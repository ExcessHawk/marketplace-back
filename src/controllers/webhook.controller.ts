import type { Context } from 'hono';
import {
  Body,
  ConflictException,
  Controller,
  Ctx,
  Inject,
  InjectDB,
  NotFoundException,
  Param,
  Post,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { paymentEvents } from '../db/schema';
import { CheckoutService } from '../services/checkout.service';
import { FakePaymentProvider, PaymentSignatureError, type PaymentProvider } from '../services/payments';
import { and, eq } from 'drizzle-orm';
import { orders } from '../db/schema';
import { z } from 'zod';
import { logger } from '../services/logger';

const SimulateSchema = z.object({ outcome: z.enum(['succeeded', 'failed']) });
type SimulateDto = z.infer<typeof SimulateSchema>;

@Controller('/api/webhooks')
export class WebhookController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(CheckoutService) private checkout: CheckoutService,
    @Inject('PaymentProvider') private payments: PaymentProvider,
  ) {}

  @Post('/payments')
  async receive(@Ctx() c: Context) {
    const raw = await c.req.text();
    const signature = c.req.header('x-payment-signature') ?? null;

    let event;
    try {
      event = this.payments.parseWebhook(raw, signature);
    } catch (error) {
      if (error instanceof PaymentSignatureError) {
        logger.warn({ msg: 'webhook rejected', reason: error.message });
        c.status(400);
        return { error: 'Invalid signature' };
      }
      throw error;
    }

    const inserted = await this.db
      .insert(paymentEvents)
      .values({ eventId: event.id, type: event.type, payload: { intentId: event.intentId } })
      .onConflictDoNothing({ target: paymentEvents.eventId })
      .returning({ id: paymentEvents.id });

    if (inserted.length === 0) {
      return { received: true, duplicate: true };
    }

    let applied = false;
    if (event.type === 'payment_intent.succeeded') {
      applied = await this.checkout.markPaid(this.db, event.intentId);
    } else if (event.type === 'payment_intent.payment_failed') {
      applied = await this.checkout.cancel(this.db, event.intentId);
    }

    logger.info({ msg: 'webhook handled', type: event.type, intentId: event.intentId, applied });
    return { received: true, applied };
  }

  @Post('/simulate/:intentId')
  @Roles(['admin', 'seller', 'buyer'])
  async simulate(
    @Param('intentId') intentId: string,
    @Body(SimulateSchema) body: SimulateDto,
    @Ctx() c: Context,
  ) {
    if (!(this.payments instanceof FakePaymentProvider)) {
      throw new NotFoundException('Not found');
    }

    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');

    const [order] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.paymentIntentId, intentId), eq(orders.buyerId, user.sub)));
    if (!order) throw new NotFoundException('Ese pago no es tuyo');

    const raw = JSON.stringify({
      id: `evt_sim_${intentId}_${body.outcome}`,
      type:
        body.outcome === 'succeeded'
          ? 'payment_intent.succeeded'
          : 'payment_intent.payment_failed',
      data: { object: { id: intentId } },
    });

    const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3102}/api/webhooks/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment-signature': this.payments.sign(raw),
      },
      body: raw,
    });
    if (!res.ok) throw new ConflictException('El pago simulado no se pudo aplicar');
    return res.json();
  }
}
