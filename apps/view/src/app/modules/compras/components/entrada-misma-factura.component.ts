import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import type { FacturaCompartidaLiga, MismaFactura, MovimientoDeFactura } from '@megadulces/contracts';

/** `[RE.86]` El mínimo del motivo de ligar o desligar: el mismo que exige la base (CHECK) y el servidor. */
const MOTIVO_MIN = 10;

/**
 * `[RE.85]` La misma factura citada por varias entradas del proveedor, en el panel lateral de la entrada.
 * `[RE.86]` Y la acción que cierra ese caso: ligar esta entrada a la factura (o deshacer la liga), SÓLO con motivo.
 *
 * Las cinco preguntas (diseno 0b), contestadas antes de la plantilla:
 *  1. Qué ve y en qué orden: primero la respuesta (cuánto debe Kepler por esa factura contra lo que dice el CFDI,
 *     y qué significa la diferencia); debajo, la cadena en orden de fecha, cada movimiento con SU motivo; al final,
 *     UNA acción: «Es parte de esta factura» si la entrada no tiene papel, o «Deshacer la liga» si ya está ligada.
 *  2. Qué no ve: la sección no existe si ninguna otra entrada cita la factura y la entrada no está ligada; la
 *     referencia cruda de Kepler no se muestra (se muestra la factura por serie y folio). La acción no aparece a
 *     quien no tiene permiso de validar.
 *  3. Accesibilidad: cero clics para leer (va dentro del panel ya abierto); el origen del motivo va en TEXTO, no en
 *     color; el motivo se escribe en un campo con etiqueta y dice cuánto falta, y el botón no se activa sin él.
 *  4. Ligas: cada devolución o nota dice a qué entrada se aplicó; la que se está viendo dice «esta».
 *  5. ¿Le toca? Sí: Revisión de facturas es donde se decide si lo de Kepler cuadra con la factura.
 *
 * Jerarquía: primario = lo que debe Kepler contra la factura · secundario = cada movimiento y su importe ·
 * terciario = el motivo y de dónde salió.
 *
 * ⛔ Cada movimiento dice POR QUÉ se hizo (Edgar, 2026-11-23): el de Kepler, el deducido del dato, o
 * «sin motivo capturado» dicho en voz alta. Y ligar o desligar sólo existe con motivo escrito.
 */
