import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import type { DesgloseDeOperacion, EstadoRecepcion, ResponsableKepler, TipoParadaKepler } from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import { ESTADO_RECEPCION_LABEL } from '@megadulces/contracts/http/cierre-viaje';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';

/**
 * `[EMB.50]` `[EMB.51]` — **El movimiento de una operación, documento por documento.**
 *
 * Pieza compartida: la abren «Operaciones» (el panel de la guía) y «Por persona» (al hacer clic
 * en una guía de la solicitud), así que las dos dicen lo mismo con las mismas palabras. Sólo
 * pinta: quien la usa pide el desglose (`GET …/operaciones/:sucursal/:guia/desglose`).
 *
 * Por documento: cajas y sueltas (la misma regla que el reporte), quién surtió/checó/embarcó, quién
 * lo capturó, la recepción en destino (traspasos) y, desplegable, sus productos.
 */
@Component({
  selector: 'app-desglose-operacion',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe, TableModule, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (desglose(); as d) {
      <p class="do-sub">{{ d.documentos.length }} documento{{ d.documentos.length === 1 ? '' : 's' }} ·
        {{ d.cajas | number:'1.0-2' }} cajas@if (d.sueltos) { · {{ d.sueltos | number:'1.0-2' }} sueltas }</p>
      <ul class="do-docs">
        @for (doc of d.documentos; track doc.serie + '|' + doc.folio) {
          <li class="do-doc">
            <div class="do-cab">
              <span><span class="do-folio">{{ doc.folio }}</span> · {{ tipoParada(doc.tipo) }} · {{ doc.destino || '—' }}</span>
              <span class="do-num">{{ doc.cajas | number:'1.0-2' }} cajas@if (doc.sueltos) { · {{ doc.sueltos | number:'1.0-2' }} sueltas }</span>
            </div>
            <dl class="do-quien">
              <div><dt>Surtió</dt><dd>{{ persona(doc.surtio) }}</dd></div>
              <div><dt>Checó</dt><dd>{{ persona(doc.checo) }}</dd></div>
              <div><dt>Embarcó</dt><dd>{{ persona(doc.embarco) }}</dd></div>
              <div><dt>Capturó en Kepler</dt><dd>{{ doc.capturo ? 'usuario ' + doc.capturo : '—' }}@if (doc.hora_captura) { · {{ doc.hora_captura }} }</dd></div>
            </dl>
            @if (doc.recepcion; as r) {
              <p class="do-rec">
                <span [class]="'do-estado do-estado-' + r.estado">{{ estadoRecepcion(r.estado) }}</span>
                Recepción en {{ r.sucursal ? (r.sucursal | sucursal) : 'destino desconocido' }}@if (r.folio) {: folio {{ r.folio }} del {{ fechaCorta(r.fecha) }}, capturó el usuario {{ r.capturo || '—' }} }@if (r.diferencia) { · diferencia {{ r.diferencia | currency:'MXN':'symbol-narrow':'1.2-2' }} }
              </p>
            }
            <details class="do-det">
              <summary>{{ doc.renglones.length }} producto{{ doc.renglones.length === 1 ? '' : 's' }}</summary>
              <div class="dt-scope">
                <p-table [value]="doc.renglones" size="small" class="surf-table surf-table--plain dt-stack">
                  <ng-template #header>
                    <tr><th scope="col">Producto</th><th scope="col" class="comm-num">Cantidad</th><th scope="col">Presentación</th><th scope="col" class="comm-num">Cajas</th></tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr>
                      <td data-label="Producto">{{ r.producto || r.sku }}<span class="do-sub">{{ r.sku }}@if (r.sin_carga) { · no se carga }</span></td>
                      <td data-label="Cantidad" class="comm-num">{{ r.cantidad == null ? '—' : (r.cantidad | number:'1.0-2') }}</td>
                      <td data-label="Presentación">{{ r.presentacion || 'sin presentación' }}</td>
                      <td data-label="Cajas" class="comm-num">{{ r.cajas | number:'1.0-2' }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            </details>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    :host { display: block; }
    .do-sub { display: block; margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .do-docs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .do-doc { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .do-cab { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-sm); }
    .do-folio { font-family: var(--font-mono); font-weight: var(--fw-medium); }
    .do-num { font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
    .do-quien { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: var(--sp-1) var(--sp-3); margin: var(--sp-2) 0 0; }
    .do-quien dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .do-quien dd { margin: 0; font-size: var(--fs-sm); }
    .do-rec { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); }
    .do-estado { font-weight: var(--fw-medium); margin-right: var(--sp-1); }
    .do-estado-cerrada { color: var(--ok-soft-fg); }
    .do-estado-faltante, .do-estado-sobrante, .do-estado-pendiente, .do-estado-destino_desconocido { color: var(--warn-soft-fg); }
    .do-det { margin-top: var(--sp-2); }
    .do-det summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-muted); }
    .do-det summary:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
  `],
})
export class DesgloseOperacionComponent {
  readonly desglose = input<DesgloseDeOperacion | null>(null);

  tipoParada(t: TipoParadaKepler): string {
    return ({ cliente: 'Entrega a cliente', traspaso: 'Traspaso', carga_ruta: 'Carga a ruta (no paga)' } as const)[t];
  }
  /** Una persona de un catálogo de Kepler; sin nombre se dice la clave, no se inventa. */
  persona(p: ResponsableKepler): string {
    if (p.nombre) return p.nombre;
    return p.codigo ? `clave ${p.codigo} (sin nombre en Kepler)` : '—';
  }
  estadoRecepcion(e: EstadoRecepcion): string {
    return ESTADO_RECEPCION_LABEL[e] ?? e;
  }
  fechaCorta(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }
}
