/**
 * `[PVI.5]` — La vista **Ventas** de `/finanzas/presupuesto`, fuera del shell.
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────────────────────
 *
 * `finanzas-presupuesto.component.ts` llegó a **2,719 líneas** y lo editan al menos **cinco
 * carriles** a la vez — Ventas, Tesorería, Gastos, VP y Sucursales (medido sobre los últimos 10
 * commits del archivo, 2026-10-09). En un solo día de trabajo eso produjo **tres colisiones**, y en
 * una de ellas un arreglo terminó dentro del commit de otra sesión. No es un riesgo teórico: es el
 * modo de falla que más tiempo costó, y **ningún test lo detecta**.
 *
 * ⭐ Lo que la medición mostró, y que decidió el corte: de los **28 identificadores** del bloque
 *    Ventas, **26 no los usa ninguna otra vista**. Los dos compartidos son `selected` (el ejercicio
 *    elegido → entra por input) y `money` (formateador → sale del util común). El bloque no estaba
 *    enredado con el resto: estaba **co-ubicado**. Por eso el corte es mecánico y no un rediseño.
 *
 * ── Qué se movió y qué NO ────────────────────────────────────────────────────────────────────
 *
 * Se sigue el patrón que la pantalla de **bancos** ya dejó probado en este mismo módulo (un
 * componente por pestaña + `bancos-shared.ts` + `bancos.styles.ts`): el hijo es **presentacional**
 * —`input.required` + `@Output`—, y **el estado y el HTTP se quedan en el shell**.
 *
 * ⛔ Eso último no es pereza, es evitar una regresión: hoy las vistas se montan con
 *    `@if (view() === …)`, así que un hijo con estado propio **perdería lo cargado** cada vez que
 *    el usuario sale a otra pestaña y vuelve — y «Cargar meta vs real» consulta el sell-out del ODS
 *    y tarda segundos. Con el estado en el shell, volver a Ventas encuentra lo que ya se cargó,
 *    exactamente como antes.
 *
 * ⚠️ **Este archivo no cambia ni un comportamiento.** Mismo template, mismas reglas, mismos
 *    textos. Lo único que cambia es dónde vive. Un refactor que además corrige algo es un refactor
 *    que no se puede revisar.
 *
 * Lo que sigue en el shell y es deuda declarada de este carril: el diálogo de propuesta
 * (`openProposePlan`/`confirmProposePlan`) y los de captura manual (`openGenPlan`, `openMetaEdit`)
 * **no tienen un solo llamador** — y la tabla de abajo conserva su columna «Acciones» con la celda
 * vacía, que es el residuo visible de ese botón. No se borran acá: son estado + HTTP, viven del
 * lado del shell por el patrón, y decidir si se restauran o se retiran es una decisión de producto,
 * no un efecto colateral de mover archivos.
 */
import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { SegmentedComponent } from '../../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { PRESUPUESTO_STYLES } from './presupuesto.styles';
import {
  money, type BudgetRef, type IndicatorRow, type ProposeCoverage, type SalesComparison,
  type SalesIndicators, type SalesReconciliation, type SalesRow, type SalesTab,
} from './presupuesto-shared';

