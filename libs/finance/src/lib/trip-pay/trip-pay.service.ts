import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { PagoViaje } from '@megadulces/contracts';
import { CONCEPTO_KEPLER, totalesPorConcepto } from '@megadulces/contracts';
import { htmlAPdf } from '../shared/chromium-pdf';
import {
  conceptoDelVale, corteAPagar, corteDe, Corte, esFecha, htmlHojaDeViajes, resumenPorPersona, ResumenPersona,
} from './trip-pay.logic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fila cruda de `logistics.v_trip_pay_items` (pg devuelve numeric como texto y date como Date). */
interface FilaPago extends Omit<PagoViaje, 'shipment_date' | 'amount'> {
  shipment_date: string | Date;
  amount: string | number;
}

const dia = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));

export interface CorteDeLogistica {
  corte: Corte;
  personas: ResumenPersona[];
  totales: { liberado: number; retenido: number; en_vale: number };
}

export interface DetallePersona {
  corte: Corte;
  driver_id: string;
  persona: string;
  pagables: PagoViaje[];
  retenidos: PagoViaje[];
  en_vale: PagoViaje[];
}

export interface ValeCreado {
  id: string;
  importe: number;
  renglones: number;
  persona: string;
}

/**
 * `[EMB.29]` — El vale de comisiones y viáticos de logística (ADR-091).
 *
 * Lee lo que cada persona tiene por viaje o por carga en `logistics.v_trip_pay_items` (una
 * vista: finanzas NO importa la librería de logística) y arma UN vale de Gastos por persona y
 * corte, sólo con lo LIBERADO (viaje cerrado o carga en Kepler) que no esté ya en otro vale.
 *
 * El vale sigue el protocolo normal de Gastos: nace `recibida`, sin folio (la solicitud X-A-15
 * se casa después con «Casar con Kepler»), con la hoja de viajes como respaldo, y lo aprueba
 * alguien distinto de quien lo preparó (`asegurarQueNoEsSuyo` lee `created_by`).
 */
