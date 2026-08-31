/**
 * Fase CXC — la aplicación (cobro / nota / devolución) dice EN QUÉ FECHA se aplicó.
 *
 * `kdm5` (el linkage cobro→factura) NO trae fecha: sus columnas son c1..c14 y la última
 * útil es `c14`='EMBARCADO' (estatus). Verificado en vivo sobre prod. Por eso el drill de
 * `/finanzas/cartera` venía pintando '—' en la fecha de cada cobro aplicado, y una factura
 * ya saldada no podía decir CUÁNDO se pagó.
 *
 * La fecha sí está en `kdue`, en el documento que aplica (el abono, `c7`). Se une por
 * (sucursal, doc_code del aplicador, folio) contra el mismo `src` ya deduplicado, así que
 * hereda el DISTINCT ON de la mig 20260822160000 y no dobla montos.
 *
 * Sólo cambia el CONTENIDO del jsonb `aplicaciones` — la firma de columnas de la vista es
 * idéntica → `CREATE OR REPLACE`. Mantiene el cobro UA05 de la sucursal '00' (mig 20260822170000)
 * — que es OFICINAS, no el CEDIS, pese a lo que dice el comentario de aquella mig (ERP_KEPLER §2.3).
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
-- Fecha del documento que aplica: kdm5 no la tiene, kdue sí (c7 del abono).
abo AS (
  SELECT btrim(c1) AS suc,
         'UA'||lpad(btrim(c4::text),2,'0')||lpad(btrim(c5::text),2,'0') AS doc,
         btrim(c6) AS folio,
         c7::date AS fecha
  FROM src WHERE c29='A'
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
         max(a.fecha)::text AS ultima_fecha,
         jsonb_agg(jsonb_build_object(
           'tipo', CASE btrim(m.c4::text) WHEN '5' THEN 'cobro' WHEN '7' THEN 'cobro' WHEN '21' THEN 'nota_credito' WHEN '25' THEN 'devolucion' ELSE 'otro' END,
           'label', CASE btrim(m.c4::text) WHEN '5' THEN 'Cobro' WHEN '7' THEN 'Cobro CFDI' WHEN '21' THEN 'Nota Créd/Dev' WHEN '25' THEN 'Devolución' ELSE 'Abono' END,
           'folio', btrim(m.c6), 'fecha', a.fecha::text, 'monto', round(m.c13::numeric,2)
         ) ORDER BY a.fecha NULLS LAST, btrim(m.c6)) AS aplicaciones
  FROM m0 m
  LEFT JOIN abo a
    ON a.suc = btrim(m.c1)
   AND a.doc = 'U'||btrim(m.c3)||lpad(btrim(m.c4::text),2,'0')||lpad(btrim(m.c5::text),2,'0')
   AND a.folio = btrim(m.c6)
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
  // No revierte: la fecha de la aplicación es estrictamente más información.
};
