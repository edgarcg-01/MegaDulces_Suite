'use strict';
/**
 * `[MSP.0.1]` — Mesa de Servicio: las cuatro piezas que pide el área de Presupuestos y Requerimientos, construidas POR COLA (D5) para
 * que la próxima área que las necesite sea configuración. Plan: `docs/IMPLEMENTACION/FASES/FASE_MSP_PRESUPUESTOS_Y_REQUERIMIENTOS.md`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-18) ──────────────────────────────────────────────
 *  · `servicedesk.queues` no tiene cómo decir QUIÉN puede levantar, ni que la descripción es obligatoria, ni que hace falta un
 *    dictamen, ni a qué áreas se mandan órdenes. `servicedesk.requests` no tiene dictamen ni padre.
 *  · `requests.pause_reason` admite `proveedor|refaccion|aprobacion|solicitante|otro`.
 *
 * ── Qué agrega ────────────────────────────────────────────────────────────────────────────────────
 * En `queues`:
 *  · `requester_positions text[]` — los PUESTOS (`identity.users.position_code`) que pueden levantar en la cola. NULL = cualquiera (lo
 *    de siempre). Una lista vacía significaría «nadie» y es un typo: la base la rechaza.
 *  · `requires_description boolean` — la descripción deja de ser opcional en esta cola.
 *  · `requires_decision boolean` — la coordinación debe dar un DICTAMEN (autorizado / no autorizado + motivo) antes de resolver.
 *  · `work_order_queue_codes text[]` — a qué colas puede mandar ÓRDENES DE SERVICIO (solicitudes hijas) la coordinación. NULL = a
 *    ninguna. Una cola no se manda órdenes a sí misma (CHECK).
 * En `requests`:
 *  · `decision`, `decision_note`, `decided_by`, `decided_at` — el dictamen. Va COMPLETO o no va (CHECK): un «autorizado» sin quién,
 *    cuándo o por qué sería un dato que miente.
 *  · `parent_request_id` — la solicitud de la que nació esta orden de servicio. FK compuesta (mismo tenant). Nadie es su propio padre.
 *  · `pause_reason` admite `orden_servicio`: el padre ESPERA a sus órdenes (la respuesta del solicitante no lo reanuda).
 *
 * Sólo AGREGA columnas con DEFAULT/NULL y amplía un CHECK: el código anterior las ignora. Aplicala en prod ANTES de mergear.
 * Aditiva, idempotente y reversible (`down` conserva lo que ya se usa: no tira un registro).
 *
 * @param { import("knex").Knex } knex
 */

const MOTIVOS_ANTES = ['proveedor', 'refaccion', 'aprobacion', 'solicitante', 'otro'];
const MOTIVOS = [...MOTIVOS_ANTES, 'orden_servicio'];

