import { Account, Amount, Bkper, Book, Group } from "bkper";
import { EXC_AMOUNT_PROP, EXC_BASE_PROP, EXC_CODE_PROP, EXC_RATE_PROP, EXC_RATES_CACHE_PROP, EXC_RATES_URL_PROP, EXC_DATE_PROP } from "./constants";
import { AmountDescription } from "./EventHandlerTransaction";
import { convert, getRates } from "./exchange-service";
import { ExchangeRates } from "./ExchangeRates";

interface RatesEndpointConfig {
  url: string
}

export function getRatesEndpointConfig(book: Book, transaction: bkper.Transaction): RatesEndpointConfig {
  //Read from properties
  let ratesUrl = book.getProperty(EXC_RATES_URL_PROP, 'exchange_rates_url');

  let date = transaction.date;

  if (transaction.properties[EXC_DATE_PROP]) {
    let parsedDate = book.parseDate(transaction.properties[EXC_DATE_PROP])
    date = parsedDate.toISOString().substring(0, 10);
  }

  //Default values
  if (ratesUrl == null || ratesUrl.trim() == '') {
    ratesUrl = "https://openexchangerates.org/api/historical/${date}.json?show_alternative=true&app_id=" + process.env.open_exchange_rates_app_id;
  }

  //Use today if date in future
  let today = new Date();
  let parsedDate = book.parseDate(date);
  if (parsedDate.getTime() > today.getTime()) {
    date = today.toISOString().substring(0, 10);
  }
  
  //deprecated
  ratesUrl = ratesUrl.replace("${transaction.date}", date);
  ratesUrl = ratesUrl.replace("${date}", date);
  ratesUrl = ratesUrl.replace("${agent}", 'bot');

  return {
    url: ratesUrl
  }
}

export async function getConnectedBooks(book: Book): Promise<Set<Book>> {
  if (book.getProperties() == null) {
    return new Set<Book>();
  }
  let books = new Set<Book>();

  //deprecated
  for (const key in book.getProperties()) {
    if ((key.startsWith('exc')) && key.endsWith('_book')) {
      books.add(await Bkper.getBook(book.getProperties()[key]));
    }
  }

  //deprecated
  var exc_books = book.getProperty('exc_books');
  if (exc_books != null && exc_books.trim() != '') {
    var bookIds = exc_books.split(/[ ,]+/);
    for (var bookId of bookIds) {
      if (bookId != null && bookId.trim().length > 10) {
        books.add(await Bkper.getBook(bookId));
      }
    }
  }

  let collectionBooks = book.getCollection() != null ? book.getCollection().getBooks() : null;
  if (collectionBooks) {
    for (const b of collectionBooks) {
      if ((b.getId() != book.getId()) && getBaseCode(b) != null && getBaseCode(b) != 'TEMPLATE') {
        books.add(b);
      }
    }
  }

  return books;
}

export function isBaseBook(book: Book): boolean {
  if (book.getProperty(EXC_BASE_PROP)) {
    return true;
  } else {
    return false;
  }
}

export function hasBaseBookInCollection(book: Book): boolean {
  let collectionBooks = book.getCollection() != null ? book.getCollection().getBooks() : null;
  if (collectionBooks) {
    for (const b of collectionBooks) {
      if (isBaseBook(b)) {
        return true;
      }
    }
  }

  return false;
}

export function getBaseCode(book: Book): string {
  return book.getProperty(EXC_CODE_PROP, 'exchange_code');
}

export async function getAccountExcCode(book: Book, account: bkper.Account): Promise<string> {
  let groups = account.groups;
  if (groups) {
    for (const group of groups) {
      let excCode = await getGroupExcCode(book, group);
      if (excCode) {
        return excCode;
      }
    }
  }
  return undefined;
}

async function getGroupExcCode(book: Book, group: bkper.Group): Promise<string> {
  let exchangeBooks = await getConnectedBooks(book);
  for (const exchangeBook of exchangeBooks) {
    let bookExcCode = getBaseCode(exchangeBook);
    if (group.name == bookExcCode) {
      return group.name;
    }
  }
  return group.properties[EXC_CODE_PROP];
}

export async function extractAmountDescription_(baseBook: Book, connectedBook: Book, base: string, connectedCode: string, transaction: bkper.Transaction, ratesEndpointUrl: string): Promise<AmountDescription> {
  if (ratesEndpointUrl == null) {
    throw 'exchangeRatesUrl must be provided.';
  }
  let rates = await getRates(ratesEndpointUrl);
  let amountDescription = await getAmountDescription_(baseBook, connectedBook, base, connectedCode, transaction, rates);
  amountDescription.amount = amountDescription.amount.round(8);
  amountDescription.excBaseRate = amountDescription.amount.div(transaction.amount);
  amountDescription.rates = rates;
  return amountDescription;
}

async function getAmountDescription_(baseBook: Book, connectedBook: Book, base: string, connectedCode: string, transaction: bkper.Transaction, rates: ExchangeRates): Promise<AmountDescription> {

  let txExcAmount = transaction.properties[EXC_AMOUNT_PROP];
  let txExcRate = transaction.properties[EXC_RATE_PROP];
  let txExcCode = transaction.properties[EXC_CODE_PROP];

  if (txExcAmount && (connectedCode == txExcCode || match(baseBook, connectedCode, transaction))) {
    const amount = connectedBook.parseValue(txExcAmount);
    return {
      amount: amount,
      excBaseCode: base,
      description: transaction.description,
    };
  }

  if (txExcRate && (connectedCode == txExcCode || isBaseBook(connectedBook) || match(baseBook, connectedCode, transaction))) {
    const excRate = connectedBook.parseValue(txExcRate);
    return {
      amount: excRate.times(transaction.amount),
      excBaseCode: base,
      description: transaction.description,
    };
  }

  let parts = transaction.description.split(' ');

  for (const part of parts) {
    if (part.startsWith(connectedCode)) {
      try {
        const amount = connectedBook.parseValue(part.replace(connectedCode, ''));
        let ret: AmountDescription = {
          amount: amount,
          excBaseCode: base,
          description: transaction.description.replace(part, `${base}${transaction.amount}`),
        };
        if (ret.amount) {
          return ret;
        }
      } catch (error) {
        continue;
      }
    }
  }

  const convertedAmount = await convert(new Amount(transaction.amount), base, connectedCode, rates);

  return {
    amount: convertedAmount.amount,
    excBaseCode: convertedAmount.base,
    description: `${transaction.description}`,
  };
}

export function match(baseBook: Book, connectedCode: string, transaction: bkper.Transaction): boolean {

  const creditGroups = transaction.creditAccount.groups;
  const debitGroups = transaction.debitAccount.groups;

  if (creditGroups != null) {
    for (const group of creditGroups) {
      if (group.name == connectedCode) {
        return true;
      }
      if (group.properties[EXC_CODE_PROP] == connectedCode) {
        return true;
      }
    }
  }

  if (debitGroups != null) {
    for (const group of debitGroups) {
      if (group.name == connectedCode) {
        return true;
      }
      if (group.properties[EXC_CODE_PROP] == connectedCode) {
        return true;
      }
    }
  }

  return false;
}
