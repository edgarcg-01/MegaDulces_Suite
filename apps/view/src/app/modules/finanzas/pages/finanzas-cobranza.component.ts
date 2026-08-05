import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
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
import { CobranzaService, CobroRow, CobrosReport, DepositOcr, DepositFile, CobroDetail, UnmatchedBankReport, UnmatchedBankRow, CobroCandidate } from '../cobranza.service';

/**
 * CC — "Comprobantes de Cobranza". Lista los cobros de Kepler (documento UA0501)
 * y le adjunta a cada uno la FICHA DE DEPÓSITO (imagen/PDF): el capturista elige
 * el cobro, sube la ficha, corre OCR (Claude vision), el sistema compara el monto
 * OCR vs el del cobro (chip de cuadre) y guarda la evidencia. Validación/rechazo
 * a nivel gestión. No escribe a Kepler — es evidencia read-only sobre el ERP.
 */
@Component({
  selector: 'app-finanzas-cobranza',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cobranza — comprobantes</h1>
          <p class="surf-page-sub">Adjunta la ficha de depósito a cada cobro de Kepler (UA0501) · OCR compara el monto · pendiente → validado/rechazado</p>
        </div>
      </header>

      <div class="cb-mode">
        <app-segmented [options]="modeOpts" [value]="mode()" (valueChange)="setMode($event)" ariaLabel="Vista" />
      </div>

      @if (mode() === 'cobros') {
      <div class="cb-filters card-premium card-flat">
        <div class="cb-field"><label>Estado</label>
          <app-segmented [options]="estadoOpts" [value]="estadoSel()" (valueChange)="setEstado($event)" ariaLabel="Estado del comprobante" /></div>
        <div class="cb-field"><label>Forma de pago</label>
          <p-select [options]="formaOpts" [(ngModel)]="formaSel" optionLabel="label" optionValue="value" appendTo="body" styleClass="cb-sel" (onChange)="load()" /></div>
        <div class="cb-field cb-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Folio, cliente, monto…" (keyup.enter)="load()" (blur)="queue()" /></div>
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
              <th>Cliente</th>
              <th>Concepto</th>
              <th style="width:8rem">Forma</th>
              <th class="ta-r" style="width:9rem">Monto</th>
              <th style="width:11rem">Comprobante</th>
              <th style="width:12rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr>
              <td>{{ c.cobro_date | date:'dd/MM/yy' }}</td>
              <td class="mono">{{ c.folio }}</td>
              <td>{{ c.cliente_nombre || c.cliente_code || '—' }}<div class="cb-sub">{{ c.cliente_code }}</div></td>
              <td class="muted cb-concepto" [title]="c.concepto">{{ c.concepto || '—' }}</td>
              <td><p-tag [value]="formaLabel(c.forma_pago)" [severity]="formaSev(c.forma_pago)" /></td>
              <td class="ta-r strong">{{ money(c.monto) }}</td>
              <td class="cb-comp-cell" (click)="openView(c)" [title]="c.deposits > 0 ? 'Ver comprobante adjunto' : 'Adjuntar comprobante'">
                @if (c.deposits > 0) {
                  <div class="cb-comp">
                    <p-tag [value]="depLabel(c.deposit_status)" [severity]="depSev(c.deposit_status)" />
                    <span class="cb-match" [class.ok]="c.monto_match" [class.bad]="!c.monto_match" [title]="c.monto_match ? 'El monto de la ficha cuadra con el cobro' : 'El monto de la ficha NO cuadra'">
                      <i class="pi" [ngClass]="c.monto_match ? 'pi-check-circle' : 'pi-exclamation-triangle'"></i>
                    </span>
                    @if (c.alerta) {
                      <span class="cb-alert" [title]="alertTitle(c)"><i class="pi pi-flag-fill" aria-hidden="true"></i></span>
                    }
                    <i class="pi pi-eye cb-eye" aria-hidden="true"></i>
                  </div>
                } @else { <span class="muted cb-comp-empty"><i class="pi pi-paperclip" aria-hidden="true"></i> Sin comprobante</span> }
              </td>
              <td>
                <button pButton type="button" size="small" text (click)="openAttach(c)" [title]="c.deposits > 0 ? 'Agregar otra ficha' : 'Adjuntar ficha'"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">{{ c.deposits > 0 ? 'Otra' : 'Adjuntar' }}</span></button>
                @if (c.deposit_id && canManage()) {
                  @if (c.deposit_status !== 'validado') { <button pButton type="button" size="small" text severity="success" [loading]="actingId() === c.deposit_id" [disabled]="!!actingId()" (click)="doValidate(c)" title="Validar"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                  @if (c.deposit_status !== 'rechazado') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(c)" title="Rechazar"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button> }
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="8" class="cb-empty">Sin cobros para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
      }
      } @else {
        <!-- Caso B: abonos en banco sin cobro -->
        <div class="cb-filters card-premium card-flat">
          <div class="cb-field"><label>Solo huérfanos</label>
            <app-segmented [options]="huerfanoOpts" [value]="soloHuerfanos()" (valueChange)="setHuerfanos($event)" ariaLabel="Filtrar huérfanos" /></div>
          <div class="cb-field cb-grow"><label>Buscar concepto</label>
            <input pInputText [(ngModel)]="searchB" placeholder="Concepto del abono…" (keyup.enter)="loadBanco()" (blur)="queueBanco()" /></div>
        </div>
        @if (bancoReport(); as r) { <app-metric-strip [items]="bancoKpis(r)" ariaLabel="Resumen abonos" /> }
        @if (errorB()) {
          <app-load-state [error]="errorB()" (retry)="loadBanco()"></app-load-state>
        } @else {
        <div class="card-premium card-flat">
          <p-table [value]="bancoRows()" styleClass="p-datatable-sm cb-table" [rowHover]="true" [scrollable]="true" scrollHeight="62vh"
                   [paginator]="bancoRows().length > 150" [rows]="150" [loading]="loadingB()">
            <ng-template #header>
              <tr>
                <th style="width:6rem">Fecha</th>
                <th style="width:9rem">Cuenta</th>
                <th class="ta-r" style="width:9rem">Abono</th>
                <th>Concepto</th>
                <th style="width:11rem">Origen</th>
                <th style="width:8rem">Acción</th>
              </tr>
            </ng-template>
            <ng-template #body let-m>
              <tr [class.cb-row-huerfano]="!m.tiene_candidato">
                <td>{{ m.movement_date | date:'dd/MM/yy' }}</td>
                <td class="mono">{{ m.bank }} {{ m.account_label }}</td>
                <td class="ta-r strong">{{ money(m.amount_in) }}</td>
                <td class="muted cb-concepto" [title]="m.concept">{{ m.concept || '—' }}</td>
                <td>
                  @if (m.tiene_candidato) { <span class="cb-orig ok"><i class="pi pi-link"></i> Hay cobro candidato</span> }
                  @else { <span class="cb-orig bad"><i class="pi pi-exclamation-triangle"></i> Sin cobro (investigar)</span> }
                </td>
                <td>
                  @if (m.tiene_candidato) {
                    <button pButton type="button" size="small" text (click)="openLink(m)" title="Ligar a un cobro"><span class="p-button-icon p-button-icon-left pi pi-link" aria-hidden="true"></span><span class="p-button-label">Ligar</span></button>
                  } @else { <span class="muted cb-sub">—</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="6" class="cb-empty">Sin abonos de cobranza pendientes para el filtro.</td></tr></ng-template>
          </p-table>
        </div>
        }
      }
    </div>

    <!-- Diálogo: ligar abono → cobro (Caso B) -->
    <p-dialog [(visible)]="showLink" [modal]="true" [style]="{ width: '42rem' }" [draggable]="false" header="Ligar abono a un cobro">
      @if (linkMov(); as mv) {
        <div class="cb-form">
          <div class="cb-cobro">
            <div><span class="cb-lbl">Abono</span><strong class="mono">{{ mv.bank }} {{ mv.account_label }}</strong></div>
            <div><span class="cb-lbl">Fecha</span><strong>{{ mv.movement_date | date:'dd/MM/yy' }}</strong></div>
            <div class="ta-r"><span class="cb-lbl">Monto</span><strong class="cb-monto">{{ money(mv.amount_in) }}</strong></div>
          </div>
          <div class="cb-fields-head">Cobros candidatos <em class="cb-auto">mismo monto (±$1) y fecha cercana, aún sin ligar</em></div>
          @if (linkLoading()) { <div class="cb-view-loading"><i class="pi pi-spin pi-spinner"></i> Buscando cobros…</div> }
          @else if (!linkCands().length) { <p class="muted">No se encontró un cobro candidato. Es un abono sin cobro — investígalo en Bancos.</p> }
          @for (c of linkCands(); track c.folio) {
            <div class="cb-cand">
              <div class="cb-cand-info">
                <strong class="mono">{{ c.sucursal }}/{{ c.folio }}</strong>
                <span>{{ c.cliente_nombre || c.cliente_code || '—' }}</span>
                <span class="cb-sub">{{ c.cobro_date | date:'dd/MM/yy' }} · {{ formaLabel(c.forma_pago) }} · {{ money(c.monto) }}</span>
              </div>
              <button pButton type="button" size="small" [loading]="linkingFolio() === c.folio" (click)="doLink(c)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Ligar</span></button>
            </div>
          }
        </div>
        <ng-template #footer>
          <button pButton type="button" text (click)="showLink.set(false)"><span class="p-button-label">Cerrar</span></button>
        </ng-template>
      }
    </p-dialog>

    <!-- Diálogo: adjuntar ficha + OCR -->
    <p-dialog [(visible)]="showAttach" [modal]="true" [style]="{ width: '38rem' }" [draggable]="false" header="Adjuntar comprobante de depósito">
      @if (attachTarget(); as t) {
        <div class="cb-form">
          <div class="cb-cobro">
            <div><span class="cb-lbl">Cobro</span><strong class="mono">{{ t.sucursal }}/{{ t.folio }}</strong></div>
            <div><span class="cb-lbl">Cliente</span><strong>{{ t.cliente_nombre || t.cliente_code }}</strong></div>
            <div class="ta-r"><span class="cb-lbl">Monto del cobro</span><strong class="cb-monto">{{ money(t.monto) }}</strong></div>
          </div>

          <div class="cb-f cb-file">
            <span>Ficha de depósito (imagen o PDF) * <em class="cb-auto">se almacena y se lee sola al elegirla</em></span>
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
                <img [src]="fileData" alt="Previsualización de la ficha" />
              } @else if (isPdfFile()) {
                <div class="cb-preview-pdf"><i class="pi pi-file-pdf"></i><div class="cb-preview-pdf-txt"><strong>{{ fileName() }}</strong><span>PDF listo — se lee con OCR (los datos aparecen abajo)</span></div></div>
              }
            </div>
          }

          @if (fileName()) {
            <div class="cb-ocr-actions">
              @if (uploading() || ocrLoading()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> {{ (uploading() && ocrLoading()) ? 'Almacenando imagen y leyendo ficha…' : uploading() ? 'Almacenando imagen…' : 'Leyendo la ficha…' }}</span>
              } @else {
                @if (uploadedFile()) { <span class="cb-stored"><i class="pi pi-check-circle"></i> Imagen almacenada</span> }
                @if (ocrRun()) {
                  @if (matchState() === true) { <p-tag value="Cuadra con el cobro" severity="success" /> }
                  @else if (matchState() === false) { <p-tag [value]="'Difiere ' + money(diff())" severity="danger" /> }
                  @if (ocrForm.ocr_status === 'sin_key') { <span class="cb-hint">OCR no disponible — captura a mano.</span> }
                  @else if (ocrForm.ocr_status === 'ilegible') { <span class="cb-hint">No se pudo leer — captura a mano.</span> }
                }
                <button pButton type="button" size="small" text (click)="runOcr()" title="Volver a leer con OCR"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Releer</span></button>
              }
            </div>
          }

          @if (fileName()) {
            <div class="cb-fields-head">Datos de la ficha <em class="cb-auto">revisa y corrige lo que el OCR haya leído mal</em></div>
            <div class="cb-grid">
              <label class="cb-f"><span>Monto de la ficha</span><p-inputnumber [(ngModel)]="ocrForm.monto" [disabled]="ocrLoading()" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
              <label class="cb-f"><span>Fecha</span><input pInputText [(ngModel)]="ocrForm.fecha" [disabled]="ocrLoading()" placeholder="AAAA-MM-DD" /></label>
              <label class="cb-f"><span>Banco</span><input pInputText [(ngModel)]="ocrForm.banco" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Referencia / clave</span><input pInputText [(ngModel)]="ocrForm.referencia" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Cuenta destino</span><input pInputText [(ngModel)]="ocrForm.cuenta_dest" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Ordenante</span><input pInputText [(ngModel)]="ocrForm.ordenante" [disabled]="ocrLoading()" /></label>
            </div>
          }
          @if (attachError()) { <div class="cb-err">{{ attachError() }}</div> }
        </div>
        <ng-template #footer>
          <button pButton type="button" text (click)="showAttach.set(false)"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" [loading]="saving()" [disabled]="!fileData || uploading()" (click)="saveAttach()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar comprobante</span></button>
        </ng-template>
      }
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [(visible)]="showReject" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar comprobante">
      <div class="cb-form">
        <p class="muted">Cobro <strong>{{ rejectTarget()?.folio }}</strong> · {{ rejectTarget()?.cliente_nombre }}</p>
        <label class="cb-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. ficha ilegible, monto no cuadra, no corresponde…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: ver comprobante(s) adjunto(s) -->
    <p-dialog [(visible)]="showView" [modal]="true" [style]="{ width: '46rem' }" [draggable]="false" header="Comprobante del cobro">
      @if (viewData(); as v) {
        <div class="cb-form">
          <div class="cb-cobro">
            <div><span class="cb-lbl">Cobro</span><strong class="mono">{{ v.cobro.sucursal }}/{{ v.cobro.folio }}</strong></div>
            <div><span class="cb-lbl">Forma</span><strong>{{ formaLabel(v.cobro.forma_pago) }}</strong></div>
            <div><span class="cb-lbl">Cliente</span><strong>{{ v.cobro.cliente_nombre || v.cobro.cliente_code }}</strong></div>
            <div class="ta-r"><span class="cb-lbl">Monto del cobro</span><strong class="cb-monto">{{ money(v.cobro.monto) }}</strong></div>
          </div>

          @if (!v.deposits.length) { <p class="muted cb-view-none">Este cobro aún no tiene comprobante adjunto.</p> }
          @for (d of v.deposits; track d.id) {
            <div class="cb-view-dep">
              <div class="cb-view-head">
                <p-tag [value]="depLabel(d.status)" [severity]="depSev(d.status)" />
                @if (d.monto_match === true) { <p-tag value="Cuadra" severity="success" /> }
                @else if (d.monto_match === false) { <p-tag value="No cuadra" severity="danger" /> }
                @if (d.cuenta_propia === true) { <p-tag value="Cuenta propia" severity="success" /> }
                @else if (d.cuenta_propia === false) { <p-tag value="Cuenta NO reconocida" severity="danger" /> }
                @if (d.ref_duplicada) { <p-tag value="Referencia duplicada" severity="warn" /> }
                <span class="cb-view-meta">{{ d.created_by || '—' }} · {{ d.created_at | date:'dd/MM/yy HH:mm' }}</span>
              </div>
              @if (d.ref_duplicada && d.ref_otros?.length) {
                <div class="cb-alert-note"><i class="pi pi-flag-fill"></i> Mismo folio electrónico en: <strong>{{ d.ref_otros?.join(', ') }}</strong> — verifica si es un depósito que cubre varios cobros o una ficha repetida.</div>
              }
              @if (d.cuenta_propia === false) {
                <div class="cb-alert-note bad"><i class="pi pi-exclamation-triangle"></i> La cuenta destino de la ficha no coincide con ninguna cuenta de banco de la empresa.</div>
              }
              @if (d.banco; as bk) {
                @if (bk.conciliado) {
                  <div class="cb-bank ok">
                    <div class="cb-bank-head"><i class="pi pi-verified"></i> <strong>Conciliado con el banco</strong></div>
                    @for (m of bk.matched; track m.id) {
                      <div class="cb-bank-mov">
                        <span class="mono">{{ m.bank }} {{ m.account_label }}</span>
                        <span>{{ m.movement_date | date:'dd/MM/yy' }}</span>
                        <span class="strong">{{ money(m.amount_in) }}</span>
                        <span class="muted cb-bank-concept" [title]="m.concept">{{ m.concept || '—' }}</span>
                        @if (canManage()) { <button pButton type="button" size="small" text severity="secondary" [loading]="actingId() === d.id + m.id" (click)="doUnlinkBank(d.id, m.id)" title="Deshacer conciliación"><span class="p-button-icon pi pi-link" aria-hidden="true"></span></button> }
                      </div>
                      @if (m.matched_by) { <span class="cb-bank-by">por {{ m.matched_by }} · {{ m.matched_at | date:'dd/MM/yy HH:mm' }}</span> }
                    }
                  </div>
                } @else {
                  <div class="cb-bank" [class.warn]="bk.estado === 'multiple'" [class.bad]="bk.estado === 'sin_match'">
                    <div class="cb-bank-head">
                      <i class="pi" [ngClass]="bankIcon(bk.estado)"></i>
                      <strong>{{ bankLabel(bk.estado) }}</strong>
                    </div>
                    @for (m of bk.candidatos; track m.id) {
                      <div class="cb-bank-mov">
                        <span class="mono">{{ m.bank }} {{ m.account_label }}</span>
                        <span>{{ m.movement_date | date:'dd/MM/yy' }}</span>
                        <span class="strong">{{ money(m.amount_in) }}</span>
                        <span class="muted cb-bank-concept" [title]="m.concept">{{ m.concept || '—' }}</span>
                        @if (canManage()) { <button pButton type="button" size="small" text severity="success" [loading]="actingId() === d.id + m.id" (click)="doConfirmBank(d.id, m.id)" title="Confirmar que este abono es el del cobro"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                      </div>
                    }
                  </div>
                }
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
                <span><em>Banco</em> {{ d.ocr_banco || '—' }}</span>
                <span><em>Referencia</em> {{ d.ocr_referencia || '—' }}</span>
                @if (d.ocr_cuenta_dest) { <span><em>Cuenta dest.</em> {{ d.ocr_cuenta_dest }}</span> }
                @if (d.ocr_ordenante) { <span><em>Ordenante</em> {{ d.ocr_ordenante }}</span> }
              </div>
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
    .cb-sel { min-width: 12rem; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .cb-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cb-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .cb-table .strong { font-weight: 600; color: var(--text-main); }
    .cb-table .muted { color: var(--text-muted); }
    .cb-sub { font-size: .7rem; color: var(--text-muted); }
    .cb-concepto { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: var(--font-mono); font-size: .85em; }
    .cb-comp { display: inline-flex; align-items: center; gap: .45rem; }
    .cb-match.ok { color: var(--ok-fg); }
    .cb-match.bad { color: var(--bad-fg); }
    .cb-alert { color: var(--bad-fg); display: inline-flex; }
    .cb-alert i { font-size: .8rem; }
    .cb-alert-note { font-size: .78rem; color: var(--warn-fg); display: flex; align-items: baseline; gap: .4rem; background: var(--surface-sunken, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .45rem .6rem; }
    .cb-alert-note.bad { color: var(--bad-fg); }
    .cb-alert-note i { font-size: .8rem; }
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
    .cb-mode { margin-bottom: 1rem; }
    .cb-row-huerfano { background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .cb-orig { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; }
    .cb-orig.ok { color: var(--ok-fg); }
    .cb-orig.bad { color: var(--bad-fg); }
    .cb-orig i { font-size: .8rem; }
    .cb-cand { display: flex; align-items: center; justify-content: space-between; gap: .8rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .5rem .7rem; }
    .cb-cand-info { display: flex; flex-direction: column; gap: .1rem; }
    .cb-cand-info > span { font-size: .82rem; color: var(--text-main); }
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
  `],
})
export class FinanzasCobranzaComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(CobranzaService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<CobrosReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly actingId = signal<string | null>(null);
  readonly estadoSel = signal<string>('pendiente');
  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_COLLECTIONS_GESTIONAR] === true);

  readonly estadoOpts = [{ label: 'Pendientes', value: 'pendiente' }, { label: 'Con comprobante', value: 'con_comprobante' }, { label: 'Validados', value: 'validado' }, { label: 'Todos', value: '' }];
  readonly formaOpts = [{ label: 'Con ficha (dep./transf./tarjeta)', value: '' }, { label: 'Depósito', value: 'deposito' }, { label: 'Transferencia', value: 'transferencia' }, { label: 'Tarjeta', value: 'tarjeta' }, { label: 'Todas', value: 'todas' }];
  formaSel = '';
  search = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  // attach dialog
  readonly showAttach = signal(false);
  readonly attachTarget = signal<CobroRow | null>(null);
  readonly fileName = signal<string>('');
  readonly ocrLoading = signal(false);
  readonly ocrRun = signal(false);
  readonly uploading = signal(false);
  readonly uploadedFile = signal<DepositFile | null>(null);
  readonly attachError = signal<string>('');
  fileData: string | null = null;
  ocrForm: Partial<DepositOcr> = {};

  // reject dialog
  readonly showReject = signal(false);
  readonly rejectTarget = signal<CobroRow | null>(null);
  rejectMotivo = '';

  // view dialog (ver comprobante adjunto)
  readonly showView = signal(false);
  readonly viewData = signal<CobroDetail | null>(null);
  readonly viewTarget = signal<CobroRow | null>(null);

  // Caso B: abonos en banco sin cobro
  readonly mode = signal<'cobros' | 'banco'>('cobros');
  readonly modeOpts = [{ label: 'Cobros', value: 'cobros' }, { label: 'Abonos sin cobro', value: 'banco' }];
  readonly huerfanoOpts = [{ label: 'Todos', value: '' }, { label: 'Sin cobro', value: '1' }];
  readonly soloHuerfanos = signal<string>('');
  readonly bancoReport = signal<UnmatchedBankReport | null>(null);
  readonly bancoRows = computed(() => this.bancoReport()?.rows || []);
  readonly loadingB = signal(false);
  readonly errorB = signal<string | null>(null);
  searchB = '';
  private timerB: ReturnType<typeof setTimeout> | null = null;
  // link dialog
  readonly showLink = signal(false);
  readonly linkMov = signal<UnmatchedBankRow | null>(null);
  readonly linkCands = signal<CobroCandidate[]>([]);
  readonly linkLoading = signal(false);
  readonly linkingFolio = signal<string | null>(null);

  constructor() { this.load(); }

  setMode(v: string) { this.mode.set(v as 'cobros' | 'banco'); if (v === 'banco' && !this.bancoReport()) this.loadBanco(); }
  setHuerfanos(v: string) { this.soloHuerfanos.set(v); this.loadBanco(); }
  queueBanco() { if (this.timerB) clearTimeout(this.timerB); this.timerB = setTimeout(() => this.loadBanco(), 300); }

  bancoKpis(r: UnmatchedBankReport): MetricStripItem[] {
    return [
      { label: 'Abonos sin ligar', value: r.kpis.abonos },
      { label: '$ sin conciliar', value: this.money(r.kpis.monto), tone: 'warn' },
      { label: 'Sin cobro (investigar)', value: r.kpis.huerfanos, tone: r.kpis.huerfanos > 0 ? 'bad' : 'ok' },
    ];
  }

  loadBanco() {
    if (this.timerB) { clearTimeout(this.timerB); this.timerB = null; }
    this.loadingB.set(true); this.errorB.set(null);
    this.svc.unmatchedBank({ solo_huerfanos: this.soloHuerfanos() || undefined, search: this.searchB || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.bancoReport.set(r); this.loadingB.set(false); },
        error: () => { this.errorB.set('No se pudieron cargar los abonos.'); this.loadingB.set(false); },
      });
  }

  openLink(m: UnmatchedBankRow) {
    this.linkMov.set(m); this.linkCands.set([]); this.linkLoading.set(true); this.showLink.set(true);
    this.svc.bankCandidates(m.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.linkCands.set(r.cobros); this.linkLoading.set(false); },
        error: () => { this.linkLoading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudieron cargar candidatos' }); },
      });
  }
  doLink(c: CobroCandidate) {
    const m = this.linkMov();
    if (!m || this.linkingFolio()) return;
    this.linkingFolio.set(c.folio);
    this.svc.linkBank(m.id, c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.linkingFolio.set(null); this.showLink.set(false); this.toast.add({ severity: 'success', summary: 'Conciliado', detail: `Abono ligado al cobro ${c.sucursal}/${c.folio}` }); this.loadBanco(); },
        error: (e) => { this.linkingFolio.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo ligar', detail: e?.error?.message }); },
      });
  }

  kpiItems(r: CobrosReport): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Cobros', value: r.kpis.cobros },
      { label: 'Con comprobante', value: r.kpis.con_comprobante, tone: 'ok' },
      { label: 'Validados', value: r.kpis.validados, tone: 'ok' },
      { label: '$ por comprobar', value: this.money(r.kpis.monto_pendiente), tone: 'warn' },
    ];
    const alertas = (r.kpis.cuentas_ajenas || 0) + (r.kpis.refs_duplicadas || 0);
    if (alertas > 0) items.push({ label: 'Alertas de control', value: alertas, tone: 'bad' });
    return items;
  }

  /** Tooltip del flag de alerta en la tabla. */
  alertTitle(c: CobroRow): string {
    const p: string[] = [];
    if (c.cuenta_ajena) p.push('Depósito a una cuenta NO reconocida');
    if (c.ref_dup) p.push('Folio electrónico usado en otro cobro');
    return p.join(' · ') || 'Requiere revisión';
  }

  setEstado(v: string) { this.estadoSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.error.set(null);
    const forma = this.formaSel && this.formaSel !== 'todas' ? this.formaSel : undefined;
    const incluir_todas = this.formaSel === 'todas' ? '1' : undefined;
    this.svc.list({ estado: this.estadoSel() || undefined, forma_pago: forma, incluir_todas, search: this.search || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar los cobros.'); this.loading.set(false); },
      });
  }

  openAttach(c: CobroRow) {
    this.attachTarget.set(c);
    this.fileData = null;
    this.fileName.set('');
    this.ocrForm = {};
    this.ocrRun.set(false);
    this.uploadedFile.set(null);
    this.uploading.set(false);
    this.attachError.set('');
    this.showAttach.set(true);
  }

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
      this.autoProcess(); // al seleccionar: almacena la imagen + corre OCR, sin botones
    };
    reader.readAsDataURL(file);
  }

  /** Dispara en paralelo el almacenamiento de la imagen y la lectura OCR. */
  private autoProcess() {
    this.storeImage();
    this.runOcr();
  }

  /** Sube la ficha a Cloudinary (la ALMACENA) y guarda su referencia para el attach. */
  private storeImage() {
    if (!this.fileData) return;
    this.uploading.set(true);
    this.svc.uploadFile(this.fileData, 'deposito').pipe(takeUntilDestroyed(this.destroyRef))
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
        next: (f) => { this.ocrForm = { ...f }; this.ocrRun.set(true); this.ocrLoading.set(false); },
        error: () => { this.ocrLoading.set(false); this.toast.add({ severity: 'error', summary: 'OCR falló', detail: 'Captura los datos a mano.' }); this.ocrForm = { ocr_status: 'ilegible' }; this.ocrRun.set(true); },
      });
  }

  /** Estado del cuadre para el chip: true cuadra, false difiere, null sin monto OCR. */
  matchState(): boolean | null {
    const t = this.attachTarget();
    const m = this.ocrForm.monto;
    if (!t || m == null || isNaN(Number(m))) return null;
    return Math.abs(Number(m) - t.monto) <= 1;
  }
  diff(): number { const t = this.attachTarget(); return t && this.ocrForm.monto != null ? Math.abs(Number(this.ocrForm.monto) - t.monto) : 0; }

  saveAttach() {
    const t = this.attachTarget();
    if (!t || !this.fileData) { this.attachError.set('Falta la ficha de depósito.'); return; }
    this.attachError.set('');
    this.saving.set(true);
    const already = this.uploadedFile();
    if (already) { this.doAttach(t, already); return; } // ya se almacenó al seleccionar
    // La imagen no alcanzó a almacenarse (o falló) → súbela ahora y adjunta.
    this.svc.uploadFile(this.fileData, 'deposito').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (file: DepositFile) => { this.uploadedFile.set(file); this.doAttach(t, file); },
        error: () => { this.saving.set(false); this.attachError.set('No se pudo almacenar la ficha. Reintenta.'); },
      });
  }

  private doAttach(t: CobroRow, file: DepositFile) {
    this.svc.attach({ sucursal: t.sucursal, folio: t.folio, files: [file], ocr: this.ocrRun() ? this.ocrForm : undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false); this.showAttach.set(false);
          this.toast.add({ severity: 'success', summary: 'Comprobante adjuntado', detail: res.monto_match ? 'El monto cuadra ✓' : 'Guardado (revisa el monto)' });
          if (res.cuenta_propia === false) this.toast.add({ severity: 'warn', summary: 'Cuenta NO reconocida', detail: 'La cuenta destino de la ficha no es una cuenta de la empresa.', life: 8000 });
          if (res.ref_duplicada) this.toast.add({ severity: 'warn', summary: 'Referencia duplicada', detail: `Mismo folio electrónico en: ${(res.ref_otros || []).join(', ')}`, life: 8000 });
          this.load();
        },
        error: (e) => { this.saving.set(false); this.attachError.set(e?.error?.message || 'No se pudo adjuntar.'); },
      });
  }

  doValidate(c: CobroRow) {
    if (!c.deposit_id || this.actingId()) return;
    this.actingId.set(c.deposit_id);
    this.svc.validate(c.deposit_id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'success', summary: 'Validado', detail: `Cobro ${c.folio}` }); this.load(); },
        error: () => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(c: CobroRow) { this.rejectTarget.set(c); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const c = this.rejectTarget();
    if (!c?.deposit_id) return;
    this.saving.set(true);
    this.svc.reject(c.deposit_id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazado', detail: `Cobro ${c.folio}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  /** Confirma que un abono del banco corresponde al cobro y recarga el detalle. */
  doConfirmBank(depositId: string, movId: string) {
    if (this.actingId()) return;
    this.actingId.set(depositId + movId);
    this.svc.confirmBank(depositId, movId).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'success', summary: 'Conciliado', detail: 'El abono quedó ligado al cobro.' }); this.reloadView(); this.load(); },
        error: (e) => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo conciliar', detail: e?.error?.message }); },
      });
  }
  /** Deshace la conciliación cobro↔abono y recarga el detalle. */
  doUnlinkBank(depositId: string, movId: string) {
    if (this.actingId()) return;
    this.actingId.set(depositId + movId);
    this.svc.unlinkBank(depositId, movId).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'info', summary: 'Conciliación deshecha' }); this.reloadView(); },
        error: () => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo deshacer' }); },
      });
  }
  /** Recarga el diálogo de ver comprobante (tras conciliar/deshacer). */
  private reloadView() {
    const c = this.viewTarget();
    if (!c) return;
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.viewData.set(d), error: () => {} });
  }

  openView(c: CobroRow) {
    if (c.deposits <= 0) { this.openAttach(c); return; } // sin comprobante → ir directo a adjuntar
    this.viewTarget.set(c);
    this.viewData.set(null);
    this.showView.set(true);
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef))
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
  isImageUrl(f: DepositFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }

  bankLabel(e: string): string { return ({ confirmado: 'Abono confirmado en el banco', multiple: 'Posibles abonos — revisa cuál corresponde', sin_match: 'Sin abono en el estado de cuenta', sin_dato: 'No verificable (falta monto/fecha de la ficha)' } as Record<string, string>)[e] || e; }
  bankIcon(e: string): string { return ({ confirmado: 'pi-check-circle', multiple: 'pi-question-circle', sin_match: 'pi-times-circle', sin_dato: 'pi-minus-circle' } as Record<string, string>)[e] || 'pi-minus-circle'; }

  formaLabel(f: string | null): string { return ({ deposito: 'Depósito', transferencia: 'Transferencia', tarjeta: 'Tarjeta', efectivo: 'Efectivo', cheque: 'Cheque', otro: 'Otro' } as Record<string, string>)[f || ''] || (f || '—'); }
  formaSev(f: string | null): 'info' | 'success' | 'warn' | 'secondary' { return ({ deposito: 'info', transferencia: 'info', tarjeta: 'secondary', efectivo: 'success', cheque: 'warn' } as Record<string, 'info' | 'success' | 'warn' | 'secondary'>)[f || ''] || 'secondary'; }
  depLabel(s: string | null): string { return ({ recibido: 'Recibido', validado: 'Validado', rechazado: 'Rechazado' } as Record<string, string>)[s || ''] || '—'; }
  depSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibido: 'warn', validado: 'success', rechazado: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
