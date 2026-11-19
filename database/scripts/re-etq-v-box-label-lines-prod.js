/* eslint-disable no-console */
/**
 * `[RE.ETQ.0.2]` Verifica en PROD, sólo lectura, el cuerpo de `analytics.v_box_label_lines` ANTES de
 * crear la vista: corre EXACTAMENTE el `SELECT_SQL` de la migración contra los datos reales.
 *
 *   node database/scripts/re-etq-v-box-label-lines-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta]
 *   node database/scripts/re-etq-v-box-label-lines-prod.js --negativa   ← prueba negativa: TIENE que salir rojo
 *   (default: 2026-10-06 .. 2026-11-04, la ventana de la métrica de la fase)
 *
 * Qué compara, cada cosa contra un testigo que NO sale de la vista:
 *  1. El espécimen (la etiqueta física de la foto): Suc 08, orden 0000474 → 70106, 20 cajas, UXC 18,
 *     C70106, «Sucursal Morelia Abastos», capturada el 2026-11-05, vale 0000487.
 *  2. Abanico: renglones de la vista = renglones de kdm2 con el mismo filtro, contados sin los LEFT JOIN.
 *  3. Cajas: Σ `cajas` (kdm2.c56) contra Σ c9 / c58 calculado aparte (dos columnas distintas de Kepler).
 *  4. Piezas sueltas: renglones con caja incompleta (Kepler no les imprime etiqueta) y un ejemplo.
 *  5. Tiempo: una sucursal, 7 días (la consulta de la cola).
 *
 * Candados: identidad del clúster por `pg_control_system()` (el nombre de la base no sirve),
 * `BEGIN READ ONLY`, `statement_timeout`, `ROLLBACK` siempre. Lee `PROD_DB_URL` del `.env`.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(REPO, '.env'), quiet: true });
const { Client } = require('pg');
const { SELECT_SQL } = require('../migrations-newdb/20261119100324_re_etq_v_box_label_lines.js');

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
const NEGATIVA = process.argv.includes('--negativa');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const desde = args[0] || '2026-10-06';
const hasta = args[1] || '2026-11-04';

/** Lo que dice la etiqueta física (o lo contrario, en la prueba negativa). */
const ESPECIMEN = {
  sku: '70106',
  cajas_completas: NEGATIVA ? 21 : 20,
  uxc: 18,
  piezas_sueltas: 0,
  codigo: 'C70106',
  nombre: 'LA ROSA BOTA GRANDE 418GR',
  sucursal_nombre: 'Sucursal Morelia Abastos',
  capturada_el: '2026-11-05',
  vale_folio: '0000487',
};

