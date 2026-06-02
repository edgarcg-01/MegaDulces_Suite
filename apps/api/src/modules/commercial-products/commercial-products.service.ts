import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';

export interface ListProductsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  brand_id?: string;
  category_id?: string;
  /** Filtro por `activo` (true = solo activos, false = solo inactivos). Undefined trae ambos. */
  active?: boolean;
  /** Solo productos con costo cargado (útil para validar imports del ERP). */
  with_cost?: boolean;
}

export interface UpdateProductDto {
  description?: string | null;
  location?: string | null;
  location_warehouse?: string | null;
  loyalty_points?: number | null;
  activo?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin CRUD-ish para `public.products`. Gateado por CATALOGO_GESTIONAR porque
 * expone columnas sensibles (cost_base, cost_with_tax, cost_per_case) que NO
 * deben ser accesibles a customer_b2b ni vendedores.
 *
 * Update limitado a campos editables manualmente por admin (description,
 * location, loyalty_points, activo). Los costos, precios, SKU, brand vienen
 * del importer Mega_Dulces — modificarlos manual rompe la consistencia con
 * el ERP. Si el admin quiere cambiar un costo, lo hace en el ERP origen.
 */
@Injectable()
export class CommercialProductsService {
  constructor(private readonly tk: TenantKnexService) {}

  async list(query: ListProductsQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    const search = (query.search || '').trim();

    return this.tk.run(async (trx) => {
      const buildBase = () => {
        let q = trx('products as p')
          .leftJoin('brands as b', function () {
            this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin('categories as cat', function () {
            this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
          })
          .whereNull('p.deleted_at');

        if (search) {
          const term = `%${search}%`;
          q = q.where((b) =>
            b.where('p.nombre', 'ilike', term)
              .orWhere('p.sku', 'ilike', term)
              .orWhere('p.barcode', 'ilike', term)
              .orWhere('p.description', 'ilike', term),
          );
        }
        if (query.brand_id) {
          if (!UUID_REGEX.test(query.brand_id)) throw new BadRequestException('brand_id inválido');
          q = q.where('p.brand_id', query.brand_id);
        }
        if (query.category_id) {
          if (!UUID_REGEX.test(query.category_id)) throw new BadRequestException('category_id inválido');
          q = q.where('p.category_id', query.category_id);
        }
        if (typeof query.active === 'boolean') {
          q = q.where('p.activo', query.active);
        }
        if (query.with_cost) {
          q = q.whereNotNull('p.cost_base');
        }
        return q;
      };

      const [{ total }] = await buildBase().count<{ total: string }[]>('p.id as total');

      const data = await buildBase()
        .select(
          'p.id',
          'p.sku',
          'p.barcode',
          'p.nombre',
          'p.description',
          'p.brand_id',
          'b.nombre as brand_name',
          'p.category_id',
          'cat.name as category_name',
          'p.unit_purchase',
          'p.unit_sale',
          'p.factor_purchase',
          'p.factor_sale',
          'p.iva_rate',
          'p.ieps_rate',
          'p.cost_base',
          'p.cost_with_tax',
          'p.cost_per_case',
          'p.location',
          'p.location_warehouse',
          'p.loyalty_points',
          'p.activo',
          'p.updated_at',
        )
        .orderBy('p.nombre', 'asc')
        .limit(pageSize)
        .offset(offset);

      const totalNum = Number(total) || 0;
      return {
        data,
        pagination: {
          page,
          pageSize,
          total: totalNum,
          pageCount: Math.ceil(totalNum / pageSize) || 0,
        },
      };
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('products as p')
        .leftJoin('brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .leftJoin('categories as cat', function () {
          this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
        })
        .where('p.id', id)
        .whereNull('p.deleted_at')
        .first(
          'p.*',
          'b.nombre as brand_name',
          'cat.name as category_name',
        );
      if (!row) throw new NotFoundException(`Product ${id} no encontrado`);

      // Conteo de prices configurados (sin traer todos).
      const [{ count: pricesCount }] = await trx('commercial.product_prices')
        .where({ product_id: id })
        .whereNull('deleted_at')
        .count<{ count: string }[]>('* as count');

      // Stock agregado entre warehouses.
      const stockAgg = await trx('commercial.stock')
        .where({ product_id: id })
        .select(
          trx.raw('COALESCE(SUM(quantity), 0)::numeric AS total_on_hand'),
          trx.raw('COALESCE(SUM(reserved_quantity), 0)::numeric AS total_reserved'),
        )
        .first();

      return {
        ...row,
        prices_count: Number(pricesCount) || 0,
        total_on_hand: Number(stockAgg?.total_on_hand || 0),
        total_reserved: Number(stockAgg?.total_reserved || 0),
        total_available: Number(stockAgg?.total_on_hand || 0) - Number(stockAgg?.total_reserved || 0),
      };
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validateUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('products')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Product ${id} no encontrado`);

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.description !== undefined) patch.description = dto.description || null;
      if (dto.location !== undefined) patch.location = dto.location || null;
      if (dto.location_warehouse !== undefined) patch.location_warehouse = dto.location_warehouse || null;
      if (dto.loyalty_points !== undefined) {
        patch.loyalty_points = dto.loyalty_points == null ? null : Number(dto.loyalty_points);
      }
      if (dto.activo !== undefined) patch.activo = !!dto.activo;

      const [row] = await trx('products')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  private validateUpdate(dto: UpdateProductDto): void {
    if (dto.description !== undefined && dto.description !== null && dto.description.length > 500) {
      throw new BadRequestException('description máx 500 chars');
    }
    if (dto.location !== undefined && dto.location !== null && dto.location.length > 20) {
      throw new BadRequestException('location máx 20 chars');
    }
    if (dto.loyalty_points !== undefined && dto.loyalty_points !== null) {
      const v = Number(dto.loyalty_points);
      if (!Number.isFinite(v) || v < 0 || v > 1_000_000) {
        throw new BadRequestException('loyalty_points debe ser entero >= 0');
      }
    }
  }
}
