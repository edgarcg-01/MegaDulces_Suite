import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { AndenLinea } from '../anden.state';
import { PickSuggestion } from '../../bin-location.service';
import { formatExpiryEcho, parseExpiryShort } from '../../shared/expiry-short';

export interface RenglonConfirmado {
  linea: AndenLinea;
  cantidad: number;
  lote: string;
  caducidadIso: string | null;
  binId: string | null;
  binCode: string | null;
  fotoDataUri: string | null;
}

type Semaforo = 'green' | 'yellow' | 'red' | null;

/**
 * Andén · **Puerta 2 — Fechado y acomodo**. Corre contra el anaquel.
 *
 * Sin prisa y con la caja en la mano: foto, lote, caducidad, rack. Un solo botón
 * escribe las dos cosas, así que **fechar y ubicar dejan de poder saltarse por
 * separado**: o se hacen juntas o el vale sigue reclamándolas.
 *
 * Tres decisiones que vienen del rediseño:
 *  - **El semáforo se pinta MIENTRAS se teclea**, no al apretar un botón. Hoy el
 *    operario declara a ciegas y se entera del 🔴 después.
 *  - **La caducidad se teclea en 4 dígitos** (`0327` = marzo 2027, último día del
 *    mes; `150327` = 15/03/2027). Sin separadores: se hace con guantes.
 *  - **El rack viene precargado** desde `pick-suggestion`. Sólo se escanea cuando
 *    cambia.
 */
