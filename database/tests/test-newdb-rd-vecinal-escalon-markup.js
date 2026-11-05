/* eslint-disable no-console */
/**
 * `[RD.103.2]` El escalón por markup, el piso del chofer y el costo vecinal
 * (`20261104124524`).
 *
 * Afirma, en una transacción que se revierte:
 *   1. Existen `commission_scales.piso_chofer_venta`, `commission_run_lines.scale_id` y
 *      `v_rd_commission_sales.costo_vecinal` / `costo_vecinal_status`.
 *   2. NEGATIVAS: `gate_field` inventado y piso negativo dan 23514. CONTROLES: `markup` y un piso
 *      de 129,999.99 entran.
 *   3. ⭐ La razón de `escalaVigente()` con familia: con una versión VECINAL más nueva en la
 *      tabla, la consulta vieja (sin familia, la de la API anterior) devuelve la vecinal —
 *      Ruta Directa se pagaría con ella—; la de familia devuelve la de Ruta Directa.
 *   4. La vista: las filas `kepler_vecinal` declaran su costo (`estandar_kepler_*`) y las de
 *      push siguen sin costo. Sin filas en el destino: NO MEDIDO.
 *
 * Sin la migración en el destino: NO MEDIDO, no verde.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-vecinal-escalon-markup.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/** Corre `sql` en un SAVEPOINT y devuelve el código de error (o null si entró). */
async function codigo(db, sql, params = []) {
  await db.query('SAVEPOINT p');
  try { await db.query(sql, params); await db.query('RELEASE SAVEPOINT p'); return null; }
  catch (e) { await db.query('ROLLBACK TO SAVEPOINT p'); return e.code; }
}

(async () => {
  const db = new Client({ connectionString: URL, statement_timeout: 120000 });
  await db.connect();
  console.log(`\n=== [RD.103.2] escalón por markup y costo vecinal · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  const { rows: cols } = await db.query(`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE (table_schema, table_name, column_name) IN (
       ('commercial', 'commission_scales', 'piso_chofer_venta'),
       ('commercial', 'commission_scales', 'familia'),
       ('commercial', 'commission_run_lines', 'scale_id'),
       ('analytics', 'v_rd_commission_sales', 'costo_vecinal'),
       ('analytics', 'v_rd_commission_sales', 'costo_vecinal_status'))`);
  if (cols.length < 5) {
    noMedido('el escalón por markup', `el destino no tiene 20261104103945 + 20261104124524 (${cols.map((c) => c.c).join(', ') || 'nada'})`);
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`); await db.end(); process.exit(0);
  }
  console.log('\n— 1. columnas');
  check('las cinco columnas existen', cols.length === 5, cols.map((c) => c.c).join(', '));

  await db.query('BEGIN');
  try {
    const { rows: [ten] } = await db.query(`SELECT id FROM identity.tenants ORDER BY created_at LIMIT 1`);
    if (!ten) { noMedido('las escrituras', 'el destino no tiene ningún tenant'); throw new Error('_salir'); }
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [ten.id]);
    const ins = `INSERT INTO commercial.commission_scales
        (tenant_id, code, nombre, valid_from, base_field, gate_field, share_supervisor_pct, familia, piso_chofer_venta)
      VALUES ($1, 'ZZ-PRUEBA-' || $2, 'prueba', $3::date, 'subtotal', $4, 20, $5, $6)
      RETURNING id`;

    console.log('\n— 2. negativas y controles');
    const gateMalo = await codigo(db, ins, [ten.id, 'gate', '2099-01-01', 'litros', 'vecinal', null]);
    check(`gate_field inventado RECHAZADO con 23514 (dio ${gateMalo})`, gateMalo === '23514');
    const pisoMalo = await codigo(db, ins, [ten.id, 'piso', '2099-01-02', 'markup', 'vecinal', -1]);
    check(`piso negativo RECHAZADO con 23514 (dio ${pisoMalo})`, pisoMalo === '23514');
    const control = await codigo(db, ins, [ten.id, 'vec', '2099-01-03', 'markup', 'vecinal', 129999.99]);
    check(`control: markup con piso 129,999.99 ENTRA (dio ${control ?? 'ok'})`, control === null);

    console.log('\n— 3. la escala vigente se elige POR FAMILIA');
    const { rows: [rd] } = await db.query(`SELECT count(*)::int n FROM commercial.commission_scales
       WHERE familia = 'ruta_directa' AND deleted_at IS NULL AND valid_from <= DATE '2099-06-01'
         AND (valid_to IS NULL OR valid_to > DATE '2099-06-01')`);
    if (!rd.n) {
      noMedido('la elección por familia', 'el destino no tiene una versión de Ruta Directa abierta');
    } else {
      const vieja = await db.query(`SELECT familia FROM commercial.commission_scales
         WHERE deleted_at IS NULL AND valid_from <= DATE '2099-06-01'
           AND (valid_to IS NULL OR valid_to > DATE '2099-06-01')
         ORDER BY valid_from DESC LIMIT 1`);
      check(`negativa: la consulta SIN familia devuelve la vecinal (dio ${vieja.rows[0]?.familia})`,
        vieja.rows[0]?.familia === 'vecinal');
      const nueva = await db.query(`SELECT familia FROM commercial.commission_scales
         WHERE deleted_at IS NULL AND familia = 'ruta_directa' AND valid_from <= DATE '2099-06-01'
           AND (valid_to IS NULL OR valid_to > DATE '2099-06-01')
         ORDER BY valid_from DESC LIMIT 1`);
      check(`con familia devuelve la de Ruta Directa (dio ${nueva.rows[0]?.familia})`,
        nueva.rows[0]?.familia === 'ruta_directa');
    }
  } catch (e) {
    if (e.message !== '_salir') throw e;
  } finally {
    await db.query('ROLLBACK');
  }

  console.log('\n— 4. la vista declara el costo vecinal');
  const { rows: [v] } = await db.query(`
    SELECT count(*) FILTER (WHERE source = 'kepler_vecinal')::int vecinal,
           count(*) FILTER (WHERE source = 'kepler_vecinal'
                             AND costo_status NOT IN ('estandar_kepler_hoy', 'estandar_kepler_incompleto'))::int vecinal_mal,
           count(*) FILTER (WHERE source = 'push')::int push,
           count(*) FILTER (WHERE source = 'push' AND costo IS NOT NULL)::int push_con_costo
      FROM analytics.v_rd_route_daily
     WHERE business_date >= CURRENT_DATE - 30`);
  if (!v.vecinal) noMedido('el costo vecinal', 'el destino no tiene venta vecinal en 30 días');
  else check(`las ${v.vecinal} filas vecinales declaran estandar_kepler_* (${v.vecinal_mal} no)`, v.vecinal_mal === 0);
  if (!v.push) noMedido('el push sin costo', 'el destino no tiene push en 30 días');
  else check(`push sigue sin costo (${v.push_con_costo} de ${v.push} con costo)`, v.push_con_costo === 0);

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
