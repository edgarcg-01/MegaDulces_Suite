'use strict';
/**
 * `[OR.4]` — El contrato de tarea contra el esquema REAL.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────
 * ADR-056: **un primitivo no cierra la fase hasta que vive en `libs/`**, y el
 * reparto de trabajo se construyó cuatro veces sin subir nunca. El contrato
 * (`libs/contracts/src/work/task.contract.ts`) declara esas cuatro fuentes y su
 * mapeo. Este smoke es el **gate** que impide que se vuelva a repetir:
 *
 *   1. Descubre en la base TODA tabla con semántica de asignación (alguna
 *      columna `assigned_(to|by|at)`) y falla si aparece **una quinta sin
 *      declarar**. Es el gate contra la tabla número cinco.
 *   2. Verifica que **cada columna que el contrato nombra exista de verdad**.
 *      Un contrato que apunta a una columna renombrada es peor que no tenerlo:
 *      compila, se lee bien y devuelve `undefined` en silencio.
 *   3. Cruza los **dialectos de estado** declarados contra los CHECK de la base,
 *      en las DOS direcciones: un valor que la base admite y el contrato no
 *      conoce se traduciría a `null`; uno que el contrato inventa nunca llegaría.
 *   4. Prueba negativa del traductor: un estado desconocido devuelve `null` y
 *      **no** cae a `pending`. Un default disfrazado convertiría lo desconocido
 *      en trabajo vivo.
 *
 * ⚠️ Lee el `.ts` REAL con ts-node — no una copia de las constantes. Un gate que
 * compara el contrato contra su propia transcripción se pone verde solo.
 *
 * Read-only: no escribe una sola fila.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(REPO, '.env') });
const knex = require('knex');

require(path.join(REPO, 'node_modules', 'ts-node')).register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;

let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, msg) => {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ FAIL ${msg}`); }
};
const declarar = (msg) => { nomedido++; console.log(`  ~ NO MEDIDO ${msg}`); };

/**
 * Vistas passthrough que espejan una tabla ya declarada. NO son fuentes nuevas:
 * `public.daily_assignments` es la vista de `trade.daily_assignments` (mismas 119
 * filas). Se listan acá para que el descubridor no las cuente dos veces — y para
 * que agregar una vista nueva exija tocar este archivo.
 */
const ESPEJOS = { 'public.daily_assignments': 'trade.daily_assignments' };

