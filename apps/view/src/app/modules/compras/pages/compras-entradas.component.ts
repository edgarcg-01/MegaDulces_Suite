import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, map } from 'rxjs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { EntradasService, EntradaRow, EntradasReport, RemisionOcr, ProofFile, EntradaDetail, EntradaLinea, DuplicateHit, DocPresence } from '../entradas.service';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { entityRef } from '../../../shared/components/entity-inspector/entity-ref.service';
import { ComprasService, AdjustmentForEntradaRow, AdjustmentGrupo } from '../compras.service';
import { GoodsReceiptsSocketService } from '../goods-receipts-socket.service';

/** Una foto en el set de evidencia de la recepción (lo normal son 3–4). */
interface AttachFile {
  id: number; name: string; dataUri: string; kind: 'image' | 'pdf'; role: string;
  uploaded: ProofFile | null; uploading: boolean; failed: boolean;
  primary: boolean; // la ★ = la que además ENLAZA la entrada (folio/total). Ahora TODAS se leen con OCR.
  sha256?: string;           // hash de contenido (anti-hoja-duplicada)
  ocrLoading?: boolean;      // OCR de ESTA hoja en curso
  ocrDone?: boolean;
  ocrFolio?: string | null;  // OCR por-archivo (cada hoja se lee)
  ocrTotal?: number | null;
  ocrSubtotal?: number | null; // RE.pkt.2 — para que el cuadre use el total/subtotal de la hoja FISCAL
  ocrFecha?: string | null;
  ocrRfc?: string | null;
  ocrDocs?: string[];        // RE (#4) — tipos de documento detectados en la hoja (packet-aware)
  ocrDocsDetail?: DocPresence[]; // RE.pkt.1 — cada doc detectado con página + evidencia (auditable)
  dup?: DuplicateHit | null; // ya subida antes (misma hoja o folio ya capturado)
}

/**
 * CC (extensión) — "Comprobantes de Orden de Entrada" (proyecto Compras). Lista las
 * órdenes de entrada de Kepler (documento X-A-40) y le adjunta a cada una la
 * REMISIÓN/FACTURA del proveedor (imagen/PDF): el capturista elige la entrada, sube
 * la remisión, corre OCR (Claude vision), el sistema compara el total OCR vs el valor
 * de la entrada (chip de cuadre) y guarda la evidencia. Validación/rechazo a nivel
 * gestión. No escribe a Kepler.
 */
