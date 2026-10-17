import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  ConflictException,
  Controller,
  Ctx,
  Delete,
  ForbiddenException,
  Get,
  InjectDB,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import {
  CreateProductSchema,
  CreateSellerSchema,
  PaginationSchema,
  ReplaceShippingRatesSchema,
  ReplaceVariantsSchema,
  UpdateProductSchema,
  UpdateSellerSchema,
  type CreateProductDto,
  type CreateSellerDto,
  type PaginationDto,
  type ReplaceShippingRatesDto,
  type ReplaceVariantsDto,
  type SellerProductDetail,
  type UpdateProductDto,
  type ShippingRateView,
  type UpdateSellerDto,
  type VariantView,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { products, sellers, shippingRates, variants } from '../db/schema';

function toVariantView(row: typeof variants.$inferSelect): VariantView {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    priceCents: row.priceCents,
    compareAtCents: row.compareAtCents,
    stock: row.stock,
    imageKeys: row.imageKeys,
  };
}

@Controller('/api/seller')
export class SellerController {
  constructor(@InjectDB() private db: DrizzleDB) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  private async requireStore(c: Context) {
    const [store] = await this.db
      .select()
      .from(sellers)
      .where(and(eq(sellers.userId, this.userId(c)), isNull(sellers.deletedAt)));

    if (!store) throw new ForbiddenException('Esta cuenta no tiene tienda');
    if (store.status !== 'active') {
      const what = store.status === 'pending' ? 'está en revisión' : 'está suspendida';
      const why = store.statusReason ? `: ${store.statusReason}` : '';
      throw new ForbiddenException(`Tu tienda ${what}${why}`);
    }
    return store;
  }

