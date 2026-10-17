import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  Controller,
  Get,
  Inject,
  InjectDB,
  NotFoundException,
  Param,
  Query,
  UseMiddleware,
} from 'veloce-ts';
import { SearchProductsSchema, type SearchProductsDto } from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { categories, sellers } from '../db/schema';
import { publicReadRateLimit } from '../middleware/rate-limit.middleware';
import { CatalogService } from '../services/catalog.service';

@Controller('/api')
export class CatalogController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(CatalogService) private catalog: CatalogService,
  ) {}

  @Get('/products')
  @UseMiddleware(publicReadRateLimit)
  async search(@Query(SearchProductsSchema) query: SearchProductsDto) {
    return this.catalog.search(this.db, query);
  }

  @Get('/products/:slug')
  @UseMiddleware(publicReadRateLimit)
  async detail(@Param('slug') slug: string) {
    return this.catalog.bySlug(this.db, slug);
  }

  @Get('/categories')
  @UseMiddleware(publicReadRateLimit)
  async listCategories() {
    const rows = await this.db
      .select({
        id: categories.id,
        parentId: categories.parentId,
        name: categories.name,
        slug: categories.slug,
      })
      .from(categories)
      .orderBy(asc(categories.position), asc(categories.name));

    return { items: rows };
  }

  @Get('/sellers/:slug')
  @UseMiddleware(publicReadRateLimit)
  async storePage(@Param('slug') slug: string) {
    const [store] = await this.db
      .select({
        id: sellers.id,
        slug: sellers.slug,
        storeName: sellers.storeName,
        description: sellers.description,
        logoKey: sellers.logoKey,
        bannerKey: sellers.bannerKey,
        ratingAvgRaw: sellers.ratingAvg,
        ratingCount: sellers.ratingCount,
        createdAt: sellers.createdAt,
      })
      .from(sellers)
      .where(and(eq(sellers.slug, slug), eq(sellers.status, 'active'), isNull(sellers.deletedAt)));

    if (!store) throw new NotFoundException('Esa tienda no existe');

    const { ratingAvgRaw, ...rest } = store;
    return { ...rest, ratingAvg: ratingAvgRaw === null ? null : ratingAvgRaw / 100 };
  }
}
