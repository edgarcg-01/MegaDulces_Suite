import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import type { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PagosTabsComponent } from '../pagos-tabs.component';
import {
  ESPERA_CAPTURA_DIAS, HOLGURA_PROGRAMA_DIAS, MARGEN_SIN_SALIDA_DIAS, nombreTipoPagoKepler, textoKepler, textoPrograma, tipoPagoKepler, warehouseName,
  type AcreedorSugerido, type FilaSalidaProveedor, type GuiaFueraDePrograma, type NivelAtribucion, type PagoDelPar, type UniversoPago,
} from '@megadulces/contracts';

type Ventana = '30d' | 'mes' | 'mes_ant';
interface GrupoAcreedor { acreedor: string; nombre: string; pagos: number; monto: number; motivos: string; filas: FilaSalidaProveedor[] }

/**
 * `[PGP.97]` **Salidas del banco** — la guía del área de pagos: lo que salió del banco a un
 * proveedor y todavía no tiene su pago en Kepler, y lo que se pagó sin pasar por el programa.
 *
 * Pedido de Francisco (2026-11-07). La regla vive en `salida-proveedor.contract.ts`; la lectura en
 * `fuera-de-programa.sql.ts`. Esta pantalla sólo lee: no escribe en Kepler ni en el banco (eso es
 * O3, que necesita los permisos de escritura de quien administra Kepler).
 *
 * Diseño (las doce preguntas de la skill `diseno`, contestadas en `FASE_PGP_PAGO_A_PROVEEDOR.md`):
 * primario = cuánto falta en Kepler; secundario = la lista para elaborarlo; terciario = la meta
 * por universo, lo pagado fuera del programa por acreedor y lo que no se pudo medir.
 *
 * ⛔ Lo que no se pudo medir se dice (ADR-056): un día sin estado de cuenta cargado no es «nada
 * pendiente», y una ventana sin bancos cargados no pinta ceros: pinta «sin medir».
 */
