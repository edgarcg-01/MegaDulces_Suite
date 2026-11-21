#!/usr/bin/env node
/**
 * [GP.A.2] La bitácora de la autorización de pedidos TELEMARK — lo que la Suite escribe en SU base (Kepler no se toca).
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * Las verificaciones viven en `_lib/bitacora-autorizacion.js` (las comparte la simulación contra prod con ROLLBACK).
 * Regla 13: un endpoint que ESCRIBE no está probado hasta que su escritura corre contra una base real. Aquí, como
 * `app_runtime` (el rol de prod, con RLS), en una transacción que se REVIERTE, con las sentencias LEÍDAS DEL SERVICIO
 * (`autorizacion-decision.service.ts`) y los valores que arma con el cuerpo del panel ({ accion, motivo }):
 *
 *  1. **Autorizar**: la fila nace `pendiente` y se cierra `escrito` con lo que contestó Kepler; cerrarla otra vez no
 *     toca nada (el `WHERE estado = 'pendiente'`).
 *  2. **Dos escrituras a la vez** del mismo pedido: la segunda choca con el índice único (23505).
 *  3. **Rechazar / escalar** nacen `registrado` y no pueden nacer `pendiente`.
 *  4. **La que se quedó a medias** (`VENCER_PENDIENTES`): con el plazo vencido se cierra `rechazado`; dentro del
 *     plazo, no (control).
 *  5. **Regresar (D-A7)**: `ULTIMA_AUTORIZACION` encuentra la autorización vigente y deja de encontrarla cuando hay un
 *     regreso escrito después.
 *  6. **Negativas de la tabla**: sin motivo, automática que no es autorizar, automática con persona, acción inventada;
 *     `app_runtime` no puede borrar.
 *  7. **El interruptor** acepta `autorizacion` (9 apagados, sin tope: D-A14) sin perder los tipos previos; **la llave**
 *     `FINANCE_PEDIDOS_AUTORIZAR` quedó en `credito_cobranza` y en nadie más fuera de superadmin.
 *  8. **RLS**: con otro tenant no se ve nada.
 *
 * ⚠️ Sin la tabla (migración 20261120145451 sin aplicar) reporta NO MEDIDO, nunca ✔.
 * ⛔ No se corre contra producción: exige `assert-safe-target` como las demás.
 */
const { Client } = require('pg');
const { verificarBitacora } = require('./_lib/bitacora-autorizacion');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-autorizacion-pedidos', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  const dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[GP.A.2] bitácora de la autorización de pedidos  —  ${dest.u}@${dest.d}\n`);

  const hay = (await c.query(`SELECT to_regclass('finance.order_authorizations') IS NOT NULL a`)).rows[0];
  if (!hay.a) {
    NM('finance.order_authorizations no existe (migración 20261120145451 sin aplicar)');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
    await c.end();
    process.exit(0);
  }
  await c.query('BEGIN');
  try {
    await verificarBitacora(c, { P, F, NM }, { tenant: TENANT, otro: OTRO, usuario: dest.u });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
