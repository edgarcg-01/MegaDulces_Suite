/**
 * AX.9 — smoke de los cuatro arreglos de `/comercial/documentos`.
 *
 * Cada bloque comprueba un hecho MEDIDO, no una intención:
 *   1. "vencida" = venció Y debe          -> las liquidadas salen del conteo (prueba NEGATIVA)
 *   2. el saldo viene de la cartera        -> cuadra al peso con `customer_receivables`
 *   3. `importe_bruto` cuadra con el detalle -> es lo que se imprime en el anexo
 *   4. procedencia del vencimiento         -> ternario, y ninguna fecha 'erp' es anterior a la factura
 *   5. `doc_tipo`/`doc_label` según `kdmm` -> U/D/12 es "Factura Cont No Fiscal", no "Venta a crédito"
 *
 * Lo que no se puede medir se reporta `NO MEDIDO` (nunca ✔ por falta de datos).
 * Read-only. Uso: node database/tests/test-newdb-sales-docs-cobranza.js
 */
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const URL = process.env.DATABASE_URL_NEW || process.env.FLEET_DB_URL;
const VENTANA = 90;

let ok = 0, fail = 0, skip = 0;
const check = (n, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK   ${n}`); } else { fail++; console.log(`  FAIL ${n}  ${det}`); }
};
const noMedido = (n, motivo) => { skip++; console.log(`  NO MEDIDO  ${n} — ${motivo}`); };

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW / FLEET_DB_URL'); process.exit(1); }
  const c = new Client({ connectionString: URL, ssl: false });
  await c.connect();
  console.log(`\n=== AX.9 · cobranza y procedencia en /comercial/documentos (${VENTANA}d) ===`);

  const existe = (await c.query(`
    SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema='analytics' AND table_name='erp_sales_invoices' AND column_name='estatus_cobro'`)).rows[0].n;
  if (!existe) {
    console.log('  FAIL  la vista no trae estatus_cobro: falta aplicar 20260905150100');
    await c.end(); process.exit(1);
  }

  const W = `WHERE fecha >= current_date - ${VENTANA} AND doc_tipo='telemarketing' AND NOT cancelada`;

  // ── 1. "vencida" ya no cuenta las pagadas ──────────────────────────────────
  const v = (await c.query(`
    SELECT count(*) FILTER (WHERE vencimiento < current_date)::int viejo,
           count(*) FILTER (WHERE vencimiento < current_date
                              AND estatus_cobro IN ('pendiente','parcial'))::int nuevo,
           count(*) FILTER (WHERE vencimiento < current_date AND estatus_cobro='pagada')::int pagadas_vencidas,
           round(coalesce(sum(total) FILTER (WHERE vencimiento < current_date AND estatus_cobro='pagada'),0),2) importe_liberado,
           round(coalesce(sum(saldo) FILTER (WHERE vencimiento < current_date
                              AND estatus_cobro IN ('pendiente','parcial')),0),2) saldo_vencido
    FROM analytics.erp_sales_invoices ${W}`)).rows[0];
  const sinCartVenc = (await c.query(`
    SELECT count(*)::int n FROM analytics.erp_sales_invoices ${W}
      AND vencimiento < current_date AND estatus_cobro='sin_cartera'`)).rows[0].n;
  console.log(`\n1) vencidas: ${v.viejo} (sólo fecha) -> ${v.nuevo} (fecha + saldo) · saldo real $${v.saldo_vencido}`);
  check('el conteo nuevo nunca supera al viejo', v.nuevo <= v.viejo, `${v.nuevo} > ${v.viejo}`);
  // PRUEBA NEGATIVA: si hay facturas pagadas que ya vencieron, el gate TIENE que excluirlas.
  // Un gate que nunca se probó rompiéndolo es una intención, no una compuerta.
  if (v.pagadas_vencidas > 0) {
    check(`el gate excluye las ${v.pagadas_vencidas} pagadas que ya vencieron ($${v.importe_liberado})`,
      v.nuevo === v.viejo - v.pagadas_vencidas - sinCartVenc,
      `viejo=${v.viejo} nuevo=${v.nuevo} pagadas=${v.pagadas_vencidas} sin_cartera=${sinCartVenc}`);
  } else {
    noMedido('el gate excluye pagadas vencidas', 'no hay ninguna pagada vencida en la ventana');
  }
  check('una factura marcada "pagada" nunca conserva saldo', (await c.query(`
    SELECT count(*)::int n FROM analytics.erp_sales_invoices ${W}
      AND estatus_cobro='pagada' AND coalesce(saldo,0) > 0.005`)).rows[0].n === 0);
  console.log(`   (${sinCartVenc} vencidas sin rastro en cartera: cobro DESCONOCIDO, fuera del conteo y declaradas en pantalla)`);

  // ── 2. el saldo lo manda la cartera ────────────────────────────────────────
  const s = (await c.query(`
    SELECT count(*)::int docs,
           count(*) FILTER (WHERE abs(i.saldo - r.saldo_documento) > 0.005)::int difiere
    FROM analytics.erp_sales_invoices i
    JOIN analytics.customer_receivables r ON r.folio_digital = i.folio_digital AND r.cargo_abono='C'
    WHERE i.fecha >= current_date - ${VENTANA} AND i.doc_tipo='telemarketing' AND NOT i.cancelada`)).rows[0];
  console.log(`\n2) saldo cruzado contra la cartera en ${s.docs} documentos`);
  check('el saldo de la vista == el de customer_receivables', s.difiere === 0, `${s.difiere} difieren`);
  check('cobrado + saldo == total', (await c.query(`
    SELECT count(*)::int n FROM analytics.erp_sales_invoices ${W}
      AND saldo IS NOT NULL AND abs(cobrado + saldo - total) > 0.02`)).rows[0].n === 0);

  // ── 3. el dinero que se imprime cuadra con el detalle ──────────────────────
  const b = (await c.query(`
    WITH i AS (SELECT folio_digital, total, ieps, descuento, descuento_pct, subtotal, importe_bruto
               FROM analytics.erp_sales_invoices ${W}),
         l AS (SELECT folio_digital, round(sum(importe),2) suma FROM analytics.erp_sales_invoice_lines GROUP BY 1)
    SELECT count(*)::int docs,
           count(*) FILTER (WHERE abs(i.importe_bruto - l.suma) <= 1)::int cuadra_bruto,
           count(*) FILTER (WHERE abs(i.subtotal - l.suma) <= 1)::int cuadra_subtotal,
           -- el numerador tiene que llevar LAS MISMAS dos condiciones que el denominador:
           -- sin la de IEPS colaba las facturas exentas y el conteo salia mayor que el total.
           count(*) FILTER (WHERE i.descuento_pct = 0 AND i.ieps > 0
                              AND abs(l.suma - i.total) <= 0.05)::int ieps_dentro,
           count(*) FILTER (WHERE i.descuento_pct = 0 AND i.ieps > 0)::int sin_desc_con_ieps,
           -- y el contraejemplo: si el IEPS estuviera FUERA, Σrenglones sería total − ieps
           count(*) FILTER (WHERE i.descuento_pct = 0 AND i.ieps > 0
                              AND abs(l.suma - (i.total - i.ieps)) <= 0.05)::int ieps_fuera
    FROM i JOIN l USING (folio_digital)`)).rows[0];
  console.log(`\n3) bruto vs renglones: ${b.cuadra_bruto}/${b.docs} (el subtotal viejo: ${b.cuadra_subtotal}/${b.docs})`);
  check('importe_bruto cuadra con Σ renglones en el 100%', b.cuadra_bruto === b.docs,
    `${b.docs - b.cuadra_bruto} no cuadran`);
  if (b.sin_desc_con_ieps > 0) {
    check(`el IEPS ya viene dentro del renglón (${b.sin_desc_con_ieps} facturas sin descuento y con IEPS)`,
      b.ieps_dentro === b.sin_desc_con_ieps, `${b.sin_desc_con_ieps - b.ieps_dentro} no cumplen`);
    check('...y NO fuera: Σrenglones nunca es total − IEPS', b.ieps_fuera === 0, `${b.ieps_fuera} sí lo son`);
  } else {
    noMedido('el IEPS viene dentro del renglón', 'no hay facturas sin descuento y con IEPS en la ventana');
  }

  // ── 4. procedencia del vencimiento ─────────────────────────────────────────
  const p = (await c.query(`
    SELECT vencimiento_source AS src, count(*)::int n FROM analytics.erp_sales_invoices ${W}
    GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log(`\n4) vencimiento_source: ${p.map((r) => `${r.src}=${r.n}`).join(' · ')}`);
  check('sólo los tres estados declarados',
    p.every((r) => ['erp', 'derivado', 'derivado_erp_invalido'].includes(r.src)),
    p.map((r) => r.src).join(','));
  check('ninguna fecha marcada "erp" es anterior a su factura', (await c.query(`
    SELECT count(*)::int n FROM analytics.erp_sales_invoices ${W}
      AND vencimiento_source='erp' AND vencimiento < fecha`)).rows[0].n === 0);
  check('las derivadas nunca usan la fecha inválida del ERP', (await c.query(`
    SELECT count(*)::int n FROM analytics.erp_sales_invoices ${W}
      AND vencimiento_source='derivado_erp_invalido' AND vencimiento = vencimiento_erp`)).rows[0].n === 0);

  // ── 5. las etiquetas dicen lo que dice kdmm ────────────────────────────────
  const et = (await c.query(`
    SELECT doc_prefix, doc_tipo, doc_label, count(*)::int n
    FROM analytics.erp_sales_invoices WHERE fecha >= current_date - ${VENTANA} GROUP BY 1,2,3`)).rows;
  console.log(`\n5) etiquetas: ${et.map((r) => `${r.doc_prefix}=${r.doc_tipo}/${r.doc_label}`).join(' · ')}`);
  const ud12 = et.find((r) => r.doc_prefix === 'UD1201');
  if (ud12) {
    check('U/D/12 es "Factura Cont No Fiscal" (kdmm), no "Venta a crédito"',
      ud12.doc_label === 'Factura Cont No Fiscal' && ud12.doc_tipo === 'contado_nf',
      `${ud12.doc_tipo}/${ud12.doc_label}`);
  } else {
    noMedido('la etiqueta de U/D/12', 'no hay documentos U/D/12 en la ventana');
  }
  check('doc_estatus_label decodifica c43', (await c.query(`
    SELECT count(*)::int n FROM analytics.erp_sales_invoices
    WHERE fecha >= current_date - ${VENTANA} AND doc_estatus IN ('N','R','F','C')
      AND doc_estatus_label NOT IN ('Sin abonos','Abono parcial','Liquidada','Cancelada')`)).rows[0].n === 0);

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
