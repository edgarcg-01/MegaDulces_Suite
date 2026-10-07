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
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { SdAgentDto, SdQueueCandidateDto } from '@megadulces/contracts';
import { Permission, TenantKnexService } from '@megadulces/platform-core';
import { puedeAtenderCola } from './domain/queue-access';
import type { ActorCtx } from './service-desk.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /**
   * Agentes asignables con su carga abierta. `[MS.7.6]` Con `queueId`, sólo los de esa cola; sin él, los de cualquier
   * cola. En ambos casos exige la pertenencia: quien tiene la clave pero no es miembro de ninguna cola no puede
   * hacer nada, así que ofrecerlo como destino de una asignación sería ofrecer un callejón.
   */
  list(queueId?: string | readonly string[] | null): Promise<SdAgentDto[]> {
    return this.tk.run((trx) => this.listIn(trx, queueId));
  }

  /**
   * `[MS.7.6]` Lo que ve QUIEN PREGUNTA: con `queue_id`, esa cola (si no la atiende, 404: no se revela que existe); sin él,
   * sólo los de las colas que él atiende. El god-mode ve todas. Quien no atiende ninguna cola, una lista vacía.
   */
  async listFor(ctx: ActorCtx, queueId?: string): Promise<SdAgentDto[]> {
    if (queueId) {
      if (!UUID_RE.test(queueId) || !puedeAtenderCola(ctx.colas, queueId)) throw new NotFoundException('Cola no encontrada');
      return this.list(queueId);
    }
    if (ctx.colas.todas) return this.list();
    const mias = [...ctx.colas.atiende];
    return mias.length ? this.list(mias) : [];
  }

  async listIn(trx: Knex.Transaction, queueId?: string | readonly string[] | null): Promise<SdAgentDto[]> {
    const colas = typeof queueId === 'string' ? [queueId] : queueId && queueId.length ? [...queueId] : null;
    const { rows } = await trx.raw(
      `SELECT u.id AS user_id, u.username, u.nombre AS name,
              (SELECT count(*)::int FROM servicedesk.requests r
                WHERE r.tenant_id = u.tenant_id AND r.assigned_to = u.id AND r.deleted_at IS NULL
                  AND r.status IN ('asignado','en_proceso','en_espera')) AS open_count
         FROM identity.users u
        WHERE u.deleted_at IS NULL
          AND COALESCE(u.kind, 'interno') <> 'servicio'
          AND (${EFECTIVO} OR ${EFECTIVO})
          AND EXISTS (
            SELECT 1 FROM servicedesk.queue_members m
             WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.active
               ${colas ? "AND m.queue_id = ANY(string_to_array(?, ',')::uuid[])" : ''})
        ORDER BY open_count ASC, lower(coalesce(u.nombre, u.username))`,
      [CLAVES[0], CLAVES[0], CLAVES[1], CLAVES[1], ...(colas ? [colas.join(',')] : [])],
    );
    return (rows as { user_id: string; username: string; name: string | null; open_count: number | string }[]).map((r) => ({
      user_id: r.user_id,
      username: r.username,
      name: r.name ?? null,
      open_count: Number(r.open_count),
    }));
  }

  /**
   * Qué claves tiene EFECTIVAS cada persona (atender / coordinar), con el mismo cálculo de siempre: el override de la
   * persona gana, y si no hay, la unión de sus roles. Es la CAPACIDAD, sin mirar de qué cola es miembro.
   */
  async capacidades(trx: Knex.Transaction, userIds: readonly string[]): Promise<Map<string, { atender: boolean; coordinar: boolean }>> {
    const out = new Map<string, { atender: boolean; coordinar: boolean }>();
    if (!userIds.length) return out;
    const { rows } = await trx.raw(
      `SELECT u.id, (${EFECTIVO}) AS atender, (${EFECTIVO}) AS coordinar
         FROM identity.users u
        WHERE u.id = ANY(string_to_array(?, ',')::uuid[])`,
      [CLAVES[0], CLAVES[0], CLAVES[1], CLAVES[1], userIds.join(',')],
    );
    for (const r of rows as { id: string; atender: boolean; coordinar: boolean }[]) out.set(r.id, { atender: r.atender === true, coordinar: r.coordinar === true });
    return out;
  }

  /**
   * `[MS.7.17]` Quién PODRÍA entrar a `queueId`: tiene la clave de atender o coordinar (efectiva) y todavía no es miembro activo.
   * Es lo que alimenta el selector de «agregar a la cola»: sin esto la coordinación tendría que adivinar a quién ya se le dio la clave.
   */
  async candidatos(trx: Knex.Transaction, queueId: string): Promise<SdQueueCandidateDto[]> {
    const { rows } = await trx.raw(
      `SELECT u.id AS user_id, u.username, u.nombre AS name, (${EFECTIVO}) AS can_coordinate
         FROM identity.users u
        WHERE u.deleted_at IS NULL
          AND COALESCE(u.kind, 'interno') <> 'servicio'
          AND u.role_name NOT LIKE 'retirado%'
          AND (${EFECTIVO} OR ${EFECTIVO})
          AND NOT EXISTS (
            SELECT 1 FROM servicedesk.queue_members m
             WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.queue_id = ? AND m.active)
        ORDER BY lower(coalesce(u.nombre, u.username))`,
      [CLAVES[1], CLAVES[1], CLAVES[0], CLAVES[0], CLAVES[1], CLAVES[1], queueId],
    );
    return (rows as { user_id: string; username: string; name: string | null; can_coordinate: boolean }[]).map((r) => ({
      user_id: r.user_id,
      username: r.username,
      name: r.name ?? null,
      can_coordinate: r.can_coordinate === true,
    }));
  }

  /** ¿`userId` puede ser asignado? Con `queueId`, ¿puede serlo EN ESA cola? */
  async esAsignable(trx: Knex.Transaction, userId: string, queueId?: string | null): Promise<boolean> {
    return (await this.listIn(trx, queueId)).some((a) => a.user_id === userId);
  }
}
