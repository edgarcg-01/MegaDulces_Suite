'use strict';
/**
 * `[DP.0.1]` `[DP.0.2]` — Definiciones de negocio: **la pregunta vive en el sistema**.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 * El 2026-11-03 Lupita Sánchez pidió cuatro cosas para las comisiones de Ruta Directa y ninguna se
 * puede construir sin reglas que sólo el negocio conoce. Esas reglas iban a preguntarse por
 * WhatsApp; Edgar: *«hoy las preguntas hay que hacerlas en un sistema configurable»*. Una respuesta
 * de chat no tiene autor, fecha ni vigencia, y el motor no puede declarar «sin definir» de algo que
 * no sabe que existe.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 7688376744939610156, 2026-11-03) ─────────────────
 *  · Rutas vecinales: **$2.2M de venta en 30 días** sin comisión configurada (VERDAD_ABSOLUTA §32.5);
 *    321 + 322: **$846,189.75 desde el 2026-09-08**.
 *  · `hr.attendance_logs` = 0 · `hr.attendance_days` = 0 · `hr.attendance_incidents` = 0.
 *  · `kepler_ods.kdud` `RD001` «COBRO FALTANTE INVENTARIO» en las 9 sucursales, 0 documentos en
 *    `kdm1` (c10…c15, c85) y 0 en `kdue`.
 *  · Ningún primitivo de «pendiente de definir» en el repo; «Mi trabajo» publica P-01 · P-11 a mano.
 *
 * ── Dos tablas ──────────────────────────────────────────────────────────────────────────────
 *  · `business_definitions` — la PREGUNTA: qué se pregunta, qué decide, de qué tipo es la
 *    respuesta, quién la contesta y en qué estado está. Lleva `assigned_(to|by|at)` + `due_at`:
 *    es una TAREA de su dueño y por eso se declara en `task.contract.ts` (DP.1.2) —
 *    `test-newdb-task-contract.js` falla si aparece sin declarar.
 *  · `business_definition_answers` — las RESPUESTAS, con `valid_from` y motivo obligatorio. Es
 *    registro: `app_runtime` no tiene UPDATE ni DELETE. Contestar otra vez no pisa: agrega una
 *    vigencia (D3), igual que el tabulador, para que una quincena vieja se recalcule con la regla
 *    que regía entonces.
 *
 * ── Invariantes que hace cumplir la base ────────────────────────────────────────────────────
 *  · `respondida` ⇔ `answered_at`; `respondida` ⇒ `answered_by`.
 *  · `descartada` ⇔ `discarded_at`; `descartada` ⇒ motivo no vacío.
 *  · `assigned_to` y `assigned_at` van juntos.
 *  · `choice`/`choices` ⇔ hay `choices` (arreglo); `config_ref` ⇔ hay `config_route`.
 *  · `suggested_value` y `suggested_source` van juntos: una propuesta sin fuente no se puede citar.
 *  ⚠️ Que el VALOR de una respuesta corresponda al tipo NO lo puede revisar un CHECK (otra tabla):
 *     lo revisa `validarRespuesta()` del contrato, antes de insertar.
 *
 * ── Las 17 preguntas de Comisiones RD (DP.0.2) ──────────────────────────────────────────────
 * Nacen **sin dueño** (D4: quién contesta lo decide Edgar) y lo que Lupita ya dijo entra como
 * **propuesta**, no como respuesta (D2): un chat no da usuario, fecha ni motivo.
 * Van en ESTA migración y no en una aparte: una que sólo inserta la clasifica NO_MEDIDO la
 * compuerta del despliegue y frena al equipo.
 *
 * Aditiva e idempotente. RLS forzado. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const FUENTE_LUPITA = 'Lupita Sánchez, WhatsApp 2026-11-03';

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

const op = (value, label) => ({ value, label });

/** [key, area, question, decides, value_type, choices, unit, config_route, suggested_value] */
const PREGUNTAS = [
  ['rd.universo.sigue_a', 'direccion',
    '¿La comisión de Ruta Directa sigue al chofer o al tipo de ruta?',
    'Las rutas 321 y 322 pasaron a Vecinal el 2026-09-08 y desde entonces venden $846,189.75 sin comisión. El mismo chofer comisionaba en junio.',
    'choice', [op('chofer', 'Al chofer: si cambia de ruta, la comisión se va con él'), op('tipo_ruta', 'Al tipo de ruta: sólo comisiona la ruta de camión')], null, null, null],
  ['rd.vecinal.tabulador', 'comercial',
    '¿Cuál es el tabulador de las rutas vecinales: escalones de venta, porcentaje y sobre qué se calcula?',
    'Las rutas vecinales venden $2.2M en 30 días sin comisión configurada.',
    'config_ref', null, null, '/comercial/comisiones', null],
  ['rd.vecinal.quien_cobra', 'comercial',
    'En una ruta vecinal, ¿quién cobra la comisión?',
    'Decide a quién se le escribe la línea de comisión en cada ruta vecinal.',
    'choice', [op('chofer', 'El chofer'), op('supervisor', 'El supervisor'), op('ambos', 'Los dos, con un reparto')], null, null, null],
  ['rd.tlmk.tabulador', 'comercial',
    '¿Cuál es el tabulador de Telemarketing (TLMK): escalones, porcentaje y sobre qué se calcula?',
    'TLMK no está en el motor de comisiones. Su venta sale del pedido de telemarketing (U-D-40), no de una ruta.',
    'config_ref', null, null, '/comercial/comisiones', null],
  ['rd.tlmk.quien_cobra', 'comercial',
    'En Telemarketing, ¿quién cobra la comisión: quien capturó el pedido, el equipo o alguien más?',
    'Decide a quién se le escribe la línea de comisión de cada pedido de telemarketing.',
    'text', null, null, null, null],
  ['rd.ausencia.motivos', 'rh',
    '¿Qué motivos de ausencia se compensan con el promedio de los periodos pagados?',
    'Sin el motivo, el motor no distingue «el camión no salió» de «la fuente perdió el día». En Q21 la ruta 505 vendió 3 de 11 días.',
    'choices', [op('vacaciones', 'Vacaciones'), op('incapacidad', 'Incapacidad'), op('mantenimiento_vehiculo', 'Mantenimiento del vehículo'), op('falla_computo', 'Falla de cómputo')],
    null, null, ['vacaciones', 'incapacidad', 'mantenimiento_vehiculo', 'falla_computo']],
  ['rd.ausencia.base', 'comercial',
    'Al compensar una ausencia, ¿qué se promedia?',
    'El tabulador es escalonado: promediar la venta y aplicar el escalón no da lo mismo que promediar la comisión ya pagada.',
    'choice', [op('comision', 'La comisión pagada'), op('venta', 'La venta total'), op('subtotal', 'El subtotal')], null, null, null],
  ['rd.ausencia.ventana', 'comercial',
    '¿Cuántos periodos pagados entran en el promedio?',
    'Fija cuántas quincenas ya pagadas se toman hacia atrás.',
    'number', null, 'quincenas pagadas', null, 3],
  ['rd.ausencia.alcance', 'comercial',
    '¿El promedio cubre sólo los días ausentes o la quincena completa?',
    'Con días parciales se compensa la parte que faltó; con la quincena completa se reemplaza el cálculo entero.',
    'choice', [op('dias', 'Sólo los días ausentes'), op('quincena', 'La quincena completa')], null, null, null],
  ['rd.ausencia.comprobante', 'rh',
    '¿Qué comprobante respalda cada motivo de ausencia y quién lo captura?',
    'Una compensación sin comprobante no se puede auditar.',
    'text', null, null, null, null],
  ['rd.bono_asistencia.monto', 'rh',
    '¿De cuánto es el bono de asistencia y puntualidad?',
    'Hoy el motor no tiene este bono.',
    'money', null, 'MXN', null, null],
  ['rd.bono_asistencia.faltas_max', 'rh',
    '¿Con cuántas faltas en el mes se pierde el bono de asistencia?',
    'Define cuándo no se paga el bono.',
    'number', null, 'faltas en el mes', null, null],
  ['rd.bono_asistencia.retardos_max', 'rh',
    '¿Con cuántos retardos en el mes se pierde el bono de puntualidad?',
    'Define cuándo no se paga el bono.',
    'number', null, 'retardos en el mes', null, null],
  ['rd.bono_asistencia.fuente', 'rh',
    '¿De dónde sale hoy la asistencia de los choferes?',
    'La suite no tiene checadas: hr.attendance_logs tenía 0 filas el 2026-11-03.',
    'choice', [op('reloj_checador', 'El reloj checador'), op('mega_talento', 'Mega Talento'), op('captura_manual', 'Una lista que lleva alguien')], null, null, null],
  ['rd.bono_asistencia.dia_pago', 'rh',
    '¿Qué día se paga el bono de asistencia y puntualidad?',
    'El motor paga por quincena; un bono mensual hoy se calcula y no entra a la nómina.',
    'choice', [op('ultimo_viernes_mes', 'El último viernes del mes'), op('con_la_quincena', 'Con la quincena que cierra el mes')], null, null, 'ultimo_viernes_mes'],
  ['rd.faltante.forma_cobro', 'comercial',
    '¿Cómo se cobra el faltante de mercancía a la ruta?',
    'El cliente RD001 «COBRO FALTANTE INVENTARIO» existe en las 9 sucursales y tiene 0 documentos en Kepler.',
    'choice', [op('venta_rd001', 'Con una venta al cliente RD001 en Kepler'), op('descuento_comision', 'Se descuenta de la comisión'), op('otra', 'De otra forma')], null, null, null],
  ['rd.faltante.quien_determina', 'comercial',
    '¿Quién determina el monto del faltante, contra qué conteo y cada cuándo?',
    'El inventario de ruta no existe como saldo en Kepler: el faltante tiene que salir de un conteo.',
    'text', null, null, null, null],
];

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
  // ⚠️ Sin USAGE del schema los GRANT de tabla no sirven: el runtime tira 42501. Ya pasó con `budget`.
  await knex.raw('GRANT USAGE ON SCHEMA platform TO app_runtime');

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.business_definitions (
      id                uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id         uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      key               text        NOT NULL,
      area              text        NOT NULL,
      consumer          text        NOT NULL,
      question          text        NOT NULL,
      decides           text        NOT NULL DEFAULT '',
      value_type        text        NOT NULL,
      choices           jsonb,
      unit              text,
      config_route      text,
      suggested_value   jsonb,
      suggested_source  text,
      status            text        NOT NULL DEFAULT 'pendiente',
      assigned_to       uuid,
      assigned_by       uuid,
      assigned_at       timestamptz,
      due_at            timestamptz,
      answered_at       timestamptz,
      answered_by       uuid,
      discarded_at      timestamptz,
      discard_reason    text,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT business_definitions_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT business_definitions_key_uk UNIQUE (tenant_id, key),
      CONSTRAINT business_definitions_key_ck CHECK (key ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$'),
      CONSTRAINT business_definitions_area_ck CHECK (area IN
        ('comercial','finanzas','logistica','rh','plataforma','trade','direccion')),
      CONSTRAINT business_definitions_question_ck CHECK (length(btrim(question)) BETWEEN 1 AND 400),
      CONSTRAINT business_definitions_type_ck CHECK (value_type IN
        ('number','money','percent','boolean','text','date','choice','choices','config_ref')),
      CONSTRAINT business_definitions_status_ck CHECK (status IN ('pendiente','respondida','descartada')),
      CONSTRAINT business_definitions_choices_ck CHECK (
        (value_type IN ('choice','choices')) = (choices IS NOT NULL)
        AND (choices IS NULL OR (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) >= 2))),
      CONSTRAINT business_definitions_config_ck CHECK ((value_type = 'config_ref') = (config_route IS NOT NULL)),
      CONSTRAINT business_definitions_suggested_ck CHECK ((suggested_value IS NULL) = (suggested_source IS NULL)),
      -- ── La máquina de estados, con sus invariantes entre columnas ──
      CONSTRAINT business_definitions_assigned_pair_ck CHECK ((assigned_to IS NULL) = (assigned_at IS NULL)),
      CONSTRAINT business_definitions_answered_ck CHECK ((status = 'respondida') = (answered_at IS NOT NULL)),
      CONSTRAINT business_definitions_answered_by_ck CHECK (status <> 'respondida' OR answered_by IS NOT NULL),
      CONSTRAINT business_definitions_discarded_ck CHECK ((status = 'descartada') = (discarded_at IS NOT NULL)),
      CONSTRAINT business_definitions_discard_reason_ck CHECK (status <> 'descartada'
        OR length(btrim(coalesce(discard_reason, ''))) > 0),
      CONSTRAINT business_definitions_assigned_to_fk FOREIGN KEY (tenant_id, assigned_to)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT business_definitions_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT business_definitions_answered_by_fk FOREIGN KEY (tenant_id, answered_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  // Los accesos reales: lo que lee un consumidor (por consumer), la bandeja del dueño y lo vencido.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bdef_consumer ON platform.business_definitions (tenant_id, consumer)
                  WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bdef_asignado ON platform.business_definitions (tenant_id, assigned_to, status)
                  WHERE deleted_at IS NULL AND assigned_to IS NOT NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.business_definition_answers (
      id             uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      definition_id  uuid        NOT NULL,
      value          jsonb       NOT NULL,
      valid_from     date        NOT NULL,
      note           text        NOT NULL,
      answered_by    uuid        NOT NULL,
      answered_at    timestamptz NOT NULL DEFAULT now(),
      created_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT business_definition_answers_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT business_definition_answers_note_ck CHECK (length(btrim(note)) > 0),
      CONSTRAINT business_definition_answers_value_ck CHECK (jsonb_typeof(value) <> 'null'),
      CONSTRAINT business_definition_answers_definition_fk FOREIGN KEY (tenant_id, definition_id)
        REFERENCES platform.business_definitions (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT business_definition_answers_answered_by_fk FOREIGN KEY (tenant_id, answered_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bdef_ans_vigencia ON platform.business_definition_answers
                  (tenant_id, definition_id, valid_from DESC, answered_at DESC)`);

  // ── DP.0.2: las 17 preguntas de Comisiones RD, sin dueño, sólo si el tenant existe ──
  const { rows: [t] } = await knex.raw('SELECT id FROM identity.tenants WHERE id = ?', [TENANT]);
  if (t) {
    // El insert pasa por la política RLS (FORCE aplica también al dueño): se fija el tenant.
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    for (const [key, area, question, decides, valueType, choices, unit, configRoute, suggested] of PREGUNTAS) {
      await knex.raw(`
        INSERT INTO platform.business_definitions
          (tenant_id, key, area, consumer, question, decides, value_type, choices, unit,
           config_route, suggested_value, suggested_source)
        VALUES (?, ?, ?, 'commercial.commissions', ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?)
        ON CONFLICT (tenant_id, key) DO NOTHING`,
      [TENANT, key, area, question, decides, valueType,
        choices ? JSON.stringify(choices) : null, unit, configRoute,
        suggested == null ? null : JSON.stringify(suggested),
        suggested == null ? null : FUENTE_LUPITA]);
    }
  }

  // Grants por tabla: la RESPUESTA es registro, no se edita ni se borra desde la API.
  // La pregunta no tiene DELETE: se descarta, con motivo.
  await proteger(knex, 'business_definitions', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'business_definition_answers', 'SELECT, INSERT');

  await knex.raw(`COMMENT ON TABLE platform.business_definitions IS 'DP.0.1 — una regla de negocio que falta, PREGUNTADA dentro del sistema: qué decide, de qué tipo es la respuesta y quién la contesta. Es también la TAREA de su dueño (contrato de tarea: assigned_(to|by|at)). No se borra: se descarta con motivo.'`);
  await knex.raw(`COMMENT ON TABLE platform.business_definition_answers IS 'DP.0.1 — las respuestas, con vigencia (valid_from) y motivo. Registro: sin UPDATE ni DELETE para app_runtime. La vigente a una fecha es la de mayor valid_from <= fecha (y la más nueva si empatan).'`);
  await knex.raw(`COMMENT ON COLUMN platform.business_definitions.suggested_value IS 'Lo que alguien ya dijo FUERA del sistema (un chat, una junta). Es propuesta, no respuesta: no tiene usuario, fecha ni motivo. suggested_source dice de dónde salió.'`);
  await knex.raw(`COMMENT ON COLUMN platform.business_definitions.config_route IS 'Para value_type=config_ref: la pantalla donde la respuesta se CONFIGURA (p. ej. el tabulador). La definición sólo apunta ahí.'`);
  // eslint-disable-next-line no-console
  console.log(`  [DP.0.1] platform: business_definitions + business_definition_answers · [DP.0.2] ${t ? PREGUNTAS.length : 0} preguntas de Comisiones RD`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS platform.business_definition_answers');
  await knex.raw('DROP TABLE IF EXISTS platform.business_definitions');
  // El schema sólo se borra si quedó vacío: otra fase pudo haberlo empezado a usar.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'platform') THEN
        EXECUTE 'DROP SCHEMA platform';
      END IF;
    END $$`);
};