(async () => {
  if (!URL) { console.error('Falta FLEET_DB_URL / DATABASE_URL_NEW'); process.exit(1); }

  const contrato = require(path.join(REPO, 'libs/contracts/src/work/task.contract.ts'));
  const { FUENTES_TAREA, ADAPTADORES, ESTADOS_TAREA, estadoCanonico, adaptadorDe, estaAbierta,
          LIMITES_DEL_CONTRATO } = contrato;

  const k = knex({
    client: 'pg',
    pool: { min: 0, max: 2 },
    connection: /rlwy|railway/i.test(URL)
      ? { connectionString: URL, ssl: { rejectUnauthorized: false } }
      : URL,
  });

  try {
    // ── 1. El gate: ¿apareció una quinta tabla de tareas? ─────────────────
    console.log('\n── 1. Gate: ninguna fuente de tareas sin declarar');
    const desc = await k.raw(`
      WITH cols AS (
        SELECT table_schema s, table_name t, array_agg(column_name::text) cs
          FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog','information_schema')
         GROUP BY 1,2)
      SELECT s, t FROM cols
       WHERE EXISTS (SELECT 1 FROM unnest(cs) x WHERE x ~ '^assigned_(to|by|at)')
       ORDER BY 1,2`);

    const halladas = desc.rows.map((r) => `${r.s}.${r.t}`);
    const declaradas = new Set(FUENTES_TAREA);
    const sinDeclarar = halladas.filter((f) => !declaradas.has(f) && !ESPEJOS[f]);
    const declaradasQueNoExisten = [...declaradas].filter((f) => !halladas.includes(f));

    check(
      sinDeclarar.length === 0,
      `ninguna fuente de tareas sin declarar en el contrato (sobra: ${sinDeclarar.join(', ') || 'ninguna'})`,
    );
    check(
      declaradasQueNoExisten.length === 0,
      `toda fuente declarada existe en la base (fantasma: ${declaradasQueNoExisten.join(', ') || 'ninguna'})`,
    );
    check(
      FUENTES_TAREA.length === ADAPTADORES.length,
      `${FUENTES_TAREA.length} fuentes y ${ADAPTADORES.length} adaptadores — una fuente sin mapeo no se puede leer`,
    );
    console.log(`     halladas en la base: ${halladas.length} (${Object.keys(ESPEJOS).length} espejo/s de vista)`);

    // ── 1b. PRUEBA NEGATIVA del gate ──────────────────────────────────────
    // ADR-056: un gate sin prueba negativa es una intención. Un verde sobre una
    // base que nunca cambia no prueba que el gate MIRE. Se crea una quinta
    // tabla de tareas a propósito, dentro de una transacción que hace ROLLBACK
    // (Postgres tiene DDL transaccional), y se verifica que la descubra.
    const trx = await k.transaction();
    try {
      await trx.raw(`
        CREATE TABLE public._or4_tarea_intrusa (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          assigned_to uuid,
          status text
        )`);
      const reDesc = await trx.raw(`
        WITH cols AS (
          SELECT table_schema s, table_name t, array_agg(column_name::text) cs
            FROM information_schema.columns
           WHERE table_schema NOT IN ('pg_catalog','information_schema')
           GROUP BY 1,2)
        SELECT s, t FROM cols
         WHERE EXISTS (SELECT 1 FROM unnest(cs) x WHERE x ~ '^assigned_(to|by|at)')
         ORDER BY 1,2`);
      const conIntrusa = reDesc.rows
        .map((r) => `${r.s}.${r.t}`)
        .filter((f) => !declaradas.has(f) && !ESPEJOS[f]);
      check(
        conIntrusa.includes('public._or4_tarea_intrusa'),
        `una quinta tabla de tareas SIN declarar es DETECTADA (encontró: ${conIntrusa.join(', ') || 'nada'})`,
      );
      check(
        conIntrusa.length === 1,
        `y sólo detecta la intrusa, no dispara sobre las declaradas (${conIntrusa.length} hallazgo/s)`,
      );
    } finally {
      await trx.rollback();
    }
    const post = await k.raw(
      `SELECT to_regclass('public._or4_tarea_intrusa') AS r`);
    check(post.rows[0].r === null, 'prod intacto: la tabla de prueba no quedó (rollback)');

    // ── 2. Cada columna que el contrato nombra, ¿existe? ──────────────────
    console.log('\n── 2. El contrato apunta a columnas que existen');
    for (const a of ADAPTADORES) {
      const [schema, tabla] = a.fuente.split('.');
      const cols = await k('information_schema.columns')
        .where({ table_schema: schema, table_name: tabla })
        .pluck('column_name');
      const set = new Set(cols);
      const nombradas = [
        a.col_asignado_a, a.col_asignado_por, a.col_asignado_at, a.col_vence, a.col_estado,
      ].filter(Boolean);
      const faltan = nombradas.filter((c) => !set.has(c));
      check(faltan.length === 0, `${a.fuente}: sus ${nombradas.length} columnas existen (faltan: ${faltan.join(', ') || 'ninguna'})`);

      // El tipo de "quién asignó" está DECLARADO; si la base dice otra cosa, el
      // contrato miente sobre si esa persona se puede unir al padrón.
      const tipo = await k('information_schema.columns')
        .where({ table_schema: schema, table_name: tabla, column_name: a.col_asignado_por })
        .first('data_type');
      if (tipo) {
        const esUuid = tipo.data_type === 'uuid';
        check(
          esUuid === a.asignado_por_es_uuid,
          `${a.fuente}.${a.col_asignado_por} es ${tipo.data_type} y el contrato declara ` +
            `${a.asignado_por_es_uuid ? 'uuid' : 'texto'} — de esto depende si se puede unir a identity.users`,
        );
      }
    }

    // ── 3. Los dialectos de estado, contra el CHECK real ──────────────────
    console.log('\n── 3. Los dialectos declarados == lo que la base admite');
    for (const a of ADAPTADORES) {
      if (!a.col_estado) {
        check(
          a.estado_fijo !== null,
          `${a.fuente}: sin columna de estado, declara estado_fijo="${a.estado_fijo}"`,
        );
        continue;
      }
      const ck = await k.raw(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
          WHERE conrelid = ?::regclass AND contype = 'c'`, [a.fuente]);
      const def = ck.rows.map((r) => r.d).find((d) => new RegExp(`\\b${a.col_estado}\\b`).test(d));

      if (!def) {
        // Sin CHECK no hay vocabulario declarado: se mide contra los datos, y se
        // DECLARA que la tabla no restringe nada.
        const vivos = await k(a.fuente).distinct(a.col_estado).pluck(a.col_estado);
        const desconocidos = vivos.filter((v) => v != null && !a.estados[v]);
        check(
          desconocidos.length === 0,
          `${a.fuente}: todos los estados en datos están mapeados (sin mapear: ${desconocidos.join(', ') || 'ninguno'})`,
        );
        declarar(
          `${a.fuente}.${a.col_estado} NO tiene CHECK: su vocabulario no está declarado en la base, ` +
            `así que sólo se puede medir contra las filas que hoy existen (${vivos.length} valor/es distinto/s).`,
        );
        continue;
      }

      const admitidos = [...def.matchAll(/'([a-z_]+)'::/g)].map((m) => m[1]);
      const unicos = [...new Set(admitidos)].filter((v) => v !== 'text' && v !== 'character');
      const sinMapear = unicos.filter((v) => !a.estados[v]);
      const inventados = Object.keys(a.estados).filter((v) => !unicos.includes(v));
      check(
        sinMapear.length === 0,
        `${a.fuente}: el CHECK admite ${unicos.length} estados y el contrato los mapea todos ` +
          `(sin mapear: ${sinMapear.join(', ') || 'ninguno'})`,
      );
      check(
        inventados.length === 0,
        `${a.fuente}: el contrato no inventa estados que la base rechaza (inventados: ${inventados.join(', ') || 'ninguno'})`,
      );
    }

    // ── 4. El traductor: prueba negativa y control positivo ───────────────
    console.log('\n── 4. El traductor no adivina');
    check(
      estadoCanonico('finance.recon_tasks', 'pendiente') === 'pending',
      'CONTROL: un estado conocido SÍ se traduce (pendiente -> pending)',
    );
    check(
      estadoCanonico('finance.recon_tasks', 'una_cosa_rara') === null,
      'un estado desconocido devuelve null, NO cae a "pending" — un default disfrazado convertiría lo desconocido en trabajo vivo',
    );
    check(
      estadoCanonico('finance.recon_tasks', null) === null,
      'un estado nulo devuelve null',
    );
    check(
      estadoCanonico('commercial.inventory_count_assignments', null) === 'pending',
      'una fuente SIN columna de estado usa su estado_fijo declarado',
    );
    let lanzo = false;
    try { adaptadorDe('finance.tabla_inventada'); } catch { lanzo = true; }
    check(lanzo, 'pedir el adaptador de una fuente no declarada LANZA — el gate también en tiempo de uso');

    check(
      estaAbierta('pending') && estaAbierta('in_progress') &&
        !estaAbierta('done') && !estaAbierta('cancelled') && !estaAbierta('not_applicable'),
      'estaAbierta() separa trabajo vivo de trabajo cerrado en los 5 estados',
    );
    check(
      ESTADOS_TAREA.includes('cancelled') && ESTADOS_TAREA.includes('not_applicable'),
      '`cancelled` y `not_applicable` conviven sin colapsarse: "se dio de baja" y "no era real" son distintos',
    );

    // ── 5. Volumen real por fuente ────────────────────────────────────────
    console.log('\n── 5. Lo que hay hoy en cada fuente');
    let total = 0;
    for (const f of FUENTES_TAREA) {
      const r = await k(f).count('* as n').first();
      total += Number(r.n);
      console.log(`     ${String(f).padEnd(42)} ${String(r.n).padStart(5)} filas`);
    }
    check(total > 0, `${total} asignaciones nominales en total entre las 4 fuentes`);

    // ── 6. Los límites, declarados ────────────────────────────────────────
    console.log('\n── 6. Lo que el contrato NO resuelve');
    LIMITES_DEL_CONTRATO.forEach((l) => declarar(l));
    for (const a of ADAPTADORES) {
      a.no_responde.forEach((n) => declarar(`${a.fuente}: ${n}`));
    }

    console.log(
      `\n${fail === 0 ? '✅' : '❌'} [OR.4] contrato único de tarea: ${ok} ok, ${fail} fallos, ${nomedido} declarado(s)`,
    );
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
