-- [PQ.160] La Suite cambia las CANTIDADES de una OC (X-A-35) pendiente y sin vale, con las fórmulas de Kepler
-- (libs/commercial/src/lib/commercial-replenishment/kepler-oc-edicion.ts). Lo que escribe:
--   renglones kdm2: c9 (cantidad base) · c13 (importe) · c24 (pendiente) · c56 (cantidad en la presentación) ·
--                   c31 (= c9, sólo si ya lo era) · c51 (pedida = c56, sólo si ya lo era)
--   encabezado kdm1: c14 (IVA) · c15 (IEPS) · c16 (total) · c42 (saldo = total)
-- Medido el 2026-11-26 (kepler_push en 00): YA tiene UPDATE en kdm2.c24 y kdm1.c16/c42/c43 (pq110, pgp106);
-- le faltan los de abajo. Tipos iguales en 00, 03 y 08: c9/c24/c31 double precision, c13 numeric, c51/c56 varchar.
--
-- ⛔ Dar el permiso NO enciende nada: lo enciende el interruptor edita_oc de kepler_push_switch, por sucursal.
--    Las filas las acota el adaptador: una OC, su sucursal, su folio, estado N, sin vale, y cada UPDATE repite
--    en su WHERE lo que leyó.
--
-- Correr (como superusuario, desde md: en CEDIS postgres, en 01–08 sa), primero en seco:
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pq160_editar_oc.sql --servidores 00
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pq160_editar_oc.sql --servidores 00 --aplicar
-- verificar: SELECT has_column_privilege('kepler_push', 'md.kdm2', 'c9', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c13', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c24', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c31', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c51', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c56', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c14', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c15', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c16', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c42', 'UPDATE')

GRANT UPDATE (c9, c13, c24, c31, c51, c56) ON md.kdm2 TO kepler_push;  -- los renglones: cantidad, importe y sus copias
GRANT UPDATE (c14, c15, c16, c42) ON md.kdm1 TO kepler_push;           -- el encabezado: impuestos, total y saldo
