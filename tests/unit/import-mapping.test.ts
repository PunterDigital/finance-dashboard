import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { columnKeys, guessMapping } from '../../src/import-mapping';

const parse = (csv: string) => Papa.parse<string[]>(csv.trim(), { skipEmptyLines: 'greedy' }).data;

describe('guessMapping', () => {
  it('maps a Wise export', () => {
    const rows = parse(`
"TransferWise ID",Date,"Date Time",Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees","Exchange To Amount","Transaction Type","Transaction Details Type"
CARD-1,16-10-2026,"16-10-2026 12:01:02.123",-12.50,CZK,"Card transaction of 12.50 CZK issued by Albert",,987.50,,,,,,,Albert,1234,"A Person",,,0.00,,DEBIT,CARD
TRANSFER-2,15-10-2026,"15-10-2026 09:00:00.000",1000.00,CZK,"Received money from A Person",Rent,1000.00,,,,"A Person",,,,,,,"back rent",0.00,,CREDIT,DEPOSIT
`);
    expect(guessMapping(columnKeys(rows, true), { rows: rows.slice(1) })).toEqual({
      Date: 'date',
      Amount: 'amount',
      Currency: 'currency',
      Description: 'description',
      Note: 'notes',
      'Transaction Type': 'type',
    });
  });

  it('maps a Monzo export: signed amount wins over money in/out, odd Type values are left alone', () => {
    const headers = ['Transaction ID', 'Date', 'Time', 'Type', 'Name', 'Emoji', 'Category', 'Amount', 'Currency',
      'Local amount', 'Local currency', 'Notes and #tags', 'Address', 'Receipt', 'Description', 'Category split',
      'Money Out', 'Money In'];
    const rows = [['tx_1', '16/10/2026', '12:00', 'Card payment', 'Tesco', '', 'groceries', '-5.00', 'GBP',
      '-5.00', 'GBP', '', '', '', 'TESCO STORES', '', '-5.00', '']];
    expect(guessMapping(headers, { rows, categories: ['Groceries'] })).toEqual({
      Date: 'date',
      Amount: 'amount',
      Description: 'description',
      Currency: 'currency',
      Category: 'category',
      'Notes and #tags': 'notes',
    });
  });

  it('maps paid out / paid in pairs and loose headers', () => {
    expect(guessMapping(['Transaction Date', 'Details', 'Paid out', 'Paid in', 'Balance'])).toEqual({
      'Transaction Date': 'date',
      Details: 'description',
      'Paid out': 'debit',
      'Paid in': 'credit',
    });
    expect(guessMapping(['Date', 'Counter Party', 'Reference', 'Amount (GBP)', 'Balance (GBP)'])).toEqual({
      Date: 'date',
      'Counter Party': 'description',
      'Amount (GBP)': 'amount',
    });
  });

  it('drops a lone debit or credit column', () => {
    expect(guessMapping(['Date', 'Money out'])).toEqual({ Date: 'date' });
  });

  it('only maps Account and Category columns whose values already exist', () => {
    const headers = ['Date', 'Account', 'Amount', 'Category'];
    const rows = [['2026-10-01', '20-32-06 12345678', '-1', 'PAYMENT'], ['2026-10-02', '20-32-06 12345678', '-2', 'DIRECTDEP']];
    expect(guessMapping(headers, { rows, accounts: ['Barclays'], categories: ['Groceries'] })).toEqual({ Date: 'date', Amount: 'amount' });

    const known = [['2026-10-01', 'barclays', '-1', 'Groceries'], ['2026-10-02', 'Barclays', '-2', 'Rent']];
    expect(guessMapping(headers, { rows: known, accounts: ['Barclays'], categories: ['Groceries'] })).toEqual({
      Date: 'date', Account: 'account', Amount: 'amount', Category: 'category',
    });
  });

  it('gives each role one column and each column one role', () => {
    const m = guessMapping(['Memo', 'Date', 'Note', 'Amount', 'Amount']);
    expect(m).toEqual({ Memo: 'description', Date: 'date', Note: 'notes', Amount: 'amount' });
  });

  it('does not guess headerless files', () => {
    const rows = parse('2026-10-01,Coffee,-3.20\n2026-10-02,Salary,1000');
    expect(guessMapping(columnKeys(rows, false))).toEqual({});
  });

  it('ignores header names that clash with object properties', () => {
    expect(guessMapping(['constructor', 'Date', 'toString'])).toEqual({ Date: 'date' });
  });
});
