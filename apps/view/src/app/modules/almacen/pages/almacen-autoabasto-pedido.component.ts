import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import {
  necesitaMotivo, pasoAjuste, MOTIVOS_AJUSTE, MOTIVO_AJUSTE_LABEL, UMBRAL_MOTIVO,
  posicionPedido, POSICIONES_PEDIDO, POSICIONES_PEDIDO_DEFAULT, POSICION_PEDIDO_LABEL,
  CLASES_UNIDAD, CLASE_UNIDAD_LABEL, MINIMO_VALOR_MENOR, warehouseCodeAndName,
  type ClaseUnidad, type PosicionPedido,
  type MotivoAjuste, type AutoabastoPedidoGrupo, type AutoabastoPedidoLinea, type AutoabastoPedidoResponse,
  type AutoabastoVieneDoc, type AutoabastoEnviarResponse,
  esEnviable, yaSeMandoACompras,
} from '@megadulces/contracts';

import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { AutoabastoService, AutoabastoWarehouseOpt } from '../autoabasto.service';
import { qty } from '../porques.util';
import { descargarPdfMiPedido, type MiPedidoPdfGrupo } from '../mi-pedido-pdf';
import { AuthService } from '../../../core/services/auth.service';

/**
 * `[AB.16]` + `[AB.18]` Fase AB — **«Mi pedido»**: el pedido de la semana de una sucursal, armado
 * por el sistema, agrupado por a quién se le pide, y **ajustado y guardado dentro de la Suite**.
 *
 * ── Por qué no hay Excel (decisión de Francisco, 2026-10-12) ─────────────────────────────────
 * Cada vez que el pedido sale a un Excel, sale del control: ya no se sabe qué se cambió ni por
 * qué. Acá el sistema arma el pedido y la persona sólo corrige EXCEPCIONES con − / + (meta: no más
 * de 20% de los renglones); si se aleja más de 20% del sugerido, elige un motivo de una lista
 * cerrada con un clic. Cada decisión deja HUELLA (lo sugerido que vio, lo que dejó, el motivo,
 * cuánto tardó), que es la materia prima del aprendizaje (etapa 4). El envío a la matriz y a
 * Compras es la etapa 2; el seguimiento contra Kepler, la 3.
 *
 * Los números NO se calculan acá: vienen de `GET /commercial/autoabasto/pedido` (mismo motor que
 * Compras). Las reglas del ajuste —cuándo pide motivo, cómo avanza el − / +— viven en el contrato
 * y las prueba su candado; la pantalla sólo las aplica. Lo único que calcula es el total en vivo
 * mientras la persona mueve cantidades (`cantidad × factor × costo por unidad base`).
 */

const POSICION: Record<string, string> = {
  agotado: 'Agotado', bajo_minimo: 'Bajo mínimo', bajo_reorden: 'Bajo reorden', sano: 'Sano', sobrestock: 'Sobrestock',
};
/** Tiempo sin clics antes de guardar un renglón: deja terminar de mover con − / +. */
const ESPERA_GUARDADO_MS = 700;

/** Estado local de un renglón mientras la persona lo mueve. */
interface Renglon {
  cantidad: number;
  motivo: MotivoAjuste | null;
  guardando: boolean;
  guardado: boolean;
  error: string | null;
  /** Cuándo empezó a trabajar el renglón (para la huella). */
  desde: number | null;
}

