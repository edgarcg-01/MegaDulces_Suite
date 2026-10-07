/**
 * `[MS.2.7]` Configuración de la Mesa de Servicio para la coordinación: horario hábil, SLA, colas y categorías.
 *
 * La base ya es la última defensa (los CHECK de `servicedesk.*` rechazan horarios invertidos, plazos en cero,
 * `first_response > resolution`…). Acá se valida ANTES para devolver un 400 con la razón en español, no un
 * `23514` de Postgres, y para que lo que no tiene CHECK (la zona horaria) tampoco entre.
 *
 * Todo lo que se cambia aplica de inmediato: el resto del módulo lee la configuración en cada operación.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  SD_PRIORITIES,
  SD_PRIORITY_MODELS,
  type SdCategoryAdminDto,
  type SdClock,
  type SdConfigResponse,
  type SdFieldAdminDto,
  type SdPriority,
  type SdPriorityModel,
  type SdQueueAdminDto,
  type SdSettingsDto,
  type SdSlaPolicyDto,
  type SdUpsertCategoryDto,
  type SdUpsertFieldDto,
  type SdUpsertQueueDto,
  type SdUpsertZoneDto,
  type SdZoneAdminDto,
} from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { parseHHMM } from './domain/business-clock';
import { validarDefinicionCampo } from './domain/campos-extra';
import { puedeCoordinarCola } from './domain/queue-access';
import { ServiceDeskQueueMembersService } from './queue-members.service';
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
    private readonly members: ServiceDeskQueueMembersService,
  ) {}

  async get(): Promise<SdConfigResponse> {
    return this.tk.run(async (trx) => {
      const s = await trx('servicedesk.settings').first();
      if (!s) throw new NotFoundException('La Mesa de Servicio no está configurada para este tenant');
      const policies = await trx('servicedesk.sla_policies').select('queue_id', 'priority', 'first_response_minutes', 'resolution_minutes', 'clock');
      const queues = await trx('servicedesk.queues').whereNull('deleted_at').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'code', 'name', 'department_code', 'active', 'sort_order', 'priority_model', 'asks_zone');
      const cats = await trx('servicedesk.categories').whereNull('deleted_at').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'queue_id', 'code', 'name', 'default_priority', 'requires_branch', 'active', 'sort_order');
      const zones = await trx('servicedesk.zones').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'code', 'name', 'sort_order', 'active');
      const fields = await trx('servicedesk.queue_fields').orderBy([{ column: 'sort_order' }, { column: 'label' }]).select('id', 'queue_id', 'code', 'label', 'type', 'required', 'options', 'sort_order', 'active');
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
          unassigned_alert_minutes: Number(s.unassigned_alert_minutes),
        },
        policies: (policies as SdSlaPolicyDto[])
          .map((p) => ({ queue_id: p.queue_id ?? null, priority: p.priority, first_response_minutes: Number(p.first_response_minutes), resolution_minutes: Number(p.resolution_minutes), clock: p.clock }))
          // La general primero (queue_id null), luego las de cada cola; dentro de cada una, de la más baja a la más urgente.
          .sort((a, b) => (a.queue_id ?? '').localeCompare(b.queue_id ?? '') || orden(a.priority) - orden(b.priority)),
        queues: queues as SdQueueAdminDto[],
        categories: cats as SdCategoryAdminDto[],
        zones: zones as SdZoneAdminDto[],
        fields: fields as SdFieldAdminDto[],
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
    if (dto.unassigned_alert_minutes !== undefined) {
      if (!esEntero(dto.unassigned_alert_minutes, 5, 1440)) throw new BadRequestException('unassigned_alert_minutes debe ser un entero de 5 a 1440 (minutos hábiles)');
      patch['unassigned_alert_minutes'] = dto.unassigned_alert_minutes;
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

  /**
   * Cambia los plazos de una prioridad. Sin `queueId` es la política GENERAL (la de siempre). Con `queueId` es la de ESA cola:
   * si ya tenía una propia se edita; si no, **nace como copia de la general con el cambio aplicado** (una cola puede cambiar
   * sólo algunas prioridades y heredar el resto). `[MS.7.2]` Sólo la coordinación de ESA cola (o el god-mode).
   */
  async updatePolicy(ctx: ActorCtx, priority: string, dto: Partial<Omit<SdSlaPolicyDto, 'priority' | 'queue_id'>>, queueId?: string | null): Promise<SdConfigResponse> {
    if (!SD_PRIORITIES.includes(priority as SdPriority)) throw new BadRequestException(`priority debe ser una de: ${SD_PRIORITIES.join(', ')}`);
    if (queueId) {
      if (!UUID_RE.test(queueId)) throw new BadRequestException('queue_id inválido');
      if (!puedeCoordinarCola(ctx.colas, queueId)) throw new ForbiddenException('Sólo la coordinación de esa cola cambia sus plazos');
    }
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
      const alcance = (qb: Knex.QueryBuilder): Knex.QueryBuilder => (queueId ? qb.where({ queue_id: queueId }) : qb.whereNull('queue_id'));
      const propia = await trx('servicedesk.sla_policies').where({ priority }).modify(alcance).first();
      // Sin política propia de la cola se parte de la general: es lo que la cola «hereda» y ahora cambia.
      const base = propia ?? (queueId ? await trx('servicedesk.sla_policies').where({ priority }).whereNull('queue_id').first() : null);
      if (!base) throw new NotFoundException(`No hay política para la prioridad «${priority}»`);
      if (queueId) {
        const cola = await trx('servicedesk.queues').where({ id: queueId }).whereNull('deleted_at').first('id');
        if (!cola) throw new NotFoundException('Cola no encontrada');
      }
      const primera = Number(patch['first_response_minutes'] ?? base.first_response_minutes);
      const resolucion = Number(patch['resolution_minutes'] ?? base.resolution_minutes);
      if (primera > resolucion) throw new BadRequestException('La primera respuesta no puede tardar más que la resolución');
      try {
        if (propia) {
          await trx('servicedesk.sla_policies').where({ id: propia.id }).update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
        } else if (queueId) {
          await trx('servicedesk.sla_policies').insert({
            tenant_id: this.tenantCtx.requireTenantId(),
            queue_id: queueId,
            priority,
            first_response_minutes: base.first_response_minutes,
            resolution_minutes: base.resolution_minutes,
            clock: base.clock,
            ...patch,
            created_by: ctx.userId,
            updated_by: ctx.userId,
          });
        }
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  /** `[MS.7.2]` La cola vuelve a heredar la política general de esa prioridad (se borra su cambio propio). */
  async removeQueuePolicy(ctx: ActorCtx, priority: string, queueId: string): Promise<SdConfigResponse> {
    if (!SD_PRIORITIES.includes(priority as SdPriority)) throw new BadRequestException(`priority debe ser una de: ${SD_PRIORITIES.join(', ')}`);
    if (!queueId || !UUID_RE.test(queueId)) throw new BadRequestException('queue_id inválido');
    if (!puedeCoordinarCola(ctx.colas, queueId)) throw new ForbiddenException('Sólo la coordinación de esa cola cambia sus plazos');
    await this.tk.run(async (trx) => {
      const n = await trx('servicedesk.sla_policies').where({ priority, queue_id: queueId }).del();
      if (!n) throw new NotFoundException('Esa cola no tiene un plazo propio para esa prioridad: ya hereda el general');
    });
    return this.get();
  }

  async createQueue(ctx: ActorCtx, dto: SdUpsertQueueDto): Promise<SdConfigResponse> {
    const code = String(dto?.code ?? '').trim();
    const name = String(dto?.name ?? '').trim();
    if (!CODIGO_RE.test(code)) throw new BadRequestException('code debe ir en minúsculas, empezar con letra y usar sólo letras, números y guion bajo');
    if (!name) throw new BadRequestException('Escribe el nombre de la cola');
    const orden = dto.sort_order !== undefined ? this.orden(dto.sort_order) : 100;
    const modelo = dto.priority_model !== undefined ? this.modelo(dto.priority_model) : 'impacto';
    await this.tk.run(async (trx) => {
      try {
        const [{ id }] = await trx('servicedesk.queues')
          .insert({
            tenant_id: this.tenantCtx.requireTenantId(),
            code,
            name,
            priority_model: modelo,
            asks_zone: dto.asks_zone === true,
            department_code: dto.department_code ? String(dto.department_code) : null,
            active: dto.active ?? true,
            sort_order: orden,
            created_by: ctx.userId,
            updated_by: ctx.userId,
          })
          .returning('id');
        // `[MS.7.6]` Quien crea la cola queda como su coordinador: si no, crearía algo que ya no puede ver ni administrar.
        await this.members.altaComoCoordinador(trx, ctx, id as string);
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
    if (dto.priority_model !== undefined) patch['priority_model'] = this.modelo(dto.priority_model);
    if (dto.asks_zone !== undefined) {
      if (typeof dto.asks_zone !== 'boolean') throw new BadRequestException('asks_zone debe ser verdadero o falso');
      patch['asks_zone'] = dto.asks_zone;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');
    // `[MS.7.6]` Sólo la coordinación de ESA cola (o el god-mode) edita su cola.
    if (!puedeCoordinarCola(ctx.colas, id)) throw new ForbiddenException('Sólo la coordinación de esa cola puede cambiarla');
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
      // La cola debe existir (400, como siempre) y, `[MS.7.6]`, las categorías de una cola las edita la coordinación de ESA cola.
      const cola = await trx('servicedesk.queues').where({ id: dto.queue_id }).whereNull('deleted_at').first('id');
      if (!cola) throw new BadRequestException('La cola indicada no existe');
      if (!puedeCoordinarCola(ctx.colas, dto.queue_id as string)) throw new ForbiddenException('Sólo la coordinación de esa cola puede agregarle categorías');
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
      const cat = await trx('servicedesk.categories').where({ id }).whereNull('deleted_at').first('queue_id');
      if (!cat) throw new NotFoundException('Categoría no encontrada');
      // `[MS.7.6]` Las categorías de una cola las edita la coordinación de ESA cola.
      if (!puedeCoordinarCola(ctx.colas, cat.queue_id)) throw new ForbiddenException('Sólo la coordinación de esa cola puede cambiar sus categorías');
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

  // ── `[MS.7.4]` Campos propios de una cola ─────────────────────────────────────────────────────
  /**
   * Los campos son de UNA cola, así que los administra la coordinación de ESA cola (o el god-mode) — a diferencia de las zonas, que
   * son del tenant. El código y el tipo no cambian (los tickets ya guardan respuestas con ellos); apagar no borra.
   */
  async createField(ctx: ActorCtx, queueId: string, dto: SdUpsertFieldDto): Promise<SdConfigResponse> {
    if (!UUID_RE.test(queueId)) throw new NotFoundException('Cola no encontrada');
    if (!puedeCoordinarCola(ctx.colas, queueId)) throw new ForbiddenException('Sólo la coordinación de esa cola puede cambiar sus campos');
    const errores = validarDefinicionCampo({ code: dto?.code, label: dto?.label, type: dto?.type, options: dto?.options });
    if (errores.length) throw new BadRequestException(errores.join('. '));
    if (dto.required !== undefined && typeof dto.required !== 'boolean') throw new BadRequestException('required debe ser verdadero o falso');
    const orden = dto.sort_order !== undefined ? this.orden(dto.sort_order) : 100;
    const opciones = dto.type === 'select' ? (dto.options as string[]).map((o) => o.trim()) : [];
    await this.tk.run(async (trx) => {
      const cola = await trx('servicedesk.queues').where({ id: queueId }).whereNull('deleted_at').first('id');
      if (!cola) throw new NotFoundException('Cola no encontrada');
      try {
        await trx('servicedesk.queue_fields').insert({
          tenant_id: this.tenantCtx.requireTenantId(),
          queue_id: queueId,
          code: dto.code,
          label: String(dto.label).trim(),
          type: dto.type,
          required: dto.required === true,
          options: JSON.stringify(opciones),
          sort_order: orden,
          active: dto.active ?? true,
          created_by: ctx.userId,
          updated_by: ctx.userId,
        });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  async updateField(ctx: ActorCtx, id: string, dto: SdUpsertFieldDto): Promise<SdConfigResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Campo no encontrado');
    if (dto.code !== undefined) throw new BadRequestException('El código de un campo no se cambia (los tickets ya guardan respuestas con él): apaga éste y crea otro');
    if (dto.type !== undefined) throw new BadRequestException('El tipo de un campo no se cambia (invalidaría lo ya guardado): apaga éste y crea otro');
    const patch: Record<string, unknown> = {};
    if (dto.label !== undefined) {
      const l = String(dto.label).trim();
      if (!l || l.length > 80) throw new BadRequestException('Escribe la pregunta del campo (hasta 80 caracteres)');
      patch['label'] = l;
    }
    if (dto.required !== undefined) {
      if (typeof dto.required !== 'boolean') throw new BadRequestException('required debe ser verdadero o falso');
      patch['required'] = dto.required;
    }
    if (dto.sort_order !== undefined) patch['sort_order'] = this.orden(dto.sort_order);
    if (dto.active !== undefined) {
      if (typeof dto.active !== 'boolean') throw new BadRequestException('active debe ser verdadero o falso');
      patch['active'] = dto.active;
    }
    if (dto.options === undefined && !Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');
    await this.tk.run(async (trx) => {
      const f = await trx('servicedesk.queue_fields').where({ id }).first('id', 'queue_id', 'type');
      if (!f) throw new NotFoundException('Campo no encontrado');
      // La autorización es por la cola DEL CAMPO (no por lo que diga el cuerpo).
      if (!puedeCoordinarCola(ctx.colas, f.queue_id)) throw new ForbiddenException('Sólo la coordinación de esa cola puede cambiar sus campos');
      if (dto.options !== undefined) {
        if (f.type !== 'select') throw new BadRequestException('Sólo un campo de tipo «opciones» lleva lista de opciones');
        const errores = validarDefinicionCampo({ code: 'x', label: 'x', type: 'select', options: dto.options });
        if (errores.length) throw new BadRequestException(errores.join('. '));
        patch['options'] = JSON.stringify((dto.options as string[]).map((o) => o.trim()));
      }
      try {
        await trx('servicedesk.queue_fields').where({ id }).update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  // ── `[MS.7.3]` Zonas ──────────────────────────────────────────────────────────────────────────
  /**
   * Las zonas son un catálogo del TENANT (la misma «bodega» sirve a todas las colas), no de una cola: por eso las administra quien
   * coordina ALGUNA cola (o el god-mode), no cualquiera que tenga la clave sin cola. El código es inmutable (los tickets lo guardan);
   * apagar no borra.
   */
  async createZone(ctx: ActorCtx, dto: SdUpsertZoneDto): Promise<SdConfigResponse> {
    this.exigirAdministraZonas(ctx);
    const code = String(dto?.code ?? '').trim();
    const name = String(dto?.name ?? '').trim();
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(code)) throw new BadRequestException('code debe ir en minúsculas, empezar con letra y usar sólo letras, números y guion bajo (máx. 30)');
    if (!name || name.length > 60) throw new BadRequestException('Escribe el nombre de la zona (hasta 60 caracteres)');
    const orden = dto.sort_order !== undefined ? this.orden(dto.sort_order) : 100;
    await this.tk.run(async (trx) => {
      try {
        await trx('servicedesk.zones').insert({ tenant_id: this.tenantCtx.requireTenantId(), code, name, sort_order: orden, active: dto.active ?? true, created_by: ctx.userId, updated_by: ctx.userId });
      } catch (e) {
        traducir(e);
      }
    });
    return this.get();
  }

  async updateZone(ctx: ActorCtx, id: string, dto: SdUpsertZoneDto): Promise<SdConfigResponse> {
    this.exigirAdministraZonas(ctx);
    if (!UUID_RE.test(id)) throw new NotFoundException('Zona no encontrada');
    if (dto.code !== undefined) throw new BadRequestException('El código de una zona no se cambia (los tickets ya lo guardan): apaga ésta y crea otra');
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const n = String(dto.name).trim();
      if (!n || n.length > 60) throw new BadRequestException('El nombre de la zona no puede quedar vacío (hasta 60 caracteres)');
      patch['name'] = n;
    }
    if (dto.sort_order !== undefined) patch['sort_order'] = this.orden(dto.sort_order);
    if (dto.active !== undefined) {
      if (typeof dto.active !== 'boolean') throw new BadRequestException('active debe ser verdadero o falso');
      patch['active'] = dto.active;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');
    await this.tk.run(async (trx) => {
      const n = await trx('servicedesk.zones').where({ id }).update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
      if (!n) throw new NotFoundException('Zona no encontrada');
    });
    return this.get();
  }

  private exigirAdministraZonas(ctx: ActorCtx): void {
    if (!ctx.esGod && ctx.colas.coordina.size === 0) throw new ForbiddenException('Las zonas las administra quien coordina alguna cola de la Mesa de Servicio');
  }

  /** `[MS.7.7]` El modelo con el que se sugiere la prioridad de la cola: sólo los que el código sabe aplicar. */
  private modelo(v: unknown): SdPriorityModel {
    if (typeof v !== 'string' || !(SD_PRIORITY_MODELS as readonly string[]).includes(v)) {
      throw new BadRequestException(`priority_model debe ser uno de: ${SD_PRIORITY_MODELS.join(', ')}`);
    }
    return v as SdPriorityModel;
  }

  private orden(v: unknown): number {
    if (!esEntero(v, 0, 10_000)) throw new BadRequestException('sort_order debe ser un entero de 0 a 10000');
    return v;
  }
}
