import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — RITMO del día: curva horaria total + comparativa por sucursal. */
@Component({
  selector: 'app-tienda-pace',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    .hrs.big { height:220px; gap:.35rem; }
    .hrs.big .hr .bar { border-radius:4px 4px 0 0; }
    .hrs.big .hr.peak .bar { background:#15803d; }
    .hrs.big .hv { font-size:.58rem; color:var(--text-muted); font-variant-numeric:tabular-nums; margin-bottom:.2rem; height:.8rem; }
    .hrs.big .hl { font-size:.64rem; }
    .peakline { display:flex; flex-wrap:wrap; gap:.75rem; margin:.2rem 0 1rem; }
    .bcurves { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:.8rem; }
    .bcurve h3 { margin:0 0 .1rem; font-size:.9rem; font-weight:700; }
    .bcurve .sub { font-size:.72rem; color:var(--text-muted); margin-bottom:.4rem; }
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
            <select class="tda-filter" [value]="s.selectedBranch()" (change)="s.changeBranch($any($event.target).value)">
              <option value="">Todas las sucursales</option>
              @for (b of s.branchList; track b.code) { <option [value]="b.code">{{ b.name }}</option> }
            </select>
          }
          <div class="tda-live" [class.on]="s.connected()"><span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}</div>
        </div>
      </header>

      <div class="peakline">
        <div class="tda-kpi" style="flex:1 1 170px"><span class="l">Hora pico</span><span class="v">{{ peak().hora >= 0 ? peak().hora + ':00' : '—' }}</span></div>
        <div class="tda-kpi" style="flex:1 1 170px"><span class="l">Venta hora pico</span><span class="v">{{ peak().venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
        <div class="tda-kpi" style="flex:1 1 170px"><span class="l">Tickets hora pico</span><span class="v">{{ peak().tickets | number }}</span></div>
        <div class="tda-kpi" style="flex:1 1 170px"><span class="l">Venta del día</span><span class="v">{{ s.ventaHoy() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
      </div>

      <section class="tda-card">
        <h2>Venta por hora (6:00 – 22:00)</h2>
        <div class="hrs big">
          @for (h of s.hourBars(); track h.hora) {
            <div class="hr" [class.peak]="h.hora === peak().hora && h.venta > 0"
                 [title]="h.hora + 'h · ' + (h.venta | currency:'MXN') + ' · ' + h.tickets + ' tickets'">
              <span class="hv">{{ h.venta > 0 ? (h.venta / 1000 | number:'1.0-0') + 'k' : '' }}</span>
              <div class="bar" [style.height.%]="h.pct"></div>
              <span class="hl">{{ h.hora }}</span>
            </div>
          }
        </div>
      </section>

      @if (!s.scopedWarehouse && !s.selectedBranch()) {
        <section class="tda-card" style="margin-top:1rem">
          <h2>Ritmo por sucursal</h2>
          <div class="bcurves">
            @for (bc of branchCurves(); track bc.code) {
              <div class="bcurve">
                <h3>{{ bc.name }}</h3>
                <div class="sub">{{ bc.venta | currency:'MXN':'symbol-narrow':'1.0-0' }} · pico {{ bc.peak >= 0 ? bc.peak + 'h' : '—' }}</div>
                <div class="hrs">
                  @for (h of bc.bars; track h.hora) {
                    <div class="hr" [title]="h.hora + 'h · ' + (h.venta | currency:'MXN')"><div class="bar" [style.height.%]="h.pct"></div></div>
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
