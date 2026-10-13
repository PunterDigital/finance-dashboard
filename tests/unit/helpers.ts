import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll } from 'vitest';
import { listen } from '../../server/index';

// Starts the real API on a random loopback port for the current test file.
export function startApi() {
  let server: Server;
  const ctx = { base: '' };
  beforeAll(async () => {
    server = await listen(0);
    ctx.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(ctx.base + url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    ctx,
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}) => call('POST', url, body),
    put: (url: string, body: unknown) => call('PUT', url, body),
    del: (url: string) => call('DELETE', url),
  };
}
