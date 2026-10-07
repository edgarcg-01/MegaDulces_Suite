-- RL.13 — Alta de la rama `md_08` (Morelia Abastos) en la consolidación on-prem
-- (`kepler_consolidado` @ 192.168.0.222:5433). ADITIVA: una fila, no toca nada existente.
--
-- ── POR QUÉ HACE FALTA, medido el 2026-09-21 ────────────────────────────────────────────────
-- `analytics.sales_daily` —el fact de venta que alimenta Command Center, margen y rotación—
-- se llena con `import-sales-fact.js` desde `mart.ventas_enriched`, que es una vista sobre
-- `mart.ventas`. Y `mart.ventas` la llena `mart.refresh_si_cambio()`, que hace exactamente esto:
--
--     FOR r IN SELECT db, host, port, dbname FROM dim.sucursales ORDER BY db LOOP
--
-- O sea que la lista de sucursales de la consolidación es ESTA TABLA, y tenía `md_00`..`md_07`.
-- Sin fila para `md_08`, Morelia Abastos vendía y el fact quedaba en CERO:
--
--     kepler_ods.kdm1 sucursal '08' · U-D-10 : 710 (19-sep) · 479 (20-sep) · 126 (21-sep)
--     analytics.sales_daily          almacén '08' :      0 filas
--
-- ⛔ Esto NO lo arregla desplegar `ops/vl`. El despliegue corrige la lista de ramas del CÓDIGO
-- (`kepler-branches.js`, que sí quedó en 00-08 y por eso el stock y los tickets en vivo ya
-- entran). La consolidación lee su lista de la BASE. Son dos registros distintos de la misma
-- red, y hay que tocar los dos — es la clase de hueco que se lee como "la sucursal no vendió".
--
-- ── Apunta a la RÉPLICA, no al POS ──────────────────────────────────────────────────────────
-- `127.0.0.1:5432/kepler_md_08` es la réplica lógica local, dentro del mismo contenedor donde
-- vive esta base. Mismo criterio que `md_06` y `md_07`: el POS de `.30.30` responde (verificado,
-- `md.kdik` = 2,975 filas), pero leer del espejo es más barato para una caja que está cobrando.
-- `refresh_si_cambio` conecta con `platform_ro`; la credencial vive en la función, no acá.
--
-- ── Aplicar ─────────────────────────────────────────────────────────────────────────────────
--   psql "$DATABASE_URL_KEPLER_CONSOLIDADO" -f database/importers/kepler/sql/dim_sucursales_md08.sql
--
-- Idempotente. Después del alta, `refresh_si_cambio` (corre cada ~30 s) ve `last_marker` NULL,
-- lo encuentra DISTINCT y refresca sola. El relleno explícito de abajo cubre desde el 18-sep,
-- primer día de la `08` en Kepler, porque el ciclo normal sólo trae su ventana corta.

INSERT INTO dim.sucursales (db, codigo, nombre, tipo, ddns, host, port, dbname)
VALUES ('md_08', '08', 'Sucursal Morelia Abastos', 'RETAIL', 'abastos.local',
        '127.0.0.1', 5432, 'kepler_md_08')
ON CONFLICT (db) DO UPDATE
  SET host = EXCLUDED.host, port = EXCLUDED.port, dbname = EXCLUDED.dbname;

-- Relleno de los días que la tienda ya vendió antes de existir en esta tabla.
SELECT mart._refresh_one('md_08', 10) AS renglones_cargados;

-- Verificación: debe traer los días desde el 2026-09-18 con importe > 0.
SELECT fecha, count(*) AS renglones, round(sum(importe)::numeric, 0) AS importe
  FROM mart.ventas WHERE sucursal = 'md_08'
 GROUP BY 1 ORDER BY 1;