@Component({
  selector: 'app-compras-entradas',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, DialogModule, ToastModule, ConfirmDialogModule, SegmentedComponent, MetricStripComponent, LoadStateComponent, EntityInspectorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <p-confirmdialog />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Órdenes de entrada — factura del proveedor</h1>
          <p class="surf-page-sub">Identificá la entrada por los <strong>últimos 4 dígitos</strong> de su folio y subí solo la <strong>factura del proveedor</strong> · el OCR la compara contra el total de Kepler · pendiente → validado/rechazado</p>
        </div>
      </header>

      <div class="cb-filters card-premium card-flat">
        <div class="cb-field"><label>Estado</label>
          <app-segmented [options]="estadoOpts" [value]="estadoSel()" (valueChange)="setEstado($event)" ariaLabel="Estado del comprobante" /></div>
        <div class="cb-field cb-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Últimos 4 del folio (ej. 0397), o proveedor / RFC / OC…" (keyup.enter)="load()" (blur)="queue()" /></div>
        <div class="cb-field"><label>&nbsp;</label>
          <button pButton type="button" (click)="openAttachPhotoFirst()" title="Identificá la entrada por folio y subí la factura"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Subir factura</span></button></div>
        @if (newCount() > 0) {
          <div class="cb-field cb-field-pill"><label>&nbsp;</label>
            <button pButton type="button" class="cb-newpill" (click)="applyNew()" [title]="newCount() + ' orden(es) de entrada nueva(s) en el ERP'"><span class="p-button-icon p-button-icon-left pi pi-arrow-down" aria-hidden="true"></span><span class="p-button-label">{{ newCount() }} nueva(s) — actualizar</span></button></div>
        }
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
              <th style="width:7rem">Entrada</th>
              <th>Proveedor</th>
              <th style="width:7rem">OC</th>
              <th class="ta-r" style="width:9rem">Monto</th>
              <th style="width:11rem">Remisión</th>
              <th style="width:12rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr>
              <td>{{ c.receipt_date | date:'dd/MM/yy' }}</td>
              <td><button type="button" class="cb-foliolink" (click)="openDetail(c)" title="Ver detalle por línea (auditoría)">{{ c.folio }}</button></td>
              <td>
                @if (c.proveedor_code) {
                  <button type="button" class="cb-reflink" (click)="inspect.set(refProv(c.proveedor_code))"
                          [attr.aria-label]="'Ver ficha de ' + (c.proveedor_nombre || c.proveedor_code)">{{ c.proveedor_nombre || c.proveedor_code }}</button>
                } @else { {{ c.proveedor_nombre || '—' }} }
                <div class="cb-sub">{{ c.proveedor_rfc || c.proveedor_code }}</div>
              </td>
              <td class="mono muted">
                @if (c.oc_folio) {
                  <button type="button" class="cb-reflink mono" (click)="inspect.set(refOc(c.sucursal, c.oc_folio))"
                          [attr.aria-label]="'Abrir la orden de compra ' + c.oc_folio">{{ c.oc_folio }}</button>
                } @else { — }
              </td>
              <td class="ta-r strong">{{ money(c.monto) }}</td>
              <td class="cb-comp-cell" (click)="openDetail(c)" [title]="c.deposits > 0 ? 'Ver remisión adjunta + detalle por línea' : 'Ver detalle por línea'">
                @if (c.deposits > 0) {
                  <div class="cb-comp">
                    <p-tag [value]="depLabel(c.deposit_status)" [severity]="depSev(c.deposit_status)" />
                    <span class="cb-match" [class.ok]="c.monto_match" [class.bad]="!c.monto_match" [title]="c.monto_match ? 'El total de la remisión cuadra con la entrada' : 'El total de la remisión NO cuadra'">
                      <i class="pi" [ngClass]="c.monto_match ? 'pi-check-circle' : 'pi-exclamation-triangle'"></i>
                    </span>
                    <i class="pi pi-eye cb-eye" aria-hidden="true"></i>
                  </div>
                } @else { <span class="muted cb-comp-empty"><i class="pi pi-paperclip" aria-hidden="true"></i> Sin remisión</span> }
              </td>
              <td>
                <button pButton type="button" size="small" text (click)="openAttach(c)" [title]="c.deposits > 0 ? 'Agregar otra remisión' : 'Adjuntar remisión'"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">{{ c.deposits > 0 ? 'Otra' : 'Adjuntar' }}</span></button>
                @if (c.deposit_id && canValidate()) {
                  @if (c.deposit_status !== 'validado') { <button pButton type="button" size="small" text severity="success" [loading]="actingId() === c.deposit_id" [disabled]="!!actingId()" (click)="doValidate(c)" title="Validar"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                  @if (c.deposit_status !== 'rechazado') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(c)" title="Rechazar"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button> }
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="7" class="cb-empty">Sin entradas para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
      }
    </div>

    <!-- Diálogo: adjuntar remisión + OCR -->
    <p-dialog [visible]="showAttach()" (visibleChange)="onAttachVisible($event)" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" [header]="photoFirst() ? 'Adjuntar comprobantes (PDF)' : 'Adjuntar comprobantes de la entrada'">
      <div class="cb-form">
        @if (photoFirst() && attachStep() === 1) {
          <!-- PASO 1 — identificar la entrada por los últimos 4 dígitos del folio (OE opcional) -->
          <div class="cb-step-head"><span class="cb-step-n">1</span><span>Identificá la orden de entrada por los <strong>últimos 4 dígitos</strong> de su folio (buscala abajo). En el paso 2 subís la <strong>factura</strong>.</span></div>
          @if (!ordenFile() && !attachTarget()) {
            <div class="cb-drop cb-drop-opt" [class.drag]="dragging()"
                 (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
              <i class="pi pi-file-pdf cb-drop-ico" aria-hidden="true"></i>
              <div class="cb-drop-main"><span class="cb-opt-tag">opcional</span> Arrastrá el <strong>PDF de la orden de entrada</strong> para enlazarla sola</div>
              <div class="cb-drop-or">o</div>
              <label class="cb-pickbtn"><i class="pi pi-upload"></i> Elegir PDF
                <input type="file" accept="application/pdf" (change)="onFiles($event)" hidden />
              </label>
              <div class="cb-drop-hint">Si prefieres, mejor identifícala por el folio abajo — es más rápido.</div>
            </div>
          }
          @if (ordenFile(); as f) {
            <div class="cb-files">
              <div class="cb-file-card primary" [class.dup]="!!f.dup">
                <div class="cb-file-thumb">
                  @if (f.kind === 'image') { <img [src]="f.uploaded?.url || f.dataUri" [alt]="f.name" /> }
                  @else { <i class="pi pi-file-pdf" aria-hidden="true"></i> }
                </div>
                <div class="cb-file-body">
                  <div class="cb-file-name" [title]="f.name">{{ f.name }}</div>
                  <div class="cb-file-controls">
                    <span class="cb-role-fixed"><i class="pi pi-star-fill" aria-hidden="true"></i> Aplica Orden Entrada</span>
                    @if (f.uploading) { <span class="cb-file-stat" title="Almacenando…"><i class="pi pi-spin pi-spinner"></i></span> }
                    @else if (f.uploaded) { <span class="cb-file-stat ok" title="Almacenada — ya no vive en el teléfono"><i class="pi pi-check-circle"></i></span> }
                    @else if (f.failed) { <button type="button" class="cb-file-retry" (click)="retryUpload(f)" title="Reintentar subida"><i class="pi pi-refresh"></i></button> }
                  </div>
                  @if (f.dup) { <div class="cb-file-dup"><i class="pi pi-ban" aria-hidden="true"></i> {{ dupText(f) }}</div> }
                </div>
                <button type="button" class="cb-file-x" (click)="removeFile(f)" [attr.aria-label]="'Quitar ' + f.name"><i class="pi pi-times" aria-hidden="true"></i></button>
              </div>
            </div>
            <div class="cb-ocr-actions">
              @if (ocrLoading()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> Leyendo la orden…</span>
              } @else if (ocrRun()) {
                @if (ocrForm.ocr_status === 'sin_key') { <span class="cb-hint">OCR no disponible — enlazá la entrada abajo.</span> }
                @else if (ocrForm.ocr_status === 'ilegible') { <span class="cb-hint">No se pudo leer — enlazá la entrada abajo.</span> }
                <button pButton type="button" size="small" text (click)="runOcr()" title="Volver a leer la orden"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Releer</span></button>
              }
            </div>
          }
          @if (attachTarget(); as t) {
            <div class="cb-cobro cb-cobro-ok">
              <div><span class="cb-lbl">Entrada enlazada</span><strong class="mono">{{ t.sucursal }}/{{ t.folio }}</strong></div>
              <div><span class="cb-lbl">Proveedor</span><strong>{{ t.proveedor_nombre || t.proveedor_code }}</strong></div>
              <div class="ta-r"><span class="cb-lbl">Valor</span><strong class="cb-monto">{{ money(t.monto) }}</strong></div>
              <button pButton type="button" size="small" text (click)="unlinkEntrada()" title="Cambiar la entrada enlazada"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span><span class="p-button-label">Cambiar</span></button>
            </div>
          } @else {
            <div class="cb-link">
              @if (matching()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando la entrada…</span>
              } @else if (matchCandidates() === null) {
                <p class="cb-link-hint"><i class="pi pi-search" aria-hidden="true"></i> Escribí los <strong>últimos 4 dígitos</strong> del folio de la orden de entrada (o proveedor):</p>
                <div class="cb-link-search">
                  <input pInputText [(ngModel)]="manualSearch" placeholder="Últimos 4 del folio (ej. 0397), o proveedor…" (keyup.enter)="runManualSearch()" aria-label="Buscar entrada" />
                  <button pButton type="button" size="small" (click)="runManualSearch()" ariaLabel="Buscar entrada"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                </div>
              } @else {
                <div class="cb-link-head">
                  @if (matchCandidates()!.length) { {{ matchCandidates()!.length }} entrada(s) posible(s) — elegí la correcta: }
                  @else { No la reconocí automáticamente — buscala por folio o proveedor: }
                </div>
                <div class="cb-link-search">
                  <input pInputText [(ngModel)]="manualSearch" placeholder="Últimos 4 del folio (ej. 0397), o proveedor…" (keyup.enter)="runManualSearch()" aria-label="Buscar entrada" />
                  <button pButton type="button" size="small" (click)="runManualSearch()" ariaLabel="Buscar entrada"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                </div>
                @for (e of matchCandidates()!; track e.sucursal + '/' + e.folio) {
                  <button type="button" class="cb-link-cand" (click)="pickEntrada(e)">
                    <span class="mono">{{ e.sucursal }}/{{ e.folio }}</span>
                    <span class="cb-link-prov">{{ e.proveedor_nombre || e.proveedor_code || '—' }}</span>
                    <span class="cb-link-monto">{{ money(e.monto) }}</span>
                    @if (e.deposits > 0) { <span class="cb-link-has" title="Ya tiene comprobante">ya tiene</span> }
                  </button>
                }
              }
            </div>
          }
        } @else {
          <!-- PASO 2 — entrada enlazada + demás documentos (remisión/factura, vale, ticket) -->
          @if (attachTarget(); as t) {
            <div class="cb-cobro">
              <div><span class="cb-lbl">Entrada</span><strong class="mono">{{ t.sucursal }}/{{ t.folio }}</strong></div>
              <div><span class="cb-lbl">Proveedor</span><strong>{{ t.proveedor_nombre || t.proveedor_code }}</strong></div>
              <div class="ta-r"><span class="cb-lbl">Valor de la entrada</span><strong class="cb-monto">{{ money(t.monto) }}</strong></div>
            </div>
          }
          <div class="cb-step-head">@if (photoFirst()) { <span class="cb-step-n">2</span> }<span>Subí la <strong>factura del proveedor</strong> — es lo único obligatorio; la comparo contra el total de Kepler. Puedes agregar la orden de entrada u otra evidencia (opcional).</span></div>
          @if (!attachFiles().length) {
            <div class="cb-drop" [class.drag]="dragging()"
                 (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
              <i class="pi pi-file-pdf cb-drop-ico" aria-hidden="true"></i>
              <div class="cb-drop-main">Arrastrá aquí la <strong>factura del proveedor</strong> (PDF)</div>
              <div class="cb-drop-or">o</div>
              <label class="cb-pickbtn"><i class="pi pi-upload"></i> Elegir PDF
                <input type="file" accept="application/pdf" (change)="onFiles($event)" hidden multiple />
              </label>
            </div>
          }
          @if (attachFiles().length) {
            <div class="cb-files">
              @for (f of attachFiles(); track f.id) {
                <div class="cb-file-card" [class.primary]="f.primary" [class.dup]="!!f.dup">
                  <div class="cb-file-thumb">
                    @if (f.kind === 'image') { <img [src]="f.uploaded?.url || f.dataUri" [alt]="f.name" /> }
                    @else { <i class="pi pi-file-pdf" aria-hidden="true"></i> }
                  </div>
                  <div class="cb-file-body">
                    <div class="cb-file-name" [title]="f.name">{{ f.name }}</div>
                    <div class="cb-file-controls">
                      <select class="cb-role" [ngModel]="f.role" (ngModelChange)="setRole(f, $event)" [attr.aria-label]="'Tipo de ' + f.name">
                        @for (r of roleOpts(); track r.value) { <option [value]="r.value">{{ r.label }}</option> }
                      </select>
                      <button type="button" class="cb-star" [class.on]="f.primary" (click)="setPrimary(f)" [title]="f.primary ? 'Enlaza la entrada' : 'Usar esta para enlazar'"><i class="pi" [ngClass]="f.primary ? 'pi-star-fill' : 'pi-star'" aria-hidden="true"></i></button>
                      @if (f.ocrLoading) { <span class="cb-file-stat" title="Leyendo con OCR…"><i class="pi pi-spin pi-spinner"></i></span> }
                      @else if (f.ocrFolio && !f.dup) { <span class="cb-file-folio" title="Folio leído por OCR">#{{ f.ocrFolio }}</span> }
                      @if (f.uploading) { <span class="cb-file-stat" title="Almacenando…"><i class="pi pi-spin pi-spinner"></i></span> }
                      @else if (f.uploaded) { <span class="cb-file-stat ok" title="Almacenada — ya no vive en el teléfono"><i class="pi pi-check-circle"></i></span> }
                      @else if (f.failed) { <button type="button" class="cb-file-retry" (click)="retryUpload(f)" title="Reintentar subida"><i class="pi pi-refresh"></i></button> }
                    </div>
                    @if (f.dup) { <div class="cb-file-dup"><i class="pi pi-ban" aria-hidden="true"></i> {{ dupText(f) }}</div> }
                  </div>
                  <button type="button" class="cb-file-x" (click)="removeFile(f)" [attr.aria-label]="'Quitar ' + f.name"><i class="pi pi-times" aria-hidden="true"></i></button>
                </div>
              }
              <div class="cb-addmore" [class.drag]="dragging()"
                   (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
                <label class="cb-pickbtn"><i class="pi pi-upload"></i> Elegir más PDF
                  <input type="file" accept="application/pdf" (change)="onFiles($event)" hidden multiple />
                </label>
                <span class="cb-addmore-drop"><i class="pi pi-arrow-down" aria-hidden="true"></i> o arrastrá aquí</span>
                <span class="cb-addmore-n">{{ attachFiles().length }} adjunta(s)</span>
              </div>
            </div>

            <div class="cb-ocr-actions">
              @if (ocrLoading()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> Leyendo la orden…</span>
              } @else if (ocrRun()) {
                @if (matchState() === true) { <p-tag value="La remisión cuadra con la entrada" severity="success" /> }
                @else if (matchState() === false) { <p-tag [value]="'Difiere ' + money(diff())" severity="danger" /> }
              }
            </div>

            <div class="cb-fields-head">Datos leídos de la orden <em class="cb-auto">revisa y corrige lo que el OCR haya leído mal</em></div>
            <div class="cb-grid">
              <label class="cb-f"><span>Total</span><p-inputnumber [(ngModel)]="ocrForm.total" [disabled]="ocrLoading()" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
              <label class="cb-f"><span>Folio</span><input pInputText [(ngModel)]="ocrForm.folio" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Fecha</span><input pInputText [(ngModel)]="ocrForm.fecha" [disabled]="ocrLoading()" placeholder="AAAA-MM-DD" /></label>
              <label class="cb-f"><span>Proveedor (emisor)</span><input pInputText [(ngModel)]="ocrForm.proveedor" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>RFC</span><input pInputText [(ngModel)]="ocrForm.rfc" [disabled]="ocrLoading()" /></label>
              <label class="cb-f"><span>Subtotal</span><p-inputnumber [(ngModel)]="ocrForm.subtotal" [disabled]="ocrLoading()" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
              <label class="cb-f"><span>IVA</span><p-inputnumber [(ngModel)]="ocrForm.iva" [disabled]="ocrLoading()" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
            </div>
          }
          @if (dupFiles().length) { <div class="cb-dup"><i class="pi pi-ban" aria-hidden="true"></i> {{ dupFiles().length }} hoja(s) duplicada(s) (misma imagen o folio ya subido) — quitala(s) para guardar.</div> }
          @if (attachFiles().length) {
            <div class="cb-checklist">
              <div class="cb-checklist-head">
                <span>Documentos requeridos · <strong>{{ srcKind() === 'kepler' ? 'Kepler (CEDIS)' : 'Wincaja (sucursal)' }}</strong></span>
                @if (!missingGroups().length) { <span class="cb-chk-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> Completo</span> }
                @else { <span class="cb-chk-miss">{{ missingGroups().length }} faltante(s)</span> }
              </div>
              <ul class="cb-chk-list">
                @for (c of checklist(); track c.label) {
                  <li [class.ok]="c.ok" [class.opt]="c.optional"><i class="pi" [ngClass]="c.ok ? 'pi-check-circle' : (c.optional ? 'pi-minus-circle' : 'pi-circle')" aria-hidden="true"></i>
                    <span class="cb-chk-lbl">{{ c.label }}</span>
                    @if (c.optional && !c.ok) { <span class="cb-chk-opt">opcional</span> }
                    @if (c.ok && c.via === 'auto') {
                      <span class="cb-chk-via" title="Detectado por el lector">detectado{{ c.page ? ' · pág. ' + c.page : '' }}</span>
                      @if (c.evidence) { <span class="cb-chk-ev" [title]="c.evidence">{{ c.evidence }}</span> }
                    } @else if (c.ok && c.via === 'manual') {
                      <span class="cb-chk-via cb-chk-via-manual" title="Asignado a mano">manual</span>
                    }
                  </li>
                }
              </ul>
              @if (detectedDocs().length) {
                <div class="cb-detected">
                  <span class="cb-detected-h"><i class="pi pi-file-check" aria-hidden="true"></i> Detectado en el archivo</span>
                  <ul>
                    @for (d of detectedDocs(); track d.type + '|' + d.page) {
                      <li><strong>{{ d.label }}</strong>@if (d.page) { <span class="cb-detected-pg">pág. {{ d.page }}</span> }@if (d.evidence) { <span class="cb-detected-ev">{{ d.evidence }}</span> }</li>
                    }
                  </ul>
                </div>
              }
              <p class="cb-chk-hint">Los tipos se detectan leyendo cada hoja — si subiste todo en un solo PDF, cuenta igual (mostramos la página y la prueba de cada uno).</p>
            </div>
          }
        }
        @if (attachError()) { <div class="cb-err">{{ attachError() }}</div> }
      </div>
      <ng-template #footer>
        @if (photoFirst() && attachStep() === 1) {
          <button pButton type="button" text (click)="closeAttach()"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" [disabled]="!attachTarget()" (click)="continuar()"><span class="p-button-label">Continuar</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span></button>
        } @else {
          @if (photoFirst()) {
            <button pButton type="button" text (click)="backToStep1()"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Atrás</span></button>
          } @else {
            <button pButton type="button" text (click)="closeAttach()"><span class="p-button-label">Cancelar</span></button>
          }
          <button pButton type="button" [loading]="saving()" [disabled]="!attachFiles().length || uploadingAny() || ocrBusy() || dupFiles().length > 0 || !attachTarget() || missingGroups().length > 0" (click)="saveAttach()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar {{ attachFiles().length > 1 ? attachFiles().length + ' fotos' : 'comprobante' }}</span></button>
        }
      </ng-template>
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [visible]="showReject()" (visibleChange)="onRejectVisible($event)" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar remisión">
      <div class="cb-form">
        <p class="muted">Entrada <strong>{{ rejectTarget()?.folio }}</strong> · {{ rejectTarget()?.proveedor_nombre }}</p>
        <label class="cb-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. remisión ilegible, total no cuadra, no corresponde…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="closeReject()"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: detalle por línea (auditoría) + comparación documento vs OCR (RE.8) -->
    <p-dialog [(visible)]="showDetail" [modal]="true" [style]="{ width: '72rem', maxWidth: '96vw' }" [draggable]="false" [maximizable]="true" header="Detalle de la orden de entrada — documento vs OCR">
      @if (detailLoading()) {
        <div class="cb-detail-loading"><i class="pi pi-spin pi-spinner"></i> Cargando detalle…</div>
      } @else if (detailData(); as d) {
        <div class="cb-review"><div class="cb-review-main">
        <div class="cb-cobro">
          <div><span class="cb-lbl">Entrada</span>
            <button type="button" class="cb-reflink mono strong" (click)="inspect.set(refEnt(d.entrada.sucursal, d.entrada.folio))"
                    title="Ficha completa: renglones, ajustes, pagos candidatos y copia CEDIS">{{ d.entrada.sucursal }}/{{ d.entrada.folio }}</button></div>
          <div><span class="cb-lbl">Proveedor</span>
            @if (d.entrada.proveedor_code) {
              <button type="button" class="cb-reflink strong" (click)="inspect.set(refProv(d.entrada.proveedor_code))"
                      title="Ficha del proveedor: compras, ajustes, pagos y listas del SAT">{{ d.entrada.proveedor_nombre || d.entrada.proveedor_code }}</button>
            } @else { <strong>{{ d.entrada.proveedor_nombre || '—' }}</strong> }
            <div class="cb-sub">{{ d.entrada.proveedor_rfc }}</div></div>
          <div><span class="cb-lbl">Fecha</span><strong>{{ d.entrada.receipt_date | date:'dd/MM/yy' }}</strong></div>
          <div><span class="cb-lbl">OC / Vale</span><strong class="mono">
            @if (d.entrada.oc_folio) {
              <button type="button" class="cb-reflink mono" (click)="inspect.set(refOc(d.entrada.sucursal, d.entrada.oc_folio))"
                      title="Abrir la orden de compra: lo pedido, sus vales y qué tanto se surtió">{{ d.entrada.oc_folio }}</button>
            } @else { — }
            /
            @if (d.entrada.vale_folio) {
              <button type="button" class="cb-reflink mono" (click)="inspect.set(refVale(d.entrada.sucursal, d.entrada.vale_folio))"
                      title="Abrir el vale de entrada y su orden de compra">{{ d.entrada.vale_folio }}</button>
            } @else { — }
          </strong></div>
          <div class="ta-r"><span class="cb-lbl">Total Kepler</span><strong class="cb-monto">{{ money(d.entrada.monto) }}</strong></div>
        </div>
        @if (d.cedis_twins?.length) {
          <div class="cb-twin"><i class="pi pi-clone" aria-hidden="true"></i>
            <span>Incluye la copia de <strong>CEDIS</strong> (misma recepción, otra póliza) — no requiere evidencia aparte:</span>
            @for (t of d.cedis_twins; track t.sucursal + '/' + t.folio) {
              <button type="button" class="cb-twin-folio cb-reflink mono" (click)="inspect.set(refEnt(t.sucursal, t.folio))"
                      [attr.aria-label]="'Abrir la copia CEDIS ' + t.sucursal + '/' + t.folio">{{ t.sucursal }}/{{ t.folio }}</button>
            }
          </div>
        }
        <p-table [value]="d.lineas" styleClass="p-datatable-sm cb-table" [scrollable]="true" scrollHeight="44vh"
                 [paginator]="d.lineas.length > 200" [rows]="200">
          <ng-template #header>
            <tr>
              <th style="width:3rem">#</th>
              <th style="width:6rem">SKU</th>
              <th>Producto</th>
              <th class="ta-r" style="width:6rem">Cant.</th>
              <th style="width:4rem">U</th>
              <th class="ta-r" style="width:8rem">Costo u.</th>
              <th class="ta-r" style="width:9rem">Importe</th>
            </tr>
          </ng-template>
          <ng-template #body let-l>
            <tr>
              <td class="muted">
                <button type="button" class="cb-reflink" (click)="inspect.set(refLin(d.entrada.sucursal, d.entrada.folio, l.linea))"
                        [attr.aria-label]="'Abrir el renglón ' + l.linea">{{ l.linea }}</button>
              </td>
              <td class="mono">
                @if (l.sku) {
                  <button type="button" class="cb-reflink mono" (click)="inspect.set(refSku(l.sku))"
                          [attr.aria-label]="'Abrir el producto ' + l.sku">{{ l.sku }}</button>
                } @else { <span class="muted">—</span> }
              </td>
              <td>{{ l.nombre || '—' }}</td>
              <td class="ta-r">{{ l.cantidad | number:'1.0-2' }}</td>
              <td class="muted">{{ l.unidad || '' }}</td>
              <td class="ta-r">{{ money(l.costo_unitario) }}</td>
              <td class="ta-r strong">{{ money(l.importe) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="7" class="cb-empty">Sin líneas de detalle para esta entrada.</td></tr></ng-template>
        </p-table>
        <div class="cb-detail-total">
          <span class="muted">{{ d.lineas.length }} renglones</span>
          <span>Σ líneas (subtotal) <strong>{{ money(lineasTotal(d.lineas)) }}</strong> · Total doc <strong>{{ money(d.entrada.monto) }}</strong>
            @if (lineasCuadra(d)) { <p-tag value="Cuadra (sin IVA)" severity="success" /> }
            @else { <p-tag [value]="'IVA/dif ' + money(lineasDiff(d))" severity="info" /> }</span>
        </div>

        <!-- RE.2 — ajustes que EXPLICAN el descuadre (devoluciones / notas de crédito / descuentos del proveedor) -->
        <div class="cb-explains">
          <div class="cb-explains-head">
            <span><i class="pi pi-search-plus" aria-hidden="true"></i> ¿Por qué no cuadra? — ajustes del proveedor</span>
            @if (explains().length) { <span class="cb-explains-sum">{{ explains().length }} · {{ money(explainsTotal()) }}</span> }
          </div>
          @if (explainsLoading()) {
            <p class="muted cb-explains-none"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando ajustes…</p>
          } @else if (!explains().length) {
            <p class="muted cb-explains-none">Sin devoluciones ni notas de crédito (X-D-40/55) de este proveedor cerca de la fecha. Si la factura no cuadra, la diferencia suele ser IVA o captura.</p>
          } @else {
            <p class="cb-explains-hint muted">Devoluciones y notas de crédito de <strong>{{ d.entrada.proveedor_nombre || d.entrada.proveedor_code }}</strong> ±15 días — explican por qué la factura difiere de lo recibido.</p>
            <ul class="cb-explains-list">
              @for (a of explains(); track a.doctype + a.folio) {
                <li class="cb-explains-item">
                  <p-tag [value]="adjDoctypeLabel(a.doctype)" [severity]="a.doctype === 'XD40' ? 'warn' : 'info'" />
                  <button type="button" class="cb-explains-folio cb-reflink mono" (click)="inspect.set(refAdj(a))"
                          [attr.aria-label]="'Abrir el ajuste ' + a.doctype + ' ' + a.folio">{{ a.folio }}</button>
                  <span class="cb-explains-fecha muted">{{ a.adjustment_date | date:'dd/MM/yy' }}</span>
                  <span class="cb-explains-motivo" [title]="a.motivo || ''">{{ a.motivo || '—' }}</span>
                  <p-tag [value]="adjGrupoLabel(a.grupo)" [severity]="adjGrupoSev(a.grupo)" />
                  @if (a.match === 'exacto') { <span class="cb-explains-exact" title="Ligado por folio de entrada"><i class="pi pi-link" aria-hidden="true"></i> exacto</span> }
                  @else { <span class="cb-explains-heur" title="Coincidencia por proveedor + fecha (Kepler no liga la nota a la entrada)">≈ prov+fecha</span> }
                  <span class="cb-explains-monto strong">{{ money(a.monto) }}</span>
                </li>
              }
            </ul>
          }
        </div>

        <div class="cb-view-attachments">
          <div class="cb-view-att-head">Remisión / factura adjunta</div>
          @if (!d.deposits.length) { <p class="muted cb-view-none">Aún sin remisión adjunta.</p> }
          @for (dep of d.deposits; track dep.id) {
            <div class="cb-view-dep">
              <div class="cb-view-head">
                <p-tag [value]="depLabel(dep.status)" [severity]="depSev(dep.status)" />
                @if (dep.monto_match === true) { <p-tag value="Cuadra" severity="success" /> }
                @else if (dep.monto_match === false) { <p-tag value="No cuadra" severity="danger" /> }
                @if (dep.discrepancy_kind && dep.discrepancy_kind !== 'cuadra') {
                  <p-tag [value]="discLabel(dep.discrepancy_kind) + (dep.discrepancy_amount ? ' · ' + money(dep.discrepancy_amount) : '')" [severity]="discSev(dep.discrepancy_kind)" />
                }
                <span class="cb-view-meta">{{ dep.created_by || '—' }} · {{ dep.created_at | date:'dd/MM/yy HH:mm' }}</span>
              </div>
              <div class="cb-view-files">
                @for (f of dep.files; track f.url) {
                  <button type="button" class="cb-view-filebtn" [class.on]="selectedDoc()?.url === f.url" (click)="selectDoc(f)" [title]="'Ver ' + (f.name || 'documento') + ' a la derecha'">
                    <i class="pi" [ngClass]="isImageUrl(f) ? 'pi-image' : 'pi-file-pdf'" aria-hidden="true"></i>
                    <span class="cb-filebtn-name">{{ f.name || (isImageUrl(f) ? 'imagen' : 'remisión (PDF)') }}</span>
                  </button>
                }
                @if (!dep.files.length) { <span class="muted">Sin archivo.</span> }
              </div>
              <div class="cb-view-ocr">
                <span><em>Folio</em> {{ dep.ocr_folio || '—' }}</span>
                <span><em>Fecha</em> {{ dep.ocr_fecha || '—' }}</span>
                <span><em>Proveedor</em> {{ dep.ocr_proveedor || '—' }}</span>
                <span><em>Total</em> {{ dep.ocr_monto != null ? money(dep.ocr_monto) : '—' }}</span>
                @if (dep.ocr_subtotal != null) { <span><em>Subtotal</em> {{ money(dep.ocr_subtotal) }}</span> }
                @if (dep.ocr_iva != null) { <span><em>IVA</em> {{ money(dep.ocr_iva) }}</span> }
              </div>
              @if (dep.status === 'rechazado' && dep.motivo_rechazo) { <div class="cb-err">Rechazado: {{ dep.motivo_rechazo }}</div> }
              @if (dep.comentarios) { <div class="cb-view-coment">{{ dep.comentarios }}</div> }
            </div>
          }
        </div>
        </div><!-- /.cb-review-main -->

        <!-- Panel derecho: documento (PDF/imagen) para comparar contra la lectura OCR de la izquierda -->
        <aside class="cb-review-doc">
          @if (selectedDoc(); as doc) {
            <div class="cb-doc-head">
              <span class="cb-doc-name" [title]="doc.name"><i class="pi" [ngClass]="doc.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'" aria-hidden="true"></i> {{ doc.name }}</span>
              <a pButton type="button" text size="small" [href]="doc.url" target="_blank" rel="noopener" title="Abrir en pestaña"><span class="p-button-icon pi pi-external-link" aria-hidden="true"></span></a>
            </div>
            <div class="cb-doc-frame">
              @if (doc.kind === 'pdf') { <iframe [src]="doc.safeUrl" title="Documento de la orden de entrada"></iframe> }
              @else { <img [src]="doc.url" [alt]="doc.name" /> }
            </div>
          } @else {
            <div class="cb-doc-empty"><i class="pi pi-file" aria-hidden="true"></i><span>Elegí una hoja abajo para verla acá, junto a la lectura OCR.</span></div>
          }
        </aside>
        </div><!-- /.cb-review -->
      }
      <ng-template #footer>
        <button pButton type="button" text (click)="showDetail.set(false)"><span class="p-button-label">Cerrar</span></button>
        <button pButton type="button" (click)="fromDetailToAttach()"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">Adjuntar remisión</span></button>
      </ng-template>
    </p-dialog>

    <!-- Visor de imagen: se abre solo al pedirlo (no carga la imagen en el detalle) -->
    <p-dialog [(visible)]="viewerOpen" [modal]="true" [dismissableMask]="true" [draggable]="false" [style]="{ width: '56rem', maxWidth: '94vw' }"
              [header]="viewerName() || 'Imagen de la remisión'" [baseZIndex]="10000" appendTo="body">
      @if (viewerUrl(); as url) {
        <div class="cb-viewer"><img [src]="url" [alt]="viewerName() || 'remisión'" /></div>
      }
      <ng-template #footer>
        <a pButton type="button" text [href]="viewerUrl()" target="_blank" rel="noopener"><span class="p-button-icon p-button-icon-left pi pi-external-link" aria-hidden="true"></span><span class="p-button-label">Abrir en pestaña</span></a>
        <button pButton type="button" (click)="closeImage()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Cerrar</span></button>
      </ng-template>
    </p-dialog>

    <!-- Panel de ficha: proveedor, entrada, renglón, producto y ajuste se abren acá y
         se navegan entre sí sin salir de la pantalla ni apilar diálogos. -->
    <app-entity-inspector [(ref)]="inspect" />
  `,
  styles: [`
    :host { display: block; }
    /* Cualquier dato que lleva a una ficha. Discreto en reposo: la tabla ya tiene
       suficiente color y esto aparece en muchas celdas a la vez. */
    .cb-reflink { border:0; background:transparent; color:inherit; cursor:pointer; padding:0; font:inherit; text-align:left; }
    .cb-reflink:hover { color:var(--action); text-decoration:underline; }
    .cb-reflink:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cb-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .cb-field { display: flex; flex-direction: column; gap: .3rem; }
    .cb-field > label { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-field.cb-grow { flex: 1 1 16rem; }
    /* RE.10 — pill de órdenes nuevas (WS) */
    .cb-newpill { background: var(--action); border-color: var(--action); color: #fff; }
    .cb-newpill:hover { filter: brightness(1.06); }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .cb-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cb-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .cb-table .strong { font-weight: 600; color: var(--text-main); }
    .cb-table .muted { color: var(--text-muted); }
    .cb-sub { font-size: .7rem; color: var(--text-muted); }
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
    .cb-foliolink { border: none; background: transparent; color: var(--action); cursor: pointer; padding: 0; font-family: var(--font-mono); font-size: .85em; }
    .cb-foliolink:hover { text-decoration: underline; }
    .cb-detail-loading { padding: 2rem; text-align: center; color: var(--text-muted); display: flex; align-items: center; justify-content: center; gap: .5rem; }
    .cb-detail-total { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: .7rem; padding-top: .7rem; border-top: 1px solid var(--border-color); font-size: .85rem; }
    .cb-detail-total strong { font-family: var(--font-mono); color: var(--text-main); }
    .cb-detail-total > span:last-child { display: inline-flex; align-items: center; gap: .5rem; }
    /* RE.12 — copia CEDIS (espejo) adjunta a la vista de la canónica */
    .cb-twin { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; margin: .6rem 0 0; padding: .45rem .7rem; font-size: .8rem; color: var(--text-muted); background: var(--surface-sunken, var(--card-bg)); border: 1px dashed var(--border-color); border-radius: var(--r-sm, .4rem); }
    .cb-twin .pi-clone { color: var(--action); }
    .cb-twin-folio { color: var(--text-main); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .05rem .35rem; }
    /* columna Remisión clickable */
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
    /* multi-archivo: set de 3–4 fotos de la recepción */
    .cb-files { display: flex; flex-direction: column; gap: .5rem; }
    .cb-file-card { display: flex; align-items: center; gap: .7rem; padding: .5rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .cb-file-card.primary { border-color: var(--action); box-shadow: inset 3px 0 0 var(--action); }
    .cb-file-thumb { flex: 0 0 auto; width: 3rem; height: 3rem; border-radius: var(--r-sm, .4rem); overflow: hidden; display: flex; align-items: center; justify-content: center; background: #00000010; }
    .cb-file-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .cb-file-thumb .pi-file-pdf { font-size: 1.4rem; color: var(--bad-fg); }
    .cb-file-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
    .cb-file-name { font-size: .8rem; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-file-controls { display: flex; align-items: center; gap: .5rem; }
    .cb-role { font-size: .76rem; padding: .2rem .4rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); background: var(--card-bg); color: var(--text-main); max-width: 12rem; }
    .cb-star { border: none; background: transparent; cursor: pointer; color: var(--text-faint); padding: .1rem .2rem; font-size: .95rem; }
    .cb-star.on { color: var(--warn-soft-fg, #d19a00); }
    .cb-file-stat { display: inline-flex; align-items: center; font-size: .85rem; color: var(--text-muted); }
    .cb-file-stat.ok { color: var(--ok-fg); }
    .cb-file-retry { border: none; background: transparent; cursor: pointer; color: var(--bad-fg); padding: .1rem .2rem; }
    .cb-file-x { flex: 0 0 auto; border: none; background: transparent; cursor: pointer; color: var(--text-muted); padding: .2rem .3rem; border-radius: var(--r-sm, .4rem); }
    .cb-file-x:hover { color: var(--bad-fg); background: var(--surface-hover, rgba(0,0,0,.04)); }
    /* foto-primero: enlace de la entrada por OCR / búsqueda manual */
    .cb-link { display: flex; flex-direction: column; gap: .5rem; padding: .7rem .9rem; border: 1px dashed var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .cb-link-hint { margin: 0; font-size: .82rem; color: var(--text-muted); display: flex; align-items: center; gap: .4rem; }
    .cb-link-head { font-size: .82rem; font-weight: 600; color: var(--text-main); }
    .cb-link-search { display: flex; gap: .4rem; }
    .cb-link-search input { flex: 1 1 auto; }
    .cb-link-cand { display: flex; align-items: center; gap: .7rem; width: 100%; text-align: left; padding: .45rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); background: var(--card-bg); cursor: pointer; font-size: .82rem; }
    .cb-link-cand:hover { border-color: var(--action); }
    .cb-link-prov { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-main); }
    .cb-link-monto { font-family: var(--font-mono); color: var(--text-main); }
    .cb-link-has { font-size: .7rem; color: var(--warn-soft-fg, #b26a00); background: var(--warn-soft-bg, #fff3e0); padding: .05rem .35rem; border-radius: var(--r-sm, .4rem); }
    .cb-missing { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--warn-soft-fg, #b26a00); background: var(--warn-soft-bg, #fff3e0); border: 1px solid var(--warn-border, #f0c987); border-radius: var(--r-sm, .4rem); padding: .4rem .6rem; }
    /* RE (#4) — checklist de completitud por fuente (Kepler/Wincaja), packet-aware */
    .cb-checklist { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .6rem .8rem; background: var(--surface-sunken, var(--card-bg)); display: flex; flex-direction: column; gap: .45rem; }
    .cb-checklist-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; font-size: .8rem; color: var(--text-main); }
    .cb-chk-ok { display: inline-flex; align-items: center; gap: .3rem; color: var(--ok-fg); font-weight: 600; }
    .cb-chk-miss { color: var(--warn-soft-fg, #b26a00); font-weight: 600; }
    .cb-chk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .3rem .9rem; }
    .cb-chk-list li { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; color: var(--text-muted); }
    .cb-chk-list li.ok { color: var(--text-main); }
    .cb-chk-list li.ok .pi { color: var(--ok-fg); }
    .cb-chk-list li .pi-circle { color: var(--text-faint); }
    /* RE.pkt.1 — cómo se cumplió cada requerido (auto=OCR con página / manual) + evidencia */
    .cb-chk-via { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); border-radius: var(--r-sm, .25rem); padding: .05rem .3rem; }
    .cb-chk-via-manual { color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 12%, transparent); }
    .cb-chk-list li.opt { color: var(--text-faint); }
    .cb-chk-list li.opt .pi-minus-circle { color: var(--text-faint); }
    .cb-chk-opt { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 10%, transparent); border-radius: var(--r-sm, .25rem); padding: .05rem .3rem; }
    .cb-chk-ev { font-size: .72rem; color: var(--text-faint); font-family: var(--font-mono, ui-monospace, monospace); max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-detected { border-top: 1px dashed var(--border-color); padding-top: .45rem; display: flex; flex-direction: column; gap: .25rem; }
    .cb-detected-h { font-size: .72rem; font-weight: 600; color: var(--text-muted); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-detected ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; }
    .cb-detected li { font-size: .78rem; color: var(--text-main); display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
    .cb-detected-pg { font-size: .68rem; color: var(--text-muted); background: var(--surface-raised, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-sm, .25rem); padding: 0 .3rem; }
    .cb-detected-ev { font-size: .72rem; color: var(--text-faint); font-family: var(--font-mono, ui-monospace, monospace); }
    .cb-chk-hint { margin: 0; font-size: .72rem; color: var(--text-faint); }
    /* wizard foto-primero: paso 1 (orden) → continuar → paso 2 (demás docs) */
    .cb-step-head { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: var(--text-main); line-height: 1.35; }
    .cb-step-n { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 1.4rem; height: 1.4rem; border-radius: 50%; background: var(--action); color: #fff; font-size: .74rem; font-weight: 700; }
    .cb-cobro-ok { border: 1px solid var(--ok-fg, #2e7d32); }
    .cb-role-fixed { display: inline-flex; align-items: center; gap: .3rem; font-size: .78rem; font-weight: 600; color: var(--action); }
    .cb-role-fixed .pi { font-size: .8rem; }
    .cb-addmore { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; padding-top: .1rem; border-radius: var(--r-sm, .4rem); transition: outline-color .15s; }
    .cb-addmore.drag { outline: 2px dashed var(--action); outline-offset: 3px; }
    .cb-addmore-drop { font-size: .74rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-addmore-n { font-size: .76rem; color: var(--text-muted); margin-left: auto; }
    /* RE.7 — dropzone de arrastre del PDF (dispara el OCR solo) */
    .cb-drop { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 1.6rem 1rem; border: 2px dashed var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); text-align: center; transition: border-color .15s, background .15s; }
    .cb-drop.drag { border-color: var(--action); background: var(--action-soft-bg, rgba(0,0,0,.03)); }
    .cb-drop-ico { font-size: 2rem; color: var(--bad-fg); }
    .cb-drop-main { font-size: .88rem; color: var(--text-main); }
    .cb-drop-or { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
    .cb-drop-hint { font-size: .74rem; color: var(--text-muted); }
    .cb-drop-opt { border-style: dotted; opacity: .82; }
    .cb-opt-tag { display: inline-block; font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); border: 1px solid var(--border-color); border-radius: var(--r-sm, .3rem); padding: 0 .3rem; margin-right: .35rem; vertical-align: middle; }
    /* OCR por-archivo + duplicados */
    .cb-file-folio { font-size: .72rem; font-family: var(--font-mono); color: var(--text-muted); background: var(--surface-sunken, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .05rem .3rem; max-width: 8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-file-card.dup { border-color: var(--bad-fg); box-shadow: inset 3px 0 0 var(--bad-fg); }
    .cb-file-dup { display: flex; align-items: center; gap: .3rem; margin-top: .25rem; font-size: .74rem; color: var(--bad-fg); }
    .cb-dup { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--bad-fg); background: var(--bad-soft-bg, #fdecea); border: 1px solid var(--bad-border, #f5c2c0); border-radius: var(--r-sm, .4rem); padding: .4rem .6rem; }
    /* RE.2 — ajustes que explican el descuadre */
    .cb-explains { margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .5rem; }
    .cb-explains-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; font-size: .8rem; font-weight: 600; color: var(--text-main); }
    .cb-explains-head > span:first-child { display: inline-flex; align-items: center; gap: .4rem; }
    .cb-explains-sum { font-family: var(--font-mono); color: var(--action); font-weight: 600; }
    .cb-explains-none { font-size: .82rem; margin: 0; display: inline-flex; align-items: center; gap: .4rem; }
    .cb-explains-hint { font-size: .76rem; margin: 0; }
    .cb-explains-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .cb-explains-item { display: flex; align-items: center; gap: .55rem; padding: .4rem .55rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); background: var(--surface-sunken, var(--card-bg)); font-size: .82rem; }
    .cb-explains-folio { color: var(--text-main); }
    .cb-explains-fecha { font-size: .76rem; white-space: nowrap; }
    .cb-explains-motivo { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-main); }
    .cb-explains-exact { font-size: .72rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .25rem; white-space: nowrap; }
    .cb-explains-heur { font-size: .72rem; color: var(--text-muted); white-space: nowrap; }
    .cb-explains-monto { font-family: var(--font-mono); white-space: nowrap; }
    /* remisión adjunta en el detalle */
    .cb-view-attachments { margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .6rem; }
    .cb-view-att-head { font-size: .8rem; font-weight: 600; color: var(--text-main); }
    .cb-view-none { padding: .3rem 0; }
    .cb-view-dep { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .8rem .9rem; display: flex; flex-direction: column; gap: .6rem; }
    .cb-view-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .cb-view-meta { font-size: .74rem; color: var(--text-muted); margin-left: auto; }
    .cb-view-files { display: flex; flex-wrap: wrap; gap: .6rem; }
    .cb-view-filebtn { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); color: var(--action); background: var(--card-bg); font-size: .85rem; cursor: pointer; transition: border-color .15s, color .15s; }
    .cb-view-filebtn:hover { border-color: var(--action); }
    .cb-filebtn-name { color: var(--text-muted); font-size: .78rem; }
    /* visor modal de la imagen */
    .cb-viewer { display: flex; align-items: center; justify-content: center; background: #00000010; border-radius: var(--r-md, .5rem); padding: .5rem; }
    .cb-viewer img { display: block; max-width: 100%; max-height: 74vh; object-fit: contain; }
    .cb-view-pdf { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); color: var(--action); text-decoration: none; font-size: .85rem; }
    .cb-view-pdf:hover { border-color: var(--action); }
    .cb-view-pdf .pi-file-pdf { color: var(--bad-fg); }
    .cb-view-ocr { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; font-size: .78rem; color: var(--text-main); }
    .cb-view-ocr em { font-style: normal; color: var(--text-muted); margin-right: .3rem; }
    .cb-view-coment { font-size: .8rem; color: var(--text-muted); font-style: italic; }
    /* RE.8 — comparación de dos paneles: contenido/OCR (izq) + documento (der) */
    .cb-review { display: grid; grid-template-columns: 1fr; gap: 1.1rem; }
    @media (min-width: 62rem) { .cb-review { grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); align-items: start; } }
    .cb-review-main { min-width: 0; }
    .cb-review-doc { min-width: 0; }
    @media (min-width: 62rem) { .cb-review-doc { position: sticky; top: 0; align-self: start; } }
    .cb-doc-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .4rem; }
    .cb-doc-name { display: inline-flex; align-items: center; gap: .4rem; min-width: 0; font-size: .8rem; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-doc-name .pi-file-pdf { color: var(--bad-fg); }
    .cb-doc-frame { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); overflow: hidden; background: #00000010; height: 64vh; min-height: 24rem; display: flex; }
    .cb-doc-frame iframe { width: 100%; height: 100%; border: 0; background: #fff; }
    .cb-doc-frame img { width: 100%; height: 100%; object-fit: contain; }
    .cb-doc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6rem; height: 64vh; min-height: 24rem; border: 1px dashed var(--border-color); border-radius: var(--r-md, .5rem); color: var(--text-muted); text-align: center; padding: 1rem; background: var(--surface-sunken, var(--card-bg)); }
    .cb-doc-empty .pi { font-size: 1.9rem; opacity: .5; }
    .cb-view-filebtn.on { border-color: var(--action); color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
  `],
})
export class ComprasEntradasComponent {
  private readonly svc = inject(EntradasService);
  private readonly compras = inject(ComprasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly grSocket = inject(GoodsReceiptsSocketService);
  private readonly destroyRef = inject(DestroyRef);
  // RE.10 — órdenes de entrada nuevas detectadas por WS (pill "N nuevas — actualizar").
  readonly newCount = signal(0);

  readonly report = signal<EntradasReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly actingId = signal<string | null>(null);
  readonly estadoSel = signal<string>('pendiente');
  // Captura de evidencia (subir/OCR/adjuntar) requiere gestionar entradas.
  readonly canManage = computed(() => this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);
  // Validación restringida: permiso especial COMPRAS_ENTRADAS_VALIDAR (o god-mode admin).
  // GESTIONAR NO alcanza — que no todos puedan validar la evidencia.
  readonly canValidate = computed(() => this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_VALIDAR] === true);

  readonly estadoOpts = [{ label: 'Pendientes', value: 'pendiente' }, { label: 'Con remisión', value: 'con_comprobante' }, { label: 'Validadas', value: 'validado' }, { label: 'Todas', value: '' }];
  search = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  // attach dialog
  readonly showAttach = signal(false);
  readonly attachTarget = signal<EntradaRow | null>(null);
  // foto-primero (como Cobranza): sin entrada preseleccionada; se enlaza por OCR de la Aplica Orden Entrada.
  readonly photoFirst = signal(false);
  // Wizard foto-primero: 1 = solo la Aplica Orden Entrada (se lee y enlaza), 2 = demás documentos.
  readonly attachStep = signal<1 | 2>(1);
  readonly matching = signal(false);
  readonly matchCandidates = signal<EntradaRow[] | null>(null); // null = aún no buscado; [] = buscado, sin match
  manualSearch = '';
  readonly ocrLoading = signal(false);
  readonly ocrRun = signal(false);
  readonly attachError = signal<string>('');
  readonly attachFiles = signal<AttachFile[]>([]);
  readonly uploadingAny = computed(() => this.attachFiles().some((f) => f.uploading));
  // La ★ del paso 1 (la que se lee y enlaza). Habilita "Continuar".
  readonly ordenFile = computed(() => this.attachFiles().find((f) => f.role === 'orden_entrada') || null);
  // Set obligatorio de la recepción: Aplica Orden Entrada + Remisión/Factura + Vale (Ticket opcional).
  // RE (#4) — completitud CONSCIENTE DE FUENTE + packet-aware. La fuente (Kepler CEDIS /
  // Wincaja sucursal) define qué documentos exige la recepción; los tipos se detectan por OCR
  // (documents_present) ∪ el rol asignado → si subís TODO en un solo PDF también cumple.
  // El ENFOQUE es la FACTURA del proveedor: es lo único obligatorio (se compara contra
  // lo que ya trae Kepler). La orden de entrada queda OPCIONAL (solo para identificar).
  readonly REQUIRED_BY_SOURCE: Record<'kepler' | 'wincaja', { keys: string[]; label: string; optional?: boolean }[]> = {
    kepler: [
      { keys: ['factura', 'remision'], label: 'Factura' },
      { keys: ['aplica_orden_entrada'], label: 'Orden de entrada', optional: true },
    ],
    wincaja: [
      { keys: ['factura', 'remision'], label: 'Factura' },
      { keys: ['aplica_orden_entrada'], label: 'Orden de entrada', optional: true },
      { keys: ['ticket'], label: 'Ticket', optional: true },
    ],
  };
  private readonly ROLE_TO_TYPE: Record<string, string> = {
    orden_entrada: 'aplica_orden_entrada', remision: 'remision', factura: 'factura',
    vale: 'vale', ticket: 'ticket', orden_recepcion: 'orden_recepcion',
  };
  /** El origen (source_branch) define el set de docs. CEDIS (md_00) y las plazas `wincaja_*`
   *  reciben por WINCAJA (ticket + orden recepción + aplica OE); las sucursales Kepler
   *  (md_01–05) por KEPLER (aplica OE + factura). */
  receptionSource(e: EntradaRow | null): 'kepler' | 'wincaja' {
    const sb = (e?.source_branch || '').toLowerCase();
    return (sb.startsWith('wincaja') || sb === 'md_00') ? 'wincaja' : 'kepler';
  }
  readonly srcKind = computed<'kepler' | 'wincaja'>(() => this.receptionSource(this.attachTarget()));
  /** Tipos de documento cubiertos: rol asignado + lo que el OCR detectó en cada hoja (packet-aware). */
  readonly coveredTypes = computed(() => {
    const s = new Set<string>();
    for (const f of this.attachFiles()) {
      const t = this.ROLE_TO_TYPE[f.role]; if (t) s.add(t);
      for (const d of (f.ocrDocs || [])) s.add(d);
    }
    return s;
  });
  readonly requiredGroups = computed(() => this.REQUIRED_BY_SOURCE[this.srcKind()]);
  // Etiqueta legible por tipo de documento (para el resumen "Detectado en el PDF" y el checklist).
  private readonly DOC_LABEL: Record<string, string> = {
    aplica_orden_entrada: 'Aplica Orden Entrada', factura: 'Factura', remision: 'Remisión',
    ticket: 'Ticket', orden_recepcion: 'Orden de recepción', vale: 'Vale', otro: 'Otra hoja',
  };
  /** RE.pkt.1 — checklist auditable: cada requerido dice CÓMO se cumplió (auto=OCR con página+
   *  evidencia, o manual=rol asignado) para que no sea caja negra. */
  readonly checklist = computed(() => {
    const cov = this.coveredTypes();
    const files = this.attachFiles();
    const ocrByType = new Map<string, DocPresence>();
    for (const f of files) for (const d of (f.ocrDocsDetail || [])) if (!ocrByType.has(d.type)) ocrByType.set(d.type, d);
    const manualTypes = new Set<string>();
    for (const f of files) { const t = this.ROLE_TO_TYPE[f.role]; if (t) manualTypes.add(t); }
    return this.requiredGroups().map((g) => {
      const auto = g.keys.map((k) => ocrByType.get(k)).find((d): d is DocPresence => !!d) || null;
      const manual = g.keys.some((k) => manualTypes.has(k));
      return {
        label: g.label,
        ok: g.keys.some((k) => cov.has(k)),
        optional: !!g.optional,
        via: (auto ? 'auto' : manual ? 'manual' : null) as 'auto' | 'manual' | null,
        page: auto?.page ?? null,
        evidence: auto?.evidence ?? null,
      };
    });
  });
  // Solo los REQUERIDOS faltantes bloquean Guardar; los opcionales (ej. ticket de compra) no.
  readonly missingGroups = computed(() => this.checklist().filter((c) => !c.ok && !c.optional));
  /** RE.pkt.1 — todos los documentos que el OCR detectó en el/los archivo(s), con página+prueba;
   *  dedup por (tipo,página). Es el "recibo" de que un PDF combinado trae todo lo requerido. */
  readonly detectedDocs = computed(() => {
    const seen = new Set<string>();
    const out: { type: string; label: string; page: number | null; evidence: string | null }[] = [];
    for (const f of this.attachFiles()) for (const d of (f.ocrDocsDetail || [])) {
      const key = `${d.type}|${d.page}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ type: d.type, label: this.DOC_LABEL[d.type] || d.type, page: d.page, evidence: d.evidence });
    }
    return out.sort((a, b) => (a.page ?? 99) - (b.page ?? 99));
  });
  // Hojas duplicadas (misma imagen/PDF, o folio de remisión ya subido) → bloquean Guardar.
  readonly dupFiles = computed(() => this.attachFiles().filter((f) => f.dup));
  readonly ocrBusy = computed(() => this.attachFiles().some((f) => f.ocrLoading));
  private fileSeq = 0;
  ocrForm: Partial<RemisionOcr> = {};
  // Opciones del <select> de rol POR FUENTE — deben cubrir TODO tipo del checklist
  // (si no, un requerido queda imposible de marcar a mano y Guardar se traba).
  // Wincaja pide ticket + orden_recepcion + aplica_orden_entrada; Kepler, aplica_orden_entrada + factura/remisión.
  private readonly ROLE_OPTS_KEPLER = [
    { label: 'Aplica orden entrada', value: 'orden_entrada' },
    { label: 'Factura', value: 'factura' },
    { label: 'Otra evidencia', value: 'evidencia' },
  ];
  private readonly ROLE_OPTS_WINCAJA = [
    { label: 'Ticket de compra', value: 'ticket' },
    { label: 'Orden de recepción', value: 'orden_recepcion' },
    { label: 'Aplica orden entrada', value: 'orden_entrada' },
    { label: 'Remisión/Factura', value: 'remision' },
    { label: 'Otra evidencia', value: 'evidencia' },
  ];
  readonly roleOpts = computed(() => this.srcKind() === 'wincaja' ? this.ROLE_OPTS_WINCAJA : this.ROLE_OPTS_KEPLER);

  // reject dialog
  readonly showReject = signal(false);
  readonly rejectTarget = signal<EntradaRow | null>(null);
  rejectMotivo = '';

  // detail dialog (auditoría por línea + remisión adjunta)
  /** Ficha abierta en el panel lateral (`null` = cerrado). Hace clickeable la vista entera. */
  readonly inspect = signal<string | null>(null);

  refProv(code: string | null): string { return entityRef('prov', code); }
  refEnt(sucursal: string, folio: string): string { return entityRef('ent', sucursal, 'XA2001', folio); }
  refLin(sucursal: string, folio: string, linea: string): string { return entityRef('lin', sucursal, folio, linea); }
  refSku(sku: string): string { return entityRef('sku', sku); }
  refAdj(a: AdjustmentForEntradaRow): string { return entityRef('adj', a.doctype, a.sucursal, a.folio); }
  refOc(sucursal: string, folio: string): string { return entityRef('pdoc', 'XA3501', sucursal, folio); }
  refVale(sucursal: string, folio: string): string { return entityRef('pdoc', 'XA3701', sucursal, folio); }

  readonly showDetail = signal(false);
  readonly detailLoading = signal(false);
  readonly detailData = signal<EntradaDetail | null>(null);
  readonly detailTarget = signal<EntradaRow | null>(null);

  // Visor de imagen bajo demanda (no se carga la imagen inline en el detalle).
  readonly viewerOpen = signal(false);
  readonly viewerUrl = signal<string | null>(null);
  readonly viewerName = signal<string>('');
  openImage(url: string, name?: string): void { this.viewerName.set(name || ''); this.viewerUrl.set(url); this.viewerOpen.set(true); }
  closeImage(): void { this.viewerOpen.set(false); }

  // RE.8 — documento mostrado en el panel derecho del detalle (comparación vs OCR).
  readonly selectedDoc = signal<{ url: string; safeUrl: SafeResourceUrl | null; kind: 'image' | 'pdf'; name: string } | null>(null);
  selectDoc(f: ProofFile): void {
    const isImg = this.isImageUrl(f);
    this.selectedDoc.set({
      url: f.url,
      safeUrl: isImg ? null : this.sanitizer.bypassSecurityTrustResourceUrl(f.url), // iframe requiere SafeResourceUrl
      kind: isImg ? 'image' : 'pdf',
      name: f.name || (isImg ? 'imagen' : 'remisión (PDF)'),
    });
  }

  // RE.2 — ajustes (X-D-40/55) que explican el descuadre de esta entrada
  readonly explains = signal<AdjustmentForEntradaRow[]>([]);
  readonly explainsLoading = signal(false);
  readonly explainsTotal = signal(0);

  constructor() {
    this.load();
    // RE.10 — WS near-real-time: el watcher del backend avisa cuando llegan órdenes nuevas.
    this.grSocket.connect();
    this.grSocket.newReceipts$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      this.newCount.update((c) => c + e.count);
      const first = e.sample?.[0];
      this.toast.add({ severity: 'info', summary: `${e.count} orden(es) de entrada nueva(s)`, detail: first ? (first.proveedor || `${first.sucursal}/${first.folio}`) : 'Actualizá para verlas' });
    });
    this.destroyRef.onDestroy(() => this.grSocket.disconnect());
  }

  /** Aplica las nuevas: recarga la lista y limpia el contador del pill. */
  applyNew(): void { this.newCount.set(0); this.load(); }

  kpiItems(r: EntradasReport): MetricStripItem[] {
    return [
      { label: 'Entradas', value: r.kpis.entradas },
      { label: 'Con remisión', value: r.kpis.con_comprobante, tone: 'ok' },
      { label: 'Validadas', value: r.kpis.validados, tone: 'ok' },
      { label: '$ por comprobar', value: this.money(r.kpis.monto_pendiente), tone: 'warn' },
    ];
  }

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
        error: () => { this.error.set('No se pudieron cargar las entradas.'); this.loading.set(false); },
      });
  }

  // ── Descarte de captura (DESIGN §Leyes 8) ────────────────────────────────────
  // Un modal de captura ACTIVA nunca descarta en silencio: ni por el botón Cancelar,
  // ni por la ✕, ni por Escape. La fricción es PROPORCIONAL — si no hay nada
  // capturado, cierra directo (preguntar de gratis también es mal diseño).

  /** Hay trabajo real que se perdería: hojas subidas, OCR corrido, tipos asignados a mano. */
  readonly attachDirty = computed(() => this.attachFiles().length > 0);
  /** Motivo tecleado que se perdería. */
  private rejectDirty(): boolean { return !!this.rejectMotivo.trim(); }

  private askDiscard(detail: string, onDiscard: () => void) {
    this.confirm.confirm({
      header: '¿Descartar la captura?',
      message: detail,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, descartar',
      rejectLabel: 'Seguir capturando',
      acceptButtonStyleClass: 'p-button-danger',
      accept: onDiscard,
    });
  }

  /** Cancelar / ✕ / Escape del diálogo de adjuntar. */
  closeAttach() {
    if (!this.attachDirty()) { this.showAttach.set(false); return; }
    const n = this.attachFiles().length;
    this.askDiscard(
      `Se perderán ${n === 1 ? 'la hoja adjunta' : 'las ' + n + ' hojas adjuntas'} y su lectura de OCR. Los archivos ya subidos no quedan ligados a ninguna entrada.`,
      () => this.showAttach.set(false),
    );
  }

  /** Cancelar / ✕ / Escape del diálogo de rechazo. */
  closeReject() {
    if (!this.rejectDirty()) { this.showReject.set(false); return; }
    this.askDiscard('Se perderá el motivo del rechazo que escribiste.', () => this.showReject.set(false));
  }

  /** PrimeNG no trae un evento cancelable de cierre → interceptamos el cambio de
   *  visibilidad: si el cierre viene de la ✕ o de Escape con captura sucia, lo
   *  revertimos y pedimos confirmación. */
  onAttachVisible(v: boolean) { if (v) this.showAttach.set(true); else if (this.attachDirty()) this.closeAttach(); else this.showAttach.set(false); }
  onRejectVisible(v: boolean) { if (v) this.showReject.set(true); else if (this.rejectDirty()) this.closeReject(); else this.showReject.set(false); }

  openAttach(c: EntradaRow) {
    this.photoFirst.set(false);
    this.attachTarget.set(c);
    this.resetAttach();
    this.attachStep.set(2); // ya hay entrada: directo a los documentos
    this.showAttach.set(true);
  }

  /** Foto-primero: sin entrada; se enlaza por el OCR de la Aplica Orden Entrada (o manual). */
  openAttachPhotoFirst() {
    this.photoFirst.set(true);
    this.attachTarget.set(null);
    this.resetAttach();
    this.attachStep.set(1); // paso 1: solo la Aplica Orden Entrada
    this.showAttach.set(true);
  }

  /** Paso 1 → 2: basta con la entrada IDENTIFICADA (por folio). La orden de entrada es opcional. */
  continuar() { if (this.attachTarget()) this.attachStep.set(2); }
  backToStep1() { this.attachStep.set(1); }

  private resetAttach() {
    this.attachFiles.set([]);
    this.ocrForm = {};
    this.ocrRun.set(false);
    this.ocrLoading.set(false);
    this.matching.set(false);
    this.matchCandidates.set(null);
    this.manualSearch = '';
    this.attachError.set('');
  }

  /** Multi-archivo: acumula todas las hojas elegidas (lo normal son 3–4).
   *  Secuencial: garantiza que la 1ª elegida quede como ★ (Aplica Orden Entrada). */
  async onFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = ''; // permite volver a elegir el mismo archivo
    for (const file of picked) await this.addOne(file);
  }

  // RE.7 — arrastrar el PDF y que corra el OCR solo (reusa el mismo pipeline que onFiles).
  readonly dragging = signal(false);
  onDragOver(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); if (!this.dragging()) this.dragging.set(true); }
  onDragLeave(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false); }
  async onDrop(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation();
    this.dragging.set(false);
    const files = ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { this.attachError.set('Solo se aceptan archivos PDF — arrastrá un PDF.'); return; }
    const rejected = files.length - pdfs.length;
    if (rejected > 0) this.attachError.set(`Se ignoraron ${rejected} archivo(s) que no son PDF.`);
    for (const f of pdfs) await this.addOne(f); // 1º = ★ Aplica Orden Entrada → OCR + enlace automático
  }

  private async addOne(file: File) {
    if (file.size > 20 * 1024 * 1024) { this.attachError.set(`"${file.name}" supera 20 MB.`); return; }
    this.attachError.set('');
    let dataUri: string;
    try { dataUri = await this.fileToDataUri(file); }
    catch { this.attachError.set(`No se pudo leer "${file.name}".`); return; }
    // Anti-hoja-duplicada (misma sesión): hash del contenido; si ya está en la lista, no la agrega.
    const hash = await this.sha256Hex(dataUri.replace(/^data:[^,]*,/, ''));
    if (hash && this.attachFiles().some((f) => f.sha256 === hash)) {
      this.attachError.set(`"${file.name}" ya está en la lista (misma hoja).`);
      return;
    }
    const kind: 'image' | 'pdf' = dataUri.startsWith('data:application/pdf') ? 'pdf' : 'image';
    const id = ++this.fileSeq;
    // El ENFOQUE es la FACTURA: el 1er archivo default = factura/remisión (★, la que cuadra
    // contra Kepler). La orden de entrada queda como slot opcional posterior. EXCEPCIÓN: el drop
    // del PASO 1 (foto-primero) es específicamente la orden de entrada → rol orden_entrada + auto-enlace.
    const step1Oe = this.photoFirst() && this.attachStep() === 1;
    const roleSeq = this.srcKind() === 'wincaja'
      ? ['remision', 'orden_entrada', 'ticket']
      : ['factura', 'orden_entrada'];
    this.attachFiles.update((l) => {
      const primary = !l.some((f) => f.primary);
      const af: AttachFile = {
        id, name: file.name, dataUri, kind,
        role: step1Oe ? 'orden_entrada' : (roleSeq[l.length] || 'evidencia'),
        uploaded: null, uploading: false, failed: false, primary,
        sha256: hash || undefined, ocrLoading: true,
      };
      return l.concat(af);
    });
    this.uploadOne(id);
    this.runFileOcr(id); // TODAS las hojas se leen con OCR (la ★ además enlaza la entrada)
  }

  /** SHA-256 hex del contenido (para el anti-duplicado del lado cliente). */
  private async sha256Hex(text: string): Promise<string> {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { return ''; } // sin secure context: el dedup por hash lo cubre el server
  }

  /** Suelta el base64 solo cuando la hoja ya se subió Y se leyó (no la ★). Así no se retiene en el teléfono. */
  private maybeDropBase64(id: number) {
    const f = this.attachFiles().find((x) => x.id === id);
    if (f && f.uploaded && f.ocrDone && !f.primary && f.dataUri) this.patch(id, { dataUri: '' });
  }

  /** Imagen → JPEG reducido (lado mayor ≤1920px, ~0.82) como data URI; el PDF se lee
   *  tal cual. Recorta el payload de fotos de cámara (evita 413) y acelera el OCR.
   *  Si la reducción falla, cae a leer el original (el backend acepta hasta 32mb). */
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

  private patch(id: number, p: Partial<AttachFile>) {
    this.attachFiles.update((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)));
  }

  private uploadOne(id: number) {
    const af = this.attachFiles().find((f) => f.id === id);
    if (!af) return;
    this.patch(id, { uploading: true, failed: false });
    this.svc.uploadFile(af.dataUri, af.role).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (up) => { this.patch(id, { uploaded: up, uploading: false }); this.maybeDropBase64(id); },
        error: () => this.patch(id, { uploading: false, failed: true }),
      });
  }
  retryUpload(f: AttachFile) { this.uploadOne(f.id); }
  setRole(f: AttachFile, role: string) { this.patch(f.id, { role }); }

  setPrimary(f: AttachFile) {
    this.attachFiles.update((l) => l.map((x) => ({ ...x, primary: x.id === f.id })));
    const cur = this.attachFiles().find((x) => x.id === f.id);
    if (cur?.dataUri) { this.runFileOcr(f.id); }
    else {
      // base64 ya soltado: reusa el OCR por-archivo ya leído para el cuadre/enlace.
      this.ocrForm = { folio: f.ocrFolio ?? null, total: f.ocrTotal ?? null, fecha: f.ocrFecha ?? null, rfc: f.ocrRfc ?? null, ocr_status: f.ocrDone ? 'ok' : 'ilegible' };
      this.ocrRun.set(true); this.afterOcrMatch();
    }
  }

  removeFile(f: AttachFile) {
    this.attachError.set('');
    const wasPrimary = f.primary;
    this.attachFiles.update((l) => l.filter((x) => x.id !== f.id));
    if (wasPrimary) {
      const next = this.attachFiles()[0];
      if (next) this.setPrimary(next);
      else { this.ocrRun.set(false); this.ocrForm = {}; }
    }
  }

  /** OCR de UNA hoja: guarda su folio/total propio + detecta duplicado (misma hoja o folio ya
   *  subido). Si es la ★, además alimenta el cuadre y enlaza la entrada (foto-primero). */
  private runFileOcr(id: number) {
    const f = this.attachFiles().find((x) => x.id === id);
    if (!f) return;
    if (!f.dataUri) { this.patch(id, { ocrLoading: false, ocrDone: true }); return; }
    this.patch(id, { ocrLoading: true });
    if (f.primary) this.ocrLoading.set(true);
    this.svc.ocr(f.dataUri, f.role).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.patch(id, {
            ocrLoading: false, ocrDone: true,
            ocrFolio: r.folio ?? null, ocrTotal: r.total ?? null, ocrSubtotal: r.subtotal ?? null, ocrFecha: r.fecha ?? null, ocrRfc: r.rfc ?? null,
            ocrDocs: (r.documents_present ?? []).map((d) => d.type), ocrDocsDetail: r.documents_present ?? [],
            sha256: r.sha256 || f.sha256, dup: r.duplicate ?? null,
          });
          if (r.duplicate) this.attachError.set(this.dupMsg(f.name, r.duplicate));
          const cur = this.attachFiles().find((x) => x.id === id);
          if (cur?.primary) { this.ocrForm = { ...r }; this.ocrRun.set(true); this.ocrLoading.set(false); this.afterOcrMatch(); }
          this.maybeDropBase64(id);
        },
        error: () => {
          this.patch(id, { ocrLoading: false, ocrDone: true });
          const cur = this.attachFiles().find((x) => x.id === id);
          if (cur?.primary) { this.ocrLoading.set(false); this.ocrForm = { ocr_status: 'ilegible' }; this.ocrRun.set(true); }
        },
      });
  }
  private dupMsg(name: string, d: DuplicateHit): string {
    const where = `entrada ${d.sucursal}/${d.folio}${d.proveedor ? ' · ' + d.proveedor : ''}`;
    return d.reason === 'file' ? `"${name}" ya se había subido (${where}). Quitala.` : `El folio de "${name}" ya se subió (${where}). Quitala.`;
  }
  dupText(f: AttachFile): string {
    const d = f.dup; if (!d) return '';
    return (d.reason === 'file' ? 'Misma hoja ya subida' : 'Folio ya subido') + ` · ${d.sucursal}/${d.folio}`;
  }
  runOcr() { const p = this.attachFiles().find((f) => f.primary); if (p && p.dataUri) this.runFileOcr(p.id); }

  /** Tras leer la Aplica Orden Entrada (★), enlaza la entrada por folio/total (solo foto-primero). */
  private afterOcrMatch() {
    if (!this.photoFirst() || this.attachTarget()) return;
    this.matching.set(true);
    this.svc.matchByOcr({ folio: this.ocrForm.folio || undefined, total: this.ocrForm.total ?? undefined, fecha: this.ocrForm.fecha || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.matching.set(false);
          const e = res.entradas || [];
          if (e.length === 1) { this.attachTarget.set(e[0]); this.matchCandidates.set(null); }
          else this.matchCandidates.set(e); // 0 o varias → el usuario elige/busca
        },
        error: () => { this.matching.set(false); this.matchCandidates.set([]); },
      });
  }
  runManualSearch() {
    const s = (this.manualSearch || '').trim();
    if (!s) return;
    this.matching.set(true);
    this.svc.matchByOcr({ search: s }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => { this.matching.set(false); this.matchCandidates.set(res.entradas || []); },
        error: () => { this.matching.set(false); this.matchCandidates.set([]); },
      });
  }
  pickEntrada(e: EntradaRow) { this.attachTarget.set(e); this.matchCandidates.set(null); }
  unlinkEntrada() { this.attachTarget.set(null); if (this.ocrRun()) this.afterOcrMatch(); else this.matchCandidates.set(null); }

  /** Cuadra si el total O el subtotal de la remisión ≈ el valor de la entrada. */
  matchState(): boolean | null {
    const t = this.attachTarget();
    if (!t) return null;
    const near = (v: number | null | undefined) => v != null && !isNaN(Number(v)) && Math.abs(Number(v) - t.monto) <= 1;
    const total = this.ocrForm.total, sub = this.ocrForm.subtotal;
    if ((total == null || isNaN(Number(total))) && (sub == null || isNaN(Number(sub)))) return null;
    return near(total) || near(sub);
  }
  diff(): number {
    const t = this.attachTarget();
    if (!t) return 0;
    const cands = [this.ocrForm.total, this.ocrForm.subtotal]
      .filter((v) => v != null && !isNaN(Number(v)))
      .map((v) => Math.abs(Number(v) - t.monto));
    return cands.length ? Math.min(...cands) : 0;
  }

  saveAttach() {
    const t = this.attachTarget();
    const files = this.attachFiles();
    if (!t || !files.length) { this.attachError.set('Agregá al menos una foto.'); return; }
    if (this.dupFiles().length) { this.attachError.set('Hay hojas duplicadas (misma imagen o folio ya subido). Quitalas para guardar.'); return; }
    if (this.missingGroups().length) { this.attachError.set('Faltan documentos: ' + this.missingGroups().map((g) => g.label).join(', ') + '.'); return; }
    this.attachError.set('');
    this.saving.set(true);
    // Sube las que falten (o fallaron), conserva las ya almacenadas → UNA evidencia con TODAS las fotos.
    const uploads = files.map((f) => f.uploaded
      ? of({ f, up: f.uploaded })
      : this.svc.uploadFile(f.dataUri, f.role).pipe(map((up) => ({ f, up }))));
    forkJoin(uploads).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (results) => {
        const proofFiles: ProofFile[] = results.map(({ f, up }) => ({
          ...up, role: f.role, name: f.name,
          // Por-archivo: hash (anti-dup) + su OCR propio (cada hoja se lee).
          sha256: f.sha256, ocr_folio: f.ocrFolio ?? null, ocr_total: f.ocrTotal ?? null, ocr_fecha: f.ocrFecha ?? null, ocr_rfc: f.ocrRfc ?? null,
        }));
        // RE.pkt.2 — el CUADRE (monto_match) debe usar el total de la FACTURA/REMISIÓN, sin importar
        // cuál hoja es la ★. Elegimos la hoja fiscal por tipo DETECTADO (o rol). Si la fiscal es la ★,
        // usamos el form (respeta ediciones del capturista); si viene APARTE, usamos su OCR propio.
        // Fallback: el form (PDF combinado, o captura manual sin hoja fiscal distinguible).
        const isFiscal = (f: AttachFile) => (f.ocrDocs || []).some((d) => d === 'factura' || d === 'remision') || f.role === 'factura' || f.role === 'remision';
        const fiscalFile = files.find((f) => f.primary && isFiscal(f)) || files.find(isFiscal) || null;
        const ocr: Partial<RemisionOcr> | undefined =
          fiscalFile && !fiscalFile.primary
            ? { folio: fiscalFile.ocrFolio ?? null, total: fiscalFile.ocrTotal ?? null, subtotal: fiscalFile.ocrSubtotal ?? null, fecha: fiscalFile.ocrFecha ?? null, rfc: fiscalFile.ocrRfc ?? null, ocr_status: 'ok' }
            : (this.ocrRun() ? this.ocrForm : undefined);
        this.svc.attach({ sucursal: t.sucursal, folio: t.folio, files: proofFiles, ocr })
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (res) => { this.saving.set(false); this.resetAttach(); this.showAttach.set(false); this.toast.add({ severity: 'success', summary: `${proofFiles.length} foto(s) adjuntada(s)`, detail: res.monto_match ? 'El total cuadra ✓' : 'Guardado (revisa el total)' }); this.load(); },
            error: (e) => { this.saving.set(false); this.attachError.set(e?.error?.message || 'No se pudo adjuntar.'); },
          });
      },
      error: () => { this.saving.set(false); this.attachError.set('No se pudieron subir algunas fotos. Reintentá.'); },
    });
  }

  doValidate(c: EntradaRow) {
    if (!c.deposit_id || this.actingId()) return;
    this.actingId.set(c.deposit_id);
    this.svc.validate(c.deposit_id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'success', summary: 'Validada', detail: `Entrada ${c.folio}` }); this.load(); },
        error: () => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(c: EntradaRow) { this.rejectTarget.set(c); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const c = this.rejectTarget();
    if (!c?.deposit_id) return;
    this.saving.set(true);
    this.svc.reject(c.deposit_id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.rejectMotivo = ''; this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: `Entrada ${c.folio}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  openDetail(c: EntradaRow) {
    this.detailTarget.set(c);
    this.detailData.set(null);
    this.selectedDoc.set(null);
    this.detailLoading.set(true);
    this.showDetail.set(true);
    this.loadExplains(c);
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.detailData.set(d);
          this.detailLoading.set(false);
          // Muestra el 1er documento en el panel derecho para comparar contra el OCR.
          let first: ProofFile | null = null;
          for (const dep of d.deposits || []) { if (dep.files && dep.files.length) { first = dep.files[0]; break; } }
          if (first) this.selectDoc(first);
        },
        error: () => { this.detailLoading.set(false); this.showDetail.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar el detalle' }); },
      });
  }

  /**
   * RE.2 — busca los ajustes X-D-40/55 (devoluciones / notas de crédito / descuentos)
   * del proveedor que pueden EXPLICAR por qué la factura no cuadra con la entrada.
   * Link exacto por folio de entrada cuando existe; si no, proveedor + ventana ±15d.
   */
  private loadExplains(c: EntradaRow) {
    this.explains.set([]);
    this.explainsTotal.set(0);
    if (!c.proveedor_code && !c.folio) return;
    this.explainsLoading.set(true);
    this.compras.adjustmentsForEntrada({ proveedor_code: c.proveedor_code, entrada_folio: c.folio, date: c.receipt_date, window_days: 15 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.explains.set(r.rows || []); this.explainsTotal.set(r.total_monto || 0); this.explainsLoading.set(false); },
        error: () => { this.explainsLoading.set(false); },
      });
  }
  adjDoctypeLabel(dt: string): string { return dt === 'XD40' ? 'Devolución' : 'Nota de crédito'; }
  adjGrupoLabel(g: AdjustmentGrupo): string { return ({ comercial: 'Descuento/apoyo', operacional: 'Operativo', error: 'Error de captura', sin_clasificar: 'Sin clasificar' } as Record<string, string>)[g] || g; }
  adjGrupoSev(g: AdjustmentGrupo): 'success' | 'warn' | 'danger' | 'secondary' { return ({ comercial: 'success', operacional: 'warn', error: 'danger', sin_clasificar: 'secondary' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[g] || 'secondary'; }

  fromDetailToAttach() { const c = this.detailTarget(); this.showDetail.set(false); if (c) this.openAttach(c); }
  lineasTotal(lineas: EntradaLinea[]): number { return (lineas || []).reduce((s, l) => s + (Number(l.importe) || 0), 0); }
  lineasDiff(d: EntradaDetail): number { return Math.abs(this.lineasTotal(d.lineas) - (Number(d.entrada.monto) || 0)); }
  lineasCuadra(d: EntradaDetail): boolean { return this.lineasDiff(d) <= 1; }

  /** El archivo ELEGIDO (data URI, aún sin subir) es imagen / PDF. */
  /** Un archivo YA subido (Cloudinary) es imagen (por kind o extensión) — si no, se trata como PDF/archivo. */
  isImageUrl(f: ProofFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }

  discLabel(k: string): string { return ({ iva: 'Diferencia = IVA', typo: 'Posible error de captura', otro: 'Descuadre', cuadra: 'Cuadra' } as Record<string, string>)[k] || k; }
  discSev(k: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ cuadra: 'success', iva: 'secondary', typo: 'danger', otro: 'warn' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[k] || 'secondary'; }
  depLabel(s: string | null): string { return ({ recibido: 'Recibido', validado: 'Validado', rechazado: 'Rechazado' } as Record<string, string>)[s || ''] || '—'; }
  depSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibido: 'warn', validado: 'success', rechazado: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
