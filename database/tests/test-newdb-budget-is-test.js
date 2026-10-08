/**
 * `[PU.VG.1]` — **El ejercicio de PRUEBA no puede contaminar al que manda.**
 *
 * Medido en prod el 2026-10-08: `budget.budgets` tenía **3 filas y 2 eran de prueba** — una de
 * ellas llamada literalmente `PRUEBA ciclo ledger — no usar`, que es un **duplicado exacto** del
 * `Presupuesto 2027` (misma huella md5 sobre `(concept, line_type, vigente_amount)`). Consecuencia
 * medida: **todo agregado por `fiscal_year` publicaba el doble** ($149,704,381.64 de gasto donde
 * el real son $74,852,190.82). Y el `@Cron` del autopiloto recorría los tres todas las mañanas,
 * dejando fresco al que dice «no usar» — que es justo lo que lo hacía parecer legítimo.
 *
 * ⭐ La bandera `is_test` tiene DOS mitades y la segunda es la que no se ve:
 *
 *   1. que el autopiloto **no entre** a un ejercicio de prueba — eso es lógica pura y se prueba
 *      en `budget-autopilot.esEjercicioOperable.spec.ts`, no acá;
 *   2. que `ensureBudgetForYear` **no lo cuente** como «ya existe el ejercicio del año». Sin esto,
 *      el día que alguien marque como prueba el ÚNICO ejercicio de un año, la garantía de
 *      `[VE.5-A]` se apaga en silencio y ese año se queda **sin presupuesto**. Un hueco nuevo
 *      abierto por el cambio que vino a cerrar otro.
 *
 * Esta suite cubre (2) y la forma de la columna, que es lo que vive en Postgres. Cada compuerta
 * se prueba **rompiéndola a propósito**: un candado sin prueba negativa es una intención.
 *
 * ⚠️ La consulta de (2) se replica acá en vez de llamar al servicio (sería levantar Nest). Para
 * que no sea «verificar una vista contra sí misma», cada caso corre las DOS variantes —con y sin
 * el filtro— y afirma que **difieren**. Si algún día dejan de diferir, el filtro no está haciendo
 * nada y esto se pone rojo.
 *
 * Uso: DATABASE_URL_NEW=<una base NO productiva> node database/tests/test-newdb-budget-is-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
// Este test ESCRIBE (crea ejercicios de juguete). El `DATABASE_URL_NEW` del `.env` de las
// máquinas de trabajo apunta a `192.168.0.222:5434` — `pg-prod`. Sin esta guarda, correrlo tal
// cual deja ejercicios de prueba en el padrón real, que es el accidente del 2026-08-29.
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-is-test');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (c, m) => { console.log(`  ⚠️  NO MEDIDO · ${m}${c ? ` (${c})` : ''}`); };

/** Marca propia: todo lo que cree esta corrida se borra, sin tocar ejercicios de gente. */
const TAG = `__pu_vg_test_${Date.now()}`;
/** Año imposible: no choca con ningún ejercicio real, ni ahora ni en 50 años. */
const FY = 2999;

/** La consulta EXACTA de `ensureBudgetForYear` (budget-generation.service.ts), con y sin filtro. */
const yaExiste = (trx, fiscalYear, conFiltro) => {
  const q = trx('budget.budgets').where({ tenant_id: T, fiscal_year: fiscalYear });
  if (conFiltro) q.where({ is_test: false });
  return q.orderBy('created_at', 'asc').first();
};

