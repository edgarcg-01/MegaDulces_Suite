import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SD_IMPACTS, type SdAttachmentInput, type SdCatalogResponse, type SdDepartmentDto, type SdImpact, type SdPreferencesDto, type SdRequesterDto, type SdRequestRow } from '@megadulces/contracts';
import { STORE_BRANCHES } from '../../../core/constants/store-branches';
import { optimizarImagenes } from '../image-compress';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { IMPACT_LABEL, PRIORITY_LABEL, STATUS_LABEL, ServiceDeskService, sdError } from '../service-desk.service';
import { SdRequestDetailComponent, MAX_ARCHIVOS } from '../sd-request-detail.component';

const TIPOS_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;

function dataUri(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(`No se pudo leer ${f.name}`));
    r.readAsDataURL(f);
  });
}

/**
 * `[MS.3.2]` Mesa de Servicio › Mis solicitudes (`/servicio/solicitudes`).
 *
 * La puerta de TODA persona de la suite: reporta un problema, ve cómo va y contesta cuando se lo
 * piden. Operations (DESIGN.md): lista densa a la izquierda, ficha a la derecha; abajo de 1100 px la
 * ficha REEMPLAZA a la lista. El formulario no pide prioridad: la SUGIERE el sistema con lo que la
 * persona sí sabe (a cuántos afecta y si le impide trabajar) y la confirma quien atiende, porque
 * si cada quien se declarara Urgente la fila dejaría de ordenar.
 */
