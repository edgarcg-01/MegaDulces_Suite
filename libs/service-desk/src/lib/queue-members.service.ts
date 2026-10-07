/**
 * `[MS.7.6]` Quién atiende cada cola: la administración de `servicedesk.queue_members`. `FASE_MS7_MANTENIMIENTO.md` (M1, M9).
 *
 * Reglas, y por qué:
 *  · **Sólo la coordinación DE ESA COLA** (clave `SERVICIO_COORDINAR` + rol `coordinador` ahí) o el god-mode agrega, cambia
 *    de rol o quita miembros. Que un coordinador de TI pueda meterse a Mantenimiento «para ver» sería exactamente la fuga que
 *    esta fase cierra; y cuando la cola sea confidencial (Fase RH) el god-mode dejará de poder, para que un administrador no
 *    se agregue a sí mismo y lo vea todo (hallazgo H1 de `FASE_RH_MESA_DE_SERVICIO.md`).
 *  · **No se agrega a quien no podría actuar**: un `coordinador` debe tener la clave de coordinar y un `tecnico` la de atender
 *    (o coordinar). Un miembro sin la clave no ve ni hace nada: ofrecerlo como destino de una asignación sería un callejón.
 *    La clave la da Administración (`/admin/personas`); aquí se dice con claridad que falta.
 *  · **Una cola nunca se queda sin coordinador** (si no, nadie podría administrarla salvo el god-mode).
 *  · **No se quita a quien tiene solicitudes abiertas asignadas**: quedarían «asignadas» a alguien que ya no las ve, que es
 *    el peor lugar para que se pierda un ticket (misma razón por la que el ruteo no asigna a quien no puede atender).
 *  · Quitar es `active = false`, no borrar: la fila conserva quién y cuándo.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { SD_QUEUE_ROLES, type SdQueueMemberDto, type SdQueueMembersResponse, type SdQueueRole } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { ServiceDeskAgentsService } from './agents.service';
import { puedeAtenderCola, puedeCoordinarCola } from './domain/queue-access';
import type { ActorCtx } from './service-desk.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABIERTOS = ['asignado', 'en_proceso', 'en_espera'];

@Injectable()
export class ServiceDeskQueueMembersService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly agents: ServiceDeskAgentsService,
  ) {}

  /** Los miembros de una cola. Los ve quien la atiende (para saber con quién trabaja) y el god-mode. */
  async list(ctx: ActorCtx, queueId: string): Promise<SdQueueMembersResponse> {
    if (!UUID_RE.test(queueId)) throw new NotFoundException('Cola no encontrada');
    if (!puedeAtenderCola(ctx.colas, queueId)) throw new NotFoundException('Cola no encontrada');
    return this.tk.run((trx) => this.leer(trx, queueId));
  }

  async upsert(ctx: ActorCtx, queueId: string, userId: string, role: unknown): Promise<SdQueueMembersResponse> {
    if (!UUID_RE.test(queueId)) throw new NotFoundException('Cola no encontrada');
    if (!UUID_RE.test(userId)) throw new BadRequestException('user_id inválido');
    if (typeof role !== 'string' || !(SD_QUEUE_ROLES as readonly string[]).includes(role)) {
      throw new BadRequestException(`role debe ser uno de: ${SD_QUEUE_ROLES.join(', ')}`);
    }
    const rol = role as SdQueueRole;
    return this.tk.run(async (trx) => {
      await this.exigirCola(trx, queueId);
      this.exigirCoordinacion(ctx, queueId);

      const persona = await trx('identity.users')
        .where({ id: userId })
        .whereNull('deleted_at')
        .whereRaw(`COALESCE(kind, 'interno') <> 'servicio'`)
        .whereRaw(`role_name NOT LIKE 'retirado%'`)
        .first('id');
      if (!persona) throw new BadRequestException('La persona no existe o no puede atender solicitudes');

      const cap = (await this.agents.capacidades(trx, [userId])).get(userId);
      if (rol === 'coordinador' && !cap?.coordinar) {
        throw new BadRequestException('Esa persona no tiene el permiso de coordinar (SERVICIO_COORDINAR). Pídelo a Administración antes de nombrarla coordinadora.');
      }
      if (rol === 'tecnico' && !cap?.atender && !cap?.coordinar) {
        throw new BadRequestException('Esa persona no tiene el permiso de atender (SERVICIO_ATENDER). Pídelo a Administración antes de agregarla.');
      }

      const actual = await trx('servicedesk.queue_members').where({ queue_id: queueId, user_id: userId }).first('id', 'role', 'active');
      // Bajar de coordinador a técnico a quien es el último coordinador dejaría la cola huérfana.
      if (actual?.active && actual.role === 'coordinador' && rol === 'tecnico') await this.exigirOtroCoordinador(trx, queueId, userId);

      if (actual) {
        await trx('servicedesk.queue_members').where({ id: actual.id }).update({ role: rol, active: true, updated_at: trx.fn.now(), updated_by: ctx.userId });
      } else {
        await trx('servicedesk.queue_members').insert({
          tenant_id: this.tenantCtx.requireTenantId(),
          queue_id: queueId,
          user_id: userId,
          role: rol,
          created_by: ctx.userId,
          updated_by: ctx.userId,
        });
      }
      return this.leer(trx, queueId);
    });
  }

  async remove(ctx: ActorCtx, queueId: string, userId: string): Promise<SdQueueMembersResponse> {
    if (!UUID_RE.test(queueId)) throw new NotFoundException('Cola no encontrada');
    if (!UUID_RE.test(userId)) throw new BadRequestException('user_id inválido');
    return this.tk.run(async (trx) => {
      await this.exigirCola(trx, queueId);
      this.exigirCoordinacion(ctx, queueId);
      const m = await trx('servicedesk.queue_members').where({ queue_id: queueId, user_id: userId, active: true }).first('id', 'role');
      if (!m) throw new NotFoundException('Esa persona no es miembro de la cola');
      if (m.role === 'coordinador') await this.exigirOtroCoordinador(trx, queueId, userId);
      const abiertas = await trx('servicedesk.requests')
        .where({ queue_id: queueId, assigned_to: userId })
        .whereNull('deleted_at')
        .whereIn('status', ABIERTOS)
        .count({ n: '*' })
        .first();
      const n = Number(abiertas?.n ?? 0);
      if (n > 0) {
        throw new ConflictException(`Tiene ${n} solicitud${n === 1 ? '' : 'es'} abierta${n === 1 ? '' : 's'} asignada${n === 1 ? '' : 's'}: reasígnalas antes de quitarla de la cola`);
      }
      await trx('servicedesk.queue_members').where({ id: m.id }).update({ active: false, updated_at: trx.fn.now(), updated_by: ctx.userId });
      return this.leer(trx, queueId);
    });
  }

  /** Quien crea una cola queda como su coordinador: si no, crearía algo que ya no puede ver ni administrar. */
  async altaComoCoordinador(trx: Knex.Transaction, ctx: ActorCtx, queueId: string): Promise<void> {
    if (ctx.esGod) return; // el god-mode ve todas las colas sin ser miembro
    await trx('servicedesk.queue_members')
      .insert({ tenant_id: this.tenantCtx.requireTenantId(), queue_id: queueId, user_id: ctx.userId, role: 'coordinador', created_by: ctx.userId, updated_by: ctx.userId })
      .onConflict(['tenant_id', 'queue_id', 'user_id'])
      .merge({ role: 'coordinador', active: true, updated_at: trx.fn.now(), updated_by: ctx.userId });
  }

  // ── internos ──

  private exigirCoordinacion(ctx: ActorCtx, queueId: string): void {
    if (!ctx.esCoordinador && !ctx.esGod) throw new ForbiddenException('Sólo la coordinación administra a quienes atienden una cola');
    if (!puedeCoordinarCola(ctx.colas, queueId)) throw new ForbiddenException('Sólo la coordinación de esa cola administra a sus miembros');
  }

  private async exigirCola(trx: Knex.Transaction, queueId: string): Promise<void> {
    const q = await trx('servicedesk.queues').where({ id: queueId }).whereNull('deleted_at').first('id');
    if (!q) throw new NotFoundException('Cola no encontrada');
  }

  private async exigirOtroCoordinador(trx: Knex.Transaction, queueId: string, excepto: string): Promise<void> {
    const otros = await trx('servicedesk.queue_members').where({ queue_id: queueId, role: 'coordinador', active: true }).whereNot('user_id', excepto).count({ n: '*' }).first();
    if (Number(otros?.n ?? 0) === 0) throw new ConflictException('La cola no puede quedarse sin coordinación: nombra a otra persona coordinadora primero');
  }

  private async leer(trx: Knex.Transaction, queueId: string): Promise<SdQueueMembersResponse> {
    const filas = (await trx('servicedesk.queue_members as m')
      .join('identity.users as u', function () {
        this.on('u.tenant_id', 'm.tenant_id').andOn('u.id', 'm.user_id');
      })
      .where({ 'm.queue_id': queueId, 'm.active': true })
      .select('m.user_id', 'm.role', 'u.username', 'u.nombre')
      .orderByRaw(`CASE m.role WHEN 'coordinador' THEN 0 ELSE 1 END`)
      .orderByRaw('lower(coalesce(u.nombre, u.username))')) as { user_id: string; role: SdQueueRole; username: string; nombre: string | null }[];
    const caps = await this.agents.capacidades(trx, filas.map((f) => f.user_id));
    const members: SdQueueMemberDto[] = filas.map((f) => ({
      user_id: f.user_id,
      username: f.username,
      name: f.nombre ?? null,
      role: f.role,
      can_attend: caps.get(f.user_id)?.atender === true || caps.get(f.user_id)?.coordinar === true,
      can_coordinate: caps.get(f.user_id)?.coordinar === true,
    }));
    return { queue_id: queueId, members };
  }
}
