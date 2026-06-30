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

> **Todos los importers a prod son BULK** (staging temp + merge server-side). El
> per-fila contra Railway (~1.2 s/query) tomaba horas; bulk = segundos/<2 min.

1. **Catálogo + precios Kepler → prod** (on-prem, `DATABASE_URL_NEW=<prod>`, `MEGA_DULCES_URL=<.245>`):
   ```
   node database/importers/import-catalog-bulk.js --apply   # match por nombre, setea sku
   node database/importers/import-prices-bulk.js  --apply   # 5 listas, solo activos
   ```
   Verificar: `SELECT count(*), count(*) FILTER (WHERE btrim(coalesce(sku,''))<>'') FROM public.products` (~12.4k, ~11.1k con sku) y precios `> 0` en `commercial.product_prices`.
2. **Deploy de código** (migración `20260629120000_catalog_top_sellers_live.js` crea la tabla; endpoint `listTopSellers`; exclusión MD-10 en `mega_dulces_sync`; módulo inerte en Railway). Verificar tras deploy: `SELECT to_regclass('catalog.top_sellers_live')` no nula.
3. **Feeds → prod** (on-prem, Docker `kepler_consolidado` arriba):
   ```
   node database/importers/kepler/import-branch-stock-live.js        --apply   # stock 6 sucursales (00..05)
   node database/importers/kepler/import-rotation-from-consolidado.js --apply  # rotación de red → Thot
   node database/importers/kepler/import-top-sellers-from-consolidado.js --apply # best-sellers portal
   ```
   O en un solo paso: `node database/importers/kepler/run-prod-feeds.js all --apply`.

## 4. Operación continua (runner on-prem)

**Punto de entrada único:** `database/importers/kepler/run-prod-feeds.js <modo> [--apply]`
(orquesta los importers bulk como subprocesos; guarda: `--apply` exige
`DATABASE_URL_NEW` = proxy Railway, default dry-run). Modos: `stock` · `nightly`
(rotación+top-sellers) · `catalog` (catálogo+precios) · `all`.

Env de la tarea: `DATABASE_URL_NEW=<prod>`, `DATABASE_URL_KEPLER_CONSOLIDADO=<localhost:5433>`,
`MEGA_DULCES_URL=<.245>` (solo `catalog`).

| Tarea | Frecuencia | Comando |
|---|---|---|
| Refresh consolidación | cada 2 min | `psql <kepler_consolidado> -c "SELECT mart.refresh_si_cambio(7)"` |
| Stock 6 sucursales | cada 30 min | `run-prod-feeds.js stock --apply` |
| Rotación + best-sellers | nightly 04:00 | `run-prod-feeds.js nightly --apply` |
| Catálogo + precios | semanal | `run-prod-feeds.js catalog --apply` |

Ejemplo Task Scheduler (Windows), stock cada 30 min:
```
schtasks /Create /TN "Kepler\StockProd" /SC MINUTE /MO 30 /TR ^
 "cmd /c cd /d C:\ruta\Trade_marketing && node database/importers/kepler/run-prod-feeds.js stock --apply >> logs\stock.log 2>&1"
```
(env vars vía variables de sistema o un `.cmd` wrapper que las exporte antes del `node`.)

> Alternativa: desplegar una instancia NestJS on-prem con esas env vars → los
> `@Cron` del módulo `kepler-consolidado` corren solos. Más pesado que el scheduler.

### 4.1 — Runner ACTIVO (2026-06-30)

Programado en la **laptop `192.168.0.249`** (Task Scheduler), wrapper en
`C:\KeplerRunner\run-feeds.cmd` (fuera del repo — contiene credenciales; setea
`DATABASE_URL_NEW`=prod, `DATABASE_URL_KEPLER_CONSOLIDADO`, `MEGA_DULCES_URL`).
Logs en `C:\KeplerRunner\logs\<modo>.log`.

| Tarea | Schedule | Modo |
|---|---|---|
| `Kepler\Stock` | cada 30 min | `stock` |
| `Kepler\Nightly` | diario 03:00 | `nightly` (rotación, top-sellers, margin, sales-fact, stats, inventory-health, promos, customers, customer-sales) |
| `Kepler\Catalog` | domingo 02:00 | `catalog` (catálogo + precios) |

**DEPENDENCIAS (si falla la actualización, revisar esto):**
1. La laptop debe estar **encendida y con sesión iniciada** (las tareas corren "solo si el usuario inició sesión" porque Docker Desktop vive en la sesión del usuario).
2. **Docker Desktop arriba** con el contenedor `pgvector-md` (kepler_consolidado en localhost:5433).
3. VPN a las sucursales activa (para stock/margin/customers).

Recrear/editar: `schtasks /Query /TN "Kepler\Stock"` · borrar: `schtasks /Delete /TN "Kepler\Stock" /F`.

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
