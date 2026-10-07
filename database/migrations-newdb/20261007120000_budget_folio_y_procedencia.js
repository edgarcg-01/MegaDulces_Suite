'use strict';
/**
 * `[VE.5]` — **El ejercicio tiene FOLIO, y cada generación deja PROCEDENCIA.** Opciones A y D del
 * pedido de Edgar (2026-10-07): *«hay que automatizar el proceso […] todo valor manual es posible
 * error, cada que se genere uno se le puede asignar un folio»*.
 *
 * ── La evidencia está en los propios datos de prod ──────────────────────────────────────────
 *
 * Los dos únicos ejercicios que existen muestran los dos errores que esto cierra:
 *
 *     name        fiscal_year  status      plan_ventas  plan_gastos  partidas
 *     prueba      2026         pendiente             0            0         0   ← firmado a medias, VACÍO
 *     presupesto  2027         borrador            418            0         0   ← el nombre es un typo
 *
 * `presupesto` es texto libre tecleado una vez y queda para siempre como el identificador que todos
 * ven. Un folio no se teclea.
 *
 * ── Las DOS piezas, y por qué van juntas ────────────────────────────────────────────────────
 *
 * **1. `budgets.folio`** (`PRE-2027-001`) — identidad del ejercicio, generada, única por tenant. El
 * `name` se conserva: sigue sirviendo para que una persona lo reconozca, pero deja de ser lo que lo
 * identifica.
 *
 * **2. `budget.generation_runs`** — qué hizo cada corrida del piloto: con qué **supuestos** calculó,
 * qué **celdas** escribió y en qué paso, y si falló. ⭐ Esta es la que de verdad importa, y es la
 * respuesta a una objeción que el propio pedido tiene adentro: *«todo valor manual es posible
 * error»* es cierto, **pero un valor derivado también puede estar mal — y es peor, porque nadie lo
 * revisa**. Sin saber con qué se calculó un número, automatizarlo sólo cambia quién se equivoca
 * (ADR-056; es el mismo primitivo que la Fase VP midió en 4 de 171 endpoints).
 *
 * Con esto, «¿por qué la meta de P7 cambió entre ayer y hoy?» tiene respuesta: la corrida
 * `GEN-20261007-001` usó crecimiento 8.4 % y la de hoy 6.1 %, porque el histórico se movió.
 *
 * ── El folio NO se calcula con max()+1 ──────────────────────────────────────────────────────
 *
 * ⚠️ Dos corridas simultáneas con `max()+1` sacan el mismo número. Se usa la tabla de secuencia con
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, que es atómico — el mismo patrón que
 * `commercial.expiry_folio_sequences` y `commercial.order_sequences` ya usan en este repo.
 *
 * ⚠️ `budgets.folio` nace NULLABLE y se rellena: hay 2 ejercicios vivos y ponerlo NOT NULL de
 * entrada rompería el INSERT de cualquier código viejo que todavía no lo manda. Los existentes se
 * backfillean acá con su propio folio, por orden de creación.
 */

