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
import { CobranzaService, CobroRow, CobrosReport, DepositOcr, DepositFile } from '../cobranza.service';

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
              <td>
                @if (c.deposits > 0) {
                  <div class="cb-comp">
                    <p-tag [value]="depLabel(c.deposit_status)" [severity]="depSev(c.deposit_status)" />
                    <span class="cb-match" [class.ok]="c.monto_match" [class.bad]="!c.monto_match" [title]="c.monto_match ? 'El monto de la ficha cuadra con el cobro' : 'El monto de la ficha NO cuadra'">
                      <i class="pi" [ngClass]="c.monto_match ? 'pi-check-circle' : 'pi-exclamation-triangle'"></i>
                    </span>
                  </div>
                } @else { <span class="muted">Sin comprobante</span> }
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
    </div>

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

  constructor() { this.load(); }

  kpiItems(r: CobrosReport): MetricStripItem[] {
    return [
      { label: 'Cobros', value: r.kpis.cobros },
      { label: 'Con comprobante', value: r.kpis.con_comprobante, tone: 'ok' },
      { label: 'Validados', value: r.kpis.validados, tone: 'ok' },
      { label: '$ por comprobar', value: this.money(r.kpis.monto_pendiente), tone: 'warn' },
    ];
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
        next: (res) => { this.saving.set(false); this.showAttach.set(false); this.toast.add({ severity: 'success', summary: 'Comprobante adjuntado', detail: res.monto_match ? 'El monto cuadra ✓' : 'Guardado (revisa el monto)' }); this.load(); },
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

  formaLabel(f: string | null): string { return ({ deposito: 'Depósito', transferencia: 'Transferencia', tarjeta: 'Tarjeta', efectivo: 'Efectivo', cheque: 'Cheque', otro: 'Otro' } as Record<string, string>)[f || ''] || (f || '—'); }
  formaSev(f: string | null): 'info' | 'success' | 'warn' | 'secondary' { return ({ deposito: 'info', transferencia: 'info', tarjeta: 'secondary', efectivo: 'success', cheque: 'warn' } as Record<string, 'info' | 'success' | 'warn' | 'secondary'>)[f || ''] || 'secondary'; }
  depLabel(s: string | null): string { return ({ recibido: 'Recibido', validado: 'Validado', rechazado: 'Rechazado' } as Record<string, string>)[s || ''] || '—'; }
  depSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibido: 'warn', validado: 'success', rechazado: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
