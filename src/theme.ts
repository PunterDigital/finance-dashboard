import { useSyncExternalStore } from 'react';

// Chart colors passed to Recharts as hex (SVG attrs don't resolve CSS vars
// reliably). Values mirror styles.css; both palettes validated with the
// dataviz six-checks script.
const light = {
  income: '#1baf7a',
  expense: '#e34948',
  accent: '#2a78d6',
  yellow: '#eda100',
  violet: '#4a3aa7',
  muted: '#898781',
  grid: '#e1e0d9',
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
};
const dark: typeof light = {
  income: '#199e70',
  expense: '#e66767',
  accent: '#3987e5',
  yellow: '#c98500',
  violet: '#9085e9',
  muted: '#898781',
  grid: '#2c2c2a',
  surface: '#1a1a19',
  ink: '#ffffff',
  ink2: '#c3c2b7',
};

const mq = window.matchMedia('(prefers-color-scheme: dark)');

export function useChartTheme() {
  const isDark = useSyncExternalStore(
    (cb) => {
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => mq.matches
  );
  return isDark ? dark : light;
}
