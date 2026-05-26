import type { Request, Response, NextFunction } from 'express';
import { AUTH_PASSWORD } from '@token-monitor/shared';

const sessions = new Set<string>();

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_PASSWORD) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && sessions.has(header.slice(7))) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: 'Unauthorized' });
}

export function login(password: string): string | null {
  if (!AUTH_PASSWORD || password === AUTH_PASSWORD) {
    const token = crypto.randomUUID();
    sessions.add(token);
    return token;
  }
  return null;
}

export function authEnabled(): boolean {
  return !!AUTH_PASSWORD;
}
