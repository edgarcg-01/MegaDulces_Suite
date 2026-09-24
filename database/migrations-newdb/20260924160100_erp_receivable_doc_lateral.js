/**
 * [PERF.4b] La cartera se resuelve POR DOCUMENTO, no construyendo la piramide entera.
 *
 * ── El sintoma ───────────────────────────────────────────────────────────────────────────
 * Tres consultas de pantalla sobre analytics.erp_sales_invoices (el panel de facturacion de
 * Televenta y las listas de commercial-sales-documents) tardaban **43,699 / 43,989 / 49,367 ms
 * de promedio** en prod. El proyecto tiene un gate explicito: mas de 1 s de carga es "no
 * funciona". Estas tardaban 44 segundos.
 *
 * ── La causa raiz, medida ────────────────────────────────────────────────────────────────
 * La vista hace LEFT JOIN analytics.erp_receivable_documents. Esa vista es una piramide de CTEs
 * (un DISTINCT ON sobre 56,046 filas de kdue mas un agregado sobre kdm5) que **no admite
 * pushdown**: se construye entera, siempre.
 *
 * Y el planificador elige Nested Loop porque estima el lado de facturas en **1 fila cuando trae
 * 1,033**. Medido con EXPLAIN ANALYZE:
 *
 *     CTE Scan on src r  (actual rows=17609, loops=1038)   <-- la cartera entera, 1,038 veces
 *
 * De donde sale el rows=1, predicado por predicado:
 *     c4 IN (8,12) .......................................... rows=4,762
 *     + (c9)::date >= current_date-30 ....................... rows=1,587   (bien: hay indice)
 *     + btrim(c1) = btrim(sucursal) ......................... rows=8       (/198)
 *     + CASE c4 WHEN 8 THEN 'telemarketing' ... ............. rows=1       (/8)
 *
 * Los dos ultimos son expresiones SIN estadistica y Postgres les aplica DEFAULT_EQ_SEL=0.005.
 * El peor, btrim(c1)=btrim(sucursal), es expr = expr sobre la MISMA relacion:
 * get_restriction_variable() falla porque ningun lado es constante, asi que ese 0.005 esta
 * CABLEADO y no hay estadistica que lo mueva.
 *
 * ⛔ DOS "FIXES OBVIOS" REFUTADOS CON MEDICION, para que nadie los vuelva a intentar:
 *   1. CREATE STATISTICS sobre las expresiones: el CASE paso de rows=5 a rows=9 y la
 *      auto-comparacion de 5 a 4. El real es 1,036. **No sirve.**
 *   2. Indice parcial con WHERE btrim(c1)=btrim(sucursal): si logra que el planificador borre el
 *      predicado del Filter, pero el indice **hereda el mismo 0.005** en su propia estimacion,
 *      asi que rows=1 igual -- y encima abarata el lado externo, lo que hace el Nested Loop MAS
 *      atractivo. **Empeora.**
 *
 * ── El arreglo ───────────────────────────────────────────────────────────────────────────
 * Una funcion SQL STABLE PARALLEL SAFE que resuelve la cartera de UN documento por su llave, y
 * la vista la llama por LEFT JOIN LATERAL. Se inlinea (el plan no muestra Function Scan), asi
 * que los predicados bajan hasta el indice.
 *
 * ⛔ analytics.erp_receivable_documents NO se toca ni se borra: sigue siendo la definicion para
 * los escaneos completos y tiene otro consumidor (customer_receivables). Esto no es una copia
 * del dato: es la misma logica resuelta por clave en vez de por barrido.
 *
 * ── Medido en prod (misma consulta de facturacion(), ventana 30d, 1,038 filas) ───────────
 *     A) vista actual .............................. ~64,000 ms ·    14,682 paginas
 *     B) LATERAL **sin** el indice ..................  19,830 ms · 1,820,114 paginas  (124x PEOR)
 *     C) LATERAL **con** el indice ..................      82 ms ·    15,254 paginas  (+3.9%)
 *
 * **781x**, y las paginas practicamente no se mueven. Por eso el indice va en su propia
 * migracion y ESTA verifica que exista antes de tocar la vista.
 *
 * ── Equivalencia: probada sobre el UNIVERSO COMPLETO, no una muestra ─────────────────────
 * Las dos definiciones dentro de UNA sola transaccion REPEATABLE READ (el ODS se escribe cada
 * 15 s: compararlas sueltas no controla la deriva del CDC, y de hecho al primer intento el
 * conteo se movio 1033 -> 1035 -> 1036):
 *   · 8,265 filas contra 8,265 · llave (sucursal, doc_prefix, folio) UNICA 8,265/8,265, o sea
 *     hay desempate y la comparacion es DEMOSTRABLE
 *   · EXCEPT ALL en AMBAS direcciones sobre las 43 columnas: 0 y 0
 *   · suma total 29,412,120.27 · saldo 15,981,587.97 · cobrado 13,308,655.37 -- identicos
 *   · distribucion de estatus_cobro identica (cancelada 431 / pagada 3,379 / parcial 318 /
 *     pendiente 3,991 / sin_cartera 146)
 *
 * ⚠️ LA TRAMPA QUE ESTO YA COBRO: la primera version de esta funcion devolvia TRES columnas y
 * no compilaba. La vista tiene **43 columnas y d alimenta OCHO**, no cuatro: se le escapaban
 * aplicaciones (jsonb) y dias_pago (integer). Y reponerlas obliga a devolver el lookup a kdue
 * que da la FECHA de cada aplicacion -- que era justo el escaneo que se habia borrado para
 * llegar al numero publicado. Medido: ese lookup es barato (984 paginas en 246 loops, por
 * kdue_distinct_key_idx), asi que el enfoque SOBREVIVE a reponerlo. El candado de 43 columnas de
 * la migracion 20260922120000 es exactamente el que atrapo esto; se conserva.
 *
 * ⚠️ Y un endurecimiento que la version original no tenia: la funcion repone el filtro de
 * doctipos c4 IN ('3','8','9','12','13','25','41') que erp_receivable_documents si aplica. HOY
 * es no-op (medido: los kdm1.c4 distintos son exactamente {8,12}, los dos en la lista, y el diff
 * de 0 diferencias se corrio SIN el filtro). Pero kdue tiene ~479,705 filas con c29='C' y
 * c4='10' que la vista canonica EXCLUYE a proposito: el dia que erp_sales_invoices se abra a
 * otro doctipo, las dos definiciones dejarian de coincidir EN DINERO sin que nada falle.
 *
 * ⚠️ La definicion de la vista se genero con un script desde la migracion vigente, no a mano.
 * Los dos unicos cambios son k4/k5 expuestas en q (que NO salen al SELECT exterior, por eso
 * sigue en 43) y el join de cartera.
 *
 * @param { import("knex").Knex } knex
 */

