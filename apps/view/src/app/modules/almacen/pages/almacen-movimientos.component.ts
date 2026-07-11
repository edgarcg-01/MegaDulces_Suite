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
  AlmacenMovimientosService, GroupBy, MovementsFilters, MovementsSummary, MovementByType,
  AggregateRow, FolioRow, MovementsFilterOpts, DocumentResponse, TransfersCheckResponse, TransferStatus,
} from '../almacen-movimientos.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * DM.2 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Superficie Operations (PrimeNG denso, quiet-luxury). Diseño rector:
 * **agregación primero, folio a folio bajo demanda**. La tabla arranca agrupada
 * (producto por default; re-agrupable por tipo/día/almacén); un click en la fila
 * abre el drill con los folios individuales de esa rama.
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
          <p class="surf-page-sub">Entradas y salidas de inventario. Vista agregada; clic en una fila para ver los folios.</p>
        </div>
      </header>

      <!-- KPIs -->
      @if (summary(); as s) {
        <div class="dm-kpis">
          <div class="dm-kpi"><span class="dm-kpi-val up">+{{ s.totals.entradas | number:'1.0-0' }}</span><span class="dm-kpi-lbl">Entradas</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val down">−{{ absN(s.totals.salidas) | number:'1.0-0' }}</span><span class="dm-kpi-lbl">Salidas</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val" [class.up]="s.totals.neto>=0" [class.down]="s.totals.neto<0">{{ s.totals.neto | number:'1.0-0' }}</span><span class="dm-kpi-lbl">Neto</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val">{{ money(s.totals.valor) }}</span><span class="dm-kpi-lbl">Valor movido</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val">{{ s.totals.documentos | number }}</span><span class="dm-kpi-lbl">Documentos</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val">{{ s.totals.lineas | number }}</span><span class="dm-kpi-lbl">Líneas</span></div>
        </div>

        <!-- Entradas vs Salidas por tipo de documento (clic = filtrar) -->
        <div class="dm-types">
          <div class="dm-types-col">
            <h3 class="dm-types-h up">Entradas</h3>
            @for (t of typesOf(s, 'entrada'); track t.doc_code) {
              <button type="button" class="dm-type-row" [class.active]="fDocCode === t.doc_code" (click)="toggleType(t.doc_code)">
                <span class="dm-type-lbl">{{ t.movement_label }}</span>
                <span class="dm-type-num">+{{ t.piezas | number:'1.0-0' }} pzs</span>
                <span class="dm-type-val">{{ money(t.valor || 0) }}</span>
              </button>
            } @empty { <span class="dm-empty-sm">Sin entradas en el rango.</span> }
          </div>
          <div class="dm-types-col">
            <h3 class="dm-types-h down">Salidas</h3>
            @for (t of typesOf(s, 'salida'); track t.doc_code) {
              <button type="button" class="dm-type-row" [class.active]="fDocCode === t.doc_code" (click)="toggleType(t.doc_code)">
                <span class="dm-type-lbl">{{ t.movement_label }}</span>
                <span class="dm-type-num">−{{ t.piezas | number:'1.0-0' }} pzs</span>
                <span class="dm-type-val">{{ money(t.valor || 0) }}</span>
              </button>
            } @empty { <span class="dm-empty-sm">Sin salidas en el rango.</span> }
          </div>
        </div>
      }

      <!-- DM.3 — validación de traspasos: cada salida contra su recepción -->
      @if (transfers(); as tc) {
        <button type="button" class="dm-transfers" (click)="transfersOpen = true">
          <span class="dm-tr-title">Traspasos</span>
          <span class="dm-tr-chip ok">✓ {{ tc.totals.ok }} recibidos</span>
          @if (tc.totals.diferencia) { <span class="dm-tr-chip warn">≠ {{ tc.totals.diferencia }} con diferencia</span> }
          @if (tc.totals.sin_recepcion) { <span class="dm-tr-chip bad">⏳ {{ tc.totals.sin_recepcion }} sin recepción</span> }
          @if (tc.totals.sin_origen) { <span class="dm-tr-chip bad">? {{ tc.totals.sin_origen }} sin origen</span> }
          <span class="dm-tr-more">Ver detalle <i class="pi pi-angle-right"></i></span>
        </button>
      }

      <!-- Filtros -->
      <div class="dm-filters">
        <p-select [options]="groupOpts" [(ngModel)]="fGroup" (onChange)="reload()"
                  optionLabel="label" optionValue="value" styleClass="dm-sel" placeholder="Agrupar por"></p-select>
        <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="fWarehouses" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="dm-sel"></p-multiSelect>
        <p-datepicker [(ngModel)]="fFrom" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-datepicker [(ngModel)]="fTo" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Dirección" [showClear]="true" styleClass="dm-sel-sm"></p-select>
        <p-select [options]="docTypeOpts()" [(ngModel)]="fDocCode" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Tipo de documento" [showClear]="true" styleClass="dm-sel"></p-select>
        <span class="dm-search">
          <input pInputText type="text" [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="SKU o producto…" />
        </span>
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="reload()" ariaLabel="Buscar"></button>
      </div>

      <!-- Tabla agregada (DEFAULT) -->
      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm dm-table" [rowsPerPageOptions]="[50, 100, 200]"
               [rowHover]="true" (onRowSelect)="drill($event.data)" selectionMode="single">
        <ng-template pTemplate="header">
          <tr>
            <th>{{ groupHeader() }}</th>
            <th class="dm-r">Entradas</th>
            <th class="dm-r">Salidas</th>
            <th class="dm-r">Neto</th>
            <th class="dm-r">Valor</th>
            <th class="dm-r">Docs</th>
            <th style="width:2.2rem"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr class="dm-row" (click)="drill(r)">
            <td>
              <span class="dm-label">{{ rowLabel(r) }}</span>
              @if (fGroup === 'product' && r.sku) { <span class="dm-sub dm-mono">{{ r.sku }}</span> }
              @if (fGroup === 'doc_code') { <p-tag [value]="r.movement_kind === 'entrada' ? 'entrada' : 'salida'" [severity]="r.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag> }
              @if (fGroup === 'warehouse' && r.code) { <span class="dm-sub dm-mono">{{ r.code }}</span> }
            </td>
            <td class="dm-r up">{{ r.entradas ? ('+' + (r.entradas | number:'1.0-0')) : '—' }}</td>
            <td class="dm-r down">{{ r.salidas ? ('−' + (absN(r.salidas) | number:'1.0-0')) : '—' }}</td>
            <td class="dm-r" [class.up]="r.neto>0" [class.down]="r.neto<0">{{ r.neto | number:'1.0-0' }}</td>
            <td class="dm-r dm-strong">{{ money(r.valor || 0) }}</td>
            <td class="dm-r dm-muted">{{ r.documentos | number }}</td>
            <td class="dm-r"><i class="pi pi-angle-right dm-muted"></i></td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7" class="dm-empty">Sin movimientos en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Drill: folios de la rama seleccionada -->
    <p-dialog [(visible)]="drillOpen" [modal]="true" [style]="{ width: '52rem', maxWidth: '95vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template pTemplate="header"><span class="dm-dlg-title">{{ drillTitle() }}</span></ng-template>
      @if (drillLoading()) { <div class="dm-empty">Cargando folios…</div> }
      @else if (!drillLines().length) { <div class="dm-empty">Sin folios.</div> }
      @else {
        <p-table [value]="drillLines()" styleClass="p-datatable-sm dm-dtable" [scrollable]="true" scrollHeight="26rem">
          <ng-template pTemplate="header">
            <tr>
              <th>Fecha</th><th>Folio</th><th>Tipo</th>
              <th class="dm-r">Líneas</th><th class="dm-r">Cantidad</th><th class="dm-r">Valor</th><th>Cadena</th><th>Auditado</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr class="dm-row" (click)="openDocument(l)" title="Ver el documento completo">
              <td class="dm-mono">{{ l.doc_date | date:'yyyy-MM-dd' }}</td>
              <td class="dm-mono dm-link">{{ l.folio }}</td>
              <td><p-tag [value]="l.movement_label" [severity]="l.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag></td>
              <td class="dm-r dm-muted">{{ l.lineas | number }}</td>
              <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0">{{ l.signed_qty | number:'1.0-0' }}</td>
              <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
              <td class="dm-sub dm-mono">{{ l.parent_folio ? (l.parent_group + '·' + l.parent_folio) : '—' }}</td>
              <td (click)="$event.stopPropagation()">
                @if (l.audited) {
                  <button type="button" class="dm-audit is-audited" [title]="'Auditado por ' + (l.audited_by || '—') + ' · ' + (l.audited_at | date:'yyyy-MM-dd HH:mm')"
                          [disabled]="!canAudit" (click)="toggleAudit(l)"><i class="pi pi-verified"></i> Sí</button>
                } @else {
                  <button type="button" class="dm-audit" [title]="canAudit ? 'Marcar como auditado' : 'Sin auditar'"
                          [disabled]="!canAudit" (click)="toggleAudit(l)"><i class="pi pi-circle"></i> No</button>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
        <p class="dm-dlg-foot">{{ drillTotal() | number }} documentos · sucursal {{ drillLines()[0].source_branch }} · clic en un folio para desglosarlo</p>
      }
    </p-dialog>

    <!-- Drill 3: documento completo (todas las líneas del folio) -->
    <p-dialog [(visible)]="docOpen" [modal]="true" [style]="{ width: '46rem', maxWidth: '95vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template pTemplate="header"><span class="dm-dlg-title">Documento {{ doc()?.header?.folio }}</span></ng-template>
      @if (docLoading()) { <div class="dm-empty">Cargando documento…</div> }
      @else if (doc()) {
        @if (doc()!.header; as h) {
          <div class="dm-doc-head">
            <p-tag [value]="h.movement_label" [severity]="h.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag>
            <span class="dm-doc-meta">{{ h.doc_date | date:'yyyy-MM-dd' }}</span>
            <span class="dm-doc-meta dm-mono">{{ h.genero }}{{ h.naturaleza }}{{ h.doc_type }}{{ h.doc_serie ? '·s' + h.doc_serie : '' }} · folio {{ h.folio }}</span>
            <span class="dm-doc-meta">Almacén {{ h.warehouse_code || h.source_branch }}</span>
            @if (h.parent_folio) { <span class="dm-doc-meta dm-mono">cadena → {{ h.parent_group }}·{{ h.parent_folio }}</span> }
            <button type="button" class="dm-audit dm-doc-audit" [class.is-audited]="h.audited" [disabled]="!canAudit" (click)="toggleAuditDoc(h)"
                    [title]="h.audited ? ('Auditado por ' + (h.audited_by || '—')) : (canAudit ? 'Marcar como auditado' : 'Sin auditar')">
              <i class="pi" [class.pi-verified]="h.audited" [class.pi-circle]="!h.audited"></i> {{ h.audited ? 'Auditado' : 'Sin auditar' }}
            </button>
          </div>
          <!-- Contraparte del traspaso: valida que se entregó Y se recibió -->
          @if (doc()!.counterpart; as cp) {
            <div class="dm-cp" [class.cp-ok]="cp.status === 'ok'" [class.cp-warn]="cp.status === 'diferencia'" [class.cp-bad]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'">
              <i class="pi" [class.pi-check-circle]="cp.status === 'ok'" [class.pi-exclamation-triangle]="cp.status === 'diferencia'" [class.pi-clock]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'"></i>
              @if (cp.docs.length) {
                <span><strong>{{ cp.kind === 'recepcion' ? 'Recepción' : 'Origen' }}:</strong>
                  @for (d of cp.docs; track d.folio) { <span class="dm-mono">{{ d.folio }} ({{ d.warehouse_code || '—' }}, {{ d.doc_date | date:'MM-dd' }}, {{ d.qty | number:'1.0-0' }} pzs)</span> }
                </span>
                @if (cp.status === 'ok') { <span class="dm-cp-status">cantidades cuadran ✓</span> }
                @else { <span class="dm-cp-status">diferencia {{ cp.delta > 0 ? '+' : '' }}{{ cp.delta | number:'1.0-0' }} pzs</span> }
              } @else {
                <span>{{ cp.status === 'sin_recepcion' ? 'SIN RECEPCIÓN registrada en destino (en tránsito o no recibido)' : 'Recepción SIN documento de origen visible' }}</span>
              }
            </div>
          }
          <p-table [value]="doc()!.lines" styleClass="p-datatable-sm dm-dtable" [scrollable]="true" scrollHeight="22rem">
            <ng-template pTemplate="header">
              <tr><th>SKU</th><th>Producto</th><th class="dm-r">Cantidad</th><th class="dm-r">Costo/u</th><th class="dm-r">Importe</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-l>
              <tr>
                <td class="dm-mono">{{ l.sku }}</td>
                <td class="dm-dname">{{ l.product_name || '—' }}</td>
                <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0">{{ l.signed_qty | number:'1.0-0' }}</td>
                <td class="dm-r dm-muted">{{ l.unit_cost != null ? money(l.unit_cost) : '—' }}</td>
                <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
              </tr>
            </ng-template>
          </p-table>
          <div class="dm-doc-foot">
            <span>{{ doc()!.totals.lineas | number }} líneas</span>
            <span>Neto <strong [class.up]="doc()!.totals.qty>0" [class.down]="doc()!.totals.qty<0">{{ doc()!.totals.qty | number:'1.0-0' }}</strong></span>
            <span>Total <strong>{{ money(doc()!.totals.amount) }}</strong></span>
          </div>
        } @else { <div class="dm-empty">Documento sin líneas.</div> }
      }
    </p-dialog>

    <!-- DM.3 — detalle de validación de traspasos -->
    <p-dialog [(visible)]="transfersOpen" [modal]="true" [style]="{ width: '56rem', maxWidth: '96vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template pTemplate="header"><span class="dm-dlg-title">Validación de traspasos — salida vs recepción</span></ng-template>
      @if (transfers(); as tc) {
        <p class="dm-dlg-sub">Cada salida (UD41) pareada con su recepción (UA50) por serie+folio. {{ tc.range.from }} → {{ tc.range.to }}.</p>
        <p-table [value]="tc.rows" styleClass="p-datatable-sm dm-dtable" [scrollable]="true" scrollHeight="26rem">
          <ng-template pTemplate="header">
            <tr>
              <th>Estado</th><th>Origen</th><th>Folio salida</th><th>Fecha</th><th class="dm-r">Enviadas</th>
              <th>Destino</th><th>Folio recep.</th><th>Fecha</th><th class="dm-r">Recibidas</th><th class="dm-r">Δ</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td><p-tag [value]="statusLabel(r.status)" [severity]="statusSev(r.status)" styleClass="dm-tag"></p-tag></td>
              <td class="dm-mono">{{ r.origin_wh || '—' }}</td>
              <td class="dm-mono dm-link" (click)="openTransferDoc(r, 'ship')">{{ r.origin_folio || '—' }}</td>
              <td class="dm-mono">{{ r.ship_date ? (r.ship_date | date:'MM-dd') : '—' }}</td>
              <td class="dm-r">{{ r.qty_sent != null ? (r.qty_sent | number:'1.0-0') : '—' }}</td>
              <td class="dm-mono">{{ r.dest_wh || '—' }}</td>
              <td class="dm-mono dm-link" (click)="openTransferDoc(r, 'rcv')">{{ r.rcv_folio || '—' }}</td>
              <td class="dm-mono">{{ r.rcv_date ? (r.rcv_date | date:'MM-dd') : '—' }}</td>
              <td class="dm-r">{{ r.qty_received != null ? (r.qty_received | number:'1.0-0') : '—' }}</td>
              <td class="dm-r" [class.down]="r.delta < 0" [class.up]="r.delta > 0">{{ r.delta ? (r.delta | number:'1.0-0') : '0' }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="10" class="dm-empty">Sin traspasos en el rango.</td></tr></ng-template>
        </p-table>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .dm-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .5rem; margin-bottom: 1rem; }
    .dm-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .dm-kpi-val { font-size: 1.3rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
    .dm-kpi-lbl { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .dm-kpi-val.up { color: var(--ok-fg); }
    .dm-kpi-val.down { color: var(--bad-fg); }
    .dm-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .dm-sel { min-width: 12rem; } .dm-sel-sm { min-width: 8rem; } .dm-date { min-width: 9rem; } .dm-search input { min-width: 12rem; }
    .dm-table { font-size: .82rem; }
    .dm-row { cursor: pointer; }
    .dm-r { text-align: right; font-variant-numeric: tabular-nums; }
    .dm-r.up, .dm-kpi-val.up, td.up { color: var(--ok-fg); }
    .dm-r.down, td.down { color: var(--bad-fg); }
    .dm-label { font-weight: 600; }
    .dm-sub { display: block; font-size: .68rem; color: var(--text-muted); }
    .dm-mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .dm-muted { color: var(--text-muted); }
    .dm-strong { font-weight: 700; }
    .dm-tag { font-size: .66rem; }
    .dm-empty { color: var(--text-muted); padding: 1.2rem; text-align: center; }
    .dm-dlg-title { font-weight: 700; }
    .dm-dtable { font-size: .8rem; margin-top: .3rem; }
    .dm-dname { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-dlg-foot { margin-top: .6rem; font-size: .74rem; color: var(--text-muted); }
    .dm-link { color: var(--action); }
    .dm-types { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 1rem; }
    @media (max-width: 40rem) { .dm-types { grid-template-columns: 1fr; } }
    .dm-types-col { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); padding: .55rem .7rem; display: flex; flex-direction: column; gap: .1rem; }
    .dm-types-h { margin: 0 0 .3rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .dm-types-h.up { color: var(--ok-fg); } .dm-types-h.down { color: var(--bad-fg); }
    .dm-type-row { display: flex; align-items: baseline; gap: .6rem; padding: .28rem .4rem; border: 0; background: none; border-radius: var(--r-sm); cursor: pointer; font: inherit; text-align: left; color: var(--text-main); }
    .dm-type-row:hover { background: var(--surface-hover-bg); }
    .dm-type-row.active { background: var(--surface-hover-bg); outline: 1px solid var(--border-color); }
    .dm-type-lbl { flex: 1; min-width: 0; font-size: .8rem; }
    .dm-type-num { font-size: .74rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .dm-type-val { font-size: .78rem; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 5.5rem; text-align: right; }
    .dm-empty-sm { font-size: .76rem; color: var(--text-muted); padding: .2rem .4rem; }
    .dm-transfers { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; width: 100%; margin-bottom: 1rem; padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); cursor: pointer; font: inherit; color: var(--text-main); text-align: left; }
    .dm-transfers:hover { background: var(--surface-hover-bg); }
    .dm-tr-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .dm-tr-chip { font-size: .76rem; font-variant-numeric: tabular-nums; }
    .dm-tr-chip.ok { color: var(--ok-fg); } .dm-tr-chip.warn { color: var(--warn-fg); } .dm-tr-chip.bad { color: var(--bad-fg); font-weight: 600; }
    .dm-tr-more { margin-left: auto; font-size: .74rem; color: var(--text-muted); }
    .dm-audit { display: inline-flex; align-items: center; gap: .3rem; border: 0; background: none; font: inherit; font-size: .74rem; color: var(--text-muted); cursor: pointer; padding: .15rem .35rem; border-radius: var(--r-sm); }
    .dm-audit:hover:not(:disabled) { background: var(--surface-hover-bg); color: var(--text-main); }
    .dm-audit:disabled { cursor: default; }
    .dm-audit.is-audited { color: var(--ok-fg); }
    .dm-doc-audit { margin-left: auto; }
    .dm-cp { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .78rem; padding: .45rem .6rem; border-radius: var(--r-sm); border: 1px solid var(--border-color); margin-bottom: .55rem; }
    .dm-cp.cp-ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .dm-cp.cp-warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .dm-cp.cp-bad { color: var(--bad-fg); }
    .dm-cp-status { font-weight: 600; }
    .dm-dlg-sub { color: var(--text-muted); font-size: .8rem; margin: 0 0 .4rem; }
    .dm-doc-head { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; margin-bottom: .5rem; padding-bottom: .5rem; border-bottom: 1px solid var(--border-color); }
    .dm-doc-meta { font-size: .76rem; color: var(--text-muted); }
    .dm-doc-foot { display: flex; gap: 1.5rem; justify-content: flex-end; margin-top: .6rem; font-size: .82rem; }
    .dm-doc-foot strong { font-variant-numeric: tabular-nums; }
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
  rows = signal<AggregateRow[]>([]);
  total = signal(0);
  summary = signal<MovementsSummary | null>(null);
  loading = signal(false);
  page = signal(1);

  warehouseOpts = signal<{ label: string; value: string }[]>([]);
  docTypeOpts = signal<{ label: string; value: string }[]>([]);

  fGroup: GroupBy = 'product';
  fWarehouses: string[] = [];
  fFrom: Date | null = null;
  fTo: Date | null = null;
  fKind: '' | 'entrada' | 'salida' = '';
  fDocCode = '';
  fSearch = '';

  groupOpts = [
    { label: 'Por producto', value: 'product' },
    { label: 'Por tipo de documento', value: 'doc_code' },
    { label: 'Por día', value: 'day' },
    { label: 'Por almacén', value: 'warehouse' },
  ];
  kindOpts = [
    { label: 'Entradas', value: 'entrada' },
    { label: 'Salidas', value: 'salida' },
  ];

  // Drill 2 (folios englobados: una fila por documento)
  drillOpen = false;
  drillLoading = signal(false);
  drillLines = signal<FolioRow[]>([]);
  drillTotal = signal(0);
  private drillLabel = signal('');

  // Drill 3 (documento completo)
  docOpen = false;
  docLoading = signal(false);
  doc = signal<DocumentResponse | null>(null);

  // DM.3 — validación de traspasos
  transfersOpen = false;
  transfers = signal<TransfersCheckResponse | null>(null);

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
    this.api.transfersCheck(this.currentFilters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (t) => this.transfers.set(t),
      error: () => this.transfers.set(null),
    });
  }

  private load(): void {
    this.loading.set(true);
    this.api.aggregate(this.currentFilters(), this.fGroup, this.page(), this.pageSize)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
        error: () => { this.rows.set([]); this.total.set(0); this.loading.set(false); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    const p = Math.floor((e.first || 0) / (e.rows || this.pageSize)) + 1;
    this.page.set(p);
    this.load();
  }

  drill(r: AggregateRow): void {
    this.drillOpen = true;
    this.drillLoading.set(true);
    this.drillLines.set([]);
    this.drillLabel.set(this.rowLabel(r));
    const f = this.currentFilters();
    // Fija la rama seleccionada según el eje de agrupación.
    if (this.fGroup === 'product') f.search = undefined;
    const extra: { product_id?: string; page?: number; pageSize?: number } = { page: 1, pageSize: 200 };
    if (this.fGroup === 'product') extra.product_id = r.key;
    else if (this.fGroup === 'doc_code') f.doc_code = r.key;
    else if (this.fGroup === 'warehouse') f.warehouse_ids = [r.key];
    else if (this.fGroup === 'day') { f.from = r.key.slice(0, 10); f.to = r.key.slice(0, 10); }
    this.api.lines(f, extra).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.drillLines.set(res.rows); this.drillTotal.set(res.total); this.drillLoading.set(false); },
      error: () => { this.drillLines.set([]); this.drillLoading.set(false); },
    });
  }

  /** Tipos de documento del summary filtrados por dirección (panel Entradas|Salidas). */
  typesOf(s: MovementsSummary, kind: 'entrada' | 'salida'): MovementByType[] {
    return (s.by_type || []).filter((t) => t.movement_kind === kind);
  }

  /** Clic en un tipo del panel = filtrar/desfiltrar la tabla por ese tipo. */
  toggleType(doc_code: string): void {
    this.fDocCode = this.fDocCode === doc_code ? '' : doc_code;
    this.reload();
  }

  /** Drill 3: abre el documento completo (todas las líneas del folio). */
  openDocument(l: FolioRow): void {
    this.docOpen = true;
    this.docLoading.set(true);
    this.doc.set(null);
    this.api.document(l.folio, l.warehouse_id, l.doc_code, l.doc_serie).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.doc.set(d); this.docLoading.set(false); },
      error: () => { this.doc.set({ header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 }, counterpart: null }); this.docLoading.set(false); },
    });
  }

  /** DM.4 — toggle auditado desde la fila del drill (optimistic). */
  toggleAudit(l: FolioRow): void {
    if (!this.canAudit) return;
    const next = !l.audited;
    l.audited = next;
    this.api.setAudit({ warehouse_id: l.warehouse_id, doc_code: l.doc_code, doc_serie: l.doc_serie, folio: l.folio, audited: next })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { l.audited_by = r.audited_by ?? null; this.drillLines.set([...this.drillLines()]); },
        error: () => { l.audited = !next; this.drillLines.set([...this.drillLines()]); },
      });
  }

  /** DM.4 — toggle auditado desde el diálogo del documento. */
  toggleAuditDoc(h: NonNullable<DocumentResponse['header']>): void {
    if (!this.canAudit) return;
    const next = !h.audited;
    h.audited = next;
    this.api.setAudit({ warehouse_id: h.warehouse_id, doc_code: h.doc_code, doc_serie: h.doc_serie, folio: h.folio, audited: next })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { h.audited_by = r.audited_by ?? null; this.doc.set({ ...this.doc()! }); },
        error: () => { h.audited = !next; this.doc.set({ ...this.doc()! }); },
      });
  }

  statusLabel(s: TransferStatus): string {
    return s === 'ok' ? 'Recibido' : s === 'diferencia' ? 'Diferencia' : s === 'sin_recepcion' ? 'Sin recepción' : 'Sin origen';
  }
  statusSev(s: TransferStatus): 'success' | 'warn' | 'danger' {
    return s === 'ok' ? 'success' : s === 'diferencia' ? 'warn' : 'danger';
  }

  /** Abre el documento (salida o recepción) desde la tabla de validación. */
  openTransferDoc(r: { origin_wh_id: string | null; origin_folio: string | null; doc_serie: string | null; dest_wh_id: string | null; rcv_folio: string | null }, side: 'ship' | 'rcv'): void {
    const folio = side === 'ship' ? r.origin_folio : r.rcv_folio;
    const wh = side === 'ship' ? r.origin_wh_id : r.dest_wh_id;
    if (!folio || !wh) return;
    this.docOpen = true;
    this.docLoading.set(true);
    this.doc.set(null);
    this.api.document(folio, wh, side === 'ship' ? 'TrsfShip' : 'TrsfRcv', side === 'ship' ? r.doc_serie : null)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.doc.set(d); this.docLoading.set(false); },
        error: () => { this.doc.set({ header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 }, counterpart: null }); this.docLoading.set(false); },
      });
  }

  groupHeader(): string {
    return this.fGroup === 'product' ? 'Producto' : this.fGroup === 'doc_code' ? 'Tipo de documento' : this.fGroup === 'day' ? 'Día' : 'Almacén';
  }
  rowLabel(r: AggregateRow): string {
    if (this.fGroup === 'day') return (r.label || '').slice(0, 10);
    return r.label || r.key || '—';
  }
  drillTitle(): string { return this.drillLabel() || 'Folios'; }

  absN(v: number): number { return Math.abs(v || 0); }
  money(v: number): string {
    return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
