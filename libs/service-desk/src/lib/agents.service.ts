/**
 * `[MS.2.4]` Quién puede ser asignado a un ticket.
 *
 * Se resuelve en SQL sobre los mismos datos que usa el `RolesGuard` (unión de `identity.user_roles` +
 * `role_permissions`, y el override de la PERSONA en `identity.user_permissions`, que gana en los dos
 * sentidos), para no pedirle al coordinador `USUARIOS_VER` sólo para llenar un selector.
 *
 * ⚠️ El god-mode (`superadmin`/`admin`) NO aparece en la lista: entra por el nombre del rol, no porque su
 * mapa tenga la clave, y listarlo metería a todos los administradores en el selector. Puede tomar un
 * ticket él mismo (`take`) y se le acepta como destino sólo si es quien asigna.
 */
import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import type { SdAgentDto } from '@megadulces/contracts';
import { Permission, TenantKnexService } from '@megadulces/platform-core';

const CLAVES = [Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR] as const;

/** `identity.users u` tiene permiso efectivo `?`: el override de la persona manda; si no hay, la unión de sus roles. */
const EFECTIVO = `COALESCE(
  (SELECT up.allow FROM identity.user_permissions up
    WHERE up.tenant_id = u.tenant_id AND up.user_id = u.id AND up.permission_key = ?),
  EXISTS (
    SELECT 1
      FROM (SELECT ur.role_name FROM identity.user_roles ur WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
            UNION SELECT u.role_name) roles
      JOIN identity.role_permissions rp ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(roles.role_name)
     WHERE rp.permissions ->> ? = 'true'
  )
)`;

@Injectable()
export class ServiceDeskAgentsService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Agentes asignables con su carga abierta. */
  list(): Promise<SdAgentDto[]> {
    return this.tk.run((trx) => this.listIn(trx));
  }

  async listIn(trx: Knex.Transaction): Promise<SdAgentDto[]> {
    const { rows } = await trx.raw(
      `SELECT u.id AS user_id, u.username, u.nombre AS name,
              (SELECT count(*)::int FROM servicedesk.requests r
                WHERE r.tenant_id = u.tenant_id AND r.assigned_to = u.id AND r.deleted_at IS NULL
                  AND r.status IN ('asignado','en_proceso','en_espera')) AS open_count
         FROM identity.users u
        WHERE u.deleted_at IS NULL
          AND COALESCE(u.kind, 'interno') <> 'servicio'
          AND (${EFECTIVO} OR ${EFECTIVO})
        ORDER BY open_count ASC, lower(coalesce(u.nombre, u.username))`,
      [CLAVES[0], CLAVES[0], CLAVES[1], CLAVES[1]],
    );
    return (rows as { user_id: string; username: string; name: string | null; open_count: number | string }[]).map((r) => ({
      user_id: r.user_id,
      username: r.username,
      name: r.name ?? null,
      open_count: Number(r.open_count),
    }));
  }

  /** ¿`userId` puede ser asignado? */
  async esAsignable(trx: Knex.Transaction, userId: string): Promise<boolean> {
    return (await this.listIn(trx)).some((a) => a.user_id === userId);
  }
}
