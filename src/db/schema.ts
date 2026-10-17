import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const userStatusEnum = pgEnum('user_status', ['active', 'suspended']);
export const sellerStatusEnum = pgEnum('seller_status', ['pending', 'active', 'suspended']);
export const productStatusEnum = pgEnum('product_status', ['draft', 'published', 'archived']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    avatarUrl: text('avatar_url'),
    phone: text('phone'),
    isPlatformAdmin: boolean('is_platform_admin').default(false).notNull(),
    isDemo: boolean('is_demo').default(false).notNull(),
    status: userStatusEnum('status').default('active').notNull(),
    emailVerifiedAt: timestamp('email_verified_at'),
    lastLoginAt: timestamp('last_login_at'),
    loginCount: integer('login_count').default(0).notNull(),
    failedLoginCount: integer('failed_login_count').default(0).notNull(),
    lockedUntil: timestamp('locked_until'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    emailUniqueActive: uniqueIndex('users_email_unique_active')
      .on(t.email)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    byUser: index('refresh_tokens_user_idx').on(t.userId),
    byHash: uniqueIndex('refresh_tokens_hash_unique').on(t.tokenHash),
  }),
);

export const revokedAccessTokens = pgTable('revoked_access_tokens', {
  jti: text('jti').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at').defaultNow().notNull(),
});

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    tableName: text('table_name'),
    recordId: text('record_id'),
    oldValues: jsonb('old_values'),
    newValues: jsonb('new_values'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    byRecord: index('audit_logs_record_idx').on(t.tableName, t.recordId),
    byCreatedAt: index('audit_logs_created_at_idx').on(t.createdAt),
  }),
);

