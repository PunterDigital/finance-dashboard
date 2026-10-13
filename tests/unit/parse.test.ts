import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate } from '../../src/pages/ImportPage';

describe('parseAmount', () => {
  it.each<[string, number | null]>([
    ['1,234.56', 1234.56], ['1 234,56', 1234.56], ['-£12.34', -12.34], ['(45.00)', -45],
    ['1.234,56', 1234.56], ['CZK 250', 250], ['+99', 99], ['', null], ['abc', null], ['12,345', 12345],
  ])('%j -> %j', (input, want) => expect(parseAmount(input)).toBe(want));
});

describe('parseDate', () => {
  it.each<[string, 'auto' | 'DMY' | 'MDY' | 'YMD', string | null]>([
    ['2026-03-02', 'auto', '2026-03-02'], ['02/03/2026', 'auto', '2026-03-02'],
    ['03/02/2026', 'MDY', '2026-03-02'], ['13/02/2026', 'auto', '2026-02-13'],
    ['02.03.2026', 'DMY', '2026-03-02'], ['2026/03/02', 'auto', '2026-03-02'],
    ['1/3/26', 'DMY', '2026-03-01'], ['12 Mar 2026', 'auto', '2026-03-12'], ['garbage', 'auto', null],
  ])('%j (%s) -> %j', (input, mode, want) => expect(parseDate(input, mode)).toBe(want));
});
