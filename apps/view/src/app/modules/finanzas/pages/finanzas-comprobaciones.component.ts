import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { FileUploadModule } from 'primeng/fileupload';
import { TextareaModule } from 'primeng/textarea';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ExpenseProofsSocketService } from '../expense-proofs-socket.service';
import { money } from '../../../shared/util';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ComercialService, ExpenseRequestRow } from '../../comercial/comercial.service';
import { ProofPhotoOcr, ComprobacionesService, ExpenseProof, ExpenseProofDetail, ExpenseProofsReport, CreateExpenseProof, Departamento, ProofFile, ProofFileRole } from '../comprobaciones.service';
import { dmy } from './finanzas-format';

interface FileSlot { role: ProofFileRole; label: string; required: boolean; accept: string; }
/** Un adjunto listo para pintar. `safeUrl` se sanitiza UNA vez al abrir: hacerlo en el
 *  template recrearía el iframe en cada ciclo de detección. */
interface PeekDoc { role: string; label: string; url: string; isPdf: boolean; safeUrl: SafeResourceUrl | null; failed: boolean; }
interface SolicitudSug extends ExpenseRequestRow { label: string; }

/**
 * GX.7 — "Solicitud de autorización de gastos" (reembolso). Captura ligada a la
 * solicitud de Kepler (XA1501): se elige la solicitud (autocomplete), se auto-
 * rellenan proveedor/fecha/importe/solicitante, y se adjunta la evidencia
 * (comprobante h1/h2 + 3 fotos). Solo el comprobante h1 es obligatorio: la
 * solicitud NO se pide porque ya está en Kepler y se lee por folio. Flujo
 * recibida→validada/rechazada. No escribe a Kepler; se concilia por folio.
 */
