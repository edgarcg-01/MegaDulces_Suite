import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { CarteraSegmentsComponent } from '../cartera-segments.component';
import { CarteraService, PorDiaResp, DiaCartera, DiaDocumento, DiaClienteRef, ClienteDelDia, DiaEstado } from '../cartera.service';

/**
 * ⭐ `[CXC.26]` **Crédito por día** — la misma cartera de `/finanzas/cartera`, con el calendario
 * como eje. Contesta las dos preguntas que la vista por cliente no contesta: **«¿quiénes me deben
 * estos días?»** y **«¿qué día debo cobrar?»**.
 *
 * ── ⛔ POR QUÉ EL EJE VA A LOS DOS LADOS ──────────────────────────────────────────────────────
 * La lectura ingenua de «qué día debo cobrar» es un calendario hacia adelante. Medido en prod el
 * 2026-09-25, ese calendario es casi vacío: **$7,897,657.69 vencen hoy o después (12.9%) contra
 * $53,015,537.54 ya vencidos (87.1%), repartidos en 273 días distintos**. Una pantalla de
 * sólo-futuro diría «tenés $7.9M por cobrar» sobre una cartera de $61M.
 *
 * Así que el día significa dos cosas según de qué lado caiga, y la pantalla lo dice con esas
 * palabras: hacia atrás **«desde cuándo te deben»**, hacia adelante **«cuándo te van a deber»**.
 *
 * ── ⛔ EL TIPO DE CUENTA NO ES UN FILTRO MÁS ─────────────────────────────────────────────────
 * De los $26,081,506.31 entre plazas propias (`interno`), **cero están por vencer**: el 100% ya
 * venció. `ruta` ($3.2M) va casi igual — 0.4% por vencer. Sin separarlas, la agenda de cobranza se
 * llena de saldos que nadie va a cobrar por teléfono. La pantalla abre en **Todas** —esconder
 * dinero al abrir es el bug que `[CXC.20.3]` ya arregló una vez— pero el reparto por tipo está a
 * un clic, arriba.
 *
 * ⚠️ Esas cifras son del 2026-09-25 y la base es VIVA (el CDC corre cada 15 s): entre la primera
 * medición de esta fase y la última, `ruta` pasó de $0 a $12,873 por vencer. Quien las necesite
 * exactas las saca del smoke, que las vuelve a medir; acá están para explicar la decisión de
 * diseño, no para citarlas como saldo.
 *
 * ── Lo que el calendario NO puede mostrar ────────────────────────────────────────────────────
 * El eje es el vencimiento, que sólo existe a nivel documento. La diferencia contra el saldo
 * canónico de `kdue` no tiene fecha ($612,428.11, el 1.0%) y va **declarada al pie**, nunca
 * repartida a dedo (ADR-056).
 *
 * ⚠️ **Todos los drills son locales.** La respuesta trae la agenda completa (292 días y 5,652
 * filas día × cliente = 119 KB gzipeados, medido), así que abrir un día es instantáneo y no
 * dispara un request. La única espera es la carga inicial: ~2.4 s, que es la pirámide de CTEs ya
 * bautizada `[CXC.21]`, no algo que esta pantalla haya agregado.
 *
 * ── ⛔ El enlace al auxiliar NO usa `multitarea.enlaceDetalle()` ──────────────────────────────
 * El nombre del cliente en el drill abre su estado de cuenta con `?suc=&cliente=`, un deep link
 * que se agregó a `/finanzas/cartera` junto con esta pantalla (antes esa ruta ignoraba por
 * completo los query params, así que un enlace así se veía igual y aterrizaba sin filtrar).
 *
 * `enlaceDetalle()` devuelve un `UrlTree` en modo pantalla partida, y el `RouterLink` de Angular,
 * cuando su entrada ya es un `UrlTree`, lo usa tal cual e **IGNORA `queryParams`** (verificado en
 * el fuente de `@angular/router`: `isUrlTree(input)` → `return input`). O sea que en modo partido
 * el enlace abriría el panel sin cliente y sin filtro: justo lo único que este enlace lleva.
 *
 * ⚠️ Adentro del template NO van acentos graves —ni en los comentarios HTML—: vive en un template
 * literal y uno solo lo corta. Ya rompió el build de este repo cuatro veces.
 */
