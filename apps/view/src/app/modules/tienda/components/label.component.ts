import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input,
  OnChanges, QueryList, ViewChild, ViewChildren, ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import JsBarcode from 'jsbarcode';

export interface LabelSections {
  mayoreoPza: boolean;
  paquete: boolean;
  mayoreoPaq: boolean;
  caja: boolean;
  barcode: boolean;
}
export const ALL_SECTIONS: LabelSections = { mayoreoPza: true, paquete: true, mayoreoPaq: true, caja: true, barcode: true };

/** Qué precio va en GRANDE (hero). Intercambiable por ticket. */
export type HeroKey = 'pieza' | 'paquete' | 'caja';

export interface LabelModel {
  code?: string;
  product_id: string;
  sku: string | null;
  name: string;
  content: string | null;
  barcode: string | null;
  barcode_format: string | null;
  piece_price: number | null;
  wholesale_piece_min_qty: number | null;
  wholesale_piece_price: number | null;
  pack_size: number | null;
  pack_price: number | null;
  wholesale_pack_price: number | null;
  box_size: number | null;
  box_price: number | null;
  unit_base: string | null;
}

/**
 * Etiqueta de anaquel Mega Dulces (115×40 mm) — diseño congelado (ver etiqueta-preview.html).
 * Sin iconos, letra grande, naranja de marca (--brand-700 #F05A28) en lo importante (SKU + número de piezas).
 * ViewEncapsulation.None + clases `etq-*` para que el layout en mm y las fuentes apliquen
 * limpio al imprimir. El barcode se genera con JsBarcode (mismo formato que Kepler).
 */
