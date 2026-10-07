/**
 * `[AU.29]` — Ivette Cruz, jefa de zona de La Piedad, queda con el mismo perfil
 * que sus dos pares.
 *
 * Decisión de Edgar: *«ivette cruz jefa de zona la piedad igual con superadmin»*.
 *
 * ── Qué la distinguía, medido ─────────────────────────────────────────────
 *
 * Los tres ocupan `jefe_zona` y los tres están en desvío declarado respecto del
 * `supervisor_ventas` que el puesto propone. Pero no estaban en el mismo lugar:
 *
 *   aaron_alejo      superadmin        (170 permisos)   sin override de alcance
 *   ramon_rodriguez  superadmin        (170 permisos)   sin override de alcance
 *   ivette_cruz      encargado_tienda  ( 69 permisos)   warehouse: listed 01-04
 *
 * Esta migración iguala **el rol**: gana 103 permisos.
 *
 * ── Los 2 permisos que «pierde» no se pierden ─────────────────────────────
 *
 * `encargado_tienda` tiene `COMMERCIAL_EXPIRY_VER` y `COMMERCIAL_EXPIRY_CAPTURAR`
 * y el mapa de `superadmin` **no los declara**. En la práctica no pierde nada:
 * `RolesGuard` (línea 89) resuelve los roles de plataforma por NOMBRE antes de
 * mirar el mapa, y los tres frontends espejan esa lista. Es justo el caso que el
 * comentario de `platform-admin.ts` describe: «siguen pasando aunque a su JSONB
 * le falte una clave». ⚠️ Queda anotado igual, porque si algún día el god-mode
 * se resolviera por mapa, las caducidades —que son trabajo de tienda, y ella es
 * jefa de zona de tiendas— serían lo primero que se apagaría sin que nadie lo vea.
 *
 * ── ⚠️ Lo que este cambio APAGA, y no se borra ────────────────────────────
 *
 * Ivette tiene un override `warehouse: listed ['03','02','01','04']` que puso
 * `superoot` el 2026-09-14. **`ScopeService` (línea 191) devuelve `all` en todas
 * las dimensiones para un rol de plataforma**, así que ese override queda
 * **inerte**: con `superadmin` va a ver los 36 almacenes, no 4.
 *
 * ⛔ No se borra, a propósito. Es la decisión de otra persona, tomada ayer, y es
 * el estado al que la cuenta vuelve si el rol se revierte. Borrarlo sería perder
 * esa información para siempre a cambio de nada. Pero **no se puede leer como
 * vigente**: queda declarado acá y en el evento de la bitácora.
 */

