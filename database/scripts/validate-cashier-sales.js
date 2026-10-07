/* eslint-disable */
/**
 * validate-cashier-sales.js — ¿la venta que muestra la app es la de las cajeras?
 *
 * READ-ONLY. Nace de un reporte de campo: "los datos no coinciden con los datos
 * reales de las cajeras". Contrasta las TRES capas que hoy dicen cuánto vendió una
 * caja, contra el hecho independiente que es el CORTE de Kepler:
 *
 *   corte       analytics.cash_cuts          ← kdpv_folio_caja (lo que firma la cajera)
 *   por cajera  analytics.pos_ticket_sales   ← kdm1 U/D/10 agregado por c67
 *   en vivo     analytics.store_live_tickets ← poller (lo que pinta /tienda y /tienda/cajas)
 *
 * Y mide de frente las dos sospechas que salieron de leer el código:
 *
 *   S1 · RÉPLICA CRUZADA. Las DBs de sucursal arrastran documentos de OTRAS
 *        sucursales (dicho tal cual en import-cash-cuts.js). Los importers de
 *        corte/sesión/cajera filtran `c1 = sucursal`; el poller de tickets en vivo
 *        y la venta por caja de openSessions NO. Si `c1 <> sucursal` tiene volumen,
 *        la venta en vivo está inflada con tickets ajenos.
 *
 *   S2 · CANCELADOS. `kdm1.c43='C'` = cancelada (decode de la mig 20260824140000).
 *        En facturas U/D/8-12 las canceladas quedan en $0, así que no inflan dinero
 *        — pero eso NO está verificado para los tickets U/D/10 de mostrador, que es
 *        justo lo que cobran las cajeras. Acá se mide en U/D/10.
 *
 * Env:
 *   ODS_URL        kepler_ods (kdm1)                     [requerido]
 *   ANALYTICS_URL  postgres_platform / platform_test     [opcional, default = ODS_URL]
 *   FROM / TO      rango YYYY-MM-DD (default: últimos 7 días)
 *   BRANCH         acota a una sucursal ('01'…'06')
 *
 * Uso:
 *   ODS_URL="postgresql://usuario:pass@192.168.0.245:5432/platform_test" \
 *     node database/scripts/validate-cashier-sales.js
 */
const { Client } = require('pg');

const TENANT = process.env.MEGA_DULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const TO = process.env.TO || null;
const FROM = process.env.FROM || null;
const BRANCH = process.env.BRANCH || null;
const to = TO ? `DATE '${TO}'` : `(now() AT TIME ZONE 'America/Mexico_City')::date`;
const from = FROM ? `DATE '${FROM}'` : `(${to} - 7)`;
const brOds = BRANCH ? ` AND sucursal = '${BRANCH}'` : '';
const brCol = (c) => (BRANCH ? ` AND ${c} = '${BRANCH}'` : '');

const ICON = { OK: 'OK ', WARN: 'WARN', FAIL: 'FAIL', INFO: 'INFO' };
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (a, b) => (Number(b) ? ((Number(a) / Number(b)) * 100).toFixed(2) + '%' : '--');
const veredicto = [];
const say = (lvl, t, d) => {
  veredicto.push({ lvl, t, d });
  console.log(`\n[${ICON[lvl]}] ${t}\n   ${d}`);
};

