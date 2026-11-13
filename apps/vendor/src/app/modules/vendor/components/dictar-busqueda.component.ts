import { ChangeDetectionStrategy, Component, OnDestroy, input, output, signal } from '@angular/core';
import { consultaDeDictado } from '@megadulces/ui-web';
import { dictar, puedeDictar } from '../dictado';

/**
 * `[MCP.26]` **El micrófono de un buscador de productos: buscar dictando.**
 *
 * Lo usan Tomar pedido, Cotización y el checador de precios, al lado del botón de la cámara. La
 * vendedora en ruta trae una mano ocupada: decir «bombón de la rosa de un kilo» es más rápido que
 * teclearlo.
 *
 * Lo dicho NO va al campo tal cual: Kepler escribe «LA ROSA BOMBON 1KG» y la frase completa no
 * encuentra nada (medido: 0 de 1,963). `consultaDeDictado` la convierte («bombón rosa 1 k») y eso es
 * lo que se escribe en el campo, así que lo que se ve es lo que se busca y se puede corregir a mano.
 *
 * Reglas:
 *  - **Sin reconocimiento de voz en el navegador no se pinta** (el teclado sigue ahí, con su propio
 *    micrófono si el teléfono lo trae).
 *  - **Nunca se queda callado:** si no hubo permiso, no se escuchó o sólo se oyeron palabras de
 *    enlace, `error()` lo dice; el padre lo pinta debajo del buscador.
 *  - **El micrófono se apaga** al terminar la frase, al tocar otra vez y al salir de la pantalla.
 *
 * El dictado y la cámara se repiten por app porque ninguna librería hospeda componentes de Angular
 * (deuda `[VTK.17.D1]`); la conversión, que es la regla, sí vive en `@megadulces/ui-web`.
 */
@Component({
  selector: 'app-dictar-busqueda',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (disponible) {
      <button type="button" class="db-btn" [class.on]="escuchando()" [attr.aria-pressed]="escuchando()"
        [attr.aria-label]="escuchando() ? 'Escuchando: toca para parar' : etiqueta()"
        [title]="escuchando() ? 'Escuchando: toca para parar' : etiqueta()" (click)="alternar()">
        <i class="pi" [class.pi-microphone]="!escuchando()" [class.pi-stop-circle]="escuchando()" aria-hidden="true"></i>
      </button>
    }
  `,
  styles: [`
    :host { display: block; flex: none; }
    :host:empty { display: none; }
    .db-btn {
      display: grid; place-items: center;
      min-width: max(var(--tap-min), 2.5rem); min-height: max(var(--tap-min), 2.5rem);
      border: 1px solid var(--border-color); border-radius: var(--r-pill);
      background: var(--card-bg); color: var(--text-main); cursor: pointer;
    }
    .db-btn i { font-size: var(--fs-h3); }
    .db-btn.on { border-color: var(--action); color: var(--action); }
    .db-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class DictarBusquedaComponent implements OnDestroy {
  /** Lo que dice el botón al lector de pantalla (y su `title`). */
  readonly etiqueta = input('Buscar dictando el producto');

  /** La búsqueda ya convertida («bombón rosa 1 k»). Sale con cada parte que reconoce, no sólo al final. */
  readonly texto = output<string>();

  /** ¿Este navegador puede dictar? Si no, el componente no pinta nada. */
  readonly disponible = puedeDictar();
  readonly escuchando = signal(false);
  /** Por qué no se buscó nada en el último intento. `null` = salió bien o no se ha intentado. */
  readonly error = signal<string | null>(null);

  private parar: (() => void) | null = null;

  alternar(): void {
    if (this.escuchando()) { this.parar?.(); return; }
    this.error.set(null);
    this.escuchando.set(true);
    let busco = false;
    this.parar = dictar(
      (frase) => {
        const q = consultaDeDictado(frase);
        if (!q) return;
        busco = true;
        this.texto.emit(q);
      },
      (error) => {
        this.escuchando.set(false);
        this.parar = null;
        this.error.set(error ?? (busco ? null : 'No se escuchó ningún producto. Toca el micrófono y dilo otra vez.'));
      },
    );
    // `dictar` devuelve null cuando no pudo abrir el micrófono (y ya avisó por `alTerminar`).
    if (!this.parar && !this.error()) {
      this.escuchando.set(false);
      this.error.set('No se pudo abrir el micrófono.');
    }
  }

  ngOnDestroy(): void {
    this.parar?.();
  }
}
