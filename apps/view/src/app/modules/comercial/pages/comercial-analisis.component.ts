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
  SellOutMover,
  SellOutExplainParams,
  SelloutChatBlock,
  SelloutAnomaliesReport,
} from '../comercial.service';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  blocks?: SelloutChatBlock[];
  suggestions?: string[];
}
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

      @if (activeExplain(); as e) {
        <section class="an-explain card-premium">
          @if (drill(); as dr) {
            <nav class="an-crumbs">
              <button type="button" (click)="backToRoot()"><i class="pi pi-arrow-left"></i> {{ dimLabel() }}</button>
              <i class="pi pi-angle-right"></i>
              <span>{{ dr.parentLabel }} · por {{ activeDimLabel() }}</span>
            </nav>
          }
          <header class="an-explain-head">
            <div>
              <h2>Explica el cambio</h2>
              <span class="an-sub">{{ activeDimLabel() }} · vs {{ e.compare === 'yoy' ? 'año anterior' : 'periodo anterior' }} ({{ e.mirror.from }} → {{ e.mirror.to }})</span>
            </div>
            <div class="an-total" [class.up]="e.total.delta > 0" [class.down]="e.total.delta < 0">
              <i [class]="e.total.delta > 0 ? 'pi pi-arrow-up' : e.total.delta < 0 ? 'pi pi-arrow-down' : 'pi pi-minus'"></i>
              <strong>{{ signed(e.total.delta) }}</strong>
              @if (e.total.delta_pct !== null) { <em>{{ e.total.delta_pct > 0 ? '+' : '' }}{{ e.total.delta_pct.toFixed(1) }}%</em> }
            </div>
          </header>

          <p class="an-narrative">{{ e.narrative }}</p>
          @if (drillLoading()) { <p class="an-sub"><i class="pi pi-spin pi-spinner"></i> Profundizando...</p> }

          <ul class="an-movers">
            @for (m of e.movers; track m.key) {
              <li [class.clickable]="drillable(m)" (click)="drillInto(m)">
                <span class="an-m-label">
                  @if (drillable(m)) { <i class="pi pi-angle-right an-drill-i"></i> }
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
          <p class="an-foot"><i class="pi pi-verified"></i> Reparto exacto: la suma de los movimientos es el cambio total, al centavo.@if (!drill()) {  Toca un renglón para ver qué lo explica.}</p>
        </section>
      } @else {
        <section class="an-empty">
          <i class="pi pi-chart-bar"></i>
          <p>Elige un mes y una dimensión, y genera para ver qué explica el cambio de la venta.</p>
        </section>
      }

      @if (radar(); as rd) {
        @if (rd.anomalies.length) {
          <section class="an-radar card-premium">
            <header class="an-radar-head">
              <h2><i class="pi pi-bell"></i> Radar</h2>
              <span class="an-sub">Lo que se movió raro en {{ rd.month }} vs su propio promedio ({{ rd.baseline_months.length }}m). Sin que preguntes.</span>
            </header>
            <ul class="an-radar-list">
              @for (a of rd.anomalies; track a.key) {
                <li [class]="'k-' + a.kind">
                  <i [class]="radarIcon(a.kind)"></i>
                  <div class="an-radar-txt">
                    <strong>{{ a.label }}</strong>
                    <span>{{ a.reason }}</span>
                  </div>
                  <span class="an-radar-dev" [class.up]="a.deviation > 0" [class.down]="a.deviation < 0">{{ signed(a.deviation) }}</span>
                </li>
              }
            </ul>
          </section>
        }
      }

      <section class="an-chat card-premium">
        <header class="an-chat-head">
          <h2><i class="pi pi-comments"></i> Pregúntale al Sell-Out</h2>
          <span class="an-sub">En español. Los números salen del modelo verificado, no se inventan.</span>
        </header>

        <div class="an-chat-body">
          @for (m of chatMsgs(); track $index) {
            <div class="an-msg" [class.user]="m.role === 'user'">
              <div class="an-msg-text" [innerHTML]="mdLite(m.content)"></div>
              @for (b of (m.blocks || []); track $index) {
                @if (asTable(b); as t) {
                  <div class="an-block">
                    <table>
                      <thead><tr>@for (c of t.columns; track $index) { <th>{{ c }}</th> }</tr></thead>
                      <tbody>
                        @for (row of t.data; track $index) {
                          <tr>@for (cell of row; track $index) { <td>{{ fmtCell(cell) }}</td> }</tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              }
              @if (m.suggestions?.length) {
                <div class="an-chips">
                  @for (s of m.suggestions; track $index) {
                    <button type="button" (click)="ask(s)">{{ s }}</button>
                  }
                </div>
              }
            </div>
          }
          @if (chatLoading()) { <div class="an-msg"><div class="an-msg-text"><i class="pi pi-spin pi-spinner"></i> Consultando la venta...</div></div> }
          @if (!chatMsgs().length && !chatLoading()) {
            <div class="an-chat-empty">
              <p>Prueba con:</p>
              <div class="an-chips">
                <button type="button" (click)="ask('¿Cuánto vendimos en agosto 2026?')">¿Cuánto vendimos en agosto?</button>
                <button type="button" (click)="ask('Top 5 empresas de agosto 2026')">Top 5 empresas</button>
                <button type="button" (click)="ask('¿Por qué cambió la venta de agosto vs julio 2026, por marca?')">¿Por qué cambió agosto vs julio?</button>
              </div>
            </div>
          }
        </div>

        <div class="an-chat-input">
          <input type="text" [(ngModel)]="chatInput" (keydown.enter)="ask(chatInput)" placeholder="Escribe tu pregunta sobre la venta..." [disabled]="chatLoading()" />
          <button pButton type="button" icon="pi pi-send" (click)="ask(chatInput)" [disabled]="chatLoading() || !chatInput.trim()"></button>
        </div>
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
    .an-crumbs { display: flex; align-items: center; gap: .5rem; margin-bottom: .75rem; font-size: .85rem; color: var(--text-muted); }
    .an-crumbs button { border: 0; background: transparent; color: var(--action, #d9772e); cursor: pointer; font-size: .85rem; display: inline-flex; align-items: center; gap: .3rem; padding: 0; }
    .an-movers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .an-movers li.clickable { cursor: pointer; border-radius: 8px; margin: 0 -.5rem; padding: .15rem .5rem; }
    .an-movers li.clickable:hover { background: var(--surface-hover, #f0ede8); }
    .an-drill-i { font-size: .75rem; color: var(--text-muted); margin-right: .1rem; }
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
    .an-radar { padding: 1.25rem 1.5rem; margin-top: 1.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); background: var(--surface-card, #fff); }
    .an-radar-head h2 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: .5rem; }
    .an-radar-list { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .an-radar-list li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .75rem; padding: .55rem .7rem; border: 1px solid var(--border-color); border-radius: 10px; }
    .an-radar-list li > i { font-size: 1.05rem; }
    .an-radar-list li.k-caida > i, .an-radar-list li.k-perdido > i { color: var(--danger-fg, #c0392b); }
    .an-radar-list li.k-pico > i, .an-radar-list li.k-nuevo > i { color: var(--success-fg, #2e7d32); }
    .an-radar-txt { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
    .an-radar-txt strong { font-size: .92rem; }
    .an-radar-txt span { font-size: .82rem; color: var(--text-muted); }
    .an-radar-dev { font-variant-numeric: tabular-nums; font-weight: 600; font-size: .9rem; }
    .an-radar-dev.up { color: var(--success-fg, #2e7d32); }
    .an-radar-dev.down { color: var(--danger-fg, #c0392b); }
    .an-chat { padding: 1.25rem 1.5rem; margin-top: 1.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); background: var(--surface-card, #fff); }
    .an-chat-head h2 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: .5rem; }
    .an-chat-body { margin: 1rem 0; display: flex; flex-direction: column; gap: .85rem; max-height: 440px; overflow-y: auto; }
    .an-msg { max-width: 92%; }
    .an-msg.user { align-self: flex-end; background: var(--action, #d9772e); color: #fff; padding: .5rem .85rem; border-radius: 12px 12px 2px 12px; }
    .an-msg-text { font-size: .92rem; line-height: 1.5; }
    .an-msg:not(.user) .an-msg-text { color: var(--text-color); }
    .an-block { margin: .6rem 0; overflow-x: auto; }
    .an-block table { border-collapse: collapse; font-size: .82rem; font-variant-numeric: tabular-nums; width: 100%; }
    .an-block th, .an-block td { border-bottom: 1px solid var(--border-color); padding: .3rem .6rem; text-align: left; }
    .an-block th { color: var(--text-muted); font-weight: 600; }
    .an-block td:not(:first-child), .an-block th:not(:first-child) { text-align: right; }
    .an-chips { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .6rem; }
    .an-chips button { border: 1px solid var(--border-color); background: transparent; color: var(--text-color); padding: .35rem .7rem; border-radius: 999px; font-size: .8rem; cursor: pointer; }
    .an-chips button:hover { border-color: var(--action, #d9772e); }
    .an-chat-empty { color: var(--text-muted); font-size: .9rem; }
    .an-chat-input { display: flex; gap: .5rem; }
    .an-chat-input input { flex: 1; border: 1px solid var(--border-color); border-radius: 10px; padding: .6rem .85rem; font-size: .92rem; background: var(--surface-ground, #fff); color: var(--text-color); }
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
  readonly radar = signal<SelloutAnomaliesReport | null>(null);
  readonly loading = signal(false);

  radarIcon(kind: string): string {
    return kind === 'perdido' ? 'pi pi-times-circle' : kind === 'nuevo' ? 'pi pi-star' : kind === 'pico' ? 'pi pi-arrow-up-right' : 'pi pi-arrow-down-right';
  }

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

  // BI.2 — drill navegable: clic en un mover -> descompone ESE cambio por la
  // siguiente dimensión, acotado al miembro. Breadcrumb para regresar.
  readonly drill = signal<{ parentLabel: string; report: SellOutExplainReport } | null>(null);
  readonly drillLoading = signal(false);
  readonly activeExplain = computed(() => this.drill()?.report ?? this.explain());
  readonly activeDimLabel = computed(() => this.dimOpts.find((o) => o.key === this.activeExplain()?.dimension)?.label ?? '');
  private readonly maxAbsSig = computed(() => Math.max(1, ...((this.activeExplain()?.movers ?? []).map((m) => Math.abs(m.delta)))));

  generate() {
    const d = this.monthDate;
    if (!d) { this.toast.add({ severity: 'warn', summary: 'Selecciona un mes' }); return; }
    const from = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
    const to = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    this.loading.set(true);
    forkJoin({
      report: this.svc.sellOut({ from, to }),
      explain: this.svc.sellOutExplain({ from, to, dim: this.dim(), compare: this.compare() }),
      radar: this.svc.sellOutAnomalies({ month: from.slice(0, 7), dim: 'brand' }),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ report, explain, radar }) => {
          this.report.set(report);
          this.drill.set(null);
          this.explain.set(explain);
          this.radar.set(radar);
          this.loading.set(false);
        },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo generar el análisis' }); },
      });
  }

  private nextDimFor(dim?: SellOutExplainDim): SellOutExplainDim | null {
    if (dim === 'brand') return 'branch';
    if (dim === 'branch') return 'brand';
    if (dim === 'channel') return 'brand';
    return null;
  }

  drillable(m: SellOutMover): boolean {
    return !this.drill() && m.key !== '__none__' && m.delta !== 0 && this.nextDimFor(this.explain()?.dimension) !== null;
  }

  drillInto(m: SellOutMover) {
    if (!this.drillable(m)) return;
    const e = this.explain();
    const next = this.nextDimFor(e?.dimension);
    if (!e || !next) return;
    const scope: Partial<SellOutExplainParams> = {};
    if (e.dimension === 'brand') scope.brand_id = m.key;
    else if (e.dimension === 'branch') scope.warehouses = [m.key];
    else if (e.dimension === 'channel') scope.channel = m.key;
    this.drillLoading.set(true);
    this.svc
      .sellOutExplain({ from: e.period.from, to: e.period.to, dim: next, compare: e.compare, ...scope })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.drill.set({ parentLabel: m.label, report: r }); this.drillLoading.set(false); },
        error: () => { this.drillLoading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo profundizar' }); },
      });
  }

  backToRoot() { this.drill.set(null); }

  barPct(delta: number): number {
    return Math.max(2, Math.round((Math.abs(delta) / this.maxAbsSig()) * 100));
  }

  // ── BI.5 chat ──
  readonly chatMsgs = signal<ChatMsg[]>([]);
  readonly chatLoading = signal(false);
  chatInput = '';

  ask(text: string) {
    const message = (text || '').trim();
    if (!message || this.chatLoading()) return;
    const history = this.chatMsgs().map((m) => ({ role: m.role, content: m.content }));
    this.chatMsgs.update((ms) => [...ms, { role: 'user', content: message }]);
    this.chatInput = '';
    this.chatLoading.set(true);
    this.svc
      .sellOutAsk({ message, history })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.chatMsgs.update((ms) => [...ms, { role: 'assistant', content: r.narrative, blocks: r.blocks, suggestions: r.suggestions }]);
          this.chatLoading.set(false);
        },
        error: () => {
          this.chatMsgs.update((ms) => [...ms, { role: 'assistant', content: 'No pude responder en este momento. Intenta de nuevo.' }]);
          this.chatLoading.set(false);
        },
      });
  }

  /** Un bloque de tool con formato columnar {columns,data} -> tabla. */
  asTable(b: SelloutChatBlock): { columns: string[]; data: any[][] } | null {
    const r = b?.result;
    return r && Array.isArray(r.columns) && Array.isArray(r.data) && r.data.length ? { columns: r.columns, data: r.data } : null;
  }

  fmtCell(cell: any): string {
    if (cell === null || cell === undefined) return '—';
    if (typeof cell === 'number') return cell.toLocaleString('es-MX');
    return String(cell);
  }

  /** Markdown ligero y seguro (escapa HTML, negritas y saltos). */
  mdLite(s: string): string {
    const esc = (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }

  signed(n: number): string {
    return (n >= 0 ? '+' : '-') + this.fmt.format(Math.abs(n)).replace('MX$', '$');
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
