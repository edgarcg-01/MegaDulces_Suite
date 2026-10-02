'use strict';
/**
 * `[MS.1.1]` — Mesa de Servicio: el schema `servicedesk` y sus CATÁLOGOS (colas, categorías, plazos y
 * ajustes). ADR-081, Fase MS (`FASE_MS_MESA_DE_SERVICIO.md`), solicitud aprobada en PR #204
 * (`FASE_MS_SOLICITUD_TABLAS_Y_ACCESOS.md`).
 *
 * ── Qué es y por qué es dato propio ──────────────────────────────────────────────────────────
 * Un ticket de servicio lo CAPTURA una persona (HITL); ninguna fuente del ERP lo tiene, así que la
 * regla «derivar del ODS» no aplica y las tablas son legítimas (mismo caso que `devtools.projects`).
 * Nada de lo de acá copia otra tabla.
 *
 * ── Cuatro tablas, y por qué cada una es una TABLA ───────────────────────────────────────────
 *  · `queues`        — las colas de atención. Hoy una (TI). Sumar Mantenimiento u otra área es una
 *                      FILA, no un rediseño ni un despliegue.
 *  · `categories`    — lo que elige quien reporta. Cada una trae su prioridad por defecto y si exige
 *                      indicar sucursal. Se edita desde pantalla.
 *  · `sla_policies`  — los plazos por prioridad. Están en TABLA para poder CALIBRARLOS sin tocar
 *                      código: `cash-count-sla` se retiró (SM.34) por estar mal calibrado, y un reloj
 *                      sin calibrar enseña a ignorar la alarma.
 *  · `settings`      — una fila por tenant: horario hábil, auto-cierre, % de aviso y el interruptor
 *                      del escalamiento, que ARRANCA APAGADO (primero el SLA mide, después escala).
 *
 * ── Unidad de los plazos ─────────────────────────────────────────────────────────────────────
 * `first_response_minutes` y `resolution_minutes` son MINUTOS **del reloj de esa política**: con
 * `clock='business'` cuentan sólo dentro del horario hábil (`settings.business_*`); con
 * `clock='calendar'` corren corridos. «Un día hábil» se siembra como **480** (8 h de trabajo), no
 * como la ventana entera de 11 h: así «1 día hábil» y «8 h hábiles» dicen lo mismo.
 *
 * ── La responsabilidad de la cola NO se siembra acá, a propósito ─────────────────────────────
 * `queues.responsibility_key` existe y apunta al catálogo de responsabilidades, pero nace NULL.
 * Hay un candado (`test-newdb-me-context.js`) que exige que TODA clave del catálogo tenga una cola
 * declarada en `me-work.ts` con su ruta. Crear la clave aquí, sin la bandeja ni la pantalla, lo
 * pondría en rojo. La clave `servicio.atender` nace en MS.3.6 junto con su bandeja.
 *
 * Aditiva e idempotente. RLS forzado + grants por tabla a `app_runtime` (NO el `DEFAULT PRIVILEGES`
 * genérico: ver `FASE_MS_SOLICITUD_TABLAS_Y_ACCESOS.md` §4.2). FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

/** Cola de arranque. `departamento` es el código de `identity.departments`; si el tenant no lo tiene, NULL. */
const COLA_TI = { code: 'ti', name: 'TI (Sistemas)', departamento: 'sistemas', orden: 10 };

/**
 * Categorías de arranque de la cola TI: las de «Sistemas» de la Bitácora de Productividad, que es la
 * referencia funcional (`CAT_SISTEMAS`). `[code, nombre, prioridad por defecto, exige sucursal, orden]`.
 * La prioridad por defecto es una SUGERENCIA: quien atiende la confirma (ADR-081 §3).
 */
const CATEGORIAS_TI = [
  ['soporte_sucursal', 'Soporte a sucursal', 'media', true, 10],
  ['base_datos', 'Base de datos', 'media', false, 20],
  ['erp_kepler', 'ERP Kepler', 'alta', false, 30],
  ['gastos_kepler', 'Elaboración de gastos Kepler', 'media', false, 40],
  ['camaras_cctv', 'Cámaras / CCTV', 'media', true, 50],
  ['redes_infraestructura', 'Redes / Infraestructura', 'alta', true, 60],
  ['inventario', 'Inventario', 'media', true, 70],
  ['respaldos', 'Respaldos', 'media', false, 80],
  ['reportes_bi', 'Reportes / Power BI', 'baja', false, 90],
  ['capacitacion', 'Capacitación', 'baja', false, 100],
  ['cedis', 'CEDIS', 'alta', false, 110],
  ['otro', 'Otro', 'media', false, 999],
];

