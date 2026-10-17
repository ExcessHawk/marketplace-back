import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const API = 'http://localhost:3102'
const RUN = Date.now()
const PASSWORD = 'frase-larga-de-prueba-123'

const WEBHOOK_SECRET = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n')
  .find((line) => line.startsWith('PAYMENT_WEBHOOK_SECRET='))
  .split('=')[1]
  .trim()

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
  const { method = 'GET', token, body, headers = {} } = options
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(JSON.parse(text)?.retryAfter ?? 20)
    console.log(`   (rate limit: espero ${retryAfter + 2}s)`)
    await sleep((retryAfter + 2) * 1000)
    return call(path, options, attempt + 1)
  }
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

const webhook = (event) => {
  const raw = JSON.stringify(event)
  return call('/api/webhooks/payments', {
    method: 'POST',
    body: raw,
    headers: { 'x-payment-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
  })
}

const results = []
function check(label, actual, expected) {
  const pass = String(actual) === String(expected)
  results.push(pass)
  console.log(
    `${pass ? 'OK ' : 'XX '} ${label.padEnd(62)} ${actual}${pass ? '' : `  (esperaba ${expected})`}`,
  )
}

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'rev%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'rev%@x.mx'`)

const sellerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `rev${RUN}v@x.mx`, password: PASSWORD, fullName: 'Vendedor Reseñas' },
})
await call('/api/seller/register', {
  method: 'POST',
  token: sellerReg.data.tokens.accessToken,
  body: { storeName: 'Tienda Reseñas', slug: `rev-${RUN}` },
})
psql(`UPDATE sellers SET status='active' WHERE slug='rev-${RUN}'`)
const seller = (
  await call('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: sellerReg.data.tokens.refreshToken },
  })
).data.tokens.accessToken
await call('/api/seller/shipping', {
  method: 'PUT',
  token: seller,
  body: { rates: [{ zone: 'nacional', baseCents: 5000, perKgCents: 0 }] },
})

async function makeProduct(suffix) {
  const slug = `rev-prod-${suffix}-${RUN}`
  const product = await call('/api/seller/products', {
    method: 'POST',
    token: seller,
    body: {
      title: `Producto reseñado ${suffix}`,
      slug,
      variants: [{ name: 'Única', priceCents: 50000, stock: 50, weightGrams: 300, imageKeys: [] }],
    },
  })
  await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token: seller })
  return { id: product.data.id, slug, variantId: product.data.variants[0].id }
}

const p1 = await makeProduct('a')
const p2 = await makeProduct('b')

async function makeBuyer(suffix, name) {
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { email: `rev${RUN}${suffix}@x.mx`, password: PASSWORD, fullName: name },
  })
  const token = reg.data.tokens.accessToken
  const address = await call('/api/addresses', {
    method: 'POST',
    token,
    body: {
      recipient: name, phone: '3312345678', street: 'Hidalgo 45',
      neighborhood: 'Centro', city: 'Guadalajara', state: 'Jalisco', postalCode: '44100',
    },
  })
  return { token, addressId: address.data.id }
}

const ana = await makeBuyer('c', 'Ana López Martínez')
const beto = await makeBuyer('d', 'Beto')

