import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  CambioDeTarifa, cambiosDeConfig, cambiosDeRuta, configFijada, mensajeTarifaFijada, rutaFijada,
} from './tarifas-fijas.logic';

/**
 * `[EMB.28.1]` Quién hace el cambio. Lo arma el controlador desde la sesión: `autorizador` es
 * `LOGISTICS_TARIFAS_AUTORIZAR` o administrador de plataforma.
 */
export interface ActorTarifas {
  userId?: string | null;
  username?: string | null;
  autorizador: boolean;
}
const SIN_ACTOR: ActorTarifas = { autorizador: false };

/** Un renglón de `logistics.config_finance` como lo devuelve Postgres (numeric llega como texto). */
export interface ConfigRow {
  id: string;
  key: string;
  category: ConfigCategory;
  description: string | null;
  value: string | number;
  unit: string | null;
  active: boolean;
  [col: string]: unknown;
}
/** Un renglón de `logistics.routes` como lo devuelve Postgres. */
export interface RouteRow {
  id: string;
  name: string;
  driver_commission: string | number;
  helper_commission: string | number;
  estimated_km: string | number | null;
  active: boolean;
  notes: string | null;
  [col: string]: unknown;
}
export interface RouteDto {
  name?: string;
  driver_commission?: number;
  helper_commission?: number;
  estimated_km?: number | null;
  origin?: string;
  destination?: string;
  notes?: string;
  active?: boolean;
}
export interface Borrado { deleted: true; id: string }
/** `[EMB.28.1]` Un movimiento de `logistics.tariff_changes`. */
export interface TariffChangeRow {
  id: string;
  entity: 'route' | 'config';
  entity_id: string;
  entity_label: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  autorizado: boolean;
  changed_by: string | null;
  changed_by_username: string | null;
  changed_at: string;
}
const UUID_ACTOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConfigCategory = 'factor' | 'costo_km' | 'tarifa_maniobra' | 'viatico' | 'otro';

export interface CreateConfigDto {
  key: string;
  category: ConfigCategory;
  description?: string;
  value: number;
  unit?: string;
}
export type UpdateConfigDto = Partial<CreateConfigDto> & { active?: boolean };

export interface ListConfigQuery {
  category?: ConfigCategory;
  active?: boolean;
}

const KEY_REGEX = /^[a-z][a-z0-9_]{2,80}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CATEGORIES: ConfigCategory[] = ['factor', 'costo_km', 'tarifa_maniobra', 'viatico', 'otro'];

@Injectable()
export class LogisticsConfigService {
  constructor(private readonly tk: TenantKnexService) {}

