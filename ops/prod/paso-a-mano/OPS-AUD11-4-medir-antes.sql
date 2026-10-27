-- =============================================================================
-- [OPS-AUD.11.4] MEDIR ANTES DE APLICAR — sólo lectura (termina en ROLLBACK).
--
-- La migración 20261027153139 cambia de dónde leen Caja General y Bancos: de recorrer kdm1
-- (o de la materializada que se refresca cada minuto) a la tabla que mantiene el trigger.
-- Esto mide, con la forma NUEVA armada como vista temporal, sin tocar nada:
--   1. paridad: la vista nueva contra la vieja, fila por fila (debe dar 0 y 0);
--   2. cuánto tarda leer la caja HOY (materializada) y cuánto con la forma nueva;
--   3. la bandeja de pendientes con la forma nueva (lo que abre la pantalla).
-- Regla del proyecto: una consulta de más de 500 ms no funciona.
--
--   k3s kubectl -n prod exec -i deploy/pg-prod -- psql -U postgres -d railway -v ON_ERROR_STOP=1 < OPS-AUD11-4-medir-antes.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\timing on
BEGIN;  -- no READ ONLY: Postgres no deja crear ni una vista temporal así. Termina en ROLLBACK.
SET LOCAL statement_timeout = '120s';

-- La forma nueva, IGUAL a la de la migración (VIEW_SQL), como vista temporal.
CREATE TEMP VIEW _kbm_nueva AS
  WITH kb AS (
    SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre, btrim(c5) cta,
           CASE WHEN btrim(c5) NOT LIKE '102%' THEN 'puente'
                WHEN upper(btrim(coalesce(c3, ''))) = 'EFECTIVO' THEN 'caja'
                ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>''
     ORDER BY btrim(c1), sucursal
  ),
  xw AS (
    SELECT kb.clave,
      COALESCE(
        (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id='00000000-0000-0000-0000-00000000d01c'::uuid AND ba.account_label=kb.clave LIMIT 1),
        CASE WHEN kb.clave='0011' THEN 'CG' END,
        (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id='00000000-0000-0000-0000-00000000d01c'::uuid AND length(ba.account_label)>=3
           AND kb.clave LIKE '%'||ba.account_label AND kb.clave<>ba.account_label ORDER BY length(ba.account_label) DESC LIMIT 1)
      ) AS account_label
    FROM kb
  )
  SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    l.sucursal, l.doc_tipo, l.folio, l.clave_banco,
    kb.cta AS cuenta_contable, kb.nombre AS banco_nombre, kb.tipo AS tipo_cuenta,
    l.flujo, l.importe, l.signo, l.fecha_valor, l.fecha_captura,
    l.concepto, l.metodo, l.beneficiario, l.es_traspaso, l.contra_clave, l.pierna,
    xw.account_label, now() AS computed_at, l.entidad_code,
    pc.fecha_pago AS fecha_pago_sat, COALESCE(pc.fecha_pago, l.fecha_valor) AS fecha_efectiva
  FROM analytics.bank_movement_legs l
  LEFT JOIN kb ON kb.clave = l.clave_banco
  LEFT JOIN xw ON xw.clave = l.clave_banco
  LEFT JOIN analytics.v_kepler_payment_complement pc
    ON pc.sucursal = l.sucursal AND pc.doc_tipo = l.doc_tipo AND pc.folio = l.folio;

\echo '1 · paridad vieja vs nueva, sin computed_at (debe dar 0 · 0)'
WITH v AS (SELECT tenant_id, sucursal, doc_tipo, folio, clave_banco, cuenta_contable, banco_nombre, tipo_cuenta, flujo, importe, signo, fecha_valor, fecha_captura, concepto, metodo, beneficiario, es_traspaso, contra_clave, pierna, account_label, entidad_code, fecha_pago_sat, fecha_efectiva FROM analytics.kepler_bank_movements),
     n AS (SELECT tenant_id, sucursal, doc_tipo, folio, clave_banco, cuenta_contable, banco_nombre, tipo_cuenta, flujo, importe, signo, fecha_valor, fecha_captura, concepto, metodo, beneficiario, es_traspaso, contra_clave, pierna, account_label, entidad_code, fecha_pago_sat, fecha_efectiva FROM _kbm_nueva)
SELECT (SELECT count(*) FROM (SELECT * FROM v EXCEPT ALL SELECT * FROM n) a) AS faltan,
       (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM v) b) AS sobran,
       (SELECT count(*) FROM v) AS filas;

\echo '2a · caja HOY (materializada)'
SELECT count(*), round(sum(importe),2) FROM analytics.mv_caja_movimientos;
\echo '2b · caja con la forma NUEVA (lo que costará cada lectura)'
SELECT count(*), round(sum(importe),2) FROM _kbm_nueva WHERE tipo_cuenta = 'caja';
\echo '2c · tesorería entera con la forma NUEVA, un mes (lo que lee Bancos)'
SELECT count(*) FROM _kbm_nueva WHERE fecha_valor >= date_trunc('month', now())::date;
\echo '2d · tesorería entera HOY (vista que recorre kdm1), mismo mes'
SELECT count(*) FROM analytics.kepler_bank_movements WHERE fecha_valor >= date_trunc('month', now())::date;

\echo '3 · la bandeja de pendientes con la forma NUEVA (lo que abre la pantalla)'
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-00000000d01c', true);
SELECT count(*), round(sum(k.importe),2)
  FROM _kbm_nueva k
 WHERE k.tipo_cuenta = 'caja' AND k.signo <> 0 AND k.es_traspaso = false AND k.importe > 0
   AND NOT EXISTS (SELECT 1 FROM finance.cash_ledger l
                    WHERE l.tenant_id = k.tenant_id
                      AND l.origen_tipo = CASE WHEN k.signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END
                      AND l.origen_ref  = k.sucursal || '|' || k.doc_tipo || '|' || k.folio || '|' || k.clave_banco
                      AND l.deleted_at IS NULL AND l.estado <> 'cancelado');
\echo '3b · la misma bandeja HOY'
SELECT count(*), round(sum(monto),2) FROM finance.v_caja_movimientos_pendientes;

ROLLBACK;
