import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  diaCorto, etiquetasDelRenglon, fechaKepler, warehouseName,
  type BoxLabelLine, type BoxLabelOrder, type BoxLabelOrderEstado, type BoxLabelOrdersResponse, type EtiquetaCaja,
} from '@megadulces/contracts';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { EtiquetasCajaService } from '../etiquetas-caja.service';
import { documentoVistaPrevia, imprimirEtiquetasCaja, leerConsecutivos, rangoMx } from '../etiquetas-caja-impresion';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

type Vista = 'pendientes' | 'enviadas' | 'todas';
type Rango = '1' | '7' | '30';

const ESTADO: Record<BoxLabelOrderEstado, { texto: string; sev: 'warn' | 'info' | 'success' }> = {
  por_etiquetar: { texto: 'Por etiquetar', sev: 'warn' },
  parcial: { texto: 'Faltan etiquetas', sev: 'info' },
  enviada: { texto: 'Enviada', sev: 'success' },
};

const llave = (o: { sucursal: string; serie: number; folio: string }) => `${o.sucursal}|${o.serie}|${o.folio}`;

/**
 * `[RE.ETQ.3.1–3.3]` **Etiquetas de caja** — la cola de órdenes de entrada de Kepler para imprimir en la TSC TE200
 * la etiqueta de cada caja recibida (Fase RE, D1). Reemplaza «Imprimir Etiquetas» de Kepler, cuya barra no se lee.
 *
 * Los 12 pasos de la skill `diseno` §0a, por escrito:
 *  1. Propósito: «¿qué cajas que recibí faltan por etiquetar?» — el acto es IMPRIMIR las etiquetas de una orden.
 *  2. Quién: encargado de tienda, almacenista, encargado de bodega y supervisor (ALMACEN_ETIQUETAS_CAJA), en la PC
 *     que tiene la TSC, justo después de capturar la orden de entrada en Kepler. Pantalla nueva: sin uso que medir.
 *  3. Estado real (prod, 2026-11-19): 0 de 87,070 cajas al mes se etiquetan desde la Suite; Suc 08 captura ~7
 *     órdenes al día y la orden aparece en el ODS a los 3 minutos.
 *  4. Nivel 0: lo pendiente primero, la orden más reciente arriba, y «Imprimir» en la fila (un clic por orden).
 *  5. No se ve: el renglón en piezas (no lleva etiqueta), los datos del catálogo (van a su pestaña) y los avisos
 *     en la fila (sólo su conteo; el texto, en el detalle).
 *  6. Desglose: la franja filtra la cola; la fila abre el detalle con sus renglones, avisos, vista previa y
 *     reimpresión (los da GET orders); «con avisos del catálogo» lleva a la pestaña Catálogo de Kepler.
 *  7. Acceso: buscar por folio, vale, clave o nombre; teclado en la tabla; la sucursal por nombre.
 *  8. Ligas: el folio del vale de entrada (la llegada) va en la fila y en el detalle, con su fecha.
 *  9. Le toca: sí, es recepción. La lista de defectos del catálogo es de Compras: va aparte.
 * 12. No resuelve: la impresión física no está probada en la TSC real (RE.ETQ.3.5) y la vía B (TSPL) no se
 *     ofrece hasta medir la impresora (RE.ETQ.0.3). Se dice en pantalla.
 *
 * Jerarquía: primario = las órdenes por etiquetar y su botón; secundario = cuántas etiquetas y su estado;
 * terciario = vale, hora de captura y avisos.
 */
