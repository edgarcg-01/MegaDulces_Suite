import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TableModule } from 'primeng/table';
import { TreeTableModule } from 'primeng/treetable';
import { ChartModule } from 'primeng/chart';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { MessageService, TreeNode } from 'primeng/api';
import {
  ComercialService,
  ExpensesReport,
  ExpensesTree,
  ExpenseTreeNode,
  ExpenseDocRow,
  ExpenseRow,
  ExpensesParams,
  ExpenseGroupBy,
  ExpenseDocumentDetail,
  ApProvider,
  ExpenseFinding,
  ExpenseFindingsReport,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { REPORTS_TABS } from '../reports-tabs';

/**
 * GX v2 — Egresos contables (pólizas gastos + compras) con desglose jerárquico
 * tipo menú (Familia→Mayor→Subcuenta), tabla dinámica por dimensión, tendencia
 * mensual, filtros ampliados, comparativo de período y drill a documentos.
 */
@Component({
  selector: 'app-comercial-egresos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, MultiSelectModule, SelectModule,
    DatePickerModule, InputNumberModule, InputTextModule, ToggleSwitchModule,
    TableModule, TreeTableModule, ChartModule, ToastModule, DialogModule,
    PageTabsComponent, SegmentedComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Egresos contables</h1>
          <p class="surf-page-sub">Pólizas de gastos (6xx) y compras (5xx) · desglose por cuenta, beneficiario, sucursal y más · fuente Kepler</p>
        </div>
        <button pButton type="button" label="Exportar CSV" icon="pi pi-download"
                class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"></button>
      </header>

      <!-- Filtros -->
      <div class="ex-filters card-premium card-flat">
        <div class="ex-field"><label>Rango</label>
          <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="load()" /></div>
        <div class="ex-field"><label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code" placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" /></div>
        <div class="ex-field"><label>Tipo</label>
          <app-segmented [options]="familiaOpts" [value]="familia()" (valueChange)="setStr(familia, $event)" ariaLabel="Tipo de egreso" /></div>
        <div class="ex-field"><label>Tipo doc</label>
          <p-select [options]="docTipoOpts()" [(ngModel)]="docTipo" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="load()" styleClass="w-full" /></div>
        <div class="ex-field"><label>Área</label>
          <p-select [options]="areaOpts()" [(ngModel)]="area" [showClear]="true" placeholder="Todas" appendTo="body" (onChange)="load()" styleClass="w-full" [filter]="true" /></div>
        <div class="ex-field"><label>Beneficiario</label>
          <input pInputText [(ngModel)]="beneficiario" placeholder="Buscar…" (keyup.enter)="load()" (blur)="load()" /></div>
        <div class="ex-field ex-narrow"><label>Monto ≥</label>
          <p-inputNumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="load()" /></div>
        <div class="ex-field ex-toggle"><label>Comparar</label>
          <p-toggleSwitch [(ngModel)]="compare" (ngModelChange)="load()" /></div>
      </div>

      <!-- KPIs -->
      @if (report(); as r) {
        <div class="ex-kpis">
          <div class="ex-kpi">
            <span class="ex-kpi-label">Egreso total</span>
            <span class="ex-kpi-val">{{ money(r.total) }}</span>
            <span class="ex-kpi-sub">{{ r.movimientos | number }} movs · {{ r.from }} → {{ r.to }}</span>
          </div>
          @for (f of r.by_familia; track f.familia) {
            <div class="ex-kpi">
              <span class="ex-kpi-label">{{ f.label }}</span>
              <span class="ex-kpi-val">{{ money(f.total) }}</span>
              <span class="ex-kpi-sub">{{ f.movs | number }} movs · {{ pct(f.total, r.total) }}%</span>
            </div>
          }
        </div>
      }

      <!-- Vista -->
      <div class="ex-viewbar">
        <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista" />
        @if (view() === 'tabla') {
          <div class="ex-dim">
            <label>Agrupar por</label>
            <p-select [options]="groupByOpts" [ngModel]="groupBy()" (ngModelChange)="setGroupBy($event)" optionLabel="label" optionValue="value" appendTo="body" />
          </div>
        }
      </div>

      <!-- DEBUG temporal -->
      <div style="background:#fde68a;color:#111;padding:.4rem .7rem;font-size:.78rem;border-radius:6px;margin-bottom:.6rem;font-family:monospace">
        DEBUG · vista={{ view() }} · docsTitle="{{ docsTitle() }}" · docs={{ docs().length }} · detailOpen={{ docDetailOpen() }}
      </div>

      @if (loading()) {
        <div class="ex-empty">Cargando…</div>
      } @else {
        <!-- ÁRBOL -->
        @if (view() === 'arbol') {
          <p-treeTable [value]="treeNodes()" [scrollable]="true" styleClass="p-treetable-sm ex-table">
            <ng-template pTemplate="header">
              <tr><th>Concepto</th><th class="ta-r" style="width:8rem">Movs</th><th class="ta-r" style="width:12rem">Importe</th><th class="ta-r" style="width:7rem">%</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
              <tr [ttRow]="rowNode" [class.ex-clickable]="rowData.level === 'cuenta'" (click)="rowData.level === 'cuenta' && openCuenta(rowData.key, rowData.label)">
                <td>
                  <p-treeTableToggler [rowNode]="rowNode" />
                  <span [class.strong]="rowData.level === 'familia'" [class.muted]="rowData.level === 'cuenta'">{{ rowData.label }}</span>
                  @if (rowData.level === 'cuenta') { <span class="mono ex-code">{{ rowData.key }}</span> }
                </td>
                <td class="ta-r">{{ rowData.movs | number }}</td>
                <td class="ta-r strong">{{ money(rowData.total) }}</td>
                <td class="ta-r muted">{{ rowData.share_pct }}%</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="4" class="ex-empty">Sin egresos.</td></tr></ng-template>
          </p-treeTable>
        }

        <!-- TABLA DINÁMICA -->
        @if (view() === 'tabla' && report(); as r) {
          <p-table [value]="r.rows" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm ex-table" [rowHover]="true"
                   [paginator]="r.rows.length > 50" [rows]="50" sortField="total" [sortOrder]="-1">
            <ng-template pTemplate="header">
              <tr>
                <th pSortableColumn="label">{{ groupByLabel() }}</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="movs">Movs</th>
                <th class="ta-r" style="width:12rem" pSortableColumn="total">Importe</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="share_pct">%</th>
                @if (compare()) { <th class="ta-r" style="width:8rem" pSortableColumn="delta_pct">Δ vs prev</th> }
                <th style="width:3rem"></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-row>
              <tr class="ex-clickable" (click)="drillRow(row)">
                <td>
                  {{ row.label }}
                  @if (row.familia === '5') { <span class="ex-tag fam5">Compra</span> }
                  @else if (row.familia === '6') { <span class="ex-tag fam6">Gasto</span> }
                </td>
                <td class="ta-r">{{ row.movs | number }}</td>
                <td class="ta-r strong">{{ money(row.total) }}</td>
                <td class="ta-r muted">{{ row.share_pct }}%</td>
                @if (compare()) {
                  <td class="ta-r" [class.up]="row.delta_pct > 0" [class.down]="row.delta_pct < 0">
                    {{ row.delta_pct === null ? '—' : (row.delta_pct > 0 ? '+' : '') + row.delta_pct + '%' }}
                  </td>
                }
                <td class="ta-r"><i class="pi pi-angle-right muted"></i></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td [attr.colspan]="compare() ? 6 : 5" class="ex-empty">Sin egresos en el período.</td></tr></ng-template>
          </p-table>
        }

        <!-- TENDENCIA -->
        @if (view() === 'tendencia') {
          <div class="card-premium card-flat ex-chart">
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts" height="360px"></p-chart>
          </div>
        }
      }

      <!-- PROVEEDORES (cuenta 201) -->
      @if (view() === 'proveedores') {
        <div class="ex-viewbar">
          <div class="ex-field" style="max-width:18rem">
            <input pInputText [(ngModel)]="providerSearch" placeholder="Buscar proveedor…" (keyup.enter)="loadProviders()" (blur)="loadProviders()" />
          </div>
          <span class="muted">Top {{ providers().length }} por compra · saldo = compra − pagos (ventana)</span>
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="providers()" styleClass="p-datatable-sm ex-table" [rowHover]="true" [scrollable]="true" scrollHeight="520px"
                   [paginator]="providers().length > 50" [rows]="50">
            <ng-template pTemplate="header">
              <tr>
                <th>Proveedor</th>
                <th class="ta-r" style="width:9rem" pSortableColumn="compra_12m">Compra 12m</th>
                <th class="ta-r" style="width:6rem">% </th>
                <th class="ta-r" style="width:9rem">Pagos</th>
                <th class="ta-r" style="width:9rem">Saldo</th>
                <th class="ta-r" style="width:5rem">Fact.</th>
                <th class="ta-r" style="width:6rem">DPO</th>
                <th style="width:6rem">Últ. compra</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr>
                <td>{{ p.proveedor }}</td>
                <td class="ta-r strong">{{ money(p.compra_12m) }}</td>
                <td class="ta-r muted">{{ p.share_pct }}%</td>
                <td class="ta-r">{{ money(p.pagos_12m) }}</td>
                <td class="ta-r" [class.up]="p.saldo > 0">{{ money(p.saldo) }}</td>
                <td class="ta-r">{{ p.num_facturas }}</td>
                <td class="ta-r" [class.up]="p.dpo_dias != null && p.dpo_dias > 60">{{ p.dpo_dias != null ? p.dpo_dias + ' d' : '—' }}</td>
                <td>{{ p.ultima_compra | date:'dd/MM/yy' }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="ex-empty">Sin proveedores (¿corrió el feed de AP?).</td></tr></ng-template>
          </p-table>
        </div>
      }

      <!-- HALLAZGOS -->
      @if (view() === 'hallazgos') {
        @if (findings(); as f) {
          <div class="ex-findcards">
            @for (s of f.summary; track s.tipo) {
              <button type="button" class="ex-findcard" [class.active]="findingTipo() === s.tipo"
                      [class.sev-bad]="findingMeta(s.tipo).sev === 'bad'" (click)="loadFindings(s.tipo)">
                <span class="ex-findcard-label">{{ findingMeta(s.tipo).label }}</span>
                <span class="ex-findcard-val">{{ money(s.total) }}</span>
                <span class="ex-findcard-sub">{{ s.num }} pólizas</span>
              </button>
            }
          </div>
          @if (findingTipo()) {
            <p class="muted ex-findhint">{{ findingMeta(findingTipo()).hint }}</p>
            <div class="card-premium card-flat">
              <p-table [value]="f.rows" styleClass="p-datatable-sm ex-table" [rowHover]="true" [scrollable]="true" scrollHeight="480px"
                       [paginator]="f.rows.length > 100" [rows]="100">
                <ng-template pTemplate="header">
                  <tr><th style="width:6rem">Fecha</th><th>Documento</th><th>Sucursal</th><th>Beneficiario</th><th>Cuenta</th><th class="ta-r" style="width:9rem">Importe</th><th>Nota</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-r>
                  <tr>
                    <td>{{ r.fecha | date:'dd/MM/yy' }}</td>
                    <td class="mono">{{ r.doc_tipo }}-{{ r.doc_folio }}</td>
                    <td>{{ r.sucursal_nombre || r.sucursal }}</td>
                    <td>{{ r.beneficiario || '—' }}</td>
                    <td class="mono">{{ r.cuenta }}</td>
                    <td class="ta-r strong">{{ money(r.importe) }}</td>
                    <td class="muted">{{ r.nota || '' }}</td>
                  </tr>
                </ng-template>
                <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="ex-empty">Sin filas.</td></tr></ng-template>
              </p-table>
            </div>
          } @else {
            <p class="ex-empty">Selecciona un hallazgo para ver el detalle.</p>
          }
        } @else {
          <p class="ex-empty">Cargando hallazgos… (¿corrió el feed?)</p>
        }
      }

      <!-- Drill: documentos -->
      @if (docsTitle()) {
        <div class="ex-docs card-premium card-flat">
          <div class="ex-docs-head">
            <span class="ex-docs-title">{{ docsTitle() }}</span>
            <span class="ex-docs-total">{{ docsTotal() }} · {{ money(docsSum()) }}</span>
            <button pButton type="button" icon="pi pi-times" class="p-button-text p-button-sm" (click)="closeDocs()"></button>
          </div>
          <p-table [value]="docs()" styleClass="p-datatable-sm ex-table" [rowHover]="true" [scrollable]="true" scrollHeight="420px"
                   [paginator]="docs().length > 100" [rows]="100">
            <ng-template pTemplate="header">
              <tr><th style="width:6rem">Fecha</th><th>Documento</th><th>Sucursal</th><th>Cuenta</th><th>Beneficiario</th><th class="ta-r" style="width:9rem">Importe</th><th style="width:2.5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-d>
              <tr class="ex-clickable" (click)="openDocument(d)">
                <td>{{ d.fecha | date:'dd/MM/yy' }}</td>
                <td class="mono">{{ d.doc_tipo }}-{{ d.doc_folio }}</td>
                <td>{{ d.sucursal_nombre || d.sucursal }}</td>
                <td>{{ d.cuenta_nombre || d.cuenta }}</td>
                <td>{{ d.beneficiario || '—' }}</td>
                <td class="ta-r strong">{{ money(d.importe) }}</td>
                <td class="ta-r"><i class="pi pi-angle-right muted"></i></td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- Drill final: documento fuente (kdm1/kdm2) detrás de la póliza -->
      <p-dialog [visible]="docDetailOpen()" (visibleChange)="docDetailOpen.set($event)" [modal]="true" [dismissableMask]="true"
                appendTo="body" [style]="{ width: '54rem', maxWidth: '95vw' }" [header]="docDetailTitle()" styleClass="ex-doc-dialog">
        @if (docDetailLoading()) {
          <div class="ex-empty">Cargando documento…</div>
        } @else {
          @if (docDetail(); as dd) {
          @if (dd.header; as h) {
            <div class="ex-dochdr">
              <div class="ex-dochdr-grid">
                <div><span class="ex-dl">Beneficiario</span><span class="ex-dv">{{ h.beneficiario || '—' }}</span></div>
                <div><span class="ex-dl">RFC</span><span class="ex-dv mono">{{ h.rfc || '—' }}</span></div>
                <div><span class="ex-dl">Concepto</span><span class="ex-dv">{{ h.concepto || '—' }}</span></div>
                <div><span class="ex-dl">Área</span><span class="ex-dv">{{ h.area || '—' }}</span></div>
                <div><span class="ex-dl">Fecha</span><span class="ex-dv">{{ (h.fecha_doc || h.fecha) | date:'dd/MM/yyyy' }}</span></div>
                <div><span class="ex-dl">Sucursal</span><span class="ex-dv">{{ h.sucursal_nombre || h.sucursal }}</span></div>
                <div><span class="ex-dl">Total documento</span><span class="ex-dv strong">{{ money(h.importe) }}</span></div>
                <div><span class="ex-dl">IVA</span><span class="ex-dv">{{ money(h.iva) }}</span></div>
                <div><span class="ex-dl">Capturó</span><span class="ex-dv">{{ h.usuario || '—' }}</span></div>
              </div>
            </div>
          } @else {
            <div class="ex-empty">Sin cabecera de documento (póliza de diario/presupuesto sin factura).</div>
          }

          @if (dd.lines.length) {
            <h4 class="ex-dsec">Productos ({{ dd.lines.length }})</h4>
            <p-table [value]="dd.lines" styleClass="p-datatable-sm ex-table" [scrollable]="true" scrollHeight="300px">
              <ng-template pTemplate="header">
                <tr><th style="width:5rem">SKU</th><th>Producto</th><th class="ta-r" style="width:6rem">Cant.</th><th style="width:4rem">Pres.</th><th class="ta-r" style="width:7rem">Costo u.</th><th class="ta-r" style="width:8rem">Importe</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-l>
                <tr>
                  <td class="mono">{{ l.sku || '—' }}</td>
                  <td>{{ l.producto || '—' }}</td>
                  <td class="ta-r">{{ l.cantidad != null ? (l.cantidad | number:'1.0-0') : '—' }}</td>
                  <td class="muted">{{ l.presentacion || '—' }}</td>
                  <td class="ta-r">{{ l.costo_unitario != null ? money(l.costo_unitario) : '—' }}</td>
                  <td class="ta-r strong">{{ money(l.importe) }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else {
            <p class="ex-doc-nolines muted">Este documento no tiene desglose de producto en Kepler (típico de gastos — el detalle es la cuenta contable).</p>
          }

          @if (dd.postings.length) {
            <h4 class="ex-dsec">Posturas contables ({{ dd.postings.length }})</h4>
            <p-table [value]="dd.postings" styleClass="p-datatable-sm ex-table">
              <ng-template pTemplate="header">
                <tr><th style="width:3rem">#</th><th>Cuenta</th><th class="ta-r" style="width:9rem">Importe</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-p>
                <tr>
                  <td class="muted">{{ p.linea }}</td>
                  <td><span class="mono">{{ p.cuenta }}</span> <span class="muted">{{ p.cuenta_nombre || '' }}</span></td>
                  <td class="ta-r strong">{{ money(p.importe) }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
          } @else {
            <div class="ex-empty">No se encontró el documento.</div>
          }
        }
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ex-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .ex-field { display: flex; flex-direction: column; gap: .35rem; }
    .ex-field label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-narrow { max-width: 10rem; }
    .ex-toggle { align-items: center; }
    .ex-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ex-kpi { border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .85rem 1rem; background: var(--card-bg, #fff); }
    .ex-kpi-label { display: block; font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-kpi-val { display: block; font-size: 1.4rem; font-weight: 700; margin-top: .15rem; }
    .ex-kpi-sub { display: block; font-size: .74rem; color: var(--text-muted, #78716c); margin-top: .1rem; }
    .ex-viewbar { display: flex; align-items: center; gap: 1.5rem; margin-bottom: .75rem; flex-wrap: wrap; }
    .ex-dim { display: flex; align-items: center; gap: .5rem; }
    .ex-dim label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; }
    .ex-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .ex-code { color: var(--text-muted, #78716c); margin-left: .5rem; }
    .strong { font-weight: 700; }
    .muted { color: var(--text-muted, #78716c); }
    /* Egreso: subir el gasto es malo (rojo), bajarlo es bueno (verde). */
    .up { color: var(--bad-fg); font-weight: 600; }
    .down { color: var(--ok-fg); font-weight: 600; }
    .ex-clickable { cursor: pointer; }
    .ex-tag { display: inline-block; font-size: .68rem; font-weight: 600; padding: .05rem .4rem; border-radius: 999px; margin-left: .5rem; border: 1px solid var(--border, #e7e5e4); }
    .ex-tag.fam5 { color: var(--chip-brand-fg); border-color: var(--chip-brand-border); background: var(--chip-brand-bg); }
    .ex-tag.fam6 { color: var(--chip-competition-fg); border-color: var(--chip-competition-border); background: var(--chip-competition-bg); }
    .ex-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .ex-chart { padding: 1rem; }
    .ex-docs { margin-top: 1.25rem; padding: 1rem; }
    .ex-docs-head { display: flex; align-items: center; gap: 1rem; margin-bottom: .5rem; }
    .ex-docs-title { font-weight: 700; }
    .ex-docs-total { margin-left: auto; color: var(--text-muted, #78716c); font-weight: 600; }
    .ex-dochdr { margin-bottom: 1rem; }
    .ex-dochdr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem 1.25rem; }
    .ex-dochdr-grid > div { display: flex; flex-direction: column; gap: .15rem; }
    .ex-dl { font-size: .68rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-dv { font-size: .92rem; }
    .ex-dsec { margin: 1.1rem 0 .5rem; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .ex-doc-nolines { padding: .75rem 0; }
    .ex-findcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ex-findcard { text-align: left; border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .85rem 1rem; background: var(--card-bg, #fff); cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .ex-findcard:hover { border-color: var(--action, #f97316); }
    .ex-findcard.active { border-color: var(--action, #f97316); box-shadow: 0 0 0 1px var(--action, #f97316) inset; }
    .ex-findcard.sev-bad .ex-findcard-val { color: var(--bad-fg); }
    .ex-findcard-label { display: block; font-size: .78rem; font-weight: 600; color: var(--text-muted, #78716c); }
    .ex-findcard-val { display: block; font-size: 1.3rem; font-weight: 700; margin-top: .15rem; }
    .ex-findcard-sub { display: block; font-size: .74rem; color: var(--text-muted, #78716c); margin-top: .1rem; }
    .ex-findhint { margin: -.25rem 0 .75rem; font-size: .82rem; }
  `],
})
export class ComercialEgresosComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly reportTabs = REPORTS_TABS;
  readonly familiaOpts = [{ label: 'Todo', value: '' }, { label: 'Compras', value: '5' }, { label: 'Gastos', value: '6' }];
  readonly viewOpts = [
    { label: 'Árbol', value: 'arbol' }, { label: 'Tabla', value: 'tabla' }, { label: 'Tendencia', value: 'tendencia' },
    { label: 'Proveedores', value: 'proveedores' }, { label: 'Hallazgos', value: 'hallazgos' },
  ];
  readonly findingLabels: Record<string, { label: string; sev: string; hint: string }> = {
    iva_bug: { label: 'IVA acreditable huérfano', sev: 'bad', hint: 'XD5501 con abono a 122-001 sin cargo espejo (descuadra el libro)' },
    prov_203: { label: 'Provisiones 203 sin descargar', sev: 'warn', hint: 'Nómina/IMSS/SAT provisionados a 203 que nunca se cargan' },
    anticipo_107: { label: 'Anticipos 107 sin aplicar', sev: 'warn', hint: 'Anticipos a proveedor (cargo 107) nunca cruzados contra factura' },
  };
  readonly groupByOpts = [
    { label: 'Cuenta', value: 'cuenta' }, { label: 'Cuenta mayor', value: 'cuenta_mayor' },
    { label: 'Beneficiario', value: 'beneficiario' }, { label: 'Sucursal', value: 'sucursal' },
    { label: 'Tipo de documento', value: 'doc_tipo' }, { label: 'Área', value: 'area' }, { label: 'Mes', value: 'mes' },
  ];

  readonly report = signal<ExpensesReport | null>(null);
  readonly tree = signal<ExpensesTree | null>(null);
  readonly docs = signal<ExpenseDocRow[]>([]);
  readonly docsTitle = signal<string>('');
  readonly docDetail = signal<ExpenseDocumentDetail | null>(null);
  readonly docDetailOpen = signal(false);
  readonly docDetailLoading = signal(false);
  readonly docDetailTitle = signal<string>('');
  readonly providers = signal<ApProvider[]>([]);
  readonly findings = signal<ExpenseFindingsReport | null>(null);
  readonly findingTipo = signal<string>('');
  providerSearch = '';
  readonly loading = signal(false);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly docTipoOpts = signal<string[]>([]);
  readonly areaOpts = signal<string[]>([]);

  readonly view = signal<'arbol' | 'tabla' | 'tendencia' | 'proveedores' | 'hallazgos'>('arbol');
  readonly groupBy = signal<ExpenseGroupBy>('cuenta');
  readonly familia = signal<string>('');
  readonly compare = signal(false);
  sucursal: string[] = [];
  docTipo: string | null = null;
  area: string | null = null;
  beneficiario = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];

  readonly treeNodes = computed<TreeNode[]>(() => (this.tree()?.tree || []).map((n) => this.toNode(n, true)));
  readonly groupByLabel = computed(() => this.groupByOpts.find((o) => o.value === this.groupBy())?.label || 'Concepto');
  readonly docsTotal = computed(() => `${this.docs().length} docs`);
  readonly docsSum = computed(() => this.docs().reduce((a, d) => a + d.importe, 0));
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
  readonly chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom' } },
    scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v: any) => '$' + Number(v).toLocaleString('es-MX') } } },
  };

  constructor() {
    console.log('[egresos] build GX-v3 drill+42702fix+logs · ' + new Date().toISOString());
    this.svc.expensesSucursales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code }))));
    this.svc.expensesFilters().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((f) => { this.docTipoOpts.set(f.doc_tipos); this.areaOpts.set(f.areas); });
    this.load();
  }

  private params(extra: Partial<ExpensesParams> = {}): ExpensesParams {
    const [a, b] = this.rangeDates || [];
    // Formateo local (no toISOString → evita correr el día por UTC-6 en MX).
    const fmt = (d?: Date) =>
      d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    return {
      from: fmt(a), to: fmt(b),
      sucursal: this.sucursal, familia: (this.familia() || undefined) as '5' | '6' | undefined,
      doc_tipo: this.docTipo || undefined, area: this.area || undefined,
      beneficiario: this.beneficiario || undefined,
      min_importe: this.minImporte ?? undefined,
      ...extra,
    };
  }

  setStr(sig: { set: (v: string) => void }, v: string) { sig.set(v || ''); this.load(); }
  setView(v: string) { this.view.set(v as any); this.load(); }
  setGroupBy(v: string) { this.groupBy.set(v as ExpenseGroupBy); this.closeDocs(); this.load(); }

  private reportSub?: Subscription;
  private treeSub?: Subscription;
  private docsSub?: Subscription;

  load() {
    this.loading.set(true);
    this.closeDocs(); // el drill abierto queda inválido al cambiar filtros
    this.reportSub?.unsubscribe(); // cancela la request anterior: sin esto una respuesta lenta vieja pisa a la nueva
    this.reportSub = this.svc.expenses(this.params({ group_by: this.groupBy(), compare: this.compare() }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar egresos' }); },
      });
    if (this.view() === 'arbol') {
      this.treeSub?.unsubscribe();
      this.treeSub = this.svc.expensesTree(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (t) => this.tree.set(t), error: () => {} });
    }
    if (this.view() === 'proveedores') this.loadProviders();
    if (this.view() === 'hallazgos') this.loadFindings(this.findingTipo());
  }

  private providersSub?: Subscription;
  private findingsSub?: Subscription;

  loadProviders() {
    this.providersSub?.unsubscribe();
    this.providersSub = this.svc.apProviders({ search: this.providerSearch, sucursal: this.sucursal, limit: 200 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.providers.set(r), error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar proveedores' }) });
  }

  loadFindings(tipo: string) {
    this.findingTipo.set(tipo);
    this.findingsSub?.unsubscribe();
    this.findingsSub = this.svc.expenseFindings({ tipo: tipo || undefined, sucursal: this.sucursal, limit: 1000 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.findings.set(r), error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar hallazgos' }) });
  }

  readonly findingMeta = (t: string) => this.findingLabels[t] || { label: t, sev: 'warn', hint: '' };

  private toNode(n: ExpenseTreeNode, expanded = false): TreeNode {
    return {
      data: n,
      expanded,
      leaf: !n.children || n.children.length === 0,
      children: (n.children || []).map((c) => this.toNode(c, false)),
    };
  }

  /** Click en fila de tabla dinámica → drill: si es cuenta/beneficiario carga documentos. */
  drillRow(row: ExpenseRow) {
    console.log('[egresos] drillRow CLICK →', { group_by: this.groupBy(), key: row?.key, label: row?.label });
    const gb = this.groupBy();
    const extra: Partial<ExpensesParams> = {};
    if (gb === 'cuenta') extra.cuenta = row.key;
    else if (gb === 'cuenta_mayor') extra.cuenta_mayor = row.key;
    else if (gb === 'beneficiario') {
      // match exacto (no ILIKE: "PEDRO" no debe traer "PEDROZA"); el bucket sintético filtra IS NULL
      if (row.key === '(sin beneficiario)') extra.beneficiario_null = true;
      else extra.beneficiario_eq = row.key;
    }
    else if (gb === 'sucursal') extra.sucursal = [row.key];
    else if (gb === 'doc_tipo') extra.doc_tipo = row.key;
    else if (gb === 'area') {
      if (row.key === '(sin área)') extra.area_null = true;
      else extra.area = row.key;
    }
    else return; // 'mes' no drillea a doc
    this.loadDocs(extra, `${this.groupByLabel()}: ${row.label}`);
  }

  openCuenta(cuenta: string, label: string) {
    console.log('[egresos] openCuenta CLICK →', { cuenta, label });
    this.loadDocs({ cuenta }, `Cuenta ${cuenta} · ${label}`);
  }

  private loadDocs(extra: Partial<ExpensesParams>, title: string) {
    console.log('[egresos] loadDocs → llamando /documents con', extra);
    this.docsTitle.set(title);
    this.docsSub?.unsubscribe();
    this.docsSub = this.svc.expenseDocuments(this.params(extra)).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          console.log('[egresos] /documents OK →', d?.length, 'documentos');
          this.docs.set(d);
          // auto-scroll a la tabla de documentos (puede quedar debajo del árbol largo)
          setTimeout(() => document.querySelector('.ex-docs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
        },
        error: (err) => { console.error('[egresos] /documents ERROR →', err?.status, err?.message); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar documentos' }); },
      });
  }

  closeDocs() { this.docsTitle.set(''); this.docs.set([]); }

  private docDetailSub?: Subscription;
  /** Click en una fila de documento → abre el documento fuente (kdm1/kdm2). */
  openDocument(d: ExpenseDocRow) {
    console.log('[egresos] openDocument CLICK →', { sucursal: d?.sucursal, doc_tipo: d?.doc_tipo, folio: d?.doc_folio });
    if (!d || !d.sucursal || !d.doc_tipo || !d.doc_folio) {
      console.warn('[egresos] fila sin llave de documento — no se puede abrir', d);
      this.toast.add({ severity: 'warn', summary: 'Sin documento', detail: 'Esta fila no tiene documento fuente asociado' });
      return;
    }
    this.docDetailTitle.set(`${d.doc_tipo}-${d.doc_folio}`);
    this.docDetail.set(null);
    this.docDetailOpen.set(true);
    this.docDetailLoading.set(true);
    console.log('[egresos] dialog abierto=true, llamando endpoint…');
    this.docDetailSub?.unsubscribe();
    this.docDetailSub = this.svc.expenseDocument(d.sucursal, d.doc_tipo, d.doc_folio)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (dd) => {
          console.log('[egresos] respuesta documento:', dd);
          this.docDetail.set(dd); this.docDetailLoading.set(false);
        },
        error: (err) => {
          console.error('[egresos] ERROR documento:', err?.status, err?.message, err);
          this.docDetailLoading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: `No se pudo cargar el documento (${err?.status || '?'})` });
        },
      });
  }

  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  pct(part: number, total: number): number { return total ? +((part / total) * 100).toFixed(1) : 0; }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const head = ['concepto', 'movs', 'importe', 'share_pct', ...(this.compare() ? ['delta_pct'] : [])];
    const lines = [head.join(',')];
    for (const row of r.rows) {
      const label = (row.label || '').replace(/"/g, '""');
      const base = [`"${label}"`, row.movs, row.total, row.share_pct];
      if (this.compare()) base.push(row.delta_pct ?? '');
      lines.push(base.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `egresos_${r.group_by}_${r.from}_${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
