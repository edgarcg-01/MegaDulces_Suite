/* eslint-disable no-console */
/**
 * [AUD-DAT.17] → [VEC.39] CANDADO de los combos Producto/Cliente de `/comercial/ventas-por-ruta`.
 *
 * ⚠️ ESTE ARCHIVO EXISTE PORQUE SU AUSENCIA FUE UNA MENTIRA PUBLICADA, Y SU PRIMERA VERSIÓN NO
 * ALCANZÓ. La migración `20260929170000_mv_route_filter_options.js` afirmaba un candado que no
 * existía; se escribió. Pero declaraba su frescura «NO MEDIDA» y nadie la cableó: la matvista
 * quedó con la foto del 2026-09-29 hasta el 2026-11-05 (586 de 886 clientes vecinales vendidos
 * desde entonces no aparecían en el combo). Un NO MEDIDO permanente es un verde con otro nombre.
 *
 * ── QUÉ PROTEGE (mig `20261105122624`) ─────────────────────────────────────────────────────
 *  · `mv_route_filter_options_live` — push (camionetas) + vecinal del ODS, ciclo de 30 min.
 *  · `mv_route_filter_options_wincaja` — historia de Wincaja por mes, SIN refresco: su fuente
 *    dejó de vender por ruta el 2026-08-12.
 *
 *  1. Las dos existen; la viva con índice ÚNICO (sin él no hay `REFRESH CONCURRENTLY`).
 *  2. Sirven de catálogo: no vacías, sin códigos en blanco, con rótulo.
 *  3. Su definición == la vista enriquecida `v_route_sales_lines`, en una ventana de 30 días
 *     (los 2 años no entran en el `statement_timeout` de 1 min: la pierna Wincaja cuesta ~15 s
 *     por mes). Si divergen, el combo esconde u ofrece clientes que el filtro no encuentra.
 *  4. FRESCURA de la viva: la refresca el ciclo de 30 min; más de 2 h es ROJO.
 *  5. ÁRBITRO de la congelada: Wincaja NO puede tener venta de ruta posterior a la última que la
 *     matvista guardó. Debe encontrar 0; si encuentra, la historia quedó corta y hay que
 *     refrescarla (o devolverla al ciclo).
 *
 *   DATABASE_URL_NEW=<destino> node database/tests/test-newdb-route-filter-options.js
 */
const { Client } = require('pg');
const { _sql } = require('../migrations-newdb/20261105122624_combos_ruta_wincaja_congelado_y_vivo.js');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

