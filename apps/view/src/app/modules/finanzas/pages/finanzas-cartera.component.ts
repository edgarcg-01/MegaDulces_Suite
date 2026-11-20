import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
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
import { Subscription } from 'rxjs';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { esRestoDeFactura } from '@megadulces/contracts';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';

/** `[CXC.43]` Fecha en México (AAAA-MM-DD) de un instante ISO: «hoy» es el día de la sucursal. */
const diaMx = (iso: string | Date): string =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
/** Días de calendario (en México) entre el contacto y hoy. */
const diasDesde = (iso: string): number =>
  Math.round((Date.parse(diaMx(new Date())) - Date.parse(diaMx(iso))) / 86_400_000);
const horaMx = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' });
const fechaMx = (iso: string): string =>
  new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short' });

/** Minúsculas y sin acentos: «Peña» se encuentra escribiendo «pena». */
const normalizar = (s: string | null | undefined): string =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
import { CarteraService, CarteraResp, CarteraCliente, CarteraDetalle, TelefonosCuenta, CarteraFiltros, CarteraQuery, CanalContacto, CarteraResumen, CarteraTendencia, AgingBucket, Partida, BusquedaProducto, CuentaKind } from '../cartera.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { CarteraSegmentsComponent } from '../cartera-segments.component';
import { mensajeEstadoCuenta, mensajeVendedor, pdfPublicoDelEnlace, type PeriodoMensaje } from '../estado-cuenta-mensaje';
import { MESES_ESTADO_CUENTA_POR_DEFECTO, PERIODOS_ESTADO_CUENTA, dateFromDelPeriodo, pagadaEnPeriodo, type PeriodoEstadoCuenta } from '@megadulces/contracts';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarPdf } from '../../../shared/util/abrir-pdf';
import { mensajeDeErrorBlob } from '../../../core/http/blob-error';

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
  imports: [RouterLink, CarteraSegmentsComponent, CommonModule, FormsModule, RouterModule, ButtonModule, SelectModule, InputTextModule, DialogModule, DatePickerModule, ToggleSwitchModule, MetricStripComponent, FreshnessPillComponent, LoadStateComponent, SucursalPipe],
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
          <!-- [CXC.41] El CSV trae TODAS las cuentas de lo que ves (filtro + búsqueda), no las 500
               que pinta la tabla: antes bajaba 500 de 1,455 sin decirlo. Ya están en memoria. -->
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="!filtradas().length" (click)="exportCsv()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">CSV</span></button>
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
        <!-- [CXC.42] Búsqueda y orden INSTANTÁNEOS: se resuelven sobre las cuentas ya cargadas,
             sin Enter y sin volver a pedir. Medido el 2026-11-17: cobranza recargaba la lista 3.7
             veces por cada ficha que abría, a 4.3 s cada una. -->
        <span class="p-input-icon-left ct-search">
          <input pInputText type="search" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                 enterkeyhint="search" autocomplete="off"
                 placeholder="Buscar cliente, código o RFC" aria-label="Buscar cliente, código o RFC" />
        </span>
        <p-select [options]="sortOpts" [ngModel]="orden()" (ngModelChange)="orden.set($event)" optionLabel="label" optionValue="value" ariaLabel="Ordenar por" styleClass="ct-sel" />
        <label class="ct-toggle"><p-toggleswitch [(ngModel)]="incluirSaldados" (onChange)="load()" /> <span>Incluir saldados</span></label>
        <!-- [CXC.42] Un filtro que se está aplicando SE VE: antes la tabla vieja se quedaba igual
             ~4 s y sólo giraba el botón «Actualizar». -->
        @if (loading() && data()) {
          <span class="ct-actualizando" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Actualizando…</span>
        }
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

      @if (csvAviso(); as av) {
        <p class="ct-csv-aviso" [class.ct-pdf-err]="av.error" role="status"><i class="pi" [class.pi-info-circle]="!av.error" [class.pi-exclamation-triangle]="av.error" aria-hidden="true"></i> {{ av.texto }}</p>
      }

      @if (error() && data()) { <div class="ct-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo actualizar la cartera: lo que ves es la carga anterior. {{ error() }}</div> }

      <!-- [CXC.42] La primera carga reserva su lugar con un esqueleto del alto de lo que viene:
           antes la pantalla brincaba al llegar los datos (CLS medido: 74 de 93 sesiones fuera de
           «bueno», varias en 0.47–0.53). Un error sin datos previos sale con «Reintentar». -->
      <app-load-state [loading]="!data() && !error()" [error]="data() ? null : error()" [skeletonRows]="14"
                      errorTitle="No se pudo cargar la cartera" (retry)="load()">
      @if (data(); as d) {
        <div class="ct-cuerpo" [class.ct-cargando]="loading()" [attr.aria-busy]="loading()">
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de cartera" />

        <!-- [CXC.25] El total, REPARTIDO por a quién le cobrás. No es una decoración: sin esta
             tira, «$57.78M de cartera» se lee como $57.78M de clientes, y 46% son plazas
             propias.
             [CXC.41] La tira sale del universo SIN el filtro de tipo: la pantalla abre en
             «Cliente» (lo que cobranza trabaja) y la tira sigue mostrando el total completo,
             con el tipo elegido marcado. Así abrir filtrado ya no esconde dinero. -->
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
                <span class="ct-tipo-bar"><span class="ct-tipo-fill" [style.width.%]="t.pct"></span></span>
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
                      <td>{{ v.sucursal | sucursal }}</td>
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
          <!-- [CXC.41] El tope se dice ARRIBA. Al pie de 500 filas nadie lo veía.
               [CXC.42] Ya llegan todas las cuentas del filtro; la tabla pinta hasta 500 para no
               cargar el navegador, y la búsqueda alcanza a las demás al instante. -->
          @if (busqueda().trim()) {
            <p class="ct-more ct-more-top" role="status">
              <i class="pi pi-search" aria-hidden="true"></i>
              <b>{{ filtradas().length | number }}</b> {{ filtradas().length === 1 ? 'cuenta coincide' : 'cuentas coinciden' }} con «{{ busqueda().trim() }}».
              <span class="muted">Los totales de arriba son del filtro; la búsqueda sólo ubica cuentas.</span>
            </p>
          }
          @if (filtradas().length > visibles().length) {
            <p class="ct-more ct-more-top" role="status">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Se ven las primeras <b>{{ visibles().length | number }}</b> de <b>{{ filtradas().length | number }}</b> cuentas
              ({{ orden() === 'vencido' ? 'las de más vencido' : 'las de mayor saldo' }}). Escribe en la búsqueda para ubicar las demás, o baja el CSV, que trae todas.
            </p>
          }
          @if (d.total_clientes > d.clientes.length) {
            <p class="ct-more ct-more-top ct-more-corte" role="status">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              El servidor mandó <b>{{ d.clientes.length | number }}</b> de <b>{{ d.total_clientes | number }}</b> cuentas: la búsqueda y el CSV no alcanzan a las demás. Afina el filtro.
            </p>
          }
          <table class="ct-table">
            <thead>
              <tr>
                <th>Cliente</th><th>Suc</th><th>Zona</th><th>Vend</th><th class="ta-r">Partidas</th>
                <th class="ta-r">Paga a</th>
                <th class="ta-r">Línea</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th><th><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              @for (c of visibles(); track c.sucursal + c.cliente_code) {
                <!-- [CXC.41] La fila se abre también con teclado (Tab + Enter o Espacio): antes
                     sólo con mouse, y ningún cliente era alcanzable sin él. -->
                <tr (click)="openDetalle(c)" (keydown.enter)="openDetalle(c)"
                    (keydown.space)="$event.preventDefault(); openDetalle(c)" tabindex="0"
                    class="ct-row" [class.ct-row-venc]="c.vencido > 0 && !c.solo_resto_vencido">
                  <td>
                    <b>{{ c.cliente_nombre }}</b> <span class="muted">{{ c.cliente_code }}</span>
                    <!-- [CXC.43] A quién ya se le habló: al retomar la lista se sabe dónde ibas. -->
                    @if (contactoCorto(c); as cc) {
                      <span class="ct-contactado" [class.ct-contactado-hoy]="cc.hoy">
                        <i class="pi pi-check" aria-hidden="true"></i> {{ cc.texto }}
                      </span>
                    }
                    <!-- La etiqueta de tipo sale sólo con «Todas las cuentas» y sólo en lo que NO
                         es cliente: filtrada a «Cliente» repetiría la misma palabra en cada fila. -->
                    @if (!cuenta && c.cuenta_kind !== 'cliente_final') {
                      <span class="ct-kind" [class]="'ct-kind-' + c.cuenta_kind"
                            [title]="kindTitle(c)">{{ kindLabel(c.cuenta_kind) }}</span>
                    }
                  </td>
                  <td>{{ c.sucursal | sucursal }}</td>
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
                  <!-- [GP.R.1] Todo su vencido son centavos de facturas ya cobradas: no es cobranza. -->
                  @if (c.solo_resto_vencido) {
                    <td class="ta-r"><span class="ct-tag-redondeo" [title]="tituloRedondeo">Redondeo</span> <span class="muted">{{ c.vencido | number:'1.2-2' }}</span></td>
                  } @else {
                    <td class="ta-r" [class.ct-venc-num]="c.vencido > 0">{{ c.vencido | number:'1.2-2' }}</td>
                  }
                  <td class="ta-r"><b>{{ c.saldo | number:'1.2-2' }}</b></td>
                  <td class="ta-r"><i class="pi pi-angle-right muted" aria-hidden="true"></i></td>
                </tr>
              } @empty {
                <tr><td colspan="10" class="ct-empty">
                  @if (busqueda().trim()) { Ninguna cuenta del filtro coincide con «{{ busqueda().trim() }}». Revisa el texto o cambia el filtro de arriba. }
                  @else { Sin cartera para el filtro. Ajusta tipo de cuenta o sucursal. }
                </td></tr>
              }
            </tbody>
          </table>
          @if (filtradas().length > visibles().length) {
            <p class="ct-more muted">Fin de la lista: {{ visibles().length | number }} de {{ filtradas().length | number }} cuentas. Escribe en la búsqueda para ubicar las demás, o baja el CSV.</p>
          }
        </section>
        </div>
      }
      </app-load-state>
    </div>

    <p-dialog [visible]="detalleOpen()" (visibleChange)="!$event && closeDetalle()" [modal]="true" [dismissableMask]="true" [style]="{ width: '820px', maxWidth: '96vw' }" [header]="detalle()?.cliente?.cliente_nombre || detalleRef()?.nombre || 'Auxiliar del cliente'">
      <!-- [CXC.42] Se trabaja la lista de arriba abajo sin cerrar la ficha. La siguiente ya viene
           pedida por adelantado mientras lees ésta, así que abre sin la espera de ~3.3 s. -->
      @if (posicion(); as pos) {
        <nav class="ct-det-nav" aria-label="Recorrer la lista">
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="pos.i === 0" (click)="irA(-1)">
            <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Anterior</span>
          </button>
          <span class="ct-det-pos muted">{{ pos.i + 1 | number }} de {{ pos.n | number }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="pos.i >= pos.n - 1" (click)="irA(1)">
            <span class="p-button-label">Siguiente cliente</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span>
          </button>
        </nav>
      }
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
            <span class="muted">Código</span> {{ det.cliente.cliente_code }} · <span class="muted">Suc</span> {{ det.cliente.sucursal | sucursal }} @if (det.cliente.rfc) { · <span class="muted">RFC</span> {{ det.cliente.rfc }} }
            @if (det.cliente.vendedor) { · <span class="muted">Vendedor</span> {{ det.cliente.vendedor_nombre || det.cliente.vendedor }} }
            @if (det.cliente.limite_credito) { · <span class="muted">Límite</span> {{ money(det.cliente.limite_credito) }} @if (det.saldo > det.cliente.limite_credito) { <span class="ct-sobre">(sobre línea)</span> } }
            @if (det.cliente.dias_credito) { · <span class="muted">{{ det.cliente.dias_credito }}d crédito</span> }
          </div>
          <div class="ct-det-saldos">
            <span>Saldo <b>{{ money(det.saldo) }}</b></span>
            @if (det.vencido > 0) { <span class="ct-venc-num">Vencido <b>{{ money(det.vencido) }}</b></span> }
            @if (det.saldo_a_favor > 0) { <span class="ct-favor">A favor <b>{{ money(det.saldo_a_favor) }}</b></span> }
            @if (det.dias_pago_prom != null) { <span class="muted" [title]="det.n_pagos + ' facturas pagadas'">paga a <b>{{ det.dias_pago_prom }}d</b></span> }
            <!-- [CXC.47] Edgar, 2026-11-20: el estado de cuenta muestra pagadas y no pagadas, y se elige el tiempo. El
                 periodo recorta SÓLO las pagadas (las abiertas salen todas) y es el mismo para esta tabla, el PDF y
                 los dos mensajes: lo que se ve es lo que se envía. -->
            <p-select [options]="periodosEC" [ngModel]="periodoEC()" (ngModelChange)="periodoEC.set($event)"
                      optionLabel="etiqueta" optionValue="clave" ariaLabel="Periodo de las facturas pagadas"
                      styleClass="ct-sel ct-sel-periodo" data-testid="periodo-estado-cuenta" />
            @if (pagadasPeriodo().length > 0) {
              <button type="button" class="ct-link-btn" (click)="verSaldadas.set(!verSaldadas())"
                      [attr.aria-pressed]="verSaldadas()" data-testid="ver-pagadas">
                <i class="pi" [class.pi-eye]="!verSaldadas()" [class.pi-eye-slash]="verSaldadas()" aria-hidden="true"></i>
                {{ verSaldadas() ? 'Ocultar' : 'Ver' }} {{ pagadasPeriodo().length }} pagadas · {{ money(importePagadoPeriodo()) }}
              </button>
            } @else {
              <span class="muted" data-testid="sin-pagadas">Sin pagadas en el periodo</span>
            }
          </div>
          <!-- [CXC.48] Edgar, 2026-11-20: los teléfonos se corrigen aquí, donde se usan para enviar. El del cliente se
               escribe EN KEPLER, en cada sucursal donde está dado de alta (un cambio hecho en una sucursal no llega a
               las otras: medido); el del vendedor se guarda en la Suite (Kepler no tiene dónde). -->
          <div class="ct-tels" data-testid="telefonos">
            <div class="ct-tel">
              <span class="muted">Tel. cliente</span>
              <b>{{ telCliente()?.telefono || det.cliente.telefono || 'sin teléfono' }}</b>
              @if (telCliente(); as tc) { <small class="muted" [class.ct-tel-dif]="tc.distintas > 0">{{ tc.resumen }}</small> }
              @if (puedeTelefonos() && tels() && editarTel() !== 'cliente') {
                <button type="button" class="ct-link-btn" (click)="abrirEdicionTel('cliente')" data-testid="tel-cliente-cambiar">Cambiar</button>
              }
            </div>
            @if (tels()?.vendedor; as v) {
              <div class="ct-tel">
                <span class="muted">Tel. vendedor</span>
                <b>{{ v.telefono || 'sin teléfono' }}</b>
                @if (puedeTelefonos() && editarTel() !== 'vendedor') {
                  <button type="button" class="ct-link-btn" (click)="abrirEdicionTel('vendedor')" data-testid="tel-vendedor-cambiar">{{ v.telefono ? 'Cambiar' : 'Agregar' }}</button>
                }
              </div>
            }
            @if (editarTel(); as cual) {
              <form class="ct-tel-form" (ngSubmit)="guardarTel(det)" data-testid="tel-form">
                <input pInputText type="tel" inputmode="tel" autocomplete="off" name="telNuevo" [(ngModel)]="telNuevo"
                       [attr.aria-label]="cual === 'cliente' ? 'Teléfono del cliente, 10 dígitos' : 'Teléfono del vendedor, 10 dígitos'"
                       placeholder="10 dígitos" />
                <button pButton type="submit" [disabled]="telBusy() || (cual === 'cliente' && !tels()?.escritura?.posible)"
                        [attr.aria-busy]="telBusy()" data-testid="tel-guardar">{{ telBusy() ? 'Guardando…' : cual === 'cliente' ? 'Guardar en Kepler' : 'Guardar' }}</button>
                <button type="button" class="ct-link-btn" [disabled]="telBusy()" (click)="editarTel.set(null)">Cancelar</button>
                @if (cual === 'cliente') {
                  @if (tels()?.escritura?.posible) {
                    <small class="muted">Se escribe en las {{ tels()?.sucursales?.length }} sucursales donde está dado de alta.</small>
                  } @else {
                    <small class="ct-pdf-err" data-testid="tel-bloqueo">{{ tels()?.escritura?.motivo }}</small>
                  }
                }
              </form>
            }
            @if (telAviso(); as ta) {
              <p class="ct-pdf-aviso" [class.ct-pdf-err]="ta.error" role="status" data-testid="tel-aviso"><i class="pi" [class.pi-check-circle]="!ta.error" [class.pi-exclamation-triangle]="ta.error" aria-hidden="true"></i> {{ ta.texto }}</p>
            }
          </div>
          <!-- [CXC.44] Edgar, 2026-11-17: «todo esto lo podemos hacer en uno solo». Teléfono, PDF, WhatsApp y el
               enlace para depósitos eran CUATRO botones de UN acto: entregarle al cliente su estado de cuenta. Un botón:
               descarga el PDF (para adjuntarlo: wa.me sólo lleva texto), abre el chat de ESE teléfono —o, sin teléfono,
               WhatsApp para elegir a quién— con el mensaje que ya trae el enlace para depósitos (CC.20), y deja
               constancia del contacto (CXC.43). Después de enviarlo, «Ver PDF» queda a un clic en la línea de aviso. -->
          <div class="ct-det-contact">
            <a [href]="waLink(det)" target="_blank" rel="noopener" class="ct-send" (click)="enviarEstadoCuenta(det)"
               [attr.aria-busy]="pdfBusy()" data-testid="enviar-estado-cuenta">
              <i class="pi" [class.pi-whatsapp]="!pdfBusy()" [class.pi-spin]="pdfBusy()" [class.pi-spinner]="pdfBusy()" aria-hidden="true"></i>
              <span class="ct-send-txt">
                <b>Enviar al cliente</b>
                <small>WhatsApp · {{ det.cliente.telefono || 'eliges a quién' }}{{ enlaceDeposito() ? ' · PDF y depósitos en su enlace' : ' · con el PDF para adjuntar' }}</small>
              </span>
            </a>
            <!-- [CXC.47] El mismo estado de cuenta para el vendedor de la cuenta. Ni Kepler ni la Suite guardan su teléfono:
                 el chat se elige en WhatsApp, y el botón lo dice. -->
            <a [href]="waLinkVendedor(det)" target="_blank" rel="noopener" class="ct-send ct-send-sec" (click)="enviarAlVendedor(det)"
               [attr.aria-busy]="pdfBusy()" data-testid="enviar-vendedor">
              <i class="pi pi-user" aria-hidden="true"></i>
              <span class="ct-send-txt">
                <b>Enviar al vendedor</b>
                <small>WhatsApp · {{ nombreVendedor(det) || 'sin vendedor' }} · {{ tels()?.vendedor?.telefono || 'eliges el chat' }}</small>
              </span>
            </a>
          </div>
          @if (contactoTexto(det); as ct) {
            <p class="ct-contacto-linea" [class.ct-pdf-err]="ct.error" role="status">
              <i class="pi" [class.pi-check-circle]="!ct.error" [class.pi-exclamation-triangle]="ct.error" aria-hidden="true"></i> {{ ct.texto }}
            </p>
          }
          @if (pdfAviso(); as av) {
            <p class="ct-pdf-aviso" [class.ct-pdf-err]="av.error" role="status"><i class="pi" [class.pi-info-circle]="!av.error" [class.pi-exclamation-triangle]="av.error" aria-hidden="true"></i> {{ av.texto }}
              @if (!av.error) { <button type="button" class="ct-link-btn" [disabled]="pdfBusy()" (click)="verEstadoCuenta(det)">Ver PDF</button> }
            </p>
          }
        </div>
        <table class="ct-det-table">
          <thead><tr><th>Documento</th><th>Folio</th><th>Fecha</th><th>Vence</th><th class="ta-r">Importe</th><th class="ta-r">Saldo</th><th>Estado</th><th><span class="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            @for (p of partidasVisibles(); track p.folio_digital) {
              <tr [class.ct-row-venc]="p.vencida && !esResto(p)" [class.ct-row-pagada]="p.saldada">
                <td>{{ p.doc_label }}</td>
                <td class="ct-mono">{{ p.folio_digital }}</td>
                <td>{{ p.fecha }}</td>
                <td>{{ p.vencimiento || '—' }}</td>
                <td class="ta-r">{{ p.importe | number:'1.2-2' }}</td>
                <td class="ta-r"><b>{{ p.saldo_documento | number:'1.2-2' }}</b></td>
                <td>
                  @if (p.saldada) { <span class="ct-tag-pag">Pagada{{ p.pagada_el ? ' ' + p.pagada_el : '' }}</span> }
                  @else if (esResto(p)) { <span class="ct-tag-redondeo" [title]="tituloRedondeo">Redondeo</span> }
                  @else if (p.vencida) { <span class="ct-tag-venc">{{ p.dias_vencido }}d</span> }
                  @else { <span class="muted">al día</span> }
                </td>
                <td class="ta-r">
                  @if (docAbrible(p)) {
                    <a pButton class="p-button-text p-button-xs"
                       [routerLink]="multitarea.enlaceDetalle(['/telemarketing/documentos'])" [target]="multitarea.target()" [queryParams]="{ doc: p.folio_digital }"
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
                @if (pagadasPeriodo().length > 0 && !verSaldadas()) { Sin partidas vivas — todo cobrado. Sus {{ pagadasPeriodo().length }} facturas pagadas del periodo están arriba, en «Ver pagadas». }
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
        <!-- [CC.20] Las fichas que el CLIENTE subió desde su enlace: lo por revisar va primero y lleva a la bandeja. -->
        @if (det.depositos_reportados?.length) {
          <div class="ct-reportados">
            <h4 class="ct-rs-h4"><i class="pi pi-upload" aria-hidden="true"></i> Fichas que subió el cliente</h4>
            @for (r of det.depositos_reportados; track r.id) {
              <div class="ct-rep-row">
                <span class="ct-prom-monto">{{ money(r.monto ?? 0) }}</span>
                <span>del {{ r.fecha || '—' }}@if (r.banco) { · {{ r.banco }} }</span>
                @switch (r.status) {
                  @case ('validado') { <span class="ct-tag-pag">Aplicada{{ r.folio ? ' · cobro ' + r.folio : '' }}</span> }
                  @case ('rechazado') { <span class="ct-tag-venc" [title]="r.motivo_rechazo || ''">Rechazada</span> }
                  @default { <a routerLink="/finanzas/cobranza" class="ct-rep-pend">Por revisar en Cobranza</a> }
                }
              </div>
            }
          </div>
        }
        <!-- [CXC.41] Compromisos de pago. Medido el 2026-11-17: CERO registrados desde que existe
             la tabla (0 inserciones, 0 envíos en ui_usage), contra 910 fichas abiertas en 30 días.
             El formulario ya no ocupa cada ficha: queda a un clic, con su conteo. Lo abierto o
             incumplido se sigue viendo siempre. -->
        <div class="ct-promesas">
          <div class="ct-prom-head">
            <h4 class="ct-rs-h4"><i class="pi pi-handshake" aria-hidden="true"></i> Compromisos de pago
              <span class="muted">{{ det.compromisos.length ? det.compromisos.length + ' abiertos' : 'ninguno abierto' }}</span></h4>
            @if (!promFormAbierto()) {
              <button type="button" class="ct-link-btn ct-prom-abrir" (click)="promFormAbierto.set(true)">
                <i class="pi pi-plus" aria-hidden="true"></i> Registrar compromiso
              </button>
            }
          </div>
          @for (p of det.compromisos; track p.id) {
            <div class="ct-prom-row" [class.ct-prom-inc]="p.estado === 'incumplida'">
              <span class="ct-prom-monto">{{ money(p.monto_prometido) }}</span>
              <span>para el <b>{{ p.fecha_promesa }}</b></span>
              @if (p.estado === 'incumplida') { <span class="ct-sobre">incumplida</span> }
              @if (p.nota) { <span class="muted ct-prom-nota">· {{ p.nota }}</span> }
              <span class="ct-prom-btns">
                @if (cancelando() === p.id) {
                  <span class="ct-prom-confirma">¿Cancelar este compromiso?</span>
                  <button pButton type="button" class="p-button-xs p-button-danger" label="Sí, cancelar" [disabled]="resolviendo() === p.id" (click)="resolvePromise(p.id, 'cancelada')"></button>
                  <button pButton type="button" class="p-button-xs p-button-text" label="No" (click)="cancelando.set(null)"></button>
                } @else {
                  <button pButton type="button" class="p-button-xs p-button-outlined" [disabled]="resolviendo() === p.id" (click)="resolvePromise(p.id, 'cumplida')">
                    <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Cumplida</span>
                  </button>
                  <button pButton type="button" class="p-button-xs p-button-text p-button-danger ct-prom-cancel" [disabled]="resolviendo() === p.id" (click)="cancelando.set(p.id)">
                    <span class="p-button-label">Cancelar</span>
                  </button>
                }
              </span>
            </div>
          }
          @if (promFormAbierto()) {
            <div class="ct-prom-form">
              <input pInputText type="text" inputmode="decimal" [(ngModel)]="promMontoTxt" placeholder="Monto" class="ct-prom-in" aria-label="Monto prometido" />
              <p-datepicker [(ngModel)]="promFecha" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" placeholder="Fecha" styleClass="ct-prom-dp" ariaLabel="Fecha de promesa" />
              <input pInputText type="text" [(ngModel)]="promNota" placeholder="Nota (opcional)" class="ct-prom-in ct-prom-nota-in" aria-label="Nota" />
              <button pButton type="button" class="p-button-sm" label="Registrar" [loading]="savingProm()" [disabled]="!montoPromesa() || !promFecha || savingProm()" (click)="savePromise(det)"></button>
              <button pButton type="button" class="p-button-sm p-button-text" label="Cerrar" [disabled]="savingProm()" (click)="promFormAbierto.set(false)"></button>
            </div>
          }
          @if (promError(); as pe) {
            <p class="ct-pdf-aviso ct-pdf-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ pe }}</p>
          }
        </div>
        @if (det.abonos.length) {
          <details class="ct-abonos"><summary>{{ det.abonos.length }} cobros / notas aplicados</summary>
            <ul>@for (a of det.abonos; track a.folio) { <li>{{ a.doc_label }} {{ a.folio }} · {{ a.fecha }} <b>{{ money(a.importe) }}</b></li> }</ul>
          </details>
        }
        @if (det.sin_documento > 0) {
          <p class="ct-det-note ct-sin-doc">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            {{ money(det.sin_documento) }} del saldo no lo explica ningún documento: Kepler aplicó cobros
            por encima de lo que la cuenta justifica. El total de arriba es el de Kepler; el desglose se queda corto.
          </p>
        } @else if (det.sin_documento < 0) {
          <p class="ct-det-note ct-sin-doc">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            {{ money(-det.sin_documento) }} en pagos que Kepler todavía no aplica a ninguna factura: se restan del
            saldo, pero cada factura sigue con lo que Kepler dice que debe.
          </p>
        }
        <p class="ct-det-note muted">El saldo del cliente sale de <b>kdue</b> (cargos − abonos), que es la cifra que cuadra con Kepler. El saldo de cada factura es el de sus aplicaciones en <b>kdm5</b>, como en el reporte de partidas vivas. Espejo read-only del ERP.</p>
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
          <p class="ct-bp-nota"><i class="pi pi-info-circle" aria-hidden="true"></i> Se muestran los primeros {{ res.renglones.length }}: <b>hay más</b>. Afina el texto.</p>
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
                    <td>{{ r.sucursal | sucursal }}</td>
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
    .ct-bp-excluye { color: var(--warn-soft-fg); }
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
      color: var(--warn-soft-fg); background: var(--warn-soft-bg);
      border: 1px solid var(--warn-border);
      border-radius: var(--r-md, 8px); padding: .5rem .75rem; margin: 0 0 1rem; }
    /* [CXC.25] El total repartido. Botones y no tarjetas: cada uno filtra. */
    .ct-tipos { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .6rem; margin: 0 0 1rem; }
    .ct-tipo { display: flex; flex-direction: column; gap: .15rem; text-align: left; cursor: pointer;
      background: var(--surface-card); border: 1px solid var(--border-color);
      border-radius: var(--r-md, 8px); padding: .6rem .75rem; font: inherit; color: inherit; }
    .ct-tipo:hover { border-color: var(--action); }
    .ct-tipo.on { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .ct-tipo:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ct-tipo-h { font-size: .74rem; text-transform: uppercase; letter-spacing: .03em; }
    .ct-tipo-n { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ct-tipo-sub { font-size: .7rem; }
    .ct-tipo-bar { display: block; height: 4px; border-radius: 2px; background: var(--surface-2); margin-top: .35rem; overflow: hidden; }
    /* [CXC.41] Un solo tono neutro: la palabra dice el tipo. El color no codificaba nada que el
       rótulo no dijera y repetía los colores de la antigüedad con otro significado. */
    .ct-tipo-fill { display: block; height: 100%; background: var(--fg-3); }
    .ct-tipo.on .ct-tipo-fill { background: var(--action); }
    /* La etiqueta en la fila: sólo aparece cuando NO es un cliente, que es la excepción. */
    .ct-kind { display: inline-block; margin-left: .4rem; font-size: .65rem; padding: .05rem .35rem;
      border-radius: var(--r-pill, 999px); border: 1px solid currentColor; cursor: help; white-space: nowrap; }
    .ct-kind { color: var(--text-muted); }
    .ct-error { color: var(--bad-fg); display: flex; gap: .5rem; align-items: center; padding: .75rem 0; }
    .ct-card-title { display: flex; align-items: center; gap: .5rem; font-size: .95rem; margin: 0 0 .6rem; }
    .ct-aging { padding: 1rem; margin-bottom: 1rem; }
    .ct-aging-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--surface-2); }
    .ct-seg { display: block; }
    /* [CXC.41] La rampa de antigüedad con tokens que voltean por tema (eran hex fijos). */
    .ct-seg-por_vencer { background: var(--ok-fg); } .ct-seg-d0_30 { background: var(--warn-fg); }
    .ct-seg-d31_60 { background: var(--chart-1); } .ct-seg-d61_90 { background: var(--bad-fg); }
    .ct-seg-d90_plus { background: color-mix(in srgb, var(--bad-fg) 65%, var(--text-main)); }
    /* El hueco no es un tramo de antigüedad: va rayado, para que se lea como "esto no tiene
       fecha" y no como un quinto nivel de morosidad. */
    .ct-seg-sin_documento { background: repeating-linear-gradient(45deg,
      var(--text-faint) 0 4px, transparent 4px 8px); }
    .ct-leg-nodoc { color: var(--text-faint); }
    .ct-leg-nodoc .pi-info-circle { font-size: .72rem; cursor: help; }
    .ct-aging-legend { list-style: none; display: flex; flex-wrap: wrap; gap: 1rem; margin: .7rem 0 0; padding: 0; font-size: .82rem; }
    .ct-aging-legend li { display: flex; align-items: center; gap: .35rem; }
    .ct-aging-legend b { margin-left: .2rem; }
    .ct-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .ct-tablewrap { padding: 0; overflow-x: auto; }
    .ct-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    .ct-table th, .ct-table td { padding: .5rem .7rem; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    .ct-table th { font-weight: 600; color: var(--text-muted); position: sticky; top: 0; background: var(--surface-card); }
    .ct-row { cursor: pointer; } .ct-row:hover { background: var(--surface-hover); }
    .ct-row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .ct-row-venc { background: color-mix(in srgb, var(--bad-fg) 4%, transparent); }
    .ct-venc-num { color: var(--bad-fg); }
    .ta-r { text-align: right !important; }
    .muted { color: var(--text-muted); font-weight: 400; }
    .ct-empty { text-align: center; color: var(--text-muted); padding: 1.5rem !important; }
    .ct-more { padding: .6rem .7rem; margin: 0; font-size: .8rem; }
    .ct-more-top { display: flex; gap: .4rem; align-items: baseline; color: var(--text-main); border-bottom: 1px solid var(--border-color); }
    .ct-more-corte { color: var(--warn-soft-fg); }
    .ct-contactado { display: inline-flex; align-items: center; gap: .2rem; margin-left: .4rem; font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .ct-contactado .pi { font-size: .65rem; }
    .ct-contactado-hoy { color: var(--ok-soft-fg); font-weight: 600; }
    .ct-contacto-linea { flex-basis: 100%; margin: .4rem 0 0; font-size: var(--fs-xs); color: var(--text-muted); display: flex; gap: .35rem; align-items: center; }
    .ct-actualizando { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); color: var(--text-muted); }
    /* [CXC.42] Mientras llega el filtro nuevo, lo viejo se atenúa y no se puede abrir: así nadie
       trabaja sobre una lista que ya no es la que eligió. */
    .ct-cuerpo { transition: opacity 150ms ease-out; }
    .ct-cuerpo.ct-cargando { opacity: .5; pointer-events: none; }
    @media (prefers-reduced-motion: reduce) { .ct-cuerpo { transition: none; } }
    .ct-det-nav { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin: 0 0 .6rem; padding-bottom: .5rem; border-bottom: 1px solid var(--border-color); }
    .ct-det-pos { font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
    .ct-csv-aviso { display: flex; gap: .35rem; align-items: center; margin: 0 0 .75rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .ct-det-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; font-size: .85rem; margin-bottom: .8rem; }
    .ct-det-saldos { display: flex; gap: 1rem; }
    .ct-det-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .ct-det-table th, .ct-det-table td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    .ct-det-table th { color: var(--text-muted); font-weight: 600; }
    .ct-mono { font-family: ui-monospace, monospace; font-size: .78rem; }
    .ct-tag-venc { background: var(--bad-soft-bg); color: var(--bad-soft-fg); border-radius: 4px; padding: .1rem .4rem; font-size: var(--fs-xs); font-weight: 600; }
    .ct-app td { border-bottom: none; padding-top: .1rem; padding-bottom: .1rem; }
    .ct-app-cell { padding-left: 1.6rem !important; font-size: .78rem; color: var(--text-muted); }
    .ct-app-cell i { font-size: .7rem; opacity: .6; }
    .ct-app-cell b { color: var(--text-main); }
    .ct-abonos { margin-top: .8rem; font-size: .82rem; } .ct-abonos ul { margin: .4rem 0 0; padding-left: 1.1rem; }
    .ct-det-note { font-size: .78rem; margin-top: .8rem; }
    .ct-head-actions { display: flex; gap: .5rem; }
    .ct-sobre { color: var(--bad-fg); font-weight: 600; }
    .ct-resumen { padding: 1rem; margin-bottom: 1rem; }
    .ct-rs-kpis { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: .3rem 0 1rem; }
    .ct-rs-kpi { display: flex; flex-direction: column; }
    .ct-rs-num { font-size: 1.4rem; font-weight: 700; line-height: 1.1; }
    .ct-rs-lbl { font-size: .76rem; color: var(--text-muted); }
    .ct-rs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 45rem) { .ct-rs-grid { grid-template-columns: 1fr; } }
    .ct-rs-h4 { font-size: .82rem; margin: 0 0 .4rem; color: var(--text-muted); }
    .ct-rs-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .ct-rs-table th, .ct-rs-table td { padding: .3rem .5rem; border-bottom: 1px solid var(--border-color); text-align: left; }
    .ct-rs-table th { color: var(--text-muted); font-weight: 600; }
    .ct-det-contact { display: flex; gap: .6rem; flex-basis: 100%; margin-top: .5rem; }
    /* [CXC.48] Teléfonos: una línea por teléfono; la edición en su renglón, sin diálogo. */
    .ct-tels { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: .3rem 1.2rem; margin-top: .5rem; font-size: var(--fs-sm, .82rem); }
    .ct-tel { display: inline-flex; align-items: baseline; gap: .45rem; }
    .ct-tel b { font-variant-numeric: tabular-nums; }
    .ct-tel-dif { color: var(--warn-soft-fg); }
    .ct-tel-form { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .ct-tel-form input { width: 12rem; }
    /* [CXC.44] El único botón de entrega: es la acción primaria de la ficha, así que lleva el color de acción. */
    .ct-send { display: inline-flex; align-items: center; gap: .55rem; min-height: 40px; padding: .35rem .9rem; border-radius: 8px;
      border: 1px solid var(--action); background: var(--action); color: var(--action-ink); text-decoration: none; font-size: .82rem; }
    .ct-send:hover { background: var(--action-hover); border-color: var(--action-hover); }
    /* [CXC.47] El envío al vendedor es secundario: un solo botón de color de acción por ficha. */
    .ct-send.ct-send-sec { background: transparent; color: var(--text-main); border-color: var(--border); }
    .ct-send.ct-send-sec:hover { background: var(--surface-hover); border-color: var(--text-muted); }
    .ct-send:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ct-send[aria-busy="true"] { cursor: progress; }
    .ct-send .pi { font-size: 1.1rem; }
    .ct-send-txt { display: flex; flex-direction: column; line-height: 1.2; }
    .ct-send-txt small { font-size: var(--fs-xs, .72rem); } /* sin opacidad: tinta sobre acción da 5.00:1 (claro) y 5.23:1 (oscuro) */
    @media (pointer: coarse) { .ct-send { min-height: 44px; } }
    .ct-pdf-aviso { flex-basis: 100%; margin: .4rem 0 0; font-size: var(--fs-xs, .75rem); color: var(--text-muted); display: flex; gap: .35rem; align-items: center; }
    .ct-pdf-err { color: var(--bad-fg, var(--text-main)); }
    .ct-360 { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: .9rem; padding: .5rem .7rem; border-radius: 6px; background: var(--surface-2); font-size: .82rem; }
    .ct-360 > i { color: var(--ok-fg); }
    .ct-360-ev { color: var(--text-muted); }
    .ct-reportados { margin-top: .9rem; padding: .7rem; border: 1px solid var(--border-color); border-radius: 8px; }
    .ct-rep-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .82rem; padding: .3rem 0; border-bottom: 1px dashed var(--border-color); }
    .ct-rep-pend { margin-left: auto; color: var(--action); text-decoration: none; font-weight: 600; font-size: .8rem; }
    .ct-360-link { margin-left: auto; text-decoration: none; color: var(--action); font-size: .8rem; white-space: nowrap; }
    .ct-rs-proy { margin-bottom: 1rem; }
    .ct-proy-row { display: flex; flex-wrap: wrap; gap: .5rem; }
    .ct-proy-cell { flex: 1; min-width: 120px; padding: .5rem .7rem; border-radius: 6px; background: var(--surface-2); display: flex; flex-direction: column; }
    .ct-proy-venc { background: var(--bad-soft-bg); }
    .ct-proy-num { font-weight: 700; font-size: 1rem; }
    .ct-proy-lbl { font-size: .74rem; color: var(--text-muted); }
    .ct-rs-trend { margin-bottom: 1rem; }
    .ct-trend-bars { display: flex; align-items: flex-end; gap: 2px; height: 60px; }
    .ct-trend-col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
    .ct-trend-bar { width: 100%; background: var(--chart-8); border-radius: 2px 2px 0 0; position: relative; min-height: 2px; display: flex; align-items: flex-end; }
    .ct-trend-venc { width: 100%; background: var(--bad-fg); border-radius: 2px 2px 0 0; }
    .ct-rs-trend-empty { font-size: .78rem; margin: .2rem 0 1rem; display: flex; gap: .4rem; align-items: baseline; }
    .ct-rs-nota { font-size: .78rem; margin: .6rem 0 0; display: flex; gap: .4rem; align-items: baseline; }
    .ct-promesas { margin-top: .9rem; padding: .7rem; border: 1px solid var(--border-color); border-radius: 8px; }
    .ct-prom-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .ct-prom-abrir { white-space: nowrap; }
    .ct-prom-confirma { font-size: .8rem; color: var(--text-main); }
    /* Cancelar va separado de Cumplida (Von Restorff): no se aprieta por error. */
    .ct-prom-cancel { margin-left: .75rem; }
    .ct-prom-head .ct-rs-h4 { margin: 0; display: flex; align-items: center; gap: .4rem; }
    .ct-prom-row { display: flex; align-items: center; gap: .5rem; font-size: .82rem; padding: .3rem 0; border-bottom: 1px dashed var(--surface-border, #eee); }
    .ct-prom-inc { background: var(--bad-soft-bg); }
    .ct-prom-monto { font-weight: 700; }
    .ct-prom-nota { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ct-prom-btns { margin-left: auto; display: flex; gap: .3rem; align-items: center; }
    .ct-prom-empty { font-size: .8rem; margin: .3rem 0; }
    .ct-prom-form { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .6rem; align-items: center; }
    .ct-prom-in { width: 110px; } .ct-prom-nota-in { flex: 1; min-width: 140px; width: auto; }
    .ct-det-state { display: flex; align-items: center; gap: .6rem; padding: 1.2rem .2rem; font-size: .85rem; color: var(--text-muted); }
    .ct-det-err { color: var(--bad-fg); }
    .ct-row-pagada td { opacity: .6; }
    .ct-tag-redondeo { border: 1px solid var(--border-color); color: var(--text-muted); border-radius: 4px; padding: .1rem .4rem; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; }
    .ct-tag-pag { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border-radius: 4px; padding: .1rem .4rem; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; }
    .ct-link-btn { background: none; border: 0; padding: 0; font: inherit; font-size: .82rem; color: var(--action); cursor: pointer; display: inline-flex; align-items: center; gap: .3rem; }
    .ct-link-btn:hover { text-decoration: underline; }
    .ct-nodoc { font-size: .7rem; opacity: .45; }
    .ct-lento { color: var(--warn-soft-fg); font-weight: 600; }
    .ct-favor { color: var(--ok-soft-fg); }
    .ct-sin-doc { display: flex; align-items: flex-start; gap: .4rem; color: var(--warn-soft-fg); background: var(--warn-soft-bg); padding: .5rem .7rem; border-radius: 6px; }
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

  // ── `[CXC.47]` El periodo del estado de cuenta: recorta las PAGADAS de la tabla, del PDF y de los mensajes ──────────
  readonly periodosEC = [...PERIODOS_ESTADO_CUENTA];
  /** Default 3 meses: la regla y su medición viven en `@megadulces/contracts` (estado-cuenta-periodo). */
  readonly periodoEC = signal<PeriodoEstadoCuenta>('3m');
  /** Lo que viaja como `date_from`: una fecha AAAA-MM-DD o «todo». */
  readonly dateFromEC = computed(() => {
    const hoy = this.detalle()?.hoy;
    return hoy ? dateFromDelPeriodo(hoy, this.periodoEC()) : undefined;
  });
  /** Las pagadas que entran al periodo: la MISMA regla que el PDF (`pagadaEnPeriodo`). */
  readonly pagadasPeriodo = computed(() => {
    const df = this.dateFromEC();
    const desde = !df || df === 'todo' ? null : df;
    return (this.detalle()?.partidas || []).filter((p) => pagadaEnPeriodo(p, desde));
  });
  readonly importePagadoPeriodo = computed(() =>
    Math.round(this.pagadasPeriodo().reduce((s, p) => s + p.importe, 0) * 100) / 100);
  readonly partidasVisibles = computed(() => {
    const p = this.detalle()?.partidas || [];
    if (!this.verSaldadas()) return p.filter((x) => !x.saldada);
    const pagadas = new Set(this.pagadasPeriodo());
    return p.filter((x) => !x.saldada || pagadas.has(x));
  });
  /** El periodo elegido, para los mensajes: su nombre y la liga pública al PDF de ESE periodo. */
  readonly periodoMensaje = computed<PeriodoMensaje | null>(() => {
    const df = this.dateFromEC();
    if (!df) return null;
    const p = PERIODOS_ESTADO_CUENTA.find((x) => x.clave === this.periodoEC());
    return {
      etiqueta: p?.etiqueta || '',
      pdfUrl: pdfPublicoDelEnlace(this.enlaceDeposito(), df),
      porDefecto: p?.meses === MESES_ESTADO_CUENTA_POR_DEFECTO,
    };
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
  /**
   * ⭐ `[CXC.41]` Abre en **«Cliente», ordenada por vencido** — lo que cobranza trabaja.
   *
   * Medido el 2026-11-17: 98 % de las 3,532 aperturas en 30 días son de `credito_cobranza`, y con
   * «Todas» por saldo la lista arrancaba con las cuentas internas (`30-73`, `50-75`, `10-00`…,
   * $24.2M) que nadie cobra por teléfono. El temor de `[CXC.25]` —abrir escondiendo dinero— ya no
   * aplica: la tira por tipo sale del universo SIN este filtro (`por_tipo_universo`) y sigue
   * mostrando internas y rutas con su monto, a un clic. Un enlace profundo a un cliente
   * (`?cliente=`) abre en «Todas»: ese cliente puede ser una cuenta interna.
   */
  cuenta: string | null = 'cliente_final';
  incluirSaldados = false;
  readonly sortOpts = [{ label: 'Mayor saldo', value: 'saldo' }, { label: 'Más vencido (cobrar)', value: 'vencido' }];

  // ── `[CXC.42]` Búsqueda y orden en el navegador ─────────────────────────────────
  /**
   * La lista llega COMPLETA (todas las cuentas del filtro, `limit=5000`: medido el 2026-11-17,
   * 1,455 cuentas = 75 KB comprimidos y el mismo tiempo de respuesta que 500). Buscar y ordenar
   * ya no vuelven al servidor: antes cada búsqueda pedía Enter y costaba 4.3 s, y cobranza
   * recargaba la lista 3.7 veces por cada ficha que abría.
   *
   * ⚠️ La búsqueda sólo UBICA cuentas: los totales de arriba siguen siendo del filtro. Se dice en
   * pantalla mientras hay texto escrito.
   */
  readonly busqueda = signal('');
  readonly orden = signal<'saldo' | 'vencido'>('vencido');
  /** Tope de filas pintadas: la tabla no es virtual y 1,455 filas de 10 celdas pesan al navegador. */
  static readonly FILAS_VISIBLES = 500;

  readonly filtradas = computed<CarteraCliente[]>(() => {
    const rows = this.data()?.clientes ?? [];
    const tokens = normalizar(this.busqueda()).split(/\s+/).filter(Boolean);
    const hits = tokens.length
      ? rows.filter((c) => {
          const hay = normalizar(`${c.cliente_nombre} ${c.cliente_code} ${c.rfc ?? ''}`);
          return tokens.every((t) => hay.includes(t));
        })
      : rows.slice();
    // [GP.R.1] En «cobrar», el vencido que es puro redondeo cuenta como cero: no se sale a cobrar $0.05.
    const venc = (c: CarteraCliente) => (c.solo_resto_vencido ? 0 : c.vencido);
    return this.orden() === 'vencido'
      ? hits.sort((x, y) => venc(y) - venc(x) || y.saldo - x.saldo)
      : hits.sort((x, y) => y.saldo - x.saldo);
  });

  /** `[GP.R.1]` La misma regla del servidor (`esRestoDeFactura`), sobre la partida del detalle. */
  esResto(p: Partida): boolean {
    return !p.saldada && esRestoDeFactura(Number(p.saldo_documento), Number(p.importe));
  }
  readonly tituloRedondeo =
    'Centavos que quedaron de una factura ya cobrada (hasta $1). Siguen en Kepler; se cierran con un Ajuste Abono, no con otro cobro.';
  readonly visibles = computed(() => this.filtradas().slice(0, FinanzasCarteraComponent.FILAS_VISIBLES));

  // ── `[CXC.42]` Recorrer la lista desde la ficha ─────────────────────────────────
  /** Dónde está la ficha abierta dentro de lo que se ve, para «Anterior» / «Siguiente cliente». */
  readonly posicion = computed<{ i: number; n: number } | null>(() => {
    const ref = this.detalleRef();
    const lista = this.visibles();
    if (!ref) return null;
    const i = lista.findIndex((c) => c.sucursal === ref.sucursal && c.cliente_code === ref.cliente);
    return i < 0 ? null : { i, n: lista.length };
  });
  /**
   * Fichas ya traídas (y la siguiente, pedida por adelantado). Se vacía en cada carga de la lista
   * y al registrar o resolver un compromiso de ese cliente.
   */
  private readonly cacheDet = new Map<string, CarteraDetalle>();
  private prefetchSub?: Subscription;
  private detSub?: Subscription;
  readonly tendencia = signal<CarteraTendencia[]>([]);
  readonly tendenciaCargada = signal(false);
  /** Texto tal cual lo teclean: «1,250.00» o «$1250» se entienden (Postel). Ver `montoPromesa()`. */
  promMontoTxt = '';
  promFecha: Date | null = null;
  promNota = '';
  readonly savingProm = signal(false);
  /** `[CXC.41]` El formulario de compromiso queda a un clic: 0 compromisos registrados en su historia. */
  readonly promFormAbierto = signal(false);
  /** Un guardado o una resolución que falla SE DICE (antes se callaba y el usuario creía que quedó). */
  readonly promError = signal<string | null>(null);
  /** Id del compromiso que pide confirmar su cancelación (paso intermedio, no se cancela de un clic). */
  readonly cancelando = signal<string | null>(null);
  /** Id del compromiso en vuelo: sus botones se apagan en el primer clic (sin doble envío). */
  readonly resolviendo = signal<string | null>(null);

  // ── `[CXC.41]` Carga sin carreras ─────────────────────────────────────────────
  /**
   * La petición en vuelo. Una carga nueva CANCELA la anterior: con 4 a 29 s por respuesta, dos
   * filtros seguidos podían terminar al revés y pintar los datos del primero con el segundo
   * elegido en el selector.
   */
  private loadSub?: Subscription;
  private tendSub?: Subscription;

  readonly csvAviso = signal<{ texto: string; error: boolean } | null>(null);

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
    if (cliente) { this.busqueda.set(cliente); this.cuenta = null; }
    this.load();
    if (cliente && suc) {
      this.detalleRef.set({ sucursal: suc, cliente, nombre: qp.get('nombre') || cliente });
      this.detalleOpen.set(true);
      this.fetchDetalle(suc, cliente);
    }
  }

  /** Los filtros de la pantalla, tal como viajan. Lo usan la carga y el CSV: el mismo universo. */
  private consulta(): CarteraQuery {
    return {
      sucursal: this.sucursal || undefined,
      grupo: this.grupo || undefined,
      zona: this.zona || undefined,
      vendedor: this.vendedor || undefined,
      cuenta: this.cuenta || undefined,
      incluir_saldados: this.incluirSaldados ? '1' : undefined,
      // `[CXC.42]` Todas las cuentas del filtro: la búsqueda y el orden se resuelven aquí.
      limit: 5000,
    };
  }

  load() {
    this.loading.set(true); this.error.set(null);
    // `[CXC.20]` UNA llamada: tabla + KPIs + resumen + opciones de filtro. Eran tres, y cada una
    // reconstruía la misma pirámide de CTEs (6.0 s + 11.3 s + 3.7 s medidos en prod).
    this.loadSub?.unsubscribe();
    // Las fichas en caché son de la lista anterior: con datos nuevos, se vuelven a pedir.
    this.cacheDet.clear();
    this.loadSub =this.svc.cartera(this.consulta()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
    this.tendSub?.unsubscribe();
    this.tendSub = this.svc.tendencia({ sucursal: this.sucursal || undefined, dias: 90 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (t) => { this.tendencia.set(t); this.tendenciaCargada.set(true); },
        error: () => { this.tendencia.set([]); this.tendenciaCargada.set(true); },
      });
  }

  trendPct(saldo: number): number {
    const max = Math.max(...this.tendencia().map((t) => t.saldo_total), 1);
    return Math.round((saldo / max) * 100);
  }

  /**
   * `[CXC.41]` Exporta a CSV **todas** las cuentas de lo que ves, no las que pinta la tabla.
   *
   * Antes salía `data().clientes`: las 500 del tope, sin aviso (medido el 2026-11-17: 500 de
   * 1,455, con $2.82M fuera). `[CXC.42]` La lista ya llega completa, así que sale de memoria, al
   * instante, con el filtro y la búsqueda aplicados. Si el servidor se cortó (más de 5,000), lo dice
   * — no entrega un archivo parcial como si fuera todo.
   */
  exportCsv() {
    const d = this.data();
    const rows = this.filtradas();
    if (!d || !rows.length) return;
    this.descargarCsv(rows, d.hoy);
    const n = rows.length.toLocaleString('es-MX');
    this.csvAviso.set(d.total_clientes > d.clientes.length
      ? { texto: `El CSV trae ${n} cuentas, pero el filtro tiene ${d.total_clientes.toLocaleString('es-MX')}: el servidor corta en 5,000. Afina el filtro para bajar el resto.`, error: true }
      : { texto: `CSV descargado: ${n} cuentas${this.busqueda().trim() ? ', las que coinciden con la búsqueda' : ', todas las del filtro'}.`, error: false });
  }

  private descargarCsv(rows: CarteraCliente[], hoy: string | undefined) {
    if (!rows.length) return;
    const head = ['Sucursal', 'Codigo', 'Cliente', 'RFC', 'Grupo', 'Zona', 'Vendedor', 'Vendedor_nombre', 'Telefono', 'Limite', 'Uso_%', 'Sobre_linea', 'Partidas', 'Dias_pago_prom', 'Vencido', 'Saldo', 'Sin_documento', 'Saldo_a_favor'];
    const esc = (v: any) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = rows.map((c) => [c.sucursal, c.cliente_code, c.cliente_nombre, c.rfc, c.grupo, c.zona, c.vendedor, c.vendedor_nombre, c.telefono, c.limite_credito, c.uso_linea, c.sobre_linea ? 'SI' : '', c.n_partidas, c.dias_pago_prom, c.vencido, c.saldo, c.sin_documento || '', c.saldo_a_favor || ''].map(esc).join(','));
    const csv = '﻿' + [head.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cartera_${this.sucursal || 'todas'}_${hoy || 'hoy'}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  /**
   * Estado de cuenta por WhatsApp, prellenado (el operador lo revisa antes de enviar). `[CXC.44]` Sin teléfono, el
   * enlace abre WhatsApp para ELEGIR a quién (wa.me sin número): antes el botón desaparecía y el estado de cuenta no se
   * podía mandar por ahí.
   */
  waLink(det: CarteraDetalle): string {
    const tel = (det.cliente.telefono || '').replace(/\D/g, '');
    const num = tel.length === 10 ? `52${tel}` : tel;
    return `https://wa.me/${num}?text=${encodeURIComponent(mensajeEstadoCuenta(det, this.enlaceDeposito(), this.periodoMensaje()))}`;
  }

  /** `[CXC.47]` El nombre del vendedor sin el número de ruta que `kduv` le pone delante. */
  nombreVendedor(det: CarteraDetalle): string {
    return (det.cliente.vendedor_nombre || det.cliente.vendedor || '').replace(/^\d+\s+/, '').trim();
  }

  /** `[CXC.47]` Al vendedor: sin teléfono en ningún sistema (medido), wa.me sin número abre WhatsApp para elegir el chat. */
  waLinkVendedor(det: CarteraDetalle): string {
    // `[CXC.48]` Con el teléfono del vendedor guardado, el chat abre directo; sin él, se elige en WhatsApp.
    const tel = this.tels()?.vendedor?.telefono || '';
    return `https://wa.me/${tel ? `52${tel}` : ''}?text=${encodeURIComponent(mensajeVendedor(det, this.enlaceDeposito(), this.periodoMensaje()))}`;
  }

  // ── `[CXC.48]` Teléfonos: el del cliente se corrige EN KEPLER (cada sucursal donde está), el del vendedor en la Suite ──
  readonly tels = signal<TelefonosCuenta | null>(null);
  private telsSub?: Subscription;
  /** Qué teléfono se está editando. */
  readonly editarTel = signal<'cliente' | 'vendedor' | null>(null);
  telNuevo = '';
  readonly telBusy = signal(false);
  readonly telAviso = signal<{ texto: string; error: boolean } | null>(null);
  /** La llave que deja corregir teléfonos (escribe en Kepler). Sin ella, los teléfonos se ven y no se editan. */
  readonly puedeTelefonos = computed(() =>
    this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_CARTERA_TELEFONOS] === true);

  /** El teléfono del cliente en la sucursal de la cuenta, y cómo está en las demás donde está dado de alta. */
  readonly telCliente = computed(() => {
    const t = this.tels(); const det = this.detalle();
    if (!t || !det) return null;
    const propio = t.sucursales.find((x) => x.sucursal === det.cliente.sucursal)?.telefono ?? null;
    const digitos = (v: string | null) => (v || '').replace(/\D/g, '');
    const distintas = t.sucursales.filter((x) => digitos(x.telefono) !== digitos(propio)).length;
    const n = t.sucursales.length;
    const resumen = n === 1 ? 'dado de alta en 1 sucursal'
      : distintas === 0 ? `igual en las ${n} sucursales donde está dado de alta`
      : `distinto en ${distintas} de ${n} sucursales`;
    return { telefono: propio, resumen, distintas };
  });

  private pedirTelefonos(det: CarteraDetalle): void {
    this.telsSub?.unsubscribe();
    this.telsSub = this.svc.telefonos(det.cliente.sucursal, det.cliente.cliente_code, det.cliente.vendedor)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (t) => { if (this.detalleRef()?.cliente === det.cliente.cliente_code) this.tels.set(t); },
        // Sin los teléfonos la ficha sigue: el de `det.cliente.telefono` sirve para enviar. Se dice, no se calla.
        error: (e) => this.telAviso.set({ texto: `No se pudieron leer los teléfonos. ${e?.error?.message || ''}`.trim(), error: true }),
      });
  }

  abrirEdicionTel(cual: 'cliente' | 'vendedor'): void {
    this.telAviso.set(null);
    this.telNuevo = (cual === 'cliente' ? this.telCliente()?.telefono : this.tels()?.vendedor?.telefono) || '';
    this.editarTel.set(cual);
  }

  guardarTel(det: CarteraDetalle): void {
    const cual = this.editarTel();
    if (!cual || this.telBusy()) return;
    this.telBusy.set(true);
    this.telAviso.set(null);
    const c = det.cliente;
    const fin = () => this.telBusy.set(false);
    const fallo = (e: { error?: { message?: string }; message?: string }) => {
      fin();
      this.telAviso.set({ texto: `No se guardó. ${e?.error?.message || e?.message || ''}`.trim(), error: true });
    };
    if (cual === 'vendedor') {
      const v = this.tels()?.vendedor;
      if (!v) { fin(); return; }
      this.svc.cambiarTelefonoVendedor(v.sucursal, v.code, this.telNuevo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          fin();
          const t = this.tels();
          if (t?.vendedor) this.tels.set({ ...t, vendedor: { ...t.vendedor, telefono: r.telefono } });
          this.editarTel.set(null);
          this.telAviso.set({ texto: `Teléfono del vendedor guardado: ${r.telefono}.`, error: false });
        },
        error: fallo,
      });
      return;
    }
    this.svc.cambiarTelefonoCliente(c.sucursal, c.cliente_code, this.telNuevo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        fin();
        const cuenta = (e: string) => r.servidores.filter((x) => x.estado === e && x.servidor !== 'SC').length;
        const malas = r.servidores.filter((x) => x.estado === 'rechazada');
        const nuevo = this.telNuevo.replace(/\D/g, '').slice(-10);
        // Lo escrito se refleja ya; el ODS lo confirma por la cola de cambios en segundos.
        const t = this.tels();
        if (t) {
          const buenas = new Set(r.servidores.filter((x) => x.estado === 'escrita' || x.estado === 'ya_estaba').map((x) => x.servidor));
          this.tels.set({ ...t, sucursales: t.sucursales.map((x) => (buenas.has(x.sucursal) ? { ...x, telefono: nuevo } : x)) });
        }
        if (r.estado !== 'rechazado') {
          const d = this.detalle();
          if (d) this.detalle.set({ ...d, cliente: { ...d.cliente, telefono: nuevo } });
          this.cacheDet.delete(`${c.sucursal}|${c.cliente_code}`);
        }
        const partes = [`${cuenta('escrita')} actualizada(s)`];
        if (cuenta('ya_estaba')) partes.push(`${cuenta('ya_estaba')} ya lo tenía(n)`);
        if (cuenta('no_esta')) partes.push(`no está dado de alta en ${cuenta('no_esta')}`);
        this.editarTel.set(null);
        this.telAviso.set(malas.length
          ? { texto: `Kepler no aceptó el cambio en: ${malas.map((x) => (x.servidor === 'SC' ? 'concentrador' : x.servidor)).join(', ')}. ${malas[0].motivo || ''}`.trim(), error: true }
          : { texto: `Teléfono guardado en Kepler: ${partes.join(' · ')}.`, error: false });
      },
      error: fallo,
    });
  }

  /**
   * `[CXC.47]` Con enlace, el mensaje lleva la liga al PDF del periodo: no hay nada que adjuntar. Sin enlace, se descarga
   * el PDF para adjuntarlo, como con el cliente. No se registra como contacto con el cliente: no lo es.
   */
  enviarAlVendedor(det: CarteraDetalle): void {
    if (this.periodoMensaje()?.pdfUrl) this.pdfAviso.set({ texto: 'El mensaje al vendedor lleva la liga al PDF del periodo.', error: false });
    else if (!this.pdfBusy()) this.descargarParaWhatsApp(det);
  }

  /**
   * `[CXC.44]` El único botón de entrega: el `<a>` abre el chat (dentro del clic, el navegador no lo bloquea) y aquí se
   * descarga el PDF para adjuntarlo y queda el contacto. Un segundo clic mientras se genera el PDF no lo pide dos veces.
   */
  enviarEstadoCuenta(det: CarteraDetalle): void {
    // `[CC.20.2]` Con enlace, el PDF viaja EN el enlace (el cliente lo descarga ahí): no hay nada que adjuntar, y
    // descargarlo aquí sólo dejaría un archivo de más. Sin enlace, como antes: se descarga para adjuntarlo a mano.
    if (this.enlaceDeposito()) this.pdfAviso.set({ texto: 'El estado de cuenta en PDF va en su enlace: el cliente lo descarga desde ahí.', error: false });
    else if (!this.pdfBusy()) this.descargarParaWhatsApp(det);
    this.registrarContacto(det, 'whatsapp');
  }

  // ── [CXC.40] Estado de cuenta en PDF ─────────────────────────────────────────
  readonly pdfBusy = signal(false);
  readonly pdfAviso = signal<{ texto: string; error: boolean } | null>(null);

  /**
   * Abre el PDF en su pestaña. La pestaña se abre YA, dentro del clic, o el navegador la bloquea. `[CXC.44]` Se llama
   * desde la línea de aviso que dejó el envío: el aviso se conserva para que «Ver PDF» siga a la mano.
   */
  verEstadoCuenta(det: CarteraDetalle): void {
    const previo = this.pdfAviso();
    this.pedirPdf(det, abrirPestanaParaPdf('Preparando el estado de cuenta…'), previo && !previo.error ? previo.texto : null);
  }

  /**
   * El enlace de WhatsApp abre el chat (es un `<a>`: el navegador no lo bloquea) y aquí se descarga
   * el PDF para adjuntarlo. wa.me sólo lleva texto: adjuntar es un paso de la persona, y se le dice.
   */
  descargarParaWhatsApp(det: CarteraDetalle): void {
    this.pedirPdf(det, null, 'Se descargó el estado de cuenta: adjúntalo en el chat de WhatsApp antes de enviar el mensaje.');
  }

  private pedirPdf(det: CarteraDetalle, win: Window | null, avisoOk: string | null): void {
    const c = det.cliente;
    this.pdfBusy.set(true);
    this.pdfAviso.set(null);
    this.svc.estadoCuentaPdf(c.sucursal, c.cliente_code, this.dateFromEC()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        this.pdfBusy.set(false);
        const donde = entregarPdf(win, b, `estado-de-cuenta-${c.cliente_code}-${det.hoy}`);
        if (avisoOk) this.pdfAviso.set({ texto: avisoOk, error: false });
        else if (donde === 'descarga') this.pdfAviso.set({ texto: 'El navegador bloqueó la pestaña: el estado de cuenta se descargó.', error: false });
      },
      error: (e) => {
        this.pdfBusy.set(false);
        cerrarPestanaDePdf(win);
        mensajeDeErrorBlob(e).then((m) => this.pdfAviso.set({ texto: `No se pudo generar el estado de cuenta. ${m}`, error: true }));
      },
    });
  }

  openDetalle(c: CarteraCliente) {
    this.limpiarFicha();
    this.detalleRef.set({ sucursal: c.sucursal, cliente: c.cliente_code, nombre: c.cliente_nombre });
    this.detalleOpen.set(true);
    this.fetchDetalle(c.sucursal, c.cliente_code);
  }
  closeDetalle() {
    this.detalleOpen.set(false); this.detalle.set(null);
    this.detalleError.set(null); this.detalleLoading.set(false); this.detalleRef.set(null);
    this.detSub?.unsubscribe();
    this.limpiarFicha();
  }
  /** Lo que pertenece a UNA ficha y no debe pasar a la siguiente al recorrer la lista. */
  // ── `[CC.20]` El enlace del cliente para subir su ficha de depósito ─────────────────────────────
  /** La URL del enlace de la ficha abierta: va dentro del mensaje de WhatsApp (y como QR en el PDF). */
  readonly enlaceDeposito = signal<string | null>(null);
  private enlaceSub?: Subscription;
  /** Se pide al abrir la ficha; si falla, el mensaje sale como antes (sin enlace): es una comodidad, no un requisito. */
  private pedirEnlace(sucursal: string, cliente: string) {
    this.enlaceSub?.unsubscribe();
    this.enlaceSub = this.svc.enlaceDeposito(sucursal, cliente).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { if (this.detalleRef()?.cliente === cliente) this.enlaceDeposito.set(r.url); },
      error: () => this.enlaceDeposito.set(null),
    });
  }
  private limpiarFicha() {
    this.enlaceDeposito.set(null); this.enlaceSub?.unsubscribe();
    this.tels.set(null); this.telsSub?.unsubscribe(); this.editarTel.set(null); this.telAviso.set(null);
    this.verSaldadas.set(false);
    this.pdfAviso.set(null);
    this.contactoError.set(null);
    this.promFormAbierto.set(false); this.promError.set(null);
    this.cancelando.set(null); this.resolviendo.set(null);
    this.promMontoTxt = ''; this.promFecha = null; this.promNota = '';
  }

  // ── `[CXC.43]` Contactos de cobranza ────────────────────────────────────────────
  /** Un registro de contacto que falló SE DICE: si no, la lista afirmaría «sin contactar». */
  readonly contactoError = signal<string | null>(null);

  /**
   * Deja constancia del contacto. Lo dispara el acto (llamar, WhatsApp, PDF), sin formulario.
   * El mismo canal con la misma cuenta dentro de un minuto no se repite (doble clic).
   */
  registrarContacto(det: CarteraDetalle, canal: CanalContacto) {
    const { sucursal, cliente_code } = det.cliente;
    const fila = this.data()?.clientes.find((c) => c.sucursal === sucursal && c.cliente_code === cliente_code);
    const previo = fila?.ultimo_contacto;
    if (previo && previo.canal === canal && Date.now() - new Date(previo.at).getTime() < 60_000) return;
    this.contactoError.set(null);
    this.svc.registrarContacto(sucursal, cliente_code, canal).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const d = this.data();
        if (!d) return;
        const yo = this.auth.user()?.username ?? null;
        this.data.set({
          ...d,
          contactos_medidos: true,
          clientes: d.clientes.map((c) => c.sucursal === sucursal && c.cliente_code === cliente_code
            ? { ...c, ultimo_contacto: { at: r.contacted_at, canal: r.canal, por: yo } }
            : c),
        });
      },
      error: (e) => this.contactoError.set(`No quedó registrado el contacto. ${e?.error?.message || e?.message || ''}`.trim()),
    });
  }

  /** «hoy 10:32» o «hace 3 días» para la fila; null si no hay contacto o no se puede medir. */
  contactoCorto(c: CarteraCliente): { texto: string; hoy: boolean } | null {
    if (!this.data()?.contactos_medidos || !c.ultimo_contacto) return null;
    const dias = diasDesde(c.ultimo_contacto.at);
    if (dias === 0) return { texto: `hoy ${horaMx(c.ultimo_contacto.at)}`, hoy: true };
    return { texto: dias === 1 ? 'ayer' : `hace ${dias} días`, hoy: false };
  }

  /** La línea de la ficha: último contacto, o por qué no se puede decir. */
  contactoTexto(det: CarteraDetalle): { texto: string; error: boolean } | null {
    const err = this.contactoError();
    if (err) return { texto: err, error: true };
    const d = this.data();
    if (!d) return null;
    if (!d.contactos_medidos) {
      return { texto: 'El registro de contactos todavía no está activo: no se puede decir a quién ya se contactó.', error: false };
    }
    const fila = d.clientes.find((c) => c.sucursal === det.cliente.sucursal && c.cliente_code === det.cliente.cliente_code);
    const uc = fila?.ultimo_contacto;
    if (!uc) return { texto: 'Sin contacto registrado en los últimos 30 días.', error: false };
    const canal = ({ telefono: 'por teléfono', whatsapp: 'por WhatsApp', estado_cuenta_pdf: 'con el estado de cuenta en PDF' } as Record<CanalContacto, string>)[uc.canal];
    const cuando = diasDesde(uc.at) === 0 ? `hoy a las ${horaMx(uc.at)}` : `el ${fechaMx(uc.at)}`;
    return { texto: `Último contacto: ${cuando}, ${canal}${uc.por ? ` (${uc.por})` : ''}.`, error: false };
  }

  /** `[CXC.42]` Anterior / siguiente cliente de lo que se ve, sin cerrar la ficha. */
  irA(delta: number) {
    const pos = this.posicion();
    if (!pos) return;
    const destino = this.visibles()[pos.i + delta];
    if (destino) this.openDetalle(destino);
  }

  /**
   * El documento de venta desglosado vive en `/telemarketing/documentos` (Fase AX, vistas en vivo
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

  /**
   * `[CXC.42]` Trae la ficha (de la caché si ya vino) y, al tenerla, pide por adelantado la
   * SIGUIENTE de la lista: así «Siguiente cliente» abre sin la espera de ~3.3 s.
   * Una ficha que llega tarde de un cliente que ya no es el abierto se descarta.
   */
  private fetchDetalle(sucursal: string, cliente: string, usarCache = true) {
    const k = `${sucursal}|${cliente}`;
    this.detSub?.unsubscribe();
    this.detalleError.set(null);
    const enCache = usarCache ? this.cacheDet.get(k) : undefined;
    if (enCache) {
      this.detalle.set(enCache); this.detalleLoading.set(false);
      this.precargarSiguiente();
      this.pedirEnlace(sucursal, cliente);
      this.pedirTelefonos(enCache);
      return;
    }
    this.detalle.set(null); this.detalleLoading.set(true);
    this.detSub = this.svc.detalle(sucursal, cliente).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.cacheDet.set(k, d);
        this.detalle.set(d); this.detalleLoading.set(false);
        this.precargarSiguiente();
        this.pedirEnlace(sucursal, cliente);
        this.pedirTelefonos(d);
      },
      error: (e) => { this.detalleError.set(e?.error?.message || e?.message || 'error'); this.detalleLoading.set(false); },
    });
  }

  private precargarSiguiente() {
    const pos = this.posicion();
    const sig = pos ? this.visibles()[pos.i + 1] : undefined;
    if (!sig) return;
    const k = `${sig.sucursal}|${sig.cliente_code}`;
    if (this.cacheDet.has(k)) return;
    this.prefetchSub?.unsubscribe();
    this.prefetchSub = this.svc.detalle(sig.sucursal, sig.cliente_code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.cacheDet.set(k, d),
      // Una precarga que falla no avisa: al abrir esa ficha se vuelve a pedir y ahí sí se dice.
      error: () => undefined,
    });
  }

  /** Después de escribir (compromiso), la ficha se vuelve a pedir: la de la caché ya es vieja. */
  private reloadDetalle(sucursal: string, cliente: string) {
    this.cacheDet.delete(`${sucursal}|${cliente}`);
    this.fetchDetalle(sucursal, cliente, false);
  }

  /**
   * `[CXC.41]` El monto como número, aceptando la forma en que se teclea: «1,250.00», «$1250»,
   * « 1250 ». Liberal en la FORMA, nunca en el significado: algo que no es un número positivo
   * devuelve null y el botón no se enciende.
   */
  montoPromesa(): number | null {
    const limpio = (this.promMontoTxt || '').replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
    const n = Number(limpio);
    return n > 0 ? n : null;
  }

  savePromise(det: CarteraDetalle) {
    const monto = this.montoPromesa();
    if (!monto || !this.promFecha || this.savingProm()) return;
    const f = this.promFecha;
    const fecha = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    this.savingProm.set(true); this.promError.set(null);
    this.svc.createPromise(det.cliente.sucursal, det.cliente.cliente_code, { monto, fecha, nota: this.promNota.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.promMontoTxt = ''; this.promFecha = null; this.promNota = '';
          this.savingProm.set(false); this.promFormAbierto.set(false);
          this.reloadDetalle(det.cliente.sucursal, det.cliente.cliente_code);
        },
        // Lo tecleado se QUEDA en el formulario para reintentar; antes se callaba la falla.
        error: (e) => {
          this.savingProm.set(false);
          this.promError.set(`No se guardó el compromiso. ${e?.error?.message || e?.message || ''}`.trim());
        },
      });
  }

  resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada') {
    if (this.resolviendo()) return;
    const det = this.detalle();
    this.resolviendo.set(id); this.promError.set(null);
    this.svc.resolvePromise(id, estado).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.resolviendo.set(null); this.cancelando.set(null);
        if (det) this.reloadDetalle(det.cliente.sucursal, det.cliente.cliente_code);
      },
      error: (e) => {
        this.resolviendo.set(null);
        this.promError.set(`No se pudo marcar el compromiso. ${e?.error?.message || e?.message || ''}`.trim());
      },
    });
  }

  money(v: number) { return (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' }); }

  kpiItems(d: CarteraResp): MetricStripItem[] {
    // `[CXC.41]` Los rótulos dicen QUÉ universo suman: con un tipo elegido, el saldo es el de ese
    // tipo (el total completo está en la tira de abajo), y «clientes» sólo cuando sólo hay clientes
    // — sin filtro, el conteo incluye cuentas internas y rutas.
    const tipo = this.cuenta ? this.kindLabel(this.cuenta as CuentaKind) : null;
    return [
      { label: tipo ? `Saldo · ${tipo}` : 'Saldo total', value: this.money(d.kpi.total_saldo) },
      { label: 'Vencido', value: this.money(d.kpi.total_vencido), tone: d.kpi.total_vencido > 0 ? 'warn' : undefined },
      { label: this.cuenta === 'cliente_final' ? 'Clientes con saldo' : 'Cuentas con saldo', value: String(d.kpi.n_clientes) },
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
    // `[CXC.41]` Del universo SIN el filtro de tipo, para que elegir «Cliente» no esconda el resto.
    // Si la API todavía no lo manda (versión anterior), cae al reparto de lo filtrado.
    const t = d.kpi.por_tipo_universo ?? d.kpi.por_tipo;
    const total = (['cliente_final', 'interno', 'ruta'] as CuentaKind[]).reduce((s, k) => s + t[k].saldo, 0) || 1;
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
