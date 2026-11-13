-- [PQ.110] La Suite cancela una OC (X-A-35) en Kepler igual que Kepler: D40 = (a), decidido por Edgar
-- el 2026-11-13. Lo que escribe una cancelación, medido con el respaldo nocturno de md contra prod
-- (FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md §3c):
--   cabecera kdm1: c43 N→C · c13, c14, c15, c16 (importes) y c42 (saldo) → 0 ·
--                  c67 → usuario que cancela · c68/c69 → fecha y hora de la cancelación
--   renglones kdm2: se BORRAN
--   requisición de origen (c37=30): Kepler la REABRE — c43 F→A, c42 = c16, kdm2.c24 = c9 (25 de 25
--                  en 90 días; caso 08|0000362 visto en el respaldo). Por eso UPDATE (c24) en kdm2.
-- En las 361 OC canceladas de 90 días, c13–c16 y c42 están en 0 sin excepción.
--
-- ⛔ Dar el permiso NO enciende nada: PQ.110 todavía no tiene código. El DELETE no se puede acotar por
--    columna ni por fila en Kepler; lo acota el adaptador (una OC, su sucursal, su folio, sin vale vivo).
-- ⚠️ `kepler_push` ya tiene UPDATE (c43) y UPDATE (c115) en md.kdm1 (cot37); aquí se agregan las demás.
--
-- Correr con (primero CEDIS, luego las sucursales donde la Suite ya escribe OC: 01, 02, 06, 07, 08):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pq110_cancelar_oc.sql --servidores 00
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pq110_cancelar_oc.sql --servidores 00 --aplicar
-- verificar: SELECT has_column_privilege('kepler_push', 'md.kdm1', 'c13', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c14', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c15', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c16', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c42', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c43', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c67', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c68', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c69', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdm2', 'DELETE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c24', 'UPDATE')

GRANT UPDATE (c13, c14, c15, c16, c42, c43, c67, c68, c69) ON md.kdm1 TO kepler_push;  -- la cabecera cancelada
GRANT DELETE ON md.kdm2 TO kepler_push;                                                -- sus renglones
-- [2026-11-13, tras el ensayo] Reabrir la requisición. Aplicado el bloque de arriba en los 6; ÉSTE espera la firma de Edgar.
GRANT UPDATE (c24) ON md.kdm2 TO kepler_push;                                          -- pendiente de los renglones de la requisición
