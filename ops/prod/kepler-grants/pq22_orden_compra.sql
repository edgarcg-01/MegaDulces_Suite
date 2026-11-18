-- [PQ.22] La Suite escribe la COMPRA en Kepler: la requisición X-A-30 y, con `genera_orden`, su OC
-- X-A-35, en la misma transacción. Son los permisos que el alta del rol ya declaraba
-- (ops/prod/kepler-push-secretos.js, [KR.14]) y que en cada servidor tenía que correr un superusuario.
-- Sólo lectura de lo que el adaptador consulta + INSERT de los dos documentos: ni UPDATE ni DELETE.
--   SELECT md.kdm1, md.kdm2   — el freno contra el duplicado y el folio siguiente
--   SELECT md.pv_suc_ip       — la sucursal del servidor
--   SELECT md.kdxd            — el proveedor (clave y nombre)
--   SELECT md.kdii            — la ficha del producto: unidad base, caja y tasas IVA/IEPS
--   INSERT md.kdm1, md.kdm2   — el documento y sus renglones
--
-- Por qué ahora (medido en prod el 2026-11-11, compras de 30 días por sucursal):
--   8 Esquinas (03)   0 enviadas · 3 rechazadas «permiso denegado a la tabla kdii»  (RQ-2026-02443 …)
--   Yurécuaro (04)    0 enviadas · 1 rechazada  «permiso denegado a la tabla kdxd»  (RQ-2026-02441)
--   Zamora Centro (05) sin intentos: no se sabe si le falta
--   00, 01, 02, 06, 07, 08 escriben (01, 06 y 07 recibieron kdxd/kdii a mano el 2026-10-28)
--
-- ⛔ Dar el permiso NO enciende nada: la compra a Kepler se enciende por sucursal en
--    /compras/kepler-escritura. Lo rechazado se reintenta solo cada 30 min (PQ.26) con el freno
--    contra el duplicado (si alguien ya hizo la OC a mano, no se reenvía).
-- Idempotente: un GRANT repetido no cambia nada.
--
-- Correr DESDE md con `sa`, dentro del pod `api` (runbook KEPLER_PUSH_DESPLIEGUE §14.2, «Desde md»):
--   node /tmp/k.js /tmp/g.sql --usuario sa --servidores 03,04,05              (revisa)
--   node /tmp/k.js /tmp/g.sql --usuario sa --servidores 03,04,05 --aplicar    (aplica y comprueba)
-- ⚠️ Al 2026-11-06 el pg_hba de 03/04/05 rechazaba a `sa` desde md; si sigue así, el script lo dice por
--    servidor y hay que agregar `host md_NN sa 192.168.0.222/32 md5` + `SELECT pg_reload_conf();`.
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdii', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdxd', 'SELECT') AND has_table_privilege('kepler_push', 'md.pv_suc_ip', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdm1', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdm2', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdm1', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm2', 'INSERT')

GRANT USAGE ON SCHEMA md TO kepler_push;
GRANT SELECT ON md.kdm1, md.kdm2, md.pv_suc_ip, md.kdxd, md.kdii TO kepler_push;
GRANT INSERT ON md.kdm1, md.kdm2 TO kepler_push;
