'use strict';
/**
 * `[AU.30]` — «Carmen Rodriguez» y «María del Carmen Rodríguez Vera» son la
 * misma persona.
 *
 * Confirmado por Edgar el 2026-09-15. Es el dato que faltaba: `[AU.23]` lo
 * levantó como sospecha y **no se fusionó entonces**, porque el criterio de
 * `[ID.36]` es «nombre idéntico normalizado» y éstos no lo son. Es el mismo
 * motivo por el que ahí NO se fusionó a Ivette contra **Ivonne** Cruz Oceguera:
 * adivinar no es un método. Ahora hay confirmación humana, que es lo que
 * `[ID.36]` pedía explícitamente («se declara para que lo confirme un humano»).
 *
 * ── Qué había ─────────────────────────────────────────────────────────────
 *
 *   maria_rodriguez   «María del Carmen Rodríguez Vera»  auxiliar_finanzas
 *                     alta 2026-07-25   ⛔ NUNCA inició sesión
 *   carmenrodriguez   «Carmen Rodriguez»                 jefe_finanzas
 *                     alta 2026-08-12   sesión el 2026-08-12, nunca más
 *
 * ── Cuál sobrevive, y por qué NO decide la huella ─────────────────────────
 *
 * `[ID.36]` eligió por **huella operativa** («elegir por antigüedad habría
 * movido la venta de lugar»). Acá se midió contra las **98 tablas con FK a
 * `identity.users`** y las dos dan **cero**: sólo aparecen en `user_events` y
 * `user_roles`. La huella no desempata.
 *
 * El desempate es cuál credencial **conoce la persona**: `carmenrodriguez` es la
 * única que alguna vez inició sesión. Retirar la que nunca se usó no le quita
 * nada a nadie; retirar la que sí, la dejaría sin poder entrar.
 *
 * ── Lo que sí se corrige: el nombre ───────────────────────────────────────
 *
 * La ficha que sobrevive se llama «Carmen Rodriguez», que es una abreviatura.
 * Pasa a «María del Carmen Rodríguez Vera», que es el nombre **verificado contra
 * una fuente independiente del padrón**: `analytics.pos_cashiers`, que viene del
 * POS, lo trae completo y no tiene ninguna «Carmen Rodriguez» suelta. Esa
 * verificación es la que hizo defendible la sospecha antes de preguntarla.
 *
 * ── ⚠️ Lo que NO se resuelve, y queda declarado ───────────────────────────
 *
 * **Su puesto.** Sobrevive con `jefe_finanzas`, que es el de la ficha que se
 * conserva, pero **ninguna fuente se lo confirma**: la nómina de agosto no la
 * trae, y el POS la registra como cajera. Y ese mismo puesto lo ocupa además
 * **Juan Jesús Carrillo Contreras**, a quien `[AU.25]` movió ahí porque la
 * nómina **sí** dice que él es el Jefe de Finanzas.
 *
 * No se le cambia el puesto: cambiarlo sin fuente sería inventar en la dirección
 * contraria. Pero un puesto que ninguna fuente sostiene no es lo mismo que uno
 * confirmado, y eso tiene que estar escrito donde se lea.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VIVE = 'carmenrodriguez';
const MUERE = 'maria_rodriguez';
const NOMBRE_VERIFICADO = 'María del Carmen Rodríguez Vera';
const MOTIVO =
  'Confirmado por Edgar (2026-09-15): «maria carmen y carmen es la misma». Las dos fichas dan huella ' +
  'operativa CERO contra las 98 tablas con FK a identity.users, asi que el criterio de [ID.36] no ' +
  'desempata; sobrevive la unica que alguna vez inicio sesion. El nombre se corrige al verificado ' +
  'contra analytics.pos_cashiers, que es fuente independiente del padron.';

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");

  const idDe = async (username) => {
    const { rows } = await knex.raw(
      'SELECT id, tenant_id, status, nombre, position_code FROM identity.users WHERE username = ?',
      [username],
    );
    return rows[0] || null;
  };

  const a = await idDe(VIVE);
  const b = await idDe(MUERE);
  if (!a) throw new Error('[AU.30] ABORTA: no existe la ficha que sobrevive (' + VIVE + ').');
  if (!b) {
    console.log('[AU.30] ' + MUERE + ' ya no existe — nada que fusionar.');
    return;
  }
  if (b.status === 'terminated') {
    console.log('[AU.30] ' + MUERE + ' ya estaba retirada — nada que hacer.');
    return;
  }

  /*
   * ⛔ El argumento entero para retirar `maria_rodriguez` es que su huella es
   * cero. Se vuelve a medir contra TODAS las FKs, no contra la lista de la
   * investigación: si entre la medición y la corrida alguien le colgó un pedido,
   * una visita o una tarea, retirarla dejaría esa fila apuntando a una baja.
   */
  const { rows: fks } = await knex.raw(
    `SELECT tc.table_schema AS s, tc.table_name AS t, kcu.column_name AS col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_schema = 'identity' AND ccu.table_name = 'users' AND ccu.column_name = 'id'
        AND NOT (tc.table_schema = 'identity' AND tc.table_name IN ('user_events', 'user_roles'))
      GROUP BY 1, 2, 3`,
  );
  const conHuella = [];
  for (const f of fks) {
    const { rows } = await knex.raw(
      'SELECT count(*)::int AS n FROM ' + f.s + '.' + f.t + ' WHERE ' + f.col + ' = ?',
      [b.id],
    );
    if (rows[0].n) conHuella.push(f.s + '.' + f.t + '.' + f.col + '=' + rows[0].n);
  }
  if (conHuella.length) {
    throw new Error(
      '[AU.30] ABORTA: ' + MUERE + ' dejó de tener huella cero — ' + conHuella.join(', ') +
        '. Retirarla ahora dejaría esas filas apuntando a una cuenta dada de baja.',
    );
  }

  // Y que la que sobrevive siga siendo la que tiene la sesión: si se dio vuelta,
  // el desempate también.
  const { rows: ses } = await knex.raw(
    `SELECT username, last_login_at FROM identity.users WHERE username IN (?, ?)`,
    [VIVE, MUERE],
  );
  const viva = ses.find((s) => s.username === VIVE);
  const muerta = ses.find((s) => s.username === MUERE);
  if (!viva.last_login_at && muerta.last_login_at) {
    throw new Error(
      '[AU.30] ABORTA: ahora la que inició sesión es ' + MUERE + ' y no ' + VIVE +
        '. El desempate era cuál credencial conoce la persona.',
    );
  }

  // ── 1. El nombre verificado, en la ficha que queda.
  await knex.raw('UPDATE identity.users SET nombre = ?, updated_at = now() WHERE id = ?', [
    NOMBRE_VERIFICADO,
    a.id,
  ]);

  // ── 2. Retirar la duplicada, con el ciclo de vida escrito.
  await knex.raw(
    `UPDATE identity.users
        SET status = 'terminated',
            terminated_at = COALESCE(terminated_at, now()),
            deleted_at    = COALESCE(deleted_at, now()),
            updated_at    = now()
      WHERE id = ?`,
    [b.id],
  );

  // ── 3. Las dos puntas del vínculo. Sin esto la fusión es indistinguible de
  //      una baja, y «¿qué accesos tenía esta persona?» vuelve a no tener
  //      respuesta.
  await knex.raw(
    `INSERT INTO identity.user_events (id, tenant_id, user_id, event, detalle, actor_username)
     VALUES (gen_random_uuid(), ?, ?, 'cuenta_fusionada', ?::jsonb, 'migracion [AU.30]'),
            (gen_random_uuid(), ?, ?, 'cuenta_retirada_por_fusion', ?::jsonb, 'migracion [AU.30]')`,
    [
      a.tenant_id,
      a.id,
      JSON.stringify({
        absorbe_a: MUERE,
        motivo: MOTIVO,
        item: 'AU.30',
        nombre_anterior: a.nombre,
        puesto_sin_confirmar:
          'Conserva ' + a.position_code + ', que es el de esta ficha, pero ninguna fuente se lo ' +
          'confirma: la nomina de agosto no la trae y el POS la registra como cajera. El mismo ' +
          'puesto lo ocupa Juan Jesus Carrillo Contreras, a quien [AU.25] movio ahi porque la ' +
          'nomina SI dice que el es el Jefe de Finanzas. No se cambia sin fuente.',
      }),
      b.tenant_id,
      b.id,
      JSON.stringify({
        fusionada_en: VIVE,
        motivo: MOTIVO,
        item: 'AU.30',
        puesto_que_tenia: b.position_code,
        huella_operativa: 'cero contra las 98 tablas con FK a identity.users',
      }),
    ],
  );

  // ── 4. Compuertas.
  // ⚠️ `ILIKE '%rodriguez vera%'` NO matchea «Rodríguez»: el LIKE de Postgres no
  // ignora acentos, y esta guarda se puso en rojo a sí misma al escribirla. Se
  // usa el mismo `translate` que `[ID.36]`, que es el patrón del repo.
  const { rows: fin } = await knex.raw(
    `SELECT (SELECT count(*)::int FROM identity.users
              WHERE lower(translate(nombre, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'))
                    LIKE '%rodriguez vera%'
                AND deleted_at IS NULL) AS vivas_con_ese_nombre,
            (SELECT nombre FROM identity.users WHERE username = ?) AS nombre_final,
            (SELECT status FROM identity.users WHERE username = ?) AS status_retirada,
            (SELECT count(*)::int FROM identity.users
              WHERE deleted_at IS NULL AND kind = 'interno') AS internos`,
    [VIVE, MUERE],
  );
  if (fin[0].vivas_con_ese_nombre !== 1) {
    throw new Error(
      '[AU.30] ABORTA: quedaron ' + fin[0].vivas_con_ese_nombre + ' fichas vivas con ese nombre, se esperaba 1.',
    );
  }
  if (fin[0].nombre_final !== NOMBRE_VERIFICADO) {
    throw new Error('[AU.30] ABORTA: el nombre quedó en "' + fin[0].nombre_final + '".');
  }
  if (fin[0].status_retirada !== 'terminated') {
    throw new Error('[AU.30] ABORTA: la retirada quedó en status=' + fin[0].status_retirada + '.');
  }

  console.log(
    '[AU.30] ' + VIVE + ' absorbe a ' + MUERE + '. Nombre: "' + a.nombre + '" -> "' +
      NOMBRE_VERIFICADO + '". Internos activos: ' + fin[0].internos + '.',
  );
};

exports.down = async function down(knex) {
  const { rows } = await knex.raw(
    'SELECT id FROM identity.users WHERE username = ?',
    [MUERE],
  );
  if (rows.length) {
    await knex.raw(
      `UPDATE identity.users
          SET status = 'active', terminated_at = NULL, deleted_at = NULL, updated_at = now()
        WHERE id = ?`,
      [rows[0].id],
    );
  }
  await knex.raw("UPDATE identity.users SET nombre = 'Carmen Rodriguez', updated_at = now() WHERE username = ?", [VIVE]);
  console.log('[AU.30] revertido: las dos fichas vuelven a estar activas y separadas.');
};
