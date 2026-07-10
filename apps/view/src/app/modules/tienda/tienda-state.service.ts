import { Injectable, computed, inject, signal } from '@angular/core';
import { StoreSocketService, LiveTicket, StoreAlert, StoreBranchKpi } from './store-socket.service';
import { AuthService } from '../../core/services/auth.service';
import { STORE_BRANCHES, branchName } from '../../core/constants/store-branches';

/**
 * Estado compartido del apartado Tienda (Monitor / Sucursales / Ritmo).
 * Una sola conexión WS + un solo snapshot para las 3 páginas: navegar entre
 * ellas NO reconecta ni re-baja datos. Refcount con desconexión debounced al
 * salir del apartado. Ver [[project_proyecto_tienda_live]].
 */
@Injectable({ providedIn: 'root' })
export class TiendaStateService {
  private readonly svc = inject(StoreSocketService);
  private readonly auth = inject(AuthService);

  readonly connected = this.svc.connected;
  readonly branchList = STORE_BRANCHES;
  readonly branchName = branchName;

  readonly ventaHoy = signal(0);
  readonly ticketsHoy = signal(0);
  readonly branches = signal<StoreBranchKpi[]>([]);
  readonly hourly = signal<Record<number, { venta: number; tickets: number }>>({});
  readonly ticker = signal<LiveTicket[]>([]);
  readonly alerts = signal<StoreAlert[]>([]);
  readonly selectedBranch = signal<string>(''); // filtro global ('' = todas)
  scopedWarehouse = ''; // sucursal fija por login ('' = rol global)

  private readonly open = signal<Set<string>>(new Set());
  private readonly seen = new Set<string>();
  private static readonly MAX_TICKER = 6000;

  private subscribed = false;
  private loadedOnce = false;
  private stale = false;
  private refs = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  readonly avgTicket = computed(() => (this.ticketsHoy() ? this.ventaHoy() / this.ticketsHoy() : 0));
  readonly activeBranches = computed(() => this.branches().filter((b) => b.tickets > 0).length);
  readonly hourBars = computed(() => this.buildHourBars(this.hourly()));

  private tkKey(t: LiveTicket): string { return t.warehouse_code + t.serie + t.folio; }

  /** ngOnInit de cada página. Conecta 1 vez y comparte estado. */
  enter(): void {
    this.refs++;
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    this.svc.connect();
    if (!this.subscribed) {
      this.subscribed = true;
      this.scopedWarehouse = this.auth.user()?.warehouse_code || '';
      if (this.scopedWarehouse) this.selectedBranch.set(this.scopedWarehouse);
      this.svc.ticket$.subscribe((t) => this.applyTicket(t));
      this.svc.alert$.subscribe((a) => this.alerts.update((l) => [a, ...l].slice(0, 25)));
    }
    if (!this.loadedOnce || this.stale) { this.loadedOnce = true; this.stale = false; this.loadSnapshot(); }
  }

