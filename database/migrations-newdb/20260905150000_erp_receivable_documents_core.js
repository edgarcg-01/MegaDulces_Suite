/**
 * Fase AX.9 — el saldo de un documento deja de tener DOS dueños.
 *
 * `/comercial/documentos` necesitaba responder "¿esta factura ya se pagó?" (hoy dice
 * *vencida* sin mirar si hay cobro). El dato existe y está bien resuelto en
 * `analytics.customer_receivables` (Fase CXC), pero esa vista arrastra un FIFO por cliente
 * con función de ventana sobre TODA la cartera: no acepta pushdown y cuesta **1,521 ms**
 * aunque le pidas 738 folios. Copiar su fórmula del saldo a una segunda vista habría sido
 * el pecado de GOTCHAS §32: dos materializaciones del mismo número, listas para divergir
 * el día que una se arregle.
 *
 * Se parte en dos, sin cambiar el contrato de nadie:
 *
 *   `analytics.erp_receivable_documents`  <- el CTE `base` de la cartera, tal cual, como vista
 *      propia: una fila por documento de `kdue` (cargo y abono) con su `saldo_documento`,
 *      sus `aplicaciones` y su `vencimiento`. Filtrable por (sucursal, doc_code, folio) ->
 *      el planner SI empuja el filtro.
 *
 *   `analytics.customer_receivables`      <- CREATE OR REPLACE encima de la anterior. Conserva
 *      las 29 columnas EN SU ORDEN (requisito de REPLACE, y hay una matview ajena colgando
 *      en el `.245` que un DROP se llevaría — ver nota de 20260831140000).
 *
 * VALIDADO contra prod ANTES de aplicar (`test-newdb-receivable-core-parity.js`): las 29
 * columnas coinciden al peso con la definición anterior, incluido el jsonb de aplicaciones
 * y el reparto FIFO. Cero filas de más, cero de menos.
 *
 * INDICE: el `DISTINCT ON` de `src` ordenaba 423,799 filas de `kdue` sin índice. Se agrega uno
 * de expresión que calca la clave del DISTINCT. Medido: el scan de `kdue` pasa de 162 ms a
 * **28 ms** y la consulta de la pantalla de **2,119 ms a 931 ms**.
 *   · `CONCURRENTLY` (por eso `transaction: false`): `kdue` la escribe el CDC cada minuto y un
 *     CREATE INDEX normal le tomaría el lock exclusivo.
 *   · El `ANALYZE` de después NO es adorno: sin él el planner descarta el índice y hace
 *     `Parallel Seq Scan` igual — se verificó en el `.245`, mismo plan malo con el índice ya creado.
 *   · ⚠️ AL APLICAR: `CONCURRENTLY` espera a que cierren las transacciones viejas ("waiting for
 *     old snapshots"). En el `.245` se quedó ~15 min detrás de un `REFRESH MATERIALIZED VIEW
 *     analytics.mv_kepler_sales_daily`. No bloquea a nadie — sólo espera. Si urge, correrlo
 *     cuando no haya refresh en vuelo.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

/**
 * Núcleo por documento = el CTE `base` de 20260831140000, verbatim salvo el SELECT final.
 * Si algo del saldo cambia, cambia AQUI y las dos pantallas se enteran a la vez.
 */
