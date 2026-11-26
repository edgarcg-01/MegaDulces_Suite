/**
 * `[PQ.3.17]` Quién definió, quién cambió y de qué a qué en las reglas del Calendario de compras (anexo C §10.9, DC25),
 * contra una base REAL y con el payload de la pantalla (CLAUDE.md regla 13).
 *
 * Carga con ts-node el MISMO `purchase-calendar.repo.ts` que usa la API y lo corre como `app_runtime` con el tenant
 * puesto (RLS y GRANT de producción). Todo en UNA transacción que se revierte: la migración 20261124231747 (su `up()`
 * real: el disparador de `analytics.master_data_history` sobre las reglas) y las fechas que la prueba recorre.
 *
 * ⚠️ En una transacción `now()` no avanza: para que una regla «se haya cambiado después» la prueba corre hacia atrás
 * `created_at` / `updated_at` como postgres con los disparadores apagados (`session_replication_role = replica`).
 *
 * Qué afirma:
 *  1. La migración pone el disparador (idempotente) y `down()` lo quita.
 *  2. Una regla recién definida: «Definida por» quien la creó, sin último cambio y sin historial (el alta no se registra).
 *     Y lo escrito en la MISMA transacción del alta (como «Sacar del ciclo a los N»: define y saca del ciclo) es parte
 *     del alta: ni último cambio ni «Cambios», aunque la fila sí quede en el log (lo encontró la prueba visual).
 *  3. Otra persona cambia el patrón: la regla nombra a las DOS (definida por A, último cambio de B) y el historial dice
 *     de qué a qué (cada miércoles → cada 14 días), con B como quien lo hizo.
 *  4. Una tercera escritura (fuera de ciclo) la hace A: el historial la atribuye a A y no a B (cada escritura declara
 *     quién; NEGATIVA de que el actor no se «hereda» de la escritura anterior).
 *  5. Guardar el mismo patrón otra vez deja su fila (sólo `updated_at`): el último cambio siempre tiene su fila.
 *  6. Una escritura que no declara quién queda con `por: null` (se dice, no se inventa).
 *  7. La baja queda en el historial con quién.
 *  8. NEGATIVA: sin el disparador, el calendario DECLARA el historial no medido y no manda `cambios` (no «sin cambios»).
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). A mano, con `DATABASE_URL_NEW` a una base local.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-17-calendario-historial');
const { noMedido, correr } = require('./_lib/no-medido');
const RAIZ = path.resolve(__dirname, '..', '..');
let R;
let K;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  R = require(path.join(RAIZ, 'libs/commercial/src/lib/purchase-calendar/purchase-calendar.repo.ts'));
  K = require(path.join(RAIZ, 'libs/contracts/src/http/purchase-calendar.contract.ts'));
} catch (e) {
  noMedido(`no se pudo cargar el repositorio con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const migBase = require('../migrations-newdb/20261120130156_pq3_2_reglas_de_revision_compras.js');
const migCadencia = require('../migrations-newdb/20261124133043_pq3_15_cadencia_dias_de_la_semana.js');
const migHistorial = require('../migrations-newdb/20261124231747_pq3_17_historial_de_reglas_del_calendario.js');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const RULES = 'commercial.purchase_review_rules';
let ok = 0;
let ko = 0;
const nm = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};

correr(async () => {
  console.log('\n[PQ.3.17] Quién definió, quién cambió y de qué a qué — el repositorio real, como app_runtime\n');
  const trx = await knex.transaction();
  try {
    if ((await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on') noMedido('la conexión es de sólo lectura');
    if (!(await trx('identity.tenants').where({ id: TENANT }).first('id'))) noMedido(`no existe el tenant ${TENANT}`);
    if (!(await trx.raw(`SELECT to_regclass('analytics.master_data_history') IS NOT NULL AS si`)).rows[0].si) {
      noMedido('la base no tiene analytics.master_data_history (VP.3.1, migración 20260907130000)');
    }
    if (!(await trx.schema.withSchema('commercial').hasTable('purchase_review_rules'))) await migBase.up(trx);
    await migCadencia.up(trx);

    // ── 1 · La migración ──────────────────────────────────────────────────────────────────────────────────────
    const disparador = async () => (await trx.raw(`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'commercial.purchase_review_rules'::regclass AND tgname = 'trg_master_data_history' AND NOT tgisinternal`)).rows[0].n;
    await migHistorial.up(trx);
    await migHistorial.up(trx); // idempotente
    check('la migración pone UN disparador del historial sobre las reglas (dos veces = uno)', (await disparador()) === 1);
    await migHistorial.down(trx);
    check('down() lo quita', (await disparador()) === 0);
    await migHistorial.up(trx);

    const [P, P2] = await trx('catalog.suppliers as s').where({ 's.tenant_id': TENANT }).whereNull('s.deleted_at').whereNotNull('s.code')
      .whereRaw(`btrim(s.code) <> ''`)
      .whereRaw(`NOT EXISTS (SELECT 1 FROM ${RULES} r WHERE r.tenant_id = s.tenant_id AND r.supplier_code = s.code AND r.deleted_at IS NULL)`)
      .orderBy('s.code').limit(2).select('s.code', 's.name');
    if (!P2) noMedido('la base no tiene dos proveedores vivos sin regla en catalog.suppliers');
    const gente = await trx('identity.users').where({ tenant_id: TENANT, activo: true }).whereNull('deleted_at').whereNotNull('nombre')
      .orderBy('username').limit(2).select('id', 'nombre', 'username');
    if (gente.length < 2) noMedido('la base no tiene 2 personas activas con nombre');
    const [A, B] = gente;
    const quien = (u) => ({ userId: u.id, username: u.username ?? null, escribe: null });

    // Como la API en producción; las fechas se corren como postgres (ver el encabezado).
    const comoApi = async () => { await trx.raw('SET LOCAL ROLE app_runtime'); await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]); };
    const correrFechas = async (id, sql) => {
      await trx.raw('RESET ROLE');
      await trx.raw('SET LOCAL session_replication_role = replica');
      await trx.raw(`UPDATE ${RULES} SET ${sql} WHERE id = ?`, [id]);
      await trx.raw('SET LOCAL session_replication_role = origin');
      await comoApi();
    };
    const filaDe = async (id) => (await R.leerCalendario(trx, TENANT, null)).reglas.find((r) => r.id === id);
    await comoApi();

    // ── 2 · Recién definida ──────────────────────────────────────────────────────────────────────────────────
    const creada = await R.guardarRegla(trx, TENANT, quien(A), { supplier_code: P.code, scope: 'corporate', pattern: 'weekdays', weekdays: [3] });
    const id = creada.id;
    const cal0 = await R.leerCalendario(trx, TENANT, null);
    const r0 = cal0.reglas.find((r) => r.id === id);
    check(`recién definida: «Definida por» A, sin último cambio, historial medido y vacío (el alta no se registra)`,
      r0.definida_por === A.nombre && r0.ultimo_cambio === null && Array.isArray(r0.cambios) && r0.cambios.length === 0 && r0.cambios_total === 0
      && cal0.historial?.measured === true, { def: r0.definida_por, u: r0.ultimo_cambio, c: r0.cambios, h: cal0.historial });
    // Como «Sacar del ciclo a los N» (definirOcasionales): define y saca del ciclo en la MISMA transacción.
    const enBloque = await R.guardarRegla(trx, TENANT, quien(A), { supplier_code: P2.code, scope: 'corporate', pattern: 'every_n_days', every_n_days: 180 });
    await R.fueraDeCiclo(trx, TENANT, quien(A), enBloque.id, { hasta: (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date + 182, 'YYYY-MM-DD') AS d`)).rows[0].d, motivo: 'ocasional de prueba' });
    const rB = await filaDe(enBloque.id);
    const enLog = (await trx.raw(`SELECT count(*)::int AS n FROM analytics.master_data_history WHERE tabla = ? AND pk = ?`, [RULES, enBloque.id])).rows[0].n;
    check('lo escrito en la MISMA transacción del alta es parte del alta: ni último cambio ni «Cambios» (la fila sí queda en el log)',
      rB.ultimo_cambio === null && Array.isArray(rB.cambios) && rB.cambios.length === 0 && rB.cambios_total === 0 && rB.out_of_cycle_reason === 'ocasional de prueba' && enLog === 1,
      { u: rB.ultimo_cambio, c: rB.cambios, t: rB.cambios_total, enLog });

    // ── 3 · Otra persona cambia el patrón (con el payload de la pantalla) ────────────────────────────────────
    await correrFechas(id, `created_at = created_at - interval '2 days', updated_at = updated_at - interval '2 days'`);
    const cambio = await R.guardarRegla(trx, TENANT, quien(B), { supplier_code: P.code, scope: 'corporate', pattern: 'every_n_days', every_n_days: 14, weekend_shift: 'friday' });
    const r1 = await filaDe(id);
    const c1 = r1.cambios?.[0];
    check(`B cambia el patrón: la MISMA regla (reemplazo), y nombra a las dos personas`,
      cambio.accion === 'actualizada' && cambio.id === id && r1.definida_por === A.nombre && r1.ultimo_cambio?.por === B.nombre,
      { accion: cambio.accion, def: r1.definida_por, u: r1.ultimo_cambio });
    check('el historial dice de qué a qué: weekdays [3] → cada 14 días, hecho por quien lo cambió',
      c1?.por === B.nombre && c1.campos.pattern?.antes === 'weekdays' && c1.campos.pattern?.despues === 'every_n_days'
      && JSON.stringify(c1.campos.weekdays?.antes) === '[3]' && c1.campos.weekdays?.despues === null && c1.campos.every_n_days?.despues === 14,
      c1);
    const pasos = K.historialDeLaRegla(r1, r1.cambios);
    check('el contrato reconstruye la regla entera de antes (para decir «Cada miércoles → Cada 14 días»)',
      pasos[0].antes.pattern === 'weekdays' && JSON.stringify(pasos[0].antes.weekdays) === '[3]' && pasos[0].despues.every_n_days === 14, pasos[0]);
    check('el último cambio tiene su fila en el historial (no se dice «anterior al historial»)', K.ultimoCambioSinHistorial(r1) === false, r1.ultimo_cambio);

    // ── 4 · Una tercera escritura, de A: el actor no se hereda de la anterior ───────────────────────────────────
    await correrFechas(id, `updated_at = updated_at - interval '1 day'`);
    await R.fueraDeCiclo(trx, TENANT, quien(A), id, { hasta: (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date + 30, 'YYYY-MM-DD') AS d`)).rows[0].d, motivo: 'inventario de prueba' });
    const r2 = await filaDe(id);
    check(`fuera de ciclo lo hizo A: el historial la atribuye a A (no a B, que escribió antes en la misma transacción)`,
      r2.cambios?.[0]?.por === A.nombre && r2.cambios[0].campos.out_of_cycle_until?.antes === null
      && r2.cambios[0].campos.out_of_cycle_reason?.despues === 'inventario de prueba' && r2.ultimo_cambio?.por === A.nombre,
      r2.cambios?.[0]);
    check('dos cambios, el más nuevo primero, y cuántos hay', r2.cambios_total === 2 && r2.cambios[1].por === B.nombre, { t: r2.cambios_total });

    // ── 5 · Guardar lo mismo otra vez deja su fila ─────────────────────────────────────────────────────────────
    await correrFechas(id, `updated_at = updated_at - interval '1 hour'`);
    await R.guardarRegla(trx, TENANT, quien(B), { supplier_code: P.code, scope: 'corporate', pattern: 'every_n_days', every_n_days: 14, weekend_shift: 'friday' });
    const r3 = await filaDe(id);
    const soloFecha = r3.cambios?.[0] && Object.keys(r3.cambios[0].campos);
    check('guardar el mismo patrón deja una fila con sólo updated_at (y el último cambio la tiene)',
      JSON.stringify(soloFecha) === JSON.stringify(['updated_at']) && r3.cambios[0].por === B.nombre && K.ultimoCambioSinHistorial(r3) === false,
      soloFecha);

    // ── 5b · Un usuario SIN nombre: se dice «sin nombre registrado», no «sin nombre declarado» (= fuera de la Suite) ──
    await trx.raw('RESET ROLE');
    const [sn] = await trx('identity.users').insert({ tenant_id: TENANT, username: 'pq317_prueba_sin_nombre', password_hash: 'x', nombre: null,
      role_name: 'gerente_compras', activo: true }).returning('id');
    await correrFechas(id, `updated_at = updated_at - interval '1 hour'`); // now() no avanza: sin esto no hay fila nueva
    await R.guardarRegla(trx, TENANT, quien({ id: sn.id ?? sn, username: 'pq317_prueba_sin_nombre' }), { supplier_code: P.code, scope: 'corporate', pattern: 'every_n_days', every_n_days: 14, weekend_shift: 'friday' });
    const rSn = await filaDe(id);
    check('un usuario sin nombre en identity.users sale «sin nombre registrado» (null queda SÓLO para la escritura que no dijo quién)',
      rSn.cambios?.[0]?.por === 'sin nombre registrado', rSn.cambios?.[0]?.por);

    // ── 6 · Una escritura que no declara quién ────────────────────────────────────────────────────────────────
    await trx.raw(`SELECT set_config('app.actor', '', true)`);
    await trx(RULES).where({ id }).update({ note: 'sin declarar' });
    const r4 = await filaDe(id);
    check('una escritura que no dijo quién queda con por = null (no se le atribuye a nadie)',
      r4.cambios?.[0]?.por === null && r4.cambios[0].campos.note?.despues === 'sin declarar', r4.cambios?.[0]);

    // ── 7 · La baja ──────────────────────────────────────────────────────────────────────────────────────────
    await R.darDeBaja(trx, TENANT, quien(A), id);
    const h = await R.leerCambios(trx, TENANT, [id]);
    const baja = h.por.get(id)?.cambios?.[0];
    check(`la baja queda en el historial con quién (A)`, h.measured && baja?.por === A.nombre && !!baja.campos.deleted_at?.despues, baja);

    // ── 8 · NEGATIVA: sin el disparador, se DECLARA ─────────────────────────────────────────────────────────────
    await trx.raw('RESET ROLE');
    await migHistorial.down(trx);
    await comoApi();
    const otra = await R.guardarRegla(trx, TENANT, quien(A), { supplier_code: P.code, scope: 'corporate', pattern: 'weekdays', weekdays: [1] });
    const calSin = await R.leerCalendario(trx, TENANT, null);
    const rSin = calSin.reglas.find((r) => r.id === otra.id);
    check('NEGATIVA: sin el disparador el historial se declara no medido y la regla no trae «cambios» (no «sin cambios»)',
      calSin.historial?.measured === false && /no está activo/.test(calSin.historial.note ?? '') && rSin && !('cambios' in rSin),
      { h: calSin.historial, cambios: rSin && rSin.cambios });
  } finally {
    await trx.rollback().catch(() => undefined);
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗ · ${nm} ○ NO MEDIDO`);
  if (ko) process.exit(1);
});
