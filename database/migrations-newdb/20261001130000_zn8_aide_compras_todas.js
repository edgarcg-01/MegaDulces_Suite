/**
 * `[ZN.8.1]` — La primera excepción por área, y es la que motivó la fase.
 *
 * *«Aide hace el pedido de TODAS las sucursales, ve reportes de algunas, y en otras sólo quiere
 * ver la zona Morelia»*.
 *
 * Con una sola palanca eso no se podía escribir, y su bitácora lo muestra: **cuatro cambios de
 * alcance en quince días** (`all` → `listed` → `all` → `own`), cada uno arreglando una pantalla
 * y rompiendo otra. Ahora se escribe como lo que es — **dos reglas, no una**:
 *
 *   · `warehouse` en `'*'`      = `listed ['07','08']`  → en el resto de la app, su plaza
 *   · `warehouse` en `compras`  = `all`                 → donde hace el pedido, la red entera
 *
 * ⚠️ **Esto ENSANCHA lo que ve en Compras**, así que no se infiere: sale de lo que el usuario
 * describió como su trabajo, dicho dos veces. Es reversible con `down()`.
 *
 * ⛔ **No toca `'*'`.** La regla general la dejó `[ZN.6.1]` ayer y sigue siendo la correcta para
 * todo lo demás. Esta migración **agrega** una excepción; no corrige la anterior.
 *
 * ── Por qué sólo `compras` y no también los reportes ────────────────────────
 * Porque el subconjunto de los reportes **todavía no está decidido** — el usuario lo iba a
 * confirmar. Inventarlo sería dibujar una regla que nadie pidió, y una regla de alcance
 * equivocada no se ve: la persona simplemente ve de más o de menos. Queda declarado.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USUARIO = 'aide_piceno';
const AREA = 'compras';
const DIMENSION = 'warehouse';

const NOTA =
  '[ZN.8.1] En Compras ve la red entera porque hace el pedido de TODAS las sucursales. ' +
  'En el resto sigue viendo su plaza (regla general: Morelia 07 y 08, de [ZN.6.1]). ' +
  'Antes esto exigia mover su unica palanca y rompia una pantalla cada vez. Pedido por el ' +
  'usuario, 2026-10-01.';

exports.up = async function up(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .whereNull('deleted_at')
    .first('id', 'role_name');
  if (!u) throw new Error(`[ZN.8.1] No existe "${USUARIO}".`);

  // ── Candado 1: el schema de [ZN.8] tiene que estar ───────────────────────
  const tieneArea = await knex.schema.withSchema('identity').hasColumn('user_scopes', 'area');
  if (!tieneArea) {
    throw new Error('[ZN.8.1] Falta `identity.user_scopes.area`: corré 20261001120000 primero.');
  }

  // ── Candado 2: su regla general existe y NO es `all` ─────────────────────
  // Si ya fuera `all`, esta excepción no agregaría nada y estaríamos escribiendo una regla
  // decorativa — que después alguien lee como si significara algo.
  const general = await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: DIMENSION, area: '*' })
    .first('mode', 'values');
  if (!general) {
    throw new Error(
      `[ZN.8.1] ${USUARIO} no tiene regla general de ${DIMENSION}. Sin ella, la excepción de ` +
        `Compras la dejaría heredando el rol en el resto de la app, que es otra decisión.`,
    );
  }
  if (general.mode === 'all') {
    throw new Error(
      `[ZN.8.1] Su regla general ya es 'all': la excepción de Compras no agregaría nada. ` +
        `Revisá qué se quiso hacer antes de seguir.`,
    );
  }

  const fila = {
    tenant_id: TENANT,
    user_id: u.id,
    dimension: DIMENSION,
    area: AREA,
    mode: 'all',
    values: null,
    mode_write: null,
    nota: NOTA,
    updated_at: knex.fn.now(),
  };
  await knex('identity.user_scopes')
    .insert(fila)
    .onConflict(['tenant_id', 'user_id', 'dimension', 'area'])
    .merge(fila);

  await knex('identity.user_events').insert({
    tenant_id: TENANT,
    user_id: u.id,
    event: 'scope_changed',
    detalle: JSON.stringify({
      dimension: DIMENSION,
      area: AREA,
      de: { mode: general.mode, values: general.values, origen: "la regla general '*'" },
      a: { mode: 'all' },
      criterio: NOTA,
      origen: 'migracion_ZN.8.1',
    }),
    actor_username: 'migracion [ZN.8.1]',
  });

  const { rows } = await knex.raw(
    `SELECT area, mode, values FROM identity.user_scopes
      WHERE tenant_id = ? AND user_id = ? AND dimension = ? ORDER BY area`,
    [TENANT, u.id, DIMENSION],
  );
  if (rows.length !== 2) {
    throw new Error(`[ZN.8.1] Se esperaban 2 reglas (la general y la de ${AREA}), hay ${rows.length}.`);
  }
  console.log(`[ZN.8.1] ${USUARIO} · ${DIMENSION}:`);
  rows.forEach((r) =>
    console.log(`           ${r.area === '*' ? "en el resto de la app" : `en ${r.area}`.padEnd(21)} → ${r.mode} ${r.values ? JSON.stringify(r.values) : ''}`));
};

exports.down = async function down(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .first('id');
  if (!u) return;
  // Borrar la excepción la devuelve a su regla general — que sigue intacta.
  await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: DIMENSION, area: AREA })
    .del();
};