  /** ngOnDestroy de cada página. Desconecta (debounced) al salir del apartado. */
  leave(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) {
      this.disconnectTimer = setTimeout(() => { this.svc.disconnect(); this.stale = true; }, 1000);
    }
  }

  changeBranch(code: string): void {
    if (this.scopedWarehouse) return;      // scopeado: no puede cambiar
    if (code === this.selectedBranch()) return;
    this.selectedBranch.set(code);
    this.ticker.set([]); this.seen.clear();
    this.loadSnapshot();
  }

  private loadSnapshot(): void {
    this.svc.snapshot(this.selectedBranch() || undefined).subscribe({
      next: (s) => {
        this.ventaHoy.set(s.totals.venta);
        this.ticketsHoy.set(s.totals.tickets);
        this.branches.set(s.by_branch);
        const hy: Record<number, { venta: number; tickets: number }> = {};
        for (const h of s.hourly) hy[h.hora] = { venta: h.venta, tickets: h.tickets };
        this.hourly.set(hy);
        this.seen.clear();
        for (const t of s.recent) this.seen.add(this.tkKey(t));
        this.ticker.set(s.recent);
      },
      error: () => undefined,
    });
  }

  private applyTicket(t: LiveTicket): void {
    const sel = this.selectedBranch();
    if (sel && t.warehouse_code !== sel) return;
    const key = this.tkKey(t);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.ticker.update((list) => [t, ...list].slice(0, TiendaStateService.MAX_TICKER));
    this.ventaHoy.update((v) => v + (t.total || 0));
    this.ticketsHoy.update((n) => n + 1);
    this.branches.update((list) => {
      const i = list.findIndex((b) => b.warehouse_code === t.warehouse_code);
      if (i === -1) return [...list, { warehouse_code: t.warehouse_code, warehouse_name: t.warehouse_name || t.warehouse_code, tickets: 1, venta: t.total || 0, last_ts: t.ticket_ts }];
      const copy = [...list];
      copy[i] = { ...copy[i], tickets: copy[i].tickets + 1, venta: copy[i].venta + (t.total || 0), last_ts: t.ticket_ts };
      return copy.sort((a, b) => b.venta - a.venta);
    });
    const hora = Number(t.ticket_ts.slice(11, 13));
    this.hourly.update((h) => ({ ...h, [hora]: { venta: (h[hora]?.venta || 0) + (t.total || 0), tickets: (h[hora]?.tickets || 0) + 1 } }));
  }

  // ── Derivados por sucursal (del ticker en memoria = todo el día) ──
  /** Curva horaria 6..22 a partir de un mapa hora→{venta,tickets}. */
  private buildHourBars(h: Record<number, { venta: number; tickets: number }>) {
    const hrs = Array.from({ length: 17 }, (_, i) => i + 6);
    const max = Math.max(1, ...hrs.map((x) => h[x]?.venta || 0));
    return hrs.map((hora) => ({ hora, venta: h[hora]?.venta || 0, tickets: h[hora]?.tickets || 0, pct: Math.round(((h[hora]?.venta || 0) / max) * 100) }));
  }
  /** Tickets del día de una sucursal (más nuevo primero). */
  ticketsOf(code: string): LiveTicket[] { return this.ticker().filter((t) => t.warehouse_code === code); }
  /** Curva horaria de una sucursal, derivada del ticker. */
  hourBarsOf(code: string) {
    const acc: Record<number, { venta: number; tickets: number }> = {};
    for (const t of this.ticker()) {
      if (t.warehouse_code !== code) continue;
      const hh = Number(t.ticket_ts.slice(11, 13));
      (acc[hh] ||= { venta: 0, tickets: 0 }).venta += t.total || 0;
      acc[hh].tickets++;
    }
    return this.buildHourBars(acc);
  }

  // ── Palancas de crecimiento (3 pilares) ──────────────────────────
  // Venta = Tickets × Ticket promedio ; Ticket promedio = Productos/ticket × Precio prom.
  // Unidades/líneas se derivan del ticker (trae items de todo el día). Si un día
  // supera el tope del ticker, el ratio queda como muestra representativa (los
  // pilares Tickets y Ticket promedio siguen exactos porque salen de `branches`).
  private itemsAgg(tickets: LiveTicket[]): { units: number; lines: number; n: number } {
    let units = 0, lines = 0;
    for (const t of tickets) {
      const its = t.items || [];
      lines += its.length;
      for (const it of its) units += it.cant || 0;
    }
    return { units, lines, n: tickets.length };
  }

  /** Promedios de la RED (benchmark relativo para el coaching por tienda). */
  readonly networkLevers = computed(() => {
    const bs = this.branches();
    const tickets = bs.reduce((s, b) => s + b.tickets, 0);
    const venta = bs.reduce((s, b) => s + b.venta, 0);
    const a = this.itemsAgg(this.ticker());
    const active = bs.filter((b) => b.tickets > 0).length || 1;
    return {
      tickets,
      ticketsPerStore: tickets / active,
      ticketProm: tickets ? venta / tickets : 0,
      unitsPerTicket: a.n ? a.units / a.n : 0,
      linesPerTicket: a.n ? a.lines / a.n : 0,
    };
  });

  /** Las 3 palancas de una tienda + índice vs red + cuál debe subir. */
  leversOf(code: string) {
    const b = this.branches().find((x) => x.warehouse_code === code);
    const a = this.itemsAgg(this.ticketsOf(code));
    const net = this.networkLevers();
    const tickets = b?.tickets ?? 0;
    const ticketProm = tickets ? (b!.venta / tickets) : 0;
    const unitsPerTicket = a.n ? a.units / a.n : 0;
    const linesPerTicket = a.n ? a.lines / a.n : 0;
    const idx = {
      tickets: net.ticketsPerStore ? tickets / net.ticketsPerStore : 1,
      ticketProm: net.ticketProm ? ticketProm / net.ticketProm : 1,
      unitsPerTicket: net.unitsPerTicket ? unitsPerTicket / net.unitsPerTicket : 1,
    };
    const items = [
      { key: 'tickets', label: 'Tickets', short: 'Tickets', value: tickets, idx: idx.tickets },
      { key: 'ticketProm', label: 'Ticket promedio', short: '$/tkt', value: ticketProm, idx: idx.ticketProm },
      { key: 'unitsPerTicket', label: 'Productos/ticket', short: 'Prod/tkt', value: unitsPerTicket, idx: idx.unitsPerTicket },
    ];
    const weakest = items.reduce((m, e) => (e.idx < m.idx ? e : m), items[0]);
    // gap vs red en % (negativo = por debajo)
    const gapPct = Math.round((weakest.idx - 1) * 100);
    return { tickets, ticketProm, unitsPerTicket, linesPerTicket, idx, items, weakest, gapPct };
  }

  toggle(t: LiveTicket): void {
    const key = this.tkKey(t);
    this.open.update((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  isOpen(t: LiveTicket): boolean { return this.open().has(this.tkKey(t)); }

  hora(ts: string): string { return ts.slice(11, 16); }
  idleMin(ts: string): number { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 60000) : 9999; }
  lastLabel(ts: string): string { const m = this.idleMin(ts); return m >= 9999 ? '—' : m <= 0 ? 'ahora' : `hace ${m} min`; }
}
