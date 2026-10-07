import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuideRecipient, NuevoEmbarqueHoja, NuevoEmbarqueParada } from '../logistica.service';

/**
 * `kdm1.c43` de la parada en palabras: F y R traen factura hija `U-D-8`, N no; A no está
 * decodificado (ERP_KEPLER.md §3.y) y por eso no se adivina.
 */
export function facturaLabel(p: Pick<NuevoEmbarqueParada, 'facturado' | 'facturacion'>): string {
  if (p.facturado) return 'Sí';
  return p.facturacion === 'N' ? 'No' : '—';
}

/**
 * EMB.12 — Las paradas del viaje tal como salieron de Kepler. Sólo lectura: es parte de la hoja
 * de embarque, donde lo que viene de Kepler ya está escrito y no se toca.
 *
 * La última columna es la nota de almacén al tomar el viaje; con `entregas`, en el embarque ya
 * creado, es lo que el chofer registró en cada parada.
 */
@Component({
  selector: 'app-kepler-paradas',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let h = hoja();
    <div class="kp dt-scope">
      <table class="kp-table dt-stack">
        <thead>
          <tr>
            <th scope="col">Ruta</th>
            <th scope="col" class="num">Orden</th>
            <th scope="col">Documento</th>
            <th scope="col">Cliente</th>
            <th scope="col" class="num">Cajas</th>
            <th scope="col" class="num">Sueltos</th>
            <th scope="col" class="num">Kg</th>
            <th scope="col" class="num">Valor</th>
            <th scope="col">Factura</th>
            @if (conEntregas()) { <th scope="col">Entrega</th> } @else { <th scope="col">Nota de almacén</th> }
          </tr>
        </thead>
        <tbody>
          @for (p of h.paradas; track p.folio_digital) {
            <tr>
              <td data-label="Ruta" role="cell" class="dt-id">{{ p.ruta_nombre || '—' }}</td>
              <td data-label="Orden" role="cell" class="num dt-num">{{ p.orden_visita ?? '—' }}</td>
              <td data-label="Documento" role="cell">
                <code>{{ p.folio_digital }}</code>
                @if (p.pedido_folio) { <span class="kp-sub">pedido {{ p.pedido_folio }}</span> }
              </td>
              <td data-label="Cliente" role="cell">
                {{ p.destino_nombre || p.cliente_code || '—' }}
                <span class="kp-sub">{{ p.destino_ciudad || p.domicilio_ciudad || '' }}</span>
              </td>
              <td data-label="Cajas" role="cell" class="num dt-num">{{ p.cajas ?? '—' }}</td>
              <td data-label="Sueltos" role="cell" class="num dt-num">{{ p.sueltos ? p.sueltos : '—' }}</td>
              <td data-label="Kg" role="cell" class="num dt-num">{{ p.kg ?? '—' }}</td>
              <td data-label="Valor" role="cell" class="num dt-num">{{ p.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td data-label="Factura" role="cell">{{ factura(p) }}</td>
              @if (conEntregas()) {
                <td data-label="Entrega" role="cell">{{ entregaLabel(entregaDe(p)) }}</td>
              } @else {
                <td data-label="Nota de almacén" role="cell"><span class="kp-nota">{{ p.nota_almacen || '—' }}</span></td>
              }
            </tr>
          }
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colspan="4">Total · {{ h.resumen.paradas }} parada{{ h.resumen.paradas === 1 ? '' : 's' }}</th>
            <td class="num">{{ h.resumen.cajas | number:'1.0-0' }}</td>
            <td class="num">{{ h.resumen.sueltos | number:'1.0-0' }}</td>
            <td class="num">{{ h.resumen.kg_vendido_por_kilo ?? '—' }}</td>
            <td class="num">{{ (h.resumen.valor_venta + h.resumen.valor_traspaso) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .kp { overflow-x: auto; }
    .kp-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .kp-table th { text-align: left; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); padding: .45rem .5rem; border-bottom: 1px solid var(--c-divider); }
    .kp-table td { padding: .45rem .5rem; border-bottom: 1px solid var(--c-surface-2); vertical-align: top; }
    .kp-table code { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .kp-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .kp-table tfoot th, .kp-table tfoot td { font-weight: var(--fw-bold); border-top: 1px solid var(--c-divider); border-bottom: 0; color: var(--c-text-1); text-transform: none; letter-spacing: 0; font-size: var(--fs-sm); }
    .kp-sub { display: block; font-size: var(--fs-xs); color: var(--c-text-2); }
    .kp-nota { font-family: var(--font-mono); font-size: var(--fs-xs); }
  `],
})
export class KeplerParadasComponent {
  readonly hoja = input.required<NuevoEmbarqueHoja>();
  /** En el embarque ya creado: los destinatarios de la guía, con lo que registró el chofer. */
  readonly entregas = input<GuideRecipient[] | null>(null);

  readonly conEntregas = computed(() => this.entregas() !== null);
  private readonly entregaPorFolio = computed(() => {
    const m = new Map<string, string>();
    for (const r of this.entregas() ?? []) if (r.kepler_folio) m.set(`${r.kepler_serie}|${r.kepler_folio}`, r.status);
    return m;
  });

  factura(p: NuevoEmbarqueParada) { return facturaLabel(p); }

  entregaDe(p: NuevoEmbarqueParada): string {
    return this.entregaPorFolio().get(`${p.serie}|${p.folio}`) ?? 'sin_guia';
  }

  entregaLabel(s: string): string {
    return ({
      pendiente: 'Pendiente', entregado: 'Entregado', no_entregado: 'No entregado',
      rechazado: 'Rechazado', sin_guia: '—',
    } as Record<string, string>)[s] ?? s;
  }
}
