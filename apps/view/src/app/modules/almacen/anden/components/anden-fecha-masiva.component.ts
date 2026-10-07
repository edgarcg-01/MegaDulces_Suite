import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { AndenLinea } from '../anden.state';
import { formatExpiryEcho, parseExpiryShort, maskExpiryMx } from '../../shared/expiry-short';

export interface FechadoMasivo {
  lote: string;
  caducidadIso: string;
  /** Los renglones a los que se aplica, con la cantidad que le falta a cada uno. */
  lineas: AndenLinea[];
}

/** Lo que el padre va reportando mientras corre. */
export interface AvanceMasivo {
  hechas: number;
  total: number;
  /** Renglones que no se pudieron fechar, con el motivo. Se muestran, no se tragan. */
  fallas: { nombre: string; motivo: string }[];
  /** Capturas que el backend marcó 🔴: entraron a la bandeja, no a existencia. */
  retenidas: number;
  terminado: boolean;
}

/**
 * Andén · **fechar todo el vale con la misma caducidad**.
 *
 * Es el caso normal de una entrega de un proveedor: toda la tarima es del mismo
 * lote y caduca el mismo día. Fecharlo renglón por renglón son N fotos, N fechas
 * y N confirmaciones para capturar **un solo dato**.
 *
 * Tres cosas que este panel NO hace, a propósito:
 *
 *  - **No decide la cantidad.** A cada renglón se le aplica lo que le falta por
 *    fechar, que es lo que Kepler manda. Un faltante se corrige después, renglón
 *    por renglón, donde se puede mirar la tarima.
 *  - **No se traga los errores.** Si tres renglones fallan, se listan con nombre y
 *    motivo. Un "listo" sobre 9 de 12 es exactamente cómo se pierde mercancía.
 *  - **No adelanta el veredicto.** El 🔴 lo decide el backend por producto (cada
 *    uno tiene su política de vida útil), así que una misma fecha puede entrar
 *    verde en un SKU y quedar retenida en otro. Se dice cuántas quedaron retenidas
 *    al terminar, no antes.
 */