@Component({
  selector: 'app-finanzas-cartera-dia',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterModule, ButtonModule, SelectModule, InputTextModule,
    MetricStripComponent, FreshnessPillComponent, CarteraSegmentsComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Crédito por día</h1>
          <p class="surf-page-sub">
            La agenda de cobranza: qué día vence cada peso y quién lo debe. Hacia atrás el día dice
            <b>desde cuándo</b> te deben; hacia adelante, <b>cuándo</b> te van a deber.
          </p>
        </div>
        <div class="cd-head-actions">
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="!data()?.dias?.length" (click)="exportCsv()">
            <span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">CSV</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <app-cartera-segments />

      <div class="cd-filters">
        <p-select [options]="cuentaOpts()" [(ngModel)]="cuenta" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Tipo de cuenta" styleClass="cd-sel" ariaLabel="Tipo de cuenta" />
        <p-select [options]="sucursalOpts()" [(ngModel)]="sucursal" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Sucursal" styleClass="cd-sel" ariaLabel="Sucursal" />
        <p-select [options]="zonaOpts()" [(ngModel)]="zona" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Zona" [showClear]="true" styleClass="cd-sel" ariaLabel="Zona" />
        <p-select [options]="vendedorOpts()" [(ngModel)]="vendedor" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Vendedor" [showClear]="true" [filter]="true" styleClass="cd-sel cd-sel-vend" ariaLabel="Vendedor" />
        <span class="cd-search">
          <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Cliente, código o RFC…" aria-label="Buscar cliente" />
        </span>
        @if (data(); as d) {
          <app-freshness-pill measures="data" [freshness]="d.freshness" [since]="d.freshness.data_as_of" label="Datos del ERP" />
        }
      </div>

      @if (error()) {
        <div class="cd-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>No se pudo cargar la agenda por día. {{ error() }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" label="Reintentar" (click)="load()"></button>
        </div>
      }

      @if (loading() && !data()) {
        <div class="cd-state"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Armando la agenda…</div>
      }

      @if (data(); as d) {
        @if (d.freshness.stale) {
          <div class="cd-stale" role="status">
            <i class="pi pi-clock" aria-hidden="true"></i>
            @if (d.freshness.status === 'unknown') {
              <span>No se pudo medir qué tan viejo es este dato. No quiere decir que esté al día.</span>
            } @else {
              <span>Los saldos vienen del ERP con <b>{{ d.freshness.age_human }}</b> de rezago.</span>
            }
          </div>
        }

        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Agenda de cobranza" />

        <!-- ⛔ Esto NO es decoración. Es la corrección de fondo de la pantalla: sin este renglón,
             la tira de días de abajo se lee como «la cobranza que viene», y lo que viene es el
             12.9%. Las tres cifras suman lo repartible, exacto. -->
        <section class="cd-eje" aria-label="Los dos lados del eje">
          <button type="button" class="cd-lado cd-lado-venc" [class.on]="lado() === 'vencido'"
                  [attr.aria-pressed]="lado() === 'vencido'" (click)="verLado('vencido')">
            <span class="cd-lado-h"><i class="pi pi-exclamation-circle" aria-hidden="true"></i> Ya venció — cobrar ya</span>
            <span class="cd-lado-n">{{ money(d.totales.vencido) }}</span>
            <span class="cd-lado-sub muted">{{ pct(d.totales.vencido, repartible(d)) }}% · repartido en {{ d.totales.dias_vencidos }} días</span>
          </button>
          <button type="button" class="cd-lado cd-lado-hoy" [class.on]="lado() === 'hoy'"
                  [attr.aria-pressed]="lado() === 'hoy'" (click)="verLado('hoy')">
            <span class="cd-lado-h"><i class="pi pi-flag" aria-hidden="true"></i> Vence hoy</span>
            <span class="cd-lado-n">{{ money(d.totales.hoy) }}</span>
            <span class="cd-lado-sub muted">{{ pct(d.totales.hoy, repartible(d)) }}% · {{ d.hoy }}</span>
          </button>
          <button type="button" class="cd-lado cd-lado-fut" [class.on]="lado() === 'futuro'"
                  [attr.aria-pressed]="lado() === 'futuro'" (click)="verLado('futuro')">
            <span class="cd-lado-h"><i class="pi pi-calendar" aria-hidden="true"></i> Por vencer</span>
            <span class="cd-lado-n">{{ money(d.totales.futuro) }}</span>
            <span class="cd-lado-sub muted">{{ pct(d.totales.futuro, repartible(d)) }}% · en {{ d.totales.dias_futuros }} días</span>
          </button>
        </section>

        <!-- La forma del calendario de un vistazo. Cada barra es un día; el alto es el monto y el
             color, de qué lado cae. Hoy va marcado. -->
        @if (tira().length > 1) {
          <section class="card-premium card-flat cd-tira">
            <div class="cd-tira-head">
              <h3 class="cd-card-title"><i class="pi pi-chart-bar" aria-hidden="true"></i> La forma del calendario
                <span class="muted">{{ tira().length }} días con saldo · pico {{ money(maxDia()) }}</span></h3>
              @if (lado() || diaSel()) {
                <button type="button" class="cd-link-btn" (click)="verTodo()"><i class="pi pi-times" aria-hidden="true"></i> Ver todos los días</button>
              }
            </div>
            <div class="cd-bars" role="img" [attr.aria-label]="'Cartera por día de vencimiento, ' + tira().length + ' días'">
              @for (t of tira(); track t.fecha) {
                <button type="button" class="cd-bar-col" [class.sel]="diaSel() === t.fecha"
                        [title]="t.fecha + ' · ' + money(t.monto) + ' · ' + t.clientes + ' clientes · ' + cuando(t)"
                        [attr.aria-label]="t.fecha + ', ' + money(t.monto)"
                        (click)="seleccionar(t.fecha)">
                  <span class="cd-bar" [class]="'cd-bar-' + t.estado" [style.height.%]="alto(t)"></span>
                </button>
              }
            </div>
            <p class="cd-bars-leg muted">
              <span class="cd-dot cd-bar-vencido"></span> ya venció
              <span class="cd-dot cd-bar-hoy"></span> hoy
              <span class="cd-dot cd-bar-futuro"></span> por vencer
            </p>
          </section>
        }

        <section class="card-premium card-flat cd-tablewrap">
          <table class="cd-table">
            <caption class="sr-only">Cartera por día de vencimiento. Cada renglón abre los clientes de ese día.</caption>
            <thead>
              <tr>
                <th>Día</th><th>Cuándo</th><th class="ta-r">Clientes</th><th class="ta-r">Docs</th>
                <th class="ta-r">Monto</th><th class="ta-r">Acumulado</th><th><span class="sr-only">Abrir</span></th>
              </tr>
            </thead>
            <tbody>
              @for (t of filas(); track t.fecha) {
                <tr class="cd-row" [class.cd-row-venc]="t.estado === 'vencido'" [class.cd-row-hoy]="t.estado === 'hoy'"
                    [class.cd-row-open]="diaSel() === t.fecha"
                    [attr.aria-expanded]="diaSel() === t.fecha" (click)="seleccionar(t.fecha)">
                  <td><b>{{ t.fecha }}</b> <span class="muted">{{ diaSemana(t.fecha) }}</span></td>
                  <td [class.cd-venc-num]="t.estado === 'vencido'">{{ cuando(t) }}</td>
                  <td class="ta-r">{{ t.clientes }}</td>
                  <td class="ta-r">{{ t.docs }}</td>
                  <td class="ta-r"><b>{{ t.monto | number:'1.2-2' }}</b></td>
                  <td class="ta-r muted">{{ acumulado()[t.fecha] | number:'1.0-0' }}</td>
                  <td class="ta-r"><i class="pi" [class.pi-angle-down]="diaSel() === t.fecha" [class.pi-angle-right]="diaSel() !== t.fecha" aria-hidden="true"></i></td>
                </tr>
                @if (diaSel() === t.fecha) {
                  <tr class="cd-drill"><td colspan="7">
                    <div class="cd-drill-head">
                      <span>
                        <b>{{ clientesDelDia().length }}</b> {{ clientesDelDia().length === 1 ? 'cliente' : 'clientes' }}
                        {{ t.estado === 'futuro' ? 'con facturas que vencen el' : 'con facturas vencidas el' }} {{ t.fecha }}
                        <span class="muted">— suman {{ money(t.monto) }} en {{ t.docs }} {{ t.docs === 1 ? 'factura' : 'facturas' }}</span>
                      </span>
                      <button type="button" class="cd-link-btn" (click)="alternarTodasLasFacturas()">
                        <i class="pi" [class.pi-eye]="!todasFacturas()" [class.pi-eye-slash]="todasFacturas()" aria-hidden="true"></i>
                        {{ todasFacturas() ? 'Ocultar las facturas' : 'Ver todas las facturas' }}
                      </button>
                    </div>
                    <table class="cd-drill-table">
                      <thead><tr>
                        <th>Cliente</th><th>Plaza</th><th>Zona</th><th>Vendedor</th><th>Teléfono</th>
                        <th class="ta-r">Facturas</th><th class="ta-r">Monto</th><th><span class="sr-only">Abrir</span></th>
                      </tr></thead>
                      <tbody>
                        @for (c of clientesDelDia(); track c.ref.k) {
                          <tr class="cd-crow" [class.cd-crow-open]="facturasAbiertas(c.ref.k)"
                              [attr.aria-expanded]="facturasAbiertas(c.ref.k)" (click)="alternarCliente(c.ref.k)">
                            <td>
                              <!-- El nombre abre el auxiliar completo; el RENGLÓN abre sus facturas
                                   de este día. Son dos cosas distintas y por eso el enlace corta la
                                   propagación. Ver el bloque del deep link en la cabecera del
                                   componente. Sin acentos graves acá: esto vive en un template
                                   literal y uno solo lo corta. -->
                              <a [routerLink]="['/finanzas/cartera']"
                                 [queryParams]="{ suc: c.ref.sucursal, cliente: c.ref.cliente_code, nombre: c.ref.cliente_nombre }"
                                 (click)="$event.stopPropagation()"
                                 [title]="'Ver el estado de cuenta completo de ' + c.ref.cliente_nombre">{{ c.ref.cliente_nombre }}</a>
                              <span class="muted cd-mono">{{ c.ref.cliente_code }}</span>
                              @if (!cuenta && c.ref.cuenta_kind !== 'cliente_final') {
                                <span class="cd-kind" [class]="'cd-kind-' + c.ref.cuenta_kind">{{ kindLabel(c.ref.cuenta_kind) }}</span>
                              }
                            </td>
                            <!-- El NOMBRE de la plaza. Si el código no está en el catálogo de
                                 almacenes se muestra el número, marcado: esconderlo sería esconder
                                 dinero que nadie puede ubicar. -->
                            <td>
                              @if (c.ref.sucursal_nombre) { {{ c.ref.sucursal_nombre }} }
                              @else { <span class="cd-sinnombre" [title]="'La sucursal ' + c.ref.sucursal + ' no está en el catálogo de almacenes'">{{ c.ref.sucursal }}</span> }
                            </td>
                            <td>
                              @if (c.ref.zona_nombre) { {{ c.ref.zona_nombre }} }
                              @else if (c.ref.zona) { <span class="cd-sinnombre" [title]="'El código de zona ' + c.ref.zona + ' no está en el catálogo de Kepler'">{{ c.ref.zona }}</span> }
                              @else { <span class="muted" title="El cliente no tiene zona asignada en el ERP">Sin zona</span> }
                            </td>
                            <td>{{ c.ref.vendedor_nombre || c.ref.vendedor || '—' }}</td>
                            <td>
                              @if (c.ref.telefono) {
                                <a [href]="'tel:' + c.ref.telefono" (click)="$event.stopPropagation()" class="cd-tel"><i class="pi pi-phone" aria-hidden="true"></i> {{ c.ref.telefono }}</a>
                              } @else { <span class="muted">—</span> }
                            </td>
                            <td class="ta-r">{{ c.docs.length }}</td>
                            <td class="ta-r"><b>{{ c.monto | number:'1.2-2' }}</b></td>
                            <td class="ta-r"><i class="pi" [class.pi-angle-down]="facturasAbiertas(c.ref.k)" [class.pi-angle-right]="!facturasAbiertas(c.ref.k)" aria-hidden="true"></i></td>
                          </tr>
                          @if (facturasAbiertas(c.ref.k)) {
                            <tr class="cd-fact"><td colspan="8">
                              <table class="cd-fact-table">
                                <thead><tr>
                                  <th>Documento</th><th>Folio</th><th>Se facturó</th><th>Venció</th>
                                  <th class="ta-r">Importe</th><th class="ta-r">Saldo</th>
                                </tr></thead>
                                <tbody>
                                  @for (f of c.docs; track f.folio_digital) {
                                    <tr>
                                      <td>{{ f.doc_label }}</td>
                                      <td class="cd-mono">{{ f.folio_digital }}</td>
                                      <td>{{ f.fecha_doc || '—' }}</td>
                                      <td [class.cd-venc-num]="f.estado === 'vencido'">{{ f.fecha }}</td>
                                      <td class="ta-r muted">{{ f.importe | number:'1.2-2' }}</td>
                                      <td class="ta-r"><b>{{ f.saldo | number:'1.2-2' }}</b></td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                              <!-- ⭐ El que va a llamar necesita saber que el cliente debe MÁS que lo
                                   de este día, o lo llama dos veces. -->
                              @if (c.otros_dias_docs > 0) {
                                <p class="cd-otros muted">
                                  <i class="pi pi-info-circle" aria-hidden="true"></i>
                                  Este cliente además debe <b>{{ money(c.otros_dias_monto) }}</b> en
                                  {{ c.otros_dias_docs }} {{ c.otros_dias_docs === 1 ? 'factura' : 'facturas' }} de otros días.
                                  <a [routerLink]="['/finanzas/cartera']"
                                     [queryParams]="{ suc: c.ref.sucursal, cliente: c.ref.cliente_code, nombre: c.ref.cliente_nombre }"
                                     (click)="$event.stopPropagation()">Ver su estado de cuenta</a>
                                </p>
                              }
                            </td></tr>
                          }
                        } @empty {
                          <!-- No puede pasar: los días y las facturas salen de las mismas filas. Pero
                               un drill vacío en silencio se leería como "no debe nadie". -->
                          <tr><td colspan="8" class="cd-empty">Este día tiene {{ money(t.monto) }} pero ningún cliente en el desglose. Es una inconsistencia del dato, no un día sin deuda: avisá a Sistemas.</td></tr>
                        }
                      </tbody>
                    </table>
                  </td></tr>
                }
              } @empty {
                <tr><td colspan="7" class="cd-empty">
                  @if (lado()) { Ningún día de este lado del eje con el filtro puesto. <button type="button" class="cd-link-btn" (click)="verTodo()">Ver todos los días</button> }
                  @else { Sin cartera para el filtro. Ajustá sucursal, vendedor o búsqueda. }
                </td></tr>
              }
            </tbody>
          </table>
        </section>

        <!-- ADR-056: lo que el eje no puede colocar en ningún día se dice con su monto. -->
        <p class="cd-cobertura muted">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          El calendario reparte <b>{{ money(d.cobertura.repartible) }}</b> de los
          <b>{{ money(d.cobertura.canonico) }}</b> que deben {{ d.cobertura.clientes | number }} cuentas.
          @if (d.cobertura.sin_documento !== 0) {
            Los <b>{{ money(d.cobertura.sin_documento) }}</b> restantes ({{ pct(absN(d.cobertura.sin_documento), d.cobertura.canonico) }}%) no tienen
            documento abierto que les ponga fecha, así que no caen en ningún día.
          }
          @if (d.cobertura.sin_vencimiento > 0) {
            Otros <b>{{ money(d.cobertura.sin_vencimiento) }}</b> tienen documento pero sin fecha de vencimiento en el ERP.
          }
        </p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cd-head-actions { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
    .cd-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .6rem 0 .9rem; }
    :host ::ng-deep .cd-sel { min-width: 170px; }
    :host ::ng-deep .cd-sel-vend { min-width: 220px; }
    .cd-search input { min-width: 220px; }
    .cd-error { display: flex; align-items: center; gap: .6rem; color: var(--danger, #b42318); background: rgba(180,35,24,.06); padding: .6rem .8rem; border-radius: 8px; font-size: .85rem; margin-bottom: .8rem; }
    .cd-state { display: flex; align-items: center; gap: .6rem; padding: 1.4rem .2rem; font-size: .85rem; color: var(--text-2, #6b6b6b); }
    .cd-stale { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: #8a6d1f; background: rgba(201,162,39,.08); padding: .5rem .7rem; border-radius: 6px; margin-bottom: .7rem; }

    /* Los dos lados del eje. Botones, no cajas: cada uno filtra la tabla de abajo. */
    .cd-eje { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: .6rem; margin: .9rem 0; }
    .cd-lado { display: flex; flex-direction: column; gap: .15rem; text-align: left; padding: .7rem .8rem; border: 1px solid var(--border-color, #e7e5e0); border-radius: 10px; background: var(--card-bg, #fff); cursor: pointer; transition: border-color 120ms var(--ease-standard), box-shadow 120ms var(--ease-standard); }
    .cd-lado:hover { border-color: var(--action, #c2410c); }
    .cd-lado.on { border-color: var(--action, #c2410c); box-shadow: 0 0 0 1px var(--action, #c2410c) inset; }
    .cd-lado-h { font-size: .74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; display: flex; align-items: center; gap: .35rem; }
    .cd-lado-n { font-family: var(--font-mono, 'Geist Mono', monospace); font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .cd-lado-sub { font-size: .74rem; }
    .cd-lado-venc .cd-lado-h { color: var(--danger, #b42318); }
    .cd-lado-hoy .cd-lado-h { color: #8a6d1f; }
    .cd-lado-fut .cd-lado-h { color: #4f6b54; }

    .cd-card-title { display: flex; align-items: baseline; gap: .45rem; font-size: .88rem; margin: 0 0 .5rem; }
    .cd-tira-head { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
    .cd-bars { display: flex; align-items: flex-end; gap: 1px; height: 96px; overflow-x: auto; padding-bottom: 2px; }
    .cd-bar-col { flex: 1 0 4px; min-width: 4px; height: 100%; display: flex; align-items: flex-end; background: none; border: 0; padding: 0; cursor: pointer; }
    .cd-bar { width: 100%; min-height: 2px; border-radius: 1px 1px 0 0; transition: opacity 120ms var(--ease-standard); }
    .cd-bar-col:hover .cd-bar { opacity: .7; }
    .cd-bar-col.sel .cd-bar { outline: 2px solid var(--action, #c2410c); outline-offset: 1px; }
    .cd-bar-vencido { background: #b42318; }
    .cd-bar-hoy { background: #c9a227; }
    .cd-bar-futuro { background: #6b8f71; }
    .cd-bars-leg { font-size: .72rem; display: flex; gap: .9rem; align-items: center; margin: .45rem 0 0; }
    .cd-dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-right: .25rem; vertical-align: -1px; }

    .cd-tablewrap { padding: 0; overflow: hidden; }
    .cd-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .cd-table thead th { position: sticky; top: 0; z-index: 1; background: var(--card-bg, #fff); text-align: left; font-weight: 600; font-size: .74rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #6b6b6b); padding: .5rem .6rem; border-bottom: 1px solid var(--border-color, #e7e5e0); }
    .cd-table td { padding: .42rem .6rem; border-bottom: 1px solid var(--surface-border, #f1efec); }
    .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cd-row { cursor: pointer; }
    .cd-row:hover td { background: var(--layout-bg, #faf9f7); }
    .cd-row-venc td:first-child { box-shadow: inset 3px 0 0 #b42318; }
    .cd-row-hoy td:first-child { box-shadow: inset 3px 0 0 #c9a227; }
    .cd-row-open td { background: var(--layout-bg, #faf9f7); font-weight: 600; }
    .cd-venc-num { color: var(--danger, #b42318); }
    .cd-mono { font-family: var(--font-mono, 'Geist Mono', monospace); font-size: .72rem; margin-left: .35rem; }

    .cd-drill td { background: var(--layout-bg, #faf9f7); padding: .5rem .8rem .8rem; }
    .cd-drill-head { font-size: .8rem; margin-bottom: .4rem; display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; flex-wrap: wrap; }
    .cd-drill-table { width: 100%; border-collapse: collapse; font-size: .78rem; }
    .cd-drill-table th { text-align: left; font-weight: 600; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #6b6b6b); padding: .3rem .45rem; border-bottom: 1px solid var(--border-color, #e7e5e0); }
    .cd-drill-table td { padding: .3rem .45rem; border-bottom: 1px dashed var(--surface-border, #eee); }
    .cd-drill-table a { color: var(--action, #c2410c); text-decoration: none; }
    .cd-drill-table a:hover { text-decoration: underline; }
    .cd-crow { cursor: pointer; }
    .cd-crow:hover > td { background: var(--card-bg, #fff); }
    .cd-crow-open > td { background: var(--card-bg, #fff); font-weight: 600; }

    /* El tercer nivel: las FACTURAS. Se hunde un poco mas y pierde el fondo, para que se lea
       como "lo de adentro de este cliente" y no como otra tabla al mismo nivel. */
    .cd-fact > td { background: var(--card-bg, #fff); padding: .35rem .5rem .6rem 1.6rem; border-left: 2px solid var(--action, #c2410c); }
    .cd-fact-table { width: 100%; border-collapse: collapse; font-size: .76rem; }
    .cd-fact-table th { text-align: left; font-weight: 600; font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #6b6b6b); padding: .25rem .4rem; border-bottom: 1px solid var(--surface-border, #eee); }
    .cd-fact-table td { padding: .25rem .4rem; border-bottom: 1px dotted var(--surface-border, #f0eeeb); }
    .cd-otros { font-size: .74rem; margin: .45rem 0 0; display: flex; gap: .35rem; align-items: baseline; flex-wrap: wrap; }
    .cd-otros a { color: var(--action, #c2410c); }

    /* Un codigo sin nombre NO se esconde: se muestra marcado. Ocultarlo seria esconder dinero
       que nadie puede ubicar, y en esta pantalla ese es justo el error a evitar. */
    .cd-sinnombre { font-family: var(--font-mono, 'Geist Mono', monospace); font-size: .74rem; border-bottom: 1px dotted currentColor; opacity: .75; cursor: help; }
    .cd-tel { white-space: nowrap; }
    .cd-kind { font-size: .68rem; font-weight: 600; border-radius: 4px; padding: .05rem .3rem; margin-left: .3rem; white-space: nowrap; }
    .cd-kind-interno { background: rgba(107,143,113,.16); color: #4f6b54; }
    .cd-kind-ruta { background: rgba(201,162,39,.16); color: #8a6d1f; }

    .cd-empty { text-align: center; color: var(--text-muted, #6b6b6b); padding: 1.4rem .6rem; font-size: .82rem; }
    .cd-link-btn { background: none; border: 0; padding: 0; font: inherit; font-size: .78rem; color: var(--action, #c2410c); cursor: pointer; display: inline-flex; align-items: center; gap: .25rem; }
    .cd-link-btn:hover { text-decoration: underline; }
    .cd-cobertura { font-size: .78rem; margin: .8rem 0 0; display: flex; gap: .4rem; align-items: baseline; line-height: 1.5; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

    @media (pointer: coarse) { .cd-bar-col { flex-basis: 8px; min-width: 8px; } }
  `],
})
export class FinanzasCarteraDiaComponent implements OnInit {
  private readonly svc = inject(CarteraService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<PorDiaResp | null>(null);

  /** Qué lado del eje se está mirando. `null` = los dos, que es como abre. */
  readonly lado = signal<DiaEstado | null>(null);
  /** El día abierto. Su desglose YA está en la respuesta: abrirlo no pide nada al servidor. */
  readonly diaSel = signal<string | null>(null);

  sucursal: string | null = null;
  zona: string | null = null;
  vendedor: string | null = null;
  /**
   * Abre en **Todas**, igual que la vista por cliente y por el mismo motivo: filtrar de entrada
   * a `cliente_final` escondería $29.3M de cuentas internas y de ruta. El reparto está arriba y
   * filtrar es un clic — pero el total que se publica es el total.
   */
  cuenta: string | null = null;
  search = '';

  readonly sucursalOpts = computed(() => [
    { label: 'Todas', value: null as string | null },
    ...(this.data()?.filtros.sucursales || []).map((s) => ({ label: s.label, value: s.code as string | null })),
  ]);
  readonly zonaOpts = computed(() => (this.data()?.filtros.zonas || []).map((z) => ({ label: z, value: z })));
  readonly vendedorOpts = computed(() => (this.data()?.filtros.vendedores || []).map((v) => ({ label: v.label, value: v.code })));
  readonly cuentaOpts = computed(() => [
    { label: 'Todas las cuentas', value: null as string | null },
    ...(this.data()?.filtros.cuentas || []).map((k) => ({ label: k.label, value: k.code as string | null })),
  ]);

  /** Los días que la tira dibuja y la tabla lista: todos, o los del lado elegido. */
  readonly tira = computed<DiaCartera[]>(() => {
    const d = this.data(); if (!d) return [];
    const l = this.lado();
    return l ? d.dias.filter((x) => x.estado === l) : d.dias;
  });

  /**
   * La tabla va del más reciente al más viejo hacia atrás, y del más cercano al más lejano hacia
   * adelante — o sea **el día de hoy arriba**. Ordenar por fecha ascendente pondría primero una
   * factura de julio de 2025 que nadie va a cobrar hoy; ordenar por monto perdería el calendario.
   */
  readonly filas = computed<DiaCartera[]>(() =>
    this.tira().slice().sort((a, b) => Math.abs(a.dias_offset) - Math.abs(b.dias_offset)
      || b.dias_offset - a.dias_offset));

  /** Acumulado en el orden de la tabla: «si cobro hasta acá, junté tanto». */
  readonly acumulado = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {}; let s = 0;
    for (const t of this.filas()) { s += t.monto; out[t.fecha] = Math.round(s * 100) / 100; }
    return out;
  });

  readonly maxDia = computed(() => this.tira().reduce((m, x) => Math.max(m, x.monto), 0));

  /**
   * ⭐ Los clientes del día abierto, con SUS facturas — armado en memoria, sin un solo request.
   *
   * El monto del renglón es la suma de sus propias facturas, no un número que venga aparte: por
   * construcción no puede discrepar del desglose que se abre debajo.
   *
   * `otros_dias_*` mira TODA la agenda, no sólo el día: el que va a llamar necesita saber que el
   * cliente debe más que lo de hoy, o lo llama dos veces.
   */
  readonly clientesDelDia = computed<ClienteDelDia[]>(() => {
    const f = this.diaSel(); const d = this.data();
    if (!f || !d) return [];

    const porK = new Map<string, DiaClienteRef>();
    for (const c of d.clientes) porK.set(c.k, c);

    const delDia = new Map<string, DiaDocumento[]>();
    const otros = new Map<string, { monto: number; docs: number }>();
    for (const doc of d.documentos) {
      if (doc.fecha === f) {
        const l = delDia.get(doc.k); if (l) l.push(doc); else delDia.set(doc.k, [doc]);
      } else {
        const o = otros.get(doc.k) || { monto: 0, docs: 0 };
        o.monto += doc.saldo; o.docs += 1; otros.set(doc.k, o);
      }
    }

    const out: ClienteDelDia[] = [];
    for (const [k, docs] of delDia) {
      const ref = porK.get(k);
      // Una factura sin su cliente no se descarta en silencio: se muestra con el código que trae
      // la llave. Descartarla haría que el renglón del día no sume lo que dice la tabla.
      const [suc, code] = k.split('|');
      const o = otros.get(k);
      out.push({
        ref: ref ?? {
          k, sucursal: suc, sucursal_nombre: null, cliente_code: code, cliente_nombre: code,
          telefono: null, zona: null, zona_nombre: null, vendedor: null, vendedor_nombre: null,
          cuenta_kind: 'cliente_final', dias_credito: null,
        },
        docs: docs.slice().sort((a, b) => b.saldo - a.saldo),
        monto: Math.round(docs.reduce((s, x) => s + x.saldo, 0) * 100) / 100,
        otros_dias_monto: o ? Math.round(o.monto * 100) / 100 : 0,
        otros_dias_docs: o ? o.docs : 0,
      });
    }
    return out.sort((a, b) => b.monto - a.monto);
  });

  /** Qué clientes tienen sus facturas abiertas. Se limpia al cambiar de día o de filtro. */
  private readonly abiertos = signal<ReadonlySet<string>>(new Set());
  /** «Ver todas las facturas» — abre el desglose de todos los clientes del día de una. */
  readonly todasFacturas = signal(false);

  facturasAbiertas(k: string): boolean { return this.todasFacturas() || this.abiertos().has(k); }

  alternarCliente(k: string): void {
    // Con «ver todas» prendido, el clic individual apagaría sólo uno y el botón quedaría
    // mintiendo. Se apaga el modo global y se conserva lo que estaba abierto menos éste.
    if (this.todasFacturas()) {
      const todos = new Set(this.clientesDelDia().map((c) => c.ref.k));
      todos.delete(k);
      this.todasFacturas.set(false);
      this.abiertos.set(todos);
      return;
    }
    const s = new Set(this.abiertos());
    if (s.has(k)) s.delete(k); else s.add(k);
    this.abiertos.set(s);
  }

  alternarTodasLasFacturas(): void {
    const v = !this.todasFacturas();
    this.todasFacturas.set(v);
    if (!v) this.abiertos.set(new Set());
  }

  ngOnInit() { this.load(); }

  load(): void {
    this.loading.set(true); this.error.set(null);
    this.svc.porDia({
      sucursal: this.sucursal || undefined,
      zona: this.zona || undefined,
      vendedor: this.vendedor || undefined,
      cuenta: this.cuenta || undefined,
      search: this.search.trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        // Un día abierto que ya no existe en el recorte nuevo dejaría la fila expandida vacía.
        if (this.diaSel() && !d.dias.some((x) => x.fecha === this.diaSel())) this.cerrarDia();
        else this.cerrarFacturas();
        this.loading.set(false);
      },
      // Visible SIEMPRE: un `subscribe(next)` a secas deja la pantalla en el estado anterior y
      // nadie se entera de que el servidor falló.
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'error'); this.loading.set(false); },
    });
  }

  /**
   * ⚠️ Cerrar las facturas al cambiar de día NO es cosmético: las llaves abiertas son de los
   * clientes del día anterior, y si sobreviven, el cliente que caiga con la misma llave en el día
   * nuevo aparece desplegado sin que nadie lo haya pedido.
   */
  private cerrarFacturas(): void { this.abiertos.set(new Set()); this.todasFacturas.set(false); }
  private cerrarDia(): void { this.diaSel.set(null); this.cerrarFacturas(); }

  seleccionar(fecha: string): void {
    const mismo = this.diaSel() === fecha;
    this.cerrarFacturas();
    this.diaSel.set(mismo ? null : fecha);
  }
  verLado(l: DiaEstado): void { this.lado.set(this.lado() === l ? null : l); this.cerrarDia(); }
  verTodo(): void { this.lado.set(null); this.cerrarDia(); }

  repartible(d: PorDiaResp): number { return d.cobertura.repartible; }
  absN(n: number): number { return Math.abs(n); }

  kpiItems(d: PorDiaResp): MetricStripItem[] {
    const exigible = Math.round((d.totales.vencido + d.totales.hoy) * 100) / 100;
    return [
      { label: 'Exigible hoy', value: this.money(exigible), tone: exigible > 0 ? 'bad' : undefined,
        sub: 'vencido + lo que vence hoy' },
      { label: 'Por vencer', value: this.money(d.totales.futuro), sub: `en ${d.totales.dias_futuros} días` },
      { label: 'Días con saldo', value: String(d.dias.length), sub: `${d.totales.dias_vencidos} ya vencidos` },
      { label: 'Cuentas con saldo', value: String(d.cobertura.clientes) },
    ];
  }

  /** Alto de la barra. Raíz cuadrada: con escala lineal un pico de $1.5M aplana 200 días a 1px. */
  alto(t: DiaCartera): number {
    const m = this.maxDia();
    if (m <= 0) return 2;
    return Math.max(2, Math.round(Math.sqrt(t.monto / m) * 100));
  }

  /** En palabras, del lado que toque. El servidor ya dijo cuál es: acá sólo se redacta. */
  cuando(t: DiaCartera): string {
    if (t.estado === 'hoy') return 'Vence hoy';
    if (t.estado === 'futuro') return t.dias_offset === 1 ? 'Vence mañana' : `Vence en ${t.dias_offset} días`;
    const n = -t.dias_offset;
    return n === 1 ? 'Venció ayer' : `Venció hace ${n} días`;
  }

  /**
   * ⚠️ `new Date('2026-09-25')` es medianoche **UTC**, así que `getDay()` en México devuelve el
   * día ANTERIOR. Se arma con `Date.UTC` + `getUTCDay()`, que no depende del reloj del equipo.
   */
  diaSemana(fecha: string): string {
    const d = new Date(Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1, +fecha.slice(8, 10)));
    return ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getUTCDay()];
  }

  kindLabel(k: string): string {
    return k === 'interno' ? 'Plaza' : k === 'ruta' ? 'Ruta' : 'Cliente';
  }

  money(n: number): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  pct(a: number, b: number): number { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

  /**
   * El CSV sale de lo que está EN PANTALLA (mismo filtro, mismo lado): si exportara todo, el
   * archivo no coincidiría con lo que la persona acaba de mirar.
   *
   * ⭐ Una fila por **FACTURA**, no por cliente: es lo que se lleva el que sale a cobrar, y una
   * fila «cliente X debe $600» no le dice qué folios reclamar. Plaza y zona van con **nombre**;
   * el código va en su propia columna para que siga siendo cruzable con el ERP.
   */
  exportCsv(): void {
    const d = this.data(); if (!d) return;
    const filas = this.filas();
    const porFecha = new Set(filas.map((f) => f.fecha));
    const porK = new Map(d.clientes.map((c) => [c.k, c]));
    const cuandoPorFecha = new Map(filas.map((f) => [f.fecha, this.cuando(f)]));
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['vence', 'dia', 'cuando', 'dias_vencido', 'plaza', 'plaza_code', 'zona', 'zona_code',
      'cliente_code', 'cliente', 'vendedor', 'telefono', 'tipo_cuenta',
      'documento', 'folio', 'se_facturo', 'importe', 'saldo'];
    const body = d.documentos
      .filter((x) => porFecha.has(x.fecha))
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || b.saldo - a.saldo)
      .map((x) => {
        const c = porK.get(x.k);
        return [
          x.fecha, this.diaSemana(x.fecha), cuandoPorFecha.get(x.fecha) || '',
          x.dias_offset < 0 ? -x.dias_offset : 0,
          // Si el catálogo no tiene el código, va el código: un vacío se leería como «sin plaza».
          c?.sucursal_nombre || c?.sucursal || '', c?.sucursal || '',
          c?.zona_nombre || c?.zona || 'Sin zona', c?.zona || '',
          c?.cliente_code || '', c?.cliente_nombre || '',
          c?.vendedor_nombre || c?.vendedor || '', c?.telefono || '', c?.cuenta_kind || '',
          x.doc_label, x.folio_digital, x.fecha_doc || '',
          x.importe.toFixed(2), x.saldo.toFixed(2),
        ].map(esc).join(',');
      });
    const csv = [head.join(','), ...body].join('\n');
    // BOM: sin él Excel en Windows abre los acentos rotos.
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = `cartera-por-dia-${d.hoy}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
}