@Component({
  selector: 'app-servicio-solicitudes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, DialogModule, InputTextModule, TextareaModule, SdRequestDetailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ss-page" [class.con-ficha]="panel()">
      <header class="ss-head">
        <div>
          <h1>Mis solicitudes</h1>
          <p>Reporta un problema o una necesidad y da seguimiento. Quien atiende confirma la prioridad.</p>
        </div>
        <div class="ss-head-actions">
          <p-button icon="pi pi-bell" label="Mis avisos" severity="secondary" [outlined]="true" (onClick)="abrirPrefs()" />
          <p-button icon="pi pi-plus" label="Nueva solicitud" (onClick)="nueva()" />
        </div>
      </header>

      <section class="ss-chips" aria-label="Filtrar solicitudes">
        @for (s of scopes; track s.value) {
          <button type="button" class="ss-chip" [class.on]="scope() === s.value" (click)="setScope(s.value)">{{ s.label }}</button>
        }
        <span class="ss-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Buscar folio o texto" [ngModel]="search()" (ngModelChange)="setSearch($event)" aria-label="Buscar solicitud" />
        </span>
      </section>

      @if (loadError(); as e) { <p class="ss-banner bad" role="alert">{{ e }}</p> }

      <div class="ss-body" [class.has-detail]="panel()">
        <section class="ss-list" aria-label="Lista de solicitudes">
          <ul class="ss-rows">
            @for (t of rows(); track t.id) {
              <li>
                <button type="button" class="ss-row" [class.sel]="selId() === t.id" (click)="abrir(t.id)">
                  <span class="ss-r1"><span class="ss-mono">{{ t.folio }}</span>
                    <span class="ss-st" [attr.data-s]="t.status">{{ statusLabel[t.status] }}</span></span>
                  <span class="ss-title">{{ t.title }}</span>
                  <span class="ss-r3">
                    <span class="ss-pri" [attr.data-p]="t.priority">{{ priorityLabel[t.priority] }}</span>
                    <span>{{ t.assigned_to_name || 'Sin asignar' }}</span>
                    <span class="ss-mono ss-date">{{ t.created_at | date:'dd/MM/yy' }}</span>
                  </span>
                </button>
              </li>
            } @empty {
              <li class="ss-empty">
                @if (loading()) { Cargando… }
                @else if (search() || scope() !== 'open') { Ninguna solicitud con estos filtros. }
                @else { No tienes solicitudes abiertas. Si algo no funciona, usa «Nueva solicitud». }
              </li>
            }
          </ul>
          @if (total() > rows().length) { <p class="ss-more">Mostrando {{ rows().length }} de {{ total() }}. Usa el buscador para acotar.</p> }
        </section>

        @if (panel()) {
          <section class="ss-detail" aria-label="Ficha">
            <p-button class="ss-back" icon="pi pi-arrow-left" label="Volver a la lista" [text]="true" severity="secondary" size="small" (onClick)="cerrar()" />
            @if (creando()) {
              <div class="ss-form">
                <div class="ss-fhead"><h2>Nueva solicitud</h2>
                  <p-button icon="pi pi-times" [text]="true" severity="secondary" ariaLabel="Cerrar formulario" (onClick)="cerrar()" /></div>
                @if (formError(); as e) { <p class="ss-banner bad" role="alert">{{ e }}</p> }

                @if (puedeAtender()) {
                  <div class="ss-onbehalf">
                    @if (!solicitante()) {
                      <label class="ss-chk"><input type="checkbox" [ngModel]="aNombreDe()" (ngModelChange)="alternarANombreDe($event)" /> <b>Levantar a nombre de otra persona</b></label>
                      @if (aNombreDe()) {
                        <label class="ss-field"><span>Persona que lo solicita <em>*</em></span>
                          <input pInputText type="search" [ngModel]="buscaTexto()" (ngModelChange)="buscarPersona($event)" placeholder="Escribe al menos 2 letras de su nombre o usuario" aria-label="Buscar persona" autocomplete="off" /></label>
                        @if (buscando()) { <p class="ss-hint">Buscando…</p> }
                        @else if (buscaTexto().trim().length >= 2 && !resultados().length) { <p class="ss-hint">Nadie con ese nombre. Sólo se puede levantar a nombre de quien tiene usuario en la suite.</p> }
                        @if (resultados().length) {
                          <ul class="ss-people" role="listbox" aria-label="Personas">
                            @for (p of resultados(); track p.user_id) {
                              <li><button type="button" class="ss-person" (click)="elegirPersona(p)">
                                <b>{{ p.name || p.username }}</b>
                                <small>{{ p.username }}{{ p.department_name ? ' · ' + p.department_name : '' }}{{ p.warehouse_name ? ' · ' + p.warehouse_name : '' }}</small>
                              </button></li>
                            }
                          </ul>
                        }
                      }
                    } @else {
                      <div class="ss-picked">
                        <div><b>{{ solicitante()?.name || solicitante()?.username }}</b> <small class="ss-hint">lo solicita · {{ solicitante()?.username }}</small></div>
                        <p-button label="Cambiar" [text]="true" size="small" severity="secondary" (onClick)="quitarPersona()" />
                      </div>
                      <label class="ss-field"><span>Área</span>
                        <p-select [options]="departamentos()" optionLabel="name" optionValue="code" [(ngModel)]="areaCode" placeholder="Sin área en su ficha" [showClear]="true" appendTo="body" ariaLabel="Área" /></label>
                      <p class="ss-hint">La persona recibirá el aviso y será quien confirme o reabra la solicitud. La sucursal se precarga de su ficha: corrígela si hace falta.</p>
                    }
                  </div>
                }

                <label class="ss-field"><span>¿Sobre qué es? <em>*</em></span>
                  <p-select [options]="categorias()" optionLabel="name" optionValue="id" [group]="true" optionGroupLabel="label" optionGroupChildren="items" [ngModel]="form.category_id"
                            (ngModelChange)="elegirCategoria($event)" placeholder="Elige una categoría" appendTo="body" ariaLabel="Categoría" [filter]="true" filterBy="name" />
                </label>
                <label class="ss-field"><span>Título corto <em>*</em></span>
                  <input pInputText [(ngModel)]="form.title" maxlength="200" placeholder="Ej. No me abre el sistema de caja" /></label>
                <label class="ss-field"><span>Cuéntanos qué pasa</span>
                  <textarea pTextarea rows="5" [(ngModel)]="form.description" placeholder="Qué intentabas hacer, qué mensaje te salió, desde cuándo."></textarea></label>

                @if (requiereSucursal() || mostrarSucursal() || form.warehouse_code) {
                  <label class="ss-field"><span>Sucursal {{ requiereSucursal() ? '*' : '' }}</span>
                    <p-select [options]="sucursales" optionLabel="name" optionValue="code" [(ngModel)]="form.warehouse_code" placeholder="Elige la sucursal"
                              [showClear]="!requiereSucursal()" appendTo="body" ariaLabel="Sucursal" /></label>
                } @else {
                  <button type="button" class="ss-link" (click)="mostrarSucursal.set(true)">Indicar sucursal (opcional)</button>
                }

                <fieldset class="ss-impact">
                  <legend>¿A cuántas personas afecta?</legend>
                  @for (i of impactos; track i.value) {
                    <label class="ss-radio"><input type="radio" name="impact" [value]="i.value" [(ngModel)]="form.impact" /> {{ i.label }}</label>
                  }
                  <label class="ss-chk"><input type="checkbox" [(ngModel)]="form.blocks_work" /> <b>Me impide trabajar</b></label>
                </fieldset>

                <div class="ss-field">
                  <span>Fotos o PDF (opcional)</span>
                  <div class="ss-att">
                    <p-button icon="pi pi-camera" label="Cámara" severity="secondary" [outlined]="true" size="small" (onClick)="cam.click()" />
                    <input #cam type="file" hidden accept="image/*" capture="environment" (change)="elegirArchivos($event)" />
                    <p-button icon="pi pi-paperclip" label="Adjuntar" severity="secondary" [outlined]="true" size="small" (onClick)="fi.click()" />
                    <input #fi type="file" hidden multiple accept="image/*,application/pdf" (change)="elegirArchivos($event)" />
                    <span class="ss-hint">Hasta {{ maxArchivos }}. Una captura de pantalla ayuda mucho.</span>
                    @if (optimizando()) { <span class="ss-hint" role="status">Optimizando las fotos…</span> }
                  </div>
                  @if (archivos().length) {
                    <ul class="ss-pend">@for (f of archivos(); track f.name + f.size) {
                      <li><i class="pi pi-paperclip" aria-hidden="true"></i> {{ f.name }}
                        <p-button icon="pi pi-times" [text]="true" size="small" severity="secondary" [ariaLabel]="'Quitar ' + f.name" (onClick)="quitar(f)" /></li>
                    }</ul>
                  }
                </div>

                <p class="ss-hint">La prioridad la propone el sistema según lo que marcaste y la confirma quien atiende.</p>
                <div class="ss-ffoot">
                  <p-button label="Enviar solicitud" icon="pi pi-send" [loading]="enviando()" [disabled]="!puedeEnviar()" (onClick)="enviar()" />
                  <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="cerrar()" />
                </div>
              </div>
            } @else if (selId(); as id) {
              <app-sd-request-detail [id]="id" [agent]="false" (cambio)="alCambiar($event)" (cerrar)="cerrar()" />
            }
          </section>
        }
      </div>
    </div>

    <p-dialog header="Mis avisos" [(visible)]="prefsAbierto" [modal]="true" [style]="{ width: '30rem', maxWidth: '94vw' }" appendTo="body">
      @if (prefsError(); as e) { <p class="ss-banner bad" role="alert">{{ e }}</p> }
      @if (prefs(); as p) {
       <div class="ss-dlg">
        <p class="ss-hint">Siempre verás los avisos en la campana. Aquí eliges si además te llegan por correo o WhatsApp.</p>
        <label class="ss-field"><span>Correo</span>
          <input pInputText type="email" [(ngModel)]="pForm.email" placeholder="tu.correo@empresa.mx" /></label>
        <label class="ss-chk"><input type="checkbox" [(ngModel)]="pForm.email_enabled" /> Avisarme por correo</label>
        <label class="ss-field"><span>Celular (10 dígitos)</span>
          <input pInputText inputmode="tel" [(ngModel)]="pForm.phone" placeholder="443 123 4567" /></label>
        <label class="ss-chk"><input type="checkbox" [(ngModel)]="pForm.whatsapp_enabled" /> Avisarme por WhatsApp
          @if (p.whatsapp_opt_in_at) { <small class="ss-hint">(aceptado el {{ p.whatsapp_opt_in_at | date:'dd/MM/yy' }})</small> }</label>
        @if (pForm.whatsapp_enabled && !p.whatsapp_enabled) { <p class="ss-hint">Al activarlo aceptas recibir mensajes de la Mesa de Servicio por WhatsApp. Puedes apagarlo cuando quieras.</p> }
       </div>
      }
      <ng-template #footer>
        <p-button label="Guardar" [loading]="prefsGuardando()" (onClick)="guardarPrefs()" />
        <p-button label="Cerrar" [text]="true" severity="secondary" (onClick)="prefsAbierto.set(false)" />
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ss-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .ss-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .ss-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); }
    .ss-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .ss-head-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ss-chips { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .ss-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill);
      padding: 4px var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
    .ss-chip.on { border-color: var(--action); color: var(--text-main); background: var(--surface-selected-bg); }
    .ss-chip:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .ss-search { position: relative; flex: 1 1 220px; max-width: 360px; margin-left: auto; }
    .ss-search i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-faint); font-size: var(--fs-xs); }
    .ss-search input { width: 100%; padding-left: 30px; }
    .ss-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .ss-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .ss-body { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
    .ss-body.has-detail { grid-template-columns: minmax(0, 1fr) minmax(380px, 1.1fr); }
    .ss-list, .ss-detail { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .ss-rows { list-style: none; margin: 0; padding: 0; }
    .ss-row { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); background: transparent;
      border: 0; border-top: 1px solid var(--border-color); color: var(--text-main); font: inherit; cursor: pointer; }
    .ss-rows li:first-child .ss-row { border-top: 0; }
    .ss-row:hover { background: var(--surface-hover-bg); }
    .ss-row.sel { background: var(--surface-selected-bg); }
    .ss-row:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .ss-r1, .ss-r3 { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); }
    .ss-r1 { justify-content: space-between; }
    .ss-r3 { color: var(--text-muted); }
    .ss-date { margin-left: auto; }
    .ss-title { font-weight: 600; font-size: var(--fs-sm); overflow-wrap: anywhere; }
    .ss-mono { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .ss-st, .ss-pri { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; }
    .ss-st { background: var(--surface-2); color: var(--text-muted); }
    .ss-st[data-s='asignado'], .ss-st[data-s='en_proceso'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .ss-st[data-s='en_espera'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .ss-st[data-s='resuelto'], .ss-st[data-s='cerrado'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ss-st[data-s='cancelado'] { color: var(--text-faint); text-decoration: line-through; }
    .ss-pri { color: var(--text-muted); }
    .ss-pri[data-p='alta'] { color: var(--warn-fg); background: var(--warn-soft-bg); }
    .ss-pri[data-p='urgente'] { color: var(--bad-fg); background: var(--bad-soft-bg); font-weight: 600; }
    .ss-empty { padding: var(--sp-6); text-align: center; color: var(--text-muted); font-size: var(--fs-sm); }
    .ss-more { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); border-top: 1px solid var(--border-color); }
    .ss-detail { padding: var(--sp-4); position: sticky; top: var(--sp-4); max-height: calc(100vh - 2 * var(--sp-4)); overflow: auto; }
    .ss-back { display: none; }
    .ss-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ss-fhead { display: flex; justify-content: space-between; align-items: center; }
    .ss-fhead h2 { margin: 0; font: 700 var(--fs-h3)/1.2 var(--font-body); color: var(--text-main); }
    .ss-field { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .ss-field > span:first-child { font-weight: 600; font-size: var(--fs-xs); color: var(--text-main); }
    .ss-field em { color: var(--bad-fg); font-style: normal; }
    .ss-field input, .ss-field textarea, .ss-field p-select { width: 100%; }
    .ss-onbehalf { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-md); }
    .ss-people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
    .ss-person { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 1px; background: var(--surface-2); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); cursor: pointer; color: var(--text-main); font-size: var(--fs-sm); }
    .ss-person small { color: var(--text-muted); font-size: var(--fs-xs); }
    .ss-person:hover { background: var(--surface-hover-bg); }
    .ss-person:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .ss-picked { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); }
    .ss-picked small { margin-left: var(--sp-2); }
    .ss-link { align-self: flex-start; background: none; border: 0; padding: 0; color: var(--action); font-size: var(--fs-sm); cursor: pointer; }
    .ss-impact { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; }
    .ss-impact legend { font-weight: 600; font-size: var(--fs-xs); color: var(--text-main); padding: 0 var(--sp-1); }
    .ss-radio, .ss-chk { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .ss-att { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .ss-hint { font-size: var(--fs-xs); color: var(--text-muted); margin: 0; }
    .ss-pend { list-style: none; margin: var(--sp-1) 0 0; padding: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ss-pend li { display: flex; align-items: center; gap: var(--sp-1); }
    .ss-ffoot { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ss-dlg { display: flex; flex-direction: column; gap: var(--sp-3); }
    @media (max-width: 1100px) {
      .ss-body.has-detail { grid-template-columns: 1fr; }
      .ss-body.has-detail .ss-list { display: none; }
      .ss-detail { position: static; max-height: none; }
      .ss-back { display: inline-flex; align-self: flex-start; margin: calc(-1 * var(--sp-2)) 0 var(--sp-2) calc(-1 * var(--sp-2)); }
      /* La ficha reemplaza a la lista, así que también a los filtros que la acompañan. */
      .ss-page.con-ficha .ss-chips { display: none; }
    }
    @media (max-width: 640px) {
      .ss-page { padding: var(--sp-3); gap: var(--sp-3); }
      .ss-head-actions, .ss-head-actions p-button, .ss-head-actions p-button ::ng-deep button { width: 100%; }
      .ss-head-actions p-button ::ng-deep button { justify-content: center; min-height: 44px; }
      .ss-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .ss-chip { flex: none; min-height: 36px; }
      .ss-search { flex: 0 0 220px; margin-left: 0; }
      .ss-ffoot p-button { flex: 1 1 auto; }
      .ss-ffoot p-button ::ng-deep button { width: 100%; justify-content: center; min-height: 44px; }
    }
  `],
})
export class ServicioSolicitudesComponent implements OnInit {
  private readonly api = inject(ServiceDeskService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly statusLabel = STATUS_LABEL;
  readonly priorityLabel = PRIORITY_LABEL;
  readonly maxArchivos = MAX_ARCHIVOS;
  readonly sucursales = STORE_BRANCHES;
  readonly impactos = SD_IMPACTS.map((v) => ({ value: v, label: IMPACT_LABEL[v] }));
  readonly scopes = [{ value: 'open', label: 'Abiertas' }, { value: 'closed', label: 'Cerradas' }, { value: 'all', label: 'Todas' }];

  readonly rows = signal<SdRequestRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly scope = signal('open');
  readonly search = signal('');
  readonly selId = signal<string | null>(null);
  readonly creando = signal(false);
  readonly panel = computed(() => this.creando() || !!this.selId());

  // ── alta ──
  readonly catalogo = signal<SdCatalogResponse | null>(null);
  readonly mostrarSucursal = signal(false);
  readonly archivos = signal<File[]>([]);
  readonly enviando = signal(false);
  readonly formError = signal<string | null>(null);
  form: { category_id: string | null; title: string; description: string; impact: SdImpact; blocks_work: boolean; warehouse_code: string | null } = this.formVacio();

  /** Categorías agrupadas por cola (`p-select` con `group`). Hoy hay una sola cola (TI). */
  readonly categorias = computed(() => {
    const c = this.catalogo();
    if (!c) return [];
    return c.queues.map((q) => ({ label: q.name, items: c.categories.filter((k) => k.queue_id === q.id) })).filter((g) => g.items.length);
  });
  /**
   * La categoría elegida vive en una SEÑAL aparte del `form` plano a propósito: un `computed()` que lee un campo
   * plano se evalúa una vez y queda congelado (la compuerta `check:signal-reactivity` lo atrapó), y entonces una
   * categoría que exige sucursal nunca la pediría. El `form` sigue siendo plano porque `ngModel` escribe ahí.
   */
  readonly categoriaId = signal<string | null>(null);
  readonly requiereSucursal = computed(() => !!this.catalogo()?.categories.find((k) => k.id === this.categoriaId())?.requires_branch);

  // ── preferencias ──
  readonly prefsAbierto = signal(false);
  readonly prefs = signal<SdPreferencesDto | null>(null);
  readonly prefsError = signal<string | null>(null);
  readonly prefsGuardando = signal(false);
  pForm = { email: '', phone: '', email_enabled: true, whatsapp_enabled: false };

  private formVacio() {
    return { category_id: null as string | null, title: '', description: '', impact: 'yo' as SdImpact, blocks_work: false, warehouse_code: null as string | null };
  }

  ngOnInit(): void {
    this.cargar();
    // `?id=` (deep-link de la campana) y `?nueva=1` («Reportar un problema» del header). Se ESCUCHAN, no se leen una
    // vez: estando ya en esta página, Angular reutiliza el componente y sólo cambia el parámetro — medido en vivo,
    // el botón del header no hacía nada desde aquí.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const id = q.get('id');
      if (id) this.abrir(id);
      if (q.get('nueva')) {
        this.nueva();
        void this.router.navigate([], { queryParams: { nueva: null }, queryParamsHandling: 'merge', replaceUrl: true });
      }
    });
  }

  cargar(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.mine({ scope: this.scope(), search: this.search().trim() || undefined, limit: 100 }).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: (e) => { this.loadError.set(sdError(e, 'No se pudieron cargar tus solicitudes.')); this.loading.set(false); },
    });
  }
  setScope(s: string): void { this.scope.set(s); this.cargar(); }
  private buscarTimer?: ReturnType<typeof setTimeout>;
  setSearch(v: string): void {
    this.search.set(v);
    clearTimeout(this.buscarTimer);
    this.buscarTimer = setTimeout(() => this.cargar(), 300);
  }

  abrir(id: string): void { this.creando.set(false); this.selId.set(id); }
  cerrar(): void { this.creando.set(false); this.selId.set(null); }
  alCambiar(t: { id: string }): void { this.cargar(); this.selId.set(t.id); }

  // ── alta ──
  nueva(): void {
    this.form = this.formVacio();
    this.aNombreDe.set(false);
    this.quitarPersona();
    this.categoriaId.set(null);
    this.archivos.set([]);
    this.formError.set(null);
    this.mostrarSucursal.set(false);
    this.selId.set(null);
    this.creando.set(true);
    if (!this.catalogo()) this.api.catalog().subscribe({ next: (c) => this.catalogo.set(c), error: (e) => this.formError.set(sdError(e, 'No se pudo cargar el catálogo.')) });
  }
  elegirCategoria(id: string): void { this.form.category_id = id; this.categoriaId.set(id); }
  /** `[MS.3.12]` Mientras se achican las fotos de la cámara no se deja enviar. */
  readonly optimizando = signal(false);

  puedeEnviar(): boolean {
    if (this.optimizando()) return false;
    // Con «a nombre de otra persona» encendido hay que haber ELEGIDO a la persona: si no, se levantaría a nombre de quien llama sin que lo note.
    if (this.aNombreDe() && !this.solicitante()) return false;
    return !!this.form.category_id && !!this.form.title.trim() && (!this.requiereSucursal() || !!this.form.warehouse_code);
  }

  // ── `[MS.3.11]` levantar a nombre de otra persona (sólo quien atiende) ──
  private readonly perms = inject(PermissionsService);
  readonly puedeAtender = computed(() => this.perms.has(Permission.SERVICIO_ATENDER) || this.perms.has(Permission.SERVICIO_COORDINAR));
  readonly aNombreDe = signal(false);
  readonly buscaTexto = signal('');
  readonly buscando = signal(false);
  readonly resultados = signal<SdRequesterDto[]>([]);
  readonly solicitante = signal<SdRequesterDto | null>(null);
  readonly departamentos = signal<SdDepartmentDto[]>([]);
  /** Área elegida (plano: lo escribe `ngModel`). `null` = la de la ficha de la persona. */
  areaCode: string | null = null;
  private personaTimer?: ReturnType<typeof setTimeout>;

  alternarANombreDe(on: boolean): void {
    this.aNombreDe.set(on);
    if (!on) this.quitarPersona();
    if (on && !this.departamentos().length) this.api.departments().subscribe({ next: (d) => this.departamentos.set(d), error: () => this.departamentos.set([]) });
  }
  buscarPersona(v: string): void {
    this.buscaTexto.set(v);
    clearTimeout(this.personaTimer);
    if (v.trim().length < 2) { this.resultados.set([]); this.buscando.set(false); return; }
    this.buscando.set(true);
    this.personaTimer = setTimeout(() => {
      this.api.requesters(v.trim()).subscribe({
        next: (r) => { this.resultados.set(r); this.buscando.set(false); },
        error: (e) => { this.resultados.set([]); this.buscando.set(false); this.formError.set(sdError(e, 'No se pudo buscar a la persona.')); },
      });
    }, 250);
  }
  elegirPersona(p: SdRequesterDto): void {
    this.solicitante.set(p);
    this.resultados.set([]);
    this.areaCode = p.department_code;
    // La sucursal de su ficha se precarga si quien atiende todavía no eligió otra; sigue siendo editable.
    if (p.warehouse_code && !this.form.warehouse_code) this.form.warehouse_code = p.warehouse_code;
  }
  quitarPersona(): void {
    this.solicitante.set(null);
    this.resultados.set([]);
    this.buscaTexto.set('');
    this.areaCode = null;
  }

  elegirArchivos(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const nuevos = Array.from(input.files ?? []);
    input.value = '';
    const malos = nuevos.filter((f) => !TIPOS_OK.test(f.type));
    if (malos.length) this.formError.set(`Sólo se aceptan fotos y PDF: ${malos.map((f) => f.name).join(', ')}.`);
    this.optimizando.set(true);
    // Las fotos de teléfono (3–15 MB) se achican ANTES de subir: ver `image-compress.ts`. Lo que no se pueda, sube original.
    void optimizarImagenes(nuevos.filter((f) => TIPOS_OK.test(f.type))).then((listos) => {
      const todos = [...this.archivos(), ...listos];
      if (todos.length > MAX_ARCHIVOS) this.formError.set(`Máximo ${MAX_ARCHIVOS} archivos por envío.`);
      this.archivos.set(todos.slice(0, MAX_ARCHIVOS));
      this.optimizando.set(false);
    });
  }
  quitar(f: File): void { this.archivos.update((a) => a.filter((x) => x !== f)); }

  enviar(): void {
    if (!this.puedeEnviar() || !this.form.category_id) return;
    this.enviando.set(true);
    this.formError.set(null);
    Promise.all(this.archivos().map(async (f): Promise<SdAttachmentInput> => ({ file_base64: await dataUri(f), file_name: f.name })))
      .then((attachments) => this.api.create({
        category_id: this.form.category_id as string,
        title: this.form.title.trim(),
        description: this.form.description.trim() || undefined,
        impact: this.form.impact,
        blocks_work: this.form.blocks_work,
        warehouse_code: this.form.warehouse_code || null,
        attachments: attachments.length ? attachments : undefined,
        // Sólo viaja si quien atiende ELIGIÓ a la persona: sin ella, la solicitud es de quien la escribe (lo de siempre).
        requester_id: this.solicitante()?.user_id,
        department_code: this.solicitante() ? this.areaCode : undefined,
      }).subscribe({
        next: (t) => {
          this.enviando.set(false);
          this.creando.set(false);
          // A nombre de otra persona NO es «mía»: no aparece en «Mis solicitudes», así que se abre en la bandeja de quien atiende.
          if (this.solicitante()) { void this.router.navigate(['/servicio/bandeja'], { queryParams: { id: t.id } }); return; }
          this.selId.set(t.id);
          this.scope.set('open');
          this.cargar();
        },
        error: (e) => { this.enviando.set(false); this.formError.set(sdError(e, 'No se pudo enviar la solicitud.')); },
      }))
      .catch((e) => { this.enviando.set(false); this.formError.set(sdError(e, 'No se pudo leer un archivo.')); });
  }

  // ── preferencias ──
  abrirPrefs(): void {
    this.prefsError.set(null);
    this.prefsAbierto.set(true);
    this.api.preferences().subscribe({
      next: (p) => { this.prefs.set(p); this.pForm = { email: p.email ?? '', phone: p.phone ?? '', email_enabled: p.email_enabled, whatsapp_enabled: p.whatsapp_enabled }; },
      error: (e) => this.prefsError.set(sdError(e, 'No se pudieron cargar tus preferencias.')),
    });
  }
  guardarPrefs(): void {
    this.prefsGuardando.set(true);
    this.prefsError.set(null);
    this.api.updatePreferences({
      email: this.pForm.email.trim() || null,
      phone: this.pForm.phone.trim() || null,
      email_enabled: this.pForm.email_enabled,
      whatsapp_enabled: this.pForm.whatsapp_enabled,
    }).subscribe({
      next: (p) => { this.prefs.set(p); this.prefsGuardando.set(false); this.prefsAbierto.set(false); },
      error: (e) => { this.prefsGuardando.set(false); this.prefsError.set(sdError(e, 'No se pudieron guardar tus preferencias.')); },
    });
  }

}
