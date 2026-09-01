import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChildren } from '@angular/core';
import { Seccion } from '../anden.state';

export interface SegItem {
  key: Seccion;
  label: string;
  /** Pendientes de la sección. 0 + `on` = ✓. */
  pend: number;
  /** Habilitada. Caducidad y Ubicación no lo están hasta que se da acceso. */
  on: boolean;
  /** Terminada: contador a ✓. */
  done: boolean;
}

/**
 * Selector segmentado del Andén — patrón iOS: contenedor hundido, thumb elevado.
 *
 * **No es `PageTabs`.** Aquél navega entre rutas y filtra por permiso; esto es
 * estado de pantalla. El segmento activo **no va en la URL** a propósito: el vale
 * es el contexto y se conserva al saltar; si viviera en la ruta, el back del
 * navegador rompería el flujo a media captura.
 *
 * **Cada segmento lleva su contador**, así el trabajo que falta se ve sin entrar.
 * Y las secciones bloqueadas van **deshabilitadas, no ocultas**: el operario tiene
 * que ver que existen y qué le espera — no se puede fechar mercancía que todavía
 * no se corroboró contra Kepler.
 */
@Component({
  selector: 'app-anden-segmented',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="seg" role="tablist" aria-label="Secciones del andén">
      @for (t of items(); track t.key; let i = $index) {
        <button
          #btn
          type="button"
          role="tab"
          [attr.aria-selected]="activa() === t.key"
          [attr.tabindex]="activa() === t.key ? 0 : -1"
          [disabled]="!t.on"
          [class.is-on]="activa() === t.key"
          (click)="elegir.emit(t.key)"
          (keydown)="onKey($event, i)"
        >
          <span class="seg-l">{{ t.label }}</span>
          @if (t.done) {
            <span class="bdg done" aria-label="sin pendientes">✓</span>
          } @else if (t.pend > 0) {
            <span class="bdg" [attr.aria-label]="t.pend + ' pendientes'">{{ t.pend }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .seg {
      display: flex; gap: 2px; padding: 3px; margin-top: var(--sp-2);
      background: var(--surface-ground); border-radius: var(--r-md);
    }
    .seg button {
      flex: 1 1 0; min-width: 0; border: 0; background: none; font: inherit;
      font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-muted);
      /* 44px: la regla de --tap-min sólo sube en pointer:coarse, y esto se usa
         con guantes también en equipos que se declaran fine. */
      min-height: 44px; padding: var(--sp-1) var(--sp-1);
      border-radius: var(--r-sm); cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      transition: background var(--dur-short, 150ms) var(--ease-standard, ease), color 150ms;
    }
    .seg button.is-on {
      background: var(--card-bg); color: var(--text-main);
      box-shadow: 0 1px 3px rgb(0 0 0 / 12%);
    }
    .seg button:disabled { opacity: .45; cursor: not-allowed; }
    .seg button:focus-visible { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 1px; }
    .seg-l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bdg {
      flex: 0 0 auto; min-width: 17px; height: 17px; padding: 0 4px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--r-pill); font-size: var(--fs-micro); font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums;
      background: var(--action); color: var(--action-ink, #fff);
    }
    .seg button:disabled .bdg { background: var(--text-faint); }
    .bdg.done { background: var(--good-soft-bg, var(--surface-ground)); color: var(--good-fg, var(--text-muted)); }
    @media (prefers-reduced-motion: reduce) { .seg button { transition: none; } }
  `],
})
export class AndenSegmentedComponent {
  readonly items = input.required<SegItem[]>();
  readonly activa = input.required<Seccion>();
  readonly elegir = output<Seccion>();

  private readonly botones = viewChildren<ElementRef<HTMLButtonElement>>('btn');

  /** Flechas para moverse entre segmentos, saltando los deshabilitados. */
  onKey(ev: KeyboardEvent, i: number): void {
    const paso = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!paso) return;
    ev.preventDefault();
    const its = this.items();
    for (let n = 1; n <= its.length; n++) {
      const j = (i + paso * n + its.length * n) % its.length;
      if (!its[j].on) continue;
      this.elegir.emit(its[j].key);
      this.botones()[j]?.nativeElement.focus();
      return;
    }
  }
}
