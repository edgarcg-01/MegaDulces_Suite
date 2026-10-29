import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';
import { MessageModule } from 'primeng/message';
import { DiferenciaMaestro, TeleventaDashboard, TeleventaService } from '../televenta.service';
import { callOutcomeLabel, callOutcomeSeverity } from '../call-outcomes';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

/**
 * E.4 — Resumen del canal de telemarketing.
 *
 * Jerarquía: primario = la facturación del canal (ERP) · secundario = las tablas por operador y
 * las últimas facturas · terciario = la actividad de llamadas, que sólo se pinta si existe.
 *
 * Auditoría 2026-10-21 (`[E.14]`): la cola se titulaba «priorizada» y no lo estaba, la actividad
 * dibujaba ceros que el propio aviso declaraba sin medir, el vencido dejaba fuera la deuda vieja
 * y las etiquetas de resultado usaban claves que el backend nunca manda.
 */
@Component({
  selector: 'app-televenta-dashboard',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    ButtonModule, CardModule, TableModule, TagModule, ProgressBarModule, MessageModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent, SidePeekComponent,
  ],
  template: `
    <!-- [E.13] El encabezado nombra la PÁGINA, no el proyecto: la migaja ya dice Telemarketing. -->
    <div class="surf-page">
    <header class="surf-page-head">
      <div class="surf-page-head-text">
        <h1>Resumen del canal</h1>
        <p class="surf-page-sub">Facturación del canal (ERP) y actividad de llamadas.</p>
      </div>
      <div class="header-actions">
        <app-freshness-pill measures="fetch" [since]="loadedAt()" />
        <button pButton severity="secondary" (click)="reload()" [loading]="loading()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
      </div>
    </header>

    <app-load-state [loading]="loading() && !data()" [error]="error()" [skeletonRows]="8"
      errorTitle="No se pudo cargar el resumen" (retry)="reload()">
      @if (data(); as d) {
        <!-- ── FACTURACIÓN: el resultado del canal. Va primero porque es lo que existe todos
             los días; la captura de llamadas puede no haber arrancado. -->
        <h2 class="section-title">
          <i class="pi pi-file" aria-hidden="true"></i> Facturación del canal
          @if (d.billing.ultima_factura) {
            <span class="asof">última factura {{ d.billing.ultima_factura | date: 'dd/MM/yy' }}</span>
          }
        </h2>
        <app-metric-strip [items]="billingItems(d)" ariaLabel="Facturación de telemarketing" />

        <!-- [E.15] El descuento como CUENTA: se lee de arriba abajo y cierra al centavo contra
             lo facturado, porque los dos descuentos se miden como diferencias (regla TK.13). -->
        @if (d.billing.descuentos; as ds) {
          <p-card class="descuentos">
            <div class="card-header-row">
              <h3>Descuentos · 30 días</h3>
              <span class="muted">{{ ds.facturas | number }} facturas · {{ ds.renglones | number }} renglones</span>
            </div>
            <div class="desc-grid">
              <table class="surf-table surf-table--plain is-dense cuenta" aria-label="Del precio de lista a lo facturado">
                <tbody>
                  <tr>
                    <th scope="row">Precio de lista</th>
                    <td class="comm-num">{{ ds.lista | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                    <td class="comm-num pct"></td>
                  </tr>
                  <tr>
                    <th scope="row">
                      − Descuento de producto
                      <span class="def">precio de lista del renglón contra lo cobrado</span>
                    </th>
                    <td class="comm-num">{{ ds.producto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                    <td class="comm-num pct">{{ pct(ds.producto, ds.lista) }} de la lista</td>
                  </tr>
                  <tr class="parcial">
                    <th scope="row">= Subtotal</th>
                    <td class="comm-num">{{ ds.subtotal | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                    <td class="comm-num pct"></td>
                  </tr>
                  <tr>
                    <th scope="row">
                      − Descuento de cliente
                      <span class="def">el % negociado del cliente, sobre el documento</span>
                    </th>
                    <td class="comm-num">{{ ds.cliente | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                    <td class="comm-num pct">{{ pct(ds.cliente, ds.subtotal) }} del subtotal</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">= Facturado</th>
                    <td class="comm-num">{{ ds.facturado | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                    <td class="comm-num pct">descontado {{ pct(ds.producto + ds.cliente, ds.lista) }} de la lista</td>
                  </tr>
                </tfoot>
              </table>

              <div class="negociado">
                <h4>Descuento de cliente: negociado contra aplicado</h4>
                <dl>
                  <div>
                    <dt>Con menos % del negociado</dt>
                    <dd>
                      <strong class="comm-num">{{ ds.negociado_no_aplicado.facturas | number }}</strong> facturas ·
                      <span class="comm-num">{{ ds.negociado_no_aplicado.monto | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</span>
                      menos de descuento que el negociado
                      @if (ds.negociado_no_aplicado.facturas) {
                        <p-button [link]="true" size="small" label="Ver facturas" icon="pi pi-arrow-right" iconPos="right"
                          (onClick)="abrirPeek('menos')" />
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Con más % del que tiene el maestro</dt>
                    <dd>
                      <strong class="comm-num">{{ ds.sin_respaldo_maestro.facturas | number }}</strong> facturas ·
                      <span class="comm-num">{{ ds.sin_respaldo_maestro.monto | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</span>
                      más de descuento que el registrado
                      @if (ds.sin_respaldo_maestro.facturas) {
                        <p-button [link]="true" size="small" label="Ver facturas" icon="pi pi-arrow-right" iconPos="right"
                          (onClick)="abrirPeek('mas')" />
                      }
                    </dd>
                  </div>
                </dl>
                <p class="nota">
                  <i class="pi pi-info-circle" aria-hidden="true"></i>
                  Contra el maestro de clientes de hoy. Desde el dato no se puede saber si fue una
                  excepción autorizada o un error de captura: hay que preguntarle a quien factura.
                </p>
              </div>
            </div>
            @if (ds.renglones_sin_lista > 0 || ds.facturas_sin_renglones > 0) {
              <div class="aviso"><p-message severity="warn" size="small">
                <span>
                  @if (ds.renglones_sin_lista > 0) {
                    {{ ds.renglones_sin_lista | number }} renglones no tienen precio de lista en el ERP:
                    el descuento de producto es un piso, no la cifra exacta.
                  }
                  @if (ds.facturas_sin_renglones > 0) {
                    {{ ds.facturas_sin_renglones | number }} facturas
                    ({{ ds.total_sin_renglones | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}) llegaron sin
                    renglones todavía y quedan fuera de esta cuenta.
                  }
                </span>
              </p-message></div>
            }
          </p-card>
        }

        <div class="two-col">
          <p-card>
            <div class="card-header-row">
              <!-- [E.15] Decía «Por operador» y 7 de sus 17 filas no son operadores (E-COMMERCE,
                   sucursales, rutas, «Otros Ingresos», sin vendedor): son el vendedor que el ERP
                   pone en la factura de telemarketing. El rótulo dice lo que la fila es. -->
              <h3>Por vendedor del ERP · 30 días</h3>
              <span class="muted">{{ d.billing.por_operador.length | number }} vendedores</span>
            </div>
            <div class="dt-scope"><p-table [value]="d.billing.por_operador" size="small" class="surf-table dt-stack">
              <ng-template #header>
                <tr>
                  <th>Vendedor</th>
                  <th class="comm-num">Facturas</th>
                  <th class="comm-num">Clientes</th>
                  <th class="comm-num">Facturado</th>
                  <th class="comm-num">Descuento</th>
                  <th class="comm-num">Por cobrar</th>
                </tr>
              </ng-template>
              <ng-template #body let-o>
                <tr>
                  <td data-label="Vendedor" role="cell" class="dt-id">
                    <strong>{{ o.vendedor_nombre || 'Sin vendedor asignado' }}</strong>
                    @if (o.vendedor_code) { <span class="sub mono">{{ o.vendedor_code }}</span> }
                  </td>
                  <td data-label="Facturas" role="cell" class="comm-num dt-num">{{ o.facturas }}</td>
                  <td data-label="Clientes" role="cell" class="comm-num dt-num">{{ o.clientes }}</td>
                  <td data-label="Facturado" role="cell" class="comm-num dt-num">{{ +o.importe | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</td>
                  <td data-label="Descuento" role="cell" class="comm-num dt-num">
                    @if (o.importe_lista != null) {
                      {{ (o.descuento_producto ?? 0) + (o.descuento_cliente ?? 0) | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}
                      <span class="sub-linea">{{ pct((o.descuento_producto ?? 0) + (o.descuento_cliente ?? 0), o.importe_lista) }} de la lista</span>
                    } @else {
                      <span class="muted">sin renglones</span>
                    }
                  </td>
                  <td data-label="Por cobrar" role="cell" class="comm-num debe dt-num">{{ +o.saldo | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="6" class="muted">Sin facturas de telemarketing en los últimos 30 días.</td></tr>
              </ng-template>
            </p-table></div>
            <p class="nota">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              El vendedor lo pone el ERP en la factura (<code>vendedor_code</code>), y no todos son
              operadores de telemarketing. No se puede cruzar con el usuario que registra las
              llamadas: no hay campo que los ligue.
            </p>
          </p-card>

          <p-card>
            <div class="card-header-row">
              <h3>Últimas facturas</h3>
              <a pButton routerLink="/telemarketing/documentos" severity="secondary" [text]="true" size="small"
                ><span class="p-button-label">Ver todas</span
                ><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span
              ></a>
            </div>
            <div class="dt-scope"><p-table [value]="d.billing.ultimas" size="small" class="surf-table dt-stack">
              <ng-template #header>
                <tr><th>Folio</th><th>Cliente</th><th class="comm-num">Total</th><th>Cobro</th></tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td data-label="Folio" role="cell" class="dt-id">
                    <code>{{ f.sucursal }} {{ f.doc_prefix }}-{{ f.folio }}</code>
                    <span class="sub">{{ f.fecha | date: 'dd/MM/yy' }}</span>
                  </td>
                  <td data-label="Cliente" role="cell">{{ f.cliente_nombre }}</td>
                  <td data-label="Total" role="cell" class="comm-num dt-num">{{ +f.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                  <td data-label="Cobro" role="cell">
                    <p-tag [severity]="COBRO_TONE[f.estatus_cobro]" [value]="COBRO_LABEL[f.estatus_cobro]"></p-tag>
                    @if (f.vencida) { <span class="sub bad">vencida</span> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="4" class="muted">Sin facturas en el periodo.</td></tr>
              </ng-template>
            </p-table></div>
          </p-card>
        </div>

        <!-- ── ACTIVIDAD: sólo existe si alguien capturó llamadas. Sin captura no se pintan
             indicadores: un cero sin registro no es desempeño (ADR-056). -->
        <h2 class="section-title"><i class="pi pi-phone" aria-hidden="true"></i> Actividad de llamadas</h2>
        @if (!d.actividad.registrada) {
          <div class="aviso"><p-message severity="warn">
            <span>
              <strong>No hay llamadas capturadas en este módulo</strong>, así que no hay actividad
              que medir. Los indicadores aparecen cuando los operadores registren sus llamadas
              desde la cola. La facturación de arriba no depende de esto: sale del ERP.
            </span>
          </p-message></div>
        } @else {
          @if (d.my_stats) {
            <h3 class="sub-title"><i class="pi pi-user" aria-hidden="true"></i> Mis llamadas · hoy</h3>
            <app-metric-strip [items]="myItems(d)" ariaLabel="Mis llamadas de hoy" />
          }
          <h3 class="sub-title">Equipo · hoy</h3>
          <app-metric-strip [items]="teamItems(d)" ariaLabel="Llamadas del equipo hoy" />
          <div class="two-col">
            <p-card>
              <h3>Operadores con más llamadas · hoy</h3>
              <div class="dt-scope"><p-table [value]="d.top_operators" size="small" class="surf-table dt-stack">
                <ng-template #header>
                  <tr>
                    <th>#</th>
                    <th>Operador</th>
                    <th class="comm-num">Llamadas</th>
                    <th class="comm-num">Ventas</th>
                    <th class="comm-num">Min</th>
                    <th class="comm-num">Conv.</th>
                  </tr>
                </ng-template>
                <ng-template #body let-op let-i="rowIndex">
                  <tr>
                    <td data-label="#" role="cell"><strong>{{ i + 1 }}</strong></td>
                    <td data-label="Operador" role="cell" class="dt-id">{{ op.username || '—' }}</td>
                    <td data-label="Llamadas" role="cell" class="comm-num dt-num">{{ op.calls }}</td>
                    <td data-label="Ventas" role="cell" class="comm-num pos dt-num">{{ op.orders }}</td>
                    <td data-label="Min" role="cell" class="comm-num dt-num">{{ op.minutes }}</td>
                    <td data-label="Conv." role="cell" class="comm-num dt-num">{{ opConversion(op) | number:'1.1-1' }}%</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="6" class="muted">Nadie ha registrado llamadas hoy.</td></tr>
                </ng-template>
              </p-table></div>
            </p-card>
            <p-card>
              <h3>Resultado de las llamadas · 7 días</h3>
              @for (o of d.outcomes_7d; track o.outcome) {
                <div class="outcome-row">
                  <div class="outcome-header">
                    <p-tag [value]="outcomeLabel(o.outcome)" [severity]="outcomeSeverity(o.outcome)"></p-tag>
                    <span class="outcome-count">{{ o.count }}</span>
                  </div>
                  <p-progressbar [value]="outcomePct(o, d)" [showValue]="false"></p-progressbar>
                </div>
              }
              @if (d.outcomes_7d.length === 0) {
                <p class="muted">Sin llamadas registradas en los últimos 7 días.</p>
              }
            </p-card>
          </div>
        }

        <!-- [E.16] La vista previa de la cola salió del Resumen: era trabajo del operador (a quién
             llamar) dentro del resumen del dinero del canal, y la cola tiene su pestaña. Queda la
             puerta y la declaración de su universo, que es lo que este tablero sí puede afirmar. -->
        <div class="aviso cola-linea"><p-message severity="info">
          <span>
            La cola de llamadas está en su pestaña.
            @if (d.billing.clientes_en_cola < d.billing.d30.clientes) {
              Sale del padrón de la plataforma, no de quien compra por el canal: de los
              <strong>{{ d.billing.d30.clientes | number }}</strong> clientes facturados en 30 días,
              <strong>{{ d.billing.clientes_en_cola | number }}</strong> están en ella.
            }
          </span>
          <a pButton routerLink="/telemarketing/queue" severity="secondary" [text]="true" size="small"><span class="p-button-label">Ir a la cola</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span></a>
        </p-message></div>

        <!-- [E.16] Las facturas detrás de cada conteo de «negociado contra aplicado»: el encabezado
             dice N y la lista llega a N (sin tope). Cada folio abre el documento. -->
        <app-side-peek [(open)]="peekAbierto" [width]="820"
          [title]="peekTipo() === 'menos' ? 'Facturas con menos % del negociado' : 'Facturas con más % del registrado'"
          [subtitle]="peekSubtitulo(d)">
          @if (peekDetalle(d); as lista) {
            <p class="nota">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Contra el maestro de clientes de hoy. Diferencia = subtotal × la diferencia de %.
            </p>
            <div class="dt-scope"><p-table [value]="lista" size="small" class="surf-table dt-stack">
              <ng-template #header>
                <tr>
                  <th>Folio</th>
                  <th>Cliente</th>
                  <th>Vendedor</th>
                  <th class="comm-num">Maestro</th>
                  <th class="comm-num">Factura</th>
                  <th class="comm-num">Subtotal</th>
                  <th class="comm-num">Diferencia</th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td data-label="Folio" role="cell" class="dt-id">
                    <a [routerLink]="['/telemarketing/documentos']" [queryParams]="{ doc: f.folio_digital }"><code>{{ f.folio_digital }}</code></a>
                    <span class="sub">{{ f.fecha | date: 'dd/MM/yy' }}</span>
                  </td>
                  <td data-label="Cliente" role="cell">{{ f.cliente_nombre || f.cliente_code || '—' }}</td>
                  <td data-label="Vendedor" role="cell">{{ f.vendedor_nombre || 'Sin vendedor asignado' }}</td>
                  <td data-label="Maestro" role="cell" class="comm-num dt-num">{{ f.pct_maestro | number: '1.0-2' }} %</td>
                  <td data-label="Factura" role="cell" class="comm-num dt-num">{{ f.pct_documento | number: '1.0-2' }} %</td>
                  <td data-label="Subtotal" role="cell" class="comm-num dt-num">{{ f.subtotal | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                  <td data-label="Diferencia" role="cell" class="comm-num dt-num"><strong>{{ f.diferencia | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</strong></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="7" class="muted">Ninguna factura en este grupo.</td></tr>
              </ng-template>
            </p-table></div>
          }
        </app-side-peek>
      }
    </app-load-state>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .header-actions { display:flex; align-items:center; gap:var(--sp-3); }
    .muted { color: var(--text-muted); font-size:var(--fs-sm); margin:0; }
    .section-title { margin: var(--sp-6) 0 var(--sp-3); font-size: var(--fs-micro); font-weight: var(--fw-bold); text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .section-title .asof { margin-left: var(--sp-2); text-transform: none; letter-spacing: 0; font-weight: var(--fw-regular); }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:var(--r-sm); font-size:var(--fs-xs); }
    app-metric-strip { display:block; margin-bottom:var(--sp-6); }

    .two-col { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap:var(--sp-4); }
    .two-col h3 { margin: 0 0 var(--sp-3); font-size: var(--fs-h3); }
    .comm-num.pos { color: var(--ok-fg); font-weight: var(--fw-bold); }
    .comm-num.debe { color: var(--bad-fg); font-weight: var(--fw-bold); }
    .sub-title { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-muted); }
    .sub-title i { margin-right: .35rem; }
    .sub { display: inline-block; margin-left: .35rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .sub.bad { color: var(--bad-fg); }
    .mono { font-family: var(--font-mono); }
    .nota { display: flex; gap: .4rem; margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    /* Lo que no se pudo medir o no cubre el universo se DECLARA (ADR-056), con p-message. */
    .aviso { margin: 0 0 var(--sp-3); }

    /* [E.15] La cuenta del descuento: etiqueta a la izquierda, cifra alineada, base del % al lado. */
    .descuentos { display:block; margin-bottom: var(--sp-4); }
    .desc-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: var(--sp-6); align-items: start; }
    /* La cuenta: base surf-table--plain; sólo lo propio de una cuenta (subtotal, definición, base del %). */
    .cuenta th { text-align:left; font-weight: var(--fw-regular); }
    .cuenta td.pct { color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; }
    .cuenta .def { display:block; font-size: var(--fs-xs); color: var(--text-muted); }
    .cuenta tr.parcial th, .cuenta tr.parcial td { font-weight: var(--fw-bold); }
    .cuenta tfoot th { text-align:left; }
    .negociado h4 { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .negociado dl { margin: 0; display:flex; flex-direction:column; gap: var(--sp-2); }
    .negociado dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .negociado dd { margin: 0; font-size: var(--fs-sm); }
    .sub-linea { display:block; font-size: var(--fs-xs); color: var(--text-muted); }

    .outcome-row { margin-bottom: var(--sp-3); }
    .outcome-header { display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--sp-1); }
    .outcome-count { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }

    .aviso.cola-linea { margin-top: var(--sp-4); }
    .card-header-row { display:flex; justify-content:space-between; align-items:center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .card-header-row h3 { margin: 0; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeleventaDashboardComponent {
  private readonly api = inject(TeleventaService);

  readonly data = signal<TeleventaDashboard | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Hora del navegador en que llegó la respuesta: la píldora dice «cargado», no «dato al». */
  readonly loadedAt = signal<Date | null>(null);
  /** [E.16] El panel con las facturas detrás de un conteo de negociado contra aplicado. */
  readonly peekAbierto = signal(false);
  readonly peekTipo = signal<'menos' | 'mas'>('menos');

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getDashboard().subscribe({
      next: (d) => {
        this.data.set(d);
        this.loadedAt.set(new Date());
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(e?.error?.message || e?.message || 'El servidor no respondió.');
      },
    });
  }

  readonly COBRO_LABEL: Record<string, string> = {
    pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente',
    sin_cartera: 'Sin cartera', cancelada: 'Cancelada',
  };
  readonly COBRO_TONE: Record<string, 'success' | 'warn' | 'danger' | 'secondary' | 'info'> = {
    pagada: 'success', parcial: 'warn', pendiente: 'info',
    sin_cartera: 'secondary', cancelada: 'secondary',
  };

  /**
   * E.9 — el dinero del canal. Cada cifra dice su ventana en el rótulo: la sección ya no lleva
   * «últimos 30 días» porque el vencido abarca toda la cartera.
   * «Ya cobrado» es de lo FACTURADO en 30 días (importe − saldo), no el dinero que entró en
   * esos días — por eso no se rotula «Cobrado 30d».
   */
  billingItems(d: TeleventaDashboard): MetricStripItem[] {
    const b = d.billing;
    const cobrado = b.d30.importe - b.d30.saldo;
    const pctCobrado = b.d30.importe > 0 ? (cobrado / b.d30.importe) * 100 : null;
    const v = b.cartera_vencida;
    return [
      {
        label: 'Facturado 30 días', value: b.d30.importe, format: 'currency',
        sub: `${b.d30.facturas.toLocaleString('es-MX')} facturas · ${b.d30.clientes.toLocaleString('es-MX')} clientes`,
      },
      {
        // [E.15] Producto + cliente, medidos como diferencias. El desglose está en su tarjeta.
        label: 'Descontado 30 días', value: b.descuentos.producto + b.descuentos.cliente, format: 'currency',
        sub: `${this.pct(b.descuentos.producto + b.descuentos.cliente, b.descuentos.lista)} del precio de lista`,
      },
      { label: 'Este mes', value: b.mes.importe, format: 'currency', sub: `${b.mes.facturas.toLocaleString('es-MX')} facturas` },
      {
        label: 'Ya cobrado', value: cobrado, format: 'currency',
        sub: pctCobrado == null ? 'de lo facturado en 30 días' : `${pctCobrado.toFixed(0)}% de lo facturado en 30 días`,
      },
      {
        label: 'Vencido · toda la cartera', value: v.saldo, format: 'currency',
        tone: v.saldo > 0 ? 'bad' : undefined,
        sub: `${v.facturas.toLocaleString('es-MX')} facturas · ${MXN.format(b.d30.saldo_vencido)} de los últimos 30 días`,
      },
    ];
  }

  myItems(d: TeleventaDashboard): MetricStripItem[] {
    const m = d.my_stats!;
    return [
      { label: 'Llamadas', value: m.my_calls },
      { label: 'Ventas confirmadas', value: m.my_orders, tone: m.my_orders > 0 ? 'ok' : undefined },
      { label: 'Minutos en línea', value: m.my_minutes },
      this.conversionItem('Mi conversión', m.my_orders, m.my_calls, 'sin llamadas tuyas hoy'),
    ];
  }

  teamItems(d: TeleventaDashboard): MetricStripItem[] {
    const c7 = d.conversion_7d;
    const conv7 = this.conversionItem('Conversión 7 días', c7.orders_taken, c7.total_calls, 'sin llamadas en 7 días');
    return [
      { label: 'Llamadas hoy', value: d.today.calls, sub: `${d.today.total_minutes} min totales` },
      {
        label: 'Ventas confirmadas', value: d.today.orders_taken,
        tone: d.today.orders_taken > 0 ? 'ok' : undefined,
        sub: d.today.calls ? `${((d.today.orders_taken / d.today.calls) * 100).toFixed(1)}% de las llamadas` : 'sin llamadas hoy',
      },
      { label: 'Reservas activas', value: d.active_reservations.total, sub: `${d.active_reservations.unique_operators} operadores` },
      { ...conv7, sub: c7.total_calls ? `${c7.orders_taken} / ${c7.total_calls} llamadas` : conv7.sub },
    ];
  }

  /** Sin llamadas no hay conversión: se declara «no medido», no se dibuja un 0 %. */
  private conversionItem(label: string, ventas: number, llamadas: number, motivo: string): MetricStripItem {
    if (!llamadas) {
      return { label, value: '—', format: 'text', state: 'no_medido', stateNote: motivo, sub: motivo };
    }
    return { label, value: (ventas / llamadas) * 100, format: 'percent' };
  }

  abrirPeek(tipo: 'menos' | 'mas'): void {
    this.peekTipo.set(tipo);
    this.peekAbierto.set(true);
  }
  private peekGrupo(d: TeleventaDashboard): DiferenciaMaestro {
    const ds = d.billing.descuentos;
    return this.peekTipo() === 'menos' ? ds.negociado_no_aplicado : ds.sin_respaldo_maestro;
  }
  peekDetalle(d: TeleventaDashboard): DiferenciaMaestro['detalle'] {
    return this.peekGrupo(d).detalle;
  }
  /** El conteo del panel tiene que ser el de la tarjeta: si no lo es, se dice (Cruce 1). */
  peekSubtitulo(d: TeleventaDashboard): string {
    const g = this.peekGrupo(d);
    const base = `${g.facturas.toLocaleString('es-MX')} facturas · ${MXN.format(g.monto)} de diferencia`;
    return g.detalle.length === g.facturas ? base : `${base} · se listan ${g.detalle.length}`;
  }

  /** «2.37 %» con su base dicha al lado en la plantilla; sin base no hay porcentaje. */
  pct(parte: number, base: number | null): string {
    if (!base) return '—';
    return `${((parte / base) * 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
  }

  opConversion(op: { calls: number; orders: number }): number {
    if (!op.calls) return 0;
    return (op.orders / op.calls) * 100;
  }
  outcomePct(o: { count: number }, d: TeleventaDashboard): number {
    const total = d.outcomes_7d.reduce((acc, x) => acc + x.count, 0);
    return total > 0 ? (o.count / total) * 100 : 0;
  }
  outcomeLabel(outcome: string): string {
    return callOutcomeLabel(outcome);
  }
  outcomeSeverity(outcome: string): ReturnType<typeof callOutcomeSeverity> {
    return callOutcomeSeverity(outcome);
  }
}
