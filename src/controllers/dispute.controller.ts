import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  ForbiddenException,
  Get,
  Inject,
  InjectDB,
  Param,
  Post,
  Query,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import {
  DisputeMessageSchema,
  ListDisputesSchema,
  OpenDisputeSchema,
  ResolveDisputeSchema,
  type DisputeMessageDto,
  type ListDisputesDto,
  type OpenDisputeDto,
  type ResolveDisputeDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { sellers, users } from '../db/schema';
import { DisputeService } from '../services/dispute.service';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

@Controller('/api')
export class DisputeController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(DisputeService) private disputes: DisputeService,
  ) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const [user] = await this.db
      .select({ isPlatformAdmin: users.isPlatformAdmin, status: users.status })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    return Boolean(user?.isPlatformAdmin) && user?.status === 'active';
  }

  private async requireAdmin(c: Context): Promise<string> {
    const userId = this.userId(c);
    if (!(await this.isAdmin(userId))) {
      throw new ForbiddenException('Esta cuenta no es administrador de plataforma');
    }
    return userId;
  }

  @Post('/suborders/:id/dispute')
  @Roles(ANY_ROLE)
  async open(
    @Param('id') id: string,
    @Body(OpenDisputeSchema) body: OpenDisputeDto,
    @Ctx() c: Context,
  ) {
    const result = await this.disputes.open(this.db, this.userId(c), id, body);
    c.status(201);
    return result;
  }

  @Get('/suborders/:id/dispute')
  @Roles(ANY_ROLE)
  async forSuborder(@Param('id') id: string, @Ctx() c: Context) {
    const dispute = await this.disputes.forSuborder(this.db, this.userId(c), id);
    return { dispute };
  }

  @Get('/disputes/:id')
  @Roles(ANY_ROLE)
  async detail(@Param('id') id: string, @Ctx() c: Context) {
    const userId = this.userId(c);
    return this.disputes.detail(this.db, userId, id, await this.isAdmin(userId));
  }

  @Post('/disputes/:id/messages')
  @Roles(ANY_ROLE)
  async addMessage(
    @Param('id') id: string,
    @Body(DisputeMessageSchema) body: DisputeMessageDto,
    @Ctx() c: Context,
  ) {
    const userId = this.userId(c);
    return this.disputes.addMessage(this.db, userId, id, body.body, await this.isAdmin(userId));
  }

  @Post('/disputes/:id/withdraw')
  @Roles(ANY_ROLE)
  async withdraw(@Param('id') id: string, @Ctx() c: Context) {
    return this.disputes.withdraw(this.db, this.userId(c), id);
  }

  @Get('/seller/disputes')
  @Roles(['seller', 'admin'])
  async sellerList(@Query(ListDisputesSchema) query: ListDisputesDto, @Ctx() c: Context) {
    const [store] = await this.db
      .select()
      .from(sellers)
      .where(and(eq(sellers.userId, this.userId(c)), isNull(sellers.deletedAt)));

    if (!store) throw new ForbiddenException('Esta cuenta no tiene tienda');
    if (store.status !== 'active') throw new ForbiddenException('Tu tienda no está activa');

    return this.disputes.list(this.db, { ...query, sellerId: store.id });
  }

  @Get('/admin/disputes')
  @Roles(['admin'])
  async adminList(@Query(ListDisputesSchema) query: ListDisputesDto, @Ctx() c: Context) {
    await this.requireAdmin(c);
    return this.disputes.list(this.db, query);
  }

  @Post('/admin/disputes/:id/resolve')
  @Roles(['admin'])
  async resolve(
    @Param('id') id: string,
    @Body(ResolveDisputeSchema) body: ResolveDisputeDto,
    @Ctx() c: Context,
  ) {
    const adminId = await this.requireAdmin(c);
    return this.disputes.resolve(this.db, adminId, id, body);
  }
}
