'use strict';
/**
 * `[RE.27.A]` — El segundo paso que `20260827150000_entradas_validar_trim` dejó pendiente.
 *
 * Aquella migración recortó `COMPRAS_ENTRADAS_VALIDAR` de los roles **sin usuarios** y dejó
 * anotado, con razón, que los roles **con gente** son decisión de control interno de Edgar y no
 * del código. Ésta trae esa decisión, tomada el 2026-09-07 con los números delante.
 *
 * ── Lo que se midió antes de decidir (prod, 2026-09-07)
 *
 * 9 roles pueden validar = **26 personas activas**. De esas, **tres lo han hecho alguna vez**:
 * 8 decisiones en total y **cero rechazos, nunca**. O sea que el permiso no es lo que frena el
 * proceso; repartirlo de menos tampoco lo arranca.
 *
 * Por eso el cambio es **mínimo y quirúrgico**: sale `marketing` (1 persona), que llegó ahí por
 * el grant masivo de `20260811130000_compras_grant_full_to_holders` —"quien opera Compras tiene
 * todos sus submódulos"— y no por una decisión de nadie. Aprobar la factura de un proveedor no
 * es un submódulo de Compras.
 *
 * ── Lo que NO hace, con motivo
 *
 * No toca `encargado_tienda` (6), `finanzas`, `tesoreria` ni los de Compras. Acotar a esas
 * personas se hace por **alcance** (`identity.user_scopes`, modo `listed`) y no por permiso:
 * el alcance dice *sobre qué sucursales*, se administra desde `/admin/users` y **no exige
 * re-login** (TTL 30 s). Quitar el permiso es el martillo; el alcance es el bisturí.
 *
 * Tampoco resuelve la acumulación **captura + valida** en la misma persona (26 de 29). El guard
 * de `validate()` ya impide aprobar lo propio; separar los oficios es decisión de organización.
 * Queda anotado como hallazgo de control en el tracker, no disfrazado de resuelto.
 *
 * ── El arreglo de `direccion`
 *
 * `direccion` tiene hoy `COMPRAS_ENTRADAS_VER: 'true'` y las otras dos claves **ausentes**
 * (`NULL`, que no es `false`). Es el mismo patrón que mordió en LC.6.2: una clave que sólo vive
 * en el enum y nunca se repartió. Se escribe `false` explícito — no le quita nada (ya no las
 * tenía) y deja dicho que es un rol de lectura, que es lo que `role_scopes` ya declara con su
 * `mode_write: 'none'`.
 *
 * Idempotente. **Cambia el JWT → `fer_zambrano` necesita re-login** para que surta efecto.
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'COMPRAS_ENTRADAS_VALIDAR';
/** Sale por decisión de Edgar (2026-09-07): llegó por el grant masivo, no por criterio. */
const FUERA = ['marketing'];
/** Rol de lectura: se le escriben en `false` las claves que hoy están ausentes. */
const SOLO_LECTURA = { rol: 'direccion', claves: ['COMPRAS_ENTRADAS_GESTIONAR', PERM] };

exports.up = async function up(knex) {
  // 1) Revocar donde se decidió. `->>` y no el operador `?` de JSONB: knex no lo escapa
  //    bien y termina en 42P18 (gotcha del repo).
  const { rows: antes } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE role_name = ANY(?) AND COALESCE((permissions->>?)::boolean, false)`,
    [FUERA, PERM],
  );
  if (antes.length) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], 'false'::jsonb)
        WHERE role_name = ANY(?)`,
      [PERM, antes.map((r) => r.role_name)],
    );
    console.log(`[RE.27.A] ${PERM} revocado en: ${antes.map((r) => r.role_name).join(', ')}`);
  } else {
    console.log(`[RE.27.A] ${PERM} ya no estaba en ${FUERA.join(', ')} — nada que revocar`);
  }

  // 2) Repartir en `false` lo que a `direccion` le falta. Sólo si la clave está AUSENTE:
  //    si alguien ya la puso en `true` a propósito, esto no la pisa.
  for (const clave of SOLO_LECTURA.claves) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], 'false'::jsonb)
        WHERE role_name = ? AND permissions -> ? IS NULL`,
      [clave, SOLO_LECTURA.rol, clave],
    );
    if (r.rowCount) console.log(`[RE.27.A] ${SOLO_LECTURA.rol}.${clave} = false (estaba ausente)`);
  }

  const { rows: despues } = await knex.raw(
    `SELECT count(*)::int n FROM identity.role_permissions
      WHERE COALESCE((permissions->>?)::boolean, false)`, [PERM]);
  console.log(`[RE.27.A] roles con ${PERM}: ${despues[0].n}`);
};

/**
 * Sólo se revierte la revocación. El `false` explícito de `direccion` era una corrección —
 * la clave estaba ausente y el rol nunca tuvo el permiso—, así que devolverla a `NULL` no
 * restauraría nada: reintroduciría la ambigüedad.
 */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb)
      WHERE role_name = ANY(?)`,
    [PERM, FUERA],
  );
};