const FN = `
CREATE OR REPLACE FUNCTION analytics.erp_receivable_doc(
  p_suc text, p_k4 text, p_k5 text, p_folio text)
RETURNS TABLE (importe numeric, vencimiento date, saldo_documento numeric,
               aplicaciones jsonb, dias_pago integer)
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT round(car.c11,2),
         car.vencimiento,
         round(GREATEST(0::numeric, car.c11 - COALESCE(ap.aplicado,0::numeric)),2),
         ap.aplicaciones,
         CASE WHEN ap.ultima_fecha IS NOT NULL
               AND round(GREATEST(0::numeric, car.c11 - COALESCE(ap.aplicado,0::numeric)),2) <= 0.005
              THEN ap.ultima_fecha - car.fecha ELSE NULL::integer END
  FROM (
    SELECT DISTINCT ON (btrim(e.c1), e.c29, btrim(e.c4::text), btrim(e.c5::text), btrim(e.c6))
           e.c11, e.c10::date AS vencimiento, e.c7::date AS fecha
    FROM kepler_ods.kdue e
    WHERE btrim(e.c1)=p_suc AND e.c29='C'
      AND btrim(e.c4::text)=p_k4 AND btrim(e.c5::text)=p_k5 AND btrim(e.c6)=p_folio
      AND btrim(e.c4::text) = ANY (ARRAY['3','8','9','12','13','25','41'])
    ORDER BY btrim(e.c1), e.c29, btrim(e.c4::text), btrim(e.c5::text), btrim(e.c6), e.c7
  ) car
  LEFT JOIN LATERAL (
    SELECT round(sum(d.c13),2) AS aplicado,
           max(a.fecha) AS ultima_fecha,
           jsonb_agg(jsonb_build_object('tipo',
             CASE btrim(d.c4::text) WHEN '21' THEN 'nota_credito' WHEN '35' THEN 'nota_credito'
               WHEN '25' THEN 'devolucion' WHEN '40' THEN 'anticipo' WHEN '30' THEN 'ajuste'
               ELSE 'cobro' END, 'label',
             CASE btrim(d.c4::text) WHEN '5' THEN 'Cobro' WHEN '7' THEN 'Cobro CFDI'
               WHEN '21' THEN 'Nota Créd/Dev' WHEN '25' THEN 'Devolución'
               WHEN '30' THEN 'Ajuste Abono' WHEN '35' THEN 'Nota de crédito'
               WHEN '40' THEN 'Anticipo' ELSE 'Abono' END,
             'folio', btrim(d.c6), 'fecha', a.fecha::text, 'monto', round(d.c13,2))
             ORDER BY a.fecha, btrim(d.c6)) AS aplicaciones
    FROM (
      -- El DISTINCT es OBLIGATORIO: replica el CTE m0 de erp_receivable_documents, que deduplica
      -- filas de kdm5 que solo difieren en c7. Sin el, "aplicado" se DOBLA.
      SELECT DISTINCT m.c1,m.c2,m.c3,m.c4,m.c5,m.c6,m.c8,m.c9,m.c10,m.c11,m.c13
      FROM kepler_ods.kdm5 m
      WHERE m.c2='U' AND btrim(m.c1)=p_suc AND btrim(m.c8)='D'
        AND btrim(m.c9::text)=p_k4 AND btrim(m.c10::text)=p_k5 AND btrim(m.c11)=p_folio
        AND btrim(m.c4::text) = ANY (ARRAY['5','7','21','25','30','35','40'])
    ) d
    LEFT JOIN LATERAL (
      -- El lookup que da la FECHA de cada aplicacion. La primera version del parche lo habia
      -- borrado y por eso "llegaba" a 48 ms: sin el no hay aplicaciones ni dias_pago.
      SELECT e2.c7::date AS fecha FROM kepler_ods.kdue e2
      WHERE btrim(e2.c1)=btrim(d.c1) AND e2.c29='A' AND btrim(d.c3)='A'
        AND btrim(e2.c4::text)=btrim(d.c4::text) AND btrim(e2.c5::text)=btrim(d.c5::text)
        AND btrim(e2.c6)=btrim(d.c6)
        AND btrim(e2.c4::text)=ANY(ARRAY['5','7','21','25','30','35','40'])
      ORDER BY e2.c7 LIMIT 1
    ) a ON true
  ) ap ON true;
$fn$;`;