@Component({
  selector: 'app-compras-entrada-misma-factura',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputTextModule],
  template: `
    @if (data() || ligada()) {
      <section class="mf" aria-labelledby="mf-t">
        <h3 id="mf-t" class="mf-h">{{ data() ? 'La misma factura en otras entradas' : 'Factura compartida' }}{{ factura() }}</h3>
        @if (data(); as m) {
          <p class="mf-res">
            <span class="mf-res-n">Kepler debe {{ money(m.neto_kepler) }}</span>
            @if (m.cfdi) { <span class="mf-res-s"> · la factura dice {{ money(m.cfdi.total) }}</span> }
          </p>
          <p class="mf-lect">{{ lectura() }}</p>
          <ol class="mf-lista">
            @for (x of m.movimientos; track x.tipo + x.folio) {
              <li class="mf-mov" [attr.data-esta]="x.es_esta ? '' : null">
                <div class="mf-fila">
                  <span class="mf-fecha">{{ fecha(x.fecha) }}</span>
                  <span class="mf-que">
                    {{ tipoTexto(x) }} <span class="mf-folio">{{ x.folio }}</span>
                    @if (x.es_esta) { <span class="mf-esta">esta</span> }
                    @if (x.aplicada_a) { <span class="mf-apl">aplicada a la entrada {{ x.aplicada_a }}</span> }
                  </span>
                  <span class="mf-imp">{{ conSigno(x.importe) }}</span>
                </div>
                <p class="mf-mot" [attr.data-origen]="x.motivo_origen">
                  <span class="mf-orig">{{ origenTexto(x.motivo_origen) }}</span>
                  {{ x.motivo ?? 'Nadie escribió por qué se hizo este movimiento.' }}
                </p>
              </li>
            }
          </ol>
        }
        @if (ligada(); as l) {
          <p class="mf-ligada">
            <span class="mf-orig">Ligada a esta factura{{ l.por ? ' por ' + l.por : '' }}{{ l.fecha ? ' el ' + fecha(l.fecha) : '' }}:</span>
            {{ l.motivo }}
          </p>
        }
        @if (accion(); as a) {
          @if (modo() === null) {
            <div class="mf-acc">
              <button pButton type="button" outlined severity="secondary" (click)="abrir(a)">
                <span class="p-button-icon p-button-icon-left pi {{ a === 'ligar' ? 'pi-link' : 'pi-times' }}" aria-hidden="true"></span>
                <span class="p-button-label">{{ a === 'ligar' ? 'Es parte de esta factura' : 'Deshacer la liga' }}</span>
              </button>
            </div>
          } @else {
            <div class="mf-form">
              <label class="mf-f" for="mf-motivo">{{ modo() === 'ligar' ? '¿Por qué esta entrada es parte de esta factura?' : '¿Por qué se deshace la liga?' }}</label>
              <textarea id="mf-motivo" pInputText rows="2" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)"
                        aria-describedby="mf-ayuda" [placeholder]="modo() === 'ligar' ? 'Ej.: llegó la caja que faltó de esa factura' : 'Ej.: se ligó a la factura equivocada'"></textarea>
              <p id="mf-ayuda" class="mf-ayuda">{{ faltan() > 0 ? 'Faltan ' + faltan() + ' caracteres.' : 'Queda escrito con tu nombre.' }}</p>
              <div class="mf-acc">
                <button pButton type="button" text (click)="cancelar()"><span class="p-button-label">Cancelar</span></button>
                <button pButton type="button" [disabled]="faltan() > 0 || enviando()" [loading]="enviando()" (click)="confirmar()">
                  <span class="p-button-label">{{ modo() === 'ligar' ? 'Ligar a esta factura' : 'Deshacer la liga' }}</span>
                </button>
              </div>
            </div>
          }
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .mf { display: flex; flex-direction: column; gap: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); }
    .mf-h { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .mf-res { margin: 0; font-variant-numeric: tabular-nums; }
    .mf-res-n { font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .mf-res-s { font-size: var(--fs-sm); color: var(--text-muted); }
    .mf-lect { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mf-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .mf-mov { padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: var(--sp-1); }
    .mf-mov[data-esta] .mf-que { font-weight: 700; }
    .mf-fila { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) auto; gap: var(--sp-2); align-items: baseline; font-size: var(--fs-sm); }
    .mf-fecha { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .mf-que { color: var(--text-main); min-width: 0; }
    .mf-folio { font-family: var(--font-mono); }
    .mf-esta { margin-left: var(--sp-1); font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); border: 1px solid var(--border-color); border-radius: var(--r-pill); padding: 0 var(--sp-1); }
    .mf-apl { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .mf-imp { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-main); text-align: right; white-space: nowrap; }
    .mf-mot { margin: 0 0 0 calc(4.5rem + var(--sp-2)); font-size: var(--fs-xs); color: var(--text-main); }
    .mf-orig { font-weight: 600; color: var(--text-muted); margin-right: var(--sp-1); }
    .mf-mot[data-origen="sin_motivo"] { color: var(--text-muted); }
    .mf-mot[data-origen="sin_motivo"] .mf-orig { color: var(--warn-fg); }
    .mf-ligada { margin: 0; padding-top: var(--sp-2); border-top: 1px solid var(--border-color); font-size: var(--fs-xs); color: var(--text-main); }
    .mf-form { display: flex; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-2); border-top: 1px solid var(--border-color); }
    .mf-f { font-size: var(--fs-xs); font-weight: 600; color: var(--text-main); }
    .mf-form textarea { width: 100%; resize: vertical; }
    .mf-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mf-acc { display: flex; gap: var(--sp-2); justify-content: flex-end; flex-wrap: wrap; }
    @media (max-width: 40rem) {
      .mf-fila { grid-template-columns: minmax(0, 1fr) auto; }
      .mf-fecha { grid-column: 1 / -1; }
      .mf-mot { margin-left: 0; }
    }
  `],
})
export class ComprasEntradaMismaFacturaComponent {
  readonly data = input<MismaFactura | null | undefined>(null);
  /** `[RE.86]` La liga compartida de esta entrada, si ya la tiene. */
  readonly ligada = input<FacturaCompartidaLiga | null | undefined>(null);
  /** `[RE.86]` Quien la ve puede ligar: tiene permiso de validar y la entrada no tiene papel propio. */
  readonly puedeLigar = input(false);
  /** `[RE.86]` Quien la ve puede deshacer una liga (permiso de validar). */
  readonly puedeDesligar = input(false);
  readonly enviando = input(false);
  readonly ligar = output<string>();
  readonly desligar = output<string>();