async function main() {
  const ods = new Client({ connectionString: process.env.ODS_URL });
  await ods.connect();
  const distinta = process.env.ANALYTICS_URL && process.env.ANALYTICS_URL !== process.env.ODS_URL;
  let an = ods;
  if (distinta) {
    an = new Client({ connectionString: process.env.ANALYTICS_URL });
    await an.connect();
  }

  console.log(
    `\n==== VENTA DE CAJERAS · ${FROM || '(hoy-7)'} -> ${TO || 'hoy'} ${BRANCH ? `· suc ${BRANCH}` : '· todas'} ====`,
  );

  // -- S1: réplica cruzada en los tickets de mostrador -----------------------
  const rep = (
    await ods.query(`
    SELECT sucursal,
           count(*) FILTER (WHERE btrim(c1) = btrim(sucursal))::int  AS propios,
           count(*) FILTER (WHERE btrim(c1) <> btrim(sucursal))::int AS ajenos,
           round(coalesce(sum(c16::numeric) FILTER (WHERE btrim(c1) <> btrim(sucursal)),0),2) AS importe_ajeno,
           round(coalesce(sum(c16::numeric),0),2) AS importe_total
      FROM kepler_ods.kdm1
     WHERE c2='U' AND c3='D' AND c4::text='10'
       AND c9::date BETWEEN ${from} AND ${to}${brOds}
     GROUP BY sucursal ORDER BY sucursal`)
  ).rows;
  console.log('\nS1 · tickets U/D/10 por sucursal -- cuantos son de OTRA sucursal?');
  console.table(
    rep.map((r) => ({
      sucursal: r.sucursal,
      propios: r.propios,
      ajenos: r.ajenos,
      '$ ajeno': money(r.importe_ajeno),
      '% inflado': pct(r.importe_ajeno, Number(r.importe_total) - Number(r.importe_ajeno)),
    })),
  );
  const ajeno = rep.reduce((a, r) => a + Number(r.importe_ajeno || 0), 0);
  const propio = rep.reduce((a, r) => a + (Number(r.importe_total) - Number(r.importe_ajeno)), 0);
  say(
    ajeno > 0 ? 'FAIL' : 'OK',
    'S1 · replica cruzada en tickets de mostrador',
    ajeno > 0
      ? `${money(ajeno)} de tickets ajenos (${pct(ajeno, propio)} sobre la venta propia). El poller y openSessions NO filtran c1=sucursal -> esa plata se le carga a la sucursal y a la CAJA equivocada.`
      : 'No hay documentos con c1<>sucursal en la ventana: la falta del filtro no esta inflando HOY (puede volver a aparecer).',
  );

  // -- S2: cancelados en U/D/10 ---------------------------------------------
  const can = (
    await ods.query(`
    SELECT coalesce(nullif(btrim(c43::text),''),'(vacio)') estatus,
           count(*)::int docs, round(coalesce(sum(c16::numeric),0),2) importe,
           count(*) FILTER (WHERE coalesce(c16::numeric,0) <> 0)::int con_importe
      FROM kepler_ods.kdm1
     WHERE c2='U' AND c3='D' AND c4::text='10' AND btrim(c1)=btrim(sucursal)
       AND c9::date BETWEEN ${from} AND ${to}${brOds}
     GROUP BY 1 ORDER BY importe DESC`)
  ).rows;
  console.log('\nS2 · U/D/10 por estatus (c43) -- las canceladas traen dinero?');
  console.table(
    can.map((r) => ({ estatus: r.estatus, docs: r.docs, importe: money(r.importe), 'con importe<>0': r.con_importe })),
  );
  const c = can.find((r) => r.estatus === 'C');
  say(
    !c ? 'OK' : Number(c.con_importe) ? 'FAIL' : 'WARN',
    'S2 · tickets cancelados',
    !c
      ? 'No hay U/D/10 cancelados en la ventana.'
      : Number(c.con_importe)
        ? `${c.docs} tickets cancelados conservan importe (${money(c.importe)}). Ningun lector de tickets filtra c43='C' -> esa venta NO existe y se esta contando.`
        : `${c.docs} cancelados, todos en $0 (como en las facturas U/D/8-12). Infla el CONTEO de tickets, no el dinero.`,
  );

  // -- Cruce de capas contra el corte ----------------------------------------
  try {
    const cmp = (
      await an.query(
        `
      WITH corte AS (
        SELECT warehouse_code, business_date, round(sum(venta_total)::numeric,2) v
          FROM analytics.cash_cuts WHERE tenant_id=$1
           AND business_date BETWEEN ${from} AND ${to}${brCol('warehouse_code')}
         GROUP BY 1,2),
      cajera AS (
        SELECT warehouse_code, business_date, round(sum(ticket_total)::numeric,2) v
          FROM analytics.pos_ticket_sales WHERE tenant_id=$1
           AND business_date BETWEEN ${from} AND ${to}${brCol('warehouse_code')}
         GROUP BY 1,2),
      vivo AS (
        SELECT warehouse_code,
               (ticket_ts AT TIME ZONE 'America/Mexico_City')::date business_date,
               round(sum(total)::numeric,2) v
          FROM analytics.store_live_tickets WHERE tenant_id=$1
           AND (ticket_ts AT TIME ZONE 'America/Mexico_City')::date BETWEEN ${from} AND ${to}${brCol('warehouse_code')}
         GROUP BY 1,2)
      SELECT coalesce(c.warehouse_code,k.warehouse_code,v.warehouse_code) suc,
             coalesce(c.business_date,k.business_date,v.business_date) dia,
             c.v corte, k.v cajera, v.v vivo,
             round(coalesce(v.v,0)-coalesce(c.v,0),2) delta_vivo_corte
        FROM corte c
        FULL JOIN cajera k ON k.warehouse_code=c.warehouse_code AND k.business_date=c.business_date
        FULL JOIN vivo  v ON v.warehouse_code=coalesce(c.warehouse_code,k.warehouse_code)
                         AND v.business_date=coalesce(c.business_date,k.business_date)
       ORDER BY 2 DESC, 1`,
        [TENANT],
      )
    ).rows;
    console.log('\nCRUCE · corte (firma la cajera) vs por-cajera vs en-vivo (lo que pinta la app)');
    console.table(
      cmp.map((r) => ({
        suc: r.suc,
        dia: String(r.dia).slice(0, 10),
        corte: money(r.corte),
        cajera: money(r.cajera),
        vivo: money(r.vivo),
        'D vivo-corte': money(r.delta_vivo_corte),
      })),
    );
    const desc = cmp.filter((r) => Math.abs(Number(r.delta_vivo_corte || 0)) > 100);
    say(
      desc.length ? 'FAIL' : 'OK',
      'CRUCE · en-vivo vs corte',
      desc.length
        ? `${desc.length} de ${cmp.length} dias-sucursal difieren mas de $100 del corte.`
        : 'Todos los dias-sucursal cuadran a +/-$100 contra el corte.',
    );
  } catch (e) {
    say('INFO', 'CRUCE omitido', `No se pudo leer analytics.*: ${e.message}`);
  }

  console.log('\n==== RESUMEN ====');
  for (const v of veredicto) console.log(`[${ICON[v.lvl]}] ${v.t}`);
  await ods.end();
  if (an !== ods) await an.end();
  process.exit(veredicto.some((v) => v.lvl === 'FAIL') ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
