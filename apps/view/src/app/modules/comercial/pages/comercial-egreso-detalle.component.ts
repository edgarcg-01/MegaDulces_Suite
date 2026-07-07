import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  ExpensesReport,
  ExpenseRow,
  ExpenseDocRow,
  ExpensesParams,
  ExpenseDocumentDetail,
  ExpenseProvider360,
} from '../comercial.service';
import { ThemeService } from '../../../core/services/theme.service';
import { egresChartOptions } from './egresos-chart-opts';

/**
 * GX.4 — Explorador de detalle de egresos (una superficie por "cosa").
 * GX.4.3 — Filtros acumulables + breadcrumb: en vez de pivotar (reemplazar el
 * filtro), cada drill AGREGA una restricción a la cadena, así se puede ver p.ej.
 * "cuenta 511 Y proveedor DE LA ROSA" juntos. El breadcrumb permite quitar/saltar
 * a cualquier nivel. El desglose se hace por una dimensión libre (selector), y al
 * drillear esa fila se agrega como nueva restricción. Backend ya compone estos
 * filtros en /expenses (cuenta + beneficiario_eq + area + sucursal + doc_tipo).
 */
type SliceType = 'cuenta' | 'cuenta_mayor' | 'beneficiario' | 'area' | 'sucursal' | 'doc_tipo';
interface Constraint { type: SliceType; key: string; label: string; }

