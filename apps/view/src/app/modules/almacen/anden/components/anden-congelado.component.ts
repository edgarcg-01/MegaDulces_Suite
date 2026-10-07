import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { WarehouseFreeze } from '../../bin-location.service';

/**
 * Andén · **el almacén está congelado, y acá se destraba.**
 *
 * Antes este panel explicaba el problema y ofrecía un solo botón: *Salir*. Medido
 * en producción el 2026-09-28, eso costaba caro: el folio `INV-2026-00009` llevaba
 * **100 días** congelando Padre Hidalgo con **3 artículos contados de 2,094** y el
 * último escaneo hacía **67 días**. Cada intento de fechar se guardaba y se
 * revertía — 10 capturas, todas del mismo almacén. La salida existía en otra
 * pantalla, a la que el bodeguero no llega.
 *
 * **Cancelar no es reconciliar.** Cancelar abandona el conteo y no toca ni una
 * pieza de existencia; reconciliar aplica lo contado y ajusta el saldo. Por eso
 * este panel sólo ofrece lo primero: aplicar un conteo con 3 de 2,094 artículos
 * pondría el inventario de la sucursal casi en cero, y esa acción se queda donde
 * siempre estuvo, con quien la sabe tomar.
 *
 * **El motivo es obligatorio** cuando se cancela desde acá: queda en las notas del
 * folio y es lo único que después explica por qué se descartó un conteo.
 *
 * ⚠️ Se usa un bloque desplegable y NO un `p-dialog`: en PrimeNG 22 el
 * `pTemplate="footer"` se ignora en silencio y el diálogo abre sin botones (ya
 * pasó en Caja General). Un bloque en la misma página no tiene esa forma de
 * fallar, y en un teléfono en el andén se lee mejor.
 */
