import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePickerModule } from 'primeng/datepicker';
import { PeriodoFicha, PresetPeriodo, periodoDe } from '../periodo-ficha';

/** `YYYY-MM-DD` → `Date` local (sin correr de día por la zona horaria). */
const aFecha = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Lo más atrás que se puede elegir: el servidor (`periodoFicha`) acepta a lo más 731 días, hoy incluido. */
const DIAS_ATRAS = 730;

/**
 * `[PF.23]` El periodo de la ficha, como CALENDARIO de rango (pedido de David, 2026-11-04: «lo quiero como un
 * calendario», no un menú). Muestra siempre las fechas que se están viendo: al abrir, las del periodo de por
 * omisión. Elegir dos fechas (o una: ese día) y cerrar aplica; «Limpiar» vuelve al de por omisión.
 * Emite el periodo elegido, o `null` = el de por omisión (lo decide el servidor).
 *
 * El periodo vigente lo guarda la FICHA (`valor`), no este control: si la ficha se reconstruye (p. ej. tras un error y
 * «Reintentar»), el calendario vuelve a mostrar lo que la ficha está pidiendo — nunca «este mes» con datos de otro
 * periodo — y «Limpiar» siempre puede regresar al de por omisión.
 */
@Component({
  selector: 'app-periodo-ficha',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePickerModule],
  template: `
    <p-datepicker [ngModel]="rango()" (ngModelChange)="rango.set($event)" selectionMode="range" dateFormat="dd/mm/yy"
                  [minDate]="minimo" [maxDate]="hoy" [readonlyInput]="true" [showIcon]="true" [showButtonBar]="true" [numberOfMonths]="1"
                  appendTo="body" [ariaLabel]="etiqueta()" placeholder="Desde – hasta" styleClass="pf-fechas"
                  (onClose)="aplicar()" (onClearClick)="limpiar()" />
  `,
  styles: [`:host { display: inline-block; }`],
})
export class PeriodoFichaComponent {
  /** El periodo con que nace el bloque (el que usa el servidor sin fechas): es lo que muestra al abrir. */
  readonly porOmision = input<Exclude<PresetPeriodo, 'otro'>>('mes');
  /** El periodo que la ficha está pidiendo AHORA; null = el de por omisión. */
  readonly valor = input<PeriodoFicha | null>(null);
  readonly etiqueta = input('Periodo');
  readonly cambio = output<PeriodoFicha | null>();

  readonly hoy = new Date();
  readonly minimo = new Date(this.hoy.getFullYear(), this.hoy.getMonth(), this.hoy.getDate() - DIAS_ATRAS);
  /** Las fechas a la vista: las de la ficha, o el periodo de por omisión (las dos señales se leen siempre). */
  private readonly vigente = computed<PeriodoFicha | null>(() => {
    const v = this.valor();
    const o = periodoDe(this.porOmision(), null, this.hoy);
    return v ?? o;
  });
  /** El modelo del calendario. Sigue a lo vigente; mientras se elige, lleva la selección a medias. */
  readonly rango = signal<(Date | null)[] | null>(null);

  constructor() {
    // Al nacer y cada vez que la ficha cambia de periodo, el calendario muestra lo vigente (nunca un campo vacío).
    effect(() => {
      const v = this.vigente();
      untracked(() => this.rango.set(v ? [aFecha(v.desde), aFecha(v.hasta)] : null));
    });
  }

  private mostrarVigente(): void {
    const v = this.vigente();
    this.rango.set(v ? [aFecha(v.desde), aFecha(v.hasta)] : null);
  }

  /** Al cerrar: con una fecha, ese día; con dos, el rango. Sin ninguna, o el mismo de ahora, vuelve a lo vigente. */
  aplicar(): void {
    const p = periodoDe('otro', this.rango());
    const actual = this.vigente();
    if (!p || (actual && actual.desde === p.desde && actual.hasta === p.hasta)) { this.mostrarVigente(); return; }
    const omision = periodoDe(this.porOmision(), null, this.hoy);
    const esOmision = !!omision && omision.desde === p.desde && omision.hasta === p.hasta;
    this.cambio.emit(esOmision ? null : p);
  }

  /** «Limpiar»: vuelve al periodo de por omisión (si la ficha pedía otro). */
  limpiar(): void {
    if (this.valor() !== null) this.cambio.emit(null);
    else this.mostrarVigente();
  }
}
