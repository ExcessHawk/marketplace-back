import { createRequire } from 'node:module';
import { createRateLimitMiddleware } from 'veloce-ts';
import type { Context } from 'hono';

const authMax = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10);

type ConnInfoGetter = (c: Context) => { remote: { address?: string } };

let connInfo: ConnInfoGetter | null | undefined;

function loadConnInfo(): ConnInfoGetter | null {
  const require = createRequire(import.meta.url);
  const specifier =
    typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
      ? 'hono/bun'
      : '@hono/node-server/conninfo';

  try {
    return require(specifier).getConnInfo as ConnInfoGetter;
  } catch {
    return null;
  }
}

function getConnInfo(c: Context): { remote: { address?: string } } {
  if (connInfo === undefined) connInfo = loadConnInfo();
  if (!connInfo) throw new Error('No connection-info adapter for this runtime');
  return connInfo(c);
}

const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 0);

export function clientIp(c: Context): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    peer = undefined;
  }

  if (TRUST_PROXY_HOPS > 0) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const chain = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const idx = chain.length - TRUST_PROXY_HOPS;
      if (idx >= 0 && chain[idx]) return chain[idx];
    }
  }

  return peer ?? 'unknown-ip';
}

export const publicRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: authMax,
  keyGenerator: (c) => `login:${clientIp(c as Context)}`,
});

export const signupRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: authMax,
  keyGenerator: (c) => `signup:${clientIp(c as Context)}`,
});

export const publicReadRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: 120,
  keyGenerator: (c) => `read:${clientIp(c as Context)}`,
});
