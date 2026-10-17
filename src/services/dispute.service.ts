import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ConflictException, ForbiddenException, NotFoundException } from 'veloce-ts';
import {
  DISPUTE_WINDOW_DAYS,
  type DisputeMessageView,
  type DisputeStatus,
  type DisputeView,
  type OpenDisputeDto,
  type ResolveDisputeDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { disputeMessages, disputes, orders, sellers, suborders, users } from '../db/schema';
import { AuditService } from './audit.service';

type Role = 'buyer' | 'seller' | 'platform';

export class DisputeService {
  constructor(private readonly audit: AuditService) {}

  private async context(db: DrizzleDB, suborderId: string) {
    const [row] = await db
      .select({
        suborderId: suborders.id,
        status: suborders.status,
        deliveredAt: suborders.deliveredAt,
        shippedAt: suborders.shippedAt,
        payoutId: suborders.payoutId,
        amountCents: sql<number>`(${suborders.subtotalCents} + ${suborders.shippingCents})::int`,
        orderNumber: orders.number,
        buyerId: orders.buyerId,
        sellerId: sellers.id,
        sellerUserId: sellers.userId,
        sellerSlug: sellers.slug,
        storeName: sellers.storeName,
      })
      .from(suborders)
      .innerJoin(orders, eq(orders.id, suborders.orderId))
      .innerJoin(sellers, eq(sellers.id, suborders.sellerId))
      .where(eq(suborders.id, suborderId));

    if (!row) throw new NotFoundException('Ese pedido no existe');
    return row;
  }

  private roleOf(context: { buyerId: string; sellerUserId: string }, userId: string): Role | null {
    if (context.buyerId === userId) return 'buyer';
    if (context.sellerUserId === userId) return 'seller';
    return null;
  }

  async open(
    db: DrizzleDB,
    userId: string,
    suborderId: string,
    body: OpenDisputeDto,
  ): Promise<DisputeView> {
    const context = await this.context(db, suborderId);
    if (context.buyerId !== userId) throw new NotFoundException('Ese pedido no existe');

    if (context.status !== 'shipped' && context.status !== 'delivered') {
      throw new ConflictException(
        'Solo puedes abrir una aclaración de algo que ya salió de la tienda',
      );
    }
    if (context.payoutId) {
      throw new ConflictException(
        'Ese pedido ya se le pagó al vendedor. Escríbenos y lo vemos a mano.',
      );
    }

    const since = context.deliveredAt ?? context.shippedAt;
    if (since) {
      const deadline = new Date(since.getTime() + DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      if (new Date() > deadline) {
        throw new ConflictException(
          `El plazo para abrir una aclaración es de ${DISPUTE_WINDOW_DAYS} días`,
        );
      }
    }

    const [existing] = await db
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.suborderId, suborderId), eq(disputes.status, 'open')));
    if (existing) throw new ConflictException('Ya hay una aclaración abierta de ese pedido');

    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(disputes)
        .values({
          suborderId,
          openedBy: userId,
          reason: body.reason,
          description: body.description,
        })
        .returning();
      if (!created) throw new Error('Could not open the dispute');

      await tx.insert(disputeMessages).values({
        disputeId: created.id,
        senderId: userId,
        senderRole: 'buyer',
        body: body.description,
      });

      await this.audit.record(tx, {
        userId,
        action: 'dispute.opened',
        tableName: 'disputes',
        recordId: created.id,
        newValues: { suborderId, reason: body.reason },
      });

      return created.id;
    });

    return this.detail(db, userId, id, true);
  }

  async addMessage(
    db: DrizzleDB,
    userId: string,
    disputeId: string,
    body: string,
    isAdmin: boolean,
  ): Promise<DisputeView> {
    const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
    if (!dispute) throw new NotFoundException('Esa aclaración no existe');
    if (dispute.status !== 'open') {
      throw new ConflictException('Esa aclaración ya se resolvió');
    }

    const context = await this.context(db, dispute.suborderId);
    const role = isAdmin ? 'platform' : this.roleOf(context, userId);
    if (!role) throw new NotFoundException('Esa aclaración no existe');

    await db.insert(disputeMessages).values({
      disputeId,
      senderId: userId,
      senderRole: role,
      body,
    });
    await db.update(disputes).set({ updatedAt: new Date() }).where(eq(disputes.id, disputeId));

    return this.detail(db, userId, disputeId, true);
  }

  async withdraw(db: DrizzleDB, userId: string, disputeId: string): Promise<DisputeView> {
    const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
    if (!dispute) throw new NotFoundException('Esa aclaración no existe');
    if (dispute.openedBy !== userId) throw new NotFoundException('Esa aclaración no existe');
    if (dispute.status !== 'open') throw new ConflictException('Esa aclaración ya se resolvió');

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(disputes)
        .set({ status: 'withdrawn', resolvedAt: now, updatedAt: now })
        .where(eq(disputes.id, disputeId));
      await this.audit.record(tx, {
        userId,
        action: 'dispute.withdrawn',
        tableName: 'disputes',
        recordId: disputeId,
      });
    });

    return this.detail(db, userId, disputeId, true);
  }

  async resolve(
    db: DrizzleDB,
    adminId: string,
    disputeId: string,
    body: ResolveDisputeDto,
  ): Promise<DisputeView> {
    const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
    if (!dispute) throw new NotFoundException('Esa aclaración no existe');
    if (dispute.status !== 'open') throw new ConflictException('Esa aclaración ya se resolvió');

    const now = new Date();
    const status: DisputeStatus = body.inFavorOf === 'buyer' ? 'resolved_buyer' : 'resolved_seller';

    await db.transaction(async (tx) => {
      await tx
        .update(disputes)
        .set({
          status,
          resolution: body.resolution,
          resolvedBy: adminId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(disputes.id, disputeId));

      await tx.insert(disputeMessages).values({
        disputeId,
        senderId: adminId,
        senderRole: 'platform',
        body: body.resolution,
      });

      if (body.inFavorOf === 'buyer') {
        await tx
          .update(suborders)
          .set({ status: 'refunded', updatedAt: now })
          .where(eq(suborders.id, dispute.suborderId));
      }

      await this.audit.record(tx, {
        userId: adminId,
        action: 'dispute.resolved',
        tableName: 'disputes',
        recordId: disputeId,
        oldValues: { status: 'open' },
        newValues: { status, suborderId: dispute.suborderId },
      });
    });

    return this.detail(db, adminId, disputeId, true);
  }

  async detail(
    db: DrizzleDB,
    userId: string,
    disputeId: string,
    allow = false,
  ): Promise<DisputeView> {
    const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
    if (!dispute) throw new NotFoundException('Esa aclaración no existe');

    const context = await this.context(db, dispute.suborderId);
    if (!allow && !this.roleOf(context, userId)) {
      throw new NotFoundException('Esa aclaración no existe');
    }

    const [buyer] = await db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, context.buyerId));

    const messages = await db
      .select({
        id: disputeMessages.id,
        senderRole: disputeMessages.senderRole,
        body: disputeMessages.body,
        createdAt: disputeMessages.createdAt,
        senderName: users.fullName,
      })
      .from(disputeMessages)
      .leftJoin(users, eq(users.id, disputeMessages.senderId))
      .where(eq(disputeMessages.disputeId, disputeId))
      .orderBy(disputeMessages.createdAt);

    return {
      id: dispute.id,
      suborderId: dispute.suborderId,
      orderNumber: context.orderNumber,
      reason: dispute.reason,
      description: dispute.description,
      status: dispute.status,
      resolution: dispute.resolution,
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      createdAt: dispute.createdAt.toISOString(),
      amountCents: Number(context.amountCents),
      seller: { id: context.sellerId, slug: context.sellerSlug, storeName: context.storeName },
      buyer: { id: buyer?.id ?? '', fullName: buyer?.fullName ?? '' },
      openedByRole: dispute.openedBy === context.buyerId ? 'buyer' : 'platform',
      messages: messages.map(
        (message): DisputeMessageView => ({
          id: message.id,
          senderRole: message.senderRole as DisputeMessageView['senderRole'],
          senderName: message.senderName,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
        }),
      ),
    };
  }

  async forSuborder(db: DrizzleDB, userId: string, suborderId: string): Promise<DisputeView | null> {
    const context = await this.context(db, suborderId);
    if (!this.roleOf(context, userId)) throw new NotFoundException('Ese pedido no existe');

    const [dispute] = await db
      .select({ id: disputes.id })
      .from(disputes)
      .where(eq(disputes.suborderId, suborderId))
      .orderBy(desc(disputes.createdAt))
      .limit(1);

    return dispute ? this.detail(db, userId, dispute.id, true) : null;
  }

  async list(
    db: DrizzleDB,
    options: { status?: DisputeStatus; page: number; limit: number; sellerId?: string },
  ) {
    const filters = [];
    if (options.status) filters.push(eq(disputes.status, options.status));
    if (options.sellerId) filters.push(eq(suborders.sellerId, options.sellerId));
    const where = filters.length > 0 ? and(...filters) : undefined;
    const offset = (options.page - 1) * options.limit;

    const [rows, [counted]] = await Promise.all([
      db
        .select({ id: disputes.id })
        .from(disputes)
        .innerJoin(suborders, eq(suborders.id, disputes.suborderId))
        .where(where)
        .orderBy(desc(disputes.createdAt))
        .limit(options.limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(disputes)
        .innerJoin(suborders, eq(suborders.id, disputes.suborderId))
        .where(where),
    ]);

    const items: DisputeView[] = [];
    for (const row of rows) items.push(await this.detail(db, '', row.id, true));

    const total = counted?.total ?? 0;
    return {
      items,
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    };
  }

  async openSuborderIds(db: DrizzleDB, suborderIds: string[]): Promise<Set<string>> {
    if (suborderIds.length === 0) return new Set();
    const rows = await db
      .select({ suborderId: disputes.suborderId })
      .from(disputes)
      .where(and(eq(disputes.status, 'open'), inArray(disputes.suborderId, suborderIds)));
    return new Set(rows.map((row) => row.suborderId));
  }
}
