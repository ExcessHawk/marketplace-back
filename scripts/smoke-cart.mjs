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

async function call(path, { method = 'GET', token, body } = {}, attempt = 0) {
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
    return call(path, arguments[1] ?? {}, attempt + 1)
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

psql(`DELETE FROM users WHERE email LIKE 'compra%@x.mx' OR email LIKE 'vende%carrito@x.mx'`)

const SELLER_A = `vende${RUN}acarrito@x.mx`
const SELLER_B = `vende${RUN}bcarrito@x.mx`
const BUYER = `compra${RUN}@x.mx`
const OTHER = `compra${RUN}b@x.mx`

async function makeSeller(email, slug, storeName, productSlug, title, priceCents, stock) {
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
      variants: [{ name: 'Única', priceCents, stock, imageKeys: [] }],
    },
  })
  await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token })
  return { token, productId: product.data.id, variantId: product.data.variants[0].id, slug }
}

const a = await makeSeller(SELLER_A, `tienda-a-${RUN}`, 'Tienda A', `jarra-${RUN}`, 'Jarra de barro', 25000, 5)
const b = await makeSeller(SELLER_B, `tienda-b-${RUN}`, 'Tienda B', `rebozo-${RUN}`, 'Rebozo de seda', 180000, 2)

const buyerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: BUYER, password: PASSWORD, fullName: 'Compradora' },
})
const buyer = buyerReg.data.tokens.accessToken

const otherReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: OTHER, password: PASSWORD, fullName: 'Otro Comprador' },
})
const other = otherReg.data.tokens.accessToken

console.log('\n--- básicos ---')
check('sin token el carrito contesta 401', (await call('/api/cart')).status, 401)

const empty = await call('/api/cart', { token: buyer })
check('carrito nuevo viene vacío', `${empty.data.groups.length} grupos, ${empty.data.itemCount} piezas`, '0 grupos, 0 piezas')

const added = await call('/api/cart/items', {
  method: 'POST',
  token: buyer,
  body: { variantId: a.variantId, quantity: 2 },
})
check('agregar devuelve 201', added.status, 201)
check('con el precio congelado', added.data.groups[0].lines[0].priceCentsAtAdd, 25000)
check('y el total de la línea', added.data.groups[0].lines[0].lineTotalCents, 50000)
check('y cuenta las piezas', added.data.itemCount, 2)

const again = await call('/api/cart/items', {
  method: 'POST',
  token: buyer,
  body: { variantId: a.variantId, quantity: 1 },
})
check('agregar lo mismo NO crea otra línea', again.data.groups[0].lines.length, 1)
check('sube la cantidad', again.data.groups[0].lines[0].quantity, 3)

check(
  'pasarse del stock da 409',
  (await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 50 } })).status,
  409,
)
check(
  'cantidad 0 se rechaza',
  (await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 0 } })).status,
  422,
)
check(
  'cantidad 100 se rechaza',
  (await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: b.variantId, quantity: 100 } })).status,
  422,
)

console.log('\n--- agrupado por vendedor ---')
const two = await call('/api/cart/items', {
  method: 'POST',
  token: buyer,
  body: { variantId: b.variantId, quantity: 1 },
})
check('dos vendedores son dos grupos', two.data.groups.length, 2)
check('cada grupo con su subtotal', two.data.groups.map((g) => g.subtotalCents).sort((x, y) => x - y).join(','), '75000,180000')
check('el envío es null, no 0', two.data.groups[0].shippingCents, null)
check('subtotal general', two.data.subtotalCents, 255000)

console.log('\n--- precio congelado (PROFECO) ---')
psql(`UPDATE variants SET price_cents = 39900 WHERE id = '${a.variantId}'`)

const afterChange = await call('/api/cart', { token: buyer })
const lineA = afterChange.data.groups.flatMap((g) => g.lines).find((l) => l.variantId === a.variantId)
check('el precio congelado NO cambió', lineA.priceCentsAtAdd, 25000)
check('pero sí reporta el precio vivo', lineA.currentPriceCents, 39900)
check('con la diferencia', lineA.priceDeltaCents, 14900)
check('y lo marca en el carrito', afterChange.data.hasPriceChanges, true)
check('el total sigue con el precio viejo', lineA.lineTotalCents, 75000)

psql(`UPDATE variants SET price_cents = 25000 WHERE id = '${a.variantId}'`)

