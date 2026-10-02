import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';

import { DataScopeService } from '../../../core/services/data-scope.service';

/**
 * `[ZN.7]` — **El selector de sucursal, una sola vez.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Censadas 16 pantallas que dejan elegir sucursal, y arman la lista de **seis maneras
 * distintas**: el alcance del usuario, tres endpoints propios, un endpoint PUBLICO, un array
 * en el bundle y un array escrito a mano dentro del componente. Sólo seis de las dieciséis
 * pasan por el alcance; el resto ofrece sucursales que a la persona no le tocan — y el array
 * a mano de Logística se quedó en 00-06, o sea que desde esa pantalla **Morelia no se puede
 * filtrar** y dos opciones se llaman "04" y "05" a secas.
 *
 * El primitivo correcto ya existía (`DataScopeService.misSucursales()`, de `[ZN.2]`) y nunca
 * se generalizó: es el modo de falla de ADR-056 otra vez. Esto lo cierra del lado del consumo.
 *
 * ── Los CUATRO estados, que no son tres ─────────────────────────────────────────────────────
 * El idiom sale de `comercial-tickets`, que ya lo tenía bien, y se conserva tal cual:
 *
 *   · `null`      el alcance todavía no contestó  → no se pinta nada (no es "ninguna")
 *   · `[]`        contestó y no te toca ninguna   → se DECLARA, no se deja vacío
 *   · una sola    es un hecho de la sesión        → etiqueta fija, no un desplegable de 1
 *   · varias      ahí sí, un selector
 *
 * ⛔ `null` y `[]` se ven igual si se colapsan, y significan cosas opuestas. Colapsarlos es
 * justo el defecto que `[ZN.2]` encontró en compras, donde "no cargó" se leía como "ves todo"
 * y por las dudas se ofrecían las nueve.
 *
 * ── Lo que este componente NO hace ──────────────────────────────────────────────────────────
 * No decide seguridad: el backend recorta igual con `ScopeService`. Acá se decide qué se
 * OFRECE, para que nadie elija algo que el servidor le va a negar — ni al revés, que es peor:
 * una pantalla que ofrece nueve sucursales y devuelve dos se lee como que está rota.
 *
 * Tampoco auto-selecciona cuando hay una sola. El valor sigue siendo del padre y `null` sigue
 * queriendo decir "sin filtro explícito"; el servidor ya acota. Emitirlo solo cambiaría el
 * comportamiento de cada pantalla que lo adopte, y esto es un cambio de presentación.
 */
/**
 * `[ZN.7]` Estrecha lo que emite el picker a UN código. Vive acá y no copiado en cada pantalla:
 * en modo simple el `model` igual está tipado como `string | string[] | null`, y resolverlo con
 * un ternario por componente es el mismo primitivo escrito N veces que esta fase vino a cerrar.
 */
export const unCodigo = (v: string | string[] | null): string | null =>
  Array.isArray(v) ? (v[0] ?? null) : v;

@Component({
  selector: 'app-sucursal-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, MultiSelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (opciones(); as ops) {
      @if (ops.length > 1) {
        @if (multiple()) {
          <p-multiselect [options]="ops" [ngModel]="valor()" (ngModelChange)="valor.set($event)"
                         optionLabel="label" optionValue="value" appendTo="body" display="chip"
                         [filter]="ops.length > 8" [showClear]="true"
                         [placeholder]="placeholder()" [ariaLabel]="etiqueta()"
                         class="sp-ctl" />
        } @else {
          <p-select [options]="ops" [ngModel]="valor()" (ngModelChange)="valor.set($event)"
                    optionLabel="label" optionValue="value" appendTo="body"
                    [filter]="ops.length > 8" [showClear]="true"
                    [placeholder]="placeholder()" [ariaLabel]="etiqueta()"
                    class="sp-ctl" />
        }
      } @else if (ops.length === 1) {
        <!-- Una sola alcanzable: es un hecho de la sesion, no una opcion. -->
        <span class="sp-fija">
          <i class="pi pi-building" aria-hidden="true"></i>{{ ops[0].label }}
        </span>
      } @else {
        <!-- Contesto y no te toca ninguna. Se DECLARA: un hueco mudo se lee como "todas". -->
        <span class="sp-fija sp-sin" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>Sin sucursal asignada
        </span>
      }
    }
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; min-width: 0; }
    .sp-ctl { min-width: 13rem; }
    .sp-fija {
      display: inline-flex; align-items: center; gap: var(--sp-2);
      font-size: var(--fs-sm); color: var(--text-muted); white-space: nowrap;
    }
    .sp-sin { color: var(--warn-fg, var(--text-muted)); }
  `],
})
export class SucursalPickerComponent {
  private readonly scope = inject(DataScopeService);

  /** El código de sucursal elegido, o el arreglo de códigos con `multiple`. */
  readonly valor = model<string | string[] | null>(null);
  readonly multiple = input(false);
  readonly placeholder = input('Todas las sucursales');
  readonly etiqueta = input('Sucursal');

  /**
   * `null` mientras `me/scope` no conteste. Se propaga tal cual al template a propósito: es la
   * diferencia entre «todavía no sé» y «ninguna», y el `@if` de arriba las trata distinto.
   */
  readonly opciones = computed(() => this.scope.misSucursales()());
}
