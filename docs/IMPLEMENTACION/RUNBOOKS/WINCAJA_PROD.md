# Runbook — despliegue de Wincaja a producción (Fase W)

> Secuencia para llevar la ingesta Wincaja (bronze→silver→gold) a Railway + agendar
> los feeds. **Los writes a prod los corrés vos** (el classifier bloquea que Claude
> escriba a Railway). Ver [`FASE_W_WINCAJA.md`](../FASES/FASE_W_WINCAJA.md) · ADR-031.

## Prerrequisitos

- **Host de feeds:** `.245` (o cualquier Windows en la LAN con acceso a las `.mdb`). Necesita:
  - `Microsoft.Jet.OLEDB.4.0` (viene con Windows, 32-bit) — ya verificado.
  - Acceso a `D:\Salidas\Bases\Actuales` y `...\Concentradas` (local en `.245`, o `Z:` en otra máquina).
  - Node + el repo (`database/importers/wincaja/`).
- **`DATABASE_URL_NEW`** apuntando a la DB nueva en Railway (`...proxy.rlwy.net...?sslmode=no-verify`).
- Cuenta de servicio read-only en el origen recomendada (no usar admin).

## Paso 1 — Migraciones (schema + gold warehouse) → Railway

Aplicar en orden (idempotentes, guard `hasTable`/`NOT EXISTS`):

```
npx knex migrate:latest --knexfile database/knexfile-newdb.js
```

Las de esta fase (batch): 
- `20260713120000_wincaja_landing_schema` — schema `wincaja.*` (21 tablas) + crosswalk `branches`.
- `20260713140000_wincaja_silver_views` — v_sales_lines/daily, v_stock.
- `20260713150000_wincaja_silver_views_2` — v_ar_customer/open_docs, v_ap_supplier, v_cash_denomination, v_prices.
- `20260713160000_wincaja_md32_warehouse` — alta MD-32.
- `20260713170000_wincaja_landing_extra` — cotizaciones/autorizaciones/cajeros/categorias/almacenes.
- `20260713180000_wincaja_silver_views_3` — v_lost_demand, v_cash_authorizations.

> ⚠️ Requiere PG15+ (las vistas usan `security_invoker`). La DB nueva es PG18 → OK.

## Paso 2 — Bronze (extraer Access → landing) en `.245`

```
# desde database/, con DATABASE_URL_NEW seteado a Railway:
node importers/wincaja/import-wincaja.js --branch all --domain all --dataset both --apply
```

- Lee las 8 sucursales × 2 carpetas (Actuales + Concentradas) vía Jet 4.0 32-bit.
- Recarga full por (sucursal, dataset) → idempotente. ~5.7M filas, tarda varios minutos (detalles concentrada es lo pesado).
- Override de carpetas: `WINCAJA_ACTUALES` / `WINCAJA_CONCENTRADAS` (default `Z:\Salidas\Bases\...`).

## Paso 3 — Gold (silver → tablas canónicas) en `.245`

```
node importers/wincaja/import-wincaja-analytics.js --apply   # venta 30/32/50 -> analytics.sales_daily (channel='wincaja')
node importers/wincaja/import-wincaja-stock.js --apply        # existencia 30/32/50 -> commercial.stock
```

- Solo alimentan las **wincaja_only (30/32/50)** → cero doble conteo con Kepler.
- Idempotentes: analytics = DELETE canal `wincaja` + INSERT; stock = ON CONFLICT DO UPDATE quantity.

## Paso 4 — Agendar (cron en `.245`)

Cadencia sugerida (confirmar con la real de las `.mdb`):
- **Actuales** cambian a diario → correr Pasos 2+3 **diario** (madrugada).
- **Concentradas** son mensuales → un run mensual basta para el histórico; el diario de Actuales cubre lo vigente.

Un wrapper `run-wincaja.js` (pendiente crear) encadena bronze→gold, al estilo `run-prod-feeds.js` de Kepler.

## Orden de dependencias

```
migraciones (schema) ─> bronze (import-wincaja) ─> gold (analytics + stock)
                                                     │ dependen de catalog.products (sku)
                                                     │ y commercial.warehouses (MD-30/32/50)
```

## Verificación post-deploy

```sql
-- bronze cargado
SELECT source_dataset, count(distinct source_branch) FROM wincaja.articulos GROUP BY 1;
-- gold venta visible
SELECT count(*), round(sum(revenue)) FROM analytics.sales_daily WHERE channel='wincaja';
-- gold stock visible
SELECT w.code, count(*) FROM commercial.stock st JOIN commercial.warehouses w ON w.id=st.warehouse_id
 WHERE w.code IN ('MD-30','MD-32','MD-50') GROUP BY 1;
```

## Rollback

- Gold: `DELETE FROM analytics.sales_daily WHERE channel='wincaja'` + re-feed Kepler; stock se re-sincroniza con el snapshot nocturno de Kepler (no aplica a 30/32/50, que no tienen Kepler → borrar manual si se quiere).
- Bronze/silver: `DROP SCHEMA wincaja CASCADE` (las migraciones `down` lo hacen).

## Pendiente (no bloquea el deploy)

- Wiring de UI puntual (qué pantalla muestra 30/32/50).
- Cuenta de servicio read-only en el origen.
- Confirmar cadencia real de las carpetas.
