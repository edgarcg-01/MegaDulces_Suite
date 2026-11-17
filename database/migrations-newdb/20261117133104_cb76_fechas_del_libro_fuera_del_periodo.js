'use strict';
/**
 * `[CB.76]` — 32 movimientos del libro de bancos con la fecha mal capturada vuelven a su día real.
 *
 * La carga del libro no comparaba la fecha contra el periodo (corregido en el mismo item: lo que cae a más de 10 días
 * del mes ya no entra y se dice). Antes de eso entraron tres bloques —cada uno, un solo día del libro— con un año o un
 * mes imposibles. Viven en el estado de cuenta correcto, pero con esa fecha quedaban fuera de su mes en todo lo que
 * agrupa por fecha (Movimientos, «hasta qué día ve» el Cierre, los pases por fecha del motor de conciliación).
 *
 * ── Lo medido antes (prod, sólo lectura, identidad 7688376744939610156, 2026-11-17) ─────────────────────────────────
 *  · 32 renglones vivos a más de un mes de su periodo; ninguno entre 8 y 31 días; 47 a 1–7 días (legítimos, no se tocan).
 *  · La fecha real, con DOS testigos independientes que coinciden (regla 10: no se adivina):
 *      - la cadena de saldos del libro: el primer renglón de cada bloque viene del saldo del día anterior y el último
 *        da el saldo del que parte el día siguiente;
 *      - el documento de Kepler con que casaron (donde casaron).
 *
 *      estado de cuenta | fecha capturada | renglones | anterior   | siguiente  | Kepler     | fecha real
 *      2026-02          | 0206-02-25      |     6     | 2026-02-24 | 2026-02-26 | —          | 2026-02-25
 *      2026-08          | 2027-08-06      |    17     | 2026-08-05 | 2026-08-07 | 2026-08-06 | 2026-08-06
 *      2026-10          | 2026-01-01      |     9     | —          | 2026-10-02 | 2026-10-01 | 2026-10-01
 *
 * Por `id` (los 32, leídos de prod): el `up` toca exactamente esas filas y sólo si todavía tienen la fecha mala; el `down`
 * las regresa a la fecha capturada. Idempotente. No cambia importes, categorías ni pareos: sólo la fecha.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA a todo el equipo hasta que alguien
 *    la aplique a mano. Aplicala ANTES de mergear (`apply-one-migration-prod.js`).
 *
 * @param { import("knex").Knex } knex
 */

const CORRECCIONES = [
  { mala: '0206-02-25', buena: '2026-02-25', ids: ['873d206e-c9dd-45e6-b23e-10d68fd819ab', '89144be8-f62c-43c5-8ba1-32b690a09c64', '93a38deb-8f63-4259-9864-ca8b902209a9', '9b6e41c7-f046-457c-babb-c864decb5134', 'abda9445-26b6-4880-b668-cc1bad559b63', 'e4c0a81b-e30c-42cd-8a44-2548b1135949'] },
  { mala: '2027-08-06', buena: '2026-08-06', ids: ['026d28b8-057b-4711-95c0-2f5be473013d', '051be851-3528-4971-8e0e-968d524be93c', '1329cd05-3f77-4dc3-9abe-0b3267e89cfc', '1d19db28-c877-47ea-bdd1-2a499c95ab70', '2a385f4b-a537-4901-bf62-928b2a277af7', '359f7595-12d0-49c0-8731-cb78b42984a9', '36e3366d-efb5-4a9d-a10b-c23a687d8464', '3f543b63-ccd1-47ad-9bc2-114f833a2bf3', '5f8cc759-36b9-440d-8e06-95aa1420edac', '6772c14e-fbc9-4524-8c4c-1d20f9955cf6', '6b0fe96a-c2b4-4bfb-bc7c-a62a99612c84', '7b5ce6ed-c82e-40db-a074-cb0e2057a29f', '872f91c6-d116-484e-be88-e8170fe67be6', '87a2f378-8ccb-4631-a01e-19afd7a16976', 'a31a1345-b151-45bd-aed7-9ecbe1a47bdb', 'c9c1b290-db06-4ea2-9e89-f95745036bd1', 'fad4af66-8749-4e4b-874c-ee437664f69a'] },
  { mala: '2026-01-01', buena: '2026-10-01', ids: ['1e68a728-02ab-4161-9619-63b955a7cfe5', '2077c3e2-84bc-424a-b22f-18ace8767467', '44195cbe-3057-4d00-bf9d-cb28fc6681a0', '56816a46-6fec-497a-8f52-cc76303b0211', '77622d67-bc4f-4395-aa79-798421cbebb5', '7d23992b-fe06-48b6-83eb-f709aa8169c7', 'c1ee95e0-b2ea-46d6-af8e-27dd64dc5dfc', 'f0176239-de22-4ca2-8f25-61d263143e67', 'f6275edf-3276-43ec-a607-fd4b2140da7c'] },
];

const TENANT = '00000000-0000-0000-0000-00000000d01c';

async function mover(knex, de, a) {
  if (!(await knex.schema.withSchema('finance').hasTable('bank_movements'))) return 0;
  // ⛔ RLS FORZADO en finance.bank_movements (medido en prod): sin el tenant fijado el UPDATE toca CERO filas y no
  // da error — la migración «pasaría» sin corregir nada.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  let total = 0;
  for (const c of CORRECCIONES) {
    const n = await knex('finance.bank_movements').where('tenant_id', TENANT).whereIn('id', c.ids).where('movement_date', c[de])
      .update({ movement_date: c[a], updated_at: knex.fn.now() });
    total += n;
    // eslint-disable-next-line no-console
    console.log(`[CB.76] ${c[de]} → ${c[a]}: ${n} de ${c.ids.length}`);
  }
  return total;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable('bank_movements'))) return;
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  const todos = CORRECCIONES.flatMap((c) => c.ids);
  // Cuántas de las 32 existen en ESTA base (en prod, 32; en una base de pruebas, ninguna o una copia vieja). Se dice en
  // el log: quien la aplique en prod tiene que leer «32 de 32» (si lee 0, el tenant no quedó fijado: RLS).
  const [{ n: visibles }] = await knex('finance.bank_movements').where('tenant_id', TENANT).whereIn('id', todos).count({ n: '*' });
  console.log(`[CB.76] en esta base se ven ${visibles} de ${todos.length}`); // eslint-disable-line no-console
  if (Number(visibles) === 0) return;
  await mover(knex, 'mala', 'buena');
  const [{ n: quedan }] = await knex('finance.bank_movements').where('tenant_id', TENANT)
    .where((q) => { for (const c of CORRECCIONES) q.orWhere((w) => w.whereIn('id', c.ids).where('movement_date', c.mala)); })
    .count({ n: '*' });
  if (Number(quedan) > 0) throw new Error(`[CB.76] quedan ${quedan} con la fecha mala: no se corrigió`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await mover(knex, 'buena', 'mala');
};
