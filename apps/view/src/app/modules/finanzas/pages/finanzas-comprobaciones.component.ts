import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
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
import { FINANZAS_TABS } from '../finanzas-tabs';
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
  imports: [CommonModule, FormsModule, TableModule, SelectModule, AutoCompleteModule, DatePickerModule, TagModule, InputTextModule, InputNumberModule, ButtonModule, DialogModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head cp-head">
        <div class="surf-page-head-text">
          <h1>Solicitudes de reembolso</h1>
          <p class="surf-page-sub">Adjunta los comprobantes de una solicitud de gasto (Kepler XA1501) · recibida → validada/rechazada</p>
        </div>
        <button pButton type="button" icon="pi pi-plus" label="Nueva solicitud" (click)="openNew()"></button>
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

      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm cp-table" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
                 [paginator]="rows().length > 100" [rows]="100" [loading]="loading()" sortField="created_at" [sortOrder]="-1">
          <ng-template pTemplate="header">
            <tr>
              <th pSortableColumn="created_at" style="width:6rem">Fecha <p-sortIcon field="created_at" /></th>
              <th pSortableColumn="folio_solicitud" style="width:7rem">Folio sol. <p-sortIcon field="folio_solicitud" /></th>
              <th>Solicitante</th>
              <th>Departamento</th>
              <th>Proveedor</th>
              <th class="ta-r" style="width:8rem">Importe</th>
              <th style="width:8rem">Adjuntos</th>
              <th style="width:7rem">Estado</th>
              <th style="width:11rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
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
                @if (r.status === 'rechazada' && r.motivo_rechazo) { <div class="cp-motivo" [title]="r.motivo_rechazo">{{ r.motivo_rechazo }}</div> }
              </td>
              <td>
                @if (canManage()) {
                  @if (r.status !== 'validada') { <button pButton type="button" size="small" text severity="success" icon="pi pi-check" label="Validar" (click)="doValidate(r)"></button> }
                  @if (r.status !== 'rechazada') { <button pButton type="button" size="small" text severity="danger" icon="pi pi-times" (click)="openReject(r)" title="Rechazar"></button> }
                } @else { <span class="muted">—</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="9" class="cp-empty">Sin solicitudes para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
    </div>

    <!-- Diálogo: nueva solicitud de reembolso -->
    <p-dialog [(visible)]="showForm" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" header="Nueva solicitud de reembolso">
      <div class="cp-form">
        <label class="cp-f"><span>Solicitud de gasto (Kepler XA1501) *</span>
          <p-autoComplete [(ngModel)]="solicitudSel" [suggestions]="solicitudSug()" (completeMethod)="searchSolicitud($event)"
            field="label" [forceSelection]="false" [minLength]="2" placeholder="Busca por folio o proveedor…" appendTo="body"
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
            <p-datePicker [(ngModel)]="fechaGasto" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" styleClass="w-full" /></label>
        </div>
        <label class="cp-f"><span>Importe</span>
          <p-inputNumber [(ngModel)]="form.importe" mode="currency" currency="MXN" locale="es-MX" styleClass="w-full" /></label>

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
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" text (click)="showForm.set(false)"></button>
        <button pButton type="button" label="Enviar solicitud" icon="pi pi-check" [loading]="saving()" (click)="submit()"></button>
      </ng-template>
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [(visible)]="showReject" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar solicitud">
      <div class="cp-form">
        <p class="muted">Folio <strong>{{ rejectTarget()?.folio_solicitud }}</strong> · {{ rejectTarget()?.proveedor }}</p>
        <label class="cp-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. comprobante ilegible, no corresponde al folio…"></textarea></label>
      </div>
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" text (click)="showReject.set(false)"></button>
        <button pButton type="button" label="Rechazar" icon="pi pi-times" severity="danger" [loading]="saving()" (click)="doReject()"></button>
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
    .cp-table .strong { font-weight: 600; color: var(--text-main); }
    .cp-table .muted { color: var(--text-muted); }
    .cp-suc-cell { font-size: .7rem; color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-size: .85em; }
    .cp-files { display: inline-flex; gap: .35rem; flex-wrap: wrap; }
    .cp-fchip { color: var(--action); font-size: 1rem; }
    .cp-fchip:hover { opacity: .75; }
    .cp-motivo { font-size: .72rem; color: var(--danger-fg, #b91c1c); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-empty { text-align: center; color: var(--text-muted); padding: 2rem; }
    .cp-form { display: flex; flex-direction: column; gap: .8rem; padding: .25rem 0; }
    .cp-row { display: flex; gap: .8rem; }
    .cp-row .cp-f { flex: 1 1 0; }
    .cp-f { display: flex; flex-direction: column; gap: .3rem; }
    .cp-f > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cp-req { color: var(--danger-fg, #b91c1c); }
    .cp-hint { font-size: .72rem; color: var(--text-muted); }
    .cp-f input[type=file] { font-size: .82rem; }
    .cp-files-head { font-size: .8rem; font-weight: 600; color: var(--text-main); margin-top: .4rem; border-top: 1px solid var(--border-color); padding-top: .7rem; }
    .cp-file { gap: .2rem; }
    .cp-suc { font-size: .82rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; margin-top: -.35rem; }
    .cp-suc strong { color: var(--text-main); }
    .cp-filepick { font-size: .78rem; color: var(--ok-fg, #15803d); display: inline-flex; align-items: center; gap: .3rem; }
    .cp-err { color: var(--danger-fg, #b91c1c); font-size: .82rem; }
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
  readonly saving = signal(false);
  readonly statusSel = signal<string>('');
  readonly departamentos = signal<Departamento[]>([]);
  readonly sucursalDerivada = signal<string>('');
  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_FINDINGS_GESTIONAR] === true);

  readonly statusOpts = [{ label: 'Todas', value: '' }, { label: 'Recibidas', value: 'recibida' }, { label: 'Validadas', value: 'validada' }, { label: 'Rechazadas', value: 'rechazada' }];
  search = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  // form
  readonly showForm = signal(false);
  readonly fileNames = signal<Record<string, string>>({});
  readonly formError = signal<string>('');
  readonly solicitudSug = signal<SolicitudSug[]>([]);
  solicitudSel: SolicitudSug | string | null = null;
  fechaGasto: Date | null = null;
  form: CreateExpenseProof = {};
  private fileData: Record<string, string> = {}; // role → data URI

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
  }

  kpiItems(r: ExpenseProofsReport): MetricStripItem[] {
    return [
      { label: 'Recibidas', value: r.kpis.recibidas, tone: 'warn' },
      { label: 'Validadas', value: r.kpis.validadas, tone: 'ok' },
      { label: 'Rechazadas', value: r.kpis.rechazadas, tone: 'bad' },
    ];
  }

  setStatus(v: string) { this.statusSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.svc.list({ status: this.statusSel() || undefined, search: this.search || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.report.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  // (A) Autocomplete de solicitud Kepler (XA1501); excluye canceladas.
  searchSolicitud(ev: { query: string }) {
    const q = (ev.query || '').trim();
    if (q.length < 2) { this.solicitudSug.set([]); return; }
    this.comercial.expenseRequests({ search: q }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => this.solicitudSug.set((r.rows || [])
        .filter((row) => row.estado !== 'C')
        .slice(0, 20)
        .map((row) => ({ ...row, label: `${row.folio} · ${row.beneficiario || '—'} · ${this.money(row.importe)}${row.aplicada ? ' · aplicada' : ''}` }))));
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
    if (reset) { this.form = { solicitante: this.auth.user()?.username || '' }; this.fechaGasto = null; this.fileData = {}; this.fileNames.set({}); this.solicitudSel = null; }
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
      if (slot.required && !this.fileData[slot.role]) { this.formError.set(`Falta: ${slot.label}.`); return; }
    }
    this.formError.set('');
    this.saving.set(true);

    // Subir cada archivo presente (uno por request), luego crear la solicitud.
    const roles = this.fileSlots.map((s) => s.role).filter((r) => this.fileData[r]);
    const uploads = roles.map((r) => this.svc.uploadFile(this.fileData[r], r));
    (uploads.length ? forkJoin(uploads) : of([] as ProofFile[]))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (files) => {
          this.svc.create({ ...f, fecha_gasto: this.fmtDate(this.fechaGasto), files })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => { this.saving.set(false); this.showForm.set(false); this.toast.add({ severity: 'success', summary: 'Solicitud enviada', detail: `Folio ${f.folio_solicitud}` }); this.load(); },
              error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar la solicitud.'); },
            });
        },
        error: () => { this.saving.set(false); this.formError.set('No se pudieron subir los archivos.'); },
      });
  }

  doValidate(r: ExpenseProof) {
    this.svc.validate(r.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.toast.add({ severity: 'success', summary: 'Validada', detail: `Folio ${r.folio_solicitud}` }); this.load(); }, error: () => this.toast.add({ severity: 'error', summary: 'Error al validar' }) });
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
  statusLabel(s: string): string { return ({ recibida: 'Recibida', validada: 'Validada', rechazada: 'Rechazada' } as Record<string, string>)[s] || s; }
  statusSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'warn', validada: 'success', rechazada: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
