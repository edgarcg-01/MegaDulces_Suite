import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, of, switchMap, catchError } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { RadioButtonModule } from 'primeng/radiobutton';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import {
  EntradasService, EntradaRow, EntradasReport, EntradasQuery, EntradaDetail,
} from '../entradas.service';
import { DocViewerComponent, DocViewerFile } from '../../../shared/components/doc-viewer/doc-viewer.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { ComprasService, AdjustmentForEntradaRow, type AdjustmentExplicacion, type AdjustmentLinesResponse } from '../compras.service';
import { receiptVerdict, plural, MOTIVOS_RECHAZO, motivoLabel } from '../receipt-verdict';
import { branchName, NETWORK_BRANCHES } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { entityRef } from '../../../shared/components/entity-inspector/entity-ref.service';

/**
 * `[RE.13.2]` — **Bandeja de revisión**: la cola del revisor.
 *
 * Es una **cola con veredicto**, no un CRUD. El revisor no busca: decide lo que le toca, en
 * orden de riesgo, y pasa a la siguiente. Antes esto vivía en un diálogo de 72rem dentro de
 * la pantalla de captura, así que revisar era abrir/cerrar modales de a uno y volver a buscar
 * dónde ibas.
 *
 * **Una sola pantalla para los dos tipos de revisor** — el central (alcance `all`, ve toda la
 * cola) y el local de algunas sucursales (`own`/`listed`, ve la suya). No hay código
 * condicional: lo resuelve `ScopeService` del lado del server. De ahí salen dos cosas que sí
 * están construidas: el aviso de **colisión** (los dos pueden mirar la misma fila) y la
 * **segregación de funciones** (no validás lo que subiste), que en una sucursal chica es la
 * única defensa real.
 */
