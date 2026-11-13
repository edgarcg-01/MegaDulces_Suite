import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import {
  CategorizarEgresoApi, type CategoriaEgreso, type ResultadoCategorizar, type VistaPreviaBeneficiario,
  sugerenciaBeneficiario, textoCategorizado,
} from './categorizar-egreso.api';

let siguienteId = 0;

/**
 * `[CP.8.80]` / `[CB.70]` — **Categorizar un egreso de banco sin categoría**, y si se pide, todos los que empiecen
 * con el mismo nombre (la regla del motor de bancos, al final del catálogo: sólo toma lo que nadie toma).
 *
 * Nació dentro del puente ContPAQi; desde CB.70 es una pieza porque Bancos la usa también, en el detalle de un
 * movimiento. ⛔ Una sola pieza, un solo endpoint, un solo permiso (`FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR`): quien la
 * pinta decide si se muestra; el guard del endpoint es la puerta.
 *
 * Las cinco preguntas (diseno §0b), para Bancos:
 *  1. Ve la categoría (lista con búsqueda) y, prendida por defecto, la regla por nombre con lo que tomaría.
 *  2. No ve prioridades ni expresiones: la regla se arma sola («empieza con», palabra completa).
 *  3. A un clic desde el detalle del movimiento; la lista se busca escribiendo; todo con teclado.
 *  4. Ligada al archivo de ContPAQi (un egreso sin categoría no entra) y al Cierre de Bancos (deja de contarlo).
 *  5. La ve quien tiene el permiso de categorizar; quien no, ve quién lo hace.
 */
