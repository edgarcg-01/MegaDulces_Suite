import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, computed, effect, input, output, signal, viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import JsBarcode from 'jsbarcode';
import { printIsolated } from '../../../../shared/util/print-isolated';

export interface CartelUbicacion {
  /** El código que se escanea. Es el mismo `warehouse_bins.code`. */
  code: string;
  /** Lo que lee un humano: "Rack 12", "Tarima 3". */
  label: string | null;
  /** Código del almacén, para que un cartel no termine pegado en la bodega de al lado. */
  almacen: string | null;
}

/** Píxeles por módulo del CODE128. Ancho para que el símbolo aguante impreso a 14 cm. */
const MODULO_PX = 2;

/**
 * Andén · **el cartel de la ubicación nueva**.
 *
 * La ubicación no existe de verdad hasta que hay un papel pegado en el rack: el
 * andén la da de alta en la base, pero el bodeguero la encuentra —y la pistola la
 * lee— gracias a este cartel. Por eso imprimirlo es parte de crearla, no un extra.
 *
 * **Media carta, dos por hoja.** El código va del tamaño de la hoja porque se lee
 * caminando por el pasillo, y abajo el **CODE128** del mismo código para que la
 * misma pistola que escanea la caja escanee el rack. Un cartel sin barras
 * obligaría a teclear, que es justo lo que el andén evita.
 *
 * El símbolo se dibuja con JsBarcode y se le arregla el `viewBox` a mano: la
 * librería escribe `width="226px"` (con unidad) y un `viewBox` lleva NÚMEROS.
 * Copiar el texto tal cual deja `viewBox="0 0 226px 98px"`, que Chrome descarta
 * — el símbolo se dibuja a su tamaño natural y `overflow:hidden` le come los
 * módulos de la derecha. **En pantalla se ve igual; sólo falla impreso.** Es el
 * mismo defecto que la etiquetera midió en la Fase ETQ.
 */
