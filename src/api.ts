async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  get: <T = any>(url: string) => fetch(url).then((r) => handle<T>(r)),
  post: <T = any>(url: string, body?: any) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  put: <T = any>(url: string, body: any) =>
    fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  del: <T = any>(url: string) => fetch(url, { method: 'DELETE' }).then((r) => handle<T>(r)),
};
