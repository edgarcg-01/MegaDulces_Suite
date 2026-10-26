import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import {
  necesitaMotivo, pasoAjuste, MOTIVOS_AJUSTE, MOTIVO_AJUSTE_LABEL, UMBRAL_MOTIVO,
  posicionPedido, POSICIONES_PEDIDO, POSICIONES_PEDIDO_DEFAULT, POSICION_PEDIDO_LABEL,
  CLASES_UNIDAD, CLASE_UNIDAD_LABEL, MINIMO_VALOR_MENOR, warehouseCodeAndName,
  ESTADO_RENGLON_LABEL, resumirRenglones, esEnviable, yaSeMandoACompras,
  type ClaseUnidad, type PosicionPedido, type EstadoRenglon, type SurteRenglon, type ResumenMesa,
  type MotivoAjuste, type AutoabastoPedidoGrupo, type AutoabastoPedidoLinea, type AutoabastoPedidoResponse,
  type AutoabastoVieneDoc, type AutoabastoEnviarResponse,
} from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';

import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch } from '../../../shared/util/debounced-search.util';
import { AutoabastoService, AutoabastoWarehouseOpt } from '../autoabasto.service';
import { qty, cuandoTexto, cuandoPorQue, surtePorQue, faltaNetaPorQue, estadoPorQue } from '../porques.util';
import { descargarPdfMiPedido, type MiPedidoPdfGrupo } from '../mi-pedido-pdf';

/**
 * Fase AB — **Autoabasto**: lo que le falta a un almacén, lo que ya viene y el pedido que sale de ahí.
 *
 * ── [AB.39] Una sola pantalla (PM, 2026-10-26) ───────────────────────────────────────────────
 * Hasta AB.38 había DOS: la mesa (`/almacen/autoabasto`, diagnóstico con filtros) y «Mi pedido»
 * (`/almacen/autoabasto/pedido`, el pedido por origen que se ajusta y se manda). Desde AB.27 las dos
 * leían la MISMA cuenta del renglón (`armarRenglon`): eran la misma información pintada dos veces, y el
 * PM lo llamó por su nombre — «mantener dos interfaces iguales en dos lados diferentes es un
 * anti-patrón». Ésta es la que queda; `/almacen/autoabasto/pedido` redirige aquí.
 *
 * Inventario de lo que trae cada una y dónde quedó (para que unificar no pierda nada):
 *  · De «Mi pedido»: grupos por origen y lista de surtido, − / + con motivo y guardado solo, «Lo que te
 *    va a llegar», «¿Hasta dónde pides?», mínimo de $200, mínimo del proveedor, Aceptar grupo, PDF por
 *    origen y de todo, Enviar a Compras, avisos de consulta / sin guardado / no medido.
 *  · De la mesa: filtro de estado con su conteo (reemplaza «Ver también lo cubierto»), a quién se le
 *    pide, búsqueda, Falta neta, Estado con su porqué, mínimo / reorden / máximo y entrega (terciario,
 *    del `diagnostico` que ahora trae `/pedido`), aviso de productos sin valuar, el reporte PDF del
 *    almacén y la ayuda contextual. Su filtro de posición es el mismo dato que «¿Hasta dónde pides?».
 *  · Lo que se va, dicho: el orden por columna y la paginación de la mesa. El renglón queda ordenado
 *    como en el pedido (lo que hay que pedir primero, por valor) y cada tabla muestra hasta
 *    `VISIBLES_TABLA` renglones con «Ver los N»: nunca se esconde una fila sin decirlo.
 *
 * La pregunta, en una frase: **¿qué le pido hoy a cada quien para que a mi almacén no le falte?**
 * Jerarquía (DESIGN §Q.5): primario = cuántos productos faltan por pedir y cuánto vale lo que se pide;
 * secundario = el pedido por origen con «A pedir»; terciario = mínimo, reorden, máximo y entrega.
 *
 * Los números NO se calculan acá: vienen de `GET /commercial/autoabasto/pedido`. Lo único que se
 * calcula es el valor en vivo mientras la persona mueve cantidades (cantidad × factor × costo base).
 * Decisiones que la gobiernan: un almacén a la vez (D2) · «Surte» = su matriz o el proveedor, nunca
 * el sobrante de la red (D3) · sin Excel: el ajuste deja huella (Francisco, 2026-10-12).
 */

const POSICION: Record<string, string> = {
  agotado: 'Agotado', bajo_minimo: 'Bajo mínimo', bajo_reorden: 'Bajo reorden', sano: 'Sano', sobrestock: 'Sobrestock',
};
const ESTADO_SEVERIDAD: Record<EstadoRenglon, 'danger' | 'warn' | 'success' | 'secondary'> = {
  sin_pedir: 'danger', lo_pediste: 'warn', compras_lo_planeo: 'warn', ya_viene: 'success', en_politica: 'secondary',
};
const SURTE_LABEL: Record<SurteRenglon['tipo'], string> = {
  matriz: 'Su matriz (traspaso)', proveedor: 'Proveedor (compra)', sin_ruta: 'Sin ruta',
};
/** Qué renglones se ven: los del pedido (default), los de un estado, o todos. */
type Vista = 'pedido' | 'todos' | Exclude<EstadoRenglon, 'en_politica' | 'sin_pedir'>;
/** Tiempo sin clics antes de guardar un renglón: deja terminar de mover con − / +. */
const ESPERA_GUARDADO_MS = 700;
/** Renglones por tabla antes de «Ver los N». */
const VISIBLES_TABLA = 150;

/** Estado local de un renglón mientras la persona lo mueve. */
interface Edicion {
  cantidad: number;
  motivo: MotivoAjuste | null;
  guardando: boolean;
  guardado: boolean;
  error: string | null;
  /** Cuándo empezó a trabajar el renglón (para la huella). */
  desde: number | null;
}

