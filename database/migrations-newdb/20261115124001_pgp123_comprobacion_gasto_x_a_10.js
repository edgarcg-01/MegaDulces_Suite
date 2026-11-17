'use strict';
/**
 * `[PGP.123]` G.6 — **La comprobación del gasto (X-A-10) se escribe desde la Suite: lo que guarda la Suite y el
 * interruptor.** Nada de esto escribe en Kepler. Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md`
 * §5.4 (estados, bitácora y lazo).
 *
 *  1. **El estado del X-A-10 en el vale** (`finance.expense_proofs`, ADR-056: no se inventa otra tabla): como el de la
 *     solicitud de PGP.122 (`kepler_request_*`), pero del gasto: estado, cuándo, nota, intentos, próximo intento, el
 *     folio del X-A-10, su fecha (DG1) y su póliza (`kdc2AAMM/D/<n>`).
 *  2. **La bitácora de intentos** (`finance.expense_request_kepler_attempts`) gana el TIPO de documento (15 la
 *     solicitud, 10 el gasto): no se hace otra tabla. `DEFAULT 15`: el único camino que inserta hoy (el de la
 *     solicitud, `solicitud-gasto.service.ts`) sigue igual sin tocarlo (regla 14). Y su disparo admite `validacion`
 *     (DG8: el gasto se escribe al firmar o al validar el vale).
 *  3. **El interruptor** `commercial.kepler_push_switch` admite `comprobacion_gasto`, sembrado **apagado** en las
 *     nueve sucursales con tope de **1 por día** (el canario). En 00/01/03/06/08 además lo frena DG7 en el código.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-15) ──
 *  · `kepler_push_switch_tipo_ck` = compra, traspaso, telemarketing, cliente, cancela_oc, solicitud_gasto.
 *  · `expense_request_kepler_attempts_trigger_ck` = firma, cron, reintento · 0 intentos en la bitácora.
 *  · `expense_proofs` no tiene ninguna columna `kepler_expense_*`; ningún renglón `comprobacion_gasto`.
 *
 * Los CHECK se REARMAN desde el que haya en la base (no desde una lista escrita aquí): otra fase puede haber
 * agregado un valor entre que esto se escribió y se aplicó, y una lista fija se lo borraría.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pgp123_comprobacion_gasto]';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'comprobacion_gasto';
const INTENTOS = 'expense_request_kepler_attempts';
// Los mismos de la solicitud (PGP.122), para que el servicio y la pantalla los lean igual.
// `cancelled`: Kepler canceló el X-A-10 (c43 = C); el vale vuelve a esperar su gasto y lo dice.
const ESTADOS = ['pending', 'writing', 'written', 'seen_in_ods', 'retry', 'stuck', 'rejected_by_kepler', 'in_doubt', 'cancelled'];
const lista = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
/** Los valores del CHECK `col IN (...)` tal como están en la base (pg los guarda como `= ANY (ARRAY[...])`). */
async function valoresDelCheck(knex, tabla, nombre) {
  const { rows } = await knex.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [tabla, nombre]);
  if (!rows.length) return null;
  return [...rows[0].d.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El estado del X-A-10 en el vale ───────────────────────────────────────────────────────────────────────────
  const columnas = [
    ['kepler_expense_status', (t) => t.text('kepler_expense_status')],
    ['kepler_expense_at', (t) => t.timestamp('kepler_expense_at', { useTz: true })],
    ['kepler_expense_note', (t) => t.text('kepler_expense_note')],
    ['kepler_expense_attempts', (t) => t.integer('kepler_expense_attempts').notNullable().defaultTo(0)],
    ['kepler_expense_next_at', (t) => t.timestamp('kepler_expense_next_at', { useTz: true })],
    ['kepler_expense_folio', (t) => t.text('kepler_expense_folio')],       // kdm1.c6 del X-A-10
    ['kepler_expense_date', (t) => t.date('kepler_expense_date')],         // kdm1.c9 (DG1)
    ['kepler_expense_policy', (t) => t.text('kepler_expense_policy')],     // kdc2AAMM/D/<n>
  ];
  for (const [col, def] of columnas) {
    if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', col))) {
      await knex.schema.withSchema('finance').alterTable('expense_proofs', def);
    }
  }
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_kepler_expense_status_ck`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_kepler_expense_status_ck
                    CHECK (kepler_expense_status IS NULL OR kepler_expense_status IN (${lista(ESTADOS)}))`);
  // Un gasto escrito trae su folio: sin él, el lazo no tiene qué buscar en el ODS. ⚠️ `coalesce(…, false)`: con el
  // folio NULL, `NULL ~ '…'` da NULL y un CHECK que da NULL NO falla (lo cazó la prueba negativa).
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_kepler_expense_folio_ck`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_kepler_expense_folio_ck
                    CHECK (kepler_expense_status IS NULL OR kepler_expense_status NOT IN ('written','seen_in_ods')
                           OR coalesce(kepler_expense_folio ~ '^[0-9]{7}$', false))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_proofs_kepler_gasto_pendiente
                    ON finance.expense_proofs (tenant_id, kepler_expense_next_at)
                    WHERE kepler_expense_status IN ('pending','retry','in_doubt','writing','written')`);

  // ── 2. La bitácora: el tipo de documento y el disparo de la validación ──────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable(INTENTOS))) {
    throw new Error(`${TAG} finance.${INTENTOS} no existe: falta la migración de PGP.122 (20261115003547)`);
  }
  if (!(await knex.schema.withSchema('finance').hasColumn(INTENTOS, 'document_type'))) {
    await knex.schema.withSchema('finance').alterTable(INTENTOS, (t) => t.smallint('document_type').notNullable().defaultTo(15));
  }
  await knex.raw(`ALTER TABLE finance.${INTENTOS} DROP CONSTRAINT IF EXISTS ${INTENTOS}_document_type_ck`);
  await knex.raw(`ALTER TABLE finance.${INTENTOS} ADD CONSTRAINT ${INTENTOS}_document_type_ck CHECK (document_type IN (15, 10))`);
  const disparos = (await valoresDelCheck(knex, `finance.${INTENTOS}`, `${INTENTOS}_trigger_ck`)) ?? ['firma', 'cron', 'reintento'];
  if (!disparos.includes('validacion')) {
    await knex.raw(`ALTER TABLE finance.${INTENTOS} DROP CONSTRAINT IF EXISTS ${INTENTOS}_trigger_ck`);
    await knex.raw(`ALTER TABLE finance.${INTENTOS} ADD CONSTRAINT ${INTENTOS}_trigger_ck CHECK (trigger IN (${lista([...disparos, 'validacion'])}))`);
  }

  // ── 3. El interruptor ───────────────────────────────────────────────────────────────────────────────────────────
  const tipos = await valoresDelCheck(knex, 'commercial.kepler_push_switch', 'kepler_push_switch_tipo_ck');
  if (!tipos) throw new Error(`${TAG} commercial.kepler_push_switch no tiene kepler_push_switch_tipo_ck: ¿falta la migración de PQ.20?`);
  if (!tipos.includes(TIPO)) {
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista([...tipos, TIPO])}))`);
  }
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: TIPO, encendida: false, tope_dia: 1,
      nota: '[PGP.123] La Suite escribe en Kepler el gasto (X-A-10) al validar el vale: apagada hasta la captura de prueba G.1, el ensayo verde y los GRANT; canario de 1 por día. En 00/01/03/06/08 la frena DG7 en el código',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();

  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  const { rows: [b] } = await knex.raw(`SELECT count(*)::int n, count(*) FILTER (WHERE document_type = 15)::int quince FROM finance.${INTENTOS}`);
  console.log(`  ${TAG} ${columnas.length} columnas kepler_expense_* en expense_proofs · bitácora: ${b.n} intento(s), ${b.quince} quedan como solicitud (15)`);
  console.log(`  ${TAG} disparos: ${[...disparos.filter((d) => d !== 'validacion'), 'validacion'].join(', ')} · interruptor '${TIPO}': ${sw.n} renglón(es), ${sw.encendidas} encendido(s)`);
};

/**
 * Deshace lo que hizo el `up`. Las columnas se conservan si algún vale ya tiene un gasto escrito por la Suite
 * (regla 5: no se borra lo que existe en prod); el tipo de la bitácora, si hay intentos del gasto.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: TIPO }).del();
  const tipos = (await valoresDelCheck(knex, 'commercial.kepler_push_switch', 'kepler_push_switch_tipo_ck')) ?? [];
  if (tipos.includes(TIPO)) {
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(tipos.filter((t) => t !== TIPO))}))`);
  }
  const hayIntentos = await knex.schema.withSchema('finance').hasColumn(INTENTOS, 'document_type')
    ? Number((await knex.raw(`SELECT count(*)::int n FROM finance.${INTENTOS} WHERE document_type = 10 OR trigger = 'validacion'`)).rows[0].n) : 0;
  if (hayIntentos === 0) {
    const disparos = (await valoresDelCheck(knex, `finance.${INTENTOS}`, `${INTENTOS}_trigger_ck`)) ?? [];
    if (disparos.includes('validacion')) {
      await knex.raw(`ALTER TABLE finance.${INTENTOS} DROP CONSTRAINT IF EXISTS ${INTENTOS}_trigger_ck`);
      await knex.raw(`ALTER TABLE finance.${INTENTOS} ADD CONSTRAINT ${INTENTOS}_trigger_ck CHECK (trigger IN (${lista(disparos.filter((d) => d !== 'validacion'))}))`);
    }
    await knex.raw(`ALTER TABLE finance.${INTENTOS} DROP CONSTRAINT IF EXISTS ${INTENTOS}_document_type_ck`);
    if (await knex.schema.withSchema('finance').hasColumn(INTENTOS, 'document_type')) {
      await knex.schema.withSchema('finance').alterTable(INTENTOS, (t) => t.dropColumn('document_type'));
    }
  } else {
    console.log(`  ${TAG} la bitácora tiene ${hayIntentos} intento(s) del gasto: su tipo de documento se conserva`);
  }
  await knex.raw('DROP INDEX IF EXISTS finance.ix_expense_proofs_kepler_gasto_pendiente');
  const { rows: [g] } = await knex.raw(`SELECT count(*)::int n FROM finance.expense_proofs WHERE kepler_expense_status IS NOT NULL`)
    .catch(() => ({ rows: [{ n: 0 }] }));
  if (g.n === 0) {
    await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_kepler_expense_folio_ck`);
    await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_kepler_expense_status_ck`);
    for (const col of ['kepler_expense_policy', 'kepler_expense_date', 'kepler_expense_folio', 'kepler_expense_next_at', 'kepler_expense_attempts', 'kepler_expense_note', 'kepler_expense_at', 'kepler_expense_status']) {
      if (await knex.schema.withSchema('finance').hasColumn('expense_proofs', col)) {
        await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => t.dropColumn(col));
      }
    }
  } else {
    console.log(`  ${TAG} hay ${g.n} vale(s) con estado del gasto en Kepler: las columnas se conservan`);
  }
};
