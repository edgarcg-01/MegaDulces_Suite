/**
 * Fase SU.2 — REPARTE `COMMERCIAL_PICKING_VER` / `_GESTIONAR` (ADR-067).
 *
 * ⭐ Lección `[LC.6.2]`, pagada dos veces: **un módulo no está entregado hasta que su permiso está
 * REPARTIDO en prod, no sólo declarado en el enum.** `FISCAL_PURCHASE_BOOK_*` estuvo un día en
 * producción con cero roles y nadie podía abrirlo; `STORE_PRICE_CHECK_VER` estuvo igual hasta que
 * una migración se lo dio a 7. Declarar la clave y no repartirla deja el módulo accesible sólo
 * para `ALL_PERMS` (superadmin), y el síntoma es un 403 que parece un bug de código.
 *
 * ── A quién, y por qué ────────────────────────────────────────────────────────────────────────
 *
 * El reparto se **DERIVA del estado vivo**, no de un organigrama escrito en un editor de texto
 * (el defecto que `[OR.0]` documenta). El hermano es `COMMERCIAL_INVENTORY_AJUSTAR`: quien ya
 * puede mover el stock de un almacén es quien puede organizar cómo se surte. Medido al escribir
 * esta migración:
 *
 *   GESTIONAR ← COMMERCIAL_INVENTORY_AJUSTAR = true
 *   VER       ← COMMERCIAL_INVENTORY_VER     = true   (superconjunto del anterior)
 *
 * ⛔ **`customer_b2b` queda FUERA aunque tenga `COMMERCIAL_INVENTORY_VER`**: es un cliente
 * externo: ve existencia para saber si le pueden surtir, no el trabajo interno del almacén. Es la
 * única excepción a la derivación, y va escrita para que se vea que es deliberada.
 *
 * `direccion` queda en sólo lectura por la misma derivación (ve inventario, no lo ajusta).
 *
 * ⚠️ Aditiva con `jsonb_set`: NO reescribe el mapa de permisos del rol. Guardar el mapa completo
 * desde `/admin/roles` deja en `false` las claves nuevas del enum, y ese `false` explícito es un
 * dato real (alguien decidió que no) — por eso acá sólo se ESCRIBE la clave nueva.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // Los dos conjuntos salen de una consulta, no de una lista a mano: si mañana un rol gana o
  // pierde el permiso de inventario, este reparto sigue siendo el que se documentó.
  const conceder = async (clave, columnaHermana) => {
    const { rows } = await knex.raw(
      `SELECT tenant_id, role_name
         FROM public.role_permissions
        WHERE (permissions->>?)::text = 'true'
          AND role_name <> 'customer_b2b'
          AND role_name NOT LIKE 'retirado_%'`,
      [columnaHermana],
    );
    for (const r of rows) {
      await knex.raw(
        `UPDATE public.role_permissions
            SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb, true)
          WHERE tenant_id = ? AND role_name = ?`,
        [clave, r.tenant_id, r.role_name],
      );
    }
    console.log(`  [SU.2] ${clave} → ${rows.length} rol(es): ${rows.map((x) => x.role_name).join(', ') || '(ninguno)'}`);
    return rows.length;
  };

  const nGestionar = await conceder('COMMERCIAL_PICKING_GESTIONAR', 'COMMERCIAL_INVENTORY_AJUSTAR');
  const nVer = await conceder('COMMERCIAL_PICKING_VER', 'COMMERCIAL_INVENTORY_VER');

  // ── PRUEBA NEGATIVA: un reparto que no reparte nada se ve igual de verde que uno bueno ──────
  // Si la derivación deja de encontrar roles (porque cambió el nombre de la clave hermana, o
  // porque alguien vació los mapas), esto ABORTA en vez de dejar el módulo sin dueño otra vez.
  if (nVer === 0 || nGestionar === 0) {
    throw new Error(
      `[SU.2] el reparto no alcanzó a nadie (ver=${nVer}, gestionar=${nGestionar}). ` +
        'Es exactamente el defecto de [LC.6.2]: el permiso quedaría declarado y sin repartir. ' +
        'Revisar que COMMERCIAL_INVENTORY_VER/_AJUSTAR sigan existiendo en role_permissions.',
    );
  }
  if (nVer < nGestionar) {
    throw new Error(
      `[SU.2] VER (${nVer}) no puede alcanzar a menos roles que GESTIONAR (${nGestionar}): ` +
        'alguien podría gestionar una ola sin poder verla.',
    );
  }
};

exports.down = async function down(knex) {
  for (const clave of ['COMMERCIAL_PICKING_VER', 'COMMERCIAL_PICKING_GESTIONAR']) {
    await knex.raw(`UPDATE public.role_permissions SET permissions = permissions - ?`, [clave]);
  }
};
