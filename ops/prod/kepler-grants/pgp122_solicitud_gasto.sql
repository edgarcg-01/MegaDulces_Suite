-- [PGP.122] La Suite CREA en Kepler la solicitud de gasto (X-A-15-1) que nació en la Suite, al firmarla y ya
-- autorizada (c43 = 'A'). Plan: docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md §4–§5.
--
-- Lo que escribe (medido en el ODS, 2026-11-14/15):
--   1 INSERT kdm1   — la cabecera (clon de la plantilla del servidor). kepler_push YA lo tiene (requisición, KR).
--   2 INSERT kdm6   — los renglones (concepto, cuenta, proyecto, departamento, importe).
--   3 UPDATE sqliov.c4 — el contador de folios KFXA1501.NN, y SÓLO esa columna. El candado de la fila
--                        (SELECT … FOR UPDATE) pide UPDATE sobre al menos una columna: es ésta.
-- Más la lectura: acreedor (kdxd), conceptos con su cuenta (kdco), proyectos (kdcp), departamentos (kdc3).
-- Una solicitud NO hace póliza, kdxe ni acumulados (0 de 11,444 CxP son X-A-15; 0 renglones de póliza):
-- este permiso es mucho menor que el del pago (pgp106_pago_proveedor.sql).
--
-- ⚠️ Lo que Kepler además toque al CREAR una solicitud se cierra con la captura de prueba (anexo §8, S.1;
--    ops/prod/ensayo-solicitud-gasto/README.md). Si aparece otra tabla, se agrega aquí antes de encender.
-- ⛔ Dar el permiso NO enciende nada: la escritura sigue apagada por KEPLER_GASTO_SOLICITUD (≠ 'encendida'),
--    por KEPLER_SOLGASTO_TEMPLATE_FOLIO_NN (sin default) y por el interruptor 'solicitud_gasto' de
--    commercial.kepler_push_switch (sembrado apagado, tope 1). El ensayo SÍ lo necesita para correr completo.
-- ⚠️ El GRANT es por tabla y columna, no por tipo de documento: INSERT en kdm6 sirve para cualquier documento.
--    Lo único que lo acota a la X-A-15 es el código (KeplerSolicitudGastoSinkAdapter) y el interruptor.
--
-- Correr con (05 primero: es el canario, ~1.8 solicitudes al día):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp122_solicitud_gasto.sql --servidores 05
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp122_solicitud_gasto.sql --servidores 05 --aplicar
--   (después: --servidores 07,08 · luego 01,02,03,04,06 · al final 00)
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdm1', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm6', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm6', 'SELECT') AND has_table_privilege('kepler_push', 'md.sqliov', 'SELECT') AND has_column_privilege('kepler_push', 'md.sqliov', 'c4', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdxd', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdco', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdcp', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdc3', 'SELECT')

GRANT SELECT, INSERT ON md.kdm1, md.kdm6 TO kepler_push;         -- 1 2: la cabecera y sus renglones
GRANT SELECT ON md.sqliov TO kepler_push;                        -- leer el contador
GRANT UPDATE (c4) ON md.sqliov TO kepler_push;                   -- 3: avanzarlo, y sólo esa columna
GRANT SELECT ON md.kdxd, md.kdco, md.kdcp, md.kdc3 TO kepler_push;  -- acreedor y catálogos del servidor
