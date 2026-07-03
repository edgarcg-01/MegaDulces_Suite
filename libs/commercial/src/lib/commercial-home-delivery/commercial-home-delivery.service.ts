import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { CommercialCustomersService } from '../commercial-customers/commercial-customers.service';
import { CommercialOrdersService } from '../commercial-orders/commercial-orders.service';
import { CommercialPaymentsService } from '../commercial-payments/commercial-payments.service';
import {
  DELIVERY_OUTCOMES,
  HomeDeliveryIntakeDto,
  RecordDeliveryOutcomeDto,
} from './dto/home-delivery.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = ['phone', 'whatsapp', 'social', 'walk_in'];

/**
 * Fase LM.2 — intake de pedidos a domicilio (recepción por tel/WhatsApp/redes).
 *
 * Orquesta el flujo del SOP §5: resuelve el cliente (de cartera o casual con
 * alta rápida), arma el pedido con dirección ad-hoc + canal + ETA, y lo deja
 * `confirmed` (stock reservado). Reusa la secuencia probada createDraft →
 * replaceLines → place (misma que vendedor/portal); no fully-atomic entre pasos
 * (un fallo tardío deja un draft cancelable), consistente con esos flujos.
 *
 * Geocoding del domicilio (lat/lng) se difiere a LM.3: si el UI manda coords
 * en delivery_address se persisten; si no, la dirección viaja como texto.
 */
@Injectable()
export class CommercialHomeDeliveryService {
  private readonly logger = new Logger(CommercialHomeDeliveryService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly customers: CommercialCustomersService,
    private readonly orders: CommercialOrdersService,
    private readonly payments: CommercialPaymentsService,
  ) {}

  async createIntake(dto: HomeDeliveryIntakeDto) {
    if (!dto.delivery_address || !dto.delivery_address.street)
      throw new BadRequestException('delivery_address.street requerido');
    if (!CHANNELS.includes(dto.delivery_channel))
      throw new BadRequestException(`delivery_channel inválido: ${dto.delivery_channel}`);
    if (!Array.isArray(dto.lines) || dto.lines.length === 0)
      throw new BadRequestException('El pedido requiere al menos una línea');

    const customerId = await this.resolveCustomer(dto);
    const warehouseId = await this.resolveWarehouse(dto.warehouse_id);

    const draft = await this.orders.createDraft({
      customer_id: customerId,
      warehouse_id: warehouseId,
      delivery_type: 'home_delivery',
      delivery_address: dto.delivery_address,
      delivery_channel: dto.delivery_channel,
      promised_eta_min: dto.promised_eta_min,
      notes: dto.notes,
    });

    await this.orders.replaceLines(draft.id, {
      lines: dto.lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
    });

    const order = await this.orders.place(draft.id);
    return order;
  }

