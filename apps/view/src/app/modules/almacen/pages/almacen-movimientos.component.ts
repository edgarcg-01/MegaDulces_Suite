import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import {
  AlmacenMovimientosService, MovementsFilters, MovementsSummary,
  AggregateRow, FolioRow, MovementsFilterOpts, DocumentResponse,
} from '../almacen-movimientos.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * DM.2 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Superficie Operations (denso, quiet-luxury). Diseño simple:
 *   - Vista principal AGRUPADA POR DÍA (tabla expandible). Abrís un día → sus documentos.
 *   - Al abrir un documento se muestra su contenido, la RELACIÓN con su contraparte
 *     (folio A ⇄ folio B, si existe) y el documento contraparte al lado, para validar
 *     que se entregó y se recibió correctamente antes de auditarlo.
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
          <p class="surf-page-sub">Movimientos de inventario por día. Abrí un día para ver sus documentos y auditarlos.</p>
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
        <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Estado (traspasos)" [showClear]="true" styleClass="dm-sel"></p-select>
        <span class="dm-search">
          <input pInputText type="text" [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="SKU o producto…" aria-label="Buscar por SKU o producto" />
        </span>
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="reload()" ariaLabel="Buscar"></button>
      </div>

      @if (error()) {
        <div class="dm-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" label="Reintentar" (click)="reload()"></button>
        </div>
      }

      <!-- Tabla por DÍA (expandible) -->
      <p-table [value]="days()" [loading]="loading()" dataKey="key" [expandedRowKeys]="expanded"
               (onRowExpand)="onDayExpand($event.data)" styleClass="p-datatable-sm dm-table" [scrollable]="true" scrollHeight="flex">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:2.5rem"></th>
            <th>Día</th>
            <th class="dm-r" style="width:6rem">Docs</th>
            <th class="dm-r" style="width:8rem">Entradas</th>
            <th class="dm-r" style="width:8rem">Salidas</th>
            <th class="dm-r" style="width:9rem">Valor</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-day let-expanded="expanded">
          <tr class="dm-day-row">
            <td><button type="button" pButton [pRowToggler]="day" class="p-button-text p-button-sm p-button-rounded"
                        [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"></button></td>
            <td class="dm-strong">{{ dayLabel(day.key) }}</td>
            <td class="dm-r dm-muted">{{ day.documentos | number }}</td>
            <td class="dm-r up">{{ day.entradas ? ('+' + (day.entradas | number:'1.0-0')) : '—' }}</td>
            <td class="dm-r down">{{ day.salidas ? ('−' + (absN(day.salidas) | number:'1.0-0')) : '—' }}</td>
            <td class="dm-r dm-strong">{{ money(day.valor || 0) }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="rowexpansion" let-day>
          <tr>
            <td colspan="6" class="dm-exp">
              @if (dayLoading()[day.key]) { <div class="dm-empty">Cargando documentos…</div> }
              @else {
                <table class="dm-docs">
                  <thead>
                    <tr><th>Tipo</th><th>Folio</th><th>Almacén</th><th class="dm-r">Líneas</th><th class="dm-r">Cantidad</th><th class="dm-r">Valor</th><th>Estado</th><th>Auditoría</th></tr>
                  </thead>
                  <tbody>
                    @for (l of dayDocs()[day.key]; track l.warehouse_id + l.doc_code + l.folio) {
                      <tr class="dm-row" (click)="openDocument(l)">
                        <td><p-tag [value]="l.movement_label" [severity]="l.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag></td>
                        <td class="dm-mono dm-link">{{ l.folio }}</td>
                        <td class="dm-mono dm-muted">{{ l.warehouse_code || l.source_branch }}</td>
                        <td class="dm-r dm-muted">{{ l.lineas | number }}</td>
                        <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0">{{ l.signed_qty | number:'1.0-0' }}</td>
                        <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
                        <td>
                          @if (l.transfer_status) {
                            <p-tag [value]="estadoLabel(l.transfer_status)" [severity]="estadoSev(l.transfer_status)" styleClass="dm-tag"></p-tag>
                          } @else { <span class="dm-muted">—</span> }
                        </td>
                        <td (click)="$event.stopPropagation()">
                          @if (l.audited) {
                            <button type="button" class="dm-audit is-audited" [disabled]="!canAudit" (click)="toggleAudit(l)"
                                    [title]="'Auditado por ' + (l.audited_by || '—') + (canAudit ? ' · clic para quitar' : '')">
                              <i class="pi pi-verified"></i> Auditado
                            </button>
                          } @else {
                            <button type="button" class="dm-audit-row-btn" [disabled]="!canAudit" (click)="toggleAudit(l)" title="Marcar como auditado">
                              <i class="pi pi-check"></i> Auditar
                            </button>
                          }
                        </td>
                      </tr>
                    } @empty { <tr><td colspan="8" class="dm-empty">Sin documentos.</td></tr> }
                  </tbody>
                </table>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="6" class="dm-empty">Sin movimientos en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Documento + relación + contraparte -->
    <p-dialog [(visible)]="docOpen" [modal]="true" [style]="{ width: cpDoc() ? '68rem' : '46rem', maxWidth: '96vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template pTemplate="header"><span class="dm-dlg-title">Documento {{ doc()?.header?.folio }}</span></ng-template>
      @if (docLoading()) { <div class="dm-empty">Cargando documento…</div> }
      @else if (docError()) {
        <div class="dm-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ docError() }}</span>
        </div>
      }
      @else {
        @if (doc()?.header; as h) {
          <!-- Relación con la contraparte -->
          @if (doc()!.counterpart; as cp) {
            <div class="dm-rel">
              <i class="pi pi-link"></i>
              <span class="dm-rel-doc" [class.rel-out]="h.movement_kind==='salida'" [class.rel-in]="h.movement_kind==='entrada'">
                Folio {{ h.folio }} · {{ h.warehouse_code || h.source_branch }} · {{ h.movement_kind === 'salida' ? 'salida' : 'entrada' }}
              </span>
              <i class="pi pi-arrows-h dm-rel-arrow"></i>
              @if (cp.docs.length) {
                <span class="dm-rel-doc" [class.rel-out]="cp.kind==='origen'" [class.rel-in]="cp.kind==='recepcion'">
                  Folio {{ cp.docs[0].folio }} · {{ cp.docs[0].warehouse_code || '—' }} · {{ cp.kind === 'recepcion' ? 'recepción' : 'origen' }}
                </span>
              } @else { <span class="dm-rel-none">{{ cp.status === 'sin_recepcion' ? 'sin recepción' : 'sin origen' }}</span> }
            </div>
            <!-- Validación -->
            <div class="dm-cp" [class.cp-ok]="cp.status === 'ok'" [class.cp-warn]="cp.status === 'diferencia'" [class.cp-bad]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'">
              <i class="pi" [class.pi-check-circle]="cp.status === 'ok'" [class.pi-exclamation-triangle]="cp.status === 'diferencia'" [class.pi-clock]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'"></i>
              <strong>{{ cpTitle(cp.status) }}</strong>
              <span>Enviadas {{ absN(doc()!.totals.qty) | number:'1.0-0' }} · Recibidas {{ cp.qty | number:'1.0-0' }}</span>
              @if (cp.status === 'diferencia') { <span class="dm-strong">Δ {{ cp.delta > 0 ? '+' : '' }}{{ cp.delta | number:'1.0-0' }} pzs</span> }
            </div>
          }

          <div class="dm-doc-head">
            <p-tag [value]="h.movement_label" [severity]="h.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag>
            <span class="dm-doc-meta">{{ h.doc_date | date:'yyyy-MM-dd' }}</span>
            <span class="dm-doc-meta">Almacén {{ h.warehouse_code || h.source_branch }}</span>
          </div>

          <!-- Documento + contraparte lado a lado -->
          <div class="dm-cols" [class.two]="cpDoc()">
            <div class="dm-col">
              <h4 class="dm-col-h">Folio {{ h.folio }} · {{ h.movement_kind === 'salida' ? 'salida' : 'entrada' }}</h4>
              <ng-container [ngTemplateOutlet]="linesTpl" [ngTemplateOutletContext]="{ lines: doc()!.lines, totals: doc()!.totals }"></ng-container>
            </div>
            @if (cpLoading()) { <div class="dm-col dm-empty">Cargando contraparte…</div> }
            @else if (cpDoc()) {
              @if (cpDoc()!.header; as ch) {
                <div class="dm-col">
                  <h4 class="dm-col-h">Contraparte — folio {{ ch.folio }} · {{ ch.movement_label }} ({{ ch.warehouse_code || ch.source_branch }})</h4>
                  <ng-container [ngTemplateOutlet]="linesTpl" [ngTemplateOutletContext]="{ lines: cpDoc()!.lines, totals: cpDoc()!.totals }"></ng-container>
                </div>
              }
            }
          </div>

          <!-- Auditar -->
          <div class="dm-audit-bar">
            @if (h.audited) {
              <span class="dm-audited-note"><i class="pi pi-verified"></i> Auditado por {{ h.audited_by || '—' }} · {{ h.audited_at | date:'yyyy-MM-dd HH:mm' }}</span>
              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" label="Quitar auditoría" [disabled]="!canAudit" (click)="toggleAuditDoc(h)"></button>
            } @else {
              <button pButton type="button" class="dm-audit-btn" icon="pi pi-check-circle" [label]="auditLabel(h)" [disabled]="!canAudit" (click)="toggleAuditDoc(h)"></button>
            }
          </div>
        } @else { <div class="dm-empty">Documento sin líneas.</div> }
      }
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
    .dm-table { font-size: .84rem; }
    .dm-day-row td { padding-top: .45rem; padding-bottom: .45rem; }
    .dm-r { text-align: right; font-variant-numeric: tabular-nums; }
    .up, .dm-r.up { color: var(--ok-fg); } .down, .dm-r.down { color: var(--bad-fg); }
    .dm-link { color: var(--action); }
    .dm-mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .dm-muted { color: var(--text-muted); }
    .dm-strong { font-weight: 700; }
    .dm-tag { font-size: .68rem; }
    .dm-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .dm-error { display: flex; align-items: center; gap: .5rem; font-size: .82rem; padding: .55rem .8rem; margin: .5rem 0; border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border); }
    .dm-error span { margin-right: auto; }
    /* documentos dentro del día */
    .dm-exp { padding: 0 !important; background: var(--surface-alt-bg, var(--card-bg)); }
    .dm-docs { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .dm-docs thead th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); padding: .4rem .75rem; }
    .dm-docs thead th.dm-r { text-align: right; }
    .dm-docs tbody td { padding: .35rem .75rem; border-top: 1px solid var(--border-color); }
    .dm-row { cursor: pointer; }
    .dm-row:hover td { background: var(--surface-hover-bg); }
    .dm-audit { display: inline-flex; align-items: center; gap: .3rem; font-size: .76rem; border: 0; background: none; font-family: inherit; cursor: pointer; padding: .15rem .4rem; border-radius: var(--r-sm); }
    .dm-audit.is-audited { color: var(--ok-fg); font-weight: 600; }
    .dm-audit:disabled { cursor: default; }
    .dm-audit:hover:not(:disabled) { background: var(--surface-hover-bg); }
    .dm-audit-row-btn { display: inline-flex; align-items: center; gap: .3rem; font-size: .74rem; font-family: inherit; cursor: pointer; padding: .2rem .55rem; border-radius: var(--r-sm); border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main); }
    .dm-audit-row-btn:hover:not(:disabled) { border-color: var(--ok-fg); color: var(--ok-fg); }
    .dm-audit-row-btn:disabled { cursor: default; opacity: .55; }
    /* Dialog */
    .dm-dlg-title { font-weight: 700; }
    .dm-rel { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .8rem; padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-sm); margin-bottom: .5rem; background: var(--card-bg); }
    .dm-rel-doc { padding: .1rem .45rem; border-radius: var(--r-sm); font-family: var(--font-mono, ui-monospace, monospace); font-size: .76rem; }
    .dm-rel-doc.rel-out { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .dm-rel-doc.rel-in { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .dm-rel-arrow { color: var(--text-muted); }
    .dm-rel-none { color: var(--bad-fg); font-weight: 600; }
    .dm-cp { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .8rem; padding: .5rem .7rem; border-radius: var(--r-sm); border: 1px solid var(--border-color); margin-bottom: .6rem; }
    .dm-cp.cp-ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .dm-cp.cp-warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .dm-cp.cp-bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .dm-doc-head { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; margin-bottom: .3rem; }
    .dm-doc-meta { font-size: .78rem; color: var(--text-muted); }
    .dm-cols { display: grid; grid-template-columns: 1fr; gap: 1rem; }
    .dm-cols.two { grid-template-columns: 1fr 1fr; }
    @media (max-width: 48rem) { .dm-cols.two { grid-template-columns: 1fr; } }
    .dm-col-h { margin: .3rem 0 .2rem; font-size: .74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
    .dm-dtable { font-size: .8rem; }
    .dm-dname { max-width: 13rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-col-foot { margin-top: .4rem; font-size: .74rem; color: var(--text-muted); }
    .dm-audit-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: .6rem; margin-top: 1rem; padding-top: .7rem; border-top: 1px solid var(--border-color); }
    .dm-audited-note { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; color: var(--ok-fg); margin-right: auto; }
    :host ::ng-deep .dm-audit-btn.p-button { background: var(--ok-fg); border-color: var(--ok-fg); }
  `],
})
export class AlmacenMovimientosComponent implements OnInit {
  private readonly api = inject(AlmacenMovimientosService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly canAudit = this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_SUPERVISAR];

  days = signal<AggregateRow[]>([]);
  summary = signal<MovementsSummary | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  expanded: Record<string, boolean> = {};
  dayDocs = signal<Record<string, FolioRow[]>>({});
  dayLoading = signal<Record<string, boolean>>({});

  warehouseOpts = signal<{ label: string; value: string }[]>([]);
  docTypeOpts = signal<{ label: string; value: string }[]>([]);

  fWarehouses: string[] = [];
  fFrom: Date | null = null;
  fTo: Date | null = null;
  fKind: '' | 'entrada' | 'salida' = '';
  fDocCode = '';
  fSearch = '';
  fEstado: '' | 'en_transito' | 'completado' | 'diferencia' = '';

  kindOpts = [
    { label: 'Todo', value: '' },
    { label: 'Entradas', value: 'entrada' },
    { label: 'Salidas', value: 'salida' },
  ];
  estadoOpts = [
    { label: 'En tránsito', value: 'en_transito' },
    { label: 'Completado', value: 'completado' },
    { label: 'Con diferencia', value: 'diferencia' },
  ];

  // Documento + contraparte
  docOpen = false;
  docLoading = signal(false);
  docError = signal<string | null>(null);
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
      estado: this.fEstado || undefined,
    };
  }

  reload(): void {
    // limpiar expansión/caché al cambiar filtros
    this.expanded = {};
    this.dayDocs.set({});
    this.loading.set(true);
    this.error.set(null);
    this.api.aggregate(this.currentFilters(), 'day', 1, 200).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const rows = [...r.rows].sort((a, b) => (b.key > a.key ? 1 : b.key < a.key ? -1 : 0));
        this.days.set(rows); this.loading.set(false);
      },
      error: () => { this.days.set([]); this.loading.set(false); this.error.set('No se pudieron cargar los movimientos. Revisá la conexión e intentá de nuevo.'); },
    });
    this.api.summary(this.currentFilters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => this.summary.set(s));
  }

  /** Al expandir un día, carga sus documentos (lazy, cacheado). */
  onDayExpand(day: AggregateRow): void {
    const key = day.key;
    if (this.dayDocs()[key]) return;
    this.dayLoading.set({ ...this.dayLoading(), [key]: true });
    const d = key.slice(0, 10);
    this.api.lines({ ...this.currentFilters(), from: d, to: d }, { page: 1, pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.dayDocs.set({ ...this.dayDocs(), [key]: r.rows as FolioRow[] });
          this.dayLoading.set({ ...this.dayLoading(), [key]: false });
        },
        error: () => { this.dayLoading.set({ ...this.dayLoading(), [key]: false }); },
      });
  }

  /** Abre el documento; si es traspaso, carga TAMBIÉN la contraparte para validar. */
  openDocument(l: FolioRow): void {
    this.docOpen = true;
    this.docLoading.set(true);
    this.docError.set(null);
    this.doc.set(null);
    this.cpDoc.set(null);
    this.api.document(l.folio, l.warehouse_id, l.doc_code, l.doc_serie).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.doc.set(d); this.docLoading.set(false); this.loadCounterpart(d); },
      error: () => { this.doc.set(null); this.docLoading.set(false); this.docError.set('No se pudo cargar el documento. Intentá de nuevo.'); },
    });
  }

  private loadCounterpart(d: DocumentResponse): void {
    const first = d.counterpart?.docs?.[0];
    if (!first) { this.cpDoc.set(null); return; }
    this.cpLoading.set(true);
    this.api.document(first.folio, first.warehouse_id, first.doc_code, first.doc_serie)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (c) => { this.cpDoc.set(c); this.cpLoading.set(false); },
        error: () => { this.cpDoc.set(null); this.cpLoading.set(false); },
      });
  }

  auditLabel(h: NonNullable<DocumentResponse['header']>): string {
    const cpFolio = this.cpDoc()?.header?.folio;
    return cpFolio ? `Auditar ${h.folio} ↔ ${cpFolio}` : `Auditar documento ${h.folio}`;
  }

  estadoLabel(s: string): string {
    return s === 'en_transito' ? 'En tránsito' : s === 'completado' ? 'Completado' : 'Diferencia';
  }
  estadoSev(s: string): 'success' | 'warn' | 'danger' | 'info' {
    return s === 'completado' ? 'success' : s === 'en_transito' ? 'info' : 'danger';
  }

  /** DM.4 — botón Auditar por fila (optimistic). */
  toggleAudit(l: FolioRow): void {
    if (!this.canAudit) return;
    const next = !l.audited;
    l.audited = next;
    this.dayDocs.set({ ...this.dayDocs() });
    this.api.setAudit({ warehouse_id: l.warehouse_id, doc_code: l.doc_code, doc_serie: l.doc_serie, folio: l.folio, audited: next })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { l.audited_by = r.audited_by ?? null; this.dayDocs.set({ ...this.dayDocs() }); },
        error: () => { l.audited = !next; this.dayDocs.set({ ...this.dayDocs() }); },
      });
  }

  toggleAuditDoc(h: NonNullable<DocumentResponse['header']>): void {
    if (!this.canAudit) return;
    const next = !h.audited;
    h.audited = next;
    this.doc.set({ ...this.doc()! });
    this.api.setAudit({ warehouse_id: h.warehouse_id, doc_code: h.doc_code, doc_serie: h.doc_serie, folio: h.folio, audited: next })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { h.audited_by = r.audited_by ?? null; this.doc.set({ ...this.doc()! }); this.syncRowAudit(h, next, r.audited_by ?? null); },
        error: () => { h.audited = !next; this.doc.set({ ...this.doc()! }); },
      });
  }

  /** Refleja el estado auditado en la fila del día cacheado. */
  private syncRowAudit(h: NonNullable<DocumentResponse['header']>, audited: boolean, by: string | null): void {
    const cache = this.dayDocs();
    for (const key of Object.keys(cache)) {
      const row = cache[key].find((r) => r.folio === h.folio && r.warehouse_id === h.warehouse_id && r.doc_code === h.doc_code);
      if (row) { row.audited = audited; row.audited_by = by; this.dayDocs.set({ ...cache }); return; }
    }
  }

  cpTitle(s: string): string {
    return s === 'ok' ? 'Recibido correctamente' : s === 'diferencia' ? 'Diferencia entre lo enviado y recibido'
      : s === 'sin_recepcion' ? 'Sin recepción registrada (en tránsito o no recibido)' : 'Recepción sin origen visible';
  }
  dayLabel(key: string): string {
    return (key || '').slice(0, 10);
  }
  absN(v: number | string): number { return Math.abs(Number(v ?? 0) || 0); }
  /** Postgres numeric llega como STRING por JSON; sin Number() el toLocaleString de string
   *  ignora las opciones de currency y sale sin "$" ni comas. */
  money(v: number | string | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
