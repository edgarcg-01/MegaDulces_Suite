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
import { LabelPricesChanged, LiveTicket } from './store.types';
import { composeFreshness, evalInput, tableAt } from '@megadulces/platform-core';

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
    // commercial.warehouses tiene RLS FORCE y el ingest es @Public (sin interceptor de tenant):
    // seteamos el contexto en la MISMA tx para que la lectura no vuelva vacía si el rol es app_runtime.
    const rows: Array<{ id: string; code: string | null; kepler_code: string | null }> =
      await this.knex.transaction(async (trx) => {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        // await antes del return: devolver el QueryBuilder tal cual hace que knex
        // tipe la transacción como `void | T[]` y el build no compila (TS2322).
        const rows = await trx('commercial.warehouses')
          .where({ tenant_id: TENANT })
          .whereNull('deleted_at')
          .select('id', 'code', 'kepler_code');
        return rows;
      });
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.code) m.set(String(r.code).trim(), r.id);
      if (r.kepler_code) m.set(String(r.kepler_code).trim(), r.id);
    }
    if (m.size) { this.whMap = m; this.whMapAt = Date.now(); } // no cachear vacío (RLS/transitorio)
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
   * `[TDA.1]` — Reemite por WS el aviso de que cambiaron precios de etiqueta.
   *
   * No escribe nada: el precio ya lo escribió `feeds-ingest` antes de avisar. Acá sólo se valida la
   * forma y se empuja al room del tenant.
   *
   * El `tenant_id` se acepta del body pero se **ignora si no es el nuestro**: el endpoint es
   * `@Public()` con llave de máquina, así que quien tenga la llave no debería poder emitirle a otro
   * tenant. Con un solo tenant real esto es una guarda barata, no una restricción.
   */
  notifyLabelPricesChanged(body: {
    tenant_id?: string;
    product_ids?: string[];
    total?: number;
    truncated?: boolean;
    at?: string;
  }): { emitted: boolean; product_ids: number; total: number; truncated: boolean } {
    const ids = Array.from(
      new Set((Array.isArray(body?.product_ids) ? body.product_ids : []).filter((x) => typeof x === 'string' && x.length > 0)),
    );
    const tenant = body?.tenant_id && body.tenant_id !== TENANT ? null : TENANT;
    if (!tenant) {
      this.logger.warn(`label-prices-changed para un tenant ajeno (${body?.tenant_id}): se ignora.`);
      return { emitted: false, product_ids: 0, total: 0, truncated: false };
    }
    // Un aviso sin ids no dice nada útil: la pantalla no sabría qué refrescar y un banner sin
    // motivo se aprende a ignorar. Se descarta explícito en vez de emitir ruido.
    if (!ids.length) return { emitted: false, product_ids: 0, total: Number(body?.total) || 0, truncated: false };

    const total = Number.isFinite(Number(body?.total)) && Number(body?.total) > 0 ? Number(body?.total) : ids.length;
    const truncated = body?.truncated === true || total > ids.length;
    const payload: LabelPricesChanged = {
      product_ids: ids,
      total,
      truncated,
      at: typeof body?.at === 'string' ? body.at : new Date().toISOString(),
    };
    this.gateway.emitLabelPricesChanged(tenant, payload);
    this.logger.log(`label_prices_changed → ${ids.length} producto(s)${truncated ? ` (de ${total}, recortado)` : ''}`);
    return { emitted: true, product_ids: ids.length, total, truncated };
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
   * Snapshot del día. `warehouseCodes` es el alcance ya resuelto por
   * `ScopeService` (`[AUTHZ-HARD.3]`):
   *   - `null`  → alcance `all` sin filtro pedido → TODAS las sucursales.
   *   - `[...]` → exactamente esas (código de 2 dígitos).
   *   - `[]`    → alcance `none`/recorte vacío → NINGUNA (fail-closed, `WHERE 1=0`).
   * La distinción `null` vs `[]` es la que mata el viejo fail-open: antes "vacío"
   * significaba "todas"; ahora sólo `null` es "todas".
   */
  async snapshot(warehouseCodes?: string[] | null): Promise<any> {
    const k = this.knex;
    const today = `(ticket_ts AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`;
    const scope = (q: Knex.QueryBuilder) =>
      warehouseCodes !== null && warehouseCodes !== undefined
        ? q.whereIn('warehouse_code', warehouseCodes)
        : q;

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

    // TDA.P — palancas de la política comercial (partidas y unidades por ticket).
    // Se calcula en SQL sobre TODOS los renglones del día, no sobre el ticker del
    // navegador, que está topado (5000 acá / 6000 en el cliente) y daría una muestra.
    const lineAgg = await this.lineLevers(warehouseCodes);

    const totals = byBranch.reduce(
      (a: any, b: any) => ({ tickets: a.tickets + Number(b.tickets), venta: a.venta + Number(b.venta || 0) }),
      { tickets: 0, venta: 0 },
    );

    /**
     * [VP.2.2] Frescura del tablero en vivo. La señal es **cuándo llegó el último ticket**
     * (`max(created_at)` = cuándo lo recibimos, no la hora de la venta), y sufre la misma
     * ambigüedad que las cajas: "cero tickets" puede ser una tienda tranquila o un feed muerto.
     *
     * Tolerancia 45 min, el mismo número con el que este dominio ya juzga su feed en `feed.sospechoso`
     * — un solo umbral para las dos superficies en vez de dos criterios que se separan.
     *
     * Barato a propósito: medido con EXPLAIN ANALYZE en prod, `max(created_at)` sobre
     * `store_live_tickets` (224 MB) ejecuta en **59 ms** aun siendo Seq Scan, así que no necesita
     * índice ni se le pone uno (ver `20260908150000_freshness_max_idx`).
     */
    const freshness = composeFreshness([
      evalInput('store_live_tickets', 'Último ticket recibido',
        await tableAt(this.knex, 'analytics.store_live_tickets', 'created_at'), 0.75),
    ]);

    return {
      generated_at: new Date().toISOString(),
      freshness,
      totals: { ...totals, avg_ticket: totals.tickets ? +(totals.venta / totals.tickets).toFixed(2) : 0 },
      by_branch: byBranch.map((b: any) => ({
        warehouse_code: b.warehouse_code, warehouse_name: b.warehouse_name,
        tickets: Number(b.tickets), venta: Number(b.venta || 0), last_ts: b.last_ts,
        lines: lineAgg.by_branch[b.warehouse_code] || null,
      })),
      hourly: hourly.map((h: any) => ({ hora: Number(h.hora), tickets: Number(h.tickets), venta: Number(h.venta || 0) })),
      recent: recent.map((r: any) => ({ ...r, total: Number(r.total) })),
      lines: lineAgg.totals,
      sockets: this.gateway.getStats(),
    };
  }

  /**
   * TDA.P — Partidas y unidades del día, por sucursal y en total.
   *
   * La política comercial se apoya en dos descomposiciones EXACTAS de la venta:
   *   Venta = Tickets × (Partidas/ticket) × (Valor/partida)
   *   Venta = Tickets × (Unidades/ticket) × (Valor/unidad)
   *
   * **Partidas y su valor son exactos**: un renglón es un renglón, y el numerador
   * sale del `importe` de los mismos renglones que se cuentan (medido: Σ importe de
   * renglones == Σ total de tickets).
   *
   * **Las unidades NO se pueden sumar crudas.** `cant` viene en el peldaño realmente
   * vendido y un mismo SKU con el mismo rótulo se vende en pieza Y en paquete
   * (`UNIDADES_DE_MEDIDA.md` §7: el 70031 a $6.12 la pieza y a $90.96 el paquete de 16).
   * Sumar crudo subcuenta — medido sobre 200k renglones reales de mostrador (`U-D-10`):
   * **1.63%** de subconteo, 99.73% de los renglones resueltos. Así que el peldaño se
   * identifica por el **precio realmente cobrado** contra la escalera del ERP
   * (`analytics.v_product_unit_ladder`: `p1/p2/p3` con factores `1/f2/f3`), eligiendo el
   * más cercano en log-espacio y **sólo dentro de la banda 0.5×–2×**. Los peldaños distan
   * ≥2×, mucho más que cualquier descuento, así que la banda no confunde uno con otro.
   *
   * Fuera de banda **no se adivina**: el renglón queda sin resolver, no se suma, y se
   * reporta en `unresolved_lines` / `coverage_pct` para que la pantalla lo declare
   * (ADR-056: lo que no se pudo medir se declara, no se dibuja como cero).
   */
  private async lineLevers(warehouseCodes?: string[] | null): Promise<{ totals: any; by_branch: Record<string, any> }> {
    const scoped = warehouseCodes !== null && warehouseCodes !== undefined;
    // Alcance vacío = no ve nada (fail-closed, misma semántica que `snapshot`).
    if (scoped && !warehouseCodes!.length) {
      return { totals: this.emptyLevers('sin_alcance'), by_branch: {} };
    }
    try {
      const { rows } = await this.knex.raw(
        `WITH lineas AS (
           SELECT t.warehouse_code,
                  (it->>'sku')              AS sku,
                  (it->>'cant')::numeric    AS cant,
                  (it->>'importe')::numeric AS importe
             FROM analytics.store_live_tickets t
             CROSS JOIN LATERAL jsonb_array_elements(t.items) it
            WHERE t.tenant_id = ?
              AND (t.ticket_ts AT TIME ZONE ?)::date = (now() AT TIME ZONE ?)::date
              ${scoped ? 'AND t.warehouse_code = ANY(?)' : ''}
         ),
         res AS (
           SELECT l.warehouse_code, l.cant, l.importe, rung.factor
             FROM lineas l
             LEFT JOIN analytics.v_product_unit_ladder pl ON pl.sku = l.sku
             LEFT JOIN LATERAL (
               SELECT r.factor
                 FROM (VALUES (1::numeric, pl.p1), (pl.f2, pl.p2), (pl.f3, pl.p3)) AS r(factor, price)
                WHERE r.price IS NOT NULL AND r.price > 0
                  AND r.factor IS NOT NULL AND r.factor > 0
                  AND l.cant > 0 AND l.importe > 0
                  AND abs(ln((l.importe / l.cant) / r.price)) <= ln(2)
                ORDER BY abs(ln((l.importe / l.cant) / r.price))
                LIMIT 1
             ) rung ON TRUE
         )
         SELECT warehouse_code,
                count(*)::int                                              AS lines,
                sum(importe)                                               AS amount,
                count(*) FILTER (WHERE factor IS NOT NULL)::int            AS resolved_lines,
                sum(cant * factor) FILTER (WHERE factor IS NOT NULL)       AS units_base,
                sum(importe)       FILTER (WHERE factor IS NOT NULL)       AS resolved_amount
           FROM res
          GROUP BY warehouse_code`,
        scoped ? [TENANT, TZ, TZ, warehouseCodes] : [TENANT, TZ, TZ],
      );

      const by_branch: Record<string, any> = {};
      const acc = { lines: 0, amount: 0, resolved_lines: 0, units_base: 0, resolved_amount: 0 };
      for (const r of rows as any[]) {
        const row = {
          lines: Number(r.lines) || 0,
          amount: Number(r.amount) || 0,
          resolved_lines: Number(r.resolved_lines) || 0,
          units_base: Number(r.units_base) || 0,
          resolved_amount: Number(r.resolved_amount) || 0,
        };
        by_branch[r.warehouse_code] = this.shapeLevers(row);
        acc.lines += row.lines; acc.amount += row.amount;
        acc.resolved_lines += row.resolved_lines;
        acc.units_base += row.units_base; acc.resolved_amount += row.resolved_amount;
      }
      return { totals: this.shapeLevers(acc), by_branch };
    } catch (e: any) {
      // La escalera vive sobre `kepler_ods.kdii`: si el ODS no está en este entorno la
      // pantalla NO se cae — las unidades se declaran `no_medido` y las partidas, que no
      // dependen de la escalera, se pierden también acá a propósito (un agregado a medias
      // que no sabe decir de dónde salió miente más que un hueco declarado).
      this.logger.warn(`Palancas de partidas/unidades no disponibles: ${e?.message || e}`);
      return { totals: this.emptyLevers('escalera_no_disponible'), by_branch: {} };
    }
  }

  /** Ratios derivados + la declaración de con qué se midieron (ADR-056). */
  private shapeLevers(r: { lines: number; amount: number; resolved_lines: number; units_base: number; resolved_amount: number }) {
    const covered = r.lines > 0 ? (100 * r.resolved_lines) / r.lines : 0;
    return {
      lines: r.lines,
      amount: +r.amount.toFixed(2),
      // Valor por partida: exacto — dinero e importe salen de los MISMOS renglones.
      amount_per_line: r.lines ? +(r.amount / r.lines).toFixed(2) : 0,
      // Unidades con el peldaño resuelto. `null` = no se pudo medir, NUNCA 0.
      units: r.resolved_lines ? +r.units_base.toFixed(2) : null,
      // Valor unitario sobre el MISMO subconjunto que resolvió unidades (si no, miente).
      amount_per_unit: r.resolved_lines && r.units_base > 0 ? +(r.resolved_amount / r.units_base).toFixed(2) : null,
      unresolved_lines: r.lines - r.resolved_lines,
      coverage_pct: +covered.toFixed(2),
      method: r.lines === 0 ? 'sin_datos' : r.resolved_lines ? 'peldano_por_precio' : 'no_medido',
    };
  }

  private emptyLevers(method: string) {
    return {
      lines: 0, amount: 0, amount_per_line: 0,
      units: null, amount_per_unit: null,
      unresolved_lines: 0, coverage_pct: 0, method,
    };
  }

  // ── TDA.R — ritmo semanal/mensual (baseline para comparar el día) ─────
  private rhythmCache = new Map<string, { at: number; data: any }>();
  private static readonly RHYTHM_TTL_MS = 30 * 60 * 1000; // el baseline cambia una vez al día
  private static readonly RHYTHM_WINDOW = 30;             // días que se traen del ODS

  /**
   * Ritmo de referencia: las mismas razones del día, promediadas sobre los últimos
   * 7 y 30 días. Sirve para responder "¿hoy vamos mejor o peor de lo normal?".
   *
   * **De dónde sale.** NO de `analytics.store_live_tickets`: ese buffer se limpia a los
   * 3 días, así que no puede sostener una semana ni un mes. Sale del ODS
   * (`kepler_ods.kdm1` ⋈ `kdm2`, documentos `U-D-10`), que es la fuente canónica del
   * dato del ERP y tiene historia desde ene-2025.
   *
   * **Se compara contra la misma ventana horaria.** Sólo entran los tickets emitidos
   * hasta la hora actual, porque el día de hoy va a medias: comparar media jornada
   * contra jornadas completas castigaría a hoy por la mañana y lo premiaría al cierre.
   * (Medido: mueve las razones poco — partidas/ticket 3.04 → 3.08 a 7 días — pero es
   * la comparación honesta y no cuesta nada.)
   *
   * **Y mide su propia base.** Un día al que el feed no llegó no es un día de venta
   * floja: es un día que no sabemos. Si la ventana no junta suficientes días completos,
   * el baseline se declara `no_medido` y la pantalla NO dibuja un delta. Vivido: al
   * consultar esto, al ODS le faltaban 4 días seguidos y otros 3 venían a un cuarto de
   * su volumen — un "vs. semana" ingenuo habría publicado un desplome inventado.
   */
  async rhythm(warehouseCodes?: string[] | null): Promise<any> {
    const key = warehouseCodes === null || warehouseCodes === undefined ? 'all' : [...warehouseCodes].sort().join(',');
    const hit = this.rhythmCache.get(key);
    if (hit && Date.now() - hit.at < StoreService.RHYTHM_TTL_MS) return hit.data;

    const data = await this.computeRhythm(warehouseCodes);
    this.rhythmCache.set(key, { at: Date.now(), data });
    return data;
  }

  private async computeRhythm(warehouseCodes?: string[] | null): Promise<any> {
    const scoped = warehouseCodes !== null && warehouseCodes !== undefined;
    if (scoped && !warehouseCodes!.length) {
      return {
        week: this.emptyRhythm(7, 'sin_alcance'),
        month: this.emptyRhythm(30, 'sin_alcance'),
        dow: { ...this.emptyRhythm(28, 'sin_alcance'), dow: this.todayDow(), occurrences: 0 },
        hourly: { dow: null, week: null, month: null },
        generated_at: new Date().toISOString(),
      };
    }
    try {
      const { rows } = await this.knex.raw(
        `WITH cab AS (
           SELECT h.sucursal, h.c9::date AS dia, h.c1,h.c2,h.c3,h.c4,h.c5,h.c6
             FROM kepler_ods.kdm1 h
            WHERE h.c2='U' AND h.c3='D' AND h.c4=10
              AND h.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
              AND h.c9::date >= (now() AT TIME ZONE ?)::date - ?::int
              AND h.c9::date <  (now() AT TIME ZONE ?)::date
              AND h.c62::time <= (now() AT TIME ZONE ?)::time
              ${scoped ? 'AND h.sucursal = ANY(?)' : ''}
         ),
         tick AS (SELECT dia, sucursal AS suc, count(*)::int AS tickets FROM cab GROUP BY dia, sucursal),
         lin AS (
           SELECT cab.dia, cab.sucursal AS suc, d.c8 AS sku,
                  coalesce(d.c9,0)::numeric AS cant, coalesce(d.c13,0)::numeric AS importe
             FROM cab
             JOIN kepler_ods.kdm2 d
               ON d.sucursal=cab.sucursal AND d.c1=cab.c1 AND d.c2=cab.c2 AND d.c3=cab.c3
              AND d.c4=cab.c4 AND d.c5=cab.c5 AND d.c6=cab.c6
            WHERE btrim(d.c8) <> '' AND d.c8 NOT IN ('00001','00002')
         ),
         res AS (
           SELECT l.dia, l.suc, l.cant, l.importe, rung.factor
             FROM lin l
             LEFT JOIN analytics.v_product_unit_ladder pl ON pl.sku = l.sku
             LEFT JOIN LATERAL (
               SELECT r.factor
                 FROM (VALUES (1::numeric, pl.p1), (pl.f2, pl.p2), (pl.f3, pl.p3)) AS r(factor, price)
                WHERE r.price IS NOT NULL AND r.price > 0
                  AND r.factor IS NOT NULL AND r.factor > 0
                  AND l.cant > 0 AND l.importe > 0
                  AND abs(ln((l.importe / l.cant) / r.price)) <= ln(2)
                ORDER BY abs(ln((l.importe / l.cant) / r.price))
                LIMIT 1
             ) rung ON TRUE
         )
         SELECT t.dia::text                                                  AS dia,
                t.suc                                                        AS suc,
                t.tickets                                                    AS tickets,
                count(r.*)::int                                              AS lines,
                coalesce(sum(r.importe),0)                                   AS amount,
                count(r.*) FILTER (WHERE r.factor IS NOT NULL)::int          AS resolved_lines,
                coalesce(sum(r.cant*r.factor) FILTER (WHERE r.factor IS NOT NULL),0) AS units_base,
                coalesce(sum(r.importe)       FILTER (WHERE r.factor IS NOT NULL),0) AS resolved_amount
           FROM tick t LEFT JOIN res r ON r.dia = t.dia AND r.suc = t.suc
          GROUP BY t.dia, t.suc, t.tickets
          ORDER BY t.dia DESC`,
        scoped
          ? [TZ, StoreService.RHYTHM_WINDOW, TZ, TZ, warehouseCodes]
          : [TZ, StoreService.RHYTHM_WINDOW, TZ, TZ],
      );

      const filas = (rows as any[]).map((r) => ({
        dia: String(r.dia).slice(0, 10),
        suc: String(r.suc ?? '').trim(),
        tickets: Number(r.tickets) || 0,
        lines: Number(r.lines) || 0,
        amount: Number(r.amount) || 0,
        resolved_lines: Number(r.resolved_lines) || 0,
        units_base: Number(r.units_base) || 0,
        resolved_amount: Number(r.resolved_amount) || 0,
      }));

      // La red = la suma de las sucursales, día por día.
      const red = [...filas.reduce((m, f) => {
        const a = m.get(f.dia) || { dia: f.dia, tickets: 0, lines: 0, amount: 0, resolved_lines: 0, units_base: 0, resolved_amount: 0 };
        a.tickets += f.tickets; a.lines += f.lines; a.amount += f.amount;
        a.resolved_lines += f.resolved_lines; a.units_base += f.units_base; a.resolved_amount += f.resolved_amount;
        m.set(f.dia, a); return m;
      }, new Map<string, any>()).values()].sort((a, b) => (a.dia < b.dia ? 1 : -1));

      const porSuc = new Map<string, any[]>();
      for (const f of filas) {
        if (!f.suc) continue;
        if (!porSuc.has(f.suc)) porSuc.set(f.suc, []);
        porSuc.get(f.suc)!.push(f);
      }

      const horas = await this.rhythmHourlyRaw(warehouseCodes);
      const redOut = this.buildWindows(red, horas, null);
      const by_branch: Record<string, any> = {};
      for (const [suc, ds] of porSuc) by_branch[suc] = this.buildWindows(ds, horas, suc);

      return { ...redOut, by_branch, generated_at: new Date().toISOString() };
    } catch (e: any) {
      this.logger.warn(`Ritmo (baseline semanal/mensual) no disponible: ${e?.message || e}`);
      return {
        week: this.emptyRhythm(7, 'ods_no_disponible'),
        month: this.emptyRhythm(30, 'ods_no_disponible'),
        dow: { ...this.emptyRhythm(28, 'ods_no_disponible'), dow: this.todayDow(), occurrences: 0 },
        hourly: { dow: null, week: null, month: null },
        generated_at: new Date().toISOString(),
      };
    }
  }

  /** Día de la semana de HOY en hora MX (0=domingo), no en la del servidor. */
  private todayDow(): number {
    return new Date(Date.now() - 6 * 3600e3).getUTCDay();
  }

  /**
   * Curva de venta POR HORA de cada ritmo, para poner de referencia sobre la del día.
   * Responde "a esta hora, ¿normalmente cuánto llevábamos?".
   *
   * Sale sólo de las cabeceras (`kdm1.c16` = total del ticket): no necesita los
   * renglones, así que es una consulta barata al lado de la de las razones.
   *
   * ⚠️ **A diferencia de las razones, acá NO se recorta a la hora actual.** La curva
   * de referencia tiene que mostrar el día entero: la gracia es ver lo que todavía
   * falta, no sólo lo que ya pasó.
   *
   * Una hora sin ventas en un día cuenta como CERO, no se excluye — si no, las horas
   * muertas se verían tan altas como las buenas por promediar sólo los días en que hubo
   * movimiento.
   */
  private async rhythmHourlyRaw(warehouseCodes?: string[] | null): Promise<any[]> {
    const scoped = warehouseCodes !== null && warehouseCodes !== undefined;
    try {
      const { rows } = await this.knex.raw(
        `SELECT h.c9::date::text                                AS dia,
                h.sucursal                                      AS suc,
                substring(h.c62 from '^[0-9]{1,2}')::int        AS hora,
                count(*)::int                                   AS tickets,
                coalesce(sum(h.c16),0)                          AS venta
           FROM kepler_ods.kdm1 h
          WHERE h.c2='U' AND h.c3='D' AND h.c4=10
            AND h.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
            AND h.c9::date >= (now() AT TIME ZONE ?)::date - ?::int
            AND h.c9::date <  (now() AT TIME ZONE ?)::date
            ${scoped ? 'AND h.sucursal = ANY(?)' : ''}
          GROUP BY 1, 2, 3`,
        scoped
          ? [TZ, StoreService.RHYTHM_WINDOW, TZ, warehouseCodes]
          : [TZ, StoreService.RHYTHM_WINDOW, TZ],
      );
      return (rows as any[]).map((r) => ({
        dia: String(r.dia).slice(0, 10),
        suc: String(r.suc ?? '').trim(),
        hora: Number(r.hora),
        tickets: Number(r.tickets) || 0,
        venta: Number(r.venta) || 0,
      }));
    } catch (e: any) {
      this.logger.warn(`Curva horaria de referencia no disponible: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * Arma las tres ventanas (día de la semana / 7 / 30) + sus curvas horarias para UNA
   * serie: la red entera, o una sola sucursal.
   *
   * La utilidad de cada día se decide **dentro de la serie**, con su propia mediana. Una
   * sucursal chica no es un día incompleto de la red: si se juzgara a todas con el
   * umbral de la red, las tiendas de menor volumen quedarían descartadas siempre.
   */
  private buildWindows(dias: any[], horasRaw: any[], suc: string | null) {
    const orden = dias.map((d) => d.tickets).sort((a: number, b: number) => a - b);
    const mediana = orden.length ? orden[Math.floor(orden.length / 2)] : 0;
    const umbral = mediana * 0.5;
    for (const d of dias) d.usable = d.tickets > 0 && d.tickets >= umbral;

    const week = this.shapeRhythm(dias, 7, mediana);
    const month = this.shapeRhythm(dias, 30, mediana);
    const dow = this.shapeRhythmDow(dias, mediana);

    const usables = new Set(dias.filter((d) => d.usable).map((d) => d.dia));
    const porDia = new Map<string, Map<number, { tickets: number; venta: number }>>();
    for (const r of horasRaw) {
      if (suc !== null && r.suc !== suc) continue;
      if (!usables.has(r.dia)) continue;
      if (!porDia.has(r.dia)) porDia.set(r.dia, new Map());
      const m = porDia.get(r.dia)!;
      const prev = m.get(r.hora);
      // Sin filtro de sucursal las filas de todas se acumulan en la misma hora.
      m.set(r.hora, { tickets: (prev?.tickets || 0) + r.tickets, venta: (prev?.venta || 0) + r.venta });
    }

    const hoy = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
    const dowIdx = this.todayDow();
    const desde = (n: number) => new Date(Date.now() - 6 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
    const perfil = (filtro: (dia: string) => boolean, win: any) => {
      if (!win || win.method !== 'ods_u_d_10') return null;
      const dds = [...porDia.keys()].filter(filtro);
      if (!dds.length) return null;
      return Array.from({ length: 17 }, (_, i) => {
        const hora = i + 6;
        let venta = 0, tickets = 0;
        for (const d of dds) {
          const h = porDia.get(d)!.get(hora);
          if (h) { venta += h.venta; tickets += h.tickets; }
        }
        return { hora, venta: +(venta / dds.length).toFixed(2), tickets: +(tickets / dds.length).toFixed(2) };
      });
    };

    return {
      week, month, dow,
      hourly: {
        dow: perfil((d) => d < hoy && new Date(d + 'T12:00:00Z').getUTCDay() === dowIdx, dow),
        week: perfil((d) => d >= desde(7) && d < hoy, week),
        month: perfil((d) => d >= desde(30) && d < hoy, month),
      },
    };
  }

  /**
   * Ritmo del MISMO día de la semana: los últimos 4 miércoles si hoy es miércoles.
   *
   * En retail el día de la semana manda —un sábado no se parece a un martes—, así que
   * comparar el día en curso contra un promedio de 30 días que mezcla ambos castiga o
   * premia por el calendario, no por la operación. Este baseline aísla ese efecto.
   *
   * Sale de los MISMOS días que ya trajo la consulta de 30 (4 semanas = 28 días), así
   * que no cuesta una query extra. Pide 3 de 4 ocurrencias utilizables: con dos, un
   * solo día flojo mueve el promedio 50% y el "vs." deja de significar algo.
   */
  private shapeRhythmDow(dias: any[], mediana: number) {
    const dow = this.todayDow();
    const hoy = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
    const mismos = dias
      .filter((d) => d.dia < hoy && new Date(d.dia + 'T12:00:00Z').getUTCDay() === dow)
      .sort((a, b) => (a.dia < b.dia ? 1 : -1))
      .slice(0, 4);
    const usables = mismos.filter((d) => d.usable);

    const acc = usables.reduce(
      (a, d) => ({
        tickets: a.tickets + d.tickets, lines: a.lines + d.lines, amount: a.amount + d.amount,
        resolved_lines: a.resolved_lines + d.resolved_lines,
        units_base: a.units_base + d.units_base, resolved_amount: a.resolved_amount + d.resolved_amount,
      }),
      { tickets: 0, lines: 0, amount: 0, resolved_lines: 0, units_base: 0, resolved_amount: 0 },
    );

    if (usables.length < 3 || !acc.tickets) {
      return {
        ...this.emptyRhythm(28, mismos.length ? 'ventana_incompleta' : 'sin_datos'),
        dow,
        occurrences: mismos.length,
        days_used: usables.length,
        days_missing: 4 - mismos.length,
        days_partial: mismos.length - usables.length,
      };
    }
    return {
      window_days: 28,
      dow,
      occurrences: mismos.length,
      days_used: usables.length,
      days_missing: 4 - mismos.length,
      days_partial: mismos.length - usables.length,
      median_tickets: mediana,
      tickets_per_day: +(acc.tickets / usables.length).toFixed(2),
      lines_per_ticket: +(acc.lines / acc.tickets).toFixed(4),
      amount_per_line: acc.lines ? +(acc.amount / acc.lines).toFixed(2) : 0,
      amount_per_ticket: +(acc.amount / acc.tickets).toFixed(2),
      units_per_ticket: acc.resolved_lines ? +(acc.units_base / acc.tickets).toFixed(4) : null,
      amount_per_unit: acc.units_base > 0 ? +(acc.resolved_amount / acc.units_base).toFixed(2) : null,
      coverage_pct: acc.lines ? +((100 * acc.resolved_lines) / acc.lines).toFixed(2) : 0,
      method: 'ods_u_d_10',
    };
  }

  /** Promedia SOLO los días utilizables de la ventana y declara cuántos fueron. */
  private shapeRhythm(dias: any[], ventana: number, mediana: number) {
    const hoy = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
    const desde = new Date(Date.now() - 6 * 3600e3 - ventana * 86400e3).toISOString().slice(0, 10);
    const enVentana = dias.filter((d) => d.dia >= desde && d.dia < hoy);
    const usables = enVentana.filter((d) => d.usable);

    const acc = usables.reduce(
      (a, d) => ({
        tickets: a.tickets + d.tickets, lines: a.lines + d.lines, amount: a.amount + d.amount,
        resolved_lines: a.resolved_lines + d.resolved_lines,
        units_base: a.units_base + d.units_base, resolved_amount: a.resolved_amount + d.resolved_amount,
      }),
      { tickets: 0, lines: 0, amount: 0, resolved_lines: 0, units_base: 0, resolved_amount: 0 },
    );

    // Con menos del 70% de la ventana no se publica una comparación: un promedio de 3
    // días no es "el ritmo de la semana", y presentarlo como tal es peor que no tenerlo.
    const suficiente = usables.length >= Math.ceil(ventana * 0.7);
    if (!suficiente || !acc.tickets) {
      return {
        ...this.emptyRhythm(ventana, enVentana.length ? 'ventana_incompleta' : 'sin_datos'),
        days_used: usables.length,
        days_missing: ventana - enVentana.length,
        days_partial: enVentana.length - usables.length,
      };
    }
    return {
      window_days: ventana,
      days_used: usables.length,
      days_missing: ventana - enVentana.length,
      days_partial: enVentana.length - usables.length,
      median_tickets: mediana,
      tickets_per_day: +(acc.tickets / usables.length).toFixed(2),
      lines_per_ticket: +(acc.lines / acc.tickets).toFixed(4),
      amount_per_line: acc.lines ? +(acc.amount / acc.lines).toFixed(2) : 0,
      amount_per_ticket: +(acc.amount / acc.tickets).toFixed(2),
      units_per_ticket: acc.resolved_lines ? +(acc.units_base / acc.tickets).toFixed(4) : null,
      amount_per_unit: acc.units_base > 0 ? +(acc.resolved_amount / acc.units_base).toFixed(2) : null,
      coverage_pct: acc.lines ? +((100 * acc.resolved_lines) / acc.lines).toFixed(2) : 0,
      method: 'ods_u_d_10',
    };
  }

  private emptyRhythm(ventana: number, method: string) {
    return {
      window_days: ventana, days_used: 0, days_missing: ventana, days_partial: 0,
      median_tickets: 0, tickets_per_day: null,
      lines_per_ticket: null, amount_per_line: null, amount_per_ticket: null,
      units_per_ticket: null, amount_per_unit: null, coverage_pct: 0, method,
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
  /**
   * `warehouses`: alcance ya resuelto (`ScopeService`). `null` = sin filtro
   * (alcance `all`); `[]` = no ve ninguna sucursal → tablero vacío, no un 403:
   * son 3 KPIs y una tabla, y un error rompe la pantalla entera.
   */
  async openSessions(warehouses?: string[] | null): Promise<any> {
    const vacio = Array.isArray(warehouses) && warehouses.length === 0;
    const filtrar = Array.isArray(warehouses) && warehouses.length > 0;
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
    if (filtrar) actQ.whereIn('warehouse_code', warehouses as string[]);
    if (vacio) actQ.whereRaw('false');
    const act = await actQ;
    const actMap = new Map(act.map((a: any) => [`${a.warehouse_code}|${a.caja}`, a]));

    /**
     * SM.13 — La venta del día también sale de Kepler (ODS), no solo del poller.
     *
     * `store_live_tickets` lo llena un poller aparte: si se cae, la página decía
     * "$0 vendido" con las cajas cobrando — un cero que parece un dato. El ODS trae
     * los documentos de venta (`kdm1` U/D/10, `c5`=caja, `c16`=total) por el mismo
     * CDC que todo lo demás. **Verificado contra el corte de Kepler**: por caja
     * reproduce `venta_total` al centavo (suc01 caja2 $74,642.11, caja3 $35,601.40,
     * caja4 $24,887.48).
     *
     * Se toma el MAYOR de las dos fuentes por caja, no una u otra: las dos miden lo
     * mismo (la venta acumulada del día, que solo crece) y cada una puede ir
     * rezagada — el mayor es simplemente la menos vieja. El poller sigue mandando
     * en "último ticket"/"cobrando ahora", donde lo que importa son los segundos.
     */
    const odsQ = this.knex('kepler_ods.kdm1')
      .whereRaw(`c2 = 'U' AND c3 = 'D' AND c4 = 10`)
      .andWhereRaw(`c9::date = ${todayMX}`)
      .whereNotNull('c5')
      .groupBy('sucursal', k.raw('c5::bigint::text'))
      .select(
        k.raw('sucursal AS warehouse_code'),
        // `c5` es NUMERIC en el ODS y `cash_sessions.caja` es TEXT: sin castear, el
        // cruce por llave compuesta erra en silencio (un '1.0' no matchea a '1').
        k.raw('c5::bigint::text AS caja'),
        k.raw('COUNT(*)::int AS tickets'),
        k.raw('ROUND(SUM(c16::numeric), 2) AS venta'),
      );
    if (filtrar) odsQ.whereIn('sucursal', warehouses as string[]);
    if (vacio) odsQ.whereRaw('false');
    // El ODS puede no estar disponible (entorno sin CDC): degradar al poller, no romper.
    const ods: any[] = await odsQ.catch((e: any) => {
      this.logger.warn(`venta por caja desde el ODS no disponible: ${e?.message || e}`);
      return [];
    });
    const odsMap = new Map(ods.map((o: any) => [`${o.warehouse_code}|${o.caja}`, o]));

    const sesQ = k('analytics.cash_sessions as s')
      .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
        this.on('pc.tenant_id', '=', 's.tenant_id').andOn('pc.warehouse_code', '=', 's.warehouse_code').andOn('pc.cajero_code', '=', 's.cajero_code');
      })
      /**
       * SM.13.2 — Abierta es abierta, aunque haya abierto ayer.
       *
       * Esto filtraba `business_date = hoy`, así que una caja que abrió ayer y
       * **nunca se cerró** desaparecía del monitor — justo la que más hay que
       * mirar. Medido en la data: 14 sesiones en `open` y la pantalla mostrando 0,
       * una de ellas arrastrada desde hacía dos días.
       *
       * La ventana son 2 días porque es la que refresca `import-cash-sessions`
       * (lee las aperturas recientes): más atrás no re-verifica, y una sesión que
       * se cerró en Kepler fuera de esa ventana se quedaría marcada abierta para
       * siempre. Mostrar solo lo que el importer confirma evita inventar cajas.
       */
      .where('s.tenant_id', TENANT).where('s.status', 'open')
      .andWhereRaw(`s.business_date >= (${todayMX} - INTERVAL '2 days')`)
      .select('s.warehouse_code', 's.warehouse_name', 's.caja', 's.cajero_code',
        k.raw('pc.nombre AS cajero_nombre'),
        k.raw(`to_char(s.opened_at AT TIME ZONE '${TZ}', 'HH24:MI') AS abrio`), 's.opened_at',
        k.raw('s.business_date::text AS desde_dia'),
        // Días que lleva abierta. >0 = quedó de un día anterior: nadie la cerró.
        k.raw(`((${todayMX}) - s.business_date)::int AS dias_abierta`))
      .orderBy('s.warehouse_code').orderBy('s.caja');
    if (filtrar) sesQ.whereIn('s.warehouse_code', warehouses as string[]);
    if (vacio) sesQ.whereRaw('false');
    const sesiones = await sesQ;

    const NOW = Date.now();
    const open_cajas = sesiones.map((s: any) => {
      const key = `${s.warehouse_code}|${s.caja}`;
      const a: any = actMap.get(key);
      const o: any = odsMap.get(key);
      const lastMs = a?.last_ts ? new Date(a.last_ts).getTime() : null;
      const idleMin = lastMs != null ? Math.round((NOW - lastMs) / 60000) : null;
      return {
        warehouse_code: s.warehouse_code, warehouse_name: s.warehouse_name, caja: s.caja,
        cajero: s.cajero_code, cajero_nombre: s.cajero_nombre || null, abrio: s.abrio,
        // Una caja arrastrada de un día anterior es una incidencia por sí sola.
        desde_dia: s.desde_dia, dias_abierta: Number(s.dias_abierta) || 0,
        arrastrada: (Number(s.dias_abierta) || 0) > 0,
        // El mayor de poller y ODS: los dos son prefijos de la misma venta del día.
        tickets: Math.max(a ? Number(a.tickets) : 0, o ? Number(o.tickets) : 0),
        venta: Math.max(a ? Number(a.venta) : 0, o ? Number(o.venta) : 0),
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

    /**
     * SM.13.1 — Salud del feed: para que un cero nunca sea mudo.
     *
     * "0 cajas abiertas" tiene dos causas opuestas y hasta ahora se veían igual:
     * la tienda está cerrada, o **dejamos de recibir datos de Kepler**. En ago-2026
     * el CDC estuvo congelado 2 días con la tarea en `Running` y nadie se enteró;
     * durante esas 48 h esta pantalla habría dicho "no hay cajas abiertas" y todo
     * el mundo lo habría creído. Se devuelven dos relojes distintos:
     *
     *   `al`         — cuándo corrió por última vez el importer (¿nos llegan datos?)
     *   `ultimo_dia` — el día más reciente del que sabemos algo (¿son de hoy?)
     *
     * El importer puede estar corriendo puntual y aun así traer el día equivocado si
     * el CDC que lo alimenta se quedó atrás — por eso hacen falta los dos.
     */
    const feedQ = this.knex('analytics.cash_sessions')
      .where('tenant_id', TENANT)
      .select(
        k.raw('MAX(updated_at) AS al'),
        k.raw('MAX(business_date)::text AS ultimo_dia'),
        k.raw(`(${todayMX})::text AS hoy`),
      )
      .first();
    if (filtrar) feedQ.whereIn('warehouse_code', warehouses as string[]);
    const f: any = (await feedQ.catch(() => null)) || {};
    const alMs = f.al ? new Date(f.al).getTime() : null;
    const minutos = alMs != null ? Math.round((NOW - alMs) / 60000) : null;
    const atrasado = !!(f.ultimo_dia && f.hoy && f.ultimo_dia < f.hoy);

    /**
     * [VP.2.2] El MISMO hecho, en el vocabulario común. `feed` (arriba) es la vista de dominio y es
     * MEJOR que la genérica: distingue "la tienda está cerrada" de "dejamos de recibir datos", y la
     * pantalla la usa para cambiar hasta el texto del empty-state. No se toca.
     *
     * Lo que faltaba es que ese hecho se pudiera leer sin conocer este dominio: `freshness` es el
     * contrato que cualquier consumidor ya entiende (ADR-056). Se compone de los **mismos dos
     * valores** que alimentan `feed` (`f.al` y `atrasado`), así que no pueden discrepar — si algún
     * día lo hacen, es un bug, no una diferencia de criterio. Es la lección de las 11 copias del
     * dedup: dos campos que dicen lo mismo se separan salvo que salgan del mismo cálculo.
     *
     * Los dos relojes son los dos eslabones, y el peor gana el titular:
     *   · carga (45 min) — el mismo umbral con el que `sospechoso` ya juzga este feed.
     *   · día de los datos — su veredicto NO sale de una tolerancia horaria sino de `atrasado`
     *     (comparación de CALENDARIO): a la 01:00, "ayer" tiene 25 h y una tolerancia de 26 h lo
     *     daría por fresco cuando el dato ya no es de hoy.
     */
    const freshness = composeFreshness([
      evalInput('store_cash_sessions', 'Cajas (carga del importer)', f.al || null, 0.75),
      {
        key: 'store_business_day',
        label: 'Día de los datos',
        at: f.ultimo_dia ? `${f.ultimo_dia}T00:00:00Z` : null,
        age_human: f.ultimo_dia || null,
        status: !f.ultimo_dia ? 'unknown' : atrasado ? 'stale' : 'fresh',
        stale: !f.ultimo_dia || atrasado,
      },
    ]);

    return {
      generated_at: new Date().toISOString(),
      freshness,
      cajas_abiertas: open_cajas.length,
      cobrando_ahora: open_cajas.filter((c: any) => c.cobrando).length,
      // Cajas que nadie cerró al terminar el día. Se cuentan aparte: no son
      // actividad de hoy, son un pendiente operativo.
      arrastradas: open_cajas.filter((c: any) => c.arrastrada).length,
      open_cajas,
      // compat: el frontend consume `cajeros_sin_sesion`; ahora es por caja.
      cajeros_sin_sesion: cajas_sin_sesion,
      feed: {
        al: f.al || null,
        minutos,
        ultimo_dia: f.ultimo_dia || null,
        hoy: f.hoy || null,
        // Sin noticias en 45 min, o el último día conocido no es hoy: el cero es dudoso.
        sospechoso: minutos == null || minutos > 45 || atrasado,
        atrasado,
      },
    };
  }
}