const LIVE = 'mv_route_filter_options_live';
const WCJ = 'mv_route_filter_options_wincaja';
const VENTANA_MIG = `(CURRENT_DATE - INTERVAL '2 years')`;

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };
const money = (n) => Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Los cuerpos de la migración con otra ventana. Si la cadena no está, el candado mediría otra cosa. */
const conVentana = (sql, desde) => {
  if (!sql.includes(VENTANA_MIG)) throw new Error('la migración ya no usa la ventana esperada: el candado no sabe acotarla');
  return sql.split(VENTANA_MIG).join(desde);
};

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    const t = (await db.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces' LIMIT 1`)).rows[0];
    if (!t) { console.log('sin tenant mega_dulces: nada que medir'); process.exitCode = 0; return; }
    const T = t.id;
    // Sin esto `wincaja.v_sales_lines` devuelve 0 filas y el candado se pondría verde midiendo el vacío.
    await db.query('SELECT set_config($1,$2,false)', ['app.tenant_id', T]);
    await db.query(`SET statement_timeout = '1min'`);

    // ── 1. Forma ────────────────────────────────────────────────────────────────────────────
    console.log('\n[1] Las dos matvistas existen');
    const existen = (await db.query(
      `SELECT matviewname FROM pg_matviews WHERE schemaname='analytics' AND matviewname = ANY($1)`,
      [[LIVE, WCJ]])).rows.map((r) => r.matviewname);
    for (const mv of [LIVE, WCJ]) {
      if (existen.includes(mv)) pass(`analytics.${mv} existe.`);
      else bad(`analytics.${mv} no existe: el combo cae a la consulta en vivo (minutos).`);
    }
    if (existen.includes(LIVE)) {
      const uq = (await db.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname='analytics' AND tablename=$1 AND indexdef ILIKE '%UNIQUE%'`, [LIVE])).rows;
      if (uq.length) pass(`índice único en la viva (${uq[0].indexname}): REFRESH CONCURRENTLY es posible.`);
      else bad('la viva no tiene índice único: el REFRESH bloquearía a los lectores.');
    }

    // ── 2. Catálogo usable ──────────────────────────────────────────────────────────────────
    console.log('\n[2] El catálogo es usable (no vacío, sin códigos en blanco, con rótulo)');
    for (const mv of [LIVE, WCJ].filter((m) => existen.includes(m))) {
      const r = (await db.query(
        `SELECT count(*) FILTER (WHERE kind='cliente')::int AS clientes,
                count(*) FILTER (WHERE kind='sku')::int     AS skus,
                count(*) FILTER (WHERE value IS NULL OR btrim(value) = '')::int AS vacios,
                count(*) FILTER (WHERE label IS NULL OR btrim(label) = '')::int AS sin_rotulo,
                count(*) FILTER (WHERE kind='cliente' AND label = value)::int  AS cli_sin_nombre
           FROM analytics.${mv} WHERE tenant_id = $1`, [T])).rows[0];
      console.log(`     ${mv}: ${r.clientes} filas cliente · ${r.skus} filas sku`);
      if (!r.clientes && !r.skus) bad(`${mv} está VACÍA para mega_dulces.`);
      else if (r.vacios || r.sin_rotulo) bad(`${mv}: ${r.vacios} código(s) vacío(s) y ${r.sin_rotulo} sin rótulo.`);
      else {
        pass(`${mv}: todas las opciones con código y rótulo.`);
        // Las camionetas 501–505 no tienen nombre en NINGUNA fuente ([VEC.38]): se declara, no se juzga.
        console.log(`     ${r.cli_sin_nombre} cliente(s) sin nombre en la fuente: su rótulo ES el código.`);
      }
    }

    // ── 3. Definición == vista enriquecida (30 días) ────────────────────────────────────────
    console.log('\n[3] La definición de las matvistas da el mismo universo que v_route_sales_lines');
    const D = `(CURRENT_DATE - INTERVAL '30 days')`;
    // ⚠️ La MISMA foto para los dos lados: la vecinal del ODS entra en vivo, y dos lecturas a 5 s
    // de distancia difirieron $98.85 en horario hábil (medido). Sin esto el candado da rojo falso.
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const nuevo = (await db.query(
      `WITH o AS (
         SELECT tenant_id, kind, value, rev FROM (${conVentana(_sql.SQL_LIVE, D)}) a
         UNION ALL
         SELECT tenant_id, kind, value, rev FROM (${conVentana(_sql.SQL_WCJ, D)}) b)
       SELECT count(DISTINCT value) FILTER (WHERE kind='cliente')::int AS clientes,
              count(DISTINCT value) FILTER (WHERE kind='sku')::int AS skus,
              round(sum(rev) FILTER (WHERE kind='cliente'),2) AS rev_cli
         FROM o WHERE tenant_id = $1`, [T])).rows[0];
    const enr = (await db.query(
      `SELECT count(DISTINCT cliente) FILTER (
                WHERE cliente IS NOT NULL AND btrim(cliente) <> '' AND cliente <> '0001')::int AS clientes,
              count(DISTINCT sku) FILTER (WHERE sku IS NOT NULL)::int AS skus,
              round(sum(importe) FILTER (
                WHERE cliente IS NOT NULL AND btrim(cliente) <> '' AND cliente <> '0001'),2) AS rev_cli
         FROM analytics.v_route_sales_lines
        WHERE tenant_id = $1 AND business_date >= ${D}`, [T])).rows[0];
    await db.query('COMMIT');
    if (!nuevo.clientes && !enr.clientes) {
      skip('no hay venta de ruta en los últimos 30 días: nada con qué comparar.');
    } else if (nuevo.clientes === enr.clientes && nuevo.skus === enr.skus
      && Math.abs(Number(nuevo.rev_cli || 0) - Number(enr.rev_cli || 0)) < 0.01) {
      pass(`30 días: ${nuevo.clientes} clientes · ${nuevo.skus} skus · $${money(nuevo.rev_cli)} — iguales.`);
    } else {
      bad(`DIVERGEN en 30 días: matvistas ${nuevo.clientes}/${nuevo.skus}/$${money(nuevo.rev_cli)} vs `
        + `enriquecida ${enr.clientes}/${enr.skus}/$${money(enr.rev_cli)}.`);
    }

    // ── 4. Frescura de la viva ──────────────────────────────────────────────────────────────
    console.log('\n[4] Frescura de la viva (ciclo de 30 min)');
    if (!existen.includes(LIVE)) skip('sin la viva no hay frescura que medir.');
    else {
      const f = (await db.query(
        `SELECT to_char(max(computed_at),'YYYY-MM-DD HH24:MI') AS al,
                round(extract(epoch FROM (now() - max(computed_at))) / 60)::int AS min
           FROM analytics.${LIVE} WHERE tenant_id = $1`, [T])).rows[0];
      console.log(`     calculada el ${f.al} (hace ${f.min} min)`);
      if (f.min === null) bad('sin computed_at: no se puede saber la edad.');
      else if (f.min <= 120) pass(`edad ${f.min} min ≤ 120.`);
      else bad(`edad ${f.min} min: el ciclo de 30 min no la está refrescando.`);
    }

    // ── 5. Árbitro de la congelada ──────────────────────────────────────────────────────────
    console.log('\n[5] Wincaja no vendió por ruta después de lo que la historia congelada guarda');
    if (!existen.includes(WCJ)) skip('sin la congelada no hay árbitro.');
    else {
      const a = (await db.query(
        `SELECT (SELECT to_char(max(last_date),'YYYY-MM-DD') FROM analytics.${WCJ}
                  WHERE tenant_id = $1 AND last_date <= CURRENT_DATE) AS guardado,
                (SELECT to_char(max(business_date) FILTER (
                          WHERE venta_origen = 'derivado_tasa_linea' AND venta > 0),'YYYY-MM-DD')
                   FROM analytics.mv_rd_route_daily_200d
                  WHERE tenant_id = $1 AND business_date <= CURRENT_DATE) AS wincaja_ultimo`, [T])).rows[0];
      console.log(`     guardado hasta ${a.guardado ?? '—'} · Wincaja vendió por ruta hasta ${a.wincaja_ultimo ?? '(nada en 200 d)'}`);
      if (!a.guardado) bad('la congelada no tiene fechas: nació vacía.');
      else if (!a.wincaja_ultimo || a.wincaja_ultimo <= a.guardado) pass('0 días de Wincaja fuera de la historia congelada.');
      else bad(`Wincaja volvió a vender por ruta (${a.wincaja_ultimo}) después de ${a.guardado}: `
        + 'la historia congelada quedó corta — refrescarla o devolverla al ciclo.');
    }

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
