import { Injectable, computed, signal } from '@angular/core';
import { alCambiarEnOtraVentana, guardarPreferencia, leerPreferencia } from '../utils/cross-tab';

const CLAVE = 'mt.detallesAparte.v1';

/**
 * Multitarea: trabajar la Suite en varias ventanas (ADR-078).
 *
 * Son DOS cosas y conviene no confundirlas:
 *
 *  1. **La acción** — "abrir esta pantalla en otra ventana". No cambia nada de la
 *     app: si no la usás, todo se comporta igual que siempre.
 *  2. **La preferencia** — "abrir siempre los detalles aparte". Mientras está
 *     prendida, los enlaces de drill-down llevan 'target="_blank"' y el navegador
 *     los abre en una ventana nueva sin que haya que hacer Ctrl+clic.
 *
 * ── Por qué la preferencia es un 'target' y no lógica nuestra ─────────────────
 * 'RouterLink' ya deja pasar la navegación NATIVA cuando el 'target' es un string
 * distinto de '_self' (verificado en el fuente del router, no asumido). Así que
 * toda la preferencia es un atributo: cero interceptores de clic, cero
 * 'window.open' nuestro, cero trabajo en cada render. Es lo que hace que esto sea
 * imperceptible en rendimiento — el pedido explícito del usuario.
 *
 * ── Por qué se sincroniza entre ventanas ──────────────────────────────────────
 * Una preferencia de multitarea que NO llega a las otras ventanas es una
 * preferencia que miente: la prendés en una, mirás la otra y se comporta al
 * revés. Se escucha 'storage' ('core/utils/cross-tab'), que es exactamente el
 * mecanismo que la Suite no tenía (cero listeners, medido).
 */
@Injectable({ providedIn: 'root' })
export class MultitareaService {
  /** ¿Los detalles se abren en otra ventana por default? */
  private readonly _detallesAparte = signal<boolean>(leerPreferencia(CLAVE) === '1');
  readonly detallesAparte = this._detallesAparte.asReadonly();

  /**
   * Lo que se le pasa a '[target]' de un enlace de drill-down.
   *
   * 'undefined' y no '_self': con '_self' RouterLink igual entra por su camino,
   * pero el atributo queda escrito en el DOM sin necesidad. Sin valor, no hay
   * atributo y el enlace es un enlace normal del SPA.
   *
   * ⚠️ 'undefined', NO 'null': el input 'target' de RouterLink esta tipado
   * 'string | undefined'. Con null compila 'tsc --noEmit' y REVIENTA el
   * compilador de plantillas de Angular -- la mitad de la cobertura que el
   * chequeo de tipos suelto no da.
   */
  readonly target = computed<string | undefined>(() => (this._detallesAparte() ? '_blank' : undefined));

  constructor() {
    // Otra ventana cambió la preferencia.
    alCambiarEnOtraVentana(CLAVE, (v) => this._detallesAparte.set(v === '1'));
  }

  alternarDetallesAparte(): void {
    const v = !this._detallesAparte();
    this._detallesAparte.set(v);
    guardarPreferencia(CLAVE, v ? '1' : '0');
  }

  /**
   * Abre la pantalla actual —con su filtro, su búsqueda y su scroll en la URL—
   * en otra ventana.
   *
   * 'noopener' no es ceremonia: sin él la ventana nueva recibe 'window.opener' y
   * puede navegar a la que la abrió. Además le deja al navegador liberar el hilo.
   */
  abrirEstaPantallaAparte(): void {
    if (typeof window === 'undefined') return;
    window.open(window.location.href, '_blank', 'noopener');
  }
}
