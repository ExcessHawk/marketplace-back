import { Client } from 'pg'

const DOMAIN = '@demo.marketplace.mx'
const FORCE = process.argv.includes('--force')

if (process.env.DEMO_MODE !== 'true' && !FORCE) {
  console.error('DEMO_MODE no está en true. Este script solo corre contra la base de demostración.')
  console.error('Si de verdad quieres correrlo aquí, pasa --force.')
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Corre con bun, que lee el .env solo.')
  process.exit(1)
}

const client = new Client({ connectionString: DATABASE_URL })
await client.connect()

const psql = async (sql) => {
  const { rows } = await client.query(sql)
  if (!rows.length) return ''
  const first = Object.values(rows[0])[0]
  return first === null || first === undefined ? '' : String(first)
}

const demoUsers = `(SELECT id FROM users WHERE email LIKE '%${DOMAIN}' AND is_demo = true)`

const before = await psql(`SELECT count(*) FROM users WHERE email LIKE '%${DOMAIN}' AND is_demo = true`)
if (before === '0') {
  console.error('No hay cuentas de demostración. Siembra primero con demo:seed.')
  process.exit(1)
}

const outsiders = await psql(`
  SELECT count(*) FROM users
   WHERE is_demo = true AND email NOT LIKE '%${DOMAIN}'`)
if (outsiders !== '0') {
  console.error(`${outsiders} cuenta(s) marcadas is_demo fuera del dominio de demostración.`)
  console.error('Eso no debería pasar. Revísalas antes de borrar nada.')
  process.exit(1)
}

console.log(`Reiniciando la demostración (${before} cuentas)`)

// payment_events no se toca: es el registro de idempotencia del webhook. Borrarlo
// dejaría pasar de nuevo un evento viejo.
const steps = [
  [
    'mensajes del chat',
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT c.id FROM conversations c
         JOIN suborders s ON s.id = c.suborder_id
         JOIN orders o    ON o.id = s.order_id
        WHERE o.buyer_id IN ${demoUsers})`,
  ],
  [
    'conversaciones',
    `DELETE FROM conversations WHERE suborder_id IN (
       SELECT s.id FROM suborders s JOIN orders o ON o.id = s.order_id
        WHERE o.buyer_id IN ${demoUsers})`,
  ],
  [
    'mensajes de aclaraciones',
    `DELETE FROM dispute_messages WHERE dispute_id IN (
       SELECT d.id FROM disputes d
         JOIN suborders s ON s.id = d.suborder_id
         JOIN orders o    ON o.id = s.order_id
        WHERE o.buyer_id IN ${demoUsers})`,
  ],
  [
    'aclaraciones',
    `DELETE FROM disputes WHERE suborder_id IN (
       SELECT s.id FROM suborders s JOIN orders o ON o.id = s.order_id
        WHERE o.buyer_id IN ${demoUsers})`,
  ],
  ['reseñas', `DELETE FROM reviews WHERE buyer_id IN ${demoUsers}`],
  [
    'renglones de subpedido',
    `DELETE FROM suborder_items WHERE suborder_id IN (
       SELECT s.id FROM suborders s JOIN orders o ON o.id = s.order_id
        WHERE o.buyer_id IN ${demoUsers})`,
  ],
  [
    'pagos al vendedor',
    `DELETE FROM payouts WHERE seller_id IN (SELECT id FROM sellers WHERE user_id IN ${demoUsers})`,
  ],
  [
    'subpedidos',
    `DELETE FROM suborders WHERE order_id IN (SELECT id FROM orders WHERE buyer_id IN ${demoUsers})`,
  ],
  ['pedidos', `DELETE FROM orders WHERE buyer_id IN ${demoUsers}`],
  [
    'líneas de carrito',
    `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id IN ${demoUsers})`,
  ],
  ['sesiones abiertas', `DELETE FROM refresh_tokens WHERE user_id IN ${demoUsers}`],
  [
    'productos que publicó un visitante',
    `UPDATE products SET deleted_at = now()
      WHERE deleted_at IS NULL
        AND slug NOT LIKE '%-demo'
        AND seller_id IN (SELECT id FROM sellers WHERE user_id IN ${demoUsers})`,
  ],
  [
    'promedios de reseña',
    `UPDATE products SET rating_avg = NULL, rating_count = 0
      WHERE seller_id IN (SELECT id FROM sellers WHERE user_id IN ${demoUsers})`,
  ],
  [
    'promedios de tienda',
    `UPDATE sellers SET rating_avg = NULL, rating_count = 0 WHERE user_id IN ${demoUsers}`,
  ],
  [
    'tiendas suspendidas por un visitante',
    `UPDATE sellers SET status = 'active', status_reason = NULL
      WHERE user_id IN ${demoUsers} AND status <> 'active'`,
  ],
  [
    'bitácora de la demostración',
    `DELETE FROM audit_logs WHERE user_id IN ${demoUsers} AND created_at < now() - interval '1 hour'`,
  ],
]

for (const [label, sql] of steps) {
  await psql(sql)
  console.log(`  limpio: ${label}`)
}

const stock = {
  'jarron-de-talavera-azul-demo': 7,
  'juego-de-tazas-barro-brunido-demo': 12,
  'pinata-de-barro-pintada-demo': 3,
  'alebrije-jaguar-demo': 4,
  'alebrije-colibri-demo': 15,
}

for (const [slug, qty] of Object.entries(stock)) {
  await psql(`
    UPDATE variants v SET stock = ${qty}
      FROM products p
     WHERE p.id = v.product_id AND p.slug = '${slug}'`)
}
console.log('  repuesto: inventario de las cinco piezas')

console.log('')
console.log('Demostración lista otra vez. Vuelve a correr demo:seed para rehacer el pedido de ejemplo.')

await client.end()