@Component({
  selector: 'app-anden-renglon',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ButtonModule, InputTextModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rg">
      <header class="rg-head">
        <h3 class="rg-nombre">{{ nombre() }}</h3>
        <span class="rg-falta">{{ linea().faltaFechar | number }} piezas por fechar</span>
      </header>

      <!-- Principio 03: la política se ve ANTES, no después. -->
      <div class="rg-politica">
        @if (minShelfLife() != null) {
          <span>Vida útil mínima: <strong>{{ minShelfLife() }} días</strong></span>
        } @else {
          <span class="rg-sinpol">Sin política configurada para este producto</span>
        }
        @if (existingMinExpiry()) {
          <span>· En stock ya hay caducidad <strong>{{ echoExistente() }}</strong></span>
        }
      </div>

      <label class="rg-f">
        <span>Foto de la etiqueta</span>
        <input type="file" accept="image/*" capture="environment" (change)="onFoto($event)" />
      </label>
      @if (fotoDataUri()) {
        <div class="rg-foto">
          <img [src]="fotoDataUri()!" alt="Etiqueta de lote y caducidad" />
          @if (ocrCorriendo()) { <span class="rg-ocr">leyendo…</span> }
          @else if (ocrConfianza() != null) {
            <span class="rg-ocr">OCR {{ (ocrConfianza()! * 100).toFixed(0) }}%</span>
          }
        </div>
      }

      <div class="rg-grid">
        <label class="rg-f">
          <span>Lote</span>
          <input pInputText [ngModel]="lote()" (ngModelChange)="lote.set($event)" placeholder="NA" />
        </label>

        <label class="rg-f">
          <span>Caducidad</span>
          <input pInputText inputmode="numeric" class="rg-fecha" maxlength="8"
            [ngModel]="fechaRaw()" (ngModelChange)="setFecha($event)" placeholder="0327" />
          <small class="rg-eco" [class.rg-eco-mal]="fechaRaw().length > 0 && !caducidadIso()">
            {{ echoFecha() }}
          </small>
        </label>
      </div>

      @if (semaforo(); as s) {
        <div class="rg-sem" [class]="'rg-sem--' + s">
          <p-tag [value]="textoSemaforo()" [severity]="s === 'green' ? 'success' : s === 'yellow' ? 'warn' : 'danger'" />
          <span>{{ razonSemaforo() }}</span>
        </div>
      }

      <label class="rg-f">
        <span>Rack</span>
        <input pInputText [ngModel]="binCode()" (ngModelChange)="binCode.set($event)"
          [placeholder]="sugerido() ? '' : 'escaneá la etiqueta del rack'" />
        @if (sugerido(); as sg) {
          <small class="rg-sug">sugerido: {{ sg.bin_code }} — donde ya vive este SKU</small>
        }
      </label>

      <div class="rg-cant">
        <span>Piezas a dar de alta</span>
        <input pInputText inputmode="numeric" class="rg-num"
          [ngModel]="cantidad()" (ngModelChange)="setCantidad($event)" />
      </div>

      <button pButton type="button" class="rg-confirmar" [loading]="guardando()"
        [disabled]="!puedeConfirmar()" (click)="emitir()">
        Fechar y acomodar
      </button>
      @if (linea().sinUbicar) {
        <p class="rg-sinubicar">
          La caducidad quedó guardada pero el rack no. Volvé a intentar el acomodo.
        </p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rg-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .rg-nombre { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); text-wrap: balance; }
    .rg-falta { flex: 0 0 auto; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .rg-politica {
      display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3);
      padding: var(--sp-2) var(--sp-3); background: var(--surface-ground);
      border-radius: var(--r-sm); font-size: var(--fs-xs); color: var(--text-muted);
    }
    .rg-sinpol { font-style: italic; }
    .rg-f { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-3); }
    .rg-f > span { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); }
    .rg-f input[pInputText] { min-height: 48px; }
    .rg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    .rg-fecha { font-size: var(--fs-h3); font-weight: var(--fw-bold); text-align: center; letter-spacing: .1em; font-variant-numeric: tabular-nums; }
    .rg-eco { font-size: var(--fs-xs); color: var(--text-muted); text-align: center; min-height: 1.2em; }
    .rg-eco-mal { color: var(--bad-fg); }
    .rg-foto { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .rg-foto img { max-height: 72px; border-radius: var(--r-sm); border: 1px solid var(--border-color); }
    .rg-ocr { font-size: var(--fs-micro); color: var(--text-muted); }
    .rg-sem { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-xs); }
    .rg-sem--green { background: var(--good-soft-bg, var(--surface-ground)); }
    .rg-sem--yellow { background: var(--warn-soft-bg, var(--surface-ground)); }
    .rg-sem--red { background: var(--bad-soft-bg, var(--surface-ground)); }
    .rg-sug { font-size: var(--fs-micro); color: var(--text-faint); }
    .rg-cant { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .rg-cant > span { font-size: var(--fs-xs); color: var(--text-muted); }
    .rg-num { width: 110px; min-height: 48px; text-align: center; font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .rg-confirmar { width: 100%; min-height: 56px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .rg-sinubicar { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--bad-fg); }
  `],
})
export class AndenRenglonComponent {
  readonly linea = input.required<AndenLinea>();
  readonly sugerido = input<PickSuggestion | null>(null);
  readonly minShelfLife = input<number | null>(null);
  readonly existingMinExpiry = input<string | null>(null);
  readonly guardando = input(false);

  readonly confirmar = output<RenglonConfirmado>();
  readonly pedirOcr = output<string>();

  readonly lote = signal('');
  readonly fechaRaw = signal('');
  readonly binCode = signal('');
  readonly cantidad = signal(0);
  readonly fotoDataUri = signal<string | null>(null);
  readonly ocrCorriendo = signal(false);
  readonly ocrConfianza = signal<number | null>(null);

  readonly nombre = computed(() => {
    const l = this.linea();
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  });

  readonly caducidadIso = computed(() => parseExpiryShort(this.fechaRaw()));
  readonly echoFecha = computed(() => {
    if (!this.fechaRaw()) return 'MMAA o DDMMAA';
    const iso = this.caducidadIso();
    return iso ? formatExpiryEcho(iso) : 'fecha inválida';
  });
  readonly echoExistente = computed(() => formatExpiryEcho(this.existingMinExpiry()));

  /**
   * Semáforo anticipado. **Sólo replica lo que se puede derivar en cliente**: la
   * vida útil mínima y la comparación contra lo que ya hay en stock. El veredicto
   * que manda es el del backend (`computeVerdict`) — acá no se duplica la cascada
   * de políticas, que se desincronizaría y terminaría mintiendo.
   */
  readonly semaforo = computed<Semaforo>(() => {
    const iso = this.caducidadIso();
    if (!iso) return null;
    const dias = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
    const min = this.minShelfLife();
    const existente = this.existingMinExpiry();
    if (min != null && dias < min) return 'red';
    if (existente && iso < existente) return 'red';
    if (min != null && dias < Math.ceil(min * 1.5)) return 'yellow';
    return 'green';
  });

  readonly textoSemaforo = computed(() => {
    const s = this.semaforo();
    return s === 'green' ? 'Verde' : s === 'yellow' ? 'Amarillo' : 'Rojo';
  });

  readonly razonSemaforo = computed(() => {
    const s = this.semaforo();
    const iso = this.caducidadIso();
    if (!iso) return '';
    const dias = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
    if (s === 'red') {
      const existente = this.existingMinExpiry();
      if (existente && iso < existente) return 'más viejo que lo que ya hay en stock — necesita autorización';
      return `${dias} días de vida, bajo el mínimo — necesita autorización`;
    }
    if (s === 'yellow') return `${dias} días de vida, cerca del mínimo`;
    return `${dias} días de vida`;
  });

  readonly puedeConfirmar = computed(() => this.cantidad() > 0 && !this.guardando());

  private soloDigitos(v: unknown): string {
    return String(v ?? '').replace(/\D/g, '').slice(0, 8);
  }

  setFecha(v: unknown): void { this.fechaRaw.set(this.soloDigitos(v)); }
  setCantidad(v: unknown): void {
    const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
    this.cantidad.set(Number.isFinite(n) ? n : 0);
  }

  onFoto(ev: Event): void {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const uri = String(r.result);
      this.fotoDataUri.set(uri);
      this.ocrConfianza.set(null);
      this.ocrCorriendo.set(true);
      // OCR SIEMPRE automático al tomar la foto (principio 06: una sola forma de
      // capturar cada dato). El padre responde por `aplicarOcr`.
      this.pedirOcr.emit(uri);
    };
    r.readAsDataURL(f);
  }

  /** Lo llama el padre con lo que devolvió el OCR. El humano confirma, el OCR propone. */
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

  /** Precarga al abrir el renglón: cantidad = lo que falta, rack = el sugerido. */
  precargar(): void {
    this.cantidad.set(this.linea().faltaFechar);
    const s = this.sugerido();
    if (s?.bin_code && !this.binCode()) this.binCode.set(s.bin_code);
  }

  emitir(): void {
    const s = this.sugerido();
    this.confirmar.emit({
      linea: this.linea(),
      cantidad: this.cantidad(),
      lote: this.lote().trim() || 'NA',
      caducidadIso: this.caducidadIso(),
      binId: !this.binCode() && s ? s.bin_id : null,
      binCode: this.binCode().trim() || null,
      fotoDataUri: this.fotoDataUri(),
    });
  }
}
