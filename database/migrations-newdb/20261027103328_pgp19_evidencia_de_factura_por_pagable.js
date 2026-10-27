'use strict';
/**
 * `[PGP.19]` — **El motor de evidencia**: por cada documento por pagar, la MEJOR prueba
 * documental que exista en la casa, venga de donde venga, con su puntaje y su tipo.
 *
 * No es un carril ni una cadena de parches: es UN universo de candidatos (el papel que Compras
 * adjunta + el CFDI que llega de ContPAQi/SAT) puntuado por cuántas SEÑALES INDEPENDIENTES
 * coinciden. Fuente nueva = un `UNION ALL` más. Señal nueva = una columna más en la suma.
 *
 * ── Las 5 señales ──────────────────────────────────────────────────────────────────────────
 *  importe (±1%) · fecha (±5 días) · folio · referencia del proveedor · RFC del emisor
 *
 * ⛔ ANCLA OBLIGATORIA: un candidato sólo puntúa si coincide **importe o RFC**. Sin ancla,
 *    «folio + fecha» es azar — medido: cruzar sólo por folio alcanza 842 documentos y su
 *    placebo alcanza 757, o sea que 9 de cada 10 aciertos son casualidad.
 *
 * ── Lo medido antes, contra prod (sólo lectura, sid 7688376744939610156, 2026-10-27) ────────
 *  · Universo exigible: 2,916 documentos · $102,006,316. (Se excluye `compromiso_financiero`
 *    —crédito BBVA, Banco Bajío, factoraje, préstamos de los dueños: 43 docs, $38,534,351—
 *    porque NO puede tener factura de proveedor: no es que falte, no existe.)
 *  · Umbral 4 →   607 docs (20.8%) · $46,669,423 · placebo 0 · precisión 100%
 *  · Umbral 3 →  1,140 docs (39.1%) · $68,467,653 · placebo 0 · precisión 100%  <-- EL ELEGIDO
 *  · Umbral 2 →  1,742 docs (59.7%) · $80,543,846 · placebo 958 · precisión 45%  ⛔
 *  · Umbral 1 →  1,988 docs (68.2%) · placebo 1,753 · precisión 11.8%  ⛔
 *    El placebo corre el MISMO motor con las llaves del pagable corridas (importe ×1.07,
 *    fecha +400 días, folio +7, referencia +7).
 *  · De los 1,140 del umbral 3, **780 traen PDF real** del proveedor y 360 sólo UUID fiscal.
 *  · El techo NO lo pone el cruce, lo pone el dato: `fiscal.cfdis.pdf` es NULL en las 432,037
 *    filas y el papel adjunto nace el 2026-08-04.
 *
 * ⚠️ Costo medido del cuerpo de esta vista sobre el universo completo: **16 s**. Es alto para
 *    una pantalla; se consume SIEMPRE filtrada por documento o por proveedor, nunca entera.
 *    Si alguien la pide completa, medirlo antes (regla dura: >500 ms no funciona).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CUERPO = `
WITH rfcm AS (
  SELECT sucursal, btrim(c2) AS prov, min(nullif(btrim(c10), '')) AS rfc
    FROM kepler_ods.kdxd GROUP BY 1, 2),
pay AS (
  SELECT v.tenant_id, v.sucursal, v.doc_tipo, v.doc_sub, btrim(v.folio) AS folio,
         v.proveedor, v.fecha::date AS fecha, v.importe, v.pendiente,
         nullif(btrim(coalesce(v.referencia, '')), '') AS referencia,
         nullif(regexp_replace(btrim(v.folio), '[^0-9]', '', 'g'), '')::numeric AS folio_n,
         nullif(regexp_replace(coalesce(v.referencia, ''), '[^0-9]', '', 'g'), '')::numeric AS ref_n,
         m.rfc
    FROM analytics.v_supplier_payables v
    LEFT JOIN rfcm m ON m.sucursal = v.sucursal AND m.prov = btrim(v.proveedor)
   WHERE v.pendiente > 0
     -- Lo financiero no puede tener factura de proveedor. Mismos prefijos que
     -- PREFIJOS_FINANCIEROS / GRUPOS_FINANCIEROS en creditor-statements.engine.ts.
     AND NOT ( btrim(coalesce(v.grupo, '')) = '140'
            OR upper(btrim(v.proveedor)) LIKE 'A%'
            OR upper(btrim(v.proveedor)) LIKE 'TC%'
            OR upper(btrim(v.proveedor)) LIKE 'B.B.%' )),
pr AS (
  SELECT id, sucursal, receipt_monto AS imp, receipt_date AS fec,
         nullif(btrim(coalesce(proveedor_rfc, '')), '') AS rfc,
         nullif(regexp_replace(btrim(folio), '[^0-9]', '', 'g'), '')::numeric AS folio_n,
         nullif(regexp_replace(coalesce(ocr_folio, ''), '[^0-9]', '', 'g'), '')::numeric AS ocr_n
    FROM finance.goods_receipt_proofs
   WHERE jsonb_array_length(files) > 0),
cfd AS (
  SELECT uuid, emisor_rfc AS rfc, total AS imp, fecha::date AS fec,
         nullif(regexp_replace(coalesce(folio, ''), '[^0-9]', '', 'g'), '')::numeric AS folio_n
    FROM fiscal.cfdis
   WHERE rol = 'recibidas'),
-- Cada rama entra por UNA llave de IGUALDAD (hash join). Un OR en el ON fuerza bucle
-- anidado sobre 169 mil filas y lleva la consulta de 16 s a mas de 2 min: no se toca.
cand AS (
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf'::text AS clase, x.id::text AS ref_evidencia,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int AS s_imp,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int AS s_fec,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int AS s_fol,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int AS s_ref,
         (x.rfc IS NOT NULL AND p.rfc IS NOT NULL AND x.rfc = p.rfc)::int AS s_rfc
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.folio_n = p.folio_n
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf', x.id::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int,
         (x.ocr_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.ocr_n = p.ref_n)::int,
         (x.rfc IS NOT NULL AND p.rfc IS NOT NULL AND x.rfc = p.rfc)::int
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.ocr_n = p.ref_n
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf', x.id::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int,
         1
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.rfc = p.rfc
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'uuid', x.uuid::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (abs(x.fec - p.fecha) <= 5)::int,
         0,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int,
         1
    FROM pay p JOIN cfd x ON x.rfc = p.rfc
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'uuid', x.uuid::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (abs(x.fec - p.fecha) <= 5)::int,
         0, 1,
         (x.rfc IS NOT NULL AND p.rfc IS NOT NULL AND x.rfc = p.rfc)::int
    FROM pay p JOIN cfd x ON x.folio_n = p.ref_n),
punt AS (
  SELECT c.*, (c.s_imp + c.s_fec + c.s_fol + c.s_ref + c.s_rfc) AS puntaje
    FROM cand c
   WHERE c.s_imp = 1 OR c.s_rfc = 1),
mejor AS (
  SELECT DISTINCT ON (tenant_id, sucursal, doc_tipo, doc_sub, folio) *
    FROM punt
   WHERE puntaje >= 3
   ORDER BY tenant_id, sucursal, doc_tipo, doc_sub, folio,
            (clase = 'pdf') DESC, puntaje DESC, ref_evidencia)
SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor, p.pendiente,
       coalesce(m.clase, 'ninguna')::text AS evidencia,
       m.ref_evidencia,
       coalesce(m.puntaje, 0)::int AS puntaje,
       array_remove(ARRAY[
         CASE WHEN m.s_imp = 1 THEN 'importe' END,
         CASE WHEN m.s_fec = 1 THEN 'fecha' END,
         CASE WHEN m.s_fol = 1 THEN 'folio' END,
         CASE WHEN m.s_ref = 1 THEN 'referencia' END,
         CASE WHEN m.s_rfc = 1 THEN 'rfc' END], NULL)::text[] AS senales,
       CASE WHEN m.clase IS NOT NULL THEN NULL
            WHEN p.rfc IS NULL THEN 'el proveedor no tiene RFC capturado en Kepler'
            WHEN p.fecha < DATE '2026-08-04' THEN 'anterior a que se empezara a adjuntar la factura'
            WHEN p.referencia IS NULL THEN 'el documento no trae referencia del proveedor'
            ELSE 'no hay ninguna prueba que alcance el umbral de confianza' END::text AS motivo
  FROM pay p
  LEFT JOIN mejor m
    ON m.tenant_id = p.tenant_id AND m.sucursal = p.sucursal AND m.doc_tipo = p.doc_tipo
   AND m.doc_sub = p.doc_sub AND m.folio = p.folio`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_payable_evidence AS ${CUERPO}`);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_payable_evidence IS ` +
      `'[PGP.19] La mejor prueba documental de cada documento por pagar. 5 senales, ancla importe-o-RFC, umbral 3 (precision 100% medida contra placebo el 2026-10-27). Derivada: no materializa nada.'`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_payable_evidence`);
};
