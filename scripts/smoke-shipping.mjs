import { execFileSync } from 'node:child_process'

const API = 'http://localhost:3102'
const RUN = Date.now()
const PASSWORD = 'frase-larga-de-prueba-123'

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
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

const results = []
function check(label, actual, expected) {
  const pass = String(actual) === String(expected)
  results.push(pass)
  console.log(
    `${pass ? 'OK ' : 'XX '} ${label.padEnd(60)} ${actual}${pass ? '' : `  (esperaba ${expected})`}`,
  )
}

psql(`DELETE FROM users WHERE email LIKE 'envio%@x.mx'`)

const SELLER_A = `envio${RUN}a@x.mx`
const SELLER_B = `envio${RUN}b@x.mx`
const BUYER = `envio${RUN}c@x.mx`

async function makeSeller(email, slug, storeName, productSlug, title, priceCents, weightGrams) {
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, fullName: storeName },
  })
  await call('/api/seller/register', {
    method: 'POST',
    token: reg.data.tokens.accessToken,
    body: { storeName, slug },
  })
  psql(`UPDATE sellers SET status='active' WHERE slug='${slug}'`)
  const session = await call('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: reg.data.tokens.refreshToken },
  })
  const token = session.data.tokens.accessToken
  const product = await call('/api/seller/products', {
    method: 'POST',
    token,
    body: {
      title,
      slug: productSlug,
      variants: [{ name: 'Única', priceCents, stock: 20, weightGrams, imageKeys: [] }],
    },
  })
  await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token })
  return { token, variantId: product.data.variants[0].id, slug }
}

const a = await makeSeller(SELLER_A, `env-a-${RUN}`, 'Envíos A', `cazuela-${RUN}`, 'Cazuela', 30000, 2300)
const b = await makeSeller(SELLER_B, `env-b-${RUN}`, 'Envíos B', `servilleta-${RUN}`, 'Servilleta bordada', 15000, 120)

const buyerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: BUYER, password: PASSWORD, fullName: 'Compradora Envíos' },
})
const buyer = buyerReg.data.tokens.accessToken

console.log('\n--- tarifas del vendedor ---')
check('al inicio no hay tarifas', (await call('/api/seller/shipping', { token: a.token })).data.rates.length, 0)

check(
  'una tarifa local sin nacional se rechaza',
  (await call('/api/seller/shipping', {
    method: 'PUT',
    token: a.token,
    body: { rates: [{ zone: 'local', baseCents: 5000, perKgCents: 0 }] },
  })).status,
  422,
)
check(
  'dos tarifas de la misma zona se rechazan',
  (await call('/api/seller/shipping', {
    method: 'PUT',
    token: a.token,
    body: {
      rates: [
        { zone: 'nacional', baseCents: 9900, perKgCents: 0 },
        { zone: 'nacional', baseCents: 5000, perKgCents: 0 },
      ],
    },
  })).status,
  422,
)

const saved = await call('/api/seller/shipping', {
  method: 'PUT',
  token: a.token,
  body: { rates: [{ zone: 'nacional', baseCents: 9900, perKgCents: 2500, freeOverCents: 100000 }] },
})
check('guardar una nacional funciona', saved.data.rates.length, 1)
check('con su base', saved.data.rates[0].baseCents, 9900)
check('y su umbral de envío gratis', saved.data.rates[0].freeOverCents, 100000)

const replaced = await call('/api/seller/shipping', {
  method: 'PUT',
  token: a.token,
  body: {
    rates: [
      { zone: 'nacional', baseCents: 9900, perKgCents: 2500, freeOverCents: 100000 },
      { zone: 'local', baseCents: 4000, perKgCents: 0 },
    ],
  },
})
check('reemplazar deja exactamente dos', replaced.data.rates.length, 2)
check(
  'y la anterior quedó borrada en suave, no duplicada',
  psql(`SELECT count(*) FROM shipping_rates r JOIN sellers s ON s.id=r.seller_id WHERE s.slug='env-a-${RUN}' AND r.deleted_at IS NULL`),
  2,
)

console.log('\n--- el carrito usa las tarifas ---')
await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 1 } })
let cart = await call('/api/cart', { token: buyer })
let groupA = cart.data.groups.find((g) => g.seller.slug === `env-a-${RUN}`)

check('el peso del grupo sale de las variantes', groupA.weightGrams, 2300)
check('envío = base + kilos redondeados hacia arriba x perKg', groupA.shippingCents, 9900 + 3 * 2500)
check('el total suma producto y envío', cart.data.totalCents, 30000 + 17400)
check('nadie quedó sin tarifa', cart.data.hasUnconfiguredShipping, false)
check('y dice cuánto falta para el envío gratis', groupA.missingForFreeCents, 70000)

console.log('\n--- envío gratis al pasar el umbral ---')
const lineA = groupA.lines[0]
await call(`/api/cart/items/${lineA.id}`, { method: 'PATCH', token: buyer, body: { quantity: 4 } })
cart = await call('/api/cart', { token: buyer })
groupA = cart.data.groups.find((g) => g.seller.slug === `env-a-${RUN}`)
check('al pasar el umbral el envío es 0', groupA.shippingCents, 0)
check('y ya no falta nada', groupA.missingForFreeCents, 0)
check('el total es solo el producto', cart.data.totalCents, 120000)

console.log('\n--- un vendedor sin tarifa ---')
await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: b.variantId, quantity: 1 } })
cart = await call('/api/cart', { token: buyer })
const groupB = cart.data.groups.find((g) => g.seller.slug === `env-b-${RUN}`)
check('su envío es null, no 0', groupB.shippingCents, null)
check('el carrito lo marca', cart.data.hasUnconfiguredShipping, true)
check('y el total NO lo cuenta como gratis', cart.data.totalCents, 120000 + 15000)

await call('/api/seller/shipping', {
  method: 'PUT',
  token: b.token,
  body: { rates: [{ zone: 'nacional', baseCents: 5000, perKgCents: 1000 }] },
})
cart = await call('/api/cart', { token: buyer })
check(
  'al configurarla, 120 g redondean a 1 kg',
  cart.data.groups.find((g) => g.seller.slug === `env-b-${RUN}`).shippingCents,
  6000,
)
check('y ya nadie queda sin tarifa', cart.data.hasUnconfiguredShipping, false)

console.log('\n--- líneas bloqueadas no pagan envío ---')
psql(`UPDATE variants SET stock = 0 WHERE id = '${b.variantId}'`)
cart = await call('/api/cart', { token: buyer })
check(
  'un grupo agotado no cobra envío',
  cart.data.groups.find((g) => g.seller.slug === `env-b-${RUN}`).shippingCents,
  null,
)
check('y el total vuelve a ser el del otro vendedor', cart.data.totalCents, 120000)

console.log('\n--- aislamiento ---')
check(
  'un comprador sin tienda no puede poner tarifas',
  (await call('/api/seller/shipping', {
    method: 'PUT',
    token: buyer,
    body: { rates: [{ zone: 'nacional', baseCents: 1, perKgCents: 0 }] },
  })).status,
  403,
)
check('ni leerlas', (await call('/api/seller/shipping', { token: buyer })).status, 403)

psql(`DELETE FROM users WHERE email IN ('${SELLER_A}','${SELLER_B}','${BUYER}')`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
