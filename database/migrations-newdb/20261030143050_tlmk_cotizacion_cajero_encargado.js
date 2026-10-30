'use strict';
/**
 * `[E.12.x]` — reparte las dos claves de Cotizaciones de mayoreo (`/telemarketing/cotizaciones`)
 * a `cajero` y `encargado_tienda` (pedido de Edgar, 2026-10-30: «cynthia_lopez y todos los cajeros
 * necesitan acceso a TLMK cotización, genérala ya»).
 *
 *   COMMERCIAL_QUOTES_VER       → ver la cotización (folio, cliente, vigencia, total, estado).
 *   COMMERCIAL_QUOTES_GESTIONAR → crear y editar: capturar la lista, PONER PRECIO (incluido por
 *                                 debajo de lista), enviar y cerrar. ⚠️ Es poder de precio.
 *
 * ── Por qué estos dos roles ─────────────────────────────────────────────────────────────────
 *  · `cajero` = los 14+ cajeros de sucursal, caja general y vecinal (MATRIZ_ACCESOS). Hoy NO
 *    tienen ninguna de las dos (medido en prod, sólo lectura, 2026-10-30: `cajero||`).
 *  · `encargado_tienda` = el rol de **cynthia_lopez** (medido: `cynthia_lopez|encargado_tienda`,
 *    NO es cajera). Repartir por rol —no por usuario— es ADR-054: el permiso es una CLAVE de rol.
 *    Esto se lo da a TODOS los encargados de tienda, no sólo a cynthia; es la forma correcta en
 *    este sistema. Si Edgar quiere acotarlo a una persona, eso es otra conversación.
 *  · `telemarketing` ya las tiene en `true` (medido). Este UPDATE sólo toca filas con la clave en
 *    `NULL`, así que NO lo pisa.
 *
 * Los demás roles vivos reciben la clave en `false` explícito (sin la clave, /admin/roles no la
 * muestra y nadie la puede conceder). Los `retirado_*` quedan fuera. `superadmin` entra por
 * god-mode; va en el mapa para que /admin/roles diga la verdad.
 *
 * ⚠️ Sólo hace UPDATE sobre `role_permissions`: la compuerta del despliegue la clasifica
 *    NO_MEDIDO. Aplicala con `apply-one-migration-prod.js`, una por una (regla 17). Permisos
 *    frescos por request (`RolesGuard`): no hace falta re-login para el servidor; la UI los toma
 *    en el siguiente `me/access`.
 *
 * Idempotente por `-> 'KEY' IS NULL`.
 *
 * @param { import("knex").Knex } knex
 */

const LLAVES = {
  COMMERCIAL_QUOTES_VER: ['cajero', 'encargado_tienda', 'telemarketing'],
  COMMERCIAL_QUOTES_GESTIONAR: ['cajero', 'encargado_tienda', 'telemarketing'],
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [key, roles] of Object.entries(LLAVES)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, (role_name = ANY(?::text[])))
        WHERE permissions -> ?::text IS NULL
          AND role_name NOT LIKE 'retirado_%'`,
      [key, roles, key],
    );
    const { rows } = await knex.raw(
      `SELECT role_name FROM role_permissions
        WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' ORDER BY 1`,
      [key],
    );
    console.log(`[tlmk_cotizacion_cajero_encargado] ${key}: ${res.rowCount ?? 0} filas · en true: ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
    if (!rows.length) {
      throw new Error(`Ningún rol (fuera de superadmin) quedó con ${key}: el acto nacería sin dueño (regla 20)`);
    }
  }
};

exports.down = async function down(knex) {
  // Retira SÓLO las claves de los roles que este UP agregó; no toca a quien ya las tenía antes.
  for (const key of Object.keys(LLAVES)) {
    await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions - ?::text
        WHERE role_name IN ('cajero', 'encargado_tienda')`,
      [key],
    );
  }
};