@Component({
  selector: 'app-label',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: [`
    @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Bebas+Neue&display=swap');
    .etq-label{
      --green:hsl(141,76%,16%); --yellow:#f6c400; --cream:#f8f6ea; --red:#F05A28;
      --font:'Baloo 2',system-ui,sans-serif; --font-num:'Impact','Haettenschweiler','Anton','Arial Narrow',sans-serif;
      --font-cond:'Bebas Neue','Impact','Arial Narrow',sans-serif;
      width:115mm; height:40mm; background:var(--cream); border-radius:3mm; overflow:hidden;
      font-family:var(--font); color:var(--green); display:flex; flex-direction:column;
      text-align:left; /* reset: el sheet-sim y el body de impresión usan text-align:center y se heredaba adentro (centraba los rótulos) */
      -webkit-print-color-adjust:exact; print-color-adjust:exact;
    }
    .etq-label *{ box-sizing:border-box; margin:0; padding:0; }
    .etq-head{ background:var(--green); color:#fff; height:7.8mm; min-height:7.8mm; display:flex; align-items:center;
      padding:0 3mm; font-weight:800; font-size:4.4mm; letter-spacing:.2px; text-transform:uppercase; overflow:hidden; }
    .etq-head-txt{ display:block; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etq-red{ color:var(--red); font-weight:800; }
    .etq-body{ flex:1; min-height:0; display:flex; padding:1mm 2mm 1.2mm 2mm; gap:2mm; }
    .etq-left{ width:54mm; display:flex; flex-direction:column; }
    .etq-meta{ display:flex; align-items:baseline; gap:1.6mm; font-weight:800; font-size:4mm; margin-bottom:1mm; }
    .etq-meta .sep{ color:var(--green); opacity:.5; }
    .etq-pricebox{ flex:1; position:relative; background:var(--yellow); border-radius:2.4mm; display:flex;
      align-items:center; justify-content:center; padding:1.5mm 1.5mm 6mm; overflow:hidden; }
    .etq-pricebox::before{ content:""; position:absolute; inset:1mm 1mm 6mm 1mm; border:.28mm dashed var(--green);
      border-bottom:0; border-radius:1.8mm 1.8mm 0 0; pointer-events:none; }
    .etq-sprout{ position:absolute; top:1mm; left:2mm; width:5.4mm; height:5.4mm; }
    .etq-price{ font-family:var(--font-num); font-weight:400; font-size:16mm; line-height:.82; letter-spacing:0;
      transform:scaleX(1.1); transform-origin:center; }
    .etq-price .cur{ font-size:.5em; vertical-align:.6em; margin-right:.3mm; }
    .etq-price .dot{ font-size:.78em; }
    .etq-pieza{ position:absolute; left:0; right:0; bottom:0; background:var(--green); color:#fff; height:5.2mm;
      display:flex; align-items:center; justify-content:center; gap:1.6mm; font-weight:800; font-size:3.2mm; white-space:nowrap; border-radius:0 0 2mm 2mm; }
    .etq-pieza::before,.etq-pieza::after{ content:""; width:7mm; height:.9mm; flex:none;
      background:repeating-linear-gradient(90deg, var(--yellow) 0 2.8mm, transparent 2.8mm 4.6mm); }
    .etq-right{ width:55mm; min-height:0; display:flex; flex-direction:column; }
    /* Los tiers se centran como grupo → 1 o 4 renglones siempre lucen balanceados (no flotan arriba). */
    .etq-tiers{ flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; gap:1.2mm; }
    .etq-tier{ position:relative; display:grid; grid-template-columns:1fr auto; align-items:center;
      column-gap:2mm; padding:.6mm 0; min-height:0; }
    .etq-tier::before{ content:""; position:absolute; top:0; left:0; right:0; height:.28mm;
      background:repeating-linear-gradient(90deg, var(--green) 0 .32mm, transparent .32mm .6mm); }
    .etq-tier:first-child::before{ display:none; }
    .etq-tier .txt{ font-family:var(--font-cond); font-size:3mm; font-weight:400; line-height:1; letter-spacing:.3px; }
    /* Celda de precio de ancho fijo → todos los precios arrancan en el mismo x (orden a la izquierda). */
    .etq-tier .pricecell{ width:20mm; display:flex; align-items:baseline; gap:1mm; }
    .etq-tier .amt{ font-family:var(--font-cond); font-weight:400; font-size:5mm; white-space:nowrap; letter-spacing:.3px; font-variant-numeric:tabular-nums; }
    .etq-tier .unit{ font-family:var(--font); font-size:1.9mm; font-weight:600; }
    .etq-barcode{ margin-top:.3mm; display:flex; justify-content:flex-end; }
    .etq-barcode svg{ display:block; width:85%; height:5.4mm; }
  `],
  template: `
    <div class="etq-label">
      <div class="etq-head" #head><span class="etq-head-txt" #headtxt>{{ headName }}</span></div>
      <div class="etq-body">
        <div class="etq-left">
          <div class="etq-meta">
            @if (model.content) { <span>{{ model.content }}</span><span class="sep">|</span> }
            <span>Código: <span class="etq-red">{{ model.sku }}</span></span>
          </div>
          <div class="etq-pricebox">
            <svg class="etq-sprout" viewBox="0 0 40 40" fill="hsl(141, 60%, 38%)"><path transform="translate(12,15) rotate(120)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/><path transform="translate(22,10) rotate(150) scale(0.7)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/></svg>
            <div class="etq-price" #priceEl><span class="cur">$</span>{{ bigInt }}<span class="dot">.</span>{{ bigDec }}</div>
            <div class="etq-pieza">Precio por {{ bigUnit.word }}</div>
          </div>
        </div>
        <div class="etq-right">
          <div class="etq-tiers">
            @if (hasMayoreoPza) {
              <div class="etq-tier">
                <div class="txt">Mayoreo desde <span class="etq-red">{{ mayoreoMin }}</span> pzas:</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.wholesale_piece_price | number:'1.2-2' }}</span><span class="unit">c/u</span></div>
              </div>
            }
            @if (hasPaquete) {
              <div class="etq-tier">
                <div class="txt">Paquete con <span class="etq-red">{{ model.pack_size }}</span> pzas:</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.pack_price | number:'1.2-2' }}</span></div>
              </div>
            }
            @if (hasMayoreoPaq) {
              <div class="etq-tier">
                <div class="txt">Mayoreo desde <span class="etq-red">{{ mayoreoMin }}</span> paquetes:</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.wholesale_pack_price | number:'1.2-2' }}</span><span class="unit">c/u</span></div>
              </div>
            }
            @if (hasCaja) {
              <div class="etq-tier">
                <div class="txt">Caja con <span class="etq-red">{{ model.box_size }}</span> pzas:</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.box_price | number:'1.2-2' }}</span></div>
              </div>
            }
          </div>
          @if (hasBarcode) {
            <div class="etq-barcode"><svg #bc></svg></div>
          }
        </div>
      </div>
    </div>
  `,
})
export class LabelComponent implements AfterViewInit, OnChanges {
  @Input({ required: true }) model!: LabelModel;
  @Input() show: LabelSections = ALL_SECTIONS;
  /** Precio que va en grande. Null = default (pieza con fallback). Intercambiable por ticket. */
  @Input() hero: HeroKey | null = null;
  @ViewChild('bc') bc?: ElementRef<SVGElement>;
  @ViewChild('head') head?: ElementRef<HTMLElement>;
  @ViewChild('headtxt') headtxt?: ElementRef<HTMLElement>;
  @ViewChild('priceEl') priceEl?: ElementRef<HTMLElement>;
  @ViewChildren('amtEl') amtEls?: QueryList<ElementRef<HTMLElement>>;