@Component({
  selector: 'app-anden-fecha-masiva',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fm">
      <header class="fm-hd">
        <div>
          <h3 class="fm-t">Todos caducan el mismo día</h3>
          <!-- El total sale del avance en cuanto arrancó: la lista de pendientes se
               vacía al recargar el detalle al final, y sin esto el encabezado
               terminaba diciendo "se aplica a los 0 renglones" justo al terminar. -->
          <p class="fm-s">
            Se aplica a los <b>{{ avance()?.total ?? lineas().length }}</b> renglones sin fechar ·
            <b>{{ piezas() | number }} pz</b>
          </p>
        </div>
        <button type="button" class="fm-back" [disabled]="corriendo()" (click)="volver.emit()">← Lista</button>
      </header>

      @if (!avance()?.terminado) {
        <div class="fm-campos">
          <label class="fm-f fm-lote">
            <span>Lote</span>
            <input pInputText [ngModel]="lote()" (ngModelChange)="lote.set($event)"
              [disabled]="corriendo()" placeholder="opcional" />
          </label>
          <label class="fm-f">
            <span>Caducidad</span>
            <input pInputText inputmode="numeric" maxlength="10" class="fm-fecha"
              [ngModel]="fechaVista()" (ngModelChange)="setFecha($event)"
              [disabled]="corriendo()" placeholder="DD/MM/AA" />
          </label>
        </div>
        <p class="fm-eco" [class.fm-mal]="fechaRaw().length > 0 && !iso()">
          {{ iso() ? '→ ' + eco() : 'DD/MM/AA · o sólo MM/AA si la etiqueta no trae día' }}
        </p>
      }

      @if (corriendo()) {
        <div class="fm-run">
          <div class="fm-barra"><span [style.width.%]="pct()"></span></div>
          <p class="fm-run-t">Fechando {{ avance()!.hechas }} de {{ avance()!.total }}…</p>
        </div>
      }

      @if (avance()?.terminado) {
        <div class="fm-fin">
          <p class="fm-fin-t">
            <b>{{ okCount() | number }}</b> de {{ avance()!.total | number }} renglones fechados
            al {{ eco() }}.
          </p>
          @if (avance()!.retenidas > 0) {
            <p class="fm-fin-r">
              <b>{{ avance()!.retenidas }}</b> quedaron 🔴 retenidas por su política de vida útil:
              un supervisor las libera antes de que el vale cierre.
            </p>
          }
          @if (avance()!.fallas.length) {
            <div class="fm-fallas">
              <p class="fm-fallas-t">Estos NO se fecharon — hay que hacerlos a mano:</p>
              <ul>
                @for (f of avance()!.fallas; track f.nombre) {
                  <li><b>{{ f.nombre }}</b> — {{ f.motivo }}</li>
                }
              </ul>
            </div>
          }
          <button pButton type="button" class="fm-go" (click)="volver.emit()">Volver a la lista</button>
        </div>
      } @else {
        <button pButton type="button" class="fm-go" [loading]="corriendo()"
          [disabled]="!iso() || corriendo() || !lineas().length" (click)="lanzar()">
          {{ iso() ? 'Fechar los ' + lineas().length + ' renglones' : 'Falta la caducidad' }}
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fm { display: flex; flex-direction: column; gap: var(--sp-3); }
    .fm-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .fm-t { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); line-height: 1.2; }
    .fm-s { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .fm-s b { color: var(--text-main); }
    .fm-back {
      flex: 0 0 auto; min-height: 36px; padding: 0 var(--sp-2);
      background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      color: var(--text-muted); font: inherit; font-size: var(--fs-xs); cursor: pointer;
    }
    .fm-campos { display: flex; gap: var(--sp-2); }
    .fm-f { display: flex; flex-direction: column; gap: var(--sp-1); flex: 1; min-width: 0; }
    .fm-lote { flex: 0 0 40%; }
    .fm-f > span { font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .1em;
      text-transform: uppercase; color: var(--text-muted); }
    .fm-f input { min-height: 48px; }
    .fm-fecha { font-size: var(--fs-h3); font-weight: var(--fw-bold); text-align: center;
      letter-spacing: .12em; font-variant-numeric: tabular-nums; }
    .fm-eco { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); text-align: center; min-height: 1.2em; }
    .fm-mal { color: var(--bad-fg); }
    .fm-run { display: flex; flex-direction: column; gap: var(--sp-1); }
    .fm-barra { height: 6px; border-radius: var(--r-pill); background: var(--surface-ground); overflow: hidden; }
    .fm-barra span { display: block; height: 100%; background: var(--action);
      transition: width var(--dur-short, 150ms) var(--ease-standard, ease); }
    .fm-run-t { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .fm-fin { display: flex; flex-direction: column; gap: var(--sp-2); }
    .fm-fin-t { margin: 0; font-size: var(--fs-sm); }
    .fm-fin-r {
      margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
      background: var(--warn-soft-bg, var(--surface-ground)); color: var(--warn-fg, var(--text-main));
      font-size: var(--fs-xs); line-height: 1.4;
    }
    .fm-fallas {
      padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
      background: var(--bad-soft-bg, var(--surface-ground)); color: var(--bad-fg);
      font-size: var(--fs-xs); line-height: 1.45;
    }
    .fm-fallas-t { margin: 0 0 var(--sp-1); font-weight: var(--fw-bold); }
    .fm-fallas ul { margin: 0; padding-left: 1.1em; }
    .fm-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    @media (prefers-reduced-motion: reduce) { .fm-barra span { transition: none; } }
  `],
})
export class AndenFechaMasivaComponent {
  readonly lineas = input.required<AndenLinea[]>();
  /** El padre lo va actualizando mientras corre. `null` = todavía no arrancó. */
  readonly avance = input<AvanceMasivo | null>(null);

  readonly aplicar = output<FechadoMasivo>();
  readonly volver = output<void>();

  readonly lote = signal('');
  readonly fechaRaw = signal('');

  readonly iso = computed(() => parseExpiryShort(this.fechaRaw()));
  readonly eco = computed(() => formatExpiryEcho(this.iso()));
  readonly fechaVista = computed(() => maskExpiryMx(this.fechaRaw()));

  readonly piezas = computed(() => this.lineas().reduce((a, l) => a + l.faltaFechar, 0));
  readonly corriendo = computed(() => {
    const a = this.avance();
    return !!a && !a.terminado;
  });
  readonly pct = computed(() => {
    const a = this.avance();
    return a && a.total > 0 ? Math.round((a.hechas / a.total) * 100) : 0;
  });
  readonly okCount = computed(() => {
    const a = this.avance();
    return a ? Math.max(0, a.hechas - a.fallas.length) : 0;
  });

  setFecha(v: unknown): void {
    this.fechaRaw.set(String(v ?? '').replace(/\D/g, '').slice(0, 8));
  }

  lanzar(): void {
    const i = this.iso();
    if (!i || this.corriendo()) return;
    this.aplicar.emit({ lote: this.lote().trim() || 'NA', caducidadIso: i, lineas: this.lineas() });
  }

  /** Los dígitos tecleados, para precargar el panel individual del que quedó fallando. */
  digitos(): string { return this.fechaRaw(); }
}
