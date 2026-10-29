import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { RadioButtonModule } from 'primeng/radiobutton';
import { MessageService } from 'primeng/api';
import {
  MOTIVO_FUERA_DE_HOJA_TEXTO, pagableConBilletesCaos, warehouseName,
  type ClaseRenglonHoja, type ClaveZonaHoja, type EstadoDepositoHoja, type EstadoHojaGastos, type HojaAbierta, type HojaGastos,
  type HojasDeGastos, type PagoDeHojaGastos, type RenglonHoja, type RetiroParaHoja,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { uuidV4 } from '../../../core/utils/uuid';
import { CashLedgerService } from '../cash-ledger.service';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';

type Accion = 'rechazar' | 'cancelar';

/**
 * ⭐ `[CGA-A.65]` **La hoja de gastos de zona** — el Excel «Formato de autorización de gastos» que
 * Morelia llenaba a mano, armado solo con los pagos de Kepler.
 *
 * Edgar, 2026-10-29: *«no queremos impresiones, solo quiero que se automatice el proceso tanto del
 * excel como a la hora de pagar»*, *«debería pagarse todo con un solo movimiento y vincularse»* y
 * *«si no está aprobada no se puede pagar»*. Tres firmas, una sola pantalla: la zona cierra su hoja,
 * finanzas la aprueba o la rechaza, y Caja General la paga de un clic con el retiro de CAOS que la
 * cuadra (todos sus pagos quedan ligados a él) y ve si el depósito ya llegó.
 *
 * Jerarquía (Q.5): primario = la hoja abierta (cuánto y qué se va a cerrar) y lo que espera una
 * firma o un pago; secundario = los subtotales y el retiro que la cuadra; terciario = el renglón de
 * Kepler. Abajo, lo que no es de la hoja: lo que no es reposición y lo que ya salió del cajón.
 *
 * ⚠️ Quién hace qué lo vuelve a exigir el servidor (y la base: quien cierra no aprueba). La pantalla
 * manda QUÉ pagos; el importe lo vuelve a leer el servidor de Kepler en la misma transacción.
 */
@Component({
  selector: 'app-finanzas-hoja-gastos',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, TableModule, TagModule, DatePickerModule, DialogModule, TextareaModule, ToastModule, RadioButtonModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast />
    <section class="surf-page hg">
      <header class="surf-page-head hg-head">
        <div>
          <h1 class="surf-title">Hoja de gastos de zona</h1>
          <p class="surf-sub">Los pagos que la zona hizo con su venta, armados solos desde Kepler. La zona la cierra, finanzas la aprueba y Caja General la paga con un solo retiro de CAOS.</p>
        </div>
        <div class="hg-head-r">
          @if (datos(); as d) {
            @if (d.datos_al) { <app-freshness-pill measures="data" [since]="d.datos_al" label="Kepler" /> }
            @else { <span class="hg-warn">Kepler sin medir</span> }
            @if (d.caos_al) { <app-freshness-pill measures="data" [since]="d.caos_al" label="CAOS" /> }
            @else { <span class="hg-warn">CAOS sin medir</span> }
          }
          <p-button icon="pi pi-refresh" size="small" severity="secondary" [text]="true" [loading]="cargando()"
                    ariaLabel="Volver a leer las hojas" (onClick)="cargar()"></p-button>
        </div>
      </header>

      @if (datos(); as d) {
        @if (!d.instalada) {
          <p class="hg-aviso" role="status">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            La hoja abierta se ve, pero todavía no se puede cerrar: falta aplicar en la base la migración de las hojas.
          </p>
        }
        <app-metric-strip class="hg-kpis" [items]="kpis()"></app-metric-strip>
      }

      <app-load-state class="dt-scope" [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="false" [skeletonRows]="4"
                      errorTitle="No se pudieron leer las hojas" (retry)="cargar()">
        @if (datos(); as d) {
          <!-- ── 1. La hoja abierta: lo que hoy se teclea en Excel ── -->
          <section class="hg-sec" aria-labelledby="hg-t-abierta">
            <div class="hg-sec-head">
              <h2 id="hg-t-abierta" class="hg-h2">Hoja abierta</h2>
              <app-context-help topic="hoja_gastos_zona" />
              <span class="hg-sp"></span>
              <app-segmented [options]="opcionesZona()" [value]="zona()" (valueChange)="elegirZona($any($event))" ariaLabel="Zona" />
            </div>
            @if (abierta(); as a) {
              @if (a.renglones.length) {
                <p class="hg-lead" aria-live="polite">
                  <strong class="hg-mono">{{ money(totalElegido()) }}</strong>
                  <span class="hg-dim">en {{ elegidos().length }} de {{ a.renglones.length }} pagos de {{ a.nombre }}
                    · {{ subtotalesTexto(a) }}</span>
                </p>
                <!-- D.7: la fila se recorre con flechas y se marca o desmarca con Enter, igual que su casilla. -->
                <p-table [value]="a.renglones" size="small" dataKey="origen_ref" class="dt-stack hg-tbl"
                         selectionMode="multiple" [metaKeySelection]="false"
                         [selection]="elegidos()" (selectionChange)="elegir($any($event))">
                  <ng-template #header>
                    <tr>
                      <th class="hg-col-sel"><p-tableheadercheckbox ariaLabel="Todos los pagos" /></th>
                      <th>Sucursal</th><th>Día de pago</th><th>Folio</th><th>Beneficiario</th><th>Clase</th>
                      <th class="hg-num">Importe</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr [pSelectableRow]="r">
                      <td class="hg-col-sel" data-label="Va en la hoja" role="cell">
                        <p-tablecheckbox [value]="r" [ariaLabel]="'Incluir ' + (r.beneficiario ?? r.folio)" />
                      </td>
                      <td data-label="Sucursal" role="cell">{{ nombre(r.sucursal) }}</td>
                      <td class="hg-mono" data-label="Día de pago" role="cell">{{ dmy(r.fecha_pago) }}</td>
                      <td class="hg-mono dt-id" data-label="Folio" role="cell">X{{ r.folio.slice(-4) }}</td>
                      <td data-label="Beneficiario" role="cell">{{ r.beneficiario ?? '—' }}</td>
                      <td data-label="Clase" role="cell">{{ claseTexto(r.clase) }}</td>
                      <td class="hg-num dt-num" data-label="Importe" role="cell">{{ money(r.importe) }}</td>
                    </tr>
                  </ng-template>
                </p-table>

                <div class="hg-cierre">
                  <div class="hg-campo">
                    <label class="hg-lbl" for="hg-venta">Se tomó de la venta del día</label>
                    <p-datepicker inputId="hg-venta" [ngModel]="venta()" (ngModelChange)="venta.set($event)" dateFormat="dd/mm/yy"
                                  [showIcon]="true" appendTo="body" [maxDate]="hoy" ariaLabel="Venta del día de la que salió el dinero" />
                  </div>
                  @if (instruccionElegida(); as i) {
                    <p class="hg-instr hg-dim">Al pagar: de CAOS <span class="hg-mono">{{ money(i.retiro) }}</span>,
                      el cajón <span class="hg-mono">{{ money(i.cajon) }}</span>, y se depositan <span class="hg-mono">{{ money(i.deposito) }}</span>.</p>
                  }
                  <span class="hg-sp"></span>
                  @if (puedeCerrar()) {
                    <p-button [label]="'Cerrar hoja · ' + elegidos().length + ' pagos'" icon="pi pi-check" size="small"
                              [disabled]="!d.instalada || !elegidos().length || !venta() || !!ocupado()" [loading]="ocupado() === 'cerrar'"
                              (onClick)="cerrar()"></p-button>
                  } @else {
                    <small class="hg-dim">La cierra quien autoriza por la zona.</small>
                  }
                </div>
              } @else {
                <p class="hg-vacio hg-dim">Sin pagos por reponer en {{ a.nombre }} desde el {{ dmy(a.desde) }}.</p>
              }

              @if (a.fuera.length) {
                <details class="hg-fuera">
                  <summary>{{ a.fuera.length }} {{ a.fuera.length === 1 ? 'pago no va' : 'pagos no van' }} en la hoja ({{ money(totalFuera(a)) }}): por qué</summary>
                  <ul class="hg-fuera-l">
                    @for (r of a.fuera; track r.origen_ref) {
                      <li><span>{{ nombre(r.sucursal) }} · X{{ r.folio.slice(-4) }} · {{ r.beneficiario ?? '—' }}</span>
                        <span class="hg-mono">{{ money(r.importe) }}</span>
                        <span class="hg-dim">{{ motivoTexto(r.motivo) }}</span></li>
                    }
                  </ul>
                </details>
              }
              <!-- Edgar: «lo que se paga con cajón o no es reposición va abajo». -->
              @if (a.pagados_aparte.length) {
                <details class="hg-fuera">
                  <summary>{{ a.pagados_aparte.length }} {{ a.pagados_aparte.length === 1 ? 'pago ya salió' : 'pagos ya salieron' }} de Caja General sin hoja ({{ money(totalAparte(a)) }}): del cajón o de un retiro</summary>
                  <ul class="hg-fuera-l">
                    @for (r of a.pagados_aparte; track r.origen_ref) {
                      <li><span>{{ nombre(r.sucursal) }} · X{{ r.folio.slice(-4) }} · {{ r.beneficiario ?? '—' }}</span>
                        <span class="hg-mono">{{ money(r.importe) }}</span>
                        <span class="hg-dim">{{ r.como === 'cajon' ? 'Del cajón' : 'De un retiro de CAOS' }}@if (r.cg_folio) { · {{ r.cg_folio }} }</span></li>
                    }
                  </ul>
                </details>
              }
            }
          </section>

          <!-- ── 2. Las hojas cerradas: firmas y pago ── -->
          <section class="hg-sec" aria-labelledby="hg-t-cerradas">
            <div class="hg-sec-head">
              <h2 id="hg-t-cerradas" class="hg-h2">Hojas cerradas</h2>
              <app-context-help topic="hoja_gastos_zona" />
            </div>
            @if (d.cerradas.length) {
              <!-- D.7: se recorre con flechas; Enter abre o cierra los pagos de la hoja. -->
              <p-table [value]="d.cerradas" size="small" dataKey="id" class="dt-stack hg-tbl" [expandedRowKeys]="expandidas()"
                       selectionMode="single" [metaKeySelection]="false" [selection]="filaActiva()" (selectionChange)="filaActiva.set($any($event))">
                <ng-template #header>
                  <tr>
                    <th class="hg-col-sel"><span class="sr-only">Detalle</span></th>
                    <th>Folio</th><th>Zona</th><th>Venta del día</th><th class="hg-num">Total</th><th>Estado</th>
                    <th>Firmas</th><th>Pago</th><th>Qué sigue</th>
                  </tr>
                </ng-template>
                <ng-template #body let-h let-expanded="expanded">
                  <tr [pSelectableRow]="h" (keydown.enter)="enterEnFila($event, h.id)">
                    <td class="hg-col-sel dt-actions" data-label="Detalle" role="cell">
                      <p-button type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" [text]="true" size="small"
                                severity="secondary" [ariaLabel]="(expanded ? 'Ocultar' : 'Ver') + ' los pagos de ' + h.folio" (onClick)="alternar(h.id)"></p-button>
                    </td>
                    <td class="hg-mono dt-id" data-label="Folio" role="cell"><strong>{{ h.folio }}</strong></td>
                    <td data-label="Zona" role="cell">{{ h.nombre_zona }}</td>
                    <td class="hg-mono" data-label="Venta del día" role="cell">{{ dmy(h.venta_del_dia) }}</td>
                    <td class="hg-num dt-num" data-label="Total" role="cell">{{ money(h.total) }}</td>
                    <td data-label="Estado" role="cell"><p-tag [severity]="severidadEstado(h.estado)" [value]="estadoTexto(h.estado)"></p-tag></td>
                    <td class="hg-apila" data-label="Firmas" role="cell">
                      <small>Cerró {{ h.cerrada_por_nombre ?? 'sin nombre' }}</small>
                      @if (h.aprobada_por_nombre) { <small>Aprobó {{ h.aprobada_por_nombre }}</small> }
                      @if (h.pago?.pagada_por_nombre) { <small>Pagó {{ h.pago?.pagada_por_nombre }}</small> }
                      @if (h.resuelta_por_nombre) { <small>{{ h.estado === 'rechazada' ? 'Rechazó' : 'Canceló' }} {{ h.resuelta_por_nombre }}</small> }
                    </td>
                    <td class="hg-apila" data-label="Pago" role="cell">
                      @if (h.pago; as p) {
                        <small>{{ medioTexto(p) }}</small>
                        <p-tag [severity]="severidadDeposito(p.deposito.estado)" [value]="depositoTexto(p.deposito.estado)"></p-tag>
                        @if (p.sin_capturar) { <small class="hg-warn">{{ p.sin_capturar }} {{ p.sin_capturar === 1 ? 'pago sin capturar' : 'pagos sin capturar' }} en el libro</small> }
                        @if (p.deposito.nota) { <small class="hg-dim">{{ p.deposito.nota }}</small> }
                      } @else {
                        <span class="hg-dim">—</span>
                      }
                    </td>
                    <td class="hg-apila hg-que" data-label="Qué sigue" role="cell">
                      @if (h.estado === 'cerrada') {
                        @if (puedeAprobar() && h.cerrada_por !== yo()) {
                          <div class="hg-acc">
                            <p-button label="Aprobar" icon="pi pi-check" size="small" [disabled]="!!ocupado()" [loading]="ocupado() === h.id"
                                      (onClick)="aprobar(h)"></p-button>
                            <p-button label="Rechazar" severity="secondary" [outlined]="true" size="small" [disabled]="!!ocupado()"
                                      (onClick)="pedirMotivo('rechazar', h)"></p-button>
                          </div>
                        } @else if (puedeAprobar()) {
                          <small class="hg-dim">La cerraste tú: la aprueba otra persona.</small>
                        } @else {
                          <small class="hg-dim">Espera la firma de finanzas.</small>
                        }
                        @if (puedeCerrar()) {
                          <p-button label="Cancelar hoja" severity="danger" [text]="true" size="small" [disabled]="!!ocupado()"
                                    (onClick)="pedirMotivo('cancelar', h)"></p-button>
                        }
                      } @else if (h.estado === 'aprobada') {
                        @if (puedePagar() && h.aprobada_por !== yo()) {
                          <p-button [label]="'Pagar ' + h.folio" icon="pi pi-wallet" size="small" [disabled]="!!ocupado()"
                                    (onClick)="abrirPago(h)"></p-button>
                          <small class="hg-dim">{{ textoCuadre(h) }}</small>
                        } @else if (puedePagar()) {
                          <small class="hg-dim">La aprobaste tú: la paga otra persona.</small>
                        } @else {
                          <small>La paga Caja General con un solo retiro: <span class="hg-mono">{{ money(h.instruccion.retiro) }}</span> de CAOS,
                            el cajón pone <span class="hg-mono">{{ money(h.instruccion.cajon) }}</span>.</small>
                        }
                      } @else if (h.estado === 'pagada') {
                        @if (puedePagar() && h.pago?.sin_capturar) {
                          <p-button label="Capturar lo que falta" icon="pi pi-refresh" size="small" severity="secondary" [outlined]="true"
                                    [disabled]="!!ocupado()" [loading]="ocupado() === h.id" (onClick)="capturar(h)"></p-button>
                        } @else {
                          <small class="hg-dim">Pagada: todos sus pagos los explica {{ h.pago?.medio === 'cajon' ? 'el cajón' : 'su retiro' }}.</small>
                        }
                      } @else {
                        <small class="hg-dim">{{ h.motivo }}</small>
                      }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #expandedrow let-h>
                  <tr>
                    <td colspan="9" class="hg-det" role="cell">
                      <p class="hg-dim hg-det-sub">{{ subtotalesCerrada(h) }}</p>
                      <p-table [value]="h.renglones" size="small" class="hg-mini">
                        <ng-template #header>
                          <tr><th>Sucursal</th><th>Día de pago</th><th>Folio</th><th>Beneficiario</th><th>Clase</th><th class="hg-num">Importe</th></tr>
                        </ng-template>
                        <ng-template #body let-r>
                          <tr>
                            <td data-label="Sucursal" role="cell">{{ nombre(r.sucursal) }}</td>
                            <td class="hg-mono" data-label="Día de pago" role="cell">{{ dmy(r.fecha_pago) }}</td>
                            <td class="hg-mono" data-label="Folio" role="cell">X{{ r.folio.slice(-4) }}</td>
                            <td data-label="Beneficiario" role="cell">{{ r.beneficiario ?? '—' }}</td>
                            <td data-label="Clase" role="cell">{{ claseTexto(r.clase) }}</td>
                            <td class="hg-num dt-num" data-label="Importe" role="cell">{{ money(r.importe) }}</td>
                          </tr>
                        </ng-template>
                      </p-table>
                      @if (h.pago?.retiro; as rt) {
                        <p class="hg-dim hg-det-sub">Retiro de CAOS «{{ rt.ref ?? rt.external_id }}» del {{ dmy(rt.dia) }} por <span class="hg-mono">{{ money(rt.total) }}</span>;
                          el cajón puso <span class="hg-mono">{{ money(h.pago?.cajon ?? 0) }}</span>.</p>
                      }
                      @if (h.pago?.deposito?.depositos; as deps) {
                        <p class="hg-dim hg-det-sub">Depósito: @for (x of deps; track x.id) { <span class="hg-mono">{{ money(x.importe) }}</span> el {{ dmy(x.dia) }}@if (!$last) { y } }.</p>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            } @else {
              <p class="hg-vacio hg-dim">Todavía no se ha cerrado ninguna hoja.</p>
            }
          </section>
        }
      </app-load-state>
    </section>

    <p-dialog [visible]="dialogo() !== null" (visibleChange)="$event ? null : cerrarDialogo()" [modal]="true" appendTo="body"
              [header]="dialogo()?.accion === 'rechazar' ? 'Rechazar la hoja' : 'Cancelar la hoja'" [style]="{ width: '32rem' }" [draggable]="false">
      @if (dialogo(); as dl) {
        <div class="hg-dlg">
          <p>{{ dl.hoja.folio }} · {{ dl.hoja.nombre_zona }} · <span class="hg-mono">{{ money(dl.hoja.total) }}</span>.
            Sus pagos vuelven a la hoja abierta.</p>
          <label class="hg-lbl" for="hg-motivo">Por qué (mínimo 10 letras)</label>
          <textarea pTextarea id="hg-motivo" rows="3" [(ngModel)]="motivo" class="hg-ancho"
                    placeholder="Ej. falta el comprobante del proveedor"></textarea>
        </div>
      }
      <ng-template #footer>
        <p-button label="Volver" severity="secondary" [text]="true" (onClick)="cerrarDialogo()"></p-button>
        <p-button [label]="dialogo()?.accion === 'rechazar' ? 'Rechazar' : 'Cancelar hoja'" severity="danger"
                  [disabled]="motivo.trim().length < 10 || !!ocupado()" [loading]="ocupado() === 'motivo'" (onClick)="confirmarMotivo()"></p-button>
      </ng-template>
    </p-dialog>

    <!-- Pagar: UN movimiento para la hoja entera. El servidor vuelve a revisar que esté aprobada, que
         quien paga no la haya aprobado y que el retiro la cuadre. -->
    <p-dialog [visible]="pagando() !== null" (visibleChange)="$event ? null : cerrarPago()" [modal]="true" appendTo="body"
              [header]="'Pagar ' + (pagando()?.folio ?? '')" [style]="{ width: '36rem' }" [draggable]="false">
      @if (pagando(); as h) {
        <div class="hg-dlg">
          <p>{{ h.nombre_zona }} · {{ h.renglones.length }} pagos · <strong class="hg-mono">{{ money(h.total) }}</strong>.
            Todos quedan explicados por el mismo movimiento.</p>
          <fieldset class="hg-opciones">
            <legend class="hg-lbl">Con qué se paga</legend>
            @for (r of h.retiros_que_cuadran; track r.external_id) {
              <div class="hg-opcion">
                <p-radiobutton name="hg-medio" [value]="claveRetiro(r)" [ngModel]="eleccion()" (ngModelChange)="eleccion.set($event)"
                               [inputId]="'hg-r-' + r.external_id" />
                <label [for]="'hg-r-' + r.external_id">Retiro «{{ r.ref ?? r.external_id }}» del {{ dmy(r.dia) }} ·
                  <span class="hg-mono">{{ money(r.total) }}</span> · el cajón pone <span class="hg-mono">{{ money(r.cajon) }}</span></label>
              </div>
            } @empty {
              <p class="hg-dim hg-sin-retiro">Ningún retiro libre cuadra con la hoja. Saca <span class="hg-mono">{{ money(h.instruccion.retiro) }}</span>
                de CAOS (el cajón pone <span class="hg-mono">{{ money(h.instruccion.cajon) }}</span>) y vuelve a cargar: aparece aquí.</p>
            }
            <div class="hg-opcion">
              <p-radiobutton name="hg-medio" value="cajon" [ngModel]="eleccion()" (ngModelChange)="eleccion.set($event)" inputId="hg-r-cajon" />
              <label for="hg-r-cajon">Con el cajón, sin retiro de CAOS <span class="hg-dim">(la excepción: se ve aparte)</span></label>
            </div>
          </fieldset>
        </div>
      }
      <ng-template #footer>
        <p-button label="Volver" severity="secondary" [text]="true" (onClick)="cerrarPago()"></p-button>
        <p-button [label]="'Pagar ' + (pagando()?.folio ?? '')" icon="pi pi-check" [disabled]="!eleccion() || !!ocupado()"
                  [loading]="ocupado() === 'pagar'" (onClick)="confirmarPago()"></p-button>
      </ng-template>
    </p-dialog>
  `,
  styles: [
    FINANZAS_SHARED_STYLES,
    `
    :host { display:block; }
    .hg-head { display:flex; align-items:flex-start; flex-wrap:wrap; gap:var(--sp-3); }
    .hg-head-r { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin-left:auto; }
    .hg-warn { color:var(--warn-soft-fg); font-size:var(--fs-xs); }
    .hg-aviso { display:flex; gap:var(--sp-2); align-items:center; margin:0; padding:var(--sp-2) var(--sp-3);
                border:1px solid var(--border-color); border-radius:var(--r-md, 8px); background:var(--surface-2); color:var(--fg-2); }
    .hg-kpis { display:block; }
    .hg-sec { display:flex; flex-direction:column; gap:var(--sp-2); margin-bottom:var(--sp-4); }
    .hg-sec-head { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); }
    .hg-h2 { margin:0; font-size:var(--fs-md); font-weight:700; color:var(--fg-1); }
    .hg-sp { flex:1 1 auto; }
    .hg-lead { margin:0; display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); }
    .hg-lead strong { font-size:var(--fs-lg); color:var(--fg-1); }
    .hg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .hg-num { text-align:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .hg-dim { color:var(--text-muted); }
    .hg-col-sel { width:2.5rem; }
    .hg-cierre { display:flex; align-items:flex-end; flex-wrap:wrap; gap:var(--sp-3); }
    .hg-campo { display:flex; flex-direction:column; gap:var(--sp-1); }
    .hg-lbl { font-size:var(--fs-xs); color:var(--text-muted); }
    .hg-instr { margin:0; max-width:40rem; }
    .hg-vacio { margin:0; }
    .hg-fuera summary { cursor:pointer; color:var(--fg-2); font-size:var(--fs-sm); }
    .hg-fuera summary:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .hg-fuera-l { margin:var(--sp-2) 0 0; padding-left:var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-1); }
    .hg-fuera-l li { display:flex; flex-wrap:wrap; gap:var(--sp-2); font-size:var(--fs-sm); }
    .hg-apila { display:flex; flex-direction:column; align-items:flex-start; gap:var(--sp-1); }
    .hg-que { min-width:14rem; }
    .hg-que small { max-width:24rem; }
    .hg-acc { display:flex; flex-wrap:wrap; gap:var(--sp-2); }
    .hg-det { background:var(--surface-2); padding:var(--sp-3); }
    .hg-det-sub { margin:0 0 var(--sp-2); }
    .hg-dlg { display:flex; flex-direction:column; gap:var(--sp-2); }
    .hg-dlg p { margin:0; }
    .hg-opciones { border:0; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--sp-2); }
    .hg-opcion { display:flex; align-items:center; gap:var(--sp-2); }
    .hg-opcion label { cursor:pointer; }
    .hg-ancho { width:100%; }
    `,
  ],
})
export class FinanzasHojaGastosComponent implements OnInit {
  private readonly api = inject(CashLedgerService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly money = money;
  readonly dmy = dmy;
  readonly hoy = new Date();

  readonly datos = signal<HojasDeGastos | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly ocupado = signal<string | null>(null);
  readonly zona = signal<ClaveZonaHoja>('morelia');
  /** Por zona, los pagos que la persona dejó FUERA de esta hoja. Todo lo demás va. */
  private readonly fueraElegidos = signal<Partial<Record<ClaveZonaHoja, string[]>>>({});
  readonly venta = signal<Date | null>(null);
  readonly expandidas = signal<Record<string, boolean>>({});
  /** La hoja cerrada donde está el teclado (D.7). */
  readonly filaActiva = signal<HojaGastos | null>(null);
  readonly dialogo = signal<{ accion: Accion; hoja: HojaGastos } | null>(null);
  motivo = '';
  /** La hoja aprobada que se está pagando, y con qué: `device|external_id` de un retiro, o `cajon`. */
  readonly pagando = signal<HojaGastos | null>(null);
  readonly eleccion = signal<string | null>(null);
  /** La llave del cierre: el doble clic no cierra dos hojas. Se renueva al cerrar. */
  private llave = uuidV4();

  readonly puedeCerrar = computed(() => this.perms.has(Permission.FINANCE_HOJA_GASTOS_CERRAR));
  readonly puedeAprobar = computed(() => this.perms.has(Permission.FINANCE_EXPENSES_COMPROBAR));
  /** Paga quien gestiona la caja: el mismo permiso que el lote de la cola. */
  readonly puedePagar = computed(() => this.perms.has(Permission.FINANCE_CAJA_GESTIONAR));
  readonly yo = computed(() => this.auth.user()?.sub ?? null);

  readonly abierta = computed<HojaAbierta | null>(() => this.datos()?.abiertas.find((a) => a.zona === this.zona()) ?? null);
  readonly elegidos = computed<RenglonHoja[]>(() => {
    const a = this.abierta();
    const fuera = new Set(this.fueraElegidos()[this.zona()] ?? []);
    return a ? a.renglones.filter((r) => !fuera.has(r.origen_ref)) : [];
  });
  readonly totalElegido = computed(() => Math.round(this.elegidos().reduce((s, r) => s + Number(r.importe), 0) * 100) / 100);
  readonly instruccionElegida = computed(() => {
    const t = this.totalElegido();
    if (!(t > 0)) return null;
    const retiro = pagableConBilletesCaos(t);
    return { retiro, cajon: Math.round((t - retiro) * 100) / 100, deposito: t };
  });

  readonly opcionesZona = computed<SegOption[]>(() => (this.datos()?.abiertas ?? []).map((a) => ({
    label: a.nombre.replace(/^Zona /, ''), value: a.zona, count: a.renglones.length,
  })));

  /** Q.1: abre con lo que espera a alguien, no con la tabla. */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const abiertas = d.abiertas.reduce((a, h) => a + h.total, 0);
    const porFirmar = d.cerradas.filter((h) => h.estado === 'cerrada');
    const porPagar = d.cerradas.filter((h) => h.estado === 'aprobada');
    const sinDeposito = d.cerradas.filter((h) => h.estado === 'pagada' && h.pago?.deposito.estado !== 'depositada');
    const suma = (xs: HojaGastos[]) => xs.reduce((a, h) => a + h.total, 0);
    return [
      { label: 'Por cerrar (hojas abiertas)', value: abiertas, format: 'currency2', tone: 'default' },
      { label: `Esperan a finanzas (${porFirmar.length})`, value: suma(porFirmar), format: 'currency2', tone: porFirmar.length ? 'warn' : 'ok' },
      { label: `Aprobadas por pagar (${porPagar.length})`, value: suma(porPagar), format: 'currency2', tone: porPagar.length ? 'warn' : 'ok' },
      { label: `Pagadas sin depósito (${sinDeposito.length})`, value: suma(sinDeposito), format: 'currency2', tone: sinDeposito.length ? 'warn' : 'ok' },
    ];
  });

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.hojasDeGastos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.datos.set(d);
        this.cargando.set(false);
        // Zona por defecto: la primera con pagos por cerrar.
        if (!d.abiertas.some((a) => a.zona === this.zona() && a.renglones.length)) {
          const conPagos = d.abiertas.find((a) => a.renglones.length);
          if (conPagos) this.zona.set(conPagos.zona);
        }
        this.ventaPorDefecto();
      },
      error: (e) => {
        this.cargando.set(false);
        this.error.set(e?.error?.message ?? 'No se pudo leer');
      },
    });
  }

  elegirZona(z: ClaveZonaHoja): void {
    this.zona.set(z);
    this.ventaPorDefecto();
  }

  /** La selección de la tabla → los que quedan FUERA (así lo nuevo que llega entra solo). */
  elegir(sel: RenglonHoja[]): void {
    const a = this.abierta();
    if (!a) return;
    const dentro = new Set(sel.map((r) => r.origen_ref));
    this.fueraElegidos.update((f) => ({ ...f, [a.zona]: a.renglones.filter((r) => !dentro.has(r.origen_ref)).map((r) => r.origen_ref) }));
  }

  cerrar(): void {
    const a = this.abierta();
    const venta = this.venta();
    if (!a || !venta || !this.elegidos().length || this.ocupado()) return;
    this.ocupado.set('cerrar');
    this.api.cerrarHojaDeGastos(a.zona, {
      origen_refs: this.elegidos().map((r) => r.origen_ref), venta_del_dia: this.iso(venta), client_key: this.llave,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => {
        this.ocupado.set(null);
        this.llave = uuidV4();
        this.fueraElegidos.update((f) => ({ ...f, [a.zona]: [] }));
        this.toast.add({ severity: 'success', summary: `${h.folio} cerrada`, detail: `${h.renglones.length} pagos por ${money(h.total)}. Ahora la aprueba finanzas.` });
        this.cargar();
      },
      error: (e) => this.falla(e, 'No se cerró la hoja'),
    });
  }

  aprobar(h: HojaGastos): void {
    if (this.ocupado()) return;
    this.ocupado.set(h.id);
    this.api.aprobarHojaDeGastos(h.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'success', summary: `${x.folio} aprobada`, detail: 'Caja General ya la puede pagar, con un solo retiro de CAOS.' });
        this.cargar();
      },
      error: (e) => this.falla(e, 'No se aprobó la hoja'),
    });
  }

  pedirMotivo(accion: Accion, hoja: HojaGastos): void {
    this.motivo = '';
    this.dialogo.set({ accion, hoja });
  }

  cerrarDialogo(): void {
    this.dialogo.set(null);
  }

  confirmarMotivo(): void {
    const dl = this.dialogo();
    const m = this.motivo.trim();
    if (!dl || m.length < 10 || this.ocupado()) return;
    this.ocupado.set('motivo');
    const pide = dl.accion === 'rechazar' ? this.api.rechazarHojaDeGastos(dl.hoja.id, m) : this.api.cancelarHojaDeGastos(dl.hoja.id, m);
    pide.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        this.dialogo.set(null);
        this.toast.add({ severity: 'info', summary: `${x.folio} ${dl.accion === 'rechazar' ? 'rechazada' : 'cancelada'}`, detail: 'Sus pagos volvieron a la hoja abierta.' });
        this.cargar();
      },
      error: (e) => this.falla(e, dl.accion === 'rechazar' ? 'No se rechazó la hoja' : 'No se canceló la hoja'),
    });
  }

  /** Abre el pago con la propuesta ya elegida cuando UN solo retiro cuadra; con varios, elige la persona. */
  abrirPago(h: HojaGastos): void {
    this.eleccion.set(h.retiros_que_cuadran.length === 1 ? this.claveRetiro(h.retiros_que_cuadran[0]) : null);
    this.pagando.set(h);
  }

  cerrarPago(): void {
    this.pagando.set(null);
  }

  claveRetiro(r: RetiroParaHoja): string {
    return `${r.device}|${r.external_id}`;
  }

  confirmarPago(): void {
    const h = this.pagando();
    const e = this.eleccion();
    if (!h || !e || this.ocupado()) return;
    const r = h.retiros_que_cuadran.find((x) => this.claveRetiro(x) === e);
    if (e !== 'cajon' && !r) return;
    this.ocupado.set('pagar');
    const body = r ? { medio: 'caos' as const, device: r.device, external_id: r.external_id } : { medio: 'cajon' as const };
    this.api.pagarHojaDeGastos(h.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        this.pagando.set(null);
        const faltan = x.sin_capturar.length;
        this.toast.add({
          severity: faltan ? 'warn' : 'success', summary: `${x.hoja.folio} pagada`,
          detail: `${x.capturados + x.ligados} ${x.capturados + x.ligados === 1 ? 'pago quedó' : 'pagos quedaron'} explicados por ${r ? 'el retiro' : 'el cajón'}.`
            + (faltan ? ` ${faltan} sin capturar: ${x.sin_capturar[0].motivo ?? 'reintenta con «Capturar lo que falta»'}.` : ''),
        });
        this.cargar();
      },
      error: (err) => this.falla(err, 'No se pagó la hoja'),
    });
  }

  capturar(h: HojaGastos): void {
    if (this.ocupado()) return;
    this.ocupado.set(h.id);
    this.api.capturarHojaDeGastos(h.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        const faltan = x.sin_capturar.length;
        this.toast.add({ severity: faltan ? 'warn' : 'success', summary: `${x.hoja.folio}: ${x.capturados} ${x.capturados === 1 ? 'capturado' : 'capturados'}`,
          detail: faltan ? `${faltan} todavía sin capturar: ${x.sin_capturar[0].motivo ?? 'revisa su cuenta contable'}.` : 'Todos sus pagos ya están en el libro.' });
        this.cargar();
      },
      error: (err) => this.falla(err, 'No se capturó'),
    });
  }

  /** La línea bajo «Pagar»: qué retiro cuadra, o cuánto sacar. */
  textoCuadre(h: HojaGastos): string {
    const rs = h.retiros_que_cuadran;
    if (rs.length === 1) return `Cuadra el retiro «${rs[0].ref ?? rs[0].external_id}» del ${dmy(rs[0].dia)}: ${money(rs[0].total)}, el cajón pone ${money(rs[0].cajon)}.`;
    if (rs.length > 1) return `${rs.length} retiros cuadran con la hoja: elige el suyo.`;
    return `Saca ${money(h.instruccion.retiro)} de CAOS (el cajón pone ${money(h.instruccion.cajon)}) y vuelve a cargar.`;
  }

  medioTexto(p: PagoDeHojaGastos): string {
    if (p.medio === 'cajon') return `Del cajón: ${money(p.cajon)}`;
    const r = p.retiro;
    return `Retiro «${r?.ref ?? r?.external_id ?? '—'}» ${money(r?.total ?? 0)}${p.cajon > 0 ? ` · cajón ${money(p.cajon)}` : ''}`;
  }

  depositoTexto(e: EstadoDepositoHoja): string {
    return { depositada: 'Depositada', ambiguo: 'Depósito por ligar', no_aparece: 'Sin depósito todavía', sin_medir: 'Depósito sin medir' }[e];
  }

  severidadDeposito(e: EstadoDepositoHoja): 'success' | 'info' | 'warn' | 'secondary' {
    return e === 'depositada' ? 'success' : e === 'no_aparece' ? 'info' : e === 'ambiguo' ? 'warn' : 'secondary';
  }

  totalAparte(a: HojaAbierta): number {
    return Math.round(a.pagados_aparte.reduce((s, r) => s + Number(r.importe), 0) * 100) / 100;
  }

  /** Enter en la fila abre o cierra sus pagos; si el foco está en un botón de la fila, manda el botón. */
  enterEnFila(ev: Event, id: string): void {
    if ((ev.target as HTMLElement | null)?.closest('button, a, input, textarea')) return;
    ev.preventDefault();
    this.alternar(id);
  }

  alternar(id: string): void {
    this.expandidas.update((e) => (e[id] ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== id)) : { ...e, [id]: true }));
  }

  nombre(sucursal: string): string {
    return warehouseName(sucursal);
  }

  claseTexto(c: ClaseRenglonHoja): string {
    return c === 'proveedor' ? 'Proveedor' : c === 'gasto' ? 'Gasto' : 'Sin clave';
  }

  motivoTexto(m: keyof typeof MOTIVO_FUERA_DE_HOJA_TEXTO): string {
    return MOTIVO_FUERA_DE_HOJA_TEXTO[m];
  }

  totalFuera(a: HojaAbierta): number {
    return Math.round(a.fuera.reduce((s, r) => s + Number(r.importe), 0) * 100) / 100;
  }

  subtotalesTexto(a: HojaAbierta): string {
    const elegidos = new Set(this.elegidos().map((r) => r.origen_ref));
    return a.por_sucursal.map((s) => {
      const xs = a.renglones.filter((r) => r.sucursal === s.sucursal && elegidos.has(r.origen_ref));
      return `${this.nombre(s.sucursal)} ${money(xs.reduce((t, r) => t + Number(r.importe), 0))}`;
    }).join(' · ');
  }

  subtotalesCerrada(h: HojaGastos): string {
    return h.por_sucursal.map((s) => `${this.nombre(s.sucursal)}: ${s.renglones} ${s.renglones === 1 ? 'pago' : 'pagos'} por ${money(s.total)}`).join(' · ');
  }

  estadoTexto(e: EstadoHojaGastos): string {
    return { cerrada: 'Espera a finanzas', aprobada: 'Aprobada, por pagar', pagada: 'Pagada', rechazada: 'Rechazada', cancelada: 'Cancelada' }[e];
  }

  severidadEstado(e: EstadoHojaGastos): 'warn' | 'success' | 'info' | 'danger' | 'secondary' {
    return e === 'cerrada' ? 'warn' : e === 'aprobada' ? 'info' : e === 'pagada' ? 'success' : e === 'rechazada' ? 'danger' : 'secondary';
  }

  /** Venta del día por defecto: el primer día de pago de la hoja (lo cambia quien la cierra). */
  private ventaPorDefecto(): void {
    const a = this.abierta();
    const primero = a?.renglones.map((r) => r.fecha_pago).sort()[0];
    if (!primero) { this.venta.set(null); return; }
    const [y, m, d] = primero.split('-').map(Number);
    const dia = new Date(y, m - 1, d);
    this.venta.set(dia > this.hoy ? new Date(this.hoy.getFullYear(), this.hoy.getMonth(), this.hoy.getDate()) : dia);
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private falla(e: { error?: { message?: string } }, titulo: string): void {
    this.ocupado.set(null);
    this.toast.add({ severity: 'error', summary: titulo, detail: e?.error?.message ?? 'Intenta de nuevo.' });
    if ((e as { status?: number })?.status === 409) this.cargar();
  }
}