  private num(v: number | null | undefined): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

  get headName(): string {
    return (this.model?.name || '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:kg|g|gr|grs|ml|l)\s*\/?\s*\d*\s*$/i, '').trim() || this.model?.name || '';
  }
  get mayoreoMin(): number { return this.model?.wholesale_piece_min_qty || 3; }

  // ── F1: visibilidad data-driven — un tier solo se muestra si el multiselect lo
  //    pide Y hay dato real (precio > 0 y, donde aplica, tamaño > 0). Mata los $0.00 y (0 pzas).
  // ── F5: además, un mayoreo solo se muestra si CUADRA (es más barato que su precio base);
  //    un "mayoreo" ≥ menudeo es dato erróneo de Kepler → se oculta en vez de imprimir un precio absurdo.
  get hasMayoreoPza(): boolean {
    const w = this.num(this.model?.wholesale_piece_price);
    const base = this.num(this.model?.piece_price);
    return !!this.show.mayoreoPza && w > 0 && (base <= 0 || w < base);
  }
  get hasPaquete(): boolean { return !!this.show.paquete && this.num(this.model?.pack_price) > 0 && this.num(this.model?.pack_size) > 0; }
  get hasMayoreoPaq(): boolean {
    // Sólo si el producto TIENE paquete REAL (precio y tamaño > 0, igual que hasPaquete) y el
    // mayoreo es más barato. Sin paquete, un "mayoreo por paquete" queda huérfano (ej. SKU 70001,
    // unidad = caja directa). F5.
    const w = this.num(this.model?.wholesale_pack_price);
    const base = this.num(this.model?.pack_price);
    const size = this.num(this.model?.pack_size);
    return !!this.show.mayoreoPaq && base > 0 && size > 0 && w > 0 && w < base;
  }
  get hasCaja(): boolean { return !!this.show.caja && this.num(this.model?.box_price) > 0 && this.num(this.model?.box_size) > 0; }
  // Muestra el barcode si el multiselect lo pide Y hay algo que codificar: EAN/UPC válido
  // del producto, o al menos el SKU (fallback CODE128) → toda etiqueta sale escaneable.
  get hasBarcode(): boolean { return !!this.show.barcode && (!!(this.model?.barcode && this.model?.barcode_format) || !!(this.model?.sku && this.model.sku.trim())); }

  /**
   * Precio grande. Con `hero` explícito (intercambiable por ticket) usa ese precio si es válido.
   * Sin override — default F8/F2: precio de PIEZA (legible en anaquel); si no hay pieza (>0),
   * cae al primer precio disponible (paquete → caja) para no imprimir $0.00.
   * KG (granel): piece_price es $/kg → palabra "kg".
   */
  get bigUnit(): { word: string; value: number } {
    const m = this.model;
    const kg = (m?.unit_base || '').toUpperCase() === 'KG';
    const pieceWord = kg ? 'kg' : 'pieza';
    // Override explícito por ticket (solo si ese precio existe).
    if (this.hero === 'paquete' && this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price) };
    if (this.hero === 'caja' && this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price) };
    if (this.hero === 'pieza' && this.num(m?.piece_price) > 0) return { word: pieceWord, value: this.num(m?.piece_price) };
    // Default: pieza con fallback.
    const piece = this.num(m?.piece_price);
    if (piece > 0) return { word: pieceWord, value: piece };
    if (this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price) };
    if (this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price) };
    return { word: pieceWord, value: 0 };
  }
  private get bigStr(): string { return this.bigUnit.value.toFixed(2); }
  // F4: separador de miles (igual que los tiers con number:'1.2-2') → "1,044".
  get bigInt(): string { return this.bigStr.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  get bigDec(): string { return this.bigStr.split('.')[1] ?? '00'; }

  ngAfterViewInit(): void { this.render(); (document as any).fonts?.ready?.then(() => this.layout()); }
  ngOnChanges(): void { queueMicrotask(() => this.render()); }

  private render(): void { this.renderBarcode(); this.layout(); }

  /** Corre todos los auto-ajustes (nombre + precio grande + montos de tier). */
  private layout(): void { this.fitHead(); this.fitPrice(); this.fitAmts(); }

  /** Reduce la fuente hasta que `el` (contenido) quepa en su contenedor, con piso mínimo. */
  private shrinkToFit(el: HTMLElement, container: HTMLElement, startMm: number, minMm: number, stepMm = 0.2): void {
    let size = startMm;
    el.style.fontSize = size + 'mm';
    let guard = 0;
    while (container.scrollWidth > container.clientWidth && size > minMm && guard++ < 120) {
      size -= stepMm;
      el.style.fontSize = size + 'mm';
    }
  }

  /** Auto-ajuste del nombre (una línea en el header). */
  private fitHead(): void {
    const head = this.head?.nativeElement;
    const txt = this.headtxt?.nativeElement;
    if (!head || !txt) return;
    let size = 4.4;
    head.style.fontSize = size + 'mm';
    let guard = 0;
    while (txt.scrollWidth > txt.clientWidth && size > 2.6 && guard++ < 40) {
      size -= 0.14;
      head.style.fontSize = size + 'mm';
    }
  }

  /**
   * F3: el precio grande se encoge hasta caber en la caja amarilla (nunca desborda).
   * Usa `offsetWidth` (layout, agnóstico al scale del sheet-sim) y multiplica ×1.12 para
   * compensar el `scaleX(1.1)` visual del precio + un margen; así no spillea ni en pantalla ni impreso.
   */
  private fitPrice(): void {
    const el = this.priceEl?.nativeElement;
    const box = el?.parentElement; // .etq-pricebox
    if (!el || !box) return;
    const cs = getComputedStyle(box);
    const avail = box.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    let size = 16;
    el.style.fontSize = size + 'mm';
    let guard = 0;
    while (el.offsetWidth * 1.12 > avail && size > 6 && guard++ < 120) {
      size -= 0.3;
      el.style.fontSize = size + 'mm';
    }
  }

  /** F3: cada monto de tier se encoge hasta caber en su celda (20mm), preservando el c/u. */
  private fitAmts(): void {
    this.amtEls?.forEach((ref) => {
      const amt = ref.nativeElement;
      const cell = amt.parentElement; // .pricecell
      if (cell) this.shrinkToFit(amt, cell, 5, 3, 0.2);
    });
  }

  private renderBarcode(): void {
    const el = this.bc?.nativeElement;
    if (!el) return;
    el.innerHTML = '';
    // 1) EAN/UPC/EAN8 válido del producto (== lo que el lector matchea). 2) fallback: CODE128
    //    del SKU, para que TODA etiqueta salga con un código escaneable (resolve matchea por SKU).
    let code = this.model?.barcode;
    let fmt = this.model?.barcode_format;
    if (!code || !fmt) {
      const sku = (this.model?.sku || '').trim();
      if (!sku) return;
      code = sku;
      fmt = 'CODE128';
    }
    try {
      JsBarcode(el, code, { format: fmt as any, displayValue: false, margin: 0, width: 2, height: 66 });
      const w = el.getAttribute('width');
      const h = el.getAttribute('height');
      if (w && h) {
        el.setAttribute('viewBox', `0 0 ${w} ${h}`);
        el.setAttribute('preserveAspectRatio', 'none');
        el.removeAttribute('width');
        el.removeAttribute('height');
      }
    } catch { /* código inválido → sin barcode */ }
  }
}
