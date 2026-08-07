/**
 * Política de descuento por proveedor — DECLARADA por Tesorería.
 *
 * Fuente: workbook manual "PROGRAMA PAGOS 2026.xlsx", hoja PROVEEDORES, columnas
 * DÍAS DE CRÉDITO + DESCUENTO PP. Solo 5 proveedores traen descuento PP declarado.
 *
 * UPSERT idempotente sobre `commercial.supplier_discount_policy` (llave = código
 * Kepler `proveedor_code`, el mismo que cargan los espejos `analytics.erp_*`).
 * `source='manual'` (declarado) REFINA la tasa ciega `observed=0.0741` que el
 * detector usaba por defecto, y aporta `discount_days` (hoy null en todas).
 *
 * Los códigos se verificaron 1:1 contra analytics.erp_supplier_payments
 * (proveedor_nombre + monto dominante). Ver [[reference_programa_pagos_2026_workbook]].
 *
 * Env: DATABASE_URL_NEW · TENANT_ID (default mega_dulces). Read-only sobre el Excel;
 * no lee el archivo (valores curados) para no depender de su ruta.
 */
const { Client } = require('pg');
require('dotenv').config();

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// proveedor_code (Kepler) → { nombre, rate (fracción), days }  — del Programa de Pagos 2026
const POLICY = [
  { code: 'CA023', nombre: 'AGROALIMENTOS SANTOYO SPR DE RL', rate: 0.03, days: 21 },
  { code: 'CC022', nombre: 'COSPOR DISTRIBUCIONES S.A. DE C.V.', rate: 0.08, days: 15 },
  { code: 'CD015', nombre: 'DISTRIBUIDORA DE LA ROSA SA DE CV', rate: 0.02, days: 20 },
  { code: 'CL001', nombre: 'LA COCULENSE S.A.', rate: 0.06, days: 15 },
  { code: 'CP009', nombre: 'PRODUCTOS ALIMENTICIOS PAF SA DE CV', rate: 0.02, days: 30 },
];

(async () => {
  const pg = new Client({ connectionString: DST });
  await pg.connect();
  await pg.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT]);

  let upserted = 0;
  for (const p of POLICY) {
    const before = await pg.query(
      `SELECT expected_discount_rate, discount_days, source FROM commercial.supplier_discount_policy WHERE tenant_id=$1 AND proveedor_code=$2`,
      [TENANT, p.code],
    );
    const prev = before.rows[0]
      ? `${before.rows[0].expected_discount_rate}/${before.rows[0].discount_days ?? '-'}d/${before.rows[0].source}`
      : '(nueva)';
    await pg.query(
      `INSERT INTO commercial.supplier_discount_policy
         (tenant_id, proveedor_code, proveedor_nombre, expected_discount_rate, discount_days, discount_type, source, notes, active, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pronto_pago','manual','Programa de Pagos 2026 (declarado Tesorería)',true,'import-supplier-discount-policy',now())
       ON CONFLICT (tenant_id, proveedor_code) DO UPDATE SET
         proveedor_nombre = EXCLUDED.proveedor_nombre,
         expected_discount_rate = EXCLUDED.expected_discount_rate,
         discount_days = EXCLUDED.discount_days,
         discount_type = 'pronto_pago',
         source = 'manual',
         notes = EXCLUDED.notes,
         active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [TENANT, p.code, p.nombre, p.rate, p.days],
    );
    upserted++;
    console.log(`  ${p.code} ${p.nombre.slice(0, 34).padEnd(34)} ${prev.padEnd(22)} → ${p.rate}/${p.days}d/manual`);
  }

  console.log(`\nOK — ${upserted} políticas declaradas (source=manual) cargadas al tenant ${TENANT}.`);
  await pg.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
