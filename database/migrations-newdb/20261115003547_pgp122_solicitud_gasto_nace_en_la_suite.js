'use strict';
/**
 * `[PGP.122.6]` — **La solicitud de gasto nace en la Suite: lo que guarda la Suite y el interruptor.**
 * Nada de esto escribe en Kepler. Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md`.
 *
 *  1. **El vale nace como solicitud** (`finance.expense_proofs`, ADR-056: no se inventa otra tabla):
 *     `origen` admite `solicitud` (nace SIN folio de Kepler; la firma lo escribe y le pone el folio) y se
 *     agregan las columnas de lo que la Suite captura y Kepler no guarda: el acreedor, el IVA, el
 *     documento que ampara el gasto (tipo, folio, FECHA y UUID del CFDI — DS15), la fecha en que se
 *     necesita, si es retroactiva y por qué, y el estado de su escritura en Kepler con su marca (`c26`).
 *  2. **`finance.expense_proof_lines`**: los renglones (concepto, proyecto, departamento, importe). Son la
 *     contabilidad del gasto: el X-A-10 los copia tal cual en el 99.5 %.
 *  3. **`finance.expense_request_kepler_attempts`**: un renglón por INTENTO de escribir en Kepler, sólo
 *     inserción. Es el único rastro de quién y cuándo (Kepler no guarda quién autoriza: `c30` es texto libre).
 *  4. **El interruptor** `commercial.kepler_push_switch` admite el tipo `solicitud_gasto`, sembrado
 *     **apagado** en las nueve sucursales con tope de **1 por día** (el canario, como `cancela_oc`).
 *  5. **Un vale vivo por solicitud de Kepler, en la base**: índice único (sucursal, folio) sobre los vales no
 *     rechazados. Hoy lo sostiene sólo un `pg_advisory_xact_lock` (GX.91). ⚠️ En prod hay UN par vivo
 *     duplicado (00/0008441, del 21-ago, anterior a GX.91): el índice cubre los vales desde el 1-sep y ese
 *     par queda fuera, DECLARADO — corregir ese dato es decisión de Tesorería, no de una migración.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-15) ──
 *  · `expense_proofs_origen_check` = interno, link · 2,041 vales · 1 par vivo duplicado (el de arriba).
 *  · `kepler_push_switch_tipo_ck` = compra, traspaso, telemarketing, cliente, cancela_oc.
 *
 * El CHECK del interruptor se REARMA desde el que haya en la base (no desde una lista escrita aquí): otra
 * fase puede haber agregado un tipo entre que esto se escribió y se aplicó, y una lista fija se lo borraría.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pgp122_solicitud_gasto]';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'solicitud_gasto';
const LINEAS = 'expense_proof_lines';
const INTENTOS = 'expense_request_kepler_attempts';
// `cancelled`: se rechazó en la Suite ANTES de escribirse en Kepler; ya no se escribirá (terminal).
const ESTADOS_KEPLER = ['pending', 'writing', 'written', 'seen_in_ods', 'retry', 'stuck', 'rejected_by_kepler', 'in_doubt', 'cancelled'];
const lista = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

/** Los valores del CHECK `col IN (...)` tal como están en la base (pg los guarda como `= ANY (ARRAY[...])`). */
async function valoresDelCheck(knex, tabla, nombre) {
  const { rows } = await knex.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [tabla, nombre]);
  if (!rows.length) return null;
  return [...rows[0].d.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El vale nace como solicitud ───────────────────────────────────────────────────────
  const origenes = (await valoresDelCheck(knex, 'finance.expense_proofs', 'expense_proofs_origen_check')) ?? ['interno', 'link'];
  if (!origenes.includes('solicitud')) {
    await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_origen_check`);
    await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_origen_check CHECK (origen IN (${lista([...origenes, 'solicitud'])}))`);
  }
  const columnas = [
    ['creditor_code', (t) => t.text('creditor_code')],                 // kdxd.c2
    ['vat_amount', (t) => t.decimal('vat_amount', 15, 2)],             // c14
    ['document_type', (t) => t.text('document_type')],                 // cfdi | ticket | cotizacion
    ['document_folio', (t) => t.text('document_folio')],               // c11
    ['document_date', (t) => t.date('document_date')],                 // la fecha que va en c25 (AMPARA)
    ['cfdi_uuid', (t) => t.text('cfdi_uuid')],                         // Kepler no tiene dónde guardarlo
    ['requested_on', (t) => t.date('requested_on')],                   // c9: la fecha de solicitud
    ['needed_by', (t) => t.date('needed_by')],                         // c18: la fecha de pago
    ['is_retroactive', (t) => t.boolean('is_retroactive')],
    ['date_reason', (t) => t.text('date_reason')],                     // por qué un documento viejo
    ['kepler_request_status', (t) => t.text('kepler_request_status')],
    ['kepler_request_at', (t) => t.timestamp('kepler_request_at', { useTz: true })],
    ['kepler_request_note', (t) => t.text('kepler_request_note')],
    ['kepler_request_mark', (t) => t.text('kepler_request_mark')],     // c26: SUITE SG-<8>
    ['kepler_request_attempts', (t) => t.integer('kepler_request_attempts').notNullable().defaultTo(0)],
    ['kepler_request_next_at', (t) => t.timestamp('kepler_request_next_at', { useTz: true })],
  ];
  for (const [col, def] of columnas) {
    if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', col))) {
      await knex.schema.withSchema('finance').alterTable('expense_proofs', def);
    }
  }
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_document_type_ck`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_document_type_ck CHECK (document_type IS NULL OR document_type IN ('cfdi','ticket','cotizacion'))`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_kepler_request_status_ck`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_kepler_request_status_ck CHECK (kepler_request_status IS NULL OR kepler_request_status IN (${lista(ESTADOS_KEPLER)}))`);
  // Una solicitud de la Suite trae su acreedor y su estado de escritura desde que nace (la base lo exige).
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_solicitud_ck`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_solicitud_ck
                    CHECK (origen <> 'solicitud' OR (creditor_code IS NOT NULL AND kepler_request_status IS NOT NULL AND requested_on IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_proofs_marca_kepler
                    ON finance.expense_proofs (tenant_id, kepler_request_mark) WHERE kepler_request_mark IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_proofs_kepler_pendiente
                    ON finance.expense_proofs (tenant_id, kepler_request_next_at)
                    WHERE kepler_request_status IN ('pending','retry','in_doubt')`);
  // 5. Un vale vivo por solicitud (desde el 1-sep: el par de agosto queda fuera y declarado).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_proofs_un_vale_por_solicitud
                    ON finance.expense_proofs (tenant_id, sucursal, folio_solicitud)
                    WHERE status <> 'rechazada' AND folio_solicitud IS NOT NULL AND created_at >= '2026-09-01'`);
  // 6. Una factura del SAT respalda UN solo vale vivo (la columna es nueva: en prod no hay datos que choquen).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_proofs_cfdi_uuid
                    ON finance.expense_proofs (tenant_id, lower(cfdi_uuid))
                    WHERE cfdi_uuid IS NOT NULL AND status <> 'rechazada'`);

  // ── 2. Los renglones ─────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable(LINEAS))) {
    await knex.schema.withSchema('finance').createTable(LINEAS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('proof_id').notNullable().references('id').inTable('finance.expense_proofs').onDelete('CASCADE');
      t.integer('line_no').notNullable();
      t.text('concept_code').notNullable();      // kdm6.c12 → kdco
      t.text('concept_name');                    // kdco.c2, para mostrar
      t.text('account');                         // kdco.c3 al capturar (en Kepler la pone su catálogo)
      t.text('project_code').notNullable();      // kdm6.c13 → kdcp
      t.text('department_code').notNullable();   // kdm6.c16 → kdc3
      t.decimal('amount', 15, 2).notNullable();  // kdm6.c11, SIN IVA
      t.text('prefill_source');                  // de dónde salió: cfdi | ticket | habito | persona
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
      t.unique(['proof_id', 'line_no']);
    });
  }
  await knex.raw(`ALTER TABLE finance.${LINEAS} DROP CONSTRAINT IF EXISTS ${LINEAS}_amount_ck`);
  await knex.raw(`ALTER TABLE finance.${LINEAS} ADD CONSTRAINT ${LINEAS}_amount_ck CHECK (amount > 0)`);
  await knex.raw(`ALTER TABLE finance.${LINEAS} DROP CONSTRAINT IF EXISTS ${LINEAS}_codes_ck`);
  await knex.raw(`ALTER TABLE finance.${LINEAS} ADD CONSTRAINT ${LINEAS}_codes_ck
                    CHECK (length(concept_code) BETWEEN 1 AND 10 AND length(project_code) BETWEEN 1 AND 10 AND length(department_code) BETWEEN 1 AND 10 AND line_no BETWEEN 1 AND 999)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${LINEAS}_proof ON finance.${LINEAS} (tenant_id, proof_id)`);
  await knex.raw(`ALTER TABLE finance.${LINEAS} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${LINEAS} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${LINEAS}_tenant ON finance.${LINEAS}`);
  await knex.raw(`CREATE POLICY ${LINEAS}_tenant ON finance.${LINEAS} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${LINEAS} TO app_runtime`);

  // ── 3. La bitácora de intentos (sólo inserción) ────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable(INTENTOS))) {
    await knex.schema.withSchema('finance').createTable(INTENTOS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('proof_id').notNullable().references('id').inTable('finance.expense_proofs');
      t.text('trigger').notNullable();           // firma | cron | reintento
      t.text('server').notNullable();            // sucursal (md_NN)
      t.text('mark').notNullable();              // c26
      t.text('result').notNullable();            // escrito | ya_estaba | apagado | rechazado | en_duda
      t.text('folio');
      t.boolean('retryable');
      t.text('note');
      t.jsonb('plan');                           // lo que se mandó (sin credenciales)
      t.text('plan_hash');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by');
    });
  }
  await knex.raw(`ALTER TABLE finance.${INTENTOS} DROP CONSTRAINT IF EXISTS ${INTENTOS}_result_ck`);
  await knex.raw(`ALTER TABLE finance.${INTENTOS} ADD CONSTRAINT ${INTENTOS}_result_ck CHECK (result IN ('escrito','ya_estaba','apagado','rechazado','en_duda'))`);
  await knex.raw(`ALTER TABLE finance.${INTENTOS} DROP CONSTRAINT IF EXISTS ${INTENTOS}_trigger_ck`);
  await knex.raw(`ALTER TABLE finance.${INTENTOS} ADD CONSTRAINT ${INTENTOS}_trigger_ck CHECK (trigger IN ('firma','cron','reintento'))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${INTENTOS}_proof ON finance.${INTENTOS} (tenant_id, proof_id, created_at DESC)`);
  await knex.raw(`ALTER TABLE finance.${INTENTOS} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${INTENTOS} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${INTENTOS}_tenant ON finance.${INTENTOS}`);
  await knex.raw(`CREATE POLICY ${INTENTOS}_tenant ON finance.${INTENTOS} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT ON finance.${INTENTOS} TO app_runtime`);

  // ── 4. El interruptor ────────────────────────────────────────────────────────────────────
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
      nota: '[PGP.122] La Suite escribe en Kepler la solicitud de gasto al firmarla: apagada hasta la captura de prueba, el ensayo verde y los GRANT; canario de 1 por día',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  const { rows: [dup] } = await knex.raw(
    `SELECT count(*)::int n FROM (SELECT 1 FROM finance.expense_proofs WHERE status <> 'rechazada' AND folio_solicitud IS NOT NULL
       GROUP BY tenant_id, sucursal, folio_solicitud HAVING count(*) > 1) x`);
  console.log(`  ${TAG} origen admite 'solicitud' · ${columnas.length} columnas · ${LINEAS} · ${INTENTOS}`);
  console.log(`  ${TAG} interruptor '${TIPO}': ${sw.n} renglón(es), ${sw.encendidas} encendido(s) · tipos: ${[...tipos.filter((t) => t !== TIPO), TIPO].join(', ')}`);
  console.log(`  ${TAG} vales vivos duplicados por (sucursal, folio), fuera del índice: ${dup.n} (en prod se esperaba 1: 00/0008441, de agosto)`);
};

