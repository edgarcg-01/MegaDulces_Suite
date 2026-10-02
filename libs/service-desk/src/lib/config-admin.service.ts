/**
 * `[MS.2.7]` Configuración de la Mesa de Servicio para la coordinación: horario hábil, SLA, colas y categorías.
 *
 * La base ya es la última defensa (los CHECK de `servicedesk.*` rechazan horarios invertidos, plazos en cero,
 * `first_response > resolution`…). Acá se valida ANTES para devolver un 400 con la razón en español, no un
 * `23514` de Postgres, y para que lo que no tiene CHECK (la zona horaria) tampoco entre.
 *
 * Todo lo que se cambia aplica de inmediato: el resto del módulo lee la configuración en cada operación.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  SD_PRIORITIES,
  type SdCategoryAdminDto,
  type SdClock,
  type SdConfigResponse,
  type SdPriority,
  type SdQueueAdminDto,
  type SdSettingsDto,
  type SdSlaPolicyDto,
  type SdUpsertCategoryDto,
  type SdUpsertQueueDto,
} from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { parseHHMM } from './domain/business-clock';
import type { ActorCtx } from './service-desk.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODIGO_RE = /^[a-z][a-z0-9_]*$/;
const hhmm = (v: unknown): string => String(v).slice(0, 5);
const esEntero = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function zonaValida(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Traduce el error de Postgres a un 4xx legible. Lo desconocido se relanza tal cual. */
function traducir(e: unknown): never {
  const code = (e as { code?: string })?.code;
  if (code === '23505') throw new ConflictException('Ya existe un registro con ese código');
  if (code === '23503') throw new BadRequestException('La referencia indicada no existe (cola o departamento)');
  if (code === '23514') throw new BadRequestException('El valor no cumple una regla de la base de datos');
  throw e;
}

