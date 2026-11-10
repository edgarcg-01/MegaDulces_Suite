-- [PGP.106] La Suite escribe el pago a proveedor (X-D-26) en Kepler: las 8 escrituras que hace una
-- transferencia capturada en Kepler (deducidas por ingeniería inversa, FASE_PGP_PAGO_A_PROVEEDOR.md,
-- «lo que escribe una transferencia a proveedor», 2026-11-04):
--   1 INSERT kdm1 (el documento) · 2 INSERT kdm5 (un renglón por factura) · 3 INSERT kdxe (renglón D)
--   4 INSERT kdxf (aplicaciones) · 5 UPDATE kdxe.c20 (saldo de la factura, SÓLO esa columna)
--   6 UPDATE kdxg (acumulado del acreedor por mes) · 7 INSERT kdc2AAMM (póliza del mes)
--   8 UPDATE kdc126 (acumulados de la cuenta por mes)
-- Más la lectura que necesita el armador: acreedor (kdxd), tipos (kdmm), conceptos (kdxv), bancos (kdb1).
--
-- ⛔ Dar el permiso NO enciende nada: la escritura sigue apagada por KEPLER_PAGO_ESCRITURA (≠ 'encendida'),
--    por KEPLER_PAGO_TEMPLATE_FOLIO_NN y por la compuerta de la Suite (día autorizado + pago validado con
--    banco y comprobante, [PGP.104]). El adaptador hoy escribe 1, 3, 4 y 5; 2, 6, 7 y 8 faltan en código.
-- ⚠️ La póliza vive en UNA TABLA POR MES (kdc2AAMM): esto da el permiso sobre la del mes en curso y la
--    del siguiente si ya existen. Hay que volver a correrlo cada mes (o cuando Kepler cree la tabla nueva).
-- ⚠️ Pregunta abierta al proveedor de Kepler: si su motor de documentos (kdmx_26 / k_docXml) se puede
--    llamar desde fuera, este permiso sobre tablas contables sobra.
--
-- Correr con (primero sólo CEDIS, que es de donde salen los pagos a proveedor):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp106_pago_proveedor.sql --servidores 00
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp106_pago_proveedor.sql --servidores 00 --aplicar
-- verificar: SELECT has_table_privilege('kepler_push', 'md.kdxe', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdxf', 'INSERT') AND has_table_privilege('kepler_push', 'md.kdm5', 'INSERT') AND has_column_privilege('kepler_push', 'md.kdxe', 'c20', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdxg', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdc126', 'UPDATE') AND has_table_privilege('kepler_push', 'md.kdmm', 'SELECT')

GRANT SELECT, INSERT ON md.kdm1, md.kdm5, md.kdxe, md.kdxf TO kepler_push;   -- 1 2 3 4: el documento, sus renglones y aplicaciones
GRANT UPDATE (c20)   ON md.kdxe TO kepler_push;                             -- 5: el saldo de la factura, y sólo esa columna
GRANT SELECT, UPDATE ON md.kdxg, md.kdc126 TO kepler_push;                  -- 6 8: acumulados del acreedor y de la cuenta
GRANT SELECT ON md.kdxd, md.kdmm, md.kdxv, md.kdb1 TO kepler_push;          -- acreedor, tipos, conceptos, bancos

-- 7: la póliza del mes en curso y la del siguiente (kdc2AAMM), sólo si existen.
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
