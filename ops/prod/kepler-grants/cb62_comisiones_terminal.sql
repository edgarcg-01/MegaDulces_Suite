-- [CB.62] La Suite captura en Kepler las comisiones de la terminal: solicitud X-A-15 + gasto X-A-10 por sucursal,
-- banco y día de venta, y un pago X-D-26 por cada cargo del banco (FASE_CB_CONCILIACION_BANCARIA.md §9).
-- Va en las sucursales 01–08: cada una captura sus comisiones en su propio Kepler. CEDIS (00) no: sus cuotas de
-- banco son otra forma de gasto (203 / 702-002), fuera de CB.62.
--
-- ⭐ SEGURO QUITADO EL 2026-11-26. La lista de tablas ya NO es una hipótesis: CB.62 no inventa un escritor, usa los
-- TRES que ya cerraron su lista con una captura real contra el Kepler vivo, y este archivo es exactamente la unión
-- de sus permisos, sin una tabla de más:
--
--   · solicitud X-A-15 → pgp122_solicitud_gasto.sql   (kdm1, kdm6, el contador sqliov KFXA1501.NN)
--   · gasto     X-A-10 → pgp123_comprobacion_gasto.sql (+ kdxe, póliza D, kdc126, kdcn26, kdxg, el contador
--                        KFXA1001.NN, y la solicitud a F con saldo 0: UPDATE sólo de c42 y c43)
--   · pago      X-D-26 → pgp106_pago_proveedor.sql    (+ kdm5, póliza E, kdxf, kdxg, kdc126, y el saldo de la
--                        CxP: UPDATE sólo de kdxe.c20)
--
-- ⛔ Lo que esto CORRIGE del borrador anterior: decía `GRANT INSERT ON md.kdm6, md.kdxe, md.kdxf` y ninguna sobre
--    `md.kdm5`. Medido en el ODS el 2026-11-26: los **2,194 de 2,194** pagos X-D-26 a un banco (GB…) de oct–nov
--    llevan su renglón `kdm5`. Un escritor hecho con el plan propio de CB.62 habría parido 2,194 pagos mancos.
-- ⛔ Dar el permiso NO enciende nada. La escritura lleva, además: el interruptor global
--    `KEPLER_COMISIONES_TERMINAL=encendida` (apagado por default), los tres de los escritores que usa
--    (`KEPLER_GASTO_SOLICITUD`, `KEPLER_GASTO_COMPROBACION`, `KEPLER_PAGO_ESCRITURA`), sus plantillas por servidor
--    y el renglón `comisiones_terminal` de `commercial.kepler_push_switch`.
-- ⚠️ La póliza vive en UNA TABLA POR MES (kdc2AAMM): igual que pgp106 y pgp123, se da sobre la del mes en curso y
--    la del siguiente si ya existen, y hay que volver a correrlo cada mes.
--
-- Correr (runbook KEPLER_PUSH_DESPLIEGUE.md §14: desde md como `postgres`; la contraseña la teclea una persona):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cb62_comisiones_terminal.sql --servidores 01,02,03,04,05,06,07,08
--   … --aplicar
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdm1', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm5', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm6', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxe', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxf', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxg', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdc126', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdcn26', 'INSERT');

-- Los documentos y sus renglones (kdm5 es del pago; kdm6, de la solicitud y del gasto).
GRANT SELECT, INSERT ON md.kdm1, md.kdm5, md.kdm6 TO kepler_push;

-- La cuenta por pagar del gasto y la aplicación de cada pago contra ella.
GRANT SELECT, INSERT ON md.kdxe, md.kdxf TO kepler_push;
-- El saldo de la CxP, y SÓLO esa columna (pgp106: el pago lo baja hasta 0).
GRANT UPDATE (c20) ON md.kdxe TO kepler_push;
-- La solicitud aplicada por su gasto, y SÓLO esas dos columnas (pgp123: c42 = 0, c43 = 'F').
GRANT UPDATE (c42, c43) ON md.kdm1 TO kepler_push;

-- Los contadores de folio (KFXA1501.NN de la solicitud y KFXA1001.NN del gasto): leer y avanzar, sólo c4.
GRANT SELECT ON md.sqliov TO kepler_push;
GRANT UPDATE (c4) ON md.sqliov TO kepler_push;

-- Acumulados: el acreedor y la cuenta se actualizan; el ejercido por centro de costo puede estrenar celda.
GRANT SELECT, UPDATE ON md.kdxg, md.kdc126 TO kepler_push;
GRANT SELECT, INSERT, UPDATE ON md.kdcn26 TO kepler_push;

-- Catálogos que los escritores LEEN: acreedor, tipos de póliza, conceptos de pago y de gasto, bancos,
-- departamentos (y sus padres, para kdcn26) y proyectos.
GRANT SELECT ON md.kdxd, md.kdmm, md.kdxv, md.kdb1, md.kdco, md.kdc3, md.kdcp TO kepler_push;

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
