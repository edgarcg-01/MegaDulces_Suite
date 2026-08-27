import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, of, switchMap, catchError, firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import {
  EntradasService, EntradaRow, EntradasReport, EntradasQuery, ProofFile, RemisionOcr, AttachReceipt,
} from '../entradas.service';
import { branchName, STORE_BRANCHES } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';
import { motivoLabel } from '../receipt-verdict';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/** En qué punto va una hoja de la bandeja. `enlazada` = ya sabe a qué entrada pertenece. */
type EstadoHoja = 'leyendo' | 'enlazada' | 'ambigua' | 'sin_match' | 'duplicada' | 'guardada' | 'error';

/** Un PDF en la bandeja, con su lectura y la entrada a la que va. */
interface Hoja {
  id: number;
  name: string;
  dataUri: string;
  bytes: number;
  estado: EstadoHoja;
  sha256?: string;
  folioOcr?: string | null;
  total?: number | null;
  subtotal?: number | null;
  fecha?: string | null;
  rfc?: string | null;
  ocr?: Partial<RemisionOcr>;
  /** A qué orden de entrada va. Se preselecciona si el PDF se soltó sobre una fila. */
  entrada?: EntradaRow | null;
  /** Se enlazó por importe y no por folio: vale decirlo, es un enlace más débil. */
  porMonto?: boolean;
  candidatas?: EntradaRow[];
  dupDe?: string | null;
  motivo?: string;
  busqueda?: string;
  buscando?: boolean;
}

/**
 * `[RE.16.4]` — **Pendientes de subir**: la worklist del que tiene las facturas.
 *
 * Rediseñada sobre dos hechos que corrigieron el diseño anterior:
 *
 *  1. **Todos capturan en lap o escritorio**, no en el celular junto a la mercancía. La lista
 *     apilada de 56 px por renglón mostraba 8 órdenes donde caben 25, y el diálogo modal tapaba
 *     justo la tabla que hay que seguir mirando. Ahora: tabla densa + panel lateral.
 *  2. **El PDF ya existe** en la carpeta del escáner. Adjuntarlo costaba cuatro interacciones
 *     (botón → diálogo → elegir archivo → guardar); ahora **se arrastra sobre su fila** y es una.
 *
 * Y con eso desaparece una pantalla: **soltar varios PDFs a la vez ES el lote de CEDIS**. La
 * bandeja es la misma lista de hojas, sólo cambia de dónde salió la entrada — de la fila donde
 * se soltó, o del folio que leyó el OCR. Guardar es un solo camino (`attach-bulk`, agrupando por
 * expediente), así que no hay dos lógicas de guardado que se puedan ir separando con el tiempo.
 *
 * Vocabulario único de la fase: **Sin factura → Por revisar → Validada**, con **Devuelta** como
 * el único camino de regreso. Antes cada pantalla les daba un nombre distinto.
 *
 * Lo que NO vive acá: la auditoría por línea, los ajustes del proveedor y la validación. Son el
 * trabajo del revisor (`/compras/entradas/revision`) y del Centro de control.
 */
