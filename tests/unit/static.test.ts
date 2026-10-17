import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveStatic } from '../../server/index';
import { startApi } from './helpers';

// The desktop app serves the built UI from the API server. Express 5 changed route matching, so
// check the SPA fallback still answers deep links and never swallows /api.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-dist-'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>spa</title>');
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
serveStatic(dist);

const api = startApi();
const text = async (url: string) => {
  const res = await fetch(api.ctx.base + url);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

describe('serveStatic', () => {
  it('serves index.html at the root and for client-side routes', async () => {
    for (const url of ['/', '/transactions', '/reports/monthly?month=2026-03']) {
      const res = await text(url);
      expect(res.status, url).toBe(200);
      expect(res.body, url).toContain('<title>spa</title>');
    }
  });

  it('serves built assets as files', async () => {
    const res = await text('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/javascript/);
    expect(res.body).toBe('console.log(1)');
  });

  it('leaves /api routes to the API: known ones answer JSON, unknown ones 404', async () => {
    expect((await api.get('/api/accounts')).status).toBe(200);
    const res = await text('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('<title>spa</title>');
  });
});

describe('request bodies', () => {
  it('a body-less request still reaches handlers with an empty body', async () => {
    const res = await fetch(api.ctx.base + '/api/maintenance/reset', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Type RESET to confirm' });
  });
});
