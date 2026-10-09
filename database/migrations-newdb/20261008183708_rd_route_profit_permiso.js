'use strict';
/**
 * `[RD.57]` — **Reparto de `COMMERCIAL_ROUTE_PROFIT_VER`.**
 *
 * Declarar un permiso en el enum NO le da acceso a nadie. Sin esta migración el módulo queda
 * en prod y **sólo entran `superadmin`/`admin` por `ALL_PERMS`**; cualquier otro recibe 403 al
 * abrir la URL. Pasó con `FISCAL_PURCHASE_BOOK_*` (LC.6.2): el módulo llevaba un día vivo y
 * nadie podía abrirlo.
 *
 * ── A quién, y de dónde sale la lista ────────────────────────────────────────────────────
 * **No se inventa una lista de roles: se deriva del estado vivo.** La pantalla publica el
 * gasto del departamento de Ruta Directa, que incluye nómina, SUA y comisiones — o sea, lo
 * mismo que ya ve quien tiene `COMMERCIAL_COMMISSIONS_VER`. Ése es el hermano correcto.
 *
 * ⛔ **NO se deriva de `COMMERCIAL_PROFITABILITY_VER`** (la rentabilidad de la Fase MR), aunque
 * el nombre invite: medido contra prod el 2026-10-08, lo tienen **11 roles** incluidos
 * `repartidor`, `telemarketing`, `marketing` y `compras`. Calcarlo les abriría la nómina de RD.
 * Con el hermano correcto son **4 roles / 15 personas**: contabilidad, direccion, finanzas,
 * superadmin.
 *
 * ── La trampa del `IS NULL`, medida antes de confiar en ella ─────────────────────────────
 * `/admin/roles` guarda el JSONB completo, así que en cuanto alguien salva un rol cualquiera
 * **toda clave nueva del enum aterriza en `false`**, y el guard `-> 'KEY' IS NULL` respeta ese
 * `false` a propósito (no pisar decisiones humanas). Medido: la clave **no existe en ninguno de
 * los 56 roles, ni en `false`** (0 declarados / 0 en false), así que el guard idempotente sí
 * hace algo acá. Si esto se vuelve a correr después de que alguien salve un rol, ese rol ya no
 * lo recibe — y está bien, porque entonces sería una decisión tomada.
 *
 * ⚠️ `retirado_*` queda fuera: son roles dados de baja.
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'COMMERCIAL_ROUTE_PROFIT_VER';
const HERMANO = 'COMMERCIAL_COMMISSIONS_VER';

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `UPDATE role_permissions
        SET permissions = jsonb_set(permissions, ARRAY[?], 'true'::jsonb, true)
      WHERE permissions -> ? = 'true'::jsonb
        AND permissions -> ? IS NULL
        AND role_name NOT LIKE 'retirado%'
      RETURNING role_name`,
    [PERM, HERMANO, PERM],
  );
  // eslint-disable-next-line no-console
  console.log(`  [RD.57] ${PERM} → ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || 'ninguno'}`);
};

exports.down = async function down(knex) {
  // Quita la clave sólo donde esta migración la puso en `true`. Un `false` puesto a mano por
  // alguien en /admin/roles es una decisión y no se toca.
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions - ?
      WHERE permissions -> ? = 'true'::jsonb`,
    [PERM, PERM],
  );
};
