import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  CargaDelEmbarque,
  CargadorRegistrado,
  CargadoresBody,
  CerrarParadaBody,
  CierreDeEmbarque,
  EstadoDeViaje,
  PagoViaje,
  ParadaCierre,
} from '@megadulces/contracts';
import type { BandejaDeViajes, Corte, PersonaDelPadron, TipoParadaKepler, ViajePorCompletar } from '@megadulces/contracts';
import {
  corteDe, erroresDeCargadores, erroresDeCierreDeParada, esFecha, faltasDelViaje, repartoDeCarga,
  TARIFA_CARGA_CAJA_KEY, tipoDeParadaKepler, tipoDelViaje, totalDeCarga,
} from '@megadulces/contracts';
import { CambioRegistrado, tarifaVigenteEl } from '../logistics-config/tarifas-fijas.logic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fila cruda de `logistics.v_trip_stop_closure` (pg devuelve numeric como texto y date como Date). */
type Num = string | number | null;
type Fecha = string | Date | null;
interface FilaParada extends Omit<ParadaCierre, 'value' | 'importe_embarcado' | 'recepcion_importe' | 'recepcion_fecha' | 'diferencia' | 'delivered_at' | 'remision_url'> {
  value: Num;
  importe_embarcado: Num;
  recepcion_importe: Num;
  recepcion_fecha: Fecha;
  diferencia: Num;
  delivered_at: Fecha;
  proof_photo_url: string | null;
  shipment_id: string;
}
/** Fila cruda de `logistics.v_trip_state`. */
interface FilaViaje extends Omit<EstadoDeViaje, 'shipment_date' | 'paradas' | 'paradas_cerradas' | 'paradas_con_diferencia' | 'paradas_pendientes'> {
  shipment_date: Fecha;
  paradas: Num;
  paradas_cerradas: Num;
  paradas_con_diferencia: Num;
  paradas_pendientes: Num;
}
/** Fila cruda de `logistics.v_trip_pay_items`. */
export interface FilaPago extends Omit<PagoViaje, 'shipment_date' | 'amount'> {
  shipment_date: Fecha;
  amount: Num;
}
interface FilaCargador { id: string; driver_id: string; persona: string; rate: Num; pagado: boolean | null }
/** Lo que hace falta del embarque para calcular su carga. */
interface EmbarqueCarga {
  id: string;
  shipment_date: Fecha;
  kepler_sucursal: string | null;
  kepler_guia: string | null;
  boxes_count: Num;
  status?: string;
}
const COLS_EMBARQUE = ['id', 'shipment_date', 'kepler_sucursal', 'kepler_guia', 'boxes_count', 'status'];

