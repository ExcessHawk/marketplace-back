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

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'pay%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'pay%@x.mx'`)

const ADMIN = `pay${RUN}admin@x.mx`
const adminReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: ADMIN, password: PASSWORD, fullName: 'Admin Pagos' },
})
psql(`UPDATE users SET is_platform_admin = true WHERE email = '${ADMIN}'`)
const adminSession = await call('/api/auth/refresh', {
  method: 'POST',
  body: { refreshToken: adminReg.data.tokens.refreshToken },
})
const admin = adminSession.data.tokens.accessToken

async function makeSeller(suffix, bps) {
  const email = `pay${RUN}${suffix}@x.mx`
  const slug = `pay-${suffix}-${RUN}`
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, fullName: `Tienda ${suffix.toUpperCase()}` },
  })
  await call('/api/seller/register', {
    method: 'POST',
    token: reg.data.tokens.accessToken,
    body: { storeName: `Tienda ${suffix.toUpperCase()}`, slug },
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
    body: { rates: [{ zone: 'nacional', baseCents: 5000, perKgCents: 0 }] },
  })
  const product = await call('/api/seller/products', {
    method: 'POST',
    token,
    body: {
      title: `Producto ${suffix}`,
      slug: `prod-${suffix}-${RUN}`,
      variants: [{ name: 'Única', priceCents: 100000, stock: 20, weightGrams: 400, imageKeys: [] }],
    },
  })
  await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token })
  return { token, slug, variantId: product.data.variants[0].id }
}

const a = await makeSeller('a', 1000)
const b = await makeSeller('b', 2000)

const buyerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `pay${RUN}c@x.mx`, password: PASSWORD, fullName: 'Comprador Pagos' },
})
const buyer = buyerReg.data.tokens.accessToken
const address = await call('/api/addresses', {
  method: 'POST',
  token: buyer,
  body: {
    recipient: 'Ana López', phone: '3312345678', street: 'Hidalgo 45',
    neighborhood: 'Centro', city: 'Guadalajara', state: 'Jalisco', postalCode: '44100',
  },
})

