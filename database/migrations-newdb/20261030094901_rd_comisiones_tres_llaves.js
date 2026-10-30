'use strict';
/**
 * `[RD.101]` — reparte `COMMERCIAL_COMMISSIONS_APROBAR` y `COMMERCIAL_COMMISSIONS_PAGAR` (D6,
 * firmada por Edgar el 2026-10-29: «Calcular: Comercial. Aprobar: Dirección. Marcar pagado:
 * Finanzas. Nadie aprueba lo que calculó.»).
 *
 * Hasta acá las tres cosas colgaban de `COMMERCIAL_COMMISSIONS_GESTIONAR`: quien calculaba podía
 * aprobarse y pagarse solo, y los cuatro pasos de la corrida eran decorado. El controlador ya
 * exige APROBAR en `/approve` y PAGAR en `/pay`; **sin este reparto nadie que no sea superadmin
 * podría aprobar ni pagar** (regla 20: un permiso en el enum y no repartido es un módulo cerrado).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-30) ───────────────────────────────────────
 *  · GESTIONAR = true en `direccion` (2 base + 3 complementos), `finanzas` (1 + 3) y
 *    `superadmin` (8 + 15). `contabilidad` ve y no gestiona.
 *  · De 21 corridas vivas, **ninguna** tiene `approved_by` ni `paid_by`: las 20 pagadas entraron
 *    como espejo del libro y la otra es un borrador. Nadie pierde un acto que ya ejercía.
 *  · **No existe un rol «comercial» con gerencia**: los candidatos son `supervisor_ventas` (cobran
 *    comisión: calcularían la suya) y `analisis_ventas`. Por eso GESTIONAR **no se mueve acá**:
 *    sigue en dirección y finanzas, y el control lo pone el código (nadie aprueba lo que
 *    calculó). Quién de Comercial calcula se concede desde /admin/roles cuando Edgar lo nombre.
 *
 *   APROBAR → direccion, superadmin
 *   PAGAR   → finanzas, superadmin
 *
 * `superadmin` entra por god-mode igual; va en el mapa para que /admin/roles diga la verdad.
 * Los demás roles vivos reciben la clave en `false` explícito (sin la clave, /admin/roles no la
 * muestra y nadie puede concederla). Los `retirado_*` quedan fuera.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO. Aplicala ANTES de que
 *    llegue el código, o Dirección se queda sin el botón «Aprobar» en el ínterin.
 *
 * Idempotente por `-> 'KEY' IS NULL`. Permisos frescos por request (`RolesGuard`): no hace falta
 * re-login para el servidor; la UI los toma en el siguiente `me/access`.
 *
 * @param { import("knex").Knex } knex
 */

const LLAVES = {
  COMMERCIAL_COMMISSIONS_APROBAR: ['direccion', 'superadmin'],
  COMMERCIAL_COMMISSIONS_PAGAR: ['finanzas', 'superadmin'],
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
    console.log(`[rd_comisiones_tres_llaves] ${key}: ${res.rowCount ?? 0} filas · en true: ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
    if (!rows.length) {
      throw new Error(`Ningún rol (fuera de superadmin) quedó con ${key}: el acto nacería sin dueño (regla 20)`);
    }
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: quita las dos claves. */
exports.down = async function down(knex) {
  for (const key of Object.keys(LLAVES)) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
      [key, key],
    );
  }
};
