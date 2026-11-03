import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CaosService, RutaCajaDeposito, RutaCajaFila, RutaCajaReporte } from '../../finanzas/caos.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

/**
 * `[CG.58.7]` — **La liga de la ruta con su dinero: depósito en CAOS → entrada a Caja General.**
 *
 * Panel colapsable dentro de `/comercial/ventas-por-ruta`, sólo lectura.
 *
 * ── Qué cadena muestra ───────────────────────────────────────────────────────────────────────
 *
 *     el repartidor deposita en la caja fuerte (CAOS)  →  alguien captura esa entrada en Caja
 *     General, y Caja General guarda de QUÉ depósito salió
 *
 * El segundo tramo es estructural: la entrada lleva `origen_ref = device|external_id`, la llave
 * natural del movimiento de CAOS. Por eso el folio de Caja General es un **enlace**, no una
 * coincidencia. ⛔ Y no se podía casar por monto: medido en prod, **no coinciden** (depósito
 * #1590 `$13,800` ↔ entrada `$14,370`) porque el depósito es efectivo contado en múltiplos de 10
 * y la entrada es el cobro con sus centavos. La columna «Δ» publica esa diferencia en vez de
 * esconderla.
 *
 * ── Lo que se declara (ADR-056) ──────────────────────────────────────────────────────────────
 *
 * Medido sobre los 749 depósitos de prod (may→oct 2026, $18,360,140):
 *
 *     ruta y día     551   $10,011,860   54.5%
 *     plaza           76   $ 5,173,790   28.2%   (no se baja a una ruta: sería inventar)
 *     sin declarar    69   $ 2,030,000   11.1%
 *     vecinal         21   $   640,410    3.5%   (otro circuito: tiene su panel arriba)
 *     sólo ruta       32   $   504,080    2.7%
 *
 * y **18 de 749 ($280,600) están capturados en Caja General**. Lo pendiente se dice como
 * pendiente: no es un cero ni un descuadre, es que Caja General arrancó hace días.
 *
 * `[CG.58.8]` (2026-11-03): la liga es también `caos_cash_links` —el depósito ligado a los
 * cobros de sus rutas—, que este panel no leía: publicaba 30 de 141 depósitos ligados. Cada
 * depósito trae ahora TODAS sus entradas (`ligas`), la ruta sale de la liga cuando el texto no
 * la dice, y lo anterior al primer ingreso de Caja General se cuenta aparte, no como pendiente.
 */
