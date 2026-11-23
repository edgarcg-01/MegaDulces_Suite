'use strict';
/**
 * Fase RH · frente NE · `[NE.0.4]`/`[NE.0.12]` — EL PERIODO ES UNA LLAVE, Y EL ALIAS DICE CÓMO SE LIGÓ.
 *
 * Las dos tablas que cierran dos de los catorce patrones de `FASE_RH_FRENTE_NE_DISENO.md`:
 *   · B1 «la llave de periodo escrita a mano en texto libre»
 *   · A2 «dos padrones sin llave común, que sólo se unen por el nombre escrito»
 *
 * ── Lo medido antes (sólo lectura, 2026-11-23) ──────────────────────────────────────────────
 *  · La fecha de nómina del sistema actual es **viernes en los 1,088 casos de 2026**. Es el único
 *    dato consistente de todo el periodo → se vuelve la llave, y el viernes se vuelve un CHECK.
 *  · ⛔ Su «número de semana» NO es una semana: va de **23 a 726 con 504 valores distintos en 2026**
 *    y 335 números apuntan a más de una fecha. Es un **consecutivo por centro** (44 centros, cada
 *    uno con su contador). Por eso nunca iba a reconciliar contra nada. Entra como ALIAS, no como
 *    llave.
 *  · ⛔ **Qué días cubre un periodo no está registrado en ninguna parte.** Ni en el recibo ni en el
 *    consecutivo (que sólo dice `Dias = 7` en los 44). Por eso `starts_on`/`ends_on` nacen NULL:
 *    se DECLARA desconocido (ADR-056) en vez de inventar un rango. Los llena RH, no una suposición.
 *  · El padrón de nómina y el de la Suite no comparten llave: hoy sólo ligan **por nombre** (73.7 %
 *    sin ambigüedad). Por eso `matched_by` es NOT NULL: un empate por nombre queda MARCADO como tal
 *    y se puede auditar y reemplazar. ⛔ Sin esa columna, un empate por nombre se vuelve verdad de
 *    producción en silencio.
 *
 * Aditiva e idempotente: dos tablas nuevas, ninguna existente se toca. La API desplegada no las
 * conoce, así que aplicarla antes de desplegar no rompe nada.
 *
 * @param { import("knex").Knex } knex
 */

