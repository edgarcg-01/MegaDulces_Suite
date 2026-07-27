import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService, normalizeMxPhone } from '@megadulces/platform-core';
import { OrderStockService } from '../commercial-orders/order-stock.service';
import { CommercialPricingService } from '../commercial-pricing/commercial-pricing.service';

/**
 * FIQ.6 (ADR-038) — Apartado de pedidos con TTL.
 *
 * El cliente pide "apártame esto"; el MOTOR reserva el stock (incrementa
 * commercial.stock.reserved_quantity via OrderStockService.reserve, con
 * reference_type='reservation' y el guard anti-congelamiento de inventario) por
 * un TTL configurable. El apartado NO crea una orden ni cobra (ADR-034): es un
 * hold temporal anclado al teléfono E.164 del contacto (aun sin customer_id).
 *
 * Un cron @5min (StockReservationCronService) libera los vencidos y devuelve el
 * reserved_quantity. El precio de cada línea sale de resolvePriceForQty (mismo
 * tier de volumen que cotiza el bot y que cobra el pedido — ADR-016).
 */

export interface ReservationLineInput {
  product_id: string;
  quantity: number; // piezas
}

export interface ReservationLineView {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface ReservationView {
  reservation_id: string;
  folio: string;
  phone: string;
  reserved_at: string;
  expires_at: string;
  expires_in_minutes: number;
  total: number;
  lines: ReservationLineView[];
}

export interface ApartarInput {
  phone: string;
  customerId?: string | null;
  lines: ReservationLineInput[];
  ttlMinutes?: number;
  notes?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_MIN = Number(process.env.WHATSAPP_RESERVATION_TTL_MIN) || 180; // 3 h

@Injectable()
export class StockReservationService {
  private readonly logger = new Logger(StockReservationService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly stock: OrderStockService,
    private readonly pricing: CommercialPricingService,
  ) {}

  /**
   * Crea un apartado: reserva stock de cada línea (atómico, todo-o-nada) por un
   * TTL. Si una línea no alcanza, la transacción entera hace rollback y se lanza
   * ConflictException con el NOMBRE del producto (nunca el número — FIQ.2).
   */
  async apartar(input: ApartarInput): Promise<ReservationView> {
    const canonical = normalizeMxPhone(input.phone);
    if (!canonical) throw new BadRequestException('Teléfono inválido para el apartado.');
    if (!Array.isArray(input.lines) || input.lines.length === 0)
      throw new BadRequestException('El apartado requiere al menos una línea.');
    for (const l of input.lines) {
      if (!UUID_RE.test(l.product_id)) throw new BadRequestException('product_id inválido en el apartado.');
    }
    if (input.customerId && !UUID_RE.test(input.customerId))
      throw new BadRequestException('customer_id inválido.');

    const ttl = Math.max(5, Math.min(input.ttlMinutes || DEFAULT_TTL_MIN, 24 * 60));
    const warehouseId = await this.resolveWarehouse();

    // Precios por tier (motor, ADR-016) fuera de la trx — read-only, respeta CLS.
    // Bump a mínimo de compra si la cantidad pedida cae por debajo (igual que orders).
    const priced: Array<{ product_id: string; quantity: number; unit_price: number }> = [];
    for (const l of input.lines) {
      const q0 = Math.max(1, Math.floor(Number(l.quantity) || 1));
      let pr = await this.pricing.resolvePriceForQty(l.product_id, q0);
      let qty = q0;
      if (pr.price == null) {
        qty = Math.max(q0, pr.min_purchase || q0);
        pr = await this.pricing.resolvePriceForQty(l.product_id, qty);
      }
      if (pr.price == null) {
        // Sin precio ni al mínimo → producto no vendible; el bot ofrece otra cosa.
        throw new ConflictException(`No pudimos apartar el producto ${l.product_id} (sin precio vigente).`);
      }
      priced.push({ product_id: l.product_id, quantity: qty, unit_price: Number(pr.price) });
    }

    const created = await this.tk.run(async (trx) => {
      const folio = await this.nextFolio(trx);
      const tenantId = this.tenantCtx.requireTenantId();

      const [header] = await trx('commercial.stock_reservations')
        .insert({
          tenant_id: tenantId,
          folio,
          phone: canonical,
          customer_id: input.customerId || null,
          warehouse_id: warehouseId,
          expires_at: new Date(Date.now() + ttl * 60 * 1000),
          notes: input.notes || null,
          created_by: this.tenantCtx.get()?.userId || null,
        })
        .returning(['id', 'reserved_at', 'expires_at']);

      let total = 0;
      const lines: ReservationLineView[] = [];
      for (const p of priced) {
        try {
          await this.stock.reserve(trx, warehouseId, p.product_id, p.quantity, header.id, 'reservation');
        } catch (e: any) {
          if (e instanceof ConflictException) {
            const name = await this.productName(trx, p.product_id);
            // Rechazo CUALITATIVO (FIQ.2): nunca revelamos el inventario disponible.
            throw new ConflictException(
              `No pudimos apartar "${name}" en esa cantidad. Ofrecé una cantidad menor.`,
            );
          }
          throw e;
        }
        const lineTotal = Math.round(p.quantity * p.unit_price * 100) / 100;
        total += lineTotal;
        const name = await this.productName(trx, p.product_id);
        await trx('commercial.stock_reservation_lines').insert({
          tenant_id: tenantId,
          reservation_id: header.id,
          product_id: p.product_id,
          warehouse_id: warehouseId,
          quantity: p.quantity,
          unit_price: p.unit_price,
          line_total: lineTotal,
        });
        lines.push({ product_id: p.product_id, name, quantity: p.quantity, unit_price: p.unit_price, line_total: lineTotal });
      }

      total = Math.round(total * 100) / 100;
      await trx('commercial.stock_reservations').where({ id: header.id }).update({ total, updated_at: trx.fn.now() });

      return { header, folio, lines, total };
    });

    return {
      reservation_id: created.header.id,
      folio: created.folio,
      phone: canonical,
      reserved_at: created.header.reserved_at,
      expires_at: created.header.expires_at,
      expires_in_minutes: Math.max(0, Math.round((new Date(created.header.expires_at).getTime() - Date.now()) / 60000)),
      total: created.total,
      lines: created.lines,
    };
  }

