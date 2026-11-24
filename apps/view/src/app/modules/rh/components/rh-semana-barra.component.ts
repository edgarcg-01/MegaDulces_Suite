import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MultiSelectModule } from 'primeng/multiselect';
import { PopoverModule } from 'primeng/popover';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { aplicarCambio, etiquetaPersonas, haySeleccion, opcionesPersonas, valorSeleccion } from '../personas-seleccion';

/**
 * `[RH.18.11]` (David, 24-nov: «lo quiero más simple») La cabecera de Asistencia baja de 7 franjas a 3. Dos piezas
 * que antes eran franjas propias del marco pasan a la fila de modos (Semana · Faltas · Tolerancia):
 *
 * - **Filtros**: Personas y Planta/Promotoras se pliegan en un globo. El botón dice cuántos están puestos, para que
 *   nada filtre sin que se vea (el resumen «4 personas de promotoría · solo SISTEMAS» también lo dice).
 * - **Avisos en línea**: cuándo se puede cerrar la semana en curso, quién checa sin estar ligado y los nombres por
 *   confirmar, cada uno con el botón que lo arregla. El aviso que PIDE algo (la semana terminó y no se cerró) no
 *   viene aquí: sigue siendo su propio aviso en el marco, para que no se pierda en una línea gris.
 */
