'use strict';
/**
 * Otorga `FINANCE_EXPENSES_CAPTURAR` a los roles del listado de usuarios de
 * gastos (Excel "LISTADO DE USUARIOS DE GASTOS", 58 nombres → 31 usuarios
 * confirmados en 18 roles).
 *
 * POR QUÉ SOLO ESTE PERMISO. La pantalla `/finanzas/capturar-gasto` usa 5
 * endpoints (`/gastos`, `/upload`, `/validate-photo`, `POST /`, `/mine`) y los
 * 5 aceptan `RequireAnyPermission(FINANCE_EXPENSES_CAPTURAR, FINANCE_EXPENSES_VER)`.
 * NO usa `/gastos-list`, `/status-by-solicitud` ni `/proofs/departamentos`, que
 * son los que exigen `FINANCE_EXPENSES_VER`. Así que CAPTURAR se sostiene solo y
 * NO hay que otorgar VER — que es el permiso ancho del módulo de gastos y fue
 * uno de los 25 de la fuga que se revocó en `20260820203000`.
 *
 * Lo que da CAPTURAR (por su propia definición en permission-meta): subir el
 * folio del gasto de Kepler y su comprobante, y ver SUS PROPIAS capturas. No da
 * la bandeja de revisión ni validar/rechazar (eso es FINANCE_EXPENSES_COMPROBAR).
 *
 * ALCANCE. El modelo es 1 usuario = 1 rol, así que el permiso se otorga a nivel
 * ROL: los 31 confirmados quedan cubiertos y con ellos 49 compañeros del mismo
 * rol (80 de 112 del padrón). Autorizado así por Edgar; `cajera` entra completo
 * porque las 3 cajeras del listado se quedan como cajeras (decisión 2026-08-21)
 * y no se les crea cuenta nombrada.
 *
 * Idempotente y tolerante: solo escribe en los roles que existan en cada tenant,
 * así corre igual en local (que tiene otros roles) y en prod.
 *
 * Requiere RE-LOGIN: los permisos viajan en el JWT.
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'FINANCE_EXPENSES_CAPTURAR';

// Los 18 roles de los usuarios confirmados del listado.
const ROLES = [
  'analista_credito_cobranza',
  'auxiliar_compras',
  'auxiliar_finanzas',
  'auxiliar_mercadotecnia',
  'auxiliar_sucursal',
  'cajera',
  'colaborador',
  'coordinador_presupuestos',
  'coordinadora_contabilidad',
  'encargada_operaciones_compras',
  'encargada_prevencion',
  'encargado_sucursal',
  'etiquetas_tienda',
  'gerente_compras',
  'gerente_finanzas',
  'jefe_marketing',
  'superadmin',
  'supervisor_ventas',
];

exports.up = async function up(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true),
            updated_at = now()
      WHERE lower(role_name) = ANY(?::text[])
        AND deleted_at IS NULL
        AND COALESCE((permissions->>?::text)::boolean, false) IS NOT TRUE`,
    [PERM, ROLES, PERM],
  );
  console.log(`[grant_expenses_capturar] ${PERM} otorgado en ${res.rowCount ?? 0} filas de rol`);

  const cobertura = await knex.raw(
    `SELECT rp.role_name,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id
                AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
      WHERE lower(rp.role_name) = ANY(?::text[])
        AND rp.deleted_at IS NULL
        AND (rp.permissions->>?::text)::boolean IS TRUE
      ORDER BY 2 DESC, 1`,
    [ROLES, PERM],
  );
  let total = 0;
  for (const r of cobertura.rows) {
    total += Number(r.usuarios);
    if (Number(r.usuarios) > 0) {
      console.log(`  ${r.role_name}: ${r.usuarios} usuario(s)`);
    }
  }
  console.log(`[grant_expenses_capturar] usuarios con acceso a /finanzas/capturar-gasto: ${total} — deben RE-LOGUEAR`);

  // Control: que este cambio NO haya otorgado el permiso ancho del módulo.
  const ver = await knex.raw(
    `SELECT count(*) n FROM identity.role_permissions
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL
        AND (permissions->>'FINANCE_EXPENSES_VER')::boolean IS TRUE`,
    [ROLES],
  );
  console.log(`[grant_expenses_capturar] roles del lote con FINANCE_EXPENSES_VER (no lo toca esta mig): ${ver.rows[0].n}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, false)
      WHERE lower(role_name) = ANY(?::text[])`,
    [PERM, ROLES],
  );
};
