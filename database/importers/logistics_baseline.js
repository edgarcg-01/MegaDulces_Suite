#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Importer baseline para Fase J — Logística.
 *
 * Carga (UPSERT idempotente) los catálogos base de Mega Dulces extraídos del
 * repo origen `_imported/logistica/database/seeds/01b_logistica_seed.js`:
 *   - 105 destinos (logistics.routes) con comisiones chofer/repartidor/ayudante + km
 *   - 26 períodos catorcenales 2026 (logistics.payroll_periods)
 *   - 22 parámetros financieros (logistics.config_finance): factores + costos km + tarifas maniobra
 *
 * Idempotente: re-ejecutable. Usa UPSERT por (tenant, name | year+number | key).
 *
 * Uso:
 *   node database/importers/logistics_baseline.js --tenant-slug=mega_dulces [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

// ───────────────────────── DATA (extraída de repo origen) ─────────────────────────

const DESTINOS = [
  { name: 'AGUASCALIENTES', driver: 250, repartidor: 130.40, helper: 91.20, km: null },
  { name: 'APATZINGAN', driver: 129, repartidor: 130.40, helper: 91.20, km: null },
  { name: 'ARANDAS MATUTINO', driver: 95, repartidor: 76, helper: 67.16, km: null },
  { name: 'ARANDAS VESPERTINO', driver: 61.92, repartidor: 48.90, helper: 36.48, km: null },
  { name: 'ARIO DE ROSALES', driver: 129, repartidor: 130.40, helper: 91.20, km: null },
  { name: 'ATOTONILCO', driver: 103.20, repartidor: 88.02, helper: 60.80, km: null },
  { name: 'CIUDAD HIDALGO', driver: 129, repartidor: 130.40, helper: 97.28, km: null },
  { name: 'COTIJA', driver: 103.20, repartidor: 88.02, helper: 66.88, km: null },
  { name: 'DEGOLLADO', driver: 51.60, repartidor: 48.90, helper: 30.40, km: null },
  { name: 'ECUANDUREO', driver: 61.92, repartidor: 48.90, helper: 36.48, km: null },
  { name: 'GUADALAJARA', driver: 180, repartidor: 127.25, helper: 127.25, km: null },
  { name: 'GUANAJUATO', driver: 113.52, repartidor: 97.80, helper: 76, km: null },
  { name: 'JACONA', driver: 77.40, repartidor: 71.72, helper: 51.68, km: null },
  { name: 'JIQUILPAN', driver: 98.04, repartidor: 78.24, helper: 57.76, km: null },
  { name: 'LA BARCA', driver: 77.40, repartidor: 65.20, helper: 45.60, km: null },
  { name: 'LEON', driver: 113.52, repartidor: 97.80, helper: 76, km: null },
  { name: 'LOS REYES', driver: 103.20, repartidor: 114.10, helper: 76, km: null },
  { name: 'MORELIA', driver: 180, repartidor: 119.89, helper: 111.40, km: null },
  { name: 'MOROLEON', driver: 92.88, repartidor: 81.50, helper: 60.80, km: null },
  { name: 'NUEVA ITALIA', driver: 129, repartidor: 130.40, helper: 91.20, km: null },
  { name: 'PATZCUARO', driver: 103.20, repartidor: 84.76, helper: 63.84, km: null },
  { name: 'PENJAMILLO', driver: 77.40, repartidor: 71.72, helper: 51.68, km: null },
  { name: 'PENJAMO', driver: 51.60, repartidor: 48.90, helper: 36.48, km: null },
  { name: 'PERIBAN', driver: 103.20, repartidor: 114.10, helper: 76, km: null },
  { name: 'PURUANDIRO', driver: 103.20, repartidor: 88.02, helper: 66.88, km: null },
  { name: 'QUERENDARO', driver: 129, repartidor: 130.40, helper: 91.20, km: null },
  { name: 'QUEDAR A DORMIR / NOCHE', driver: 180, repartidor: 113.72, helper: 106.04, km: null },
  { name: 'TANGAMANDAPIO', driver: 103.20, repartidor: 84.76, helper: 63.84, km: null },
  { name: 'SAHUAYO', driver: 92.88, repartidor: 71.72, helper: 51.68, km: null },
  { name: 'VIAJE EN DOMINGO', driver: 200, repartidor: 126.35, helper: 117.82, km: null },
  { name: 'SAN JOSE', driver: 51.60, repartidor: 39.12, helper: 30.40, km: null },
  { name: 'SANTA ANA M', driver: 87.72, repartidor: 71.72, helper: 54.72, km: null },
  { name: 'SUCURSAL MATUTINO', driver: 51.60, repartidor: 48.90, helper: 30.40, km: null },
  { name: 'SEGUNDO VIAJE SUCURSAL', driver: 25.80, repartidor: 16.30, helper: 0, km: null },
  { name: 'TANGANCICUARO', driver: 103.20, repartidor: 88.02, helper: 60.80, km: null },
  { name: 'TANHUATO', driver: 61.92, repartidor: 48.90, helper: 36.48, km: null },
  { name: 'URUAPAN', driver: 113.52, repartidor: 97.80, helper: 76, km: null },
  { name: 'VALLE DE SANTIAGO', driver: 77.40, repartidor: 65.20, helper: 45.60, km: null },
  { name: 'VENUSTIANO CARRANZA', driver: 77.40, repartidor: 65.20, helper: 48.64, km: null },
  { name: 'YURECUARO', driver: 61.92, repartidor: 48.90, helper: 36.48, km: null },
  { name: 'YURIDIA', driver: 92.88, repartidor: 81, helper: 60.80, km: null },
  { name: 'ZACAPU', driver: 87.72, repartidor: 71.72, helper: 54.72, km: null },
  { name: 'ZAMORA', driver: 120, repartidor: 100, helper: 100, km: null },
  { name: 'ZINAPECUARO', driver: 129, repartidor: 130.40, helper: 97.28, km: null },
  { name: 'ZITACUARO', driver: 129, repartidor: 130.40, helper: 97.28, km: null },
  { name: 'CARGA CAMION MEDIANO', driver: 30, repartidor: 0, helper: 30, km: null },
  { name: 'CARGA CAMION GRANDE', driver: 50, repartidor: 50, helper: 50, km: null },
  { name: 'CARGA NISSAN', driver: 30, repartidor: 0, helper: 0, km: null },
  { name: 'COJUMATLAN DE REGULES', driver: 94.12, repartidor: 0, helper: 65.88, km: 126.7 },
  { name: 'CELAYA', driver: 126.47, repartidor: 0, helper: 88.53, km: 145.9 },
  { name: 'COMONFORT', driver: 141.64, repartidor: 0, helper: 99.15, km: 163.4 },
  { name: 'CUERAMARO', driver: 58.68, repartidor: 0, helper: 41.08, km: 67.7 },
  { name: 'DOLORES HIDALGO', driver: 169.03, repartidor: 0, helper: 118.32, km: 195 },
  { name: 'IRAPUATO', driver: 74.63, repartidor: 0, helper: 52.24, km: 86.1 },
  { name: 'ROMITA GTO', driver: 90.23, repartidor: 0, helper: 63.16, km: 104.1 },
  { name: 'SAN FRANCISCO / PURISIMA DEL RINCON', driver: 73.68, repartidor: 0, helper: 51.58, km: 85 },
  { name: 'SAN MIGUEL DE ALLENDE', driver: 162.96, repartidor: 0, helper: 114.07, km: 188 },
  { name: 'AMECA JALISCO', driver: 267.25, repartidor: 0, helper: 187.07, km: 252.4 },
  { name: 'AUTLAN DE NAVARRO JAL', driver: 486.46, repartidor: 0, helper: 340.52, km: 358 },
  { name: 'CD. GUZMAN', driver: 311.19, repartidor: 0, helper: 217.83, km: 293.9 },
  { name: 'ENCARNACION DE DIAZ JAL', driver: 182.44, repartidor: 0, helper: 127.70, km: 172.3 },
  { name: 'SAN GABRIEL JAL', driver: 437.68, repartidor: 0, helper: 306.37, km: 322.1 },
  { name: 'SAN JUAN DE LOS LAGOS JAL', driver: 180.95, repartidor: 0, helper: 126.67, km: 170.9 },
  { name: 'SAN MIGUEL EL ALTO JAL', driver: 146.96, repartidor: 0, helper: 102.88, km: 138.8 },
  { name: 'TEPATITLAN', driver: 149.61, repartidor: 0, helper: 104.73, km: 141.3 },
  { name: 'TESISTAN', driver: 192.28, repartidor: 0, helper: 134.60, km: 181.6 },
  { name: 'UNION DE SAN ANTONIO', driver: 120.71, repartidor: 0, helper: 84.49, km: 114 },
  { name: 'YAHUALICA', driver: 209.54, repartidor: 0, helper: 146.68, km: 197.9 },
  { name: 'ZACOALCO DE TORRES', driver: 247.55, repartidor: 0, helper: 173.29, km: 233.8 },
  { name: 'ZAPOPAN', driver: 186.99, repartidor: 0, helper: 130.89, km: 176.6 },
  { name: 'ACAMBAY EDO MEX', driver: 367.96, repartidor: 0, helper: 257.57, km: 291.1 },
  { name: 'ATIZAPAN / ECATEPEC', driver: 478.69, repartidor: 0, helper: 335.08, km: 378.7 },
  { name: 'TEOLOYUCAN', driver: 450, repartidor: 0, helper: 315, km: 356 },
  { name: 'JILOTEPEC / CHAPA DE MOTA', driver: 399.68, repartidor: 0, helper: 279.78, km: 316.2 },
  { name: 'TULTITLAN', driver: 464.40, repartidor: 0, helper: 325.08, km: 367.4 },
  { name: 'CHALCO', driver: 547.08, repartidor: 0, helper: 382.95, km: 432.8 },
  { name: 'NEZAHUALCOYOTL', driver: 507.13, repartidor: 0, helper: 354.99, km: 401.2 },
  { name: 'APAXCO 10 TON', driver: 200, repartidor: 0, helper: 140, km: null },
  { name: 'APAXCO 15 TON', driver: 300, repartidor: 0, helper: 210, km: null },
  { name: 'APAXCO TON EXTRA', driver: 20, repartidor: 0, helper: 14, km: null },
  { name: 'TEXCOCO', driver: 500, repartidor: 0, helper: 350, km: null },
  { name: 'CUAUTITLAN IZCALLI', driver: 450, repartidor: 0, helper: 315, km: null },
  { name: 'CHICHIMEQUILLAS QRO', driver: 226.10, repartidor: 0, helper: 158.27, km: 226.1 },
  { name: 'QUERETARO', driver: 189.20, repartidor: 0, helper: 132.44, km: 189.2 },
  { name: 'BUENAVISTA QUERETARO', driver: 217, repartidor: 0, helper: 151.90, km: 217 },
  { name: 'IZTAPALAPA 1', driver: 400, repartidor: 0, helper: 280, km: null },
  { name: 'IZTAPALAPA 2', driver: 500, repartidor: 0, helper: 350, km: null },
  { name: 'SAN LUIS POTOSI', driver: 366.82, repartidor: 0, helper: 256.77, km: 300.8 },
  { name: 'VILLA DE REYES / BLEDOS SLP', driver: 298.77, repartidor: 0, helper: 209.14, km: 245 },
  { name: 'QUIROGA', driver: 143.39, repartidor: 0, helper: 100.37, km: 141 },
  { name: 'JUVENTINO ROSAS', driver: 114.59, repartidor: 0, helper: 80.21, km: 132.2 },
  { name: 'IXMIQUILPAN HGO', driver: 430.53, repartidor: 0, helper: 301.37, km: 340.6 },
  { name: 'NOCHISTLAN ZACATECAS', driver: 221.82, repartidor: 0, helper: 155.28, km: 209.5 },
  { name: 'TLALTENANGO ZACATECAS', driver: 466.08, repartidor: 0, helper: 326.25, km: 343 },
  { name: 'JALPA ZACATECAS', driver: 440.26, repartidor: 0, helper: 308.18, km: 324 },
  { name: 'GUADALAJARA - LERMA EDO MEX', driver: 619.38, repartidor: 0, helper: 433.57, km: 490 },
];

const PAYROLL_PERIODS_2026 = [
  { number: 1,  start: '2026-01-01', end: '2026-01-14', payment: '2026-01-17' },
  { number: 2,  start: '2026-01-15', end: '2026-01-28', payment: '2026-01-31' },
  { number: 3,  start: '2026-01-29', end: '2026-02-11', payment: '2026-02-14' },
  { number: 4,  start: '2026-02-12', end: '2026-02-25', payment: '2026-02-28' },
  { number: 5,  start: '2026-02-26', end: '2026-03-11', payment: '2026-03-14' },
  { number: 6,  start: '2026-03-12', end: '2026-03-25', payment: '2026-03-28' },
  { number: 7,  start: '2026-03-26', end: '2026-04-08', payment: '2026-04-11' },
  { number: 8,  start: '2026-04-09', end: '2026-04-22', payment: '2026-04-25' },
  { number: 9,  start: '2026-04-23', end: '2026-05-06', payment: '2026-05-09' },
  { number: 10, start: '2026-05-07', end: '2026-05-20', payment: '2026-05-23' },
  { number: 11, start: '2026-05-21', end: '2026-06-03', payment: '2026-06-06' },
  { number: 12, start: '2026-06-04', end: '2026-06-17', payment: '2026-06-20' },
  { number: 13, start: '2026-06-18', end: '2026-07-01', payment: '2026-07-04' },
  { number: 14, start: '2026-07-02', end: '2026-07-15', payment: '2026-07-18' },
  { number: 15, start: '2026-07-16', end: '2026-07-29', payment: '2026-08-01' },
  { number: 16, start: '2026-07-30', end: '2026-08-12', payment: '2026-08-15' },
  { number: 17, start: '2026-08-13', end: '2026-08-26', payment: '2026-08-29' },
  { number: 18, start: '2026-08-27', end: '2026-09-09', payment: '2026-09-12' },
  { number: 19, start: '2026-09-10', end: '2026-09-23', payment: '2026-09-26' },
  { number: 20, start: '2026-09-24', end: '2026-10-07', payment: '2026-10-10' },
  { number: 21, start: '2026-10-08', end: '2026-10-21', payment: '2026-10-24' },
  { number: 22, start: '2026-10-22', end: '2026-11-04', payment: '2026-11-07' },
  { number: 23, start: '2026-11-05', end: '2026-11-18', payment: '2026-11-21' },
  { number: 24, start: '2026-11-19', end: '2026-12-02', payment: '2026-12-05' },
  { number: 25, start: '2026-12-03', end: '2026-12-16', payment: '2026-12-19' },
  { number: 26, start: '2026-12-17', end: '2026-12-30', payment: '2027-01-02' },
];

const CONFIG_FINANCE = [
  // Factores por zona
  { key: 'factor_aguascalientes', category: 'factor', value: 0.60478, unit: 'pct', description: 'A AGUASCALIENTES' },
  { key: 'factor_michoacan', category: 'factor', value: 1.01695, unit: 'pct', description: 'A URUAPAN' },
  { key: 'factor_jalisco_zacatecas', category: 'factor', value: 1.05882, unit: 'pct', description: 'A GDL Y ZAC.' },
  { key: 'factor_guanajuato', category: 'factor', value: 0.86681, unit: 'pct', description: 'PROM GTO Y LEON' },
  { key: 'factor_slp', category: 'factor', value: 1.2195, unit: 'pct', description: 'A LA CAPITAL S.L.P.' },
  { key: 'factor_queretaro', category: 'factor', value: 1.0000, unit: 'pct', description: 'QRO' },
  { key: 'factor_edomex_cdmx', category: 'factor', value: 1.26404, unit: 'pct', description: 'A TEOLOYUCAN' },
  // Costos KM por vehículo
  { key: 'costo_km_international', category: 'costo_km', value: 7.64, unit: 'mxn/km', description: 'INTERNATIONAL' },
  { key: 'costo_km_international_ii', category: 'costo_km', value: 8.09, unit: 'mxn/km', description: 'INTERNATIONAL II' },
  { key: 'costo_km_freightliner_std', category: 'costo_km', value: 5.92, unit: 'mxn/km', description: 'FREIGHTLINER STD' },
  { key: 'costo_km_freightliner_auto', category: 'costo_km', value: 5.89, unit: 'mxn/km', description: 'FREIGHTLINER AUTO' },
  { key: 'costo_km_hino_500', category: 'costo_km', value: 23.53, unit: 'mxn/km', description: 'HINO 500' },
  { key: 'costo_km_international_iii', category: 'costo_km', value: 17.16, unit: 'mxn/km', description: 'INTERNATIONAL III' },
  { key: 'costo_km_international_city_star', category: 'costo_km', value: 7.12, unit: 'mxn/km', description: 'INTERNATIONAL CITY STAR' },
  { key: 'costo_km_kodiak', category: 'costo_km', value: 11.47, unit: 'mxn/km', description: 'KODIAK' },
  { key: 'costo_km_f350', category: 'costo_km', value: 4.05, unit: 'mxn/km', description: 'F-350' },
  { key: 'costo_km_f450', category: 'costo_km', value: 4.91, unit: 'mxn/km', description: 'F-450' },
  { key: 'costo_km_nissan_fz0437b', category: 'costo_km', value: 4.53, unit: 'mxn/km', description: 'NISSAN FZ0437B' },
  { key: 'costo_km_ram_4000_zamora', category: 'costo_km', value: 7.14, unit: 'mxn/km', description: 'RAM 4000 ZAMORA' },
  { key: 'costo_km_ram_4000_morelia', category: 'costo_km', value: 7.07, unit: 'mxn/km', description: 'RAM 4000 MORELIA' },
  { key: 'costo_km_nissan_jv05705', category: 'costo_km', value: 6.28, unit: 'mxn/km', description: 'NISSAN JV05705' },
  // Tarifas Maniobra
  { key: 'tarifa_maniobra_carga', category: 'tarifa_maniobra', value: 30.00, unit: 'mxn', description: 'Carga por persona' },
  { key: 'tarifa_maniobra_descarga', category: 'tarifa_maniobra', value: 1.00, unit: 'mxn', description: 'Descarga por caja' },
];

// ───────────────────────── helpers ─────────────────────────

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--')) {
      const [k, v] = raw.slice(2).split('=');
      args[k.replace(/-/g, '_')] = v ?? true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node database/importers/logistics_baseline.js --tenant-slug=<slug> [--dry-run]

Loads (UPSERT idempotente):
  - 105 destinos en logistics.routes
  - 26 períodos catorcenales 2026 en logistics.payroll_periods
  - 22 parámetros financieros en logistics.config_finance

Origen: _imported/logistica/database/seeds/01b_logistica_seed.js (real Mega Dulces).
`);
}

async function setCtx(trx, tenantId) {
  await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();
  if (!args.tenant_slug) {
    console.error('ERROR: --tenant-slug requerido');
    printHelp();
    process.exit(1);
  }

  const knexCfg = require('../knexfile-newdb.js').development;
  const knex = knexLib(knexCfg);

  try {
    const tenant = await knex('public.tenants').where({ slug: args.tenant_slug, activo: true }).first();
    if (!tenant) throw new Error(`Tenant slug "${args.tenant_slug}" no encontrado o inactivo`);
    console.log(`[logistics_baseline] tenant: ${tenant.slug} (${tenant.id})`);

    if (args.dryRun) {
      console.log(`[DRY RUN] Would upsert: ${DESTINOS.length} destinos, ${PAYROLL_PERIODS_2026.length} períodos, ${CONFIG_FINANCE.length} config_finance`);
      return;
    }

    let summary = { routes: 0, periods: 0, config: 0 };

    await knex.transaction(async (trx) => {
      await setCtx(trx, tenant.id);

      // 1. Destinos → logistics.routes (UPSERT por tenant + name)
      for (const d of DESTINOS) {
        await trx.raw(
          `
          INSERT INTO logistics.routes
            (tenant_id, name, driver_commission, helper_commission, estimated_km, active)
          VALUES (?, ?, ?, ?, ?, true)
          ON CONFLICT ON CONSTRAINT logistics_routes_tenant_name_unique
          DO UPDATE SET
            driver_commission = EXCLUDED.driver_commission,
            helper_commission = EXCLUDED.helper_commission,
            estimated_km = EXCLUDED.estimated_km,
            updated_at = now()
          `,
          [tenant.id, d.name, d.driver, d.helper, d.km],
        );
        summary.routes++;
      }

      // 2. Períodos → logistics.payroll_periods (UPSERT por tenant + year + number)
      for (const p of PAYROLL_PERIODS_2026) {
        await trx.raw(
          `
          INSERT INTO logistics.payroll_periods
            (tenant_id, number, year, start_date, end_date, payment_date, status)
          VALUES (?, ?, 2026, ?, ?, ?, 'abierto')
          ON CONFLICT ON CONSTRAINT logistics_payroll_periods_tenant_year_number_unique
          DO UPDATE SET
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            payment_date = EXCLUDED.payment_date,
            updated_at = now()
          `,
          [tenant.id, p.number, p.start, p.end, p.payment],
        );
        summary.periods++;
      }

      // 3. Config finance (UPSERT por tenant + key)
      for (const c of CONFIG_FINANCE) {
        await trx.raw(
          `
          INSERT INTO logistics.config_finance
            (tenant_id, key, category, description, value, unit, active)
          VALUES (?, ?, ?, ?, ?, ?, true)
          ON CONFLICT ON CONSTRAINT logistics_config_finance_tenant_key_unique
          DO UPDATE SET
            category = EXCLUDED.category,
            description = EXCLUDED.description,
            value = EXCLUDED.value,
            unit = EXCLUDED.unit,
            updated_at = now()
          `,
          [tenant.id, c.key, c.category, c.description, c.value, c.unit],
        );
        summary.config++;
      }
    });

    console.log('[logistics_baseline] OK:', summary);
  } catch (e) {
    console.error('[logistics_baseline] ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main();
