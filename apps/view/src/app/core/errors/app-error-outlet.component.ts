import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AppErrorService, AppError } from './app-error.service';

/**
 * Lo que ve el usuario cuando algo se rompe. Vive en el shell, fuera del router,
 * porque una excepción puede haber dejado la navegación inservible.
 *
 * Dos respuestas distintas para dos problemas distintos:
 *
 *  - **Versión vieja** → tapa la pantalla. No es dramatismo: el código que la
 *    pestaña necesita ya no existe en el servidor, seguir haciendo clic sólo
 *    encadena errores, y recargar es la única salida. Se dice sin jerga y se
 *    ofrece el único botón que sirve.
 *  - **Error inesperado** → aviso abajo, descartable, que no tapa nada. La app
 *    casi siempre sigue usable; robarle la pantalla a alguien que está a mitad
 *    de una captura le haría perder el trabajo por un error del que quizá ni se
 *    enteró. Lleva el identificador para que pueda reportarlo.
 */
@Component({
  selector: 'app-error-outlet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (err(); as e) {
      @if (e.kind === 'stale-version') {
        <div class="ae-block" role="alertdialog" aria-labelledby="ae-t" aria-describedby="ae-d">
          <div class="ae-card">
            <p class="ae-eyebrow">Versión nueva</p>
            <h2 class="ae-title" id="ae-t">Hay una actualización lista</h2>
            <p class="ae-lead" id="ae-d">
              Se publicó una versión mientras tenías esta pestaña abierta, así que
              esta pantalla quedó a medias. Recargá para seguir trabajando; no
              perdés nada de lo que ya se guardó.
            </p>
            <button type="button" class="ae-btn" (click)="reload()">
              <i class="pi pi-refresh" aria-hidden="true"></i> Recargar ahora
            </button>
          </div>
        </div>
      } @else {
        <div class="ae-toast" role="status">
          <i class="pi pi-exclamation-triangle ae-toast-ico" aria-hidden="true"></i>
          <div class="ae-toast-txt">
            <p class="ae-toast-t">Algo falló en esta pantalla</p>
            <p class="ae-toast-s">
              Si se repite, reportá el código <code>{{ e.id }}</code>.
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

    /* ── Bloqueante: versión vieja ─────────────────────────────────────── */
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

    @media (max-width: 640px) {
      .ae-toast { left: var(--sp-2); right: var(--sp-2); bottom: var(--sp-2); max-width: none; }
    }
  `],
})
export class AppErrorOutletComponent {
  private readonly svc = inject(AppErrorService);
  readonly err = computed(() => this.svc.current());

  reload(): void {
    window.location.reload();
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
