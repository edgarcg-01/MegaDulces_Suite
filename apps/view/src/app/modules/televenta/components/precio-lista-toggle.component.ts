import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

/**
 * `[COT.55]` «Solo precio 1 (sin mayoreo)»: la cotización se cobra al precio de lista de la
 * presentación, sin el precio por volumen del ERP. Promociones y % del cliente sí aplican.
 *
 * Nace del valor del cliente; moverlo (y fijarlo para el cliente) es de supervisores y Dirección
 * (`COMMERCIAL_QUOTES_PRECIO_LISTA`). Quien no lo tiene ve el estado, no lo mueve, y lo lee escrito.
 * Lo usan el alta y el borrador: el componente sólo pinta y avisa; quien lo usa decide qué hacer.
 */
@Component({
  selector: 'app-precio-lista-toggle',
  standalone: true,
  imports: [FormsModule, ToggleSwitchModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pl">
      <div class="pl-fila">
        <p-toggleswitch
          inputId="precioListaSwitch"
          [ngModel]="valor()"
          (ngModelChange)="cambiar.emit(!!$event)"
          [disabled]="!puede() || ocupado()"
          ariaLabelledBy="precioListaLabel"
        />
        <label id="precioListaLabel" for="precioListaSwitch" class="pl-label">Solo precio 1 (sin mayoreo)</label>
      </div>
      <!-- El estado va escrito: sin mouse y sin color también se entiende. -->
      @if (nota() || ofrecerFijar()) {
        <p class="pl-nota">
          {{ nota() ?? '' }}
          @if (ofrecerFijar()) {
            {{ nota() ? ' ' : '' }}<button type="button" class="pl-fijar" [disabled]="ocupado()" (click)="fijarCliente.emit()">Dejarlo así para este cliente</button>
          }
        </p>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .pl { display: flex; flex-direction: column; gap: var(--sp-1); }
      .pl-fila { display: flex; align-items: center; gap: var(--sp-2); }
      .pl-label { font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; }
      .pl-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
      .pl-fijar {
        background: none; border: 0; padding: 0; font: inherit; color: var(--text-main);
        text-decoration: underline; cursor: pointer;
      }
      .pl-fijar:disabled { cursor: default; opacity: 0.6; }
      .pl-fijar:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 2px; }
    `,
  ],
})
export class PrecioListaToggleComponent {
  /** Lo que tiene la cotización. */
  readonly valor = input(false);
  /** Lo que tiene el cliente por defecto; null = sin cliente de Kepler (o no se pudo leer). */
  readonly delCliente = input<boolean | null>(null);
  /** Tiene COMMERCIAL_QUOTES_PRECIO_LISTA. */
  readonly puede = input(false);
  /** Guardando o re-cotizando: no se mueve a medias. */
  readonly ocupado = input(false);

  readonly cambiar = output<boolean>();
  readonly fijarCliente = output<void>();

  /** Con permiso y cliente, si la cotización quedó distinta a lo del cliente, se ofrece fijarlo. */
  readonly ofrecerFijar = computed(() => this.puede() && this.delCliente() !== null && this.valor() !== this.delCliente());

  readonly nota = computed<string | null>(() => textoPrecioLista(this.valor(), this.delCliente(), this.puede()));
}

/** `[COT.55]` La línea de estado, en palabras. Pura para poder probarla. */
export function textoPrecioLista(valor: boolean, delCliente: boolean | null, puede: boolean): string | null {
  if (!puede) return delCliente === true && valor ? 'Así lo tiene el cliente. Lo cambia un supervisor.' : 'Lo cambia un supervisor.';
  if (delCliente === true && valor) return 'Así lo tiene el cliente.';
  if (delCliente !== null && valor !== delCliente) return valor ? 'El cliente va con mayoreo.' : 'El cliente va a precio 1.';
  return null;
}
