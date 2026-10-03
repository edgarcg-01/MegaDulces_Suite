import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  FaltantesService,
  type ConsultaFaltante,
  type ReportarResultado,
} from '../faltantes.service';
import { VerificadorService } from '../verificador.service';
import {
  MOTIVO_AUTOMATICO,
  anotaSolo,
  pasoDeReloj,
  porcentajeReloj,
  type VeredictoExistencia,
} from '../faltante-express';

/** Lo que devuelve el catálogo local, y lo que se pinta en cada renglón del desplegable. */
type Hallado = { codigo: string; nombre: string; precio: number | null; unidad: string | null };

type Aviso = { tono: 'warn' | 'bad'; texto: string } | null;

/** De dónde salió el precio que se está mostrando. Un precio sin procedencia no se puede defender. */
type OrigenPrecio = 'vivo' | 'respaldo' | 'sin_dato';

const PASO_MS = 100;

@Component({
  selector: 'app-faltante-express',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fx">
      <!-- ── La caja. Es lo único que hay cuando no pasa nada. ──────────────────────────── -->
      <label class="fx-lbl" for="fx-q">¿Qué te pidieron?</label>
      <div class="fx-wrap">
        <i class="pi pi-search fx-ico" aria-hidden="true"></i>
        <input #caja id="fx-q" type="search" class="fx-input" autocomplete="off" spellcheck="false"
               [ngModel]="termino()" (ngModelChange)="alEscribir($event)"
               (keydown)="alTeclear($event)"
               [disabled]="!sucursal()"
               [placeholder]="sucursal() ? 'Escanea, o escribe la clave o el nombre' : 'Elige la sucursal para poder buscar'"
               [attr.aria-describedby]="sucursal() ? 'fx-ayuda' : null" />
        @if (buscando()) { <i class="pi pi-spin pi-spinner fx-spin" aria-hidden="true"></i> }

        <!-- Desplegable: nombre, clave, unidad y PRECIO. El precio en el renglón es lo que
             convierte esta caja en el verificador, sin mandar a nadie a otra pantalla. -->
        @if (listaAbierta()) {
          <ul class="fx-lista" role="listbox" aria-label="Productos encontrados">
            @for (r of resultados(); track r.codigo; let i = $index) {
              <li>
                <button type="button" class="fx-fila" role="option"
                        [attr.aria-selected]="i === resaltado()"
                        [class.on]="i === resaltado()"
                        (mouseenter)="resaltado.set(i)"
                        (click)="elegir(r)">
                  <span class="fx-fila-n">{{ r.nombre }}</span>
                  <span class="fx-fila-sku">{{ r.codigo }}</span>
                  @if (r.unidad) { <span class="fx-fila-u">{{ r.unidad }}</span> }
                  <span class="fx-fila-p num">
                    @if (r.precio !== null) {
                      {{ r.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                    } @else { <em class="fx-muted">sin precio</em> }
                  </span>
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <!-- Sin sucursal la caja está deshabilitada, y eso TIENE que decirse. Deshabilitada y muda
           se lee como "está roto": la persona teclea, no pasa nada, y no hay forma de saber que
           el problema está en un campo de más arriba. En la pantalla de faltantes no aparece
           porque ahí la tarjeta ni se dibuja hasta elegir sucursal; acá convive con el arqueo,
           que se abre con la sucursal todavía en blanco cuando alguien alcanza más de una. -->
      @if (!sucursal()) {
        <p class="fx-sin-suc" role="status">
          <i class="pi pi-arrow-up" aria-hidden="true"></i>
          <span>Elige primero la <strong>sucursal</strong> de arriba. El mismo código tiene precio
            y existencia distintos en cada plaza, así que sin ella no hay nada que contestar.</span>
        </p>
      } @else {
        <p id="fx-ayuda" class="fx-ayuda">
          La ventana se cierra sola en {{ segundosVentana }} s. Si no hay existencia, el faltante
          queda anotado sin preguntar nada.
        </p>
      }

      @if (aviso(); as a) {
        <div class="fx-aviso" [class]="'t-' + a.tono" role="status">{{ a.texto }}</div>
      }

      <!-- ── La ventana con tiempo ──────────────────────────────────────────────────────── -->
      @if (ventana()) {
        <section class="fx-ventana" role="status" aria-live="polite"
                 (mouseenter)="pausar(true)" (mouseleave)="pausar(false)"
                 (focusin)="pausar(true)" (focusout)="pausar(false)">
          <div class="fx-v-cuerpo">
            <div class="fx-v-izq">
              <div class="fx-v-nom">
                <strong>{{ elegido()?.nombre }}</strong>
                <span class="fx-v-sku">{{ elegido()?.codigo }}</span>
              </div>
              <div class="fx-v-precio num">
                @if (precioValor() !== null) {
                  {{ precioValor() | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                } @else { <span class="fx-sin">sin precio</span> }
                @if (elegido()?.unidad) { <span class="fx-v-un">por {{ elegido()?.unidad }}</span> }
              </div>
              <div class="fx-v-origen">
                @switch (origenPrecio()) {
                  @case ('vivo') { <span class="fx-chip ok"><i class="pi pi-circle-fill" aria-hidden="true"></i> Precio en vivo</span> }
                  @case ('respaldo') { <span class="fx-chip warn">De respaldo — puede haber cambiado</span> }
                  @default { <span class="fx-chip warn">No se pudo leer el precio</span> }
                }
              </div>
            </div>

            <div class="fx-v-der">
              <!-- El veredicto. Tres respuestas, no dos: "no se pudo leer" NUNCA se dibuja
                   como cero, porque mandan a hacer cosas opuestas. -->
              @if (!consulta()) {
                <div class="fx-ver v-cargando">
                  <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
                  <div><strong>Consultando existencia…</strong></div>
                </div>
              } @else {
                <div class="fx-ver" [class]="'v-' + (veredicto() ?? 'no_medido')">
                  @switch (veredicto()) {
                    @case ('hay_en_tienda') {
                      <i class="pi pi-check-circle" aria-hidden="true"></i>
                      <div>
                        <strong>Hay {{ consulta()?.existencia }}</strong>
                        <span>Está en la tienda.</span>
                      </div>
                    }
                    @case ('sin_existencia') {
                      <i class="pi pi-times-circle" aria-hidden="true"></i>
                      <div>
                        <strong>No hay — existencia 0</strong>
                        <span>La venta ya se perdió.</span>
                      </div>
                    }
                    @default {
                      <i class="pi pi-question-circle" aria-hidden="true"></i>
                      <div>
                        <strong>Existencia sin medir</strong>
                        <span>No se pudo leer. No es cero.</span>
                      </div>
                    }
                  }
                </div>
              }

              <!-- Lo que pasó solo, y cómo salirse. -->
              @if (anotado(); as a) {
                @if (!deshecho()) {
                  <div class="fx-anot">
                    <i class="pi pi-flag-fill" aria-hidden="true"></i>
                    <div class="fx-anot-t">
                      <strong>Anotado en faltantes</strong>
                      <span>
                        {{ a.times_reported }} {{ a.times_reported === 1 ? 'vez' : 'veces' }} esta semana
                        @if (a.est_lost_revenue !== null) {
                          · {{ a.est_lost_revenue | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                        }
                      </span>
                    </div>
                    <button type="button" class="fx-quitar" (click)="deshacer()" [disabled]="deshaciendo()">
                      {{ deshaciendo() ? 'Quitando…' : 'Quitar' }}
                    </button>
                  </div>
                } @else {
                  <div class="fx-nada">
                    <i class="pi pi-replay" aria-hidden="true"></i>
                    <span>Quitado. No se anotó nada.</span>
                  </div>
                }
              }

              <!-- El único botón de la ventana, y sólo en el caso que no se anota solo. -->
              @if (ofreceAnotarIgual()) {
                <div class="fx-nada">
                  <span>No se anotó nada: cero y «no se pudo leer» no son lo mismo.</span>
                  <button type="button" class="fx-igual" (click)="anotarIgual()" [disabled]="enviando()">
                    {{ enviando() ? 'Anotando…' : 'Anotar igual' }}
                  </button>
                </div>
              }
            </div>
          </div>

          <div class="fx-reloj">
            <div class="fx-barra" [class]="'b-' + (veredicto() ?? 'no_medido')">
              <span [style.width.%]="porcentaje()"></span>
            </div>
            <span class="fx-seg">{{ pausado() ? 'en pausa' : 'se cierra en ' + segundos() + ' s' }}</span>
            <button type="button" class="fx-cerrar" (click)="cerrar()" aria-label="Cerrar ahora">
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    /* Operations (DESIGN §O). Todo por token: dark funciona solo. */
    .fx { display: flex; flex-direction: column; gap: .5rem; }
    .fx-lbl { font-size: var(--fs-sm, .82rem); font-weight: 700; color: var(--text-main); }
    .fx-wrap { position: relative; display: flex; align-items: center; }
    .fx-ico { position: absolute; left: .7rem; color: var(--text-muted); font-size: .85rem; pointer-events: none; }
    .fx-spin { position: absolute; right: .7rem; color: var(--text-muted); font-size: .85rem; }
    .fx-input { width: 100%; min-height: var(--tap-min, 44px); padding: 0 .75rem 0 2.1rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      background: var(--card-bg); color: var(--text-main); font: inherit; font-size: .95rem; }
    .fx-input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .fx-ayuda { margin: 0; font-size: .72rem; color: var(--text-muted); }
    /* El aviso de "falta la sucursal" NO es un error: es una instruccion. Por eso usa el tono de
       aviso y no el rojo -- nadie se equivoco todavia, falta un paso. */
    .fx-sin-suc { margin: 0; display: flex; align-items: flex-start; gap: .4rem;
      font-size: .74rem; line-height: 1.35; padding: .45rem .6rem;
      border-radius: var(--r-sm, 8px); background: var(--warn-soft-bg);
      color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .fx-sin-suc i { font-size: .8rem; margin-top: .1rem; flex: 0 0 auto; }

    .fx-lista { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 50;
      list-style: none; margin: 0; padding: 0; max-height: 17rem; overflow-y: auto;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-sm, 8px); box-shadow: var(--shadow-float); }
    .fx-lista li + li .fx-fila { border-top: 1px solid var(--border-color); }
    .fx-fila { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto auto 5.5rem;
      align-items: center; gap: .6rem; padding: .55rem .75rem; background: none; border: 0;
      cursor: pointer; text-align: left; color: var(--text-main); font: inherit; font-size: .8125rem; }
    .fx-fila:hover, .fx-fila.on { background: var(--hover-bg); }
    .fx-fila-n { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fx-fila-sku { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--text-muted); }
    .fx-fila-u { font-size: .68rem; font-weight: 700; color: var(--text-muted);
      background: var(--neutral-100); border-radius: 4px; padding: .05rem .3rem; }
    .fx-fila-p { text-align: right; font-weight: 700; }
    .fx-muted, .fx-sin { color: var(--text-muted); font-style: italic; font-weight: 400; }
    .num { font-variant-numeric: tabular-nums; }

    .fx-aviso { font-size: .78rem; padding: .5rem .7rem; border-radius: var(--r-sm, 8px); }
    .fx-aviso.t-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .fx-aviso.t-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }

    /* ── La ventana ──────────────────────────────────────────────────────────────────── */
    .fx-ventana { margin-top: .3rem; border: 1px solid var(--border-color);
      border-radius: var(--r-md, 12px); background: var(--card-bg); box-shadow: var(--shadow-float);
      overflow: hidden; }
    .fx-v-cuerpo { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
      gap: .8rem 1.2rem; padding: .85rem 1rem .7rem; }
    .fx-v-izq { min-width: 0; }
    .fx-v-nom { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
    .fx-v-nom strong { font-size: .95rem; }
    .fx-v-sku { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--text-muted);
      background: var(--neutral-100); border-radius: 4px; padding: .05rem .35rem; }
    .fx-v-precio { font-size: 2rem; font-weight: 800; letter-spacing: -.02em; line-height: 1.1; margin-top: .4rem;
      display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
    .fx-v-un { font-size: .82rem; font-weight: 500; color: var(--text-muted); letter-spacing: 0; }
    .fx-v-origen { margin-top: .35rem; }
    .fx-chip { display: inline-flex; align-items: center; gap: .3rem; font-size: .7rem; font-weight: 600;
      border-radius: var(--r-sm, 8px); padding: .1rem .4rem; }
    .fx-chip i { font-size: .45rem; }
    .fx-chip.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border: 1px solid var(--ok-border); }
    .fx-chip.warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border: 1px solid var(--warn-border); }

    .fx-v-der { display: flex; flex-direction: column; gap: .45rem; min-width: 0; }
    .fx-ver { display: flex; align-items: flex-start; gap: .55rem; padding: .55rem .7rem;
      border-radius: var(--r-sm, 8px); }
    .fx-ver i { margin-top: .1rem; }
    .fx-ver div { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
    .fx-ver strong { font-size: .88rem; }
    .fx-ver span { font-size: .75rem; }
    .fx-ver.v-hay_en_tienda { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border: 1px solid var(--ok-border); }
    .fx-ver.v-sin_existencia { background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border); }
    .fx-ver.v-no_medido { background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .fx-ver.v-cargando { background: var(--neutral-100); color: var(--text-muted); border: 1px solid var(--border-color); }

    .fx-anot { display: flex; align-items: center; gap: .55rem; padding: .5rem .7rem;
      border-radius: var(--r-sm, 8px); background: color-mix(in srgb, var(--action) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--action) 35%, transparent); color: var(--brand-900); }
    .fx-anot-t { display: flex; flex-direction: column; gap: .1rem; min-width: 0; flex: 1 1 auto; }
    .fx-anot-t strong { font-size: .8rem; }
    .fx-anot-t span { font-size: .72rem; }
    .fx-quitar { flex: 0 0 auto; background: none; border: 0; font: inherit; font-size: .74rem;
      font-weight: 700; color: var(--brand-900); text-decoration: underline; cursor: pointer;
      min-height: var(--tap-min, 44px); padding: 0 .4rem; }
    .fx-nada { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; padding: .5rem .7rem;
      border-radius: var(--r-sm, 8px); background: var(--neutral-100); border: 1px solid var(--border-color);
      font-size: .74rem; color: var(--text-muted); }
    .fx-nada span { flex: 1 1 8rem; }
    .fx-igual { flex: 0 0 auto; min-height: var(--tap-min, 44px); padding: 0 .7rem;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      font: inherit; font-size: .76rem; font-weight: 700; color: var(--text-main); cursor: pointer; }
    .fx-igual:hover { border-color: var(--text-faint); }

    .fx-reloj { display: flex; align-items: center; gap: .6rem; padding: 0 1rem .7rem; }
    .fx-barra { flex: 1 1 auto; height: 4px; border-radius: 999px; background: var(--neutral-200); overflow: hidden; }
    .fx-barra span { display: block; height: 100%; border-radius: 999px; background: var(--text-faint);
      transition: width 100ms linear; }
    .fx-barra.b-hay_en_tienda span { background: var(--ok-fg); }
    .fx-barra.b-sin_existencia span { background: var(--bad-fg); }
    .fx-barra.b-no_medido span { background: var(--warn-fg); }
    .fx-seg { flex: 0 0 auto; font-size: .72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .fx-cerrar { flex: 0 0 auto; background: none; border: 0; color: var(--text-muted); cursor: pointer;
      width: var(--tap-min, 44px); height: 2rem; display: inline-flex; align-items: center; justify-content: center; }

    @media (prefers-reduced-motion: reduce) {
      .fx-barra span { transition: none; }
    }
  `],
})
export class FaltanteExpressComponent {
  private readonly api = inject(FaltantesService);
  private readonly verificador = inject(VerificadorService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal sobre la que se consulta y se anota. Explícita SIEMPRE: el kiosco no tiene sesión. */
  readonly sucursal = input.required<string | null>();

  /**
   * `[FLT.16]` El código con el que llega quien viene del verificador. Se resuelve una sola vez,
   * para que la persona no lo vuelva a teclear con el cliente enfrente.
   */
  readonly codigoInicial = input<string | null>(null);

  /** Se emite cuando algo se escribió o se deshizo, para que la pantalla recargue su lista. */
  readonly cambio = output<void>();

  /** Ya se resolvió el código de entrada. Sin esto, cada repintado volvería a abrir la ventana. */
  private entradaResuelta = false;

  private readonly caja = viewChild<ElementRef<HTMLInputElement>>('caja');

  /** Cuánto dura la ventana. Declarado acá y no suelto en el template para que se lea una vez. */
  readonly segundosVentana = 9;
  private get totalMs(): number { return this.segundosVentana * 1000; }

  readonly termino = signal('');
  readonly resultados = signal<Hallado[]>([]);
  readonly resaltado = signal(0);
  readonly buscando = signal(false);
  readonly aviso = signal<Aviso>(null);

  readonly elegido = signal<Hallado | null>(null);
  readonly consulta = signal<ConsultaFaltante | null>(null);
  readonly anotado = signal<ReportarResultado | null>(null);
  readonly deshecho = signal(false);
  readonly enviando = signal(false);
  readonly deshaciendo = signal(false);

  readonly ventana = signal(false);
  readonly restante = signal(0);
  readonly pausado = signal(false);

  private debounce?: ReturnType<typeof setTimeout>;
  private reloj?: ReturnType<typeof setInterval>;

  constructor() {
    // El intervalo sobrevive al componente si nadie lo apaga, y entonces sigue llamando a
    // setState sobre algo que ya no está en el árbol.
    this.destroyRef.onDestroy(() => {
      if (this.debounce) clearTimeout(this.debounce);
      this.pararReloj();
    });

    // El código del verificador llega DESPUÉS que la sucursal (la resuelve una suscripción al
    // alcance), así que no sirve hacerlo en ngOnInit: hay que esperar a que estén los dos.
    effect(() => {
      const code = this.codigoInicial();
      const suc = this.sucursal();
      if (!code || !suc || this.entradaResuelta) return;
      this.entradaResuelta = true;
      this.porCodigo(code);
    });
  }

  readonly listaAbierta = computed(() => !this.ventana() && this.resultados().length > 0);
  readonly veredicto = computed<VeredictoExistencia>(() => this.consulta()?.veredicto);
  readonly porcentaje = computed(() => porcentajeReloj(this.restante(), this.totalMs));
  readonly segundos = computed(() => Math.ceil(this.restante() / 1000));

  /**
   * El precio y su procedencia. El del servidor manda; el local es respaldo y se DECLARA como
   * tal, porque puede estar viejo. Sin ninguno de los dos no se dibuja un cero.
   */
  readonly precioValor = computed<number | null>(() => {
    const srv = this.consulta()?.precio;
    if (srv !== null && srv !== undefined) return srv;
    return this.elegido()?.precio ?? null;
  });
  readonly origenPrecio = computed<OrigenPrecio>(() => {
    const srv = this.consulta()?.precio;
    if (srv !== null && srv !== undefined) return 'vivo';
    return (this.elegido()?.precio ?? null) !== null ? 'respaldo' : 'sin_dato';
  });

  /**
   * El botón de «Anotar igual» sale SÓLO cuando la existencia no se pudo leer. Es el único caso
   * de los tres que no se resuelve solo, y por eso es el único que tiene botón.
   */
  readonly ofreceAnotarIgual = computed(
    () => !!this.consulta() && this.veredicto() === 'no_medido' && !this.anotado(),
  );

  // ── Búsqueda ────────────────────────────────────────────────────────────────────────────────

  /**
   * El criterio es «tiene letras»: un código de barras y una clave son dígitos, un nombre no.
   * La pistola dispara y manda Enter, así que ese camino no pasa por acá — lo resuelve
   * `alTeclear`. Con menos de 3 caracteres no se busca o entra el catálogo entero.
   */
  alEscribir(v: string): void {
    this.termino.set(v ?? '');
    this.aviso.set(null);
    if (this.debounce) clearTimeout(this.debounce);
    const q = (v ?? '').trim();
    if (q.length < 3 || !/[a-zá-úñ]/i.test(q)) { this.resultados.set([]); return; }
    this.debounce = setTimeout(() => { void this.porNombre(q); }, 250);
  }

  alTeclear(ev: KeyboardEvent): void {
    const n = this.resultados().length;
    if (ev.key === 'ArrowDown' && n) {
      ev.preventDefault(); this.resaltado.set((this.resaltado() + 1) % n);
    } else if (ev.key === 'ArrowUp' && n) {
      ev.preventDefault(); this.resaltado.set((this.resaltado() - 1 + n) % n);
    } else if (ev.key === 'Escape') {
      this.resultados.set([]);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const r = this.resultados()[this.resaltado()];
      if (r) { this.elegir(r); return; }
      // Sin desplegable: lo que hay en la caja es un código. Es el camino de la pistola.
      this.porCodigo(this.termino().trim());
    }
  }

  private async porNombre(q: string): Promise<void> {
    const suc = this.sucursal();
    if (!suc) return;
    this.buscando.set(true);
    try {
      let r = await this.verificador.buscarPorNombre(suc, q);
      if (r === null) {
        // `null` = no hay catálogo bajado, que NO es lo mismo que «no hay resultados». Se baja
        // una vez y se reintenta; si tampoco, se dice.
        await new Promise<void>((ok, fail) =>
          this.verificador.descargarSnapshot(suc).subscribe({ next: () => ok(), error: fail }));
        r = await this.verificador.buscarPorNombre(suc, q);
      }
      this.resultados.set(r ?? []);
      this.resaltado.set(0);
      if (r !== null && r.length === 0) {
        this.aviso.set({ tono: 'warn', texto: 'Nada coincide. Si no lo vendemos, usa "Producto no catalogado".' });
      }
    } catch {
      this.resultados.set([]);
      this.aviso.set({ tono: 'bad', texto: 'No se pudo buscar por nombre. Revisa la conexión.' });
    } finally {
      this.buscando.set(false);
    }
  }

  private porCodigo(code: string): void {
    const suc = this.sucursal();
    if (!code || !suc) return;
    this.buscando.set(true);
    this.verificador.buscar(code, suc).subscribe({
      next: (r) => {
        this.buscando.set(false);
        if (r.estado === 'encontrado') {
          const base = r.producto.unidades?.[0];
          this.elegir({
            codigo: r.producto.codigo,
            nombre: r.producto.nombre,
            precio: base?.precio_con_iva ?? null,
            unidad: base?.u ?? null,
          });
        } else if (r.estado === 'no_encontrado') {
          // El catálogo contestó que no existe: es autoritativo, y NO se anota nada solo. Un
          // producto fuera de catálogo es otro motivo, con su propia pantalla.
          this.aviso.set({
            tono: 'warn',
            texto: 'Ese código no está en el catálogo. Usa "Producto no catalogado" para avisarle a Compras.',
          });
        } else {
          this.aviso.set({ tono: 'bad', texto: 'No se pudo consultar el catálogo. Revisa la conexión.' });
        }
      },
      error: () => {
        this.buscando.set(false);
        this.aviso.set({ tono: 'bad', texto: 'No se pudo consultar. Revisa la conexión.' });
      },
    });
  }

  // ── La ventana ──────────────────────────────────────────────────────────────────────────────

  elegir(h: Hallado): void {
    const suc = this.sucursal();
    if (!suc) return;

    this.elegido.set(h);
    this.resultados.set([]);
    this.termino.set('');
    this.aviso.set(null);
    this.consulta.set(null);
    this.anotado.set(null);
    this.deshecho.set(false);
    this.ventana.set(true);
    // El reloj NO arranca todavía: mientras la existencia viaja, la ventana no puede cerrarse o
    // se cerraría antes de contestar la única pregunta que la justifica.
    this.pararReloj();
    this.restante.set(this.totalMs);
    this.pausado.set(false);

    this.api.consultar(suc, h.codigo).subscribe({
      next: (c) => { this.consulta.set(c); this.trasConsultar(c); },
      error: () => {
        const c: ConsultaFaltante = {
          encontrado: true, termino: h.codigo, warehouse_code: suc, warehouse_name: null,
          existencia: null, veredicto: 'no_medido',
        };
        this.consulta.set(c);
        this.trasConsultar(c);
      },
    });
  }

  /** Llegó la respuesta: se decide si se anota solo, y recién ahí empieza a correr el reloj. */
  private trasConsultar(c: ConsultaFaltante): void {
    if (anotaSolo(c.veredicto)) this.anotar();
    this.arrancarReloj();
  }

  private anotar(): void {
    const suc = this.sucursal();
    const h = this.elegido();
    if (!suc || !h || this.enviando()) return;
    this.enviando.set(true);
    this.api.reportar({
      warehouse_code: suc,
      kind: MOTIVO_AUTOMATICO,
      sku: h.codigo,
      source: 'verificador',
    }).subscribe({
      next: (r) => {
        this.enviando.set(false);
        this.anotado.set(r);
        this.cambio.emit();
      },
      error: () => {
        this.enviando.set(false);
        // Falló la escritura: se DICE. Un faltante que se creyó anotado y no lo está es peor que
        // uno que nunca se intentó, porque nadie lo vuelve a reportar.
        this.aviso.set({ tono: 'bad', texto: 'No se pudo anotar el faltante. Revisa la conexión y vuelve a escanear.' });
      },
    });
  }

  /** El único botón del caso `no_medido`: lo anota una persona, no la pantalla. */
  anotarIgual(): void {
    this.anotar();
    this.restante.set(this.totalMs);   // le devuelve tiempo para ver qué quedó
  }

  deshacer(): void {
    const a = this.anotado();
    if (!a || this.deshaciendo()) return;
    this.deshaciendo.set(true);
    this.api.deshacer(a.id).subscribe({
      next: () => {
        this.deshaciendo.set(false);
        this.deshecho.set(true);
        this.restante.set(this.totalMs);
        this.cambio.emit();
      },
      error: () => {
        this.deshaciendo.set(false);
        this.aviso.set({ tono: 'bad', texto: 'No se pudo quitar. Pedile a Compras que lo marque como "no era faltante".' });
      },
    });
  }

  pausar(v: boolean): void { this.pausado.set(v); }

  cerrar(): void {
    this.pararReloj();
    this.ventana.set(false);
    this.elegido.set(null);
    this.consulta.set(null);
    this.anotado.set(null);
    this.deshecho.set(false);
    // De vuelta a la caja: en un mostrador lo que sigue es el próximo escaneo.
    this.caja()?.nativeElement.focus();
  }

  private arrancarReloj(): void {
    this.pararReloj();
    this.reloj = setInterval(() => {
      const r = pasoDeReloj(this.restante(), this.pausado(), PASO_MS);
      this.restante.set(r);
      if (r <= 0) this.cerrar();
    }, PASO_MS);
  }

  private pararReloj(): void {
    if (this.reloj) { clearInterval(this.reloj); this.reloj = undefined; }
  }
}
