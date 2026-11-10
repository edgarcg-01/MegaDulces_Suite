-- [CB.62] La Suite captura en Kepler las comisiones de la terminal: solicitud X-A-15 + gasto X-A-10 por sucursal,
-- banco y día de venta, y un pago X-D-26 por cada cargo del banco (FASE_CB_CONCILIACION_BANCARIA.md §9).
-- Va en las sucursales 01–08: cada una captura sus comisiones en su propio Kepler. CEDIS (00) no: sus cuotas de
-- banco son otra forma de gasto (203 / 702-002), fuera de CB.62.
--
-- Lo que ya está MEDIDO en el ODS (§9.2): kdm1 (los tres documentos), kdm6 (renglones 611-003 de solicitud y
-- gasto), kdxe (renglón A del gasto y D de cada pago), kdxf (cada pago aplicado al gasto), la póliza kdc2AAMM
-- (D del gasto, E de cada pago). Lo que falta CERRAR con una captura real y la foto de contadores
-- (ops/prod/ensayo-pago-kepler/foto-contadores.js): los acumulados (kdxg, kdc126, kdcn26) y cualquier tabla que el
-- ODS no replica (al aplicar un gasto se vio también `sqliov`, sin decodificar).
--
-- ⛔ BORRADOR CON SEGURO: la primera sentencia aborta. Se quita SÓLO cuando la foto cierre la lista, y se ajustan
--    las líneas de abajo a lo que la foto diga (ni una tabla de más: la autorización no reemplaza medir).
-- ⛔ Dar el permiso NO enciende nada: la escritura de CB.62 todavía no existe en código (CB.62.4) y llevará su
--    propio interruptor, apagado por defecto.
-- ⚠️ La póliza vive en UNA TABLA POR MES (kdc2AAMM): igual que pgp106, se da sobre la del mes en curso y la del
--    siguiente si ya existen, y hay que volver a correrlo cada mes.
--
-- Correr (runbook KEPLER_PUSH_DESPLIEGUE.md §14: desde md como `postgres`; la contraseña la teclea una persona):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cb62_comisiones_terminal.sql --servidores 01,02,03,04,05,06,07,08
--   … --aplicar
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdm1', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm6', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxe', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxf', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxg', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdc126', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdcn26', 'UPDATE')

DO $$ BEGIN
  RAISE EXCEPTION '[CB.62] borrador: la lista de tablas se cierra con la foto de una captura real (CB.62.3); no se aplica antes';
END $$;

GRANT SELECT, INSERT ON md.kdm1, md.kdm6, md.kdxe, md.kdxf TO kepler_push;   -- los tres documentos, sus renglones, CxP y aplicaciones
GRANT SELECT, UPDATE ON md.kdxg, md.kdc126, md.kdcn26 TO kepler_push;          -- acumulados: acreedor, cuenta, centro de costo (A CONFIRMAR con la foto)
GRANT SELECT ON md.kdxd, md.kdmm, md.kdxv, md.kdb1, md.kdco, md.kdc3, md.kdcp TO kepler_push;  -- acreedor, tipos, conceptos, bancos, cuentas, departamentos, proyectos

-- La póliza del mes en curso y la del siguiente (kdc2AAMM), sólo si existen.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kdc2' || to_char(now(), 'YYMM'), 'kdc2' || to_char(now() + interval '1 month', 'YYMM')] LOOP
    IF to_regclass('md.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT ON md.%I TO kepler_push', t);
      RAISE NOTICE 'póliza: permiso sobre md.%', t;
    ELSE
      RAISE NOTICE 'póliza: md.% todavía no existe (se crea al primer movimiento del mes)', t;
    END IF;
  END LOOP;
END $$;
