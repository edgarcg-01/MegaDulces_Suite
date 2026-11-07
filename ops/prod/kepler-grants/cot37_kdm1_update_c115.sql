-- [COT.37] La Suite puede corregir la «Dirección Envío» (kdm1.c115) de un pedido que ya escribió.
-- Sólo esa columna: no puede cambiar importes, estatus ni ninguna otra cosa del pedido.
-- Correr con: node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cot37_kdm1_update_c115.sql [--aplicar]
-- verificar: SELECT has_column_privilege('kepler_push', 'md.kdm1', 'c115', 'UPDATE')
GRANT UPDATE (c115) ON md.kdm1 TO kepler_push;
