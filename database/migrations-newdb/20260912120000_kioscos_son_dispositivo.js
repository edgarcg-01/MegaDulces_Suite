'use strict';
/**
 * `[OR.9]` — Cuatro kioscos entraron al padrón diciendo ser personas.
 *
 * ══ Qué pasó, medido ════════════════════════════════════════════════════════
 * El 2026-09-12 a las 15:14 y 15:28 se dieron de alta cuatro cuentas con
 * `kind = 'interno'`:
 *
 *     checador.01     «Checador - Padre Hidalgo»       checador_kiosco
 *     checador.03     «Checador - 8ESQ»                checador_kiosco
 *     verificador.01  «Verificador - Padre Hidalgo»    verificador_precios
 *     verificador.03  «Verificador - 8ESQ»             verificador_precios
 *
 * Son **estaciones de mostrador**, no gente: el checador de asistencia (Fase CH)
 * y el verificador de precios (`[CV.24]`). `kind = 'dispositivo'` existe desde
 * `[ID.31]` para exactamente esto, y ya clasifica 14 credenciales así.
 *
 * ══ Por qué importa, y no es cosmético ══════════════════════════════════════
 *  1. **El padrón miente por 4.** `diagnosticoPadron()` filtra por
 *     `kind = 'interno'` (`users.service.ts`), así que reportaba **104 personas,
 *     4 sin puesto y 4 sin jefe**. Las 100 personas reales tienen las tres
 *     cosas: el hueco era enteramente estos kioscos.
 *  2. ⛔ **El candado de OR.3 no los ve.** La regla —*ningún trabajo se le
 *     asigna a un dispositivo*— se evalúa por `kind`. Una estación que dice ser
 *     interna **es elegible para recibir un hallazgo**, y en las sucursales
 *     donde la única cuenta con almacén es el kiosco, se lo lleva.
 *  3. Desbloquea `DEUDA-OR-CHECK`: el CHECK parcial
 *     `kind='interno' ⇒ position_code NOT NULL` era **incumplible** con estas 4
 *     adentro. Después de esto, 100 de 100 lo satisfacen.
 *
 * ══ Por qué el guard de `[ID.31]` no las atrapó ═════════════════════════════
 * Su heurística busca `nombre ~ '^Etiquetas'` o `nombre = username`. «Checador -
 * Padre Hidalgo» no es ninguna de las dos. El smoke se extiende en el mismo
 * commit con las dos señales que sí las habrían visto.
 *
 * ══ Dos señales INDEPENDIENTES tienen que coincidir ═════════════════════════
 * No se toca una lista fija de usernames — el padrón se edita en vivo, y una
 * lista fija clasifica por lo que era verdad cuando la escribí. Se derivan al
 * correr, y **sólo se voltea la fila si las dos señales están de acuerdo**:
 *
 *   (a) el `role_name` es un rol de ESTACIÓN declarado abajo, y
 *   (b) el `username` sigue la convención `<función>.<sucursal>` — medida:
 *       12 de 122 cuentas la cumplen, y las 12 son estaciones.
 *
 * Si discrepan, **aborta** y las imprime. Una señal sola alcanzaba hoy; dos
 * señales es lo que hace que siga siendo cierto cuando alguien agregue un rol.
 *
 * ⚠️ **`ruta_505` queda AFUERA, a propósito.** Nombre «RUTA 505», rol
 * `promotor_ruta`, dada de alta el mismo día que las tabletas `rvph0N` que sí
 * son `dispositivo`, con ruta asignada y login desde Android. Parece una
 * credencial de ruta compartida — pero `promotor_ruta` lo tienen **13 personas
 * reales**, así que la señal (a) no aplica, y degradar a una persona a máquina
 * la saca del padrón y del reparto de trabajo. Se declara, no se adivina.
 *
 * ══ Lo que NO cambia ════════════════════════════════════════════════════════
 * `kind` no tiene ninguna consecuencia funcional en la fila — se verificó:
 * ni TTL de token, ni expiración, ni `must_change_password`, ni el login (ningún
 * guard filtra por `kind` salvo el corte de `servicio` de `[ID.17]`). Es un
 * clasificador que leen el reparto de trabajo y los conteos. **Los cuatro
 * kioscos siguen entrando igual.**
 *
 * Idempotente: la segunda corrida no encuentra nada que voltear.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/**
 * Roles cuya población entera son estaciones de mostrador, no personas.
 * Verificado contra prod (2026-09-12): cada uno concede **una sola** clave de
 * permiso y lo tienen únicamente las cuentas de kiosco.
 *
 * ⛔ `promotor_ruta` NO entra: lo comparten 13 personas reales con 6 tabletas.
 */
const ROLES_DE_ESTACION = ['checador_kiosco', 'verificador_precios', 'etiquetas_anaquel'];

/** `<función>.<sucursal>` — la convención de nombre de las estaciones. */
const USERNAME_DE_ESTACION = '^[a-z_]+[.][0-9]+$';

