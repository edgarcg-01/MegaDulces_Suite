/**
 * `[ZN.6.1]` — Aide Piceno vuelve a ver sus DOS plazas de Morelia.
 *
 * ── El pedido ──────────────────────────────────────────────────────────────
 * *«aide piceno es de morelia abastos pero casi siempre observa la información
 * de morelia madero»*. O sea: Abastos (`08`) **y** Madero (`07`).
 *
 * ── ⛔ Esto NO es una configuración nueva: es una que se perdió ──────────────
 * La bitácora (`identity.user_events`) lo cuenta completo, y vale la pena
 * leerla antes de tocar nada:
 *
 *   09-15 08:27  migracion [AU.20]  all            → listed ['30','07']   ✔ la intención original
 *   09-19 13:42  superoot           listed         → listed ['07','30']   (reordenó, sin cambio)
 *   09-21 14:19  superoot           listed ['07','08'] → **all**          ⛔ perdió el recorte
 *   09-21 14:19  superoot           all            → all                  (guardado sin cambio)
 *   09-30 17:27  superoot           all            → **own**              ⛔ se quedó con UNA
 *
 * `[AU.20]` ya había resuelto esto el 15-sep con el criterio de Dirección, y
 * entre el `'30'` de entonces y el `'08'` de hoy sólo cambió el corte de POS
 * (Abastos pasó de Wincaja a Kepler). Lo que rompió el alcance fueron dos
 * ediciones a mano.
 *
 * ⚠️ **Y la última ocurrió 80 minutos antes de escribir esto.** `own` resuelve
 * a UN solo valor —el `warehouse_code` de la ficha, que es `08`— así que
 * Madero quedó afuera: *«sólo lo suyo» no puede expresar dos plazas*. Es
 * probable que saliera de intentar arreglar justamente esto desde la pantalla,
 * que hasta `[ZN.6]` **sólo ofrecía lo que la persona ya tenía** y por lo tanto
 * no dejaba agregar la segunda.
 *
 * ── Por qué una migración y no un UPDATE ───────────────────────────────────
 * El dato operativo se administra en `/admin/*` (regla de Edgar), y ésta es la
 * excepción declarada: la pantalla todavía no puede hacerlo porque `[ZN.6]`
 * está en código sin desplegar. Va versionado, con candado y con `down()` que
 * es inverso de verdad — no un `delete`, que la dejaría heredando el
 * `warehouse: all` de su rol, o sea el estado del 21-sep que ya se descartó.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USUARIO = 'aide_piceno';
const SUCURSALES = ['07', '08'];

const NOTA =
  '[ZN.6.1] Opera Morelia: Abastos (08) es su plaza y Madero (07) lo mira a diario. ' +
  'Reemplaza el modo "su ficha", que sólo puede expresar UNA sucursal y dejaba Madero afuera. ' +
  'Restituye el criterio de [AU.20] (Direccion, 2026-09-15) con las llaves de hoy: el 30 de ' +
  'Abastos paso a 08 con el corte de POS. Pedido por el usuario, 2026-09-30.';

/** La llave canónica de la dimensión `warehouse` — `branchKeySql()` de `scope.types.ts`. */
const LLAVE = `CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END`;

