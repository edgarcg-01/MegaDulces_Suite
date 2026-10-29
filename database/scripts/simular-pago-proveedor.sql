-- ============================================================================================
-- [PGP.34] SIMULACION DEL CIRCUITO DE PAGO A PROVEEDOR, DE PUNTA A PUNTA
--
-- Camina los 6 pasos contra los datos REALES y dice, paso por paso, si el circuito pasaria o
-- donde se detendria. ⛔ SOLO LECTURA: no escribe una sola fila, no abre transaccion de escritura.
--
--   sh ops/prod/pgprod.sh -f database/scripts/simular-pago-proveedor.sql
--   (o, desde una maquina de trabajo:
--    ssh superoot@192.168.0.222 "sh ~/ops/prod/pgprod.sh -f -" < database/scripts/simular-pago-proveedor.sql)
--
-- ## Por que existe
--
-- El circuito de pago a proveedor NUNCA cerro una vez (medido 2026-10-29: 0 de 50 pagos
-- preparados en toda la historia de la tabla). Antes de que una persona gaste una tarde
-- descubriendo donde se traba, esto lo dice en 10 segundos -- y dice tambien QUE lo destraba.
--
-- ## Las compuertas son las del codigo, citadas por archivo:linea
--
--   paso 1 Armar      (sin compuerta)
--   paso 2 Ordenar    releaseLot   libs/finance/src/lib/payment-calendar/payment-calendar.service.ts:1546
--   paso 3 Preparar   isPrepared   payment-calendar.service.ts:102-106  (+ prepare():1214-1223)
--   paso 4 Autorizar  releaseLot   payment-calendar.service.ts:1538-1557
--   paso 5 Ejecutar   execute      payment-calendar.service.ts:1337-1352
--   paso 6 Ligar      linkKepler   payment-calendar.service.ts:1319-1322
--
-- ⚠️ Es una SEGUNDA implementacion de esas compuertas, en SQL. Si el codigo cambia y esto no,
-- la cita queda colgada y la simulacion miente en verde. Al tocar cualquiera de esas lineas,
-- revisar este archivo. Lo que lo hace util igual: cruza DOS implementaciones del mismo
-- predicado, y una discrepancia entre ambas es en si misma un hallazgo.
--
-- ## Disciplina de instrumento
--
-- ⭐⭐ Arranca con CONTROLES cuya respuesta ya se conoce por otro camino. Si un control falla,
-- el instrumento se tira -- no la medicion. Dos defectos propios se cazaron asi el 2026-10-29:
-- un join que inflaba x9 (v_supplier_account_proposal es una fila por acreedor X cuenta
-- declarada, no por acreedor) y una cifra de filas reportada como si fueran acreedores.
-- ============================================================================================
\pset border 2
\pset linestyle unicode
\set ON_ERROR_STOP on

\echo ''
\echo '################ CONTROLES DEL INSTRUMENTO ################'
\echo 'Respuestas que ya se conocen por otro camino. Si alguna falla, NO creer lo que sigue.'
\echo ''

SELECT 'C1 · base correcta (system_identifier)' AS control,
       (SELECT system_identifier::text FROM pg_control_system()) AS medido,
       '7688376744939610156' AS esperado,
       CASE WHEN (SELECT system_identifier::text FROM pg_control_system()) = '7688376744939610156'
            THEN 'OK' ELSE '*** NO ES PRODUCCION ***' END AS veredicto
UNION ALL SELECT 'C2 · la vista viva cabe en el universo rehecho',
       (SELECT count(*)::text FROM analytics.v_supplier_payables v
         WHERE NOT EXISTS (SELECT 1 FROM kepler_ods.kdxe k
                 WHERE btrim(k.c1) = k.sucursal AND k.c3 = 'A'
                   AND md5('kepler_payable|'||k.sucursal||'|'||k.c4||'|'||k.c5||'|'||btrim(k.c6))::uuid
                     = md5('kepler_payable|'||v.sucursal||'|'||v.doc_tipo||'|'||v.doc_sub||'|'||v.folio)::uuid)),
       '0',
       CASE WHEN (SELECT count(*) FROM analytics.v_supplier_payables v
         WHERE NOT EXISTS (SELECT 1 FROM kepler_ods.kdxe k
                 WHERE btrim(k.c1) = k.sucursal AND k.c3 = 'A'
                   AND md5('kepler_payable|'||k.sucursal||'|'||k.c4||'|'||k.c5||'|'||btrim(k.c6))::uuid
                     = md5('kepler_payable|'||v.sucursal||'|'||v.doc_tipo||'|'||v.doc_sub||'|'||v.folio)::uuid)) = 0
            THEN 'OK' ELSE '*** LA LLAVE DERIVADA NO CRUZA ***' END;

-- Una fila por acreedor, con el MISMO orden de preferencia que la pantalla
-- (supplier-payment-accounts.service.ts:118-120). ⛔ Sin este DISTINCT ON, el join infla x9.
CREATE TEMP VIEW sim_prop AS
SELECT DISTINCT ON (proveedor_code) proveedor_code, estado, clabe_propuesta, veces_declarada
  FROM analytics.v_supplier_account_proposal
 ORDER BY proveedor_code, (estado = 'propuesta') DESC, veces_declarada DESC NULLS LAST;

