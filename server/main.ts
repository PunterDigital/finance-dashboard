import { listen } from './index.js';

// Dev API server (npm run dev); Vite proxies /api here.
const PORT = Number(process.env.API_PORT ?? 3178);
await listen(PORT);
console.log(`Finance API listening on http://127.0.0.1:${PORT}`);
