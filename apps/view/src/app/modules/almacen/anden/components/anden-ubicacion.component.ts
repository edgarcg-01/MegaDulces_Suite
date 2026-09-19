import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { AndenLote } from '../anden.state';
import { WarehouseBin } from '../../bin-location.service';
import { formatExpiryEcho } from '../../shared/expiry-short';
import { ScanFieldComponent } from './scan-field.component';

export interface UbicadoConfirmado {
  lote: AndenLote;
  cantidad: number;
  binCode: string;
}

export interface UbicacionNueva {
  code: string;
  label: string;
}

/** Los tipos de ubicación que hay en la bodega. No es una tabla: es el vocabulario. */
export const TIPOS_UBICACION = [
  { key: 'rack', label: 'Rack', prefijo: 'R' },
  { key: 'tarima', label: 'Tarima', prefijo: 'T' },
  { key: 'otro', label: 'Otro', prefijo: 'U' },
] as const;

export type TipoUbicacion = (typeof TIPOS_UBICACION)[number]['key'];

/** Compara códigos como los compara el backend: sin espacios y sin importar mayúsculas. */
function mismo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Andén · **Ubicación** — le da rack o tarima al lote que ya está en existencia.
 *
 * Va después de fechar, y lo que se acomoda es un **LOTE** (producto + lote +
 * caducidad), no un renglón: es la unidad que el auxiliar de ubicaciones guarda,
 * y mandar el lote equivocado deja la mercancía "ubicada" en un lote que no es.
 *
 * **La ubicación puede no existir todavía, y ése es el caso normal.** Medido:
 * `commercial.warehouse_bins` está en CERO — nadie ha dado de alta un rack. Así
 * que "escaneá el rack" no alcanza: no hay etiqueta que escanear hasta que
 * alguien la crea y la imprime. Por eso crear la ubicación es parte de este
 * panel y no un viaje a la pantalla de administración: el bodeguero tiene la
 * tarima en las manos.
 *
 * **El rack sugerido viene precargado** desde `pick-suggestion` — donde ya vive
 * el SKU — y sólo se escanea cuando va a otro lado.
 */