async function existeCheck(knex, tabla, nombre) {
  const r = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = to_regclass(?)`, [nombre, `servicedesk.${tabla}`]);
  return r.rows.length > 0;
}
const tiene = (knex, tabla, col) => knex.schema.withSchema('servicedesk').hasColumn(tabla, col);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── queues ──────────────────────────────────────────────────────────────────────────────────────
  if (!(await tiene(knex, 'queues', 'requester_positions'))) await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN requester_positions text[]`);
  if (!(await tiene(knex, 'queues', 'requires_description'))) await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN requires_description boolean NOT NULL DEFAULT false`);
  if (!(await tiene(knex, 'queues', 'requires_decision'))) await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN requires_decision boolean NOT NULL DEFAULT false`);
  if (!(await tiene(knex, 'queues', 'work_order_queue_codes'))) await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN work_order_queue_codes text[]`);
  if (!(await existeCheck(knex, 'queues', 'queues_requester_positions_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.queues ADD CONSTRAINT queues_requester_positions_ck
      CHECK (requester_positions IS NULL OR (cardinality(requester_positions) >= 1 AND array_position(requester_positions, NULL) IS NULL))`);
  }
  if (!(await existeCheck(knex, 'queues', 'queues_work_order_codes_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.queues ADD CONSTRAINT queues_work_order_codes_ck
      CHECK (work_order_queue_codes IS NULL OR (cardinality(work_order_queue_codes) >= 1 AND array_position(work_order_queue_codes, NULL) IS NULL AND NOT (code = ANY (work_order_queue_codes))))`);
  }
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.requester_positions IS 'MSP.0.1 — puestos (users.position_code) que pueden levantar en esta cola. NULL = cualquiera. Se valida el puesto del TITULAR.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.requires_description IS 'MSP.0.1 — la descripción es obligatoria al levantar en esta cola.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.requires_decision IS 'MSP.0.1 — la coordinación debe dar dictamen (autorizado/no_autorizado + motivo) antes de resolver.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.work_order_queue_codes IS 'MSP.0.1 — colas (code) a las que la coordinación puede mandar órdenes de servicio (solicitudes hijas). NULL = a ninguna.'`);

  // ── requests: el dictamen ──────────────────────────────────────────────────────────────────────
  if (!(await tiene(knex, 'requests', 'decision'))) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN decision text`);
  if (!(await tiene(knex, 'requests', 'decision_note'))) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN decision_note text`);
  if (!(await tiene(knex, 'requests', 'decided_by'))) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN decided_by uuid`);
  if (!(await tiene(knex, 'requests', 'decided_at'))) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN decided_at timestamptz`);
  if (!(await existeCheck(knex, 'requests', 'requests_decision_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_decision_ck CHECK (decision IS NULL OR decision IN ('autorizado','no_autorizado'))`);
  }
  if (!(await existeCheck(knex, 'requests', 'requests_decision_complete_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_decision_complete_ck CHECK (
      (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decision_note IS NULL))`);
  }
  if (!(await existeCheck(knex, 'requests', 'requests_decision_note_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_decision_note_ck CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 5000)`);
  }
  if (!(await existeCheck(knex, 'requests', 'requests_decided_by_fk'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_decided_by_fk FOREIGN KEY (tenant_id, decided_by) REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT`);
  }

  // ── requests: la orden de servicio (hija) ──────────────────────────────────────────────────────
  if (!(await tiene(knex, 'requests', 'parent_request_id'))) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN parent_request_id uuid`);
  if (!(await existeCheck(knex, 'requests', 'requests_parent_fk'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_parent_fk FOREIGN KEY (tenant_id, parent_request_id) REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT`);
  }
  if (!(await existeCheck(knex, 'requests', 'requests_parent_not_self_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_parent_not_self_ck CHECK (parent_request_id IS NULL OR parent_request_id <> id)`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_req_parent ON servicedesk.requests (tenant_id, parent_request_id) WHERE parent_request_id IS NOT NULL`);

  // ── pause_reason admite 'orden_servicio' ───────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_pause_reason_ck`);
  await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_pause_reason_ck CHECK (pause_reason IS NULL OR pause_reason IN (${MOTIVOS.map((m) => `'${m}'`).join(',')}))`);

  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.decision IS 'MSP.0.1 — dictamen de la coordinación (autorizado|no_autorizado). Va completo con decision_note, decided_by y decided_at (CHECK).'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.parent_request_id IS 'MSP.0.1 — la solicitud de la que nació esta ORDEN DE SERVICIO (otra cola). NULL = no es una orden.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.pause_reason IS 'MS.7.5 + MSP.0.1 — por qué está en espera (proveedor|refaccion|aprobacion|solicitante|otro|orden_servicio). Sólo existe mientras status = en_espera (CHECK).'`);
};

/** Deshace lo que hizo el `up`. Lo que ya tiene datos se CONSERVA y se avisa: un dictamen o una orden ya emitidos son registro. */
exports.down = async function down(knex) {
  const usaMotivo = await knex('servicedesk.requests').where({ pause_reason: 'orden_servicio' }).count({ n: '*' }).first();
  if (Number(usaMotivo.n) === 0) {
    await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_pause_reason_ck`);
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_pause_reason_ck CHECK (pause_reason IS NULL OR pause_reason IN (${MOTIVOS_ANTES.map((m) => `'${m}'`).join(',')}))`);
  } else {
    console.log(`  [MSP.0.1] down: ${usaMotivo.n} solicitud(es) esperan una orden de servicio: se conserva el motivo`);
  }
  const conPadre = await knex('servicedesk.requests').whereNotNull('parent_request_id').count({ n: '*' }).first();
  if (Number(conPadre.n) === 0) {
    await knex.raw(`DROP INDEX IF EXISTS servicedesk.ix_sd_req_parent`);
    await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_parent_not_self_ck`);
    await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_parent_fk`);
    await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS parent_request_id`);
  } else {
    console.log(`  [MSP.0.1] down: ${conPadre.n} orden(es) de servicio ligadas: se conserva parent_request_id`);
  }
  const conDictamen = await knex('servicedesk.requests').whereNotNull('decision').count({ n: '*' }).first();
  if (Number(conDictamen.n) === 0) {
    for (const c of ['requests_decided_by_fk', 'requests_decision_note_ck', 'requests_decision_complete_ck', 'requests_decision_ck']) {
      await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS ${c}`);
    }
    for (const c of ['decided_at', 'decided_by', 'decision_note', 'decision']) await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS ${c}`);
  } else {
    console.log(`  [MSP.0.1] down: ${conDictamen.n} dictamen(es) registrados: se conservan`);
  }
  // Las columnas de `queues` son configuración: se quitan sólo si ninguna cola las usa.
  const configuradas = await knex('servicedesk.queues')
    .where((w) => w.whereNotNull('requester_positions').orWhere('requires_description', true).orWhere('requires_decision', true).orWhereNotNull('work_order_queue_codes'))
    .count({ n: '*' })
    .first();
  if (Number(configuradas.n) === 0) {
    await knex.raw(`ALTER TABLE servicedesk.queues DROP CONSTRAINT IF EXISTS queues_work_order_codes_ck`);
    await knex.raw(`ALTER TABLE servicedesk.queues DROP CONSTRAINT IF EXISTS queues_requester_positions_ck`);
    for (const c of ['work_order_queue_codes', 'requires_decision', 'requires_description', 'requester_positions']) await knex.raw(`ALTER TABLE servicedesk.queues DROP COLUMN IF EXISTS ${c}`);
  } else {
    console.log(`  [MSP.0.1] down: ${configuradas.n} cola(s) usan la configuración nueva: se conservan las columnas`);
  }
};
