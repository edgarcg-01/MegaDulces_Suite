/**
 * Fase AX.9 — la factura deja de mentir sobre tres cosas: si la pagaron, cuándo vence y
 * cuánto se descontó.
 *
 * Los tres arreglos salen de medir `/comercial/documentos` contra prod (2026-09-05):
 *
 * ── 1. "VENCIDA" NO SABIA SI YA TE PAGARON ───────────────────────────────────
 * El KPI marcaba 355 documentos vencidos por $3,320,754 en la ventana de 30 días. Cruzados
 * contra la cartera (`kdue`, el árbitro del saldo), **91 ya estaban liquidados ($567,504)**:
 * el vencido real eran 264 docs y **$2,028,423**. `vencida` sólo significaba "pasó la fecha".
 * Ahora la vista trae `saldo`, `cobrado` y `estatus_cobro` desde
 * `analytics.erp_receivable_documents` (el núcleo que comparte con la cartera — una sola
 * definición del saldo, ver 20260905150000).
 *
 * ⚠️ NO se usa `kdm1.c42`/`c43`, que están EN LA MISMA FILA y parecerían gratis. Decode
 * medido sobre 2,745 documentos de crédito (180d), separación perfecta:
 *     c43='N' -> c42 == total (sin un solo abono)   1592/1592 · 1357/1359 · 5431/5431
 *     c43='R' -> 0 < c42 < total (abono parcial)      62/62   ·  149/149
 *     c43='F' -> c42 == 0 (liquidado)                  5/5    ·  111/111
 *     c43='C' -> cancelado, total 0
 *   (y en mostrador U/D/10, 62,646 tickets 'F' con saldo 0: contado = liquidado al instante).
 * Pero la cabecera va REZAGADA: en 563 de 1,346 facturas TM, `c42` sigue diciendo que deben
 * todo mientras la cartera ya tiene el cobro con folio y fecha (`U/A/7` Cobro CFDI). Las 563
 * traen aplicaciones documentadas. Así que `c43` se decodifica y se expone como
 * `doc_estatus_label` —es información real sobre la cabecera— pero **el estado de cobro lo
 * manda kdue**, no la cabecera.
 *
 * ── 2. EL VENCIMIENTO ERA UNA RECONSTRUCCION, Y CONTRADECIA AL ERP ───────────
 * La vista lo calculaba `fecha + días de crédito del maestro DE HOY`. El ERP guarda en `kdue`
 * el que se pactó AL FACTURAR: **difieren en 329 de 729 (45%)**, hasta 25 días. El ERP es el
 * hecho; el derivado es una reconstrucción con el maestro equivocado (el de hoy).
 * Pero el de `kdue` tampoco está limpio: **57 de 729 vencen ANTES de su propia factura**, la
 * misma enfermedad por la que la Fase AX ya había descartado `kdm1.c18`.
 * Por ADR-056 el veredicto es ternario y viaja con el dato:
 *     `vencimiento_source='erp'`                   el de kdue, y es posterior a la factura
 *     `vencimiento_source='derivado_erp_invalido'` kdue trae una fecha imposible -> se deriva
 *     `vencimiento_source='derivado'`              el documento no está en cartera -> se deriva
 * Quien pinte una fecha sin mirar `vencimiento_source` está afirmando más de lo que sabe.
 *
 * ── 3. EL SUBTOTAL NO CUADRA CON LOS RENGLONES QUE SE IMPRIMEN ───────────────
 * Medido, sin una sola excepción: **el IEPS ya viene dentro del importe del renglón**. En las
 * 744 facturas TM sin descuento, Σ renglones == `total` EXACTO (744/744) y nunca
 * `total − ieps` (0/744). La identidad que se cumple siempre es
 *     **total = Σ renglones × (1 − descuento_pct/100)**   -> 1,268 de 1,268.
 * De ahí el bruto se despeja sin tocar `kdm2`: `importe_bruto = total / (1 − d)`. Validado
 * contra la suma real de renglones en **3,264 de 3,264 documentos** (peor delta $0.93),
 * contra 1,039/3,264 del `subtotal` viejo.
 * `descuento_efectivo = importe_bruto − total` reemplaza a `descuento` (`c13`), que NO es el
 * descuento aplicado: `Σ renglones − c13 == total` sólo se cumple en 985 de 1,268.
 * `subtotal` se CONSERVA con su fórmula (contrato de quien ya la lee) pero queda declarado
 * como lo que es: un **despeje fiscal sin árbitro**. La plataforma no puede verificarlo —
 * `fiscal.cfdis` tiene 167,503 filas y **todas son `rol='recibidas'`**, cero emitidos.
 *
 * ── 4. ETIQUETA EQUIVOCADA ───────────────────────────────────────────────────
 * `U/D/12` se rotulaba "Venta a crédito". El catálogo `kdmm` (que es la fuente, GOTCHAS: nunca
 * adivinar c4/c5) dice **`U/D/12` = "Factura Cont No Fiscal"** (contado) y `U/D/13` =
 * "Factura Cred No Fiscal". `doc_tipo` pasa de 'credito' a 'contado_nf'. Hoy no se veía porque
 * la pantalla filtra a telemarketing, pero mentía en cuanto se mostrara el otro tipo.
 *
 * Sólo se recrea la CABECERA: nada depende de ella (verificado en pg_depend) y
 * `erp_sales_invoice_lines` se queda como está.
 *
 * ── LO QUE CUESTA, MEDIDO ────────────────────────────────────────────────────
 * El LEFT JOIN a la cartera cobra **~750-880 ms fijos**, y los cobra igual busques 738
 * documentos o UNO. Medido en el `.245`, misma sesión, dos pasadas:
 *     lookup de 1 documento   6-11 ms  ->  764-794 ms
 *     lista de 30 días       25-29 ms  ->  735-881 ms
 * El costo es el `DISTINCT ON` sobre `kdue` del núcleo (528 ms; 46,843 filas de 423,799) y
 * **no se puede filtrar**: el WHERE del consumidor cae sobre columnas DERIVADAS
 * (`btrim(c1)`, `'U'||CASE…`), que el planner no sabe invertir para empujarlas al índice.
 * Se probó `WITH src AS NOT MATERIALIZED`: **no mejora** (774 vs 755 ms) y encima el CTE se
 * evaluaría dos veces.
 *
 * Se acepta a sabiendas: es el precio de que el vencido deje de contar $567,504 ya cobrados,
 * y la pantalla es un reporte, no un camino caliente. **Si algún día estorba** —el sospechoso
 * natural es el PDF del anexo, que llama a `detail()` por documento— la salida es retirar el
 * LEFT JOIN de ESTA vista y resolver la cobranza en el service con un segundo query, sólo en
 * `list()`/`kpis()`. No hay que inventar nada: el núcleo ya existe y ya está validado.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const DOCFILTER = `h.c2='U' AND h.c3='D' AND (h.c4)::int IN (8,12) AND btrim(h.c1)=btrim(h.sucursal)`;

const CABECERA = `
CREATE VIEW analytics.erp_sales_invoices AS
SELECT
  '${M}'::uuid AS tenant_id,
  q.sucursal, w.id AS warehouse_id,
  q.doc_prefix, q.doc_tipo, q.doc_label, q.folio,
  q.sucursal || q.doc_prefix || '-' || q.folio AS folio_digital,
  q.fecha,
  -- El vencimiento del ERP manda cuando es posterior a la factura; si no, se deriva y se dice.
  CASE WHEN d.vencimiento IS NOT NULL AND d.vencimiento >= q.fecha THEN d.vencimiento
       ELSE (q.fecha + (COALESCE(NULLIF(q.dias_credito,0),1) || ' days')::interval)::date END AS vencimiento,
  q.dias_credito, q.limite_credito,
  q.cliente_code, q.cliente_nombre, q.cliente_rfc,
  q.cliente_domicilio, q.cliente_colonia, q.cliente_estado, q.cliente_cp,
  q.vendedor_code, q.vendedor_nombre,
  q.canal, q.referencia, q.doc_origen,
  q.total, q.ieps, q.descuento, q.descuento_pct,
  -- DESPEJE fiscal, no un dato: la plataforma no tiene el CFDI emitido con qué contrastarlo.
  -- Para cuadrar contra los renglones que se imprimen, usar importe_bruto.
  round(q.total - q.ieps + q.descuento, 2) AS subtotal,
  q.doc_estatus, q.cancelada,
  'md_' || q.sucursal AS source_branch, now() AS computed_at,
  -- ── AX.9: cobranza (fuente: kdue vía el núcleo compartido) ──
  d.saldo_documento AS saldo,
  CASE WHEN d.saldo_documento IS NOT NULL
       THEN round(q.total - d.saldo_documento, 2) END AS cobrado,
  CASE WHEN q.cancelada                        THEN 'cancelada'
       WHEN d.saldo_documento IS NULL          THEN 'sin_cartera'
       WHEN d.saldo_documento <= 0.005         THEN 'pagada'
       WHEN d.saldo_documento < q.total - 0.005 THEN 'parcial'
       ELSE 'pendiente' END AS estatus_cobro,
  d.aplicaciones,
  d.dias_pago,
  -- ── AX.9: procedencia del vencimiento (ADR-056: ternario, viaja con el dato) ──
  d.vencimiento AS vencimiento_erp,
  CASE WHEN d.vencimiento IS NOT NULL AND d.vencimiento >= q.fecha THEN 'erp'
       WHEN d.vencimiento IS NOT NULL                              THEN 'derivado_erp_invalido'
       ELSE 'derivado' END AS vencimiento_source,
  -- ── AX.9: el dinero que SI cuadra con los renglones ──
  CASE WHEN q.descuento_pct > 0 AND q.descuento_pct < 100
       THEN round(q.total / (1 - q.descuento_pct/100), 2) ELSE q.total END AS importe_bruto,
  CASE WHEN q.descuento_pct > 0 AND q.descuento_pct < 100
       THEN round(q.total / (1 - q.descuento_pct/100) - q.total, 2) ELSE 0::numeric END AS descuento_efectivo,
  -- ── AX.9: c43 decodificado (estado SEGUN LA CABECERA; puede ir rezagado vs kdue) ──
  CASE q.doc_estatus WHEN 'N' THEN 'Sin abonos' WHEN 'R' THEN 'Abono parcial'
                     WHEN 'F' THEN 'Liquidada'  WHEN 'C' THEN 'Cancelada'
                     ELSE q.doc_estatus END AS doc_estatus_label
FROM (
  SELECT DISTINCT ON (btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text))
    btrim(h.sucursal) AS sucursal,
    'UD' || lpad((h.c4)::int::text,2,'0') || lpad((h.c5)::int::text,2,'0') AS doc_prefix,
    CASE (h.c4)::int WHEN 8 THEN 'telemarketing' ELSE 'contado_nf' END AS doc_tipo,
    CASE (h.c4)::int WHEN 8 THEN 'Factura Telemarketing' ELSE 'Factura Cont No Fiscal' END AS doc_label,
    btrim(h.c6::text) AS folio,
    h.c9::date AS fecha,
    NULLIF(btrim(h.c10::text),'') AS cliente_code,
    NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
    NULLIF(btrim(h.c22::text),'') AS cliente_rfc,
    NULLIF(btrim(h.c33::text),'') AS cliente_domicilio,
    NULLIF(btrim(h.c34::text),'') AS cliente_colonia,
    NULLIF(btrim(h.c35::text),'') AS cliente_estado,
    NULLIF(btrim(u.c27::text),'') AS cliente_cp,
    NULLIF(btrim(h.c12::text),'') AS vendedor_code,
    NULLIF(btrim(v.c3::text),'')  AS vendedor_nombre,
    NULLIF(btrim(h.c27::text),'') AS canal,
    NULLIF(btrim(h.c11::text),'') AS referencia,
    NULLIF(btrim(h.c43::text),'') AS doc_estatus,
    (btrim(h.c43::text) = 'C') AS cancelada,
    CASE WHEN NULLIF(btrim(h.c39::text),'') IS NULL THEN NULL
         ELSE 'UD' || lpad((h.c37)::int::text,2,'0') || lpad((h.c38)::int::text,2,'0')
              || '-' || btrim(h.c39::text) END AS doc_origen,
    ${money('h.c16')} AS total,
    ${money('h.c15')} AS ieps,
    ${money('h.c13')} AS descuento,
    coalesce(nullif(regexp_replace(h.c19::text,'[^0-9.]','','g'),'')::numeric,0) AS descuento_pct,
    coalesce(nullif(regexp_replace(u.c16::text,'[^0-9]','','g'),'')::int,0) AS dias_credito,
    ${money('u.c15')} AS limite_credito
  FROM kepler_ods.kdm1 h
  LEFT JOIN kepler_ods.kdud u
    ON btrim(u.sucursal)=btrim(h.sucursal) AND btrim(u.c2::text)=btrim(h.c10::text)
  LEFT JOIN kepler_ods.kduv v
    ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2::text)=btrim(h.c12::text)
  WHERE ${DOCFILTER}
  ORDER BY btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text)
) q
LEFT JOIN commercial.warehouses w
  ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL
LEFT JOIN analytics.erp_receivable_documents d
  ON d.sucursal = q.sucursal AND d.doc_code = q.doc_prefix AND d.folio = q.folio AND d.cargo_abono = 'C'`;

exports.up = async function up(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoices');
  await knex.raw(CABECERA);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoices TO app_runtime');
};

exports.down = async function down() {
  // Sin down: revertir exigiría reponer la cabecera de 20260824140000, y volvería a publicar
  // "vencida" sin mirar el saldo. Si hay que retroceder, se hace con una migración nueva.
};

exports.CABECERA = CABECERA;
