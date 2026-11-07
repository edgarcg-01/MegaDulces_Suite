import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type {
  VecinalCashierOrder,
  VecinalCashiersResponse,
  VecinalMonitorLine,
  VecinalPickerOrder,
  VecinalPickersResponse,
  VecinalVendorDetail,
  VecinalVendorRow,
  VecinalVendorVisit,
  VecinalVendorsResponse,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SucursalPickerComponent, unCodigo } from '../../../shared/components/sucursal-picker/sucursal-picker.component';
import { MapComponent, type MapMarker } from '../../../shared/components/map/map.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { money } from '../../../shared/util/money.util';
import { todayMx } from '../../../core/utils/mx-date';
import { VecinalMonitorService, type FiltroMonitoreo } from '../vecinal-monitor.service';
import { type AtajoPeriodo, type Periodo, diasConActividad, etiquetaPeriodo, rangoDe, rangoValido } from '../monitoreo-periodo';

type Vista = 'resumen' | 'vendedores' | 'surtidores' | 'cajeras';
type Modo = 'total' | 'promedio';
/** Un detalle que se carga al desplegar la fila. */
interface Carga<T> { cargando: boolean; error: string | null; data: T | null }

const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });
const dia = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short' });
const MOTIVO: Record<string, string> = {
  cerrado: 'estaba cerrado', no_atendio: 'no lo atendieron', con_inventario: 'tiene mercancía',
  sin_recursos: 'sin dinero', no_interesado: 'no le interesó', otro: 'otro',
};

/**
 * `[MV.3]` **Monitoreo vecinal** (Comercial › Ruta y vendedores): lo que hace cada persona de la
 * preventa vecinal —vendedores, surtidores y cajeras—, por sucursal, ruta y periodo.
 *
 * Decisiones de David (2026-11-05): se ve el periodo en calendario con atajos; en periodos largos,
 * total o promedio por día; del vendedor, lo LEVANTADO en la app y lo COBRADO en Kepler (la meta se
 * mide contra lo cobrado, como en el tablero del supervisor); con su recorrido (validado con RH).
 *
 * Lo que no se registra se dice: lo cobrado sin la vista de Kepler, el tiempo de revisión de la caja
 * y los clientes de la ruta en periodos de más de un día. Nunca se pinta como cero.
 */