@Component({
  selector: 'app-rh-filtros',
  standalone: true,
  imports: [FormsModule, MultiSelectModule, PopoverModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="mc-filtros-btn" [attr.aria-expanded]="pop.overlayVisible()"aria-haspopup="dialog"
            [attr.aria-label]="activos() ? 'Filtros: ' + activos() + ' puesto' + (activos() === 1 ? '' : 's') : 'Filtros'" (click)="pop.toggle($event)">
      <i class="pi pi-sliders-h" aria-hidden="true"></i> Filtros@if (activos()) {&ngsp;<b class="mc-filtros-n">{{ activos() }}</b> }
    </button>
    <p-popover #pop appendTo="body" ariaLabel="Filtros">
      <div class="mf-pop">
        @if (personas()) {
          <!-- [RH.13.5] «Aquí es plaza y personas también» (David, 12-nov): toda la plaza, departamentos enteros, personas
               sueltas o una sola, en un solo campo (el de Mega Talento). Marcar el departamento marca a los suyos. -->
          <label class="mf-l" for="mf-personas">Personas</label>
          <p-multiselect inputId="mf-personas" [options]="opc()" optionLabel="label" optionValue="value" [ngModel]="valor()"
                         (ngModelChange)="cambiar($event)" placeholder="Toda la plaza"
                         [filter]="true" filterBy="label,codigo" filterPlaceholder="Buscar nombre o número" [showToggleAll]="false"
                         emptyFilterMessage="Nadie coincide en esta plaza" scrollHeight="22rem" appendTo="body"
                         class="mf-personas" panelStyleClass="mc-personas-panel">
            <ng-template #selecteditems>@if (etiqueta(); as e) { <span class="mf-per-sel">{{ e }}</span> }</ng-template>
            <ng-template #item let-o>
              @if (o.tipo === 'depto') {
                <span class="mf-per-dep">{{ o.label }}</span><small class="mf-per-n">{{ o.n }}</small>
              } @else {
                <span class="mf-per-nom">{{ o.label }}</span><small class="mf-per-n mono">#{{ o.codigo }}</small>
              }
            </ng-template>
          </p-multiselect>
        }
        <span class="mf-l" id="mf-quien">A quién</span>
        <div class="mf-seg" role="group" aria-labelledby="mf-quien">
          <button type="button" [attr.aria-pressed]="!est.soloPromotoras()" (click)="est.setPromotoras(false)">Personal de planta</button>
          <button type="button" [attr.aria-pressed]="est.soloPromotoras()" (click)="est.setPromotoras(true)">Promotoras</button>
        </div>
      </div>
    </p-popover>
  `,
  styles: [`
    :host { display: inline-flex; }
    .mc-filtros-btn { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg);
      color: var(--text-main); padding: 0 var(--sp-3); font: inherit; font-size: var(--fs-sm); cursor: pointer; min-height: max(var(--tap-min), 2.25rem); }
    .mc-filtros-btn[aria-expanded='true'] { background: var(--surface-selected-bg); }
    .mc-filtros-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .mc-filtros-n { min-width: 1.25rem; padding: 0 4px; border-radius: var(--r-pill); background: var(--action); color: var(--action-ink); font-size: var(--fs-micro); text-align: center; }
    .mf-pop { display: grid; gap: var(--sp-2); min-width: 16rem; max-width: 20rem; }
    .mf-l { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
    .mf-personas { width: 100%; }
    .mf-per-sel { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mf-per-dep { flex: 1 1 auto; font-weight: 700; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; }
    .mf-per-nom { flex: 1 1 auto; padding-left: var(--sp-3); }
    .mf-per-n { margin-left: var(--sp-2); color: var(--text-muted); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
    .mf-seg { display: flex; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; background: var(--card-bg); }
    .mf-seg button { flex: 1 1 0; border: 0; background: none; color: var(--text-muted); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); cursor: pointer;
      white-space: nowrap; min-height: var(--tap-min); }
    .mf-seg button + button { border-left: 1px solid var(--border-color); }
    .mf-seg button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .mf-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  `],
})
export class RhFiltrosComponent {
  readonly est = inject(RhAsistenciaEstado);
  /** Con el campo Personas (sólo Checadas: es un filtro del reporte). */
  readonly personas = input(false);

  private readonly gente = computed(() => this.est.datos()?.personas ?? []);
  private readonly seleccion = computed(() => ({ departamentos: this.est.departamentos(), elegidas: this.est.elegidas() }));
  /** Cuántos filtros están puestos. «Hoy» ya no cuenta: es el periodo, y se ve junto a la semana. */
  readonly activos = computed(() => (this.personas() && haySeleccion(this.seleccion()) ? 1 : 0) + (this.est.soloPromotoras() ? 1 : 0));
  readonly opc = computed(() => opcionesPersonas(this.gente()));
  readonly valor = computed(() => valorSeleccion(this.gente(), this.seleccion()));
  readonly etiqueta = computed(() => etiquetaPersonas(this.gente(), this.seleccion()));

  cambiar(v: string[] | null): void {
    const s = aplicarCambio(this.gente(), this.seleccion(), v ?? []);
    this.est.departamentos.set(s.departamentos);
    this.est.elegidas.set(s.elegidas);
  }
}

@Component({
  selector: 'app-rh-avisos-semana',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (curso(); as c) { <span class="ma-i">{{ c }}</span> }
    @if (est.sinLigar(); as n) {
      <!-- [RH.14.3] El aviso lleva a donde se arregla: la bandeja de códigos sin persona vive en el panel de Relojes. -->
      <span class="ma-i">{{ n }} sin ligar@if (veRelojes()) {&ngsp;<button type="button" class="ma-link" (click)="abrir({ panel: 'relojes' })">Ligar</button> }</span>
    }
    @if (est.nombresPendientes(); as k) {
      <!-- [RH.14.4] Quien tiene el apodo del reloj como nombre: se corrige en su panel, sin salir de Asistencia. -->
      <span class="ma-i">{{ k }} nombre{{ k === 1 ? '' : 's' }} por confirmar&ngsp;<button type="button" class="ma-link" (click)="abrir({ panel: 'nombres' })">{{ adminRelojes() ? 'Corregir' : 'Ver' }}</button></span>
    }
  `,
  styles: [`
    :host { display: contents; }
    .ma-i { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .ma-i::before { content: '·'; margin-right: var(--sp-2); color: var(--text-faint); }
    /* Donde la línea empieza con un aviso (el marco), el primero no lleva punto. */
    :host(.solo) .ma-i:first-child::before { content: none; }
    .ma-link { font: inherit; font-weight: 600; color: var(--text-main); background: none; border: 0; padding: 0 var(--sp-1); text-decoration: underline;
      cursor: pointer; min-height: var(--tap-min); }
    .ma-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class RhAvisosSemanaComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly router = inject(Router);
  private readonly perms = inject(PermissionsService);

  readonly adminRelojes = computed(() => this.perms.has(Permission.HR_DEVICES_GESTIONAR));
  readonly veRelojes = computed(() => this.perms.hasAny(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR));
  /** Sólo la semana en curso va en línea; lo que pide algo (terminó sin cerrar) o lo cerrado es aviso propio en el marco. */
  readonly curso = computed(() => { const c = this.est.cierreSemana(); return c?.tono === 'curso' ? c.texto : null; });

  abrir(q: Record<string, string>): void {
    void this.router.navigate(['/rh/asistencia'], { queryParams: q });
  }
}