  readonly modo = signal<'ligar' | 'desligar' | null>(null);
  readonly motivo = signal('');
  readonly faltan = computed(() => Math.max(0, MOTIVO_MIN - this.motivo().trim().length));

  /** La única acción que ofrece la sección, o ninguna. */
  readonly accion = computed<'ligar' | 'desligar' | null>(() => {
    if (this.ligada()) return this.puedeDesligar() ? 'desligar' : null;
    return this.puedeLigar() && this.data()?.cfdi ? 'ligar' : null;
  });

  readonly factura = computed(() => {
    const c = this.data()?.cfdi;
    if (c) return ` · ${(c.serie ?? '').trim()}${c.folio ?? ''}`;
    const l = this.ligada();
    return l ? ` · ${(l.serie ?? '').trim()}${l.folio ?? ''}` : '';
  });

  /** `[RE.85]` Q.2: la diferencia contra la factura, dicha en llano. */
  readonly lectura = computed(() => {
    const m = this.data();
    if (!m) return '';
    if (!m.cfdi || m.diferencia == null) return 'Ninguna de estas entradas tiene el CFDI ligado: no se puede comparar contra la factura.';
    const d = m.diferencia;
    if (Math.abs(d) < 0.5) return 'Cuadra con la factura: lo que se descontó volvió a entrar.';
    if (d < 0) {
      return `Kepler debe ${this.money(-d)} menos que la factura: es lo descontado por devolución o nota que no ha vuelto a entrar. `
        + 'Si el proveedor no emitió la nota de crédito por eso, lo que se pague no va a cuadrar con lo facturado.';
    }
    return `Kepler debe ${this.money(d)} más que la factura: se cargó más de lo que se facturó.`;
  });

  abrir(a: 'ligar' | 'desligar'): void { this.motivo.set(''); this.modo.set(a); }
  cancelar(): void { this.modo.set(null); this.motivo.set(''); }
  confirmar(): void {
    const texto = this.motivo().trim();
    if (texto.length < MOTIVO_MIN || this.enviando()) return;
    if (this.modo() === 'ligar') this.ligar.emit(texto); else this.desligar.emit(texto);
  }

  tipoTexto(x: MovimientoDeFactura): string {
    return x.tipo === 'entrada' ? 'Entrada' : x.tipo === 'devolucion' ? 'Devolución' : 'Nota de crédito';
  }

  origenTexto(o: MovimientoDeFactura['motivo_origen']): string {
    return o === 'kepler' ? 'Motivo en Kepler:' : o === 'derivado' ? 'Deducido:' : 'Sin motivo capturado.';
  }

  money(v: number | string | null | undefined): string {
    const n = Number(v ?? 0);
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  conSigno(v: number): string {
    const n = Number(v);
    return `${n < 0 ? '−' : '+'}${this.money(Math.abs(n))}`;
  }

  fecha(f: string | null): string {
    if (!f) return 'sin fecha';
    const [y, m, d] = f.slice(0, 10).split('-');
    return d && m && y ? `${d}/${m}/${y.slice(2)}` : f;
  }
}
