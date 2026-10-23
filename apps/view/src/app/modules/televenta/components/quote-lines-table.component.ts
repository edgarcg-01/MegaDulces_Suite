import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { etiquetaFuentePrecio, tonoFuentePrecio, type PasoDesglose } from '../quote-units';

/**
 * `[E.29]` Un renglón de cotización como lo ve el operador, YA resuelto. Lo arman el alta (la
 * bandeja, antes de guardar) y el detalle (lo guardado); esta tabla sólo lo pinta. Así la
 * cotización se ve igual antes y después de crearla — pedido explícito: «mostrar esta interfaz
 * tal cual antes de generar la cotización».
 */
export interface RenglonTabla {
  id: string;
  numero: number;
  nombre: string;
  /** No casó con el catálogo: es demanda que no manejamos, sin precio. */
  sinCasar: boolean;
  /** Renglón de regalo del ERP: el número del renglón que lo trae. null = renglón normal. */
  regaloDe: number | null;
  /** Regalo que el ERP le agregará a este renglón (sólo en la bandeja, antes de guardar). */
  notaRegalo: string | null;
  unidad: string | null;
  factor: number | null;
  cantidad: number;
  editable: boolean;
  admiteFraccion: boolean;
  /**
   * Existencia de la sucursal en la unidad del renglón. `'cargando'` mientras se consulta,
   * `'sin-dato'` si el ERP no la tiene (no es cero), null = no aplica (regalo) o no se pidió.
   */
  existencia: { cantidad: number; unidad: string; faltan: number } | 'cargando' | 'sin-dato' | null;
  lista: number | null;
  precio: number | null;
  /** El precio por unidad menor: «(12 PAQ $41.82)». */
  desglose: PasoDesglose[];
  /** `price_source` del motor (código; la etiqueta la pone la tabla). */
  fuente: string;
  /** Descuento contra la lista, en % (derivado; null = sin lista o sin precio). */
  dtoPct: number | null;
  /** «lista $26.94 → volumen $24.79»; vacío si no hay pasos que explicar. */
  pasos: string;
  importe: number | null;
}

export interface CambioCantidad {
  id: string;
  valor: string;
  input: HTMLInputElement;
}

