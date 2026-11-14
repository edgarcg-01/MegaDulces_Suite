'use strict';
/**
 * `[MDT.1.2]` `[MDT.2.5]` — El manual por puesto, COMO DATO, sobre un motor de checklist genérico.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 * MDTask (la app aparte en Railway, Fase MDT) entrega cada día a cada puesto las tareas de los
 * Manuales Corporativos de Operación 2026. La norma vive en SU código (un catálogo de 96 KB) y las
 * entregas en otra base. Esto la trae a la Suite como dato, colgada de `identity.positions`, y deja
 * el motor en `platform` para que no haya un tercer motor de checklist (D5, ADR-056): el de
 * embarques (`logistics.shipment_checklists`, 0 filas en prod) queda como deuda con nombre para
 * pasarse a éste.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 7688376744939610156, 2026-11-13) ─────────────────
 *  · Catálogo de MDTask @3aa3297, extraído por AST sin ejecutarlo: 20 manuales, 51 tareas,
 *    391 puntos (8 con evidencia escrita; el resto pide foto por orden de Dirección del 3-sep).
 *  · 22 de los 23 puestos con manual existen en `identity.positions` (87 personas asignadas).
 *    Falta `kileadora` (MDTask la agregó el 22-sep, después del organigrama de `[AU.23]`).
 *  · `platform` existe (DP); ninguna tabla `checklist_*`.
 *
 * ── Las tablas ──────────────────────────────────────────────────────────────────────────────
 *  · `checklist_templates`          la tarea de la norma: cuándo toca (frecuencia, día, hora límite)
 *                                   y de qué documento sale. NO guarda los puntos.
 *  · `checklist_template_positions` a qué puestos les toca.
 *  · `checklist_template_versions`  los PUNTOS y la HORA LÍMITE, versionados. Registro: no se edita,
 *                                   se agrega una versión con `valid_from` y motivo. Una entrega guarda
 *                                   la versión con la que se juzgó (MDTask §5.4). La hora de la versión
 *                                   gana a la de la plantilla (MDT.3.2b).
 *  · `checklist_runs`               la ENTREGA de una persona para un periodo. ⛔ NO la crea un
 *                                   emisor (D3: ningún cron): nace cuando la persona abre la tarea.
 *                                   Lo pendiente de hoy se DERIVA de la norma al leer. Lleva
 *                                   `assigned_(to|by|at)` + `due_at`: es fuente del contrato de tarea
 *                                   (`task.contract.ts`), con `assigned_by` NULL = la asignó la norma.
 *  · `checklist_run_files`          la evidencia (fotos, documentos) en el bucket propio. Se guarda
 *                                   la llave, nunca la URL.
 *
 * ── Invariantes que hace cumplir la base ────────────────────────────────────────────────────
 *  · frecuencia semanal ⇔ día de la semana; mensual ⇔ día del mes.
 *  · `submitted` ⇔ `submitted_at` ⇔ `submitted_late` no nulo.
 *  · la versión de una entrega pertenece a SU plantilla (FK compuesta).
 *  · una entrega por plantilla, persona y periodo.
 *
 * ── Llaves (regla 20: repartidas, no sólo declaradas) ───────────────────────────────────────
 *  ⛔ PILOTO (2026-11-14): las tres llaves van SÓLO a Dirección, Recursos Humanos y superadmin.
 *     Mientras la gente siga entregando en MDTask, repartir ENTREGAR a todos haría que Mi trabajo les
 *     marque como PENDIENTE lo que sí entregaron (allá): un número falso para 87 personas. El reparto
 *     amplio va en la migración del CORTE (`[MDT.C1]`), el día que MDTask deja de recibir entregas:
 *       · ENTREGAR   → todo rol con personas (excepto customer_b2b, servicio, checador_kiosco,
 *                      verificador_precios, etiquetas_anaquel, etiquetas_tienda, sin_acceso, auditor_externo).
 *       · EQUIPO_VER → los roles cuyo puesto TIENE puestos a cargo (derivado de
 *                      `reports_to_position_code`, no elegido a mano) + Dirección.
 *  · TAREAS_PUESTO_NORMA_GESTIONAR → Dirección y Recursos Humanos: el manual «se elabora en Capital
 *                                   Humano y lo autoriza Dirección» (catálogo de MDTask). Ésta no cambia.
 *
 * La siembra va en ESTA migración (precedente DP): una que sólo inserta la clasifica NO_MEDIDO la
 * compuerta del despliegue. Aditiva e idempotente. RLS forzado. FKs compuestas `(tenant_id, …)`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SEED = require('../seeds-data/manual-puestos-mdtask.json');

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

const marcas = (xs) => xs.map(() => '?').join(',');

/** Piloto: quienes validan antes del corte (ver el encabezado). El reparto amplio es de `[MDT.C1]`. */
const PILOTO = ['direccion', 'superadmin', 'recursos_humanos'];

