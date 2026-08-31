/**
 * Fase CXC — **el saldo cuadra con Kepler** + los doctypes que faltaban + días de pago.
 *
 * Tres correcciones a la vista de cartera, todas medidas contra prod (2026-08-31):
 *
 * ── 1. EL SALDO ESTABA INFLADO $3.72M (+8.1%) ─────────────────────────────────
 * La página sumaba `saldo_documento` (= importe − aplicado en `kdm5`). El saldo verdadero,
 * el que se verificó al peso contra el PDF de Kepler, es `Σ signed_amount` sobre `kdue`
 * (cargo +, abono −). La diferencia se descompuso exacta, por sucursal:
 *   · $2.04M  el `greatest(0, …)` recortaba en silencio lo aplicado de más (casi todo CEDIS)
 *   · $1.56M  abonos que existen en kdue pero no tienen linaje en kdm5 → nunca restaban
 *   · $0.11M  aplicado a documentos fuera del filtro de la vista
 * Y al revés: 213 clientes con saldo A FAVOR que la página no mostraba nunca.
 *
 * Fix: `saldo_ajustado`. El total por cliente lo manda `kdue`; el **remanente** (lo que los
 * abonos no lograron ubicar en un documento) se reparte **FIFO sobre las partidas más viejas**,
 * que es el estándar de antigüedad de saldos. Así `Σ saldo_ajustado = max(Σ signed, 0)` exacto,
 * y el aging sigue teniendo detalle por documento. `saldo_documento` se conserva: es lo que
 * kdm5 afirma, y el drill lo necesita para mostrar los cobros aplicados a cada factura.
 *
 * ── 2. DOCTYPES QUE LA CARTERA IGNORABA ───────────────────────────────────────
 * Censo completo de `kdue` (nunca adivinar: `kdmm` es el catálogo). Faltaban, con saldo vivo:
 *   · C-41 Embarque Sucursal  1,095 docs  **$605,397**  ← en la suc 02 el embarque ES el cargo
 *   · A-40 Anticipo               3 docs  **−$509,844** ← dinero del cliente que no se restaba
 *   · C-9  Ticket Crédito         6 docs      $18,139
 *   · A-30 Ajuste Abono / A-35 Nota de crédito  30 docs  −$22,571
 *   · C-3  Factura TK Crédito     2 docs           $1.16
 * Siguen FUERA por ser contado, no cartera: C-10 Ticket Contado ($89.9M) y C-5 Factura TK
 * Contado ($2.37M).
 *
 * ── 3. DÍAS DE PAGO (nuevo) ───────────────────────────────────────────────────
 * `dias_pago` = cuánto tardó en cobrarse el documento (última aplicación − fecha), sólo en los
 * que quedaron saldados. Habilita priorizar la cobranza por comportamiento y no sólo por monto:
 * medido en 24,705 pagos de 317 clientes, promedio 13.2 días y mediana 3.
 *
 * ── Además ────────────────────────────────────────────────────────────────────
 * `kdue.c16` NO es una referencia: es el ESTATUS del documento ('EMBARCADO'). El decode venía
 * mal desde el origen. Se expone bien como `estatus`; `referencia` se conserva (mismo dato,
 * nombre equivocado) sólo para no romper a quien ya la lea — deprecada, usar `estatus`.
 *
 * Va `CREATE OR REPLACE` con las columnas viejas EN EL MISMO ORDEN y las nuevas al final, a
 * propósito: un DROP se llevaría por delante cualquier objeto que cuelgue de la vista (en el
 * `.245`, que es cluster compartido, hay una matview `analytics.mv_customer_receivables` que
 * no está en el repo ni en prod — de otro dev). Renombrar la columna habría exigido el DROP.
 *
 * OJO al desplegar: reemplazar una vista que el pool ya consultó invalida sus planes cacheados →
 * burst transitorio de `0A000` hasta que reciclen las conexiones. Acá sólo se leen reportes
 * (nada de escrituras en vuelo), así que degrada a un request fallido, no a una trx abortada.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const VIEW_SQL = `
CREATE OR REPLACE VIEW analytics.customer_receivables AS
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
-- Fecha del documento que aplica: kdm5 no la tiene (llega hasta c14='EMBARCADO'), kdue sí.
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
),
base AS (
  SELECT
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
    -- Cuánto tardó en cobrarse (sólo si quedó saldado): comportamiento de pago del cliente.
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
),
-- Saldo REAL del cliente = Σ signed sobre kdue (la fórmula verificada contra el PDF).
cli AS (
  SELECT sucursal, COALESCE(cliente_code,'?') AS ck,
         round(sum(signed_amount),2) AS saldo_cliente,
         round(COALESCE(sum(saldo_documento) FILTER (WHERE cargo_abono='C'),0),2) AS residual_total
  FROM base GROUP BY 1,2
),
fifo AS (
  SELECT b.*, c.saldo_cliente,
    -- Lo que los abonos no lograron ubicar en ningún documento (clamp + sin linaje kdm5).
    greatest(0, c.residual_total - greatest(c.saldo_cliente, 0)) AS remanente,
    sum(b.saldo_documento) OVER (
      PARTITION BY b.sucursal, COALESCE(b.cliente_code,'?')
      ORDER BY b.fecha, b.folio
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS corrido
  FROM base b
  JOIN cli c ON c.sucursal = b.sucursal AND c.ck = COALESCE(b.cliente_code,'?')
)
-- ORDEN DE COLUMNAS: las 25 originales primero y en su mismo orden (requisito de
-- CREATE OR REPLACE), las nuevas al final.
SELECT
  '${M}'::uuid AS tenant_id,
  sucursal, doc_code, doc_tipo, doc_label, folio, folio_digital, cliente_code,
  grupo, zona, fecha, vencimiento, importe, cargo_abono, signed_amount,
  estatus AS referencia,  -- deprecada: nombre equivocado, es el estatus. Usar la columna estatus.
  vendedor, moneda,
  'ods'::text AS source_branch,
  saldo_documento, aplicaciones,
  limite_credito, dias_credito, telefono,
  now() AS computed_at,
  -- ── nuevas ──
  -- El remanente se come las partidas MÁS VIEJAS primero (FIFO), hasta agotarse.
  CASE WHEN cargo_abono='C'
       THEN greatest(0, least(saldo_documento, round(corrido - remanente, 2)))
  END AS saldo_ajustado,
  saldo_cliente,
  dias_pago,
  estatus
FROM fifo
`;

exports.up = async function up(knex) {
  await knex.raw(VIEW_SQL);
  await knex.raw(`GRANT SELECT ON analytics.customer_receivables TO app_runtime`);
};

exports.down = async function down() {
  // No revierte: volver atrás reintroduce el saldo inflado. Si hiciera falta, la versión
  // anterior está en la mig 20260831120000.
};
