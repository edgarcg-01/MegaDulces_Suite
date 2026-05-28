import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';

/**
 * Tipos de promoción soportados. Cada uno tiene un shape específico en `rules`.
 * El validador valida shape por tipo en `validateRulesForType`.
 */
export type PromotionType =
  | 'percent_off_product'
  | 'percent_off_basket'
  | 'nxm'
  | 'volume_discount'
  | 'bundle_fixed_price'
  | 'cross_sell_discount';

const ALL_PROMOTION_TYPES: PromotionType[] = [
  'percent_off_product',
  'percent_off_basket',
  'nxm',
  'volume_discount',
  'bundle_fixed_price',
  'cross_sell_discount',
];

export interface CreatePromotionDto {
  code: string;
  name: string;
  description?: string;
  promotion_type: PromotionType;
  rules: Record<string, any>;
  priority?: number;
  starts_at?: string | null;
  ends_at?: string | null;
  usage_limit?: number | null;
  min_order_amount?: number | null;
  applies_to?: 'all_customers' | 'specific_customers';
  applies_to_customer_ids?: string[] | null;
  active?: boolean;
}

export type UpdatePromotionDto = Partial<CreatePromotionDto>;

export interface ListPromotionsQuery {
  page?: number;
  pageSize?: number;
  active?: boolean;
  promotion_type?: PromotionType;
  /** Solo promos vigentes a esta fecha (default: ahora). */
  validAt?: string;
  /** Aplica el filtro de vigencia. Si false, devuelve todas. */
  onlyActive?: boolean;
}

