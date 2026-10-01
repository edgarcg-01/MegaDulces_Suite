import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import {
  DevProjectsService, PRIORITY_LABEL, STATUS_LABEL,
  type AttachmentSource, type DevProject, type DevProjectAttachment, type DevProjectDetail,
  type DevProjectInput, type DevProjectPriority, type DevProjectStatus, type DevTeamMember,
} from '../dev-projects.service';
import { DictationController, browserRecognitionFactory, type RecognitionFactory } from '../dictation';
import { MediaCaptureComponent, type CaptureMode, type CapturedMedia } from '../media-capture.component';

/** Un archivo elegido que todavía no se sube (alta nueva) o que se está subiendo. */
export interface PendingFile {
  key: string;
  blob: Blob;
  fileName: string;
  source: AttachmentSource;
  progress: number | null;
  error: string | null;
  previewUrl: string | null;
}

export interface ProjectForm {
  title: string;
  objective: string;
  priority: DevProjectPriority;
  status: DevProjectStatus;
  assignee_user_id: string | null;
  due_date: string;
}

export const emptyForm = (): ProjectForm => ({
  title: '', objective: '', priority: 'media', status: 'nuevo', assignee_user_id: null, due_date: '',
});

/** Lo que cambió respecto del proyecto guardado: un PATCH sólo con eso. */
export function diffForm(saved: DevProjectDetail, f: ProjectForm): DevProjectInput {
  const out: DevProjectInput = {};
  if (f.title.trim() !== saved.title) out.title = f.title.trim();
  if ((f.objective.trim() || null) !== (saved.objective ?? null)) out.objective = f.objective.trim() || null;
  if (f.priority !== saved.priority) out.priority = f.priority;
  if (f.status !== saved.status) out.status = f.status;
  if ((f.assignee_user_id ?? null) !== (saved.assignee_user_id ?? null)) out.assignee_user_id = f.assignee_user_id ?? null;
  if ((f.due_date || null) !== (saved.due_date ?? null)) out.due_date = f.due_date || null;
  return out;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function apiError(e: unknown, fallback: string): string {
  if (e instanceof HttpErrorResponse) {
    const m = (e.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(m)) return m.join(' · ');
    if (typeof m === 'string' && m) return m;
    if (e.status === 413) return 'El archivo es demasiado grande para el servidor.';
    if (e.status === 403) return 'Tu rol no tiene permiso para esta acción.';
    if (e.status === 0) return 'Sin conexión con el servidor.';
  }
  return fallback;
}

const KIND_ICON: Record<string, string> = {
  imagen: 'pi pi-image', video: 'pi pi-video', audio: 'pi pi-volume-up', documento: 'pi pi-file',
};

/**
 * `[DEV.8]` Desarrolladores › Proyectos (`/desarrolladores/proyectos`).
 *
 * La bitácora del equipo: cada idea de proyecto se da de alta como una ORDEN (folio, nombre,
 * objetivo, responsable) para que no se pierda en una plática. El objetivo se escribe o se
 * dicta, y se documenta con evidencia: cualquier archivo, una foto o un video tomados ahí mismo.
 *
 * Operations (DESIGN.md): tabla densa a la izquierda, ficha a la derecha. En una alta nueva los
 * archivos se juntan en la ficha y se suben al guardar (el proyecto todavía no tiene folio al que
 * colgarlos); en un proyecto existente se suben en cuanto se eligen.
 */
@Component({
  selector: 'app-dev-proyectos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, DialogModule, InputTextModule, TextareaModule, MediaCaptureComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dp-page">
      <header class="dp-head">
        <div>
          <h1>Proyectos</h1>
          <p>La bitácora del equipo de desarrollo: cada idea se da de alta como una orden, con su objetivo y su evidencia.</p>
        </div>
        @if (canManage()) {
          <p-button icon="pi pi-plus" label="Nuevo proyecto" (onClick)="nuevo()" />
        }
      </header>

      <section class="dp-counts" aria-label="Proyectos por estado">
        <button type="button" class="dp-chip" [class.on]="!fStatus()" (click)="setStatus('')">
          Todos <b>{{ projects().length }}</b>
        </button>
        @for (s of statuses; track s.value) {
          <button type="button" class="dp-chip" [class.on]="fStatus() === s.value" (click)="setStatus(s.value)">
            {{ s.label }} <b>{{ countBy()[s.value] || 0 }}</b>
          </button>
        }
      </section>

      @if (loadError(); as e) {
        <p class="dp-banner bad" role="alert">{{ e }}</p>
      }

      <div class="dp-body" [class.has-detail]="panelOpen()">
        <section class="dp-list">
          <div class="dp-filters">
            <span class="dp-search">
              <i class="pi pi-search" aria-hidden="true"></i>
              <input pInputText type="search" placeholder="Buscar folio, nombre u objetivo"
                     [ngModel]="fSearch()" (ngModelChange)="fSearch.set($event)" aria-label="Buscar proyecto" />
            </span>
            <p-select [options]="assigneeFilterOptions()" optionLabel="label" optionValue="value"
                      [ngModel]="fAssignee()" (ngModelChange)="fAssignee.set($event)"
                      placeholder="Cualquier responsable" [showClear]="true" appendTo="body"
                      ariaLabel="Filtrar por responsable" />
          </div>

          <div class="dp-table-wrap">
            <table class="dp-table">
              <thead>
                <tr>
                  <th>Folio</th><th>Proyecto</th><th>Responsable</th><th>Prioridad</th><th>Estado</th>
                  <th class="num" title="Archivos adjuntos"><i class="pi pi-paperclip" aria-label="Adjuntos"></i></th>
                  <th>Alta</th>
                </tr>
              </thead>
              <tbody>
                @for (p of visible(); track p.id) {
                  <tr [class.sel]="selectedId() === p.id" (click)="abrir(p.id)" tabindex="0"
                      (keydown.enter)="abrir(p.id)">
                    <td class="mono">{{ p.folio }}</td>
                    <td class="title">{{ p.title }}</td>
                    <td>{{ p.assignee_name || '—' }}</td>
                    <td><span class="dp-pri" [attr.data-p]="p.priority">{{ priorityLabel[p.priority] }}</span></td>
                    <td><span class="dp-st" [attr.data-s]="p.status">{{ statusLabel[p.status] }}</span></td>
                    <td class="num">{{ p.attachments_count || '—' }}</td>
                    <td class="mono">{{ p.created_at | date:'dd/MM/yy' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="dp-empty">
                    @if (loading()) { Cargando… }
                    @else if (projects().length) { Ningún proyecto con estos filtros. }
                    @else { Todavía no hay proyectos. @if (canManage()) { Da de alta el primero con «Nuevo proyecto». } }
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (panelOpen()) {
          <section class="dp-detail" aria-label="Ficha del proyecto">
            <div class="dp-detail-head">
              <div>
                <span class="mono dp-folio">{{ current()?.folio || 'Folio al guardar' }}</span>
                <h2>{{ current() ? 'Proyecto' : 'Nuevo proyecto' }}</h2>
              </div>
              <p-button icon="pi pi-times" [text]="true" severity="secondary" ariaLabel="Cerrar ficha" (onClick)="cerrar()" />
            </div>

            @if (formError(); as e) { <p class="dp-banner bad" role="alert">{{ e }}</p> }
            @if (notice(); as n) { <p class="dp-banner ok" role="status">{{ n }}</p> }

            <label class="dp-field">
              <span>Nombre del proyecto <em>*</em></span>
              <input pInputText [(ngModel)]="form.title" maxlength="160" [disabled]="!canManage()"
                     placeholder="Ej. Portal de proveedores" />
            </label>

            <div class="dp-field">
              <div class="dp-obj-head">
                <span id="obj-label">Objetivo e instrucciones</span>
                @if (canManage()) {
                  @if (dictationSupported) {
                    <p-button [icon]="listening() ? 'pi pi-stop-circle' : 'pi pi-microphone'"
                              [label]="listening() ? 'Detener dictado' : 'Dictar'"
                              [severity]="listening() ? 'danger' : 'secondary'" [outlined]="!listening()" size="small"
                              (onClick)="toggleDictation()" />
                  } @else {
                    <span class="dp-hint">Dictado no disponible en este navegador (usa Chrome o Edge).</span>
                  }
                }
              </div>
              <textarea pTextarea #objective rows="9" [(ngModel)]="form.objective" [disabled]="!canManage()"
                        [readonly]="listening()" aria-labelledby="obj-label" class="dp-obj" [class.listening]="listening()"
                        placeholder="Qué se quiere lograr, para quién, y cómo se sabrá que quedó. Puedes escribir o dictar."></textarea>
              @if (listening()) {
                <span class="dp-hint live" aria-live="polite"><span class="dp-mic-dot"></span>Escuchando… di «nueva línea» para cambiar de renglón.</span>
              }
              @if (dictationError(); as d) { <span class="dp-hint bad">{{ d }}</span> }
            </div>

            <div class="dp-grid">
              <label class="dp-field">
                <span>Asignado a</span>
                <p-select [options]="team()" optionLabel="display_name" optionValue="user_id"
                          [(ngModel)]="form.assignee_user_id" placeholder="Sin asignar" [showClear]="true"
                          [disabled]="!canManage()" appendTo="body" ariaLabel="Responsable" />
              </label>
              <label class="dp-field">
                <span>Prioridad</span>
                <p-select [options]="priorities" optionLabel="label" optionValue="value" [(ngModel)]="form.priority"
                          [disabled]="!canManage()" appendTo="body" ariaLabel="Prioridad" />
              </label>
              <label class="dp-field">
                <span>Estado</span>
                <p-select [options]="statuses" optionLabel="label" optionValue="value" [(ngModel)]="form.status"
                          [disabled]="!canManage()" appendTo="body" ariaLabel="Estado" />
              </label>
              <label class="dp-field">
                <span>Fecha compromiso</span>
                <input pInputText type="date" [(ngModel)]="form.due_date" [disabled]="!canManage()" />
              </label>
            </div>

            <div class="dp-field">
              <span>Evidencia</span>
              @if (canManage()) {
                <div class="dp-attach-actions">
                  <p-button icon="pi pi-paperclip" label="Adjuntar archivos" severity="secondary" [outlined]="true" size="small"
                            (onClick)="fileInput.click()" />
                  <p-button icon="pi pi-camera" label="Tomar foto" severity="secondary" [outlined]="true" size="small"
                            (onClick)="abrirCaptura('foto')" />
                  <p-button icon="pi pi-video" label="Grabar video" severity="secondary" [outlined]="true" size="small"
                            (onClick)="abrirCaptura('video')" />
                  <input #fileInput type="file" multiple hidden (change)="onFiles($event, 'archivo')" />
                </div>
              }

              <ul class="dp-files">
                @for (a of current()?.attachments ?? []; track a.id) {
                  <li>
                    @if (a.kind === 'imagen' && a.url) {
                      <img class="dp-thumb" [src]="a.url" [alt]="a.file_name" loading="lazy" />
                    } @else {
                      <i [class]="kindIcon(a.kind) + ' dp-thumb-icon'" aria-hidden="true"></i>
                    }
                    <div class="dp-file-meta">
                      @if (a.url) { <a [href]="a.url" target="_blank" rel="noopener">{{ a.file_name }}</a> }
                      @else { <span>{{ a.file_name }}</span> }
                      <small>{{ size(a.size_bytes) }} · {{ sourceLabel(a.source) }} · {{ a.created_at | date:'dd/MM/yy HH:mm' }}</small>
                    </div>
                    @if (canManage()) {
                      <p-button icon="pi pi-trash" [text]="true" severity="danger" size="small"
                                [ariaLabel]="'Quitar ' + a.file_name" (onClick)="quitarAdjunto(a)" />
                    }
                  </li>
                }
                @for (f of pending(); track f.key) {
                  <li class="pending">
                    @if (f.previewUrl) { <img class="dp-thumb" [src]="f.previewUrl" [alt]="f.fileName" /> }
                    @else { <i class="pi pi-file dp-thumb-icon" aria-hidden="true"></i> }
                    <div class="dp-file-meta">
                      <span>{{ f.fileName }}</span>
                      <small>
                        {{ size(f.blob.size) }} ·
                        @if (f.error) { <b class="bad">{{ f.error }}</b> }
                        @else if (f.progress !== null) { subiendo {{ f.progress }}% }
                        @else { se sube al guardar }
                      </small>
                      @if (f.progress !== null && !f.error) { <span class="dp-bar"><span [style.width.%]="f.progress"></span></span> }
                    </div>
                    @if (f.progress === null || f.error) {
                      <p-button icon="pi pi-times" [text]="true" severity="secondary" size="small"
                                [ariaLabel]="'Descartar ' + f.fileName" (onClick)="descartar(f)" />
                    }
                  </li>
                }
                @if (!(current()?.attachments?.length) && !pending().length) {
                  <li class="dp-none">Sin archivos adjuntos.</li>
                }
              </ul>
            </div>

            @if (current(); as c) {
              <p class="dp-audit">Alta por {{ c.created_by_username || '—' }} el {{ c.created_at | date:'dd/MM/yyyy HH:mm' }}</p>
            }

            @if (canManage()) {
              <div class="dp-foot">
                @if (current()) {
                  <p-button icon="pi pi-trash" label="Eliminar" severity="danger" [text]="true" (onClick)="eliminar()" [disabled]="saving()" />
                }
                <span class="dp-spacer"></span>
                <p-button label="Cancelar" severity="secondary" [outlined]="true" (onClick)="cerrar()" [disabled]="saving()" />
                <p-button icon="pi pi-check" [label]="current() ? 'Guardar cambios' : 'Dar de alta'" (onClick)="guardar()"
                          [loading]="saving()" [disabled]="!form.title.trim()" />
              </div>
            }
          </section>
        }
      </div>
    </div>

    <p-dialog [header]="captureMode() === 'foto' ? 'Tomar foto' : 'Grabar video'" [visible]="captureMode() !== null"
              (visibleChange)="!$event && cerrarCaptura()" [modal]="true" [style]="{ width: 'min(640px, 96vw)' }"
              [draggable]="false" [closeOnEscape]="true">
      @if (captureMode(); as m) {
        <app-media-capture [mode]="m" (captured)="onCaptured($event)" (cancel)="cerrarCaptura()" />
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .dp-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .dp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .dp-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); }
    .dp-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }

    .dp-counts { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .dp-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted);
      border-radius: var(--r-pill); padding: 4px var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
    .dp-chip b { color: var(--text-main); margin-left: var(--sp-1); font-family: var(--font-mono); }
    .dp-chip.on { border-color: var(--action); color: var(--text-main); background: var(--surface-selected-bg); }
    .dp-chip:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    .dp-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .dp-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .dp-banner.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }

    .dp-body { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
    .dp-body.has-detail { grid-template-columns: minmax(0, 1.25fr) minmax(360px, 1fr); }
    @media (max-width: 1100px) { .dp-body.has-detail { grid-template-columns: 1fr; } }

    .dp-list, .dp-detail { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .dp-filters { display: flex; gap: var(--sp-2); padding: var(--sp-3); border-bottom: 1px solid var(--border-color); flex-wrap: wrap; }
    .dp-search { position: relative; flex: 1 1 220px; }
    .dp-search i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-faint); font-size: var(--fs-xs); }
    .dp-search input { width: 100%; padding-left: 30px; }
    .dp-table-wrap { overflow: auto; max-height: calc(100vh - 290px); }
    .dp-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .dp-table th { position: sticky; top: 0; background: var(--surface-2); text-align: left; font-weight: 600;
      color: var(--text-muted); font-size: var(--fs-xs); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .dp-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); }
    .dp-table tbody tr { cursor: pointer; }
    .dp-table tbody tr:hover { background: var(--surface-hover-bg); }
    .dp-table tbody tr.sel { background: var(--surface-selected-bg); }
    .dp-table tbody tr:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .dp-table .num { text-align: right; font-family: var(--font-mono); }
    .dp-table .title { font-weight: 600; }
    .mono { font-family: var(--font-mono); font-size: var(--fs-xs); white-space: nowrap; }
    .dp-empty { text-align: center; color: var(--text-muted); padding: var(--sp-6) !important; cursor: default; }

    .dp-pri, .dp-st { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; }
    .dp-pri { color: var(--text-muted); }
    .dp-pri[data-p='alta'] { color: var(--warn-fg); background: var(--warn-soft-bg); }
    .dp-pri[data-p='urgente'] { color: var(--bad-fg); background: var(--bad-soft-bg); font-weight: 600; }
    .dp-st { background: var(--surface-2); color: var(--text-muted); }
    .dp-st[data-s='en_progreso'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .dp-st[data-s='en_pausa'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .dp-st[data-s='terminado'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .dp-st[data-s='cancelado'] { color: var(--text-faint); text-decoration: line-through; }

    .dp-detail { padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); position: sticky; top: var(--sp-4); }
    .dp-detail-head { display: flex; justify-content: space-between; align-items: flex-start; }
    .dp-detail-head h2 { margin: 2px 0 0; font: 700 var(--fs-h3)/1.2 var(--font-body); color: var(--text-main); }
    .dp-folio { color: var(--text-muted); }
    .dp-field { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .dp-field > span:first-child, .dp-obj-head > span { font-weight: 600; color: var(--text-main); font-size: var(--fs-xs); }
    .dp-field em { color: var(--bad-fg); font-style: normal; }
    .dp-field input, .dp-field p-select { width: 100%; }
    .dp-obj-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); min-height: 32px; }
    .dp-obj { width: 100%; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
    .dp-obj.listening { border-color: var(--bad); box-shadow: 0 0 0 2px var(--bad-soft-bg); }
    .dp-hint { font-size: var(--fs-xs); color: var(--text-muted); }
    .dp-hint.bad, .bad { color: var(--bad-fg); }
    .dp-hint.live { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--bad-fg); }
    .dp-mic-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
    @media (prefers-reduced-motion: no-preference) { .dp-mic-dot { animation: dp-pulse 1.2s ease-in-out infinite; } }
    @keyframes dp-pulse { 50% { opacity: .25; } }
    .dp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }

    .dp-attach-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .dp-files { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .dp-files li { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .dp-files li.pending { border-style: dashed; }
    .dp-files li.dp-none { border: 0; padding: 0; color: var(--text-faint); font-size: var(--fs-xs); }
    .dp-thumb { width: 44px; height: 44px; object-fit: cover; border-radius: var(--r-sm); flex: none; }
    .dp-thumb-icon { width: 44px; height: 44px; display: grid; place-items: center; flex: none; border-radius: var(--r-sm);
      background: var(--surface-2); color: var(--text-muted); font-size: 1.1rem; }
    .dp-file-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 2px; }
    .dp-file-meta a, .dp-file-meta > span { color: var(--text-main); font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dp-file-meta a { color: var(--action); }
    .dp-file-meta small { color: var(--text-muted); font-size: var(--fs-xs); }
    .dp-bar { height: 4px; background: var(--surface-2); border-radius: var(--r-pill); overflow: hidden; }
    .dp-bar span { display: block; height: 100%; background: var(--action); }
    .dp-audit { margin: 0; color: var(--text-faint); font-size: var(--fs-xs); }
    .dp-foot { display: flex; align-items: center; gap: var(--sp-2); border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
    .dp-spacer { flex: 1; }
  `],
})
export class DevProyectosComponent implements OnInit {
  private readonly api = inject(DevProjectsService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly objectiveRef = viewChild<ElementRef<HTMLTextAreaElement>>('objective');

  /** Se sobreescribe en pruebas: el navegador real no tiene micrófono en CI. */
  protected recognitionFactory: RecognitionFactory = browserRecognitionFactory;

  readonly priorityLabel = PRIORITY_LABEL;
  readonly statusLabel = STATUS_LABEL;
  readonly priorities = (Object.keys(PRIORITY_LABEL) as DevProjectPriority[]).map((value) => ({ value, label: PRIORITY_LABEL[value] }));
  readonly statuses = (Object.keys(STATUS_LABEL) as DevProjectStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] }));

  readonly projects = signal<DevProject[]>([]);
  readonly team = signal<DevTeamMember[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly fStatus = signal<string>('');
  readonly fAssignee = signal<string | null>(null);
  readonly fSearch = signal('');

  readonly panelOpen = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly current = signal<DevProjectDetail | null>(null);
  readonly pending = signal<PendingFile[]>([]);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly captureMode = signal<CaptureMode | null>(null);

  readonly listening = signal(false);
  readonly dictationError = signal<string | null>(null);

  form: ProjectForm = emptyForm();

  readonly canManage = computed(() => this.perms.has(Permission.DEV_PROJECTS_GESTIONAR));

  readonly countBy = computed(() => {
    const out: Record<string, number> = {};
    for (const p of this.projects()) out[p.status] = (out[p.status] ?? 0) + 1;
    return out;
  });

  readonly assigneeFilterOptions = computed(() => [
    { value: 'sin_asignar', label: 'Sin asignar' },
    ...this.team().map((t) => ({ value: t.user_id, label: t.display_name })),
  ]);

  /** Los filtros corren en el cliente: es una bitácora de decenas de filas, no de miles. */
  readonly visible = computed(() => {
    const st = this.fStatus();
    const as = this.fAssignee();
    const q = this.fSearch().trim().toLowerCase();
    return this.projects().filter((p) => {
      if (st && p.status !== st) return false;
      if (as === 'sin_asignar' && p.assignee_user_id) return false;
      if (as && as !== 'sin_asignar' && p.assignee_user_id !== as) return false;
      if (q && !`${p.folio} ${p.title} ${p.objective ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  private dictation: DictationController | null = null;
  dictationSupported = false;
  private seq = 0;

  ngOnInit(): void {
    this.dictation = new DictationController(this.recognitionFactory, {
      onText: (t) => {
        this.form = { ...this.form, objective: t };
        // `form` es un objeto plano (ngModel): con OnPush hay que avisar que cambió.
        this.cdr.markForCheck();
        const ta = this.objectiveRef()?.nativeElement;
        if (ta) queueMicrotask(() => { ta.scrollTop = ta.scrollHeight; });
      },
      onState: (on) => this.listening.set(on),
      onError: (m) => this.dictationError.set(m),
    });
    this.dictationSupported = this.dictation.supported;
    this.destroyRef.onDestroy(() => {
      this.dictation?.stop();
      this.pending().forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    });
    void this.cargar();
  }

  async cargar(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const [team, list] = await Promise.all([firstValueFrom(this.api.team()), firstValueFrom(this.api.list())]);
      this.team.set(team);
      this.projects.set(list);
    } catch (e) {
      this.loadError.set(apiError(e, 'No se pudieron cargar los proyectos.'));
    } finally {
      this.loading.set(false);
    }
  }

  setStatus(s: string): void {
    this.fStatus.set(s);
  }

  nuevo(): void {
    this.stopDictation();
    this.clearPending();
    this.current.set(null);
    this.selectedId.set(null);
    this.form = emptyForm();
    this.formError.set(null);
    this.notice.set(null);
    this.panelOpen.set(true);
  }

  async abrir(id: string): Promise<void> {
    this.stopDictation();
    this.clearPending();
    this.selectedId.set(id);
    this.formError.set(null);
    this.notice.set(null);
    this.panelOpen.set(true);
    try {
      const d = await firstValueFrom(this.api.detail(id));
      this.setCurrent(d);
    } catch (e) {
      this.formError.set(apiError(e, 'No se pudo abrir el proyecto.'));
    }
  }

  cerrar(): void {
    this.stopDictation();
    this.clearPending();
    this.panelOpen.set(false);
    this.selectedId.set(null);
    this.current.set(null);
  }

  async guardar(): Promise<void> {
    if (!this.form.title.trim() || this.saving()) return;
    this.stopDictation();
    this.saving.set(true);
    this.formError.set(null);
    this.notice.set(null);
    try {
      const cur = this.current();
      let saved: DevProjectDetail;
      if (cur) {
        const patch = diffForm(cur, this.form);
        saved = Object.keys(patch).length ? await firstValueFrom(this.api.update(cur.id, patch)) : cur;
      } else {
        saved = await firstValueFrom(this.api.create({
          title: this.form.title.trim(),
          objective: this.form.objective.trim() || null,
          priority: this.form.priority,
          status: this.form.status,
          assignee_user_id: this.form.assignee_user_id,
          due_date: this.form.due_date || null,
        }));
      }
      this.setCurrent(saved);
      this.selectedId.set(saved.id);
      const fallidos = await this.subirPendientes(saved.id);
      if (fallidos === 0 && this.pending().length === 0) {
        this.notice.set(cur ? 'Cambios guardados.' : `Proyecto ${saved.folio} dado de alta.`);
      } else {
        this.formError.set(`El proyecto se guardó, pero ${fallidos} archivo(s) no se subieron. Reintenta con «Guardar cambios».`);
      }
      await this.refrescarLista();
    } catch (e) {
      this.formError.set(apiError(e, 'No se pudo guardar el proyecto.'));
    } finally {
      this.saving.set(false);
    }
  }

  async eliminar(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    if (!confirm(`¿Eliminar el proyecto ${cur.folio} «${cur.title}»?`)) return;
    try {
      await firstValueFrom(this.api.remove(cur.id));
      this.cerrar();
      await this.refrescarLista();
    } catch (e) {
      this.formError.set(apiError(e, 'No se pudo eliminar el proyecto.'));
    }
  }

  // ── Evidencia ────────────────────────────────────────────────────────────────────────────
  onFiles(ev: Event, source: AttachmentSource): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // permite volver a elegir el mismo archivo
    for (const f of files) this.agregar(f, f.name, source);
  }

  abrirCaptura(m: CaptureMode): void {
    this.captureMode.set(m);
  }

  cerrarCaptura(): void {
    this.captureMode.set(null);
  }

  onCaptured(c: CapturedMedia): void {
    this.captureMode.set(null);
    this.agregar(c.blob, c.fileName, c.source);
  }

  agregar(blob: Blob, fileName: string, source: AttachmentSource): void {
    const f: PendingFile = {
      key: `p${++this.seq}`, blob, fileName, source, progress: null, error: null,
      previewUrl: blob.type.startsWith('image/') ? URL.createObjectURL(blob) : null,
    };
    this.pending.update((l) => [...l, f]);
    // Con folio ya asignado no hay razón para esperar al «Guardar»: se sube de inmediato.
    const cur = this.current();
    if (cur) void this.subirUno(cur.id, f).then(() => this.refrescarLista());
  }

  descartar(f: PendingFile): void {
    if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    this.pending.update((l) => l.filter((x) => x.key !== f.key));
  }

  async quitarAdjunto(a: DevProjectAttachment): Promise<void> {
    const cur = this.current();
    if (!cur || !confirm(`¿Quitar «${a.file_name}» del proyecto?`)) return;
    try {
      await firstValueFrom(this.api.removeAttachment(cur.id, a.id));
      this.current.set({ ...cur, attachments: cur.attachments.filter((x) => x.id !== a.id) });
      await this.refrescarLista();
    } catch (e) {
      this.formError.set(apiError(e, 'No se pudo quitar el archivo.'));
    }
  }

  // ── Dictado ──────────────────────────────────────────────────────────────────────────────
  toggleDictation(): void {
    this.dictationError.set(null);
    if (this.listening()) this.stopDictation();
    else this.dictation?.start(this.form.objective);
  }

  private stopDictation(): void {
    if (this.listening()) this.dictation?.stop();
  }

  // ── Utilidades de plantilla ──────────────────────────────────────────────────────────────
  kindIcon(kind: string): string {
    return KIND_ICON[kind] ?? 'pi pi-file';
  }

  size(n: number): string {
    return humanSize(n);
  }

  sourceLabel(s: AttachmentSource): string {
    return s === 'camara' ? 'foto con cámara' : s === 'grabacion' ? 'video grabado' : 'archivo';
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────────
  private setCurrent(d: DevProjectDetail): void {
    this.current.set(d);
    this.form = {
      title: d.title,
      objective: d.objective ?? '',
      priority: d.priority,
      status: d.status,
      assignee_user_id: d.assignee_user_id,
      due_date: d.due_date ?? '',
    };
  }

  /** Sube en serie (un video no compite con otro por el ancho de banda). Devuelve cuántos fallaron. */
  private async subirPendientes(projectId: string): Promise<number> {
    let fallidos = 0;
    for (const f of [...this.pending()]) {
      if (f.progress !== null && !f.error) continue; // ya se está subiendo
      if (!(await this.subirUno(projectId, f))) fallidos += 1;
    }
    return fallidos;
  }

  private async subirUno(projectId: string, f: PendingFile): Promise<boolean> {
    this.patchPending(f.key, { progress: 0, error: null });
    let uploaded: DevProjectAttachment | null = null;
    try {
      uploaded = await new Promise<DevProjectAttachment>((resolve, reject) => {
        this.api.upload(projectId, f.blob, f.fileName, f.source).subscribe({
          next: (ev) => {
            if (ev.type === HttpEventType.UploadProgress) {
              this.patchPending(f.key, { progress: ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0 });
            } else if (ev.type === HttpEventType.Response && ev.body) {
              resolve(ev.body);
            }
          },
          error: reject,
          complete: () => reject(new Error('sin respuesta del servidor')),
        });
      });
    } catch (e) {
      this.patchPending(f.key, { error: apiError(e, 'no se pudo subir') });
      return false;
    }
    // Subido: sale de «pendientes» y entra a la lista real, con su URL firmada.
    const still = this.pending().find((x) => x.key === f.key);
    if (still) this.descartar(still);
    const cur = this.current();
    if (cur && cur.id === projectId) {
      this.current.set({ ...cur, attachments: [...cur.attachments, uploaded], attachments_count: cur.attachments_count + 1 });
    }
    return true;
  }

  private patchPending(key: string, patch: Partial<PendingFile>): void {
    this.pending.update((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  private clearPending(): void {
    this.pending().forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    this.pending.set([]);
  }

  private async refrescarLista(): Promise<void> {
    try {
      this.projects.set(await firstValueFrom(this.api.list()));
    } catch {
      /* la lista se queda como estaba; el error del guardado ya se mostró si lo hubo */
    }
  }
}

