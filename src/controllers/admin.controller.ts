import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Ctx,
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
  ApproveSellerSchema,
  ListAuditSchema,
  ListSellersSchema,
  SuspendSellerSchema,
  type AdminSellerRow,
  type AdminStats,
  type ApproveSellerDto,
  type ListAuditDto,
  type ListSellersDto,
  type SuspendSellerDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { products, sellers, users } from '../db/schema';
import { AuditService } from '../services/audit.service';
import { PayoutService } from '../services/payout.service';
import { ListPayoutsSchema, type ListPayoutsDto } from '@marketplace/contracts';

const ADMIN_ONLY = ['admin'];

@Controller('/api/admin')
export class AdminController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(AuditService) private audit: AuditService,
    @Inject(PayoutService) private payouts: PayoutService,
  ) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  private async requireAdmin(c: Context): Promise<string> {
    const userId = this.userId(c);
    const [user] = await this.db
      .select({ isPlatformAdmin: users.isPlatformAdmin, status: users.status })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));

    if (!user?.isPlatformAdmin || user.status !== 'active') {
      throw new ForbiddenException('Esta cuenta no es administrador de plataforma');
    }
    return userId;
  }

  private async sellerRow(sellerId: string): Promise<AdminSellerRow> {
    const [row] = await this.db
      .select({
        id: sellers.id,
        slug: sellers.slug,
        storeName: sellers.storeName,
        description: sellers.description,
        status: sellers.status,
        statusReason: sellers.statusReason,
        commissionBps: sellers.commissionBps,
        createdAt: sellers.createdAt,
        updatedAt: sellers.updatedAt,
        ownerId: users.id,
        ownerEmail: users.email,
        ownerName: users.fullName,
        ownerPhone: users.phone,
        ownerIsAdmin: users.isPlatformAdmin,
        productCount: sql<number>`(
          SELECT count(*)::int FROM ${products}
           WHERE ${products.sellerId} = ${sellers.id} AND ${products.deletedAt} IS NULL
        )`,
        publishedCount: sql<number>`(
          SELECT count(*)::int FROM ${products}
           WHERE ${products.sellerId} = ${sellers.id}
             AND ${products.deletedAt} IS NULL
             AND ${products.status} = 'published'
        )`,
      })
      .from(sellers)
      .innerJoin(users, eq(users.id, sellers.userId))
      .where(and(eq(sellers.id, sellerId), isNull(sellers.deletedAt)));

    if (!row) throw new NotFoundException('Esa tienda no existe');

    return {
      id: row.id,
      slug: row.slug,
      storeName: row.storeName,
      description: row.description,
      status: row.status,
      statusReason: row.statusReason,
      commissionBps: row.commissionBps,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      owner: {
        id: row.ownerId,
        email: row.ownerEmail,
        fullName: row.ownerName,
        phone: row.ownerPhone,
        isPlatformAdmin: row.ownerIsAdmin,
      },
      productCount: Number(row.productCount),
      publishedCount: Number(row.publishedCount),
    };
  }

  @Get('/sellers')
  @Roles(ADMIN_ONLY)
  async listSellers(@Query(ListSellersSchema) query: ListSellersDto, @Ctx() c: Context) {
    await this.requireAdmin(c);
    const filters = [isNull(sellers.deletedAt)];
    if (query.status) filters.push(eq(sellers.status, query.status));
    if (query.q) {
      const pattern = `%${query.q}%`;
      filters.push(
        or(
          ilike(sellers.storeName, pattern),
          ilike(sellers.slug, pattern),
          ilike(users.email, pattern),
        )!,
      );
    }
    const where = and(...filters);
    const offset = (query.page - 1) * query.limit;

    const [rows, [counted]] = await Promise.all([
      this.db
        .select({ id: sellers.id })
        .from(sellers)
        .innerJoin(users, eq(users.id, sellers.userId))
        .where(where)
        .orderBy(sellers.createdAt)
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(sellers)
        .innerJoin(users, eq(users.id, sellers.userId))
        .where(where),
    ]);

    const items = await Promise.all(rows.map((row) => this.sellerRow(row.id)));
    const total = counted?.total ?? 0;

    return {
      items,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  @Get('/sellers/:id')
  @Roles(ADMIN_ONLY)
  async sellerDetail(@Param('id') id: string, @Ctx() c: Context) {
    await this.requireAdmin(c);
    return this.sellerRow(id);
  }

  @Post('/sellers/:id/approve')
  @Roles(ADMIN_ONLY)
  async approveSeller(
    @Param('id') id: string,
    @Body(ApproveSellerSchema) body: ApproveSellerDto,
    @Ctx() c: Context,
  ) {
    const adminId = await this.requireAdmin(c);
    const before = await this.sellerRow(id);

    if (before.status === 'active') {
      throw new ConflictException('Esa tienda ya está activa');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(sellers)
        .set({ status: 'active', statusReason: null, updatedAt: new Date() })
        .where(eq(sellers.id, id));

      await this.audit.record(tx, {
        userId: adminId,
        action: 'seller.approved',
        tableName: 'sellers',
        recordId: id,
        oldValues: { status: before.status, statusReason: before.statusReason },
        newValues: { status: 'active', note: body.note ?? null, selfApproved: before.owner.id === adminId },
      });
    });

    return this.sellerRow(id);
  }

  @Post('/sellers/:id/suspend')
  @Roles(ADMIN_ONLY)
  async suspendSeller(
    @Param('id') id: string,
    @Body(SuspendSellerSchema) body: SuspendSellerDto,
    @Ctx() c: Context,
  ) {
    const adminId = await this.requireAdmin(c);
    const before = await this.sellerRow(id);

    if (before.status === 'suspended') {
      throw new ConflictException('Esa tienda ya está suspendida');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(sellers)
        .set({ status: 'suspended', statusReason: body.reason, updatedAt: new Date() })
        .where(eq(sellers.id, id));

      await this.audit.record(tx, {
        userId: adminId,
        action: 'seller.suspended',
        tableName: 'sellers',
        recordId: id,
        oldValues: { status: before.status },
        newValues: { status: 'suspended', reason: body.reason },
      });
    });

    return this.sellerRow(id);
  }

  @Get('/stats')
  @Roles(ADMIN_ONLY)
  async stats(@Ctx() c: Context): Promise<AdminStats> {
    await this.requireAdmin(c);
    const [sellerCounts] = await this.db
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${sellers.status} = 'pending')::int`,
        active: sql<number>`count(*) FILTER (WHERE ${sellers.status} = 'active')::int`,
        suspended: sql<number>`count(*) FILTER (WHERE ${sellers.status} = 'suspended')::int`,
      })
      .from(sellers)
      .where(isNull(sellers.deletedAt));

    const [productCounts] = await this.db
      .select({
        draft: sql<number>`count(*) FILTER (WHERE ${products.status} = 'draft')::int`,
        published: sql<number>`count(*) FILTER (WHERE ${products.status} = 'published')::int`,
        archived: sql<number>`count(*) FILTER (WHERE ${products.status} = 'archived')::int`,
      })
      .from(products)
      .where(isNull(products.deletedAt));

    const [userCount] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(users)
      .where(isNull(users.deletedAt));

    return {
      sellers: {
        pending: Number(sellerCounts?.pending ?? 0),
        active: Number(sellerCounts?.active ?? 0),
        suspended: Number(sellerCounts?.suspended ?? 0),
      },
      products: {
        draft: Number(productCounts?.draft ?? 0),
        published: Number(productCounts?.published ?? 0),
        archived: Number(productCounts?.archived ?? 0),
      },
      users: Number(userCount?.total ?? 0),
    };
  }

  @Get('/payouts')
  @Roles(ADMIN_ONLY)
  async listPayouts(@Query(ListPayoutsSchema) query: ListPayoutsDto, @Ctx() c: Context) {
    await this.requireAdmin(c);
    return this.payouts.list(this.db, query);
  }

  @Post('/payouts/run')
  @Roles(ADMIN_ONLY)
  async runPayouts(@Ctx() c: Context) {
    const adminId = await this.requireAdmin(c);
    return this.payouts.run(this.db, adminId);
  }

  @Get('/audit')
  @Roles(ADMIN_ONLY)
  async listAudit(@Query(ListAuditSchema) query: ListAuditDto, @Ctx() c: Context) {
    await this.requireAdmin(c);
    const { items, total } = await this.audit.list(this.db, {
      page: query.page,
      limit: query.limit,
      recordId: query.recordId,
    });

    return {
      items,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  @Get('/admins')
  @Roles(ADMIN_ONLY)
  async listAdmins(@Ctx() c: Context) {
    await this.requireAdmin(c);
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.isPlatformAdmin, true), isNull(users.deletedAt)))
      .orderBy(desc(users.createdAt));

    return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  }
}
