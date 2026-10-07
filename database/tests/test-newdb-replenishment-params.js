/**
 * `[RA-DYN.P4]` — **El vector de parámetros del motor de pedido: lo que tiene que IMPEDIR.**
 *
 * `commercial.replenishment_params` saca de `.env` los números que gobiernan el reorden. Lo fácil
 * de probar es que se puede insertar una fila; eso no prueba nada. Lo que se afirma acá son las
 * **cinco maneras de romper el motor en silencio** que las compuertas tienen que bloquear, cada
 * una rompiéndola a propósito — un candado sin prueba negativa es una intención, no un candado:
 *
 *  1. **Nivel de servicio en 1.0 → colchón CERO.** `invNorm` (Acklam) abre con
 *     `if (p <= 0 || p >= 1) return 0`, así que el valor que se lee como "servicio perfecto"
 *     produce `ceil(0 * sigma * sqrt(lead))` = 0. Es el peor de todos porque parece lo contrario
 *     de lo que hace, y no tira error.
 *  2. **La clase C con más servicio que la A.** El motor no falla: le da más colchón a lo que
 *     menos vale y menos a lo que sostiene la venta, para siempre.
 *  3. **Cortes de clasificación invertidos** (X=0.5, Y=0.3). El `CASE` del clasificador nunca
 *     puede devolver 'Y' y la clase desaparece sin ruido.
 *  4. **Tiempos en cero.** Un lead o un ciclo en 0 apaga su término entero del cálculo.
 *  5. **Dos versiones con el mismo `valid_from`.** El `ORDER BY valid_from DESC LIMIT 1` de la
 *     carga por corrida tomaría cualquiera de las dos — un motor que cambia de parámetros entre
 *     corridas idénticas.
 *
 * Más dos afirmaciones estructurales:
 *
 *  · **Append-only de verdad**: `app_runtime` tiene SELECT e INSERT y NO tiene UPDATE ni DELETE.
 *    La inmutabilidad es una garantía del motor de la base, no una convención del código.
 *  · **El seed NO mueve ningún número**: transcribe los defaults vigentes. Si esta aserción falla,
 *    la migración cambió el sugerido y hay que parar.
 *
 * ⚠️ PLACEBO: también se afirma que una fila VÁLIDA entra. Sin ese control, un CHECK que rechaza
 * absolutamente todo pasaría las cinco pruebas negativas en verde.
 *
 * Uso: DATABASE_URL_NEW=<dev> node database/tests/test-newdb-replenishment-params.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-replenishment-params');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const TABLA = 'commercial.replenishment_params';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** Los defaults vigentes al 2026-10-01. Si el seed se aparta de esto, movió un número. */
const VIGENTES = {
  service_a: 0.98, service_b: 0.95, service_c: 0.90, service_cedis: 0.98,
  lead_default_days: 7, cycle_days: 14, safety_floor_days: 2,
  abc_a_cut: 0.80, abc_b_cut: 0.95, xyz_x_max: 0.5, xyz_y_max: 1.0,
};

/**
 * Una fila válida, base de todas las mutaciones. `valid_from` único por llamada.
 *
 * ⚠️ Fechadas en **1990**, no en el futuro: si una limpieza fallara, una fila con `valid_from`
 * futuro se volvería la versión VIGENTE al llegar esa fecha y el motor arrancaría con parámetros
 * de prueba. En el pasado remoto nunca gana el `ORDER BY valid_from DESC LIMIT 1`.
 */
const EPOCA = Date.UTC(1990, 0, 1);
let seq = 0;
const base = (over = {}) => ({
  tenant_id: T, ...VIGENTES,
  valid_from: new Date(EPOCA + (seq += 1) * 1000),
  source: 'SMOKE-RA-DYN-P4',
  ...over,
});

/** Inserta rompiendo lo que se le pida; devuelve el error de Postgres o null si pasó. */
async function intentar(fila) {
  try { await knex(TABLA).insert(fila); return null; }
  catch (e) { return e.message || String(e); }
}

