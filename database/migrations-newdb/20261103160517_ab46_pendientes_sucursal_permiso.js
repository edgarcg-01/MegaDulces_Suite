'use strict';
/**
 * `[AB.46]` — Reparte `SUCURSAL_PENDIENTES_VER`, la llave del módulo **Pendientes de sucursal**
 * (`/sucursal/pendientes`). Un módulo no está entregado hasta que su clave está en `role_permissions`
 * (regla 20).
 *
 * ── A quién, y por qué ──────────────────────────────────────────────────────────────────────
 * Edgar (2026-11-03): «darle acceso a cada persona con la sucursal a la misma información, y en
 * oficinas con el selector». La lista es la de los roles que ya tienen `SERVICIO_REPORTAR` en `true`
 * —la llave repartida «a todo rol con personas» (Fase MS)—, medida en prod el 2026-11-03, menos
 * `auditor_externo` (no es personal de la empresa). Qué sucursal ve cada quien lo decide su ALCANCE
 * (ScopeService, área Almacén): quien tiene sucursal en su ficha ve la suya; oficinas eligen.
 *
 * ⚠️ Efecto medido en el aterrizaje (personas con login en 30 días): 17 de 133 tenían UN solo destino
 * y entraban directo (5 almacenistas, 5 surtidores, 7 de etiquetas de anaquel); con esta llave tienen
 * dos y aterrizan en «Mi trabajo». Nadie pierde acceso a nada.
 *
 * ⚠️ Sólo hace UPDATE: se aplica a mano en prod antes de soltar. Las personas tienen que volver a
 *    entrar (el JWT trae los permisos).
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB). Si
 * alguien ya la puso en `false` a mano, no se le pisa.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[ab46_pendientes_sucursal_permiso]';
const VER = 'SUCURSAL_PENDIENTES_VER';
const ROLES = [
  'administrativo', 'almacenista', 'analisis_ventas', 'auxiliar_compras', 'auxiliar_tienda', 'cajero',
  'checador', 'compras', 'compras_operaciones', 'contabilidad', 'coordinador_embarques', 'credito_cobranza',
  'direccion', 'encargado_bodega', 'encargado_tienda', 'etiquetas_anaquel', 'facturacion', 'finanzas',
  'finanzas_operativo', 'gerente_compras', 'jefe_marketing', 'marketing', 'piso_tienda', 'prevencion',
  'prevencion_auxiliar', 'promotor_ruta', 'recursos_humanos', 'repartidor', 'superadmin', 'supervisor',
  'supervisor_ventas', 'surtidor', 'telemarketing', 'tesoreria', 'vendedor_ruta', 'vendedor_telemarketing',
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?)
        AND role_name NOT LIKE 'retirado%'
        AND permissions -> ?::text IS NULL`,
    [VER, ROLES, VER],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE role_name = ANY(?) AND permissions -> ?::text = 'true'::jsonb
      ORDER BY role_name`,
    [ROLES, VER],
  );
  const con = rows.map((r) => r.role_name);
  const faltan = ROLES.filter((r) => !con.includes(r));
  // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA quién quedó sin la clave.
  console.log(
    `${TAG} ${VER}: ${res.rowCount ?? 0} fila(s) · con la clave: ${con.length} rol(es)`
    + (faltan.length ? ` · ⚠️ SIN la clave (rol inexistente o en false a mano): [${faltan.join(', ')}]` : ''),
  );
  console.log(`${TAG} Las personas afectadas deben volver a entrar (el JWT trae los permisos).`);
};

/** No-op, como el resto de los repartos de permisos: se quita desde `/admin/roles`. */
exports.down = async function down() {
  console.log(`${TAG} down: no-op`);
};
