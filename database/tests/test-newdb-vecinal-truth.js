'use strict';
/**
 * `[VEC.3]` Candado de la venta de RUTA VECINAL derivada del ODS.
 *
 *   node database/tests/test-newdb-vecinal-truth.js
 *
 * Sólo lee. No escribe una sola fila.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 *
 * El 2026-10-06 la pantalla `/ventas-por-ruta` publicaba **$9,164,175.91** de venta vecinal 2026
 * contra **$4,417,300.50** reales — **2.07×** — porque el importer unía cabecera y líneas sin la
 * CAJA (`c5`) y le pegaba a cada ticket las líneas de los tickets homónimos de las otras cajas.
 * El defecto sobrevivió meses porque **nada comparaba la cifra contra un testigo independiente**:
 * el feed se verificaba contra sí mismo.
 *
 * Por eso este candado no pregunta "¿corre?". Pregunta cuatro cosas que pueden fallar en silencio:
 *
 *  1. **¿La cifra aguanta a un árbitro que no comparte su método?** `kdm1.c16` es el total del
 *     documento, escrito por el ERP, y no depende de cómo se unan las líneas. Si el join se
 *     rompe otra vez, el árbitro no se rompe con él.
 *  2. **¿El defecto que esto corrige sigue siendo posible?** Un candado que sólo comprueba lo
 *     que ya está bien se pone verde el día que alguien lo desactiva. Acá se ejerce el join malo
 *     a propósito: **debe dar más**. Si diera lo mismo, este candado no estaría midiendo nada y
 *     lo dice en vez de aprobar.
 *  3. **¿Se publican TODAS las rutas?** La lista a mano del importer dejaba fuera a Zamora y a
 *     las dos de Morelia: $1,815,047.93 que nadie veía. Acá se cuenta contra el ODS.
 *  4. **¿`U-D-12` sigue siendo el espejo del ticket?** La exclusión descansa en una medición
 *     (99.8% de las líneas ya estaban en `U-D-10`, placebo 0). Si esa premisa cambia, el candado
 *     avisa en vez de dejar que la exclusión se vuelva un hueco.
 *
 * ⚠️ Lo que no se puede medir se reporta `NO MEDIDO`, nunca ✔. Un mes sin ventas vecinales no es
 * un mes correcto: es un mes sin evidencia.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c';
const VECINAL_RX = '^[0-9]V[0-9]';
const GATE_MS = 1000; // la matriz anual de la pantalla; por encima de esto se siente lenta

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const money = (v) => '$' + Number(v || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Universo del ERP: los documentos que SON venta de ruta vecinal. Un solo lugar. */
const DOCS_VECINALES = `
  FROM kepler_ods.kdm1 h
 WHERE h.c2='U' AND h.c3='D' AND (h.c4)::integer = 10
   AND btrim(COALESCE(h.c12,'')) ~ '${VECINAL_RX}'
   AND btrim(COALESCE(h.c1,'')) = btrim(h.sucursal)
   AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
   AND (h.c9)::date <= ((now() AT TIME ZONE 'America/Mexico_City'))::date`;

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [VEC.3] venta de ruta vecinal: derivada del ODS y arbitrada ===\n');
  try {
    // ── 1. Los objetos existen y conservan su forma ──────────────────────────────────────────
    // ⚠️ `CREATE OR REPLACE VIEW` conserva el dueño pero esta casa ya perdió un GRANT en uno, y
    // sólo lo vio una aserción de metadata como ésta (ADR-057).
    const meta = (await db.raw(
      `SELECT c.relname::text AS vista,
              COALESCE(c.reloptions::text,'') LIKE '%security_invoker%' AS invoker,
              has_table_privilege('app_runtime', c.oid, 'SELECT') AS lee_runtime
         FROM pg_class c
        WHERE c.relnamespace='analytics'::regnamespace
          AND c.relname IN ('v_kepler_vecinal_sales_lines','v_kepler_vecinal_monthly')
        ORDER BY 1`)).rows;
    t('las dos vistas existen', meta.length === 2, `encontradas: ${meta.map((m) => m.vista).join(', ') || 'ninguna'}`);
    for (const m of meta) {
      t(`${m.vista}: security_invoker`, m.invoker === true);
      t(`${m.vista}: app_runtime puede leerla`, m.lee_runtime === true);
    }
    if (meta.length !== 2) throw new Error('faltan las vistas: el resto del candado no aplica');

    // ── 2. Cabecera contra líneas, DOCUMENTO POR DOCUMENTO ───────────────────────────────────
    //
    // Ésta es la aserción que de verdad protege, y por eso va por documento y no por mes: en el
    // mes, un ticket inflado y otro faltante se compensan y el total parece sano. Por documento
    // no hay dónde esconderse — si el join suelta la caja, las líneas EXCEDEN al ticket.
    //
    // La identidad que debe cumplirse es `Σ líneas == total + descuento` (las líneas vienen en
    // bruto; `kdm1.c13` es lo que se rebajó al cobrar).
    //
    // ⚠️ Se mide sólo sobre los documentos que TIENEN líneas. Los que no las tienen son el hueco
    // de la fuente que la vista ya declara aparte: mezclarlos aquí convertiría un dato conocido
    // en un fallo del join, que es justo lo que esta aserción busca distinguir.
    const porDoc = (await db.raw(
      `WITH d AS (
         SELECT warehouse_code, caja, folio, business_date, total, descuento
           FROM analytics.v_kepler_vecinal_sales_docs WHERE tenant_id = ?),
       l AS (
         SELECT warehouse_code, caja, folio, business_date, sum(importe) AS imp
           FROM analytics.v_kepler_vecinal_sales_lines WHERE tenant_id = ? GROUP BY 1,2,3,4)
       SELECT count(*)::int AS docs_con_lineas,
              count(*) FILTER (WHERE abs(l.imp - (d.total + d.descuento)) > 0.05)::int AS difieren,
              COALESCE(max(abs(l.imp - (d.total + d.descuento))),0)::numeric AS peor,
              COALESCE(sum(d.total),0)::numeric AS total
         FROM d JOIN l ON l.warehouse_code=d.warehouse_code AND l.caja=d.caja
                      AND l.folio=d.folio AND l.business_date=d.business_date`, [T, T])).rows[0];
    if (!Number(porDoc.docs_con_lineas)) noMedido('las líneas cuadran con el ticket', 'no hay documentos vecinales con líneas');
    else {
      // ⚠️ El umbral NO es cero, y la razón está medida: 33 de 8,178 documentos (0.40%) difieren
      // por dos motivos que son de la fuente, no del cálculo — el prorrateo del descuento por
      // renglón, que no vuelve a cuadrar al centavo con el de la cabecera (±$25 sobre tickets de
      // $9,000), y algún ticket al que le faltan renglones en el ODS.
      //
      // Lo que este umbral SÍ atrapa es la regresión que importa: si alguien vuelve a soltar la
      // caja del join, no difieren 33 documentos, difieren casi todos.
      const pct = Number(porDoc.difieren) / Number(porDoc.docs_con_lineas);
      t(`las líneas cuadran con el ticket en ${((1 - pct) * 100).toFixed(2)}% de los ${porDoc.docs_con_lineas} documentos con desglose (${money(porDoc.total)})`,
        pct < 0.01, `${porDoc.difieren} documentos difieren (${(pct * 100).toFixed(2)}%), peor desvío ${money(porDoc.peor)}`);
    }

    // ── 2-bis. El hueco de la fuente, declarado y vigilado ───────────────────────────────────
    // No es un fallo del reporte: hay tickets cobrados cuyas líneas no llegaron al ODS. Lo que
    // sí sería un fallo es publicarlos sin decirlo, o que el hueco crezca sin que nadie mire.
    const hueco = (await db.raw(
      `SELECT COALESCE(sum(docs_sin_lineas),0)::int AS docs,
              COALESCE(sum(importe_sin_lineas),0)::numeric AS importe,
              COALESCE(sum(revenue),0)::numeric AS total
         FROM analytics.v_kepler_vecinal_monthly WHERE tenant_id = ?`, [T])).rows[0];
    const pctHueco = Number(hueco.total) ? Number(hueco.importe) / Number(hueco.total) : 0;
    t(`la venta sin desglose está declarada y es marginal: ${hueco.docs} tickets, ${money(hueco.importe)} (${(pctHueco * 100).toFixed(2)}% del total)`,
      pctHueco < 0.05, `subió al ${(pctHueco * 100).toFixed(2)}%: las líneas del ERP están llegando mal`);

    // ── 3. Prueba NEGATIVA: el join sin la caja tiene que dar MÁS ────────────────────────────
    // Si esto dejara de ser cierto, o el ERP cambió de forma o alguien "arregló" el universo: en
    // cualquiera de los dos casos este candado dejó de proteger lo que dice proteger.
    const neg = (await db.raw(
      `WITH universo AS (SELECT h.sucursal, h.c1, h.c2, h.c3, h.c4, h.c5, h.c6, h.c12 ${DOCS_VECINALES}),
       malo AS (
         SELECT sum((d.c13)::numeric) AS rev
           FROM universo u JOIN kepler_ods.kdm2 d
             ON btrim(d.sucursal)=btrim(u.sucursal) AND btrim(d.c1)=btrim(u.c1)
            AND d.c2=u.c2 AND d.c3=u.c3 AND (d.c4)::integer=(u.c4)::integer
            AND btrim(d.c6)=btrim(u.c6)),
       bueno AS (SELECT sum(revenue) AS rev FROM analytics.v_kepler_vecinal_monthly WHERE tenant_id = ?)
       SELECT (SELECT rev FROM malo) AS sin_caja, (SELECT rev FROM bueno) AS con_caja`, [T])).rows[0];
    const sinCaja = Number(neg.sin_caja || 0), conCaja = Number(neg.con_caja || 0);
    if (!conCaja) noMedido('el join sin la caja infla', 'la vista no devolvió venta');
    else if (sinCaja <= conCaja) {
      bad++;
      console.log(`  ✘ el join sin la caja YA NO infla (${money(sinCaja)} vs ${money(conCaja)}) — `
        + 'este candado dejó de medir el defecto que lo justifica: revisar antes de confiar en el verde');
    } else {
      t(`el join sin la caja sigue inflando: ${money(sinCaja)} vs ${money(conCaja)} (${(sinCaja / conCaja).toFixed(2)}×)`, true);
    }

    // ── 4. Cobertura: ninguna ruta del ERP se queda fuera ────────────────────────────────────
    const cob = (await db.raw(
      `WITH erp AS (
         SELECT DISTINCT btrim(h.sucursal) AS suc, btrim(h.c12) AS route_no ${DOCS_VECINALES}),
       vista AS (
         SELECT DISTINCT warehouse_code AS suc, route_no
           FROM analytics.v_kepler_vecinal_monthly WHERE tenant_id = ?)
       SELECT (SELECT count(*) FROM erp)::int AS en_erp,
              (SELECT count(*) FROM vista)::int AS en_vista,
              COALESCE((SELECT string_agg(e.suc||'/'||e.route_no, ', ')
                 FROM erp e LEFT JOIN vista v ON v.suc=e.suc AND v.route_no=e.route_no
                WHERE v.route_no IS NULL), '') AS faltantes`, [T])).rows[0];
    if (!Number(cob.en_erp)) noMedido('cobertura de rutas', 'el ODS no devolvió rutas vecinales');
    else t(`las ${cob.en_erp} rutas vecinales del ERP están publicadas`,
      cob.faltantes === '', `faltan: ${cob.faltantes}`);

    // ── 5. La premisa de la exclusión de U-D-12, con su placebo ──────────────────────────────
    // La exclusión no es doctrina: es una medición. Si el espejo se despinta, esto avisa.
    const esp = (await db.raw(
      `WITH l AS (
         SELECT (h.c4)::integer AS dt, btrim(h.c12) AS ruta, (h.c9)::date AS dia,
                btrim(COALESCE(h.c10,'')) AS cli, btrim(d.c8) AS sku, sum((d.c9)::numeric) AS qty
           FROM kepler_ods.kdm1 h
           JOIN kepler_ods.kdm2 d
             ON btrim(d.sucursal)=btrim(h.sucursal) AND btrim(d.c1)=btrim(h.c1)
            AND d.c2=h.c2 AND d.c3=h.c3 AND (d.c4)::integer=(h.c4)::integer
            AND (d.c5)::integer=(h.c5)::integer AND btrim(d.c6)=btrim(h.c6)
          WHERE h.c2='U' AND h.c3='D' AND (h.c4)::integer IN (10,12)
            AND btrim(COALESCE(h.c12,'')) ~ '${VECINAL_RX}'
            AND btrim(COALESCE(h.c1,'')) = btrim(h.sucursal)
            AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
            AND (h.c9)::date >= (((now() AT TIME ZONE 'America/Mexico_City'))::date - 30)
            AND btrim(COALESCE(d.c8,'')) <> ''
          GROUP BY 1,2,3,4,5)
       SELECT count(*) FILTER (WHERE a.dt=12)::int AS ud12,
              count(*) FILTER (WHERE a.dt=12 AND EXISTS (
                SELECT 1 FROM l b WHERE b.dt=10 AND b.ruta=a.ruta AND b.dia=a.dia
                   AND b.cli=a.cli AND b.sku=a.sku AND abs(b.qty-a.qty)<0.001))::int AS espejo,
              count(*) FILTER (WHERE a.dt=12 AND EXISTS (
                SELECT 1 FROM l b WHERE b.dt=10 AND b.ruta<>a.ruta AND b.dia=a.dia
                   AND b.cli=a.cli AND b.sku=a.sku AND abs(b.qty-a.qty)<0.001))::int AS placebo
         FROM l a`)).rows[0];
    const ud12 = Number(esp.ud12 || 0);
    if (ud12 < 50) noMedido('U-D-12 sigue siendo el espejo del ticket', `sólo ${ud12} líneas en 30 días: muestra insuficiente`);
    else {
      const pct = Number(esp.espejo) / ud12;
      const pctPlacebo = Number(esp.placebo) / ud12;
      t(`U-D-12 sigue re-facturando el ticket (${(pct * 100).toFixed(1)}% de ${ud12} líneas)`,
        pct >= 0.90, `bajó a ${(pct * 100).toFixed(1)}%: la exclusión podría estar tapando venta real`);
      t(`el cruce no es ruido: placebo contra otra ruta ${(pctPlacebo * 100).toFixed(1)}%`,
        pctPlacebo <= 0.10, `el placebo subió a ${(pctPlacebo * 100).toFixed(1)}%: el método ya no discrimina`);
    }

    // ── 6. El ticket es (caja, folio) ────────────────────────────────────────────────────────
    const tk = (await db.raw(
      `SELECT count(DISTINCT (caja, folio))::int AS por_caja_folio,
              count(DISTINCT folio)::int AS solo_folio
         FROM analytics.v_kepler_vecinal_sales_lines WHERE tenant_id = ?`, [T])).rows[0];
    if (Number(tk.por_caja_folio) === Number(tk.solo_folio)) {
      noMedido('el ticket se cuenta por (caja, folio)',
        'hoy ningún folio se repite entre cajas: contar mal daría el mismo número');
    } else {
      t(`contar por (caja, folio) cambia el resultado: ${tk.por_caja_folio} vs ${tk.solo_folio} por folio solo`, true);
    }

    // ── 6-bis. LA VERDAD COMPARTIDA: las dos superficies tienen que decir lo mismo ───────────
    //
    // El sell-out y la venta por ruta miden el MISMO hecho del MISMO ERP. Mientras cada uno lo
    // derive por su cuenta pueden contradecirse sin que nadie se entere — y de hecho lo hacen.
    //
    // ⚠️ Esta aserción **falla a propósito** hasta que `mv_kepler_sales_daily` lea de
    // `analytics.v_kepler_sales_lines`. No es un rojo decorativo: es la deuda con su monto a la
    // vista, que es la única forma de que no se vuelva paisaje. Migrarla baja la venta publicada
    // del sell-out y exige recrear una matview de 878k filas con 5 dependientes → va en ventana.
    const dos = (await db.raw(
      `WITH mes AS (
         SELECT date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City'))::date - interval '1 month' AS ini
       ),
       ruta AS (
         SELECT COALESCE(sum(importe),0)::numeric AS v
           FROM analytics.v_kepler_sales_lines, mes
          WHERE tenant_id = ? AND canal = 'vecinal' AND doc_tipo = 10
            AND business_date >= mes.ini AND business_date < mes.ini + interval '1 month'),
       sellout AS (
         SELECT COALESCE(sum(s.monto),0)::numeric AS v
           FROM analytics.mv_kepler_sales_daily s, mes
          WHERE s.vendor_code ~ ':[0-9]V[0-9]'
            AND s.business_date >= mes.ini AND s.business_date < mes.ini + interval '1 month')
       SELECT (SELECT v FROM ruta) AS ruta, (SELECT v FROM sellout) AS sellout,
              (SELECT to_char(ini,'YYYY-MM') FROM mes) AS periodo`, [T])).rows[0];
    const rutaV = Number(dos.ruta), soV = Number(dos.sellout);
    if (!rutaV || !soV) noMedido('el sell-out y la venta por ruta coinciden', `sin datos comparables en ${dos.periodo}`);
    else {
      const dif = Math.abs(soV - rutaV) / rutaV;
      t(`el sell-out y la venta por ruta dicen lo mismo de la vecinal en ${dos.periodo}`,
        dif < 0.01,
        `sell-out ${money(soV)} vs ruta ${money(rutaV)} — ${money(soV - rutaV)} de diferencia `
        + `(${(dif * 100).toFixed(1)}%). Falta migrar mv_kepler_sales_daily a v_kepler_sales_lines`);
    }

    // ── 7. La pantalla tiene que abrir ──────────────────────────────────────────────────────
    const t0 = Date.now();
    await db.raw(`SELECT route_code, month, revenue, units, tickets
                    FROM analytics.v_kepler_vecinal_monthly
                   WHERE tenant_id = ? AND month >= date_trunc('year', now())::date`, [T]);
    const ms = Date.now() - t0;
    t(`la matriz anual responde en ${ms} ms (gate ${GATE_MS} ms)`, ms <= GATE_MS,
      `${ms} ms: por encima del gate, la pantalla se siente lenta`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