@Component({
  selector: 'app-compras-entradas-pendientes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule,
    TagModule, ToastModule, TooltipModule, SegmentedComponent, LoadStateComponent,
    FreshnessPillComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in ep">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pendientes de subir</h1>
          <p class="surf-page-sub">
            Arrastrá el <strong>PDF de la factura</strong> sobre su orden. Leo el total, lo comparo
            contra Kepler y te digo si cuadra antes de guardar. Lo más atrasado va primero.
          </p>
        </div>
        <div class="ep-head-actions">
          @if (variasSucursales()) {
            <p-select [options]="sucursalOpts()" [ngModel]="sucursalSel()" (onChange)="setSucursal($event.value)"
                      optionLabel="label" optionValue="value" placeholder="Todas las mías" [showClear]="true"
                      styleClass="ep-sel" ariaLabel="Sucursal" appendTo="body" />
          } @else if (unaSucursal(); as s) {
            <span class="ep-suc-fija" pTooltip="Tu alcance es esta sucursal" tooltipPosition="bottom">
              <i class="pi pi-building" aria-hidden="true"></i> {{ s }}
            </span>
          }
          <app-freshness-pill [since]="cargadoAt()" [staleAfterSec]="600" />
          <app-context-help topic="compras-entradas" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="reload()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (sinAlcance()) {
        <!-- Fail-closed explicado: sin sucursal en la ficha no hay filas, y una tabla vacía se
             lee como "el sistema no funciona". -->
        <div class="ep-block" role="status">
          <i class="pi pi-lock" aria-hidden="true"></i>
          <div>
            <p class="ep-block-t">Tu usuario no tiene sucursal asignada</p>
            <p class="ep-block-s">Sin sucursal no hay entradas que mostrarte. Pedile a Sistemas que te
              configure el alcance de sucursal y volvé a entrar.</p>
          </div>
        </div>
      } @else {

        @if (report(); as r) {
          <!-- Answer-first (DESIGN Q.1): una oración con lo que falta, antes de la tabla. -->
          <p class="ep-verdict" [class.is-done]="faltan(r) === 0" [class.is-late]="r.kpis.atrasadas > 0">
            @if (faltan(r) === 0) {
              <i class="pi pi-check-circle" aria-hidden="true"></i> Todo al día — no te falta subir nada.
            } @else {
              Te faltan <b>{{ faltan(r) }}</b> facturas de {{ r.kpis.entradas }}
              @if (r.kpis.atrasadas > 0) {
                · <button type="button" class="ep-late-btn" (click)="soloAtrasadas()"
                          [pTooltip]="'Más de ' + r.settings.sla_capture_days + ' días sin factura'" tooltipPosition="bottom">
                  {{ r.kpis.atrasadas }} ya pasaron los {{ r.settings.sla_capture_days }} días
                </button>
              }
              <span class="ep-bar" [attr.aria-label]="avance(r) + '% subido'">
                <span [style.width.%]="avance(r)"></span>
              </span>
              <em>{{ avance(r) }}% subido</em>
            }
          </p>

          @if (r.kpis.rechazados > 0 && estado() !== 'rechazado') {
            <!-- Una factura devuelta se quedaba muerta: el que la subió nunca se enteraba. -->
            <button type="button" class="ep-returned" (click)="setEstado('rechazado')">
              <i class="pi pi-undo" aria-hidden="true"></i>
              <span><strong>{{ r.kpis.rechazados }}</strong> te {{ r.kpis.rechazados === 1 ? 'la devolvieron' : 'las devolvieron' }} — hay que volver a subirlas</span>
              <i class="pi pi-angle-right" aria-hidden="true"></i>
            </button>
          }
        }

        <div class="ep-filters">
          <app-segmented [options]="estadoOpts" [value]="estado()" (valueChange)="setEstado($event)" ariaLabel="Qué mostrar" />
          <input pInputText [(ngModel)]="search" (keyup.enter)="reload()" (blur)="reload()"
                 placeholder="Últimos 4 del folio (ej. 0397) o proveedor…" class="ep-search" aria-label="Buscar entrada" />
          @if (rezago()) {
            <button pButton type="button" class="p-button-sm p-button-text" (click)="setRezago(false)"
                    pTooltip="Volver al periodo del proceso" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
              <span class="p-button-label">Salir del rezago</span>
            </button>
          } @else if (report()?.settings; as cfg) {
            <button pButton type="button" class="p-button-sm p-button-text ep-rezago" (click)="setRezago(true)"
                    [pTooltip]="'Entradas anteriores al ' + cfg.reception_start + ' — fuera del proceso vivo'" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span>
              <span class="p-button-label">Ver rezago</span>
            </button>
          }
          <span class="ep-sp"></span>
          @if (canManage()) {
            <label class="ep-pick small">
              <i class="pi pi-file-pdf" aria-hidden="true"></i> Elegir PDFs…
              <input type="file" accept="application/pdf" multiple (change)="onFiles($event)" hidden />
            </label>
          }
        </div>

        <div class="ep-body" [class.has-panel]="hojas().length > 0">
          <!-- Zona de soltado de TODA la tabla: si el PDF no cae sobre una fila, se enlaza por
               el folio que lea el OCR. Es el camino "tengo el papel y no sé de qué orden es". -->
          <div class="ep-tablewrap" [class.dragging]="dragTabla()"
               (dragover)="onDragOverTabla($event)" (dragleave)="onDragLeaveTabla($event)" (drop)="onDropTabla($event)">
            @if (error()) {
              <app-load-state [error]="error()" (retry)="reload()" />
            } @else if (loading() && !report()) {
              <app-load-state [loading]="true" [skeletonRows]="10" />
            } @else if (rows().length === 0) {
              <app-load-state [isEmpty]="true" emptyIcon="pi-check-circle"
                              [emptyTitle]="estado() === 'pendiente' ? 'No te falta ninguna factura' : 'Sin entradas en este filtro'"
                              [emptyHint]="estado() === 'pendiente' ? 'Cuando el ERP registre una orden nueva, aparece acá sola.' : 'Probá con otro estado o quitá el buscador.'"
                              [emptyCta]="estado() === 'pendiente' ? null : 'Ver lo que falta subir'"
                              emptyCtaIcon="pi pi-list" (cta)="setEstado('pendiente')" />
            } @else {
              <table class="surf-table surf-table--sticky surf-table--frozen-first surf-table--compact ep-table"
                     [class.loading]="loading()">
                <thead>
                  <tr>
                    <th scope="col" class="ta-r" pTooltip="Días desde la recepción" tooltipPosition="top">Días</th>
                    <th scope="col">Folio</th>
                    <th scope="col">Proveedor</th>
                    <th scope="col" class="ta-r">Recepción</th>
                    <th scope="col" class="ta-r">Total Kepler</th>
                    <th scope="col">Factura</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of rows(); track c.sucursal + '/' + c.folio) {
                    <tr [class.is-drop]="dragFila() === clave(c)"
                        [class.is-open]="abierta() && clave(abierta()!) === clave(c)"
                        (dragover)="onDragOverFila($event, c)" (dragleave)="onDragLeaveFila($event)"
                        (drop)="onDropFila($event, c)">
                      <td class="ta-r ep-dias" [class]="'is-' + tono(c)">{{ c.dias }}<em>d</em></td>
                      <td class="ep-folio">
                        <b class="mono" [pTooltip]="'Folio ' + c.folio" tooltipPosition="top">{{ ultimos4(c.folio) }}</b>
                        @if (variasSucursales()) { <em>{{ suc(c.sucursal) }}</em> }
                      </td>
                      <td class="ep-prov">
                        <span [pTooltip]="c.proveedor_nombre || ''" tooltipPosition="top">{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
                        @if (c.deposit_status === 'rechazado') {
                          <!-- El motivo va EN la fila: el catálogo tipificado sólo sirve si el que
                               tiene que corregir lo ve sin abrir nada. -->
                          <p-tag [value]="'Devuelta: ' + porQue(c)" severity="danger" styleClass="ep-tag" />
                        }
                      </td>
                      <td class="ta-r mono">
                        {{ c.receipt_date | date:'dd/MM' }}
                        @if (c.fecha_futura) {
                          <i class="pi pi-exclamation-triangle ep-warn" pTooltip="Fecha capturada adelantada en el ERP" tooltipPosition="top"></i>
                        }
                      </td>
                      <td class="ta-r mono ep-monto">{{ money(c.monto) }}</td>
                      <td class="ep-cta">
                        @if (dragFila() === clave(c)) {
                          <b class="ep-drophere"><i class="pi pi-download" aria-hidden="true"></i> Soltá acá el PDF</b>
                        } @else if (c.deposit_status === 'validado') {
                          <span class="ep-ok"><i class="pi pi-check" aria-hidden="true"></i> Validada</span>
                        } @else if (c.deposit_status === 'recibido') {
                          <span class="ep-wait">Por revisar
                            @if (!c.monto_match) {
                              <i class="pi pi-exclamation-triangle ep-warn" pTooltip="El total de la factura no cuadra con Kepler" tooltipPosition="top"></i>
                            }
                          </span>
                        } @else if (canManage()) {
                          <label class="ep-rowpick">
                            <span>{{ c.deposit_status === 'rechazado' ? 'Soltar el PDF corregido' : 'Soltar PDF' }} · <b>elegir</b></span>
                            <input type="file" accept="application/pdf" multiple hidden (change)="onFilesFila($event, c)" />
                          </label>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>

              @if (report(); as r) {
                <div class="ep-pager">
                  <span>{{ desde() }}–{{ hasta() }} de <strong>{{ r.total }}</strong></span>
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="page() === 1 || loading()" (click)="irPagina(page() - 1)">
                    <span class="p-button-icon pi pi-angle-left" aria-hidden="true"></span><span class="p-button-label">Anterior</span>
                  </button>
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="hasta() >= r.total || loading()" (click)="irPagina(page() + 1)">
                    <span class="p-button-label">Siguiente</span><span class="p-button-icon pi pi-angle-right" aria-hidden="true"></span>
                  </button>
                </div>
              }
            }

            @if (dragTabla() && !dragFila()) {
              <div class="ep-dropveil" aria-hidden="true">
                <div>
                  <i class="pi pi-download" aria-hidden="true"></i>
                  <b>Soltá los PDFs</b>
                  <em>los enlazo por el folio que traigan</em>
                </div>
              </div>
            }
          </div>

          @if (hojas().length) {
            <!-- Panel lateral y no diálogo: la tabla se sigue viendo, que es lo que da contexto. -->
            <aside class="ep-panel" aria-label="Facturas en preparación">
              <header class="ep-panel-h">
                <b>{{ hojas().length }} {{ hojas().length === 1 ? 'PDF' : 'PDFs' }} en preparación</b>
                <span class="ep-sp"></span>
                <button type="button" class="ep-x" (click)="limpiar()" aria-label="Vaciar la bandeja">
                  <i class="pi pi-times" aria-hidden="true"></i>
                </button>
              </header>

              <div class="ep-panel-b">
                @for (h of hojas(); track h.id) {
                  <article class="ep-hoja" [class.bad]="h.estado === 'duplicada' || h.estado === 'error'"
                           [class.ok]="h.estado === 'enlazada' || h.estado === 'guardada'">
                    <header class="ep-hoja-h">
                      <i class="pi pi-file-pdf" aria-hidden="true"></i>
                      <b [pTooltip]="h.name" tooltipPosition="top">{{ h.name }}</b>
                      <span class="ep-sp"></span>
                      <button type="button" class="ep-x" (click)="quitar(h)" [attr.aria-label]="'Quitar ' + h.name">
                        <i class="pi pi-times" aria-hidden="true"></i>
                      </button>
                    </header>

                    @switch (h.estado) {
                      @case ('leyendo') {
                        <p class="ep-hoja-s"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo la factura…</p>
                      }
                      @case ('duplicada') {
                        <p class="ep-hoja-s is-bad">Este PDF ya está subido en la entrada <b class="mono">{{ h.dupDe }}</b>. No se vuelve a guardar.</p>
                      }
                      @case ('error') {
                        <p class="ep-hoja-s is-bad">{{ h.motivo || 'No se pudo procesar' }}</p>
                      }
                      @case ('guardada') {
                        <p class="ep-hoja-s is-ok"><i class="pi pi-check" aria-hidden="true"></i> Enviada.</p>
                      }
                      @case ('enlazada') {
                        <dl class="ep-kv">
                          <div><dt>Va a la entrada</dt><dd class="mono">{{ h.entrada!.sucursal }}/{{ ultimos4(h.entrada!.folio) }}</dd></div>
                          <div><dt>{{ h.entrada!.proveedor_nombre ? 'Proveedor' : 'Código' }}</dt><dd>{{ h.entrada!.proveedor_nombre || h.entrada!.proveedor_code || '—' }}</dd></div>
                          <div><dt>Total en Kepler</dt><dd class="mono">{{ money(h.entrada!.monto) }}</dd></div>
                          <div><dt>Leí en la factura</dt><dd class="mono">{{ h.total != null ? money(h.total) : (h.subtotal != null ? money(h.subtotal) : '—') }}</dd></div>
                        </dl>
                        @if (h.porMonto) {
                          <p class="ep-hoja-s">Enlazada por <b>importe</b> (la factura no traía folio legible) — verificá que sea la orden correcta.</p>
                        }
                        @if (h.entrada!.gemela_monto != null && h.entrada!.gemela_delta) {
                          <!-- La misma recepción también está capturada en oficinas y con otro
                               importe. Sin esto, la factura "no cuadra" por centavos que no son
                               del proveedor. -->
                          <p class="ep-hoja-s">
                            <i class="pi pi-clone" aria-hidden="true"></i>
                            Oficinas la capturó como <b class="mono">00/{{ h.entrada!.gemela_folio }}</b> por
                            <b>{{ money(h.entrada!.gemela_monto!) }}</b>. Cuadra con cualquiera de los dos.
                          </p>
                        }
                        @if (cuadre(h) !== null) {
                          <p class="ep-cuadre" [class.ok]="cuadre(h)" [class.bad]="!cuadre(h)" role="status">
                            @if (cuadre(h) && porGemela(h)) {
                              <i class="pi pi-check-circle" aria-hidden="true"></i> Cuadra con la captura de <b>oficinas</b>; con la de la sucursal difiere {{ money(dif(h)) }}.
                            } @else if (cuadre(h)) {
                              <i class="pi pi-check-circle" aria-hidden="true"></i> <b>Cuadra</b> con el total de Kepler.
                            } @else {
                              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Difiere <b>{{ money(dif(h)) }}</b>. Se puede enviar: el revisor decide.
                            }
                          </p>
                        }
                        <button type="button" class="ep-link" (click)="desenlazar(h)">cambiar de entrada</button>
                      }
                      @default {
                        <!-- ambigua / sin_match: la decisión es del humano, con los candidatos a
                             la vista y un buscador por folio. -->
                        <p class="ep-hoja-s">
                          @if (h.estado === 'ambigua') { Hay más de una orden que le queda. Elegí cuál: }
                          @else { No encontré la orden de esta factura. Buscala por folio o proveedor: }
                          @if (h.total != null) { <em>(leí {{ money(h.total) }}@if (h.folioOcr) { · folio {{ h.folioOcr }} })</em> }
                        </p>
                        <div class="ep-find">
                          <input pInputText [ngModel]="h.busqueda" (ngModelChange)="setBusqueda(h, $event)"
                                 (keyup.enter)="buscar(h)" placeholder="Folio o proveedor" class="ep-find-in"
                                 [attr.aria-label]="'Buscar la entrada de ' + h.name" />
                          <button pButton type="button" class="p-button-sm" [loading]="!!h.buscando" (click)="buscar(h)">
                            <span class="p-button-label">Buscar</span>
                          </button>
                        </div>
                        @for (e of h.candidatas || []; track e.sucursal + '/' + e.folio) {
                          <button type="button" class="ep-cand" (click)="elegir(h, e)">
                            <b class="mono">{{ e.sucursal }}/{{ ultimos4(e.folio) }}</b>
                            <span>{{ e.proveedor_nombre || e.proveedor_code || '—' }}</span>
                            <em class="mono">{{ money(e.monto) }}</em>
                          </button>
                        }
                      }
                    }
                  </article>
                }
              </div>

              <footer class="ep-panel-f">
                @if (capError()) { <p class="ep-err">{{ capError() }}</p> }
                <p class="ep-panel-n">
                  {{ nExpedientes() }} {{ nExpedientes() === 1 ? 'expediente' : 'expedientes' }} listo{{ nExpedientes() === 1 ? '' : 's' }}
                  @if (nBloqueadas()) { · {{ nBloqueadas() }} sin resolver }
                </p>
                <button pButton type="button" class="ep-send" [loading]="guardando()" [disabled]="!nExpedientes() || guardando()"
                        (click)="guardar()">
                  <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                  <span class="p-button-label">Enviar {{ nExpedientes() > 1 ? nExpedientes() + ' facturas' : 'la factura' }}</span>
                </button>
              </footer>
            </aside>
          }
        </div>

        @if (canManage()) {
          <!-- El lote dejó de ser una pantalla: soltar N archivos ES el lote. Se dice acá porque
               nadie descubre solo una interacción que no está escrita. -->
          <p class="ep-lote-hint">
            <b>¿Muchas de una vez?</b> Soltá <b>varios PDFs</b> en cualquier parte de la tabla: los
            enlazo por folio y sólo confirmás. Hasta {{ tope() }} por vez.
          </p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .ep-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .ep-suc-fija {
      display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs);
      color: var(--text-muted); border: 1px solid var(--border-color);
      border-radius: var(--r-sm, .35rem); padding: .18rem .5rem;
    }

    /* Answer-first: una oración, no una caja de KPIs. */
    .ep-verdict {
      display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
      margin: var(--sp-4) 0 var(--sp-3); font-size: var(--fs-h3); color: var(--text-main);
    }
    .ep-verdict b { font-variant-numeric: tabular-nums; }
    .ep-verdict.is-done { color: var(--ok-fg); font-weight: 600; }
    .ep-verdict.is-late b { color: var(--bad-fg); }
    .ep-verdict em { font-style: normal; font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-late-btn {
      font: inherit; font-size: var(--fs-sm); color: var(--bad-fg); background: none; border: 0;
      border-bottom: 1px solid currentColor; padding: 0; cursor: pointer;
    }
    .ep-bar { flex: 0 1 10rem; height: 4px; border-radius: var(--r-pill, 999px); background: var(--border-color); overflow: hidden; }
    .ep-bar > span { display: block; height: 100%; background: var(--ok-fg); }

    .ep-returned {
      display: flex; align-items: center; gap: var(--sp-2); width: 100%; text-align: left;
      padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3); cursor: pointer; font: inherit;
      font-size: var(--fs-sm); color: var(--bad-fg);
      background: color-mix(in oklab, var(--bad-fg) 7%, transparent);
      border: 1px solid color-mix(in oklab, var(--bad-fg) 35%, var(--border-color));
      border-radius: var(--r-md, .5rem);
    }
    .ep-returned > span { flex: 1; }

    .ep-block {
      display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-4) var(--sp-5);
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-2);
    }
    .ep-block .pi { font-size: 1.2rem; color: var(--text-muted); }
    .ep-block-t { margin: 0 0 var(--sp-1); font-weight: 600; }
    .ep-block-s { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 46ch; }

    .ep-filters { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-3); }
    .ep-search { flex: 0 1 22rem; min-width: 12rem; }
    .ep-sp { flex: 1 1 auto; }

    /* Tabla + panel: el panel sólo ocupa lugar cuando hay algo en preparación. */
    .ep-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
    .ep-body.has-panel { grid-template-columns: minmax(0, 1fr) 22rem; }
    @media (max-width: 68rem) { .ep-body.has-panel { grid-template-columns: minmax(0, 1fr); } }

    .ep-tablewrap {
      position: relative; overflow-x: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--card-bg);
    }
    .ep-tablewrap.dragging { border-color: var(--action); }

    .ep-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ep-table.loading { opacity: .6; }
    .ep-table th {
      text-align: left; font-weight: 600; font-size: var(--fs-micro); letter-spacing: .03em;
      text-transform: uppercase; color: var(--text-muted); white-space: nowrap;
      padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color);
    }
    .ep-table td {
      padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color);
      height: var(--row-h-md); vertical-align: middle;
    }
    .ep-table tbody tr:last-child td { border-bottom: 0; }
    .ep-table .mono, .ep-folio b { font-family: var(--font-mono, inherit); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }

    /* Fila objetivo del arrastre: anillo interno + fondo de acción. Es la única cosa naranja
       de la pantalla, y por eso se ve. */
    .ep-table tbody tr.is-drop > td {
      background: var(--action-soft, color-mix(in oklab, var(--action) 10%, transparent));
      box-shadow: inset 0 1.5px 0 var(--action), inset 0 -1.5px 0 var(--action);
    }
    .ep-table tbody tr.is-open > td { background: var(--table-hover); }

    .ep-dias { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ep-dias em { font-style: normal; font-size: .7em; opacity: .7; }
    .ep-dias.is-ok { color: var(--text-muted); }
    .ep-dias.is-warn { color: var(--warn-fg); }
    .ep-dias.is-bad { color: var(--bad-fg); }

    .ep-folio b { font-size: var(--fs-body); }
    .ep-folio em { display: block; font-style: normal; font-size: var(--fs-micro); color: var(--text-faint); }
    .ep-prov { max-width: 22rem; }
    .ep-prov > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ep-monto { font-weight: 600; }
    .ep-warn { color: var(--warn-fg); margin-left: .25rem; }

    .ep-cta { white-space: nowrap; font-size: var(--fs-xs); }
    .ep-drophere { color: var(--action); font-weight: 600; }
    .ep-ok { color: var(--ok-fg); }
    .ep-wait { color: var(--text-muted); }
    .ep-rowpick { color: var(--text-faint); cursor: pointer; }
    .ep-rowpick b { color: var(--text-muted); font-weight: 600; border-bottom: 1px solid currentColor; }
    .ep-rowpick:hover b { color: var(--action); }
    .ep-rowpick:focus-within { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }

    .ep-dropveil {
      position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
      background: color-mix(in oklab, var(--card-bg) 82%, transparent);
    }
    .ep-dropveil > div { display: grid; justify-items: center; gap: var(--sp-1); color: var(--action); }
    .ep-dropveil .pi { font-size: 1.6rem; }
    .ep-dropveil em { font-style: normal; font-size: var(--fs-xs); color: var(--text-muted); }

    .ep-pager {
      display: flex; align-items: center; gap: var(--sp-2); justify-content: flex-end;
      padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color);
      font-size: var(--fs-xs); color: var(--text-muted);
    }

    /* Panel lateral */
    .ep-panel {
      position: sticky; top: var(--sp-2);
      display: flex; flex-direction: column; max-height: calc(100vh - 9rem);
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--card-bg);
    }
    .ep-panel-h {
      display: flex; align-items: center; gap: var(--sp-2);
      padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color);
      font-size: var(--fs-sm);
    }
    .ep-panel-b { flex: 1 1 auto; overflow-y: auto; padding: var(--sp-3); display: grid; gap: var(--sp-3); }
    .ep-panel-f {
      display: grid; gap: var(--sp-2); padding: var(--sp-3);
      border-top: 1px solid var(--border-color); background: var(--surface-2);
    }
    .ep-panel-n { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-send { width: 100%; justify-content: center; }
    .ep-err { margin: 0; font-size: var(--fs-xs); color: var(--bad-fg); }

    .ep-hoja {
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem);
      padding: var(--sp-2); display: grid; gap: var(--sp-2);
    }
    .ep-hoja.ok { border-color: color-mix(in oklab, var(--ok-fg) 30%, var(--border-color)); }
    .ep-hoja.bad { border-color: color-mix(in oklab, var(--bad-fg) 40%, var(--border-color)); }
    .ep-hoja-h { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); }
    .ep-hoja-h b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ep-hoja-h .pi-file-pdf { color: var(--text-faint); }
    .ep-hoja-s { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4; }
    .ep-hoja-s.is-bad { color: var(--bad-fg); }
    .ep-hoja-s.is-ok { color: var(--ok-fg); }
    .ep-hoja-s em { font-style: normal; color: var(--text-faint); }

    .ep-kv { margin: 0; display: grid; gap: var(--sp-1); font-size: var(--fs-xs); }
    .ep-kv > div { display: flex; align-items: baseline; gap: var(--sp-2); }
    .ep-kv dt { flex: 0 0 8.5rem; color: var(--text-faint); }
    .ep-kv dd { margin: 0; color: var(--text-main); font-weight: 600; }
    .mono { font-family: var(--font-mono, inherit); font-variant-numeric: tabular-nums; }

    .ep-cuadre { margin: 0; font-size: var(--fs-xs); line-height: 1.4; }
    .ep-cuadre.ok { color: var(--ok-fg); }
    .ep-cuadre.bad { color: var(--warn-fg); }

    .ep-link {
      justify-self: start; font: inherit; font-size: var(--fs-micro); color: var(--text-faint);
      background: none; border: 0; padding: 0; cursor: pointer; border-bottom: 1px solid currentColor;
    }
    .ep-link:hover { color: var(--action); }

    .ep-find { display: flex; gap: var(--sp-2); }
    .ep-find-in { flex: 1 1 auto; min-width: 0; }
    .ep-cand {
      display: flex; align-items: baseline; gap: var(--sp-2); width: 100%; text-align: left;
      font: inherit; font-size: var(--fs-xs); cursor: pointer;
      padding: var(--sp-1) var(--sp-2); background: none;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem);
    }
    .ep-cand:hover { border-color: var(--action); }
    .ep-cand > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }

    .ep-x { background: none; border: 0; color: var(--text-faint); cursor: pointer; padding: .2rem; }
    .ep-x:hover { color: var(--bad-fg); }

    .ep-pick {
      display: inline-flex; align-items: center; gap: var(--sp-1); cursor: pointer;
      padding: .35rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem);
      font-size: var(--fs-sm); color: var(--text-muted);
    }
    .ep-pick:hover { border-color: var(--action); color: var(--action); }
    .ep-pick:focus-within { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }

    .ep-lote-hint { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-lote-hint b { color: var(--text-main); }

    :host ::ng-deep .ep-tag { margin-left: var(--sp-2); }
  `],
})
export class ComprasEntradasPendientesComponent {
  private readonly svc = inject(EntradasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly report = signal<EntradasReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoAt = signal<number | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);

  /** Sin `undefined`: `''` ya significa "todas" y el segmented necesita un string siempre. */
  readonly estado = signal<Exclude<EntradasQuery['estado'], undefined>>('pendiente');
  readonly sucursalSel = signal<string | null>(null);
  readonly rezago = signal(false);
  readonly diasMin = signal<number | undefined>(undefined);
  readonly page = signal(1);
  search = '';
  private readonly pageSize = 50;

  /**
   * Vocabulario único de la fase. Antes cada pantalla nombraba distinto lo mismo
   * ("Pendientes/Enviadas/Devueltas" acá, "Con remisión" allá): cuatro personas hablando del
   * mismo expediente con cuatro palabras es una discusión garantizada.
   */
  readonly estadoOpts = [
    { label: 'Sin factura', value: 'pendiente' },
    { label: 'Devueltas', value: 'rechazado' },
    { label: 'Por revisar', value: 'por_validar' },
    { label: 'Validadas', value: 'validado' },
    { label: 'Todas', value: '' },
  ];

  readonly canManage = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);

  // ── alcance: decide si hay selector, chip fijo, o bloqueo explicado ──
  private readonly alcance = computed(() => this.report()?.alcance?.sucursales ?? null);
  readonly sinAlcance = computed(() => { const a = this.alcance(); return !!a && a.length === 0; });
  readonly variasSucursales = computed(() => { const a = this.alcance(); return a === null || a.length > 1; });
  readonly unaSucursal = computed(() => { const a = this.alcance(); return a && a.length === 1 ? this.suc(a[0]) : null; });
  /**
   * Con alcance `all` las opciones salen del CATÁLOGO, no de las filas de la página: con
   * pageSize 50 sobre 1,096 entradas, derivarlas de `rows()` ofrecía sólo las sucursales que
   * cayeron en la primera página — el resto era invisible aunque el usuario pudiera verlas.
   */
  readonly sucursalOpts = computed(() => {
    const a = this.alcance();
    const codes = a ?? STORE_BRANCHES.map((b) => b.code);
    return codes.map((c) => ({ label: this.suc(c), value: c }));
  });

  suc(code: string): string { return branchName(code) || code; }
  clave(c: EntradaRow): string { return `${c.sucursal}/${c.folio}`; }
  /** Por qué la devolvieron, en llano: el código del catálogo y, si no hay, el texto libre. */
  porQue(c: EntradaRow): string {
    return motivoLabel(c.motivo_codigo) || (c.motivo_rechazo || '').trim() || 'sin motivo registrado';
  }
  money = money;
  ultimos4(folio: string): string { const d = String(folio || '').replace(/\D/g, ''); return d.slice(-4) || folio; }
  tope(): number { return this.report()?.settings?.bulk_max_files ?? 50; }

  faltan(r: EntradasReport): number { return Math.max(0, r.kpis.entradas - r.kpis.con_comprobante); }
  avance(r: EntradasReport): number {
    return r.kpis.entradas === 0 ? 100 : Math.round((r.kpis.con_comprobante / r.kpis.entradas) * 100);
  }
  desde(): number { const r = this.report(); return !r || r.total === 0 ? 0 : (this.page() - 1) * this.pageSize + 1; }
  hasta(): number { const r = this.report(); return !r ? 0 : Math.min(r.total, this.page() * this.pageSize); }

  /** Tres niveles sobre el SLA del tenant: al día · pasado · muy pasado (2×). */
  tono(c: EntradaRow): 'ok' | 'warn' | 'bad' {
    const sla = this.report()?.settings?.sla_capture_days ?? 3;
    if (c.dias > sla * 2) return 'bad';
    if (c.dias > sla) return 'warn';
    return 'ok';
  }

  // ── carga (un solo pipeline: el último pedido gana, no hay carreras) ──
  private readonly pedir = new Subject<void>();

  constructor() {
    this.pedir.pipe(
      switchMap(() => {
        this.loading.set(true);
        this.error.set(null);
        const q: EntradasQuery = {
          estado: this.estado(),
          search: this.search || undefined,
          warehouse_codes: this.sucursalSel() ? [this.sucursalSel() as string] : undefined,
          carril: this.rezago() ? 'rezago' : 'al_dia',
          dias_min: this.diasMin(),
          orden: 'antiguedad',
          page: this.page(),
          pageSize: this.pageSize,
        };
        return this.svc.list(q).pipe(catchError((e) => {
          this.error.set(e?.error?.message || 'No se pudo cargar la lista de pendientes.');
          this.loading.set(false);
          return of(null);
        }));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      if (r) { this.report.set(r); this.cargadoAt.set(Date.now()); }
      this.loading.set(false);
    });
    // Estado en la URL: el link "las pendientes de la 03" se puede pegar en un chat, y el
    // deep-link desde el Centro de control aterriza donde dice.
    const qp = this.route.snapshot.queryParamMap;
    const suc = qp.get('suc');
    if (suc) this.sucursalSel.set(suc);
    const est = qp.get('estado');
    if (est && this.estadoOpts.some((o) => o.value === est)) {
      this.estado.set(est as Exclude<EntradasQuery['estado'], undefined>);
    }
    this.reload();
  }

  reload(): void { this.pedir.next(); }
  private volverAlInicio(): void { this.page.set(1); this.diasMin.set(undefined); }
  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        suc: this.sucursalSel() || null,
        estado: this.estado() === 'pendiente' ? null : this.estado() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  setEstado(v: string): void {
    this.estado.set((v || '') as Exclude<EntradasQuery['estado'], undefined>);
    this.volverAlInicio(); this.syncUrl(); this.reload();
  }
  setSucursal(v: string | null): void { this.sucursalSel.set(v || null); this.volverAlInicio(); this.syncUrl(); this.reload(); }
  setRezago(v: boolean): void { this.rezago.set(v); this.volverAlInicio(); this.reload(); }
  soloAtrasadas(): void {
    const sla = this.report()?.settings?.sla_capture_days ?? 3;
    this.estado.set('pendiente'); this.diasMin.set(sla + 1); this.page.set(1); this.reload();
  }
  irPagina(n: number): void { this.page.set(Math.max(1, n)); this.reload(); }

  // ═════════════════════════ bandeja de PDFs ═════════════════════════
  readonly hojas = signal<Hoja[]>([]);
  readonly guardando = signal(false);
  readonly capError = signal('');
  /** La fila abierta en el panel (la última sobre la que se soltó algo). */
  readonly abierta = signal<EntradaRow | null>(null);
  readonly dragTabla = signal(false);
  readonly dragFila = signal<string | null>(null);
  private seq = 0;
  /** De 3 en 3: cada hoja es una llamada de visión y un lote son 30. */
  private static readonly EN_VUELO = 3;

  /** Cuántos EXPEDIENTES se van a crear — no cuántos archivos. Dos hojas de una factura son uno. */
  readonly listas = computed(() => this.hojas().filter((h) => h.estado === 'enlazada' && h.entrada && !h.dupDe));
  readonly nExpedientes = computed(() =>
    new Set(this.listas().map((h) => `${h.entrada!.sucursal}|${h.entrada!.folio}`)).size);
  readonly nBloqueadas = computed(() =>
    this.hojas().filter((h) => h.estado === 'ambigua' || h.estado === 'sin_match' || h.estado === 'duplicada' || h.estado === 'error').length);

  // ── arrastre ──
  onDragOverTabla(e: DragEvent): void {
    if (!this.canManage()) return;
    e.preventDefault();
    this.dragTabla.set(true);
  }
  onDragLeaveTabla(e: DragEvent): void {
    // `relatedTarget` fuera del contenedor: sin esto, pasar sobre una fila apaga el resaltado
    // del contenedor y el velo titila.
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    this.dragTabla.set(false);
    this.dragFila.set(null);
  }
  onDropTabla(e: DragEvent): void {
    e.preventDefault();
    const fila = this.dragFila();
    this.dragTabla.set(false);
    this.dragFila.set(null);
    // Si cayó sobre una fila, ya lo manejó `onDropFila` (el evento burbujea).
    if (fila) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) void this.agregar(files, null);
  }
  onDragOverFila(e: DragEvent, c: EntradaRow): void {
    if (!this.canManage()) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragFila.set(this.clave(c));
    this.dragTabla.set(true);
  }
  onDragLeaveFila(e: DragEvent): void {
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    this.dragFila.set(null);
  }
  onDropFila(e: DragEvent, c: EntradaRow): void {
    e.preventDefault();
    e.stopPropagation();
    this.dragFila.set(null);
    this.dragTabla.set(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) void this.agregar(files, c);
  }
  onFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) void this.agregar(files, null);
  }
  onFilesFila(ev: Event, c: EntradaRow): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) void this.agregar(files, c);
  }

  /**
   * `destino` = la entrada sobre la que se soltó. Si viene, no hace falta adivinar nada: el
   * usuario ya dijo de qué orden es y el enlace por folio sólo podría contradecirlo.
   */
  private async agregar(files: File[], destino: EntradaRow | null): Promise<void> {
    if (!this.canManage()) return;
    this.capError.set('');
    if (destino) this.abierta.set(destino);

    const espacio = this.tope() - this.hojas().length;
    if (espacio <= 0) {
      this.toast.add({
        severity: 'warn',
        summary: `La bandeja llegó al tope de ${this.tope()}`,
        detail: 'Enviá lo que hay y seguí con el resto.',
      });
      return;
    }
    const lote = files.slice(0, espacio);
    if (lote.length < files.length) {
      this.toast.add({
        severity: 'warn',
        summary: `Se tomaron ${lote.length} de ${files.length}`,
        detail: `El tope es ${this.tope()} archivos por vez (se cambia en el Centro de control).`,
      });
    }

    const nuevas: Hoja[] = [];
    for (const f of lote) {
      // Sólo PDF. El `accept` del input es una sugerencia (se puede elegir "todos los archivos")
      // y el arrastre no lo respeta en absoluto, así que el filtro real va acá y en el server.
      // El mensaje dice la SALIDA, no sólo el "no".
      const esPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      if (!esPdf) {
        this.capError.set(`${f.name} no es PDF. Escaneá la factura a PDF y volvé a soltarla.`);
        continue;
      }
      let dataUri: string;
      try { dataUri = await this.leer(f); } catch { this.capError.set(`No se pudo leer ${f.name}.`); continue; }
      nuevas.push({
        id: ++this.seq,
        name: f.name || 'factura.pdf',
        dataUri,
        bytes: Math.round((dataUri.length - (dataUri.indexOf(',') + 1)) * 0.75),
        estado: 'leyendo',
        entrada: destino,
        busqueda: '',
      });
    }
    if (!nuevas.length) return;
    this.hojas.update((l) => [...l, ...nuevas]);
    await this.procesar(nuevas);
  }

  /**
   * Lee y enlaza con concurrencia acotada. El pool es a mano y no con `forkJoin` porque 30
   * llamadas de visión en paralelo es exactamente cómo se choca con el rate-limit del proveedor.
   */
  private async procesar(lote: Hoja[]): Promise<void> {
    const cola = [...lote];
    const obreros = Array.from(
      { length: Math.min(ComprasEntradasPendientesComponent.EN_VUELO, cola.length) },
      async () => { for (;;) { const h = cola.shift(); if (!h) return; await this.leerYEnlazar(h); } },
    );
    await Promise.all(obreros);
  }

  private async leerYEnlazar(h: Hoja): Promise<void> {
    try {
      const o = await firstValueFrom(this.svc.ocr(h.dataUri, 'factura'));
      this.parchar(h.id, {
        sha256: o.sha256, folioOcr: o.folio, total: o.total, subtotal: o.subtotal,
        fecha: o.fecha, rfc: o.rfc, ocr: o,
      });
      if (o.duplicate) {
        this.parchar(h.id, { estado: 'duplicada', dupDe: `${o.duplicate.sucursal}/${o.duplicate.folio}` });
        return;
      }
      // Soltada sobre una fila: la entrada ya la eligió el usuario, no se busca nada.
      if (h.entrada) { this.parchar(h.id, { estado: 'enlazada' }); return; }
      // FOLIO primero (preciso), MONTO como respaldo — la misma prioridad del server.
      const r = await firstValueFrom(this.svc.matchByOcr({
        folio: o.folio || undefined,
        total: o.total ?? o.subtotal ?? undefined,
        fecha: o.fecha || undefined,
      }));
      const cands = r?.entradas || [];
      if (cands.length === 1) {
        this.parchar(h.id, { estado: 'enlazada', entrada: cands[0], porMonto: !o.folio, candidatas: [] });
      } else if (cands.length > 1) {
        this.parchar(h.id, { estado: 'ambigua', candidatas: cands.slice(0, 5) });
      } else {
        this.parchar(h.id, { estado: 'sin_match', candidatas: [] });
      }
    } catch (e: any) {
      this.parchar(h.id, { estado: 'error', motivo: e?.error?.message || 'No se pudo leer el PDF' });
    }
  }

  private parchar(id: number, p: Partial<Hoja>): void {
    this.hojas.update((l) => l.map((h) => (h.id === id ? { ...h, ...p } : h)));
  }

  elegir(h: Hoja, e: EntradaRow): void {
    this.parchar(h.id, { entrada: e, estado: 'enlazada', candidatas: [], porMonto: !h.folioOcr });
  }
  desenlazar(h: Hoja): void {
    this.parchar(h.id, { entrada: null, estado: 'sin_match', candidatas: [], porMonto: false });
  }
  quitar(h: Hoja): void { this.hojas.update((l) => l.filter((x) => x.id !== h.id)); }
  limpiar(): void { this.hojas.set([]); this.capError.set(''); this.abierta.set(null); }
  setBusqueda(h: Hoja, v: string): void { this.parchar(h.id, { busqueda: v }); }

  buscar(h: Hoja): void {
    const q = (h.busqueda || '').trim();
    if (!q) return;
    this.parchar(h.id, { buscando: true });
    this.svc.matchByOcr({ search: q }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const cands = r?.entradas || [];
        this.parchar(h.id, { buscando: false, candidatas: cands.slice(0, 8), estado: cands.length ? 'ambigua' : 'sin_match' });
      },
      error: () => this.parchar(h.id, { buscando: false }),
    });
  }

  // ── cuadre (por hoja: en un lote cada una tiene su entrada) ──
  private cfgTol(): number { return this.report()?.settings?.match_tolerance ?? 1; }
  private cerca(v: number | null | undefined, ref: number | null | undefined): boolean {
    return v != null && ref != null && Math.abs(Number(v) - Number(ref)) <= this.cfgTol();
  }
  /**
   * `null` = todavía no se puede opinar. Cuadra contra **las dos capturas** de la misma
   * recepción (sucursal y oficinas), igual que el servidor: si acá se compara sólo contra una,
   * la pantalla dice "no cuadra" sobre una factura que el server guarda como cuadrada y el
   * capturista se queda sin saber a quién creerle.
   */
  cuadre(h: Hoja): boolean | null {
    if (!h.entrada || (h.total == null && h.subtotal == null)) return null;
    return this.cerca(h.total, h.entrada.monto) || this.cerca(h.subtotal, h.entrada.monto)
      || this.cerca(h.total, h.entrada.gemela_monto) || this.cerca(h.subtotal, h.entrada.gemela_monto);
  }
  /** Cuadró con la de oficinas y NO con la de la sucursal: hay que poder decirlo. */
  porGemela(h: Hoja): boolean {
    if (!h.entrada || h.entrada.gemela_monto == null) return false;
    const conSuc = this.cerca(h.total, h.entrada.monto) || this.cerca(h.subtotal, h.entrada.monto);
    return !conSuc && (this.cerca(h.total, h.entrada.gemela_monto) || this.cerca(h.subtotal, h.entrada.gemela_monto));
  }
  dif(h: Hoja): number {
    if (!h.entrada) return 0;
    const cands = [h.total, h.subtotal].filter((v): v is number => v != null);
    if (!cands.length) return 0;
    return Math.min(...cands.map((v) => Math.abs(v - h.entrada!.monto)));
  }

  // ── guardar (UN camino: agrupa por expediente y manda el lote) ──
  /**
   * `attach-bulk` también para un solo expediente. Tener dos caminos de guardado —uno para la
   * captura de una y otro para el lote— fue exactamente cómo el lote terminó creando dos
   * evidencias para la misma entrada cuando la factura traía dos hojas.
   */
  guardar(): void {
    const listas = this.listas();
    if (!listas.length || this.guardando()) return;
    this.capError.set('');
    this.guardando.set(true);

    void (async () => {
      const subidas: { h: Hoja; file: ProofFile }[] = [];
      for (const h of listas) {
        try {
          const up = await firstValueFrom(this.svc.uploadFile(h.dataUri, 'factura'));
          subidas.push({
            h,
            file: {
              ...up, role: 'factura', name: h.name, sha256: h.sha256,
              ocr_folio: h.folioOcr ?? null, ocr_total: h.total ?? null,
              ocr_fecha: h.fecha ?? null, ocr_rfc: h.rfc ?? null,
            },
          });
        } catch (e: any) {
          this.parchar(h.id, { estado: 'error', motivo: e?.error?.message || 'No se pudo subir el archivo' });
        }
      }
      if (!subidas.length) {
        this.guardando.set(false);
        this.capError.set('No se pudo subir ningún archivo. Reintentá.');
        return;
      }

      // AGRUPAR por entrada antes de mandar: una factura de 2 hojas son 2 archivos pero UN
      // expediente. Un item por archivo crea dos evidencias de la misma entrada (el dedup por
      // hash no las cruza, son hojas distintas) y el revisor ve la misma factura dos veces.
      const porEntrada = new Map<string, { h: Hoja; file: ProofFile }[]>();
      for (const s of subidas) {
        const k = `${s.h.entrada!.sucursal}|${s.h.entrada!.folio}`;
        porEntrada.set(k, [...(porEntrada.get(k) || []), s]);
      }
      const items: AttachReceipt[] = [...porEntrada.values()].map((grupo) => ({
        sucursal: grupo[0].h.entrada!.sucursal,
        folio: grupo[0].h.entrada!.folio,
        files: grupo.map((g) => g.file),
        // La lectura que manda para el cuadre es la de la hoja que trae importe.
        ocr: (grupo.find((g) => g.h.total != null || g.h.subtotal != null) || grupo[0]).h.ocr,
      }));

      try {
        const r = await firstValueFrom(this.svc.attachBulk(items));
        // Cada hoja sabe qué le pasó: el server contesta por expediente y todas las hojas de un
        // expediente comparten su resultado.
        for (const { h } of subidas) {
          const d = r.detalle.find((x) => x.sucursal === h.entrada!.sucursal && x.folio === h.entrada!.folio);
          if (d?.ok) this.parchar(h.id, { estado: 'guardada' });
          else this.parchar(h.id, { estado: 'error', motivo: d?.motivo || 'No se pudo adjuntar' });
        }
        this.guardando.set(false);
        this.toast.add({
          severity: r.omitidas ? 'warn' : 'success',
          summary: `${r.guardadas} ${r.guardadas === 1 ? 'factura enviada' : 'facturas enviadas'}`,
          detail: r.omitidas
            ? `${r.omitidas} quedaron afuera — el motivo está en su renglón.`
            : `${r.cuadran} cuadran al peso; el resto lo mira el revisor.`,
        });
        // Las guardadas salen de la bandeja; lo que falló se queda con su motivo a la vista.
        this.hojas.update((l) => l.filter((h) => h.estado !== 'guardada'));
        if (!this.hojas().length) this.abierta.set(null);
        this.reload();
      } catch (e: any) {
        this.guardando.set(false);
        this.capError.set(e?.error?.message || 'No se pudo enviar. Reintentá.');
      }
    })();
  }

  private leer(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }
}
