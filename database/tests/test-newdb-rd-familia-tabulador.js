/* eslint-disable no-console */
/**
 * `[RD.103.1]` La FAMILIA del tabulador (`20261104103945`): `commission_scales.familia` y
 * `commission_route_config.familia`.
 *
 * Afirma, en una transacción que se revierte:
 *   1. Las dos columnas existen, NOT NULL, con DEFAULT 'ruta_directa'.
 *   2. Lo que ya existía quedó en 'ruta_directa' (ningún número cambia).
 *   3. NEGATIVA: una familia inventada da 23514; CONTROL: 'vecinal' entra.
 *   4. Un INSERT que NO manda la columna —como lo hacen hoy createScaleVersion() y el alta del
 *      padrón— sigue entrando y queda 'ruta_directa' (compatible con la API desplegada).
 *
 * Sin la migración en el destino: NO MEDIDO, no verde.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-familia-tabulador.js
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
  console.log(`\n=== [RD.103.1] familia del tabulador · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);
  const TABLAS = ['commission_scales', 'commission_route_config'];

  const { rows: cols } = await db.query(`
    SELECT table_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'commercial' AND table_name = ANY($1) AND column_name = 'familia'`, [TABLAS]);
  if (cols.length < 2) {
    noMedido('la familia del tabulador', 'el destino no tiene la migración 20261104103945');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`); await db.end(); process.exit(0);
  }

  console.log('\n— 1. columnas');
  for (const c of cols) {
    check(`${c.table_name}.familia NOT NULL con DEFAULT 'ruta_directa'`,
      c.is_nullable === 'NO' && /'ruta_directa'/.test(c.column_default ?? ''), JSON.stringify(c));
  }

  console.log('\n— 2. lo que ya era de Ruta Directa siguió siéndolo');
  const { rows: [rd] } = await db.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE familia <> 'ruta_directa')::int otras
      FROM commercial.commission_scales WHERE code LIKE 'RD%'`);
  if (!rd.n) noMedido('las versiones RD', 'el destino no tiene ninguna escala RD');
  else check(`las ${rd.n} versión(es) RD quedaron en 'ruta_directa'`, rd.otras === 0, `${rd.otras} cambiaron`);

  await db.query('BEGIN');
  try {
    const { rows: [ten] } = await db.query(`SELECT id FROM identity.tenants ORDER BY created_at LIMIT 1`);
    if (!ten) { noMedido('las escrituras', 'el destino no tiene ningún tenant'); throw new Error('_salir'); }
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [ten.id]);
    const ins = (familia) => `INSERT INTO commercial.commission_scales
            (tenant_id, code, nombre, valid_from, base_field, gate_field, share_supervisor_pct${familia ? ', familia' : ''})
          VALUES ($1, 'ZZ-PRUEBA-' || $2, 'prueba', DATE '2099-01-01' + $3::int, 'subtotal', 'venta', 0${familia ? ', $4' : ''})`;

    console.log('\n— 3. negativa y control');
    const mala = await codigo(db, ins(true), [ten.id, 'mala', 1, 'camion_rosa']);
    check(`familia inventada RECHAZADA con 23514 (dio ${mala})`, mala === '23514');
    const buena = await codigo(db, ins(true), [ten.id, 'vec', 2, 'vecinal']);
    check(`control: 'vecinal' ENTRA (dio ${buena ?? 'ok'})`, buena === null);

    console.log('\n— 4. un INSERT sin la columna, como el de la API desplegada');
    const sin = await codigo(db, ins(false), [ten.id, 'sin', 3]);
    const { rows: [y] } = await db.query(
      `SELECT familia FROM commercial.commission_scales WHERE code = 'ZZ-PRUEBA-sin'`);
    check(`entra y queda 'ruta_directa' (dio ${sin ?? 'ok'}, familia ${y?.familia})`,
      sin === null && y?.familia === 'ruta_directa');
  } catch (e) {
    if (e.message !== '_salir') throw e;
  } finally {
    await db.query('ROLLBACK');
  }

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
