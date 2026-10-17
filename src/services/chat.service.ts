import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { ForbiddenException, NotFoundException } from 'veloce-ts';
import type {
  ChatMessageView,
  ChatRole,
  ConversationSummary,
  ConversationView,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { conversations, messages, orders, sellers, suborders, users } from '../db/schema';

const TICKET_TTL_MS = 60_000;

interface Ticket {
  userId: string;
  suborderId: string;
  expiresAt: number;
}

export class ChatService {
  private readonly tickets = new Map<string, Ticket>();

  issueTicket(userId: string, suborderId: string): { ticket: string; expiresInSeconds: number } {
    this.sweep();
    const ticket = randomUUID();
    this.tickets.set(ticket, { userId, suborderId, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket, expiresInSeconds: TICKET_TTL_MS / 1000 };
  }

  redeemTicket(ticket: string, suborderId: string): string | null {
    this.sweep();
    const found = this.tickets.get(ticket);
    if (!found) return null;
    if (found.suborderId !== suborderId) return null;
    if (found.expiresAt < Date.now()) {
      this.tickets.delete(ticket);
      return null;
    }
    return found.userId;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.tickets) {
      if (value.expiresAt < now) this.tickets.delete(key);
    }
  }

  async participants(db: DrizzleDB, suborderId: string) {
    const [row] = await db
      .select({
        suborderId: suborders.id,
        status: suborders.status,
        orderNumber: orders.number,
        buyerId: orders.buyerId,
        buyerName: users.fullName,
        sellerId: sellers.id,
        sellerUserId: sellers.userId,
        sellerSlug: sellers.slug,
        storeName: sellers.storeName,
      })
      .from(suborders)
      .innerJoin(orders, eq(orders.id, suborders.orderId))
      .innerJoin(users, eq(users.id, orders.buyerId))
      .innerJoin(sellers, eq(sellers.id, suborders.sellerId))
      .where(eq(suborders.id, suborderId));

    if (!row) throw new NotFoundException('Ese pedido no existe');
    return row;
  }

  roleOf(context: { buyerId: string; sellerUserId: string }, userId: string): ChatRole | null {
    if (context.buyerId === userId) return 'buyer';
    if (context.sellerUserId === userId) return 'seller';
    return null;
  }

  async ensureConversation(db: DrizzleDB, userId: string, suborderId: string) {
    const context = await this.participants(db, suborderId);
    const role = this.roleOf(context, userId);
    if (!role) throw new NotFoundException('Ese pedido no existe');

    if (context.status === 'pending_payment') {
      throw new ForbiddenException('El chat se abre cuando el pedido está pagado');
    }

    const [existing] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.suborderId, suborderId));
    if (existing) return { conversation: existing, context, role };

    const [created] = await db
      .insert(conversations)
      .values({ suborderId, buyerId: context.buyerId, sellerId: context.sellerId })
      .onConflictDoNothing({ target: conversations.suborderId })
      .returning();
    if (created) return { conversation: created, context, role };

    const [raced] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.suborderId, suborderId));
    if (!raced) throw new Error('Could not create the conversation');
    return { conversation: raced, context, role };
  }

  async view(db: DrizzleDB, userId: string, suborderId: string): Promise<ConversationView> {
    const { conversation, context, role } = await this.ensureConversation(db, userId, suborderId);

    const rows = await db
      .select({
        id: messages.id,
        senderRole: messages.senderRole,
        body: messages.body,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
        senderId: messages.senderId,
        senderName: users.fullName,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(messages.createdAt);

    const [unread] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          ne(messages.senderRole, role),
          isNull(messages.readAt),
        ),
      );

    return {
      id: conversation.id,
      suborderId,
      orderNumber: context.orderNumber,
      myRole: role,
      counterpartName: role === 'buyer' ? context.storeName : context.buyerName,
      storeName: context.storeName,
      storeSlug: context.sellerSlug,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      unreadCount: Number(unread?.total ?? 0),
      messages: rows.map((row) => this.toView(row, userId)),
    };
  }

  private toView(
    row: {
      id: string;
      senderRole: string;
      body: string;
      readAt: Date | null;
      createdAt: Date;
      senderId: string | null;
      senderName: string | null;
    },
    userId: string,
  ): ChatMessageView {
    return {
      id: row.id,
      senderRole: row.senderRole as ChatRole,
      senderName: row.senderName,
      body: row.body,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      isMine: Boolean(userId) && row.senderId === userId,
    };
  }

  async send(
    db: DrizzleDB,
    userId: string,
    suborderId: string,
    body: string,
  ): Promise<ChatMessageView> {
    const { conversation, role } = await this.ensureConversation(db, userId, suborderId);

    const now = new Date();
    const [created] = await db
      .insert(messages)
      .values({ conversationId: conversation.id, senderId: userId, senderRole: role, body })
      .returning();
    if (!created) throw new Error('Could not send the message');

    await db
      .update(conversations)
      .set({ lastMessageAt: now })
      .where(eq(conversations.id, conversation.id));

    const [sender] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId));

    return this.toView(
      {
        id: created.id,
        senderRole: created.senderRole,
        body: created.body,
        readAt: created.readAt,
        createdAt: created.createdAt,
        senderId: userId,
        senderName: sender?.fullName ?? null,
      },
      userId,
    );
  }

  async markRead(db: DrizzleDB, userId: string, suborderId: string): Promise<{ read: number }> {
    const { conversation, role } = await this.ensureConversation(db, userId, suborderId);

    const updated = await db
      .update(messages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          ne(messages.senderRole, role),
          isNull(messages.readAt),
        ),
      )
      .returning({ id: messages.id });

    return { read: updated.length };
  }

  async inbox(db: DrizzleDB, userId: string): Promise<ConversationSummary[]> {
    const [store] = await db
      .select({ id: sellers.id })
      .from(sellers)
      .where(and(eq(sellers.userId, userId), isNull(sellers.deletedAt)));

    const where = store
      ? sql`${conversations.buyerId} = ${userId} OR ${conversations.sellerId} = ${store.id}`
      : eq(conversations.buyerId, userId);

    const rows = await db
      .select({
        id: conversations.id,
        suborderId: conversations.suborderId,
        buyerId: conversations.buyerId,
        lastMessageAt: conversations.lastMessageAt,
        orderNumber: orders.number,
        buyerName: users.fullName,
        storeName: sellers.storeName,
      })
      .from(conversations)
      .innerJoin(suborders, eq(suborders.id, conversations.suborderId))
      .innerJoin(orders, eq(orders.id, suborders.orderId))
      .innerJoin(users, eq(users.id, conversations.buyerId))
      .innerJoin(sellers, eq(sellers.id, conversations.sellerId))
      .where(where)
      .orderBy(desc(conversations.lastMessageAt));

    const out: ConversationSummary[] = [];
    for (const row of rows) {
      const myRole: ChatRole = row.buyerId === userId ? 'buyer' : 'seller';

      const [unread] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, row.id),
            ne(messages.senderRole, myRole),
            isNull(messages.readAt),
          ),
        );

      const [last] = await db
        .select({ body: messages.body })
        .from(messages)
        .where(eq(messages.conversationId, row.id))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      out.push({
        id: row.id,
        suborderId: row.suborderId,
        orderNumber: row.orderNumber,
        counterpartName: myRole === 'buyer' ? row.storeName : row.buyerName,
        storeName: row.storeName,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        lastMessageBody: last?.body ?? null,
        unreadCount: Number(unread?.total ?? 0),
      });
    }

    return out;
  }

  async unreadTotal(db: DrizzleDB, userId: string): Promise<number> {
    const rows = await this.inbox(db, userId);
    return rows.reduce((sum, row) => sum + row.unreadCount, 0);
  }
}