@Component({
  selector: 'app-quote-lines-table',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- rowTrackBy por id: al cambiar una cantidad la fila no se rehace y el campo no pierde el foco. -->
    <p-table class="dt-stack" [value]="renglones()" dataKey="id" [rowTrackBy]="porId" size="small" [tableStyle]="{ 'min-width': '70rem' }">
      <ng-template #header>
        <tr>
          <th class="num">#</th>
          <th>Producto</th>
          <th>Presentación</th>
          <th class="num">Cantidad</th>
          <th class="num">Existencia hoy</th>
          <th class="num">Lista</th>
          <th class="num">Precio</th>
          <th>De dónde sale</th>
          <th class="num">Importe</th>
          <th><span class="sr-only">Acciones</span></th>
        </tr>
      </ng-template>
      <ng-template #body let-r>
        <tr [class.row-gift]="r.regaloDe !== null">
          <td class="num mono dt-num" role="cell" data-label="Renglón">{{ r.numero }}</td>
          <td class="dt-id" role="cell">
            @if (r.regaloDe !== null) {
              <span class="gift"><i class="pi pi-gift" aria-hidden="true"></i> regalo del {{ r.regaloDe }}</span>
            }
            <span class="p-name" [title]="r.nombre">{{ r.nombre }}</span>
            @if (r.sinCasar) {
              <span class="sin-casar">sin casar con el catálogo</span>
            }
            @if (r.notaRegalo) {
              <span class="gift-nota"><i class="pi pi-gift" aria-hidden="true"></i> {{ r.notaRegalo }}</span>
            }
          </td>
          <td role="cell" data-label="Presentación">
            @if (r.unidad) {
              {{ r.unidad }}
              @if (r.factor) { <span class="factor">x{{ r.factor }}</span> }
            } @else {
              <span class="t-none">sin registrar</span>
            }
          </td>
          <td class="num dt-num" role="cell" data-label="Cantidad">
            @if (r.editable && r.regaloDe === null) {
              <div class="inline-qty-box">
                <!-- Se guarda al CONFIRMAR (Enter o salir del campo), no con cada tecla (E.20). -->
                <input
                  pInputText
                  pSize="small"
                  type="text"
                  class="qty-inline"
                  [value]="r.cantidad"
                  (change)="cantidad.emit({ id: r.id, valor: $any($event.target).value, input: $any($event.target) })"
                  (keydown.enter)="$any($event.target).blur()"
                  (focus)="$any($event.target).select()"
                  [attr.inputmode]="r.admiteFraccion ? 'decimal' : 'numeric'"
                  [disabled]="bloqueado()"
                  [attr.aria-label]="'Cantidad del renglón ' + r.numero"
                />
              </div>
            } @else {
              {{ r.cantidad }}
            }
          </td>
          <td class="num dt-num" role="cell" data-label="Existencia hoy">
            @switch (tipoExistencia(r)) {
              @case ('cargando') { <span class="t-none">…</span> }
              @case ('sin-dato') { <span class="t-none">sin dato</span> }
              @case ('dato') {
                <span [class.falta]="r.existencia.faltan > 0">{{ r.existencia.cantidad | number:'1.0-2' }} {{ r.existencia.unidad }}</span>
                @if (r.existencia.faltan > 0) { <span class="falta-nota">faltan {{ r.existencia.faltan | number:'1.0-2' }}</span> }
              }
            }
          </td>
          <td class="num muted dt-num" role="cell" data-label="Lista">{{ dinero(r.lista) }}</td>
          <td class="num dt-num" role="cell" data-label="Precio">
            @if (r.precio !== null) {
              <div class="p-unit-cell">
                <span class="p-unit-main">{{ r.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                @if (r.desglose.length) {
                  <span class="p-unit-sub-breakdown">(@for (p of r.desglose; track p.unidad; let ultimo = $last) {<span>{{ p.cantidad }} {{ p.unidad }} {{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>@if (!ultimo) { · }})</span>
                }
              </div>
            } @else {
              <span class="t-none">sin precio</span>
            }
          </td>
          <td role="cell" data-label="De dónde sale">
            <p-tag [value]="etiqueta(r.fuente)" [severity]="tono(r.fuente)" />
            @if (r.dtoPct) { <span class="dto">−{{ r.dtoPct }}%</span> }
            @if (r.pasos) { <span class="pasos">{{ r.pasos }}</span> }
          </td>
          <td class="num dt-num" role="cell" data-label="Importe">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
          <td class="num dt-actions" role="cell">
            @if (r.editable && r.regaloDe === null) {
              <p-button
                icon="pi pi-times"
                severity="danger"
                size="small"
                [text]="true"
                [disabled]="bloqueado()"
                (onClick)="quitar.emit(r.id)"
                [ariaLabel]="'Quitar el renglón ' + r.numero"
              />
            }
          </td>
        </tr>
      </ng-template>
    </p-table>
  `,
  styles: [
    `
      /* El contenedor de la tabla apilable (dense-table.css): apila por debajo de 34rem. */
      :host { display: block; overflow-x: auto; container-type: inline-size; container-name: densetable; }
      /* Sin cortes de línea sólo cuando la tabla NO está apilada. */
      @container densetable (min-width: 34rem) {
        :is(th, td) { white-space: nowrap; padding: 0.3rem 0.55rem; font-size: var(--fs-sm); }
        th { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
      }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); }
      .muted { color: var(--text-muted); }
      .row-gift { background: var(--surface-ground); }
      .p-name { display: inline-block; max-width: 22rem; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
      .gift { font-size: 0.7rem; color: var(--ok-soft-fg); margin-right: 0.35rem; }
      .gift-nota { display: block; font-size: 0.7rem; color: var(--ok-soft-fg); }
      .sin-casar { font-size: 0.7rem; color: var(--warn-soft-fg); margin-left: 0.35rem; }
      .factor { margin-left: 0.25rem; font-size: 0.7rem; color: var(--text-muted); }
      .dto { font-size: 0.7rem; color: var(--ok-soft-fg); margin-left: 0.3rem; }
      .pasos { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
      .falta { color: var(--bad-fg); font-weight: 600; }
      .falta-nota { display: block; font-size: var(--fs-xs); color: var(--bad-fg); }
      .t-none { font-style: italic; color: var(--text-muted); }
      .p-unit-cell { display: flex; align-items: baseline; justify-content: flex-end; gap: 0.35rem; white-space: nowrap; }
      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 500; }
      .inline-qty-box { display: flex; justify-content: flex-end; }
      .qty-inline { width: 4.5rem; text-align: right; font-variant-numeric: tabular-nums; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    `,
  ],
})
export class QuoteLinesTableComponent {
  readonly renglones = input.required<RenglonTabla[]>();
  /** Mientras se guarda: la cantidad y el quitar quedan deshabilitados. */
  readonly bloqueado = input(false);
  readonly cantidad = output<CambioCantidad>();
  readonly quitar = output<string>();

  readonly porId = (_: number, r: RenglonTabla): string => r.id;

  tipoExistencia(r: RenglonTabla): 'cargando' | 'sin-dato' | 'dato' | null {
    const e = r.existencia;
    if (e === null || r.regaloDe !== null) return null;
    return typeof e === 'string' ? e : 'dato';
  }

  etiqueta(s: string): string { return etiquetaFuentePrecio(s); }
  tono(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' { return tonoFuentePrecio(s); }

  dinero(v: number | null): string {
    return v === null ? '—' : v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