const CORE_SQL = `
CREATE OR REPLACE VIEW analytics.erp_receivable_documents AS
WITH src AS (
  SELECT DISTINCT ON (btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6))
         c1,c2,c4,c5,c6,c7,c8,c10,c11,c16,c18,c29
  FROM kepler_ods.kdue
  WHERE (c29='C' AND btrim(c4::text) IN ('3','8','9','12','13','25','41'))
     OR (c29='A' AND btrim(c4::text) IN ('5','7','21','25','30','35','40'))
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
abo AS (
  SELECT btrim(c1) AS suc,
         'UA'||lpad(btrim(c4::text),2,'0')||lpad(btrim(c5::text),2,'0') AS doc,
         btrim(c6) AS folio, c7::date AS fecha
  FROM src WHERE c29='A'
),
m0 AS (
  SELECT DISTINCT c1,c2,c3,c4,c5,c6,c8,c9,c10,c11,c13
  FROM kepler_ods.kdm5
  WHERE c2='U' AND btrim(c4::text) IN ('5','7','21','25','30','35','40')
),
ap AS (
  SELECT btrim(m.c1) AS suc,
         'U'||btrim(m.c8)||lpad(btrim(m.c9::text),2,'0')||lpad(btrim(m.c10::text),2,'0') AS fac_doc,
         btrim(m.c11) AS fac_folio,
         round(sum(m.c13::numeric),2) AS aplicado,
         max(a.fecha) AS ultima_fecha,
         jsonb_agg(jsonb_build_object(
           'tipo', CASE btrim(m.c4::text) WHEN '21' THEN 'nota_credito' WHEN '35' THEN 'nota_credito'
                                          WHEN '25' THEN 'devolucion' WHEN '40' THEN 'anticipo'
                                          WHEN '30' THEN 'ajuste' ELSE 'cobro' END,
           'label', CASE btrim(m.c4::text) WHEN '5' THEN 'Cobro' WHEN '7' THEN 'Cobro CFDI'
                                           WHEN '21' THEN 'Nota Créd/Dev' WHEN '25' THEN 'Devolución'
                                           WHEN '30' THEN 'Ajuste Abono' WHEN '35' THEN 'Nota de crédito'
                                           WHEN '40' THEN 'Anticipo' ELSE 'Abono' END,
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
  '${M}'::uuid AS tenant_id,
  btrim(r.c1) AS sucursal,
  'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0') AS doc_code,
  CASE WHEN r.c29='C' THEN 'factura'
       WHEN btrim(r.c4::text) IN ('5','7') THEN 'cobro'
       WHEN btrim(r.c4::text) IN ('21','35') THEN 'nota_credito'
       WHEN btrim(r.c4::text)='25' THEN 'devolucion'
       WHEN btrim(r.c4::text)='40' THEN 'anticipo'
       WHEN btrim(r.c4::text)='30' THEN 'ajuste' ELSE 'otro' END AS doc_tipo,
  CASE WHEN r.c29='C' THEN
         CASE btrim(r.c4::text) WHEN '3' THEN 'Factura TK Crédito' WHEN '8' THEN 'Factura Telemarketing'
                                WHEN '9' THEN 'Ticket Crédito'     WHEN '25' THEN 'Cheque Devuelto'
                                WHEN '41' THEN 'Embarque Sucursal' ELSE 'Venta crédito' END
       ELSE
         CASE btrim(r.c4::text) WHEN '5' THEN 'Cobro' WHEN '7' THEN 'Cobro CFDI'
                                WHEN '21' THEN 'Nota Créd/Dev' WHEN '25' THEN 'Devolución'
                                WHEN '30' THEN 'Ajuste Abono' WHEN '35' THEN 'Nota de crédito'
                                WHEN '40' THEN 'Anticipo' ELSE 'Abono' END
  END AS doc_label,
  btrim(r.c6) AS folio,
  btrim(r.c1)||'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0')||'-'||btrim(r.c6) AS folio_digital,
  NULLIF(btrim(r.c2),'') AS cliente_code,
  kd.grupo, kd.zona,
  r.c7::date AS fecha,
  CASE WHEN r.c29='C' THEN r.c10::date END AS vencimiento,
  round(r.c11::numeric,2) AS importe,
  r.c29 AS cargo_abono,
  round(CASE WHEN r.c29='C' THEN r.c11::numeric ELSE -r.c11::numeric END,2) AS signed_amount,
  NULLIF(btrim(r.c16),'') AS estatus,
  NULLIF(btrim(r.c18),'') AS vendedor,
  NULLIF(btrim(r.c8),'') AS moneda,
  CASE WHEN r.c29='C' THEN round(greatest(0, r.c11::numeric - COALESCE(ap.aplicado,0)),2) END AS saldo_documento,
  CASE WHEN r.c29='C' THEN ap.aplicaciones END AS aplicaciones,
  CASE WHEN r.c29='C' AND ap.ultima_fecha IS NOT NULL
            AND round(greatest(0, r.c11::numeric - COALESCE(ap.aplicado,0)),2) <= 0.005
       THEN (ap.ultima_fecha - r.c7::date) END AS dias_pago,
  kd.limite AS limite_credito,
  kd.dias AS dias_credito,
  kd.tel AS telefono
FROM src r
LEFT JOIN kd ON kd.code = NULLIF(btrim(r.c2),'')
LEFT JOIN ap ON ap.suc = btrim(r.c1)
            AND ap.fac_doc = 'U'||CASE WHEN r.c29='C' THEN 'D' ELSE 'A' END||lpad(btrim(r.c4::text),2,'0')||lpad(btrim(r.c5::text),2,'0')
            AND ap.fac_folio = btrim(r.c6)
`;

