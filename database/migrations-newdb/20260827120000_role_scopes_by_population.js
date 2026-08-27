'use strict';
/**
 * `[ID.8c]` — El default de alcance sigue a la POBLACIÓN, no es uno para todos
 * (Fase ID / ADR-050).
 *
 * `[ID.3]` puso `warehouse: own` como default de TODOS los roles no-god. Servía
 * para no romper nada, pero mezcla tres poblaciones que se controlan distinto —
 * el punto de Edgar: *"una cosa son las rutas, otra cosa es administrativo o
 * tienda"*.
 *
 *   POBLACIÓN        CONTROL              DEFAULT de `warehouse`
 *   ───────────────  ───────────────────  ────────────────────────────────────
 *   Tienda           su sucursal          `own`  ← ya estaba bien
 *   Administrativo   la red completa      `all`  ← esto arregla la migración
 *   Rutas            su ruta / camión     `own`  (se queda; la dimensión `route`
 *                                          se prende cuando exista la topología
 *                                          de camiones)
 *
 * Lo que arregla en concreto: con `own` para todos, **un alta administrativa
 * nueva nacía CIEGA** — sin sucursal asignada, `own` resuelve a lista vacía. Los
 * 64 administrativos de hoy no lo notan porque `[ID.3]` les escribió un override
 * `all` de usuario, pero el próximo contador que se dé de alta sí. Y "ve la red"
 * queda **escrito en el rol** en vez de repetido 64 veces a mano, que es lo que
 * el ADR-050 pide: `all` explícito, no implícito.
 *
 * NO toca `user_scopes`: los overrides por persona siguen ganando.
 * Idempotente: sólo cambia las filas que todavía tienen el default de `[ID.3]`.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * Roles administrativos = los que NO trabajan en una sucursal ni en una ruta.
 * Misma lista que `normalize-user-population.js` (departamentos administracion /
 * operaciones / almacen / logistica / sistemas), sin los god-mode, que ya pasan
 * por `manage:all` y no llevan filas.
 */
const ROLES_ADMINISTRATIVOS = [
  'finanzas', 'gerente_finanzas', 'auxiliar_finanzas', 'coordinadora_contabilidad',
  'coordinador_presupuestos', 'credito_cobranza', 'analista_credito_cobranza',
  'control_depositos_pagos', 'gestor_egresos', 'gestor_tesoreria', 'captura_gastos',
  'jefe_marketing', 'coordinadora_marketing', 'auxiliar_mercadotecnia',
  'compras', 'auxiliar_compras', 'gerente_compras', 'encargada_operaciones_compras',
  'encargada_prevencion', 'auxiliar_prevencion',
  'almacenista', 'repartidor',
];

exports.up = async function up(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_scopes
        SET mode = 'all',
            nota = '[ID.8c] Rol administrativo: su población se controla por la RED, no por sucursal. Antes heredaba el default `+"`own`"+` de [ID.3] y un alta nueva nacía ciega.',
            updated_at = now()
      WHERE dimension = 'warehouse'
        AND lower(role_name) = ANY(?::text[])
        AND mode = 'own'`,
    [ROLES_ADMINISTRATIVOS],
  );
  console.log(`[role_scopes_population] roles administrativos con warehouse own→all: ${res.rowCount ?? 0}`);

  const foto = await knex.raw(`
    SELECT rs.mode, count(*) roles,
           (SELECT count(*) FROM identity.users u
             WHERE u.deleted_at IS NULL
               AND lower(u.role_name) IN (
                 SELECT lower(r2.role_name) FROM identity.role_scopes r2
                  WHERE r2.dimension = 'warehouse' AND r2.mode = rs.mode
                    AND r2.tenant_id = rs.tenant_id)) usuarios
      FROM identity.role_scopes rs
     WHERE rs.dimension = 'warehouse'
     GROUP BY rs.mode, rs.tenant_id
     ORDER BY 2 DESC`);
  console.log('[role_scopes_population] default de `warehouse` por rol:');
  foto.rows.forEach((r) => console.log(`  mode=${String(r.mode).padEnd(6)} ${r.roles} rol(es) · ${r.usuarios} usuario(s)`));
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_scopes
        SET mode = 'own', nota = '[ID.3] default materializado del comportamiento vigente'
      WHERE dimension = 'warehouse' AND nota LIKE '[ID.8c]%'`,
  );
  console.log(`[role_scopes_population] down: ${res.rowCount ?? 0} roles vueltos a own`);
};
