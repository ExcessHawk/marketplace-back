import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { JWTProvider } from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { revokedAccessTokens } from '../db/schema';

export function createTokenRevocationMiddleware(
  db: DrizzleDB,
  jwtProvider: JWTProvider,
): MiddlewareHandler {
  return async (c, next) => {
    const authz = c.req.header('authorization');
    if (!authz?.toLowerCase().startsWith('bearer ')) return next();

    const token = authz.slice(7).trim();
    if (!token) return next();

    const payload = await jwtProvider.verifyAccessToken(token).catch(() => null);
    const jti = (payload as { jti?: string } | null)?.jti;
    if (!jti) return next();

    const [revoked] = await db
      .select({ jti: revokedAccessTokens.jti })
      .from(revokedAccessTokens)
      .where(eq(revokedAccessTokens.jti, jti));

    if (revoked) {
      return c.json({ error: 'Token has been revoked', statusCode: 401 }, 401);
    }

    return next();
  };
}
