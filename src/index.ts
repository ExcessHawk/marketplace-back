import 'reflect-metadata';
import {
  AuthPlugin,
  JWTProvider,
  OpenAPIPlugin,
  RBACPlugin,
  Veloce,
  WebSocketPlugin,
  registerDrizzle,
} from 'veloce-ts';
import { db, pool } from './db/client';
import { AddressController } from './controllers/address.controller';
import { AdminController } from './controllers/admin.controller';
import { AuthController } from './controllers/auth.controller';
import { CartController } from './controllers/cart.controller';
import { CatalogController } from './controllers/catalog.controller';
import { DemoController } from './controllers/demo.controller';
import { DisputeController } from './controllers/dispute.controller';
import { ChatController } from './controllers/chat.controller';
import { ReviewController } from './controllers/review.controller';
import { OrderController } from './controllers/order.controller';
import { SalesController } from './controllers/sales.controller';
import { WebhookController } from './controllers/webhook.controller';
import { HealthController } from './controllers/health.controller';
import { SellerController } from './controllers/seller.controller';
import { createTokenRevocationMiddleware } from './middleware/token-revocation.middleware';
import { AuditService } from './services/audit.service';
import { AuthService, customUserProvider } from './services/auth.service';
import { CartService } from './services/cart.service';
import { CheckoutService } from './services/checkout.service';
import { createPaymentProvider } from './services/payments';
import { DisputeService } from './services/dispute.service';
import { ChatService } from './services/chat.service';
import { ReviewService } from './services/review.service';
import { ChatGateway } from './websocket/chat.gateway';
import { PayoutService } from './services/payout.service';
import { CatalogService } from './services/catalog.service';
import { demoModeEnabled } from './services/demo.constants';
import { DemoService } from './services/demo.service';
import { logger, requestLoggerMiddleware } from './services/logger';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const PORT = Number(process.env.PORT ?? 3102);

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set. Copy .env.example to .env.');
}

const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean)) ?? [
    'http://localhost:5102',
    'http://localhost:4173',
  ],
);

const app = new Veloce({
  title: 'Marketplace API',
  version: '0.1.0',
  description: 'Multi-vendor marketplace built on Veloce-TS',
  cors: {
    origin: (origin: string) => ALLOWED_ORIGINS.has(origin),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});

app.usePlugin(new OpenAPIPlugin({ path: '/openapi.json', docsPath: '/docs' }));

const authPlugin = new AuthPlugin({
  jwt: {
    secret: JWT_SECRET,
    expiresIn: process.env.JWT_ACCESS_EXPIRES ?? '1h',
    refreshSecret: JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES ?? '30d',
  },
  userProvider: customUserProvider,
  enableDefaultRoutes: false,
});
app.usePlugin(authPlugin);

app.usePlugin(
  new RBACPlugin({
    roles: [
      { name: 'admin', permissions: ['*'] },
      { name: 'seller', permissions: ['products:write', 'products:read', 'orders:read'] },
      { name: 'buyer', permissions: ['products:read', 'orders:read', 'orders:write'] },
    ],
  }),
);

app.useRateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_MAX ?? 100),
});

const hono = app.getHono();

hono.use(requestLoggerMiddleware());

hono.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Referrer-Policy', 'no-referrer');
});

const jwtProvider = authPlugin.getAuthService().getJWTProvider();
hono.use(createTokenRevocationMiddleware(db, jwtProvider));

registerDrizzle(app, db);

const container = app.getContainer();
container.register(JWTProvider, { factory: () => jwtProvider, scope: 'singleton' });

const authService = new AuthService(jwtProvider);
container.register(AuthService, { factory: () => authService, scope: 'singleton' });
container.register(CatalogService, { factory: () => new CatalogService(), scope: 'singleton' });
const auditService = new AuditService();
container.register(AuditService, { factory: () => auditService, scope: 'singleton' });
const cartService = new CartService();
const paymentProvider = createPaymentProvider();
container.register(CartService, { factory: () => cartService, scope: 'singleton' });
container.register('PaymentProvider', { factory: () => paymentProvider, scope: 'singleton' });
container.register(ReviewService, { factory: () => new ReviewService(), scope: 'singleton' });
const chatService = new ChatService();
container.register(ChatService, { factory: () => chatService, scope: 'singleton' });
container.register(DisputeService, {
  factory: () => new DisputeService(auditService),
  scope: 'singleton',
});
container.register(PayoutService, {
  factory: () => new PayoutService(paymentProvider, auditService),
  scope: 'singleton',
});
container.register(CheckoutService, {
  factory: () => new CheckoutService(cartService, paymentProvider),
  scope: 'singleton',
});

app.include(ChatGateway);

const wsPlugin = new WebSocketPlugin({ heartbeatIntervalMs: 30_000 });
app.usePlugin(wsPlugin);
ChatGateway.setManager(wsPlugin.getManager());

app.include(HealthController);
app.include(AuthController);
app.include(CatalogController);
app.include(SellerController);
app.include(CartController);
app.include(AddressController);
app.include(OrderController);
app.include(SalesController);
app.include(DisputeController);
app.include(ReviewController);
app.include(ChatController);
app.include(WebhookController);
app.include(AdminController);

if (demoModeEnabled()) {
  container.register(DemoService, {
    factory: () => new DemoService(authService),
    scope: 'singleton',
  });
  app.include(DemoController);
  logger.warn('DEMO_MODE is on: /api/demo/session hands out sessions without a password');
}

async function start() {
  await app.compile();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'marketplace API running');
    logger.info({ url: `http://localhost:${PORT}/docs` }, 'OpenAPI docs');
  });

  app.setShutdownTimeout(10_000);
  app.onShutdown(async (signal: string) => {
    logger.info({ signal }, 'draining');
    await pool.end();
    logger.info('clean exit');
  });
}

start().catch((error) => {
  logger.error({ err: error }, 'failed to start');
  process.exit(1);
});

export { app, authService, jwtProvider };