@Component({
  selector: 'app-comercial-monitoreo-vecinal',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, SelectModule, DatePickerModule, TagModule, TooltipModule,
    LoadStateComponent, FreshnessPillComponent, SegmentedComponent, SucursalPickerComponent, MapComponent, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page mv-page">
      <header class="mv-head">
        <div class="mv-head-t">
          <h1 class="mv-h1">Monitoreo vecinal</h1>
          <p class="mv-sub">Lo que hace cada persona de la preventa: vendedores, surtidores y caja.</p>
        </div>
        <div class="mv-tools">
          <app-sucursal-picker [(valor)]="sucursal" (valorChange)="recargar()"></app-sucursal-picker>
          <p-select inputId="mv-ruta" [options]="rutasOpc()" [ngModel]="ruta()" (ngModelChange)="ruta.set($event ?? null)" (onChange)="recargar()" placeholder="Todas las rutas vecinales"
                    [showClear]="true" ariaLabel="Ruta vecinal" styleClass="mv-ruta"></p-select>
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="120"></app-freshness-pill>
        </div>
      </header>

      <div class="mv-periodo" role="group" aria-label="Periodo">
        @for (a of atajos; track a.key) {
          <button type="button" class="mv-chip" [class.on]="atajo() === a.key" [attr.aria-pressed]="atajo() === a.key" (click)="elegirAtajo(a.key)">{{ a.label }}</button>
        }
        <p-datepicker inputId="mv-rango" [(ngModel)]="rango" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                      [maxDate]="hoyDate" placeholder="Elegir fechas" ariaLabel="Elegir fechas en el calendario" (onClose)="elegirRango()"></p-datepicker>
      </div>

      <p class="mv-filtro">
        Mostrando <b>{{ ruta() ? 'la ruta ' + ruta() : 'todas las rutas vecinales' }}</b> · <b>{{ etiqueta() }}</b>
        @if (periodo().days > 1) { <span>({{ periodo().days }} días con actividad)</span> }
      </p>

      <!-- [MV.3] Answer-first (DESIGN Q.1): el veredicto del periodo antes de cualquier tabla. -->
      <app-metric-strip [items]="resumen()" [instant]="true" ariaLabel="Resumen del periodo"></app-metric-strip>

      <div class="mv-bar">
        <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Vista"></app-segmented>
        @if (periodo().days > 1) {
          <app-segmented [options]="modos" [value]="modo()" (valueChange)="modo.set($any($event))" ariaLabel="Total del periodo o promedio por día"></app-segmented>
        }
      </div>

      <!-- ─────────── RESUMEN ─────────── -->
      @if (vista() === 'resumen') {
        <div class="mv-grid">
          <section class="mv-card">
            <h2 class="mv-h2">Vendedores</h2>
            <app-load-state [loading]="vend().cargando && !vend().data" [error]="vend().error" [isEmpty]="!!vend().data && !vend().data!.rows.length"
                            emptyIcon="pi-users" emptyTitle="Ningún vendedor con ruta vecinal" emptyHint="En la sucursal, ruta y periodo elegidos." (retry)="cargarVendedores()">
              <p-table [value]="vend().data?.rows ?? []" styleClass="surf-table surf-table--plain" [rowHover]="true">
                <ng-template #header><tr><th>Vendedor</th><th class="comm-num">Visitas</th><th class="comm-num">Levantado</th><th class="comm-num">Cobrado</th><th class="comm-num">Meta</th></tr></ng-template>
                <ng-template #body let-v>
                  <tr class="mv-click" tabindex="0" (click)="irA('vendedores', v.user_id)" (keydown.enter)="irA('vendedores', v.user_id)">
                    <td><b>{{ v.name }}</b></td><td class="comm-num">{{ cuenta(v.visits) }}</td><td class="comm-num">{{ dinero(v.ordered_total) }}</td>
                    <td class="comm-num">@if (v.charged !== null) { {{ dinero(v.charged) }} } @else { <span class="mv-nm" [pTooltip]="v.charged_unmeasured_reason ?? ''">sin medir</span> }</td>
                    <td class="comm-num">{{ v.progress_pct !== null ? v.progress_pct + ' %' : '—' }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </app-load-state>
          </section>
          <section class="mv-card">
            <h2 class="mv-h2">Surtidores</h2>
            <app-load-state [loading]="surt().cargando && !surt().data" [error]="surt().error" [isEmpty]="!!surt().data && !surt().data!.rows.length"
                            emptyIcon="pi-box" emptyTitle="Nadie surtió preventa" emptyHint="En la sucursal y periodo elegidos." (retry)="cargarSurtidores()">
              <p-table [value]="surt().data?.rows ?? []" styleClass="surf-table surf-table--plain" [rowHover]="true">
                <ng-template #header><tr><th>Surtidor</th><th class="comm-num">Pedidos</th><th class="comm-num">Prom.</th><th class="comm-num">Con faltante</th></tr></ng-template>
                <ng-template #body let-s>
                  <tr class="mv-click" tabindex="0" (click)="irA('surtidores', s.user_id)" (keydown.enter)="irA('surtidores', s.user_id)">
                    <td><b>{{ s.name }}</b></td><td class="comm-num">{{ cuenta(s.taken) }}</td><td class="comm-num">{{ minutos(s.avg_minutes) }}</td><td class="comm-num">{{ cuenta(s.with_shortage) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </app-load-state>
          </section>
          <section class="mv-card">
            <h2 class="mv-h2">Cajeras</h2>
            <app-load-state [loading]="caja().cargando && !caja().data" [error]="caja().error" [isEmpty]="!!caja().data && !caja().data!.rows.length && !caja().data!.pending.count"
                            emptyIcon="pi-wallet" emptyTitle="Nadie revisó pedidos" emptyHint="En la sucursal y periodo elegidos." (retry)="cargarCajeras()">
              @if (caja().data?.pending?.count) {
                <p class="mv-pend"><i class="pi pi-clock" aria-hidden="true"></i> {{ caja().data!.pending.count }} por revisar · {{ dinero(caja().data!.pending.should_charge) }}</p>
              }
              <p-table [value]="caja().data?.rows ?? []" styleClass="surf-table surf-table--plain" [rowHover]="true">
                <ng-template #header><tr><th>Cajera</th><th class="comm-num">Revisados</th><th class="comm-num">Espera</th><th class="comm-num">Debió cobrar</th></tr></ng-template>
                <ng-template #body let-c>
                  <tr class="mv-click" tabindex="0" (click)="irA('cajeras', c.user_id)" (keydown.enter)="irA('cajeras', c.user_id)">
                    <td><b>{{ c.name }}</b></td><td class="comm-num">{{ cuenta(c.reviewed) }}</td><td class="comm-num">{{ minutos(c.avg_wait_minutes) }}</td><td class="comm-num">{{ dinero(c.should_charge) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </app-load-state>
          </section>
        </div>
      }

      <!-- ─────────── VENDEDORES ─────────── -->
      @if (vista() === 'vendedores') {
        <section class="mv-card">
          <app-load-state [loading]="vend().cargando && !vend().data" [error]="vend().error" [isEmpty]="!!vend().data && !vend().data!.rows.length"
                          emptyIcon="pi-users" emptyTitle="Ningún vendedor con ruta vecinal" emptyHint="En la sucursal, ruta y periodo elegidos." (retry)="cargarVendedores()">
            <p-table [value]="vend().data?.rows ?? []" dataKey="user_id" [expandedRowKeys]="abiertos()" styleClass="surf-table surf-table--plain surf-table--sticky" [rowHover]="true">
              <ng-template #header>
                <tr><th style="width:2rem"><span class="sr-only">Detalle</span></th><th>Vendedor</th><th>Estado</th><th>Actividad</th><th class="comm-num">Visitas</th><th class="comm-num">Con pedido</th>
                  <th class="comm-num">Sin pedido</th><th class="comm-num">En cada cliente</th><th class="comm-num">Levantado</th><th class="comm-num">Cobrado Kepler</th><th>Meta</th><th>Ubicación</th></tr>
              </ng-template>
              <ng-template #body let-v let-expanded="expanded">
                <tr class="mv-click" tabindex="0" [attr.aria-expanded]="expanded" (click)="alternar(v.user_id, 'v')" (keydown.enter)="alternar(v.user_id, 'v')">
                  <td><i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i></td>
                  <td><b>{{ v.name }}</b><span class="mv-mini">{{ v.routes.join(' · ') }}</span></td>
                  <td>
                    @if (v.day_state) { <p-tag [value]="estadoTxt(v)" [severity]="estadoSev(v)"></p-tag> }
                    @else { <span class="mv-mini">{{ v.days_on_route }} {{ v.days_on_route === 1 ? 'día' : 'días' }} en ruta</span> }
                  </td>
                  <td class="mv-mono">{{ horaDe(v.first_at) || '—' }}<span class="mv-mini">últ. {{ horaDe(v.last_at) || '—' }}</span></td>
                  <td class="comm-num">{{ cuenta(v.visits) }}@if (v.planned_customers !== null) {<span class="mv-mini">de {{ v.planned_customers }}</span>}</td>
                  <td class="comm-num">{{ cuenta(v.with_order) }}</td>
                  <td class="comm-num">{{ cuenta(v.no_sale_with_reason + v.no_sale_without_reason) }}@if (v.no_sale_without_reason) {<span class="mv-mini mv-flag">{{ cuenta(v.no_sale_without_reason) }} sin motivo</span>}</td>
                  <td class="comm-num">{{ minutos(v.avg_visit_minutes) }}@if (v.open_visits) {<span class="mv-mini mv-flag">{{ v.open_visits }} sin cerrar</span>}</td>
                  <td class="comm-num">{{ dinero(v.ordered_total, true) }}</td>
                  <td class="comm-num">@if (v.charged !== null) { {{ dinero(v.charged, true) }} } @else { <span class="mv-nm" [pTooltip]="v.charged_unmeasured_reason ?? ''">sin medir</span> }</td>
                  <td>
                    @if (v.target !== null) {
                      <span class="mv-meta"><span class="mv-barra" aria-hidden="true"><i [style.width.%]="min100(v.progress_pct)"></i></span>
                        <span class="mv-mono">{{ v.progress_pct !== null ? v.progress_pct + ' %' : 'sin medir' }}</span></span>
                      <span class="mv-mini">de {{ dinero(v.target) }}</span>
                    } @else { <span class="mv-nm">sin meta</span> }
                  </td>
                  <td>@if (v.gps_points) { <span class="mv-mini">{{ v.gps_points }} puntos · últ. {{ horaDe(v.gps_last_at) }}</span> } @else { <span class="mv-nm">sin ubicación</span> }</td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-v>
                <tr class="mv-sub"><td colspan="12">
                  @if (detV()[v.user_id]; as c) {
                    <app-load-state [loading]="c.cargando" [error]="c.error" [isEmpty]="!!c.data && !c.data.visits.length && !c.data.gps.points.length"
                                    emptyIcon="pi-map-marker" emptyTitle="Sin visitas ni pedidos en el periodo" emptyHint="" (retry)="cargarVendedor(v.user_id)">
                      @if (c.data; as d) {
                        <div class="mv-det">
                          <div class="mv-det-h">
                            <span><b>{{ d.visits.length }}</b> {{ d.visits.length === 1 ? 'cliente' : 'clientes' }} en el periodo</span>
                            <span>Levantado <b class="mv-mono">{{ dinero(d.ordered_total) }}</b></span>
                            <span>Cobrado Kepler @if (d.charged !== null) { <b class="mv-mono">{{ dinero(d.charged) }}</b> } @else { <span class="mv-nm" [pTooltip]="d.charged_unmeasured_reason ?? ''">sin medir</span> }</span>
                            <span>Meta @if (d.target !== null) { <b class="mv-mono">{{ dinero(d.target) }}</b> } @else { <span class="mv-nm">sin meta</span> }</span>
                          </div>
                          @if (d.gps.points.length || conUbicacion(d)) {
                            <app-map [markers]="marcadores(d)" [path]="camino(d)" height="300px"></app-map>
                            <p class="mv-nota">Recorrido con la app abierta ({{ d.gps.total }} puntos{{ d.gps.truncated ? ', se muestran los primeros ' + d.gps.points.length : '' }}). Los números son las visitas en orden.</p>
                          }
                          <div class="mv-tw">
                            <table class="mv-tabla">
                              <thead><tr><th>#</th><th>Hora</th><th>Cliente</th><th class="comm-num">Tiempo con él</th><th>Resultado</th><th class="comm-num">Levantado</th><th class="comm-num">Cobrado Kepler</th><th>Qué le vendió</th></tr></thead>
                              <tbody>
                                @for (x of d.visits; track $index; let i = $index) {
                                  <tr>
                                    <td class="mv-mono">{{ i + 1 }}</td>
                                    <td class="mv-mono mv-nw">@if (multiDia()) { {{ diaDe(x.visited_at || x.date) }} } {{ horaDe(x.visited_at) || '—' }}{{ x.ended_at ? '–' + horaDe(x.ended_at) : '' }}</td>
                                    <td class="mv-nw"><b>{{ x.customer_name || 'Cliente' }}</b><span class="mv-mini">{{ x.customer_code }}</span></td>
                                    <td class="comm-num">@if (x.status === 'abierta') { <span class="mv-flag">sin cerrar</span> } @else if (x.minutes !== null) { {{ x.minutes }} min } @else { <span class="mv-nm">—</span> }</td>
                                    <td class="mv-nw">
                                      @switch (x.status) {
                                        @case ('con_pedido') { <span class="mv-ok">{{ codigos(x) }}</span> }
                                        @case ('sin_pedido') { @if (x.no_sale_reason) { <span class="mv-mute">sin venta · {{ motivo(x.no_sale_reason) }}</span> } @else { <span class="mv-flag">sin venta · sin motivo</span> } }
                                        @case ('abierta') { <span class="mv-flag">en curso</span> }
                                        @case ('sin_visita') { <span class="mv-mute">pedido sin abrir visita</span> }
                                      }
                                    </td>
                                    <td class="comm-num">{{ x.ordered_total ? dinero(x.ordered_total) : '—' }}</td>
                                    <td class="comm-num">@if (x.charged === null) { <span class="mv-nm">sin medir</span> } @else { {{ x.charged ? dinero(x.charged) : '—' }} }</td>
                                    <td class="mv-ancho">
                                      @if (lineasVenta(x).length) {
                                        <span class="mv-prods">
                                          @for (l of lineasVenta(x); track $index) { <span class="mv-q">{{ l.quantity }} {{ l.unit }}</span><span class="mv-pn">{{ l.product_name }}@if (l.sku) {<span class="mv-sku">{{ l.sku }}</span>}</span><span class="mv-imp">{{ dinero(l.line_total) }}</span> }
                                        </span>
                                      } @else { — }
                                    </td>
                                  </tr>
                                }
                              </tbody>
                            </table>
                          </div>
                          @if (d.truncated) { <p class="mv-nota">Se muestran las {{ d.visits.length }} más recientes de {{ d.total_visits }}.</p> }
                        </div>
                      }
                    </app-load-state>
                  }
                </td></tr>
              </ng-template>
            </p-table>
          </app-load-state>
        </section>
      }

      <!-- ─────────── SURTIDORES ─────────── -->
      @if (vista() === 'surtidores') {
        <section class="mv-card">
          <app-load-state [loading]="surt().cargando && !surt().data" [error]="surt().error" [isEmpty]="!!surt().data && !surt().data!.rows.length"
                          emptyIcon="pi-box" emptyTitle="Nadie surtió preventa" emptyHint="En la sucursal y periodo elegidos." (retry)="cargarSurtidores()">
            <p-table [value]="surt().data?.rows ?? []" dataKey="user_id" [expandedRowKeys]="abiertos()" styleClass="surf-table surf-table--plain surf-table--sticky" [rowHover]="true">
              <ng-template #header>
                <tr><th style="width:2rem"><span class="sr-only">Detalle</span></th><th>Surtidor</th><th>Actividad</th><th class="comm-num">Tomados</th><th class="comm-num">Terminados</th><th class="comm-num">En curso</th>
                  <th class="comm-num">Prom. por pedido</th><th class="comm-num">El más lento</th><th class="comm-num">Con faltante</th><th class="comm-num">Cambiados por otro</th><th class="comm-num">Ajustados en caja</th></tr>
              </ng-template>
              <ng-template #body let-s let-expanded="expanded">
                <tr class="mv-click" tabindex="0" [attr.aria-expanded]="expanded" (click)="alternar(s.user_id, 's')" (keydown.enter)="alternar(s.user_id, 's')">
                  <td><i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i></td>
                  <td><b>{{ s.name }}</b></td>
                  <td class="mv-mono">{{ horaDe(s.first_at) || '—' }}<span class="mv-mini">últ. {{ horaDe(s.last_at) || '—' }}</span></td>
                  <td class="comm-num">{{ cuenta(s.taken) }}</td><td class="comm-num">{{ cuenta(s.finished) }}</td><td class="comm-num">{{ s.in_progress }}</td>
                  <td class="comm-num" [class.mv-flag]="(s.avg_minutes ?? 0) > 30">{{ minutos(s.avg_minutes) }}</td>
                  <td class="comm-num">@if (s.slowest) { {{ s.slowest.minutes }} min<span class="mv-mini">{{ s.slowest.code }}</span> } @else { — }</td>
                  <td class="comm-num">{{ cuenta(s.with_shortage) }}</td><td class="comm-num">{{ cuenta(s.substituted) }}</td><td class="comm-num">{{ cuenta(s.adjusted_by_cashier) }}</td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-s>
                <tr class="mv-sub"><td colspan="11">
                  @if (detS()[s.user_id]; as c) {
                    <app-load-state [loading]="c.cargando" [error]="c.error" [isEmpty]="!!c.data && !c.data.data.length" emptyIcon="pi-box" emptyTitle="Sin pedidos" emptyHint="" (retry)="cargarSurtidor(s.user_id)">
                      @if (c.data; as d) {
                        <div class="mv-det">
                          <div class="mv-tw">
                            <table class="mv-tabla">
                              <thead><tr><th>Pedido</th><th>Cliente</th><th>Tomó – terminó</th><th class="comm-num">Tiempo</th><th>Qué surtió (surtido / pedido)</th><th>Cambios</th></tr></thead>
                              <tbody>
                                @for (o of d.data; track o.order_id) {
                                  <tr>
                                    <td class="mv-mono">{{ o.code }}</td>
                                    <td class="mv-nw"><b>{{ o.customer_name || 'Cliente' }}</b><span class="mv-mini">de {{ o.seller_name || 'sin vendedor' }}</span></td>
                                    <td class="mv-mono mv-nw">@if (multiDia()) { {{ diaDe(o.started_at) }} } {{ horaDe(o.started_at) }}–{{ o.finished_at ? horaDe(o.finished_at) : '…' }}</td>
                                    <td class="comm-num" [class.mv-flag]="(o.minutes ?? 0) > 30">@if (o.minutes !== null) { {{ o.minutes }} min } @else { <span class="mv-flag">en curso</span> }</td>
                                    <td class="mv-ancho">
                                      <span class="mv-prods">
                                        @for (l of o.lines; track $index) {
                                          <span class="mv-q">{{ l.picked }}/{{ l.ordered }} {{ l.unit }}</span>
                                          <span class="mv-pn">{{ l.product_name }}@if (l.sku) {<span class="mv-sku">{{ l.sku }}</span>}</span>
                                          <span class="mv-imp">{{ notaSurtido(l) }}</span>
                                        }
                                      </span>
                                    </td>
                                    <td class="mv-nw">
                                      @if (o.outcome === 'completo') { <span class="mv-ok">hubo todo</span> } @else if (o.outcome === 'con_faltantes') { <span class="mv-flag">faltó</span> } @else { — }
                                      @if (o.adjusted_by_cashier) { <span class="mv-mini">después la caja lo ajustó</span> }
                                    </td>
                                  </tr>
                                }
                              </tbody>
                            </table>
                          </div>
                          @if (d.truncated) { <p class="mv-nota">Se muestran los {{ d.data.length }} más recientes de {{ d.total }}.</p> }
                        </div>
                      }
                    </app-load-state>
                  }
                </td></tr>
              </ng-template>
            </p-table>
          </app-load-state>
        </section>
      }

      <!-- ─────────── CAJERAS ─────────── -->
      @if (vista() === 'cajeras') {
        <section class="mv-card">
          @if (caja().data?.pending?.count) {
            <p class="mv-pend"><i class="pi pi-clock" aria-hidden="true"></i>
              Esperan revisión <b>{{ caja().data!.pending.count }}</b> {{ caja().data!.pending.count === 1 ? 'pedido' : 'pedidos' }} por {{ dinero(caja().data!.pending.should_charge) }}
              @if (caja().data!.pending.oldest_finished_at) { · el más viejo, surtido {{ diaDe(caja().data!.pending.oldest_finished_at) }} {{ horaDe(caja().data!.pending.oldest_finished_at) }} }
            </p>
          }
          <app-load-state [loading]="caja().cargando && !caja().data" [error]="caja().error" [isEmpty]="!!caja().data && !caja().data!.rows.length"
                          emptyIcon="pi-wallet" emptyTitle="Nadie revisó pedidos" emptyHint="En la sucursal y periodo elegidos." (retry)="cargarCajeras()">
            <p-table [value]="caja().data?.rows ?? []" dataKey="user_id" [expandedRowKeys]="abiertos()" styleClass="surf-table surf-table--plain surf-table--sticky" [rowHover]="true">
              <ng-template #header>
                <tr><th style="width:2rem"><span class="sr-only">Detalle</span></th><th>Cajera</th><th>Actividad</th><th class="comm-num">Revisados</th><th class="comm-num">Espera media</th>
                  <th class="comm-num">Por revisión</th><th class="comm-num">Completó</th><th class="comm-num">Quitó</th><th class="comm-num">Movió el total</th><th class="comm-num">Debió cobrar</th></tr>
              </ng-template>
              <ng-template #body let-c let-expanded="expanded">
                <tr class="mv-click" tabindex="0" [attr.aria-expanded]="expanded" (click)="alternar(c.user_id, 'c')" (keydown.enter)="alternar(c.user_id, 'c')">
                  <td><i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i></td>
                  <td><b>{{ c.name }}</b></td>
                  <td class="mv-mono">{{ horaDe(c.first_at) || '—' }}<span class="mv-mini">últ. {{ horaDe(c.last_at) || '—' }}</span></td>
                  <td class="comm-num">{{ cuenta(c.reviewed) }}</td>
                  <td class="comm-num" [class.mv-flag]="(c.avg_wait_minutes ?? 0) > 60">{{ minutos(c.avg_wait_minutes) }}</td>
                  <td class="comm-num"><span class="mv-nm" pTooltip="No se registra cuándo empieza a revisar, sólo cuándo termina.">no se registra</span></td>
                  <td class="comm-num">{{ cuenta(c.completed_lines) }}</td><td class="comm-num">{{ cuenta(c.removed_lines) }}</td>
                  <td class="comm-num">{{ c.delta ? (c.delta > 0 ? '+' : '') + dinero(c.delta, true) : '—' }}</td>
                  <td class="comm-num"><b>{{ dinero(c.should_charge, true) }}</b></td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-c>
                <tr class="mv-sub"><td colspan="10">
                  @if (detC()[c.user_id]; as k) {
                    <app-load-state [loading]="k.cargando" [error]="k.error" [isEmpty]="!!k.data && !k.data.data.length" emptyIcon="pi-wallet" emptyTitle="Sin pedidos revisados" emptyHint="" (retry)="cargarCajera(c.user_id)">
                      @if (k.data; as d) {
                        <div class="mv-det">
                          <div class="mv-det-h"><span>Debió cobrar en total <b class="mv-mono">{{ dinero(totalDebio(d.data)) }}</b> en {{ d.data.length }} {{ d.data.length === 1 ? 'pedido' : 'pedidos' }}</span></div>
                          <div class="mv-tw">
                            <table class="mv-tabla">
                              <thead><tr><th>Pedido</th><th>Cliente</th><th>Revisó</th><th class="comm-num">Espera</th><th>Qué quedó</th><th class="comm-num">Antes</th><th class="comm-num">Debió cobrar</th></tr></thead>
                              <tbody>
                                @for (o of d.data; track o.order_id) {
                                  <tr>
                                    <td class="mv-mono">{{ o.code }}</td>
                                    <td class="mv-nw"><b>{{ o.customer_name || 'Cliente' }}</b><span class="mv-mini">surtió {{ o.picker_name || '—' }}</span></td>
                                    <td class="mv-mono mv-nw">@if (multiDia()) { {{ diaDe(o.reviewed_at) }} } {{ horaDe(o.reviewed_at) || '—' }}</td>
                                    <td class="comm-num">{{ minutos(o.wait_minutes) }}</td>
                                    <td class="mv-ancho">
                                      <span class="mv-prods">
                                        @for (l of o.lines; track $index) {
                                          <span class="mv-q">{{ l.final ?? l.picked }} {{ l.unit }}</span>
                                          <span class="mv-pn">{{ l.product_name }}@if (l.sku) {<span class="mv-sku">{{ l.sku }}</span>}</span>
                                          <span class="mv-imp">{{ notaCaja(l) }}</span>
                                        }
                                      </span>
                                    </td>
                                    <td class="comm-num">{{ o.total_before !== null ? dinero(o.total_before) : '—' }}</td>
                                    <td class="comm-num"><b>{{ dinero(o.should_charge) }}</b></td>
                                  </tr>
                                }
                              </tbody>
                            </table>
                          </div>
                          @if (d.truncated) { <p class="mv-nota">Se muestran los {{ d.data.length }} más recientes de {{ d.total }}.</p> }
                          <p class="mv-nota">«Debió cobrar» es el total del pedido como lo dejó la revisión, con IVA.</p>
                        </div>
                      }
                    </app-load-state>
                  }
                </td></tr>
              </ng-template>
            </p-table>
          </app-load-state>
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mv-page { display: grid; gap: var(--sp-3); }
    .mv-head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
    .mv-head-t { flex: 1 1 260px; min-width: 0; }
    .mv-h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; }
    .mv-sub { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .mv-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .mv-periodo { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
    .mv-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill); padding: var(--sp-1) var(--sp-3);
      font: inherit; font-size: var(--fs-sm); font-weight: 700; cursor: pointer; min-height: 2rem; }
    .mv-chip:hover { background: var(--surface-hover); }
    .mv-chip.on { background: var(--text-main); color: var(--card-bg); border-color: var(--text-main); }
    .mv-chip:focus-visible, .mv-click:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mv-filtro { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .mv-filtro b { color: var(--text-main); }
    .mv-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--sp-2); }
    .mv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--sp-3); align-items: start; }
    .mv-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-3); min-width: 0; overflow-x: auto; }
    .mv-h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-body); font-weight: 800; }
    .mv-click { cursor: pointer; }
    .mv-mini { display: block; font-size: var(--fs-xs); color: var(--text-muted); font-weight: 500; }
    .mv-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .mv-nw { white-space: nowrap; }
    .mv-nm { color: var(--text-muted); font-style: italic; }
    .mv-flag { color: var(--warn-fg); font-weight: 700; }
    .mv-ok { color: var(--ok-fg); font-weight: 700; }
    .mv-mute { color: var(--text-muted); }
    .mv-pend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
      background: var(--warn-soft-bg); color: var(--text-main); font-size: var(--fs-sm); }
    .mv-meta { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .mv-barra { width: 64px; height: 6px; border-radius: var(--r-pill); background: var(--surface-ground); border: 1px solid var(--border-color); overflow: hidden; }
    .mv-barra i { display: block; height: 100%; background: var(--ok-fg); }
    .mv-sub > td { background: var(--surface-ground); padding: 0 !important; }
    .mv-det { display: grid; gap: var(--sp-2); padding: var(--sp-3); border-left: 3px solid var(--action); min-width: 0; }
    .mv-det-h { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); }
    .mv-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mv-tw { overflow-x: auto; }
    .mv-tabla { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .mv-tabla th { text-align: left; font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); text-transform: uppercase; padding: var(--sp-2); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    .mv-tabla td { padding: var(--sp-2); border-bottom: 1px solid var(--border-color); vertical-align: top; }
    .mv-tabla th.comm-num, .mv-tabla td.comm-num { text-align: right; }
    .mv-ancho { width: 100%; min-width: 320px; }
    .mv-prods { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px var(--sp-3); max-width: 560px; font-size: var(--fs-xs); }
    .mv-prods > span { white-space: nowrap; }
    .mv-q { text-align: right; font-family: var(--font-mono); }
    .mv-pn { overflow: hidden; text-overflow: ellipsis; }
    .mv-sku { margin-left: var(--sp-1); font-family: var(--font-mono); color: var(--text-muted); }
    .mv-imp { text-align: right; font-family: var(--font-mono); color: var(--text-muted); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `],
})
export class ComercialMonitoreoVecinalComponent implements OnInit {
  private readonly api = inject(VecinalMonitorService);
  private readonly destroyRef = inject(DestroyRef);

  readonly hoy = todayMx();
  readonly hoyDate = new Date(`${this.hoy}T12:00:00`);
  readonly atajos: Array<{ key: AtajoPeriodo; label: string }> = [
    { key: 'hoy', label: 'Hoy' }, { key: 'ayer', label: 'Ayer' }, { key: 'semana', label: 'Esta semana' },
    { key: 'catorcena', label: 'Esta catorcena' }, { key: 'mes', label: 'Este mes' }, { key: 'mes_anterior', label: 'Mes anterior' },
    { key: 'ultimos_30', label: 'Últimos 30 días' },
  ];
  readonly modos: SegOption[] = [{ value: 'total', label: 'Total del periodo' }, { value: 'promedio', label: 'Promedio por día' }];

  sucursal: string | string[] | null = null;
  /** Señal y no campo: `rutasOpc` la lee en un computed (un campo plano lo dejaría congelado). */
  readonly ruta = signal<string | null>(null);
  rango: Date[] | null = null;
  readonly atajo = signal<AtajoPeriodo | null>('hoy');
  readonly periodoSel = signal<Periodo>(rangoDe('hoy', this.hoy));
  readonly vista = signal<Vista>('resumen');
  readonly modo = signal<Modo>('total');
  readonly cargadoEn = signal<Date | null>(null);

  readonly vend = signal<Carga<VecinalVendorsResponse>>({ cargando: false, error: null, data: null });
  readonly surt = signal<Carga<VecinalPickersResponse>>({ cargando: false, error: null, data: null });
  readonly caja = signal<Carga<VecinalCashiersResponse>>({ cargando: false, error: null, data: null });
  readonly detV = signal<Record<string, Carga<VecinalVendorDetail>>>({});
  readonly detS = signal<Record<string, Carga<{ data: VecinalPickerOrder[]; total: number; truncated: boolean }>>>({});
  readonly detC = signal<Record<string, Carga<{ data: VecinalCashierOrder[]; total: number; truncated: boolean }>>>({});
  readonly abiertos = signal<Record<string, boolean>>({});

  readonly periodo = computed(() => { const p = this.periodoSel(); return { ...p, days: diasConActividad(p.from, p.to) }; });
  readonly etiqueta = computed(() => etiquetaPeriodo(this.periodoSel()));
  readonly multiDia = computed(() => this.periodoSel().from !== this.periodoSel().to);
  readonly rutasOpc = computed(() => { const r = this.ruta(); return this.vend().data?.route_options ?? (r ? [r] : []); });
  readonly vistas = computed<SegOption[]>(() => [
    { value: 'resumen', label: 'Resumen' },
    { value: 'vendedores', label: 'Vendedores', count: this.vend().data?.rows.length },
    { value: 'surtidores', label: 'Surtidores', count: this.surt().data?.rows.length },
    { value: 'cajeras', label: 'Cajeras', count: this.caja().data?.rows.length },
  ] as SegOption[]);

  /**
   * El resumen del periodo. Lo cobrado en Kepler sólo se suma si TODOS los vendedores se pudieron
   * medir: con uno sin medir, la suma sería menor a la real, así que se declara «no medido».
   */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const vs = this.vend().data?.rows ?? [];
    const ss = this.surt().data?.rows ?? [];
    const cj = this.caja().data;
    const sinMedir = vs.some((v) => v.charged === null);
    const pend = cj?.pending.count ?? 0;
    return [
      { label: 'Vendedores', value: vs.length, format: 'number', sub: 'con ruta vecinal' },
      { label: 'Visitas', value: vs.reduce((a, v) => a + v.visits, 0), format: 'number', sub: `${vs.reduce((a, v) => a + v.with_order, 0)} con pedido` },
      { label: 'Levantado', value: vs.reduce((a, v) => a + v.ordered_total, 0), format: 'currency', sub: 'pedidos en la app' },
      sinMedir || !vs.length
        ? { label: 'Cobrado Kepler', value: '—', format: 'text', state: 'no_medido', stateNote: vs.find((v) => v.charged === null)?.charged_unmeasured_reason ?? 'Sin vendedores en el periodo.' }
        : { label: 'Cobrado Kepler', value: vs.reduce((a, v) => a + (v.charged ?? 0), 0), format: 'currency', sub: 'ticket de Kepler' },
      { label: 'Pedidos surtidos', value: ss.reduce((a, s) => a + s.finished, 0), format: 'number', sub: `${ss.reduce((a, s) => a + s.with_shortage, 0)} con faltante` },
      { label: 'Por revisar en caja', value: pend, format: 'number', tone: pend ? 'warn' : 'ok', sub: pend ? this.dinero(cj?.pending.should_charge) : 'todo revisado' },
    ];
  });

  ngOnInit(): void { this.recargar(); }

  private filtro(): FiltroMonitoreo {
    const p = this.periodoSel();
    return { from: p.from, to: p.to, warehouse: unCodigo(this.sucursal), route: this.ruta() };
  }

  recargar(): void {
    this.detV.set({}); this.detS.set({}); this.detC.set({}); this.abiertos.set({});
    this.cargarVendedores(); this.cargarSurtidores(); this.cargarCajeras();
  }

  elegirAtajo(a: AtajoPeriodo): void {
    this.atajo.set(a);
    this.rango = null;
    this.periodoSel.set(rangoDe(a, this.hoy));
    this.recargar();
  }
  elegirRango(): void {
    const [a, b] = this.rango ?? [];
    const p = rangoValido(a ? ymd(a) : null, b ? ymd(b) : null, this.hoy);
    if (!p) return;
    this.atajo.set(null);
    this.periodoSel.set(p);
    this.recargar();
  }

  cargarVendedores(): void {
    this.vend.update((c) => ({ ...c, cargando: true, error: null }));
    this.api.vendors(this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => { this.vend.set({ cargando: false, error: null, data }); this.cargadoEn.set(new Date()); },
      error: (e) => this.vend.set({ cargando: false, error: mensaje(e, 'No se pudo cargar a los vendedores.'), data: null }),
    });
  }
  cargarSurtidores(): void {
    this.surt.update((c) => ({ ...c, cargando: true, error: null }));
    this.api.pickers(this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => this.surt.set({ cargando: false, error: null, data }),
      error: (e) => this.surt.set({ cargando: false, error: mensaje(e, 'No se pudo cargar a los surtidores.'), data: null }),
    });
  }
  cargarCajeras(): void {
    this.caja.update((c) => ({ ...c, cargando: true, error: null }));
    this.api.cashiers(this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => this.caja.set({ cargando: false, error: null, data }),
      error: (e) => this.caja.set({ cargando: false, error: mensaje(e, 'No se pudo cargar a las cajeras.'), data: null }),
    });
  }

  /** Desde el resumen: ir a la pestaña de esa persona con su detalle abierto. */
  irA(v: Vista, userId: string): void {
    this.vista.set(v);
    if (!this.abiertos()[userId]) this.alternar(userId, v === 'vendedores' ? 'v' : v === 'surtidores' ? 's' : 'c');
  }

  alternar(userId: string, tipo: 'v' | 's' | 'c'): void {
    const abierto = !!this.abiertos()[userId];
    this.abiertos.update((m) => { const n = { ...m }; if (abierto) delete n[userId]; else n[userId] = true; return n; });
    if (abierto) return;
    if (tipo === 'v' && !this.detV()[userId]) this.cargarVendedor(userId);
    if (tipo === 's' && !this.detS()[userId]) this.cargarSurtidor(userId);
    if (tipo === 'c' && !this.detC()[userId]) this.cargarCajera(userId);
  }

  cargarVendedor(id: string): void {
    this.detV.update((m) => ({ ...m, [id]: { cargando: true, error: null, data: null } }));
    this.api.vendor(id, this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => this.detV.update((m) => ({ ...m, [id]: { cargando: false, error: null, data } })),
      error: (e) => this.detV.update((m) => ({ ...m, [id]: { cargando: false, error: mensaje(e, 'No se pudo cargar su día.'), data: null } })),
    });
  }
  cargarSurtidor(id: string): void {
    this.detS.update((m) => ({ ...m, [id]: { cargando: true, error: null, data: null } }));
    this.api.pickerOrders(id, this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => this.detS.update((m) => ({ ...m, [id]: { cargando: false, error: null, data } })),
      error: (e) => this.detS.update((m) => ({ ...m, [id]: { cargando: false, error: mensaje(e, 'No se pudieron cargar sus pedidos.'), data: null } })),
    });
  }
  cargarCajera(id: string): void {
    this.detC.update((m) => ({ ...m, [id]: { cargando: true, error: null, data: null } }));
    this.api.cashierOrders(id, this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => this.detC.update((m) => ({ ...m, [id]: { cargando: false, error: null, data } })),
      error: (e) => this.detC.update((m) => ({ ...m, [id]: { cargando: false, error: mensaje(e, 'No se pudieron cargar sus pedidos.'), data: null } })),
    });
  }

  // ───────── formato ─────────
  /** Un conteo: el total del periodo, o el promedio por día con un decimal. */
  cuenta(n: number | null | undefined): string {
    const v = Number(n) || 0;
    return this.modo() === 'promedio' && this.periodo().days > 1 ? (v / this.periodo().days).toFixed(1) : String(v);
  }
  dinero(n: number | null | undefined, conModo = false): string {
    const v = Number(n) || 0;
    return money(conModo && this.modo() === 'promedio' && this.periodo().days > 1 ? v / this.periodo().days : v);
  }
  minutos(n: number | null | undefined): string { return n == null ? '—' : `${n} min`; }
  horaDe(iso: string | null | undefined): string { return iso ? hora.format(new Date(iso)) : ''; }
  diaDe(v: string | null | undefined): string {
    if (!v) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
    return dia.format(d).replace('.', '');
  }
  min100(p: number | null): number { return Math.max(0, Math.min(100, Number(p) || 0)); }
  motivo(m: string | null): string { return m ? MOTIVO[m] ?? m : ''; }
  codigos(x: VecinalVendorVisit): string { return x.orders.length ? x.orders.map((o) => o.code).join(', ') : 'con venta'; }
  lineasVenta(x: VecinalVendorVisit) { return x.orders.flatMap((o) => o.lines); }
  totalDebio(xs: VecinalCashierOrder[]): number { return xs.reduce((a, o) => a + (Number(o.should_charge) || 0), 0); }
  notaSurtido(l: VecinalMonitorLine): string {
    if (l.substitute) return `→ ${l.substitute.quantity} ${l.substitute.unit} ${l.substitute.product_name}`;
    if (l.substitutes_for) return `en lugar de ${l.substitutes_for}`;
    if (l.picked < l.ordered) return `faltó ${+(l.ordered - l.picked).toFixed(3)}`;
    return '✓';
  }
  notaCaja(l: VecinalMonitorLine): string {
    if (l.final == null) return '';
    if (l.final > l.picked) return `completó ${+(l.final - l.picked).toFixed(3)}`;
    if (l.final < l.picked) return `quitó ${+(l.picked - l.final).toFixed(3)}`;
    return '✓';
  }
  estadoTxt(v: VecinalVendorRow): string {
    if (v.day_state === 'finalizada') return 'Terminó';
    if (v.day_state === 'en_ruta') return this.sinSenal(v) ? 'Sin señal' : 'En ruta';
    return 'Sin iniciar';
  }
  estadoSev(v: VecinalVendorRow): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (v.day_state === 'finalizada') return 'info';
    if (v.day_state === 'en_ruta') return this.sinSenal(v) ? 'warn' : 'success';
    return v.visits ? 'secondary' : 'danger';
  }
  /** En ruta hoy, y la app lleva más de 30 min sin mandar ubicación. */
  private sinSenal(v: VecinalVendorRow): boolean {
    if (this.periodoSel().to !== this.hoy || !v.gps_last_at) return false;
    return Date.now() - new Date(v.gps_last_at).getTime() > 30 * 60_000;
  }
  conUbicacion(d: VecinalVendorDetail): boolean { return d.visits.some((x) => x.latitude != null && x.longitude != null); }
  marcadores(d: VecinalVendorDetail): MapMarker[] {
    const color = (s: VecinalVendorVisit['status']) => (s === 'con_pedido' ? 'var(--ok-fg)' : s === 'abierta' ? 'var(--warn-fg)' : 'var(--text-muted)');
    // En el mapa van en orden de llegada (la tabla va de la más nueva a la más vieja).
    const orden = [...d.visits].filter((x) => x.latitude != null && x.longitude != null && x.visited_at).sort((a, b) => String(a.visited_at).localeCompare(String(b.visited_at)));
    return orden.map((x, i) => ({ lat: x.latitude as number, lng: x.longitude as number, seq: i + 1, color: color(x.status), title: `${x.customer_name ?? 'Cliente'} · ${this.horaDe(x.visited_at)}`, kind: 'pin' }));
  }
  camino(d: VecinalVendorDetail): { lat: number; lng: number }[] { return d.gps.points.map((p) => ({ lat: p.lat, lng: p.lng })); }
}

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function mensaje(e: unknown, def: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : m || def;
}