exports.up = async function up(knex) {
  // ── 1. Secuencia de folio ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budget.folio_sequences (
      tenant_id     uuid    NOT NULL,
      kind          text    NOT NULL,
      period        text    NOT NULL,
      current_value integer NOT NULL DEFAULT 0,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, kind, period),
      CONSTRAINT folio_sequences_kind_chk CHECK (kind IN ('ejercicio', 'generacion'))
    )`);
  await knex.raw(`ALTER TABLE budget.folio_sequences ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE budget.folio_sequences FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname='budget' AND tablename='folio_sequences' AND policyname='folio_sequences_tenant') THEN
        CREATE POLICY folio_sequences_tenant ON budget.folio_sequences
          USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON budget.folio_sequences TO app_runtime`);

  // ── 2. El folio del ejercicio ────────────────────────────────────────────────────────────
  const tieneFolio = await knex.schema.withSchema('budget').hasColumn('budgets', 'folio');
  if (!tieneFolio) {
    await knex.raw(`ALTER TABLE budget.budgets ADD COLUMN folio text`);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_budgets_folio
        ON budget.budgets (tenant_id, folio) WHERE folio IS NOT NULL`);

    // Backfill de los que ya existen: su folio sale del año fiscal y del orden de creación, que
    // es información que ya está en la fila — no se inventa nada.
    await knex.raw(`
      WITH num AS (
        SELECT id, tenant_id, fiscal_year,
               row_number() OVER (PARTITION BY tenant_id, fiscal_year ORDER BY created_at) AS n
          FROM budget.budgets WHERE folio IS NULL)
      UPDATE budget.budgets b
         SET folio = 'PRE-' || num.fiscal_year || '-' || lpad(num.n::text, 3, '0')
        FROM num WHERE num.id = b.id`);

    // Y la secuencia arranca donde quedó el backfill, o el próximo folio repetiría uno.
    await knex.raw(`
      INSERT INTO budget.folio_sequences (tenant_id, kind, period, current_value)
      SELECT tenant_id, 'ejercicio', fiscal_year::text, count(*)
        FROM budget.budgets WHERE folio IS NOT NULL
       GROUP BY tenant_id, fiscal_year
      ON CONFLICT (tenant_id, kind, period) DO UPDATE
        SET current_value = GREATEST(budget.folio_sequences.current_value, EXCLUDED.current_value)`);
  }

  // ── 3. La procedencia de cada corrida ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budget.generation_runs (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL,
      folio       text        NOT NULL,
      budget_id   uuid,
      kind        text        NOT NULL,
      trigger     text        NOT NULL,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status      text        NOT NULL DEFAULT 'running',
      -- CON QUÉ se calculó: los supuestos vigentes en el momento de la corrida. Sin esto, un
      -- número que cambió de un día para el otro no tiene explicación.
      assumptions jsonb,
      -- QUÉ entregó, por paso. Un objeto, no un total: «escribió 418 celdas» no dice si el plan
      -- de gastos corrió.
      output      jsonb,
      error       text,
      created_by  text,
      PRIMARY KEY (tenant_id, id),
      CONSTRAINT generation_runs_folio_uq UNIQUE (tenant_id, folio),
      CONSTRAINT generation_runs_kind_chk CHECK (kind IN ('ejercicio', 'plan_ventas', 'plan_gastos', 'targets', 'partidas', 'obligaciones', 'pasada')),
      CONSTRAINT generation_runs_trigger_chk CHECK (trigger IN ('cron', 'manual')),
      CONSTRAINT generation_runs_status_chk CHECK (status IN ('running', 'ok', 'error'))
    )`);
  await knex.raw(`ALTER TABLE budget.generation_runs ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE budget.generation_runs FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname='budget' AND tablename='generation_runs' AND policyname='generation_runs_tenant') THEN
        CREATE POLICY generation_runs_tenant ON budget.generation_runs
          USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON budget.generation_runs TO app_runtime`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_generation_runs_budget
      ON budget.generation_runs (tenant_id, budget_id, started_at DESC)`);

  await knex.raw(`
    COMMENT ON TABLE budget.generation_runs IS
      'Procedencia de cada generacion del presupuesto: con que supuestos se calculo, que escribio '
      'por paso y si fallo. Existe porque un valor DERIVADO tambien puede estar mal, y es peor que '
      'uno capturado porque nadie lo revisa: sin saber con que se calculo un numero, automatizarlo '
      'solo cambia quien se equivoca (ADR-056). Candado: test-newdb-budget-autopilot.js'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS budget.generation_runs`);
  await knex.raw(`DROP INDEX IF EXISTS budget.ux_budgets_folio`);
  const tiene = await knex.schema.withSchema('budget').hasColumn('budgets', 'folio');
  if (tiene) await knex.raw(`ALTER TABLE budget.budgets DROP COLUMN folio`);
  await knex.raw(`DROP TABLE IF EXISTS budget.folio_sequences`);
};
