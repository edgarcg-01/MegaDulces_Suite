import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { AndenLinea } from '../anden.state';
import { formatExpiryEcho, parseExpiryShort } from '../../shared/expiry-short';

export interface FechadoConfirmado {
  linea: AndenLinea;
  cantidad: number;
  lote: string;
  caducidadIso: string;
  fotoDataUri: string | null;
}

type Semaforo = 'g' | 'y' | 'r' | 'n';

/**
 * Andén · **Caducidad** — le pone identidad al lote que entró como `NA`.
 *
 * Tres decisiones del rediseño viven acá:
 *  - **El semáforo se pinta MIENTRAS se teclea**, no al apretar un botón. Hoy el
 *    operario declara a ciegas y se entera del 🔴 después de guardar.
 *  - **La caducidad se teclea en 4 dígitos** (`0327` = marzo 2027, último día del
 *    mes; `150327` = 15/03/2027). Sin separadores: se hace con guantes.
 *  - **El OCR corre solo** al tomar la foto. El humano confirma; el OCR propone.
 */
@Component({
  selector: 'app-anden-caducidad',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fx">
      <header class="fx-hd">
        <div>
          <h3 class="fx-nm">{{ nombre() }}</h3>
          <p class="fx-sk">{{ linea().sku || linea().expected_sku || '—' }} · <b>{{ linea().faltaFechar }} pz</b> cotejadas</p>
        </div>
        <button type="button" class="fx-back" (click)="volver.emit()">← Lista</button>
      </header>

      <!-- La política se ve ANTES. Sin GET /policy/resolve sólo se muestra lo que
           se puede derivar honestamente; la cascada NO se duplica acá. Ojo: nada
           de backticks dentro del template literal, cortan la cadena. -->
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

      <label class="fx-foto">
        <span class="fx-foto-btn" [class.fx-busy]="ocrCorriendo()">
          <i class="pi" [class.pi-camera]="!ocrCorriendo()" [class.pi-spin]="ocrCorriendo()"
             [class.pi-spinner]="ocrCorriendo()" aria-hidden="true"></i>
          {{ ocrCorriendo() ? 'Leyendo la etiqueta…' : 'Tomar foto de la caducidad' }}
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
        {{ iso() ? '→ ' + eco() : 'DD/MM/AA · o sólo MM/AA si la etiqueta no trae día' }}
      </p>

      <div class="fx-sem" [class]="'fx-sem--' + semaforo()">
        <span class="fx-dot" aria-hidden="true"></span>{{ textoSemaforo() }}
      </div>

      <button pButton type="button" class="fx-go" [loading]="guardando()"
        [disabled]="!iso() || guardando()" (click)="emitir()">
        {{ iso() ? 'Guardar caducidad' : 'Falta la caducidad' }}
      </button>
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
    .fx-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
  `],
})
export class AndenCaducidadComponent {
  readonly linea = input.required<AndenLinea>();
  readonly minShelfLife = input<number | null>(null);
  readonly existingMinExpiry = input<string | null>(null);
  readonly guardando = input(false);

  readonly confirmar = output<FechadoConfirmado>();
  readonly pedirOcr = output<string>();
  readonly volver = output<void>();

  readonly lote = signal('');
  readonly fechaRaw = signal('');
  readonly fotoDataUri = signal<string | null>(null);
  readonly ocrCorriendo = signal(false);
  readonly ocrConfianza = signal<number | null>(null);

  readonly nombre = computed(() => {
    const l = this.linea();
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  });

  readonly iso = computed(() => parseExpiryShort(this.fechaRaw()));
  readonly eco = computed(() => formatExpiryEcho(this.iso()));
  readonly ecoExistente = computed(() => formatExpiryEcho(this.existingMinExpiry()));

  private readonly dias = computed(() => {
    const i = this.iso();
    return i ? Math.round((new Date(i).getTime() - Date.now()) / 86400000) : null;
  });

  /**
   * Semáforo anticipado. Replica **sólo** lo derivable en cliente: vida útil
   * mínima y comparación contra lo que ya hay en stock. El veredicto que manda
   * sigue siendo el del backend (`computeVerdict`).
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

  setFecha(v: unknown): void {
    this.fechaRaw.set(String(v ?? '').replace(/\D/g, '').slice(0, 8));
  }

  /**
   * Lo que se ve en el campo: los mismos dígitos con las barras puestas. Se
   * guardan sin formato (`fechaRaw`) y se pintan con barras, así el borrado no
   * pelea con la máscara — al borrar cae un dígito, no una barra.
   *
   * `3` → `3` · `30` → `30/` · `3004` → `30/04/` · `300428` → `30/04/28`
   */
  readonly fechaVista = computed(() => {
    const d = this.fechaRaw();
    if (d.length <= 2) return d;
    if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
    return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
  });

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

  /** Al saltar al siguiente renglón el formulario arranca limpio. */
  limpiar(): void {
    this.lote.set('');
    this.fechaRaw.set('');
    this.fotoDataUri.set(null);
    this.ocrConfianza.set(null);
    this.ocrCorriendo.set(false);
  }

  emitir(): void {
    const i = this.iso();
    if (!i) return;
    this.confirmar.emit({
      linea: this.linea(),
      cantidad: this.linea().faltaFechar,
      lote: this.lote().trim() || 'NA',
      caducidadIso: i,
      fotoDataUri: this.fotoDataUri(),
    });
  }
}