/** La cartera: mismas 29 columnas, mismo orden, ahora apoyada en el núcleo. */
const CARTERA_SQL = `
CREATE OR REPLACE VIEW analytics.customer_receivables AS
WITH base AS (SELECT * FROM analytics.erp_receivable_documents),
cli AS (
  SELECT sucursal, COALESCE(cliente_code,'?') AS ck,
         round(sum(signed_amount),2) AS saldo_cliente,
         round(COALESCE(sum(saldo_documento) FILTER (WHERE cargo_abono='C'),0),2) AS residual_total
  FROM base GROUP BY 1,2
),
fifo AS (
  SELECT b.*, c.saldo_cliente,
    greatest(0, c.residual_total - greatest(c.saldo_cliente, 0)) AS remanente,
    sum(b.saldo_documento) OVER (
      PARTITION BY b.sucursal, COALESCE(b.cliente_code,'?')
      ORDER BY b.fecha, b.folio
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS corrido
  FROM base b
  JOIN cli c ON c.sucursal = b.sucursal AND c.ck = COALESCE(b.cliente_code,'?')
)
SELECT
  '${M}'::uuid AS tenant_id,
  sucursal, doc_code, doc_tipo, doc_label, folio, folio_digital, cliente_code,
  grupo, zona, fecha, vencimiento, importe, cargo_abono, signed_amount,
  estatus AS referencia,
  vendedor, moneda,
  'ods'::text AS source_branch,
  saldo_documento, aplicaciones,
  limite_credito, dias_credito, telefono,
  now() AS computed_at,
  CASE WHEN cargo_abono='C'
       THEN greatest(0, least(saldo_documento, round(corrido - remanente, 2)))
  END AS saldo_ajustado,
  saldo_cliente,
  dias_pago,
  estatus
FROM fifo
`;

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS kdue_distinct_key_idx
      ON kepler_ods.kdue (btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6), c7)`);
  // Sin esto el planner no tiene estadísticas de las expresiones y sigue con el seq scan.
  await knex.raw('ANALYZE kepler_ods.kdue');
  await knex.raw(CORE_SQL);
  await knex.raw('GRANT SELECT ON analytics.erp_receivable_documents TO app_runtime');
  await knex.raw(CARTERA_SQL);
  await knex.raw('GRANT SELECT ON analytics.customer_receivables TO app_runtime');
};

exports.down = async function down(knex) {
  // La cartera se queda apoyada en el núcleo: revertirla exigiría reponer el SQL viejo
  // completo, y el núcleo ya demostró ser idéntico. Sólo se suelta el índice.
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.kdue_distinct_key_idx');
};

// CREATE INDEX CONCURRENTLY no puede correr dentro de una transacción.
exports.config = { transaction: false };

exports.CORE_SQL = CORE_SQL;
exports.CARTERA_SQL = CARTERA_SQL;
