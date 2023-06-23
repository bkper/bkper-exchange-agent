

namespace BotViewService {

  export function auditBooks(bookId: string): void {
    let book = BkperApp.getBook(bookId);
    let connectedBooks = BotService.getConnectedBooks(book);
    connectedBooks.add(book);
    connectedBooks.forEach(b => {
      b.audit();
    });

  }

  export function getGainLossViewTemplate(bookId: string): GoogleAppsScript.HTML.HtmlOutput {
    
    let book = BkperApp.getBook(bookId);
    
    const template = HtmlService.createTemplateFromFile('BotView');
    template.today =  Utilities.formatDate(new Date(), book.getTimeZone(), 'yyyy-MM-dd');
    template.books = [];

    const hasBaseBookInCollection = BotService.hasBaseBookInCollection(book);

    let connectedBooks = BotService.getConnectedBooks(book);
    for (const connectedBook of connectedBooks) {
        template.books.push({
          id: connectedBook.getId(),
          name: connectedBook.getName(),
          code: BotService.getBaseCode(connectedBook),
          base: BotService.isBaseBook(connectedBook) || !hasBaseBookInCollection
        })
    }

    template.book = {
      id: book.getId(),
      name: book.getName(),
      code: BotService.getBaseCode(book),
      base: BotService.isBaseBook(book) || !hasBaseBookInCollection
    }

    template.books.push(template.book)

    if (!BotService.canUserEditBook(book)) {
      template.basePermissionGranted = false;
      template.permissionError = `User needs EDITOR or OWNER permission in ${book.getName()} book`;
      return template.evaluate().setTitle('Exchange Bot');
    } else {
      template.basePermissionGranted = true;
    }

    const bookExcCodesUserCanView = BotService.getBooksExcCodesUserCanView(book)
    const bookConfiguredExcCodes = BotService.getBookConfiguredExcCodes(book)

    let bookExcCodesUserCannotView: string[] = [];
    for (const code of Array.from(bookConfiguredExcCodes)) {
      if (!bookExcCodesUserCanView.has(code)) {
        bookExcCodesUserCannotView.push(code);
      }
    }

    if (bookExcCodesUserCannotView.length > 0) {
      template.permissionGranted = false;
      template.permissionError = `User needs permission in ${bookExcCodesUserCannotView.join(', ')} books`;
    } else {
      template.permissionGranted = true;
    }

    return template.evaluate().setTitle('Exchange Bot');
  }

  export function loadRates(bookId: string, date: string): ExchangeRates {
    let book = BkperApp.getBook(bookId);
    let ratesEndpointConfig = BotService.getRatesEndpointConfig(book, date, 'app');
    let ratesJSON = UrlFetchApp.fetch(ratesEndpointConfig.url).getContentText();
    let exchangeRates = JSON.parse(ratesJSON) as ExchangeRates;

    let codes: string[] = [];
    BotService.getConnectedBooks(book).add(book).forEach(book => codes.push(BotService.getBaseCode(book)));

    for (const rate in exchangeRates.rates) {
      if (!codes.includes(rate)) {
        delete exchangeRates.rates[rate];
      }
    }

    if (exchangeRates.rates[exchangeRates.base]) {
      delete exchangeRates.rates[exchangeRates.base];
    }

    return exchangeRates;
  }

}
