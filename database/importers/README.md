# Commercial Importer CLI

Importer idempotente para cargar data comercial al `postgres_platform` multi-tenant.

## Cuándo usarlo

- Carga inicial de Mega Dulces (Fase B.3).
- Migración futura desde ERP externo (FDW snapshot → JSON → importer).
- Sync masivo de precios (al renegociar listas).
- Snapshot inicial de stock al abrir un almacén nuevo.

## Pre-requisitos

- DB nueva multi-tenant aplicada (migraciones 1-9).
- Tenant existente (`tenants.slug` válido).
- `.env` con `DATABASE_URL_NEW` apuntando a la DB nueva (postgres user).

## Uso

```bash
# Customers
node database/importers/commercial_import.js \
  --type=customers \
  --file=database/importers/examples/customers.json \
  --tenant-slug=mega_dulces

# Brands → Products → Prices (orden importa: products necesita brands; prices necesita products)
node database/importers/commercial_import.js --type=brands --file=examples/brands.json --tenant-slug=mega_dulces
node database/importers/commercial_import.js --type=products --file=examples/products.json --tenant-slug=mega_dulces
node database/importers/commercial_import.js --type=prices --file=examples/prices.json --tenant-slug=mega_dulces --price-list-code=BASE-MXN

# Warehouses
node database/importers/commercial_import.js --type=warehouses --file=examples/warehouses.json --tenant-slug=mega_dulces

# Stock (snapshot inicial — genera movement 'adjust' con el delta)
node database/importers/commercial_import.js --type=stock --file=examples/stock.json --tenant-slug=mega_dulces --warehouse-code=MD-CENTRAL

# Dry-run: valida + reporta sin escribir
node database/importers/commercial_import.js --type=customers --file=foo.json --tenant-slug=mega_dulces --dry-run
```

## Idempotencia

Cada importer hace upsert por la clave única natural:

| type       | conflict key                                |
| ---------- | ------------------------------------------- |
| customers  | (tenant_id, code)                           |
| brands     | (tenant_id, nombre)                         |
| products   | (tenant_id, brand_id, nombre)               |
| warehouses | (tenant_id, code)                           |
| prices     | (tenant_id, price_list_id, product_id)      |
| stock      | (tenant_id, warehouse_id, product_id) UPDATE |

Re-correr el mismo archivo NO duplica. Sí actualiza valores cambiados.

## Formato esperado de cada archivo

Ver `examples/` para shapes mínimos viables. Resumen:

- **customers**: `code` (regex `[A-Z0-9_-]{2,50}`), `name`, opcionales (`legal_name`, `rfc` formato MX, `email`, `phone`, `billing_address`/`shipping_address` JSON, `default_price_list_code`, `credit_limit`, `payment_terms_days`, `active`, `notes`).
- **brands**: `nombre`, opcionales (`activo`, `orden`).
- **products**: `brand_nombre` (lookup), `nombre`, opcionales (`activo`, `orden`, `puntuacion`).
- **warehouses**: `code`, `name`, opcionales (`address`, `is_default`, `active`).
- **prices**: `product_brand` + `product_nombre` (lookup), `price`, opcionales (`tax_rate` default 0.16, `min_qty` default 1). Requiere `--price-list-code=<code>`.
- **stock**: `product_brand` + `product_nombre` (lookup), `quantity`. Requiere `--warehouse-code=<code>`.

## Reporte

Cada corrida emite resumen:

```
─── SUMMARY (customers) ───
Total rows:  150
Upserted:    148
Skipped:     2
Elapsed:     312ms

First errors (2):
  row 23: rfc formato MX inválido
  row 87: default_price_list_code "PREMIUM" no existe
```

Exit codes:
- `0`: todo OK
- `1`: error fatal (file no existe, tenant no existe, etc.)
- `2`: corrió pero algunos rows fallaron validación

## Orden recomendado de carga inicial

1. `warehouses` (si tenés más que el default).
2. `brands` (catálogo).
3. `products` (depende de brands).
4. `prices` (depende de products + price_list existente).
5. `customers` (puede usar `default_price_list_code` si la lista existe).
6. `stock` (depende de products + warehouse).