@Component({
  selector: 'app-anden-cartel',
  standalone: true,
  imports: [ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ct">
      <p class="ct-nota">
        Pegá el cartel en {{ uno() ? 'la ubicación' : 'cada ubicación' }} antes de acomodar.
        Salen <b>dos por hoja</b>; recortá por la línea punteada.
      </p>

      <!-- Vista previa: el MISMO markup que se imprime, a escala. Imprimir algo
           distinto de lo que se vio en pantalla es como se cuelan los carteles con
           el código recortado. -->
      <div class="ct-prev" #hoja>
        @for (u of ubicaciones(); track u.code) {
          <article class="ct-cartel">
            <div class="ct-tipo">{{ u.label || 'Ubicación' }}</div>
            <div class="ct-code">{{ u.code }}</div>
            <svg class="ct-bar" [attr.data-code]="u.code"></svg>
            <div class="ct-pie">
              <span>{{ u.almacen || '' }}</span>
              <span>{{ hoy() }}</span>
            </div>
          </article>
        }
      </div>

      <div class="ct-acciones">
        <button pButton type="button" class="ct-go" [loading]="imprimiendo()" (click)="imprimir()">
          {{ textoBoton() }}
        </button>
        <button pButton type="button" [text]="true" severity="secondary" (click)="cerrar.emit()">
          Seguir sin imprimir
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ct { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ct-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .ct-nota b { color: var(--text-main); }

    /* Vista previa con la proporción REAL de media carta (215.9 × 139.7 mm), así
       lo que se ve en el teléfono es lo que sale de la impresora. El cartel se
       pinta en blanco y negro aunque la app esté en oscuro: se imprime en papel. */
    .ct-prev { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ct-cartel {
      aspect-ratio: 215.9 / 139.7;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2%; padding: 4% 5%;
      background: #fff; color: #111;
      border: 1px solid var(--border-color); border-radius: var(--r-sm);
      overflow: hidden;
    }
    .ct-tipo {
      font-size: clamp(9px, 3.4vw, 20px); font-weight: var(--fw-bold);
      letter-spacing: .14em; text-transform: uppercase; color: #444; line-height: 1;
    }
    .ct-code {
      font-size: clamp(34px, 15vw, 120px); font-weight: 900; line-height: .95;
      letter-spacing: -.01em; font-variant-numeric: tabular-nums; text-align: center;
      overflow-wrap: anywhere;
    }
    .ct-bar { display: block; width: 64%; height: 15%; }
    .ct-pie {
      display: flex; justify-content: space-between; width: 100%;
      font-size: clamp(8px, 2.6vw, 14px); color: #555; font-variant-numeric: tabular-nums;
    }
    .ct-acciones { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ct-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
  `],
})
export class AndenCartelComponent implements AfterViewInit {
  readonly ubicaciones = input.required<CartelUbicacion[]>();
  readonly cerrar = output<void>();

  readonly imprimiendo = signal(false);
  private readonly hoja = viewChild<ElementRef<HTMLElement>>('hoja');

  readonly uno = computed(() => this.ubicaciones().length === 1);
  readonly hoy = computed(() =>
    new Date().toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  );

  readonly textoBoton = computed(() => {
    if (this.imprimiendo()) return 'Preparando…';
    const n = this.ubicaciones().length;
    return n === 1 ? 'Imprimir el cartel' : `Imprimir los ${n} carteles`;
  });

  constructor() {
    // Redibuja el símbolo cuando cambia la lista (se crea otra ubicación sin salir
    // de la pantalla). `queueMicrotask` espera a que Angular haya pintado el @for.
    effect(() => {
      this.ubicaciones();
      queueMicrotask(() => this.dibujar());
    });
  }

  ngAfterViewInit(): void { this.dibujar(); }

  private dibujar(): void {
    const raiz = this.hoja()?.nativeElement;
    if (!raiz) return;
    raiz.querySelectorAll<SVGElement>('svg.ct-bar').forEach((el) => {
      const code = el.getAttribute('data-code') || '';
      if (!code) return;
      try {
        JsBarcode(el, code, {
          format: 'CODE128', displayValue: false, width: MODULO_PX, height: 90,
          marginTop: 0, marginBottom: 0, marginLeft: 10 * MODULO_PX, marginRight: 10 * MODULO_PX,
        });
        const w = parseFloat(el.getAttribute('width') || '');
        const h = parseFloat(el.getAttribute('height') || '');
        if (w > 0 && h > 0) {
          el.setAttribute('viewBox', `0 0 ${w} ${h}`);
          el.setAttribute('preserveAspectRatio', 'none');
          el.removeAttribute('width');
          el.removeAttribute('height');
        }
      } catch {
        /* Un código que CODE128 no puede representar sale sin barras, no rompe el cartel. */
      }
    });
  }

  imprimir(): void {
    const raiz = this.hoja()?.nativeElement;
    if (!raiz || this.imprimiendo()) return;
    this.imprimiendo.set(true);
    printIsolated({
      html: raiz.innerHTML,
      // Se imprime en hoja CARTA con dos carteles por página y se corta a la mitad:
      // pedir papel "half letter" sería pedir un insumo que la bodega no tiene.
      page: 'size: letter portrait; margin: 0;',
      css: [
        'body{margin:0}',
        // `box-sizing` incluido a propósito: sin él el padding empuja el segundo
        // cartel a la hoja siguiente y salen el doble de páginas, la mitad en blanco.
        '.ct-cartel{box-sizing:border-box;width:215.9mm;height:139.7mm;aspect-ratio:auto;',
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4mm;',
        'padding:10mm 12mm;background:#fff;color:#111;border:0;border-radius:0;',
        'outline:.3mm dashed #999;outline-offset:-2mm;break-inside:avoid;page-break-inside:avoid;overflow:hidden}',
        '.ct-tipo{font-size:10mm;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#444;line-height:1}',
        '.ct-code{font-size:48mm;font-weight:900;line-height:.95;text-align:center;overflow-wrap:anywhere}',
        '.ct-bar{display:block;width:140mm;height:22mm}',
        '.ct-pie{display:flex;justify-content:space-between;width:100%;font-size:5mm;color:#555}',
      ].join(''),
      bodyClass: 'anden-cartel-printing',
      fallbackClass: 'anden-cartel-fallback',
      onDone: () => this.imprimiendo.set(false),
    });
  }
}