@Component({
  selector: 'pres-ventas',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, SegmentedComponent, MetricStripComponent, FreshnessPillComponent],
  template: `
    <section class="pres-section">
      @if (budget(); as b) {
        <div class="pres-section-head">
          <h2>Presupuesto de ventas · <span class="pres-muted">{{ b.name }} {{ b.fiscal_year }}</span></h2>
          <div class="pres-detail-actions">
            <app-segmented [options]="salesTabOpts" [value]="tab()" (valueChange)="tabChange.emit($any($event))" ariaLabel="Vista de ventas" />
            @if (b.status === 'borrador' || b.status === 'en_revision') {
              <button pButton type="button" class="p-button-sm" (click)="proposePlan.emit()" [loading]="savingPropose()" title="Arma el plan con los supuestos del año (Ejercicio)"><span class="pi pi-bolt"></span>&nbsp;Proponer plan del año</button>
            }
            <button pButton type="button" class="p-button-sm p-button-text" (click)="loadComparison.emit()" [loading]="loadingSales()" title="Consulta el sell-out del ODS (unos segundos)"><span class="pi pi-refresh"></span>&nbsp;{{ cmp() ? 'Actualizar real' : 'Cargar meta vs real' }}</button>
            <button pButton type="button" class="p-button-sm p-button-text" (click)="projectTargets.emit()" [loading]="projecting()" title="Reparte la meta del plan (13×4) a metas mensuales del «vs objetivo» del sub-módulo Análisis (reparto por días)."><span class="pi pi-share-alt"></span>&nbsp;Proyectar a Análisis</button>
          </div>
        </div>

        <!-- ── PLAN (pivote meta vs real) ── -->
        @if (tab() === 'plan') {
          @if (cmp(); as c) {
            <div class="pres-summary-head">
              @if (c.real_available && c.data_as_of) {
                <app-freshness-pill measures="data" [freshness]="c.freshness" />
              } @else {
                <span class="pres-nodata"><span class="pi pi-info-circle"></span> Real del ODS: sin datos</span>
              }
              <span class="pres-muted">CREC = crecimiento vs {{ c.prior_year }}</span>
              @if (c.coverage?.measured && c.coverage?.pct != null) {
                <span class="pres-muted" [title]="c.coverage.note">Cobertura real: {{ c.coverage.pct }}%</span>
              }
            </div>
            <app-metric-strip [items]="salesKpis(c)" mode="strip" ariaLabel="Resumen del presupuesto de ventas" />
            <!-- [PU.V6] El total cubre PARTE del año y eso se dice acá, no en un tooltip. El
                 motor hace bien en no inventar los periodos sin base; lo que estaba mal era
                 que el aviso viviera en la columna method -que el encabezado no suma- y el
                 $0 en el campo que si suma. Dice ademas CUANTO falta, porque "incompleto" no
                 deja decidir y "faltan ~$166M" si. -->
            @if (c.periodos && !c.periodos.completo) {
              <p class="pres-warn">
                <span class="pi pi-exclamation-triangle"></span>
                <span>{{ c.periodos.nota }}</span>
              </p>
            }
            @if (coverage(); as cov) {
              @if (covEnDinero(cov); as cm) {
                <p class="pres-hint"><span class="pi pi-check-circle"></span> Última propuesta, <strong>en dinero</strong>:
                  {{ money(cm.historico_ajustado) }} de base real ({{ cov.historico_ajustado }} celdas) ·
                  {{ money(cm.estacional) }} por estacionalidad ({{ cov.estacional }}) ·
                  {{ money(cm.proxy_canal) }} proxy de canal ({{ cov.proxy_canal }}) ·
                  <strong>{{ cov.sin_base_declarado }}</strong> celdas sin base, declaradas (—, no $0) ·
                  {{ cov.manual_kept }} a mano.
                </p>
                @if (proxyAviso(cov); as av) {
                  <p class="pres-warn"><span class="pi pi-exclamation-triangle"></span> <span>{{ av }}</span></p>
                }
              } @else {
                <p class="pres-hint"><span class="pi pi-check-circle"></span> Última propuesta: <strong>{{ cov.historico_ajustado }}</strong> de base real · <strong>{{ cov.estacional }}</strong> por estacionalidad · <strong>{{ cov.proxy_canal }}</strong> proxy de canal · <strong>{{ cov.sin_base_declarado }}</strong> sin base (declaradas, no en 0) · <strong>{{ cov.no_signal }}</strong> sin señal · <strong>{{ cov.manual_kept }}</strong> a mano.</p>
                <p class="pres-hint pres-nodata"><span class="pi pi-info-circle"></span> <strong>Cuánto DINERO representa cada origen: no medido.</strong> Esta API todavía no publica el desglose por monto. El conteo de celdas no lo dice: un cuarto de las celdas puede ser un cuarto de la meta o la mitad.</p>
              }
            }
            <div class="pres-detail-actions" style="margin:.6rem 0 .2rem">
              <label class="pres-muted">Periodo (13×4):</label>
              <p-select [options]="periodOpts" [ngModel]="period()" (ngModelChange)="periodChange.emit($any($event))" optionLabel="label" optionValue="value" placeholder="Todos" styleClass="pres-inline-select" />
            </div>
            <p-table [value]="rows()" [loading]="loadingSales()" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr>
                  <th>Entidad</th><th>Canal</th><th>Origen</th>
                  <th class="ta-r">Meta</th><th class="ta-r">Real</th><th class="ta-r">Cumpl.</th>
                  <th class="ta-r">CREC</th><th class="ta-r">PART</th>
                  <th style="width:3rem"><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [class.pres-rollup]="r.is_rollup">
                  <td>{{ r.label }}</td>
                  <td class="pres-muted">{{ r.channel_label }}</td>
                  <td>@if (!r.is_rollup && r.method) { <span class="ec-src ec-src-{{ r.method }}">{{ methodLabel(r.method) }}</span> }</td>
                  <td class="ta-r pres-mono">{{ r.meta == null ? '—' : money(r.meta) }}</td>
                  <td class="ta-r pres-mono">{{ r.real == null ? '—' : money(r.real) }}</td>
                  <td class="ta-r pres-mono">{{ r.cumplimiento_pct == null ? '—' : r.cumplimiento_pct + '%' }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="r.crec_pct != null && r.crec_pct < 0">{{ r.crec_pct == null ? '—' : r.crec_pct + '%' }}</td>
                  <td class="ta-r pres-mono">{{ r.part_pct == null ? '—' : r.part_pct + '%' }}</td>
                  <td></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="9" class="pres-empty">Sin plan de ventas todavía. @if (b.status === 'borrador' || b.status === 'en_revision') { Usá «Proponer plan del año» para que el sistema lo arme desde la historia. }</td></tr></ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> <strong>Meta</strong> = plan. <strong>Origen</strong>: Histórico (real año anterior × crecimiento) · Estacional (participación + estacionalidad) · Proxy canal (entidad nueva, estimada desde su canal) · Sin base (ni entidad ni canal con señal → declarada en 0, no ausente) · Manual. <strong>Real</strong> = sell-out del ODS por el calendario 13×4. «Sin datos» ≠ cero (—).</p>
          } @else if (loadingSales()) {
            <p class="pres-muted">Cargando presupuesto de ventas…</p>
          } @else {
            <p class="pres-hint"><span class="pi pi-info-circle"></span> El «meta vs real» consulta el sell-out del ODS (unos segundos). Pulsá <strong>«Cargar meta vs real»</strong> para verlo. La propuesta del plan no lo necesita.</p>
          }
        }

        <!-- ── INDICADORES (CREC/PART histórico + meta-vs-real) ── -->
        @if (tab() === 'indicadores') {
          @if (indicators(); as ind) {
            <div class="pres-summary-head">
              @if (ind.real_available && ind.data_as_of) {
                <app-freshness-pill measures="data" [freshness]="ind.freshness" />
              } @else {
                <span class="pres-nodata"><span class="pi pi-info-circle"></span> Real del ODS: sin datos</span>
              }
              <span class="pres-muted">Años con historia: {{ ind.years_available.join(', ') }} · CREC vs {{ ind.prior_year }}</span>
            </div>
            <p-table [value]="ind.by_channel" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr>
                  <th>Canal</th>
                  <th class="ta-r">Real {{ ind.budget.fiscal_year }}</th><th class="ta-r">CREC</th><th class="ta-r">PART</th>
                  <th class="ta-r">Meta</th><th class="ta-r">Cumpl.</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td>{{ r.channel_label }}</td>
                  <td class="ta-r pres-mono">{{ r.current.real == null ? '—' : money(r.current.real) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="r.current.crec_pct != null && r.current.crec_pct < 0">{{ r.current.crec_pct == null ? '—' : r.current.crec_pct + '%' }}</td>
                  <td class="ta-r pres-mono">{{ indPart(r) }}</td>
                  <td class="ta-r pres-mono">{{ r.current.meta == null ? '—' : money(r.current.meta) }}</td>
                  <td class="ta-r pres-mono">{{ r.current.cumplimiento_pct == null ? '—' : r.current.cumplimiento_pct + '%' }}</td>
                </tr>
              </ng-template>
              <ng-template #footer>
                <tr class="pres-rollup">
                  <td>Total Venta</td>
                  <td class="ta-r pres-mono">{{ ind.company.current.real == null ? '—' : money(ind.company.current.real) }}</td>
                  <td class="ta-r pres-mono">{{ ind.company.current.crec_pct == null ? '—' : ind.company.current.crec_pct + '%' }}</td>
                  <td class="ta-r pres-mono">100%</td>
                  <td class="ta-r pres-mono">{{ ind.company.current.meta == null ? '—' : money(ind.company.current.meta) }}</td>
                  <td class="ta-r pres-mono">{{ ind.company.current.cumplimiento_pct == null ? '—' : ind.company.current.cumplimiento_pct + '%' }}</td>
                </tr>
              </ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> Bloques de consolidación del reporte (CREC = crecimiento año vs año · PART = participación en el total), directo del sell-out del ODS. Reemplaza el seguimiento manual del Excel.</p>
          } @else if (loadingIndicators()) {
            <p class="pres-muted">Cargando indicadores…</p>
          }
        }

        <!-- ── CONCILIACIÓN (documentada) sell-out ↔ facturación contable 401 ── -->
        @if (tab() === 'conciliacion') {
          @if (reconciliation(); as rec) {
            @if (rec.freshness) { <div class="pres-summary-head"><app-freshness-pill measures="data" [freshness]="rec.freshness" /><span class="pres-muted">Conciliación documental — el real del presupuesto sigue siendo el sell-out</span></div> }
            <p-table [value]="rec.annual" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr><th>Año</th><th>Canal</th><th class="ta-r">Sell-out</th><th class="ta-r">Facturación (401)</th><th class="ta-r">Δ</th><th class="ta-r">401/sell-out</th><th>Estado</th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="pres-mono">{{ r.year }}</td>
                  <td class="pres-muted">{{ r.channel_label }}</td>
                  <td class="ta-r pres-mono">{{ money(r.sell_out) }}</td>
                  <td class="ta-r pres-mono">{{ money(r.facturacion) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="r.delta < 0">{{ money(r.delta) }}</td>
                  <td class="ta-r pres-mono">{{ r.ratio_pct == null ? '—' : r.ratio_pct + '%' }}</td>
                  <td><span class="ec-src ec-src-recon-{{ r.status }}">{{ statusLabel(r.status) }}</span></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7" class="pres-empty">Sin datos de conciliación.</td></tr></ng-template>
            </p-table>
            <div class="pres-recon-notes">
              @for (n of rec.notes; track n) { <p class="pres-hint"><span class="pi pi-info-circle"></span> {{ n }}</p> }
            </div>
          } @else if (loadingReconciliation()) {
            <p class="pres-muted">Cargando conciliación…</p>
          }
        }
      }
    </section>
  `,
  styles: [PRESUPUESTO_STYLES],
})
export class PresupuestoVentasComponent {
  // ── Lo que entra del shell (estado + HTTP viven allá, ver cabecera) ──
  readonly budget = input.required<BudgetRef>();
  readonly tab = input.required<SalesTab>();
  readonly cmp = input<SalesComparison | null>(null);
  readonly indicators = input<SalesIndicators | null>(null);
  readonly reconciliation = input<SalesReconciliation | null>(null);
  readonly coverage = input<ProposeCoverage | null>(null);
  readonly loadingSales = input(false);
  readonly loadingIndicators = input(false);
  readonly loadingReconciliation = input(false);
  readonly savingPropose = input(false);
  readonly projecting = input(false);
  /** 0 = Todos (anual); 1..13 = periodo. Vive en el shell para sobrevivir el cambio de vista. */
  readonly period = input(0);

