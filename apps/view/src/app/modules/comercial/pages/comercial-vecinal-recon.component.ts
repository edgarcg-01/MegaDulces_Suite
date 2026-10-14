import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ComercialService, VecinalConciliacion, VecinalConciliacionFila, VecinalVeredicto } from '../comercial.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

/**
 * `[VEC.10]` — **La venta vecinal contra el dinero que se contó en SU caja.** Panel colapsable
 * dentro de `/comercial/ventas-por-ruta`, sólo lectura.
 *
 * La vecinal se timbra en una caja registradora de la sucursal (`U-D-10` = *"Ticket Contado
 * Caja N"*), así que su dinero se cuenta en el **arqueo de esa caja**, no en Caja General. Este
 * panel es el enganche entre las dos mitades, que existían y nadie había conectado.
 *
 * ⛔ **El grano es la caja, nunca la ruta** — una caja mezcla rutas y mostrador. Por eso la
 * columna `vecinal_pct`: sólo cuando vale 100 el descuadre es atribuible a la vecinal, y la
 * tabla lo dice en vez de dejar que el lector lo suponga.
 *
 * ⛔ `U-D-12` (re-factura) y `U-D-8` (telemarketing) se **declaran al pie y no se suman**: son la
 * explicación de por qué el sell-out publica otra cifra, y borrarlos dejaría esa diferencia sin
 * respuesta.
 */
