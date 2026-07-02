import { Inject, Injectable, Logger } from '@nestjs/common';
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

  async ingest(tickets: LiveTicket[]): Promise<{ received: number; inserted: number }> {
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

  async snapshot(): Promise<any> {
    const k = this.knex;
    const today = `(ticket_ts AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`;

    const byBranch = await k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(today)
      .groupBy('warehouse_code', 'warehouse_name')
      .select('warehouse_code', 'warehouse_name')
      .count({ tickets: '*' })
      .sum({ venta: 'total' })
      .max({ last_ts: 'ticket_ts' })
      .orderByRaw('sum(total) DESC NULLS LAST');

    const hourly = await k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(today)
      .select(k.raw(`extract(hour from ticket_ts AT TIME ZONE '${TZ}')::int AS hora`))
      .count({ tickets: '*' })
      .sum({ venta: 'total' })
      .groupByRaw('1')
      .orderByRaw('1');

    const recent = await k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .orderBy('ticket_ts', 'desc')
      .limit(40)
      .select('warehouse_code', 'warehouse_name', 'serie', 'folio', 'ticket_ts', 'total', 'forma_pago', 'items');

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
