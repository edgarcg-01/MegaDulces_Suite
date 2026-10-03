import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import type { Observable } from 'rxjs';
import type { SdAgentDto, SdAttachmentInput, SdPriority, SdRequestDetail, SdStatus } from '@megadulces/contracts';
import { SD_PRIORITIES } from '@megadulces/contracts';
import { PRIORITY_LABEL, STATUS_LABEL, IMPACT_LABEL, ServiceDeskService, sdError, slaTexto } from './service-desk.service';

/** Máximo de archivos por envío: el mismo tope que el servidor (`MAX_ADJUNTOS_POR_ENVIO`). */
export const MAX_ARCHIVOS = 5;
const TIPOS_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;

/**
 * Qué estados le OFRECE la pantalla a quien atiende desde cada estado. Es sólo la oferta del menú:
 * **quien decide es el servidor** (`domain/request-state.ts`, con 111 pruebas) y un salto que no
 * corresponde vuelve como 409 con su razón. Está acá porque ese módulo vive en `libs/service-desk`,
 * que una app Angular no puede importar; si la máquina cambia, esta lista se queda corta o larga
 * pero NUNCA permite lo que el servidor niega. Deuda declarada en el tracker (MS.3).
 */
const OFERTA_AGENTE: Readonly<Record<SdStatus, readonly SdStatus[]>> = {
  nuevo: [],
  asignado: ['en_proceso', 'en_espera'],
  en_proceso: ['en_espera', 'resuelto'],
  en_espera: ['en_proceso', 'resuelto'],
  resuelto: ['en_proceso'],
  cerrado: [],
  cancelado: [],
};

/** Lee un archivo como `data:<tipo>;base64,<...>`: el formato que el servidor valida por firma. */
function leerComoDataUri(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(`No se pudo leer ${f.name}`));
    r.readAsDataURL(f);
  });
}

/**
 * `[MS.3.3]` Ficha de una solicitud: encabezado, descripción, evidencia, hilo y acciones.
 *
 * Una sola ficha para los dos oficios — quien reporta (`agent = false`) y quien atiende
 * (`agent = true`) — porque ven el MISMO ticket y sólo cambian las acciones. Lo que el solicitante
 * NO debe ver (notas internas, tiempo registrado) ya viene filtrado del servidor: acá no se
 * esconde nada con CSS, simplemente no llega.
 */
