#!/usr/bin/env node
/**
 * [CXC.48] Teléfonos de la cartera — lo que la Suite escribe en SU base (Kepler no se toca aquí).
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * Regla 13: un endpoint que ESCRIBE no está probado hasta que su escritura corre contra una base real con el payload
 * de la pantalla. Aquí, como `app_runtime` (el rol de prod, con RLS), en una transacción que se REVIERTE:
 *
 *  1. **El teléfono del vendedor** (`commercial.seller_phones`): el upsert del servicio (leído del CÓDIGO) entra y,
 *     repetido, ACTUALIZA en vez de duplicar.
 *  2. **El rastro del cambio del cliente** (`finance.customer_phone_changes`): nace `pendiente` y se cierra `escrito`
 *     con lo que contestó cada base, como lo hace `cambiarCliente`.
 *  3. **El interruptor** acepta `telefono_cliente`, sembrado apagado en las 9 sucursales, y los tipos que ya existían
 *     siguen ahí (la migración rehace la restricción leyendo la vigente).
 *  4. **Negativas:** un teléfono de 9 dígitos lo rechaza el CHECK; un estado inventado, también; `app_runtime` no puede
 *     borrar el rastro.
 *  5. **RLS:** con otro tenant, ni el teléfono del vendedor ni el rastro se ven.
 *
 * ⚠️ Sin las tablas (migración sin aplicar) reporta NO MEDIDO, nunca ✔.
 * ⛔ No se corre contra producción: exige `assert-safe-target` como las demás.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'customer-ledger', 'cartera-telefonos.service.ts');
const TIPOS_PREVIOS = ['cancela_oc', 'cancela_requisicion', 'cancela_solicitud_gasto', 'cliente', 'compra',
  'comprobacion_gasto', 'solicitud_gasto', 'telemarketing', 'traspaso'];

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

/** El upsert del vendedor, tal como está en el servicio (con `?` → `$n`). */
function upsertDelServicio() {
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf('INSERT INTO commercial.seller_phones');
  const j = src.indexOf('updated_at = now()', i);
  if (i < 0 || j < 0) throw new Error('no encontré el upsert de seller_phones en el servicio');
  let n = 0;
  return src.slice(i, j + 'updated_at = now()'.length).replace(/\?/g, () => `$${++n}`);
}

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cartera-telefonos', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  const dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[CXC.48] teléfonos de la cartera  —  ${dest.u}@${dest.d}\n`);

  const hay = (await c.query(`SELECT to_regclass('commercial.seller_phones') IS NOT NULL a, to_regclass('finance.customer_phone_changes') IS NOT NULL b`)).rows[0];
  if (!hay.a || !hay.b) {
    NM('commercial.seller_phones / finance.customer_phone_changes no existen (migración 20261120125622 sin aplicar)');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
    await c.end();
    process.exit(0);
  }
  const upsert = upsertDelServicio();

  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

    // 3. El interruptor
    const def = (await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid = 'commercial.kepler_push_switch'::regclass AND conname = 'kepler_push_switch_tipo_ck'`)).rows[0]?.d || '';
    const tipos = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    if (tipos.includes('telefono_cliente')) P('el interruptor acepta telefono_cliente'); else F(`el CHECK no tiene telefono_cliente: ${tipos}`);
    const perdidos = TIPOS_PREVIOS.filter((t) => !tipos.includes(t));
    if (!perdidos.length) P('los tipos que ya existían siguen en la restricción'); else F(`la migración borró tipos: ${perdidos}`);
    const sw = (await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int on_ FROM commercial.kepler_push_switch WHERE tipo = 'telefono_cliente'`)).rows[0];
    if (sw.n === 9 && sw.on_ === 0) P('9 renglones telefono_cliente, todos apagados');
    else if (sw.n === 0) NM('sin renglones telefono_cliente en esta base (tenant sin sembrar)');
    else F(`telefono_cliente: ${sw.n} renglones, ${sw.on_} encendidos (se esperaban 9 y 0)`);

    // 1. El vendedor: el upsert del servicio entra y, repetido, actualiza
    await c.query(upsert, ['06', 'T-VEND-48', '3312345678', 'prueba', 'prueba']);
    await c.query(upsert, ['06', 'T-VEND-48', '3398765432', 'prueba2', 'prueba2']);
    const v = (await c.query(`SELECT count(*)::int n, max(telefono) t, max(updated_by) u FROM commercial.seller_phones WHERE vendedor_code = 'T-VEND-48'`)).rows[0];
    if (v.n === 1 && v.t === '3398765432' && v.u === 'prueba2') P('el upsert del vendedor actualiza (1 fila, el teléfono nuevo)');
    else F(`upsert del vendedor: ${JSON.stringify(v)}`);

    // 2. El rastro del cliente: pendiente → escrito
    const id = (await c.query(`INSERT INTO finance.customer_phone_changes (tenant_id, sucursal, cliente_code, telefono_anterior, telefono_nuevo, estado, created_by, updated_by)
      VALUES (current_tenant_id(), '06', 'T-CLI-48', NULL, '3311112222', 'pendiente', 'prueba', 'prueba') RETURNING id`)).rows[0].id;
    await c.query(`UPDATE finance.customer_phone_changes SET estado = 'escrito', resultado = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify({ servidores: [{ servidor: 'SC', estado: 'escrita', anterior: '', motivo: null }] })]);
    const r = (await c.query(`SELECT estado, resultado->'servidores'->0->>'estado' s FROM finance.customer_phone_changes WHERE id = $1`, [id])).rows[0];
    if (r.estado === 'escrito' && r.s === 'escrita') P('el rastro nace pendiente y se cierra escrito con el resultado por base');
    else F(`rastro: ${JSON.stringify(r)}`);

    // 4. Negativas
    const rechaza = async (nombre, sql, params) => {
      await c.query('SAVEPOINT n');
      try { await c.query(sql, params); F(`${nombre}: la base lo aceptó`); } catch { P(`${nombre}: rechazado`); }
      await c.query('ROLLBACK TO SAVEPOINT n');
    };
    await rechaza('teléfono de vendedor con 9 dígitos', upsert, ['06', 'T-VEND-49', '331234567', 'p', 'p']);
    await rechaza('estado inventado en el rastro', `UPDATE finance.customer_phone_changes SET estado = 'enviado' WHERE id = $1`, [id]);
    if (dest.u === 'app_runtime') {
      await c.query('SAVEPOINT d');
      const del = await c.query(`DELETE FROM finance.customer_phone_changes WHERE id = $1`, [id]).then(() => 'borró', (e) => e.code);
      await c.query('ROLLBACK TO SAVEPOINT d');
      if (del === '42501') P('app_runtime no puede borrar el rastro'); else F(`app_runtime borró o falló distinto: ${del}`);
    } else NM(`el DELETE de app_runtime (la sesión es ${dest.u})`);

    // 5. RLS
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
    const otro = (await c.query(`SELECT (SELECT count(*) FROM commercial.seller_phones WHERE vendedor_code = 'T-VEND-48')::int a,
                                        (SELECT count(*) FROM finance.customer_phone_changes WHERE cliente_code = 'T-CLI-48')::int b`)).rows[0];
    if (dest.u === 'app_runtime' || dest.u !== 'postgres') {
      if (otro.a === 0 && otro.b === 0) P('con otro tenant no se ve nada'); else F(`otro tenant ve: ${JSON.stringify(otro)}`);
    } else NM('RLS (la sesión es postgres: salta RLS)');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