@Component({
  selector: 'app-ruta-caja-caos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  template: `
    <section class="rc-panel">
      <button type="button" class="rc-head" (click)="toggle()" [attr.aria-expanded]="open()">
        <i class="pi" [class.pi-chevron-right]="!open()" [class.pi-chevron-down]="open()" aria-hidden="true"></i>
        <span class="rc-title">El depósito de la ruta: caja fuerte (CAOS) y su entrada a Caja General</span>
        <app-context-help topic="deposito-ruta-caos" (click)="$event.stopPropagation()" />
        @if (data(); as d) {
          <span class="rc-badges">
            <p-tag [value]="d.resumen.en_caja_general + ' en Caja General'"
                   [severity]="d.resumen.en_caja_general ? 'success' : 'secondary'" />
            @if (d.resumen.pendientes) {
              <p-tag [value]="d.resumen.pendientes + ' sin capturar'" severity="warn" />
            }
          </span>
        }
        <span class="rc-hint">rutas directas · la vecinal va aparte</span>
      </button>

      @if (open()) {
        <div class="rc-body">
          <div class="rc-filters">
            <label>Desde <input type="date" [ngModel]="from()" (ngModelChange)="from.set($event); reload()" [max]="to()" /></label>
            <label>Hasta <input type="date" [ngModel]="to()" (ngModelChange)="to.set($event); reload()" [max]="today" /></label>
            @if (data(); as d) {
              <app-freshness-pill measures="data" [since]="d.data_as_of" label="CAOS" [staleAfterSec]="86400" />
            }
          </div>

          <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!filas().length"
                          [skeletonRows]="6" emptyIcon="pi-wallet"
                          emptyTitle="Ningún depósito a la caja fuerte en estas fechas"
                          emptyHint="Amplía el rango: la caja fuerte tiene movimientos desde mayo de 2026."
                          (retry)="reload()">
            @if (data(); as d) {
              <p class="rc-veredicto" [class]="'rc-v-' + veredicto().tono">
                <i class="pi" [class]="veredicto().icono" aria-hidden="true"></i>
                <span><strong>{{ veredicto().titulo }}</strong> {{ veredicto().cuerpo }}</span>
              </p>

              <app-metric-strip [items]="kpis()" ariaLabel="Depósitos de ruta en la caja fuerte" />

              <!-- dt-scope + dt-stack: el panel se embebe a anchos distintos segun el sidebar, y
                   cada columna es un campo del mismo registro. El dt-stack SIN el dt-scope no
                   apila nada: la consulta de contenedor no tiene contra que medir. -->
              <div class="dt-scope">
              <p-table [value]="filas()" class="dt-stack surf-table surf-table--plain surf-table--sticky"
                       size="small" [rowHover]="true" [scrollable]="true" scrollHeight="34vh"
                       [tableStyle]="{ 'min-width': '60rem' }"
                       dataKey="clave" [expandedRowKeys]="abiertas()">
                <ng-template #header>
                  <tr>
                    <th style="width:2.5rem"></th>
                    <th>A quién se le atribuye</th>
                    <th>Sucursal</th>
                    <th class="comm-num">Depósitos</th>
                    <th class="comm-num">Depositado</th>
                    <th class="comm-num">En Caja General</th>
                    <th class="comm-num">Sin capturar</th>
                    <th class="comm-num">Antes de Caja General</th>
                  </tr>
                </ng-template>
                <ng-template #body let-f>
                  <tr [class.rc-aparte]="f.vecinal">
                    <td role="cell">
                      <button type="button" class="rc-exp" (click)="alternar(f.clave)"
                              [attr.aria-expanded]="!!abiertas()[f.clave]"
                              [attr.aria-label]="'Ver los depósitos de ' + f.etiqueta">
                        <i class="pi" [class.pi-chevron-right]="!abiertas()[f.clave]"
                           [class.pi-chevron-down]="!!abiertas()[f.clave]" aria-hidden="true"></i>
                      </button>
                    </td>
                    <td role="cell" data-label="A quién se le atribuye">
                      {{ f.etiqueta }}
                      @if (f.grano === 'plaza') { <p-tag value="sin ruta" severity="secondary" /> }
                      @if (f.vecinal) { <p-tag value="otro circuito" severity="secondary" /> }
                    </td>
                    <td role="cell" data-label="Sucursal">
                      @if (f.warehouse_code) {
                        <span class="rc-mono">{{ f.warehouse_code }}</span> {{ f.warehouse_name }}
                      } @else {
                        <span class="rc-tenue">{{ f.motivo_sucursal ?? 'sin resolver' }}</span>
                      }
                    </td>
                    <td class="comm-num rc-mono" role="cell" data-label="Depósitos">{{ f.depositos }}</td>
                    <td class="comm-num rc-mono" role="cell" data-label="Depositado">{{ money(f.monto_caos) }}</td>
                    <td class="comm-num rc-mono" role="cell" data-label="En Caja General">
                      @if (f.en_caja_general) { {{ money(f.monto_caja_general) }} }
                      @else { <span class="rc-tenue">—</span> }
                    </td>
                    <td class="comm-num rc-mono" role="cell" data-label="Sin capturar"
                        [class.rc-warn]="f.pendientes > 0">
                      @if (f.pendientes) { {{ money(f.monto_pendiente) }} }
                      @else { <span class="rc-ok">todo capturado</span> }
                    </td>
                    <td class="comm-num rc-mono rc-tenue" role="cell" data-label="Antes de Caja General">
                      @if (f.previos) { {{ money(f.monto_previo) }} } @else { — }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #expandedrow let-f>
                  <tr class="rc-detalle">
                    <td [attr.colspan]="8">
                      <table class="rc-sub">
                        <thead>
                          <tr>
                            <th>Depósito</th>
                            <th>Cuándo</th>
                            <th>Texto que tecleó</th>
                            <th>Día de venta</th>
                            <th class="comm-num">Depositado</th>
                            <th>Entrada a Caja General</th>
                            <th class="comm-num">Sin explicar</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (d of detalle(f.clave); track d.device + d.external_id) {
                            <tr>
                              <td class="rc-mono">#{{ d.external_id }}</td>
                              <td class="rc-mono">{{ d.occurred_at.slice(0, 16).replace('T', ' ') }}</td>
                              <td class="rc-mono rc-tenue">
                                {{ d.ref || '(sin referencia)' }}
                                @if (d.ruta_por === 'liga') { <p-tag [value]="'ruta ' + d.ruta + ' por su cobro'" severity="secondary" /> }
                              </td>
                              <td class="rc-mono">
                                @if (d.fecha_venta) { {{ d.fecha_venta }} }
                                @else { <span class="rc-tenue" [title]="d.motivo">no la declara</span> }
                              </td>
                              <td class="comm-num rc-mono">{{ money(d.monto_caos) }}</td>
                              <td>
                                @for (l of d.ligas; track l.folio) {
                                  <span class="rc-ligas">
                                    <span class="rc-mono">{{ l.folio }}</span>
                                    <span class="rc-tenue rc-mono">
                                      {{ l.fecha }} · {{ money(l.monto) }}@if (l.ruta && d.ligas.length > 1) { · ruta {{ l.ruta }} }
                                    </span>
                                  </span>
                                } @empty {
                                  <span class="rc-tenue">{{ d.estado_liga === 'previo' ? 'antes de Caja General' : 'sin capturar todavía' }}</span>
                                }
                                @if (d.cg_repetida) { <p-tag value="capturado dos veces" severity="danger" /> }
                                @if (d.ruta_contradice) {
                                  <p-tag [value]="'el cobro es de la ruta ' + d.rutas_ligadas.join(', ')" severity="warn" />
                                }
                              </td>
                              <td class="comm-num rc-mono" [class.rc-warn]="(d.delta ?? 0) < 0">
                                @if (d.delta === null) { <span class="rc-tenue">—</span> }
                                @else if (d.delta < 0) { {{ money(-d.delta) }} }
                                @else { <span class="rc-ok">completo</span> }
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              </div>

              <p class="rc-nota">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>
                  De qué ruta es cada depósito lo dice el <strong>texto que tecleó quien depositó</strong>;
                  si el texto no la dice y todas sus entradas en Caja General son cobros de una sola
                  ruta, la dice <strong>su liga</strong> ({{ d.resumen.ruta_por_liga }} depósitos).
                  @if (d.resumen.contradicen) {
                    En <strong>{{ d.resumen.contradicen }}</strong> el texto y la liga dicen rutas
                    distintas: manda el texto y la fila lo marca.
                  }
                  <strong>{{ d.resumen.plaza }}</strong> depósitos ({{ money(d.resumen.monto_plaza) }})
                  sólo nombran la plaza, y bajarlos a una ruta sería inventar;
                  <strong>{{ d.resumen.sin_declarar }}</strong> ({{ money(d.resumen.monto_sin_declarar) }})
                  no declaran nada; y <strong>{{ d.resumen.vecinal }}</strong>
                  ({{ money(d.resumen.monto_vecinal) }}) son de la vecinal, que se arquea en su caja
                  y tiene su propio panel arriba.
                  <strong>Sin explicar</strong> es la parte del depósito que todavía ninguna entrada
                  toma: no es faltante, es captura a medias.
                  @if (d.resumen.previos) {
                    Lo depositado antes del {{ d.cg_desde }}
                    (<strong>{{ d.resumen.previos }}</strong>, {{ money(d.resumen.monto_previo) }})
                    es anterior al primer ingreso de Caja General: no tiene entrada que ligar y no
                    se cuenta como pendiente.
                  }
                </span>
              </p>
            }
          </app-load-state>
        </div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .rc-panel { border: 1px solid var(--border-color); border-radius: var(--r-md); margin-bottom: var(--sp-4); overflow: hidden; }
    .rc-head { width: 100%; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 0; background: transparent; font: inherit; text-align: left; cursor: pointer; }
    .rc-head:hover { background: var(--overlay-hover); }
    .rc-head:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .rc-title { font-weight: var(--fw-bold); font-size: var(--fs-sm); color: var(--text-main); }
    .rc-badges { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
    .rc-hint { margin-left: auto; font-size: var(--fs-micro); color: var(--text-faint); }
    .rc-body { padding: var(--sp-3); border-top: 1px solid var(--border-color); }
    .rc-filters { display: flex; gap: var(--sp-4); align-items: center; flex-wrap: wrap; margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
    .rc-filters label { display: inline-flex; gap: var(--sp-1); align-items: center; color: var(--text-muted); }
    .rc-filters input { padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: transparent; color: var(--text-main); font: inherit; font-size: var(--fs-sm); }
    .rc-filters input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }

    .rc-veredicto { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0 0 var(--sp-3);
      padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-sm); color: var(--text-main); }
    .rc-veredicto .pi { margin-top: 2px; }
    .rc-v-ok   { border-color: color-mix(in srgb, var(--ok-fg) 38%, var(--border-color)); }
    .rc-v-warn { border-color: color-mix(in srgb, var(--warn-fg) 38%, var(--border-color)); }
    .rc-v-ok .pi   { color: var(--ok-fg); }
    .rc-v-warn .pi { color: var(--warn-fg); }

    .rc-exp { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; padding: var(--sp-1); line-height: 1; }
    .rc-exp:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; border-radius: var(--r-sm); }
    .rc-aparte td { opacity: .82; }

    .rc-detalle > td { padding: 0 !important; background: var(--overlay-subtle, transparent); }
    .rc-sub { width: 100%; border-collapse: collapse; font-size: var(--fs-micro); }
    .rc-sub th, .rc-sub td { padding: var(--sp-1) var(--sp-2); text-align: left; border-bottom: 1px solid var(--border-color); }
    .rc-sub th { color: var(--text-faint); font-weight: var(--fw-medium); }
    .rc-sub .comm-num { text-align: right; }

    .rc-ligas { display: inline-flex; gap: var(--sp-1); align-items: baseline; margin-right: var(--sp-2); white-space: nowrap; }

    .rc-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rc-tenue { color: var(--text-faint); }
    .rc-warn { color: var(--warn-fg); }
    .rc-ok { color: var(--text-faint); font-size: var(--fs-micro); }

    .rc-nota { display: flex; gap: var(--sp-2); align-items: flex-start; margin: var(--sp-3) 0 0;
      font-size: var(--fs-micro); color: var(--text-muted); line-height: 1.5; }
    .rc-nota .pi { margin-top: 2px; color: var(--text-faint); }
  `],
})
export class RutaCajaCaosComponent {
  private readonly api = inject(CaosService);

  readonly today = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  readonly from = signal<string>(new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10));
  readonly to = signal<string>(this.today);
  readonly open = signal(false);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<RutaCajaReporte | null>(null);
  readonly abiertas = signal<Record<string, boolean>>({});

  private loadedOnce = false;

  /**
   * Lee `data()` incondicionalmente: un `signal() && ...` que corta antes de leerlo deja al
   * computed sin dependencias y sin recalcular nunca. Hay compuerta de reactividad por eso.
   */
  readonly filas = computed<RutaCajaFila[]>(() => this.data()?.filas ?? []);

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const r = d.resumen;
    const atribuido = r.monto - r.monto_sin_declarar - r.monto_vecinal;
    return [
      { label: 'Depositado en la caja fuerte', value: r.monto, format: 'currency', sub: `${r.depositos} depósitos` },
      {
        label: 'Con entrada en Caja General', value: r.monto_caja_general, format: 'currency',
        tone: r.en_caja_general ? 'ok' : 'warn',
        sub: `${r.en_caja_general} de ${r.depositos - r.previos} depósitos desde ${d.cg_desde ?? '—'}`,
        state: r.pendientes ? 'parcial' : 'medido',
        stateNote: r.pendientes
          ? 'El resto todavía no se captura en Caja General: es pendiente, no descuadre'
          : undefined,
      },
      {
        label: 'Atribuido a una ruta o plaza', value: atribuido, format: 'currency',
        tone: 'ok',
        sub: `${r.depositos - r.sin_declarar - r.vecinal} depósitos`,
        state: r.sin_declarar ? 'parcial' : 'medido',
        stateNote: r.sin_declarar
          ? `${r.sin_declarar} depósitos no declaran de quién son`
          : undefined,
      },
      {
        label: 'Sin declarar', value: r.monto_sin_declarar, format: 'currency',
        tone: r.sin_declarar ? 'warn' : 'ok', sub: `${r.sin_declarar} depósitos sin dueño en el texto`,
      },
    ];
  });

  readonly veredicto = computed<{ tono: 'ok' | 'warn'; icono: string; titulo: string; cuerpo: string }>(() => {
    const d = this.data();
    if (!d) return { tono: 'ok', icono: 'pi-check-circle', titulo: '', cuerpo: '' };
    const r = d.resumen;
    const previos = r.previos
      ? ` ${r.previos} depósitos (${this.money(r.monto_previo)}) son anteriores a Caja General y no tienen entrada que ligar.`
      : '';
    if (!r.pendientes) {
      return {
        tono: 'ok', icono: 'pi-check-circle',
        titulo: r.en_caja_general
          ? 'Todo lo depositado desde que existe Caja General tiene su entrada.'
          : 'Ningún depósito del período es posterior al arranque de Caja General.',
        cuerpo: `${r.en_caja_general} depósitos ligados por ${this.money(r.monto_caja_general)}.${previos}`,
      };
    }
    return {
      tono: 'warn', icono: 'pi-exclamation-triangle',
      titulo: `${r.pendientes} depósitos no se han capturado en Caja General.`,
      cuerpo: `Son ${this.money(r.monto_pendiente)} que ya están en la caja fuerte y todavía no `
        + `tienen entrada. No es un faltante: es captura pendiente.${previos}`,
    };
  });

  /**
   * Los depósitos de una fila. Se filtra en el cliente: el detalle ya viene en la respuesta.
   *
   * ⭐ Agrupa por la  que MANDA el servidor, no por una precedencia re-escrita acá. Una
   * segunda copia de esa regla divergiría algún día y el detalle de una fila mostraría los
   * depósitos de otra, sin error visible.
   */
  detalle(clave: string): RutaCajaDeposito[] {
    const d = this.data();
    if (!d) return [];
    return d.depositos.filter((x) => x.clave === clave);
  }

  alternar(clave: string) {
    const m = { ...this.abiertas() };
    if (m[clave]) delete m[clave]; else m[clave] = true;
    this.abiertas.set(m);
  }

  toggle() {
    const next = !this.open();
    this.open.set(next);
    if (next && !this.loadedOnce) { this.loadedOnce = true; this.reload(); }
  }

  reload() {
    this.cargando.set(true);
    this.error.set(null);
    this.api.rutaCaja(this.from(), this.to()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: () => {
        this.error.set('No se pudo cargar el depósito de las rutas en la caja fuerte.');
        this.cargando.set(false);
      },
    });
  }

  /** Number() antes de formatear: los numeric de Postgres llegan como string por JSON. */
  money(n: number | null): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })
      .format(Number(n));
  }
}
