import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import {
  StoreSocketService, LiveTicket, StoreAlert, StoreBranchKpi,
} from '../store-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { STORE_BRANCHES, branchName } from '../../../core/constants/store-branches';

/** Proyecto Tienda — monitor de tickets de venta EN VIVO (WebSocket /store). */
@Component({
  selector: 'app-tienda-live',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in tda">
      <header class="surf-page-head tda-head">
        <div class="surf-page-head-text">
          <h1>Tienda — en vivo</h1>
          <p class="surf-page-sub">Tickets de venta de cada sucursal al instante · KPIs del día · ritmo por hora</p>
        </div>
        <div class="tda-head-right">
          @if (scopedWarehouse) {
            <span class="tda-scope"><i class="pi pi-map-marker"></i>{{ branchName(scopedWarehouse) }}</span>
          } @else {
            <select class="tda-filter" [value]="selectedBranch()" (change)="changeBranch($any($event.target).value)">
              <option value="">Todas las sucursales</option>
              @for (b of branchList; track b.code) {
                <option [value]="b.code">{{ b.name }}</option>
              }
            </select>
          }
          <div class="tda-live" [class.on]="connected()">
            <span class="dot"></span>{{ connected() ? 'EN VIVO' : 'conectando…' }}
          </div>
        </div>
      </header>

      <!-- KPIs del día -->
      <div class="tda-kpis">
        <div class="tda-kpi"><span class="l">Venta hoy</span><span class="v">{{ ventaHoy() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
        <div class="tda-kpi"><span class="l">Tickets hoy</span><span class="v">{{ ticketsHoy() | number }}</span></div>
        <div class="tda-kpi"><span class="l">Ticket promedio</span><span class="v">{{ avgTicket() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
        <div class="tda-kpi"><span class="l">Sucursales activas</span><span class="v">{{ activeBranches() }}</span></div>
      </div>

      <!-- Sucursales -->
      <div class="tda-branches">
        @for (b of branches(); track b.warehouse_code) {
          <div class="tda-branch" [class.idle]="idleMin(b.last_ts) >= 20">
            <div class="bh"><span class="bn">{{ b.warehouse_name || b.warehouse_code }}</span>
              <span class="bt" [class.warn]="idleMin(b.last_ts) >= 20">{{ lastLabel(b.last_ts) }}</span></div>
            <div class="bv">{{ b.venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
            <div class="bk">{{ b.tickets | number }} tickets</div>
          </div>
        }
        @if (!branches().length) { <div class="tda-empty">Aún sin ventas hoy…</div> }
      </div>

      <div class="tda-grid">
        <!-- Ticker en vivo -->
        <section class="tda-card tda-ticker">
          <h2>Tickets del día <span class="tk-count">{{ ticker().length | number }}</span></h2>
          <div class="tk-list">
            @for (t of ticker(); track t.warehouse_code + t.serie + t.folio) {
              <div class="tk" [class.flash]="t === ticker()[0]" (click)="toggle(t)">
                <div class="tk-row">
                  <span class="tk-time">{{ hora(t.ticket_ts) }}</span>
                  <span class="tk-suc">{{ t.warehouse_name || t.warehouse_code }}</span>
                  <span class="tk-items">{{ t.items.length }} art.</span>
                  <span class="tk-total">{{ t.total | currency:'MXN':'symbol-narrow':'1.0-2' }}</span>
                </div>
                @if (isOpen(t)) {
                  <div class="tk-detail">
                    @for (it of t.items; track it.sku) {
                      <div class="tk-item"><span class="q">{{ it.cant }}×</span> {{ it.nombre }} <span class="im">{{ it.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</span></div>
                    }
                  </div>
                }
              </div>
            }
            @if (!ticker().length) { <div class="tda-empty">Esperando el próximo ticket…</div> }
          </div>
        </section>

        <div class="tda-side">
          <!-- Ritmo por hora -->
          <section class="tda-card">
            <h2>Ritmo de hoy (venta por hora)</h2>
            <div class="hrs">
              @for (h of hourBars(); track h.hora) {
                <div class="hr" [title]="h.hora + 'h · ' + (h.venta | currency:'MXN')">
                  <div class="bar" [style.height.%]="h.pct"></div>
                  <span class="hl">{{ h.hora }}</span>
                </div>
              }
            </div>
          </section>

          <!-- Alertas -->
          <section class="tda-card">
            <h2>Alertas</h2>
            <div class="al-list">
              @for (a of alerts(); track a.emitted_at) {
                <div class="al" [class]="'sev-' + a.severity">
                  <span class="al-t">{{ a.title }}</span><span class="al-m">{{ a.message }}</span>
                </div>
              }
              @if (!alerts().length) { <div class="tda-empty">Sin alertas.</div> }
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .tda-head { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
    .tda-head-right { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
    .tda-filter { font-size:.8rem; font-weight:600; color:var(--ink); background:var(--card-bg);
      border:1px solid var(--border); border-radius:var(--radius-md); padding:.4rem .7rem; cursor:pointer; }
    .tda-filter:focus-visible { outline:2px solid var(--action,#b45309); outline-offset:1px; }
    .tda-scope { display:inline-flex; align-items:center; gap:.35rem; font-size:.78rem; font-weight:700;
      color:var(--ink); border:1px solid var(--border); border-radius:999px; padding:.3rem .7rem; }
    .tda-scope i { font-size:.7rem; color:var(--text-muted); }
    .tda-live { display:inline-flex; align-items:center; gap:.4rem; font-size:.72rem; font-weight:700; letter-spacing:.05em;
      color:var(--text-muted); border:1px solid var(--border); border-radius:999px; padding:.3rem .7rem; }
    .tda-live.on { color:#15803d; border-color:#15803d55; }
    .tda-live .dot { width:.55rem; height:.55rem; border-radius:50%; background:var(--text-muted); }
    .tda-live.on .dot { background:#22c55e; box-shadow:0 0 0 0 #22c55e88; animation:pulse 1.6s infinite; }
    @keyframes pulse { 0%{box-shadow:0 0 0 0 #22c55e88} 70%{box-shadow:0 0 0 .5rem #22c55e00} 100%{box-shadow:0 0 0 0 #22c55e00} }
    .tda-kpis { display:flex; flex-wrap:wrap; gap:.75rem; margin:1rem 0; }
    .tda-kpi { flex:1 1 170px; border:1px solid var(--border); border-radius:var(--radius-md); padding:.7rem 1rem; background:var(--card-bg); }
    .tda-kpi .l { display:block; font-size:.68rem; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); font-weight:600; }
    .tda-kpi .v { display:block; font-size:1.6rem; font-weight:800; margin-top:.15rem; font-variant-numeric:tabular-nums; }
    .tda-branches { display:flex; flex-wrap:wrap; gap:.6rem; margin-bottom:1rem; }
    .tda-branch { flex:1 1 150px; border:1px solid var(--border); border-radius:var(--radius-md); padding:.55rem .8rem; background:var(--card-bg); }
    .tda-branch.idle { border-color:#f59e0b66; background:#f59e0b0d; }
    .tda-branch .bh { display:flex; justify-content:space-between; align-items:baseline; gap:.4rem; }
    .tda-branch .bn { font-weight:700; font-size:.82rem; }
    .tda-branch .bt { font-size:.66rem; color:var(--text-muted); } .tda-branch .bt.warn { color:#b45309; font-weight:700; }
    .tda-branch .bv { font-size:1.15rem; font-weight:800; font-variant-numeric:tabular-nums; margin-top:.2rem; }
    .tda-branch .bk { font-size:.7rem; color:var(--text-muted); }
    .tda-grid { display:grid; grid-template-columns:1.6fr 1fr; gap:1rem; align-items:start; }
    @media (max-width:900px){ .tda-grid { grid-template-columns:1fr; } }
    .tda-card { border:1px solid var(--border); border-radius:var(--radius-md); background:var(--card-bg); padding:1rem 1.1rem; }
    .tda-card h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); font-weight:700; margin:0 0 .7rem; }
    .tk-count { color:var(--ink); font-weight:800; font-variant-numeric:tabular-nums; }
    .tda-side { display:flex; flex-direction:column; gap:1rem; }
    .tk-list { display:flex; flex-direction:column; max-height:60vh; overflow-y:auto; }
    .tk { border-bottom:1px solid var(--border); padding:.4rem 0; cursor:pointer;
      content-visibility:auto; contain-intrinsic-size:0 40px; } /* render fluido con miles de filas */
    .tk-row { display:grid; grid-template-columns:3.2rem 1fr auto auto; gap:.6rem; align-items:baseline; font-size:.84rem; }
    .tk-time { font-variant-numeric:tabular-nums; color:var(--text-muted); font-size:.78rem; }
    .tk-suc { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .tk-items { font-size:.72rem; color:var(--text-muted); }
    .tk-total { font-weight:800; font-variant-numeric:tabular-nums; }
    .tk.flash { animation:flash 1.2s ease-out; }
    @keyframes flash { from{background:#22c55e22} to{background:transparent} }
    .tk-detail { padding:.3rem 0 .35rem 3.8rem; }
    .tk-item { font-size:.76rem; color:var(--text-muted); display:flex; gap:.4rem; }
    .tk-item .q { color:var(--ink); font-weight:700; } .tk-item .im { margin-left:auto; font-variant-numeric:tabular-nums; }
    .hrs { display:flex; align-items:flex-end; gap:.2rem; height:120px; }
    .hr { flex:1; display:flex; flex-direction:column; align-items:center; height:100%; justify-content:flex-end; }
    .hr .bar { width:70%; min-height:2px; background:var(--action,#b45309); border-radius:3px 3px 0 0; transition:height .4s; }
    .hr .hl { font-size:.58rem; color:var(--text-muted); margin-top:.15rem; }
    .al-list { display:flex; flex-direction:column; gap:.4rem; max-height:30vh; overflow-y:auto; }
    .al { border-left:3px solid var(--border); padding:.35rem .6rem; background:var(--layout-bg); border-radius:0 6px 6px 0; }
    .al.sev-info { border-left-color:#3b82f6; } .al.sev-warn { border-left-color:#f59e0b; } .al.sev-critical { border-left-color:#ef4444; }
    .al-t { display:block; font-weight:700; font-size:.78rem; } .al-m { font-size:.72rem; color:var(--text-muted); }
    .tda-empty { color:var(--text-muted); font-size:.8rem; padding:.6rem 0; }
  `],
})
export class TiendaLiveComponent implements OnInit, OnDestroy {
  private readonly svc = inject(StoreSocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);

  readonly connected = this.svc.connected;
  readonly branchList = STORE_BRANCHES;
  readonly branchName = branchName;
  // Sucursal a la que el usuario está scopeado por su login ('' = rol global, ve todas).
  scopedWarehouse = '';
  // Sucursal seleccionada en el filtro ('' = todas). Los scopeados quedan fijos a la suya.
  selectedBranch = signal<string>('');
  ventaHoy = signal(0);
  ticketsHoy = signal(0);
  branches = signal<StoreBranchKpi[]>([]);
  hourly = signal<Record<number, { venta: number; tickets: number }>>({});
  ticker = signal<LiveTicket[]>([]);
  alerts = signal<StoreAlert[]>([]);
  private open = signal<Set<string>>(new Set());
  private seen = new Set<string>(); // claves ya en el ticker (dedup snapshot↔WS)
  private static readonly MAX_TICKER = 6000; // cota de seguridad del DOM (~día pico)
  private tkKey(t: LiveTicket): string { return t.warehouse_code + t.serie + t.folio; }

  avgTicket = computed(() => this.ticketsHoy() ? this.ventaHoy() / this.ticketsHoy() : 0);
  activeBranches = computed(() => this.branches().filter((b) => b.tickets > 0).length);
  hourBars = computed(() => {
    const h = this.hourly();
    const hrs = Array.from({ length: 17 }, (_, i) => i + 6); // 6h..22h
    const max = Math.max(1, ...hrs.map((x) => h[x]?.venta || 0));
    return hrs.map((hora) => ({ hora, venta: h[hora]?.venta || 0, pct: Math.round(((h[hora]?.venta || 0) / max) * 100) }));
  });

  ngOnInit(): void {
    this.svc.connect();
    // Si el login trae sucursal, el usuario queda fijo a ella (el backend además
    // lo fuerza en snapshot y WS; esto solo sincroniza el UI).
    this.scopedWarehouse = this.auth.user()?.warehouse_code || '';
    if (this.scopedWarehouse) this.selectedBranch.set(this.scopedWarehouse);
    this.loadSnapshot();
    this.svc.ticket$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((t) => this.applyTicket(t));
    this.svc.alert$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((a) =>
      this.alerts.update((list) => [a, ...list].slice(0, 25)));
  }

  ngOnDestroy(): void { this.svc.disconnect(); }

  /** (Re)carga el snapshot para la sucursal seleccionada ('' = todas). */
  private loadSnapshot(): void {
    this.svc.snapshot(this.selectedBranch() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (s) => {
          this.ventaHoy.set(s.totals.venta);
          this.ticketsHoy.set(s.totals.tickets);
          this.branches.set(s.by_branch);
          const hy: Record<number, { venta: number; tickets: number }> = {};
          for (const h of s.hourly) hy[h.hora] = { venta: h.venta, tickets: h.tickets };
          this.hourly.set(hy);
          // Todos los tickets del día (más nuevo primero); registrar claves para dedup.
          this.seen = new Set(s.recent.map((t) => this.tkKey(t)));
          this.ticker.set(s.recent);
        },
        error: () => undefined,
      });
  }

  /** Cambio de filtro por sucursal (solo roles globales). Resetea y recarga. */
  changeBranch(code: string): void {
    if (this.scopedWarehouse) return; // usuario scopeado: no puede cambiar
    if (code === this.selectedBranch()) return;
    this.selectedBranch.set(code);
    this.ticker.set([]);
    this.seen.clear();
    this.loadSnapshot();
  }

  private applyTicket(t: LiveTicket): void {
    const sel = this.selectedBranch();
    if (sel && t.warehouse_code !== sel) return; // filtro activo → ignora otras sucursales
    const key = this.tkKey(t);
    if (this.seen.has(key)) return; // ya estaba (snapshot o reemisión) → no duplicar ni recontar
    this.seen.add(key);
    this.ticker.update((list) => [t, ...list].slice(0, TiendaLiveComponent.MAX_TICKER));
    this.ventaHoy.update((v) => v + (t.total || 0));
    this.ticketsHoy.update((n) => n + 1);
    // sucursal
    this.branches.update((list) => {
      const i = list.findIndex((b) => b.warehouse_code === t.warehouse_code);
      if (i === -1) return [...list, { warehouse_code: t.warehouse_code, warehouse_name: t.warehouse_name || t.warehouse_code, tickets: 1, venta: t.total || 0, last_ts: t.ticket_ts }];
      const copy = [...list];
      copy[i] = { ...copy[i], tickets: copy[i].tickets + 1, venta: copy[i].venta + (t.total || 0), last_ts: t.ticket_ts };
      return copy.sort((a, b) => b.venta - a.venta);
    });
    // hora
    const hora = Number(t.ticket_ts.slice(11, 13));
    this.hourly.update((h) => ({ ...h, [hora]: { venta: (h[hora]?.venta || 0) + (t.total || 0), tickets: (h[hora]?.tickets || 0) + 1 } }));
  }

  toggle(t: LiveTicket): void {
    const key = t.warehouse_code + t.serie + t.folio;
    this.open.update((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  isOpen(t: LiveTicket): boolean { return this.open().has(t.warehouse_code + t.serie + t.folio); }

  hora(ts: string): string { return ts.slice(11, 16); }
  idleMin(ts: string): number { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 60000) : 9999; }
  lastLabel(ts: string): string { const m = this.idleMin(ts); return m >= 9999 ? '—' : m <= 0 ? 'ahora' : `hace ${m} min`; }
}
