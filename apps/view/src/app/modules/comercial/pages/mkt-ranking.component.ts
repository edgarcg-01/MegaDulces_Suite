import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { firstValueFrom, forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { PopoverModule } from 'primeng/popover';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { coincideBusqueda } from '@megadulces/ui-web';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarPdf } from '../../../shared/util/abrir-pdf';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PROMOS_TABS } from '../promos-tabs';
import {
  CANALES, CANAL_VENTA, Canal, MktRankingService, PromoVenta, VendedorVenta, VentaSemana, canalesSinContrastar, coincidePromoVenta, dinero,
  moverSemana, pct, textoProductos, textoSemana,
} from '../mkt-ranking.service';
import { pdfVenta } from '../mkt-venta-pdf';

type Vista = 'promociones' | 'vendedores';
const TODOS = 'todos';
const n0 = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 2 });

/**
 * `[MKT.30]`/`[MKT.31]` **Promociones** — los dos rankings de Mercadotecnia (rediseño del 2026-11-19,
 * maqueta aprobada por el dev responsable, v14).
 *
 * Dos preguntas que no se mezclan:
 *  · «Ranking de promociones»: ¿qué promoción se vende más y dónde se movió? TODA la venta de la
 *    semana, los 4 canales; filtros canal · sucursal · zona; la promo abre por canal, sucursal y zona.
 *  · «Ranking de vendedores»: ¿quién vendió más? Sólo lo que se le CARGÓ a cada uno (en Sucursales,
 *    lo que la cajera le asignó en su arqueo); el vendedor abre sus promociones con precio y total.
 *
 * Jerarquía: primario = paquetes y el lugar; secundario = dinero, objetivo y avance; terciario =
 * el código, la ruta y las notas de método. «Objetivos» se cambian en un solo panel (Sucursales).
 * Lo que no se midió se dice (ADR-056): «sin dato» para el dinero sin producto, y el dinero de los
 * canales que aún no se contrastan contra Kepler lo lleva escrito junto a la cifra.
 */
