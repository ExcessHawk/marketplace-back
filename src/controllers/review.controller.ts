import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  InjectDB,
  Param,
  Patch,
  Post,
  Query,
  Roles,
  UnauthorizedException,
  UseMiddleware,
  getCurrentUser,
} from 'veloce-ts';
import {
  CreateReviewSchema,
  ListReviewsSchema,
  ReplyReviewSchema,
  UpdateReviewSchema,
  type CreateReviewDto,
  type ListReviewsDto,
  type ReplyReviewDto,
  type UpdateReviewDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { sellers } from '../db/schema';
import { publicReadRateLimit } from '../middleware/rate-limit.middleware';
import { ReviewService } from '../services/review.service';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

@Controller('/api')
export class ReviewController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(ReviewService) private reviews: ReviewService,
  ) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  private optionalUserId(c: Context): string {
    return getCurrentUser(c)?.sub ?? '';
  }

  @Get('/products/:slug/reviews')
  @UseMiddleware(publicReadRateLimit)
  async forProduct(
    @Param('slug') slug: string,
    @Query(ListReviewsSchema) query: ListReviewsDto,
    @Ctx() c: Context,
  ) {
    return this.reviews.listForProduct(this.db, this.optionalUserId(c), slug, query);
  }

  @Get('/products/:slug/reviews/summary')
  @UseMiddleware(publicReadRateLimit)
  async summary(@Param('slug') slug: string) {
    return this.reviews.summaryForProduct(this.db, slug);
  }

  @Get('/sellers/:slug/reviews')
  @UseMiddleware(publicReadRateLimit)
  async forSeller(
    @Param('slug') slug: string,
    @Query(ListReviewsSchema) query: ListReviewsDto,
    @Ctx() c: Context,
  ) {
    const [store] = await this.db
      .select({ id: sellers.id })
      .from(sellers)
      .where(and(eq(sellers.slug, slug), eq(sellers.status, 'active'), isNull(sellers.deletedAt)));
    if (!store) return { items: [], page: query.page, limit: query.limit, total: 0, totalPages: 1 };

    return this.reviews.listForSeller(this.db, this.optionalUserId(c), store.id, query);
  }

  @Get('/suborders/:id/reviews')
  @Roles(ANY_ROLE)
  async reviewable(@Param('id') id: string, @Ctx() c: Context) {
    return this.reviews.reviewable(this.db, this.userId(c), id);
  }

  @Post('/suborders/:id/reviews')
  @Roles(ANY_ROLE)
  async create(
    @Param('id') id: string,
    @Body(CreateReviewSchema) body: CreateReviewDto,
    @Ctx() c: Context,
  ) {
    const created = await this.reviews.create(this.db, this.userId(c), id, body);
    c.status(201);
    return created;
  }

  @Patch('/reviews/:id')
  @Roles(ANY_ROLE)
  async update(
    @Param('id') id: string,
    @Body(UpdateReviewSchema) body: UpdateReviewDto,
    @Ctx() c: Context,
  ) {
    return this.reviews.update(this.db, this.userId(c), id, body);
  }

  @Delete('/reviews/:id')
  @Roles(ANY_ROLE)
  async remove(@Param('id') id: string, @Ctx() c: Context) {
    await this.reviews.remove(this.db, this.userId(c), id);
    return { message: 'Opinión eliminada' };
  }

  @Post('/reviews/:id/reply')
  @Roles(['seller', 'admin'])
  async reply(
    @Param('id') id: string,
    @Body(ReplyReviewSchema) body: ReplyReviewDto,
    @Ctx() c: Context,
  ) {
    const [store] = await this.db
      .select()
      .from(sellers)
      .where(and(eq(sellers.userId, this.userId(c)), isNull(sellers.deletedAt)));

    if (!store) throw new ForbiddenException('Esta cuenta no tiene tienda');
    if (store.status !== 'active') throw new ForbiddenException('Tu tienda no está activa');

    return this.reviews.reply(this.db, store.id, id, body.reply);
  }
}
