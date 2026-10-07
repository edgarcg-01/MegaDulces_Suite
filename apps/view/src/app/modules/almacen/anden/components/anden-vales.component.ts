import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { ErpOrderMatch, ErpPendingBranch } from '../../receiving-session.service';

/**
 * Andén · **paso 1 — cuál de los vales de hoy.**
 *
 * El folio manda visualmente porque es lo que trae el papel del chofer; el
 * proveedor y el monto están para reconocerlo de un vistazo sin leer el folio
 * entero.
 *
 * **No lleva la fecha en cada renglón, a propósito:** con la regla de sólo-hoy
 * todos son del mismo día y repetirla nueve veces es ruido. El día se dice una
 * vez, en el encabezado.
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
          <p class="va-sub">{{ sucursal().pendientes | number }} vales de hoy · {{ hoy }}</p>
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
          <p>Los vales de hoy de esta sucursal ya se abrieron. Puede haberlos tomado otra persona.</p>
          <button pButton type="button" [outlined]="true" (click)="volver.emit()">Volver a sucursales</button>
        </div>
      } @else {
        <div class="va-cab">
          <span>Elegí el vale</span>
          <span>sólo la fecha de hoy</span>
        </div>

        <ul class="va-lista">
          @for (v of vales(); track v.sucursal + '/' + v.folio) {
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
      font-variant-numeric: tabular-nums; text-transform: capitalize; }
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

  readonly hoy = new Date().toLocaleDateString('es-MX', {
    weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Mexico_City',
  });
}
