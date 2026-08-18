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

  // Normalización ALMACÉN Paso 2b: map warehouse_code → warehouse_id (uuid) cacheado 15min.
  // Incluye kepler_code (Canindo '06' → MD-50) para que el poller poble warehouse_id inline.
  private whMap: Map<string, string> | null = null;
  private whMapAt = 0;
  private async warehouseMap(): Promise<Map<string, string>> {
    if (this.whMap && Date.now() - this.whMapAt < 15 * 60 * 1000) return this.whMap;
    const rows = await this.knex('commercial.warehouses')
      .where({ tenant_id: TENANT }).whereNull('deleted_at')
      .select('id', 'code', 'kepler_code');
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.code) m.set(String(r.code).trim(), r.id);
      if (r.kepler_code) m.set(String(r.kepler_code).trim(), r.id);
    }
    this.whMap = m; this.whMapAt = Date.now();
    return m;
  }

  async ingest(tickets: LiveTicket[], emit = true): Promise<{ received: number; inserted: number }> {
    if (!Array.isArray(tickets) || !tickets.length) return { received: 0, inserted: 0 };
    const whMap = await this.warehouseMap();
    let inserted = 0;
    for (const t of tickets) {
      if (!t.warehouse_code || !t.folio || !t.serie || !t.ticket_ts) continue;
      const total = Number(t.total) || 0;
      const row = {
        tenant_id: TENANT,
        warehouse_code: t.warehouse_code,
        warehouse_id: whMap.get(String(t.warehouse_code).trim()) || null,
        warehouse_name: t.warehouse_name || null,
        serie: t.serie,
        folio: t.folio,
        ticket_ts: t.ticket_ts,
        total,
        forma_pago: t.forma_pago || null,
        cajero: t.cajero || null,
        caja: t.caja || null,
        items: JSON.stringify(Array.isArray(t.items) ? t.items : []),
      };
      let ins: any[] = [];
      try {
        // Upsert idempotente: en conflicto ACTUALIZA los campos de datos (sana un ticket
        // re-empujado con mejor info, p.ej. descripcion de producto que antes venia vacia).
        // (xmax = 0) => fue alta real -> solo entonces contamos e emitimos (no spam en re-seed).
        ins = await this.knex('analytics.store_live_tickets')
          .insert(row)
          .onConflict(['tenant_id', 'warehouse_code', 'serie', 'folio'])
          .merge({
            warehouse_id: row.warehouse_id,
            warehouse_name: row.warehouse_name,
            ticket_ts: row.ticket_ts,
            total: row.total,
            forma_pago: row.forma_pago,
            cajero: row.cajero,
            caja: row.caja,
            items: row.items,
          })
          .returning(['id', this.knex.raw('(xmax = 0) AS is_new')]);
      } catch (e: any) {
        this.logger.warn(`ingest insert falló (${t.warehouse_code}/${t.folio}): ${e.message}`);
        continue;
      }
      const isNew = ins.length && (ins[0].is_new === true || ins[0].is_new === 't');
      if (!isNew) continue; // ya existía: solo se actualizaron los datos, no contamos ni emitimos
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

    try {
      return await this.knex.transaction(async (trx) => {
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
    } catch (error) {
      // Knex ya hizo rollback automático de la transacción al propagarse la
      // excepción fuera del callback. Re-lanzamos tal cual para que el filtro
      // de excepciones de Nest la traduzca al status HTTP correcto.
      throw error;
    }
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

    // Sucursales ACTIVAS en los últimos 7 días con su último ticket real (para detectar
    // "sin conexión": una caja que vendía y dejó de reportar NO debe desaparecer del tablero,
    // sino aparecer con su last_ts stale). Se fusiona con las de hoy (tickets=0 si no hay hoy).
    const recentBranches = await scope(k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(`ticket_ts > now() - interval '7 days'`))
      .groupBy('warehouse_code', 'warehouse_name')
      .select('warehouse_code', 'warehouse_name')
      .max({ last_ts: 'ticket_ts' });
    const todayCodes = new Set(byBranch.map((b: any) => b.warehouse_code));
    for (const r of recentBranches as any[]) {
      if (!todayCodes.has(r.warehouse_code)) {
        byBranch.push({ warehouse_code: r.warehouse_code, warehouse_name: r.warehouse_name, tickets: 0, venta: 0, last_ts: r.last_ts });
      }
    }

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

  /**
   * SM.10 — Cajas ABIERTAS ahora + quién está cobrando. Atribución POR CAJA:
   *  - `analytics.cash_sessions` (status=open, hoy) da qué CAJA está abierta, la hora de
   *    apertura y el cajero ASIGNADO (`cajero_code` = kdpv c8; NO el c7/opener, que suele
   *    ser un supervisor que abre todas las cajas).
   *  - `analytics.store_live_tickets` de hoy, agrupado por (sucursal, CAJA) (kdm1.c5),
   *    da tickets/venta/último ticket de esa caja. Antes se cruzaba por cajero → el total
   *    del supervisor se duplicaba en cada caja que abrió (bug ago-2026).
   * `cobrando` = ticket en los últimos 15 min.
   */
  async openSessions(warehouseCode?: string): Promise<any> {
    const k = this.knex;
    const todayMX = `(now() AT TIME ZONE '${TZ}')::date`;

    // Actividad por CAJA (una fila por caja): agregado + último cajero que cobró ahí.
    const actQ = k('analytics.store_live_tickets')
      .where('tenant_id', TENANT)
      .andWhereRaw(`(ticket_ts AT TIME ZONE '${TZ}')::date = ${todayMX}`)
      .whereNotNull('caja')
      .distinctOn('warehouse_code', 'caja')
      .select('warehouse_code', 'caja',
        k.raw('COUNT(*) OVER (PARTITION BY warehouse_code, caja)::int AS tickets'),
        k.raw('ROUND(SUM(total) OVER (PARTITION BY warehouse_code, caja)::numeric,2) AS venta'),
        k.raw(`to_char(MAX(ticket_ts) OVER (PARTITION BY warehouse_code, caja) AT TIME ZONE '${TZ}', 'HH24:MI') AS last_ticket`),
        k.raw('MAX(ticket_ts) OVER (PARTITION BY warehouse_code, caja) AS last_ts'),
        k.raw('cajero AS last_cajero'))
      .orderBy([{ column: 'warehouse_code' }, { column: 'caja' }, { column: 'ticket_ts', order: 'desc' }]);
    if (warehouseCode) actQ.andWhere('warehouse_code', warehouseCode);
    const act = await actQ;
    const actMap = new Map(act.map((a: any) => [`${a.warehouse_code}|${a.caja}`, a]));

    const sesQ = k('analytics.cash_sessions as s')
      .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
        this.on('pc.tenant_id', '=', 's.tenant_id').andOn('pc.warehouse_code', '=', 's.warehouse_code').andOn('pc.cajero_code', '=', 's.cajero_code');
      })
      .where('s.tenant_id', TENANT).where('s.status', 'open').andWhereRaw(`s.business_date = ${todayMX}`)
      .select('s.warehouse_code', 's.warehouse_name', 's.caja', 's.cajero_code',
        k.raw('pc.nombre AS cajero_nombre'),
        k.raw(`to_char(s.opened_at AT TIME ZONE '${TZ}', 'HH24:MI') AS abrio`), 's.opened_at')
      .orderBy('s.warehouse_code').orderBy('s.caja');
    if (warehouseCode) sesQ.andWhere('s.warehouse_code', warehouseCode);
    const sesiones = await sesQ;

    const NOW = Date.now();
    const open_cajas = sesiones.map((s: any) => {
      const a: any = actMap.get(`${s.warehouse_code}|${s.caja}`);
      const lastMs = a?.last_ts ? new Date(a.last_ts).getTime() : null;
      const idleMin = lastMs != null ? Math.round((NOW - lastMs) / 60000) : null;
      return {
        warehouse_code: s.warehouse_code, warehouse_name: s.warehouse_name, caja: s.caja,
        cajero: s.cajero_code, cajero_nombre: s.cajero_nombre || null, abrio: s.abrio,
        tickets: a ? Number(a.tickets) : 0, venta: a ? Number(a.venta) : 0,
        last_ticket: a?.last_ticket || null, idle_min: idleMin,
        cobrando: idleMin != null && idleMin <= 15,
      };
    })
      // Ranking: quien más vende hoy arriba (rank 1 = top). Empate por tickets.
      .sort((x: any, y: any) => y.venta - x.venta || y.tickets - x.tickets)
      .map((c: any, i: number) => ({ ...c, rank: i + 1 }));

    // Cajas con venta hoy pero SIN sesión abierta (ya cerró la caja / handoff).
    const linked = new Set(sesiones.map((s: any) => `${s.warehouse_code}|${s.caja}`));
    const cajas_sin_sesion = act
      .filter((a: any) => !linked.has(`${a.warehouse_code}|${a.caja}`))
      .map((a: any) => ({ warehouse_code: a.warehouse_code, caja: a.caja, cajero: a.last_cajero, tickets: Number(a.tickets), venta: Number(a.venta), last_ticket: a.last_ticket }))
      .sort((x: any, y: any) => y.venta - x.venta || y.tickets - x.tickets);

    return {
      generated_at: new Date().toISOString(),
      cajas_abiertas: open_cajas.length,
      cobrando_ahora: open_cajas.filter((c: any) => c.cobrando).length,
      open_cajas,
      // compat: el frontend consume `cajeros_sin_sesion`; ahora es por caja.
      cajeros_sin_sesion: cajas_sin_sesion,
    };
  }
}
