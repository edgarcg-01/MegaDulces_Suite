import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AppErrorService, AppError, AppErrorKind, bloquea } from './app-error.service';
import { clasificarFallaDeCarga } from './global-error-handler';

/**
 * Lo que ve el usuario cuando algo se rompe. Vive en el shell, fuera del router,
 * porque una excepción puede haber dejado la navegación inservible.
 *
 * Dos respuestas distintas para dos problemas distintos:
 *
 *  - **No cargó la pantalla** (falta un trozo de código) → tapa la pantalla. No es
 *    dramatismo: seguir haciendo clic sólo encadena errores. Pero lo que DICE depende
 *    de la causa que el servidor confirme, no del error del navegador, que es el mismo
 *    en los cuatro casos (AUD.6, 2026-11-12).
 *  - **Error inesperado** → aviso abajo, descartable, que no tapa nada. La app
 *    casi siempre sigue usable; robarle la pantalla a alguien que está a mitad
 *    de una captura le haría perder el trabajo por un error del que quizá ni se
 *    enteró. Lleva el identificador para que pueda reportarlo.
 *
 * ⛔⛔ Antes de AUD.6 este aviso afirmaba *se publicó una versión* ante CUALQUIER
 * falla de carga — red cortada, nodo de CDN sin el archivo, equipo sin conexión — y su
 * único botón mandaba a recargar, que en esos casos no saca a nadie de ahí. Un rótulo que
 * miente en la pantalla que se pinta encima de todo es la ley 0 del estándar rota.
 *
 * Las cinco preguntas de la skill de diseño, contestadas antes de tocar la plantilla:
 *  1. **Qué ve y en qué orden:** la causa real primero (rótulo + título), después la frase
 *     que la explica, y al final el ÚNICO botón que sirve para esa causa.
 *  2. **Qué NO ve:** la URL del archivo, el stack ni el nombre del bundler; tampoco dos
 *     botones primarios compitiendo. El detalle sigue a un clic, en "Copiar detalle".
 *  3. **Accesibilidad:** alertdialog con título y descripción enlazados, todo alcanzable
 *     con teclado, y ningún estado que dependa sólo del color.
 *  4. **Ligada a otro proceso:** al despliegue. El veredicto lo da el servidor, no el cliente.
 *  5. **Le toca a esta pantalla:** sí, al shell — salvo en una pantalla pública, donde no
 *     hay trabajo que proteger y el aviso baja a toast (ver enPantallaPublica).
 */
