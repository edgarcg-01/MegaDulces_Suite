/**
 * SQL: ¿la persona `identity.users <alias>` tiene el permiso EFECTIVO `?`?
 *
 * Es lo mismo que arma el JWT en `login-core.ts`: el override de la PERSONA (`identity.user_permissions`) manda
 * en los dos sentidos; si no hay, la UNIÓN de su rol base (`users.role_name`) y sus complementos
 * (`identity.user_roles`). Cruzar sólo `users.role_name` deja fuera a quien recibió la llave por un
 * complemento o un ajuste personal (revisión MDT del 2026-11-17: el vale no se le podía asignar).
 *
 * ⚠️ El god-mode (`superadmin`/`admin`) entra por el NOMBRE del rol en el guard, no por la llave: aquí sólo
 * cuenta si su mapa la tiene.
 *
 * Lleva DOS parámetros por uso, los dos la misma llave: `whereRaw(permisoEfectivoSql('u'), [k, k])`.
 *
 * Deuda con nombre (ADR-056): `libs/service-desk/src/lib/agents.service.ts` tiene su propia copia
 * (`EFECTIVO`, sin el filtro de `rp.deleted_at`); pasarla a ésta es de su dueño.
 */
export function permisoEfectivoSql(alias = 'u'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`alias inválido: ${alias}`);
  return `COALESCE(
  (SELECT up.allow FROM identity.user_permissions up
    WHERE up.tenant_id = ${alias}.tenant_id AND up.user_id = ${alias}.id AND up.permission_key = ?),
  EXISTS (
    SELECT 1
      FROM (SELECT ur.role_name FROM identity.user_roles ur WHERE ur.tenant_id = ${alias}.tenant_id AND ur.user_id = ${alias}.id
            UNION SELECT ${alias}.role_name) roles
      JOIN identity.role_permissions rp ON rp.tenant_id = ${alias}.tenant_id AND lower(rp.role_name) = lower(roles.role_name)
     WHERE rp.permissions ->> ? = 'true' AND rp.deleted_at IS NULL
  )
)`;
}
