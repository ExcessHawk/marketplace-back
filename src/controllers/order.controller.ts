import { and, eq } from 'drizzle-orm';
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
  CheckoutSchema,
  ListOrdersSchema,
  type CheckoutDto,
  type ListOrdersDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { orders, suborders } from '../db/schema';
import { CheckoutService } from '../services/checkout.service';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

@Controller('/api')
export class OrderController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(CheckoutService) private checkout: CheckoutService,
  ) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  @Post('/checkout')
  @Roles(ANY_ROLE)
  async placeOrder(@Body(CheckoutSchema) body: CheckoutDto, @Ctx() c: Context) {
    const result = await this.checkout.checkout(this.db, this.userId(c), body.addressId);
    c.status(201);
    return result;
  }

  @Get('/orders')
  @Roles(ANY_ROLE)
  async list(@Query(ListOrdersSchema) query: ListOrdersDto, @Ctx() c: Context) {
    return this.checkout.list(this.db, this.userId(c), query);
  }

  @Get('/orders/:id')
  @Roles(ANY_ROLE)
  async detail(@Param('id') id: string, @Ctx() c: Context) {
    return this.checkout.order(this.db, this.userId(c), id);
  }

  @Post('/suborders/:id/confirm')
  @Roles(ANY_ROLE)
  async confirmDelivery(@Param('id') id: string, @Ctx() c: Context) {
    const userId = this.userId(c);

    const [row] = await this.db
      .select({ status: suborders.status, buyerId: orders.buyerId })
      .from(suborders)
      .innerJoin(orders, eq(orders.id, suborders.orderId))
      .where(eq(suborders.id, id));

    if (!row || row.buyerId !== userId) throw new NotFoundException('Ese pedido no existe');
    if (row.status !== 'shipped') {
      throw new ConflictException('Solo puedes confirmar lo que ya va en camino');
    }

    await this.checkout.transition(this.db, id, 'delivered', { deliveredAt: new Date() });
    return { message: 'Entrega confirmada' };
  }
}
