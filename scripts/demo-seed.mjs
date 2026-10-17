import { Client } from 'pg'

const API = process.env.DEMO_API ?? 'http://localhost:3102'
const DOMAIN = '@demo.marketplace.mx'
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demostracion-larga-de-prueba-9182'

const BUYER = `comprador${DOMAIN}`
const SELLER = `vendedor${DOMAIN}`
const ADMIN = `admin${DOMAIN}`
const SECOND = `segunda-tienda${DOMAIN}`

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Corre con bun, que lee el .env solo.')
  process.exit(1)
}

const client = new Client({ connectionString: DATABASE_URL })
await client.connect()

// Devuelve la primera columna de la primera fila como texto, que es lo que
// esperan las llamadas de abajo. Antes esto salía por `docker exec psql`, que
// no existe dentro del contenedor de la API.
const psql = async (sql) => {
  const { rows } = await client.query(sql)
  if (!rows.length) return ''
  const first = Object.values(rows[0])[0]
  return first === null || first === undefined ? '' : String(first)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    console.log(`   (límite de peticiones: espero ${retryAfter + 2}s)`)
    await sleep((retryAfter + 2) * 1000)
    return call(path, options, attempt + 1)
  }
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data?.detail ?? text}`)
  return data
}

const exists = async (email) =>
  (await psql(`SELECT count(*) FROM users WHERE email = '${email}' AND deleted_at IS NULL`)) !== '0'

async function account(email, fullName) {
  if (await exists(email)) {
    return call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })
  }
  return call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, fullName },
  })
}

async function store(token, body) {
  const already = await psql(
    `SELECT count(*) FROM sellers WHERE slug = '${body.slug}' AND deleted_at IS NULL`,
  )
  if (already === '0') await call('/api/seller/register', { method: 'POST', token, body })
}

async function product(token, body) {
  const already = await psql(
    `SELECT count(*) FROM products WHERE slug = '${body.slug}' AND deleted_at IS NULL`,
  )
  if (already !== '0') return null
  const created = await call('/api/seller/products', { method: 'POST', token, body })
  return created
}

console.log('Sembrando el mundo de demostración')
console.log(`  base:  ${DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`)
console.log(`  API:   ${API}`)

const health = await call('/health/ready').catch(() => null)
if (!health) {
  console.error('La API no responde. Levántala con `bun run dev` antes de sembrar.')
  process.exit(1)
}

const buyer = await account(BUYER, 'Dani (comprador de prueba)')
const seller = await account(SELLER, 'Barro y Talavera')
const second = await account(SECOND, 'Copal y Color')
const admin = await account(ADMIN, 'Equipo de la plataforma')

console.log('cuentas listas')

const emails = [BUYER, SELLER, SECOND, ADMIN].map((e) => `'${e}'`).join(', ')
await psql(`UPDATE users SET is_demo = true WHERE email IN (${emails})`)
await psql(`UPDATE users SET is_platform_admin = true WHERE email = '${ADMIN}'`)
console.log('marcadas como cuentas de demostración; admin con permiso de plataforma')

await store(seller.tokens.accessToken, {
  storeName: 'Barro y Talavera',
  slug: 'barro-y-talavera-demo',
  description:
    'Talavera poblana y barro bruñido de Tonalá. Cada pieza sale del torno y se pinta a mano.',
  contactEmail: SELLER,
  contactPhone: '3312345678',
})

await store(second.tokens.accessToken, {
  storeName: 'Copal y Color',
  slug: 'copal-y-color-demo',
  description:
    'Figuras talladas en copal y pintadas con tinta natural, de San Martín Tilcajete.',
  contactEmail: SECOND,
  contactPhone: '9511234567',
})

console.log('tiendas registradas')

await psql(`
  UPDATE sellers SET status = 'active', updated_at = now()
   WHERE slug IN ('barro-y-talavera-demo', 'copal-y-color-demo')`)

const sellerLogin = await call('/api/auth/login', {
  method: 'POST',
  body: { email: SELLER, password: PASSWORD },
})
const secondLogin = await call('/api/auth/login', {
  method: 'POST',
  body: { email: SECOND, password: PASSWORD },
})

// Las categorías las sembraba el seed de desarrollo. La demostración se
// planta las suyas para poder correr sola en un servidor limpio.
const CATEGORIES = [
  ['Barro y cerámica', 'barro-y-ceramica', 1],
  ['Talavera', 'talavera', 2],
  ['Papel y cartonería', 'papel-y-cartoneria', 3],
  ['Textiles', 'textiles', 4],
]
for (const [name, slug, position] of CATEGORIES) {
  await psql(
    `INSERT INTO categories (name, slug, position)
          VALUES ('${name.replaceAll("'", "''")}', '${slug}', ${position})
     ON CONFLICT (slug) DO NOTHING`,
  )
}

const categoryId = await psql(`SELECT id FROM categories WHERE slug = 'talavera'`)
if (!categoryId) {
  console.error('No pude crear las categorías. ¿Corriste las migraciones?')
  process.exit(1)
}
console.log('categorías listas')

const catalog = [
  {
    token: sellerLogin.tokens.accessToken,
    slug: 'jarron-de-talavera-azul-demo',
    title: 'Jarrón de talavera azul cobalto',
    description:
      'Jarrón de 32 cm en talavera poblana, esmaltado y cocido dos veces. El azul sale del cobalto, no de pintura.',
    priceCents: 189000,
    stock: 7,
    weightGrams: 2400,
  },
  {
    token: sellerLogin.tokens.accessToken,
    slug: 'juego-de-tazas-barro-brunido-demo',
    title: 'Juego de seis tazas de barro bruñido',
    description:
      'Barro bruñido con piedra de río, sin esmalte. Aguanta el café caliente y no le pasa nada en el lavavajillas.',
    priceCents: 94000,
    stock: 12,
    weightGrams: 1800,
  },
  {
    token: sellerLogin.tokens.accessToken,
    slug: 'pinata-de-barro-pintada-demo',
    title: 'Piñata de barro pintada a mano',
    description: 'Pieza decorativa de 24 cm. La acentuación en el nombre es intencional: sirve para probar la búsqueda.',
    priceCents: 56000,
    stock: 3,
    weightGrams: 1200,
  },
  {
    token: secondLogin.tokens.accessToken,
    slug: 'alebrije-jaguar-demo',
    title: 'Alebrije jaguar en copal',
    description:
      'Tallado en una sola pieza de copal y pintado con grana cochinilla. Mide 18 cm de largo.',
    priceCents: 245000,
    stock: 4,
    weightGrams: 900,
  },
  {
    token: secondLogin.tokens.accessToken,
    slug: 'alebrije-colibri-demo',
    title: 'Alebrije colibrí pequeño',
    description: 'Colibrí de 9 cm, punteado a pincel fino. Se vende en caja de madera.',
    priceCents: 78000,
    stock: 15,
    weightGrams: 300,
  },
]

let created = 0
for (const item of catalog) {
  const made = await product(item.token, {
    title: item.title,
    slug: item.slug,
    description: item.description,
    categoryId,
    variants: [
      {
        name: 'Única',
        sku: `${item.slug.slice(0, 20)}-u`,
        priceCents: item.priceCents,
        stock: item.stock,
        weightGrams: item.weightGrams,
      },
    ],
  })
  if (made) {
    await call(`/api/seller/products/${made.id}/publish`, {
      method: 'POST',
      token: item.token,
    })
    created += 1
  }
}
console.log(`catálogo: ${created} productos nuevos`)

for (const token of [sellerLogin.tokens.accessToken, secondLogin.tokens.accessToken]) {
  await call('/api/seller/shipping', {
    method: 'PUT',
    token,
    body: {
      rates: [
        { zone: 'nacional', baseCents: 9900, perKgCents: 2500, freeOverCents: 150000 },
        { zone: 'local', baseCents: 5000, perKgCents: 1500, freeOverCents: 80000 },
      ],
    },
  })
}
console.log('tarifas de envío puestas')

const artwork = {
  'jarron-de-talavera-azul-demo': '/piezas/jarron-talavera.svg',
  'juego-de-tazas-barro-brunido-demo': '/piezas/tazas-barro.svg',
  'pinata-de-barro-pintada-demo': '/piezas/pinata-barro.svg',
  'alebrije-jaguar-demo': '/piezas/alebrije-jaguar.svg',
  'alebrije-colibri-demo': '/piezas/alebrije-colibri.svg',
}

for (const [slug, file] of Object.entries(artwork)) {
  // Sin condicion de vacio: tambien corrige las que quedaron apuntando a la
  // ruta vieja, /demo/, que chocaba con una ruta de la aplicacion.
  await psql(`
    UPDATE variants v
       SET image_keys = '["${file}"]'::jsonb
      FROM products p
     WHERE p.id = v.product_id
       AND p.slug = '${slug}'
       AND v.image_keys <> '["${file}"]'::jsonb`)
}
console.log('ilustraciones asignadas')

const buyerToken = (
  await call('/api/auth/login', { method: 'POST', body: { email: BUYER, password: PASSWORD } })
).tokens.accessToken

const addresses = await call('/api/addresses', { token: buyerToken })
if (!addresses.items?.length) {
  await call('/api/addresses', {
    method: 'POST',
    token: buyerToken,
    body: {
      label: 'Casa',
      recipient: 'Dani Ruiz',
      phone: '3311122233',
      street: 'Av. Vallarta 1234',
      interior: '5',
      neighborhood: 'Americana',
      city: 'Guadalajara',
      state: 'Jalisco',
      postalCode: '44100',
      isDefault: true,
    },
  })
  console.log('dirección de entrega lista')
}

async function buildOrder() {
  const placed = await psql(`
    SELECT count(*) FROM orders o
      JOIN users u ON u.id = o.buyer_id
     WHERE u.email = '${BUYER}' AND o.status <> 'pending_payment'`)
  if (placed !== '0') {
    console.log('el comprador ya tiene un pedido pagado, no creo otro')
    return
  }

  const detail = await call('/api/products/jarron-de-talavera-azul-demo')
  const variantId = detail.variants?.[0]?.id
  if (!variantId) throw new Error('el jarrón de demostración no tiene variante')

  await call('/api/cart/items', {
    method: 'POST',
    token: buyerToken,
    body: { variantId, quantity: 1 },
  })

  const list = await call('/api/addresses', { token: buyerToken })
  const addressId = list.items[0].id

  const checkout = await call('/api/checkout', {
    method: 'POST',
    token: buyerToken,
    body: { addressId },
  })

  await call(`/api/webhooks/simulate/${checkout.payment.intentId}`, {
    method: 'POST',
    token: buyerToken,
    body: { outcome: 'succeeded' },
  })

  const order = await call(`/api/orders/${checkout.order.id}`, { token: buyerToken })
  const suborder = order.suborders[0]
  console.log(`pedido ${order.number ?? order.id.slice(0, 8)} pagado`)

  await call(`/api/chat/${suborder.id}`, {
    method: 'POST',
    token: buyerToken,
    body: { body: '¡Hola! ¿El jarrón se puede enviar con envoltura de regalo?' },
  })

  const sellerSession = await call('/api/auth/login', {
    method: 'POST',
    body: { email: SELLER, password: PASSWORD },
  })

  await call(`/api/chat/${suborder.id}`, {
    method: 'POST',
    token: sellerSession.tokens.accessToken,
    body: { body: 'Claro que sí, va envuelto en papel de estraza con cordón. Sale hoy mismo.' },
  })

  await call(`/api/suborders/${suborder.id}/ship`, {
    method: 'POST',
    token: sellerSession.tokens.accessToken,
    body: { carrier: 'Estafeta', trackingNumber: 'DEMO123456789' },
  })

  console.log('pedido enviado, con conversación de dos mensajes')
}

await buildOrder().catch((error) => {
  console.log(`no pude armar el pedido de ejemplo: ${error.message}`)
  console.log('el resto de la demostración sigue sirviendo')
})

await psql(`UPDATE users SET is_demo = true WHERE email IN (${emails})`)

console.log('')
console.log('Listo. Cuentas de demostración:')
for (const [role, email] of [
  ['comprador', BUYER],
  ['vendedor', SELLER],
  ['admin', ADMIN],
]) {
  console.log(`  ${role.padEnd(10)} ${email}`)
}
console.log('')
console.log('La contraseña no se usa desde el portafolio: POST /api/demo/session entrega la sesión.')
console.log('Ese endpoint solo existe cuando DEMO_MODE=true.')

await client.end()
