import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { Subject, debounceTime } from 'rxjs';
import { MetricStripComponent, MetricStripItem, MetricTone } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ComprasService, AdjustmentsSummary, AdjustmentRow, AdjustmentsSupplierRow, DuplicateGroup, DiscountReconRow, DiscountReconResponse, DiscountLeakageRow, DiscountLeakageResponse } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
type ViewMode = 'ajustes' | 'duplicados' | 'reconciliacion' | 'fuga';

/**
 * RE.10 — Descuentos y apoyos de compra + posibles facturas duplicadas. Hace VISIBLE
 * lo que el Excel de recepción no veía: los ajustes de compra de Kepler (X-D-40
 * "Devolución" / X-D-55 "Nota crédito") clasificados por su motivo (`c24`) — descuentos,
 * pronto pago, apoyo de marca — y un detector proactivo de facturas duplicadas (mismo
 * proveedor + monto exacto repetido en pocos días). Superficie Operations (PrimeNG denso).
 */
@Component({
  selector: 'app-compras-descuentos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ToastModule, SelectModule, TagModule, InputTextModule, SkeletonModule, ButtonModule, MetricStripComponent, ContextHelpComponent, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in dx-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 style="display:inline-flex;align-items:center;gap:.4rem">Descuentos y apoyos <app-context-help topic="compras-descuentos" /></h1>
          <p class="surf-page-sub">Notas de crédito y devoluciones de compra de Kepler (X-D-40 / X-D-55) clasificadas por su motivo: descuentos, apoyos de marca y pronto pago — más un detector de facturas duplicadas.</p>
        </div>
        <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vistas de descuentos y apoyos" />
      </header>

      @if (err(); as e) {
        <div class="dx-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="dx-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
        </div>
      }

      <div id="dx-panel" role="tabpanel">

      @if (view() === 'ajustes') {
        <app-metric-strip [items]="ajustesMetrics()" ariaLabel="Resumen de ajustes por grupo" />

        <div class="dx-filters">
          <p-select [options]="grupoOpts" [(ngModel)]="fGrupo" (onChange)="onFilter()" optionLabel="label" optionValue="value" placeholder="Todos los grupos" [showClear]="true" styleClass="dx-sel" ariaLabel="Filtrar por grupo" appendTo="body"></p-select>
          <p-select [options]="doctypeOpts" [(ngModel)]="fDoctype" (onChange)="onFilter()" optionLabel="label" optionValue="value" placeholder="Ambos documentos" [showClear]="true" styleClass="dx-sel" ariaLabel="Filtrar por tipo de documento" appendTo="body"></p-select>
          <input pInputText type="text" [(ngModel)]="fSearch" (ngModelChange)="search$.next($event)" placeholder="Proveedor o motivo…" class="dx-search" aria-label="Buscar por proveedor o motivo" />
          <span class="dx-count">{{ total() | number }} ajuste(s)</span>
        </div>

        @if (loading()) {
          <div class="dx-skel">
            @for (i of skelRows; track i) { <p-skeleton height="1.9rem" styleClass="dx-skel-row" /> }
          </div>
        } @else {
        <div class="dx-grid">
          <p-table [value]="rows()" [loading]="false" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm dx-table">
            <ng-template #header>
              <tr>
                <th class="dx-w-date">Fecha</th><th class="dx-w-doc">Doc</th><th>Proveedor</th>
                <th class="dx-w-cat">Categoría</th><th>Motivo</th><th class="dx-r dx-w-amt">Monto</th>
              </tr>
            </ng-template>
            <ng-template #body let-a>
              <tr>
                <td class="dx-muted">{{ a.adjustment_date ? (a.adjustment_date | date:'dd/MM/yy') : '—' }}</td>
                <td><span class="dx-doc">{{ a.doctype === 'XD40' ? 'Devolución' : 'Nota créd.' }}</span></td>
                <td class="dx-prov">{{ a.proveedor_nombre || a.proveedor_code || '—' }}</td>
                <td><p-tag [value]="catLabel(a.categoria)" [severity]="grupoTag(a.grupo)"></p-tag></td>
                <td class="dx-motivo" [title]="a.motivo || ''">{{ a.motivo || '—' }}</td>
                <td class="dx-r dx-strong">{{ money(a.monto) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr>
                <td colspan="6">
                  <div class="dx-empty-op">
                    <i class="pi pi-inbox" aria-hidden="true"></i>
                    <span class="dx-empty-op-title">Sin ajustes de compra</span>
                    @if (hasFilters()) {
                      <span class="dx-empty-op-sub">Ningún descuento, apoyo o devolución coincide con los filtros actuales.</span>
                      <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
                    } @else {
                      <span class="dx-empty-op-sub">No hay notas de crédito ni devoluciones de compra (X-D-40 / X-D-55) cargadas en el periodo.</span>
                    }
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>

          <aside class="dx-side">
            <h2 class="dx-side-title">Top proveedores</h2>
            @for (s of suppliers(); track s.proveedor_code) {
              <div class="dx-supplier">
                <span class="dx-supplier-name" [title]="s.proveedor_nombre || ''">{{ s.proveedor_nombre || s.proveedor_code || '—' }}</span>
                <span class="dx-supplier-val">{{ money(s.monto) }}</span>
              </div>
            }
            @if (!suppliers().length) { <p class="dx-empty">—</p> }
          </aside>
        </div>
        }
      } @else if (view() === 'duplicados') {
        <div class="dx-dup-banner">
          <span class="dx-dup-risk">{{ money(dupRisk()) }}</span>
          <span class="dx-dup-txt">en riesgo · <strong>{{ dupGroups() | number }}</strong> proveedores facturaron el <strong>mismo monto exacto ≥2 veces</strong> dentro de {{ dupWindow() }} días. Revisar: posible captura doble del comprobante.</span>
        </div>
        @if (dupsLoading()) {
          <div class="dx-skel">@for (i of skelRows; track i) { <p-skeleton height="1.9rem" styleClass="dx-skel-row" /> }</div>
        } @else {
        <p-table [value]="dups()" [loading]="false" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm dx-table">
          <ng-template #header>
            <tr>
              <th>Proveedor</th><th class="dx-r dx-w-amt">Monto</th><th class="dx-r dx-w-x">Veces</th>
              <th class="dx-w-per">Periodo</th><th>Folios</th><th class="dx-r dx-w-amt">$ en riesgo</th>
            </tr>
          </ng-template>
          <ng-template #body let-d>
            <tr class="dx-clickable" role="button" tabindex="0"
                [attr.aria-label]="'Ver ajustes de ' + (d.proveedor_nombre || d.proveedor_code || '')"
                (click)="drillTo('ajustes', d.proveedor_nombre || d.proveedor_code)"
                (keydown.enter)="drillTo('ajustes', d.proveedor_nombre || d.proveedor_code)"
                (keydown.space)="$event.preventDefault(); drillTo('ajustes', d.proveedor_nombre || d.proveedor_code)">
              <td class="dx-prov">{{ d.proveedor_nombre || d.proveedor_code || '—' }} <span class="dx-drillhint" aria-hidden="true">→ ajustes</span></td>
              <td class="dx-r">{{ money(d.monto) }}</td>
              <td class="dx-r dx-strong">×{{ d.veces }}</td>
              <td class="dx-muted">{{ d.desde | date:'dd/MM/yy' }}@if (d.span_dias > 0) {<span> – {{ d.hasta | date:'dd/MM/yy' }} ({{ d.span_dias }}d)</span>}</td>
              <td class="dx-mono">{{ (d.folios || []).join(', ') }}</td>
              <td class="dx-r dx-strong dx-bad">{{ money(d.monto_riesgo) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="6" class="dx-empty">Sin duplicados potenciales en la ventana.</td></tr>
          </ng-template>
        </p-table>
        }
      } @else if (view() === 'reconciliacion') {
        <app-metric-strip [items]="reconMetrics()" ariaLabel="Resumen de reconciliación de descuentos" />
        <div class="dx-filters">
          <input pInputText type="text" [(ngModel)]="fSearch" (ngModelChange)="search$.next($event)" placeholder="Proveedor…" class="dx-search" aria-label="Buscar por proveedor" />
          <span class="dx-count">{{ (recon()?.rows?.length || 0) | number }} proveedor(es)</span>
        </div>
        @if (reconLoading()) {
          <div class="dx-skel">@for (i of skelRows; track i) { <p-skeleton height="1.9rem" styleClass="dx-skel-row" /> }</div>
        } @else {
        <p-table [value]="recon()?.rows || []" [loading]="false" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm dx-table">
          <ng-template #header>
            <tr>
              <th>Proveedor</th><th class="dx-w-canal">Canal</th><th class="dx-r dx-w-amt">Pago (c84)</th>
              <th class="dx-r dx-w-amt">Nota</th><th class="dx-r dx-w-amt">Total</th><th class="dx-r dx-w-pct">% compras</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="dx-clickable" role="button" tabindex="0"
                [attr.aria-label]="'Ver ajustes de ' + (r.proveedor_nombre || r.proveedor_code || '')"
                (click)="drillTo('ajustes', r.proveedor_nombre || r.proveedor_code)"
                (keydown.enter)="drillTo('ajustes', r.proveedor_nombre || r.proveedor_code)"
                (keydown.space)="$event.preventDefault(); drillTo('ajustes', r.proveedor_nombre || r.proveedor_code)">
              <td class="dx-prov">{{ r.proveedor_nombre || r.proveedor_code || '—' }} <span class="dx-drillhint" aria-hidden="true">→ ajustes</span></td>
              <td><p-tag [value]="canalLabel(r.canal)" [severity]="canalTag(r.canal)"></p-tag></td>
              <td class="dx-r">{{ r.desc_pago ? money(r.desc_pago) : '—' }}</td>
              <td class="dx-r">{{ r.desc_nota ? money(r.desc_nota) : '—' }}</td>
              <td class="dx-r dx-strong">{{ money(r.total_desc) }}</td>
              <td class="dx-r dx-muted">{{ r.pct_vs_compras != null ? (r.pct_vs_compras * 100 | number:'1.1-1') + '%' : '—' }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="6" class="dx-empty">Sin descuento de proveedor con estos filtros.</td></tr></ng-template>
        </p-table>
        }
      } @else {
        <div class="dx-dup-banner">
          <span class="dx-dup-risk">{{ money(leak()?.summary?.total_lost || 0) }}</span>
          <span class="dx-dup-txt">de <strong>pronto pago dejado en la mesa</strong> · <strong>{{ leak()?.summary?.suppliers || 0 }}</strong> proveedores que dan descuento tienen pagos liquidados <strong>sin descuento</strong> (c84=0). Oportunidad = tasa habitual × monto pagado completo.</span>
        </div>
        <div class="dx-filters">
          <input pInputText type="text" [(ngModel)]="fSearch" (ngModelChange)="search$.next($event)" placeholder="Proveedor…" class="dx-search" aria-label="Buscar por proveedor" />
          <span class="dx-count">{{ (leak()?.rows?.length || 0) | number }} proveedor(es)</span>
        </div>
        @if (leakLoading()) {
          <div class="dx-skel">@for (i of skelRows; track i) { <p-skeleton height="1.9rem" styleClass="dx-skel-row" /> }</div>
        } @else {
        <p-table [value]="leak()?.rows || []" [loading]="false" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm dx-table">
          <ng-template #header>
            <tr>
              <th>Proveedor</th><th class="dx-r dx-w-pct">Tasa</th><th class="dx-r dx-w-x">Sin desc.</th>
              <th class="dx-r dx-w-amt">Monto sin desc.</th><th class="dx-r dx-w-amt">$ perdido</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="dx-clickable" role="button" tabindex="0"
                [attr.aria-label]="'Ver reconciliación de ' + (r.proveedor_nombre || r.proveedor_code || '')"
                (click)="drillTo('reconciliacion', r.proveedor_nombre || r.proveedor_code)"
                (keydown.enter)="drillTo('reconciliacion', r.proveedor_nombre || r.proveedor_code)"
                (keydown.space)="$event.preventDefault(); drillTo('reconciliacion', r.proveedor_nombre || r.proveedor_code)">
              <td class="dx-prov">{{ r.proveedor_nombre || r.proveedor_code || '—' }} <span class="dx-drillhint" aria-hidden="true">→ reconciliación</span></td>
              <td class="dx-r dx-muted">{{ r.rate * 100 | number:'1.2-2' }}%</td>
              <td class="dx-r"><span class="dx-strong">{{ r.n_uncaptured }}</span><span class="dx-muted">/{{ r.n_total }}</span></td>
              <td class="dx-r">{{ money(r.monto_uncaptured) }}</td>
              <td class="dx-r dx-strong dx-bad">{{ money(r.lost) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="5" class="dx-empty">Sin fuga de descuento (o sin política de proveedor cargada).</td></tr></ng-template>
        </p-table>
        }
      }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .surf-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .dx-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .dx-sel { min-width: 12rem; }
    .dx-search { min-width: 14rem; }
    .dx-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .dx-grid { display: grid; grid-template-columns: 1fr 15rem; gap: .9rem; align-items: start; }
    @media (max-width: 900px) { .dx-grid { grid-template-columns: 1fr; } }
    .dx-table { font-size: .82rem; }
    .dx-r { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .dx-w-date { width: 5.5rem; } .dx-w-doc { width: 6rem; } .dx-w-cat { width: 9rem; } .dx-w-amt { width: 7rem; } .dx-w-x { width: 4rem; } .dx-w-per { width: 11rem; } .dx-w-canal { width: 6rem; } .dx-w-pct { width: 6rem; }
    .dx-muted { color: var(--text-muted); }
    .dx-strong { font-weight: 700; }
    .dx-bad { color: var(--bad-fg); }
    .dx-doc { font-size: .74rem; color: var(--text-muted); }
    .dx-prov { max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dx-motivo { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .dx-mono { font-family: var(--font-mono); font-size: .76rem; color: var(--text-muted); }
    .dx-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .dx-side { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: .7rem .85rem; background: var(--card-bg); }
    .dx-side-title { font-size: .82rem; font-weight: 700; margin: 0 0 .5rem; }
    .dx-supplier { display: flex; justify-content: space-between; gap: .5rem; padding: .28rem 0; border-bottom: 1px solid var(--border-color); font-size: .8rem; }
    .dx-supplier:last-child { border-bottom: 0; }
    .dx-supplier-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dx-supplier-val { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
    .dx-dup-banner { display: flex; align-items: baseline; gap: .5rem; padding: .6rem .85rem; margin-bottom: .75rem; border: 1px solid var(--border-color); border-left: 3px solid var(--bad-fg); border-radius: var(--r-md); background: var(--card-bg); }
    .dx-dup-risk { font-family: var(--font-mono); font-size: 1.15rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--bad-fg); }
    .dx-dup-txt { font-size: .84rem; color: var(--text-muted); }
    /* estado de error por vista (banner + reintento) — Empty ≠ error de red */
    .dx-errbox { display: flex; align-items: center; gap: .6rem; padding: .7rem .85rem; margin-bottom: .75rem; border: 1px solid var(--bad-border, var(--border-color)); border-left: 3px solid var(--bad-fg); border-radius: var(--r-md); background: var(--card-bg); }
    .dx-errbox .pi { color: var(--bad-fg); }
    .dx-errbox-txt { flex: 1; font-size: .84rem; color: var(--text-main); }
    /* empty state operacional: icono + título + descripción + CTA */
    .dx-empty-op { display: flex; flex-direction: column; align-items: center; gap: .4rem; padding: 2.2rem 1rem; text-align: center; }
    .dx-empty-op .pi { font-size: 1.6rem; color: var(--text-faint); }
    .dx-empty-op-title { font-weight: 600; color: var(--text-main); }
    .dx-empty-op-sub { font-size: .84rem; color: var(--text-muted); max-width: 32rem; }
    app-metric-strip { display: block; margin-bottom: .9rem; }
    .dx-skel { display: flex; flex-direction: column; gap: .45rem; padding: .3rem 0; }
    /* filas navegables a su arreglo (Q.4): clic → tab + filtro por proveedor */
    tr.dx-clickable { cursor: pointer; }
    tr.dx-clickable:hover td { background: var(--hover-bg); }
    tr.dx-clickable:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .dx-drillhint { font-size: .72rem; color: var(--text-faint); margin-left: .35rem; }
  `],
})
export class ComprasDescuentosComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  view = signal<ViewMode>('ajustes');
  /** Error de red de la vista activa (banner + reintento). Empty ≠ error. */
  err = signal<string | null>(null);

  summary = signal<AdjustmentsSummary | null>(null);
  rows = signal<AdjustmentRow[]>([]);
  suppliers = signal<AdjustmentsSupplierRow[]>([]);
  total = signal(0);
  loading = signal(false);

  dups = signal<DuplicateGroup[]>([]);
  dupsLoading = signal(false);
  dupRisk = signal(0);
  dupGroups = signal(0);
  dupWindow = signal(30);
  private dupsLoaded = false;

  recon = signal<DiscountReconResponse | null>(null);
  reconLoading = signal(false);
  private reconLoaded = false;

  leak = signal<DiscountLeakageResponse | null>(null);
  leakLoading = signal(false);
  private leakLoaded = false;

  fGrupo = '';
  fDoctype = '';
  fSearch = '';
  search$ = new Subject<string>();

  grupoOpts = [
    { label: 'Descuentos y apoyos', value: 'comercial' },
    { label: 'Faltantes / devoluciones', value: 'operacional' },
    { label: 'Errores de captura', value: 'error' },
    { label: 'Sin clasificar', value: 'sin_clasificar' },
  ];
  doctypeOpts = [
    { label: 'Nota de crédito', value: 'XD55' },
    { label: 'Devolución de compra', value: 'XD40' },
  ];

  private readonly CAT_LABEL: Record<string, string> = {
    faltante: 'Faltante', no_solicitado: 'No solicitado', mal_estado: 'Mal estado', cambiada: 'Cambios/reposición',
    devolucion_otra: 'Devolución', factura_duplicada: 'Factura duplicada', diferencia_monto: 'Diferencia de monto',
    pronto_pago: 'Pronto pago', apoyo_marca: 'Apoyo de marca', descuento_comercial: 'Descuento comercial',
    saldo_favor: 'Saldo a favor', otro: 'Otro',
  };
  private readonly GRUPO_LABEL: Record<string, string> = {
    comercial: 'Descuentos y apoyos', operacional: 'Faltantes / devoluciones', error: 'Errores de captura', sin_clasificar: 'Sin clasificar',
  };
  private readonly GRUPO_TONE: Record<string, MetricTone> = {
    comercial: 'brand', error: 'bad', operacional: 'warn', sin_clasificar: 'default',
  };

  /** Filas skeleton mientras carga el grid de ajustes. */
  readonly skelRows = Array.from({ length: 8 });

  /** KPIs de Ajustes → MetricStrip (sin cajas, Geist mono, count-up). ADR-033. */
  readonly ajustesMetrics = computed<MetricStripItem[]>(() => {
    const s = this.summary();
    const items: MetricStripItem[] = (s?.by_grupo || []).map((g) => ({
      label: this.grupoLabel(g.key), value: g.monto, format: 'currency-short',
      tone: this.GRUPO_TONE[g.key] || 'default', sub: `${(g.n || 0).toLocaleString('es-MX')} nota(s)`,
    }));
    items.push({
      label: 'Total', value: s?.total?.monto || 0, format: 'currency-short',
      tone: 'default', sub: `${(s?.total?.n || 0).toLocaleString('es-MX')} nota(s)`,
    });
    return items;
  });

  /** KPIs de Reconciliación → MetricStrip. Variedad por tono (total=marca, ambos=alerta). */
  readonly reconMetrics = computed<MetricStripItem[]>(() => {
    const r = this.recon()?.summary;
    return [
      { label: 'Canal pago (c84)', value: r?.total_desc_pago || 0, format: 'currency-short', sub: 'pronto pago al pagar' },
      { label: 'Canal nota (X-D-55)', value: r?.total_desc_nota || 0, format: 'currency-short', sub: 'nota de crédito' },
      { label: 'Descuento total', value: r?.total_desc || 0, format: 'currency-short', tone: 'brand', sub: `${r?.suppliers || 0} proveedores` },
      { label: 'Usan ambos canales', value: r?.suppliers_ambos || 0, format: 'number', tone: 'warn', sub: 'posible solapamiento' },
    ];
  });

  private readonly VIEWS: ViewMode[] = ['ajustes', 'duplicados', 'reconciliacion', 'fuga'];

  ngOnInit(): void {
    // Estado en URL: rehidratar vista + filtros de los query params (F5 y deep-link).
    const q = this.route.snapshot.queryParamMap;
    const v = q.get('view') as ViewMode | null;
    if (v && this.VIEWS.includes(v)) this.view.set(v);
    this.fGrupo = q.get('grupo') || '';
    this.fDoctype = q.get('doctype') || '';
    this.fSearch = q.get('q') || '';

    this.search$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.syncUrl(); this.onSearch(); });
    this.loadSummary();
    this.loadView(this.view());
  }

  /** Opciones del selector iOS (app-segmented) para las 4 vistas. */
  readonly viewOpts: SegOption[] = [
    { label: 'Ajustes', value: 'ajustes' },
    { label: 'Posibles duplicados', value: 'duplicados' },
    { label: 'Reconciliación', value: 'reconciliacion' },
    { label: 'Descuento no capturado', value: 'fuga' },
  ];

  setView(v: string): void {
    const view = v as ViewMode;
    this.view.set(view);
    this.err.set(null);
    this.syncUrl();
    this.loadView(view);
  }

  /** Carga (o recarga) la vista activa. Lazy: solo la primera vez, salvo reintento. */
  private loadView(v: ViewMode, force = false): void {
    if (v === 'ajustes') this.reload();
    else if (v === 'duplicados' && (force || !this.dupsLoaded)) this.loadDuplicates();
    else if (v === 'reconciliacion' && (force || !this.reconLoaded)) this.loadRecon();
    else if (v === 'fuga' && (force || !this.leakLoaded)) this.loadLeakage();
  }

  /** Reintento del banner de error: recarga la vista activa. */
  retry(): void {
    this.err.set(null);
    this.loadView(this.view(), true);
  }

  /** Refleja vista + filtros en la URL (replaceUrl → no ensucia el historial). */
  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        view: this.view() === 'ajustes' ? null : this.view(),
        grupo: this.fGrupo || null,
        doctype: this.fDoctype || null,
        q: this.fSearch.trim() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** El buscador recarga la vista activa (ajustes / reconciliación / fuga). */
  private onSearch(): void {
    const v = this.view();
    if (v === 'reconciliacion') this.loadRecon();
    else if (v === 'fuga') this.loadLeakage();
    else this.reload();
  }

  loadRecon(): void {
    this.reconLoading.set(true); this.err.set(null);
    this.api.adjustmentsDiscountReconciliation({ search: this.fSearch.trim() || undefined }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.recon.set(r); this.reconLoading.set(false); this.reconLoaded = true; },
      error: () => { this.reconLoading.set(false); this.err.set('No se pudo cargar la reconciliación.'); },
    });
  }

  loadLeakage(): void {
    this.leakLoading.set(true); this.err.set(null);
    this.api.adjustmentsDiscountLeakage(this.fSearch.trim() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.leak.set(r); this.leakLoading.set(false); this.leakLoaded = true; },
      error: () => { this.leakLoading.set(false); this.err.set('No se pudo cargar el descuento no capturado.'); },
    });
  }

  private query() {
    return { grupo: this.fGrupo || undefined, doctype: this.fDoctype || undefined, search: this.fSearch.trim() || undefined };
  }

  loadSummary(): void {
    this.api.adjustmentsSummary(this.query()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.summary.set(s),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el resumen.' }),
    });
    this.api.adjustmentsBySupplier(this.query()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.suppliers.set(r.slice(0, 12)),
      error: () => {},
    });
  }

  /** Cambio de filtro (grupo/doctype): refleja en URL y recarga la vista de ajustes. */
  onFilter(): void { this.syncUrl(); this.reload(); }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    this.api.adjustments({ ...this.query(), pageSize: 200 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); this.loadSummary(); },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los ajustes.'); },
    });
  }

  loadDuplicates(): void {
    this.dupsLoading.set(true); this.err.set(null);
    this.api.adjustmentsDuplicates(30).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.dups.set(r.rows); this.dupRisk.set(r.total_riesgo); this.dupGroups.set(r.groups); this.dupWindow.set(r.window_days); this.dupsLoading.set(false); this.dupsLoaded = true; },
      error: () => { this.dupsLoading.set(false); this.err.set('No se pudieron cargar los duplicados.'); },
    });
  }

  hasFilters(): boolean { return !!(this.fGrupo || this.fDoctype || this.fSearch.trim()); }

  /** Q.4 — navega a la vista destino filtrando por el proveedor (su lugar de arreglo). */
  drillTo(v: ViewMode, proveedor: string | null | undefined): void {
    this.fSearch = proveedor || '';
    this.fGrupo = ''; this.fDoctype = '';
    this.view.set(v);
    this.err.set(null);
    this.syncUrl();
    this.loadView(v, true);
  }

  /** Limpia filtros (CTA del empty state) y recarga. */
  clearFilters(): void {
    this.fGrupo = ''; this.fDoctype = ''; this.fSearch = '';
    this.syncUrl(); this.reload();
  }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  grupoLabel(k: string) { return this.GRUPO_LABEL[k] || k; }
  catLabel(c: string | null) { return c ? (this.CAT_LABEL[c] || c) : 'Sin motivo'; }
  grupoTag(g: string): Sev { return ({ comercial: 'success', error: 'danger', operacional: 'warn', sin_clasificar: 'secondary' } as Record<string, Sev>)[g] || 'secondary'; }
  canalLabel(c: string) { return ({ pago: 'Pago', nota: 'Nota', ambos: 'Ambos' } as Record<string, string>)[c] || c; }
  canalTag(c: string): Sev { return ({ pago: 'info', nota: 'warn', ambos: 'danger' } as Record<string, Sev>)[c] || 'secondary'; }
}
