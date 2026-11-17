import { ChangeDetectionStrategy, Component, EventEmitter, Output, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { FactorajeCompare } from '../../bank.service';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * `[CB.78]` Bancos › Más › **Factoraje**: las compras a proveedores liquidadas por factoraje, contra ese proveedor en
 * ContPAQi. Es lo único propio de esta pestaña.
 *
 * Antes («vs ContPAQi», CP.2) abría con banco ↔ ContPAQi —totales, detalle por cuenta, detalle movimiento a
 * movimiento— y el factoraje quedaba tercero. Esas cifras son las mismas que la columna ContPAQi del Cuadre 3 vías
 * (`threeWay` llama a `contpaqiCompare`), que además las abre movimiento a movimiento con las tres fuentes. Medido en
 * 30 días: 3 consultas a esta pestaña, 0 al detalle y 0 enlaces. El enlace cuenta de banco ↔ cuenta 102xxx se mudó a
 * Configuración › Cuentas de banco, que es donde el Cuadre ya mandaba a buscarlo.
 *
 * Cinco preguntas (diseno §0b): (1) ve primero el total del mes y cuántos proveedores se identificaron; (2) no ve el
 * cuadre banco ↔ libros (vive en Cuadre 3 vías); (3) la tabla por proveedor, sin clics; (4) viene del libro (cuenta de
 * factoraje) y va al proveedor en ContPAQi; (5) le toca a Bancos: es dinero que no pasa por banco.
 */
@Component({
  selector: 'bancos-factoraje',
  standalone: true,
  imports: [CommonModule, TableModule, LoadStateComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <app-load-state [error]="error()" (retry)="reintentar.emit()"></app-load-state>
    } @else if (factoraje(); as f) {
      <div class="card-premium card-flat fb-tablewrap">
        <h3 class="fb-card-title fb-pnl-title">Factoraje a proveedores <span class="muted">— {{ f.period }}</span></h3>
        @if (!f.rows.length) {
          <div class="surf-empty"><i class="pi pi-inbox" aria-hidden="true"></i><p>Sin compras con factoraje en {{ f.period }}.</p></div>
        } @else {
          <app-metric-strip [items]="kpis(f)" ariaLabel="Factoraje del periodo" />
          <p class="fb-plain fjt-lead">Se pagan por una línea de factoraje, no desde un banco: por eso no aparecen en el Cuadre 3 vías. Contra el proveedor en ContPAQi es <b>contexto</b> —los montos difieren por IVA y momento de registro—, no un cuadre exacto.</p>
          <p-table [value]="f.rows" dataKey="proveedor" selectionMode="single" [(selection)]="fila" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
            <ng-template #header>
              <tr>
                <th>Proveedor</th>
                <th class="ta-r">Factoraje (libro)</th>
                <th class="ta-c">Movs</th>
                <th>CxP ContPAQi</th>
                <th class="ta-r">Costo ContPAQi</th>
                <th class="ta-c">En ContPAQi</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr [pSelectableRow]="r">
                <td><span class="fb-strong">{{ r.proveedor }}</span></td>
                <td class="ta-r mono">{{ r.excel_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-c mono muted">{{ r.movs }}</td>
                <td class="mono muted">
                  @if (r.cxp_cuenta) { {{ r.cxp_cuenta }} <span class="fjt-mini">{{ r.cxp_nombre }} · mes {{ r.cxp_cargos | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> }
                  @else { — }
                </td>
                <td class="ta-r mono">
                  @if (r.costo_cuentas) { {{ r.costo_cargos | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                  @else { <span class="muted">—</span> }
                </td>
                <td class="ta-c">
                  @if (r.matched) { <i class="pi pi-check-circle ok" aria-hidden="true"></i><span class="sr-only">identificado</span> }
                  @else { <span class="cpq-tag muted-tag">sin identificar</span> }
                </td>
              </tr>
            </ng-template>
          </p-table>
        }
      </div>
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox" aria-hidden="true"></i><p>Sin datos de factoraje para {{ period() }}.</p></div>
    }
  `,
  styles: [BANCOS_STYLES, `
    :host { display: block; }
    .cpq-tag { display: inline-block; font-size: var(--fs-micro); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-transform: uppercase; letter-spacing: .03em; }
    .muted-tag { background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    .fjt-lead { padding: 0 var(--sp-3); margin: 0 0 var(--sp-3); }
    .fjt-mini { font-size: var(--fs-micro); color: var(--text-faint); }
  `],
})
export class BancosFactorajeComponent {
  readonly factoraje = input<FactorajeCompare | null>(null);
  readonly period = input<string>('');
  /** No se pudo leer: antes el error se callaba y el bloque desaparecía (se leía como «sin factoraje»). */
  readonly error = input<string | null>(null);
  @Output() reintentar = new EventEmitter<void>();
  /** La fila con el foco del teclado (flechas): sólo resalta, no dispara nada. */
  fila: unknown = null;

  kpis(f: FactorajeCompare): MetricStripItem[] {
    return [
      { label: 'Factoraje del mes', value: f.totals.excel_out, format: 'currency' },
      { label: 'Proveedores', value: f.rows.length, format: 'number' },
      { label: 'Identificados en ContPAQi', value: f.matched, format: 'number', tone: f.matched < f.rows.length ? 'warn' : 'ok' },
      { label: 'Costo ContPAQi de esos proveedores', value: f.totals.costo_cargos, format: 'currency' },
    ];
  }
}
