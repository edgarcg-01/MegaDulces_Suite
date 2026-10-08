/* eslint-disable no-console */
/**
 * [WH.6] CANDADO: ninguna sucursal de Wincaja se cae de `analytics.sales_daily` en silencio.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `services/feeds-ingest/sales-daily-projection.js` decide qué venta de Wincaja entra al fact con
 * un `WHERE` de esta forma:
 *
 *     WHERE ( s.wincaja_only = true
 *             OR (s.source_branch = '10' AND s.business_date < ...)
 *             OR (s.source_branch = '42' AND s.business_date < ...) ... )
 *
 * O sea: una sucursal entra **sólo** si sigue siendo ciega a Kepler, **o** si alguien le escribió
 * su cláusula a mano. Cuando una plaza migra su POS a Kepler, el script de identidad le pone
 * `kepler_code` y `wincaja_only` pasa a FALSE — y si nadie agrega la cláusula, **toda su historia
 * desaparece del fact sin un solo error**. La pantalla no se rompe: muestra menos.
 *
 * Ya cobró. El comentario de Canindo en la proyección lo dice textual —*"Sin el remap + esta
 * cláusula, su historia se caía"*— y aun así, cuando Morelia Madero (32→'07') y Morelia Abastos
 * (30→'08') migraron en septiembre-2026, nadie las agregó. Medido el 2026-10-07, antes del
 * arreglo: **1,583,925 filas y 7,437 SKUs** fuera del fact, y en `/compras/pedido` el globo de 12
 * meses de Morelia con **2 meses y CERO SKUs** con año anterior, contra los 22 meses de las demás.
 *
 * ── QUÉ COMPRUEBA, Y QUÉ **NO** ──────────────────────────────────────────────────────────
 * ⛔ **No lee el fuente de la proyección con un regex.** Un `grep` de `source_branch = '30'` se
 * pone verde con la cláusula escrita en un comentario o dentro de una rama muerta. Este archivo
 * **ejecuta** la proyección y mide el dato que produce, que es lo único que llega a la pantalla.
 *
 * ⛔ **Tampoco corre la proyección entera.** Agregar las ~3.2 M filas del silver con sus JOINs
 * pasa de 10 minutos por sucursal y volvería inviable el candado (se probó: no termina). Se sondea
 * la **ventana de 10 días pegada al corte**, que es donde el predicado decide — acotada por rama y
 * por día, un modo de primera clase del builder (el que usa la re-derivación scoped), no un atajo.
 *
 * Las cuatro preguntas:
 *  1. Si el silver tiene venta en los 10 días ANTES del corte, ¿la proyección la publica?
 *     — el invariante que faltaba, el que habría atrapado a Morelia.
 *  2. ¿Publica CERO en los 10 días DESDE el corte? — el techo, y la **prueba negativa** que viene
 *     de regalo: sin ella, agregar una cláusula con la fecha mal cuenta el mismo día dos veces
 *     (Wincaja + Kepler) y nadie lo ve.
 *  3. ¿El fact ya tiene esas filas? — se **declara** NO MEDIDO, no se falla: que el feed no haya
 *     corrido es estado de operación, no un defecto del código.
 *  4. ¿Los cortes coinciden con `analytics.v_branch_erp_cutover`? — se **declara**: donde el
 *     resolvedor dice `-infinity` está diciendo *"nadie lo decidió todavía"*, y tratar un marcador
 *     de pendiente como decisión firmada borraría historia que hoy sirve.
 */
'use strict';
const { Client } = require('pg');
const { buildSalesDailySrc } = require('../../services/feeds-ingest/sales-daily-projection');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const VENTANA = 10; // días a cada lado del corte que se sondean

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };
const n = (v) => Number(v || 0).toLocaleString();
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const correr = (d0, k) => { const a = []; const b = new Date(d0); for (let i = 0; i < k; i++) { a.push(dia(b)); b.setUTCDate(b.getUTCDate() + 1); } return a; };