@Component({
  selector: 'app-finanzas-salidas-banco',
  standalone: true,
  imports: [ButtonModule, TableModule, TagModule, MetricStripComponent, LoadStateComponent, FreshnessPillComponent, SegmentedComponent, SucursalPipe, PagosTabsComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page sb-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="surf-page-title">Salidas del banco <app-context-help topic="salidas-del-banco" /></h1>
          <p class="surf-page-sub">Lo que salió del banco a proveedores, contra Kepler y contra el programa de pagos: qué falta elaborar en Kepler y qué se pagó sin pasar por el programa.</p>
        </div>
        <div class="sb-head-actions">
          <app-segmented [options]="ventanas" [value]="ventana()" ariaLabel="Ventana de fechas" (valueChange)="cambiarVentana($event)" />
          @if (guia(); as g) { <app-freshness-pill measures="data" [since]="g.datos_al" label="Kepler" /> }
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="cargar()" aria-label="Volver a leer">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>
      <app-pagos-tabs />

      <section class="sb-body">
        <app-load-state [loading]="loading()" [error]="error()" [skeletonRows]="8"
          errorTitle="No se pudo leer el banco contra Kepler" (retry)="cargar()"></app-load-state>

        @if (!loading() && !error() && guia(); as g) {
          <p class="sb-veredicto" [class.sb-veredicto--falta]="faltan().length > 0">{{ veredicto() }}</p>
          <p class="sb-cobertura">
            <i class="pi pi-building-columns" aria-hidden="true"></i>
            <span>{{ coberturaTexto() }} Ventana del {{ fecha(g.desde) }} al {{ fecha(g.hasta) }}.</span>
          </p>
          <app-metric-strip [items]="kpis()" [instant]="true" ariaLabel="Salidas del banco contra Kepler y el programa" />

          <!-- Nivel secundario: la lista de trabajo -->
          <h2 class="sb-h2">Sin pago en Kepler <span class="sb-count">{{ sinPago().length }}</span></h2>
          <p class="sb-help">Las de más de {{ esperaDias }} días (lo normal de captura) dicen «Falta»: elabóralas en Kepler. Las más atrasadas primero. La propuesta de a quién se le pagó dice con qué evidencia: «fuerte» es nombre e importe juntos; «débil», una sola señal; revísala antes de capturar.</p>
          @if (sinPago().length) {
            <div class="dt-scope">
            <p-table [value]="sinPago()" dataKey="salida.id" size="small" class="dt-stack surf-table surf-table--plain surf-table--sticky sb-table">
              <ng-template #header>
                <tr>
                  <th>Estado</th><th>Fecha</th><th>Cuenta</th><th>Concepto del banco</th><th class="comm-num">Importe</th>
                  <th>A quién se le pagó</th><th>Facturas que salda</th><th>Programa</th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td role="cell" data-label="Estado">
                    <p-tag [value]="f.estado_kepler === 'falta' ? 'Falta' : 'En espera'" [severity]="f.estado_kepler === 'falta' ? 'danger' : 'secondary'" />
                    <div class="sb-muted">hace {{ f.dias }} {{ f.dias === 1 ? 'día' : 'días' }}</div>
                  </td>
                  <td role="cell" data-label="Fecha" class="sb-nowrap">{{ fecha(f.salida.fecha) }}</td>
                  <td role="cell" data-label="Cuenta" class="sb-nowrap">{{ f.salida.cuenta }}</td>
                  <td role="cell" data-label="Concepto del banco">{{ f.salida.concepto || '—' }}</td>
                  <td role="cell" data-label="Importe" class="comm-num sb-strong">{{ money2(f.salida.importe) }}</td>
                  <td role="cell" data-label="A quién se le pagó">
                    @if (f.sugerido?.acreedor) {
                      <div class="sb-strong">{{ f.sugerido.nombre || f.sugerido.acreedor }}</div>
                      <div class="sb-muted">{{ f.sugerido.acreedor }} · evidencia {{ nivelTexto(f.sugerido.nivel) }}: {{ f.sugerido.porque }}</div>
                    } @else {
                      <div class="sb-muted">Sin identificar: {{ f.sugerido?.porque || 'sin señal' }}</div>
                    }
                    @if (f.sugerido?.candidatos?.length) { <div class="sb-muted">También podría ser: {{ candidatosTexto(f.sugerido) }}</div> }
                    @if (f.no_cuadra; as nc) {
                      <div class="sb-aviso">Kepler tiene un pago de este acreedor ese día por {{ money2(nc.importe) }} ({{ documento(nc) }}) que no cuadra con el banco: revísalo antes de capturar.</div>
                    }
                  </td>
                  <td role="cell" data-label="Facturas que salda">
                    @for (x of f.sugerido?.facturas || []; track x.id) {
                      <div class="sb-nowrap">{{ x.folio }} · {{ x.sucursal | sucursal }} · {{ money2(x.pendiente) }}</div>
                    } @empty { <span class="sb-muted">Ninguna suma el importe</span> }
                  </td>
                  <td role="cell" data-label="Programa">{{ programaTexto(f) }}</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
          } @else {
            <p class="sb-empty">{{ sinBanco() ? 'Sin estado de cuenta cargado en esta ventana: no se puede decir.' : hayHuecos() ? 'Nada sin pago en Kepler en lo que el banco tiene cargado (abajo, lo que falta cargar).' : 'Todo lo que salió del banco a proveedores en esta ventana tiene su pago en Kepler.' }}</p>
          }

          <!-- Nivel secundario: correcciones -->
          <h2 class="sb-h2">Por corregir en Kepler <span class="sb-count">{{ porCorregir().length + g.kepler_sin_salida.length }}</span></h2>
          <p class="sb-help">El pago está en Kepler pero no cuadra con el banco. No hay que capturarlo otra vez: hay que corregirlo.</p>
          @if (porCorregir().length) {
            <p-table [value]="porCorregir()" dataKey="salida.id" size="small" class="surf-table surf-table--plain sb-table">
              <ng-template #header>
                <tr><th>Fecha</th><th>Cuenta del banco</th><th class="comm-num">Importe del banco</th><th>Qué no cuadra</th><th>Documento en Kepler</th><th>Acreedor</th></tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td class="sb-nowrap">{{ fecha(f.salida.fecha) }}</td>
                  <td class="sb-nowrap">{{ f.salida.cuenta }}</td>
                  <td class="comm-num">{{ money2(f.salida.importe) }}</td>
                  <td>{{ queNoCuadra(f) }}</td>
                  <td>@for (d of f.documentos; track d.id) { <div class="sb-nowrap">{{ documento(d) }}</div> }</td>
                  <td>{{ f.documentos[0]?.acreedor_nombre || f.documentos[0]?.acreedor || '—' }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
          @if (g.kepler_sin_salida.length) {
            <h3 class="sb-h3">En Kepler sin salida en el banco <span class="sb-count">{{ g.kepler_sin_salida.length }}</span></h3>
            <p class="sb-help">Kepler bajó la deuda y el banco de esa cuenta —cargado ese día y {{ margenSinSalida }} días después— no muestra la transferencia: puede ser una captura doble, un envío devuelto o una cuenta equivocada.</p>
            <p-table [value]="g.kepler_sin_salida" dataKey="id" size="small" class="surf-table surf-table--plain sb-table">
              <ng-template #header>
                <tr><th>Fecha</th><th>Documento</th><th>Acreedor</th><th>Cuenta en Kepler</th><th class="comm-num">Importe</th><th>Capturado</th></tr>
              </ng-template>
              <ng-template #body let-p>
                <tr>
                  <td class="sb-nowrap">{{ fecha(p.fecha) }}</td>
                  <td class="sb-nowrap">{{ documento(p) }}</td>
                  <td>{{ p.acreedor_nombre || p.acreedor }}</td>
                  <td class="sb-nowrap">{{ p.banco_nombre || p.account_label || '—' }}</td>
                  <td class="comm-num">{{ money2(p.importe) }}</td>
                  <td class="sb-nowrap">{{ p.fecha_captura ? fecha(p.fecha_captura) : '—' }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
          @if (!porCorregir().length && !g.kepler_sin_salida.length) {
            <p class="sb-empty">{{ sinBanco() ? 'Sin estado de cuenta cargado en esta ventana: no se puede decir.' : hayHuecos() ? 'Nada por corregir en lo que el banco tiene cargado.' : 'Nada por corregir.' }}</p>
          }

          <!-- Nivel terciario: lo pagado fuera del programa -->
          <h2 class="sb-h2">Pagado fuera del programa <span class="sb-count">{{ fuera().length }} · {{ money(fueraMonto()) }}</span></h2>
          <p class="sb-help">Salidas del banco cargado cuyo pago ya está en Kepler, pero ninguna de sus facturas estaba en el Calendario para ese día (±{{ holgura }} días) antes de pagarla. Por acreedor, de mayor a menor.</p>
          @if (fueraPorAcreedor().length) {
            <p-table [value]="fueraPorAcreedor()" dataKey="acreedor" [expandedRowKeys]="abiertos" size="small" class="surf-table surf-table--plain sb-table">
              <ng-template #header>
                <tr><th style="width:2.5rem"><span class="sr-only">Detalle</span></th><th>Acreedor</th><th class="comm-num">Pagos</th><th class="comm-num">Monto</th><th>Por qué quedó fuera</th></tr>
              </ng-template>
              <ng-template #body let-a let-expanded="expanded">
                <tr>
                  <td><p-button type="button" [pRowToggler]="a" styleClass="p-button-text p-button-sm p-button-rounded"
                        [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" [ariaLabel]="(expanded ? 'Cerrar ' : 'Ver los pagos de ') + a.nombre"></p-button></td>
                  <td><span class="sb-strong">{{ a.nombre }}</span> <span class="sb-muted">{{ a.acreedor }}</span></td>
                  <td class="comm-num">{{ a.pagos }}</td>
                  <td class="comm-num">{{ money2(a.monto) }}</td>
                  <td class="sb-muted">{{ a.motivos }}</td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-a>
                <tr>
                  <td colspan="5" class="sb-exp">
                    <table class="sb-mini" [attr.aria-label]="'Pagos de ' + a.nombre">
                      <thead><tr><th>Fecha</th><th>Cuenta</th><th>Documento en Kepler</th><th class="comm-num">Importe</th><th>Programa</th></tr></thead>
                      <tbody>
                        @for (f of a.filas; track f.salida.id) {
                          <tr>
                            <td class="sb-nowrap">{{ fecha(f.salida.fecha) }}</td>
                            <td class="sb-nowrap">{{ f.salida.cuenta }}</td>
                            <td>@for (d of f.documentos; track d.id) { <div class="sb-nowrap">{{ documento(d) }}</div> }</td>
                            <td class="comm-num">{{ money2(f.salida.importe) }}</td>
                            <td>{{ programaTexto(f) }}@if (f.mal_clasificada) {<span class="sb-muted"> · en el banco no estaba marcada como pago a proveedor</span>}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          } @else {
            <p class="sb-empty">{{ sinBanco() ? 'Sin estado de cuenta cargado en esta ventana: no se puede decir.' : hayHuecos() || fueraSinFila().pagos ? 'Nada en lo que el banco tiene cargado (abajo, lo que Kepler tiene fuera del programa sin renglón aquí).' : 'Nada pagado fuera del programa en esta ventana.' }}</p>
          }

          <!-- Nivel terciario: la meta -->
          <h2 class="sb-h2">La meta: el 100 % de los pagos por el programa</h2>
          <p class="sb-help">Medido desde Kepler (todos los pagos con dinero a acreedores de compra), por la cuenta de Kepler de donde salieron. «Por el programa» = alguna factura que saldó estaba en el Calendario para ese día (±{{ holgura }}), dada de alta antes de pagar y vigente ese día.</p>
          <table class="sb-mini sb-meta" aria-label="Cobertura del programa por universo">
            <thead><tr><th>De dónde salió</th><th class="comm-num">Pagos</th><th class="comm-num">Por el programa</th><th class="comm-num">Dinero</th><th class="comm-num">Por el programa</th><th class="comm-num">%</th></tr></thead>
            <tbody>
              @for (u of universos; track u.key) {
                @if (g.metrica[u.key].pagos) {
                  <tr>
                    <td>{{ u.label }}</td>
                    <td class="comm-num">{{ g.metrica[u.key].pagos }}</td>
                    <td class="comm-num">{{ g.metrica[u.key].pagos_en_programa }}</td>
                    <td class="comm-num">{{ money(g.metrica[u.key].monto) }}</td>
                    <td class="comm-num">{{ money(g.metrica[u.key].monto_en_programa) }}</td>
                    <td class="comm-num sb-strong">{{ pct(g.metrica[u.key].monto_en_programa, g.metrica[u.key].monto) }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
          @if (fueraSinFila().pagos) {
            <p class="sb-help">De los pagos por banco fuera del programa, {{ fueraSinFila().pagos }} por {{ money(fueraSinFila().monto) }} no tienen renglón arriba:
              @if (g.kepler_fuera_sin_fila.sin_salida.pagos) { {{ g.kepler_fuera_sin_fila.sin_salida.pagos }} no muestran salida en el banco cargado (están en «Por corregir»); }
              @if (g.kepler_fuera_sin_fila.sin_cobertura.pagos) { {{ g.kepler_fuera_sin_fila.sin_cobertura.pagos }} caen en días o cuentas que el banco no tiene cargados. }
            </p>
          }
          @if (anticipos(); as a) { @if (a.n) { <p class="sb-help">De esos, {{ a.n }} son anticipos ({{ money(a.monto) }}): no saldan ninguna factura y el Calendario todavía no programa anticipos.</p> } }

          @if (g.fuera_del_universo.gasto.pagos || g.fuera_del_universo.devueltas.pagos) {
            <p class="sb-help">Fuera de esta guía:
              @if (g.fuera_del_universo.gasto.pagos) { {{ g.fuera_del_universo.gasto.pagos }} salidas marcadas como proveedor que son gasto ({{ money(g.fuera_del_universo.gasto.monto) }}). }
              @if (g.fuera_del_universo.devueltas.pagos) { {{ g.fuera_del_universo.devueltas.pagos }} envíos que el banco devolvió ({{ money(g.fuera_del_universo.devueltas.monto) }}). }
            </p>
          }

          @if (g.no_medido.length) {
            <details class="sb-nomedido">
              <summary>Lo que no se pudo medir ({{ g.no_medido.length }})</summary>
              <ul>@for (x of g.no_medido; track x) { <li>{{ x }}</li> }</ul>
            </details>
          }
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sb-page { display: block; }
    .sb-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .sb-body { padding: var(--sp-3) 1.5rem var(--sp-8); display: block; }
    .sb-veredicto { font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-1); }
    .sb-veredicto--falta { color: var(--bad-soft-fg); }
    .sb-cobertura { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-3); display: flex; gap: var(--sp-2); align-items: baseline; }
    app-metric-strip { display: block; margin: 0 0 var(--sp-4); }
    .sb-h2 { font-size: var(--fs-md); font-weight: 600; color: var(--text-main); margin: var(--sp-6) 0 var(--sp-1); display: flex; gap: var(--sp-2); align-items: baseline; }
    .sb-h3 { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: var(--sp-4) 0 var(--sp-1); display: flex; gap: var(--sp-2); align-items: baseline; }
    .sb-count { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sb-help { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-2); max-width: 72rem; }
    .sb-empty { font-size: var(--fs-sm); color: var(--text-muted); margin: var(--sp-1) 0 var(--sp-2); }
    .sb-strong { font-weight: 600; color: var(--text-main); }
    .sb-muted { font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-aviso { font-size: var(--fs-xs); color: var(--text-main); font-weight: 600; margin-top: var(--sp-1); }
    .sb-nowrap { white-space: nowrap; }
    .sb-table { display: block; margin-bottom: var(--sp-2); }
    .sb-exp { padding: var(--sp-2) var(--sp-3) var(--sp-3) 3rem; }
    .sb-mini { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .sb-mini th { text-align: left; font-weight: 600; color: var(--text-muted); padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .sb-mini td { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    .sb-mini th.comm-num, .sb-mini td.comm-num { text-align: right; font-variant-numeric: tabular-nums; }
    .sb-meta { max-width: 56rem; margin-bottom: var(--sp-2); }
    .sb-nomedido { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); }
    .sb-nomedido summary { cursor: pointer; font-weight: 600; color: var(--text-main); }
    .sb-nomedido summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sb-nomedido ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-5); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) { .sb-body { padding: var(--sp-2) 1rem var(--sp-6); } }
  `],
})
export class FinanzasSalidasBancoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/payment-calendar`;
  private peticion?: Subscription;

  readonly esperaDias = ESPERA_CAPTURA_DIAS;
  readonly holgura = HOLGURA_PROGRAMA_DIAS;
  readonly margenSinSalida = MARGEN_SIN_SALIDA_DIAS;
  readonly ventanas: SegOption[] = [
    { label: 'Últimos 30 días', value: '30d' },
    { label: 'Este mes', value: 'mes' },
    { label: 'Mes anterior', value: 'mes_ant' },
  ];
  readonly universos: { key: UniversoPago; label: string }[] = [
    { key: 'banco', label: 'Cuentas de banco' },
    { key: 'caja', label: 'Caja (efectivo)' },
    { key: 'otra', label: 'Otras cuentas de Kepler (factoraje, devoluciones, ajustes)' },
  ];

  readonly ventana = signal<Ventana>('30d');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly guia = signal<GuiaFueraDePrograma | null>(null);
  abiertos: Record<string, boolean> = {};

  readonly filas = computed(() => this.guia()?.filas ?? []);
  /** Sin pago en Kepler: primero las que ya faltan (las más atrasadas), luego las que están en espera. */
  readonly sinPago = computed(() => this.filas()
    .filter((f) => f.estado_kepler === 'falta' || f.estado_kepler === 'en_espera')
    .sort((a, b) => (a.estado_kepler === b.estado_kepler ? b.dias - a.dias : a.estado_kepler === 'falta' ? -1 : 1)));
  readonly faltan = computed(() => this.sinPago().filter((f) => f.estado_kepler === 'falta'));
  readonly enEspera = computed(() => this.sinPago().filter((f) => f.estado_kepler === 'en_espera'));
  readonly porCorregir = computed(() => this.filas().filter((f) => f.corregir !== null));
  readonly fuera = computed(() => this.filas().filter((f) => f.cuadrante === 'fuera_en_kepler'));
  readonly fueraMonto = computed(() => this.fuera().reduce((s, f) => s + f.salida.importe, 0));
  readonly fueraSinFila = computed(() => {
    const k = this.guia()?.kepler_fuera_sin_fila;
    return { pagos: (k?.sin_salida.pagos ?? 0) + (k?.sin_cobertura.pagos ?? 0), monto: (k?.sin_salida.monto ?? 0) + (k?.sin_cobertura.monto ?? 0) };
  });
  readonly fueraPorAcreedor = computed<GrupoAcreedor[]>(() => {
    const m = new Map<string, GrupoAcreedor & { cuenta: Map<string, number> }>();
    for (const f of this.fuera()) {
      const d = f.documentos[0];
      const k = d?.acreedor ?? '—';
      const g: GrupoAcreedor & { cuenta: Map<string, number> } = m.get(k)
        ?? { acreedor: k, nombre: d?.acreedor_nombre || k, pagos: 0, monto: 0, motivos: '', filas: [], cuenta: new Map<string, number>() };
      g.pagos++; g.monto += f.salida.importe; g.filas.push(f);
      const t = textoPrograma(f.programa.estado);
      g.cuenta.set(t, (g.cuenta.get(t) ?? 0) + 1);
      m.set(k, g);
    }
    return [...m.values()].map(({ cuenta, ...g }) => ({
      ...g, motivos: [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => (g.pagos > 1 ? `${t} (${n})` : t)).join(' · '),
    })).sort((a, b) => b.monto - a.monto);
  });
  readonly anticipos = computed(() => {
    const g = this.guia();
    if (!g) return null;
    const ms = Object.values(g.metrica);
    return { n: ms.reduce((s, x) => s + x.pagos_sin_factura, 0), monto: ms.reduce((s, x) => s + x.monto_sin_factura, 0) };
  });
  /** Las cuentas con estado de cuenta y movimientos en la ventana. */
  readonly conDatos = computed(() => {
    const g = this.guia();
    return g ? g.cuentas.filter((c) => c.estado_cargado && c.hasta && c.hasta >= g.desde) : [];
  });
  /** La ventana no tiene NINGÚN banco cargado: todo lo del lado banco es «sin medir». */
  readonly sinBanco = computed(() => !!this.guia() && this.conDatos().length === 0);
  readonly hayHuecos = computed(() => (this.guia()?.no_medido.length ?? 0) > 0);
  /** La cobertura cuenta por cuenta: el día más común, las que se quedan atrás y las que no tienen estado. */
  readonly coberturaTexto = computed(() => {
    const g = this.guia();
    if (!g) return '';
    const con = this.conDatos();
    if (!con.length) return 'Sin estado de cuenta cargado para esta ventana.';
    const porDia = new Map<string, string[]>();
    for (const c of con) { const l = porDia.get(c.hasta as string) ?? []; l.push(c.cuenta); porDia.set(c.hasta as string, l); }
    const [diaComun, comunes] = [...porDia.entries()].sort((a, b) => b[1].length - a[1].length || b[0].localeCompare(a[0]))[0];
    const partes = [`${comunes.length} ${comunes.length === 1 ? 'cuenta' : 'cuentas'} hasta el ${this.fecha(diaComun)}`];
    for (const [dia, cs] of [...porDia.entries()].filter(([d]) => d !== diaComun).sort((a, b) => a[0].localeCompare(b[0]))) partes.push(`${cs.join(', ')} hasta el ${this.fecha(dia)}`);
    const sinEstado = g.cuentas.filter((c) => !c.estado_cargado).map((c) => c.cuenta);
    const quietas = g.cuentas.filter((c) => c.estado_cargado && !(c.hasta && c.hasta >= g.desde)).map((c) => c.cuenta);
    if (sinEstado.length) partes.push(`sin estado de cuenta: ${sinEstado.join(', ')}`);
    if (quietas.length) partes.push(`sin movimientos: ${quietas.join(', ')}`);
    return `Bancos cargados: ${partes.join('; ')}.`;
  });
  readonly veredicto = computed(() => {
    const g = this.guia();
    if (!g) return '';
    if (this.sinBanco()) return 'Sin estado de cuenta cargado en esta ventana: no se puede decir qué falta en Kepler.';
    const f = this.faltan();
    const e = this.enEspera();
    const suma = (xs: FilaSalidaProveedor[]) => xs.reduce((s, x) => s + x.salida.importe, 0);
    if (f.length) {
      const extra = e.length ? ` Otras ${e.length} todavía están dentro de la espera normal de captura.` : '';
      return `${f.length} ${f.length === 1 ? 'transferencia' : 'transferencias'} por ${this.money2(suma(f))} salieron del banco hace más de ${this.esperaDias} días y no tienen su pago en Kepler.${extra}`;
    }
    if (e.length) return `Nada atrasado: ${e.length} ${e.length === 1 ? 'salida' : 'salidas'} por ${this.money2(suma(e))} salieron hace ${this.esperaDias} días o menos y todavía esperan su captura en Kepler.`;
    if (this.hayHuecos()) return 'Nada sin pago en Kepler en lo que el banco tiene cargado; no todas las cuentas ni todos los días están cargados (abajo).';
    return 'Todo lo que salió del banco a proveedores en esta ventana tiene su pago en Kepler.';
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const g = this.guia();
    if (!g) return [];
    const b = g.metrica.banco;
    const meta: MetricStripItem = b.monto
      ? { label: 'Por el programa (banco)', value: Math.round((1000 * b.monto_en_programa) / b.monto) / 10, format: 'percent', sub: `${this.money(b.monto_en_programa)} de ${this.money(b.monto)} · meta 100 %` }
      : { label: 'Por el programa (banco)', value: '—', format: 'text', sub: 'sin pagos de compra por banco en la ventana' };
    if (this.sinBanco()) {
      const sinMedir = (label: string): MetricStripItem => ({ label, value: '—', format: 'text', state: 'no_medido', stateNote: this.coberturaTexto(), sub: 'sin estado de cuenta cargado' });
      return [sinMedir('Falta en Kepler'), sinMedir('Por corregir en Kepler'), sinMedir('Fuera del programa (banco cargado)'), meta];
    }
    const faltan = this.faltan();
    const corregir = this.porCorregir().length + g.kepler_sin_salida.length;
    const parcial = this.hayHuecos() ? { state: 'parcial' as const, stateNote: this.coberturaTexto() } : {};
    const sinFila = this.fueraSinFila();
    return [
      {
        label: 'Falta en Kepler', value: faltan.reduce((s, x) => s + x.salida.importe, 0), format: 'currency', tone: faltan.length ? 'bad' : 'default',
        sub: `${faltan.length} ${faltan.length === 1 ? 'salida' : 'salidas'} · ${this.enEspera().length} en espera`, ...parcial,
      },
      { label: 'Por corregir en Kepler', value: corregir, format: 'number', sub: 'cuenta, importe o salida que no cuadra', ...parcial },
      {
        label: 'Fuera del programa (banco cargado)', value: this.fueraMonto(), format: 'currency-short', sub: `${this.fuera().length} salidas ya en Kepler`,
        ...(this.hayHuecos() || sinFila.pagos
          ? { state: 'parcial' as const, stateNote: `Más ${sinFila.pagos} pagos por ${this.money(sinFila.monto)} que Kepler tiene fuera del programa sin renglón aquí (ver la meta).` }
          : {}),
      },
      meta,
    ];
  });

  ngOnInit(): void { this.cargar(); }

  cambiarVentana(v: string): void {
    this.ventana.set(v as Ventana);
    this.cargar();
  }

  cargar(): void {
    const { desde, hasta } = this.rango(this.ventana());
    // Una respuesta vieja no pisa a la nueva: cambiar de ventana cancela la petición anterior.
    this.peticion?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.peticion = this.http.get<GuiaFueraDePrograma>(`${this.base}/fuera-de-programa`, { params: { date_from: desde, date_to: hasta } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (g) => { this.guia.set(g); this.abiertos = {}; this.loading.set(false); },
        error: (e) => { this.error.set(e?.error?.message || 'Intenta de nuevo en un momento.'); this.loading.set(false); },
      });
  }

  /** La ventana en fechas locales (la persona está en México). */
  private rango(v: Ventana): { desde: string; hasta: string } {
    const hoy = new Date();
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (v === 'mes') return { desde: ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: ymd(hoy) };
    if (v === 'mes_ant') return { desde: ymd(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)), hasta: ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 0)) };
    const d = new Date(hoy); d.setDate(d.getDate() - 30);
    return { desde: ymd(d), hasta: ymd(hoy) };
  }

  programaTexto(f: FilaSalidaProveedor): string {
    const t = textoPrograma(f.programa.estado);
    return f.programa.dia ? `${t} (${this.fecha(f.programa.dia)})` : t;
  }
  queNoCuadra(f: FilaSalidaProveedor): string {
    const d = f.documentos[0];
    if (f.corregir === 'cuenta') return `${textoKepler(f.estado_kepler)}: Kepler lo tiene en la cuenta ${d?.banco_nombre || d?.account_label || '—'}`;
    if (f.corregir === 'importe' && f.dif_importe !== null && d) return `${textoKepler(f.estado_kepler)}: Kepler tiene ${this.money2(d.importe)} (${f.dif_importe > 0 ? '+' : '−'}${this.money2(Math.abs(f.dif_importe))})`;
    return textoKepler(f.estado_kepler);
  }
  documento(p: Pick<PagoDelPar, 'doc_tipo' | 'folio' | 'sucursal'> | null | undefined): string {
    if (!p) return '—';
    const tipo = Number(p.doc_tipo.split('-').pop());
    return `${nombreTipoPagoKepler(tipoPagoKepler(tipo, 1))} ${p.folio} · ${warehouseName(p.sucursal)}`;
  }
  candidatosTexto(s: AcreedorSugerido): string { return s.candidatos.map((c) => c.nombre || c.acreedor).join(', '); }
  nivelTexto(n: NivelAtribucion): string { return n === 'fuerte' ? 'fuerte' : n === 'debil' ? 'débil' : 'ninguna'; }
  pct(a: number, b: number): string { return b ? `${(Math.round((1000 * a) / b) / 10).toFixed(1)} %` : '—'; }
  fecha(ymd: string): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1];
    return `${d}-${mes}${y !== new Date().getFullYear() ? `-${y}` : ''}`;
  }
  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  money2(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
