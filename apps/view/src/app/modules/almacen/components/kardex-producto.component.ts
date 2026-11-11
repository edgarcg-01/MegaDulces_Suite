import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { diaCorto, type KardexNegativoResponse, type TipoPista } from '@megadulces/contracts';
import { AlmacenMovimientosService } from '../almacen-movimientos.service';

const ICONO_PISTA: Record<TipoPista, string> = {
  unidad: 'pi-exclamation-triangle', entrada_tardia: 'pi-history', conteo: 'pi-calendar', sin_conteo: 'pi-question-circle',
};

/**
 * `[IC.25]` **El kardex de un producto en una sucursal** — la historia de su existencia, movimiento
 * por movimiento, con el saldo después de cada uno.
 *
 * Nació dentro de Existencia negativa (`[MX.2.9]`) y se extrajo aquí cuando Diferencias lo necesitó
 * (ADR-056: un primitivo no se copia a la segunda pantalla, se comparte). El dato es el de
 * `GET /commercial/movements/negative-stock/kardex`, que sirve para CUALQUIER producto, esté o no en
 * negativo: lee `kdm2` de Kepler en vivo y declara si sus movimientos suman lo mismo que Kepler.
 *
 * ⛔ Por qué no la foto diaria (`analytics.stock_snapshots`): no guarda negativos (0 de 22,352
 * renglones el 2026-11-09) y pinta 0 donde Kepler estuvo en −145. Ni el Diario: en Padre Hidalgo no
 * trae las ventas de mostrador. Medido con el 83816 el 2026-11-10.
 *
 * El encabezado del panel (título y ayuda) lo pone quien lo usa; esto pinta los tres estados, el
 * control contra Kepler y los movimientos.
 */
@Component({
  selector: 'app-kardex-producto',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.aria-busy]': 'cargando()' },
  template: `
    @if (cargando()) {
      <p class="kx-meta" role="status">Leyendo los movimientos de Kepler…</p>
    } @else if (error()) {
      <p class="kx-err" role="alert">{{ error() }}</p>
      <button pButton type="button" class="p-button-sm p-button-text" (click)="reintentar()"><span class="p-button-label">Reintentar</span></button>
    } @else if (kardex(); as k) {
      @if (encabezado()) {
        <p class="kx-frase">{{ k.producto || 'Producto sin nombre en el catálogo' }}</p>
        <p class="kx-meta">Hoy Kepler marca <strong class="kx-num" [class.kx-saldo-neg]="k.existencia_kepler < 0">{{ k.existencia_kepler | number:'1.0-2' }} pz</strong> en {{ k.sucursal }}.</p>
      }
      @if (!k.cuadra) {
        <p class="kx-err">El kardex no cuadra con Kepler: los movimientos suman {{ k.existencia_kepler + k.diferencia | number:'1.0-2' }} pz y Kepler marca {{ k.existencia_kepler | number:'1.0-2' }}. Con el kardex incompleto no se calcula el día de cruce ni las pistas; los movimientos se muestran tal cual.</p>
      }
      @if (!k.renglones.length) {
        <p class="kx-meta">Kepler no tiene movimientos de este producto en esta sucursal.</p>
      } @else {
        @if (k.cuadra) {
          @if (k.cruce) {
            <p class="kx-frase-sm">Cayó a negativo el {{ dia(k.cruce.dia) }} (venía de {{ k.cruce.saldo_antes | number:'1.0-2' }} pz).</p>
          } @else if (minimo(); as m) {
            <p class="kx-frase-sm">Estuvo en negativo: el {{ dia(m.dia) }} cerró en <span class="kx-saldo-neg">{{ m.saldo | number:'1.0-2' }} pz</span>.</p>
          }
          @if (k.pistas.length) {
            <ul class="kx-pistas" aria-label="Pistas">
              @for (p of k.pistas; track $index) {
                <li [class.kx-pista-fuerte]="p.tipo === 'unidad'"><i class="pi" [ngClass]="iconoPista(p.tipo)" aria-hidden="true"></i><span>{{ p.texto }}</span></li>
              }
            </ul>
          }
          @if (k.salidas_desde_cruce.length) {
            <p-table [value]="k.salidas_desde_cruce" size="small" class="surf-table surf-table--plain kx-mini">
              <ng-template #caption><span class="kx-meta">Lo que salió desde que cruzó</span></ng-template>
              <ng-template #header><tr><th>Documento</th><th class="comm-num">Piezas</th><th class="comm-num">Importe</th></tr></ng-template>
              <ng-template #body let-s>
                <tr><td>{{ s.nombre }} <span class="kx-tenue-i">· {{ s.documentos }} doc.</span></td>
                  <td class="comm-num">{{ s.piezas | number:'1.0-2' }}</td><td class="comm-num">{{ dinero(s.importe) }}</td></tr>
              </ng-template>
            </p-table>
          }
          <p class="kx-tenue">Control: los movimientos suman {{ k.existencia_kepler | number:'1.0-2' }} pz, lo mismo que Kepler.</p>
        }
        @if (k.renglones_omitidos) {
          <p class="kx-tenue">{{ k.renglones_omitidos | number }} movimientos anteriores no se muestran; arranca con saldo {{ k.saldo_inicial | number:'1.0-2' }} pz.</p>
        }
        <p-table [value]="k.renglones" size="small" [scrollable]="true" [scrollHeight]="alto()" class="surf-table surf-table--plain surf-table--sticky kx-tabla">
          <ng-template #header><tr><th>Día</th><th>Documento</th><th class="comm-num">Piezas</th><th class="comm-num">Saldo</th></tr></ng-template>
          <ng-template #body let-r>
            <tr>
              <td class="kx-nowrap">{{ dia(r.dia) }}</td>
              <td>{{ r.nombre }}{{ r.folio ? ' ' + r.folio : '' }}
                @if (!r.folio && r.documentos > 1) { <span class="kx-tenue-i">· {{ r.documentos }} tickets</span> }
                @if (r.unidad) { <span class="kx-tenue-i">· {{ r.unidad }}{{ r.factor ? ' ×' + r.factor : '' }}</span> }
              </td>
              <td class="comm-num">{{ r.piezas > 0 ? '+' : '' }}{{ r.piezas | number:'1.0-2' }}</td>
              <td class="comm-num" [class.kx-saldo-neg]="r.saldo < 0">{{ r.saldo | number:'1.0-2' }}</td>
            </tr>
          </ng-template>
        </p-table>
      }
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: var(--sp-2); }
    .kx-frase { margin: 0; font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); }
    .kx-frase-sm { margin: 0; font-weight: 600; color: var(--text-main); }
    .kx-meta { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .kx-num { font-variant-numeric: tabular-nums; color: var(--text-main); }
    .kx-tenue { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .kx-tenue-i { font-size: var(--fs-xs); color: var(--text-muted); }
    .kx-err { margin: 0; font-size: var(--fs-xs); color: var(--bad-fg); }
    .kx-nowrap { white-space: nowrap; }
    .kx-saldo-neg { color: var(--bad-fg); font-weight: 600; }
    .kx-pistas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .kx-pistas li { display: grid; grid-template-columns: 1rem 1fr; gap: var(--sp-2); align-items: start; }
    .kx-pistas .pi { margin-top: .2rem; color: var(--text-muted); }
    .kx-pista-fuerte { font-weight: 600; }
    .kx-pista-fuerte .pi { color: var(--warn-fg); }
  `],
})
export class KardexProductoComponent {
  readonly warehouseId = input.required<string>();
  readonly sku = input.required<string>();
  /** Nombre del producto y existencia de hoy arriba: lo pide quien no los muestra ya en su panel. */
  readonly encabezado = input(false);
  readonly alto = input('20rem');

