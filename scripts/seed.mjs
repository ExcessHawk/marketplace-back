import { execFileSync } from 'node:child_process'

const API = 'http://localhost:3102'
const EMAIL = 'panel@tonala.mx'
const ADMIN = 'admin@marketplace.mx'
const PENDING = 'pendiente@tonala.mx'
const PASSWORD = 'frase-larga-de-prueba-123'

const RESET = process.argv.includes('--reset')

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'marketplace_postgres', 'psql', '-U', 'postgres', '-d', 'marketplace', '-qtAc', sql],
    { encoding: 'utf8' },
  ).trim()

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function call(path, options = {}, attempt = 0) {
  const { method = 'GET', token, body } = options
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(JSON.parse(text)?.retryAfter ?? 20)
    console.log(`   (rate limit: espero ${retryAfter + 2}s)`)
    await sleep((retryAfter + 2) * 1000)
    return call(path, options, attempt + 1)
  }
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data?.detail ?? text}`)
  return data
}

const exists = (email) =>
  psql(`SELECT count(*) FROM users WHERE email = '${email}' AND deleted_at IS NULL`) !== '0'

async function account(email, fullName) {
  if (exists(email)) {
    return call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })
  }
  return call('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, fullName } })
}

async function store(token, body) {
  const already = psql(`SELECT count(*) FROM sellers WHERE slug = '${body.slug}' AND deleted_at IS NULL`)
  if (already === '0') await call('/api/seller/register', { method: 'POST', token, body })
}

if (RESET) {
  const atRisk = psql(`
    SELECT count(DISTINCT c.user_id)
      FROM cart_items ci
      JOIN carts c    ON c.id = ci.cart_id
      JOIN variants v ON v.id = ci.variant_id
      JOIN products p ON p.id = v.product_id
      JOIN sellers  s ON s.id = p.seller_id
      JOIN users    u ON u.id = s.user_id
     WHERE u.email IN ('${EMAIL}', '${PENDING}')
       AND c.user_id <> u.id`)

  console.log('--reset: borrando las cuentas de demostración.')
  if (atRisk !== '0') {
    console.log(
      `ATENCIÓN: ${atRisk} persona(s) tienen estos productos en su carrito.\n` +
        '  cart_items.variant_id cae en cascada hasta la cuenta del vendedor, así que\n' +
        '  esas líneas se van a borrar también. Corre sin --reset para no tocarlas.',
    )
  }
  psql(`DELETE FROM users WHERE email IN ('${EMAIL}', '${ADMIN}', '${PENDING}')`)
}

psql(`DELETE FROM users WHERE email LIKE 'vendedor%@tonala.mx' OR email LIKE 'intruso%@x.mx' OR email LIKE 'utf8test%@x.mx'`)

let session = await account(EMAIL, 'Lucía Márquez')

await store(session.tokens.accessToken, {
  storeName: 'Barro y Talavera de Tonalá',
  slug: 'barro-y-talavera',
  description:
    'Piezas de barro bruñido y talavera hechas a mano en Tonalá, Jalisco. Cada pieza es distinta: el bruñido se hace con piedra de río y nunca sale igual dos veces.',
})

psql(`UPDATE sellers SET status='active' WHERE slug='barro-y-talavera'`)

session = await call('/api/auth/refresh', {
  method: 'POST',
  body: { refreshToken: session.tokens.refreshToken },
})
const token = session.tokens.accessToken

const catalog = [
  {
    title: 'Jarrón de barro bruñido',
    slug: 'jarron-barro-brunido',
    description:
      'Barro bruñido a mano con piedra de río.\n\nCada pieza tarda cerca de tres semanas: moldeado, secado a la sombra, bruñido y quemado en horno de leña. El tono cambia según dónde quedó en el horno, así que no hay dos iguales.',
    variants: [
      { name: 'Chico · 22 cm', sku: 'JAR-22', priceCents: 48000, stock: 7, imageKeys: [] },
      { name: 'Mediano · 32 cm', sku: 'JAR-32', priceCents: 78000, stock: 3, imageKeys: [] },
      { name: 'Grande · 45 cm', sku: 'JAR-45', priceCents: 125000, stock: 0, imageKeys: [] },
    ],
    publish: true,
  },
  {
    title: 'Piñata de siete picos',
    slug: 'pinata-siete-picos-demo',
    description: 'Olla de barro forrada con papel de china. Los siete picos son los siete pecados capitales.',
    variants: [
      { name: 'Única', sku: 'PIN-01', priceCents: 21900, compareAtCents: 27900, stock: 30, imageKeys: [] },
    ],
    publish: true,
  },
  {
    title: 'Plato de talavera pintado a mano',
    slug: 'plato-talavera',
    description: 'Talavera poblana de 25 cm, pintada a mano con pigmentos minerales.',
    variants: [
      { name: 'Azul cobalto', sku: 'TAL-AZ', priceCents: 34000, stock: 12, imageKeys: [] },
      { name: 'Verde óxido', sku: 'TAL-VE', priceCents: 34000, stock: 5, imageKeys: [] },
    ],
    publish: false,
  },
]

const CATEGORIES = [
  ['Barro y cerámica', 'barro-y-ceramica', 1],
  ['Talavera', 'talavera', 2],
  ['Papel y cartonería', 'papel-y-cartoneria', 3],
  ['Textiles', 'textiles', 4],
]
for (const [name, slug, position] of CATEGORIES) {
  psql(
    `INSERT INTO categories (name, slug, position) VALUES ('${name.replaceAll("'", "''")}', '${slug}', ${position}) ON CONFLICT (slug) DO NOTHING`,
  )
}

