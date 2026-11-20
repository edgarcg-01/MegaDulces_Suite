import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePickerModule } from 'primeng/datepicker';
import { PopoverModule } from 'primeng/popover';
import type { Popover } from 'primeng/popover';
import type { DatePickerDateMeta } from 'primeng/types/datepicker';

/**
 * `[PGP.176]` — **La semana se toca y abre dos meses: el brinco largo en tres clics.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * En el Calendario de pagos la única forma de cambiar de semana eran las flechas. Brincar del
 * 15-oct al 23-dic (diez semanas) costaba **11 clics y 10 lecturas** de la semana al servidor; con
 * esto son **3 clics** (abrir · mes siguiente · el día) **y 1 lectura**.
 *
 * Y había un defecto debajo: la etiqueta salía de la RESPUESTA del servidor, y cada clic nuevo
 * descarta la respuesta del anterior. Al dar diez clics seguidos la etiqueta se quedaba en
 * «12 oct – 18 oct» hasta que llegaba la última: se avanzaba a ciegas. Aquí la etiqueta se calcula
 * de la fecha elegida, al instante, con la MISMA regla que el servidor (`weekDates()`: lunes a
 * domingo).
 *
 * ── Qué hace y qué no ───────────────────────────────────────────────────────────────────────
 * Sólo la etiqueta y su calendario: las flechas y «Hoy» siguen en la pantalla que la usa. Tocar
 * un día emite ESE día (no el lunes): la tira se mueve a su semana con ese día abierto.
 * ⛔ Sin marcas de «tiene pagos» en el calendario: el servidor sólo da una semana a la vez, y
 * marcar las semanas que se conocen dejaría las demás pintadas como vacías sin haberlas medido
 * (ADR-056). Si hacen falta, piden su propia lectura de dos meses.
 *
 * Mismo patrón que la semana de Promociones (`mkt-ranking`, un mes); ésa puede adoptar esta pieza.
 */
@Component({
  selector: 'app-semana-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePickerModule, PopoverModule],
  template: `
    <button #lbl type="button" class="sp-lbl comm-num" (click)="alTocar($event, pop)"
            aria-haspopup="dialog" [attr.aria-expanded]="abierto()"
            [attr.aria-label]="'Semana del ' + etiqueta() + '. Abrir el calendario para brincar a otra fecha'">
      <span aria-live="polite">{{ etiqueta() }}</span>
      <i class="pi pi-calendar sp-ico" aria-hidden="true"></i>
    </button>
    <!-- En plantilla y no proyectado: el popover la crea en cada apertura. Proyectado, el calendario vivía
         siempre y recordaba el mes al que se navegó aunque no se eligiera nada. -->
    <!-- Lo de PrimeNG se ajusta con SUS tokens (dt) y su pass-through (pt), sin perforar su encapsulado (DESIGN.md §S). -->
    <p-popover #pop styleClass="sp-pop" [style]="angosto() ? margenAngosto : null" ariaLabel="Brincar a otra fecha"
               (onShow)="alAbrir()" (onHide)="alCerrar()">
      <ng-template #content>
        <p-datepicker #dp [inline]="true" [numberOfMonths]="mesesAhora()" [dt]="tokens" [pt]="pasoDirecto()"
                      [firstDayOfWeek]="1" [selectOtherMonths]="true" [ngModel]="valor()"
                      (onSelect)="elegido($event); pop.hide()" ariaLabel="Elige un día: se abre su semana, de lunes a domingo" />
        <p class="sp-pista">Toca un día: se abre su semana con ese día elegido.</p>
      </ng-template>
    </p-popover>
  `,
  styles: [`
    :host { display:inline-flex; }
    /* --tap-min: 0 con ratón, 44px con el dedo (medido en táctil: la etiqueta medía 24px de alto). */
    .sp-lbl { all:unset; box-sizing:border-box; display:inline-flex; align-items:center; gap:var(--sp-1);
      min-height:var(--tap-min); padding:2px var(--sp-1); border-radius:var(--r-sm); cursor:pointer; white-space:nowrap;
      font-size:var(--fs-sm); font-weight:600; color:var(--text-main); }
    .sp-lbl:hover { background:var(--overlay-hover); }
    .sp-lbl:active { background:var(--overlay-active); }
    .sp-lbl:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
    .sp-ico { font-size:var(--fs-xs); color:var(--text-muted); }
    .sp-pista { margin:var(--sp-1) 0 0; font-size:var(--fs-xs); color:var(--text-muted); }
  `],
})
export class SemanaPickerComponent {
  /** El día elegido (AAAA-MM-DD). La etiqueta dice su semana; el calendario abre en su mes. */
  readonly fecha = input.required<string>();
  /** Cuántos meses enseña el calendario. En pantallas angostas (40rem o menos) siempre uno. */
  readonly meses = input(2);
  /** El día que se tocó en el calendario (AAAA-MM-DD). */
  readonly elegir = output<string>();

  readonly abierto = signal(false);
  readonly etiqueta = computed(() => etiquetaSemana(this.fecha()));
  readonly valor = computed(() => isoAFecha(this.fecha()));
  private readonly semana = computed(() => semanaDe(this.fecha()));
  /**
   * Dos meses no caben en un celular: ahí, uno. ⛔ No con `responsiveOptions` de PrimeNG: en la v22 su CSS
   * apunta a `.p-datepicker-group` y `.p-datepicker-next`, que ya no existen (son `-calendar` y `-next-button`),
   * y no hace NADA — medido a 390 px: salían los dos meses, el segundo cortado y su «Mes siguiente» fuera de la
   * pantalla. Se decide al abrir: el calendario nace con cada apertura, con el número de meses que cabe.
   */
  readonly angosto = signal(false);
  readonly mesesAhora = computed(() => (this.angosto() ? 1 : this.meses()));
  /**
   * En angosto PrimeNG recorre el globo hasta `left:0` cuando no cabe junto a la etiqueta (medido a 390 px): pegado
   * al borde. El margen lo separa 1rem sin pelear su posición con `!important`.
   */
  readonly margenAngosto = { 'margin-inline-start': 'var(--sp-4)' };

