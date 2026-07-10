import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
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
import { MessageService, TreeNode } from 'primeng/api';
import {
  ComercialService,
  ExpensesReport,
  ExpensesTree,
  ExpenseTreeNode,
  ExpenseRow,
  ExpensesParams,
  ExpenseGroupBy,
  ApProvider,
  ExpenseFinding,
  ExpenseFindingsReport,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_TABS } from '../../finanzas/finanzas-tabs';
import { ThemeService } from '../../../core/services/theme.service';
import { egresChartOptions } from './egresos-chart-opts';

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
    TableModule, TreeTableModule, ChartModule, ToastModule,
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

      <!-- Filtros — Sucursales es común a todas las vistas; el resto solo aplica a los
           reportes de egresos (árbol/tabla/tendencia). Proveedores/Hallazgos no los usan. -->
      <div class="ex-filters card-premium card-flat">
        <div class="ex-field"><label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code" placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queueFilter()" /></div>
        @if (isReportView()) {
          <div class="ex-field"><label>Mes</label>
            <p-select [options]="mesOpts" [(ngModel)]="mesSel" optionLabel="label" optionValue="value" [showClear]="true" placeholder="—" appendTo="body" (onChange)="pickMes($event.value)" styleClass="w-full" [filter]="true" /></div>
          <div class="ex-field"><label>Rango</label>
            <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="onRangeChange()" /></div>
          <div class="ex-field"><label>Tipo</label>
            <app-segmented [options]="familiaOpts" [value]="familia()" (valueChange)="setStr(familia, $event)" ariaLabel="Tipo de egreso" /></div>
          <div class="ex-field"><label>Tipo doc</label>
            <p-select [options]="docTipoOpts()" [(ngModel)]="docTipo" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="queueFilter()" styleClass="w-full" /></div>
          <div class="ex-field"><label>Solicitante</label>
            <p-select [options]="areaOpts()" [(ngModel)]="area" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="queueFilter()" styleClass="w-full" [filter]="true" /></div>
          <div class="ex-field"><label>Departamento</label>
            <p-select [options]="dptoOpts()" [(ngModel)]="dpto" optionLabel="label" optionValue="value" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="queueFilter()" styleClass="w-full" [filter]="true" /></div>
          <div class="ex-field"><label>Concepto</label>
            <p-select [options]="conceptoOpts()" [(ngModel)]="concepto" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="queueFilter()" styleClass="w-full" [filter]="true" /></div>
          <div class="ex-field"><label>Beneficiario</label>
            <input pInputText [(ngModel)]="beneficiario" placeholder="Buscar…" (keyup.enter)="applyFilters()" (blur)="queueFilter()" /></div>
          <div class="ex-field ex-narrow"><label>Monto ≥</label>
            <p-inputNumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="queueFilter()" /></div>
          <div class="ex-field ex-toggle"><label>Comparar</label>
            <p-toggleSwitch [(ngModel)]="compare" (ngModelChange)="queueFilter()" /></div>
        }
      </div>

      <!-- KPIs (solo del reporte de egresos — no aplican a Proveedores/Hallazgos) -->
      @if (isReportView() && report(); as r) {
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
              <tr [ttRow]="rowNode" [class.ex-clickable]="rowData.level === 'cuenta'"
                  [attr.tabindex]="rowData.level === 'cuenta' ? 0 : null"
                  [attr.role]="rowData.level === 'cuenta' ? 'button' : null"
                  (click)="rowData.level === 'cuenta' && openCuenta(rowData.key, rowData.label)"
                  (keydown.enter)="rowData.level === 'cuenta' && openCuenta(rowData.key, rowData.label)">
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
              <tr class="ex-clickable" tabindex="0" role="button" [attr.aria-label]="'Ver detalle de ' + row.label"
                  (click)="drillRow(row)" (keydown.enter)="drillRow(row)" (keydown.space)="$event.preventDefault(); drillRow(row)">
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
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts()" height="360px"></p-chart>
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

    </div>
  `,
  styles: [`
    :host { display: block; }
    .ex-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .ex-field { display: flex; flex-direction: column; gap: .35rem; }
    .ex-field label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-narrow { max-width: 10rem; }
    /* El p-inputNumber no encoge solo → se desbordaba sobre "Comparar". Lo fijo al ancho del campo. */
    :host ::ng-deep .ex-narrow .p-inputnumber { width: 100%; }
    :host ::ng-deep .ex-narrow .p-inputnumber input { width: 100%; min-width: 0; }
    /* "Comparar": label arriba + toggle abajo, alineado como el resto (no centrado). */
    .ex-toggle { align-items: flex-start; justify-content: flex-end; min-width: 6rem; }
    .ex-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ex-kpi { border: 1px solid var(--border, #e7e5e4); border-radius: var(--r-md); padding: .85rem 1rem; background: var(--card-bg, #fff); }
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
    .ex-clickable:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
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
    .ex-findcard { text-align: left; border: 1px solid var(--border, #e7e5e4); border-radius: var(--r-md); padding: .85rem 1rem; background: var(--card-bg, #fff); cursor: pointer; transition: border-color .15s, box-shadow .15s; }
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
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly theme = inject(ThemeService);

  readonly reportTabs = FINANZAS_TABS;
  readonly familiaOpts = [{ label: 'Todo', value: '' }, { label: 'Compras', value: '5' }, { label: 'Gastos', value: '6' }];
  readonly viewOpts = [
    { label: 'Árbol', value: 'arbol' }, { label: 'Tabla', value: 'tabla' }, { label: 'Tendencia', value: 'tendencia' },
    { label: 'Proveedores', value: 'proveedores' }, { label: 'Hallazgos', value: 'hallazgos' },
  ];
  readonly findingLabels: Record<string, { label: string; sev: string; hint: string }> = {
    iva_bug: { label: 'IVA acreditable huérfano', sev: 'bad', hint: 'XD5501 con abono a 122-001 sin cargo espejo (descuadra el libro)' },
    prov_203: { label: 'Provisiones 203 sin descargar', sev: 'warn', hint: 'Nómina/IMSS/SAT provisionados a 203 que nunca se cargan' },
    anticipo_107: { label: 'Anticipos 107 sin aplicar', sev: 'warn', hint: 'Anticipos a proveedor (cargo 107) nunca cruzados contra factura' },
    solicitud_sin_aplicar: { label: 'Solicitudes sin aplicar', sev: 'warn', hint: 'Solicitudes de gasto (XA1501) vencidas que nunca se volvieron gasto (XA1001) — dinero pedido/aprobado no ejecutado' },
  };
  readonly groupByOpts = [
    { label: 'Cuenta', value: 'cuenta' }, { label: 'Cuenta mayor', value: 'cuenta_mayor' },
    { label: 'Beneficiario', value: 'beneficiario' }, { label: 'Sucursal', value: 'sucursal' },
    { label: 'Tipo de documento', value: 'doc_tipo' }, { label: 'Solicitante', value: 'area' },
    { label: 'Departamento', value: 'dpto' }, { label: 'Concepto', value: 'concepto' }, { label: 'Mes', value: 'mes' },
  ];

  readonly report = signal<ExpensesReport | null>(null);
  readonly tree = signal<ExpensesTree | null>(null);
  readonly providers = signal<ApProvider[]>([]);
  readonly findings = signal<ExpenseFindingsReport | null>(null);
  readonly findingTipo = signal<string>('');
  providerSearch = '';
  readonly loading = signal(false);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly docTipoOpts = signal<string[]>([]);
  readonly areaOpts = signal<string[]>([]);
  readonly dptoOpts = signal<{ label: string; value: string }[]>([]);
  readonly conceptoOpts = signal<string[]>([]);

  readonly view = signal<'arbol' | 'tabla' | 'tendencia' | 'proveedores' | 'hallazgos'>('arbol');
  readonly groupBy = signal<ExpenseGroupBy>('cuenta');
  readonly familia = signal<string>('');
  readonly compare = signal(false);
  sucursal: string[] = [];
  docTipo: string | null = null;
  area: string | null = null;
  dpto: string | null = null;
  concepto: string | null = null;
  beneficiario = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];
  mesSel: string | null = null;
  /** Últimos 18 meses (YYYY-MM) para el selector rápido de mes. */
  readonly mesOpts = (() => {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 18; i++) {
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const lbl = d.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
      out.push({ label: lbl.charAt(0).toUpperCase() + lbl.slice(1), value: val });
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  })();

  /** Árbol/Tabla/Tendencia = renders del reporte de egresos. Proveedores/Hallazgos = otros datasets. */
  readonly isReportView = computed(() => {
    const v = this.view();
    return v === 'arbol' || v === 'tabla' || v === 'tendencia';
  });
  readonly treeNodes = computed<TreeNode[]>(() => (this.tree()?.tree || []).map((n) => this.toNode(n, true)));
  readonly groupByLabel = computed(() => this.groupByOpts.find((o) => o.value === this.groupBy())?.label || 'Concepto');
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
  // Theme-aware (ver egresos-chart-opts): sin esto los ejes/leyenda son ilegibles en dark.
  readonly chartOpts = computed(() => egresChartOptions(this.theme.isMonochrome()));

  constructor() {
    this.svc.expensesSucursales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code }))));
    this.svc.expensesFilters().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((f) => {
        this.docTipoOpts.set(f.doc_tipos);
        this.areaOpts.set(f.areas);
        this.dptoOpts.set((f.dptos || []).map((d) => ({ label: d.nombre ? `${d.nombre} · ${d.code}` : d.code, value: d.code })));
        this.conceptoOpts.set(f.conceptos || []);
      });
    this.showView();
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
      dpto: this.dpto || undefined, concepto: this.concepto || undefined,
      beneficiario: this.beneficiario || undefined,
      min_importe: this.minImporte ?? undefined,
      ...extra,
    };
  }

  // Caché por frescura: cambiar de VISTA no re-consulta (usa lo cargado); cambiar
  // FILTROS invalida y recarga solo la vista activa (con debounce).
  private fresh = { report: false, tree: false, providers: false, findings: false };
  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  setStr(sig: { set: (v: string) => void }, v: string) { sig.set(v || ''); this.applyFilters(); }
  setView(v: string) { this.view.set(v as any); this.showView(); }
  // groupBy solo reagrupa las filas del reporte (tabla) → recarga solo el reporte.
  setGroupBy(v: string) { this.groupBy.set(v as ExpenseGroupBy); this.fresh.report = false; this.showView(); }

  /** Selector rápido de mes: acota el rango a ese mes (o lo limpia y deja el rango). */
  pickMes(v: string | null) {
    this.mesSel = v || null;
    if (v) {
      const [y, m] = v.split('-').map(Number);
      this.rangeDates = [new Date(y, m - 1, 1), new Date(y, m, 0)];
    }
    this.applyFilters();
  }
  /** Cambio manual del rango → limpia el selector de mes (evita estado incoherente). */
  onRangeChange() { this.mesSel = null; this.queueFilter(); }

  /** Cambio de filtro con debounce: agrupa varios cambios seguidos en una sola request. */
  queueFilter() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.applyFilters(), 300);
  }
  /** Aplica filtros ya: invalida la caché y recarga la vista activa. */
  applyFilters() {
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
    this.fresh = { report: false, tree: false, providers: false, findings: false };
    this.showView();
  }

  /** Carga SOLO lo que la vista activa necesita y que no esté ya fresco. */
  showView() {
    const v = this.view();
    if (v === 'proveedores') { if (!this.fresh.providers) this.loadProviders(); return; }
    if (v === 'hallazgos') { if (!this.fresh.findings) this.loadFindings(this.findingTipo()); return; }
    if (!this.fresh.report) this.loadReport();
    if (v === 'arbol' && !this.fresh.tree) this.loadTree();
  }

  private reportSub?: Subscription;
  private treeSub?: Subscription;

  private loadReport() {
    this.loading.set(true);
    this.reportSub?.unsubscribe(); // cancela la request anterior: sin esto una respuesta lenta vieja pisa a la nueva
    this.reportSub = this.svc.expenses(this.params({ group_by: this.groupBy(), compare: this.compare() }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.fresh.report = true; this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar egresos' }); },
      });
  }

  private loadTree() {
    this.treeSub?.unsubscribe();
    this.treeSub = this.svc.expensesTree(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (t) => { this.tree.set(t); this.fresh.tree = true; }, error: () => {} });
  }

  private providersSub?: Subscription;
  private findingsSub?: Subscription;

  loadProviders() {
    this.providersSub?.unsubscribe();
    this.providersSub = this.svc.apProviders({ search: this.providerSearch, sucursal: this.sucursal, limit: 200 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.providers.set(r); this.fresh.providers = true; }, error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar proveedores' }) });
  }

  loadFindings(tipo: string) {
    this.findingTipo.set(tipo);
    this.findingsSub?.unsubscribe();
    this.findingsSub = this.svc.expenseFindings({ tipo: tipo || undefined, sucursal: this.sucursal, limit: 1000 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.findings.set(r); this.fresh.findings = true; }, error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar hallazgos' }) });
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

  /** Click en fila del reporte → navega a la interfaz de detalle de esa entidad. */
  drillRow(row: ExpenseRow) {
    const gb = this.groupBy();
    if (gb === 'mes') return; // 'mes' no tiene superficie de detalle
    this.goToDetalle(gb, row.key, row.label);
  }

  openCuenta(cuenta: string, label: string) {
    this.goToDetalle('cuenta', cuenta, label);
  }

  private goToDetalle(type: ExpenseGroupBy, key: string, label: string) {
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    this.router.navigate(['/finanzas/egresos/detalle'], {
      queryParams: { type, key, label, from: fmt(a), to: fmt(b), suc: this.sucursal.join(',') || null },
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
