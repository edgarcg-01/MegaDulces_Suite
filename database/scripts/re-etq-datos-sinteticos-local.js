/* eslint-disable no-console */
/**
 * `[RE.ETQ]` Datos SINTÉTICOS para ver `/almacen/etiquetas` en la base LOCAL (`127.0.0.1:5442`), reversibles.
 *
 *   node database/scripts/re-etq-datos-sinteticos-local.js            ← siembra
 *   node database/scripts/re-etq-datos-sinteticos-local.js --borrar   ← quita lo sembrado y la bitácora de esas órdenes
 *
 * La base local tiene `kepler_ods.kdm2` VACÍA: sin sembrar, la cola no muestra nada. Siembra en Suc 08 tres órdenes
 * de entrada (folios `ETQ…`, que no existen en Kepler) modeladas sobre lo medido en prod:
 *  · ETQ0474 — el espécimen de la foto: 70106 LA ROSA BOTA GRANDE 418GR, 20 cajas × 18, vale de ayer.
 *  · ETQ0480 — dos cajetas que Kepler imprimía con el MISMO nombre cortado a 24, y un renglón en PZA (sin etiqueta).
 *  · ETQ0485 — media caja (Kepler no le imprimía etiqueta) y un producto con el catálogo mal (sin código de caja y
 *    factor 0), para ver los avisos y la pestaña Catálogo de Kepler.
 *
 * Candados: sólo corre contra 127.0.0.1:5442; se niega si alguna clave ya existe (así borrar sólo quita lo suyo).
 * Nunca contra prod.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const { Client } = require(require.resolve('pg', { paths: [REPO] }));

const URL = process.env.RE_ETQ_LOCAL_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform';
const SUC = '08';
const SKUS = ['70106', '61010', '61011', '40045', '52210'];
const FOLIOS = ['ETQ0474', 'ETQ0480', 'ETQ0485', 'ETV0487', 'ETV0490'];

(async () => {
  if (!/@127\.0\.0\.1:5442\//.test(URL)) throw new Error('Sólo contra la base local 127.0.0.1:5442.');
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    const borrar = process.argv.includes('--borrar');
    await c.query('BEGIN');
    if (borrar) {
      const b = await c.query(`DELETE FROM commercial.box_label_prints WHERE sucursal = $1 AND folio = ANY($2)`, [SUC, FOLIOS]);
      const m2 = await c.query(`DELETE FROM kepler_ods.kdm2 WHERE sucursal = $1 AND c6 = ANY($2)`, [SUC, FOLIOS]);
      const m1 = await c.query(`DELETE FROM kepler_ods.kdm1 WHERE sucursal = $1 AND c6 = ANY($2)`, [SUC, FOLIOS]);
      const ii = await c.query(`DELETE FROM kepler_ods.kdii WHERE sucursal = $1 AND c1 = ANY($2)`, [SUC, SKUS]);
      const ms = await c.query(`DELETE FROM kepler_ods.kdms WHERE sucursal = $1 AND c2 = 'Sucursal Morelia Abastos'`, [SUC]);
      await c.query('COMMIT');
      console.log(`✓ borrado: bitácora ${b.rowCount} · kdm2 ${m2.rowCount} · kdm1 ${m1.rowCount} · kdii ${ii.rowCount} · kdms ${ms.rowCount}`);
      return;
    }
    const ya = await c.query(
      `SELECT (SELECT count(*) FROM kepler_ods.kdii WHERE sucursal = $1 AND c1 = ANY($2))::int AS kdii,
              (SELECT count(*) FROM kepler_ods.kdm1 WHERE sucursal = $1 AND c6 = ANY($3))::int AS kdm1,
              (SELECT count(*) FROM kepler_ods.kdms WHERE sucursal = $1)::int AS kdms`,
      [SUC, SKUS, FOLIOS],
    );
    const r = ya.rows[0];
    if (r.kdii || r.kdm1 || r.kdms) throw new Error(`Ya hay datos (kdii ${r.kdii}, kdm1 ${r.kdm1}, kdms ${r.kdms}): corre --borrar primero.`);

    const hoy = new Date();
    const ayer = new Date(hoy.getTime() - 86_400_000);
    await c.query(`INSERT INTO kepler_ods.kdms (sucursal, c1, c2) VALUES ($1, $1, 'Sucursal Morelia Abastos')`, [SUC]);
    const kdii = [
      ['70106', 'LA ROSA BOTA GRANDE 418GR', 'PZA', 'CJA', 18, 'C70106'],
      ['61010', 'CAJETA ENVINADA TOPPER 1KG', 'PZA', 'CJA', 12, 'C61010'],
      ['61011', 'CAJETA ENVINADA TOPPER 1/2 KG', 'PZA', 'CJA', 24, 'C61011'],
      ['40045', 'PALETA PAYASO CHICA 100 PZ', 'PAQ', 'CJA', 100, 'C40045'],
      ['52210', 'GOMITA ENCHILADA SURTIDA 1KG', 'PZA', '', 0, ''],
    ];
    for (const [c1, c2, c11, c83, c84, c85] of kdii) {
      await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c11, c83, c84, c85) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [SUC, c1, c2, c11, c83, c84, c85]);
    }
    const doc = (c4, c6, fecha, hora, extra = {}) =>
      c.query(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c68, c69, c43, c37, c39) VALUES ($1,$1,'X','A',$2,1,$3,$4,$4,$5,'F',$6,$7)`,
        [SUC, c4, c6, fecha, hora, extra.c37 ?? null, extra.c39 ?? null],
      );
    await doc(37, 'ETV0487', ayer, '17:40');
    await doc(37, 'ETV0490', hoy, '09:05');
    await doc(40, 'ETQ0474', hoy, '09:31', { c37: 37, c39: 'ETV0487' });
    await doc(40, 'ETQ0480', hoy, '10:12', { c37: 37, c39: 'ETV0490' });
    await doc(40, 'ETQ0485', hoy, '11:47', { c37: 37, c39: 'ETV0490' });
    const ren = (c6, c7, c8, c10, c9, c11, c55, c56, c58) =>
      c.query(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c55, c56, c58, c32) VALUES ($1,$1,'X','A',40,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [SUC, c6, c7, c8, c9, c10, c11, c55, String(c56), String(c58), hoy],
      );
    await ren('ETQ0474', 1, '70106', 'LA ROSA BOTA GRANDE 418', 360, 'PZA', 'CJA', 20, 18);
    await ren('ETQ0480', 1, '61010', 'CAJETA ENVINADA TOPPER 1', 72, 'PZA', 'CJA', 6, 12);
    await ren('ETQ0480', 2, '61011', 'CAJETA ENVINADA TOPPER 1', 96, 'PZA', 'CJA', 4, 24);
    await ren('ETQ0480', 3, '70106', 'LA ROSA BOTA GRANDE 418', 6, 'PZA', 'PZA', 6, 1);
    await ren('ETQ0485', 1, '40045', 'PALETA PAYASO CHICA 100', 50, 'PAQ', 'CJA', 0.5, 100);
    await ren('ETQ0485', 2, '52210', 'GOMITA ENCHILADA SURTID', 30, 'PZA', 'CJA', 3, 10);
    await c.query('COMMIT');
    const v = await c.query(`SELECT folio, count(*)::int AS renglones, sum(cajas_completas)::int AS cajas FROM analytics.v_box_label_lines WHERE sucursal = $1 AND folio LIKE 'ETQ%' GROUP BY 1 ORDER BY 1`, [SUC]);
    console.log('✓ sembrado en Suc 08. Lo que ve la vista:');
    console.table(v.rows);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