@Component({
  selector: 'app-vecinal-recon',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  template: `
    <section class="vr-panel">
      <button type="button" class="vr-head" (click)="toggle()" [attr.aria-expanded]="open()">
        <i class="pi" [class.pi-chevron-right]="!open()" [class.pi-chevron-down]="open()" aria-hidden="true"></i>
        <span class="vr-title">Vecinal: la venta contra el dinero contado</span>
        <app-context-help topic="conciliacion-vecinal" (click)="$event.stopPropagation()" />
        @if (data(); as d) {
          <span class="vr-badges">
            @if (incidencias().length) {
              <p-tag [value]="incidencias().length + ' por revisar'" severity="warn" />
            } @else {
              <p-tag value="sin incidencias" severity="success" />
            }
          </span>
        }
        <span class="vr-hint">arqueo de la caja donde se timbró</span>
      </button>

      @if (open()) {
        <div class="vr-body">
          <div class="vr-filters">
            <label>Desde <input type="date" [ngModel]="from()" (ngModelChange)="from.set($event); reload()" [max]="to()" /></label>
            <label>Hasta <input type="date" [ngModel]="to()" (ngModelChange)="to.set($event); reload()" [max]="today" /></label>
            @if (data(); as d) {
              <app-freshness-pill measures="data" [since]="d.summary.arqueo_hasta" label="Arqueo"
                                  [staleAfterSec]="172800" />
            }
          </div>

          <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!filas().length"
                          [skeletonRows]="8" emptyIcon="pi-wallet"
                          emptyTitle="Ninguna ruta vecinal vendió en estas fechas"
                          emptyHint="La vecinal sólo aparece en las sucursales que la operan. Ampliá el rango."
                          (retry)="reload()">
            @if (data(); as d) {
              <!-- Q.1 answer-first: primero el veredicto, después la rejilla. -->
              <p class="vr-veredicto" [class]="'vr-v-' + veredicto().tono">
                <i class="pi" [class]="veredicto().icono" aria-hidden="true"></i>
                <span><strong>{{ veredicto().titulo }}</strong> {{ veredicto().cuerpo }}</span>
              </p>

              <app-metric-strip [items]="kpis()" ariaLabel="Conciliación de la vecinal contra el arqueo" />

              <!-- dt-scope + dt-stack: el panel se embebe a anchos distintos según el sidebar, y
                   cada columna es un CAMPO del mismo registro (no un pivote), así que en angosto
                   la rejilla se apila por renglón con su data-label en vez de scrollear a ciegas.
                   ⚠️ El dt-stack SIN el dt-scope no apila nada: la consulta de contenedor no tiene
                   contra qué medir. Se ve igual de roto, pero en verde. -->
              <div class="dt-scope">
              <p-table [value]="filas()" class="dt-stack surf-table surf-table--plain surf-table--sticky"
                       size="small" [rowHover]="true" [scrollable]="true" scrollHeight="44vh"
                       [tableStyle]="{ 'min-width': '58rem' }">
                <ng-template #header>
                  <tr>
                    <th>Día</th>
                    <th>Sucursal</th>
                    <th>Caja</th>
                    <th>Rutas</th>
                    <th class="comm-num">Venta vecinal</th>
                    <th class="comm-num">Venta de la caja</th>
                    <th class="comm-num">% vecinal</th>
                    <th class="comm-num">Efectivo</th>
                    <th>Estado</th>
                  </tr>
                </ng-template>
                <ng-template #body let-f>
                  <tr>
                    <td class="vr-mono" role="cell" data-label="Día">{{ f.date }}</td>
                    <td role="cell" data-label="Sucursal">{{ f.warehouse_name }}</td>
                    <td class="vr-mono" role="cell" data-label="Caja">{{ f.caja }}</td>
                    <td class="vr-mono vr-tenue" role="cell" data-label="Rutas">{{ f.rutas.join(' · ') }}</td>
                    <td class="comm-num vr-mono" role="cell" data-label="Venta vecinal">{{ money(f.vecinal) }}</td>
                    <td class="comm-num vr-mono" role="cell" data-label="Venta de la caja">
                      <!-- Sin title: la definición vive en el diccionario (regla P) y el chip de
                           la columna Estado ya dice "sin arqueo" en el mismo renglón. -->
                      @if (f.arqueo_venta === null) { <span class="vr-tenue">—</span> }
                      @else { {{ money(f.arqueo_venta) }} }
                    </td>
                    <td class="comm-num vr-mono" role="cell" data-label="% vecinal">
                      @if (f.vecinal_pct === null) { <span class="vr-tenue">—</span> }
                      @else { {{ f.vecinal_pct }}% }
                    </td>
                    <td class="comm-num vr-mono" role="cell" data-label="Efectivo"
                        [class.vr-bad]="esDinero(f) && (f.efectivo_diff ?? 0) > 1"
                        [class.vr-warn]="esDinero(f) && (f.efectivo_diff ?? 0) < -1">
                      @if (f.efectivo_diff === null) { <span class="vr-tenue">—</span> }
                      @else { {{ money(f.efectivo_diff) }} }
                    </td>
                    <td role="cell" data-label="Estado">
                      <p-tag [value]="etiqueta(f.veredicto)" [severity]="severidad(f.veredicto)" />
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              </div>

              <!-- Lo que lleva código de ruta vecinal y NO es venta de la caja. Se declara, no se suma. -->
              <p class="vr-nosuma">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>
                  En el mismo período hay
                  <strong>{{ money(d.no_suma.refactura) }}</strong> de re-factura
                  (<span class="vr-mono">U-D-12</span>, {{ d.no_suma.refactura_docs }} documentos) y
                  <strong>{{ money(d.no_suma.telemarketing) }}</strong> de telemarketing
                  (<span class="vr-mono">U-D-8</span>, {{ d.no_suma.telemarketing_docs }} documentos)
                  con código de ruta vecinal. <strong>Ninguno de los dos suma</strong>: la re-factura
                  re-emite el mismo ticket y el arqueo la ignora; el telemarketing es venta por otro
                  canal que no pasa por esta caja. El sell-out sí los cuenta, y por eso publica una
                  cifra más alta.
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
    .vr-panel { border: 1px solid var(--border-color); border-radius: var(--r-md); margin-bottom: var(--sp-4); overflow: hidden; }
    .vr-head { width: 100%; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 0; background: transparent; font: inherit; text-align: left; cursor: pointer; }
    .vr-head:hover { background: var(--overlay-hover); }
    .vr-head:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .vr-title { font-weight: var(--fw-bold); font-size: var(--fs-sm); color: var(--text-main); }
    .vr-badges { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
    .vr-hint { margin-left: auto; font-size: var(--fs-micro); color: var(--text-faint); }
    .vr-body { padding: var(--sp-3); border-top: 1px solid var(--border-color); }
    .vr-filters { display: flex; gap: var(--sp-4); align-items: center; flex-wrap: wrap; margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
    .vr-filters label { display: inline-flex; gap: var(--sp-1); align-items: center; color: var(--text-muted); }
    .vr-filters input { padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: transparent; color: var(--text-main); font: inherit; font-size: var(--fs-sm); }
    .vr-filters input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }

    .vr-veredicto { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0 0 var(--sp-3);
      padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-sm); color: var(--text-main); }
    .vr-veredicto .pi { margin-top: 2px; }
    .vr-v-ok   { border-color: color-mix(in srgb, var(--ok-fg) 38%, var(--border-color)); }
    .vr-v-warn { border-color: color-mix(in srgb, var(--warn-fg) 38%, var(--border-color)); }
    .vr-v-bad  { border-color: color-mix(in srgb, var(--bad-fg) 38%, var(--border-color)); }
    .vr-v-ok .pi   { color: var(--ok-fg); }
    .vr-v-warn .pi { color: var(--warn-fg); }
    .vr-v-bad .pi  { color: var(--bad-fg); }

    .vr-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .vr-tenue { color: var(--text-faint); }
    .vr-bad { color: var(--bad-fg); }
    .vr-warn { color: var(--warn-fg); }

    .vr-nosuma { display: flex; gap: var(--sp-2); align-items: flex-start; margin: var(--sp-3) 0 0;
      font-size: var(--fs-micro); color: var(--text-muted); line-height: 1.5; }
    .vr-nosuma .pi { margin-top: 2px; color: var(--text-faint); }
  `],
})
export class VecinalReconComponent {
  private readonly api = inject(ComercialService);

