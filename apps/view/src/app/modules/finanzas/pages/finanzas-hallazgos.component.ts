import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FindingsService, Finding, FindingsStats, RuleHealth, FindingClase, Coverage, DataQuality, Hypothesis, ModelStatus, Backtest, UncertainRow } from '../findings.service';
import { ActionsService, ProposedAction } from '../actions.service';

/**
 * MAAT.2 — Bandeja de hallazgos (motor de patrones). Superficie Operations:
 * KPIs + filtros + tabla densa con triage (confirmar/descartar = feedback que
 * entrena la precisión de la regla) + evidencia + link a la póliza. Panel de
 * salud de reglas (precisión, auto-supresión, pin).
 */
@Component({
  selector: 'app-finanzas-hallazgos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, PageTabsComponent, MetricStripComponent, ContextHelpComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in fh-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head fh-head">
        <div class="surf-page-head-text">
          <div style="display:inline-flex;align-items:center;gap:.4rem"><h1>Hallazgos</h1><app-context-help topic="hallazgos" /></div>
          <p class="surf-page-sub">Patrones que el motor detecta en los libros: riesgos, errores de captura y oportunidades. Confirma o descarta — Maat aprende de cada veredicto.</p>
        </div>
        <div class="fh-head-actions">
          <button pButton type="button" [label]="rulesOpen() ? 'Ocultar reglas' : 'Reglas'" icon="pi pi-sliders-h" class="p-button-sm p-button-text" (click)="rulesOpen.set(!rulesOpen())"></button>
          <button pButton type="button" label="Escanear ahora" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"></button>
        </div>
      </header>

      <!-- Switcher de vistas (MAAT-IQ) -->
      <div class="fh-viewseg" role="tablist">
        <button role="tab" [attr.aria-selected]="view()==='hallazgos'" [class.active]="view()==='hallazgos'" (click)="setView('hallazgos')"><i class="pi pi-flag"></i> Hallazgos</button>
        <button role="tab" [attr.aria-selected]="view()==='cobertura'" [class.active]="view()==='cobertura'" (click)="setView('cobertura')"><i class="pi pi-shield"></i> Cobertura</button>
        <button role="tab" [attr.aria-selected]="view()==='calidad'" [class.active]="view()==='calidad'" (click)="setView('calidad')"><i class="pi pi-database"></i> Calidad de datos</button>
        <button role="tab" [attr.aria-selected]="view()==='descubrimiento'" [class.active]="view()==='descubrimiento'" (click)="setView('descubrimiento')"><i class="pi pi-compass"></i> Descubrimiento</button>
        <button role="tab" [attr.aria-selected]="view()==='modelo'" [class.active]="view()==='modelo'" (click)="setView('modelo')"><i class="pi pi-sparkles"></i> Modelo</button>
      </div>

      @if (view() === 'hallazgos') {
      <!-- KPIs -->
      @if (stats(); as s) {
        <app-metric-strip [items]="kpiItems(s)" ariaLabel="Resumen de hallazgos" />
      }

      <!-- Acciones propuestas por Maat (HITL — aprobar/rechazar) -->
      @if (actions().length) {
        <div class="card-premium card-flat fh-actions">
          <h3 class="fh-card-title"><i class="pi pi-bolt" aria-hidden="true"></i> Acciones propuestas por Maat <span class="muted">({{ actions().length }} pendiente{{ actions().length === 1 ? '' : 's' }} de aprobación)</span></h3>
          @for (a of actions(); track a.id) {
            <div class="fh-action">
              <div class="fh-action-body">
                <span class="fh-action-titulo">{{ a.titulo }}</span>
                @if (a.descripcion) { <span class="fh-action-desc">{{ a.descripcion }}</span> }
                @if (a.efecto) { <span class="fh-action-efecto"><i class="pi pi-arrow-right"></i> {{ a.efecto }}</span> }
              </div>
              <div class="fh-action-acts">
                <button pButton type="button" icon="pi pi-check" label="Aprobar" class="p-button-sm p-button-success" (click)="approve(a)"></button>
                <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-text p-button-danger" title="Rechazar" (click)="reject(a)"></button>
              </div>
            </div>
          }
        </div>
      }

      <!-- Panel de salud de reglas -->
      @if (rulesOpen()) {
        <div class="card-premium card-flat fh-rules">
          <h3 class="fh-card-title">Salud de las reglas <span class="muted">(precisión = confirmados / veredictos)</span></h3>
          <p-table [value]="rules()" styleClass="p-datatable-sm" [rowHover]="true">
            <ng-template pTemplate="header">
              <tr><th>Regla</th><th>Clase</th><th class="ta-r">Hallazgos</th><th class="ta-r">✓ / ✗</th><th class="ta-r">Precisión</th><th>Estado</th><th style="width:5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr [class.fh-suppressed]="r.suppressed_auto">
                <td>{{ r.nombre }}</td>
                <td><span class="fh-tag" [ngClass]="'cls-' + r.clase">{{ claseLabel(r.clase) }}</span></td>
                <td class="ta-r">{{ r.findings_total | number }}</td>
                <td class="ta-r muted">{{ r.findings_confirmados }} / {{ r.findings_falsos }}</td>
                <td class="ta-r" [class.bad]="r.precision_score != null && r.precision_score < 0.3">{{ r.precision_score != null ? (r.precision_score * 100 | number:'1.0-0') + '%' : '—' }}</td>
                <td>
                  @if (r.suppressed_auto) { <span class="fh-tag cls-off">auto-suprimida</span> }
                  @else if (!r.enabled) { <span class="fh-tag cls-off">off</span> }
                  @else if (r.pinned) { <span class="fh-tag cls-pin">fijada</span> }
                  @else { <span class="muted">activa</span> }
                </td>
                <td class="ta-r"><button pButton type="button" [icon]="r.pinned ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'" class="p-button-text p-button-sm" [title]="r.pinned ? 'Desfijar' : 'Fijar (nunca auto-suprimir)'" (click)="pin(r)"></button></td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- Filtros -->
      <div class="fh-filters">
        <div class="fh-seg">
          <button [class.active]="clase() === null" (click)="setClase(null)">Todos</button>
          <button [class.active]="clase() === 'riesgo'" (click)="setClase('riesgo')">Riesgo</button>
          <button [class.active]="clase() === 'error_captura'" (click)="setClase('error_captura')">Errores</button>
          <button [class.active]="clase() === 'oportunidad'" (click)="setClase('oportunidad')">Oportunidad</button>
        </div>
        <div class="fh-seg">
          <button [class.active]="status() === 'pendientes'" (click)="setStatus('pendientes')">Pendientes</button>
          <button [class.active]="status() === 'confirmado'" (click)="setStatus('confirmado')">Confirmados</button>
          <button [class.active]="status() === 'descartado'" (click)="setStatus('descartado')">Descartados</button>
        </div>
      </div>

      <!-- Tabla de hallazgos -->
      @if (error()) {
        <app-load-state [error]="error()" (retry)="reload()"></app-load-state>
      } @else {
      <div class="card-premium card-flat">
        <p-table [value]="findings()" styleClass="p-datatable-sm fh-table" [rowHover]="true" [loading]="loading()"
                 dataKey="id" [expandedRowKeys]="expanded()" [scrollable]="true" scrollHeight="560px" [paginator]="findings().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr><th style="width:2.5rem"></th><th style="width:6rem">Severidad</th><th>Hallazgo</th><th style="width:8rem">Clase</th><th class="ta-r" style="width:9rem">Importe</th><th style="width:13rem">Acciones</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-f let-expanded="expanded">
            <tr>
              <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" (click)="toggle(f)"></button></td>
              <td><span class="fh-sev" [ngClass]="'sev-' + f.severity">{{ sevLabel(f.severity) }}</span></td>
              <td>
                <div class="fh-titulo">{{ f.titulo }}</div>
                <div class="fh-resumen">{{ f.resumen }}</div>
              </td>
              <td><span class="fh-tag" [ngClass]="'cls-' + f.clase">{{ claseLabel(f.clase) }}</span></td>
              <td class="ta-r strong">{{ money(f.importe) }}</td>
              <td>
                <div class="fh-acts">
                  @if (docUrl(f); as u) { <button pButton type="button" icon="pi pi-external-link" class="p-button-text p-button-sm" title="Ver póliza" (click)="go(u)"></button> }
                  @if (f.status === 'nuevo' || f.status === 'en_revision') {
                    <button pButton type="button" icon="pi pi-check" label="Confirmar" class="p-button-sm p-button-success p-button-text" [disabled]="pending().has(f.id)" (click)="verdict(f, 'util')" title="Es real y útil" aria-label="Confirmar hallazgo"></button>
                    <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-danger p-button-text" [disabled]="pending().has(f.id)" (click)="verdict(f, 'falso')" title="Falso positivo" aria-label="Descartar como falso positivo"></button>
                  } @else {
                    <span class="fh-status" [ngClass]="'st-' + f.status">{{ statusLabel(f.status) }}</span>
                  }
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-f>
            <tr><td colspan="6" class="fh-ev">
              <div class="fh-ev-grid">
                @for (kv of evidenceRows(f); track kv.k) { <div><span class="fh-ev-k">{{ kv.k }}</span><span class="fh-ev-v mono">{{ kv.v }}</span></div> }
              </div>
              <div class="fh-ev-meta muted">Regla: {{ f.regla || f.rule_key }} · detectado {{ f.first_seen | date:'dd/MM/yy' }} · visto {{ f.last_seen | date:'dd/MM/yy' }}</div>
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="fh-empty">
            @if (loading()) { Cargando… } @else { Sin hallazgos {{ status() === 'pendientes' ? 'pendientes' : '' }}. Corre "Escanear ahora" o revisa otro filtro. }
          </td></tr></ng-template>
        </p-table>
      </div>
      }
      }

      @else if (view() === 'cobertura') {
        <div class="card-premium card-flat fh-panel">
          <div class="fh-panel-head">
            <h3 class="fh-card-title">Cobertura por categoría de riesgo <span class="muted">(¿qué NO estamos vigilando?)</span></h3>
            @if (coverage(); as c) { <span class="fh-cov-pct" [class.bad]="c.puntos_ciegos.length > 0">{{ c.cobertura_pct }}% cubierto · {{ c.puntos_ciegos.length }} punto(s) ciego(s)</span> }
          </div>
          @if (coverage(); as c) {
            <p-table [value]="c.categorias" styleClass="p-datatable-sm" [rowHover]="true">
              <ng-template pTemplate="header"><tr><th>Categoría</th><th class="ta-r" style="width:7rem">Activos</th><th class="ta-r" style="width:7rem">Hallazgos</th><th style="width:11rem">Estado</th></tr></ng-template>
              <ng-template pTemplate="body" let-cat>
                <tr [class.fh-blind]="cat.activos === 0">
                  <td><span class="fh-titulo">{{ cat.nombre }}</span>@if (cat.critica) { <span class="fh-tag cls-riesgo">crítica</span> }<div class="muted fh-cov-rules">{{ cat.rules.join(', ') }}</div></td>
                  <td class="ta-r mono">{{ cat.activos }}/{{ cat.rules.length }}</td>
                  <td class="ta-r mono">{{ cat.findings | number }}</td>
                  <td>@if (cat.activos === 0) { <span class="fh-tag cls-riesgo">PUNTO CIEGO</span> } @else if (cat.suprimidos > 0) { <span class="fh-tag cls-error_captura">{{ cat.suprimidos }} suprimida(s)</span> } @else { <span class="fh-tag cls-oportunidad">cubierta</span> }</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="4" class="fh-empty">@if (loadingMiq()) { Cargando… } @else { Corre "Escanear ahora" para registrar las reglas. }</td></tr></ng-template>
            </p-table>
          } @else if (loadingMiq()) { <div class="fh-empty">Cargando cobertura…</div> }
        </div>
      }

      @else if (view() === 'calidad') {
        <div class="card-premium card-flat fh-panel">
          <div class="fh-panel-head">
            <h3 class="fh-card-title">Calidad de los datos que alimentan al motor</h3>
            @if (dq(); as d) { <span class="fh-dq-idx" [ngClass]="'sem-' + d.semaforo">Índice {{ d.indice_global }}/100</span> }
          </div>
          @if (dq(); as d) {
            <p-table [value]="d.dimensiones" styleClass="p-datatable-sm" [rowHover]="true">
              <ng-template pTemplate="header"><tr><th>Dimensión</th><th style="width:9rem">Score</th><th class="ta-r" style="width:10rem">$ afectado</th><th>Detalle</th></tr></ng-template>
              <ng-template pTemplate="body" let-dim>
                <tr>
                  <td class="fh-titulo">{{ dim.nombre }}</td>
                  <td><span class="fh-bar"><span class="fh-bar-fill" [ngClass]="scoreTone(dim.score)" [style.width.%]="dim.score"></span></span><span class="fh-bar-n mono">{{ dim.score }}</span></td>
                  <td class="ta-r mono">{{ dim.importe ? money(dim.importe) : '—' }}</td>
                  <td class="fh-resumen">{{ dim.detalle }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else if (loadingMiq()) { <div class="fh-empty">Cargando…</div> }
        </div>
      }

      @else if (view() === 'descubrimiento') {
        <div class="card-premium card-flat fh-panel fh-actions">
          <div class="fh-panel-head">
            <h3 class="fh-card-title">Hipótesis de detectores nuevos <span class="muted">(la AI y los mineros proponen, tú apruebas)</span></h3>
            <button pButton type="button" label="Buscar hipótesis" icon="pi pi-compass" class="p-button-sm p-button-outlined" [loading]="discovering()" (click)="runDiscovery()"></button>
          </div>
          @for (h of hypotheses(); track h.id) {
            <div class="fh-action">
              <div class="fh-action-body">
                <span class="fh-action-titulo">{{ h.titulo }} <span class="fh-tag" [ngClass]="h.source === 'ai' ? 'cls-pin' : 'cls-off'">{{ h.source === 'ai' ? 'AI' : 'determinista' }}</span></span>
                <span class="fh-action-desc">{{ h.descripcion }}</span>
              </div>
              <div class="fh-action-acts">
                <button pButton type="button" icon="pi pi-check" label="Aprobar" class="p-button-sm p-button-success" (click)="approveHyp(h)"></button>
                <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-text p-button-danger" title="Rechazar" (click)="rejectHyp(h)"></button>
              </div>
            </div>
          } @empty {
            <div class="fh-empty">@if (loadingMiq()) { Cargando… } @else { <i class="pi pi-compass"></i> Sin hipótesis pendientes. Corre "Buscar hipótesis" para que los mineros propongan detectores nuevos. }</div>
          }
        </div>
      }

      @else if (view() === 'modelo') {
        <div class="fh-model-grid">
          <div class="card-premium card-flat fh-panel">
            <h3 class="fh-card-title">Modelo que prioriza <span class="muted">(aprende del feedback)</span></h3>
            @if (model(); as m) {
              @if (m.modelo) {
                <div class="fh-model-kv">
                  <div><span class="fh-ev-k">Versión</span><span class="fh-ev-v mono">v{{ m.modelo.version }}</span></div>
                  <div><span class="fh-ev-k">Entrenado con</span><span class="fh-ev-v mono">{{ m.modelo.n_train }} etiquetas ({{ m.modelo.n_pos }}+)</span></div>
                  <div><span class="fh-ev-k">AUC (train)</span><span class="fh-ev-v mono">{{ m.modelo.metrics?.['auc'] ?? '—' }}</span></div>
                  <div><span class="fh-ev-k">Precisión</span><span class="fh-ev-v mono">{{ m.modelo.metrics?.['precision'] ?? '—' }}</span></div>
                </div>
              } @else {
                <div class="fh-empty2"><i class="pi pi-hourglass"></i> Cold-start: la bandeja usa el score del detector. El modelo entrena solo al llegar a ≥12 etiquetas (hoy {{ m.dataset.etiquetados }}).</div>
              }
              <div class="fh-model-ds muted">Dataset: {{ m.dataset.etiquetados }}/{{ m.dataset.total }} etiquetados · {{ m.dataset.scoreados }} priorizados</div>
              <button pButton type="button" label="Entrenar / priorizar ahora" icon="pi pi-sync" class="p-button-sm p-button-outlined" [loading]="training()" (click)="runLearning()"></button>
            } @else if (loadingMiq()) { <div class="fh-empty">Cargando…</div> }
          </div>

          <div class="card-premium card-flat fh-panel">
            <h3 class="fh-card-title">Backtest <span class="muted">(¿supera al detector?)</span></h3>
            @if (backtest(); as b) {
              @if (b.ran) {
                <div class="fh-model-kv">
                  <div><span class="fh-ev-k">AUC modelo</span><span class="fh-ev-v mono strong">{{ b.model?.auc }}</span></div>
                  <div><span class="fh-ev-k">AUC detector</span><span class="fh-ev-v mono">{{ b.baseline_detector?.auc }}</span></div>
                  <div><span class="fh-ev-k">Lift</span><span class="fh-ev-v mono" [class.ok]="(b.lift_auc || 0) > 0">{{ b.lift_auc }}</span></div>
                  <div><span class="fh-ev-k">Etiquetas</span><span class="fh-ev-v mono">{{ b.n_labeled }}</span></div>
                </div>
                <p class="fh-resumen">{{ b.veredicto }}</p>
              } @else { <div class="fh-empty2"><i class="pi pi-info-circle"></i> {{ b.reason || 'Aún no hay suficientes etiquetas para el backtest.' }}</div> }
            } @else if (loadingMiq()) { <div class="fh-empty">Cargando…</div> }
          </div>

          <div class="card-premium card-flat fh-panel fh-uncertain">
            <h3 class="fh-card-title">Etiquetá estos primero <span class="muted">(el modelo está más inseguro — rinde más por clic)</span></h3>
            @for (u of uncertain(); track u.id) {
              <div class="fh-unc-row" tabindex="0" role="button" (click)="setView('hallazgos')" (keyup.enter)="setView('hallazgos')">
                <span class="fh-unc-t">{{ u.titulo }}</span>
                <span class="fh-unc-p mono">p={{ u.model_score | number:'1.2-2' }}</span>
              </div>
            } @empty { <div class="fh-empty">@if (loadingMiq()) { Cargando… } @else { Nada pendiente por etiquetar (o el modelo aún no scorea). }</div> }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fh-head { display: flex; align-items: flex-start; gap: 1rem; }
    .fh-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .fh-filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .fh-seg { display: inline-flex; border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .fh-seg button { border: none; background: var(--card-bg, #fff); padding: .3rem .8rem; font-size: .8rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .fh-seg button.active { background: var(--action, #FB923C); color: #fff; font-weight: 600; }
    .fh-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; }
    .fh-rules { padding: 1rem; margin-bottom: 1rem; }
    .fh-table { font-variant-numeric: tabular-nums; }
    .fh-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted, #78716c); }
    .bad { color: var(--bad-fg, #dc2626); font-weight: 600; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .fh-titulo { font-weight: 600; }
    .fh-resumen { font-size: .82rem; color: var(--text-muted, #78716c); margin-top: .1rem; max-width: 60ch; }
    .fh-sev { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .68rem; font-weight: 700; text-transform: uppercase; }
    .sev-critical { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .sev-warn { background: color-mix(in srgb, var(--warn-fg) 15%, transparent); color: var(--warn-soft-fg); }
    .sev-info { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #57534e); }
    .fh-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .7rem; font-weight: 600; }
    .cls-riesgo { background: color-mix(in srgb, var(--bad-fg, #dc2626) 12%, transparent); color: var(--bad-fg, #dc2626); }
    .cls-error_captura { background: color-mix(in srgb, var(--warn-fg) 14%, transparent); color: var(--warn-soft-fg); }
    .cls-oportunidad { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .cls-off { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #78716c); }
    .cls-pin { background: color-mix(in srgb, var(--action, #FB923C) 15%, transparent); color: var(--action, #FB923C); }
    .fh-acts { display: flex; align-items: center; gap: .1rem; }
    .fh-status { font-size: .75rem; font-weight: 600; }
    .st-confirmado { color: var(--ok-fg, #16a34a); } .st-descartado { color: var(--text-muted, #a8a29e); } .st-corregido { color: var(--action, #FB923C); }
    .fh-suppressed { opacity: .55; }
    .fh-ev { background: var(--surface-hover-bg, #fafaf9); padding: .8rem 1.2rem; }
    .fh-ev-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .4rem 1.2rem; }
    .fh-ev-k { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); display: block; }
    .fh-ev-v { font-size: .85rem; }
    .fh-ev-meta { font-size: .74rem; margin-top: .6rem; }
    .fh-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .fh-actions { padding: 1rem; margin-bottom: 1rem; border-left: 3px solid var(--action, #FB923C); }
    .fh-action { display: flex; align-items: center; gap: 1rem; padding: .6rem 0; border-top: 1px solid var(--border-color, #e7e5e4); }
    .fh-action:first-of-type { border-top: none; }
    .fh-action-body { display: flex; flex-direction: column; gap: .15rem; flex: 1; min-width: 0; }
    .fh-action-titulo { font-weight: 700; }
    .fh-action-desc { font-size: .84rem; color: var(--text-muted, #78716c); }
    .fh-action-efecto { font-size: .8rem; color: var(--action, #FB923C); }
    .fh-action-efecto i { font-size: .7rem; }
    .fh-action-acts { display: flex; gap: .3rem; flex-shrink: 0; }
    /* MAAT-IQ — vistas */
    .fh-viewseg { display: flex; gap: .3rem; flex-wrap: wrap; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color, #e7e5e4); padding-bottom: .6rem; }
    .fh-viewseg button { border: none; background: transparent; padding: .35rem .8rem; font-size: .82rem; cursor: pointer; color: var(--text-muted, #78716c); border-radius: var(--r-md, 10px); display: inline-flex; align-items: center; gap: .4rem; }
    .fh-viewseg button:hover { color: var(--text-main); }
    .fh-viewseg button.active { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-main); font-weight: 600; }
    .fh-panel { padding: 1rem 1.2rem; margin-bottom: 1rem; }
    .fh-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .6rem; }
    .fh-cov-pct { font-size: .8rem; font-weight: 600; color: var(--ok-fg, #16a34a); }
    .fh-cov-pct.bad { color: var(--bad-fg, #dc2626); }
    .fh-cov-rules { font-size: .68rem; margin-top: .1rem; }
    .fh-blind td:first-child { box-shadow: inset 3px 0 0 var(--bad-fg, #dc2626); }
    .fh-dq-idx { font-size: .85rem; font-weight: 700; padding: .15rem .6rem; border-radius: var(--r-pill, 999px); }
    .sem-verde { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .sem-amarillo { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-soft-fg, #b45309); }
    .sem-rojo { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .fh-bar { display: inline-block; width: 6rem; height: .5rem; background: var(--surface-hover-bg, #f5f5f4); border-radius: 999px; overflow: hidden; vertical-align: middle; }
    .fh-bar-fill { display: block; height: 100%; border-radius: 999px; }
    .fh-bar-fill.ok { background: var(--ok-fg, #16a34a); } .fh-bar-fill.warn { background: var(--warn-fg, #d97706); } .fh-bar-fill.bad { background: var(--bad-fg, #dc2626); }
    .fh-bar-n { margin-left: .4rem; font-size: .8rem; }
    .fh-model-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
    .fh-model-kv { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem 1rem; margin-bottom: .6rem; }
    .fh-model-ds { font-size: .76rem; margin-bottom: .6rem; }
    .fh-empty2 { font-size: .82rem; color: var(--text-muted, #78716c); padding: .6rem 0; display: flex; gap: .4rem; align-items: baseline; }
    .fh-uncertain { grid-column: 1 / -1; }
    .fh-unc-row { display: flex; justify-content: space-between; gap: 1rem; padding: .4rem 0; border-top: 1px solid var(--border-color, #e7e5e4); cursor: pointer; }
    .fh-unc-row:first-of-type { border-top: none; }
    .fh-unc-t { font-size: .85rem; } .fh-unc-p { color: var(--text-muted, #78716c); }
    .ok { color: var(--ok-fg, #16a34a); }
  `],
})
export class FinanzasHallazgosComponent implements OnInit {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(FindingsService);
  private readonly actionsSvc = inject(ActionsService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  readonly actions = signal<ProposedAction[]>([]);

  readonly findings = signal<Finding[]>([]);
  readonly stats = signal<FindingsStats | null>(null);

  kpiItems(s: FindingsStats): MetricStripItem[] {
    return [
      { label: 'Pendientes', value: s.pendientes },
      { label: 'Críticos', value: s.criticos, tone: s.criticos > 0 ? 'bad' : 'default' },
      { label: '$ en juego', value: s.monto_en_riesgo, format: 'currency' },
      ...s.por_clase.map((c): MetricStripItem => ({ label: this.claseLabel(c.clase), value: c.n })),
    ];
  }
  readonly rules = signal<RuleHealth[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Hallazgos con veredicto en vuelo — evita doble-POST (§13 idempotencia visual). */
  readonly pending = signal<Set<string>>(new Set());
  readonly scanning = signal(false);
  readonly rulesOpen = signal(false);
  readonly clase = signal<FindingClase | null>(null);
  readonly status = signal<'pendientes' | 'confirmado' | 'descartado'>('pendientes');
  readonly expanded = signal<Record<string, boolean>>({});

  // MAAT-IQ — vistas (cobertura / calidad / descubrimiento / modelo)
  readonly view = signal<'hallazgos' | 'cobertura' | 'calidad' | 'descubrimiento' | 'modelo'>('hallazgos');
  readonly coverage = signal<Coverage | null>(null);
  readonly dq = signal<DataQuality | null>(null);
  readonly hypotheses = signal<Hypothesis[]>([]);
  readonly model = signal<ModelStatus | null>(null);
  readonly backtest = signal<Backtest | null>(null);
  readonly uncertain = signal<UncertainRow[]>([]);
  readonly loadingMiq = signal(false);
  readonly discovering = signal(false);
  readonly training = signal(false);

  ngOnInit() { this.reload(); this.loadStats(); this.loadActions(); }

  private loadActions() {
    this.actionsSvc.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (a) => this.actions.set(a), error: () => {} });
  }

  approve(a: ProposedAction) {
    this.actionsSvc.approve(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.actions.update((arr) => arr.filter((x) => x.id !== a.id)); this.toast.add({ severity: 'success', summary: 'Aprobada', detail: r?.resultado || 'Acción ejecutada.' }); this.reload(); this.loadStats(); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo aprobar.' }),
    });
  }
  reject(a: ProposedAction) {
    this.actionsSvc.reject(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.actions.update((arr) => arr.filter((x) => x.id !== a.id)); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: 'La acción no se ejecutará.' }); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo rechazar.' }),
    });
  }

  reload() {
    this.loading.set(true);
    this.error.set(null);
    const status = this.status() === 'pendientes' ? undefined : this.status();
    this.svc.list({ clase: this.clase() || undefined, status, limit: 300 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.findings.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar los hallazgos.'); this.loading.set(false); },
      });
  }
  private loadStats() {
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.rules().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.rules.set(r), error: () => {} });
  }

  setClase(c: FindingClase | null) { this.clase.set(c); this.reload(); }
  setStatus(s: 'pendientes' | 'confirmado' | 'descartado') { this.status.set(s); this.reload(); }

  scan() {
    this.scanning.set(true);
    this.svc.scan().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); this.toast.add({ severity: 'success', summary: 'Escaneo listo', detail: `${r.nuevos} hallazgo(s) nuevo(s) en ${r.reglas} reglas.` }); this.reload(); this.loadStats(); },
      error: () => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo escanear.' }); },
    });
  }

  toggle(f: Finding) {
    this.expanded.update((e) => { const c = { ...e }; if (c[f.id]) delete c[f.id]; else c[f.id] = true; return c; });
  }

  // ── MAAT-IQ: cambia de vista y carga sus datos ──
  setView(v: 'hallazgos' | 'cobertura' | 'calidad' | 'descubrimiento' | 'modelo') {
    this.view.set(v);
    if (v === 'cobertura') this.loadMiq(this.svc.coverage(), this.coverage);
    else if (v === 'calidad') this.loadMiq(this.svc.dataQuality(), this.dq);
    else if (v === 'descubrimiento') this.loadMiq(this.svc.discovery('propuesta'), this.hypotheses);
    else if (v === 'modelo') {
      this.loadMiq(this.svc.learningStatus(), this.model);
      this.svc.backtest().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.backtest.set(b), error: () => {} });
      this.svc.uncertain(15).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (u) => this.uncertain.set(u), error: () => {} });
    }
  }
  private loadMiq<T>(obs: Observable<T>, sink: { set: (v: T) => void }) {
    this.loadingMiq.set(true);
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { sink.set(r); this.loadingMiq.set(false); }, error: () => this.loadingMiq.set(false) });
  }

  runDiscovery() {
    this.discovering.set(true);
    this.svc.runDiscovery().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.discovering.set(false); this.toast.add({ severity: 'success', summary: 'Descubrimiento', detail: `${r.total} hipótesis (${r.deterministas} deterministas + ${r.ai} AI).` }); this.loadMiq(this.svc.discovery('propuesta'), this.hypotheses); },
      error: () => { this.discovering.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo correr el descubrimiento.' }); },
    });
  }
  approveHyp(h: Hypothesis) {
    this.svc.approveHypothesis(h.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.hypotheses.update((a) => a.filter((x) => x.id !== h.id)); this.toast.add({ severity: 'success', summary: 'Aprobada', detail: 'Queda en backlog para codificar/activar como detector.' }); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo aprobar.' }),
    });
  }
  rejectHyp(h: Hypothesis) {
    this.svc.rejectHypothesis(h.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.hypotheses.update((a) => a.filter((x) => x.id !== h.id)),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo rechazar.' }),
    });
  }
  runLearning() {
    this.training.set(true);
    this.svc.runLearning().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.training.set(false); this.toast.add({ severity: 'success', summary: 'Modelo actualizado', detail: 'Features + entrenamiento + priorización.' }); this.setView('modelo'); },
      error: () => { this.training.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar el modelo.' }); },
    });
  }
  scoreTone(s: number): string { return s >= 80 ? 'ok' : s >= 60 ? 'warn' : 'bad'; }

  verdict(f: Finding, v: 'util' | 'falso') {
    if (this.pending().has(f.id)) return; // anti doble-clic
    this.pending.update((s) => new Set(s).add(f.id));
    const snapshot = this.findings();
    this.findings.update((arr) => arr.filter((x) => x.id !== f.id)); // optimista: sale ya
    const clear = () => this.pending.update((s) => { const n = new Set(s); n.delete(f.id); return n; });
    this.svc.feedback(f.id, v).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        clear();
        this.loadStats();
        const msg = v === 'util' ? 'Confirmado' : 'Descartado';
        const sup = res?.suppressed ? ' · regla auto-suprimida por baja precisión' : '';
        this.toast.add({ severity: v === 'util' ? 'success' : 'info', summary: msg, detail: `Maat aprende de esto${sup}.` });
      },
      error: () => {
        clear();
        this.findings.set(snapshot); // rollback visible
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo registrar.' });
      },
    });
  }

  pin(r: RuleHealth) {
    this.svc.pinRule(r.rule_key, !r.pinned).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.loadStats(), error: () => {},
    });
  }

  /** Deep-link a la póliza si el hallazgo apunta a un documento. */
  docUrl(f: Finding): string | null {
    const e = f.entity;
    if (!e || !e['doc_folio']) return null;
    const p = new URLSearchParams({ type: 'beneficiario', key: e['beneficiario'] || '(sin beneficiario)', doc_sucursal: e['sucursal'] || '', doc_tipo: e['doc_tipo'] || 'XA2001', doc_folio: e['doc_folio'] });
    return `/finanzas/egresos/detalle?${p.toString()}`;
  }
  go(url: string) { this.router.navigateByUrl(url); }

  evidenceRows(f: Finding): { k: string; v: string }[] {
    const e = { ...(f.entity || {}), ...(f.evidencia || {}) };
    return Object.entries(e).filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => ({ k: k.replace(/_/g, ' '), v: String(v) }));
  }

  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  claseLabel(c: string): string { return c === 'riesgo' ? 'Riesgo' : c === 'error_captura' ? 'Error' : c === 'oportunidad' ? 'Oportunidad' : c; }
  sevLabel(s: string): string { return s === 'critical' ? 'Crítico' : s === 'warn' ? 'Alerta' : 'Info'; }
  statusLabel(s: string): string { return s === 'confirmado' ? 'Confirmado' : s === 'descartado' ? 'Descartado' : s === 'corregido' ? 'Corregido' : s; }
}