/**
 * Deshace lo que hizo el `up`. Las tablas y columnas se conservan si ya tienen datos (regla 5: no se borra
 * lo que existe en prod); el CHECK de origen sólo vuelve si ningún vale es `solicitud`.
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
  await knex.raw('DROP INDEX IF EXISTS finance.ux_expense_proofs_cfdi_uuid');
  await knex.raw('DROP INDEX IF EXISTS finance.ux_expense_proofs_un_vale_por_solicitud');
  await knex.raw('DROP INDEX IF EXISTS finance.ix_expense_proofs_kepler_pendiente');
  await knex.raw('DROP INDEX IF EXISTS finance.ux_expense_proofs_marca_kepler');
  for (const t of [INTENTOS, LINEAS]) {
    const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM finance.${t}`).catch(() => ({ rows: [{ n: 0 }] }));
    if (n.n === 0) await knex.raw(`DROP TABLE IF EXISTS finance.${t}`);
    else console.log(`  ${TAG} finance.${t} tiene ${n.n} renglón(es): se conserva`);
  }
  const { rows: [s] } = await knex.raw(`SELECT count(*)::int n FROM finance.expense_proofs WHERE origen = 'solicitud'`);
  if (s.n === 0) {
    await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_solicitud_ck`);
    await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_origen_check`);
    await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_origen_check CHECK (origen IN ('interno','link'))`);
  } else {
    console.log(`  ${TAG} hay ${s.n} vale(s) de origen 'solicitud': el CHECK de origen y las columnas se conservan`);
  }
};
