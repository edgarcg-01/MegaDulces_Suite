'use strict';
/**
 * `[FCU.0.1–0.4, 0.7, 0.8]` — Costo por unidad: lo que la hoja «TRANSPORTES 2026 - COSTOS DE
 * TRANSPORTE» captura a mano, en el sistema. Plan: `docs/IMPLEMENTACION/FASES/
 * FASE_FC_ANEXO_COSTO_POR_UNIDAD_2026-10-26.md` (regla de la fase: «todo debe tener pantalla»).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-26) ────────────────────────────────────────
 *  · Kepler tiene un concepto de gasto para cada renglón de la hoja (X-A-10: 101 refrendo, 111
 *    seguro, 205 pensión, 209 GPS, 076/240/267 mantenimiento, 044/045/200 llantas, 022 aceite…),
 *    pero **ningún campo de unidad** y ningún centro de costo por unidad. La unidad viene escrita
 *    en el texto («DISEL HINO 500 LA ROSA MORELIA», «SEGURO QUALITAS INTERNATIONAL 1»): ene–sep,
 *    $1,162,139 se pueden atribuir así a las 14 unidades de la hoja.
 *  · `logistics.vehicles` no tiene dónde guardar lo que la hoja sí trae: vencimiento y prima del
 *    seguro, valor de compra, salario del chofer, km presupuestados.
 *
 * ── Qué crea ────────────────────────────────────────────────────────────────────────────────
 *  1. La **ficha** en `logistics.vehicles` (columnas nuevas, todas opcionales; `kepler_aliases`
 *     con default `{}`, así que ningún camino de inserción existente se rompe: importer de
 *     dimensiones, alta desde el GPS y alta rápida siguen igual).
 *  2. `logistics.fleet_cost_budget` — presupuesto anual por unidad × rubro (lo que hoy es la hoja).
 *  3. `logistics.fleet_expense_assignments` — la unidad CONFIRMADA por una persona para un renglón
 *     de Kepler (o «no es de flota»). Es el único dato propio del gasto: el importe se sigue
 *     leyendo de Kepler.
 *  4. `logistics.fleet_admin_payroll` — nómina administrativa de Logística por mes y cómo se
 *     reparte (no está en el ODS).
 *  5. `logistics.vehicle_odometer_readings` — lectura de odómetro para las unidades sin GPS.
 *  6. `analytics.v_fleet_expense_lines` — cada renglón X-A-10 (sin cancelados) con la unidad
 *     SUGERIDA por los alias de la ficha y la CONFIRMADA. `derive-no-copy` sobre `kepler_ods`.
 *     Si el texto empata con dos unidades, no se adivina: `ambiguo`.
 *
 * Las 4 tablas: `tenant_id` + auditoría completa + RLS forzada + baja lógica.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[fcu_costo_unidad_esquema]';

// Los rubros que se pueden presupuestar: los 14 de la hoja + los que la hoja no trae.
// ⚠️ Mismo orden y mismas claves que `RUBROS_COSTO_UNIDAD` en libs/contracts/src/http/costo-unidad.contract.ts.
const RUBROS = [
  'placas_refrendo_verificacion', 'arrendamiento_depreciacion', 'pension', 'gps_magnitracking', 'gps_salvador',
  'seguro', 'comisiones', 'salarios', 'mtto_preventivo', 'reparaciones', 'neumaticos', 'lubricantes',
  'gastos_directos', 'sueldos_admin', 'combustible', 'casetas', 'multas',
];

const FICHA = [
  ['display_name', 'varchar(80)'],
  ['fleet_area', 'varchar(30)'],
  ['ownership', 'varchar(12)'],
  ['purchase_value', 'numeric(14,2)'],
  ['purchase_date', 'date'],
  ['useful_life_years', 'numeric(5,2)'],
  ['residual_value', 'numeric(14,2)'],
  ['insurance_premium', 'numeric(14,2)'],
  ['insurance_expires_on', 'date'],
  ['driver_monthly_salary', 'numeric(12,2)'],
  ['budget_km_year', 'integer'],
  ['kepler_aliases', `text[] NOT NULL DEFAULT '{}'`],
];

const AUDITORIA = `
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid NULL,
    deleted_at timestamptz NULL,
    deleted_by uuid NULL`;

async function conRls(knex, tabla) {
  await knex.raw(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tabla} TO app_runtime`);
}

async function restriccion(knex, tabla, nombre, ddl) {
  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [nombre]);
  if (!rows.length) await knex.raw(`ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre} ${ddl}`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La ficha ──────────────────────────────────────────────────────────────────────────
  for (const [col, tipo] of FICHA) {
    if (!(await knex.schema.withSchema('logistics').hasColumn('vehicles', col))) {
      await knex.raw(`ALTER TABLE logistics.vehicles ADD COLUMN ${col} ${tipo}`);
    }
  }
  await restriccion(knex, 'logistics.vehicles', 'vehicles_ownership_valid',
    `CHECK (ownership IS NULL OR ownership IN ('propia','arrendada'))`);
  await restriccion(knex, 'logistics.vehicles', 'vehicles_fleet_area_valid',
    `CHECK (fleet_area IS NULL OR fleet_area IN ('transportes','reparto','telemarketing','ventas','administracion','otra'))`);
  await restriccion(knex, 'logistics.vehicles', 'vehicles_money_nonneg',
    `CHECK (coalesce(purchase_value,0) >= 0 AND coalesce(residual_value,0) >= 0 AND coalesce(insurance_premium,0) >= 0
            AND coalesce(driver_monthly_salary,0) >= 0 AND coalesce(budget_km_year,0) >= 0 AND coalesce(useful_life_years,1) > 0)`);
  await knex.raw(`COMMENT ON COLUMN logistics.vehicles.kepler_aliases IS
    'FCU.0.2 — Cómo se escribe esta unidad en el texto de los gastos de Kepler (X-A-10), en MAYÚSCULAS y sin acentos. analytics.v_fleet_expense_lines sugiere la unidad cuando el texto contiene uno; si empata con dos unidades, queda ambiguo.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.vehicles.driver_monthly_salary IS
    'FCU.0.4 — Salario mensual del chofer de la unidad, CAPTURADO (no está en el ODS). Dato sensible: sólo con LOGISTICS_COSTO_UNIDAD_GESTIONAR.'`);

  // ── 2. Presupuesto anual por unidad × rubro ─────────────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('fleet_cost_budget'))) {
    await knex.raw(`
      CREATE TABLE logistics.fleet_cost_budget (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        vehicle_id uuid NOT NULL,
        anio integer NOT NULL CHECK (anio BETWEEN 2020 AND 2100),
        rubro varchar(40) NOT NULL CHECK (rubro IN (${RUBROS.map((r) => `'${r}'`).join(',')})),
        amount numeric(14,2) NOT NULL CHECK (amount >= 0),
        source varchar(20) NOT NULL DEFAULT 'captura' CHECK (source IN ('captura','hoja_2026')),
        notes text NULL,${AUDITORIA},
        CONSTRAINT fk_fleet_cost_budget_vehicle FOREIGN KEY (tenant_id, vehicle_id)
          REFERENCES logistics.vehicles (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE UNIQUE INDEX fleet_cost_budget_natural_unique
      ON logistics.fleet_cost_budget (tenant_id, vehicle_id, anio, rubro) WHERE deleted_at IS NULL`);
  }
  await conRls(knex, 'logistics.fleet_cost_budget');

  // ── 3. Unidad confirmada para un renglón de Kepler ─────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('fleet_expense_assignments'))) {
    await knex.raw(`
      CREATE TABLE logistics.fleet_expense_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        linea_clave varchar(80) NOT NULL,
        vehicle_id uuid NULL,
        decision varchar(12) NOT NULL CHECK (decision IN ('unidad','no_es_flota')),
        notes text NULL,${AUDITORIA},
        CONSTRAINT fleet_expense_assignments_unidad_con_vehiculo
          CHECK (decision = 'no_es_flota' OR vehicle_id IS NOT NULL),
        CONSTRAINT fk_fleet_expense_assignments_vehicle FOREIGN KEY (tenant_id, vehicle_id)
          REFERENCES logistics.vehicles (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE UNIQUE INDEX fleet_expense_assignments_linea_unique
      ON logistics.fleet_expense_assignments (tenant_id, linea_clave) WHERE deleted_at IS NULL`);
  }
  await knex.raw(`COMMENT ON TABLE logistics.fleet_expense_assignments IS
    'FCU.0.3 — La unidad que una PERSONA confirmó para un renglón X-A-10 de Kepler (linea_clave = sucursal|c1|c5|folio|renglón), o «no_es_flota». El importe NO se copia: se lee en vivo de kepler_ods por analytics.v_fleet_expense_lines.'`);
  await conRls(knex, 'logistics.fleet_expense_assignments');

  // ── 4. Nómina administrativa de Logística por mes ──────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('fleet_admin_payroll'))) {
    await knex.raw(`
      CREATE TABLE logistics.fleet_admin_payroll (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        year_month char(7) NOT NULL CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        sueldos_admin numeric(14,2) NOT NULL DEFAULT 0 CHECK (sueldos_admin >= 0),
        gastos_directos numeric(14,2) NOT NULL DEFAULT 0 CHECK (gastos_directos >= 0),
        metodo varchar(16) NOT NULL DEFAULT 'km' CHECK (metodo IN ('km','partes_iguales')),
        notes text NULL,${AUDITORIA}
      )`);
    await knex.raw(`CREATE UNIQUE INDEX fleet_admin_payroll_mes_unique
      ON logistics.fleet_admin_payroll (tenant_id, year_month) WHERE deleted_at IS NULL`);
  }
  await knex.raw(`COMMENT ON TABLE logistics.fleet_admin_payroll IS
    'FCU.0.7 — Nómina administrativa de Logística y gastos directos del mes (CAPTURADOS: no están en el ODS) y cómo se reparten entre las unidades de Transportes (por km del GPS o partes iguales). Reemplaza el «SUELDOS ADMIN» de $82,000 repetido en cada ficha de la hoja.'`);
  await conRls(knex, 'logistics.fleet_admin_payroll');

  // ── 5. Lectura de odómetro (unidades sin GPS) ──────────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('vehicle_odometer_readings'))) {
    await knex.raw(`
      CREATE TABLE logistics.vehicle_odometer_readings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        vehicle_id uuid NOT NULL,
        read_on date NOT NULL,
        odometer_km integer NOT NULL CHECK (odometer_km >= 0),
        notes text NULL,${AUDITORIA},
        CONSTRAINT fk_vehicle_odometer_readings_vehicle FOREIGN KEY (tenant_id, vehicle_id)
          REFERENCES logistics.vehicles (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE UNIQUE INDEX vehicle_odometer_readings_dia_unique
      ON logistics.vehicle_odometer_readings (tenant_id, vehicle_id, read_on) WHERE deleted_at IS NULL`);
  }
  // ⚠️ Sin CHECK de «mayor que la anterior»: una lectura mal tecleada se ROTULA, no se rechaza
  // (mismo criterio que RD.5 con route_odometer).
  await conRls(knex, 'logistics.vehicle_odometer_readings');

  // ── 6. La vista de los gastos de flota de Kepler ───────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_fleet_expense_lines WITH (security_invoker = true) AS
    WITH l AS (
      SELECT btrim(l.sucursal) || '|' || btrim(l.c1) || '|' || l.c5::text || '|' || btrim(l.c6) || '|' || l.c7::text AS linea_clave,
             btrim(l.sucursal)                         AS sucursal,
             btrim(l.c6)                               AS folio,
             l.c7::int                                 AS renglon,
             h.c9::date                                AS fecha,
             btrim(l.c12)                              AS concepto,
             l.c11::numeric                            AS importe,
             nullif(btrim(l.c16), '')                  AS centro,
             btrim(coalesce(h.c24, ''))                AS cabecera,
             btrim(coalesce(l.c9, ''))                 AS texto,
             btrim(coalesce(h.c32, ''))                AS proveedor,
             regexp_replace(upper(translate(coalesce(h.c24, '') || ' ' || coalesce(l.c9, ''),
               'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '\\s+', ' ', 'g') AS texto_norm
        FROM kepler_ods.kdm6 l
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = l.sucursal AND btrim(h.c1) = btrim(l.c1) AND h.c2 = l.c2 AND h.c3 = l.c3
         AND h.c4 = l.c4 AND h.c5::text = l.c5::text AND btrim(h.c6) = btrim(l.c6)
       WHERE l.c2 = 'X' AND l.c3 = 'A' AND l.c4::int = 10 AND btrim(l.c1) = btrim(l.sucursal)
         AND coalesce(h.c43, '') <> 'C'
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           l.linea_clave, l.sucursal, l.folio, l.renglon, l.fecha, l.concepto, l.importe, l.centro,
           l.cabecera, l.texto, l.proveedor,
           c.candidatos,
           c.sugerido                                   AS sugerido_vehicle_id,
           a.vehicle_id                                 AS asignado_vehicle_id,
           a.decision,
           CASE WHEN a.decision = 'no_es_flota' THEN NULL
                ELSE coalesce(a.vehicle_id, CASE WHEN c.candidatos = 1 THEN c.sugerido END) END AS vehicle_id,
           CASE WHEN a.decision = 'no_es_flota' THEN 'no_es_flota'
                WHEN a.vehicle_id IS NOT NULL     THEN 'confirmado'
                WHEN c.candidatos = 1             THEN 'sugerido'
                WHEN c.candidatos > 1             THEN 'ambiguo'
                ELSE 'sin_unidad' END             AS estado
      FROM l
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS candidatos, (array_agg(v.id ORDER BY v.id))[1] AS sugerido
          FROM logistics.vehicles v
         WHERE v.deleted_at IS NULL AND cardinality(v.kepler_aliases) > 0
           AND EXISTS (SELECT 1 FROM unnest(v.kepler_aliases) al
                        WHERE btrim(al) <> '' AND l.texto_norm LIKE '%' || al || '%')
      ) c ON true
      LEFT JOIN logistics.fleet_expense_assignments a
        ON a.linea_clave = l.linea_clave AND a.deleted_at IS NULL`);
  await knex.raw(`COMMENT ON VIEW analytics.v_fleet_expense_lines IS
    'FCU.0.1 — Cada renglón X-A-10 de Kepler (gastos, sin cancelados) con la unidad: SUGERIDA por los alias de la ficha (logistics.vehicles.kepler_aliases) y CONFIRMADA por una persona (logistics.fleet_expense_assignments). estado: confirmado · sugerido · ambiguo (el texto nombra dos unidades) · sin_unidad · no_es_flota. derive-no-copy: el importe es el de Kepler.'`);
  await knex.raw(`GRANT SELECT ON analytics.v_fleet_expense_lines TO app_runtime`);

  console.log(`${TAG} ficha (${FICHA.length} columnas) · 4 tablas con RLS · vista analytics.v_fleet_expense_lines`);
};

/** Deshace EXACTAMENTE lo que hizo el `up` (objetos nuevos de esta fase). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_fleet_expense_lines`);
  await knex.raw(`DROP TABLE IF EXISTS logistics.vehicle_odometer_readings`);
  await knex.raw(`DROP TABLE IF EXISTS logistics.fleet_admin_payroll`);
  await knex.raw(`DROP TABLE IF EXISTS logistics.fleet_expense_assignments`);
  await knex.raw(`DROP TABLE IF EXISTS logistics.fleet_cost_budget`);
  for (const n of ['vehicles_ownership_valid', 'vehicles_fleet_area_valid', 'vehicles_money_nonneg']) {
    await knex.raw(`ALTER TABLE logistics.vehicles DROP CONSTRAINT IF EXISTS ${n}`);
  }
  for (const [col] of FICHA) await knex.raw(`ALTER TABLE logistics.vehicles DROP COLUMN IF EXISTS ${col}`);
};
