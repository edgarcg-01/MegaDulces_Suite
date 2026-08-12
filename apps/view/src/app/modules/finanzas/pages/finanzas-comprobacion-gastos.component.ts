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
import { ComprobacionGastosService, CreateComprobacion, Departamento, GastoSug, GastoRow, GastosReport, ProofFile, ComprobacionFileRole, KeplerGastosOcr } from '../comprobacion-gastos.service';

interface FileSlot { role: ComprobacionFileRole; label: string; required: boolean; accept: string; }

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

    <!-- Diálogo: nueva comprobación -->
    <p-dialog [(visible)]="showForm" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" header="Nueva comprobación de gasto">
      <div class="cp-form">
        <!-- 1) Subir la comprobación de gastos (documento de Kepler XA1001) — el OCR auto-rellena todo -->
        <div class="cp-f">
          <span>Comprobación de gastos (documento de Kepler) *</span>
          @if (!fileNames()['comprobacion']) {
            <div class="cp-drop" [class.drag]="dragging()" (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDropComprobacion($event)">
              <i class="pi pi-file-pdf cp-drop-ico" aria-hidden="true"></i>
              <div class="cp-drop-main">Arrastrá el <strong>documento "Gastos"</strong> (PDF o foto)</div>
              <div class="cp-drop-or">o</div>
              <label class="cp-pickbtn"><i class="pi pi-upload" aria-hidden="true"></i> Elegir archivo
                <input type="file" accept="application/pdf,image/*" (change)="onFile($event, 'comprobacion')" hidden />
              </label>
              <div class="cp-drop-hint">Lo leo y auto-relleno folio, proveedor, importe, departamento y fecha.</div>
            </div>
          } @else {
            <div class="cp-file-done">
              <i class="pi pi-check-circle cp-ok" aria-hidden="true"></i> <span class="cp-file-nm">{{ fileNames()['comprobacion'] }}</span>
              @if (ocrLoading()) { <span class="cp-proc"><i class="pi pi-spin pi-spinner"></i> leyendo…</span> }
              <button type="button" class="cp-linkbtn" (click)="clearComprobacion()">cambiar</button>
            </div>
          }
        </div>

        <div class="cp-files-head">Datos del gasto <em class="cp-hint">revisá y completá lo que falte</em></div>
        <div class="cp-row">
          <label class="cp-f"><span>Nombre del solicitante *</span>
            <input pInputText [(ngModel)]="form.solicitante" /></label>
          <label class="cp-f"><span>Folio del gasto (4 díg.) *</span>
            <input pInputText [(ngModel)]="form.folio_gasto" maxlength="12" placeholder="0000" /></label>
        </div>
        <label class="cp-f"><span>Departamento *</span>
          <p-select [options]="departamentos()" [(ngModel)]="form.departamento_code" optionLabel="nombre" optionValue="code" [filter]="true" placeholder="Selecciona departamento" appendTo="body" styleClass="w-full" (onChange)="onDeptoChange()" /></label>
        @if (sucursalDerivada()) { <div class="cp-suc"><i class="pi pi-map-marker"></i> Sucursal: <strong>{{ sucursalDerivada() }}</strong></div> }
        <div class="cp-row">
          <label class="cp-f"><span>Nombre proveedor *</span>
            <input pInputText [(ngModel)]="form.proveedor" /></label>
          <label class="cp-f"><span>Fecha de la comprobación</span>
            <p-datepicker [(ngModel)]="fechaComprobacion" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" styleClass="w-full" /></label>
        </div>
        <div class="cp-row">
          <label class="cp-f"><span>Folio de la comprobación (últimos 4)</span>
            <input pInputText [(ngModel)]="form.folio_comprobacion" maxlength="12" placeholder="0000" /></label>
          <label class="cp-f"><span>Importe</span>
            <p-inputnumber [(ngModel)]="form.importe" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>
        </div>

        @if (readGasto(); as o) {
          <details class="cp-read" open>
            <summary>Más datos leídos del documento Kepler</summary>
            <div class="cp-read-grid">
              @if (o.sucursal) { <div><em>Sucursal</em> {{ o.sucursal }}</div> }
              @if (o.moneda) { <div><em>Moneda</em> {{ o.moneda }}</div> }
              @if (o.fecha_pago) { <div><em>Fecha de pago</em> {{ o.fecha_pago }}</div> }
              @if (o.autoriza) { <div><em>Autoriza</em> {{ o.autoriza }}</div> }
              @if (o.cuenta) { <div><em>Cuenta</em> {{ o.cuenta }}</div> }
              @if (o.concepto) { <div><em>Concepto</em> {{ o.concepto }}</div> }
              @if (o.proyecto) { <div><em>Proyecto</em> {{ o.proyecto }}</div> }
              @if (o.poliza) { <div><em>Póliza</em> {{ o.poliza }}</div> }
              @if (o.a_nombre_de) { <div class="cp-read-wide"><em>A nombre de</em> {{ o.a_nombre_de }}</div> }
              @if (o.descripcion) { <div class="cp-read-wide"><em>Descripción</em> {{ o.descripcion }}</div> }
              @if (o.subtotal != null) { <div><em>Subtotal</em> {{ money(o.subtotal) }}</div> }
              @if (o.iva != null) { <div><em>IVA</em> {{ money(o.iva) }}</div> }
              @if (o.ieps != null && o.ieps > 0) { <div><em>IEPS</em> {{ money(o.ieps) }}</div> }
              @if (o.anticipos != null && o.anticipos > 0) { <div><em>Anticipos</em> {{ money(o.anticipos) }}</div> }
            </div>
          </details>
        }

        <div class="cp-files-head">Foto(s) del gasto <em class="cp-hint">evidencia — opcional</em></div>
        @for (slot of evidenciaSlots; track slot.role) {
          <label class="cp-f cp-file">
            <span>{{ slot.label }}</span>
            <input type="file" [accept]="slot.accept" (change)="onFile($event, slot.role)" />
            @if (fileNames()[slot.role]) { <span class="cp-filepick"><i class="pi pi-paperclip"></i> {{ fileNames()[slot.role] }}</span> }
          </label>
        }

        <label class="cp-f"><span>Comentarios</span>
          <textarea pInputText [(ngModel)]="form.comentarios" rows="2"></textarea></label>
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
  // OCR del documento "Gastos" de Kepler → auto-rellena el form.
  readonly ocrLoading = signal(false);
  readonly readGasto = signal<KeplerGastosOcr | null>(null); // datos completos leídos (panel read-only)

  readonly fileSlots: FileSlot[] = [
    { role: 'comprobacion', label: 'Comprobación de gasto', required: true, accept: 'application/pdf,image/*' },
    { role: 'evidencia_1', label: 'Foto 1', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_2', label: 'Foto 2', required: false, accept: 'image/*,.pdf' },
  ];
  // Las fotos de evidencia (todo menos la comprobación, que sube arriba con OCR).
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

  readonly statusOpts = [{ label: 'Pendientes', value: 'pendiente' }, { label: 'Comprobadas', value: 'comprobada' }, { label: 'Validadas', value: 'validada' }, { label: 'Todos', value: '' }];
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
    this.form.folio_gasto = g.folio_gasto;
    this.form.proveedor = g.proveedor || this.form.proveedor || '';
    if (g.importe) this.form.importe = g.importe;
    if (g.sucursal && !this.form.sucursal) this.form.sucursal = g.sucursal;
  }

  openNew() {
    this.form = { solicitante: this.auth.user()?.username || '' };
    this.fechaComprobacion = new Date();
    this.fileData = {}; this.uploaded = {}; this.fileNames.set({}); this.gastoSel = null;
    this.sucursalDerivada.set('');
    this.readGasto.set(null);
    this.formError.set('');
    this.showForm.set(true);
  }

  /** Abre el form pre-rellenado con el gasto de la fila (folio/proveedor/importe/sucursal). */
  openComprobar(g: GastoRow) {
    this.openNew();
    this.form.folio_gasto = g.folio_gasto;
    this.form.proveedor = g.proveedor || '';
    if (g.importe) this.form.importe = g.importe;
    if (g.sucursal) this.form.sucursal = g.sucursal;
  }

  onDeptoChange() {
    const dep = this.departamentos().find((d) => d.code === this.form.departamento_code);
    this.sucursalDerivada.set(dep?.sucursal || '');
  }

  onFile(ev: Event, role: string) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.handleFile(file, role);
  }

  // Arrastrar la comprobación (doc Kepler) → OCR auto-rellena.
  readonly dragging = signal(false);
  onDragOver(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); if (!this.dragging()) this.dragging.set(true); }
  onDragLeave(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false); }
  onDropComprobacion(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false);
    const file = ev.dataTransfer?.files?.[0];
    if (file) this.handleFile(file, 'comprobacion');
  }
  clearComprobacion() {
    delete this.fileData['comprobacion']; delete this.uploaded['comprobacion'];
    this.fileNames.update((m) => { const n = { ...m }; delete n['comprobacion']; return n; });
    this.readGasto.set(null);
  }

  private handleFile(file: File, role: string) {
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri;
      delete this.uploaded[role];
      this.fileNames.update((m) => ({ ...m, [role]: file.name }));
      // OCR-primero: al subir el documento "Gastos" de Kepler, auto-rellena el form.
      if (role === 'comprobacion') this.runGastoOcr(dataUri);
      this.cdr.markForCheck();
    };
    reader.readAsDataURL(file);
  }

  /** Lee el documento "Gastos" de Kepler (XA1001) y auto-rellena la captura. */
  private runGastoOcr(dataUri: string) {
    this.ocrLoading.set(true);
    this.svc.ocr(dataUri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => {
        this.ocrLoading.set(false);
        if (o.ocr_status === 'sin_key') { this.toast.add({ severity: 'info', summary: 'OCR no disponible', detail: 'Captura los datos a mano.' }); return; }
        if (o.ocr_status === 'ilegible') { this.toast.add({ severity: 'warn', summary: 'No se pudo leer', detail: 'Captura los datos a mano.' }); return; }
        this.applyGastoOcr(o);
        this.readGasto.set(o);
        this.cdr.markForCheck();
      },
      error: () => { this.ocrLoading.set(false); },
    });
  }

  private applyGastoOcr(o: KeplerGastosOcr) {
    const f = this.form;
    if (o.folio) f.folio_gasto = o.folio;
    if (o.solicitante) f.solicitante = o.solicitante;
    if (o.proveedor) f.proveedor = o.proveedor; else if (o.proveedor_code) f.proveedor = o.proveedor_code;
    if (o.importe != null) f.importe = o.importe;
    if (!f.comentarios && (o.comentarios || o.descripcion)) f.comentarios = o.comentarios || o.descripcion || '';
    if (o.fecha) { const d = this.parseIso(o.fecha); if (d) this.fechaComprobacion = d; }
    // Departamento: casa el código con el catálogo (tolerante a espacios).
    if (o.departamento) {
      const norm = (s: string) => s.replace(/\s/g, '');
      const dep = this.departamentos().find((x) => x.code === o.departamento || norm(x.code) === norm(o.departamento!));
      if (dep) { f.departamento_code = dep.code; this.sucursalDerivada.set(dep.sucursal || ''); }
    }
    // Auto-match el gasto Kepler por folio (completa proveedor/importe/sucursal si faltan).
    if (o.folio) this.autoMatchGasto(o.folio);
    this.toast.add({ severity: 'success', summary: 'Datos leídos del gasto Kepler', detail: `${o.folio || ''} · ${o.proveedor || o.proveedor_code || ''}`.trim() });
  }

  private parseIso(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }

  /** Confirma el gasto en el espejo Kepler por folio y completa lo que falte. */
  private autoMatchGasto(folio: string) {
    this.svc.searchGastos(folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        const g = (rows || []).find((r) => r.folio_gasto === folio) || (rows || [])[0];
        if (!g) return;
        this.form.folio_gasto = g.folio_gasto;
        if (g.proveedor && !this.form.proveedor) this.form.proveedor = g.proveedor;
        if (g.importe && !this.form.importe) this.form.importe = g.importe;
        if (g.sucursal && !this.form.sucursal) this.form.sucursal = g.sucursal;
        this.cdr.markForCheck();
      },
      error: () => { /* el OCR ya rellenó lo básico */ },
    });
  }

  private fmtDate(d?: Date | null): string | undefined {
    return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
  }

  submit() {
    const f = this.form;
    const dep = this.departamentos().find((d) => d.code === f.departamento_code);
    f.departamento = dep?.nombre || '';
    f.sucursal = dep?.sucursal || f.sucursal || undefined;
    if (!f.solicitante?.trim() || !f.departamento_code || !f.folio_gasto?.trim() || !f.proveedor?.trim()) {
      this.formError.set('Completa los campos obligatorios (*).'); return;
    }
    for (const slot of this.fileSlots) {
      if (slot.required && !this.fileData[slot.role] && !this.uploaded[slot.role]) { this.formError.set(`Falta: ${slot.label}.`); return; }
    }
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
    this.svc.create({ ...this.form, fecha_comprobacion: this.fmtDate(this.fechaComprobacion), files })
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
  statusLabel(s: string | null): string { return ({ recibida: 'Recibida', validada: 'Validada', rechazada: 'Rechazada' } as Record<string, string>)[s || ''] || (s || '—'); }
  statusSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'warn', validada: 'success', rechazada: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