(async () => {
  try {
    await knex.raw(`SET app.tenant_id = '${T}'`);

    // ── 1 · La forma de la columna ────────────────────────────────────────────────────────
    console.log('\n[1] la columna existe y su default es el lado seguro');
    const col = await knex.raw(`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='budget' AND table_name='budgets' AND column_name='is_test'`);
    const c = col.rows[0];
    ok(!!c, 'budget.budgets.is_test existe');
    if (c) {
      ok(c.data_type === 'boolean', `es boolean (${c.data_type})`);
      ok(c.is_nullable === 'NO', 'es NOT NULL — un ejercicio no puede estar "a medio marcar"');
      ok(String(c.column_default).includes('false'),
        `el default es false, no true: un ejercicio NUEVO se asume REAL (${c.column_default})`);
    }
    const idx = await knex.raw(`SELECT 1 FROM pg_indexes WHERE schemaname='budget' AND indexname='ix_budget_budgets_is_test'`);
    ok(idx.rows.length === 1, 'el índice parcial ix_budget_budgets_is_test está');

    // ── 2 · Una fila nueva nace REAL ──────────────────────────────────────────────────────
    console.log('\n[2] una fila nueva nace real, no de prueba');
    const [real] = await knex('budget.budgets').insert({
      tenant_id: T, name: `${TAG}_real`, fiscal_year: FY, currency: 'MXN', status: 'borrador',
    }).returning(['id', 'is_test']);
    ok(real.is_test === false, 'sin decir nada, is_test = false');

    // ── 3 · EL CANDADO: un ejercicio de prueba NO cuenta como "ya existe el del año" ───────
    console.log('\n[3] ensureBudgetForYear no puede contar los de prueba [PRUEBA NEGATIVA]');
    await knex('budget.budgets').where({ id: real.id }).update({ is_test: true });

    const conFiltro = await yaExiste(knex, FY, true);
    const sinFiltro = await yaExiste(knex, FY, false);

    ok(!conFiltro,
      'CON el filtro: el año se ve VACÍO, así que ensureBudgetForYear crearía el ejercicio real');
    ok(!!sinFiltro,
      'SIN el filtro: lo encontraría — o sea el filtro es lo único que separa los dos casos');
    ok(!conFiltro && !!sinFiltro,
      '⭐ las dos variantes DIFIEREN: esto no se está verificando contra sí mismo');

    // ── 4 · Y al revés: un ejercicio REAL sí frena la creación ────────────────────────────
    console.log('\n[4] prueba negativa del otro lado: un ejercicio real SÍ frena la creación');
    const [real2] = await knex('budget.budgets').insert({
      tenant_id: T, name: `${TAG}_real2`, fiscal_year: FY, currency: 'MXN', status: 'borrador',
    }).returning(['id']);
    const conFiltro2 = await yaExiste(knex, FY, true);
    ok(!!conFiltro2,
      'con un ejercicio real presente, el filtro lo encuentra — is_test no apaga la garantía [VE.5-A]');
    ok(String(conFiltro2.id) === String(real2.id),
      'y encuentra el REAL, no el de prueba');

    // ── 5 · El agregado publicado deja de duplicar ────────────────────────────────────────
    console.log('\n[5] el agregado por fiscal_year deja de contar dos veces');
    const total = await knex('budget.budgets').where({ tenant_id: T, fiscal_year: FY }).count('* as n').first();
    const publicable = await knex('budget.budgets').where({ tenant_id: T, fiscal_year: FY, is_test: false }).count('* as n').first();
    ok(Number(total.n) === 2, `hay 2 ejercicios en FY${FY} (uno de prueba, uno real)`);
    ok(Number(publicable.n) === 1, 'pero sólo 1 es publicable — el duplicado ya no suma');

    // ── 6 · Lo que esta suite NO mide, declarado ──────────────────────────────────────────
    console.log('\n[6] lo que NO se mide acá');
    nm('', 'que el @Cron del autopiloto salte el ejercicio marcado: es lógica pura y vive en budget-autopilot.esEjercicioOperable.spec.ts');
    nm('', 'que alguien MARQUE las filas de prod: es un acto con dueño, por id verificado, y no lo hace una migración');
  } catch (e) {
    console.error('\n❌ EXCEPCIÓN:', e.message);
    fail++;
  } finally {
    await knex('budget.budgets').where({ tenant_id: T, fiscal_year: FY }).whereLike('name', `${TAG}%`).del()
      .catch((e) => console.error('  (limpieza falló:', e.message, ')'));
    await knex.destroy();
  }
  console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} FALLA(S)`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
