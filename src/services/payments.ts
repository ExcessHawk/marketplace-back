import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface PaymentIntent {
  id: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
}

export interface PaymentEvent {
  id: string;
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed' | string;
  intentId: string;
  amountCents: number;
}

export interface Transfer {
  id: string;
  amountCents: number;
}

export interface PaymentProvider {
  readonly name: string;
  createTransfer(input: {
    amountCents: number;
    sellerId: string;
    reference: string;
  }): Promise<Transfer>;
  createIntent(input: {
    amountCents: number;
    orderNumber: string;
    buyerId: string;
  }): Promise<PaymentIntent>;
  cancelIntent(intentId: string): Promise<void>;
  parseWebhook(rawBody: string, signature: string | null): PaymentEvent;
}

export class PaymentConfigurationError extends Error {}
export class PaymentSignatureError extends Error {}

export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  constructor(private readonly secret: string) {}

  async createIntent(input: { amountCents: number }): Promise<PaymentIntent> {
    const id = `pi_fake_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return {
      id,
      clientSecret: `${id}_secret_${createHmac('sha256', this.secret).update(id).digest('hex').slice(0, 24)}`,
      amountCents: input.amountCents,
      currency: 'mxn',
    };
  }

  async cancelIntent(): Promise<void> {}

  async createTransfer(input: { amountCents: number }): Promise<Transfer> {
    return {
      id: `tr_fake_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      amountCents: input.amountCents,
    };
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  parseWebhook(rawBody: string, signature: string | null): PaymentEvent {
    if (!signature) throw new PaymentSignatureError('Missing signature header');

    const expected = Buffer.from(this.sign(rawBody));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new PaymentSignatureError('Bad signature');
    }

    const parsed = JSON.parse(rawBody) as {
      id?: string;
      type?: string;
      data?: { object?: { id?: string; amount?: number } };
    };
    if (!parsed.id || !parsed.type || !parsed.data?.object?.id) {
      throw new PaymentSignatureError('Malformed event');
    }

    return {
      id: parsed.id,
      type: parsed.type,
      intentId: parsed.data.object.id,
      amountCents: parsed.data.object.amount ?? 0,
    };
  }
}

export function createPaymentProvider(): PaymentProvider {
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (stripeKey) {
    throw new PaymentConfigurationError(
      'STRIPE_SECRET_KEY is set but the Stripe provider is not implemented yet.\n' +
        'Unset it to run against the built-in fake provider, or write the adapter:\n' +
        'it has to satisfy the PaymentProvider interface in src/services/payments.ts.',
    );
  }

  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    throw new PaymentConfigurationError(
      'PAYMENT_WEBHOOK_SECRET is not set. Copy .env.example to .env.',
    );
  }
  return new FakePaymentProvider(secret);
}
