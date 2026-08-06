import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { TabsModule } from 'primeng/tabs';
import {
  AlmacenMovimientosService, MovementsFilters, MovementsSummary,
  AggregateRow, FolioRow, MovementsFilterOpts, DocumentResponse, TransfersLedgerResponse,
  TransfersMatrixResponse, TransfersCheckResponse, TransferCheckRow, TransfersLedgerDetailResponse,
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
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, MultiSelectModule, DatePickerModule, DialogModule, TagModule, InputTextModule, TabsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in dm-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Diario de movimientos</h1>
          <p class="surf-page-sub">Movimientos de inventario por día. Abrí un día para ver sus documentos y auditarlos.</p>
        </div>
        <div class="dm-head-right">
          @if (summary(); as s) {
            <div class="dm-strip">
              <span class="up">+{{ s.totals.entradas | number:'1.0-2' }}</span> entradas ·
              <span class="down">−{{ absN(s.totals.salidas) | number:'1.0-2' }}</span> salidas ·
              <span class="dm-strong">{{ money(s.totals.valor) }}</span> · {{ s.totals.documentos | number }} docs
            </div>
          }
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="dlXlsx()" (click)="download('xlsx')" title="Documentos + validación de traspasos (filtros actuales)"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">Excel</span></button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="dlPdf()" (click)="download('pdf')" title="Documentos + validación de traspasos (filtros actuales)"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF</span></button>
        </div>
      </header>

      <p-tabs [value]="activeTab()" (valueChange)="onTab($any($event))" styleClass="dm-tabs">
        <p-tablist>
          <p-tab value="diario"><i class="pi pi-book" aria-hidden="true"></i> Diario</p-tab>
          <p-tab value="cuadre"><i class="pi pi-sitemap" aria-hidden="true"></i> Cuadre de traspasos</p-tab>
        </p-tablist>
        <p-tabpanels>
        <p-tabpanel value="diario">

      <!-- Filtros -->
      <div class="dm-filters">
        <p-multiselect [options]="destKindOpts" [(ngModel)]="fDestKinds" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Destino"
                       [showClear]="false" [showToggleAll]="false" styleClass="dm-sel-sm"
                       title="Destino de los traspasos. Por defecto solo sucursales; agregá Rutas para incluir reparto."></p-multiselect>
        <p-multiselect [options]="warehouseOpts()" [(ngModel)]="fWarehouses" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="dm-sel"></p-multiselect>
        <p-datepicker [(ngModel)]="fFrom" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-datepicker [(ngModel)]="fTo" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todo" styleClass="dm-sel-sm"></p-select>
        <p-select [options]="docTypeOpts()" [(ngModel)]="fDocCode" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Tipo de documento" [showClear]="true" styleClass="dm-sel"></p-select>
        <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Estado (traspasos)" [showClear]="true" styleClass="dm-sel"></p-select>
        <p-multiselect [options]="warehouseOpts()" [(ngModel)]="fTransferWhs" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Origen/Destino (traspasos)" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} orígenes/destinos" styleClass="dm-sel"
                       title="Solo documentos de traspaso donde el origen o el destino esté en la selección"></p-multiselect>
        <span class="dm-search">
          <input pInputText type="text" [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="SKU o producto…" aria-label="Buscar por SKU o producto" />
        </span>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()" ariaLabel="Buscar"><span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span></button>
      </div>

      @if (error()) {
        <div class="dm-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
        </div>
      }

      <!-- Tabla por DÍA (expandible) -->
      <p-table [value]="days()" [loading]="loading()" dataKey="key" [expandedRowKeys]="expanded"
               (onRowExpand)="onDayExpand($event.data)" styleClass="p-datatable-sm dm-table" [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th style="width:2.5rem"></th>
            <th>Día</th>
            <th class="dm-r" style="width:6rem">Docs</th>
            <th class="dm-r" style="width:8rem">Entradas</th>
            <th class="dm-r" style="width:8rem">Salidas</th>
            <th class="dm-r" style="width:9rem">Valor</th>
          </tr>
        </ng-template>
        <ng-template #body let-day let-expanded="expanded">
          <tr class="dm-day-row">
            <td><p-button type="button" [pRowToggler]="day" styleClass="p-button-text p-button-sm p-button-rounded"
                        [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"></p-button></td>
            <td class="dm-strong">{{ dayLabel(day.key) }}</td>
            <td class="dm-r dm-muted">{{ day.documentos | number }}</td>
            <td class="dm-r up">{{ day.entradas ? ('+' + (day.entradas | number:'1.0-2')) : '—' }}</td>
            <td class="dm-r down">{{ day.salidas ? ('−' + (absN(day.salidas) | number:'1.0-2')) : '—' }}</td>
            <td class="dm-r dm-strong">{{ money(day.valor || 0) }}</td>
          </tr>
        </ng-template>
        <ng-template #expandedrow let-day>
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
                        <td><p-tag [value]="l.movement_label" [severity]="kindSev(l.movement_kind)" styleClass="dm-tag"></p-tag></td>
                        <td class="dm-mono dm-link">{{ l.folio }}</td>
                        <td class="dm-muted">
                          {{ l.warehouse_name || l.warehouse_code || l.source_branch }}
                          @if (l.doc_code === 'TrsfShip' && destName(l)) {
                            <span class="dm-dest" [title]="'Traspaso dirigido a ' + destName(l)"><i class="pi pi-arrow-right"></i>{{ destName(l) }}</span>
                          }
                        </td>
                        <td class="dm-r dm-muted">{{ l.lineas | number }}</td>
                        <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0" [class.dm-muted]="l.movement_kind === 'info'">{{ (l.movement_kind === 'info' ? l.qty : l.signed_qty) | number:'1.0-2' }}</td>
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
        <ng-template #emptymessage>
          <tr><td colspan="6" class="dm-empty">Sin movimientos en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
        </p-tabpanel>

        <!-- ═══ CUADRE DE TRASPASOS (informe desglosado) ═══ -->
        <p-tabpanel value="cuadre">
          <div class="dm-cuadre-bar">
            <span class="dm-muted">Mes:</span>
            <p-select [options]="monthOpts" [(ngModel)]="cMonth" (onChange)="onMonthChange()" optionLabel="label" optionValue="value" styleClass="dm-sel" appendTo="body"></p-select>
            <span class="dm-muted">o rango:</span>
            <p-datepicker [(ngModel)]="cFrom" (onSelect)="cMonth=''" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
            <p-datepicker [(ngModel)]="cTo" (onSelect)="cMonth=''" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
            <button pButton type="button" class="p-button-sm" (click)="loadCuadre()" [loading]="cuadreLoading()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
            <p-select [options]="pdfModeOpts" [(ngModel)]="cPdfMode" optionLabel="label" optionValue="value" styleClass="dm-sel" appendTo="body" title="Alcance del reporte PDF"></p-select>
            <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="dlCuadre()" (click)="downloadCuadre()" title="Reporte del cuadre en PDF (global / concentrado / desglosado por sucursal)"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">Reporte PDF</span></button>
            <span class="dm-muted dm-cuadre-note">Vista de red — ignora el filtro de almacén del Diario.</span>
          </div>

          @if (cuadreLoading()) { <div class="dm-empty">Cargando informe de cuadre…</div> }
          @else {
            <!-- ── Bloque CONTABLE (balanza Kepler, mayor 515) ── -->
            @if (ledger(); as lg) {
              <section class="dm-block">
                <header class="dm-block-head">
                  <div>
                    <h2 class="dm-block-title"><i class="pi pi-book" aria-hidden="true"></i> Cuadre contable · mayor 515 «Ajuste traspasos internos»</h2>
                    <p class="dm-block-sub">Cuenta puente: cada salida (515-002) debe tener su entrada (515-001) → el mayor debe netear <strong>$0</strong>. Δ ≠ 0 = traspasos sin cuadrar o en tránsito al corte.</p>
                  </div>
                  <div class="dm-total" [class.ok]="ledgerOk(lg.totals.delta, lg.totals.entrada)" [class.bad]="!ledgerOk(lg.totals.delta, lg.totals.entrada)">
                    <span class="dm-total-lbl">Descuadre acumulado</span>
                    <span class="dm-total-val">{{ signed(lg.totals.delta) }}</span>
                  </div>
                </header>

                <!-- Desglose POR SUBCUENTA -->
                <div class="dm-subacc">
                  <div class="dm-subacc-card"><span class="dm-subacc-code up">515-001 · Entrada</span><span class="dm-subacc-val up">{{ money(lg.totals.entrada) }}</span></div>
                  <div class="dm-subacc-card"><span class="dm-subacc-code down">515-002 · Salida</span><span class="dm-subacc-val down">{{ money(lg.totals.salida) }}</span></div>
                  <div class="dm-subacc-card"><span class="dm-subacc-code">Δ neto</span><span class="dm-subacc-val" [class.up]="lg.totals.delta>0" [class.down]="lg.totals.delta<0">{{ signed(lg.totals.delta) }}</span></div>
                </div>

                <div class="dm-block-grid">
                  <!-- Serie mensual + tendencia -->
                  <div>
                    <h3 class="dm-h3">Serie mensual + tendencia</h3>
                    <table class="dm-docs dm-tbl">
                      <thead><tr><th>Mes</th><th class="dm-r">Entrada</th><th class="dm-r">Salida</th><th class="dm-r">Δ</th><th class="dm-r">% desc.</th><th class="dm-r">Acumulado</th></tr></thead>
                      <tbody>
                        @for (m of ledgerRowsAcc(); track m.anio_mes) {
                          <tr><td class="dm-strong">{{ m.anio_mes }}</td>
                            <td class="dm-r up">{{ money(m.entrada) }}</td>
                            <td class="dm-r down">{{ money(m.salida) }}</td>
                            <td class="dm-r dm-delta" [class.ok]="ledgerOk(m.delta, m.entrada)" [class.bad]="!ledgerOk(m.delta, m.entrada)">{{ ledgerOk(m.delta, m.entrada) ? 'cuadra' : signed(m.delta) }}</td>
                            <td class="dm-r dm-muted">{{ pctDesc(m.delta, m.entrada) }}</td>
                            <td class="dm-r dm-strong" [class.bad]="!ledgerOk(m.acumulado, m.entrada)">{{ signed(m.acumulado) }}</td></tr>
                        } @empty { <tr><td colspan="6" class="dm-empty">Sin datos contables de traspasos en el rango.</td></tr> }
                      </tbody>
                    </table>
                  </div>
                  <!-- Por sucursal -->
                  @if (lg.by_sucursal.length) {
                    <div>
                      <h3 class="dm-h3">Por sucursal</h3>
                      <table class="dm-docs dm-tbl">
                        <thead><tr><th>Sucursal</th><th class="dm-r">Entrada</th><th class="dm-r">Salida</th><th class="dm-r">Δ descuadre</th></tr></thead>
                        <tbody>
                          @for (s of lg.by_sucursal; track s.sucursal) {
                            <tr><td class="dm-strong">{{ s.sucursal }}</td>
                              <td class="dm-r up">{{ money(s.entrada) }}</td>
                              <td class="dm-r down">{{ money(s.salida) }}</td>
                              <td class="dm-r dm-delta" [class.ok]="ledgerOk(s.delta, s.entrada)" [class.bad]="!ledgerOk(s.delta, s.entrada)">{{ ledgerOk(s.delta, s.entrada) ? 'cuadra' : signed(s.delta) }}</td></tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }
                </div>
              </section>
            } @else { <div class="dm-empty">Sin datos contables de traspasos en el rango.</div> }

            <!-- ── Detalle: pólizas 515 — pareo tolerante (exacto/costo/sin rastro) ── -->
            @if (detail(); as dt) {
              <section class="dm-block">
                <header class="dm-block-head">
                  <div>
                    <h2 class="dm-block-title"><i class="pi pi-search" aria-hidden="true"></i> Detalle de pólizas <span class="dm-muted">· dónde está la contraparte</span></h2>
                    <p class="dm-block-sub">Pareo por importe con tolerancia <strong>±{{ dt.tolerance_pct }}%</strong> + ventana ±{{ dt.window_months }} mes (origen y destino registran el traspaso con costo ligeramente distinto). Lo <strong>sin rastro</strong> es lo que hay que encontrar en Kepler; la referencia trae el folio. Fuente: pólizas Kepler.</p>
                  </div>
                  <div class="dm-total" [class.ok]="!dt.totals.sin_rastro.n_entrada && !dt.totals.sin_rastro.n_salida" [class.bad]="dt.totals.sin_rastro.n_entrada || dt.totals.sin_rastro.n_salida">
                    <span class="dm-total-lbl">Sin rastro</span>
                    <span class="dm-total-val">{{ dt.totals.sin_rastro.n_entrada + dt.totals.sin_rastro.n_salida }} pólizas</span>
                  </div>
                </header>
                <div class="dm-subacc">
                  <div class="dm-subacc-card"><span class="dm-subacc-code">✔ Pareadas exactas</span><span class="dm-subacc-val">{{ dt.totals.n_exact | number }} <span class="dm-muted dm-subacc-n">pólizas</span></span></div>
                  <div class="dm-subacc-card"><span class="dm-subacc-code">≈ Con dif. de costo</span><span class="dm-subacc-val">{{ dt.totals.cost.n | number }} <span class="dm-muted dm-subacc-n">pares · Δ {{ money(dt.totals.cost.diff_total) }}</span></span></div>
                  <div class="dm-subacc-card"><span class="dm-subacc-code up">Sin rastro · entradas</span><span class="dm-subacc-val up">{{ money(dt.totals.sin_rastro.amt_entrada) }} <span class="dm-muted dm-subacc-n">· {{ dt.totals.sin_rastro.n_entrada }}</span></span></div>
                  <div class="dm-subacc-card"><span class="dm-subacc-code down">Sin rastro · salidas</span><span class="dm-subacc-val down">{{ money(dt.totals.sin_rastro.amt_salida) }} <span class="dm-muted dm-subacc-n">· {{ dt.totals.sin_rastro.n_salida }}</span></span></div>
                </div>

                <h3 class="dm-h3">Sin rastro — a revisar en Kepler</h3>
                <table class="dm-docs dm-tbl">
                  <thead><tr><th>Mes</th><th>Tipo</th><th>Suc.</th><th class="dm-r">Importe</th><th>Referencia (localizador)</th></tr></thead>
                  <tbody>
                    @for (r of dt.rows; track $index) {
                      <tr>
                        <td class="dm-mono">{{ r.anio_mes }}</td>
                        <td [class.up]="r.kind==='entrada'" [class.down]="r.kind==='salida'" class="dm-strong">{{ r.kind === 'entrada' ? 'Entrada 515-001' : 'Salida 515-002' }}</td>
                        <td class="dm-muted">{{ r.sucursal }}</td>
                        <td class="dm-r dm-strong">{{ money(r.importe) }}</td>
                        <td class="dm-ref">{{ r.referencia || '—' }}</td>
                      </tr>
                    } @empty { <tr><td colspan="5" class="dm-empty">Todo pareó (exacto o con diferencia de costo). 🎉</td></tr> }
                  </tbody>
                </table>
                @if (dt.truncated) { <div class="dm-check-foot dm-muted">Mostrando las {{ dt.rows.length }} de mayor importe de {{ dt.total }} — acotá el rango para ver todas.</div> }

                @if (dt.cost_pairs.length) {
                  <h3 class="dm-h3">Pareadas con diferencia de costo <span class="dm-muted">(la contraparte SÍ existe — Δ = valuación)</span></h3>
                  <table class="dm-docs dm-tbl">
                    <thead><tr><th>Mes</th><th>Entrada (515-001)</th><th class="dm-r">Importe ent.</th><th>Salida (515-002)</th><th class="dm-r">Importe sal.</th><th class="dm-r">Δ costo</th></tr></thead>
                    <tbody>
                      @for (p of dt.cost_pairs; track $index) {
                        <tr>
                          <td class="dm-mono">{{ p.anio_mes }}</td>
                          <td class="dm-ref up">{{ p.entrada_ref || '—' }} <span class="dm-muted">· suc {{ p.sucursal_entrada }}</span></td>
                          <td class="dm-r">{{ money(p.entrada_importe) }}</td>
                          <td class="dm-ref down">{{ p.salida_ref || '—' }} <span class="dm-muted">· suc {{ p.sucursal_salida }}</span></td>
                          <td class="dm-r">{{ money(p.salida_importe) }}</td>
                          <td class="dm-r dm-delta bad">{{ signed(p.delta) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                  @if (dt.cost_truncated) { <div class="dm-check-foot dm-muted">Mostrando los {{ dt.cost_pairs.length }} de mayor Δ de {{ dt.cost_total }}.</div> }
                }
              </section>
            }

            <!-- ── Bloque FÍSICO (feed de movimientos, TrsfShip ⇄ TrsfRcv) ── -->
            <section class="dm-block">
              <h2 class="dm-block-title"><i class="pi pi-sitemap" aria-hidden="true"></i> Flujo físico origen → destino <span class="dm-muted">· feed de movimientos</span></h2>
              <p class="dm-block-sub">Pareo de cada salida física con su recepción. Le pone cara (qué sucursales) y folio al descuadre contable.</p>

              <!-- Matriz origen → destino -->
              <h3 class="dm-h3">Matriz origen → destino</h3>
              @if (matrix(); as mx) {
                <table class="dm-docs dm-tbl">
                  <thead><tr><th>Origen</th><th>Destino</th><th class="dm-r">Enviado</th><th class="dm-r">Recibido</th><th class="dm-r">Δ pzs</th><th class="dm-r">Valor</th><th class="dm-r">OK / dif / s.rec.</th></tr></thead>
                  <tbody>
                    @for (r of mx.rows; track r.origin_wh_id + '>' + r.dest_wh_id) {
                      <tr>
                        <td class="dm-strong">{{ r.origin_wh || '—' }}</td>
                        <td>{{ r.dest_wh || '(sin destino)' }}</td>
                        <td class="dm-r">{{ r.qty_sent | number:'1.0-0' }}</td>
                        <td class="dm-r">{{ r.qty_received | number:'1.0-0' }}</td>
                        <td class="dm-r dm-delta" [class.ok]="matrixQtyOk(r.delta_qty)" [class.bad]="!matrixQtyOk(r.delta_qty)">{{ matrixQtyOk(r.delta_qty) ? 'cuadra' : (r.delta_qty>0?'+':'') + (r.delta_qty | number:'1.0-0') }}</td>
                        <td class="dm-r dm-strong">{{ money(r.amount) }}</td>
                        <td class="dm-r dm-muted"><span class="up">{{ r.n_ok }}</span> / <span [class.down]="r.n_diferencia>0">{{ r.n_diferencia }}</span> / <span [class.down]="r.n_sin_recepcion>0">{{ r.n_sin_recepcion }}</span></td>
                      </tr>
                    } @empty { <tr><td colspan="7" class="dm-empty">Sin traspasos físicos en el rango (el feed de movimientos no trae TrsfShip/TrsfRcv en este período).</td></tr> }
                  </tbody>
                </table>
              } @else { <div class="dm-empty">Sin datos.</div> }

              <!-- Drill: folios sin cuadrar -->
              <h3 class="dm-h3">Traspasos sin cuadrar <span class="dm-muted">(clic para abrir el documento)</span></h3>
              @if (check(); as ck) {
                <table class="dm-docs dm-tbl">
                  <thead><tr><th>Estado</th><th>Origen</th><th>Folio</th><th>Destino</th><th class="dm-r">Enviado</th><th class="dm-r">Recibido</th><th class="dm-r">Δ pzs</th><th class="dm-r">Valor</th><th>Fecha</th></tr></thead>
                  <tbody>
                    @for (r of unmatched(); track r.origin_folio + '|' + r.rcv_folio + '|' + r.origin_wh_id) {
                      <tr class="dm-row" (click)="openTransfer(r)">
                        <td><p-tag [value]="checkLabel(r.status)" [severity]="checkSev(r.status)" styleClass="dm-tag"></p-tag></td>
                        <td class="dm-strong">{{ r.origin_wh || '—' }}</td>
                        <td class="dm-mono dm-link">{{ r.origin_folio || r.rcv_folio || '—' }}</td>
                        <td>{{ r.dest_wh || '—' }}</td>
                        <td class="dm-r">{{ r.qty_sent != null ? (r.qty_sent | number:'1.0-0') : '—' }}</td>
                        <td class="dm-r">{{ r.qty_received != null ? (r.qty_received | number:'1.0-0') : '—' }}</td>
                        <td class="dm-r down">{{ r.delta > 0 ? '+' : '' }}{{ r.delta | number:'1.0-0' }}</td>
                        <td class="dm-r dm-strong">{{ r.amount != null ? money(r.amount) : '—' }}</td>
                        <td class="dm-muted">{{ (r.ship_date || r.rcv_date) | date:'yyyy-MM-dd' }}</td>
                      </tr>
                    } @empty { <tr><td colspan="9" class="dm-empty">No hay traspasos sin cuadrar en el rango. 🎉</td></tr> }
                  </tbody>
                </table>
                @if (ck.rows.length) {
                  <div class="dm-check-foot dm-muted">
                    {{ ck.totals.ok }} ok · <span [class.down]="ck.totals.diferencia>0">{{ ck.totals.diferencia }} con diferencia</span> ·
                    <span [class.down]="ck.totals.sin_recepcion>0">{{ ck.totals.sin_recepcion }} sin recepción</span> ·
                    <span [class.down]="ck.totals.sin_origen>0">{{ ck.totals.sin_origen }} sin origen</span>
                  </div>
                }
              } @else { <div class="dm-empty">Sin datos.</div> }
            </section>
          }
        </p-tabpanel>
        </p-tabpanels>
      </p-tabs>
    </div>

    <!-- Documento + relación + contraparte -->
    <p-dialog [(visible)]="docOpen" [modal]="true" [style]="{ width: cpDoc() ? '68rem' : '46rem', maxWidth: '96vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template #header><span class="dm-dlg-title">Documento {{ doc()?.header?.folio }}</span></ng-template>
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
                Folio {{ h.folio }} · {{ h.warehouse_name || h.warehouse_code || h.source_branch }} · {{ h.movement_kind === 'salida' ? 'salida' : 'entrada' }}
              </span>
              <i class="pi pi-arrows-h dm-rel-arrow"></i>
              @if (cp.docs.length) {
                <span class="dm-rel-doc" [class.rel-out]="cp.kind==='origen'" [class.rel-in]="cp.kind==='recepcion'">
                  Folio {{ cp.docs[0].folio }} · {{ cp.docs[0].warehouse_name || cp.docs[0].warehouse_code || '—' }} · {{ cp.kind === 'recepcion' ? 'recepción' : 'origen' }}
                </span>
              } @else if (cp.status === 'sin_recepcion' && cpDestName(cp)) {
                <span class="dm-rel-doc rel-in">{{ cpDestName(cp) }}</span>
                <span class="dm-rel-none">· sin recepción</span>
              } @else { <span class="dm-rel-none">{{ cp.status === 'sin_recepcion' ? 'sin recepción' : 'sin origen' }}</span> }
            </div>
            <!-- Validación -->
            <div class="dm-cp" [class.cp-ok]="cp.status === 'ok'" [class.cp-warn]="cp.status === 'diferencia'" [class.cp-bad]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'">
              <i class="pi" [class.pi-check-circle]="cp.status === 'ok'" [class.pi-exclamation-triangle]="cp.status === 'diferencia'" [class.pi-clock]="cp.status === 'sin_recepcion' || cp.status === 'sin_origen'"></i>
              <strong>{{ cpTitle(cp.status) }}</strong>
              <span>Enviadas {{ absN(doc()!.totals.qty) | number:'1.0-2' }} · Recibidas {{ cp.qty | number:'1.0-2' }}</span>
              @if (cp.status === 'diferencia') { <span class="dm-strong">Δ {{ cp.delta > 0 ? '+' : '' }}{{ cp.delta | number:'1.0-2' }} pzs</span> }
            </div>
          }

          <div class="dm-doc-head">
            <p-tag [value]="h.movement_label" [severity]="kindSev(h.movement_kind)" styleClass="dm-tag"></p-tag>
            <span class="dm-doc-meta">{{ h.doc_date | date:'yyyy-MM-dd' }}</span>
            <span class="dm-doc-meta">Almacén {{ h.warehouse_name || h.warehouse_code || h.source_branch }}</span>
            @if (h.movement_kind === 'info' && h.parent_folio) {
              <span class="dm-doc-meta">Aplica a la orden de entrada {{ h.parent_folio }} · no mueve inventario</span>
            }
          </div>

          <!-- Documento + contraparte lado a lado -->
          <div class="dm-cols" [class.two]="cpDoc()">
            <div class="dm-col">
              <h4 class="dm-col-h">Folio {{ h.folio }} · {{ h.movement_kind === 'salida' ? 'salida' : h.movement_kind === 'info' ? 'informativo' : 'entrada' }}</h4>
              <ng-container [ngTemplateOutlet]="linesTpl" [ngTemplateOutletContext]="{ lines: doc()!.lines, totals: doc()!.totals }"></ng-container>
            </div>
            @if (cpLoading()) { <div class="dm-col dm-empty">Cargando contraparte…</div> }
            @else if (cpDoc()) {
              @if (cpDoc()!.header; as ch) {
                <div class="dm-col">
                  <h4 class="dm-col-h">Contraparte — folio {{ ch.folio }} · {{ ch.movement_label }} ({{ ch.warehouse_name || ch.warehouse_code || ch.source_branch }})</h4>
                  <ng-container [ngTemplateOutlet]="linesTpl" [ngTemplateOutletContext]="{ lines: cpDoc()!.lines, totals: cpDoc()!.totals }"></ng-container>
                </div>
              }
            }
          </div>

          <!-- Auditar -->
          <div class="dm-audit-bar">
            @if (h.audited) {
              <span class="dm-audited-note"><i class="pi pi-verified"></i> Auditado por {{ h.audited_by || '—' }} · {{ h.audited_at | date:'yyyy-MM-dd HH:mm' }}</span>
              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [disabled]="!canAudit" (click)="toggleAuditDoc(h)"><span class="p-button-label">Quitar auditoría</span></button>
            } @else {
              <p-button type="button" styleClass="dm-audit-btn" icon="pi pi-check-circle" [label]="auditLabel(h)" [disabled]="!canAudit" (click)="toggleAuditDoc(h)"></p-button>
            }
          </div>
        } @else { <div class="dm-empty">Documento sin líneas.</div> }
      }
    </p-dialog>

    <!-- Tabla de líneas reutilizable -->
    <ng-template #linesTpl let-lines="lines" let-totals="totals">
      <p-table [value]="lines" styleClass="p-datatable-sm dm-dtable" [scrollable]="true" scrollHeight="20rem">
        <ng-template #header>
          <tr><th>SKU</th><th>Producto</th><th class="dm-r">Cant.</th><th class="dm-r">Importe</th></tr>
        </ng-template>
        <ng-template #body let-l>
          <tr>
            <td class="dm-mono">{{ l.sku }}</td>
            <td class="dm-dname" [title]="l.product_name">{{ l.product_name || '—' }}</td>
            <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0" [class.dm-muted]="l.movement_kind === 'info'">{{ (l.movement_kind === 'info' ? l.qty : l.signed_qty) | number:'1.0-2' }}</td>
            <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
          </tr>
        </ng-template>
      </p-table>
      <div class="dm-col-foot">{{ totals.lineas | number }} líneas · {{ lines[0]?.movement_kind === 'info' ? 'Ampara' : 'Neto' }} <strong [class.up]="totals.qty>0" [class.down]="totals.qty<0">{{ totals.qty | number:'1.0-2' }}</strong> · {{ money(totals.amount) }}</div>
    </ng-template>
  `,
  styles: [`
    :host { display: block; }
    .dm-head-right { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
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
    .dm-dest { display: inline-flex; align-items: center; gap: .2rem; margin-left: .45rem; font-size: .74rem; color: var(--warn-soft-fg); background: var(--warn-soft-bg); padding: .05rem .4rem; border-radius: var(--r-sm); }
    .dm-dest i { font-size: .62rem; }
    .dm-mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .dm-muted { color: var(--text-muted); }
    .dm-strong { font-weight: 700; }
    .dm-tag { font-size: .68rem; }
    .dm-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .dm-error { display: flex; align-items: center; gap: .5rem; font-size: .82rem; padding: .55rem .8rem; margin: .5rem 0; border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border); }
    .dm-error span { margin-right: auto; }
    /* DM.12 — informe de cuadre de traspasos */
    .dm-cuadre-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .25rem 0 1rem; }
    .dm-cuadre-note { margin-left: .25rem; font-size: .76rem; }
    .dm-block { border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); padding: .8rem .9rem; margin-bottom: 1rem; }
    .dm-block-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .75rem 1rem; }
    .dm-block-title { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: .4rem; }
    .dm-block-sub { margin: .2rem 0 .6rem; font-size: .76rem; color: var(--text-muted); max-width: 52rem; }
    .dm-total { display: flex; flex-direction: column; align-items: flex-end; padding: .35rem .7rem; border-radius: var(--r-sm); border: 1px solid var(--border-color); white-space: nowrap; }
    .dm-total.ok { background: var(--ok-soft-bg); border-color: var(--ok-border); color: var(--ok-soft-fg); }
    .dm-total.bad { background: var(--bad-soft-bg); border-color: var(--bad-border); color: var(--bad-soft-fg); }
    .dm-total-lbl { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; }
    .dm-total-val { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .dm-subacc { display: flex; flex-wrap: wrap; gap: .6rem; margin: .3rem 0 .8rem; }
    .dm-subacc-card { display: flex; flex-direction: column; gap: .1rem; padding: .4rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-sm); min-width: 11rem; }
    .dm-subacc-code { font-size: .72rem; font-weight: 600; }
    .dm-subacc-val { font-size: 1rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .dm-subacc-n { font-size: .72rem; font-weight: 400; }
    .dm-ref { font-size: .78rem; max-width: 30rem; }
    .dm-block-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 1.2rem; }
    @media (max-width: 60rem) { .dm-block-grid { grid-template-columns: 1fr; } }
    .dm-h3 { margin: .6rem 0 .3rem; font-size: .74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
    .dm-tbl { font-size: .8rem; width: 100%; }
    .dm-check-foot { margin-top: .4rem; font-size: .76rem; }
    .dm-delta { font-variant-numeric: tabular-nums; font-weight: 600; }
    .dm-delta.ok { color: var(--text-muted); font-weight: 400; }
    .dm-delta.bad { color: var(--bad-fg); }
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

  readonly canAudit = this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_MOVEMENTS_GESTIONAR];

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
  fTransferWhs: string[] = [];
  // DM.11c — por defecto MOSTRAR TODO (sucursal+ruta+cliente): un default que oculta movimientos
  // confunde ("no aparece nada"). "Solo sucursal" pasa a ser una elección explícita para conciliar
  // traspasos entre sucursales. Los 3 seleccionados ⇒ destBucketSql='' ⇒ sin filtro de destino.
  fDestKinds: string[] = ['sucursal', 'ruta', 'cliente'];

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
  destKindOpts = [
    { label: 'Sucursal', value: 'sucursal' },
    { label: 'Rutas', value: 'ruta' },
    { label: 'Clientes', value: 'cliente' },
  ];

  // Documento + contraparte
  docOpen = false;
  docLoading = signal(false);
  docError = signal<string | null>(null);
  doc = signal<DocumentResponse | null>(null);
  cpLoading = signal(false);
  cpDoc = signal<DocumentResponse | null>(null);

  // DM.6 — export XLSX/PDF
  dlXlsx = signal(false);
  dlPdf = signal(false);

  // DM.12 — pestaña "Cuadre de traspasos" (informe desglosado)
  activeTab = signal<string>('diario');
  cFrom: Date = new Date(new Date().getFullYear(), 0, 1); // 1-ene del año en curso
  cTo: Date = new Date();
  cMonth = ''; // '' = rango personalizado (usa cFrom/cTo); 'YYYY-MM' = mes puntual
  monthOpts = this.buildMonthOpts();

  // Los datos del cuadre arrancan en ene-2026 (balanza mayor 515). No ofrecer meses
  // anteriores → saldrían vacíos. Ver cobertura por fuente en la nota de DM.12.
  private static readonly DATA_START = { y: 2026, m: 0 }; // enero 2026 (m 0-based)

  /** Meses desde ene-2026 hasta el mes actual (desc) + "Rango personalizado". */
  private buildMonthOpts(): { label: string; value: string }[] {
    const opts = [{ label: 'Rango personalizado', value: '' }];
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth();
    const start = AlmacenMovimientosComponent.DATA_START;
    while (y > start.y || (y === start.y && m >= start.m)) {
      const label = new Date(y, m, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
      opts.push({ label: label.charAt(0).toUpperCase() + label.slice(1), value: `${y}-${String(m + 1).padStart(2, '0')}` });
      m--; if (m < 0) { m = 11; y--; }
    }
    return opts;
  }

  /** Al elegir un mes, fija el rango a ese mes completo y recarga. */
  onMonthChange(): void {
    if (!this.cMonth) return; // "Rango personalizado" → usa los datepickers
    const [y, m] = this.cMonth.split('-').map(Number);
    this.cFrom = new Date(y, m - 1, 1);
    this.cTo = new Date(y, m, 0); // día 0 del mes siguiente = último día del mes
    this.loadCuadre();
  }
  cuadreLoaded = signal(false);
  cuadreLoading = signal(false);
  dlCuadre = signal(false);                                    // descarga del reporte PDF
  cPdfMode: 'global' | 'resumen' | 'detalle' = 'global';       // alcance del reporte PDF
  pdfModeOpts = [
    { label: 'PDF: Global', value: 'global' },
    { label: 'PDF: Concentrado por sucursal', value: 'resumen' },
    { label: 'PDF: Desglosado por sucursal', value: 'detalle' },
  ];
  ledger = signal<TransfersLedgerResponse | null>(null);       // contable (mayor 515)
  matrix = signal<TransfersMatrixResponse | null>(null);       // físico origen→destino
  check = signal<TransfersCheckResponse | null>(null);         // físico folio a folio
  detail = signal<TransfersLedgerDetailResponse | null>(null); // pólizas 515 sin contraparte

  /** Cambio de pestaña; carga el informe la 1ª vez que se entra a "cuadre". */
  onTab(v: string | number): void {
    const tab = String(v);
    this.activeTab.set(tab);
    if (tab === 'cuadre' && !this.cuadreLoaded()) this.loadCuadre();
  }

  /** Carga los 3 lentes del informe (contable + matriz + folios) para el rango propio. */
  loadCuadre(): void {
    const f: MovementsFilters = { from: this.iso(this.cFrom), to: this.iso(this.cTo) };
    this.cuadreLoading.set(true);
    forkJoin({
      ledger: this.api.transfersLedger(f),
      matrix: this.api.transfersMatrix(f),
      check: this.api.transfersCheck(f),
      detail: this.api.transfersLedgerDetail(f),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ledger.set(r.ledger); this.matrix.set(r.matrix); this.check.set(r.check); this.detail.set(r.detail);
        this.cuadreLoading.set(false); this.cuadreLoaded.set(true);
      },
      error: () => { this.cuadreLoading.set(false); this.cuadreLoaded.set(true); },
    });
  }

  /** DM.12 — descarga el reporte mensual del cuadre en PDF (rango de la pestaña). */
  downloadCuadre(): void {
    const f: MovementsFilters = { from: this.iso(this.cFrom), to: this.iso(this.cTo) };
    this.dlCuadre.set(true);
    this.api.downloadCuadrePdf(f, this.cPdfMode).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resp) => {
        this.dlCuadre.set(false);
        const cd = resp.headers.get('content-disposition') || '';
        const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const name = m ? decodeURIComponent(m[1]) : 'Cuadre de traspasos.pdf';
        const url = URL.createObjectURL(resp.body!);
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.dlCuadre.set(false),
    });
  }

  /** Serie mensual contable con acumulado corriente del descuadre. */
  ledgerRowsAcc(): (TransfersLedgerResponse['rows'][number] & { acumulado: number })[] {
    const rows = this.ledger()?.rows ?? [];
    let acc = 0;
    return rows.map((m) => { acc += Number(m.delta) || 0; return { ...m, acumulado: acc }; });
  }
  /** % de descuadre del mes = |Δ| / entrada. */
  pctDesc(delta: number, entrada: number): string {
    const e = Math.abs(Number(entrada) || 0);
    if (!e) return '—';
    return ((Math.abs(Number(delta) || 0) / e) * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%';
  }
  /** Filas físicas sin cuadrar (todo lo que no es 'ok'), ya vienen priorizadas del backend. */
  unmatched(): TransferCheckRow[] {
    return (this.check()?.rows ?? []).filter((r) => r.status !== 'ok');
  }
  matrixQtyOk(delta: number): boolean { return Math.abs(Number(delta) || 0) < 0.01; }
  checkLabel(s: string): string {
    return s === 'diferencia' ? 'Diferencia' : s === 'sin_recepcion' ? 'Sin recepción' : s === 'sin_origen' ? 'Sin origen' : 'OK';
  }
  checkSev(s: string): 'success' | 'warn' | 'danger' | 'info' {
    return s === 'ok' ? 'success' : s === 'diferencia' ? 'danger' : s === 'sin_recepcion' ? 'warn' : 'info';
  }
  /** Drill: abre el documento del traspaso sin cuadrar (la salida; si no hay origen, la recepción). */
  openTransfer(r: TransferCheckRow): void {
    if (r.origin_folio && r.origin_wh_id) {
      this.openDocument({ folio: r.origin_folio, warehouse_id: r.origin_wh_id, doc_code: 'TrsfShip', doc_serie: r.doc_serie } as FolioRow);
    } else if (r.rcv_folio && r.dest_wh_id) {
      this.openDocument({ folio: r.rcv_folio, warehouse_id: r.dest_wh_id, doc_code: 'TrsfRcv', doc_serie: null } as FolioRow);
    }
  }

  /** Cuadra si |Δ| es despreciable: < $1 absoluto o < 0.1% de las entradas del período. */
  ledgerOk(delta: number, entrada: number): boolean {
    const d = Math.abs(Number(delta) || 0);
    return d < 1 || d < Math.abs(Number(entrada) || 0) * 0.001;
  }
  /** Δ con signo explícito (+/−) y formato moneda. */
  signed(v: number | string): string {
    const n = Number(v) || 0;
    return (n > 0 ? '+' : '') + this.money(n);
  }

  /** Descarga el reporte (Documentos + Validación de traspasos) con los filtros actuales. */
  download(format: 'xlsx' | 'pdf'): void {
    const flag = format === 'xlsx' ? this.dlXlsx : this.dlPdf;
    flag.set(true);
    this.api.downloadExport(this.currentFilters(), format)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          flag.set(false);
          const cd = resp.headers.get('content-disposition') || '';
          const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const name = m ? decodeURIComponent(m[1]) : `Diario de movimientos.${format}`;
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a'); a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => flag.set(false),
      });
  }

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
      transfer_wh_ids: this.fTransferWhs.length ? this.fTransferWhs : undefined,
      dest_kinds: this.fDestKinds.length ? this.fDestKinds : undefined,
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

  /** Tag por dirección del documento; 'info' (no mueve inventario) = neutro. */
  kindSev(k: string): 'success' | 'warn' | 'secondary' {
    return k === 'entrada' ? 'success' : k === 'salida' ? 'warn' : 'secondary';
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

  /** DM.11 — nombre del destino de un traspaso (almacén curado o label kdud). */
  destName(l: FolioRow): string | null {
    return l.dest_warehouse_name || l.dest_label || null;
  }
  cpDestName(cp: NonNullable<DocumentResponse['counterpart']>): string | null {
    return cp.dest_warehouse_name || cp.dest_label || null;
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
