import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { EmbarqueSinFactura, EmbarquesSinFacturaReport, SalesDocumentsService } from '../sales-documents.service';

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/**
 * `[AX.18]` Embarques de telemarketing que salieron y no tienen factura viva.
 *
 * Es lo SECUNDARIO de Facturación TM, así que va como Edgar fijó el 2026-10-29 para lo secundario
 * de una pantalla de trabajo (`[CGA-A.63]`): un botón en el encabezado que ya dice cuánto falta y
 * abre una ventana ENCIMA — no empuja la tabla de facturas, que es la tarea.
 *
 * Cuestionario de diseño (skill `diseno` §0b):
 *  1. Qué ve y en qué orden: en el botón, cuántos y cuánto dinero; en la ventana, ese mismo
 *     resumen arriba y la lista del embarque más reciente al más viejo.
 *  2. Qué no: ni los que sí cuadran ni las diferencias de centavos (eso es el detalle de cada
 *     factura, `[AX.17]`); ni la serie 2 (traspaso), ni el cargo directo de La Piedad Abastos.
 *  3. Accesibilidad: el número sin abrir nada; la lista a un clic, por nombre de sucursal y de
 *     cliente; recorrible con flechas.
 *  4. Ligado a otro proceso: la factura se emite en Kepler (la Suite no escribe ahí). Las facturas
 *     en $0 se nombran por folio para encontrarlas allá.
 *  5. ¿Le toca a esta pantalla? Sí: es la mitad que falta de «lo que se facturó».
 *
 * La fuente es `analytics.erp_shipment_billing`, la misma vista y diagnóstico que el detector
 * de Finanzas `cxc_embarcado_sin_facturar`: las dos pantallas dicen lo mismo.
 */
