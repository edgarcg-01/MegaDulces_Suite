import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { HR_SUCURSALES_EMPLEO, type HrVacanteDto, type HrVacanteEdicion } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';

interface FormVacante {
  id: string | null; name: string; area: string; branch_codes: string[]; branches_text: string; salary_text: string; schedule_text: string;
  requirements: string; description: string; image_url: string; is_active: boolean; sort_order: number;
}

/** El formulario de una vacante (vacío para una nueva). */
export function formDe(v: HrVacanteDto | null): FormVacante {
  return {
    id: v?.id ?? null, name: v?.name ?? '', area: v?.area ?? '', branch_codes: [...(v?.branch_codes ?? [])], branches_text: v?.branches_text ?? '', salary_text: v?.salary_text ?? '',
    schedule_text: v?.schedule_text ?? '', requirements: v?.requirements ?? '', description: v?.description ?? '',
    image_url: v?.image_url ?? '', is_active: v?.is_active ?? true, sort_order: v?.sort_order ?? 999,
  };
}

/** Lo que se manda al servidor: texto vacío = sin dato (null), nunca una cadena en blanco. */
export function cuerpoDe(f: FormVacante): HrVacanteEdicion {
  const t = (s: string) => s.trim() || null;
  return {
    name: f.name.trim(), area: t(f.area), branch_codes: [...f.branch_codes], branches_text: t(f.branches_text), salary_text: t(f.salary_text),
    schedule_text: t(f.schedule_text), requirements: t(f.requirements), description: t(f.description), image_url: t(f.image_url),
    is_active: f.is_active, sort_order: Number(f.sort_order) || 999,
  };
}

/**
 * Fase RH · `[RH.2.3]` — Vacantes (`/rh/reclutamiento/vacantes`). Antes: «Puestos» de Mega Talento (7 al 12-oct-2026).
 * Se desactivan, no se borran: un candidato puede apuntar a una vacante que ya cerró.
 *
 * `[RH.13.6]` Contesta «¿qué vacantes se publican y dónde?»: las publicadas primero y las cerradas aparte (antes iban
 * revueltas en el orden de captura, con una pastilla «Publicada» en cada renglón). La fila entera abre la edición.
 */
