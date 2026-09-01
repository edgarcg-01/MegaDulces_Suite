import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ErpOrderMatch } from '../../receiving-session.service';

/**
 * Andén · paso 0 — identificar el vale.
 *
 * **El andén arranca con el folio del papel, no con una lista.** Es la diferencia
 * de fondo con la pantalla vieja: el bodeguero no entra a buscar entre sesiones
 * abiertas, entra con el papel que le dio el chofer en la mano. Lo único que ese
 * papel trae es el folio.
 */
@Component({
  selector: 'app-anden-folio',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="af">
      <p class="af-lead">
        Llegó un camión. En el papel que trae el chofer viene el folio del vale que mandó Kepler.
      </p>

      <label class="af-label" for="af-folio">Folio del vale · Kepler</label>
      <div class="af-row">
        <input
          id="af-folio"
          #campo
          pInputText
          class="af-input"
          inputmode="text"
          autocomplete="off"
          autocapitalize="characters"
          placeholder="909"
          [ngModel]="folio()"
          (ngModelChange)="folioChange.emit($event)"
          (keyup.enter)="buscar.emit()"
        />
        <button pButton type="button" class="af-btn" [loading]="buscando()" (click)="buscar.emit()">
          BUSCAR
        </button>
      </div>
      <p class="af-hint">Escaneá el papel o tecleá el folio y buscá</p>

      @if (candidatos().length > 1) {
        <p class="af-multi">{{ candidatos().length }} vales coinciden. Elegí cuál:</p>
        <div class="af-list">
          @for (c of candidatos(); track c.sucursal + c.folio) {
            <button type="button" class="af-cand" (click)="elegir.emit(c)">
              <span class="af-cand-folio">{{ c.folio }}</span>
              <span class="af-cand-prov">{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
              <span class="af-cand-meta">suc. {{ c.sucursal }} · {{ c.line_count }} líneas</span>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .af-lead {
      margin: 0 0 var(--sp-4);
      padding: var(--sp-3);
      border-left: 3px solid var(--action);
      background: var(--surface-ground);
      border-radius: 0 var(--r-sm) var(--r-sm) 0;
      font-size: var(--fs-sm);
      color: var(--text-main);
      text-wrap: pretty;
    }
    .af-label {
      display: block;
      font-size: var(--fs-micro);
      font-weight: var(--fw-bold);
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: var(--sp-2);
    }
    .af-row { display: flex; gap: var(--sp-2); }
    /* El folio es lo más grande de esta pantalla: es lo único que se hace acá. */
    .af-input {
      flex: 1; min-width: 0; min-height: 56px;
      font-size: var(--fs-h2); font-weight: var(--fw-bold);
      letter-spacing: .04em; font-variant-numeric: tabular-nums;
    }
    .af-btn { min-height: 56px; flex: 0 0 auto; font-weight: var(--fw-bold); letter-spacing: .06em; }
    .af-hint { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-faint); }
    .af-multi { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-medium); }
    .af-list { display: flex; flex-direction: column; gap: var(--sp-2); }
    .af-cand {
      display: grid; gap: 2px; width: 100%; min-height: 56px;
      padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
    }
    .af-cand:hover { border-color: var(--action); }
    .af-cand-folio { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .af-cand-prov { font-size: var(--fs-sm); }
    .af-cand-meta { font-size: var(--fs-xs); color: var(--text-muted); }
  `],
})
export class AndenFolioComponent implements AfterViewInit {
  readonly folio = input.required<string>();
  readonly buscando = input(false);
  readonly candidatos = input<ErpOrderMatch[]>([]);

  readonly folioChange = output<string>();
  readonly buscar = output<void>();
  readonly elegir = output<ErpOrderMatch>();

  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');

  ngAfterViewInit(): void {
    // Con pistola en modo wedge el disparo va al elemento enfocado: si el campo
    // no tiene el foco, el escaneo se pierde.
    setTimeout(() => this.campo()?.nativeElement.focus(), 0);
  }
}
