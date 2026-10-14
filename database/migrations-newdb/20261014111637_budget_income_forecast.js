'use strict';
/**
 * `[PU.13]` — **El estimado de INGRESOS por día, en Presupuestos.**
 *
 * Pedido de Francisco (2026-10-14): «el estimado de ingresos para el resto de octubre a diciembre
 * de 2026, en una tabla, agregada a Presupuestos de la Suite», con el formato de su hoja: una fila
 * por semana y, por cada día, **bancos | caja general**.
 *
 * ── Qué se guarda y qué NO ──────────────────────────────────────────────────────────────────
 *  · Se guarda el ESTIMADO: es un dato propio (un plan), no un dato del ERP — la regla de
 *    «tabla real sólo para datos propios» lo permite.
 *  · ⛔ NO se guarda lo REAL. Lo que entró lo lee el servidor de `finance.bank_movements` (categoría
 *    `cobranza`) cada vez que se abre la pantalla, para ponerlo al lado del estimado. Copiarlo acá
 *    sería una segunda tabla del mismo hecho.
 *
 * ── Las tablas ──────────────────────────────────────────────────────────────────────────────
 *  · `budget.income_forecasts`: la VERSIÓN del estimado (nombre, periodo, método en texto, los
 *    factores en `parametros`). Una sola vigente por tenant (índice único parcial): la pantalla
 *    muestra la vigente; una versión nueva no borra la anterior.
 *  · `budget.income_forecast_days`: el monto estimado por (versión, día, canal). Canal cerrado a
 *    `bancos` | `caja_general` — los mismos dos de `finance.bank_accounts.kind` (`bank` / `cash`).
 *
 * ── La versión que se siembra: «Estimado oct–dic 2026 (al 13-oct)» ──────────────────────────
 * Medido en prod (sólo lectura) el 2026-10-14; el método completo va en `parametros` y en pantalla:
 *  1. Octubre = lo ya entrado ÷ la parte del mes que en jul–sep 2026 había entrado a esa fecha
 *     (bancos $19,513,367 al 13-oct = 39.7 % → $49.1 M; caja $2,212,905 al 10-oct = 36.1 % → $6.1 M).
 *  2. Noviembre y diciembre = octubre × la FORMA de 2025, leída de los libros de bancos de
 *     oct/nov/dic-2025 con las mismas reglas de clasificación (cuadran contra su CONCENTRADO al
 *     0.02 / 0.5 / 0.9 %): bancos nov 0.888 · dic 1.395; caja nov 0.804 · dic 1.534.
 *  3. Reparto por día con el patrón de cada día de la semana de los últimos 90 días; los días
 *     inhábiles bancarios (2-nov, 16-nov, 12-dic, 25-dic) cuentan como domingo y lo que les
 *     tocaba pasa al siguiente día hábil.
 * ⚠️ Sólo la FORMA de 2025, no su nivel: en 2026 entra al banco menos por cada peso vendido
 * (bancos/venta 1.12 en oct-25, 0.87 en jul–sep-26).
 *
 * Aditiva e idempotente (la siembra no se repite si la versión ya existe).
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const NOMBRE = 'Estimado oct–dic 2026 (al 13-oct)';

/** [fecha, bancos, caja_general] — null = ese canal ya tiene dato real ese día (no se estima). */
const DIAS = [
  ['2026-10-11', null, 0],
  ['2026-10-12', null, 150195],
  ['2026-10-13', null, 308696],
  ['2026-10-14', 1642074, 230174],
  ['2026-10-15', 1753887, 337595],
  ['2026-10-16', 1967177, 184027],
  ['2026-10-17', 372517, 95315],
  ['2026-10-18', 73920, 0],
  ['2026-10-19', 3283236, 150195],
  ['2026-10-20', 2835374, 308696],
  ['2026-10-21', 1642074, 230174],
  ['2026-10-22', 1753887, 337595],
  ['2026-10-23', 1967177, 184027],
  ['2026-10-24', 372517, 95315],
  ['2026-10-25', 73920, 0],
  ['2026-10-26', 3283236, 150195],
  ['2026-10-27', 2835374, 308696],
  ['2026-10-28', 1642074, 230174],
  ['2026-10-29', 1753887, 337595],
  ['2026-10-30', 1967177, 184027],
  ['2026-10-31', 372517, 95315],
  ['2026-11-01', 63144, 0],
  ['2026-11-02', 63144, 0],
  ['2026-11-03', 5163502, 420716],
  ['2026-11-04', 1402694, 211026],
  ['2026-11-05', 1498208, 309510],
  ['2026-11-06', 1680405, 168718],
  ['2026-11-07', 318212, 87386],
  ['2026-11-08', 63144, 0],
  ['2026-11-09', 2804610, 137701],
  ['2026-11-10', 2422037, 283015],
  ['2026-11-11', 1402694, 211026],
  ['2026-11-12', 1498208, 309510],
  ['2026-11-13', 1680405, 168718],
  ['2026-11-14', 318212, 87386],
  ['2026-11-15', 63144, 0],
  ['2026-11-16', 63144, 0],
  ['2026-11-17', 5163502, 420716],
  ['2026-11-18', 1402694, 211026],
  ['2026-11-19', 1498208, 309510],
  ['2026-11-20', 1680405, 168718],
  ['2026-11-21', 318212, 87386],
  ['2026-11-22', 63144, 0],
  ['2026-11-23', 2804610, 137701],
  ['2026-11-24', 2422037, 283015],
  ['2026-11-25', 1402694, 211026],
  ['2026-11-26', 1498208, 309510],
  ['2026-11-27', 1680405, 168718],
  ['2026-11-28', 318212, 87386],
  ['2026-11-29', 63144, 0],
  ['2026-11-30', 2804610, 137701],
  ['2026-12-01', 3599693, 475940],
  ['2026-12-02', 2084720, 354877],
  ['2026-12-03', 2226674, 520496],
  ['2026-12-04', 2497460, 283728],
  ['2026-12-05', 472934, 146955],
  ['2026-12-06', 93847, 0],
  ['2026-12-07', 4168283, 231568],
  ['2026-12-08', 3599693, 475940],
  ['2026-12-09', 2084720, 354877],
  ['2026-12-10', 2226674, 520496],
  ['2026-12-11', 2497460, 283728],
  ['2026-12-12', 93847, 0],
  ['2026-12-13', 93847, 0],
  ['2026-12-14', 4547370, 378523],
  ['2026-12-15', 3599693, 475940],
  ['2026-12-16', 2084720, 354877],
  ['2026-12-17', 2226674, 520496],
  ['2026-12-18', 2497460, 283728],
  ['2026-12-19', 472934, 146955],
  ['2026-12-20', 93847, 0],
  ['2026-12-21', 4168283, 231568],
  ['2026-12-22', 3599693, 475940],
  ['2026-12-23', 2084720, 354877],
  ['2026-12-24', 2226674, 520496],
  ['2026-12-25', 93847, 0],
  ['2026-12-26', 472934, 146955],
  ['2026-12-27', 93847, 0],
  ['2026-12-28', 6571896, 515296],
  ['2026-12-29', 3599693, 475940],
  ['2026-12-30', 2084720, 354877],
  ['2026-12-31', 2226674, 520496],
];

