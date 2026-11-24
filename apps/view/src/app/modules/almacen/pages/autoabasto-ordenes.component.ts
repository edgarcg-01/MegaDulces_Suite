import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import {
  armarOrdenes,
  MINIMO_RENGLONES_UNIDAD,
  MOTIVO_FUERA_LABEL,
  TOPE_RENGLONES_ORDEN,
  UNIDAD_MIXTA,
  type AutoabastoPedidoLinea,
  type RenglonArmable,
} from '@megadulces/contracts';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

/**
 * `[AB.NI.5]` **El pedido abierto** — `/almacen/autoabasto` → «Ver los N renglones».
 *
 * No es «la tabla de antes con filtros»: es el pedido **ya partido en las órdenes en que se va a
 * armar**, con el orden que fijó Edgar el 2026-11-22 — unidad → línea → alfabético — y el corte de
 * 70 renglones al terminar una línea.
 *
 * ⛔ El reparto NO se calcula acá: lo hace `armarOrdenes` en `libs/contracts`, la misma función que
 * puede usar el servidor (ADR-056). Esta pantalla sólo la pinta.
 *
 * **Deuda declarada — §2 matriz de estados:** esta vista NO hace fetch. Es una proyección pura de
 * lo que el padre (`almacen-autoabasto`) ya cargó dentro de su `app-load-state`; «cargando» y
 * «error de red» son estados del padre y envolverla en un segundo `LoadState` siempre apagado sería
 * cumplir la regla pintando un control muerto. El estado vacío sí vive acá (`@empty`), con su causa.
 *
 * Ver `docs/IMPLEMENTACION/FASES/FASE_AB_ANEXO_INTERFAZ_2026-11-23.md` §6.
 */

/** Lo que la fila necesita para pintarse, además de lo armable. */
type Fila = AutoabastoPedidoLinea & RenglonArmable;

/** Una fila ya aplanada para `p-table`: lleva su orden y su línea para agrupar sin anidar tablas. */
interface FilaPlana {
  l: Fila;
  /** Llave del grupo de `rowGroupMode="subheader"`: una banda por línea dentro de cada orden. */
  grupo: string;
  orden: number;
  ordenes: number;
  unidad: string;
  ordenRenglones: number;
  ordenValor: number | null;
  ordenSinValuar: number;
  linea: string;
  lineaRenglones: number;
  /** La primera fila de la orden: es la que pinta la banda de orden encima de la de línea. */
  abreOrden: boolean;
  /** `true` en la orden que junta las unidades chicas (D1, Edgar 2026-11-24). */
  mixta: boolean;
  /** Las unidades reales que junta la orden mixta. Una sola en las órdenes normales. */
  unidades: string[];
  /** La unidad de ESTA banda de línea. En la mixta distingue un grupo de otro. */
  unidadBanda: string;
}