(async () => {
  try {
    const existe = (await knex.raw(`SELECT to_regclass('${TABLA}') AS t`)).rows[0]?.t;
    if (!existe) {
      console.log('  ⚠️  sin la tabla de parámetros (¿migración 20261001170000 pendiente?) — NO MEDIDO');
      process.exit(2);
    }

    console.log('\n[1] El seed transcribe los defaults vigentes (NO mueve ningún número)');
    const seed = await knex(TABLA).where({ tenant_id: T }).orderBy('valid_from', 'asc').first();
    ok(!!seed, 'existe una versión inicial para el tenant');
    if (seed) {
      for (const [k, v] of Object.entries(VIGENTES)) {
        ok(Number(seed[k]) === v, `${k} = ${v} (vigente) · leído ${seed[k]}`);
      }
      ok(!!seed.source && seed.source.trim() !== '', 'la versión declara su procedencia');
    }

    console.log('\n[2] PRUEBAS NEGATIVAS — romper cada compuerta a propósito');
    ok(!!await intentar(base({ service_a: 1.0 })),
       'rechaza service_a = 1.0 (invNorm daría Z=0 → colchón CERO en silencio)');
    ok(!!await intentar(base({ service_a: 0.4, service_b: 0.35, service_c: 0.3 })),
       'rechaza nivel de servicio < 0.5 (Z negativa, modelo invertido)');
    ok(!!await intentar(base({ service_a: 0.90, service_c: 0.98 })),
       'rechaza C con más servicio que A (más colchón a lo que menos vale)');
    ok(!!await intentar(base({ xyz_x_max: 0.5, xyz_y_max: 0.3 })),
       "rechaza cortes XYZ invertidos (la clase 'Y' se volvería inalcanzable)");
    ok(!!await intentar(base({ abc_a_cut: 0.95, abc_b_cut: 0.80 })),
       'rechaza cortes ABC invertidos');
    ok(!!await intentar(base({ lead_default_days: 0 })),
       'rechaza lead_default_days = 0 (apaga el término sqrt(lead))');
    ok(!!await intentar(base({ cycle_days: 0 })), 'rechaza cycle_days = 0');
    ok(!!await intentar(base({ source: '   ' })), 'rechaza una procedencia vacía');

    console.log('\n[3] PLACEBO — una fila válida SÍ entra (si no, los CHECK rechazan todo)');
    const valida = base();
    const errValida = await intentar(valida);
    ok(errValida === null, `una versión válida se inserta${errValida ? ` · ${errValida}` : ''}`);

    console.log('\n[4] Una sola versión por instante');
    ok(!!await intentar(base({ valid_from: valida.valid_from })),
       'rechaza dos versiones con el mismo valid_from (la lectura por corrida sería ambigua)');

    /*
     * [5] Append-only: app_runtime no puede editar la evidencia.
     *
     * ⚠️ Se pregunta con `has_table_privilege`, NO con `information_schema.role_table_grants`.
     * La vista sólo muestra los grants donde quien consulta es otorgante, beneficiario o miembro:
     * preguntando por un rol ajeno devuelve **lista vacía**, y entonces `!privs.includes('UPDATE')`
     * se pone **verde por ausencia de datos**. Pasó de verdad el 2026-10-01 verificando esta misma
     * tabla en prod, y tapó que `app_runtime` SÍ tenía UPDATE y DELETE (las DEFAULT PRIVILEGES del
     * schema `commercial` dan `arwd` a toda tabla nueva, así que el GRANT selectivo fue un no-op y
     * hizo falta un REVOKE — mig 20261001180000). `has_table_privilege` lo contesta el motor y no
     * depende de la visibilidad de quien pregunta.
     */
    console.log('\n[5] Append-only: app_runtime no puede editar la evidencia');
    const priv = async (p) => (await knex.raw(
      `SELECT has_table_privilege('app_runtime', ?, ?) AS v`, [TABLA, p])).rows[0].v;
    ok(await priv('SELECT'), 'app_runtime puede leer');
    ok(await priv('INSERT'), 'app_runtime puede insertar una versión nueva');
    ok(!await priv('UPDATE'), 'app_runtime NO puede UPDATE (la fila referenciada no se edita)');
    ok(!await priv('DELETE'), 'app_runtime NO puede DELETE');
    // CONTROL: una tabla vecina del mismo schema SÍ tiene UPDATE. Sin esto, un entorno donde
    // app_runtime no existiera dejaría las dos negativas en verde sin significar nada.
    ok(await knex.raw(`SELECT has_table_privilege('app_runtime','commercial.reorder_policy','UPDATE') AS v`)
      .then((r) => r.rows[0].v), 'CONTROL: commercial.reorder_policy SÍ admite UPDATE (el rol existe y la pregunta discrimina)');

    console.log('\n[6] RLS forzado');
    const rls = await knex.raw(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='${TABLA}'::regclass`);
    ok(rls.rows[0]?.relrowsecurity === true, 'RLS habilitado');
    ok(rls.rows[0]?.relforcerowsecurity === true, 'RLS FORZADO (aplica también al dueño)');

    // Limpieza: sólo lo que sembró este smoke. El seed de la migración no se toca.
    await knex(TABLA).where({ tenant_id: T, source: 'SMOKE-RA-DYN-P4' }).del();

    console.log(`\n${fail === 0 ? '✅' : '❌'} test-newdb-replenishment-params: ${fail} falla(s)`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('  ❌ error inesperado:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