  private readonly api = inject(AlmacenMovimientosService);
  private readonly destroyRef = inject(DestroyRef);
  readonly kardex = signal<KardexNegativoResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  private sub: Subscription | null = null;

  /**
   * El saldo más bajo de lo que se muestra, si fue negativo. Sale cuando ya no está en negativo
   * (no hay «cruce»): sin esta línea, un producto que bajó a −145 y volvió a 0 se lee como «nunca
   * faltó nada» — el caso que la originó (83816 en Padre Hidalgo, 8-nov-2026).
   *
   * ⛔ Se mide al CIERRE de cada día, no renglón por renglón: `kdm2` sólo guarda la fecha (`c32`),
   * no la hora, y el kardex acomoda las entradas del día antes que sus salidas. El 9-nov el reporte
   * de Kepler pone el ticket ANTES de la recepción (−150) y este kardex después (−145): el orden
   * dentro del día no se sabe, y un mínimo intradía afirmaría uno de los dos. El saldo al cierre es
   * el mismo en cualquier orden.
   */
  readonly minimo = computed(() => {
    const rs = this.kardex()?.renglones ?? [];
    const cierre = new Map<string, number>();
    for (const r of rs) cierre.set(r.dia, r.saldo); // el último renglón del día es su cierre
    let m: { saldo: number; dia: string } | null = null;
    for (const [dia, saldo] of cierre) if (saldo < 0 && (!m || saldo < m.saldo)) m = { saldo, dia };
    return m;
  });

  constructor() {
    effect(() => {
      // Las dos lecturas van ANTES de cualquier condición: un effect que no las lee no se vuelve a correr.
      const wh = this.warehouseId();
      const sku = this.sku();
      untracked(() => this.cargar(wh, sku));
    });
  }

  reintentar(): void { this.cargar(this.warehouseId(), this.sku()); }

  private cargar(wh: string, sku: string): void {
    this.sub?.unsubscribe();
    this.kardex.set(null); this.error.set(null);
    if (!wh || !sku?.trim()) { this.cargando.set(false); return; }
    this.cargando.set(true);
    this.sub = this.api.negativeKardex(wh, sku.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (k) => { this.kardex.set(k); this.cargando.set(false); },
      // El 400 trae su motivo en llano («Esa sucursal no está en tu alcance.»): se dice tal cual.
      error: (e: { status?: number; error?: { message?: unknown } }) => {
        this.cargando.set(false);
        const msg = e?.error?.message;
        this.error.set(e?.status === 400 && typeof msg === 'string' ? msg : 'No se pudo leer el kardex de Kepler.');
      },
    });
  }

  iconoPista(t: TipoPista): string { return ICONO_PISTA[t]; }
  dia(f: string | null): string { return f ? diaCorto(f) : 'sin fecha'; }
  dinero(n: number | string): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
