'use strict';
/**
 * `[PR.V1]` — **El permiso del motor de margen, DERIVADO y no copiado.**
 *
 * ── ⛔ Lo que habria pasado copiando el permiso "natural" ─────────────────────────────────
 * `COMMERCIAL_PRICING_VER` parecia el obvio: es "ver precios". Medido en prod antes de usarlo,
 * lo tienen **18 roles**, y entre ellos:
 *
 *   · **`customer_b2b` — 3 usuarios, que son CLIENTES**
 *   · `promotor_ruta` (19), `vendedor_ruta` (15), `repartidor` (1), `vendedor_telemarketing` (1)
 *
 * Esta pantalla publica **costo de reposicion, margen realizado y la fuga de descuento de todo
 * el catalogo**. Copiar ese permiso se lo habria entregado a un cliente. *Un permiso no se
 * hereda por parecerse de nombre.*
 *
 * ── El reparto, derivado del estado vivo ──────────────────────────────────────────────────
 * Se otorga a quien **decide precio** o **responde por margen**, cruzando dos hechos medidos:
 * quien ya ve el costo estandar (`COMPRAS_COSTO_ESTANDAR_VER`) y quien ya disena experimentos
 * de precio (`COMMERCIAL_PRICE_EXPERIMENT_VER`).
 *
 *   direccion · superadmin · gerente_compras · jefe_marketing · marketing · finanzas · compras
 *
 * ⛔ **Excluidos con motivo**, que es la parte que importa:
 *   · `customer_b2b` ......... es un CLIENTE
 *   · los cuatro de campo .... la pantalla expone el costo del catalogo entero
 *   · `encargado_tienda`, `auxiliar_compras`, `compras_operaciones`, `tesoreria`,
 *     `credito_cobranza` ..... ven costo para SU trabajo; no fijan precio
 *   · `telemarketing` ........ vende, y la fuga por vendedor habla de ellos
 *
 * ⚠️ Un `false` existente NO se pisa: si alguien se lo quito a mano desde `/admin/roles`, esta
 * migracion no se lo devuelve. Lo que reparte son las claves **ausentes**.
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'COMMERCIAL_MARGIN_ENGINE_VER';
const ROLES = [
  'direccion', 'superadmin', 'gerente_compras', 'jefe_marketing',
  'marketing', 'finanzas', 'compras',
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⛔ El operador `?` de JSONB no lo escapa knex: se pregunta con `-> 'KEY' IS NULL`.
  const { rows: antes } = await knex.raw(
    `SELECT role_name, permissions -> ?::text IS NULL AS ausente,
            COALESCE((permissions ->> ?::text)::boolean, false) AS tiene
       FROM public.role_permissions WHERE role_name = ANY(?::text[])`, [PERM, PERM, ROLES]);

  const faltantes = antes.filter((r) => r.ausente).map((r) => r.role_name);
  const conFalse = antes.filter((r) => !r.ausente && !r.tiene).map((r) => r.role_name);

  if (faltantes.length) {
    await knex.raw(
      // ⚠️ Los casts NO son decorativos: sin `?::text` Postgres no puede inferir el tipo del
      //    parametro dentro de jsonb_build_object y la migracion muere con 42P18.
      `UPDATE public.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true),
              updated_at = now()
        WHERE role_name = ANY(?::text[]) AND permissions -> ?::text IS NULL`,
      [PERM, faltantes, PERM]);
  }

  const { rows: [g] } = await knex.raw(`
    SELECT count(*)::int roles,
           (SELECT count(*)::int FROM identity.users u
             WHERE u.deleted_at IS NULL
               AND u.role_name IN (SELECT role_name FROM public.role_permissions
                                    WHERE (permissions ->> ?::text)::boolean)) AS usuarios
      FROM public.role_permissions WHERE (permissions ->> ?::text)::boolean`, [PERM, PERM]);

  // eslint-disable-next-line no-console
  console.log(`  · [PR.V1] ${PERM} en ${g.roles} roles · ${g.usuarios} usuarios `
    + `· repartido a ${faltantes.length}`
    + (conFalse.length ? ` · ⚠️ NO se pisa el false de: ${conFalse.join(', ')}` : ''));

  /**
   * ⛔⛔ LA COMPUERTA QUE IMPORTA: que el permiso NO haya caido en un rol de cliente ni de
   *     campo. Es el defecto que esta migracion existe para no cometer, y un reparto se ve
   *     igual de exitoso lo cometa o no.
   */
  const PROHIBIDOS = ['customer_b2b', 'promotor_ruta', 'vendedor_ruta', 'repartidor',
    'vendedor_telemarketing'];
  const { rows: fuga } = await knex.raw(
    `SELECT role_name FROM public.role_permissions
      WHERE role_name = ANY(?::text[]) AND COALESCE((permissions ->> ?::text)::boolean, false)`,
    [PROHIBIDOS, PERM]);
  if (fuga.length) {
    throw new Error(`[PR.V1] el motor de margen quedo visible para ${fuga.map((r) => r.role_name)
      .join(', ')} — la pantalla publica el costo del catalogo entero.`);
  }
  if (g.roles === 0) throw new Error('[PR.V1] el permiso no quedo en ningun rol.');
};

exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE public.role_permissions SET permissions = permissions - ?::text, updated_at = now()
      WHERE permissions -> ?::text IS NOT NULL`, [PERM, PERM]);
};