@Component({
  selector: 'app-compras-entradas-revision',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule, DialogModule,
    TableModule, TagModule, ToastModule, CheckboxModule, RadioButtonModule, RouterLink, SegmentedComponent, LoadStateComponent,
    EntityInspectorComponent, DocViewerComponent, FreshnessPillComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in rv">
      <p-toast />

      <!--
        RE.18 — el header decía siete cosas antes de la primera fila: subtítulo de tres
        líneas con los atajos, contador, botón de lote, densidad, frescura, ayuda y actualizar.
        Ahora es **una oración** (Q.1 answer-first) con el estado de la cola, y todo lo que se
        opera bajó a la barra de trabajo. Los atajos se fueron al pie del riel de decisión, que
        es donde sirven — al lado de los botones que disparan.
      -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Revisión de facturas de entrada</h1>
          @if (report(); as r) {
            <p class="surf-page-sub rv-lead">
              @if (r.kpis.por_validar === 0) {
                No hay facturas esperando tu decisión.
              } @else {
                <strong>{{ r.kpis.por_validar }}</strong>
                {{ r.kpis.por_validar === 1 ? 'factura espera' : 'facturas esperan' }} tu decisión, la de
                mayor riesgo primero.
                @if (r.kpis.por_validar_atrasadas > 0) {
                  <b class="rv-late" [title]="'Más de ' + r.settings.sla_review_days + ' días esperando'">
                    {{ r.kpis.por_validar_atrasadas }} ya pasaron los {{ r.settings.sla_review_days }} días.
                  </b>
                }
                @if (decididasHoy() > 0) { <em>Llevás {{ decididasHoy() }} decididas.</em> }
              }
            </p>
          }
        </div>
        <div class="rv-head-actions">
          <!-- RE.17.4 — DESIGN §9: una cola de decisiones es dato volátil (el revisor central y
               el local trabajan la misma) y no decía de cuándo era lo que estabas mirando. -->
          <app-freshness-pill [since]="cargadoAt()" [staleAfterSec]="300" />
          <app-context-help topic="compras-entradas" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="reload()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <!-- Una sola barra de trabajo: filtrar la cola y actuar sobre ella son el mismo momento. -->
      <div class="rv-bar">
        <app-segmented [options]="ordenOpts" [value]="orden()" (valueChange)="setOrden($event)" ariaLabel="Orden de la cola" />
        @if (variasSucursales()) {
          <p-select [options]="sucursalOpts()" [ngModel]="sucursalSel()" (onChange)="setSucursal($event.value)"
                    optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                    styleClass="rv-sel" ariaLabel="Sucursal" appendTo="body" />
        }
        <input pInputText [(ngModel)]="search" (keyup.enter)="reload()" (blur)="reload()"
               placeholder="Proveedor, folio o últimos 4…" class="rv-search" aria-label="Buscar en la cola" />
        <span class="rv-chk">
          <p-checkbox [binary]="true" [ngModel]="soloDescuadre()" (onChange)="setSoloDescuadre(!soloDescuadre())"
                      inputId="rv-solo-desc" />
          <label for="rv-solo-desc">Sólo las que no cuadran</label>
        </span>
        <span class="rv-bar-sp"></span>
        @if (report(); as r) {
          <!-- Sin topes silenciosos: la cola trae 200 por pasada; si hay más, se dice. -->
          @if (cortada(r)) {
            <span class="rv-cut" [title]="'Al cerrar estas aparecen las que siguen'">
              mostrando {{ cola().length }} de {{ r.kpis.por_validar }}
            </span>
          }
        }
        @if (canValidate() && limpias().length > 1 && !sel().size) {
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="bulking()" (click)="abrirLote()"
                  [title]="'Aprobar las ' + limpias().length + ' que cuadran al peso'">
            <span class="p-button-icon p-button-icon-left pi pi-check-square" aria-hidden="true"></span>
            <span class="p-button-label">Aprobar {{ limpias().length }} que cuadran</span>
          </button>
        }
      </div>

      @if (error()) {
        <app-load-state [error]="error()" (retry)="reload()" />
      } @else if (cola().length === 0 && !loading()) {
        <div class="rv-empty">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <p>No hay nada esperando tu decisión.</p>
          <a routerLink="/compras/compras-360" class="rv-empty-link">Ver todas las entradas</a>
        </div>
      } @else {
        <!--
          RE.18 — **cabina de tres columnas**: cola · documento · decisión.
          Master-detail permanente (DESIGN §O.1), pero con las proporciones del trabajo real.
          Antes el grid daba todo el ancho sobrante a la tabla de renglones y un máximo de
          26rem al papel: en
          una pantalla de 1920 la factura escaneada se leía en ~400px y los renglones se llevaban
          ~1000px. Está al revés — el oficio de esta pantalla es **comparar el papel contra las
          cifras**, así que el papel manda y los renglones son respaldo (Q.1: la evidencia va al
          drill-down). Las tres columnas hacen scroll por separado, así que decidir no obliga a
          perder de vista ni la fila ni el documento.
        -->
        <div class="rv-cockpit">
          <ul class="rv-queue" [class.loading]="loading()" role="listbox" aria-label="Cola de revisión">
            @for (c of cola(); track c.sucursal + '/' + c.folio; let i = $index) {
              <li class="rv-li" [class.picked]="estaSel(c)">
                @if (canValidate()) {
                  <!-- RE.17.4 — la casilla es lo que faltaba para poder aprobar 5 de 12. Antes
                       el lote era todo-o-nada ("las que cuadran") y el resto de a una. -->
                  <p-checkbox [binary]="true" [ngModel]="estaSel(c)" (onChange)="alternarSel(c)"
                              [disabled]="!c.deposit_id" styleClass="rv-cb"
                              [ariaLabel]="'Seleccionar ' + c.folio + ' de ' + (c.proveedor_nombre || 'proveedor')" />
                }
                <button type="button" class="rv-q" [class.on]="i === idx()" [class.bad]="noCuadra(c)"
                        role="option" [attr.aria-selected]="i === idx()" (click)="ir(i)">
                  <span class="rv-q-top">
                    <b class="rv-q-prov">{{ c.proveedor_nombre || c.proveedor_code || '—' }}</b>
                    <span class="rv-q-monto">{{ money(c.monto) }}</span>
                  </span>
                  <span class="rv-q-bot">
                    <em class="rv-q-folio">{{ suc(c.sucursal) }} · {{ c.folio }}</em>
                    @if (c.discrepancy_amount) {
                      <span class="rv-q-delta" [title]="'La factura difiere ' + money(c.discrepancy_amount)">Δ {{ money(c.discrepancy_amount) }}</span>
                    } @else if (c.monto_match) {
                      <span class="rv-q-ok" title="La factura cuadra al peso"><i class="pi pi-check" aria-hidden="true"></i></span>
                    }
                    <span class="rv-q-dias" [class.late]="c.atrasada" [title]="(c.dias_espera ?? 0) + ' días esperando decisión'">
                      {{ c.dias_espera ?? 0 }}d
                    </span>
                  </span>
                </button>
              </li>
            }
          </ul>

          <!-- ── 2. EL DOCUMENTO ───────────────────────────────────────────────────
               La columna que manda. El visor trae zoom, rotación, páginas y pantalla
               completa; acá se le da el espacio, que es lo que le faltaba. -->
          <section class="rv-stage" aria-label="Documento del proveedor">
            @if (detailLoading()) {
              <div class="rv-sk rv-sk-doc" aria-busy="true" aria-label="Cargando documento"></div>
            } @else if (detail()) {
              <app-doc-viewer [files]="hojas()" [(idx)]="hojaIdx"
                              emptyTitle="Sin hoja adjunta"
                              emptyHint="Esta entrada no tiene documento del proveedor. Devolvela con el motivo «falta una hoja» o pedile a la sucursal que la suba." />
            } @else {
              <div class="rv-doc-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Elegí una factura de la cola.</span></div>
            }
          </section>

          <!-- ── 3. EL RIEL DE DECISIÓN ────────────────────────────────────────────
               Veredicto y cifras arriba, evidencia de respaldo en el medio (plegada:
               es drill-down, no dato vital), y las acciones **ancladas abajo** — antes
               vivían en el medio de la página, entre las cifras y los renglones. -->
          <aside class="rv-rail" aria-label="Decisión">
            @if (detailLoading()) {
              <div class="rv-skel" aria-busy="true">
                <span class="rv-sk rv-sk-v"></span><span class="rv-sk rv-sk-t"></span>
                @for (i of [1,2,3,4,5]; track i) { <span class="rv-sk rv-sk-r"></span> }
              </div>
            } @else if (detail(); as d) {
              @if (verdict(d); as q) {
                <div class="rv-verdict" [class]="'is-' + q.tone" role="status">
                  <i class="pi" [ngClass]="q.icon" aria-hidden="true"></i>
                  <div>
                    <p class="rv-v-t">{{ q.titulo }}</p>
                    <p class="rv-v-s">{{ q.lectura }}</p>
                  </div>
                </div>
                <!--
                  Las cifras dejaron de ser cuatro cajitas iguales. Q.5 pide tres niveles por
                  **tipo y contraste, no por más cajas**: arriba la comparación que decide
                  (Kepler contra el papel), abajo el respaldo (Σ renglones, que casi siempre
                  difiere porque es subtotal sin impuestos y eso confundía tanto como ayudaba).
                -->
                <dl class="rv-cmp">
                  <div class="rv-cmp-key">
                    <dt>Kepler</dt>
                    <dd class="mono">{{ money(q.kepler) }}</dd>
                  </div>
                  <div class="rv-cmp-key">
                    <dt>Documento</dt>
                    <dd class="mono" [class.is-off]="q.ocr == null">{{ q.ocr != null ? money(q.ocr) : 'sin leer' }}</dd>
                  </div>
                  @if (q.delta && q.tone !== 'ok') {
                    <div class="rv-cmp-delta">
                      <dt>Diferencia</dt>
                      <dd class="mono">{{ q.delta > 0 ? '+' : '' }}{{ money(q.delta) }}</dd>
                    </div>
                  }
                  <!-- RE.14.4 — la cuarta cifra sólo aparece cuando existe y aporta: la misma
                       recepción capturada en oficinas con OTRO importe. Es lo que explica un
                       descuadre de centavos sin tener que dudar de la factura. -->
                  @if (q.gemela?.monto != null && q.gemela?.delta) {
                    <div>
                      <dt>Oficinas <em>folio {{ q.gemela!.folio }}</em></dt>
                      <dd class="mono">{{ money(q.gemela!.monto!) }}</dd>
                    </div>
                  }
                  <div>
                    <dt>Σ renglones <em>{{ q.lineasMeta }}</em></dt>
                    <dd class="mono">{{ money(q.lineas) }}</dd>
                  </div>
                </dl>

                <dl class="rv-ficha">
                  <div><dt>Entrada</dt><dd>
                    <button type="button" class="rv-ref mono" (click)="inspect.set(refEnt(d.entrada.sucursal, d.entrada.folio))"
                            title="Ficha completa: renglones, ajustes, pagos candidatos y copia CEDIS">{{ d.entrada.sucursal }}/{{ d.entrada.folio }}</button>
                  </dd></div>
                  <div><dt>Proveedor</dt><dd>
                    @if (d.entrada.proveedor_code) {
                      <button type="button" class="rv-ref" (click)="inspect.set(refProv(d.entrada.proveedor_code))"
                              title="Ficha del proveedor: compras, ajustes, pagos y listas del SAT">{{ d.entrada.proveedor_nombre || d.entrada.proveedor_code }}</button>
                    } @else { {{ d.entrada.proveedor_nombre || '—' }} }
                  </dd></div>
                  <div><dt>Recepción</dt><dd>{{ d.entrada.receipt_date | date:'dd/MM/yy' }}</dd></div>
                  <div><dt>OC / Vale</dt><dd class="mono">{{ d.entrada.oc_folio || '—' }} / {{ d.entrada.vale_folio || '—' }}</dd></div>
                  @if (d.deposits?.length) {
                    <!-- Quién subió es dato de la decisión (segregación de funciones), así que
                         va en la ficha y no perdido bajo la tabla. -->
                    <div><dt>Subió</dt><dd>
                      {{ d.deposits[0].created_by || '—' }}
                      <em>{{ d.deposits[0].created_at | date:'dd/MM HH:mm' }} · {{ plural(hojas().length, 'hoja', 'hojas') }}</em>
                    </dd></div>
                  }
                </dl>

                <!--
                  Respaldo, plegado. Tesler permite el pliegue sólo para lo secundario, y acá
                  lo es: la respuesta está arriba y esto es la evidencia para cuando no alcanza.
                  Los ajustes se abren SOLOS cuando no cuadra — es justo el caso en que el
                  revisor devuelve una factura que estaba bien (3 de cada 4 ajustes de proveedor
                  son descuentos ganados). <details> nativo: teclado y a11y gratis.
                -->
                <details class="rv-fold">
                  <summary>Renglones <span>{{ d.lineas.length }}</span></summary>
                  <p-table [value]="d.lineas" styleClass="p-datatable-sm rv-table" [scrollable]="true" scrollHeight="30vh"
                           [paginator]="d.lineas.length > 100" [rows]="100">
                    <ng-template #header>
                      <tr>
                        <th style="width:5.5rem">SKU</th><th>Producto</th>
                        <th class="ta-r" style="width:5rem">Cant.</th>
                        <th class="ta-r" style="width:8rem">Importe</th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-l>
                      <tr>
                        <td class="mono">{{ l.sku || '—' }}</td>
                        <td [title]="l.nombre || ''">{{ l.nombre || '—' }}</td>
                        <td class="ta-r">{{ l.cantidad | number:'1.0-2' }}<em class="rv-u">{{ l.unidad || '' }}</em></td>
                        <td class="ta-r strong">{{ money(l.importe) }}</td>
                      </tr>
                    </ng-template>
                    <ng-template #emptymessage><tr><td colspan="4" class="rv-none">Sin renglones de detalle.</td></tr></ng-template>
                  </p-table>
                </details>

                <details class="rv-fold" [open]="q.tone === 'bad'">
                  <summary>
                    ¿Por qué no cuadra? — ajustes del proveedor
                    @if (explica().length) { <span>{{ explica().length }}</span> }
                  </summary>
                  @if (explicaLoading()) {
                    <p class="rv-none"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando devoluciones y notas…</p>
                  } @else if (!explica().length) {
                    <p class="rv-none">Sin devoluciones ni notas de crédito de este proveedor ±15 días. Si difiere, suele ser IVA o captura.</p>
                  } @else {
                    <!-- RE.21 — el veredicto ANTES de la lista. Antes salían hasta 50 candidatos
                         del mismo proveedor sin decir cuál importaba, y el revisor tenía que
                         hacer la resta a mano. Se dice el tamaño del hueco y si alguno lo tiene. -->
                    @if (explicacion(); as ex) {
                      <p class="rv-expl" [attr.data-tone]="ex.explicado ? (ex.grupo === 'negociado' ? 'ok' : 'warn') : 'muted'">
                        @if (ex.explicado) {
                          <strong>{{ ex.candidatos === 1 ? 'Hay uno del tamaño del hueco' : ex.candidatos + ' del tamaño del hueco' }}</strong>
                          ({{ money(ex.delta) }}).
                          @if (ex.grupo === 'negociado') {
                            Es un <b>beneficio negociado</b> — descuento, pronto pago o apoyo: no dice que falte mercancía.
                          } @else {
                            Es un <b>problema operativo</b> — faltante, mal estado o no solicitado: la factura difiere porque no llegó completo.
                          }
                          <!-- RE.21.3 — el cuadre es una foto: si el ajuste llegó después, el
                               descuadre guardado no pudo tomarlo en cuenta. Es la diferencia
                               entre "se equivocó el capturista" y "todavía no existía". -->
                          @if (ex.dias_despues && ex.dias_despues > 0) {
                            <em>Llegó <b>{{ ex.dias_despues }} {{ ex.dias_despues === 1 ? 'día' : 'días' }} después</b> de recibir: cuando se calculó el cuadre todavía no existía.</em>
                          }
                          @if (ex.confianza === 'ambigua') { <em>Hay más de un candidato: confirmá cuál.</em> }
                          @else if (ex.confianza === 'media') { <em>Kepler no liga la nota a esta recepción — casa por monto, confirmalo.</em> }
                          @else if (ex.confianza === 'alta') { <em>Kepler lo liga a esta entrada: se puede aprobar en lote.</em> }
                        } @else {
                          El hueco es de <strong>{{ money(ex.delta) }}</strong> y <b>ninguno de estos ajustes lo explica</b>.
                          Suele ser IVA o captura.
                        }
                      </p>
                    }
                    <ul class="rv-adj">
                      @for (a of explica(); track a.doctype + a.folio) {
                        <li [class.is-explica]="a.explica" [class.is-abierto]="ajusteAbierto() === claveAjuste(a)">
                          <!-- RE.22.1 — la fila entera abre el desglose: la lista decía CUÁNTO se
                               ajustó y nunca QUÉ. Es botón (no div con click) por teclado. -->
                          <button type="button" class="rv-adj-row" (click)="toggleAjuste(a)"
                                  [attr.aria-expanded]="ajusteAbierto() === claveAjuste(a)">
                            <i class="pi rv-adj-caret" [class.pi-chevron-right]="ajusteAbierto() !== claveAjuste(a)" [class.pi-chevron-down]="ajusteAbierto() === claveAjuste(a)" aria-hidden="true"></i>
                            <p-tag [value]="a.doctype === 'XD40' ? 'Devolución' : 'Nota de crédito'" [severity]="a.doctype === 'XD40' ? 'warn' : 'info'" />
                            <span class="mono">{{ a.folio }}</span>
                            <em>{{ a.adjustment_date | date:'dd/MM' }}</em>
                            <span class="rv-adj-mot" [title]="a.motivo || ''">{{ a.motivo || '—' }}</span>
                            <span class="rv-adj-monto">{{ money(a.monto) }}</span>
                            <!-- title nativo y no pTooltip: esta pantalla no importa
                                 TooltipModule y no vale traerlo por un ícono. -->
                            @if (a.explica) { <i class="pi pi-arrow-left rv-adj-hit" [title]="a.match === 'exacto' ? 'Kepler la liga a esta entrada Y tiene el tamaño del hueco' : 'Tiene exactamente el tamaño del hueco'"></i> }
                          </button>

                          @if (ajusteAbierto() === claveAjuste(a)) {
                            <div class="rv-adj-det">
                              @if (desgloseLoading()) {
                                <p class="rv-adj-nota"><i class="pi pi-spin pi-spinner"></i> Abriendo el movimiento…</p>
                              } @else if (desgloseError()) {
                                <p class="rv-adj-nota">No se pudo abrir el movimiento. <button type="button" class="rv-adj-retry" (click)="reintentarAjuste(a)">Reintentar</button></p>
                              } @else if (desglose(); as dg) {
                                @if (dg.desglose === 'renglones') {
                                  <!-- Misma base compartida que el listado: una <table> cruda no
                                       se re-estila por pantalla (surf-table--plain existe para eso). -->
                                  <div class="rv-adj-scroll">
                                    <table class="surf-table surf-table--plain is-dense">
                                      <thead><tr><th>SKU</th><th>Producto</th><th class="comm-num">Cant.</th><th>Unidad</th><th class="comm-num">Costo</th><th class="comm-num">Importe</th></tr></thead>
                                      <tbody>
                                        @for (l of dg.lineas; track l.linea) {
                                          <tr>
                                            <td class="mono">{{ l.sku || '—' }}</td>
                                            <td>{{ l.nombre || '—' }}</td>
                                            <td class="comm-num">{{ l.cantidad }}</td>
                                            <td>{{ l.unidad || '—' }}</td>
                                            <td class="comm-num">{{ money(l.costo_unitario) }}</td>
                                            <td class="comm-num">{{ money(l.importe) }}</td>
                                          </tr>
                                        }
                                      </tbody>
                                      <tfoot><tr><td colspan="5">{{ plural(dg.lineas.length, 'renglón', 'renglones') }}</td><td class="comm-num">{{ money(dg.total_importe) }}</td></tr></tfoot>
                                    </table>
                                  </div>
                                } @else {
                                  <!-- RE.22.1 — una nota de crédito NO se desglosa por producto: es
                                       dinero, no mercancía. Decirlo es la mitad del valor; dejar la
                                       lista vacía se leería como que falló la carga. -->
                                  <p class="rv-adj-nota">{{ dg.nota }}</p>
                                  @if (dg.motivo) { <p class="rv-adj-motivo">Motivo en Kepler: <b>{{ dg.motivo }}</b></p> }
                                }
                              }
                            </div>
                          }
                        </li>
                      }
                    </ul>
                  }
                </details>

                @if (d.history?.length) {
                  <details class="rv-fold">
                    <summary>Historial <span>{{ d.history!.length }}</span></summary>
                    <ol class="rv-hist">
                      @for (h of d.history; track h.changed_at) {
                        <li>
                          <b>{{ etiquetaEstado(h.status_to) }}</b>
                          <em>{{ h.changed_by || '—' }} · {{ h.changed_at | date:'dd/MM HH:mm' }}</em>
                          @if (h.motivo_codigo || h.motivo) {
                            <span class="rv-hist-mot">{{ motivoLabel(h.motivo_codigo) || h.motivo }}</span>
                          }
                        </li>
                      }
                    </ol>
                  </details>
                }

                <!-- Ancladas abajo: la acción no se busca, está donde termina la lectura. -->
                <footer class="rv-act">
                  @if (canValidate()) {
                    @if (bloqueoPropio(); as quien) {
                      <p class="rv-block">
                        <i class="pi pi-user-minus" aria-hidden="true"></i>
                        Esta evidencia la subió <strong>{{ quien }}</strong> — que sos vos. Tiene que revisarla otra persona.
                      </p>
                    } @else {
                      <div class="rv-act-btns">
                        <button pButton type="button" severity="success" [loading]="acting()" (click)="aprobar()">
                          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                          <span class="p-button-label">Aprobar</span>
                        </button>
                        <button pButton type="button" severity="danger" class="p-button-outlined" [disabled]="acting()" (click)="abrirRechazo()">
                          <span class="p-button-icon p-button-icon-left pi pi-undo" aria-hidden="true"></span>
                          <span class="p-button-label">Devolver</span>
                        </button>
                      </div>
                    }
                  } @else {
                    <p class="rv-block"><i class="pi pi-lock" aria-hidden="true"></i> No tenés permiso para validar evidencia.</p>
                  }
                  <div class="rv-act-nav">
                    <span class="rv-pos">{{ idx() + 1 }} de {{ cola().length }}</span>
                    <button pButton type="button" class="p-button-sm p-button-text" [disabled]="idx() >= cola().length - 1" (click)="ir(idx() + 1)">
                      <span class="p-button-label">Saltar</span><span class="p-button-icon pi pi-angle-right" aria-hidden="true"></span>
                    </button>
                  </div>
                  <!-- Los atajos, al lado de lo que disparan. En el subtítulo de la página nadie
                       los relacionaba con estos dos botones. -->
                  <p class="rv-keys"><kbd>A</kbd> aprobar · <kbd>R</kbd> devolver · <kbd>J</kbd>/<kbd>K</kbd> moverse</p>
                </footer>
              }
            } @else {
              <div class="rv-doc-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Elegí una de la cola.</span></div>
            }
          </aside>
        </div>

        @if (sel().size) {
          <!-- Bulk-bar (§datos densos 6): al seleccionar sube y reemplaza al toolbar. Dice qué
               va a pasar con las que NO cuadran en vez de esconderlas: el server revalida una
               por una y devuelve el motivo de cada omitida (§10, fallos parciales). -->
          <div class="rv-bulk" role="region" aria-label="Acciones sobre la selección">
            <span class="rv-bulk-n"><strong>{{ sel().size }}</strong> {{ sel().size === 1 ? 'seleccionada' : 'seleccionadas' }}</span>
            <span class="rv-bulk-m">{{ money(montoSel()) }}</span>
            @if (selConDescuadre() > 0) {
              <span class="rv-bulk-w">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                {{ selConDescuadre() }} no {{ selConDescuadre() === 1 ? 'cuadra' : 'cuadran' }} — {{ selConDescuadre() === 1 ? 'esa se queda' : 'esas se quedan' }} en la cola
              </span>
            }
            <span class="rv-bulk-sp"></span>
            <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarSel()">
              <span class="p-button-label">Quitar selección</span>
            </button>
            <button pButton type="button" class="p-button-sm" severity="success" [loading]="bulking()" (click)="abrirLote()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
              <span class="p-button-label">Aprobar {{ sel().size }}</span>
            </button>
          </div>
        }
      }
    </div>

    <!-- Devolver: el motivo es del catálogo, no texto libre. -->
    <p-dialog [visible]="showRechazo()" (visibleChange)="onRechazoVisible($event)" [modal]="true" [draggable]="false"
              [style]="{ width: '30rem', maxWidth: '96vw' }" header="Devolver la factura a la sucursal">
      <div class="rv-rej">
        <p class="rv-rej-sub">
          Entrada <strong class="mono">{{ actual()?.folio }}</strong> · {{ actual()?.proveedor_nombre }}.
          El motivo se le muestra a quien la subió.
        </p>
        <!-- p-radiobutton y no un radio crudo (checklist 3): era el último control de la
             pantalla fuera del sistema y en tema oscuro se veía el del sistema operativo. -->
        <div class="rv-rej-opts">
          @for (m of motivos; track m.code) {
            <label class="rv-rej-opt" [class.on]="motivoCodigo() === m.code" [attr.for]="'motivo-' + m.code">
              <p-radiobutton name="motivo" [value]="m.code" [ngModel]="motivoCodigo()"
                             (ngModelChange)="motivoCodigo.set($event)" [inputId]="'motivo-' + m.code" />
              <span>{{ m.label }}</span>
            </label>
          }
        </div>
        <label class="rv-rej-txt">
          <span>Detalle {{ motivoCodigo() === 'otro' ? '(obligatorio)' : '(opcional)' }}</span>
          <textarea pInputText [(ngModel)]="motivoTexto" rows="2" placeholder="Ej. la hoja 2 salió cortada"></textarea>
        </label>
        @if (rejError()) { <p class="rv-rej-err">{{ rejError() }}</p> }
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="cerrarRechazo()"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="acting()" [disabled]="!motivoCodigo()" (click)="devolver()">
          <span class="p-button-icon p-button-icon-left pi pi-undo" aria-hidden="true"></span>
          <span class="p-button-label">Devolver</span>
        </button>
      </ng-template>
    </p-dialog>

    <!-- Lote: enumera antes de aplicar. Nunca un "aprobar todo". -->
    <p-dialog [visible]="showLote()" (visibleChange)="onLoteVisible($event)" [modal]="true" [draggable]="false"
              [style]="{ width: '34rem', maxWidth: '96vw' }"
              [header]="resultado().length ? 'Resultado del lote' : (sel().size ? 'Aprobar las seleccionadas' : 'Aprobar las que cuadran al peso')">
      @if (resultado(); as res) {
        @if (res.length) {
          <!-- §10 — fallos parciales: el resultado es POR EXPEDIENTE, no un toast que tapa la
               mitad. Las que fallaron quedan seleccionadas para corregirlas. -->
          <div class="rv-lote">
            <ul class="rv-res">
              @for (r of res; track r.id) {
                <li [class.bad]="!r.ok">
                  <i class="pi" [ngClass]="r.ok ? 'pi-check-circle' : 'pi-times-circle'" aria-hidden="true"></i>
                  <span class="mono">{{ etiquetaDe(r.id) }}</span>
                  <em>{{ r.ok ? 'aprobada' : r.motivo }}</em>
                </li>
              }
            </ul>
          </div>
        } @else {
          <div class="rv-lote">
            <p>
              Se van a aprobar <strong>{{ loteObjetivo().length }}</strong> facturas
              @if (sel().size) {
                de tu selección. El servidor revisa cada una: las que no cuadren o hayas subido vos
                se quedan en la cola y te dice cuáles.
              } @else {
                cuyo total coincide con Kepler dentro de la tolerancia de
                <strong>{{ money(report()?.settings?.match_tolerance ?? 1) }}</strong> y que no subiste vos.
                Las que no cuadran quedan en la cola para revisarlas a mano.
              }
            </p>
            <ul>
              @for (c of loteObjetivo(); track c.deposit_id) {
                <li>
                  <span class="mono">{{ suc(c.sucursal) }} · {{ c.folio }}</span>
                  <em>{{ c.proveedor_nombre }}</em>
                  <b>{{ money(c.monto) }}</b>
                  @if (!c.monto_match) { <i class="rv-res-w pi pi-exclamation-triangle" title="No cuadra: el servidor la va a omitir" aria-hidden="true"></i> }
                </li>
              }
            </ul>
          </div>
        }
      }
      <ng-template #footer>
        @if (resultado().length) {
          <button pButton type="button" (click)="cerrarLote()">
            <span class="p-button-label">Entendido</span>
          </button>
        } @else {
          <button pButton type="button" text (click)="cerrarLote()"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" severity="success" [loading]="bulking()" [disabled]="!loteObjetivo().length" (click)="aprobarLote()">
            <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
            <span class="p-button-label">Aprobar {{ loteObjetivo().length }}</span>
          </button>
        }
      </ng-template>
    </p-dialog>

    <app-entity-inspector [(ref)]="inspect" />
  `,
  styles: [`
    :host { display: block; }
    kbd { font: inherit; font-size: .85em; font-family: var(--font-mono); border: 1px solid var(--border-color);
      border-radius: 3px; padding: 0 .25em; color: var(--text-muted); }
    .rv-head-actions { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    /* Answer-first: una oración, no una fila de chips. La jerarquía la lleva el peso del
       número y el color sólo marca el vencimiento (Q.5: tipo y contraste, no color). */
    .rv-lead strong { color: var(--text-main); font-weight: var(--fw-bold, 700); }
    .rv-lead .rv-late { color: var(--bad-fg); font-weight: 600; }
    .rv-lead em { font-style: normal; color: var(--ok-fg); }
    .rv-cut { font-style: normal; color: var(--text-muted); font-size: var(--fs-xs, .75rem); }

    .rv-bar { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .rv-bar-sp { flex: 1 1 auto; }
    .rv-search { flex: 0 1 18rem; min-width: 10rem; }
    .rv-chk { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--fs-sm, .85rem); color: var(--text-muted); }
    .rv-chk label { cursor: pointer; }

    /* ── La cabina ────────────────────────────────────────────────────────────────
       Tres columnas de alto fijo que hacen scroll por separado: decidir no puede
       obligar a perder de vista la fila ni el documento. Consulta de CONTENEDOR y no
       de media (checklist 9) — la cabina se estrecha por el sidebar expandido, no
       sólo por el ancho de la ventana. */
    .rv { container-type: inline-size; }
    .rv-cockpit {
      display: grid; gap: .8rem;
      grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr) minmax(19rem, 23rem);
      /* El alto de la ventana menos el chrome de la página: la cabina no crece con el
         contenido, cada columna se lo administra. */
      height: calc(100vh - 15rem); min-height: 30rem;
    }
    .rv-cockpit > * { min-height: 0; min-width: 0; }
    /* Sin lugar para tres: el documento se va abajo, a lo ancho, y arriba quedan cola y
       decisión — que es como se trabaja en una laptop chica. */
    @container (max-width: 76rem) {
      .rv-cockpit { grid-template-columns: minmax(14rem, 18rem) 1fr; grid-template-rows: auto 22rem; height: auto; }
      .rv-stage { grid-column: 1 / -1; grid-row: 2; height: 22rem; }
      .rv-queue, .rv-rail { max-height: 60vh; }
    }
    @container (max-width: 52rem) {
      .rv-cockpit { grid-template-columns: 1fr; grid-template-rows: none; }
      .rv-stage { grid-column: auto; grid-row: auto; }
      .rv-queue { max-height: 22rem; }
      .rv-rail { max-height: none; }
    }

    .rv-stage { min-width: 0; }

    .rv-queue { list-style: none; margin: 0; padding: 0; overflow: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); }
    .rv-queue.loading { opacity: .6; }
    /* La casilla y el renglón conviven: la casilla NO puede ir dentro del <button> (HTML
       inválido) y el renglón entero tiene que seguir siendo el objetivo de "abrir". */
    .rv-li { display: flex; align-items: stretch; }
    .rv-li.picked { background: var(--surface-selected-bg, var(--overlay-selected)); }
    .rv-cb { align-self: center; margin-left: .5rem; flex: none; }
    .rv-li + .rv-li { border-top: 1px solid var(--border-color); }
    .rv-q { display: grid; gap: .15rem; flex: 1; min-width: 0; text-align: left; background: transparent; border: 0;
      border-left: 3px solid transparent; padding: .5rem .7rem; cursor: pointer; font: inherit; }
    .rv-q:hover { background: var(--surface-hover, var(--surface-2)); }
    .rv-q.on { background: var(--surface-2); border-left-color: var(--action); }
    .rv-q.bad .rv-q-delta { color: var(--bad-fg); }
    .rv-q-top, .rv-q-bot { display: flex; align-items: baseline; gap: .4rem; }
    .rv-q-prov { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .rv-q-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-sm, .85rem); }
    .rv-q-folio { flex: 1; font-style: normal; font-size: var(--fs-micro, .72rem); color: var(--text-muted);
      font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rv-q-delta { font-size: var(--fs-micro, .72rem); font-family: var(--font-mono); }
    .rv-q-ok { color: var(--ok-fg); font-size: .8em; }
    .rv-q-dias { font-size: var(--fs-micro, .72rem); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .rv-q-dias.late { color: var(--bad-fg); font-weight: 600; }

    /* El riel: una sola caja con hairline (§datos densos 1 — elevación es borde O sombra,
       nunca las dos, y nunca una caja dentro de otra caja dentro de otra). Lo de adentro
       se separa por reglas de 1px, no por más recuadros: eso era el "muchas cajas". */
    .rv-rail {
      display: flex; flex-direction: column; overflow: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem);
      background: var(--card-bg);
    }
    .rv-rail > * { flex: none; }

    /* El veredicto ya no es una caja de color dentro de otra caja: es la cabecera del riel con
       un acento de 3px al canto. El semáforo lo lleva el ícono + el acento, y el texto queda
       legible (antes el párrafo entero se pintaba del color del estado y gritaba). */
    .rv-verdict { display: flex; gap: .7rem; align-items: flex-start; padding: .8rem .85rem;
      border-bottom: 1px solid var(--border-color); border-left: 3px solid transparent; }
    .rv-verdict .pi { font-size: 1.15rem; margin-top: .1rem; }
    .rv-verdict.is-ok   { border-left-color: var(--ok-fg); }
    .rv-verdict.is-warn { border-left-color: var(--warn-fg, var(--bad-fg)); }
    .rv-verdict.is-bad  { border-left-color: var(--bad-fg); }
    .rv-verdict.is-ok   .pi { color: var(--ok-fg); }
    .rv-verdict.is-warn .pi { color: var(--warn-fg, var(--bad-fg)); }
    .rv-verdict.is-bad  .pi { color: var(--bad-fg); }
    .rv-verdict.is-muted .pi { color: var(--text-faint); }
    .rv-verdict.is-bad .rv-v-t { color: var(--bad-fg); }
    .rv-v-t { margin: 0; font-weight: 600; }
    .rv-v-s { margin: .15rem 0 0; font-size: var(--fs-sm, .85rem); color: var(--text-main); }
    .rv-verdict.is-muted .rv-v-s { color: var(--text-muted); }

    /* Las cifras: filas alineadas a la misma columna derecha, no tiles. Comparar dos
       números pide que compartan eje, y cuatro cajitas de ancho variable lo impiden. */
    .rv-cmp { margin: 0; padding: .7rem .85rem; border-bottom: 1px solid var(--border-color); }
    .rv-cmp > div { display: flex; align-items: baseline; gap: .6rem; padding: .18rem 0; }
    .rv-cmp dt { flex: 1; min-width: 0; font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
    .rv-cmp dt em { display: block; font-style: normal; font-size: var(--fs-micro, .72rem); color: var(--text-faint); }
    .rv-cmp dd { margin: 0; font-variant-numeric: tabular-nums; font-size: var(--fs-sm, .85rem); color: var(--text-muted); }
    /* Nivel 1 — las dos que deciden. Nivel 2 — el resto, en muted. */
    .rv-cmp-key dt { color: var(--text-main); font-weight: 600; }
    .rv-cmp-key dd { font-size: 1.05rem; font-weight: 700; color: var(--text-main); }
    .rv-cmp-key dd.is-off { color: var(--text-faint); font-weight: 400; font-size: var(--fs-sm, .85rem); }
    /* El selector de arriba es más específico que .rv-cmp-delta a secas, así que el override
       va calificado — no con !important (checklist 16). */
    .rv-cmp > div.rv-cmp-delta { border-top: 1px dashed var(--border-color); margin-top: .25rem; padding-top: .4rem; }
    .rv-cmp-delta dt, .rv-cmp-delta dd { color: var(--bad-fg); font-weight: 600; }

    .rv-ficha { margin: 0; padding: .7rem .85rem; border-bottom: 1px solid var(--border-color); display: grid; gap: .3rem; }
    .rv-ficha > div { display: flex; align-items: baseline; gap: .6rem; }
    .rv-ficha dt { flex: 0 0 5.5rem; font-size: var(--fs-micro, .72rem); text-transform: uppercase;
      letter-spacing: .04em; color: var(--text-faint); }
    .rv-ficha dd { margin: 0; min-width: 0; font-size: var(--fs-sm, .85rem); }
    .rv-ficha dd em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); }

    /* Plegables nativos: teclado y a11y sin JS (checklist 16). */
    .rv-fold { border-bottom: 1px solid var(--border-color); }
    .rv-fold > summary {
      display: flex; align-items: center; gap: .4rem; cursor: pointer; list-style: none;
      padding: .55rem .85rem; font-size: var(--fs-sm, .85rem); color: var(--text-muted);
    }
    .rv-fold > summary::-webkit-details-marker { display: none; }
    .rv-fold > summary::before {
      content: ''; flex: none; width: .38rem; height: .38rem; margin-right: .15rem;
      border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg); transition: transform var(--dur-micro, 120ms) var(--ease-out);
    }
    .rv-fold[open] > summary::before { transform: rotate(45deg); }
    .rv-fold > summary:hover { color: var(--text-main); background: var(--overlay-hover); }
    .rv-fold > summary:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .rv-fold > summary span { margin-left: auto; font-variant-numeric: tabular-nums;
      font-size: var(--fs-micro, .72rem); color: var(--text-faint); }
    .rv-fold > :not(summary) { padding: 0 .85rem .7rem; }
    @media (prefers-reduced-motion: reduce) { .rv-fold > summary::before { transition: none; } }

    /* Ancladas al pie del riel: margin-top auto las empuja abajo cuando sobra alto, y
       quedan pegadas al hacer scroll cuando no. */
    .rv-act {
      margin-top: auto; position: sticky; bottom: 0;
      display: grid; gap: .5rem; padding: .7rem .85rem;
      border-top: 1px solid var(--border-color); background: var(--card-bg);
    }
    .rv-act-btns { display: flex; gap: .5rem; }
    .rv-act-btns > * { flex: 1; }
    .rv-act-nav { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .rv-pos { font-size: var(--fs-xs, .75rem); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .rv-keys { margin: 0; font-size: var(--fs-micro, .72rem); color: var(--text-faint); }
    .rv-block { margin: 0; display: flex; align-items: flex-start; gap: .4rem; font-size: var(--fs-sm, .85rem); color: var(--warn-fg, var(--bad-fg)); }
    .rv-ref { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; font: inherit; font-weight: 600; text-align: left; }
    .rv-ref:hover { color: var(--action); text-decoration: underline; }
    .rv-ref:focus-visible { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }
    .mono { font-family: var(--font-mono); font-size: .9em; }
    .rv-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rv-table td.ta-r { font-family: var(--font-mono); }
    .rv-table .strong { font-weight: 600; }
    .rv-u { font-style: normal; color: var(--text-muted); font-size: .8em; margin-left: .2rem; }
    .rv-none { color: var(--text-muted); font-size: var(--fs-sm, .85rem); margin: .2rem 0; }

    /* RE.21 — el veredicto sobre el hueco, antes de la lista. Verde cuando lo explica un
       beneficio negociado (no falta mercancía) y ámbar cuando lo explica un problema operativo
       (no llegó completo): son dos decisiones distintas para el revisor. Gris cuando nada lo
       explica — que NO es alarma, es "esto es IVA o captura, mirá otra cosa". */
    .rv-expl {
      margin: 0 0 var(--sp-2); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-md); border-left: 3px solid var(--border-color);
      background: var(--surface-ground); font-size: var(--fs-xs); line-height: 1.5;
      color: var(--text-muted);
    }
    .rv-expl strong, .rv-expl b { color: var(--text-main); }
    .rv-expl em { font-style: italic; display: block; margin-top: 2px; }
    .rv-expl[data-tone='ok']   { border-left-color: var(--ok-fg);   background: var(--ok-soft-bg); }
    .rv-expl[data-tone='warn'] { border-left-color: var(--warn-fg); background: var(--warn-soft-bg); }
    /* Sobre el fondo de color, el texto secundario pierde contraste: sube a --text-main. */
    .rv-expl[data-tone='ok'], .rv-expl[data-tone='warn'] { color: var(--text-main); }

    .rv-adj { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
    /* El que casa con el hueco se marca en la lista, para poder ir del veredicto a la fila. */
    .rv-adj li.is-explica { font-weight: 600; }
    .rv-adj-hit { color: var(--action); font-size: .7rem; }
    /* RE.22.1 — el li pasa a bloque: ahora contiene la fila (botón) + el desglose debajo. */
    .rv-adj li { display: block; font-size: var(--fs-sm, .85rem); }
    .rv-adj-row {
      display: flex; align-items: center; gap: .45rem; flex-wrap: wrap; width: 100%;
      /* Ghost: es una fila de lista que se abre, no un botón que compite con Aprobar/Devolver. */
      background: none; border: 0; padding: .15rem .2rem; margin: 0;
      border-radius: var(--r-sm, 4px); color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .rv-adj-row:hover { background: var(--overlay-hover); }
    .rv-adj-row:active { background: var(--overlay-active); }
    .rv-adj-row:focus-visible { outline: var(--focus-ring); outline-offset: 1px; }
    /* La fila entera es el objetivo de clic, así que en touch se le da la altura mínima. */
    @media (pointer: coarse) { .rv-adj-row { min-height: var(--tap-min); } }
    .rv-adj-caret { color: var(--text-faint); font-size: var(--fs-micro); width: .7rem; flex: none; }
    .rv-adj li.is-abierto .rv-adj-caret { color: var(--text-muted); }
    .rv-adj em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); }
    .rv-adj-mot { flex: 1; min-width: 6rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .rv-adj-monto { font-family: var(--font-mono); font-weight: 600; }

    /* El desglose cuelga de la fila, sangrado a la altura del caret para que se lea como su hijo. */
    /* Elevación por borde (no borde+sombra): el desglose cuelga de su fila, sangrado a la
       altura del caret para que se lea como su hijo y no como un bloque suelto. */
    .rv-adj-det {
      margin: var(--sp-1) 0 var(--sp-2) 1.15rem; padding: var(--sp-2);
      border-left: 2px solid var(--border-color); background: var(--surface-ground);
      border-radius: 0 var(--r-sm) var(--r-sm) 0;
    }
    .rv-adj-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
    .rv-adj-motivo { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-adj-motivo b { color: var(--text-main); }
    .rv-adj-retry {
      background: none; border: 0; padding: 0; font: inherit; cursor: pointer;
      color: var(--action); text-decoration: underline;
    }
    .rv-adj-retry:focus-visible { outline: var(--focus-ring); outline-offset: 2px; }
    /* La tabla usa la base compartida; acá sólo lo que ella no cubre: el nombre envuelve y el
       panel es angosto, así que scrollea sola. */
    .rv-adj-scroll { overflow-x: auto; }
    .rv-adj-det .surf-table--plain > tbody > tr > td:nth-child(2) { white-space: normal; min-width: 9rem; }
    .rv-hist { list-style: none; margin: 0; padding: 0; display: grid; gap: .2rem; }
    .rv-hist li { display: flex; gap: .45rem; align-items: baseline; font-size: var(--fs-sm, .85rem); flex-wrap: wrap; }
    .rv-hist em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); }
    .rv-hist-mot { color: var(--text-muted); }

    .rv-doc-empty { display: grid; place-items: center; gap: .4rem; padding: 2.5rem 1rem; color: var(--text-muted); text-align: center;
      height: 100%; border: 1px dashed var(--border-color); border-radius: var(--r-md, .5rem); }
    .rv-doc-empty .pi { font-size: 1.4rem; }

    .rv-empty { display: grid; place-items: center; gap: .5rem; padding: 4rem 1rem; color: var(--text-muted); }
    .rv-empty .pi { font-size: 1.8rem; color: var(--ok-fg); }
    .rv-empty p { margin: 0; }
    .rv-empty-link { color: var(--action); font-size: var(--fs-sm, .85rem); }
    .rv-skel { display: grid; gap: .4rem; padding: .85rem; }
    .rv-sk { border-radius: var(--r-sm, .35rem);
      background: linear-gradient(90deg, var(--border-color) 25%, var(--surface-2) 50%, var(--border-color) 75%);
      background-size: 200% 100%; animation: rv-sh 1.2s infinite; }
    .rv-sk-v { height: 3.4rem; } .rv-sk-t { height: 4rem; } .rv-sk-r { height: 1.6rem; }
    /* El documento carga con la FORMA de la hoja, no con un spinner: CLS 0. */
    .rv-sk-doc { height: 100%; border-radius: var(--r-md, .5rem); }
    @keyframes rv-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .rv-sk { animation: none; } }

    .rv-rej { display: grid; gap: .7rem; }
    .rv-rej-sub { margin: 0; color: var(--text-muted); font-size: var(--fs-sm, .85rem); }
    .rv-rej-opts { display: grid; gap: .25rem; }
    .rv-rej-opt { display: flex; align-items: center; gap: .45rem; padding: .4rem .55rem; cursor: pointer;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); }
    .rv-rej-opt.on { border-color: var(--action); color: var(--action); }
    .rv-rej-txt { display: grid; gap: .2rem; }
    .rv-rej-txt > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .rv-rej-err { margin: 0; color: var(--bad-fg); font-size: var(--fs-sm, .85rem); }
    .rv-lote ul { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 40vh; overflow: auto; display: grid; gap: .2rem; }
    .rv-lote li { display: flex; gap: .5rem; align-items: baseline; font-size: var(--fs-sm, .85rem); }
    .rv-lote li em { font-style: normal; flex: 1; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rv-lote li b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rv-res-w { color: var(--warn-fg); font-size: .8em; }
    .rv-res li .pi { font-size: .85em; }
    .rv-res li { color: var(--ok-fg); }
    .rv-res li.bad { color: var(--bad-fg); }
    .rv-res li .mono, .rv-res li em { color: var(--text-main); }
    .rv-res li.bad em { color: var(--bad-fg); }

    /* Bulk-bar (§datos densos 6): sube al seleccionar y queda pegada abajo mientras dure la
       selección — si se fuera con el scroll, en una cola de 200 desaparecería justo al elegir. */
    .rv-bulk {
      position: sticky; bottom: 0; z-index: 2;
      display: flex; align-items: center; gap: .7rem; flex-wrap: wrap;
      margin-top: .6rem; padding: .5rem .7rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem);
      background: var(--card-bg); box-shadow: var(--shadow-float);
      animation: rv-bulk-in var(--dur-standard, 200ms) var(--ease-out, ease-out);
    }
    @keyframes rv-bulk-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .rv-bulk { animation: none; } }
    .rv-bulk-n { font-size: var(--fs-sm, .85rem); color: var(--text-muted); }
    .rv-bulk-n strong { color: var(--text-main); font-size: 1.05rem; font-variant-numeric: tabular-nums; }
    .rv-bulk-m { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-sm, .85rem); color: var(--text-main); }
    .rv-bulk-w { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs, .75rem); color: var(--warn-fg); }
    .rv-bulk-sp { flex: 1 1 auto; }
  `],
})
export class ComprasEntradasRevisionComponent {
  private readonly svc = inject(EntradasService);
  private readonly compras = inject(ComprasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  readonly report = signal<EntradasReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly cola = computed(() => this.report()?.rows || []);
  readonly idx = signal(0);
  readonly actual = computed(() => this.cola()[this.idx()] ?? null);

  readonly orden = signal<'riesgo' | 'antiguedad'>('riesgo');
  readonly sucursalSel = signal<string | null>(null);
  readonly soloDescuadre = signal(false);
  search = '';
  readonly ordenOpts = [
    { label: 'Por riesgo', value: 'riesgo' },
    { label: 'Más viejas', value: 'antiguedad' },
  ];
  readonly motivos = MOTIVOS_RECHAZO;
  motivoLabel = motivoLabel;
  money = money;
  plural = plural;
  suc(code: string): string { return branchName(code) || code; }

  readonly canValidate = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_VALIDAR] === true);

  private readonly alcance = computed(() => this.report()?.alcance?.sucursales ?? null);
  readonly variasSucursales = computed(() => { const a = this.alcance(); return a === null || a.length > 1; });
  /**
   * Con alcance `all`, del catálogo — no de la cola, que puede no traer todas las sucursales.
   * `[RE.23]` El catálogo es la RED (9); las 7 Kepler dejaban Morelia sin poder filtrarse.
   */
  readonly sucursalOpts = computed(() => {
    const a = this.alcance() ?? NETWORK_BRANCHES.map((b) => b.code);
    return a.map((c) => ({ label: this.suc(c), value: c }));
  });

  noCuadra(c: EntradaRow): boolean { return !c.monto_match; }
  /** ¿La cola quedó cortada por el tope de la pasada? (o por el filtro de descuadre) */
  cortada(r: EntradasReport): boolean { return r.kpis.por_validar > this.cola().length; }

  /**
   * Quien subió la evidencia soy yo → no puedo validarla.
   *
   * Esto es sólo la PISTA para no ofrecer un botón que va a fallar: el que decide es el
   * server (`validate()` compara `created_by` con el actor). La comparación es por
   * `username` porque es lo que el JWT trae y, por lo tanto, lo que termina guardado en
   * `created_by` (el backend intenta `full_name` primero, pero el payload no lo incluye).
   */
  private get yo(): string { return (this.auth.user()?.username || '').trim().toLowerCase(); }
  readonly bloqueoPropio = computed(() => {
    const c = this.actual();
    const subio = (c?.deposit_by || '').trim().toLowerCase();
    return this.yo && subio && this.yo === subio ? (c?.deposit_by as string) : null;
  });

  /** Las que se pueden aprobar en lote: cuadran al peso y no las subí yo. */
  readonly limpias = computed(() => this.cola().filter((c) =>
    c.monto_match && !!c.deposit_id && !this.esMio(c.deposit_by)));
  private esMio(quien: string | null): boolean {
    return !!this.yo && this.yo === (quien || '').trim().toLowerCase();
  }

  readonly decididasHoy = signal(0);
  readonly acting = signal(false);
  readonly bulking = signal(false);
  /** Momento de la última carga de la cola — lo lee la píldora de frescura. */
  readonly cargadoAt = signal<number | null>(null);

  // ── carga de la cola ──
  private readonly pedir = new Subject<void>();

  constructor() {
    this.pedir.pipe(
      switchMap(() => {
        this.loading.set(true);
        this.error.set(null);
        const q: EntradasQuery = {
          estado: 'por_validar',
          orden: this.orden(),
          search: this.search || undefined,
          warehouse_codes: this.sucursalSel() ? [this.sucursalSel() as string] : undefined,
          pageSize: 200, // la cola se trabaja completa; si pasa de 200 hay un problema aparte
        };
        return this.svc.list(q).pipe(catchError((e) => {
          this.error.set(e?.error?.message || 'No se pudo cargar la cola.');
          this.loading.set(false);
          return of(null);
        }));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) return;
      const filtrado = this.soloDescuadre() ? { ...r, rows: r.rows.filter((x) => !x.monto_match) } : r;
      this.report.set(filtrado);
      this.cargadoAt.set(Date.now());
      // La selección se poda contra la cola nueva: una evidencia que otro revisor ya decidió
      // deja de existir, y arrastrarla haría que el lote pidiera aprobar fantasmas.
      const vivos = new Set(filtrado.rows.map((x) => x.deposit_id).filter(Boolean) as string[]);
      const s = this.sel();
      if (s.size) {
        const podada = new Set([...s].filter((id) => vivos.has(id)));
        if (podada.size !== s.size) this.sel.set(podada);
      }
      // El índice se acota, no se resetea: tras aprobar la 5ª querés la nueva 5ª (la que era
      // la 6ª), no volver al principio de la fila.
      this.idx.set(Math.min(this.idx(), Math.max(0, filtrado.rows.length - 1)));
      this.cargarExpediente();
    });
    // Deep-link desde la cobertura de Compras 360 (`?suc=03`).
    const suc = this.route.snapshot.queryParamMap.get('suc');
    if (suc) this.sucursalSel.set(suc);
    this.reload();
  }

  reload(): void { this.pedir.next(); }
  setOrden(v: string): void { this.orden.set(v as 'riesgo' | 'antiguedad'); this.idx.set(0); this.reload(); }
  setSucursal(v: string | null): void { this.sucursalSel.set(v || null); this.idx.set(0); this.reload(); }
  setSoloDescuadre(v: boolean): void { this.soloDescuadre.set(v); this.idx.set(0); this.reload(); }
  ir(i: number): void {
    if (i < 0 || i >= this.cola().length) return;
    this.idx.set(i);
    this.cargarExpediente();
  }

  // ── expediente ──
  readonly detail = signal<EntradaDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly explica = signal<AdjustmentForEntradaRow[]>([]);
  readonly explicaLoading = signal(false);
  /** `[RE.21]` — el veredicto sobre el hueco: quién lo explica, de qué naturaleza y con cuánta certeza. */
  readonly explicacion = signal<AdjustmentExplicacion | null>(null);
  readonly inspect = signal<string | null>(null);

  // ── `[RE.22.1]` desglose de un ajuste (clic en la fila) ──
  /** Acordeón: un solo ajuste abierto. Clave = doctype+folio, la misma del `track`. */
  readonly ajusteAbierto = signal<string | null>(null);
  /** Caché por clave: reabrir no vuelve a pedir. `null` = pedido y falló. */
  private readonly desgloseCache = new Map<string, AdjustmentLinesResponse | null>();
  readonly desglose = signal<AdjustmentLinesResponse | null>(null);
  readonly desgloseLoading = signal(false);
  readonly desgloseError = signal(false);

  claveAjuste(a: AdjustmentForEntradaRow): string { return a.doctype + a.folio; }

  /**
   * `[RE.22.1]` — abre/cierra el desglose de un ajuste. La respuesta se descarta si mientras
   * viajaba se abrió otro (o se cerró): sin ese corte se pintarían los renglones de un ajuste
   * bajo el encabezado de otro, que es peor que no mostrarlos porque se ve correcto.
   */
  toggleAjuste(a: AdjustmentForEntradaRow): void {
    const clave = this.claveAjuste(a);
    if (this.ajusteAbierto() === clave) { this.ajusteAbierto.set(null); return; }
    this.abrirAjuste(a, clave);
  }

  /** Reintento tras un fallo: hay que OLVIDAR el fallo cacheado o se repite la misma respuesta. */
  reintentarAjuste(a: AdjustmentForEntradaRow): void {
    const clave = this.claveAjuste(a);
    this.desgloseCache.delete(clave);
    this.abrirAjuste(a, clave);
  }

  private abrirAjuste(a: AdjustmentForEntradaRow, clave: string): void {
    this.ajusteAbierto.set(clave);
    this.desgloseError.set(false);
    if (this.desgloseCache.has(clave)) {
      const hit = this.desgloseCache.get(clave) ?? null;
      this.desglose.set(hit);
      this.desgloseError.set(hit === null);
      this.desgloseLoading.set(false);
      return;
    }
    this.desglose.set(null);
    this.desgloseLoading.set(true);
    this.compras.adjustmentLines({ sucursal: a.sucursal, folio: a.folio, doctype: a.doctype })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.desgloseCache.set(clave, r);
          if (this.ajusteAbierto() !== clave) return;   // se abrió otro mientras viajaba
          this.desglose.set(r); this.desgloseLoading.set(false);
        },
        error: () => {
          this.desgloseCache.set(clave, null);
          if (this.ajusteAbierto() !== clave) return;
          this.desgloseLoading.set(false); this.desgloseError.set(true);
        },
      });
  }

  /**
   * `[RE.17.4]` — todas las hojas del expediente, aplanadas para el visor. Un expediente puede
   * tener más de un depósito (se subió, se devolvió, se volvió a subir) y el revisor tiene que
   * poder mirar cualquiera de las hojas, no sólo las del último.
   */
  readonly hojas = computed<DocViewerFile[]>(() =>
    (this.detail()?.deposits || []).flatMap((dep) =>
      (dep.files || []).map((f) => ({ url: f.url, name: f.name, role: f.role, kind: f.kind }))));
  readonly hojaIdx = signal(0);

  refProv(code: string): string { return entityRef('prov', code); }
  refEnt(sucursal: string, folio: string): string { return entityRef('ent', sucursal, 'XA2001', folio); }

  verdict(d: EntradaDetail) { return receiptVerdict(d, this.explica().length > 0); }
  etiquetaEstado(s: string): string {
    return s === 'recibido' ? 'Subida' : s === 'validado' ? 'Aprobada' : s === 'rechazado' ? 'Devuelta' : s;
  }

  private cargarExpediente(): void {
    const c = this.actual();
    this.detail.set(null); this.hojaIdx.set(0); this.explica.set([]);
    if (!c) return;
    this.detailLoading.set(true);
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.detailLoading.set(false);
        this.detail.set(d);
        // La primera hoja se muestra sola: el trabajo es comparar, no hacer clics.
        this.hojaIdx.set(0);
      },
      error: (e) => {
        this.detailLoading.set(false);
        this.error.set(e?.error?.message || 'No se pudo abrir el expediente.');
      },
    });
    if (c.proveedor_code) {
      this.explicaLoading.set(true);
      // `[RE.21]` — se manda EL HUECO. Sin él el server devolvía hasta 50 candidatos del mismo
      // proveedor en ±15 días, sin decir cuál importa; con él marca los que tienen el tamaño de
      // la diferencia y devuelve un veredicto. Kepler no liga la nota de crédito a la recepción
      // (el 96% no trae folio de entrada, y las X-D-55 el 100%), así que el monto es la única
      // evidencia defendible — y la decide una persona, no el motor.
      this.compras.adjustmentsForEntrada({
        proveedor_code: c.proveedor_code, entrada_folio: c.folio, date: c.receipt_date, window_days: 15,
        delta: c.discrepancy_amount ?? null,
        tolerancia: this.report()?.settings?.match_tolerance,
      })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => {
            this.explicaLoading.set(false);
            this.explica.set(r?.rows || []);
            this.explicacion.set(r?.explicacion ?? null);
          },
          error: () => { this.explicaLoading.set(false); this.explica.set([]); this.explicacion.set(null); },
        });
    } else { this.explicacion.set(null); }
  }

  // ── decidir ──
  aprobar(): void {
    const c = this.actual();
    if (!c?.deposit_id || this.acting() || !this.canValidate() || this.bloqueoPropio()) return;
    this.acting.set(true);
    this.svc.validate(c.deposit_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.acting.set(false);
        this.decididasHoy.update((n) => n + 1);
        this.toast.add({ severity: 'success', summary: `Aprobada — ${c.folio}`, detail: c.proveedor_nombre || '' });
        this.siguiente();
      },
      error: (e) => { this.acting.set(false); this.avisarColision(e); },
    });
  }

  readonly showRechazo = signal(false);
  readonly motivoCodigo = signal<string | null>(null);
  readonly rejError = signal('');
  motivoTexto = '';
  abrirRechazo(): void { this.motivoCodigo.set(null); this.motivoTexto = ''; this.rejError.set(''); this.showRechazo.set(true); }
  cerrarRechazo(): void { this.showRechazo.set(false); }
  onRechazoVisible(v: boolean): void { if (!v) this.cerrarRechazo(); }

  devolver(): void {
    const c = this.actual();
    const code = this.motivoCodigo();
    if (!c?.deposit_id || !code || this.acting()) return;
    if (code === 'otro' && !this.motivoTexto.trim()) { this.rejError.set('Con "Otro" hace falta explicar.'); return; }
    this.acting.set(true);
    this.svc.reject(c.deposit_id, this.motivoTexto.trim() || undefined, code)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.acting.set(false);
          this.decididasHoy.update((n) => n + 1);
          this.showRechazo.set(false);
          this.toast.add({ severity: 'info', summary: `Devuelta — ${c.folio}`, detail: motivoLabel(code) });
          this.siguiente();
        },
        error: (e) => { this.acting.set(false); this.rejError.set(e?.error?.message || 'No se pudo devolver.'); },
      });
  }

  /**
   * Revisor central y local pueden estar mirando la misma fila. El backend rechaza la segunda
   * decisión con un mensaje claro; acá eso NO es un error del usuario: se avisa y se avanza.
   */
  private avisarColision(e: any): void {
    const msg = e?.error?.message || 'No se pudo aprobar.';
    const ganada = /ya (est|decid)/i.test(msg);
    this.toast.add({
      severity: ganada ? 'info' : 'error',
      summary: ganada ? 'Otra persona ya la decidió' : 'No se pudo aprobar',
      detail: msg,
    });
    if (ganada) this.siguiente(); else this.reload();
  }

  /** Saca la decidida de la cola local y abre la siguiente sin recargar todo. */
  private siguiente(): void {
    const r = this.report();
    const i = this.idx();
    if (!r) return;
    const rows = r.rows.filter((_, n) => n !== i);
    this.report.set({
      ...r, rows,
      kpis: { ...r.kpis, por_validar: Math.max(0, r.kpis.por_validar - 1) },
    });
    this.idx.set(Math.min(i, Math.max(0, rows.length - 1)));
    this.cargarExpediente();
  }

  // ── selección múltiple ──
  /** Ids de evidencia marcados a mano. Vacío = el lote trabaja sobre `limpias()`. */
  readonly sel = signal<ReadonlySet<string>>(new Set());
  estaSel(c: EntradaRow): boolean { return !!c.deposit_id && this.sel().has(c.deposit_id); }
  alternarSel(c: EntradaRow): void {
    const id = c.deposit_id;
    if (!id) return;
    const s = new Set(this.sel());
    s.has(id) ? s.delete(id) : s.add(id);
    this.sel.set(s);
  }
  limpiarSel(): void { this.sel.set(new Set()); }

  /** Sobre qué actúa el lote: la selección si la hay, si no las que cuadran solas. */
  readonly loteObjetivo = computed<EntradaRow[]>(() => {
    const s = this.sel();
    return s.size ? this.cola().filter((c) => !!c.deposit_id && s.has(c.deposit_id)) : this.limpias();
  });
  readonly montoSel = computed(() => this.loteObjetivo().reduce((t, c) => t + (Number(c.monto) || 0), 0));
  /** Cuántas de las elegidas el server va a omitir por descuadre: se dice ANTES, no después. */
  readonly selConDescuadre = computed(() => this.loteObjetivo().filter((c) => !c.monto_match).length);

  // ── lote ──
  readonly showLote = signal(false);
  /** Resultado por expediente de la última corrida (§10). Vacío = el diálogo pide confirmación. */
  readonly resultado = signal<{ id: string; ok: boolean; motivo?: string }[]>([]);
  abrirLote(): void { this.resultado.set([]); this.showLote.set(true); }
  cerrarLote(): void { this.showLote.set(false); this.resultado.set([]); }
  onLoteVisible(v: boolean): void { if (!v) this.cerrarLote(); }

  /** Para el resultado: del id de evidencia al folio, que es como la nombra el revisor. */
  etiquetaDe(id: string): string {
    const c = this.cola().find((x) => x.deposit_id === id);
    return c ? `${this.suc(c.sucursal)} · ${c.folio}` : id.slice(0, 8);
  }

  aprobarLote(): void {
    const ids = this.loteObjetivo().map((c) => c.deposit_id as string).filter(Boolean);
    if (!ids.length || this.bulking()) return;
    this.bulking.set(true);
    this.svc.validateBulk(ids).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.bulking.set(false);
        this.decididasHoy.update((n) => n + r.validadas);
        // El diálogo se queda abierto mostrando qué pasó con cada una: un toast que dice
        // "2 quedaron en la cola" sin decir cuáles ni por qué obliga a buscarlas a ojo.
        this.resultado.set(r.detalle || []);
        if (!r.omitidas) this.cerrarLote();
        // Las fallidas siguen seleccionadas para corregirlas; las exitosas salen (§10).
        const fallidas = new Set((r.detalle || []).filter((d) => !d.ok).map((d) => d.id));
        this.sel.set(fallidas);
        this.toast.add({
          severity: r.omitidas ? 'warn' : 'success',
          summary: `${r.validadas} ${r.validadas === 1 ? 'aprobada' : 'aprobadas'}`,
          detail: r.omitidas ? `${r.omitidas} siguen seleccionadas, con su motivo` : 'Todas cuadraban al peso',
        });
        this.idx.set(0);
        this.reload();
      },
      error: (e) => {
        this.bulking.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo aprobar el lote', detail: e?.error?.message || '' });
      },
    });
  }

  /** Una cola se trabaja con el teclado. No se dispara si el foco está en un campo. */
  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (this.showRechazo() || this.showLote()) return;
    const t = ev.target as HTMLElement | null;
    const tag = (t?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const k = ev.key.toLowerCase();
    if (k === 'j') { this.ir(this.idx() + 1); ev.preventDefault(); }
    else if (k === 'k') { this.ir(this.idx() - 1); ev.preventDefault(); }
    else if (k === 'a') { this.aprobar(); ev.preventDefault(); }
    else if (k === 'r') { if (this.canValidate() && !this.bloqueoPropio()) this.abrirRechazo(); ev.preventDefault(); }
  }
}
