/**
 * `[ZN.8.H]` — HOTFIX: Aide ve todo hasta que suba el despliegue.
 *
 * ── ⛔ Lo que hay que decir primero: esto repara algo que rompí yo ───────────
 * `[ZN.8.1]` le dejó **dos filas** de `warehouse` (`'*'` = `listed ['07','08']` y
 * `compras` = `all`) **antes de redesplegar el API**. Y el código que corre hoy
 * en prod **no conoce `area`** — medido dentro de `prod-api`: cero referencias a
 * `elegirRegla` o al filtro de área, y la consulta es
 *
 *     .where({ tenant_id, user_id }).select('dimension','mode','values',…)
 *
 * sin `ORDER BY`, seguida de `new Map(rows.map(r => [r.dimension, r]))`. Un Map
 * construido así se queda con **la última** fila de cada dimensión. O sea que su
 * alcance efectivo era **una moneda al aire** entre `listed ['07','08']` y `all`,
 * según el orden que devolviera Postgres.
 *
 * Hoy devuelve `'*'` primero y `compras` después, así que ganaba `all` — que es
 * justo lo que se necesita. **Por casualidad, no por diseño**, y eso no es un
 * estado en el que se deje nada.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────
 * Deja **UNA sola fila**: `'*'` = `all`. Sin ambigüedad posible, con el código
 * viejo o con el nuevo.
 *
 * ⛔ **Borra la excepción de `compras` a propósito.** Dejarla con los dos en
 * `all` también funcionaría —ambas filas dirían lo mismo— pero deja una trampa
 * armada: el día que alguien edite una de las dos antes del redespliegue, la
 * moneda vuelve. Y una fila `area='compras'` que el código corriendo IGNORA es
 * engañosa para quien mire la base. Se rehace desde `/admin/personas` → Datos →
 * «Ve distinto en un área» en medio minuto, que para eso se construyó la
 * pantalla.
 *
 * ── Cuando suba el despliegue ───────────────────────────────────────────────
 * La configuración que el negocio describió es: `'*'` = `listed ['07','08']` +
 * `compras` = `all`. Se vuelve a armar desde la pantalla, sin migración.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USUARIO = 'aide_piceno';
const DIMENSION = 'warehouse';

const NOTA =
  '[ZN.8.H] HOTFIX temporal: ve TODA la red mientras no suba el despliegue con el alcance por ' +
  'area. El codigo en produccion todavia no lee `area`, y con dos filas de la misma dimension se ' +
  'quedaba con la ultima que devolviera Postgres (sin ORDER BY) = resultado no determinista. ' +
  'Lo definitivo es: general listed 07/08 + excepcion en compras all, desde /admin/personas. ' +
  'Pedido por el usuario, 2026-10-01.';

exports.up = async function up(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .whereNull('deleted_at')
    .first('id');
  if (!u) throw new Error(`[ZN.8.H] No existe "${USUARIO}".`);

  const antes = await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: DIMENSION })
    .orderBy('area')
    .select('area', 'mode', 'values');

  // Fuera las excepciones por área: con el código viejo son ambigüedad, no configuración.
  const borradas = await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: DIMENSION })
    .whereNot('area', '*')
    .del();

  const fila = {
    tenant_id: TENANT,
    user_id: u.id,
    dimension: DIMENSION,
    area: '*',
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
      de: antes,
      a: { mode: 'all', area: '*' },
      excepciones_borradas: borradas,
      criterio: NOTA,
      origen: 'migracion_ZN.8.H',
      temporal: true,
    }),
    actor_username: 'migracion [ZN.8.H]',
  });

  // ── Candado: UNA sola fila, y dice `all` ─────────────────────────────────
  // Es el punto entero del hotfix. Dos filas serían volver a la moneda al aire.
  const { rows } = await knex.raw(
    `SELECT area, mode FROM identity.user_scopes
      WHERE tenant_id = ? AND user_id = ? AND dimension = ?`,
    [TENANT, u.id, DIMENSION],
  );
  if (rows.length !== 1 || rows[0].area !== '*' || rows[0].mode !== 'all') {
    throw new Error(
      `[ZN.8.H] Esperaba UNA fila '*'/all y quedaron ${rows.length}: ` +
        `${rows.map((r) => `${r.area}=${r.mode}`).join(', ')}.`,
    );
  }

  console.log(
    `[ZN.8.H] ${USUARIO} · ${DIMENSION} = all (toda la red). ` +
      `Antes: ${antes.map((a) => `${a.area}=${a.mode}`).join(' + ')} · ` +
      `excepciones retiradas: ${borradas}.`,
  );
  console.log(
    '          ⚠️ TEMPORAL. Tras el redespliegue, rearmar desde /admin/personas → Datos: ' +
      'general listed 07/08 + «Ve distinto en un área» → Compras = ve todo.',
  );
};

/**
 * Vuelve al estado de `[ZN.6.1]` + `[ZN.8.1]`, que es lo que el negocio describió.
 * ⚠️ Sólo tiene sentido **con el despliegue nuevo arriba**: con el viejo, estas dos filas son
 * otra vez un resultado no determinista.
 */
exports.down = async function down(knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USUARIO })
    .first('id');
  if (!u) return;
  await knex('identity.user_scopes')
    .where({ tenant_id: TENANT, user_id: u.id, dimension: DIMENSION, area: '*' })
    .update({
      mode: 'listed',
      values: ['07', '08'],
      nota: '[ZN.8.H down] Vuelve a la regla general de [ZN.6.1]: Morelia 07 y 08.',
      updated_at: knex.fn.now(),
    });
};
