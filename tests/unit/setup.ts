import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test file gets a throwaway data dir; real data in ./data is never opened.
process.env.FINANCE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-test-'));