-- El universo COMPLETO de facturas de proveedor (sin el filtro `pendiente > 0.005` de la vista),
-- para poder distinguir «Kepler ya no la debe» de «la llave derivo».
CREATE TEMP VIEW sim_universo AS
SELECT md5('kepler_payable|'||k.sucursal||'|'||k.c4||'|'||k.c5||'|'||btrim(k.c6))::uuid AS id,
       k.sucursal, btrim(k.c2) AS proveedor, k.c4 AS doc_tipo, k.c5 AS doc_sub,
       btrim(k.c6) AS folio, k.c11 AS importe
  FROM kepler_ods.kdxe k
 WHERE btrim(k.c1) = k.sucursal AND k.c3 = 'A';

CREATE TEMP VIEW sim_pagos AS
SELECT a.*, l.lot_date, l.status AS lot_status, l.folio AS lot_folio
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.status = 'pending';

\echo ''
\echo '################ PASO A PASO, LOTE POR LOTE ################'
\echo 'Compuertas: releaseLot:1546 (orden) e isPrepared:102-106 (preparado).'
\echo ''

SELECT to_char(lot_date,'YYYY-MM-DD') AS dia, lot_status AS lote,
       count(*)::int AS vivos,
       to_char(sum(amount_assigned),'FM$999,999,999.00') AS importe,
       CASE WHEN count(*) FILTER (WHERE priority_rank IS NULL) > 0
              THEN 'PASO 2 · ' || count(*) FILTER (WHERE priority_rank IS NULL) || ' sin orden'
            WHEN count(*) FILTER (WHERE NOT (
                   payment_method IS NOT NULL
               AND (payment_method = 'efectivo' OR bank_account_id IS NOT NULL)
               AND (payment_method <> 'transferencia' OR coalesce(btrim(destination_account_text),'') <> ''))) > 0
              THEN 'PASO 3 · ' || count(*) FILTER (WHERE NOT (
                   payment_method IS NOT NULL
               AND (payment_method = 'efectivo' OR bank_account_id IS NOT NULL)
               AND (payment_method <> 'transferencia' OR coalesce(btrim(destination_account_text),'') <> ''))) || ' sin preparar'
            ELSE 'pasa el 3 · revisar autorizacion' END AS se_detiene_en
  FROM sim_pagos GROUP BY 1, 2 ORDER BY 1;

\echo ''
\echo '################ PASO 3 · QUE LE FALTA A CADA PAGO ################'
\echo ''

SELECT CASE WHEN payment_method IS NULL THEN 'el metodo de pago'
            WHEN payment_method <> 'efectivo' AND bank_account_id IS NULL THEN 'la cuenta de origen'
            WHEN payment_method = 'transferencia' AND coalesce(btrim(destination_account_text),'') = ''
                 THEN 'la cuenta DESTINO del proveedor'
            WHEN payment_method = 'cheque'   AND coalesce(btrim(reference_text),'') = ''     THEN 'el folio del cheque'
            WHEN payment_method = 'efectivo' AND coalesce(btrim(cash_register_text),'') = '' THEN 'la caja de salida'
            ELSE '(preparado)' END AS le_falta,
       count(*)::int AS pagos,
       to_char(sum(amount_assigned),'FM$999,999,999.00') AS importe
  FROM sim_pagos GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '--- la causa raiz, medida ---'
\echo ''

SELECT 'cuentas de proveedor activas en el catalogo' AS recurso,
       (SELECT count(*) FROM commercial.supplier_payment_accounts WHERE status = 'activa')::int AS hay,
       'sin una, "transferencia" no se puede preparar: el destino es obligatorio' AS consecuencia
UNION ALL SELECT 'solicitudes de alta de cuenta',
       (SELECT count(*) FROM commercial.supplier_payment_account_change_requests)::int,
       'el circuito anti-fraude existe completo y nunca se uso'
UNION ALL SELECT 'ACREEDORES con CLABE proponible (de su propio REP)',
       (SELECT count(DISTINCT proveedor_code) FROM sim_prop WHERE estado = 'propuesta')::int,
       'la pantalla ya los ofrece con el comprobante citado: falta que alguien FIRME'
UNION ALL SELECT 'cuentas de ORIGEN que el selector ofrece',
       (SELECT count(*) FROM finance.bank_accounts WHERE active)::int,
       'incluye CAJA GENERAL desde [PGP.33]';

\echo ''
\echo '################ ¿CUANTO SE DESTRABA CON UNA FIRMA? ################'
\echo ''

WITH benef AS (
  SELECT p.id, p.amount_assigned,
         coalesce(
           (SELECT min(v.proveedor) FROM finance.payment_allocation_items i
               JOIN analytics.v_supplier_payables v
                 ON md5('kepler_payable|'||v.sucursal||'|'||v.doc_tipo||'|'||v.doc_sub||'|'||v.folio)::uuid = i.obligation_id
              WHERE i.allocation_id = p.id AND i.obligation_source = 'kepler_payable'),
           (SELECT min(s.code) FROM finance.payment_allocation_items i
               JOIN commercial.supplier_payment_obligations o ON o.id = i.obligation_id
               JOIN catalog.suppliers s ON s.id = o.supplier_id
              WHERE i.allocation_id = p.id AND i.obligation_source = 'supplier_payable')) AS proveedor_code
    FROM sim_pagos p)
