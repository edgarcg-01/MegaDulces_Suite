import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageService } from 'primeng/api';
import { ComprasService, WorklistRow, ReplenishmentFilters, CriticalStockRow, CreateRequisitionDto, OrderBasis, SupplierOrderHistory } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
type WLRow = WorklistRow & { _key: string };
type DetailLine = CriticalStockRow & { final: number; uxc: number };
interface DetailState {
  loading: boolean;
  basis: OrderBasis;
  lines: DetailLine[];
  hub: Record<string, number> | null; // product_id → existencia en el hub (solo traspaso)
  hist: SupplierOrderHistory | null;   // histórico de compras al proveedor
  creating: boolean;
}

/**
 * RA-PRO.8/9/10 — Cockpit "Pedido" (antes "Qué toca"). Master (almacén × proveedor: cuándo,
 * canal, cadencia) con drill-down que CONCENTRA la compra: selector de base (cadencia/reorden/
 * máximo), cajas + $ por línea, mínimo del proveedor, aviso de traspaso NO surtible (hub sin
 * stock) e histórico de compras. Crea la requisición/traspaso. Superficie Operations (PrimeNG
 * denso, tokens, monocromático quiet-luxury: solo se colorean los problemas).
 */
@Component({
  selector: 'app-compras-que-toca',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, MultiSelectModule, TagModule, TooltipModule, InputTextModule, InputNumberModule, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in qt-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pedido</h1>
          <p class="surf-page-sub">Ciclos de reabasto por proveedor y sucursal. Abre un renglón para armar la compra: elige la base, revisa cajas y costo, y crea la requisición (compra) o traspaso según el canal.</p>
        </div>
        @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
      </header>

      <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de ciclos de reabasto" />

      <div class="qt-filters">
        <div class="qt-terr">
          <span class="qt-terr-lbl">Territorio:</span>
          @for (t of territories; track t.label) {
            <button pButton type="button" [label]="t.label"
                    class="p-button-sm" [ngClass]="isTerr(t.codes) ? 'p-button-outlined' : 'p-button-text'"
                    (click)="applyTerr(t.codes)"></button>
          }
        </div>
        <p-multiSelect [options]="warehouses()" [(ngModel)]="fWh" (onChange)="reload()"
                       optionLabel="label" optionValue="id" placeholder="Almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="qt-sel"></p-multiSelect>
        <p-select [options]="viaOpts" [(ngModel)]="fVia" (onChange)="reload()" optionLabel="label" optionValue="value"
                  placeholder="Canal" [showClear]="true" styleClass="qt-sel-sm"></p-select>
        <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="reload()" optionLabel="label" optionValue="value" styleClass="qt-sel-sm"></p-select>
        <p-select [options]="supplierOpts()" [(ngModel)]="fSearch" (onChange)="reload()" (onClear)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                  [filter]="true" filterBy="label" filterPlaceholder="Buscar proveedor…" [resetFilterOnHide]="true"
                  [virtualScroll]="true" [virtualScrollItemSize]="34" styleClass="qt-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
        <span class="qt-count">{{ total() | number }} par(es) activo(s)</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               dataKey="_key" (onRowExpand)="onExpand($event.data)" styleClass="p-datatable-sm qt-table">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:2.5rem"></th>
            <th>Estado</th><th>Próximo</th><th>Proveedor</th><th>Almacén</th><th>Canal</th>
            <th class="qt-r">Cadencia</th><th>Última</th><th class="qt-r">SKUs</th>
            <th class="qt-r">Sugerido</th><th class="qt-r">Costo est.</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r let-expanded="expanded">
          <tr>
            <td>
              <button type="button" pButton [pRowToggler]="r" [text]="true" [rounded]="true"
                      class="p-button-sm" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"></button>
            </td>
            <td><p-tag [value]="estLabel(r)" [severity]="estSev(r)"></p-tag></td>
            <td class="qt-nowrap" [class.qt-bad]="(r.days_to_due ?? 0) < 0">
              {{ r.next_due_date | date:'dd/MM/yy' }}
              <span class="qt-dd">{{ ddLabel(r.days_to_due) }}</span>
            </td>
            <td>{{ r.supplier_name || '—' }}</td>
            <td class="qt-muted" [title]="r.warehouse_code">{{ r.warehouse_name || r.warehouse_code }}</td>
            <td>
              @if (r.via === 'transfer') {
                <span class="qt-via qt-via-t" [pTooltip]="'Traspaso desde ' + (r.source_warehouse_code||'?')">
                  <i class="pi pi-arrow-right-arrow-left"></i> Traspaso <span class="qt-muted">← {{ r.source_warehouse_code || '?' }}</span>
                </span>
              } @else {
                <span class="qt-via qt-via-c"><i class="pi pi-shopping-cart"></i> Compra</span>
              }
            </td>
            <td class="qt-r">
              <span class="qt-cad">{{ r.cadence_days != null ? (r.cadence_days | number:'1.0-1') + 'd' : '—' }}</span>
              @if (r.health_band) { <p-tag [value]="bandLabel(r.health_band)" [severity]="bandSev(r.health_band)" styleClass="qt-band"></p-tag> }
            </td>
            <td class="qt-muted qt-nowrap">{{ r.last_delivery_date | date:'dd/MM/yy' }}</td>
            <td class="qt-r"><span [class.qt-strong]="r.n_below>0">{{ r.n_below | number }}</span><span class="qt-muted">/{{ r.n_skus | number }}</span></td>
            <td class="qt-r">{{ r.suggested_qty | number:'1.0-0' }}</td>
            <td class="qt-r qt-strong">{{ money(r.suggested_cost) }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="rowexpansion" let-r>
          <tr class="qt-detrow">
            <td colspan="11">
              @if (detail()[r._key]; as st) {
                @if (st.loading && !st.lines.length) {
                  <div class="qt-det-msg">Cargando pedido…</div>
                } @else {
                <div class="qt-det">
                  <!-- Barra: base del pedido + histórico del proveedor -->
                  <div class="qt-det-bar">
                    <div class="qt-basis">
                      <span class="qt-basis-lbl">Base:</span>
                      @for (b of basisOpts; track b.value) {
                        <button pButton type="button" [label]="b.label"
                                class="p-button-sm" [ngClass]="st.basis===b.value ? 'p-button-outlined' : 'p-button-text'"
                                [pTooltip]="b.tip" (click)="setBasis(r, b.value)"></button>
                      }
                    </div>
                    @if (st.hist; as h) {
                      <div class="qt-hist" [pTooltip]="histTip(h)" tooltipPosition="left">
                        <i class="pi pi-history"></i>
                        @if (h.last) {
                          Última compra {{ h.last.date | date:'dd/MM/yy' }} · {{ money(h.last.amount) }}
                          <span class="qt-muted">· típico ~{{ money(h.typical_amount) }} · {{ h.n_orders }} órdenes</span>
                        } @else {
                          <span class="qt-muted">Sin compras directas{{ r.via==='transfer' ? ' (se surte por traspaso)' : '' }}</span>
                        }
                      </div>
                    }
                  </div>

                  <!-- Aviso: traspaso NO surtible (el hub no tiene stock) -->
                  @if (r.via==='transfer' && hubShortCount(r._key) > 0) {
                    <div class="qt-block" role="alert">
                      <i class="pi pi-exclamation-triangle"></i>
                      El hub <strong>{{ r.source_warehouse_code }}</strong> no tiene stock para surtir {{ hubShortCount(r._key) }} línea(s).
                      El faltante hay que <strong>comprarlo directo</strong>, no traspasarlo.
                    </div>
                  }

                  @if (st.lines.length) {
                    <table class="qt-det-table">
                      <thead>
                        <tr>
                          <th>SKU</th><th>Producto</th>
                          <th class="qt-r">Existencia</th>
                          @if (r.via==='transfer') { <th class="qt-r">En hub</th> }
                          <th class="qt-r">Objetivo</th><th class="qt-r">Sugerido</th>
                          <th class="qt-r qt-pedir">Pedir (pz)</th>
                          <th class="qt-r">Cajas</th><th class="qt-r">$ línea</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (l of st.lines; track l.product_id) {
                          <tr [class.qt-det-below]="l.on_hand <= l.reorder_point">
                            <td class="qt-mono">{{ l.sku }}</td>
                            <td>{{ l.nombre }}</td>
                            <td class="qt-r" [class.qt-bad]="l.on_hand <= 0">{{ l.on_hand | number:'1.0-0' }}</td>
                            @if (r.via==='transfer') {
                              <td class="qt-r" [class.qt-bad]="hubShort(r._key, l)" [pTooltip]="hubShort(r._key, l) ? 'El hub no alcanza a surtir lo pedido' : ''">
                                {{ hubOnHand(r._key, l) === null ? '—' : (hubOnHand(r._key, l) | number:'1.0-0') }}
                              </td>
                            }
                            <td class="qt-r qt-muted">{{ objetivo(l) | number:'1.0-0' }}</td>
                            <td class="qt-r">{{ l.suggested_qty | number:'1.0-0' }}</td>
                            <td class="qt-r qt-pedir"><p-inputNumber [(ngModel)]="l.final" [min]="0" [showButtons]="false" inputStyleClass="qt-qty" (onInput)="touch()"></p-inputNumber></td>
                            <td class="qt-r qt-muted">{{ cajas(l) | number:'1.0-0' }}</td>
                            <td class="qt-r">{{ money(lineCost(l)) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                    <div class="qt-det-foot">
                      @if (r.via==='purchase' && minWarn(r._key); as mw) {
                        <p-tag severity="warn" [value]="mw" styleClass="qt-mintag" [pTooltip]="'Mínimo de compra del proveedor (captúralo en Proveedores).'"></p-tag>
                      }
                      <span class="qt-foot-tot">
                        {{ countToOrder(r._key) }} línea(s) · {{ totalPz(r._key) | number:'1.0-0' }} pz ·
                        {{ totalCajas(r._key) | number:'1.0-0' }} cajas · <strong>{{ money(detailTotal(r._key)) }}</strong>
                      </span>
                      <button pButton [label]="r.via==='transfer' ? 'Crear traspaso' : 'Crear requisición'"
                              icon="pi pi-file-edit" class="p-button-sm"
                              [loading]="st.creating" [disabled]="countToOrder(r._key)===0"
                              (click)="createReq(r)"></button>
                    </div>
                  } @else {
                    <div class="qt-det-msg">Sin SKUs por pedir con base “{{ basisLabel(st.basis) }}” (todo cubierto).</div>
                  }
                </div>
                }
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="11" class="qt-empty">Sin ciclos activos con estos filtros. Ajusta el territorio o corre el job de cadencia.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    app-metric-strip { display: block; margin-bottom: .9rem; }
    .qt-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .qt-terr { display: flex; align-items: center; gap: .15rem; flex-wrap: wrap; }
    .qt-terr-lbl { font-size: .78rem; color: var(--text-muted); margin-right: .25rem; }
    .qt-sel { min-width: 14rem; }
    .qt-sel-sm { min-width: 9rem; }
    .qt-sel-wide { min-width: 15rem; }
    .qt-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .qt-table { font-size: .82rem; }
    .qt-r { text-align: right; font-variant-numeric: tabular-nums; }
    .qt-nowrap { white-space: nowrap; }
    .qt-muted { color: var(--text-muted); }
    .qt-strong { font-weight: 700; }
    .qt-bad { color: var(--bad-fg); font-weight: 600; }
    .qt-dd { font-size: .72rem; color: var(--text-muted); margin-left: .35rem; }
    .qt-via { display: inline-flex; align-items: center; gap: .3rem; font-size: .78rem; }
    .qt-via i { font-size: .7rem; }
    .qt-via-t { color: var(--action); }
    .qt-cad { font-variant-numeric: tabular-nums; margin-right: .35rem; }
    :host ::ng-deep .qt-band { font-size: .62rem !important; padding: .05rem .3rem !important; }
    .qt-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    /* detalle (drill-down) */
    .qt-detrow > td { background: var(--surface-sunken, var(--card-bg)); padding: .4rem .75rem .6rem; }
    .qt-det-msg { color: var(--text-muted); font-size: .82rem; padding: .5rem; }
    .qt-det-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      flex-wrap: wrap; padding: .1rem .1rem .5rem; }
    .qt-basis { display: flex; align-items: center; gap: .1rem; }
    .qt-basis-lbl { font-size: .74rem; color: var(--text-muted); margin-right: .3rem; }
    .qt-hist { font-size: .76rem; color: var(--text-main); display: inline-flex; align-items: center; gap: .35rem; }
    .qt-hist i { font-size: .72rem; color: var(--text-muted); }
    .qt-block { display: flex; align-items: center; gap: .45rem; font-size: .78rem;
      background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border);
      border-radius: var(--r-sm, 6px); padding: .35rem .6rem; margin-bottom: .5rem; }
    .qt-block i { font-size: .8rem; }
    .qt-det-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .qt-det-table th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: .72rem;
      text-transform: uppercase; letter-spacing: .02em; padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); }
    .qt-det-table td { padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); }
    .qt-det-below td { background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .qt-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .76rem; }
    .qt-pedir { width: 7rem; }
    :host ::ng-deep .qt-qty { width: 5.5rem; text-align: right; font-size: .8rem; padding: .2rem .4rem; }
    .qt-det-foot { display: flex; align-items: center; justify-content: flex-end; gap: .75rem; padding: .55rem .5rem 0; }
    .qt-foot-tot { font-size: .82rem; color: var(--text-main); }
    :host ::ng-deep .qt-mintag { font-size: .68rem !important; }
  `],
})
export class ComprasQueTocaComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<WLRow[]>([]);
  warehouses = signal<{ id: string; code: string; label: string }[]>([]);
  supplierOpts = signal<{ label: string; value: string }[]>([]);
  detail = signal<Record<string, DetailState>>({});
  total = signal(0);
  vencidos = signal(0);
  hoy = signal(0);
  prox7 = signal(0);
  loading = signal(false);
  readonly loadedAt = signal<number | null>(null);
  private readonly touchTick = signal(0); // fuerza recálculo de totales al editar
  sugeridoTotal = computed(() => this.rows().reduce((s, r) => s + (Number(r.suggested_cost) || 0), 0));

  readonly kpiItems = computed<MetricStripItem[]>(() => [
    { label: 'Vencidos', value: this.vencidos(), tone: this.vencidos() > 0 ? 'bad' : 'default' },
    { label: 'Hoy', value: this.hoy(), tone: this.hoy() > 0 ? 'warn' : 'default' },
    { label: 'Próx. 7 días', value: this.prox7() },
    { label: 'Sugerido (visible)', value: this.sugeridoTotal(), format: 'currency', tone: 'brand' },
  ]);

  fWh: string[] = [];
  fVia = '';
  fStatus = '';
  fSearch = '';
  viaOpts = [{ label: 'Compra', value: 'purchase' }, { label: 'Traspaso', value: 'transfer' }];
  statusOpts = [{ label: 'Activos', value: '' }, { label: 'Solo lo que toca (≤ hoy)', value: 'due' }];
  basisOpts: { label: string; value: OrderBasis; tip: string }[] = [
    { label: 'Cadencia', value: 'cadence', tip: 'Cubre el ciclo del canal (cadencia + lead + colchón). El pedido "normal".' },
    { label: 'Reorden', value: 'reorder', tip: 'Sube hasta el punto de reorden. Catch-up tras desabasto.' },
    { label: 'Máximo', value: 'max', tip: 'Sube al máximo (tope de almacén).' },
  ];
  territories = [
    { label: 'Bajío', codes: ['01', '02', '03', '04'] },
    { label: 'Morelia', codes: ['MD-30', 'MD-32'] },
    { label: 'Zamora', codes: ['05', 'MD-50'] },
    { label: 'CEDIS', codes: ['00'] },
  ];

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f: ReplenishmentFilters) => {
        this.warehouses.set(f.warehouses.map((w) => ({ id: w.id, code: w.code, label: `${w.code} · ${w.name}` })));
        this.supplierOpts.set(f.suppliers.map((s) => ({ label: s.name, value: s.name })));
      },
      error: () => {},
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.detail.set({}); // invalida drill-downs al refiltrar
    this.api.worklist({ warehouse_ids: this.fWh.length ? this.fWh : undefined, via: this.fVia || undefined, status: this.fStatus || undefined, search: this.fSearch || undefined, pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.rows.set(r.rows.map((x) => ({ ...x, _key: `${x.warehouse_id}__${x.supplier_id}` })));
          this.total.set(r.total); this.vencidos.set(r.vencidos); this.hoy.set(r.hoy); this.prox7.set(r.prox7);
          this.loading.set(false); this.loadedAt.set(Date.now());
        },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el pedido.' }); },
      });
  }

  // ── Drill-down: SKUs del proveedor en ese almacén (base seleccionable) + contexto ──
  onExpand(r: WLRow): void {
    const cur = this.detail()[r._key];
    if (cur && !cur.loading) return; // ya cargado
    this.loadLines(r, 'cadence', true);
  }

  setBasis(r: WLRow, basis: OrderBasis): void {
    if (this.detail()[r._key]?.basis === basis) return;
    this.loadLines(r, basis, false); // recarga solo las líneas; conserva hub + histórico
  }

  private loadLines(r: WLRow, basis: OrderBasis, withContext: boolean): void {
    this.detail.update((d) => ({
      ...d,
      [r._key]: { loading: true, basis, lines: d[r._key]?.lines ?? [], hub: d[r._key]?.hub ?? null, hist: d[r._key]?.hist ?? null, creating: false },
    }));
    this.api.criticalStock({ supplier_id: r.supplier_id, warehouse_id: r.warehouse_id, target_basis: basis, scope: 'all', pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (res) => {
          const lines: DetailLine[] = res.rows
            .filter((x) => Number(x.suggested_qty) > 0)
            .map((x) => ({ ...x, uxc: this.uxc(x), final: Math.round(Number(x.suggested_qty) || 0) }));
          this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], loading: false, basis, lines } } : d));
        },
        error: () => {
          this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], loading: false, lines: [] } } : d));
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los SKUs.' });
        },
      });
    if (!withContext) return;
    // Histórico de compras (para traspaso, el hub es donde se compra realmente)
    const buyWh = r.via === 'transfer' ? (r.source_warehouse_id ?? undefined) : r.warehouse_id;
    this.api.supplierOrderHistory(r.supplier_id, buyWh).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], hist: h } } : d)),
      error: () => {},
    });
    // Cobertura del hub (solo traspaso): existencia del origen para esos SKUs
    if (r.via === 'transfer' && r.source_warehouse_id) {
      this.api.criticalStock({ supplier_id: r.supplier_id, warehouse_id: r.source_warehouse_id, target_basis: 'max', scope: 'all', pageSize: 1000 })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (res) => {
            const hub: Record<string, number> = {};
            for (const x of res.rows) hub[x.product_id] = Number(x.on_hand) || 0;
            this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], hub } } : d));
          },
          error: () => {},
        });
    }
  }

  touch(): void { this.touchTick.update((n) => n + 1); }
  objetivo(l: DetailLine): number { return Math.round(Number(l.on_hand) + Number(l.in_transit) + Number(l.suggested_qty)); }
  private uxc(l: CriticalStockRow): number {
    const fs = Number(l.factor_sale), fp = Number(l.factor_purchase);
    return fs > 0 ? fs : (fp > 0 ? fp : 1);
  }
  cajas(l: DetailLine): number { return Math.ceil(Number(l.final || 0) / (l.uxc || 1)); }
  lineCost(l: DetailLine): number { return Number(l.final || 0) * Number(l.unit_cost || 0); }

  private linesOf(key: string): DetailLine[] { this.touchTick(); return this.detail()[key]?.lines ?? []; }
  countToOrder(key: string): number { return this.linesOf(key).filter((l) => Number(l.final) > 0).length; }
  detailTotal(key: string): number { return this.linesOf(key).reduce((s, l) => s + Number(l.final || 0) * Number(l.unit_cost || 0), 0); }
  totalPz(key: string): number { return this.linesOf(key).reduce((s, l) => s + Number(l.final || 0), 0); }
  totalCajas(key: string): number { return this.linesOf(key).reduce((s, l) => s + Math.ceil(Number(l.final || 0) / (l.uxc || 1)), 0); }

  // Cobertura del hub (traspaso)
  hubOnHand(key: string, l: DetailLine): number | null { const h = this.detail()[key]?.hub; return h ? (h[l.product_id] ?? 0) : null; }
  hubShort(key: string, l: DetailLine): boolean {
    const st = this.detail()[key]; this.touchTick();
    if (!st?.hub) return false; return (st.hub[l.product_id] ?? 0) < Number(l.final || 0);
  }
  hubShortCount(key: string): number {
    const st = this.detail()[key]; this.touchTick();
    if (!st?.hub) return 0; return st.lines.filter((l) => (st.hub![l.product_id] ?? 0) < Number(l.final || 0)).length;
  }

  // Mínimo de compra del proveedor vs el pedido de esta sucursal (solo compra)
  minWarn(key: string): string | null {
    this.touchTick();
    const st = this.detail()[key]; if (!st?.lines.length) return null;
    const l0 = st.lines[0];
    const minA = l0.supplier_min_amount != null ? Number(l0.supplier_min_amount) : null;
    const minB = l0.supplier_min_boxes != null ? Number(l0.supplier_min_boxes) : null;
    if (minA != null && this.detailTotal(key) < minA) return `Bajo mínimo · ${this.money(this.detailTotal(key))} < ${this.money(minA)}`;
    if (minB != null && this.totalCajas(key) < minB) return `Bajo mínimo · ${this.totalCajas(key)} < ${minB} cajas`;
    return null;
  }

  histTip(h: SupplierOrderHistory): string {
    if (!h.recent?.length) return '';
    const recent = h.recent.map((e) => `${new Date(e.date).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit' })}  ${this.money(e.amount)}`).join('\n');
    return `Últimas compras:\n${recent}\n\nMediana ${this.money(h.median_amount)} · máx ${this.money(h.max_amount)}`;
  }

  createReq(r: WLRow): void {
    const st = this.detail()[r._key];
    if (!st) return;
    const picked = st.lines.filter((l) => Number(l.final) > 0);
    if (!picked.length) return;
    const isTransfer = r.via === 'transfer';
    if (isTransfer && !r.source_warehouse_id) {
      this.toast.add({ severity: 'warn', summary: 'Sin origen', detail: 'Este traspaso no tiene almacén origen (hub). Configúralo en Red de abasto.' });
      return;
    }
    const dto: CreateRequisitionDto = {
      warehouse_id: r.warehouse_id,
      supplier_id: isTransfer ? null : r.supplier_id,
      source_type: isTransfer ? 'branch' : 'supplier',
      source_warehouse_id: isTransfer ? r.source_warehouse_id : null,
      notes: `Pedido ${r.supplier_name || ''} @ ${r.warehouse_code} · base ${st.basis}`.trim(),
      lines: picked.map((l) => ({
        product_id: l.product_id,
        supplier_id: isTransfer ? null : (l.supplier_id ?? r.supplier_id),
        source_type: isTransfer ? 'branch' : 'supplier',
        source_warehouse_id: isTransfer ? r.source_warehouse_id : null,
        on_hand: Number(l.on_hand), in_transit: Number(l.in_transit),
        min_stock: Number(l.min_stock), reorder_point: Number(l.reorder_point), max_stock: Number(l.max_stock),
        suggested_qty: Number(l.suggested_qty), final_qty: Number(l.final), unit_cost: Number(l.unit_cost || 0),
      })),
    };
    this.detail.update((d) => ({ ...d, [r._key]: { ...d[r._key], creating: true } }));
    this.api.createRequisition(dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (req) => {
        this.detail.update((d) => ({ ...d, [r._key]: { ...d[r._key], creating: false } }));
        this.toast.add({ severity: 'success', summary: isTransfer ? 'Traspaso creado' : 'Requisición creada', detail: `${req.folio} · ${picked.length} línea(s)` });
      },
      error: (e) => {
        this.detail.update((d) => ({ ...d, [r._key]: { ...d[r._key], creating: false } }));
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' });
      },
    });
  }

  isTerr(codes: string[]): boolean {
    const ids = this.idsForCodes(codes);
    return ids.length > 0 && ids.length === this.fWh.length && ids.every((i) => this.fWh.includes(i));
  }
  applyTerr(codes: string[]): void {
    const ids = this.idsForCodes(codes);
    this.fWh = this.isTerr(codes) ? [] : ids;
    this.reload();
  }
  private idsForCodes(codes: string[]): string[] {
    return this.warehouses().filter((w) => codes.includes(w.code)).map((w) => w.id);
  }

  estLabel(r: WLRow): string {
    const d = r.days_to_due ?? 99;
    return d < 0 ? 'Vencido' : d === 0 ? 'Hoy' : d <= 7 ? 'Próximo' : 'Futuro';
  }
  estSev(r: WLRow): Sev {
    const d = r.days_to_due ?? 99;
    return d < 0 ? 'danger' : d === 0 ? 'warn' : d <= 7 ? 'info' : 'secondary';
  }
  ddLabel(d: number | null): string {
    if (d == null) return '';
    if (d < 0) return `${Math.abs(d)}d tarde`;
    if (d === 0) return 'hoy';
    return `en ${d}d`;
  }
  basisLabel(b: OrderBasis): string { return ({ cadence: 'Cadencia', reorder: 'Reorden', max: 'Máximo', min: 'Mínimo' } as Record<string, string>)[b] || b; }
  bandLabel(b: string): string { return ({ rapida: 'rápida', promedio: 'promedio', mal_abasto: 'lento' } as Record<string, string>)[b] || b; }
  bandSev(b: string): Sev { return ({ rapida: 'success', promedio: 'info', mal_abasto: 'danger' } as Record<string, Sev>)[b] || 'secondary'; }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
