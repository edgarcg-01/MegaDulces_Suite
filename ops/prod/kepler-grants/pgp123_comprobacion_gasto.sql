-- [PGP.123] La Suite ESCRIBE en Kepler la comprobación del gasto (X-A-10 «Alta gasto CFDI») de una solicitud viva,
-- con su póliza D y sus acumulados. Plan: docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md §3 y §5.3.
--
-- Las 9 escrituras (medidas en el ODS, 1,922 X-A-10 vivos de oct–nov 2026):
--   1 INSERT kdm1        — el gasto (clon de su X-A-15).            2 INSERT kdm6 — sus renglones (clon).
--   3 UPDATE kdm1 (c42, c43) — la X-A-15 a 'F' con saldo 0. El candado de la fila (SELECT … FOR UPDATE) pide
--                          UPDATE sobre al menos una columna: son éstas dos, y sólo éstas.
--   4 UPDATE sqliov.c4   — el contador de folios KFXA1001.NN, y SÓLO esa columna.
--   5 INSERT kdxe        — la cuenta por pagar que después salda el pago (X-D-26).
--   6 INSERT kdc2AAMM    — la póliza D del mes (DG1: siempre el mes en curso).
--   7 UPDATE kdc126      — cargos y abonos del mes por cuenta y su mayor (dos juegos).
--   8 INSERT/UPDATE kdcn26 — el ejercido por centro de costo (concepto × departamento × proyecto × mes).
--   9 UPDATE kdxg        — el cargo del mes del acreedor.
-- Más la lectura: el tipo de póliza y sus cuentas (kdmm) y los departamentos padre (kdc3).
--
-- ⛔ Dar el permiso NO enciende nada: la escritura sigue apagada por KEPLER_GASTO_COMPROBACION (≠ 'encendida'),
--    por el interruptor 'comprobacion_gasto' de commercial.kepler_push_switch (sembrado apagado, tope 1) y, en
--    00/01/03/06/08, por DG7 (el número de la póliza D lleva un contador que la Suite todavía no ve: G.1).
--    El ensayo (ROLLBACK) SÍ lo necesita para correr completo.
-- ⚠️ El GRANT es por tabla y columna, no por tipo de documento: INSERT en kdm1/kdm6/kdxe sirve para cualquier
--    documento. Lo único que lo acota al X-A-10 es el código (KeplerGastoSinkAdapter) y el interruptor.
-- ⚠️ La póliza vive en UNA TABLA POR MES (kdc2AAMM): esto da el permiso sobre la del mes en curso y la del
--    siguiente si ya existen. Hay que volver a correrlo cada mes (o cuando Kepler cree la tabla nueva).
-- ⚠️ Lo que Kepler además toque al capturar un X-A-10 lo cierra la captura de prueba (anexo §8, G.1). Si aparece
--    otra tabla (la cuadrícula del UUID: kdfecfdcom / kdcecfdpol), se agrega aquí antes de encender.
--
-- Correr con (05 primero: es el canario; su póliza D numera con una sola secuencia por mes):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql --servidores 05
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql --servidores 05 --aplicar
--   (después: --servidores 07,02,04 · los otros cinco, cuando G.1 resuelva DG7)
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdm1', 'INSERT') AND has_column_privilege('kepler_push', 'md.kdm1', 'c42', 'UPDATE') AND has_column_privilege('kepler_push', 'md.kdm1', 'c43', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdm6', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxe', 'INSERT') AND has_column_privilege('kepler_push', 'md.sqliov', 'c4', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdc126', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdcn26', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdcn26', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdxg', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdmm', 'SELECT') AND has_table_privilege('kepler_push', 'md.kdc3', 'SELECT')

GRANT SELECT, INSERT ON md.kdm1, md.kdm6, md.kdxe TO kepler_push;   -- 1 2 5: el gasto, sus renglones y su cuenta por pagar
GRANT UPDATE (c42, c43) ON md.kdm1 TO kepler_push;                 -- 3: la solicitud aplicada, y sólo esas dos columnas
GRANT SELECT ON md.sqliov TO kepler_push;                          -- leer el contador
GRANT UPDATE (c4) ON md.sqliov TO kepler_push;                     -- 4: avanzarlo, y sólo esa columna
GRANT SELECT, UPDATE ON md.kdc126, md.kdxg TO kepler_push;         -- 7 9: acumulados de la cuenta y del acreedor
GRANT SELECT, INSERT, UPDATE ON md.kdcn26 TO kepler_push;          -- 8: el ejercido (la celda nueva se inserta)
GRANT SELECT ON md.kdmm, md.kdc3 TO kepler_push;                   -- el tipo de póliza y sus cuentas; los departamentos

-- 6: la póliza del mes en curso y la del siguiente (kdc2AAMM), sólo si existen.
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