@Component({
  selector: 'app-rh-vacantes',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule, CheckboxModule, LoadStateComponent, SidePeekComponent, RhReclutamientoMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rv-page">
      <app-rh-reclutamiento-marco subtitulo="Las vacantes de la bolsa de trabajo. Cerrar una no la borra: hay candidatos que se postularon a ella.">
        <div acciones class="rv-btns">
          @if (gestiona()) { <p-button icon="pi pi-plus" label="Nueva vacante" (onClick)="editar(null)" /> }
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        </div>
      </app-rh-reclutamiento-marco>

      <app-load-state [loading]="loading() && !vacantes().length" [error]="error()" [isEmpty]="!loading() && !error() && !vacantes().length"
                      emptyIcon="pi-briefcase" emptyTitle="No hay vacantes" [emptyHint]="gestiona() ? 'Publica la primera con «Nueva vacante».' : null" (retry)="cargar()">
        <section class="rv-card" aria-label="Vacantes">
          <div class="rv-scroll dt-scope">
            <table class="rv-tabla dt-stack">
              <thead><tr>
                <th scope="col" class="rv-c-nom">Vacante</th><th scope="col">Plazas</th><th scope="col">Sueldo</th><th scope="col">Horario</th>
              </tr></thead>
              @for (g of grupos(); track g.id) {
                <tbody [class.rv-cerradas]="g.id === 'cerradas'">
                  <tr class="rv-grupo"><th scope="rowgroup" colspan="4">{{ g.titulo }} <small>{{ g.vacantes.length }}</small></th></tr>
                  @for (v of g.vacantes; track v.id) {
                    <!-- Quien gestiona abre la edición desde la fila, con el mouse o el teclado (Tab llega; Enter o Espacio abre). -->
                    <tr [class.rv-abre]="gestiona()" (click)="gestiona() && editar(v)" [attr.tabindex]="gestiona() ? 0 : null"
                        (keydown.enter)="gestiona() && editar(v)" (keydown.space)="teclaEspacio($event, v)"
                        [attr.aria-label]="gestiona() ? 'Editar la vacante ' + v.name : null">
                      <td class="dt-id rv-c-nom" role="cell">
                        <b class="rv-nom">{{ v.name }}</b>
                        @if (v.area) { <span class="rv-meta">{{ v.area }}</span> }
                      </td>
                      <td role="cell" data-label="Plazas">{{ plazas(v) }}</td>
                      <td role="cell" data-label="Sueldo">{{ v.salary_text || '—' }}</td>
                      <td role="cell" data-label="Horario">{{ v.schedule_text || '—' }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="4" class="rv-vacio" role="cell">Ninguna publicada ahora mismo.</td></tr>
                  }
                </tbody>
              }
            </table>
          </div>
        </section>
      </app-load-state>

      <app-side-peek [open]="peek()" (openChange)="peek.set($event)" [title]="form()?.id ? 'Editar vacante' : 'Nueva vacante'" [subtitle]="form()?.name || null">
        @if (form(); as f) {
          <form class="rv-form" (ngSubmit)="guardar()" aria-label="Datos de la vacante">
            <fieldset class="rv-bloque">
              <legend>Lo que se publica</legend>
              <label>Nombre (obligatorio) <input pInputText name="name" [(ngModel)]="f.name" required maxlength="200" /></label>
              <label>Área <input pInputText name="area" [(ngModel)]="f.area" placeholder="Ventas, Almacén…" /></label>
              <label>Sueldo <input pInputText name="sueldo" [(ngModel)]="f.salary_text" placeholder="$2,300 semanales" /></label>
              <label>Horario <input pInputText name="horario" [(ngModel)]="f.schedule_text" placeholder="Lunes a sábado, 8:00 a 17:00" /></label>
            </fieldset>
            <fieldset class="rv-bloque">
              <legend>Dónde se contrata</legend>
              <small>Sin ninguna marcada, la vacante sale en todas las ciudades de la bolsa de trabajo.</small>
              @for (s of sucursales; track s.id) {
                <label class="rv-check"><p-checkbox [binary]="true" [ngModel]="f.branch_codes.includes(s.id)" (ngModelChange)="alternar(f, s.id)"
                  [ngModelOptions]="{ standalone: true }" [inputId]="'rv-suc-' + s.id" /> <span><b>{{ s.ciudad }}</b> — {{ sucursalCorta(s.direccion) }}</span></label>
              }
              <label>Texto de plazas que se publica (opcional) <input pInputText name="plazas" [(ngModel)]="f.branches_text" placeholder="Zamora y La Piedad" /></label>
            </fieldset>
            <fieldset class="rv-bloque">
              <legend>Detalle</legend>
              <label>Requisitos <textarea pInputText name="req" rows="3" [(ngModel)]="f.requirements"></textarea></label>
              <label>Descripción <textarea pInputText name="desc" rows="3" [(ngModel)]="f.description"></textarea></label>
              <label>Imagen (liga) <input pInputText name="img" [(ngModel)]="f.image_url" /></label>
            </fieldset>
            <fieldset class="rv-bloque">
              <legend>Publicación</legend>
              <label class="rv-check"><p-checkbox [binary]="true" name="activa" [(ngModel)]="f.is_active" inputId="rv-activa" /> <span>Publicada en la bolsa de trabajo</span></label>
              <label>Orden en la lista <input pInputText type="number" name="orden" [(ngModel)]="f.sort_order" /></label>
            </fieldset>
            @if (aviso(); as a) { <p class="rv-banner" role="alert">{{ a }}</p> }
            <div class="rv-btns">
              <p-button type="submit" label="Guardar" [disabled]="!f.name.trim()" [loading]="ocupado()" />
              <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="peek.set(false)" />
            </div>
          </form>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rv-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rv-btns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .rv-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; overflow: hidden; }
    .rv-scroll { overflow-x: auto; }
    .rv-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rv-tabla thead th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rv-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rv-c-nom { width: 34%; }
    /* Un grupo por estado (como las zonas de Candidatos): primero lo publicado, lo cerrado al final y atenuado. */
    .rv-tabla tr.rv-grupo th { text-align: left; padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); background: var(--surface-2);
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-main); }
    .rv-tabla tr.rv-grupo small { margin-left: var(--sp-1); font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0; color: var(--text-muted); }
    .rv-cerradas td, .rv-cerradas .rv-nom { color: var(--text-muted); }
    .rv-tabla tr.rv-abre { cursor: pointer; }
    .rv-tabla tr.rv-abre:hover td { background: var(--surface-hover-bg); }
    .rv-nom { font-weight: 700; color: var(--text-main); }
    .rv-tabla tr.rv-abre:hover .rv-nom { text-decoration: underline; }
    .rv-tabla tr.rv-abre:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rv-tabla tr.rv-abre:focus-visible td { background: var(--surface-hover-bg); }
    /* Con el dedo, la fila que abre la edición mide al menos 44 px (--tap-min: 0 con mouse). */
    .rv-tabla tr.rv-abre td { height: var(--tap-min); }
    .rv-meta { display: block; margin-top: 2px; font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-vacio { color: var(--text-muted); font-size: var(--fs-sm); }
    @container densetable (max-width: 34rem) { .rv-tabla td.rv-c-nom { width: auto; } }

    /* El formulario en cuatro bloques con título (antes: 11 campos seguidos). */
    .rv-form { display: flex; flex-direction: column; gap: var(--sp-4); }
    .rv-bloque { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
    .rv-bloque legend { padding: 0 0 var(--sp-2); margin-bottom: var(--sp-1); width: 100%; border-bottom: 1px solid var(--border-color);
      font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .rv-bloque > small { font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-form .rv-check { flex-direction: row; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); min-height: var(--tap-min); }
    .rv-check b { font-weight: 600; }
    .rv-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    :host ::ng-deep .p-button, :host ::ng-deep input.p-inputtext { min-height: var(--tap-min); }
    @media (max-width: 40rem) { .rv-page { padding: var(--sp-3); } }
  `],
})
export class RhVacantesComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);
  private readonly perms = inject(PermissionsService);

  readonly sucursales = HR_SUCURSALES_EMPLEO;
  readonly vacantes = signal<HrVacanteDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly ocupado = signal(false);
  readonly peek = signal(false);
  readonly form = signal<FormVacante | null>(null);
  readonly aviso = signal<string | null>(null);

  readonly gestiona = computed(() => this.perms.has(Permission.HR_RECRUITMENT_GESTIONAR));
  /** Publicadas primero (siempre, aunque no haya ninguna: eso también se dice); las cerradas al final, sólo si hay. */
  readonly grupos = computed(() => {
    const vs = this.vacantes();
    const g = [{ id: 'publicadas', titulo: 'Publicadas', vacantes: vs.filter((v) => v.is_active) }];
    const cerradas = vs.filter((v) => !v.is_active);
    if (cerradas.length) g.push({ id: 'cerradas', titulo: 'Cerradas', vacantes: cerradas });
    return g;
  });

  ngOnInit(): void { this.cargar(); }

  /** Las plazas: el texto de RH si lo hay; si no, las ciudades de sus sucursales; sin sucursales, todas. */
  plazas(v: HrVacanteDto): string {
    if (v.branches_text) return v.branches_text;
    if (!v.branch_codes.length) return 'Todas';
    return [...new Set(HR_SUCURSALES_EMPLEO.filter((s) => v.branch_codes.includes(s.id)).map((s) => s.ciudad))].join(' · ') || v.branch_codes.join(', ');
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.vacantes().subscribe({
      next: (v) => { this.vacantes.set(v); this.loading.set(false); },
      error: (e) => { this.error.set(rhError(e, 'No se pudieron leer las vacantes.')); this.loading.set(false); },
    });
  }

  /** La primera parte de la dirección (calle y número), para distinguir dos sucursales de la misma ciudad. */
  sucursalCorta(dir: string): string {
    return dir.split(',')[0] || dir;
  }

  /** Espacio sobre la fila abre la edición (sin desplazar la página), sólo para quien gestiona. */
  teclaEspacio(e: Event, v: HrVacanteDto): void {
    if (!this.gestiona()) return;
    e.preventDefault();
    this.editar(v);
  }

  alternar(f: FormVacante, id: string): void {
    f.branch_codes = f.branch_codes.includes(id) ? f.branch_codes.filter((x) => x !== id) : [...f.branch_codes, id];
  }

  editar(v: HrVacanteDto | null): void {
    this.form.set(formDe(v));
    this.aviso.set(null);
    this.peek.set(true);
  }

  guardar(): void {
    const f = this.form();
    if (!f || !f.name.trim()) return;
    this.ocupado.set(true);
    const obs = f.id ? this.api.editarVacante(f.id, cuerpoDe(f)) : this.api.crearVacante(cuerpoDe(f));
    obs.subscribe({
      next: () => { this.ocupado.set(false); this.peek.set(false); this.cargar(); },
      error: (e) => { this.ocupado.set(false); this.aviso.set(rhError(e, 'No se pudo guardar la vacante.')); },
    });
  }
}
