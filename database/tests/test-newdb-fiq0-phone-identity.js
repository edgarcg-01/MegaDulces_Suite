/* eslint-disable no-console */
/**
 * FIQ.0 (ADR-036) — Smoke identidad del contacto por teléfono. DB-direct, en UNA
 * transacción con ROLLBACK (no persiste). Verifica:
 *   1. public.mx_normalize_phone canónico == mirror JS (paridad SQL↔TS).
 *   2. Índices funcionales presentes.
 *   3. Lookup resolveCustomerByPhone: un cliente sembrado matchea SIN importar el
 *      formato de entrada (Meta 521 / 52 / +52 / 10 dígitos).
 *   4. Dedup de casual por teléfono normalizado (no duplica).
 *   5. Seed del mapa phone_number_id → tenant.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// Mirror EXACTO del util TS normalizeMxPhone (guarda paridad con la fn SQL).
function jsNormalize(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, '');
  d = d.replace(/^00/, '');
  if (!d) return null;
  if (d.length === 10) return '52' + d;
  if (d.length === 12 && d.startsWith('52')) return d;
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

(async () => {
  try {
    // ── Paridad SQL ↔ JS (fuera de trx, la fn es global) ──
    const cases = ['5213521111129', '523521111129', '+52 352 111 1129', '3521111129', '  521 352-111-1129 ', '00523521111129', '', 'abc', '18001234567'];
    for (const c of cases) {
      const r = await knex.raw('SELECT public.mx_normalize_phone(?) AS n', [c]);
      const sql = r.rows[0].n;
      const js = jsNormalize(c);
      ok(sql === js, `mx_normalize_phone(${JSON.stringify(c)}) SQL=${JSON.stringify(sql)} == JS=${JSON.stringify(js)}`);
    }
    // Los 4 formatos del mismo número → mismo canónico
    const canon = '523521111129';
    for (const v of ['5213521111129', '523521111129', '+523521111129', '3521111129']) {
      const r = await knex.raw('SELECT public.mx_normalize_phone(?) AS n', [v]);
      ok(r.rows[0].n === canon, `${v} → ${canon}`);
    }

    // ── Índices funcionales + seed del mapa (global) ──
    const idx = await knex.raw(`SELECT indexname FROM pg_indexes WHERE schemaname='commercial' AND indexname IN ('ix_customers_whatsapp_norm','ix_customers_phone_norm')`);
    ok(idx.rows.length === 2, 'índices funcionales ix_customers_whatsapp_norm + ix_customers_phone_norm');
    const map = await knex.raw(`SELECT tenant_id FROM whatsapp.phone_number_tenant_map WHERE phone_number_id='1256572530868591'`);
    ok(map.rows.length === 1 && map.rows[0].tenant_id === T, 'seed phone_number_tenant_map 1256572530868591 → mega_dulces');

    // ── Lookup + dedup dentro del tenant, con ROLLBACK ──
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // Cliente sembrado con whatsapp E.164 canónico (número improbable para no
      // chocar con data real; igual la trx hace ROLLBACK).
      const [cust] = await trx('commercial.customers')
        .insert({
          tenant_id: T,
          code: 'FIQ0-TEST-001',
          name: 'Cliente Prueba FIQ0',
          whatsapp: '+525500009999',
          is_casual: false,
        })
        .returning(['id', 'name']);
      ok(!!cust?.id, 'cliente de prueba insertado');

      // resolveCustomerByPhone (misma SQL del binding) con 4 formatos de entrada
      const resolve = async (input) => {
        const c = jsNormalize(input);
        return trx('commercial.customers')
          .whereNull('deleted_at')
          .andWhere((b) => {
            b.whereRaw('public.mx_normalize_phone(whatsapp) = ?', [c]).orWhereRaw('public.mx_normalize_phone(phone) = ?', [c]);
          })
          .orderBy('is_casual', 'asc')
          .orderBy('created_at', 'desc')
          .first('id', 'name');
      };
      for (const input of ['5215500009999', '525500009999', '+52 550 000 9999', '5500009999']) {
        const hit = await resolve(input);
        ok(hit && hit.id === cust.id, `resolveCustomerByPhone(${JSON.stringify(input)}) → ${cust.name}`);
      }
      // Número distinto → no matchea
      const miss = await resolve('5559998877');
      ok(!miss, 'número desconocido → no matchea');

      // Dedup de casual: 2do insert del mismo número (otro formato) NO debe crear
      // otro cliente (la lógica de resolveCustomer lo reusaría). Simulamos el lookup previo.
      const dedupHit = await resolve('52 1 550 000 9999');
      ok(dedupHit && dedupHit.id === cust.id, 'dedup: mismo número en formato Meta reusa el cliente existente');

      await trx.rollback(new Error('rollback intencional (smoke no persiste)'));
    }).catch((e) => { if (!/rollback intencional/.test(e.message)) throw e; });

    console.log(`\nFIQ.0 phone-identity: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e);
    await knex.destroy();
    process.exit(1);
  }
})();
