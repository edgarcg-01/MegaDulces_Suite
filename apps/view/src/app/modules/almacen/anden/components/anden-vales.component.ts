import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { ErpOrderMatch, ErpPendingBranch } from '../../receiving-session.service';
import { DIAS_PENDIENTES_ANDEN } from '@megadulces/contracts';
import { diasDesde, esAnterior, hoyMexico } from '../dia-mx';

/**
 * Andén · **paso 1 — cuál de los vales de hoy.**
 *
 * El folio manda visualmente porque es lo que trae el papel del chofer; el
 * proveedor y el monto están para reconocerlo de un vistazo sin leer el folio
 * entero.
 *
 * **No lleva la fecha en cada renglón de compra, a propósito:** con la regla de
 * sólo-hoy todos son del mismo día y repetirla nueve veces es ruido. El día se dice
 * una vez, en el encabezado.
 *
 * **`[WMS-REC.17]` Los traspasos van aparte y arriba.** Llegan con el EMBARQUE de quien
 * manda (otro documento, otra regla de día: salió hoy o sigue en camino), así que cada
 * uno dice de dónde viene, cuándo salió y si Kepler ya registró la recepción. Mezclarlos
 * con las compras haría pasar un "salió hace 3 días" por un vale de hoy.
 */
@Component({
  selector: 'app-anden-vales',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="va">
      <header class="va-hd">
        <button type="button" class="va-back" aria-label="Volver a sucursales" (click)="volver.emit()">←</button>
        <div class="va-id">
          <div class="va-nm">
            <span class="va-code">{{ sucursal().warehouse_code || sucursal().sucursal }}</span>
            <span>{{ sucursal().warehouse_name || 'Sucursal ' + sucursal().sucursal }}</span>
          </div>
          <p class="va-sub">{{ sucursal().pendientes | number }} por recibir · <span class="va-dia">{{ hoy }}</span></p>
        </div>
      </header>

      @if (cargando()) {
        <p class="va-nota">Buscando los vales de hoy…</p>
      } @else if (error()) {
        <div class="va-mal">
          <p class="va-mal-t">No se pudieron leer los vales</p>
          <p>{{ error() }}</p>
          <button pButton type="button" size="small" [outlined]="true" (click)="reintentar.emit()">Reintentar</button>
        </div>
      } @else if (!vales().length) {
        <!-- Puede pasar: el menú contó y alguien abrió el último desde otro equipo
             entre una pantalla y la otra. Se dice, no se deja una lista muda. -->
        <div class="va-cero">
          <h3>Ya no queda ninguno</h3>
          <p>Los vales de esta sucursal ya se abrieron. Puede haberlos tomado otra persona: buscalos en «En curso».</p>
          <button pButton type="button" [outlined]="true" (click)="volver.emit()">Volver a sucursales</button>
        </div>
      } @else {
        @if (traspasos().length) {
          <div class="va-cab">
            <span>Traspasos</span>
            <span>salieron hoy o siguen en camino</span>
          </div>
          <ul class="va-lista">
            @for (v of traspasos(); track 'UD41/' + v.sucursal + '/' + v.serie + '/' + v.folio) {
              <li>
                <button type="button" class="va-row va-row-tr" [disabled]="abriendo()" (click)="abrir.emit(v)">
                  <span class="va-folio">
                    Embarque {{ v.folio }}
                    <span class="va-chip">{{ v.origin?.label || 'Traspaso' }}</span>
                  </span>
                  <span class="va-monto">{{ v.monto | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }}</span>
                  <span class="va-prov">De {{ v.origin?.name || v.proveedor_nombre || 'Sucursal ' + v.sucursal }} · {{ estado(v) }}</span>
                  <span class="va-reng">{{ v.line_count | number }} {{ v.line_count === 1 ? 'renglón' : 'renglones' }}</span>
                </button>
              </li>
            }
          </ul>
        }

        @if (comprasHoy().length) {
          <div class="va-cab">
            <span>{{ traspasos().length ? 'Compras de hoy' : 'De hoy' }}</span>
            <span>con fecha de hoy en Kepler</span>
          </div>
          <ul class="va-lista">
            @for (v of comprasHoy(); track v.sucursal + '/' + v.folio) {
              <li>
                <button type="button" class="va-row" [disabled]="abriendo()" (click)="abrir.emit(v)">
                  <span class="va-folio">{{ v.folio }}</span>
                  <span class="va-monto">{{ v.monto | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }}</span>
                  <span class="va-prov">{{ v.proveedor_nombre || v.proveedor_code || 'Sin proveedor' }}</span>
                  <span class="va-reng">{{ v.line_count | number }} {{ v.line_count === 1 ? 'renglón' : 'renglones' }}</span>
                </button>
              </li>
            }
          </ul>
        }

        <!-- [WMS-REC.18] Lo que llegó otro día y nadie recibió. Aparte y abajo: lo de hoy
             sigue primero, pero lo atrasado ya no desaparece al cambiar el día. -->
        @if (comprasAntes().length) {
          <div class="va-cab va-cab-antes">
            <span>De días anteriores</span>
            <span>siguen sin recibir · hasta {{ diasAtras }} días</span>
          </div>
          <ul class="va-lista">
            @for (v of comprasAntes(); track v.sucursal + '/' + v.folio) {
              <li>
                <button type="button" class="va-row va-row-antes" [disabled]="abriendo()" (click)="abrir.emit(v)">
                  <span class="va-folio">{{ v.folio }}</span>
                  <span class="va-monto">{{ v.monto | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }}</span>
                  <span class="va-prov">{{ v.proveedor_nombre || v.proveedor_code || 'Sin proveedor' }} · {{ antiguedad(v) }}</span>
                  <span class="va-reng">{{ v.line_count | number }} {{ v.line_count === 1 ? 'renglón' : 'renglones' }}</span>
                </button>
              </li>
            }
          </ul>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .va { display: flex; flex-direction: column; gap: var(--sp-3); }
    .va-hd { display: flex; align-items: flex-start; gap: var(--sp-2); }
    .va-back {
      flex: 0 0 auto; width: 38px; height: 38px; cursor: pointer; font: inherit; font-size: var(--fs-body);
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-sm);
    }
    .va-id { flex-grow: 1; min-width: 0; }
    .va-nm { display: flex; align-items: center; gap: var(--sp-1);
      font-size: var(--fs-h3); font-weight: var(--fw-black); letter-spacing: -0.01em; }
    .va-code {
      padding: 2px 7px; background: var(--surface-ground); border-radius: var(--r-sm);
      font-size: var(--fs-xs); font-weight: var(--fw-black); font-variant-numeric: tabular-nums;
    }
    .va-sub { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted);
      font-variant-numeric: tabular-nums; }
    /* Sólo el día va con mayúscula ("Mar, 06/10"); capitalizar el renglón entero daba "Por Recibir". */
    .va-dia { text-transform: capitalize; }
    .va-nota { margin: 0; padding: var(--sp-3); text-align: center; font-size: var(--fs-sm); color: var(--text-muted); }
    .va-mal {
      display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2);
      padding: var(--sp-3); border-radius: var(--r-md);
      background: var(--bad-soft-bg, var(--surface-ground)); color: var(--bad-fg);
      font-size: var(--fs-xs); line-height: 1.45;
    }
    .va-mal p { margin: 0; }
    .va-mal-t { font-weight: var(--fw-bold); }
    .va-cab {
      display: flex; align-items: baseline; justify-content: space-between; padding: 0 2px;
      font-size: var(--fs-micro); color: var(--text-faint);
    }
    .va-cab span:first-child { font-weight: var(--fw-bold); letter-spacing: .09em; text-transform: uppercase; }
    .va-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .va-row {
      display: grid; grid-template-columns: 1fr auto; gap: 3px var(--sp-2); align-items: baseline;
      width: 100%; padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
    }
    .va-row:hover { border-color: var(--action); }
    /* El traspaso lleva el ámbar de "ojo con esto" del chip de origen: el reclamo es interno. */
    .va-row-tr { border-left: 3px solid var(--warn-fg); }
    .va-chip {
      margin-left: 6px; padding: 2px 7px; vertical-align: middle;
      font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .07em; text-transform: uppercase;
      border-radius: var(--r-pill); background: var(--warn-soft-bg); color: var(--warn-fg);
    }
    .va-row:disabled { opacity: .6; cursor: progress; }
    .va-folio { grid-column: 1; font-size: var(--fs-body); font-weight: var(--fw-black);
      font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
    .va-monto { grid-column: 2; grid-row: 1; font-size: var(--fs-sm); font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums; }
    .va-prov { grid-column: 1; min-width: 0; font-size: var(--fs-xs); color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .va-reng { grid-column: 2; grid-row: 2; font-size: var(--fs-micro); color: var(--text-faint);
      text-align: right; font-variant-numeric: tabular-nums; }
    .va-cero { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      text-align: center; padding: var(--sp-6) var(--sp-3); }
    .va-cero h3 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .va-cab-antes span:first-child { color: var(--warn-fg); }
    .va-row-antes { border-left: 3px solid var(--warn-fg); }
    .va-cero p { margin: 0 0 var(--sp-2); max-width: 32ch; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class AndenValesComponent {
  readonly sucursal = input.required<ErpPendingBranch>();
  readonly vales = input.required<ErpOrderMatch[]>();
  readonly cargando = input(false);
  readonly abriendo = input(false);
  readonly error = input<string | null>(null);

  readonly abrir = output<ErpOrderMatch>();
  readonly volver = output<void>();
  readonly reintentar = output<void>();

  /** Embarques de traspaso (`fuente = 'embarque'`): van primero y con su propia regla de día. */
  readonly traspasos = computed(() => this.vales().filter((v) => v.fuente === 'embarque'));
  /** Órdenes de entrada (sin `fuente` = orden de entrada, lo que existía antes). */
  readonly compras = computed(() => this.vales().filter((v) => v.fuente !== 'embarque'));
  /** `[WMS-REC.18]` Hoy en México como `YYYY-MM-DD` (el mismo día con que filtra el servidor). */
  readonly hoyIso = hoyMexico();
  /** Las de hoy van primero; las atrasadas, en su grupo. */
  readonly comprasHoy = computed(() => this.compras().filter((v) => !esAnterior(v.receipt_date, this.hoyIso)));
  readonly comprasAntes = computed(() => this.compras().filter((v) => esAnterior(v.receipt_date, this.hoyIso)));
  readonly diasAtras = DIAS_PENDIENTES_ANDEN;

  /** "de ayer", "de hace 3 días": cuánto lleva esperando. */
  antiguedad(v: ErpOrderMatch): string {
    const d = diasDesde(v.receipt_date, this.hoyIso);
    if (d === null) return 'sin fecha';
    if (d <= 1) return 'de ayer';
    return `de hace ${d} días`;
  }

  /**
   * Cómo va el traspaso, en palabras de andén. Que Kepler ya tenga la recepción NO quiere
   * decir que tenga caducidad: se dice para que nadie busque el camión en la calle.
   */
  estado(v: ErpOrderMatch): string {
    if (v.recibido_kepler) return 'Kepler ya registró la recepción';
    const d = v.dias_en_camino;
    if (d == null) return 'en camino';
    if (d < 0) return 'fechado a futuro en Kepler';
    if (d === 0) return 'salió hoy';
    if (d === 1) return 'salió ayer';
    return `salió hace ${d} días`;
  }

  readonly hoy = new Date().toLocaleDateString('es-MX', {
    weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Mexico_City',
  });
}
