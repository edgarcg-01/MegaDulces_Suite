import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { PagosComprobantesService, PagoRow, PagosReport, DepositOcr, ProofFile, PagoDetail, PagoCandidate } from '../pagos-comprobantes.service';
import { PagosComprobantesSocketService, PaymentProofEvent } from '../pagos-comprobantes-socket.service';

/** PC.2 — una foto del gasto (factura/ticket/mercancía). Se lee su total para validar Σ gastos ≈ pago. */
interface GastoFile {
  id: number; name: string; dataUri: string; kind: 'image' | 'pdf';
  uploaded: ProofFile | null; uploading: boolean; failed: boolean;
  ocrMonto: number | null; ocrLoading: boolean;
}

/**
 * CC (extensión) — "Comprobantes de Pago a Proveedor". Lista los pagos de Kepler
 * (documento XD2501) y le adjunta a cada uno el COMPROBANTE DE TRANSFERENCIA
 * (imagen/PDF): el capturista elige el pago, sube el comprobante, corre OCR (Claude
 * vision), el sistema compara el monto OCR vs el del pago (chip de cuadre) y guarda
 * la evidencia. Validación/rechazo a nivel gestión. No escribe a Kepler.
 */
@Component({
  selector: 'app-finanzas-pagos-comprobantes',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, InputTextModule, InputNumberModule, SelectModule, ButtonModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pagos a proveedor — comprobantes</h1>
          <p class="surf-page-sub">Adjunta el comprobante a cada pago de Kepler (transferencia o cheque) · OCR compara el monto · pendiente → validado/rechazado</p>
        </div>
      </header>

      <div class="cb-cap-bar">
        <button pButton type="button" (click)="openCapture()" title="Sube el comprobante y buscamos el pago solo"><span class="p-button-icon p-button-icon-left pi pi-camera" aria-hidden="true"></span><span class="p-button-label">Capturar comprobante</span></button>
        <span class="cb-cap-hint">Sube el comprobante primero — el sistema busca el pago por ti.</span>
        @if (live()) { <span class="cb-live" title="Cambios de otros usuarios se reflejan al momento"><span class="cb-live-dot"></span> En vivo</span> }
      </div>
      <div class="cb-filters card-premium card-flat">
        <div class="cb-field"><label>Estado</label>
          <app-segmented [options]="estadoOpts" [value]="estadoSel()" (valueChange)="setEstado($event)" ariaLabel="Estado del comprobante" /></div>
        <div class="cb-field"><label>Año</label>
          <p-select [options]="anioOpts" [(ngModel)]="anio" (onChange)="onAnio()" optionLabel="label" optionValue="value" styleClass="cb-sel" ariaLabel="Filtrar por año" /></div>
        <div class="cb-field"><label>Mes</label>
          <p-select [options]="mesOpts" [(ngModel)]="mes" (onChange)="load()" optionLabel="label" optionValue="value" [disabled]="!anio" styleClass="cb-sel" ariaLabel="Filtrar por mes" /></div>
        <div class="cb-field"><label>Método</label>
          <p-select [options]="metodoOpts" [(ngModel)]="metodo" (onChange)="load()" optionLabel="label" optionValue="value" styleClass="cb-sel" ariaLabel="Filtrar por método de pago" /></div>
        <div class="cb-field cb-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Folio, proveedor, RFC, monto…" (keyup.enter)="load()" (blur)="queue()" /></div>
        <div class="cb-field"><label>&nbsp;</label>
          <button pButton type="button" size="small" [outlined]="!soloAlertas()" severity="danger" (click)="toggleAlertas()" [attr.aria-pressed]="soloAlertas()" title="Solo pagos con alerta de control (cuenta ajena / clave repetida)"><span class="p-button-icon p-button-icon-left pi pi-flag" aria-hidden="true"></span><span class="p-button-label">Solo alertas</span></button></div>
      </div>

      @if (report(); as r) { <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen" /> }

      @if (error()) {
        <app-load-state [error]="error()" (retry)="load()"></app-load-state>
      } @else {
      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm cb-table" [rowHover]="true" [scrollable]="true" scrollHeight="62vh"
                 [paginator]="rows().length > 150" [rows]="150" [loading]="loading()">
          <ng-template #header>
            <tr>
              <th style="width:6rem">Fecha</th>
              <th style="width:7rem">Folio</th>
              <th style="width:7rem">Método</th>
              <th>Proveedor</th>
              <th>Concepto</th>
              <th class="ta-r" style="width:9rem">Monto</th>
              <th style="width:11rem">Comprobante</th>
              <th style="width:12rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr>
              <td>{{ c.pago_date | date:'dd/MM/yy' }}</td>
              <td class="mono">{{ c.folio }}</td>
              <td><span class="cb-metodo" [class.tra]="c.metodo_pago === 'transferencia'" [class.che]="c.metodo_pago === 'cheque'" [class.ant]="c.metodo_pago === 'anticipo'"><i class="pi" [ngClass]="c.metodo_pago === 'cheque' ? 'pi-book' : c.metodo_pago === 'anticipo' ? 'pi-wallet' : 'pi-send'"></i> {{ metodoLabel(c.metodo_pago) }}</span></td>
              <td>{{ c.proveedor_nombre || c.proveedor_code || '—' }}<div class="cb-sub">{{ c.proveedor_rfc || c.proveedor_code }}</div></td>
              <td class="muted cb-concepto" [title]="c.concepto">{{ c.concepto || '—' }}</td>
              <td class="ta-r strong">{{ money(c.monto) }}</td>
              <td class="cb-comp-cell" (click)="openView(c)" [title]="c.deposits > 0 ? 'Ver comprobante adjunto' : 'Adjuntar comprobante'">
                @if (c.deposits > 0) {
                  <div class="cb-comp">
                    <p-tag [value]="depLabel(c.deposit_status)" [severity]="depSev(c.deposit_status)" />
                    <span class="cb-match" [class.ok]="c.monto_match" [class.bad]="!c.monto_match" [title]="c.monto_match ? 'El monto del comprobante cuadra con el pago' : 'El monto del comprobante NO cuadra'">
                      <i class="pi" [ngClass]="c.monto_match ? 'pi-check-circle' : 'pi-exclamation-triangle'"></i>
                    </span>
                    @if (c.alerta) { <span class="cb-alert" [title]="alertTitle(c)"><i class="pi pi-flag-fill" aria-hidden="true"></i></span> }
                    <i class="pi pi-eye cb-eye" aria-hidden="true"></i>
                  </div>
                } @else { <span class="muted cb-comp-empty"><i class="pi pi-paperclip" aria-hidden="true"></i> Sin comprobante</span> }
              </td>
              <td>
                <button pButton type="button" size="small" text (click)="openAttach(c)" [title]="c.deposits > 0 ? 'Agregar otro comprobante' : 'Adjuntar comprobante'"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">{{ c.deposits > 0 ? 'Otro' : 'Adjuntar' }}</span></button>
                @if (c.deposit_id && canManage()) {
                  @if (c.deposit_status !== 'validado') { <button pButton type="button" size="small" text severity="success" [loading]="actingId() === c.deposit_id" [disabled]="!!actingId()" (click)="doValidate(c)" title="Validar"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                  @if (c.deposit_status !== 'rechazado') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(c)" title="Rechazar"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button> }
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="8" class="cb-empty">Sin pagos para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
      }
    </div>

    <!-- Diálogo: adjuntar comprobante + OCR (soporta ficha-first sin pago preseleccionado) -->
    <p-dialog [(visible)]="showAttach" [modal]="true" [style]="{ width: '38rem' }" [draggable]="false" [header]="attachTarget() ? 'Adjuntar comprobante de pago' : 'Capturar comprobante de pago'">
      @if (attachTarget() || captureMode()) {
        <div class="cb-form">
          @if (attachTarget(); as t) {
          <div class="cb-cobro">
            <div><span class="cb-lbl">Pago</span><strong class="mono">{{ t.sucursal }}/{{ t.folio }}</strong></div>
            <div><span class="cb-lbl">Método</span><strong>{{ metodoLabel(t.metodo_pago) }}</strong></div>
            <div><span class="cb-lbl">Proveedor</span><strong>{{ t.proveedor_nombre || t.proveedor_code }}</strong></div>
            <div class="ta-r"><span class="cb-lbl">Monto del pago</span><strong class="cb-monto">{{ money(t.monto) }}</strong></div>
          </div>
          } @else {
          <div class="cb-cap-banner"><i class="pi pi-bolt"></i> Sube el comprobante — buscamos el pago por ti (monto + factura).</div>
          }

          <div class="cb-f cb-file">
            <span>Comprobante de pago (PDF) * <em class="cb-auto">SPEI/cheque — se lee y liga el pago solo</em></span>
            <div class="cb-pick cb-droppable" [class.drag]="dragging()" (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
              <label class="cb-pickbtn"><i class="pi pi-file-pdf"></i> Elegir PDF
                <input type="file" accept="application/pdf" (change)="onFile($event)" hidden />
              </label>
              <span class="cb-drop-hint"><i class="pi pi-cloud-upload" aria-hidden="true"></i> o arrastrá el PDF aquí</span>
            </div>
            @if (fileName()) { <span class="cb-filepick"><i class="pi pi-paperclip"></i> {{ fileName() }}</span> }
          </div>

          @if (fileName()) {
            <div class="cb-preview">
              @if (isImageFile()) {
                <img [src]="fileData" alt="Previsualización del comprobante" />
              } @else if (isPdfFile()) {
                <div class="cb-preview-pdf"><i class="pi pi-file-pdf"></i><div class="cb-preview-pdf-txt"><strong>{{ fileName() }}</strong><span>PDF listo — se lee con OCR (los datos aparecen abajo)</span></div></div>
              }
            </div>
          }

          @if (fileName()) {
            <div class="cb-ocr-actions">
              @if (uploading() || ocrLoading()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> {{ (uploading() && ocrLoading()) ? 'Almacenando imagen y leyendo comprobante…' : uploading() ? 'Almacenando imagen…' : 'Leyendo el comprobante…' }}</span>
              } @else {
                @if (uploadedFile()) { <span class="cb-stored"><i class="pi pi-check-circle"></i> Imagen almacenada</span> }
                @if (ocrRun()) {
                  @if (matchState() === true) { <p-tag value="Cuadra con el pago" severity="success" /> }
                  @else if (matchState() === false) { <p-tag [value]="'Difiere ' + money(diff())" severity="danger" /> }
                  @if (ocrForm.ocr_status === 'sin_key') { <span class="cb-hint">OCR no disponible — captura a mano.</span> }
                  @else if (ocrForm.ocr_status === 'ilegible') { <span class="cb-hint">No se pudo leer — captura a mano.</span> }
                }
                <button pButton type="button" size="small" text (click)="runOcr()" title="Volver a leer con OCR"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Releer</span></button>
              }
            </div>
          }

          <!-- ficha-first: buscar el pago por el OCR -->
          @if (captureMode() && !attachTarget() && ocrRun()) {
            <div class="cb-match">
              <div class="cb-match-row2">
                <!-- Buscar es BUSCAR: acá sí se puede tantear otro importe para dar con el
                     pago si el OCR leyó mal. Lo que cambia es que ya no escribe sobre la
                     lectura del modelo — antes eran los mismos ocrForm.*, o sea que tantear
                     terminaba guardado como "lo que leyó Claude Vision". -->
                <label class="cb-f cb-grow"><span>Buscar por monto <em class="cb-auto">tanteá otro importe si el OCR leyó mal</em></span>
                  <p-inputnumber [(ngModel)]="buscarMonto" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
                <label class="cb-f cb-grow"><span>Concepto / factura</span>
                  <input pInputText [(ngModel)]="buscarConcepto" placeholder="F 451" /></label>
                <button pButton type="button" size="small" (click)="runCapMatch()" [loading]="capMatching()"><span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Buscar pago</span></button>
              </div>
              @if (capMatching()) {
                <div class="cb-view-loading"><i class="pi pi-spin pi-spinner"></i> Buscando el pago…</div>
              } @else if (capMatches().length) {
                <div class="cb-fields-head">Pagos con ese monto <em class="cb-auto">elige el que corresponde</em></div>
                @for (c of capMatches(); track c.doc_prefix + c.sucursal + c.folio) {
                  <div class="cb-cand" (click)="pickPago(c)">
                    <div class="cb-cand-info">
                      <strong class="mono">{{ c.doc_prefix }} {{ c.sucursal }}/{{ c.folio }}</strong>
                      <span>{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
                      <span class="cb-sub">{{ c.pago_date | date:'dd/MM/yy' }} · {{ money(c.monto) }} · {{ c.concepto || '—' }}@if (c.concepto_match) { · <em class="cb-has-ok">factura coincide</em> }@if (c.deposits > 0) { · <em class="cb-has">ya tiene comprobante</em> }</span>
                    </div>
                    <button pButton type="button" size="small"><span class="p-button-label">Es este</span></button>
                  </div>
                }
              } @else {
                <p class="muted">No encontramos un pago con ese monto. Búscalo a mano:</p>
                <div class="cb-match-row2">
                  <input pInputText class="cb-grow" [(ngModel)]="capManualSearch" placeholder="Folio, proveedor, RFC, monto…" (keyup.enter)="capManualSearchRun()" />
                  <button pButton type="button" size="small" text (click)="capManualSearchRun()"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                </div>
                @for (c of capManualResults(); track c.doc_prefix + c.sucursal + c.folio) {
                  <div class="cb-cand" (click)="pickPago(c)">
                    <div class="cb-cand-info">
                      <strong class="mono">{{ c.doc_prefix }} {{ c.sucursal }}/{{ c.folio }}</strong>
                      <span>{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
                      <span class="cb-sub">{{ c.pago_date | date:'dd/MM/yy' }} · {{ metodoLabel(c.metodo_pago) }} · {{ money(c.monto) }}</span>
                    </div>
                    <button pButton type="button" size="small"><span class="p-button-label">Es este</span></button>
                  </div>
                }
              }
            </div>
          }

          @if (attachTarget() && fileName()) {
            <!-- Lo que leyó Claude Vision del comprobante es EVIDENCIA, no un formulario:
                 de estos valores salen el cuadre contra el pago de Kepler, el control de
                 "salió de una cuenta nuestra" y el de clave de rastreo repetida. -->
            <div class="cb-fields-head">Lo que leyó Claude Vision
              <em class="cb-auto">del comprobante de pago · es la evidencia, no se edita</em></div>
            <dl class="cb-read">
              <div><dt>Monto</dt><dd class="cb-num">{{ ocrForm.monto != null ? money(ocrForm.monto) : '—' }}</dd></div>
              <div><dt>Fecha</dt><dd class="cb-num">{{ ocrForm.fecha || '—' }}</dd></div>
              <div><dt>Concepto (factura)</dt><dd class="cb-num">{{ ocrForm.concepto || '—' }}</dd></div>
              <div><dt>Clave de rastreo</dt><dd class="cb-num">{{ ocrForm.clave_rastreo || '—' }}</dd></div>
              <div><dt>Cuenta origen (propia)</dt><dd class="cb-num">{{ ocrForm.cuenta_origen || '—' }}</dd></div>
              <div><dt>Cuenta destino (prov.)</dt><dd class="cb-num">{{ ocrForm.cuenta_destino || '—' }}</dd></div>
              <div><dt>Banco destino</dt><dd>{{ ocrForm.banco_destino || '—' }}</dd></div>
              <div class="cb-read-wide"><dt>Beneficiario</dt><dd>{{ ocrForm.beneficiario || '—' }}</dd></div>
            </dl>
            <p class="cb-read-out">Si algo quedó mal leído: <button type="button" class="cb-linkbtn" (click)="runOcr()">releer</button>, subí un archivo mejor, o guardá así y que se resuelva al validar.</p>
          }

          <!-- PC.2 — foto(s) del gasto (evidencia de lo comprado); Σ se valida contra el pago -->
          @if (attachTarget()) {
            <div class="cb-gasto">
              <div class="cb-gasto-head">
                <span>Foto(s) del gasto <em class="cb-auto">factura/ticket/mercancía — el total se valida vs el pago</em></span>
                @if (gastoMatch() === true) { <p-tag value="Cuadra con el pago" severity="success" /> }
                @else if (gastoMatch() === false) { <p-tag [value]="'Difiere ' + money(gastoDiff())" severity="danger" /> }
              </div>
              <div class="cb-pick cb-droppable" [class.drag]="dragging()" (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onGastoDrop($event)">
                <label class="cb-pickbtn cb-cam"><i class="pi pi-camera"></i> Tomar foto
                  <input type="file" accept="image/*" capture="environment" (change)="onGastoFiles($event)" hidden multiple />
                </label>
                <label class="cb-pickbtn"><i class="pi pi-images"></i> Elegir fotos
                  <input type="file" accept="image/*,.pdf" (change)="onGastoFiles($event)" hidden multiple />
                </label>
                <span class="cb-drop-hint"><i class="pi pi-cloud-upload" aria-hidden="true"></i> o arrastrá aquí</span>
              </div>
              @for (g of gastoFiles(); track g.id) {
                <div class="cb-gasto-item">
                  <div class="cb-gasto-thumb">@if (g.kind === 'image') { <img [src]="g.dataUri" [alt]="g.name" /> } @else { <i class="pi pi-file-pdf" aria-hidden="true"></i> }</div>
                  <div class="cb-gasto-body">
                    <div class="cb-gasto-name" [title]="g.name">{{ g.name }}</div>
                    <div class="cb-gasto-meta">
                      @if (g.ocrLoading) { <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> leyendo total…</span> }
                      @else { <span>Total <strong>{{ g.ocrMonto != null ? money(g.ocrMonto) : '—' }}</strong></span> }
                      @if (g.uploading) { <i class="pi pi-spin pi-spinner" title="subiendo"></i> }
                      @else if (g.uploaded) { <i class="pi pi-check-circle cb-gasto-ok" title="almacenada"></i> }
                      @else if (g.failed) { <i class="pi pi-exclamation-triangle cb-gasto-bad" title="falló la subida"></i> }
                    </div>
                  </div>
                  <button type="button" class="cb-gasto-x" (click)="removeGasto(g.id)" [attr.aria-label]="'Quitar ' + g.name"><i class="pi pi-times" aria-hidden="true"></i></button>
                </div>
              }
              @if (gastoFiles().length) {
                <div class="cb-gasto-total">Σ gastos <strong>{{ money(gastoTotal()) }}</strong> · Pago <strong>{{ money(attachTarget()!.monto) }}</strong></div>
              }
            </div>
          }
          @if (attachError()) { <div class="cb-err">{{ attachError() }}</div> }
        </div>
        <ng-template #footer>
          <button pButton type="button" text (click)="showAttach.set(false)"><span class="p-button-label">Cancelar</span></button>
          @if (attachTarget()) {
            <button pButton type="button" [loading]="saving()" [disabled]="!fileData || uploading() || gastoBusy()" (click)="saveAttach()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar</span></button>
          }
        </ng-template>
      }
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [(visible)]="showReject" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar comprobante">
      <div class="cb-form">
        <p class="muted">Pago <strong>{{ rejectTarget()?.folio }}</strong> · {{ rejectTarget()?.proveedor_nombre }}</p>
        <label class="cb-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. comprobante ilegible, monto no cuadra, no corresponde…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: ver comprobante(s) adjunto(s) -->
    <p-dialog [(visible)]="showView" [modal]="true" [style]="{ width: '46rem' }" [draggable]="false" header="Comprobante del pago">
      @if (viewData(); as v) {
        <div class="cb-form">
          <div class="cb-cobro">
            <div><span class="cb-lbl">Pago</span><strong class="mono">{{ v.pago.sucursal }}/{{ v.pago.folio }}</strong></div>
            <div><span class="cb-lbl">Método</span><strong>{{ metodoLabel(v.pago.metodo_pago || null) }}</strong></div>
            <div><span class="cb-lbl">Proveedor</span><strong>{{ v.pago.proveedor_nombre || v.pago.proveedor_code }}</strong></div>
            <div class="ta-r"><span class="cb-lbl">Monto del pago</span><strong class="cb-monto">{{ money(v.pago.monto) }}</strong></div>
          </div>

          @if (!v.deposits.length) { <p class="muted cb-view-none">Este pago aún no tiene comprobante adjunto.</p> }
          @for (d of v.deposits; track d.id) {
            <div class="cb-view-dep">
              <div class="cb-view-head">
                <p-tag [value]="depLabel(d.status)" [severity]="depSev(d.status)" />
                @if (d.monto_match === true) { <p-tag value="Cuadra" severity="success" /> }
                @else if (d.monto_match === false) { <p-tag value="No cuadra" severity="danger" /> }
                @if (d.cuenta_propia === true) { <p-tag value="Cuenta propia" severity="success" /> }
                @else if (d.cuenta_propia === false) { <p-tag value="Cuenta origen NO reconocida" severity="danger" /> }
                @if (d.ref_duplicada) { <p-tag value="Clave duplicada" severity="warn" /> }
                <span class="cb-view-meta">{{ d.created_by || '—' }} · {{ d.created_at | date:'dd/MM/yy HH:mm' }}</span>
              </div>
              @if (d.ref_duplicada && d.ref_otros?.length) {
                <div class="cb-alert-note"><i class="pi pi-flag-fill"></i> Misma clave de rastreo en: <strong>{{ d.ref_otros?.join(', ') }}</strong> — ¿transferencia repetida?</div>
              }
              @if (d.cuenta_propia === false) {
                <div class="cb-alert-note bad"><i class="pi pi-exclamation-triangle"></i> La cuenta de origen del pago no coincide con ninguna cuenta de la empresa.</div>
              }
              <div class="cb-view-files">
                @for (f of d.files; track f.url) {
                  @if (isImageUrl(f)) {
                    <a [href]="f.url" target="_blank" rel="noopener" class="cb-view-img"><img [src]="f.url" [alt]="f.name || 'comprobante'" /></a>
                  } @else {
                    <a class="cb-view-pdf" [href]="f.url" target="_blank" rel="noopener"><i class="pi pi-file-pdf"></i> Abrir {{ f.name || 'comprobante (PDF)' }} <i class="pi pi-external-link"></i></a>
                  }
                }
                @if (!d.files.length) { <span class="muted">Sin archivo.</span> }
              </div>
              <div class="cb-view-ocr">
                <span><em>Monto OCR</em> {{ d.ocr_monto != null ? money(d.ocr_monto) : '—' }}</span>
                <span><em>Fecha</em> {{ d.ocr_fecha || '—' }}</span>
                <span><em>Concepto</em> {{ d.ocr_concepto || '—' }}</span>
                <span><em>Clave</em> {{ d.ocr_referencia || '—' }}</span>
                @if (d.ocr_cuenta_origen) { <span><em>Cta. origen</em> {{ d.ocr_cuenta_origen }}</span> }
                @if (d.ocr_cuenta_dest) { <span><em>Cta. dest.</em> {{ d.ocr_cuenta_dest }}</span> }
                @if (d.ocr_ordenante) { <span><em>Beneficiario</em> {{ d.ocr_ordenante }}</span> }
                @if (d.ocr_banco) { <span><em>Banco dest.</em> {{ d.ocr_banco }}</span> }
              </div>
              @if (d.banco; as bk) {
                @if (bk.conciliado) {
                  <div class="cb-bank ok">
                    <div class="cb-bank-head"><i class="pi pi-verified"></i> <strong>Conciliado con el banco (cargo)</strong></div>
                    @for (m of bk.matched; track m.id) {
                      <div class="cb-bank-mov">
                        <span class="mono">{{ m.bank }} {{ m.account_label }}</span>
                        <span>{{ m.movement_date | date:'dd/MM/yy' }}</span>
                        <span class="strong">{{ money(m.amount_out) }}</span>
                        <span class="muted cb-bank-concept" [title]="m.concept">{{ m.concept || '—' }}</span>
                        @if (canManage()) { <button pButton type="button" size="small" text severity="secondary" [loading]="actingId() === d.id + m.id" (click)="doUnlinkBank(d.id, m.id)" title="Deshacer"><span class="p-button-icon pi pi-link" aria-hidden="true"></span></button> }
                      </div>
                      @if (m.matched_by) { <span class="cb-bank-by">por {{ m.matched_by }} · {{ m.matched_at | date:'dd/MM/yy HH:mm' }}</span> }
                    }
                  </div>
                } @else {
                  <div class="cb-bank" [class.warn]="bk.estado === 'multiple'" [class.bad]="bk.estado === 'sin_match'">
                    <div class="cb-bank-head"><i class="pi" [ngClass]="bankIcon(bk.estado)"></i> <strong>{{ bankLabel(bk.estado) }}</strong></div>
                    @for (m of bk.candidatos; track m.id) {
                      <div class="cb-bank-mov">
                        <span class="mono">{{ m.bank }} {{ m.account_label }}</span>
                        <span>{{ m.movement_date | date:'dd/MM/yy' }}</span>
                        <span class="strong">{{ money(m.amount_out) }}</span>
                        <span class="muted cb-bank-concept" [title]="m.concept">{{ m.concept || '—' }}</span>
                        @if (canManage()) { <button pButton type="button" size="small" text severity="success" [loading]="actingId() === d.id + m.id" (click)="doConfirmBank(d.id, m.id)" title="Confirmar que este cargo es el del pago"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                      </div>
                    }
                  </div>
                }
              }
              @if (d.status === 'rechazado' && d.motivo_rechazo) { <div class="cb-err">Rechazado: {{ d.motivo_rechazo }}</div> }
              @if (d.comentarios) { <div class="cb-view-coment">{{ d.comentarios }}</div> }
            </div>
          }

          @if (v.adjustments?.rows?.length) {
            <div class="cb-adj">
              <div class="cb-adj-head">
                <span class="cb-adj-title"><i class="pi pi-percentage"></i> Descuentos y notas de crédito del proveedor</span>
                <button pButton type="button" size="small" text (click)="openDescuentos(v.adjustments?.deep_link_q)" title="Ver en Compras · Descuentos y apoyos"><span class="p-button-label">Ver en Compras</span><span class="p-button-icon p-button-icon-right pi pi-arrow-up-right" aria-hidden="true"></span></button>
              </div>
              <p class="cb-adj-note">Explican por qué el banco pagó ≠ factura. Registradas en Kepler (X-D-55 / X-D-40) — no cuadre al peso, contexto de RE.10.</p>
              @if (v.adjustments?.total_factura) {
                <div class="cb-adj-kpi"><strong>{{ money(v.adjustments?.total_factura || 0) }}</strong> ligado a la(s) factura(s) de este pago · <span class="muted">{{ money(v.adjustments?.total_monto || 0) }} en la ventana</span></div>
              } @else {
                <div class="cb-adj-kpi muted">{{ money(v.adjustments?.total_monto || 0) }} en ajustes del proveedor (ventana ±60 días)</div>
              }
              <div class="cb-adj-scroll">
                <table class="cb-adj-tbl">
                  <tbody>
                    @for (a of v.adjustments?.rows || []; track $index) {
                      <tr [class.cb-adj-hit]="a.factura_match">
                        <td class="mono">{{ a.adjustment_date | date:'dd/MM/yy' }}</td>
                        <td>{{ a.doctype === 'XD40' ? 'Devolución' : 'Nota créd.' }}</td>
                        <td class="cb-adj-mot" [title]="a.motivo || a.factura_ref || ''">{{ a.factura_ref || a.motivo || '—' }}</td>
                        <td><span class="cb-adj-cat">{{ catLabel(a.categoria) }}</span></td>
                        <td class="ta-r strong">{{ money(a.monto) }}@if (a.factura_match) { <i class="pi pi-link cb-adj-link" title="Coincide con la factura de este pago"></i> }</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }
        </div>
        <ng-template #footer>
          <button pButton type="button" text (click)="showView.set(false)"><span class="p-button-label">Cerrar</span></button>
          <button pButton type="button" (click)="fromViewToAttach()"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">Agregar comprobante</span></button>
        </ng-template>
      } @else {
        <div class="cb-view-loading"><i class="pi pi-spin pi-spinner"></i> Cargando comprobante…</div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .cb-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .cb-field { display: flex; flex-direction: column; gap: .3rem; }
    .cb-field > label { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-field.cb-grow { flex: 1 1 16rem; }
    .cb-sel { min-width: 11rem; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .cb-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cb-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .cb-table .strong { font-weight: 600; color: var(--text-main); }
    .cb-table .muted { color: var(--text-muted); }
    .cb-sub { font-size: .7rem; color: var(--text-muted); }
    .cb-metodo { display: inline-flex; align-items: center; gap: .3rem; font-size: .75rem; color: var(--text-muted); white-space: nowrap; }
    .cb-metodo i { font-size: .7rem; }
    .cb-metodo.tra { color: var(--action); }
    .cb-metodo.che { color: var(--text-main); }
    .cb-metodo.ant { color: var(--warn-fg, #b45309); }
    .cb-concepto { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: var(--font-mono); font-size: .85em; }
    .cb-comp { display: inline-flex; align-items: center; gap: .45rem; }
    .cb-match.ok { color: var(--ok-fg); }
    .cb-match.bad { color: var(--bad-fg); }
    .cb-empty { text-align: center; color: var(--text-muted); padding: 2rem; }
    .cb-form { display: flex; flex-direction: column; gap: .85rem; padding: .25rem 0; }
    .cb-cobro { display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: flex-end; padding: .7rem .9rem; background: var(--surface-sunken, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); }
    .cb-cobro > div { display: flex; flex-direction: column; gap: .15rem; }
    .cb-lbl { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-monto { color: var(--action); font-size: 1.05rem; font-family: var(--font-mono); }
    .cb-f { display: flex; flex-direction: column; gap: .3rem; }
    .cb-f > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-pick { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    /* PC.1 — arrastrar el comprobante */
    .cb-droppable { padding: .6rem; border: 2px dashed var(--border-color); border-radius: var(--r-md, .5rem); transition: border-color .15s, background .15s; }
    .cb-droppable.drag { border-color: var(--action); background: var(--action-soft-bg, rgba(0,0,0,.03)); }
    .cb-drop-hint { font-size: .76rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .3rem; }
    /* PC.2 — foto(s) del gasto */
    .cb-gasto { display: flex; flex-direction: column; gap: .5rem; border-top: 1px solid var(--border-color); padding-top: .8rem; margin-top: .3rem; }
    .cb-gasto-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; font-size: .82rem; font-weight: 600; color: var(--text-main); }
    .cb-gasto-item { display: flex; align-items: center; gap: .7rem; padding: .45rem .55rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .cb-gasto-thumb { flex: 0 0 auto; width: 2.8rem; height: 2.8rem; border-radius: var(--r-sm, .4rem); overflow: hidden; display: flex; align-items: center; justify-content: center; background: #00000010; }
    .cb-gasto-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .cb-gasto-thumb .pi-file-pdf { font-size: 1.3rem; color: var(--bad-fg); }
    .cb-gasto-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: .2rem; }
    .cb-gasto-name { font-size: .8rem; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-gasto-meta { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--text-muted); }
    .cb-gasto-meta strong { font-family: var(--font-mono); color: var(--text-main); }
    .cb-gasto-ok { color: var(--ok-fg); } .cb-gasto-bad { color: var(--bad-fg); }
    .cb-gasto-x { flex: 0 0 auto; border: none; background: transparent; cursor: pointer; color: var(--text-muted); padding: .2rem .3rem; border-radius: var(--r-sm, .4rem); }
    .cb-gasto-x:hover { color: var(--bad-fg); background: var(--surface-hover, rgba(0,0,0,.04)); }
    .cb-gasto-total { display: flex; justify-content: flex-end; gap: 1rem; font-size: .82rem; color: var(--text-muted); }
    .cb-gasto-total strong { font-family: var(--font-mono); color: var(--text-main); }
    .cb-pickbtn { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); font-size: .85rem; color: var(--text-main); cursor: pointer; background: var(--card-bg); transition: border-color .15s, color .15s; }
    .cb-pickbtn:hover { border-color: var(--action); color: var(--action); }
    .cb-pickbtn i { font-size: .95rem; }
    .cb-filepick { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-ocr-actions { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
    .cb-hint { font-size: .74rem; color: var(--text-muted); }
    .cb-proc { font-size: .8rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; }
    .cb-stored { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-auto { font-style: normal; font-size: .68rem; color: var(--text-muted); text-transform: none; letter-spacing: 0; opacity: .8; }
    /* Lectura del modelo: se ve como dato leído, no como campos deshabilitados. Un input
       gris dice "ahorita no se puede"; lo que hay que decir es "esto no se toca". */
    .cb-read { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
      gap: var(--sp-3); margin: var(--sp-2) 0 0; padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cb-read > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cb-read-wide { grid-column: 1 / -1; }
    .cb-read dt { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .cb-read dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1);
      overflow: hidden; text-overflow: ellipsis; }
    .cb-read .cb-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cb-read-out { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.45; }
    .cb-linkbtn { padding: 0; border: 0; background: none; font: inherit; color: var(--action);
      cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .cb-linkbtn:hover { color: var(--action-hover); }
    .cb-linkbtn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .cb-fields-head { font-size: .8rem; font-weight: 600; color: var(--text-main); margin-top: .3rem; }
    .cb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; border-top: 1px solid var(--border-color); padding-top: .8rem; }
    .cb-err { color: var(--bad-fg); font-size: .82rem; }
    .w-full { width: 100%; }
    /* columna Comprobante clickable */
    .cb-comp-cell { cursor: pointer; }
    .cb-comp-cell:hover { background: var(--surface-hover, rgba(0,0,0,.03)); }
    .cb-eye { color: var(--text-muted); font-size: .8rem; opacity: 0; transition: opacity .15s; }
    .cb-comp-cell:hover .cb-eye { opacity: .8; }
    .cb-comp-empty { display: inline-flex; align-items: center; gap: .35rem; }
    .cb-comp-empty i { font-size: .75rem; opacity: .7; }
    /* preview antes de subir */
    .cb-preview { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); overflow: hidden; background: var(--surface-sunken, var(--card-bg)); }
    .cb-preview img { display: block; width: 100%; max-height: 15rem; object-fit: contain; background: #00000008; }
    .cb-preview-pdf { display: flex; align-items: center; gap: .7rem; padding: .8rem 1rem; }
    .cb-preview-pdf > i { font-size: 1.8rem; color: var(--bad-fg); }
    .cb-preview-pdf-txt { display: flex; flex-direction: column; gap: .1rem; }
    .cb-preview-pdf-txt strong { font-size: .9rem; color: var(--text-main); }
    .cb-preview-pdf-txt span { font-size: .74rem; color: var(--text-muted); }
    /* view dialog */
    .cb-view-none { padding: .6rem 0; }
    .cb-view-loading { display: flex; align-items: center; gap: .5rem; color: var(--text-muted); padding: 2rem; justify-content: center; }
    .cb-view-dep { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .8rem .9rem; display: flex; flex-direction: column; gap: .6rem; }
    .cb-view-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .cb-view-meta { font-size: .74rem; color: var(--text-muted); margin-left: auto; }
    .cb-view-files { display: flex; flex-wrap: wrap; gap: .6rem; }
    .cb-view-img { display: block; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); overflow: hidden; max-width: 100%; }
    .cb-view-img img { display: block; max-height: 22rem; max-width: 100%; object-fit: contain; background: #00000008; }
    .cb-view-pdf { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); color: var(--action); text-decoration: none; font-size: .85rem; }
    .cb-view-pdf:hover { border-color: var(--action); }
    .cb-view-pdf .pi-file-pdf { color: var(--bad-fg); }
    .cb-view-ocr { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; font-size: .78rem; color: var(--text-main); }
    .cb-view-ocr em { font-style: normal; color: var(--text-muted); margin-right: .3rem; }
    .cb-view-coment { font-size: .8rem; color: var(--text-muted); font-style: italic; }
    .cb-alert { color: var(--bad-fg); display: inline-flex; }
    .cb-alert i { font-size: .8rem; }
    .cb-alert-note { font-size: .78rem; color: var(--warn-fg); display: flex; align-items: baseline; gap: .4rem; background: var(--surface-sunken, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .45rem .6rem; }
    .cb-alert-note.bad { color: var(--bad-fg); }
    .cb-alert-note i { font-size: .8rem; }
    .cb-cap-bar { display: flex; align-items: center; gap: .8rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .cb-cap-hint { font-size: .8rem; color: var(--text-muted); }
    .cb-live { display: inline-flex; align-items: center; gap: .4rem; margin-left: auto; font-size: .74rem; color: var(--ok-fg); font-weight: 600; }
    .cb-live-dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--ok-fg); animation: cb-pulse 1.8s ease-in-out infinite; }
    @keyframes cb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
    @media (prefers-reduced-motion: reduce) { .cb-live-dot { animation: none; } }
    .cb-cap-banner { display: flex; align-items: center; gap: .5rem; font-size: .84rem; color: var(--action); background: color-mix(in srgb, var(--action) 8%, transparent); border: 1px solid color-mix(in srgb, var(--action) 25%, transparent); border-radius: var(--r-sm, .4rem); padding: .5rem .7rem; }
    .cb-match { display: flex; flex-direction: column; gap: .6rem; border-top: 1px solid var(--border-color); padding-top: .8rem; }
    .cb-match-row2 { display: flex; gap: .5rem; align-items: flex-end; flex-wrap: wrap; }
    .cb-grow { flex: 1 1 8rem; }
    .cb-cand { display: flex; align-items: center; justify-content: space-between; gap: .8rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .5rem .7rem; cursor: pointer; transition: border-color .12s; }
    .cb-cand:hover { border-color: var(--action); }
    .cb-cand-info { display: flex; flex-direction: column; gap: .1rem; }
    .cb-cand-info > span { font-size: .82rem; color: var(--text-main); }
    .cb-has { font-style: normal; color: var(--warn-fg); }
    .cb-has-ok { font-style: normal; color: var(--ok-fg); }
    .cb-bank { border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-sm, .4rem); padding: .5rem .7rem; display: flex; flex-direction: column; gap: .35rem; font-size: .78rem; }
    .cb-bank.ok { border-left-color: var(--ok-fg); }
    .cb-bank.warn { border-left-color: var(--warn-fg); }
    .cb-bank.bad { border-left-color: var(--bad-fg); }
    .cb-bank-head { display: flex; align-items: center; gap: .4rem; }
    .cb-bank.ok .cb-bank-head { color: var(--ok-fg); }
    .cb-bank.warn .cb-bank-head { color: var(--warn-fg); }
    .cb-bank.bad .cb-bank-head { color: var(--bad-fg); }
    .cb-bank-mov { display: grid; grid-template-columns: 6rem 4.5rem auto 1fr auto; gap: .5rem; align-items: center; color: var(--text-main); }
    .cb-bank-concept { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-bank-by { font-size: .7rem; color: var(--text-muted); }
    /* descuentos / notas de crédito del proveedor (enlace a /compras/descuentos, RE.10) */
    .cb-adj { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .7rem .85rem; background: var(--surface-sunken, var(--card-bg)); display: flex; flex-direction: column; gap: .5rem; }
    .cb-adj-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .cb-adj-title { font-weight: 600; font-size: .86rem; display: inline-flex; align-items: center; gap: .4rem; }
    .cb-adj-title i { color: var(--action); }
    .cb-adj-note { font-size: .74rem; color: var(--text-muted); margin: 0; }
    .cb-adj-kpi { font-size: .82rem; }
    .cb-adj-kpi strong { color: var(--action); font-family: var(--font-mono); }
    .cb-adj-scroll { max-height: 15rem; overflow-y: auto; }
    .cb-adj-tbl { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .cb-adj-tbl td { padding: .28rem .4rem; border-bottom: 1px solid var(--border-color); }
    .cb-adj-tbl tr:last-child td { border-bottom: 0; }
    .cb-adj-tbl .ta-r { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cb-adj-hit td { background: var(--hover-bg); }
    .cb-adj-mot { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .cb-adj-cat { font-size: .72rem; color: var(--text-muted); }
    .cb-adj-link { color: var(--action); margin-left: .3rem; font-size: .75rem; }
  `],
})
export class FinanzasPagosComprobantesComponent implements OnInit, OnDestroy {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(PagosComprobantesService);
  private readonly socket = inject(PagosComprobantesSocketService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  /** WS en vivo: refresca la tabla cuando otro usuario adjunta/valida/rechaza/concilia. */
  readonly live = this.socket.connected;
  private wsTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WS_VERB: Record<PaymentProofEvent['action'], string> = {
    attached: 'adjuntó un comprobante', validated: 'validó un pago', rejected: 'rechazó un comprobante',
    bank_matched: 'concilió un pago con el banco', bank_unmatched: 'deshizo una conciliación',
  };

  readonly report = signal<PagosReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly actingId = signal<string | null>(null);
  readonly estadoSel = signal<string>('pendiente');
  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_PAYMENTS_GESTIONAR] === true);

  readonly estadoOpts = [{ label: 'Pendientes', value: 'pendiente' }, { label: 'Con comprobante', value: 'con_comprobante' }, { label: 'Validados', value: 'validado' }, { label: 'Todos', value: '' }];
  search = '';
  // filtros: año (2025→hoy), mes, método de pago, solo alertas
  anio = '';
  mes = '';
  metodo = '';
  readonly soloAlertas = signal(false);
  readonly anioOpts = [{ label: 'Todos los años', value: '' },
    ...Array.from({ length: (new Date().getFullYear() - 2025) + 1 }, (_, i) => { const y = new Date().getFullYear() - i; return { label: String(y), value: String(y) }; })];
  readonly mesOpts = [{ label: 'Todos los meses', value: '' },
    ...['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'].map((n, i) => ({ label: n, value: String(i + 1) }))];
  readonly metodoOpts = [{ label: 'Todos los métodos', value: '' }, { label: 'Transferencia', value: 'transferencia' }, { label: 'Cheque', value: 'cheque' }, { label: 'Anticipo', value: 'anticipo' }];
  private timer: ReturnType<typeof setTimeout> | null = null;

  // attach dialog
  readonly showAttach = signal(false);
  readonly attachTarget = signal<PagoRow | null>(null);
  readonly fileName = signal<string>('');
  readonly ocrLoading = signal(false);
  readonly ocrRun = signal(false);
  readonly uploading = signal(false);
  readonly uploadedFile = signal<ProofFile | null>(null);
  readonly attachError = signal<string>('');
  fileData: string | null = null;
  ocrForm: Partial<DepositOcr> = {};
  /** Con qué se BUSCA el pago. Arranca en lo que leyó el modelo, pero es propio:
   *  tantear acá no puede cambiar la evidencia que se guarda. */
  buscarMonto: number | null = null;
  buscarConcepto = '';
  // ficha-first (captura sin elegir pago)
  readonly captureMode = signal(false);
  readonly capMatching = signal(false);
  readonly capMatches = signal<PagoCandidate[]>([]);
  capManualSearch = '';
  readonly capManualResults = signal<PagoCandidate[]>([]);
  // PC.2 — foto(s) del gasto (evidencia de lo comprado); se valida Σ gastos ≈ monto del pago.
  readonly gastoFiles = signal<GastoFile[]>([]);
  private gastoSeq = 0;
  readonly gastoTotal = computed(() => this.gastoFiles().reduce((s, g) => s + (Number(g.ocrMonto) || 0), 0));
  readonly gastoBusy = computed(() => this.gastoFiles().some((g) => g.ocrLoading || g.uploading));
  readonly gastoMatch = computed(() => {
    const t = this.attachTarget(); const gf = this.gastoFiles();
    if (!t || !gf.length || gf.some((g) => g.ocrMonto == null)) return null;
    return Math.abs(this.gastoTotal() - t.monto) <= 1;
  });
  gastoDiff(): number { const t = this.attachTarget(); return t ? Math.abs(this.gastoTotal() - t.monto) : 0; }

  // reject dialog
  readonly showReject = signal(false);
  readonly rejectTarget = signal<PagoRow | null>(null);
  rejectMotivo = '';

  // view dialog (ver comprobante adjunto)
  readonly showView = signal(false);
  readonly viewData = signal<PagoDetail | null>(null);
  readonly viewTarget = signal<PagoRow | null>(null);

  constructor() { this.load(); }

  ngOnInit(): void {
    this.socket.connect();
    this.socket.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((ev) => this.onWsChange(ev));
  }
  ngOnDestroy(): void {
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.socket.disconnect();
  }

  /** Cambio de otro usuario → aviso sutil (si no fui yo) + refresco debounced de la tabla. */
  private onWsChange(ev: PaymentProofEvent): void {
    const me: any = this.auth.user();
    const mine = !!ev.actor && (ev.actor === me?.full_name || ev.actor === me?.username);
    if (!mine) {
      this.toast.add({ severity: 'info', summary: 'En vivo', detail: `${ev.actor || 'Alguien'} ${this.WS_VERB[ev.action] || 'actualizó un comprobante'} · ${ev.folio}`, life: 3500 });
    }
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => this.load(), 400); // coalesce ráfagas
  }

  kpiItems(r: PagosReport): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Pagos', value: r.kpis.pagos },
      { label: 'Con comprobante', value: r.kpis.con_comprobante, tone: 'ok' },
      { label: 'Validados', value: r.kpis.validados, tone: 'ok' },
      { label: '$ por comprobar', value: Number(r.kpis.monto_pendiente) || 0, format: 'currency-short', tone: 'warn' },
    ];
    const alertas = (r.kpis.cuentas_ajenas || 0) + (r.kpis.refs_duplicadas || 0);
    if (alertas > 0) items.push({ label: 'Alertas de control', value: alertas, tone: 'bad' });
    return items;
  }

  alertTitle(c: PagoRow): string {
    const p: string[] = [];
    if (c.cuenta_ajena) p.push('Pago desde una cuenta NO reconocida');
    if (c.ref_dup) p.push('Clave de rastreo usada en otro pago');
    return p.join(' · ') || 'Requiere revisión';
  }
  bankLabel(e: string): string { return ({ confirmado: 'Cargo confirmado en el banco', multiple: 'Posibles cargos — revisa cuál', sin_match: 'Sin cargo en el estado de cuenta', sin_dato: 'No verificable (falta monto/fecha)' } as Record<string, string>)[e] || e; }
  bankIcon(e: string): string { return ({ confirmado: 'pi-check-circle', multiple: 'pi-question-circle', sin_match: 'pi-times-circle', sin_dato: 'pi-minus-circle' } as Record<string, string>)[e] || 'pi-minus-circle'; }

  private readonly CAT_LABEL: Record<string, string> = {
    faltante: 'Faltante', no_solicitado: 'No solicitado', mal_estado: 'Mal estado', cambiada: 'Cambios',
    devolucion_otra: 'Devolución', factura_duplicada: 'Factura duplicada', diferencia_monto: 'Diferencia de monto',
    pronto_pago: 'Pronto pago', apoyo_marca: 'Apoyo de marca', descuento_comercial: 'Descuento', saldo_favor: 'Saldo a favor', otro: 'Otro',
  };
  catLabel(c: string | null): string { return c ? (this.CAT_LABEL[c] || c) : 'Sin motivo'; }

  /** Salta a /compras/descuentos filtrando por el proveedor (su lugar de contabilización). */
  openDescuentos(q?: string | null): void {
    this.router.navigate(['/compras/descuentos'], { queryParams: q ? { q } : {} });
  }

  setEstado(v: string) { this.estadoSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  /** Año seleccionado → rango de fechas (año completo, o mes específico si hay mes). */
  private dateRange(): { from?: string; to?: string } {
    if (!this.anio) return {};
    if (!this.mes) return { from: `${this.anio}-01-01`, to: `${this.anio}-12-31` };
    const mm = String(this.mes).padStart(2, '0');
    const last = new Date(Number(this.anio), Number(this.mes), 0).getDate();
    return { from: `${this.anio}-${mm}-01`, to: `${this.anio}-${mm}-${String(last).padStart(2, '0')}` };
  }

  /** Cambio de año: si vuelve a "Todos", limpia el mes (no aplica sin año). */
  onAnio() { if (!this.anio) this.mes = ''; this.load(); }
  toggleAlertas() { this.soloAlertas.update((v) => !v); this.load(); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.error.set(null);
    const { from, to } = this.dateRange();
    this.svc.list({
      estado: this.estadoSel() || undefined, search: this.search || undefined,
      from, to, metodo: this.metodo || undefined, alertas: this.soloAlertas() ? 'true' : undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar los pagos.'); this.loading.set(false); },
      });
  }

  openAttach(c: PagoRow) {
    this.resetAttach();
    this.attachTarget.set(c);
    this.captureMode.set(false);
    this.showAttach.set(true);
  }

  /** Ficha-first: captura SIN pago preseleccionado (lo busca el OCR). */
  openCapture() {
    this.resetAttach();
    this.attachTarget.set(null);
    this.captureMode.set(true);
    this.showAttach.set(true);
  }

  private resetAttach() {
    this.fileData = null;
    this.fileName.set('');
    this.gastoFiles.set([]);
    this.ocrForm = {}; this.buscarMonto = null; this.buscarConcepto = '';
    this.ocrRun.set(false);
    this.uploadedFile.set(null);
    this.uploading.set(false);
    this.attachError.set('');
    this.capMatches.set([]);
    this.capManualResults.set([]);
    this.capManualSearch = '';
    this.capMatching.set(false);
  }

  /** Con el comprobante leído, busca el pago por monto + fecha + concepto (factura).
   *  OCR-primero SIN fricción: si hay UNA sola candidata, la enlaza sola (no buscar folio). */
  runCapMatch() {
    if (this.buscarMonto == null) { this.capMatches.set([]); return; }
    this.capMatching.set(true);
    this.svc.matchPago(this.buscarMonto, this.ocrForm.fecha, this.buscarConcepto || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.capMatching.set(false);
          if ((r.pagos?.length || 0) === 1) { this.capMatches.set([]); this.pickPago(r.pagos[0]); this.toast.add({ severity: 'success', summary: 'Pago encontrado', detail: `${r.pagos[0].doc_prefix} ${r.pagos[0].sucursal}/${r.pagos[0].folio}` }); }
          else this.capMatches.set(r.pagos);
        },
        error: () => { this.capMatching.set(false); this.capMatches.set([]); },
      });
  }

  capManualSearchRun() {
    const s = this.capManualSearch.trim();
    if (!s) { this.capManualResults.set([]); return; }
    this.svc.list({ search: s }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.capManualResults.set(r.rows.slice(0, 15) as any), error: () => this.capManualResults.set([]) });
  }

  /** Elige el pago (sugerido o manual) → aparecen los campos + Guardar. */
  pickPago(c: PagoCandidate | PagoRow) { this.attachTarget.set(c as PagoRow); }

  onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // permite reelegir el mismo archivo
    if (file) this.handleFile(file);
  }

  // PC.1 — arrastrar el comprobante (foto o PDF) → mismo pipeline que elegir.
  readonly dragging = signal(false);
  onDragOver(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); if (!this.dragging()) this.dragging.set(true); }
  onDragLeave(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false); }
  onDrop(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation();
    this.dragging.set(false);
    const file = ev.dataTransfer?.files?.[0];
    if (file) this.handleFile(file);
  }

  private async handleFile(file: File) {
    if (file.size > 10 * 1024 * 1024) { this.attachError.set(`"${file.name}" supera 10 MB.`); return; }
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { this.attachError.set('El comprobante de pago debe ser PDF — la foto del gasto va abajo.'); return; }
    this.attachError.set('');
    this.ocrRun.set(false);
    this.ocrForm = {}; this.buscarMonto = null; this.buscarConcepto = '';
    this.uploadedFile.set(null);
    let dataUri: string;
    try { dataUri = await this.fileToDataUri(file); }
    catch { this.attachError.set(`No se pudo leer "${file.name}".`); return; }
    this.fileData = dataUri;
    this.fileName.set(file.name);
    this.autoProcess();
  }

  /** Imagen → JPEG reducido (≤1920px) para acelerar OCR/subida; el PDF se lee tal cual. */
  private async fileToDataUri(file: File): Promise<string> {
    const readRaw = () => new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = () => rej(r.error || new Error('read'));
      r.readAsDataURL(file);
    });
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) return readRaw();
    try {
      const bmp = await createImageBitmap(file);
      const maxDim = 1920, quality = 0.82;
      const ratio = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * ratio), h = Math.round(bmp.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('sin contexto 2D');
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return canvas.toDataURL('image/jpeg', quality);
    } catch {
      return readRaw();
    }
  }

  private autoProcess() { this.storeImage(); this.runOcr(); }

  private storeImage() {
    if (!this.fileData) return;
    this.uploading.set(true);
    this.svc.uploadFile(this.fileData, 'comprobante').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (f) => { this.uploadedFile.set(f); this.uploading.set(false); },
        error: () => { this.uploading.set(false); this.attachError.set('No se pudo almacenar la imagen — se reintenta al Guardar.'); },
      });
  }

  runOcr() {
    if (!this.fileData) return;
    this.ocrLoading.set(true);
    this.svc.ocr(this.fileData).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (f) => {
          this.ocrForm = { ...f }; this.ocrRun.set(true); this.ocrLoading.set(false);
          // El buscador arranca donde quedó la lectura.
          this.buscarMonto = f.monto ?? null; this.buscarConcepto = f.concepto || '';
          if (this.captureMode() && !this.attachTarget()) this.runCapMatch();
        },
        error: () => { this.ocrLoading.set(false); this.toast.add({ severity: 'error', summary: 'OCR falló', detail: 'Captura los datos a mano.' }); this.ocrForm = { ocr_status: 'ilegible' }; this.ocrRun.set(true); },
      });
  }

  matchState(): boolean | null {
    const t = this.attachTarget();
    const m = this.ocrForm.monto;
    if (!t || m == null || isNaN(Number(m))) return null;
    return Math.abs(Number(m) - t.monto) <= 1;
  }
  diff(): number { const t = this.attachTarget(); return t && this.ocrForm.monto != null ? Math.abs(Number(this.ocrForm.monto) - t.monto) : 0; }

  // PC.2 — foto(s) del gasto: sube (role=gasto → imagen) + OCR del total para validar Σ ≈ pago.
  onGastoFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    for (const f of files) this.addGasto(f);
  }
  onGastoDrop(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation();
    this.dragging.set(false);
    const files = ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
    for (const f of files) this.addGasto(f);
  }
  private async addGasto(file: File) {
    if (file.size > 10 * 1024 * 1024) { this.attachError.set(`"${file.name}" supera 10 MB.`); return; }
    this.attachError.set('');
    let dataUri: string;
    try { dataUri = await this.fileToDataUri(file); } catch { this.attachError.set(`No se pudo leer "${file.name}".`); return; }
    const kind: 'image' | 'pdf' = dataUri.startsWith('data:application/pdf') ? 'pdf' : 'image';
    const id = ++this.gastoSeq;
    this.gastoFiles.update((l) => l.concat({ id, name: file.name, dataUri, kind, uploaded: null, uploading: true, failed: false, ocrMonto: null, ocrLoading: true }));
    this.svc.uploadFile(dataUri, 'gasto').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (up) => this.patchGasto(id, { uploaded: up, uploading: false }),
      error: () => this.patchGasto(id, { uploading: false, failed: true }),
    });
    this.svc.ocr(dataUri, 'gasto').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.patchGasto(id, { ocrMonto: r.monto ?? null, ocrLoading: false }),
      error: () => this.patchGasto(id, { ocrLoading: false }),
    });
  }
  private patchGasto(id: number, p: Partial<GastoFile>) { this.gastoFiles.update((l) => l.map((g) => (g.id === id ? { ...g, ...p } : g))); }
  removeGasto(id: number) { this.gastoFiles.update((l) => l.filter((g) => g.id !== id)); }

  saveAttach() {
    const t = this.attachTarget();
    if (!t || !this.fileData) { this.attachError.set('Falta el comprobante.'); return; }
    this.attachError.set('');
    this.saving.set(true);
    const already = this.uploadedFile();
    if (already) { this.doAttach(t, already); return; }
    this.svc.uploadFile(this.fileData, 'comprobante').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (file: ProofFile) => { this.uploadedFile.set(file); this.doAttach(t, file); },
        error: () => { this.saving.set(false); this.attachError.set('No se pudo almacenar el comprobante. Reintenta.'); },
      });
  }

  private doAttach(t: PagoRow, file: ProofFile) {
    // PC.2 — el comprobante (PDF) + las fotos del gasto ya subidas van en la misma evidencia.
    const gastos: ProofFile[] = this.gastoFiles().filter((g) => g.uploaded).map((g) => ({ ...(g.uploaded as ProofFile), role: 'gasto', name: g.name, ocr_monto: g.ocrMonto }));
    const hoja: ProofFile = { ...file, sha256: this.ocrForm.sha256 };
    this.svc.attach({ sucursal: t.sucursal, folio: t.folio, doc_prefix: t.doc_prefix, files: [hoja, ...gastos], ocr: this.ocrRun() ? this.ocrForm : undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false); this.showAttach.set(false);
          this.toast.add({ severity: 'success', summary: 'Comprobante adjuntado', detail: res.monto_match ? 'El monto cuadra ✓' : 'Guardado (revisa el monto)' });
          if (res.cuenta_propia === false) this.toast.add({ severity: 'warn', summary: 'Cuenta origen NO reconocida', detail: 'El pago no salió de una cuenta de la empresa.', life: 8000 });
          if (res.ref_duplicada) this.toast.add({ severity: 'warn', summary: 'Clave de rastreo duplicada', detail: `Misma clave en: ${(res.ref_otros || []).join(', ')}`, life: 8000 });
          this.load();
        },
        error: (e) => { this.saving.set(false); this.attachError.set(e?.error?.message || 'No se pudo adjuntar.'); },
      });
  }

  /** Confirma que un cargo del banco corresponde al pago. */
  doConfirmBank(proofId: string, movId: string) {
    if (this.actingId()) return;
    this.actingId.set(proofId + movId);
    this.svc.confirmBank(proofId, movId).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'success', summary: 'Conciliado', detail: 'El cargo quedó ligado al pago.' }); this.reloadView(); this.load(); },
        error: (e) => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo conciliar', detail: e?.error?.message }); },
      });
  }
  doUnlinkBank(proofId: string, movId: string) {
    if (this.actingId()) return;
    this.actingId.set(proofId + movId);
    this.svc.unlinkBank(proofId, movId).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'info', summary: 'Conciliación deshecha' }); this.reloadView(); },
        error: () => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo deshacer' }); },
      });
  }
  private reloadView() {
    const c = this.viewTarget();
    if (!c) return;
    this.svc.detail(c.sucursal, c.folio, c.doc_prefix).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.viewData.set(d), error: () => {} });
  }

  doValidate(c: PagoRow) {
    if (!c.deposit_id || this.actingId()) return;
    this.actingId.set(c.deposit_id);
    this.svc.validate(c.deposit_id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'success', summary: 'Validado', detail: `Pago ${c.folio}` }); this.load(); },
        error: () => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(c: PagoRow) { this.rejectTarget.set(c); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const c = this.rejectTarget();
    if (!c?.deposit_id) return;
    this.saving.set(true);
    this.svc.reject(c.deposit_id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazado', detail: `Pago ${c.folio}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  openView(c: PagoRow) {
    if (c.deposits <= 0) { this.openAttach(c); return; } // sin comprobante → ir directo a adjuntar
    this.viewTarget.set(c);
    this.viewData.set(null);
    this.showView.set(true);
    this.svc.detail(c.sucursal, c.folio, c.doc_prefix).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.viewData.set(d),
        error: () => { this.showView.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar el comprobante' }); },
      });
  }
  fromViewToAttach() { const c = this.viewTarget(); this.showView.set(false); if (c) this.openAttach(c); }

  /** El archivo ELEGIDO (data URI, aún sin subir) es imagen / PDF. */
  isImageFile(): boolean { return !!this.fileData && this.fileData.startsWith('data:image'); }
  isPdfFile(): boolean { return !!this.fileData && this.fileData.startsWith('data:application/pdf'); }
  /** Un archivo YA subido (Cloudinary) es imagen (por kind o extensión) — si no, se trata como PDF/archivo. */
  isImageUrl(f: ProofFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }

  metodoLabel(m: string | null): string { return ({ transferencia: 'Transferencia', cheque: 'Cheque', anticipo: 'Anticipo' } as Record<string, string>)[m || ''] || '—'; }
  depLabel(s: string | null): string { return ({ recibido: 'Recibido', validado: 'Validado', rechazado: 'Rechazado' } as Record<string, string>)[s || ''] || '—'; }
  depSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibido: 'warn', validado: 'success', rechazado: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
