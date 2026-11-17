#!/usr/bin/env node
/**
 * [CXC.43] Contactos de cobranza — `finance.collection_contacts`, la escritura que deja el ACTO.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * La ficha de `/finanzas/cartera` registra un contacto al tocar «Llamar», «Enviar por WhatsApp» o
 * «Estado de cuenta (PDF)» (POST `:sucursal/:cliente/contact` con `{ canal }`). La lista lo lee
 * para mostrar «contactado hoy». Regla 13: un endpoint que ESCRIBE no está probado hasta que su
 * escritura corre contra una base real con el payload de la pantalla. Aquí, como `app_runtime`
 * (el rol de prod, con RLS):
 *
 *  1. **El insert del servicio entra** con los tres canales de la pantalla, y devuelve la fecha en
 *     ISO UTC (lo que la pantalla parsea).
 *  2. **El CHECK y la lista del servicio dicen lo mismo:** los canales de `CANALES_CONTACTO` (leídos
 *     del CÓDIGO) son exactamente los del CHECK. Si divergen, la pantalla ofrecería un canal que la
 *     base rechaza — un 500 que sólo aparece al tocar el botón.
 *  3. **Negativas:** un canal desconocido lo rechaza el CHECK; sin sucursal, el NOT NULL; y
 *     `app_runtime` NO puede editar ni borrar un contacto (sólo SELECT/INSERT).
 *  4. **RLS:** con otro tenant, el contacto no se ve.
 *  5. **La lectura de la lista** (el SQL de `ultimosContactos`, leído del servicio) devuelve el
 *     ÚLTIMO contacto por cuenta.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin la tabla (migración sin aplicar) reporta NO MEDIDO, nunca ✔.
 * ⛔ No se corre contra producción: exige `assert-safe-target` como las demás.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'customer-ledger', 'customer-ledger.service.ts');

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

function delServicio() {
  const src = fs.readFileSync(SRC, 'utf8');
  const lista = src.match(/CANALES_CONTACTO: CanalContacto\[\] = \[([^\]]*)\]/);
  const i = src.indexOf('SELECT DISTINCT ON (sucursal, cliente_code)');
  const j = src.indexOf('contacted_at DESC', i);
  if (!lista || i < 0 || j < 0) throw new Error('no se encontró CANALES_CONTACTO o el SQL de ultimosContactos en el servicio');
  return {
    canales: [...lista[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    sqlUltimos: src.slice(i, j + 'contacted_at DESC'.length).replace('?', '$1'),
  };
}

// Escribe (dentro de una transacción que se revierte), así que nunca contra producción.
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cartera-contactos', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  const dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[CXC.43] contactos de cobranza  —  ${dest.u}@${dest.d}\n`);

  const existe = (await c.query(`SELECT to_regclass('finance.collection_contacts') IS NOT NULL ok`)).rows[0].ok;
  if (!existe) {
    NM('finance.collection_contacts no existe (migración 20261117135602 sin aplicar)');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
    await c.end();
    process.exit(0);
  }
  const { canales, sqlUltimos } = delServicio();

  // 2. El CHECK y el servicio dicen lo mismo.
  const chk = (await c.query(`
    SELECT pg_get_constraintdef(oid) def FROM pg_constraint
     WHERE conrelid = 'finance.collection_contacts'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%canal%'`)).rows[0]?.def || '';
  const enCheck = [...chk.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  if (JSON.stringify(enCheck) === JSON.stringify(canales)) P(`los canales del servicio = los del CHECK (${canales.join(', ')})`);
  else F(`el servicio ofrece [${canales}] y el CHECK acepta [${enCheck}]`);

  await c.query('BEGIN');
  const sp = async (nombre, fn) => {
    await c.query(`SAVEPOINT ${nombre}`);
    try { return await fn(); } finally { await c.query(`ROLLBACK TO SAVEPOINT ${nombre}`); }
  };
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const ins = `INSERT INTO finance.collection_contacts (tenant_id, sucursal, cliente_code, canal, created_by, updated_by)
                 VALUES (current_tenant_id(), $1, $2, $3, 'prueba', 'prueba')
                 RETURNING id, canal, to_char(contacted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS contacted_at`;

    // 1. Los tres canales de la pantalla entran, y la fecha sale en ISO.
    let ultimo = null;
    for (const canal of ['telefono', 'estado_cuenta_pdf', 'whatsapp']) {
      const r = (await c.query(ins, ['ZZ', 'CXC43-PRUEBA', canal])).rows[0];
      if (r?.canal === canal && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.contacted_at)) ultimo = r;
      else F(`el insert con canal=${canal} no devolvió lo esperado: ${JSON.stringify(r)}`);
      await c.query(`SELECT pg_sleep(0.01)`);
    }
    if (ultimo) P('los 3 canales de la pantalla entran como app_runtime y la fecha sale en ISO UTC');

    // 5. La lectura de la lista da el ÚLTIMO.
    const u = (await c.query(sqlUltimos, [TENANT])).rows.filter((x) => x.cliente_code === 'CXC43-PRUEBA');
    if (u.length === 1 && u[0].canal === 'whatsapp') P('ultimosContactos (SQL del servicio) devuelve UNA fila por cuenta: la última (whatsapp)');
    else F(`ultimosContactos devolvió ${JSON.stringify(u)}`);

    // 3. Negativas.
    await sp('canal_malo', async () => {
      try { await c.query(ins, ['ZZ', 'CXC43-PRUEBA', 'fax']); F('un canal desconocido («fax») entró'); }
      catch (e) { if (e.code === '23514') P('prueba negativa: canal «fax» lo rechaza el CHECK'); else F(`«fax» falló por otra cosa: ${e.code} ${e.message}`); }
    });
    await sp('sin_suc', async () => {
      try { await c.query(ins, [null, 'CXC43-PRUEBA', 'whatsapp']); F('un contacto sin sucursal entró'); }
      catch (e) { if (e.code === '23502') P('prueba negativa: sin sucursal lo rechaza el NOT NULL'); else F(`sin sucursal falló por otra cosa: ${e.code}`); }
    });
    if (dest.u === 'app_runtime') {
      await sp('editar', async () => {
        try { await c.query(`UPDATE finance.collection_contacts SET canal = 'telefono' WHERE cliente_code = 'CXC43-PRUEBA'`); F('app_runtime pudo EDITAR un contacto'); }
        catch (e) { if (e.code === '42501') P('prueba negativa: app_runtime no puede editar un contacto'); else F(`editar falló por otra cosa: ${e.code}`); }
      });
      await sp('borrar', async () => {
        try { await c.query(`DELETE FROM finance.collection_contacts WHERE cliente_code = 'CXC43-PRUEBA'`); F('app_runtime pudo BORRAR un contacto'); }
        catch (e) { if (e.code === '42501') P('prueba negativa: app_runtime no puede borrar un contacto'); else F(`borrar falló por otra cosa: ${e.code}`); }
      });
    } else {
      NM(`permisos de app_runtime: la prueba corrió como ${dest.u} (falta DATABASE_URL_NEW_RUNTIME)`);
    }

    // 4. RLS.
    await sp('rls', async () => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
      const n = (await c.query(`SELECT count(*)::int n FROM finance.collection_contacts WHERE cliente_code = 'CXC43-PRUEBA'`)).rows[0].n;
      if (dest.u !== 'app_runtime' && n > 0) NM('RLS: como superusuario la política no aplica; corre con DATABASE_URL_NEW_RUNTIME');
      else if (n === 0) P('RLS: con otro tenant, el contacto no se ve');
      else F(`RLS: otro tenant ve ${n} contactos ajenos`);
    });
  } finally {
    await c.query('ROLLBACK');
  }

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
