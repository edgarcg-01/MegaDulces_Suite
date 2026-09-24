import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { ErpPendingBranch } from '../../receiving-session.service';

/**
 * Andén · **paso 0 — a qué sucursal entra la mercancía.**
 *
 * Reemplaza al "tecleá el folio" como primera pantalla. El bodeguero ya no tiene
 * que leer el papel para empezar: ve las plazas que le tocan y cuántos vales
 * quedan sin abrir en cada una.
 *
 * **Sólo los vales con fecha de HOY** (regla de negocio, Edgar 2026-09-24). El
 * día vacío es un estado de primera clase, no un accidente: medido en prod, el
 * día que se implementó había CERO vales de hoy en las 9 sucursales y 1 el día
 * anterior, mientras un día hábil normal trae entre 22 y 55. Por eso el vacío
 * explica el motivo, empuja el folio a mano —que es la salida que quedó a
 * propósito— y da la referencia de un día normal, para que quien lo mire sepa si
 * es un día flojo o si algo se rompió.
 *
 * **No se amplía sola a días pasados.** Ampliar en silencio sería decidir por el
 * dueño de la regla y además escondería que el dato del día no llegó.
 */
@Component({
  selector: 'app-anden-sucursales',
  standalone: true,
  imports: [DecimalPipe, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="su">
      <header class="su-hd">
        <div>
          <h2 class="su-t">Andén de Entrada</h2>
          <p class="su-s">¿A qué sucursal entra la mercancía?</p>
        </div>
        <span class="su-dia">{{ hoy() }}</span>
      </header>

      @if (alcanceAbierto()) {
        <!-- Se dice por qué salen todas en vez de fingir un filtro que la
             configuración no respalda. Medido: el rol almacenista tiene
             alcance all y 3 de los 4 bodegueros no tienen sucursal asignada. -->
        <p class="su-aviso">
          Estás viendo las <b>{{ sucursales().length }} sucursales</b> porque tu usuario no tiene una asignada.
        </p>
      }

      @if (cargando()) {
        <p class="su-nota">Buscando los vales de hoy…</p>
      } @else if (error()) {
        <div class="su-mal">
          <p class="su-mal-t">No se pudo leer el tablero de hoy</p>
          <p>{{ error() }}</p>
          <button pButton type="button" size="small" [outlined]="true" (click)="reintentar.emit()">Reintentar</button>
        </div>
      } @else if (!sucursales().length) {
        <!-- El día vacío. Con la regla de sólo-hoy se ve seguido, así que es una
             pantalla de verdad y no un renglón gris. -->
        <div class="su-cero">
          <div class="su-cero-ic" aria-hidden="true">
            <svg width="46" height="46" viewBox="0 0 48 48" fill="none">
              <rect x="7" y="13" width="34" height="27" rx="3" stroke="currentColor" stroke-width="2.2"/>
              <path d="M7 21H41" stroke="currentColor" stroke-width="2.2"/>
              <path d="M16 8V15M32 8V15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
          </div>
          <h3>Hoy no hay vales</h3>
          <p>
            Kepler no tiene ninguna entrada con fecha de hoy en las sucursales que te tocan.
            En cuanto capturen una, aparece acá.
          </p>
          <p class="su-cero-hint">
            <b>¿Llegó un camión igual?</b> El papel puede llegar antes que Kepler. Buscá el vale
            por su folio y recibilo sin esperar a que aparezca en la lista.
          </p>
          <button pButton type="button" class="su-cero-go" (click)="verFolio.emit()">Buscar por folio</button>
        </div>
      } @else {
        <div class="su-cab">
          <span>Vales de hoy sin abrir</span>
          <span>sólo la fecha de hoy</span>
        </div>

        <ul class="su-lista">
          @for (b of sucursales(); track b.sucursal) {
            <li>
              <button type="button" class="su-row" [class.su-row-mal]="b.sin_almacen"
                [disabled]="b.sin_almacen" (click)="elegir.emit(b)">
                <span class="su-code">{{ b.warehouse_code || b.sucursal }}</span>
                <span class="su-nm">
                  {{ b.warehouse_name || 'Sucursal ' + b.sucursal }}
                  @if (b.sin_almacen) { <small>sin almacén configurado — no se puede recibir</small> }
                </span>
                <span class="su-n">{{ b.pendientes | number }}</span>
              </button>
            </li>
          }
        </ul>

        <button pButton type="button" [text]="true" severity="secondary" class="su-folio" (click)="verFolio.emit()">
          ¿No aparece? Buscar por folio
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .su { display: flex; flex-direction: column; gap: var(--sp-3); }
    .su-hd { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-2); }
    .su-t { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-black); letter-spacing: -0.01em; }
    .su-s { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .su-dia {
      flex: 0 0 auto; padding: 3px 9px; border-radius: var(--r-pill);
      background: var(--card-bg); border: 1px solid var(--border-color);
      font-size: var(--fs-micro); font-weight: var(--fw-bold); color: var(--text-main);
      font-variant-numeric: tabular-nums; text-transform: capitalize;
    }
    .su-aviso {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--warn-soft-bg, var(--card-bg)); color: var(--warn-fg, var(--text-muted));
      border: 1px solid var(--border-color); border-left: 3px solid var(--warn-fg, var(--action));
      border-radius: var(--r-sm); font-size: var(--fs-xs); line-height: 1.45;
    }
    .su-nota {
      margin: 0; padding: var(--sp-3); text-align: center;
      font-size: var(--fs-sm); color: var(--text-muted);
    }
    .su-mal {
      display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2);
      padding: var(--sp-3); border-radius: var(--r-md);
      background: var(--bad-soft-bg, var(--surface-ground)); color: var(--bad-fg);
      font-size: var(--fs-xs); line-height: 1.45;
    }
    .su-mal p { margin: 0; }
    .su-mal-t { font-weight: var(--fw-bold); }
    .su-cab {
      display: flex; align-items: baseline; justify-content: space-between; padding: 0 2px;
      font-size: var(--fs-micro); color: var(--text-faint);
    }
    .su-cab span:first-child { font-weight: var(--fw-bold); letter-spacing: .09em; text-transform: uppercase; }
    .su-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .su-row {
      display: grid; grid-template-columns: auto 1fr auto; gap: var(--sp-2); align-items: center;
      width: 100%; min-height: 58px; padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
    }
    .su-row:hover { border-color: var(--action); }
    .su-row:disabled { opacity: .55; cursor: not-allowed; }
    .su-row:disabled:hover { border-color: var(--border-color); }
    .su-code {
      flex: 0 0 auto; min-width: 34px; height: 34px; padding: 0 6px;
      display: flex; align-items: center; justify-content: center;
      background: var(--surface-ground); border-radius: var(--r-sm);
      font-size: var(--fs-sm); font-weight: var(--fw-black); font-variant-numeric: tabular-nums;
    }
    .su-nm { min-width: 0; font-size: var(--fs-body); font-weight: var(--fw-medium); }
    .su-nm small { display: block; font-size: var(--fs-micro); font-weight: var(--fw-regular);
      color: var(--bad-fg); }
    .su-n {
      flex: 0 0 auto; min-width: 26px; height: 24px; padding: 0 8px;
      display: flex; align-items: center; justify-content: center;
      background: var(--action); color: var(--action-ink, #fff); border-radius: var(--r-pill);
      font-size: var(--fs-xs); font-weight: var(--fw-black); font-variant-numeric: tabular-nums;
    }
    .su-folio { width: 100%; min-height: 46px; }
    .su-cero {
      display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      text-align: center; padding: var(--sp-6) var(--sp-3) var(--sp-3);
    }
    .su-cero-ic { color: var(--text-faint); line-height: 0; }
    .su-cero h3 { margin: var(--sp-1) 0 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .su-cero p { margin: 0; max-width: 32ch; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
    .su-cero-hint {
      margin-top: var(--sp-2) !important; padding: var(--sp-2) var(--sp-3); text-align: left;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs) !important;
    }
    .su-cero-hint b { color: var(--text-main); }
    .su-cero-go { width: 100%; min-height: 54px; margin-top: var(--sp-2);
      font-size: var(--fs-body); font-weight: var(--fw-bold); }
  `],
})
export class AndenSucursalesComponent {
  readonly sucursales = input.required<ErpPendingBranch[]>();
  readonly cargando = input(false);
  readonly error = input<string | null>(null);
  /** El alcance del usuario no acota nada: se dice, no se finge. */
  readonly alcanceAbierto = input(false);

  readonly elegir = output<ErpPendingBranch>();
  readonly verFolio = output<void>();
  readonly reintentar = output<void>();

  /** El día que se está mostrando, en hora de México — la misma que filtra el backend. */
  readonly hoy = computed(() =>
    new Date().toLocaleDateString('es-MX', {
      weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Mexico_City',
    }),
  );
}
