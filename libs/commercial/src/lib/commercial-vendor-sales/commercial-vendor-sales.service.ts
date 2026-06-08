import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  CrearVendorSaleDto,
  ListVendorSalesQuery,
  VendorSalesReportQuery,
} from './dto/vendor-sale.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Líneas de venta de la captura del vendedor. Registro liviano (1 fila por
 * producto OCR del ticket), anclado a la tienda de trade (store_id = "cliente").
 * NO crea pedido, NO route_ticket, NO toca stock. Agrupable por tienda
 * (venta por cliente) y por capture_ref (venta por ticket de vendedor).
 *
 * Idempotencia: el cliente genera `capture_ref` y lo reusa en retry — si ya
 * existen filas con ese capture_ref del tenant, las retornamos sin re-insertar.
 */
@Injectable()
export class CommercialVendorSalesService {
  private readonly logger = new Logger(CommercialVendorSalesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async crear(dto: CrearVendorSaleDto) {
    if (!dto.store_id || !UUID_RE.test(dto.store_id))
      throw new BadRequestException('store_id requerido (UUID)');
    if (!dto.sale_date || !DATE_RE.test(dto.sale_date))
      throw new BadRequestException('sale_date requerido (YYYY-MM-DD)');
    if (!Array.isArray(dto.lines) || dto.lines.length === 0)
      throw new BadRequestException('lines requerido (al menos 1)');

    const lines = dto.lines
      .filter((l) => l && typeof l.sku === 'string' && l.sku.trim() && Number(l.quantity) > 0)
      .map((l) => ({
        sku: l.sku.trim(),
        product_name: l.product_name ?? null,
        quantity: Number(l.quantity),
        confidence: l.confidence ?? null,
      }));
    if (lines.length === 0)
      throw new BadRequestException('Ninguna línea válida (sku + quantity > 0)');

    if (dto.capture_ref && !UUID_RE.test(dto.capture_ref))
      throw new BadRequestException('capture_ref inválido (UUID)');
    if (dto.daily_capture_id && !UUID_RE.test(dto.daily_capture_id))
      throw new BadRequestException('daily_capture_id inválido (UUID)');
    if (dto.route_id && !UUID_RE.test(dto.route_id))
      throw new BadRequestException('route_id inválido (UUID)');

    const captureRef = dto.capture_ref || randomUUID();

    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();

      // Idempotencia: si ya hay filas con este capture_ref, retornarlas.
      if (dto.capture_ref) {
        const existing = await trx('commercial.vendor_sale_lines')
          .where({ capture_ref: captureRef })
          .whereNull('deleted_at');
        if (existing.length) {
          this.logger.warn(`Idempotency hit: capture_ref=${captureRef} (${existing.length} líneas).`);
          return { capture_ref: captureRef, idempotent: true, lines: existing.length, rows: existing };
        }
      }

      // La tienda debe existir (cross-schema; RLS aplica via tk.run).
      const store = await trx('trade.stores').where({ id: dto.store_id }).first();
      if (!store) throw new BadRequestException(`Tienda ${dto.store_id} no encontrada`);

      // Resolver product_id canónico (catalog) por sku, para BI comercial. El
      // sku ERP del OCR no coincide con el sku del catálogo, así que se resuelve
      // PRIMERO vía el alias ERP→catalog del planograma (mismo mapeo que usa la
      // visita) y, para los que no estén aliasados, fallback por sku directo en
      // catalog.products. product_id queda null solo si no se encuentra en
      // ninguno (la línea igual se guarda — el sku es el identificador principal).
      const skuList = lines.map((l) => l.sku);
      const aliasRows = await trx('trade.planogram_sku_aliases')
        .whereIn('erp_sku', skuList)
        .whereNull('deleted_at')
        .select('erp_sku', 'product_id');
      const skuToProductId = new Map<string, string>(
        aliasRows.map((r: any) => [r.erp_sku, r.product_id]),
      );
      const unresolved = skuList.filter((s) => !skuToProductId.has(s));
      if (unresolved.length) {
        const catRows = await trx('catalog.products')
          .whereIn('sku', unresolved)
          .whereNull('deleted_at')
          .select('id', 'sku');
        for (const r of catRows as any[]) {
          if (!skuToProductId.has(r.sku)) skuToProductId.set(r.sku, r.id);
        }
      }

      const rows = await trx('commercial.vendor_sale_lines')
        .insert(
          lines.map((l) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            capture_ref: captureRef,
            vendor_user_id: userId,
            store_id: dto.store_id,
            route_id: dto.route_id ?? null,
            sale_date: dto.sale_date,
            sku: l.sku,
            product_id: skuToProductId.get(l.sku) ?? null,
            product_name: l.product_name,
            quantity: l.quantity,
            confidence: l.confidence,
            ticket_photo_url: dto.ticket_photo_url ?? null,
            ticket_cloudinary_public_id: dto.ticket_cloudinary_public_id ?? null,
            daily_capture_id: dto.daily_capture_id ?? null,
            created_by: userId,
          })),
        )
        .returning('*');

