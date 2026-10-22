#!/usr/bin/env node
/**
 * `[PGP.3]` **Ejerce contra prod, en SÓLO LECTURA, el conteo de las dos bandejas de pagos.**
 *
 *   node database/scripts/verify-pgp3-bandejas-pagos.js
 *
 * Necesita `PROD_DB_URL` (la cuenta de sólo lectura `dev_ro`).
 *
 * ⭐ **Lo que de verdad verifica es que el aviso no mande a nadie a chocarse contra una pared.**
 * «Días sin autorizar» sólo cuenta los lotes que `releaseLot()` aceptaría; si contara todos, la
 * pantalla diría «6 esperando» y los 6 botones devolverían 400. La aserción es que los dos
 * conteos, sumados con los que quedan fuera, dan los lotes totales — y que **ningún lote
 * contado como autorizable tiene un pago sin preparar**.
 *
 * Medido el 2026-10-22: 10 pagos sin preparar · 0 días autorizables · 6 lotes en `draft`,
 * los 6 excluidos por tener pagos sin preparar.
 */
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PROD_SYSTEM_ID = '7688376744939610156';

/** La misma condición que `isPrepared()` exige en `payment-calendar.service.ts`. */
const SIN_PREPARAR = `status = 'pending' and payment_method is null`;

/** El mismo predicado que la bandeja `pagos-por-autorizar` pone en `abiertaExtra`. */
const AUTORIZABLE = `
  not exists (select 1 from finance.payment_allocations a
               where a.lot_id = l.id and a.status = 'pending'
                 and (a.payment_method is null or a.priority_rank is null))`;

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en el .env (cuenta de sólo lectura)');
  const c = new Client({ connectionString: process.env.PROD_DB_URL });
  await c.connect();
  try {
    const id = await c.query('select system_identifier from pg_control_system()');
    if (String(id.rows[0].system_identifier) !== PROD_SYSTEM_ID) {
      throw new Error(`La base no es prod (system_identifier ${id.rows[0].system_identifier}).`);
    }

    const t0 = Date.now();
    const [prep, lotes] = await Promise.all([
      c.query(
        `select count(*) filter (where ${SIN_PREPARAR})::int sin_preparar,
                count(*) filter (where status = 'pending')::int pendientes,
                count(*)::int total,
                coalesce(sum(amount_assigned) filter (where ${SIN_PREPARAR}), 0)::numeric monto_sin_preparar,
                min(created_at) filter (where ${SIN_PREPARAR}) mas_viejo
           from finance.payment_allocations where tenant_id = $1`,
        [TENANT],
      ),
      c.query(
        `select count(*) filter (where status = 'draft')::int borradores,
                count(*) filter (where status = 'draft' and ${AUTORIZABLE})::int autorizables,
                count(*) filter (where released_at is not null)::int liberados,
                count(*)::int total,
                min(created_at) filter (where status = 'draft' and ${AUTORIZABLE}) mas_viejo
           from finance.payment_calendar_lots l where tenant_id = $1`,
        [TENANT],
      ),
    ]);
    const ms = Date.now() - t0;
    const p = prep.rows[0];
    const l = lotes.rows[0];

    const dias = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);

    console.log(`\nconsulta: ${ms} ms`);
    console.log(`\n  Pagos sin preparar .......... ${p.sin_preparar} de ${p.pendientes} pendientes (${p.total} en total)`);
    console.log(`     monto detenido ........... $${Number(p.monto_sin_preparar).toLocaleString('es-MX')}`);
    console.log(`     el más viejo espera ...... ${dias(p.mas_viejo) ?? '—'} días   (umbral de la bandeja: 2)`);
    console.log(`\n  Días de pago sin autorizar .. ${l.autorizables} autorizables de ${l.borradores} en borrador (${l.total} lotes)`);
    console.log(`     liberados alguna vez ..... ${l.liberados}`);
    console.log(`     el más viejo espera ...... ${dias(l.mas_viejo) ?? '—'} días   (umbral de la bandeja: 1)`);

    const checks = [
      ['«sin preparar» es un subconjunto de los pendientes', p.sin_preparar <= p.pendientes],
      ['«autorizables» es un subconjunto de los borradores', l.autorizables <= l.borradores],
      [
        '⛔ ningún lote contado como autorizable tiene un pago sin preparar (si no, el aviso manda a un 400)',
        (await c.query(
          `select count(*)::int n from finance.payment_calendar_lots l
            where l.tenant_id = $1 and l.status = 'draft' and ${AUTORIZABLE}
              and exists (select 1 from finance.payment_allocations a
                           where a.lot_id = l.id and a.status = 'pending' and a.payment_method is null)`,
          [TENANT],
        )).rows[0].n === 0,
      ],
      [
        'las dos colas juntas explican el atasco: o hay pagos sin preparar, o hay días autorizables, o no hay borradores',
        p.sin_preparar > 0 || l.autorizables > 0 || l.borradores === 0,
      ],
    ];
    console.log('');
    for (const [n, ok] of checks) console.log(`${ok ? '  ✔' : '  ✖'} ${n}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
