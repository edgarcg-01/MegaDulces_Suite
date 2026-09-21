import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { AndenLinea } from '../anden.state';
import { describirDiferencia } from '../cantidad.util';
import { unidadDelVale } from '../../shared/unidad-vale';
import { formatExpiryEcho, parseExpiryShort, maskExpiryMx } from '../../shared/expiry-short';

/** Un lote fechado: una caducidad con su cantidad. Un renglón puede tener varios. */
export interface FechadoEntrada {
  cantidad: number;
  lote: string;
  caducidadIso: string;
  fotoDataUri: string | null;
}

export interface FechadoConfirmado {
  linea: AndenLinea;
  /** Todas las fechas capturadas para este renglón, en el orden en que se agregaron. */
  entradas: FechadoEntrada[];
}

type Semaforo = 'g' | 'y' | 'r' | 'n';

/**
 * Andén · **Fechar** — lote, caducidad y cuántas unidades llegaron, en una pantalla.
 *
 * **Un renglón puede traer VARIAS caducidades.** Es lo normal, no la excepción:
 * llegan 6 cajas de un lote y 4 de otro dentro del mismo producto. Por eso las
 * fechas se van **agregando a una lista** y recién al final se guardan todas
 * juntas: mientras están en la lista se pueden quitar sin haber tocado el
 * inventario, que es lo que hace segura la corrección de un dedazo.
 *
 * **Cada fecha lleva su propia foto**, porque cada juego de cajas tiene su propia
 * etiqueta — una sola foto para tres caducidades no es evidencia de nada.
 *
 * **Fechar es contar.** No hay un cotejo aparte: la suma de las cantidades
 * declaradas acá es lo que se recibió, y de ahí sale el faltante que el cierre
 * del vale convierte en reclamo. Un dedazo acá es un reclamo falso, así que la
 * diferencia contra Kepler se dice en voz alta antes de guardar.
 *
 * **La cantidad se dice en la unidad del VALE, no en piezas.** Medido: 68,440 de
 * 93,030 renglones (73.6%) se cuentan en `PAQ`, `KG`, `CJA`… — escribir "pz" le
 * miente al bodeguero que está contando paquetes (ver `unidad-vale.ts`).
 *
 * Tres decisiones del rediseño siguen vivas:
 *  - **El semáforo se pinta MIENTRAS se teclea**, no al apretar un botón. Antes el
 *    operario declaraba a ciegas y se enteraba del 🔴 después de guardar.
 *  - **La caducidad se teclea en 4 dígitos** (`0327` = marzo 2027, último día del
 *    mes; `150327` = 15/03/2027). Sin separadores: se hace con guantes.
 *  - **El OCR corre solo** al tomar la foto. El humano confirma; el OCR propone.
 */