      return { capture_ref: captureRef, idempotent: false, lines: rows.length, rows };
    });
  }

  /** Líneas de venta propias del vendedor (agrupadas por captura). */
  async listMine(q: ListVendorSalesQuery) {
    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();
      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 30));

      const base = trx('commercial.vendor_sale_lines')
        .where({ vendor_user_id: userId })
        .whereNull('deleted_at');
      if (q.store_id) base.where('store_id', q.store_id);
      this.applyDateRange(base, q);

      const [{ count }] = await base.clone().count<{ count: string }[]>('* as count');
      const data = await base
        .clone()
        .orderBy('sale_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return { data, total: Number(count), page, pageSize };
    });
  }

  /** Reporte admin: venta por tienda/cliente. */
  async porTienda(q: VendorSalesReportQuery) {
    return this.tk.run(async (trx) => {
      const base = trx('commercial.vendor_sale_lines as vsl')
        .leftJoin('trade.stores as s', function () {
          this.on('s.tenant_id', 'vsl.tenant_id').andOn('s.id', 'vsl.store_id');
        })
        .whereNull('vsl.deleted_at');
      this.applyDateRange(base, q, 'vsl');
      return base
        .clone()
        .select('vsl.store_id', 's.nombre as store_name')
        .countDistinct('vsl.capture_ref as capturas')
        .count('* as lineas')
        .sum('vsl.quantity as unidades')
        .groupBy('vsl.store_id', 's.nombre')
        .orderBy('unidades', 'desc');
    });
  }

  /** Reporte admin: venta por captura/ticket de vendedor. */
  async porCaptura(q: VendorSalesReportQuery) {
    return this.tk.run(async (trx) => {
      const base = trx('commercial.vendor_sale_lines as vsl')
        .leftJoin('identity.users as u', function () {
          this.on('u.tenant_id', 'vsl.tenant_id').andOn('u.id', 'vsl.vendor_user_id');
        })
        .leftJoin('trade.stores as s', function () {
          this.on('s.tenant_id', 'vsl.tenant_id').andOn('s.id', 'vsl.store_id');
        })
        .leftJoin('trade.catalogs as r', function () {
          this.on('r.tenant_id', 'vsl.tenant_id').andOn('r.id', 'vsl.route_id');
        })
        .whereNull('vsl.deleted_at');
      this.applyDateRange(base, q, 'vsl');
      if (q.store_id && UUID_RE.test(q.store_id)) base.where('vsl.store_id', q.store_id);
      return base
        .clone()
        .select(
          'vsl.capture_ref',
          'vsl.store_id',
          's.nombre as store_name',
          'vsl.route_id',
          'r.value as route_name',
          'vsl.vendor_user_id',
          'u.nombre as vendor_name',
          'u.username as vendor_username',
          'vsl.sale_date',
        )
        .count('* as lineas')
        .sum('vsl.quantity as unidades')
        .max('vsl.ticket_photo_url as ticket_photo_url')
        .max('vsl.created_at as created_at')
        .groupBy(
          'vsl.capture_ref',
          'vsl.store_id',
          's.nombre',
          'vsl.route_id',
          'r.value',
          'vsl.vendor_user_id',
          'u.nombre',
          'u.username',
          'vsl.sale_date',
        )
        .orderBy('vsl.sale_date', 'desc')
        .orderBy('created_at', 'desc');
    });
  }

  /** Líneas de una captura/ticket específico (drill-down del reporte admin). */
  async linesByCapture(captureRef: string) {
    if (!captureRef || !UUID_RE.test(captureRef))
      throw new BadRequestException('capture_ref requerido (UUID)');
    return this.tk.run(async (trx) =>
      trx('commercial.vendor_sale_lines')
        .where({ capture_ref: captureRef })
        .whereNull('deleted_at')
        .select('id', 'sku', 'product_name', 'quantity', 'confidence', 'product_id')
        .orderBy('product_name'),
    );
  }

  /** Reporte admin: venta por ruta. */
  async porRuta(q: VendorSalesReportQuery) {
    return this.tk.run(async (trx) => {
      const base = trx('commercial.vendor_sale_lines')
        .whereNull('deleted_at')
        .whereNotNull('route_id');
      this.applyDateRange(base, q);
      return base
        .clone()
        .select('route_id')
        .countDistinct('capture_ref as capturas')
        .count('* as lineas')
        .sum('quantity as unidades')
        .groupBy('route_id')
        .orderBy('unidades', 'desc');
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private applyDateRange(qb: any, q: { date_from?: string; date_to?: string }, alias?: string) {
    const col = alias ? `${alias}.sale_date` : 'sale_date';
    if (q.date_from && DATE_RE.test(q.date_from)) qb.where(col, '>=', q.date_from);
    if (q.date_to && DATE_RE.test(q.date_to)) qb.where(col, '<=', q.date_to);
    return qb;
  }

  private requireUserId(): string {
    const ctx = this.tenantCtx.get();
    if (!ctx?.userId)
      throw new BadRequestException('Usuario no identificado — requiere request autenticado');
    return ctx.userId;
  }
}