(async () => {
  const db = new Client({ connectionString: URL, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(URL) ? false : { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`SET statement_timeout = '300s'`);

  // ── El universo: sucursales NO-ruta que YA migraron a Kepler. `wincaja_only` de la vista se
  // deriva justamente de esto (`kepler_code IS NULL`), así que el día que una plaza recibe su
  // `kepler_code` deja de entrar por el `wincaja_only = true` del WHERE y pasa a depender,
  // enteramente, de que alguien le haya escrito su cláusula. Ése es el universo en riesgo.
  const { rows: ramas } = await db.query(`
    SELECT b.source_branch, b.warehouse_code, b.kepler_code, b.kepler_cutover_date AS corte
      FROM wincaja.branches b
     WHERE b.tenant_id = $1 AND COALESCE(b.is_route, false) = false AND b.kepler_code IS NOT NULL
     ORDER BY b.source_branch`, [TENANT]);

  console.log(`\n[WH.6] ${ramas.length} sucursales NO-ruta que dependen de una cláusula de corte\n`);
  if (!ramas.length) { noMedido('universo', 'wincaja.branches no devolvió ramas migradas'); await db.end(); process.exit(0); }

  console.log(`— 1/2. el predicado deja pasar lo de antes del corte y frena lo de después (ventana ${VENTANA} d) —`);
  const publicaron = [];
  for (const r of ramas) {
    const etq = `branch ${r.source_branch} → almacén ${r.warehouse_code}`;
    const corteFinito = r.corte && String(r.corte) !== '-infinity' && !Number.isNaN(Date.parse(r.corte));
    if (!corteFinito) {
      const { rows: [sv] } = await db.query(`
        SELECT count(*)::int AS filas, round(sum(importe))::numeric AS importe,
               min(business_date) AS desde, max(business_date) AS hasta
          FROM wincaja.v_sales_daily WHERE tenant_id=$1 AND source_branch=$2`, [TENANT, r.source_branch]);
      noMedido(`${etq} · corte SIN DECIDIR (${r.corte})`,
        `${n(sv.filas)} filas y $${n(sv.importe)} entre ${dia(sv.desde)} y ${dia(sv.hasta)} esperando que alguien lo arbitre`);
      continue;
    }

    const corte = new Date(r.corte);
    const antes = correr(new Date(corte.getTime() - VENTANA * 86400000), VENTANA);
    const despues = correr(corte, VENTANA);

    // ¿El silver tiene algo que publicar en la ventana de antes? Si no, no hay nada que probar.
    const { rows: [sv] } = await db.query(`
      SELECT count(*)::int AS filas FROM wincaja.v_sales_daily
       WHERE tenant_id=$1 AND source_branch=$2 AND business_date = ANY($3::date[])`,
    [TENANT, r.source_branch, antes]);
    if (!sv.filas) { noMedido(`${etq}`, `el silver no tiene venta en los ${VENTANA} d previos al corte`); continue; }

    const srcA = buildSalesDailySrc({ tenantId: TENANT, branches: [r.source_branch], days: antes });
    // ⚠️ Se lee de vuelta el `warehouse_id` QUE LA PROYECCIÓN ELIGIÓ, no el de `wincaja.branches`.
    // Para la mitad de las ramas no son el mismo: el CASE de la proyección remapea 'MD-10'→'01',
    // 'MD-42'→'02', 'MD-50'→'06'. Copiar ese mapa acá sería repetir exactamente el pecado que este
    // candado existe para atrapar — y de hecho lo cometí en la primera versión, que reportó "el
    // fact tiene 0 filas" para tres almacenes que sí las tienen.
    const { rows: [pa] } = await db.query(
      `SELECT count(*)::int AS filas, round(sum(revenue))::numeric AS importe,
              (array_agg(DISTINCT warehouse_id))[1] AS wh
         FROM (${srcA}) x`);
    check(`${etq} publica lo de antes del corte (${n(pa.filas)} de ${n(sv.filas)} filas del silver)`,
      pa.filas > 0,
      `la proyección produce CERO con ${n(sv.filas)} filas disponibles: le falta su cláusula en sales-daily-projection.js — su historia NO llega al fact y la pantalla sólo muestra desde el corte`);
    if (pa.filas > 0) publicaron.push({ ...r, wh: pa.wh });

    const srcD = buildSalesDailySrc({ tenantId: TENANT, branches: [r.source_branch], days: despues });
    const { rows: [pd] } = await db.query(`SELECT count(*)::int AS filas FROM (${srcD}) x`);
    check(`${etq} frena en el corte ${dia(r.corte)} (0 filas los ${VENTANA} d siguientes)`,
      pd.filas === 0,
      `publica ${n(pd.filas)} filas DESPUÉS del corte: esos días los cuentan Wincaja y Kepler a la vez = doble conteo`);
  }

  // ── 3. ¿El fact ya la tiene? La proyección puede estar bien y el feed sin correr.
  console.log('\n— 3. el fact refleja lo que la proyección produce —');
  for (const r of publicaron) {
    const { rows: [f] } = await db.query(`
      SELECT count(*)::int AS filas, min(sd.sale_date) AS desde,
             count(DISTINCT sd.product_id)::int AS skus, max(w.code) AS code
        FROM analytics.sales_daily sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
       WHERE sd.tenant_id=$1 AND sd.warehouse_id=$2 AND sd.channel LIKE 'wincaja%'`, [TENANT, r.wh]);
    if (!f.filas) {
      noMedido(`branch ${r.source_branch} en analytics.sales_daily`,
        'la proyección SÍ la publica y el fact tiene 0 filas wincaja — falta correr import-wincaja-analytics.js --apply');
    } else {
      check(`almacén ${f.code} está en el fact (${n(f.filas)} filas · ${n(f.skus)} SKUs desde ${dia(f.desde)})`, true);
    }
  }

  // ── 4. EL DÍA DEL CORTE: que no lo publiquen los dos a la vez.
  // ⛔ La primera versión de este bloque comparaba `wincaja.branches.kepler_cutover_date` contra
  // `v_branch_erp_cutover`… que es una VISTA SOBRE ESA MISMA COLUMNA. Daba ✔ siempre y no podía
  // dar otra cosa: un árbitro que nunca contradice es un espejo. Lo que de verdad hay que medir es
  // si el corte **que la proyección aplica** (una constante en su código, que este archivo no ve)
  // coincide con el que el dato declara — y eso se observa en el único lugar donde deja huella:
  // los días alrededor del corte. Si la constante va adelantada, Wincaja y Kepler publican el
  // MISMO día (doble conteo); si va atrasada, queda un hueco que nadie llena.
  console.log('\n— 4. alrededor del corte: ni doble conteo ni hueco —');
  const { rows: res } = await db.query(
    `SELECT wincaja_source_branch AS b, cutover_date FROM analytics.v_branch_erp_cutover WHERE tenant_id=$1`, [TENANT]);
  check(`el resolvedor conoce a las ${ramas.length} ramas migradas`, res.length >= ramas.length,
    `v_branch_erp_cutover sólo tiene ${res.length}`);
  const resolver = new Map(res.map((x) => [x.b, x.cutover_date]));
  for (const r of publicaron) {
    const rc = resolver.get(r.source_branch);
    if (!rc || String(rc) === '-infinity') continue;
    const span = correr(new Date(new Date(rc).getTime() - VENTANA * 86400000), VENTANA * 2);
    const src = buildSalesDailySrc({ tenantId: TENANT, branches: [r.source_branch], days: span });
    const { rows: dias } = await db.query(`
      WITH win AS (SELECT sale_date, sum(revenue) rev FROM (${src}) x GROUP BY 1),
           kep AS (SELECT sd.sale_date, sum(sd.revenue) rev FROM analytics.sales_daily sd
                    WHERE sd.tenant_id=$1 AND sd.warehouse_id=$2
                      AND sd.channel NOT LIKE 'wincaja%' AND sd.sale_date = ANY($3::date[])
                    GROUP BY 1)
      SELECT COALESCE(win.sale_date, kep.sale_date) AS d,
             round(COALESCE(win.rev,0))::numeric AS w, round(COALESCE(kep.rev,0))::numeric AS k
        FROM win FULL JOIN kep ON kep.sale_date = win.sale_date ORDER BY 1`, [TENANT, r.wh, span]);
    const ambos = dias.filter((x) => Number(x.w) > 0 && Number(x.k) > 0);
    const vacios = span.filter((d) => !dias.some((x) => dia(x.d) === d && (Number(x.w) > 0 || Number(x.k) > 0)));
    check(`branch ${r.source_branch} · ningún día lo publican Wincaja y Kepler a la vez (corte ${dia(rc)})`,
      ambos.length === 0,
      `${ambos.length} día(s) con las dos fuentes: ${ambos.slice(0, 4).map((x) => `${dia(x.d)} W=$${n(x.w)}/K=$${n(x.k)}`).join(' · ')} — la constante de la proyección va adelantada respecto del resolvedor`);
    if (vacios.length > 2) {
      noMedido(`branch ${r.source_branch} · hueco alrededor del corte`,
        `${vacios.length} de ${span.length} días sin venta de ninguna fuente (${vacios.slice(0, 3).join(', ')}…) — puede ser cierre normal o la constante atrasada`);
    }
  }

  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
