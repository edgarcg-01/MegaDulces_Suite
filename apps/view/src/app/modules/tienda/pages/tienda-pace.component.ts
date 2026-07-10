import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — RITMO del día: curva horaria total + comparativa por sucursal. */
@Component({
  selector: 'app-tienda-pace',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, MetricCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    :host { display:block; }

    .pace-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.75rem; margin:1rem 0; }

    /* Curva horaria grande — barras neutras, pico en sunset (quiet-luxury dataviz). */
    .hrs.big { height:220px; gap:.35rem; }
    .hrs.big .hr .bar { border-radius:4px 4px 0 0; }
    .hrs.big .hr:hover .bar { background:color-mix(in srgb, var(--text-main) 34%, transparent); }
    .hrs.big .hr.peak:hover .bar { background:var(--action-hover); }
    .hrs.big .hv { font-size:.58rem; color:var(--text-faint); font-variant-numeric:tabular-nums; margin-bottom:.2rem; height:.8rem; }
    .hrs.big .hr.peak .hv { color:var(--action); font-weight:700; }
    .hrs.big .hl { font-size:.64rem; }
    .hrs.big .hr.peak .hl { color:var(--text-main); font-weight:700; }

    .pace-branches { margin-top:1rem; }
    .bcurves { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:.8rem; }
    .bcurve { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.7rem .8rem; }
    .bcurve h3 { margin:0 0 .1rem; font-size:.85rem; font-weight:600; color:var(--text-main); }
    .bcurve .sub { font-size:.72rem; color:var(--text-muted); margin-bottom:.4rem; font-variant-numeric:tabular-nums; }
    .bcurve .hrs { height:70px; }
  `],
  template: `
    <div class="surf-page in tda">
      <header class="surf-page-head tda-head">
        <div class="surf-page-head-text">
          <h1>Tienda — ritmo del día</h1>
          <p class="surf-page-sub">Venta por hora · hora pico · comparativa entre sucursales</p>
        </div>
        <div class="tda-head-right">
          @if (s.scopedWarehouse) {
            <span class="tda-scope"><i class="pi pi-map-marker"></i>{{ s.branchName(s.scopedWarehouse) }}</span>
          } @else {
            <p-select [options]="branchOptions" [ngModel]="s.selectedBranch()" (onChange)="s.changeBranch($event.value)"
              optionLabel="label" optionValue="value" styleClass="tda-filter-sel" [style]="{ minWidth: '12rem' }"
              appendTo="body" ariaLabel="Filtrar por sucursal"></p-select>
          }
          <div class="tda-live" [class.on]="s.connected()" role="status"
               [attr.aria-label]="s.connected() ? 'Conexión en vivo activa' : 'Conectando'">
            <span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}
          </div>
        </div>
      </header>

      <div class="pace-kpis">
        <app-metric-card label="Hora pico" format="text"
          [valueText]="peak().hora >= 0 ? peak().hora + ':00' : '—'" sub="hora de mayor venta"></app-metric-card>
        <app-metric-card label="Venta hora pico" [value]="peak().venta" format="currency"
          variant="progress" [goal]="s.ventaHoy()" sub="respecto al día"></app-metric-card>
        <app-metric-card label="Tickets hora pico" [value]="peak().tickets" format="number"
          sub="en la hora más alta"></app-metric-card>
        <app-metric-card label="Venta del día" [value]="s.ventaHoy()" format="currency"
          variant="sparkline" [series]="hourVenta()" [seriesLabels]="hourLabels()" tone="brand"
          [live]="s.connected()"></app-metric-card>
      </div>

      <section class="tda-card">
        <h2>Venta por hora (6:00 – 22:00)</h2>
        <div class="hrs big" role="list" aria-label="Venta por hora">
          @for (h of s.hourBars(); track h.hora) {
            <div class="hr" role="listitem" [class.peak]="h.hora === peak().hora && h.venta > 0"
                 [attr.aria-label]="h.hora + ':00 — ' + (h.venta | currency:'MXN':'symbol-narrow':'1.0-0') + ', ' + h.tickets + ' tickets'"
                 [title]="h.hora + 'h · ' + (h.venta | currency:'MXN') + ' · ' + h.tickets + ' tickets'">
              <span class="hv" aria-hidden="true">{{ h.venta > 0 ? (h.venta / 1000 | number:'1.0-0') + 'k' : '' }}</span>
              <div class="bar" [style.height.%]="h.pct"></div>
              <span class="hl" aria-hidden="true">{{ h.hora }}</span>
            </div>
          }
        </div>
      </section>

      @if (!s.scopedWarehouse && !s.selectedBranch()) {
        <section class="tda-card pace-branches">
          <h2>Ritmo por sucursal</h2>
          <div class="bcurves">
            @for (bc of branchCurves(); track bc.code) {
              <div class="bcurve">
                <h3>{{ bc.name }}</h3>
                <div class="sub">{{ bc.venta | currency:'MXN':'symbol-narrow':'1.0-0' }} · pico {{ bc.peak >= 0 ? bc.peak + 'h' : '—' }}</div>
                <div class="hrs" role="list" [attr.aria-label]="'Ritmo de ' + bc.name">
                  @for (h of bc.bars; track h.hora) {
                    <div class="hr" role="listitem" [class.peak]="h.hora === bc.peak && h.venta > 0"
                         [attr.aria-label]="h.hora + ':00 — ' + (h.venta | currency:'MXN':'symbol-narrow':'1.0-0')"
                         [title]="h.hora + 'h · ' + (h.venta | currency:'MXN')">
                      <div class="bar" [style.height.%]="h.pct"></div>
                    </div>
                  }
                </div>
              </div>
            }
            @if (!branchCurves().length) { <div class="tda-empty">Aún sin ventas hoy…</div> }
          </div>
        </section>
      }
    </div>
  `,
})
export class TiendaPaceComponent implements OnInit, OnDestroy {
  readonly s = inject(TiendaStateService);

  readonly branchOptions = [
    { label: 'Todas las sucursales', value: '' },
    ...this.s.branchList.map((b) => ({ label: b.name, value: b.code })),
  ];

  readonly hourVenta = computed(() => this.s.hourBars().map((h) => h.venta));
  readonly hourLabels = computed(() => this.s.hourBars().map((h) => h.hora + ':00'));

  readonly peak = computed(() => {
    let best = { hora: -1, venta: 0, tickets: 0 };
    for (const h of this.s.hourBars()) if (h.venta > best.venta) best = { hora: h.hora, venta: h.venta, tickets: h.tickets };
    return best;
  });

  readonly branchCurves = computed(() =>
    this.s.branches().map((b) => {
      const bars = this.s.hourBarsOf(b.warehouse_code);
      let peakH = -1, peakV = 0;
      for (const h of bars) if (h.venta > peakV) { peakV = h.venta; peakH = h.hora; }
      return { code: b.warehouse_code, name: b.warehouse_name || b.warehouse_code, venta: b.venta, peak: peakH, bars };
    }),
  );

  ngOnInit(): void { this.s.enter(); }
  ngOnDestroy(): void { this.s.leave(); }
}
