#!/usr/bin/env node
/**
 * [CC.20] La ficha de depósito que sube el CLIENTE (migración 20261117153156) — lo que la base sostiene.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **Entra la ficha del cliente** (origen 'cliente', SIN folio: todavía no hay cobro en Kepler), como `app_runtime`,
 *     con las columnas que escribe `CustomerDepositsService.enviar`.
 *  2. **Negativa:** la ficha de OFICINA sin folio la rechaza el CHECK (la de oficina siempre va ligada a un cobro).
 *  3. **Negativa:** un origen desconocido lo rechaza el CHECK.
 *  4. **Ligar** (lo que hace `ligar`): ponerle sucursal/folio del cobro y dejarla validada; `cuenta_sucursal` no cambia.
 *  5. **El enlace:** sin renglón no hay versión (=1); renovar sube la versión (upsert); `app_runtime` NO puede borrar.
 *  6. **RLS:** con otro tenant, ni la ficha ni el enlace se ven.
 *
 * Todo en UNA transacción que se revierte. Sin la migración reporta NO MEDIDO. ⛔ Contra producción se NIEGA.
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-deposito-cliente', { url: DST });
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  const yo = (await c.query('SELECT current_user u')).rows[0].u;
  console.log(`\n[CC.20] ficha de depósito del cliente — como ${yo}\n`);
  const hay = (await c.query(`SELECT to_regclass('finance.customer_deposit_links') IS NOT NULL AS l,
     EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'collection_deposits' AND column_name = 'origen') AS o`)).rows[0];
  if (!hay.l || !hay.o) { NM('sin la migración 20261117153156'); return fin(c); }

  await c.query('BEGIN');
  const sp = async (n, fn) => { await c.query(`SAVEPOINT ${n}`); try { return await fn(); } finally { await c.query(`ROLLBACK TO SAVEPOINT ${n}`); } };
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    // 1. La ficha del cliente, con las columnas del servicio.
    const ins = `INSERT INTO finance.collection_deposits (tenant_id, origen, sucursal, cuenta_sucursal, folio, cliente_code, cliente_nombre,
        files, ocr_monto, ocr_fecha, ocr_banco, ocr_referencia, ocr_status, monto_match, reported_monto, reported_fecha, reported_nota, status, created_by)
      VALUES (public.current_tenant_id(), $1, 'ZZ', 'ZZ', $2, 'CC20-PRUEBA', 'Cliente de prueba', $3::jsonb, 12500, '2026-11-15', 'BBVA', '123',
        'ok', true, 12500, '2026-11-15', 'pago', 'recibido', 'cliente:ZZ/CC20-PRUEBA')
      RETURNING id, status, folio`;
    const files = JSON.stringify([{ role: 'deposito', url: 'finance/x/customer-deposits/a.jpg', sha256: 'h1' }]);
    const r = (await c.query(ins, ['cliente', null, files])).rows[0];
    if (r?.status === 'recibido' && r.folio === null) P('la ficha del cliente entra sin folio y queda «recibido»');
    else F(`la ficha del cliente no entró como se esperaba: ${JSON.stringify(r)}`);

    // 2 y 3. Negativas del CHECK.
    await sp('oficina', async () => {
      try { await c.query(ins, ['oficina', null, files]); F('una ficha de OFICINA sin folio entró'); }
      catch (e) { e.code === '23514' ? P('prueba negativa: la ficha de oficina sin folio la rechaza el CHECK') : F(`oficina sin folio falló por otra cosa: ${e.code} ${e.message}`); }
    });
    await sp('origen', async () => {
      try { await c.query(ins, ['whatsapp', 'X1', files]); F('un origen desconocido entró'); }
      catch (e) { e.code === '23514' ? P('prueba negativa: un origen desconocido lo rechaza el CHECK') : F(`origen desconocido falló por otra cosa: ${e.code}`); }
    });

    // Doble envío: la búsqueda por huella del archivo (files @> [{sha256}]) encuentra la que ya estaba.
    const dup = (await c.query(`SELECT count(*)::int n FROM finance.collection_deposits
       WHERE origen = 'cliente' AND cuenta_sucursal = 'ZZ' AND cliente_code = 'CC20-PRUEBA' AND files @> $1::jsonb`,
      [JSON.stringify([{ sha256: 'h1' }])])).rows[0].n;
    dup === 1 ? P('la misma foto se reconoce por su huella (para no duplicar el envío)') : F(`la búsqueda por huella encontró ${dup}`);

    // 4. Ligar al cobro.
    const l = (await c.query(`UPDATE finance.collection_deposits SET sucursal = '00', folio = '9001', status = 'validado', linked_at = now(), linked_by = 'prueba'
       WHERE id = $1 AND origen = 'cliente' RETURNING sucursal, folio, cuenta_sucursal, status`, [r.id])).rows[0];
    (l?.folio === '9001' && l.cuenta_sucursal === 'ZZ' && l.status === 'validado')
      ? P('ligar le pone el cobro (otra sucursal) y conserva la cuenta del cliente') : F(`ligar: ${JSON.stringify(l)}`);

    // 5. El enlace.
    const up = `INSERT INTO finance.customer_deposit_links (tenant_id, sucursal, cliente_code, version, created_by, updated_by)
      VALUES (current_tenant_id(), 'ZZ', 'CC20-PRUEBA', 2, 'prueba', 'prueba')
      ON CONFLICT (tenant_id, sucursal, cliente_code) DO UPDATE SET version = finance.customer_deposit_links.version + 1
      RETURNING version`;
    const v1 = (await c.query(up)).rows[0].version; const v2 = (await c.query(up)).rows[0].version;
    (v1 === 2 && v2 === 3) ? P('renovar el enlace sube la versión (2 → 3): los enlaces viejos dejan de servir') : F(`versiones ${v1}, ${v2}`);
    if (yo === 'app_runtime') {
      await sp('borrar', async () => {
        try { await c.query(`DELETE FROM finance.customer_deposit_links WHERE cliente_code = 'CC20-PRUEBA'`); F('app_runtime pudo BORRAR un enlace'); }
        catch (e) { e.code === '42501' ? P('prueba negativa: app_runtime no puede borrar un enlace') : F(`borrar falló por otra cosa: ${e.code}`); }
      });
    } else NM(`permisos de app_runtime: corrió como ${yo}`);

    // 6. RLS.
    await sp('rls', async () => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
      const a = (await c.query(`SELECT count(*)::int n FROM finance.collection_deposits WHERE cliente_code = 'CC20-PRUEBA'`)).rows[0].n;
      const b = (await c.query(`SELECT count(*)::int n FROM finance.customer_deposit_links WHERE cliente_code = 'CC20-PRUEBA'`)).rows[0].n;
      if (yo !== 'app_runtime' && (a || b)) NM('RLS: como superusuario la política no aplica');
      else (a === 0 && b === 0) ? P('RLS: con otro tenant no se ven ni la ficha ni el enlace') : F(`RLS: otro tenant ve ${a} fichas y ${b} enlaces`);
    });
  } finally {
    await c.query('ROLLBACK');
  }
  return fin(c);
})().catch((e) => { console.error(e); process.exit(1); });

async function fin(c) {
  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
}
