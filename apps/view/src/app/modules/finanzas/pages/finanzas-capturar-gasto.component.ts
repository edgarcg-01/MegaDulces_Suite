import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { AuthService } from '../../../core/services/auth.service';
import {
  ComprobacionGastosService, GastoSug, ProofFile, ComprobacionFileRole,
  ValidatePhotoResult, Comprobacion,
} from '../comprobacion-gastos.service';

/** Gasto de Kepler elegido (read-only) — el capturista solo confirma que es el correcto. */
interface SelGasto { folio_gasto: string; proveedor: string | null; importe: number; sucursal: string | null; area: string | null; fecha: string | null; solicitud_folio: string | null; solicitud_importe: number | null; }

/**
 * GX.8 — Vista del CAPTURISTA (rol `FINANCE_EXPENSES_CAPTURAR`). Superficie mínima:
 * pega el folio del gasto que le dieron de Kepler, sube el/los comprobante(s), envía.
 * Todo lo demás (proveedor, importe, área, solicitud) lo deriva el sistema del gasto
 * Kepler. No ve la bandeja de revisión ni valida — eso es del autorizador. Móvil-first.
 */
@Component({
  selector: 'app-finanzas-capturar-gasto',
  standalone: true,
  imports: [CommonModule, FormsModule, AutoCompleteModule, TagModule, ButtonModule, InputTextModule, ToastModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cap">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Capturar comprobante de gasto</h1>
          <p class="surf-page-sub">Pega el folio del gasto (Kepler) y sube el comprobante. Lo demás lo llena el sistema.</p>
        </div>
      </header>

      <div class="card-premium card-flat cap-card">
        <!-- 1) Folio del gasto -->
        @if (!gasto()) {
          <label class="cap-f"><span>1 · Folio del gasto (Kepler)</span>
            <p-autocomplete [(ngModel)]="sel" [suggestions]="sug()" (completeMethod)="buscar($event)"
              (onSelect)="pick($event)" optionLabel="label" [forceSelection]="false" [showClear]="true"
              placeholder="Ej. 7243, o nombre del proveedor…" appendTo="body" styleClass="w-full" [minLength]="2" />
            <em class="cap-hint">Escribe el folio que te dieron; te muestro el gasto para confirmar.</em>
          </label>
        } @else {
          <div class="cap-gasto">
            <div class="cap-g-top">
              <div>
                <div class="cap-g-folio">Gasto <span class="mono">{{ gasto()!.folio_gasto }}</span></div>
                <div class="cap-g-prov">{{ gasto()!.proveedor || '—' }}</div>
              </div>
              <div class="cap-g-imp">{{ moneyFull(gasto()!.importe) }}</div>
            </div>
            <div class="cap-g-meta">
              @if (gasto()!.sucursal) { <span><i class="pi pi-map-marker"></i> {{ gasto()!.sucursal }}</span> }
              @if (gasto()!.area) { <span><i class="pi pi-sitemap"></i> {{ gasto()!.area }}</span> }
              @if (gasto()!.fecha) { <span><i class="pi pi-calendar"></i> {{ gasto()!.fecha | date:'dd/MM/yy' }}</span> }
            </div>
            @if (gasto()!.solicitud_folio) {
              <div class="cap-cuadre" [class.ok]="cuadra() === 'ok'" [class.bad]="cuadra() === 'bad'">
                @if (cuadra() === 'ok') { <i class="pi pi-check-circle"></i> Cuadra con la solicitud {{ gasto()!.solicitud_folio }} · {{ moneyFull(gasto()!.solicitud_importe) }} }
                @else if (cuadra() === 'bad') { <i class="pi pi-exclamation-triangle"></i> Ojo: la solicitud {{ gasto()!.solicitud_folio }} pide {{ moneyFull(gasto()!.solicitud_importe) }}, el gasto es {{ moneyFull(gasto()!.importe) }} }
                @else { <i class="pi pi-info-circle"></i> Solicitud {{ gasto()!.solicitud_folio }} }
              </div>
            }
            <button type="button" class="cap-link" (click)="reset()">cambiar gasto</button>
          </div>

          <!-- 2) Comprobante -->
          <div class="cap-step">2 · Sube el comprobante</div>
          @if (!names()['comprobacion']) {
            <div class="cap-drop" [class.drag]="drag()" (dragover)="over($event)" (dragleave)="leave($event)" (drop)="drop($event)">
              <i class="pi pi-camera cap-drop-ic"></i>
              <div>Arrastra la <strong>foto o PDF</strong> del comprobante</div>
              <label class="cap-pick"><i class="pi pi-upload"></i> Elegir / tomar foto
                <input type="file" accept="image/*,application/pdf" capture="environment" (change)="onFile($event, 'comprobacion')" hidden />
              </label>
            </div>
          } @else {
            <div class="cap-done">
              <i class="pi pi-check-circle cap-ok"></i> <span class="cap-nm">{{ names()['comprobacion'] }}</span>
              @if (photoLoading()) { <span class="cap-proc"><i class="pi pi-spin pi-spinner"></i> leyendo…</span> }
              <button type="button" class="cap-link" (click)="clearPhoto()">cambiar</button>
            </div>
            @if (photoResult(); as pr) {
              @if (pr.ocr_status === 'ok' && pr.monto_match) { <div class="cap-val ok"><i class="pi pi-check-circle"></i> El monto de la foto cuadra con el gasto.</div> }
              @else if (pr.ocr_status === 'ok') { <div class="cap-val warn"><i class="pi pi-exclamation-triangle"></i> El monto no cuadra — igual puedes enviarlo; quedará en revisión.</div> }
              @else if (pr.ocr_status === 'sin_key') { <div class="cap-val warn"><i class="pi pi-info-circle"></i> Se enviará para revisión manual.</div> }
              @else { <div class="cap-val warn"><i class="pi pi-exclamation-triangle"></i> No pude leer la foto — quedará en revisión.</div> }
            }
          }

          <label class="cap-f"><span>Comentarios (opcional)</span>
            <textarea pInputText [(ngModel)]="comentarios" rows="2" placeholder="Nota para quien autoriza…"></textarea></label>

          @if (formError()) { <div class="cap-err">{{ formError() }}</div> }
          <button pButton type="button" class="cap-send" [loading]="saving()" (click)="submit()">
            <span class="p-button-icon p-button-icon-left pi pi-send"></span><span class="p-button-label">Enviar comprobante</span>
          </button>
        }
      </div>

      <!-- Mis capturas -->
      <div class="cap-mine">
        <div class="cap-mine-h"><h2>Mis últimas capturas</h2><button type="button" class="cap-link" (click)="loadMine()"><i class="pi pi-refresh"></i> actualizar</button></div>
        @if (mineLoading()) { <div class="cap-muted">Cargando…</div> }
        @else if (!mine().length) { <div class="cap-muted">Aún no has capturado comprobantes.</div> }
        @else {
          <div class="cap-list">
            @for (m of mine(); track m.id) {
              <div class="cap-item">
                <div class="cap-it-main">
                  <span class="mono">{{ m.folio_gasto }}</span>
                  <span class="cap-it-prov">{{ m.proveedor }}</span>
                </div>
                <div class="cap-it-side">
                  <span class="cap-it-imp">{{ moneyFull(m.importe) }}</span>
                  <p-tag [value]="statusLabel(m.status)" [severity]="statusSev(m.status)" />
                  <span class="cap-it-date">{{ m.created_at | date:'dd/MM HH:mm' }}</span>
                </div>
                @if (m.status === 'rechazada' && m.motivo_rechazo) { <div class="cap-it-note bad"><i class="pi pi-times-circle"></i> {{ m.motivo_rechazo }}</div> }
                @else if (m.status === 'revision' && m.revision_nota) { <div class="cap-it-note warn"><i class="pi pi-exclamation-triangle"></i> {{ m.revision_nota }}</div> }
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cap { max-width: 44rem; margin: 0 auto; }
    .cap-card { padding: 1.2rem; display: flex; flex-direction: column; gap: 1rem; }
    .cap-f { display: flex; flex-direction: column; gap: .35rem; }
    .cap-f > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cap-hint { font-size: .74rem; color: var(--text-muted); font-style: normal; }
    .w-full { width: 100%; }
    .mono { font-family: var(--font-mono); }
    .cap-gasto { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .9rem; background: var(--surface-sunken, var(--card-bg)); display: flex; flex-direction: column; gap: .5rem; }
    .cap-g-top { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    .cap-g-folio { font-size: .82rem; color: var(--text-muted); }
    .cap-g-prov { font-size: 1.05rem; font-weight: 600; color: var(--text-main); margin-top: .15rem; }
    .cap-g-imp { font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cap-g-meta { display: flex; flex-wrap: wrap; gap: .3rem .9rem; font-size: .8rem; color: var(--text-muted); }
    .cap-g-meta span { display: inline-flex; align-items: center; gap: .3rem; }
    .cap-cuadre { display: flex; align-items: center; gap: .4rem; font-size: .8rem; padding: .45rem .6rem; border-radius: var(--r-sm, .4rem); border: 1px solid var(--border-color); color: var(--text-muted); }
    .cap-cuadre.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 8%, transparent); border-color: color-mix(in srgb, var(--ok-fg) 30%, transparent); }
    .cap-cuadre.bad { color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 8%, transparent); border-color: color-mix(in srgb, var(--bad-fg) 30%, transparent); }
    .cap-link { align-self: flex-start; border: none; background: transparent; color: var(--action); cursor: pointer; font: inherit; text-decoration: underline; padding: 0; font-size: .8rem; }
    .cap-step { font-size: .8rem; font-weight: 600; color: var(--text-main); border-top: 1px solid var(--border-color); padding-top: .8rem; }
    .cap-drop { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 1.6rem 1rem; border: 2px dashed var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); text-align: center; }
    .cap-drop.drag { border-color: var(--action); }
    .cap-drop-ic { font-size: 2rem; color: var(--action); }
    .cap-pick { display: inline-flex; align-items: center; gap: .4rem; padding: .6rem 1rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); cursor: pointer; background: var(--card-bg); font-size: .9rem; }
    .cap-pick:hover { border-color: var(--action); color: var(--action); }
    .cap-done { display: flex; align-items: center; gap: .5rem; font-size: .88rem; padding: .6rem .8rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .cap-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap-ok { color: var(--ok-fg); }
    .cap-proc { font-size: .8rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .35rem; }
    .cap-val { display: flex; align-items: flex-start; gap: .5rem; font-size: .82rem; padding: .55rem .7rem; border-radius: var(--r-md, .5rem); border: 1px solid var(--border-color); }
    .cap-val.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 8%, transparent); border-color: color-mix(in srgb, var(--ok-fg) 30%, transparent); }
    .cap-val.warn { color: var(--warn-fg, var(--bad-fg)); background: color-mix(in srgb, var(--warn-fg, var(--bad-fg)) 8%, transparent); border-color: color-mix(in srgb, var(--warn-fg, var(--bad-fg)) 30%, transparent); }
    .cap-err { color: var(--bad-fg); font-size: .82rem; }
    .cap-send { justify-content: center; }
    .cap-mine { margin-top: 1.4rem; }
    .cap-mine-h { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
    .cap-mine-h h2 { font-size: 1rem; margin: 0 0 .6rem; }
    .cap-muted { color: var(--text-muted); font-size: .85rem; }
    .cap-list { display: flex; flex-direction: column; gap: .5rem; }
    .cap-item { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .6rem .8rem; background: var(--card-bg); display: flex; flex-direction: column; gap: .35rem; }
    .cap-it-main { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
    .cap-it-prov { color: var(--text-muted); font-size: .88rem; }
    .cap-it-side { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
    .cap-it-imp { font-variant-numeric: tabular-nums; font-weight: 600; }
    .cap-it-date { font-size: .74rem; color: var(--text-muted); margin-left: auto; }
    .cap-it-note { font-size: .78rem; display: flex; align-items: center; gap: .35rem; }
    .cap-it-note.bad { color: var(--bad-fg); }
    .cap-it-note.warn { color: var(--warn-fg, var(--bad-fg)); }
  `],
})
export class FinanzasCapturarGastoComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComprobacionGastosService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly gasto = signal<SelGasto | null>(null);
  readonly sug = signal<(GastoSug & { label: string })[]>([]);
  sel: (GastoSug & { label: string }) | string | null = null;
  comentarios = '';

  readonly photoLoading = signal(false);
  readonly photoResult = signal<ValidatePhotoResult | null>(null);
  readonly names = signal<Record<string, string>>({});
  private fileData: Record<string, string> = {};
  private uploaded: Record<string, ProofFile> = {};
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly drag = signal(false);

  readonly mine = signal<Comprobacion[]>([]);
  readonly mineLoading = signal(false);

  readonly cuadra = computed<'ok' | 'bad' | 'na'>(() => {
    const g = this.gasto();
    if (!g || g.solicitud_importe == null) return 'na';
    const tol = Math.max(1, Math.abs(g.importe) * 0.01);
    return Math.abs(g.importe - g.solicitud_importe) <= tol ? 'ok' : 'bad';
  });

  constructor() { this.loadMine(); }

  buscar(ev: { query: string }) {
    const q = (ev.query || '').trim();
    if (q.length < 2) { this.sug.set([]); return; }
    this.svc.searchGastos(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((rows) => {
      this.sug.set((rows || []).map((r) => ({ ...r, label: `${r.folio_gasto} · ${r.proveedor || '—'} · ${this.moneyFull(r.importe)}` })));
      this.cdr.markForCheck();
    });
  }

  pick(ev: { value: GastoSug & { label: string } } | (GastoSug & { label: string })) {
    const g = (ev as { value: GastoSug & { label: string } }).value ?? (ev as GastoSug & { label: string });
    if (!g || typeof g === 'string') return;
    this.gasto.set({ folio_gasto: g.folio_gasto, proveedor: g.proveedor, importe: Number(g.importe) || 0, sucursal: g.sucursal, area: g.area, fecha: g.fecha, solicitud_folio: g.solicitud_folio, solicitud_importe: g.solicitud_importe ?? null });
    this.sel = null;
  }

  reset() { this.gasto.set(null); this.clearPhoto(); this.sel = null; this.comentarios = ''; this.formError.set(''); }

  onFile(ev: Event, role: string) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.handle(file, role);
  }
  over(e: DragEvent) { e.preventDefault(); e.stopPropagation(); if (!this.drag()) this.drag.set(true); }
  leave(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.drag.set(false); }
  drop(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.drag.set(false); const f = e.dataTransfer?.files?.[0]; if (f) this.handle(f, 'comprobacion'); }
  clearPhoto() {
    delete this.fileData['comprobacion']; delete this.uploaded['comprobacion'];
    this.names.update((m) => { const n = { ...m }; delete n['comprobacion']; return n; });
    this.photoResult.set(null);
  }

  private handle(file: File, role: string) {
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri;
      delete this.uploaded[role];
      this.names.update((m) => ({ ...m, [role]: file.name }));
      if (role === 'comprobacion') this.validate(dataUri);
      this.cdr.markForCheck();
    };
    reader.readAsDataURL(file);
  }

  private validate(dataUri: string) {
    this.photoLoading.set(true);
    this.photoResult.set(null);
    this.svc.validatePhoto(dataUri, Number(this.gasto()?.importe) || 0).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.photoLoading.set(false); this.photoResult.set(r); this.cdr.markForCheck(); },
      error: () => { this.photoLoading.set(false); },
    });
  }

  submit() {
    const g = this.gasto();
    if (!g) { this.formError.set('Elige el gasto.'); return; }
    if (!this.fileData['comprobacion'] && !this.uploaded['comprobacion']) { this.formError.set('Sube el comprobante.'); return; }
    if (this.photoLoading()) { this.formError.set('Espera a que termine de leerse la foto…'); return; }
    this.formError.set('');
    this.saving.set(true);

    const roles = ['comprobacion'];
    const toUpload = roles.filter((r) => this.fileData[r] && !this.uploaded[r]);
    if (!toUpload.length) { this.create(); return; }
    const ups = toUpload.map((r) => this.svc.uploadFile(this.fileData[r], r as ComprobacionFileRole).pipe(
      map((file) => ({ role: r, file: file as ProofFile | null })), catchError(() => of({ role: r, file: null as ProofFile | null })),
    ));
    forkJoin(ups).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((results) => {
      for (const res of results) { if (res.file) { this.uploaded[res.role] = res.file; delete this.fileData[res.role]; } }
      if (results.some((r) => !r.file)) { this.saving.set(false); this.formError.set('No se pudo subir el archivo. Reintenta.'); return; }
      this.create();
    });
  }

  private create() {
    const g = this.gasto()!;
    const pr = this.photoResult();
    const files = ['comprobacion'].map((r) => this.uploaded[r]).filter(Boolean) as ProofFile[];
    this.svc.create({
      folio_gasto: g.folio_gasto, sucursal: g.sucursal || undefined, comentarios: this.comentarios || undefined, files,
      monto_ocr: pr?.total ?? null, subtotal_ocr: pr?.subtotal ?? null,
      receipt_legible: pr ? (pr.ocr_status === 'ok' && pr.legible) : false,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Enviado', detail: `Gasto ${g.folio_gasto} · pendiente de autorización` }); this.uploaded = {}; this.reset(); this.loadMine(); },
      error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar.'); },
    });
  }

  loadMine() {
    this.mineLoading.set(true);
    this.svc.mine(50).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.mine.set(r.rows || []); this.mineLoading.set(false); },
      error: () => { this.mineLoading.set(false); },
    });
  }

  statusLabel(s: string): string { return ({ recibida: 'Recibida', validada: 'Validada', rechazada: 'Rechazada', revision: 'En revisión' } as Record<string, string>)[s] || s; }
  statusSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'secondary', validada: 'success', rechazada: 'danger', revision: 'warn' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[s] || 'secondary'; }
  moneyFull(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
}
