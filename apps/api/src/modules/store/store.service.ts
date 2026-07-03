import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { StoreGateway } from './store.gateway';
import { LiveTicket } from './store.types';

const TENANT = process.env.MEGA_DULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const TZ = 'America/Mexico_City';
const LARGE_TICKET = Number(process.env.STORE_LARGE_TICKET || 3000);

/**
 * Lógica del monitor Tienda: ingesta de tickets (upsert idempotente + emisión WS)
 * y snapshot inicial (KPIs del día + curva horaria + últimos tickets). Lee/escribe
 * analytics.store_live_tickets (sin RLS → tenant explícito).
 */
@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);

  constructor(
    @Inject('STORE_KNEX') private readonly knex: Knex,
    private readonly gateway: StoreGateway,
  ) {}

  async ingest(tickets: LiveTicket[], emit = true): Promise<{ received: number; inserted: number }> {
    if (!Array.isArray(tickets) || !tickets.length) return { received: 0, inserted: 0 };
    let inserted = 0;
    for (const t of tickets) {
      if (!t.warehouse_code || !t.folio || !t.serie || !t.ticket_ts) continue;
      const total = Number(t.total) || 0;
      const row = {
        tenant_id: TENANT,
        warehouse_code: t.warehouse_code,
        warehouse_name: t.warehouse_name || null,
        serie: t.serie,
        folio: t.folio,
        ticket_ts: t.ticket_ts,
        total,
        forma_pago: t.forma_pago || null,
        items: JSON.stringify(Array.isArray(t.items) ? t.items : []),
      };
      let ins: any[] = [];
      try {
        ins = await this.knex('analytics.store_live_tickets')
          .insert(row)
          .onConflict(['tenant_id', 'warehouse_code', 'serie', 'folio'])
          .ignore()
          .returning('id');
      } catch (e: any) {
        this.logger.warn(`ingest insert falló (${t.warehouse_code}/${t.folio}): ${e.message}`);
        continue;
      }
      if (!ins.length) continue; // ya existía (idempotente)
      inserted++;
      if (!emit) continue; // backfill histórico: no emitir por WS
      this.gateway.emitTicket(TENANT, { ...t, total });
      if (total >= LARGE_TICKET) {
        this.gateway.emitAlert(TENANT, {
          type: 'large_ticket',
          severity: 'info',
          title: 'Ticket grande',
          message: `${t.warehouse_name || t.warehouse_code}: $${Math.round(total).toLocaleString('es-MX')}`,
          data: { warehouse_code: t.warehouse_code, folio: t.folio, total },
          emitted_at: new Date().toISOString(),
        });
      }
    }
    return { received: tickets.length, inserted };
  }

  /**
   * Fase LM-K.1 — busca un ticket de venta de Kepler por folio para armar una
   * entrega a domicilio. Valida que la sucursal esté en el allowlist
   * (logistics.home_delivery_warehouses) y devuelve las líneas (qué cargar) +
   * total + forma de pago. Sugiere el flag COD según forma_pago (CONTADO = ya
   * pagado en tienda). Lee del buffer del día (analytics.store_live_tickets).
   */
  async ticketLookup(opts: { folio: string; serie?: string; warehouseCode?: string }): Promise<any> {
    const folio = (opts.folio || '').trim();
    const warehouseCode = (opts.warehouseCode || '').trim();
    const serie = (opts.serie || '').trim();
    if (!folio) throw new BadRequestException('folio requerido');
    if (!warehouseCode) throw new BadRequestException('warehouse (sucursal) requerido');

    return this.knex.transaction(async (trx) => {
      // set_config admite bind param (SET LOCAL x = ? NO — Postgres rechaza params en SET).
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

      // Allowlist: solo sucursales habilitadas para domicilio (piloto 01/02/03).
      const wh = await trx('logistics.home_delivery_warehouses')
        .where({ tenant_id: TENANT, warehouse_code: warehouseCode, enabled: true })
        .first();
      if (!wh)
        throw new ForbiddenException(
          `La sucursal ${warehouseCode} no está habilitada para entrega a domicilio.`,
        );

      let q = trx('analytics.store_live_tickets')
        .where({ tenant_id: TENANT, warehouse_code: warehouseCode, folio });
      if (serie) q = q.andWhere('serie', serie);
      const t = await q.orderBy('ticket_ts', 'desc').first();
      if (!t)
        throw new NotFoundException(
          `Ticket ${warehouseCode}/${serie || '*'}/${folio} no encontrado en la ventana de la tienda.`,
        );

      const items = typeof t.items === 'string' ? JSON.parse(t.items) : t.items || [];
      const alreadyPaid = String(t.forma_pago || '').toUpperCase() === 'CONTADO';
      return {
        warehouse_code: t.warehouse_code,
        warehouse_name: t.warehouse_name,
        serie: t.serie,
        folio: t.folio,
        ticket_ts: t.ticket_ts,
        total: Number(t.total) || 0,
        forma_pago: t.forma_pago,
        items,
        already_paid: alreadyPaid, // CONTADO = pagado en caja → repartidor solo entrega
        collect_on_delivery_suggested: !alreadyPaid, // default del flag COD en la captura
      };
    });
  }

  /**
   * Snapshot del día. `warehouseCode` opcional: si viene (usuario scopeado a
   * sucursal, o filtro del UI), acota TODO al code dado. Vacío = todas.
   */
  async snapshot(warehouseCode?: string): Promise<any> {
    const k = this.knex;
    const today = `(ticket_ts AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`;
    const scope = (q: Knex.QueryBuilder) =>
      warehouseCode ? q.andWhere('warehouse_code', warehouseCode) : q;

    const byBranch = await scope(k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(today))
      .groupBy('warehouse_code', 'warehouse_name')
      .select('warehouse_code', 'warehouse_name')
      .count({ tickets: '*' })
      .sum({ venta: 'total' })
      .max({ last_ts: 'ticket_ts' })
      .orderByRaw('sum(total) DESC NULLS LAST');

    const hourly = await scope(k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(today))
      .select(k.raw(`extract(hour from ticket_ts AT TIME ZONE '${TZ}')::int AS hora`))
      .count({ tickets: '*' })
      .sum({ venta: 'total' })
      .groupByRaw('1')
      .orderByRaw('1');

    // TODOS los tickets de HOY, más nuevo primero (como van saliendo). Tope alto
    // de seguridad: un día pico ronda ~3.5k tickets en las 6 sucursales.
    const recent = await scope(k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(today))
      .orderBy('ticket_ts', 'desc')
      .limit(5000)
      .select(
        'warehouse_code', 'warehouse_name', 'serie', 'folio',
        // ticket_ts en hora MX con offset -06:00 (mismo formato que emite el WS).
        // Sin esto el timestamptz se serializa en UTC y la hora sale +6h corrida.
        k.raw(`to_char(ticket_ts AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '-06:00' AS ticket_ts`),
        'total', 'forma_pago', 'items',
      );

    const totals = byBranch.reduce(
      (a: any, b: any) => ({ tickets: a.tickets + Number(b.tickets), venta: a.venta + Number(b.venta || 0) }),
      { tickets: 0, venta: 0 },
    );

    return {
      generated_at: new Date().toISOString(),
      totals: { ...totals, avg_ticket: totals.tickets ? +(totals.venta / totals.tickets).toFixed(2) : 0 },
      by_branch: byBranch.map((b: any) => ({
        warehouse_code: b.warehouse_code, warehouse_name: b.warehouse_name,
        tickets: Number(b.tickets), venta: Number(b.venta || 0), last_ts: b.last_ts,
      })),
      hourly: hourly.map((h: any) => ({ hora: Number(h.hora), tickets: Number(h.tickets), venta: Number(h.venta || 0) })),
      recent: recent.map((r: any) => ({ ...r, total: Number(r.total) })),
      sockets: this.gateway.getStats(),
    };
  }
}
