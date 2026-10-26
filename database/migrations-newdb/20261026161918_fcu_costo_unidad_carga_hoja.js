'use strict';
/**
 * `[FCU.0.2, 0.4, 0.5]` — Carga inicial desde la hoja «TRANSPORTES 2026 - COSTOS DE TRANSPORTE»:
 * la ficha de las 14 unidades, sus alias para reconocerlas en Kepler y su presupuesto 2026.
 *
 * Es el backfill único que la regla del proyecto permite (después, TODO se edita en pantalla:
 * Logística › Costo por unidad › Ficha y Presupuesto).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-26) ────────────────────────────────────────
 *  · La hoja tiene 15 bloques para 14 unidades: la UNIDAD 12 viene dos veces («RAM 4000» y «RAM
 *    4000 ZAMORA», mismo VIN y placas). Se carga «RAM 4000 ZAMORA»; el bloque genérico se descarta.
 *  · Cada unidad de la hoja, contra `logistics.vehicles` (por clave de Kepler cuando la tiene; si
 *    no, por la placa que trae su GPS):
 *      U1 International 1 → Kepler 00001 · U2 Hino 500 → 00006 · U3 International 2 → 00002 ·
 *      U4 International 3 → 00003 · U5 Freightliner estándar → 00005 · U6 Freightliner automático
 *      → 00004 · U7 City Star → GPS NL5485C (la hoja dice placas GN-6051) · U8 Kodiak → **no existe
 *      en Kepler ni en el GPS**: se da de alta con la placa de la hoja (GS7683B; ⚠️ GS7682B es un
 *      Nissan, no el Kodiak) · U9 F-350 → GPS MZ0108A (la 00007 «MZ0108» de Kepler NO es esta
 *      unidad: el GPS lo contradice, EMB.55) · U10 F-450 → 00008 (la hoja dice 77AH6V; Kepler
 *      774H6V) · U11 Nissan FZ0437B → 00021 · U12 RAM 4000 Zamora → GPS NG5962D · U13 RAM 4000
 *      Morelia → 00029 · U14 Nissan JV05705 → GPS JV05705.
 *  · Totales por unidad = suma de sus renglones (la hoja omite la comisión en 4 totales; aquí se
 *    cargan los RENGLONES, no los totales, así que ese error no entra).
 *  · Los alias se probaron contra los gastos X-A-10 de ene–26 oct: sugieren unidad en 556
 *    renglones ($1,113,317) y dejan 14 ambiguos ($14,701), todos textos que nombran 2 o 3 camiones.
 *
 * ── Lo que NO se carga, a propósito ─────────────────────────────────────────────────────────
 *  · El VIN de la F-350 y de la F-450: la hoja les pone el mismo (1FDEF3G6XEEB44435). Se captura en
 *    la Ficha cuando se sepa cuál es de cuál.
 *  · Las celdas sin rótulo de la hoja: nadie sabe qué calculan.
 *  · Nada que ya esté capturado: la ficha sólo se llena donde está vacía; el presupuesto no pisa una
 *    celda existente.
 *
 * ⚠️ Sólo hace UPDATE/INSERT: la compuerta del despliegue la clasifica NO_MEDIDO → se aplica a mano
 *    en prod ANTES de soltar, DESPUÉS de `20261026161917_fcu_costo_unidad_esquema.js`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[fcu_costo_unidad_carga_hoja]';
const M = '00000000-0000-0000-0000-00000000d01c';
const ANIO = 2026;
const NOTA = 'FCU: ficha cargada de la hoja TRANSPORTES 2026';

// Generado desde la hoja (CSV del 2026-10-26) por un extractor que suma sus renglones; ver la cabecera.
const UNIDADES = [
  {
    hoja: 'UNIDAD 1',
    nombre: 'INTERNATIONAL 1',
    kepler: '00001',
    placas_hoja: '55A- - B1M',
    vin: '3HAMSAZR3GL379068',
    anio: 2016,
    km_anio: 80000,
    seguro_vence: '2024-05-15',
    salario_mensual: 7566,
    alias: [
      'INTERNATIONAL 1',
      'INTERNACIONAL 1',
      'INTERNATIOINAL 1',
      'INTER 1',
      'C. SECA',
      'C.SECA',
      'CAJA SECA',
      '55AB1M'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 86555.81,
      pension: 9000,
      gps_magnitracking: 4000,
      gps_salvador: 2900,
      seguro: 42845,
      comisiones: 80000,
      salarios: 90792,
      mtto_preventivo: 76000,
      reparaciones: 90000,
      neumaticos: 40000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 2',
    nombre: 'HINO 500',
    kepler: '00006',
    placas_hoja: '67-BB-9C',
    vin: '3HJFL8JTXRS711277',
    anio: 2024,
    km_anio: 80000,
    seguro_vence: null,
    salario_mensual: 7566,
    alias: [
      'HINO',
      '67BB9C',
      '69BB9C'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 1500000,
      pension: 9000,
      gps_magnitracking: 4000,
      gps_salvador: 0,
      seguro: 33254.64,
      comisiones: 80000,
      salarios: 90792,
      mtto_preventivo: 30000,
      reparaciones: 10000,
      neumaticos: 40000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 3',
    nombre: 'INTERNATIONAL 2',
    kepler: '00002',
    placas_hoja: '06AU2M',
    vin: '3HAMSAZR4GL223847',
    anio: 2016,
    km_anio: 80000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'INTERNATIONAL 2',
      'INTERNACIONAL 2',
      'INTERNATIOINAL 2',
      'INTER 2',
      'CAJA LERMA',
      '06AU2M',
      'INTER LERMA',
      'INTERNATIONAL LERMA',
      'INTERNACIONAL LERMA',
      'INNTR LERMA'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 96173,
      pension: 9000,
      gps_magnitracking: 4000,
      gps_salvador: 2900,
      seguro: 76394.14,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 73000,
      reparaciones: 85900,
      neumaticos: 40000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 4',
    nombre: 'INTERNATIONAL 3',
    kepler: '00003',
    placas_hoja: '19AU5F',
    vin: '3GBM7H1C88M110537',
    anio: 2018,
    km_anio: 90000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'INTERNATIONAL 3',
      'INTERNACIONAL 3',
      'INTERNATIOINAL 3',
      'INTER 3',
      'RUDO',
      '19AU5F'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 1000000,
      pension: 9000,
      gps_magnitracking: 4000,
      gps_salvador: 0,
      seguro: 98937,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 60000,
      reparaciones: 72000,
      neumaticos: 40000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 5',
    nombre: 'FREIGHTLINER ESTÁNDAR',
    kepler: '00005',
    placas_hoja: '88-2-EW9',
    vin: '1FBACXCS47HY81710',
    anio: 2007,
    km_anio: 80000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'FREIGHTLINER STD',
      'FREIGHTLINER ESTANDAR',
      '882EW9',
      '882-EW9'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 48639,
      pension: 9000,
      gps_magnitracking: 4000,
      gps_salvador: 2900,
      seguro: 19130,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 40000,
      reparaciones: 50000,
      neumaticos: 40000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 6',
    nombre: 'FREIGHTLINER AUTOMÁTICO',
    kepler: '00004',
    placas_hoja: '46-AG-6H',
    vin: '1FVACWDT99HAK0711',
    anio: 2009,
    km_anio: 80000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'FREIGHTLINER AUTO',
      '46AG6H'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 2800,
      arrendamiento_depreciacion: 55588,
      pension: 9000,
      gps_magnitracking: 0,
      gps_salvador: 2900,
      seguro: 14000,
      comisiones: 80000,
      salarios: 90972,
      mtto_preventivo: 40000,
      reparaciones: 50000,
      neumaticos: 40000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 7',
    nombre: 'INTERNATIONAL CITY STAR',
    placa: 'NL5485C',
    placas_hoja: 'GN-6051',
    vin: '3JA1SCB25FK000230',
    anio: 2015,
    km_anio: 50000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'CITY STAR',
      'NL5485C',
      'GN-6051',
      'GN6051'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 0,
      pension: 9000,
      gps_magnitracking: 0,
      gps_salvador: 0,
      seguro: 25967,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 20000,
      reparaciones: 25000,
      neumaticos: 16000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 8',
    nombre: 'KODIAK',
    placa: 'GS7683B',
    crear: true,
    placas_hoja: 'GS7683B',
    vin: null,
    anio: 2006,
    km_anio: 25000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'KODIAK',
      'KIDIAK',
      'GS7683B'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 41691,
      pension: 9000,
      gps_magnitracking: 0,
      gps_salvador: 0,
      seguro: 10921,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 20000,
      reparaciones: 20000,
      neumaticos: 5000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 9',
    nombre: 'F-350',
    placa: 'MZ0108A',
    placas_hoja: 'MZ0108A',
    vin: null,
    anio: 2014,
    km_anio: 100000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'F-350',
      'F350',
      'FORD 350',
      'MZ0108A'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 20845,
      pension: 9000,
      gps_magnitracking: 0,
      gps_salvador: 2900,
      seguro: 11364,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 35000,
      reparaciones: 48000,
      neumaticos: 18000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 10',
    nombre: 'F-450',
    kepler: '00008',
    placas_hoja: '77AH6V',
    vin: null,
    anio: 2014,
    km_anio: 80000,
    seguro_vence: '2024-04-02',
    salario_mensual: 7581,
    alias: [
      '774H6V',
      '77AH6V'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 3600,
      arrendamiento_depreciacion: 20845,
      pension: 4500,
      gps_magnitracking: 0,
      gps_salvador: 2900,
      seguro: 6509.08,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 35000,
      reparaciones: 45000,
      neumaticos: 18000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 11',
    nombre: 'NISSAN FZ0437B',
    kepler: '00021',
    placas_hoja: 'FZ0437B',
    vin: '3N6DD25X5FK076237',
    anio: 2015,
    km_anio: 70000,
    seguro_vence: '2024-06-21',
    salario_mensual: 7581,
    alias: [
      'FZ0437B'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 2200,
      arrendamiento_depreciacion: 0,
      pension: 4500,
      gps_magnitracking: 0,
      gps_salvador: 2900,
      seguro: 11004,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 16000,
      reparaciones: 16000,
      neumaticos: 8000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 12',
    nombre: 'RAM 4000 ZAMORA',
    placa: 'NG5962D',
    placas_hoja: 'GV3268C',
    vin: '3C7WRAKT3NG376291',
    anio: 2022,
    km_anio: 90000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'RAM 4000 ZAMORA',
      'NG5962D',
      'GV3268C'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 2200,
      arrendamiento_depreciacion: 288000,
      pension: 4500,
      gps_magnitracking: 0,
      gps_salvador: 2900,
      seguro: 24407,
      salarios: 90972,
      comisiones: 90000,
      mtto_preventivo: 26000,
      reparaciones: 20000,
      neumaticos: 8000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 13',
    nombre: 'RAM 4000 MORELIA',
    kepler: '00029',
    placas_hoja: 'GV3267C',
    vin: '3C7WRAKT5NG376292',
    anio: 2022,
    km_anio: 90000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'RAM 4000 MORELIA',
      'NH9181D',
      'GV3267C'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 2200,
      arrendamiento_depreciacion: 288000,
      pension: 4500,
      gps_magnitracking: 0,
      gps_salvador: 2900,
      seguro: 24407,
      salarios: 90972,
      comisiones: 80000,
      mtto_preventivo: 28000,
      reparaciones: 22000,
      neumaticos: 8000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  },
  {
    hoja: 'UNIDAD 14',
    nombre: 'NISSAN JV05705',
    placa: 'JV05705',
    placas_hoja: 'JV05705',
    vin: '3N6AD35A6HK818491',
    anio: 2017,
    km_anio: 70000,
    seguro_vence: null,
    salario_mensual: 7581,
    alias: [
      'JV05705'
    ],
    presupuesto: {
      placas_refrendo_verificacion: 2200,
      arrendamiento_depreciacion: 133111,
      pension: 0,
      gps_magnitracking: 0,
      gps_salvador: 0,
      seguro: 0,
      salarios: 90972,
      comisiones: 90000,
      mtto_preventivo: 14000,
      reparaciones: 16000,
      neumaticos: 8000,
      lubricantes: 3600,
      gastos_directos: 0,
      sueldos_admin: 82000
    }
  }
];

const normPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function unidadDe(knex, u) {
  if (u.kepler) {
    const { rows } = await knex.raw(
      `SELECT id FROM logistics.vehicles WHERE tenant_id = ?::uuid AND kepler_code = ? AND deleted_at IS NULL`, [M, u.kepler]);
    return rows.length === 1 ? rows[0].id : null;
  }
  const { rows } = await knex.raw(
    `SELECT id FROM logistics.vehicles WHERE tenant_id = ?::uuid AND deleted_at IS NULL
        AND regexp_replace(upper(plate), '[^A-Z0-9]', '', 'g') = ?`, [M, normPlaca(u.placa)]);
  return rows.length === 1 ? rows[0].id : null;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('logistics').hasTable('fleet_cost_budget'))) {
    throw new Error(`${TAG} falta 20261026161917_fcu_costo_unidad_esquema.js`);
  }
  const { rows: t } = await knex.raw(`SELECT 1 FROM identity.tenants WHERE id = ?::uuid`, [M]);
  if (!t.length) { console.log(`${TAG} sin el tenant de Mega Dulces: nada que cargar`); return; }

  let creadas = 0, fichas = 0, montos = 0;
  const faltan = [];
  for (const u of UNIDADES) {
    let id = await unidadDe(knex, u);
    if (!id && u.crear) {
      const { rows } = await knex.raw(
        `INSERT INTO logistics.vehicles (tenant_id, plate, brand, model, status, active, notes)
         VALUES (?::uuid, ?, '', ?, 'disponible', true, ?) RETURNING id`,
        [M, u.placa, u.nombre, `${NOTA}: ${u.hoja} no existe en Kepler ni en el GPS; alta con la placa de la hoja. Confirmar si sigue en la flota.`]);
      id = rows[0].id; creadas++;
    }
    if (!id) { faltan.push(`${u.hoja} ${u.nombre}`); continue; }

    // La ficha: sólo donde está vacía (lo capturado en pantalla manda).
    const r = await knex.raw(
      `UPDATE logistics.vehicles SET
          economic_number       = coalesce(economic_number, ?),
          display_name          = coalesce(display_name, ?),
          vin                   = coalesce(vin, ?),
          year                  = coalesce(year, ?),
          fleet_area            = coalesce(fleet_area, 'transportes'),
          budget_km_year        = coalesce(budget_km_year, ?),
          insurance_expires_on  = coalesce(insurance_expires_on, ?::date),
          driver_monthly_salary = coalesce(driver_monthly_salary, ?),
          kepler_aliases        = CASE WHEN cardinality(kepler_aliases) = 0 THEN ?::text[] ELSE kepler_aliases END,
          notes                 = CASE WHEN coalesce(notes, '') LIKE '%' || ? || '%' THEN notes
                                       ELSE coalesce(notes || ' · ', '') || ? END,
          updated_at            = now()
        WHERE tenant_id = ?::uuid AND id = ?`,
      [u.hoja, u.nombre, u.vin, u.anio, u.km_anio, u.seguro_vence, u.salario_mensual, u.alias,
        NOTA, `${NOTA} (${u.hoja}; placas en la hoja: ${u.placas_hoja})`, M, id]);
    fichas += r.rowCount;

    for (const [rubro, amount] of Object.entries(u.presupuesto)) {
      const ins = await knex.raw(
        `INSERT INTO logistics.fleet_cost_budget (tenant_id, vehicle_id, anio, rubro, amount, source, notes)
         VALUES (?::uuid, ?, ?, ?, ?, 'hoja_2026', ?)
         ON CONFLICT (tenant_id, vehicle_id, anio, rubro) WHERE deleted_at IS NULL DO NOTHING`,
        [M, id, ANIO, rubro, amount, `${u.hoja} · ${u.nombre}`]);
      montos += ins.rowCount;
    }
  }
  console.log(`${TAG} ${fichas} fichas · ${creadas} unidad(es) dadas de alta · ${montos} montos de presupuesto ${ANIO}`
    + (faltan.length ? ` · ⚠️ SIN unidad en la Suite: ${faltan.join(', ')}` : ''));
};

/** Deshace EXACTAMENTE lo que hizo el `up`: el presupuesto de la hoja y el alta del Kodiak. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('logistics').hasTable('fleet_cost_budget')) {
    await knex.raw(`DELETE FROM logistics.fleet_cost_budget WHERE tenant_id = ?::uuid AND source = 'hoja_2026'`, [M]);
  }
  // La ficha no se vacía: pudo editarse en pantalla después. El Kodiak dado de alta aquí se da de baja lógica.
  await knex.raw(
    `UPDATE logistics.vehicles SET deleted_at = now(), active = false, updated_at = now()
      WHERE tenant_id = ?::uuid AND deleted_at IS NULL AND notes LIKE ? AND kepler_code IS NULL`,
    [M, `${NOTA}: UNIDAD 8 no existe en Kepler ni en el GPS%`]);
};