@Injectable()
export class TripPayService {
  private readonly logger = new Logger(TripPayService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  private resolverCorte(desde?: string, hasta?: string): Corte {
    if (esFecha(desde) && esFecha(hasta)) {
      if (desde > hasta) throw new BadRequestException('«desde» es posterior a «hasta».');
      return { desde, hasta, pago: corteDe(hasta).pago };
    }
    if (desde || hasta) throw new BadRequestException('Las fechas van como YYYY-MM-DD.');
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    return corteAPagar(hoy);
  }

  private async items(trx: Knex.Transaction, corte: Corte, driverId?: string): Promise<PagoViaje[]> {
    const q = trx('logistics.v_trip_pay_items').whereBetween('shipment_date', [corte.desde, corte.hasta]);
    if (driverId) q.where({ driver_id: driverId });
    const rows = await q.orderBy(['shipment_date', 'shipment_folio']);
    return (rows as FilaPago[]).map((r) => ({
      source: r.source, source_id: r.source_id, shipment_id: r.shipment_id, shipment_folio: r.shipment_folio,
      kepler_sucursal: r.kepler_sucursal, kepler_guia: r.kepler_guia, shipment_date: dia(r.shipment_date),
      guide_number: r.guide_number, driver_id: r.driver_id, persona: r.persona, rol: r.rol, concept: r.concept,
      amount: Number(r.amount), estado_viaje: r.estado_viaje, liberado: !!r.liberado, motivo: r.motivo,
      en_vale: !!r.en_vale, expense_proof_id: r.expense_proof_id, vale_status: r.vale_status, vale_folio: r.vale_folio,
    }));
  }

  async corte(desde?: string, hasta?: string): Promise<CorteDeLogistica> {
    const corte = this.resolverCorte(desde, hasta);
    const items = await this.tk.run((trx) => this.items(trx, corte));
    const personas = resumenPorPersona(items);
    const sum = (f: (p: ResumenPersona) => number) => Math.round(personas.reduce((s, p) => s + f(p), 0) * 100) / 100;
    return {
      corte,
      personas,
      totales: { liberado: sum((p) => p.liberado_total), retenido: sum((p) => p.retenido_total), en_vale: sum((p) => p.en_vale_total) },
    };
  }

  async persona(driverId: string, desde?: string, hasta?: string): Promise<DetallePersona> {
    if (!UUID.test(driverId)) throw new BadRequestException('driver_id inválido');
    const corte = this.resolverCorte(desde, hasta);
    const items = (await this.tk.run((trx) => this.items(trx, corte, driverId))).filter((i) => i.estado_viaje !== 'cancelado');
    let persona = items[0]?.persona;
    if (!persona) {
      const d = await this.tk.run((trx) => trx('logistics.drivers').where({ id: driverId }).first('full_name'));
      if (!d) throw new NotFoundException('Persona no encontrada');
      persona = d.full_name;
    }
    return {
      corte, driver_id: driverId, persona: persona as string,
      pagables: items.filter((i) => i.liberado && !i.en_vale),
      retenidos: items.filter((i) => !i.liberado),
      en_vale: items.filter((i) => i.en_vale),
    };
  }

  async crearVale(driverId: string, desde: string | undefined, hasta: string | undefined, actor: string): Promise<ValeCreado> {
    if (!UUID.test(driverId)) throw new BadRequestException('driver_id inválido');
    if (!actor) throw new BadRequestException('No se pudo identificar quién prepara el vale.');
    const tenantId = this.tenantCtx.requireTenantId();
    const det = await this.persona(driverId, desde, hasta);
    const items = det.pagables;
    if (!items.length) throw new ConflictException('Esta persona no tiene viajes ni cargas liberados sin pagar en el corte.');

    const t = totalesPorConcepto(items);
    const importe = Math.round((t.comision + t.viatico + t.maniobra_carga) * 100) / 100;
    const generado = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    // La hoja se genera y se sube ANTES de escribir: si falla, no queda un vale sin respaldo.
    const pdf = await htmlAPdf(htmlHojaDeViajes(det.persona, det.corte, items, actor, generado));
    const { key } = await this.storage.putBuffer(pdf, 'application/pdf', `finance/${tenantId}/expense-proofs`, 'hoja-de-viajes.pdf');
    const concepto = conceptoDelVale(det.persona, det.corte, items);
    const sucursales = items.map((i) => i.kepler_sucursal).filter((s): s is string => !!s);
    const sucursal = moda(sucursales) ?? '00';

    try {
      const vale = await this.tk.run(async (trx) => {
        // Lo que estaba en un vale RECHAZADO deja de estar vigente: se puede volver a pagar.
        await trx('finance.trip_pay_lines as l')
          .whereIn('l.expense_proof_id', trx('finance.expense_proofs').where({ status: 'rechazada' }).select('id'))
          .where({ 'l.driver_id': driverId, 'l.vigente': true })
          .whereIn('l.source_id', items.map((i) => i.source_id))
          .update({ vigente: false, updated_at: trx.fn.now(), updated_by: actor });

        const [p] = await trx('finance.expense_proofs')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            solicitante: det.persona,
            departamento: 'Logística',
            sucursal,
            fecha_gasto: det.corte.hasta,
            folio_solicitud: null,
            proveedor: det.persona,
            importe,
            files: JSON.stringify([{ role: 'comprobante_1', url: key, public_id: key, kind: 'pdf', name: 'hoja-de-viajes.pdf' }]),
            comentarios: concepto,
            comprobacion_nota: concepto,
            clasificacion: 'no_comprobable',
            forma_pago: 'efectivo',
            status: 'recibida',
            created_by: actor,
            evidencia_por: actor,
            evidencia_at: trx.fn.now(),
            capture_meta: JSON.stringify({
              fuente: 'logistica_viajes',
              driver_id: driverId,
              corte: det.corte,
              conceptos: {
                [CONCEPTO_KEPLER.comision.codigo]: t.comision,
                [CONCEPTO_KEPLER.viatico.codigo]: t.viatico,
                [CONCEPTO_KEPLER.maniobra_carga.codigo]: t.maniobra_carga,
              },
            }),
          })
          .returning(['id']);

        await trx('finance.trip_pay_lines').insert(
          items.map((i) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            expense_proof_id: p.id,
            source: i.source,
            source_id: i.source_id,
            shipment_id: i.shipment_id,
            driver_id: driverId,
            concept: i.concept,
            amount: i.amount,
            detail: JSON.stringify({ folio: i.shipment_folio, fecha: i.shipment_date, rol: i.rol, guia: i.kepler_guia }),
            created_by: actor,
            updated_by: actor,
          })),
        );
        return p.id as string;
      });
      this.logger.log(`Vale ${vale} de ${det.persona}: ${items.length} renglones, $${importe} (preparó ${actor})`);
      return { id: vale, importe, renglones: items.length, persona: det.persona };
    } catch (e: unknown) {
      await this.storage.remove(key);
      // El índice único dice que alguno de estos renglones ya entró a otro vale (dos personas a la vez).
      if ((e as { code?: string } | null)?.code === '23505') throw new ConflictException('Alguno de estos viajes ya se pagó en otro vale. Recarga la página.');
      throw e;
    }
  }
}

function moda(xs: string[]): string | null {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of c) if (v > n || (v === n && best !== null && k < best)) { best = k; n = v; }
  return best;
}
