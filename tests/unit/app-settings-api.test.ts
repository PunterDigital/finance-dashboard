import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appSettingsPath } from '../../server/app-settings';
import { setUpdateController, type UpdateController, type UpdateStatus } from '../../server/updates';
import { startApi } from './helpers';

// App settings and the update endpoints the UI uses (#3353).
const api = startApi();

const send = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(api.ctx.base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => setUpdateController(null));

describe('app settings', () => {
  it('defaults to checking for updates when there is no settings file', async () => {
    expect(fs.existsSync(appSettingsPath())).toBe(false);
    expect((await api.get('/api/app/settings')).body).toEqual({ checkForUpdates: true });
  });

  it('saves the toggle and keeps keys it does not know', async () => {
    fs.writeFileSync(appSettingsPath(), JSON.stringify({ fromANewerVersion: 1 }));
    const res = await api.put('/api/app/settings', { checkForUpdates: false });
    expect(res).toEqual({ status: 200, body: { checkForUpdates: false } });
    expect(JSON.parse(fs.readFileSync(appSettingsPath(), 'utf8'))).toEqual({ fromANewerVersion: 1, checkForUpdates: false });
    expect((await api.get('/api/app/settings')).body).toEqual({ checkForUpdates: false });
    await api.put('/api/app/settings', { checkForUpdates: true });
    expect((await api.get('/api/app/settings')).body).toEqual({ checkForUpdates: true });
  });

  it('treats a broken settings file as the defaults', async () => {
    fs.writeFileSync(appSettingsPath(), '{not json');
    expect((await api.get('/api/app/settings')).body).toEqual({ checkForUpdates: true });
  });

  it('rejects anything but a boolean, and other origins', async () => {
    expect((await api.put('/api/app/settings', { checkForUpdates: 'no' })).status).toBe(400);
    const res = await send('PUT', '/api/app/settings', { Origin: 'https://evil.example' }, { checkForUpdates: false });
    expect(res.status).toBe(403);
  });
});

describe('update endpoints', () => {
  it('are off without the desktop shell', async () => {
    expect((await api.get('/api/app/update')).body).toEqual({ state: 'idle', mode: 'off' });
    expect((await api.post('/api/app/update/check')).body).toEqual({ state: 'idle', mode: 'off' });
    expect(await api.post('/api/app/update/install')).toEqual({
      status: 409,
      body: { error: 'Update checks only run in the installed app.' },
    });
  });

  it('pass through to the registered updater', async () => {
    let status: UpdateStatus = { state: 'idle', mode: 'install' };
    const fake: UpdateController = {
      getStatus: () => status,
      check: vi.fn(async () => (status = { state: 'downloaded', mode: 'install', version: '0.6.0' })),
      install: vi.fn(),
    };
    setUpdateController(fake);
    expect((await api.get('/api/app/update')).body).toEqual({ state: 'idle', mode: 'install' });
    expect((await api.post('/api/app/update/check')).body).toEqual({ state: 'downloaded', mode: 'install', version: '0.6.0' });
    expect((await api.get('/api/app/update')).body.state).toBe('downloaded');
    expect(await api.post('/api/app/update/install')).toEqual({ status: 200, body: { ok: true } });
    expect(fake.install).toHaveBeenCalledTimes(1);
  });

  it('refuse a check or an install from another origin', async () => {
    const fake: UpdateController = { getStatus: () => ({ state: 'idle', mode: 'install' }), check: vi.fn(), install: vi.fn() };
    setUpdateController(fake);
    expect((await send('POST', '/api/app/update/install', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('POST', '/api/app/update/check', { Origin: 'null' })).status).toBe(403);
    expect(fake.install).not.toHaveBeenCalled();
    expect(fake.check).not.toHaveBeenCalled();
    // The app's own page is fine.
    const own = await send('POST', '/api/app/update/install', { Origin: api.ctx.base });
    expect(own.status).toBe(200);
  });
});
