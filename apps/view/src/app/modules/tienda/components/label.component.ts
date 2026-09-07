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

/** Qué precio va en GRANDE (hero). Intercambiable por ticket. 'kg' = granel por kilo. */
export type HeroKey = 'pieza' | 'paquete' | 'caja' | 'kg';

/**
 * ⭐ EL BUG DEL "número que a veces se ve más chico".
 *
 * `fitPrice()`/`fitAmts()` encogen el texto midiendo su ancho. Si miden ANTES de que la
 * tipografía definitiva esté usable, miden con la **fallback**, que tiene otro ancho, y el
 * tamaño que dejan queda mal en la dirección de esa fallback. Medido (mismo precio, misma
 * caja, cambiando sólo la fuente con la que se mide):
 *
 *   midiendo con        ancho vs Anton    un precio de 4 cifras queda en
 *   Anton (la buena)    —                 9.00 mm
 *   Impact (Windows)    +5…8%             8.50 mm
 *   Helvetica (iPad)    +13…21%           7.50 mm  ← 17% más chico
 *   Arial Narrow        −1…7%             9.25 mm  (y al llegar Anton se RECORTA)
 *
 * `document.fonts.ready` NO alcanzaba, y de ahí lo intermitente: las familias llegan por un
 * `@import` a fonts.googleapis.com DENTRO del CSS de este componente, así que mientras esa
 * hoja no baja **no existe ningún `@font-face`** — no hay carga pendiente, `fonts.ready`
 * resuelve al instante y `layout()` mide con la fallback. Encima el re-layout vivía sólo en
 * `ngAfterViewInit`: toda etiqueta creada por un cambio de input (que es como las crea la
 * etiquetera al armar la cola) se quedaba con la medida equivocada para siempre.
 *
 * Esto espera a que las familias estén **realmente usables** (`fonts.load` + `fonts.check`,
 * con tope de 3 s), una sola vez para toda la app. Si no llegan —equipo sin internet— se
 * sigue midiendo con la fallback, que ahí es lo CORRECTO: es la que va a imprimir.
 *
 * (Ver `FUENTES_USABLES` abajo, que es la pieza que lo implementa.)
 */

/**
 * Tamaños de ARRANQUE de los dos números que se auto-ajustan. Están también en el CSS (los
 * necesita el primer render y el clon de impresión, antes de que corra el TS), y el spec
 * `etiqueta-hoja.spec.ts` exige que coincidan: si se cambia uno solo, el número arranca de un
 * tamaño y se mide contra otro.
 */
const PRECIO_MM = 10;
const MONTO_MM = 5.4;

/** Resuelve cuando Anton/Bebas/Baloo están REALMENTE usables (o a los 3 s). Ver el bloque de arriba. */
const FUENTES_USABLES: Promise<void> = (() => {
  const f: any = (globalThis as any).document?.fonts;
  const specs = ['11mm Anton', "5mm 'Bebas Neue'", "4mm 'Baloo 2'"];
  if (!f?.load || !f?.check) return Promise.resolve();
  const listas = () => specs.every((s) => { try { return f.check(s); } catch { return true; } });
  return new Promise<void>((resolve) => {
    Promise.all(specs.map((s) => f.load(s).catch(() => undefined))).catch(() => undefined);
    const t0 = Date.now();
    const tick = () => {
      if (listas() || Date.now() - t0 > 3000) { resolve(); return; }
      setTimeout(tick, 60);
    };
    tick();
  });
})();

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
  wholesale_pack_min_qty: number | null;
  box_size: number | null;
  box_price: number | null;
  unit_base: string | null;
  sold_by_kg?: boolean;
  scanned_unit?: string | null;   // unidad del barcode con que se resolvió (PZA/PAQ/CJA/KG) — auto-selecciona el hero
}

