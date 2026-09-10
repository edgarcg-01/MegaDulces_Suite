import { Injectable, computed, inject, signal } from '@angular/core';
import { StoreSocketService, LiveTicket, StoreAlert, StoreBranchKpi, StoreLineLevers, StoreRhythm, StoreRhythmWindow } from './store-socket.service';
import { AuthService } from '../../core/services/auth.service';
import { LIVE_MONITOR_BRANCHES, branchName } from '../../core/constants/store-branches';

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
  readonly branchList = LIVE_MONITOR_BRANCHES;
  readonly branchName = branchName;

  readonly ventaHoy = signal(0);
  readonly ticketsHoy = signal(0);
  readonly branches = signal<StoreBranchKpi[]>([]);
  readonly hourly = signal<Record<number, { venta: number; tickets: number }>>({});
  readonly ticker = signal<LiveTicket[]>([]);
  readonly alerts = signal<StoreAlert[]>([]);
  readonly selectedBranch = signal<string>(''); // filtro global ('' = todas)
  readonly error = signal(false); // §6: falla del snapshot ≠ "sin ventas"
  scopedWarehouse = ''; // sucursal fija por login ('' = rol global)

  // ── TDA.P — palancas de la política comercial ────────────────────────
  // Partidas y su importe se llevan VIVOS: el ticket que entra por WS trae sus
  // renglones, así que `partidas`/`importePartidas` siguen exactos sin re-consultar.
  readonly partidasHoy = signal(0);
  readonly importePartidas = signal(0);
  /** Unidades del snapshot (peldaño resuelto en SQL). NO se puede resolver en el navegador. */
  readonly levers = signal<StoreLineLevers | null>(null);
  /** Tickets al momento del snapshot — el divisor honesto de `unidadesPorTicket`. */
  readonly leversTickets = signal(0);
  /** Hora del servidor del snapshot que produjo las unidades (no el reloj del navegador). */
  readonly leversAt = signal<string>('');
  private leversByBranch: Record<string, StoreLineLevers> = {};

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

  // ── Las 3 palancas de la política: Venta = Tickets × Partidas/tkt × Valor/partida ──
  /** Renglones por ticket. EXACTO y vivo (contar renglones no necesita la escalera). */
  readonly partidasPorTicket = computed(() => (this.ticketsHoy() ? this.partidasHoy() / this.ticketsHoy() : 0));
  /** Valor por renglón. EXACTO: numerador y denominador salen de los mismos renglones. */
  readonly valorPorPartida = computed(() => (this.partidasHoy() ? this.importePartidas() / this.partidasHoy() : 0));

  // ── Lente de unidades (del snapshot: el peldaño se resuelve en SQL) ──
  /**
   * Unidades por ticket, con el peldaño resuelto. Se divide por los tickets que había
   * AL MOMENTO del snapshot, no por los de ahora: mezclar un numerador viejo con un
   * denominador vivo haría bajar el ratio solo porque entraron tickets.
   */
  readonly unidadesPorTicket = computed(() => {
    const l = this.levers();
    const t = this.leversTickets();
    return l?.units != null && t ? l.units / t : null;
  });
  /** Valor unitario promedio, sobre el mismo subconjunto de renglones que resolvió unidades. */
  readonly valorUnitario = computed(() => this.levers()?.amount_per_unit ?? null);
  /** % de renglones con peldaño resuelto — se declara, no se esconde (ADR-056). */
  readonly unidadesCobertura = computed(() => this.levers()?.coverage_pct ?? 0);
  readonly unidadesMedidas = computed(() => this.levers()?.method === 'peldano_por_precio');

  // ── TDA.R — comparación contra el ritmo semanal / mensual ────────────
  readonly rhythm = signal<StoreRhythm | null>(null);
  /**
   * Contra qué se compara hoy. Arranca en `dow` (mismo día de la semana) porque es la
   * comparación menos engañosa en retail: aísla el efecto del calendario.
   */
  readonly baseline = signal<'week' | 'month' | 'dow'>('dow');
  readonly baselineWin = computed<StoreRhythmWindow | null>(() => {
    const r = this.rhythm();
    return r ? r[this.baseline()] : null;
  });
  /** ¿La ventana elegida junta días suficientes para comparar? */
  readonly baselineOk = computed(() => this.baselineWin()?.method === 'ods_u_d_10');

  /**
   * Delta % de hoy contra el ritmo, por métrica. `null` = no se compara — porque la
   * ventana no alcanzó, o porque hoy todavía no tiene esa cifra. Un `null` NO se
   * dibuja como 0%: eso diría "vamos igual que siempre", que es una afirmación.
   */
  readonly deltas = computed(() => {
    const b = this.baselineWin();
    const pct = (hoy: number | null | undefined, base: number | null | undefined): number | null =>
      hoy != null && base != null && base > 0 ? +(((hoy / base) - 1) * 100).toFixed(1) : null;
    if (!b || b.method !== 'ods_u_d_10') {
      return { tickets: null, lines: null, amountLine: null, ticket: null, units: null, unit: null };
    }
    return {
      tickets:    pct(this.ticketsHoy(),         b.tickets_per_day),
      lines:      pct(this.partidasPorTicket(),  b.lines_per_ticket),
      amountLine: pct(this.valorPorPartida(),    b.amount_per_line),
      ticket:     pct(this.avgTicket(),          b.amount_per_ticket),
      units:      pct(this.unidadesPorTicket(),  b.units_per_ticket),
      unit:       pct(this.valorUnitario(),      b.amount_per_unit),
    };
  });

  /** Por qué no hay comparación, en llano. */
  /**
   * Ritmo de UNA sucursal (mismas 3 ventanas + curvas horarias). `null` si el servidor
   * no lo mandó o esa tienda no tiene días suficientes por sí sola — el umbral se
   * calcula con SU mediana, no con la de la red: una tienda chica no es un día roto.
   */
  branchRhythm(code: string): StoreRhythm | null {
    const b = (this.rhythm() as any)?.by_branch?.[code];
    return b ? { ...b, generated_at: this.rhythm()!.generated_at } : null;
  }

  /** Nombre del día de la semana de hoy, para rotular la comparación (es-MX). */
  readonly dowLabel = computed(() => {
    const d = this.rhythm()?.dow?.dow;
    if (d == null) return 'Día';
    // 2026-02-01 fue domingo: sirve de ancla para nombrar el índice sin tocar "hoy".
    const ancla = new Date(Date.UTC(2026, 1, 1 + d, 12));
    const n = ancla.toLocaleDateString('es-MX', { weekday: 'long' });
    return n.charAt(0).toUpperCase() + n.slice(1);
  });

  baselineWhy(): string {
    const b = this.baselineWin();
    const k = this.baseline();
    // "los últimos N días", no "la semana"/"el mes": la ventana es MÓVIL, no calendario.
    const cual = k === 'week' ? 'los últimos 7 días'
      : k === 'month' ? 'los últimos 30 días'
      : `los ${this.dowLabel().toLowerCase()}s anteriores`;
    if (!b) return 'Cargando el ritmo…';
    switch (b.method) {
      case 'ods_u_d_10': return '';
      case 'ventana_incompleta':
        return k === 'dow'
          ? `No se puede comparar contra ${cual}: de los últimos 4 sólo ${b.days_used} llegaron completos`
            + `${b.days_missing ? ` (faltan ${b.days_missing})` : ''}${b.days_partial ? `, ${b.days_partial} a medias` : ''}.`
          : `No se puede comparar contra ${cual}: de ${b.window_days} días sólo ${b.days_used} llegaron completos`
            + `${b.days_missing ? ` (faltan ${b.days_missing})` : ''}${b.days_partial ? `, ${b.days_partial} a medias` : ''}.`
            + ' Promediar un feed incompleto inventaría el ritmo.';
      case 'sin_datos': return `El ERP no tiene ventas registradas en ${cual}.`;
      case 'sin_alcance': return 'Tu alcance de sucursales no incluye ninguna tienda.';
      default: return 'El histórico del ERP no está disponible en este entorno.';
    }
  }

  private loadRhythm(): void {
    this.svc.rhythm(this.selectedBranch() || undefined).subscribe({
      next: (r) => this.rhythm.set(r),
      // Sin ritmo la pantalla sigue viva: se pierden los deltas, no los KPIs.
      error: () => this.rhythm.set(null),
    });
  }

  /**
   * Sucursales SIN CONEXIÓN al POS: vendían HOY y dejaron de reportar. Condiciones:
   *  - la red está operando (alguien vendió hace <15 min) → no alarma de noche/cierre;
   *  - la sucursal VENDIÓ HOY (last_ts ≥ medianoche MX) → una tienda que aún no abre NO es
   *    un POS caído (bug 2026-08-05: Yurécuaro marcada "caída" a las 08:09 cuando su última
   *    venta era de ayer 19:43 y solo no había abierto todavía);
   *  - ≥45 min de silencio desde su última venta de hoy.
   * (Una caja rota ANTES de la 1ª venta del día es indistinguible de "cerrada/no abre" con
   * solo datos de venta → no se alarma; el drop a media operación sí se caza.)
   */
  readonly disconnectedBranches = computed(() => {
    const bs = this.branches();
    const networkFresh = bs.some((b) => b.tickets > 0 && this.idleMin(b.last_ts) < 15);
    if (!networkFresh) return [];
    const mxMid = this.mxMidnightMs();
    return bs
      .filter((b) => b.last_ts && new Date(b.last_ts).getTime() >= mxMid && this.idleMin(b.last_ts) >= 45)
      .map((b) => ({ code: b.warehouse_code, name: b.warehouse_name || b.warehouse_code, last_ts: b.last_ts, idle: this.idleMin(b.last_ts) }))
      .sort((a, b) => b.idle - a.idle);
  });
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
    // El ritmo se pide una vez por sesión del apartado: es un promedio de días
    // cerrados, no cambia mientras la pantalla está abierta (y el servidor lo cachea).
    if (!this.rhythm()) this.loadRhythm();
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
    // El ritmo también está acotado a la sucursal: comparar una tienda contra el
    // promedio de la red entera diría cualquier cosa.
    this.rhythm.set(null);
    this.loadRhythm();
  }

  private loadSnapshot(): void {
    this.svc.snapshot(this.selectedBranch() || undefined).subscribe({
      next: (s) => {
        this.error.set(false);
        this.ventaHoy.set(s.totals.venta);
        this.ticketsHoy.set(s.totals.tickets);
        this.branches.set(s.by_branch);
        const hy: Record<number, { venta: number; tickets: number }> = {};
        for (const h of s.hourly) hy[h.hora] = { venta: h.venta, tickets: h.tickets };
        this.hourly.set(hy);
        this.seen.clear();
        for (const t of s.recent) this.seen.add(this.tkKey(t));
        this.ticker.set(s.recent);

        // TDA.P — palancas. El backend viejo no manda `lines`: en ese caso NO se
        // inventa el dato desde el ticker (que va topado) — se deja en null y la
        // pantalla lo declara.
        this.levers.set(s.lines ?? null);
        this.leversTickets.set(s.totals.tickets);
        this.leversAt.set(s.generated_at || '');
        this.leversByBranch = {};
        for (const b of s.by_branch) if (b.lines) this.leversByBranch[b.warehouse_code] = b.lines;
        this.partidasHoy.set(s.lines?.lines ?? 0);
        this.importePartidas.set(s.lines?.amount ?? 0);
      },
      error: () => this.error.set(true),
    });
  }

  /** §6/§13 — reintento manual del snapshot tras un error de carga. */
  retry(): void { this.error.set(false); this.loadSnapshot(); }

  private applyTicket(t: LiveTicket): void {
    const sel = this.selectedBranch();
    if (sel && t.warehouse_code !== sel) return;
    const key = this.tkKey(t);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.ticker.update((list) => [t, ...list].slice(0, TiendaStateService.MAX_TICKER));
    this.ventaHoy.update((v) => v + (t.total || 0));
    this.ticketsHoy.update((n) => n + 1);
    // Partidas al vuelo: el ticket trae sus renglones, así que el conteo y su importe
    // siguen siendo exactos sin volver a preguntarle al servidor. Las unidades NO se
    // tocan acá — su peldaño solo se resuelve en SQL, y sumar `cant` crudo metería el
    // sesgo de 1.63% medido (UNIDADES_DE_MEDIDA.md §7).
    const its = t.items || [];
    if (its.length) {
      this.partidasHoy.update((n) => n + its.length);
      this.importePartidas.update((v) => v + its.reduce((s, it) => s + (it.importe || 0), 0));
    }
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

  /**
   * Unidades por ticket de UNA sucursal (peldaño ya resuelto en el servidor).
   * `null` = esa sucursal no tiene renglones resueltos; el llamador NO debe leerlo
   * como cero.
   */
  unitsPerTicketOf(code: string): number | null {
    const l = this.leversByBranch[code];
    const b = this.branches().find((x) => x.warehouse_code === code);
    return l?.units != null && b?.tickets ? l.units / b.tickets : null;
  }

  /**
   * Partidas de UNA sucursal. Prefiere el agregado exacto del servidor; si el backend
   * no lo mandó, cae al ticker (que va topado, o sea muestra) — nunca al revés.
   */
  private linesOf(code: string): { lines: number; amount: number } {
    const exact = this.leversByBranch[code];
    if (exact) return { lines: exact.lines, amount: exact.amount };
    const t = this.ticketsOf(code);
    const a = this.itemsAgg(t);
    let amount = 0;
    for (const tk of t) for (const it of tk.items || []) amount += it.importe || 0;
    return { lines: a.lines, amount };
  }

  /** Promedios de la RED (benchmark relativo para el coaching por tienda). */
  readonly networkLevers = computed(() => {
    const bs = this.branches();
    const tickets = bs.reduce((s, b) => s + b.tickets, 0);
    const venta = bs.reduce((s, b) => s + b.venta, 0);
    const active = bs.filter((b) => b.tickets > 0).length || 1;
    return {
      tickets,
      ticketsPerStore: tickets / active,
      ticketProm: tickets ? venta / tickets : 0,
      linesPerTicket: this.partidasPorTicket(),
      amountPerLine: this.valorPorPartida(),
    };
  });

  /**
   * Las 3 palancas de una tienda + índice vs red + cuál debe subir.
   * Son las MISMAS tres de la política comercial: más tickets · más partidas por
   * ticket · más valor por partida. (Antes la tercera eran "productos/ticket" con
   * `cant` crudo, que mezcla peldaños — ver `UNIDADES_DE_MEDIDA.md` §7.)
   */
  leversOf(code: string) {
    const b = this.branches().find((x) => x.warehouse_code === code);
    const ln = this.linesOf(code);
    const net = this.networkLevers();
    const tickets = b?.tickets ?? 0;
    const ticketProm = tickets ? (b!.venta / tickets) : 0;
    const linesPerTicket = tickets ? ln.lines / tickets : 0;
    const amountPerLine = ln.lines ? ln.amount / ln.lines : 0;
    const idx = {
      tickets: net.ticketsPerStore ? tickets / net.ticketsPerStore : 1,
      ticketProm: net.ticketProm ? ticketProm / net.ticketProm : 1,
      linesPerTicket: net.linesPerTicket ? linesPerTicket / net.linesPerTicket : 1,
    };
    // `sub` = segunda métrica del chip (solo Partidas la usa: el valor de cada renglón).
    // null = el chip muestra un solo número.
    const items = [
      { key: 'tickets', label: 'Tickets', short: 'Tickets', value: tickets, idx: idx.tickets, sub: null as number | null },
      { key: 'ticketProm', label: 'Ticket promedio', short: '$/tkt', value: ticketProm, idx: idx.ticketProm, sub: null as number | null },
      { key: 'linesPerTicket', label: 'Partidas por ticket', short: 'Part/tkt', value: linesPerTicket, idx: idx.linesPerTicket, sub: amountPerLine as number | null },
    ];
    const weakest = items.reduce((m, e) => (e.idx < m.idx ? e : m), items[0]);
    // gap vs red en % (negativo = por debajo)
    const gapPct = Math.round((weakest.idx - 1) * 100);
    // Lente de unidades de ESTA sucursal. `null` = su peldaño no se resolvió; el chip
    // muestra "—", no un cero. Fuera de `items` a propósito: `weakest` decide qué
    // palanca empujar, y las palancas de la política son tres, no cinco.
    const bl = this.leversByBranch[code];
    const unitsPerTicket = this.unitsPerTicketOf(code);
    const amountPerUnit = bl?.amount_per_unit ?? null;
    return { tickets, ticketProm, linesPerTicket, amountPerLine, unitsPerTicket, amountPerUnit, idx, items, weakest, gapPct };
  }

  toggle(t: LiveTicket): void {
    const key = this.tkKey(t);
    this.open.update((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  isOpen(t: LiveTicket): boolean { return this.open().has(this.tkKey(t)); }

  /**
   * Unidades de UN ticket = suma de cantidades de sus partidas. Es lo que el cliente se
   * llevó según ESE ticket, tal cual lo imprimió la caja: no se le aplica el resolvedor
   * de peldaño, que sirve para agregar entre tickets, no para transcribir uno solo.
   *
   * Memorizado: la lista llega a miles de filas y se repinta con cada venta que entra
   * por WS. Un ticket ya recibido no cambia, así que se calcula una vez.
   */
  private readonly artsMemo = new Map<string, number>();
  arts(t: LiveTicket): number {
    const k = this.tkKey(t);
    let v = this.artsMemo.get(k);
    if (v === undefined) {
      v = (t.items || []).reduce((s, it) => s + (it.cant || 0), 0);
      // El ticker se recorta a 6000; una pestaña abierta días acumularía entradas de
      // tickets que ya no están en pantalla. Se vacía y se vuelve a llenar.
      if (this.artsMemo.size > 12000) this.artsMemo.clear();
      this.artsMemo.set(k, v);
    }
    return v;
  }

  /** "1 partida" / "3 partidas" — en español el plural no es sumar una s. */
  plural(n: number, uno: string, muchos: string): string {
    return `${n.toLocaleString('es-MX')} ${n === 1 ? uno : muchos}`;
  }

  hora(ts: string): string { return ts.slice(11, 16); }
  idleMin(ts: string): number { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 60000) : 9999; }
  /** Epoch ms de la medianoche de HOY en hora MX (offset fijo -06, sin DST). */
  private mxMidnightMs(): number { const h6 = 6 * 3600e3; return Math.floor((Date.now() - h6) / 86400e3) * 86400e3 + h6; }
  lastLabel(ts: string): string { const m = this.idleMin(ts); return m >= 9999 ? '—' : m <= 0 ? 'ahora' : `hace ${m} min`; }
}