  // ── Lo que sale: acciones, no datos ──
  @Output() tabChange = new EventEmitter<SalesTab>();
  @Output() periodChange = new EventEmitter<number>();
  @Output() proposePlan = new EventEmitter<void>();
  @Output() loadComparison = new EventEmitter<void>();
  @Output() projectTargets = new EventEmitter<void>();

  protected readonly money = money;
  readonly periodOpts = [{ label: 'Todos (anual)', value: 0 }, ...Array.from({ length: 13 }, (_, i) => ({ label: `P${i + 1}`, value: i + 1 }))];
  readonly salesTabOpts = [{ label: 'Plan', value: 'plan' }, { label: 'Indicadores', value: 'indicadores' }, { label: 'Conciliación', value: 'conciliacion' }];

  salesKpis(c: SalesComparison): MetricStripItem[] {
    // [PU.V6] El total NO se rotula «Meta total» a secas cuando cubre parte del año. Medido en
    // prod: el «Presupuesto 2027» publicaba $604.8M y eran 10 de 13 períodos — los tres que
    // faltaban (nov–ene) valieron $166.6M en 2025 y son los MEJORES del año. El motor hizo bien
    // en no inventarlos; lo que estaba mal era presentar el subtotal como si fuera el ejercicio.
    const per = c.periodos;
    const parcial = per != null && per.completo === false;
    return [
      {
        label: parcial ? `Meta de ${per.con_meta} de ${per.del_anio} períodos` : 'Meta total',
        value: c.totals.meta, format: 'currency-short',
        sub: parcial ? `faltan ${per.sin_meta.join(', ')} — sin base aún` : undefined,
        tone: parcial ? 'warn' : undefined,
      },
      { label: 'Real', value: c.totals.real == null ? '—' : c.totals.real, format: c.totals.real == null ? 'text' : 'currency-short', sub: c.totals.real == null ? 'sin datos' : undefined },
      // ⛔ Acá la ausencia se convertía en CERO: `?? 0` metía un 0 en el modelo y lo único que lo
      // disimulaba era cambiar `format` a 'text'. Sobrevive a cualquier cambio de formato — el día
      // que alguien lo vuelva 'percent', la pantalla publica «0 %» donde no hay meta. ⭐ Y el patrón
      // correcto no había que inventarlo: la tarjeta «Real», dos líneas más arriba, ya devuelve el
      // guion. Tres tarjetas de la misma función con dos criterios para la misma ausencia.
      // «No hay dato» no es «hay dato y vale cero» (ADR-056).
      {
        label: 'Cumplimiento',
        value: c.totals.cumplimiento_pct == null ? '—' : c.totals.cumplimiento_pct,
        format: c.totals.cumplimiento_pct == null ? 'text' : 'percent',
        sub: c.totals.cumplimiento_pct == null ? 'sin meta capturada' : undefined,
        // sin meta no se puede merecer verde: el tono queda inhabilitado, no en gris.
        tone: c.totals.cumplimiento_pct != null && c.totals.cumplimiento_pct >= 100 ? 'ok' : undefined,
      },
      {
        label: `CREC vs ${c.prior_year}`,
        value: c.totals.crec_pct == null ? '—' : c.totals.crec_pct,
        format: c.totals.crec_pct == null ? 'text' : 'percent',
        sub: c.totals.crec_pct == null ? 'sin base del año anterior' : undefined,
        tone: c.totals.crec_pct != null && c.totals.crec_pct < 0 ? 'bad' : undefined,
      },
    ];
  }

