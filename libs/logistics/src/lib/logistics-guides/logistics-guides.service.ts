import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import type { CompletarGuiaBody, GuiaCompletada, TarifaDeRuta, TarifasViatico } from '@megadulces/contracts';
import { erroresDeTarifa, erroresDeTarifaDeRuta, pendientesDeLaGuia, tarifasDeViatico } from '@megadulces/contracts';
import {
  calcularCompletar, calcularGuia, cambiosACamposCalculados, capturaCompleta, CompletarContexto, GUIA_NO_SE_EDITA,
  validarCompletar, validarGuiaManual,
} from './guia-calculada.logic';
import { ErpShipmentsService } from '../logistics-erp-shipments/erp-shipments.service';

export type GuideStatus = 'pendiente' | 'en_ruta' | 'entregada' | 'cancelada';
export type RecipientStatus = 'pendiente' | 'entregado' | 'no_entregado' | 'rechazado';

export interface CreateGuideDto {
  shipment_id: string;
  type?: string;
  driver_id?: string;
  helper1_id?: string;
  helper2_id?: string;
  /** EMB.19 — el horario del viaje: de él salen los viáticos (`HH:MM`). */
  departure_time?: string | null;
  arrival_time?: string | null;
  /** Se queda a dormir fuera: da cena (regla de la beta). */
  overnight?: boolean;
  /**
   * EMB.19 — comisión y viáticos NO se capturan: se calculan de la tarifa de la ruta del embarque
   * y del horario. Si vienen, tienen que coincidir con el cálculo o la guía no se crea.
   */
  driver_commission?: number;
  helper1_commission?: number;
  helper2_commission?: number;
  per_diem_total?: number;
  notes?: string;
}

export interface UpdateGuideDto extends Partial<Omit<CreateGuideDto, 'shipment_id'>> {
  status?: GuideStatus;
  /** Ya no se aceptan: el desglose lo escribe el cálculo (EMB.19). Declarados para rechazarlos. */
  per_diem_breakdown?: unknown;
  auto_per_diem?: boolean;
}

export interface CreateRecipientDto {
  customer_name: string;
  customer_id?: string;
  order_id?: string;
  address?: string;
  boxes_count?: number;
  weight_kg?: number;
  value?: number;
  notes?: string;
}

