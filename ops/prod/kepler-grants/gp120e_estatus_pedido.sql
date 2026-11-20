-- [GP.12.0e] La Suite escribe el estatus de un pedido U-D-40 en Kepler: SURTIDO, CHECADO y EMBARCADO (ADR-117).
-- Sólo las columnas que Kepler cambia en cada captura, medidas en GP.12.0a (foto antes/después del 19-nov, 71
-- cambios de estatus, FASE_GP_PLAN §2.2):
--   SURTIDO   kdm1: c11 c69 c67 c100 c30 c88 c83 c84 (+ c13–c16 y c42 si algo bajó)   kdm2: c52 c59 c62 c63 c7
--   CHECADO   kdm1: c11 c69 c102 c83 c84 (+ recálculo)                                  kdm2: c53 c60 c7 (+ INSERT)
--   EMBARCADO kdm1: c11 c69 c43 c85 c103                                                kdm2: c54 c61
-- Lo que NO se da, a propósito:
--   · kdm1.c86 (guía) y kdm2.c24: los pone la Salida por Embarque (U-D-41), que sigue en Kepler (D26, P-GP.12).
--   · kdm1.c63 (prefijo PD-/PD26-): Kepler lo cambia a veces y no está decodificado; la Suite no lo toca.
--   · Cancelar (c43 → 'C') no es de este carril.
-- Ya existen y no se repiten aquí: SELECT e INSERT en md.kdm1/md.kdm2 (PQ.22, pq22_orden_compra.sql) y
-- DELETE en md.kdm2 (D40: 00, 01, 02, 06, 07 y 08; Padre Hidalgo, el piloto, es la 01).
-- El UPDATE repite en el WHERE el estatus leído (ADR-117): sin carrera con una captura en Kepler.
-- Qué valor va en c67/c100/c102/c103 (quién captura / responsables) es P-GP.11 y lo decide el PM: el permiso
-- no depende de esa decisión.
-- Idempotente: un GRANT repetido no cambia nada. Lo corre el PM (pide la contraseña de superusuario).
-- Correr con: node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/gp120e_estatus_pedido.sql [--aplicar]
-- verificar: SELECT has_column_privilege('kepler_push', 'md.kdm1', 'c11', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c43', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c103', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c52', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c61', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm2', 'c7', 'UPDATE') AND NOT has_column_privilege('kepler_push', 'md.kdm1', 'c86', 'UPDATE')
GRANT UPDATE (c11, c13, c14, c15, c16, c30, c42, c43, c67, c69, c83, c84, c85, c88, c100, c102, c103) ON md.kdm1 TO kepler_push;
GRANT UPDATE (c7, c52, c53, c54, c59, c60, c61, c62, c63) ON md.kdm2 TO kepler_push;
