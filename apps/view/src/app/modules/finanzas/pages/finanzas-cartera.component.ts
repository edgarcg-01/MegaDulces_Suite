import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { CarteraService, CarteraResp, CarteraCliente, CarteraDetalle, CarteraFiltros, CarteraResumen, CarteraTendencia, AgingBucket, Partida, BusquedaProducto, CuentaKind } from '../cartera.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { CarteraSegmentsComponent } from '../cartera-segments.component';

/**
 * CXC (ADR-048) — Cartera de clientes / Partidas vivas (Cuentas por Cobrar).
 * Reproduce el `Reporte de partidas vivas` de Kepler: quién debe, cuánto, desde
 * cuándo (aging), por sucursal/cliente/vendedor. Read-only sobre Kepler (kdue).
 * Answer-first Operations: KPIs de saldo/vencido + aging arriba, tabla densa de
 * clientes ordenada por saldo, drill al auxiliar (partidas vivas) por cliente.
 */
@Component({
  selector: 'app-finanzas-cartera',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CarteraSegmentsComponent, CommonModule, FormsModule, RouterModule, ButtonModule, SelectModule, InputTextModule, DialogModule, DatePickerModule, ToggleSwitchModule, MetricStripComponent, FreshnessPillComponent],
  template: `
    <div class="surf-page in">
      <!-- La barra de Finanzas FALTABA acá: esta pantalla era la única del proyecto sin
           ella, así que desde Cartera no había cómo volver al resto sin el sidebar. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Crédito de clientes</h1>
          <p class="surf-page-sub">Partidas vivas de Cuentas por Cobrar: quién debe, cuánto y desde cuándo. Estado de cuenta read-only de Kepler; el saldo es factura menos cobros y notas.</p>
        </div>
        <div class="ct-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="abrirBuscador()">
            <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span>
            <span class="p-button-label">Buscar por producto</span>
          </button>
          <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="!showResumen()" (click)="toggleResumen()"><span class="p-button-icon p-button-icon-left pi pi-chart-bar" aria-hidden="true"></span><span class="p-button-label">Resumen</span></button>
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="!data()?.clientes?.length" (click)="exportCsv()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">CSV</span></button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <!-- Selector del submódulo: Cartera (lo que te deben) ↔ Cobranza (lo que te pagaron).
           Va acá, pegado a la cabecera, y NO junto a los filtros: navega entre dos vistas,
           no recorta la que estás viendo (D.1). -->
      <app-cartera-segments />

      <div class="ct-filters">
        <!-- [CXC.25] A quién le cobrás. Va PRIMERO porque es el filtro que más cambia lo que ves:
             46% del saldo son ocho cuentas entre plazas propias, no clientes. -->
        <p-select [options]="cuentaOpts()" [(ngModel)]="cuenta" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Tipo de cuenta" styleClass="ct-sel" ariaLabel="Tipo de cuenta" />
        <p-select [options]="sucursalOpts()" [(ngModel)]="sucursal" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Sucursal" styleClass="ct-sel" ariaLabel="Sucursal" />
        <p-select [options]="grupoOpts()" [(ngModel)]="grupo" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Grupo" [showClear]="true" styleClass="ct-sel" ariaLabel="Grupo" />
        <p-select [options]="zonaOpts()" [(ngModel)]="zona" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Zona" [showClear]="true" styleClass="ct-sel" ariaLabel="Zona" />
        <!-- El filtro por vendedor existía en la API desde CXC y no tenía control: la pantalla
             pedía sus 61 códigos en cada carga y los tiraba. -->
        <p-select [options]="vendedorOpts()" [(ngModel)]="vendedor" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Vendedor" [showClear]="true" [filter]="true" styleClass="ct-sel ct-sel-vend" ariaLabel="Vendedor" />
        <span class="p-input-icon-left ct-search">
          <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Cliente, código o RFC…" aria-label="Buscar cliente" />
        </span>
        <p-select [options]="sortOpts" [(ngModel)]="sort" (onChange)="load()" optionLabel="label" optionValue="value" ariaLabel="Ordenar por" styleClass="ct-sel" />
        <label class="ct-toggle"><p-toggleswitch [(ngModel)]="incluirSaldados" (onChange)="load()" /> <span>Incluir saldados</span></label>
        <!-- [CXC.20] Antes decía «saldos al {{ '{{' }} hoy }}» con la fecha del reloj de Postgres.
             Ahora la píldora mide el DATO: la edad de los carriles del ODS que traen kdue/kdm5 y
             los catálogos. ADR-056 — no poder medir se declara, no se pinta como fresco. -->
        @if (data(); as d) {
          <app-freshness-pill measures="data" [freshness]="d.freshness" [since]="d.freshness.data_as_of" label="Datos del ERP" />
        }
      </div>

      @if (data(); as d) {
        @if (d.freshness.stale) {
          <div class="ct-stale" role="status">
            <i class="pi pi-clock" aria-hidden="true"></i>
            @if (d.freshness.status === 'unknown') {
              <span>No se pudo medir qué tan viejo es este dato. No quiere decir que esté al día.</span>
            } @else {
              <span>Los saldos vienen del ERP con <b>{{ d.freshness.age_human }}</b> de rezago.</span>
            }
            <span class="muted">{{ staleDetalle(d) }}</span>
          </div>
        }
      }

      @if (error()) { <div class="ct-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo cargar la cartera. {{ error() }}</div> }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de cartera" />

        <!-- [CXC.25] El total, REPARTIDO por a quién le cobrás. No es una decoración: sin esta
             tira, «$57.78M de cartera» se lee como $57.78M de clientes, y 46% son plazas
             propias. Las tres barras suman el KPI de arriba, exacto. -->
        @if (kpiPorTipo(d).length > 1) {
          <section class="ct-tipos" aria-label="Cartera por tipo de cuenta">
            @for (t of kpiPorTipo(d); track t.key) {
              <button type="button" class="ct-tipo" [class.on]="cuenta === t.key"
                      [attr.aria-pressed]="cuenta === t.key"
                      [title]="'Filtrar por ' + t.label + ' (' + t.clientes + ' cuentas)'"
                      (click)="filtrarTipo(t.key)">
                <span class="ct-tipo-h">{{ t.label }} <span class="muted">{{ t.pct }}%</span></span>
                <span class="ct-tipo-n">{{ money(t.saldo) }}</span>
                <span class="ct-tipo-sub muted">{{ t.clientes }} cuentas · {{ money(t.vencido) }} vencido</span>
                <span class="ct-tipo-bar"><span [class]="'ct-tipo-fill ct-tipo-' + t.key" [style.width.%]="t.pct"></span></span>
              </button>
            }
          </section>
        }

        @if (showResumen() && resumen(); as rs) {
          <section class="card-premium card-flat ct-resumen">
            <h3 class="ct-card-title"><i class="pi pi-chart-bar" aria-hidden="true"></i> Resumen gerencial <span class="muted">lo que el reporte de Kepler no da</span></h3>
            <div class="ct-rs-kpis">
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ rs.dso ?? '—' }}</span><span class="ct-rs-lbl">DSO (días cartera)</span></div>
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ rs.pct_vencido }}%</span><span class="ct-rs-lbl">del saldo vencido</span></div>
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ rs.concentracion.top10_pct }}%</span><span class="ct-rs-lbl">en top-10 clientes</span></div>
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ money(rs.ventas_90d) }}</span><span class="ct-rs-lbl">ventas 90d (base DSO)</span></div>
              @if (rs.pago; as pg) {
                <div class="ct-rs-kpi"><span class="ct-rs-num">{{ pg.mediana }}d</span><span class="ct-rs-lbl">mediana real de pago ({{ pg.n | number }} facturas)</span></div>
                <div class="ct-rs-kpi"><span class="ct-rs-num">{{ pg.tarde_30d | number }}</span><span class="ct-rs-lbl">pagos a más de 30 días</span></div>
              }
            </div>
            <div class="ct-rs-proy">
              <h4 class="ct-rs-h4">Proyección de cobranza <span class="muted">cuánto debería entrar y cuándo</span></h4>
              <div class="ct-proy-row">
                <div class="ct-proy-cell ct-proy-venc"><span class="ct-proy-num">{{ money(rs.proyeccion.vencido) }}</span><span class="ct-proy-lbl">Vencido (cobrar ya)</span></div>
                <div class="ct-proy-cell"><span class="ct-proy-num">{{ money(rs.proyeccion.d0_7) }}</span><span class="ct-proy-lbl">Vence ≤ 7 días</span></div>
                <div class="ct-proy-cell"><span class="ct-proy-num">{{ money(rs.proyeccion.d8_15) }}</span><span class="ct-proy-lbl">8–15 días</span></div>
                <div class="ct-proy-cell"><span class="ct-proy-num">{{ money(rs.proyeccion.d16_30) }}</span><span class="ct-proy-lbl">16–30 días</span></div>
                <div class="ct-proy-cell"><span class="ct-proy-num">{{ money(rs.proyeccion.d30_plus) }}</span><span class="ct-proy-lbl">> 30 días</span></div>
              </div>
            </div>

            @if (tendencia().length > 1) {
              <div class="ct-rs-trend">
                <h4 class="ct-rs-h4">Tendencia de cartera <span class="muted">saldo · vencido</span></h4>
                <div class="ct-trend-bars">
                  @for (t of tendencia(); track t.fecha) {
                    <div class="ct-trend-col" [title]="t.fecha + ': ' + money(t.saldo_total) + ' (' + money(t.vencido_total) + ' vencido)'">
                      <div class="ct-trend-bar" [style.height.%]="trendPct(t.saldo_total)"><div class="ct-trend-venc" [style.height.%]="t.saldo_total > 0 ? (t.vencido_total / t.saldo_total) * 100 : 0"></div></div>
                    </div>
                  }
                </div>
              </div>
            } @else if (showResumen() && tendenciaCargada()) {
              <!-- [CXC.20] Decía «aparecerá al acumular días», que suena a que el proceso va
                   caminando. Medido en prod el 2026-09-24: había UNA sola foto, del 23-sep, y el
                   latido del job estaba en error desde el 22. Un empty-state que tranquiliza
                   sobre algo roto es peor que no tenerlo. -->
              <p class="ct-rs-trend-empty muted">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                @if (tendencia().length === 1) {
                  La tendencia necesita al menos dos fotos diarias y sólo hay una ({{ tendencia()[0].fecha }}).
                  Si mañana sigue igual, el trabajo de la foto diaria no está corriendo.
                } @else {
                  Todavía no hay ninguna foto diaria de cartera: sin eso no hay tendencia que mostrar.
                }
              </p>
            }

            <div class="ct-rs-grid">
              <div>
                <h4 class="ct-rs-h4">Cartera por vendedor</h4>
                <!-- [CXC.20] Con NOMBRE, y la fila es (sucursal, código). Antes listaba «1», «2»,
                     «10001»: el join a kduv existía en el ODS y nadie lo hacía. Y agrupar por el
                     código pelado habría fundido dos carteras — 11 de 81 códigos nombran a
                     personas distintas según la plaza. -->
                <table class="ct-rs-table"><thead><tr><th>Vendedor</th><th>Suc</th><th class="ta-r">Clientes</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th></tr></thead>
                  <tbody>@for (v of rs.por_vendedor.slice(0, 10); track v.sucursal + '|' + v.vendedor) {
                    <tr>
                      <td>{{ v.vendedor_nombre || v.vendedor }} @if (v.vendedor_nombre) { <span class="muted ct-mono">{{ v.vendedor }}</span> }</td>
                      <td>{{ v.sucursal }}</td>
                      <td class="ta-r">{{ v.n_clientes }}</td>
                      <td class="ta-r" [class.ct-venc-num]="v.vencido > 0">{{ v.vencido | number:'1.0-0' }}</td>
                      <td class="ta-r"><b>{{ v.saldo | number:'1.0-0' }}</b></td>
                    </tr>
                  }</tbody></table>
              </div>
              <div>
                <h4 class="ct-rs-h4">Cartera por zona</h4>
                <table class="ct-rs-table"><thead><tr><th>Zona</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th></tr></thead>
                  <tbody>@for (z of rs.por_zona; track z.zona) {
                    <tr><td>{{ z.zona }}</td><td class="ta-r" [class.ct-venc-num]="z.vencido > 0">{{ z.vencido | number:'1.0-0' }}</td><td class="ta-r"><b>{{ z.saldo | number:'1.0-0' }}</b></td></tr>
                  }</tbody></table>
              </div>
            </div>
            @if (rs.sin_documento.monto > 0.005) {
              <!-- Los dos rollups de arriba reparten POR DOCUMENTO, así que suman menos que el
                   KPI. Decirlo es la diferencia entre una cifra con alcance y una que no cuadra. -->
              <p class="ct-rs-nota muted">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Vendedor y zona reparten <b>{{ money(rs.saldo_total - rs.sin_documento.monto) }}</b>: los
                <b>{{ money(rs.sin_documento.monto) }}</b> de {{ rs.sin_documento.clientes }} clientes sin documento
                que los explique no se pueden atribuir a nadie.
              </p>
            }
          </section>
        }

        <section class="card-premium card-flat ct-aging">
          <h3 class="ct-card-title"><i class="pi pi-hourglass" aria-hidden="true"></i> Antigüedad de saldos</h3>
          <!-- [CXC.20] La barra suma EXACTAMENTE el KPI de arriba. Antes sumaba el desglose por
               documento ($57.01M) mientras el KPI mostraba el saldo de Kepler ($57.78M), y la
               etiqueta accesible afirmaba que la barra valía el KPI. El hueco ahora es un
               segmento con nombre: ADR-056, lo que no se puede repartir se declara. -->
          <div class="ct-aging-bar" role="img" [attr.aria-label]="'Antigüedad de ' + money(d.kpi.total_saldo)">
            @for (b of agingSegs(d.kpi); track b.key) {
              @if (b.val > 0) { <span class="ct-seg" [class]="'ct-seg-' + b.key" [style.flex]="b.val" [title]="b.label + ': ' + money(b.val)"></span> }
            }
          </div>
          <ul class="ct-aging-legend">
            @for (b of agingSegs(d.kpi); track b.key) {
              <li [class.ct-leg-nodoc]="b.key === 'sin_documento'">
                <span class="ct-dot" [class]="'ct-seg-' + b.key"></span>{{ b.label }} <b>{{ money(b.val) }}</b>
                @if (b.key === 'sin_documento') {
                  <i class="pi pi-info-circle" aria-hidden="true"
                     [title]="d.kpi.sin_documento.clientes + ' clientes en los que Kepler aplicó cobros por encima de lo que la cuenta justifica: el saldo total es correcto, el desglose por factura se queda corto y por eso no tiene antigüedad.'"></i>
                }
              </li>
            }
          </ul>
        </section>

        <section class="card-premium card-flat ct-tablewrap">
          <table class="ct-table">
            <thead>
              <tr>
                <th>Cliente</th><th>Suc</th><th>Zona</th><th>Vend</th><th class="ta-r">Partidas</th>
                <!-- La columna existe sólo cuando hay más de un tipo a la vista: filtrada a
                     «Cliente» repetiría la misma palabra 1,186 veces. -->
                <th class="ta-r">Paga a</th>
                <th class="ta-r">Línea</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th><th><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              @for (c of d.clientes; track c.sucursal + c.cliente_code) {
                <tr (click)="openDetalle(c)" class="ct-row" [class.ct-row-venc]="c.vencido > 0">
                  <td>
                    <b>{{ c.cliente_nombre }}</b> <span class="muted">{{ c.cliente_code }}</span>
                    @if (!cuenta && c.cuenta_kind !== 'cliente_final') {
                      <span class="ct-kind" [class]="'ct-kind-' + c.cuenta_kind"
                            [title]="kindTitle(c)">{{ kindLabel(c.cuenta_kind) }}</span>
                    }
                  </td>
                  <td>{{ c.sucursal }}</td>
                  <td>{{ c.zona || '—' }}</td>
                  <td [title]="c.vendedor || ''">{{ c.vendedor_nombre || c.vendedor || '—' }}</td>
                  <td class="ta-r">{{ c.n_partidas }}</td>
                  <td class="ta-r">
                    @if (c.dias_pago_prom != null) {
                      <span [class.ct-lento]="c.dias_pago_prom > 30" [title]="c.n_pagos + ' facturas ya pagadas'">{{ c.dias_pago_prom }}d</span>
                    } @else { <span class="muted">—</span> }
                  </td>
                  <td class="ta-r">
                    @if (c.uso_linea != null) { <span [class.ct-sobre]="c.sobre_linea" [title]="'Límite ' + money(c.limite_credito || 0)">{{ c.uso_linea }}%</span> } @else { <span class="muted">—</span> }
                    @if (c.sobre_linea) { <i class="pi pi-exclamation-triangle ct-sobre" title="Sobre su línea de crédito" aria-hidden="true"></i> }
                  </td>
                  <td class="ta-r" [class.ct-venc-num]="c.vencido > 0">{{ c.vencido | number:'1.2-2' }}</td>
                  <td class="ta-r"><b>{{ c.saldo | number:'1.2-2' }}</b></td>
                  <td class="ta-r"><i class="pi pi-angle-right muted" aria-hidden="true"></i></td>
                </tr>
              } @empty {
                <tr><td colspan="10" class="ct-empty">Sin cartera para el filtro. Ajustá sucursal o búsqueda.</td></tr>
              }
            </tbody>
          </table>
          @if (d.total_clientes > d.clientes.length) {
            <p class="ct-more muted">Mostrando {{ d.clientes.length }} de {{ d.total_clientes }} clientes. Afiná el filtro para ver el resto.</p>
          }
        </section>
      }
    </div>

    <p-dialog [visible]="detalleOpen()" (visibleChange)="!$event && closeDetalle()" [modal]="true" [dismissableMask]="true" [style]="{ width: '820px', maxWidth: '96vw' }" [header]="detalle()?.cliente?.cliente_nombre || detalleRef()?.nombre || 'Auxiliar del cliente'">
      @if (detalleLoading()) {
        <div class="ct-det-state"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando el auxiliar…</div>
      } @else if (detalleError(); as err) {
        <div class="ct-det-state ct-det-err">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>No se pudo cargar el auxiliar del cliente. {{ err }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" label="Reintentar" (click)="retryDetalle()"></button>
        </div>
      }
      @if (detalle(); as det) {
        <div class="ct-det-head">
          <div>
            <span class="muted">Código</span> {{ det.cliente.cliente_code }} · <span class="muted">Suc</span> {{ det.cliente.sucursal }} @if (det.cliente.rfc) { · <span class="muted">RFC</span> {{ det.cliente.rfc }} }
            @if (det.cliente.vendedor) { · <span class="muted">Vendedor</span> {{ det.cliente.vendedor_nombre || det.cliente.vendedor }} }
            @if (det.cliente.limite_credito) { · <span class="muted">Límite</span> {{ money(det.cliente.limite_credito) }} @if (det.saldo > det.cliente.limite_credito) { <span class="ct-sobre">(sobre línea)</span> } }
            @if (det.cliente.dias_credito) { · <span class="muted">{{ det.cliente.dias_credito }}d crédito</span> }
          </div>
          <div class="ct-det-saldos">
            <span>Saldo <b>{{ money(det.saldo) }}</b></span>
            @if (det.vencido > 0) { <span class="ct-venc-num">Vencido <b>{{ money(det.vencido) }}</b></span> }
            @if (det.saldo_a_favor > 0) { <span class="ct-favor">A favor <b>{{ money(det.saldo_a_favor) }}</b></span> }
            @if (det.dias_pago_prom != null) { <span class="muted" [title]="det.n_pagos + ' facturas pagadas'">paga a <b>{{ det.dias_pago_prom }}d</b></span> }
            @if (det.pagadas > 0) {
              <button type="button" class="ct-link-btn" (click)="verSaldadas.set(!verSaldadas())"
                      [attr.aria-pressed]="verSaldadas()"
                      [title]="'Facturas ya cobradas por ' + money(det.importe_pagado)">
                <i class="pi" [class.pi-eye]="!verSaldadas()" [class.pi-eye-slash]="verSaldadas()" aria-hidden="true"></i>
                {{ verSaldadas() ? 'Ocultar' : 'Ver' }} {{ det.pagadas }} pagadas
              </button>
            }
          </div>
          @if (det.cliente.telefono) {
            <div class="ct-det-contact">
              <a [href]="'tel:' + det.cliente.telefono" class="ct-contact-btn"><i class="pi pi-phone" aria-hidden="true"></i> {{ det.cliente.telefono }}</a>
              <a [href]="waLink(det)" target="_blank" rel="noopener" class="ct-contact-btn ct-wa"><i class="pi pi-whatsapp" aria-hidden="true"></i> Recordar por WhatsApp</a>
            </div>
          }
        </div>
        <table class="ct-det-table">
          <thead><tr><th>Documento</th><th>Folio</th><th>Fecha</th><th>Vence</th><th class="ta-r">Importe</th><th class="ta-r">Saldo</th><th>Estado</th><th><span class="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            @for (p of partidasVisibles(); track p.folio_digital) {
              <tr [class.ct-row-venc]="p.vencida" [class.ct-row-pagada]="p.saldada">
                <td>{{ p.doc_label }}</td>
                <td class="ct-mono">{{ p.folio_digital }}</td>
                <td>{{ p.fecha }}</td>
                <td>{{ p.vencimiento || '—' }}</td>
                <td class="ta-r">{{ p.importe | number:'1.2-2' }}</td>
                <td class="ta-r"><b>{{ p.saldo_documento | number:'1.2-2' }}</b></td>
                <td>
                  @if (p.saldada) { <span class="ct-tag-pag">Pagada{{ p.pagada_el ? ' ' + p.pagada_el : '' }}</span> }
                  @else if (p.vencida) { <span class="ct-tag-venc">{{ p.dias_vencido }}d</span> }
                  @else { <span class="muted">al día</span> }
                </td>
                <td class="ta-r">
                  @if (docAbrible(p)) {
                    <a pButton class="p-button-text p-button-xs"
                       [routerLink]="multitarea.enlaceDetalle(['/comercial/documentos'])" [target]="multitarea.target()" [queryParams]="{ doc: p.folio_digital }"
                       (click)="$event.stopPropagation()"
                       [title]="'Abrir el documento ' + p.folio_digital">
                      <i class="pi pi-external-link" aria-hidden="true"></i><span class="sr-only">Abrir documento</span>
                    </a>
                  } @else if (sinDetalle(p)) {
                    <i class="pi pi-minus muted ct-nodoc" title="Traspaso/venta agregada: su único renglón es contable, no tiene desglose de producto" aria-hidden="true"></i>
                  }
                </td>
              </tr>
              @for (a of p.aplicaciones; track a.folio) {
                <tr class="ct-app"><td class="ct-app-cell" colspan="8"><i class="pi pi-arrow-turn-down-right" aria-hidden="true"></i> {{ a.label }} {{ a.folio }} · {{ a.fecha || '—' }} <b>−{{ a.monto | number:'1.2-2' }}</b></td></tr>
              }
            } @empty {
              <tr><td colspan="8" class="ct-empty">
                @if (det.pagadas > 0 && !verSaldadas()) { Sin partidas vivas — todo cobrado. Sus {{ det.pagadas }} facturas pagadas están arriba, en «Ver pagadas». }
                @else { Sin partidas para este cliente. }
              </td></tr>
            }
          </tbody>
        </table>
        @if (det.cobranza; as cc) {
          <div class="ct-360">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <span><b>{{ cc.n }}</b> cobros registrados ({{ money(cc.monto) }})@if (cc.ultimo) { · último {{ cc.ultimo }} }</span>
            <span class="ct-360-ev">· <b>{{ cc.con_ficha }}</b> con ficha · <b>{{ cc.validados }}</b> validados en banco</span>
            <a routerLink="/finanzas/cobranza" class="ct-360-link">Ver cobranza <i class="pi pi-arrow-right" aria-hidden="true"></i></a>
          </div>
        }
        <div class="ct-promesas">
          <div class="ct-prom-head">
            <h4 class="ct-rs-h4"><i class="pi pi-handshake" aria-hidden="true"></i> Compromisos de pago</h4>
          </div>
          @for (p of det.compromisos; track p.id) {
            <div class="ct-prom-row" [class.ct-prom-inc]="p.estado === 'incumplida'">
              <span class="ct-prom-monto">{{ money(p.monto_prometido) }}</span>
              <span>para el <b>{{ p.fecha_promesa }}</b></span>
              @if (p.estado === 'incumplida') { <span class="ct-sobre">incumplida</span> }
              @if (p.nota) { <span class="muted ct-prom-nota">· {{ p.nota }}</span> }
              <span class="ct-prom-btns">
                <button pButton type="button" class="p-button-xs p-button-text p-button-success" (click)="resolvePromise(p.id, 'cumplida')" title="Cumplida"><i class="pi pi-check" aria-hidden="true"></i></button>
                <button pButton type="button" class="p-button-xs p-button-text p-button-danger" (click)="resolvePromise(p.id, 'cancelada')" title="Cancelar"><i class="pi pi-times" aria-hidden="true"></i></button>
              </span>
            </div>
          } @empty { <p class="muted ct-prom-empty">Sin compromisos abiertos.</p> }
          <div class="ct-prom-form">
            <input pInputText type="number" [(ngModel)]="promMonto" placeholder="Monto" class="ct-prom-in" aria-label="Monto prometido" />
            <p-datepicker [(ngModel)]="promFecha" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" placeholder="Fecha" styleClass="ct-prom-dp" ariaLabel="Fecha de promesa" />
            <input pInputText type="text" [(ngModel)]="promNota" placeholder="Nota (opcional)" class="ct-prom-in ct-prom-nota-in" aria-label="Nota" />
            <button pButton type="button" class="p-button-sm" label="Registrar" [disabled]="!promMonto || !promFecha || savingProm()" (click)="savePromise(det)"></button>
          </div>
        </div>
        @if (det.abonos.length) {
          <details class="ct-abonos"><summary>{{ det.abonos.length }} cobros / notas aplicados</summary>
            <ul>@for (a of det.abonos; track a.folio) { <li>{{ a.doc_label }} {{ a.folio }} · {{ a.fecha }} <b>{{ money(a.importe) }}</b></li> }</ul>
          </details>
        }
        @if (det.sin_documento !== 0) {
          <p class="ct-det-note ct-sin-doc">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            {{ money(det.sin_documento) }} del saldo no lo explica ningún documento: Kepler aplicó cobros
            por encima de lo que la cuenta justifica. El total de arriba es el de Kepler; el desglose se queda corto.
          </p>
        }
        <p class="ct-det-note muted">El saldo del cliente sale de <b>kdue</b> (cargos − abonos), que es la cifra que cuadra con Kepler. El reparto por documento usa las aplicaciones de <b>kdm5</b>; lo que no logran ubicar se aplica a las partidas más viejas primero. Espejo read-only del ERP.</p>
      }
    </p-dialog>

    <!-- [CXC.SKU.1] Buscador por producto. Diálogo y no una vista aparte: es una
         herramienta DENTRO de cartera ("quién compró o devolvió esto"), no otra
         pantalla. El selector de arriba sigue eligiendo entre Cartera y Cobranza. -->
    <p-dialog [visible]="buscadorAbierto()" (visibleChange)="buscadorAbierto.set($event)"
              [modal]="true" [style]="{ width: '62rem', maxWidth: '96vw' }"
              header="Buscar por producto">
      <div class="ct-bp-bar">
        <input pInputText type="text" [(ngModel)]="bpTexto" (keyup.enter)="buscarProducto()"
               placeholder="SKU o parte de la descripción…" aria-label="SKU o descripción" />
        <button pButton type="button" class="p-button-sm" [loading]="bpCargando()"
                [disabled]="bpTexto.trim().length < 2" (click)="buscarProducto()">
          <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span>
          <span class="p-button-label">Buscar</span>
        </button>
      </div>

      @if (bpError()) { <div class="ct-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ bpError() }}</div> }

      @if (bpRes(); as res) {
        <p class="ct-bp-resumen">
          <b>{{ res.renglones.length }}</b> renglones en <b>{{ bpDocs(res) }}</b> documentos ·
          {{ bpCargos(res) }} en facturas ·
          <b class="ct-bp-abono">{{ bpAbonos(res) }} en notas de crédito o devoluciones</b>
          @if (res.skus.length > 1) { <span class="muted"> · {{ res.skus.length }} SKU coincidieron</span> }
        </p>
        @if (res.truncado) {
          <p class="ct-bp-nota"><i class="pi pi-info-circle" aria-hidden="true"></i> Se muestran los primeros {{ res.renglones.length }}: <b>hay más</b>. Afiná el texto.</p>
        }
        <!-- La cobertura se DECLARA. Un vacío sin esta línea se lee como "no se vendió". -->
        <p class="ct-bp-nota ct-bp-excluye">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          No incluye {{ res.excluye.doctypes.join(', ') }} — {{ res.excluye.motivo }}
        </p>

        @if (res.renglones.length) {
          <div class="ct-bp-scroll">
            <table class="surf-table surf-table--plain surf-table--sticky">
              <thead>
                <tr>
                  <th scope="col">Documento</th>
                  <th scope="col">Fecha</th>
                  <th scope="col">Suc.</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Descripción</th>
                  <th scope="col" class="comm-num">Cantidad</th>
                  <th scope="col" class="comm-num">Importe</th>
                </tr>
              </thead>
              <tbody>
                @for (r of res.renglones; track r.folio_digital + '-' + r.linea) {
                  <tr [class.ct-bp-r-abono]="r.naturaleza === 'abono'">
                    <td class="mono">{{ r.folio_digital }}</td>
                    <td>{{ r.fecha || '—' }}</td>
                    <td>{{ r.sucursal }}</td>
                    <td>
                      @if (r.naturaleza === 'abono') { <span class="ct-bp-tag">Nota / devolución</span> }
                      @else { <span class="muted">Factura</span> }
                    </td>
                    <td class="mono">{{ r.sku }}</td>
                    <td>{{ r.descripcion || '—' }}</td>
                    <td class="comm-num">{{ r.cantidad }} <span class="muted">{{ r.unidad }}</span></td>
                    <td class="comm-num">{{ money(r.importe) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (!bpCargando()) {
          <p class="ct-bp-nota">Sin documentos con ese producto en el universo de arriba.</p>
        }
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ct-bp-bar { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .ct-bp-bar input { flex: 1 1 auto; }
    .ct-bp-resumen { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .ct-bp-abono { color: var(--bad-fg); }
    .ct-bp-nota { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-faint); }
    .ct-bp-excluye { color: var(--warn-fg); }
    .ct-bp-scroll { max-height: 26rem; overflow: auto; }
    .ct-bp-tag { font-size: var(--fs-micro); font-weight: 600; color: var(--bad-fg); }
    tr.ct-bp-r-abono td { background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .ct-filters { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: .75rem 0 1rem; }
    .ct-search input { min-width: 240px; }
    .ct-toggle { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; }
    .ct-hoy { margin-left: auto; font-size: .8rem; }
    .ct-filters app-freshness-pill { margin-left: auto; }
    .ct-sel-vend { min-width: 230px; }
    /* [CXC.20] Aviso de rezago del dato: tono de advertencia, no de error — el número sirve,
       sólo que es de hace N. Lo rojo es para lo que no se puede usar. */
    .ct-stale { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .82rem;
      color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--warn-fg) 24%, transparent);
      border-radius: var(--r-md, 8px); padding: .5rem .75rem; margin: 0 0 1rem; }
    /* [CXC.25] El total repartido. Botones y no tarjetas: cada uno filtra. */
    .ct-tipos { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .6rem; margin: 0 0 1rem; }
    .ct-tipo { display: flex; flex-direction: column; gap: .15rem; text-align: left; cursor: pointer;
      background: var(--surface-1, #fff); border: 1px solid var(--border, #e5e2dc);
      border-radius: var(--r-md, 8px); padding: .6rem .75rem; font: inherit; color: inherit; }
    .ct-tipo:hover { border-color: var(--action, #c2410c); }
    .ct-tipo.on { border-color: var(--action, #c2410c); box-shadow: inset 0 0 0 1px var(--action, #c2410c); }
    .ct-tipo-h { font-size: .74rem; text-transform: uppercase; letter-spacing: .03em; }
    .ct-tipo-n { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ct-tipo-sub { font-size: .7rem; }
    .ct-tipo-bar { display: block; height: 4px; border-radius: 2px; background: var(--surface-2, #f0efec); margin-top: .35rem; overflow: hidden; }
    .ct-tipo-fill { display: block; height: 100%; }
    .ct-tipo-cliente_final { background: #6b8f71; }
    .ct-tipo-interno { background: #7c6f9f; }
    .ct-tipo-ruta { background: #c9a227; }
    /* La etiqueta en la fila: sólo aparece cuando NO es un cliente, que es la excepción. */
    .ct-kind { display: inline-block; margin-left: .4rem; font-size: .65rem; padding: .05rem .35rem;
      border-radius: var(--r-pill, 999px); border: 1px solid currentColor; cursor: help; white-space: nowrap; }
    .ct-kind-interno { color: #7c6f9f; }
    .ct-kind-ruta { color: #9a7b10; }
    .ct-error { color: var(--danger, #b42318); display: flex; gap: .5rem; align-items: center; padding: .75rem 0; }
    .ct-card-title { display: flex; align-items: center; gap: .5rem; font-size: .95rem; margin: 0 0 .6rem; }
    .ct-aging { padding: 1rem; margin-bottom: 1rem; }
    .ct-aging-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--surface-2, #f0efec); }
    .ct-seg { display: block; }
    .ct-seg-por_vencer { background: #6b8f71; } .ct-seg-d0_30 { background: #c9a227; }
    .ct-seg-d31_60 { background: #d98324; } .ct-seg-d61_90 { background: #c2410c; } .ct-seg-d90_plus { background: #b42318; }
    /* El hueco no es un tramo de antigüedad: va rayado, para que se lea como "esto no tiene
       fecha" y no como un quinto nivel de morosidad. */
    .ct-seg-sin_documento { background: repeating-linear-gradient(45deg,
      var(--text-faint, #8a8579) 0 4px, transparent 4px 8px); }
    .ct-leg-nodoc { color: var(--text-faint); }
    .ct-leg-nodoc .pi-info-circle { font-size: .72rem; cursor: help; }
    .ct-aging-legend { list-style: none; display: flex; flex-wrap: wrap; gap: 1rem; margin: .7rem 0 0; padding: 0; font-size: .82rem; }
    .ct-aging-legend li { display: flex; align-items: center; gap: .35rem; }
    .ct-aging-legend b { margin-left: .2rem; }
    .ct-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .ct-tablewrap { padding: 0; overflow-x: auto; }
    .ct-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    .ct-table th, .ct-table td { padding: .5rem .7rem; text-align: left; border-bottom: 1px solid var(--surface-border, #e7e5e0); white-space: nowrap; }
    .ct-table th { font-weight: 600; color: var(--text-2, #6b6b6b); position: sticky; top: 0; background: var(--surface-0, #fff); }
    .ct-row { cursor: pointer; } .ct-row:hover { background: var(--surface-hover, #faf9f7); }
    .ct-row-venc { background: rgba(180,35,24,.04); }
    .ct-venc-num { color: #b42318; }
    .ta-r { text-align: right !important; }
    .muted { color: var(--text-2, #8a8a8a); font-weight: 400; }
    .ct-empty { text-align: center; color: var(--text-2, #8a8a8a); padding: 1.5rem !important; }
    .ct-more { padding: .6rem .7rem; margin: 0; font-size: .8rem; }
    .ct-det-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; font-size: .85rem; margin-bottom: .8rem; }
    .ct-det-saldos { display: flex; gap: 1rem; }
    .ct-det-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .ct-det-table th, .ct-det-table td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid var(--surface-border, #eee); white-space: nowrap; }
    .ct-det-table th { color: var(--text-2, #6b6b6b); font-weight: 600; }
    .ct-mono { font-family: ui-monospace, monospace; font-size: .78rem; }
    .ct-tag-venc { background: rgba(180,35,24,.1); color: #b42318; border-radius: 4px; padding: .1rem .4rem; font-size: var(--fs-xs); font-weight: 600; }
    .ct-app td { border-bottom: none; padding-top: .1rem; padding-bottom: .1rem; }
    .ct-app-cell { padding-left: 1.6rem !important; font-size: .78rem; color: #6b8f71; }
    .ct-app-cell i { font-size: .7rem; opacity: .6; }
    .ct-app-cell b { color: var(--text-2, #6b6b6b); }
    .ct-abonos { margin-top: .8rem; font-size: .82rem; } .ct-abonos ul { margin: .4rem 0 0; padding-left: 1.1rem; }
    .ct-det-note { font-size: .78rem; margin-top: .8rem; }
    .ct-head-actions { display: flex; gap: .5rem; }
    .ct-sobre { color: #b42318; font-weight: 600; }
    .ct-resumen { padding: 1rem; margin-bottom: 1rem; }
    .ct-rs-kpis { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: .3rem 0 1rem; }
    .ct-rs-kpi { display: flex; flex-direction: column; }
    .ct-rs-num { font-size: 1.4rem; font-weight: 700; line-height: 1.1; }
    .ct-rs-lbl { font-size: .76rem; color: var(--text-2, #8a8a8a); }
    .ct-rs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 45rem) { .ct-rs-grid { grid-template-columns: 1fr; } }
    .ct-rs-h4 { font-size: .82rem; margin: 0 0 .4rem; color: var(--text-2, #6b6b6b); }
    .ct-rs-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .ct-rs-table th, .ct-rs-table td { padding: .3rem .5rem; border-bottom: 1px solid var(--surface-border, #eee); text-align: left; }
    .ct-rs-table th { color: var(--text-2, #8a8a8a); font-weight: 600; }
    .ct-det-contact { display: flex; gap: .6rem; flex-basis: 100%; margin-top: .5rem; }
    .ct-contact-btn { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; text-decoration: none; padding: .3rem .7rem; border-radius: 6px; border: 1px solid var(--surface-border, #ddd); color: inherit; }
    .ct-contact-btn:hover { background: var(--surface-hover, #faf9f7); }
    .ct-wa { color: #128c7e; border-color: rgba(18,140,126,.3); }
    .ct-360 { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: .9rem; padding: .5rem .7rem; border-radius: 6px; background: rgba(107,143,113,.08); font-size: .82rem; }
    .ct-360 > i { color: #6b8f71; }
    .ct-360-ev { color: var(--text-2, #6b6b6b); }
    .ct-360-link { margin-left: auto; text-decoration: none; color: var(--action, #c2410c); font-size: .8rem; white-space: nowrap; }
    .ct-rs-proy { margin-bottom: 1rem; }
    .ct-proy-row { display: flex; flex-wrap: wrap; gap: .5rem; }
    .ct-proy-cell { flex: 1; min-width: 120px; padding: .5rem .7rem; border-radius: 6px; background: var(--surface-2, #f6f5f2); display: flex; flex-direction: column; }
    .ct-proy-venc { background: rgba(180,35,24,.08); }
    .ct-proy-num { font-weight: 700; font-size: 1rem; }
    .ct-proy-lbl { font-size: .74rem; color: var(--text-2, #8a8a8a); }
    .ct-rs-trend { margin-bottom: 1rem; }
    .ct-trend-bars { display: flex; align-items: flex-end; gap: 2px; height: 60px; }
    .ct-trend-col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
    .ct-trend-bar { width: 100%; background: #6b8f71; border-radius: 2px 2px 0 0; position: relative; min-height: 2px; display: flex; align-items: flex-end; }
    .ct-trend-venc { width: 100%; background: #b42318; border-radius: 2px 2px 0 0; }
    .ct-rs-trend-empty { font-size: .78rem; margin: .2rem 0 1rem; display: flex; gap: .4rem; align-items: baseline; }
    .ct-rs-nota { font-size: .78rem; margin: .6rem 0 0; display: flex; gap: .4rem; align-items: baseline; }
    .ct-promesas { margin-top: .9rem; padding: .7rem; border: 1px solid var(--surface-border, #e7e5e0); border-radius: 8px; }
    .ct-prom-head { display: flex; align-items: center; }
    .ct-prom-head .ct-rs-h4 { margin: 0; display: flex; align-items: center; gap: .4rem; }
    .ct-prom-row { display: flex; align-items: center; gap: .5rem; font-size: .82rem; padding: .3rem 0; border-bottom: 1px dashed var(--surface-border, #eee); }
    .ct-prom-inc { background: rgba(180,35,24,.05); }
    .ct-prom-monto { font-weight: 700; }
    .ct-prom-nota { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ct-prom-btns { margin-left: auto; display: flex; gap: .2rem; }
    .ct-prom-empty { font-size: .8rem; margin: .3rem 0; }
    .ct-prom-form { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .6rem; align-items: center; }
    .ct-prom-in { width: 110px; } .ct-prom-nota-in { flex: 1; min-width: 140px; width: auto; }
    .ct-det-state { display: flex; align-items: center; gap: .6rem; padding: 1.2rem .2rem; font-size: .85rem; color: var(--text-2, #6b6b6b); }
    .ct-det-err { color: var(--danger, #b42318); }
    .ct-row-pagada td { opacity: .6; }
    .ct-tag-pag { background: rgba(107,143,113,.14); color: #4f6b54; border-radius: 4px; padding: .1rem .4rem; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; }
    .ct-link-btn { background: none; border: 0; padding: 0; font: inherit; font-size: .82rem; color: var(--action, #c2410c); cursor: pointer; display: inline-flex; align-items: center; gap: .3rem; }
    .ct-link-btn:hover { text-decoration: underline; }
    .ct-nodoc { font-size: .7rem; opacity: .45; }
    .ct-lento { color: #c2410c; font-weight: 600; }
    .ct-favor { color: #4f6b54; }
    .ct-sin-doc { display: flex; align-items: flex-start; gap: .4rem; color: #8a6d1f; background: rgba(201,162,39,.08); padding: .5rem .7rem; border-radius: 6px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  `],
})
export class FinanzasCarteraComponent implements OnInit {
  /** `[MT.3]` Con la preferencia prendida, el detalle abre en otra ventana. */
  readonly multitarea = inject(MultitareaService);