const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CommercialPromotionsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async create(dto: CreatePromotionDto) {
    this.validateCreate(dto);

    return this.tk.run(async (trx) => {
      const dup = await trx('commercial.promotions')
        .where({ code: dto.code })
        .whereNull('deleted_at')
        .first();
      if (dup) {
        throw new ConflictException(`Ya existe promoción con code "${dto.code}"`);
      }

      const [row] = await trx('commercial.promotions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code: dto.code,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          promotion_type: dto.promotion_type,
          rules: JSON.stringify(dto.rules),
          priority: dto.priority ?? 100,
          starts_at: dto.starts_at || null,
          ends_at: dto.ends_at || null,
          usage_limit: dto.usage_limit ?? null,
          usage_count: 0,
          min_order_amount: dto.min_order_amount ?? null,
          applies_to: dto.applies_to ?? 'all_customers',
          applies_to_customer_ids:
            dto.applies_to === 'specific_customers' && dto.applies_to_customer_ids?.length
              ? JSON.stringify(dto.applies_to_customer_ids)
              : null,
          active: dto.active ?? true,
          created_by_user_id: this.tenantCtx.get()?.userId || null,
        })
        .returning('*');
      return row;
    });
  }

  async list(query: ListPromotionsQuery) {
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 20));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      let q = trx('commercial.promotions').whereNull('deleted_at');
      if (typeof query.active === 'boolean') q = q.where({ active: query.active });
      if (query.promotion_type) q = q.where({ promotion_type: query.promotion_type });

      if (query.onlyActive) {
        const now = query.validAt ? new Date(query.validAt) : new Date();
        q = q
          .where({ active: true })
          .where(function () {
            this.whereNull('starts_at').orWhere('starts_at', '<=', now);
          })
          .where(function () {
            this.whereNull('ends_at').orWhere('ends_at', '>', now);
          });
      }

      const [{ total }] = await q.clone().count<{ total: string }[]>('* as total');

      const data = await q
        .orderBy('priority', 'asc')
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      return {
        data,
        pagination: {
          page,
          pageSize,
          total: Number(total) || 0,
          pageCount: Math.ceil((Number(total) || 0) / pageSize),
        },
      };
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.promotions')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Promoción ${id} no encontrada`);
      return row;
    });
  }

  async update(id: string, dto: UpdatePromotionDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validateUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.promotions')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Promoción ${id} no encontrada`);

      if (dto.code && dto.code !== existing.code) {
        const dup = await trx('commercial.promotions')
          .where({ code: dto.code })
          .whereNot({ id })
          .whereNull('deleted_at')
          .first();
        if (dup) {
          throw new ConflictException(`Ya existe promoción con code "${dto.code}"`);
        }
      }

      // Si cambia el tipo o las rules, re-validar shape del JSON.
      if (dto.promotion_type !== undefined || dto.rules !== undefined) {
        const finalType = (dto.promotion_type ?? existing.promotion_type) as PromotionType;
        const finalRules = dto.rules ?? existing.rules;
        this.validateRulesForType(finalType, finalRules);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.code !== undefined) patch.code = dto.code;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
      if (dto.promotion_type !== undefined) patch.promotion_type = dto.promotion_type;
      if (dto.rules !== undefined) patch.rules = JSON.stringify(dto.rules);
      if (dto.priority !== undefined) patch.priority = dto.priority;
      if (dto.starts_at !== undefined) patch.starts_at = dto.starts_at || null;
      if (dto.ends_at !== undefined) patch.ends_at = dto.ends_at || null;
      if (dto.usage_limit !== undefined) patch.usage_limit = dto.usage_limit;
      if (dto.min_order_amount !== undefined) patch.min_order_amount = dto.min_order_amount;
      if (dto.applies_to !== undefined) patch.applies_to = dto.applies_to;
      if (dto.applies_to_customer_ids !== undefined) {
        patch.applies_to_customer_ids =
          dto.applies_to_customer_ids && dto.applies_to_customer_ids.length
            ? JSON.stringify(dto.applies_to_customer_ids)
            : null;
      }
      if (dto.active !== undefined) patch.active = dto.active;

      const [row] = await trx('commercial.promotions')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async softDelete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.promotions')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Promoción ${id} no encontrada`);
      await trx('commercial.promotions')
        .where({ id })
        .update({ deleted_at: trx.fn.now(), active: false });
      return { deleted: true, id };
    });
  }

  /** Toggle rápido de active. Útil para "pausar" sin abrir form. */
  async setActive(id: string, active: boolean) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.promotions')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Promoción ${id} no encontrada`);
      const [row] = await trx('commercial.promotions')
        .where({ id })
        .update({ active, updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Validación
  // ═══════════════════════════════════════════════════════════════════

  private validateCreate(dto: CreatePromotionDto): void {
    if (!dto.code || !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException(
        'code requerido: 2-50 chars [A-Z0-9_-]. Ej: "NAVIDAD-2026".',
      );
    }
    if (!dto.name?.trim()) throw new BadRequestException('name requerido');
    if (!dto.promotion_type || !ALL_PROMOTION_TYPES.includes(dto.promotion_type)) {
      throw new BadRequestException(
        `promotion_type inválido. Permitidos: ${ALL_PROMOTION_TYPES.join(', ')}`,
      );
    }
    if (!dto.rules || typeof dto.rules !== 'object') {
      throw new BadRequestException('rules requerido (objeto con config del tipo)');
    }
    this.validateRulesForType(dto.promotion_type, dto.rules);
    this.validateCommonFields(dto);
  }

  private validateUpdate(dto: UpdatePromotionDto): void {
    if (dto.code !== undefined && !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code inválido');
    }
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('name no puede ser vacío');
    }
    if (dto.promotion_type !== undefined && !ALL_PROMOTION_TYPES.includes(dto.promotion_type)) {
      throw new BadRequestException(`promotion_type inválido`);
    }
    this.validateCommonFields(dto);
  }

  private validateCommonFields(dto: Partial<CreatePromotionDto>): void {
    if (dto.priority !== undefined && (dto.priority < 0 || dto.priority > 1000)) {
      throw new BadRequestException('priority debe estar entre 0 y 1000');
    }
    if (dto.applies_to === 'specific_customers') {
      if (!Array.isArray(dto.applies_to_customer_ids) || dto.applies_to_customer_ids.length === 0) {
        throw new BadRequestException(
          'applies_to=specific_customers requiere applies_to_customer_ids no vacío',
        );
      }
      for (const cid of dto.applies_to_customer_ids) {
        if (!UUID_REGEX.test(cid)) {
          throw new BadRequestException(`customer_id inválido en applies_to_customer_ids: ${cid}`);
        }
      }
    }
    if (dto.starts_at && dto.ends_at && new Date(dto.ends_at) <= new Date(dto.starts_at)) {
      throw new BadRequestException('ends_at debe ser posterior a starts_at');
    }
    if (dto.usage_limit !== undefined && dto.usage_limit !== null && dto.usage_limit < 1) {
      throw new BadRequestException('usage_limit debe ser ≥ 1 (o null para ilimitado)');
    }
    if (
      dto.min_order_amount !== undefined &&
      dto.min_order_amount !== null &&
      dto.min_order_amount < 0
    ) {
      throw new BadRequestException('min_order_amount no puede ser negativo');
    }
  }

  /**
   * Valida el shape del JSON `rules` según el `promotion_type`. La forma de
   * cada tipo está documentada en la migración.
   */
  private validateRulesForType(type: PromotionType, rules: any): void {
    const required = (field: string, predicate: (v: any) => boolean, msg: string) => {
      if (!predicate(rules[field])) {
        throw new BadRequestException(`rules.${field} ${msg} (tipo: ${type})`);
      }
    };
    const isUuid = (v: any) => typeof v === 'string' && UUID_REGEX.test(v);
    const isPercent = (v: any) => typeof v === 'number' && v > 0 && v <= 100;
    const isPositiveInt = (v: any) => typeof v === 'number' && Number.isInteger(v) && v >= 1;
    const isPositiveNumber = (v: any) => typeof v === 'number' && v > 0;

    switch (type) {
      case 'percent_off_product':
        required('product_id', isUuid, 'requerido (UUID del producto)');
        required('percent', isPercent, 'requerido (>0 y ≤100)');
        break;
      case 'percent_off_basket':
        required('percent', isPercent, 'requerido (>0 y ≤100)');
        break;
      case 'nxm':
        required('product_id', isUuid, 'requerido (UUID del producto)');
        required('n_buy', isPositiveInt, 'requerido (entero ≥1: cuántos compra)');
        required('m_pay', isPositiveInt, 'requerido (entero ≥1: cuántos paga)');
        if (rules.m_pay >= rules.n_buy) {
          throw new BadRequestException(
            'nxm inválido: m_pay debe ser menor que n_buy (ej: 2x1 = n_buy:2, m_pay:1)',
          );
        }
        break;
      case 'volume_discount':
        required('product_id', isUuid, 'requerido (UUID del producto)');
        if (!Array.isArray(rules.tiers) || rules.tiers.length === 0) {
          throw new BadRequestException('rules.tiers requerido: array de {min_qty, percent}');
        }
        for (const [i, t] of rules.tiers.entries()) {
          if (!isPositiveInt(t?.min_qty)) {
            throw new BadRequestException(`tier ${i}: min_qty requerido (entero ≥1)`);
          }
          if (!isPercent(t?.percent)) {
            throw new BadRequestException(`tier ${i}: percent requerido (>0 y ≤100)`);
          }
        }
        // Validar tiers ordenados por min_qty creciente y percent creciente.
        const sorted = [...rules.tiers].sort((a, b) => a.min_qty - b.min_qty);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].percent <= sorted[i - 1].percent) {
            throw new BadRequestException(
              `tier ${i}: percent debe ser mayor que el tier anterior (volumen ↑ descuento ↑)`,
            );
          }
        }
        break;
      case 'bundle_fixed_price':
        if (!Array.isArray(rules.items) || rules.items.length < 2) {
          throw new BadRequestException('rules.items requerido: array de ≥2 {product_id, quantity}');
        }
        for (const [i, it] of rules.items.entries()) {
          if (!isUuid(it?.product_id)) {
            throw new BadRequestException(`item ${i}: product_id requerido (UUID)`);
          }
          if (!isPositiveInt(it?.quantity)) {
            throw new BadRequestException(`item ${i}: quantity requerido (entero ≥1)`);
          }
        }
        required('price', isPositiveNumber, 'requerido (>0, precio fijo del bundle)');
        break;
      case 'cross_sell_discount':
        required('trigger_product_id', isUuid, 'requerido (UUID del producto que dispara)');
        required('target_product_id', isUuid, 'requerido (UUID del producto descontado)');
        required('percent', isPercent, 'requerido (>0 y ≤100)');
        if (rules.trigger_product_id === rules.target_product_id) {
          throw new BadRequestException(
            'cross_sell_discount: trigger_product_id y target_product_id deben ser distintos',
          );
        }
        break;
      default:
        throw new BadRequestException(`Tipo no soportado: ${type}`);
    }
  }
}