exports.up = async function up(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .whereNull('deleted_at')
    .first('id', 'username', 'role_name');
  if (!u) throw new Error(`[ZN.6.1] No existe "${USUARIO}".`);

  // ── Candado 1: las llaves existen en el UNIVERSO de la dimensión ──────────
  // Un alcance sobre un valor que no está en el universo no recorta: deja a la
  // persona **sin ver nada** y en pantalla parece un bug. Es exactamente lo que
  // le pasó a los 4 usuarios anclados a la sucursal '32' borrada (`[ZN.2.0]`).
  const { rows: universo } = await knex.raw(
    `SELECT ${LLAVE} AS llave FROM commercial.warehouses w
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND (${LLAVE}) = ANY (?)`,
    [TENANT, SUCURSALES],
  );
  const vivas = universo.map((r) => r.llave);
  const faltan = SUCURSALES.filter((s) => !vivas.includes(s));
  if (faltan.length) {
    throw new Error(
      `[ZN.6.1] La(s) llave(s) ${faltan.join(', ')} no están en el universo de warehouse: ` +
        `el alcance dejaría a ${USUARIO} sin ver nada. Se revierte.`,
    );
  }

  // ── Candado 2: y además traen datos en la pantalla que ella usa ───────────
  // Existir en el catálogo no alcanza: si la sucursal no aparece en lo que la
  // pantalla lee, el alcance es correcto y la pantalla igual sale vacía.
  const { rows: conDatos } = await knex.raw(
    `SELECT sucursal, count(*)::int AS entradas FROM analytics.erp_goods_receipts
      WHERE tenant_id = ? AND sucursal = ANY (?) GROUP BY sucursal ORDER BY sucursal`,
    [TENANT, SUCURSALES],
  );
  const mudas = SUCURSALES.filter((s) => !conDatos.some((r) => r.sucursal === s));
  if (mudas.length) {
    throw new Error(
      `[ZN.6.1] ${mudas.join(', ')} no aparece(n) en erp_goods_receipts: el alcance quedaría ` +
        `técnicamente bien y la pantalla igual vacía. Se revierte.`,
    );
  }

  const previo = await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: 'warehouse' })
    .first('mode', 'values', 'mode_write');

  const fila = {
    tenant_id: TENANT,
    user_id: u.id,
    dimension: 'warehouse',
    mode: 'listed',
    values: SUCURSALES,
    mode_write: null,
    nota: NOTA,
    updated_at: knex.fn.now(),
  };
  await knex('identity.user_scopes')
    .insert(fila)
    .onConflict(['tenant_id', 'user_id', 'dimension'])
    .merge(fila);

  await knex('identity.user_events').insert({
    tenant_id: TENANT,
    user_id: u.id,
    event: 'scope_changed',
    detalle: JSON.stringify({
      dimension: 'warehouse',
      de: previo ? { mode: previo.mode, values: previo.values } : { mode: 'all', origen: `rol ${u.role_name}` },
      a: { mode: 'listed', values: SUCURSALES },
      criterio: NOTA,
      origen: 'migracion_ZN.6.1',
    }),
    actor_username: 'migracion [ZN.6.1]',
  });

  // ── Verificación: lo escrito, y qué ve de verdad ──────────────────────────
  const { rows: despues } = await knex.raw(
    `SELECT us.mode, us.values,
            (SELECT count(*)::int FROM analytics.erp_goods_receipts g
              WHERE g.tenant_id = us.tenant_id AND g.sucursal = ANY (us.values)) AS entradas_que_ve,
            (SELECT count(*)::int FROM analytics.erp_goods_receipts g
              WHERE g.tenant_id = us.tenant_id) AS entradas_totales
       FROM identity.user_scopes us
      WHERE us.tenant_id = ? AND us.user_id = ? AND us.dimension = 'warehouse'`,
    [TENANT, u.id],
  );
  const d = despues[0];
  if (!d || d.mode !== 'listed' || d.values.length !== SUCURSALES.length) {
    throw new Error('[ZN.6.1] El alcance no quedó escrito como se esperaba.');
  }
  console.log(
    `[ZN.6.1] ${USUARIO} · warehouse = ${d.mode} ${JSON.stringify(d.values)} · ` +
      `ve ${d.entradas_que_ve} de ${d.entradas_totales} entradas de mercancía. ` +
      `Antes estaba en "${previo ? previo.mode : 'sin regla propia'}".`,
  );
  conDatos.forEach((r) => console.log(`           ${r.sucursal} → ${r.entradas} entradas`));
};

/**
 * Inverso de verdad: devuelve el `own` que había justo antes. ⛔ **No borra la
 * fila** — eso la dejaría heredando el `warehouse: all` del rol
 * `compras_operaciones`, que es el estado del 21-sep que este cambio descarta.
 */
exports.down = async function down(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .first('id');
  if (!u) return;
  await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: 'warehouse' })
    .update({
      mode: 'own',
      values: null,
      mode_write: null,
      nota: '[ZN.6.1 down] Revertido al modo "su ficha" que habia antes del 2026-09-30.',
      updated_at: knex.fn.now(),
    });
};