/**
 * Etiqueta de anaquel Mega Dulces — **82×35 mm**.
 *
 * Mismo diseño de `etiqueta-preview.html` (que quedó al tamaño original, 115×40) re-proporcionado.
 * El cambio de tamaño no fue cosmético: 115 mm de ancho daban **2 columnas × 4 filas = 8 por hoja**
 * Carta horizontal, y el umbral de la 3ª columna está en 82.6 mm de ancho (263 mm útiles ÷ 3, menos
 * los 5 mm de margen de recorte). A 82×35 entran **3 × 5 = 15 por hoja**: casi la mitad de papel.
 * Bajar sólo a 100 mm no habría cambiado nada — los saltos son umbrales, no una curva.
 * Además la pantalla ya AFIRMABA "100×40 mm" mientras el CSS imprimía 115: 15 mm más ancho que
 * el material que decía usar.
 *
 * Al angostar, lo único con mínimo físico es el código de barras (un EAN-13 pide ~29.8 mm al 80%
 * de magnificación): toma el ancho completo de su columna, **43.4 mm**. El resto del texto se
 * auto-encoge (`fitHead`/`fitPrice`/`fitTiers`/`fitAmts`), así que ninguna cadena larga desborda.
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
    @import url('https://fonts.googleapis.com/css2?family=Anton&family=Baloo+2:wght@500;600;700;800&family=Bebas+Neue&display=swap');
    .etq-label{
      --green:hsl(141,76%,16%); --yellow:#f6c400; --cream:#f8f6ea; --red:#F05A28;
      --font:'Baloo 2',system-ui,sans-serif;
      /* El precio grande va con Anton, que SE DESCARGA. Antes encabezaba 'Impact', que no es
         webfont: existe instalada en Windows y macOS pero no en iPad ni en Android, y ahí toda
         la cadena caía hasta sans-serif — el precio salía en Helvetica normal en vez de la
         condensada pesada. Misma etiqueta, dos tipografías según el equipo que la imprimiera.
         Anton queda primero para que la etiqueta impresa sea idéntica en todos lados; Impact
         queda de respaldo por si el equipo está sin internet y ya la tiene instalada. */
      --font-num:'Anton','Impact','Haettenschweiler','Arial Narrow',sans-serif;
      --font-cond:'Bebas Neue','Impact','Arial Narrow',sans-serif;
      width:82mm; height:35mm; background:var(--cream); border-radius:2.5mm; overflow:hidden;
      font-family:var(--font); color:var(--green); display:flex; flex-direction:column;
      text-align:left; /* reset: el sheet-sim y el body de impresión usan text-align:center y se heredaba adentro (centraba los rótulos) */
      -webkit-print-color-adjust:exact; print-color-adjust:exact;
    }
    .etq-label *{ box-sizing:border-box; margin:0; padding:0; }
    .etq-head{ background:var(--green); color:#fff; height:6.8mm; min-height:6.8mm; display:flex; align-items:center;
      padding:0 2mm; font-weight:800; font-size:3.9mm; letter-spacing:.2px; text-transform:uppercase; overflow:hidden; }
    .etq-head-txt{ display:block; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etq-red{ color:var(--red); font-weight:800; }
    .etq-body{ flex:1; min-height:0; display:flex; padding:.8mm 1.5mm 1mm 1.5mm; gap:1.6mm; }
    /* 34 + 1.6 de gap + 43.4 + 3 de padding = 82 exactos.
       El reparto YA NO es el original (54:55): al reducir la etiqueta, el mayoreo quedó
       ilegible porque su monto se auto-encogía hasta ~3.7 mm. Se le pasan 4.4 mm del precio
       unitario —que arranca un poco más chico— a la columna del mayoreo, que es donde el
       cliente compara. */
    .etq-left{ width:34mm; display:flex; flex-direction:column; }
    .etq-meta{ display:flex; align-items:baseline; gap:1.2mm; font-weight:800; font-size:3.2mm; margin-bottom:.8mm; }
    .etq-meta .sep{ color:var(--green); opacity:.5; }
    .etq-pricebox{ flex:1; position:relative; background:var(--yellow); border-radius:2mm; display:flex;
      align-items:center; justify-content:center; padding:1.2mm 1.2mm 5mm; overflow:hidden; }
    .etq-pricebox::before{ content:""; position:absolute; inset:.8mm .8mm 5mm .8mm; border:.28mm dashed var(--green);
      border-bottom:0; border-radius:1.5mm 1.5mm 0 0; pointer-events:none; }
    .etq-sprout{ position:absolute; top:.8mm; left:1.4mm; width:4.4mm; height:4.4mm; }
    /* 10mm de arranque (era 11.5): el precio unitario cede tamaño para que el mayoreo se lea.
       ⚠️ Este valor está duplicado en PRECIO_MM (lo necesita el TS para arrancar el
       auto-ajuste) y el spec exige que coincidan. */
    .etq-price{ font-family:var(--font-num); font-weight:400; font-size:10mm; line-height:.82; letter-spacing:0;
      transform:scaleX(1.1); transform-origin:center; }
    .etq-price .cur{ font-size:.5em; vertical-align:.6em; margin-right:.3mm; }
    .etq-price .dot{ font-size:.78em; }
    .etq-pieza{ position:absolute; left:0; right:0; bottom:0; background:var(--green); color:#fff; height:4.4mm;
      display:flex; align-items:center; justify-content:center; gap:1.2mm; font-weight:800; font-size:2.7mm; white-space:nowrap; border-radius:0 0 1.6mm 1.6mm; }
    .etq-pieza::before,.etq-pieza::after{ content:""; width:4.6mm; height:.8mm; flex:none;
      background:repeating-linear-gradient(90deg, var(--yellow) 0 2mm, transparent 2mm 3.2mm); }
    .etq-right{ width:43.4mm; min-height:0; display:flex; flex-direction:column; }
    /* Los tiers se centran como grupo → 1 o 4 renglones siempre lucen balanceados (no flotan arriba). */
    /* Gap y padding apretados a propósito: el alto que ahorran acá se lo queda el MONTO, que es
       lo que se lee de lejos. Medido sobre los 9,013 productos con precios de etiqueta, el
       **76.1% tiene 2 renglones** y sólo el **2.0% tiene 4**, así que el caso común se imprime
       al tamaño grande y los de 4 bajan lo que haga falta (fitTiers). */
    .etq-tiers{ flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; gap:.5mm; }
    .etq-tier{ position:relative; display:grid; grid-template-columns:1fr auto; align-items:center;
      column-gap:1.2mm; padding:.2mm 0; min-height:0; }
    .etq-tier::before{ content:""; position:absolute; top:0; left:0; right:0; height:.28mm;
      background:repeating-linear-gradient(90deg, var(--green) 0 .32mm, transparent .32mm .6mm); }
    .etq-tier:first-child::before{ display:none; }
    .etq-tier .txt{ font-family:var(--font-cond); font-size:2.6mm; font-weight:400; line-height:1; letter-spacing:.3px; }
    /* Celda de precio de ancho fijo → todos los precios arrancan en el mismo x (orden a la izquierda). */
    .etq-tier .pricecell{ width:22mm; display:flex; align-items:baseline; gap:.7mm; }
    /* ⚠️ 5.4mm duplicado en MONTO_MM (el TS arranca de ahí el ajuste); el spec lo verifica.
       El PESO va por trazo, no por font-weight: Bebas Neue no tiene bold real y el navegador
       no la sintetiza — medido, font-weight:700 daba el MISMO ancho al píxel, o sea nada. */
    .etq-tier .amt{ font-family:var(--font-cond); font-weight:400; font-size:5.4mm; white-space:nowrap;
      letter-spacing:.3px; font-variant-numeric:tabular-nums; -webkit-text-stroke:.09mm currentColor; }
    .etq-tier .unit{ font-family:var(--font); font-size:1.7mm; font-weight:600; }
    /* MAYOREO: es el renglón por el que el cliente decide comprar más, así que se realza —
       chip amarillo de marca + trazo más grueso en el número. Es el mismo amarillo de la caja
       del precio grande, para que se lean como pareja. */
    .etq-tier.is-mayoreo{ background:rgba(246,196,0,.32); border-radius:1mm; padding:.3mm 1mm; margin:0 -1mm; }
    .etq-tier.is-mayoreo::before{ display:none; }
    .etq-tier.is-mayoreo + .etq-tier::before{ display:none; }
    .etq-tier.is-mayoreo .txt{ font-weight:400; letter-spacing:.4px; }
    .etq-tier.is-mayoreo .amt{ -webkit-text-stroke:.16mm currentColor; }
    /* El código toma el ANCHO COMPLETO de la columna (antes 85%): al angostar la etiqueta es lo
       único con un mínimo físico —un EAN-13 necesita ~29.8 mm al 80% de magnificación— y 39.4 mm
       lo deja con holgura. La altura no baja de 5 mm: es lo que el lector necesita para engancharlo. */
    .etq-barcode{ margin-top:.3mm; display:flex; justify-content:flex-end; }
    .etq-barcode svg{ display:block; width:100%; height:5mm; }
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
          <!-- Rótulos CORTOS ("Mayoreo 3+ cajas" en vez de "Mayoreo desde 3 cajas:"): el
               rótulo era lo que se comía el ancho de la columna y obligaba a encoger el monto
               hasta dejarlo ilegible. Acortarlo es lo que permite el monto grande. -->
          <div class="etq-tiers" #tiers>
            @if (granelAltTier; as g) {
              <div class="etq-tier">
                <div class="txt">Por {{ g.label }}</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ g.value | number:'1.2-2' }}</span></div>
              </div>
            }
            @if (hasMayoreoPza) {
              <div class="etq-tier is-mayoreo">
                <div class="txt">Mayoreo <span class="etq-red">{{ mayoreoMin }}+</span> {{ mayoreoBaseWord }}</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.wholesale_piece_price | number:'1.2-2' }}</span><span class="unit">c/u</span></div>
              </div>
            }
            @if (hasPaquete) {
              <div class="etq-tier">
                <div class="txt">Paquete <span class="etq-red">{{ model.pack_size }}</span> pzas</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.pack_price | number:'1.2-2' }}</span></div>
              </div>
            }
            @if (hasMayoreoPaq) {
              <div class="etq-tier is-mayoreo">
                @if (mayoreoPaqMin; as mn) {
                  <div class="txt">Mayoreo <span class="etq-red">{{ mn }}+</span> {{ mayoreoGroupWord }}</div>
                } @else {
                  <div class="txt">Mayoreo</div>
                }
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.wholesale_pack_price | number:'1.2-2' }}</span><span class="unit">c/u</span></div>
              </div>
            }
            @if (hasCaja) {
              <div class="etq-tier">
                @if (isGranel) {
                  <div class="txt">Caja <span class="etq-red">{{ cajaWeight }}</span></div>
                } @else {
                  <div class="txt">Caja <span class="etq-red">{{ model.box_size }}</span> {{ boxContentWord }}</div>
                }
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
  @ViewChild('tiers') tiers?: ElementRef<HTMLElement>;
  @ViewChildren('amtEl') amtEls?: QueryList<ElementRef<HTMLElement>>;

  private num(v: number | null | undefined): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

  get headName(): string {
    return (this.model?.name || '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:kg|g|gr|grs|ml|l)\s*\/?\s*\d*\s*$/i, '').trim() || this.model?.name || '';
  }
  get mayoreoMin(): number { return this.model?.wholesale_piece_min_qty || 3; }

  // ── Unidad BASE de venta (piece_price == Kepler c90). `unit_base` dice QUÉ es esa fila:
  //    PAQ → el producto se vende POR PAQUETE (c90 = precio del paquete), CJA → por caja, resto
  //    → pieza. (Granel — KG/gramos — se resuelve por kg/porción aparte.) ~75% del catálogo es
  //    base PAQ: antes imprimía "Precio por pieza" con el precio del paquete → bug de unidad.
  get baseUnit(): 'paquete' | 'caja' | 'pieza' {
    const ub = (this.model?.unit_base || '').toUpperCase();
    if (ub === 'PAQ') return 'paquete';
    if (ub === 'CJA') return 'caja';
    return 'pieza';
  }
  /** El producto se vende agrupado (paquete/caja) como unidad base, no por pieza suelta. */
  get baseIsGrouped(): boolean { return this.baseUnit !== 'pieza'; }
  private plural(u: string): string { return u === 'pieza' ? 'pzas' : u === 'paquete' ? 'paquetes' : 'cajas'; }
  /** Umbral del mayoreo por paquete (min_qty del tier elegido). null = sin umbral confiable. */
  get mayoreoPaqMin(): number | null { const m = this.num(this.model?.wholesale_pack_min_qty); return m > 1 ? m : null; }
  /** Palabra plural del tier de mayoreo agrupado: paquetes/cajas (o 'paquetes' en base pieza). */
  get mayoreoGroupWord(): string { return this.baseIsGrouped ? this.plural(this.baseUnit) : 'paquetes'; }
  /** Unidad del mayoreo de la BASE (no agrupada): KG→'kg', granel numérico/PZA→'pzas'. */
  get mayoreoBaseWord(): string { return (this.model?.unit_base || '').toUpperCase() === 'KG' ? 'kg' : 'pzas'; }
  /** Contenido de la caja: en base agrupada la caja trae N paquetes/cajas, no piezas. */
  get boxContentWord(): string { return this.baseIsGrouped ? this.plural(this.baseUnit) : 'pzas'; }

  // ── F1: visibilidad data-driven — un tier solo se muestra si el multiselect lo
  //    pide Y hay dato real (precio > 0 y, donde aplica, tamaño > 0). Mata los $0.00 y (0 pzas).
  // ── F5: además, un mayoreo solo se muestra si CUADRA (es más barato que su precio base);
  //    un "mayoreo" ≥ menudeo es dato erróneo de Kepler → se oculta en vez de imprimir un precio absurdo.
  /** El precio grande (hero) es la unidad BASE (pieza/paquete/caja base o granel). null = sin scan → base. */
  get bigIsBase(): boolean { const h = this.hero; return !h || h === 'pieza' || h === 'kg'; }
  get hasMayoreoPza(): boolean {
    // Base agrupada (paquete/caja) no tiene "pieza suelta" que mayorear → se oculta.
    if (this.baseIsGrouped) return false;
    // El mayoreo debe ser el de la UNIDAD LEÍDA: pieza solo si el hero es la base (pieza/granel).
    if (!this.bigIsBase) return false;
    const w = this.num(this.model?.wholesale_piece_price);
    const base = this.num(this.model?.piece_price);
    return !!this.show.mayoreoPza && w > 0 && (base <= 0 || w < base);
  }
  get hasPaquete(): boolean { return !!this.show.paquete && this.num(this.model?.pack_price) > 0 && this.num(this.model?.pack_size) > 0; }
  get hasMayoreoPaq(): boolean {
    // El comparativo depende de la unidad base (Kepler unit_base):
    //  · base=paquete/caja → el "precio de paquete" ES el precio base (c90/piece_price); el
    //    mayoreo (wholesale_pack_price) vive suelto porque el paquete no está en pack_size. F-unit.
    //  · base=pieza → paquete REAL de piezas (pack_price + pack_size), igual que antes. F5.
    const w = this.num(this.model?.wholesale_pack_price);
    if (!this.show.mayoreoPaq || w <= 0) return false;
    if (this.baseIsGrouped) {
      // base es paquete/caja → este ES el mayoreo de la unidad base → solo si el hero es la base.
      if (!this.bigIsBase) return false;
      const base = this.num(this.model?.piece_price);
      return base > 0 && w < base;
    }
    // base=pieza → mayoreo por PAQUETE → solo si se leyó/eligió el paquete.
    if (this.hero !== 'paquete') return false;
    const base = this.num(this.model?.pack_price);
    const size = this.num(this.model?.pack_size);
    return base > 0 && size > 0 && w < base;
  }
  get hasCaja(): boolean { return !!this.show.caja && this.num(this.model?.box_price) > 0 && this.num(this.model?.box_size) > 0; }
  // Muestra el barcode si el multiselect lo pide Y hay algo que codificar: EAN/UPC válido
  // del producto, o al menos el SKU (fallback CODE128) → toda etiqueta sale escaneable.
  get hasBarcode(): boolean { return !!this.show.barcode && (!!(this.model?.barcode && this.model?.barcode_format) || !!(this.model?.sku && this.model.sku.trim())); }

  /**
   * ¿Producto a GRANEL (se vende por KILO)? `unit_base` = tamaño de la porción base: "KG" (1 kg)
   * o gramos ("500"/"250"/"400"). SOLO es granel si `sold_by_kg` (Kepler: base KG o tier KG) →
   * evita fabricar "$/kg" para bolsas/palitos con unit_base numérico que NO se venden por kilo
   * (ej. 68521 PALO, POLIPRO). Sin presentación en kilos → 0 (cae a "Precio por pieza").
   */
  private get granelGrams(): number {
    if (!this.model?.sold_by_kg) return 0;
    const ub = (this.model?.unit_base || '').toUpperCase();
    if (ub === 'KG') return 1000;
    return /^\d+$/.test(ub) ? parseInt(ub, 10) : 0; // 500g/250g/400g; 0 = no es granel
  }
  /** Precio por kg del granel: pza × (1000 / gramos de la porción base). */
  private get perKgPrice(): number {
    const g = this.granelGrams;
    return g > 0 ? this.num(this.model?.piece_price) * 1000 / g : 0;
  }
  get isGranel(): boolean { return this.granelGrams > 0; }
  /** Peso de la caja en granel: box_size × porción (10×500g = "5 kg"). */
  get cajaWeight(): string {
    const g = this.num(this.model?.box_size) * this.granelGrams;
    return g >= 1000 ? `${+(g / 1000).toFixed(2)} kg` : `${g} g`;
  }

  /**
   * Precio grande. Con `hero` explícito (intercambiable por ticket) usa ese precio si es válido.
   * GRANEL (unit_base KG/500/250/…): el "pieza" se muestra como **precio por kg**.
   * Sin override: pieza/kg; si no hay (>0), cae a paquete → caja para no imprimir $0.00.
   */
  get bigUnit(): { word: string; value: number } {
    const m = this.model;
    const grams = this.granelGrams;
    const granel = grams > 0;
    const piece = this.num(m?.piece_price);
    const portionWord = grams >= 1000 ? 'kg' : `${grams} g`; // "500 g" / "kg"

    // Overrides explícitos por ticket.
    if (this.hero === 'kg' && granel) return { word: 'kg', value: this.perKgPrice };
    if (this.hero === 'paquete' && this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price) };
    if (this.hero === 'caja' && this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price) };
    if (this.hero === 'pieza' && piece > 0) return granel ? { word: portionWord, value: piece } : { word: this.baseUnit, value: piece };

    // Default: granel = por kg (se vende por kilo); normal = unidad base (pieza/paquete/caja
    // según Kepler unit_base); con fallback. c90 es el precio de ESA unidad base.
    if (granel && (piece > 0 || this.perKgPrice > 0)) return { word: 'kg', value: this.perKgPrice };
    if (piece > 0) return { word: this.baseUnit, value: piece };
    if (this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price) };
    if (this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price) };
    return granel ? { word: 'kg', value: 0 } : { word: this.baseUnit, value: 0 };
  }

  /**
   * Granel de porción < 1 kg (500 g / 250 g / …): muestra el OTRO precio como tier para ver
   * AMBOS — si el hero es por kg, el tier es la porción; si el hero es la porción, el tier es kg.
   */
  get granelAltTier(): { label: string; value: number } | null {
    const grams = this.granelGrams;
    if (grams <= 0 || grams >= 1000) return null;
    const piece = this.num(this.model?.piece_price);
    if (piece <= 0) return null;
    return this.bigUnit.word === 'kg'
      ? { label: `${grams} g`, value: piece }
      : { label: '1 kg', value: this.perKgPrice };
  }
  private get bigStr(): string { return this.bigUnit.value.toFixed(2); }
  // F4: separador de miles (igual que los tiers con number:'1.2-2') → "1,044".
  get bigInt(): string { return this.bigStr.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  get bigDec(): string { return this.bigStr.split('.')[1] ?? '00'; }

  ngAfterViewInit(): void { this.render(); FUENTES_USABLES.then(() => this.layout()); }
  ngOnChanges(): void { queueMicrotask(() => { this.render(); FUENTES_USABLES.then(() => this.layout()); }); }

  private render(): void { this.renderBarcode(); this.layout(); }

  /**
   * Corre todos los auto-ajustes. `fitTiers` va ANTES de `fitAmts`: el primero baja el tamaño
   * de TODOS los montos por igual hasta que el bloque quepa a lo alto (para que sigan
   * alineados), el segundo encoge cada monto suelto si su celda no lo aguanta a lo ancho.
   */
  private layout(): void { this.fitHead(); this.fitPrice(); this.fitTiers(); this.fitAmts(); }

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
    let size = 3.9;
    head.style.fontSize = size + 'mm';
    let guard = 0;
    while (txt.scrollWidth > txt.clientWidth && size > 2.3 && guard++ < 40) {
      size -= 0.12;
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
    let size = PRECIO_MM;
    el.style.fontSize = size + 'mm';
    // La OTRA mitad del bug del número chico: si la caja todavía no tiene ancho (etiqueta
    // recién creada, oculta o sin estilos aplicados), `clientWidth` da 0 → `avail` sale
    // NEGATIVO → el bucle corre hasta el piso y el precio queda en 4.5 mm, la versión
    // dramática de "se ve más chico". Sin medida no se encoge: se deja el tamaño de arranque
    // y el siguiente pase (fuentes usables) lo corrige con una medida de verdad.
    if (!(avail > 0)) return;
    let guard = 0;
    while (el.offsetWidth * 1.12 > avail && size > 4.5 && guard++ < 120) {
      size -= 0.25;
      el.style.fontSize = size + 'mm';
    }
  }

  /**
   * Ajuste VERTICAL del bloque de tiers: baja el tamaño de todos los montos por igual hasta
   * que los renglones quepan a lo alto de su columna.
   *
   * Antes no existía y el bloque se RECORTABA en silencio (lo tapa el `overflow:hidden` de la
   * etiqueta): con 4 renglones el contenido medía 100 px contra 92 de caja **ya en la etiqueta
   * de 115×40**, o sea que el último tier salía cortado desde antes de reducir el tamaño. Con
   * esto, 1-3 tiers —el caso común— se imprimen al tamaño grande, y 4 bajan lo necesario en vez
   * de perder un renglón.
   */
  private fitTiers(): void {
    const box = this.tiers?.nativeElement;
    const amts = this.amtEls;
    if (!box || !amts?.length) return;
    if (!(box.clientHeight > 0)) return; // sin medida no se toca (ver fitPrice)
    let size = MONTO_MM;
    const set = (mm: number) => amts.forEach((r) => { r.nativeElement.style.fontSize = mm + 'mm'; });
    set(size);
    let guard = 0;
    while (box.scrollHeight > box.clientHeight + 1 && size > 2.6 && guard++ < 60) {
      size -= 0.2;
      set(size);
    }
  }

  /**
   * Cada monto se encoge hasta caber en su celda, preservando el "c/u". Arranca del tamaño que
   * dejó `fitTiers` (no de la constante) para no deshacer el ajuste vertical.
   */
  private fitAmts(): void {
    this.amtEls?.forEach((ref) => {
      const amt = ref.nativeElement;
      const cell = amt.parentElement; // .pricecell
      if (!cell || !(cell.clientWidth > 0)) return;
      const desde = parseFloat(amt.style.fontSize) || MONTO_MM;
      this.shrinkToFit(amt, cell, desde, 2.4, 0.15);
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
