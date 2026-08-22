/**
 * Fase CXC — Cartera: incluir el cobro de CEDIS (UA05 / c4=5) en el lado ABONO.
 *
 * Hallazgo (2026-08-22, prod): en la sucursal 00 (CEDIS) el cobro es `UA05` (c4=5) —
 * 26,075 filas / $409M — mientras que a nivel sucursal (01-06) el cobro es `UA07` (c4=7).
 * El filtro de abonos original solo tomaba 7/21/25 → CEDIS captaba las facturas (cargos
 * c4=12/13) pero NO los cobros → **saldo CEDIS inflado ~$409M**. La suc 01 no se afecta
 * (no tiene c4=5). Fix: agregar '5' al lado abono en kdue y en kdm5, con label 'Cobro'.
 *
 * Mantiene el dedup de la mig 20260822160000. Misma firma de columnas → CREATE OR REPLACE.
 * PROD-ONLY (kepler_ods vacío local).
 *
 * @param { import("knex").Knex } knex
 */
const VIEW_SQL = `
CREATE OR REPLACE VIEW analytics.customer_receivables AS
WITH src AS (
  SELECT DISTINCT ON (btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6))
         c1,c2,c4,c5,c6,c7,c8,c10,c11,c16,c18,c29
  FROM kepler_ods.kdue
  WHERE (c29='C' AND btrim(c4::text) IN ('8','12','13'))
     OR (c29='A' AND btrim(c4::text) IN ('5','7','21','25'))
  ORDER BY btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6), c7
),
kd AS (
  SELECT DISTINCT ON (btrim(c2)) btrim(c2) AS code,
         NULLIF(btrim(c13),'') AS grupo, NULLIF(btrim(c14),'') AS zona,
         NULLIF(regexp_replace(c15::text,'[^0-9.-]','','g'),'')::numeric AS limite,
         NULLIF(btrim(c16::text),'')::int AS dias, NULLIF(btrim(c7),'') AS tel
  FROM kepler_ods.kdud
  ORDER BY btrim(c2), (NULLIF(regexp_replace(c15::text,'[^0-9.-]','','g'),'')::numeric) DESC NULLS LAST
),
m0 AS (
  SELECT DISTINCT c1,c2,c3,c4,c5,c6,c8,c9,c10,c11,c13
  FROM kepler_ods.kdm5
  WHERE c2='U' AND btrim(c4::text) IN ('5','7','21','25')
),
ap AS (
  SELECT btrim(m.c1) AS suc,
         'U'||btrim(m.c8)||lpad(btrim(m.c9::text),2,'0')||lpad(btrim(m.c10::text),2,'0') AS fac_doc,
         btrim(m.c11) AS fac_folio,
         round(sum(m.c13::numeric),2) AS aplicado,
         jsonb_agg(jsonb_build_object(
           'tipo', CASE btrim(m.c4::text) WHEN '5' THEN 'cobro' WHEN '7' THEN 'cobro' WHEN '21' THEN 'nota_credito' WHEN '25' THEN 'devolucion' ELSE 'otro' END,
           'label', CASE btrim(m.c4::text) WHEN '5' THEN 'Cobro' WHEN '7' THEN 'Cobro CFDI' WHEN '21' THEN 'Nota Créd/Dev' WHEN '25' THEN 'Devolución' ELSE 'Abono' END,
           'folio', btrim(m.c6), 'monto', round(m.c13::numeric,2)
         ) ORDER BY btrim(m.c6)) AS aplicaciones
  FROM m0 m
  GROUP BY 1,2,3
)
SELECT
  '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
  btrim(r.c1) AS sucursal,
  'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0') AS doc_code,
  CASE WHEN r.c29='C' THEN 'factura'
       WHEN btrim(r.c4::text)='5' THEN 'cobro'
       WHEN btrim(r.c4::text)='7' THEN 'cobro'
       WHEN btrim(r.c4::text)='21' THEN 'nota_credito'
       WHEN btrim(r.c4::text)='25' THEN 'devolucion' ELSE 'otro' END AS doc_tipo,
  CASE WHEN r.c29='C' AND btrim(r.c4::text)='8' THEN 'Factura Telemarketing'
       WHEN r.c29='C' THEN 'Venta crédito'
       WHEN btrim(r.c4::text)='5' THEN 'Cobro'
       WHEN btrim(r.c4::text)='7' THEN 'Cobro CFDI'
       WHEN btrim(r.c4::text)='21' THEN 'Nota Créd/Dev'
       WHEN btrim(r.c4::text)='25' THEN 'Devolución' ELSE 'Abono' END AS doc_label,
  btrim(r.c6) AS folio,
  btrim(r.c1)||'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0')||'-'||btrim(r.c6) AS folio_digital,
  NULLIF(btrim(r.c2),'') AS cliente_code,
  kd.grupo, kd.zona,
  r.c7::date AS fecha,
  CASE WHEN r.c29='C' THEN r.c10::date END AS vencimiento,
  round(r.c11::numeric,2) AS importe,
  r.c29 AS cargo_abono,
  round(CASE WHEN r.c29='C' THEN r.c11::numeric ELSE -r.c11::numeric END,2) AS signed_amount,
  NULLIF(btrim(r.c16),'') AS referencia,
  NULLIF(btrim(r.c18),'') AS vendedor,
  NULLIF(btrim(r.c8),'') AS moneda,
  'ods'::text AS source_branch,
  CASE WHEN r.c29='C' THEN round(greatest(0, r.c11::numeric - COALESCE(ap.aplicado,0)),2) END AS saldo_documento,
  CASE WHEN r.c29='C' THEN ap.aplicaciones END AS aplicaciones,
  kd.limite AS limite_credito,
  kd.dias AS dias_credito,
  kd.tel AS telefono,
  now() AS computed_at
FROM src r
LEFT JOIN kd ON kd.code = NULLIF(btrim(r.c2),'')
LEFT JOIN ap ON ap.suc = btrim(r.c1)
            AND ap.fac_doc = 'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0')
            AND ap.fac_folio = btrim(r.c6)
`;

exports.up = async function (knex) {
  await knex.raw(VIEW_SQL);
  await knex.raw(`GRANT SELECT ON analytics.customer_receivables TO app_runtime`);
};

exports.down = async function () {
  // No revierte: incluir el cobro CEDIS es estrictamente más correcto.
};
