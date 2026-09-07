import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  SellOutReport,
  SellOutExplainReport,
  SellOutExplainDim,
  SellOutExplainCompare,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { REPORTS_TABS } from '../reports-tabs';

const DIM_OPTS: { key: SellOutExplainDim; label: string; icon: string }[] = [
  { key: 'brand', label: 'Marca', icon: 'pi pi-tag' },
  { key: 'branch', label: 'Sucursal', icon: 'pi pi-building' },
  { key: 'channel', label: 'Canal', icon: 'pi pi-sitemap' },
];
const CMP_OPTS: { key: SellOutExplainCompare; label: string }[] = [
  { key: 'prev', label: 'Periodo anterior' },
  { key: 'yoy', label: 'Año anterior' },
];

/**
 * BI.3 — Sub-modulo "Analisis" (Sell-Out BI). "Explica el cambio": ante un delta,
 * descompone al centavo quien lo movio (marca/sucursal/canal), sobre el MISMO
 * SellOutReport verificado a factura. La venta es sumable -> el reparto es EXACTO.
 */
@Component({
  selector: 'app-comercial-analisis',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DatePickerModule, ToastModule, PageTabsComponent, MetricStripComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis</h1>
          <p>Explora la misma venta del Sell-Out — pero para responder qué cambió y por qué. Misma verdad que el reporte, otra forma de interrogarla.</p>
        </div>
      </header>

      <section class="an-filter">
        <label>
          <span>Mes</span>
          <p-datepicker [(ngModel)]="monthDate" view="month" dateFormat="MM yy" [showIcon]="true" [readonlyInput]="true" />
        </label>
        <label>
          <span>Explicar por</span>
          <div class="an-seg">
            @for (o of dimOpts; track o.key) {
              <button type="button" [class.on]="dim() === o.key" (click)="dim.set(o.key)"><i [class]="o.icon"></i>{{ o.label }}</button>
            }
          </div>
        </label>
        <label>
          <span>Comparar contra</span>
          <div class="an-seg">
            @for (o of cmpOpts; track o.key) {
              <button type="button" [class.on]="compare() === o.key" (click)="compare.set(o.key)">{{ o.label }}</button>
            }
          </div>
        </label>
        <button pButton type="button" label="Generar" icon="pi pi-play" (click)="generate()" [loading]="loading()"></button>
      </section>

      @if (report(); as r) {
        <app-metric-strip [items]="kpiItems()" />
      }

      @if (explain(); as e) {
        <section class="an-explain card-premium">
          <header class="an-explain-head">
            <div>
              <h2>Explica el cambio</h2>
              <span class="an-sub">{{ dimLabel() }} · vs {{ e.compare === 'yoy' ? 'año anterior' : 'periodo anterior' }} ({{ e.mirror.from }} → {{ e.mirror.to }})</span>
            </div>
            <div class="an-total" [class.up]="e.total.delta > 0" [class.down]="e.total.delta < 0">
              <i [class]="e.total.delta > 0 ? 'pi pi-arrow-up' : e.total.delta < 0 ? 'pi pi-arrow-down' : 'pi pi-minus'"></i>
              <strong>{{ signed(e.total.delta) }}</strong>
              @if (e.total.delta_pct !== null) { <em>{{ e.total.delta_pct > 0 ? '+' : '' }}{{ e.total.delta_pct.toFixed(1) }}%</em> }
            </div>
          </header>

          <p class="an-narrative">{{ e.narrative }}</p>

          <ul class="an-movers">
            @for (m of e.movers; track m.key) {
              <li>
                <span class="an-m-label">
                  {{ m.label }}
                  @if (m.kind === 'perdido') { <span class="an-tag bad">dejó de vender</span> }
                  @else if (m.kind === 'nuevo') { <span class="an-tag ok">nuevo</span> }
                </span>
                <span class="an-m-bar">
                  <span class="an-m-fill" [class.up]="m.delta > 0" [class.down]="m.delta < 0" [style.width.%]="barPct(m.delta)"></span>
                </span>
                <span class="an-m-delta" [class.up]="m.delta > 0" [class.down]="m.delta < 0">{{ signed(m.delta) }}</span>
                <span class="an-m-pct" [class.up]="m.delta > 0" [class.down]="m.delta < 0">
                  @if (m.delta_pct !== null) {
                    <i [class]="m.delta > 0 ? 'pi pi-arrow-up' : 'pi pi-arrow-down'"></i>{{ m.delta_pct > 0 ? '+' : '' }}{{ m.delta_pct.toFixed(0) }}%
                  } @else { — }
                </span>
              </li>
            }
            @if (e.otros.count > 0) {
              <li class="an-otros">
                <span class="an-m-label">Otros ({{ e.otros.count }})</span>
                <span class="an-m-bar"></span>
                <span class="an-m-delta" [class.up]="e.otros.delta > 0" [class.down]="e.otros.delta < 0">{{ signed(e.otros.delta) }}</span>
                <span class="an-m-pct"></span>
              </li>
            }
          </ul>
          <p class="an-foot"><i class="pi pi-verified"></i> Reparto exacto: la suma de los movimientos es el cambio total, al centavo. Misma venta verificada del Sell-Out.</p>
        </section>
      } @else {
        <section class="an-empty">
          <i class="pi pi-chart-bar"></i>
          <p>Elige un mes y una dimensión, y genera para ver qué explica el cambio de la venta.</p>
        </section>
      }

      <section class="an-grid">
        <article class="an-card">
          <i class="pi pi-comments"></i>
          <h3>Pregúntale al Sell-Out</h3>
          <p>En español: "¿por qué bajó Padre Hidalgo en agosto?", "top 5 marcas que cayeron vs julio". Números del modelo, no inventados.</p>
          <span class="an-soon">Próximamente · BI.5</span>
        </article>
        <article class="an-card">
          <i class="pi pi-bell"></i>
          <h3>Radar</h3>
          <p>El tablero te avisa qué se movió raro sin que preguntes: caídas contra el promedio, marcas que aparecen o desaparecen.</p>
          <span class="an-soon">Próximamente · BI.6</span>
        </article>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .an-filter { display: flex; align-items: flex-end; gap: 1rem; margin: 0 0 1.25rem; flex-wrap: wrap; }
    .an-filter label { display: flex; flex-direction: column; gap: .35rem; }
    .an-filter label > span { font-size: .72rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
    .an-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: 10px; overflow: hidden; }
    .an-seg button { border: 0; background: transparent; padding: .5rem .85rem; font-size: .85rem; cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; }
    .an-seg button + button { border-left: 1px solid var(--border-color); }
    .an-seg button.on { background: var(--action, #d9772e); color: #fff; }
    .an-explain { padding: 1.25rem 1.5rem; margin-top: .5rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); background: var(--surface-card, #fff); }
    .an-explain-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .an-explain-head h2 { margin: 0; font-size: 1.15rem; }
    .an-sub { font-size: .8rem; color: var(--text-muted); }
    .an-total { display: inline-flex; align-items: baseline; gap: .4rem; font-variant-numeric: tabular-nums; }
    .an-total strong { font-size: 1.4rem; }
    .an-total em { font-style: normal; font-size: .9rem; opacity: .85; }
    .an-total.up, .an-m-delta.up, .an-m-pct.up { color: var(--success-fg, #2e7d32); }
    .an-total.down, .an-m-delta.down, .an-m-pct.down { color: var(--danger-fg, #c0392b); }
    .an-narrative { margin: 1rem 0 1.25rem; font-size: 1rem; line-height: 1.5; color: var(--text-color); }
    .an-movers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .an-movers li { display: grid; grid-template-columns: minmax(140px, 1.4fr) minmax(80px, 2fr) minmax(90px, auto) 62px; align-items: center; gap: .75rem; font-variant-numeric: tabular-nums; }
    .an-m-label { font-size: .9rem; display: flex; align-items: center; gap: .45rem; }
    .an-tag { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; padding: .1rem .4rem; border-radius: 6px; }
    .an-tag.bad { background: var(--danger-bg, #fdecea); color: var(--danger-fg, #c0392b); }
    .an-tag.ok { background: var(--success-bg, #e8f5e9); color: var(--success-fg, #2e7d32); }
    .an-m-bar { height: 10px; background: var(--surface-hover, #f0ede8); border-radius: 5px; overflow: hidden; }
    .an-m-fill { display: block; height: 100%; border-radius: 5px; }
    .an-m-fill.up { background: var(--success-fg, #2e7d32); }
    .an-m-fill.down { background: var(--danger-fg, #c0392b); }
    .an-m-delta { text-align: right; font-size: .9rem; font-weight: 600; }
    .an-m-pct { text-align: right; font-size: .8rem; display: inline-flex; align-items: center; gap: .2rem; justify-content: flex-end; }
    .an-otros { opacity: .7; }
    .an-foot { margin: 1.25rem 0 0; font-size: .78rem; color: var(--text-muted); display: flex; align-items: center; gap: .4rem; }
    .an-empty { display: flex; flex-direction: column; align-items: center; gap: .6rem; padding: 3rem 1rem; color: var(--text-muted); text-align: center; }
    .an-empty > i { font-size: 2rem; opacity: .5; }
    .an-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .an-card { border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); padding: 1.25rem; background: var(--surface-card, #fff); display: flex; flex-direction: column; gap: .5rem; }
    .an-card > i { font-size: 1.4rem; color: var(--text-muted); }
    .an-card h3 { margin: 0; font-size: 1rem; }
    .an-card p { margin: 0; font-size: .85rem; color: var(--text-muted); line-height: 1.45; }
    .an-soon { margin-top: auto; font-size: .72rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--text-muted); opacity: .8; }
  `],
})
export class ComercialAnalisisComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly reportTabs = REPORTS_TABS;
  readonly dimOpts = DIM_OPTS;
  readonly cmpOpts = CMP_OPTS;
  monthDate: Date = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  readonly dim = signal<SellOutExplainDim>('brand');
  readonly compare = signal<SellOutExplainCompare>('prev');
  readonly report = signal<SellOutReport | null>(null);
  readonly explain = signal<SellOutExplainReport | null>(null);
  readonly loading = signal(false);

  private readonly fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

  readonly dimLabel = computed(() => this.dimOpts.find((o) => o.key === this.dim())?.label ?? '');

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    return [
      { label: 'Monto total', value: r.grand_total.monto, format: 'currency', sub: 'Sell-out del periodo' },
      { label: 'Cajas', value: r.grand_total.cajas, format: 'decimal1', sub: 'Unidades ÷ UXC' },
      { label: 'Empresas', value: r.rows.length, sub: 'Con venta' },
      { label: 'Sucursales', value: r.coverage.branches_with_data.length, sub: r.columns.length + ' columnas' },
    ];
  });

  private maxAbs = 1;

  generate() {
    const d = this.monthDate;
    if (!d) { this.toast.add({ severity: 'warn', summary: 'Selecciona un mes' }); return; }
    const from = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
    const to = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    this.loading.set(true);
    forkJoin({
      report: this.svc.sellOut({ from, to }),
      explain: this.svc.sellOutExplain({ from, to, dim: this.dim(), compare: this.compare() }),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ report, explain }) => {
          this.report.set(report);
          this.maxAbs = Math.max(1, ...explain.movers.map((m) => Math.abs(m.delta)));
          this.explain.set(explain);
          this.loading.set(false);
        },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo generar el análisis' }); },
      });
  }

  barPct(delta: number): number {
    return Math.max(2, Math.round((Math.abs(delta) / this.maxAbs) * 100));
  }

  signed(n: number): string {
    return (n >= 0 ? '+' : '-') + this.fmt.format(Math.abs(n)).replace('MX$', '$');
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
