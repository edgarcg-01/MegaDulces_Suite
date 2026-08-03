import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
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
import { ComprobacionGastosService, Comprobacion, ComprobacionesReport, CreateComprobacion, Departamento, GastoSug, ProofFile, ComprobacionFileRole } from '../comprobacion-gastos.service';

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
          <p class="surf-page-sub">Comprueba un gasto ya ejercido (Kepler XA1001) adjuntando su comprobación · recibida → validada/rechazada</p>
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
                 [paginator]="rows().length > 100" [rows]="100" [loading]="loading()" sortField="created_at" [sortOrder]="-1">
          <ng-template #header>
            <tr>
              <th pSortableColumn="created_at" style="width:6rem">Fecha <p-sorticon field="created_at" /></th>
              <th pSortableColumn="folio_gasto" style="width:7rem">Folio gasto <p-sorticon field="folio_gasto" /></th>
              <th style="width:7rem">Folio comp.</th>
              <th>Solicitante</th>
              <th>Departamento</th>
              <th>Proveedor</th>
              <th class="ta-r" style="width:8rem">Importe</th>
              <th style="width:6rem">Adjunto</th>
              <th style="width:7rem">Estado</th>
              <th style="width:11rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td>{{ r.created_at | date:'dd/MM/yy' }}</td>
              <td class="mono">{{ r.folio_gasto }}</td>
              <td class="mono muted">{{ r.folio_comprobacion || '—' }}</td>
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
                  @if (r.status !== 'validada') { <button pButton type="button" size="small" text severity="success" [loading]="validatingId() === r.id" [disabled]="!!validatingId()" (click)="doValidate(r)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Validar</span></button> }
                  @if (r.status !== 'rechazada') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(r)" title="Rechazar"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span></button> }
                } @else { <span class="muted">—</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="10" class="cp-empty">Sin comprobaciones para el filtro.</td></tr></ng-template>
        </p-table>
      </div>
      }
    </div>

    <!-- Diálogo: nueva comprobación -->
    <p-dialog [(visible)]="showForm" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" header="Nueva comprobación de gasto">
      <div class="cp-form">
        <label class="cp-f"><span>Gasto (Kepler XA1001) *</span>
          <p-autocomplete [(ngModel)]="gastoSel" [suggestions]="gastoSug()" (completeMethod)="searchGasto($event)"
            field="label" [forceSelection]="false" [minQueryLength]="2" placeholder="Busca por folio o proveedor…" appendTo="body"
            styleClass="w-full" (onSelect)="onGastoSelect($event)" [delay]="250" />
          <small class="cp-hint">Elige el gasto para auto-rellenar proveedor e importe. También puedes teclear el folio abajo.</small></label>

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

        <div class="cp-files-head">Comprobación</div>
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
    .cp-motivo { font-size: .72rem; color: var(--bad-fg); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
export class FinanzasComprobacionGastosComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComprobacionGastosService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly fileSlots: FileSlot[] = [
    { role: 'comprobacion', label: 'Comprobación de gasto', required: true, accept: '.pdf,image/*' },
    { role: 'evidencia_1', label: 'Evidencia adicional 1', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_2', label: 'Evidencia adicional 2', required: false, accept: 'image/*,.pdf' },
  ];

  readonly report = signal<ComprobacionesReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly validatingId = signal<string | null>(null);
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
  readonly rejectTarget = signal<Comprobacion | null>(null);
  rejectMotivo = '';

  constructor() {
    this.svc.departamentos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((d) => this.departamentos.set(d));
    this.load();
  }

  kpiItems(r: ComprobacionesReport): MetricStripItem[] {
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
    this.error.set(null);
    this.svc.list({ status: this.statusSel() || undefined, search: this.search || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar las comprobaciones.'); this.loading.set(false); },
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
      this.fileData[role] = String(reader.result || '');
      delete this.uploaded[role];
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

  doValidate(r: Comprobacion) {
    if (this.validatingId()) return;
    this.validatingId.set(r.id);
    this.svc.validate(r.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.validatingId.set(null); this.toast.add({ severity: 'success', summary: 'Validada', detail: `Gasto ${r.folio_gasto}` }); this.load(); },
        error: () => { this.validatingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(r: Comprobacion) { this.rejectTarget.set(r); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const r = this.rejectTarget();
    if (!r) return;
    this.saving.set(true);
    this.svc.reject(r.id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: `Gasto ${r.folio_gasto}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  fileLabel(role: string): string { return this.fileSlots.find((s) => s.role === role)?.label || role; }
  statusLabel(s: string): string { return ({ recibida: 'Recibida', validada: 'Validada', rechazada: 'Rechazada' } as Record<string, string>)[s] || s; }
  statusSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'warn', validada: 'success', rechazada: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
