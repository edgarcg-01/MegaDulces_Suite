import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';


export interface SegOption { label: string; value: string; }

/**
 * Segmented control canónico (Operations). Track + pill activo, radiogroup accesible.
 * Reemplaza las 3 implementaciones ad-hoc (.co-segment / .so-segment / historical).
 *
 * **Teclado (SM.30).** Era un `role="radiogroup"` que sólo respondía al click, y
 * eso es un radiogroup a medias: el patrón ARIA manda que las flechas muevan la
 * selección, y además **el tabulador debe ver UN solo stop** por grupo, no uno
 * por opción. Sin eso, en el arqueo había que dar tres Tab para cruzar las tres
 * pestañas antes de llegar al primer campo — con las manos en el efectivo.
 *
 *   ← ↑     opción anterior (circular)
 *   → ↓     opción siguiente (circular)
 *   Home    primera · End última
 *
 * La selección se mueve CON el foco (es lo estándar en un radiogroup: no hay
 * "enfocado pero no elegido"), así que cambiar de pestaña con flechas es un solo
 * gesto. `saltarAbajo` deja que el padre siga la cadena hacia el siguiente
 * bloque; si nadie lo escucha, `↓` simplemente avanza dentro del grupo.
 */
@Component({
  selector: 'app-segmented',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="seg" role="radiogroup" [attr.aria-label]="ariaLabel()" #grupo>
      @for (o of options(); track o.value) {
        <!-- El tabindex por opcion (0 solo en la activa) es lo que convierte al
             grupo en UN stop de tabulador en vez de uno por boton. -->
        <button type="button" role="radio" [attr.aria-checked]="value() === o.value"
                [attr.tabindex]="value() === o.value ? 0 : -1"
                class="seg-btn" [class.on]="value() === o.value"
                (keydown)="onKey($event)"
                (click)="pick(o.value)">{{ o.label }}</button>
      }
    </div>
  `,
  styles: [`
    /* flex-wrap + max-width:100%: las etiquetas no se cortan, asi que en un
       telefono tres opciones se salian del contenedor. Envolviendo, el track se
       parte en dos renglones y el control nunca es mas ancho que su padre. */
    .seg { display:inline-flex; align-items:stretch; flex-wrap:wrap; max-width:100%; background:var(--layout-bg); border:1px solid var(--border-color); border-radius:var(--r-sm,8px); padding:2px; gap:2px; }
    .seg-btn { border:0; background:transparent; padding:.4rem .7rem; font-size:var(--fs-xs,.8rem); font-weight:600; color:var(--text-muted); cursor:pointer; border-radius:6px; white-space:nowrap; transition:color 120ms var(--ease-standard), background 120ms var(--ease-standard); }
    .seg-btn:hover { color:var(--text-main); }
    .seg-btn.on { background:var(--card-bg); color:var(--text-main); box-shadow:0 1px 2px rgba(0,0,0,.08); }

    /* Touch: 31px de alto es la mitad del minimo de Fitts (DESIGN §11). En el
       arqueo estas pestanas eligen si el corte es cierre o relevo — errarle con
       el pulgar cambia QUE se esta sellando.

       Solo el ALTO. Estirarlas a lo ancho tambien se veia bien en el arqueo,
       pero este control lo usan 14 pantallas mas y, en un contenedor de flujo,
       pasar de inline-flex a flex les da renglon propio: eso lo decide cada
       pagina desde su contenedor, no el control. */
    @media (pointer: coarse) {
      .seg-btn { min-height:var(--tap-min, 44px); padding:.55rem .8rem; }
    }
  `],
})
export class SegmentedComponent {
  readonly options = input<SegOption[]>([]);
  readonly value = input<string>('');
  readonly ariaLabel = input<string>('');
  readonly valueChange = output<string>();
  /** `↓` en la última opción: el padre encadena al bloque siguiente si quiere. */
  readonly saltarAbajo = output<void>();

  private readonly grupo = viewChild<ElementRef<HTMLElement>>('grupo');

  pick(v: string): void { if (v !== this.value()) this.valueChange.emit(v); }

  onKey(ev: KeyboardEvent): void {
    const ops = this.options();
    if (!ops.length) return;

    const i = Math.max(0, ops.findIndex((o) => o.value === this.value()));
    let destino: number | null = null;

    switch (ev.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        destino = (i - 1 + ops.length) % ops.length;
        break;
      case 'ArrowRight':
        destino = (i + 1) % ops.length;
        break;
      case 'ArrowDown':
        // En la última opción, ↓ sale del grupo (el padre encadena). Adentro,
        // avanza como →. Así el mismo ↓ sirve para recorrer y para salir.
        if (i === ops.length - 1) { ev.preventDefault(); this.saltarAbajo.emit(); return; }
        destino = i + 1;
        break;
      case 'Home':
        destino = 0;
        break;
      case 'End':
        destino = ops.length - 1;
        break;
      default:
        return; // Enter y espacio son la activación nativa del botón: no se tocan.
    }

    ev.preventDefault();
    if (destino === i) return;
    this.pick(ops[destino].value);
    // El `tabindex` se recalcula cuando el padre devuelve el `value` nuevo, así
    // que el foco se mueve en el próximo tick — si no, se enfoca el botón que
    // todavía tiene tabindex -1.
    const btns = this.grupo()?.nativeElement.querySelectorAll<HTMLButtonElement>('.seg-btn');
    if (btns?.[destino]) setTimeout(() => btns[destino].focus(), 0);
  }
}
