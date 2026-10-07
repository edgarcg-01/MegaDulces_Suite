/**
 * `[AU.20]` — Aide Piceno ve sólo Morelia: Abastos y Madero.
 *
 * ── Qué pasaba ────────────────────────────────────────────────────────────
 *
 * No tenía alcance propio, así que heredaba el de su rol `compras_operaciones`,
 * que es `warehouse: all`. En `/compras/entradas` y `/compras/entradas/control`
 * veía **las 9 sucursales**, incluido el CEDIS con sus 9,156 entradas.
 *
 * ── La trampa que hace que esto NO sea obvio (`[RE.23]`) ───────────────────
 *
 * Las dos Morelias resuelven su llave de sucursal por caminos DISTINTOS, y hay
 * una tercera fila que confunde:
 *
 *   MD-30  «Almacén Morelia Abastos (30)»  wincaja_source_branch='30'  VIVA  -> 30
 *   07     «Morelia Madero»                wincaja_source_branch=NULL  VIVA  -> 07
 *   MD-32  «Almacén Morelia Madero (32)»   wincaja_source_branch='32'  BORRADA
 *
 * O sea el alcance es **['30','07']**, no `['MD-30','MD-32']` ni `['30','32']`.
 * Medido contra los datos que la pantalla lee de verdad
 * (`analytics.erp_goods_receipts.sucursal`): `30` tiene 2,519 entradas, `07`
 * tiene 16, y **`32` no aparece nunca** — el Madero vivo es `07`.
 *
 * ⛔ Va por PERSONA y no por rol aunque hoy sea la única con `compras_operaciones`:
 * el alcance por rol no tiene pantalla (`DEUDA-AU-SCOPEROL`) y dárselo al rol
 * se lo daría en silencio al próximo que lo reciba.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USUARIO = 'aide_piceno';
const SUCURSALES = ['30', '07'];

const NOTA =
  '[AU.20] Encargada de operaciones de Morelia: ve su plaza y nada más. Las llaves son 30 ' +
  '(Abastos, que la resuelve por wincaja_source_branch) y 07 (Madero, que la resuelve por code); ' +
  'MD-32 esta borrada y no tiene una sola entrada. Decidido por Direccion, 2026-09-15.';

exports.up = async function up(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .whereNull('deleted_at')
    .first('id', 'username', 'role_name');
  if (!u) throw new Error(`[AU.20] No existe "${USUARIO}".`);

  // Las llaves tienen que existir en lo que la pantalla lee. Un alcance sobre un
  // valor que no existe no recorta: deja a la persona sin ver NADA y parece un bug.
  const { rows: reales } = await knex.raw(
    `SELECT sucursal, count(*)::int AS entradas
       FROM analytics.erp_goods_receipts
      WHERE tenant_id = ? AND sucursal = ANY (?)
      GROUP BY sucursal ORDER BY sucursal`,
    [TENANT, SUCURSALES],
  );
  const vistas = reales.map((r) => r.sucursal);
  const faltan = SUCURSALES.filter((s) => !vistas.includes(s));
  if (faltan.length) {
    throw new Error(
      `[AU.20] La(s) llave(s) ${faltan.join(', ')} no aparecen en erp_goods_receipts: ` +
        `el alcance dejaría a ${USUARIO} sin ver nada. Se revierte.`,
    );
  }

  const fila = {
    tenant_id: TENANT,
    user_id: u.id,
    dimension: 'warehouse',
    mode: 'listed',
    values: SUCURSALES,
    mode_write: null,
    nota: NOTA,
    updated_by: null,
    updated_at: knex.fn.now(),
  };
  await knex('identity.user_scopes')
    .insert({ ...fila, created_by: null })
    .onConflict(['tenant_id', 'user_id', 'dimension'])
    .merge(fila);

  await knex('identity.user_events').insert({
    tenant_id: TENANT,
    user_id: u.id,
    event: 'scope_changed',
    detalle: JSON.stringify({
      dimension: 'warehouse',
      de: { mode: 'all', origen: `rol ${u.role_name}` },
      a: { mode: 'listed', values: SUCURSALES },
      criterio: NOTA,
      origen: 'migracion_AU.20',
    }),
    actor_username: 'migracion [AU.20]',
  });

  const { rows: despues } = await knex.raw(
    `SELECT us.mode, us.values,
            (SELECT count(*)::int FROM analytics.erp_goods_receipts g
              WHERE g.tenant_id = us.tenant_id AND g.sucursal = ANY (us.values)) AS entradas_que_vera,
            (SELECT count(*)::int FROM analytics.erp_goods_receipts g
              WHERE g.tenant_id = us.tenant_id) AS entradas_totales
       FROM identity.user_scopes us
      WHERE us.tenant_id = ? AND us.user_id = ? AND us.dimension = 'warehouse'`,
    [TENANT, u.id],
  );
  const d = despues[0];
  if (!d || d.mode !== 'listed') throw new Error('[AU.20] El alcance no quedó escrito.');

  console.log(
    `[AU.20] ${USUARIO} · warehouse = ${d.mode} ${JSON.stringify(d.values)} · ` +
      `ve ${d.entradas_que_vera} de ${d.entradas_totales} entradas ` +
      `(${Math.round((d.entradas_que_vera / d.entradas_totales) * 100)}%)`,
  );
};

exports.down = async function down(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .first('id');
  if (!u) return;
  await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: 'warehouse' })
    .del();
};
