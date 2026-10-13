import { describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const api = startApi();

const transfer = (account: string, amount: number, description: string, date: string) =>
  api.post('/api/transactions', { date, description, account, amount, currency: 'CZK', type: 'Transfer' });

describe('transfer matching', () => {
  it('pairs the two sides of a transfer and works out which side sent it', async () => {
    await api.post('/api/accounts', { name: 'Biz', type: 'Business', base_currency: 'CZK', opening_balance: 0 });
    await api.post('/api/accounts', { name: 'Personal', type: 'Personal', base_currency: 'CZK', opening_balance: 0 });
    // 10 000 left Biz, 9 950 arrived in Personal two days later (fee): Biz is the sender.
    await transfer('Biz', -10000, 'Payout to me', '2026-05-01');
    await transfer('Personal', 9950, 'Received', '2026-05-03');

    const result = await api.post('/api/transfers/match');
    expect(result.body).toMatchObject({ paired: 1, unpaired: 0 });

    const rows = (await api.get('/api/transactions?type=Transfer')).body.rows as { account: string; transfer_role: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.account, r.transfer_role]))).toEqual({ Biz: 'out', Personal: 'in' });
  });

  it('leaves transfers more than 4 days apart unpaired', async () => {
    await api.post('/api/transfers/reset');
    await api.post('/api/transfers/match');
    await transfer('Biz', -500, 'Move', '2026-06-01');
    await transfer('Personal', 500, 'Move', '2026-06-10');
    const result = await api.post('/api/transfers/match');
    expect(result.body).toMatchObject({ paired: 0, unpaired: 2 });
  });
});