async function buyAndDeliver(seller, quantity) {
  await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: seller.variantId, quantity } })
  const placed = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
  await webhook({
    id: `evt_${RUN}_${placed.data.order.number}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: placed.data.payment.intentId } },
  })
  const sub = placed.data.order.suborders[0]
  await call(`/api/suborders/${sub.id}/ship`, {
    method: 'POST',
    token: seller.token,
    body: { carrier: 'Estafeta', trackingNumber: `TR${Date.now()}` },
  })
  await call(`/api/suborders/${sub.id}/confirm`, { method: 'POST', token: buyer })
  return sub.id
}

console.log('\n--- antes de entregar no hay nada que pagar ---')
await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 1 } })
const pendingOrder = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
let earnings = await call('/api/seller/payouts', { token: a.token })
check('un pedido sin pagar no cuenta', earnings.data.pending.count, 0)

await webhook({
  id: `evt_${RUN}_pend`,
  type: 'payment_intent.succeeded',
  data: { object: { id: pendingOrder.data.payment.intentId } },
})
earnings = await call('/api/seller/payouts', { token: a.token })
check('pagado pero sin entregar tampoco', earnings.data.pending.count, 0)

const subPending = pendingOrder.data.order.suborders[0]
await call(`/api/suborders/${subPending.id}/ship`, {
  method: 'POST', token: a.token, body: { carrier: 'DHL', trackingNumber: 'AAA111' },
})
earnings = await call('/api/seller/payouts', { token: a.token })
check('enviado pero sin confirmar tampoco', earnings.data.pending.count, 0)

await call(`/api/suborders/${subPending.id}/confirm`, { method: 'POST', token: buyer })

console.log('\n--- entregado: ahí sí ---')
earnings = await call('/api/seller/payouts', { token: a.token })
check('entregado entra a lo por cobrar', earnings.data.pending.count, 1)
check('100000 - 10% + 5000 de envío', earnings.data.pending.amountCents, 95000)
check('todavía no le han depositado nada', earnings.data.paidTotalCents, 0)
check('y la línea trae el número de pedido', /^MX-/.test(earnings.data.lines[0].orderNumber), true)

await buyAndDeliver(a, 2)
await buyAndDeliver(b, 1)

earnings = await call('/api/seller/payouts', { token: a.token })
check('dos ventas entregadas de A', earnings.data.pending.count, 2)
check('suman 95000 (1 pieza) + 185000 (2 piezas)', earnings.data.pending.amountCents, 280000)

console.log('\n--- la corrida de pagos ---')
check(
  'un vendedor no puede correrla',
  (await call('/api/admin/payouts/run', { method: 'POST', token: a.token })).status,
  403,
)
check('sin token tampoco', (await call('/api/admin/payouts/run', { method: 'POST' })).status, 401)

const run = await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check('la corrida crea pagos', run.data.created >= 2, true)
check(
  'uno para cada uno de mis dos vendedores',
  psql(`SELECT count(*) FROM payouts p JOIN sellers s ON s.id=p.seller_id WHERE s.slug LIKE 'pay-%-${RUN}'`),
  2,
)
check('y nada queda retenido con hold 0', run.data.skippedHeld, 0)

earnings = await call('/api/seller/payouts', { token: a.token })
check('A ya no tiene nada por cobrar', earnings.data.pending.count, 0)
check('y su total depositado es 280000', earnings.data.paidTotalCents, 280000)
check('con un pago en la lista', earnings.data.payouts.length, 1)
check('marcado como depositado', earnings.data.payouts[0].status, 'paid')
check('con su id de transferencia', earnings.data.payouts[0].transferId.startsWith('tr_fake_'), true)
check('y el conteo de ventas', earnings.data.payouts[0].suborderCount, 2)

const earningsB = await call('/api/seller/payouts', { token: b.token })
check('B cobra 100000 - 20% + 5000', earningsB.data.paidTotalCents, 85000)

console.log('\n--- no paga dos veces ---')
const second = await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check('una segunda corrida no crea nada', second.data.created, 0)
check(
  'y sigue habiendo dos pagos',
  psql(`SELECT count(*) FROM payouts p JOIN sellers s ON s.id=p.seller_id WHERE s.slug LIKE 'pay-%-${RUN}'`),
  2,
)
check(
  'cada subpedido quedó con su transferencia',
  psql(`SELECT count(*) FROM suborders so JOIN sellers s ON s.id=so.seller_id WHERE s.slug LIKE 'pay-%-${RUN}' AND so.transfer_id IS NULL`),
  0,
)

console.log('\n--- la retención ---')
await buyAndDeliver(a, 1)
psql(`UPDATE suborders SET delivered_at = now() WHERE payout_id IS NULL AND status='delivered'`)
const held = await call('/api/admin/payouts/run', {
  method: 'POST',
  token: admin,
  headers: { 'x-hold-override': '1' },
})
check('con hold 0 la nueva venta sí se paga', held.data.created, 1)

console.log('\n--- aislamiento y bitácora ---')
check(
  'un vendedor no ve los pagos de otro',
  (await call('/api/seller/payouts', { token: b.token })).data.payouts.every((p) => p.seller.slug === `pay-b-${RUN}`),
  true,
)
check(
  'el admin los ve todos',
  (await call('/api/admin/payouts', { token: admin })).data.total >= 3,
  true,
)
check(
  'la bitácora registró cada pago',
  psql(`SELECT count(*) FROM audit_logs WHERE action='payout.created' AND record_id IN (SELECT p.id::text FROM payouts p JOIN sellers s ON s.id=p.seller_id WHERE s.slug LIKE 'pay-%-${RUN}')`),
  3,
)

psql(`DELETE FROM payouts WHERE seller_id IN (SELECT id FROM sellers WHERE slug LIKE 'pay-%-${RUN}')`)
psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'pay${RUN}%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'pay${RUN}%@x.mx'`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
