'use strict';
/**
 * `[MSH.1]` — La BASE de la cola confidencial de RH. `FASE_MSH_MESA_DE_SERVICIO_HUMANOS.md` §4 (decisiones R1, R4 y R5).
 *
 * Sólo base de datos: ninguna cola es confidencial todavía (la siembra de RH es MSH.4), así que TI y Mantenimiento quedan EXACTAMENTE
 * como están. Lo que esta migración deja es lo que ninguna regla de código puede garantizar por sí sola: que la marca no se falsifique.
 *
 * ── Qué agrega ────────────────────────────────────────────────────────────────────────────────
 * · `queues.confidential` (R1) — la cola confidencial. Una cola con la marca habilita el flujo confidencial.
 * · `queues.uses_priority` / `queues.sla_enabled` (R5) — una cola puede NO usar prioridad ni SLA (RH v1: «—», nunca 0). Aquí sólo existen
 *   las columnas, con el valor de siempre (`true`); lo que hacen con ellas el barrido del SLA y la pantalla es MSH.2/MSH.3.
 * · `queues.report_min_cases` (R4) — el mínimo de casos para mostrar un agregado de la cola (por debajo, «—»). Propuesta inicial: 5.
 * · `requests.confidential` — la marca del TICKET.
 *
 * ── Las tres defensas de la base (R1: «una regla de código no basta») ─────────────────────────
 * `app_runtime` tiene UPDATE sobre `requests` y `queues`: sin esto, un bug o una consulta a mano podría quitarle la marca a un ticket
 * confidencial o sacarlo a una cola que ve TI.
 *  1. **`BEFORE INSERT` en `requests`:** la marca del ticket se COPIA de su cola y no se puede falsificar — ni declarar un ticket
 *     confidencial en una cola que no lo es, ni al revés. El cliente no decide.
 *  2. **`BEFORE UPDATE OF confidential, queue_id` en `requests`:** la marca no cambia NUNCA, y un ticket sólo se mueve a una cola de la
 *     MISMA clase. Es más fuerte que el plan (que prohibía salir de confidencial a no confidencial): también se rechaza el sentido
 *     contrario, porque meter un ticket «normal» en una cola confidencial lo dejaría con la marca equivocada. Invariante:
 *     `requests.confidential = queues.confidential` de su cola, siempre. (Confidencial → OTRA confidencial se permite a nivel de base;
 *     quién puede, es regla de MSH.2: R3 dice sólo coordinación hacia coordinación.)
 *  3. **`BEFORE UPDATE OF confidential` en `queues`:** la marca de una cola con tickets no se cambia. Sin esto, apagar la marca de la cola
 *     dejaría tickets confidenciales dentro de una cola «normal» (y encenderla, tickets normales dentro de una confidencial).
 *     Una cola SIN tickets sí se puede ajustar (es lo que hace la siembra). Cuenta TODOS los tickets, también los dados de baja.
 *
 * Los triggers son `SECURITY INVOKER` a propósito: leen `queues` con el RLS de quien escribe (mismo tenant), no con privilegios ajenos.
 * Se disparan sólo con `UPDATE OF <columnas>`: el resto de los UPDATE de `requests` (estado, asignación, SLA…) no pagan nada.
 *
 * Aditiva, idempotente y reversible. `down` se NIEGA si ya hay una cola o un ticket confidencial: borrar la columna les quitaría la
 * marca en silencio, que es justo el fallo que esto previene.
 *
 * @param { import("knex").Knex } knex
 */
const MSG_CAMBIO = 'La marca de confidencial de una solicitud no se cambia (se fija desde su cola al crearla)';
const MSG_MOVER = 'Una solicitud sólo se mueve a una cola de su misma clase: confidencial con confidencial, normal con normal';
const MSG_COLA = 'La marca de confidencial de una cola con solicitudes no se cambia: dejaría solicitudes en una cola de otra clase';

