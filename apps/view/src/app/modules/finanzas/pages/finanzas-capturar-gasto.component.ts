import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { ComprobacionesService, SolicitudSug, ProofFile, ProofFileRole, ProofPhotoOcr, ExpenseProof, ExpenseClasificacion, requiereEvidencia } from '../comprobaciones.service';

/** Solicitud de Kepler elegida (read-only) — el capturista sólo confirma que es la correcta. */
interface SelSolicitud { folio: string; beneficiario: string | null; importe: number; sucursal: string | null; solicitante: string | null; fecha: string | null; concepto: string | null; }

/**
 * GX.8 — Vista del CAPTURISTA (rol `FINANCE_EXPENSES_CAPTURAR`). Superficie mínima:
 * pega el folio del gasto que le dieron de Kepler, sube el/los comprobante(s), envía.
 * Todo lo demás (proveedor, importe, área, solicitud) lo deriva el sistema del gasto
 * Kepler. No ve la bandeja de revisión ni valida — eso es del autorizador. Móvil-first.
 */
@Component({
  selector: 'app-finanzas-capturar-gasto',
  standalone: true,
  imports: [CommonModule, FormsModule, AutoCompleteModule, TagModule, ButtonModule, InputTextModule, TextareaModule, SelectButtonModule, ToastModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cap">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Capturar gasto</h1>
          <p class="surf-page-sub">Pega el folio de la solicitud (Kepler), sube la solicitud firmada y —si aplica— el comprobante. Lo demás lo llena el sistema.</p>
        </div>
      </header>

      <div class="card-premium card-flat cap-card">
        <!-- 1) Folio del gasto -->
        @if (!gasto()) {
          <label class="cap-f"><span>1 · Folio de la solicitud (Kepler)</span>
            <p-autocomplete [(ngModel)]="sel" [suggestions]="sug()" (completeMethod)="buscar($event)"
              (onSelect)="pick($event)" optionLabel="label" [forceSelection]="false" [showClear]="true"
              placeholder="Últimos 4 dígitos, ej. 8489" appendTo="body" styleClass="w-full"
              [emptyMessage]="vacioMsg()" />
            <em class="cap-hint">Con los últimos dígitos basta: el 23 encuentra el folio 0000023. También podés buscar por beneficiario.</em>
          </label>
        } @else {
          <div class="cap-gasto">
            <div class="cap-g-top">
              <div>
                <div class="cap-g-folio">Solicitud <span class="mono">{{ gasto()!.folio }}</span></div>
                <div class="cap-g-prov">{{ gasto()!.beneficiario || '—' }}</div>
              </div>
              <div class="cap-g-imp">{{ moneyFull(gasto()!.importe) }}</div>
            </div>
            <div class="cap-g-meta">
              @if (gasto()!.sucursal) { <span><i class="pi pi-map-marker" aria-hidden="true"></i> {{ gasto()!.sucursal }}</span> }
              @if (gasto()!.solicitante) { <span><i class="pi pi-user" aria-hidden="true"></i> {{ gasto()!.solicitante }}</span> }
              @if (gasto()!.fecha) { <span><i class="pi pi-calendar" aria-hidden="true"></i> {{ gasto()!.fecha | date:'dd/MM/yy' }}</span> }
            </div>
            @if (gasto()!.concepto) { <div class="cap-g-meta"><span><i class="pi pi-align-left" aria-hidden="true"></i> {{ gasto()!.concepto }}</span></div> }
            <button type="button" class="cap-link" (click)="reset()">cambiar solicitud</button>
          </div>

          <!-- 2) Solicitud firmada: OBLIGATORIA siempre (la autorización que respalda la
               salida de dinero). Va en los tres tipos de gasto, incluso no comprobable. -->
          <div class="cap-step">2 · Sube la solicitud firmada</div>
          @if (!names()['solicitud_kepler']) {
            <div class="cap-drop" [class.drag]="dragSol()" (dragover)="overSol($event)" (dragleave)="leaveSol($event)" (drop)="dropSol($event)">
              <i class="pi pi-file-edit cap-drop-ic" aria-hidden="true"></i>
              <div>Arrastra la <strong>solicitud de gasto firmada</strong> (foto o PDF)</div>
              <label class="cap-pick"><i class="pi pi-upload" aria-hidden="true"></i> Elegir / tomar foto
                <input type="file" accept="image/*,application/pdf" capture="environment" (change)="onFile($event, 'solicitud_kepler')" hidden />
              </label>
            </div>
          } @else {
            <div class="cap-done">
              <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()['solicitud_kepler'] }}</span>
              <button type="button" class="cap-link" (click)="clearFile('solicitud_kepler')">cambiar</button>
            </div>
          }

          <!-- 3) Clasificación del gasto: decide si lleva evidencia. -->
          <div class="cap-step">3 · ¿Qué tipo de gasto es?</div>
          <p-selectbutton [options]="clasOpts" [(ngModel)]="clasificacionV" (ngModelChange)="onClasChange()"
                          optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="cap-clas"
                          ariaLabel="Tipo de gasto" />
          @if (clasificacion()) { <em class="cap-hint">{{ clasHint() }}</em> }

          <!-- 3) Evidencia (si el gasto es comprobable) o motivo (si no lo es). -->
          @if (clasificacion()) {
            @if (llevaEvidencia()) {
              <div class="cap-step">4 · Sube la evidencia</div>
              @if (!names()['comprobante_1']) {
                <div class="cap-drop" [class.drag]="drag()" (dragover)="over($event)" (dragleave)="leave($event)" (drop)="drop($event)">
                  <i class="pi pi-camera cap-drop-ic" aria-hidden="true"></i>
                  <div>Arrastra la <strong>foto o PDF</strong> de la {{ clasificacion() === 'fiscal' ? 'factura' : 'evidencia' }}</div>
                  <label class="cap-pick"><i class="pi pi-upload" aria-hidden="true"></i> Elegir / tomar foto
                    <input type="file" accept="image/*,application/pdf" capture="environment" (change)="onFile($event, 'comprobante_1')" hidden />
                  </label>
                </div>
              } @else {
                <div class="cap-done">
                  <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()['comprobante_1'] }}</span>
                  @if (photoLoading()) { <span class="cap-proc"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> leyendo…</span> }
                  <button type="button" class="cap-link" (click)="clearPhoto()">cambiar</button>
                </div>
                @if (photoResult(); as pr) {
                  @if (pr.ocr_status === 'ok' && pr.monto_match) { <div class="cap-val ok"><i class="pi pi-check-circle" aria-hidden="true"></i> El monto de la foto cuadra con el gasto.</div> }
                  @else if (pr.ocr_status === 'ok') { <div class="cap-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> El monto no cuadra — igual puedes enviarlo; quedará en revisión.</div> }
                  @else if (pr.ocr_status === 'sin_key') { <div class="cap-val warn"><i class="pi pi-info-circle" aria-hidden="true"></i> Se enviará para revisión manual.</div> }
                  @else { <div class="cap-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No pude leer la foto — quedará en revisión.</div> }
                }
              }
              <label class="cap-f"><span>Comentarios (opcional)</span>
                <textarea pTextarea [(ngModel)]="comentarios" rows="2" class="w-full" placeholder="Nota para quien autoriza…"></textarea></label>
            } @else {
              <!-- No comprobable: sin foto, pero el motivo es obligatorio y auditable. -->
              <div class="cap-step">4 · ¿Por qué no se puede comprobar?</div>
              <textarea pTextarea [(ngModel)]="comentarios" rows="3" class="w-full"
                        placeholder="Ej. propina, gasto en efectivo sin recibo, viático sin factura…"></textarea>
              <em class="cap-hint">Este gasto se registra <strong>sin evidencia</strong>. El motivo lo lee quien valida.</em>
            }
          }

          @if (formError()) { <div class="cap-err">{{ formError() }}</div> }
          <!-- Poka-yoke: el botón no se puede apretar hasta tener lo que exige la
               clasificación (evidencia, o motivo si es no comprobable). -->
          <button pButton type="button" class="cap-send" [loading]="saving()"
                  [disabled]="!puedeEnviar() || saving() || photoLoading()"
                  [title]="enviarTitle()"
                  (click)="submit()">
            <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">Enviar</span>
          </button>
        }
      </div>

      <!-- Mis capturas -->
      <div class="cap-mine">
        <div class="cap-mine-h"><h2>Mis últimas capturas</h2><button type="button" class="cap-link" (click)="loadMine()"><i class="pi pi-refresh" aria-hidden="true"></i> actualizar</button></div>
        @if (mineLoading()) { <div class="cap-muted">Cargando…</div> }
        @else if (!mine().length) { <div class="cap-muted">Aún no has capturado comprobantes.</div> }
        @else {
          <div class="cap-list">
            @for (m of mine(); track m.id) {
              <div class="cap-item">
                <div class="cap-it-main">
                  <span class="mono">{{ m.folio_solicitud }}</span>
                  <span class="cap-it-prov">{{ m.proveedor }}</span>
                </div>
                <div class="cap-it-side">
                  <span class="cap-it-imp">{{ moneyFull(m.importe) }}</span>
                  <p-tag [value]="statusLabel(m.status)" [severity]="statusSev(m.status)" />
                  <span class="cap-it-date">{{ m.created_at | date:'dd/MM HH:mm' }}</span>
                </div>
                @if (m.status === 'rechazada' && m.motivo_rechazo) { <div class="cap-it-note bad"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ m.motivo_rechazo }} — vuelve a capturar el folio {{ m.folio_solicitud }}.</div> }
                @else if (m.status === 'revision' && m.revision_nota) { <div class="cap-it-note warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ m.revision_nota }}</div> }
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    /* Columna angosta: esto es un flujo de un solo hilo (elegí, subí, enviá), no una
       bandeja. El resto de Operations es full-width porque ahí sí se compara. */
    .cap { max-width: 44rem; margin: 0 auto; }
    .card-premium.cap-card { display: flex; flex-direction: column; gap: var(--sp-4);
      padding: var(--sp-4); box-shadow: none; }
    .card-premium.cap-card:hover { box-shadow: none; }
    .cap-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .cap-f > span { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .cap-hint { font-size: var(--fs-xs); color: var(--fg-3); font-style: normal; }
    .w-full { width: 100%; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    /* Ficha de la solicitud elegida, hundida respecto de la card.
       Ojo: --surface-sunken NO existe en tokens.css, así que el fallback la dejaba del
       mismo color que la card y el hundido no se veía nunca. */
    .cap-gasto { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cap-g-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); }
    .cap-g-folio { font-size: var(--fs-xs); color: var(--fg-3); }
    .cap-g-prov { margin-top: 1px; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cap-g-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--fg-1); white-space: nowrap; }
    .cap-g-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3);
      font-size: var(--fs-xs); color: var(--fg-2); }
    .cap-g-meta span { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .cap-cuadre { display: inline-flex; align-items: center; gap: var(--sp-1);
      padding: var(--sp-1) var(--sp-2); font-size: var(--fs-xs);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); color: var(--fg-2); }
    .cap-cuadre.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .cap-cuadre.bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cap-link { align-self: flex-start; min-height: max(1.5rem, var(--tap-min)); padding: 0; border: 0;
      background: none; font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer;
      text-decoration: underline; text-underline-offset: 2px; }
    .cap-link:hover { color: var(--action-hover); }
    .cap-link:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .cap-step { padding-top: var(--sp-3); border-top: 1px solid var(--border-color);
      font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    /* Clasificación: que las 3 opciones quepan y envuelvan en móvil. */
    :host ::ng-deep .cap-clas { display: flex; flex-wrap: wrap; }
    :host ::ng-deep .cap-clas .p-togglebutton, :host ::ng-deep .cap-clas .p-button { flex: 1 1 auto; }

    .cap-drop { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      padding: var(--sp-6) var(--sp-4); text-align: center; font-size: var(--fs-sm); color: var(--fg-2);
      border: 2px dashed var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cap-drop.drag { border-color: var(--action); background: var(--overlay-selected); }
    /* Ícono de la zona: neutro. El naranja es de la acción, no de la decoración. */
    .cap-drop-ic { font-size: var(--fs-h1); color: var(--fg-3); }
    /* Se ve como botón secundario porque ES el botón. El input va oculto para poder ofrecer
       cámara y arrastrar-soltar, que p-fileupload en modo básico no da. */
    .cap-pick { display: inline-flex; align-items: center; gap: var(--sp-2);
      min-height: max(2.25rem, var(--tap-min)); padding: 0 var(--sp-4);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg);
      font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); cursor: pointer;
      transition: border-color var(--dur-short) var(--ease-standard), color var(--dur-short) var(--ease-standard); }
    .cap-pick:hover { border-color: var(--action); color: var(--action); }
    .cap-pick:focus-within { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    .cap-done { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-sm); border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--surface-ground); }
    .cap-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap-ok { color: var(--ok-fg); }
    .cap-proc { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--fg-2); }
    /* Veredicto de la lectura: ícono + texto; el color acompaña, no carga solo. */
    .cap-val { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-xs); line-height: 1.4; border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .cap-val.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .cap-val.warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .cap-err { font-size: var(--fs-xs); color: var(--bad-fg); }
    .cap-send { justify-content: center; }

    .cap-mine { margin-top: var(--sp-6); }
    .cap-mine-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-4); }
    .cap-mine-h h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cap-muted { font-size: var(--fs-sm); color: var(--fg-2); }
    .cap-list { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cap-item { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .cap-it-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); }
    .cap-it-prov { font-size: var(--fs-sm); color: var(--fg-2); }
    .cap-it-side { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); }
    .cap-it-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .cap-it-date { margin-left: auto; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-xs); color: var(--fg-3); }
    .cap-it-note { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); }
    .cap-it-note.bad { color: var(--bad-fg); }
    .cap-it-note.warn { color: var(--warn-fg); }
  `],
})
export class FinanzasCapturarGastoComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComprobacionesService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly gasto = signal<SelSolicitud | null>(null);
  readonly sug = signal<(SolicitudSug & { label: string })[]>([]);
  sel: (SolicitudSug & { label: string }) | string | null = null;
  comentarios = '';

  /** Clasificación del gasto: decide si lleva evidencia. Obligatoria para enviar. */
  readonly clasificacion = signal<ExpenseClasificacion | null>(null);
  /** ngModel del selectbutton (no toma signal directo). */
  clasificacionV: ExpenseClasificacion | null = null;
  readonly clasOpts = [
    { label: 'Fiscal (factura)', value: 'fiscal' },
    { label: 'No fiscal, con recibo', value: 'no_fiscal_comprobable' },
    { label: 'No comprobable', value: 'no_comprobable' },
  ];
  readonly llevaEvidencia = computed(() => requiereEvidencia(this.clasificacion()));
  onClasChange() { this.clasificacion.set(this.clasificacionV); this.formError.set(''); }
  clasHint(): string {
    switch (this.clasificacion()) {
      case 'fiscal': return 'Lleva CFDI/factura. Adjunta la factura.';
      case 'no_fiscal_comprobable': return 'No tiene factura pero sí ticket o recibo. Adjunta la foto.';
      case 'no_comprobable': return 'No hay documento que lo respalde. Se registra con un motivo, sin foto.';
      default: return '';
    }
  }
  /** Poka-yoke del envío: la solicitud firmada es obligatoria SIEMPRE; la clasificación
   *  decide si además falta evidencia o motivo. */
  puedeEnviar(): boolean {
    if (!this.gasto() || !this.clasificacion()) return false;
    if (!this.names()['solicitud_kepler']) return false;   // la firma va en los 3 tipos
    return this.llevaEvidencia() ? !!this.names()['comprobante_1'] : !!this.comentarios.trim();
  }
  enviarTitle(): string {
    if (!this.names()['solicitud_kepler']) return 'Falta la solicitud firmada';
    if (!this.clasificacion()) return 'Elige el tipo de gasto';
    if (this.llevaEvidencia()) return this.names()['comprobante_1'] ? 'Enviar' : 'Falta subir la evidencia';
    return this.comentarios.trim() ? 'Enviar' : 'Falta el motivo';
  }

  readonly photoLoading = signal(false);
  readonly photoResult = signal<ProofPhotoOcr | null>(null);
  readonly names = signal<Record<string, string>>({});
  private fileData: Record<string, string> = {};
  private uploaded: Record<string, ProofFile> = {};
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly drag = signal(false);
  /** Drag propio de la zona de la solicitud firmada (para no encender ambas zonas a la vez). */
  readonly dragSol = signal(false);

  readonly mine = signal<ExpenseProof[]>([]);
  readonly mineLoading = signal(false);

  constructor() { this.loadMine(); }

  /** Último término buscado, para poder explicar un resultado vacío. */
  private readonly ultimo = signal('');
  /**
   * Un desplegable vacío sin explicación es el peor resultado posible: no se distingue
   * «ese folio no existe» de «no tenés alcance para verlo». Se dice cuál de las dos.
   */
  vacioMsg(): string {
    const q = this.ultimo();
    if (!q) return 'Escribí el folio de la solicitud.';
    if (/^[0-9]+$/.test(q)) return `No hay ninguna solicitud con folio ${q}. Revisá el número — el folio del gasto y el de la solicitud NO son el mismo.`;
    return 'Sin coincidencias. Si buscás por nombre y no sale nada, puede que no tengas áreas de gasto asignadas: buscá por folio exacto.';
  }

  buscar(ev: { query: string }) {
    const q = (ev.query || '').trim();
    this.ultimo.set(q);
    if (!q.length || (q.length < 2 && !/^[0-9]+$/.test(q))) { this.sug.set([]); return; }
    this.svc.searchSolicitudes(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((rows) => {
      this.sug.set((rows || []).map((r) => ({ ...r, label: `${r.folio} · suc ${r.sucursal || '?'} · ${r.beneficiario || '—'} · ${this.moneyFull(r.importe)}` })));
      this.cdr.markForCheck();
    });
  }

  pick(ev: { value: SolicitudSug & { label: string } } | (SolicitudSug & { label: string })) {
    const g = (ev as { value: SolicitudSug & { label: string } }).value ?? (ev as SolicitudSug & { label: string });
    if (!g || typeof g === 'string') return;
    this.gasto.set({ folio: g.folio, beneficiario: g.beneficiario, importe: Number(g.importe) || 0,
      sucursal: g.sucursal, solicitante: g.solicitante, fecha: g.fecha, concepto: g.concepto });
    this.sel = null;
  }

  reset() {
    this.gasto.set(null); this.clearPhoto(); this.clearFile('solicitud_kepler'); this.sel = null; this.comentarios = '';
    this.clasificacion.set(null); this.clasificacionV = null; this.formError.set('');
  }

  onFile(ev: Event, role: string) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.handle(file, role);
  }
  over(e: DragEvent) { e.preventDefault(); e.stopPropagation(); if (!this.drag()) this.drag.set(true); }
  leave(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.drag.set(false); }
  drop(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.drag.set(false); const f = e.dataTransfer?.files?.[0]; if (f) this.handle(f, 'comprobante_1'); }
  overSol(e: DragEvent) { e.preventDefault(); e.stopPropagation(); if (!this.dragSol()) this.dragSol.set(true); }
  leaveSol(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.dragSol.set(false); }
  dropSol(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.dragSol.set(false); const f = e.dataTransfer?.files?.[0]; if (f) this.handle(f, 'solicitud_kepler'); }
  /** Quita un archivo elegido por rol. El comprobante además limpia su lectura de visión. */
  clearFile(role: string) {
    delete this.fileData[role]; delete this.uploaded[role];
    this.names.update((m) => { const n = { ...m }; delete n[role]; return n; });
    if (role === 'comprobante_1') this.photoResult.set(null);
  }
  clearPhoto() { this.clearFile('comprobante_1'); }

  private handle(file: File, role: string) {
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri;
      delete this.uploaded[role];
      this.names.update((m) => ({ ...m, [role]: file.name }));
      if (role === 'comprobante_1') this.validate(dataUri);
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

  /** Roles de archivo a subir/incluir: la solicitud firmada SIEMPRE, más el comprobante
   *  cuando el gasto es comprobable. */
  private rolesActivos(): ProofFileRole[] {
    return ['solicitud_kepler', ...(this.llevaEvidencia() ? (['comprobante_1'] as ProofFileRole[]) : [])];
  }

  submit() {
    const g = this.gasto();
    if (!g) { this.formError.set('Elige el gasto.'); return; }
    if (!this.clasificacion()) { this.formError.set('Elige el tipo de gasto.'); return; }
    // La solicitud firmada va siempre — el backend la exige en los tres tipos.
    if (!this.fileData['solicitud_kepler'] && !this.uploaded['solicitud_kepler']) { this.formError.set('Sube la solicitud firmada.'); return; }
    if (this.llevaEvidencia()) {
      if (!this.fileData['comprobante_1'] && !this.uploaded['comprobante_1']) { this.formError.set('Sube la evidencia.'); return; }
      if (this.photoLoading()) { this.formError.set('Espera a que termine de leerse la foto…'); return; }
    } else if (!this.comentarios.trim()) {
      this.formError.set('Escribe por qué no se puede comprobar.'); return;
    }
    this.formError.set('');
    this.saving.set(true);

    const toUpload = this.rolesActivos().filter((r) => this.fileData[r] && !this.uploaded[r]);
    if (!toUpload.length) { this.create(); return; }
    const ups = toUpload.map((r) => this.svc.uploadFile(this.fileData[r], r).pipe(
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
    const lleva = this.llevaEvidencia();
    const pr = lleva ? this.photoResult() : null;
    const files = this.rolesActivos().map((r) => this.uploaded[r]).filter(Boolean) as ProofFile[];
    this.svc.create({
      folio_solicitud: g.folio, sucursal: g.sucursal || undefined,
      solicitante: g.solicitante || undefined, proveedor: g.beneficiario || undefined,
      fecha_gasto: g.fecha ? String(g.fecha).slice(0, 10) : undefined, importe: g.importe || undefined,
      clasificacion: this.clasificacion()!,
      // No comprobable: el motivo ES el comentario (obligatorio). Comprobable: nota opcional.
      comentarios: this.comentarios || (lleva ? g.concepto || undefined : undefined), files,
      monto_ocr: pr?.monto_ocr ?? pr?.total ?? undefined, subtotal_ocr: pr?.subtotal ?? undefined,
      receipt_legible: pr ? pr.ocr_status === 'ok' : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Enviado', detail: `Solicitud ${g.folio} · pendiente de revisión` }); this.uploaded = {}; this.reset(); this.loadMine(); },
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