  /**
   * Fase LM.4 — el repartidor cierra la parada.
   *
   * - `delivered`: exige evidencia (firma | foto | confirmación WhatsApp; regla
   *   dura §9), entrega+cobra (deliverAndCollect: fulfill + pago atómicos) y
   *   marca la parada `entregado` con POD/firma.
   * - incidencia (§10): marca la parada y, si el cliente RECHAZA, cancela el
   *   pedido → libera la reserva de stock. `not_located`/`wrong_address` dejan la
   *   parada `no_entregado` y el pedido vivo para reintento.
   *
   * Actualiza logistics.guide_recipients por SQL en el mismo tenant scope
   * (cross-schema pragmático, espejo del routing que lee/escribe commercial.orders).
   */
  async recordDeliveryOutcome(recipientId: string, dto: RecordDeliveryOutcomeDto) {
    if (!UUID_RE.test(recipientId)) throw new BadRequestException('recipientId inválido');
    if (!DELIVERY_OUTCOMES.includes(dto?.outcome))
      throw new BadRequestException(`outcome inválido: ${dto?.outcome}`);

    const recipient = await this.tk.run((trx) =>
      trx('logistics.guide_recipients').where({ id: recipientId }).first(),
    );
    if (!recipient) throw new NotFoundException(`Destinatario ${recipientId} no encontrado`);
    if (recipient.status === 'entregado')
      throw new ConflictException('La parada ya fue entregada');
    const orderId: string | null = recipient.order_id || null;

    if (dto.outcome === 'delivered') {
      const hasEvidence = !!(dto.signature_url || dto.proof_photo_url || dto.whatsapp_confirmed);
      if (!hasEvidence)
        throw new BadRequestException(
          'Entrega requiere evidencia: firma, foto o confirmación WhatsApp',
        );

      let payment: any = null;
      let order: any = null;
      if (orderId) {
        // Intake propio: fulfill (consume stock) + cobro atómico contra la orden.
        const orderPayment = dto.payment ? { ...dto.payment, order_id: orderId } : undefined;
        const res = await this.payments.deliverAndCollect(orderId, { payment: orderPayment });
        order = res.order;
        payment = res.payment;
      } else if (recipient.kepler_folio && recipient.collect_on_delivery && dto.payment) {
        // Parada Kepler COD: cobro ligado al folio (sin orden; entra al arqueo).
        payment = await this.payments.recordKeplerPayment({
          kepler_folio: recipient.kepler_folio,
          kepler_serie: recipient.kepler_serie,
          kepler_warehouse_code: recipient.kepler_warehouse_code,
          method: dto.payment.method,
          amount: dto.payment.amount,
          cash_received: dto.payment.cash_received,
          reference: dto.payment.reference,
        });
      }

      await this.tk.run((trx) =>
        trx('logistics.guide_recipients').where({ id: recipientId }).update({
          status: 'entregado',
          delivered_to: dto.delivered_to || recipient.customer_name || null,
          proof_photo_url: dto.proof_photo_url || null,
          delivered_signature_url: dto.signature_url || null,
          gps_lat: dto.gps_lat ?? null,
          gps_lng: dto.gps_lng ?? null,
          incident_type: null,
          updated_at: trx.fn.now(),
        }),
      );
      return { recipient_id: recipientId, status: 'entregado', order, payment };
    }

    // ── Incidencia ──
    const rejected = dto.outcome === 'customer_rejected';
    if (rejected && !dto.incident_notes)
      throw new BadRequestException('El rechazo requiere motivo (incident_notes)');

    await this.tk.run((trx) =>
      trx('logistics.guide_recipients').where({ id: recipientId }).update({
        status: rejected ? 'rechazado' : 'no_entregado',
        incident_type: dto.outcome,
        incident_notes: dto.incident_notes || null,
        attempted_at: dto.attempted_at || trx.fn.now(),
        updated_at: trx.fn.now(),
      }),
    );

    // Rechazo → cancelar el pedido libera la reserva de stock.
    if (rejected && orderId) {
      await this.orders.cancel(orderId, dto.incident_notes || 'Rechazo en entrega');
    }

    return {
      recipient_id: recipientId,
      status: rejected ? 'rechazado' : 'no_entregado',
      incident_type: dto.outcome,
      order_cancelled: rejected && !!orderId,
    };
  }

  /** Cliente de cartera (customer_id) o casual: reusa por teléfono, o alta rápida. */
  private async resolveCustomer(dto: HomeDeliveryIntakeDto): Promise<string> {
    if (dto.customer_id) {
      if (!UUID_RE.test(dto.customer_id)) throw new BadRequestException('customer_id inválido');
      return dto.customer_id;
    }
    if (!dto.casual?.name || !dto.casual?.phone)
      throw new BadRequestException('Falta customer_id o casual {name, phone}');

    const phone = dto.casual.phone.trim();
    // Dedup: si ya existe un cliente con ese teléfono, reusarlo (no duplicar casuales).
    const existing = await this.tk.run((trx) =>
      trx('commercial.customers').whereNull('deleted_at').where({ phone }).first(),
    );
    if (existing) return existing.id;

    const digits = phone.replace(/\D/g, '').slice(-10) || 'SN';
    const created = await this.customers.create({
      code: `CAS-${digits}`,
      name: dto.casual.name.trim(),
      phone,
      is_casual: true,
    });
    return created.id;
  }

  /** Warehouse dado o el default del tenant (is_default, activo). */
  private async resolveWarehouse(warehouseId?: string): Promise<string> {
    if (warehouseId) {
      if (!UUID_RE.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
      return warehouseId;
    }
    const wh = await this.tk.run((trx) =>
      trx('commercial.warehouses')
        .whereNull('deleted_at')
        .where({ active: true })
        .orderBy('is_default', 'desc')
        .orderBy('name', 'asc')
        .first(),
    );
    if (!wh) throw new NotFoundException('No hay warehouse activo para la entrega');
    return wh.id;
  }
}