const ids = {}
for (const item of catalog) {
  const { publish, ...body } = item
  const existing = psql(`SELECT id FROM products WHERE slug = '${item.slug}' AND deleted_at IS NULL`)
  if (existing) {
    ids[item.slug] = existing
    continue
  }
  const created = await call('/api/seller/products', { method: 'POST', token, body })
  ids[item.slug] = created.id
  if (publish) {
    await call(`/api/seller/products/${created.id}/publish`, { method: 'POST', token })
  }
}

await call('/api/seller/shipping', {
  method: 'PUT',
  token,
  body: {
    rates: [
      { zone: 'nacional', baseCents: 14900, perKgCents: 3500, freeOverCents: 150000 },
      { zone: 'local', baseCents: 6000, perKgCents: 0 },
    ],
  },
})

const admin = await account(ADMIN, 'Rosa Elena Vega')
psql(`UPDATE users SET is_platform_admin = true WHERE email = '${ADMIN}'`)
const adminSession = await call('/api/auth/refresh', {
  method: 'POST',
  body: { refreshToken: admin.tokens.refreshToken },
})

const pending = await account(PENDING, 'Marco Antonio Ruiz')
await store(pending.tokens.accessToken, {
  storeName: 'Alebrijes de Oaxaca',
  slug: 'alebrijes-de-oaxaca',
  description: 'Tallado en copal y pintado a mano en San Martín Tilcajete.',
})

const BY_CATEGORY = {
  'jarron-barro-brunido': 'barro-y-ceramica',
  'pinata-siete-picos-demo': 'papel-y-cartoneria',
  'plato-talavera': 'talavera',
}
for (const [productSlug, categorySlug] of Object.entries(BY_CATEGORY)) {
  psql(
    `UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = '${categorySlug}') WHERE slug = '${productSlug}'`,
  )
}

psql(`UPDATE variants SET weight_grams = 2400 WHERE sku IN ('JAR-22','JAR-32','JAR-45')`)
psql(`UPDATE variants SET weight_grams = 900 WHERE sku = 'PIN-01'`)
psql(`UPDATE variants SET weight_grams = 600 WHERE sku IN ('TAL-AZ','TAL-VE')`)

const published = await call('/api/products')
console.log(`ACCESS=${token}`)
console.log(`REFRESH=${session.tokens.refreshToken}`)
console.log(`EDIT_ID=${ids['plato-talavera']}`)
console.log(`CATALOGO=${published.total} publicados`)
console.log(`TITULOS=${published.items.map((p) => p.title).join(' | ')}`)
console.log(`ADMIN_ACCESS=${adminSession.tokens.accessToken}`)
console.log(`ADMIN_REFRESH=${adminSession.tokens.refreshToken}`)
console.log(`ADMIN_ROLES=${JSON.stringify(adminSession.user.roles)}`)
