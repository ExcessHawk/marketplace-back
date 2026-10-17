import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Delete,
  Get,
  Inject,
  InjectDB,
  Param,
  Patch,
  Post,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import {
  AddCartItemSchema,
  UpdateCartItemSchema,
  type AddCartItemDto,
  type UpdateCartItemDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { CartService } from '../services/cart.service';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

@Controller('/api/cart')
export class CartController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(CartService) private cart: CartService,
  ) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  @Get('/')
  @Roles(ANY_ROLE)
  async view(@Ctx() c: Context) {
    return this.cart.view(this.db, this.userId(c));
  }

  @Get('/summary')
  @Roles(ANY_ROLE)
  async summary(@Ctx() c: Context) {
    return this.cart.summary(this.db, this.userId(c));
  }

  @Post('/items')
  @Roles(ANY_ROLE)
  async addItem(@Body(AddCartItemSchema) body: AddCartItemDto, @Ctx() c: Context) {
    const userId = this.userId(c);
    await this.cart.addItem(this.db, userId, body);
    c.status(201);
    return this.cart.view(this.db, userId);
  }

  @Patch('/items/:id')
  @Roles(ANY_ROLE)
  async updateItem(
    @Param('id') id: string,
    @Body(UpdateCartItemSchema) body: UpdateCartItemDto,
    @Ctx() c: Context,
  ) {
    const userId = this.userId(c);
    await this.cart.updateQuantity(this.db, userId, id, body.quantity);
    return this.cart.view(this.db, userId);
  }

  @Delete('/items/:id')
  @Roles(ANY_ROLE)
  async removeItem(@Param('id') id: string, @Ctx() c: Context) {
    const userId = this.userId(c);
    await this.cart.removeItem(this.db, userId, id);
    return this.cart.view(this.db, userId);
  }

  @Delete('/')
  @Roles(ANY_ROLE)
  async clear(@Ctx() c: Context) {
    const userId = this.userId(c);
    await this.cart.clear(this.db, userId);
    return this.cart.view(this.db, userId);
  }
}
