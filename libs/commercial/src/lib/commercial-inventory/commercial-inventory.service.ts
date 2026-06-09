import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

export type StockMovementType =
  | 'in'
  | 'out'
  | 'adjust'
  | 'reserve'
  | 'release'
  | 'sale';

export interface RecordMovementDto {
  warehouse_id: string;
  product_id: string;
  movement_type: StockMovementType;
  quantity: number;
  reference_type?: string;
  reference_id?: string;
  notes?: string;
}

export interface AdjustStockDto {
  warehouse_id: string;
  product_id: string;
  new_quantity: number; // saldo deseado tras ajuste (delta calculado internamente)
  notes?: string;
}

export interface ListStockQuery {
  warehouse_id?: string;
  product_id?: string;
  page?: number;
  pageSize?: number;
}

export interface ListMovementsQuery {
  warehouse_id?: string;
  product_id?: string;
  movement_type?: StockMovementType;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TYPES: StockMovementType[] = [
  'in',
  'out',
  'adjust',
  'reserve',
  'release',
  'sale',
];

@Injectable()
export class CommercialInventoryService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ───── stock reads ─────

  async listStock(query: ListStockQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 100));
    const offset = (page - 1) * pageSize;

    if (query.warehouse_id && !UUID_REGEX.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (query.product_id && !UUID_REGEX.test(query.product_id))
      throw new BadRequestException('product_id inválido');

    return this.tk.run(async (trx) => {
      let q = trx('commercial.stock as s')
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 's.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id');

      if (query.warehouse_id) q = q.where('s.warehouse_id', query.warehouse_id);
      if (query.product_id) q = q.where('s.product_id', query.product_id);

      const [{ count }] = await q.clone().count<{ count: string }[]>('* as count');

      const data = await q
        .select(
          's.id',
          's.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          's.product_id',
          'p.sku',
          'p.nombre as product_name',
          'p.brand_id',
          'b.nombre as brand_name',
          // M.6.2 enriched fields (Mega_Dulces) → margen + picking en UI.
          'p.cost_base',
          'p.cost_with_tax',
          'p.location',
          // Aliases para alinearse con el frontend que históricamente usa
          // on_hand/reserved/available. Esto desbroza un bug preexistente
          // donde la UI mostraba campos vacíos (referenciaba on_hand sin que
          // existiera). Mantenemos también los nombres reales por compat.
          's.quantity',
          's.quantity as on_hand',
          's.reserved_quantity',
          's.reserved_quantity as reserved',
          trx.raw('(s.quantity - s.reserved_quantity) as available_quantity'),
          trx.raw('(s.quantity - s.reserved_quantity) as available'),
          // Valor del stock disponible al costo (para totals del dashboard).
          trx.raw('GREATEST(s.quantity - s.reserved_quantity, 0) * COALESCE(p.cost_base, 0) AS available_value'),
          's.updated_at',
        )
        .orderBy('w.name', 'asc')
        .orderBy('p.nombre', 'asc')
        .limit(pageSize)
        .offset(offset);

      // Forma anidada `pagination` consistente con el resto de los endpoints
      // comerciales (customers/orders/pricing/products/promotions). El frontend
      // lee `r.pagination.total`; con la forma flat anterior leía undefined → 0
      // (contador de "líneas de stock" y paginador rotos).
      return {
        data,
        pagination: {
          page,
          pageSize,
          total: Number(count),
          pageCount: Math.ceil(Number(count) / pageSize) || 0,
        },
      };
    });
  }

  async getStockForProduct(warehouseId: string, productId: string) {
    if (!UUID_REGEX.test(warehouseId))
      throw new BadRequestException('warehouse_id inválido');
    if (!UUID_REGEX.test(productId))
      throw new BadRequestException('product_id inválido');

    return this.tk.run(async (trx) => {
      const row = await trx('commercial.stock')
        .where({ warehouse_id: warehouseId, product_id: productId })
        .first();
      if (!row) {
        // No row = stock 0. Devolvemos shape consistente para el caller.
        return {
          warehouse_id: warehouseId,
          product_id: productId,
          quantity: 0,
          reserved_quantity: 0,
          available_quantity: 0,
        };
      }
      return {
        warehouse_id: row.warehouse_id,
        product_id: row.product_id,
        quantity: Number(row.quantity),
        reserved_quantity: Number(row.reserved_quantity),
        available_quantity: Number(row.quantity) - Number(row.reserved_quantity),
      };
    });
  }

  // ───── stock writes ─────

  async recordMovement(dto: RecordMovementDto) {
    this.validateMovement(dto);

    return this.tk.run(async (trx) => {
      const userId = await this.getUserIdFromCtx();

      // Lock pesimista sobre la fila de stock para evitar races con reservas
      // concurrentes (dos pedidos simultáneos que ambos cumplen check de
      // disponibilidad y uno deja negativo).
      const stockRow = await trx('commercial.stock')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id })
        .forUpdate()
        .first();

      const quantityBefore = stockRow ? Number(stockRow.quantity) : 0;
      const reservedBefore = stockRow ? Number(stockRow.reserved_quantity) : 0;
      let quantityAfter = quantityBefore;
      let reservedAfter = reservedBefore;

      switch (dto.movement_type) {
        case 'in':
          quantityAfter = quantityBefore + dto.quantity;
          break;
        case 'out':
          if (quantityBefore - reservedBefore < dto.quantity) {
            throw new ConflictException(
              `Stock disponible insuficiente: tiene ${quantityBefore - reservedBefore}, necesita ${dto.quantity}`,
            );
          }
          quantityAfter = quantityBefore - dto.quantity;
          break;
        case 'adjust':
          // En 'adjust' la quantity ya viene como nuevo saldo deseado (delta).
          // Para evitar confusión, usar AdjustStockDto vía adjustStock().
          quantityAfter = quantityBefore + dto.quantity;
          if (quantityAfter < reservedBefore) {
            throw new ConflictException(
              'Ajuste dejaría quantity < reserved_quantity',
            );
          }
          break;
        case 'reserve':
          if (quantityBefore - reservedBefore < dto.quantity) {
            throw new ConflictException(
              `No hay stock disponible para reservar: ${quantityBefore - reservedBefore} < ${dto.quantity}`,
            );
          }
          reservedAfter = reservedBefore + dto.quantity;
          break;
        case 'release':
          if (reservedBefore < dto.quantity) {
            throw new ConflictException(
              `No se puede liberar más de lo reservado: ${reservedBefore} < ${dto.quantity}`,
            );
          }
          reservedAfter = reservedBefore - dto.quantity;
          break;
        case 'sale':
          if (reservedBefore < dto.quantity) {
            throw new ConflictException(
              `Sale > reserved: ${reservedBefore} < ${dto.quantity}`,
            );
          }
          quantityAfter = quantityBefore - dto.quantity;
          reservedAfter = reservedBefore - dto.quantity;
          break;
      }

      // Upsert del saldo
      if (stockRow) {
        await trx('commercial.stock')
          .where({ id: stockRow.id })
          .update({
            quantity: quantityAfter,
            reserved_quantity: reservedAfter,
            updated_at: trx.fn.now(),
            updated_by: userId,
          });
      } else {
        await trx('commercial.stock').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          quantity: quantityAfter,
          reserved_quantity: reservedAfter,
          updated_by: userId,
        });
      }

      // Bitácora append-only
      const [movement] = await trx('commercial.stock_movements')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          movement_type: dto.movement_type,
          quantity: dto.quantity,
          quantity_before: quantityBefore,
          quantity_after: quantityAfter,
          reference_type: dto.reference_type || null,
          reference_id: dto.reference_id || null,
          notes: dto.notes || null,
          created_by: userId,
        })
        .returning('*');

      return movement;
    });
  }

  /**
   * Ajuste a un saldo deseado (calcula delta internamente, genera movement
   * tipo 'adjust' con la diferencia firmada). Útil para auditorías físicas.
   */
  async adjustStock(dto: AdjustStockDto) {
    if (!UUID_REGEX.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (!UUID_REGEX.test(dto.product_id))
      throw new BadRequestException('product_id inválido');
    if (typeof dto.new_quantity !== 'number' || dto.new_quantity < 0)
      throw new BadRequestException('new_quantity inválido (>= 0)');

    return this.tk.run(async (trx) => {
      const userId = await this.getUserIdFromCtx();

      // Lock + read + write del saldo absoluto en la MISMA trx: evita lost updates y saldos intermedios corruptos por ajustes concurrentes o crash a medias.
      const stockRow = await trx('commercial.stock')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id })
        .forUpdate()
        .first();

      const quantityBefore = stockRow ? Number(stockRow.quantity) : 0;
      const reservedBefore = stockRow ? Number(stockRow.reserved_quantity) : 0;
      const delta = dto.new_quantity - quantityBefore;

      if (delta === 0) {
        return { adjusted: false, reason: 'sin cambios', delta: 0, new_quantity: dto.new_quantity };
      }
      if (dto.new_quantity < reservedBefore) {
        throw new ConflictException(
          `Ajuste dejaría quantity (${dto.new_quantity}) < reserved (${reservedBefore})`,
        );
      }

      if (stockRow) {
        await trx('commercial.stock')
          .where({ id: stockRow.id })
          .update({
            quantity: dto.new_quantity,
            updated_at: trx.fn.now(),
            updated_by: userId,
          });
      } else {
        await trx('commercial.stock').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          quantity: dto.new_quantity,
          reserved_quantity: 0,
          updated_by: userId,
        });
      }

      const [movement] = await trx('commercial.stock_movements')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          movement_type: 'adjust',
          quantity: Math.abs(delta),
          quantity_before: quantityBefore,
          quantity_after: dto.new_quantity,
          reference_type: 'adjustment',
          notes: `Ajuste a saldo ${dto.new_quantity}. ${dto.notes || ''}`.trim(),
          created_by: userId,
        })
        .returning('*');

      return { adjusted: true, delta, new_quantity: dto.new_quantity, movement_id: movement.id };
    });
  }

  async listMovements(query: ListMovementsQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 100));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      let q = trx('commercial.stock_movements as m')
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 'm.product_id');

      if (query.warehouse_id) q = q.where('m.warehouse_id', query.warehouse_id);
      if (query.product_id) q = q.where('m.product_id', query.product_id);
      if (query.movement_type) q = q.where('m.movement_type', query.movement_type);
      if (query.from) q = q.where('m.created_at', '>=', query.from);
      if (query.to) q = q.where('m.created_at', '<=', query.to);

      const [{ count }] = await q.clone().count<{ count: string }[]>('* as count');

      const data = await q
        .select(
          'm.id',
          'm.warehouse_id',
          'w.code as warehouse_code',
          'm.product_id',
          'p.nombre as product_name',
          'm.movement_type',
          'm.quantity',
          'm.quantity_before',
          'm.quantity_after',
          'm.reference_type',
          'm.reference_id',
          'm.notes',
          'm.created_at',
          'm.created_by',
        )
        .orderBy('m.created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      // Forma anidada `pagination` consistente con el resto de los endpoints
      // comerciales (customers/orders/pricing/products/promotions). El frontend
      // lee `r.pagination.total`; con la forma flat anterior leía undefined → 0
      // (contador de "líneas de stock" y paginador rotos).
      return {
        data,
        pagination: {
          page,
          pageSize,
          total: Number(count),
          pageCount: Math.ceil(Number(count) / pageSize) || 0,
        },
      };
    });
  }

  // ───── helpers ─────

  private validateMovement(dto: RecordMovementDto): void {
    if (!UUID_REGEX.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (!UUID_REGEX.test(dto.product_id))
      throw new BadRequestException('product_id inválido');
    if (!VALID_TYPES.includes(dto.movement_type))
      throw new BadRequestException(
        `movement_type debe ser uno de: ${VALID_TYPES.join(', ')}`,
      );
    if (typeof dto.quantity !== 'number' || dto.quantity <= 0)
      throw new BadRequestException('quantity debe ser número > 0');
    if (dto.reference_id && !UUID_REGEX.test(dto.reference_id))
      throw new BadRequestException('reference_id inválido (UUID)');
  }

  private async getUserIdFromCtx(): Promise<string | null> {
    // TenantContext incluye userId cuando el request viene autenticado.
    // Para llamadas internas / cron jobs puede ser null y está OK (audit field nullable).
    return this.tenantCtx.get()?.userId || null;
  }
}
