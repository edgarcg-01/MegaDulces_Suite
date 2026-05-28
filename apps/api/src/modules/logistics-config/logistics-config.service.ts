import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';

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

  async create(dto: CreateConfigDto) {
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
      return row;
    });
  }

  async list(query: ListConfigQuery) {
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

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.config_finance').where({ id }).first();
      if (!row) throw new NotFoundException(`Config ${id} no encontrado`);
      return row;
    });
  }

  async update(id: string, dto: UpdateConfigDto) {
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

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of ['key', 'category', 'description', 'value', 'unit', 'active'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }

      const [row] = await trx('logistics.config_finance')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async delete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const cfg = await trx('logistics.config_finance').where({ id }).first();
      if (!cfg) throw new NotFoundException(`Config ${id} no encontrado`);
      await trx('logistics.config_finance').where({ id }).del();
      return { deleted: true, id };
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

  async createRoute(dto: {
    name: string;
    driver_commission?: number;
    helper_commission?: number;
    estimated_km?: number | null;
    origin?: string;
    destination?: string;
    notes?: string;
  }) {
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
      return row;
    });
  }

  async updateRoute(id: string, dto: {
    name?: string;
    driver_commission?: number;
    helper_commission?: number;
    estimated_km?: number | null;
    origin?: string;
    destination?: string;
    notes?: string;
    active?: boolean;
  }) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.routes').where({ id }).whereNull('deleted_at').first();
      if (!existing) throw new NotFoundException(`Route ${id} no encontrada`);
      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of ['name','driver_commission','helper_commission','estimated_km','origin','destination','notes','active'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }
      const [row] = await trx('logistics.routes').where({ id }).update(patch).returning('*');
      return row;
    });
  }

  async deleteRoute(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const route = await trx('logistics.routes').where({ id }).whereNull('deleted_at').first();
      if (!route) throw new NotFoundException(`Route ${id} no encontrada`);
      await trx('logistics.routes').where({ id }).update({ deleted_at: trx.fn.now() });
      return { deleted: true, id };
    });
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
