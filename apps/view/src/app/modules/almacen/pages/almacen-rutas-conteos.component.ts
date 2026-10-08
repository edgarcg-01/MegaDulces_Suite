import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ComercialService, RouteCountSheetRow } from '../../comercial/comercial.service';

/**
 * `[RD.45]` **Inventarios RD — el índice: qué camión se cuenta.**
 *
 * La pantalla que sustituye a «imprimir la hoja». Una fila por ruta con lo que el camión declara
 * de sí mismo hoy (la foto), cuántos renglones hay que recorrer y cuándo fue la última vez que
 * alguien lo contó de verdad.
 *
 * ⛔ **Las 11 rutas, no las 10 que tienen foto.** La 505 lleva sin mover desde el 10-sep y sin
 * reportar existencia; esconderla haría ver una flota de diez camiones sana en lugar de una de
 * once con uno apagado (ADR-056). Sale declarada y sin botón: no se puede contar contra nada.
 *
 * ⚠️ **«Nunca contada» y «contada hace 0 días» no son lo mismo**, y por eso `dias_desde_conteo`
 * llega `null` en el primer caso en vez de un cero que se leería como «recién contada».
 */
@Component({
  selector: 'app-almacen-rutas-conteos',
  standalone: true,
  imports: [CommonModule, RouterLink, ButtonModule, TableModule, TagModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Inventarios de Ruta Directa</h1>
          <p class="surf-page-sub">
            Elegí el camión y contá renglón por renglón. Lo que la pantalla pone enfrente es
            <strong>lo que la camioneta declara de sí misma</strong> — la misma hoja que hoy se
            imprime, sin papel y sin regla.
          </p>
        </div>
      </header>

      @if (cargando()) {
        <div class="rc-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando las rutas…</div>
      } @else if (error()) {
        <div class="rc-msg rc-bad">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}
        </div>
      } @else {
        <div class="rc-kpis">
          <div class="rc-kpi">
            <span class="rc-kpi-n">{{ contables().length }}</span>
            <span class="rc-kpi-l">Camiones contables</span>
          </div>
          <div class="rc-kpi">
            <span class="rc-kpi-n">{{ renglonesTotales() | number }}</span>
            <span class="rc-kpi-l">Renglones en total</span>
          </div>
          <div class="rc-kpi" [class.rc-warn]="nuncaContadas() > 0">
            <span class="rc-kpi-n">{{ nuncaContadas() }}</span>
            <span class="rc-kpi-l">Nunca contados</span>
          </div>
          <div class="rc-kpi" [class.rc-bad]="sinFoto().length > 0">
            <span class="rc-kpi-n">{{ sinFoto().length }}</span>
            <span class="rc-kpi-l">Sin reportar</span>
          </div>
        </div>

        <!-- ⚠️ El dt-scope va en el CONTENEDOR y no en la tabla: un elemento no puede ser
             su propio contenedor de consulta, así que con dt-stack sin un dt-scope
             alrededor la consulta no mide nada y el apilado NUNCA ocurre. La tabla se veía
             igual de rota en pantalla angosta, pero la compuerta la daba por resuelta.
             (Sin acentos graves acá: adentro de un template literal parten el archivo.) -->
        <div class="dt-scope">
        <!-- PrimeNG 22: la clase va en el host y las plantillas se nombran con #; con
             styleClass + pTemplate la tabla carga los datos y no dibuja ni una fila. -->
        <p-table [value]="filas()" dataKey="route_no" [scrollable]="true"
                 class="dt-stack surf-table surf-table--sticky surf-table--frozen-first"
                 size="small" [rowHover]="true" [tableStyle]="{ 'min-width': '48rem' }">
          <ng-template #header>
            <tr>
              <th>Ruta</th>
              <th>Lo que declara</th>
              <th class="rc-num">Renglones</th>
              <th class="rc-num">Importe</th>
              <th>Último conteo</th>
              <th class="rc-acc"></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr [class.rc-row-off]="!r.renglones">
              <td class="rc-ruta" data-label="Ruta" role="cell">{{ r.route_no }}</td>
              <td data-label="Lo que declara" role="cell">
                @if (r.foto_fecha) {
                  <span class="rc-fecha">{{ r.foto_fecha }}</span>
                  @if (r.aceptada === false) {
                    <p-tag severity="warn" value="foto dudosa" [pTooltip]="r.motivo || ''"></p-tag>
                  }
                } @else {
                  <!-- Sin foto NO es cero: es sin medir. El rotulo lo dice con palabras. -->
                  <span class="rc-nada" pTooltip="La camioneta no ha reportado su existencia. No hay contra qué contar.">
                    no reportó
                  </span>
                }
              </td>
              <td class="rc-num" data-label="Renglones" role="cell">{{ r.renglones ? (r.renglones | number) : '—' }}</td>
              <td class="rc-num" data-label="Importe" role="cell">{{ r.importe != null ? (r.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
              <td data-label="Último conteo" role="cell">
                @if (r.ultimo_conteo) {
                  {{ r.ultimo_conteo }}
                  <small class="rc-dias">{{ etiquetaDias(r.dias_desde_conteo) }}</small>
                } @else {
                  <span class="rc-nunca">nunca</span>
                }
              </td>
              <td class="rc-acc" data-label="" role="cell">
                @if (r.renglones) {
                  <a pButton size="small" [routerLink]="['/almacen/rutas/contar', r.route_no]">
                    <span class="p-button-icon p-button-icon-left pi pi-list-check" aria-hidden="true"></span>
                    Contar
                  </a>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
        </div>

        <p class="rc-pie">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Un conteo <strong>reemplaza</strong> lo que la pantalla publica de esa ruta: lo que no
          aparezca en la hoja queda en cero. Por eso sólo se puede cerrar completo.
        </p>
      }
    </div>
  `,
  styles: [`
    .rc-msg { display: flex; align-items: center; gap: .5rem; padding: 1.5rem; color: var(--text-muted); }
    .rc-msg.rc-bad { color: var(--bad-fg); }
    .rc-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 0 0 1rem; }
    .rc-kpi { background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; }
    .rc-kpi-n { font-size: var(--fs-h2); font-weight: 800; font-variant-numeric: tabular-nums; }
    .rc-kpi-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .rc-kpi.rc-warn .rc-kpi-n { color: var(--warn-fg); }
    .rc-kpi.rc-bad .rc-kpi-n { color: var(--bad-fg); }
    .rc-ruta { font-weight: 800; font-variant-numeric: tabular-nums; }
    .rc-num { text-align: right; font-variant-numeric: tabular-nums; }
    .rc-acc { text-align: right; width: 1%; white-space: nowrap; }
    .rc-fecha { font-variant-numeric: tabular-nums; margin-right: .4rem; }
    .rc-nada, .rc-nunca { color: var(--text-muted); font-style: italic; }
    .rc-dias { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    /* La fila sin foto se atenua pero NO se esconde: tiene que verse que existe y que esta muda. */
    .rc-row-off { opacity: .62; }
    .rc-pie { display: flex; align-items: flex-start; gap: .5rem; margin-top: 1rem;
      font-size: var(--fs-xs); color: var(--text-muted); }
    @media (max-width: 52rem) { .rc-kpis { grid-template-columns: repeat(2, 1fr); } }
  `],
})
export class AlmacenRutasConteosComponent implements OnInit {
  private readonly api = inject(ComercialService);

  readonly filas = signal<RouteCountSheetRow[]>([]);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);

  readonly contables = computed(() => this.filas().filter((r) => r.renglones > 0));
  readonly sinFoto = computed(() => this.filas().filter((r) => !r.renglones));
  readonly renglonesTotales = computed(() => this.contables().reduce((a, r) => a + r.renglones, 0));
  readonly nuncaContadas = computed(() => this.contables().filter((r) => !r.ultimo_conteo).length);

  ngOnInit(): void {
    this.api.routeCountSheets().subscribe({
      next: (rs) => { this.filas.set(rs); this.cargando.set(false); },
      error: (e) => {
        this.error.set(e?.error?.message || 'No se pudieron cargar las rutas.');
        this.cargando.set(false);
      },
    });
  }

  /** `null` = nunca se contó, y eso ya lo dice la celda; acá sólo la antigüedad. */
  etiquetaDias(dias: number | null): string {
    if (dias == null) return '';
    if (dias === 0) return 'hoy';
    return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
  }
}