@Component({
  selector: 'app-mkt-ranking',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, ButtonModule, InputTextModule, SelectModule, PopoverModule, DatePickerModule, ToastModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page vt">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Promociones <app-context-help topic="mkt-ranking" /></h1>
          <div class="vt-semana" role="group" aria-label="Semana">
            <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(-1)" [disabled]="!datos()" aria-label="Semana anterior">
              <span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
            <button type="button" class="vt-semana-btn" (click)="calendario.toggle($event)" aria-haspopup="dialog" [disabled]="!datos()"
                    [attr.aria-label]="'Semana: ' + (datos() ? semanaTexto() : 'cargando') + '. Elegir otra en el calendario'">
              <i [class]="actualizando() ? 'pi pi-spin pi-spinner' : 'pi pi-calendar'" aria-hidden="true"></i>
              <span>{{ datos() ? semanaTexto() : 'Cargando semana…' }}</span>
            </button>
            <span class="sr-only" role="status">{{ actualizando() ? 'Actualizando…' : '' }}</span>
            <p-popover #calendario appendTo="body" ariaLabel="Elegir semana">
              <p-datepicker [inline]="true" [showWeek]="true" [firstDayOfWeek]="1" [maxDate]="hoy" [ngModel]="lunesFecha()"
                            (onSelect)="elegirDia($event); calendario.hide()" ariaLabel="Elige un día: se abre su semana (lunes a domingo)" />
              <p class="vt-pista">Toca cualquier día: se abre su semana, de lunes a domingo.</p>
            </p-popover>
            <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(1)" [disabled]="!datos() || datos()?.semana?.en_curso" aria-label="Semana siguiente">
              <span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
          </div>
        </div>
        <div class="vt-acciones">
          <app-freshness-pill measures="fetch" [since]="datos()?.consultado_at ?? null" [staleAfterSec]="900"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="objetivosAbierto.set(true)" [disabled]="!datos()">
            <span class="p-button-icon p-button-icon-left pi pi-bullseye" aria-hidden="true"></span><span class="p-button-label">Objetivos</span>
          </button>
          <button pButton type="button" class="p-button-sm" (click)="pdf()" [disabled]="generando() || !datos() || actualizando()" [loading]="generando()">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF</span>
          </button>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" variant="menu" ariaLabel="Secciones de Mercadotecnia" />

      <app-segmented [options]="opcionesVista" [value]="vista()" (valueChange)="elegirVista($event)" ariaLabel="Ranking"></app-segmented>

      <div class="vt-filtros">
        <input pInputText type="search" class="vt-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               [placeholder]="vista() === 'promociones' ? 'Escanea o escribe: promoción, código o producto' : 'Busca un vendedor, ruta o sucursal'"
               [attr.aria-label]="vista() === 'promociones' ? 'Buscar promoción' : 'Buscar vendedor'" />
        <app-segmented [options]="opcionesCanal" [value]="canal() ?? todos" (valueChange)="elegirCanal($event)" ariaLabel="Canal"></app-segmented>
        <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (ngModelChange)="elegirSucursal($event)"
                  [showClear]="true" placeholder="Todas las sucursales" appendTo="body" ariaLabel="Sucursal" [filter]="true" filterBy="label"></p-select>
        <p-select [options]="opcionesZona()" optionLabel="label" optionValue="value" [ngModel]="zona()" (ngModelChange)="elegirZona($event)"
                  [showClear]="true" placeholder="Todas las zonas" appendTo="body" ariaLabel="Zona"></p-select>
      </div>

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !datos()!.promos.length"
                      emptyTitle="Ninguna promoción vendió con estos filtros" emptyHint="Cambia la semana o quita un filtro." (retry)="res.reload()">
        @if (datos(); as d) {
          <div [class.vt-atenuado]="actualizando()">
          @if (vista() === 'promociones') {
            <app-metric-strip [items]="metricas()" ariaLabel="La semana"></app-metric-strip>
            @if (sinContrastar().length) {
              <p class="vt-aviso" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i>
                Dinero de {{ textoSinContrastar() }}: todavía sin contrastar contra el total de los documentos de Kepler.</p>
            }
            <div class="vt-cab">
              <h2>Toda la venta <span class="vt-tenue">· {{ textoFiltro() }}</span></h2>
              <span class="vt-tenue">{{ filasPromos().length }} de {{ d.promos.length }} promociones · de más a menos paquetes</span>
            </div>
            <p-table [value]="filasPromos()" dataKey="promo_id" styleClass="p-datatable-sm vt-tabla" [tableStyle]="{ 'min-width': '760px' }">
              <ng-template #header>
                <tr>
                  <th class="vt-num" style="width:3rem">#</th>
                  <th>Promoción</th>
                  <th class="vt-num" style="width:7rem">Paquetes</th>
                  <th class="vt-num" style="width:7rem">Objetivo</th>
                  <th style="width:10rem">Avance</th>
                  <th class="vt-num" style="width:9rem">Dinero</th>
                </tr>
              </ng-template>
              <ng-template #body let-p let-i="rowIndex">
                <tr class="vt-fila" tabindex="0" (click)="abrirPromo(p)" (keydown.enter)="abrirPromo(p)" [attr.aria-label]="'Ver ' + p.nombre">
                  <td class="vt-num vt-tenue">{{ lugarDe(p) }}</td>
                  <td>
                    <span class="vt-nombre">{{ p.nombre }}</span> <span class="vt-codigo">{{ p.code }}</span>
                    <span class="vt-sub">{{ textoProductos(p.productos_metodo, p.productos_nombres) }}{{ p.proveedor ? ' · ' + p.proveedor : '' }}</span>
                  </td>
                  <td class="vt-num vt-fuerte">{{ n0(p.paquetes) }}</td>
                  <td class="vt-num vt-tenue">{{ p.objetivo === null ? '—' : n0(p.objetivo) }}</td>
                  <td><div class="vt-avance"><span class="vt-barra" aria-hidden="true"><span [style.width.%]="barra(p.avance)"></span></span><span class="vt-tenue">{{ pct(p.avance) }}</span></div></td>
                  <td class="vt-num" [class.vt-tenue]="p.dinero === null">{{ dinero(p.dinero) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6" class="vt-tenue">{{ sinCodigosBarras()
                ? 'No se pudieron leer los códigos de barras: busca por nombre, código o producto.'
                : 'Ninguna promoción coincide con «' + busqueda() + '».' }}</td></tr></ng-template>
            </p-table>
          } @else {
            <div class="vt-cab">
              <h2>Lo que se le cargó a cada vendedor <span class="vt-tenue">· {{ textoFiltro() }}</span></h2>
              <span class="vt-tenue">{{ filasVendedores().length }} vendedores · de más a menos paquetes</span>
            </div>
            @if (d.mostrador && d.mostrador.tickets_con_promo > d.mostrador.tickets_asignados) {
              <p class="vt-aviso" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i>
                Sucursales: {{ d.mostrador.tickets_con_promo - d.mostrador.tickets_asignados }} de {{ d.mostrador.tickets_con_promo }} tickets con promoción
                no se le cargaron a nadie (la cajera no los asignó en su arqueo). No se reparten.</p>
            }
            <p-table [value]="filasVendedores()" dataKey="clave" styleClass="p-datatable-sm vt-tabla" [tableStyle]="{ 'min-width': '760px' }">
              <ng-template #header>
                <tr>
                  <th class="vt-num" style="width:3rem">#</th>
                  <th>Vendedor</th>
                  <th style="width:11rem">Canal</th>
                  <th class="vt-num" style="width:7rem">Paquetes</th>
                  <th class="vt-num" style="width:8rem">Promociones</th>
                  <th class="vt-num" style="width:9rem">Total</th>
                </tr>
              </ng-template>
              <ng-template #body let-v>
                <tr class="vt-fila" tabindex="0" (click)="abrirVendedor(v)" (keydown.enter)="abrirVendedor(v)" [attr.aria-label]="'Ver lo que vendió ' + v.nombre">
                  <td class="vt-num vt-tenue">{{ lugarVendedor(v) }}</td>
                  <td><span class="vt-nombre">{{ v.nombre }}</span><span class="vt-sub">{{ v.detalle }}</span></td>
                  <td class="vt-tenue">{{ canalTexto(v.canal) }}</td>
                  <td class="vt-num vt-fuerte">{{ n0(v.paquetes) }}</td>
                  <td class="vt-num">{{ v.promos.length }}</td>
                  <td class="vt-num">{{ dinero(v.total) }}@if (v.promos_sin_dato) {<span class="vt-sub">+ {{ v.promos_sin_dato }} sin dato</span>}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="6" class="vt-tenue">{{ busqueda() ? 'Ningún vendedor coincide con «' + busqueda() + '».' : 'Nadie tiene promociones cargadas con estos filtros.' }}</td></tr>
              </ng-template>
            </p-table>
          }
          <p class="vt-nota">{{ vista() === 'promociones'
            ? 'Cuenta toda la venta, se le haya cargado a un vendedor o no. Dinero: lo que pagó el cliente por los productos de la promoción, con impuestos; «sin dato» = sin producto identificado. Objetivo: el que fija Mercadotecnia o, si no, el promedio de sus 4 semanas anteriores.'
            : 'Sólo cuenta lo que se le cargó a cada uno (la venta completa está en «Ranking de promociones»). Sucursales: lo que la cajera le asignó en su arqueo · Ruta vecinal: quien tiene asignada la ruta · Ruta directa: la camioneta y su chofer · Telemarketing: su clave.' }}</p>
          </div>
        }
      </app-load-state>

      <!-- La promoción: dónde se vendió (canal, sucursal, zona). Sin vendedores: eso es el otro ranking. -->
      <app-side-peek [open]="!!abiertaPromo()" (openChange)="!$event && abiertaPromo.set(null)" [title]="abiertaPromo()?.nombre ?? ''"
                     [subtitle]="abiertaPromo() ? 'Código ' + abiertaPromo()!.code + ' · ' + semanaTexto() : null">
        @if (abiertaPromo(); as p) {
          <app-metric-strip [items]="metricasPromo()" density="compact" ariaLabel="La promoción"></app-metric-strip>
          @if (p.dinero === null) { <p class="vt-aviso" role="note">Sin producto identificado: no se puede saber cuánto pagó el cliente por ella.</p> }
          <p class="vt-sub">{{ textoProductos(p.productos_metodo, p.productos_nombres) }}</p>
          <h3 class="vt-h3">Dónde se vendió</h3>
          <table class="vt-mini">
            <thead><tr><th>Canal</th><th class="vt-num">Paquetes</th><th class="vt-num">Dinero</th><th class="vt-num">Del total</th></tr></thead>
            <tbody>
              @for (c of p.por_canal; track c.canal) {
                <tr><td>{{ canalTexto(c.canal) }}</td><td class="vt-num vt-fuerte">{{ n0(c.paquetes) }}</td><td class="vt-num">{{ dinero(c.dinero) }}</td><td class="vt-num vt-tenue">{{ pct(p.paquetes ? c.paquetes / p.paquetes : null) }}</td></tr>
              }
            </tbody>
          </table>
          <div class="vt-cab vt-cab--peek">
            <h3 class="vt-h3">En qué {{ desglose() === 'sucursal' ? 'sucursales' : 'zonas' }} se movió</h3>
            <app-segmented [options]="opcionesDesglose" [value]="desglose()" (valueChange)="desglose.set($any($event))" ariaLabel="Ver por"></app-segmented>
          </div>
          <table class="vt-mini">
            <thead><tr><th>{{ desglose() === 'sucursal' ? 'Sucursal' : 'Zona' }}</th>@if (desglose() === 'sucursal') {<th>Zona</th>}<th class="vt-num">Paquetes</th><th class="vt-num">Objetivo</th><th class="vt-num">Dinero</th></tr></thead>
            <tbody>
              @for (s of filasDesglose(); track s.clave) {
                <tr><td>{{ s.nombre }}</td>@if (desglose() === 'sucursal') {<td class="vt-tenue">{{ s.zona }}</td>}<td class="vt-num vt-fuerte">{{ n0(s.paquetes) }}</td>
                  <td class="vt-num vt-tenue">{{ s.objetivo === null ? '—' : n0(s.objetivo) }}</td><td class="vt-num">{{ dinero(s.dinero) }}</td></tr>
              }
            </tbody>
          </table>
        }
      </app-side-peek>

      <!-- El vendedor: lo que se le cargó, con precio por paquete y total. -->
      <app-side-peek [open]="!!abiertoVendedor()" (openChange)="!$event && abiertoVendedor.set(null)" [title]="abiertoVendedor()?.nombre ?? ''"
                     [subtitle]="abiertoVendedor() ? canalTexto(abiertoVendedor()!.canal) + ' · ' + abiertoVendedor()!.detalle : null">
        @if (abiertoVendedor(); as v) {
          <app-metric-strip [items]="metricasVendedor()" density="compact" ariaLabel="El vendedor"></app-metric-strip>
          @if (v.canal === 'mostrador') {
            <p class="vt-aviso" role="note">Se lo asignó la cajera en su arqueo: {{ v.tickets }} {{ v.tickets === 1 ? 'ticket' : 'tickets' }}.
              @if (datos()?.mostrador; as m) { En Sucursales, {{ m.tickets_asignados }} de {{ m.tickets_con_promo }} tickets con promoción están asignados. }</p>
          }
          <h3 class="vt-h3">Lo que vendió</h3>
          <table class="vt-mini">
            <thead><tr><th>Promoción</th><th class="vt-num">Paquetes</th><th class="vt-num">Precio</th><th class="vt-num">Total</th></tr></thead>
            <tbody>
              @for (x of v.promos; track x.code) {
                <tr><td><span class="vt-nombre">{{ x.nombre }}</span> <span class="vt-codigo">{{ x.code }}</span></td><td class="vt-num vt-fuerte">{{ n0(x.paquetes) }}</td>
                  <td class="vt-num vt-tenue">{{ dinero(x.precio) }}</td><td class="vt-num">{{ dinero(x.total) }}</td></tr>
              }
              <tr class="vt-total"><th scope="row">Total</th><td class="vt-num">{{ n0(v.paquetes) }}</td><td></td><td class="vt-num">{{ dinero(v.total) }}</td></tr>
            </tbody>
          </table>
          <p class="vt-nota">Precio: lo que pagó el cliente por un paquete de la promoción, en promedio. Total = lo que pagó por sus productos.
            @if (v.promos_sin_dato) { {{ v.promos_sin_dato }} {{ v.promos_sin_dato === 1 ? 'promoción no tiene' : 'promociones no tienen' }} producto identificado: su dinero no entra al total. }</p>
        }
      </app-side-peek>

      <!-- Objetivos: se cambian todos en un solo lugar (paquetes por sucursal a la semana, en Sucursales). -->
      <app-side-peek [open]="objetivosAbierto()" (openChange)="objetivosAbierto.set($event)" title="Objetivos"
                     subtitle="Paquetes por sucursal, a la semana · Sucursales">
        <input pInputText type="search" class="vt-buscar" [ngModel]="buscaObjetivo()" (ngModelChange)="buscaObjetivo.set($event)"
               placeholder="Buscar promoción o código" aria-label="Buscar promoción en objetivos" />
        <table class="vt-mini">
          <thead><tr><th>Promoción</th><th class="vt-num">Automático</th><th class="vt-num">Objetivo</th></tr></thead>
          <tbody>
            @for (p of filasObjetivo(); track p.promo_id) {
              <tr>
                <td><span class="vt-nombre">{{ p.nombre }}</span> <span class="vt-codigo">{{ p.code }}</span>
                  @if (p.objetivo_sucursal.mixto) { <span class="vt-sub">Tiene objetivos distintos por sucursal: <a routerLink="/mkt/ranking/promociones">cambiar por sucursal</a></span> }
                  @if (!p.objetivo_sucursal.sucursales.length) { <span class="vt-sub">No se vende en Sucursales</span> }
                </td>
                <td class="vt-num vt-tenue">{{ p.objetivo_sucursal.automatico ?? '—' }}</td>
                <td class="vt-num">
                  <input pInputText type="text" inputmode="numeric" class="vt-obj" [class.vt-obj--cambio]="cambios().has(p.promo_id)"
                         [ngModel]="valorObjetivo(p)" (ngModelChange)="editarObjetivo(p, $event)"
                         [disabled]="!puedeGestionar || !p.objetivo_sucursal.sucursales.length || p.objetivo_sucursal.mixto"
                         [placeholder]="p.objetivo_sucursal.mixto ? 'varios' : 'auto'" [attr.aria-label]="'Objetivo por sucursal de ' + p.nombre" />
                </td>
              </tr>
            }
          </tbody>
        </table>
        <p class="vt-nota">Vacío = automático: el promedio de sus 4 semanas anteriores. Lo que escribas queda fijo en todas sus sucursales hasta que lo cambies o lo borres.
          Los de rutas, telemarketing o una sola sucursal: <a routerLink="/mkt/ranking/promociones">Objetivos por sucursal</a>.</p>
        @if (!puedeGestionar) { <p class="vt-aviso" role="note">Puedes verlos; para cambiarlos hace falta permiso de Mercadotecnia.</p> }
        <div class="vt-pie">
          <span class="vt-tenue" role="status">{{ cambios().size ? cambios().size + (cambios().size === 1 ? ' cambio sin guardar' : ' cambios sin guardar') : '' }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cancelarObjetivos()" [disabled]="!cambios().size || guardando()">
            <span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" class="p-button-sm" (click)="guardarObjetivos()" [disabled]="!cambios().size || guardando() || !puedeGestionar" [loading]="guardando()">
            <span class="p-button-label">Guardar</span></button>
        </div>
      </app-side-peek>
    </div>
  `,
  styles: [`
    .vt { display: flex; flex-direction: column; gap: var(--sp-3, 12px); container-type: inline-size; }
    /* Angosto (sidebar abierto o celular): los filtros y las acciones se apilan; la tabla se desplaza dentro de su marco. */
    @container (max-width: 720px) {
      .vt-filtros { flex-direction: column; align-items: stretch; }
      .vt-acciones { width: 100%; justify-content: flex-end; }
    }
    .vt-semana { display: flex; align-items: center; gap: 2px; margin-top: 4px; }
    .vt-semana-btn { display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: 14px; font-weight: 600; color: var(--fg-1); background: var(--surface-0, #fff);
      border: 1px solid var(--border, #E4E4E7); border-radius: 8px; padding: 6px 12px; cursor: pointer; min-height: 34px; }
    .vt-semana-btn:focus-visible, .vt-fila:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .vt-pista { margin: 6px 0 0; font-size: 12px; color: var(--fg-2); }
    .vt-acciones { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .vt-filtros { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .vt-buscar { flex: 1 1 320px; min-width: 0; }
    .vt-cab { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .vt-cab h2 { margin: 0; font-size: 15px; font-weight: 700; }
    .vt-cab--peek { margin-top: 12px; align-items: center; }
    .vt-h3 { margin: 12px 0 6px; font-size: 14px; font-weight: 700; }
    .vt-tenue { color: var(--fg-2); font-weight: 500; }
    .vt-fuerte { font-weight: 700; }
    .vt-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .vt-nombre { font-weight: 600; }
    .vt-codigo { font-family: var(--font-mono, 'Geist Mono', monospace); font-size: 12px; color: var(--fg-3, #6B6B74); }
    .vt-sub { display: block; font-size: 12px; color: var(--fg-3, #6B6B74); font-weight: 400; }
    .vt-fila { cursor: pointer; }
    .vt-avance { display: flex; align-items: center; gap: 8px; }
    .vt-barra { flex: 1; height: 6px; border-radius: 999px; background: var(--border, #E4E4E7); overflow: hidden; }
    .vt-barra > span { display: block; height: 100%; background: var(--action); }
    .vt-aviso { margin: 0; display: flex; gap: 8px; align-items: baseline; font-size: 13px; color: var(--fg-2); background: var(--surface-1, #FAFAFA);
      border: 1px solid var(--border, #E4E4E7); border-radius: 8px; padding: 8px 12px; }
    .vt-nota { margin: 4px 0 0; font-size: 12px; color: var(--fg-3, #6B6B74); line-height: 1.5; }
    .vt-atenuado { opacity: .6; transition: opacity .15s; }
    .vt-mini { width: 100%; border-collapse: collapse; font-size: 14px; }
    .vt-mini th { text-align: left; font-size: 12px; font-weight: 600; color: var(--fg-2); padding: 8px 6px; border-bottom: 1px solid var(--border, #E4E4E7); }
    .vt-mini td { padding: 8px 6px; border-bottom: 1px solid var(--surface-2, #F4F4F5); vertical-align: top; }
    .vt-mini th.vt-num { text-align: right; }
    .vt-total th, .vt-total td { font-weight: 700; border-bottom: 0; }
    .vt-obj { width: 76px; text-align: right; }
    .vt-obj--cambio { border-color: var(--action); font-weight: 700; }
    .vt-pie { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border, #E4E4E7); }
    .vt-pie > span { margin-right: auto; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class MktRankingComponent {
  private readonly api = inject(MktRankingService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  readonly tabs = PROMOS_TABS;
  readonly pct = pct;
  readonly n0 = n0;
  readonly dinero = dinero;
  readonly textoProductos = textoProductos;
  readonly todos = TODOS;
  readonly puedeGestionar = this.perms.has(Permission.MKT_AGREEMENTS_GESTIONAR);

  /** NULL = la última semana (la decide el servidor). */
  readonly semana = signal<string | null>(null);
  readonly vista = signal<Vista>('promociones');
  readonly canal = signal<Canal | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly zona = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly abiertaPromo = signal<PromoVenta | null>(null);
  readonly abiertoVendedor = signal<VendedorVenta | null>(null);
  readonly desglose = signal<'sucursal' | 'zona'>('sucursal');
  readonly objetivosAbierto = signal(false);
  readonly buscaObjetivo = signal('');
  /** Lo tecleado en «Objetivos» sin guardar: promo → texto ('' = volver al automático). */
  readonly cambios = signal(new Map<string, string>());
  readonly guardando = signal(false);
  readonly generando = signal(false);

  readonly opcionesVista: SegOption[] = [
    { label: 'Ranking de promociones', value: 'promociones' },
    { label: 'Ranking de vendedores', value: 'vendedores' },
  ];
  readonly opcionesCanal: SegOption[] = [{ label: 'Todos', value: TODOS }, ...CANALES.map((c) => ({ label: CANAL_VENTA[c], value: c }))];
  readonly opcionesDesglose: SegOption[] = [{ label: 'Sucursal', value: 'sucursal' }, { label: 'Zona', value: 'zona' }];

  readonly res = rxResource({
    params: () => ({ semana: this.semana(), canal: this.canal(), sucursal: this.sucursal(), zona: this.zona() }),
    stream: ({ params }) => this.api.venta(params.semana, { canal: params.canal, sucursal: params.sucursal, zona: params.zona }),
  });
  /** Lo último que llegó: al cambiar un filtro se queda lo anterior atenuado; si la carga FALLA, se suelta. */
  readonly datos = linkedSignal<{ v: VentaSemana | undefined; cargando: boolean }, VentaSemana | undefined>({
    source: () => ({ v: this.res.hasValue() ? this.res.value() : undefined, cargando: this.res.isLoading() }),
    computation: (s, prev) => s.v ?? (s.cargando ? prev?.value : undefined),
  });
  readonly actualizando = computed(() => this.res.isLoading() && !!this.datos());
  readonly error = computed(() => (this.res.error() ? 'No se pudieron cargar las promociones. Revisa tu conexión y vuelve a intentar.' : null));

  readonly semanaTexto = computed(() => { const d = this.datos(); return d ? textoSemana(d.semana) : ''; });
  readonly opcionesSucursal = computed(() => (this.datos()?.sucursales_lista ?? []).map((s) => ({ value: s.code, label: `${s.nombre} (${s.code})` })));
  readonly opcionesZona = computed(() => (this.datos()?.zonas_lista ?? []).map((z) => ({ value: z, label: z })));

  readonly filasPromos = computed(() => {
    const q = this.busqueda();
    const d = this.datos();
    return (d?.promos ?? []).filter((p) => coincidePromoVenta(q, p, d?.codigos_barras ?? null));
  });
  /** [MKT.27] Si no se pudieron leer los códigos de barras y lo buscado parece uno, se dice (no es «ninguna coincide»). */
  readonly sinCodigosBarras = computed(() => this.datos()?.codigos_barras === null && /^\d{8,14}$/.test(this.busqueda().trim()));
  readonly filasVendedores = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.vendedores ?? []).filter((v) => coincideBusqueda(q, v.nombre, v.detalle, v.warehouse_name, v.vendedor));
  });
  /** El lugar es el de la lista completa: buscar no renumera (el 5.º sigue siendo el 5.º). */
  lugarDe(p: PromoVenta): number { return (this.datos()?.promos.indexOf(p) ?? -1) + 1; }
  lugarVendedor(v: VendedorVenta): number { return (this.datos()?.vendedores.indexOf(v) ?? -1) + 1; }

  readonly sinContrastar = computed(() => { const d = this.datos(); return d ? canalesSinContrastar(d, this.canal()) : []; });
  readonly textoSinContrastar = computed(() => this.sinContrastar().map((c) => CANAL_VENTA[c]).join(', '));

  readonly metricas = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const top = d.promos[0];
    const suc = d.sucursal_top;
    const sinDato = d.totales.promos_sin_dato;
    return [
      { label: 'Paquetes', value: d.totales.paquetes, format: 'number', sub: d.totales.objetivo === null ? 'sin objetivo' : `de ${n0(d.totales.objetivo)} de objetivo` },
      {
        label: 'Dinero', value: d.totales.dinero, format: 'currency',
        sub: sinDato ? `al menos · ${sinDato} ${sinDato === 1 ? 'promoción' : 'promociones'} sin dato` : 'lo que pagó el cliente',
        ...(this.sinContrastar().length ? { state: 'parcial' as const, stateNote: `Sin contrastar contra Kepler: ${this.textoSinContrastar()}` } : {}),
      },
      { label: 'La más vendida', value: top ? top.nombre : '—', format: 'text', sub: top ? `${n0(top.paquetes)} paquetes` : undefined },
      { label: 'Sucursal que más vendió', value: suc ? suc.nombre : '—', format: 'text', sub: suc ? `${suc.zona} · ${n0(suc.paquetes)} paquetes` : undefined },
    ];
  });
  readonly metricasPromo = computed<MetricStripItem[]>(() => {
    const p = this.abiertaPromo();
    if (!p) return [];
    return [
      { label: 'Paquetes', value: p.paquetes, format: 'number', sub: p.objetivo === null ? 'sin objetivo' : `de ${n0(p.objetivo)} · ${pct(p.avance)}` },
      { label: 'Dinero', value: p.dinero === null ? 'sin dato' : p.dinero, format: p.dinero === null ? 'text' : 'currency2' },
      { label: 'Lugar', value: `#${this.lugarDe(p)} de ${this.datos()?.promos.length ?? 0}`, format: 'text' },
    ];
  });
  readonly metricasVendedor = computed<MetricStripItem[]>(() => {
    const v = this.abiertoVendedor();
    if (!v) return [];
    return [
      { label: 'Total', value: v.total, format: 'currency2' },
      { label: 'Paquetes', value: v.paquetes, format: 'number' },
      { label: 'Promociones', value: v.promos.length, format: 'number' },
    ];
  });

  /** «En qué sucursales/zonas se movió»: por zona se SUMAN sus sucursales (el dinero sin dato sigue sin dato). */
  readonly filasDesglose = computed(() => {
    const p = this.abiertaPromo();
    if (!p) return [];
    if (this.desglose() === 'sucursal') return p.por_sucursal.map((s) => ({ clave: s.warehouse_code, ...s }));
    const z = new Map<string, { clave: string; nombre: string; zona: string; paquetes: number; objetivo: number | null; dinero: number | null }>();
    for (const s of p.por_sucursal) {
      const a = z.get(s.zona) ?? { clave: s.zona, nombre: s.zona, zona: s.zona, paquetes: 0, objetivo: null, dinero: s.dinero === null ? null : 0 };
      a.paquetes += s.paquetes;
      if (s.objetivo !== null) a.objetivo = (a.objetivo ?? 0) + s.objetivo;
      if (a.dinero !== null && s.dinero !== null) a.dinero = Math.round((a.dinero + s.dinero) * 100) / 100;
      z.set(s.zona, a);
    }
    return [...z.values()].sort((a, b) => b.paquetes - a.paquetes || a.nombre.localeCompare(b.nombre, 'es'));
  });

  readonly filasObjetivo = computed(() => {
    const q = this.buscaObjetivo();
    return (this.datos()?.promos ?? []).filter((p) => coincideBusqueda(q, p.nombre, p.code));
  });

  canalTexto(c: Canal): string { return CANAL_VENTA[c]; }
  barra(avance: number | null): number { return avance === null ? 0 : Math.min(100, Math.round(avance * 100)); }

  readonly textoFiltro = computed(() => this.filtrosEnPalabras().join(' · ') || 'todas las sucursales y canales');
  private filtrosEnPalabras(): string[] {
    const d = this.datos();
    const out: string[] = [];
    if (this.canal()) out.push(CANAL_VENTA[this.canal()!]);
    if (this.sucursal()) out.push(d?.sucursales_lista.find((s) => s.code === this.sucursal())?.nombre ?? `Sucursal ${this.sucursal()}`);
    if (this.zona()) out.push(`Zona ${this.zona()}`);
    if (this.busqueda().trim()) out.push(`Búsqueda «${this.busqueda().trim()}»`);
    return out;
  }

  // ── navegación ──
  elegirVista(v: string): void { this.cerrarDetalles(); this.vista.set(v === 'vendedores' ? 'vendedores' : 'promociones'); }
  elegirCanal(v: string): void { this.cerrarDetalles(); this.canal.set(v === TODOS ? null : (v as Canal)); }
  elegirSucursal(v: string | null): void { this.cerrarDetalles(); this.sucursal.set(v || null); }
  elegirZona(v: string | null): void { this.cerrarDetalles(); this.zona.set(v || null); }
  abrirPromo(p: PromoVenta): void { this.abiertoVendedor.set(null); this.desglose.set('sucursal'); this.abiertaPromo.set(p); }
  abrirVendedor(v: VendedorVenta): void { this.abiertaPromo.set(null); this.abiertoVendedor.set(v); }
  private cerrarDetalles(): void { this.abiertaPromo.set(null); this.abiertoVendedor.set(null); }

  /** Hoy: el calendario no ofrece semanas futuras (no hay venta que medir). */
  readonly hoy = new Date();
  readonly lunesFecha = computed(() => {
    const l = this.datos()?.semana.lunes;
    if (!l) return null;
    const [y, m, d] = l.split('-').map(Number);
    return new Date(y, m - 1, d);
  });
  /** Un día cualquiera del calendario abre SU semana (ISO, lunes a domingo). */
  elegirDia(dia: Date): void {
    const l = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate());
    l.setDate(l.getDate() - ((l.getDay() + 6) % 7));
    const p2 = (n: number) => String(n).padStart(2, '0');
    this.cerrarDetalles();
    this.semana.set(l.getFullYear() + '-' + p2(l.getMonth() + 1) + '-' + p2(l.getDate()));
  }
  cambiarSemana(delta: number): void {
    const d = this.datos();
    if (!d) return;
    this.cerrarDetalles();
    this.semana.set(moverSemana(d.semana.lunes, delta));
  }

  // ── objetivos ──
  valorObjetivo(p: PromoVenta): string {
    const c = this.cambios();
    if (c.has(p.promo_id)) return c.get(p.promo_id)!;
    return p.objetivo_sucursal.fijo === null ? '' : String(p.objetivo_sucursal.fijo);
  }
  editarObjetivo(p: PromoVenta, texto: string): void {
    const limpio = String(texto ?? '').replace(/[^\d.]/g, '');
    const original = p.objetivo_sucursal.fijo === null ? '' : String(p.objetivo_sucursal.fijo);
    const m = new Map(this.cambios());
    if (limpio === original) m.delete(p.promo_id); else m.set(p.promo_id, limpio);
    this.cambios.set(m);
  }
  cancelarObjetivos(): void { this.cambios.set(new Map()); }

  /**
   * Guarda con el endpoint de siempre (`PUT promos/:id/objetivos`, probado contra base real en `[MKT.23]`):
   * el mismo valor en cada sucursal donde se vende en mostrador; vacío = se borra el fijo y vuelve el automático.
   */
  async guardarObjetivos(): Promise<void> {
    const d = this.datos();
    if (!d || !this.cambios().size || this.guardando()) return;
    const llamadas = [...this.cambios().entries()].flatMap(([id, texto]) => {
      const p = d.promos.find((x) => x.promo_id === id);
      if (!p || !p.objetivo_sucursal.sucursales.length) return [];
      const v = texto.trim() === '' ? null : Number(texto);
      if (v !== null && !(v > 0)) return [];
      return [this.api.guardarObjetivos(id, p.objetivo_sucursal.sucursales.map((w) => ({ warehouse_code: w, canal: 'mostrador' as const, vendor_code: '', objetivo_semanal: v })))];
    });
    if (!llamadas.length) { this.cambios.set(new Map()); return; }
    this.guardando.set(true);
    try {
      await firstValueFrom(forkJoin(llamadas));
      this.toast.add({ severity: 'success', summary: 'Objetivos guardados', detail: `${llamadas.length} ${llamadas.length === 1 ? 'promoción' : 'promociones'}` });
      this.cambios.set(new Map());
      this.res.reload();
    } catch {
      this.toast.add({ severity: 'error', summary: 'No se guardaron los objetivos', detail: 'Lo que escribiste sigue aquí. Intenta de nuevo.' });
    } finally {
      this.guardando.set(false);
    }
  }

  // ── PDF de lo que se ve ──
  async pdf(): Promise<void> {
    const d = this.datos();
    if (!d || this.generando() || this.actualizando()) return;
    const vista = this.vista();
    const datos: VentaSemana = { ...d, promos: this.filasPromos(), vendedores: this.filasVendedores() };
    if (vista === 'promociones' ? !datos.promos.length : !datos.vendedores.length) {
      this.toast.add({ severity: 'info', summary: 'Nada que reportar', detail: 'Ningún renglón coincide con tus filtros.' });
      return;
    }
    this.generando.set(true);
    const win = abrirPestanaParaPdf('Preparando el reporte…');
    try {
      const { blob, archivo } = await pdfVenta({ datos, vista, filtros: this.filtrosEnPalabras(), elaboro: this.auth.user()?.username ?? 'Mercadotecnia' });
      const donde = entregarPdf(win, blob, archivo);
      if (donde === 'descarga') this.toast.add({ severity: 'success', summary: 'Reporte descargado', detail: archivo });
    } catch {
      cerrarPestanaDePdf(win);
      this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF', detail: 'Intenta de nuevo.' });
    } finally {
      this.generando.set(false);
    }
  }
}
