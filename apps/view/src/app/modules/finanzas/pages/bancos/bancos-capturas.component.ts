import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';
import { BankCaptureService, BankCapture, CaptureKpis } from '../../bank-capture.service';
import { money0, dmy } from './bancos-shared';

/**
 * CBW.4 (ADR-042) — Bandeja de capturas bancarias por WhatsApp.
 * Cada foto de ficha llega atribuida (remitente + sucursal + cuenta + monto) y en
 * estado pendiente/confirmado. El revisor de Crédito y Cobranza valida (→ luego
 * cuadra contra el estado de cuenta) o rechaza. Surface Operations, denso.
 */
@Component({
  selector: 'bancos-capturas',
  standalone: true,
  imports: [FormsModule, ButtonModule, TableModule, SelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bc-kpis">
      <button class="bc-kpi" [class.active]="fStatus()===''" (click)="setStatus('')">
        <span class="bc-kpi-n mono">{{ total() }}</span><span class="bc-kpi-l">Todas</span></button>
      <button class="bc-kpi" [class.active]="fStatus()==='confirmado'" (click)="setStatus('confirmado')">
        <span class="bc-kpi-n mono">{{ kpis().confirmado }}</span><span class="bc-kpi-l">Por validar</span></button>
      <button class="bc-kpi" [class.active]="fStatus()==='pendiente_confirmacion'" (click)="setStatus('pendiente_confirmacion')">
        <span class="bc-kpi-n mono">{{ kpis().pendiente_confirmacion }}</span><span class="bc-kpi-l">Sin confirmar</span></button>
      <button class="bc-kpi" [class.active]="fStatus()==='validado'" (click)="setStatus('validado')">
        <span class="bc-kpi-n mono">{{ kpis().validado }}</span><span class="bc-kpi-l">Validadas</span></button>
      <div class="bc-kpi bc-kpi-money">
        <span class="bc-kpi-n mono">{{ money(kpis().total_monto) }}</span><span class="bc-kpi-l">Monto (conf.+valid.)</span></div>
    </div>

    <p class="bc-note">Depósitos recibidos por WhatsApp o subidos por web. Al validar, el depósito se agrega al libro (Movimientos) automáticamente.
      @if (errorCount() > 0) { <span class="bc-note-warn"><i class="pi pi-exclamation-triangle"></i> {{ errorCount() }} con problema — revisar.</span> }
    </p>

    <div class="bc-upload">
      <label class="bc-up-file" [class.has]="!!upB64()">
        <i class="pi" [class.pi-upload]="!upB64()" [class.pi-check]="!!upB64()"></i>
        <span>{{ upName() || 'Elegir foto o PDF de la ficha…' }}</span>
        <input type="file" accept="image/*,application/pdf" (change)="onFile($event)" hidden />
      </label>
      <input class="bc-up-suc" type="text" [ngModel]="upSucursal()" (ngModelChange)="upSucursal.set($event)" placeholder="Sucursal (opcional)" aria-label="Sucursal" />
      <button pButton type="button" class="p-button-sm" [disabled]="!upB64() || uploading()" [loading]="uploading()" (click)="doUpload()">
        <span class="p-button-icon p-button-icon-left pi pi-cloud-upload" aria-hidden="true"></span><span class="p-button-label">Subir ficha</span>
      </button>
      <span class="bc-up-hint muted">Se lee con OCR y entra a la bandeja para validar. No necesita WhatsApp.</span>
    </div>

    @if (loading()) {
      <div class="bc-skel" aria-busy="true">@for (i of [1,2,3,4,5]; track i) { <div class="bc-skel-row"></div> }</div>
    } @else if (!rows().length) {
      <div class="surf-empty"><i class="pi pi-whatsapp"></i><p>Sin capturas{{ fStatus() ? ' en este estado' : '' }}.</p></div>
    } @else {
      <div class="surf-card bc-tablewrap">
        <p-table [value]="rows()" styleClass="p-datatable-sm" [scrollable]="true">
          <ng-template #header>
            <tr>
              <th>Fecha</th><th>Remitente</th><th>Suc</th><th>Banco / Cuenta</th>
              <th class="ta-r">Monto</th><th>Ref</th><th>Estado</th><th>Foto</th><th class="ta-r">Acción</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr [class.bc-rej]="r.status==='rechazado' || r.status==='descartado'" [class.bc-err]="r.error_detail">
              <td class="mono muted">{{ dmy(r.created_at) }}</td>
              <td>
                <span class="bc-strong">{{ r.sender_name || r.from_phone }}</span>
                @if (r.customer_code || r.rfc) { <div class="bc-cust muted">{{ r.customer_code }}@if (r.rfc) { · {{ r.rfc }} }</div> }
                @if (r.error_detail) { <div class="bc-err-msg"><i class="pi pi-exclamation-triangle"></i> {{ r.error_detail }}</div> }
              </td>
              <td class="mono">{{ r.sucursal || '—' }}</td>
              <td>
                <div class="bc-bank">{{ r.ocr_banco || '—' }}</div>
                <div class="bc-acct muted">{{ r.cuenta || (r.ocr_cuenta_dest ? '···' + r.ocr_cuenta_dest : 'por asignar') }}</div>
              </td>
              <td class="ta-r mono bc-strong">{{ money(r.amount_in) }}</td>
              <td class="mono muted bc-ref">{{ r.ocr_referencia || '—' }}</td>
              <td><span class="bc-badge" [class]="'st-' + r.status">{{ label(r.status) }}</span></td>
              <td>
                @if (fileUrl(r); as u) { <a [href]="u" target="_blank" rel="noopener" class="bc-thumb" title="Ver comprobante"><i class="pi pi-image"></i></a> }
                @else { <span class="muted">—</span> }
              </td>
              <td class="ta-r">
                @if (r.status !== 'validado' && r.status !== 'rechazado' && r.status !== 'descartado') {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="validate(r)" title="Validar y agregar al libro"><i class="pi pi-check"></i></button>
                  <button pButton type="button" class="p-button-sm p-button-text btn-ghost-danger" (click)="reject(r)" title="Rechazar"><i class="pi pi-times"></i></button>
                } @else if (r.status === 'validado') {
                  <i class="pi pi-check-circle ok" title="En el libro"></i>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .bc-kpis { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-3) 0 var(--sp-2); }
    .bc-kpi { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 7rem; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); cursor: pointer; text-align: left;
      transition: border-color 120ms ease, background-color 120ms ease; }
    .bc-kpi:hover { border-color: var(--action); }
    .bc-kpi.active { border-color: var(--action); background: color-mix(in srgb, var(--action) 6%, transparent); }
    .bc-kpi-money { cursor: default; }
    .bc-kpi-n { font-size: var(--fs-lg, 1.125rem); font-weight: 700; color: var(--text-main); }
    .bc-kpi-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
    .bc-note { font-size: var(--fs-xs); color: var(--text-muted); margin: 0 0 var(--sp-3); }
    .bc-note-warn { color: var(--warn-fg); margin-left: var(--sp-2); }
    .bc-note-warn i { font-size: 0.7rem; margin-right: 2px; }
    .bc-upload { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-3); padding: var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .bc-up-file { display: inline-flex; align-items: center; gap: 6px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); cursor: pointer; font-size: var(--fs-sm); color: var(--text-main); background: var(--surface, var(--card-bg)); }
    .bc-up-file:hover { border-color: var(--action); } .bc-up-file.has { border-color: var(--ok-fg); color: var(--ok-fg); }
    .bc-up-suc { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface, var(--card-bg)); color: var(--text-main); font-size: var(--fs-sm); min-width: 10rem; }
    .bc-up-hint { font-size: var(--fs-xs); flex-basis: 100%; }
    .bc-tablewrap { padding: 0; overflow: hidden; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .muted { color: var(--text-muted); } .ta-r { text-align: right; }
    .ok { color: var(--ok-fg); } .bc-strong { font-weight: 600; color: var(--text-main); }
    .bc-bank { font-size: var(--fs-sm); } .bc-acct { font-size: var(--fs-xs); }
    .bc-cust { font-size: var(--fs-xs); font-family: var(--font-mono); margin-top: 1px; }
    .bc-ref { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bc-rej { opacity: 0.5; }
    .bc-err > td { background: color-mix(in srgb, var(--warn-fg) 6%, transparent); }
    .bc-err-msg { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; font-size: var(--fs-xs); color: var(--warn-fg); }
    .bc-err-msg i { font-size: 0.75rem; }
    .bc-badge { display: inline-block; font-size: var(--fs-2xs, 0.7rem); font-weight: 600; padding: 1px var(--sp-2); border-radius: var(--r-pill); }
    .st-pendiente_confirmacion { color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .st-confirmado { color: var(--action); background: color-mix(in srgb, var(--action) 12%, transparent); }
    .st-validado { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); }
    .st-rechazado, .st-descartado { color: var(--text-faint); background: var(--hover-bg); }
    .bc-thumb { color: var(--action); } .bc-thumb:hover { text-decoration: none; opacity: 0.8; }
    .btn-ghost-danger { color: var(--text-faint); } .btn-ghost-danger:hover { color: var(--bad-fg); }
    .bc-skel { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); }
    .bc-skel-row { height: 40px; border-radius: var(--r-sm); background: var(--hover-bg); animation: bc-pulse 1.4s ease-in-out infinite; }
    @keyframes bc-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .bc-skel-row { animation: none; } }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosCapturasComponent implements OnInit {
  private readonly api = inject(BankCaptureService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<BankCapture[]>([]);
  readonly kpis = signal<CaptureKpis>({ pendiente_confirmacion: 0, confirmado: 0, validado: 0, rechazado: 0, descartado: 0, total_monto: 0 });
  readonly loading = signal(true);
  readonly fStatus = signal('');

  // CBW.8 — subida web de la ficha (sin WhatsApp).
  readonly upB64 = signal<string | null>(null);
  readonly upMime = signal('image/jpeg');
  readonly upName = signal('');
  readonly upSucursal = signal('');
  readonly uploading = signal(false);

  readonly total = computed(() => {
    const k = this.kpis();
    return k.pendiente_confirmacion + k.confirmado + k.validado + k.rechazado + k.descartado;
  });
  readonly errorCount = computed(() => this.rows().filter((r) => !!r.error_detail).length);

  readonly money = money0;
  readonly dmy = dmy;

  ngOnInit(): void { this.load(); }

  setStatus(s: string): void { this.fStatus.set(s); this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.list({ status: this.fStatus() || undefined, limit: 300 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.rows.set(p.rows); this.kpis.set(p.kpis); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las capturas.', life: 3500 }); },
    });
  }

  onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { this.toast.add({ severity: 'warn', summary: 'Archivo grande', detail: 'Máx 12 MB.', life: 3000 }); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const b64 = res.includes(',') ? res.slice(res.indexOf(',') + 1) : res;
      this.upB64.set(b64); this.upMime.set(file.type || 'image/jpeg'); this.upName.set(file.name);
    };
    reader.readAsDataURL(file);
  }

  doUpload(): void {
    const b64 = this.upB64(); if (!b64) return;
    this.uploading.set(true);
    this.api.upload({ file_base64: b64, mime: this.upMime(), sucursal: this.upSucursal() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.uploading.set(false);
          this.toast.add({ severity: 'success', summary: 'Ficha subida', detail: 'Se leyó con OCR y entró a la bandeja para validar.', life: 3000 });
          this.upB64.set(null); this.upName.set(''); this.upSucursal.set('');
          this.load();
        },
        error: (e) => { this.uploading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo subir', detail: e?.error?.message || 'Reintenta.', life: 4000 }); },
      });
  }

  fileUrl(r: BankCapture): string | null {
    const f = typeof r.files === 'string' ? safeParse(r.files) : r.files;
    return Array.isArray(f) && f[0]?.url ? f[0].url : null;
  }

  label(s: string): string {
    return s === 'pendiente_confirmacion' ? 'Sin confirmar' : s === 'confirmado' ? 'Por validar'
      : s === 'validado' ? 'Validada' : s === 'rechazado' ? 'Rechazada' : 'Descartada';
  }

  validate(r: BankCapture): void {
    this.api.validate(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Agregado al libro', detail: 'El depósito se registró en Movimientos.', life: 2500 }); this.load(); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'No se pudo validar', detail: e?.error?.message || 'Revisa que tenga cuenta asignada.', life: 4000 }),
    });
  }

  reject(r: BankCapture): void {
    this.api.reject(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Rechazada', life: 1500 }); this.load(); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo rechazar.', life: 3000 }),
    });
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