@Component({
  selector: 'app-error-outlet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (err(); as e) {
      @if (aviso(); as a) {
        @if (!enPantallaPublica()) {
          <div class="ae-block" role="alertdialog" aria-labelledby="ae-t" aria-describedby="ae-d">
            <div class="ae-card">
              <p class="ae-eyebrow">{{ a.rotulo }}</p>
              <h2 class="ae-title" id="ae-t">{{ a.titulo }}</h2>
              <p class="ae-lead" id="ae-d">{{ a.texto }}</p>

              @if (e.kind === 'load-checking') {
                <p class="ae-wait" role="status">
                  <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
                  Preguntando al servidor por el archivo que faltó
                </p>
              } @else {
                <div class="ae-acts">
                  @if (a.recargar) {
                    <button type="button" class="ae-btn" (click)="reload()">
                      <i class="pi pi-refresh" aria-hidden="true"></i> {{ a.accion }}
                    </button>
                  } @else {
                    <button type="button" class="ae-btn" (click)="reintentar(e)">
                      <i class="pi pi-replay" aria-hidden="true"></i> {{ a.accion }}
                    </button>
                    <button type="button" class="ae-alt" (click)="reload()">Recargar de todos modos</button>
                  }
                </div>
                @if (e.kind !== 'stale-version') {
                  <p class="ae-code">
                    Código <code>{{ e.id }}</code>
                    <button type="button" class="ae-copy" (click)="copy(e)">
                      {{ copied() ? 'Copiado' : 'Copiar detalle' }}
                    </button>
                  </p>
                }
              }
            </div>
          </div>
        } @else {
          <div class="ae-toast" role="status">
            <i class="pi pi-refresh ae-toast-ico" aria-hidden="true"></i>
            <div class="ae-toast-txt">
              <p class="ae-toast-t">{{ a.titulo }}</p>
              <p class="ae-toast-s">Puedes entrar igual; vuelve a intentar en un momento.</p>
            </div>
            <button type="button" class="ae-toast-a" (click)="reload()">Recargar</button>
            <button type="button" class="ae-toast-x" (click)="dismiss()" aria-label="Descartar aviso">
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>
        }
      } @else {
        <div class="ae-toast" role="status">
          <i class="pi pi-exclamation-triangle ae-toast-ico" aria-hidden="true"></i>
          <div class="ae-toast-txt">
            <p class="ae-toast-t">Algo falló en esta pantalla</p>
            <p class="ae-toast-s">
              Si se repite, reporta el código <code>{{ e.id }}</code>.
              <button type="button" class="ae-toast-copy" (click)="copy(e)">
                {{ copied() ? 'Copiado' : 'Copiar detalle' }}
              </button>
            </p>
          </div>
          <button type="button" class="ae-toast-a" (click)="reload()">Recargar</button>
          <button type="button" class="ae-toast-x" (click)="dismiss()" aria-label="Descartar aviso">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        </div>
      }
    }
  `,
  styles: [`
    :host { display: contents; }

    /* ── Bloqueante: la pantalla no cargó ──────────────────────────────── */
    .ae-block {
      position: fixed;
      inset: 0;
      z-index: 9995;           /* por encima de todo lo de la app; sólo el splash de arranque va más arriba */
      display: grid;
      place-items: center;
      padding: var(--sp-4);
      background: rgba(var(--ink-rgb), 0.55);
      backdrop-filter: blur(2px);
    }
    .ae-card {
      max-width: 27rem;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-md);
      padding: var(--sp-6);
    }
    .ae-eyebrow {
      margin: 0 0 var(--sp-2);
      font-family: var(--font-mono);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--c-text-3);
    }
    .ae-title {
      margin: 0;
      font-size: var(--fs-h2);
      font-weight: var(--fw-bold);
      letter-spacing: -0.01em;
      color: var(--c-text-1);
    }
    .ae-lead {
      margin: var(--sp-3) 0 var(--sp-6);
      font-size: var(--fs-sm);
      line-height: 1.5;
      color: var(--c-text-2);
    }
    .ae-acts { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .ae-btn {
      font: inherit;
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2);
      padding: var(--sp-2) var(--sp-4);
      min-height: var(--row-h-sm);
      border: none;
      border-radius: var(--r-sm);
      background: var(--c-text-1);
      color: var(--c-surface-1);
      cursor: pointer;
    }
    .ae-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* Salida secundaria: existe, pero no compite con la acción que sí corresponde. */
    .ae-alt {
      font: inherit;
      font-size: var(--fs-xs);
      background: none;
      border: 0;
      padding: var(--sp-1) 0;
      color: var(--c-text-3);
      text-decoration: underline;
      cursor: pointer;
    }
    .ae-alt:hover { color: var(--c-text-1); }
    .ae-alt:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ae-wait {
      margin: 0;
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      font-size: var(--fs-xs);
      color: var(--c-text-3);
      min-height: var(--row-h-sm);
    }
    .ae-code {
      margin: var(--sp-4) 0 0;
      font-size: var(--fs-micro);
      color: var(--c-text-3);
    }
    .ae-code code { font-family: var(--font-mono); color: var(--c-text-2); }
    .ae-copy {
      background: none; border: 0; padding: 0 0 0 .4rem; font: inherit;
      color: var(--action, currentColor); text-decoration: underline; cursor: pointer;
    }
    /* Halo --focus-ring y no --action-ring: el segundo mide 1.56:1 y la propia compuerta
       de estilos lo lleva como deuda ("no se ve"). En pieza nueva, el que sí se ve. */
    .ae-copy:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      .ae-wait .pi-spin { animation: none; }
    }

    /* ── No bloqueante: error inesperado ───────────────────────────────── */
    .ae-toast {
      position: fixed;
      z-index: 9990;
      left: var(--sp-4);
      bottom: var(--sp-4);
      max-width: min(30rem, calc(100vw - var(--sp-8)));
      display: flex;
      align-items: flex-start;
      gap: var(--sp-3);
      padding: var(--sp-3) var(--sp-4);
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-md);
      box-shadow: var(--shadow-float);
    }
    .ae-toast-ico { color: var(--c-warn); margin-top: 2px; }
    .ae-toast-txt { min-width: 0; flex: 1; }
    .ae-toast-t {
      margin: 0;
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      color: var(--c-text-1);
    }
    .ae-toast-s {
      margin: 2px 0 0;
      font-size: var(--fs-micro);
      color: var(--c-text-3);
    }
    .ae-toast-s code { font-family: var(--font-mono); color: var(--c-text-2); }
    /* Copiar el detalle es lo que convierte el código en algo accionable: sin esto el
       usuario reporta un número y del otro lado no hay con qué cruzarlo. */
    .ae-toast-copy { background: none; border: 0; padding: 0 0 0 .4rem; font: inherit;
      color: var(--action, currentColor); text-decoration: underline; cursor: pointer; }
    .ae-toast-copy:focus-visible { outline: 2px solid var(--action-ring, currentColor); outline-offset: 2px; }
    .ae-toast-a {
      font: inherit;
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      color: var(--c-text-1);
      background: none;
      border: 1px solid var(--c-divider);
      border-radius: var(--r-sm);
      padding: var(--sp-1) var(--sp-3);
      cursor: pointer;
      flex: none;
    }
    .ae-toast-a:hover { background: var(--overlay-hover); }
    .ae-toast-a:focus-visible,
    .ae-toast-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .ae-toast-x {
      background: none;
      border: none;
      color: var(--c-text-3);
      cursor: pointer;
      padding: 0;
      font-size: var(--fs-xs);
      flex: none;
      line-height: 1.4;
    }
    .ae-toast-x:hover { color: var(--c-text-1); }

    @media (max-width: 40rem) {
      .ae-toast { left: var(--sp-2); right: var(--sp-2); bottom: var(--sp-2); max-width: none; }
    }
  `],
})
export class AppErrorOutletComponent {
  private readonly svc = inject(AppErrorService);
  readonly err = computed(() => this.svc.current());

  /**
   * El texto del aviso, elegido por la causa CONFIRMADA. Devuelve null cuando el error no es
   * de carga — entonces va el toast de error inesperado.
   */
  readonly aviso = computed(() => {
    const e = this.err();
    if (!e) return null;
    const causa = e.kind;
    return bloquea(causa) ? AVISOS[causa] : null;
  });

  /**
   * ⛔ **El bloqueo NO se pinta sobre una pantalla pública.** Medido en producción el 2026-10-14,
   * con una oficina entera afuera: el overlay es position fixed, inset 0, z-index 9995, así
   * que sobre /login tapaba el formulario y **el único control de la pantalla**. La salida
   * existía —el botón de recargar— pero no se lee como salida cuando lo que querías era entrar.
   *
   * ⭐ Y su propio texto era falso ahí: «quedó a medias… no pierdes nada de lo que ya se guardó».
   * Nadie estaba trabajando; estaban FUERA. El bloqueo sólo tiene sentido cuando hay trabajo que
   * proteger — sin sesión no hay ninguno, y entonces el aviso va como toast descartable y el
   * login sigue usable.
   *
   * Se lee location.pathname y no el Router a propósito: esto corre cuando la navegación
   * pudo haber quedado inservible, que es la razón por la que este componente vive fuera del
   * router (ver la cabecera del archivo).
   */
  enPantallaPublica(): boolean {
    const p = (globalThis.location?.pathname ?? '').toLowerCase();
    return p.includes('/login');
  }

  reload(): void {
    window.location.reload();
  }

  /**
   * Vuelve a preguntar por el archivo que faltó.
   *
   * ⭐ Si sigue sin conexión **no recarga**: recargar sin red deja a la persona en la pantalla de
   * error del navegador, que es peor que donde estaba. Recién cuando hay con qué cargar, recarga.
   */
  async reintentar(e: AppError): Promise<void> {
    this.svc.resolver(e.id, 'load-checking');
    const kind = await clasificarFallaDeCarga(e.recurso ?? null);
    if (kind === 'load-offline') { this.svc.resolver(e.id, 'load-offline'); return; }
    this.reload();
  }

  dismiss(): void {
    this.svc.dismiss();
  }

  readonly copied = signal(false);

  /** Deja en el portapapeles código + momento + pantalla + stack, listo para pegar. */
  copy(e: AppError): void {
    const txt = this.svc.describe(e);
    const done = () => { this.copied.set(true); setTimeout(() => this.copied.set(false), 2000); };
    navigator.clipboard?.writeText(txt).then(done).catch(() => {
      // Sin permiso de portapapeles (http, o el navegador lo bloquea): al menos
      // dejarlo en la consola, que es de donde se puede rescatar a mano.
      console.info(txt);
      done();
    });
  }
}

export interface AvisoDeCarga {
  rotulo: string;
  titulo: string;
  texto: string;
  accion: string;
  /** true = el botón recarga (sirve); false = reintenta, porque recargar no arreglaría nada. */
  recargar: boolean;
}

/**
 * ⭐ Un texto por causa, y ninguno afirma lo que no se comprobó.
 *
 * Sólo stale-version dice que hubo un despliegue, y sólo se llega ahí cuando el servidor
 * contestó que el archivo ya no existe.
 */
export const AVISOS: Record<Exclude<AppErrorKind, 'unexpected'>, AvisoDeCarga> = {
  'load-checking': {
    rotulo: 'Un momento',
    titulo: 'Esta pantalla no cargó completa',
    texto: 'Faltó una parte y estamos viendo por qué antes de decirte qué hacer.',
    accion: '',
    recargar: false,
  },
  'stale-version': {
    rotulo: 'Versión nueva',
    titulo: 'Hay una actualización lista',
    texto: 'Se publicó una versión mientras tenías esta pestaña abierta, así que esta pantalla '
      + 'quedó a medias. Recarga para seguir trabajando; no pierdes nada de lo que ya se guardó.',
    accion: 'Recargar ahora',
    recargar: true,
  },
  'load-offline': {
    rotulo: 'Sin conexión',
    titulo: 'No pudimos cargar esta pantalla',
    texto: 'Tu equipo se quedó sin conexión y faltó una parte de la pantalla. No se publicó '
      + 'ninguna versión nueva: en cuanto vuelva la red, vuelve a intentar. No pierdes nada de '
      + 'lo que ya se guardó.',
    accion: 'Reintentar',
    recargar: false,
  },
  'load-server': {
    rotulo: 'Servidor',
    titulo: 'El servidor no entregó esta pantalla',
    texto: 'Pedimos la parte que falta y el servidor respondió con un error. No es una versión '
      + 'nueva ni tu conexión. Vuelve a intentar en un momento; si sigue igual, reporta el código.',
    accion: 'Reintentar',
    recargar: false,
  },
  'load-unknown': {
    rotulo: 'Sin determinar',
    titulo: 'No pudimos cargar esta pantalla',
    texto: 'Faltó una parte de la pantalla y no pudimos determinar por qué: no fue una versión '
      + 'nueva ni tu conexión. Vuelve a intentar; si se repite, reporta el código.',
    accion: 'Reintentar',
    recargar: false,
  },
};