@Component({
  selector: 'app-anden-ubicacion',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ButtonModule, InputTextModule, ScanFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ub">
      <header class="ub-hd">
        <div>
          <h3 class="ub-nm">{{ nombre() }}</h3>
          <p class="ub-sk">
            {{ lote().sku || '—' }} · lote <b>{{ lote().lot_code }}</b>
            @if (lote().expiry_date) { · caduca <b>{{ caducidad() }}</b> }
          </p>
          <p class="ub-qt"><b>{{ lote().porUbicar | number }} pz</b> por acomodar</p>
        </div>
        <button type="button" class="ub-back" (click)="volver.emit()">← Lista</button>
      </header>

      @if (!creando()) {
        <p class="ub-nota">
          @if (lote().binSugerido) {
            Este SKU ya vive en <b>{{ lote().binSugerido }}</b>. Viene precargado; escaneá el rack si va a otro lado.
          } @else if (!bins().length) {
            Todavía no hay ninguna ubicación dada de alta en este almacén. Creá la primera acá abajo.
          } @else {
            Sin ubicación previa para este SKU. Escaneá el rack donde lo vas a dejar.
          }
        </p>

        <!-- Misma barra que las listas. El Enter de la pistola acomoda directo:
             escanear el rack y confirmar son un solo gesto. -->
        <app-scan-field
          #scan
          etiqueta="Rack o tarima"
          placeholder="Escaneá o escribí el código"
          [valor]="bin()"
          [conCamara]="true"
          (valorChange)="bin.set($event)"
          (enter)="emitir()"
          (sinCamara)="sinCamara.emit($event)"
        />

        <!-- Qué es lo que se tecleó. Sin esto, escribir un código que no existe
             sólo se descubre al guardar, con un 404 del backend. -->
        @if (bin().trim()) {
          @if (encontrado(); as b) {
            <p class="ub-res ub-ok">
              <b>{{ b.code }}</b>{{ b.label ? ' · ' + b.label : '' }} —
              @if (+(b.units || 0) > 0) { ya tiene {{ +(b.units || 0) | number }} pz } @else { está vacía }
            </p>
          } @else {
            <div class="ub-res ub-new">
              <p><b>{{ bin().trim() }}</b> no existe en este almacén todavía.</p>
              <button pButton type="button" size="small" [outlined]="true" (click)="abrirCrear(bin().trim())">
                Crear esta ubicación
              </button>
            </div>
          }
        }

        <button pButton type="button" class="ub-go" [loading]="guardando()"
          [disabled]="!encontrado() || guardando()" (click)="emitir()">
          {{ encontrado() ? 'Acomodar en ' + encontrado()!.code : 'Elegí o creá la ubicación' }}
        </button>

        <button pButton type="button" [text]="true" severity="secondary" class="ub-alt"
          [disabled]="guardando()" (click)="abrirCrear('')">
          Crear una ubicación nueva
        </button>
      } @else {
        <div class="ub-form">
          <p class="ub-nota">
            La ubicación se crea acá y sale su cartel para pegarlo en el rack. Sin
            cartel, nadie la vuelve a encontrar ni la pistola la puede leer.
          </p>

          <div class="ub-tipos" role="group" aria-label="Tipo de ubicación">
            @for (t of tipos; track t.key) {
              <button type="button" class="ub-tipo" [class.ub-tipo-on]="tipo() === t.key"
                (click)="setTipo(t.key)">{{ t.label }}</button>
            }
          </div>

          <div class="ub-campos">
            <label class="ub-f">
              <span>Número o nombre</span>
              <input pInputText [ngModel]="num()" (ngModelChange)="setNum($event)" placeholder="12" />
            </label>
            <label class="ub-f">
              <span>Código a escanear</span>
              <input pInputText class="ub-code" [ngModel]="code()" (ngModelChange)="setCode($event)"
                placeholder="R-12" />
            </label>
          </div>
          <p class="ub-eco">
            Va a quedar como <b>{{ etiquetaFinal() || '—' }}</b>
            @if (code().trim()) { con código <b>{{ code().trim().toUpperCase() }}</b> }
          </p>
          @if (duplicada()) {
            <p class="ub-res ub-mal">
              Ya existe una ubicación con el código <b>{{ code().trim().toUpperCase() }}</b>.
              Usá esa o cambiá el código.
            </p>
          }

          <button pButton type="button" class="ub-go" [loading]="creandoBusy()"
            [disabled]="!code().trim() || duplicada() || creandoBusy()" (click)="crearla()">
            Crear e imprimir el cartel
          </button>
          <button pButton type="button" [text]="true" severity="secondary" class="ub-alt"
            [disabled]="creandoBusy()" (click)="creando.set(false)">
            Cancelar
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ub { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ub-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .ub-nm { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); line-height: 1.2; text-wrap: balance; }
    .ub-sk { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ub-sk b { color: var(--text-main); }
    .ub-qt { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ub-qt b { color: var(--text-main); font-size: var(--fs-sm); }
    .ub-back {
      flex: 0 0 auto; min-height: 36px; padding: 0 var(--sp-2);
      background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      color: var(--text-muted); font: inherit; font-size: var(--fs-xs); cursor: pointer;
    }
    .ub-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .ub-nota b { color: var(--text-main); }
    .ub-res {
      margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
      font-size: var(--fs-xs); line-height: 1.45; font-variant-numeric: tabular-nums;
    }
    .ub-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ub-mal { background: var(--bad-soft-bg, var(--surface-ground)); color: var(--bad-fg); }
    .ub-new {
      display: flex; flex-direction: column; gap: var(--sp-2); align-items: flex-start;
      background: var(--warn-soft-bg, var(--surface-ground)); color: var(--warn-fg, var(--text-main));
    }
    .ub-new p { margin: 0; }
    .ub-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ub-tipos { display: flex; gap: var(--sp-1); }
    .ub-tipo {
      flex: 1; min-height: 46px; cursor: pointer; font: inherit;
      font-size: var(--fs-sm); font-weight: var(--fw-medium);
      background: var(--card-bg); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
    }
    .ub-tipo-on { border-color: var(--action); color: var(--action); font-weight: var(--fw-bold); }
    .ub-campos { display: flex; gap: var(--sp-2); }
    .ub-f { display: flex; flex-direction: column; gap: var(--sp-1); flex: 1; min-width: 0; }
    .ub-f > span { font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .1em;
      text-transform: uppercase; color: var(--text-muted); }
    .ub-f input { min-height: 48px; }
    .ub-code { font-weight: var(--fw-bold); letter-spacing: .06em; text-transform: uppercase; }
    .ub-eco { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); text-align: center; }
    .ub-eco b { color: var(--text-main); }
    .ub-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .ub-alt { width: 100%; }
  `],
})
export class AndenUbicacionComponent {
  readonly lote = input.required<AndenLote>();
  /** Las ubicaciones que ya existen en el almacén del vale. */
  readonly bins = input<WarehouseBin[]>([]);
  readonly guardando = input(false);
  readonly creandoBusy = input(false);
  /**
   * Código de la ubicación recién creada. Llega por input y no por un método
   * porque **este componente se destruye mientras el cartel está en pantalla**:
   * cuando vuelve es una instancia nueva, así que llamarle un método al viejo no
   * deja rastro y el bodeguero se encontraba el campo vacío justo después de
   * crear el rack.
   */
  readonly codigoNuevo = input<string | null>(null);

  readonly confirmar = output<UbicadoConfirmado>();
  readonly crear = output<UbicacionNueva>();
  readonly sinCamara = output<string>();
  readonly volver = output<void>();

  readonly tipos = TIPOS_UBICACION;

  readonly bin = signal('');
  readonly creando = signal(false);
  readonly tipo = signal<TipoUbicacion>('rack');
  readonly num = signal('');
  readonly code = signal('');
  /** El código se toca a mano: desde ahí deja de derivarse de tipo + número. */
  private readonly codeManual = signal(false);

  private readonly scan = viewChild<ScanFieldComponent>('scan');

  readonly nombre = computed(() => {
    const l = this.lote();
    return l.product_name || l.sku || 'Sin nombre';
  });

  readonly caducidad = computed(() => formatExpiryEcho(this.lote().expiry_date));

  readonly encontrado = computed(() => {
    const c = this.bin().trim();
    if (!c) return null;
    return this.bins().find((b) => mismo(b.code, c)) ?? null;
  });

  readonly duplicada = computed(() => {
    const c = this.code().trim();
    return !!c && this.bins().some((b) => mismo(b.code, c));
  });

  readonly etiquetaFinal = computed(() => {
    const t = TIPOS_UBICACION.find((x) => x.key === this.tipo());
    const n = this.num().trim();
    if (!t) return '';
    return n ? `${t.label} ${n}` : t.label;
  });

  constructor() {
    // El rack sugerido se precarga al abrir cada lote — incluido el siguiente
    // cuando se encadena, que es donde se gana el toque.
    effect(() => {
      const l = this.lote();
      this.bin.set(this.codigoNuevo() || l.binSugerido || '');
      this.creando.set(false);
      this.codeManual.set(false);
    });
  }

  /** El padre la llama tras guardar: la pistola tiene que poder disparar de nuevo. */
  enfocar(): void { this.scan()?.enfocar(); }

  abrirCrear(codigoPropuesto: string): void {
    this.creando.set(true);
    this.codeManual.set(!!codigoPropuesto);
    this.code.set(codigoPropuesto);
    if (!codigoPropuesto) this.num.set('');
  }

  setTipo(t: TipoUbicacion): void {
    this.tipo.set(t);
    this.recalcularCode();
  }

  setNum(v: unknown): void {
    this.num.set(String(v ?? ''));
    this.recalcularCode();
  }

  setCode(v: unknown): void {
    this.codeManual.set(true);
    this.code.set(String(v ?? '').toUpperCase());
  }

  /**
   * El código se propone solo (`R-12`) mientras nadie lo haya tocado. En cuanto
   * el operario lo escribe a mano deja de recalcularse: si no, cambiar el tipo
   * le borraría el código que acaba de leer del cartel viejo.
   */
  private recalcularCode(): void {
    if (this.codeManual()) return;
    const t = TIPOS_UBICACION.find((x) => x.key === this.tipo());
    const n = this.num().trim().toUpperCase().replace(/\s+/g, '-');
    this.code.set(t && n ? `${t.prefijo}-${n}` : '');
  }

  crearla(): void {
    const c = this.code().trim().toUpperCase();
    if (!c || this.duplicada()) return;
    this.crear.emit({ code: c, label: this.etiquetaFinal() || c });
  }

  emitir(): void {
    const b = this.encontrado();
    if (!b) return;
    this.confirmar.emit({ lote: this.lote(), cantidad: this.lote().porUbicar, binCode: b.code });
  }
}