const PERIODOS = 'payroll_periods';
const ALIAS = 'person_aliases';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El periodo de nómina ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr.${PERIODOS} (
      id             uuid         NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid         NOT NULL,
      paid_on        date         NOT NULL,
      starts_on      date,
      ends_on        date,
      days           smallint,
      status         text         NOT NULL DEFAULT 'abierto',
      source         text         NOT NULL,
      notes          text,
      created_at     timestamptz  NOT NULL DEFAULT now(),
      created_by     uuid,
      updated_at     timestamptz  NOT NULL DEFAULT now(),
      updated_by     uuid,
      CONSTRAINT ${PERIODOS}_pkey PRIMARY KEY (id),
      -- identity.tenants, NO public.tenants (es una vista: lección de 20261104235236).
      CONSTRAINT ${PERIODOS}_tenant_fk FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT,
      -- Medido: viernes en 1,088 de 1,088. Si algún día deja de serlo, que falle acá y no en un reporte.
      CONSTRAINT ${PERIODOS}_viernes_ck CHECK (extract(isodow from paid_on) = 5),
      CONSTRAINT ${PERIODOS}_status_ck CHECK (status IN ('abierto', 'cerrado', 'pagado')),
      CONSTRAINT ${PERIODOS}_source_ck CHECK (source IN ('access', 'suite', 'manual')),
      -- El rango se declara ENTERO o no se declara: medio rango es peor que ninguno.
      CONSTRAINT ${PERIODOS}_rango_ck CHECK (
        (starts_on IS NULL AND ends_on IS NULL AND days IS NULL)
        OR (starts_on IS NOT NULL AND ends_on IS NOT NULL AND ends_on >= starts_on
            AND days = (ends_on - starts_on) + 1)
      )
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${PERIODOS}_pago ON hr.${PERIODOS} (tenant_id, paid_on)`);
  await knex.raw(`COMMENT ON TABLE hr.${PERIODOS} IS
    '[NE.0.4] El periodo de nómina como LLAVE. Se identifica por su fecha de pago, que es viernes (medido 1,088/1,088 en 2026). starts_on/ends_on nacen NULL a propósito: qué días cubre un periodo no está registrado en el sistema de origen — se declara desconocido, no se inventa.'`);
  await knex.raw(`COMMENT ON COLUMN hr.${PERIODOS}.days IS
    'Redundante con el rango y amarrado por CHECK. Existe para que una consulta no tenga que restar fechas.'`);

  await knex.raw(`ALTER TABLE hr.${PERIODOS} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE hr.${PERIODOS} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${PERIODOS}_tenant ON hr.${PERIODOS}`);
  await knex.raw(`CREATE POLICY ${PERIODOS}_tenant ON hr.${PERIODOS}
                    USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  // Sin DELETE: un periodo pagado no se borra, se marca.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON hr.${PERIODOS} TO app_runtime`);

  // ── 2. El alias: la misma persona, nombrada por cada sistema ───────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr.${ALIAS} (
      id             uuid         NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid         NOT NULL,
      employee_id    uuid         NOT NULL,
      system         text         NOT NULL,
      external_code  text         NOT NULL,
      matched_by     text         NOT NULL,
      matched_note   text,
      is_active      boolean      NOT NULL DEFAULT true,
      created_at     timestamptz  NOT NULL DEFAULT now(),
      created_by     uuid,
      updated_at     timestamptz  NOT NULL DEFAULT now(),
      updated_by     uuid,
      CONSTRAINT ${ALIAS}_pkey PRIMARY KEY (id),
      CONSTRAINT ${ALIAS}_tenant_fk FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT,
      CONSTRAINT ${ALIAS}_employee_fk FOREIGN KEY (employee_id) REFERENCES hr.employees(id) ON DELETE RESTRICT,
      CONSTRAINT ${ALIAS}_system_ck CHECK (system IN ('nomina', 'reloj', 'contpaqi', 'suite')),
      -- ⭐ Cómo se ligó queda registrado. 'nombre' es provisional por definición: se puede listar y reemplazar.
      CONSTRAINT ${ALIAS}_matched_by_ck CHECK (matched_by IN ('llave', 'nombre', 'manual')),
      -- Un empate por nombre sin nota no se puede auditar después.
      CONSTRAINT ${ALIAS}_nombre_ck CHECK (matched_by <> 'nombre' OR matched_note IS NOT NULL),
      CONSTRAINT ${ALIAS}_code_ck CHECK (btrim(external_code) <> '')
    )`);
  // Un código externo nombra a UNA persona. Es lo que impide que vuelvan los padrones paralelos.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${ALIAS}_externo
                    ON hr.${ALIAS} (tenant_id, system, external_code) WHERE is_active`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${ALIAS}_empleado ON hr.${ALIAS} (tenant_id, employee_id)`);
  await knex.raw(`COMMENT ON TABLE hr.${ALIAS} IS
    '[NE.0.4] Cómo nombra cada sistema a la misma persona. matched_by dice CÓMO se ligó: un empate por nombre queda marcado como tal (hoy liga el 73.7 % del universo de nómina) y se puede auditar y reemplazar por una llave real.'`);
  await knex.raw(`COMMENT ON COLUMN hr.${ALIAS}.matched_by IS
    'llave = los dos sistemas comparten un código · nombre = empate textual, PROVISIONAL · manual = alguien lo decidió y firmó en matched_note.'`);

  await knex.raw(`ALTER TABLE hr.${ALIAS} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE hr.${ALIAS} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${ALIAS}_tenant ON hr.${ALIAS}`);
  await knex.raw(`CREATE POLICY ${ALIAS}_tenant ON hr.${ALIAS}
                    USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON hr.${ALIAS} TO app_runtime`);

  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS n FROM hr.employees`);
  console.log(
    `  [ne04] hr.${PERIODOS} y hr.${ALIAS} listas. hr.employees tiene ${n.n} fila(s): ` +
      `mientras siga en 0, no se puede dar de alta un alias (lo llena [RH.1.4]).`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TABLE IF EXISTS hr.${ALIAS}`);
  await knex.raw(`DROP TABLE IF EXISTS hr.${PERIODOS}`);
};