  readonly today = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  readonly from = signal<string>(new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10));
  readonly to = signal<string>(this.today);
  readonly open = signal(false);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<VecinalConciliacion | null>(null);

  private loadedOnce = false;

  /**
   * ⚠️ Los dos `computed` leen `data()` **incondicionalmente** (lo asignan a una constante antes
   * de cualquier corte). Un `signal() && …` que corta antes de leerlo deja al `computed` sin
   * dependencias y sin recalcular nunca — hay compuerta `reactividad` por eso.
   */
  readonly filas = computed<VecinalConciliacionFila[]>(() => this.data()?.filas ?? []);

  /** Lo accionable: los estados que piden que alguien haga algo. */
  readonly incidencias = computed(() =>
    this.filas().filter((f) => f.veredicto !== 'cuadra' && f.veredicto !== 'dia_en_curso'));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const s = d.summary;
    return [
      { label: 'Venta vecinal', value: s.vecinal_total, format: 'currency', sub: `${s.dia_caja} día-caja` },
      {
        label: 'Cobertura del arqueo', value: s.cobertura_pct, format: 'percent',
        tone: s.cobertura_pct >= 95 ? 'ok' : 'warn',
        sub: `${s.con_arqueo} de ${s.dia_caja} con caja cerrada`,
        state: s.cobertura_pct === 100 ? 'medido' : 'parcial',
        stateNote: s.cobertura_pct === 100 ? undefined : 'Hay día-caja sin arqueo: ese dinero no se puede juzgar',
      },
      {
        label: 'Efectivo', value: s.efectivo_diff, format: 'currency',
        tone: Math.abs(s.efectivo_diff) <= 1 ? 'ok' : s.efectivo_diff > 0 ? 'bad' : 'warn',
        sub: s.efectivo_diff > 0 ? 'falta' : s.efectivo_diff < 0 ? 'sobra' : 'cuadra',
        // No es el neto crudo: los turnos que declaran cero contado quedan fuera a propósito.
        state: 'parcial', stateNote: 'Excluye los turnos con cero contado, que no son dinero faltante',
      },
      {
        label: 'Por revisar', value: this.incidencias().length, format: 'number',
        tone: this.incidencias().length ? 'warn' : 'ok', sub: 'día-caja que no cuadran',
      },
    ];
  });

  readonly veredicto = computed<{ tono: 'ok' | 'warn' | 'bad'; icono: string; titulo: string; cuerpo: string }>(() => {
    const d = this.data();
    if (!d) return { tono: 'ok', icono: 'pi-check-circle', titulo: '', cuerpo: '' };
    const n = this.incidencias().length;
    const diff = d.summary.efectivo_diff;
    if (!n) {
      return {
        tono: 'ok', icono: 'pi-check-circle', titulo: 'La vecinal cuadra contra su caja.',
        cuerpo: `${d.summary.con_arqueo} de ${d.summary.dia_caja} día-caja tienen arqueo y ninguno quedó fuera de $1.`,
      };
    }
    const falta = diff > 1;
    return {
      tono: Math.abs(diff) > 10000 ? 'bad' : 'warn',
      icono: 'pi-exclamation-triangle',
      titulo: `${n} día-caja no cuadran.`,
      cuerpo: `El efectivo queda ${falta ? 'corto' : 'largo'} por ${this.money(Math.abs(diff))} en el período. `
        + 'El arqueo es por caja, así que el descuadre sólo es de la vecinal cuando la columna «% vecinal» dice 100.',
    };
  });

  toggle() {
    const next = !this.open();
    this.open.set(next);
    if (next && !this.loadedOnce) { this.loadedOnce = true; this.reload(); }
  }

  reload() {
    this.cargando.set(true);
    this.error.set(null);
    this.api.vecinalConciliacion(this.from(), this.to()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: () => { this.error.set('No se pudo cargar la conciliación de la vecinal.'); this.cargando.set(false); },
    });
  }

  /** Sólo en estos estados el número de efectivo significa dinero; en los demás es una ausencia. */
  esDinero(f: VecinalConciliacionFila): boolean {
    return f.veredicto === 'faltante' || f.veredicto === 'sobrante' || f.veredicto === 'cuadra';
  }

  etiqueta(v: VecinalVeredicto): string {
    switch (v) {
      case 'cuadra': return 'cuadra';
      case 'faltante': return 'falta efectivo';
      case 'sobrante': return 'sobra efectivo';
      case 'contado_en_cero': return 'cero contado';
      case 'vecinal_excede_arqueo': return 'la caja declara menos';
      case 'sin_arqueo': return 'sin arqueo';
      case 'arqueo_abierto': return 'turno abierto';
      default: return 'día en curso';
    }
  }

  /** `secondary` para las ausencias: no son un descuadre, son que todavía no hay con qué juzgar. */
  severidad(v: VecinalVeredicto): 'success' | 'warn' | 'danger' | 'secondary' {
    switch (v) {
      case 'cuadra': return 'success';
      case 'faltante': return 'danger';
      case 'sobrante':
      case 'vecinal_excede_arqueo': return 'warn';
      default: return 'secondary';
    }
  }

  /** ⚠️ `Number()` antes de formatear: los `numeric` de Postgres llegan como string por JSON. */
  money(n: number | null): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })
      .format(Number(n));
  }
}
