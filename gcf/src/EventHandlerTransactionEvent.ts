import { Account, AccountType, Book, Transaction } from "bkper";
import { getBaseCode, getRatesEndpointConfigForDate, extractAmountDescription_ } from "./BotService";
import { EXC_CODE_PROP, EXC_RATE_PROP, EXC_LOG_PROP, EXC_AMOUNT_PROP, EXC_DATE_HIST_PROP, EXC_RATE_HIST_PROP } from "./constants";
import { EventHandlerTransaction } from "./EventHandlerTransaction";

export abstract class EventHandlerTransactionEvent extends EventHandlerTransaction {

  protected getTransactionQuery(transaction: bkper.Transaction): string {
    return `remoteId:${transaction.id}`;
  }

  protected async mirrorTransaction(baseBook: Book, connectedBook: Book, transaction: bkper.Transaction): Promise<Transaction> {

    let baseCode = getBaseCode(baseBook);
    let baseCreditAccount = transaction.creditAccount;
    let baseDebitAccount = transaction.debitAccount;
    let connectedCode = getBaseCode(connectedBook);

    let connectedCreditDebitAccounts = await Promise.all([connectedBook.getAccount(baseCreditAccount.name), connectedBook.getAccount(baseDebitAccount.name)])

    let connectedCreditAccount = connectedCreditDebitAccounts[0];
    if (connectedCreditAccount == null) {
      try {
        connectedCreditAccount = await this.createAccount(connectedBook, baseCreditAccount);
      } catch (err) {
        //OK
      }
    }
    let connectedDebitAccount = connectedCreditDebitAccounts[1];
    if (connectedDebitAccount == null) {
      try {
        connectedDebitAccount = await this.createAccount(connectedBook, baseDebitAccount);
      } catch (err) {
        //OK
      }
    }

    let amountDescription = await super.extractAmountDescription_(baseBook, connectedBook, baseCode, connectedCode, transaction);

    if (amountDescription.amount == null) {
      throw `Exchange rate NOT found for code  ${connectedCode} on ${transaction.date}`;
    }

    if (amountDescription.amount.eq(0)) {
      return null;
    }

    const creditDebitAccounts = await Promise.all([connectedBook.getAccount(baseCreditAccount.name), connectedBook.getAccount(baseDebitAccount.name)])

    let newTransaction = connectedBook.newTransaction()
      .setDate(transaction.date)
      .setProperties(transaction.properties)
      .setAmount(amountDescription.amount)
      .setCreditAccount(creditDebitAccounts[0])
      .setDebitAccount(creditDebitAccounts[1])
      .setDescription(amountDescription.description)
      .addRemoteId(transaction.id)
      .setChecked(transaction.checked)
    ;

    if (amountDescription.excBaseCode) {
      // Exchange code prop
      newTransaction.setProperty(EXC_CODE_PROP, amountDescription.excBaseCode);
    }

    if (amountDescription.excBaseRate) {
      // Exchange rate prop
      newTransaction.setProperty(EXC_RATE_PROP, amountDescription.excBaseRate.toString());
      // Exchange amount prop
      if (transaction.amount) {
        newTransaction.setProperty(EXC_AMOUNT_PROP, transaction.amount);
      }
    }

    if (amountDescription.rates) {
      const excLogEntries = await this.buildExcLog(baseBook, connectedBook, transaction, amountDescription);
      if (excLogEntries.length > 0) {
        newTransaction.setProperty(EXC_LOG_PROP, JSON.stringify(excLogEntries));
      }
    }

    // exc_date_hist prop: if present, fetch and record historical exchange rate for reference
    const excDateHistProp = transaction.properties[EXC_DATE_HIST_PROP];
    if (excDateHistProp) {
      // historical rates endpoint
      const histRatesEndpointConfig = getRatesEndpointConfigForDate(baseBook, excDateHistProp);
      // historical amount description
      const amountDescriptionHist = await extractAmountDescription_(baseBook, connectedBook, baseCode, connectedCode, transaction, histRatesEndpointConfig.url);
      if (amountDescriptionHist.excBaseRate) {
        // set property
        newTransaction.setProperty(EXC_RATE_HIST_PROP, amountDescriptionHist.excBaseRate.toString());
      }
    }

    if (this.isReadyToPost(newTransaction.json())) {
      await newTransaction.post();
    } else {
      newTransaction.setDescription(`${newTransaction.getCreditAccount() == null ? baseCreditAccount.name : ''} ${newTransaction.getDebitAccount() == null ? baseDebitAccount.name : ''} ${newTransaction.getDescription()}`.trim())
      await newTransaction.create();
    }

    return newTransaction;
  }

  protected isReadyToPost(newTransaction: bkper.Transaction) {
    return newTransaction.creditAccount != null && newTransaction.debitAccount != null && newTransaction.amount != null;
  }

  protected async createAccount(connectedBook: Book, baseAccount: bkper.Account): Promise<Account> {
    let newConnectedAccount = connectedBook.newAccount()
      .setName(baseAccount.name)
      .setType(baseAccount.type as AccountType)
      .setProperties(baseAccount.properties);
    const baseGroups = baseAccount.groups;
    if (baseGroups) {
      for (const baseGroup of baseGroups) {
        let connectedGroup = await connectedBook.getGroup(baseGroup.name);
        if (connectedGroup == null) {
          connectedGroup = await connectedBook.newGroup().setName(baseGroup.name).setProperties(baseGroup.properties).create();
        }
        await newConnectedAccount.addGroup(connectedGroup);
      }
    }
    await newConnectedAccount.create();
    return newConnectedAccount;
  }

}
