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

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'pago%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'pago%@x.mx'`)

async function makeSeller(email, slug, storeName, productSlug, title, priceCents, stock, bps) {
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, fullName: storeName },
  })
  await call('/api/seller/register', {
    method: 'POST',
    token: reg.data.tokens.accessToken,
    body: { storeName, slug },
  })
  psql(`UPDATE sellers SET status='active', commission_bps=${bps} WHERE slug='${slug}'`)
  const session = await call('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: reg.data.tokens.refreshToken },
  })
  const token = session.data.tokens.accessToken
  await call('/api/seller/shipping', {
    method: 'PUT',
    token,
    body: { rates: [{ zone: 'nacional', baseCents: 10000, perKgCents: 0 }] },
  })
  const product = await call('/api/seller/products', {
    method: 'POST',
    token,
    body: {
      title,
      slug: productSlug,
      variants: [{ name: 'Única', priceCents, stock, weightGrams: 500, imageKeys: [] }],
    },
  })
  await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token })
  return { token, slug, variantId: product.data.variants[0].id }
}

const a = await makeSeller(`pago${RUN}a@x.mx`, `pago-a-${RUN}`, 'Pagos A', `olla-${RUN}`, 'Olla de barro', 40000, 10, 1000)
const b = await makeSeller(`pago${RUN}b@x.mx`, `pago-b-${RUN}`, 'Pagos B', `sarape-${RUN}`, 'Sarape', 60000, 3, 1500)

const buyerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `pago${RUN}c@x.mx`, password: PASSWORD, fullName: 'Compradora Pagos' },
})
const buyer = buyerReg.data.tokens.accessToken

console.log('\n--- direcciones ---')
check('sin direcciones al inicio', (await call('/api/addresses', { token: buyer })).data.items.length, 0)
check(
  'un código postal de 4 dígitos se rechaza',
  (await call('/api/addresses', {
    method: 'POST',
    token: buyer,
    body: {
      recipient: 'Ana López', phone: '3312345678', street: 'Hidalgo 45',
      neighborhood: 'Centro', city: 'Guadalajara', state: 'Jalisco', postalCode: '4432',
    },
  })).status,
  422,
)
const address = await call('/api/addresses', {
  method: 'POST',
  token: buyer,
  body: {
    label: 'Casa', recipient: 'Ana López', phone: '3312345678', street: 'Hidalgo 45',
    neighborhood: 'Centro', city: 'Guadalajara', state: 'Jalisco', postalCode: '44100',
  },
})
check('la primera dirección queda como predeterminada', address.data.isDefault, true)

console.log('\n--- el carrito tiene que estar listo ---')
check(
  'checkout con el carrito vacío da 409',
  (await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })).status,
  409,
)

await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 2 } })
await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: b.variantId, quantity: 1 } })

check(
  'una dirección ajena da 404',
  (await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: '00000000-0000-0000-0000-000000000000' } })).status,
  404,
)

psql(`UPDATE variants SET stock = 0 WHERE id = '${b.variantId}'`)
const blocked = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
check('con una línea agotada se bloquea', blocked.status, 409)
check('y dice cuál', blocked.data.details?.blockers?.[0]?.reason ?? JSON.stringify(blocked.data).slice(0, 80), 'out_of_stock')
check('y qué producto', blocked.data.details?.blockers?.[0]?.productTitle, 'Sarape')
psql(`UPDATE variants SET stock = 3 WHERE id = '${b.variantId}'`)

console.log('\n--- la compra ---')
const placed = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
check('checkout devuelve 201', placed.status, 201)
const order = placed.data.order
check('un pedido, dos subpedidos', order.suborders.length, 2)
check('subtotal 2x400 + 1x600', order.subtotalCents, 140000)
check('envío de dos tiendas', order.shippingCents, 20000)
check('total', order.totalCents, 160000)
check('nace esperando pago', order.status, 'pending_payment')
check('con número legible', /^MX-\d{6}-[0-9A-Z]{3}$/.test(order.number), true)
check('y un intent de pago', placed.data.payment.intentId.startsWith('pi_fake_'), true)

check(
  'comisión de A: 10% de 80000',
  psql(`SELECT commission_cents FROM suborders so JOIN sellers s ON s.id=so.seller_id WHERE s.slug='pago-a-${RUN}'`),
  8000,
)
check(
  'lo que le toca a A: 80000 - 8000 + 10000 de envío',
  psql(`SELECT payout_cents FROM suborders so JOIN sellers s ON s.id=so.seller_id WHERE s.slug='pago-a-${RUN}'`),
  82000,
)
check(
  'comisión de B: 15% de 60000',
  psql(`SELECT commission_cents FROM suborders so JOIN sellers s ON s.id=so.seller_id WHERE s.slug='pago-b-${RUN}'`),
  9000,
)

check('el carrito queda vacío', (await call('/api/cart', { token: buyer })).data.itemCount, 0)
check('el stock de A bajó de 10 a 8', psql(`SELECT stock FROM variants WHERE id='${a.variantId}'`), 8)
check('la dirección quedó copiada en el pedido', order.shippingSnapshot.postalCode, '44100')

