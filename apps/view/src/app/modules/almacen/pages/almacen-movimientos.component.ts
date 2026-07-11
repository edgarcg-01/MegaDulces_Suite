import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import {
  AlmacenMovimientosService, MovementsFilters, MovementsSummary,
  FolioRow, MovementsFilterOpts, DocumentResponse,
} from '../almacen-movimientos.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * DM.2 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Superficie Operations (denso, quiet-luxury). Diseño: **lista de documentos**
 * (folios englobados) para auditar. Al abrir un documento se muestra su contenido
 * y —si es traspaso— el documento CONTRAPARTE al lado, para validar que se entregó
 * y se recibió correctamente antes de marcarlo auditado.
 */
@Component({
  selector: 'app-almacen-movimientos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, MultiSelectModule, DatePickerModule, DialogModule, TagModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in dm-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Diario de movimientos</h1>
          <p class="surf-page-sub">Documentos de entrada y salida de inventario. Clic en uno para revisarlo y auditarlo.</p>
        </div>
        @if (summary(); as s) {
          <div class="dm-strip">
            <span class="up">+{{ s.totals.entradas | number:'1.0-0' }}</span> entradas ·
            <span class="down">−{{ absN(s.totals.salidas) | number:'1.0-0' }}</span> salidas ·
            <span class="dm-strong">{{ money(s.totals.valor) }}</span> · {{ s.totals.documentos | number }} docs
          </div>
        }
      </header>

      <!-- Filtros -->
      <div class="dm-filters">
        <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="fWarehouses" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="dm-sel"></p-multiSelect>
        <p-datepicker [(ngModel)]="fFrom" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-datepicker [(ngModel)]="fTo" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todo" styleClass="dm-sel-sm"></p-select>
        <p-select [options]="docTypeOpts()" [(ngModel)]="fDocCode" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Tipo de documento" [showClear]="true" styleClass="dm-sel"></p-select>
        <span class="dm-search">
          <input pInputText type="text" [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="SKU o producto…" />
        </span>
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="reload()" ariaLabel="Buscar"></button>
      </div>

      <!-- Lista de documentos -->
      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm dm-table" [rowsPerPageOptions]="[50, 100, 200]" [rowHover]="true">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:6.5rem">Fecha</th>
            <th>Tipo</th>
            <th style="width:6rem">Folio</th>
            <th style="width:5rem">Almacén</th>
            <th class="dm-r" style="width:5rem">Líneas</th>
            <th class="dm-r" style="width:7rem">Cantidad</th>
            <th class="dm-r" style="width:8rem">Valor</th>
            <th style="width:6rem">Auditado</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-l>
          <tr class="dm-row" (click)="openDocument(l)">
            <td class="dm-mono">{{ l.doc_date | date:'yyyy-MM-dd' }}</td>
            <td><p-tag [value]="l.movement_label" [severity]="l.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag></td>
            <td class="dm-mono dm-link">{{ l.folio }}</td>
            <td class="dm-mono dm-muted">{{ l.warehouse_code || l.source_branch }}</td>
            <td class="dm-r dm-muted">{{ l.lineas | number }}</td>
            <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0">{{ l.signed_qty | number:'1.0-0' }}</td>
            <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
            <td (click)="$event.stopPropagation()">
              <button type="button" class="dm-audit" [class.is-audited]="l.audited" [disabled]="!canAudit" (click)="toggleAudit(l)"
                      [title]="l.audited ? ('Auditado por ' + (l.audited_by || '—')) : (canAudit ? 'Marcar auditado' : 'Sin auditar')">
                <i class="pi" [class.pi-verified]="l.audited" [class.pi-circle]="!l.audited"></i> {{ l.audited ? 'Sí' : 'No' }}
              </button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="dm-empty">Sin documentos en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Documento + contraparte -->
    <p-dialog [(visible)]="docOpen" [modal]="true" [style]="{ width: cpDoc() ? '68rem' : '46rem', maxWidth: '96vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template pTemplate="header">
        <span class="dm-dlg-title">Documento {{ doc()?.header?.folio }}</span>
      </ng-template>
      @if (docLoading()) { <div class="dm-empty">Cargando documento…</div> }
      @else if (doc()?.header; as h) {
        <!-- Validación de la contraparte (traspasos) -->
        @if (doc()!.counterpart; as cp) {
          <div class="dm-cp" [class.cp-ok]="cp.status === 'ok'" [class.cp-warn]="cp.status === 'diferencia'" [class.cp-bad]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'">
            <i class="pi" [class.pi-check-circle]="cp.status === 'ok'" [class.pi-exclamation-triangle]="cp.status === 'diferencia'" [class.pi-clock]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'"></i>
            <strong>{{ cpTitle(cp.status) }}</strong>
            <span>Enviadas {{ absN(doc()!.totals.qty) | number:'1.0-0' }} · Recibidas {{ cp.qty | number:'1.0-0' }}</span>
            @if (cp.status === 'diferencia') { <span class="dm-strong">Δ {{ cp.delta > 0 ? '+' : '' }}{{ cp.delta | number:'1.0-0' }} pzs</span> }
          </div>
        }

        <!-- Header + botón auditar -->
        <div class="dm-doc-head">
          <p-tag [value]="h.movement_label" [severity]="h.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag>
          <span class="dm-doc-meta">{{ h.doc_date | date:'yyyy-MM-dd' }}</span>
          <span class="dm-doc-meta">Almacén {{ h.warehouse_code || h.source_branch }}</span>
          <button pButton type="button" class="p-button-sm dm-doc-audit" [class.p-button-success]="h.audited" [class.p-button-outlined]="!h.audited"
                  [icon]="h.audited ? 'pi pi-verified' : 'pi pi-check'" [label]="h.audited ? 'Auditado' : 'Marcar auditado'"
                  [disabled]="!canAudit" (click)="toggleAuditDoc(h)"></button>
        </div>
        @if (h.audited && h.audited_by) { <p class="dm-audit-by">Auditado por {{ h.audited_by }} · {{ h.audited_at | date:'yyyy-MM-dd HH:mm' }}</p> }

        <!-- Documento + contraparte lado a lado -->
        <div class="dm-cols" [class.two]="cpDoc()">
          <div class="dm-col">
            <h4 class="dm-col-h">{{ h.movement_kind === 'salida' ? 'Este documento (salida)' : 'Este documento' }}</h4>
            <ng-container [ngTemplateOutlet]="linesTpl" [ngTemplateOutletContext]="{ lines: doc()!.lines, totals: doc()!.totals }"></ng-container>
          </div>
          @if (cpLoading()) { <div class="dm-col dm-empty">Cargando contraparte…</div> }
          @else if (cpDoc()?.header; as ch) {
            <div class="dm-col">
              <h4 class="dm-col-h">Contraparte — {{ ch.movement_label }} · folio {{ ch.folio }} ({{ ch.warehouse_code || ch.source_branch }})</h4>
              <ng-container [ngTemplateOutlet]="linesTpl" [ngTemplateOutletContext]="{ lines: cpDoc()!.lines, totals: cpDoc()!.totals }"></ng-container>
            </div>
          }
        </div>
      } @else { <div class="dm-empty">Documento sin líneas.</div> }
    </p-dialog>

    <!-- Tabla de líneas reutilizable -->
    <ng-template #linesTpl let-lines="lines" let-totals="totals">
      <p-table [value]="lines" styleClass="p-datatable-sm dm-dtable" [scrollable]="true" scrollHeight="20rem">
        <ng-template pTemplate="header">
          <tr><th>SKU</th><th>Producto</th><th class="dm-r">Cant.</th><th class="dm-r">Importe</th></tr>
        </ng-template>
        <ng-template pTemplate="body" let-l>
          <tr>
            <td class="dm-mono">{{ l.sku }}</td>
            <td class="dm-dname" [title]="l.product_name">{{ l.product_name || '—' }}</td>
            <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0">{{ l.signed_qty | number:'1.0-0' }}</td>
            <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
          </tr>
        </ng-template>
      </p-table>
      <div class="dm-col-foot">{{ totals.lineas | number }} líneas · Neto <strong [class.up]="totals.qty>0" [class.down]="totals.qty<0">{{ totals.qty | number:'1.0-0' }}</strong> · {{ money(totals.amount) }}</div>
    </ng-template>
  `,
  styles: [`
    :host { display: block; }
    .dm-strip { font-size: .82rem; color: var(--text-muted); white-space: nowrap; }
    .dm-strip .up { color: var(--ok-fg); font-weight: 600; } .dm-strip .down { color: var(--bad-fg); font-weight: 600; }
    .dm-strip .dm-strong { color: var(--text-main); font-weight: 700; }
    .dm-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .75rem 0; }
    .dm-sel { min-width: 12rem; } .dm-sel-sm { min-width: 8rem; } .dm-date { min-width: 9rem; } .dm-search input { min-width: 12rem; }
    .dm-table { font-size: .82rem; }
    .dm-row { cursor: pointer; }
    .dm-r { text-align: right; font-variant-numeric: tabular-nums; }
    .up, .dm-r.up { color: var(--ok-fg); } .down, .dm-r.down { color: var(--bad-fg); }
    .dm-link { color: var(--action); }
    .dm-mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .dm-muted { color: var(--text-muted); }
    .dm-strong { font-weight: 700; }
    .dm-tag { font-size: .68rem; }
    .dm-empty { color: var(--text-muted); padding: 1.2rem; text-align: center; }
    .dm-audit { display: inline-flex; align-items: center; gap: .3rem; border: 0; background: none; font: inherit; font-size: .76rem; color: var(--text-muted); cursor: pointer; padding: .15rem .4rem; border-radius: var(--r-sm); }
    .dm-audit:hover:not(:disabled) { background: var(--surface-hover-bg); color: var(--text-main); }
    .dm-audit:disabled { cursor: default; opacity: .8; }
    .dm-audit.is-audited { color: var(--ok-fg); font-weight: 600; }
    /* Dialog */
    .dm-dlg-title { font-weight: 700; }
    .dm-cp { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .8rem; padding: .5rem .7rem; border-radius: var(--r-sm); border: 1px solid var(--border-color); margin-bottom: .6rem; }
    .dm-cp.cp-ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .dm-cp.cp-warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .dm-cp.cp-bad { color: var(--bad-fg); background: var(--card-bg); }
    .dm-doc-head { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; margin-bottom: .3rem; }
    .dm-doc-meta { font-size: .78rem; color: var(--text-muted); }
    .dm-doc-audit { margin-left: auto; }
    .dm-audit-by { font-size: .72rem; color: var(--text-muted); margin: 0 0 .5rem; }
    .dm-cols { display: grid; grid-template-columns: 1fr; gap: 1rem; }
    .dm-cols.two { grid-template-columns: 1fr 1fr; }
    @media (max-width: 48rem) { .dm-cols.two { grid-template-columns: 1fr; } }
    .dm-col-h { margin: .3rem 0 .2rem; font-size: .74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
    .dm-dtable { font-size: .8rem; }
    .dm-dname { max-width: 13rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-col-foot { margin-top: .4rem; font-size: .74rem; color: var(--text-muted); }
  `],
})
export class AlmacenMovimientosComponent implements OnInit {
  private readonly api = inject(AlmacenMovimientosService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** DM.4 — marcar auditado exige supervisión de inventario. */
  readonly canAudit = this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_SUPERVISAR];

  readonly pageSize = 50;
  rows = signal<FolioRow[]>([]);
  total = signal(0);
  summary = signal<MovementsSummary | null>(null);
  loading = signal(false);
  page = signal(1);

  warehouseOpts = signal<{ label: string; value: string }[]>([]);
  docTypeOpts = signal<{ label: string; value: string }[]>([]);

  fWarehouses: string[] = [];
  fFrom: Date | null = null;
  fTo: Date | null = null;
  fKind: '' | 'entrada' | 'salida' = '';
  fDocCode = '';
  fSearch = '';

  kindOpts = [
    { label: 'Todo', value: '' },
    { label: 'Entradas', value: 'entrada' },
    { label: 'Salidas', value: 'salida' },
  ];

  // Documento + contraparte
  docOpen = false;
  docLoading = signal(false);
  doc = signal<DocumentResponse | null>(null);
  cpLoading = signal(false);
  cpDoc = signal<DocumentResponse | null>(null);

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((f: MovementsFilterOpts) => {
      this.warehouseOpts.set(f.warehouses.filter(w => w.code).map(w => ({ label: `${w.code} — ${w.name}`, value: w.id })));
      this.docTypeOpts.set(f.doc_types.map(d => ({ label: d.movement_label, value: d.doc_code })));
    });
    this.reload();
  }

  private currentFilters(): MovementsFilters {
    return {
      warehouse_ids: this.fWarehouses,
      from: this.fFrom ? this.iso(this.fFrom) : undefined,
      to: this.fTo ? this.iso(this.fTo) : undefined,
      movement_kind: this.fKind,
      doc_code: this.fDocCode || undefined,
      search: this.fSearch || undefined,
    };
  }

  reload(): void {
    this.page.set(1);
    this.load();
    this.api.summary(this.currentFilters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => this.summary.set(s));
  }

  private load(): void {
    this.loading.set(true);
    this.api.lines(this.currentFilters(), { page: this.page(), pageSize: this.pageSize })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rows.set(r.rows as FolioRow[]); this.total.set(r.total); this.loading.set(false); },
        error: () => { this.rows.set([]); this.total.set(0); this.loading.set(false); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    this.page.set(Math.floor((e.first || 0) / (e.rows || this.pageSize)) + 1);
    this.load();
  }

  /** Abre el documento; si es traspaso, carga TAMBIÉN la contraparte para validar. */
  openDocument(l: FolioRow): void {
    this.docOpen = true;
    this.docLoading.set(true);
    this.doc.set(null);
    this.cpDoc.set(null);
    this.api.document(l.folio, l.warehouse_id, l.doc_code, l.doc_serie).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.doc.set(d); this.docLoading.set(false); this.loadCounterpart(d); },
      error: () => { this.doc.set({ header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 }, counterpart: null }); this.docLoading.set(false); },
    });
  }

  /** DM.3 — carga el documento de la contraparte (recepción/origen del traspaso). */
  private loadCounterpart(d: DocumentResponse): void {
    const cp = d.counterpart;
    const first = cp?.docs?.[0];
    if (!first) { this.cpDoc.set(null); return; }
    this.cpLoading.set(true);
    this.api.document(first.folio, first.warehouse_id, first.doc_code, first.doc_serie)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (c) => { this.cpDoc.set(c); this.cpLoading.set(false); },
        error: () => { this.cpDoc.set(null); this.cpLoading.set(false); },
      });
  }

  /** DM.4 — toggle auditado desde la fila (optimistic). */
  toggleAudit(l: FolioRow): void {
    if (!this.canAudit) return;
    const next = !l.audited;
    l.audited = next;
    this.rows.set([...this.rows()]);
    this.api.setAudit({ warehouse_id: l.warehouse_id, doc_code: l.doc_code, doc_serie: l.doc_serie, folio: l.folio, audited: next })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { l.audited_by = r.audited_by ?? null; this.rows.set([...this.rows()]); },
        error: () => { l.audited = !next; this.rows.set([...this.rows()]); },
      });
  }

  /** DM.4 — toggle auditado desde el diálogo. */
  toggleAuditDoc(h: NonNullable<DocumentResponse['header']>): void {
    if (!this.canAudit) return;
    const next = !h.audited;
    h.audited = next;
    this.doc.set({ ...this.doc()! });
    this.api.setAudit({ warehouse_id: h.warehouse_id, doc_code: h.doc_code, doc_serie: h.doc_serie, folio: h.folio, audited: next })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { h.audited_by = r.audited_by ?? null; this.doc.set({ ...this.doc()! }); this.syncRowAudit(h.folio, next, r.audited_by ?? null); },
        error: () => { h.audited = !next; this.doc.set({ ...this.doc()! }); },
      });
  }

  private syncRowAudit(folio: string, audited: boolean, by: string | null): void {
    const row = this.rows().find((r) => r.folio === folio);
    if (row) { row.audited = audited; row.audited_by = by; this.rows.set([...this.rows()]); }
  }

  cpTitle(s: string): string {
    return s === 'ok' ? 'Recibido correctamente' : s === 'diferencia' ? 'Diferencia entre lo enviado y recibido'
      : s === 'sin_recepcion' ? 'Sin recepción registrada (en tránsito o no recibido)' : 'Recepción sin origen visible';
  }

  absN(v: number): number { return Math.abs(v || 0); }
  money(v: number): string {
    return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
