import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SD_QUEUE_ROLES, type SdConfigResponse, type SdQueueCandidateDto, type SdQueueMemberDto, type SdQueueRole } from '@megadulces/contracts';
import { ServiceDeskService, sdError } from './service-desk.service';

export const ROL_COLA_LABEL: Readonly<Record<SdQueueRole, string>> = { coordinador: 'Coordinación (responsable)', tecnico: 'Técnico' };

/**
 * `[MS.7.17]` Quién atiende una cola — la pantalla de los miembros de `servicedesk.queue_members`.
 *
 * Hasta aquí sólo se administraban por API. Reglas que la pantalla hereda del servidor (y que **el servidor sigue
 * exigiendo**; esto sólo evita ofrecer lo que va a rechazar):
 *  · sólo la coordinación DE ESA COLA agrega, cambia de rol o quita (`can_manage` viene del servidor; sin él, sólo se lee);
 *  · sólo se ofrece a quien ya tiene la clave de atender (o coordinar) y todavía no es miembro; para nombrar COORDINACIÓN
 *    se necesita la clave de coordinar, y la lista dice cuál no la tiene en vez de dejarte descubrirlo con un error;
 *  · la cola nunca se queda sin coordinación y no se quita a quien tiene solicitudes abiertas: el servidor lo dice y la
 *    pantalla muestra su mensaje tal cual.
 * Un miembro que perdió la clave sale marcado «sin permiso»: sigue en la cola pero no puede hacer nada hasta que
 * Administración se la devuelva.
 */