  /**
   * Los tokens del DatePicker, apoyados en `--tap-min` (0 con ratón, 44px con el dedo):
   * · un solo marco: el globo ya es la caja; el borde y el relleno del panel eran una caja dentro de otra;
   * · el día, a 44px con el dedo (medido: 28) y a su 1.75rem con ratón;
   * · el relleno de 0.25rem de la celda, a 0 con el dedo: a 44px el globo medía 408px en un celular de 390 y 793 en el
   *   Fold de 750. `calc(0.25rem - min(0.25rem, --tap-min))` da 0.25rem con ratón y 0 con el dedo.
   */
  readonly tokens = {
    panel: { borderColor: 'transparent', padding: '0' },
    date: {
      width: 'max(1.75rem, var(--tap-min))',
      height: 'max(1.75rem, var(--tap-min))',
      padding: 'calc(0.25rem - min(0.25rem, var(--tap-min)))',
    },
  };

  /**
   * El pass-through: la semana a la vista como una banda (dónde estás antes de brincar), redondeada en el lunes y el
   * domingo, y las flechas de mes a 44px con el dedo (medidas: 36).
   */
  readonly pasoDirecto = computed(() => {
    const s = this.semana();
    const flecha = { root: { style: { 'min-width': 'var(--tap-min)', 'min-height': 'var(--tap-min)' } } };
    return {
      pcPrevButton: flecha,
      pcNextButton: flecha,
      dayCell: (o: { context?: { date?: DatePickerDateMeta } }) => {
        const d = o?.context?.date;
        if (!d) return {};
        const k = `${d.year}-${dos(d.month + 1)}-${dos(d.day)}`;
        if (k < s.desde || k > s.hasta) return {};
        const radio = k === s.desde ? 'var(--r-pill) 0 0 var(--r-pill)' : k === s.hasta ? '0 var(--r-pill) var(--r-pill) 0' : '0';
        return { style: { background: 'var(--overlay-selected)', 'border-radius': radio } };
      },
    };
  });

  private readonly dp = viewChild('dp', { read: ElementRef });
  private readonly lbl = viewChild<ElementRef<HTMLButtonElement>>('lbl');

  /**
   * Al cerrar (Esc, elegir un día, tocar fuera), el foco vuelve a la etiqueta si se quedó sin lugar: medido en la
   * prueba visual, tras Esc caía en el body y quien va con teclado volvía a empezar desde arriba. Si la persona
   * tocó otro control, se respeta.
   */
  alCerrar(): void {
    this.abierto.set(false);
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.closest('.sp-pop')) this.lbl()?.nativeElement.focus({ preventScroll: true });
    });
  }

  alTocar(ev: Event, pop: Popover): void {
    this.angosto.set(typeof matchMedia === 'function' && matchMedia('(max-width: 40rem)').matches);
    pop.toggle(ev);
  }

  elegido(f: Date): void {
    const iso = fechaAIso(f);
    if (iso !== this.fecha()) this.elegir.emit(iso);
  }

  /**
   * El popover vive en el body: sin esto, quien llega con el teclado se queda en la etiqueta y no alcanza los días.
   * El día de PrimeNG es un `<span>` que no trae `tabindex` hasta que se navega (medido en la prueba visual: el
   * foco se quedaba en la etiqueta), así que se le da antes de enfocarlo; sus flechas y Enter ya son de PrimeNG.
   * Se reintenta unos cuadros porque el calendario nace con la apertura.
   */
  alAbrir(): void {
    this.abierto.set(true);
    let intentos = 0;
    const enfocar = () => {
      const el = this.dp()?.nativeElement as HTMLElement | undefined;
      const dia = el?.querySelector<HTMLElement>('.p-datepicker-day-selected');
      if (dia) { dia.tabIndex = 0; dia.focus(); return; }
      if (++intentos < 20) requestAnimationFrame(enfocar);
    };
    requestAnimationFrame(enfocar);
  }
}

const dos = (n: number) => String(n).padStart(2, '0');
const FMT_DIA_MES = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const FMT_DIA_MES_ANO = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Lunes y domingo de la semana que contiene `iso`: la MISMA regla que `weekDates()` del servidor. */
export function semanaDe(iso: string): { desde: string; hasta: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const lunes = new Date(base);
  lunes.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7));
  const domingo = new Date(lunes);
  domingo.setUTCDate(lunes.getUTCDate() + 6);
  return { desde: lunes.toISOString().slice(0, 10), hasta: domingo.toISOString().slice(0, 10) };
}

/** «16 nov – 22 nov 2026»: la misma forma que tenía la etiqueta de la semana. */
export function etiquetaSemana(iso: string): string {
  const { desde, hasta } = semanaDe(iso);
  return `${FMT_DIA_MES.format(new Date(desde + 'T12:00:00Z'))} – ${FMT_DIA_MES_ANO.format(new Date(hasta + 'T12:00:00Z'))}`;
}

/** El calendario trabaja en hora local: a mediodía, para que ningún huso mueva el día. */
export function isoAFecha(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function fechaAIso(f: Date): string {
  return `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
}
