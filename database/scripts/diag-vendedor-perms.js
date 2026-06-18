/* eslint-disable no-console */
/**
 * Diagnóstico read-only: permisos REALES del rol 'vendedor' en la DB (no el seed).
 * Decide si el flujo del vendedor sufre 403 en runtime. Replica lo que ve el guard.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const url = process.env.DATABASE_URL || process.env.DATABASE_URL_NEW_RUNTIME;
const knex = require('knex')({ client: 'pg', connection: url });
const MEGA = '00000000-0000-0000-0000-00000000d01c';

// Permisos que el flujo del vendedor exige (FE rutas + BE endpoints)
const FLOW_PERMS = [
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_ORDERS_CREAR',
  'COMMERCIAL_ORDERS_CONFIRMAR',
  'COMMERCIAL_ORDERS_FULFILL',
  'COMMERCIAL_ORDERS_CANCELAR',
  'VISITAS_REGISTRAR',
  'CAPTURE_TICKET_USE', // OCR ticket + vendor-sales
  'ROUTE_TICKET_CAPTURE', // cierre de ruta
  'ROUTE_CONTROL_VER', // reportes de ruta
  'SUPERVISOR_AI_VER', // tareas Horus de campo
];

(async () => {
  try {
    const rows = await knex('role_permissions').where({ role_name: 'vendedor' }).select('*');
    console.log(`Filas role_permissions['vendedor']: ${rows.length}`);
    for (const r of rows) {
      const p = r.permissions || {};
      const n = Object.keys(p).filter((k) => p[k]).length;
      const isMega = r.tenant_id === MEGA;
      console.log(`\n— tenant_id=${r.tenant_id}${isMega ? ' (MEGA DULCES)' : ''} · ${n} permisos true`);
      for (const perm of FLOW_PERMS) {
        const ok = p[perm] === true;
        console.log(`    ${ok ? '✓' : '✗ FALTA'}  ${perm}`);
      }
    }
    if (rows.length === 0) console.log('❌ No hay rol "vendedor" en role_permissions');
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await knex.destroy();
  }
})();
