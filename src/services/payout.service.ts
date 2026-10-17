import { and, desc, eq, isNull, isNotNull, lte, sql } from 'drizzle-orm';
import type {
  PayoutLine,
  PayoutRunResult,
  PayoutStatus,
  PayoutView,
  SellerEarnings,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { orders, payouts, sellers, suborders } from '../db/schema';
import type { PaymentProvider } from './payments';
import { AuditService } from './audit.service';

interface EligibleRow {
  suborderId: string;
  sellerId: string;
  orderNumber: string;
  subtotalCents: number;
  shippingCents: number;
  commissionCents: number;
  payoutCents: number;
  deliveredAt: Date | null;
}

export class PayoutService {
  constructor(
    private readonly payments: PaymentProvider,
    private readonly audit: AuditService,
  ) {}

  get holdDays(): number {
    const parsed = Number(process.env.PAYOUT_HOLD_DAYS ?? 3);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
  }

  private releaseCutoff(): Date {
    return new Date(Date.now() - this.holdDays * 24 * 60 * 60 * 1000);
  }

  private releasesAt(deliveredAt: Date | null): Date | null {
    if (!deliveredAt) return null;
    return new Date(deliveredAt.getTime() + this.holdDays * 24 * 60 * 60 * 1000);
  }

  private async eligible(db: DrizzleDB, sellerId?: string): Promise<EligibleRow[]> {
    const filters = [
      eq(suborders.status, 'delivered'),
      isNull(suborders.payoutId),
      isNotNull(suborders.deliveredAt),
      sql`NOT EXISTS (
        SELECT 1 FROM disputes d
         WHERE d.suborder_id = suborders.id AND d.status = 'open'
      )`,
    ];
    if (sellerId) filters.push(eq(suborders.sellerId, sellerId));

    return db
      .select({
        suborderId: suborders.id,
        sellerId: suborders.sellerId,
        orderNumber: orders.number,
        subtotalCents: suborders.subtotalCents,
        shippingCents: suborders.shippingCents,
        commissionCents: suborders.commissionCents,
        payoutCents: suborders.payoutCents,
        deliveredAt: suborders.deliveredAt,
      })
      .from(suborders)
      .innerJoin(orders, eq(orders.id, suborders.orderId))
      .where(and(...filters))
      .orderBy(desc(suborders.deliveredAt));
  }

  async earnings(db: DrizzleDB, sellerId: string): Promise<SellerEarnings> {
    const rows = await this.eligible(db, sellerId);
    const cutoff = this.releaseCutoff();

    const lines: PayoutLine[] = rows.map((row) => {
      const releases = this.releasesAt(row.deliveredAt);
      return {
        suborderId: row.suborderId,
        orderNumber: row.orderNumber,
        subtotalCents: row.subtotalCents,
        shippingCents: row.shippingCents,
        commissionCents: row.commissionCents,
        payoutCents: row.payoutCents,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        releasesAt: releases?.toISOString() ?? null,
        held: Boolean(row.deliveredAt && row.deliveredAt > cutoff),
      };
    });

    const ready = lines.filter((line) => !line.held);
    const held = lines.filter((line) => line.held);
    const nextRelease = held
      .map((line) => line.releasesAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];

    const [paidTotal] = await db
      .select({ total: sql<number>`coalesce(sum(${payouts.amountCents}), 0)::int` })
      .from(payouts)
      .where(and(eq(payouts.sellerId, sellerId), eq(payouts.status, 'paid')));

    return {
      holdDays: this.holdDays,
      pending: {
        amountCents: ready.reduce((sum, line) => sum + line.payoutCents, 0),
        count: ready.length,
      },
      held: {
        amountCents: held.reduce((sum, line) => sum + line.payoutCents, 0),
        count: held.length,
        nextReleaseAt: nextRelease ?? null,
      },
      paidTotalCents: Number(paidTotal?.total ?? 0),
      lines,
      payouts: await this.list(db, { sellerId, page: 1, limit: 20 }).then((r) => r.items),
    };
  }

  async list(
    db: DrizzleDB,
    options: { sellerId?: string; status?: PayoutStatus; page: number; limit: number },
  ) {
    const filters = [];
    if (options.sellerId) filters.push(eq(payouts.sellerId, options.sellerId));
    if (options.status) filters.push(eq(payouts.status, options.status));
    const where = filters.length > 0 ? and(...filters) : undefined;
    const offset = (options.page - 1) * options.limit;

    const [rows, [counted]] = await Promise.all([
      db
        .select({
          id: payouts.id,
          amountCents: payouts.amountCents,
          commissionCents: payouts.commissionCents,
          suborderCount: payouts.suborderCount,
          periodStart: payouts.periodStart,
          periodEnd: payouts.periodEnd,
          status: payouts.status,
          transferId: payouts.transferId,
          failureReason: payouts.failureReason,
          createdAt: payouts.createdAt,
          paidAt: payouts.paidAt,
          sellerId: sellers.id,
          sellerSlug: sellers.slug,
          storeName: sellers.storeName,
        })
        .from(payouts)
        .innerJoin(sellers, eq(sellers.id, payouts.sellerId))
        .where(where)
        .orderBy(desc(payouts.createdAt))
        .limit(options.limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(payouts).where(where),
    ]);

    const items: PayoutView[] = rows.map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      commissionCents: row.commissionCents,
      suborderCount: row.suborderCount,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      status: row.status,
      transferId: row.transferId,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      seller: { id: row.sellerId, slug: row.sellerSlug, storeName: row.storeName },
    }));

    const total = counted?.total ?? 0;
    return {
      items,
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    };
  }

  async run(db: DrizzleDB, adminId: string): Promise<PayoutRunResult> {
    const rows = await this.eligible(db);
    const cutoff = this.releaseCutoff();

    const ready = rows.filter((row) => row.deliveredAt && row.deliveredAt <= cutoff);
    const skippedHeld = rows.length - ready.length;

    const bySeller = new Map<string, EligibleRow[]>();
    for (const row of ready) {
      const list = bySeller.get(row.sellerId) ?? [];
      list.push(row);
      bySeller.set(row.sellerId, list);
    }

    let created = 0;
    let totalCents = 0;

    for (const [sellerId, group] of bySeller) {
      const amountCents = group.reduce((sum, row) => sum + row.payoutCents, 0);
      const commissionCents = group.reduce((sum, row) => sum + row.commissionCents, 0);
      const dates = group
        .map((row) => row.deliveredAt)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => a.getTime() - b.getTime());

      const payoutId = await db.transaction(async (tx) => {
        const [payout] = await tx
          .insert(payouts)
          .values({
            sellerId,
            amountCents,
            commissionCents,
            suborderCount: group.length,
            periodStart: dates[0] ?? new Date(),
            periodEnd: dates[dates.length - 1] ?? new Date(),
          })
          .returning();
        if (!payout) throw new Error('Could not create the payout');

        for (const row of group) {
          const claimed = await tx
            .update(suborders)
            .set({ payoutId: payout.id, updatedAt: new Date() })
            .where(and(eq(suborders.id, row.suborderId), isNull(suborders.payoutId)))
            .returning({ id: suborders.id });

          if (claimed.length === 0) throw new Error('Suborder already claimed by another run');
        }

        await this.audit.record(tx, {
          userId: adminId,
          action: 'payout.created',
          tableName: 'payouts',
          recordId: payout.id,
          newValues: { amountCents, suborderCount: group.length, sellerId },
        });

        return payout.id;
      });

      try {
        const transfer = await this.payments.createTransfer({
          amountCents,
          sellerId,
          reference: payoutId,
        });
        const now = new Date();
        await db
          .update(payouts)
          .set({ status: 'paid', transferId: transfer.id, paidAt: now })
          .where(eq(payouts.id, payoutId));
        await db
          .update(suborders)
          .set({ transferId: transfer.id, transferredAt: now, updatedAt: now })
          .where(eq(suborders.payoutId, payoutId));
      } catch (error) {
        await db
          .update(payouts)
          .set({
            status: 'failed',
            failureReason: error instanceof Error ? error.message : 'transfer failed',
          })
          .where(eq(payouts.id, payoutId));

        await db
          .update(suborders)
          .set({ payoutId: null, updatedAt: new Date() })
          .where(eq(suborders.payoutId, payoutId));
      }

      created += 1;
      totalCents += amountCents;
    }

    return { created, totalCents, sellers: bySeller.size, skippedHeld };
  }
}
