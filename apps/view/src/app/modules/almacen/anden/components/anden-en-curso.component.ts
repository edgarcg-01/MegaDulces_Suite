import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { AndenValeEnCurso } from '../../receiving-session.service';
import { diasDesde, hoyMexico } from '../dia-mx';

/**
 * Andén · **los vales que quedaron a medias** (`[WMS-REC.17]`).
 *
 * Existe para poder **cambiar de camión**: llega un segundo camión mientras se fecha el
 * primero, el bodeguero lo atiende y después vuelve al primero. Antes eso no tenía camino:
 * un vale abierto sale del menú de pendientes (ya tiene sesión), y sólo el borrador local del
 * mismo equipo lo recordaba — y sólo el último.
 *
 * Va ARRIBA del menú de sucursales porque es trabajo ya empezado: terminarlo es más barato
 * que abrir otro. Si no hay nada a medias, no ocupa ni un renglón.
 *
 * **Lo que falta se dice en renglones por fechar**, no en piezas: es lo que el bodeguero ve
 * dentro del vale, y un "faltan 2" se reconoce de un vistazo.
 */
@Component({
  selector: 'app-anden-en-curso',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (vales().length) {
      <section class="ec" aria-label="Vales incompletos">
        <div class="ec-cab">
          <span>Incompletos</span>
          <span>{{ vales().length | number }} sin terminar · tocá uno para seguir</span>
        </div>
        <ul class="ec-lista">
          @for (v of vales(); track v.id) {
            <li>
              <button type="button" class="ec-row" [disabled]="abriendo()" (click)="retomar.emit(v)">
                <span class="ec-fol">{{ v.folio }}</span>
                <span class="ec-chip" [class.ec-tr]="v.origin.kind === 'transfer'">{{ v.origin.label }}</span>
                <span class="ec-det">
                  {{ v.origin.name || v.documento || 'Vale manual' }}
                  @if (v.warehouse_code || v.warehouse_name) { · {{ v.warehouse_code || v.warehouse_name }} }
                </span>
                <span class="ec-pend" [class.ec-ok]="!v.por_fechar">
                  @if (v.por_fechar) { faltan {{ v.por_fechar | number }} } @else { todo fechado }
                </span>
                <span class="ec-quien">
                  @if (porEnviar().has(v.id)) { <span class="ec-envio">por mandar</span> · }
                  {{ desde(v.created_at) }}@if (v.abierto_por) { · lo abrió {{ v.abierto_por }} }
                </span>
              </button>
            </li>
          }
        </ul>
      </section>
    } @else if (error()) {
      <!-- Si la lista no se pudo leer se dice: callarlo haría creer que no hay nada a medias. -->
      <p class="ec-mal">No se pudieron leer los vales incompletos: {{ error() }}</p>
    }
  `,
  styles: [`
    :host { display: block; }
    .ec { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-3); }
    .ec-cab {
      display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); padding: 0 2px;
      font-size: var(--fs-micro); color: var(--text-faint);
    }
    .ec-cab span:first-child { font-weight: var(--fw-bold); letter-spacing: .09em; text-transform: uppercase; }
    .ec-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .ec-row {
      display: grid; grid-template-columns: auto 1fr auto; gap: 3px var(--sp-2); align-items: center;
      width: 100%; padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-left: 3px solid var(--action);
      border-radius: var(--r-md); font: inherit;
    }
    .ec-row:hover { border-color: var(--action); }
    .ec-row:disabled { opacity: .6; cursor: progress; }
    .ec-fol { grid-column: 1; font-size: var(--fs-body); font-weight: var(--fw-black);
      font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
    .ec-chip {
      grid-column: 2; justify-self: start;
      font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .07em; text-transform: uppercase;
      padding: 2px 7px; border-radius: var(--r-pill);
      background: var(--surface-ground); color: var(--text-muted); border: 1px solid var(--border-color);
    }
    /* Mismo criterio que el chip del encabezado del vale: traspaso = ámbar, proveedor = neutro. */
    .ec-tr { background: var(--warn-soft-bg); color: var(--warn-fg); border-color: transparent; }
    .ec-det { grid-column: 1 / 3; min-width: 0; font-size: var(--fs-xs); color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ec-pend { grid-column: 3; grid-row: 1; justify-self: end; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      color: var(--warn-fg); font-variant-numeric: tabular-nums; }
    .ec-ok { color: var(--ok-fg); }
    .ec-quien { grid-column: 3; grid-row: 2; justify-self: end; font-size: var(--fs-micro); color: var(--text-faint); }
    /* [WMS-REC.20] Hecho sin conexión y todavía en este equipo. */
    .ec-envio { font-weight: var(--fw-bold); color: var(--warn-fg); }
    .ec-mal {
      margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
      background: var(--bad-soft-bg, var(--surface-ground)); color: var(--bad-fg);
      font-size: var(--fs-xs); line-height: 1.45;
    }
  `],
})
export class AndenEnCursoComponent {
  readonly vales = input.required<AndenValeEnCurso[]>();
  readonly abriendo = input(false);
  readonly error = input<string | null>(null);
  /** `[WMS-REC.20]` Los vales con algo hecho sin conexión que todavía no se manda. */
  readonly porEnviar = input<ReadonlySet<string>>(new Set());

  readonly retomar = output<AndenValeEnCurso>();

  private readonly hoy = hoyMexico();

  /**
   * `[WMS-REC.18]` Desde cuándo está abierto. Un incompleto de hace días es el que hay que ver
   * primero: el camión ya se fue y la mercancía sigue sin caducidad.
   */
  desde(createdAt: string): string {
    const d = diasDesde(createdAt, this.hoy);
    if (d === null || d <= 0) return 'abierto hoy';
    if (d === 1) return 'abierto ayer';
    return `abierto hace ${d} días`;
  }
}
