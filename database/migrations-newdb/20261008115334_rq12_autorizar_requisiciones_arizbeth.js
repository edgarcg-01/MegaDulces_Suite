'use strict';
/**
 * `[RQ.12]` — **Toda requisición la autoriza `arizbeth_gonzalez`, y sólo ella.**
 *
 * Pedido de Edgar (2026-10-08): *"necesito que toda requisición sea aprobada por
 * arizbeth_gonzalez… es la única que puede autorizar y que el proceso siga"*.
 *
 * ── Por qué una fila por PERSONA y no un permiso de rol ──────────────────────────────────────
 * ⛔ Hay **DOS** `gerente_compras` en prod: `arizbeth_gonzalez` y `fernanda_hernandez`. Darle la
 * llave al rol se la daría también a quien nadie nombró, y el pedido dice *la única*. Medido el
 * 2026-10-08 sobre las 47 requisiciones ya decididas: **Arizbeth decidió 38 (81 %)** —5 aprobadas,
 * 29 ordenadas, 4 recibidas— y Fernanda **ninguna**. Las otras 9 las decidieron `aide_piceno` (10),
 * `superoot` (2) y `superuser` (2).
 *
 * El mecanismo NO se inventa acá: `identity.user_permissions` es el override por persona que ya
 * gana sobre el rol en los dos sentidos (`permissions-cache.service.ts`), y en prod ya vive
 * exactamente este caso — `carmen_rodriguez` tiene `FINANCE_CAJA_AUTORIZAR` repartido así.
 *
 * ── Qué NO toca, y ése es el *"que el proceso siga"* ─────────────────────────────────────────
 * `COMPRAS_REQUISICIONES_GESTIONAR` **no se recorta**. Esa llave gatea ocho endpoints y la tienen
 * **29 personas en 9 roles**; recortarla habría dejado a 28 de ellas sin poder armar un pedido.
 * Lo que cambia es que tres endpoints —aprobar, rechazar y el lote— pasan a exigir la llave nueva;
 * crear, armar en lote, recalcular costos, ordenar y recibir se quedan donde estaban, con quien
 * hoy los opera (medido: `aide_piceno` marcó 5 recepciones y 2 órdenes).
 *
 * ── Lo que esta migración NO puede garantizar, y se declara ──────────────────────────────────
 * ⚠️ **El god-mode de plataforma sigue pasando.** ADR-054: el admin se resuelve por ROL, no por el
 * mapa de permisos, así que los **7 superadmins activos** (`aaron_alejo`, `david_cisneros`,
 * `felipe_galvan`, `ivette_cruz`, `jorge_rubio`, `ramon_rodriguez`, `viviana_flores`) más la
 * cuenta de servicio `superoot` pueden autorizar sin tener esta llave. Es la salida de emergencia
 * para cuando ella no esté; cerrarla sería ir contra ADR-054 y dejar la operación sin respaldo.
 * Si se quiere cerrar también eso, es una decisión aparte y se hace en el guard, no acá.
 *
 * ⚠️ **Las 645 requisiciones que ya están en `pending_approval` NO se tocan.** Siguen esperando, y
 * ahora esperan a una sola persona: el embudo se vuelve explícito en vez de repartido.
 *
 * ── Seguridad del cambio ─────────────────────────────────────────────────────────────────────
 * Pre-vuelo contra prod el 2026-10-08: **0 filas** con esta llave en `user_permissions`, **0 roles**
 * la declaran, y `arizbeth_gonzalez` existe, está activa y es única. Idempotente: si la fila ya
 * existe, sólo se asegura `allow = true` y se refresca la nota.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USERNAME = 'arizbeth_gonzalez';
const LLAVE = 'COMPRAS_REQUISICIONES_AUTORIZAR';
const NOTA = '[RQ.12] Única autorizante de requisiciones de compra (aprobar/rechazar, de una o en lote). '
  + 'Se otorga por PERSONA y no por rol: hay dos gerente_compras y el pedido es que sea la única.';

exports.up = async function (knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USERNAME })
    .first('id', 'activo');

  // ⛔ No se inventa el destinatario. Si el usuario no está, la migración DICE por qué no hizo
  // nada en vez de dejar un permiso colgado de un uuid que no existe.
  if (!u) {
    console.log(`[RQ.12] ⚠️ NO MEDIDO: no existe el usuario '${USERNAME}' en este tenant — no se otorgó nada.`);
    return;
  }
  if (!u.activo) {
    console.log(`[RQ.12] ⚠️ '${USERNAME}' existe pero está INACTIVO — se otorga igual, pero no podrá entrar hasta reactivarlo.`);
  }

  const r = await knex.raw(
    `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota, granted_by_username, created_at, updated_at)
          VALUES (?, ?, ?, true, ?, 'migracion_20261008115334', now(), now())
     ON CONFLICT (tenant_id, user_id, permission_key)
     DO UPDATE SET allow = true, nota = EXCLUDED.nota, updated_at = now()
       RETURNING (xmax = 0) AS insertada`,
    [TENANT, u.id, LLAVE, NOTA]);

  const insertada = r.rows?.[0]?.insertada;
  console.log(`[RQ.12] ${LLAVE} -> ${USERNAME}: ${insertada ? 'otorgado' : 'ya lo tenía (se reafirmó allow=true)'}.`);

  // La afirmación que importa, medida DESPUÉS de escribir: nadie más la tiene.
  const otros = await knex('identity.user_permissions')
    .where({ tenant_id: TENANT, permission_key: LLAVE, allow: true })
    .whereNot('user_id', u.id)
    .count({ n: '*' })
    .first();
  console.log(`[RQ.12] otras personas con la llave: ${otros?.n ?? '?'} (se espera 0).`);
};

exports.down = async function (knex) {
  const u = await knex('identity.users')
    .where({ tenant_id: TENANT, username: USERNAME })
    .first('id');
  if (!u) return;
  await knex('identity.user_permissions')
    .where({ tenant_id: TENANT, user_id: u.id, permission_key: LLAVE })
    .del();
};
