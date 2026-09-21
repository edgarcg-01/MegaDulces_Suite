'use strict';
/**
 * `[CDRP.2]` — **EL REGISTRO DE UMBRALES.** Contra qué se juzga cada indicador directivo.
 *
 * ── Por qué es lo PRIMERO del tablero y no un KPI ───────────────────────────────────────────
 * §13 del documento CDRP: *«No codificar umbrales dentro de la interfaz. Deben ser configurables
 * por KPI, puesto, periodo y eventualmente unidad de negocio»*. Sin esta tabla, las 12 interfaces
 * del tablero nacen cada una con su número clavado adentro — y la Fase VP ya midió a dónde lleva
 * eso: `db-health` clasificaba con `cfg ? classify : 'ok'`, o sea **verde incondicional a toda
 * fuente sin umbral registrado**. Las 3 matvistas del sell-out estuvieron verdes por no tener
 * umbral, no por estar sanas.
 *
 * ── ⛔ Se midió antes de crear la cuarta tabla de umbrales ───────────────────────────────────
 * En este repo YA hay tres registros de umbral, y ninguno sirve para KPIs de negocio:
 *
 *   · `CRON_JOBS` (`db-health.service.ts:651`) — ~36 jobs con `warnH`/`critH`/`maxRunH`. Mide
 *     FRESCURA DE FEEDS en horas, no meta de negocio, y es un **array de TypeScript**: no se edita
 *     por UI, no tiene puesto ni periodo. Queda FUERA de alcance a propósito; moverlo a tabla es
 *     su propia tarea y su pregunta es otra.
 *   · `commercial.execution_thresholds` (Horus HIQ.2/HIQ.4) — **sí es tabla**, pero es UNA FILA
 *     POR TENANT y el umbral es una COLUMNA (`score_min_pct`, `days_no_visit_max`, …). Agregar un
 *     indicador cuesta una columna y una migración; no escala a 16 KPIs × 9 puestos.
 *   · `commercial.reorder_policy` — nivel de servicio por producto×almacén. Otro grano, otro tema.
 *
 * Así que esta tabla **hereda el primitivo probado y corrige la forma**: `manual_lock` y
 * `auto_tuned_at` vienen tal cual de Horus (ADR-021: el auto-calibrador NO pisa lo que un humano
 * fijó), y el grano pasa a ser **una FILA por (kpi, puesto, periodo)**.
 *
 * ── ⛔ Nace VACÍA, y eso es la verdad, no un pendiente ───────────────────────────────────────
 * No se siembra ningún umbral porque **no existe ninguna meta**: medido el 2026-09-18, las seis
 * tablas que las guardarían (`budget.budgets`, `budget.budget_lines`, `budget.line_movements`,
 * `budget.daily_capacity`, `budget.expense_obligations`, `commercial.sales_targets`) tienen 0
 * filas. Con la tabla vacía, `clasificarKpi` devuelve `sin_meta` para todo — que es exactamente lo
 * que hoy es cierto. Sembrar un umbral inventado para «que se vea» sería el cero dibujado que
 * ADR-056 prohíbe, un nivel más arriba.
 *
 * ── Los tres números, y el CHECK que los mantiene coherentes ────────────────────────────────
 *     higher_is_better:  target ≥ warn_at ≥ escalate_at      (y al revés en lower_is_better)
 *
 * `target` = lo esperado · `warn_at` = piso del amarillo · `escalate_at` = línea que suma
 * destinatario (no cambia el color).
 *
 * ⛔ Son ABSOLUTOS y no «porcentaje de la meta», que es como lo escribe §13. Dos razones medidas:
 * (1) el porcentaje **se rompe con meta 0**, y «cartera vencida, meta 0» es un objetivo real acá;
 * (2) esconde el operando, y este proyecto ya publicó cifras falsas por no poder verlo. El riesgo
 * del absoluto —que suban la meta y olviden mover los umbrales— **no se mitiga con disciplina: se
 * impide**. El CHECK de coherencia RECHAZA la fila incoherente, así que el descuido falla ruidoso
 * en vez de dejar un semáforo callado clasificando al revés.
 *
 * ⚠️ `direction` no es adorno: sin ella, «cartera vencida» y «días de inventario» se clasifican al
 * revés, y un tablero pintaría en verde una cartera disparada.
 *
 * El clasificador vive en `libs/contracts/src/http/kpi-threshold.contract.ts` —donde SÍ hay runner
 * de pruebas (ADR-056)— con sus negativas en el spec hermano.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'kpi_thresholds';
const SCHEMA = 'analytics';
const FULL = `${SCHEMA}.${TABLA}`;

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema(SCHEMA).hasTable(TABLA);
  if (!existe) {
    await knex.schema.withSchema(SCHEMA).createTable(TABLA, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('kpi_key').notNullable();
      // NULL = aplica a todos los puestos. Una fila con puesto GANA sobre la genérica; la
      // precedencia se resuelve en `umbralPara()` y en un solo lugar (ADR-057: cuando un CASE
      // mezcla dos preguntas, la precedencia le miente a una).
      t.text('position_code').nullable();
      t.text('period').notNullable();
      t.decimal('target', 18, 4).notNullable();
      t.decimal('warn_at', 18, 4).notNullable();
      t.decimal('escalate_at', 18, 4).notNullable();
      t.text('direction').notNullable();
      t.text('escalate_to').nullable();
      // Obligatoria: un umbral sin procedencia es el mismo problema que una cifra sin procedencia.
      t.text('source').notNullable();
      t.boolean('manual_lock').notNullable().defaultTo(false);
      t.timestamp('auto_tuned_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by').nullable();
      t.timestamp('deleted_at', { useTz: true }).nullable();
      t.uuid('deleted_by').nullable();
    });
    console.log(`  [CDRP.2] ${FULL} creada`);
  } else {
    console.log(`  [CDRP.2] ${FULL} ya existe`);
  }

  const check = async (nombre, expr) => {
    const ya = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass`,
      [nombre, FULL],
    );
    if (ya.rowCount === 0) {
      await knex.raw(`ALTER TABLE ${FULL} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
      console.log(`  [CDRP.2] +CHECK ${nombre}`);
    }
  };

  await check('kpi_thr_period_valido', `period IN ('dia','semana','mes','trimestre','anio')`);
  await check(
    'kpi_thr_direction_valida',
    `direction IN ('higher_is_better','lower_is_better')`,
  );
  // Una clave y una procedencia vacías son lo mismo que no tenerlas, y pasan desapercibidas.
  await check('kpi_thr_kpi_key_no_vacia', `btrim(kpi_key) <> ''`);
  await check('kpi_thr_source_no_vacia', `btrim(source) <> ''`);
  /*
   * ⛔ EL CHECK QUE CONVIERTE UN DESCUIDO EN UN ERROR RUIDOSO.
   *
   * ⚠️ Corregido por su propia prueba: el comentario decía «subir `target`», y con
   * `higher_is_better` subir la meta la ALEJA del amarillo — no puede romper nada. El descuido
   * real es el inverso y es el que de verdad ocurre: **RECORTAR la meta** a mitad de año (un
   * presupuesto que se ajusta) y dejar el amarillo donde estaba. Ahí el amarillo queda POR ENCIMA
   * de la meta, el clasificador no puede devolver `warn` nunca, y el indicador salta de verde a
   * rojo sin etapa intermedia. Con el CHECK, ese UPDATE se rechaza y alguien se entera al hacerlo.
   */
  await check(
    'kpi_thr_umbrales_coherentes',
    `(direction = 'higher_is_better' AND target >= warn_at AND warn_at >= escalate_at)
     OR (direction = 'lower_is_better' AND target <= warn_at AND warn_at <= escalate_at)`,
  );

  /*
   * Índice único por (tenant, kpi, periodo, puesto). `COALESCE` porque en SQL dos NULL no chocan:
   * sin él se podrían crear DOS filas genéricas para el mismo KPI y `umbralPara()` tomaría
   * cualquiera de las dos — un semáforo que cambia de opinión entre recargas.
   */
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS kpi_thr_uniq
    ON ${FULL} (tenant_id, kpi_key, period, COALESCE(position_code, ''))
    WHERE deleted_at IS NULL`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS kpi_thr_lookup
    ON ${FULL} (tenant_id, kpi_key) WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE ${FULL} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${FULL} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='${SCHEMA}' AND tablename='${TABLA}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${FULL}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${FULL} TO app_runtime`);

  await knex.raw(`
    COMMENT ON TABLE ${FULL} IS
    '[CDRP.2] Contra que se juzga cada indicador directivo: una FILA por (kpi, puesto, periodo). '
    'position_code NULL = aplica a todos; la fila con puesto gana. target/warn_at/escalate_at son '
    'ABSOLUTOS (el porcentaje se rompe con meta 0, que es un objetivo real) y un CHECK impide que '
    'queden incoherentes. manual_lock + auto_tuned_at heredados de commercial.execution_thresholds '
    '(Horus HIQ.2, ADR-021): el auto-calibrador no pisa lo que un humano fijo. '
    'SIN FILA no hay semaforo: el clasificador devuelve sin_meta, nunca ok (ADR-056). '
    'Nace VACIA porque no existe ninguna meta: las 6 tablas de presupuesto tienen 0 filas (2026-09-18).'
  `);

  const n = await knex(FULL).count({ n: '*' }).first();
  console.log(
    `  [CDRP.2] ${(n && n.n) || 0} umbral(es) registrados — vacía a propósito: sin meta, ` +
      'todo indicador sale "sin_meta", que es lo que hoy es cierto',
  );
};

exports.down = async function down(knex) {
  // Tabla propia de esta fase y sin consumidores fuera de ella: se puede retirar entera.
  await knex.schema.withSchema(SCHEMA).dropTableIfExists(TABLA);
};
