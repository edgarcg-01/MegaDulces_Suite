import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, of, switchMap, catchError } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import {
  EntradasService, EntradaRow, EntradasReport, EntradasQuery, EntradaDetail, ProofFile,
} from '../entradas.service';
import { ComprasService, AdjustmentForEntradaRow } from '../compras.service';
import { receiptVerdict, lineasTotal, plural, MOTIVOS_RECHAZO, motivoLabel } from '../receipt-verdict';
import { branchName, STORE_BRANCHES } from '../../../core/constants/store-branches';
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
    TableModule, TagModule, ToastModule, RouterLink, SegmentedComponent, LoadStateComponent, EntityInspectorComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in rv">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Bandeja de revisión</h1>
          <p class="surf-page-sub">
            Facturas que esperan tu decisión, la de mayor riesgo primero. Aprobá o devolvé con
            motivo; la siguiente se abre sola. <kbd>A</kbd> aprobar · <kbd>R</kbd> devolver ·
            <kbd>J</kbd>/<kbd>K</kbd> moverse.
          </p>
        </div>
        <div class="rv-head-actions">
          @if (report(); as r) {
            <span class="rv-count" [class.late]="r.kpis.por_validar_atrasadas > 0">
              <strong>{{ r.kpis.por_validar }}</strong> por validar
              @if (r.kpis.por_validar_atrasadas > 0) {
                <em [title]="'Más de ' + r.settings.sla_review_days + ' días esperando'">· {{ r.kpis.por_validar_atrasadas }} vencidas</em>
              }
              <!-- Sin topes silenciosos: la cola trae 200 por pasada; si hay más, se dice. -->
              @if (cortada(r)) {
                <em class="rv-cut" [title]="'La cola trae ' + cola().length + ' por pasada; al cerrar estas aparecen las que siguen'">
                  · mostrando {{ cola().length }}
                </em>
              }
            </span>
            @if (decididasHoy() > 0) { <span class="rv-done">{{ decididasHoy() }} decididas</span> }
          }
          @if (canValidate() && limpias().length > 1) {
            <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="bulking()" (click)="abrirLote()"
                    [title]="'Aprobar las ' + limpias().length + ' que cuadran al peso'">
              <span class="p-button-icon p-button-icon-left pi pi-check-square" aria-hidden="true"></span>
              <span class="p-button-label">Aprobar {{ limpias().length }} que cuadran</span>
            </button>
          }
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="reload()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <div class="rv-filters">
        <app-segmented [options]="ordenOpts" [value]="orden()" (valueChange)="setOrden($event)" ariaLabel="Orden de la cola" />
        @if (variasSucursales()) {
          <p-select [options]="sucursalOpts()" [ngModel]="sucursalSel()" (onChange)="setSucursal($event.value)"
                    optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                    styleClass="rv-sel" ariaLabel="Sucursal" appendTo="body" />
        }
        <input pInputText [(ngModel)]="search" (keyup.enter)="reload()" (blur)="reload()"
               placeholder="Proveedor, folio o últimos 4…" class="rv-search" aria-label="Buscar en la cola" />
        <label class="rv-check">
          <input type="checkbox" [checked]="soloDescuadre()" (change)="setSoloDescuadre($any($event.target).checked)" />
          Sólo las que no cuadran
        </label>
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
        <!-- Master-detail permanente (DESIGN §O.1): la cola a la izquierda no desaparece al
             abrir un expediente, así el revisor no pierde el lugar en la fila. -->
        <div class="rv-split">
          <ul class="rv-queue" [class.loading]="loading()" role="listbox" aria-label="Cola de revisión">
            @for (c of cola(); track c.sucursal + '/' + c.folio; let i = $index) {
              <li>
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

          <section class="rv-file" aria-label="Expediente">
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
                <dl class="rv-tri">
                  <div><dt>Kepler</dt><dd>{{ money(q.kepler) }}</dd><p>total registrado, con impuestos</p></div>
                  <div><dt>Σ renglones</dt><dd>{{ money(q.lineas) }}</dd><p>{{ q.lineasMeta }}</p></div>
                  <div [class.off]="q.tone === 'bad'"><dt>Documento (OCR)</dt><dd>{{ q.ocr != null ? money(q.ocr) : '—' }}</dd><p>{{ q.ocrMeta }}</p></div>
                  <!-- RE.14.4 — la cuarta cifra sólo aparece cuando existe y aporta: la misma
                       recepción capturada en oficinas con OTRO importe. Es lo que explica un
                       descuadre de centavos sin tener que dudar de la factura. -->
                  @if (q.gemela?.monto != null && q.gemela?.delta) {
                    <div><dt>Oficinas</dt><dd>{{ money(q.gemela!.monto!) }}</dd>
                      <p>misma recepción, folio {{ q.gemela!.folio }} · {{ money(q.gemela!.delta!) }} vs la de la sucursal</p></div>
                  }
                </dl>
              }

              <div class="rv-decide">
                @if (canValidate()) {
                  @if (bloqueoPropio(); as quien) {
                    <p class="rv-block">
                      <i class="pi pi-user-minus" aria-hidden="true"></i>
                      Esta evidencia la subió <strong>{{ quien }}</strong> — que sos vos. Tiene que revisarla otra persona.
                    </p>
                  } @else {
                    <button pButton type="button" severity="success" [loading]="acting()" (click)="aprobar()">
                      <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                      <span class="p-button-label">Aprobar</span>
                    </button>
                    <button pButton type="button" severity="danger" class="p-button-outlined" [disabled]="acting()" (click)="abrirRechazo()">
                      <span class="p-button-icon p-button-icon-left pi pi-undo" aria-hidden="true"></span>
                      <span class="p-button-label">Devolver</span>
                    </button>
                  }
                } @else {
                  <p class="rv-block"><i class="pi pi-lock" aria-hidden="true"></i> No tenés permiso para validar evidencia.</p>
                }
                <span class="rv-pos">{{ idx() + 1 }} de {{ cola().length }}</span>
                <button pButton type="button" class="p-button-sm p-button-text" [disabled]="idx() >= cola().length - 1" (click)="ir(idx() + 1)">
                  <span class="p-button-label">Saltar</span><span class="p-button-icon pi pi-angle-right" aria-hidden="true"></span>
                </button>
              </div>

              <div class="rv-body">
                <div class="rv-main">
                  <dl class="rv-head">
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
                    <div><dt>Fecha</dt><dd>{{ d.entrada.receipt_date | date:'dd/MM/yy' }}</dd></div>
                    <div><dt>OC / Vale</dt><dd class="mono">{{ d.entrada.oc_folio || '—' }} / {{ d.entrada.vale_folio || '—' }}</dd></div>
                  </dl>

                  @if (d.deposits?.length) {
                    <div class="rv-hojas">
                      <span class="rv-lbl">Hojas adjuntas</span>
                      @for (dep of d.deposits; track dep.id) {
                        @for (f of dep.files; track f.url) {
                          <button type="button" class="rv-hoja" [class.on]="doc()?.url === f.url" (click)="verDoc(f)">
                            <i class="pi" [ngClass]="esImagen(f) ? 'pi-image' : 'pi-file-pdf'" aria-hidden="true"></i>
                            {{ f.name || (esImagen(f) ? 'foto' : 'PDF') }}
                          </button>
                        }
                      }
                      <span class="rv-subio">
                        subió {{ d.deposits[0].created_by || '—' }} · {{ d.deposits[0].created_at | date:'dd/MM HH:mm' }}
                      </span>
                    </div>
                  }

                  <p-table [value]="d.lineas" styleClass="p-datatable-sm rv-table" [scrollable]="true" scrollHeight="24vh"
                           [paginator]="d.lineas.length > 100" [rows]="100">
                    <ng-template #header>
                      <tr>
                        <th style="width:5.5rem">SKU</th><th>Producto</th>
                        <th class="ta-r" style="width:5rem">Cant.</th>
                        <th class="ta-r" style="width:7rem">Costo u.</th>
                        <th class="ta-r" style="width:8rem">Importe</th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-l>
                      <tr>
                        <td class="mono">{{ l.sku || '—' }}</td>
                        <td>{{ l.nombre || '—' }}</td>
                        <td class="ta-r">{{ l.cantidad | number:'1.0-2' }}<em class="rv-u">{{ l.unidad || '' }}</em></td>
                        <td class="ta-r">{{ money(l.costo_unitario) }}</td>
                        <td class="ta-r strong">{{ money(l.importe) }}</td>
                      </tr>
                    </ng-template>
                    <ng-template #emptymessage><tr><td colspan="5" class="rv-none">Sin renglones de detalle.</td></tr></ng-template>
                  </p-table>
                  <p class="rv-sum">{{ plural(d.lineas.length, 'renglón', 'renglones') }} · Σ {{ money(lineasTotal(d.lineas)) }}</p>

                  <!-- Lo que EXPLICA el descuadre. Sin esto el revisor devuelve facturas que
                       estaban bien: 3 de cada 4 ajustes de proveedor son descuentos ganados. -->
                  <div class="rv-explica">
                    <span class="rv-lbl"><i class="pi pi-search-plus" aria-hidden="true"></i> ¿Por qué no cuadra? — ajustes del proveedor</span>
                    @if (explicaLoading()) {
                      <p class="rv-none"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando devoluciones y notas…</p>
                    } @else if (!explica().length) {
                      <p class="rv-none">Sin devoluciones ni notas de crédito de este proveedor ±15 días. Si difiere, suele ser IVA o captura.</p>
                    } @else {
                      <ul class="rv-adj">
                        @for (a of explica(); track a.doctype + a.folio) {
                          <li>
                            <p-tag [value]="a.doctype === 'XD40' ? 'Devolución' : 'Nota de crédito'" [severity]="a.doctype === 'XD40' ? 'warn' : 'info'" />
                            <span class="mono">{{ a.folio }}</span>
                            <em>{{ a.adjustment_date | date:'dd/MM' }}</em>
                            <span class="rv-adj-mot" [title]="a.motivo || ''">{{ a.motivo || '—' }}</span>
                            <span class="rv-adj-monto">{{ money(a.monto) }}</span>
                          </li>
                        }
                      </ul>
                    }
                  </div>

                  @if (d.history?.length) {
                    <div class="rv-hist">
                      <span class="rv-lbl">Historial</span>
                      <ol>
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
                    </div>
                  }
                </div>

                <!-- El documento al lado de las cifras: es la comparación que hace el trabajo. -->
                <aside class="rv-doc">
                  @if (doc(); as v) {
                    <div class="rv-doc-head">
                      <span [title]="v.name"><i class="pi" [ngClass]="v.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'" aria-hidden="true"></i> {{ v.name }}</span>
                      <a pButton type="button" text size="small" [href]="v.url" target="_blank" rel="noopener" title="Abrir en pestaña">
                        <span class="p-button-icon pi pi-external-link" aria-hidden="true"></span>
                      </a>
                    </div>
                    <div class="rv-doc-frame">
                      @if (v.kind === 'pdf') { <iframe [src]="v.safe" title="Documento de la entrada"></iframe> }
                      @else { <img [src]="v.url" [alt]="v.name" /> }
                    </div>
                  } @else {
                    <div class="rv-doc-empty"><i class="pi pi-file" aria-hidden="true"></i><span>Elegí una hoja para verla acá.</span></div>
                  }
                </aside>
              </div>
            } @else {
              <div class="rv-doc-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Elegí una de la cola.</span></div>
            }
          </section>
        </div>
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
        <div class="rv-rej-opts">
          @for (m of motivos; track m.code) {
            <label class="rv-rej-opt" [class.on]="motivoCodigo() === m.code">
              <input type="radio" name="motivo" [value]="m.code" [checked]="motivoCodigo() === m.code" (change)="motivoCodigo.set(m.code)" />
              {{ m.label }}
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
              [style]="{ width: '32rem', maxWidth: '96vw' }" header="Aprobar las que cuadran al peso">
      <div class="rv-lote">
        <p>
          Se van a aprobar <strong>{{ limpias().length }}</strong> facturas cuyo total coincide con
          Kepler dentro de la tolerancia de
          <strong>{{ money(report()?.settings?.match_tolerance ?? 1) }}</strong> y que no subiste vos.
          Las que no cuadran quedan en la cola para revisarlas a mano.
        </p>
        <ul>
          @for (c of limpias(); track c.deposit_id) {
            <li><span class="mono">{{ suc(c.sucursal) }} · {{ c.folio }}</span> <em>{{ c.proveedor_nombre }}</em> <b>{{ money(c.monto) }}</b></li>
          }
        </ul>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="showLote.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="success" [loading]="bulking()" (click)="aprobarLote()">
          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
          <span class="p-button-label">Aprobar {{ limpias().length }}</span>
        </button>
      </ng-template>
    </p-dialog>

    <app-entity-inspector [(ref)]="inspect" />
  `,
  styles: [`
    :host { display: block; }
    kbd { font: inherit; font-size: .85em; font-family: var(--font-mono); border: 1px solid var(--border-color);
      border-radius: 3px; padding: 0 .25em; color: var(--text-muted); }
    .rv-head-actions { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .rv-count { font-size: var(--fs-sm, .85rem); color: var(--text-muted); }
    .rv-count strong { color: var(--text-main); font-size: 1.05rem; }
    .rv-count.late em { font-style: normal; color: var(--bad-fg); }
    .rv-done { font-size: var(--fs-xs, .75rem); color: var(--ok-fg); }
    .rv-cut { font-style: normal; color: var(--text-muted); font-size: var(--fs-xs, .75rem); }

    .rv-filters { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .rv-search { flex: 1 1 14rem; min-width: 10rem; }
    .rv-check { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm, .85rem); color: var(--text-muted); cursor: pointer; }

    .rv-split { display: grid; gap: .8rem; grid-template-columns: minmax(15rem, 22rem) 1fr; align-items: start; }
    @media (max-width: 60rem) { .rv-split { grid-template-columns: 1fr; } }

    .rv-queue { list-style: none; margin: 0; padding: 0; max-height: 74vh; overflow: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); }
    .rv-queue.loading { opacity: .6; }
    .rv-q { display: grid; gap: .15rem; width: 100%; text-align: left; background: transparent; border: 0;
      border-left: 3px solid transparent; padding: .5rem .7rem; cursor: pointer; font: inherit; }
    .rv-queue li + li .rv-q { border-top: 1px solid var(--border-color); }
    .rv-q:hover { background: var(--surface-hover, var(--surface-sunken)); }
    .rv-q.on { background: var(--surface-sunken); border-left-color: var(--action); }
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

    .rv-file { min-width: 0; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .8rem; }
    .rv-verdict { display: flex; gap: .7rem; align-items: flex-start; padding: .7rem .85rem; border-radius: var(--r-sm, .35rem);
      border: 1px solid var(--border-color); margin-bottom: .7rem; }
    .rv-verdict .pi { font-size: 1.15rem; margin-top: .1rem; }
    .rv-verdict.is-ok { color: var(--ok-fg); border-color: color-mix(in oklab, var(--ok-fg) 35%, var(--border-color)); }
    .rv-verdict.is-warn { color: var(--warn-fg, var(--bad-fg)); border-color: color-mix(in oklab, var(--warn-fg, var(--bad-fg)) 35%, var(--border-color)); }
    .rv-verdict.is-bad { color: var(--bad-fg); border-color: color-mix(in oklab, var(--bad-fg) 35%, var(--border-color)); }
    .rv-verdict.is-muted { color: var(--text-muted); }
    .rv-v-t { margin: 0; font-weight: 600; }
    .rv-v-s { margin: .15rem 0 0; font-size: var(--fs-sm, .85rem); color: var(--text-main); }
    .rv-verdict.is-muted .rv-v-s { color: var(--text-muted); }

    .rv-tri { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .6rem; margin: 0 0 .8rem; }
    .rv-tri > div { padding: .5rem .7rem; background: var(--surface-sunken, var(--card-bg));
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); }
    .rv-tri dt { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .rv-tri dd { margin: .1rem 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 1.05rem; font-weight: 600; }
    .rv-tri p { margin: 0; font-size: var(--fs-micro, .72rem); color: var(--text-muted); }
    .rv-tri > div.off dd { color: var(--bad-fg); }

    .rv-decide { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .6rem .7rem; margin-bottom: .8rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); background: var(--surface-sunken, var(--card-bg)); }
    .rv-pos { margin-left: auto; font-size: var(--fs-xs, .75rem); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .rv-block { margin: 0; display: flex; align-items: center; gap: .4rem; font-size: var(--fs-sm, .85rem); color: var(--warn-fg, var(--bad-fg)); }

    .rv-body { display: grid; grid-template-columns: 1fr minmax(14rem, 24rem); gap: .8rem; align-items: start; }
    @media (max-width: 72rem) { .rv-body { grid-template-columns: 1fr; } }
    .rv-main { min-width: 0; display: grid; gap: .7rem; }
    .rv-head { display: flex; gap: 1.1rem; flex-wrap: wrap; margin: 0; }
    .rv-head > div { display: flex; flex-direction: column; gap: .1rem; }
    .rv-head dt { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .rv-head dd { margin: 0; font-weight: 600; }
    .rv-ref { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; font: inherit; font-weight: 600; }
    .rv-ref:hover { color: var(--action); text-decoration: underline; }
    .rv-ref:focus-visible { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }
    .mono { font-family: var(--font-mono); font-size: .9em; }
    .rv-lbl { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .rv-hojas { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
    .rv-hoja { display: inline-flex; align-items: center; gap: .3rem; padding: .2rem .5rem; cursor: pointer; font: inherit;
      font-size: var(--fs-xs, .75rem); background: transparent; border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); }
    .rv-hoja.on { border-color: var(--action); color: var(--action); }
    .rv-subio { font-size: var(--fs-micro, .72rem); color: var(--text-muted); margin-left: auto; }
    .rv-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rv-table td.ta-r { font-family: var(--font-mono); }
    .rv-table .strong { font-weight: 600; }
    .rv-u { font-style: normal; color: var(--text-muted); font-size: .8em; margin-left: .2rem; }
    .rv-sum { margin: 0; font-size: var(--fs-xs, .75rem); color: var(--text-muted); text-align: right; }
    .rv-none { color: var(--text-muted); font-size: var(--fs-sm, .85rem); margin: .2rem 0; }

    .rv-explica, .rv-hist { border-top: 1px solid var(--border-color); padding-top: .6rem; }
    .rv-adj { list-style: none; margin: .3rem 0 0; padding: 0; display: grid; gap: .25rem; }
    .rv-adj li { display: flex; align-items: center; gap: .45rem; font-size: var(--fs-sm, .85rem); flex-wrap: wrap; }
    .rv-adj em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); }
    .rv-adj-mot { flex: 1; min-width: 6rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .rv-adj-monto { font-family: var(--font-mono); font-weight: 600; }
    .rv-hist ol { list-style: none; margin: .3rem 0 0; padding: 0; display: grid; gap: .2rem; }
    .rv-hist li { display: flex; gap: .45rem; align-items: baseline; font-size: var(--fs-sm, .85rem); flex-wrap: wrap; }
    .rv-hist em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); }
    .rv-hist-mot { color: var(--text-muted); }

    .rv-doc { position: sticky; top: .5rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); overflow: hidden; }
    .rv-doc-head { display: flex; align-items: center; justify-content: space-between; gap: .4rem; padding: .35rem .5rem;
      border-bottom: 1px solid var(--border-color); font-size: var(--fs-xs, .75rem); }
    .rv-doc-head > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rv-doc-frame { height: 52vh; background: var(--surface-sunken); }
    .rv-doc-frame iframe, .rv-doc-frame img { width: 100%; height: 100%; border: 0; object-fit: contain; display: block; }
    .rv-doc-empty { display: grid; place-items: center; gap: .4rem; padding: 2.5rem 1rem; color: var(--text-muted); text-align: center; }
    .rv-doc-empty .pi { font-size: 1.4rem; }

    .rv-empty { display: grid; place-items: center; gap: .5rem; padding: 4rem 1rem; color: var(--text-muted); }
    .rv-empty .pi { font-size: 1.8rem; color: var(--ok-fg); }
    .rv-empty p { margin: 0; }
    .rv-empty-link { color: var(--action); font-size: var(--fs-sm, .85rem); }
    .rv-skel { display: grid; gap: .4rem; }
    .rv-sk { border-radius: var(--r-sm, .35rem);
      background: linear-gradient(90deg, var(--border-color) 25%, var(--surface-sunken) 50%, var(--border-color) 75%);
      background-size: 200% 100%; animation: rv-sh 1.2s infinite; }
    .rv-sk-v { height: 3.4rem; } .rv-sk-t { height: 4rem; } .rv-sk-r { height: 1.6rem; }
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
    .rv-lote li b { font-family: var(--font-mono); }
  `],
})
export class ComprasEntradasRevisionComponent {
  private readonly svc = inject(EntradasService);
  private readonly compras = inject(ComprasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly sanitizer = inject(DomSanitizer);
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
  lineasTotal = lineasTotal;
  suc(code: string): string { return branchName(code) || code; }

  readonly canValidate = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_VALIDAR] === true);

  private readonly alcance = computed(() => this.report()?.alcance?.sucursales ?? null);
  readonly variasSucursales = computed(() => { const a = this.alcance(); return a === null || a.length > 1; });
  /** Con alcance `all`, del catálogo — no de la cola, que puede no traer todas las sucursales. */
  readonly sucursalOpts = computed(() => {
    const a = this.alcance() ?? STORE_BRANCHES.map((b) => b.code);
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
  readonly inspect = signal<string | null>(null);
  readonly doc = signal<{ url: string; safe: SafeResourceUrl | null; kind: 'image' | 'pdf'; name: string } | null>(null);

  refProv(code: string): string { return entityRef('prov', code); }
  refEnt(sucursal: string, folio: string): string { return entityRef('ent', sucursal, 'XA2001', folio); }

  verdict(d: EntradaDetail) { return receiptVerdict(d, this.explica().length > 0); }
  etiquetaEstado(s: string): string {
    return s === 'recibido' ? 'Subida' : s === 'validado' ? 'Aprobada' : s === 'rechazado' ? 'Devuelta' : s;
  }

  esImagen(f: ProofFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }
  verDoc(f: ProofFile): void {
    const img = this.esImagen(f);
    this.doc.set({
      url: f.url,
      safe: img ? null : this.sanitizer.bypassSecurityTrustResourceUrl(f.url), // iframe exige SafeResourceUrl
      kind: img ? 'image' : 'pdf',
      name: f.name || (img ? 'foto' : 'PDF'),
    });
  }

  private cargarExpediente(): void {
    const c = this.actual();
    this.detail.set(null); this.doc.set(null); this.explica.set([]);
    if (!c) return;
    this.detailLoading.set(true);
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.detailLoading.set(false);
        this.detail.set(d);
        // La primera hoja se muestra sola: el trabajo es comparar, no hacer clics.
        const f = d.deposits?.[0]?.files?.[0];
        if (f) this.verDoc(f);
      },
      error: (e) => {
        this.detailLoading.set(false);
        this.error.set(e?.error?.message || 'No se pudo abrir el expediente.');
      },
    });
    if (c.proveedor_code) {
      this.explicaLoading.set(true);
      this.compras.adjustmentsForEntrada({ proveedor_code: c.proveedor_code, entrada_folio: c.folio, date: c.receipt_date, window_days: 15 })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => { this.explicaLoading.set(false); this.explica.set(r?.rows || []); },
          error: () => { this.explicaLoading.set(false); this.explica.set([]); },
        });
    }
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

  // ── lote ──
  readonly showLote = signal(false);
  abrirLote(): void { this.showLote.set(true); }
  onLoteVisible(v: boolean): void { if (!v) this.showLote.set(false); }
  aprobarLote(): void {
    const ids = this.limpias().map((c) => c.deposit_id as string);
    if (!ids.length || this.bulking()) return;
    this.bulking.set(true);
    this.svc.validateBulk(ids).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.bulking.set(false);
        this.showLote.set(false);
        this.decididasHoy.update((n) => n + r.validadas);
        this.toast.add({
          severity: r.omitidas ? 'warn' : 'success',
          summary: `${r.validadas} aprobadas`,
          detail: r.omitidas ? `${r.omitidas} quedaron en la cola (mirá el detalle)` : 'Todas cuadraban al peso',
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
