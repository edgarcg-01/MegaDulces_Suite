import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { SkeletonModule } from 'primeng/skeleton';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { DATE_PRESET_OPTIONS, datePresetRange } from '../../../shared/util';
import { ComprasService, SupplierLedgerResponse, SupplierLedgerRow, SupplierLedgerMove } from '../compras.service';

/**
 * CXP.7 — "Cuadre contable por proveedor": estado de cuenta de la 201 (Proveedores) según
 * los libros de Kepler. Por proveedor: facturado (XA2001/XA1001) vs pagado (XD2601/XD2501)
 * vs notas (XD5501) vs devoluciones (XD4001) → Δ = movimiento neto de la deuda en el periodo.
 * Corroboración contable independiente de Compras 360. Read-only sobre analytics.gl_*.
 * Operations mode, PrimeNG-first.
 */
@Component({
  selector: 'app-compras-cuadre-proveedor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, SelectModule, DatePickerModule, SkeletonModule, DialogModule, TagModule, MetricStripComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuadre contable por proveedor</h1>
          <p class="surf-page-sub">Estado de cuenta de la 201 (Proveedores) según los libros de Kepler: qué le facturaste, qué le pagaste y qué te acreditó por notas, por proveedor. <b>Δ</b> = movimiento neto de la deuda en el periodo (no saldo absoluto).</p>
        </div>
        <div class="cq-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cq-filters">
        <p-iconfield styleClass="cq-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar proveedor" />
        </p-iconfield>
        <p-select [options]="presetOpts" [ngModel]="preset()" (onChange)="onPreset($event.value)" optionLabel="label" optionValue="value" placeholder="Rango rápido" [showClear]="true" styleClass="cq-sel" ariaLabel="Rango de fecha rápido" />
        <p-datepicker [ngModel]="dateFrom()" (onSelect)="onDate('from', $event)" (onClear)="onDate('from', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="cq-dp" ariaLabel="Desde" />
        <p-datepicker [ngModel]="dateTo()" (onSelect)="onDate('to', $event)" (onClear)="onDate('to', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="cq-dp" ariaLabel="Hasta" />
        @if (hasFilters()) {
          <button pButton type="button" class="p-button-sm p-button-text" (click)="clearFilters()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button>
        }
      </div>

      @if (err(); as e) {
        <div class="cq-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="cq-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
        </div>
      }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Totales del cuadre por proveedor" />
      }

      @if (loading()) {
        <div class="cq-skel">
          @for (i of skelRows; track i) { <p-skeleton height="2rem" styleClass="cq-skel-row" /> }
        </div>
      } @else if (data(); as d) {
        <p-table [value]="d.rows" [loading]="false" styleClass="p-datatable-sm surf-table surf-table--sticky cq-table"
                 [rowHover]="true" [scrollable]="true" scrollHeight="flex">
          <ng-template #header>
            <tr>
              <th>Proveedor</th>
              <th class="ta-r cq-w-amt">Facturado</th>
              <th class="ta-r cq-w-amt">Pagado</th>
              <th class="ta-r cq-w-amt">Notas</th>
              <th class="ta-r cq-w-amt">Devol.</th>
              <th class="ta-r cq-w-amt">Δ periodo</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="cq-row" role="button" tabindex="0"
                [attr.aria-label]="'Ver desglose de ' + (r.proveedor || 'sin referencia')"
                (click)="openDetail(r)" (keydown.enter)="openDetail(r)" (keydown.space)="$event.preventDefault(); openDetail(r)">
              <td class="cq-prov" [title]="r.proveedor">{{ r.proveedor || '—' }} <span class="cq-drillhint" aria-hidden="true">→ desglose</span></td>
              <td class="ta-r cq-num">{{ money(r.facturado) }}</td>
              <td class="ta-r cq-num">{{ r.pagado ? money(r.pagado) : '—' }}</td>
              <td class="ta-r cq-num" [class.cq-pos]="r.notas > 0">{{ r.notas ? money(r.notas) : '—' }}</td>
              <td class="ta-r cq-num">{{ r.devoluciones ? money(r.devoluciones) : '—' }}</td>
              <td class="ta-r cq-num cq-strong" [class.cq-up]="r.delta > 0" [class.cq-down]="r.delta < 0">{{ money(r.delta) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="6">
              <div class="cq-empty-op">
                <i class="pi pi-inbox" aria-hidden="true"></i>
                <span class="cq-empty-op-title">Sin movimientos</span>
                @if (hasFilters()) {
                  <span class="cq-empty-op-sub">Ningún proveedor coincide con los filtros actuales.</span>
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
                } @else {
                  <span class="cq-empty-op-sub">No hay pólizas de proveedor (201) en el periodo (o falta el feed de pólizas de Kepler).</span>
                }
              </div>
            </td></tr>
          </ng-template>
        </p-table>
        <p class="cq-foot">Movimiento de la cuenta <b>201 Proveedores</b> en los libros de Kepler: <b>Facturado</b> = abonos (XA2001/comprobación) · <b>Pagado</b> = cargos de pago (XD2601/XD2501) · <b>Notas</b> = notas de crédito (XD5501) · <b>Devol.</b> = devoluciones (XD4001). <b>Δ</b> = facturado − pagado − notas − devol (cuánto creció/bajó la deuda en el periodo; no incluye saldo de apertura). Algunas filas son entidades internas (el dueño, sucursales) porque la 201 también asienta deuda inter-sucursal. <b>Clic en una fila</b> para ver el desglose (folios, fechas, saldo corrido).</p>
      }
    </div>

    <p-dialog [visible]="!!detail()" (visibleChange)="!$event && closeDetail()" [modal]="true" [dismissableMask]="true" [style]="{ width: '1040px', maxWidth: '96vw' }" [header]="detail()?.proveedor || 'Desglose'">
      @if (detail(); as d) {
        <div class="cq-dt-kpis">
          <span>Facturado <b>{{ money(d.facturado) }}</b></span>
          <span>Pagado <b>{{ money(d.pagado) }}</b></span>
          <span>Notas <b>{{ money(d.notas) }}</b></span>
          <span>Devol. <b>{{ money(d.devoluciones) }}</b></span>
          <span>Δ <b>{{ money(d.delta) }}</b></span>
        </div>
        @if (movesLoading()) {
          <p class="cq-empty">Cargando movimientos…</p>
        } @else if (moves().length === 0) {
          <p class="cq-empty">Sin movimientos en la 201 para este proveedor en el periodo.</p>
        } @else {
          <div class="cq-tacct">
            <!-- IZQUIERDA: COMPRAS (lo que le facturaste / le debes) -->
            <section class="cq-side">
              <header class="cq-side-head cq-side-head--debe">
                <span class="cq-side-title"><i class="pi pi-arrow-up-right" aria-hidden="true"></i> Compras (facturado)</span>
                <span class="cq-side-total">{{ money(totalCompras()) }} <small>· {{ comprasMoves().length }}</small></span>
              </header>
              <p-table [value]="comprasMoves()" styleClass="p-datatable-sm surf-table cq-dt-table" [scrollable]="true" scrollHeight="46vh" [rowHover]="true">
                <ng-template #header>
                  <tr><th class="cq-w-date">Fecha</th><th class="cq-w-folio">Folio</th><th class="cq-w-suc">Suc</th><th class="ta-r cq-w-amt">Importe</th></tr>
                </ng-template>
                <ng-template #body let-m let-i="rowIndex">
                  <tr [class.cq-xhover]="hoverIdx() === i" (mouseenter)="hoverIdx.set(i)" (mouseleave)="hoverIdx.set(null)">
                    <td class="cq-mono">{{ m.fecha ? (m.fecha | date:'yyyy-MM-dd') : m.anio_mes }}</td>
                    <td class="cq-mono muted">{{ m.folio }}</td>
                    <td class="cq-mono muted">{{ m.sucursal }}</td>
                    <td class="ta-r cq-num cq-debe">{{ money(m.importe) }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="4" class="cq-empty">Sin compras en el periodo.</td></tr></ng-template>
              </p-table>
            </section>
            <!-- DERECHA: PAGOS Y CRÉDITOS (lo que ya cubriste) -->
            <section class="cq-side">
              <header class="cq-side-head cq-side-head--haber">
                <span class="cq-side-title"><i class="pi pi-arrow-down-left" aria-hidden="true"></i> Pagos y créditos</span>
                <span class="cq-side-total">{{ money(totalPagos()) }} <small>· {{ pagosMoves().length }}</small></span>
              </header>
              <p-table [value]="pagosMoves()" styleClass="p-datatable-sm surf-table cq-dt-table" [scrollable]="true" scrollHeight="46vh" [rowHover]="true">
                <ng-template #header>
                  <tr><th class="cq-w-date">Fecha</th><th class="cq-w-tipo">Tipo</th><th class="cq-w-folio">Folio</th><th class="ta-r cq-w-amt">Importe</th></tr>
                </ng-template>
                <ng-template #body let-m let-i="rowIndex">
                  <tr [class.cq-xhover]="hoverIdx() === i" (mouseenter)="hoverIdx.set(i)" (mouseleave)="hoverIdx.set(null)">
                    <td class="cq-mono">{{ m.fecha ? (m.fecha | date:'yyyy-MM-dd') : m.anio_mes }}</td>
                    <td><p-tag [value]="m.tipo_label" [severity]="tagSev(m.categoria)" styleClass="cq-tag" /></td>
                    <td class="cq-mono muted">{{ m.folio }}</td>
                    <td class="ta-r cq-num cq-haber">{{ money(m.importe) }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="4" class="cq-empty">Sin pagos ni créditos en el periodo.</td></tr></ng-template>
              </p-table>
            </section>
          </div>
          <!-- BALANCE: Compras − Pagos = lo que falta pagar -->
          <div class="cq-balance" [class.cq-balance--pend]="pendiente() > 0" [class.cq-balance--over]="pendiente() < 0">
            <div class="cq-bal-cell"><span class="cq-bal-lbl">Compras</span><span class="cq-bal-val">{{ money(totalCompras()) }}</span></div>
            <span class="cq-bal-op">−</span>
            <div class="cq-bal-cell"><span class="cq-bal-lbl">Pagos y créditos</span><span class="cq-bal-val">{{ money(totalPagos()) }}</span></div>
            <span class="cq-bal-op">=</span>
            <div class="cq-bal-cell cq-bal-res">
              <span class="cq-bal-lbl">{{ pendiente() > 0.5 ? 'Sin pagar (falta)' : pendiente() < -0.5 ? 'Pagado de más' : 'Cuadrado' }}</span>
              <span class="cq-bal-val">{{ money(absVal(pendiente())) }}</span>
            </div>
          </div>
          <p class="cq-dt-note">Cuenta-T de la <b>201 Proveedores</b> (Kepler). <b>Compras</b> = facturado (sube deuda) · <b>Pagos y créditos</b> = pagos, notas y devoluciones (bajan deuda). <b>Pendiente</b> = Compras − Pagos: lo no cubierto en el periodo (movimiento neto, sin saldo de apertura). Kepler <b>no liga factura↔pago 1:1</b>, así que el cuadre es por totales del periodo, no línea a línea.</p>
        }
      }
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cq-head-actions { display:flex; gap:.5rem; }
    .cq-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    .cq-search input { min-width:220px; }
    :host ::ng-deep .cq-sel { min-width:11rem; }
    .cq-table { margin-top:.6rem; }
    .cq-row { cursor:pointer; }
    .cq-row:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    .cq-drillhint { font-size:.72rem; color:var(--text-faint); margin-left:.35rem; }
    .ta-r { text-align:right; }
    .cq-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cq-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-faint); }
    .cq-strong { font-weight:700; }
    .cq-pos { color:var(--ok-fg); }
    .cq-up { color:var(--warn-fg); }
    .cq-down { color:var(--ok-fg); }
    .cq-w-amt { width:8.5rem; }
    .cq-w-date { width:6rem; } .cq-w-tipo { width:9.5rem; } .cq-w-folio { width:6rem; } .cq-w-suc { width:3.5rem; }
    .cq-prov { max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* desglose (dialog) */
    .cq-dt-kpis { display:flex; flex-wrap:wrap; gap:1rem; margin-bottom:.8rem; font-size:.8rem; color:var(--text-muted); }
    .cq-dt-kpis b { color:var(--text-main); font-family:var(--font-mono); margin-left:.2rem; }
    .cq-dt-table { font-size:.8rem; }
    .cq-dt-note { font-size:.72rem; color:var(--text-faint); margin-top:.6rem; line-height:1.5; }
    .cq-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    :host ::ng-deep .cq-tag { font-size:.64rem; }
    /* Cuenta-T: Compras (izquierda) | Pagos y créditos (derecha), alineados */
    .cq-tacct { display:grid; grid-template-columns:1fr 1fr; gap:1rem; align-items:start; }
    .cq-side { display:flex; flex-direction:column; min-width:0; border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; }
    .cq-side-head { display:flex; justify-content:space-between; align-items:center; gap:.5rem; padding:.5rem .7rem; font-size:.78rem; font-weight:600; border-bottom:2px solid var(--border-color); }
    .cq-side-head--debe { color:var(--warn-fg); border-bottom-color:var(--warn-fg); }
    .cq-side-head--haber { color:var(--ok-fg); border-bottom-color:var(--ok-fg); }
    .cq-side-title { display:inline-flex; align-items:center; gap:.35rem; }
    .cq-side-total { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .cq-side-total small { color:var(--text-faint); font-weight:400; }
    .cq-debe { color:var(--warn-fg); }
    .cq-haber { color:var(--ok-fg); }
    /* hover cruzado: subraya la fila alineada en AMBAS columnas (inset → sin shift de layout) */
    :host ::ng-deep tr.cq-xhover > td { background:color-mix(in srgb, var(--action) 10%, transparent); box-shadow:inset 0 -2px 0 var(--action); }
    .cq-balance { display:flex; align-items:stretch; gap:.6rem; margin-top:.9rem; padding:.7rem .9rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .cq-bal-cell { display:flex; flex-direction:column; gap:.15rem; flex:1; min-width:0; }
    .cq-bal-lbl { font-size:.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .cq-bal-val { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:700; }
    .cq-bal-op { align-self:center; color:var(--text-faint); font-family:var(--font-mono); font-size:1.1rem; }
    .cq-bal-res { border-left:1px solid var(--border-color); padding-left:.8rem; }
    .cq-balance--pend .cq-bal-res, .cq-balance--pend .cq-bal-res .cq-bal-lbl { color:var(--bad-fg); }
    .cq-balance--over .cq-bal-res, .cq-balance--over .cq-bal-res .cq-bal-lbl { color:var(--ok-fg); }
    @media (max-width:720px) { .cq-tacct { grid-template-columns:1fr; } }
    .cq-foot { margin-top:1.2rem; font-size:.74rem; color:var(--text-faint); line-height:1.55; }
    .cq-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--bad-border, var(--border-color)); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cq-errbox .pi { color:var(--bad-fg); }
    .cq-errbox-txt { flex:1; font-size:.84rem; color:var(--text-main); }
    .cq-empty-op { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .cq-empty-op .pi { font-size:1.6rem; color:var(--text-faint); }
    .cq-empty-op-title { font-weight:600; color:var(--text-main); }
    .cq-empty-op-sub { font-size:.84rem; color:var(--text-muted); max-width:32rem; }
    .cq-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1.2rem; padding:.3rem 0; }
    app-metric-strip { display:block; margin:.9rem 0; }
  `],
})
export class ComprasCuadreProveedorComponent implements OnInit {
  private readonly svc = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly data = signal<SupplierLedgerResponse | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly search = signal('');
  readonly dateFrom = signal<Date | null>(null);
  readonly dateTo = signal<Date | null>(null);
  readonly preset = signal<string>('');
  readonly presetOpts = DATE_PRESET_OPTIONS;
  private searchTimer: any;
  readonly skelRows = Array.from({ length: 8 });
  // Desglose (auxiliar 201) del proveedor seleccionado.
  readonly detail = signal<SupplierLedgerRow | null>(null);
  readonly moves = signal<SupplierLedgerMove[]>([]);
  readonly movesLoading = signal(false);
  readonly saldoFinal = signal(0);
  // Cuenta-T: compras (facturado, sube deuda) a la izquierda; pagos/notas/devoluciones (bajan) a la
  // derecha. `signed` > 0 = compra · < 0 = pago/crédito (lo escribe el backend por categoría).
  readonly comprasMoves = computed(() => this.moves().filter((m) => m.signed > 0));
  readonly pagosMoves = computed(() => this.moves().filter((m) => m.signed < 0));
  readonly totalCompras = computed(() => this.comprasMoves().reduce((s, m) => s + Math.abs(m.importe || 0), 0));
  readonly totalPagos = computed(() => this.pagosMoves().reduce((s, m) => s + Math.abs(m.importe || 0), 0));
  readonly pendiente = computed(() => this.totalCompras() - this.totalPagos());
  // Hover cruzado: al pasar por la fila i de un lado, se subraya la fila i del otro (alineadas por
  // posición) → ayuda a leer compra vs pago a la misma altura.
  readonly hoverIdx = signal<number | null>(null);

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    this.search.set(q.get('q') || '');
    this.dateFrom.set(this.fromIso(q.get('from')));
    this.dateTo.set(this.fromIso(q.get('to')));
    this.reload();
  }

  /** Date → 'YYYY-MM-DD' (local, sin correr por TZ). */
  private toIso(d: Date | null): string | undefined {
    if (!d) return undefined;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  /** 'YYYY-MM-DD' → Date (local). */
  private fromIso(s: string | null): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    this.svc.supplierLedger({ search: this.search() || undefined, date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.data.set(d); this.loading.set(false); },
        error: () => { this.loading.set(false); this.err.set('No se pudo cargar el cuadre por proveedor.'); },
      });
  }

  retry(): void { this.err.set(null); this.reload(); }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: this.search().trim() || null, from: this.toIso(this.dateFrom()) || null, to: this.toIso(this.dateTo()) || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.syncUrl(); this.reload(); }, 320);
  }

  onDate(which: 'from' | 'to', v: Date | null): void {
    (which === 'from' ? this.dateFrom : this.dateTo).set(v);
    this.preset.set(''); this.syncUrl(); this.reload();
  }

  onPreset(key: string | null): void {
    this.preset.set(key || '');
    const r = key ? datePresetRange(key) : null;
    if (!r) return;
    this.dateFrom.set(r.from); this.dateTo.set(r.to);
    this.syncUrl(); this.reload();
  }

  hasFilters(): boolean { return !!(this.search().trim() || this.dateFrom() || this.dateTo()); }

  clearFilters(): void {
    this.search.set(''); this.dateFrom.set(null); this.dateTo.set(null); this.preset.set('');
    this.syncUrl(); this.reload();
  }

  /** Abre el desglose (auxiliar 201) del proveedor, respetando el rango de fecha actual. */
  openDetail(r: SupplierLedgerRow): void {
    this.detail.set(r);
    this.moves.set([]); this.saldoFinal.set(0); this.movesLoading.set(true);
    this.svc.supplierLedgerDetail({ proveedor: r.proveedor || undefined, date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.moves.set(d.rows || []); this.saldoFinal.set(d.saldo_final || 0); this.movesLoading.set(false); },
        error: () => { this.movesLoading.set(false); },
      });
  }
  closeDetail(): void { this.detail.set(null); this.moves.set([]); }

  /** Color del tag por categoría del movimiento. */
  tagSev(cat: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return cat === 'facturado' ? 'warn' : cat === 'pagado' ? 'success' : cat === 'nota' ? 'info' : cat === 'devolucion' ? 'danger' : 'secondary';
  }

  kpiItems(d: SupplierLedgerResponse): MetricStripItem[] {
    return [
      { label: 'Facturado', value: d.totals.facturado, format: 'currency-short', tone: 'default', sub: `${d.total} proveedor(es)` },
      { label: 'Pagado', value: d.totals.pagado, format: 'currency-short', tone: 'ok' },
      { label: 'Notas de crédito', value: d.totals.notas, format: 'currency-short', tone: 'warn' },
      { label: 'Δ deuda (periodo)', value: d.totals.delta, format: 'currency-short', tone: 'brand' },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  absVal(n: number): number { return Math.abs(n || 0); }
}
