/**
 * TK.9 — `analytics.erp_sales_invoices` sale del mismo pozo que TK.7: un `DISTINCT ON` que no
 * deduplica nada y dos `btrim` que anulan PK existentes.
 *
 * ── Por qué ahora, si TK.7 lo dejó declarado como deuda ──────────────────────────────────
 * TK.7 arregló la vista del mostrador y dejó ésta anotada a propósito: 43 columnas y seis
 * consumidores (`weekly-analytics`, `commercial-profitability`, `commercial-televenta`,
 * `mv_kepler_sales_daily`, `product_volume_tiers`, `v_product_box_factor`) son un radio de
 * impacto que merece su propia medición.
 *
 * La medición llegó sola: al ejercer las consultas del **reporte por cliente** contra prod, el
 * lado de facturas tardó **11,483 ms** para 43 documentos. La deuda dejó de ser deuda y pasó a
 * ser el camino crítico — la pantalla no puede existir con ese número.
 *
 * ── Lo que cambia (idéntico a TK.7, mismo diagnóstico) ───────────────────────────────────
 *  1. Fuera el `DISTINCT ON` y su `ORDER BY`. Medido sobre el universo completo:
 *     **10,931 filas = 10,931 documentos distintos**. Cero repetidos. Era lo único que impedía
 *     empujar cualquier filtro que no fuera la identidad del documento.
 *  2. Los JOIN a `kdud` (cliente) y `kduv` (vendedor) ganan la igualdad CRUDA junto a la de
 *     `btrim`, para que `kdud_pkey (sucursal, c2)` y `kduv_pkey (sucursal, c2)` vuelvan a
 *     servir. Medido: cero padding en `kdud.sucursal/c2` (18,095 filas), en `kduv` (379) y en
 *     `kdm1.c10/c12` (663,747). Una condición extra sólo puede quitar filas, y no quita ninguna.
 *
 * ⚠️ **Y un tercer arreglo que no es de rendimiento sino de corrección:** `pg_get_viewdef`
 * imprime `LEFT JOIN warehouses w` **sin esquema** — la definición viva depende del
 * `search_path` que había cuando se creó. Re-crearla así la ataría al `search_path` de la
 * migración, que no tiene por qué ser el mismo. Queda calificada como `commercial.warehouses`.
 *
 * ⚠️ La definición sale de `pg_get_viewdef` de PROD y se transformó con un script, no a mano:
 * son 43 columnas y copiarlas a ojo es la forma de perder una sin que nadie lo note. El `up()`
 * vuelve a contar que sigan siendo 43.
 *
 * @param { import("knex").Knex } knex
 */

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
     LEFT JOIN analytics.erp_receivable_documents d ON d.sucursal = q.sucursal AND d.doc_code = q.doc_prefix AND d.folio = q.folio AND d.cargo_abono = 'C'::text`;

exports.up = async function up(knex) {
  // El candado, ANTES de tocar nada: quitar un DISTINCT ON sólo es seguro mientras no haya qué
  // deduplicar. Se comprueba contra los datos, no contra el recuerdo de haberlo medido.
  const { rows: [d] } = await knex.raw(`
    SELECT count(*)::bigint AS filas,
           count(DISTINCT (btrim(sucursal), (c4)::int, (c5)::int, btrim(c6)))::bigint AS docs
      FROM kepler_ods.kdm1
     WHERE c2='U' AND ((c3='D' AND (c4)::int = ANY(ARRAY[8,12])) OR (c3='A' AND (c4)::int = ANY(ARRAY[21,25,35])))
       AND btrim(c1)=btrim(sucursal)`);
  if (String(d.filas) !== String(d.docs)) {
    throw new Error(
      `kepler_ods.kdm1 trae ${d.filas} filas de factura/abono para ${d.docs} documentos distintos: ` +
      'el DISTINCT ON de erp_sales_invoices SI esta deduplicando. NO se puede quitar sin decidir ' +
      'antes cual de las filas repetidas es la buena. La vista queda como esta.');
  }

  const { rows: [p] } = await knex.raw(`
    SELECT (SELECT count(*) FROM kepler_ods.kdud WHERE sucursal <> btrim(sucursal) OR c2 <> btrim(c2))::bigint AS u,
           (SELECT count(*) FROM kepler_ods.kduv WHERE sucursal <> btrim(sucursal) OR c2 <> btrim(c2))::bigint AS v,
           (SELECT count(*) FROM kepler_ods.kdm1 WHERE c10 <> btrim(c10) OR c12 <> btrim(c12))::bigint AS h`);
  if (String(p.u) !== '0' || String(p.v) !== '0' || String(p.h) !== '0') {
    throw new Error(
      `Hay padding en las columnas del JOIN (kdud ${p.u} · kduv ${p.v} · kdm1 ${p.h}): atarlas ` +
      'crudas PERDERIA filas (el cliente o el vendedor quedarian en NULL). La vista queda como esta.');
  }
  console.log(`  ✓ ${d.filas} filas = ${d.docs} documentos, y cero padding en los JOIN.`);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sales_invoices AS ${VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoices TO app_runtime');

  const { rows: [c] } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_sales_invoices'`);
  if (c.n !== 43) {
    throw new Error(`analytics.erp_sales_invoices quedo con ${c.n} columnas, se esperaban 43: ` +
      'se perdio alguna al re-crear la definicion. Revisar contra pg_get_viewdef antes de seguir.');
  }
  console.log('  ✓ erp_sales_invoices: 43 columnas, sin DISTINCT ON y con las PK de catalogo usables.');
};

/** No-op: el `up` no agrega ni quita columnas. Volver atras seria reponer los 11 segundos. */
exports.down = async function down() {
  console.log('[erp_sales_invoices_sin_distinct_on] down: no-op (el cambio es de plan, no de datos)');
};
