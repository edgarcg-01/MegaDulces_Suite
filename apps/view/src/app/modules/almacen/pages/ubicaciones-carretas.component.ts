import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { CART_KINDS, CART_NUM_MAX, describeCart, type CartKind, type CartRow, type CartsResponse } from '@megadulces/contracts';
import { AlmacenCarretasService } from '../almacen-carretas.service';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { AndenCartelComponent, type CartelUbicacion } from '../anden/components/anden-cartel.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

/**
 * `[GP.11.5]` Ubicaciones › Carretas: el catálogo de carretas y carritos del almacén (FASE_GP D6), el alta
 * por rango con sus carteles, y qué pedido trae cada una. Vive en el Mapa (`?vista=carretas`), como la
 * captura masiva: es el mismo catálogo (FASE_UB D8), no una pantalla nueva.
 *
 * Las cinco preguntas (skill `diseno` §0b):
 *  1. Qué ve y en qué orden: cuántas libres y cuántas con pedido; luego cada una, con su pedido, de quién
 *     y desde cuándo. Quien gestiona, arriba, «Dar de alta» por rango.
 *  2. Qué no ve: el detalle del pedido (vive en el Tablero).
 *  3. Accesibilidad: el estado va en palabras («Libre», «Con PD-…»), no en color; botones de 44 px.
 *  4. Ligas: Surtir las ocupa; el checado las escanea; aquí el coordinador libera una a mano (provisional
 *     hasta que el embarque la libere al cargar, D22).
 *  5. ¿Le toca? Sí: es el catálogo del almacén.
 */
