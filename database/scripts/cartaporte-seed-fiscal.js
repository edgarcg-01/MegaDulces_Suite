/**
 * J12.0 (C) — Plantilla de captura de datos fiscales para Carta Porte.
 *
 * Llena el bloque CONFIG con los datos REALES de Mega Dulces y corré:
 *   node cartaporte-seed-fiscal.js            # dry-run (muestra qué haría)
 *   node cartaporte-seed-fiscal.js --apply    # escribe
 *
 * Siembra:
 *   1. logistics.carrier_fiscal_profile  — emisor/transportista (1 fila/tenant)
 *   2. commercial.warehouses.fiscal_address — domicilio de origen (por code)
 *   3. logistics.vehicles fiscales       — config SAT + seguros (por placa)
 *
 * Idempotente (UPSERT del perfil; UPDATE por placa/code). Guard: rechaza --apply
 * si quedan placeholders (RFC genérico / textos PLACEHOLDER).
 *
 * Conexión: DATABASE_URL_NEW (.env) o default localhost:5433. Tenant: mega_dulces.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

// ════════════ EDITA AQUÍ CON DATOS REALES ════════════
const EMISOR = {
  rfc: 'XAXX010101000',                 // ← RFC fiscal de Mega Dulces
  legal_name: 'PLACEHOLDER RAZON SOCIAL',// ← razón social como aparece en el SAT
  regimen_fiscal: '601',                // ← 601 General PM · 626 RESICO · etc.
  cp_expedicion: '59300',               // ← CP del CEDIS de expedición
  sct_permit_type: 'TPAF01',            // ← tipo de permiso SCT (autotransporte federal)
  sct_permit_number: 'PLACEHOLDER',     // ← número de permiso SCT
  fiscal_address: {
    street: 'PLACEHOLDER', exterior_number: '', neighborhood: '',
    city: '', state: '', zip: '59300', country: 'MEX',
  },
};

// Domicilio fiscal del/los almacén(es) de origen, por `code` de commercial.warehouses
const ORIGIN_WAREHOUSES = {
  // '02': { street:'', exterior_number:'', neighborhood:'', city:'', state:'', zip:'', country:'MEX' },
};

// Datos fiscales por placa de vehículo
const VEHICLES = [
  // { plate:'ABC-1234', sat_config_vehicular:'C2', gross_weight_kg:8000, insurance_carrier:'GNP', insurance_policy:'POL-123' },
];
// ══════════════════════════════════════════════════════

const APPLY = process.argv.includes('--apply');
const CONN = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.CP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

function placeholdersPresent() {
  const bad = [];
  if (EMISOR.rfc === 'XAXX010101000') bad.push('EMISOR.rfc');
  if (/PLACEHOLDER/.test(EMISOR.legal_name)) bad.push('EMISOR.legal_name');
  if (/PLACEHOLDER/.test(EMISOR.sct_permit_number)) bad.push('EMISOR.sct_permit_number');
  if (/PLACEHOLDER/.test(EMISOR.fiscal_address.street)) bad.push('EMISOR.fiscal_address.street');
  return bad;
}

(async () => {
  const knex = knexLib({ client: 'pg', connection: CONN, pool: { min: 1, max: 2 } });
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔎 DRY-RUN (usa --apply para escribir)'} · tenant ${TENANT}\n`);
  console.log('Emisor:', EMISOR.rfc, '·', EMISOR.legal_name);
  console.log('Almacenes origen:', Object.keys(ORIGIN_WAREHOUSES).join(', ') || '(ninguno)');
  console.log('Vehículos:', VEHICLES.map((v) => v.plate).join(', ') || '(ninguno)');

  const bad = placeholdersPresent();
  if (APPLY && bad.length) {
    console.error(`\n❌ No aplico: quedan placeholders → ${bad.join(', ')}\n   Edita el bloque CONFIG con datos reales.`);
    await knex.destroy(); process.exit(2);
  }
  if (!APPLY) { console.log('\nDry-run: nada escrito.', bad.length ? `(placeholders pendientes: ${bad.join(', ')})` : ''); await knex.destroy(); return; }

  // 1. Emisor (UPSERT por tenant)
  const existing = await knex('logistics.carrier_fiscal_profile').where({ tenant_id: TENANT }).first();
  const payload = {
    rfc: EMISOR.rfc.toUpperCase(), legal_name: EMISOR.legal_name,
    regimen_fiscal: EMISOR.regimen_fiscal, cp_expedicion: EMISOR.cp_expedicion,
    sct_permit_type: EMISOR.sct_permit_type, sct_permit_number: EMISOR.sct_permit_number,
    fiscal_address: JSON.stringify(EMISOR.fiscal_address), updated_at: knex.fn.now(),
  };
  if (existing) await knex('logistics.carrier_fiscal_profile').where({ id: existing.id }).update(payload);
  else await knex('logistics.carrier_fiscal_profile').insert({ tenant_id: TENANT, ...payload });
  console.log(`✅ Emisor ${existing ? 'actualizado' : 'creado'}.`);

  // 2. Almacenes origen
  for (const [code, addr] of Object.entries(ORIGIN_WAREHOUSES)) {
    const r = await knex('commercial.warehouses')
      .where({ tenant_id: TENANT, code })
      .update({ fiscal_address: JSON.stringify(addr), updated_at: knex.fn.now() });
    console.log(`  almacén ${code}: ${r ? 'OK' : 'no encontrado'}`);
  }

  // 3. Vehículos por placa
  for (const v of VEHICLES) {
    const r = await knex('logistics.vehicles')
      .where({ tenant_id: TENANT, plate: v.plate })
      .update({
        sat_config_vehicular: v.sat_config_vehicular ?? null,
        gross_weight_kg: v.gross_weight_kg ?? null,
        insurance_carrier: v.insurance_carrier ?? null,
        insurance_policy: v.insurance_policy ?? null,
        updated_at: knex.fn.now(),
      });
    console.log(`  unidad ${v.plate}: ${r ? 'OK' : 'no encontrada'}`);
  }

  console.log('\n✅ Datos fiscales sembrados.');
  await knex.destroy();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
