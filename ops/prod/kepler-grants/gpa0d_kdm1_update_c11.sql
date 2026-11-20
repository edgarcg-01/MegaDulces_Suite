-- [GP.A.0d] La Suite puede autorizar un pedido TELEMARK en Kepler: CREADO -> AUTORIZADO, y regresarlo (D-A7).
-- Sólo la columna del estatus (kdm1.c11): autorizar en Kepler no toca otra cosa (GP.A.0a, medido: 8 casos
-- de la foto del 19-nov, ni renglones, ni existencia, ni cartera). No puede cambiar importes ni renglones.
-- El UPDATE repite en el WHERE el estatus leído (ADR-117), así que también necesita LEER c11: kepler_push
-- ya lee md.kdm1 por el carril del pedido TELEMARK (COT.7); la comprobación pide los dos permisos.
-- Lo corre el PM (pide la contraseña de superusuario).
-- Correr con: node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/gpa0d_kdm1_update_c11.sql [--aplicar]
-- verificar: SELECT has_column_privilege('kepler_push', 'md.kdm1', 'c11', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c11', 'SELECT')
GRANT UPDATE (c11) ON md.kdm1 TO kepler_push;
