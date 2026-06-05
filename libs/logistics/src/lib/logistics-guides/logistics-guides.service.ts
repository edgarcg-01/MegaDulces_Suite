import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

export type GuideStatus = 'pendiente' | 'en_ruta' | 'entregada' | 'cancelada';
export type RecipientStatus = 'pendiente' | 'entregado' | 'no_entregado' | 'rechazado';

export interface CreateGuideDto {
  shipment_id: string;
  type?: string;
  driver_id?: string;
  helper1_id?: string;
  helper2_id?: string;
  driver_commission?: number;
  helper1_commission?: number;
  helper2_commission?: number;
  overnight?: boolean;
  per_diem_total?: number;
  per_diem_breakdown?: any;
  notes?: string;
  /**
   * Si true, auto-calcula comisiones leyendo route.driver_commission y
   * route.helper_commission (NO toca valores que vengan explícitamente en el dto).
   */
  auto_commissions?: boolean;
  /**
   * Si true, computa `per_diem_total` y enriquece `per_diem_breakdown` con
   * `subtotal` por persona a partir del checklist café/desayuno/comida/cena
   * × tarifas de `config_finance` categoría `viatico`. Sobrescribe el
   * `per_diem_total` del dto si auto=true.
   */
  auto_per_diem?: boolean;
}

export interface UpdateGuideDto extends Partial<Omit<CreateGuideDto, 'shipment_id' | 'auto_commissions' | 'auto_per_diem'>> {
  status?: GuideStatus;
  auto_per_diem?: boolean;
}

