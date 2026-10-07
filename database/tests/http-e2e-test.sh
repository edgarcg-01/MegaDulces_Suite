#!/bin/bash
# HTTP E2E test: login + customers + warehouses + pricing + inventory + orders
# Requiere API en localhost:3334 con ENABLE_MULTITENANT=true.

set -e
BASE="http://localhost:3334/api"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "  ✅ $name"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name"
    FAIL=$((FAIL+1))
  fi
}

echo "── 1. Login ──"
TOKEN=$(curl -s -X POST $BASE/auth-mt/login \
  -H "Content-Type: application/json" \
  -d '{"tenant_slug":"mega_dulces","username":"superoot","password":"superoot"}' \
  | grep -oP '"access_token":"[^"]+' | sed 's/"access_token":"//')
[ -n "$TOKEN" ] && check "auth-mt login → JWT obtenido" 0 || check "auth-mt login" 1
AUTH="Authorization: Bearer $TOKEN"

echo ""
echo "── 2. Customers ──"
LIST_CUSTOMERS=$(curl -s -H "$AUTH" "$BASE/commercial/customers?pageSize=5")
echo "$LIST_CUSTOMERS" | grep -q '"total":2[0-9]' && check "GET customers (paginado, total >= 20)" 0 || check "GET customers" 1

echo "$LIST_CUSTOMERS" | grep -q "Abarrotes" && check "List incluye nombres de testdata" 0 || check "List names" 1

# Create
CREATED=$(curl -s -X POST $BASE/commercial/customers \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"code":"HTTP-E2E-001","name":"HTTP Test Customer"}')
echo "$CREATED" | grep -q "HTTP-E2E-001" && check "POST customer creado" 0 || check "POST customer" 1
NEW_CUSTOMER_ID=$(echo "$CREATED" | grep -oP '"id":"[^"]+' | head -1 | sed 's/"id":"//')

# Update
curl -s -X PATCH $BASE/commercial/customers/$NEW_CUSTOMER_ID \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"credit_limit":99999}' | grep -q '"credit_limit":"99999' && check "PATCH customer" 0 || check "PATCH customer" 1

# Search
curl -s -H "$AUTH" "$BASE/commercial/customers?search=HTTP-E2E" | grep -q "HTTP-E2E-001" \
  && check "GET customers ?search=" 0 || check "Search customers" 1

echo ""
echo "── 3. Warehouses ──"
curl -s -H "$AUTH" $BASE/commercial/warehouses | grep -q "MD-CENTRAL" \
  && check "GET warehouses incluye MD-CENTRAL" 0 || check "GET warehouses" 1

echo ""
echo "── 4. Pricing ──"
curl -s -H "$AUTH" $BASE/commercial/price-lists | grep -q "BASE-MXN" \
  && check "GET price-lists incluye BASE-MXN" 0 || check "GET price-lists" 1

PL_ID=$(curl -s -H "$AUTH" $BASE/commercial/price-lists \
  | grep -oP '"id":"[^"]+","[^}]*"code":"BASE-MXN"' | grep -oP 'id":"[^"]+' | sed 's/id":"//')

PRICES_COUNT=$(curl -s -H "$AUTH" "$BASE/commercial/price-lists/$PL_ID/prices" \
  | grep -oP '"product_id"' | wc -l)
[ "$PRICES_COUNT" -ge "25" ] && check "Lista de prices con >= 25 productos" 0 \
  || (echo "    got: $PRICES_COUNT"; check "Lista prices" 1)

echo ""
echo "── 5. Inventory ──"
STOCK=$(curl -s -H "$AUTH" "$BASE/commercial/inventory/stock?pageSize=5")
echo "$STOCK" | grep -q '"available_quantity"' && check "GET stock incluye available_quantity" 0 \
  || check "GET stock" 1

echo ""
echo "── 6. Orders ──"
# Crear draft
WH_ID=$(curl -s -H "$AUTH" $BASE/commercial/warehouses | grep -oP '"id":"[^"]+","[^}]*"code":"MD-CENTRAL"' | grep -oP 'id":"[^"]+' | sed 's/id":"//')
CUST_ID=$(echo "$LIST_CUSTOMERS" | grep -oP '"id":"[^"]+","[^}]*"code":"TST-0002"' | grep -oP 'id":"[^"]+' | sed 's/id":"//')

ORDER=$(curl -s -X POST $BASE/commercial/orders \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"customer_id\":\"$CUST_ID\",\"warehouse_id\":\"$WH_ID\",\"notes\":\"HTTP E2E test order\"}")
echo "$ORDER" | grep -q "PD-2026-" && check "POST orders (draft) → genera code PD-2026-N" 0 \
  || (echo "    response: $ORDER" | head -3; check "POST orders" 1)

ORDER_ID=$(echo "$ORDER" | grep -oP '"id":"[^"]+' | head -1 | sed 's/"id":"//')
ORDER_CODE=$(echo "$ORDER" | grep -oP 'PD-2026-[0-9]+')
echo "    code generado: $ORDER_CODE"

# Pick first product
PRODUCT_ID=$(curl -s -H "$AUTH" "$BASE/commercial/price-lists/$PL_ID/prices" \
  | grep -oP '"product_id":"[^"]+' | head -1 | sed 's/"product_id":"//')

# Add line
ADD_LINE=$(curl -s -X POST $BASE/commercial/orders/$ORDER_ID/lines \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"product_id\":\"$PRODUCT_ID\",\"quantity\":3}")
echo "$ADD_LINE" | grep -q '"line_total"' && check "POST /orders/:id/lines → calcula totals" 0 \
  || (echo "    response: $ADD_LINE"; check "Add line" 1)

# Confirm
CONFIRM=$(curl -s -X POST $BASE/commercial/orders/$ORDER_ID/confirm -H "$AUTH")
echo "$CONFIRM" | grep -q '"status":"confirmed"' && check "POST /orders/:id/confirm → status=confirmed" 0 \
  || (echo "    response: $CONFIRM"; check "Confirm" 1)

# Fulfill
FULFILL=$(curl -s -X POST $BASE/commercial/orders/$ORDER_ID/fulfill -H "$AUTH")
echo "$FULFILL" | grep -q '"status":"fulfilled"' && check "POST /orders/:id/fulfill → status=fulfilled" 0 \
  || (echo "    response: $FULFILL"; check "Fulfill" 1)

# Get order detail with lines
DETAIL=$(curl -s -H "$AUTH" $BASE/commercial/orders/$ORDER_ID)
echo "$DETAIL" | grep -q '"lines"' && check "GET /orders/:id incluye lines" 0 \
  || check "Order detail" 1

echo ""
echo "── 7. Tenant isolation (sin Authorization → no abre scope → reject) ──"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" $BASE/commercial/customers)
[ "$HTTP_CODE" = "500" ] || [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ] \
  && check "GET sin auth → rechazo (HTTP $HTTP_CODE)" 0 \
  || check "Sin auth blocked" 1

echo ""
echo "═════════════════════════════════"
echo "Resultado: ✅ $PASS pasaron, ❌ $FAIL fallaron"
echo "═════════════════════════════════"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
