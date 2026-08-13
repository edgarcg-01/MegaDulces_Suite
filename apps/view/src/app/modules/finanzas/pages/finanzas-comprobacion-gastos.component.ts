import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
import { ComprobacionGastosService, CreateComprobacion, Departamento, GastoSug, GastoRow, GastosReport, ProofFile, ComprobacionFileRole, ValidatePhotoResult } from '../comprobacion-gastos.service';

interface FileSlot { role: ComprobacionFileRole; label: string; required: boolean; accept: string; }
/** Gasto de Kepler seleccionado (read-only) — la fuente de verdad. */
interface SelGasto { folio_gasto: string; proveedor: string | null; importe: number; sucursal: string | null; area: string | null; fecha: string | null; solicitud_folio: string | null; }

/**
 * GX.8 — "Comprobación de Gastos" (2ª etapa del ciclo). Se elige el gasto de Kepler
 * (XA1001, autocomplete) que auto-rellena proveedor/importe, se captura el folio de
 * la comprobación y se adjunta el archivo comprobatorio. Flujo recibida→validada/
 * rechazada. No escribe a Kepler; se concilia por folio.
 */
@Component({
  selector: 'app-finanzas-comprobacion-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, AutoCompleteModule, DatePickerModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head cp-head">
        <div class="surf-page-head-text">
          <h1>Comprobación de gastos</h1>
          <p class="surf-page-sub">Los gastos ejercidos en Kepler (XA1001) y su comprobación adjunta · pendiente → recibida → validada/rechazada</p>
        </div>
        <button pButton type="button" (click)="openNew()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nueva comprobación</span></button>
      </header>

      <div class="cp-filters card-premium card-flat">
        <div class="cp-field"><label>Estado</label>
          <app-segmented [options]="statusOpts" [value]="statusSel()" (valueChange)="setStatus($event)" ariaLabel="Estado" /></div>
        <div class="cp-field cp-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Folio gasto, folio comprob., proveedor, solicitante…" (keyup.enter)="load()" (blur)="queue()" /></div>
      </div>

      @if (report(); as r) { <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen" /> }

      @if (error()) {
        <app-load-state [error]="error()" (retry)="load()"></app-load-state>
      } @else {
      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm cp-table" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
                 [paginator]="rows().length > 100" [rows]="100" [loading]="loading()">
          <ng-template #header>
            <tr>
              <th style="width:6rem">Fecha</th>
              <th style="width:7rem">Folio gasto</th>
              <th>Proveedor</th>
              <th style="width:9rem">Área</th>
              <th class="ta-r" style="width:9rem">Importe</th>
              <th style="width:14rem">Comprobación</th>
              <th style="width:11rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-g>
            <tr>
              <td>{{ g.fecha | date:'dd/MM/yy' }}</td>
              <td class="mono">{{ g.folio_gasto }}@if (g.solicitud_folio) { <div class="cp-suc-cell">sol {{ g.solicitud_folio }}</div> }</td>
              <td>{{ g.proveedor || '—' }}</td>
              <td class="muted">{{ g.area || '—' }}<div class="cp-suc-cell">{{ g.sucursal }}</div></td>
              <td class="ta-r strong">{{ money(g.importe) }}</td>
              <td>
                @if (g.comprobaciones > 0) {
                  <div class="cp-comp">
                    <p-tag [value]="statusLabel(g.comprobacion_status)" [severity]="statusSev(g.comprobacion_status)" />
                    <span class="cp-files">
                      @for (f of g.files; track f.url) {
                        <a [href]="f.url" target="_blank" rel="noopener" class="cp-fchip" [title]="fileLabel(f.role)"><i class="pi" [ngClass]="f.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'"></i></a>
                      }
                    </span>
                    @if (g.folio_comprobacion) { <span class="mono muted cp-folioc">#{{ g.folio_comprobacion }}</span> }
                    @if (g.comprobacion_status === 'revision' && g.revision_nota) { <span class="cp-motivo" [title]="g.revision_nota"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ g.revision_nota }}</span> }
                  </div>
                } @else { <span class="muted cp-pend"><i class="pi pi-clock" aria-hidden="true"></i> Pendiente</span> }
              </td>
              <td>
                @if (g.comprobaciones === 0) {
                  <button pButton type="button" size="small" text (click)="openComprobar(g)" title="Capturar la comprobación de este gasto"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">Comprobar</span></button>
                } @else {
                  <button pButton type="button" size="small" text (click)="openComprobar(g)" title="Agregar otra comprobación"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Otra</span></button>
                  @if (g.comprobacion_id && canManage()) {
                    @if (g.comprobacion_status !== 'validada') { <button pButton type="button" size="small" text severity="success" [loading]="validatingId() === g.comprobacion_id" [disabled]="!!validatingId()" (click)="doValidate(g)" title="Validar"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                    @if (g.comprobacion_status !== 'rechazada') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(g)" title="Rechazar"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button> }
                  }
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="7" class="cp-empty">Sin gastos para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
      }
    </div>

    <!-- Diálogo: comprobar gasto (datos de Kepler + foto validada por vision) -->
    <p-dialog [(visible)]="showForm" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" header="Comprobar gasto">
      <div class="cp-form">
        <!-- 1) El gasto YA está en Kepler: se muestra read-only (o se busca si es alta libre) -->
        @if (!selectedGasto()) {
          <label class="cp-f"><span>Buscar gasto de Kepler (folio · proveedor · importe)</span>
            <p-autocomplete [(ngModel)]="gastoSel" [suggestions]="gastoSug()" (completeMethod)="searchGasto($event)"
              (onSelect)="onGastoSelect($event)" optionLabel="label" [forceSelection]="false" [showClear]="true"
              placeholder="Ej. 6569, nombre del proveedor…" appendTo="body" styleClass="w-full" /></label>
        } @else {
          <div class="cp-gasto-card">
            <div class="cp-gc-head">
              <div>
                <div class="cp-gc-folio">Gasto <span class="mono">{{ selectedGasto()!.folio_gasto }}</span></div>
                <div class="cp-gc-prov">{{ selectedGasto()!.proveedor || '—' }}</div>
              </div>
              <div class="cp-gc-importe">{{ moneyFull(selectedGasto()!.importe) }}</div>
            </div>
            <div class="cp-gc-meta">
              @if (selectedGasto()!.sucursal) { <span><i class="pi pi-map-marker"></i> {{ selectedGasto()!.sucursal }}</span> }
              @if (selectedGasto()!.area) { <span><i class="pi pi-sitemap"></i> {{ selectedGasto()!.area }}</span> }
              @if (selectedGasto()!.fecha) { <span><i class="pi pi-calendar"></i> {{ selectedGasto()!.fecha | date:'dd/MM/yy' }}</span> }
              @if (selectedGasto()!.solicitud_folio) { <span class="muted">sol {{ selectedGasto()!.solicitud_folio }}</span> }
            </div>
            <button type="button" class="cp-linkbtn cp-gc-change" (click)="changeGasto()">cambiar gasto</button>
          </div>
        }

        <!-- 2) Adjuntar la foto del comprobante → Claude Vision valida el monto contra Kepler -->
        @if (selectedGasto()) {
        <div class="cp-files-head">Foto del comprobante * <em class="cp-hint">Claude Vision valida el monto contra Kepler</em></div>
        @if (!fileNames()['comprobacion']) {
          <div class="cp-drop" [class.drag]="dragging()" (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDropPhoto($event)">
            <i class="pi pi-camera cp-drop-ico" aria-hidden="true"></i>
            <div class="cp-drop-main">Arrastrá la <strong>foto/evidencia del gasto</strong> (ticket, recibo o PDF)</div>
            <div class="cp-drop-or">o</div>
            <label class="cp-pickbtn"><i class="pi pi-upload" aria-hidden="true"></i> Elegir archivo
              <input type="file" accept="image/*,application/pdf" (change)="onFile($event, 'comprobacion')" hidden />
            </label>
            <div class="cp-drop-hint">La leo y comparo su monto con el gasto de Kepler. Si no cuadra, queda en revisión.</div>
          </div>
        } @else {
          <div class="cp-file-done">
            <i class="pi pi-check-circle cp-ok" aria-hidden="true"></i> <span class="cp-file-nm">{{ fileNames()['comprobacion'] }}</span>
            @if (photoLoading()) { <span class="cp-proc"><i class="pi pi-spin pi-spinner"></i> leyendo…</span> }
            <button type="button" class="cp-linkbtn" (click)="clearPhoto()">cambiar</button>
          </div>
          @if (photoResult(); as pr) {
            @if (pr.ocr_status === 'ok' && pr.monto_match) {
              <div class="cp-val ok"><i class="pi pi-check-circle" aria-hidden="true"></i> Cuadra: foto <strong>{{ money(pr.monto_ocr) }}</strong> ≈ gasto {{ money(form.importe) }}. Quedará <strong>validada</strong>.</div>
            } @else if (pr.ocr_status === 'ok') {
              <div class="cp-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No cuadra: foto <strong>{{ money(pr.total ?? pr.monto_ocr) }}</strong> vs gasto {{ money(form.importe) }}. Quedará <strong>en revisión</strong>.</div>
            } @else if (pr.ocr_status === 'sin_key') {
              <div class="cp-val warn"><i class="pi pi-info-circle" aria-hidden="true"></i> Lectura automática no disponible — quedará <strong>en revisión</strong>.</div>
            } @else {
              <div class="cp-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No pude leer la foto — quedará <strong>en revisión</strong>.</div>
            }
          }
        }

        <div class="cp-files-head">Fotos adicionales <em class="cp-hint">opcional</em></div>
        @for (slot of evidenciaSlots; track slot.role) {
          <label class="cp-f cp-file">
            <span>{{ slot.label }}</span>
            <input type="file" [accept]="slot.accept" (change)="onFile($event, slot.role)" />
            @if (fileNames()[slot.role]) { <span class="cp-filepick"><i class="pi pi-paperclip"></i> {{ fileNames()[slot.role] }}</span> }
          </label>
        }

        <label class="cp-f"><span>Comentarios</span>
          <textarea pInputText [(ngModel)]="form.comentarios" rows="2"></textarea></label>
        }
        @if (formError()) { <div class="cp-err">{{ formError() }}</div> }
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showForm.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" [loading]="saving()" (click)="submit()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Enviar comprobación</span></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [(visible)]="showReject" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar comprobación">
      <div class="cp-form">
        <p class="muted">Gasto <strong>{{ rejectTarget()?.folio_gasto }}</strong> · {{ rejectTarget()?.proveedor }}</p>
        <label class="cp-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. comprobante ilegible, no corresponde al gasto…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
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
    .cp-fchip { color: var(--action); font-size: 1rem; }
    .cp-fchip:hover { opacity: .75; }
    .cp-comp { display: inline-flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
    .cp-pend { display: inline-flex; align-items: center; gap: .3rem; }
    .cp-pend i { font-size: .75rem; opacity: .7; }
    .cp-folioc { font-size: .72rem; }
    .cp-motivo { font-size: .72rem; color: var(--bad-fg); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-empty { text-align: center; color: var(--text-muted); padding: 2rem; }
    .cp-form { display: flex; flex-direction: column; gap: .8rem; padding: .25rem 0; }
    .cp-row { display: flex; gap: .8rem; }
    .cp-row .cp-f { flex: 1 1 0; }
    .cp-f { display: flex; flex-direction: column; gap: .3rem; }
    .cp-f > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cp-req { color: var(--bad-fg); }
    .cp-hint { font-size: .72rem; color: var(--text-muted); }
    /* OCR-primero: dropzone del documento Kepler */
    .cp-drop { display: flex; flex-direction: column; align-items: center; gap: .45rem; padding: 1.3rem 1rem; border: 2px dashed var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); text-align: center; transition: border-color .15s, background .15s; }
    .cp-drop.drag { border-color: var(--action); background: var(--action-soft-bg, rgba(0,0,0,.03)); }
    .cp-drop-ico { font-size: 1.9rem; color: var(--bad-fg); }
    .cp-drop-main { font-size: .88rem; color: var(--text-main); }
    .cp-drop-or { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
    .cp-drop-hint { font-size: .74rem; color: var(--text-muted); }
    .cp-pickbtn { display: inline-flex; align-items: center; gap: .4rem; padding: .5rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); font-size: .85rem; color: var(--text-main); cursor: pointer; background: var(--card-bg); }
    .cp-pickbtn:hover { border-color: var(--action); color: var(--action); }
    .cp-file-done { display: flex; align-items: center; gap: .5rem; font-size: .84rem; color: var(--text-main); padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .cp-file-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-ok { color: var(--ok-fg); }
    .cp-linkbtn { margin-left: auto; border: none; background: transparent; color: var(--action); cursor: pointer; font: inherit; text-decoration: underline; padding: 0; }
    .cp-proc { font-size: .8rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; }
    /* Tarjeta read-only del gasto de Kepler */
    .cp-gasto-card { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .8rem .9rem; background: var(--surface-sunken, var(--card-bg)); display: flex; flex-direction: column; gap: .5rem; position: relative; }
    .cp-gc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .cp-gc-folio { font-size: .82rem; color: var(--text-muted); }
    .cp-gc-folio .mono { font-family: var(--font-mono); color: var(--text-main); font-size: .9em; }
    .cp-gc-prov { font-size: 1rem; font-weight: 600; color: var(--text-main); margin-top: .15rem; }
    .cp-gc-importe { font-size: 1.25rem; font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cp-gc-meta { display: flex; flex-wrap: wrap; gap: .3rem .9rem; font-size: .8rem; color: var(--text-muted); }
    .cp-gc-meta span { display: inline-flex; align-items: center; gap: .3rem; }
    .cp-gc-meta i { font-size: .8rem; opacity: .8; }
    .cp-gc-change { align-self: flex-start; }
    /* Resultado de la validación por vision de la foto */
    .cp-val { display: flex; align-items: flex-start; gap: .5rem; font-size: .82rem; padding: .55rem .7rem; border-radius: var(--r-md, .5rem); border: 1px solid var(--border-color); margin-top: .1rem; }
    .cp-val i { margin-top: .1rem; }
    .cp-val.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 8%, transparent); border-color: color-mix(in srgb, var(--ok-fg) 30%, transparent); }
    .cp-val.warn { color: var(--warn-fg, var(--bad-fg)); background: color-mix(in srgb, var(--warn-fg, var(--bad-fg)) 8%, transparent); border-color: color-mix(in srgb, var(--warn-fg, var(--bad-fg)) 30%, transparent); }
    /* datos extra leídos (read-only) */
    .cp-read { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .5rem .75rem; background: var(--surface-sunken, var(--card-bg)); }
    .cp-read > summary { font-size: .8rem; font-weight: 600; color: var(--text-main); cursor: pointer; }
    .cp-read-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: .3rem .9rem; margin-top: .5rem; font-size: .8rem; color: var(--text-main); }
    .cp-read-grid > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-read-grid em { font-style: normal; color: var(--text-muted); margin-right: .3rem; }
    .cp-read-wide { grid-column: 1 / -1; white-space: normal !important; }
    .cp-f input[type=file] { font-size: .82rem; }
    .cp-files-head { font-size: .8rem; font-weight: 600; color: var(--text-main); margin-top: .4rem; border-top: 1px solid var(--border-color); padding-top: .7rem; }
    .cp-file { gap: .2rem; }
    .cp-suc { font-size: .82rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; margin-top: -.35rem; }
    .cp-suc strong { color: var(--text-main); }
    .cp-filepick { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cp-err { color: var(--bad-fg); font-size: .82rem; }
    .w-full { width: 100%; }
  `],
})
export class FinanzasComprobacionGastosComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComprobacionGastosService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  // Claude Vision lee la FOTO del gasto y valida el monto contra el importe Kepler.
  readonly photoLoading = signal(false);
  readonly photoResult = signal<ValidatePhotoResult | null>(null);
  // Gasto de Kepler seleccionado (read-only) — todo se deriva de él.
  readonly selectedGasto = signal<SelGasto | null>(null);

  readonly fileSlots: FileSlot[] = [
    { role: 'comprobacion', label: 'Foto del gasto', required: true, accept: 'image/*,application/pdf' },
    { role: 'evidencia_1', label: 'Foto adicional 1', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_2', label: 'Foto adicional 2', required: false, accept: 'image/*,.pdf' },
  ];
  // Las fotos adicionales (todo menos la foto principal, que valida vision arriba).
  readonly evidenciaSlots = this.fileSlots.filter((s) => s.role !== 'comprobacion');

  readonly report = signal<GastosReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly validatingId = signal<string | null>(null);
  readonly statusSel = signal<string>('pendiente');
  readonly departamentos = signal<Departamento[]>([]);
  readonly sucursalDerivada = signal<string>('');
  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_FINDINGS_GESTIONAR] === true);

  readonly statusOpts = [{ label: 'Pendientes', value: 'pendiente' }, { label: 'Comprobadas', value: 'comprobada' }, { label: 'En revisión', value: 'revision' }, { label: 'Validadas', value: 'validada' }, { label: 'Todos', value: '' }];
  search = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  // form
  readonly showForm = signal(false);
  readonly fileNames = signal<Record<string, string>>({});
  readonly formError = signal<string>('');
  private readonly gastoQuery = signal<string | null>(null);
  private readonly gastoRes = rxResource({
    params: () => { const q = this.gastoQuery(); return q && q.length >= 2 ? q : undefined; },
    stream: ({ params }) => this.svc.searchGastos(params as string).pipe(
      map((rows) => (rows || []).map((row) => ({ ...row, label: `${row.folio_gasto} · ${row.proveedor || '—'} · ${this.money(row.importe)}${row.solicitud_folio ? ' · sol ' + row.solicitud_folio : ''}` }))),
    ),
  });
  readonly gastoSug = computed<(GastoSug & { label: string })[]>(() => this.gastoRes.value() ?? []);
  gastoSel: (GastoSug & { label: string }) | string | null = null;
  fechaComprobacion: Date | null = null;
  form: CreateComprobacion = {};
  private fileData: Record<string, string> = {};
  private uploaded: Record<string, ProofFile> = {};

  // reject
  readonly showReject = signal(false);
  readonly rejectTarget = signal<GastoRow | null>(null);
  rejectMotivo = '';

  constructor() {
    this.svc.departamentos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((d) => this.departamentos.set(d));
    this.load();
  }

  kpiItems(r: GastosReport): MetricStripItem[] {
    return [
      { label: 'Gastos', value: r.kpis.gastos },
      { label: 'Comprobados', value: r.kpis.comprobados, tone: 'ok' },
      { label: 'Validados', value: r.kpis.validados, tone: 'ok' },
      { label: 'En revisión', value: r.kpis.en_revision || 0, tone: 'warn' },
      { label: '$ por comprobar', value: Number(r.kpis.monto_pendiente) || 0, format: 'currency-short', tone: 'warn' },
    ];
  }

  setStatus(v: string) { this.statusSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.error.set(null);
    this.svc.listGastos({ estado: this.statusSel() || undefined, search: this.search || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar los gastos.'); this.loading.set(false); },
      });
  }

  searchGasto(ev: { query: string }) { this.gastoQuery.set((ev.query || '').trim()); }

  onGastoSelect(ev: { value: GastoSug & { label: string } } | (GastoSug & { label: string })) {
    const g = (ev as { value: GastoSug & { label: string } }).value ?? (ev as GastoSug & { label: string });
    if (!g || typeof g === 'string') return;
    this.setGasto({ folio_gasto: g.folio_gasto, proveedor: g.proveedor, importe: Number(g.importe) || 0, sucursal: g.sucursal, area: g.area, fecha: g.fecha, solicitud_folio: g.solicitud_folio });
  }

  /** Fija el gasto de Kepler (fuente de verdad) y prepara la validación de la foto. */
  private setGasto(g: SelGasto) {
    this.selectedGasto.set(g);
    this.form.folio_gasto = g.folio_gasto;
    this.form.sucursal = g.sucursal || undefined;
    this.form.importe = g.importe;
    this.gastoSel = null;
    this.revalidatePhoto();
  }

  /** Vuelve a elegir otro gasto (limpia la foto ya cargada). */
  changeGasto() {
    this.selectedGasto.set(null);
    this.clearPhoto();
    this.form.folio_gasto = '';
    this.form.importe = 0;
    this.gastoSel = null;
  }

  openNew() {
    this.form = { solicitante: this.auth.user()?.username || '' };
    this.fechaComprobacion = new Date();
    this.fileData = {}; this.uploaded = {}; this.fileNames.set({}); this.gastoSel = null;
    this.selectedGasto.set(null);
    this.photoResult.set(null);
    this.formError.set('');
    this.showForm.set(true);
  }

  /** Abre el diálogo con el gasto de la fila ya seleccionado (read-only) + foto. */
  openComprobar(g: GastoRow) {
    this.openNew();
    this.setGasto({ folio_gasto: g.folio_gasto, proveedor: g.proveedor, importe: Number(g.importe) || 0, sucursal: g.sucursal, area: g.area, fecha: g.fecha, solicitud_folio: g.solicitud_folio });
  }

  onFile(ev: Event, role: string) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.handleFile(file, role);
  }

  // Arrastrar la foto/evidencia del gasto → Claude Vision valida el monto.
  readonly dragging = signal(false);
  onDragOver(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); if (!this.dragging()) this.dragging.set(true); }
  onDragLeave(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false); }
  onDropPhoto(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false);
    const file = ev.dataTransfer?.files?.[0];
    if (file) this.handleFile(file, 'comprobacion');
  }
  clearPhoto() {
    delete this.fileData['comprobacion']; delete this.uploaded['comprobacion'];
    this.fileNames.update((m) => { const n = { ...m }; delete n['comprobacion']; return n; });
    this.photoResult.set(null);
  }

  /** Al elegir un gasto de Kepler por folio (blur del input), jala proveedor/importe/sucursal. */
  onFolioBlur() {
    const folio = (this.form.folio_gasto || '').trim();
    if (!folio) return;
    this.svc.searchGastos(folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        const g = (rows || []).find((r) => r.folio_gasto === folio) || (rows || [])[0];
        if (!g) return;
        this.form.folio_gasto = g.folio_gasto;
        if (g.proveedor) this.form.proveedor = g.proveedor;
        if (g.importe) this.form.importe = g.importe;
        if (g.sucursal && !this.form.sucursal) this.form.sucursal = g.sucursal;
        this.revalidatePhoto();
        this.cdr.markForCheck();
      },
      error: () => { /* no-op */ },
    });
  }

  /** Si el importe cambia y ya hay foto leída, recalcula el cuadre (preview). */
  onImporteChange() { this.revalidatePhoto(); }

  private handleFile(file: File, role: string) {
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri;
      delete this.uploaded[role];
      this.fileNames.update((m) => ({ ...m, [role]: file.name }));
      // La foto principal del gasto → Claude Vision valida el monto contra Kepler.
      if (role === 'comprobacion') this.runPhotoValidation(dataUri);
      this.cdr.markForCheck();
    };
    reader.readAsDataURL(file);
  }

  /** Lee la foto/evidencia del gasto con Claude Vision y la valida contra el importe Kepler. */
  private runPhotoValidation(dataUri: string) {
    this.photoLoading.set(true);
    this.photoResult.set(null);
    this.svc.validatePhoto(dataUri, Number(this.form.importe) || 0).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.photoLoading.set(false);
        this.photoResult.set(r);
        if (r.ocr_status === 'ok' && r.monto_match) this.toast.add({ severity: 'success', summary: 'Monto cuadra', detail: `Foto ${this.money(r.monto_ocr)} ≈ gasto ${this.money(this.form.importe)}` });
        else if (r.ocr_status === 'ok') this.toast.add({ severity: 'warn', summary: 'Monto no cuadra', detail: 'Quedará en revisión.' });
        this.cdr.markForCheck();
      },
      error: () => { this.photoLoading.set(false); },
    });
  }

  /** Reejecuta la validación de la foto ya cargada (cambió el importe/gasto). */
  private revalidatePhoto() {
    const dataUri = this.fileData['comprobacion'];
    if (dataUri && !this.photoLoading()) this.runPhotoValidation(dataUri);
  }

  private fmtDate(d?: Date | null): string | undefined {
    return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
  }

  submit() {
    if (!this.selectedGasto()) { this.formError.set('Elegí el gasto de Kepler.'); return; }
    for (const slot of this.fileSlots) {
      if (slot.required && !this.fileData[slot.role] && !this.uploaded[slot.role]) { this.formError.set('Adjuntá la foto del comprobante.'); return; }
    }
    if (this.photoLoading()) { this.formError.set('Espera a que termine de leerse la foto…'); return; }
    this.formError.set('');
    this.saving.set(true);

    const present = this.fileSlots.map((s) => s.role).filter((r) => this.fileData[r] || this.uploaded[r]);
    const toUpload = present.filter((r) => !this.uploaded[r]);
    if (!toUpload.length) { this.createComprobacion(present); return; }

    const ups = toUpload.map((r) => this.svc.uploadFile(this.fileData[r], r as ComprobacionFileRole).pipe(
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
      this.createComprobacion(present);
    });
  }

  private createComprobacion(present: string[]) {
    const files = present.map((r) => this.uploaded[r]).filter(Boolean) as ProofFile[];
    const pr = this.photoResult();
    const g = this.selectedGasto();
    // El backend deriva proveedor/importe/sucursal/área/solicitante del gasto Kepler.
    this.svc.create({
      folio_gasto: g?.folio_gasto,
      sucursal: g?.sucursal || undefined,
      comentarios: this.form.comentarios,
      files,
      // Validación por vision de la foto (el backend decide validada vs revisión):
      monto_ocr: pr?.total ?? null,
      subtotal_ocr: pr?.subtotal ?? null,
      receipt_legible: pr ? (pr.ocr_status === 'ok' && pr.legible) : false,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.saving.set(false); this.uploaded = {}; this.showForm.set(false); this.toast.add({ severity: 'success', summary: 'Comprobación enviada', detail: `Gasto ${this.form.folio_gasto}` }); this.load(); },
        error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar la comprobación.'); },
      });
  }

  doValidate(g: GastoRow) {
    if (!g.comprobacion_id || this.validatingId()) return;
    this.validatingId.set(g.comprobacion_id);
    this.svc.validate(g.comprobacion_id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.validatingId.set(null); this.toast.add({ severity: 'success', summary: 'Validada', detail: `Gasto ${g.folio_gasto}` }); this.load(); },
        error: () => { this.validatingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(g: GastoRow) { this.rejectTarget.set(g); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const g = this.rejectTarget();
    if (!g?.comprobacion_id) return;
    this.saving.set(true);
    this.svc.reject(g.comprobacion_id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: `Gasto ${g.folio_gasto}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  fileLabel(role: string): string { return this.fileSlots.find((s) => s.role === role)?.label || role; }
  statusLabel(s: string | null): string { return ({ recibida: 'Recibida', validada: 'Validada', rechazada: 'Rechazada', revision: 'En revisión' } as Record<string, string>)[s || ''] || (s || '—'); }
  statusSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'secondary', validada: 'success', rechazada: 'danger', revision: 'warn' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[s || ''] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  moneyFull(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
}