async function buy(buyer, variants, { deliver = true } = {}) {
  for (const variantId of variants) {
    await call('/api/cart/items', { method: 'POST', token: buyer.token, body: { variantId, quantity: 1 } })
  }
  const placed = await call('/api/checkout', {
    method: 'POST', token: buyer.token, body: { addressId: buyer.addressId },
  })
  await webhook({
    id: `evt_${RUN}_${placed.data.order.number}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: placed.data.payment.intentId } },
  })
  const sub = placed.data.order.suborders[0]
  await call(`/api/suborders/${sub.id}/ship`, {
    method: 'POST', token: seller, body: { carrier: 'Estafeta', trackingNumber: `R${Date.now()}` },
  })
  if (deliver) await call(`/api/suborders/${sub.id}/confirm`, { method: 'POST', token: buyer.token })
  return sub.id
}

console.log('\n--- cuándo se puede opinar ---')
const undelivered = await buy(ana, [p1.variantId], { deliver: false })
check(
  'sin confirmar la entrega no se puede',
  (await call(`/api/suborders/${undelivered}/reviews`, { method: 'POST', token: ana.token, body: { productId: p1.id, rating: 5 } })).status,
  409,
)
await call(`/api/suborders/${undelivered}/confirm`, { method: 'POST', token: ana.token })

check(
  'un rating de 6 se rechaza',
  (await call(`/api/suborders/${undelivered}/reviews`, { method: 'POST', token: ana.token, body: { productId: p1.id, rating: 6 } })).status,
  422,
)
check(
  'un producto que no venía en ese pedido da 404',
  (await call(`/api/suborders/${undelivered}/reviews`, { method: 'POST', token: ana.token, body: { productId: p2.id, rating: 5 } })).status,
  404,
)
check(
  'otro comprador no puede opinar de ese pedido',
  (await call(`/api/suborders/${undelivered}/reviews`, { method: 'POST', token: beto.token, body: { productId: p1.id, rating: 1 } })).status,
  404,
)
check(
  'el vendedor tampoco',
  (await call(`/api/suborders/${undelivered}/reviews`, { method: 'POST', token: seller, body: { productId: p1.id, rating: 5 } })).status,
  404,
)

const review = await call(`/api/suborders/${undelivered}/reviews`, {
  method: 'POST',
  token: ana.token,
  body: { productId: p1.id, rating: 4, body: 'Llegó bien empacado y el barro se siente firme.' },
})
check('la compradora sí', review.status, 201)
check('con su calificación', review.data.rating, 4)
check('el nombre sale abreviado', review.data.authorName, 'Ana L.')
check(
  'dos veces del mismo producto no',
  (await call(`/api/suborders/${undelivered}/reviews`, { method: 'POST', token: ana.token, body: { productId: p1.id, rating: 1 } })).status,
  409,
)

console.log('\n--- el promedio se recalcula ---')
check('el producto quedó en 4.00', psql(`SELECT rating_avg FROM products WHERE id='${p1.id}'`), 400)
check('con una opinión', psql(`SELECT rating_count FROM products WHERE id='${p1.id}'`), 1)
check('y la tienda igual', psql(`SELECT rating_avg FROM sellers WHERE slug='rev-${RUN}'`), 400)

const sub2 = await buy(beto, [p1.variantId])
await call(`/api/suborders/${sub2}/reviews`, {
  method: 'POST', token: beto.token, body: { productId: p1.id, rating: 5, body: 'Excelente' },
})
check('con 4 y 5 el promedio es 4.50', psql(`SELECT rating_avg FROM products WHERE id='${p1.id}'`), 450)
check('y son dos', psql(`SELECT rating_count FROM products WHERE id='${p1.id}'`), 2)

console.log('\n--- el catálogo lo muestra ---')
const listed = await call(`/api/products?seller=rev-${RUN}`)
const card = listed.data.items.find((p) => p.slug === p1.slug)
check('la tarjeta trae el promedio', card.ratingAvg, 4.5)
check('y el conteo', card.ratingCount, 2)
const detail = await call(`/api/products/${p1.slug}`)
check('la ficha también', detail.data.ratingAvg, 4.5)
const otherCard = listed.data.items.find((p) => p.slug === p2.slug)
check('un producto sin opiniones viene en null', otherCard.ratingAvg, null)

const summary = await call(`/api/products/${p1.slug}/reviews/summary`)
check('el resumen da el promedio', summary.data.average, 4.5)
check('y el desglose por estrellas', `${summary.data.breakdown['4']}-${summary.data.breakdown['5']}`, '1-1')

const publicList = await call(`/api/products/${p1.slug}/reviews`)
check('las opiniones son públicas', publicList.data.total, 2)
check('sin token también', (await call(`/api/products/${p1.slug}/reviews`)).status, 200)

console.log('\n--- editar y borrar ---')
const edited = await call(`/api/reviews/${review.data.id}`, {
  method: 'PATCH', token: ana.token, body: { rating: 2, body: 'Se quebró a la semana.' },
})
check('la autora puede editarla', edited.data.rating, 2)
check('el promedio baja a 3.50', psql(`SELECT rating_avg FROM products WHERE id='${p1.id}'`), 350)
check(
  'otro no puede editarla',
  (await call(`/api/reviews/${review.data.id}`, { method: 'PATCH', token: beto.token, body: { rating: 5 } })).status,
  404,
)

console.log('\n--- el vendedor responde ---')
const replied = await call(`/api/reviews/${review.data.id}/reply`, {
  method: 'POST', token: seller, body: { reply: 'Lamento mucho eso, escríbeme y te repongo la pieza.' },
})
check('el vendedor puede responder', replied.data.sellerReply.startsWith('Lamento'), true)
check(
  'un comprador no puede responder como tienda',
  (await call(`/api/reviews/${review.data.id}/reply`, { method: 'POST', token: beto.token, body: { reply: 'yo contesto' } })).status,
  403,
)

console.log('\n--- borrar ---')
check(
  'otro no puede borrarla',
  (await call(`/api/reviews/${review.data.id}`, { method: 'DELETE', token: beto.token })).status,
  404,
)
check('la autora sí', (await call(`/api/reviews/${review.data.id}`, { method: 'DELETE', token: ana.token })).status, 200)
check('el promedio vuelve a 5.00', psql(`SELECT rating_avg FROM products WHERE id='${p1.id}'`), 500)
check('y queda una', psql(`SELECT rating_count FROM products WHERE id='${p1.id}'`), 1)

console.log('\n--- lo que falta por opinar ---')
const pending = await call(`/api/suborders/${sub2}/reviews`, { token: beto.token })
check('dice si ya se puede opinar', pending.data.canReview, true)
check('y lista el producto con su opinión', pending.data.items[0].review.rating, 5)

const sellerReviews = await call(`/api/sellers/rev-${RUN}/reviews`)
check('la tienda expone las suyas', sellerReviews.data.total, 1)

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'rev${RUN}%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'rev${RUN}%@x.mx'`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
