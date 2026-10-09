import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { RevisionGps, RevisionGpsEstado } from '@megadulces/contracts';

const ETIQUETA: Readonly<Record<RevisionGpsEstado, string>> = {
  coincide: 'Coincide con el GPS',
  difiere: 'Difiere del GPS',
  no_medible: 'No se pudo revisar',
  en_curso: 'Viaje en curso',
};

/**
 * EMB.21 — Lo capturado en la guía contra lo que marca el GPS de la unidad, de sólo lectura.
 * Aquí no se corrige nada: si difiere, se dice qué y cuánto, y quien revisa decide. Lo que no se
 * pudo medir dice POR QUÉ; nunca se pinta como «coincide» (ADR-056).
 */
@Component({
  selector: 'app-revision-gps',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rg" aria-labelledby="rg-titulo">
      <header class="rg-head">
        <h3 id="rg-titulo" class="cell-label">Revisión con GPS</h3>
        @if (revision(); as r) {
          <span class="rg-pill" [attr.data-estado]="r.estado">{{ etiqueta() }}</span>
        }
      </header>

      @if (cargando()) {
        <p class="rg-nota" role="status">Revisando el recorrido de la unidad…</p>
      } @else if (error()) {
        <p class="rg-nota rg-mal" role="alert">No se pudo revisar: {{ error() }}</p>
      } @else if (revision(); as r) {
        @if (r.motivo) { <p class="rg-nota">{{ r.motivo }}</p> }
        @if (r.capturado || r.gps) {
          <div class="rg-wrap dt-scope">
            <table class="rg-table dt-stack">
              <caption class="sr-only">Lo capturado en la guía contra lo que marca el GPS</caption>
              <thead>
                <tr><th scope="col">Dato</th><th scope="col">Capturado</th><th scope="col">GPS</th></tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" role="rowheader" data-label="Dato" class="dt-id">Salida</th>
                  <td data-label="Capturado" role="cell" class="num">{{ r.capturado?.salida ?? '—' }}</td>
                  <td data-label="GPS" role="cell" class="num">{{ r.gps?.salida ?? '—' }}</td>
                </tr>
                <tr>
                  <th scope="row" role="rowheader" data-label="Dato" class="dt-id">Llegada</th>
                  <td data-label="Capturado" role="cell" class="num">{{ r.capturado?.llegada ?? '—' }}</td>
                  <td data-label="GPS" role="cell" class="num">{{ r.gps?.llegada ?? '—' }}</td>
                </tr>
                <tr>
                  <th scope="row" role="rowheader" data-label="Dato" class="dt-id">Durmió fuera</th>
                  <td data-label="Capturado" role="cell">{{ r.capturado ? (r.capturado.duerme_fuera ? 'Sí' : 'No') : '—' }}</td>
                  <td data-label="GPS" role="cell">{{ r.gps ? (r.gps.duerme_fuera ? 'Sí' : 'No') : '—' }}</td>
                </tr>
                <tr>
                  <th scope="row" role="rowheader" data-label="Dato" class="dt-id">Kilómetros</th>
                  <td data-label="Capturado" role="cell" class="num">{{ r.capturado?.km ?? '—' }}</td>
                  <td data-label="GPS" role="cell" class="num">
                    {{ r.gps?.km ?? '—' }}
                    @if (r.gps?.km_metodo === 'trazo') { <span class="rg-sub">por trazo: el odómetro no es creíble</span> }
                  </td>
                </tr>
                <tr>
                  <th scope="row" role="rowheader" data-label="Dato" class="dt-id">Viáticos</th>
                  <td data-label="Capturado" role="cell" class="num">{{ r.capturado?.viaticos != null ? (r.capturado!.viaticos! | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td data-label="GPS" role="cell" class="num">{{ r.gps?.viaticos != null ? (r.gps!.viaticos! | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        }
        @if (r.diferencias.length) {
          <ul class="rg-dif">
            @for (d of r.diferencias; track d) { <li>{{ d }}</li> }
          </ul>
        }
        <p class="rg-pie">Se marca diferencia si una hora se separa más de {{ r.tolerancias.minutos }} min, si los kilómetros se separan más del {{ r.tolerancias.km * 100 | number:'1.0-0' }}% o si cambian los viáticos.</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rg { display: flex; flex-direction: column; gap: .5rem; }
    .rg-head { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .rg-head h3 { margin: 0; }
    .rg-pill { font-size: var(--fs-xs); font-weight: var(--fw-medium); padding: .15rem .55rem; border-radius: var(--r-sm); background: var(--c-surface-2); color: var(--c-text-2); }
    .rg-pill[data-estado="coincide"] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .rg-pill[data-estado="difiere"] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .rg-nota { margin: 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .rg-mal { color: var(--bad-soft-fg); }
    .rg-wrap { overflow-x: auto; }
    .rg-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .rg-table th, .rg-table td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid var(--c-divider); }
    .rg-table thead th { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); }
    .rg-table tbody th { font-weight: var(--fw-medium); }
    .rg-table .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rg-sub { display: block; font-family: var(--font-body); font-size: var(--fs-xs); color: var(--c-text-2); }
    .rg-dif { margin: 0; padding-left: 1rem; font-size: var(--fs-sm); color: var(--bad-soft-fg); }
    .rg-pie { margin: 0; font-size: var(--fs-xs); color: var(--c-text-2); }
  `],
})
export class RevisionGpsComponent {
  readonly revision = input<RevisionGps | null>(null);
  readonly cargando = input(false);
  readonly error = input<string | null>(null);

  readonly etiqueta = computed(() => {
    const r = this.revision();
    return r ? ETIQUETA[r.estado] : '';
  });
}