@Component({
  selector: 'app-almacen-autoabasto',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, InputTextModule, TooltipModule, TagModule,
    CheckboxModule, DialogModule, TextareaModule,
    LoadStateComponent, MetricStripComponent, SegmentedComponent, FreshnessPillComponent, ContextHelpComponent, SucursalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="surf-page ab-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Autoabasto</h1>
          <p class="surf-page-sub">
            Qué le falta a tu almacén, qué ya viene y a quién se le pide. El sistema ya armó tu pedido: corrige sólo
            lo que haga falta con − / + (si te alejas más de {{ umbralPct }}% de lo sugerido, elige el motivo) y
            mándalo a Compras. Todo se guarda solo.
          </p>
        </div>
        <div class="ab-actions">
          <app-context-help topic="almacen-autoabasto" />
          @if (data()?.puede_ajustar) {
            <!-- [AB.29] La acción principal: lo que falta por pedir sale como requisición a Compras. -->
            <button pButton type="button" class="p-button-sm"
                    (click)="abrirEnvio()" [disabled]="loading() || enviando() || !porEnviar().renglones || sinGuardar() > 0"
                    [pTooltip]="porQueNoEnviar() ?? 'Manda a Compras lo que te falta por pedir: una requisición por origen, para que la aprueben.'"
                    tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span>
              <span class="p-button-label">Enviar a Compras</span>
            </button>
          }
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  (click)="pdf()" [disabled]="loading() || !hayQuePedir() || imprimiendo()"
                  pTooltip="El pedido, cada origen en su hoja, para capturarlo en Kepler." tooltipPosition="bottom">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>
            <span class="p-button-label">PDF del pedido</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  (click)="reporte()" [disabled]="!warehouseId() || generandoReporte()"
                  pTooltip="Todos los productos del almacén con los filtros de estado, origen y búsqueda." tooltipPosition="bottom">
            <span class="p-button-icon p-button-icon-left pi"
                  [class.pi-file]="!generandoReporte()" [class.pi-spin]="generandoReporte()" [class.pi-spinner]="generandoReporte()" aria-hidden="true"></span>
            <span class="p-button-label">{{ generandoReporte() ? 'Generando…' : 'Reporte del almacén' }}</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  (click)="recargar()" [disabled]="loading()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Recalcular</span>
          </button>
        </div>
      </header>

      <!-- El alcance lo aplica el servidor (área Almacén): la lista ya viene recortada a los almacenes de la persona. -->
      @if (filtrosListos()) {
        @if (!warehouses().length) {
          <p class="ab-note ab-warn" role="note">
            <i class="pi pi-lock" aria-hidden="true"></i>
            No tienes almacén asignado. Pide que te asignen tu almacén en tu ficha de Personas.
          </p>
        }
      } @else if (filtrosError()) {
        <p class="ab-note ab-warn" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          No se pudo saber qué almacenes tienes a tu alcance. Vuelve a intentar con «Recalcular».
        </p>
      }

      @if (warehouses().length > 1) {
        <div class="ab-almacen">
          <p-select [options]="warehouses()" optionLabel="name" optionValue="id"
                    [ngModel]="warehouseId()" (ngModelChange)="setWarehouse($event)"
                    placeholder="Elige un almacén" [filter]="warehouses().length > 6"
                    class="ab-f" ariaLabel="Almacén"></p-select>
          @if (!warehouseId()) {
            <span class="ab-dim">Tienes <strong>{{ warehouses().length }} almacenes</strong> a tu alcance. El pedido es de un solo almacén: elige uno.</span>
          }
        </div>
      } @else if (almacenSel(); as a) {
        <span class="ab-scope"><i class="pi pi-building" aria-hidden="true"></i> {{ a.name }}</span>
      }

      @if (data(); as d) {
        @if (!d.puede_ajustar) {
          <p class="ab-note" role="note">
            <i class="pi pi-eye" aria-hidden="true"></i>
            Estás viendo el pedido en modo consulta: para ajustarlo necesitas el permiso de preparar pedidos.
          </p>
        }
        @if (d.puede_ajustar && !d.guardado_disponible) {
          <p class="ab-note ab-warn" role="note">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            Puedes mover las cantidades, pero <strong>no se guardan</strong>: esta base no permite guardar
            el pedido (le falta su actualización o la conexión es de sólo lectura). Al recargar vuelves al sugerido.
          </p>
        }
        @if (!d.pedidos_medidos) {
          <p class="ab-note ab-warn" role="note">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            Este almacén no tiene cliente de traspaso en Kepler: lo ya pedido a la matriz, lo atorado y lo negado
            <strong>no se pudo medir</strong> (no es lo mismo que cero). «Ya viene» puede quedarse corto.
          </p>
        }
        @if (resumen()?.sin_valuar; as n) {
          <p class="ab-note" role="note">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <strong>{{ n }}</strong> producto(s) no entran en los importes: su costo de compra no coincide con su unidad,
            así que el dinero <strong>no se está midiendo</strong>. Las cantidades sí son válidas.
          </p>
        }
        @if (aviso(); as a) {
          <p class="ab-note ab-warn" role="alert">
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ a }}
            <button type="button" class="ab-link" (click)="aviso.set(null)">cerrar</button>
          </p>
        }
        @if (enviado(); as e) {
          <!-- [AB.29] Lo que pasó al enviar: los folios, a quién le llegó y lo que no se mandó (con su porqué). -->
          <div class="ab-note" [class.ab-ok]="e.requisiciones.length && e.le_llega_a.length"
               [class.ab-warn]="!e.requisiciones.length || !e.le_llega_a.length" role="status">
            <i class="pi" [class.pi-check-circle]="e.requisiciones.length" [class.pi-info-circle]="!e.requisiciones.length" aria-hidden="true"></i>
            <div>
              @if (e.requisiciones.length) {
                <strong>Se mandó a Compras:</strong>
                @for (q of e.requisiciones; track q.id; let ult = $last) {
                  {{ q.folio }} ({{ q.surte.tipo === 'matriz' ? 'traspaso de ' + (q.surte.clave | sucursal) : 'compra a ' + q.surte.nombre }},
                  {{ q.renglones }} {{ q.renglones === 1 ? 'producto' : 'productos' }}){{ ult ? '.' : ';' }}
                }
                @if (e.le_llega_a.length) {
                  Le llegó a <strong>{{ e.le_llega_a.join(', ') | titlecase }}</strong> para aprobarla o rechazarla con motivo.
                } @else {
                  <strong>Nadie tiene asignado recibirlas</strong>: avísale a Compras que la revise en Requisiciones.
                }
              } @else {
                <strong>No se mandó nada nuevo.</strong>
              }
              @if (e.omitidos.length) {
                <span class="ab-dim">
                  {{ e.omitidos.length }} {{ e.omitidos.length === 1 ? 'producto no se mandó' : 'productos no se mandaron' }}:
                  {{ resumenOmitidos(e) }}.
                </span>
              }
            </div>
            <button type="button" class="ab-link" (click)="enviado.set(null)">cerrar</button>
          </div>
        }
        @if (yaMandados(); as n) {
          <p class="ab-note" role="note">
            <i class="pi pi-send" aria-hidden="true"></i>
            {{ n }} {{ n === 1 ? 'producto ya lo pediste' : 'productos ya los pediste' }} a Compras: no entran a este pedido
            para no pedirlos dos veces. Su requisición está abajo, en «Lo que te va a llegar».
          </p>
        }

        <app-metric-strip [items]="kpis()" ariaLabel="Lo que le falta al almacén y lo que se pide"></app-metric-strip>
        <p class="ab-stamp">
          Calculado el {{ d.fecha_mx }} a las {{ d.hora_mx }} (hora de México) · cobertura {{ d.cobertura_dias }} días ·
          cantidades en cajas, salvo «A pedir», que va en la unidad en que se captura.
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        </p>

        <!-- [AB.23] Lo que te va a llegar: para no pedir dos veces lo que ya viene. Lo de la ventana ya
             se restó de «A pedir»; lo más viejo se muestra para reclamarlo, no se resta. -->
        @if (viene(); as v) {
          <section class="ab-viene" aria-labelledby="ab-viene-h">
            <h2 id="ab-viene-h" class="ab-viene-h">Lo que te va a llegar</h2>
            @if (!v.docs.length) {
              <p class="ab-dim">No hay pedidos de traspaso abiertos ni embarques en camino hacia {{ d.almacen.code | sucursal }}.</p>
            } @else {
              <p class="ab-viene-res">
                @if (v.embarques) { <strong>{{ v.embarques }} {{ v.embarques === 1 ? 'embarque en camino' : 'embarques en camino' }}</strong> }
                @if (v.embarques && v.pedidos) { y }
                @if (v.pedidos) { <strong>{{ v.pedidos }} {{ v.pedidos === 1 ? 'pedido en preparación' : 'pedidos en preparación' }}</strong> }
                @if (v.monto) { · {{ v.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                @if (v.embarques || v.pedidos) { <span class="ab-dim">— ya se restaron de lo que te toca pedir.</span> }
                @if (v.viejos) { <span class="ab-chip ab-chip-warn">{{ v.viejos }} sin llegar desde hace días: no se restan, reclámalos</span> }
                @if (v.porAprobar) { <span class="ab-chip ab-chip-warn">{{ v.porAprobar }} {{ v.porAprobar === 1 ? 'requisición tuya' : 'requisiciones tuyas' }} por aprobar en Compras</span> }
                @if (v.rechazadas) { <span class="ab-chip ab-chip-bad">{{ v.rechazadas }} {{ v.rechazadas === 1 ? 'rechazada' : 'rechazadas' }}: mira el motivo</span> }
                @if (v.planes) { <span class="ab-chip" pTooltip="Compras ya decidió mandártelo, pero todavía no existe el pedido de traspaso en Kepler: la matriz no lo surte hasta que exista. No se resta." tooltipPosition="top">{{ v.planes }} {{ v.planes === 1 ? 'requisición' : 'requisiciones' }} de Compras sin llegar a Kepler</span> }
              </p>
              <ul class="ab-viene-l">
                @for (doc of v.visibles; track doc.tipo + doc.origen + doc.serie + doc.folio) {
                  <li class="ab-viene-i" [class.ab-viene-viejo]="!doc.se_resta">
                    <span class="ab-viene-et" [class.ab-viene-camino]="doc.tipo === 'embarque'">{{ etapa(doc) }}</span>
                    @if (doc.tipo === 'requisicion' && doc.proveedor) {
                      <span>a <strong>{{ doc.proveedor }}</strong></span>
                    } @else {
                      <span>desde <strong>{{ doc.origen | sucursal }}</strong></span>
                    }
                    <span class="ab-dim">{{ doc.tipo === 'embarque' ? 'Embarque' : doc.tipo === 'pedido' ? 'Pedido' : 'Requisición' }} {{ doc.folio }}</span>
                    <span class="ab-dim">{{ doc.renglones }} {{ doc.renglones === 1 ? 'producto' : 'productos' }}</span>
                    <span class="ab-num">{{ doc.monto == null ? '—' : (doc.monto | currency:'MXN':'symbol-narrow':'1.0-0') }}</span>
                    <span [class.ab-warn-t]="!doc.se_resta && doc.tipo !== 'requisicion'">{{ hace(doc.dias) }}@if (doc.tipo === 'plan') { · aún no está en Kepler } @else if (doc.tipo === 'requisicion') { · la pediste tú } @else if (!doc.se_resta) { · no se resta }</span>
                    @if (doc.motivo) {
                      <span class="ab-viene-motivo"><i class="pi pi-comment" aria-hidden="true"></i> Motivo de Compras: «{{ doc.motivo }}»</span>
                    }
                  </li>
                }
              </ul>
              @if (v.docs.length > v.visibles.length || verTodoViene()) {
                <button type="button" class="ab-link" (click)="verTodoViene.set(!verTodoViene())">
                  {{ verTodoViene() ? 'Ver menos' : 'Ver los ' + v.docs.length }}
                </button>
              }
              @if (d.viene?.renglones_sin_unidad) {
                <p class="ab-dim">{{ d.viene!.renglones_sin_unidad }} renglón(es) vienen en una unidad que la ficha del producto no conoce: no se restaron.</p>
              }
            }
          </section>
        }

        <fieldset class="ab-pos">
          <legend class="ab-pos-leg">¿Hasta dónde pides?</legend>
          @for (p of posicionesTodas; track p) {
            <label class="ab-check">
              <p-checkbox [binary]="true" [ngModel]="posiciones().has(p)" (ngModelChange)="togglePosicion(p, $event)"
                          [inputId]="'ab-pos-' + p"></p-checkbox>
              <span>{{ etiquetaPosicion(p) }}</span>
              <span class="ab-pos-n">{{ conteoPosicion()[p] }}</span>
            </label>
          }
          @if (!posiciones().size) {
            <span class="ab-dim">Elige al menos una para armar el pedido.</span>
          }
        </fieldset>
        @if (debajoMinimo(); as n) {
          <p class="ab-note" role="note">
            <i class="pi pi-filter" aria-hidden="true"></i>
            {{ n }} {{ n === 1 ? 'renglón' : 'renglones' }} en unidad menor no llegan a
            {{ minimoMenor | currency:'MXN':'symbol-narrow':'1.0-0' }} y no se piden. Para verlos, elige «Todos».
          </p>
        }

        <div class="ab-filters">
          <app-segmented [options]="vistaOpts()" [value]="vista()" (valueChange)="setVista($event)" ariaLabel="Qué renglones ver" />
          <p-select [options]="surteOpts" optionLabel="label" optionValue="value"
                    [ngModel]="surte()" (ngModelChange)="surte.set($event)"
                    placeholder="A quién se le pide" [showClear]="true" class="ab-f" ariaLabel="A quién se le pide"></p-select>
          <input pInputText type="search" class="ab-search" placeholder="SKU o nombre"
                 [ngModel]="searchRaw()" (ngModelChange)="onSearch($event)" aria-label="Buscar por SKU o nombre" />
        </div>
      }

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!!data() && !gruposVisibles().length"
                      [emptyTitle]="hayFiltro() ? 'Nada con estos filtros' : 'Nada que pedir'"
                      [emptyHint]="hayFiltro() ? 'Quita algún filtro o elige «Todos».' : 'Con la venta de los últimos 30 días y lo que ya viene, este almacén está cubierto.'"
                      (retry)="cargar()">
        @for (g of gruposVisibles(); track llaveGrupo(g)) {
          <article class="ab-grupo">
            <header class="ab-ghead">
              <div class="ab-gtitle">
                <span class="ab-gtipo">{{ tipoTexto(g) }}</span>
                <strong class="ab-why" [pTooltip]="surtePorQueGrupo(g)" tooltipPosition="top">{{ g.tipo === 'matriz' ? (g.nombre | sucursal:'con-codigo') : g.nombre }}</strong>
                @if (aceptados().has(llaveGrupo(g))) {
                  <span class="ab-chip ab-chip-ok"><i class="pi pi-check" aria-hidden="true"></i> Revisado</span>
                }
              </div>
              <div class="ab-gtot">
                @let t = totales(g);
                <span>{{ t.renglones }} en el pedido</span>
                @if (t.ajustados > 0) { <span class="ab-dim">{{ t.ajustados }} ajustados</span> }
                <span class="ab-strong">{{ t.valor == null ? '—' : (t.valor | currency:'MXN':'symbol-narrow':'1.0-0') }}</span>
                <button pButton type="button" class="p-button-sm p-button-outlined"
                        (click)="pdf(g)" [disabled]="!t.renglones || imprimiendo()"
                        [attr.aria-label]="'PDF del pedido a ' + g.nombre"
                        [pTooltip]="g.tipo === 'proveedor' ? 'Requisición de compra para este proveedor' : 'Pedido de traspaso para capturar en la sucursal que surte'" tooltipPosition="top">
                  <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>
                  <span class="p-button-label">PDF</span>
                </button>
                @if (data()?.puede_ajustar) {
                  <button pButton type="button" class="p-button-sm"
                          [class.p-button-outlined]="aceptados().has(llaveGrupo(g))"
                          (click)="aceptarGrupo(g)" [disabled]="!t.renglones">
                    <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                    <span class="p-button-label">{{ aceptados().has(llaveGrupo(g)) ? 'Aceptado' : 'Aceptar grupo' }}</span>
                  </button>
                }
              </div>
            </header>
            @if (avisoMinimo(g); as am) {
              <p class="ab-note ab-warn ab-gnote" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ am }}</p>
            }
            @for (cl of clasesDe(g); track cl) {
              @let tc = totalesClase(g, cl);
              @let vis = lineasDe(g, cl);
              <div class="ab-clase">
                <span class="ab-clase-tit">{{ etiquetaClase(cl) }}</span>
                <span class="ab-dim">{{ ayudaClase(cl) }}</span>
                <span class="ab-clase-tot">
                  {{ tc.renglones }} en el pedido
                  @if (cl === 'mayor' && tc.unidades > 0) { · {{ qty(tc.unidades) }} unidades mayores }
                  · {{ tc.valor == null ? '—' : (tc.valor | currency:'MXN':'symbol-narrow':'1.0-0') }}
                </span>
              </div>
              <p-table [value]="tabla(g, cl)" dataKey="product_id" [scrollable]="true"
                       styleClass="p-datatable-sm dt-stack surf-table surf-table--plain surf-table--frozen-first">
                <ng-template #header>
                  <tr>
                    <th class="ab-c-sku">Producto</th>
                    <th class="comm-num" pTooltip="Venta de los últimos 30 días, en cajas." tooltipPosition="top">Venta 30 d</th>
                    <th class="comm-num">Existencia</th>
                    <th class="comm-num" pTooltip="Lo que ya te viene y ya se restó: pedidos abiertos a la matriz de 7 días o menos, más lo embarcado que todavía no recibes." tooltipPosition="top">Ya viene</th>
                    <th class="comm-num" pTooltip="Lo que falta después de restar lo que ya viene, en cajas, antes de redondear." tooltipPosition="top">Falta neta</th>
                    <th class="comm-num ab-c-pedir">A pedir</th>
                    <th class="comm-num">Valor</th>
                    <th>Estado</th>
                    <th>Avisos</th>
                  </tr>
                </ng-template>
                <ng-template #body let-l>
                  @let c = cantidad(l);
                  <tr [class.ab-cubierto]="!c" [class.ab-ajustada]="c !== l.a_pedir.cantidad">
                    <td class="ab-c-sku" data-label="Producto">
                      <span class="ab-sku">{{ l.sku }}</span>
                      <span class="ab-name">{{ l.nombre }}</span>
                    </td>
                    <td class="comm-num" data-label="Venta 30 d">{{ l.venta_30d == null ? '—' : qty(l.venta_30d) }}</td>
                    <td class="comm-num" data-label="Existencia">
                      {{ qty(l.existencia) }}
                      @if (l.diagnostico; as dg) {
                        <span class="ab-dg">mín {{ qty(dg.min_stock) }} · reorden {{ qty(dg.reorder_point) }} · máx {{ qty(dg.max_stock) }}</span>
                      }
                    </td>
                    <td class="comm-num" data-label="Ya viene" [pTooltip]="yaVieneTitle(l)" tooltipPosition="top">{{ yaViene(l) > 0 ? qty(yaViene(l)) : '—' }}</td>
                    <td class="comm-num ab-why" data-label="Falta neta" [pTooltip]="faltaNetaPorQue(l, medidos())" tooltipPosition="top">{{ qty(l.falta_neta) }}</td>
                    <td class="comm-num ab-c-pedir" data-label="A pedir" [pTooltip]="porQueAPedir(l)" tooltipPosition="left">
                      @if (editable(l)) {
                        <span class="ab-step">
                          <button type="button" class="ab-stepbtn" (click)="mover(g, l, -1)" [disabled]="!c"
                                  [attr.aria-label]="'Bajar ' + l.nombre">−</button>
                          <span class="ab-val">{{ qty(c) }}</span>
                          <button type="button" class="ab-stepbtn" (click)="mover(g, l, 1)"
                                  [attr.aria-label]="'Subir ' + l.nombre">+</button>
                          <span class="ab-unit">{{ l.a_pedir.unidad ?? '' }}</span>
                        </span>
                      } @else {
                        @if (c > 0) { <span class="ab-strong">{{ qty(c) }}</span> <span class="ab-unit">{{ l.a_pedir.unidad ?? 'sin unidad' }}</span> } @else { — }
                      }
                      @if (c !== l.a_pedir.cantidad) {
                        <span class="ab-sug">sugerido {{ qty(l.a_pedir.cantidad) }}
                          @if (editable(l)) {
                            · <button type="button" class="ab-link" (click)="restablecer(l)">volver</button>
                          }
                        </span>
                      }
                      @let st = edicion()[l.product_id];
                      @if (st?.guardando) { <span class="ab-save ab-dim">guardando…</span> }
                      @else if (st?.error) { <span class="ab-save ab-err" [pTooltip]="st.error">no se guardó</span> }
                      @else if (st?.guardado) { <span class="ab-save ab-okc">guardado</span> }
                    </td>
                    <td class="comm-num" data-label="Valor">{{ valor(l) == null ? '—' : (valor(l) | currency:'MXN':'symbol-narrow':'1.0-0') }}</td>
                    <td data-label="Estado">
                      <p-tag [value]="etiquetaEstado(l.estado)" [severity]="severidadEstado(l.estado)"
                             [pTooltip]="estadoPorQue(l)" tooltipPosition="left" />
                    </td>
                    <td class="ab-flags" data-label="Avisos">
                      <span class="ab-chip">{{ posicion(l.posicion) }}</span>
                      @if (fueraDelPedido(l); as fp) {
                        <span class="ab-chip">{{ fp }}</span>
                      }
                      @if (l.diagnostico?.next_due_date) {
                        <span class="ab-chip ab-why" [pTooltip]="entregaPorQue(l)" tooltipPosition="left">Entrega {{ entrega(l) }}</span>
                      }
                      @if (l.planeado_compras > 0) {
                        <span class="ab-chip" [pTooltip]="'Compras ya decidió mandarte ' + qty(l.planeado_compras) + ' cajas, pero todavía no está en Kepler: no se resta hasta que exista el pedido de traspaso.'" tooltipPosition="left">Compras {{ qty(l.planeado_compras) }}</span>
                      }
                      @if (l.atorado > 0) {
                        <span class="ab-chip ab-chip-warn" [pTooltip]="'Pedido abierto hace más de 7 días: ' + qty(l.atorado) + ' cajas. No se resta: reclámalo o cancélalo.'" tooltipPosition="left">Atorado {{ qty(l.atorado) }}</span>
                      }
                      @if (l.negado_30d > 0) {
                        <span class="ab-chip ab-chip-bad" [pTooltip]="'La matriz no surtió ' + qty(l.negado_30d) + ' cajas en los últimos 30 días.'" tooltipPosition="left">Negado {{ qty(l.negado_30d) }}</span>
                      }
                      @if (l.minimo_menor === 'debajo') {
                        <span class="ab-chip ab-chip-warn" [pTooltip]="'En unidad menor valía ' + ((l.valor_menor ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0') + ', menos del mínimo de ' + (minimoMenor | currency:'MXN':'symbol-narrow':'1.0-0') + '. No se pide; súbelo con + si lo necesitas.'" tooltipPosition="left">Menos de {{ minimoMenor | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                      }
                      @if (l.minimo_menor === 'agotado') {
                        <span class="ab-chip" [pTooltip]="'Vale ' + ((l.valor_menor ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0') + ', menos del mínimo, pero está agotado: se pide igual.'" tooltipPosition="left">Agotado: se pide aunque sea poco</span>
                      }
                      @if (l.minimo_menor === 'sin_costo') {
                        <span class="ab-chip" pTooltip="No tiene costo confiable: no se pudo revisar el mínimo en unidad menor. Se deja como está." tooltipPosition="left">Mínimo sin revisar</span>
                      }
                      @if (l.a_pedir.regla === 'sin_escalera') {
                        <span class="ab-chip" pTooltip="Kepler no trae su escalera de unidades: la cantidad no se redondeó y no se puede ajustar." tooltipPosition="left">Sin unidad</span>
                      }
                    </td>
                  </tr>
                  @if (pideMotivo(l)) {
                    <tr class="ab-motivo-row">
                      <td colspan="9">
                        <span class="ab-motivo-txt">¿Por qué te alejas de lo sugerido?</span>
                        @for (m of motivos; track m) {
                          <button type="button" class="ab-motivo" [class.ab-motivo-on]="motivoDe(l) === m"
                                  (click)="elegirMotivo(l, m)">{{ etiquetaMotivo(m) }}</button>
                        }
                      </td>
                    </tr>
                  }
                </ng-template>
              </p-table>
              @if (vis.length > visiblesTabla && !expandidas().has(llaveTabla(g, cl))) {
                <button type="button" class="ab-link ab-mas" (click)="expandir(g, cl)">
                  Se ven {{ visiblesTabla }} de {{ vis.length }} · Ver los {{ vis.length }}
                </button>
              }
            }
          </article>
        }
      </app-load-state>

      <!-- [AB.29] Confirmar el envío: qué sale, a quién se le pide y quién lo aprueba. -->
      <p-dialog [visible]="envioAbierto()" (visibleChange)="envioAbierto.set($event)" [modal]="true"
                [style]="{ width: '34rem' }" [breakpoints]="{ '40rem': '95vw' }" header="Enviar a Compras" [dismissableMask]="!enviando()">
        @let pe = porEnviar();
        <p class="ab-env-p">
          Se mandan <strong>{{ pe.renglones }} {{ pe.renglones === 1 ? 'producto' : 'productos' }}</strong> que te faltan por pedir,
          en {{ pe.grupos.length }} {{ pe.grupos.length === 1 ? 'requisición' : 'requisiciones' }} (una por a quién se le pide):
        </p>
        <ul class="ab-env-l">
          @for (eg of pe.grupos; track eg.llave) {
            <li>
              <span>{{ eg.tipo === 'matriz' ? 'Traspaso de' : 'Compra a' }} <strong>{{ eg.tipo === 'matriz' ? (eg.nombre | sucursal) : eg.nombre }}</strong></span>
              <span class="ab-dim">{{ eg.renglones }} {{ eg.renglones === 1 ? 'producto' : 'productos' }}</span>
              <span class="ab-num">{{ eg.valor == null ? '—' : (eg.valor | currency:'MXN':'symbol-narrow':'1.0-0') }}</span>
            </li>
          }
        </ul>
        <p class="ab-env-p ab-dim">
          Van con las cantidades que dejaste y sólo lo marcado en «¿Hasta dónde pides?». Le llegan a Compras para
          aprobarlas o rechazarlas con motivo; mientras tanto no se vuelven a pedir.
        </p>
        <label class="ab-env-lab" for="ab-env-nota">Nota para Compras <span class="ab-dim">(opcional)</span></label>
        <textarea pTextarea id="ab-env-nota" class="ab-env-nota" rows="3" maxlength="500"
                  [ngModel]="notaEnvio()" (ngModelChange)="notaEnvio.set($event)"
                  placeholder="Por ejemplo: viene una promoción la otra semana"></textarea>
        <ng-template #footer>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="envioAbierto.set(false)" [disabled]="enviando()">
            <span class="p-button-label">Cancelar</span>
          </button>
          <button pButton type="button" class="p-button-sm" (click)="enviar()" [disabled]="enviando() || !pe.renglones">
            <span class="p-button-icon p-button-icon-left pi" [class.pi-send]="!enviando()" [class.pi-spin]="enviando()" [class.pi-spinner]="enviando()" aria-hidden="true"></span>
            <span class="p-button-label">{{ enviando() ? 'Enviando…' : 'Enviar' }}</span>
          </button>
        </ng-template>
      </p-dialog>

      <p class="ab-foot">
        Falta neta = objetivo − existencia − lo que ya viene (pedido abierto a la matriz de 7 días o menos y embarque sin
        recibir). Lo que Compras planeó y todavía no está en Kepler se muestra, pero no se resta. Tu pedido se guarda en la
        Suite con cada ajuste; «Enviar a Compras» lo manda como requisición para que la aprueben.
      </p>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ab-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .ab-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .ab-almacen { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .ab-scope { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }

    .ab-note { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0; padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-md); font-size: var(--fs-sm); line-height: 1.45; background: var(--overlay-hover); color: var(--text-main); }
    .ab-note i { margin-top: var(--sp-1); }
    .ab-warn { background: var(--warn-soft-bg); }
    .ab-ok { background: var(--ok-soft-bg); }
    .ab-stamp { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ab-foot { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ab-dim { color: var(--text-muted); }
    .ab-strong { font-weight: 650; }
    .ab-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ab-link { border: 0; background: none; padding: 0; color: var(--action); font-size: var(--fs-xs); cursor: pointer; text-decoration: underline; }
    .ab-link:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ab-mas { align-self: flex-start; margin: var(--sp-2) var(--sp-3); }
    /* El subrayado punteado marca lo que EXPLICA al pasar el mouse. */
    .ab-why { text-decoration: underline dotted var(--border-color); text-underline-offset: 3px; cursor: help; }

    /* [AB.23] Lo que te va a llegar */
    .ab-viene { border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-2) var(--sp-3); background: var(--card-bg); }
    .ab-viene-h { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ab-viene-res { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); align-items: baseline; }
    .ab-viene-l { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-1); }
    .ab-viene-i { display: grid; grid-template-columns: 6.5rem minmax(9rem, 1.4fr) minmax(7rem, 1fr) 6rem 6.5rem minmax(7rem, 1fr);
      gap: var(--sp-2); align-items: baseline; font-size: var(--fs-sm); padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); }
    .ab-viene-i:first-child { border-top: 0; }
    .ab-viene-et { font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .ab-viene-et.ab-viene-camino { color: var(--info-fg); }
    .ab-viene-viejo { color: var(--text-muted); }
    .ab-viene-motivo { grid-column: 1 / -1; font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    .ab-warn-t { color: var(--warn-fg); }
    @container (max-width: 40rem) { .ab-viene-i { grid-template-columns: 1fr 1fr; } }

    /* [AB.19] Hasta dónde pides */
    .ab-pos { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); margin: 0; padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); }
    .ab-pos-leg { float: left; padding: 0; margin-right: var(--sp-2); font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ab-pos-n { min-width: 1.6rem; padding: 0 var(--sp-2); border-radius: var(--r-pill); background: var(--overlay-hover);
      font-size: var(--fs-micro); text-align: center; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ab-check { display: inline-flex; gap: var(--sp-2); align-items: center; font-size: var(--fs-body); color: var(--text-main); cursor: pointer; }

    .ab-filters { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .ab-f { min-width: 12rem; }
    .ab-search { min-width: 14rem; flex: 1 1 14rem; }

    /* Un grupo por a quién se le pide */
    .ab-grupo { border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); overflow: hidden; }
    .ab-ghead { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
      padding: var(--sp-2) var(--sp-3); background: var(--surface-ground); border-bottom: 1px solid var(--border-color); }
    .ab-gtitle { display: flex; align-items: center; gap: var(--sp-2); color: var(--text-main); }
    .ab-gtipo { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .ab-gtot { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .ab-gnote { margin: var(--sp-2) var(--sp-3) 0; }
    .ab-clase { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3) var(--sp-1);
      border-top: 1px solid var(--border-color); font-size: var(--fs-sm); }
    .ab-clase-tit { font-weight: 650; color: var(--text-main); }
    .ab-clase-tot { margin-left: auto; color: var(--text-main); font-variant-numeric: tabular-nums; }

    .ab-c-sku { min-width: 15rem; }
    .ab-c-pedir { min-width: 11rem; }
    .ab-sku { display: block; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-xs); color: var(--text-muted); }
    .ab-name { display: block; color: var(--text-main); }
    /* Terciario: lo que explica la posición. */
    .ab-dg { display: block; font-size: var(--fs-micro); color: var(--text-muted); white-space: nowrap; }
    .ab-cubierto td { color: var(--text-muted); }
    .ab-ajustada td.ab-c-pedir { background: var(--overlay-hover); }

    .ab-step { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .ab-stepbtn { width: 1.9rem; height: 1.9rem; border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); font-size: var(--fs-h3); font-weight: 650; line-height: 1; cursor: pointer; }
    .ab-stepbtn:hover:not(:disabled) { border-color: var(--action); color: var(--action); }
    .ab-stepbtn:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .ab-stepbtn:disabled { opacity: .4; cursor: default; }
    @media (pointer: coarse) { .ab-stepbtn { width: 2.75rem; height: 2.75rem; } }
    .ab-val { min-width: 2.4rem; text-align: center; font-weight: 650; }
    .ab-unit { font-size: var(--fs-micro); font-weight: 500; color: var(--text-muted); margin-left: var(--sp-1); }
    .ab-sug { display: block; font-size: var(--fs-micro); color: var(--text-muted); margin-top: var(--sp-1); }
    .ab-save { display: block; font-size: var(--fs-nano); margin-top: var(--sp-1); }
    .ab-okc { color: var(--ok-soft-fg); }
    .ab-err { color: var(--bad-soft-fg); cursor: help; }

    .ab-motivo-row td { background: var(--overlay-hover); }
    .ab-motivo-txt { font-size: var(--fs-xs); color: var(--text-main); margin-right: var(--sp-2); }
    .ab-motivo { margin: var(--sp-1) var(--sp-1) var(--sp-1) 0; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); border: 1px solid var(--border-color);
      background: var(--card-bg); font-size: var(--fs-xs); color: var(--text-main); cursor: pointer; }
    .ab-motivo:hover { border-color: var(--action); }
    .ab-motivo:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .ab-motivo-on { background: var(--action); border-color: var(--action); color: var(--action-ink); }

    .ab-flags { white-space: normal; min-width: 12rem; }
    .ab-chip { display: inline-flex; align-items: center; gap: var(--sp-1); margin: 0 var(--sp-1) var(--sp-1) 0; padding: 0 var(--sp-2); border-radius: var(--r-pill);
      font-size: var(--fs-micro); background: var(--overlay-hover); color: var(--text-muted); }
    .ab-chip-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ab-chip-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .ab-chip-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }

    /* [AB.29] Enviar a Compras */
    .ab-env-p { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); line-height: 1.45; color: var(--text-main); }
    .ab-env-l { list-style: none; margin: 0 0 var(--sp-3); padding: 0; display: grid; gap: var(--sp-1); }
    .ab-env-l li { display: grid; grid-template-columns: 1fr auto 6.5rem; gap: var(--sp-3); align-items: baseline;
      font-size: var(--fs-sm); padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); }
    .ab-env-l li:first-child { border-top: 0; }
    .ab-env-lab { display: block; margin: var(--sp-1) 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ab-env-nota { width: 100%; }
  `],
})
export class AlmacenAutoabastoComponent {
  private readonly svc = inject(AutoabastoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<AutoabastoPedidoResponse | null>(null);
  /** Cuándo llegó la respuesta a esta pantalla (la píldora de frescura mide la CARGA, no el dato). */
  readonly cargadoEn = signal<Date | null>(null);
  readonly warehouses = signal<AutoabastoWarehouseOpt[]>([]);
  readonly warehouseId = signal<string | null>(null);
  readonly almacenSel = computed<AutoabastoWarehouseOpt | null>(() => {
    const id = this.warehouseId();
    return this.warehouses().find((w) => w.id === id) ?? null;
  });
  /** `true` sólo si los filtros llegaron bien: una lista vacía por error no es «sin almacén». */
  readonly filtrosListos = signal(false);
  readonly filtrosError = signal(false);

  // ── Filtros (de la mesa) ──────────────────────────────────────────────────────────────────
  readonly vista = signal<Vista>('pedido');
  readonly surte = signal<SurteRenglon['tipo'] | null>(null);
  readonly searchRaw = signal('');
  private readonly busqueda = signal('');
  readonly onSearch = makeDebouncedSearch((term) => this.busqueda.set(term.trim()));
  readonly surteOpts = (Object.keys(SURTE_LABEL) as SurteRenglon['tipo'][]).map((value) => ({ value, label: SURTE_LABEL[value] }));
  readonly hayFiltro = computed(() => this.vista() !== 'pedido' || !!this.surte() || !!this.busqueda());

  /** `[AB.23]` Lo que te va a llegar: los primeros, y «ver los N» para el resto (nunca se esconde sin decirlo). */
  readonly verTodoViene = signal(false);
  private static readonly VIENE_VISIBLES = 6;
  readonly viene = computed(() => {
    const v = this.data()?.viene;
    const todo = this.verTodoViene();
    if (!v) return null;
    // En camino primero (lo que llega antes), después los pedidos y al final lo planeado por Compras.
    const orden = { embarque: 0, pedido: 1, plan: 2, requisicion: 3 } as const;
    const docs = [...v.documentos].sort((a, b) => orden[a.tipo] - orden[b.tipo] || a.dias - b.dias);
    const restan = docs.filter((x) => x.se_resta);
    return {
      docs,
      visibles: todo ? docs : docs.slice(0, AlmacenAutoabastoComponent.VIENE_VISIBLES),
      embarques: restan.filter((x) => x.tipo === 'embarque').length,
      pedidos: restan.filter((x) => x.tipo === 'pedido').length,
      monto: restan.reduce((s, x) => s + (x.monto ?? 0), 0),
      viejos: docs.filter((x) => !x.se_resta && x.tipo !== 'plan' && x.tipo !== 'requisicion').length,
      planes: docs.filter((x) => x.tipo === 'plan').length,
      // `[AB.29]` Lo que la sucursal mandó a Compras.
      porAprobar: docs.filter((x) => x.tipo === 'requisicion' && x.estado === 'POR APROBAR').length,
      rechazadas: docs.filter((x) => x.tipo === 'requisicion' && x.estado === 'RECHAZADA').length,
    };
  });

  /** Lo que la persona va moviendo, por producto. Manda sobre el sugerido y sobre lo guardado. */
  readonly edicion = signal<Record<string, Edicion>>({});
  /** Grupos que la persona revisó y aceptó en esta sesión. */
  readonly aceptados = signal<Set<string>>(new Set());
  /** `[AB.19]` Hasta dónde pide: qué posiciones entran al pedido. Se guarda en el borrador. */
  readonly posiciones = signal<Set<PosicionPedido>>(new Set(POSICIONES_PEDIDO_DEFAULT));
  readonly posicionesTodas = POSICIONES_PEDIDO;
  /** Tablas en las que la persona pidió ver todos los renglones. */
  readonly expandidas = signal<Set<string>>(new Set());
  readonly visiblesTabla = VISIBLES_TABLA;
  private posTimer: ReturnType<typeof setTimeout> | null = null;
  /** Error de una acción que no debe tapar el pedido (guardar posiciones, aceptar grupo). */
  readonly aviso = signal<string | null>(null);
  /** `[AB.29]` Enviar a Compras: el diálogo, la nota, el envío en curso y lo que contestó el servidor. */
  readonly envioAbierto = signal(false);
  readonly notaEnvio = signal('');
  readonly enviando = signal(false);
  readonly enviado = signal<AutoabastoEnviarResponse | null>(null);
  readonly imprimiendo = signal(false);
  readonly generandoReporte = signal(false);

  readonly qty = qty;
  readonly faltaNetaPorQue = faltaNetaPorQue;
  readonly estadoPorQue = estadoPorQue;
  readonly motivos = MOTIVOS_AJUSTE;
  readonly umbralPct = Math.round(UMBRAL_MOTIVO * 100);
  readonly minimoMenor = MINIMO_VALOR_MENOR;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.cargarFiltros();
    this.destroyRef.onDestroy(() => {
      this.timers.forEach((t) => clearTimeout(t));
      if (this.posTimer) clearTimeout(this.posTimer);
    });
  }

  readonly medidos = computed(() => this.data()?.pedidos_medidos ?? true);
  /** Todos los renglones del almacén, sin filtro. */
  readonly todas = computed<AutoabastoPedidoLinea[]>(() => (this.data()?.grupos ?? []).flatMap((g) => g.lineas));
  /** Conteos del almacén ENTERO con la regla de la mesa (`resumirRenglones`): el filtro cambia la lista, no esto. */
  readonly resumen = computed<ResumenMesa | null>(() => (this.data() ? resumirRenglones(this.todas()) : null));

  /** Lo que lleva el pedido ahora: posición marcada, no mandado ya, y con cantidad. */
  readonly enPedido = computed<AutoabastoPedidoLinea[]>(() => {
    this.edicion();
    this.posiciones();
    return this.todas().filter((l) => this.incluida(l) && this.cantidad(l) > 0);
  });

  /** El estado con su conteo DENTRO del control: no hay que tocar el filtro para saber si vale la pena. */
  readonly vistaOpts = computed<SegOption[]>(() => {
    const r = this.resumen();
    const n = this.enPedido().length;
    return [
      { label: 'En tu pedido', value: 'pedido', count: n },
      { label: ESTADO_RENGLON_LABEL.ya_viene, value: 'ya_viene', count: r?.por_estado.ya_viene },
      { label: ESTADO_RENGLON_LABEL.lo_pediste, value: 'lo_pediste', count: r?.por_estado.lo_pediste },
      { label: ESTADO_RENGLON_LABEL.compras_lo_planeo, value: 'compras_lo_planeo', count: r?.por_estado.compras_lo_planeo },
      { label: 'Todos', value: 'todos', count: r?.renglones },
    ];
  });

  readonly gruposVisibles = computed<AutoabastoPedidoGrupo[]>(() => {
    const d = this.data();
    const s = this.surte();
    // Se leen siempre: la visibilidad cambia con cada ajuste, con la vista y con la búsqueda.
    this.edicion();
    this.vista();
    this.busqueda();
    this.posiciones();
    if (!d) return [];
    return d.grupos.filter((g) => (!s || g.tipo === s) && this.lineasVisibles(g).length > 0);
  });

  /** Hay al menos un renglón que pedir con las posiciones marcadas (habilita el PDF del pedido). */
  readonly hayQuePedir = computed<boolean>(() => this.enPedido().length > 0);

  /** `[AB.20]` Renglones de las posiciones marcadas que el mínimo de $200 dejó fuera (y nadie subió). */
  readonly debajoMinimo = computed<number>(() => {
    this.edicion();
    this.posiciones();
    return this.todas().filter((l) => l.minimo_menor === 'debajo' && this.incluida(l) && this.cantidad(l) === 0).length;
  });

  /** `[AB.19]` Cuántos renglones con algo que pedir hay en cada posición (marcada o no). */
  readonly conteoPosicion = computed<Record<PosicionPedido, number>>(() => {
    const n: Record<PosicionPedido, number> = { agotado: 0, bajo_minimo: 0, bajo_reorden: 0, otros: 0 };
    this.edicion();
    for (const l of this.todas()) if (this.cantidad(l) > 0 && !yaSeMandoACompras(l)) n[posicionPedido(l.posicion)]++;
    return n;
  });

  /**
   * Primario: cuántos productos faltan por pedir (de la mesa). Después cuánto vale lo que se pide, por a
   * quién, en VIVO con lo que la persona ajustó (de «Mi pedido»). Un importe que no se pudo medir sale
   * «—», nunca $0 (ADR-056).
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    const r = this.resumen();
    const pedido = this.enPedido();
    if (!d || !r) return [];
    const incluidas = this.todas().filter((l) => this.incluida(l));
    const ajustados = incluidas.filter((l) => this.cantidad(l) !== l.a_pedir.cantidad).length;
    const dinero = (label: string, tipo: SurteRenglon['tipo']): MetricStripItem => {
      const ls = pedido.filter((l) => l.surte.tipo === tipo);
      let valor: number | null = null;
      let sin = 0;
      for (const l of ls) { const v = this.valor(l); if (v == null) sin++; else valor = (valor ?? 0) + v; }
      const sub = `${ls.length} ${ls.length === 1 ? 'renglón' : 'renglones'}${sin ? ` · ${sin} sin valuar` : ''}`;
      if (ls.length && valor == null) return { label, value: '—', format: 'text', sub: 'sin medir' };
      return { label, value: valor ?? 0, format: 'currency-short', sub };
    };
    const items: MetricStripItem[] = [
      { label: 'Falta por pedir', value: r.por_estado.sin_pedir, tone: r.por_estado.sin_pedir > 0 ? 'bad' : 'ok',
        sub: `${pedido.length} en tu pedido` },
      dinero('Se pide a la matriz', 'matriz'),
      dinero('Se pide al proveedor', 'proveedor'),
      { label: 'Ajustados por ti', value: ajustados, tone: ajustados > pedido.length * UMBRAL_MOTIVO ? 'warn' : 'ok',
        sub: pedido.length ? `${Math.round((ajustados / pedido.length) * 100)}% de los renglones` : 'ninguno' },
    ];
    if (d.pedidos_medidos) {
      const todas = this.todas();
      items.push(
        // Atorado y negado son avisos del almacén entero: no dependen de hasta dónde pides.
        { label: 'Atorados', value: todas.filter((l) => l.atorado > 0).length, tone: 'warn', sub: 'pedidos de más de 7 días' },
        { label: 'Negados 30 d', value: todas.filter((l) => l.negado_30d > 0).length, tone: 'bad', sub: 'la matriz no surtió' },
      );
    }
    if (r.por_surte.sin_ruta.renglones > 0) {
      items.push({ label: 'Sin ruta', value: r.por_surte.sin_ruta.renglones, tone: 'warn', sub: 'no se sabe a quién pedir' });
    }
    return items;
  });

  // ── Carga ─────────────────────────────────────────────────────────────────────────────────

  private cargarFiltros(): void {
    this.filtrosError.set(false);
    this.svc.filtros().subscribe({
      next: (f) => {
        const ws = f.warehouses ?? [];
        this.warehouses.set(ws);
        this.filtrosListos.set(true);
        // D2: el pedido es de UN almacén. Con uno solo a su alcance, se fija y se carga.
        if (ws.length === 1) this.setWarehouse(ws[0].id);
      },
      // Si no se pudo saber el alcance, se dice: una lista vacía no significa «no tienes almacén».
      error: () => { this.warehouses.set([]); this.filtrosListos.set(false); this.filtrosError.set(true); },
    });
  }

  /** «Recalcular»: si no se supo el alcance, se vuelve a pedir; si ya se sabe, se rearma el pedido. */
  recargar(): void {
    if (!this.filtrosListos()) { this.cargarFiltros(); return; }
    this.cargar();
  }

  setWarehouse(id: string | null): void {
    this.warehouseId.set(id);
    this.enviado.set(null);
    this.data.set(null);
    if (id) this.cargar();
  }

  setVista(v: string): void {
    this.vista.set(v as Vista);
  }

  cargar(): void {
    const id = this.warehouseId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    this.edicion.set({});
    this.aceptados.set(new Set());
    this.expandidas.set(new Set());
    this.svc.pedido(id).subscribe({
      next: (d) => {
        this.data.set(d);
        this.cargadoEn.set(new Date());
        this.posiciones.set(new Set(d.posiciones ?? POSICIONES_PEDIDO_DEFAULT));
        this.loading.set(false);
        // Huella de apertura. Si falla (base de sólo lectura, red), el pedido igual se usa.
        const renglones = d.grupos.reduce((s, g) => s + g.lineas.length, 0);
        this.svc.abrirPedido({ warehouse_id: id, renglones }).subscribe({ error: () => undefined });
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo armar el pedido.');
        this.data.set(null);
        this.loading.set(false);
      },
    });
  }

  // ── El renglón ────────────────────────────────────────────────────────────────────────────

  /** Lo que lleva el pedido en ese renglón: lo que se está moviendo, lo guardado, o el sugerido. */
  cantidad(l: AutoabastoPedidoLinea): number {
    const st = this.edicion()[l.product_id];
    if (st) return st.cantidad;
    return l.ajuste ? l.ajuste.cantidad : l.a_pedir.cantidad;
  }

  motivoDe(l: AutoabastoPedidoLinea): MotivoAjuste | null {
    const st = this.edicion()[l.product_id];
    return st ? st.motivo : (l.ajuste?.motivo ?? null);
  }

  valor(l: AutoabastoPedidoLinea): number | null {
    if (l.costo_base == null || !l.a_pedir.factor) return l.valor;
    return this.cantidad(l) * l.a_pedir.factor * l.costo_base;
  }

  /** `[AB.19]` + `[AB.29]` El renglón entra al pedido si su posición está marcada y no se mandó ya a Compras. */
  incluida(l: AutoabastoPedidoLinea): boolean {
    return this.posiciones().has(posicionPedido(l.posicion)) && !yaSeMandoACompras(l);
  }

  /** Se puede mover con − / + sólo lo que entra al pedido, con permiso y con escalera de unidades. */
  editable(l: AutoabastoPedidoLinea): boolean {
    return !!this.data()?.puede_ajustar && !!l.a_pedir.factor && this.incluida(l);
  }

  /** Por qué un renglón visible NO entra al pedido (sólo se ve fuera de «En tu pedido»). */
  fueraDelPedido(l: AutoabastoPedidoLinea): string | null {
    if (yaSeMandoACompras(l)) return 'Ya lo pediste a Compras';
    if (!this.posiciones().has(posicionPedido(l.posicion))) return 'No entra: su posición no está marcada';
    return null;
  }

  /** La fila de motivos aparece cuando el ajuste pasa del umbral y todavía no tiene motivo. */
  pideMotivo(l: AutoabastoPedidoLinea): boolean {
    if (!this.editable(l)) return false;
    const c = this.cantidad(l);
    if (c === l.a_pedir.cantidad) return false;
    return necesitaMotivo(l.a_pedir.cantidad, c) && (!this.motivoDe(l) || !!this.edicion()[l.product_id]);
  }

  /** Qué renglones del grupo se ven, según la vista, la búsqueda y lo que la persona está moviendo. */
  lineasVisibles(g: AutoabastoPedidoGrupo): AutoabastoPedidoLinea[] {
    const v = this.vista();
    const q = this.busqueda();
    const ed = this.edicion();
    return g.lineas.filter((l) => {
      const enVista = v === 'pedido'
        ? this.incluida(l) && (this.cantidad(l) > 0 || !!ed[l.product_id])
        : v === 'todos' || l.estado === v;
      return enVista && coincideBusqueda(q, l.sku, l.nombre);
    });
  }

  /** `[AB.19]` Las listas de surtido que tiene el grupo, en orden: mayor, menor, única, sin unidad. */
  clasesDe(g: AutoabastoPedidoGrupo): ClaseUnidad[] {
    const vis = this.lineasVisibles(g);
    return CLASES_UNIDAD.filter((cl) => vis.some((l) => this.claseDe(l) === cl));
  }

  lineasDe(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): AutoabastoPedidoLinea[] {
    return this.lineasVisibles(g).filter((l) => this.claseDe(l) === cl);
  }

  /** Lo que pinta la tabla: hasta `VISIBLES_TABLA`, salvo que la persona pidiera ver todos (lo dice abajo). */
  tabla(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): AutoabastoPedidoLinea[] {
    const ls = this.lineasDe(g, cl);
    return this.expandidas().has(this.llaveTabla(g, cl)) ? ls : ls.slice(0, VISIBLES_TABLA);
  }

  llaveTabla(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): string { return `${this.llaveGrupo(g)}|${cl}`; }
  expandir(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): void {
    this.expandidas.update((s) => new Set(s).add(this.llaveTabla(g, cl)));
  }

  /**
   * La lista del renglón. Un API anterior a `[AB.19]` no manda `clase`: sin este respaldo la
   * pantalla escondía TODO el detalle (visto en local, 2026-10-12, con la vista nueva y el API viejo).
   */
  private claseDe(l: AutoabastoPedidoLinea): ClaseUnidad {
    const r = l.a_pedir;
    if (r.clase) return r.clase;
    switch (r.regla) {
      case 'cajas': return 'mayor';
      case 'menor': return 'menor';
      case 'base': case 'granel': return 'unica';
      case 'sin_escalera': return 'sin_unidad';
      default: return r.factor == null ? 'sin_unidad' : r.factor > 1 ? 'mayor' : 'unica';
    }
  }

  totales(g: AutoabastoPedidoGrupo): { renglones: number; ajustados: number; valor: number | null } {
    let renglones = 0, ajustados = 0, valor: number | null = null;
    for (const l of g.lineas) {
      if (!this.incluida(l)) continue;
      const c = this.cantidad(l);
      if (c !== l.a_pedir.cantidad) ajustados++;
      if (c > 0) {
        renglones++;
        const v = this.valor(l);
        if (v != null) valor = (valor ?? 0) + v;
      }
    }
    return { renglones, ajustados, valor };
  }

  /** Totales de una lista de surtido (sólo lo que entra al pedido); `unidades` = cuántas unidades mayores. */
  totalesClase(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): { renglones: number; unidades: number; valor: number | null } {
    let renglones = 0, unidades = 0, valor: number | null = null;
    for (const l of g.lineas) {
      if (this.claseDe(l) !== cl || !this.incluida(l)) continue;
      const c = this.cantidad(l);
      if (c <= 0) continue;
      renglones++;
      unidades += c;
      const v = this.valor(l);
      if (v != null) valor = (valor ?? 0) + v;
    }
    return { renglones, unidades, valor };
  }

  // ── Ajustar (− / +, motivo, volver) ───────────────────────────────────────────────────────

  mover(g: AutoabastoPedidoGrupo, l: AutoabastoPedidoLinea, dir: 1 | -1): void {
    if (!this.editable(l)) return;
    const prev = this.edicion()[l.product_id];
    const cantidad = pasoAjuste(this.cantidad(l), dir);
    this.patch(l.product_id, {
      cantidad,
      motivo: prev?.motivo ?? l.ajuste?.motivo ?? null,
      guardando: false, guardado: false, error: null,
      desde: prev?.desde ?? performance.now(),
    });
    this.programarGuardado(g, l);
  }

  elegirMotivo(l: AutoabastoPedidoLinea, m: MotivoAjuste): void {
    const prev = this.edicion()[l.product_id];
    this.patch(l.product_id, {
      cantidad: this.cantidad(l), motivo: m, guardando: false, guardado: false, error: null,
      desde: prev?.desde ?? performance.now(),
    });
    const g = this.data()?.grupos.find((x) => x.lineas.includes(l));
    if (g) this.guardar(g, l);
  }

  restablecer(l: AutoabastoPedidoLinea): void {
    const id = this.warehouseId();
    if (!id) return;
    const prev = this.edicion()[l.product_id];
    const ms = prev?.desde != null ? Math.round(performance.now() - prev.desde) : null;
    this.cancelarTimer(l.product_id);
    // Movido pero nunca guardado: no hay nada en el servidor, basta con soltar el estado local.
    if (!l.ajuste && !prev?.guardado && !prev?.guardando) {
      this.edicion.update((s) => { const n = { ...s }; delete n[l.product_id]; return n; });
      return;
    }
    // Volver al sugerido: se borra el estado local; si había algo guardado, se borra en el servidor.
    this.patch(l.product_id, { cantidad: l.a_pedir.cantidad, motivo: null, guardando: true, guardado: false, error: null, desde: null });
    this.svc.restablecer({ warehouse_id: id, product_id: l.product_id, ms_en_renglon: ms }).subscribe({
      next: () => { this.quitarAjusteGuardado(l); this.patch(l.product_id, { ...this.edicion()[l.product_id], guardando: false, guardado: true }); },
      error: (e) => this.patch(l.product_id, { ...this.edicion()[l.product_id], guardando: false, error: e?.error?.message ?? 'No se pudo restablecer.' }),
    });
  }

  aceptarGrupo(g: AutoabastoPedidoGrupo): void {
    const id = this.warehouseId();
    if (!id) return;
    const llave = this.llaveGrupo(g);
    this.svc.aceptarGrupo({
      warehouse_id: id, origen_tipo: g.tipo, origen_clave: g.clave,
      renglones: g.lineas.filter((l) => this.incluida(l) && this.cantidad(l) > 0).length,
    }).subscribe({
      next: () => this.aceptados.update((s) => new Set(s).add(llave)),
      error: (e) => this.aviso.set(e?.error?.message ?? 'No se pudo aceptar el grupo.'),
    });
  }

  private programarGuardado(g: AutoabastoPedidoGrupo, l: AutoabastoPedidoLinea): void {
    this.cancelarTimer(l.product_id);
    this.timers.set(l.product_id, setTimeout(() => {
      this.timers.delete(l.product_id);
      const st = this.edicion()[l.product_id];
      // Si pide motivo y no lo tiene, se espera a que la persona lo elija (la fila de motivos ya está a la vista).
      if (st && necesitaMotivo(l.a_pedir.cantidad, st.cantidad) && !st.motivo) return;
      this.guardar(g, l);
    }, ESPERA_GUARDADO_MS));
  }

  private guardar(g: AutoabastoPedidoGrupo, l: AutoabastoPedidoLinea): void {
    const id = this.warehouseId();
    const st = this.edicion()[l.product_id];
    if (!id || !st || !l.a_pedir.factor) return;
    const ms = st.desde != null ? Math.round(performance.now() - st.desde) : null;
    this.patch(l.product_id, { ...st, guardando: true, error: null });
    this.svc.ajustar({
      warehouse_id: id, product_id: l.product_id, sku: l.sku,
      origen_tipo: g.tipo, origen_clave: g.clave,
      sugerido: l.a_pedir.cantidad, unidad: l.a_pedir.unidad, factor: l.a_pedir.factor,
      cantidad: st.cantidad, motivo: st.motivo, ms_en_renglon: ms,
      contexto: {
        venta_30d: l.venta_30d, existencia: l.existencia, objetivo: l.objetivo, falta: l.falta,
        ya_pedido: l.ya_pedido, atorado: l.atorado, negado_30d: l.negado_30d, regla: l.a_pedir.regla, posicion: l.posicion,
      },
    }).subscribe({
      next: () => this.patch(l.product_id, { ...this.edicion()[l.product_id], guardando: false, guardado: true, desde: null }),
      error: (e) => this.patch(l.product_id, { ...this.edicion()[l.product_id], guardando: false, error: e?.error?.message ?? 'No se pudo guardar.' }),
    });
  }

  private quitarAjusteGuardado(l: AutoabastoPedidoLinea): void {
    const d = this.data();
    if (!d) return;
    this.data.set({
      ...d,
      grupos: d.grupos.map((g) => ({ ...g, lineas: g.lineas.map((x) => (x.product_id === l.product_id ? { ...x, ajuste: null } : x)) })),
    });
  }

  private patch(productId: string, r: Edicion): void {
    this.edicion.update((s) => ({ ...s, [productId]: r }));
  }

  private cancelarTimer(productId: string): void {
    const t = this.timers.get(productId);
    if (t) { clearTimeout(t); this.timers.delete(productId); }
  }

  /** `[AB.19]` Marca o desmarca una posición. Se guarda en el borrador tras un momento sin clics. */
  togglePosicion(p: PosicionPedido, on: boolean): void {
    const s = new Set(this.posiciones());
    if (on) s.add(p); else s.delete(p);
    this.posiciones.set(s);
    const d = this.data();
    const id = this.warehouseId();
    if (!d?.puede_ajustar || !d.guardado_disponible || !id) return;
    if (this.posTimer) clearTimeout(this.posTimer);
    this.posTimer = setTimeout(() => {
      this.posTimer = null;
      const lista = POSICIONES_PEDIDO.filter((x) => this.posiciones().has(x));
      this.svc.guardarPosiciones({ warehouse_id: id, posiciones: lista })
        .subscribe({ error: (e) => this.aviso.set(e?.error?.message ?? 'No se pudo guardar hasta dónde pides.') });
    }, ESPERA_GUARDADO_MS);
  }

  // ── [AB.29] Enviar a Compras ───────────────────────────────────────────────────────────────

  /** `[AB.29]` Productos que ya se mandaron a Compras (requisición viva): no entran a este pedido. */
  readonly yaMandados = computed<number>(() => this.todas().filter((l) => yaSeMandoACompras(l)).length);

  /**
   * `[AB.29]` Renglones movidos que todavía no están guardados (esperando, guardándose, con error o
   * esperando motivo). El servidor manda lo GUARDADO: con uno solo pendiente, lo que se enviaría no
   * sería lo que se ve, así que el botón espera.
   */
  readonly sinGuardar = computed<number>(() => Object.values(this.edicion()).filter((r) => !r.guardado).length);

  /**
   * `[AB.29]` Lo que sale con «Enviar a Compras»: lo marcado en «¿Hasta dónde pides?», con cantidad y
   * que de verdad falte por pedir. La regla es la del contrato (`esEnviable`), la misma que aplica el
   * servidor, evaluada con la cantidad que se ve en pantalla. No depende de los filtros de la vista.
   */
  readonly porEnviar = computed(() => {
    this.edicion();
    this.posiciones();
    const grupos: Array<{ llave: string; tipo: AutoabastoPedidoGrupo['tipo']; nombre: string; renglones: number; valor: number | null; ids: string[] }> = [];
    for (const g of this.data()?.grupos ?? []) {
      const ls = g.lineas.filter((l) => this.incluida(l)
        && esEnviable({ ...l, ajuste: null, a_pedir: { ...l.a_pedir, cantidad: this.cantidad(l) } }));
      if (!ls.length) continue;
      let valor: number | null = null;
      for (const l of ls) { const v = this.valor(l); if (v != null) valor = (valor ?? 0) + v; }
      grupos.push({ llave: this.llaveGrupo(g), tipo: g.tipo, nombre: g.tipo === 'matriz' ? (g.clave ?? g.nombre) : g.nombre,
        renglones: ls.length, valor, ids: ls.map((l) => l.product_id) });
    }
    return { grupos, renglones: grupos.reduce((s, g) => s + g.renglones, 0), ids: grupos.flatMap((g) => g.ids) };
  });

  /** `[AB.29]` Por qué el botón está apagado, dicho en el botón. `null` = se puede enviar. */
  porQueNoEnviar(): string | null {
    const n = this.sinGuardar();
    if (n > 0) return `Espera a que se guarden tus cambios (${n} ${n === 1 ? 'renglón' : 'renglones'}): se manda lo guardado.`;
    if (!this.porEnviar().renglones) return 'No te falta nada por pedir con lo que tienes marcado.';
    return null;
  }

  abrirEnvio(): void {
    if (this.porQueNoEnviar()) return;
    this.notaEnvio.set('');
    this.envioAbierto.set(true);
  }

  /** `[AB.29]` El botón se apaga en el primer clic (idempotencia visual); el servidor además tiene su candado. */
  enviar(): void {
    const id = this.warehouseId();
    const ids = this.porEnviar().ids;
    if (!id || !ids.length || this.enviando()) return;
    this.enviando.set(true);
    this.svc.enviar({ warehouse_id: id, product_ids: ids, nota: this.notaEnvio().trim() || null }).subscribe({
      next: (r) => {
        this.enviando.set(false);
        this.envioAbierto.set(false);
        this.enviado.set(r);
        this.cargar(); // lo mandado pasa a «Lo pediste a Compras» y aparece en «Lo que te va a llegar»
      },
      error: (e) => {
        this.enviando.set(false);
        this.aviso.set(e?.error?.message ?? 'No se pudo mandar a Compras. Intenta de nuevo.');
      },
    });
  }

  /** «3 ya lo pediste a Compras · 1 no tiene a quién pedírselo». */
  resumenOmitidos(e: AutoabastoEnviarResponse): string {
    const n = new Map<string, number>();
    for (const o of e.omitidos) n.set(o.motivo, (n.get(o.motivo) ?? 0) + 1);
    return [...n].map(([m, c]) => `${c} ${m.charAt(0).toLowerCase()}${m.slice(1)}`).join(' · ');
  }

  // ── Papel ─────────────────────────────────────────────────────────────────────────────────

  /**
   * `[AB.21]` PDF para la captura manual en Kepler: de un origen (`g`) o de todo el pedido. Lleva
   * exactamente lo que entra al pedido: posiciones marcadas, ajustes (guardados o en curso) y el mínimo
   * de $200. No depende de los filtros de la vista: el pedido es el pedido.
   */
  async pdf(g?: AutoabastoPedidoGrupo): Promise<void> {
    const d = this.data();
    if (!d || this.imprimiendo()) return;
    this.imprimiendo.set(true);
    try {
      const grupos = (g ? [g] : d.grupos).map((x) => this.grupoPdf(x));
      const archivo = await descargarPdfMiPedido({
        almacen: d.almacen,
        fecha_mx: d.fecha_mx,
        hora_mx: d.hora_mx,
        elaboro: this.auth.user()?.username ?? null,
        posiciones: POSICIONES_PEDIDO.filter((p) => this.posiciones().has(p)).map((p) => POSICION_PEDIDO_LABEL[p]),
        grupos,
      });
      if (!archivo) this.aviso.set('No hay nada que pedir con lo que tienes marcado.');
    } catch {
      this.aviso.set('No se pudo generar el PDF. Intenta de nuevo.');
    } finally {
      this.imprimiendo.set(false);
    }
  }

  private grupoPdf(g: AutoabastoPedidoGrupo): MiPedidoPdfGrupo {
    const origen = g.tipo === 'matriz' ? warehouseCodeAndName(g.nombre) : g.nombre;
    return {
      tipo: g.tipo,
      origen,
      aviso: this.avisoMinimo(g),
      listas: CLASES_UNIDAD.map((clase) => ({
        clase,
        renglones: g.lineas
          .filter((l) => this.incluida(l) && this.claseDe(l) === clase && this.cantidad(l) > 0)
          .map((l) => {
            const c = this.cantidad(l);
            const notas: string[] = [];
            if (c !== l.a_pedir.cantidad) {
              const m = this.motivoDe(l);
              // Corto a propósito: en el PDF cabe en una línea de la columna Aviso.
              notas.push(`Ajuste: sug. ${qty(l.a_pedir.cantidad)}${m ? `, ${MOTIVO_AJUSTE_LABEL[m]}` : ''}`);
            }
            if (l.minimo_menor === 'agotado') notas.push('Agotado: se pide aunque sea poco');
            if (l.en_camino > 0) notas.push(`En camino ${qty(l.en_camino)} cj`);
            if (l.atorado > 0) notas.push(`Atorado ${qty(l.atorado)} cj`);
            if (l.negado_30d > 0) notas.push(`Negado 30 d ${qty(l.negado_30d)} cj`);
            return {
              sku: l.sku, nombre: l.nombre, cantidad: c, unidad: l.a_pedir.unidad,
              existencia: l.existencia, venta_30d: l.venta_30d, valor: this.valor(l), nota: notas.join(' · '),
            };
          }),
      })),
    };
  }

  /**
   * El reporte del almacén (el papel que tenía la mesa): todos los productos, con los filtros de estado,
   * origen y búsqueda. Lo arma el servidor con la misma cuenta (`/renglones?todos=1`).
   */
  async reporte(): Promise<void> {
    const id = this.warehouseId();
    if (!id || this.generandoReporte()) return;
    this.generandoReporte.set(true);
    this.aviso.set(null);
    try {
      const v = this.vista();
      const estado = v === 'pedido' || v === 'todos' ? undefined : v;
      const rep = await firstValueFrom(this.svc.renglones({
        warehouse_id: id, estado, surte: this.surte() ?? undefined, search: this.busqueda() || undefined, todos: 1,
      }));
      const filtros: string[] = [];
      if (estado) filtros.push(`Estado: ${ESTADO_RENGLON_LABEL[estado]}`);
      const s = this.surte();
      if (s) filtros.push(`Surte: ${SURTE_LABEL[s]}`);
      if (this.busqueda()) filtros.push(`Búsqueda: «${this.busqueda()}»`);
      const { descargarPdfAutoabasto } = await import('../autoabasto-pdf');
      await descargarPdfAutoabasto(rep, { filtros, generadoPor: this.auth.user()?.username ?? null });
    } catch (err: unknown) {
      const msg = (err as { error?: { message?: string } })?.error?.message;
      this.aviso.set(msg || 'No se pudo generar el reporte. Inténtalo de nuevo.');
    } finally {
      this.generandoReporte.set(false);
    }
  }

  // ── Textos ────────────────────────────────────────────────────────────────────────────────

  etapa(doc: AutoabastoVieneDoc): string {
    return ({ EMBARCADO: 'En camino', AUTORIZADO: 'Autorizado', SURTIDO: 'Surtido', CHECADO: 'Checado', PLANEADO: 'Lo planeó Compras',
      'POR APROBAR': 'Por aprobar', APROBADA: 'Aprobada', RECHAZADA: 'Rechazada' } as Record<string, string>)[doc.estado] ?? doc.estado;
  }
  hace(dias: number): string { return dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : `hace ${dias} días`; }

  /** `[AB.23]` Lo que ya viene y se restó: pedido abierto + embarcado sin recibir. */
  yaViene(l: AutoabastoPedidoLinea): number { return (l.ya_pedido || 0) + (l.en_camino || 0); }
  yaVieneTitle(l: AutoabastoPedidoLinea): string {
    if (!(this.yaViene(l) > 0)) return 'No hay nada en camino ni pedido para este producto.';
    const p: string[] = [];
    if (l.ya_pedido > 0) p.push(`pedido a la matriz ${qty(l.ya_pedido)}`);
    if (l.en_camino > 0) p.push(`en camino ${qty(l.en_camino)}`);
    return `Ya viene: ${p.join(' + ')} cajas. Ya se restó de «A pedir».`;
  }

  /** La cuenta del renglón, para auditarla: falta − ya pedido = neta → cómo se redondeó. */
  porQueAPedir(l: AutoabastoPedidoLinea): string {
    const partes = [l.ya_pedido > 0 ? ` − ya pedido ${qty(l.ya_pedido)}` : '', l.en_camino > 0 ? ` − en camino ${qty(l.en_camino)}` : ''].join('');
    const resta = partes
      ? `Falta ${qty(l.falta)}${partes} = ${qty(l.falta_neta)} cajas.`
      : `Falta ${qty(l.falta_neta)} cajas.`;
    switch (l.a_pedir.regla) {
      case 'cajas': return `${resta} Media caja o más: se piden cajas completas.`;
      case 'menor': return `${resta} Menos de media caja: se pide en ${l.a_pedir.unidad ?? 'la unidad menor'}.`;
      case 'granel': return `${resta} Granel: kilos completos.`;
      case 'base': return `${resta} No tiene caja: se pide en ${l.a_pedir.unidad ?? 'su unidad'}.`;
      case 'sin_escalera': return `${resta} Kepler no trae su escalera de unidades: no se redondeó.`;
      default: return this.yaViene(l) > 0 ? `${resta} Lo que ya viene lo cubre.` : 'Nada que pedir.';
    }
  }

  entrega(l: AutoabastoPedidoLinea): string {
    const dg = l.diagnostico;
    return dg ? cuandoTexto({ next_due_date: dg.next_due_date, cadence_days: dg.cadence_days }) : '—';
  }
  entregaPorQue(l: AutoabastoPedidoLinea): string {
    const dg = l.diagnostico;
    if (!dg) return '';
    return cuandoPorQue({
      next_due_date: dg.next_due_date, cadence_days: dg.cadence_days,
      lead_time_days: dg.lead_time_days, on_hand: l.existencia, avg_daily_units: dg.venta_diaria,
    });
  }

  surtePorQueGrupo(g: AutoabastoPedidoGrupo): string {
    return surtePorQue({ tipo: g.tipo, clave: g.clave, nombre: g.nombre });
  }

  etiquetaEstado(e: EstadoRenglon): string { return ESTADO_RENGLON_LABEL[e] ?? e; }
  severidadEstado(e: EstadoRenglon): 'danger' | 'warn' | 'success' | 'secondary' { return ESTADO_SEVERIDAD[e] ?? 'secondary'; }
  etiquetaClase(cl: ClaseUnidad): string { return CLASE_UNIDAD_LABEL[cl]; }
  ayudaClase(cl: ClaseUnidad): string {
    switch (cl) {
      case 'mayor': return 'cajas, bultos: se surte en una orden';
      case 'menor': return 'piezas, paquetes, kilos: otra orden';
      case 'unica': return 'productos con una sola unidad para todo';
      default: return 'Kepler no trae su unidad: revisarlo';
    }
  }
  etiquetaPosicion(p: PosicionPedido): string { return POSICION_PEDIDO_LABEL[p]; }
  posicion(p: string): string { return POSICION[p] ?? p; }
  etiquetaMotivo(m: MotivoAjuste): string { return MOTIVO_AJUSTE_LABEL[m]; }
  llaveGrupo(g: AutoabastoPedidoGrupo): string { return `${g.tipo}:${g.clave ?? ''}`; }
  tipoTexto(g: AutoabastoPedidoGrupo): string {
    return g.tipo === 'matriz' ? 'Traspaso de' : g.tipo === 'proveedor' ? 'Compra a' : '';
  }

  /** El pedido mínimo del proveedor, sólo si no se alcanza. Sin mínimo registrado, no se dice nada. */
  avisoMinimo(g: AutoabastoPedidoGrupo): string | null {
    if (g.tipo !== 'proveedor') return null;
    const t = this.totales(g);
    if (!t.renglones) return null;
    if (g.minimo_valor != null && t.valor != null && t.valor < g.minimo_valor) {
      return `El proveedor pide un mínimo de $${Math.round(g.minimo_valor).toLocaleString('es-MX')}; este pedido lleva $${Math.round(t.valor).toLocaleString('es-MX')}.`;
    }
    if (g.minimo_cajas != null && g.total_cajas < g.minimo_cajas) {
      return `El proveedor pide un mínimo de ${qty(g.minimo_cajas)} cajas; el sugerido lleva ${qty(g.total_cajas)}.`;
    }
    return null;
  }
}
