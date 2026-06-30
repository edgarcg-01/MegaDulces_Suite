# Runbook — Consolidación Kepler en vivo → Prod (Railway)

> Integración que lleva ventas/stock/rotación reales de las 6 sucursales Kepler a
> `postgres_platform` (prod) alimentando Thot, dead-stock, stock del vendedor y
> best-sellers del portal. Single dev (Edgar). Actualizado 2026-06-29.

## 1. Por qué hay un runner on-prem (no todo en Railway)

**Railway (prod, nube) NO alcanza la red de Mega Dulces** — ni las 6 sucursales
(`192.168.x.x`) ni la DB central `.245`. (Confirmado: las migraciones con FDW al
`.245` crashean el boot de Railway.)

Por lo tanto el pipeline de consolidación **corre on-premise** (una máquina en la
red Mega Dulces) y **empuja los resultados a prod** por el proxy público de Railway
(`trolley.proxy.rlwy.net:39023`), que sí es alcanzable desde la LAN.

El módulo NestJS `apps/api/src/modules/kepler-consolidado` desplegado en Railway
queda **inerte** (null-safe: sin `DATABASE_URL_KEPLER_CONSOLIDADO` no hace nada).
Los crons reales corren en el runner on-prem.

```
ON-PREM (laptop/server en LAN Mega Dulces)            RAILWAY (nube)
┌───────────────────────────────────────┐
│ Docker localhost:5433/kepler_consolidado│            postgres_platform (prod)
│   mart.ventas (FDW 6 sucursales)        │  push      ├ public.products (sku, catálogo)
│ Runner: feeds Node →─────────────────────────────────┤ catalog.products (rotation)
│   DATABASE_URL_NEW = <proxy Railway>    │  (proxy)   ├ commercial.stock (almacén '01' = PH)
│   PH_WAREHOUSE_CODE = 01                │            └ catalog.top_sellers_live
└───────────────────────────────────────┘
```

## 2. Mapeo de almacenes (¡difiere por entorno!)

| Sucursal | DB Kepler | Código prod | Código local (dev) |
|---|---|---|---|
| Padre Hidalgo (PH, surte vendedor+portal) | md_01 | **`01`** | MD-10 |
| La Piedad Abastos | md_02 | `02` | MD-42 |
| 8 Esquinas | md_03 | `03` | MD-40 |

→ El feed de stock PH usa env `PH_WAREHOUSE_CODE` (prod=`01`, dev=`MD-10`).

## 3. Cutover (orden, una sola vez)

> **Backup primero** (rollback): `pg_dump <prod> -t public.products -t commercial.product_prices -t catalog.brands -t catalog.categories --data-only --column-inserts -f backup.sql`

1. **Catálogo Kepler → prod** (on-prem, `DATABASE_URL_NEW=<prod>`), por scope, SALTANDO warehouses/stock:
   ```
   node database/importers/mega_dulces_sync.js --tenant-slug=mega_dulces --scope=categories
   node database/importers/mega_dulces_sync.js --tenant-slug=mega_dulces --scope=brands
   node database/importers/mega_dulces_sync.js --tenant-slug=mega_dulces --scope=products
   node database/importers/mega_dulces_sync.js --tenant-slug=mega_dulces --scope=price-lists
   node database/importers/mega_dulces_sync.js --tenant-slug=mega_dulces --scope=prices
   ```
   Verificar tras products: `SELECT count(*), count(*) FILTER (WHERE sku<>'') FROM public.products` (~12.9k, sku poblado) y sin duplicados por nombre.
2. **Deploy de código** (migración `20260629120000_catalog_top_sellers_live.js` crea la tabla; cambio de endpoint `listTopSellers`; exclusión MD-10 en `mega_dulces_sync`; módulo inerte).
3. **Feeds → prod** (on-prem):
   ```
   PH_WAREHOUSE_CODE=01 node database/importers/kepler/import-ph-stock-live.js --apply
   node database/importers/kepler/import-rotation-from-consolidado.js --apply
   node database/importers/kepler/import-top-sellers-from-consolidado.js --apply
   ```

## 4. Operación continua (runner on-prem)

Programar en la máquina on-prem (Windows Task Scheduler o equivalente), con env
`DATABASE_URL_KEPLER_CONSOLIDADO`, `DATABASE_URL_NEW=<prod>`, `PH_WAREHOUSE_CODE=01`:

| Tarea | Frecuencia | Comando |
|---|---|---|
| Refresh consolidación | cada 2 min | `psql <kepler_consolidado> -c "SELECT mart.refresh_si_cambio(7)"` |
| Stock PH | cada 30 min | `import-ph-stock-live.js --apply` |
| Rotación | nightly 04:00 | `import-rotation-from-consolidado.js --apply` |
| Best-sellers | nightly 04:15 | `import-top-sellers-from-consolidado.js --apply` |
| Catálogo (opcional) | semanal | `mega_dulces_sync.js --scope=products` (+ prices) |

> Alternativa: desplegar una instancia NestJS on-prem con esas env vars → los 4
> `@Cron` del módulo `kepler-consolidado` corren solos. Más pesado que el scheduler.

## 5. Seguridad / pendientes

- El runner on-prem tiene el string superusuario de prod + creds de sucursales.
  **TODO**: rol prod scoped (solo `catalog.products`, `commercial.stock`,
  `catalog.top_sellers_live`, `public.products`) en vez de `postgres`.
- `platform_ro`/`kepler123` (read-only) en las 6 sucursales para los FDW.
- NUNCA correr `knex migrate:latest` a mano contra prod si hay migraciones
  pendientes no relacionadas (regla: no tocar Trade Marketing / auditoría de ruta).

## 6. Rollback

- Catálogo: restaurar `backup.sql` (TRUNCATE + restore de las 4 tablas).
- Endpoint top-sellers: revertir la línea a `catalog.products_top_sellers` (el MV
  viejo queda intacto).
- Feeds: son idempotentes; re-correr o dejar de agendar.
