import { parseAmount, parseDate } from '../src/pages/ImportPage';

const amounts: [any, number | null][] = [
  ['1,234.56', 1234.56], ['1 234,56', 1234.56], ['-£12.34', -12.34], ['(45.00)', -45],
  ['1.234,56', 1234.56], ['CZK 250', 250], ['+99', 99], ['', null], ['abc', null], ['12,345', 12345],
];
let fail = 0;
for (const [inp, want] of amounts) {
  const got = parseAmount(inp);
  if (got !== want) { console.log('AMOUNT FAIL', JSON.stringify(inp), 'got', got, 'want', want); fail++; }
}
const dates: [string, 'auto' | 'DMY' | 'MDY' | 'YMD', string | null][] = [
  ['2026-03-02', 'auto', '2026-03-02'], ['02/03/2026', 'auto', '2026-03-02'],
  ['03/02/2026', 'MDY', '2026-03-02'], ['13/02/2026', 'auto', '2026-02-13'],
  ['02.03.2026', 'DMY', '2026-03-02'], ['2026/03/02', 'auto', '2026-03-02'],
  ['1/3/26', 'DMY', '2026-03-01'], ['12 Mar 2026', 'auto', '2026-03-12'], ['garbage', 'auto', null],
];
for (const [inp, mode, want] of dates) {
  const got = parseDate(inp, mode);
  if (got !== want) { console.log('DATE FAIL', JSON.stringify(inp), mode, 'got', got, 'want', want); fail++; }
}
console.log(fail === 0 ? 'ALL PARSE TESTS PASS' : `${fail} FAILURES`);
