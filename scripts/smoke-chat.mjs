import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const API = 'http://localhost:3102'
const WS = 'ws://localhost:3102'
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

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const inbox = []
    const timer = setTimeout(() => reject(new Error('timeout abriendo el socket')), 5000)

    socket.addEventListener('message', (event) => {
      try {
        inbox.push(JSON.parse(event.data))
      } catch {
        inbox.push({ raw: event.data })
      }
    })
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        socket,
        inbox,
        send: (data) => socket.send(JSON.stringify(data)),
        waitFor: async (predicate, ms = 4000) => {
          const deadline = Date.now() + ms
          while (Date.now() < deadline) {
            const found = inbox.find(predicate)
            if (found) return found
            await sleep(60)
          }
          return null
        },
        close: () => socket.close(),
      })
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('el socket falló al abrir'))
    })
  })
}

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'cha%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'cha%@x.mx'`)

const sellerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `cha${RUN}v@x.mx`, password: PASSWORD, fullName: 'Vendedor Chat' },
})
await call('/api/seller/register', {
  method: 'POST',
  token: sellerReg.data.tokens.accessToken,
  body: { storeName: 'Tienda Chat', slug: `cha-${RUN}` },
})
psql(`UPDATE sellers SET status='active' WHERE slug='cha-${RUN}'`)
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
    title: 'Comal de barro',
    slug: `comal-${RUN}`,
    variants: [{ name: 'Única', priceCents: 40000, stock: 20, weightGrams: 500, imageKeys: [] }],
  },
})
await call(`/api/seller/products/${product.data.id}/publish`, { method: 'POST', token: seller })

const buyerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `cha${RUN}c@x.mx`, password: PASSWORD, fullName: 'Compradora Chat' },
})
const buyer = buyerReg.data.tokens.accessToken
const otherReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: `cha${RUN}o@x.mx`, password: PASSWORD, fullName: 'Ajeno Chat' },
})
const other = otherReg.data.tokens.accessToken

const address = await call('/api/addresses', {
  method: 'POST',
  token: buyer,
  body: {
    recipient: 'Ana', phone: '3312345678', street: 'Hidalgo 45',
    neighborhood: 'Centro', city: 'Guadalajara', state: 'Jalisco', postalCode: '44100',
  },
})

await call('/api/cart/items', {
  method: 'POST', token: buyer, body: { variantId: product.data.variants[0].id, quantity: 1 },
})
const placed = await call('/api/checkout', {
  method: 'POST', token: buyer, body: { addressId: address.data.id },
})
const suborderId = placed.data.order.suborders[0].id

console.log('\n--- antes de pagar ---')
check(
  'el chat no abre si el pedido no está pagado',
  (await call(`/api/chat/${suborderId}`, { token: buyer })).status,
  403,
)

await webhook({
  id: `evt_${RUN}_chat`,
  type: 'payment_intent.succeeded',
  data: { object: { id: placed.data.payment.intentId } },
})

console.log('\n--- quién entra ---')
const opened = await call(`/api/chat/${suborderId}`, { token: buyer })
check('la compradora sí', opened.status, 200)
check('su rol es comprador', opened.data.myRole, 'buyer')
check('ve el nombre de la tienda', opened.data.counterpartName, 'Tienda Chat')
check('el vendedor también', (await call(`/api/chat/${suborderId}`, { token: seller })).data.myRole, 'seller')
check('un tercero no', (await call(`/api/chat/${suborderId}`, { token: other })).status, 404)
check('sin token tampoco', (await call(`/api/chat/${suborderId}`)).status, 401)
check(
  'una sola conversación por subpedido',
  psql(`SELECT count(*) FROM conversations WHERE suborder_id='${suborderId}'`),
  1,
)

console.log('\n--- boletos para el socket ---')
check(
  'un tercero no obtiene boleto',
  (await call(`/api/chat/${suborderId}/ticket`, { method: 'POST', token: other })).status,
  404,
)
const ticketBuyer = await call(`/api/chat/${suborderId}/ticket`, { method: 'POST', token: buyer })
check('la compradora sí', ticketBuyer.status, 200)
check('y trae la URL del socket', ticketBuyer.data.url.startsWith(`/ws/chat/${suborderId}?ticket=`), true)