/** `[EMB.43]` Filas crudas de la bandeja. */
interface FilaViajeKepler { sucursal: string; guia_embarque: string; fecha: Fecha; paradas: Num; chofer_nombre: string | null; total: Num }
interface FilaParadaKepler { sucursal: string; guia_embarque: string; serie: number | string; cliente_code: string | null; destino_nombre: string | null }
interface FilaSuite {
  shipment_id: string; folio: string; kepler_sucursal: string; kepler_guia: string;
  guide_id: string | null; driver_id: string | null; helper1_id: string | null; helper2_id: string | null;
  departure_time: string | null; arrival_time: string | null; overnight: boolean | null; cargadores: number;
}

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

  /**
   * `[EMB.43]` La bandeja «Por completar»: los viajes de Kepler de la catorcena (traspaso y cliente)
   * con lo que le falta a cada uno para pagarse. El viaje es de Kepler y se lee en vivo
   * (`analytics.erp_shipment_*`, sin copia); de la Suite sólo se lee lo que Kepler no sabe.
   *
   * ⛔ No lee `logistics.v_trip_state`: esa vista calcula el cierre de TODAS las paradas antes de
   * filtrar y se pasó de 60 s en prod (2026-10-24). Lo que falta para pagar (chofer, horario,
   * cargadores) sale directo de la guía y de `load_details`: 14 ms.
   *
   * Medido 8–21 oct 2026: 436 guías, 1,354 paradas; viajes 322 ms + paradas 43 ms.
   */
  async bandeja(desde?: string, hasta?: string, sucursal?: string): Promise<BandejaDeViajes> {
    const corte = this.resolverCorte(desde, hasta);
    if (sucursal != null && sucursal !== '' && !/^[0-9]{2}$/.test(sucursal)) {
      throw new BadRequestException('La sucursal va como su código de Kepler de dos dígitos.');
    }
    const suc = sucursal || null;

    return this.tk.run(async (trx) => {
      const tenant = trx.raw('public.current_tenant_id()');
      const qViajes = trx('analytics.erp_shipment_trips').where('tenant_id', tenant).whereBetween('fecha', [corte.desde, corte.hasta]);
      const qParadas = trx('analytics.erp_shipment_stops').where('tenant_id', tenant).whereBetween('fecha', [corte.desde, corte.hasta]);
      if (suc) { qViajes.where({ sucursal: suc }); qParadas.where({ sucursal: suc }); }
      const [viajes, paradas, personas] = await Promise.all([
        qViajes.select('sucursal', 'guia_embarque', 'fecha', 'paradas', 'chofer_nombre', 'total') as Promise<FilaViajeKepler[]>,
        qParadas.select('sucursal', 'guia_embarque', 'serie', 'cliente_code', 'destino_nombre') as Promise<FilaParadaKepler[]>,
        trx('logistics.drivers').whereNull('deleted_at').where({ active: true, status: 'activo' })
          .orderBy('full_name').select('id', 'full_name', 'roles') as Promise<PersonaDelPadron[]>,
      ]);

      // Tipo y destinos de cada guía, con sus paradas.
      const porGuia = new Map<string, { tipos: TipoParadaKepler[]; destinos: string[] }>();
      for (const p of paradas) {
        const k = `${p.sucursal}|${p.guia_embarque}`;
        const g = porGuia.get(k) ?? { tipos: [], destinos: [] };
        const tipo = tipoDeParadaKepler(p.serie, p.cliente_code);
        g.tipos.push(tipo);
        const nombre = (p.destino_nombre ?? '').trim();
        if (tipo !== 'carga_ruta' && nombre && !g.destinos.includes(nombre)) g.destinos.push(nombre);
        porGuia.set(k, g);
      }

      // Lo que la Suite sabe de esas guías: la hoja, su guía y cuántos cargaron.
      const sucs = viajes.map((v) => v.sucursal);
      const guias = viajes.map((v) => v.guia_embarque);
      const suite = new Map<string, FilaSuite>();
      if (viajes.length) {
        const { rows } = await trx.raw<{ rows: FilaSuite[] }>(
          `SELECT s.id AS shipment_id, s.folio, s.kepler_sucursal, s.kepler_guia,
                  g.id AS guide_id, g.driver_id, g.helper1_id, g.helper2_id,
                  g.departure_time::text AS departure_time, g.arrival_time::text AS arrival_time, g.overnight,
                  (SELECT count(*)::int FROM logistics.load_details l WHERE l.shipment_id = s.id) AS cargadores
             FROM logistics.shipments s
             LEFT JOIN LATERAL (
               SELECT * FROM logistics.delivery_guides g
                WHERE g.shipment_id = s.id AND g.deleted_at IS NULL AND g.status <> 'cancelada'
                ORDER BY g.created_at LIMIT 1
             ) g ON true
            WHERE s.deleted_at IS NULL AND s.status <> 'cancelado' AND s.kepler_guia IS NOT NULL
              AND (s.kepler_sucursal, s.kepler_guia) IN (SELECT x.s, x.g FROM unnest(?::text[], ?::text[]) AS x(s, g))`,
          [sucs, guias],
        );
        for (const r of rows) suite.set(`${r.kepler_sucursal}|${r.kepler_guia}`, r);
      }

      let fueraDeAlcance = 0;
      const filas: ViajePorCompletar[] = [];
      for (const v of viajes) {
        const k = `${v.sucursal}|${v.guia_embarque}`;
        const g = porGuia.get(k);
        const tipo = tipoDelViaje(g?.tipos ?? []);
        if (!tipo) { fueraDeAlcance++; continue; }
        const s = suite.get(k) ?? null;
        filas.push({
          sucursal: v.sucursal,
          guia: v.guia_embarque,
          fecha: dia(v.fecha) as string,
          paradas: Number(v.paradas ?? 0),
          destinos: (g?.destinos ?? []).join(' · '),
          tipo,
          chofer_kepler: v.chofer_nombre?.trim() || null,
          importe: Number(v.total ?? 0),
          shipment_id: s?.shipment_id ?? null,
          shipment_folio: s?.folio ?? null,
          guide_id: s?.guide_id ?? null,
          driver_id: s?.driver_id ?? null,
          helper1_id: s?.helper1_id ?? null,
          helper2_id: s?.helper2_id ?? null,
          departure_time: s?.departure_time?.slice(0, 5) ?? null,
          arrival_time: s?.arrival_time?.slice(0, 5) ?? null,
          overnight: !!s?.overnight,
          cargadores: Number(s?.cargadores ?? 0),
          faltan: faltasDelViaje(s ? { ...s, cargadores: Number(s.cargadores ?? 0) } : null),
        });
      }
      // Lo que más falta, primero; dentro, lo más viejo primero (es lo que ya debería estar).
      filas.sort((a, b) => b.faltan.length - a.faltan.length || a.fecha.localeCompare(b.fecha) || a.guia.localeCompare(b.guia));
      return {
        corte,
        viajes: filas,
        fuera_de_alcance: fueraDeAlcance,
        personas: personas.map((p) => ({ id: p.id, full_name: p.full_name, roles: Array.isArray(p.roles) ? p.roles : [] })),
        leido_at: new Date().toISOString(),
      };
    });
  }

  /** `[EMB.43]` El corte pedido, o la catorcena que va corriendo (la que contiene hoy). */
  private resolverCorte(desde?: string, hasta?: string): Corte {
    if (esFecha(desde) && esFecha(hasta)) {
      if (desde > hasta) throw new BadRequestException('«desde» es posterior a «hasta».');
      return { desde, hasta, pago: corteDe(hasta).pago };
    }
    if (desde || hasta) throw new BadRequestException('Las fechas van como YYYY-MM-DD.');
    return corteDe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }));
  }

  async cierre(shipmentId: string): Promise<CierreDeEmbarque> {
    if (!UUID.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    const datos = await this.tk.run(async (trx) => {
      const s: EmbarqueCarga | undefined = await trx('logistics.shipments')
        .where({ id: shipmentId }).whereNull('deleted_at').first(COLS_EMBARQUE);
      if (!s) throw new NotFoundException('Embarque no encontrado');
      const [viajes, paradas, pagos, cargadores, carga] = await Promise.all([
        trx('logistics.v_trip_state').where({ shipment_id: shipmentId }).orderBy('guide_number'),
        trx('logistics.v_trip_stop_closure')
          .where({ shipment_id: shipmentId })
          .orderByRaw('sequence_order NULLS LAST, kepler_folio NULLS LAST, recipient_id'),
        trx('logistics.v_trip_pay_items').where({ shipment_id: shipmentId }).orderBy(['rol', 'persona', 'concept']),
        this.cargadoresDe(trx, shipmentId),
        this.cargaDe(trx, s),
      ]);
      return { viajes, paradas, pagos, cargadores, carga };
    });

    const paradas: ParadaCierre[] = await Promise.all(
      (datos.paradas as FilaParada[]).map(async (p) => ({
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
      viajes: (datos.viajes as FilaViaje[]).map((v): EstadoDeViaje => ({
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
      pagos: (datos.pagos as FilaPago[]).map(aPagoViaje),
      cargadores: datos.cargadores,
      carga: datos.carga,
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

  /**
   * `[EMB.27]` `[EMB.39]` Quién cargó el embarque. Reemplaza la lista. La carga se paga por caja:
   * cajas del embarque × tarifa vigente el día del embarque, repartido en partes iguales a centavos.
   * Cada renglón guarda con qué cajas y qué tarifa se calculó: cambiar la tarifa después no lo mueve.
   */
  async setCargadores(shipmentId: string, body: CargadoresBody): Promise<CierreDeEmbarque> {
    if (!UUID.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    await this.tk.run(async (trx) => {
      const s: EmbarqueCarga | undefined = await trx('logistics.shipments')
        .where({ id: shipmentId }).whereNull('deleted_at').forUpdate().first(COLS_EMBARQUE);
      if (!s) throw new NotFoundException('Embarque no encontrado');
      if (s.status === 'cancelado') throw new ConflictException('El embarque está cancelado.');

      const carga = await this.cargaDe(trx, s);
      const errs = erroresDeCargadores(body, carga);
      if (errs.length) throw new BadRequestException(errs.join(' '));

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
        const partes = repartoDeCarga(carga.total ?? 0, ids.length);
        await trx('logistics.load_details').insert(
          ids.map((driver_id, i) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            shipment_id: shipmentId,
            driver_id,
            rate: partes[i],
            boxes: carga.cajas,
            rate_per_box: carga.tarifa_por_caja,
            role_at_time: 'cargador',
            created_by: this.actorId(),
          })),
        );
        this.logger.log(`Carga ${shipmentId}: ${carga.cajas} cajas × $${carga.tarifa_por_caja} = $${carga.total} entre ${ids.length} (${this.actor() ?? '?'})`);
      }
    });
    return this.cierre(shipmentId);
  }

  private async cargadoresDe(trx: Knex.Transaction, shipmentId: string): Promise<CargadorRegistrado[]> {
    const rows = await trx('logistics.load_details as ld')
      .join('logistics.drivers as d', 'd.id', 'ld.driver_id')
      .leftJoin('finance.trip_pay_lines as l', function (this: Knex.JoinClause) {
        this.on('l.source_id', '=', 'ld.id').andOn('l.driver_id', '=', 'ld.driver_id')
          .andOn(trx.raw("l.source = 'carga'")).andOn(trx.raw('l.vigente'));
      })
      .leftJoin('finance.expense_proofs as p', 'p.id', 'l.expense_proof_id')
      .where('ld.shipment_id', shipmentId)
      .orderBy('d.full_name')
      .select('ld.id', 'ld.driver_id', 'd.full_name as persona', 'ld.rate',
        trx.raw("(l.id IS NOT NULL AND COALESCE(p.status,'') <> 'rechazada') AS pagado"));
    return (rows as FilaCargador[]).map((r) => ({
      id: r.id, driver_id: r.driver_id, persona: r.persona, rate: Number(r.rate), pagado: !!r.pagado,
    }));
  }

  /** `[EMB.39]` Tarifa vigente el día del embarque × cajas del embarque. */
  private async cargaDe(trx: Knex.Transaction, s: EmbarqueCarga): Promise<CargaDelEmbarque> {
    const [tarifa, cajas] = await Promise.all([this.tarifaCargaEl(trx, dia(s.shipment_date)), this.cajasDe(trx, s)]);
    return {
      tarifa_por_caja: tarifa,
      cajas: cajas?.cajas ?? null,
      fuente_cajas: cajas?.fuente ?? null,
      total: totalDeCarga(cajas?.cajas ?? null, tarifa),
    };
  }

  /**
   * `[EMB.39]` La tarifa por caja que estaba vigente ese día, derivada de `logistics.tariff_changes`
   * (EMB.28.1): un cambio de tarifa aplica desde el día en que se hizo, no hacia atrás.
   */
  private async tarifaCargaEl(trx: Knex.Transaction, diaEmbarque: string | null): Promise<number | null> {
    if (!diaEmbarque) return null;
    const row = await trx('logistics.config_finance').where({ key: TARIFA_CARGA_CAJA_KEY }).first('id', 'value', 'active');
    if (!row) return null;
    const cambios: CambioRegistrado[] = await trx('logistics.tariff_changes')
      .where({ entity: 'config', entity_id: row.id })
      .select('field', 'old_value', 'new_value', 'changed_at');
    return tarifaVigenteEl(row, cambios, diaEmbarque);
  }

  /**
   * `[EMB.39]` Cajas del embarque. Si salió de Kepler: Σ de las cajas (presentación CJA/BTO) de
   * todas las paradas de la guía, leídas en vivo. Si es manual: las capturadas. `null` = no se sabe;
   * un embarque de Kepler con sólo piezas sueltas tiene 0 cajas, que es un dato, no un hueco.
   */
  private async cajasDe(trx: Knex.Transaction, s: EmbarqueCarga): Promise<{ cajas: number; fuente: 'kepler' | 'captura' } | null> {
    if (s.kepler_sucursal && s.kepler_guia) {
      // Dos pasos con constantes, a propósito: un LATERAL contra `erp_shipment_stop_load` no baja
      // serie/folio al índice de kdm2 y recorre TODOS los embarques de la sucursal por parada
      // (medido 2026-10-24: guía de 30 paradas, 1.7–6 s; así, 15 ms con el mismo resultado).
      const paradas: Array<{ serie: number; folio: string }> = await trx('analytics.erp_shipment_stops')
        .where({ sucursal: s.kepler_sucursal, guia_embarque: s.kepler_guia })
        .distinct('serie', 'folio');
      if (!paradas.length) return null;
      const deLaGuia = new Set(paradas.map((p) => `${p.serie}|${p.folio}`));
      const renglones: Array<{ serie: number; folio: string; cajas: Num }> = await trx('analytics.erp_shipment_stop_load')
        .where({ sucursal: s.kepler_sucursal })
        .whereIn('serie', [...new Set(paradas.map((p) => Number(p.serie)))])
        .whereIn('folio', [...new Set(paradas.map((p) => p.folio))])
        .select('serie', 'folio', 'cajas');
      const propios = renglones.filter((r) => deLaGuia.has(`${r.serie}|${r.folio}`));
      // Sin renglones en Kepler, las cajas no se saben (null); con piezas sueltas, son 0 de verdad.
      if (!propios.length) return null;
      return { cajas: propios.reduce((a, r) => a + Number(r.cajas ?? 0), 0), fuente: 'kepler' };
    }
    const capturadas = Number(s.boxes_count ?? 0);
    return capturadas > 0 ? { cajas: capturadas, fuente: 'captura' } : null;
  }

  private async urlDe(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;
    const url = await this.storage.signedUrl(key).catch(() => '');
    return url || null;
  }
}

export function aPagoViaje(r: FilaPago): PagoViaje {
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