const LLAVES = {
  TAREAS_PUESTO_ENTREGAR: { solo: PILOTO },
  TAREAS_PUESTO_EQUIPO_VER: { solo: PILOTO },
  TAREAS_PUESTO_NORMA_GESTIONAR: { solo: PILOTO },
};

async function proteger(knex, tabla, privilegios) {
  await knex.raw(`ALTER TABLE platform.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE platform.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON platform.${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON platform.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT ${privilegios} ON platform.${tabla} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform');
  await knex.raw('GRANT USAGE ON SCHEMA platform TO app_runtime');

  // ── La tarea de la norma ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_templates (
      id                uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id         uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      key               text        NOT NULL,
      domain            text        NOT NULL,
      name              text        NOT NULL,
      moment            text,
      frequency         text        NOT NULL,
      weekday           smallint,
      month_day         smallint,
      start_time        time        NOT NULL DEFAULT '06:00',
      due_time          time        NOT NULL DEFAULT '23:00',
      per_event         boolean     NOT NULL DEFAULT false,
      document_title    text,
      document_code     text,
      document_version  text,
      document_file     text,
      format_code       text,
      note              text,
      source_key        text,
      active            boolean     NOT NULL DEFAULT true,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT checklist_templates_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_templates_key_uk UNIQUE (tenant_id, key),
      CONSTRAINT checklist_templates_key_ck CHECK (key ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$'),
      CONSTRAINT checklist_templates_domain_ck CHECK (domain IN ('manual_puesto')),
      CONSTRAINT checklist_templates_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 200),
      CONSTRAINT checklist_templates_moment_ck CHECK (moment IS NULL OR moment IN
        ('apertura','operacion','cierre','supervision','administrativo')),
      CONSTRAINT checklist_templates_frequency_ck CHECK (frequency IN
        ('daily','weekly','biweekly','monthly','event')),
      CONSTRAINT checklist_templates_weekday_ck CHECK (
        (frequency = 'weekly') = (weekday IS NOT NULL) AND (weekday IS NULL OR weekday BETWEEN 1 AND 7)),
      CONSTRAINT checklist_templates_month_day_ck CHECK (
        (frequency = 'monthly') = (month_day IS NOT NULL) AND (month_day IS NULL OR month_day BETWEEN 1 AND 31)),
      CONSTRAINT checklist_templates_window_ck CHECK (start_time < due_time)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_template_positions (
      tenant_id      uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      template_id    uuid        NOT NULL,
      position_code  text        NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      created_by     uuid,
      PRIMARY KEY (tenant_id, template_id, position_code),
      CONSTRAINT checklist_template_positions_template_fk FOREIGN KEY (tenant_id, template_id)
        REFERENCES platform.checklist_templates (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT checklist_template_positions_position_fk FOREIGN KEY (tenant_id, position_code)
        REFERENCES identity.positions (tenant_id, code) ON DELETE CASCADE
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cktpl_pos_position
                  ON platform.checklist_template_positions (tenant_id, position_code)`);

  // ── Los puntos, versionados (registro) ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_template_versions (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      template_id   uuid        NOT NULL,
      version       integer     NOT NULL,
      valid_from    date        NOT NULL,
      items         jsonb       NOT NULL,
      change_note   text        NOT NULL,
      -- La hora límite es parte de la NORMA y se versiona con ella (MDT.3.2b): cambiarla nunca reescribe lo ya
      -- juzgado. NULL = la de la plantilla (la ventana del día de MDTask, 23:00).
      due_time      time,
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid,
      PRIMARY KEY (id),
      CONSTRAINT checklist_template_versions_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_template_versions_tpl_id_uk UNIQUE (tenant_id, template_id, id),
      CONSTRAINT checklist_template_versions_version_uk UNIQUE (tenant_id, template_id, version),
      CONSTRAINT checklist_template_versions_version_ck CHECK (version >= 1),
      CONSTRAINT checklist_template_versions_items_ck CHECK (
        jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
      CONSTRAINT checklist_template_versions_note_ck CHECK (length(btrim(change_note)) > 0),
      CONSTRAINT checklist_template_versions_due_ck CHECK (due_time IS NULL OR due_time > time '00:00'),
      CONSTRAINT checklist_template_versions_template_fk FOREIGN KEY (tenant_id, template_id)
        REFERENCES platform.checklist_templates (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cktpl_ver_vigencia
                  ON platform.checklist_template_versions (tenant_id, template_id, valid_from DESC, version DESC)`);

  // ── La entrega: nace cuando la persona abre la tarea, no la crea un emisor (D3) ───────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_runs (
      id               uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id        uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      template_id      uuid        NOT NULL,
      version_id       uuid        NOT NULL,
      period_date      date        NOT NULL,
      assigned_to      uuid        NOT NULL,
      assigned_by      uuid,
      assigned_at      timestamptz NOT NULL,
      due_at           timestamptz NOT NULL,
      position_code    text,
      warehouse_code   text,
      status           text        NOT NULL DEFAULT 'in_progress',
      responses        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      employee_note    text,
      submitted_at     timestamptz,
      submitted_late   boolean,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT checklist_runs_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_runs_periodo_uk UNIQUE (tenant_id, template_id, assigned_to, period_date),
      CONSTRAINT checklist_runs_status_ck CHECK (status IN ('in_progress','submitted','cancelled')),
      CONSTRAINT checklist_runs_submitted_ck CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
      CONSTRAINT checklist_runs_late_ck CHECK ((submitted_at IS NULL) = (submitted_late IS NULL)),
      CONSTRAINT checklist_runs_responses_ck CHECK (jsonb_typeof(responses) = 'object'),
      CONSTRAINT checklist_runs_note_ck CHECK (employee_note IS NULL OR length(employee_note) <= 2000),
      CONSTRAINT checklist_runs_template_fk FOREIGN KEY (tenant_id, template_id)
        REFERENCES platform.checklist_templates (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_runs_version_fk FOREIGN KEY (tenant_id, template_id, version_id)
        REFERENCES platform.checklist_template_versions (tenant_id, template_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_runs_assigned_to_fk FOREIGN KEY (tenant_id, assigned_to)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_runs_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ckrun_persona
                  ON platform.checklist_runs (tenant_id, assigned_to, period_date DESC) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ckrun_periodo
                  ON platform.checklist_runs (tenant_id, period_date, status) WHERE deleted_at IS NULL`);

  // ── La evidencia ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_run_files (
      id             uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      run_id         uuid        NOT NULL,
      item_id        text        NOT NULL,
      storage_key    text        NOT NULL,
      mime           text        NOT NULL,
      size_bytes     integer     NOT NULL,
      original_name  text,
      captured_at    timestamptz,
      uploaded_by    uuid        NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      deleted_at     timestamptz,
      deleted_by     uuid,
      PRIMARY KEY (id),
      CONSTRAINT checklist_run_files_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_run_files_key_uk UNIQUE (tenant_id, storage_key),
      CONSTRAINT checklist_run_files_size_ck CHECK (size_bytes > 0),
      CONSTRAINT checklist_run_files_item_ck CHECK (length(item_id) BETWEEN 1 AND 40),
      CONSTRAINT checklist_run_files_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      CONSTRAINT checklist_run_files_run_fk FOREIGN KEY (tenant_id, run_id)
        REFERENCES platform.checklist_runs (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_run_files_uploaded_by_fk FOREIGN KEY (tenant_id, uploaded_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ckfile_run
                  ON platform.checklist_run_files (tenant_id, run_id, item_id) WHERE deleted_at IS NULL`);

  // Grants: la versión es registro; la entrega se edita mientras está abierta; el archivo sólo
  // se retira (soft delete) antes de entregar.
  await proteger(knex, 'checklist_templates', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'checklist_template_positions', 'SELECT, INSERT, DELETE');
  await proteger(knex, 'checklist_template_versions', 'SELECT, INSERT');
  await proteger(knex, 'checklist_runs', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'checklist_run_files', 'SELECT, INSERT, UPDATE');

  await knex.raw(`COMMENT ON TABLE platform.checklist_templates IS 'MDT.1.2 — una tarea de la norma (p. ej. el manual de un puesto): cuándo toca y de qué documento sale. Los puntos viven en checklist_template_versions. Motor genérico (D5): logistics.shipment_checklists es deuda para pasarse aquí.'`);
  await knex.raw(`COMMENT ON TABLE platform.checklist_runs IS 'MDT.1.3 — la entrega de una persona para un periodo. NO la crea un emisor (D3: ningún cron): nace cuando la persona abre la tarea; lo pendiente se deriva de la norma al leer. assigned_by NULL = la asignó la norma, no una persona. Fuente del contrato de tarea.'`);
  await knex.raw(`COMMENT ON TABLE platform.checklist_run_files IS 'MDT.2.1 — la evidencia de un punto, en el bucket privado. Se guarda storage_key, nunca la URL (se firma en cada lectura).'`);

  // ── MDT.0.6: el puesto que faltaba, y la siembra de la norma, sólo si el tenant existe ─────
  const { rows: [t] } = await knex.raw('SELECT id FROM identity.tenants WHERE id = ?', [TENANT]);
  let sembradas = 0;
  let sinPuesto = 0;
  if (t) {
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    // `kileadora` hereda lo organizacional de `anaquelista` (mismo nivel, misma sucursal) y reporta
    // a la Encargada. Sin `default_role`: MDTask no trae perfil de acceso y no se inventa ([AU.23]).
    await knex.raw(`
      INSERT INTO identity.positions
        (tenant_id, code, name, org_labels, orden, department_code, scope_axis,
         reports_to_position_code, default_complements, nivel)
      SELECT a.tenant_id, 'kileadora', 'Kileadora de Sucursal', a.org_labels, a.orden, a.department_code,
             a.scope_axis,
             (SELECT e.code FROM identity.positions e
               WHERE e.tenant_id = a.tenant_id AND e.code = 'encargado_sucursal' AND e.deleted_at IS NULL),
             a.default_complements, a.nivel
        FROM identity.positions a
       WHERE a.tenant_id = ? AND a.code = 'anaquelista' AND a.deleted_at IS NULL
      ON CONFLICT (tenant_id, code) DO NOTHING`, [TENANT]);

    for (const m of SEED.manuales) {
      for (const tarea of m.tareas) {
        const doc = tarea.own_document || { documento: m.documento, version: m.version };
        const { rows: [tpl] } = await knex.raw(`
          INSERT INTO platform.checklist_templates
            (tenant_id, key, domain, name, moment, frequency, weekday, month_day, start_time, due_time,
             per_event, document_title, document_code, document_version, document_file, format_code,
             note, source_key)
          VALUES (?, ?, 'manual_puesto', ?, ?, ?, ?, ?, ?::time, ?::time, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, key) DO NOTHING
          RETURNING id`,
        [TENANT, tarea.key, tarea.name, tarea.moment, tarea.frequency, tarea.weekday, tarea.month_day,
          SEED.ventana.inicio, tarea.due_time, tarea.per_event, doc.documento,
          tarea.own_document ? null : m.codigo, doc.version, tarea.own_document ? null : m.archivo,
          tarea.format_code, tarea.note, 'mdtask:' + tarea.source_key]);
        if (!tpl) continue; // ya estaba: idempotente, no se pisa lo que alguien haya editado
        sembradas++;
        await knex.raw(`
          INSERT INTO platform.checklist_template_versions
            (tenant_id, template_id, version, valid_from, items, change_note)
          VALUES (?, ?, 1, DATE '2026-11-13', ?::jsonb, ?)
          ON CONFLICT (tenant_id, template_id, version) DO NOTHING`,
        [TENANT, tpl.id, JSON.stringify(tarea.items),
          `Carga inicial desde MDTask (${m.documento} · ${doc.version}), catálogo @3aa3297`]);
        // A qué puestos: los del manual, o sólo los que la tarea nombra. Un puesto que no existe en
        // este tenant se salta y se cuenta: no se inventa.
        const puestos = tarea.only_positions || m.puestos;
        for (const code of puestos) {
          const { rowCount } = await knex.raw(`
            INSERT INTO platform.checklist_template_positions (tenant_id, template_id, position_code)
            SELECT ?, ?, p.code FROM identity.positions p
             WHERE p.tenant_id = ? AND p.code = ? AND p.deleted_at IS NULL
            ON CONFLICT DO NOTHING`, [TENANT, tpl.id, TENANT, code]);
          if (!rowCount) sinPuesto++;
        }
      }
    }
  }

  // ── Las tres llaves, REPARTIDAS. Tabla real `identity.role_permissions`. ─────────────────
  for (const [llave, regla] of Object.entries(LLAVES)) {
    let valor;
    let params;
    if (regla.solo) {
      valor = `role_name IN (${marcas(regla.solo)})`;
      params = regla.solo;
    } else if (regla.excepto) {
      valor = `role_name NOT IN (${marcas(regla.excepto)})`;
      params = regla.excepto;
    } else {
      valor = `(role_name IN (${regla.derivado}) OR role_name IN (${marcas(regla.ademas)}))`;
      params = regla.ademas;
    }
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, ${valor})
        WHERE permissions -> ?::text IS NULL
          AND role_name NOT LIKE 'retirado%'
          AND deleted_at IS NULL`,
      [llave, ...params, llave],
    );
    const { rows } = await knex.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`,
      [llave],
    );
    const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
    if (hay.n > 0 && !rows.length) {
      throw new Error(`Ningún rol (fuera de superadmin) quedó con ${llave}: la pantalla nacería sin dueño (regla 20)`);
    }
    // eslint-disable-next-line no-console
    console.log(`  [MDT.2.5] ${llave}: en true → ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  }

  // eslint-disable-next-line no-console
  console.log(`  [MDT.1.2] platform.checklist_*: ${sembradas} tareas sembradas de ${SEED._conteo.tareas}` +
    ` (${SEED._conteo.puntos} puntos)${sinPuesto ? ` · ${sinPuesto} enlace(s) a puesto omitidos: el puesto no existe en el tenant` : ''}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const llave of Object.keys(LLAVES)) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
      [llave, llave],
    );
  }
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_run_files');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_runs');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_template_versions');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_template_positions');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_templates');
  // El puesto sólo se retira si nadie lo ocupa: si ya tiene gente, quitarlo dejaría fichas sin puesto.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex.raw(`
    DELETE FROM identity.positions p
     WHERE p.tenant_id = ? AND p.code = 'kileadora'
       AND NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code)
       AND NOT EXISTS (SELECT 1 FROM identity.positions c WHERE c.tenant_id = p.tenant_id AND c.reports_to_position_code = p.code)`,
  [TENANT]);
};
