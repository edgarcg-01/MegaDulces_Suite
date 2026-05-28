import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';

// ─────────── DTOs ───────────

export interface CreatePriceListDto {
  code: string;
  name: string;
  currency?: string;
  valid_from?: string;
  valid_to?: string;
  is_default?: boolean;
  active?: boolean;
  notes?: string;
}
export type UpdatePriceListDto = Partial<CreatePriceListDto>;

export interface UpsertProductPriceDto {
  product_id: string;
  price: number;
  tax_rate?: number;
  min_qty?: number;
}

export interface BulkUpsertProductPricesDto {
  price_list_id: string;
  items: UpsertProductPriceDto[];
}

// ─────────── regex ───────────

const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CommercialPricingService {
  constructor(private readonly tk: TenantKnexService) {}

  // ───── price_lists ─────

  async createPriceList(dto: CreatePriceListDto) {
    this.validatePriceListCreate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.price_lists')
        .where({ code: dto.code })
        .first();
      if (existing) {
        throw new ConflictException(
          `Ya existe price_list con code "${dto.code}"`,
        );
      }

      if (dto.is_default) await this.clearDefaultPriceList(trx);

      const [row] = await trx('commercial.price_lists')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code: dto.code,
          name: dto.name.trim(),
          currency: (dto.currency || 'MXN').toUpperCase(),
          valid_from: dto.valid_from || null,
          valid_to: dto.valid_to || null,
          is_default: dto.is_default ?? false,
          active: dto.active ?? true,
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  async listPriceLists(active?: boolean) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.price_lists').whereNull('deleted_at');
      if (typeof active === 'boolean') q = q.where({ active });
      return q.orderBy('is_default', 'desc').orderBy('name', 'asc');
    });
  }

  async findPriceListById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.price_lists')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`PriceList ${id} no encontrada`);
      return row;
    });
  }

  async updatePriceList(id: string, dto: UpdatePriceListDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validatePriceListUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.price_lists')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`PriceList ${id} no encontrada`);

      if (dto.code && dto.code !== existing.code) {
        const dup = await trx('commercial.price_lists')
          .where({ code: dto.code })
          .whereNot({ id })
          .first();
        if (dup) throw new ConflictException(`code duplicado: ${dto.code}`);
      }

      if (dto.is_default === true && !existing.is_default) {
        await this.clearDefaultPriceList(trx);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.code !== undefined) patch.code = dto.code;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.currency !== undefined)
        patch.currency = (dto.currency || 'MXN').toUpperCase();
      if (dto.valid_from !== undefined) patch.valid_from = dto.valid_from || null;
      if (dto.valid_to !== undefined) patch.valid_to = dto.valid_to || null;
      if (dto.is_default !== undefined) patch.is_default = dto.is_default;
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.notes !== undefined) patch.notes = dto.notes || null;

      const [row] = await trx('commercial.price_lists')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async softDeletePriceList(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const pl = await trx('commercial.price_lists')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!pl) throw new NotFoundException(`PriceList ${id} no encontrada`);

      if (pl.is_default) {
        throw new ConflictException(
          'No se puede borrar la price_list default. Marcar otra como default primero.',
        );
      }

      await trx('commercial.price_lists')
        .where({ id })
        .update({ deleted_at: trx.fn.now(), active: false });
      return { deleted: true, id };
    });
  }

  // ───── product_prices ─────

  /**
   * Lista precios de una price list.
   *
   * J.6.7: si `warehouseId` viene, LEFT JOIN con `commercial.stock` y devuelve
   * `stock_available` por producto. Si no viene, `stock_available` queda como
   * `null` (mantiene compatibilidad con callers que no necesitan stock).
   *
   * `stock_available` es lo disponible REAL (quantity - reserved), no el total.
   */
  async listPrices(priceListId: string, warehouseId?: string) {
    if (!UUID_REGEX.test(priceListId))
      throw new BadRequestException('price_list_id inválido');
    if (warehouseId !== undefined && warehouseId !== null && !UUID_REGEX.test(warehouseId)) {
      throw new BadRequestException('warehouse_id inválido');
    }

    return this.tk.run(async (trx) => {
      let q = trx('commercial.product_prices as pp')
        .leftJoin('public.products as p', function () {
          this.on('p.id', '=', 'pp.product_id').andOn(
            'p.tenant_id',
            '=',
            'pp.tenant_id',
          );
        })
        .whereNull('pp.deleted_at')
        .where('pp.price_list_id', priceListId);

      if (warehouseId) {
        q = q.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'pp.product_id')
            .andOn('s.tenant_id', '=', 'pp.tenant_id')
            .andOnVal('s.warehouse_id', warehouseId);
        });
      }

      const selects: any[] = [
        'pp.id',
        'pp.product_id',
        'p.nombre as product_name',
        'pp.price',
        'pp.tax_rate',
        'pp.min_qty',
      ];
      if (warehouseId) {
        // stock_available = quantity - reserved. Si no hay row en stock → null.
        selects.push(
          trx.raw(
            'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved, 0), 0) END AS stock_available',
          ),
        );
      } else {
        selects.push(trx.raw('NULL::int AS stock_available'));
      }

      return q.select(...selects).orderBy('p.nombre', 'asc');
    });
  }

  async bulkUpsertPrices(dto: BulkUpsertProductPricesDto) {
    if (!UUID_REGEX.test(dto.price_list_id))
      throw new BadRequestException('price_list_id inválido');
    if (!Array.isArray(dto.items) || dto.items.length === 0)
      throw new BadRequestException('items debe ser array no vacío');
    if (dto.items.length > 1000)
      throw new BadRequestException('máximo 1000 items por bulk upsert');

    for (const it of dto.items) this.validatePriceItem(it);

    return this.tk.run(async (trx) => {
      // Verificar que la price_list existe
      const pl = await trx('commercial.price_lists')
        .where({ id: dto.price_list_id })
        .whereNull('deleted_at')
        .first();
      if (!pl)
        throw new NotFoundException(`PriceList ${dto.price_list_id} no encontrada`);

      const rows = dto.items.map((it) => ({
        tenant_id: trx.raw('public.current_tenant_id()'),
        price_list_id: dto.price_list_id,
        product_id: it.product_id,
        price: it.price,
        tax_rate: it.tax_rate ?? 0.16,
        min_qty: it.min_qty ?? 1,
      }));

      const inserted = await trx('commercial.product_prices')
        .insert(rows)
        .onConflict(['tenant_id', 'price_list_id', 'product_id'])
        .merge(['price', 'tax_rate', 'min_qty', 'updated_at'])
        .returning('id');

      return { upserted: inserted.length };
    });
  }

  async deletePrice(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.product_prices')
        .where({ id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now() })
        .returning('id');
      if (!row) throw new NotFoundException(`ProductPrice ${id} no encontrado`);
      return { deleted: true, id };
    });
  }

  /**
   * Resuelve precio aplicable a un producto para un cliente:
   *   1. Si el cliente tiene default_price_list_id, busca ahí.
   *   2. Fallback: busca en la price_list default del tenant.
   *   3. Si nada existe, devuelve null (el caller decide si bloquea el pedido).
   */
  async resolvePriceForCustomer(productId: string, customerId: string) {
    if (!UUID_REGEX.test(productId))
      throw new BadRequestException('product_id inválido');
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');

    return this.tk.run(async (trx) => {
      const customer = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!customer)
        throw new NotFoundException(`Customer ${customerId} no encontrado`);

      const tryPriceList = async (priceListId: string | null) => {
        if (!priceListId) return null;
        return trx('commercial.product_prices')
          .where({ price_list_id: priceListId, product_id: productId })
          .whereNull('deleted_at')
          .first();
      };

      let price = await tryPriceList(customer.default_price_list_id);
      let source: 'customer_default' | 'tenant_default' | null = price
        ? 'customer_default'
        : null;

      if (!price) {
        const tenantDefault = await trx('commercial.price_lists')
          .where({ is_default: true, active: true })
          .whereNull('deleted_at')
          .first();
        if (tenantDefault) {
          price = await tryPriceList(tenantDefault.id);
          if (price) source = 'tenant_default';
        }
      }

      if (!price) {
        return {
          product_id: productId,
          customer_id: customerId,
          price: null,
          tax_rate: null,
          min_qty: null,
          source: null,
        };
      }

      return {
        product_id: productId,
        customer_id: customerId,
        price_list_id: price.price_list_id,
        price: Number(price.price),
        tax_rate: Number(price.tax_rate),
        min_qty: price.min_qty,
        source,
      };
    });
  }

  // ───── helpers ─────

  private async clearDefaultPriceList(trx: any): Promise<void> {
    await trx('commercial.price_lists')
      .where({ is_default: true })
      .update({ is_default: false, updated_at: trx.fn.now() });
  }

  private validatePriceListCreate(dto: CreatePriceListDto): void {
    if (!dto.code || !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code requerido: 2-50 chars [A-Z0-9_-]');
    }
    if (!dto.name?.trim()) throw new BadRequestException('name requerido');
    if (dto.currency && !/^[A-Z]{3}$/.test(dto.currency.toUpperCase())) {
      throw new BadRequestException('currency debe ser ISO 4217 (3 letras)');
    }
  }

  private validatePriceListUpdate(dto: UpdatePriceListDto): void {
    if (dto.code !== undefined && !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code inválido');
    }
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('name no puede ser vacío');
    }
    if (dto.currency && !/^[A-Z]{3}$/.test(dto.currency.toUpperCase())) {
      throw new BadRequestException('currency debe ser ISO 4217');
    }
  }

  private validatePriceItem(it: UpsertProductPriceDto): void {
    if (!UUID_REGEX.test(it.product_id)) {
      throw new BadRequestException(`product_id inválido: ${it.product_id}`);
    }
    if (typeof it.price !== 'number' || it.price < 0) {
      throw new BadRequestException(`price inválido (>= 0): ${it.price}`);
    }
    if (it.tax_rate !== undefined && (it.tax_rate < 0 || it.tax_rate > 1)) {
      throw new BadRequestException(`tax_rate fuera de rango [0..1]: ${it.tax_rate}`);
    }
    if (it.min_qty !== undefined && (!Number.isInteger(it.min_qty) || it.min_qty < 1)) {
      throw new BadRequestException(`min_qty debe ser entero >= 1`);
    }
  }
}