const fallas = [];
const check = (nombre, ok, detalle) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  if (!ok) fallas.push(nombre);
};

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en .env');
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 're-etq-0.2-verifica' });
  await c.connect();
  try {
    const sid = (await c.query(`SELECT system_identifier::text AS s FROM pg_control_system()`)).rows[0].s;
    if (sid !== PROD_CLUSTER_ID) throw new Error(`No es pg-prod (system_identifier ${sid})`);
    await c.query('BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);
    console.log(`pg-prod ${sid} · ventana ${desde} .. ${hasta}${NEGATIVA ? ' · PRUEBA NEGATIVA (debe salir rojo)' : ''}\n`);

    // 1. Espécimen
    const esp = (await c.query(
      `WITH v AS (${SELECT_SQL}) SELECT sku, cajas_completas, uxc::float AS uxc, piezas_sueltas::float AS piezas_sueltas, codigo, nombre,
              sucursal_nombre, to_char(capturada_el,'YYYY-MM-DD') AS capturada_el, vale_folio, to_char(vale_capturado_el,'YYYY-MM-DD') AS vale_el
         FROM v WHERE sucursal = '08' AND folio = '0000474'`,
    )).rows;
    check('espécimen: un solo renglón en la orden 0000474 de Suc 08', esp.length === 1, `${esp.length} renglón(es)`);
    if (esp[0]) {
      for (const [k, esperado] of Object.entries(ESPECIMEN)) {
        check(`espécimen.${k}`, String(esp[0][k]) === String(esperado), `vista=${esp[0][k]} etiqueta=${esperado}`);
      }
      console.log(`    (vale capturado el ${esp[0].vale_el}: la etiqueta de Kepler dice 308 = la orden, no el vale)`);
    }

    // 2. Abanico: la vista no puede tener más renglones que kdm2 con el mismo filtro
    const base = `FROM kepler_ods.kdm1 m JOIN kepler_ods.kdm2 l
        ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3 AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
       WHERE m.c2='X' AND m.c3='A' AND m.c4=40 AND btrim(m.c1)=m.sucursal AND btrim(coalesce(m.c43,''))<>'C'
         AND upper(btrim(l.c55)) IN ('CJA','BTO','CUB') AND m.c68::date BETWEEN $1 AND $2`;
    const t0 = Date.now();
    const [vista] = (await c.query(
      `WITH v AS (${SELECT_SQL}) SELECT count(*)::int AS renglones, sum(cajas)::float AS cajas, sum(cajas_completas)::int AS completas,
              count(*) FILTER (WHERE piezas_sueltas > 0)::int AS incompletas
         FROM v WHERE capturada_el BETWEEN $1 AND $2`, [desde, hasta])).rows;
    const msVentana = Date.now() - t0;
    const [testigo] = (await c.query(
      `SELECT count(*)::int AS renglones, sum(l.c9::numeric / nullif(l.c58::numeric, 0))::float AS cajas ${base}`, [desde, hasta])).rows;
    check('abanico: renglones de la vista = renglones de kdm2', vista.renglones === testigo.renglones,
      `vista=${vista.renglones} kdm2=${testigo.renglones}`);
    check('cajas: Σ c56 (vista) = Σ c9/c58 (aparte)', Math.abs(vista.cajas - testigo.cajas) < 0.01,
      `vista=${vista.cajas} testigo=${testigo.cajas.toFixed(2)}`);
    console.log(`    etiquetas que imprimiría Kepler (cajas completas): ${vista.completas} · renglones con caja incompleta: ${vista.incompletas} · ${msVentana} ms`);

    // 3. Caja incompleta: ejemplo
    const inc = (await c.query(
      `WITH v AS (${SELECT_SQL}) SELECT sucursal, folio, sku, unidad, cajas::float AS cajas, uxc::float AS uxc, piezas_sueltas::float AS sueltas, unidad_base
         FROM v WHERE capturada_el BETWEEN $1 AND $2 AND piezas_sueltas > 0 ORDER BY sucursal, folio LIMIT 3`, [desde, hasta])).rows;
    inc.forEach((r) => console.log(`    incompleta: Suc ${r.sucursal} ${r.folio} ${r.sku} ${r.cajas} ${r.unidad} × ${r.uxc} → ${r.sueltas} ${r.unidad_base} sueltas`));

    // 4. Avisos del catálogo (no fallan: se reportan)
    const [av] = (await c.query(
      `WITH v AS (${SELECT_SQL}) SELECT count(*)::int AS n,
              count(*) FILTER (WHERE kepler_codigo_caja IS NULL)::int AS sin_c85,
              count(*) FILTER (WHERE coalesce(kepler_factor_caja,0) = 0)::int AS factor_0,
              count(*) FILTER (WHERE kepler_unidad_caja IS DISTINCT FROM unidad)::int AS caja_otra,
              count(*) FILTER (WHERE sin_catalogo)::int AS sin_catalogo
         FROM v WHERE capturada_el BETWEEN $1 AND $2`, [desde, hasta])).rows;
    console.log(`    avisos: sin c85 ${av.sin_c85} · factor 0 en kdii ${av.factor_0} · la caja de Kepler es otra unidad ${av.caja_otra} · sin kdii ${av.sin_catalogo} (de ${av.n})`);

    // 5. Tiempo de la cola: una sucursal, 7 días
    const t1 = Date.now();
    const cola = (await c.query(
      `WITH v AS (${SELECT_SQL}) SELECT folio, count(*) AS renglones, sum(cajas_completas) AS etiquetas
         FROM v WHERE sucursal = '08' AND capturada_el >= ($1::date - 7) GROUP BY folio`, [hasta])).rows;
    const msCola = Date.now() - t1;
    check('tiempo de la cola (Suc 08, 7 días) < 500 ms', msCola < 500, `${msCola} ms, ${cola.length} órdenes`);

    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
  console.log(fallas.length ? `\n✗ ${fallas.length} falla(s): ${fallas.join(' · ')}` : '\n✓ todo cuadra');
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