@Injectable()
export class ServiceDeskConfigAdminService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async get(): Promise<SdConfigResponse> {
    return this.tk.run(async (trx) => {
      const s = await trx('servicedesk.settings').first();
      if (!s) throw new NotFoundException('La Mesa de Servicio no está configurada para este tenant');
      const policies = await trx('servicedesk.sla_policies').select('priority', 'first_response_minutes', 'resolution_minutes', 'clock');
      const queues = await trx('servicedesk.queues').whereNull('deleted_at').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'code', 'name', 'department_code', 'active', 'sort_order');
      const cats = await trx('servicedesk.categories').whereNull('deleted_at').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'queue_id', 'code', 'name', 'default_priority', 'requires_branch', 'active', 'sort_order');
      const orden = (p: SdPriority): number => SD_PRIORITIES.indexOf(p);
      return {
        settings: {
          business_days: (s.business_days as number[]).map(Number).sort((a, b) => a - b),
          business_start: hhmm(s.business_start),
          business_end: hhmm(s.business_end),
          tz: s.tz,
          auto_close_days: Number(s.auto_close_days),
          escalate_at_pct: Number(s.escalate_at_pct),
          escalation_enabled: !!s.escalation_enabled,
          max_attachment_mb: Number(s.max_attachment_mb),
        },
        policies: (policies as SdSlaPolicyDto[])
          .map((p) => ({ priority: p.priority, first_response_minutes: Number(p.first_response_minutes), resolution_minutes: Number(p.resolution_minutes), clock: p.clock }))
          .sort((a, b) => orden(a.priority) - orden(b.priority)),
        queues: queues as SdQueueAdminDto[],
        categories: cats as SdCategoryAdminDto[],
      };
    });
  }

  async updateSettings(ctx: ActorCtx, dto: Partial<SdSettingsDto>): Promise<SdConfigResponse> {
    const patch: Record<string, unknown> = {};
    if (dto.business_days !== undefined) {
      const d = dto.business_days;
      if (!Array.isArray(d) || !d.length || !d.every((x) => esEntero(x, 0, 6))) throw new BadRequestException('business_days debe ser una lista no vacía de 0 (domingo) a 6 (sábado)');
      patch['business_days'] = [...new Set(d)].sort((a, b) => a - b);
    }
    if (dto.business_start !== undefined) patch['business_start'] = this.hora(dto.business_start, 'business_start');
    if (dto.business_end !== undefined) patch['business_end'] = this.hora(dto.business_end, 'business_end');
    if (dto.tz !== undefined) {
      if (typeof dto.tz !== 'string' || !zonaValida(dto.tz)) throw new BadRequestException('tz no es una zona horaria IANA válida');
      patch['tz'] = dto.tz;
    }
    if (dto.auto_close_days !== undefined) {
      if (!esEntero(dto.auto_close_days, 1, 60)) throw new BadRequestException('auto_close_days debe ser un entero de 1 a 60');
      patch['auto_close_days'] = dto.auto_close_days;
    }
    if (dto.escalate_at_pct !== undefined) {
      if (!esEntero(dto.escalate_at_pct, 1, 100)) throw new BadRequestException('escalate_at_pct debe ser un entero de 1 a 100');
      patch['escalate_at_pct'] = dto.escalate_at_pct;
    }
    if (dto.escalation_enabled !== undefined) {
      if (typeof dto.escalation_enabled !== 'boolean') throw new BadRequestException('escalation_enabled debe ser verdadero o falso');
      patch['escalation_enabled'] = dto.escalation_enabled;
    }
    if (dto.max_attachment_mb !== undefined) {
      if (!esEntero(dto.max_attachment_mb, 1, 15)) throw new BadRequestException('max_attachment_mb debe ser un entero de 1 a 15');
      patch['max_attachment_mb'] = dto.max_attachment_mb;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');

    await this.tk.run(async (trx) => {
      const actual = await trx('servicedesk.settings').first();
      if (!actual) throw new NotFoundException('La Mesa de Servicio no está configurada para este tenant');
      // El orden de las horas se valida contra lo que quedaría, no sólo contra lo que llega.
      const ini = parseHHMM(String(patch['business_start'] ?? actual.business_start));
      const fin = parseHHMM(String(patch['business_end'] ?? actual.business_end));
      if (fin <= ini) throw new BadRequestException('El horario hábil debe terminar después de empezar');
      try {
        await trx('servicedesk.settings').update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  async updatePolicy(ctx: ActorCtx, priority: string, dto: Partial<Omit<SdSlaPolicyDto, 'priority'>>): Promise<SdConfigResponse> {
    if (!SD_PRIORITIES.includes(priority as SdPriority)) throw new BadRequestException(`priority debe ser una de: ${SD_PRIORITIES.join(', ')}`);
    const patch: Record<string, unknown> = {};
    if (dto.first_response_minutes !== undefined) {
      if (!esEntero(dto.first_response_minutes, 1, 525_600)) throw new BadRequestException('first_response_minutes debe ser un entero positivo');
      patch['first_response_minutes'] = dto.first_response_minutes;
    }
    if (dto.resolution_minutes !== undefined) {
      if (!esEntero(dto.resolution_minutes, 1, 525_600)) throw new BadRequestException('resolution_minutes debe ser un entero positivo');
      patch['resolution_minutes'] = dto.resolution_minutes;
    }
    if (dto.clock !== undefined) {
      if (dto.clock !== 'business' && dto.clock !== 'calendar') throw new BadRequestException('clock debe ser business o calendar');
      patch['clock'] = dto.clock as SdClock;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');

    await this.tk.run(async (trx) => {
      const actual = await trx('servicedesk.sla_policies').where({ priority }).first();
      if (!actual) throw new NotFoundException(`No hay política para la prioridad «${priority}»`);
      const primera = Number(patch['first_response_minutes'] ?? actual.first_response_minutes);
      const resolucion = Number(patch['resolution_minutes'] ?? actual.resolution_minutes);
      if (primera > resolucion) throw new BadRequestException('La primera respuesta no puede tardar más que la resolución');
      try {
        await trx('servicedesk.sla_policies').where({ priority }).update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  async createQueue(ctx: ActorCtx, dto: SdUpsertQueueDto): Promise<SdConfigResponse> {
    const code = String(dto?.code ?? '').trim();
    const name = String(dto?.name ?? '').trim();
    if (!CODIGO_RE.test(code)) throw new BadRequestException('code debe ir en minúsculas, empezar con letra y usar sólo letras, números y guion bajo');
    if (!name) throw new BadRequestException('Escribe el nombre de la cola');
    const orden = dto.sort_order !== undefined ? this.orden(dto.sort_order) : 100;
    await this.tk.run(async (trx) => {
      try {
        await trx('servicedesk.queues').insert({
          tenant_id: this.tenantCtx.requireTenantId(),
          code,
          name,
          department_code: dto.department_code ? String(dto.department_code) : null,
          active: dto.active ?? true,
          sort_order: orden,
          created_by: ctx.userId,
          updated_by: ctx.userId,
        });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  async updateQueue(ctx: ActorCtx, id: string, dto: SdUpsertQueueDto): Promise<SdConfigResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Cola no encontrada');
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      if (!String(dto.name).trim()) throw new BadRequestException('El nombre de la cola no puede quedar vacío');
      patch['name'] = String(dto.name).trim();
    }
    if (dto.department_code !== undefined) patch['department_code'] = dto.department_code ? String(dto.department_code) : null;
    if (dto.active !== undefined) {
      if (typeof dto.active !== 'boolean') throw new BadRequestException('active debe ser verdadero o falso');
      patch['active'] = dto.active;
    }
    if (dto.sort_order !== undefined) patch['sort_order'] = this.orden(dto.sort_order);
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');
    await this.tk.run(async (trx) => {
      try {
        const n = await trx('servicedesk.queues').where({ id }).whereNull('deleted_at').update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
        if (!n) throw new NotFoundException('Cola no encontrada');
      } catch (e) {
        if (e instanceof NotFoundException) throw e;
        traducir(e);
      }
    });
    return this.get();
  }

  async createCategory(ctx: ActorCtx, dto: SdUpsertCategoryDto): Promise<SdConfigResponse> {
    const code = String(dto?.code ?? '').trim();
    const name = String(dto?.name ?? '').trim();
    if (!dto?.queue_id || !UUID_RE.test(dto.queue_id)) throw new BadRequestException('queue_id inválido');
    if (!CODIGO_RE.test(code)) throw new BadRequestException('code debe ir en minúsculas, empezar con letra y usar sólo letras, números y guion bajo');
    if (!name) throw new BadRequestException('Escribe el nombre de la categoría');
    const prioridad = dto.default_priority ?? 'media';
    if (!SD_PRIORITIES.includes(prioridad)) throw new BadRequestException(`default_priority debe ser una de: ${SD_PRIORITIES.join(', ')}`);
    const orden = dto.sort_order !== undefined ? this.orden(dto.sort_order) : 100;
    await this.tk.run(async (trx) => {
      try {
        await trx('servicedesk.categories').insert({
          tenant_id: this.tenantCtx.requireTenantId(),
          queue_id: dto.queue_id,
          code,
          name,
          default_priority: prioridad,
          requires_branch: dto.requires_branch ?? false,
          active: dto.active ?? true,
          sort_order: orden,
          created_by: ctx.userId,
          updated_by: ctx.userId,
        });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  async updateCategory(ctx: ActorCtx, id: string, dto: SdUpsertCategoryDto): Promise<SdConfigResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Categoría no encontrada');
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      if (!String(dto.name).trim()) throw new BadRequestException('El nombre de la categoría no puede quedar vacío');
      patch['name'] = String(dto.name).trim();
    }
    if (dto.default_priority !== undefined) {
      if (!SD_PRIORITIES.includes(dto.default_priority)) throw new BadRequestException(`default_priority debe ser una de: ${SD_PRIORITIES.join(', ')}`);
      patch['default_priority'] = dto.default_priority;
    }
    if (dto.requires_branch !== undefined) {
      if (typeof dto.requires_branch !== 'boolean') throw new BadRequestException('requires_branch debe ser verdadero o falso');
      patch['requires_branch'] = dto.requires_branch;
    }
    if (dto.active !== undefined) {
      if (typeof dto.active !== 'boolean') throw new BadRequestException('active debe ser verdadero o falso');
      patch['active'] = dto.active;
    }
    if (dto.sort_order !== undefined) patch['sort_order'] = this.orden(dto.sort_order);
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');
    await this.tk.run(async (trx) => {
      try {
        const n = await this.actualizarCategoria(trx, id, patch, ctx.userId);
        if (!n) throw new NotFoundException('Categoría no encontrada');
      } catch (e) {
        if (e instanceof NotFoundException) throw e;
        traducir(e);
      }
    });
    return this.get();
  }

  // ── internos ──

  private actualizarCategoria(trx: Knex.Transaction, id: string, patch: Record<string, unknown>, userId: string): Promise<number> {
    return trx('servicedesk.categories').where({ id }).whereNull('deleted_at').update({ ...patch, updated_at: trx.fn.now(), updated_by: userId });
  }

  private hora(v: unknown, campo: string): string {
    try {
      parseHHMM(String(v));
    } catch {
      throw new BadRequestException(`${campo} debe tener el formato HH:MM`);
    }
    return String(v).slice(0, 5);
  }

  private orden(v: unknown): number {
    if (!esEntero(v, 0, 10_000)) throw new BadRequestException('sort_order debe ser un entero de 0 a 10000');
    return v;
  }
}
