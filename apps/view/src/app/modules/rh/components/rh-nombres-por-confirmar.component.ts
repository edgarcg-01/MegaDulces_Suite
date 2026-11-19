import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { firstValueFrom } from 'rxjs';
import type { HrNombrePorConfirmarDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhService, rhError } from '../rh.service';

interface Renglon { nombre: string; alReloj: boolean; guardando: boolean; error: string | null }

/**
 * Fase RH · `[RH.14.4]` — Nombres por confirmar: las personas activas, sin acceso a la Suite, cuyo nombre es el apodo del
 * reloj o tiene menos de 3 palabras (212 de 513 activas el 18-nov). RH escribe el nombre completo y, si quiere, lo manda
 * también a los relojes donde checa (23 letras, sin acentos: la orden `renombrar` de siempre). Un formulario por renglón:
 * Enter guarda ese renglón y lo guardado sale de la lista.
 */
@Component({
  selector: 'app-rh-nombres-por-confirmar',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="np">
      <div class="np-head">
        <p class="np-cuenta">{{ filas()?.length ?? '—' }} por confirmar</p>
        <div class="np-seg" role="group" aria-label="De qué plazas">
          <button type="button" [attr.aria-pressed]="!todas()" (click)="todas.set(false)" [disabled]="!sitio()">Esta plaza</button>
          <button type="button" [attr.aria-pressed]="todas()" (click)="todas.set(true)">Todas las plazas</button>
        </div>
      </div>
      <app-load-state [loading]="loading() && !filas()" [error]="error()" [isEmpty]="!loading() && !error() && filas()?.length === 0"
                      emptyIcon="pi-check" emptyTitle="Nada por confirmar"
                      (retry)="cargar()">
        @if (aviso(); as a) { <p class="np-aviso" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
        <ul class="np-lista">
          @for (f of filas(); track f.user_id) {
            @let r = renglon(f);
            <li>
              <form class="np-fila" (ngSubmit)="guardar(f)" [attr.aria-label]="'Nombre completo de ' + f.nombre">
                <div class="np-quien">
                  <span class="np-apodo">{{ f.nombre }}@if (f.nombre_reloj && f.nombre_reloj !== f.nombre) { <small>· reloj: {{ f.nombre_reloj }}</small> }</span>
                  <small>@for (p of f.plazas; track p.site_code + p.person_code; let ultimo = $last) { #{{ p.person_code }} {{ p.site_name }}{{ ultimo ? '' : ' · ' }} }</small>
                </div>
                <label class="np-campo"><span class="sr-only">Nombre completo</span>
                  <input pInputText [name]="'n' + f.user_id" [ngModel]="r.nombre" (ngModelChange)="editar(f, { nombre: $event })" autocomplete="off"
                         placeholder="Nombre y apellidos" [attr.aria-invalid]="!!r.error" /></label>
                @if (puedeEditar()) {
                  <label class="np-check"><input type="checkbox" [name]="'r' + f.user_id" [ngModel]="r.alReloj" (ngModelChange)="editar(f, { alReloj: $event })" />
                    Reloj</label>
                  <p-button type="submit" label="Guardar" size="small" [disabled]="!valido(r.nombre)" [loading]="r.guardando" />
                }
                @if (r.error) { <p class="np-error" role="alert">{{ r.error }}</p> }
              </form>
            </li>
          }
        </ul>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .np { display: flex; flex-direction: column; gap: var(--sp-3); }
    .np-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
        .np-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; background: var(--card-bg); }
    .np-seg button { border: 0; background: none; color: var(--text-muted); padding: var(--sp-2) var(--sp-3); font: inherit; font-size: var(--fs-sm); cursor: pointer; min-height: var(--tap-min); }
    .np-seg button + button { border-left: 1px solid var(--border-color); }
    .np-seg button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .np-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .np-seg button:disabled { cursor: default; opacity: .6; }
    .np-cuenta { margin: 0; flex: 1 1 auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .np-aviso { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .np-aviso.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .np-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .np-lista li { border-top: 1px solid var(--border-color); }
    .np-fila { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-2) 0; }
    .np-quien { display: flex; flex-direction: column; flex: 1 1 14rem; min-width: 0; }
    .np-apodo { font-weight: 600; color: var(--text-main); font-size: var(--fs-sm); }
    .np-quien small { font-size: var(--fs-xs); color: var(--text-muted); }
    .np-campo { flex: 2 1 16rem; }
    .np-campo input { width: 100%; min-height: var(--tap-min); }
    .np-check { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-main); min-height: var(--tap-min); }
    .np-error { flex: 1 1 100%; margin: 0; font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    :host ::ng-deep .p-button { min-height: var(--tap-min); }
  `],
})
export class RhNombresPorConfirmarComponent {
  private readonly api = inject(RhService);

  /** La plaza en pantalla (la lista abre con ella; «Todas las plazas» quita el filtro). */
  readonly sitio = input<string | null>(null);
  readonly puedeEditar = input(false);
  /** Se guardó al menos un nombre: el padre vuelve a leer la asistencia. */
  readonly cambio = output<void>();

  readonly todas = signal(false);
  readonly filas = signal<HrNombrePorConfirmarDto[] | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  private readonly renglones = signal(new Map<string, Renglon>());
  private seq = 0;

  private readonly filtro = computed(() => (this.todas() || !this.sitio() ? null : this.sitio()));

  constructor() {
    effect(() => { this.filtro(); untracked(() => this.cargar()); });
  }

  cargar(): void {
    const mi = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.nombresPorConfirmar(this.filtro()).subscribe({
      next: (r) => { if (mi !== this.seq) return; this.filas.set(r.filas); this.loading.set(false); },
      error: (e) => { if (mi !== this.seq) return; this.filas.set(null); this.error.set(rhError(e, 'No se pudo leer la lista de nombres.')); this.loading.set(false); },
    });
  }

  renglon(f: HrNombrePorConfirmarDto): Renglon {
    return this.renglones().get(f.user_id) ?? { nombre: f.motivo === 'menos_de_3_palabras' ? f.nombre : '', alReloj: true, guardando: false, error: null };
  }

  editar(f: HrNombrePorConfirmarDto, cambio: Partial<Renglon>): void {
    const m = new Map(this.renglones());
    m.set(f.user_id, { ...this.renglon(f), ...cambio, ...(cambio.nombre !== undefined ? { error: null } : {}) });
    this.renglones.set(m);
  }

  /** Lo mismo que pide el servidor: nombre y al menos un apellido. */
  valido(nombre: string): boolean {
    return nombre.trim().split(/\s+/).filter(Boolean).length >= 2;
  }

  async guardar(f: HrNombrePorConfirmarDto): Promise<void> {
    const r = this.renglon(f);
    const [plaza] = f.plazas;
    if (!plaza || !this.valido(r.nombre) || r.guardando) return;
    this.editar(f, { guardando: true, error: null });
    const nombre = r.nombre.replace(/\s+/g, ' ').trim();
    try {
      await firstValueFrom(this.api.editarFicha({ site_code: plaza.site_code, person_code: plaza.person_code, nombre }));
    } catch (e) {
      this.editar(f, { guardando: false, error: rhError(e, 'No se pudo guardar el nombre.') });
      return;
    }
    // El nombre ya quedó; el reloj es aparte: si falla, se dice, pero no se deshace lo guardado.
    let relojes = 0;
    const fallos: string[] = [];
    if (r.alReloj) {
      for (const p of f.plazas) {
        try { relojes += (await firstValueFrom(this.api.renombrar(p.site_code, p.person_code, nombre))).relojes; }
        catch (e) { fallos.push(`${p.site_name}: ${rhError(e, 'no se pudo')}`); }
      }
    }
    this.filas.set((this.filas() ?? []).filter((x) => x.user_id !== f.user_id));
    this.aviso.set(fallos.length
      ? { texto: `Guardado: ${nombre} · falló el reloj de ${fallos.join(' · ')}`, mal: true }
      : { texto: `Guardado: ${nombre}${relojes ? ' · enviado al reloj' : ''}`, mal: false });
    this.cambio.emit();
  }
}
