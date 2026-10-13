import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
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
 */
@Component({
  selector: 'app-rh-vacantes',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule, LoadStateComponent, SidePeekComponent, RhReclutamientoMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rv-page">
      <app-rh-reclutamiento-marco subtitulo="Las vacantes que se publican. Una vacante cerrada se desactiva: no se borra, porque hay candidatos que se postularon a ella.">
        <div acciones class="rv-btns">
          @if (gestiona()) { <p-button icon="pi pi-plus" label="Nueva vacante" severity="secondary" [outlined]="true" (onClick)="editar(null)" /> }
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        </div>
      </app-rh-reclutamiento-marco>

      <app-load-state [loading]="loading() && !vacantes().length" [error]="error()" [isEmpty]="!loading() && !error() && !vacantes().length"
                      emptyIcon="pi-briefcase" emptyTitle="No hay vacantes" [emptyHint]="gestiona() ? 'Publica la primera con «Nueva vacante».' : null" (retry)="cargar()">
        <section class="rv-card" aria-label="Vacantes">
          <div class="rv-scroll dt-scope">
            <table class="rv-tabla dt-stack">
              <thead><tr>
                <th scope="col">Vacante</th><th scope="col">Área</th><th scope="col">Plazas</th><th scope="col">Sueldo</th>
                <th scope="col">Horario</th><th scope="col">Estado</th>
              </tr></thead>
              <tbody>
                @for (v of vacantes(); track v.id) {
                  <tr [class.inactiva]="!v.is_active">
                    <td class="dt-id" role="cell">
                      @if (gestiona()) { <button type="button" class="rv-nom" (click)="editar(v)">{{ v.name }}</button> } @else { <b>{{ v.name }}</b> }
                    </td>
                    <td role="cell" data-label="Área">{{ v.area || '—' }}</td>
                    <td role="cell" data-label="Plazas">{{ plazas(v) }}</td>
                    <td role="cell" data-label="Sueldo">{{ v.salary_text || '—' }}</td>
                    <td role="cell" data-label="Horario">{{ v.schedule_text || '—' }}</td>
                    <td role="cell" data-label="Estado"><span class="pill" [attr.data-t]="v.is_active ? 'ok' : 'gris'">{{ v.is_active ? 'Publicada' : 'Cerrada' }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="rv-pie">{{ activas() }} publicada(s) · {{ vacantes().length - activas() }} cerrada(s)</p>
        </section>
      </app-load-state>

      <app-side-peek [open]="peek()" (openChange)="peek.set($event)" [title]="form()?.id ? 'Editar vacante' : 'Nueva vacante'" [subtitle]="form()?.name || null">
        @if (form(); as f) {
          <form class="rv-form" (ngSubmit)="guardar()" aria-label="Datos de la vacante">
            <label>Nombre <input pInputText name="name" [(ngModel)]="f.name" required maxlength="200" /></label>
            <label>Área <input pInputText name="area" [(ngModel)]="f.area" /></label>
            <fieldset class="rv-suc">
              <legend>Sucursales donde se contrata</legend>
              <small>Sin ninguna marcada, la vacante sale en todas las ciudades de la bolsa de trabajo.</small>
              @for (s of sucursales; track s.id) {
                <label class="rv-check"><input type="checkbox" [checked]="f.branch_codes.includes(s.id)" (change)="alternar(f, s.id)" /> {{ s.ciudad }} — {{ sucursalCorta(s.direccion) }}</label>
              }
            </fieldset>
            <label>Plazas (texto que se publica, opcional) <input pInputText name="plazas" [(ngModel)]="f.branches_text" placeholder="Zamora y La Piedad" /></label>
            <label>Sueldo <input pInputText name="sueldo" [(ngModel)]="f.salary_text" placeholder="$2,300 semanales" /></label>
            <label>Horario <input pInputText name="horario" [(ngModel)]="f.schedule_text" /></label>
            <label>Requisitos <textarea pInputText name="req" rows="3" [(ngModel)]="f.requirements"></textarea></label>
            <label>Descripción <textarea pInputText name="desc" rows="3" [(ngModel)]="f.description"></textarea></label>
            <label>Imagen (liga) <input pInputText name="img" [(ngModel)]="f.image_url" /></label>
            <label>Orden <input pInputText type="number" name="orden" [(ngModel)]="f.sort_order" /></label>
            <label class="rv-check"><input type="checkbox" name="activa" [(ngModel)]="f.is_active" /> Publicada</label>
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
    .rv-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .rv-scroll { overflow-x: auto; }
    .rv-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rv-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rv-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rv-tabla tr.inactiva td { color: var(--text-muted); }
    .rv-nom { border: 0; background: none; padding: 0; font: inherit; font-weight: 700; color: var(--text-main); cursor: pointer; text-align: left; }
    .rv-nom:hover { text-decoration: underline; }
    .rv-nom:focus-visible { outline: 2px solid var(--focus-ring); }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='ok'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .rv-pie { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); border-top: 1px solid var(--border-color); }
    .rv-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .rv-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-form .rv-check { flex-direction: row; align-items: center; gap: var(--sp-2); }
    .rv-suc { border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); margin: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .rv-suc legend { font-size: var(--fs-xs); color: var(--text-muted); padding: 0 var(--sp-1); }
    .rv-suc small { font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
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
  readonly activas = computed(() => this.vacantes().filter((v) => v.is_active).length);

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
