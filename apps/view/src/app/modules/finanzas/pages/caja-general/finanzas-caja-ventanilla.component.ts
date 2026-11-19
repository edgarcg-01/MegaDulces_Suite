import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, Injector, OnInit, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import {
  SUCURSAL_CAJA_GENERAL, valorDePiezas, type CustodiaAbierta, type HojaDeReposicion, type PersonaDeCustodia, type ResultadoRendicion, type PartidaEnSuspenso, type PlanDePagoVentanilla, type QuienLlevaDeposito, type ResultadoCobro, type ResultadoHecho, type ResultadoPago,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { DevolverFocoDirective } from '../../../../shared/directives/devolver-foco.directive';
import { DescartarCambiosComponent } from '../../../../shared/components/descartar-cambios/descartar-cambios.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { uuidV4 } from '../../../../core/utils/uuid';
import { CashLedgerService, type PendientesResponse } from '../../cash-ledger.service';
import { LibroEfectivoService } from '../../libro-efectivo.service';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { ConteoCajonComponent } from '../../components/conteo-cajon.component';
import { VentanillaDiaComponent } from '../../components/ventanilla-dia.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { armarCobros, armarCola, resumenCola, textoDiferencia, type FilaCobro, type FilaVentanilla } from './ventanilla.util';

/** El libro nuevo, para la Ventanilla: si hoy puede pagar. */
type EstadoLibro = 'abierto' | 'sin_dia' | 'sin_medir';

/**
 * ⭐ `[LE.2.13]` **La Ventanilla de Caja General** (fase LE, ADR-112): pagar ES registrar, y lo que
 * respalda el pago lo dice Kepler. PM, 2026-11-03: *«las compras ya se autorizan cuando se hace la
 * compra»*, *«¿por qué volverlos a aprobar?»* (D27) y *«lo rechazado no se paga»* (D29).
 *
 * Las cinco preguntas (`diseno` §0b):
 * 1. Qué ve y en qué orden: si el libro puede pagar hoy; cuánto se paga ya, cuánto pide firma y
 *    cuánto está detenido; la cola en ese orden (lo que se paga primero).
 * 2. Qué no ve: la cuenta y el concepto (los resuelve el sistema), ni un vale que elegir (lo pone Kepler).
 * 3. Accesibilidad: el motivo va en la fila y en palabras (no sólo color), con el enlace a donde se
 *    arregla; el resultado del pago se anuncia (`role="status"`).
 * 4. Ligado a: Aprobación de gastos (donde se arregla un gasto), la máquina CAOS (el código) y la
 *    cola de Kepler (`movimientos-pendientes`, la misma de Captura).
 * 5. Quién: quien opera la caja (el permiso de Captura); pagar pide GESTIONAR, y la base exige la llave (LE.0.9).
 *
 * `[LE.6.7]` «Por recibir», en la misma pantalla y después de lo que sale (§5.2):
 * 1. Qué ve: cada cobro U-A-5 de la 0011 con de quién es (ruta o sucursal) y lo que Kepler espera;
 *    primero lo que se recibe, después lo detenido con su porqué.
 * 2. Qué no: lo ya recibido en el libro nuevo (se cuenta en el pie, no se lista) ni un importe que teclear.
 * 3. Accesibilidad: la ventana pregunta primero cómo llegó el dinero —2 de cada 3 cobros de ruta
 *    entran por la máquina (medido el 2026-11-04) y contarlos aquí sería contarlos dos veces—; lo
 *    contado se compara en palabras contra lo esperado (faltan, sobran o centavos que no se cuentan).
 * 4. Ligado a: la cobranza de Kepler (lo que la ruta debe rendir) y la máquina (lo depositado).
 * 5. Quién: el mismo permiso que pagar.
 *
 * Jerarquía (Q.5): primario = qué se puede pagar ya; secundario = la fila y su porqué; terciario = el folio.
 *
 * `[LE.6.10]` **Una sola pantalla, sin scroll** (PM, 2026-11-05: *«todo debe vivir en la interfaz principal
 * sin necesidad de hacer scroll»*). Antes eran seis bloques apilados y en 1366×768 sólo se veían cinco filas
 * de Suspenso: «Por pagar» —el 65 % del trabajo— quedaba abajo. Las cinco preguntas, otra vez:
 * 1. Qué ve y en qué orden: la barra del día; las cifras de lo que hay; qué ver, con su conteo; y la cola.
 *    Abre en «Por pagar», que es lo que más se hace.
 * 2. Qué no: el título largo y el aviso a todo lo ancho (el estado del libro es una etiqueta en la barra).
 * 3. Accesibilidad: cambiar de cola es un radiogroup con flechas y su conteo en el nombre accesible; la
 *    página no se desplaza, sólo la cola (en pantallas angostas vuelve el scroll de la página).
 * 4. Ligado a: lo mismo que antes; cada acción sigue en su fila y abre su ventana.
 * 5. Quién: sin cambio.
 *
 * ⚠️ El importe nunca viaja desde aquí: el servidor relee el documento (`pagos/plan`, `pagos`).
 */
@Component({
  selector: 'app-finanzas-caja-ventanilla',
  standalone: true,
  imports: [
    FormsModule, RouterLink, ButtonModule, TableModule, TagModule, DialogModule, InputTextModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, DevolverFocoDirective, CajaTabsComponent, ConteoCajonComponent, ContextHelpComponent, VentanillaDiaComponent,
    DescartarCambiosComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-caja-tabs />
    <!-- PM, 2026-11-05: «todo debe vivir en la interfaz principal sin necesidad de hacer scroll». La página no
         se desplaza: barra del día, lo que hay (cifras), qué ver (con su conteo) y UNA cola con su propio scroll. -->
    <div #marco class="surf-page in vt" [style.height.px]="alto()">
      <header class="vt-barra">
        <h1 class="vt-h1">Ventanilla</h1>
        <!-- [LE.6.3] [LE.6.4] [LE.6.6] Tu día: abrir, arrancar, contar, cerrar, arqueo, firmas y hallazgos. -->
        <app-ventanilla-dia class="vt-dia" (cambio)="cargar()" (codigo)="ultimoCodigo.set($event)" />
        <div class="vt-acciones">
          <!-- [LE.6.34] El último código entregado en esta sesión: si alguien cerró la ventana antes de teclearlo, aquí sigue. -->
          @if (ultimoCodigo(); as u) {
            <span class="vt-chip vt-chip--codigo" role="status" data-testid="ultimo-codigo">
              Último código: <b class="vt-codigo-chico">{{ u.codigo }}</b> · {{ u.de }}
            </span>
          }
          @if (libro() === 'sin_dia') {
            <span class="vt-chip" role="status" data-testid="libro-sin-dia">
              <i class="pi pi-info-circle" aria-hidden="true"></i> Sin día abierto: se ve, pero no se paga hasta el saldo de arranque
            </span>
          }
          @if (!puedeGestionar()) {
            <span class="vt-chip" data-testid="solo-lectura">
              <i class="pi pi-eye" aria-hidden="true"></i> Sólo lectura: pagar y recibir necesitan el permiso «Capturar en Caja General»
            </span>
          }
          <app-context-help topic="caja-ventanilla" />
          <app-freshness-pill measures="data" [since]="cola()?.datos_al ?? null" label="Kepler" />
          <p-button size="small" icon="pi pi-refresh" severity="secondary" [text]="true" label="Actualizar"
                    [loading]="cargando()" (onClick)="cargar()" />
        </div>
      </header>

      @if (cola()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Lo que hay en la caja, por estado" density="compact" />
      }

      <div class="vt-vista">
        <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="vista.set($any($event))" (saltarAbajo)="aLaCola()" ariaLabel="Qué ver de la caja" />
        <!-- [LE.6.11] El recorrido, ESCRITO (D.5: un atajo que nadie sabe que existe no existe). Sólo lo que el
             código responde: ← → el radiogroup de app-segmented · ↓ desde el selector y ↑ desde la primera fila
             (teclaEnMarco) · ↑ ↓ entre filas, pSelectableRow · Enter onRowSelect abre la acción de la fila ·
             Esc cierra la ventana y appDevolverFoco regresa el foco a la fila. Medido con Playwright sólo teclado. -->
        <span class="vt-atajo" data-testid="atajos">
          <kbd>←</kbd><kbd>→</kbd> cola · <kbd>↓</kbd> a la lista · <kbd>↑</kbd><kbd>↓</kbd> fila · <kbd>Enter</kbd> abrir · <kbd>Esc</kbd> cerrar
        </span>
        @if (vista() === 'recibir') {
          <!-- [LE.6.7] E-23: lo que entra sin documento de cobro de Kepler. -->
          <p-button size="small" severity="secondary" [outlined]="true" icon="pi pi-plus" label="Otro ingreso" [disabled]="!puedePagar()" (onClick)="abrirOtro()" />
        } @else if (vista() === 'custodias') {
          <p-button size="small" severity="secondary" [outlined]="true" icon="pi pi-plus" label="Sacar a custodia" [disabled]="!puedePagar()"
                    (onClick)="abrirNuevaCustodia()" />
        }
      </div>

      <div #colaEl class="vt-cola" data-testid="cola" data-foco-retorno>
        @switch (vista()) {
          @case ('pagar') {
            <app-load-state [loading]="cargando() && !cola()" [error]="error()" [isEmpty]="!!cola() && !filas().length" [skeletonRows]="6"
                            errorTitle="No se pudo leer qué hay por pagar" emptyTitle="No hay pagos por hacer en Caja General"
                            (retry)="cargar()">
              @if (cola(); as c) {
                <!-- D.7: la cola se recorre con flechas y Enter abre el pago de la fila (lo detenido no abre). -->
                <p-table [value]="filas()" size="small" dataKey="doc.origen_ref" class="dt-stack vt-tbl" data-testid="pagos"
                         selectionMode="single" [metaKeySelection]="false" [selection]="null" (onRowSelect)="abrirFila($event.data)">
                  <ng-template #header>
                    <tr>
                      <th scope="col">Documento</th><th scope="col">Beneficiario</th><th scope="col">Fecha</th>
                      <th scope="col">Lo respalda</th><th scope="col" class="ta-r">Importe</th><th scope="col"><span class="sr-only">Pagar</span></th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-f>
                    <tr [pSelectableRow]="f" [class.vt-detenido]="f.estado === 'detenido'" [attr.data-estado]="f.estado">
                      <td class="dt-id num" data-label="Documento">{{ f.doc.doc_tipo }} {{ f.doc.folio }}</td>
                      <td data-label="Beneficiario">{{ f.doc.beneficiario ?? '—' }}</td>
                      <td class="num" data-label="Fecha">{{ dmy(f.doc.fecha_valor) }}</td>
                      <td data-label="Lo respalda">
                        <p-tag [value]="f.etiqueta" [severity]="severidad(f)" styleClass="vt-tag" />
                        @if (f.motivo) {
                          <span class="vt-motivo">{{ f.motivo }}
                            @if (f.arreglo === 'aprobacion_gastos') { <a routerLink="/finanzas/aprobacion-gastos">Ir a Aprobación de gastos</a> }
                          </span>
                        }
                      </td>
                      <td class="ta-r num dt-num" data-label="Importe">{{ money(f.doc.monto) }}</td>
                      <td class="ta-r" data-label="Pagar">
                        <p-button size="small" severity="secondary" [outlined]="true" [label]="f.estado === 'firma' ? 'Pedir firma' : 'Pagar'"
                                  [disabled]="f.estado === 'detenido' || !puedePagar()" [ariaLabel]="(f.estado === 'firma' ? 'Pedir firma para ' : 'Pagar ') + f.doc.doc_tipo + ' ' + f.doc.folio"
                                  (onClick)="$event.stopPropagation(); abrir(f)" />
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
                <p class="vt-pie muted">
                  Pagos a proveedor (X-D-26) y anticipos (X-D-60) de la caja 0011, de la cola de Kepler.
                  @if (c.mal_fechados?.movimientos) {
                    {{ c.mal_fechados!.movimientos }} {{ c.mal_fechados!.movimientos === 1 ? 'documento viene fechado' : 'documentos vienen fechados' }}
                    después de hoy ({{ money(c.mal_fechados!.monto) }}): se corrigen en Kepler y aparecen solos.
                  }
                  @if (c.has_more) { <b data-testid="pagos-topada">La cola llega topada: se ven los primeros {{ c.limit }} de cada tipo, y las cifras de arriba suman sólo esos.</b> }
                </p>
              }
            </app-load-state>
          }

          @case ('recibir') {
            <!-- [LE.6.7] Lo que entra: los cobros de ruta y de sucursal. -->
            <app-load-state [loading]="cargandoCobros() && !colaCobros()" [error]="errorCobros()" [isEmpty]="!!colaCobros() && !cobros().length"
                            [skeletonRows]="3" errorTitle="No se pudo leer qué hay por recibir" emptyTitle="No hay cobros por recibir"
                            (retry)="cargar()">
              @if (colaCobros(); as cc) {
                <p-table [value]="cobros()" size="small" dataKey="doc.origen_ref" class="dt-stack vt-tbl" data-testid="cobros"
                         selectionMode="single" [metaKeySelection]="false" [selection]="null" (onRowSelect)="abrirCobroFila($event.data)">
                  <ng-template #header>
                    <tr>
                      <th scope="col">Cobro</th><th scope="col">De</th><th scope="col">Fecha</th>
                      <th scope="col" class="ta-r">Kepler espera</th><th scope="col"><span class="sr-only">Recibir</span></th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-f>
                    <tr [pSelectableRow]="f" [class.vt-detenido]="f.estado === 'detenido'" [attr.data-cobro]="f.estado">
                      <td class="dt-id num" data-label="Cobro">U-A-5 {{ f.doc.folio }}</td>
                      <td data-label="De">
                        <p-tag [value]="f.etiqueta" [severity]="f.estado === 'detenido' ? 'danger' : 'secondary'" styleClass="vt-tag" />
                        @if (f.motivo) { <span class="vt-motivo">{{ f.motivo }}</span> }
                      </td>
                      <td class="num" data-label="Fecha">{{ dmy(f.doc.fecha_valor) }}</td>
                      <td class="ta-r num dt-num" data-label="Kepler espera">{{ f.esperado === null ? '—' : money(f.esperado) }}</td>
                      <td class="ta-r" data-label="Recibir">
                        <p-button size="small" severity="secondary" [outlined]="true" label="Recibir"
                                  [disabled]="f.estado === 'detenido' || !puedePagar()" [ariaLabel]="'Recibir el cobro U-A-5 ' + f.doc.folio"
                                  (onClick)="$event.stopPropagation(); abrirCobro(f)" />
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
                <p class="vt-pie muted">
                  Los cobros U-A-5 de la caja 0011. Aquí se cuenta lo que se entrega en el cajón; lo que ya se depositó en la máquina lo registra la máquina.
                  @if (cobrosYaRecibidos()) { {{ cobrosYaRecibidos() }} ya {{ cobrosYaRecibidos() === 1 ? 'está recibido' : 'están recibidos' }} en el libro nuevo. }
                  @if (cc.has_more) { <b data-testid="cobros-topada">La cola llega topada: se ven los primeros {{ cc.limit }}, y la cifra de arriba suma sólo esos.</b> }
                </p>
              }
            </app-load-state>
          }

          @case ('suspenso') {
            <!-- [LE.6.7] Lo que la máquina hizo sin orden (V2): se explica en la fila. -->
            @if (errorSuspenso()) {
              <p class="vt-aviso vt-aviso--mal" role="alert" data-testid="suspenso-error">{{ errorSuspenso() }}</p>
            } @else if (suspenso(); as sp) {
              @if (sp.length) {
                <p-table [value]="sp" size="small" dataKey="event_ref" class="dt-stack vt-tbl" data-testid="suspenso"
                         selectionMode="single" [metaKeySelection]="false" [selection]="null" (onRowSelect)="abrirSuspensoFila($event.data)">
                  <ng-template #header>
                    <tr>
                      <th scope="col">Qué pasó</th><th scope="col">Lo que se tecleó</th><th scope="col">Usuario de la máquina</th>
                      <th scope="col">Cuándo</th><th scope="col" class="ta-r">Importe</th><th scope="col"><span class="sr-only">Explicar</span></th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-p>
                    <tr [pSelectableRow]="p" [attr.data-suspenso]="p.esta_en">
                      <td data-label="Qué pasó">{{ p.esta_en === 'haber' ? 'Entró sin decir de quién' : 'Salió sin orden' }}
                        <span class="vt-motivo">{{ p.movimiento ?? 'movimiento de la máquina' }}</span></td>
                      <td data-label="Lo que se tecleó">{{ p.texto || '(nada)' }}</td>
                      <td data-label="Usuario de la máquina">{{ p.usuario_maquina ?? '—' }}@if (p.persona) { <span class="vt-motivo">{{ p.persona }}</span> }</td>
                      <td class="num" data-label="Cuándo">{{ dmy(p.fecha) }}</td>
                      <td class="ta-r num dt-num" data-label="Importe">{{ minor(p.monto_minor) }}</td>
                      <td class="ta-r" data-label="Explicar">
                        <p-button size="small" severity="secondary" [outlined]="true" label="Explicar" [disabled]="!puedePagar()"
                                  [ariaLabel]="'Explicar el movimiento ' + p.event_ref" (onClick)="$event.stopPropagation(); abrirSuspenso(p)" />
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              } @else {
                <p class="vt-pie muted" data-testid="suspenso-vacio">Nada en Suspenso: todo lo que hizo la máquina está explicado.</p>
              }
            }
          }

          @case ('reposiciones') {
            <!-- [LE.6.8] La reposición (§5.5): una hoja por zona, un código. [LE.6.18] Firma Tesorería sólo si a un pago le falta su autorización (D27). -->
            <div data-testid="reposiciones">
              @if (errorReposiciones()) {
                <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorReposiciones() }}</p>
              } @else if (reposiciones(); as hs) {
                @if (hs[0]?.sin_arranque) {
                  <p class="vt-pie muted" data-testid="reposicion-sin-arranque">El libro nuevo no ha abierto: la hoja de cada zona empieza con la apertura.</p>
                } @else {
                  <p-table [value]="hs" size="small" dataKey="zona" class="dt-stack vt-tbl"
                           selectionMode="single" [metaKeySelection]="false" [selection]="null"
                           (onRowSelect)="abrirReposicionFila($event.data)">
                    <ng-template #header>
                      <tr>
                        <th scope="col">Zona</th><th scope="col" class="ta-r">Pagos</th><th scope="col" class="ta-r">Total</th>
                        <th scope="col">No se reponen</th><th scope="col"><span class="sr-only">Pedir</span></th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-h>
                      <tr [pSelectableRow]="h" [attr.data-zona]="h.zona">
                        <td data-label="Zona">{{ h.nombre }}
                          @if (h.anteriores.n) { <span class="vt-motivo">{{ h.anteriores.n }} de antes de la apertura: los reconstruye la historia, no esta hoja.</span> }
                          @if (h.detenidos.length) {
                            <span class="vt-motivo" data-testid="reposicion-detenidos">{{ h.detenidos.length === 1 ? '1 pago espera' : h.detenidos.length + ' pagos esperan' }} su aprobación: no entran hasta aprobarse.
                              <a routerLink="/finanzas/aprobacion-gastos" (click)="$event.stopPropagation()">Ir a Aprobación de gastos</a></span>
                          }
                        </td>
                        <td class="ta-r num" data-label="Pagos">{{ h.renglones.length }}</td>
                        <td class="ta-r num dt-num" data-label="Total">{{ minor(h.total_minor) }}</td>
                        <td data-label="No se reponen">{{ h.fuera.length ? h.fuera.length + ' (nómina, apoyos, compras o comisiones)' : '—' }}</td>
                        <td class="ta-r" data-label="Pedir">
                          <p-button size="small" severity="secondary" [outlined]="true" label="Pedir la reposición"
                                    [disabled]="!h.renglones.length || !puedePagar()" [ariaLabel]="'Pedir la reposición de ' + h.nombre"
                                    (onClick)="$event.stopPropagation(); abrirReposicion(h)" />
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                }
              }
            </div>
          }

          @case ('custodias') {
            <!-- [LE.6.5] Custodias (V6): el dinero que tiene una persona para algo sin documento todavía, con su antigüedad. -->
            <div data-testid="custodias">
              @if (errorCustodias()) {
                <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorCustodias() }}</p>
              } @else if (custodias(); as cs) {
                @if (!cs.length) {
                  <p class="vt-pie muted" data-testid="custodias-vacio">Nadie tiene dinero a su cargo.</p>
                } @else {
                  <p-table [value]="cs" size="small" dataKey="persona" class="dt-stack vt-tbl"
                           selectionMode="single" [metaKeySelection]="false" [selection]="null" (onRowSelect)="abrirRendirFila($event.data)">
                    <ng-template #header>
                      <tr><th scope="col">Persona</th><th scope="col">Desde</th><th scope="col" class="ta-r">A su cargo</th><th scope="col"><span class="sr-only">Rendir</span></th></tr>
                    </ng-template>
                    <ng-template #body let-c>
                      <tr [pSelectableRow]="c" [attr.data-persona]="c.persona">
                        <td data-label="Persona">{{ c.nombre }}
                          @for (r of c.reposiciones; track r.orden_id) {
                            <span class="vt-motivo">Reposición {{ r.zona }} del {{ dmy(r.dia) }} · {{ minor(r.total_minor) }} · espera su depósito en el banco
                              <p-button size="small" [text]="true" label="Confirmar el depósito" [disabled]="!puedePagar()"
                                        [ariaLabel]="'Confirmar el depósito de la reposición ' + r.zona" (onClick)="$event.stopPropagation(); confirmarDeposito(r.orden_id)" />
                            </span>
                          }
                        </td>
                        <td class="num" data-label="Desde">{{ c.desde ? dmy(c.desde) : '—' }}</td>
                        <td class="ta-r num dt-num" data-label="A su cargo">{{ minor(c.saldo_minor) }}</td>
                        <td class="ta-r" data-label="Rendir">
                          <p-button size="small" severity="secondary" [outlined]="true" label="Rendir" [disabled]="!puedePagar()"
                                    [ariaLabel]="'Rendir la custodia de ' + c.nombre" (onClick)="$event.stopPropagation(); abrirRendir(c)" />
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                }
                @if (avisoCustodia()) { <p class="vt-aviso" role="status" data-testid="aviso-custodia">{{ avisoCustodia() }}</p> }
              }
            </div>
          }
        }
      </div>
    </div>

    <!-- [LE.6.34] Cada ventana: con algo capturado, mientras se envía o con el resultado en pantalla, no se cierra sola
         (ni X ni Esc). Lo capturado se descarta preguntando (app-descartar-cambios); el resultado se cierra con «Listo». -->
    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="otroAbierto()" (visibleChange)="!$event && cerrarOtro()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioOtro(), enviandoOtro(), !!resultadoOtro())" [closeOnEscape]="libre(sucioOtro(), enviandoOtro(), !!resultadoOtro())"
              [style]="{ width: '36rem' }" header="Otro ingreso">
      @if (resultadoOtro(); as r) {
        <p class="vt-resultado" role="status" data-testid="resultado-otro">
          {{ r.estado === 'asentado' ? 'Listo: ya está en el libro.' : 'Pasa el umbral: espera la firma de otra persona.' }}
        </p>
      } @else {
        <p class="muted">Dinero que entra sin un cobro de Kepler (una venta de desecho, una devolución). Se cuenta por pieza y se dice de qué es.</p>
        <label class="vt-lbl" for="vt-concepto">De qué es</label>
        <input pInputText id="vt-concepto" class="vt-in" [ngModel]="conceptoOtro()" (ngModelChange)="conceptoOtro.set($event)" autocomplete="off" />
        <app-conteo-cajon sentido="entra" [total]="0" [(piezas)]="piezasOtro" [conMorralla]="false" />
        @if (errorOtro()) { <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorOtro() }}</p> }
      }
      <ng-template #footer>
        @if (resultadoOtro()) {
          <p-button label="Listo" data-listo (onClick)="cerrarOtro()" />
        } @else {
          <app-descartar-cambios [sucio]="sucioOtro()" [bloqueado]="enviandoOtro()" (cerrar)="cerrarOtro()" />
          <p-button label="Recibir" [disabled]="!listoParaOtro()" [loading]="enviandoOtro()" (onClick)="recibirOtro()" />
        }
      </ng-template>
    </p-dialog>

    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="nuevaCustodia()" (visibleChange)="!$event && cerrarNuevaCustodia()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioCustodia(), enviandoCustodia(), !!resultadoCustodia())" [closeOnEscape]="libre(sucioCustodia(), enviandoCustodia(), !!resultadoCustodia())"
              [style]="{ width: '36rem' }" header="Sacar dinero a la custodia de una persona">
      @if (resultadoCustodia(); as r) {
        <p class="vt-resultado" role="status" data-testid="resultado-custodia">
          @if (r.estado === 'pagado' && r.codigo) { Teclea en la máquina este código: <b class="vt-codigo">{{ r.codigo }}</b> }
          @else if (r.estado === 'por_firmar') { Quedó por firmar: {{ r.motivo }}. }
          @else if (r.estado === 'asentado') { Listo: el dinero del cajón ya está a su cargo. }
          @else if (r.estado === 'por_autorizar') { Pasa el umbral: espera la firma de otra persona. }
        </p>
      } @else {
        <label class="vt-lbl" for="vt-persona">Quién se lo lleva</label>
        <input pInputText id="vt-persona" class="vt-in" [ngModel]="buscaPersona()" (ngModelChange)="buscarPersona($event)" placeholder="Nombre o usuario" autocomplete="off" />
        @if (personasHalladas().length) {
          <fieldset class="vt-destinos">
            <legend class="sr-only">Elige a la persona</legend>
            @for (p of personasHalladas(); track p.usuario_id) {
              <label class="vt-destino"><input type="radio" name="vt-persona" [checked]="personaCustodia() === p.usuario_id" (change)="personaCustodia.set(p.usuario_id)" /> {{ p.nombre }}</label>
            }
          </fieldset>
        }
        <label class="vt-lbl" for="vt-para">Para qué</label>
        <input pInputText id="vt-para" class="vt-in" [ngModel]="paraCustodia()" (ngModelChange)="paraCustodia.set($event)" placeholder="Para qué se lleva el dinero" autocomplete="off" />
        <fieldset class="vt-destinos">
          <legend class="vt-lbl">De dónde sale</legend>
          <label class="vt-destino"><input type="radio" name="vt-de" [checked]="desdeCustodia() === 'maquina'" (change)="desdeCustodia.set('maquina')" />
            De la máquina (billetes), por <input pInputText class="vt-ruta" inputmode="numeric" aria-label="Pesos" [ngModel]="montoCustodia()" (ngModelChange)="montoCustodia.set($event)" placeholder="pesos" /></label>
          <label class="vt-destino"><input type="radio" name="vt-de" [checked]="desdeCustodia() === 'cajon'" (change)="desdeCustodia.set('cajon')" /> Del cajón (monedas, por pieza)</label>
        </fieldset>
        @if (desdeCustodia() === 'cajon') {
          <app-conteo-cajon sentido="entra" [total]="0" [(piezas)]="piezasCustodia" [conBilletes]="false" [conMorralla]="false" />
        }
        @if (errorCustodia()) { <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorCustodia() }}</p> }
      }
      <ng-template #footer>
        @if (resultadoCustodia()) {
          <p-button label="Listo" data-listo (onClick)="cerrarNuevaCustodia()" />
        } @else {
          <app-descartar-cambios [sucio]="sucioCustodia()" [bloqueado]="enviandoCustodia()" texto="Se pierde lo que capturaste." textoSeguir="Seguir capturando"
                                 (cerrar)="cerrarNuevaCustodia()" />
          <p-button label="Sacar" [disabled]="!listoParaCustodia()" [loading]="enviandoCustodia()" (onClick)="sacarACustodia()" />
        }
      </ng-template>
    </p-dialog>

    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="!!rindiendo()" (visibleChange)="!$event && cerrarRendir()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioRendir(), enviandoRendir(), !!resultadoRendir())" [closeOnEscape]="libre(sucioRendir(), enviandoRendir(), !!resultadoRendir())"
              [style]="{ width: '38rem' }" [header]="rindiendo() ? 'Rendir · ' + rindiendo()!.nombre : ''">
      @if (rindiendo(); as c) {
        <p class="vt-quien">Tiene a su cargo <b class="num">{{ minor(c.saldo_minor) }}</b></p>
        @if (resultadoRendir(); as r) {
          <p class="vt-resultado" role="status" data-testid="resultado-rendir">Rendido. Le queda a su cargo <b class="num">{{ minor(r.saldo_minor) }}</b>.</p>
        } @else {
          <fieldset class="vt-destinos">
            <legend class="vt-lbl">Los documentos de Kepler que pagó con ese dinero</legend>
            @for (f of docsParaRendir(); track f.doc.origen_ref) {
              <label class="vt-destino"><input type="checkbox" [checked]="docsRendir().includes(f.doc.origen_ref)" (change)="alternarDoc(f.doc.origen_ref)" />
                X-D-26 {{ f.doc.folio }} · {{ f.doc.beneficiario ?? '—' }} · {{ money(f.doc.monto) }}</label>
            } @empty {
              <p class="muted">No hay X-D-26 de Caja General por pagar con su cuenta de Kepler.</p>
            }
          </fieldset>
          <p class="vt-lbl">Lo que regresa al cajón</p>
          <app-conteo-cajon sentido="entra" [total]="0" [(piezas)]="piezasRegresa" [conMorralla]="false" />
          @if (errorRendir()) { <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorRendir() }}</p> }
        }
      }
      <ng-template #footer>
        @if (resultadoRendir()) {
          <p-button label="Listo" data-listo (onClick)="cerrarRendir()" />
        } @else {
          <app-descartar-cambios [sucio]="sucioRendir()" [bloqueado]="enviandoRendir()" texto="Se pierde lo que marcaste y contaste." (cerrar)="cerrarRendir()" />
          <p-button label="Rendir" [disabled]="!listoParaRendir()" [loading]="enviandoRendir()" (onClick)="rendirCustodia()" />
        }
      </ng-template>
    </p-dialog>

    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="!!reponiendo()" (visibleChange)="!$event && cerrarReposicion()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioReposicion(), enviandoReposicion(), !!resultadoReposicion())" [closeOnEscape]="libre(sucioReposicion(), enviandoReposicion(), !!resultadoReposicion())"
              [style]="{ width: '42rem' }" [header]="reponiendo() ? 'Reposición · ' + reponiendo()!.nombre : ''">
      @if (reponiendo(); as h) {
        <p class="vt-quien">{{ h.renglones.length }} pagos · <b class="num">{{ minor(h.total_minor) }}</b></p>
        @if (resultadoReposicion(); as r) {
          <p class="vt-resultado" role="status" data-testid="resultado-reposicion">
            @if (r.estado === 'por_firmar') {
              Quedó por firmar: {{ r.motivo }}. Al firmar sale el código para la máquina.
            } @else {
              El código es <b class="vt-codigo">{{ r.codigo }}</b>.
            }
          </p>
        } @else {
          @if (h.motivo_firma) {
            <p class="vt-aviso" role="status" data-testid="reposicion-firma">{{ h.motivo_firma }}. Al pedirla queda por firmar y no sale un peso hasta la firma.</p>
          } @else {
            <p class="vt-respalda muted" data-testid="reposicion-sin-firma">Cada pago trae su autorización (la compra o el gasto aprobado): al pedirla sale el código.</p>
          }
          <dl class="vt-plan">
            <div><dt>La máquina entrega</dt><dd class="num">{{ minor(h.maquina_minor) }}</dd></div>
            <div><dt>Del cajón, en monedas</dt><dd class="num">{{ minor(h.cajon_minor) }}</dd></div>
          </dl>
          <details class="vt-renglones">
            <summary>Los {{ h.renglones.length }} pagos que repone</summary>
            <ul>
              @for (p of h.renglones; track p.origen_ref) {
                <li class="num">X-D-26 {{ p.folio }} · {{ p.beneficiario ?? '—' }} · {{ minor(p.importe_minor) }}</li>
              }
            </ul>
          </details>
          @if (h.detenidos.length) {
            <details class="vt-renglones" data-testid="reposicion-detenidos-lista">
              <summary>{{ h.detenidos.length }} {{ h.detenidos.length === 1 ? 'pago espera' : 'pagos esperan' }} y no entran</summary>
              <ul>
                @for (p of h.detenidos; track p.origen_ref) {
                  <li class="num">X-D-26 {{ p.folio }} · {{ p.beneficiario ?? '—' }} · {{ minor(p.importe_minor) }} · {{ p.motivo }}</li>
                }
              </ul>
              <a routerLink="/finanzas/aprobacion-gastos">Ir a Aprobación de gastos</a>
            </details>
          }
          @if (cajonReposicion() > 0) {
            <app-conteo-cajon [total]="cajonReposicion()" [(piezas)]="piezasReposicion" [conBilletes]="false" [conMorralla]="false" />
          }
          @if (errorQuienLleva()) {
            <!-- [LE.6.32] Una lectura fallida NO es «falta nombrar»: mandaría a configurar lo que quizá ya está. -->
            <p class="vt-aviso vt-aviso--mal" role="alert" data-testid="quien-lleva-error">{{ errorQuienLleva() }}</p>
          } @else if (quienLleva().length) {
            <fieldset class="vt-destinos">
              <legend class="vt-lbl">Quién lleva el depósito al banco</legend>
              @for (q of quienLleva(); track q.usuario_id) {
                <label class="vt-destino"><input type="radio" name="vt-lleva" [checked]="lleva() === q.usuario_id" (change)="lleva.set(q.usuario_id)" />
                  {{ q.nombre }}</label>
              }
            </fieldset>
            <p class="vt-respalda muted">El dinero queda a su nombre hasta que el banco confirma el depósito.</p>
          } @else {
            <p class="vt-aviso" role="status" data-testid="sin-quien-lleva">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Falta nombrar quién lleva el depósito: se da como responsabilidad en Administración › Responsabilidades (D35).
            </p>
          }
          @if (errorReposicion()) { <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorReposicion() }}</p> }
        }
      }
      <ng-template #footer>
        @if (resultadoReposicion()) {
          <p-button label="Listo" data-listo (onClick)="cerrarReposicion()" />
        } @else {
          <app-descartar-cambios [sucio]="sucioReposicion()" [bloqueado]="enviandoReposicion()" (cerrar)="cerrarReposicion()" />
          <p-button [label]="reponiendo()?.motivo_firma ? 'Pedir la firma' : 'Sacar el código'" [disabled]="!listoParaReponer()" [loading]="enviandoReposicion()" (onClick)="pedirReposicion()" />
        }
      </ng-template>
    </p-dialog>

    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="!!recibiendo()" (visibleChange)="!$event && cerrarCobro()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioCobro(), enviandoCobro(), !!resultadoCobro())" [closeOnEscape]="libre(sucioCobro(), enviandoCobro(), !!resultadoCobro())"
              [style]="{ width: '40rem' }" [header]="recibiendo() ? 'Recibir el cobro U-A-5 ' + recibiendo()!.doc.folio : ''">
      @if (recibiendo(); as f) {
        <p class="vt-quien">{{ f.etiqueta }} · Kepler espera <b class="num">{{ f.esperado === null ? '—' : money(f.esperado) }}</b></p>
        @if (resultadoCobro(); as r) {
          <div class="vt-resultado" role="status" data-testid="resultado-cobro">
            @if (r.estado === 'recibido') {
              <p>Recibido: <b class="num">{{ minor(r.contado_minor) }}</b> entraron al cajón y ya están en el libro.</p>
            } @else {
              <p>El dinero ya está en el cajón; el registro pasa el umbral y espera la firma de otra persona.</p>
            }
            <p>{{ diferenciaDe(r.contado_minor, r.esperado_minor, r.ruta) }}</p>
          </div>
        } @else if (modoCobro() === null) {
          <!-- Medido 2026-11-04: 66 de 102 cobros de ruta de 14 días entraron por la máquina. Contarlos aquí sería contarlos dos veces. -->
          <p>¿Cómo llegó este dinero?</p>
          <div class="vt-opciones">
            <p-button label="Me lo entregan en el cajón" (onClick)="modoCobro.set('cajon')" />
            <p-button label="Ya se depositó en la máquina" severity="secondary" [outlined]="true" (onClick)="modoCobro.set('maquina')" />
          </div>
        } @else if (modoCobro() === 'maquina') {
          <p class="vt-aviso" role="status" data-testid="cobro-maquina">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            Lo que entra a la máquina lo registra la máquina: no se cuenta aquí. Si el depósito dice la ruta, queda ligado solo; si no la dice,
            queda en la cola Suspenso y se liga desde ahí con «Explicar».
          </p>
        } @else {
          <app-conteo-cajon sentido="entra" [total]="f.esperado ?? 0" [(piezas)]="piezasCobro" [conMorralla]="false" />
          @if (hayContado() && f.esperado !== null) {
            <p class="vt-respalda" data-testid="diferencia-cobro">{{ diferenciaDe(contadoCobro().toString(), esperadoMinor(f), f.ruta) }}</p>
          }
          <label class="vt-lbl" for="vt-entrega">Quién entrega el dinero</label>
          <input pInputText id="vt-entrega" class="vt-in" [ngModel]="entrega()" (ngModelChange)="entrega.set($event)"
                 placeholder="Nombre de quien entrega" autocomplete="off" />
          @if (errorCobro()) { <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorCobro() }}</p> }
        }
      }
      <ng-template #footer>
        @if (resultadoCobro()) {
          <p-button label="Listo" data-listo (onClick)="cerrarCobro()" />
        } @else {
          <app-descartar-cambios [etiqueta]="modoCobro() === 'maquina' ? 'Cerrar' : 'Cancelar'" [sucio]="sucioCobro()" [bloqueado]="enviandoCobro()" (cerrar)="cerrarCobro()" />
          @if (modoCobro() === 'cajon') {
            <p-button label="Recibir" [disabled]="!listoParaRecibir()" [loading]="enviandoCobro()" (onClick)="recibir()" />
          }
        }
      </ng-template>
    </p-dialog>

    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="!!explicando()" (visibleChange)="!$event && cerrarSuspenso()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioSuspenso(), enviandoSuspenso(), !!resultadoSuspenso())" [closeOnEscape]="libre(sucioSuspenso(), enviandoSuspenso(), !!resultadoSuspenso())"
              [style]="{ width: '34rem' }" header="Explicar un movimiento de la máquina">
      @if (explicando(); as p) {
        <p class="vt-quien">{{ p.esta_en === 'haber' ? 'Entraron' : 'Salieron' }} <b class="num">{{ minor(p.monto_minor) }}</b>
          · {{ p.movimiento ?? 'movimiento' }} · «{{ p.texto || 'sin texto' }}» · usuario {{ p.usuario_maquina ?? '—' }}</p>
        @if (resultadoSuspenso(); as r) {
          <p class="vt-resultado" role="status" data-testid="resultado-suspenso">
            {{ r.estado === 'asentado' ? 'Explicado: ya salió de Suspenso.' : 'Pasa el umbral: la explicación espera la firma de otra persona.' }}
          </p>
        } @else {
          <fieldset class="vt-destinos">
            <legend class="vt-lbl">{{ p.esta_en === 'haber' ? '¿De quién era este dinero?' : '¿A dónde fue este dinero?' }}</legend>
            @if (p.esta_en === 'haber') {
              <label class="vt-destino"><input type="radio" name="vt-dest" [checked]="destino() === 'ruta'" (change)="destino.set('ruta')" />
                De la ruta <input pInputText class="vt-ruta" [ngModel]="rutaSuspenso()" (ngModelChange)="rutaSuspenso.set($event)"
                                  inputmode="numeric" aria-label="Número de ruta" placeholder="número" /></label>
              <label class="vt-destino"><input type="radio" name="vt-dest" [checked]="destino() === 'cajon'" (change)="destino.set('cajon')" />
                Venía del cajón (se depositó lo de la ventanilla)</label>
            } @else {
              <label class="vt-destino"><input type="radio" name="vt-dest" [checked]="destino() === 'cajon'" (change)="destino.set('cajon')" />
                Fue al cajón</label>
              <label class="vt-destino"><input type="radio" name="vt-dest" [checked]="destino() === 'transito'" (change)="destino.set('transito')" />
                Se fue al banco</label>
            }
          </fieldset>
          <p class="vt-respalda muted">Si se lo llevó una persona para algo que todavía no tiene documento, va a su custodia: eso todavía no se puede explicar desde esta ventana.</p>
          @if (errorExplicar()) { <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorExplicar() }}</p> }
        }
      }
      <ng-template #footer>
        @if (resultadoSuspenso()) {
          <p-button label="Listo" data-listo (onClick)="cerrarSuspenso()" />
        } @else {
          <app-descartar-cambios [sucio]="sucioSuspenso()" [bloqueado]="enviandoSuspenso()" texto="Se pierde lo que elegiste." textoSeguir="Seguir" (cerrar)="cerrarSuspenso()" />
          <p-button label="Explicar" [disabled]="!listoParaExplicar()" [loading]="enviandoSuspenso()" (onClick)="explicar()" />
        }
      </ng-template>
    </p-dialog>

    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="!!pagando()" (visibleChange)="!$event && cerrar()" [modal]="true" [draggable]="false"
              [closable]="libre(sucioPago(), enviando(), !!resultado())" [closeOnEscape]="libre(sucioPago(), enviando(), !!resultado())"
              [style]="{ width: '36rem' }" [header]="pagando() ? 'Pagar ' + pagando()!.doc.doc_tipo + ' ' + pagando()!.doc.folio : ''">
      @if (pagando(); as f) {
        <p class="vt-quien">{{ f.doc.beneficiario ?? '—' }} · <b class="num">{{ money(f.doc.monto) }}</b></p>
        <p class="vt-respalda muted" data-testid="lo-respalda">{{ loRespalda(f) }}</p>

        @if (resultado(); as r) {
          <div class="vt-resultado" role="status" data-testid="resultado">
            @if (r.estado === 'pagado') {
              @if (r.codigo) {
                <p>Teclea en la máquina este código; entrega <b class="num">{{ minor(r.maquina_minor) }}</b>:</p>
                <p class="vt-codigo" data-testid="codigo">{{ r.codigo }}</p>
                <p class="muted">Vale hasta el fin del día.</p>
              } @else {
                <p>Todo salió del cajón: no hay código que teclear.</p>
              }
              @if (r.cajon_minor !== '0') { <p>Del cajón salieron <b class="num">{{ minor(r.cajon_minor) }}</b>, ya registrados.</p> }
            } @else {
              <p>Quedó por firmar: {{ r.motivo }}. Tesorería la firma desde su teléfono y entonces sale el código.</p>
            }
          </div>
        } @else if (plan(); as p) {
          <dl class="vt-plan">
            <div><dt>La máquina entrega</dt><dd class="num">{{ minor(p.maquina_minor) }}</dd></div>
            <div><dt>Del cajón, en monedas</dt><dd class="num">{{ minor(p.cajon_minor) }}</dd></div>
            @if (p.redondeo_minor !== '0') {
              <div><dt>Redondeo al medio peso, declarado</dt><dd class="num">{{ minor(p.redondeo_minor) }}</dd></div>
            }
          </dl>
          @if (p.bloqueo) {
            <p class="vt-aviso vt-aviso--mal" role="alert">{{ p.motivo_bloqueo }}</p>
          } @else {
            @if (p.requiere_firma) {
              <p class="vt-aviso" role="status">{{ p.motivo_firma }}: al pedirlo queda por firmar y no sale un peso hasta que Tesorería firme.</p>
            }
            @if (cajon() > 0) {
              <app-conteo-cajon [total]="cajon()" [(piezas)]="piezas" [conBilletes]="false" [conMorralla]="false" />
            }
            <label class="vt-lbl" for="vt-recibe">Quién recibe el dinero</label>
            <input pInputText id="vt-recibe" class="vt-in" [ngModel]="recibe()" (ngModelChange)="recibe.set($event)"
                   placeholder="Nombre de quien recibe" autocomplete="off" />
          }
        } @else if (errorPago()) {
          <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorPago() }}</p>
        } @else {
          <p class="muted">Leyendo el documento…</p>
        }
        @if (resultado() === null && errorPago() && plan()) {
          <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorPago() }}</p>
        }
      }
      <ng-template #footer>
        @if (resultado()) {
          <p-button label="Listo" data-listo (onClick)="cerrar()" />
        } @else {
          <app-descartar-cambios [sucio]="sucioPago()" [bloqueado]="enviando()" (cerrar)="cerrar()" />
          <p-button [label]="plan()?.requiere_firma ? 'Pedir la firma' : 'Pagar'" [disabled]="!listoParaPagar()" [loading]="enviando()"
                    (onClick)="pagar()" />
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .vt { gap: var(--sp-2); padding-bottom: 0; min-height: 0; }
    .vt-barra { display: flex; align-items: center; gap: var(--sp-2) var(--sp-4); flex-wrap: wrap; }
    .vt-h1 { margin: 0; font-size: var(--fs-lg, 1.25rem); font-weight: 700; }
    .vt-dia { flex: 1; min-width: 0; }
    .vt-acciones { display: flex; align-items: center; gap: var(--sp-2); }
    .vt-chip { display: inline-flex; gap: var(--sp-1); align-items: center; padding: 2px var(--sp-2); border-radius: var(--r-sm, 8px);
      background: var(--warn-soft-bg); color: var(--text-main); font-size: var(--fs-xs); }
    .vt-chip .pi { color: var(--warn-fg); }
    .vt-chip--mal { background: var(--bad-soft-bg, var(--warn-soft-bg)); }
    .vt-chip--codigo { background: var(--surface-2, var(--card-bg)); border: 1px solid var(--border-color); }
    .vt-codigo-chico { font-family: var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; }
    .vt-vista { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .vt-atajo { flex: 1; font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .vt-atajo kbd { font-family: var(--font-mono); font-size: var(--fs-xs); padding: 0 4px; margin: 0 1px; border: 1px solid var(--border-color);
      border-radius: 4px; background: var(--card-bg); }
    .vt-cola { flex: 1; min-height: 0; overflow: auto; }
    .vt-cola tr:focus-visible { outline: 2px solid var(--focus-ring, var(--action)); outline-offset: -2px; }
    .vt-cola .vt-tbl { margin-top: 0; }
    .vt-cola thead th { position: sticky; top: 0; z-index: 1; background: var(--surface-1, var(--bg)); }
    .vt-aviso { display: flex; gap: var(--sp-2); align-items: baseline; margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-sm, 8px); background: var(--warn-soft-bg); color: var(--text-main); font-size: var(--fs-sm); }
    .vt-aviso .pi { color: var(--warn-fg); }
    .vt-aviso--mal { background: var(--bad-soft-bg, var(--warn-soft-bg)); }
    .vt-tbl { margin-top: var(--sp-3); }
    .vt-motivo { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .vt-motivo a { color: var(--text-main); text-decoration: underline; text-underline-offset: 2px; }
    .vt-pie { margin-top: var(--sp-3); font-size: var(--fs-xs); }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ta-r { text-align: right; }
    .vt-quien { margin: 0 0 var(--sp-1); }
    .vt-respalda { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
    .vt-plan { display: grid; gap: var(--sp-1); margin: 0 0 var(--sp-3); }
    .vt-plan div { display: flex; justify-content: space-between; gap: var(--sp-3); }
    .vt-plan dt { color: var(--text-muted); } .vt-plan dd { margin: 0; font-weight: 600; }
    .vt-lbl { display: block; margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); }
    .vt-in { width: 100%; }
    .vt-codigo { font: 600 1.75rem/1.2 var(--font-mono, ui-monospace, monospace); letter-spacing: .08em; margin: var(--sp-2) 0; }
    .vt-resultado p { margin: 0 0 var(--sp-2); }
    .vt-opciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-2); }
    .vt-destinos { border: 0; margin: 0 0 var(--sp-2); padding: 0; display: grid; gap: var(--sp-2); }
    .vt-destino { display: flex; gap: var(--sp-2); align-items: center; font-size: var(--fs-sm); }
    .vt-ruta { width: 6rem; }
    .vt-renglones { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
    .vt-renglones ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-4); max-height: 12rem; overflow: auto; }
  `],
})
export class FinanzasCajaVentanillaComponent implements OnInit, AfterViewInit {
  private readonly marco = viewChild<ElementRef<HTMLElement>>('marco');
  private readonly colaEl = viewChild<ElementRef<HTMLElement>>('colaEl');
  /** El alto que deja la pantalla debajo de la barra de la app: la página no se desplaza, sólo la cola. */
  readonly alto = signal<number | null>(null);
  /** Qué cola se ve. Abre en lo que más se hace: pagar. */
  readonly vista = signal<'pagar' | 'recibir' | 'suspenso' | 'reposiciones' | 'custodias'>('pagar');
  /** Cada cola con su conteo; sin medir no se dibuja un cero (`undefined`, ADR-056). */
  readonly vistas = computed<SegOption[]>(() => [
    // [LE.6.32] Topada, el conteo no es el universo: dice «200+», no «200». Una lectura fallida no tiene conteo.
    this.opcionConConteo('Por pagar', 'pagar', this.cola(), this.filas().length, false),
    this.opcionConConteo('Por recibir', 'recibir', this.colaCobros(), this.cobros().length, !!this.errorCobros()),
    { label: 'Suspenso', value: 'suspenso', count: this.suspenso()?.length },
    { label: 'Reposiciones', value: 'reposiciones', count: this.reposiciones()?.filter((h) => h.renglones.length).length },
    { label: 'Custodias', value: 'custodias', count: this.custodias()?.length },
  ]);
  private readonly ledger = inject(CashLedgerService);
  private readonly libroApi = inject(LibroEfectivoService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly money = money;
  readonly dmy = dmy;
  readonly minor = (m: string | null | undefined): string => money(Number(m ?? 0) / 100);

  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cola = signal<PendientesResponse | null>(null);
  readonly filas = signal<FilaVentanilla[]>([]);
  readonly libro = signal<EstadoLibro>('sin_medir');

  readonly pagando = signal<FilaVentanilla | null>(null);
  readonly plan = signal<PlanDePagoVentanilla | null>(null);
  readonly piezas = signal<Record<string, number>>({});
  readonly recibe = signal('');
  readonly enviando = signal(false);
  readonly errorPago = signal<string | null>(null);
  readonly resultado = signal<ResultadoPago | null>(null);
  /** Una llave por intento: un doble clic o un reintento no paga dos veces. */
  private llave = '';

  // ── `[LE.6.34]` Auditoría 2026-11-18: ninguna ventana tira lo contado ni el código sin preguntar ─────────
  private readonly injector = inject(Injector);
  /** El último código para la máquina entregado en esta sesión: si alguien cierra la ventana, aquí sigue. */
  readonly ultimoCodigo = signal<{ codigo: string; de: string } | null>(null);
  private readonly hay = (p: Record<string, number>): boolean => Object.values(p).some((n) => Number(n) > 0);
  /** Una ventana se cierra sola (X, Esc) sólo si no hay nada que perder: sin captura, sin envío en curso y sin resultado. */
  libre(sucio: boolean, enviando: boolean, hecho: boolean): boolean { return !sucio && !enviando && !hecho; }
  readonly sucioPago = computed(() => !this.resultado() && (this.hay(this.piezas()) || !!this.recibe().trim()));
  readonly sucioOtro = computed(() => !this.resultadoOtro() && (this.hay(this.piezasOtro()) || !!this.conceptoOtro().trim()));
  readonly sucioCustodia = computed(() => !this.resultadoCustodia() && (this.hay(this.piezasCustodia()) || !!this.personaCustodia()
    || !!this.buscaPersona().trim() || !!this.paraCustodia().trim() || !!this.montoCustodia().trim() || this.desdeCustodia() !== null));
  readonly sucioRendir = computed(() => !this.resultadoRendir() && (this.hay(this.piezasRegresa()) || this.docsRendir().length > 0));
  /** Quien lleva el depósito sólo cuenta como captura si hubo que elegirlo (con una sola persona viene puesto). */
  readonly sucioReposicion = computed(() => !this.resultadoReposicion() && (this.hay(this.piezasReposicion())
    || (this.quienLleva().length > 1 && !!this.lleva())));
  readonly sucioCobro = computed(() => !this.resultadoCobro() && (this.hay(this.piezasCobro()) || !!this.entrega().trim()));
  readonly sucioSuspenso = computed(() => !this.resultadoSuspenso() && (this.destino() !== null || !!this.rutaSuspenso().trim()));

  /** Al aparecer el resultado, el foco va a «Listo» (la única salida de la ventana). */
  private alListo(): void {
    afterNextRender(() => document.querySelector<HTMLElement>('p-button[data-listo] button')?.focus(), { injector: this.injector });
  }

  /** Lo que tiene código queda anotado en la barra («Último código»). */
  private anotarCodigo(r: ResultadoPago | ResultadoHecho, de: string): void {
    if (r.estado === 'pagado' && r.codigo) this.ultimoCodigo.set({ codigo: r.codigo, de });
  }

  // `[LE.6.7]` Otro ingreso (E-23).
  readonly otroAbierto = signal(false);
  readonly conceptoOtro = signal('');
  readonly piezasOtro = signal<Record<string, number>>({});
  readonly enviandoOtro = signal(false);
  readonly errorOtro = signal<string | null>(null);
  readonly resultadoOtro = signal<ResultadoHecho | null>(null);
  private llaveOtro = '';
  readonly listoParaOtro = computed(() => this.puedePagar() && !this.enviandoOtro() && this.conceptoOtro().trim().length >= 5
    && valorDePiezas(Object.fromEntries(Object.entries(this.piezasOtro()).filter(([, n]) => Number(n) > 0)), 'MXN') > 0n);

  // `[LE.6.5]` Custodias.
  readonly custodias = signal<CustodiaAbierta[] | null>(null);
  readonly errorCustodias = signal<string | null>(null);
  readonly avisoCustodia = signal<string | null>(null);
  readonly nuevaCustodia = signal(false);
  readonly buscaPersona = signal('');
  readonly personasHalladas = signal<PersonaDeCustodia[]>([]);
  readonly personaCustodia = signal<string | null>(null);
  readonly paraCustodia = signal('');
  readonly desdeCustodia = signal<'maquina' | 'cajon' | null>(null);
  readonly montoCustodia = signal('');
  readonly piezasCustodia = signal<Record<string, number>>({});
  readonly enviandoCustodia = signal(false);
  readonly errorCustodia = signal<string | null>(null);
  readonly resultadoCustodia = signal<ResultadoPago | ResultadoHecho | null>(null);
  private llaveCustodia = '';
  readonly rindiendo = signal<CustodiaAbierta | null>(null);
  readonly docsRendir = signal<string[]>([]);
  readonly piezasRegresa = signal<Record<string, number>>({});
  readonly enviandoRendir = signal(false);
  readonly errorRendir = signal<string | null>(null);
  readonly resultadoRendir = signal<ResultadoRendicion | null>(null);
  private llaveRendir = '';
  /** Los X-D-26 de la cola que se pueden rendir: con su cuenta de Kepler. */
  readonly docsParaRendir = computed(() => this.filas().filter((f) => !!f.doc.kepler_cuenta));
  private readonly piezasDe = (p: Record<string, number>) => Object.fromEntries(Object.entries(p).filter(([, n]) => Number(n) > 0));
  readonly listoParaCustodia = computed(() => {
    if (!this.personaCustodia() || this.paraCustodia().trim().length < 5 || !this.puedePagar() || this.enviandoCustodia()) return false;
    if (this.desdeCustodia() === 'maquina') return /^\d+$/.test(this.montoCustodia().trim()) && Number(this.montoCustodia()) > 0;
    if (this.desdeCustodia() === 'cajon') return valorDePiezas(this.piezasDe(this.piezasCustodia()), 'MXN') > 0n;
    return false;
  });
  readonly listoParaRendir = computed(() => !!this.rindiendo() && this.puedePagar() && !this.enviandoRendir()
    && (this.docsRendir().length > 0 || valorDePiezas(this.piezasDe(this.piezasRegresa()), 'MXN') > 0n));

  // `[LE.6.8]` Reposiciones.
  readonly reposiciones = signal<HojaDeReposicion[] | null>(null);
  readonly errorReposiciones = signal<string | null>(null);
  readonly quienLleva = signal<QuienLlevaDeposito[]>([]);
  /** `[LE.6.32]` La lectura falló: no es lo mismo que «nadie tiene la responsabilidad». */
  readonly errorQuienLleva = signal<string | null>(null);
  readonly reponiendo = signal<HojaDeReposicion | null>(null);
  readonly piezasReposicion = signal<Record<string, number>>({});
  readonly lleva = signal<string | null>(null);
  readonly enviandoReposicion = signal(false);
  readonly errorReposicion = signal<string | null>(null);
  readonly resultadoReposicion = signal<ResultadoPago | null>(null);
  private llaveReposicion = '';
  readonly cajonReposicion = computed(() => Number(this.reponiendo()?.cajon_minor ?? 0) / 100);
  /** Con quien lleva el depósito elegido y las monedas exactas del cajón (la misma valuación que el servidor). */
  readonly listoParaReponer = computed(() => {
    const h = this.reponiendo();
    if (!h || !h.renglones.length || !this.lleva() || !this.puedePagar() || this.enviandoReposicion()) return false;
    const conteo = Object.fromEntries(Object.entries(this.piezasReposicion()).filter(([, n]) => Number(n) > 0));
    return valorDePiezas(conteo, 'MXN') === BigInt(h.cajon_minor);
  });

  // `[LE.6.7]` En Suspenso.
  readonly suspenso = signal<PartidaEnSuspenso[] | null>(null);
  readonly errorSuspenso = signal<string | null>(null);
  readonly explicando = signal<PartidaEnSuspenso | null>(null);
  readonly destino = signal<'ruta' | 'cajon' | 'transito' | null>(null);
  readonly rutaSuspenso = signal('');
  readonly enviandoSuspenso = signal(false);
  readonly errorExplicar = signal<string | null>(null);
  readonly resultadoSuspenso = signal<ResultadoHecho | null>(null);
  private llaveSuspenso = '';
  /** Cada destino sólo con su dirección: a una ruta sólo lo que entró; al banco sólo lo que salió. */
  readonly listoParaExplicar = computed(() => {
    const p = this.explicando();
    const d = this.destino();
    if (!p || !d || !this.puedePagar() || this.enviandoSuspenso()) return false;
    if (d === 'ruta') return p.esta_en === 'haber' && /^\d{1,4}$/.test(this.rutaSuspenso().trim());
    if (d === 'transito') return p.esta_en === 'debe';
    return true;
  });

  // `[LE.6.7]` Por recibir.
  readonly cargandoCobros = signal(false);
  readonly errorCobros = signal<string | null>(null);
  readonly colaCobros = signal<PendientesResponse | null>(null);
  readonly cobros = signal<FilaCobro[]>([]);
  readonly cobrosYaRecibidos = signal(0);
  readonly recibiendo = signal<FilaCobro | null>(null);
  /** Cómo llegó el dinero: sólo lo que llega al cajón se cuenta aquí (lo de la máquina lo registra la máquina). */
  readonly modoCobro = signal<'cajon' | 'maquina' | null>(null);
  readonly piezasCobro = signal<Record<string, number>>({});
  readonly entrega = signal('');
  readonly enviandoCobro = signal(false);
  readonly errorCobro = signal<string | null>(null);
  readonly resultadoCobro = signal<ResultadoCobro | null>(null);
  private llaveCobro = '';

  readonly puedeGestionar = computed(() => this.perms.has(Permission.FINANCE_CAJA_GESTIONAR));
  readonly puedePagar = computed(() => this.puedeGestionar() && this.libro() !== 'sin_dia');
  /** Lo contado en centavos, con la misma valuación que el servidor (`valorDePiezas`). */
  readonly contadoCobro = computed(() => valorDePiezas(Object.fromEntries(Object.entries(this.piezasCobro()).filter(([, n]) => Number(n) > 0)), 'MXN'));
  /** Las plantillas no tienen literales `bigint`: la comparación vive aquí. */
  readonly hayContado = computed(() => this.contadoCobro() > 0n);
  readonly listoParaRecibir = computed(() => this.modoCobro() === 'cajon' && this.recibiendo()?.estado === 'recibible'
    && this.puedePagar() && !this.enviandoCobro() && this.contadoCobro() > 0n && !!this.entrega().trim());
  readonly cajon = computed(() => Number(this.plan()?.cajon_minor ?? 0) / 100);
  readonly listoParaPagar = computed(() => {
    const p = this.plan();
    if (!p || p.bloqueo || this.enviando() || !this.recibe().trim()) return false;
    // La misma valuación que usa el servidor (`valorDePiezas`), no una aritmética aparte.
    const conteo = Object.fromEntries(Object.entries(this.piezas()).filter(([, n]) => Number(n) > 0));
    return valorDePiezas(conteo, 'MXN') === BigInt(p.cajon_minor);
  });

  /**
   * ⭐ `[LE.6.32]` Las cifras de arriba declaran con qué se calcularon (ADR-056). Auditoría del
   * 2026-11-18: una lectura fallida de cobros pintaba «Por recibir $0.00 · 0 cobros», una de Suspenso
   * BORRABA su tarjeta (se leía «no hay nada en Suspenso») y una cola topada sumaba sólo sus primeras
   * filas sin decirlo. Ahora: falló → «no medido» con su porqué; topada → «parcial».
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = resumenCola(this.filas());
    const rc = this.resumenCobros();
    const sp = this.suspenso() ?? [];
    const enSuspenso = sp.reduce((s, p) => s + Number(p.monto_minor), 0) / 100;
    const topadaPagos = !!this.cola()?.has_more;
    const parcial = (topada: boolean, limite: number | undefined): Partial<MetricStripItem> =>
      topada ? { state: 'parcial', stateNote: `Suma sólo los primeros ${limite ?? ''} de la cola: hay más.` } : {};
    const pagos = parcial(topadaPagos, this.cola()?.limit);
    const noMedido = (label: string, nota: string, sub = 'no se pudo leer'): MetricStripItem =>
      ({ label, value: '—', format: 'text', sub, state: 'no_medido', stateNote: nota });
    const suspensoItem: MetricStripItem[] = this.errorSuspenso()
      ? [noMedido('En Suspenso', 'No se pudo leer qué hizo la máquina sin orden. Pulsa Actualizar.')]
      // Sólo cuando hay algo: es lo primero que se resuelve, y en cero no decide nada (Q.1).
      : sp.length ? [{ label: 'En Suspenso', value: enSuspenso, format: 'currency2', sub: `${sp.length} · la máquina sin explicar`, tone: 'bad' }] : [];
    const recibirItem: MetricStripItem = this.errorCobros() || !this.colaCobros()
      ? (this.errorCobros()
        ? noMedido('Por recibir', this.errorCobros()!)
        : noMedido('Por recibir', 'Todavía se está leyendo lo que Kepler espera recibir.', 'leyendo…'))
      : { label: 'Por recibir', value: rc.monto, format: 'currency2', sub: `${rc.n} ${rc.n === 1 ? 'cobro' : 'cobros'} · lo que Kepler espera`,
          tone: rc.n ? 'default' : 'muted', ...parcial(!!this.colaCobros()?.has_more, this.colaCobros()?.limit) };
    return [
      ...suspensoItem,
      { label: 'Se pagan ya', value: r.pagable.monto, format: 'currency2', sub: `${r.pagable.n} ${r.pagable.n === 1 ? 'documento' : 'documentos'}`, tone: 'default', ...pagos },
      { label: 'Piden la firma de Tesorería', value: r.firma.monto, format: 'currency2', sub: `${r.firma.n} · Kepler no dice qué pagan`, tone: r.firma.n ? 'warn' : 'muted', ...pagos },
      { label: 'Detenidos', value: r.detenido.monto, format: 'currency2', sub: `${r.detenido.n} · se arreglan donde se autorizan`, tone: r.detenido.n ? 'bad' : 'muted', ...pagos },
      recibirItem,
    ];
  });

  /** El conteo de una cola en el selector: sin leer o con falla, sin número; topada, «N+». */
  private opcionConConteo(label: string, value: string, resp: PendientesResponse | null, n: number, fallo: boolean): SegOption {
    if (!resp || fallo) return { label, value };
    return resp.has_more ? { label: `${label} ${n}+`, value } : { label, value, count: n };
  }

  /** Lo recibible: lo detenido no suma a lo que se espera recibir hoy. */
  private readonly resumenCobros = computed(() => {
    const f = this.cobros().filter((x) => x.estado === 'recibible');
    return { n: f.length, monto: Math.round(f.reduce((s, x) => s + (x.esperado ?? 0), 0) * 100) / 100 };
  });

  ngOnInit(): void {
    this.cargar();
  }

  ngAfterViewInit(): void {
    this.medir();
    // [LE.6.11] Keyboard-first: al entrar, el foco ya está en el selector de colas (antes eran 30 Tab
    // pasando por el menú y la barra). Sólo si nadie más tomó el foco.
    setTimeout(() => { if (document.activeElement === document.body) this.alSelector(); }, 0);
    this.marco()?.nativeElement.addEventListener('keydown', (ev) => this.teclaEnMarco(ev), true);
  }

  /** El botón activo del selector de colas. */
  alSelector(): void {
    this.marco()?.nativeElement.querySelector<HTMLElement>('app-segmented [role="radio"][tabindex="0"], app-segmented [role="radio"][aria-checked="true"]')?.focus();
  }

  /**
   * `[LE.6.11]` `↓` desde el selector baja a la lista (app-segmented lo usaría como `→`), y `↑` desde la
   * primera fila sube al selector. En captura: el selector y la tabla no se enteran.
   */
  private teclaEnMarco(ev: KeyboardEvent): void {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const t = ev.target as HTMLElement;
    if (ev.key === 'ArrowDown' && t.closest('app-segmented')) {
      ev.preventDefault(); ev.stopPropagation(); this.aLaCola(); return;
    }
    if (ev.key === 'ArrowUp' && t.tagName === 'TR') {
      const filas = [...(this.colaEl()?.nativeElement.querySelectorAll<HTMLElement>('tbody tr') ?? [])];
      if (filas[0] === t) { ev.preventDefault(); ev.stopPropagation(); this.alSelector(); }
    }
  }

  /** `[LE.6.11]` `↓` en la última cola del selector baja a la primera fila de la lista. */
  aLaCola(): void {
    const fila = this.colaEl()?.nativeElement.querySelector<HTMLElement>('tr[tabindex], button:not([disabled])');
    fila?.focus();
  }

  /** Pantallas angostas: la cola apilada necesita el scroll de la página, así que no se fija el alto. */
  @HostListener('window:resize')
  medir(): void {
    const el = this.marco()?.nativeElement;
    if (!el || typeof window === 'undefined' || window.innerWidth < 768) { this.alto.set(null); return; }
    this.alto.set(Math.max(360, Math.floor(window.innerHeight - el.getBoundingClientRect().top - 8)));
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.libroApi.saldos().pipe(
      map((s): EstadoLibro => (s.jornada_abierta ? 'abierto' : 'sin_dia')),
      catchError(() => of<EstadoLibro>('sin_medir')),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((e) => this.libro.set(e));
    // `[LE.6.7]` Los pagos a proveedor (X-D-26) y los anticipos (X-D-60), en la misma cola.
    forkJoin([
      this.ledger.movimientosPendientes({ doc_tipo: 'X-D-26', tipo: 'gasto', caja: '0011', sucursal: SUCURSAL_CAJA_GENERAL, limit: 200 }),
      this.ledger.movimientosPendientes({ doc_tipo: 'X-D-60', tipo: 'gasto', caja: '0011', sucursal: SUCURSAL_CAJA_GENERAL, limit: 200 }),
    ]).pipe(
      map(([a, b]): PendientesResponse => ({ ...a, rows: [...a.rows, ...b.rows], has_more: a.has_more || b.has_more, confirmables: a.confirmables + b.confirmables })),
      switchMap((c) => forkJoin({ c: of(c), v: c.rows.length ? this.libroApi.veredictos(c.rows.map((r) => r.origen_ref)) : of([]) })),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: ({ c, v }) => { this.cola.set(c); this.filas.set(armarCola(c.rows, v)); this.cargando.set(false); },
      error: (e) => { this.error.set(this.mensaje(e, 'No se pudo leer la cola.')); this.cargando.set(false); },
    });
    // `[LE.6.5]` Lo que cada persona tiene a su cargo.
    this.errorCustodias.set(null);
    this.libroApi.custodias().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => this.custodias.set(c),
      error: (e) => { this.custodias.set(null); this.errorCustodias.set(this.mensaje(e, 'No se pudo leer qué tiene cada persona a su cargo.')); },
    });
    // `[LE.6.8]` Las reposiciones y quién puede llevar el depósito.
    this.errorReposiciones.set(null);
    this.libroApi.reposiciones().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.reposiciones.set(r),
      error: (e) => { this.reposiciones.set(null); this.errorReposiciones.set(this.mensaje(e, 'No se pudo leer qué hay por reponer.')); },
    });
    this.errorQuienLleva.set(null);
    this.libroApi.quienLleva().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (q) => this.quienLleva.set(q),
      error: (e) => { this.quienLleva.set([]); this.errorQuienLleva.set(this.mensaje(e, 'No se pudo leer quién puede llevar el depósito. Cierra la ventana y pulsa Actualizar.')); },
    });
    // `[LE.6.7]` Suspenso, aparte: si no se puede leer, se dice; nunca se pinta como «nada en Suspenso».
    this.errorSuspenso.set(null);
    this.libroApi.suspenso().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.suspenso.set(s),
      error: (e) => { this.suspenso.set(null); this.errorSuspenso.set(this.mensaje(e, 'No se pudo leer qué hay en Suspenso.')); },
    });
    // `[LE.6.7]` Lo que entra, aparte: si una de las dos colas falla, la otra se sigue viendo.
    this.cargandoCobros.set(true);
    this.errorCobros.set(null);
    this.ledger.movimientosPendientes({ doc_tipo: 'U-A-5', tipo: 'ingreso', caja: '0011', limit: 200 }).pipe(
      switchMap((c) => forkJoin({ c: of(c), e: c.rows.length ? this.libroApi.estadoDeCobros(c.rows.map((r) => r.origen_ref)) : of([]) })),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: ({ c, e }) => {
        const a = armarCobros(c.rows, e);
        this.colaCobros.set(c); this.cobros.set(a.filas); this.cobrosYaRecibidos.set(a.yaRecibidos); this.cargandoCobros.set(false);
      },
      error: (e) => { this.errorCobros.set(this.mensaje(e, 'No se pudo leer qué hay por recibir.')); this.cargandoCobros.set(false); },
    });
  }

  abrirOtro(): void {
    this.otroAbierto.set(true); this.conceptoOtro.set(''); this.piezasOtro.set({}); this.errorOtro.set(null); this.resultadoOtro.set(null);
    this.llaveOtro = uuidV4();
  }

  recibirOtro(): void {
    if (!this.listoParaOtro()) return;
    const piezas = Object.fromEntries(Object.entries(this.piezasOtro()).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, String(n)]));
    this.enviandoOtro.set(true);
    this.errorOtro.set(null);
    this.libroApi.registrarHecho({ tipo: 'otro_ingreso', concepto: this.conceptoOtro().trim(), piezas }, this.llaveOtro).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resultadoOtro.set(r); this.enviandoOtro.set(false); this.alListo(); },
      error: (e) => { this.errorOtro.set(this.mensaje(e, 'No se registró.')); this.enviandoOtro.set(false); },
    });
  }

  /** `[LE.6.34]` Cierra; si ya hubo resultado, recarga (lo mismo con «Listo», Esc o X). */
  cerrarOtro(): void {
    if (this.enviandoOtro()) return;
    const hecho = !!this.resultadoOtro();
    this.otroAbierto.set(false);
    this.resultadoOtro.set(null);
    if (hecho) this.cargar();
  }

  abrirNuevaCustodia(): void {
    this.nuevaCustodia.set(true);
    this.buscaPersona.set(''); this.personasHalladas.set([]); this.personaCustodia.set(null);
    this.paraCustodia.set(''); this.desdeCustodia.set(null); this.montoCustodia.set(''); this.piezasCustodia.set({});
    this.resultadoCustodia.set(null); this.errorCustodia.set(null);
    this.llaveCustodia = uuidV4();
  }

  buscarPersona(q: string): void {
    this.buscaPersona.set(q);
    if (q.trim().length < 2) { this.personasHalladas.set([]); return; }
    this.libroApi.personas(q.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (p) => this.personasHalladas.set(p), error: () => this.personasHalladas.set([]) });
  }

  sacarACustodia(): void {
    const persona = this.personaCustodia();
    if (!persona || !this.listoParaCustodia()) return;
    const desde = this.desdeCustodia() === 'maquina'
      ? { tipo: 'maquina' as const, monto_minor: String(Number(this.montoCustodia().trim()) * 100) }
      : { tipo: 'cajon' as const, piezas: Object.fromEntries(Object.entries(this.piezasDe(this.piezasCustodia())).map(([k, n]) => [k, String(n)])) };
    this.enviandoCustodia.set(true);
    this.errorCustodia.set(null);
    this.libroApi.retiroACustodia({ persona, para: this.paraCustodia().trim(), desde }, this.llaveCustodia).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.resultadoCustodia.set(r); this.enviandoCustodia.set(false); this.alListo();
        this.anotarCodigo(r, 'custodia de ' + (this.personasHalladas().find((p) => p.usuario_id === persona)?.nombre ?? 'una persona'));
      },
      error: (e) => { this.errorCustodia.set(this.mensaje(e, 'No se sacó.')); this.enviandoCustodia.set(false); },
    });
  }

  /** Cierra la ventana; si ya hubo resultado, recarga (lo mismo con «Listo», Esc o X). A medio envío no cierra. */
  cerrarNuevaCustodia(): void {
    if (this.enviandoCustodia()) return;
    const hecho = !!this.resultadoCustodia();
    this.nuevaCustodia.set(false);
    this.resultadoCustodia.set(null);
    if (hecho) this.cargar();
  }

  abrirRendirFila(data: CustodiaAbierta | CustodiaAbierta[] | undefined): void {
    const c = Array.isArray(data) ? data[0] : data;
    if (c && this.puedePagar()) this.abrirRendir(c);
  }

  abrirRendir(c: CustodiaAbierta): void {
    this.rindiendo.set(c);
    this.docsRendir.set([]); this.piezasRegresa.set({});
    this.resultadoRendir.set(null); this.errorRendir.set(null);
    this.llaveRendir = uuidV4();
  }

  alternarDoc(ref: string): void {
    this.docsRendir.update((d) => (d.includes(ref) ? d.filter((x) => x !== ref) : [...d, ref]));
  }

  rendirCustodia(): void {
    const c = this.rindiendo();
    if (!c || !this.listoParaRendir()) return;
    const porRef = new Map(this.filas().map((f) => [f.doc.origen_ref, f.doc.kepler_cuenta ?? '']));
    const regresa = Object.fromEntries(Object.entries(this.piezasDe(this.piezasRegresa())).map(([k, n]) => [k, String(n)]));
    this.enviandoRendir.set(true);
    this.errorRendir.set(null);
    this.libroApi.rendir({ persona: c.persona, documentos: this.docsRendir().map((r) => ({ origen_ref: r, cuenta_kepler: porRef.get(r) ?? '' })),
      ...(Object.keys(regresa).length ? { regresa } : {}) }, this.llaveRendir).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resultadoRendir.set(r); this.enviandoRendir.set(false); this.alListo(); },
      error: (e) => { this.errorRendir.set(this.mensaje(e, 'No se rindió.')); this.enviandoRendir.set(false); },
    });
  }

  cerrarRendir(): void {
    if (this.enviandoRendir()) return;
    const hecho = !!this.resultadoRendir();
    this.rindiendo.set(null);
    this.resultadoRendir.set(null);
    if (hecho) this.cargar();
  }

  /** El banco es el testigo: si el depósito no aparece, se dice y la reposición sigue abierta. */
  confirmarDeposito(ordenId: string): void {
    this.avisoCustodia.set(null);
    this.libroApi.confirmarDeposito(ordenId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.avisoCustodia.set('Depósito confirmado: la reposición quedó cerrada.'); this.cargar(); },
      error: (e) => this.avisoCustodia.set(this.mensaje(e, 'No se pudo confirmar el depósito.')),
    });
  }

  abrirReposicionFila(data: HojaDeReposicion | HojaDeReposicion[] | undefined): void {
    const h = Array.isArray(data) ? data[0] : data;
    if (h && this.puedePagar()) this.abrirReposicion(h);
  }

  abrirReposicion(h: HojaDeReposicion): void {
    if (!h.renglones.length) return;
    this.reponiendo.set(h);
    this.piezasReposicion.set({});
    this.lleva.set(this.quienLleva().length === 1 ? this.quienLleva()[0].usuario_id : null);
    this.resultadoReposicion.set(null);
    this.errorReposicion.set(null);
    this.llaveReposicion = uuidV4();
  }

  pedirReposicion(): void {
    const h = this.reponiendo();
    const lleva = this.lleva();
    if (!h || !lleva || !this.listoParaReponer()) return;
    this.enviandoReposicion.set(true);
    this.errorReposicion.set(null);
    const piezas = Object.fromEntries(Object.entries(this.piezasReposicion()).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, String(n)]));
    this.libroApi.pedirReposicion({ zona: h.zona, documentos: h.renglones.map((r) => r.origen_ref), lleva, piezas_cajon: piezas }, this.llaveReposicion)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.resultadoReposicion.set(r); this.enviandoReposicion.set(false); this.alListo(); this.anotarCodigo(r, 'reposición ' + h.nombre); },
        error: (e) => { this.errorReposicion.set(this.mensaje(e, 'No se pidió.')); this.enviandoReposicion.set(false); },
      });
  }

  cerrarReposicion(): void {
    if (this.enviandoReposicion()) return;
    const hecho = !!this.resultadoReposicion();
    this.reponiendo.set(null);
    this.resultadoReposicion.set(null);
    if (hecho) this.cargar();
  }

  abrirSuspensoFila(data: PartidaEnSuspenso | PartidaEnSuspenso[] | undefined): void {
    const p = Array.isArray(data) ? data[0] : data;
    if (p && this.puedePagar()) this.abrirSuspenso(p);
  }

  abrirSuspenso(p: PartidaEnSuspenso): void {
    this.explicando.set(p);
    this.destino.set(null);
    this.rutaSuspenso.set('');
    this.resultadoSuspenso.set(null);
    this.errorExplicar.set(null);
    this.llaveSuspenso = uuidV4();
  }

  explicar(): void {
    const p = this.explicando();
    const d = this.destino();
    if (!p || !d || !this.listoParaExplicar()) return;
    this.enviandoSuspenso.set(true);
    this.errorExplicar.set(null);
    const hacia = d === 'ruta' ? { tipo: 'ruta' as const, ruta: this.rutaSuspenso().trim() } : { tipo: d };
    this.libroApi.explicar({ event_ref: p.event_ref, hacia }, this.llaveSuspenso).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resultadoSuspenso.set(r); this.enviandoSuspenso.set(false); this.alListo(); },
      error: (e) => { this.errorExplicar.set(this.mensaje(e, 'No se explicó.')); this.enviandoSuspenso.set(false); },
    });
  }

  cerrarSuspenso(): void {
    if (this.enviandoSuspenso()) return;
    const hecho = !!this.resultadoSuspenso();
    this.explicando.set(null);
    this.resultadoSuspenso.set(null);
    if (hecho) this.cargar();
  }

  abrirCobroFila(data: FilaCobro | FilaCobro[] | undefined): void {
    const f = Array.isArray(data) ? data[0] : data;
    if (f && this.puedePagar()) this.abrirCobro(f);
  }

  abrirCobro(f: FilaCobro): void {
    if (f.estado !== 'recibible') return;
    this.recibiendo.set(f);
    this.modoCobro.set(null);
    this.piezasCobro.set({});
    this.entrega.set('');
    this.resultadoCobro.set(null);
    this.errorCobro.set(null);
    this.llaveCobro = uuidV4();
  }

  recibir(): void {
    const f = this.recibiendo();
    if (!f || !this.listoParaRecibir()) return;
    this.enviandoCobro.set(true);
    this.errorCobro.set(null);
    const piezas = Object.fromEntries(Object.entries(this.piezasCobro()).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, String(n)]));
    this.libroApi.recibir({ origen_ref: f.doc.origen_ref, piezas, entrega: { nombre: this.entrega().trim() } }, this.llaveCobro)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.resultadoCobro.set(r); this.enviandoCobro.set(false); this.alListo(); },
        error: (e) => { this.errorCobro.set(this.mensaje(e, 'No se recibió.')); this.enviandoCobro.set(false); },
      });
  }

  cerrarCobro(): void {
    if (this.enviandoCobro()) return;
    const recibido = !!this.resultadoCobro();
    this.recibiendo.set(null);
    this.resultadoCobro.set(null);
    this.modoCobro.set(null);
    if (recibido) this.cargar();
  }

  esperadoMinor(f: FilaCobro): string {
    return String(Math.round((f.esperado ?? 0) * 100));
  }

  diferenciaDe(contadoMinor: string, esperadoMinor: string, ruta: string | null): string {
    return textoDiferencia(BigInt(contadoMinor), BigInt(esperadoMinor), ruta);
  }

  severidad(f: FilaVentanilla): 'secondary' | 'warn' | 'danger' {
    return f.estado === 'detenido' ? 'danger' : f.estado === 'firma' ? 'warn' : 'secondary';
  }

  loRespalda(f: FilaVentanilla): string {
    const v = f.veredicto;
    if (!v || !v.detalle.length) return v?.respaldo === 'no_medido' ? 'No se pudo medir qué paga este documento.' : 'Kepler no dice qué gasto o compra paga.';
    const partes = v.detalle.map((d) => d.tipo === 'entrada'
      ? `entrada ${d.folio} ${this.minor(d.aplicado_minor)}`
      : `gasto ${d.folio} ${this.minor(d.aplicado_minor)} · vale ${d.vale_folio ?? 'sin expediente'}${d.aprobado ? ', aprobado' : ''}`);
    return (v.respaldo === 'compra' ? 'Paga la compra: ' : 'Paga: ') + partes.join(' · ');
  }

  /** PrimeNG declara `data` como `T | T[] | undefined` (admite selección múltiple): se toma sólo una fila. */
  abrirFila(data: FilaVentanilla | FilaVentanilla[] | undefined): void {
    const f = Array.isArray(data) ? data[0] : data;
    if (f && this.puedePagar()) this.abrir(f);
  }

  abrir(f: FilaVentanilla): void {
    if (f.estado === 'detenido' || !f.doc.kepler_cuenta) return;
    this.pagando.set(f);
    this.plan.set(null);
    this.piezas.set({});
    this.recibe.set('');
    this.resultado.set(null);
    this.errorPago.set(null);
    this.llave = uuidV4();
    this.libroApi.plan(f.doc.origen_ref, f.doc.kepler_cuenta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => this.plan.set(p),
      error: (e) => this.errorPago.set(this.mensaje(e, 'No se pudo leer el documento.')),
    });
  }

  pagar(): void {
    const f = this.pagando();
    if (!f || !f.doc.kepler_cuenta || !this.listoParaPagar()) return;
    this.enviando.set(true);
    this.errorPago.set(null);
    const piezas = Object.fromEntries(Object.entries(this.piezas()).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, String(n)]));
    this.libroApi.pagar({ origen_ref: f.doc.origen_ref, cuenta_kepler: f.doc.kepler_cuenta, piezas_cajon: piezas,
      recibe: { nombre: this.recibe().trim() } }, this.llave).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resultado.set(r); this.enviando.set(false); this.alListo(); this.anotarCodigo(r, f.doc.doc_tipo + ' ' + f.doc.folio); },
      error: (e) => { this.errorPago.set(this.mensaje(e, 'No se pagó.')); this.enviando.set(false); },
    });
  }

  cerrar(): void {
    if (this.enviando()) return;   // [LE.6.34] cerrar a medio envío pierde el código
    const pagado = !!this.resultado();
    this.pagando.set(null);
    this.plan.set(null);
    this.resultado.set(null);
    if (pagado) this.cargar();
  }

  /** El servidor del libro responde `{ codigo, mensaje }`; el resto de la API, `{ message }`. */
  private mensaje(e: unknown, porDefecto: string): string {
    const err = (e as { error?: { mensaje?: string; message?: string | string[] } })?.error;
    const m = err?.mensaje ?? err?.message;
    return (Array.isArray(m) ? m.join(' ') : m) || porDefecto;
  }
}
