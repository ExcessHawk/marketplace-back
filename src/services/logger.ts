import type { MiddlewareHandler } from 'hono';
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'refreshToken',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

declare module 'hono' {
  interface ContextVariableMap {
    reqId: string;
    logger: pino.Logger;
  }
}

export function requestLoggerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const reqId = c.req.header('x-request-id') ?? crypto.randomUUID();
    const child = logger.child({ reqId });
    c.set('reqId', reqId);
    c.set('logger', child);
    c.header('X-Request-Id', reqId);

    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);

    const line = {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms,
    };
    if (c.res.status >= 500) child.error(line, 'request failed');
    else if (c.res.status >= 400) child.warn(line, 'request rejected');
    else child.info(line, 'request');
  };
}