@Component({
  selector: 'app-sd-queue-members',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="qm">
      <button type="button" class="qm-toggle" [attr.aria-expanded]="abierto()" (click)="alternar()">
        <i class="pi" [ngClass]="abierto() ? 'pi-chevron-down' : 'pi-chevron-right'" aria-hidden="true"></i>
        Quién atiende esta cola
        @if (miembros(); as m) { <span class="qm-n">{{ m.length }}</span> }
      </button>

      @if (abierto()) {
        @if (error(); as e) { <p class="qm-msg bad" role="alert">{{ e }}</p> }
        @if (aviso(); as a) { <p class="qm-msg ok" role="status">{{ a }}</p> }

        @if (cargando()) {
          <p class="qm-hint">Cargando…</p>
        } @else {
          <table class="qm-table">
            <thead><tr><th>Persona</th><th>Rol</th>@if (puedeAdministrar()) { <th><span class="qm-sr">Acciones</span></th> }</tr></thead>
            <tbody>
              @for (m of miembros() ?? []; track m.user_id) {
                <tr>
                  <td>
                    {{ m.name || m.username }} <span class="qm-mono">{{ m.username }}</span>
                    @if (!m.can_attend) {
                      <em class="qm-off" title="Ya no tiene el permiso de atender solicitudes: sigue en la cola pero no puede hacer nada. Administración se lo devuelve desde Personas.">sin permiso</em>
                    }
                  </td>
                  <td>
                    @if (puedeAdministrar()) {
                      <p-select [options]="roles" optionLabel="label" optionValue="value" [ngModel]="m.role" (ngModelChange)="cambiarRol(m, $event)"
                                appendTo="body" [ariaLabel]="'Rol de ' + (m.name || m.username)" />
                    } @else { {{ rolLabel[m.role] }} }
                  </td>
                  @if (puedeAdministrar()) {
                    <td><p-button label="Quitar" size="small" severity="secondary" [text]="true" [loading]="trabajando() === m.user_id" (onClick)="quitar(m)" /></td>
                  }
                </tr>
              } @empty {
                <tr><td [attr.colspan]="puedeAdministrar() ? 3 : 2" class="qm-vacio">Nadie atiende esta cola todavía.</td></tr>
              }
            </tbody>
          </table>

          <!-- [MS.7.10] A quien cae un ticket que ninguna regla reparte. Siempre un miembro de ESTA cola (el servidor lo exige). -->
          @if (puedeAdministrar()) {
            <label class="qm-field qm-default"><span>Responsable por omisión</span>
              <p-select [options]="opcionesResponsable()" optionLabel="label" optionValue="user_id" [ngModel]="defaultAssigneeId()" (ngModelChange)="cambiarResponsable($event)"
                        [showClear]="true" placeholder="Nadie: los tickets sin regla quedan «Sin asignar»" appendTo="body" ariaLabel="Responsable por omisión" /></label>
          } @else if (nombreResponsable(); as r) {
            <p class="qm-hint">Responsable por omisión: <b>{{ r }}</b></p>
          }

          @if (puedeAdministrar()) {
            <div class="qm-add">
              <label class="qm-field"><span>Agregar a la cola</span>
                <p-select [options]="opcionesCandidatos()" optionLabel="label" optionValue="user_id" [(ngModel)]="elegido" [filter]="true" filterBy="label"
                          placeholder="Elige a una persona" appendTo="body" ariaLabel="Persona a agregar" /></label>
              <label class="qm-field"><span>Rol</span>
                <p-select [options]="roles" optionLabel="label" optionValue="value" [(ngModel)]="rolNuevo" appendTo="body" ariaLabel="Rol de la persona nueva" /></label>
              <p-button label="Agregar" icon="pi pi-plus" [disabled]="!puedeAgregar()" [loading]="trabajando() === 'nuevo'" (onClick)="agregar()" />
            </div>
            @if (sinCandidatos()) {
              <p class="qm-hint">No hay nadie más con el permiso de atender. Para sumar a otra persona, Administración debe darle <b>SERVICIO_ATENDER</b> desde Personas.</p>
            }
            @if (motivoNoAgrega(); as why) { <p class="qm-hint">{{ why }}</p> }
          }
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .qm { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) 0 var(--sp-3); margin-bottom: var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .qm-toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--sp-2); border: 0; background: none; padding: 2px 0;
      font: 600 var(--fs-sm)/1.2 var(--font-body); color: var(--text-main); cursor: pointer; }
    .qm-toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .qm-n { background: var(--surface-2); color: var(--text-muted); border-radius: var(--r-pill); padding: 0 var(--sp-2); font-size: var(--fs-xs); font-weight: 600; }
    .qm-msg { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .qm-msg.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .qm-msg.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .qm-hint { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .qm-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .qm-table th { text-align: left; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 600; padding: var(--sp-2) var(--sp-3); }
    .qm-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); }
    .qm-mono { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); margin-left: var(--sp-1); }
    .qm-off { font-style: normal; font-size: var(--fs-xs); color: var(--warn-fg); margin-left: var(--sp-2); }
    .qm-vacio { text-align: center; color: var(--text-muted); }
    .qm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .qm-add { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: flex-end; }
    .qm-field { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); min-width: 14rem; }
    .qm-field > span { font-weight: 600; font-size: var(--fs-xs); color: var(--text-main); }
    @media (max-width: 40rem) { .qm-table { display: block; overflow-x: auto; } .qm-field { min-width: 100%; } }
  `],
})
export class SdQueueMembersComponent {
  private readonly api = inject(ServiceDeskService);

  readonly queueId = input.required<string>();
  /** `[MS.7.10]` El responsable por omisión actual de la cola (lo trae la configuración). */
  readonly defaultAssigneeId = input<string | null>(null);
  /** Devuelve la configuración nueva cuando se cambia el responsable por omisión (la pantalla la refresca). */
  readonly configChange = output<SdConfigResponse>();

  readonly rolLabel = ROL_COLA_LABEL;
  readonly roles = SD_QUEUE_ROLES.map((r) => ({ value: r, label: ROL_COLA_LABEL[r] }));

  readonly abierto = signal(false);
  readonly cargando = signal(false);
  readonly miembros = signal<SdQueueMemberDto[] | null>(null);
  private readonly puede = signal(false);
  readonly candidatos = signal<SdQueueCandidateDto[]>([]);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  /** `'nuevo'` mientras se agrega; el `user_id` mientras se cambia o quita a alguien. */
  readonly trabajando = signal<string | null>(null);

  elegido: string | null = null;
  rolNuevo: SdQueueRole = 'tecnico';

  /** Lo decide el SERVIDOR (coordina esa cola); la pantalla sólo lo obedece. */
  readonly puedeAdministrar = computed(() => this.puede());
  readonly opcionesCandidatos = computed(() =>
    this.candidatos().map((c) => ({ user_id: c.user_id, label: `${c.name || c.username}${c.can_coordinate ? '' : ' (sin permiso de coordinar)'}` })),
  );
  /** `[MS.7.10]` Sólo quien ya es miembro y puede atender: no se ofrece lo que el servidor va a rechazar. */
  readonly opcionesResponsable = computed(() => (this.miembros() ?? []).filter((m) => m.can_attend).map((m) => ({ user_id: m.user_id, label: m.name || m.username })));
  readonly nombreResponsable = computed(() => {
    const id = this.defaultAssigneeId();
    const m = id ? (this.miembros() ?? []).find((x) => x.user_id === id) : null;
    return m ? m.name || m.username : null;
  });
  readonly sinCandidatos = computed(() => !this.cargando() && this.candidatos().length === 0);

  /** Para nombrar COORDINACIÓN hace falta la clave de coordinar: se dice aquí, no con un error del servidor. */
  motivoNoAgrega(): string | null {
    if (!this.elegido || this.rolNuevo !== 'coordinador') return null;
    const c = this.candidatos().find((x) => x.user_id === this.elegido);
    return c && !c.can_coordinate ? 'Esa persona no tiene el permiso de coordinar (SERVICIO_COORDINAR): agrégala como técnico, o pídelo a Administración.' : null;
  }
  puedeAgregar(): boolean { return !!this.elegido && this.trabajando() === null && this.motivoNoAgrega() === null; }

  alternar(): void {
    const abre = !this.abierto();
    this.abierto.set(abre);
    if (abre && this.miembros() === null) this.cargar();
  }

  /** `conservarMensaje`: al recargar tras un rechazo NO se borra el motivo que se acaba de mostrar. */
  private cargar(conservarMensaje = false): void {
    this.cargando.set(true);
    if (!conservarMensaje) this.error.set(null);
    this.api.queueMembers(this.queueId()).subscribe({
      next: (r) => {
        this.miembros.set(r.members);
        this.puede.set(r.can_manage);
        if (!r.can_manage) { this.candidatos.set([]); this.cargando.set(false); return; }
        this.api.queueCandidates(this.queueId()).subscribe({
          next: (c) => { this.candidatos.set(c); this.cargando.set(false); },
          error: (e) => { this.candidatos.set([]); this.cargando.set(false); this.error.set(sdError(e, 'No se pudo cargar a quién se puede agregar.')); },
        });
      },
      error: (e) => { this.cargando.set(false); this.error.set(sdError(e, 'No se pudieron cargar los miembros de la cola.')); },
    });
  }

  private recargarCandidatos(): void {
    this.api.queueCandidates(this.queueId()).subscribe({ next: (c) => this.candidatos.set(c), error: () => this.candidatos.set([]) });
  }

  agregar(): void {
    if (!this.puedeAgregar() || !this.elegido) return;
    this.trabajando.set('nuevo');
    this.error.set(null);
    this.aviso.set(null);
    this.api.upsertQueueMember(this.queueId(), this.elegido, this.rolNuevo).subscribe({
      next: (r) => { this.miembros.set(r.members); this.trabajando.set(null); this.aviso.set('Persona agregada a la cola.'); this.elegido = null; this.recargarCandidatos(); },
      error: (e) => { this.trabajando.set(null); this.error.set(sdError(e, 'No se pudo agregar a la persona.')); },
    });
  }

  cambiarResponsable(id: string | null): void {
    const nuevo = id ?? null;
    if (nuevo === this.defaultAssigneeId()) return;
    this.trabajando.set('responsable');
    this.error.set(null);
    this.aviso.set(null);
    this.api.updateQueue(this.queueId(), { default_assignee_id: nuevo }).subscribe({
      next: (cfg) => {
        this.trabajando.set(null);
        this.aviso.set(nuevo ? 'Responsable por omisión actualizado.' : 'Sin responsable por omisión: lo que ninguna regla reparta queda «Sin asignar».');
        this.configChange.emit(cfg);
      },
      error: (e) => { this.trabajando.set(null); this.error.set(sdError(e, 'No se pudo cambiar el responsable por omisión.')); },
    });
  }

  cambiarRol(m: SdQueueMemberDto, rol: SdQueueRole): void {
    if (rol === m.role) return;
    this.trabajando.set(m.user_id);
    this.error.set(null);
    this.aviso.set(null);
    this.api.upsertQueueMember(this.queueId(), m.user_id, rol).subscribe({
      next: (r) => { this.miembros.set(r.members); this.trabajando.set(null); this.aviso.set('Rol actualizado.'); },
      // El servidor rechaza (p. ej. dejar la cola sin coordinación): se recarga para que el selector vuelva a su valor real.
      error: (e) => { this.trabajando.set(null); this.error.set(sdError(e, 'No se pudo cambiar el rol.')); this.cargar(true); },
    });
  }

  quitar(m: SdQueueMemberDto): void {
    this.trabajando.set(m.user_id);
    this.error.set(null);
    this.aviso.set(null);
    this.api.removeQueueMember(this.queueId(), m.user_id).subscribe({
      next: (r) => { this.miembros.set(r.members); this.trabajando.set(null); this.aviso.set('Persona quitada de la cola.'); this.recargarCandidatos(); },
      error: (e) => { this.trabajando.set(null); this.error.set(sdError(e, 'No se pudo quitar a la persona.')); },
    });
  }
}
