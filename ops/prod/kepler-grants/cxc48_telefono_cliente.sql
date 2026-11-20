-- [CXC.48] La Suite corrige el teléfono del cliente en Kepler: kdud.c7 en cada sucursal donde está su clave, y
-- deja el renglón de bitácora (kdlogmov) con la columna 7, el nuevo y el anterior, como la forma de clientes.
--
-- Lo que necesita kepler_push, y nada más (medido el 2026-11-20: hoy no tiene NINGÚN permiso sobre kdud ni kdlogmov
-- en las 9 bases, ni siquiera SELECT):
--   · SELECT en md.kdud — leer la fila (FOR UPDATE) y saber si la clave está en esa base
--   · UPDATE (c7) en md.kdud — el teléfono, y sólo esa columna
--   · INSERT en md.kdlogmov — el rastro en la bitácora de Kepler
--
-- ⛔ Dar el permiso NO enciende nada: la escritura sigue apagada por commercial.kepler_push_switch (tipo
--    telefono_cliente, encendida = false en las 9) y por la llave FINANCE_CARTERA_TELEFONOS.
--
-- Correr con (primero revisar, luego aplicar):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cxc48_telefono_cliente.sql
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cxc48_telefono_cliente.sql --aplicar
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdud', 'SELECT') AND has_column_privilege('kepler_push', 'md.kdud', 'c7', 'UPDATE') AND NOT has_column_privilege('kepler_push', 'md.kdud', 'c3', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdlogmov', 'INSERT')

GRANT SELECT     ON md.kdud     TO kepler_push;   -- leer la ficha (y bloquear la fila al cambiarla)
GRANT UPDATE (c7) ON md.kdud    TO kepler_push;   -- el teléfono, y sólo esa columna
GRANT INSERT     ON md.kdlogmov TO kepler_push;   -- el rastro en la bitácora de Kepler
