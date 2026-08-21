import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
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
import { PermissionsService } from '../../../core/services/permissions.service';
import { ExpenseProofsSocketService } from '../expense-proofs-socket.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ComercialService, ExpenseRequestRow } from '../../comercial/comercial.service';
import { ComprobacionesService, ExpenseProof, ExpenseProofsReport, CreateExpenseProof, Departamento, ProofFile, ProofFileRole } from '../comprobaciones.service';

interface FileSlot { role: ProofFileRole; label: string; required: boolean; accept: string; }
interface SolicitudSug extends ExpenseRequestRow { label: string; }

/**
 * GX.7 — "Solicitud de autorización de gastos" (reembolso). Captura ligada a la
 * solicitud de Kepler (XA1501): se elige la solicitud (autocomplete), se auto-
 * rellenan proveedor/fecha/importe/solicitante, y se adjuntan hasta 6 archivos
 * (comprobante h1/h2, solicitud Kepler, 3 evidencias). Flujo recibida→validada/
 * rechazada. No escribe a Kepler; se concilia por folio.
 */
@Component({
  selector: 'app-finanzas-comprobaciones',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, AutoCompleteModule, DatePickerModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, ContextHelpComponent, LoadStateComponent],
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
                    <a [href]="f.url" target="_blank" rel="noopener" class="cp-fchip" [title]="fileLabel(f.role)">
                      <i class="pi" [ngClass]="f.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'"></i>
                    </a>
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

    <!-- Diálogo: nueva solicitud de reembolso -->
    <p-dialog [(visible)]="showForm" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" header="Nueva solicitud de reembolso">
      <div class="cp-form">
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

        <div class="cp-files-head">Comprobantes</div>
        @for (slot of fileSlots; track slot.role) {
          <label class="cp-f cp-file">
            <span>{{ slot.label }} @if (slot.required) { <b class="cp-req">*</b> }</span>
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
        <button pButton type="button" [loading]="saving()" (click)="submit()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Enviar solicitud</span></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [(visible)]="showReject" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar solicitud">
      <div class="cp-form">
        <p class="muted">Folio <strong>{{ rejectTarget()?.folio_solicitud }}</strong> · {{ rejectTarget()?.proveedor }}</p>
        <label class="cp-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. comprobante ilegible, no corresponde al folio…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
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
    .cp-fchip { color: var(--action); font-size: 1rem; }
    .cp-fchip:hover { opacity: .75; }
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
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  private readonly socket = inject(ExpenseProofsSocketService);
  readonly liveConnected = this.socket.connected;
  /** Sin este permiso la bandeja viene recortada a las áreas del usuario: hay que decirlo. */
  readonly verAll = computed(() => this.perms.can('manage', 'all')
    || this.auth.user()?.permissions?.[Permission.FINANCE_EXPENSES_VER_ALL] === true);
  private readonly destroyRef = inject(DestroyRef);

  readonly fileSlots: FileSlot[] = [
    { role: 'comprobante_1', label: 'Comprobante físico — Hoja 1', required: true, accept: '.pdf,image/*' },
    { role: 'comprobante_2', label: 'Comprobante físico — Hoja 2', required: false, accept: '.pdf,image/*' },
    { role: 'solicitud_kepler', label: 'Solicitud de gasto Kepler ERP', required: true, accept: '.pdf,image/*' },
    { role: 'evidencia_1', label: 'Evidencia fotográfica 1', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_2', label: 'Evidencia fotográfica 2', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_3', label: 'Evidencia fotográfica 3', required: false, accept: 'image/*,.pdf' },
  ];

  readonly report = signal<ExpenseProofsReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly validatingId = signal<string | null>(null);
  readonly statusSel = signal<string>('');
  readonly departamentos = signal<Departamento[]>([]);
  readonly sucursalDerivada = signal<string>('');
  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_FINDINGS_GESTIONAR] === true);

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
      this.form = { folio_solicitud: qp.get('folio_solicitud') || undefined, proveedor: qp.get('proveedor') || undefined };
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
    if (reset) { this.form = { solicitante: this.auth.user()?.username || '' }; this.fechaGasto = null; this.fileData = {}; this.uploaded = {}; this.fileNames.set({}); this.solicitudSel = null; }
    else if (!this.form.solicitante) { this.form.solicitante = this.auth.user()?.username || ''; }
    this.sucursalDerivada.set('');
    this.formError.set('');
    this.showForm.set(true);
  }

  onDeptoChange() {
    const dep = this.departamentos().find((d) => d.code === this.form.departamento_code);
    this.sucursalDerivada.set(dep?.sucursal || '');
  }

  onFile(ev: Event, role: string) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      this.fileData[role] = String(reader.result || ''); // data URI (backend detecta PDF vs imagen)
      delete this.uploaded[role]; // archivo nuevo → re-subir
      this.fileNames.update((m) => ({ ...m, [role]: file.name }));
    };
    reader.readAsDataURL(file);
  }

  private fmtDate(d?: Date | null): string | undefined {
    return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
  }

  submit() {
    const f = this.form;
    const dep = this.departamentos().find((d) => d.code === f.departamento_code);
    f.departamento = dep?.nombre || '';
    f.sucursal = dep?.sucursal || undefined;
    if (!f.solicitante?.trim() || !f.departamento_code || !f.folio_solicitud?.trim() || !f.proveedor?.trim()) {
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
    this.svc.create({ ...this.form, fecha_gasto: this.fmtDate(this.fechaGasto), files })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.saving.set(false); this.uploaded = {}; this.showForm.set(false); this.toast.add({ severity: 'success', summary: 'Solicitud enviada', detail: `Folio ${this.form.folio_solicitud}` }); this.load(); },
        error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar la solicitud.'); },
      });
  }

  doValidate(r: ExpenseProof) {
    if (this.validatingId()) return; // anti doble-clic
    this.validatingId.set(r.id);
    this.svc.validate(r.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.validatingId.set(null); this.toast.add({ severity: 'success', summary: 'Validada', detail: `Folio ${r.folio_solicitud}` }); this.load(); },
        error: () => { this.validatingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(r: ExpenseProof) { this.rejectTarget.set(r); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const r = this.rejectTarget();
    if (!r) return;
    this.saving.set(true);
    this.svc.reject(r.id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: `Folio ${r.folio_solicitud}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  fileLabel(role: string): string { return this.fileSlots.find((s) => s.role === role)?.label || role; }
  statusLabel(s: string): string { return ({ recibida: 'Recibida', revision: 'En revisión', validada: 'Validada', rechazada: 'Rechazada' } as Record<string, string>)[s] || s; }
  statusSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'warn', revision: 'warn', validada: 'success', rechazada: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
