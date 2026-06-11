import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPE_TO_KIND: Record<string, 'brand' | 'product' | 'category'> = {
  focus_brand: 'brand',
  manual_product: 'product',
  manual_category: 'category',
};
const TARGET_TABLE: Record<string, string> = {
  brand: 'catalog.brands',
  product: 'catalog.products',
  category: 'catalog.categories',
};

export interface CreateDirectiveDto {
  directive_type: 'focus_brand' | 'manual_product' | 'manual_category';
  target_id: string;
  reason: string;
  boost?: number;
  sponsor?: string;
  valid_from?: string;
  valid_to?: string;
}

/**
 * Thot T.2 — gestión de directrices de empuje (el negocio decide qué empujar).
 * Manual: focus_brand / manual_product / manual_category. El boost lo aplica
 * ThotService al score. Gateado por COMMERCIAL_PROMOTIONS_GESTIONAR (no el vendedor).
 */
@Injectable()
export class PushDirectivesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  /** Directrices activas/vigentes con el nombre del target para mostrar. */
  async list() {
    return this.tk.run(async (trx) =>
      trx('intelligence.push_directives as d')
        .whereNull('d.deleted_at')
        .leftJoin('catalog.brands as b', function () {
          this.on('d.target_kind', '=', trx.raw("'brand'")).andOn('b.id', '=', 'd.target_id');
        })
        .leftJoin('catalog.products as p', function () {
          this.on('d.target_kind', '=', trx.raw("'product'")).andOn('p.id', '=', 'd.target_id');
        })
        .leftJoin('catalog.categories as c', function () {
          this.on('d.target_kind', '=', trx.raw("'category'")).andOn('c.id', '=', 'd.target_id');
        })
        .select(
          'd.id', 'd.directive_type', 'd.target_kind', 'd.target_id',
          'd.boost', 'd.reason', 'd.sponsor', 'd.valid_from', 'd.valid_to',
          'd.active', 'd.created_at',
          trx.raw('COALESCE(b.nombre, p.nombre, c.name) AS target_name'),
        )
        .orderBy('d.created_at', 'desc'),
    );
  }

  async create(dto: CreateDirectiveDto) {
    const kind = TYPE_TO_KIND[dto.directive_type];
    if (!kind) throw new BadRequestException('directive_type inválido');
    if (!UUID.test(dto.target_id)) throw new BadRequestException('target_id inválido');
    if (!dto.reason?.trim()) throw new BadRequestException('reason requerido');
    const boost = dto.boost == null ? 0.5 : Number(dto.boost);
    if (!(boost >= 0 && boost <= 5)) throw new BadRequestException('boost fuera de rango [0..5]');

    return this.tk.run(async (trx) => {
      const target = await trx(TARGET_TABLE[kind])
        .where({ id: dto.target_id })
        .whereNull('deleted_at')
        .first('id');
      if (!target) throw new NotFoundException(`${kind} ${dto.target_id} no encontrado`);

      const [row] = await trx('intelligence.push_directives')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          directive_type: dto.directive_type,
          target_kind: kind,
          target_id: dto.target_id,
          boost,
          reason: dto.reason.trim().slice(0, 80),
          sponsor: dto.sponsor?.trim().slice(0, 80) || null,
          valid_from: dto.valid_from || null,
          valid_to: dto.valid_to || null,
          created_by: this.ctx.get()?.userId || null,
        })
        .returning('*');
      return row;
    });
  }

  async update(id: string, patch: { boost?: number; reason?: string; sponsor?: string; active?: boolean; valid_to?: string | null }) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    const upd: Record<string, unknown> = {};
    if (patch.boost != null) {
      if (!(patch.boost >= 0 && patch.boost <= 5)) throw new BadRequestException('boost fuera de rango');
      upd.boost = patch.boost;
    }
    if (patch.reason != null) upd.reason = patch.reason.trim().slice(0, 80);
    if (patch.sponsor !== undefined) upd.sponsor = patch.sponsor?.trim().slice(0, 80) || null;
    if (patch.active != null) upd.active = patch.active;
    if (patch.valid_to !== undefined) upd.valid_to = patch.valid_to || null;
    return this.tk.run(async (trx) => {
      const [row] = await trx('intelligence.push_directives')
        .where({ id })
        .whereNull('deleted_at')
        .update({ ...upd, updated_at: trx.fn.now() })
        .returning('*');
      if (!row) throw new NotFoundException('Directriz no encontrada');
      return row;
    });
  }

  /** Marcas comerciales (con conteo de productos) para el picker de marca foco. */
  async listBrands(search?: string) {
    const term = (search || '').trim();
    return this.tk.run(async (trx) => {
      let q = trx('catalog.brands as b')
        .whereNull('b.deleted_at')
        .where(function () {
          this.where('b.is_commercial', true).orWhereNull('b.is_commercial');
        })
        .select(
          'b.id',
          'b.nombre',
          trx.raw('(SELECT count(*) FROM catalog.products p WHERE p.brand_id = b.id AND p.deleted_at IS NULL)::int AS products'),
        )
        .orderBy('b.nombre')
        .limit(50);
      if (term) q = q.where('b.nombre', 'ilike', `%${term}%`);
      return q;
    });
  }

  async remove(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const n = await trx('intelligence.push_directives')
        .where({ id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), active: false });
      if (!n) throw new NotFoundException('Directriz no encontrada');
      return { deleted: true, id };
    });
  }
}