exports.up = async function up(knex) {
  const antes = await knex.raw(
    `SELECT count(*) FILTER (WHERE kind = 'interno')::int   AS internos,
            count(*) FILTER (WHERE kind = 'dispositivo')::int AS dispositivos
       FROM identity.users WHERE tenant_id = ? AND deleted_at IS NULL`,
    [TENANT],
  );
  console.log(
    `  [OR.9] antes: ${antes.rows[0].internos} internos · ${antes.rows[0].dispositivos} dispositivos`,
  );

  // ── Las dos señales, derivadas al correr ──────────────────────────────────
  // ⚠️ Nada de `= ANY(?)`: knex expande un binding de array a una lista de
  // bindings y el predicado queda mal armado. Va por query builder.
  const filas = await knex('identity.users')
    .select('id', 'username', 'nombre', 'role_name')
    .where({ tenant_id: TENANT, kind: 'interno' })
    .whereNull('deleted_at')
    .where((q) =>
      q.whereIn('role_name', ROLES_DE_ESTACION).orWhereRaw('username ~ ?', [USERNAME_DE_ESTACION]),
    )
    .orderBy('username');

  // Las dos señales se evalúan acá, no en el SQL: el regex ya lo aplicó la base
  // para traer el candidato, y repetirlo en JS con el MISMO literal es lo que
  // permite que las dos banderas signifiquen lo que dicen.
  const reUsername = new RegExp(USERNAME_DE_ESTACION);
  const candidatos = filas.map((f) => ({
    ...f,
    por_rol: ROLES_DE_ESTACION.includes(f.role_name),
    por_username: reUsername.test(f.username),
  }));

  if (!candidatos.length) {
    console.log('  [OR.9] no hay estaciones marcadas como interno: nada que hacer.');
    return;
  }

  // ── FAIL-CLOSED: las dos señales tienen que estar de acuerdo ──────────────
  const discrepan = candidatos.filter((c) => !c.por_rol || !c.por_username);
  if (discrepan.length) {
    discrepan.forEach((d) =>
      console.log(
        `     ! ${String(d.username).padEnd(18)} rol=${String(d.role_name).padEnd(22)} ` +
          `por_rol=${d.por_rol} por_username=${d.por_username}  «${d.nombre}»`,
      ),
    );
    throw new Error(
      `[OR.9] ABORTA: ${discrepan.length} cuenta/s donde las dos señales NO coinciden. ` +
        'Una sola señal no alcanza para degradar a alguien de persona a máquina. ' +
        'Resolver una por una (arriba están impresas) antes de volver a correr.',
    );
  }

  const usernames = candidatos.map((c) => c.username);
  console.log(`  [OR.9] ${usernames.length} estación/es a reclasificar (las dos señales coinciden):`);
  candidatos.forEach((c) =>
    console.log(`     · ${String(c.username).padEnd(18)} ${String(c.role_name).padEnd(22)} «${c.nombre}»`),
  );

  const cambiadas = await knex('identity.users')
    .where({ tenant_id: TENANT, kind: 'interno' })
    .whereNull('deleted_at')
    .whereIn('username', usernames)
    .update({ kind: 'dispositivo', updated_at: knex.fn.now() });

  // ── La bitácora ───────────────────────────────────────────────────────────
  // `actor_user_id` va NULL: no lo hizo una persona, lo hizo esta migración.
  for (const c of candidatos) {
    await knex('identity.user_events').insert({
      tenant_id: TENANT,
      user_id: c.id,
      event: 'kind_reclasificado',
      detalle: JSON.stringify({
        de: 'interno',
        a: 'dispositivo',
        origen: 'migracion [OR.9]',
        criterio: 'rol de estacion + username <funcion>.<sucursal>, las dos señales de acuerdo',
        evidencia: { role_name: c.role_name, nombre: c.nombre },
        motivo:
          'Es una estacion de mostrador, no una persona. Con kind=interno contaba como ' +
          'personal en el padron y era elegible para recibir trabajo asignado.',
      }),
      actor_user_id: null,
      actor_username: 'migracion [OR.9]',
    });
  }

  // ── POST-CONDICIÓN: no queda ninguna estación diciendo ser persona ────────
  const quedan = await knex('identity.users')
    .where({ tenant_id: TENANT, kind: 'interno' })
    .whereNull('deleted_at')
    .where((q) =>
      q.whereIn('role_name', ROLES_DE_ESTACION).orWhereRaw('username ~ ?', [USERNAME_DE_ESTACION]),
    )
    .count({ n: '*' });
  if (Number(quedan[0].n) > 0) {
    throw new Error(`[OR.9] ABORTA: quedaron ${quedan[0].n} estación/es como interno después del UPDATE.`);
  }

  const despues = await knex.raw(
    `SELECT count(*) FILTER (WHERE kind = 'interno')::int AS internos,
            count(*) FILTER (WHERE kind = 'interno' AND position_code IS NULL)::int AS sin_puesto,
            count(*) FILTER (WHERE kind = 'dispositivo')::int AS dispositivos
       FROM identity.users WHERE tenant_id = ? AND deleted_at IS NULL`,
    [TENANT],
  );
  const d = despues.rows[0];
  console.log(
    `  [OR.9] ${cambiadas} fila/s reclasificada/s · después: ${d.internos} personas ` +
      `(${d.sin_puesto} sin puesto) · ${d.dispositivos} dispositivos`,
  );
};

exports.down = async function down(knex) {
  // Se revierte por el evento, no por la regla: la regla volvería a atrapar a
  // quien la cumpla hoy, aunque nunca lo haya volteado esta migración.
  const rows = await knex('identity.user_events')
    .distinct('user_id')
    .where({ tenant_id: TENANT, event: 'kind_reclasificado' })
    .whereRaw(`detalle->>'origen' = ?`, ['migracion [OR.9]']);
  if (!rows.length) {
    console.log('  [OR.9] nada que revertir.');
    return;
  }
  const ids = rows.map((r) => r.user_id);
  await knex('identity.users').where({ tenant_id: TENANT }).whereIn('id', ids).update({ kind: 'interno' });
  await knex('identity.user_events')
    .where({ tenant_id: TENANT, event: 'kind_reclasificado' })
    .whereRaw(`detalle->>'origen' = ?`, ['migracion [OR.9]'])
    .del();
  console.log(`  [OR.9] revertido: ${ids.length} estación/es vuelven a contar como personal.`);
};
