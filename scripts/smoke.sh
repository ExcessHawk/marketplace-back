#!/usr/bin/env bash
set -uo pipefail

BACKEND="/c/Users/alfredo/Desktop/veloce-ts-proyecto/proyectos/02-marketplace/backend"
API="http://localhost:3102"

RUN_ID=$(date +%s)
export PATH="$PATH:$HOME/.bun/bin"

cd "$BACKEND" || exit 1
bun run src/index.ts > /tmp/mkt-api.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  if curl -fsS "$API/health" >/dev/null 2>&1; then break; fi
  curl -fsS "$API/health" >/dev/null 2>&1
done

echo "### 0. limpiar lo que dejaron corridas anteriores"
docker exec marketplace_postgres psql -U postgres -d marketplace -qtAc   "DELETE FROM users WHERE email LIKE 'vendedor%@tonala.mx' OR email LIKE 'intruso%@x.mx'"   | sed 's/^/usuarios de prueba borrados: /'

echo "### 1. health"
curl -s "$API/health/ready"; echo

EMAIL="vendedor$(date +%s)@tonala.mx"

echo "### 2. register (201 esperado)"
REG=$(curl -s -w '\n%{http_code}' -X POST "$API/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"una-frase-larga-123\",\"fullName\":\"Artesanias Tonala\"}")
echo "$REG" | tail -1
TOKEN=$(echo "$REG" | head -n -1 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tokens.accessToken' 2>/dev/null)

echo "### 3. password corto (422 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/auth/register" \
  -H 'Content-Type: application/json' -d '{"email":"x@y.mx","password":"corta","fullName":"X"}'

echo "### 4. /me sin token (401 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/auth/me"

echo "### 5. /me con token (200 esperado)"
curl -s "$API/api/auth/me" -H "Authorization: Bearer $TOKEN"; echo

echo "### 6. seller/products sin tienda (403 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/seller/products" -H "Authorization: Bearer $TOKEN"

echo "### 7. abrir tienda (201 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/seller/register" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"storeName\":\"Artesanias Tonala\",\"slug\":\"artesanias-tonala-$RUN_ID\",\"description\":\"Piezas de barro\"}"

echo "### 8. aprobar tienda (lo hace la plataforma a mano por ahora)"
docker exec marketplace_postgres psql -U postgres -d marketplace -qtAc \
  "UPDATE sellers SET status='active' WHERE slug='artesanias-tonala-$RUN_ID'"

echo "### 9. refresh para recoger el rol seller"
REFRESH=$(echo "$REG" | head -n -1 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tokens.refreshToken' 2>/dev/null)
NEW=$(curl -s -X POST "$API/api/auth/refresh" -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}")
TOKEN=$(echo "$NEW" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tokens.accessToken' 2>/dev/null)
echo "$NEW" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).user.roles)' 2>/dev/null

echo "### 10. crear producto (201 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/seller/products" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Pinata artesanal de siete picos\",\"slug\":\"pinata-siete-picos-$RUN_ID\",\"description\":\"Hecha a mano en Tonala, Jalisco\",\"variants\":[{\"name\":\"Grande\",\"priceCents\":38900,\"stock\":12,\"imageKeys\":[\"pinata-1.jpg\"]},{\"name\":\"Chica\",\"priceCents\":21900,\"stock\":30,\"imageKeys\":[]}]}"

echo "### 11. catalogo publico ANTES de publicar (0 esperado)"
curl -s "$API/api/products?seller=artesanias-tonala-$RUN_ID" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).total' 2>/dev/null

echo "### 12. publicar"
PID=$(docker exec marketplace_postgres psql -U postgres -d marketplace -qtAc \
  "SELECT id FROM products WHERE slug='pinata-siete-picos-$RUN_ID'" | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/seller/products/$PID/publish" \
  -H "Authorization: Bearer $TOKEN"

echo "### 13. catalogo publico DESPUES (1 esperado)"
curl -s "$API/api/products?seller=artesanias-tonala-$RUN_ID" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).total' 2>/dev/null

echo "### 14. busqueda SIN acento encuentra CON acento"
curl -s "$API/api/products?seller=artesanias-tonala-$RUN_ID&q=pinata" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));r.total+" -> "+(r.items[0]?r.items[0].title+" desde "+r.items[0].priceFromCents:"nada")' 2>/dev/null

echo "### 15. busqueda CON acento tambien"
curl -s "$API/api/products?seller=artesanias-tonala-$RUN_ID&q=pi%C3%B1ata" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).total' 2>/dev/null

echo "### 16. busqueda que no existe (0 esperado)"
curl -s "$API/api/products?seller=artesanias-tonala-$RUN_ID&q=refrigerador" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).total' 2>/dev/null

echo "### 17. detalle publico"
curl -s "$API/api/products/pinata-siete-picos-$RUN_ID" | node -pe 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));p.title+" | variantes: "+p.variants.length+" | tienda: "+p.seller.storeName' 2>/dev/null

echo "### 17b. GET de un producto propio (borrador incluido, con variantes)"
curl -s "$API/api/seller/products/$PID" -H "Authorization: Bearer $TOKEN" \
  | node -pe 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));p.title+" | status: "+p.status+" | variantes: "+p.variants.length' 2>/dev/null