export interface CreateRecipientDto {
  customer_name: string;
  customer_id?: string;
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
  ) {}

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

      // Validar driver/helpers
      for (const [k, v] of Object.entries({
        driver_id: dto.driver_id,
        helper1_id: dto.helper1_id,
        helper2_id: dto.helper2_id,
      })) {
        if (v) await this.assertDriverActive(trx, v, k);
      }

      // Auto-calc comisiones desde route si se pidió y la guía no override
      const commissions = await this.resolveCommissions(trx, shipment.route_id, dto);

      // Auto-calc viáticos desde checklist si se pidió
      let perDiemTotal = dto.per_diem_total ?? 0;
      let perDiemBreakdown: any = dto.per_diem_breakdown || null;
      if (dto.auto_per_diem && perDiemBreakdown) {
        const r = await this.computePerDiemFromChecklist(trx, perDiemBreakdown);
        perDiemTotal = r.total;
        perDiemBreakdown = r.enriched;
      }

      const number = await this.nextGuideFolio(trx);

      const [row] = await trx('logistics.delivery_guides')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          number,
          shipment_id: dto.shipment_id,
          type: dto.type || 'entrega',
          status: 'pendiente',
          driver_id: dto.driver_id || null,
          driver_commission: commissions.driver,
          helper1_id: dto.helper1_id || null,
          helper1_commission: commissions.helper1,
          helper2_id: dto.helper2_id || null,
          helper2_commission: commissions.helper2,
          overnight: dto.overnight ?? false,
          per_diem_total: perDiemTotal,
          per_diem_breakdown: perDiemBreakdown
            ? JSON.stringify(perDiemBreakdown)
            : null,
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

      for (const [k, v] of Object.entries({
        driver_id: dto.driver_id,
        helper1_id: dto.helper1_id,
        helper2_id: dto.helper2_id,
      })) {
        if (v) await this.assertDriverActive(trx, v as string, k);
      }

      if (dto.status !== undefined) {
        const allowed = GUIDE_TRANSITIONS[existing.status as GuideStatus] || [];
        if (!allowed.includes(dto.status)) {
          throw new ConflictException(
            `Transición inválida: ${existing.status} → ${dto.status}. Permitidas: [${allowed.join(', ')}]`,
          );
        }
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of [
        'type', 'status', 'driver_id', 'helper1_id', 'helper2_id',
        'driver_commission', 'helper1_commission', 'helper2_commission',
        'overnight', 'per_diem_total', 'notes',
      ] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }
      if (dto.per_diem_breakdown !== undefined) {
        patch.per_diem_breakdown = dto.per_diem_breakdown
          ? JSON.stringify(dto.per_diem_breakdown)
          : null;
      }
      // Auto-calc viáticos si se pidió y hay breakdown (en dto o existente)
      if (dto.auto_per_diem) {
        const breakdown = dto.per_diem_breakdown !== undefined
          ? dto.per_diem_breakdown
          : (existing.per_diem_breakdown || null);
        if (breakdown) {
          const r = await this.computePerDiemFromChecklist(trx, breakdown);
          patch.per_diem_total = r.total;
          patch.per_diem_breakdown = JSON.stringify(r.enriched);
        }
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

      if (dto.customer_id) {
        if (!UUID_REGEX.test(dto.customer_id)) throw new BadRequestException('customer_id inválido');
        const c = await trx('commercial.customers')
          .where({ id: dto.customer_id })
          .whereNull('deleted_at')
          .first();
        if (!c) throw new NotFoundException(`Customer ${dto.customer_id} no encontrado`);
      }

      const [row] = await trx('logistics.guide_recipients')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          guide_id: guideId,
          customer_id: dto.customer_id || null,
          customer_name: dto.customer_name.trim(),
          address: dto.address || null,
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

  /**
   * Resuelve qué comisión asignar al chofer/ayudantes:
   *  - Si el dto trae valor explícito, lo respeta.
   *  - Si dto.auto_commissions=true Y hay route_id, lee route.driver_commission / helper_commission.
   *  - Si no, 0.
   */
  private async resolveCommissions(
    trx: any,
    routeId: string | null,
    dto: CreateGuideDto,
  ): Promise<{ driver: number; helper1: number; helper2: number }> {
    let routeDriver = 0;
    let routeHelper = 0;
    if (dto.auto_commissions && routeId) {
      const r = await trx('logistics.routes').where({ id: routeId }).first();
      if (r) {
        routeDriver = Number(r.driver_commission) || 0;
        routeHelper = Number(r.helper_commission) || 0;
      }
    }
    return {
      driver: dto.driver_commission ?? (dto.driver_id ? routeDriver : 0),
      helper1: dto.helper1_commission ?? (dto.helper1_id ? routeHelper : 0),
      helper2: dto.helper2_commission ?? (dto.helper2_id ? routeHelper : 0),
    };
  }

  /**
   * Calcula el monto total de viáticos a partir del checklist por persona
   * y las tarifas del catálogo `config_finance` (categoría 'viatico').
   *
   * Estructura esperada de `breakdown`:
   *   {
   *     driver: { cafe: bool, desayuno: bool, comida: bool, cena: bool },
   *     helper1: { ... },
   *     helper2: { ... },
   *   }
   *
   * Si el checklist no incluye alguna persona, asume false en todos los meals.
   * Retorna { total, breakdown_enriched } donde breakdown_enriched agrega
   * el campo `subtotal` calculado por persona.
   */
  async computePerDiemFromChecklist(
    trx: any,
    breakdown: any,
  ): Promise<{ total: number; enriched: any }> {
    const rates: Record<string, number> = {};
    const rows = await trx('logistics.config_finance')
      .where({ category: 'viatico', active: true })
      .select('key', 'value');
    for (const r of rows) {
      const meal = r.key.replace(/^viatico_/, '');
      rates[meal] = Number(r.value) || 0;
    }

    const enriched: any = {};
    let total = 0;
    for (const person of ['driver', 'helper1', 'helper2']) {
      const checks = breakdown?.[person] || {};
      let subtotal = 0;
      for (const meal of ['cafe', 'desayuno', 'comida', 'cena']) {
        if (checks[meal] === true) subtotal += rates[meal] || 0;
      }
      enriched[person] = { ...checks, subtotal };
      total += subtotal;
    }
    return { total, enriched };
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
