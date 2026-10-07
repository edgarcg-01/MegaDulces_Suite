'use strict';
/**
 * `[MS.7.5]` — La base de tres capacidades que construyen MS.7.9, 7.10 y 7.11. `FASE_MS7_MANTENIMIENTO.md` (decisiones M3, M6, M9).
 *
 * Sólo AMPLÍA: cada CHECK nuevo acepta todo lo que ya existe (un ticket sin motivo de pausa, una regla con categoría o palabras, un
 * mensaje de los seis tipos de siempre).
 *
 * ── Qué agrega ────────────────────────────────────────────────────────────────────────────────
 * · `requests.pause_reason` — POR QUÉ está en espera (`proveedor`, `refaccion`, `aprobacion`, `solicitante`, `otro`). Sin estado
 *   nuevo (M3): «esperando refacción» es `en_espera` + motivo, y `en_espera` ya pausa el reloj del SLA. La base exige que el motivo
 *   sólo exista MIENTRAS el ticket está en espera (como ya exige que `en_espera` ⇔ reloj pausado): un motivo huérfano de una pausa
 *   que ya terminó sería un dato que miente.
 * · `routing_rules.warehouse_code` — la regla de asignación puede dispararse por UBICACIÓN (además de categoría o palabras). El
 *   disparador deja de ser «categoría o palabras» y pasa a «categoría, palabras o ubicación»: una regla sin ninguno sigue siendo un
 *   typo y la base lo rechaza.
 * · `request_messages.kind = 'transfer'` — el historial de transferencias entre colas es un mensaje de SISTEMA del hilo (de→a, quién,
 *   por qué), no una tabla nueva: el hilo ya es un registro sin UPDATE/DELETE.
 *
 * Aditiva, idempotente y reversible. `down` conserva lo ensanchado si ya hay datos que lo usan (no se tira un registro).
 *
 * @param { import("knex").Knex } knex
 */
const MOTIVOS = ['proveedor', 'refaccion', 'aprobacion', 'solicitante', 'otro'];

async function existeCheck(knex, tabla, nombre) {
  const r = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = to_regclass(?)`,
    [nombre, `servicedesk.${tabla}`],
  );
  return r.rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  // ── requests.pause_reason ───────────────────────────────────────────────────────────────
  const tieneMotivo = await knex.schema.withSchema('servicedesk').hasColumn('requests', 'pause_reason');
  if (!tieneMotivo) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN pause_reason text`);
  if (!(await existeCheck(knex, 'requests', 'requests_pause_reason_ck'))) {
    const lista = MOTIVOS.map((m) => `'${m}'`).join(',');
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_pause_reason_ck CHECK (pause_reason IS NULL OR pause_reason IN (${lista}))`);
  }
  if (!(await existeCheck(knex, 'requests', 'requests_pause_reason_state_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_pause_reason_state_ck CHECK (pause_reason IS NULL OR status = 'en_espera')`);
  }
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.pause_reason IS 'MS.7.5 — por qué está en espera (proveedor|refaccion|aprobacion|solicitante|otro). Sólo existe mientras status = en_espera (CHECK). NULL = sin motivo / no está en espera.'`);

  // ── routing_rules.warehouse_code + disparador ampliado ──────────────────────────────────
  const tieneUbic = await knex.schema.withSchema('servicedesk').hasColumn('routing_rules', 'warehouse_code');
  if (!tieneUbic) await knex.raw(`ALTER TABLE servicedesk.routing_rules ADD COLUMN warehouse_code varchar(20)`);
  await knex.raw(`ALTER TABLE servicedesk.routing_rules DROP CONSTRAINT IF EXISTS routing_rules_trigger_ck`);
  await knex.raw(`
    ALTER TABLE servicedesk.routing_rules ADD CONSTRAINT routing_rules_trigger_ck
      CHECK (category_id IS NOT NULL OR cardinality(keywords) > 0 OR warehouse_code IS NOT NULL)`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.routing_rules.warehouse_code IS 'MS.7.5 — la regla también puede dispararse por ubicación (código de sucursal o ubicación extra). NULL = no mira la ubicación.'`);

  // ── request_messages.kind admite 'transfer' ─────────────────────────────────────────────
  await knex.raw(`ALTER TABLE servicedesk.request_messages DROP CONSTRAINT IF EXISTS request_messages_kind_ck`);
  await knex.raw(`
    ALTER TABLE servicedesk.request_messages ADD CONSTRAINT request_messages_kind_ck
      CHECK (kind IN ('comment','status','assignment','priority','system','internal_note','transfer'))`);

  // eslint-disable-next-line no-console
  console.log(`  [MS.7.5] requests.pause_reason ${tieneMotivo ? 'ya existía' : 'agregada'} · routing_rules.warehouse_code ${tieneUbic ? 'ya existía' : 'agregada'} · kind='transfer' admitido`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_pause_reason_state_ck`);
  await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_pause_reason_ck`);
  await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS pause_reason`);

  // Una regla sólo por ubicación ya no cumpliría el CHECK de antes: se conserva el ensanchado si existe alguna.
  const soloUbic = await knex('servicedesk.routing_rules').whereNotNull('warehouse_code').whereNull('category_id').whereRaw('cardinality(keywords) = 0').count({ n: '*' }).first();
  if (Number(soloUbic.n) === 0) {
    await knex.raw(`ALTER TABLE servicedesk.routing_rules DROP CONSTRAINT IF EXISTS routing_rules_trigger_ck`);
    await knex.raw(`ALTER TABLE servicedesk.routing_rules ADD CONSTRAINT routing_rules_trigger_ck CHECK (category_id IS NOT NULL OR cardinality(keywords) > 0)`);
    await knex.raw(`ALTER TABLE servicedesk.routing_rules DROP COLUMN IF EXISTS warehouse_code`);
  }

  // Un mensaje de traslado es un REGISTRO: no se borra para poder volver atrás; se conserva el CHECK ensanchado.
  const trasl = await knex('servicedesk.request_messages').where({ kind: 'transfer' }).count({ n: '*' }).first();
  if (Number(trasl.n) === 0) {
    await knex.raw(`ALTER TABLE servicedesk.request_messages DROP CONSTRAINT IF EXISTS request_messages_kind_ck`);
    await knex.raw(`ALTER TABLE servicedesk.request_messages ADD CONSTRAINT request_messages_kind_ck CHECK (kind IN ('comment','status','assignment','priority','system','internal_note'))`);
  }
};