@Component({
  selector: 'app-sd-request-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule, TextareaModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading() && !r()) { <p class="sd-hint">Cargando…</p> }
    @if (loadError(); as e) { <p class="sd-banner bad" role="alert">{{ e }}</p> }
    @if (r(); as t) {
      <div class="sd-d">
        <div class="sd-d-head">
          <div>
            <span class="sd-mono">{{ t.folio }}</span>
            <h2>{{ t.title }}</h2>
          </div>
          <p-button icon="pi pi-times" [text]="true" severity="secondary" ariaLabel="Cerrar ficha" (onClick)="cerrar.emit()" />
        </div>

        <div class="sd-badges">
          <span class="sd-st" [attr.data-s]="t.status">{{ statusLabel[t.status] }}</span>
          <span class="sd-pri" [attr.data-p]="t.priority">{{ priorityLabel[t.priority] }}</span>
          @if (sla().texto !== '—') { <span class="sd-sla" [attr.data-t]="sla().tono">{{ sla().texto }}</span> }
        </div>

        @if (notice(); as n) { <p class="sd-banner ok" role="status">{{ n }}</p> }
        @if (error(); as e) { <p class="sd-banner bad" role="alert">{{ e }}</p> }

        <dl class="sd-meta">
          <div><dt>Reportó</dt><dd>{{ t.requester_name || '—' }}</dd></div>
          <div><dt>Atiende</dt><dd>{{ t.assigned_to_name || 'Sin asignar' }}</dd></div>
          <div><dt>Cola</dt><dd>{{ t.queue_name }} · {{ t.category_name }}</dd></div>
          <div><dt>Afecta</dt><dd>{{ impactLabel[t.impact] }}{{ t.blocks_work ? ' · me bloquea el trabajo' : '' }}</dd></div>
          @if (t.warehouse_name) { <div><dt>Sucursal</dt><dd>{{ t.warehouse_name }}</dd></div> }
          <div><dt>Alta</dt><dd>{{ t.created_at | date:'dd/MM/yy HH:mm' }}</dd></div>
          @if (agent() && t.priority_suggested && t.priority_suggested !== t.priority) {
            <div><dt>Sugerida</dt><dd>{{ priorityLabel[t.priority_suggested] }}</dd></div>
          }
          @if (agent() && t.time_logged_minutes !== null) { <div><dt>Tiempo</dt><dd>{{ horas(t.time_logged_minutes) }}</dd></div> }
          @if (t.reopened_count) { <div><dt>Reaperturas</dt><dd>{{ t.reopened_count }}</dd></div> }
        </dl>

        @if (t.description) { <p class="sd-desc">{{ t.description }}</p> }

        @if (t.resolution_note && (t.status === 'resuelto' || t.status === 'cerrado')) {
          <p class="sd-resol"><b>Resolución:</b> {{ t.resolution_note }}</p>
        }

        @if (t.attachments.length) {
          <ul class="sd-files" aria-label="Evidencia">
            @for (a of t.attachments; track a.id) {
              <li>
                @if (a.content_type.startsWith('image/') && a.url) { <img class="sd-thumb" [src]="a.url" [alt]="a.file_name" loading="lazy" /> }
                @else { <i class="pi pi-file-pdf sd-thumb sd-thumb-i" aria-hidden="true"></i> }
                <span class="sd-file-meta">
                  @if (a.url) { <a [href]="a.url" target="_blank" rel="noopener">{{ a.file_name }}</a> } @else { <span>{{ a.file_name }}</span> }
                  <small>{{ tam(a.size_bytes) }}</small>
                </span>
              </li>
            }
          </ul>
        }

        <!-- ═══ Acciones ═══ -->
        @if (!esFinal()) {
          <div class="sd-actions" role="group" aria-label="Acciones">
            @if (agent()) {
              @if (t.status === 'nuevo') {
                <p-button icon="pi pi-user" label="Tomar" size="small" [loading]="busy()" (onClick)="tomar()" />
              }
              @for (s of oferta(); track s) {
                <p-button [label]="accionLabel(s)" size="small" severity="secondary" [outlined]="true" [loading]="busy()" (onClick)="pedirEstado(s)" />
              }
              @if (coord() && t.status !== 'resuelto') {
                <p-select [options]="agentes()" optionLabel="etiqueta" optionValue="user_id" [ngModel]="asignarA()"
                          (ngModelChange)="asignarA.set($event)" placeholder="Asignar a…" [showClear]="true" appendTo="body" ariaLabel="Asignar a" />
                @if (asignarA()) { <p-button label="Asignar" size="small" [loading]="busy()" (onClick)="asignar()" /> }
              }
              <p-select [options]="prioridades" optionLabel="label" optionValue="value" [ngModel]="nuevaPrio()"
                        (ngModelChange)="nuevaPrio.set($event)" placeholder="Cambiar prioridad…" appendTo="body" ariaLabel="Cambiar prioridad" />
              @if (nuevaPrio() && nuevaPrio() !== t.priority) { <p-button label="Aplicar prioridad" size="small" [loading]="busy()" (onClick)="cambiarPrioridad()" /> }
            } @else {
              @if (t.status === 'resuelto') {
                <p-button icon="pi pi-check" label="Ya quedó, cerrar" size="small" [loading]="busy()" (onClick)="confirmar()" />
                <p-button icon="pi pi-replay" label="Sigue fallando" size="small" severity="secondary" [outlined]="true" (onClick)="modo.set('reabrir')" />
              }
              @if (puedeCancelar()) {
                <p-button icon="pi pi-ban" label="Cancelar solicitud" size="small" severity="danger" [text]="true" (onClick)="modo.set('cancelar')" />
              }
            }
          </div>

          @if (modo(); as m) {
            <div class="sd-modo" role="group" [attr.aria-label]="tituloModo()">
              <label class="sd-field">
                <span>{{ tituloModo() }}{{ nota_obligatoria() ? ' *' : '' }}</span>
                <textarea pTextarea rows="3" [ngModel]="notaModo()" (ngModelChange)="notaModo.set($event)" [placeholder]="placeholderModo()"></textarea>
              </label>
              <div class="sd-modo-foot">
                <p-button label="Confirmar" size="small" [loading]="busy()" [disabled]="nota_obligatoria() && !notaModo().trim()" (onClick)="ejecutarModo()" />
                <p-button label="Volver" size="small" [text]="true" severity="secondary" (onClick)="cerrarModo()" />
              </div>
            </div>
          }

          @if (agent()) {
            <details class="sd-tiempo">
              <summary>Registrar tiempo trabajado</summary>
              <div class="sd-tiempo-body">
                <input pInputText type="number" min="1" max="1440" [ngModel]="minutos()" (ngModelChange)="minutos.set($event)" placeholder="Minutos" aria-label="Minutos trabajados" />
                <input pInputText [ngModel]="notaTiempo()" (ngModelChange)="notaTiempo.set($event)" placeholder="Qué hiciste (opcional)" aria-label="Nota del tiempo" />
                <p-button label="Registrar" size="small" severity="secondary" [outlined]="true" [loading]="busy()" [disabled]="!minutos()" (onClick)="registrarTiempo()" />
              </div>
            </details>
          }
        }

        <!-- ═══ Hilo ═══ -->
        <section class="sd-hilo" aria-label="Seguimiento">
          <h3>Seguimiento</h3>
          <ul class="sd-tl">
            @for (m of t.messages; track m.id) {
              <li class="sd-msg" [attr.data-k]="m.kind" [class.interna]="m.visibility === 'internal'">
                <span class="sd-msg-ic" aria-hidden="true"><i [class]="iconoMsg(m.kind)"></i></span>
                <span class="sd-msg-body">
                  <span class="sd-msg-head">
                    <b>{{ m.author_label || 'Sistema' }}</b>
                    @if (m.visibility === 'internal') { <em class="sd-int">Nota interna</em> }
                    <time>{{ m.created_at | date:'dd/MM HH:mm' }}</time>
                  </span>
                  @if (textoMsg(m); as tx) { <span class="sd-msg-tx">{{ tx }}</span> }
                </span>
              </li>
            }
          </ul>

          @if (!esFinal()) {
            <div class="sd-comp">
              <textarea pTextarea rows="3" [ngModel]="texto()" (ngModelChange)="texto.set($event)" [placeholder]="agent() ? 'Escribe una respuesta o una nota…' : 'Escribe un mensaje…'" aria-label="Mensaje"></textarea>
              @if (archivos().length) {
                <ul class="sd-pend">
                  @for (f of archivos(); track f.name + f.size) {
                    <li><i class="pi pi-paperclip" aria-hidden="true"></i> {{ f.name }} <small>{{ tam(f.size) }}</small>
                      <p-button icon="pi pi-times" [text]="true" size="small" severity="secondary" [ariaLabel]="'Quitar ' + f.name" (onClick)="quitarArchivo(f)" /></li>
                  }
                </ul>
              }
              <div class="sd-comp-foot">
                <p-button icon="pi pi-paperclip" label="Adjuntar" size="small" severity="secondary" [outlined]="true" (onClick)="selector.click()" />
                <input #selector type="file" hidden multiple accept="image/*,application/pdf" (change)="elegir($event)" />
                @if (agent()) {
                  <label class="sd-chk"><input type="checkbox" [ngModel]="interna()" (ngModelChange)="interna.set($event)" /> Nota interna (no la ve quien reportó)</label>
                }
                <span class="sd-sp"></span>
                <p-button [label]="interna() ? 'Guardar nota' : 'Enviar'" size="small" [loading]="busy()"
                          [disabled]="!texto().trim() || (interna() && archivos().length > 0)" (onClick)="enviar()" />
              </div>
              @if (interna() && archivos().length) { <small class="sd-hint">Las notas internas no admiten archivos.</small> }
            </div>
          }
        </section>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .sd-d { display: flex; flex-direction: column; gap: var(--sp-3); }
    .sd-d-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .sd-d-head h2 { margin: 2px 0 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); overflow-wrap: anywhere; }
    .sd-mono { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .sd-badges { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .sd-st, .sd-pri, .sd-sla { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; }
    .sd-st { background: var(--surface-2); color: var(--text-muted); }
    .sd-st[data-s='asignado'], .sd-st[data-s='en_proceso'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .sd-st[data-s='en_espera'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .sd-st[data-s='resuelto'], .sd-st[data-s='cerrado'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .sd-st[data-s='cancelado'] { color: var(--text-faint); text-decoration: line-through; }
    .sd-pri { color: var(--text-muted); }
    .sd-pri[data-p='alta'] { color: var(--warn-fg); background: var(--warn-soft-bg); }
    .sd-pri[data-p='urgente'] { color: var(--bad-fg); background: var(--bad-soft-bg); font-weight: 600; }
    .sd-sla { background: var(--surface-2); color: var(--text-muted); }
    .sd-sla[data-t='warn'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .sd-sla[data-t='bad'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .sd-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .sd-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sd-banner.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .sd-hint { color: var(--text-muted); font-size: var(--fs-xs); }
    .sd-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2) var(--sp-4); margin: 0; }
    .sd-meta div { display: flex; flex-direction: column; min-width: 0; }
    .sd-meta dt { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
    .sd-meta dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); overflow-wrap: anywhere; }
    .sd-desc, .sd-resol { margin: 0; white-space: pre-wrap; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-main); overflow-wrap: anywhere; }
    .sd-resol { padding: var(--sp-2) var(--sp-3); background: var(--ok-soft-bg); color: var(--ok-soft-fg); border-radius: var(--r-sm); }
    .sd-files { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .sd-files li { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); max-width: 100%; }
    .sd-thumb { width: 44px; height: 44px; object-fit: cover; border-radius: var(--r-sm); flex: none; }
    .sd-thumb-i { display: grid; place-items: center; background: var(--surface-2); color: var(--text-muted); font-size: 1.1rem; }
    .sd-file-meta { display: flex; flex-direction: column; min-width: 0; }
    .sd-file-meta a { color: var(--action); font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sd-file-meta small { color: var(--text-muted); font-size: var(--fs-xs); }
    .sd-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .sd-modo { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-2); }
    .sd-modo-foot { display: flex; gap: var(--sp-2); }
    .sd-field { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .sd-field > span { font-weight: 600; font-size: var(--fs-xs); color: var(--text-main); }
    .sd-field textarea, .sd-comp textarea { width: 100%; resize: vertical; font-size: var(--fs-sm); }
    .sd-tiempo { font-size: var(--fs-sm); color: var(--text-muted); }
    .sd-tiempo summary { cursor: pointer; font-weight: 600; font-size: var(--fs-xs); }
    .sd-tiempo-body { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
    .sd-tiempo-body input[type='number'] { width: 110px; }
    .sd-tiempo-body input:not([type='number']) { flex: 1 1 200px; }
    .sd-hilo { display: flex; flex-direction: column; gap: var(--sp-3); border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
    .sd-hilo h3 { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .sd-tl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .sd-msg { display: flex; gap: var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .sd-msg:last-child { border-bottom: 0; }
    .sd-msg.interna { background: var(--warn-soft-bg); margin: 0 calc(-1 * var(--sp-2)); padding-inline: var(--sp-2); border-radius: var(--r-sm); }
    .sd-msg-ic { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 50%; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-xs); }
    .sd-msg[data-k='comment'] .sd-msg-ic { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .sd-msg-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .sd-msg-head { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .sd-msg-head b { color: var(--text-main); }
    .sd-msg-head time { margin-left: auto; font-family: var(--font-mono); }
    .sd-int { font-style: normal; font-weight: 600; color: var(--warn-fg); }
    .sd-msg-tx { white-space: pre-wrap; font-size: var(--fs-sm); color: var(--text-main); line-height: 1.45; overflow-wrap: anywhere; }
    .sd-msg[data-k='status'] .sd-msg-tx, .sd-msg[data-k='assignment'] .sd-msg-tx, .sd-msg[data-k='priority'] .sd-msg-tx, .sd-msg[data-k='system'] .sd-msg-tx { color: var(--text-muted); font-size: var(--fs-xs); }
    .sd-comp { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-2); }
    .sd-comp-foot { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .sd-sp { flex: 1; }
    .sd-chk { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .sd-pend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-xs); color: var(--text-muted); }
    .sd-pend li { display: flex; align-items: center; gap: var(--sp-1); }
    @media (max-width: 40rem) {
      .sd-meta { grid-template-columns: 1fr; }
      .sd-actions p-button ::ng-deep button, .sd-comp-foot p-button ::ng-deep button { min-height: 40px; }
      .sd-actions p-select { flex: 1 1 100%; }
    }
  `],
})
export class SdRequestDetailComponent {
  private readonly api = inject(ServiceDeskService);

  /** Id del ticket a mostrar. */
  readonly id = input.required<string>();
  /** `true` = quien atiende; `false` = quien reportó. Cambia las acciones, no los datos. */
  readonly agent = input(false);
  /** `true` = además puede reasignar. */
  readonly coord = input(false);
  /** Avisa al padre que el ticket cambió (para refrescar su lista). */
  readonly cambio = output<SdRequestDetail>();
  readonly cerrar = output<void>();

  readonly statusLabel = STATUS_LABEL;
  readonly priorityLabel = PRIORITY_LABEL;
  readonly impactLabel = IMPACT_LABEL;
  readonly prioridades = SD_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));

  readonly r = signal<SdRequestDetail | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly texto = signal('');
  readonly interna = signal(false);
  readonly archivos = signal<File[]>([]);

  readonly modo = signal<'reabrir' | 'cancelar' | 'resolver' | 'espera' | null>(null);
  readonly notaModo = signal('');
  private readonly estadoPendiente = signal<SdStatus | null>(null);

  readonly asignarA = signal<string | null>(null);
  readonly nuevaPrio = signal<SdPriority | null>(null);
  readonly minutos = signal<number | null>(null);
  readonly notaTiempo = signal('');
  private readonly agentesRaw = signal<SdAgentDto[]>([]);
  readonly agentes = computed(() => this.agentesRaw().map((a) => ({ ...a, etiqueta: `${a.name || a.username} (${a.open_count})` })));

  readonly sla = computed(() => { const t = this.r(); return t ? slaTexto(t.sla, t.status) : { texto: '—', tono: 'mute' as const }; });
  readonly esFinal = computed(() => { const s = this.r()?.status; return s === 'cerrado' || s === 'cancelado'; });
  readonly oferta = computed<SdStatus[]>(() => {
    const s = this.r()?.status;
    return s ? [...OFERTA_AGENTE[s]] : [];
  });
  /** El solicitante puede cancelar mientras nadie esté trabajando el ticket. */
  readonly puedeCancelar = computed(() => ['nuevo', 'asignado', 'en_espera'].includes(this.r()?.status ?? ''));

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.cargar(id));
    });
    effect(() => {
      if (this.agent() && this.coord()) untracked(() => {
        if (!this.agentesRaw().length) this.api.agents().subscribe({ next: (a) => this.agentesRaw.set(a), error: () => undefined });
      });
    });
  }

  private cargar(id: string): void {
    this.r.set(null);
    this.loadError.set(null);
    this.error.set(null);
    this.notice.set(null);
    this.cerrarModo();
    this.loading.set(true);
    this.api.detail(id).subscribe({
      next: (t) => { this.r.set(t); this.loading.set(false); },
      error: (e) => { this.loadError.set(sdError(e, 'No se pudo abrir la solicitud.')); this.loading.set(false); },
    });
  }

  /** Aplica la respuesta de una acción: refresca la ficha, avisa al padre y deja un mensaje. */
  private ejecutar(op: Observable<SdRequestDetail>, ok: string, alExito?: () => void): void {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    op.subscribe({
      next: (t) => {
        this.r.set(t);
        this.busy.set(false);
        this.notice.set(ok);
        alExito?.();
        this.cambio.emit(t);
      },
      error: (e) => { this.busy.set(false); this.error.set(sdError(e, 'No se pudo completar la acción.')); },
    });
  }

  // ── acciones ──
  tomar(): void { this.ejecutar(this.api.take(this.id()), 'Quedó asignada a ti.'); }
  confirmar(): void { this.ejecutar(this.api.confirm(this.id()), 'Solicitud cerrada. Gracias por confirmar.'); }
  asignar(): void {
    const u = this.asignarA();
    if (u) this.ejecutar(this.api.assign(this.id(), { user_id: u }), 'Solicitud asignada.', () => this.asignarA.set(null));
  }
  cambiarPrioridad(): void {
    const p = this.nuevaPrio();
    if (p) this.ejecutar(this.api.priority(this.id(), { priority: p }), 'Prioridad actualizada; los plazos se recalcularon.', () => this.nuevaPrio.set(null));
  }
  registrarTiempo(): void {
    const m = Number(this.minutos());
    this.ejecutar(this.api.logTime(this.id(), { minutes: m, note: this.notaTiempo().trim() || undefined }), 'Tiempo registrado.', () => { this.minutos.set(null); this.notaTiempo.set(''); });
  }

  /** `resuelto` exige decir cómo se resolvió; `en_espera` pide el motivo (qué se espera y de quién). */
  pedirEstado(s: SdStatus): void {
    const t = this.r();
    if (!t) return;
    this.estadoPendiente.set(s);
    if (s === 'resuelto') this.modo.set('resolver');
    else if (s === 'en_espera') this.modo.set('espera');
    else if (t.status === 'resuelto' && s === 'en_proceso') this.modo.set('reabrir');
    else this.ejecutar(this.api.status(this.id(), { status: s }), `Estado: ${STATUS_LABEL[s]}.`);
  }
  accionLabel(s: SdStatus): string {
    return ({ en_proceso: this.r()?.status === 'resuelto' ? 'Reabrir' : 'Iniciar', en_espera: 'Poner en espera', resuelto: 'Marcar resuelta' } as Partial<Record<SdStatus, string>>)[s] ?? STATUS_LABEL[s];
  }

  readonly tituloModo = computed(() => ({ reabrir: '¿Qué sigue sin funcionar?', cancelar: 'Motivo de la cancelación', resolver: 'Cómo se resolvió', espera: 'Qué se espera y de quién' } as const)[this.modo() ?? 'cancelar']);
  readonly placeholderModo = computed(() => ({ reabrir: 'Cuéntanos qué pasa todavía', cancelar: 'Opcional', resolver: 'Describe la solución para que quede registrada', espera: 'Opcional, pero ayuda a quien reportó' } as const)[this.modo() ?? 'cancelar']);
  /** Reabrir y resolver exigen nota: el servidor también lo exige, esto evita el viaje. */
  readonly nota_obligatoria = computed(() => this.modo() === 'reabrir' || this.modo() === 'resolver');

  cerrarModo(): void { this.modo.set(null); this.notaModo.set(''); this.estadoPendiente.set(null); }
  ejecutarModo(): void {
    const m = this.modo();
    const nota = this.notaModo().trim();
    if (!m) return;
    const id = this.id();
    const fin = () => this.cerrarModo();
    if (m === 'cancelar') return this.ejecutar(this.api.cancel(id, nota || undefined), 'Solicitud cancelada.', fin);
    if (m === 'reabrir' && !this.agent()) return this.ejecutar(this.api.reopen(id, nota), 'Solicitud reabierta.', fin);
    const destino = this.estadoPendiente() ?? (m === 'resolver' ? 'resuelto' : m === 'espera' ? 'en_espera' : 'en_proceso');
    this.ejecutar(this.api.status(id, { status: destino, note: nota || undefined }), `Estado: ${STATUS_LABEL[destino]}.`, fin);
  }

  // ── hilo ──
  enviar(): void {
    const body = this.texto().trim();
    if (!body) return;
    const files = this.archivos();
    this.busy.set(true);
    this.error.set(null);
    Promise.all(files.map(async (f): Promise<SdAttachmentInput> => ({ file_base64: await leerComoDataUri(f), file_name: f.name })))
      .then((attachments) => {
        this.ejecutar(
          this.api.message(this.id(), { body, visibility: this.interna() ? 'internal' : 'public', attachments: attachments.length ? attachments : undefined }),
          this.interna() ? 'Nota guardada.' : 'Mensaje enviado.',
          () => { this.texto.set(''); this.archivos.set([]); },
        );
      })
      .catch((e) => { this.busy.set(false); this.error.set(sdError(e, 'No se pudo leer un archivo.')); });
  }

  elegir(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const nuevos = Array.from(input.files ?? []);
    input.value = '';
    const malos = nuevos.filter((f) => !TIPOS_OK.test(f.type));
    if (malos.length) { this.error.set(`Sólo se aceptan fotos y PDF: ${malos.map((f) => f.name).join(', ')}.`); }
    const buenos = nuevos.filter((f) => TIPOS_OK.test(f.type));
    const todos = [...this.archivos(), ...buenos];
    if (todos.length > MAX_ARCHIVOS) this.error.set(`Máximo ${MAX_ARCHIVOS} archivos por envío.`);
    this.archivos.set(todos.slice(0, MAX_ARCHIVOS));
  }
  quitarArchivo(f: File): void { this.archivos.update((a) => a.filter((x) => x !== f)); }

  // ── presentación ──
  /** El texto de cada renglón del hilo. Los cambios de estado/asignación/prioridad se leen como frase. */
  textoMsg(m: SdRequestDetail['messages'][number]): string {
    const meta = m.meta as { from?: string | null; to?: string | null; to_name?: string | null };
    if (m.kind === 'status') {
      const cambio = `${STATUS_LABEL[meta.from as SdStatus] ?? meta.from ?? ''} → ${STATUS_LABEL[meta.to as SdStatus] ?? meta.to ?? ''}`;
      return m.body ? `${cambio} · ${m.body}` : cambio;
    }
    if (m.kind === 'assignment') return `Asignada a ${meta.to_name || 'otra persona'}`;
    if (m.kind === 'priority') {
      const cambio = `Prioridad: ${PRIORITY_LABEL[meta.from as SdPriority] ?? meta.from} → ${PRIORITY_LABEL[meta.to as SdPriority] ?? meta.to}`;
      return m.body ? `${cambio} · ${m.body}` : cambio;
    }
    return m.body;
  }
  iconoMsg(kind: string): string {
    return ({ comment: 'pi pi-comment', internal_note: 'pi pi-lock', status: 'pi pi-sync', assignment: 'pi pi-user', priority: 'pi pi-flag', system: 'pi pi-info-circle' } as Record<string, string>)[kind] ?? 'pi pi-circle';
  }
  tam(b: number): string { return b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`; }
  horas(min: number): string { return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim(); }
}
