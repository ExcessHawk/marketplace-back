import { sql } from 'drizzle-orm';
import { NotFoundException } from 'veloce-ts';
import type {
  Paginated,
  ProductDetail,
  ProductListItem,
  SearchProductsDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';

interface ListRow extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  status: ProductListItem['status'];
  price_from_cents: string | number;
  image_key: string | null;
  rating_avg: number | null;
  rating_count: number;
  seller_id: string;
  seller_slug: string;
  store_name: string;
  total: string | number;
}

function toListItem(row: ListRow): ProductListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    priceFromCents: Number(row.price_from_cents),
    imageKey: row.image_key,
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg) / 100,
    ratingCount: Number(row.rating_count ?? 0),
    seller: { id: row.seller_id, slug: row.seller_slug, storeName: row.store_name },
  };
}

export class CatalogService {
  async search(db: DrizzleDB, params: SearchProductsDto): Promise<Paginated<ProductListItem>> {
    const { page, limit, q, category, seller, minPrice, maxPrice, sort } = params;
    const offset = (page - 1) * limit;

    const hasQuery = Boolean(q && q.trim());
    const tsQuery = sql`websearch_to_tsquery('spanish', f_unaccent(${q ?? ''}))`;

    const effectiveSort = sort === 'relevance' && !hasQuery ? 'newest' : sort;

    const orderBy = {
      relevance: sql`ts_rank(p.search_vector, ${tsQuery}) DESC, p.published_at DESC`,
      newest: sql`p.published_at DESC NULLS LAST, p.id DESC`,
      price_asc: sql`price_from_cents ASC, p.id DESC`,
      price_desc: sql`price_from_cents DESC, p.id DESC`,
    }[effectiveSort];

    const rows = await db.execute<ListRow>(sql`
      WITH matched AS (
        SELECT
          p.id,
          p.slug,
          p.title,
          p.status,
          p.published_at,
          p.search_vector,
          p.rating_avg,
          p.rating_count,
          s.id   AS seller_id,
          s.slug AS seller_slug,
          s.store_name,
          MIN(v.price_cents) AS price_from_cents,
          (ARRAY_REMOVE(ARRAY_AGG(v.image_keys ->> 0 ORDER BY v.position, v.id), NULL))[1] AS image_key
        FROM products p
        JOIN sellers  s ON s.id = p.seller_id AND s.deleted_at IS NULL AND s.status = 'active'
        JOIN variants v ON v.product_id = p.id AND v.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
          AND p.status = 'published'
          ${hasQuery ? sql`AND p.search_vector @@ ${tsQuery}` : sql``}
          ${category ? sql`AND p.category_id = (SELECT id FROM categories WHERE slug = ${category})` : sql``}
          ${seller ? sql`AND s.slug = ${seller}` : sql``}
        GROUP BY p.id, s.id
        ${minPrice !== undefined ? sql`HAVING MIN(v.price_cents) >= ${minPrice}` : sql``}
        ${maxPrice !== undefined ? sql`${minPrice !== undefined ? sql`AND` : sql`HAVING`} MIN(v.price_cents) <= ${maxPrice}` : sql``}
      )
      SELECT p.*, COUNT(*) OVER () AS total
      FROM matched p
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `);

    const items = rows.rows.map(toListItem);
    const total = rows.rows.length > 0 ? Number(rows.rows[0]!.total) : 0;

    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async bySlug(db: DrizzleDB, slug: string): Promise<ProductDetail> {
    const result = await db.execute<Record<string, unknown>>(sql`
      SELECT
        p.id, p.slug, p.title, p.description, p.status, p.category_id, p.published_at,
        p.rating_avg, p.rating_count,
        s.id AS seller_id, s.slug AS seller_slug, s.store_name,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', v.id,
              'name', v.name,
              'sku', v.sku,
              'priceCents', v.price_cents,
              'compareAtCents', v.compare_at_cents,
              'stock', v.stock,
              'imageKeys', v.image_keys
            ) ORDER BY v.position, v.id
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'
        ) AS variants
      FROM products p
      JOIN sellers  s ON s.id = p.seller_id AND s.deleted_at IS NULL
      LEFT JOIN variants v ON v.product_id = p.id AND v.deleted_at IS NULL
      WHERE p.slug = ${slug}
        AND p.deleted_at IS NULL
        AND p.status = 'published'
      GROUP BY p.id, s.id
    `);

    const row = result.rows[0];
    if (!row) throw new NotFoundException('Ese producto no existe');

    const variants = row.variants as ProductDetail['variants'];

    return {
      id: row.id as string,
      slug: row.slug as string,
      title: row.title as string,
      status: row.status as ProductDetail['status'],
      description: (row.description as string | null) ?? null,
      categoryId: (row.category_id as string | null) ?? null,
      publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
      priceFromCents: variants.length > 0 ? Math.min(...variants.map((v) => v.priceCents)) : 0,
      imageKey: variants.find((v) => v.imageKeys.length > 0)?.imageKeys[0] ?? null,
      ratingAvg: row.rating_avg === null || row.rating_avg === undefined ? null : Number(row.rating_avg) / 100,
      ratingCount: Number(row.rating_count ?? 0),
      seller: {
        id: row.seller_id as string,
        slug: row.seller_slug as string,
        storeName: row.store_name as string,
      },
      variants,
    };
  }
}