@Component({
  selector: 'app-finanzas-comprobaciones',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, AutoCompleteModule, DatePickerModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, FileUploadModule, TextareaModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, ContextHelpComponent, LoadStateComponent, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head cp-head">
        <div class="surf-page-head-text">
          <div style="display:inline-flex;align-items:center;gap:.4rem"><h1>Solicitudes de reembolso</h1><app-context-help topic="reembolsos" /></div>
          <p class="surf-page-sub">Adjunta los comprobantes de una solicitud de gasto (Kepler XA1501) · recibida → validada/rechazada</p>
          @if (!verAll()) {
            <span class="cg-scope" title="Solo ves las solicitudes de las áreas que se te asignaron. Pedí 'Ver gastos de todos los departamentos' para ver todo."><i class="pi pi-filter" aria-hidden="true"></i> Viendo solo tus áreas asignadas</span>
          }
          @if (liveConnected()) { <span class="cg-live"><i class="pi pi-circle-fill" aria-hidden="true"></i> En vivo</span> }
        </div>
        <button pButton type="button" (click)="openNew()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nueva solicitud</span></button>
      </header>

      <div class="cp-filters card-premium card-flat">
        <div class="cp-field"><label>Estado</label>
          <app-segmented [options]="statusOpts" [value]="statusSel()" (valueChange)="setStatus($event)" ariaLabel="Estado" /></div>
        <div class="cp-field cp-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Folio solicitud, proveedor, solicitante…" (keyup.enter)="load()" (blur)="queue()" /></div>
      </div>

      @if (report(); as r) {
        <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen" />
      }

      @if (error()) {
        <app-load-state [error]="error()" (retry)="load()"></app-load-state>
      } @else {
      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm cp-table" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
                 [paginator]="rows().length > 100" [rows]="100" [loading]="loading()" sortField="created_at" [sortOrder]="-1">
          <ng-template #header>
            <tr>
              <th pSortableColumn="created_at" style="width:6rem">Fecha <p-sorticon field="created_at" /></th>
              <th pSortableColumn="folio_solicitud" style="width:7rem">Folio sol. <p-sorticon field="folio_solicitud" /></th>
              <th>Solicitante</th>
              <th>Departamento</th>
              <th>Proveedor</th>
              <th class="ta-r" style="width:8rem">Importe</th>
              <th style="width:8rem">Adjuntos</th>
              <th style="width:7rem">Estado</th>
              <th style="width:11rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td>{{ r.created_at | date:'dd/MM/yy' }}</td>
              <td class="mono">{{ r.folio_solicitud }}</td>
              <td>{{ r.solicitante }}</td>
              <td class="muted">{{ r.departamento }}<div class="cp-suc-cell">{{ r.sucursal }}</div></td>
              <td>{{ r.proveedor }}</td>
              <td class="ta-r strong">{{ r.importe ? money(r.importe) : '—' }}</td>
              <td>
                <div class="cp-files">
                  @for (f of r.files; track f.url) {
                    <button pButton type="button" class="p-button-sm p-button-text cp-fchip" (click)="openPeek(r)"
                            [attr.aria-label]="'Ver ' + fileLabel(f.role) + ' de ' + r.folio_solicitud" [title]="fileLabel(f.role)">
                      <span class="p-button-icon pi" [ngClass]="f.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'" aria-hidden="true"></span>
                    </button>
                  } @empty { <span class="muted">—</span> }
                </div>
              </td>
              <td>
                <p-tag [value]="statusLabel(r.status)" [severity]="statusSev(r.status)" />
                @if (r.status === 'validada' && r.validated_by === 'Claude Vision') { <span class="cp-vision" title="Validada automáticamente por Claude Vision"><i class="pi pi-sparkles" aria-hidden="true"></i></span> }
                @if (r.status === 'revision' && r.revision_nota) { <div class="cp-motivo" [title]="r.revision_nota">{{ r.revision_nota }}</div> }
                @if (r.status === 'rechazada' && r.motivo_rechazo) { <div class="cp-motivo" [title]="r.motivo_rechazo">{{ r.motivo_rechazo }}</div> }
              </td>
              <td>
                <button pButton type="button" size="small" text (click)="openPeek(r)"
                        [attr.aria-label]="'Ver el comprobante de ' + r.folio_solicitud" title="Ver comprobante y cuadre">
                  <span class="p-button-icon p-button-icon-left pi pi-eye" aria-hidden="true"></span>
                </button>
                @if (canManage()) {
                  @if (r.status !== 'validada') { <button pButton type="button" size="small" text severity="success" [loading]="validatingId() === r.id" [disabled]="!!validatingId()" (click)="doValidate(r)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Validar</span></button> }
                  @if (r.status !== 'rechazada') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(r)" title="Rechazar"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span></button> }
                } @else { <span class="muted">—</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="9" class="cp-empty">Sin solicitudes para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
      }
    </div>

    <!-- Detalle de quien revisa: el cuadre, la evidencia RENDERIZADA y la decisión, en
         un solo lugar y sin perder la bandeja. Antes esta pantalla no tenía detalle: el
         adjunto era un icono de 20px que abría otra pestaña con una URL ya vencida. -->
    <app-side-peek [open]="peekOpen()" (openChange)="onPeekToggle($event)"
                   title="Comprobante de reembolso" [subtitle]="peekSub()">
      @if (peek(); as pk) {
        <!-- Q.1/Q.2 — el cuadre primero: es la base de aprobar o no. El backend ya lo
             calcula (monto_ocr / monto_match) y la bandeja lo tiraba a la basura. -->
        <div class="cpk-verdict" [class.ok]="pk.monto_match === true" [class.warn]="pk.monto_match !== true">
          <i class="pi" [ngClass]="pk.monto_match === true ? 'pi-check-circle' : 'pi-exclamation-circle'" aria-hidden="true"></i>
          <div>
            <h3>{{ cuadreTitulo(pk) }}</h3>
            <p>{{ cuadreLectura(pk) }}</p>
          </div>
        </div>

        <div class="cpk-tri">
          <div><span class="cpk-k">Solicitud Kepler</span><span class="cpk-v">{{ money(pk.importe) }}</span><span class="cpk-m">{{ pk.folio_solicitud }}</span></div>
          <div><span class="cpk-k">Leído del comprobante</span><span class="cpk-v">{{ pk.monto_ocr != null ? money(pk.monto_ocr) : '—' }}</span><span class="cpk-m">{{ pk.monto_ocr != null ? 'Claude Vision' : 'sin lectura' }}</span></div>
          <div><span class="cpk-k">Diferencia</span><span class="cpk-v">{{ diffTxt(pk) }}</span><span class="cpk-m">tolera $1 o 1%</span></div>
        </div>

        @if (pk.status === 'revision' && pk.revision_nota) { <p class="cpk-note"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ pk.revision_nota }}</p> }
        @if (pk.status === 'rechazada' && pk.motivo_rechazo) { <p class="cpk-note is-bad"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ pk.motivo_rechazo }}</p> }

        <h4 class="cpk-sec">Evidencia</h4>
        @if (peekLoading()) {
          <div class="cpk-sk" aria-hidden="true"></div>
        } @else {
          @for (d of peekDocs(); track d.url) {
            <figure class="cpk-doc">
              <figcaption>{{ d.label }}</figcaption>
              @if (d.failed) {
                <!-- Un archivo que no carga NO es un archivo que no existe: decirlo. -->
                <div class="cpk-broken">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  <span>No se pudo cargar el archivo. El enlace se firma al abrir y expira; cerrá y volvé a abrir. Si sigue, hay que volver a subirlo.</span>
                </div>
              } @else if (d.isPdf) {
                <iframe [src]="d.safeUrl" [title]="d.label" class="cpk-frame"></iframe>
              } @else {
                <img [src]="d.url" [alt]="d.label" class="cpk-img" (error)="onDocError(d.url)" />
              }
              <a [href]="d.url" target="_blank" rel="noopener" class="cpk-open"><i class="pi pi-external-link" aria-hidden="true"></i> Abrir a tamaño completo</a>
            </figure>
          } @empty {
            <div class="cpk-broken">
              <i class="pi pi-inbox" aria-hidden="true"></i>
              <span>{{ pk.storage_ok === false ? 'Hay adjuntos pero el almacenamiento no está configurado en el servidor — avisá a sistemas.' : 'Esta solicitud se envió sin adjuntos.' }}</span>
            </div>
          }
        }

        <h4 class="cpk-sec">Datos</h4>
        <dl class="cpk-dl">
          <dt>Solicitante</dt><dd>{{ pk.solicitante || '—' }}</dd>
          <dt>Proveedor</dt><dd>{{ pk.proveedor || '—' }}</dd>
          <dt>Departamento</dt><dd>{{ pk.departamento || '—' }}{{ pk.sucursal ? ' · ' + pk.sucursal : '' }}</dd>
          <dt>Fecha del gasto</dt><dd>{{ pk.fecha_gasto ? dmy(pk.fecha_gasto) : '—' }}</dd>
          <dt>Capturó</dt><dd>{{ pk.created_by || '—' }}</dd>
          @if (pk.validated_by) { <dt>Resolvió</dt><dd>{{ pk.validated_by }}</dd> }
          @if (pk.comentarios) { <dt>Comentarios</dt><dd>{{ pk.comentarios }}</dd> }
        </dl>

        @if (canManage()) {
          <div class="cpk-acts">
            @if (pk.status !== 'validada') {
              <button pButton type="button" severity="success" [loading]="validatingId() === pk.id" [disabled]="!!validatingId()" (click)="doValidate(pk)">
                <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Validar</span></button>
            }
            @if (pk.status !== 'rechazada') {
              <button pButton type="button" severity="danger" text (click)="openReject(pk)">
                <span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
            }
          </div>
        }
      }
    </app-side-peek>

    <!-- Diálogo: nueva solicitud de reembolso -->
    <p-dialog [(visible)]="showForm" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" header="Nueva solicitud de reembolso">
      <div class="cp-form">
        <!-- Llegando desde la lista de solicitudes, la solicitud YA está en Kepler y trae
             solicitante, beneficiario, sucursal, fecha e importe. Volver a pedirlos era
             hacer teclear lo que el sistema ya sabe, y habilitaba que la captura
             contradijera a Kepler. Se muestran de solo lectura y queda una sola tarea:
             adjuntar la evidencia. -->
        @if (desdeSolicitud(); as d) {
          <div class="cp-fromsol">
            <div class="cp-fromsol-h"><i class="pi pi-link" aria-hidden="true"></i> Solicitud {{ d.folio }} · ya en Kepler</div>
            <dl class="cp-fromsol-g">
              @if (d.solicitante) { <div><dt>Solicitante</dt><dd>{{ d.solicitante }}</dd></div> }
              @if (d.beneficiario) { <div><dt>Beneficiario</dt><dd>{{ d.beneficiario }}</dd></div> }
              @if (d.sucursal) { <div><dt>Sucursal</dt><dd>{{ d.sucursal }}</dd></div> }
              @if (d.fecha) { <div><dt>Fecha</dt><dd>{{ d.fecha }}</dd></div> }
              @if (d.importe) { <div><dt>Importe</dt><dd>{{ money(d.importe) }}</dd></div> }
              @if (d.concepto) { <div class="cp-fromsol-wide"><dt>Concepto</dt><dd>{{ d.concepto }}</dd></div> }
            </dl>
            <div class="cp-fromsol-acts">
              <button type="button" class="cp-fromsol-edit" (click)="desdeSolicitud.set(null)">
                ¿Algo no coincide? Editar a mano
              </button>
              @if (volverA()) {
                <button type="button" class="cp-fromsol-edit" (click)="volverAtras()">
                  <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a Solicitudes
                </button>
              }
            </div>
          </div>
        } @else {
        <label class="cp-f"><span>Solicitud de gasto (Kepler XA1501) *</span>
          <p-autocomplete [(ngModel)]="solicitudSel" [suggestions]="solicitudSug()" (completeMethod)="searchSolicitud($event)"
            field="label" [forceSelection]="false" [minQueryLength]="2" placeholder="Busca por folio o proveedor…" appendTo="body"
            styleClass="w-full" (onSelect)="onSolicitudSelect($event)" [delay]="250" />
          <small class="cp-hint">Elige la solicitud para auto-rellenar proveedor, fecha e importe.</small></label>

        <div class="cp-row">
          <label class="cp-f"><span>Nombre del solicitante *</span>
            <input pInputText [(ngModel)]="form.solicitante" /></label>
          <label class="cp-f"><span>Folio de la solicitud (últimos 4) *</span>
            <input pInputText [(ngModel)]="form.folio_solicitud" maxlength="12" placeholder="0000" /></label>
        </div>
        <label class="cp-f"><span>Departamento *</span>
          <p-select [options]="departamentos()" [(ngModel)]="form.departamento_code" optionLabel="nombre" optionValue="code" [filter]="true" placeholder="Selecciona departamento" appendTo="body" styleClass="w-full" (onChange)="onDeptoChange()" /></label>
        @if (sucursalDerivada()) { <div class="cp-suc"><i class="pi pi-map-marker"></i> Sucursal: <strong>{{ sucursalDerivada() }}</strong></div> }
        <div class="cp-row">
          <label class="cp-f"><span>Nombre proveedor *</span>
            <input pInputText [(ngModel)]="form.proveedor" /></label>
          <label class="cp-f"><span>Fecha del gasto *</span>
            <p-datepicker [(ngModel)]="fechaGasto" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" styleClass="w-full" /></label>
        </div>
        <label class="cp-f"><span>Importe</span>
          <p-inputnumber [(ngModel)]="form.importe" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
        }

        <div class="cp-files-head">Comprobantes</div>
        @for (slot of fileSlots; track slot.role) {
          <div class="cp-f cp-file">
            <span>{{ slot.label }} @if (slot.required) { <b class="cp-req">*</b> }</span>
            <p-fileupload mode="basic" [auto]="true" [customUpload]="true" [accept]="slot.accept"
                          [maxFileSize]="10485760" chooseIcon="pi pi-paperclip" chooseLabel="Elegir archivo"
                          chooseStyleClass="p-button-sm p-button-outlined"
                          (onSelect)="onFilePicked($event, slot.role)" />
            @if (fileNames()[slot.role]) { <span class="cp-filepick"><i class="pi pi-paperclip"></i> {{ fileNames()[slot.role] }}</span> }
            @if (vision()[slot.role]; as v) {
              @if (v === 'cargando') {
                <span class="cp-vision is-load"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo con Claude Vision…</span>
              } @else {
                <span class="cp-vision" [class.is-ok]="visionTone(v) === 'ok'" [class.is-warn]="visionTone(v) === 'warn'">
                  <i class="pi" [ngClass]="visionTone(v) === 'ok' ? 'pi-check-circle' : 'pi-exclamation-triangle'" aria-hidden="true"></i>
                  {{ visionMsg(v) }}
                </span>
              }
            }
          </div>
        }

        <label class="cp-f"><span>Comentarios</span>
          <textarea pTextarea [(ngModel)]="form.comentarios" rows="2"></textarea></label>
        @if (formError()) { <div class="cp-err">{{ formError() }}</div> }
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showForm.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" [loading]="saving()" (click)="submit()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Enviar solicitud</span></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [(visible)]="showReject" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar solicitud">
      <div class="cp-form">
        <p class="muted">Folio <strong>{{ rejectTarget()?.folio_solicitud }}</strong> · {{ rejectTarget()?.proveedor }}</p>
        <label class="cp-f"><span>Motivo del rechazo *</span>
          <textarea pTextarea [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. comprobante ilegible, no corresponde al folio…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    /* Veredicto de Claude Vision junto al archivo: se ve ANTES de enviar, no despues.
       Icono + texto; el color solo refuerza. */
    .cp-vision { display: inline-flex; align-items: flex-start; gap: .35rem; margin-top: .25rem;
      font-size: var(--fs-micro); line-height: 1.45; color: var(--text-muted); }
    .cp-vision.is-ok { color: var(--ok-fg); }
    .cp-vision.is-warn { color: var(--warn-fg); }
    .cp-vision.is-load { color: var(--text-faint); }
    .cp-vision i { margin-top: .15rem; }
    /* Resumen de la solicitud ya subida a Kepler: read-only, para que la unica tarea
       visible sea adjuntar. Hairline sin sombra (superficie in-page). */
    .cp-fromsol { border: 1px solid var(--border-color); border-left: 3px solid var(--ok-fg);
      border-radius: var(--r-md); padding: .6rem .8rem; display: flex; flex-direction: column; gap: .45rem; }
    .cp-fromsol-h { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .cp-fromsol-h i { color: var(--ok-fg); }
    .cp-fromsol-g { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .4rem .9rem; margin: 0; }
    .cp-fromsol-g > div { display: flex; flex-direction: column; gap: .05rem; min-width: 0; }
    .cp-fromsol-wide { grid-column: 1 / -1; }
    .cp-fromsol-g dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
    .cp-fromsol-g dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .cp-fromsol-edit { align-self: flex-start; background: none; border: 0; padding: 0; font: inherit;
      font-size: var(--fs-micro); color: var(--action); text-decoration: underline; cursor: pointer; }
    .cp-fromsol-edit:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    /* Mismos indicadores que la pantalla de comprobación de gastos: alcance recortado
       (el usuario ve solo sus áreas) y conexión en vivo. */
    .cg-scope { display: inline-flex; align-items: center; gap: .35rem; margin-top: .35rem; font-size: .74rem; color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn-fg) 25%, transparent); border-radius: var(--r-sm); padding: .15rem .5rem; }
    .cg-live { display: inline-flex; align-items: center; gap: .35rem; margin-top: .35rem; margin-left: .5rem; font-size: .72rem; color: var(--ok-fg); }
    .cg-live i { font-size: .55rem; }
    :host { display: block; }
    .cp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .cp-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .cp-field { display: flex; flex-direction: column; gap: .3rem; }
    .cp-field > label { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cp-field.cp-grow { flex: 1 1 18rem; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .cp-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cp-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .cp-table .strong { font-weight: 600; color: var(--text-main); }
    .cp-table .muted { color: var(--text-muted); }
    .cp-suc-cell { font-size: .7rem; color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-size: .85em; }
    .cp-files { display: inline-flex; gap: .35rem; flex-wrap: wrap; }
    .cp-fchip { min-width: max(1.75rem, var(--tap-min)); min-height: max(1.75rem, var(--tap-min)); padding: 0; }

    /* ── Visor de quien revisa (side-peek) ───────────────────────────────
       Elevación por borde, cero sombra: el drawer ya es el overlay. */
    .cpk-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3);
      border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-md); }
    .cpk-verdict.ok { border-left-color: var(--ok-fg); }
    /* "No cuadra" es atención, no error: warn. */
    .cpk-verdict.warn { border-left-color: var(--warn-fg); }
    .cpk-verdict > i { font-size: var(--fs-h3); }
    .cpk-verdict.ok > i { color: var(--ok-fg); }
    .cpk-verdict.warn > i { color: var(--warn-fg); }
    .cpk-verdict h3 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cpk-verdict p { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45; }

    .cpk-tri { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); margin-top: var(--sp-3); }
    .cpk-tri > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cpk-k { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em; color: var(--fg-3); }
    .cpk-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-h3);
      font-weight: var(--fw-bold); color: var(--fg-1); }
    .cpk-m { font-size: var(--fs-xs); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .cpk-note { display: flex; gap: var(--sp-2); margin: var(--sp-3) 0 0; font-size: var(--fs-sm); color: var(--warn-fg); line-height: 1.4; }
    .cpk-note.is-bad { color: var(--bad-fg); }
    .cpk-sec { margin: var(--sp-5) 0 var(--sp-2); font-size: var(--fs-micro); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); font-weight: var(--fw-medium); }

    .cpk-doc { margin: 0 0 var(--sp-4); }
    .cpk-doc figcaption { font-size: var(--fs-xs); color: var(--fg-2); margin-bottom: var(--sp-1); }
    .cpk-img { display: block; width: 100%; height: auto; max-height: 60vh; object-fit: contain;
      background: var(--layout-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .cpk-frame { display: block; width: 100%; height: 55vh; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--layout-bg); }
    .cpk-open { display: inline-flex; align-items: center; gap: var(--sp-1); margin-top: var(--sp-1);
      font-size: var(--fs-xs); color: var(--action); text-decoration: none; }
    .cpk-open:hover { text-decoration: underline; }
    .cpk-broken { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3);
      font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45;
      border: 1px dashed var(--border-color); border-radius: var(--r-sm); }
    .cpk-broken i { color: var(--warn-fg); }
    .cpk-sk { height: 12rem; border-radius: var(--r-sm); background: var(--hover-bg); animation: cpk-pulse 1.4s ease-in-out infinite; }
    @keyframes cpk-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .cpk-sk { animation: none; } }

    .cpk-dl { display: grid; grid-template-columns: 9rem 1fr; gap: var(--sp-1) var(--sp-3); margin: 0; }
    .cpk-dl dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .cpk-dl dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .cpk-acts { display: flex; gap: var(--sp-2); margin-top: var(--sp-5);
      padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .cp-motivo { font-size: .72rem; color: var(--bad-fg); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-vision { color: var(--action); margin-left: .35rem; font-size: .75rem; }
    .cp-empty { text-align: center; color: var(--text-muted); padding: 2rem; }
    .cp-form { display: flex; flex-direction: column; gap: .8rem; padding: .25rem 0; }
    .cp-row { display: flex; gap: .8rem; }
    .cp-row .cp-f { flex: 1 1 0; }
    .cp-f { display: flex; flex-direction: column; gap: .3rem; }
    .cp-f > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cp-req { color: var(--bad-fg); }
    .cp-hint { font-size: .72rem; color: var(--text-muted); }
    .cp-f input[type=file] { font-size: .82rem; }
    .cp-files-head { font-size: .8rem; font-weight: 600; color: var(--text-main); margin-top: .4rem; border-top: 1px solid var(--border-color); padding-top: .7rem; }
    .cp-file { gap: .2rem; }
    .cp-suc { font-size: .82rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; margin-top: -.35rem; }
    .cp-suc strong { color: var(--text-main); }
    .cp-fromsol-acts { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
    .cp-filepick { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cp-err { color: var(--bad-fg); font-size: .82rem; }
    .w-full { width: 100%; }
  `],
})
export class FinanzasComprobacionesComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComprobacionesService);
  private readonly comercial = inject(ComercialService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  private readonly socket = inject(ExpenseProofsSocketService);
  readonly liveConnected = this.socket.connected;
  /** Datos de la solicitud de Kepler cuando se llega desde la lista: si están, el
   *  formulario se reduce a adjuntar la evidencia. `null` = captura manual completa. */
  readonly desdeSolicitud = signal<{
    folio: string; solicitante: string | null; beneficiario: string | null;
    sucursal: string | null; fecha: string | null; importe: number | null; concepto: string | null;
  } | null>(null);
  /** Dinero CON centavos (formateador compartido). Esta pantalla compara el importe de la
   *  solicitud contra lo que lee el OCR del comprobante: redondear a pesos escondía justo
   *  la diferencia que el cuadre está mirando. */
  readonly money = money;
  /** Sin este permiso la bandeja viene recortada a las áreas del usuario: hay que decirlo. */
  readonly verAll = computed(() => this.perms.can('manage', 'all')
    || this.auth.user()?.permissions?.[Permission.FINANCE_EXPENSES_VER_ALL] === true);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Lo que el formulario pide. Ya NO pide la solicitud de Kepler: existe en el ERP
   * (XA1501) y la leemos por folio — fotografiar un documento que el sistema ya tiene
   * es papeleo. Queda solo lo que la plataforma no puede sacar sola: el comprobante.
   */
  readonly fileSlots: FileSlot[] = [
    { role: 'comprobante_1', label: 'Comprobante físico — Hoja 1', required: true, accept: '.pdf,image/*' },
    { role: 'comprobante_2', label: 'Comprobante físico — Hoja 2', required: false, accept: '.pdf,image/*' },
    { role: 'evidencia_1', label: 'Evidencia fotográfica 1', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_2', label: 'Evidencia fotográfica 2', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_3', label: 'Evidencia fotográfica 3', required: false, accept: 'image/*,.pdf' },
  ];
  /** Roles retirados del formulario que siguen existiendo en registros viejos: sin
   *  esto sus adjuntos se listaban con el nombre crudo del rol. */
  private readonly legacyFileLabels: Record<string, string> = { solicitud_kepler: 'Solicitud de gasto Kepler ERP (histórico)' };

  readonly report = signal<ExpenseProofsReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly validatingId = signal<string | null>(null);
  readonly statusSel = signal<string>('');
  readonly departamentos = signal<Departamento[]>([]);
  readonly sucursalDerivada = signal<string>('');
  /** Ruta a la que se regresa al terminar, si esta pantalla se abrió como desvío. */
  readonly volverA = signal<string | null>(null);
  volverAtras() { const b = this.volverA(); this.volverA.set(null); this.showForm.set(false); if (b) this.router.navigate([b]); }

  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_FINDINGS_GESTIONAR] === true);

  // ── Visor de quien revisa ────────────────────────────────────────────────
  private readonly sanitizer = inject(DomSanitizer);
  readonly dmy = dmy;
  readonly peekOpen = signal(false);
  readonly peek = signal<ExpenseProofDetail | null>(null);
  readonly peekDocs = signal<PeekDoc[]>([]);
  readonly peekLoading = signal(false);

  peekSub(): string {
    const p = this.peek();
    return p ? `${p.folio_solicitud} · ${p.proveedor || 's/proveedor'} · ${this.statusLabel(p.status)}` : '';
  }

  /**
   * Abre el detalle y pide las URLs de nuevo.
   *
   * NO se pintan los adjuntos que trajo la lista: esos se firmaron con TTL de 10 min al
   * cargar la bandeja y para cuando alguien abre la fila suelen estar vencidos. Se espera
   * la firma fresca; si la llamada falla, se cae a lo de la lista (mejor eso que nada) y
   * el manejo de error del <img> explica qué pasó.
   */
  openPeek(r: ExpenseProof) {
    this.peek.set(r as ExpenseProofDetail);
    this.peekDocs.set([]);
    this.peekOpen.set(true);
    this.peekLoading.set(true);
    this.svc.detail(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.peek.set(d); this.buildDocs(d.files || []); this.peekLoading.set(false); },
      error: () => { this.buildDocs(r.files || []); this.peekLoading.set(false); },
    });
  }

  onPeekToggle(v: boolean) {
    this.peekOpen.set(v);
    if (!v) { this.peekDocs.set([]); this.peek.set(null); } // suelta los iframes
  }

  private buildDocs(files: ProofFile[]) {
    this.peekDocs.set((files || []).filter((f) => f?.url).map((f) => {
      const isPdf = f.kind === 'pdf' || /\.pdf(\?|$)/i.test(f.url);
      return {
        role: String(f.role), label: this.fileLabel(String(f.role)), url: f.url, isPdf,
        safeUrl: isPdf ? this.sanitizer.bypassSecurityTrustResourceUrl(f.url) : null,
        failed: false,
      };
    }));
  }

  onDocError(url: string) {
    this.peekDocs.update((ds) => ds.map((d) => d.url === url ? { ...d, failed: true } : d));
  }

  /** El cuadre, dicho en llano. El backend ya lo calcula; la bandeja lo tiraba. */
  cuadreTitulo(p: ExpenseProofDetail): string {
    if (p.monto_match === true) return 'El comprobante cuadra';
    if (p.monto_ocr == null) return 'Sin lectura automática';
    return `Difiere ${money(Math.abs((p.importe || 0) - p.monto_ocr))}`;
  }
  cuadreLectura(p: ExpenseProofDetail): string {
    const sol = money(p.importe || 0);
    if (p.monto_match === true) return `Claude Vision leyó ${money(p.monto_ocr ?? 0)} en el comprobante y la solicitud ${p.folio_solicitud} pide ${sol}.`;
    if (p.monto_ocr == null) return `No hay lectura automática del comprobante. Revisalo a ojo contra los ${sol} de la solicitud ${p.folio_solicitud}.`;
    return `La solicitud ${p.folio_solicitud} pide ${sol} y el comprobante dice ${money(p.monto_ocr)}. Revisá la foto antes de validar.`;
  }
  diffTxt(p: ExpenseProofDetail): string {
    return p.monto_ocr == null ? '—' : money(Math.abs((p.importe || 0) - p.monto_ocr));
  }

  readonly statusOpts = [{ label: 'Todas', value: '' }, { label: 'Recibidas', value: 'recibida' }, { label: 'En revisión', value: 'revision' }, { label: 'Validadas', value: 'validada' }, { label: 'Rechazadas', value: 'rechazada' }];
  search = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  // form
  readonly showForm = signal(false);
  readonly fileNames = signal<Record<string, string>>({});
  readonly formError = signal<string>('');
  private readonly solicitudQuery = signal<string | null>(null);
  private readonly solicitudRes = rxResource({
    params: () => { const q = this.solicitudQuery(); return q && q.length >= 2 ? q : undefined; },
    stream: ({ params }) => this.comercial.expenseRequests({ search: params }).pipe(
      map((r) => (r.rows || [])
        .filter((row) => row.estado !== 'C')
        .slice(0, 20)
        .map((row) => ({ ...row, label: `${row.folio} · ${row.beneficiario || '—'} · ${this.money(row.importe)}${row.aplicada ? ' · aplicada' : ''}` }))),
    ),
  });
  readonly solicitudSug = computed<SolicitudSug[]>(() => this.solicitudRes.value() ?? []);
  solicitudSel: SolicitudSug | string | null = null;
  fechaGasto: Date | null = null;
  form: CreateExpenseProof = {};
  private fileData: Record<string, string> = {}; // role → data URI (pendiente de subir)
  private uploaded: Record<string, ProofFile> = {}; // role → ya subido OK (sobrevive fallos parciales)

  // reject
  readonly showReject = signal(false);
  readonly rejectTarget = signal<ExpenseProof | null>(null);
  rejectMotivo = '';

  constructor() {
    this.svc.departamentos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((d) => this.departamentos.set(d));
    const qp = this.route.snapshot.queryParamMap;
    if (qp.get('open') === '1') {
      const folio = qp.get('folio_solicitud') || '';
      const num = (v: string | null) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
      this.form = {
        folio_solicitud: folio || undefined,
        proveedor: qp.get('proveedor') || undefined,
        solicitante: qp.get('solicitante') || undefined,
        sucursal: qp.get('sucursal') || undefined,
        importe: num(qp.get('importe')),
        fecha_gasto: qp.get('fecha') || undefined,
        comentarios: qp.get('concepto') || undefined,
      };
      if (this.form.fecha_gasto) this.fechaGasto = new Date(this.form.fecha_gasto + 'T00:00:00');
      // Con folio hay solicitud real: se colapsa el formulario a "adjuntar evidencia".
      if (folio) {
        this.desdeSolicitud.set({
          folio, solicitante: this.form.solicitante || null, beneficiario: this.form.proveedor || null,
          sucursal: this.form.sucursal || null, fecha: this.form.fecha_gasto || null,
          importe: this.form.importe ?? null, concepto: qp.get('concepto'),
        });
      }
      // Llegar acá desde /finanzas/solicitudes es un DESVÍO, no un destino: al terminar
      // se vuelve a la lista donde estaba trabajando, no se lo deja en "Reembolsos".
      if (folio) this.volverA.set('/finanzas/solicitudes');
      this.openNew(false);
    }
    this.load();
    // Realtime: el capturista sube y el autorizador se entera sin refrescar. Es la misma
    // necesidad que ya resolvía la comprobación de gastos; esta mitad del ciclo se había
    // quedado sin el aviso y la bandeja envejecía en pantalla.
    this.socket.connect();
    this.socket.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.action === 'captured') {
        this.toast.add({ severity: 'info', summary: 'Nueva solicitud',
          detail: `Folio ${e.folio_solicitud}${e.solicitante ? ' · ' + e.solicitante : ''}` });
      }
      this.load();
    });
    this.destroyRef.onDestroy(() => this.socket.disconnect());
  }

  kpiItems(r: ExpenseProofsReport): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Recibidas', value: r.kpis.recibidas, tone: 'warn' },
      { label: 'Validadas', value: r.kpis.validadas, tone: 'ok' },
      { label: 'Rechazadas', value: r.kpis.rechazadas, tone: 'bad' },
    ];
    if (r.kpis.en_revision) items.splice(2, 0, { label: 'En revisión', value: r.kpis.en_revision, tone: 'warn' });
    return items;
  }

  setStatus(v: string) { this.statusSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.error.set(null);
    this.svc.list({ status: this.statusSel() || undefined, search: this.search || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar las comprobaciones.'); this.loading.set(false); },
      });
  }

  // (A) Autocomplete de solicitud Kepler (XA1501); excluye canceladas.
  searchSolicitud(ev: { query: string }) {
    this.solicitudQuery.set((ev.query || '').trim());
  }

  // (B) Auto-relleno desde la solicitud elegida.
  onSolicitudSelect(ev: { value: SolicitudSug } | SolicitudSug) {
    const s = (ev as { value: SolicitudSug }).value ?? (ev as SolicitudSug);
    if (!s || typeof s === 'string') return;
    this.form.folio_solicitud = s.folio;
    this.form.proveedor = s.beneficiario || this.form.proveedor || '';
    if (s.importe) this.form.importe = s.importe;
    if (s.fecha) this.fechaGasto = new Date(s.fecha + 'T00:00:00');
    if (!this.form.solicitante && s.solicitante) this.form.solicitante = s.solicitante;
  }

  openNew(reset = true) {
    if (reset) { this.desdeSolicitud.set(null); this.vision.set({}); this.form = { solicitante: this.auth.user()?.username || '' }; this.fechaGasto = null; this.fileData = {}; this.uploaded = {}; this.fileNames.set({}); this.solicitudSel = null; }
    else if (!this.form.solicitante) { this.form.solicitante = this.auth.user()?.username || ''; }
    this.sucursalDerivada.set('');
    this.formError.set('');
    this.showForm.set(true);
  }

  onDeptoChange() {
    const dep = this.departamentos().find((d) => d.code === this.form.departamento_code);
    this.sucursalDerivada.set(dep?.sucursal || '');
  }

  /** `p-fileupload` (modo básico) entrega el archivo en el evento. `currentFiles` es
   *  `File[]` tipado; `files` viene como `FileList | File[]` y no vale la pena destapar. */
  onFilePicked(ev: { currentFiles?: File[] } | null, role: string) {
    const file = ev?.currentFiles?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri; // data URI (backend detecta PDF vs imagen)
      delete this.uploaded[role]; // archivo nuevo → re-subir
      this.fileNames.update((m) => ({ ...m, [role]: file.name }));
      this.leerConVision(role, dataUri);
    };
    reader.readAsDataURL(file);
  }

  /**
   * Lectura del comprobante con Claude Vision, al adjuntarlo.
   *
   * El backend ya leía con Vision al guardar, pero el formulario nunca llamaba al preview:
   * el capturista enviaba a ciegas y se enteraba después de que "quedó en revisión". Peor,
   * como tampoco mandaba `monto_ocr`, si Vision no podía correr en el servidor el respaldo
   * quedaba vacío y TODO caía en revisión.
   *
   * Ahora se lee al adjuntar, se muestra el veredicto antes de enviar, y el resultado viaja
   * en el alta. Solo aplica al comprobante: la solicitud y las evidencias no se cuadran.
   */
  readonly vision = signal<Record<string, ProofPhotoOcr | 'cargando' | null>>({});

  /** Importe contra el que se cuadra: el de la solicitud de Kepler manda. */
  private importeEsperado(): number {
    return Number(this.desdeSolicitud()?.importe ?? this.form.importe ?? 0) || 0;
  }

  private leerConVision(role: string, dataUri: string): void {
    if (!role.startsWith('comprobante')) return;
    const importe = this.importeEsperado();
    if (!importe) return;  // sin importe esperado no hay nada que cuadrar
    this.vision.update((m) => ({ ...m, [role]: 'cargando' }));
    this.svc.validatePhoto(dataUri, importe).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.vision.update((m) => ({ ...m, [role]: r })),
      // Que falle la lectura no impide capturar: el backend la reintenta al guardar.
      error: () => this.vision.update((m) => ({ ...m, [role]: null })),
    });
  }

  /** Texto del veredicto de Vision, en llano. */
  visionMsg(v: ProofPhotoOcr): string {
    if (v.ocr_status === 'sin_key') return 'Claude Vision no está configurado en el servidor — se validará a mano.';
    if (v.ocr_status === 'ilegible') return 'Claude Vision no pudo leer el importe en la foto — se validará a mano.';
    const leido = this.money(v.monto_ocr ?? v.total ?? v.subtotal);
    if (v.monto_match) return `Claude Vision leyó ${leido} y cuadra con la solicitud (${this.money(v.importe_esperado)}).`;
    return `Claude Vision leyó ${leido} y la solicitud dice ${this.money(v.importe_esperado)}` +
      `${v.diff != null ? ` — difieren ${this.money(Math.abs(v.diff))}` : ''}. Entra en revisión.`;
  }
  visionTone(v: ProofPhotoOcr): 'ok' | 'warn' {
    return v.ocr_status === 'ok' && v.monto_match ? 'ok' : 'warn';
  }

  private fmtDate(d?: Date | null): string | undefined {
    return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
  }

  submit() {
    const f = this.form;
    const dep = this.departamentos().find((d) => d.code === f.departamento_code);
    if (dep) { f.departamento = dep.nombre; f.sucursal = dep.sucursal || undefined; }
    // Viniendo de una solicitud ya cargada en Kepler, la cabecera la deriva el backend
    // (solicitante, proveedor, sucursal). Acá solo se exige el folio y la evidencia; pedir
    // departamento sería volver a reclamar lo que el sistema ya sabe.
    const desde = this.desdeSolicitud();
    if (desde) {
      if (!f.folio_solicitud?.trim()) { this.formError.set('Falta el folio de la solicitud.'); return; }
    } else if (!f.solicitante?.trim() || !f.departamento_code || !f.folio_solicitud?.trim() || !f.proveedor?.trim()) {
      this.formError.set('Completa los campos obligatorios (*).'); return;
    }
    for (const slot of this.fileSlots) {
      if (slot.required && !this.fileData[slot.role] && !this.uploaded[slot.role]) { this.formError.set(`Falta: ${slot.label}.`); return; }
    }
    this.formError.set('');
    this.saving.set(true);

    // Sube SOLO lo que aún no subió; cada archivo con su propio catch → un fallo NO tira los demás.
    // Los que suben OK quedan en `uploaded` y no se re-suben: reintentás solo los que faltaron.
    const present = this.fileSlots.map((s) => s.role).filter((r) => this.fileData[r] || this.uploaded[r]);
    const toUpload = present.filter((r) => !this.uploaded[r]);
    if (!toUpload.length) { this.createRequest(present); return; }

    const ups = toUpload.map((r) => this.svc.uploadFile(this.fileData[r], r).pipe(
      map((file) => ({ role: r, file: file as ProofFile | null })),
      catchError(() => of({ role: r, file: null as ProofFile | null })),
    ));
    forkJoin(ups).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((results) => {
      const failed: string[] = [];
      for (const res of results) {
        if (res.file) { this.uploaded[res.role] = res.file; delete this.fileData[res.role]; }
        else failed.push(res.role);
      }
      if (failed.length) {
        this.saving.set(false);
        const labels = failed.map((r) => this.fileLabel(r)).join(', ');
        const okN = results.length - failed.length;
        this.formError.set(`No se pudieron subir: ${labels}.${okN ? ` (${okN} sí quedaron guardados.)` : ''} Reintentá solo esos y volvé a Enviar.`);
        return;
      }
      this.createRequest(present);
    });
  }

  /** Crea la solicitud con los archivos ya subidos OK (todos los slots presentes). */
  private createRequest(present: string[]) {
    const files = present.map((r) => this.uploaded[r]).filter(Boolean) as ProofFile[];
    // Se manda lo que Claude Vision ya leyó en el navegador. El servidor vuelve a leer por
    // su cuenta (es la lectura autoritativa), pero si allá no puede —sin clave, archivo no
    // recuperable— esto evita que la captura caiga en revisión por falta de dato.
    const v = this.vision()['comprobante_1'] ?? this.vision()['comprobante_2'];
    const ocr = v && v !== 'cargando' ? v : null;
    this.svc.create({
      ...this.form, fecha_gasto: this.fmtDate(this.fechaGasto), files,
      monto_ocr: ocr ? ocr.monto_ocr ?? ocr.total : undefined,
      subtotal_ocr: ocr ? ocr.subtotal : undefined,
      receipt_legible: ocr ? ocr.ocr_status === 'ok' : undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false); this.uploaded = {}; this.showForm.set(false);
          const folio = this.form.folio_solicitud;
          this.toast.add({ severity: 'success', summary: 'Evidencia adjuntada', detail: `Solicitud ${folio}` });
          const back = this.volverA();
          if (back) { this.volverA.set(null); this.router.navigate([back]); return; }
          this.load();
        },
        error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar la solicitud.'); },
      });
  }

  doValidate(r: ExpenseProof) {
    if (this.validatingId()) return; // anti doble-clic
    this.validatingId.set(r.id);
    this.svc.validate(r.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.validatingId.set(null); this.onPeekToggle(false); this.toast.add({ severity: 'success', summary: 'Validada', detail: `Folio ${r.folio_solicitud}` }); this.load(); },
        error: () => { this.validatingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(r: ExpenseProof) { this.rejectTarget.set(r); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const r = this.rejectTarget();
    if (!r) return;
    this.saving.set(true);
    this.svc.reject(r.id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.showReject.set(false); this.onPeekToggle(false); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: `Folio ${r.folio_solicitud}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  fileLabel(role: string): string { return this.fileSlots.find((s) => s.role === role)?.label || this.legacyFileLabels[role] || role; }
  statusLabel(s: string): string { return ({ recibida: 'Recibida', revision: 'En revisión', validada: 'Validada', rechazada: 'Rechazada' } as Record<string, string>)[s] || s; }
  statusSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'warn', revision: 'warn', validada: 'success', rechazada: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s] || 'secondary'; }
}