@Component({
  selector: 'app-anden-caducidad',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fx">
      <header class="fx-hd">
        <div>
          <h3 class="fx-nm">{{ nombre() }}</h3>
          <p class="fx-sk">
            {{ linea().sku || linea().expected_sku || '—' }}
            @if (!suelto()) { · Kepler manda <b>{{ +linea().expected_qty | number }} {{ unidad() }}</b> }
          </p>
        </div>
        <button type="button" class="fx-back" (click)="volver.emit()">← Lista</button>
      </header>

      <!-- La política se ve ANTES. Sin GET /policy/resolve sólo se muestra lo que
           se puede derivar honestamente; la cascada NO se duplica acá. Ojo: nada
           de acentos graves dentro del template literal, cortan la cadena. -->
      <p class="fx-pol">
        @if (minShelfLife() != null) {
          Política: mínimo <b>{{ minShelfLife() }} días</b> de vida.
        } @else {
          Sin política publicada para este producto.
        }
        @if (existingMinExpiry()) {
          En stock, este SKU caduca el <b>{{ ecoExistente() }}</b>.
        }
      </p>

      <!-- Lo ya agregado en esta pasada. Todavía NO tocó el inventario: por eso se
           puede quitar sin pedirle permiso a nadie. -->
      @if (entradas().length) {
        <section class="fx-lista" aria-label="Fechas agregadas">
          @for (e of entradas(); track $index) {
            <div class="fx-item">
              <span class="fx-item-f">{{ eco(e.caducidadIso) }}</span>
              <span class="fx-item-l">
                lote {{ e.lote }}@if (e.fotoDataUri) { · <i class="pi pi-camera" aria-label="con foto"></i> }
              </span>
              <span class="fx-item-q">{{ e.cantidad | number }} {{ unidad() }}</span>
              <button type="button" class="fx-item-x" [attr.aria-label]="'Quitar ' + eco(e.caducidadIso)"
                (click)="quitar($index)">✕</button>
            </div>
          }
          <p class="fx-lista-pie">
            <b>{{ declaradoAqui() | number }}</b> de {{ linea().faltaFechar | number }} {{ unidad() }}
            @if (libre() > 0) { · faltan <b>{{ libre() | number }}</b> } @else { · el renglón queda completo }
          </p>
        </section>
      }

      <label class="fx-foto">
        <span class="fx-foto-btn" [class.fx-busy]="ocrCorriendo()">
          <i class="pi" [class.pi-camera]="!ocrCorriendo()" [class.pi-spin]="ocrCorriendo()"
             [class.pi-spinner]="ocrCorriendo()" aria-hidden="true"></i>
          {{ ocrCorriendo() ? 'Leyendo la etiqueta…' : textoFoto() }}
        </span>
        <input type="file" accept="image/*" capture="environment" (change)="onFoto($event)" hidden />
      </label>
      @if (fotoDataUri()) {
        <div class="fx-prev">
          <img [src]="fotoDataUri()!" alt="Etiqueta de lote y caducidad" />
          @if (ocrConfianza() != null) { <span>OCR {{ (ocrConfianza()! * 100).toFixed(0) }}%</span> }
        </div>
      }

      <div class="fx-campos">
        <label class="fx-f fx-lote">
          <span>Lote</span>
          <input pInputText [ngModel]="lote()" (ngModelChange)="lote.set($event)" placeholder="Lote" />
        </label>
        <label class="fx-f">
          <span>Caducidad</span>
          <input pInputText inputmode="numeric" maxlength="10" class="fx-fecha"
            [ngModel]="fechaVista()" (ngModelChange)="setFecha($event)" placeholder="DD/MM/AA" />
        </label>
      </div>
      <p class="fx-eco" [class.fx-mal]="fechaRaw().length > 0 && !iso()">
        @if (iso()) {
          → {{ eco(iso()) }}@if (repetida()) { · ya agregaste esta fecha }
        } @else { DD/MM/AA · o sólo MM/AA si la etiqueta no trae día }
      </p>

      <div class="fx-sem" [class]="'fx-sem--' + semaforo()">
        <span class="fx-dot" aria-hidden="true"></span>{{ textoSemaforo() }}
      </div>

      <!-- La cantidad va DESPUÉS de la fecha a propósito: cuando toda la entrega es
           de una sola caducidad no se toca (viene con lo que manda Kepler), y
           pedirla primero metía un campo entre el operario y lo único que de verdad
           tiene que mirar, la etiqueta. -->
      <div class="fx-cant">
        <label class="fx-f">
          <span>{{ suelto() ? 'Cantidad' : (entradas().length ? 'De esta fecha' : 'De este lote') }}</span>
          <input pInputText inputmode="numeric" class="fx-cant-num"
            [ngModel]="cantidadVista()" (ngModelChange)="setCantidad($event)" />
        </label>
        <div class="fx-cant-lado">
          <button type="button" class="fx-chip" [class.fx-chip-on]="cantidad() === libre()"
            [disabled]="libre() <= 0" (click)="cantidad.set(libre())">
            {{ entradas().length ? 'El resto' : 'Todo' }} · {{ libre() | number }}
          </button>
          <span class="fx-cant-dif" [class.fx-mal]="!suelto() && diferencia() > 0">
            {{ textoCantidad() }}
          </span>
        </div>
      </div>

      <!-- Agregar otra fecha es lo que convierte el renglón en varios lotes. Sólo
           aparece cuando queda resto: ofrecerlo con el renglón ya completo invita a
           declarar de más. -->
      @if (!suelto() && puedeAgregarOtra()) {
        <button pButton type="button" [outlined]="true" class="fx-otra" (click)="agregarOtra()">
          + Otra fecha para este producto
        </button>
      }

      <button pButton type="button" class="fx-go" [loading]="guardando()"
        [disabled]="!puedeGuardar() || guardando()" (click)="emitir()">
        {{ textoGuardar() }}
      </button>

      @if (!suelto() && puedeCerrarCorto()) {
        <button pButton type="button" [text]="true" severity="secondary" class="fx-cerrar"
          [disabled]="guardando()" (click)="cerrarRenglon.emit(linea())">
          Ya no llegó más — cerrar con {{ linea().declarado | number }} {{ unidad() }}
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fx { display: flex; flex-direction: column; gap: var(--sp-3); }
    .fx-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .fx-nm { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); line-height: 1.2; text-wrap: balance; }
    .fx-sk { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .fx-back {
      flex: 0 0 auto; min-height: 36px; padding: 0 var(--sp-2);
      background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      color: var(--text-muted); font: inherit; font-size: var(--fs-xs); cursor: pointer;
    }
    .fx-pol {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .fx-pol b { color: var(--text-main); }
    .fx-lista {
      display: flex; flex-direction: column; gap: 1px;
      background: var(--border-color); border: 1px solid var(--border-color);
      border-radius: var(--r-md); overflow: hidden;
    }
    .fx-item {
      display: grid; grid-template-columns: auto 1fr auto auto; gap: var(--sp-2); align-items: center;
      padding: var(--sp-2) var(--sp-3); background: var(--card-bg); font-size: var(--fs-xs);
    }
    .fx-item-f { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .fx-item-l { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fx-item-q { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .fx-item-x {
      min-width: 32px; min-height: 32px; padding: 0; cursor: pointer; font: inherit;
      background: none; border: 0; color: var(--text-faint); border-radius: var(--r-sm);
    }
    .fx-item-x:hover { color: var(--bad-fg); }
    .fx-lista-pie {
      margin: 0; padding: var(--sp-2) var(--sp-3); background: var(--surface-ground);
      font-size: var(--fs-micro); color: var(--text-muted); font-variant-numeric: tabular-nums;
    }
    .fx-lista-pie b { color: var(--text-main); }
    .fx-foto { display: block; cursor: pointer; }
    .fx-foto-btn {
      display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
      min-height: 46px; border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--text-muted);
      font-size: var(--fs-sm); font-weight: var(--fw-medium);
    }
    .fx-foto-btn:hover { border-color: var(--action); color: var(--action); }
    .fx-busy { color: var(--action); border-color: var(--action); }
    .fx-prev { display: flex; align-items: center; gap: var(--sp-2); }
    .fx-prev img { max-height: 68px; border-radius: var(--r-sm); border: 1px solid var(--border-color); }
    .fx-prev span { font-size: var(--fs-micro); color: var(--text-muted); }
    .fx-campos { display: flex; gap: var(--sp-2); }
    .fx-f { display: flex; flex-direction: column; gap: var(--sp-1); flex: 1; min-width: 0; }
    .fx-lote { flex: 0 0 40%; }
    .fx-f > span { font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .1em;
      text-transform: uppercase; color: var(--text-muted); }
    .fx-f input { min-height: 48px; }
    .fx-fecha { font-size: var(--fs-h3); font-weight: var(--fw-bold); text-align: center;
      letter-spacing: .12em; font-variant-numeric: tabular-nums; }
    .fx-eco { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); text-align: center; min-height: 1.2em; }
    .fx-mal { color: var(--bad-fg); }
    .fx-sem { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-sm); font-size: var(--fs-xs); font-weight: var(--fw-medium); }
    .fx-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
    .fx-sem--g { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .fx-sem--y { background: var(--warn-soft-bg, var(--surface-ground)); color: var(--warn-fg, var(--text-main)); }
    .fx-sem--r { background: var(--bad-soft-bg, var(--surface-ground)); color: var(--bad-fg); }
    .fx-sem--n { background: var(--surface-ground); color: var(--text-faint); }
    .fx-cant { display: flex; gap: var(--sp-2); align-items: flex-end; }
    .fx-cant-num { min-height: 52px; font-size: var(--fs-h2); font-weight: var(--fw-black);
      text-align: center; font-variant-numeric: tabular-nums; }
    .fx-cant-lado { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .fx-chip {
      min-height: 40px; padding: 0 var(--sp-3); cursor: pointer; font: inherit;
      font-size: var(--fs-sm); font-weight: var(--fw-medium); font-variant-numeric: tabular-nums;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-pill);
    }
    .fx-chip-on { border-color: var(--action); color: var(--action); }
    .fx-chip:disabled { opacity: .45; cursor: not-allowed; }
    .fx-cant-dif { font-size: var(--fs-micro); color: var(--text-muted); }
    .fx-otra { width: 100%; min-height: 48px; }
    .fx-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .fx-cerrar { width: 100%; }
  `],
})
export class AndenCaducidadComponent {
  readonly linea = input.required<AndenLinea>();
  readonly minShelfLife = input<number | null>(null);
  readonly existingMinExpiry = input<string | null>(null);
  readonly guardando = input(false);

  readonly confirmar = output<FechadoConfirmado>();
  readonly cerrarRenglon = output<AndenLinea>();
  readonly pedirOcr = output<string>();
  readonly volver = output<void>();

  /** Las fechas ya agregadas en esta pasada. Todavía no tocaron el inventario. */
  readonly entradas = signal<FechadoEntrada[]>([]);

  readonly lote = signal('');
  readonly fechaRaw = signal('');
  readonly cantidad = signal(0);
  readonly fotoDataUri = signal<string | null>(null);
  readonly ocrCorriendo = signal(false);
  readonly ocrConfianza = signal<number | null>(null);

  /** Captura fuera del vale: no hay renglón contra el cual comparar cantidades. */
  readonly suelto = computed(() => !this.linea().id);

  readonly nombre = computed(() => {
    const l = this.linea();
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  });

  /** En qué se cuenta este renglón. NO se asume la pieza: ver `unidad-vale.ts`. */
  readonly unidad = computed(() => unidadDelVale(this.linea().expected_unit));

  /** Lo que falta por fechar del renglón, antes de contar lo agregado acá. */
  readonly restante = computed(() => Math.max(0, this.linea().faltaFechar));
  /** Ya repartido entre las fechas de esta pasada. */
  readonly declaradoAqui = computed(() => this.entradas().reduce((a, e) => a + e.cantidad, 0));
  /** Lo que queda sin fecha: es el default de la cantidad y el tope del chip. */
  readonly libre = computed(() => Math.max(0, this.restante() - this.declaradoAqui()));

  readonly iso = computed(() => parseExpiryShort(this.fechaRaw()));
  readonly ecoExistente = computed(() => formatExpiryEcho(this.existingMinExpiry()));

  readonly cantidadVista = computed(() => (this.cantidad() > 0 ? String(this.cantidad()) : ''));
  /** Contra lo que queda libre, no contra lo que Kepler manda: el renglón se parte. */
  readonly diferencia = computed(() => this.cantidad() - this.libre());

  /** La misma caducidad dos veces en un renglón casi siempre es un dedazo. */
  readonly repetida = computed(() => {
    const i = this.iso();
    return !!i && this.entradas().some((e) => e.caducidadIso === i);
  });

  readonly textoFoto = computed(() =>
    this.entradas().length ? 'Tomar foto de ESTA caducidad' : 'Tomar foto de la caducidad',
  );

  readonly textoCantidad = computed(() => {
    if (this.suelto()) return 'fuera del vale: no hay cantidad esperada';
    if (this.cantidad() === 0) return `capturá cuántas ${this.unidad()} trae esta fecha`;
    const d = this.diferencia();
    if (d === 0) return 'con esto el renglón queda completo';
    if (d < 0) return `${describirDiferencia(d, this.linea().uxc)} — el resto queda pendiente`;
    return `${describirDiferencia(d, this.linea().uxc)} de lo que manda Kepler`;
  });

  /** Sólo tiene sentido agregar otra si ésta es válida y todavía queda resto. */
  readonly puedeAgregarOtra = computed(
    () => !!this.iso() && this.cantidad() > 0 && this.cantidad() < this.libre(),
  );

  /**
   * Se puede guardar con el formulario lleno, o con la lista cargada y el
   * formulario vacío (el operario ya agregó todo y sólo falta mandarlo).
   */
  readonly puedeGuardar = computed(() => {
    const formOk = !!this.iso() && this.cantidad() > 0;
    const formVacio = !this.fechaRaw() && this.cantidad() === 0;
    return formOk || (this.entradas().length > 0 && formVacio);
  });

  readonly textoGuardar = computed(() => {
    const n = this.entradas().length + (this.iso() && this.cantidad() > 0 ? 1 : 0);
    if (!n) return this.entradas().length ? 'Completá o borrá la fecha en curso' : 'Falta la caducidad';
    if (n === 1) {
      if (!this.iso() && !this.entradas().length) return 'Falta la caducidad';
      if (this.iso() && this.cantidad() <= 0) return 'Falta la cantidad';
      return `Guardar ${this.total() | 0} ${this.unidad()}`;
    }
    return `Guardar las ${n} fechas`;
  });

  /** Total que se va a declarar al guardar (lista + lo que esté en el formulario). */
  readonly total = computed(
    () => this.declaradoAqui() + (this.iso() && this.cantidad() > 0 ? this.cantidad() : 0),
  );

  /**
   * "Ya no llegó más" sólo aparece cuando de verdad hay un corto: algo ya
   * declarado en el servidor y resto sin cubrir ni siquiera por la pasada actual.
   */
  readonly puedeCerrarCorto = computed(
    () => this.linea().declarado > 0 && this.libre() > 0 && !this.entradas().length,
  );

  private readonly dias = computed(() => {
    const i = this.iso();
    return i ? Math.round((new Date(i).getTime() - Date.now()) / 86400000) : null;
  });

  /**
   * Semáforo anticipado. Replica **sólo** lo derivable en cliente: vida útil
   * mínima y comparación contra lo que ya hay en stock. El veredicto que manda
   * sigue siendo el del backend (`computeVerdict`), y se resuelve **por fecha**:
   * en un renglón con dos caducidades una puede entrar verde y la otra quedar
   * retenida.
   */
  readonly semaforo = computed<Semaforo>(() => {
    const d = this.dias();
    if (d === null) return 'n';
    const min = this.minShelfLife();
    const ex = this.existingMinExpiry();
    if (min != null && d < min) return 'r';
    if (ex && this.iso()! < ex) return 'r';
    if (min != null && d < min + 60) return 'y';
    return 'g';
  });

  readonly textoSemaforo = computed(() => {
    const d = this.dias();
    if (d === null) return 'Capturá la caducidad para ver el veredicto';
    const min = this.minShelfLife();
    const s = this.semaforo();
    if (s === 'r') {
      const ex = this.existingMinExpiry();
      if (ex && this.iso()! < ex) return `${d} días · más viejo que lo que ya hay en stock — quedará retenido`;
      return `${d} días de vida · bajo el mínimo de ${min} — quedará retenido`;
    }
    if (s === 'y') return `${d} días de vida · cumple, pero justo. Entra con reserva`;
    return `${d} días de vida · buen plazo, entra directo`;
  });

  constructor() {
    // **El effect reacciona AL RENGLÓN, no a la cantidad libre.**
    //
    // Depender de `libre()` parecía más corto y estaba mal: `libre()` cambia al
    // agregar una fecha a la lista, así que el effect quedaba encolado y pisaba
    // la cantidad que el operario tecleaba justo después — se guardaba el resto
    // entero en vez de las 25 que capturó. Lo destapó un candado; en el navegador
    // el orden suele salvarlo, y por eso es la clase de defecto que llega a
    // producción. La cantidad se repone donde cambia de verdad: al abrir un
    // renglón (acá) y al agregar o quitar una fecha (en sus métodos).
    effect(() => {
      const l = this.linea();
      this.entradas.set([]);
      this.limpiarFormulario();
      this.cantidad.set(Math.max(0, l.faltaFechar));
    });
  }

  eco(iso: string | null): string { return formatExpiryEcho(iso); }

  setFecha(v: unknown): void {
    this.fechaRaw.set(String(v ?? '').replace(/\D/g, '').slice(0, 8));
  }

  setCantidad(v: unknown): void {
    const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
    this.cantidad.set(Number.isFinite(n) && n > 0 ? n : 0);
  }

  /**
   * Lo que se ve en el campo: los mismos dígitos con las barras puestas. Se
   * guardan sin formato (`fechaRaw`) y se pintan con barras, así el borrado no
   * pelea con la máscara — al borrar cae un dígito, no una barra.
   *
   * `3` → `3` · `30` → `30` · `3004` → `30/04` · `300428` → `30/04/28`
   *
   * La máscara vive en `expiry-short.ts` (`maskExpiryMx`): la misma que usa la
   * captura de caducidades de tienda. Estaba duplicada acá adentro.
   */
  readonly fechaVista = computed(() => maskExpiryMx(this.fechaRaw()));

  onFoto(ev: Event): void {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    this.ocrConfianza.set(null);
    this.ocrCorriendo.set(true);
    this.comprimir(f).then((uri) => {
      this.fotoDataUri.set(uri);
      this.pedirOcr.emit(uri);
    });
  }

  /**
   * **Reduce la foto ANTES de mandarla.** La cámara de un celular tira 3–8 MB, y
   * en base64 eso crece ~33 %: contra el límite de 2 MB del backend el guardado
   * moría con `413 request entity too large` — o sea que fechar con foto **no
   * funcionaba**. Además, subir 6 MB por el wifi de la bodega es lento.
   *
   * 1600 px de lado largo alcanzan de sobra para que el OCR lea una etiqueta; el
   * resultado queda en ~200–400 KB. Si algo del canvas falla se manda el
   * original: peor es quedarse sin evidencia.
   */
  private comprimir(f: File): Promise<string> {
    return new Promise((resolve) => {
      const crudo = new FileReader();
      crudo.onload = () => {
        const uri = String(crudo.result);
        const img = new Image();
        img.onload = () => {
          try {
            const MAX = 1600;
            const esc = Math.min(1, MAX / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * esc);
            c.height = Math.round(img.height * esc);
            const ctx = c.getContext('2d');
            if (!ctx) return resolve(uri);
            ctx.drawImage(img, 0, 0, c.width, c.height);
            const chico = c.toDataURL('image/jpeg', 0.8);
            resolve(chico.length < uri.length ? chico : uri);
          } catch {
            resolve(uri);
          }
        };
        img.onerror = () => resolve(uri);
        img.src = uri;
      };
      crudo.readAsDataURL(f);
    });
  }

  /** Lo llama el padre con lo que devolvió el OCR: propone, no decide. */
  aplicarOcr(res: { lot_code: string | null; expiry_date: string | null; confidence: number | null }): void {
    this.ocrCorriendo.set(false);
    this.ocrConfianza.set(res.confidence);
    if (res.lot_code && !this.lote()) this.lote.set(res.lot_code);
    if (res.expiry_date && !this.fechaRaw()) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(res.expiry_date);
      if (m) this.fechaRaw.set(`${m[3]}${m[2]}${m[1].slice(2)}`);
    }
  }

  ocrFallo(): void { this.ocrCorriendo.set(false); }

  /** Al saltar al siguiente renglón el panel arranca limpio, lista incluida. */
  limpiar(): void {
    this.entradas.set([]);
    this.limpiarFormulario();
    this.cantidad.set(this.libre());
  }

  private limpiarFormulario(): void {
    this.lote.set('');
    this.fechaRaw.set('');
    this.fotoDataUri.set(null);
    this.ocrConfianza.set(null);
    this.ocrCorriendo.set(false);
  }

  /** Precarga lote y fecha de una captura anterior (el fechado en bloque). */
  precargar(lote: string, digitosFecha: string): void {
    if (lote) this.lote.set(lote);
    if (digitosFecha) this.fechaRaw.set(digitosFecha);
  }

  /** Manda la fecha en curso a la lista y deja el formulario listo para la siguiente. */
  agregarOtra(): void {
    const e = this.actualComoEntrada();
    if (!e) return;
    this.entradas.update((es) => [...es, e]);
    this.limpiarFormulario();
    // Se repone ACÁ, no en un effect: un effect encolado le pisa al operario la
    // cantidad que teclea a continuación (ver la nota del constructor).
    this.cantidad.set(this.libre());
  }

  quitar(i: number): void {
    this.entradas.update((es) => es.filter((_, j) => j !== i));
    this.cantidad.set(this.libre());
  }

  private actualComoEntrada(): FechadoEntrada | null {
    const i = this.iso();
    const c = this.cantidad();
    if (!i || c <= 0) return null;
    return { cantidad: c, lote: this.lote().trim() || 'NA', caducidadIso: i, fotoDataUri: this.fotoDataUri() };
  }

  emitir(): void {
    const enCurso = this.actualComoEntrada();
    const todas = enCurso ? [...this.entradas(), enCurso] : this.entradas();
    if (!todas.length) return;
    this.confirmar.emit({ linea: this.linea(), entradas: todas });
  }
}
