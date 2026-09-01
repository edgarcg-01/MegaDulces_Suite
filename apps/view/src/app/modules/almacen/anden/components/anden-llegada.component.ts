import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { AndenLinea } from '../anden.state';
import { AndenCantidadComponent } from './anden-cantidad.component';
import { describirDiferencia } from '../cantidad.util';

/**
 * Andén · **Llegada** — cotejo contra Kepler y acceso. Corre contra el chofer.
 *
 * Una sola pregunta: ¿esto es lo que Kepler dijo que mandaban? Se cuenta por
 * tarima y se da acceso; la mercancía entra **sin fecha, en lote `NA`**, y el
 * camión se va.
 *
 * Acá **nadie fotografía etiquetas**: cada segundo es andén ocupado, y ése es el
 * recurso que no se quiere gastar. Todo lo lento vive en Caducidad y Ubicación.
 */
@Component({
  selector: 'app-anden-llegada',
  standalone: true,
  imports: [DecimalPipe, ButtonModule, AndenCantidadComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (capturando(); as c) {
      <div class="ct-cap">
        <header class="ct-cap-hd">
          <div>
            <h3 class="ct-cap-nm">{{ nombre(c) }}</h3>
            <p class="ct-cap-sk">
              {{ c.sku || c.expected_sku || '—' }}
              @if (c.uxc) { · leíste el código de <b>CAJA de {{ c.uxc }}</b> }
            </p>
          </div>
          <button type="button" class="ct-x" aria-label="Cancelar" (click)="cerrarCaptura.emit()">✕</button>
        </header>
        <p class="ct-nota">
          Kepler espera <b>{{ c.expected_qty | number }} pz</b>@if (c.uxc) { — o sea <b>{{ +c.expected_qty / c.uxc }} cajas</b> de {{ c.uxc }}}.
        </p>
        <app-anden-cantidad
          [esperado]="+c.expected_qty" [uxc]="c.uxc" [inicial]="+(c.contado ?? 0)"
          (confirmar)="contar.emit({ linea: c, cantidad: $event })" />
      </div>
    } @else {
      <button type="button" class="ct-scan" (click)="abrirSiguiente()">
        <span class="ct-scan-ic" aria-hidden="true">|||‖|‖||</span>
        <span class="ct-scan-t">Escaneá la tarima</span>
        <span class="ct-scan-d">o tocá una línea para capturar otra cantidad</span>
      </button>

      <ul class="ct-lista">
        @for (l of lineas(); track l.id) {
          <li>
            <button type="button" class="ct-row"
              [class.ct-ok]="l.contado !== undefined && l.contado === +l.expected_qty"
              [class.ct-next]="l.contado === undefined && l.id === siguiente()?.id"
              (click)="abrir.emit(l)">
              <span class="ct-nm">{{ nombre(l) }}</span>
              <span class="ct-sk">
                @if (l.contado === undefined) {
                  {{ l.sku || l.expected_sku || '—' }}@if (l.uxc) { · caja de {{ l.uxc }} }
                } @else if (l.contado !== +l.expected_qty) {
                  {{ describir(+l.expected_qty - l.contado, l.uxc) }}
                } @else { completo }
              </span>
              <span class="ct-qt">
                {{ l.contado === undefined ? '—' : (l.contado | number) }}
                <span class="ct-esp">/{{ l.expected_qty | number }}</span>
              </span>
            </button>
          </li>
        }
      </ul>

      <p class="ct-nota" [class.ct-alerta]="diferencias() > 0">
        Kepler mandó <b>{{ lineas().length }} líneas</b> ·
        {{ listo() ? (unidades() | number) + ' pz cotejadas' : contadas() + ' de ' + lineas().length + ' cotejadas' }}
        @if (diferencias() > 0) { · <b>{{ diferencias() }} con diferencia</b> }
        @else if (listo()) { · <b>sin diferencias</b> }
      </p>

      <button pButton type="button" class="ct-go" [disabled]="!listo() || guardando()"
        [loading]="guardando()" (click)="darAcceso.emit()">
        {{ listo() ? 'Dar acceso' : 'Faltan ' + (lineas().length - contadas()) + ' por cotejar' }}
      </button>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ct-scan {
      width: 100%; padding: var(--sp-4) var(--sp-3); cursor: pointer; text-align: center;
      display: flex; flex-direction: column; gap: 3px;
      background: var(--card-bg); color: var(--text-main); font: inherit;
      border: 2px dashed var(--border-color); border-radius: var(--r-lg);
    }
    .ct-scan:hover, .ct-scan:focus-visible { border-color: var(--action); outline: none; }
    .ct-scan-ic { font-size: 24px; letter-spacing: -2px; color: var(--action); }
    .ct-scan-t { font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .ct-scan-d { font-size: var(--fs-micro); color: var(--text-faint); }
    .ct-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .ct-row {
      display: grid; grid-template-columns: 1fr auto; gap: 2px var(--sp-3); align-items: center;
      width: 100%; min-height: 52px; padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
    }
    .ct-row:hover { border-color: var(--action); }
    .ct-next { box-shadow: inset 3px 0 0 var(--action); }
    .ct-ok { opacity: .6; }
    .ct-nm { font-size: var(--fs-sm); font-weight: var(--fw-medium); min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ct-sk { font-size: var(--fs-micro); color: var(--text-faint); grid-column: 1; }
    .ct-qt { grid-column: 2; grid-row: 1 / 3; align-self: center; font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ct-esp { color: var(--text-faint); font-weight: var(--fw-regular); }
    .ct-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .ct-nota b { color: var(--text-main); }
    .ct-alerta { border-left-color: var(--warn-fg, var(--action)); }
    .ct-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .ct-cap { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ct-cap-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .ct-cap-nm { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); line-height: 1.2; text-wrap: balance; }
    .ct-cap-sk { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ct-x {
      flex: 0 0 auto; min-width: 36px; min-height: 36px;
      background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      color: var(--text-muted); font: inherit; cursor: pointer;
    }
  `],
})
export class AndenLlegadaComponent {
  readonly lineas = input.required<AndenLinea[]>();
  readonly contadas = input.required<number>();
  readonly unidades = input.required<number>();
  readonly diferencias = input.required<number>();
  readonly listo = input.required<boolean>();
  readonly siguiente = input<AndenLinea | null>(null);
  readonly capturando = input<AndenLinea | null>(null);
  readonly guardando = input(false);

  readonly abrir = output<AndenLinea>();
  readonly cerrarCaptura = output<void>();
  readonly contar = output<{ linea: AndenLinea; cantidad: number }>();
  readonly darAcceso = output<void>();

  readonly hayPendiente = computed(() => this.siguiente() !== null);

  nombre(l: AndenLinea): string {
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  }

  describir(diff: number, uxc: number | null): string {
    // `diff` acá es esperado − contado, así que el signo se invierte para leerlo
    // en el idioma del bodeguero ("faltan" cuando contó de menos).
    return describirDiferencia(-diff, uxc);
  }

  abrirSiguiente(): void {
    const l = this.siguiente();
    if (l) this.abrir.emit(l);
  }
}