const VIEW = ` SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    q.sucursal,
    w.id AS warehouse_id,
    q.doc_prefix,
    q.doc_tipo,
    q.doc_label,
    q.folio,
    ((q.sucursal || q.doc_prefix) || '-'::text) || q.folio AS folio_digital,
    q.fecha,
        CASE
            WHEN d.vencimiento IS NOT NULL AND d.vencimiento >= q.fecha THEN d.vencimiento
            ELSE (q.fecha + ((COALESCE(NULLIF(q.dias_credito, 0), 1) || ' days'::text)::interval))::date
        END AS vencimiento,
    q.dias_credito,
    q.limite_credito,
    q.cliente_code,
    q.cliente_nombre,
    q.cliente_rfc,
    q.cliente_domicilio,
    q.cliente_colonia,
    q.cliente_estado,
    q.cliente_cp,
    q.vendedor_code,
    q.vendedor_nombre,
    q.canal,
    q.referencia,
    q.doc_origen,
    q.total,
    q.ieps,
    q.descuento,
    q.descuento_pct,
    round(q.total - q.ieps + q.descuento, 2) AS subtotal,
    q.doc_estatus,
    q.cancelada,
    'md_'::text || q.sucursal AS source_branch,
    now() AS computed_at,
    d.saldo_documento AS saldo,
        CASE
            WHEN d.saldo_documento IS NOT NULL THEN round(q.total - d.saldo_documento, 2)
            ELSE NULL::numeric
        END AS cobrado,
        CASE
            WHEN q.cancelada THEN 'cancelada'::text
            WHEN d.saldo_documento IS NULL THEN 'sin_cartera'::text
            WHEN d.saldo_documento <= 0.005 THEN 'pagada'::text
            WHEN d.saldo_documento < (q.total - 0.005) THEN 'parcial'::text
            ELSE 'pendiente'::text
        END AS estatus_cobro,
    d.aplicaciones,
    d.dias_pago,
    d.vencimiento AS vencimiento_erp,
        CASE
            WHEN d.vencimiento IS NOT NULL AND d.vencimiento >= q.fecha THEN 'erp'::text
            WHEN d.vencimiento IS NOT NULL THEN 'derivado_erp_invalido'::text
            ELSE 'derivado'::text
        END AS vencimiento_source,
        CASE
            WHEN q.descuento_pct > 0::numeric AND q.descuento_pct < 100::numeric THEN round(q.total / (1::numeric - q.descuento_pct / 100::numeric), 2)
            ELSE q.total
        END AS importe_bruto,
        CASE
            WHEN q.descuento_pct > 0::numeric AND q.descuento_pct < 100::numeric THEN round(q.total / (1::numeric - q.descuento_pct / 100::numeric) - q.total, 2)
            ELSE 0::numeric
        END AS descuento_efectivo,
        CASE q.doc_estatus
            WHEN 'N'::text THEN 'Sin abonos'::text
            WHEN 'R'::text THEN 'Abono parcial'::text
            WHEN 'F'::text THEN 'Liquidada'::text
            WHEN 'C'::text THEN 'Cancelada'::text
            ELSE q.doc_estatus
        END AS doc_estatus_label
   FROM ( SELECT btrim(h.sucursal) AS sucursal,
            ('UD'::text || lpad(h.c4::integer::text, 2, '0'::text)) || lpad(h.c5::integer::text, 2, '0'::text) AS doc_prefix,
                CASE h.c4::integer
                    WHEN 8 THEN 'telemarketing'::text
                    ELSE 'contado_nf'::text
                END AS doc_tipo,
                CASE h.c4::integer
                    WHEN 8 THEN 'Factura Telemarketing'::text
                    ELSE 'Factura Cont No Fiscal'::text
                END AS doc_label,
            btrim(h.c6) AS folio,
            btrim(h.c4::text) AS k4,
            btrim(h.c5::text) AS k5,
            h.c9::date AS fecha,
            NULLIF(btrim(h.c10), ''::text) AS cliente_code,
            NULLIF(btrim(h.c32), ''::text) AS cliente_nombre,
            NULLIF(btrim(h.c22), ''::text) AS cliente_rfc,
            NULLIF(btrim(h.c33), ''::text) AS cliente_domicilio,
            NULLIF(btrim(h.c34), ''::text) AS cliente_colonia,
            NULLIF(btrim(h.c35), ''::text) AS cliente_estado,
            NULLIF(btrim(u.c27), ''::text) AS cliente_cp,
            NULLIF(btrim(h.c12), ''::text) AS vendedor_code,
            NULLIF(btrim(v.c3), ''::text) AS vendedor_nombre,
            NULLIF(btrim(h.c27), ''::text) AS canal,
            NULLIF(btrim(h.c11), ''::text) AS referencia,
            NULLIF(btrim(h.c43), ''::text) AS doc_estatus,
            btrim(h.c43) = 'C'::text AS cancelada,
                CASE
                    WHEN NULLIF(btrim(h.c39), ''::text) IS NULL THEN NULL::text
                    ELSE ((('UD'::text || lpad(h.c37::integer::text, 2, '0'::text)) || lpad(h.c38::integer::text, 2, '0'::text)) || '-'::text) || btrim(h.c39)
                END AS doc_origen,
            round(COALESCE(NULLIF(regexp_replace(h.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS total,
            round(COALESCE(NULLIF(regexp_replace(h.c15::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS ieps,
            round(COALESCE(NULLIF(regexp_replace(h.c13::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS descuento,
            COALESCE(NULLIF(regexp_replace(h.c19, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric) AS descuento_pct,
            COALESCE(NULLIF(regexp_replace(u.c16::text, '[^0-9]'::text, ''::text, 'g'::text), ''::text)::integer, 0) AS dias_credito,
            round(COALESCE(NULLIF(regexp_replace(u.c15::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS limite_credito
           FROM kepler_ods.kdm1 h
             LEFT JOIN kepler_ods.kdud u ON btrim(u.sucursal) = btrim(h.sucursal) AND btrim(u.c2) = btrim(h.c10)
              AND u.sucursal = h.sucursal AND u.c2 = h.c10
             LEFT JOIN kepler_ods.kduv v ON btrim(v.sucursal) = btrim(h.sucursal) AND btrim(v.c2) = btrim(h.c12)
              AND v.sucursal = h.sucursal AND v.c2 = h.c12
          WHERE h.c2 = 'U'::text AND h.c3 = 'D'::text AND (h.c4::integer = ANY (ARRAY[8, 12])) AND btrim(h.c1) = btrim(h.sucursal)) q
     LEFT JOIN commercial.warehouses w ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL
     LEFT JOIN LATERAL analytics.erp_receivable_doc(q.sucursal, q.k4, q.k5, q.folio) d ON true`;