const USUARIO = 'ivette_cruz';
const ROL_DESTINO = 'superadmin';
const PARES = ['aaron_alejo', 'ramon_rodriguez'];

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT id, tenant_id, role_name, position_code FROM identity.users
      WHERE username = ? AND deleted_at IS NULL`,
    [USUARIO],
  );
  if (!rows.length) throw new Error('[AU.29] ABORTA: no existe la ficha ' + USUARIO + '.');
  const u = rows[0];

  if (u.role_name === ROL_DESTINO) {
    console.log('[AU.29] ' + USUARIO + ' ya tiene ' + ROL_DESTINO + ' — nada que hacer.');
    return;
  }

  // ⛔ El pedido es «igual que sus pares». Si dejó de ocupar el puesto, «igual»
  //    ya no significa lo mismo y la decisión hay que volver a tomarla.
  if (u.position_code !== 'jefe_zona') {
    throw new Error(
      '[AU.29] ABORTA: ' + USUARIO + ' está en el puesto "' + u.position_code +
        '", no en jefe_zona. El motivo del cambio era igualarla a sus pares de puesto.',
    );
  }

  // Y que los pares sigan siendo lo que se midió: si a ellos les bajaron el rol,
  // subírselo a ella los desalinea en la otra dirección.
  const { rows: pares } = await knex.raw(
    `SELECT username, role_name FROM identity.users
      WHERE username = ANY (?::text[]) AND deleted_at IS NULL`,
    [PARES],
  );
  const desalineados = pares.filter((p) => p.role_name !== ROL_DESTINO);
  if (desalineados.length) {
    throw new Error(
      '[AU.29] ABORTA: sus pares ya no tienen ' + ROL_DESTINO + ' (' +
        desalineados.map((p) => p.username + '=' + p.role_name).join(', ') +
        '). Igualarla a ellos hoy significaría otra cosa.',
    );
  }

  const antesSA = (
    await knex.raw(
      "SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND role_name = 'superadmin'",
    )
  ).rows[0].n;

  // El override que va a quedar inerte, se lee ANTES para poder nombrarlo.
  const { rows: sc } = await knex.raw(
    `SELECT dimension, mode, values FROM identity.user_scopes WHERE user_id = ?`,
    [u.id],
  );

  await knex.raw(
    'UPDATE identity.users SET role_name = ?, updated_at = now() WHERE id = ?',
    [ROL_DESTINO, u.id],
  );

  await knex.raw(
    `INSERT INTO identity.user_events (tenant_id, user_id, event, detalle, actor_username)
     VALUES (?, ?, 'desvio_de_puesto', ?::jsonb, 'migracion [AU.29]')`,
    [
      u.tenant_id,
      u.id,
      JSON.stringify({
        position_code: 'jefe_zona',
        elegido: ROL_DESTINO,
        propone: 'supervisor_ventas',
        origen: 'migracion_AU.29',
        motivo:
          'Jefa de zona de La Piedad. Se iguala al perfil de los otros dos jefes de zona (aaron_alejo, ' +
          'ramon_rodriguez), que ya lo tenian: los tres ocupan el mismo puesto y hasta hoy tenian tres ' +
          'perfiles distintos. Decidido por Edgar, 2026-09-15. Reemplaza el motivo de [AU.18], que decia ' +
          '"conserva su perfil actual".',
        rol_anterior: u.role_name,
        alcance_que_queda_inerte: sc.length
          ? sc.map((s) => s.dimension + ':' + s.mode + (s.values ? '=' + JSON.stringify(s.values) : '')).join(', ') +
            ' — ScopeService devuelve `all` para un rol de plataforma, asi que estas reglas dejan de tener ' +
            'efecto. NO se borran: son la decision de superoot del 2026-09-14 y el estado al que vuelve si ' +
            'se revierte el rol.'
          : 'ninguno',
      }),
    ],
  );

  const despuesSA = (
    await knex.raw(
      "SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND role_name = 'superadmin'",
    )
  ).rows[0].n;
  if (despuesSA !== antesSA + 1) {
    throw new Error('[AU.29] ABORTA: superadmin ' + antesSA + ' -> ' + despuesSA + ', se esperaba ' + (antesSA + 1) + '.');
  }

  // Los tres tienen que quedar con el MISMO rol: es el punto del cambio.
  const { rows: fin } = await knex.raw(
    `SELECT count(DISTINCT role_name)::int AS roles, count(*)::int AS n
       FROM identity.users WHERE deleted_at IS NULL AND position_code = 'jefe_zona'`,
  );
  if (fin[0].roles !== 1) {
    throw new Error('[AU.29] ABORTA: los ' + fin[0].n + ' jefes de zona quedaron con ' + fin[0].roles + ' roles distintos.');
  }

  // Y el override sigue en su lugar: apagarlo no es borrarlo.
  const { rows: post } = await knex.raw(
    'SELECT count(*)::int AS n FROM identity.user_scopes WHERE user_id = ?',
    [u.id],
  );
  if (post[0].n !== sc.length) {
    throw new Error('[AU.29] ABORTA: se tocaron reglas de alcance (' + sc.length + ' -> ' + post[0].n + '). Esta migración sólo cambia el rol.');
  }

  console.log(
    '[AU.29] ' + USUARIO + ': ' + u.role_name + ' -> ' + ROL_DESTINO + '. Los ' + fin[0].n +
      ' jefes de zona quedan con un solo perfil. superadmin: ' + antesSA + ' -> ' + despuesSA +
      '. Reglas de alcance intactas (' + sc.length + ') y ahora inertes.',
  );
};

exports.down = async function down(knex) {
  const { rows } = await knex.raw(
    "SELECT id FROM identity.users WHERE username = ? AND deleted_at IS NULL AND role_name = 'superadmin'",
    [USUARIO],
  );
  if (!rows.length) {
    console.log('[AU.29] ' + USUARIO + ' ya no tiene superadmin — no se revierte nada.');
    return;
  }
  await knex.raw(
    "UPDATE identity.users SET role_name = 'encargado_tienda', updated_at = now() WHERE id = ?",
    [rows[0].id],
  );
  console.log('[AU.29] revertido: ' + USUARIO + ' vuelve a encargado_tienda, y su alcance vuelve a aplicar.');
};
