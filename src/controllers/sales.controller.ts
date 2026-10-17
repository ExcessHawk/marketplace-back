import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  ConflictException,
  Controller,
  Ctx,
  ForbiddenException,
  Get,
  Inject,
  InjectDB,
  NotFoundException,
  Param,
  Post,
  Query,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import {
  ListSalesSchema,
  type SellerEarnings,
  ShipSuborderSchema,
  type ListSalesDto,
  type SaleView,
  type ShipSuborderDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { orders, sellers, suborderItems, suborders, users } from '../db/schema';
import { PayoutService } from '../services/payout.service';

@Controller('/api')
export class SalesController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(PayoutService) private payouts: PayoutService,
  ) {}

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

  @Get('/seller/sales')
  @Roles(['seller', 'admin'])
  async list(@Query(ListSalesSchema) query: ListSalesDto, @Ctx() c: Context) {
    const store = await this.requireStore(c);

    const where = query.status
      ? and(eq(suborders.sellerId, store.id), eq(suborders.status, query.status))
      : eq(suborders.sellerId, store.id);
    const offset = (query.page - 1) * query.limit;

    const [rows, [counted]] = await Promise.all([
      this.db
        .select({
          id: suborders.id,
          subtotalCents: suborders.subtotalCents,
          shippingCents: suborders.shippingCents,
          commissionCents: suborders.commissionCents,
          payoutCents: suborders.payoutCents,
          status: suborders.status,
          trackingCarrier: suborders.trackingCarrier,
          trackingNumber: suborders.trackingNumber,
          shippedAt: suborders.shippedAt,
          deliveredAt: suborders.deliveredAt,
          createdAt: suborders.createdAt,
          orderId: orders.id,
          orderNumber: orders.number,
          orderStatus: orders.status,
          shippingSnapshot: orders.shippingSnapshot,
          buyerName: users.fullName,
          buyerPhone: users.phone,
        })
        .from(suborders)
        .innerJoin(orders, eq(orders.id, suborders.orderId))
        .innerJoin(users, eq(users.id, orders.buyerId))
        .where(where)
        .orderBy(desc(suborders.createdAt))
        .limit(query.limit)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::int` }).from(suborders).where(where),
    ]);

    const items: SaleView[] = []
    for (const row of rows) {
      const lines = await this.db
        .select()
        .from(suborderItems)
        .where(eq(suborderItems.suborderId, row.id))
        .orderBy(suborderItems.createdAt);

      items.push({
        id: row.id,
        seller: { id: store.id, slug: store.slug, storeName: store.storeName },
        items: lines.map((item) => ({
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
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        orderStatus: row.orderStatus,
        buyer: { fullName: row.buyerName, phone: row.buyerPhone },
        shippingSnapshot: row.shippingSnapshot,
        commissionCents: row.commissionCents,
        payoutCents: row.payoutCents,
        createdAt: row.createdAt.toISOString(),
      });
    }

    const total = counted?.total ?? 0;
    return {
      items,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  @Get('/seller/payouts')
  @Roles(['seller', 'admin'])
  async earnings(@Ctx() c: Context): Promise<SellerEarnings> {
    const store = await this.requireStore(c);
    return this.payouts.earnings(this.db, store.id);
  }

  @Post('/suborders/:id/ship')
  @Roles(['seller', 'admin'])
  async ship(
    @Param('id') id: string,
    @Body(ShipSuborderSchema) body: ShipSuborderDto,
    @Ctx() c: Context,
  ) {
    const store = await this.requireStore(c);

    const [row] = await this.db
      .select({ sellerId: suborders.sellerId, status: suborders.status })
      .from(suborders)
      .where(eq(suborders.id, id));

    if (!row || row.sellerId !== store.id) throw new NotFoundException('Esa venta no existe');
    if (row.status !== 'pending_shipment') {
      throw new ConflictException(
        row.status === 'pending_payment'
          ? 'Ese pedido todavía no está pagado'
          : 'Ese pedido ya salió de tu tienda',
      );
    }

    const now = new Date();
    await this.db
      .update(suborders)
      .set({
        status: 'shipped',
        trackingCarrier: body.carrier,
        trackingNumber: body.trackingNumber,
        shippedAt: now,
        updatedAt: now,
      })
      .where(eq(suborders.id, id));

    return { message: 'Marcado como enviado' };
  }
}
