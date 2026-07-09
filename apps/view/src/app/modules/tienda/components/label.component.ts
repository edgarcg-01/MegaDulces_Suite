import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input,
  OnChanges, ViewChild, ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import JsBarcode from 'jsbarcode';

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
}

/**
 * Etiqueta de anaquel Mega Dulces (100×40 mm) — diseño congelado (ver etiqueta-preview.html).
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
    @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&display=swap');
    .etq-label{
      --green:hsl(141,76%,16%); --yellow:#f6c400; --cream:#f8f6ea;
      --font:'Baloo 2',system-ui,sans-serif; --font-num:'Impact','Haettenschweiler','Anton','Arial Narrow',sans-serif;
      width:100mm; height:40mm; background:var(--cream); border-radius:3mm; overflow:hidden;
      font-family:var(--font); color:var(--green); display:flex; flex-direction:column;
      -webkit-print-color-adjust:exact; print-color-adjust:exact;
    }
    .etq-label *{ box-sizing:border-box; margin:0; padding:0; }
    .etq-head{ background:var(--green); color:#fff; height:7.4mm; min-height:7.4mm; display:flex; align-items:center;
      padding:0 3mm; font-weight:800; font-size:3.7mm; letter-spacing:.2px; white-space:nowrap; overflow:hidden;
      text-overflow:ellipsis; text-transform:uppercase; }
    .etq-body{ flex:1; min-height:0; display:flex; padding:1mm 2mm 1.2mm 2mm; gap:2mm; }
    .etq-left{ width:56mm; display:flex; flex-direction:column; }
    .etq-meta{ display:flex; align-items:center; gap:1.6mm; font-weight:800; font-size:3.4mm; margin-bottom:1mm; }
    .etq-meta svg{ width:4mm; height:4mm; }
    .etq-meta .sep{ color:var(--green); }
    .etq-pricebox{ flex:1; position:relative; background:var(--yellow); border-radius:2.4mm; display:flex;
      align-items:center; justify-content:center; padding:1.5mm 1.5mm 6mm; overflow:hidden; }
    .etq-pricebox::before{ content:""; position:absolute; inset:1mm 1mm 6mm 1mm; border:.28mm dashed var(--green);
      border-bottom:0; border-radius:1.8mm 1.8mm 0 0; pointer-events:none; }
    .etq-sprout{ position:absolute; top:1mm; left:2mm; width:5.4mm; height:5.4mm; }
    .etq-price{ font-family:var(--font-num); font-weight:400; font-size:19mm; line-height:.82; letter-spacing:0;
      transform:scaleX(1.1); transform-origin:center; }
    .etq-price .cur{ font-size:.5em; vertical-align:.6em; margin-right:.3mm; }
    .etq-price .dot{ font-size:.78em; }
    .etq-pieza{ position:absolute; left:0; right:0; bottom:0; background:var(--green); color:#fff; height:5.2mm;
      display:flex; align-items:center; justify-content:center; gap:2mm; font-weight:800; font-size:3mm; border-radius:0 0 2mm 2mm; }
    .etq-pieza::before,.etq-pieza::after{ content:""; width:13mm; height:.9mm;
      background:repeating-linear-gradient(90deg, var(--yellow) 0 2.8mm, transparent 2.8mm 4.6mm); }
    .etq-right{ width:42mm; min-height:0; display:flex; flex-direction:column; }
    .etq-tier{ position:relative; display:flex; align-items:center; gap:1mm; padding:.3mm 0; flex:1; min-height:0; }
    .etq-tier::before{ content:""; position:absolute; top:0; left:0; right:0; height:.28mm;
      background:repeating-linear-gradient(90deg, var(--green) 0 .32mm, transparent .32mm .6mm); }
    .etq-tier:first-child::before{ display:none; }
    .etq-pill{ background:var(--green); color:#fff; width:7.4mm; min-width:7.4mm; height:4.7mm; border-radius:1.3mm;
      display:flex; flex-direction:column; align-items:center; justify-content:flex-start; padding-top:.75mm; gap:.15mm; }
    .etq-pill svg{ width:2.8mm; height:2.2mm; }
    .etq-pill span{ font-size:1.2mm; font-weight:800; letter-spacing:.1px; }
    .etq-tier .txt{ flex:1; font-size:1.85mm; font-weight:600; line-height:1.04; }
    .etq-tier .amt{ font-family:var(--font-num); font-weight:400; font-size:3.9mm; white-space:nowrap; letter-spacing:.2px; }
    .etq-tier .amt small{ font-family:var(--font); font-size:1.5mm; font-weight:400; }
    .etq-barcode{ margin-top:.3mm; display:flex; justify-content:flex-end; }
    .etq-barcode svg{ display:block; width:85%; height:5.2mm; }
    .etq-barcode.empty{ height:5.2mm; }
  `],
  template: `
    <div class="etq-label">
      <div class="etq-head">{{ headName }}</div>
      <div class="etq-body">
        <div class="etq-left">
          <div class="etq-meta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><path d="M6.5 8a2 2 0 0 0-1.9 1.46L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.9-2.54L19.4 9.5A2 2 0 0 0 17.5 8Z"/></svg>
            @if (model.content) { <span>{{ model.content }}</span><span class="sep">|</span> }
            <span>Código: {{ model.sku }}</span>
          </div>
          <div class="etq-pricebox">
            <svg class="etq-sprout" viewBox="0 0 40 40" fill="hsl(141, 60%, 38%)"><path transform="translate(12,15) rotate(120)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/><path transform="translate(22,10) rotate(150) scale(0.7)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/></svg>
            <div class="etq-price"><span class="cur">$</span>{{ pieceInt }}<span class="dot">.</span>{{ pieceDec }}</div>
            <div class="etq-pieza">Precio por pieza</div>
          </div>
        </div>
        <div class="etq-right">
          <div class="etq-tier">
            <div class="etq-pill"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.7a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/></svg><span>MAYOREO</span></div>
            <div class="txt">Mayoreo desde {{ mayoreoMin }} pzas:</div>
            <div class="amt">\${{ (model.wholesale_piece_price ?? 0) | number:'1.2-2' }} <small>c/u</small></div>
          </div>
          <div class="etq-tier">
            <div class="etq-pill"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg><span>PAQUETE</span></div>
            <div class="txt">Paquete ({{ model.pack_size }} pzas):</div>
            <div class="amt">\${{ (model.pack_price ?? 0) | number:'1.2-2' }}</div>
          </div>
          <div class="etq-tier">
            <div class="etq-pill"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.7a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/></svg><span>MAYOREO</span></div>
            <div class="txt">Mayoreo desde {{ mayoreoMin }} paquetes:</div>
            <div class="amt">\${{ (model.wholesale_pack_price ?? 0) | number:'1.2-2' }} <small>c/u</small></div>
          </div>
          <div class="etq-tier">
            <div class="etq-pill"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m3 9 2.45-4.9A2 2 0 0 1 7.24 3h9.52a2 2 0 0 1 1.8 1.1L21 9"/><path d="M12 3v6"/></svg><span>CAJA</span></div>
            <div class="txt">Caja ({{ model.box_size }} pzas):</div>
            <div class="amt">\${{ (model.box_price ?? 0) | number:'1.2-2' }}</div>
          </div>
          <div class="etq-barcode" [class.empty]="!model.barcode_format"><svg #bc></svg></div>
        </div>
      </div>
    </div>
  `,
})
export class LabelComponent implements AfterViewInit, OnChanges {
  @Input({ required: true }) model!: LabelModel;
  @ViewChild('bc') bc?: ElementRef<SVGElement>;

  get headName(): string {
    // El nombre en Kepler a veces trae el gramaje/pack ("…50G/8 CANELS"); lo dejamos tal cual
    // salvo el sufijo de gramaje que ya se muestra aparte.
    return (this.model?.name || '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:kg|g|gr|grs|ml|l)\s*\/?\s*\d*\s*$/i, '').trim() || this.model?.name || '';
  }
  get mayoreoMin(): number { return this.model?.wholesale_piece_min_qty || 3; }
  private get pieceStr(): string { return (this.model?.piece_price ?? 0).toFixed(2); }
  get pieceInt(): string { return this.pieceStr.split('.')[0]; }
  get pieceDec(): string { return this.pieceStr.split('.')[1] ?? '00'; }

  ngAfterViewInit(): void { this.renderBarcode(); }
  ngOnChanges(): void { queueMicrotask(() => this.renderBarcode()); }

  private renderBarcode(): void {
    const el = this.bc?.nativeElement;
    if (!el) return;
    el.innerHTML = '';
    const code = this.model?.barcode;
    const fmt = this.model?.barcode_format;
    if (!code || !fmt) return; // no dibujar códigos inválidos (Kepler traía basura)
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
