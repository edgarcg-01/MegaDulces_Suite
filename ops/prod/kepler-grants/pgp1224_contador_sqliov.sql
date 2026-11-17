-- [PGP.122.4] Los 4 carriles que ya escriben en Kepler (pago X-D-26, requisición X-A-30 y traspaso, OC X-A-35,
-- pedido TELEMARK U-D-40) toman el folio del CONTADOR de Kepler (md.sqliov) en vez de MAX+1. Plan: anexo S §16 R8,
-- docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md; decisión: ADR-119 punto 4.
--
-- ⛔⛔ VA ANTES DE SOLTAR el commit 216245d60 [PGP.122.4], y en LOS 9 servidores. Medido el 2026-11-17: los
--    interruptores 'compra' y 'telemarketing' están encendidos en las 9 sucursales. Con el código nuevo y sin este
--    permiso, el candado del contador (SELECT … FOR UPDATE) falla con «permission denied» y la requisición, la OC y
--    el pedido TLMK DEJAN DE ESCRIBIRSE en todas.
--
-- Es SÓLO el contador: leerlo y avanzar su columna c4. El candado de la fila (FOR UPDATE) exige UPDATE sobre al
-- menos una columna: es ésta. NO da INSERT en kdm6 ni nada de la solicitud de gasto: eso sigue en
-- pgp122_solicitud_gasto.sql, sólo en 05 y después de la captura de prueba.
-- Las dos líneas son idénticas a las de pgp122_solicitud_gasto.sql: correr los dos archivos no duplica nada.
--
-- Correr con:
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp1224_contador_sqliov.sql            (revisa, no cambia)
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp1224_contador_sqliov.sql --aplicar
-- verificar: SELECT has_table_privilege('kepler_push', 'md.sqliov', 'SELECT') AND has_column_privilege('kepler_push', 'md.sqliov', 'c4', 'UPDATE')

GRANT SELECT ON md.sqliov TO kepler_push;                        -- leer el contador
GRANT UPDATE (c4) ON md.sqliov TO kepler_push;                   -- avanzarlo, y sólo esa columna