async function existeCheck(knex, tabla, nombre) {
  const r = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = to_regclass(?)`, [nombre, `servicedesk.${tabla}`]);
  return r.rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  // Un constructor de esquema de knex es de UN solo uso: se crea nuevo en cada consulta.
  const tiene = (tabla, col) => knex.schema.withSchema('servicedesk').hasColumn(tabla, col);

  // ── queues ─────────────────────────────────────────────────────────────────────────────────
  const cols = {
    confidential: `boolean NOT NULL DEFAULT false`,
    uses_priority: `boolean NOT NULL DEFAULT true`,
    sla_enabled: `boolean NOT NULL DEFAULT true`,
    report_min_cases: `integer NOT NULL DEFAULT 5`,
  };
  const nuevas = [];
  for (const [c, def] of Object.entries(cols)) {
    if (!(await tiene('queues', c))) {
      await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN ${c} ${def}`);
      nuevas.push(`queues.${c}`);
    }
  }
  if (!(await existeCheck(knex, 'queues', 'queues_report_min_cases_ck'))) {
    await knex.raw(`ALTER TABLE servicedesk.queues ADD CONSTRAINT queues_report_min_cases_ck CHECK (report_min_cases >= 1)`);
  }

  // ── requests ───────────────────────────────────────────────────────────────────────────────
  if (!(await tiene('requests', 'confidential'))) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN confidential boolean NOT NULL DEFAULT false`);
    nuevas.push('requests.confidential');
  }

  // ── 1. INSERT: la marca se copia de la cola ────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION servicedesk.requests_fija_confidencial() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE v boolean;
    BEGIN
      SELECT q.confidential INTO v FROM servicedesk.queues q WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.queue_id;
      -- Cola inexistente: que lo rechace la FK compuesta con su propio mensaje.
      IF v IS NOT NULL THEN NEW.confidential := v; END IF;
      RETURN NEW;
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_requests_fija_confidencial ON servicedesk.requests`);
  await knex.raw(`
    CREATE TRIGGER trg_requests_fija_confidencial BEFORE INSERT ON servicedesk.requests
      FOR EACH ROW EXECUTE FUNCTION servicedesk.requests_fija_confidencial()`);

  // ── 2. UPDATE: la marca no cambia y el ticket sólo se mueve entre colas de su misma clase ──
  await knex.raw(`
    CREATE OR REPLACE FUNCTION servicedesk.requests_protege_confidencial() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE v boolean;
    BEGIN
      IF NEW.confidential IS DISTINCT FROM OLD.confidential THEN
        RAISE EXCEPTION '${MSG_CAMBIO}' USING ERRCODE = '23514';
      END IF;
      IF NEW.queue_id IS DISTINCT FROM OLD.queue_id THEN
        SELECT q.confidential INTO v FROM servicedesk.queues q WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.queue_id;
        IF v IS NOT NULL AND v <> OLD.confidential THEN
          RAISE EXCEPTION '${MSG_MOVER}' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_requests_protege_confidencial ON servicedesk.requests`);
  await knex.raw(`
    CREATE TRIGGER trg_requests_protege_confidencial BEFORE UPDATE OF confidential, queue_id ON servicedesk.requests
      FOR EACH ROW EXECUTE FUNCTION servicedesk.requests_protege_confidencial()`);

  // ── 3. La marca de una COLA con tickets no se cambia ───────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION servicedesk.queues_protege_confidencial() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.confidential IS DISTINCT FROM OLD.confidential
         AND EXISTS (SELECT 1 FROM servicedesk.requests r WHERE r.tenant_id = OLD.tenant_id AND r.queue_id = OLD.id) THEN
        RAISE EXCEPTION '${MSG_COLA}' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_queues_protege_confidencial ON servicedesk.queues`);
  await knex.raw(`
    CREATE TRIGGER trg_queues_protege_confidencial BEFORE UPDATE OF confidential ON servicedesk.queues
      FOR EACH ROW EXECUTE FUNCTION servicedesk.queues_protege_confidencial()`);

  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.confidential IS 'MSH.1 — cola confidencial (RH). Los tickets que se levanten en ella nacen confidenciales. No se cambia si la cola ya tiene tickets (trigger).'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.uses_priority IS 'MSH.1 — false = la cola no usa prioridad (RH v1). La base conserva un valor neutro interno; la API no lo publica (MSH.2).'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.sla_enabled IS 'MSH.1 — false = la cola no mide SLA (RH v1): se declara «—», nunca 0 (MSH.2).'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.report_min_cases IS 'MSH.1 — mínimo de casos para mostrar un agregado de esta cola; por debajo, «—». Propuesta R4: 5.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.confidential IS 'MSH.1 — marca del ticket. La FIJA la base al crearlo (copia la de su cola) y no cambia nunca; el ticket sólo se mueve a colas de su misma clase (triggers).'`);

  // eslint-disable-next-line no-console
  console.log(`  [MSH.1] columnas nuevas: ${nuevas.length ? nuevas.join(', ') : 'ninguna (ya existían)'} · 3 triggers de la marca confidencial`);
};

exports.down = async function down(knex) {
  // Borrar la columna les quitaría la marca en silencio a lo que ya sea confidencial: justo lo que esto existe para impedir.
  const colas = await knex('servicedesk.queues').where({ confidential: true }).count({ n: '*' }).first();
  const tickets = await knex('servicedesk.requests').where({ confidential: true }).count({ n: '*' }).first();
  if (Number(colas.n) > 0 || Number(tickets.n) > 0) {
    throw new Error(`MSH.1 down se NIEGA: hay ${colas.n} cola(s) y ${tickets.n} solicitud(es) confidenciales; borrar la columna les quitaría la marca en silencio`);
  }
  await knex.raw(`DROP TRIGGER IF EXISTS trg_queues_protege_confidencial ON servicedesk.queues`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_requests_protege_confidencial ON servicedesk.requests`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_requests_fija_confidencial ON servicedesk.requests`);
  await knex.raw(`DROP FUNCTION IF EXISTS servicedesk.queues_protege_confidencial()`);
  await knex.raw(`DROP FUNCTION IF EXISTS servicedesk.requests_protege_confidencial()`);
  await knex.raw(`DROP FUNCTION IF EXISTS servicedesk.requests_fija_confidencial()`);
  await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS confidential`);
  await knex.raw(`ALTER TABLE servicedesk.queues DROP CONSTRAINT IF EXISTS queues_report_min_cases_ck`);
  for (const c of ['report_min_cases', 'sla_enabled', 'uses_priority', 'confidential']) {
    await knex.raw(`ALTER TABLE servicedesk.queues DROP COLUMN IF EXISTS ${c}`);
  }
};
