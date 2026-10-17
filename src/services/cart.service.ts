import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ConflictException, NotFoundException } from 'veloce-ts';
import type {
  CartGroup,
  CartLine,
  CartLineIssue,
  CartSummary,
  CartView,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { cartItems, carts, products, sellers, shippingRates, variants } from '../db/schema';

type Runner = Pick<DrizzleDB, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

interface LineRow extends Record<string, unknown> {
  id: string;
  variant_id: string;
  quantity: number;
  price_cents_at_add: number;
  current_price_cents: number;
  stock: number;
  weight_grams: number | null;
  added_at: Date;
  variant_name: string;
  variant_sku: string | null;
  variant_deleted: boolean;
  product_id: string;
  product_slug: string;
  product_title: string;
  product_status: string;
  product_deleted: boolean;
  image_key: string | null;
  seller_id: string;
  seller_slug: string;
  store_name: string;
  seller_status: string;
}

function issueOf(row: LineRow): CartLineIssue | null {
  if (row.product_deleted || row.variant_deleted || row.product_status !== 'published') {
    return 'unavailable';
  }
  if (row.seller_status !== 'active') return 'store_closed';
  if (row.stock <= 0) return 'out_of_stock';
  if (row.stock < row.quantity) return 'low_stock';
  return null;
}

export class CartService {
  async ensureCart(db: Runner, userId: string): Promise<{ id: string; updatedAt: Date }> {
    const [existing] = await db.select().from(carts).where(eq(carts.userId, userId));
    if (existing) return { id: existing.id, updatedAt: existing.updatedAt };

    const [created] = await db
      .insert(carts)
      .values({ userId })
      .onConflictDoNothing({ target: carts.userId })
      .returning();
    if (created) return { id: created.id, updatedAt: created.updatedAt };

    const [raced] = await db.select().from(carts).where(eq(carts.userId, userId));
    if (!raced) throw new Error('Could not create the cart');
    return { id: raced.id, updatedAt: raced.updatedAt };
  }

  private async lines(db: Runner, cartId: string): Promise<LineRow[]> {
    const result = await db.execute<LineRow>(sql`
      SELECT
        ci.id,
        ci.variant_id,
        ci.quantity,
        ci.price_cents_at_add,
        ci.created_at              AS added_at,
        v.price_cents              AS current_price_cents,
        v.stock,
        v.weight_grams,
        v.name                     AS variant_name,
        v.sku                      AS variant_sku,
        (v.deleted_at IS NOT NULL) AS variant_deleted,
        p.id                       AS product_id,
        p.slug                     AS product_slug,
        p.title                    AS product_title,
        p.status::text             AS product_status,
        (p.deleted_at IS NOT NULL) AS product_deleted,
        (SELECT iv.image_keys ->> 0
           FROM variants iv
          WHERE iv.product_id = p.id AND iv.deleted_at IS NULL
            AND jsonb_array_length(iv.image_keys) > 0
          ORDER BY iv.position, iv.id
          LIMIT 1)                 AS image_key,
        s.id                       AS seller_id,
        s.slug                     AS seller_slug,
        s.store_name,
        s.status::text             AS seller_status
      FROM cart_items ci
      JOIN variants v ON v.id = ci.variant_id
      JOIN products p ON p.id = v.product_id
      JOIN sellers  s ON s.id = p.seller_id
      WHERE ci.cart_id = ${cartId}
      ORDER BY s.store_name, ci.created_at
    `);
    return result.rows;
  }

  async view(db: DrizzleDB, userId: string): Promise<CartView> {
    const cart = await this.ensureCart(db, userId);
    const rows = await this.lines(db, cart.id);

    const groups = new Map<string, CartGroup>();
    let subtotalCents = 0;
    let itemCount = 0;
    let hasPriceChanges = false;
    let hasBlockers = false;

    for (const row of rows) {
      const issue = issueOf(row);
      const lineTotalCents = row.price_cents_at_add * row.quantity;

      const line: CartLine = {
        id: row.id,
        variantId: row.variant_id,
        quantity: row.quantity,
        priceCentsAtAdd: row.price_cents_at_add,
        currentPriceCents: row.current_price_cents,
        priceDeltaCents: row.current_price_cents - row.price_cents_at_add,
        lineTotalCents,
        availableStock: row.stock,
        issue,
        product: {
          id: row.product_id,
          slug: row.product_slug,
          title: row.product_title,
          imageKey: row.image_key,
        },
        variant: { name: row.variant_name, sku: row.variant_sku },
        addedAt: new Date(row.added_at).toISOString(),
      };

      if (issue) hasBlockers = true;
      if (line.priceDeltaCents !== 0 && !issue) hasPriceChanges = true;

      if (!issue) {
        subtotalCents += lineTotalCents;
        itemCount += row.quantity;
      }

      const group = groups.get(row.seller_id) ?? {
        seller: { id: row.seller_id, slug: row.seller_slug, storeName: row.store_name },
        lines: [],
        subtotalCents: 0,
        weightGrams: 0,
        shippingCents: null,
        freeOverCents: null,
        missingForFreeCents: null,
      };
      group.lines.push(line);
      if (!issue) {
        group.subtotalCents += lineTotalCents;
        group.weightGrams += (row.weight_grams ?? 0) * row.quantity;
      }
      groups.set(row.seller_id, group);
    }

    const resolved = [...groups.values()];
    await this.applyShipping(db, resolved);

    let shippingCents = 0;
    let hasUnconfiguredShipping = false;
    for (const group of resolved) {
      if (group.shippingCents === null) hasUnconfiguredShipping = true;
      else shippingCents += group.shippingCents;
    }

    return {
      id: cart.id,
      groups: resolved,
      itemCount,
      subtotalCents,
      shippingCents,
      totalCents: subtotalCents + shippingCents,
      hasPriceChanges,
      hasBlockers,
      hasUnconfiguredShipping,
      updatedAt: cart.updatedAt.toISOString(),
    };
  }

  private async applyShipping(db: Runner, groups: CartGroup[]): Promise<void> {
    const billable = groups.filter((group) => group.subtotalCents > 0);
    if (billable.length === 0) return;

    const rates = await db
      .select()
      .from(shippingRates)
      .where(
        and(
          inArray(shippingRates.sellerId, billable.map((group) => group.seller.id)),
          eq(shippingRates.zone, 'nacional'),
          isNull(shippingRates.deletedAt),
        ),
      );

    const bySeller = new Map(rates.map((rate) => [rate.sellerId, rate]));

    for (const group of billable) {
      const rate = bySeller.get(group.seller.id);
      if (!rate) continue;

      const kilos = Math.ceil(group.weightGrams / 1000);
      const reachesFree =
        rate.freeOverCents !== null && group.subtotalCents >= rate.freeOverCents;

      group.shippingCents = reachesFree ? 0 : rate.baseCents + kilos * rate.perKgCents;
      group.freeOverCents = rate.freeOverCents;
      group.missingForFreeCents =
        rate.freeOverCents === null
          ? null
          : Math.max(0, rate.freeOverCents - group.subtotalCents);
    }
  }

  async summary(db: DrizzleDB, userId: string): Promise<CartSummary> {
    const [cart] = await db.select().from(carts).where(eq(carts.userId, userId));
    if (!cart) return { itemCount: 0, subtotalCents: 0 };

    const rows = await this.lines(db, cart.id);
    let itemCount = 0;
    let subtotalCents = 0;
    for (const row of rows) {
      if (issueOf(row)) continue;
      itemCount += row.quantity;
      subtotalCents += row.price_cents_at_add * row.quantity;
    }
    return { itemCount, subtotalCents };
  }

  async addItem(
    db: DrizzleDB,
    userId: string,
    input: { variantId: string; quantity: number },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const cart = await this.ensureCart(tx, userId);

      const [variant] = await tx
        .select({
          id: variants.id,
          priceCents: variants.priceCents,
          stock: variants.stock,
          productStatus: products.status,
          productDeleted: products.deletedAt,
          sellerStatus: sellers.status,
        })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .innerJoin(sellers, eq(sellers.id, products.sellerId))
        .where(and(eq(variants.id, input.variantId), isNull(variants.deletedAt)));

      if (
        !variant ||
        variant.productDeleted ||
        variant.productStatus !== 'published' ||
        variant.sellerStatus !== 'active'
      ) {
        throw new NotFoundException('Ese producto ya no está disponible');
      }

      const [existing] = await tx
        .select()
        .from(cartItems)
        .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, input.variantId)));

      const wanted = (existing?.quantity ?? 0) + input.quantity;
      if (variant.stock < wanted) {
        throw new ConflictException(
          variant.stock === 0
            ? 'Ese producto se agotó'
            : `Solo quedan ${variant.stock} y ya tienes ${existing?.quantity ?? 0} en el carrito`,
        );
      }

      if (existing) {
        await tx
          .update(cartItems)
          .set({ quantity: wanted, updatedAt: new Date() })
          .where(eq(cartItems.id, existing.id));
      } else {
        await tx.insert(cartItems).values({
          cartId: cart.id,
          variantId: input.variantId,
          quantity: input.quantity,
          priceCentsAtAdd: variant.priceCents,
        });
      }

      await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cart.id));
    });
  }

  private async requireOwnLine(db: Runner, userId: string, itemId: string) {
    const [row] = await db
      .select({ id: cartItems.id, cartId: cartItems.cartId, variantId: cartItems.variantId })
      .from(cartItems)
      .innerJoin(carts, eq(carts.id, cartItems.cartId))
      .where(and(eq(cartItems.id, itemId), eq(carts.userId, userId)));

    if (!row) throw new NotFoundException('Ese artículo no está en tu carrito');
    return row;
  }

  async updateQuantity(
    db: DrizzleDB,
    userId: string,
    itemId: string,
    quantity: number,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const line = await this.requireOwnLine(tx, userId, itemId);

      const [variant] = await tx
        .select({ stock: variants.stock })
        .from(variants)
        .where(eq(variants.id, line.variantId));

      if (variant && variant.stock < quantity) {
        throw new ConflictException(
          variant.stock === 0 ? 'Ese producto se agotó' : `Solo quedan ${variant.stock}`,
        );
      }

      await tx
        .update(cartItems)
        .set({ quantity, updatedAt: new Date() })
        .where(eq(cartItems.id, itemId));
      await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, line.cartId));
    });
  }

  async removeItem(db: DrizzleDB, userId: string, itemId: string): Promise<void> {
    const line = await this.requireOwnLine(db, userId, itemId);
    await db.delete(cartItems).where(eq(cartItems.id, itemId));
    await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, line.cartId));
  }

  async clear(db: DrizzleDB, userId: string): Promise<void> {
    const [cart] = await db.select().from(carts).where(eq(carts.userId, userId));
    if (!cart) return;
    await db.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cart.id));
  }
}
