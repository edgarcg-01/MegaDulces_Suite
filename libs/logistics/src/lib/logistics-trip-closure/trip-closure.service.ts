import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  CargadorRegistrado,
  CargadoresBody,
  CerrarParadaBody,
  CierreDeEmbarque,
  EstadoDeViaje,
  PagoViaje,
  ParadaCierre,
} from '@megadulces/contracts';
import { erroresDeCargadores, erroresDeCierreDeParada } from '@megadulces/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const dia = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/**
 * `[EMB.24]` `[EMB.26]` `[EMB.27]` — Cierre del viaje y registro de cargadores (ADR-091).
 *
 * Lee las vistas `logistics.v_trip_*` (migración `20261012084447`): la Suite NO guarda el estado
 * del viaje, lo DERIVA de las paradas — traspasos con la recepción de Kepler, cargas a ruta al
 * embarcar, clientes con la entrega que registra Logística aquí (foto de la remisión opcional).
 */
@Injectable()
export class TripClosureService {
  private readonly logger = new Logger(TripClosureService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  /** Para el log: el nombre de quien opera. */
  private actor(): string | null {
    return this.tenantCtx.get()?.username ?? null;
  }

  /** Para las columnas de auditoría de `logistics.*`, que son `uuid` (el id del usuario). */
  private actorId(): string | null {
    const id = this.tenantCtx.get()?.userId ?? null;
    return id && UUID.test(id) ? id : null;
  }

  async cierre(shipmentId: string): Promise<CierreDeEmbarque> {
    if (!UUID.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    const datos = await this.tk.run(async (trx) => {
      const s = await trx('logistics.shipments').where({ id: shipmentId }).whereNull('deleted_at').first('id');
      if (!s) throw new NotFoundException('Embarque no encontrado');
      const [viajes, paradas, pagos, cargadores, tarifa] = await Promise.all([
        trx('logistics.v_trip_state').where({ shipment_id: shipmentId }).orderBy('guide_number'),
        trx('logistics.v_trip_stop_closure')
          .where({ shipment_id: shipmentId })
          .orderByRaw('sequence_order NULLS LAST, kepler_folio NULLS LAST, recipient_id'),
        trx('logistics.v_trip_pay_items').where({ shipment_id: shipmentId }).orderBy(['rol', 'persona', 'concept']),
        this.cargadoresDe(trx, shipmentId),
        this.tarifaCarga(trx),
      ]);
      return { viajes, paradas, pagos, cargadores, tarifa };
    });

    const paradas: ParadaCierre[] = await Promise.all(
      datos.paradas.map(async (p: any) => ({
        recipient_id: p.recipient_id,
        guide_id: p.guide_id,
        sequence_order: p.sequence_order,
        customer_name: p.customer_name,
        kepler_serie: p.kepler_serie,
        kepler_folio: p.kepler_folio,
        value: num(p.value),
        tipo_parada: p.tipo_parada,
        destino_code: p.destino_code,
        importe_embarcado: num(p.importe_embarcado),
        recepcion_folio: p.recepcion_folio,
        recepcion_importe: num(p.recepcion_importe),
        recepcion_fecha: dia(p.recepcion_fecha),
        diferencia: num(p.diferencia),
        recipient_status: p.recipient_status,
        delivered_at: p.delivered_at ? new Date(p.delivered_at).toISOString() : null,
        delivered_to: p.delivered_to,
        incident_type: p.incident_type,
        incident_notes: p.incident_notes,
        estado_parada: p.estado_parada,
        motivo: p.motivo,
        remision_url: await this.urlDe(p.proof_photo_url),
      })),
    );

    return {
      shipment_id: shipmentId,
      viajes: datos.viajes.map((v: any): EstadoDeViaje => ({
        guide_id: v.guide_id,
        guide_number: v.guide_number,
        shipment_id: v.shipment_id,
        shipment_folio: v.shipment_folio,
        kepler_sucursal: v.kepler_sucursal,
        kepler_guia: v.kepler_guia,
        shipment_date: dia(v.shipment_date) as string,
        estado_viaje: v.estado_viaje,
        paradas: Number(v.paradas),
        paradas_cerradas: Number(v.paradas_cerradas),
        paradas_con_diferencia: Number(v.paradas_con_diferencia),
        paradas_pendientes: Number(v.paradas_pendientes),
      })),
      paradas,
      pagos: datos.pagos.map(aPagoViaje),
      cargadores: datos.cargadores,
      tarifa_carga: datos.tarifa,
    };
  }

  /** `[EMB.24]` La parada de cliente se cierra con el resultado que registra Logística (foto opcional). */
  async cerrarParada(recipientId: string, body: CerrarParadaBody): Promise<ParadaCierre> {
    if (!UUID.test(recipientId)) throw new BadRequestException('recipientId inválido');
    const tenantId = this.tenantCtx.requireTenantId();

    const parada = await this.tk.run((trx) =>
      trx('logistics.v_trip_stop_closure').where({ recipient_id: recipientId }).first(),
    );
    if (!parada) throw new NotFoundException('Parada no encontrada');
    const errs = erroresDeCierreDeParada(body, parada);
    if (errs.length) {
      if (errs[0] === 'La parada ya se cerró.') throw new ConflictException(errs[0]);
      throw new BadRequestException(errs.join(' '));
    }

    // Si viene foto, se sube ANTES de escribir: si el almacenamiento falla, la parada sigue pendiente.
    const key = body.foto ? (await this.storage.putFile(body.foto, `logistics/${tenantId}/remisiones`)).key : null;
    const entregado = body.resultado === 'entregado';

    const actualizada = await this.tk.run(async (trx) => {
      const n = await trx('logistics.guide_recipients')
        .where({ id: recipientId, status: 'pendiente' })
        .update({
          status: entregado ? 'entregado' : 'no_entregado',
          delivered_at: entregado ? trx.fn.now() : null,
          attempted_at: entregado ? null : trx.fn.now(),
          delivered_to: entregado ? (body.recibio ?? '').trim() : null,
          incident_type: entregado ? null : body.motivo,
          incident_notes: (body.nota ?? '').trim() || null,
          ...(key ? { proof_photo_url: key } : {}),
          updated_at: trx.fn.now(),
          updated_by: this.actorId(),
        });
      // Dos personas a la vez: la segunda no pisa a la primera.
      if (!n) return null;
      return trx('logistics.v_trip_stop_closure').where({ recipient_id: recipientId }).first();
    });
    if (!actualizada) {
      if (key) await this.storage.remove(key);
      throw new ConflictException('La parada ya se cerró.');
    }
    this.logger.log(`Parada ${recipientId} cerrada (${body.resultado}) por ${this.actor() ?? '?'}`);
    const shipment = await this.cierre(actualizada.shipment_id);
    return shipment.paradas.find((p) => p.recipient_id === recipientId) as ParadaCierre;
  }

  /** `[EMB.27]` Quién cargó el embarque. Reemplaza la lista; cada cargador cobra la tarifa vigente. */
  async setCargadores(shipmentId: string, body: CargadoresBody): Promise<CierreDeEmbarque> {
    if (!UUID.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    await this.tk.run(async (trx) => {
      const tarifa = await this.tarifaCarga(trx);
      const errs = erroresDeCargadores(body, tarifa);
      if (errs.length) throw new BadRequestException(errs.join(' '));

      const s = await trx('logistics.shipments').where({ id: shipmentId }).whereNull('deleted_at').forUpdate().first();
      if (!s) throw new NotFoundException('Embarque no encontrado');
      if (s.status === 'cancelado') throw new ConflictException('El embarque está cancelado.');

      const pagados = await trx('finance.trip_pay_lines as l')
        .join('logistics.load_details as ld', 'ld.id', 'l.source_id')
        .join('finance.expense_proofs as p', 'p.id', 'l.expense_proof_id')
        .where({ 'l.source': 'carga', 'l.vigente': true, 'ld.shipment_id': shipmentId })
        .whereNot('p.status', 'rechazada')
        .count<{ n: string }[]>('* as n');
      if (Number(pagados[0]?.n ?? 0) > 0) {
        throw new ConflictException('La carga de este embarque ya está en un vale: no se puede cambiar.');
      }

      const ids = body.driver_ids;
      if (ids.length) {
        const personas = await trx('logistics.drivers')
          .whereIn('id', ids)
          .whereNull('deleted_at')
          .where({ active: true, status: 'activo' })
          .select('id');
        if (personas.length !== ids.length) {
          throw new BadRequestException('Hay un cargador que no existe o no está activo en el padrón.');
        }
      }

      await trx('logistics.load_details').where({ shipment_id: shipmentId }).del();
      if (ids.length) {
        await trx('logistics.load_details').insert(
          ids.map((driver_id) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            shipment_id: shipmentId,
            driver_id,
            rate: tarifa,
            role_at_time: 'cargador',
            created_by: this.actorId(),
          })),
        );
      }
    });
    return this.cierre(shipmentId);
  }

  private async cargadoresDe(trx: any, shipmentId: string): Promise<CargadorRegistrado[]> {
    const rows = await trx('logistics.load_details as ld')
      .join('logistics.drivers as d', 'd.id', 'ld.driver_id')
      .leftJoin('finance.trip_pay_lines as l', function (this: any) {
        this.on('l.source_id', '=', 'ld.id').andOn('l.driver_id', '=', 'ld.driver_id')
          .andOn(trx.raw("l.source = 'carga'")).andOn(trx.raw('l.vigente'));
      })
      .leftJoin('finance.expense_proofs as p', 'p.id', 'l.expense_proof_id')
      .where('ld.shipment_id', shipmentId)
      .orderBy('d.full_name')
      .select('ld.id', 'ld.driver_id', 'd.full_name as persona', 'ld.rate',
        trx.raw("(l.id IS NOT NULL AND COALESCE(p.status,'') <> 'rechazada') AS pagado"));
    return rows.map((r: any) => ({
      id: r.id, driver_id: r.driver_id, persona: r.persona, rate: Number(r.rate), pagado: !!r.pagado,
    }));
  }

  private async tarifaCarga(trx: any): Promise<number | null> {
    const row = await trx('logistics.config_finance')
      .where({ key: 'tarifa_maniobra_carga', active: true })
      .first('value');
    const v = row?.value == null ? null : Number(row.value);
    return v != null && v > 0 ? v : null;
  }

  private async urlDe(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;
    const url = await this.storage.signedUrl(key).catch(() => '');
    return url || null;
  }
}

export function aPagoViaje(r: any): PagoViaje {
  return {
    source: r.source,
    source_id: r.source_id,
    shipment_id: r.shipment_id,
    shipment_folio: r.shipment_folio,
    kepler_sucursal: r.kepler_sucursal,
    kepler_guia: r.kepler_guia,
    shipment_date: dia(r.shipment_date) as string,
    guide_number: r.guide_number,
    driver_id: r.driver_id,
    persona: r.persona,
    rol: r.rol,
    concept: r.concept,
    amount: Number(r.amount),
    estado_viaje: r.estado_viaje,
    liberado: !!r.liberado,
    motivo: r.motivo,
    en_vale: !!r.en_vale,
    expense_proof_id: r.expense_proof_id,
    vale_status: r.vale_status,
    vale_folio: r.vale_folio,
  };
}