@Component({
  selector: 'app-autoabasto-ordenes',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe, TableModule, TooltipModule, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .ao-head { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; justify-content: space-between; }
    .ao-tira { display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-start; justify-content: space-between; }
    .ao-pills { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .625rem; }
    .ao-pill { display: inline-flex; align-items: center; gap: .375rem; padding: .125rem .625rem;
               border: 1px solid var(--border-color); border-radius: 999px; font-size: .75rem; color: var(--text-muted); }
    .ao-pill--on { border-color: var(--action); color: var(--action); }
    .ao-pill--cola { border-style: dashed; }
    .ao-fuera { display: flex; gap: .75rem; align-items: flex-start; padding: .625rem .75rem;
                border-radius: .5rem; background: var(--warn-soft-bg); border: 1px solid var(--warn-border);
                color: var(--warn-soft-fg); font-size: .8125rem; line-height: 1.5; flex: 0 1 30rem; }
    /* La banda de ORDEN lleva el color de acción: es el corte que importa. */
    .ao-b-orden { background: color-mix(in srgb, var(--action) 10%, var(--card-bg));
                  border-top: 1px solid color-mix(in srgb, var(--action) 35%, transparent); }
    .ao-b-orden-in { display: flex; align-items: baseline; justify-content: space-between;
                     gap: 1rem; flex-wrap: wrap; padding: .125rem 0; }
    .ao-linea-nom { font-size: .75rem; font-weight: 700; letter-spacing: .04em; color: var(--text-main); }
    .ao-sku { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ao-q { font-weight: 700; }
    .ao-de { color: var(--text-faint); font-weight: 400; font-size: .75rem; }
    .ao-x { background: none; border: 0; color: var(--text-faint); padding: .25rem;
            border-radius: .375rem; cursor: pointer; min-width: 2rem; min-height: 2rem; }
    .ao-x:hover { color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .ao-pie { font-size: .75rem; color: var(--text-muted); line-height: 1.7; max-width: 112ch; }
  `],
  template: `
    <section class="flex flex-col gap-4">

      <!-- Cabecera -->
      <div class="ao-head">
        <div>
          <button type="button" class="link-accion text-sm inline-flex items-center gap-1.5 mb-1.5"
                  (click)="cerrar.emit()">
            <i class="pi pi-chevron-left text-xs" aria-hidden="true"></i> Volver al resumen
          </button>
          <h2 class="m-0 text-xl font-bold tracking-tight">Lo que le pides a {{ destino() }}</h2>
          <p class="m-0 mt-1.5 text-sm text-content-muted comm-num flex items-center gap-2 flex-wrap">
            <span>
              {{ total() }} {{ total() === 1 ? 'renglón' : 'renglones' }}
              · {{ lineasDistintas() }} {{ lineasDistintas() === 1 ? 'línea' : 'líneas' }}
              · se arma en <strong class="text-content-main">{{ armado().ordenes.length }}</strong>
              {{ armado().ordenes.length === 1 ? 'orden' : 'órdenes' }}
            </span>
            <!-- §9 La edad del cálculo viaja desde el padre: sin ella, un pedido de ayer se lee como de hoy. -->
            <app-freshness-pill measures="fetch" [since]="calculadoEn()" />
          </p>
        </div>
        <div class="flex gap-3 items-center">
          @if (marcados().size > 0) {
            <button type="button" class="btn-secundario" (click)="emitirQuitar()">
              Quitar {{ marcados().size }} {{ marcados().size === 1 ? 'renglón' : 'renglones' }}
            </button>
          }
          <button type="button" class="btn-primario" [disabled]="armado().renglones_que_salen === 0"
                  (click)="pedir.emit()">
            Pedir a {{ destino() }}
            <span class="ab-btn-n comm-num">{{ armado().renglones_que_salen }}</span>
          </button>
        </div>
      </div>

      <!--
        Q.1 El veredicto primero: cuántas órdenes, cuánto sale y cuánto NO puede salir. Quien abre
        esta pantalla no viene a leer 294 renglones — viene a saber en cuántos papeles se convierte.
      -->
      <app-metric-strip [items]="resumen()" ariaLabel="Cómo se parte el pedido" />

      <!-- Cómo se parte -->
      <div class="surf-card p-4">
        <div class="ao-tira">
          <div class="flex-1 min-w-0" style="flex-basis: 32rem">
            <p class="m-0 text-sm">
              <strong>Una orden no mezcla unidades</strong>
              <span class="text-content-muted">
                — el armado se hace por unidad — y se corta en {{ tope }} renglones, siempre al terminar una línea.
              </span>
            </p>
            <div class="ao-pills">
              @for (u of armado().por_unidad; track u.unidad) {
                <span class="ao-pill" [class.ao-pill--on]="$first" [class.ao-pill--cola]="u.mixta">
                  <span class="comm-num">{{ u.unidad }} · {{ u.renglones }}</span>
                  @if (u.mixta) { → va en «{{ unidadMixta }}» }
                  @else { → {{ u.ordenes }} {{ u.ordenes === 1 ? 'orden' : 'órdenes' }} }
                </span>
              }
              @empty { <span class="ao-pill">Nada que armar</span> }
            </div>
            @if (hayCola()) {
              <p class="m-0 mt-2 text-xs text-content-muted">
                Las unidades de menos de {{ minimoPorUnidad }} renglones no llevan documento propio:
                se arman juntas al final, en una sola orden. Así
                <strong class="text-content-main">{{ renglonesEnCola() }}</strong>
                {{ renglonesEnCola() === 1 ? 'renglón no se lleva' : 'renglones no se llevan' }}
                {{ unidadesEnCola() }} papeles aparte.
              </p>
            }
          </div>

          @if (armado().fuera.length > 0) {
            <div class="ao-fuera" role="note">
              <i class="pi pi-exclamation-circle mt-0.5" aria-hidden="true"></i>
              <p class="m-0">
                <strong>{{ armado().fuera.length }}
                  {{ armado().fuera.length === 1 ? 'renglón no tiene' : 'renglones no tienen' }} unidad en la ficha de Kepler</strong>
                @if (valorFuera() !== null) { ({{ valorFuera() | currency:'MXN':'symbol-narrow':'1.0-0' }}) }.
                Así no pueden salir: el ERP los rechaza. Quedan fuera de las órdenes y el resto sí sale.
                <button type="button" class="link-accion text-xs" (click)="verFuera.set(!verFuera())">
                  {{ verFuera() ? 'Ocultar' : 'Ver cuáles' }}
                </button>
              </p>
            </div>
          }
        </div>

        @if (verFuera() && armado().fuera.length > 0) {
          <ul class="mt-3 mb-0 pl-5 text-xs text-content-muted flex flex-col gap-1">
            @for (f of armado().fuera; track f.renglon.product_id) {
              <li>
                <span class="comm-num">{{ f.renglon.sku }}</span> · {{ f.renglon.nombre }}
                <span class="text-content-faint">— {{ motivoLabel(f.motivo) }}</span>
              </li>
            }
          </ul>
        }
      </div>

      <!--
        O.4 La rejilla es «p-table»: trae header fijo, primera columna congelada, «dt-stack» para
        angosto y la navegación de teclado del sistema. Las bandas se pintan con «rowGroupMode»
        sobre una lista APLANADA: anidar tablas rompería el teclado y el «scope» de los encabezados.
      -->
      <p-table [value]="filas()" dataKey="l.product_id" rowGroupMode="subheader" groupRowsBy="grupo"
               [scrollable]="true" scrollHeight="58vh"
               size="small" class="dt-stack surf-table surf-table--plain surf-table--frozen-first">
        <ng-template #caption>
          <span class="text-xs text-content-muted">
            El pedido a {{ destino() }}, partido en {{ armado().ordenes.length }}
            {{ armado().ordenes.length === 1 ? 'orden' : 'órdenes' }} por unidad y por línea.
          </span>
        </ng-template>

        <ng-template #header>
          <tr>
            <th scope="col" style="width: 2.75rem">
              <input type="checkbox" [checked]="todoMarcado()" (change)="marcarTodo($event)"
                     aria-label="Marcar todos los renglones">
            </th>
            <th scope="col" style="width: 5.5rem">Código</th>
            <th scope="col">Producto</th>
            <th scope="col" style="width: 6.5rem">Tránsito</th>
            <th scope="col" class="comm-num" style="width: 10.5rem"
                pTooltip="La cantidad y la unidad en que la matriz te lo puede surtir. «de 0.100 cja» es lo que calculó el motor antes de bajarlo de unidad."
                tooltipPosition="top">Pide</th>
            <th scope="col" class="comm-num" style="width: 7rem">Importe</th>
            <th scope="col" style="width: 3rem"><span class="sr-only">Quitar</span></th>
          </tr>
        </ng-template>

        <ng-template #groupheader let-f>
          @if (f.abreOrden) {
            <tr class="ao-b-orden">
              <td colspan="7">
                <div class="ao-b-orden-in">
                  <span class="text-sm font-bold">
                    Orden {{ f.orden }} de {{ f.ordenes }} · en {{ f.unidad }}
                    <!-- La orden mixta no finge ser una unidad: dice cuáles junta. -->
                    @if (f.mixta) {
                      <span class="font-normal text-content-muted">({{ f.unidades.join(', ') }})</span>
                    }
                  </span>
                  <span class="text-xs text-content-muted comm-num">
                    {{ f.ordenRenglones }} {{ f.ordenRenglones === 1 ? 'renglón' : 'renglones' }}
                    @if (f.ordenValor !== null) { · {{ f.ordenValor | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                    @if (f.ordenSinValuar > 0) { · {{ f.ordenSinValuar }} sin valuar }
                  </span>
                </div>
              </td>
            </tr>
          }
          <tr class="surf-rowgroup">
            <td colspan="7">
              <!-- Dentro de la orden mixta, la banda dice su unidad: es lo que separa un grupo de otro. -->
              @if (f.mixta) {
                <span class="ao-pill ao-pill--cola mr-2">{{ f.unidadBanda }}</span>
              }
              <span class="ao-linea-nom">{{ f.linea }}</span>
              <span class="text-xs text-content-faint comm-num">
                · {{ f.lineaRenglones }} {{ f.lineaRenglones === 1 ? 'renglón' : 'renglones' }}
              </span>
            </td>
          </tr>
        </ng-template>

        <ng-template #body let-f>
          <tr>
            <td data-label="">
              <input type="checkbox" [checked]="marcados().has(f.l.product_id)"
                     (change)="marcar(f.l.product_id, $event)"
                     [attr.aria-label]="'Marcar ' + f.l.nombre">
            </td>
            <td class="ao-sku" data-label="Código">{{ f.l.sku }}</td>
            <td data-label="Producto">{{ f.l.nombre }}</td>
            <td data-label="Tránsito">
              @if (tieneTransito(f.l)) { <span class="ao-pill">ya viene</span> }
            </td>
            <td class="comm-num" data-label="Pide">
              <span class="ao-q">{{ cantidadDe(f.l) }} {{ f.l.a_pedir.unidad }}</span>
              @if (bajoDeUnidad(f.l)) {
                <span class="ao-de"> · de {{ f.l.a_pedir.falta_mayor | number:'1.3-3' }} cja</span>
              }
            </td>
            <td class="comm-num" data-label="Importe">
              @if (f.l.valor !== null) { {{ f.l.valor | currency:'MXN':'symbol-narrow':'1.0-0' }} }
              @else { <span class="text-content-faint">—</span> }
            </td>
            <td data-label="">
              <button type="button" class="ao-x" [attr.aria-label]="'Quitar ' + f.l.nombre"
                      (click)="quitar.emit([f.l.product_id])">
                <i class="pi pi-times text-xs" aria-hidden="true"></i>
              </button>
            </td>
          </tr>
        </ng-template>

        <ng-template #emptymessage>
          <tr>
            <td colspan="7" class="text-content-muted" style="padding: 1.5rem .75rem">
              No hay nada que armar.
              @if (armado().fuera.length > 0) {
                Los {{ armado().fuera.length }} renglones del pedido no tienen unidad en la ficha de Kepler.
              } @else {
                Ningún renglón lleva cantidad.
              }
            </td>
          </tr>
        </ng-template>
      </p-table>

      <!-- Pie: de dónde sale y qué NO se midió -->
      <footer class="ao-pie">
        <p class="m-0">
          <strong class="text-content-main">«Ya viene»</strong> marca los renglones con tránsito abierto —
          <span class="comm-num">{{ conTransito() }}</span> de <span class="comm-num">{{ total() }}</span>.
          El motor ya lo restó de lo que pides. No se pinta el número porque su unidad no está verificada.
        </p>
        <p class="m-0 mt-1.5">
          <strong class="text-content-main">«de 0.100 cja»</strong> es lo que el motor calculó antes de bajarlo
          a la unidad en que te lo pueden surtir —
          <span class="comm-num">{{ bajanDeUnidad() }}</span> de <span class="comm-num">{{ total() }}</span>
          {{ bajanDeUnidad() === 1 ? 'renglón baja' : 'renglones bajan' }} de unidad.
        </p>
        <p class="m-0 mt-1.5">
          <strong class="text-content-main">La línea es el fabricante</strong>, derivada del catálogo del ERP.
          El rótulo se muestra tal cual llega: corregirlo aquí sería inventar un catálogo.
        </p>
      </footer>
    </section>
  `,
})
export class AutoabastoOrdenesComponent {
  /** Los renglones del pedido a UN destino. El llamador ya filtró el destino y los ceros. */
  readonly lineas = input.required<AutoabastoPedidoLinea[]>();
  /** Nombre del que surte, para los rótulos. ⛔ Nunca el código. */
  readonly destino = input.required<string>();
  /** Cuándo se calculó el pedido. `null` = no se sabe, y la píldora lo dice. */
  readonly calculadoEn = input<Date | null>(null);

  readonly cerrar = output<void>();
  readonly pedir = output<void>();
  readonly quitar = output<string[]>();

  readonly tope = TOPE_RENGLONES_ORDEN;
  readonly minimoPorUnidad = MINIMO_RENGLONES_UNIDAD;
  readonly unidadMixta = UNIDAD_MIXTA;
  readonly verFuera = signal(false);
  readonly marcados = signal<Set<string>>(new Set());

  /**
   * El reparto. `a_pedir.unidad` ya dice en qué unidad sale el renglón y `clase === 'sin_unidad'`
   * deja `unidad` en `null`: `armarOrdenes` lo separa solo, sin que esta pantalla decida nada.
   */
  readonly armado = computed(() => armarOrdenes<Fila>(
    this.lineas().map((l) => ({ ...l, unidad: l.a_pedir?.unidad ?? null, linea: l.linea ?? null })),
  ));

  /** Las órdenes aplanadas para `p-table`: cada fila sabe a qué orden y a qué línea pertenece. */
  readonly filas = computed<FilaPlana[]>(() => {
    const a = this.armado();
    const out: FilaPlana[] = [];
    for (const o of a.ordenes) {
      let primera = true;
      for (const b of o.bandas) {
        for (const l of b.renglones) {
          out.push({
            l,
            // La unidad entra a la llave del grupo: en la orden mixta, dos unidades pueden traer
            // la MISMA línea y sin ella sus renglones caerían bajo una sola banda.
            grupo: `${o.numero}\u0000${b.unidad}\u0000${b.linea}`,
            orden: o.numero,
            ordenes: a.ordenes.length,
            unidad: o.unidad,
            ordenRenglones: o.renglones,
            ordenValor: o.valor,
            ordenSinValuar: o.sin_valuar,
            linea: b.linea,
            lineaRenglones: b.renglones.length,
            abreOrden: primera,
            mixta: o.mixta,
            unidades: o.unidades,
            unidadBanda: b.unidad,
          });
          primera = false;
        }
      }
    }
    return out;
  });

  readonly total = computed(() => this.lineas().length);

  readonly lineasDistintas = computed(() => {
    const s = new Set<string>();
    for (const o of this.armado().ordenes) for (const b of o.bandas) s.add(b.linea);
    return s.size;
  });

  /** `null` si NINGUNA orden se pudo valuar: no se dibuja un cero que no es un cero. */
  readonly valorTotal = computed<number | null>(() => {
    let t = 0;
    let hubo = false;
    for (const o of this.armado().ordenes) if (o.valor !== null) { t += o.valor; hubo = true; }
    return hubo ? Math.round(t * 100) / 100 : null;
  });

  readonly valorFuera = computed<number | null>(() => {
    let t = 0;
    let hubo = false;
    for (const f of this.armado().fuera) {
      const v = f.renglon.valor;
      if (typeof v === 'number' && Number.isFinite(v)) { t += v; hubo = true; }
    }
    return hubo ? Math.round(t * 100) / 100 : null;
  });

  readonly conTransito = computed(() => this.lineas().filter((l) => this.tieneTransito(l)).length);
  readonly bajanDeUnidad = computed(() => this.lineas().filter((l) => this.bajoDeUnidad(l)).length);

  // ── D1 (Edgar, 2026-11-24): las unidades chicas comparten un documento ─────────────────────

  readonly hayCola = computed(() => this.armado().por_unidad.some((u) => u.mixta));
  readonly unidadesEnCola = computed(() => this.armado().por_unidad.filter((u) => u.mixta).length);
  readonly renglonesEnCola = computed(() =>
    this.armado().por_unidad.filter((u) => u.mixta).reduce((n, u) => n + u.renglones, 0));

  /** Q.1 El veredicto de la pantalla, arriba de la rejilla. */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const a = this.armado();
    const v = this.valorTotal();
    const items: MetricStripItem[] = [
      { label: 'Órdenes', value: a.ordenes.length, sub: `una por unidad · tope de ${this.tope} renglones` },
      { label: 'Renglones que salen', value: a.renglones_que_salen, sub: `de ${this.total()} del pedido` },
      v === null
        ? { label: 'Lo que sale', value: '—', state: 'no_medido', stateNote: 'Ningún renglón tiene costo en la ficha.' }
        : { label: 'Lo que sale', value: v, format: 'currency' },
    ];
    // ⛔ El bloqueo sólo aparece cuando existe. Un «0 bloqueados» permanente enseña a ignorarlo.
    if (a.fuera.length > 0) {
      items.push({ label: 'No pueden salir', value: a.fuera.length, tone: 'bad', sub: 'sin unidad en la ficha' });
    }
    return items;
  });

  readonly todoMarcado = computed(() => {
    const n = this.armado().renglones_que_salen;
    return n > 0 && this.marcados().size === n;
  });

  motivoLabel(m: keyof typeof MOTIVO_FUERA_LABEL): string {
    return MOTIVO_FUERA_LABEL[m];
  }

  /** Tránsito abierto: lo que ya viene en camino o ya está pedido a la matriz. */
  tieneTransito(l: AutoabastoPedidoLinea): boolean {
    return (l.en_camino ?? 0) > 0 || (l.ya_pedido ?? 0) > 0;
  }

  /** El renglón bajó a la unidad menor: la regla de §15.2 lo sacó de la unidad mayor. */
  bajoDeUnidad(l: AutoabastoPedidoLinea): boolean {
    return l.a_pedir?.clase === 'menor' && l.a_pedir.falta_mayor != null;
  }

  /** Lo que de verdad va: el ajuste de la persona si lo hubo, si no lo que calculó el motor. */
  cantidadDe(l: AutoabastoPedidoLinea): number {
    return l.ajuste?.cantidad ?? l.a_pedir?.cantidad ?? 0;
  }

  marcar(id: string, ev: Event): void {
    const on = (ev.target as HTMLInputElement)?.checked;
    this.marcados.update((s) => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });
  }

  marcarTodo(ev: Event): void {
    const on = (ev.target as HTMLInputElement)?.checked;
    if (!on) { this.marcados.set(new Set()); return; }
    this.marcados.set(new Set(this.filas().map((f) => f.l.product_id)));
  }

  emitirQuitar(): void {
    const ids = [...this.marcados()];
    if (!ids.length) return;
    this.quitar.emit(ids);
    this.marcados.set(new Set());
  }
}