console.log('\n--- el socket ---')
let rejected = false
try {
  const bad = await openSocket(`${WS}/ws/chat/${suborderId}?ticket=no-existe`)
  const err = await bad.waitFor((m) => m.type === 'error', 1500)
  rejected = Boolean(err) || bad.socket.readyState !== 1
  bad.close()
} catch {
  rejected = true
}
check('un boleto inválido no entra', rejected, true)

const ticketSeller = await call(`/api/chat/${suborderId}/ticket`, { method: 'POST', token: seller })
const buyerSocket = await openSocket(`${WS}${ticketBuyer.data.url}`)
const sellerSocket = await openSocket(`${WS}${ticketSeller.data.url}`)

check('la compradora recibe ready', Boolean(await buyerSocket.waitFor((m) => m.type === 'ready')), true)
check('el vendedor también', Boolean(await sellerSocket.waitFor((m) => m.type === 'ready')), true)

buyerSocket.send({ type: 'message', body: '¿Me lo puedes mandar envuelto para regalo?' })
const gotBySeller = await sellerSocket.waitFor(
  (m) => m.type === 'message' && m.message?.body?.includes('envuelto'),
)
check('el mensaje de ella llega al vendedor en vivo', Boolean(gotBySeller), true)
check('con el rol de quien lo mandó', gotBySeller?.message?.senderRole, 'buyer')

sellerSocket.send({ type: 'message', body: 'Claro, va con papel de china.' })
check(
  'y la respuesta le llega a ella',
  Boolean(await buyerSocket.waitFor((m) => m.type === 'message' && m.message?.body?.includes('papel de china'))),
  true,
)

check(
  'un cuerpo vacío se rechaza',
  Boolean(
    (buyerSocket.send({ type: 'message', body: '' }), await buyerSocket.waitFor((m) => m.error, 2000)),
  ),
  true,
)

console.log('\n--- quedan guardados ---')
await sleep(400)
const history = await call(`/api/chat/${suborderId}`, { token: buyer })
check('el historial trae los dos', history.data.messages.length, 2)
check('marcados por rol', history.data.messages.map((m) => m.senderRole).join(','), 'buyer,seller')
check('el suyo sale como propio', history.data.messages[0].isMine, true)
check('y el del vendedor no', history.data.messages[1].isMine, false)
check('con uno sin leer para ella', history.data.unreadCount, 1)

console.log('\n--- leídos ---')
check('marcar leído devuelve cuántos', (await call(`/api/chat/${suborderId}/read`, { method: 'POST', token: buyer })).data.read, 1)
check(
  'y ya no quedan sin leer',
  (await call(`/api/chat/${suborderId}`, { token: buyer })).data.unreadCount,
  0,
)
check(
  'el vendedor sigue con el suyo sin leer',
  (await call(`/api/chat/${suborderId}`, { token: seller })).data.unreadCount,
  1,
)

console.log('\n--- bandeja y contador ---')
const inbox = await call('/api/chat', { token: seller })
check('el vendedor ve la conversación', inbox.data.items.length, 1)
check('con el último mensaje', inbox.data.items[0].lastMessageBody.includes('papel de china'), true)
check('y su contador', (await call('/api/chat/unread', { token: seller })).data.total, 1)
check('el tercero no ve ninguna', (await call('/api/chat', { token: other })).data.items.length, 0)

console.log('\n--- REST también publica en el socket ---')
const viaRest = await call(`/api/chat/${suborderId}`, {
  method: 'POST', token: seller, body: { body: 'Ya va en camino, te paso la guía.' },
})
check('enviar por REST devuelve 201', viaRest.status, 201)
check(
  'y el socket de ella lo recibe igual',
  Boolean(await buyerSocket.waitFor((m) => m.type === 'message' && m.message?.body?.includes('en camino'))),
  true,
)

buyerSocket.close()
sellerSocket.close()

psql(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE 'cha${RUN}%@x.mx')`)
psql(`DELETE FROM users WHERE email LIKE 'cha${RUN}%@x.mx'`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