exports.up = async function up(knex) {
  // ⛔ EL CANDADO DE ORDEN. Sin ix_kdm5_aplicacion_factura esta vista no es una mejora: es 124x
  // PEOR que hoy (1,820,114 paginas contra 14,682, medido). No se confia en que las migraciones
  // corran en orden -- se comprueba.
  const { rows: [ix] } = await knex.raw(`
    SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'ix_kdm5_aplicacion_factura'`);
  if (!ix || !ix.indisvalid) {
    throw new Error(
      'Falta (o esta invalido) ix_kdm5_aplicacion_factura. Correr 20260924160000 PRIMERO: sin ' +
      'ese indice el LATERAL cuesta 1,820,114 paginas contra las 14,682 de la vista actual.');
  }

  await knex.raw(FN);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sales_invoices AS ${VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoices TO app_runtime');

  // El mismo candado de 43 columnas de 20260922120000 -- es el que atrapo la primera version de
  // este parche, que devolvia 3 columnas y dejaba aplicaciones y dias_pago sin fuente.
  const { rows: [c] } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_sales_invoices'`);
  if (c.n !== 43) {
    throw new Error(`analytics.erp_sales_invoices quedo con ${c.n} columnas, se esperaban 43: ` +
      'se perdio alguna al re-crear la definicion. Revisar contra pg_get_viewdef antes de seguir.');
  }
  console.log('  OK erp_sales_invoices: 43 columnas, cartera por LATERAL y GRANT repuesto.');
};

/**
 * ⛔ NO es no-op: aca hay una funcion nueva. Para volver atras hay que re-aplicar
 * 20260922120000 (que repone el LEFT JOIN contra erp_receivable_documents) y recien despues
 * DROP FUNCTION analytics.erp_receivable_doc. El indice lo revierte su propia migracion.
 */
exports.down = async function down() {
  console.log('[erp_receivable_doc_lateral] down: re-aplicar 20260922120000 y despues ' +
    'DROP FUNCTION analytics.erp_receivable_doc(text,text,text,text).');
};
