import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ConflictException, NotFoundException } from 'veloce-ts';
import type {
  CheckoutBlocker,
  CheckoutResponse,
  OrderListItem,
  OrderStatus,
  OrderView,
  SuborderStatus,
  SuborderView,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import {
  addresses,
  cartItems,
  carts,
  orders,
  sellers,
  suborderItems,
  suborders,
  variants,
} from '../db/schema';
import type { PaymentProvider } from './payments';
import { CartService } from './cart.service';

type Runner = Pick<DrizzleDB, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export class CheckoutBlockedException extends ConflictException {
  constructor(readonly blockers: CheckoutBlocker[]) {
    super('Hay artículos que ya no se pueden comprar', { blockers });
  }
}

function orderNumber(): string {
  const now = new Date();
  const stamp =
    String(now.getFullYear()).slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const tail = Math.floor(Math.random() * 46_656)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0');
  return `MX-${stamp}-${tail}`;
}

export class CheckoutService {
  constructor(
    private readonly cart: CartService,
    private readonly payments: PaymentProvider,
  ) {}

  async checkout(db: DrizzleDB, userId: string, addressId: string): Promise<CheckoutResponse> {
    const [address] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId), isNull(addresses.deletedAt)));
    if (!address) throw new NotFoundException('Esa dirección no está en tu cuenta');

    const [open] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.buyerId, userId), eq(orders.status, 'pending_payment')));
    if (open) {
      const existing = await this.order(db, userId, open.id);
      const intentId = await this.intentOf(db, open.id);
      return {
        order: existing,
        payment: {
          provider: this.payments.name,
          intentId: intentId ?? '',
          clientSecret: '',
        },
      };
    }

    const view = await this.cart.view(db, userId);
    if (view.groups.length === 0) throw new ConflictException('Tu carrito está vacío');

    const blockers: CheckoutBlocker[] = [];
    for (const group of view.groups) {
      for (const line of group.lines) {
        if (line.issue) {
          blockers.push({
            lineId: line.id,
            productTitle: line.product.title,
            variantName: line.variant.name,
            reason: line.issue,
            availableStock: line.availableStock,
          });
        }
      }
      if (group.shippingCents === null) {
        blockers.push({
          lineId: group.lines[0]?.id ?? group.seller.id,
          productTitle: group.seller.storeName,
          variantName: '',
          reason: 'no_shipping',
          availableStock: 0,
        });
      }
    }
    if (blockers.length > 0) throw new CheckoutBlockedException(blockers);

    const snapshot: Record<string, string> = {
      recipient: address.recipient,
      phone: address.phone,
      street: address.street,
      interior: address.interior ?? '',
      neighborhood: address.neighborhood,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      notes: address.notes ?? '',
    };

    const orderId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(orders)
        .values({
          number: orderNumber(),
          buyerId: userId,
          addressId: address.id,
          shippingSnapshot: snapshot,
          subtotalCents: 0,
          shippingCents: 0,
          totalCents: 0,
          platformFeeCents: 0,
        })
        .returning();
      if (!created) throw new Error('Could not create the order');

      let orderSubtotal = 0;
      let orderShipping = 0;
      let orderFee = 0;

      for (const group of view.groups) {
        const [store] = await tx
          .select({ commissionBps: sellers.commissionBps })
          .from(sellers)
          .where(eq(sellers.id, group.seller.id));

        const [suborder] = await tx
          .insert(suborders)
          .values({
            orderId: created.id,
            sellerId: group.seller.id,
            subtotalCents: 0,
            shippingCents: group.shippingCents ?? 0,
            commissionBps: store?.commissionBps ?? 1000,
            commissionCents: 0,
            payoutCents: 0,
          })
          .returning();
        if (!suborder) throw new Error('Could not create the suborder');

        let groupSubtotal = 0;

        for (const line of group.lines) {
          const unitPriceCents = Math.min(line.priceCentsAtAdd, line.currentPriceCents);
          const lineTotalCents = unitPriceCents * line.quantity;
          groupSubtotal += lineTotalCents;

          const updated = await tx
            .update(variants)
            .set({ stock: sql`${variants.stock} - ${line.quantity}`, updatedAt: new Date() })
            .where(and(eq(variants.id, line.variantId), sql`${variants.stock} >= ${line.quantity}`))
            .returning({ id: variants.id });

          if (updated.length === 0) {
            throw new CheckoutBlockedException([
              {
                lineId: line.id,
                productTitle: line.product.title,
                variantName: line.variant.name,
                reason: 'out_of_stock',
                availableStock: 0,
              },
            ]);
          }

          await tx.insert(suborderItems).values({
            suborderId: suborder.id,
            variantId: line.variantId,
            productTitle: line.product.title,
            productSlug: line.product.slug,
            variantName: line.variant.name,
            sku: line.variant.sku,
            imageKey: line.product.imageKey,
            quantity: line.quantity,
            unitPriceCents,
            lineTotalCents,
          });
        }

        const commissionBps = store?.commissionBps ?? 1000;
        const commissionCents = Math.round((groupSubtotal * commissionBps) / 10_000);
        const shipping = group.shippingCents ?? 0;

        await tx
          .update(suborders)
          .set({
            subtotalCents: groupSubtotal,
            commissionCents,
            payoutCents: groupSubtotal - commissionCents + shipping,
            updatedAt: new Date(),
          })
          .where(eq(suborders.id, suborder.id));

        orderSubtotal += groupSubtotal;
        orderShipping += shipping;
        orderFee += commissionCents;
      }

      await tx
        .update(orders)
        .set({
          subtotalCents: orderSubtotal,
          shippingCents: orderShipping,
          totalCents: orderSubtotal + orderShipping,
          platformFeeCents: orderFee,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, created.id));

      const [cart] = await tx.select().from(carts).where(eq(carts.userId, userId));
      if (cart) await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));

      return created.id;
    });

    const placed = await this.order(db, userId, orderId);

    const intent = await this.payments.createIntent({
      amountCents: placed.totalCents,
      orderNumber: placed.number,
      buyerId: userId,
    });

    await db
      .update(orders)
      .set({ paymentIntentId: intent.id, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return {
      order: placed,
      payment: {
        provider: this.payments.name,
        intentId: intent.id,
        clientSecret: intent.clientSecret,
      },
    };
  }

  private async intentOf(db: Runner, orderId: string): Promise<string | null> {
    const [row] = await db
      .select({ paymentIntentId: orders.paymentIntentId })
      .from(orders)
      .where(eq(orders.id, orderId));
    return row?.paymentIntentId ?? null;
  }

  async order(db: DrizzleDB, userId: string, orderId: string): Promise<OrderView> {
    const [row] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.buyerId, userId)));
    if (!row) throw new NotFoundException('Ese pedido no existe');

    return {
      id: row.id,
      number: row.number,
      status: row.status,
      subtotalCents: row.subtotalCents,
      shippingCents: row.shippingCents,
      totalCents: row.totalCents,
      shippingSnapshot: row.shippingSnapshot,
      suborders: await this.subordersOf(db, row.id),
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
    };
  }

  private async subordersOf(db: DrizzleDB, orderId: string): Promise<SuborderView[]> {
    const rows = await db
      .select({
        id: suborders.id,
        subtotalCents: suborders.subtotalCents,
        shippingCents: suborders.shippingCents,
        status: suborders.status,
        trackingCarrier: suborders.trackingCarrier,
        trackingNumber: suborders.trackingNumber,
        shippedAt: suborders.shippedAt,
        deliveredAt: suborders.deliveredAt,
        sellerId: sellers.id,
        sellerSlug: sellers.slug,
        storeName: sellers.storeName,
      })
      .from(suborders)
      .innerJoin(sellers, eq(sellers.id, suborders.sellerId))
      .where(eq(suborders.orderId, orderId))
      .orderBy(sellers.storeName);

    const out: SuborderView[] = [];
    for (const row of rows) {
      const items = await db
        .select()
        .from(suborderItems)
        .where(eq(suborderItems.suborderId, row.id))
        .orderBy(suborderItems.createdAt);

      out.push({
        id: row.id,
        seller: { id: row.sellerId, slug: row.sellerSlug, storeName: row.storeName },
        items: items.map((item) => ({
          id: item.id,
          productTitle: item.productTitle,
          productSlug: item.productSlug,
          variantName: item.variantName,
          sku: item.sku,
          imageKey: item.imageKey,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          lineTotalCents: item.lineTotalCents,
        })),
        subtotalCents: row.subtotalCents,
        shippingCents: row.shippingCents,
        totalCents: row.subtotalCents + row.shippingCents,
        status: row.status,
        trackingCarrier: row.trackingCarrier,
        trackingNumber: row.trackingNumber,
        shippedAt: row.shippedAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  async list(
    db: DrizzleDB,
    userId: string,
    options: { page: number; limit: number; status?: OrderStatus },
  ) {
    const where = options.status
      ? and(eq(orders.buyerId, userId), eq(orders.status, options.status))
      : eq(orders.buyerId, userId);
    const offset = (options.page - 1) * options.limit;

    const [rows, [counted]] = await Promise.all([
      db
        .select({
          id: orders.id,
          number: orders.number,
          status: orders.status,
          totalCents: orders.totalCents,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(options.limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(orders).where(where),
    ]);

    const ids = rows.map((row) => row.id);
    const counts = new Map<string, number>();
    const stores = new Map<string, string[]>();

    if (ids.length > 0) {
      const lines = await db
        .select({
          orderId: suborders.orderId,
          quantity: suborderItems.quantity,
          storeName: sellers.storeName,
        })
        .from(suborders)
        .innerJoin(sellers, eq(sellers.id, suborders.sellerId))
        .leftJoin(suborderItems, eq(suborderItems.suborderId, suborders.id))
        .where(inArray(suborders.orderId, ids));

      for (const line of lines) {
        counts.set(line.orderId, (counts.get(line.orderId) ?? 0) + (line.quantity ?? 0));
        const names = stores.get(line.orderId) ?? [];
        if (!names.includes(line.storeName)) names.push(line.storeName);
        stores.set(line.orderId, names);
      }
    }

    const total = counted?.total ?? 0;
    const items: OrderListItem[] = rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      totalCents: row.totalCents,
      itemCount: counts.get(row.id) ?? 0,
      storeNames: stores.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      items,
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    };
  }

  async markPaid(db: DrizzleDB, intentId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.paymentIntentId, intentId));

      if (!order || order.status !== 'pending_payment') return false;

      const now = new Date();
      await tx
        .update(orders)
        .set({ status: 'paid', paidAt: now, updatedAt: now })
        .where(eq(orders.id, order.id));
      await tx
        .update(suborders)
        .set({ status: 'pending_shipment', updatedAt: now })
        .where(eq(suborders.orderId, order.id));
      return true;
    });
  }

  async cancel(db: DrizzleDB, intentId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.paymentIntentId, intentId));

      if (!order || order.status !== 'pending_payment') return false;

      const rows = await tx
        .select({ variantId: suborderItems.variantId, quantity: suborderItems.quantity })
        .from(suborderItems)
        .innerJoin(suborders, eq(suborders.id, suborderItems.suborderId))
        .where(eq(suborders.orderId, order.id));

      for (const row of rows) {
        if (!row.variantId) continue;
        await tx
          .update(variants)
          .set({ stock: sql`${variants.stock} + ${row.quantity}`, updatedAt: new Date() })
          .where(eq(variants.id, row.variantId));
      }

      const now = new Date();
      await tx
        .update(orders)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(orders.id, order.id));
      await tx
        .update(suborders)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(suborders.orderId, order.id));
      return true;
    });
  }

  async transition(
    db: DrizzleDB,
    suborderId: string,
    to: SuborderStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await db
      .update(suborders)
      .set({ status: to, updatedAt: new Date(), ...extra })
      .where(eq(suborders.id, suborderId));
  }
}