@Component({
  selector: 'app-anden-congelado',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cg">
      <div class="cg-hd">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="10" rx="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <div>
          <h2>Este almacén está congelado</h2>
          <p>Hay un inventario físico en curso. Mientras se cuenta, nada puede entrar ni fecharse.</p>
        </div>
      </div>

      <div class="cg-fol">
        <div>
          <span class="cg-lbl">Folio que lo frena</span>
          <strong>{{ freeze().folio || 'sin folio' }}</strong>
        </div>
        <div>
          <span class="cg-lbl">Congelado desde</span>
          <!-- Sin fecha se DECLARA; nunca se dibuja como "hoy". -->
          <strong>{{ desde() }}</strong>
        </div>
      </div>

      @if (!puedeCancelar()) {
        <p class="cg-sal">
          Se destraba <b>conciliando</b> el conteo (se cierra aplicando lo contado) o
          <b>cancelándolo</b>. Las dos las hace quien lleva el inventario físico —
          pedíselo al encargado o a tu supervisor, con el folio de arriba.
        </p>
      } @else if (!abierto()) {
        <div class="cg-go">
          <p class="cg-sal">
            Podés <b>cancelar</b> el conteo: se abandona sin aplicar ningún ajuste y el
            almacén queda libre para recibir. No se toca la existencia.
          </p>
          <button pButton type="button" severity="danger" [outlined]="true" class="cg-btn"
            (click)="abrir()">
            Cancelar el conteo y destrabar
          </button>
        </div>
      } @else {
        <div class="cg-form">
          <label for="cg-motivo">¿Por qué se descarta este conteo?</label>
          <textarea id="cg-motivo" rows="3" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)"
            [disabled]="cancelando()"
            placeholder="Ej.: se abandonó en junio y nunca se terminó; hay que recibir mercancía."></textarea>
          <p class="cg-nota">
            Queda guardado en el folio. Es lo único que después explica por qué se descartó.
          </p>
          <div class="cg-acc">
            <button pButton type="button" [text]="true" severity="secondary"
              [disabled]="cancelando()" (click)="cerrar()">Mejor no</button>
            <button pButton type="button" severity="danger" [loading]="cancelando()"
              [disabled]="!motivoValido()" (click)="confirmar()">
              Sí, cancelar {{ freeze().folio }}
            </button>
          </div>
        </div>
      }

      <button pButton type="button" [text]="true" severity="secondary" (click)="salir.emit()">
        Salir
      </button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cg {
      display: flex; flex-direction: column; gap: var(--sp-3);
      padding: var(--sp-4) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-lg);
    }
    .cg-hd { display: flex; gap: var(--sp-3); align-items: flex-start; color: var(--text-main); }
    .cg-hd h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-black); }
    .cg-hd p { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45; }
    .cg-fol {
      display: flex; flex-wrap: wrap; gap: var(--sp-4);
      padding: var(--sp-2) var(--sp-3);
      background: var(--surface-ground); border-radius: var(--r-sm);
    }
    .cg-lbl {
      display: block; font-size: var(--fs-micro); color: var(--text-faint);
      text-transform: uppercase; letter-spacing: .08em; font-weight: var(--fw-bold);
    }
    .cg-fol strong { font-size: var(--fs-body); font-variant-numeric: tabular-nums; }
    .cg-sal { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
    .cg-go { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cg-btn { width: 100%; min-height: 50px; font-weight: var(--fw-bold); }
    .cg-form {
      display: flex; flex-direction: column; gap: var(--sp-2);
      padding: var(--sp-3); border-radius: var(--r-md);
      background: var(--bad-soft-bg, var(--surface-ground));
      border: 1px solid var(--bad-fg);
    }
    .cg-form label { font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .cg-form textarea {
      width: 100%; padding: var(--sp-2); font: inherit; font-size: var(--fs-body);
      color: var(--text-main); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); resize: vertical;
    }
    .cg-nota { margin: 0; font-size: var(--fs-micro); color: var(--text-muted); }
    .cg-acc { display: flex; gap: var(--sp-2); justify-content: flex-end; flex-wrap: wrap; }
    .cg-acc button { min-height: 46px; }
  `],
})
export class AndenCongeladoComponent {
  readonly freeze = input.required<WarehouseFreeze>();
  /** Si quien mira tiene la llave para cancelar. Sin ella se explica a quién pedírselo. */
  readonly puedeCancelar = input(false);
  readonly cancelando = input(false);

  readonly cancelar = output<string>();
  readonly salir = output<void>();

  /** El formulario de motivo, desplegado. Arranca cerrado: cancelar no es un clic al pasar. */
  readonly abierto = signal(false);
  /**
   * SIGNAL, no un campo plano: `motivoValido` es un `computed()` y un computed sobre un
   * campo plano NO se recalcula nunca — queda clavado en su primer valor y el boton se
   * inhabilita de por vida. Ya pasó en Caja General (CG.22) con un boton que se pintaba
   * pero no servia. El candado de este componente lo verifica escribiendo de verdad.
   */
  readonly motivo = signal('');

  /**
   * Hace cuánto está congelado, en palabras. **Sin fecha dice que no se sabe** — un
   * "hace 0 días" por un dato ausente haría parecer que el conteo es de hoy, que es
   * justo lo contrario de lo que hay que saber para decidir.
   */
  readonly desde = computed(() => {
    const iso = this.freeze().opened_at;
    if (!iso) return 'sin fecha registrada';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return 'sin fecha registrada';
    const dias = Math.floor(ms / 86400000);
    if (dias <= 0) return 'hoy';
    if (dias === 1) return 'ayer';
    return 'hace ' + dias + ' días';
  });

  readonly motivoValido = computed(() => this.motivo().trim().length >= 4);

  abrir() {
    this.motivo.set('');
    this.abierto.set(true);
  }

  cerrar() {
    this.abierto.set(false);
  }

  confirmar() {
    const m = this.motivo().trim();
    if (m.length < 4) return;
    this.cancelar.emit(m);
  }
}