  async create(dto: CreateConfigDto, actor: ActorTarifas = SIN_ACTOR): Promise<ConfigRow> {
    this.validateCreate(dto);
    return this.tk.run(async (trx) => {
      const dup = await trx('logistics.config_finance').where({ key: dto.key }).first();
      if (dup) throw new ConflictException(`Ya existe config_finance con key "${dto.key}"`);

      const [row] = await trx('logistics.config_finance')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          key: dto.key,
          category: dto.category,
          description: dto.description || null,
          value: dto.value,
          unit: dto.unit || null,
          active: true,
        })
        .returning('*');
      if (configFijada(row)) {
        await this.registrar(trx, 'config', row.id, row.key, [{ field: 'value', old_value: null, new_value: String(Number(row.value)) }], actor, false);
      }
      return row;
    });
  }

  async list(query: ListConfigQuery): Promise<ConfigRow[]> {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.config_finance');
      if (query.category) q = q.where({ category: query.category });
      if (typeof query.active === 'boolean') q = q.where({ active: query.active });
      return q.orderBy('category', 'asc').orderBy('key', 'asc');
    });
  }

  /** Lee un valor por key. Devuelve `null` si no existe (no lanza). Útil en servicios de cálculo. */
  async getValueByKey(key: string): Promise<number | null> {
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.config_finance').where({ key, active: true }).first();
      return row ? Number(row.value) : null;
    });
  }

  async findById(id: string): Promise<ConfigRow> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.config_finance').where({ id }).first();
      if (!row) throw new NotFoundException(`Config ${id} no encontrado`);
      return row;
    });
  }

  async update(id: string, dto: UpdateConfigDto, actor: ActorTarifas = SIN_ACTOR): Promise<ConfigRow> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.config_finance').where({ id }).first();
      if (!existing) throw new NotFoundException(`Config ${id} no encontrado`);

      if (dto.key && dto.key !== existing.key) {
        if (!KEY_REGEX.test(dto.key)) throw new BadRequestException('key inválida');
        const dup = await trx('logistics.config_finance')
          .where({ key: dto.key })
          .whereNot({ id })
          .first();
        if (dup) throw new ConflictException(`Ya existe config con key "${dto.key}"`);
      }
      if (dto.category && !VALID_CATEGORIES.includes(dto.category)) {
        throw new BadRequestException(`category inválida: ${dto.category}`);
      }

      // [EMB.28.1] Una tarifa con la que se paga, ya fijada, sólo la cambia un autorizador.
      const fijada = configFijada(existing);
      const cambios = cambiosDeConfig(existing, dto);
      if (fijada && cambios.length && !actor.autorizador) throw new ForbiddenException(mensajeTarifaFijada(existing.key));

      const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
      for (const k of ['key', 'category', 'description', 'value', 'unit', 'active'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }

      const [row] = await trx('logistics.config_finance')
        .where({ id })
        .update(patch)
        .returning('*');
      if (cambios.length && (fijada || configFijada(row))) {
        await this.registrar(trx, 'config', id, row.key, cambios, actor, fijada);
      }
      return row;
    });
  }

  async delete(id: string, actor: ActorTarifas = SIN_ACTOR): Promise<Borrado> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const cfg = await trx('logistics.config_finance').where({ id }).first();
      if (!cfg) throw new NotFoundException(`Config ${id} no encontrado`);
      // Se borra DE VERDAD: sin este candado, borrar y volver a crear saltaba el de update().
      if (configFijada(cfg)) {
        if (!actor.autorizador) throw new ForbiddenException(mensajeTarifaFijada(cfg.key));
        await this.registrar(trx, 'config', id, cfg.key, [{ field: 'borrado', old_value: String(Number(cfg.value)), new_value: null }], actor, true);
      }
      await trx('logistics.config_finance').where({ id }).del();
      return { deleted: true as const, id };
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // J.9.8 — CRUD logistics.routes (Comisiones por ruta del catálogo destinos)
  // Importadas por logistics_baseline.js (96 destinos reales con
  // driver_commission + helper_commission + estimated_km).
  // ───────────────────────────────────────────────────────────────────────

  async listRoutes(opts: { active?: boolean; search?: string } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.routes').whereNull('deleted_at');
      if (opts.active !== undefined) q = q.where('active', opts.active);
      if (opts.search) q = q.whereILike('name', `%${opts.search}%`);
      return q.orderBy('name', 'asc');
    });
  }

  async createRoute(dto: RouteDto & { name: string }, actor: ActorTarifas = SIN_ACTOR): Promise<RouteRow> {
    if (!dto.name || dto.name.length < 2) {
      throw new BadRequestException('name requerido (mín 2 chars)');
    }
    return this.tk.run(async (trx) => {
      const dup = await trx('logistics.routes')
        .where({ name: dto.name })
        .whereNull('deleted_at')
        .first();
      if (dup) throw new ConflictException(`Ya existe ruta con name "${dto.name}"`);
      const [row] = await trx('logistics.routes')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          name: dto.name,
          driver_commission: dto.driver_commission ?? 0,
          helper_commission: dto.helper_commission ?? 0,
          estimated_km: dto.estimated_km ?? null,
          origin: dto.origin || null,
          destination: dto.destination || null,
          notes: dto.notes || null,
          active: true,
        })
        .returning('*');
      if (rutaFijada(row)) {
        await this.registrar(trx, 'route', row.id, row.name, cambiosDeRuta({ driver_commission: 0, helper_commission: 0 }, row), actor, false);
      }
      return row;
    });
  }

  async updateRoute(id: string, dto: RouteDto, actor: ActorTarifas = SIN_ACTOR): Promise<RouteRow> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.routes').where({ id }).whereNull('deleted_at').first();
      if (!existing) throw new NotFoundException(`Route ${id} no encontrada`);
      // [EMB.28.1] Ruta ya tarifada: comisiones, nombre (empareja con Kepler) y desactivar = autorizador.
      const fijada = rutaFijada(existing);
      const cambios = cambiosDeRuta(existing, dto);
      if (fijada && cambios.length && !actor.autorizador) throw new ForbiddenException(mensajeTarifaFijada(existing.name));
      const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
      for (const k of ['name','driver_commission','helper_commission','estimated_km','origin','destination','notes','active'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }
      const [row] = await trx('logistics.routes').where({ id }).update(patch).returning('*');
      if (cambios.length && (fijada || rutaFijada(row))) {
        await this.registrar(trx, 'route', id, row.name, cambios, actor, fijada);
      }
      return row;
    });
  }

  async deleteRoute(id: string, actor: ActorTarifas = SIN_ACTOR): Promise<Borrado> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const route = await trx('logistics.routes').where({ id }).whereNull('deleted_at').first();
      if (!route) throw new NotFoundException(`Route ${id} no encontrada`);
      if (rutaFijada(route)) {
        if (!actor.autorizador) throw new ForbiddenException(mensajeTarifaFijada(route.name));
        await this.registrar(trx, 'route', id, route.name, [{ field: 'borrado', old_value: `${route.driver_commission}/${route.helper_commission}`, new_value: null }], actor, true);
      }
      await trx('logistics.routes').where({ id }).update({ deleted_at: trx.fn.now() });
      return { deleted: true as const, id };
    });
  }

  /** `[EMB.28.1]` La historia de una tarifa: quién, cuándo, antes y después. */
  async historial(entity: 'route' | 'config', id: string): Promise<TariffChangeRow[]> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run((trx) =>
      trx('logistics.tariff_changes').where({ entity, entity_id: id }).orderBy('changed_at', 'desc').limit(100));
  }

  private async registrar(
    trx: Knex.Transaction, entity: 'route' | 'config', id: string, label: string,
    cambios: CambioDeTarifa[], actor: ActorTarifas, autorizado: boolean,
  ): Promise<void> {
    if (!cambios.length) return;
    await trx('logistics.tariff_changes').insert(cambios.map((c) => ({
      tenant_id: trx.raw('public.current_tenant_id()'),
      entity, entity_id: id, entity_label: label,
      field: c.field, old_value: c.old_value, new_value: c.new_value,
      autorizado,
      changed_by: actor.userId && UUID_ACTOR.test(actor.userId) ? actor.userId : null,
      changed_by_username: actor.username ?? null,
    })));
  }

  private validateCreate(dto: CreateConfigDto): void {
    if (!dto.key || !KEY_REGEX.test(dto.key)) {
      throw new BadRequestException('key inválida: 3-80 chars [a-z0-9_], debe empezar con letra. Ej: "costo_km_estandar".');
    }
    if (!VALID_CATEGORIES.includes(dto.category)) {
      throw new BadRequestException(`category inválida. Permitidas: ${VALID_CATEGORIES.join(', ')}`);
    }
    if (typeof dto.value !== 'number' || Number.isNaN(dto.value)) {
      throw new BadRequestException('value debe ser número');
    }
  }
}