@Component({
  selector: 'app-embarques-sin-factura',
  standalone: true,
  imports: [CommonModule, ButtonModule, DialogModule, TableModule, TagModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-button icon="pi pi-truck" severity="secondary" [outlined]="true" size="small"
              [label]="'Embarques sin factura · ' + resumen()"
              ariaLabel="Ver los embarques de telemarketing que salieron sin factura"
              (onClick)="abierta.set(true)" />

    <p-dialog header="Embarques sin factura" [visible]="abierta()" (visibleChange)="abierta.set($event)"
              [modal]="true" [dismissableMask]="true" [draggable]="false" [style]="{ width: 'min(64rem, 96vw)' }">
      <div class="esf dt-scope">
        <div class="esf-top">
          <p class="esf-sub">Embarques de telemarketing de los últimos {{ dias() }} días que salieron
            y no tienen una factura viva en Kepler.</p>
          <app-freshness-pill measures="fetch" [since]="cargadoAt()" [staleAfterSec]="600" />
        </div>

        <app-load-state [loading]="loading()" [error]="error()"
                        [isEmpty]="!loading() && !error() && filas().length === 0"
                        emptyIcon="pi-check-circle" emptyTitle="Todos los embarques tienen factura"
                        [emptyHint]="'Ningún embarque de los últimos ' + dias() + ' días quedó sin facturar.'"
                        (retry)="cargar()">
          <app-metric-strip [items]="kpis()" />

          @if (hayDeHoy()) {
            <p class="esf-nota"><i class="pi pi-info-circle" aria-hidden="true"></i>
              Hay embarques de hoy: la factura suele salir 15 a 25 minutos después del embarque,
              así que pueden estar por facturarse.</p>
          }

          <p-table [value]="filas()" dataKey="folio_digital" size="small" selectionMode="single"
                   [selection]="marcado()" (selectionChange)="marcado.set($event)"
                   class="surf-table surf-table--plain dt-stack" [tableStyle]="{ 'min-width': '44rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Embarque</th>
                <th scope="col" style="width:6.5rem">Fecha</th>
                <th scope="col">Cliente</th>
                <th scope="col" class="r comm-num" style="width:9rem">Embarcado</th>
                <th scope="col" style="width:14rem">Situación</th>
              </tr>
            </ng-template>
            <ng-template #body let-e>
              <tr [pSelectableRow]="e">
                <td class="dt-id" role="cell">
                  <span class="mono">UD41{{ serie(e) }}-{{ e.folio }}</span>
                  <span class="sub">{{ e.sucursal | sucursal }}</span>
                </td>
                <td class="mono" role="cell" data-label="Fecha">{{ e.fecha | date: 'dd/MM/yy' }}</td>
                <td role="cell" data-label="Cliente">
                  <span class="nom">{{ e.cliente_nombre || 'Sin nombre en Kepler' }}</span>
                  <span class="sub mono">{{ e.cliente_code }}</span>
                </td>
                <td class="r mono comm-num" role="cell" data-label="Embarcado">
                  {{ +e.total_embarcado | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                <td role="cell" data-label="Situación">
                  @if (e.situacion === 'sin_factura') {
                    <p-tag severity="danger" value="Nunca se facturó" />
                  } @else {
                    <p-tag severity="warn" [value]="e.facturas.length === 1 ? 'Su factura quedó en $0' : 'Sus ' + e.facturas.length + ' facturas quedaron en $0'" />
                    <span class="sub mono">{{ e.facturas.join(', ') }}</span>
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </div>
    </p-dialog>
  `,
  styles: [`
    :host { display: contents; }
    .esf { display: flex; flex-direction: column; gap: var(--sp-3, .75rem); }
    .esf-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, .75rem); flex-wrap: wrap; }
    .esf-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .esf-nota { display: flex; align-items: flex-start; gap: .4rem; margin: 0; font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .nom { display: block; font-weight: 600; line-height: 1.25; }
    .sub { display: block; font-size: var(--fs-xs, .75rem); color: var(--text-muted); margin-top: 1px; }
    .r { text-align: right; }
  `],
})
export class EmbarquesSinFacturaComponent {
  private readonly svc = inject(SalesDocumentsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal que tiene puesta la pantalla (código). El backend la recorta a tu alcance. */
  readonly sucursal = input<string | null>(null);

  readonly abierta = signal(false);
  readonly report = signal<EmbarquesSinFacturaReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoAt = signal<Date | null>(null);
  /** Sólo para recorrer la lista con el teclado: marcar un renglón no hace nada más. */
  readonly marcado = signal<EmbarqueSinFactura | null>(null);
  private peticion = 0;

  readonly filas = computed(() => this.report()?.embarques ?? []);
  readonly dias = computed(() => this.report()?.dias ?? 365);

  /** Lo que el botón dice sin abrir nada. Lo no medido se declara, no se dibuja como cero. */
  readonly resumen = computed(() => {
    if (this.error()) return 'sin medir';
    const r = this.report();
    if (this.loading() || !r) return 'midiendo…';
    if (!r.embarques.length) return 'ninguno';
    return `${r.embarques.length} · ${MXN.format(Number(r.total))}`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const f = this.filas();
    const nunca = f.filter((e) => e.situacion === 'sin_factura').length;
    return [
      { label: 'Embarques', value: f.length, format: 'number', tone: f.length ? 'bad' : undefined },
      { label: 'Embarcado sin factura', value: Number(this.report()?.total ?? 0), format: 'currency', tone: f.length ? 'bad' : undefined },
      { label: 'Nunca se facturaron', value: nunca, format: 'number' },
      { label: 'Facturas en $0', value: f.length - nunca, format: 'number' },
    ];
  });

  readonly hayDeHoy = computed(() => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    return this.filas().some((e) => e.fecha === hoy);
  });

  constructor() {
    // Se mide al entrar (el botón dice cuánto falta sin abrir nada) y cada vez que cambia la
    // sucursal de la pantalla. Leer `sucursal()` fuera del `untracked` es lo que lo vuelve reactivo.
    effect(() => {
      this.sucursal();
      untracked(() => this.cargar());
    });
  }

  /** La serie del embarque en dos dígitos (`UD4101-…`): esta lista es sólo serie 1. */
  serie(e: EmbarqueSinFactura): string {
    return e.folio_digital.slice(6, 8);
  }

  cargar(): void {
    const mia = ++this.peticion;
    this.loading.set(true);
    this.error.set(null);
    this.svc.embarquesSinFactura(this.sucursal()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (mia !== this.peticion) return; // llegó tarde: manda la consulta nueva
        this.report.set(r);
        this.cargadoAt.set(new Date());
        this.loading.set(false);
      },
      error: (e) => {
        if (mia !== this.peticion) return;
        this.error.set(e?.error?.message || 'No se pudo medir qué embarques quedaron sin factura.');
        this.loading.set(false);
      },
    });
  }
}