  private async requireOwnProduct(c: Context, productId: string) {
    const store = await this.requireStore(c);
    const [product] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)));

    if (!product || product.sellerId !== store.id) {
      throw new NotFoundException('Ese producto no existe');
    }
    return { store, product };
  }

  private async ownRates(sellerId: string): Promise<ShippingRateView[]> {
    const rows = await this.db
      .select()
      .from(shippingRates)
      .where(and(eq(shippingRates.sellerId, sellerId), isNull(shippingRates.deletedAt)))
      .orderBy(asc(shippingRates.zone));

    return rows.map((row) => ({
      id: row.id,
      zone: row.zone,
      baseCents: row.baseCents,
      perKgCents: row.perKgCents,
      freeOverCents: row.freeOverCents,
    }));
  }

  private async ownVariants(productId: string): Promise<VariantView[]> {
    const rows = await this.db
      .select()
      .from(variants)
      .where(and(eq(variants.productId, productId), isNull(variants.deletedAt)))
      .orderBy(asc(variants.position), asc(variants.id));

    return rows.map(toVariantView);
  }

  @Post('/register')
  @Roles(['buyer', 'seller', 'admin'])
  async openStore(@Body(CreateSellerSchema) body: CreateSellerDto, @Ctx() c: Context) {
    const userId = this.userId(c);

    const [existing] = await this.db
      .select({ id: sellers.id })
      .from(sellers)
      .where(and(eq(sellers.userId, userId), isNull(sellers.deletedAt)));
    if (existing) throw new ConflictException('Esta cuenta ya tiene una tienda');

    const [slugTaken] = await this.db
      .select({ id: sellers.id })
      .from(sellers)
      .where(and(eq(sellers.slug, body.slug), isNull(sellers.deletedAt)));
    if (slugTaken) throw new ConflictException('Esa dirección de tienda ya está ocupada');

    const [store] = await this.db
      .insert(sellers)
      .values({
        userId,
        storeName: body.storeName,
        slug: body.slug,
        description: body.description ?? null,
        commissionBps: Number(process.env.PLATFORM_COMMISSION_BPS ?? 1000),
      })
      .returning();

    c.status(201);
    return {
      seller: store,
      message: 'Tienda creada y en revisión. Actualiza tu sesión para tener acceso de vendedor.',
    };
  }

  @Get('/me')
  @Roles(['seller', 'admin'])
  async myStore(@Ctx() c: Context) {
    return this.requireStore(c);
  }

  @Patch('/me')
  @Roles(['seller', 'admin'])
  async updateStore(@Body(UpdateSellerSchema) body: UpdateSellerDto, @Ctx() c: Context) {
    const store = await this.requireStore(c);
    const [updated] = await this.db
      .update(sellers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(sellers.id, store.id))
      .returning();
    return updated;
  }

  @Get('/shipping')
  @Roles(['seller', 'admin'])
  async listShipping(@Ctx() c: Context): Promise<{ rates: ShippingRateView[] }> {
    const store = await this.requireStore(c);
    return { rates: await this.ownRates(store.id) };
  }

  @Put('/shipping')
  @Roles(['seller', 'admin'])
  async replaceShipping(
    @Body(ReplaceShippingRatesSchema) body: ReplaceShippingRatesDto,
    @Ctx() c: Context,
  ): Promise<{ rates: ShippingRateView[] }> {
    const store = await this.requireStore(c);
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(shippingRates)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(shippingRates.sellerId, store.id), isNull(shippingRates.deletedAt)));

      if (body.rates.length > 0) {
        await tx.insert(shippingRates).values(
          body.rates.map((rate) => ({
            sellerId: store.id,
            zone: rate.zone,
            baseCents: rate.baseCents,
            perKgCents: rate.perKgCents,
            freeOverCents: rate.freeOverCents ?? null,
          })),
        );
      }
    });

    return { rates: await this.ownRates(store.id) };
  }

  @Get('/products')
  @Roles(['seller', 'admin'])
  async listProducts(@Query(PaginationSchema) query: PaginationDto, @Ctx() c: Context) {
    const store = await this.requireStore(c);
    const offset = (query.page - 1) * query.limit;

    const where = and(eq(products.sellerId, store.id), isNull(products.deletedAt));

    const [rows, [counted]] = await Promise.all([
      this.db
        .select({
          id: products.id,
          slug: products.slug,
          title: products.title,
          status: products.status,
          publishedAt: products.publishedAt,
          updatedAt: products.updatedAt,
        })
        .from(products)
        .where(where)
        .orderBy(desc(products.updatedAt))
        .limit(query.limit)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
    ]);

    const total = counted?.total ?? 0;
    return {
      items: rows,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  @Post('/products')
  @Roles(['seller', 'admin'])
  async createProduct(@Body(CreateProductSchema) body: CreateProductDto, @Ctx() c: Context) {
    const store = await this.requireStore(c);

    const [slugTaken] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.slug, body.slug), isNull(products.deletedAt)));
    if (slugTaken) throw new ConflictException('Esa dirección de producto ya está ocupada');

    const created = await this.db.transaction(async (tx) => {
      const [product] = await tx
        .insert(products)
        .values({
          sellerId: store.id,
          categoryId: body.categoryId ?? null,
          slug: body.slug,
          title: body.title,
          description: body.description ?? null,
        })
        .returning();

      if (!product) throw new Error('Failed to create product');

      const rows = await tx
        .insert(variants)
        .values(
          body.variants.map((v, i) => ({
            productId: product.id,
            name: v.name,
            sku: v.sku ?? null,
            priceCents: v.priceCents,
            compareAtCents: v.compareAtCents ?? null,
            stock: v.stock,
            weightGrams: v.weightGrams ?? null,
            imageKeys: v.imageKeys,
            position: i,
          })),
        )
        .returning();

      return { ...product, variants: rows };
    });

    c.status(201);
    return created;
  }

  @Get('/products/:id')
  @Roles(['seller', 'admin'])
  async getProduct(@Param('id') id: string, @Ctx() c: Context): Promise<SellerProductDetail> {
    const { product } = await this.requireOwnProduct(c, id);
    const rows = await this.ownVariants(product.id);

    return {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      categoryId: product.categoryId,
      status: product.status,
      publishedAt: product.publishedAt?.toISOString() ?? null,
      updatedAt: product.updatedAt.toISOString(),
      variants: rows,
    };
  }

  @Put('/products/:id/variants')
  @Roles(['seller', 'admin'])
  async replaceVariants(
    @Param('id') id: string,
    @Body(ReplaceVariantsSchema) body: ReplaceVariantsDto,
    @Ctx() c: Context,
  ) {
    const { product } = await this.requireOwnProduct(c, id);

    const existing = await this.db
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.productId, product.id), isNull(variants.deletedAt)));

    const existingIds = new Set(existing.map((row) => row.id));
    const keptIds = body.variants.flatMap((v) => (v.id ? [v.id] : []));

    for (const keptId of keptIds) {
      if (!existingIds.has(keptId)) throw new NotFoundException('Esa variante no existe');
    }

    const removedIds = [...existingIds].filter((rowId) => !keptIds.includes(rowId));

    return this.db.transaction(async (tx) => {
      const now = new Date();

      if (removedIds.length) {
        await tx
          .update(variants)
          .set({ deletedAt: now, updatedAt: now, sku: null })
          .where(inArray(variants.id, removedIds));
      }
      if (keptIds.length) {
        await tx.update(variants).set({ sku: null }).where(inArray(variants.id, keptIds));
      }

      for (const [position, input] of body.variants.entries()) {
        const values = {
          name: input.name,
          sku: input.sku ?? null,
          priceCents: input.priceCents,
          compareAtCents: input.compareAtCents ?? null,
          stock: input.stock,
          weightGrams: input.weightGrams ?? null,
          imageKeys: input.imageKeys,
          position,
          updatedAt: now,
        };

        if (input.id) {
          await tx.update(variants).set(values).where(eq(variants.id, input.id));
        } else {
          await tx.insert(variants).values({ productId: product.id, ...values });
        }
      }

      await tx.update(products).set({ updatedAt: now }).where(eq(products.id, product.id));

      const rows = await tx
        .select()
        .from(variants)
        .where(and(eq(variants.productId, product.id), isNull(variants.deletedAt)))
        .orderBy(asc(variants.position), asc(variants.id));

      return { variants: rows.map(toVariantView) };
    });
  }

  @Patch('/products/:id')
  @Roles(['seller', 'admin'])
  async updateProduct(
    @Param('id') id: string,
    @Body(UpdateProductSchema) body: UpdateProductDto,
    @Ctx() c: Context,
  ) {
    await this.requireOwnProduct(c, id);
    const [updated] = await this.db
      .update(products)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return updated;
  }

  @Post('/products/:id/publish')
  @Roles(['seller', 'admin'])
  async publishProduct(@Param('id') id: string, @Ctx() c: Context) {
    const { product } = await this.requireOwnProduct(c, id);

    const [variant] = await this.db
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.productId, product.id), isNull(variants.deletedAt)))
      .limit(1);
    if (!variant) throw new ConflictException('Un producto necesita al menos una variante para publicarse');

    const [updated] = await this.db
      .update(products)
      .set({
        status: 'published',
        publishedAt: product.publishedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(products.id, id))
      .returning();
    return updated;
  }

  @Delete('/products/:id')
  @Roles(['seller', 'admin'])
  async deleteProduct(@Param('id') id: string, @Ctx() c: Context) {
    await this.requireOwnProduct(c, id);
    await this.db
      .update(products)
      .set({ deletedAt: new Date(), status: 'archived', updatedAt: new Date() })
      .where(eq(products.id, id));
    return { message: 'Producto eliminado' };
  }
}