SELECT CASE WHEN pr.estado = 'propuesta'         THEN 'DESTRABABLE HOY · su REP trae la CLABE verificada'
            WHEN pr.estado = 'solo_cuenta_corta' THEN 'NO · declaro cuenta de 10 digitos, no CLABE (falta la plaza)'
            WHEN pr.estado = 'sin_rep'           THEN 'NO · nunca nos timbro un REP con cuenta'
            WHEN pr.estado IS NULL               THEN 'NO · su factura ya no esta viva: no hay acreedor que cruzar'
            ELSE 'NO · ' || pr.estado END AS situacion,
       count(*)::int AS pagos,
       to_char(sum(b.amount_assigned),'FM$999,999,999.00') AS importe,
       count(*) FILTER (WHERE h.metodo_sugerido  IS NOT NULL)::int AS metodo_precargado,
       count(*) FILTER (WHERE h.cuenta_origen_id IS NOT NULL)::int AS origen_precargado
  FROM benef b
  LEFT JOIN sim_prop pr ON pr.proveedor_code = b.proveedor_code
  LEFT JOIN analytics.v_supplier_payment_habit h ON h.proveedor_code = b.proveedor_code
 GROUP BY 1 ORDER BY sum(b.amount_assigned) DESC;

\echo ''
\echo '################ PASO 5 · LO QUE FALLARIA AUNQUE TODO LO DEMAS PASARA ################'
\echo 'execute():1346-1352 revalida que Kepler TODAVIA deba cada factura. Entre asignar y'
\echo 'ejecutar pueden pasar dias, y una factura pagada por fuera no se vuelve a pagar.'
\echo ''

WITH vig AS (
  SELECT i.allocation_id,
         bool_and(CASE WHEN i.obligation_source = 'kepler_payable'
                       THEN EXISTS (SELECT 1 FROM analytics.v_supplier_payables v
                             WHERE md5('kepler_payable|'||v.sucursal||'|'||v.doc_tipo||'|'||v.doc_sub||'|'||v.folio)::uuid = i.obligation_id)
                       ELSE true END) AS todas_vigentes
    FROM finance.payment_allocation_items i
    JOIN sim_pagos p ON p.id = i.allocation_id
   GROUP BY 1)
SELECT CASE WHEN vig.todas_vigentes THEN 'pasaria el control de saldo'
            ELSE 'FALLARIA · Kepler ya no debe alguna de sus facturas' END AS veredicto,
       count(*)::int AS pagos,
       to_char(sum(p.amount_assigned),'FM$999,999,999.00') AS importe
  FROM vig JOIN sim_pagos p ON p.id = vig.allocation_id
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '--- y de esas, ¿Kepler ya no la debe, o la llave derivo? ---'
\echo 'Si saliera "llave sin documento", el defecto seria NUESTRO y grave:'
\echo 'kepler-payable-key.contract.ts:22 lo describe como "un saldo que no baja".'
\echo ''

SELECT CASE WHEN u.id IS NOT NULL
            THEN '(a) la factura EXISTE en Kepler con saldo 0: se pago por fuera o tiene nota de credito'
            ELSE '(b) *** llave sin documento: LA LLAVE DERIVO, es defecto nuestro ***' END AS hipotesis,
       count(*)::int AS lineas,
       to_char(sum(i.applied_amount),'FM$999,999,999.00') AS importe
  FROM finance.payment_allocation_items i
  JOIN sim_pagos p ON p.id = i.allocation_id
  LEFT JOIN sim_universo u ON u.id = i.obligation_id
 WHERE i.obligation_source = 'kepler_payable'
   AND NOT EXISTS (SELECT 1 FROM analytics.v_supplier_payables v
                    WHERE md5('kepler_payable|'||v.sucursal||'|'||v.doc_tipo||'|'||v.doc_sub||'|'||v.folio)::uuid = i.obligation_id)
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '################ PASO 6 · LIGAR AL X-D-26 ################'
\echo ''

SELECT 'el pago tiene que estar EJECUTADO (linkKepler:1319)' AS compuerta,
       CASE WHEN (SELECT count(*) FROM finance.payment_allocations WHERE status = 'executed') > 0
            THEN 'PASA' ELSE 'FALLA' END AS veredicto,
       (SELECT count(*) FROM finance.payment_allocations WHERE executed_at IS NOT NULL)::text ||
       ' pagos ejecutados en toda la historia de la tabla' AS dato
UNION ALL
SELECT 'escribir el X-D-26 desde la Suite (objetivo O3)', 'BLOQUEADO',
       'kepler_push no tiene privilegio sobre md.kdxe ni md.kdxf (medido 2026-10-22): faltan dos GRANT del dueno de Kepler';
