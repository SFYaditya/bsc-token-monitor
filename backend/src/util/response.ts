import type { Response } from 'express';

export function ok<T>(res: Response, data: T, message = ''): void {
  res.json({ ok: true, data, message });
}

export function fail(res: Response, error: string, status = 400): void {
  res.status(status).json({ ok: false, error });
}
