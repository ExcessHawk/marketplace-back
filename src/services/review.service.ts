import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ConflictException, NotFoundException } from 'veloce-ts';
import type {
  CreateReviewDto,
  RatingSummary,
  ReviewView,
  ReviewableItem,
  UpdateReviewDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import {
  orders,
  products,
  reviews,
  sellers,
  suborderItems,
  suborders,
  users,
} from '../db/schema';

type Runner = Pick<DrizzleDB, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export class ReviewService {
  private async recompute(tx: Runner, productId: string, sellerId: string): Promise<void> {
    const [product] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        average: sql<number>`coalesce(round(avg(${reviews.rating}) * 100), 0)::int`,
      })
      .from(reviews)
      .where(eq(reviews.productId, productId));

    await tx
      .update(products)
      .set({
        ratingCount: Number(product?.count ?? 0),
        ratingAvg: Number(product?.count ?? 0) > 0 ? Number(product?.average ?? 0) : null,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId));

    const [store] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        average: sql<number>`coalesce(round(avg(${reviews.rating}) * 100), 0)::int`,
      })
      .from(reviews)
      .where(eq(reviews.sellerId, sellerId));

    await tx
      .update(sellers)
      .set({
        ratingCount: Number(store?.count ?? 0),
        ratingAvg: Number(store?.count ?? 0) > 0 ? Number(store?.average ?? 0) : null,
        updatedAt: new Date(),
      })
      .where(eq(sellers.id, sellerId));
  }

  private async deliveredSuborder(db: DrizzleDB, userId: string, suborderId: string) {
    const [row] = await db
      .select({
        id: suborders.id,
        sellerId: suborders.sellerId,
        status: suborders.status,
        buyerId: orders.buyerId,
      })
      .from(suborders)
      .innerJoin(orders, eq(orders.id, suborders.orderId))
      .where(eq(suborders.id, suborderId));

    if (!row || row.buyerId !== userId) throw new NotFoundException('Ese pedido no existe');
    return row;
  }

  async reviewable(
    db: DrizzleDB,
    userId: string,
    suborderId: string,
  ): Promise<{ canReview: boolean; items: ReviewableItem[] }> {
    const suborder = await this.deliveredSuborder(db, userId, suborderId);

    const rows = await db
      .select({
        productId: products.id,
        productSlug: products.slug,
        productTitle: products.title,
        imageKey: suborderItems.imageKey,
        reviewId: reviews.id,
        rating: reviews.rating,
        body: reviews.body,
      })
      .from(suborderItems)
      .innerJoin(products, eq(products.slug, suborderItems.productSlug))
      .leftJoin(
        reviews,
        and(eq(reviews.suborderId, suborderId), eq(reviews.productId, products.id)),
      )
      .where(eq(suborderItems.suborderId, suborderId));

    const seen = new Set<string>();
    const items: ReviewableItem[] = [];
    for (const row of rows) {
      if (seen.has(row.productId)) continue;
      seen.add(row.productId);
      items.push({
        productId: row.productId,
        productSlug: row.productSlug,
        productTitle: row.productTitle,
        imageKey: row.imageKey,
        review: row.reviewId
          ? { id: row.reviewId, rating: row.rating ?? 0, body: row.body ?? null }
          : null,
      });
    }

    return { canReview: suborder.status === 'delivered', items };
  }

  async create(
    db: DrizzleDB,
    userId: string,
    suborderId: string,
    body: CreateReviewDto,
  ): Promise<ReviewView> {
    const suborder = await this.deliveredSuborder(db, userId, suborderId);
    if (suborder.status !== 'delivered') {
      throw new ConflictException('Solo puedes opinar de lo que ya recibiste');
    }

    const [bought] = await db
      .select({ id: suborderItems.id })
      .from(suborderItems)
      .innerJoin(products, eq(products.slug, suborderItems.productSlug))
      .where(and(eq(suborderItems.suborderId, suborderId), eq(products.id, body.productId)));
    if (!bought) throw new NotFoundException('Ese producto no está en ese pedido');

    const [existing] = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.suborderId, suborderId), eq(reviews.productId, body.productId)));
    if (existing) throw new ConflictException('Ya opinaste de ese producto en este pedido');

    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(reviews)
        .values({
          suborderId,
          productId: body.productId,
          sellerId: suborder.sellerId,
          buyerId: userId,
          rating: body.rating,
          body: body.body ?? null,
        })
        .returning();
      if (!created) throw new Error('Could not create the review');

      await this.recompute(tx, body.productId, suborder.sellerId);
      return created.id;
    });

    return this.detail(db, userId, id);
  }

  async update(
    db: DrizzleDB,
    userId: string,
    reviewId: string,
    body: UpdateReviewDto,
  ): Promise<ReviewView> {
    const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    if (!review || review.buyerId !== userId) {
      throw new NotFoundException('Esa opinión no es tuya');
    }

    await db.transaction(async (tx) => {
      await tx
        .update(reviews)
        .set({ rating: body.rating, body: body.body ?? null, updatedAt: new Date() })
        .where(eq(reviews.id, reviewId));
      await this.recompute(tx, review.productId, review.sellerId);
    });

    return this.detail(db, userId, reviewId);
  }

  async remove(db: DrizzleDB, userId: string, reviewId: string): Promise<void> {
    const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    if (!review || review.buyerId !== userId) {
      throw new NotFoundException('Esa opinión no es tuya');
    }

    await db.transaction(async (tx) => {
      await tx.delete(reviews).where(eq(reviews.id, reviewId));
      await this.recompute(tx, review.productId, review.sellerId);
    });
  }

  async reply(
    db: DrizzleDB,
    sellerId: string,
    reviewId: string,
    reply: string,
  ): Promise<ReviewView> {
    const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    if (!review || review.sellerId !== sellerId) {
      throw new NotFoundException('Esa opinión no es de tu tienda');
    }

    await db
      .update(reviews)
      .set({ sellerReply: reply, repliedAt: new Date(), updatedAt: new Date() })
      .where(eq(reviews.id, reviewId));

    return this.detail(db, '', reviewId);
  }

  async detail(db: DrizzleDB, userId: string, reviewId: string): Promise<ReviewView> {
    const [row] = await db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        body: reviews.body,
        sellerReply: reviews.sellerReply,
        repliedAt: reviews.repliedAt,
        createdAt: reviews.createdAt,
        buyerId: reviews.buyerId,
        authorName: users.fullName,
        productId: products.id,
        productSlug: products.slug,
        productTitle: products.title,
      })
      .from(reviews)
      .innerJoin(products, eq(products.id, reviews.productId))
      .leftJoin(users, eq(users.id, reviews.buyerId))
      .where(eq(reviews.id, reviewId));

    if (!row) throw new NotFoundException('Esa opinión no existe');
    return this.toView(row, userId);
  }

  private toView(
    row: {
      id: string;
      rating: number;
      body: string | null;
      sellerReply: string | null;
      repliedAt: Date | null;
      createdAt: Date;
      buyerId: string | null;
      authorName: string | null;
      productId: string;
      productSlug: string;
      productTitle: string;
    },
    userId: string,
  ): ReviewView {
    const name = row.authorName?.trim() ?? '';
    const parts = name.split(/\s+/).filter(Boolean);
    const shown = parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : (parts[0] ?? 'Alguien');

    return {
      id: row.id,
      rating: row.rating,
      body: row.body,
      authorName: shown,
      createdAt: row.createdAt.toISOString(),
      sellerReply: row.sellerReply,
      repliedAt: row.repliedAt?.toISOString() ?? null,
      product: { id: row.productId, slug: row.productSlug, title: row.productTitle },
      isMine: Boolean(userId) && row.buyerId === userId,
    };
  }

  async listForProduct(
    db: DrizzleDB,
    userId: string,
    slug: string,
    options: { page: number; limit: number; rating?: number },
  ) {
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.slug, slug), isNull(products.deletedAt)));
    if (!product) throw new NotFoundException('Ese producto no existe');

    return this.listWhere(
      db,
      userId,
      options.rating
        ? and(eq(reviews.productId, product.id), eq(reviews.rating, options.rating))
        : eq(reviews.productId, product.id),
      options,
    );
  }

  async listForSeller(
    db: DrizzleDB,
    userId: string,
    sellerId: string,
    options: { page: number; limit: number; rating?: number },
  ) {
    return this.listWhere(
      db,
      userId,
      options.rating
        ? and(eq(reviews.sellerId, sellerId), eq(reviews.rating, options.rating))
        : eq(reviews.sellerId, sellerId),
      options,
    );
  }

  private async listWhere(
    db: DrizzleDB,
    userId: string,
    where: ReturnType<typeof eq> | undefined,
    options: { page: number; limit: number },
  ) {
    const offset = (options.page - 1) * options.limit;

    const [rows, [counted]] = await Promise.all([
      db
        .select({
          id: reviews.id,
          rating: reviews.rating,
          body: reviews.body,
          sellerReply: reviews.sellerReply,
          repliedAt: reviews.repliedAt,
          createdAt: reviews.createdAt,
          buyerId: reviews.buyerId,
          authorName: users.fullName,
          productId: products.id,
          productSlug: products.slug,
          productTitle: products.title,
        })
        .from(reviews)
        .innerJoin(products, eq(products.id, reviews.productId))
        .leftJoin(users, eq(users.id, reviews.buyerId))
        .where(where)
        .orderBy(desc(reviews.createdAt))
        .limit(options.limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(reviews).where(where),
    ]);

    const total = counted?.total ?? 0;
    return {
      items: rows.map((row) => this.toView(row, userId)),
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    };
  }

  async summaryForProduct(db: DrizzleDB, slug: string): Promise<RatingSummary> {
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.slug, slug), isNull(products.deletedAt)));
    if (!product) throw new NotFoundException('Ese producto no existe');

    const rows = await db
      .select({ rating: reviews.rating, count: sql<number>`count(*)::int` })
      .from(reviews)
      .where(eq(reviews.productId, product.id))
      .groupBy(reviews.rating);

    const breakdown = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as RatingSummary['breakdown'];
    let total = 0;
    let weighted = 0;
    for (const row of rows) {
      const key = String(row.rating) as keyof RatingSummary['breakdown'];
      breakdown[key] = Number(row.count);
      total += Number(row.count);
      weighted += row.rating * Number(row.count);
    }

    return {
      average: total > 0 ? Math.round((weighted / total) * 100) / 100 : null,
      count: total,
      breakdown,
    };
  }
}
