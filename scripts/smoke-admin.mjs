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

const cli = (args) => {
  try {
    return {
      ok: true,
      out: execFileSync('bun', ['run', 'scripts/admin.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    return { ok: false, out: (error.stdout ?? '') + (error.stderr ?? '') }
  }
}

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
  console.log(`${pass ? 'OK ' : 'XX '} ${label.padEnd(62)} ${actual}${pass ? '' : `  (esperaba ${expected})`}`)
}

psql(`DELETE FROM users WHERE email LIKE 'opera%@admin.mx' OR email LIKE 'tiendita%@x.mx'`)

const OPERATOR = `opera${RUN}@admin.mx`
const OPERATOR2 = `opera${RUN}b@admin.mx`
const SELLER = `tiendita${RUN}@x.mx`

console.log('\n--- CLI ---')
await call('/api/auth/register', {
  method: 'POST',
  body: { email: OPERATOR, password: PASSWORD, fullName: 'Operador Uno' },
})

check('grant sin --yes se niega', cli(['grant', OPERATOR]).ok, false)
check('la cuenta sigue sin ser admin', psql(`SELECT is_platform_admin FROM users WHERE email='${OPERATOR}'`), 'f')
check('grant --yes promueve', cli(['grant', OPERATOR, '--yes']).ok, true)
check('la columna quedó en true', psql(`SELECT is_platform_admin FROM users WHERE email='${OPERATOR}'`), 't')
check('grant repetido es idempotente', cli(['grant', OPERATOR, '--yes']).ok, true)
const parked = psql(
  `SELECT coalesce(string_agg(email, ','), '') FROM users WHERE is_platform_admin AND email <> '${OPERATOR}'`,
)
if (parked) {
  psql(`UPDATE users SET is_platform_admin = false WHERE email IN ('${parked.split(',').join("','")}')`)
}
check('revoke del único admin se niega', cli(['revoke', OPERATOR, '--yes']).ok, false)
check('y sigue siendo admin', psql(`SELECT is_platform_admin FROM users WHERE email='${OPERATOR}'`), 't')
if (parked) {
  psql(`UPDATE users SET is_platform_admin = true WHERE email IN ('${parked.split(',').join("','")}')`)
}

console.log('\n--- sesión ---')
const adminLogin = await call('/api/auth/login', {
  method: 'POST',
  body: { email: OPERATOR, password: PASSWORD },
})
const adminToken = adminLogin.data.tokens.accessToken
check('login trae el rol admin', JSON.stringify(adminLogin.data.user.roles), '["buyer","admin"]')

console.log('\n--- cola de revisión ---')
const sellerReg = await call('/api/auth/register', {
  method: 'POST',
  body: { email: SELLER, password: PASSWORD, fullName: 'Dueña de Tiendita' },
})
let sellerToken = sellerReg.data.tokens.accessToken
const sellerRefresh = sellerReg.data.tokens.refreshToken

await call('/api/seller/register', {
  method: 'POST',
  token: sellerToken,
  body: { storeName: 'Tiendita de la esquina', slug: `tiendita-${RUN}` },
})

const pendingBlocked = await call('/api/seller/me', { token: sellerToken })
check('tienda pendiente: el panel contesta 403', pendingBlocked.status, 403)

const queue = await call('/api/admin/sellers?status=pending', { token: adminToken })
const mine = queue.data.items.find((s) => s.slug === `tiendita-${RUN}`)
check('aparece en la cola de pendientes', Boolean(mine), true)
check('la cola trae el correo del dueño', mine?.owner.email, SELLER)
check('y el conteo de productos', mine?.productCount, 0)

const notAdmin = await call('/api/admin/sellers', { token: sellerToken })
check('un vendedor no entra a /api/admin', notAdmin.status, 403)
const anon = await call('/api/admin/sellers')
check('sin token tampoco', anon.status, 401)

console.log('\n--- aprobar ---')
const approved = await call(`/api/admin/sellers/${mine.id}/approve`, {
  method: 'POST',
  token: adminToken,
  body: { note: 'Documentos en orden' },
})
check('aprobar deja la tienda activa', approved.data.status, 'active')
check('aprobar de nuevo da 409', (await call(`/api/admin/sellers/${mine.id}/approve`, { method: 'POST', token: adminToken, body: {} })).status, 409)

const refreshed = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: sellerRefresh } })
sellerToken = refreshed.data.tokens.accessToken
check('tras refrescar, la vendedora tiene el rol', JSON.stringify(refreshed.data.user.roles), '["buyer","seller"]')
check('y el panel ya abre', (await call('/api/seller/me', { token: sellerToken })).status, 200)

console.log('\n--- suspender ---')
check(
  'motivo corto se rechaza',
  (await call(`/api/admin/sellers/${mine.id}/suspend`, { method: 'POST', token: adminToken, body: { reason: 'no' } })).status,
  422,
)
const suspended = await call(`/api/admin/sellers/${mine.id}/suspend`, {
  method: 'POST',
  token: adminToken,
  body: { reason: 'Vende piezas que no son artesanía mexicana' },
})
check('suspender guarda el motivo', suspended.data.statusReason, 'Vende piezas que no son artesanía mexicana')

const afterSuspend = await call('/api/seller/me', { token: sellerToken })
check('con el MISMO token el panel ya cierra', afterSuspend.status, 403)
check('y el 403 dice por qué', afterSuspend.data.detail, 'Tu tienda está suspendida: Vende piezas que no son artesanía mexicana')
check('la tienda sale del catálogo público', (await call(`/api/sellers/tiendita-${RUN}`)).status, 404)

console.log('\n--- bitácora ---')
const audit = await call(`/api/admin/audit?recordId=${mine.id}`, { token: adminToken })
const actions = audit.data.items.map((e) => e.action).sort().join(',')
check('quedaron las dos acciones', actions, 'seller.approved,seller.suspended')
check('con el admin que las hizo', audit.data.items[0]?.actor?.email, OPERATOR)
check('y el motivo en los valores nuevos', audit.data.items[0]?.newValues?.reason, 'Vende piezas que no son artesanía mexicana')

console.log('\n--- quitar admin surte efecto de inmediato ---')
await call('/api/auth/register', {
  method: 'POST',
  body: { email: OPERATOR2, password: PASSWORD, fullName: 'Operador Dos' },
})
cli(['grant', OPERATOR2, '--yes'])
check('ahora hay dos admins', cli(['list']).out.includes(OPERATOR2), true)
check('revoke del primero procede', cli(['revoke', OPERATOR, '--yes']).ok, true)

const afterRevoke = await call('/api/admin/sellers', { token: adminToken })
check('su token viejo YA no abre /api/admin', afterRevoke.status, 403)
check('porque cada handler revalida contra la base', afterRevoke.data.detail, 'Esta cuenta no es administrador de plataforma')
const reLogin = await call('/api/auth/login', { method: 'POST', body: { email: OPERATOR, password: PASSWORD } })
check('y al volver a entrar ya no trae el rol', JSON.stringify(reLogin.data.user.roles), '["buyer"]')

psql(`DELETE FROM users WHERE email IN ('${OPERATOR}','${OPERATOR2}','${SELLER}')`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} aserciones`)
process.exit(passed === results.length ? 0 : 1)
