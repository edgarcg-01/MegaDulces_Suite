import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ComprasService, SupplierParam, SupplierOrder, SupplierOrderParamsDto, ReplenishmentSettings } from '../compras.service';

/**
 * RA-PRO.3/10 — Parámetros de pedido por proveedor. Kepler NO codifica lead time real; se
 * captura aquí. RA-PRO.10 suma el CICLO manual (cadencia override + colchón) y el MÍNIMO DE
 * COMPRA (en $ o cajas). El motor: horizonte = cadencia+colchón; el mínimo se evalúa por
 * proveedor (total) y sube el pedido al mínimo (repartiendo en los que más rotan). El botón
 * "Ver pedido" muestra el consolidado ya evaluado. Superficie Operations (denso, tokens).
 */
@Component({
  selector: 'app-compras-proveedores',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule, InputNumberModule, IconFieldModule, InputIconModule, DialogModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cp-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Parámetros de compra</h1>
          <p class="surf-page-sub">El motor <strong>analiza y fija solo</strong> el fill rate, la cobertura y el colchón por proveedor (del histórico de recepciones, cadencia de compra y variabilidad de demanda). Los campos muestran el valor <em>auto</em> como placeholder; captura solo si quieres <strong>forzar</strong> un override manual.</p>
        </div>
      </header>

      <!-- RA-PRO.27 — parámetros globales del fill rate (aplican a todo el pedido) -->
      @if (settings(); as s) {
        <div class="cp-settings" role="group" aria-label="Parámetros globales del fill rate">
          <span class="cp-settings-title"><i class="pi pi-sliders-h"></i> Fill rate global</span>
          <label title="Meses de historia de recepciones para calcular el fill rate">Ventana
            <input pInputText type="number" min="30" max="730" [(ngModel)]="s.fill_window_days" (change)="saveSettings()" class="cp-num" /> d</label>
          <label title="Recepciones mínimas de un proveedor para confiar en su fill rate; con menos, se asume 100%">Mín. recepciones
            <input pInputText type="number" min="1" max="50" [(ngModel)]="s.fill_min_lines" (change)="saveSettings()" class="cp-num" /></label>
          <label title="Tope de inflado del pedido (piso del fill rate = 1 ÷ tope)">Tope inflado
            <input pInputText type="number" min="1" max="3" step="0.05" [(ngModel)]="s.fill_max_inflate" (change)="saveSettings()" class="cp-num" />×</label>
          <label title="Días de cobertura cuando el pedido no trae uno explícito">Cobertura default
            <input pInputText type="number" min="1" max="120" [(ngModel)]="s.default_coverage_days" (change)="saveSettings()" class="cp-num" /> d</label>
        </div>
      }

      <div class="cp-filters">
        <p-iconfield styleClass="cp-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Buscar proveedor…" aria-label="Buscar proveedor" />
        </p-iconfield>
        <span class="cp-count">{{ rows().length | number }} proveedores</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
               styleClass="p-datatable-sm cp-table">
        <ng-template pTemplate="header">
          <tr>
            <th>Proveedor</th>
            <th class="cp-r">Prod.</th>
            <th class="cp-r" title="Días de entrega (pedido→recepción). Alimenta la cobertura automática (cadencia de compra + lead).">Lead (d)</th>
            <th class="cp-r" title="Mínimo de compra en cajas">Mín cajas</th>
            <th class="cp-r" title="Mínimo de compra en $">Mín $</th>
            <th class="cp-r cp-sep" title="RA-PRO.27 — fill rate manual (%): gana sobre el histórico. Vacío = automático por recepciones.">Fill %</th>
            <th class="cp-r" title="RA-PRO.27 — colchón adicional % sobre el sugerido de este proveedor">Colchón %</th>
            <th class="cp-r" title="RA-PRO.27 — días de cobertura propios (reemplazan el global del filtro)">Cobertura (d)</th>
            <th class="cp-r" style="width:6rem"></th>
            <th style="width:2rem"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr>
            <td>{{ r.name }}</td>
            <td class="cp-r cp-muted">{{ r.product_count | number }}</td>
            <td class="cp-r"><input pInputText type="number" min="0" max="365" [(ngModel)]="r.lead_time_days" (change)="saveLead(r)" class="cp-num" [class.cp-unset]="r.lead_time_days == null" placeholder="7*" /></td>
            <td class="cp-r"><input pInputText type="number" min="0" [(ngModel)]="r.min_order_boxes" (change)="saveParam(r, { min_order_boxes: numOrNull(r.min_order_boxes) })" class="cp-num" [class.cp-unset]="r.min_order_boxes == null" placeholder="—" /></td>
            <td class="cp-r"><p-inputnumber [(ngModel)]="r.min_order_amount" (onBlur)="saveParam(r, { min_order_amount: numOrNull(r.min_order_amount) })" mode="currency" currency="MXN" locale="es-MX" [maxFractionDigits]="0" [min]="0" [showButtons]="false" inputStyleClass="cp-num" placeholder="—" /></td>
            <td class="cp-r cp-sep">
              <input pInputText type="number" min="1" max="100" [(ngModel)]="r.fill_pct" (change)="saveParam(r, { fill_rate_override: r.fill_pct == null || r.fill_pct === undefined ? null : numOrNull(r.fill_pct)! / 100 })" class="cp-num" [class.cp-unset]="r.fill_pct == null"
                     [placeholder]="r.fill_rate_auto != null ? ((r.fill_rate_auto * 100 | number:'1.0-0') + '% auto') : 'auto'"
                     [title]="r.fill_receptions ? (r.fill_receptions + ' recepciones en la ventana') : 'sin historia — asume 100%'" />
            </td>
            <td class="cp-r"><input pInputText type="number" min="0" max="100" [(ngModel)]="r.safety_pct" (change)="saveParam(r, { safety_pct: numOrNull(r.safety_pct) })" class="cp-num" [class.cp-unset]="r.safety_pct == null" [placeholder]="r.auto_safety_pct ? (r.auto_safety_pct + '% auto') : '0'" /></td>
            <td class="cp-r"><input pInputText type="number" min="1" max="120" [(ngModel)]="r.coverage_days_override" (change)="saveParam(r, { coverage_days_override: numOrNull(r.coverage_days_override) })" class="cp-num" [class.cp-unset]="r.coverage_days_override == null" [placeholder]="r.auto_coverage_days ? (r.auto_coverage_days + ' auto') : 'global'" /></td>
            <td class="cp-r"><button pButton type="button" label="Ver pedido" icon="pi pi-list" class="p-button-sm p-button-text" (click)="openOrder(r)"></button></td>
            <td class="cp-r">@if (savedId() === r.id) { <i class="pi pi-check cp-ok"></i> }</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="10" class="cp-empty">Sin proveedores.</td></tr>
        </ng-template>
      </p-table>
      <p class="cp-foot">Estos parámetros son EXACTAMENTE los que usa <strong>/compras/pedido</strong> (mismo motor). Los placeholders <em>"… auto"</em> son lo que el <strong>análisis</strong> calculó y ya aplica: <strong>Fill %</strong> del histórico de recepciones · <strong>Colchón %</strong> de la variabilidad (estable 0 / medio 10 / volátil 20) · <strong>Cobertura</strong> de la cadencia real de compra + lead time. Escribe un valor solo para <strong>forzar</strong> un override (gana sobre el auto). <strong>Lead</strong> y <strong>Mín</strong> afinan la cobertura automática y el mínimo de compra. Los globales de arriba controlan la ventana y el tope del análisis.</p>

      <p-dialog [(visible)]="orderVisible" [modal]="true" [style]="{ width: '54rem' }" [dismissableMask]="true" [header]="order()?.supplier?.name || 'Pedido consolidado'">
        @if (orderLoading()) { <div class="cp-dlg-msg">Calculando…</div> }
        @else if (order()) {
          @if (order(); as o) {
          <div class="cp-dlg-head">
            <div class="cp-dlg-tot">
              <span class="cp-dlg-lbl">Sugerido</span>
              <span class="cp-dlg-val">{{ o.totals.suggested_cajas | number:'1.0-1' }} cja · {{ money(o.totals.suggested_amount) }}</span>
            </div>
            <i class="pi pi-arrow-right cp-dlg-arrow"></i>
            <div class="cp-dlg-tot">
              <span class="cp-dlg-lbl">Pedido {{ o.padded ? '(subido al mínimo)' : '' }}</span>
              <span class="cp-dlg-val cp-strong">{{ o.totals.cajas | number:'1.0-1' }} cja · {{ money(o.totals.amount) }}</span>
            </div>
            @if (o.padded) { <p-tag value="Subido al mínimo" severity="warn" styleClass="cp-dlg-tag"></p-tag> }
            @if (o.supplier.min_order_amount) { <span class="cp-dlg-min">mín {{ money(o.supplier.min_order_amount) }}</span> }
            @else if (o.supplier.min_order_boxes) { <span class="cp-dlg-min">mín {{ o.supplier.min_order_boxes }} cja</span> }
          </div>
          <table class="cp-dlg-table">
            <thead><tr><th>Almacén</th><th>SKU</th><th>Producto</th><th class="cp-r">Exist.</th><th class="cp-r">Sugerido</th><th class="cp-r">Pedir</th><th class="cp-r">Cajas</th><th class="cp-r">$</th></tr></thead>
            <tbody>
              @for (l of o.lines; track l.product_id + l.warehouse_id) {
                <tr>
                  <td class="cp-muted">{{ l.warehouse_code }}</td>
                  <td class="cp-mono">{{ l.sku }}</td>
                  <td>{{ l.nombre }}</td>
                  <td class="cp-r cp-muted">{{ l.on_hand | number:'1.0-0' }}</td>
                  <td class="cp-r cp-muted">{{ l.suggested | number:'1.0-0' }}</td>
                  <td class="cp-r cp-strong" [class.cp-padded]="l.final > l.suggested">{{ l.final | number:'1.0-0' }}</td>
                  <td class="cp-r">{{ l.cajas | number:'1.0-1' }}</td>
                  <td class="cp-r">{{ money(l.line_cost) }}</td>
                </tr>
              }
              @empty { <tr><td colspan="8" class="cp-empty">Sin nada por pedir a este proveedor ahora.</td></tr> }
            </tbody>
          </table>
          }
        }
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cp-settings { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: .75rem; padding: .6rem .9rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); }
    .cp-settings-title { font-size: .78rem; font-weight: 600; color: var(--text-main); display: inline-flex; align-items: center; gap: .35rem; }
    .cp-settings label { font-size: .76rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .35rem; }
    :host ::ng-deep .cp-settings .cp-num { width: 4.5rem; min-width: 4.5rem; }
    th.cp-sep, td.cp-sep { border-left: 2px solid var(--border-color); }
    .cp-filters { display: flex; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    :host ::ng-deep .cp-search input { min-width: 16rem; }
    .cp-count { margin-left: auto; font-size: .8rem; color: var(--text-muted); }
    .cp-table { font-size: .84rem; }
    .cp-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cp-muted { color: var(--text-muted); }
    /* Auto-ajuste al valor: el input crece con su contenido (acotado), así no se corta
       el dato (ej. Mín $ grande). field-sizing es soportado por el Chromium de la app.
       ng-deep porque cp-num también viste el input interno de <p-inputnumber> (Mín $). */
    :host ::ng-deep .cp-num { field-sizing: content; min-width: 4rem; max-width: 12rem; width: auto; text-align: right; }
    .cp-unset { color: var(--text-muted); }
    .cp-ok { color: var(--ok-fg); }
    .cp-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .cp-foot { font-size: .72rem; color: var(--text-muted); margin-top: .5rem; }
    .cp-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .cp-strong { font-weight: 700; }
    .cp-padded { color: var(--action); }
    .cp-dlg-msg { color: var(--text-muted); padding: 1rem; }
    .cp-dlg-head { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-bottom: .75rem; padding-bottom: .6rem; border-bottom: 1px solid var(--border-color); }
    .cp-dlg-tot { display: flex; flex-direction: column; }
    .cp-dlg-lbl { font-size: .7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cp-dlg-val { font-size: .95rem; font-variant-numeric: tabular-nums; }
    .cp-dlg-arrow { color: var(--text-muted); }
    .cp-dlg-min { font-size: .78rem; color: var(--text-muted); margin-left: auto; }
    .cp-dlg-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .cp-dlg-table th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: .7rem; text-transform: uppercase; padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); }
    .cp-dlg-table td { padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); }
  `],
})
export class ComprasProveedoresComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<SupplierParam[]>([]);
  loading = signal(false);
  savedId = signal<string | null>(null);
  search = '';
  settings = signal<ReplenishmentSettings | null>(null); // RA-PRO.27 — parámetros globales

  orderVisible = false;
  order = signal<SupplierOrder | null>(null);
  orderLoading = signal(false);

  ngOnInit(): void { this.load(); this.loadSettings(); }

  load(): void {
    this.loading.set(true);
    this.api.listSuppliers(this.search || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // fill_pct = fill_rate_override en % para editar cómodo (se reconvierte a fracción al guardar).
      next: (r) => { this.rows.set(r.map((s) => ({ ...s, fill_pct: s.fill_rate_override == null ? null : Math.round(s.fill_rate_override * 100) }))); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los proveedores.' }); },
    });
  }

  loadSettings(): void {
    this.api.getReplenishmentSettings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.settings.set(s), error: () => {},
    });
  }

  saveSettings(): void {
    const s = this.settings();
    if (!s) return;
    this.api.updateReplenishmentSettings(s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.settings.set(r); this.toast.add({ severity: 'success', summary: 'Guardado', detail: 'Parámetros globales actualizados.' }); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron guardar los parámetros.' }),
    });
  }

  numOrNull(v: unknown): number | null { return v == null || (v as string) === '' || Number.isNaN(Number(v)) ? null : Number(v); }
  private flash(id: string) { this.savedId.set(id); setTimeout(() => this.savedId.set(null), 1500); }

  saveLead(r: SupplierParam): void {
    this.api.setSupplierLeadTime(r.id, this.numOrNull(r.lead_time_days)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.flash(r.id),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el lead time.' }),
    });
  }

  saveParam(r: SupplierParam, patch: SupplierOrderParamsDto): void {
    this.api.setSupplierOrderParams(r.id, patch).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.flash(r.id),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el parámetro.' }),
    });
  }

  openOrder(r: SupplierParam): void {
    this.orderVisible = true;
    this.order.set(null);
    this.orderLoading.set(true);
    this.api.supplierOrder(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => { this.order.set(o); this.orderLoading.set(false); },
      error: () => { this.orderLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo calcular el pedido.' }); },
    });
  }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