@Component({
  selector: 'app-ubicaciones-carretas',
  standalone: true,
  imports: [FormsModule, ButtonModule, SegmentedComponent, AndenCartelComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (carteles().length) {
      <section class="ca-block" aria-label="Carteles de carretas para imprimir">
        <app-anden-cartel [ubicaciones]="carteles()" formato="cartel" (cerrar)="carteles.set([])" />
      </section>
    }

    <section class="ca-block" aria-labelledby="ca-h">
      <div class="ca-head">
        <h2 id="ca-h" class="ca-h2">Carretas y carritos</h2>
        <!-- §9: la ocupación cambia a cada rato; se dice de cuándo es lo que se ve. -->
        <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        @if (data()?.carretas?.length) {
          <button pButton type="button" class="p-button-sm p-button-outlined ca-tap" (click)="imprimir(data()!.carretas)"><span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">Imprimir los {{ data()!.carretas.length }} carteles</span></button>
        }
      </div>
      <!-- Q.1: la respuesta primero — cuántas hay para tomar y cuántas traen pedido. -->
      @if (kpis().length) { <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Carretas del almacén" /> }

      @if (puedeGestionar()) {
        <form class="ca-alta" (ngSubmit)="darDeAlta()" aria-label="Dar de alta carretas por rango">
          <app-segmented [options]="tipos" [value]="tipo()" (valueChange)="tipo.set($any($event))" ariaLabel="Tipo" />
          <label class="ca-f"><span class="ca-l">Del número</span><input name="desde" type="number" inputmode="numeric" min="1" [max]="max" class="ca-in" [ngModel]="desde()" (ngModelChange)="desde.set($event)" /></label>
          <label class="ca-f"><span class="ca-l">al</span><input name="hasta" type="number" inputmode="numeric" min="1" [max]="max" class="ca-in" [ngModel]="hasta()" (ngModelChange)="hasta.set($event)" /></label>
          <button pButton type="submit" class="ca-tap" [loading]="ocupado()" [disabled]="!rangoValido()"><span class="p-button-label">Dar de alta</span></button>
        </form>
        <p class="ca-hint">Carretas y carritos comparten numeración (C01 a C{{ max }}): Kepler guarda la carreta en una sola columna.</p>
      }

      <p class="ca-msg" [class.ca-mal]="aviso()?.mal" aria-live="polite">{{ aviso()?.texto ?? '' }}</p>

      <!-- §2: cargando, vacío y error se distinguen (y el error deja reintentar). -->
      <app-load-state [loading]="!data() && !error()" [error]="error()" errorTitle="No se pudieron leer las carretas" [skeletonRows]="3"
                      [isEmpty]="!!data() && !data()!.carretas.length" emptyIcon="pi-shopping-cart" emptyTitle="Todavía no hay carretas"
                      [emptyHint]="(warehouse().name) + ' todavía no tiene carretas dadas de alta. Mientras no haya, Surtir trabaja sin carreta.'" (retry)="cargar()">
        @if (data(); as d) {
          <ul class="ca-lista">
            @for (c of d.carretas; track c.id) {
              <li class="ca-fila">
                <span class="ca-code mono">{{ c.code + ' ' }}</span>
                <span class="ca-nombre">{{ nombre(c) + ' ' }}</span>
                <span class="ca-estado">{{ estado(c) }}</span>
                @if (c.ocupacion && puedeCoordinar()) {
                  @if (liberar() === c.id) {
                    <span class="ca-btns">
                      <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ca-tap" (click)="liberar.set(null)"><span class="p-button-label">No</span></button>
                      <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger ca-tap" [loading]="ocupado()" [attr.aria-label]="'Sí, liberar ' + c.code" (click)="confirmarLiberar(c)"><span class="p-button-label">Sí, liberar</span></button>
                    </span>
                  } @else {
                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ca-tap" [attr.aria-label]="'Liberar ' + c.code" (click)="liberar.set(c.id)"><span class="p-button-label">Liberar</span></button>
                  }
                }
              </li>
            }
          </ul>
        }
      </app-load-state>
    </section>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    /* En angosto (celular, panel lateral): el estado baja a su propio renglón. */
    @container (max-width: 30rem) {
      .ca-fila { grid-template-columns: 3.5rem 1fr auto; }
      .ca-estado { grid-column: 1 / -1; }
    }
    .ca-block { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); margin-bottom: var(--sp-3); }
    .ca-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); }
    .ca-h2 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .ca-hint { font-size: var(--fs-sm); color: var(--text-muted); }
    .ca-hint { margin: 0; }
    .ca-alta { display: flex; flex-wrap: wrap; align-items: end; gap: var(--sp-2); }
    .ca-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ca-l { font-size: var(--fs-xs); color: var(--text-muted); }
    .ca-in { width: 6rem; min-height: 44px; padding: 0 var(--sp-2); font-variant-numeric: tabular-nums; }
    .ca-tap { min-height: 44px; }
    .ca-msg { margin: 0; min-height: 1.4em; font-size: var(--fs-sm); }
    .ca-mal { color: var(--bad-soft-fg); }
    .ca-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .ca-fila { display: grid; grid-template-columns: 3.5rem 7rem 1fr auto; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); }
    .ca-code { font-weight: var(--fw-bold); }
    .ca-estado { font-size: var(--fs-sm); }
    .ca-btns { display: inline-flex; gap: var(--sp-1); }
  `],
})
export class UbicacionesCarretasComponent {
  private readonly api = inject(AlmacenCarretasService);

  readonly warehouse = input.required<{ id: string; code: string; name: string }>();
  readonly puedeGestionar = input(false);
  readonly puedeCoordinar = input(false);

  readonly max = CART_NUM_MAX;
  readonly tipos: SegOption[] = CART_KINDS.map((k) => ({ label: `${k.label}s (${k.para})`, value: k.key }));
  readonly data = signal<CartsResponse | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  /** Q.1: libres para tomar, con pedido y fuera de uso (bloqueadas o dadas de baja). */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d?.carretas.length) return [];
    const fuera = d.carretas.filter((c) => c.estado !== 'activa').length;
    return [
      { label: 'Libres', value: d.libres, sub: 'para tomar' },
      { label: 'Con pedido', value: d.ocupadas, sub: 'ocupadas' },
      { label: 'Fuera de uso', value: fuera, sub: 'bloqueadas o de baja' },
    ];
  });
  readonly error = signal<string | null>(null);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly tipo = signal<CartKind>('carreta');
  readonly desde = signal<number | null>(1);
  readonly hasta = signal<number | null>(null);
  readonly ocupado = signal(false);
  readonly liberar = signal<string | null>(null);
  readonly carteles = signal<CartelUbicacion[]>([]);
  readonly rangoValido = computed(() => {
    const d = Number(this.desde()), h = Number(this.hasta());
    return Number.isInteger(d) && Number.isInteger(h) && d >= 1 && h <= CART_NUM_MAX && d <= h;
  });
  private folio = 0;

  constructor() {
    effect(() => {
      if (this.warehouse()?.id) void this.cargar();
    });
  }

  nombre(c: CartRow): string { return describeCart(c.tipo, c.numero); }

  estado(c: CartRow): string {
    if (c.estado !== 'activa') return `${c.estado === 'baja' ? 'Dada de baja' : 'Bloqueada'}${c.motivo_estado ? ` (${c.motivo_estado})` : ''}`;
    if (!c.ocupacion) return 'Libre';
    return `Con ${c.ocupacion.pedido} · ${c.ocupacion.occupied_by_name} desde las ${horaMx(c.ocupacion.occupied_at)}`;
  }

  async cargar(): Promise<void> {
    const folio = ++this.folio;
    this.error.set(null);
    try {
      const d = await firstValueFrom(this.api.list(this.warehouse().id));
      if (folio === this.folio) { this.data.set(d); this.cargadoEn.set(new Date()); }
    } catch (e) {
      if (folio === this.folio) this.error.set(mensaje(e, 'No se pudieron leer las carretas.'));
    }
  }

  async darDeAlta(): Promise<void> {
    if (!this.rangoValido() || this.ocupado()) return;
    this.ocupado.set(true);
    try {
      const r = await firstValueFrom(this.api.bulk({ warehouse_id: this.warehouse().id, tipo: this.tipo(), desde: Number(this.desde()), hasta: Number(this.hasta()) }));
      const partes = [
        r.creadas.length ? `Se dieron de alta ${rango(r.creadas)}.` : 'No se dio de alta ninguna.',
        r.ya_existian.length ? `Ya existían: ${rango(r.ya_existian)}.` : '',
      ].filter(Boolean);
      this.aviso.set({ texto: partes.join(' '), mal: false });
      await this.cargar();
      // Las nuevas, listas para imprimir: la carreta existe cuando tiene su cartel pegado.
      const nuevas = (this.data()?.carretas ?? []).filter((c) => r.creadas.includes(c.code));
      if (nuevas.length) this.imprimir(nuevas);
    } catch (e) {
      this.aviso.set({ texto: mensaje(e, 'No se pudieron dar de alta.'), mal: true });
    } finally {
      this.ocupado.set(false);
    }
  }

  async confirmarLiberar(c: CartRow): Promise<void> {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    try {
      await firstValueFrom(this.api.release(c.id));
      this.liberar.set(null);
      this.aviso.set({ texto: `${this.nombre(c)} quedó libre.`, mal: false });
      await this.cargar();
    } catch (e) {
      this.liberar.set(null);
      this.aviso.set({ texto: mensaje(e, 'No se pudo liberar.'), mal: true });
    } finally {
      this.ocupado.set(false);
    }
  }

  imprimir(cs: CartRow[]): void {
    this.carteles.set(cs.map((c) => ({ code: c.code, label: this.nombre(c), almacen: this.warehouse().code })));
  }
}

/** `["C01","C02","C03"]` → «C01 a C03»; si no son seguidas, se listan. */
function rango(codes: string[]): string {
  if (codes.length === 1) return codes[0];
  const n = codes.map((c) => Number(c.slice(1)));
  const seguidas = n.every((x, i) => i === 0 || x === n[i - 1] + 1);
  return seguidas ? `${codes[0]} a ${codes[codes.length - 1]}` : codes.join(', ');
}

const horaMx = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

function mensaje(e: unknown, fallback: string): string {
  const m = (e as HttpErrorResponse)?.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}
