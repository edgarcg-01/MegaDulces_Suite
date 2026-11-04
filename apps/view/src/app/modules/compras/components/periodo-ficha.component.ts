import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePickerModule } from 'primeng/datepicker';
import { PeriodoFicha, PresetPeriodo, periodoDe } from '../periodo-ficha';

/** `YYYY-MM-DD` → `Date` local (sin correr de día por la zona horaria). */
const aFecha = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * `[PF.23]` El periodo de la ficha, como CALENDARIO de rango (pedido de David, 2026-11-04: «lo quiero como un
 * calendario», no un menú). Muestra siempre las fechas que se están viendo: al abrir, las del periodo de por
 * omisión. Elegir dos fechas (o una: ese día) y cerrar aplica; «Limpiar» vuelve al de por omisión.
 * Emite el periodo elegido, o `null` = el de por omisión (lo decide el servidor).
 */
@Component({
  selector: 'app-periodo-ficha',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePickerModule],
  template: `
    <p-datepicker [ngModel]="rango()" (ngModelChange)="rango.set($event)" selectionMode="range" dateFormat="dd/mm/yy"
                  [maxDate]="hoy" [readonlyInput]="true" [showIcon]="true" [showButtonBar]="true" [numberOfMonths]="1"
                  appendTo="body" [ariaLabel]="etiqueta()" placeholder="Desde – hasta" styleClass="pf-fechas"
                  (onClose)="aplicar()" (onClearClick)="limpiar()" />
  `,
  styles: [`:host { display: inline-block; }`],
})
export class PeriodoFichaComponent {
  /** El periodo con que nace el bloque (el que usa el servidor sin fechas): es lo que muestra al abrir. */
  readonly porOmision = input<Exclude<PresetPeriodo, 'otro'>>('mes');
  readonly etiqueta = input('Periodo');
  readonly cambio = output<PeriodoFicha | null>();

  readonly hoy = new Date();
  /** Lo que el usuario eligió; null = el de por omisión. */
  private readonly elegido = signal<PeriodoFicha | null>(null);
  /** Las fechas a la vista: lo elegido, o el periodo de por omisión (las dos señales se leen siempre). */
  private readonly vigente = computed<PeriodoFicha | null>(() => {
    const e = this.elegido();
    const o = periodoDe(this.porOmision(), null, this.hoy);
    return e ?? o;
  });
  /** El modelo del calendario. Arranca con el periodo vigente; mientras se elige, lleva la selección a medias. */
  readonly rango = signal<(Date | null)[] | null>(null);

  constructor() {
    // Al nacer muestra el periodo de por omisión (no un campo vacío que haría creer que no hay filtro).
    queueMicrotask(() => this.mostrarVigente());
  }

  private mostrarVigente(): void {
    const v = this.vigente();
    this.rango.set(v ? [aFecha(v.desde), aFecha(v.hasta)] : null);
  }

  /** Al cerrar: con una fecha, ese día; con dos, el rango. Sin ninguna, vuelve a mostrar lo vigente. */
  aplicar(): void {
    const p = periodoDe('otro', this.rango());
    if (!p) { this.mostrarVigente(); return; }
    const actual = this.vigente();
    if (actual && actual.desde === p.desde && actual.hasta === p.hasta) { this.mostrarVigente(); return; }
    const omision = periodoDe(this.porOmision(), null, this.hoy);
    const esOmision = !!omision && omision.desde === p.desde && omision.hasta === p.hasta;
    this.elegido.set(esOmision ? null : p);
    this.mostrarVigente();
    this.cambio.emit(esOmision ? null : p);
  }

  /** «Limpiar»: vuelve al periodo de por omisión. */
  limpiar(): void {
    const habia = this.elegido() !== null;
    this.elegido.set(null);
    this.mostrarVigente();
    if (habia) this.cambio.emit(null);
  }
}
