/**
 * Subida de imágenes de producto.
 *
 * Lo que se vigila aquí no es que una foto suba, sino que no suba cualquier
 * cosa: el tipo se decide por los primeros bytes, un SVG no entra, y la ruta
 * de descarga no deja salir del directorio.
 */
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

async function call(path, options = {}) {
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
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

async function subir(bytes, { token, filename = 'foto.png', type = 'image/png' } = {}) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), filename)
  const res = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data }
}

const results = []
function check(label, actual, expected) {
  const pass = String(actual) === String(expected)
  results.push(pass)
  console.log(
    `${pass ? 'OK ' : 'XX '} ${label.padEnd(62)} ${actual}${pass ? '' : `  (esperaba ${expected})`}`,
  )
}

// ── material de prueba ────────────────────────────────────────────────────────

/** PNG de 1x1 transparente, el más chico que existe. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0x20), 0xff, 0xd9])
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'utf8',
)
const TEXTO = Buffer.from('esto no es una imagen aunque se llame .png', 'utf8')
/** Pasa el límite del contrato pero no el del framework: lo corta el handler. */
const GRANDE = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1024, 0)])
/** Pasa los dos: lo corta el framework antes de que corra nada. */
const ENORME = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024, 0)])

// ── cuentas ───────────────────────────────────────────────────────────────────

psql(`DELETE FROM users WHERE email LIKE 'subida%@x.mx'`)

const SELLER = `subida${RUN}a@x.mx`
const BUYER = `subida${RUN}b@x.mx`

const regVendedor = await call('/api/auth/register', {
  method: 'POST',
  body: { email: SELLER, password: PASSWORD, fullName: 'Tienda de fotos' },
})
await call('/api/seller/register', {
  method: 'POST',
  token: regVendedor.data.tokens.accessToken,
  body: { storeName: 'Tienda de fotos', slug: `fotos-${RUN}` },
})
psql(`UPDATE sellers SET status='active' WHERE slug='fotos-${RUN}'`)
const vendedor = (
  await call('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: regVendedor.data.tokens.refreshToken },
  })
).data.tokens.accessToken

const comprador = (
  await call('/api/auth/register', {
    method: 'POST',
    body: { email: BUYER, password: PASSWORD, fullName: 'Compradora' },
  })
).data.tokens.accessToken

// ── quién puede subir ─────────────────────────────────────────────────────────

check('sin sesión no se sube', (await subir(PNG)).status, 401)
check('un comprador tampoco', (await subir(PNG, { token: comprador })).status, 403)

// ── qué se acepta ─────────────────────────────────────────────────────────────

const png = await subir(PNG, { token: vendedor })
check('el vendedor sube un PNG', png.status, 200)
check('la clave no deja elegir el nombre', /^[0-9a-f]{32}\.png$/.test(png.data?.key ?? ''), true)
check('la url cuelga de la API', png.data?.url, `/api/uploads/${png.data?.key}`)

const jpeg = await subir(JPEG, { token: vendedor, filename: 'x.png', type: 'image/png' })
check('un JPEG disfrazado de PNG se guarda como lo que es', jpeg.data?.key?.endsWith('.jpg'), true)

const svg = await subir(SVG, { token: vendedor, filename: 'logo.svg', type: 'image/svg+xml' })
check('un SVG se rechaza (puede traer script)', svg.status, 400)

const texto = await subir(TEXTO, { token: vendedor, filename: 'foto.png', type: 'image/png' })
check('un texto con nombre de imagen se rechaza', texto.status, 400)

const vacio = await subir(Buffer.alloc(0), { token: vendedor })
check('un archivo vacío se rechaza', vacio.status, 400)

const grande = await subir(GRANDE, { token: vendedor })
check('pasarse del límite por poco lo rechaza el handler', grande.status, 400)

const enorme = await subir(ENORME, { token: vendedor })
check('pasarse por mucho lo corta el framework antes', enorme.status, 413)

const sinCampo = await (async () => {
  const form = new FormData()
  form.append('otro', new Blob([PNG], { type: 'image/png' }), 'foto.png')
  const res = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${vendedor}` },
    body: form,
  })
  return res.status
})()
check('sin el campo "file" se rechaza', sinCampo, 400)

const sinMultipart = await fetch(`${API}/api/uploads`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${vendedor}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ file: 'nope' }),
})
check('un cuerpo JSON se rechaza', sinMultipart.status, 400)

// ── cómo se entrega ───────────────────────────────────────────────────────────

const descarga = await fetch(`${API}${png.data.url}`)
check('la imagen se sirve sin token', descarga.status, 200)
check('con su tipo real', descarga.headers.get('content-type')?.includes('image/png'), true)
check('y sin dejar que el navegador adivine', descarga.headers.get('x-content-type-options'), 'nosniff')
check('el cuerpo pesa lo mismo que el original', (await descarga.arrayBuffer()).byteLength, PNG.length)

check(
  'una clave inventada da 404',
  (await fetch(`${API}/api/uploads/${'a'.repeat(32)}.png`)).status,
  404,
)
check(
  'una clave con otra forma da 404',
  (await fetch(`${API}/api/uploads/notas.txt`)).status,
  404,
)
check(
  'no se puede salir del directorio',
  (await fetch(`${API}/api/uploads/..%2F..%2F.env`)).status,
  404,
)

// ── la imagen llega al catálogo ───────────────────────────────────────────────

const producto = await call('/api/seller/products', {
  method: 'POST',
  token: vendedor,
  body: {
    title: 'Jarrón con foto',
    slug: `jarron-foto-${RUN}`,
    variants: [{ name: 'Única', priceCents: 25000, stock: 3, imageKeys: [png.data.url] }],
  },
})
await call(`/api/seller/products/${producto.data.id}/publish`, { method: 'POST', token: vendedor })

const publico = await call(`/api/products/jarron-foto-${RUN}`)
check('el catálogo devuelve la imagen subida', publico.data?.imageKey, png.data.url)

psql(`DELETE FROM users WHERE email IN ('${SELLER}','${BUYER}')`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
