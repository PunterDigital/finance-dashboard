// The app version from package.json, baked in by Vite's `define` (vite.config.ts) at build time,
// so it always matches the release that was installed (#3347). Unit tests run without Vite.
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