/**
 * Plazos propuestos (ADR-081 §4; FASE_MS §2.3). **Sin calibrar**: se miden ~30 días y se ajustan.
 * `[prioridad, 1ª respuesta (min), resolución (min), reloj]`.
 */
const SLA = [
  ['urgente', 30, 240, 'calendar'], // 30 min / 4 h, corrido
  ['alta', 120, 480, 'business'], // 2 h / 1 día hábil (8 h)
  ['media', 240, 1440, 'business'], // 4 h / 3 días hábiles
  ['baja', 480, 3360, 'business'], // 1 día hábil / 7 días hábiles
];

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

/** RLS forzado + política de aislamiento + grants por tabla (lo que cada una necesita, no más). */
async function proteger(knex, tabla, privilegios) {
  await knex.raw(`ALTER TABLE servicedesk.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT ${privilegios} ON servicedesk.${tabla} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS servicedesk');
  // ⚠️ Sin USAGE del schema los GRANT de tabla no sirven: el runtime tira 42501. Ya pasó con `budget`.
  await knex.raw('GRANT USAGE ON SCHEMA servicedesk TO app_runtime');

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.queues (
      id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id           uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      code                text        NOT NULL,
      name                text        NOT NULL,
      department_code     varchar(50),
      responsibility_key  varchar(60) REFERENCES identity.responsibilities (key) ON DELETE SET NULL,
      active              boolean     NOT NULL DEFAULT true,
      sort_order          integer     NOT NULL DEFAULT 100,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT queues_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT queues_code_uk UNIQUE (tenant_id, code),
      CONSTRAINT queues_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT queues_name_ck CHECK (length(btrim(name)) > 0),
      CONSTRAINT queues_department_fk FOREIGN KEY (tenant_id, department_code)
        REFERENCES identity.departments (tenant_id, code) ON DELETE RESTRICT
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.categories (
      id                uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id         uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      queue_id          uuid        NOT NULL,
      code              text        NOT NULL,
      name              text        NOT NULL,
      default_priority  text        NOT NULL DEFAULT 'media',
      requires_branch   boolean     NOT NULL DEFAULT false,
      active            boolean     NOT NULL DEFAULT true,
      sort_order        integer     NOT NULL DEFAULT 100,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT categories_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT categories_code_uk UNIQUE (tenant_id, queue_id, code),
      CONSTRAINT categories_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT categories_name_ck CHECK (length(btrim(name)) > 0),
      CONSTRAINT categories_priority_ck CHECK (default_priority IN ('baja','media','alta','urgente')),
      CONSTRAINT categories_queue_fk FOREIGN KEY (tenant_id, queue_id)
        REFERENCES servicedesk.queues (tenant_id, id) ON DELETE RESTRICT
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.sla_policies (
      id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id               uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      priority                text        NOT NULL,
      first_response_minutes  integer     NOT NULL,
      resolution_minutes      integer     NOT NULL,
      clock                   text        NOT NULL DEFAULT 'business',
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT sla_policies_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT sla_policies_priority_uk UNIQUE (tenant_id, priority),
      CONSTRAINT sla_policies_priority_ck CHECK (priority IN ('baja','media','alta','urgente')),
      CONSTRAINT sla_policies_clock_ck CHECK (clock IN ('business','calendar')),
      CONSTRAINT sla_policies_first_ck CHECK (first_response_minutes > 0),
      CONSTRAINT sla_policies_resolution_ck CHECK (resolution_minutes > 0),
      -- Responder nunca puede tardar MÁS que resolver: un par al revés es un typo, no una política.
      CONSTRAINT sla_policies_orden_ck CHECK (first_response_minutes <= resolution_minutes)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.settings (
      tenant_id            uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      business_days        smallint[]  NOT NULL DEFAULT '{1,2,3,4,5,6}',
      business_start       time        NOT NULL DEFAULT '08:00',
      business_end         time        NOT NULL DEFAULT '19:00',
      tz                   text        NOT NULL DEFAULT 'America/Mexico_City',
      auto_close_days      integer     NOT NULL DEFAULT 3,
      escalate_at_pct      integer     NOT NULL DEFAULT 80,
      escalation_enabled   boolean     NOT NULL DEFAULT false,
      max_attachment_mb    integer     NOT NULL DEFAULT 8,
      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid,
      updated_at           timestamptz NOT NULL DEFAULT now(),
      updated_by           uuid,
      PRIMARY KEY (tenant_id),
      CONSTRAINT settings_days_ck CHECK (business_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
                                         AND cardinality(business_days) > 0),
      CONSTRAINT settings_hours_ck CHECK (business_end > business_start),
      CONSTRAINT settings_autoclose_ck CHECK (auto_close_days BETWEEN 1 AND 60),
      CONSTRAINT settings_pct_ck CHECK (escalate_at_pct BETWEEN 1 AND 100),
      CONSTRAINT settings_attach_ck CHECK (max_attachment_mb BETWEEN 1 AND 15)
    )`);

  // Lo que cada tabla necesita, no más. Los catálogos se editan desde pantalla (incluida la baja).
  await proteger(knex, 'queues', 'SELECT, INSERT, UPDATE, DELETE');
  await proteger(knex, 'categories', 'SELECT, INSERT, UPDATE, DELETE');
  await proteger(knex, 'sla_policies', 'SELECT, INSERT, UPDATE, DELETE');
  await proteger(knex, 'settings', 'SELECT, INSERT, UPDATE');

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_categories_queue ON servicedesk.categories (tenant_id, queue_id, sort_order) WHERE deleted_at IS NULL`);

  await knex.raw(`COMMENT ON TABLE servicedesk.queues IS 'MS.1.1 — colas de atención de la Mesa de Servicio (hoy TI). Sumar un área es una fila.'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.categories IS 'MS.1.1 — categorías que elige quien reporta; traen su prioridad por defecto (sugerida, la confirma quien atiende).'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.sla_policies IS 'MS.1.1 — plazos por prioridad en MINUTOS del reloj de la política (business = sólo horario hábil). Propuesta sin calibrar.'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.settings IS 'MS.1.1 — una fila por tenant. escalation_enabled arranca APAGADO: primero el SLA mide, después escala.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.responsibility_key IS 'Nace NULL a propósito: la clave servicio.atender nace en MS.3.6 con su bandeja (el candado de me-work exige cola declarada por cada clave).'`);

  // ── Siembra, por tenant ─────────────────────────────────────────────────────────────────────
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    const dept = await knex('identity.departments')
      .where({ tenant_id: tenant, code: COLA_TI.departamento })
      .whereNull('deleted_at')
      .first('code');

    await knex.raw(
      `INSERT INTO servicedesk.queues (tenant_id, code, name, department_code, sort_order)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant, COLA_TI.code, COLA_TI.name, dept ? dept.code : null, COLA_TI.orden],
    );
    const cola = await knex('servicedesk.queues').where({ tenant_id: tenant, code: COLA_TI.code }).first('id');

    for (const [code, name, prioridad, sucursal, orden] of CATEGORIAS_TI) {
      await knex.raw(
        `INSERT INTO servicedesk.categories
           (tenant_id, queue_id, code, name, default_priority, requires_branch, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, name, prioridad, sucursal, orden],
      );
    }

    for (const [prioridad, primera, resolucion, reloj] of SLA) {
      await knex.raw(
        `INSERT INTO servicedesk.sla_policies (tenant_id, priority, first_response_minutes, resolution_minutes, clock)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, priority) DO NOTHING`,
        [tenant, prioridad, primera, resolucion, reloj],
      );
    }

    await knex.raw(`INSERT INTO servicedesk.settings (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING`, [tenant]);
  }
  // eslint-disable-next-line no-console
  console.log(`  [MS.1.1] servicedesk: ${tenants.length} tenant(s) · cola TI + ${CATEGORIAS_TI.length} categorías + ${SLA.length} plazos + ajustes (escalamiento APAGADO)`);
};

exports.down = async function down(knex) {
  // El schema es NUEVO y no tiene dependientes fuera de sí mismo: se retira completo. Los tickets
  // (MS.1.2) se retiran antes, en el `down` de su propia migración.
  await knex.raw('DROP TABLE IF EXISTS servicedesk.settings');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.sla_policies');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.categories');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.queues');
};
