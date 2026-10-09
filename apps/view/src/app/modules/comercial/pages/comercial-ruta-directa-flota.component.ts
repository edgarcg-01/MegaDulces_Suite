import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { ComercialService, RouteProfitFlota, RouteProfitUnidad } from '../comercial.service';

/**
 * `[RD.60]` — **La flota de Ruta Directa: lo que se sabe de cada camioneta, y lo que no.**
 *
 * Es la hoja `COSTO RD PH` / `COSTO RD CANINDO` del libro — la ficha de la unidad. Con una
 * diferencia que la pantalla dice en la cara: **el padrón está casi vacío**.
 *
 * ── Lo medido sobre los 56 vehículos vivos ───────────────────────────────────────────────
 *     placa y marca .......... 56 / 56
 *     modelo ................. 18 / 56
 *     año ....................  1 / 56
 *     VIN · nº económico · aseguradora · póliza · odómetro ...... 0 / 56
 *
 * ⛔ **Y no existe ninguna columna de vencimiento de seguro en toda la base.** El aviso por
 * póliza que pedía el libro no tiene dónde vivir todavía: ese dato está sólo en el Excel.
 *
 * ── ⭐ Lo que sí sale solo, y no estaba en el libro ───────────────────────────────────────
 * El **odómetro vivo** del GPS y los días sin reportar. Y los **vínculos sospechosos**: el
 * rastreador `CHEVROLET S10 NM8497D R-321` cuelga del vehículo de placa `MW7947C`, que es otra
 * camioneta — la ficha de esa ruta muestra una unidad que puede no ser la que anda.
 *
 * ── Por qué los huecos se ENUMERAN en vez de dejarse en blanco ───────────────────────────
 * Una ficha con cinco campos vacíos se lee como «la pantalla está pobre». La misma ficha
 * diciendo *«falta capturar: modelo, año, número de serie, aseguradora»* se lee como trabajo
 * pendiente, que es lo que es (ADR-056).
 */