const PARAMETROS = {
  base: 'cobranza de finance.bank_movements (sin traspasos, préstamos ni devoluciones)',
  real_hasta: { bancos: '2026-10-13', caja_general: '2026-10-10' },
  octubre: {
    bancos: { real: 19513367.46, fraccion_del_mes: 0.3974, total: 49105393, rango: [46050884, 51681759] },
    caja_general: { real: 2212905, fraccion_del_mes: 0.3609, total: 6130912, rango: [4760769, 7286340] },
  },
  forma_2025: { bancos: { nov: 0.8884, dic: 1.3947 }, caja_general: { nov: 0.8037, dic: 1.5341 } },
  inhabiles: ['2026-11-02', '2026-11-16', '2026-12-12', '2026-12-25'],
  fuente_2025: ['10 OCTUBRE 2025.xlsx', '11 NOVIEMBRE 2025.xlsx', '12 DICIEMBRE 2025.xlsx'],
};

const METODO =
  'Octubre: lo ya entrado entre la parte del mes que en jul-sep 2026 había entrado a esa fecha. ' +
  'Noviembre y diciembre: octubre por la forma de 2025 (bancos nov 0.888, dic 1.395; caja nov 0.804, dic 1.534). ' +
  'Por día: patrón de cada día de la semana de los últimos 90 días; días inhábiles bancarios como domingo, ' +
  'su parte pasa al siguiente día hábil. Sólo la forma de 2025, no su nivel: en 2026 entra al banco menos ' +
  'por cada peso vendido (1.12 en oct-25, 0.87 en jul-sep-26).';

