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

// La sesión de demostración tiene su propio límite, más holgado que el de
// registro. El playground gasta una por cada cambio de rol en el iframe y otra
// en la consola de API, así que con 10 por minuto un visitante curioso choca
// con el muro en segundos. No hay contraseña que adivinar aquí, de modo que un
// límite estrecho no protege nada; solo evita que alguien pida tokens sin fin.
export const demoRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: Number(process.env.DEMO_RATE_LIMIT_MAX ?? 40),
  keyGenerator: (c) => `demo:${clientIp(c as Context)}`,
});

// Subir cuesta disco y ancho de banda, no solo CPU. Veinte por minuto alcanza
// para cargar el catálogo de una tienda a mano y no para llenar el volumen.
export const uploadRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX ?? 20),
  keyGenerator: (c) => `upload:${clientIp(c as Context)}`,
});
