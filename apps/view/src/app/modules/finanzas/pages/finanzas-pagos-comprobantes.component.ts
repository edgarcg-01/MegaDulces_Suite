import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { PagosComprobantesService, PagoRow, PagosReport, DepositOcr, ProofFile, PagoDetail, PagoCandidate } from '../pagos-comprobantes.service';

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
  imports: [CommonModule, FormsModule, TableModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, LoadStateComponent],
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
      </div>
      <div class="cb-filters card-premium card-flat">
        <div class="cb-field"><label>Estado</label>
          <app-segmented [options]="estadoOpts" [value]="estadoSel()" (valueChange)="setEstado($event)" ariaLabel="Estado del comprobante" /></div>
        <div class="cb-field cb-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Folio, proveedor, RFC, monto…" (keyup.enter)="load()" (blur)="queue()" /></div>
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
            <span>Comprobante de pago (imagen o PDF) * <em class="cb-auto">se almacena y se lee solo al elegirlo</em></span>
            <div class="cb-pick">
              <label class="cb-pickbtn cb-cam"><i class="pi pi-camera"></i> Tomar foto
                <input type="file" accept="image/*" capture="environment" (change)="onFile($event)" hidden />
              </label>
              <label class="cb-pickbtn"><i class="pi pi-paperclip"></i> Elegir archivo
                <input type="file" accept="image/*,.pdf" (change)="onFile($event)" hidden />
              </label>
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
                <label class="cb-f cb-grow"><span>Monto del comprobante <em class="cb-auto">corrígelo si el OCR falló</em></span>
                  <p-inputnumber [(ngModel)]="ocrForm.monto" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
                <label class="cb-f cb-grow"><span>Concepto / factura</span>
                  <input pInputText [(ngModel)]="ocrForm.concepto" placeholder="F 451" /></label>
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
            <div class="cb-fields-head">Datos del comprobante <em class="cb-auto">revisa y corrige lo que el OCR haya leído mal</em></div>
            <div class="cb-grid">
              <label class="cb-f"><span>Monto del comprobante</span><p-inputnumber [(ngModel)]="ocrForm.monto" [disabled]="ocrLoading()" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
              <label class="cb-f"><span>Fecha</span><input pInputText [(ngModel)]="ocrForm.fecha" [disabled]="ocrLoading()" placeholder="AAAA-MM-DD" /></label>
              <label class="cb-f"><span>Concepto (factura)</span><input pInputText [(ngModel)]="ocrForm.concepto" [disabled]="ocrLoading()" placeholder="F 451" /></label>
              <label class="cb-f"><span>Clave de rastreo</span><input pInputText [(ngModel)]="ocrForm.clave_rastreo" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Cuenta origen (propia)</span><input pInputText [(ngModel)]="ocrForm.cuenta_origen" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Cuenta destino (prov.)</span><input pInputText [(ngModel)]="ocrForm.cuenta_destino" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Beneficiario</span><input pInputText [(ngModel)]="ocrForm.beneficiario" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Banco destino</span><input pInputText [(ngModel)]="ocrForm.banco_destino" [disabled]="ocrLoading()" /></label>
            </div>
          }
          @if (attachError()) { <div class="cb-err">{{ attachError() }}</div> }
        </div>
        <ng-template #footer>
          <button pButton type="button" text (click)="showAttach.set(false)"><span class="p-button-label">Cancelar</span></button>
          @if (attachTarget()) {
            <button pButton type="button" [loading]="saving()" [disabled]="!fileData || uploading()" (click)="saveAttach()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar comprobante</span></button>
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
    .cb-pick { display: flex; gap: .5rem; flex-wrap: wrap; }
    .cb-pickbtn { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); font-size: .85rem; color: var(--text-main); cursor: pointer; background: var(--card-bg); transition: border-color .15s, color .15s; }
    .cb-pickbtn:hover { border-color: var(--action); color: var(--action); }
    .cb-pickbtn i { font-size: .95rem; }
    .cb-filepick { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-ocr-actions { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
    .cb-hint { font-size: .74rem; color: var(--text-muted); }
    .cb-proc { font-size: .8rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; }
    .cb-stored { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-auto { font-style: normal; font-size: .68rem; color: var(--text-muted); text-transform: none; letter-spacing: 0; opacity: .8; }
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
  `],
})
export class FinanzasPagosComprobantesComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(PagosComprobantesService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

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
  // ficha-first (captura sin elegir pago)
  readonly captureMode = signal(false);
  readonly capMatching = signal(false);
  readonly capMatches = signal<PagoCandidate[]>([]);
  capManualSearch = '';
  readonly capManualResults = signal<PagoCandidate[]>([]);

  // reject dialog
  readonly showReject = signal(false);
  readonly rejectTarget = signal<PagoRow | null>(null);
  rejectMotivo = '';

  // view dialog (ver comprobante adjunto)
  readonly showView = signal(false);
  readonly viewData = signal<PagoDetail | null>(null);
  readonly viewTarget = signal<PagoRow | null>(null);

  constructor() { this.load(); }

  kpiItems(r: PagosReport): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Pagos', value: r.kpis.pagos },
      { label: 'Con comprobante', value: r.kpis.con_comprobante, tone: 'ok' },
      { label: 'Validados', value: r.kpis.validados, tone: 'ok' },
      { label: '$ por comprobar', value: this.money(r.kpis.monto_pendiente), tone: 'warn' },
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

  setEstado(v: string) { this.estadoSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.error.set(null);
    this.svc.list({ estado: this.estadoSel() || undefined, search: this.search || undefined })
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
    this.ocrForm = {};
    this.ocrRun.set(false);
    this.uploadedFile.set(null);
    this.uploading.set(false);
    this.attachError.set('');
    this.capMatches.set([]);
    this.capManualResults.set([]);
    this.capManualSearch = '';
    this.capMatching.set(false);
  }

  /** Con el comprobante leído, busca el pago por monto + fecha + concepto (factura). */
  runCapMatch() {
    if (this.ocrForm.monto == null) { this.capMatches.set([]); return; }
    this.capMatching.set(true);
    this.svc.matchPago(this.ocrForm.monto, this.ocrForm.fecha, this.ocrForm.concepto).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.capMatches.set(r.pagos); this.capMatching.set(false); },
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
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { this.attachError.set(`"${file.name}" supera 10 MB.`); return; }
    this.attachError.set('');
    this.ocrRun.set(false);
    this.ocrForm = {};
    this.uploadedFile.set(null);
    const reader = new FileReader();
    reader.onload = () => {
      this.fileData = String(reader.result || '');
      this.fileName.set(file.name);
      this.autoProcess();
    };
    reader.readAsDataURL(file);
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
    this.svc.attach({ sucursal: t.sucursal, folio: t.folio, doc_prefix: t.doc_prefix, files: [file], ocr: this.ocrRun() ? this.ocrForm : undefined })
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