console.log('\n--- doble clic en pagar ---')
const again = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
check('no crea un segundo pedido', again.data.order.id, order.id)
check('solo hay un pedido en la base', psql(`SELECT count(*) FROM orders WHERE buyer_id='${buyerReg.data.user.id}'`), 1)

console.log('\n--- el vendedor no puede enviar lo que no está pagado ---')
const subA = order.suborders.find((s) => s.seller.slug === `pago-a-${RUN}`)
check(
  'enviar antes del pago da 409',
  (await call(`/api/suborders/${subA.id}/ship`, { method: 'POST', token: a.token, body: { carrier: 'Estafeta', trackingNumber: '1234567890' } })).status,
  409,
)

console.log('\n--- el webhook ---')
check(
  'una firma inválida se rechaza',
  (await call('/api/webhooks/payments', {
    method: 'POST',
    body: JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'x' } } }),
    headers: { 'x-payment-signature': 'no' },
  })).status,
  400,
)

const paidEvent = {
  id: `evt_${RUN}_ok`,
  type: 'payment_intent.succeeded',
  data: { object: { id: placed.data.payment.intentId, amount: order.totalCents } },
}
check('el webbook aplica el pago', (await webhook(paidEvent)).data.applied, true)
check('el mismo evento otra vez no hace nada', (await webhook(paidEvent)).data.duplicate, true)
check('solo quedó una fila de evento', psql(`SELECT count(*) FROM payment_events WHERE event_id='evt_${RUN}_ok'`), 1)

const afterPay = await call(`/api/orders/${order.id}`, { token: buyer })
check('el pedido quedó pagado', afterPay.data.status, 'paid')
check('y los subpedidos por enviar', afterPay.data.suborders.every((s) => s.status === 'pending_shipment'), true)

console.log('\n--- envío y entrega ---')
check(
  'el vendedor B no puede enviar la venta de A',
  (await call(`/api/suborders/${subA.id}/ship`, { method: 'POST', token: b.token, body: { carrier: 'Estafeta', trackingNumber: '1234567890' } })).status,
  404,
)
check(
  'el vendedor A sí',
  (await call(`/api/suborders/${subA.id}/ship`, { method: 'POST', token: a.token, body: { carrier: 'Estafeta', trackingNumber: '1234567890' } })).status,
  200,
)
check(
  'confirmar antes de que llegue lo de B da 409',
  (await call(`/api/suborders/${order.suborders.find((s) => s.id !== subA.id).id}/confirm`, { method: 'POST', token: buyer })).status,
  409,
)
check('el comprador confirma la entrega de A', (await call(`/api/suborders/${subA.id}/confirm`, { method: 'POST', token: buyer })).status, 200)
check(
  'queda entregado',
  psql(`SELECT status FROM suborders WHERE id='${subA.id}'`),
  'delivered',
)

const sales = await call('/api/seller/sales', { token: a.token })
check('la venta aparece en el panel del vendedor', sales.data.items.length, 1)
check('con la dirección de entrega', sales.data.items[0].shippingSnapshot.city, 'Guadalajara')
check('y lo que le toca cobrar', sales.data.items[0].payoutCents, 82000)
check(
  'el vendedor B no ve la venta de A',
  (await call('/api/seller/sales', { token: b.token })).data.items.every((s) => s.id !== subA.id),
  true,
)

console.log('\n--- un pago fallido devuelve el stock ---')
await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 1 } })
const second = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
check('el stock bajó a 7', psql(`SELECT stock FROM variants WHERE id='${a.variantId}'`), 7)

const failed = {
  id: `evt_${RUN}_fail`,
  type: 'payment_intent.payment_failed',
  data: { object: { id: second.data.payment.intentId, amount: second.data.order.totalCents } },
}
check('el webhook de fallo aplica', (await webhook(failed)).data.applied, true)
check('el stock vuelve a 8', psql(`SELECT stock FROM variants WHERE id='${a.variantId}'`), 8)
check('el pedido queda cancelado', psql(`SELECT status FROM orders WHERE id='${second.data.order.id}'`), 'cancelled')

console.log('\n--- aislamiento ---')
const otherReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `pago${RUN}d@x.mx`, password: PASSWORD, fullName: 'Otro' },
})
check(
  'otro comprador no ve ese pedido',
  (await call(`/api/orders/${order.id}`, { token: otherReg.data.tokens.accessToken })).status,
  404,
)
check('ni lo lista', (await call('/api/orders', { token: otherReg.data.tokens.accessToken })).data.total, 0)
check('sin token tampoco', (await call(`/api/orders/${order.id}`)).status, 401)

const list = await call('/api/orders', { token: buyer })
check('el comprador ve sus dos pedidos', list.data.total, 2)
check('con el nombre de las tiendas', list.data.items.some((o) => o.storeNames.length === 2), true)

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'pago${RUN}%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'pago${RUN}%@x.mx'`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