  /** Pivote entidad × periodo → filas por entidad (o del periodo elegido) + subtotales por canal + total. */
  readonly rows = computed<SalesRow[]>(() => {
    const c = this.cmp(); if (!c) return [];
    const period = this.period();
    const cells = period > 0 ? c.cells.filter((x) => x.period_no === period) : c.cells;
    // total real del alcance mostrado (para PART)
    const scopeReal = cells.reduce((s, x) => s + (x.real ?? 0), 0);
    // agregar por entidad
    const byEntity = new Map<string, { label: string; channel: string; channel_label: string; meta: number | null; real: number | null; prior: number | null; methods: Set<string> }>();
    for (const x of cells) {
      let e = byEntity.get(x.entity_key);
      if (!e) { e = { label: x.branch_name || x.warehouse_code, channel: x.channel, channel_label: x.channel_label, meta: null, real: null, prior: null, methods: new Set() }; byEntity.set(x.entity_key, e); }
      if (x.meta != null) e.meta = (e.meta ?? 0) + x.meta;
      if (x.real != null) e.real = (e.real ?? 0) + x.real;
      if (x.real_prior != null) e.prior = (e.prior ?? 0) + x.real_prior;
      if (x.method) e.methods.add(x.method);
    }
    const rowMethod = (ms: Set<string>): string | null => (ms.size === 0 ? null : ms.size === 1 ? [...ms][0] : 'mixto');
    const pct = (n: number | null, d: number | null) => (n == null || d == null || d === 0 ? null : Math.round((n / d) * 1000) / 10);
    // «Sin datos» ≠ cero (ADR-056): sin real (r=null) el CREC es desconocido, NO −100%.
    const crec = (r: number | null, p: number | null) => (r == null || p == null || p === 0 ? null : Math.round((((r - p) / p) * 100) * 10) / 10);
    const rows: SalesRow[] = [];
    const entries = [...byEntity.entries()];
    // [VSO.8] Se recorren TODOS los canales PRESENTES, ordenados por un orden conocido y con lo
    // desconocido al final — **nunca se descarta uno**. Antes esto era la lista literal
    // `['mostrador','credito','ruta','preventa']`, y como el bucle FILTRA por ella, las entidades
    // de canal `mayoreo` y `contado_nf` no producían renglón. Medido en prod el 2026-09-28: eran
    // **$21,754,366 de meta capturada** que esta pantalla no pintaba. Un canal nuevo entra solo.
    const ORDEN = ['mostrador', 'contado_nf', 'credito', 'mayoreo', 'ruta', 'preventa'];
    const pos = (c2: string) => { const i = ORDEN.indexOf(c2); return i < 0 ? ORDEN.length : i; };
    const channelOrder = entries.map(([, e]) => e.channel)
      .filter((v, i, a) => a.indexOf(v) === i)   // dedup sin spread de Set (bundle lo downlevelea mal)
      .sort((a, b) => (pos(a) - pos(b)) || String(a).localeCompare(String(b)));
    for (const ch of channelOrder) {
      const inCh = entries.filter(([, e]) => e.channel === ch);
      if (!inCh.length) continue;
      for (const [ek, e] of inCh) {
        rows.push({ label: e.label, channel_label: e.channel_label, entity_key: ek, is_rollup: false,
          meta: e.meta, real: e.real, cumplimiento_pct: pct(e.real, e.meta), crec_pct: crec(e.real, e.prior), part_pct: pct(e.real, scopeReal), method: rowMethod(e.methods) });
      }
      // subtotal por canal — real NULL si ningún miembro tiene real (no 0 falso → CREC/PART correctos)
      const sMeta = inCh.reduce((s, [, e]) => s + (e.meta ?? 0), 0);
      const sReal = inCh.some(([, e]) => e.real != null) ? inCh.reduce((s, [, e]) => s + (e.real ?? 0), 0) : null;
      const sPrior = inCh.reduce((s, [, e]) => s + (e.prior ?? 0), 0);
      rows.push({ label: `Subtotal ${inCh[0][1].channel_label}`, channel_label: '', entity_key: null, is_rollup: true,
        meta: sMeta, real: sReal, cumplimiento_pct: pct(sReal, sMeta), crec_pct: crec(sReal, sPrior), part_pct: pct(sReal, scopeReal), method: null });
    }
    // total general
    const tMeta = entries.reduce((s, [, e]) => s + (e.meta ?? 0), 0);
    const tReal = entries.some(([, e]) => e.real != null) ? entries.reduce((s, [, e]) => s + (e.real ?? 0), 0) : null;
    const tPrior = entries.reduce((s, [, e]) => s + (e.prior ?? 0), 0);
    rows.push({ label: 'Total Venta', channel_label: '', entity_key: null, is_rollup: true,
      meta: tMeta, real: tReal, cumplimiento_pct: pct(tReal, tMeta), crec_pct: crec(tReal, tPrior), part_pct: tReal != null && tReal > 0 ? 100 : null, method: null });
    return rows;
  });

