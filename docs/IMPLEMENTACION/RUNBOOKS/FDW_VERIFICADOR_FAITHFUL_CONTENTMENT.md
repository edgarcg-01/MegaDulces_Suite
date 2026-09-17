# Runbook — Exponer los datos del verificador de precios a otro proyecto Railway vía `postgres_fdw`

> **Qué resuelve:** que una base en el proyecto Railway **`faithful-contentment`** lea, **en vivo y sin
> copiar**, los 4 objetos que necesita el verificador de precios, desde la base de prod que vive en el
> proyecto **`balanced-dream`** (`railway` @ `trolley.proxy.rlwy.net:39023`).
>
> **Mecanismo elegido: `postgres_fdw` (foreign tables).** Cero copia, siempre fresco (no puede quedar
> stale — un verificador sobre precios viejos es el incidente que fundó la Fase OBS), **cero cambio y
> cero downtime en prod** (a diferencia de la replicación lógica, que exigiría `wal_level=logical` =
> reinicio de prod). Alineado con la regla #1 (derive-no-copy).
>
> ⚠️ **Restricción de Railway:** proyectos distintos **no** comparten red privada → todo cruza el
> **proxy público** (`trolley.proxy.rlwy.net:39023`): TLS, egress facturado, ~150 ms/consulta. Para
> lookups puntuales por código (con caché de cliente en el verificador) es irrelevante; para escaneos
> pesados server-side, evaluar replicación lógica en su lugar.

## Los 4 objetos (medido 2026-09-17)

| Fuente en prod | Vía el contrato | Filas | Notas |
|---|---|--:|---|
| `kepler_ods.kdii` | `fdw_export.kdii` | 76,696 | artículo maestro por sucursal (precio base, unidades, barcodes, IVA/IEPS). **Se actualiza cada minuto** (`ods_live_hot`). |
| `kepler_ods.kdms` | `fdw_export.kdms` | 8 | maestro de sucursales (plazas 00 CEDIS … 06 Canindo). |
| `catalog.products` | `fdw_export.products` | 14,838 | puente Kepler↔Suite. **RLS FORCE** → expuesto por vista definer, tenant `mega_dulces`. |
| `commercial.product_label_prices` | `fdw_export.product_label_prices` | 69,860 | etiquetera: override manual + escalones de mayoreo. **RLS FORCE** → vista definer, tenant `mega_dulces`. |

**Por qué un schema-contrato `fdw_export` y no `GRANT` directo:** `catalog.products` y
`product_label_prices` tienen **RLS FORCE** (`tenant_id = current_tenant_id()`); el FDW no setea el GUC
de tenant, así que un grant directo devolvería **0 filas en silencio**. Las vistas de `fdw_export` son
*definer* (corren como `postgres`, superusuario → RLS resuelto una vez), filtradas a `mega_dulces`. El
rol RO **solo** ve `fdw_export` (verificado: no alcanza `commercial.orders`).

---

## PASO 1 — Prod (`balanced-dream`) — ✅ YA APLICADO 2026-09-17

Idempotente y read-only-expose. Reproducible (por si se recrea la base). El rol nace **sin password**.

```sql
CREATE SCHEMA IF NOT EXISTS fdw_export;
CREATE OR REPLACE VIEW fdw_export.kdii AS SELECT * FROM kepler_ods.kdii;
CREATE OR REPLACE VIEW fdw_export.kdms AS SELECT * FROM kepler_ods.kdms;
CREATE OR REPLACE VIEW fdw_export.products AS
  SELECT * FROM catalog.products WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid;
CREATE OR REPLACE VIEW fdw_export.product_label_prices AS
  SELECT * FROM commercial.product_label_prices WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid;
ALTER VIEW fdw_export.kdii SET (security_invoker = false);
ALTER VIEW fdw_export.kdms SET (security_invoker = false);
ALTER VIEW fdw_export.products SET (security_invoker = false);
ALTER VIEW fdw_export.product_label_prices SET (security_invoker = false);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fdw_verificador_ro') THEN
    CREATE ROLE fdw_verificador_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA fdw_export TO fdw_verificador_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA fdw_export TO fdw_verificador_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA fdw_export GRANT SELECT ON TABLES TO fdw_verificador_ro;
```

## PASO 2 — Prod — asignar el password del rol RO (lo hace un humano, NUNCA va a git)