@Component({
  selector: 'app-comercial-ruta-directa-flota',
  standalone: true,
  imports: [TagModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fl">
      <header class="fl-head">
        <div>
          <h1>La flota de Ruta Directa</h1>
          <p class="fl-sub">
            Una ficha por ruta con lo que el sistema sabe de su camioneta. Los kilómetros salen
            del rastreador; el resto se captura en Logística.
          </p>
        </div>
      </header>

      <app-load-state
        [loading]="cargando()" [isEmpty]="!data()" [skeletonRows]="6"
        emptyIcon="pi-truck" emptyTitle="Sin unidades"
        emptyHint="Ninguna ruta tiene rastreador asignado.">

        @if (data(); as d) {
          <section class="fl-resumen" aria-label="Estado del padrón">
            <div>
              <p class="fl-r-l">Unidades con rastreador</p>
              <p class="fl-r-v mono">{{ d.unidades.length }}</p>
            </div>
            <div>
              <p class="fl-r-l">Rutas sin rastreador</p>
              <p class="fl-r-v mono" [class.fl-warn]="d.rutas_sin_gps.length > 0">
                {{ d.rutas_sin_gps.length }}
              </p>
              @if (d.rutas_sin_gps.length) {
                <p class="fl-mini">{{ d.rutas_sin_gps.join(', ') }}</p>
              }
            </div>
            <div>
              <p class="fl-r-l">Fichas incompletas</p>
              <p class="fl-r-v mono" [class.fl-warn]="incompletas() > 0">{{ incompletas() }}</p>
              <p class="fl-mini">de {{ d.unidades.length }}</p>
            </div>
            <div>
              <p class="fl-r-l">Vínculos sospechosos</p>
              <p class="fl-r-v mono" [class.fl-bad]="sospechosas() > 0">{{ sospechosas() }}</p>
            </div>
          </section>

          @if (d.huecos.length) {
            <section class="fl-gaps" aria-label="Lo que falta en el padrón">
              <h2>Lo que falta, y dónde</h2>
              <ul>
                @for (h of d.huecos; track h.clave) {
                  <li><b>{{ etiquetaHueco(h.clave) }}</b> — {{ h.detalle }}</li>
                }
              </ul>
            </section>
          }

          <div class="fl-grid">
            @for (u of d.unidades; track u.route_code) {
              <article class="fl-card" [class.fl-card-bad]="u.vinculo_sospechoso">
                <header>
                  <div>
                    <p class="fl-r-l">Ruta {{ u.route_code }}@if (u.plaza) { · {{ u.plaza }} }</p>
                    <p class="fl-card-t">{{ u.marca || 'Sin marca' }} {{ u.placa || '' }}</p>
                    @if (u.chofer) { <p class="fl-mini">{{ u.chofer }}</p> }
                  </div>
                  @if (u.vinculo_sospechoso) {
                    <p-tag severity="danger" value="vínculo dudoso" />
                  } @else if (u.dias_sin_reportar !== null && u.dias_sin_reportar > 3) {
                    <p-tag severity="warn" [value]="u.dias_sin_reportar + ' días sin reportar'" />
                  }
                </header>

                <dl class="fl-dl">
                  <dt>Odómetro</dt>
                  <dd class="mono">{{ entero(u.odometro) }}</dd>
                  <dt>Último reporte</dt>
                  <dd class="mono">{{ dia(u.ultimo_visto) }}</dd>
                  <dt>Aparatos a bordo</dt>
                  <dd class="mono">
                    {{ u.aparatos }}
                    @if (u.aparatos > 1) { <span class="fl-nd">unidad y cámara</span> }
                  </dd>
                </dl>

                @if (u.vinculo_sospechoso) {
                  <p class="fl-alerta">
                    El rastreador se llama <b>{{ u.nombre_tracker }}</b> pero cuelga del vehículo
                    de placa <b>{{ u.placa }}</b>. Son placas distintas: esta ficha puede estar
                    mostrando una camioneta que no es la que anda. Se corrige en Logística.
                  </p>
                }

                @if (u.sin_capturar.length) {
                  <p class="fl-falta">
                    <b>Falta capturar:</b> {{ u.sin_capturar.join(', ') }}
                  </p>
                } @else {
                  <p class="fl-mini">Ficha completa.</p>
                }
              </article>
            }
          </div>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    .fl { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .fl-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .fl-sub { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--c-text-3); max-width: 72ch; line-height: 1.5; }

    .fl-resumen { display: flex; gap: 20px; flex-wrap: wrap;
      border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 16px; background: var(--card-bg); }
    .fl-r-l { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .fl-r-v { margin: 4px 0 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .fl-warn { color: var(--warn-fg); }
    .fl-bad { color: var(--bad-fg); }

    .fl-gaps { border: 1px solid var(--border-color); border-left: 3px solid var(--c-warn);
      border-radius: 8px; padding: 12px 14px; background: var(--card-bg); }
    .fl-gaps h2 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .fl-gaps ul { margin: 8px 0 0; padding-left: 18px; }
    .fl-gaps li { font-size: var(--fs-sm); color: var(--c-text-2); line-height: 1.6; }

    .fl-grid { display: flex; gap: 14px; flex-wrap: wrap; }
    .fl-card { flex: 1 1 290px; border: 1px solid var(--border-color); border-radius: 8px;
      padding: 14px 16px; background: var(--card-bg); }
    .fl-card-bad { border-left: 3px solid var(--bad-fg); }
    .fl-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .fl-card-t { margin: 3px 0 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .fl-dl { margin: 12px 0 0; display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; font-size: var(--fs-sm); }
    .fl-dl dt { color: var(--c-text-3); }
    .fl-dl dd { margin: 0; text-align: right; color: var(--c-text-2); }
    .mono { font-variant-numeric: tabular-nums; }
    .fl-nd { color: var(--c-text-3); font-size: var(--fs-micro); margin-left: 4px; }
    .fl-mini { margin: 4px 0 0; font-size: var(--fs-micro); color: var(--c-text-3); line-height: 1.5; }
    .fl-falta { margin: 10px 0 0; font-size: var(--fs-micro); color: var(--warn-fg); line-height: 1.55; }
    .fl-alerta { margin: 10px 0 0; font-size: var(--fs-micro); color: var(--bad-fg); line-height: 1.6; }
  `],
})
export class ComercialRutaDirectaFlotaComponent {
  private readonly svc = inject(ComercialService);

  readonly cargando = signal(true);
  readonly data = signal<RouteProfitFlota | null>(null);

  readonly incompletas = computed(() =>
    (this.data()?.unidades ?? []).filter((u: RouteProfitUnidad) => u.sin_capturar.length > 0).length);

  readonly sospechosas = computed(() =>
    (this.data()?.unidades ?? []).filter((u: RouteProfitUnidad) => u.vinculo_sospechoso).length);

  constructor() {
    this.svc.routeProfitFlota().subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: () => { this.data.set(null); this.cargando.set(false); },
    });
  }

  etiquetaHueco(c: string): string {
    const m: Record<string, string> = {
      padron_vacio: 'El padrón está casi vacío',
      sin_vencimiento_de_seguro: 'No hay dónde guardar el vencimiento del seguro',
      vinculo_sospechoso: 'Hay rastreadores mal vinculados',
      rutas_sin_gps: 'Hay rutas sin rastreador',
    };
    return m[c] ?? c;
  }

  entero(v: string | number | null): string {
    if (v === null || v === undefined || v === '') return 'sin medir';
    return Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 }) + ' km';
  }

  dia(iso: string | null): string {
    if (!iso) return 'sin medir';
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }
}