  statusLabel(s: string): string { return s === 'concilia' ? 'Concilia' : s === 'revisar' ? 'Revisar' : s === 'sin_facturacion' ? 'Sin facturación' : s === 'sin_sellout' ? 'Sin sell-out' : s; }

  methodLabel(m: string | null): string {
    return m === 'historico_ajustado' ? 'Histórico' : m === 'estacional' ? 'Estacional' : m === 'proxy_canal' ? 'Proxy canal' : m === 'sin_base_declarado' ? 'Sin base' : m === 'manual' ? 'Manual' : m === 'mixto' ? 'Mixto' : '—';
  }

  /**
   * `[PVI.2]` El desglose en DINERO, o `null` si la API no lo emite.
   *
   * ⛔ Devuelve `null` —no un objeto en ceros— a propósito: la pantalla tiene que poder distinguir
   * «la cobertura en dinero vale cero» de «no la pude medir». Un objeto relleno de ceros colapsa
   * las dos cosas y es la forma exacta del defecto que esto viene a corregir (ADR-056).
   */
  covEnDinero(cov: ProposeCoverage): ProposeCoverage['coverage_monto'] | null {
    const m = cov.coverage_monto;
    return m && typeof m.historico_ajustado === 'number' ? m : null;
  }

  /**
   * `[PVI.2]` El aviso del proxy, sólo cuando hay proxy y su monto se pudo medir.
   *
   * ⭐ Dice **de dónde sale** la cifra, no sólo que es estimada: el proxy reparte el promedio de
   * OTRAS entidades del canal, en partes iguales, a entidades sin historia propia. Medido en prod:
   * 8 entidades recibieron $197,160,564 contra $19,063,383 de venta real — 10.3×, y en el extremo
   * una recibió 2,860× lo suyo. Un «estimado» genérico no deja ver eso; el método sí.
   */
  proxyAviso(cov: ProposeCoverage): string | null {
    const m = this.covEnDinero(cov);
    if (!m || !(m.proxy_canal > 0)) return null;
    const pct = cov.proxy_canal_pct;
    const parte = typeof pct === 'number' ? `${(pct * 100).toFixed(1)} % de la meta` : `${money(m.proxy_canal)} de la meta`;
    return `${parte} se repartió con el PROMEDIO DE OTRAS entidades del canal, no con historia propia. `
      + `Son ${cov.proxy_canal} celdas sin base: la entidad no aporta ninguna señal y su monto sale del canal.`;
  }

  indPart(r: IndicatorRow): string {
    const last = r.series && r.series.length ? r.series[r.series.length - 1] : null;
    return last && last.part_pct != null ? last.part_pct + '%' : '—';
  }
}