@Component({
  selector: 'app-almacen-autoabasto-pedido',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TooltipModule, CheckboxModule, DialogModule, TextareaModule,
    LoadStateComponent, MetricStripComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mp-page">
      <header class="mp-head">
        <div>
          <h1 class="mp-title">Mi pedido</h1>
          <p class="mp-sub">
            El sistema ya armó tu pedido. Revisa por grupo y corrige sólo lo que haga falta con − / +;
            si te alejas más de {{ umbralPct }}% de lo sugerido, elige el motivo. Todo se guarda solo.
            Cuando esté listo, mándalo a Compras.
          </p>
        </div>
        <div class="mp-actions">
          <p-select [options]="warehouses()" optionLabel="name" optionValue="id"
                    [ngModel]="warehouseId()" (ngModelChange)="setWarehouse($event)"
                    placeholder="Elige tu almacén" [filter]="warehouses().length > 6"
                    [disabled]="warehouses().length <= 1" class="mp-wh"></p-select>
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
                  pTooltip="Un PDF con todo el pedido, cada origen en su hoja, para capturarlo en Kepler." tooltipPosition="bottom">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>
            <span class="p-button-label">PDF de todo el pedido</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  (click)="cargar()" [disabled]="loading() || !warehouseId()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Recalcular</span>
          </button>
        </div>
      </header>

      @if (filtrosListos() && !warehouses().length) {
        <p class="mp-note mp-warn" role="note">
          <i class="pi pi-lock" aria-hidden="true"></i>
          No tienes almacén asignado. Pide que te asignen tu almacén en tu ficha de Personas.
        </p>
      }

      @if (data(); as d) {
        @if (!d.puede_ajustar) {
          <p class="mp-note" role="note">
            <i class="pi pi-eye" aria-hidden="true"></i>
            Estás viendo el pedido en modo consulta: para ajustarlo necesitas el permiso de preparar pedidos.
          </p>
        }
        @if (d.puede_ajustar && !d.guardado_disponible) {
          <p class="mp-note mp-warn" role="note">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            Puedes mover las cantidades, pero <strong>no se guardan</strong>: esta base no permite guardar
            el pedido (le falta su actualización o la conexión es de sólo lectura). Al recargar vuelves al sugerido.
          </p>
        }
        @if (!d.pedidos_medidos) {
          <p class="mp-note mp-warn" role="note">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            Este almacén no recibe traspasos por pedido en Kepler: lo ya pedido, lo atorado y lo negado
            <strong>no se midieron</strong> (no es lo mismo que cero).
          </p>
        }
        @if (aviso(); as a) {
          <p class="mp-note mp-warn" role="alert">
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ a }}
            <button type="button" class="mp-link" (click)="aviso.set(null)">cerrar</button>
          </p>
        }
        @if (enviado(); as e) {
          <!-- [AB.29] Lo que pasó al enviar: los folios, a quién le llegó y lo que no se mandó (con su porqué). -->
          <div class="mp-note" [class.mp-ok]="e.requisiciones.length && e.le_llega_a.length"
               [class.mp-warn]="!e.requisiciones.length || !e.le_llega_a.length" role="status">
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
                <span class="mp-dim">
                  {{ e.omitidos.length }} {{ e.omitidos.length === 1 ? 'producto no se mandó' : 'productos no se mandaron' }}:
                  {{ resumenOmitidos(e) }}.
                </span>
              }
            </div>
            <button type="button" class="mp-link" (click)="enviado.set(null)">cerrar</button>
          </div>
        }
        @if (yaMandados(); as n) {
          <p class="mp-note" role="note">
            <i class="pi pi-send" aria-hidden="true"></i>
            {{ n }} {{ n === 1 ? 'producto ya lo pediste' : 'productos ya los pediste' }} a Compras: no entran a este pedido
            para no pedirlos dos veces. Su requisición está abajo, en «Lo que te va a llegar».
          </p>
        }
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen del pedido"></app-metric-strip>
        <!-- [AB.23] Lo que te va a llegar: para no pedir dos veces lo que ya viene. Lo de la ventana ya
             se restó de «A pedir»; lo más viejo se muestra para reclamarlo, no se resta. -->
        @if (viene(); as v) {
          <section class="mp-viene" aria-labelledby="mp-viene-h">
            <h2 id="mp-viene-h" class="mp-viene-h">Lo que te va a llegar</h2>
            @if (!v.docs.length) {
              <p class="mp-dim">No hay pedidos de traspaso abiertos ni embarques en camino hacia {{ d.almacen.code | sucursal }}.</p>
            } @else {
              <p class="mp-viene-res">
                @if (v.embarques) { <strong>{{ v.embarques }} {{ v.embarques === 1 ? 'embarque en camino' : 'embarques en camino' }}</strong> }
                @if (v.embarques && v.pedidos) { y }
                @if (v.pedidos) { <strong>{{ v.pedidos }} {{ v.pedidos === 1 ? 'pedido en preparación' : 'pedidos en preparación' }}</strong> }
                @if (v.monto) { · {{ v.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                @if (v.embarques || v.pedidos) { <span class="mp-dim">— ya se restaron de lo que te toca pedir.</span> }
                @if (v.viejos) { <span class="mp-chip mp-chip-warn">{{ v.viejos }} sin llegar desde hace días: no se restan, reclámalos</span> }
                @if (v.porAprobar) { <span class="mp-chip mp-chip-warn">{{ v.porAprobar }} {{ v.porAprobar === 1 ? 'requisición tuya' : 'requisiciones tuyas' }} por aprobar en Compras</span> }
                @if (v.rechazadas) { <span class="mp-chip mp-chip-bad">{{ v.rechazadas }} {{ v.rechazadas === 1 ? 'rechazada' : 'rechazadas' }}: mira el motivo</span> }
                @if (v.planes) { <span class="mp-chip" pTooltip="Compras ya decidió mandártelo, pero todavía no existe el pedido de traspaso en Kepler: la matriz no lo surte hasta que exista. No se resta." tooltipPosition="top">{{ v.planes }} {{ v.planes === 1 ? 'requisición' : 'requisiciones' }} de Compras sin llegar a Kepler</span> }
              </p>
              <ul class="mp-viene-l">
                @for (doc of v.visibles; track doc.tipo + doc.origen + doc.serie + doc.folio) {
                  <li class="mp-viene-i" [class.mp-viene-viejo]="!doc.se_resta">
                    <span class="mp-viene-et" [class.mp-viene-camino]="doc.tipo === 'embarque'">{{ etapa(doc) }}</span>
                    @if (doc.tipo === 'requisicion' && doc.proveedor) {
                      <span class="mp-viene-de">a <strong>{{ doc.proveedor }}</strong></span>
                    } @else {
                      <span class="mp-viene-de">desde <strong>{{ doc.origen | sucursal }}</strong></span>
                    }
                    <span class="mp-dim">{{ doc.tipo === 'embarque' ? 'Embarque' : doc.tipo === 'pedido' ? 'Pedido' : 'Requisición' }} {{ doc.folio }}</span>
                    <span class="mp-dim">{{ doc.renglones }} {{ doc.renglones === 1 ? 'producto' : 'productos' }}</span>
                    <span class="mp-num">{{ doc.monto == null ? '—' : (doc.monto | currency:'MXN':'symbol-narrow':'1.0-0') }}</span>
                    <span [class.mp-warn-t]="!doc.se_resta && doc.tipo !== 'requisicion'">{{ hace(doc.dias) }}@if (doc.tipo === 'plan') { · aún no está en Kepler } @else if (doc.tipo === 'requisicion') { · la pediste tú } @else if (!doc.se_resta) { · no se resta }</span>
                    @if (doc.motivo) {
                      <span class="mp-viene-motivo"><i class="pi pi-comment" aria-hidden="true"></i> Motivo de Compras: «{{ doc.motivo }}»</span>
                    }
                  </li>
                }
              </ul>
              @if (v.docs.length > v.visibles.length || verTodoViene()) {
                <button type="button" class="mp-link" (click)="verTodoViene.set(!verTodoViene())">
                  {{ verTodoViene() ? 'Ver menos' : 'Ver los ' + v.docs.length }}
                </button>
              }
              @if (d.viene?.renglones_sin_unidad) {
                <p class="mp-dim">{{ d.viene!.renglones_sin_unidad }} renglón(es) vienen en una unidad que la ficha del producto no conoce: no se restaron.</p>
              }
            }
          </section>
        }
        <fieldset class="mp-pos">
          <legend class="mp-pos-leg">¿Hasta dónde pides?</legend>
          @for (p of posicionesTodas; track p) {
            <label class="mp-check mp-pos-op">
              <p-checkbox [binary]="true" [ngModel]="posiciones().has(p)" (ngModelChange)="togglePosicion(p, $event)"
                          [inputId]="'mp-pos-' + p"></p-checkbox>
              <span>{{ etiquetaPosicion(p) }}</span>
              <span class="mp-pos-n">{{ conteoPosicion()[p] }}</span>
            </label>
          }
          @if (!posiciones().size) {
            <span class="mp-dim">Elige al menos una para armar el pedido.</span>
          }
        </fieldset>
        @if (debajoMinimo(); as n) {
          <p class="mp-note" role="note">
            <i class="pi pi-filter" aria-hidden="true"></i>
            {{ n }} {{ n === 1 ? 'renglón' : 'renglones' }} en unidad menor no llegan a
            {{ minimoMenor | currency:'MXN':'symbol-narrow':'1.0-0' }} y no se piden. Para verlos, marca
            «Ver también lo que ya está cubierto».
          </p>
        }
        <div class="mp-tools">
          <label class="mp-check">
            <p-checkbox [binary]="true" [ngModel]="verCubiertos()" (ngModelChange)="verCubiertos.set($event)"
                        inputId="mp-cub"></p-checkbox>
            <span>Ver también lo que ya está cubierto</span>
          </label>
          <span class="mp-stamp">Calculado {{ d.fecha_mx }} {{ d.hora_mx }} · cobertura {{ d.cobertura_dias }} días</span>
        </div>
      }

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!!data() && !gruposVisibles().length"
                      emptyTitle="Nada que pedir"
                      emptyHint="Con la venta de los últimos 30 días y lo que ya pediste, este almacén está cubierto."
                      (retry)="cargar()">
        @for (g of gruposVisibles(); track llaveGrupo(g)) {
          <article class="mp-grupo">
            <header class="mp-ghead">
              <div class="mp-gtitle">
                <span class="mp-gtipo">{{ tipoTexto(g) }}</span>
                <strong>{{ g.tipo === 'matriz' ? (g.nombre | sucursal:'con-codigo') : g.nombre }}</strong>
                @if (aceptados().has(llaveGrupo(g))) {
                  <span class="mp-chip mp-chip-ok"><i class="pi pi-check" aria-hidden="true"></i> Revisado</span>
                }
              </div>
              <div class="mp-gtot">
                @let t = totales(g);
                <span>{{ t.renglones }} renglones</span>
                @if (t.ajustados > 0) { <span class="mp-dim">{{ t.ajustados }} ajustados</span> }
                <span class="mp-strong">{{ t.valor == null ? '—' : (t.valor | currency:'MXN':'symbol-narrow':'1.0-0') }}</span>
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
            @if (avisoMinimo(g); as aviso) {
              <p class="mp-note mp-warn mp-gnote" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ aviso }}</p>
            }
            @for (cl of clasesDe(g); track cl) {
            @let tc = totalesClase(g, cl);
            <div class="mp-clase">
              <span class="mp-clase-tit">{{ etiquetaClase(cl) }}</span>
              <span class="mp-dim">{{ ayudaClase(cl) }}</span>
              <span class="mp-clase-tot">
                {{ tc.renglones }} renglones
                @if (cl === 'mayor' && tc.unidades > 0) { · {{ qty(tc.unidades) }} unidades mayores }
                · {{ tc.valor == null ? '—' : (tc.valor | currency:'MXN':'symbol-narrow':'1.0-0') }}
              </span>
            </div>
            <div class="mp-scroll">
              <table class="mp-table">
                <thead>
                  <tr>
                    <th class="mp-c-sku">SKU / Producto</th>
                    <th class="mp-num" pTooltip="Venta de los últimos 30 días, en cajas." tooltipPosition="top">Venta 30 d</th>
                    <th class="mp-num">Existencia</th>
                    <th class="mp-num" pTooltip="Lo que ya te viene y ya se restó: pedidos abiertos a la matriz de 7 días o menos, más lo embarcado que todavía no recibes." tooltipPosition="top">Ya viene</th>
                    <th class="mp-num mp-c-pedir">A pedir</th>
                    <th class="mp-num">Valor</th>
                    <th>Avisos</th>
                  </tr>
                </thead>
                <tbody>
                  @for (l of lineasDe(g, cl); track l.product_id) {
                    @let c = cantidad(l);
                    <tr [class.mp-cubierto]="!c" [class.mp-ajustada]="c !== l.a_pedir.cantidad">
                      <td class="mp-c-sku">
                        <span class="mp-sku">{{ l.sku }}</span>
                        <span class="mp-name">{{ l.nombre }}</span>
                      </td>
                      <td class="mp-num">{{ l.venta_30d == null ? '—' : qty(l.venta_30d) }}</td>
                      <td class="mp-num">{{ qty(l.existencia) }}</td>
                      <td class="mp-num" [pTooltip]="yaVieneTitle(l)" tooltipPosition="top">{{ yaViene(l) > 0 ? qty(yaViene(l)) : '—' }}</td>
                      <td class="mp-num mp-c-pedir" [pTooltip]="porQueAPedir(l)" tooltipPosition="left">
                        @if (data()?.puede_ajustar && l.a_pedir.factor) {
                          <span class="mp-step">
                            <button type="button" class="mp-stepbtn" (click)="mover(g, l, -1)" [disabled]="!c"
                                    [attr.aria-label]="'Bajar ' + l.nombre">−</button>
                            <span class="mp-val">{{ qty(c) }}</span>
                            <button type="button" class="mp-stepbtn" (click)="mover(g, l, 1)"
                                    [attr.aria-label]="'Subir ' + l.nombre">+</button>
                            <span class="mp-unit">{{ l.a_pedir.unidad ?? '' }}</span>
                          </span>
                        } @else {
                          @if (c > 0) { <span class="mp-strong">{{ qty(c) }}</span> <span class="mp-unit">{{ l.a_pedir.unidad ?? 'sin unidad' }}</span> } @else { — }
                        }
                        @if (c !== l.a_pedir.cantidad) {
                          <span class="mp-sug">sugerido {{ qty(l.a_pedir.cantidad) }}
                            @if (data()?.puede_ajustar) {
                              · <button type="button" class="mp-link" (click)="restablecer(l)">volver</button>
                            }
                          </span>
                        }
                        @let st = estado()[l.product_id];
                        @if (st?.guardando) { <span class="mp-save mp-dim">guardando…</span> }
                        @else if (st?.error) { <span class="mp-save mp-err" [pTooltip]="st.error">no se guardó</span> }
                        @else if (st?.guardado) { <span class="mp-save mp-okc">guardado</span> }
                      </td>
                      <td class="mp-num">{{ valor(l) == null ? '—' : (valor(l) | currency:'MXN':'symbol-narrow':'1.0-0') }}</td>
                      <td class="mp-flags">
                        <span class="mp-chip">{{ posicion(l.posicion) }}</span>
                        @if (l.planeado_compras > 0) {
                          <span class="mp-chip" [pTooltip]="'Compras ya decidió mandarte ' + qty(l.planeado_compras) + ' cajas, pero todavía no está en Kepler: no se resta hasta que exista el pedido de traspaso.'" tooltipPosition="left">Compras {{ qty(l.planeado_compras) }}</span>
                        }
                        @if (l.atorado > 0) {
                          <span class="mp-chip mp-chip-warn" [pTooltip]="'Pedido abierto hace más de 7 días: ' + qty(l.atorado) + ' cajas. No se resta: reclámalo o cancélalo.'" tooltipPosition="left">Atorado {{ qty(l.atorado) }}</span>
                        }
                        @if (l.negado_30d > 0) {
                          <span class="mp-chip mp-chip-bad" [pTooltip]="'La matriz no surtió ' + qty(l.negado_30d) + ' cajas en los últimos 30 días.'" tooltipPosition="left">Negado {{ qty(l.negado_30d) }}</span>
                        }
                        @if (l.minimo_menor === 'debajo') {
                          <span class="mp-chip mp-chip-warn" [pTooltip]="'En unidad menor valía ' + ((l.valor_menor ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0') + ', menos del mínimo de ' + (minimoMenor | currency:'MXN':'symbol-narrow':'1.0-0') + '. No se pide; súbelo con + si lo necesitas.'" tooltipPosition="left">Menos de {{ minimoMenor | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                        }
                        @if (l.minimo_menor === 'agotado') {
                          <span class="mp-chip" [pTooltip]="'Vale ' + ((l.valor_menor ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0') + ', menos del mínimo, pero está agotado: se pide igual.'" tooltipPosition="left">Agotado: se pide aunque sea poco</span>
                        }
                        @if (l.minimo_menor === 'sin_costo') {
                          <span class="mp-chip" pTooltip="No tiene costo confiable: no se pudo revisar el mínimo en unidad menor. Se deja como está." tooltipPosition="left">Mínimo sin revisar</span>
                        }
                        @if (l.a_pedir.regla === 'sin_escalera') {
                          <span class="mp-chip" pTooltip="Kepler no trae su escalera de unidades: la cantidad no se redondeó y no se puede ajustar." tooltipPosition="left">Sin unidad</span>
                        }
                      </td>
                    </tr>
                    @if (pideMotivo(l)) {
                      <tr class="mp-motivo-row">
                        <td colspan="7">
                          <span class="mp-motivo-txt">¿Por qué te alejas de lo sugerido?</span>
                          @for (m of motivos; track m) {
                            <button type="button" class="mp-motivo" [class.mp-motivo-on]="motivoDe(l) === m"
                                    (click)="elegirMotivo(l, m)">{{ etiquetaMotivo(m) }}</button>
                          }
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
            }
          </article>
        }
      </app-load-state>

      <!-- [AB.29] Confirmar el envío: qué sale, a quién se le pide y quién lo aprueba. -->
      <p-dialog [visible]="envioAbierto()" (visibleChange)="envioAbierto.set($event)" [modal]="true"
                [style]="{ width: '34rem' }" [breakpoints]="{ '40rem': '95vw' }" header="Enviar a Compras" [dismissableMask]="!enviando()">
        @let pe = porEnviar();
        <p class="mp-env-p">
          Se mandan <strong>{{ pe.renglones }} {{ pe.renglones === 1 ? 'producto' : 'productos' }}</strong> que te faltan por pedir,
          en {{ pe.grupos.length }} {{ pe.grupos.length === 1 ? 'requisición' : 'requisiciones' }} (una por a quién se le pide):
        </p>
        <ul class="mp-env-l">
          @for (g of pe.grupos; track g.llave) {
            <li>
              <span>{{ g.tipo === 'matriz' ? 'Traspaso de' : 'Compra a' }} <strong>{{ g.tipo === 'matriz' ? (g.nombre | sucursal) : g.nombre }}</strong></span>
              <span class="mp-dim">{{ g.renglones }} {{ g.renglones === 1 ? 'producto' : 'productos' }}</span>
              <span class="mp-num">{{ g.valor == null ? '—' : (g.valor | currency:'MXN':'symbol-narrow':'1.0-0') }}</span>
            </li>
          }
        </ul>
        <p class="mp-env-p mp-dim">
          Van con las cantidades que dejaste y sólo lo marcado en «¿Hasta dónde pides?». Le llegan a Compras para
          aprobarlas o rechazarlas con motivo; mientras tanto no se vuelven a pedir.
        </p>
        <label class="mp-env-lab" for="mp-env-nota">Nota para Compras <span class="mp-dim">(opcional)</span></label>
        <textarea pTextarea id="mp-env-nota" class="mp-env-nota" rows="3" maxlength="500"
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

      <p class="mp-foot">
        Tu pedido se guarda en la Suite con cada ajuste. «Enviar a Compras» manda lo que te falta por pedir
        como requisición, para que Compras la apruebe. Cantidades en cajas salvo A pedir, que va en la unidad en que se captura.
      </p>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .mp-page { display: flex; flex-direction: column; gap: 1rem; padding: 1rem 1.15rem 1.5rem; }
    .mp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .mp-title { margin: 0; font-size: var(--fs-h2); font-weight: 650; letter-spacing: -.01em; color: var(--text-main); }
    .mp-sub { margin: .3rem 0 0; max-width: 66ch; font-size: var(--fs-body); line-height: 1.5; color: var(--text-muted); }
    .mp-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .mp-wh { min-width: 15rem; }
    /* [AB.23] Lo que te va a llegar */
    .mp-viene { border: 1px solid var(--border-color); border-radius: 8px; padding: .6rem .8rem; background: var(--card-bg); }
    .mp-viene-h { margin: 0 0 .3rem; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .mp-viene-res { margin: 0 0 .4rem; font-size: var(--fs-sm); color: var(--text-main); display: flex; flex-wrap: wrap; gap: .25rem .5rem; align-items: baseline; }
    .mp-viene-l { list-style: none; margin: 0; padding: 0; display: grid; gap: .15rem; }
    .mp-viene-i { display: grid; grid-template-columns: 6.5rem minmax(9rem, 1.4fr) minmax(7rem, 1fr) 6rem 6.5rem minmax(7rem, 1fr);
      gap: .5rem; align-items: baseline; font-size: var(--fs-sm); padding: .2rem 0; border-top: 1px solid var(--border-color); }
    .mp-viene-i:first-child { border-top: 0; }
    .mp-viene-et { font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .mp-viene-et.mp-viene-camino { color: var(--info-fg); }
    .mp-viene-viejo { color: var(--text-muted); }
    .mp-warn-t { color: var(--warn-fg); }
    @container (max-width: 40rem) { .mp-viene-i { grid-template-columns: 1fr 1fr; } }
    .mp-note { display: flex; gap: .55rem; align-items: flex-start; margin: 0; padding: .6rem .8rem; border-radius: 8px;
      font-size: var(--fs-sm); line-height: 1.45; background: var(--surface-100); color: var(--text-muted); }
    .mp-warn { background: var(--warn-soft-bg); color: var(--text-main); }
    /* [AB.29] Enviar a Compras */
    .mp-ok { background: var(--ok-soft-bg); color: var(--text-main); }
    .mp-viene-motivo { grid-column: 1 / -1; font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    .mp-env-p { margin: 0 0 .5rem; font-size: var(--fs-sm); line-height: 1.45; color: var(--text-main); }
    .mp-env-l { list-style: none; margin: 0 0 .6rem; padding: 0; display: grid; gap: .2rem; }
    .mp-env-l li { display: grid; grid-template-columns: 1fr auto 6.5rem; gap: .6rem; align-items: baseline;
      font-size: var(--fs-sm); padding: .25rem 0; border-top: 1px solid var(--border-color); }
    .mp-env-l li:first-child { border-top: 0; }
    .mp-env-lab { display: block; margin: .2rem 0 .25rem; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .mp-env-nota { width: 100%; }
    .mp-tools { display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .mp-pos { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.1rem; margin: 0; padding: .55rem .8rem;
      border: 1px solid var(--surface-200); border-radius: 8px; background: var(--surface-card); }
    .mp-pos-leg { float: left; padding: 0; margin-right: .4rem; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .mp-pos-n { min-width: 1.6rem; padding: 0 .4rem; border-radius: 999px; background: var(--surface-100);
      font-size: var(--fs-micro); text-align: center; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .mp-clase { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; padding: .55rem .9rem .3rem;
      border-top: 1px solid var(--surface-100); font-size: var(--fs-sm); }
    .mp-clase-tit { font-weight: 650; color: var(--text-main); }
    .mp-clase-tot { margin-left: auto; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .mp-check { display: inline-flex; gap: .5rem; align-items: center; font-size: var(--fs-body); color: var(--text-main); cursor: pointer; }
    .mp-stamp { font-size: var(--fs-xs); color: var(--text-muted); }

    .mp-grupo { border: 1px solid var(--surface-200); border-radius: 10px; background: var(--surface-card); overflow: hidden; }
    .mp-ghead { display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap;
      padding: .65rem .9rem; background: var(--surface-ground); border-bottom: 1px solid var(--surface-200); }
    .mp-gtitle { display: flex; align-items: center; gap: .5rem; color: var(--text-main); }
    .mp-gtipo { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .mp-gtot { display: flex; gap: .85rem; align-items: center; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-main);
      font-variant-numeric: tabular-nums; }
    .mp-gnote { margin: .5rem .9rem 0; }

    .mp-scroll { overflow-x: auto; }
    .mp-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .mp-table th { text-align: left; font-weight: 600; font-size: var(--fs-xs); color: var(--text-muted); padding: .45rem .6rem;
      border-bottom: 1px solid var(--surface-200); white-space: nowrap; }
    .mp-table td { padding: .4rem .6rem; border-bottom: 1px solid var(--surface-100); vertical-align: middle; color: var(--text-main); }
    .mp-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .mp-strong { font-weight: 650; }
    .mp-dim { color: var(--text-muted); }
    .mp-unit { font-size: var(--fs-micro); font-weight: 500; color: var(--text-muted); margin-left: .2rem; }
    .mp-c-sku { min-width: 15rem; }
    .mp-c-pedir { min-width: 11rem; }
    .mp-sku { display: block; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-name { display: block; }
    .mp-cubierto td { color: var(--text-muted); }
    .mp-ajustada td.mp-c-pedir { background: var(--surface-ground); }

    .mp-step { display: inline-flex; align-items: center; gap: .3rem; }
    .mp-stepbtn { width: 1.9rem; height: 1.9rem; border-radius: 6px; border: 1px solid var(--border-color);
      background: var(--surface-card); color: var(--text-main); font-size: var(--fs-h3); font-weight: 650; line-height: 1; cursor: pointer; }
    .mp-stepbtn:hover:not(:disabled) { border-color: var(--action); color: var(--action); }
    .mp-stepbtn:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .mp-stepbtn:disabled { opacity: .4; cursor: default; }
    .mp-val { min-width: 2.4rem; text-align: center; font-weight: 650; }
    .mp-sug { display: block; font-size: var(--fs-micro); color: var(--text-muted); margin-top: .1rem; }
    .mp-link { border: 0; background: none; padding: 0; color: var(--action); font-size: var(--fs-micro); cursor: pointer; text-decoration: underline; }
    .mp-save { display: block; font-size: var(--fs-nano); margin-top: .1rem; }
    .mp-okc { color: var(--ok-soft-fg); }
    .mp-err { color: var(--bad-soft-fg); cursor: help; }

    .mp-motivo-row td { background: var(--surface-hover); padding: .45rem .6rem .55rem 1rem; }
    .mp-motivo-txt { font-size: var(--fs-xs); color: var(--text-main); margin-right: .5rem; }
    .mp-motivo { margin: .15rem .3rem .15rem 0; padding: .2rem .6rem; border-radius: 999px; border: 1px solid var(--border-color);
      background: var(--surface-card); font-size: var(--fs-xs); color: var(--text-main); cursor: pointer; }
    .mp-motivo:hover { border-color: var(--action); }
    .mp-motivo-on { background: var(--action); border-color: var(--action); color: var(--action-ink); }

    .mp-flags { white-space: nowrap; }
    .mp-chip { display: inline-flex; align-items: center; gap: .25rem; margin: 0 .25rem .15rem 0; padding: .05rem .45rem; border-radius: 999px;
      font-size: var(--fs-micro); background: var(--surface-100); color: var(--text-muted); }
    .mp-chip-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .mp-chip-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .mp-chip-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .mp-foot { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    @media (max-width: 56.25rem) { .mp-wh { min-width: 100%; } }
  `],
})
export class AlmacenAutoabastoPedidoComponent {
  private readonly svc = inject(AutoabastoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<AutoabastoPedidoResponse | null>(null);
  readonly warehouses = signal<AutoabastoWarehouseOpt[]>([]);
  readonly warehouseId = signal<string | null>(null);
  /** `true` sólo si los filtros llegaron bien: una lista vacía por error no es «sin almacén». */
  readonly filtrosListos = signal(false);
  readonly verCubiertos = signal(false);
  /** `[AB.23]` Lo que te va a llegar: los primeros, y «ver los N» para el resto (nunca se esconde sin decirlo). */
  readonly verTodoViene = signal(false);
  private static readonly VIENE_VISIBLES = 6;
  readonly viene = computed(() => {
    const v = this.data()?.viene;
    if (!v) return null;
    // En camino primero (lo que llega antes), después los pedidos y al final lo planeado por Compras.
    const orden = { embarque: 0, pedido: 1, plan: 2, requisicion: 3 } as const;
    const docs = [...v.documentos].sort((a, b) => orden[a.tipo] - orden[b.tipo] || a.dias - b.dias);
    const restan = docs.filter((x) => x.se_resta);
    return {
      docs,
      visibles: this.verTodoViene() ? docs : docs.slice(0, AlmacenAutoabastoPedidoComponent.VIENE_VISIBLES),
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
  /** Lo que la persona va moviendo, por producto. Manda sobre el sugerido y sobre lo guardado. */
  readonly estado = signal<Record<string, Renglon>>({});
  /** Grupos que la persona revisó y aceptó en esta sesión. */
  readonly aceptados = signal<Set<string>>(new Set());
  /** `[AB.19]` Hasta dónde pide: qué posiciones entran al pedido. Se guarda en el borrador. */
  readonly posiciones = signal<Set<PosicionPedido>>(new Set(POSICIONES_PEDIDO_DEFAULT));
  readonly posicionesTodas = POSICIONES_PEDIDO;
  private posTimer: ReturnType<typeof setTimeout> | null = null;
  /** Error de una acción que no debe tapar el pedido (guardar posiciones, aceptar grupo). */
  readonly aviso = signal<string | null>(null);
  /** `[AB.29]` Enviar a Compras: el diálogo, la nota, el envío en curso y lo que contestó el servidor. */
  readonly envioAbierto = signal(false);
  readonly notaEnvio = signal('');
  readonly enviando = signal(false);
  readonly enviado = signal<AutoabastoEnviarResponse | null>(null);

  readonly qty = qty;
  readonly motivos = MOTIVOS_AJUSTE;
  readonly umbralPct = Math.round(UMBRAL_MOTIVO * 100);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.svc.filtros().subscribe({
      next: (f) => {
        const ws = f.warehouses ?? [];
        this.warehouses.set(ws);
        this.filtrosListos.set(true);
        // El pedido es de UN almacén: con uno solo a su alcance, se fija y se carga.
        if (ws.length === 1) this.setWarehouse(ws[0].id);
      },
      error: () => { this.warehouses.set([]); this.filtrosListos.set(false); },
    });
    this.destroyRef.onDestroy(() => {
      this.timers.forEach((t) => clearTimeout(t));
      if (this.posTimer) clearTimeout(this.posTimer);
    });
  }

  readonly gruposVisibles = computed<AutoabastoPedidoGrupo[]>(() => {
    const d = this.data();
    if (!d) return [];
    this.estado(); // los totales y la visibilidad cambian con cada ajuste
    return d.grupos.filter((g) => this.lineasVisibles(g).length > 0);
  });

  readonly minimoMenor = MINIMO_VALOR_MENOR;
  readonly imprimiendo = signal(false);

  /** Hay al menos un renglón que pedir con las posiciones marcadas (habilita el PDF de todo). */
  readonly hayQuePedir = computed<boolean>(() => {
    this.estado();
    this.posiciones();
    return (this.data()?.grupos ?? []).some((g) => g.lineas.some((l) => this.incluida(l) && this.cantidad(l) > 0));
  });

  /** `[AB.20]` Renglones de las posiciones marcadas que el mínimo de $200 dejó fuera (y nadie subió). */
  readonly debajoMinimo = computed<number>(() => {
    this.estado();
    this.posiciones();
    let n = 0;
    for (const g of this.data()?.grupos ?? []) {
      for (const l of g.lineas) if (l.minimo_menor === 'debajo' && this.incluida(l) && this.cantidad(l) === 0) n++;
    }
    return n;
  });

  /** `[AB.19]` Cuántos renglones con algo que pedir hay en cada posición (marcada o no). */
  readonly conteoPosicion = computed<Record<PosicionPedido, number>>(() => {
    const n: Record<PosicionPedido, number> = { agotado: 0, bajo_minimo: 0, bajo_reorden: 0, otros: 0 };
    this.estado();
    for (const g of this.data()?.grupos ?? []) {
      for (const l of g.lineas) if (this.cantidad(l) > 0 && !yaSeMandoACompras(l)) n[posicionPedido(l.posicion)]++;
    }
    return n;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    this.estado();
    this.posiciones();
    const todas = d.grupos.flatMap((g) => g.lineas);
    const lineas = todas.filter((l) => this.incluida(l));
    const aPedir = lineas.filter((l) => this.cantidad(l) > 0);
    const ajustados = lineas.filter((l) => this.cantidad(l) !== l.a_pedir.cantidad);
    const valor = aPedir.reduce((s, l) => s + (this.valor(l) ?? 0), 0);
    const items: MetricStripItem[] = [
      { label: 'A pedir', value: aPedir.length, tone: 'brand', sub: `${d.grupos.filter((g) => g.lineas.some((l) => this.incluida(l) && this.cantidad(l) > 0)).length} orígenes` },
      { label: 'Valor del pedido', value: valor, format: 'currency-short', tone: 'default', sub: 'a costo' },
      { label: 'Ajustados por ti', value: ajustados.length, tone: ajustados.length > aPedir.length * UMBRAL_MOTIVO ? 'warn' : 'ok',
        sub: aPedir.length ? `${Math.round((ajustados.length / aPedir.length) * 100)}% de los renglones` : 'ninguno' },
    ];
    if (d.pedidos_medidos) {
      items.push(
        // Atorado y negado son avisos del almacén entero: no dependen de hasta dónde pides.
        { label: 'Atorados', value: todas.filter((l) => l.atorado > 0).length, tone: 'warn', sub: 'pedidos de más de 7 días' },
        { label: 'Negados 30 d', value: todas.filter((l) => l.negado_30d > 0).length, tone: 'bad', sub: 'la matriz no surtió' },
      );
    }
    return items;
  });

  setWarehouse(id: string | null): void {
    this.warehouseId.set(id);
    this.enviado.set(null);
    if (id) this.cargar();
  }

  cargar(): void {
    const id = this.warehouseId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    this.estado.set({});
    this.aceptados.set(new Set());
    this.svc.pedido(id).subscribe({
      next: (d) => {
        this.data.set(d);
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

  /** Lo que lleva el pedido en ese renglón: lo que se está moviendo, lo guardado, o el sugerido. */
  cantidad(l: AutoabastoPedidoLinea): number {
    const st = this.estado()[l.product_id];
    if (st) return st.cantidad;
    return l.ajuste ? l.ajuste.cantidad : l.a_pedir.cantidad;
  }

  motivoDe(l: AutoabastoPedidoLinea): MotivoAjuste | null {
    const st = this.estado()[l.product_id];
    return st ? st.motivo : (l.ajuste?.motivo ?? null);
  }

  valor(l: AutoabastoPedidoLinea): number | null {
    if (l.costo_base == null || !l.a_pedir.factor) return l.valor;
    return this.cantidad(l) * l.a_pedir.factor * l.costo_base;
  }

  /** La fila de motivos aparece cuando el ajuste pasa del umbral y todavía no tiene motivo. */
  pideMotivo(l: AutoabastoPedidoLinea): boolean {
    if (!this.data()?.puede_ajustar) return false;
    const c = this.cantidad(l);
    if (c === l.a_pedir.cantidad) return false;
    return necesitaMotivo(l.a_pedir.cantidad, c) && (!this.motivoDe(l) || !!this.estado()[l.product_id]);
  }

  mover(g: AutoabastoPedidoGrupo, l: AutoabastoPedidoLinea, dir: 1 | -1): void {
    const prev = this.estado()[l.product_id];
    const actual = this.cantidad(l);
    const cantidad = pasoAjuste(actual, dir);
    this.patch(l.product_id, {
      cantidad,
      motivo: prev?.motivo ?? l.ajuste?.motivo ?? null,
      guardando: false, guardado: false, error: null,
      desde: prev?.desde ?? performance.now(),
    });
    this.programarGuardado(g, l);
  }

  elegirMotivo(l: AutoabastoPedidoLinea, m: MotivoAjuste): void {
    const prev = this.estado()[l.product_id];
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
    const prev = this.estado()[l.product_id];
    const ms = prev?.desde != null ? Math.round(performance.now() - prev.desde) : null;
    this.cancelarTimer(l.product_id);
    // Movido pero nunca guardado: no hay nada en el servidor, basta con soltar el estado local.
    if (!l.ajuste && !prev?.guardado && !prev?.guardando) {
      this.estado.update((s) => { const n = { ...s }; delete n[l.product_id]; return n; });
      return;
    }
    // Volver al sugerido: se borra el estado local; si había algo guardado, se borra en el servidor.
    this.patch(l.product_id, { cantidad: l.a_pedir.cantidad, motivo: null, guardando: true, guardado: false, error: null, desde: null });
    this.svc.restablecer({ warehouse_id: id, product_id: l.product_id, ms_en_renglon: ms }).subscribe({
      next: () => { this.quitarAjusteGuardado(l); this.patch(l.product_id, { ...this.estado()[l.product_id], guardando: false, guardado: true }); },
      error: (e) => this.patch(l.product_id, { ...this.estado()[l.product_id], guardando: false, error: e?.error?.message ?? 'No se pudo restablecer.' }),
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
      const st = this.estado()[l.product_id];
      // Si pide motivo y no lo tiene, se espera a que la persona lo elija (la fila de motivos ya está a la vista).
      if (st && necesitaMotivo(l.a_pedir.cantidad, st.cantidad) && !st.motivo) return;
      this.guardar(g, l);
    }, ESPERA_GUARDADO_MS));
  }

  private guardar(g: AutoabastoPedidoGrupo, l: AutoabastoPedidoLinea): void {
    const id = this.warehouseId();
    const st = this.estado()[l.product_id];
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
      next: () => this.patch(l.product_id, { ...this.estado()[l.product_id], guardando: false, guardado: true, desde: null }),
      error: (e) => this.patch(l.product_id, { ...this.estado()[l.product_id], guardando: false, error: e?.error?.message ?? 'No se pudo guardar.' }),
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

  private patch(productId: string, r: Renglon): void {
    this.estado.update((s) => ({ ...s, [productId]: r }));
  }

  private cancelarTimer(productId: string): void {
    const t = this.timers.get(productId);
    if (t) { clearTimeout(t); this.timers.delete(productId); }
  }

  // ── [AB.29] Enviar a Compras ───────────────────────────────────────────────────────────────

  /** `[AB.29]` Productos que ya se mandaron a Compras (requisición viva): no entran a este pedido. */
  readonly yaMandados = computed<number>(() =>
    (this.data()?.grupos ?? []).reduce((s, g) => s + g.lineas.filter((l) => yaSeMandoACompras(l)).length, 0));

  /**
   * `[AB.29]` Renglones movidos que todavía no están guardados (esperando, guardándose, con error o
   * esperando motivo). El servidor manda lo GUARDADO: con uno solo pendiente, lo que se enviaría no
   * sería lo que se ve, así que el botón espera.
   */
  readonly sinGuardar = computed<number>(() => Object.values(this.estado()).filter((r) => !r.guardado).length);

  /**
   * `[AB.29]` Lo que sale con «Enviar a Compras»: lo marcado en «¿Hasta dónde pides?», con cantidad y
   * que de verdad falte por pedir. La regla es la del contrato (`esEnviable`), la misma que aplica el
   * servidor, evaluada con la cantidad que se ve en pantalla.
   */
  readonly porEnviar = computed(() => {
    this.estado();
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

  /**
   * `[AB.21]` PDF para la captura manual en Kepler: de un origen (`g`) o de todo el pedido. Lleva
   * exactamente lo que se ve: posiciones marcadas, ajustes (guardados o en curso) y el mínimo de $200.
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

  /** `[AB.19]` El renglón entra al pedido si su posición está marcada. */
  incluida(l: AutoabastoPedidoLinea): boolean {
    // `[AB.29]` Lo que ya se mandó a Compras no entra: ni a los grupos, ni a los totales, ni al PDF.
    return this.posiciones().has(posicionPedido(l.posicion)) && !yaSeMandoACompras(l);
  }

  lineasVisibles(g: AutoabastoPedidoGrupo): AutoabastoPedidoLinea[] {
    return g.lineas.filter((l) => this.incluida(l)
      && (this.verCubiertos() || this.cantidad(l) > 0 || !!this.estado()[l.product_id]));
  }

  /** `[AB.19]` Las listas de surtido que tiene el grupo, en orden: mayor, menor, única, sin unidad. */
  clasesDe(g: AutoabastoPedidoGrupo): ClaseUnidad[] {
    const vis = this.lineasVisibles(g);
    return CLASES_UNIDAD.filter((cl) => vis.some((l) => this.claseDe(l) === cl));
  }

  lineasDe(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): AutoabastoPedidoLinea[] {
    return this.lineasVisibles(g).filter((l) => this.claseDe(l) === cl);
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

  /** Totales de una lista de surtido; `unidades` = cuántas unidades mayores (sólo tiene sentido en la mayor). */
  totalesClase(g: AutoabastoPedidoGrupo, cl: ClaseUnidad): { renglones: number; unidades: number; valor: number | null } {
    let renglones = 0, unidades = 0, valor: number | null = null;
    for (const l of this.lineasDe(g, cl)) {
      const c = this.cantidad(l);
      if (c <= 0) continue;
      renglones++;
      unidades += c;
      const v = this.valor(l);
      if (v != null) valor = (valor ?? 0) + v;
    }
    return { renglones, unidades, valor };
  }

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

  llaveGrupo(g: AutoabastoPedidoGrupo): string { return `${g.tipo}:${g.clave ?? ''}`; }

  tipoTexto(g: AutoabastoPedidoGrupo): string {
    return g.tipo === 'matriz' ? 'Traspaso de' : g.tipo === 'proveedor' ? 'Compra a' : '';
  }

  posicion(p: string): string { return POSICION[p] ?? p; }

  etiquetaMotivo(m: MotivoAjuste): string { return MOTIVO_AJUSTE_LABEL[m]; }

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
}