  /** Apartados ACTIVOS (no liberados, no vencidos) de un teléfono. Para consultar_apartado. */
  async activeByPhone(phone: string): Promise<ReservationView[]> {
    const canonical = normalizeMxPhone(phone);
    if (!canonical) return [];

    return this.tk.run(async (trx) => {
      const headers = await trx('commercial.stock_reservations')
        .where({ phone: canonical })
        .whereNull('released_at')
        .where('expires_at', '>', trx.fn.now())
        .orderBy('reserved_at', 'desc')
        .select('id', 'folio', 'reserved_at', 'expires_at', 'total');
      if (headers.length === 0) return [];

      const ids = headers.map((h) => h.id);
      const lineRows = await trx('commercial.stock_reservation_lines as l')
        .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
        .whereIn('l.reservation_id', ids)
        .select('l.reservation_id', 'l.product_id', 'l.quantity', 'l.unit_price', 'l.line_total', 'p.nombre as name');

      const byRes = new Map<string, ReservationLineView[]>();
      for (const r of lineRows) {
        const arr = byRes.get(r.reservation_id) || [];
        arr.push({
          product_id: r.product_id,
          name: r.name || 'Producto',
          quantity: Number(r.quantity),
          unit_price: Number(r.unit_price),
          line_total: Number(r.line_total),
        });
        byRes.set(r.reservation_id, arr);
      }

      return headers.map((h) => ({
        reservation_id: h.id,
        folio: h.folio,
        phone: canonical,
        reserved_at: h.reserved_at,
        expires_at: h.expires_at,
        expires_in_minutes: Math.max(0, Math.round((new Date(h.expires_at).getTime() - Date.now()) / 60000)),
        total: Number(h.total),
        lines: byRes.get(h.id) || [],
      }));
    });
  }

  /**
   * Libera manualmente apartado(s) de un teléfono (el cliente cancela). Devuelve
   * el stock reservado. Si `reservationId` viene, solo ese (validando que sea del
   * teléfono); si no, TODOS los activos del teléfono.
   */
  async release(phone: string, reservationId?: string): Promise<{ released: number }> {
    const canonical = normalizeMxPhone(phone);
    if (!canonical) throw new BadRequestException('Teléfono inválido.');
    if (reservationId && !UUID_RE.test(reservationId)) throw new BadRequestException('reservation_id inválido.');

    return this.tk.run(async (trx) => {
      const q = trx('commercial.stock_reservations')
        .where({ phone: canonical })
        .whereNull('released_at')
        .where('expires_at', '>', trx.fn.now());
      if (reservationId) q.andWhere({ id: reservationId });
      const headers = await q.forUpdate().select('id', 'warehouse_id');

      if (reservationId && headers.length === 0)
        throw new NotFoundException('Apartado no encontrado, ya liberado o vencido.');

      let released = 0;
      for (const h of headers) {
        const lines = await trx('commercial.stock_reservation_lines')
          .where({ reservation_id: h.id })
          .select('product_id', 'warehouse_id', 'quantity');
        for (const l of lines) {
          await this.stock.release(trx, l.warehouse_id, l.product_id, Number(l.quantity), h.id, 'reservation');
        }
        await trx('commercial.stock_reservations')
          .where({ id: h.id })
          .whereNull('released_at')
          .update({ released_at: trx.fn.now(), released_reason: 'released_manual', updated_at: trx.fn.now() });
        released++;
      }
      return { released };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async nextFolio(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();
    const [{ current_value }] = await trx
      .raw(
        `INSERT INTO commercial.reservation_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.reservation_sequences.current_value + 1,
               updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      )
      .then((r: any) => r.rows);
    return `AP-${year}-${String(current_value).padStart(5, '0')}`;
  }

  private async productName(trx: any, productId: string): Promise<string> {
    const p = await trx('catalog.products').where({ id: productId }).first('nombre');
    return p?.nombre || 'Producto';
  }

  /** Almacén de surtido: el default activo del tenant (mismo que usa el pedido/enrich). */
  private async resolveWarehouse(): Promise<string> {
    const wh = await this.tk.run((trx) =>
      trx('commercial.warehouses')
        .whereNull('deleted_at')
        .where({ active: true })
        .orderBy('is_default', 'desc')
        .orderBy('name', 'asc')
        .first('id'),
    );
    if (!wh) throw new NotFoundException('No hay almacén activo para el apartado.');
    return wh.id;
  }
}
