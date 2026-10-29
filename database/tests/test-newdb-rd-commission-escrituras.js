/* eslint-disable no-console */
/**
 * ⭐⭐ `[RD.73.2]` CANDADO de **las escrituras del módulo de comisiones**.
 *
 *   node database/tests/test-newdb-rd-commission-escrituras.js
 *   node database/tests/test-newdb-rd-commission-escrituras.js --self-test
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 *
 * ⛔ **Cinco endpoints del módulo ESCRIBEN y ninguno tenía una prueba que los ejerciera**:
 * `/compute`, `/recalculate-from`, `/contrast/run`, `/scales` y `/objective/marks`. Es la regla
 * dura de `CLAUDE.md`, y el precio ya está medido en otra fase: `POST /cortes/:id/contar`
 * devolvía **500** y `cash_ledger_cut_denominations` llevaba **8 días en CERO filas** porque una
 * migración agregó una columna `NOT NULL` y actualizó **uno de los dos** caminos de inserción.
 * Build verde, lint verde, y su candado verde **porque escribía a la tabla sin llamar al
 * endpoint**.
 *
 * ⭐ `test-newdb-rd-commission-persist.js` ya cubre **la CABECERA**: contrasta las claves de
 * `totalesDeCorrida()` contra las columnas de `commission_runs`. Su propia etiqueta declara lo
 * que le falta, y es justo esto: *«el payload por LÍNEA de persist() sigue inline y no es
 * extraíble, y NOT NULL/CHECK/tipos son otra clase de falla»*. Este archivo cierra esa mitad.
 *
 * ── Qué vigila ─────────────────────────────────────────────────────────────────────────────
 *
 * **1. Cada columna `NOT NULL` sin default aparece en el INSERT del código.** Se leen las
 * columnas de `information_schema` y se busca cada una en el **archivo fuente real**, no en una
 * copia — una copia se desincroniza y el test se queda verde midiendo código que ya nadie corre.
 * Es el defecto del arqueo, detectado antes de que llegue a prod.
 *
 * **2. La escritura se EJERCE de verdad**, en transacción revertida: se inserta una corrida,
 * su línea y una línea del motor con la forma que arma el código. Eso ejercita `NOT NULL`,
 * `CHECK`, FK y tipos — las cuatro cosas que un cruce estático no ve.
 *
 * **3. PRUEBA NEGATIVA por cada tabla**: se quita una columna obligatoria del payload y se
 * exige el error **exacto** (`23502 not_null_violation`). Un detector que nunca marca nada se
 * lee igual que «no hay nada que marcar».
 *
 * **4. Y el CHECK del beneficiario**: un valor fuera del enum tiene que dar `23514`. Es la
 * guarda que impide que una línea se cuele con un beneficiario inventado y nadie la sume.
 *
 * ⚠️ **Lo que NO cubre, declarado:** que el endpoint HTTP arme ese payload. Eso exige la API
 * arriba y vive en las 65 suites `needsApi` que todavía no corren (deuda `[VP.5]`). Acá se
 * prueba que **la forma que el código escribe entra en la tabla**, que es la mitad que se puede
 * probar sin red.
 *
 * ⚠️ Contra una base de **sólo lectura** (el rol `edgar` en prod lo es) no se puede ejercer
 * nada: reporta **NO MEDIDO** con su motivo, no se salta en silencio.
 */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const SELF = process.argv.includes('--self-test');
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const SRC = path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-commissions');
const FUENTES = {
  commission_run_lines: path.join(SRC, 'commercial-commissions.service.ts'),
  commission_engine_lines: path.join(SRC, 'commission-contrast.service.ts'),
  // `[RD.100]` la nomina de banco del supervisor, que se fija desde la pantalla.
  commission_beneficiary_config: path.join(SRC, 'commission-beneficiarios.service.ts'),
};

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/** Las columnas que la tabla EXIGE: `NOT NULL` y sin default que las rellene. */
async function obligatorias(db, tabla) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = $1
        AND is_nullable = 'NO' AND column_default IS NULL
        AND column_name NOT IN ('id','tenant_id','created_at','updated_at')
      ORDER BY 1`, [tabla]);
  return rows.map((r) => r.column_name);
}

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 60000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  console.log(`\n=== [RD.73.2] las escrituras del modulo de comisiones · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  // ── 1. Cruce estatico: columna obligatoria <-> INSERT del codigo REAL ────────────────────
  for (const [tabla, archivo] of Object.entries(FUENTES)) {
    if (!(await db.query(`SELECT to_regclass('commercial.${tabla}') t`)).rows[0].t) {
      noMedido(`cruce de ${tabla}`, 'la tabla no existe en este destino'); continue;
    }
    if (!fs.existsSync(archivo)) {
      noMedido(`cruce de ${tabla}`, `no se encontro el fuente ${path.basename(archivo)}`); continue;
    }
    const src = fs.readFileSync(archivo, 'utf8');
    const cols = await obligatorias(db, tabla);
    const faltan = cols.filter((c) => !new RegExp(`\\b${c}\\b`).test(src));
    check(`${tabla}: las ${cols.length} columnas obligatorias aparecen en ${path.basename(archivo)}`,
      faltan.length === 0, `no se nombran: ${faltan.join(', ')}`);
    // Control positivo: si el cruce no encontrara NADA, estaria midiendo el vacio.
    check(`${tabla}: el cruce tiene columnas que vigilar`, cols.length > 0,
      'la tabla no declara ninguna columna obligatoria: el cruce seria un no-op');
  }

  // ── 2 a 4. Ejercer la escritura de verdad ────────────────────────────────────────────────
  const { rows: [ro] } = await db.query(`SELECT current_setting('transaction_read_only') AS ro`);
  if (ro.ro === 'on') {
    noMedido('ejercer las escrituras', 'el rol de esta conexion es de SOLO LECTURA; corre en CI (job pruebas-db) o con un rol que escriba');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  const { rows: [sem] } = await db.query(
    `SELECT (SELECT id FROM commercial.commission_periods WHERE tenant_id=$1 LIMIT 1) AS period_id,
            (SELECT id FROM commercial.commission_scales  WHERE tenant_id=$1 LIMIT 1) AS scale_id`,
    [TENANT]);
  if (!sem.period_id || !sem.scale_id) {
    noMedido('ejercer las escrituras', 'falta un periodo o una escala sembrados: sin FK validas no se puede insertar');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  await db.query('BEGIN');
  try {
    // La corrida, con la forma que arma `totalesDeCorrida()` + `persist()`.
    const { rows: [run] } = await db.query(
      `INSERT INTO commercial.commission_runs (tenant_id, period_id, scale_id, status, total_a_pagar)
       VALUES ($1,$2,$3,'borrador',0) RETURNING id`, [TENANT, sem.period_id, sem.scale_id]);
    check('se puede INSERTAR una corrida en borrador', !!run.id);

    await db.query(
      `INSERT INTO commercial.commission_run_lines (tenant_id, run_id, route_code, beneficiario, a_pagar)
       VALUES ($1,$2,'ZZ-TEST','chofer',0)`, [TENANT, run.id]);
    check('se puede INSERTAR una linea de corrida', true);

    await db.query(
      `INSERT INTO commercial.commission_engine_lines (tenant_id, period_id, scale_id, route_code, beneficiario)
       VALUES ($1,$2,$3,'ZZ-TEST','chofer')`, [TENANT, sem.period_id, sem.scale_id]);
    check('se puede INSERTAR una linea del motor', true);

    // ── 3. PRUEBA NEGATIVA: falta una columna obligatoria -> 23502 ─────────────────────────
    for (const [tabla, sql, params] of [
      ['commission_run_lines',
        `INSERT INTO commercial.commission_run_lines (tenant_id, run_id, route_code) VALUES ($1,$2,'ZZ-NEG')`,
        [TENANT, run.id]],
      ['commission_engine_lines',
        `INSERT INTO commercial.commission_engine_lines (tenant_id, period_id, route_code) VALUES ($1,$2,'ZZ-NEG')`,
        [TENANT, sem.period_id]],
    ]) {
      await db.query('SAVEPOINT neg');
      let code = null;
      try { await db.query(sql, params); } catch (e) { code = e.code; }
      await db.query('ROLLBACK TO SAVEPOINT neg');
      check(`PRUEBA NEGATIVA ${tabla}: sin beneficiario da 23502`, code === '23502',
        code ? `dio ${code}` : 'NO fallo: la columna obligatoria no esta siendo exigida');
    }

    // ── 4. El CHECK del beneficiario ──────────────────────────────────────────────────────
    await db.query('SAVEPOINT chk');
    let code = null;
    try {
      await db.query(
        `INSERT INTO commercial.commission_run_lines (tenant_id, run_id, route_code, beneficiario, a_pagar)
         VALUES ($1,$2,'ZZ-CHK','inventado',0)`, [TENANT, run.id]);
    } catch (e) { code = e.code; }
    await db.query('ROLLBACK TO SAVEPOINT chk');
    check('PRUEBA NEGATIVA: un beneficiario fuera del enum da 23514', code === '23514',
      code ? `dio ${code}` : 'NO fallo: cualquier beneficiario entra');

    // ── 5. `[RD.100]` La nomina del supervisor, versionada como la escribe `fijar()` ────────
    //    Primera version, despues se CIERRA (valid_to = valid_from de la nueva) y se abre otra.
    const { rows: [v1] } = await db.query(
      `INSERT INTO commercial.commission_beneficiary_config
         (tenant_id, scale_id, beneficiario, nombre, nomina_banco, valid_from, notes)
       VALUES ($1,$2,'supervisor','ZZ-SUPERVISOR',1000,'2026-01-01',NULL) RETURNING id`,
      [TENANT, sem.scale_id]);
    await db.query(
      `UPDATE commercial.commission_beneficiary_config SET valid_to = '2026-10-22' WHERE id = $1`, [v1.id]);
    await db.query(
      `INSERT INTO commercial.commission_beneficiary_config
         (tenant_id, scale_id, beneficiario, nombre, nomina_banco, valid_from)
       VALUES ($1,$2,'supervisor','ZZ-SUPERVISOR',1500,'2026-10-22')`, [TENANT, sem.scale_id]);
    // La misma consulta que `deducciones()`: a una fecha, la version vigente de cada persona.
    const vig = async (d) => (await db.query(
      `SELECT nomina_banco::float8 n FROM commercial.commission_beneficiary_config
        WHERE tenant_id = $1 AND nombre = 'ZZ-SUPERVISOR' AND deleted_at IS NULL
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from`,
      [TENANT, d])).rows.map((r) => r.n);
    check('nomina del supervisor: Q20 lee la version vieja', JSON.stringify(await vig('2026-10-07')) === '[1000]');
    check('nomina del supervisor: Q22 lee la version nueva', JSON.stringify(await vig('2026-11-04')) === '[1500]');

    // PRUEBA NEGATIVA: cerrar una version en su propio dia (valid_to = valid_from) da 23514.
    // Es por lo que `fijar()` corrige EN SITIO cuando la fecha coincide, en vez de cerrar y abrir.
    await db.query('SAVEPOINT ventana');
    let codeV = null;
    try {
      await db.query(
        `UPDATE commercial.commission_beneficiary_config SET valid_to = valid_from
          WHERE tenant_id = $1 AND nombre = 'ZZ-SUPERVISOR' AND valid_to IS NULL`, [TENANT]);
    } catch (e) { codeV = e.code; }
    await db.query('ROLLBACK TO SAVEPOINT ventana');
    check('PRUEBA NEGATIVA: cerrar una version en su mismo dia da 23514', codeV === '23514',
      codeV ? `dio ${codeV}` : 'NO fallo: la ventana vacia entra');

    // PRUEBA NEGATIVA: sin escala -> 23502 (la columna es NOT NULL; `fijar()` la resuelve sola).
    await db.query('SAVEPOINT sinescala');
    let codeS = null;
    try {
      await db.query(
        `INSERT INTO commercial.commission_beneficiary_config (tenant_id, beneficiario, nombre, nomina_banco, valid_from)
         VALUES ($1,'supervisor','ZZ-NEG',0,'2026-01-01')`, [TENANT]);
    } catch (e) { codeS = e.code; }
    await db.query('ROLLBACK TO SAVEPOINT sinescala');
    check('PRUEBA NEGATIVA: nomina de supervisor sin escala da 23502', codeS === '23502',
      codeS ? `dio ${codeS}` : 'NO fallo');
  } catch (e) {
    fail++; console.log(`  ✖ la escritura reventó — ${e.code || ''} ${e.message}`);
  } finally {
    await db.query('ROLLBACK');
  }

  const { rows: [limpio] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_run_lines WHERE route_code LIKE 'ZZ-%'`);
  check('el rollback no dejo nada', limpio.n === 0, `quedaron ${limpio.n} fila(s)`);

  noMedido('que el ENDPOINT HTTP arme este payload',
    'exige la API arriba; vive en las 65 suites needsApi que no corren (deuda VP.5)');

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

void SELF;
