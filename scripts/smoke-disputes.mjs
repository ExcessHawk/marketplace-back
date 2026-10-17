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

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'dis%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'dis%@x.mx'`)

const ADMIN = `dis${RUN}admin@x.mx`
const adminReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: ADMIN, password: PASSWORD, fullName: 'Admin Disputas' },
})
psql(`UPDATE users SET is_platform_admin = true WHERE email = '${ADMIN}'`)
const admin = (
  await call('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: adminReg.data.tokens.refreshToken },
  })
).data.tokens.accessToken

const sellerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `dis${RUN}v@x.mx`, password: PASSWORD, fullName: 'Vendedor Disputas' },
})
await call('/api/seller/register', {
  method: 'POST',
  token: sellerReg.data.tokens.accessToken,
  body: { storeName: 'Tienda Disputas', slug: `dis-${RUN}` },
})
psql(`UPDATE sellers SET status='active' WHERE slug='dis-${RUN}'`)
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
const product = await call('/api/seller/products', {
  method: 'POST',
  token: seller,
  body: {
    title: 'Olla disputada',
    slug: `olla-dis-${RUN}`,
    variants: [{ name: 'Única', priceCents: 100000, stock: 30, weightGrams: 400, imageKeys: [] }],
  },
})
await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token: seller })
const variantId = product.data.variants[0].id

const buyerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `dis${RUN}c@x.mx`, password: PASSWORD, fullName: 'Compradora Disputas' },
})
const buyer = buyerReg.data.tokens.accessToken
const otherReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `dis${RUN}o@x.mx`, password: PASSWORD, fullName: 'Ajeno' },
})
const other = otherReg.data.tokens.accessToken

const address = await call('/api/addresses', {
  method: 'POST',
  token: buyer,
  body: {
    recipient: 'Ana López', phone: '3312345678', street: 'Hidalgo 45',
    neighborhood: 'Centro', city: 'Guadalajara', state: 'Jalisco', postalCode: '44100',
  },
})