console.log('\n--- aislamiento ---')
const lineId = lineA.id
check(
  'otro comprador no puede tocar esa línea (404)',
  (await call(`/api/cart/items/${lineId}`, { method: 'PATCH', token: other, body: { quantity: 1 } })).status,
  404,
)
check(
  'ni borrarla',
  (await call(`/api/cart/items/${lineId}`, { method: 'DELETE', token: other })).status,
  404,
)
check('y su carrito sigue vacío', (await call('/api/cart', { token: other })).data.itemCount, 0)

console.log('\n--- cantidad ---')
const patched = await call(`/api/cart/items/${lineId}`, {
  method: 'PATCH',
  token: buyer,
  body: { quantity: 1 },
})
check('bajar la cantidad se refleja', patched.data.groups.flatMap((g) => g.lines).find((l) => l.id === lineId).quantity, 1)
check(
  'subirla más allá del stock da 409',
  (await call(`/api/cart/items/${lineId}`, { method: 'PATCH', token: buyer, body: { quantity: 40 } })).status,
  409,
)

console.log('\n--- líneas bloqueadas ---')
psql(`UPDATE variants SET stock = 0 WHERE id = '${a.variantId}'`)
let blocked = await call('/api/cart', { token: buyer })
let line = blocked.data.groups.flatMap((g) => g.lines).find((l) => l.variantId === a.variantId)
check('sin existencias se marca out_of_stock', line.issue, 'out_of_stock')
check('y sale del subtotal', blocked.data.subtotalCents, 180000)
check('el carrito avisa que hay bloqueos', blocked.data.hasBlockers, true)

psql(`UPDATE variants SET stock = 5 WHERE id = '${a.variantId}'`)
psql(`UPDATE products SET status = 'draft' WHERE id = '${a.productId}'`)
blocked = await call('/api/cart', { token: buyer })
line = blocked.data.groups.flatMap((g) => g.lines).find((l) => l.variantId === a.variantId)
check('despublicado se marca unavailable', line.issue, 'unavailable')

psql(`UPDATE products SET status = 'published' WHERE id = '${a.productId}'`)
psql(`UPDATE sellers SET status = 'suspended' WHERE slug = 'tienda-a-${RUN}'`)
blocked = await call('/api/cart', { token: buyer })
line = blocked.data.groups.flatMap((g) => g.lines).find((l) => l.variantId === a.variantId)
check('tienda suspendida se marca store_closed', line.issue, 'store_closed')
check(
  'y ya no se puede agregar de esa tienda (404)',
  (await call('/api/cart/items', { method: 'POST', token: buyer, body: { variantId: a.variantId, quantity: 1 } })).status,
  404,
)

psql(`UPDATE sellers SET status = 'active' WHERE slug = 'tienda-a-${RUN}'`)

const lineB = blocked.data.groups.flatMap((g) => g.lines).find((l) => l.variantId === b.variantId)
await call(`/api/cart/items/${lineB.id}`, { method: 'PATCH', token: buyer, body: { quantity: 2 } })
psql(`UPDATE variants SET stock = 1 WHERE id = '${b.variantId}'`)
blocked = await call('/api/cart', { token: buyer })
line = blocked.data.groups.flatMap((g) => g.lines).find((l) => l.variantId === b.variantId)
check('pedir 2 cuando queda 1 se marca low_stock', line.issue, 'low_stock')
check('y esa línea tampoco cuenta al subtotal', blocked.data.subtotalCents, 25000)
psql(`UPDATE variants SET stock = 2 WHERE id = '${b.variantId}'`)

console.log('\n--- resumen y limpieza ---')
const summary = await call('/api/cart/summary', { token: buyer })
const full = await call('/api/cart', { token: buyer })
check('el resumen coincide con el carrito completo (piezas)', summary.data.itemCount, full.data.itemCount)
check('y en el subtotal', summary.data.subtotalCents, full.data.subtotalCents)

const removed = await call(`/api/cart/items/${lineId}`, { method: 'DELETE', token: buyer })
check('borrar quita la línea', removed.data.groups.length, 1)

const cleared = await call('/api/cart', { method: 'DELETE', token: buyer })
check('vaciar deja el carrito en cero', `${cleared.data.groups.length} grupos, ${cleared.data.itemCount} piezas`, '0 grupos, 0 piezas')

check(
  'el carrito sobrevive a cerrar sesión',
  (await call('/api/cart', { token: buyer })).status,
  200,
)

psql(`DELETE FROM users WHERE email IN ('${SELLER_A}','${SELLER_B}','${BUYER}','${OTHER}')`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