  // ── `[CXC.SKU.1]` Buscador por producto ─────────────────────────────────────
  readonly buscadorAbierto = signal(false);
  readonly bpCargando = signal(false);
  readonly bpError = signal<string | null>(null);
  readonly bpRes = signal<BusquedaProducto | null>(null);
  bpTexto = '';

  abrirBuscador(): void { this.buscadorAbierto.set(true); }

  buscarProducto(): void {
    const q = this.bpTexto.trim();
    if (q.length < 2) return;
    this.bpCargando.set(true);
    this.bpError.set(null);
    this.svc.buscarProducto(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.bpRes.set(r); this.bpCargando.set(false); },
      error: (e) => {
        this.bpCargando.set(false);
        this.bpError.set(e?.error?.message || 'No se pudo buscar el producto.');
      },
    });
  }

  /** Documentos DISTINTOS: un producto puede repetirse en varios renglones del mismo. */
  bpDocs(r: BusquedaProducto): number { return new Set(r.renglones.map((x) => x.folio_digital)).size; }
  bpCargos(r: BusquedaProducto): number { return r.renglones.filter((x) => x.naturaleza === 'cargo').length; }
  bpAbonos(r: BusquedaProducto): number { return r.renglones.filter((x) => x.naturaleza === 'abono').length; }
  private readonly svc = inject(CarteraService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<CarteraResp | null>(null);
  readonly detalle = signal<CarteraDetalle | null>(null);
  /** Estado del drill: el diálogo abre al click y dice si carga o si falló (antes callaba). */
  readonly detalleOpen = signal(false);
  readonly detalleLoading = signal(false);
  readonly detalleError = signal<string | null>(null);
  readonly detalleRef = signal<{ sucursal: string; cliente: string; nombre: string } | null>(null);
  /** Las saldadas viven en el payload; el default sigue siendo "partidas vivas". */
  readonly verSaldadas = signal(false);
  readonly partidasVisibles = computed(() => {
    const p = this.detalle()?.partidas || [];
    return this.verSaldadas() ? p : p.filter((x) => !x.saldada);
  });

  /**
   * ⭐ `[CXC.20]` Abre en **Todas**, no en la `01`.
   *
   * El default era `'01'`, así que la pantalla abría mostrando **$6.41M de $57.78M — el 11%** de
   * la cartera, con su propio % de vencido (77.6% contra el 89.7% de la red). Quien entra a
   * «Crédito de clientes» a ver cuánto le deben, veía una novena parte y ningún aviso.
   */
  sucursal: string | null = null;
  grupo: string | null = null;
  zona: string | null = null;
  vendedor: string | null = null;
  /**
   * ⭐ `[CXC.25]` Arranca en **«Todas»**, igual que la sucursal — y por el mismo motivo.
   *
   * La tentación era abrir filtrado en «Cliente», porque de los $57,780,190.86 que la pantalla
   * publica **$26,583,657.82 (46.0%) son ocho cuentas entre plazas propias** (`30-73 TLMKT
   * Morelia Abastos`, `10-00 P.V. Padre Hidalgo Piso`…) que nadie va a cobrar por teléfono.
   * Pero eso sería repetir el bug que `[CXC.20.3]` acaba de arreglar: **abrir escondiendo
   * dinero**. La pantalla muestra el total completo y lo REPARTE a la vista; filtrar es un clic.
   */
  cuenta: string | null = null;
  search = '';
  incluirSaldados = false;
  sort: 'saldo' | 'vencido' = 'saldo';
  readonly sortOpts = [{ label: 'Mayor saldo', value: 'saldo' }, { label: 'Más vencido (cobrar)', value: 'vencido' }];
  readonly tendencia = signal<CarteraTendencia[]>([]);
  readonly tendenciaCargada = signal(false);
  promMonto: number | null = null;
  promFecha: Date | null = null;
  promNota = '';
  readonly savingProm = signal(false);

  readonly filtros = signal<CarteraFiltros | null>(null);
  readonly grupoOpts = computed(() => (this.filtros()?.grupos || []).map((g) => ({ label: g, value: g })));
  readonly zonaOpts = computed(() => (this.filtros()?.zonas || []).map((z) => ({ label: z, value: z })));
  readonly vendedorOpts = computed(() =>
    (this.filtros()?.vendedores || []).map((v) => ({ label: v.label, value: v.code })));
  readonly cuentaOpts = computed(() => [
    { label: 'Todas las cuentas', value: null as string | null },
    ...(this.filtros()?.cuentas || []).map((k) => ({ label: k.label, value: k.code as string | null })),
  ]);
  /** El resumen gerencial YA viene en la respuesta de la tabla: es el mismo cálculo. */
  readonly resumen = computed<CarteraResumen | null>(() => this.data()?.resumen ?? null);
  readonly showResumen = signal(false);

  /**
   * ⭐ `[CXC.20]` **Las sucursales salen del servidor, no de una lista de acá.**
   *
   * Acá vivía un arreglo escrito a mano con seis (`01`..`06`). No era que el dato faltara:
   * `filtros()` ya devolvía las nueve y el componente tiraba esa respuesta. Medido en prod el
   * 2026-09-24, esa copia dejaba **$45.4M (78.5% de la cartera) sin ninguna forma de filtrarla**:
   * la `00` con $44.4M y 95.8% vencido, la `07` y la `08`.
   *
   * Ahora la lista es el dato: las sucursales que la cartera tiene, con el nombre de
   * `commercial.warehouses`. Una plaza nueva aparece sola y una sin cartera no ofrece un filtro
   * que devuelve vacío.
   */
  readonly sucursalOpts = computed(() => [
    { label: 'Todas', value: null as string | null },
    ...(this.filtros()?.sucursales || []).map((s) => ({ label: s.label, value: s.code as string | null })),
  ]);

  /**
   * `[CXC.26]` **Enlace profundo a un cliente**: `?suc=00&cliente=C1011` deja la pantalla filtrada
   * a ese código y abre su auxiliar.
   *
   * Lo estrena el drill de «Por día» (`/finanzas/cartera/dia`), que lista quién debe cada día y
   * tiene que poder mandarte al estado de cuenta completo. Sin esto el enlace existía y no hacía
   * nada: la pantalla ignoraba por completo los query params, así que un `?q=` se veía como un
   * enlace que funciona y aterrizaba en la lista sin filtrar.
   *
   * ⚠️ Se lee del `snapshot`, no de un `subscribe`: navegar a la misma ruta con otros params no
   * vuelve a construir el componente, pero **ningún** enlace de la app hace eso hoy — y suscribirse
   * acá reabriría el diálogo cada vez que otra cosa toque la URL. Si algún día hace falta, va con
   * su propio motivo.
   */
  ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    const cliente = qp.get('cliente'); const suc = qp.get('suc');
    if (cliente) this.search = cliente;
    this.load();
    if (cliente && suc) {
      this.detalleRef.set({ sucursal: suc, cliente, nombre: qp.get('nombre') || cliente });
      this.detalleOpen.set(true);
      this.fetchDetalle(suc, cliente);
    }
  }

  load() {
    this.loading.set(true); this.error.set(null);
    // `[CXC.20]` UNA llamada: tabla + KPIs + resumen + opciones de filtro. Eran tres, y cada una
    // reconstruía la misma pirámide de CTEs (6.0 s + 11.3 s + 3.7 s medidos en prod).
    this.svc.cartera({
      sucursal: this.sucursal || undefined,
      grupo: this.grupo || undefined,
      zona: this.zona || undefined,
      vendedor: this.vendedor || undefined,
      cuenta: this.cuenta || undefined,
      search: this.search.trim() || undefined,
      incluir_saldados: this.incluirSaldados ? '1' : undefined,
      sort: this.sort,
    }).subscribe({
      next: (d) => { this.data.set(d); this.filtros.set(d.filtros); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'error'); this.loading.set(false); },
    });
    if (this.showResumen()) this.loadTendencia();
  }

  toggleResumen() {
    const next = !this.showResumen();
    this.showResumen.set(next);
    // El resumen ya está en `data()`; lo único que falta pedir es la tendencia, que sale de otra
    // tabla (los snapshots diarios) y no de la pirámide.
    if (next && !this.tendenciaCargada()) this.loadTendencia();
  }
  private loadTendencia() {
    this.svc.tendencia({ sucursal: this.sucursal || undefined, dias: 90 })
      .subscribe({
        next: (t) => { this.tendencia.set(t); this.tendenciaCargada.set(true); },
        error: () => { this.tendencia.set([]); this.tendenciaCargada.set(true); },
      });
  }

  trendPct(saldo: number): number {
    const max = Math.max(...this.tendencia().map((t) => t.saldo_total), 1);
    return Math.round((saldo / max) * 100);
  }

  /** Exporta la cartera visible a CSV (el navegador lo descarga). */
  exportCsv() {
    const rows = this.data()?.clientes || [];
    if (!rows.length) return;
    const head = ['Sucursal', 'Codigo', 'Cliente', 'RFC', 'Grupo', 'Zona', 'Vendedor', 'Vendedor_nombre', 'Telefono', 'Limite', 'Uso_%', 'Sobre_linea', 'Partidas', 'Dias_pago_prom', 'Vencido', 'Saldo', 'Sin_documento', 'Saldo_a_favor'];
    const esc = (v: any) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = rows.map((c) => [c.sucursal, c.cliente_code, c.cliente_nombre, c.rfc, c.grupo, c.zona, c.vendedor, c.vendedor_nombre, c.telefono, c.limite_credito, c.uso_linea, c.sobre_linea ? 'SI' : '', c.n_partidas, c.dias_pago_prom, c.vencido, c.saldo, c.sin_documento || '', c.saldo_a_favor || ''].map(esc).join(','));
    const csv = '﻿' + [head.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cartera_${this.sucursal || 'todas'}_${this.data()?.hoy || 'hoy'}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  /** Recordatorio de pago prellenado por WhatsApp (el operador lo revisa antes de enviar). */
  waLink(det: CarteraDetalle): string {
    const tel = (det.cliente.telefono || '').replace(/\D/g, '');
    const num = tel.length === 10 ? `52${tel}` : tel;
    const msg = `Hola ${det.cliente.cliente_nombre}, le recordamos su saldo pendiente con Mega Dulces de ${this.money(det.saldo)}` +
      (det.vencido > 0 ? ` (${this.money(det.vencido)} vencido)` : '') + '. ¡Gracias!';
    return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  }

  openDetalle(c: CarteraCliente) {
    this.detalleRef.set({ sucursal: c.sucursal, cliente: c.cliente_code, nombre: c.cliente_nombre });
    this.detalleOpen.set(true);
    this.fetchDetalle(c.sucursal, c.cliente_code);
  }
  closeDetalle() {
    this.detalleOpen.set(false); this.detalle.set(null);
    this.detalleError.set(null); this.detalleLoading.set(false); this.detalleRef.set(null);
    this.verSaldadas.set(false);
  }

  /**
   * El documento de venta desglosado vive en `/comercial/documentos` (Fase AX, vistas en vivo
   * sobre kepler_ods). Sólo existe para UD08 (Factura Telemarketing) y UD12 (Venta a crédito):
   * verificado en prod, 2,410/2,410 partidas de esos dos tipos resuelven. UD13 NO está —su
   * único renglón es contable ("VENTAS AL 0 %"), no hay producto que desglosar.
   */
  private readonly puedeVerDocs = computed(() =>
    this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.COMMERCIAL_SALES_DOCS_VER] === true);

  docAbrible(p: Partida): boolean {
    return this.puedeVerDocs() && /^UD(08|12)/.test(p.doc_code || '');
  }
  sinDetalle(p: Partida): boolean { return /^UD13/.test(p.doc_code || ''); }
  // El documento se abre con un <a routerLink> en la celda: asi acepta Ctrl+clic
  // y "Abrir en pestana nueva", que es justo lo que hace falta para cotejar la
  // cartera contra el documento sin perder la lista (ADR-078).
  retryDetalle() {
    const ref = this.detalleRef();
    if (ref) this.fetchDetalle(ref.sucursal, ref.cliente);
  }

  private fetchDetalle(sucursal: string, cliente: string) {
    this.detalle.set(null); this.detalleError.set(null); this.detalleLoading.set(true);
    this.svc.detalle(sucursal, cliente).subscribe({
      next: (d) => { this.detalle.set(d); this.detalleLoading.set(false); },
      error: (e) => { this.detalleError.set(e?.error?.message || e?.message || 'error'); this.detalleLoading.set(false); },
    });
  }

  private reloadDetalle(sucursal: string, cliente: string) { this.fetchDetalle(sucursal, cliente); }

  savePromise(det: CarteraDetalle) {
    if (!this.promMonto || !this.promFecha) return;
    const f = this.promFecha;
    const fecha = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    this.savingProm.set(true);
    this.svc.createPromise(det.cliente.sucursal, det.cliente.cliente_code, { monto: this.promMonto, fecha, nota: this.promNota.trim() || undefined })
      .subscribe({
        next: () => { this.promMonto = null; this.promFecha = null; this.promNota = ''; this.savingProm.set(false); this.reloadDetalle(det.cliente.sucursal, det.cliente.cliente_code); },
        error: () => this.savingProm.set(false),
      });
  }

  resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada') {
    const det = this.detalle();
    this.svc.resolvePromise(id, estado).subscribe({ next: () => { if (det) this.reloadDetalle(det.cliente.sucursal, det.cliente.cliente_code); } });
  }

  money(v: number) { return (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' }); }

  kpiItems(d: CarteraResp): MetricStripItem[] {
    return [
      { label: 'Saldo total', value: this.money(d.kpi.total_saldo) },
      { label: 'Vencido', value: this.money(d.kpi.total_vencido), tone: d.kpi.total_vencido > 0 ? 'warn' : undefined },
      { label: 'Clientes con saldo', value: String(d.kpi.n_clientes) },
      { label: 'Sobre su línea', value: String(d.kpi.n_sobre_linea), tone: d.kpi.n_sobre_linea > 0 ? 'bad' : undefined },
      { label: 'Partidas vivas', value: String(d.kpi.n_partidas) },
      ...(d.kpi.total_a_favor > 0
        ? [{ label: `A favor (${d.kpi.n_a_favor})`, value: this.money(d.kpi.total_a_favor) } as MetricStripItem]
        : []),
    ];
  }

  /**
   * `[CXC.20]` Los cinco tramos **más el hueco**, para que los segmentos sumen el KPI. Si el hueco
   * no se dibuja, la barra vale $771 mil menos que el número que tiene arriba y nada lo dice.
   */
  agingSegs(k: CarteraResp['kpi']) {
    const a: AgingBucket = k.aging;
    const segs = [
      { key: 'por_vencer', label: 'Por vencer', val: a.por_vencer },
      { key: 'd0_30', label: '1–30 días', val: a.d0_30 },
      { key: 'd31_60', label: '31–60 días', val: a.d31_60 },
      { key: 'd61_90', label: '61–90 días', val: a.d61_90 },
      { key: 'd90_plus', label: '90+ días', val: a.d90_plus },
    ];
    if (k.sin_documento.monto > 0.005) {
      segs.push({ key: 'sin_documento', label: 'Sin documento', val: k.sin_documento.monto });
    }
    return segs;
  }

  /**
   * `[CXC.25]` El total repartido por tipo de cuenta. Sólo se pintan los tipos que existen en lo
   * que estás viendo — y `@if (length > 1)` en el template evita la tira de una sola barra al
   * 100%, que no informa nada.
   */
  kpiPorTipo(d: CarteraResp) {
    const t = d.kpi.por_tipo;
    const total = d.kpi.total_saldo || 1;
    return (['cliente_final', 'interno', 'ruta'] as CuentaKind[])
      .map((key) => ({
        key,
        label: this.kindLabel(key),
        saldo: t[key].saldo, vencido: t[key].vencido, clientes: t[key].clientes,
        pct: Math.round((t[key].saldo / total) * 1000) / 10,
      }))
      .filter((x) => x.clientes > 0);
  }

  kindLabel(k: CuentaKind): string {
    return ({ cliente_final: 'Cliente', interno: 'Cuenta interna', ruta: 'Ruta' } as Record<CuentaKind, string>)[k] || k;
  }

  /**
   * Qué señal decidió el tipo. Va en el tooltip porque un veredicto sin su fuente es una
   * afirmación sin respaldo (ADR-059) — y acá el respaldo cambia: `interno` lo dice el código
   * de la cuenta, y hay 3 rutas que sólo el NOMBRE de Kepler delató.
   */
  kindTitle(c: CarteraCliente): string {
    const por = ({ codigo: 'por el código de la cuenta', nombre: 'por el nombre en Kepler', ninguno: 'por descarte (ninguna señal lo afirmó)' } as Record<string, string>)[c.cuenta_kind_source] || c.cuenta_kind_source;
    return `${this.kindLabel(c.cuenta_kind)} — ${por}. No es un cliente al que se le cobre por teléfono.`;
  }

  filtrarTipo(k: CuentaKind) {
    this.cuenta = this.cuenta === k ? null : k;
    this.load();
  }

  /** Qué eslabón de la ingesta está viejo, por nombre: «hay rezago» no es accionable. */
  staleDetalle(d: CarteraResp): string {
    const malos = (d.freshness.inputs || []).filter((i) => i.status !== 'fresh');
    if (!malos.length) return '';
    return malos.map((i) => `${i.label}: ${i.age_human ?? 'sin señal'}`).join(' · ');
  }
}