@Component({
  selector: 'app-almacen-etiquetas',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, TagModule, ButtonModule, SelectModule, InputTextModule, ToastModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="surf-page in">
      <header class="surf-page-head et-head">
        <div class="et-head-txt">
          <h1>Etiquetas de caja <app-context-help topic="almacen-etiquetas-caja" /></h1>
          <p class="et-sub">Las órdenes de entrada que capturas en Kepler aparecen aquí solas. Imprime la etiqueta de cada caja en la TSC.</p>
        </div>
        <div class="et-head-acc">
          @if (resp(); as r) {
            <app-freshness-pill measures="data" [since]="r.ods_ultima_captura" label="Última orden en Kepler" [staleAfterSec]="14400"></app-freshness-pill>
          }
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="cargando()" (click)="recargar()" aria-label="Actualizar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      @if (resp()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Etiquetas de caja"></app-metric-strip>
        @if (conAvisos() > 0) {
          <a class="et-link" routerLink="/almacen/etiquetas/catalogo">Ver qué tiene mal el catálogo de Kepler en lo recibido <i class="pi pi-arrow-right" aria-hidden="true"></i></a>
        }
      }

      <div class="et-filtros">
        <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Qué órdenes ver"></app-segmented>
        <p-select [options]="rangos" optionLabel="label" optionValue="value" [ngModel]="rango()" (ngModelChange)="elegirRango($event)"
                  appendTo="body" inputId="et-rango" ariaLabel="Periodo" class="et-sel"></p-select>
        @if (sucursales().length > 1) {
          <p-select [options]="sucursales()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (ngModelChange)="sucursal.set($event)"
                    [showClear]="true" placeholder="Todas las sucursales" appendTo="body" inputId="et-suc" ariaLabel="Sucursal" class="et-sel"></p-select>
        }
        <input pInputText type="search" class="et-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Folio, vale, clave o producto" aria-label="Buscar orden" enterkeyhint="search" autocomplete="off" />
      </div>

      <app-load-state class="dt-scope" [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="!!resp() && !visibles().length"
                      emptyIcon="pi-check-circle" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="recargar()">
        <p-table [value]="visibles()" selectionMode="single" [dataKey]="'llave'" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Orden de entrada</th>
              <th>Capturada</th>
              <th>Productos</th>
              <th class="comm-num">Etiquetas</th>
              <th>Estado</th>
              <th><span class="et-oculto">Acción</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr [pSelectableRow]="f">
              <td class="dt-id" data-label="Orden" role="cell">
                <span class="et-folio">{{ f.o.folio }}</span>
                @if (f.o.vale_folio) { <span class="et-ter">Vale {{ f.o.vale_folio }}</span> }
                @if (variasSucursales()) { <span class="et-ter">{{ nombreSucursal(f.o.sucursal) }}</span> }
              </td>
              <td data-label="Capturada" role="cell">
                <span>{{ dia(f.o.capturada_el) }} {{ f.o.capturada_hora ?? '' }}</span>
                @if (f.atraso > 0) { <span class="et-ter">llegó el {{ dia(f.o.vale_capturado_el) }} · {{ f.atraso }} {{ f.atraso === 1 ? 'día' : 'días' }} antes</span> }
              </td>
              <td data-label="Productos" role="cell">
                <span class="et-prod">{{ f.o.renglones[0]?.nombre || f.o.renglones[0]?.sku }}</span>
                @if (f.o.renglones.length > 1) { <span class="et-ter">y {{ f.o.renglones.length - 1 }} más</span> }
                @if (f.avisos) { <span class="et-aviso"><i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ f.avisos }} {{ f.avisos === 1 ? 'aviso' : 'avisos' }}</span> }
              </td>
              <td class="comm-num dt-num" data-label="Etiquetas" role="cell">
                <span class="et-num">{{ f.o.etiquetas_enviadas }}</span> <span class="et-ter">de {{ f.o.etiquetas_total }}</span>
              </td>
              <td data-label="Estado" role="cell"><p-tag [value]="estado(f.o.estado).texto" [severity]="estado(f.o.estado).sev"></p-tag></td>
              <td class="dt-actions" data-label="Acción" role="cell">
                @if (f.pendientes > 0) {
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="enviando()"
                          (click)="$event.stopPropagation(); imprimirPendientes(f.o)"
                          [attr.aria-label]="'Imprimir ' + f.pendientes + ' etiquetas de la orden ' + f.o.folio">
                    <span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">Imprimir {{ f.pendientes }}</span>
                  </button>
                } @else {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="$event.stopPropagation(); abrir(f)"
                          [attr.aria-label]="'Ver la orden ' + f.o.folio"><span class="p-button-label">Ver</span></button>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
      <p class="et-nota">«Enviada» quiere decir que se mandó a la impresora: si la impresión se canceló o salió mal, reimprímela desde la orden. Se imprime por el controlador de Windows de la TSC (hoja de 100 × 48 mm).</p>
    </div>

    <app-side-peek [open]="!!abierta()" (openChange)="$event ? null : abiertaKey.set(null)" [width]="720"
                   [title]="abierta() ? 'Orden de entrada ' + abierta()!.folio : ''" [subtitle]="subtitulo()">
      @if (abierta(); as o) {
        <section class="et-peek" aria-labelledby="et-ren-h">
          <h3 id="et-ren-h" class="et-peek-h">Productos en caja</h3>
          <p-table [value]="o.renglones" [selection]="seleccion()" (selectionChange)="seleccion.set($event)" [dataKey]="'linea'" size="small" class="surf-table surf-table--plain dt-stack">
            <ng-template #header>
              <tr>
                <th class="et-chk"><p-table-header-checkbox ariaLabel="Elegir todos"></p-table-header-checkbox></th>
                <th>Producto</th>
                <th class="comm-num">Cajas</th>
                <th class="comm-num">Etiquetas</th>
              </tr>
            </ng-template>
            <ng-template #body let-l>
              <tr>
                <td class="et-chk" role="cell"><p-table-checkbox [value]="l" [ariaLabel]="'Elegir ' + (l.nombre || l.sku)"></p-table-checkbox></td>
                <td data-label="Producto" role="cell">
                  <span class="et-prod">{{ l.nombre || l.sku }}</span>
                  <span class="et-ter">{{ l.sku }} · {{ l.codigo }}</span>
                  @for (a of l.avisos; track a.tipo) { <span class="et-aviso-txt"><i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ a.texto }}</span> }
                  @if (l.primera) {
                    <span class="et-ter">Primera vez: {{ diaHora(l.primera.enviada_at) }}{{ l.primera.usuario ? ' por ' + l.primera.usuario : '' }} · fecha impresa {{ l.primera.fecha_etiqueta }}{{ l.reimpresiones ? ' · ' + l.reimpresiones + (l.reimpresiones === 1 ? ' reimpresión' : ' reimpresiones') : '' }}</span>
                    <div class="et-reimp">
                      <label class="et-oculto" [attr.for]="'et-re-' + l.linea">Etiquetas a reimprimir de {{ l.sku }}</label>
                      <input pInputText [id]="'et-re-' + l.linea" class="et-re-in" inputmode="numeric" autocomplete="off"
                             [placeholder]="'Ej. 7 o 3-5 (de ' + l.total_etiquetas + ')'" [ngModel]="reimp()[l.linea] ?? ''"
                             (ngModelChange)="escribirReimp(l.linea, $event)" (keydown.enter)="reimprimir(o, l)" />
                      <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="enviando()" (click)="reimprimir(o, l)">
                        <span class="p-button-label">Reimprimir</span>
                      </button>
                    </div>
                    @if (errReimp()[l.linea]; as e) { <span class="et-err" role="alert">{{ e }}</span> }
                  }
                </td>
                <td class="comm-num dt-num" data-label="Cajas" role="cell">
                  <span class="et-num">{{ l.cajas_completas }}</span> <span class="et-ter">× {{ l.uxc ?? '?' }} {{ l.unidad_base }}</span>
                  @if (l.piezas_sueltas > 0) { <span class="et-ter">+ {{ l.piezas_sueltas }} {{ l.unidad_base }} sueltas</span> }
                </td>
                <td class="comm-num dt-num" data-label="Etiquetas" role="cell">
                  <span class="et-num">{{ l.enviadas }}</span> <span class="et-ter">de {{ l.total_etiquetas }}</span>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </section>

        <section class="et-peek" aria-labelledby="et-prev-h">
          <h3 id="et-prev-h" class="et-peek-h">Vista previa a tamaño real</h3>
          @if (vistaPrevia(); as vp) {
            <iframe class="et-prev" [srcdoc]="vp" title="Vista previa de la primera fila de etiquetas" tabindex="-1"></iframe>
            <p class="et-ter">{{ notaPrevia() }}</p>
          } @else {
            <p class="et-ter">Elige un producto con etiquetas pendientes para verlas.</p>
          }
        </section>

        <div class="et-peek-acc">
          <button pButton type="button" class="p-button-sm" [disabled]="enviando() || !pendientesSeleccion()" (click)="imprimirSeleccion(o)">
            <span class="p-button-icon pi pi-print" aria-hidden="true"></span>
            <span class="p-button-label">{{ pendientesSeleccion() ? 'Imprimir ' + pendientesSeleccion() + ' ' + (pendientesSeleccion() === 1 ? 'etiqueta' : 'etiquetas') : 'Nada pendiente en lo elegido' }}</span>
          </button>
        </div>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; }
    .et-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .et-head-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .et-sub { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .et-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-4) 0 var(--sp-3); }
    .et-buscar { flex: 1 1 14rem; min-width: 0; }
    .et-folio { display: block; font-weight: 600; font-variant-numeric: tabular-nums; }
    .et-prod { display: block; }
    .et-num { font-weight: 600; font-variant-numeric: tabular-nums; }
    .et-ter { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .et-aviso { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--warn-fg); font-size: var(--fs-xs); }
    .et-aviso-txt { display: flex; gap: var(--sp-1); color: var(--warn-fg); font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .et-nota { color: var(--text-muted); font-size: var(--fs-xs); margin-top: var(--sp-3); }
    .et-link { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); margin-top: var(--sp-2); }
    .et-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .et-peek { margin-bottom: var(--sp-5); }
    .et-peek-h { font-size: var(--fs-sm); font-weight: 600; margin: 0 0 var(--sp-2); }
    .et-chk { width: 2.5rem; }
    .et-reimp { display: flex; gap: var(--sp-2); align-items: center; margin-top: var(--sp-2); }
    .et-re-in { width: 12rem; max-width: 100%; }
    .et-err { display: block; color: var(--bad-fg); font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .et-prev { box-sizing: content-box; width: 100mm; height: 48mm; max-width: 100%; border: 1px solid var(--border-color); background: white; display: block; }
    .et-peek-acc { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
  `],
})
export class AlmacenEtiquetasComponent implements OnInit {
  private readonly api = inject(EtiquetasCajaService);
  private readonly toast = inject(MessageService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  readonly rangos: { label: string; value: Rango }[] = [
    { label: 'Hoy', value: '1' },
    { label: 'Últimos 7 días', value: '7' },
    { label: 'Últimos 30 días', value: '30' },
  ];
  readonly fechaHoy = fechaKepler(new Date()) ?? '';

  readonly resp = signal<BoxLabelOrdersResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly vista = signal<Vista>('pendientes');
  readonly rango = signal<Rango>('7');
  readonly sucursal = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly abiertaKey = signal<string | null>(null);
  readonly enviando = signal(false);
  readonly reimp = signal<Record<number, string>>({});
  readonly errReimp = signal<Record<number, string>>({});
  /** Los renglones elegidos en el detalle (por defecto, los que tienen etiquetas pendientes). */
  readonly seleccion = signal<BoxLabelLine[]>([]);

  /** Cada orden con lo que la fila necesita ya calculado. */
  readonly filas = computed(() => {
    const ordenes = this.resp()?.ordenes ?? [];
    return ordenes.map((o) => ({
      o,
      llave: llave(o),
      pendientes: o.renglones.reduce((s, l) => s + l.pendientes.length, 0),
      avisos: o.renglones.reduce((s, l) => s + l.avisos.length, 0),
      atraso: o.vale_capturado_el && o.capturada_el
        ? Math.max(0, Math.round((Date.parse(o.capturada_el) - Date.parse(o.vale_capturado_el)) / 86_400_000))
        : 0,
    }));
  });

  readonly sucursales = computed(() => {
    const codes = [...new Set(this.filas().map((f) => f.o.sucursal))].sort();
    return codes.map((c) => ({ label: this.nombreSucursal(c), value: c }));
  });
  readonly variasSucursales = computed(() => this.sucursales().length > 1);

  private readonly enAlcance = computed(() => {
    const s = this.sucursal();
    const base = s ? this.filas().filter((f) => f.o.sucursal === s) : this.filas();
    return filtrarPorBusqueda(base, this.busqueda(), (f) => [
      f.o.folio, f.o.vale_folio, this.nombreSucursal(f.o.sucursal), ...f.o.renglones.flatMap((l) => [l.sku, l.nombre, l.codigo]),
    ]);
  });

  readonly visibles = computed(() => {
    const v = this.vista();
    return this.enAlcance().filter((f) => (v === 'todas' ? true : v === 'pendientes' ? f.pendientes > 0 : f.pendientes === 0));
  });

  readonly vistas = computed<SegOption[]>(() => {
    const fs = this.enAlcance();
    return [
      { label: 'Por etiquetar', value: 'pendientes', count: fs.filter((f) => f.pendientes > 0).length },
      { label: 'Enviadas', value: 'enviadas', count: fs.filter((f) => f.pendientes === 0).length },
      { label: 'Todas', value: 'todas', count: fs.length },
    ];
  });

  /** Renglones cuyo catálogo de Kepler está mal (la caja incompleta no es defecto del catálogo). */
  readonly conAvisos = computed(() =>
    this.enAlcance().reduce((s, f) => s + f.o.renglones.filter((l) => l.avisos.some((a) => a.tipo !== 'caja_incompleta')).length, 0));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const fs = this.enAlcance();
    const pend = fs.filter((f) => f.pendientes > 0);
    const etiquetas = fs.reduce((s, f) => s + f.o.etiquetas_total, 0);
    const enviadas = fs.reduce((s, f) => s + f.o.etiquetas_enviadas, 0);
    const conAvisos = this.conAvisos();
    return [
      { label: 'Órdenes por etiquetar', value: pend.length, tone: pend.length ? 'warn' : 'ok',
        sub: `${pend.reduce((s, f) => s + f.pendientes, 0).toLocaleString('es-MX')} etiquetas pendientes` },
      { label: 'Etiquetas enviadas', value: enviadas, sub: `de ${etiquetas.toLocaleString('es-MX')} en el periodo` },
      { label: 'Renglones con el catálogo de Kepler mal', value: conAvisos, tone: conAvisos ? 'warn' : 'default', sub: 'se imprimen igual; Compras los corrige en Kepler' },
    ];
  });

  readonly abierta = computed<BoxLabelOrder | null>(() => {
    const k = this.abiertaKey();
    return k ? this.filas().find((f) => f.llave === k)?.o ?? null : null;
  });

  readonly subtitulo = computed(() => {
    const o = this.abierta();
    if (!o) return null;
    const partes = [this.nombreSucursal(o.sucursal), `capturada el ${this.dia(o.capturada_el)} ${o.capturada_hora ?? ''}`.trim()];
    if (o.vale_folio) partes.push(`vale ${o.vale_folio}${o.vale_capturado_el ? ` (llegó el ${this.dia(o.vale_capturado_el)})` : ''}`);
    return partes.join(' · ');
  });

  /** Las etiquetas pendientes de los renglones elegidos (lo que manda «Imprimir»). */
  readonly pendientesSeleccion = computed(() => this.seleccion().reduce((s, l) => s + l.pendientes.length, 0));

  /** La primera fila (3 etiquetas) de lo que se mandaría, dibujada a tamaño real. */
  readonly vistaPrevia = computed<SafeHtml | null>(() => {
    // Las dos señales se leen siempre, antes de cualquier corte (skill diseno §4, «reactividad»).
    const seleccion = this.seleccion();
    const o = this.abierta();
    if (!o) return null;
    const etiquetas: EtiquetaCaja[] = [];
    for (const l of seleccion) {
      if (etiquetas.length >= 3) break;
      const fecha = l.primera?.fecha_etiqueta ?? this.fechaHoy;
      etiquetas.push(...etiquetasDelRenglon(l, fecha, l.pendientes.slice(0, 3 - etiquetas.length)));
    }
    return etiquetas.length ? this.sanitizer.bypassSecurityTrustHtml(documentoVistaPrevia(etiquetas)) : null;
  });

  readonly notaPrevia = computed(() => {
    const algunaNueva = this.seleccion().some((l) => !l.primera && l.pendientes.length);
    return algunaNueva
      ? `La fecha de la etiqueta es el día en que se envía por primera vez: hoy, ${this.fechaHoy}. Una reimpresión sale igual que la primera.`
      : 'Estas etiquetas ya tienen fecha: salen con la de la primera vez.';
  });

  readonly vacioTitulo = computed(() =>
    this.vista() === 'pendientes' ? 'No hay órdenes por etiquetar' : this.vista() === 'enviadas' ? 'Ninguna orden enviada todavía' : 'Sin órdenes de entrada');
  readonly vacioPista = computed(() =>
    this.busqueda() ? 'Nada coincide con la búsqueda.' : 'Las órdenes de entrada que se capturan en Kepler aparecen aquí unos minutos después.');

  ngOnInit(): void {
    this.recargar();
  }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.ordenes(rangoMx(Number(this.rango()))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.resp.set(r);
        this.cargando.set(false);
        this.resincronizarSeleccion();
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo cargar la cola de etiquetas.');
        this.cargando.set(false);
      },
    });
  }

  elegirRango(r: Rango): void {
    this.rango.set(r);
    this.recargar();
  }

  abrir(f: { llave: string }): void {
    this.abiertaKey.set(f.llave);
    this.reimp.set({});
    this.errReimp.set({});
    const o = this.abierta();
    this.seleccion.set(o ? o.renglones.filter((l) => l.pendientes.length) : []);
  }

  /** Tras recargar, la selección apunta a los objetos nuevos de los mismos renglones. */
  private resincronizarSeleccion(): void {
    const o = this.abierta();
    if (!o) return;
    const lineas = new Set(this.seleccion().map((l) => l.linea));
    this.seleccion.set(o.renglones.filter((l) => lineas.has(l.linea)));
  }

  /** Un clic desde la fila: todas las etiquetas que faltan de la orden. */
  imprimirPendientes(o: BoxLabelOrder): void {
    this.enviar(o, o.renglones.filter((l) => l.pendientes.length).map((l) => this.pedidoPendiente(l)));
  }

  imprimirSeleccion(o: BoxLabelOrder): void {
    this.enviar(o, this.seleccion().filter((l) => l.pendientes.length).map((l) => this.pedidoPendiente(l)));
  }

  reimprimir(o: BoxLabelOrder, l: BoxLabelLine): void {
    const leido = leerConsecutivos(this.reimp()[l.linea] ?? '', l.total_etiquetas);
    if (typeof leido === 'string') {
      this.errReimp.update((m) => ({ ...m, [l.linea]: leido }));
      return;
    }
    this.errReimp.update((m) => ({ ...m, [l.linea]: '' }));
    this.enviar(o, [{ linea: l.linea, consecutivos: leido }], () => this.reimp.update((m) => ({ ...m, [l.linea]: '' })));
  }

  escribirReimp(linea: number, v: string): void {
    this.reimp.update((m) => ({ ...m, [linea]: v }));
    if (this.errReimp()[linea]) this.errReimp.update((m) => ({ ...m, [linea]: '' }));
  }

  /** Sin primera: todo el renglón. Con primera: sólo lo que falta (sale con los datos congelados). */
  private pedidoPendiente(l: BoxLabelLine): { linea: number; consecutivos?: number[] } {
    return l.primera ? { linea: l.linea, consecutivos: l.pendientes } : { linea: l.linea };
  }

  /** Registra en la bitácora, recibe las etiquetas calculadas por el servidor y las manda a la TSC. */
  private enviar(o: BoxLabelOrder, renglones: { linea: number; consecutivos?: number[] }[], despues?: () => void): void {
    if (this.enviando() || !renglones.length) return;
    this.enviando.set(true); // síncrono: el doble clic del pánico no manda dos veces
    this.api.imprimir({ sucursal: o.sucursal, serie: o.serie, folio: o.folio, via: 'navegador', renglones })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          imprimirEtiquetasCaja(r.etiquetas, () => {
            this.enviando.set(false);
            despues?.();
            this.toast.add({
              severity: 'success',
              summary: `${r.etiquetas.length} ${r.etiquetas.length === 1 ? 'etiqueta enviada' : 'etiquetas enviadas'} a la impresora`,
              detail: `Orden ${o.folio}. Si no salieron, reimprímelas desde la orden.`,
            });
            this.recargar();
          });
        },
        error: (e) => {
          this.enviando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se enviaron las etiquetas', detail: e?.error?.message ?? 'Intenta de nuevo.' });
        },
      });
  }

  estado(e: BoxLabelOrderEstado) {
    return ESTADO[e];
  }
  nombreSucursal(code: string): string {
    return warehouseName(code) || code;
  }
  dia(d: string | null): string {
    return d ? diaCorto(d) : '—';
  }
  diaHora(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
