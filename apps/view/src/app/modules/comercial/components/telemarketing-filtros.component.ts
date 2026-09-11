import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';

export interface TmFiltros {
  search: string;
  vendedor: string | null;
  desde: string;
  hasta: string;
  cobro: string | null;
  soloVencidas: boolean;
}

/**
 * Ventana por defecto: **8 días**, hoy incluido (decisión Edgar 2026-09-11 — "de lunes a
 * lunes"). Es la semana de cobranza: si hoy es lunes, arranca el lunes pasado. Antes eran 30
 * días, que para armar la guía del día traía cuatro semanas de facturas a palomear.
 */
const DIAS_VENTANA = 8;

export function tmFiltrosIniciales(): TmFiltros {
  const hoy = new Date();
  return {
    search: '',
    vendedor: null,
    desde: new Date(hoy.getTime() - (DIAS_VENTANA - 1) * 864e5).toISOString().slice(0, 10),
    hasta: hoy.toISOString().slice(0, 10),
    cobro: null,
    soloVencidas: false,
  };
}

let seq = 0;

/**
 * GT.3 — barra de filtros de Telemarketing, compartida por Facturación TM y Reportes.
 *
 * Presentacional pura (mismo patrón que `order-filters`): el padre es dueño del estado y acá
 * sólo se emite el objeto completo ya modificado.
 *
 * Va en **una sola hilera**, y el buscador es angosto a propósito: con `flex:1` se comía media
 * pantalla y empujaba el resto de los filtros a un segundo renglón — cinco controles de 2 cm
 * repartidos en dos filas se leen peor que los mismos cinco seguidos.
 *
 * El layout lo decide **`@container`, no `@media`** (DESIGN.md §R): esta barra vive en dos
 * páginas y mañana puede vivir embebida en un panel angosto — lo que manda es el ancho que le
 * da el padre, no el del viewport. En angosto se acomoda en renglones: una hilera cortada o
 * con scroll escondido es peor que dos renglones legibles.
 */
@Component({
  selector: 'app-telemarketing-filtros',
  standalone: true,
  imports: [FormsModule, SelectModule, InputTextModule, IconFieldModule, InputIconModule, CheckboxModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tmf card-premium card-flat">
      <p-iconfield class="f-search">
        <p-inputicon styleClass="pi pi-search" />
        <input pInputText type="text" [ngModel]="value.search"
               (ngModelChange)="escribir($event)" (keyup.enter)="ya()"
               placeholder="Cliente, RFC, folio o monto" aria-label="Buscar facturas" />
      </p-iconfield>

      <p-select [ngModel]="value.vendedor" (ngModelChange)="emit({ vendedor: $event })"
                [options]="vendedores" optionLabel="label" optionValue="value"
                placeholder="Vendedor" [showClear]="true" [filter]="true"
                styleClass="tmf-sel" ariaLabel="Vendedor" />

      <div class="f-fecha">
        <input pInputText type="date" [ngModel]="value.desde"
               (ngModelChange)="emit({ desde: $event })" aria-label="Desde" />
        <span class="sep" aria-hidden="true">→</span>
        <input pInputText type="date" [ngModel]="value.hasta"
               (ngModelChange)="emit({ hasta: $event })" aria-label="Hasta" />
      </div>

      <p-select [ngModel]="value.cobro" (ngModelChange)="emit({ cobro: $event })"
                [options]="COBRO" optionLabel="label" optionValue="value"
                placeholder="Estado de cobro" [showClear]="true"
                styleClass="tmf-sel" ariaLabel="Estado de cobro" />

      <label class="f-check" [for]="id">
        <p-checkbox [ngModel]="value.soloVencidas" (ngModelChange)="emit({ soloVencidas: $event })"
                    [binary]="true" [inputId]="id" />
        <span pTooltip="Vencieron y siguen debiendo. Las que ya se cobraron no cuentan.">Solo vencidas</span>
      </label>

      <span class="sp"></span>
      <ng-content />
    </div>
  `,
  styles: [`
    /* min-width:0 — sin esto el contenido de la barra fija el ancho del <main> y es la
       página entera la que se desborda a la derecha, no la barra. */
    :host { display: block; min-width: 0; container-type: inline-size; }
    .tmf {
      display: flex; align-items: center; gap: .5rem;
      padding: .5rem .625rem; margin-bottom: .75rem;
      flex-wrap: wrap;
    }
    /* el buscador NO crece: ancho fijo cómodo, el resto de la hilera es lo que importa */
    .tmf .f-search { flex: 0 1 15rem; min-width: 10rem; }
    .tmf .f-search input { width: 100%; }
    .f-fecha { display: flex; align-items: center; gap: .3rem; flex: 0 1 auto; }
    .f-fecha input { width: 8.5rem; min-width: 7rem; }
    .f-fecha .sep { color: var(--text-soft); font-size: var(--fs-sm); }
    .f-check {
      display: flex; align-items: center; gap: .4rem; flex: 0 0 auto;
      font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; white-space: nowrap;
    }
    .sp { flex: 1 1 auto; min-width: 0; }
    /* El item flex es el <p-select>, NO el div que recibe styleClass: dimensionar por
       .tmf-sel no movia el ancho. El host se estiliza directo (sin ::ng-deep: esta en
       nuestro template); .tmf-sel queda solo para lo de adentro. */
    .tmf p-select { flex: 0 1 11rem; min-width: 9rem; }
    :host ::ng-deep .tmf-sel { width: 100%; font-size: var(--fs-sm); }
    :host ::ng-deep .tmf input { font-size: var(--fs-sm); }

    /* Tablet / panel angosto: el buscador toma el renglón completo y el resto se acomoda
       debajo. Una sola hilera es lo bueno con espacio; forzarla acá sería una barra cortada. */
    @container (max-width: 56rem) {
      .tmf .f-search { flex: 1 1 100%; }
      .f-fecha { flex: 1 1 100%; }
      .f-fecha input { flex: 1 1 0; width: auto; }
      .tmf p-select { flex: 1 1 10rem; }
    }

    /* Teléfono: cada control en su renglón. Con 22rem de ancho, dos selects lado a lado
       entran a 8rem cada uno y el placeholder "Estado de cobro" queda cortado a la mitad. */
    @container (max-width: 30rem) {
      .tmf { gap: .45rem; }
      .tmf p-select { flex: 1 1 100%; }
      .f-check { flex: 1 1 100%; min-height: var(--tap-min, 44px); }
    }
  `],
})
export class TelemarketingFiltrosComponent implements OnDestroy {
  @Input({ required: true }) value!: TmFiltros;
  @Input() vendedores: { label: string; value: string }[] = [];
  @Output() readonly cambio = new EventEmitter<TmFiltros>();

  readonly id = `tmf-venc-${++seq}`;
  readonly COBRO = [
    { label: 'Pendientes', value: 'pendiente' },
    { label: 'Abono parcial', value: 'parcial' },
    { label: 'Pagadas', value: 'pagada' },
    { label: 'Sin cartera', value: 'sin_cartera' },
  ];

  private timer?: ReturnType<typeof setTimeout>;

  /** Texto libre: se espera a que deje de teclear para no disparar una consulta por tecla. */
  escribir(search: string): void {
    this.value = { ...this.value, search };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cambio.emit(this.value), 300);
  }

  ya(): void {
    clearTimeout(this.timer);
    this.cambio.emit(this.value);
  }

  emit(patch: Partial<TmFiltros>): void {
    this.value = { ...this.value, ...patch };
    this.ya();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }
}
