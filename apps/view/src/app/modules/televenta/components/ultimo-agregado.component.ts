import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** `[COT.46]` Lo último que se agregó a la lista de renglones. */
export interface UltimoAgregado {
  /** Id del renglón en la tabla (para «Ver en la lista»); null si no se pudo ubicar. */
  id: string | null;
  /** Número del renglón (la columna «#», el renglón del pedido en Kepler); null si no se sabe. */
  numero: number | null;
  nombre: string;
  /** «10 CJA · $2,573.02», ya formateado. */
  detalle: string;
  /** Se sumó a un renglón que ya estaba, en vez de abrir uno nuevo. */
  sumado: boolean;
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/** `[COT.46]` «10 CJA · $2,573.02»; sin importe (renglón sin precio) sólo la cantidad. */
export function textoAgregado(cantidad: number, unidad: string | null | undefined, importe: number | null | undefined): string {
  const cant = `${cantidad}${unidad ? ' ' + unidad : ''}`;
  return importe !== null && importe !== undefined && Number.isFinite(Number(importe)) ? `${cant} · ${MXN.format(Number(importe))}` : cant;
}

/**
 * `[COT.46]`/`[COT.47]` Baja al renglón (la tabla le pone `id="renglon-<id>"`), al centro de la vista,
 * y deja el cursor en su cantidad para seguir trabajando AHÍ (quien pidió verlo navegó a él).
 * Espera un cuadro (la tabla pudo tener que quitar un filtro para mostrarlo) y espera a que el
 * desplazamiento TERMINE antes de enfocar: `scrollIntoView` devuelve una promesa donde el navegador
 * la soporta, y donde no, `await undefined` sigue de inmediato (degrada sin romper). Sin
 * desplazamiento suave si la persona pidió reducir el movimiento en su sistema.
 */
export async function verRenglonEnLista(id: string): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  const el = document.getElementById('renglon-' + id);
  if (!el) return;
  const quieto = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  await (el.scrollIntoView({ block: 'center', behavior: quieto ? 'auto' : 'smooth' }) as unknown as Promise<void> | undefined);
  el.querySelector<HTMLInputElement>('input.qty-inline')?.focus({ preventScroll: true });
}

/**
 * `[COT.46]` La confirmación de lo que se acaba de agregar, DONDE ESTÁ LA VISTA: justo debajo del
 * buscador. En una lista larga el renglón nuevo cae al final de la tabla, fuera de la pantalla, y la
 * única señal era un aviso en la esquina que se iba solo: quien dicta no veía qué entró (ceguera al
 * cambio) y tenía que bajar a revisar, perdiendo el hilo. La línea se queda hasta el siguiente
 * agregado y se anuncia al lector de pantalla; «Ver en la lista» baja al renglón y deja el cursor en su
 * cantidad (quien lo pide navega a él). Al AGREGAR la página NO se desplaza sola: el buscador se quedaría
 * fuera de la vista a media captura.
 */
@Component({
  selector: 'app-ultimo-agregado',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- La región viva existe siempre (vacía): un aria-live que nace con su contenido no se anuncia. -->
    <p class="ultimo" role="status" aria-live="polite">
      @if (info(); as u) {
        <i class="pi pi-check ico" aria-hidden="true"></i>
        <!-- Los separadores van como TEXTO: Angular quita el espacio entre etiquetas y el lector de
             pantalla leería «Renglón 23GALL…» pegado (el gap sólo separa a la vista). -->
        <span class="que">{{ u.sumado ? 'Sumado al renglón ' + u.numero : u.numero ? 'Renglón ' + u.numero : 'Agregado' }}:</span>{{ ' ' }}<span class="nombre">{{ u.nombre }}</span>{{ ' · ' }}<span class="det">{{ u.detalle }}</span>
        @if (u.id) {
          {{ ' · ' }}<button type="button" class="ver" (click)="ver.emit(u.id)">Ver en la lista</button>
        }
      }
    </p>
  `,
  styles: [
    `
      :host { display: block; }
      .ultimo {
        display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-2);
        margin: 0; padding: 0 var(--sp-4); min-height: 1.5rem;
        font-size: var(--fs-sm); color: var(--text-muted);
      }
      .ico { color: var(--ok-soft-fg); align-self: center; }
      .que { color: var(--text-main); }
      .nombre { color: var(--text-main); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
      .det { font-variant-numeric: tabular-nums; }
      .ver {
        background: none; border: 0; padding: 0; font: inherit; color: var(--text-main);
        text-decoration: underline; cursor: pointer;
      }
      .ver:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 2px; }
    `,
  ],
})
export class UltimoAgregadoComponent {
  readonly info = input<UltimoAgregado | null>(null);
  readonly ver = output<string>();
}