/** Lo que cada mes y canal tiene que sumar (tolerancia de redondeo por día). */
const ESPERADO = {
  '2026-10|bancos': 29592025, '2026-10|caja_general': 3918006,
  '2026-11|bancos': 43624992, '2026-11|caja_general': 4927125,
  '2026-12|bancos': 68485531, '2026-12|caja_general': 9405569,
};

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('budget').hasTable('income_forecasts'))) {
    await knex.raw(`
      CREATE TABLE budget.income_forecasts (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        nombre      text NOT NULL,
        desde       date NOT NULL,
        hasta       date NOT NULL,
        metodo      text NOT NULL,
        parametros  jsonb NOT NULL DEFAULT '{}'::jsonb,
        es_vigente  boolean NOT NULL DEFAULT false,
        created_by  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  text,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CHECK (hasta >= desde),
        UNIQUE (tenant_id, nombre),
        UNIQUE (tenant_id, id)
      )`);
    // Una sola versión vigente por tenant: la pantalla no tiene que elegir.
    await knex.raw(`
      CREATE UNIQUE INDEX ux_budget_income_forecasts_vigente
          ON budget.income_forecasts (tenant_id) WHERE es_vigente`);
    await tenantRls(knex, 'budget', 'income_forecasts');
    await knex.raw(`COMMENT ON TABLE budget.income_forecasts IS
      $$[PU.13] Versión del estimado de ingresos (cobranza: bancos y caja general). Dato propio (plan).
      Lo real NO vive aquí: se lee de finance.bank_movements (categoría cobranza) al consultar.$$`);
  }

  if (!(await knex.schema.withSchema('budget').hasTable('income_forecast_days'))) {
    await knex.raw(`
      CREATE TABLE budget.income_forecast_days (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        forecast_id  uuid NOT NULL,
        fecha        date NOT NULL,
        canal        text NOT NULL CHECK (canal IN ('bancos', 'caja_general')),
        monto        numeric(14,2) NOT NULL CHECK (monto >= 0),
        created_by   text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_by   text,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, forecast_id) REFERENCES budget.income_forecasts (tenant_id, id) ON DELETE CASCADE,
        UNIQUE (tenant_id, forecast_id, fecha, canal)
      )`);
    await tenantRls(knex, 'budget', 'income_forecast_days');
    await knex.raw(`COMMENT ON TABLE budget.income_forecast_days IS
      $$[PU.13] Monto estimado por (versión, día, canal). Canal = bancos | caja_general.$$`);
  }

  // ── La primera versión ────────────────────────────────────────────────────────────────────
  const { rows: ya } = await knex.raw(
    `SELECT id FROM budget.income_forecasts WHERE tenant_id = ?::uuid AND nombre = ?`, [TENANT, NOMBRE]);
  if (ya.length) {
    console.log(`  · [PU.13] la versión "${NOMBRE}" ya existe: no se siembra de nuevo.`);
    return;
  }
  await knex.raw(
    `UPDATE budget.income_forecasts SET es_vigente = false, updated_at = now(), updated_by = 'migracion [PU.13]'
      WHERE tenant_id = ?::uuid AND es_vigente`, [TENANT]);
  const { rows: [v] } = await knex.raw(
    `INSERT INTO budget.income_forecasts (tenant_id, nombre, desde, hasta, metodo, parametros, es_vigente, created_by, updated_by)
     VALUES (?::uuid, ?, '2026-10-11', '2026-12-31', ?, ?::jsonb, true, 'migracion [PU.13]', 'migracion [PU.13]')
     RETURNING id`,
    [TENANT, NOMBRE, METODO, JSON.stringify(PARAMETROS)]);

  const filas = [];
  for (const [fecha, bancos, caja] of DIAS) {
    if (bancos !== null) filas.push([fecha, 'bancos', bancos]);
    if (caja !== null) filas.push([fecha, 'caja_general', caja]);
  }
  for (const [fecha, canal, monto] of filas) {
    await knex.raw(
      `INSERT INTO budget.income_forecast_days (tenant_id, forecast_id, fecha, canal, monto, created_by, updated_by)
       VALUES (?::uuid, ?::uuid, ?::date, ?, ?, 'migracion [PU.13]', 'migracion [PU.13]')`,
      [TENANT, v.id, fecha, canal, monto]);
  }

  // Candado: lo sembrado tiene que sumar lo que dice el método, mes por mes y canal por canal.
  const { rows: suma } = await knex.raw(
    `SELECT to_char(fecha, 'YYYY-MM') || '|' || canal AS k, sum(monto)::float AS s
       FROM budget.income_forecast_days WHERE forecast_id = ?::uuid GROUP BY 1`, [v.id]);
  if (suma.length !== Object.keys(ESPERADO).length) {
    throw new Error(`[PU.13] se sembraron ${suma.length} combinaciones mes|canal y se esperaban ${Object.keys(ESPERADO).length}.`);
  }
  for (const r of suma) {
    if (!(r.k in ESPERADO) || Math.abs(r.s - ESPERADO[r.k]) > 50) {
      throw new Error(`[PU.13] la siembra de ${r.k} suma ${r.s} y el método dice ${ESPERADO[r.k]}.`);
    }
  }
  console.log(`  ✓ [PU.13] "${NOMBRE}": ${filas.length} renglones sembrados (vigente).`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TABLE IF EXISTS budget.income_forecast_days`);
  await knex.raw(`DROP TABLE IF EXISTS budget.income_forecasts`);
};
