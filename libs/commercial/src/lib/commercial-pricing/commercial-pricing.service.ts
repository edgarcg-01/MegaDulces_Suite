import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

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
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Para customer_b2b: devuelve el set de price_list_ids permitidos (su
   * default_price_list + tenant default por fallback). Para otros roles
   * devuelve null (acceso completo).
   */
  private async allowedPriceListIdsForCtx(trx: any): Promise<string[] | null> {
    const ctx = this.tenantCtx.get();
    if (ctx?.roleName !== 'customer_b2b') return null;

    const userRow = await trx('identity.users')
      .where({ id: ctx.userId })
      .select('customer_id')
      .first();
    if (!userRow?.customer_id) {
      throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
    }

    const customer = await trx('commercial.customers')
      .where({ id: userRow.customer_id })
      .select('default_price_list_id')
      .first();

    const tenantDefault = await trx('commercial.price_lists')
      .where({ is_default: true, active: true })
      .whereNull('deleted_at')
      .select('id')
      .first();

    const ids = new Set<string>();
    if (customer?.default_price_list_id) ids.add(customer.default_price_list_id);
    if (tenantDefault?.id) ids.add(tenantDefault.id);
    return Array.from(ids);
  }

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
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      let q = trx('commercial.price_lists').whereNull('deleted_at');
      if (typeof active === 'boolean') q = q.where({ active });
      if (allowed !== null) {
        if (allowed.length === 0) return [];
        q = q.whereIn('id', allowed);
      }
      return q.orderBy('is_default', 'desc').orderBy('name', 'asc');
    });
  }

  async findPriceListById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && !allowed.includes(id)) {
        throw new ForbiddenException('No tenés acceso a esta price list');
      }
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
   * Lista precios de una price list (paginado).
   *
   * J.6.7: si `warehouseId` viene, LEFT JOIN con `commercial.stock` y devuelve
   * `stock_available` por producto. Si no viene, `stock_available` queda como
   * `null` (mantiene compatibilidad con callers que no necesitan stock).
   *
   * Sprint M: agregado `search` (ilike sobre product_name, sku, barcode) +
   * paginación (default 100/page, max 500). Sin esto, listas con miles de
   * SKUs (post-importer Mega_Dulces ~6500 en MAYOREO) colapsan el browser.
   *
   * Returns `{ data, pagination }` siempre — antes era array crudo, los callers
   * necesitan actualizar a `.data`.
   */
  async listPrices(
    priceListId: string,
    opts: { warehouseId?: string; page?: number; pageSize?: number; search?: string; commercialOnly?: boolean } = {},
  ) {
    if (!UUID_REGEX.test(priceListId))
      throw new BadRequestException('price_list_id inválido');
    const warehouseId = opts.warehouseId;
    if (warehouseId !== undefined && warehouseId !== null && !UUID_REGEX.test(warehouseId)) {
      throw new BadRequestException('warehouse_id inválido');
    }

    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(opts.pageSize) || 100));
    const offset = (page - 1) * pageSize;
    const search = (opts.search || '').trim();
    const commercialOnly = opts.commercialOnly === true;

    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && !allowed.includes(priceListId)) {
        throw new ForbiddenException('No tenés acceso a esta price list');
      }

      // Source of truth: `catalog.products` (catálogo completo).
      // `commercial.product_prices` se une por LEFT JOIN para traer el precio del
      // price_list del customer si existe — null si no hay (frontend ya maneja
      // ese caso ocultando el botón "agregar" y mostrando "Sin precio").
      const buildBaseQuery = () => {
        let q = trx('catalog.products as p')
          .leftJoin('commercial.product_prices as pp', function () {
            this.on('pp.product_id', '=', 'p.id')
              .andOn('pp.tenant_id', '=', 'p.tenant_id')
              .andOnVal('pp.price_list_id', priceListId)
              .andOnNull('pp.deleted_at');
          })
          .leftJoin('catalog.brands as b', function () {
            this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin('catalog.categories as cat', function () {
            this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
          })
          // Imagen del producto vive en inventory.products_active (no en catalog.products
          // que solo es el planograma). JOIN por SKU, fallback a `articulo` en rows
          // de Railway donde sku está NULL (drift histórico del ERP).
          .leftJoin('inventory.products_active as ipa', function () {
            this.on(trx.raw('ipa.sku = COALESCE(p.sku, p.articulo)'));
          })
          .whereNull('p.deleted_at');

        if (commercialOnly) {
          q = q.where(function () {
            this.where('b.is_commercial', true).orWhereNull('b.is_commercial');
          });
        }

        if (search) {
          const term = `%${search}%`;
          q = q.where((b) =>
            b.where('p.nombre', 'ilike', term)
              .orWhere('p.sku', 'ilike', term)
              .orWhere('p.barcode', 'ilike', term),
          );
        }
        return q;
      };

      // Count primero (sin joins de stock para no inflar el count).
      const [{ total }] = await buildBaseQuery().count<{ total: string }[]>('p.id as total');

      // Página real con joins completos.
      let q = buildBaseQuery();
      if (warehouseId) {
        q = q.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'p.id')
            .andOn('s.tenant_id', '=', 'p.tenant_id')
            .andOnVal('s.warehouse_id', warehouseId);
        });
      }

      const selects: any[] = [
        // `pp.id` puede ser null si no hay precio configurado — usamos `p.id` como
        // identidad estable de fila (alineado con frontend trackBy product_id).
        trx.raw('COALESCE(pp.id, p.id) AS id'),
        trx.raw('p.id AS product_id'),
        'p.nombre as product_name',
        'p.description as product_description',
        'p.sku',
        'p.barcode',
        'p.brand_id as brand_id',
        'b.nombre as brand_name',
        'p.category_id',
        'cat.name as category_name',
        'p.cost_base',
        'p.cost_with_tax',
        'p.location',
        'p.loyalty_points',
        'ipa.image_url as image_url',
        'pp.price',
        'pp.tax_rate',
        trx.raw('COALESCE(pp.min_qty, 1) AS min_qty'),
      ];
      if (warehouseId) {
        selects.push(
          trx.raw(
            'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available',
          ),
        );
      } else {
        selects.push(trx.raw('NULL::int AS stock_available'));
      }

      const data = await q
        .select(...selects)
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

  /**
   * Top sellers para una price_list. Lee de la TABLE
   * `catalog.products_top_sellers` (sincronizada manualmente desde el ERP
   * mientras el FDW al ERP sea inalcanzable desde Railway — ver L.2 / hotfix
   * 2026-06-03 que convirtió la MV a TABLE).
   * Joinea con `commercial.product_prices` del price_list para devolver el
   * precio del customer + sales_rank + units_sold.
   *
   * Customer_b2b sólo puede pedirla sobre SU price_list (allowedPriceListIdsForCtx).
   * Si no hay ventas todavía la MV devuelve pocos rows (es esperable hasta que
   * Mega Dulces tenga volumen real).
   */
  async listTopSellers(
    priceListId: string,
    opts: { warehouseId?: string; limit?: number } = {},
  ) {
    if (!UUID_REGEX.test(priceListId))
      throw new BadRequestException('price_list_id inválido');
    const warehouseId = opts.warehouseId;
    if (warehouseId !== undefined && warehouseId !== null && !UUID_REGEX.test(warehouseId)) {
      throw new BadRequestException('warehouse_id inválido');
    }
    const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 1000));

    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && !allowed.includes(priceListId)) {
        throw new ForbiddenException('No tenés acceso a esta price list');
      }

      // INNER JOIN con product_prices: solo devolvemos top sellers que tienen
      // precio configurado en la price_list del customer. Garantiza que cada
      // card del portal sea comprable (sin "Sin precio"). MV ya viene filtrada
      // por productos_activos del ERP, así que no requiere brand.is_commercial.
      let q = trx('catalog.products_top_sellers as ts')
        .innerJoin('commercial.product_prices as pp', function () {
          this.on('pp.product_id', '=', 'ts.id')
            .andOn('pp.tenant_id', '=', 'ts.tenant_id')
            .andOnVal('pp.price_list_id', priceListId)
            .andOnNull('pp.deleted_at');
        })
        .leftJoin('catalog.brands as b', function () {
          this.on('b.id', '=', 'ts.brand_id').andOn('b.tenant_id', '=', 'ts.tenant_id');
        })
        .leftJoin('catalog.categories as cat', function () {
          this.on('cat.id', '=', 'ts.category_id').andOn('cat.tenant_id', '=', 'ts.tenant_id');
        })
        // Imagen desde inventory.products_active (single source of truth para fotos)
        .leftJoin('inventory.products_active as ipa', 'ipa.sku', 'ts.sku');

      if (warehouseId) {
        q = q.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'ts.id')
            .andOn('s.tenant_id', '=', 'ts.tenant_id')
            .andOnVal('s.warehouse_id', warehouseId);
        });
      }

      const selects: any[] = [
        trx.raw('pp.id AS id'),
        trx.raw('ts.id AS product_id'),
        'ts.nombre as product_name',
        'ts.sku',
        'ts.barcode',
        'ts.brand_id',
        'b.nombre as brand_name',
        'ts.category_id',
        'cat.name as category_name',
        'ts.cost_base',
        'ipa.image_url as image_url',
        'pp.price',
        'pp.tax_rate',
        trx.raw('COALESCE(pp.min_qty, 1) AS min_qty'),
        'ts.sales_rank',
        'ts.units_sold',
        'ts.revenue',
        'ts.cases_sold',
        'ts.units_total',
      ];
      if (warehouseId) {
        selects.push(
          trx.raw(
            'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available',
          ),
        );
      } else {
        selects.push(trx.raw('NULL::int AS stock_available'));
      }

      const data = await q
        .select(...selects)
        .orderBy('ts.sales_rank', 'asc')
        .limit(limit);

      return { data, total: data.length };
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
        updated_at: trx.fn.now(),
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
      // Defense in depth: si el rol es customer_b2b, sobrescribir customerId
      // con el customer del JWT. Sin esto un customer_b2b autenticado podría
      // consultar el precio que paga OTRO cliente para cualquier producto
      // pasando ?customer_id=<otro_uuid> — leak de pricing competitivo.
      const ctx = this.tenantCtx.get();
      if (ctx?.roleName === 'customer_b2b') {
        const userRow = await trx('identity.users')
          .where({ id: ctx.userId })
          .select('customer_id')
          .first();
        if (!userRow?.customer_id) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
        customerId = userRow.customer_id;
      }

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