Elegí un password fuerte y guárdalo como **secret**. Desde `psql` contra `balanced-dream`:

```sql
ALTER ROLE fdw_verificador_ro PASSWORD '<PASSWORD_FUERTE_AQUI>';
```

> El password es un **secret de Railway** (Paso 4). No lo commitees, no lo pegues en chat, no lo pongas
> en el `.sql`. Si se filtra, rotarlo es un `ALTER ROLE ... PASSWORD` nuevo + actualizar el secret.

## PASO 3 — Railway — crear la base en `faithful-contentment`

En el dashboard de Railway (o `railway` CLI), dentro del proyecto **`faithful-contentment`**:
add service → **Database → PostgreSQL**. Anota su connection string interna (la usa la app del proyecto).

## PASO 4 — La base nueva (`faithful-contentment`) — montar el FDW

Conéctate a la Postgres recién creada y corré (poné el password real del Paso 2 — en Railway idealmente
como variable, no inline):

```sql
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- apunta al PROXY PÚBLICO de balanced-dream (host/port de sus "public networking" vars)
CREATE SERVER IF NOT EXISTS balanced_dream_prod
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'trolley.proxy.rlwy.net', port '39023', dbname 'railway',
           sslmode 'require', fetch_size '10000');

-- mapea el ROL QUE CONSULTA (el rol de la app del proyecto nuevo; o CURRENT_USER si es el mismo)
CREATE USER MAPPING IF NOT EXISTS FOR CURRENT_USER
  SERVER balanced_dream_prod
  OPTIONS (user 'fdw_verificador_ro', password '<PASSWORD_FUERTE_AQUI>');

CREATE SCHEMA IF NOT EXISTS verificador_src;
IMPORT FOREIGN SCHEMA fdw_export
  FROM SERVER balanced_dream_prod
  INTO verificador_src;
```

## PASO 5 — Verificar (desde `faithful-contentment`)

```sql
SELECT count(*) FROM verificador_src.kdii;                  -- esperado 76696 (crece)
SELECT count(*) FROM verificador_src.kdms;                  -- 8
SELECT count(*) FROM verificador_src.products;              -- 14838
SELECT count(*) FROM verificador_src.product_label_prices;  -- 69860
-- lookup real por código (así consulta el verificador; el WHERE se empuja a prod):
SELECT c1, c2, c7, c90 FROM verificador_src.kdii WHERE c7 = '<un_barcode>' LIMIT 5;
```

Si `count` da 0 → el rol no tiene el grant o el password/host está mal; si da error de conexión → el
proxy público/creds. **Un `0` silencioso NO debe pasar a producción** (lección VP/OBS).

---

## Notas operativas

- **Frescura:** los foreign tables leen prod al vuelo → **nunca stale**. `kdii` refleja el último ciclo
  de `ods_live_hot` (cada minuto). Es la razón de elegir FDW sobre un `pg_dump` que drifta.
- **Columnas crudas preservadas:** `fdw_export.kdii` es `SELECT *`, así que trae `c1,c2,c7,c93,c90,c84,…`
  exactamente como los usa el verificador (c7/c93 barcode base, c85 barcode u3, c90 precio base, etc.).
  El mayoreo y el override manual vienen de `fdw_export.product_label_prices`.
- **Costo/latencia:** cada lectura cruza el proxy público (egress + ~150 ms). El verificador cachea en
  el cliente (service worker + IndexedDB por sucursal), así que la ruta caliente casi no pega a la DB.
  Si aparece escaneo pesado server-side, reconsiderar replicación lógica (requiere reinicio de prod).
- **Seguridad:** rol dedicado, solo lectura, `NOBYPASSRLS`, solo ve `fdw_export`. Nunca `postgres`/`app_runtime`.
- **Tear-down (prod):** `DROP OWNED BY fdw_verificador_ro; DROP ROLE fdw_verificador_ro; DROP SCHEMA fdw_export CASCADE;`
- ⚠️ **Recordatorio de arquitectura (regla #1 / Fase CV):** estos mismos datos ya se sirven **vivos** por
  `KpModule` en `apps/api` (`/api/kp/precio`, `/api/kp/precios-todos`, `/api/sucursales`) desde prod. Este
  FDW se justifica **solo** si el proyecto `faithful-contentment` necesita la data en su propia DB por una
  razón real (una app/tienda aislada). Si el objetivo es "un verificador alcanzable", ya existe.