@Component({
  selector: 'app-comercial-egreso-detalle',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, MultiSelectModule, DatePickerModule,
    InputNumberModule, InputTextModule, TableModule, ChartModule, ToastModule, DialogModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head ed-head">
        <button pButton type="button" icon="pi pi-arrow-left" label="Volver" class="p-button-text p-button-sm"
                (click)="back()"></button>
        <div class="surf-page-head-text">
          <h1>{{ title() }}</h1>
          <p class="surf-page-sub">{{ subtitle() }}</p>
        </div>
        <button pButton type="button" label="Exportar CSV" icon="pi pi-download"
                class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"></button>
      </header>

      <!-- Breadcrumb de restricciones acumuladas -->
      <nav class="ed-crumbs">
        <button class="ed-crumb-root" (click)="back()"><i class="pi pi-home"></i> Todos los egresos</button>
        @for (c of chain(); track c.type + '|' + c.key; let i = $index) {
          <i class="pi pi-angle-right ed-crumb-sep"></i>
          <span class="ed-crumb" [class.active]="i === chain().length - 1">
            <button class="ed-crumb-btn" (click)="goToCrumb(i)" [title]="'Ver hasta ' + dimShort(c.type)">
              <span class="ed-crumb-dim">{{ dimShort(c.type) }}</span>{{ c.label }}
            </button>
            <button class="ed-crumb-x" (click)="removeCrumb(i)" title="Quitar este filtro"><i class="pi pi-times"></i></button>
          </span>
        }
      </nav>

      <!-- Filtros propios del detalle -->
      <div class="ed-filters card-premium card-flat">
        <div class="ed-field"><label>Rango</label>
          <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="applyFilters()" /></div>
        <div class="ed-field"><label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code" placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="applyFilters()" /></div>
        <div class="ed-field"><label>Beneficiario</label>
          <input pInputText [(ngModel)]="beneficiario" placeholder="Buscar…" (keyup.enter)="reload()" (blur)="queueReload()" /></div>
        <div class="ed-field ed-narrow"><label>Monto ≥</label>
          <p-inputNumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="queueReload()" /></div>
      </div>

      @if (loading()) {
        <div class="ed-empty">Cargando…</div>
      } @else {
        @if (report(); as r) {
        <!-- KPIs -->
        <div class="ed-kpis">
          <div class="ed-kpi"><span class="ed-kpi-label">Total</span><span class="ed-kpi-val">{{ money(r.total) }}</span>
            @if (r.rows.length && deltaTotal() !== null) { <span class="ed-kpi-sub" [class.up]="deltaTotal()! > 0" [class.down]="deltaTotal()! < 0">{{ deltaTotal()! > 0 ? '+' : '' }}{{ deltaTotal() }}% vs prev</span> }
          </div>
          <div class="ed-kpi"><span class="ed-kpi-label">Movimientos</span><span class="ed-kpi-val">{{ r.movimientos | number }}</span></div>
          <div class="ed-kpi"><span class="ed-kpi-label">Documentos</span><span class="ed-kpi-val">{{ docs().length | number }}{{ docs().length >= 3000 ? '+' : '' }}</span></div>
          <div class="ed-kpi"><span class="ed-kpi-label">{{ breakdownLabel() }}</span><span class="ed-kpi-val">{{ r.rows.length | number }}</span></div>
          <div class="ed-kpi"><span class="ed-kpi-label">Ticket prom.</span><span class="ed-kpi-val">{{ money(ticket()) }}</span></div>
        </div>

        <!-- Proveedor 360: cuenta 201 (saldo/DPO/pagos) -->
        @if (isProvider() && provider360()?.summary; as ps) {
          <div class="ed-kpis">
            <div class="ed-kpi"><span class="ed-kpi-label">Compra 12m</span><span class="ed-kpi-val">{{ money(ps.compra_12m) }}</span></div>
            <div class="ed-kpi"><span class="ed-kpi-label">Saldo por pagar</span><span class="ed-kpi-val" [class.up]="ps.saldo > 0">{{ money(ps.saldo) }}</span></div>
            <div class="ed-kpi"><span class="ed-kpi-label">Pagos 12m</span><span class="ed-kpi-val">{{ money(ps.pagos_12m) }}</span></div>
            <div class="ed-kpi"><span class="ed-kpi-label">DPO (días de pago)</span><span class="ed-kpi-val" [class.up]="ps.dpo_dias != null && ps.dpo_dias > 60">{{ ps.dpo_dias != null ? ps.dpo_dias + ' d' : '—' }}</span></div>
            <div class="ed-kpi"><span class="ed-kpi-label">Facturas 12m</span><span class="ed-kpi-val">{{ ps.num_facturas | number }}</span></div>
            <div class="ed-kpi"><span class="ed-kpi-label">Última compra</span><span class="ed-kpi-val" style="font-size:1.05rem">{{ ps.ultima_compra | date:'dd/MM/yy' }}</span></div>
          </div>
        }

        <div class="ed-grid">
          <!-- Tendencia -->
          <div class="card-premium card-flat ed-card">
            <h3 class="ed-card-title">Tendencia mensual</h3>
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts()" height="240px"></p-chart>
          </div>

          <!-- Desglose por dimensión (con selector) -->
          <div class="card-premium card-flat ed-card">
            <div class="ed-bk-head">
              <h3 class="ed-card-title">Desglose <span class="muted">(top {{ topRows().length }})</span></h3>
              <div class="ed-dim-select">
                <span class="ed-dim-hint">por</span>
                @for (d of availDims(); track d) {
                  <button class="ed-dim-btn" [class.active]="breakdownDim() === d" (click)="setBreakdown(d)">{{ dimShort(d) }}</button>
                }
              </div>
            </div>
            <p-table [value]="topRows()" styleClass="p-datatable-sm ed-table" [rowHover]="true" [scrollable]="true" scrollHeight="300px">
              <ng-template pTemplate="header">
                <tr><th>{{ breakdownLabel() }}</th><th class="ta-r" style="width:8rem">Importe</th><th class="ta-r" style="width:5rem">%</th><th style="width:2.5rem"></th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-row>
                <tr class="ed-clickable" tabindex="0" role="button" [attr.aria-label]="'Filtrar por ' + row.label"
                    (click)="drillInto(row)" (keydown.enter)="drillInto(row)" (keydown.space)="$event.preventDefault(); drillInto(row)"
                    [title]="'Agregar filtro: ' + row.label">
                  <td>{{ row.label }}</td>
                  <td class="ta-r strong">{{ money(row.total) }}</td>
                  <td class="ta-r muted">{{ row.share_pct }}%</td>
                  <td class="ta-r"><i class="pi pi-filter-fill ed-add"></i></td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="4" class="ed-empty">Sin datos.</td></tr></ng-template>
            </p-table>
          </div>
        </div>

        <!-- Proveedor 360: top productos comprados -->
        @if (isProvider() && provider360()?.top_products?.length) {
          <div class="card-premium card-flat ed-card">
            <h3 class="ed-card-title">Top productos que le compras <span class="muted">(top {{ provider360()!.top_products.length }})</span></h3>
            <p-table [value]="provider360()!.top_products" styleClass="p-datatable-sm ed-table" [rowHover]="true" [scrollable]="true" scrollHeight="320px">
              <ng-template pTemplate="header">
                <tr><th style="width:5rem">SKU</th><th>Producto</th><th class="ta-r" style="width:7rem">Cantidad</th><th class="ta-r" style="width:5rem">Docs</th><th class="ta-r" style="width:9rem">Importe</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-p>
                <tr>
                  <td class="mono">{{ p.sku || '—' }}</td>
                  <td>{{ p.producto || '—' }}</td>
                  <td class="ta-r">{{ p.cantidad != null ? (p.cantidad | number:'1.0-0') : '—' }}</td>
                  <td class="ta-r muted">{{ p.docs }}</td>
                  <td class="ta-r strong">{{ money(p.importe) }}</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        }

        <!-- Documentos -->
        <div class="card-premium card-flat ed-card">
          <div class="ed-docs-head">
            <h3 class="ed-card-title">Documentos <span class="muted">({{ docs().length }}{{ docs().length >= 3000 ? '+, acotado' : '' }})</span></h3>
          </div>
          <p-table [value]="docs()" styleClass="p-datatable-sm ed-table" [rowHover]="true" [scrollable]="true" scrollHeight="480px"
                   [paginator]="docs().length > 100" [rows]="100">
            <ng-template pTemplate="header">
              <tr><th style="width:6rem">Fecha</th><th>Documento</th><th>Sucursal</th><th>Cuenta</th><th>Beneficiario</th><th class="ta-r" style="width:9rem">Importe</th><th style="width:2.5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-d>
              <tr class="ed-clickable" tabindex="0" role="button" [attr.aria-label]="'Ver documento ' + d.doc_tipo + '-' + d.doc_folio"
                  (click)="openDocument(d)" (keydown.enter)="openDocument(d)" (keydown.space)="$event.preventDefault(); openDocument(d)">
                <td>{{ d.fecha | date:'dd/MM/yy' }}</td>
                <td class="mono">{{ d.doc_tipo }}-{{ d.doc_folio }}</td>
                <td>{{ d.sucursal_nombre || d.sucursal }}</td>
                <td>{{ d.cuenta_nombre || d.cuenta }}</td>
                <td>{{ d.beneficiario || '—' }}</td>
                <td class="ta-r strong">{{ money(d.importe) }}</td>
                <td class="ta-r"><i class="pi pi-angle-right muted"></i></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="ed-empty">Sin documentos.</td></tr></ng-template>
          </p-table>
        </div>
        } @else {
          <div class="ed-empty">Sin información para este filtro.</div>
        }
      }

      <!-- Drill al documento fuente -->
      <p-dialog [visible]="docDetailOpen()" (visibleChange)="docDetailOpen.set($event)" [modal]="true" [dismissableMask]="true"
                appendTo="body" [style]="{ width: '54rem', maxWidth: '95vw' }" [header]="docDetailTitle()">
        @if (docDetailLoading()) {
          <div class="ed-empty">Cargando documento…</div>
        } @else {
          @if (docDetail(); as dd) {
          @if (dd.header; as h) {
            <div class="ed-dochdr-grid">
              <div><span class="ed-dl">Beneficiario</span><span class="ed-dv">{{ h.beneficiario || '—' }}</span></div>
              <div><span class="ed-dl">RFC</span><span class="ed-dv mono">{{ h.rfc || '—' }}</span></div>
              <div><span class="ed-dl">Concepto</span><span class="ed-dv">{{ h.concepto || '—' }}</span></div>
              <div><span class="ed-dl">Área</span><span class="ed-dv">{{ h.area || '—' }}</span></div>
              <div><span class="ed-dl">Fecha</span><span class="ed-dv">{{ (h.fecha_doc || h.fecha) | date:'dd/MM/yyyy' }}</span></div>
              <div><span class="ed-dl">Sucursal</span><span class="ed-dv">{{ h.sucursal_nombre || h.sucursal }}</span></div>
              <div><span class="ed-dl">Total</span><span class="ed-dv strong">{{ money(h.importe) }}</span></div>
              <div><span class="ed-dl">IVA</span><span class="ed-dv">{{ money(h.iva) }}</span></div>
            </div>
          } @else {
            <div class="ed-empty">Sin cabecera (póliza de diario/presupuesto sin factura).</div>
          }
          <!-- GX.4.3 — Cadena de aprovisionamiento (orden → recepción → factura → pago) -->
          @if (dd.chain; as ch) {
            <h4 class="ed-dsec">Cadena de aprovisionamiento</h4>
            <div class="ed-chain">
              @for (st of chainStages(ch); track st.key) {
                <div class="ed-stage" [class.done]="st.folio" [class.miss]="!st.folio">
                  <div class="ed-stage-ico"><i class="pi" [ngClass]="st.icon"></i></div>
                  <div class="ed-stage-body">
                    <span class="ed-stage-name">{{ st.name }}</span>
                    @if (st.folio) {
                      <span class="ed-stage-folio mono">{{ st.folio }}</span>
                      <span class="ed-stage-date">{{ st.fecha | date:'dd/MM/yy' }}</span>
                    } @else {
                      <span class="ed-stage-miss">sin registro</span>
                    }
                  </div>
                </div>
              }
            </div>
            @if (ch.lead_days != null || ch.pago_days != null) {
              <div class="ed-chain-metrics">
                @if (ch.lead_days != null) { <span><b>{{ ch.lead_days }}</b> d orden→factura</span> }
                @if (ch.pago_days != null) { <span><b>{{ ch.pago_days }}</b> d factura→pago</span> }
              </div>
            }
          }
          @if (dd.lines.length) {
            <h4 class="ed-dsec">Productos ({{ dd.lines.length }})</h4>
            <p-table [value]="dd.lines" styleClass="p-datatable-sm ed-table" [scrollable]="true" scrollHeight="280px">
              <ng-template pTemplate="header">
                <tr><th style="width:5rem">SKU</th><th>Producto</th><th class="ta-r" style="width:6rem">Cant.</th><th style="width:4rem">Pres.</th><th class="ta-r" style="width:7rem">Costo u.</th><th class="ta-r" style="width:8rem">Importe</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-l>
                <tr>
                  <td class="mono">{{ l.sku || '—' }}</td><td>{{ l.producto || '—' }}</td>
                  <td class="ta-r">{{ l.cantidad != null ? (l.cantidad | number:'1.0-0') : '—' }}</td>
                  <td class="muted">{{ l.presentacion || '—' }}</td>
                  <td class="ta-r">{{ l.costo_unitario != null ? money(l.costo_unitario) : '—' }}</td>
                  <td class="ta-r strong">{{ money(l.importe) }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else {
            <p class="muted">Sin desglose de producto (típico de gastos).</p>
          }
          @if (dd.postings.length) {
            <h4 class="ed-dsec">Posturas contables ({{ dd.postings.length }})</h4>
            <p-table [value]="dd.postings" styleClass="p-datatable-sm ed-table">
              <ng-template pTemplate="header"><tr><th style="width:3rem">#</th><th>Cuenta</th><th class="ta-r" style="width:9rem">Importe</th></tr></ng-template>
              <ng-template pTemplate="body" let-p>
                <tr><td class="muted">{{ p.linea }}</td><td><span class="mono">{{ p.cuenta }}</span> <span class="muted">{{ p.cuenta_nombre || '' }}</span></td><td class="ta-r strong">{{ money(p.importe) }}</td></tr>
              </ng-template>
            </p-table>
          }
          } @else {
            <div class="ed-empty">No se encontró el documento.</div>
          }
        }
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ed-head { display: flex; align-items: center; gap: 1rem; }
    .ed-crumbs { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; margin-bottom: .9rem; font-size: .8rem; }
    .ed-crumb-root { background: none; border: none; cursor: pointer; color: var(--text-muted, #78716c); font-weight: 600; display: inline-flex; align-items: center; gap: .35rem; padding: .2rem .4rem; border-radius: 6px; }
    .ed-crumb-root:hover { background: var(--surface-2, #f5f5f4); color: var(--text, #1c1917); }
    .ed-crumb-sep { color: var(--text-muted, #a8a29e); font-size: .7rem; }
    .ed-crumb { display: inline-flex; align-items: center; border: 1px solid var(--border, #e7e5e4); border-radius: 999px; background: var(--card-bg, #fff); overflow: hidden; }
    .ed-crumb.active { border-color: var(--action, #FB923C); background: color-mix(in srgb, var(--action, #FB923C) 8%, transparent); }
    .ed-crumb-btn { background: none; border: none; cursor: pointer; padding: .22rem .5rem; font-size: .8rem; color: var(--text, #1c1917); display: inline-flex; align-items: center; gap: .35rem; }
    .ed-crumb-btn:hover { background: var(--surface-2, #f5f5f4); }
    .ed-crumb-dim { font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .ed-crumb-x { background: none; border: none; cursor: pointer; padding: .22rem .4rem; color: var(--text-muted, #a8a29e); border-left: 1px solid var(--border, #e7e5e4); }
    .ed-crumb-x:hover { color: var(--bad-fg, #dc2626); background: var(--surface-2, #f5f5f4); }
    .ed-crumb-x .pi { font-size: .68rem; }
    .ed-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .ed-field { display: flex; flex-direction: column; gap: .35rem; }
    .ed-field label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ed-narrow { max-width: 10rem; }
    .ed-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ed-kpi { border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .85rem 1rem; background: var(--card-bg, #fff); }
    .ed-kpi-label { display: block; font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ed-kpi-val { display: block; font-size: 1.35rem; font-weight: 700; margin-top: .15rem; }
    .ed-kpi-sub { display: block; font-size: .74rem; margin-top: .1rem; color: var(--text-muted, #78716c); }
    .ed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
    @media (max-width: 900px) { .ed-grid { grid-template-columns: 1fr; } }
    .ed-card { padding: 1rem; }
    .ed-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; }
    .ed-bk-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .3rem; }
    .ed-dim-select { display: inline-flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
    .ed-dim-hint { font-size: .72rem; color: var(--text-muted, #78716c); }
    .ed-dim-btn { border: 1px solid var(--border, #e7e5e4); background: var(--card-bg, #fff); border-radius: 999px; padding: .2rem .6rem; font-size: .74rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .ed-dim-btn:hover { border-color: var(--action, #FB923C); color: var(--text, #1c1917); }
    .ed-dim-btn.active { background: var(--action, #FB923C); border-color: var(--action, #FB923C); color: #fff; font-weight: 600; }
    .ed-docs-head { display: flex; align-items: center; gap: 1rem; margin-bottom: .5rem; }
    .ed-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .strong { font-weight: 700; }
    .muted { color: var(--text-muted, #78716c); }
    .up { color: var(--bad-fg); font-weight: 600; }
    .down { color: var(--ok-fg); font-weight: 600; }
    .ed-clickable { cursor: pointer; }
    .ed-clickable:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .ed-add { color: var(--action, #FB923C); font-size: .72rem; opacity: 0; transition: opacity .12s; }
    .ed-clickable:hover .ed-add { opacity: 1; }
    .ed-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .ed-dochdr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem 1.25rem; margin-bottom: 1rem; }
    .ed-dochdr-grid > div { display: flex; flex-direction: column; gap: .15rem; }
    .ed-dl { font-size: .68rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ed-dv { font-size: .92rem; }
    .ed-dsec { margin: 1.1rem 0 .5rem; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .ed-chain { display: flex; gap: .4rem; flex-wrap: wrap; }
    .ed-stage { display: flex; align-items: center; gap: .5rem; border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .5rem .7rem; min-width: 8.5rem; }
    .ed-stage.done { border-color: color-mix(in srgb, var(--ok-fg, #16a34a) 40%, var(--border, #e7e5e4)); background: color-mix(in srgb, var(--ok-fg, #16a34a) 5%, transparent); }
    .ed-stage.miss { opacity: .6; border-style: dashed; }
    .ed-stage-ico .pi { font-size: 1rem; color: var(--text-muted, #78716c); }
    .ed-stage.done .ed-stage-ico .pi { color: var(--ok-fg, #16a34a); }
    .ed-stage-body { display: flex; flex-direction: column; line-height: 1.2; }
    .ed-stage-name { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; color: var(--text-muted, #78716c); }
    .ed-stage-folio { font-size: .85rem; font-weight: 600; }
    .ed-stage-date { font-size: .72rem; color: var(--text-muted, #78716c); }
    .ed-stage-miss { font-size: .74rem; color: var(--text-muted, #a8a29e); font-style: italic; }
    .ed-chain-metrics { display: flex; gap: 1.2rem; margin-top: .6rem; font-size: .8rem; color: var(--text-muted, #57534e); }
    .ed-chain-metrics b { color: var(--text, #1c1917); font-size: .95rem; }
  `],
})
export class ComercialEgresoDetalleComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly theme = inject(ThemeService);

  readonly report = signal<ExpensesReport | null>(null);
  readonly docs = signal<ExpenseDocRow[]>([]);
  readonly loading = signal(false);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly docDetail = signal<ExpenseDocumentDetail | null>(null);
  readonly docDetailOpen = signal(false);
  readonly docDetailLoading = signal(false);
  readonly docDetailTitle = signal('');
  readonly provider360 = signal<ExpenseProvider360 | null>(null);

  // GX.4.3 — cadena de restricciones acumuladas (breadcrumb)
  readonly chain = signal<Constraint[]>([]);
  readonly focus = computed<Constraint | null>(() => { const c = this.chain(); return c.length ? c[c.length - 1] : null; });
  // override manual de la dimensión de desglose (si el usuario elige otra)
  private readonly breakdownManual = signal<SliceType | null>(null);

  private readonly DIM_ORDER: SliceType[] = ['beneficiario', 'cuenta', 'cuenta_mayor', 'area', 'sucursal', 'doc_tipo'];
  private readonly DIM_SHORT: Record<SliceType, string> = {
    cuenta: 'Cuenta', cuenta_mayor: 'Mayor', beneficiario: 'Beneficiario', area: 'Área', sucursal: 'Sucursal', doc_tipo: 'Tipo doc',
  };
  private readonly DIM_FULL: Record<SliceType, string> = {
    cuenta: 'Cuenta contable', cuenta_mayor: 'Cuenta mayor', beneficiario: 'Beneficiario / proveedor',
    area: 'Área / departamento', sucursal: 'Sucursal', doc_tipo: 'Tipo de documento',
  };

  readonly providerConstraint = computed(() => this.chain().find((c) => c.type === 'beneficiario' && c.key !== '(sin beneficiario)') || null);
  readonly isProvider = computed(() => !!this.providerConstraint());
  readonly usedDims = computed(() => new Set(this.chain().map((c) => c.type)));
  readonly availDims = computed(() => this.DIM_ORDER.filter((d) => !this.usedDims().has(d)));
  readonly breakdownDim = computed<SliceType>(() => {
    const avail = this.availDims();
    const m = this.breakdownManual();
    if (m && avail.includes(m)) return m;
    const f = this.focus();
    const seed = f ? this.defaultDimFor(f.type) : 'cuenta';
    if (avail.includes(seed)) return seed;
    return avail[0] || 'cuenta';
  });

  // filtros propios
  sucursal: string[] = [];
  beneficiario = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];

  readonly title = computed(() => this.focus()?.label || 'Detalle de egresos');
  readonly subtitle = computed(() => {
    const f = this.focus();
    if (!f) return 'Todos los egresos';
    const extra = this.chain().length > 1 ? ` · ${this.chain().length} filtros activos` : '';
    return `${this.DIM_FULL[f.type]} · ${f.key}${extra}`;
  });
  readonly breakdownLabel = computed(() => this.DIM_SHORT[this.breakdownDim()] || 'Desglose');
  readonly topRows = computed(() => (this.report()?.rows || []).slice(0, 50));
  readonly ticket = computed(() => { const n = this.docs().length; return n ? (this.report()?.total || 0) / n : 0; });
  readonly deltaTotal = computed(() => {
    const rows = this.report()?.rows || [];
    const t = this.report()?.total || 0;
    const prev = rows.reduce((a, r) => a + (r.prev_total || 0), 0);
    return prev ? +(((t - prev) / prev) * 100).toFixed(1) : null;
  });
  readonly chartData = computed(() => {
    const s = this.report()?.series || [];
    return {
      labels: s.map((p) => p.mes),
      datasets: [
        { label: 'Compras / Costo', data: s.map((p) => p.compras), backgroundColor: '#FB923C' },
        { label: 'Gastos', data: s.map((p) => p.gastos), backgroundColor: '#60A5FA' },
      ],
    };
  });
  // Theme-aware: sin colores explícitos, ejes/leyenda usan el gris default de Chart.js (ilegible en dark).
  readonly chartOpts = computed(() => egresChartOptions(this.theme.isMonochrome()));

  dimShort(t: SliceType) { return this.DIM_SHORT[t] || t; }
  private defaultDimFor(type: SliceType): SliceType {
    switch (type) {
      case 'cuenta': case 'cuenta_mayor': return 'beneficiario';
      case 'beneficiario': case 'area': return 'cuenta';
      default: return 'cuenta_mayor';
    }
  }

  constructor() {
    this.svc.expensesSucursales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code }))));
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      let chain: Constraint[] = [];
      if (q['chain']) { try { chain = JSON.parse(q['chain']).filter((c: any) => c && c.type && c.key); } catch { /* noop */ } }
      if (!chain.length && q['type'] && q['key']) chain = [{ type: q['type'] as SliceType, key: q['key'], label: q['label'] || q['key'] }];
      this.chain.set(chain);
      this.breakdownManual.set(null);
      if (q['from'] && q['to']) this.rangeDates = [new Date(q['from'] + 'T00:00:00'), new Date(q['to'] + 'T00:00:00')];
      if (q['suc']) this.sucursal = String(q['suc']).split(',').filter(Boolean);
      this.reload();
    });
  }

  /** Combina TODAS las restricciones de la cadena en los filtros del backend. */
  private chainFilters(): Partial<ExpensesParams> {
    const f: Partial<ExpensesParams> = {};
    for (const c of this.chain()) {
      switch (c.type) {
        case 'cuenta': f.cuenta = c.key; break;
        case 'cuenta_mayor': f.cuenta_mayor = c.key; break;
        case 'beneficiario': if (c.key === '(sin beneficiario)') f.beneficiario_null = true; else f.beneficiario_eq = c.key; break;
        case 'area': if (c.key === '(sin área)') f.area_null = true; else f.area = c.key; break;
        case 'sucursal': f.sucursal = [c.key]; break;
        case 'doc_tipo': f.doc_tipo = c.key; break;
      }
    }
    return f;
  }

  private params(extra: Partial<ExpensesParams> = {}): ExpensesParams {
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    const cf = this.chainFilters();
    return {
      from: fmt(a), to: fmt(b),
      // la sucursal de la cadena (si existe) manda; si no, el multiselect
      sucursal: cf.sucursal ?? (this.sucursal?.length ? this.sucursal : undefined),
      // el beneficiario libre solo si la cadena no fija uno
      beneficiario: cf.beneficiario_eq || cf.beneficiario_null ? undefined : (this.beneficiario || undefined),
      min_importe: this.minImporte ?? undefined,
      ...cf,
      ...extra,
    };
  }

  private repSub?: Subscription;
  private docsSub?: Subscription;
  private provSub?: Subscription;

  private localTimer: ReturnType<typeof setTimeout> | null = null;

  /** Recarga TODO (reporte + documentos + proveedor). Para cambios de filtro/cadena. */
  reload() {
    if (this.localTimer) { clearTimeout(this.localTimer); this.localTimer = null; }
    if (!this.chain().length) { this.report.set(null); this.docs.set([]); this.provider360.set(null); return; }
    this.loadReport();
    this.loadDocs();
    this.loadProvider();
  }

  /** Filtros locales (beneficiario/monto) con debounce: agrupa cambios rápidos en una request. */
  queueReload() {
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => { this.localTimer = null; this.reload(); }, 300);
  }

  private loadReport() {
    if (!this.chain().length) return;
    this.loading.set(true);
    this.repSub?.unsubscribe();
    this.repSub = this.svc.expenses(this.params({ group_by: this.breakdownDim(), compare: true }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el detalle' }); },
      });
  }

  private loadDocs() {
    if (!this.chain().length) return;
    this.docsSub?.unsubscribe();
    this.docsSub = this.svc.expenseDocuments(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.docs.set(d), error: () => {} });
  }

  private loadProvider() {
    // Proveedor 360: saldo/DPO/pagos (ap_provider) + top productos (kdm2)
    this.provider360.set(null);
    const prov = this.providerConstraint();
    if (!prov) return;
    this.provSub?.unsubscribe();
    this.provSub = this.svc.expenseProvider(prov.key, { sucursal: this.sucursal?.length ? this.sucursal : undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (p) => this.provider360.set(p), error: () => {} });
  }

  /** Filtros propios cambian (rango/sucursal) → refleja en URL + recarga. */
  applyFilters() { this.navigateChain(this.chain()); }

  /** Cambiar la dimensión de desglose reagrupa SOLO el reporte (docs/proveedor no dependen de ella). */
  setBreakdown(d: SliceType) { this.breakdownManual.set(d); this.loadReport(); }

  /** Drill en fila del desglose → AGREGA la restricción a la cadena (no reemplaza). */
  drillInto(row: ExpenseRow) {
    const type = this.breakdownDim();
    if (this.usedDims().has(type)) return;
    this.navigateChain([...this.chain(), { type, key: row.key, label: row.label }]);
  }

  /** Click en una miga → recorta la cadena hasta ese nivel. */
  goToCrumb(i: number) { this.navigateChain(this.chain().slice(0, i + 1)); }
  /** Quitar una restricción individual. */
  removeCrumb(i: number) { const c = [...this.chain()]; c.splice(i, 1); this.navigateChain(c); }

  private navigateChain(chain: Constraint[]) {
    if (!chain.length) { this.back(); return; }
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    this.router.navigate([], {
      queryParams: { chain: JSON.stringify(chain), type: null, key: null, label: null, from: fmt(a), to: fmt(b), suc: this.sucursal.join(',') || null },
      queryParamsHandling: 'merge',
    });
  }

  back() { this.router.navigate(['/finanzas/egresos']); }

  private docDetailSub?: Subscription;
  openDocument(d: ExpenseDocRow) {
    if (!d?.sucursal || !d.doc_tipo || !d.doc_folio) return;
    this.docDetailTitle.set(`${d.doc_tipo}-${d.doc_folio}`);
    this.docDetail.set(null);
    this.docDetailOpen.set(true);
    this.docDetailLoading.set(true);
    this.docDetailSub?.unsubscribe();
    this.docDetailSub = this.svc.expenseDocument(d.sucursal, d.doc_tipo, d.doc_folio)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (dd) => { this.docDetail.set(dd); this.docDetailLoading.set(false); },
        error: () => { this.docDetailLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el documento' }); },
      });
  }

  /** GX.4.3 — arma las etapas de la cadena de aprovisionamiento para el timeline. */
  chainStages(ch: NonNullable<ExpenseDocumentDetail['chain']>) {
    return [
      { key: 'orden', name: 'Orden', icon: 'pi-file-edit', folio: ch.orden_folio, fecha: ch.orden_fecha },
      { key: 'recepcion', name: 'Recepción', icon: 'pi-box', folio: ch.recepcion_folio, fecha: ch.recepcion_fecha },
      { key: 'factura', name: 'Factura', icon: 'pi-receipt', folio: ch.factura_folio, fecha: ch.factura_fecha },
      { key: 'pago', name: 'Pago', icon: 'pi-wallet', folio: ch.pago_folio, fecha: ch.pago_fecha },
    ];
  }

  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const lines = ['label,importe,share_pct'];
    for (const row of r.rows) lines.push(`"${(row.label || '').replace(/"/g, '""')}",${row.total},${row.share_pct}`);
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const f = this.focus();
    link.href = url; link.download = `egreso_${f?.type || 'detalle'}_${f?.key || ''}.csv`; link.click();
    URL.revokeObjectURL(url);
  }
}