export const sellers = pgTable(
  'sellers',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storeName: text('store_name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    logoKey: text('logo_key'),
    bannerKey: text('banner_key'),
    stripeAccountId: text('stripe_account_id'),
    onboardingComplete: boolean('onboarding_complete').default(false).notNull(),
    commissionBps: integer('commission_bps').default(1000).notNull(),
    status: sellerStatusEnum('status').default('pending').notNull(),
    statusReason: text('status_reason'),
    ratingAvg: integer('rating_avg'),
    ratingCount: integer('rating_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    slugUniqueActive: uniqueIndex('sellers_slug_unique_active')
      .on(t.slug)
      .where(sql`deleted_at IS NULL`),
    userUniqueActive: uniqueIndex('sellers_user_unique_active')
      .on(t.userId)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    position: integer('position').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('categories_slug_unique').on(t.slug),
    byParent: index('categories_parent_idx').on(t.parentId),
  }),
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: productStatusEnum('status').default('draft').notNull(),
    ratingAvg: integer('rating_avg'),
    ratingCount: integer('rating_count').default(0).notNull(),
    publishedAt: timestamp('published_at'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('spanish', f_unaccent(coalesce(title, '') || ' ' || coalesce(description, '')))`,
    ),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    slugUniqueActive: uniqueIndex('products_slug_unique_active')
      .on(t.slug)
      .where(sql`deleted_at IS NULL`),
    bySeller: index('products_seller_idx').on(t.sellerId),
    byCategory: index('products_category_idx').on(t.categoryId),
    search: index('products_search_idx').using('gin', t.searchVector),
    published: index('products_published_idx')
      .on(t.publishedAt)
      .where(sql`status = 'published' AND deleted_at IS NULL`),
  }),
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku'),
    name: text('name').notNull(),
    priceCents: integer('price_cents').notNull(),
    compareAtCents: integer('compare_at_cents'),
    stock: integer('stock').default(0).notNull(),
    weightGrams: integer('weight_grams'),
    imageKeys: jsonb('image_keys').$type<string[]>().default([]).notNull(),
    position: integer('position').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    byProduct: index('variants_product_idx').on(t.productId),
    skuUniqueActive: uniqueIndex('variants_sku_unique_active')
      .on(t.productId, t.sku)
      .where(sql`deleted_at IS NULL AND sku IS NOT NULL`),
  }),
);

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userUnique: uniqueIndex('carts_user_unique').on(t.userId),
  }),
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
    priceCentsAtAdd: integer('price_cents_at_add').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    byCart: index('cart_items_cart_idx').on(t.cartId),
    variantUnique: uniqueIndex('cart_items_variant_unique').on(t.cartId, t.variantId),
  }),
);

export const shippingZoneEnum = pgEnum('shipping_zone', ['nacional', 'local']);

export const shippingRates = pgTable(
  'shipping_rates',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    zone: shippingZoneEnum('zone').notNull(),
    baseCents: integer('base_cents').notNull(),
    perKgCents: integer('per_kg_cents').default(0).notNull(),
    freeOverCents: integer('free_over_cents'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    bySeller: index('shipping_rates_seller_idx').on(t.sellerId),
    zoneUniqueActive: uniqueIndex('shipping_rates_zone_unique_active')
      .on(t.sellerId, t.zone)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    recipient: text('recipient').notNull(),
    phone: text('phone').notNull(),
    street: text('street').notNull(),
    interior: text('interior'),
    neighborhood: text('neighborhood').notNull(),
    city: text('city').notNull(),
    state: text('state').notNull(),
    postalCode: text('postal_code').notNull(),
    notes: text('notes'),
    isDefault: boolean('is_default').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    byUser: index('addresses_user_idx').on(t.userId),
    oneDefault: uniqueIndex('addresses_one_default')
      .on(t.userId)
      .where(sql`is_default AND deleted_at IS NULL`),
  }),
);

export const orderStatusEnum = pgEnum('order_status', [
  'pending_payment',
  'paid',
  'cancelled',
  'refunded',
]);

export const suborderStatusEnum = pgEnum('suborder_status', [
  'pending_payment',
  'pending_shipment',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
]);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    number: text('number').notNull(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addressId: uuid('address_id').references(() => addresses.id, { onDelete: 'set null' }),
    shippingSnapshot: jsonb('shipping_snapshot').$type<Record<string, string>>().notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    shippingCents: integer('shipping_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    platformFeeCents: integer('platform_fee_cents').notNull(),
    status: orderStatusEnum('status').default('pending_payment').notNull(),
    paymentIntentId: text('payment_intent_id'),
    paidAt: timestamp('paid_at'),
    cancelledAt: timestamp('cancelled_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    byBuyer: index('orders_buyer_idx').on(t.buyerId, t.createdAt),
    numberUnique: uniqueIndex('orders_number_unique').on(t.number),
    intentUnique: uniqueIndex('orders_payment_intent_unique')
      .on(t.paymentIntentId)
      .where(sql`payment_intent_id IS NOT NULL`),
    oneOpenPerBuyer: uniqueIndex('orders_one_pending_per_buyer')
      .on(t.buyerId)
      .where(sql`status = 'pending_payment'`),
  }),
);

export const suborders = pgTable(
  'suborders',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'restrict' }),
    subtotalCents: integer('subtotal_cents').notNull(),
    shippingCents: integer('shipping_cents').notNull(),
    commissionBps: integer('commission_bps').notNull(),
    commissionCents: integer('commission_cents').notNull(),
    payoutCents: integer('payout_cents').notNull(),
    status: suborderStatusEnum('status').default('pending_payment').notNull(),
    trackingCarrier: text('tracking_carrier'),
    trackingNumber: text('tracking_number'),
    shippedAt: timestamp('shipped_at'),
    deliveredAt: timestamp('delivered_at'),
    cancelledAt: timestamp('cancelled_at'),
    payoutId: uuid('payout_id'),
    transferId: text('transfer_id'),
    transferredAt: timestamp('transferred_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index('suborders_order_idx').on(t.orderId),
    bySeller: index('suborders_seller_idx').on(t.sellerId, t.createdAt),
  }),
);

export const suborderItems = pgTable(
  'suborder_items',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    suborderId: uuid('suborder_id')
      .notNull()
      .references(() => suborders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    productTitle: text('product_title').notNull(),
    productSlug: text('product_slug').notNull(),
    variantName: text('variant_name').notNull(),
    sku: text('sku'),
    imageKey: text('image_key'),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    lineTotalCents: integer('line_total_cents').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    bySuborder: index('suborder_items_suborder_idx').on(t.suborderId),
  }),
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload'),
    processedAt: timestamp('processed_at').defaultNow().notNull(),
  },
  (t) => ({
    eventUnique: uniqueIndex('payment_events_event_unique').on(t.eventId),
  }),
);

export const payoutStatusEnum = pgEnum('payout_status', ['pending', 'paid', 'failed']);

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    commissionCents: integer('commission_cents').notNull(),
    suborderCount: integer('suborder_count').notNull(),
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    status: payoutStatusEnum('status').default('pending').notNull(),
    transferId: text('transfer_id'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    paidAt: timestamp('paid_at'),
  },
  (t) => ({
    bySeller: index('payouts_seller_idx').on(t.sellerId, t.createdAt),
    transferUnique: uniqueIndex('payouts_transfer_unique')
      .on(t.transferId)
      .where(sql`transfer_id IS NOT NULL`),
  }),
);

export const disputeStatusEnum = pgEnum('dispute_status', [
  'open',
  'resolved_buyer',
  'resolved_seller',
  'withdrawn',
]);

export const disputeReasonEnum = pgEnum('dispute_reason', [
  'not_received',
  'damaged',
  'not_as_described',
  'wrong_item',
  'other',
]);

export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    suborderId: uuid('suborder_id')
      .notNull()
      .references(() => suborders.id, { onDelete: 'cascade' }),
    openedBy: uuid('opened_by').references(() => users.id, { onDelete: 'set null' }),
    reason: disputeReasonEnum('reason').notNull(),
    description: text('description').notNull(),
    status: disputeStatusEnum('status').default('open').notNull(),
    resolution: text('resolution'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    bySuborder: index('disputes_suborder_idx').on(t.suborderId),
    byStatus: index('disputes_status_idx').on(t.status, t.createdAt),
    oneOpenPerSuborder: uniqueIndex('disputes_one_open_per_suborder')
      .on(t.suborderId)
      .where(sql`status = 'open'`),
  }),
);

export const disputeMessages = pgTable(
  'dispute_messages',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    senderRole: text('sender_role').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    byDispute: index('dispute_messages_dispute_idx').on(t.disputeId, t.createdAt),
  }),
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    suborderId: uuid('suborder_id')
      .notNull()
      .references(() => suborders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id').references(() => users.id, { onDelete: 'set null' }),
    rating: integer('rating').notNull(),
    body: text('body'),
    sellerReply: text('seller_reply'),
    repliedAt: timestamp('replied_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    byProduct: index('reviews_product_idx').on(t.productId, t.createdAt),
    bySeller: index('reviews_seller_idx').on(t.sellerId),
    onePerSuborderProduct: uniqueIndex('reviews_suborder_product_unique').on(
      t.suborderId,
      t.productId,
    ),
    ratingRange: check('reviews_rating_range', sql`rating BETWEEN 1 AND 5`),
  }),
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    suborderId: uuid('suborder_id')
      .notNull()
      .references(() => suborders.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    lastMessageAt: timestamp('last_message_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    suborderUnique: uniqueIndex('conversations_suborder_unique').on(t.suborderId),
    byBuyer: index('conversations_buyer_idx').on(t.buyerId, t.lastMessageAt),
    bySeller: index('conversations_seller_idx').on(t.sellerId, t.lastMessageAt),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').default(sql`uuid_generate_v4()`).primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    senderRole: text('sender_role').notNull(),
    body: text('body').notNull(),
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    byConversation: index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    unreadByConversation: index('messages_unread_idx')
      .on(t.conversationId, t.senderRole)
      .where(sql`read_at IS NULL`),
  }),
);
