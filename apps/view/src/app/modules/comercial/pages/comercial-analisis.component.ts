import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { ChartModule } from 'primeng/chart';
import { MessageService } from 'primeng/api';
import { getChartTokens } from '../../../shared/theme/chart-theme';
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
  SelloutSeriesReport,
  SelloutParetoReport,
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
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { SelloutTargetsReport, SelloutTargetRow } from '../comercial.service';
import type { Freshness, FreshnessInput } from '@megadulces/contracts';

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
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, DatePickerModule, ToastModule, ChartModule, PageTabsComponent, MetricStripComponent],
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

      <!--
        [VP.2.2] La edad del dato, ARRIBA de los números y no debajo.
        Esta pantalla ya recibía la frescura en SellOutExplainReport desde VP.0.3 y no la pintaba:
        el primitivo llegaba correcto al navegador y moría ahí. Es la misma falla de VP.0.1 —
        declarar sin mostrar— una capa más arriba, y acá pesa más que en el reporte: el Radar juzga
        un mes CONTRA el promedio de los previos, así que un rollup que se saltó corridas no da una
        cifra "un poco vieja", da una caída inventada. Un aviso debajo de la gráfica llega después
        de que alguien ya la leyó.
      -->
      @if (dataFreshness(); as f) {
        <p class="an-note an-note-stale" role="status">
          <i class="pi" [class.pi-clock]="f.status === 'stale'" [class.pi-question-circle]="f.status === 'unknown'"></i>
          @if (f.status === 'stale') {
            <strong>Datos de hace {{ f.age_human }}</strong> — el consolidado nocturno no corrió. Las comparaciones contra meses previos pueden mostrar caídas que no ocurrieron.
          } @else {
            <strong>No se pudo verificar qué tan actual es este análisis.</strong> No es lo mismo que estar al día.
          }
          @if (staleLanes().length) {
            <span class="an-note-lanes">
              @for (i of staleLanes(); track i.key) {
                {{ i.label }}: {{ i.age_human || 'sin señal' }}{{ $last ? '' : ' · ' }}
              }
            </span>
          }
        </p>
      }

      @if (report(); as r) {
        <app-metric-strip [items]="kpiItems()" mode="spark" />
      }

      @if (targets(); as tg) {
        <section class="an-targets card-premium">
          <header class="an-targets-head">
            <h2><i class="pi pi-flag"></i> Objetivos · {{ tg.month }}</h2>
            @if (canEditTargets()) {
              <button type="button" class="an-tgt-editbtn" (click)="editTargets.set(!editTargets())">
                <i class="pi" [class.pi-pencil]="!editTargets()" [class.pi-check]="editTargets()"></i> {{ editTargets() ? 'Listo' : 'Editar metas' }}
              </button>
            }
          </header>
          <div class="an-tgt-row head t-{{ tgtTone(tg.total) }}">
            <span class="an-tgt-label"><strong>{{ tg.total.label }}</strong></span>
            <span class="an-tgt-bar"><span class="an-tgt-fill" [style.width.%]="tgtBarPct(tg.total)"></span></span>
            <span class="an-tgt-nums">
              <b>{{ money(tg.total.actual) }}</b>
              @if (editTargets()) { <span class="an-tgt-in">/ <input type="number" [value]="tg.total.target || ''" (change)="saveTarget(tg.total, $any($event.target).value)" placeholder="meta" /></span> }
              @else if (tg.total.target > 0) { <span class="an-tgt-meta">/ {{ money(tg.total.target) }}</span> }
              @else { <span class="an-tgt-nometa">sin meta</span> }
            </span>
            <span class="an-tgt-pct t-{{ tgtTone(tg.total) }}">{{ tg.total.pct == null ? '—' : (tg.total.pct.toFixed(0) + '%') }}</span>
          </div>
          @if (tg.branches.length) {
            <h3 class="an-tgt-sub">Por sucursal</h3>
            @for (r of tg.branches; track r.scope_key) {
              <div class="an-tgt-row t-{{ tgtTone(r) }}">
                <span class="an-tgt-label">{{ r.label }}</span>
                <span class="an-tgt-bar"><span class="an-tgt-fill" [style.width.%]="tgtBarPct(r)"></span></span>
                <span class="an-tgt-nums">
                  <b>{{ money(r.actual) }}</b>
                  @if (editTargets()) { <span class="an-tgt-in">/ <input type="number" [value]="r.target || ''" (change)="saveTarget(r, $any($event.target).value)" placeholder="meta" /></span> }
                  @else if (r.target > 0) { <span class="an-tgt-meta">/ {{ money(r.target) }}</span> }
                  @else { <span class="an-tgt-nometa">sin meta</span> }
                </span>
                <span class="an-tgt-pct t-{{ tgtTone(r) }}">{{ r.pct == null ? '—' : (r.pct.toFixed(0) + '%') }}</span>
              </div>
            }
          }
          <p class="an-foot"><i class="pi pi-info-circle"></i> Cumplimiento = real ÷ meta. Sin meta capturada no hay % (no se inventa). @if (!canEditTargets()) { Para capturar metas necesitas el permiso de gestión.}</p>
        </section>
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
          @if (canSeeDocs()) {
            <a routerLink="/comercial/documentos" class="an-docs-link"><i class="pi pi-file"></i> Ver las facturas (Facturación TM) →</a>
          }
        </section>
      } @else {
        <section class="an-empty">
          <i class="pi pi-chart-bar"></i>
          <p>Elige un mes y una dimensión, y genera para ver qué explica el cambio de la venta.</p>
        </section>
      }

      @if (series() || pareto()) {
        <section class="an-charts">
          @defer (on viewport) {
            @if (trendData(); as td) {
              <div class="an-chart card-premium">
                <header class="an-chart-head"><h3><i class="pi pi-chart-line"></i> Tendencia · últimos 12 meses</h3></header>
                <div class="an-chart-box"><p-chart type="line" [data]="td" [options]="trendOpts()" height="240px"></p-chart></div>
              </div>
            }
            @if (paretoData(); as pd) {
              <div class="an-chart card-premium">
                <header class="an-chart-head"><h3><i class="pi pi-chart-bar"></i> Pareto — quién hace el 80% ({{ pareto()?.month }})</h3></header>
                <div class="an-chart-box"><p-chart type="bar" [data]="pd" [options]="paretoOpts()" height="240px"></p-chart></div>
                <p class="an-foot"><span class="an-abc a">A</span> hasta 80% · <span class="an-abc b">B</span> 80–95% · <span class="an-abc c">C</span> el resto</p>
              </div>
            }
          } @placeholder { <div class="an-chart-ph">Cargando gráficas…</div> }
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
    /* [VP.2.2] Condición del DATO, no de una acción: tono warn y sin botón de cerrar. Calca
       .so-note del Sell-Out — es el mismo aviso sobre la misma cadena de matvistas. */
    .an-note { font-size:.78rem; color:var(--text-muted); background:var(--layout-bg); border:1px solid var(--border-color);
      border-radius:var(--r-sm); padding:.5rem .7rem; margin:0 0 1rem; display:flex; gap:.4rem; align-items:baseline; flex-wrap:wrap; }
    .an-note-stale { color:var(--warn-fg); border-color:color-mix(in srgb, var(--warn-fg) 35%, var(--border-color)); }
    .an-note-stale strong { font-weight:700; }
    .an-note-lanes { flex-basis:100%; opacity:.85; font-size:var(--fs-xs,.72rem); padding-left:1.2rem; }
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
    .an-docs-link { display: inline-flex; align-items: center; gap: .4rem; margin-top: .6rem; font-size: .85rem; color: var(--action, #d9772e); text-decoration: none; }
    .an-docs-link:hover { text-decoration: underline; }
    .an-empty { display: flex; flex-direction: column; align-items: center; gap: .6rem; padding: 3rem 1rem; color: var(--text-muted); text-align: center; }
    .an-empty > i { font-size: 2rem; opacity: .5; }
    .an-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .an-card { border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); padding: 1.25rem; background: var(--surface-card, #fff); display: flex; flex-direction: column; gap: .5rem; }
    .an-card > i { font-size: 1.4rem; color: var(--text-muted); }
    .an-card h3 { margin: 0; font-size: 1rem; }
    .an-card p { margin: 0; font-size: .85rem; color: var(--text-muted); line-height: 1.45; }
    .an-soon { margin-top: auto; font-size: .72rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--text-muted); opacity: .8; }
    .an-targets { padding: 1.25rem 1.5rem; margin-top: 1.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); background: var(--surface-card, #fff); }
    .an-targets-head { display: flex; justify-content: space-between; align-items: center; }
    .an-targets-head h2 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: .5rem; }
    .an-tgt-editbtn { border: 1px solid var(--border-color); background: transparent; color: var(--action, #d9772e); padding: .35rem .7rem; border-radius: 8px; cursor: pointer; font-size: .82rem; display: inline-flex; align-items: center; gap: .35rem; }
    .an-tgt-sub { margin: 1rem 0 .5rem; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .an-tgt-row { display: grid; grid-template-columns: minmax(120px, 1.2fr) minmax(90px, 1.6fr) minmax(150px, auto) 56px; align-items: center; gap: .75rem; padding: .4rem 0; font-variant-numeric: tabular-nums; }
    .an-tgt-row.head { border-bottom: 1px solid var(--border-color); padding-bottom: .7rem; margin-bottom: .3rem; }
    .an-tgt-label { font-size: .9rem; }
    .an-tgt-bar { height: 8px; background: var(--surface-hover, #f0ede8); border-radius: 5px; overflow: hidden; }
    .an-tgt-fill { display: block; height: 100%; border-radius: 5px; background: var(--text-faint, #aaa); }
    .an-tgt-row.t-ok .an-tgt-fill { background: var(--success-fg, #2e7d32); }
    .an-tgt-row.t-warn .an-tgt-fill { background: var(--action, #d9772e); }
    .an-tgt-row.t-bad .an-tgt-fill { background: var(--danger-fg, #c0392b); }
    .an-tgt-nums { font-size: .88rem; display: flex; align-items: baseline; gap: .35rem; }
    .an-tgt-meta { color: var(--text-muted); }
    .an-tgt-nometa { color: var(--text-faint, #aaa); font-size: .78rem; font-style: italic; }
    .an-tgt-in input { width: 96px; border: 1px solid var(--border-color); border-radius: 6px; padding: .2rem .4rem; font-size: .82rem; }
    .an-tgt-pct { text-align: right; font-weight: 600; font-size: .9rem; }
    .an-tgt-pct.t-ok { color: var(--success-fg, #2e7d32); }
    .an-tgt-pct.t-warn { color: var(--action, #d9772e); }
    .an-tgt-pct.t-bad { color: var(--danger-fg, #c0392b); }
    .an-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .an-chart { padding: 1rem 1.25rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); background: var(--surface-card, #fff); }
    .an-chart-head h3 { margin: 0 0 .75rem; font-size: .95rem; display: flex; align-items: center; gap: .5rem; }
    .an-chart-box { height: 240px; }
    .an-chart-ph { padding: 2rem; color: var(--text-muted); text-align: center; }
    .an-abc { font-weight: 700; padding: 0 .25rem; border-radius: 4px; }
    .an-abc.a { color: var(--success-fg, #2e7d32); }
    .an-abc.b { color: var(--action, #d9772e); }
    .an-abc.c { color: var(--text-muted); }
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
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  // BI.9 — objetivos
  readonly targets = signal<SelloutTargetsReport | null>(null);
  readonly editTargets = signal(false);
  readonly canEditTargets = computed(() => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_SELLOUT_TARGETS_GESTIONAR]);
  // BI.7 — drill a factura: enlace a la pantalla optimizada de Facturacion TM (las vistas vivas
  // no aguantan una query por marca/mes en linea: 20s sin marca, >120s con marca). Solo si tiene el permiso.
  readonly canSeeDocs = computed(() => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_SALES_DOCS_VER]);

  tgtBarPct(r: SelloutTargetRow): number { return r.pct == null ? 0 : Math.max(0, Math.min(100, r.pct)); }
  tgtTone(r: SelloutTargetRow): string { return r.pct == null ? 'none' : r.pct >= 100 ? 'ok' : r.pct >= 70 ? 'warn' : 'bad'; }

  saveTarget(r: SelloutTargetRow, value: string) {
    const tg = this.targets();
    const n = Number(value);
    if (!tg || !Number.isFinite(n) || n < 0) return;
    this.svc
      .sellOutTargetUpsert({ scope: r.scope, scope_key: r.scope_key, year_month: tg.month, target_monto: n })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.svc.sellOutTargets(tg.month).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((t) => this.targets.set(t)),
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo guardar la meta' }),
      });
  }

  readonly reportTabs = REPORTS_TABS;
  readonly dimOpts = DIM_OPTS;
  readonly cmpOpts = CMP_OPTS;
  monthDate: Date = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  readonly dim = signal<SellOutExplainDim>('brand');
  readonly compare = signal<SellOutExplainCompare>('prev');
  readonly report = signal<SellOutReport | null>(null);
  readonly explain = signal<SellOutExplainReport | null>(null);
  readonly radar = signal<SelloutAnomaliesReport | null>(null);
  readonly series = signal<SelloutSeriesReport | null>(null);
  readonly pareto = signal<SelloutParetoReport | null>(null);
  readonly loading = signal(false);

  /**
   * [VP.2.2] La frescura de TODO lo que esta pantalla tiene cargado, en un solo aviso.
   *
   * Son cinco respuestas (explicación, metas, radar, tendencia, Pareto) sobre la MISMA cadena de
   * matvistas, así que cinco banners serían cinco copias del mismo hecho. Se toma la peor.
   *
   * La precedencia NO se inventa acá: es la de composeFreshness() en
   * libs/commercial/src/lib/shared/freshness.ts — **un eslabón medido y viejo gana el titular sobre
   * uno no medido**, porque tiene una edad concreta que mostrar; el no-medido queda de titular
   * cuando nada está medidamente viejo pero algo no se pudo medir. Reimplementarla con otro criterio
   * es cómo el dedup del sell-out terminó en 11 archivos que se separaron en silencio.
   *
   * Devuelve null cuando todo está fresco o nada está cargado, y entonces no se pinta nada: el aviso
   * aparece sólo cuando hay algo que declarar.
   */
  readonly dataFreshness = computed<Freshness | null>(() => {
    const fs = [this.explain()?.freshness, this.targets()?.freshness, this.radar()?.freshness,
      this.series()?.freshness, this.pareto()?.freshness].filter((f): f is Freshness => !!f);
    if (!fs.length) return null;
    const peor = fs.find((f) => f.status === 'stale') || fs.find((f) => f.status === 'unknown');
    return peor ?? null;
  });

  /** Los eslabones que fallan, deduplicados por clave: el aviso nombra algo accionable, no "hay rezago". */
  readonly staleLanes = computed(() => {
    const vistos = new Set<string>();
    const out: FreshnessInput[] = [];
    for (const f of [this.explain()?.freshness, this.targets()?.freshness, this.radar()?.freshness,
      this.series()?.freshness, this.pareto()?.freshness]) {
      for (const i of f?.inputs || []) {
        if (i.status !== 'fresh' && !vistos.has(i.key)) { vistos.add(i.key); out.push(i); }
      }
    }
    return out;
  });

  // BI.4 — configs de gráficas (theme-aware: getChartTokens lee los tokens vigentes).
  readonly trendData = computed<any>(() => {
    const s = this.series(); if (!s) return null;
    const t = getChartTokens();
    return { labels: s.months.map((m) => m.month), datasets: [{ label: 'Monto', data: s.months.map((m) => m.monto), borderColor: t.chart1, backgroundColor: t.chart1 + '22', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2 }] };
  });
  readonly trendOpts = computed<any>(() => {
    const t = getChartTokens();
    return { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: t.chartGrid }, ticks: { color: t.chartAxis, font: { size: 10 } } }, y: { grid: { color: t.chartGrid }, ticks: { color: t.chartAxis, callback: (v: any) => '$' + (Number(v) / 1e6).toFixed(1) + 'M' } } } };
  });
  readonly paretoData = computed<any>(() => {
    const p = this.pareto(); if (!p) return null;
    const t = getChartTokens();
    const colors = p.rows.map((r) => (r.abc === 'A' ? t.okFg : r.abc === 'B' ? t.chart1 : t.chart8));
    return { labels: p.rows.map((r) => r.label), datasets: [
      { type: 'bar', label: 'Monto', data: p.rows.map((r) => r.monto), backgroundColor: colors, order: 2, yAxisID: 'y' },
      { type: 'line', label: '% acumulado', data: p.rows.map((r) => r.cum_share), borderColor: t.chartMetaLine, borderWidth: 2, pointRadius: 0, yAxisID: 'y1', order: 1, tension: 0.2 },
    ] };
  });
  readonly paretoOpts = computed<any>(() => {
    const t = getChartTokens();
    return { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: {
      x: { grid: { display: false }, ticks: { color: t.chartAxis, font: { size: 9 }, maxRotation: 60, minRotation: 45 } },
      y: { grid: { color: t.chartGrid }, ticks: { color: t.chartAxis, callback: (v: any) => '$' + (Number(v) / 1e6).toFixed(1) + 'M' } },
      y1: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { color: t.chartAxis, callback: (v: any) => v + '%' } },
    } };
  });

  radarIcon(kind: string): string {
    return kind === 'perdido' ? 'pi pi-times-circle' : kind === 'nuevo' ? 'pi pi-star' : kind === 'pico' ? 'pi pi-arrow-up-right' : 'pi pi-arrow-down-right';
  }

  private readonly fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

  readonly dimLabel = computed(() => this.dimOpts.find((o) => o.key === this.dim())?.label ?? '');

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    const e = this.explain();
    const s = this.series();
    return [
      {
        label: 'Monto total', value: r.grand_total.monto, format: 'currency',
        delta: e ? e.total.delta_pct : null,                              // BI.1 — Δ vs periodo comparado
        series: s ? s.months.map((m) => m.monto) : undefined,            // BI.1 — sparkline 12m
        sub: e ? (this.compare() === 'yoy' ? 'vs año anterior' : 'vs periodo anterior') : 'Sell-out del periodo',
      },
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
    const month = from.slice(0, 7);
    forkJoin({
      report: this.svc.sellOut({ from, to }),
      explain: this.svc.sellOutExplain({ from, to, dim: this.dim(), compare: this.compare() }),
      radar: this.svc.sellOutAnomalies({ month, dim: 'brand' }),
      series: this.svc.sellOutSeries({ to_month: month, months: 12 }),
      pareto: this.svc.sellOutPareto({ month, dim: 'brand', n: 20 }),
      targets: this.svc.sellOutTargets(month),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ report, explain, radar, series, pareto, targets }) => {
          this.report.set(report);
          this.drill.set(null);
          this.explain.set(explain);
          this.radar.set(radar);
          this.series.set(series);
          this.pareto.set(pareto);
          this.targets.set(targets);
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

  money(n: number): string {
    return this.fmt.format(n).replace('MX$', '$');
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