export interface MarkDeliveredDto {
  delivered_to?: string;
  proof_photo_url?: string;
  gps_lat?: number;
  gps_lng?: number;
  notes?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GUIDE_TRANSITIONS: Record<GuideStatus, GuideStatus[]> = {
  pendiente: ['en_ruta', 'cancelada'],
  en_ruta: ['entregada', 'cancelada'],
  entregada: [],
  cancelada: [],
};

@Injectable()
export class LogisticsGuidesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly erp: ErpShipmentsService,
  ) {}

  /**
   * EMB.22 — Completar la guía que nació al tomar un viaje de Kepler: se captura UNA vez lo que
   * Kepler no tiene (ayudantes, horario y, si Kepler no lo trajo, el chofer). Se valida la tarifa
   * del viaje y el horario, se calculan comisión y viáticos, y la guía queda bloqueada.
   */
  async complete(id: string, dto: CompletarGuiaBody): Promise<GuiaCompletada> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    const datos = await this.tk.run(async (trx: Knex.Transaction) => {
      const guia = await trx('logistics.delivery_guides').where({ id }).whereNull('deleted_at')
        .first('id', 'number', 'status', 'shipment_id', 'driver_id', 'departure_time', 'arrival_time');
      if (!guia) throw new NotFoundException(`Guía ${id} no encontrada`);
      const embarque = await trx('logistics.shipments').where({ id: guia.shipment_id }).whereNull('deleted_at')
        .first('id', 'status', 'route_id', 'kepler_sucursal', 'kepler_guia');
      if (!embarque) throw new NotFoundException('El embarque de la guía no existe');
      const ruta = embarque.kepler_guia ? null : await this.tarifaDeRuta(trx, embarque.route_id);
      return { guia, embarque, ruta, tarifas: await this.tarifasViatico(trx) };
    });
    const { guia, embarque, ruta, tarifas } = datos;
    if (guia.status === 'cancelada') throw new ConflictException(`La guía ${guia.number} está cancelada.`);
    if (['cerrado', 'cancelado'].includes(embarque.status)) {
      throw new ConflictException(`El embarque está ${embarque.status}: su guía ya no se completa.`);
    }
    if (!pendientesDeLaGuia(guia).length) throw new ConflictException(GUIA_NO_SE_EDITA);

    // La tarifa: la del viaje de Kepler (la mayor de sus rutas, EMB.13) o la ruta del embarque.
    const hoja = embarque.kepler_sucursal && embarque.kepler_guia
      ? await this.erp.nuevoEmbarque(embarque.kepler_sucursal, embarque.kepler_guia)
      : null;
    const ctx: CompletarContexto = hoja
      ? {
          chofer_guia: guia.driver_id ?? null,
          comision: { driver: hoja.comision.driver, helper: hoja.comision.helper },
          erroresDeTarifa: (ay) => erroresDeTarifa(hoja.comision, hoja.resumen.paradas_sin_ruta, ay),
          tarifas,
        }
      : {
          chofer_guia: guia.driver_id ?? null,
          comision: { driver: ruta?.driver ?? null, helper: ruta?.helper ?? null },
          erroresDeTarifa: (ay) => erroresDeTarifaDeRuta(ruta, ay),
          tarifas,
        };
    const errores = validarCompletar(dto, ctx);
    if (errores.length) throw new BadRequestException(errores.join(' '));
    const captura = capturaCompleta(dto, ctx);
    const { comisiones, viaticos } = calcularCompletar(dto, ctx);

    return this.tk.run(async (trx: Knex.Transaction) => {
      for (const [k, v] of Object.entries({ driver_id: captura.driver_id, helper1_id: captura.helper1_id, helper2_id: captura.helper2_id })) {
        if (v) await this.assertDriverActive(trx, v, k);
      }
      // Sólo si sigue incompleta: dos personas completando la misma guía, gana la primera.
      const [row] = await trx('logistics.delivery_guides')
        .where({ id }).whereNull('deleted_at')
        .where((q) => q.whereNull('driver_id').orWhereNull('departure_time').orWhereNull('arrival_time'))
        .update({
          driver_id: captura.driver_id || null,
          driver_commission: comisiones.driver_commission,
          helper1_id: captura.helper1_id || null,
          helper1_commission: comisiones.helper1_commission,
          helper2_id: captura.helper2_id || null,
          helper2_commission: comisiones.helper2_commission,
          departure_time: viaticos.horario.salida,
          arrival_time: viaticos.horario.llegada,
          overnight: viaticos.horario.duerme_fuera,
          per_diem_total: viaticos.total,
          per_diem_breakdown: JSON.stringify(viaticos),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (!row) throw new ConflictException('Otra persona acaba de completar esta guía. Recarga el embarque.');
      return {
        id: row.id, number: row.number,
        driver_commission: Number(row.driver_commission), helper1_commission: Number(row.helper1_commission),
        helper2_commission: Number(row.helper2_commission), per_diem_total: Number(row.per_diem_total),
      };
    });
  }

  // ── Guides CRUD ──────────────────────────────────────────────────────────

  async create(dto: CreateGuideDto) {
    if (!UUID_REGEX.test(dto.shipment_id)) throw new BadRequestException('shipment_id inválido');

    return this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments')
        .where({ id: dto.shipment_id })
        .whereNull('deleted_at')
        .first();
      if (!shipment) throw new NotFoundException(`Shipment ${dto.shipment_id} no encontrado`);
      if (['cerrado', 'cancelado'].includes(shipment.status)) {
        throw new ConflictException(`Shipment ${shipment.folio} está ${shipment.status}, no admite guías nuevas.`);
      }

      // EMB.19 — la guía de un embarque de Kepler sale de su hoja (con sus paradas): no se agrega a mano.
      if (shipment.kepler_guia) {
        throw new ConflictException(
          `El embarque ${shipment.folio} viene de la guía ${shipment.kepler_sucursal}-G${shipment.kepler_guia} de Kepler: su guía sale de la hoja, no se agrega a mano.`,
        );
      }

      // Comisión y viáticos se CALCULAN (tarifa de la ruta + horario); lo que falte frena.
      const ctx = { ruta: await this.tarifaDeRuta(trx, shipment.route_id), tarifas: await this.tarifasViatico(trx) };
      const errores = validarGuiaManual(dto, ctx);
      if (errores.length) throw new BadRequestException(errores.join(' '));

      for (const [k, v] of Object.entries({
        driver_id: dto.driver_id,
        helper1_id: dto.helper1_id,
        helper2_id: dto.helper2_id,
      })) {
        if (v) await this.assertDriverActive(trx, v, k);
      }

      const { comisiones, viaticos } = calcularGuia(dto, ctx);

      const number = await this.nextGuideFolio(trx);

      const [row] = await trx('logistics.delivery_guides')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          number,
          shipment_id: dto.shipment_id,
          type: dto.type || 'entrega',
          status: 'pendiente',
          driver_id: dto.driver_id || null,
          driver_commission: comisiones.driver_commission,
          helper1_id: dto.helper1_id || null,
          helper1_commission: comisiones.helper1_commission,
          helper2_id: dto.helper2_id || null,
          helper2_commission: comisiones.helper2_commission,
          departure_time: viaticos.horario.salida,
          arrival_time: viaticos.horario.llegada,
          overnight: viaticos.horario.duerme_fuera,
          per_diem_total: viaticos.total,
          per_diem_breakdown: JSON.stringify(viaticos),
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  async list(shipmentId?: string) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.delivery_guides').whereNull('deleted_at');
      if (shipmentId) q = q.where({ shipment_id: shipmentId });
      return q.orderBy('number', 'desc');
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const guide = await trx('logistics.delivery_guides')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!guide) throw new NotFoundException(`Guide ${id} no encontrada`);
      const recipients = await trx('logistics.guide_recipients')
        .where({ guide_id: id })
        .orderBy('created_at', 'asc');
      return { ...guide, recipients };
    });
  }

  async update(id: string, dto: UpdateGuideDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.delivery_guides')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Guide ${id} no encontrada`);
      if (['entregada', 'cancelada'].includes(existing.status)) {
        throw new ConflictException(`Guide ${existing.number} ya está ${existing.status}, no editable.`);
      }

      // EMB.19 — tripulación, horario, comisión y viáticos se calculan al crear la guía.
      if (cambiosACamposCalculados(existing, dto).length) throw new ConflictException(GUIA_NO_SE_EDITA);

      if (dto.status !== undefined) {
        const allowed = GUIDE_TRANSITIONS[existing.status as GuideStatus] || [];
        if (!allowed.includes(dto.status)) {
          throw new ConflictException(
            `Transición inválida: ${existing.status} → ${dto.status}. Permitidas: [${allowed.join(', ')}]`,
          );
        }
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of ['type', 'status', 'notes'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }

      const [row] = await trx('logistics.delivery_guides')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async softDelete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const g = await trx('logistics.delivery_guides')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!g) throw new NotFoundException(`Guide ${id} no encontrada`);
      if (!['cancelada'].includes(g.status)) {
        throw new ConflictException(`Solo se borran guías canceladas (actual: ${g.status})`);
      }
      await trx('logistics.delivery_guides')
        .where({ id })
        .update({ deleted_at: trx.fn.now() });
      return { deleted: true, id };
    });
  }

  // ── Recipients ───────────────────────────────────────────────────────────

  async addRecipient(guideId: string, dto: CreateRecipientDto) {
    if (!UUID_REGEX.test(guideId)) throw new BadRequestException('guideId inválido');
    if (!dto.customer_name?.trim()) throw new BadRequestException('customer_name requerido');

    return this.tk.run(async (trx) => {
      const guide = await trx('logistics.delivery_guides')
        .where({ id: guideId })
        .whereNull('deleted_at')
        .first();
      if (!guide) throw new NotFoundException(`Guide ${guideId} no encontrada`);
      if (['entregada', 'cancelada'].includes(guide.status)) {
        throw new ConflictException(`Guide ${guide.number} está ${guide.status}, no admite destinatarios.`);
      }

      let customer: any = null;
      if (dto.customer_id) {
        if (!UUID_REGEX.test(dto.customer_id)) throw new BadRequestException('customer_id inválido');
        customer = await trx('commercial.customers')
          .where({ id: dto.customer_id })
          .whereNull('deleted_at')
          .first();
        if (!customer) throw new NotFoundException(`Customer ${dto.customer_id} no encontrado`);
      }

      // J12.0.x: liga la orden entregada para itemizar la Carta Porte (multi-drop).
      if (dto.order_id) {
        if (!UUID_REGEX.test(dto.order_id)) throw new BadRequestException('order_id inválido');
        const o = await trx('commercial.orders').where({ id: dto.order_id }).first();
        if (!o) throw new NotFoundException(`Order ${dto.order_id} no encontrada`);
      }

      // Carta Porte: domicilio de destino. Reusa el del cliente si no se da uno.
      const fiscalAddress = customer?.billing_address
        ? (typeof customer.billing_address === 'string' ? JSON.parse(customer.billing_address) : customer.billing_address)
        : null;

      const [row] = await trx('logistics.guide_recipients')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          guide_id: guideId,
          customer_id: dto.customer_id || null,
          order_id: dto.order_id || null,
          customer_name: dto.customer_name.trim(),
          address: dto.address || null,
          fiscal_address: fiscalAddress ? JSON.stringify(fiscalAddress) : null,
          boxes_count: dto.boxes_count || 0,
          weight_kg: dto.weight_kg || 0,
          value: dto.value || 0,
          status: 'pendiente',
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  async markRecipientDelivered(recipientId: string, dto: MarkDeliveredDto) {
    if (!UUID_REGEX.test(recipientId)) throw new BadRequestException('recipientId inválido');
    return this.tk.run(async (trx) => {
      const r = await trx('logistics.guide_recipients').where({ id: recipientId }).first();
      if (!r) throw new NotFoundException(`Recipient ${recipientId} no encontrado`);
      if (r.status !== 'pendiente') {
        throw new ConflictException(`Recipient ya está ${r.status}`);
      }
      const [updated] = await trx('logistics.guide_recipients')
        .where({ id: recipientId })
        .update({
          status: 'entregado',
          delivered_at: trx.fn.now(),
          delivered_to: dto.delivered_to || null,
          proof_photo_url: dto.proof_photo_url || null,
          gps_lat: dto.gps_lat ?? null,
          gps_lng: dto.gps_lng ?? null,
          notes: dto.notes || r.notes,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return updated;
    });
  }

  async removeRecipient(recipientId: string) {
    if (!UUID_REGEX.test(recipientId)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const r = await trx('logistics.guide_recipients').where({ id: recipientId }).first();
      if (!r) throw new NotFoundException(`Recipient ${recipientId} no encontrado`);
      if (r.status !== 'pendiente') {
        throw new ConflictException(`No se puede borrar recipient en estado ${r.status}`);
      }
      await trx('logistics.guide_recipients').where({ id: recipientId }).del();
      return { deleted: true, id: recipientId };
    });
  }

  // ── Helpers internos ─────────────────────────────────────────────────────

  /** La ruta del embarque con su tarifa de comisión. null = el embarque no tiene ruta. */
  private async tarifaDeRuta(trx: Knex.Transaction, routeId: string | null): Promise<TarifaDeRuta | null> {
    if (!routeId) return null;
    const r = await trx('logistics.routes').where({ id: routeId }).first('id', 'name', 'driver_commission', 'helper_commission');
    if (!r) return null;
    return {
      route_id: r.id,
      nombre: r.name,
      driver: r.driver_commission == null ? null : Number(r.driver_commission),
      helper: r.helper_commission == null ? null : Number(r.helper_commission),
    };
  }

  /** Tarifas de viático por comida (`config_finance`, categoría `viatico`). */
  async tarifasViatico(trx: Knex.Transaction): Promise<TarifasViatico> {
    const rows = await trx('logistics.config_finance').where({ category: 'viatico', active: true }).select('key', 'value');
    return tarifasDeViatico(rows);
  }

  private async assertDriverActive(trx: any, driverId: string, field: string): Promise<void> {
    if (!UUID_REGEX.test(driverId)) throw new BadRequestException(`${field} inválido`);
    const d = await trx('logistics.drivers')
      .where({ id: driverId })
      .whereNull('deleted_at')
      .first();
    if (!d) throw new NotFoundException(`Driver ${driverId} no encontrado (${field})`);
    if (!d.active || d.status !== 'activo') {
      throw new ConflictException(`Driver ${d.full_name} no está activo (${field})`);
    }
  }

  private async nextGuideFolio(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();
    const [{ current_value }] = await trx.raw(
      `
      INSERT INTO logistics.sequences (tenant_id, prefix, year, current_value)
      VALUES (?, 'GUIA', ?, 1)
      ON CONFLICT (tenant_id, prefix, year) DO UPDATE
        SET current_value = logistics.sequences.current_value + 1,
            updated_at = now()
      RETURNING current_value
      `,
      [tenantId, year],
    ).then((r: any) => r.rows);
    return `GUIA-${year}-${String(current_value).padStart(5, '0')}`;
  }
}
