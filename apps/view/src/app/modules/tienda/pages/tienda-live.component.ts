import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — monitor de tickets de venta EN VIVO (WebSocket /store). */
@Component({
  selector: 'app-tienda-live',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, MetricCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    :host { display:block; }
    .tda-kpis-mc { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:.75rem; margin:1rem 0 .3rem; }
    .tda-band-cap { margin:0 0 1rem; font-size:.72rem; color:var(--text-faint); }
    .tda-band-cap b { color:var(--text-main); font-weight:700; }

    /* Coaching por tienda: las 3 palancas vs promedio de la red + "qué subir" */
    .tda-branch { flex-basis:210px; }
    .levers { display:flex; gap:.4rem; margin-top:.55rem; }
    .lever { flex:1; display:flex; flex-direction:column; gap:.1rem; padding:.3rem .4rem; border-radius:var(--r-sm,8px);
      background:color-mix(in srgb, var(--text-main) 4%, transparent); }
    .lever.weak { background:color-mix(in srgb, var(--action) 10%, transparent); box-shadow:inset 0 0 0 1px var(--action-ring); }
    .lever .lv-k { font-size:.56rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); white-space:nowrap; }
    .lever .lv-i { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:.74rem; font-weight:700; color:var(--text-muted); }
    .lever .lv-i.lo { color:var(--bad-soft-fg); } .lever .lv-i.hi { color:var(--ok-soft-fg); }
    .coach { display:flex; align-items:center; gap:.35rem; margin-top:.45rem; font-size:.72rem; color:var(--action); font-weight:600; }
    .coach i { font-size:.7rem; } .coach .g { margin-left:auto; color:var(--text-muted); font-weight:700; font-variant-numeric:tabular-nums; }
  `],
  template: `
    <div class="surf-page in tda">
      <header class="surf-page-head tda-head">
        <div class="surf-page-head-text">
          <h1>Tienda — en vivo</h1>
          <p class="surf-page-sub">Tickets de venta de cada sucursal al instante · KPIs del día · ritmo por hora</p>
        </div>
        <div class="tda-head-right">
          @if (s.scopedWarehouse) {
            <span class="tda-scope"><i class="pi pi-map-marker"></i>{{ s.branchName(s.scopedWarehouse) }}</span>
          } @else {
            <p-select [ngModel]="s.selectedBranch() || null" (ngModelChange)="s.changeBranch($event || '')"
                      [options]="s.branchList" optionLabel="name" optionValue="code"
                      placeholder="Todas las sucursales" [showClear]="true" appendTo="body"
                      styleClass="tda-filter-sel" />
          }
          <div class="tda-live" [class.on]="s.connected()">
            <span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}
          </div>
        </div>
      </header>

      <div class="tda-kpis-mc">
        <app-metric-card label="Tickets del día" [value]="s.ticketsHoy()" format="number" variant="sparkline"
          [series]="hourTickets()" [seriesLabels]="hourLabels()" tone="brand" [live]="s.connected()"
          sub="volumen de transacciones"></app-metric-card>
        <app-metric-card label="Ticket promedio" [value]="s.avgTicket()" format="currency"
          [live]="s.connected()" [accent]="'var(--chart-2)'" sub="venta promedio por ticket"></app-metric-card>
        <app-metric-card label="Productos por ticket" [value]="netUnits()" format="number" [decimals]="1"
          [live]="s.connected()" [accent]="'var(--chart-3)'" [sub]="netLines()"></app-metric-card>
      </div>
      <p class="tda-band-cap">Venta del día <b class="num">{{ s.ventaHoy() | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
        — los 3 pilares son las palancas para subirla (Venta = Tickets × Ticket promedio; Ticket promedio ↔ Productos por ticket).</p>

      <div class="tda-branches">
        @for (c of coached(); track c.b.warehouse_code) {
          <div class="tda-branch" [class.idle]="s.idleMin(c.b.last_ts) >= 20">
            <div class="bh"><span class="bn">{{ c.b.warehouse_name || c.b.warehouse_code }}</span>
              <span class="bt" [class.warn]="s.idleMin(c.b.last_ts) >= 20">{{ s.lastLabel(c.b.last_ts) }}</span></div>
            <div class="bv">{{ c.b.venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
            <div class="bk">{{ c.b.tickets | number }} tickets</div>
            <div class="levers" role="group" aria-label="Palancas vs promedio de la red">
              @for (lv of c.lev.items; track lv.key) {
                <div class="lever" [class.weak]="lv.key === c.lev.weakest.key">
                  <span class="lv-k">{{ lv.short }}</span>
                  <span class="lv-i" [class.lo]="lv.idx < 0.97" [class.hi]="lv.idx > 1.03">{{ pct(lv.idx) }}</span>
                </div>
              }
            </div>
            <div class="coach"><i class="pi pi-arrow-up"></i> Subir: <b>{{ c.lev.weakest.label }}</b>
              <span class="g">{{ pct(c.lev.weakest.idx) }} vs red</span></div>
          </div>
        }
        @if (!s.branches().length) { <div class="tda-empty">Aún sin ventas hoy…</div> }
      </div>

      <div class="tda-grid">
        <section class="tda-card tda-ticker">
          <h2>Tickets del día <span class="tk-count">{{ s.ticker().length | number }}</span></h2>
          <div class="tk-list">
            @for (t of s.ticker(); track t.warehouse_code + t.serie + t.folio) {
              <div class="tk" [class.flash]="t === s.ticker()[0]" (click)="s.toggle(t)">
                <div class="tk-row">
                  <span class="tk-time">{{ s.hora(t.ticket_ts) }}</span>
                  <span class="tk-suc">{{ t.warehouse_name || t.warehouse_code }}</span>
                  <span class="tk-items">{{ t.items.length }} art.</span>
                  <span class="tk-total">{{ t.total | currency:'MXN':'symbol-narrow':'1.0-2' }}</span>
                </div>
                @if (s.isOpen(t)) {
                  <div class="tk-detail">
                    @for (it of t.items; track it.sku) {
                      <div class="tk-item"><span class="q">{{ it.cant }}×</span> {{ it.nombre }} <span class="im">{{ it.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</span></div>
                    }
                  </div>
                }
              </div>
            }
            @if (!s.ticker().length) { <div class="tda-empty">Esperando el próximo ticket…</div> }
          </div>
        </section>

        <div class="tda-side">
          <section class="tda-card">
            <h2>Ritmo de hoy (venta por hora)</h2>
            <div class="hrs">
              @for (h of s.hourBars(); track h.hora) {
                <div class="hr" [class.peak]="h.hora === peakHour() && h.venta > 0"
                     [title]="h.hora + 'h · ' + (h.venta | currency:'MXN')">
                  <div class="bar" [style.height.%]="h.pct"></div>
                  <span class="hl">{{ h.hora }}</span>
                </div>
              }
            </div>
          </section>

          <section class="tda-card">
            <h2>Alertas</h2>
            <div class="al-list">
              @for (a of s.alerts(); track a.emitted_at) {
                <div class="al" [class]="'sev-' + a.severity">
                  <span class="al-t">{{ a.title }}</span><span class="al-m">{{ a.message }}</span>
                </div>
              }
              @if (!s.alerts().length) { <div class="tda-empty">Sin alertas.</div> }
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
})
export class TiendaLiveComponent implements OnInit, OnDestroy {
  readonly s = inject(TiendaStateService);

  readonly hourVenta = computed(() => this.s.hourBars().map((h) => h.venta));
  readonly hourTickets = computed(() => this.s.hourBars().map((h) => h.tickets));
  readonly hourLabels = computed(() => this.s.hourBars().map((h) => h.hora + ':00'));
  readonly peakHour = computed(() => {
    let hora = -1, max = 0;
    for (const h of this.s.hourBars()) if (h.venta > max) { max = h.venta; hora = h.hora; }
    return hora;
  });

  // 3 pilares (nivel red) + coaching por tienda
  readonly netUnits = computed(() => this.s.networkLevers().unitsPerTicket);
  readonly netLines = computed(() => this.s.networkLevers().linesPerTicket.toFixed(1) + ' líneas por ticket');
  readonly coached = computed(() => this.s.branches().map((b) => ({ b, lev: this.s.leversOf(b.warehouse_code) })));

  /** Índice vs red → texto "+12%" / "−8%". */
  pct(idx: number): string { const v = Math.round((idx - 1) * 100); return (v > 0 ? '+' : '') + v + '%'; }

  ngOnInit(): void { this.s.enter(); }
  ngOnDestroy(): void { this.s.leave(); }
}