async function buy({ ship = true, deliver = true } = {}) {
  await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId, quantity: 1 } })
  const placed = await call('/api/checkout', { method: 'POST', token: buyer, body: { addressId: address.data.id } })
  await webhook({
    id: `evt_${RUN}_${placed.data.order.number}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: placed.data.payment.intentId } },
  })
  const sub = placed.data.order.suborders[0]
  if (ship) {
    await call(`/api/suborders/${sub.id}/ship`, {
      method: 'POST', token: seller, body: { carrier: 'Estafeta', trackingNumber: `T${Date.now()}` },
    })
  }
  if (deliver) await call(`/api/suborders/${sub.id}/confirm`, { method: 'POST', token: buyer })
  return sub.id
}

const REASON = { reason: 'damaged', description: 'La olla llegó quebrada de la base y no se puede usar.' }

console.log('\n--- cuándo se puede abrir ---')
const unshipped = await buy({ ship: false, deliver: false })
check(
  'antes de que salga de la tienda no se puede',
  (await call(`/api/suborders/${unshipped}/dispute`, { method: 'POST', token: buyer, body: REASON })).status,
  409,
)

const sub = await buy()
check(
  'una descripción corta se rechaza',
  (await call(`/api/suborders/${sub}/dispute`, { method: 'POST', token: buyer, body: { reason: 'damaged', description: 'mala' } })).status,
  422,
)
check(
  'el vendedor no puede abrirla por el comprador',
  (await call(`/api/suborders/${sub}/dispute`, { method: 'POST', token: seller, body: REASON })).status,
  404,
)
check(
  'un tercero tampoco',
  (await call(`/api/suborders/${sub}/dispute`, { method: 'POST', token: other, body: REASON })).status,
  404,
)

const opened = await call(`/api/suborders/${sub}/dispute`, { method: 'POST', token: buyer, body: REASON })
check('el comprador sí', opened.status, 201)
check('nace abierta', opened.data.status, 'open')
check('con el motivo', opened.data.reason, 'damaged')
check('y la descripción como primer mensaje', opened.data.messages.length, 1)
check(
  'dos veces no',
  (await call(`/api/suborders/${sub}/dispute`, { method: 'POST', token: buyer, body: REASON })).status,
  409,
)

console.log('\n--- congela el pago ---')
const runHeld = await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check(
  'con disputa abierta el subpedido no se paga',
  psql(`SELECT count(*) FROM suborders WHERE id='${sub}' AND payout_id IS NOT NULL`),
  0,
)
const earnings = await call('/api/seller/payouts', { token: seller })
check('ni aparece en lo por cobrar', earnings.data.lines.every((l) => l.suborderId !== sub), true)

console.log('\n--- la conversación ---')
check(
  'el vendedor puede responder',
  (await call(`/api/disputes/${opened.data.id}/messages`, { method: 'POST', token: seller, body: { body: 'Mándame una foto por favor' } })).status,
  200,
)
const withBuyer = await call(`/api/disputes/${opened.data.id}/messages`, {
  method: 'POST', token: buyer, body: { body: 'Aquí va la foto de la base quebrada' },
})
check('y el comprador también', withBuyer.data.messages.length, 3)
check('cada mensaje con su rol', withBuyer.data.messages.map((m) => m.senderRole).join(','), 'buyer,seller,buyer')
check(
  'un tercero no puede escribir',
  (await call(`/api/disputes/${opened.data.id}/messages`, { method: 'POST', token: other, body: { body: 'yo opino' } })).status,
  404,
)
check('ni leerla', (await call(`/api/disputes/${opened.data.id}`, { token: other })).status, 404)
check('el vendedor sí la lee', (await call(`/api/disputes/${opened.data.id}`, { token: seller })).status, 200)

console.log('\n--- resolver ---')
check(
  'un vendedor no puede resolver',
  (await call(`/api/admin/disputes/${opened.data.id}/resolve`, { method: 'POST', token: seller, body: { inFavorOf: 'seller', resolution: 'Yo decido que tengo razón porque sí.' } })).status,
  403,
)
const resolved = await call(`/api/admin/disputes/${opened.data.id}/resolve`, {
  method: 'POST',
  token: admin,
  body: { inFavorOf: 'buyer', resolution: 'La foto muestra la base quebrada. Se reembolsa al comprador.' },
})
check('el admin sí', resolved.status, 200)
check('queda a favor del comprador', resolved.data.status, 'resolved_buyer')
check('con la resolución como mensaje de la plataforma', resolved.data.messages.at(-1).senderRole, 'platform')
check('el subpedido queda reembolsado', psql(`SELECT status FROM suborders WHERE id='${sub}'`), 'refunded')
check(
  'resolver dos veces no se puede',
  (await call(`/api/admin/disputes/${opened.data.id}/resolve`, { method: 'POST', token: admin, body: { inFavorOf: 'seller', resolution: 'Cambié de opinión y ahora digo otra cosa.' } })).status,
  409,
)
check(
  'ya no se puede escribir en una resuelta',
  (await call(`/api/disputes/${opened.data.id}/messages`, { method: 'POST', token: buyer, body: { body: 'gracias' } })).status,
  409,
)

console.log('\n--- reembolsado nunca se paga ---')
await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check(
  'el subpedido reembolsado sigue sin pago',
  psql(`SELECT count(*) FROM suborders WHERE id='${sub}' AND payout_id IS NOT NULL`),
  0,
)

console.log('\n--- a favor del vendedor sí libera ---')
const sub2 = await buy()
const d2 = await call(`/api/suborders/${sub2}/dispute`, { method: 'POST', token: buyer, body: REASON })
await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check(
  'mientras está abierta no se paga',
  psql(`SELECT count(*) FROM suborders WHERE id='${sub2}' AND payout_id IS NOT NULL`),
  0,
)
await call(`/api/admin/disputes/${d2.data.id}/resolve`, {
  method: 'POST',
  token: admin,
  body: { inFavorOf: 'seller', resolution: 'Las fotos muestran la pieza completa. Se libera el pago.' },
})
await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check(
  'al resolver a favor del vendedor sí se paga',
  psql(`SELECT count(*) FROM suborders WHERE id='${sub2}' AND payout_id IS NOT NULL`),
  1,
)

console.log('\n--- retirar ---')
const sub3 = await buy()
const d3 = await call(`/api/suborders/${sub3}/dispute`, { method: 'POST', token: buyer, body: REASON })
check(
  'el vendedor no puede retirarla',
  (await call(`/api/disputes/${d3.data.id}/withdraw`, { method: 'POST', token: seller })).status,
  404,
)
check(
  'el comprador sí',
  (await call(`/api/disputes/${d3.data.id}/withdraw`, { method: 'POST', token: buyer })).data.status,
  'withdrawn',
)
await call('/api/admin/payouts/run', { method: 'POST', token: admin })
check(
  'y al retirarla se libera el pago',
  psql(`SELECT count(*) FROM suborders WHERE id='${sub3}' AND payout_id IS NOT NULL`),
  1,
)

console.log('\n--- listas y bitácora ---')
const sellerList = await call('/api/seller/disputes', { token: seller })
check('el vendedor ve las suyas', sellerList.data.total >= 3, true)
check(
  'y solo las suyas',
  sellerList.data.items.every((d) => d.seller.slug === `dis-${RUN}`),
  true,
)
check('el admin las ve todas', (await call('/api/admin/disputes', { token: admin })).data.total >= 3, true)
check(
  'un vendedor no entra a la lista de admin',
  (await call('/api/admin/disputes', { token: seller })).status,
  403,
)
check(
  'la bitácora registró abrir y resolver',
  psql(`SELECT count(*) FROM audit_logs WHERE action IN ('dispute.opened','dispute.resolved','dispute.withdrawn') AND created_at > now() - interval '10 minutes'`) >= 6,
  true,
)

psql(`DELETE FROM payouts WHERE seller_id IN (SELECT id FROM sellers WHERE slug = 'dis-${RUN}')`)
psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'dis${RUN}%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'dis${RUN}%@x.mx'`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