@Component({
  selector: 'app-categorizar-egreso',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe, FormsModule, SelectModule, CheckboxModule, InputTextModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ce" role="group" [attr.aria-label]="'Categorizar ' + (movimiento().concepto || 'el egreso')">
      <div class="ce-campos">
        <p-select [options]="categorias() ?? []" optionLabel="nombre" optionValue="code" [filter]="true" filterBy="nombre"
                  appendTo="body" placeholder="Categoría" ariaLabel="Categoría" styleClass="ce-sel"
                  [loading]="categorias() === null" [ngModel]="elegida()" (ngModelChange)="elegida.set($event)" />
        <span class="ce-sug">
          <p-checkbox [binary]="true" [inputId]="idCasilla" [ngModel]="recordar()" (ngModelChange)="cambiarRecordar($event)" />
          <label [for]="idCasilla">y todos los que empiecen con</label>
        </span>
        <input pInputText type="text" class="ce-texto" [disabled]="!recordar()" aria-label="Nombre del beneficiario"
               [ngModel]="texto()" (ngModelChange)="escribirTexto($event)" />
      </div>
      @if (error(); as e) { <p class="ce-mal" role="alert">{{ e }}</p> }
      @if (recordar()) {
        @if (previaError(); as pe) { <p class="ce-mal" role="alert">{{ pe }}</p> }
        @else if (previa(); as v) {
          <p class="ce-nota">Toma <strong class="mono">{{ v.movimientos | number }}</strong> egresos sin categoría
            (<span class="mono">{{ v.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>) de todos los meses, y los que traigan los próximos estados de cuenta.
            @if (v.regla_existente; as re) { Ya hay una regla con ese texto: {{ re.categoria }}. }</p>
          <ul class="ce-lista">
            @for (f of v.filas.slice(0, 8); track f.id) {
              <li><span class="mono ce-tenue">{{ f.fecha }}</span> {{ f.concepto }} <span class="mono">{{ f.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></li>
            }
          </ul>
          @if (v.movimientos > 8) { <p class="ce-tenue ce-chico">Se muestran 8 de {{ v.movimientos | number }}.</p> }
        } @else { <p class="ce-tenue ce-chico">Calculando qué toma…</p> }
      }
      <div class="ce-acciones">
        <button pButton type="button" class="p-button-sm" [disabled]="!puedeGuardar()" [loading]="guardando()" (click)="guardar()">
          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar</span></button>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="cancelar.emit()"><span class="p-button-label">Cancelar</span></button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ce { padding: var(--sp-2) 0; }
    .ce-campos { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    :host ::ng-deep .ce-sel.p-select { min-width: 14rem; font-size: var(--fs-sm); }
    .ce-sug { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .ce-sug label { cursor: pointer; }
    .ce-texto { width: 16rem; max-width: 100%; font-size: var(--fs-sm); }
    .ce-texto:disabled { color: var(--text-muted); }
    .ce-nota { margin: var(--sp-2) 0 var(--sp-1); font-size: var(--fs-sm); color: var(--text-main); }
    .ce-lista { margin: 0; padding-left: var(--sp-4); font-size: var(--fs-xs); max-height: 10rem; overflow: auto; }
    .ce-lista li { padding: 2px 0; }
    .ce-tenue { color: var(--text-muted); }
    .ce-chico { font-size: var(--fs-xs); margin: var(--sp-1) 0 0; }
    .ce-mal { color: var(--bad-fg); font-size: var(--fs-sm); font-weight: 600; margin: var(--sp-2) 0 0; }
    .ce-acciones { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
  `],
})
export class CategorizarEgresoComponent implements OnInit {
  private readonly api = inject(CategorizarEgresoApi);
  private readonly destroyRef = inject(DestroyRef);

  /** El egreso a categorizar: su id de `finance.bank_movements` y el concepto (de ahí sale el nombre propuesto). */
  readonly movimiento = input.required<{ id: string; concepto: string | null }>();
  /** Ya quedó guardado: `texto` es el aviso listo para mostrar. */
  readonly guardado = output<{ resultado: ResultadoCategorizar; texto: string }>();
  readonly cancelar = output<void>();

  readonly idCasilla = `ce-recordar-${++siguienteId}`;
  readonly categorias = signal<CategoriaEgreso[] | null>(null);
  readonly elegida = signal('');
  readonly recordar = signal(true);
  readonly texto = signal('');
  readonly previa = signal<VistaPreviaBeneficiario | null>(null);
  readonly previaError = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  private esperaPrevia: ReturnType<typeof setTimeout> | null = null;
  /** Sólo cuenta la última vista previa pedida: una lenta que llega tarde no pisa a la nueva. */
  private previaPedida = 0;

  /** ⛔ Con la casilla, no se guarda sin haber visto qué toma la regla. */
  readonly puedeGuardar = computed(() => {
    const elegida = this.elegida(), guardando = this.guardando(), recordar = this.recordar();
    const previa = this.previa(), error = this.previaError();
    return !!elegida && !guardando && (!recordar || (!!previa && !error));
  });

  ngOnInit(): void {
    this.texto.set(sugerenciaBeneficiario(this.movimiento().concepto));
    this.destroyRef.onDestroy(() => { if (this.esperaPrevia) clearTimeout(this.esperaPrevia); this.previaPedida += 1; });
    this.api.categoriasEgreso().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => this.categorias.set(c),
      error: (e) => {
        this.categorias.set([]);
        this.error.set(`No se pudieron leer las categorías: ${e?.error?.message ?? 'error de red'}`);
      },
    });
    this.pedirPrevia();
  }

  cambiarRecordar(v: boolean): void {
    this.recordar.set(!!v);
    if (v) this.pedirPrevia();
  }

  escribirTexto(v: string): void {
    this.texto.set(v ?? '');
    this.previa.set(null);
    this.previaError.set(null);
    if (this.esperaPrevia) clearTimeout(this.esperaPrevia);
    this.esperaPrevia = setTimeout(() => this.pedirPrevia(), 400);
  }

  private pedirPrevia(): void {
    if (!this.recordar()) return;
    const n = ++this.previaPedida;
    this.previa.set(null);
    this.previaError.set(null);
    this.api.vistaPreviaBeneficiario(this.movimiento().id, this.texto()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => { if (n === this.previaPedida) this.previa.set(v); },
      error: (e) => { if (n === this.previaPedida) this.previaError.set(e?.error?.message ?? 'No se pudo calcular qué toma la regla.'); },
    });
  }

  guardar(): void {
    if (!this.puedeGuardar()) return;
    this.guardando.set(true);   // idempotencia visual: el segundo clic ya no pasa
    this.error.set(null);
    const categoria = this.elegida();
    const body = this.recordar() ? { categoria, beneficiario: this.texto() } : { categoria };
    this.api.categorizar(this.movimiento().id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.guardando.set(false);
        const nombre = this.categorias()?.find((c) => c.code === r.categoria)?.nombre ?? r.categoria;
        this.guardado.emit({ resultado: r, texto: textoCategorizado(r, nombre) });
      },
      error: (e) => {
        this.guardando.set(false);
        this.error.set(e?.error?.message ?? 'No se pudo categorizar.');
      },
    });
  }
}