echo "### 17c. PUT variantes: conserva la existente, le cambia precio y agrega otra"
VA=$(curl -s "$API/api/seller/products/$PID" -H "Authorization: Bearer $TOKEN" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).variants[0].id' 2>/dev/null)
curl -s -X PUT "$API/api/seller/products/$PID/variants" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"variants\":[{\"id\":\"$VA\",\"name\":\"Chica\",\"sku\":\"PIN-CH\",\"priceCents\":19900,\"stock\":5,\"imageKeys\":[]},{\"name\":\"Gigante\",\"sku\":\"PIN-GI\",\"priceCents\":45000,\"stock\":2,\"imageKeys\":[]}]}" \
  | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));r.variants.length+" variantes: "+r.variants.map(v=>v.name+" "+v.sku+" @"+v.priceCents).join(" | ")' 2>/dev/null

echo "### 17d. el catalogo publico ya muestra el precio nuevo (19900 esperado)"
curl -s "$API/api/products?seller=artesanias-tonala-$RUN_ID&q=pinata" \
  | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));r.items[0]?String(r.items[0].priceFromCents):"nada"' 2>/dev/null

echo "### 17e. INTERCAMBIO de skus en una sola llamada (el indice unico parcial no debe reventar)"
IDS=$(curl -s "$API/api/seller/products/$PID" -H "Authorization: Bearer $TOKEN" \
  | node -pe 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")).variants;v[0].id+" "+v[1].id' 2>/dev/null)
VA=$(echo "$IDS" | cut -d' ' -f1); VB=$(echo "$IDS" | cut -d' ' -f2)
curl -s -X PUT "$API/api/seller/products/$PID/variants" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"variants\":[{\"id\":\"$VA\",\"name\":\"Chica\",\"sku\":\"PIN-GI\",\"priceCents\":19900,\"stock\":5,\"imageKeys\":[]},{\"id\":\"$VB\",\"name\":\"Gigante\",\"sku\":\"PIN-CH\",\"priceCents\":45000,\"stock\":2,\"imageKeys\":[]}]}" \
  | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));r.variants?r.variants.map(v=>v.name+"="+v.sku).join(" | "):"ERROR: "+(r.detail||r.error)' 2>/dev/null

echo "### 17f. quitar una variante la borra en suave (1 viva esperada)"
curl -s -X PUT "$API/api/seller/products/$PID/variants" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"variants\":[{\"id\":\"$VA\",\"name\":\"Chica\",\"sku\":\"PIN-GI\",\"priceCents\":19900,\"stock\":5,\"imageKeys\":[]}]}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).variants.length+" viva(s)" ' 2>/dev/null
docker exec marketplace_postgres psql -U postgres -d marketplace -qtAc \
  "SELECT count(*)||' fila(s) en total, '||count(*) FILTER (WHERE deleted_at IS NOT NULL)||' borrada(s) en suave' FROM variants WHERE product_id='$PID'"

echo "### 17g. dejar el producto sin variantes (422 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$API/api/seller/products/$PID/variants" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"variants":[]}'

echo "### 18. AISLAMIENTO: otro vendedor no puede tocar este producto (404 esperado)"
EMAIL2="intruso$(date +%s)@x.mx"
R2=$(curl -s -X POST "$API/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"otra-frase-larga-456\",\"fullName\":\"Intruso\"}")
T2=$(echo "$R2" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tokens.accessToken' 2>/dev/null)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/seller/register" \
  -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' \
  -d "{\"storeName\":\"Tienda Intrusa\",\"slug\":\"tienda-intrusa-$RUN_ID\"}" >/dev/null
docker exec marketplace_postgres psql -U postgres -d marketplace -qtAc \
  "UPDATE sellers SET status='active' WHERE slug='tienda-intrusa-$RUN_ID'" >/dev/null
RF2=$(echo "$R2" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tokens.refreshToken' 2>/dev/null)
T2=$(curl -s -X POST "$API/api/auth/refresh" -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$RF2\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tokens.accessToken' 2>/dev/null)
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$API/api/seller/products/$PID" \
  -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d '{"title":"Secuestrado"}'

echo "### 18b. AISLAMIENTO: tampoco puede LEER el producto ajeno (404 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/seller/products/$PID" \
  -H "Authorization: Bearer $T2"

echo "### 18c. AISLAMIENTO: tampoco puede reemplazar sus variantes (404 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$API/api/seller/products/$PID/variants" \
  -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' \
  -d '{"variants":[{"name":"Robada","priceCents":1,"stock":0,"imageKeys":[]}]}'

echo "### 19. logout invalida el access token de inmediato"
curl -s -o /dev/null -w 'logout: %{http_code}\n' -X POST "$API/api/auth/logout" -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w 'me despues de logout: %{http_code}\n' "$API/api/auth/me" -H "Authorization: Bearer $TOKEN"

echo "### 20. slug duplicado (409 esperado)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/seller/register" \
  -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' \
  -d "{\"storeName\":\"Copia\",\"slug\":\"artesanias-tonala-$RUN_ID\"}"

echo "### openapi"
curl -s "$API/openapi.json" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));Object.keys(s.paths).length+" rutas documentadas"' 2>/dev/null
