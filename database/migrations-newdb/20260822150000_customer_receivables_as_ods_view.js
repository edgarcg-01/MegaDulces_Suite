/**
 * Fase CXC — Cartera: TABLA → VISTA derive-no-copy sobre `kepler_ods` (ADR-046 + regla
 * "analytics = vista sobre ODS, fresco"). Reemplaza `analytics.customer_receivables`
 * (que era tabla+importer, copia normalizada) por una VISTA sobre `kepler_ods.kdue`
 * (+ `kdm5` para saldo_documento/aplicaciones exactos + `kdud` para grupo/zona/límite/
 * teléfono), igual que `erp_collections`/`erp_customers`. Fresca al momento (ODS lo
 * alimenta OdsLiveLoop), cero importer/cron. Verificada vs PDF: saldo cuadra al peso.
 *
 * PROD-ONLY (como las otras vistas live): local `kepler_ods` está vacío → esta migración
 * FALLA local (relation kepler_ods.kdue no existe); allá la tabla del importer queda para dev.
 * Misma firma de columnas que la tabla → el backend no cambia.
 *
 * Gotcha kdud: trae filas duplicadas por código (zona/límite distintos) → DISTINCT ON
 * por código, prefiriendo la fila con límite mayor.
 * @param { import("knex").Knex } knex
 */
const VIEW_SQL = `
CREATE OR REPLACE VIEW analytics.customer_receivables AS
WITH kd AS (
  SELECT DISTINCT ON (btrim(c2)) btrim(c2) AS code,
         NULLIF(btrim(c13),'') AS grupo, NULLIF(btrim(c14),'') AS zona,
         NULLIF(regexp_replace(c15::text,'[^0-9.-]','','g'),'')::numeric AS limite,
         NULLIF(btrim(c16::text),'')::int AS dias, NULLIF(btrim(c7),'') AS tel
  FROM kepler_ods.kdud
  ORDER BY btrim(c2), (NULLIF(regexp_replace(c15::text,'[^0-9.-]','','g'),'')::numeric) DESC NULLS LAST
),
ap AS (
  SELECT btrim(m.c1) AS suc,
         'U'||btrim(m.c8)||lpad(btrim(m.c9::text),2,'0')||lpad(btrim(m.c10::text),2,'0') AS fac_doc,
         btrim(m.c11) AS fac_folio,
         round(sum(m.c13::numeric),2) AS aplicado,
         jsonb_agg(jsonb_build_object(
           'tipo', CASE btrim(m.c4::text) WHEN '7' THEN 'cobro' WHEN '21' THEN 'nota_credito' WHEN '25' THEN 'devolucion' ELSE 'otro' END,
           'label', CASE btrim(m.c4::text) WHEN '7' THEN 'Cobro CFDI' WHEN '21' THEN 'Nota Créd/Dev' WHEN '25' THEN 'Devolución' ELSE 'Abono' END,
           'folio', btrim(m.c6), 'monto', round(m.c13::numeric,2)
         ) ORDER BY btrim(m.c6)) AS aplicaciones
  FROM kepler_ods.kdm5 m
  WHERE m.c2='U' AND btrim(m.c4::text) IN ('7','21','25')
  GROUP BY 1,2,3
)
SELECT
  '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
  btrim(r.c1) AS sucursal,
  'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0') AS doc_code,
  CASE WHEN r.c29='C' THEN 'factura'
       WHEN btrim(r.c4::text)='7' THEN 'cobro'
       WHEN btrim(r.c4::text)='21' THEN 'nota_credito'
       WHEN btrim(r.c4::text)='25' THEN 'devolucion' ELSE 'otro' END AS doc_tipo,
  CASE WHEN r.c29='C' AND btrim(r.c4::text)='8' THEN 'Factura Telemarketing'
       WHEN r.c29='C' THEN 'Venta crédito'
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
FROM kepler_ods.kdue r
LEFT JOIN kd ON kd.code = NULLIF(btrim(r.c2),'')
LEFT JOIN ap ON ap.suc = btrim(r.c1)
            AND ap.fac_doc = 'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0')
            AND ap.fac_folio = btrim(r.c6)
WHERE (r.c29='C' AND btrim(r.c4::text) IN ('8','12','13'))
   OR (r.c29='A' AND btrim(r.c4::text) IN ('7','21','25'))
`;

exports.up = async function (knex) {
  // Si es TABLA (la del importer), la tiramos (era copia; en prod está vacía).
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='analytics' AND c.relname='customer_receivables' AND c.relkind='r') THEN
        EXECUTE 'DROP TABLE analytics.customer_receivables CASCADE';
      END IF;
    END $$`);
  await knex.raw(VIEW_SQL);
  await knex.raw(`GRANT SELECT ON analytics.customer_receivables TO app_runtime`);
};

exports.down = async function (knex) {
  // Revierte a la tabla vacía (estructura de la mig 20260821160000, con todas las columnas).
  await knex.raw(`DROP VIEW IF EXISTS analytics.customer_receivables`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.customer_receivables (
      tenant_id uuid NOT NULL, sucursal text NOT NULL, doc_code text NOT NULL, doc_tipo text NOT NULL,
      doc_label text, folio text NOT NULL, folio_digital text, cliente_code text, grupo text, zona text,
      fecha date, vencimiento date, importe numeric NOT NULL DEFAULT 0, cargo_abono char(1) NOT NULL,
      signed_amount numeric NOT NULL DEFAULT 0, referencia text, vendedor text, moneda text, source_branch text,
      saldo_documento numeric, aplicaciones jsonb, limite_credito numeric, dias_credito integer, telefono text,
      computed_at timestamptz DEFAULT now(), PRIMARY KEY (tenant_id, sucursal, doc_code, folio))`);
  await knex.raw(`GRANT SELECT ON analytics.customer_receivables TO app_runtime`);
};
