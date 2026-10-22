import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import {
  ContpaqiPuenteService, LoteRow, LotesResp, CuadreResp,
  PendienteProveedor, PendientesResp, ReglaVista, PagoPorConfirmar, CfdiPropuesto,
} from '../contpaqi-puente.service';

/**
 * Fase CP `[CP.8.33]` — **La bandeja del puente: qué saldría de póliza, y qué no sale y por qué.**
 *
 * ── Por qué la pantalla muestra RECHAZOS y no entregas ──────────────────────────────────────
 * El puente hoy rechaza todo: las 21 reglas de cuenta están sin firmar. Una bandeja que sólo
 * listara lo entregado estaría en blanco.
 *
 * ⭐ Lo que sí vale hoy es **el rechazo con dueño**. Medido en enero contra producción: 1,474
 * movimientos que un diseño por-movimiento habría vuelto 1,474 pólizas se agrupan en **258
 * lotes**, y los motivos se reparten entre cuatro responsables distintos... más uno que **no es
 * de nadie**: los 148 de `no_aplica` ya se midieron y NO generan póliza. Mezclarlos con el resto
 * haría que la bandeja pida trabajo que no existe.
 *
 * ── Entregar ────────────────────────────────────────────────────────────────────────────────
 * **No manda nada a ContPAQi.** `[CP.8.54]` «Marcar como entregado» registra que contabilidad ya
 * CARGÓ el archivo, y sólo acepta ese mismo archivo (el backend lo compara byte a byte con el que
 * genera hoy). Va separado de «Generar» porque descargar no es entregar. Exige `_GESTIONAR`.
 *
 * ── ⚠️ Ruta propia, no un tab de `/contabilidad/contpaqi` ───────────────────────────────────
 * Esa página ya existe desde CP.1–CP.4 y es el **otro sentido** (lee los libros que ContPAQi ya
 * tiene), gateada por `FISCAL_CONTAB_VER`. Colgar el puente ahí lo habría escondido detrás del
 * permiso equivocado: quien revisa los libros fiscales no es quien arma la póliza de egresos.
 *
 * Operations: denso, answer-first, tokens, dark-safe. Lectura pura — mirar no cambia nada.
 */
@Component({
  selector: 'app-contabilidad-contpaqi-puente',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cpp-page">

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Puente ContPAQi &mdash; bandeja de armado</h1>
          <p class="surf-page-sub">
            Qu&eacute; saldr&iacute;a de p&oacute;liza desde los egresos de banco, y qu&eacute; no sale y de qui&eacute;n es.
            Simulaci&oacute;n de solo lectura: mirar no cambia nada.
          </p>
        </div>
        <div class="surf-page-head-actions">
          <p-select [options]="mesOpts" [ngModel]="mes()" (ngModelChange)="setMes($event)"
                    appendTo="body" class="cpp-sel" [style]="{ minWidth: '10rem' }"
                    ariaLabel="Mes"></p-select>
        </div>
      </header>

      @if (error(); as e) {
        <div class="cpp-error" role="alert">
          <i class="pi pi-exclamation-triangle"></i>
          <div>
            <strong>No se pudo leer la bandeja.</strong>
            <div class="cpp-error-d">{{ e }}</div>
          </div>
          <button type="button" class="cpp-btn" (click)="cargar()">Reintentar</button>
        </div>
      }

      @if (loading()) {
        <div class="cpp-skel" aria-busy="true">@for (i of [1,2,3,4,5,6]; track i) { <div class="cpp-skel-row"></div> }</div>
      } @else if (data(); as d) {

        <!-- ── EL VEREDICTO, antes que cualquier tabla ── -->
        <section class="cpp-verdict">
          <div class="cpp-eyebrow">Qu&eacute; saldr&iacute;a de p&oacute;liza este mes</div>
          <h2>
            <span class="mono">{{ d.resumen.incluidas | number }}</span> de
            <span class="mono">{{ d.resumen.movimientos | number }}</span> movimientos.
          </h2>
          @if (d.resumen.incluidas === 0) {
            <p class="cpp-lede">
              El puente rechaza todo: no hay ninguna regla de cuenta firmada. No es una falla
              &mdash; es el estado real, y lo que vale hoy es <strong>saber de qui&eacute;n es cada rechazo</strong>.
            </p>
          }

          <!-- ⭐ El hueco se declara ARRIBA del número que lo omite, no en una nota al pie. -->
          @if (d.fuera_de_lote.movimientos > 0) {
            <div class="cpp-declara">
              <strong class="mono">{{ d.fuera_de_lote.movimientos | number }}</strong>
              movimientos del mes ({{ d.fuera_de_lote.importe | currency:'MXN':'symbol-narrow':'1.0-0' }})
              <strong>no son egresos de banco</strong> y quedan fuera de todo lote:
              @for (c of d.fuera_de_lote.cuentas; track c.cuenta) {
                <span class="cpp-cta-fuera">{{ c.cuenta }} <span class="mono">({{ c.movimientos | number }})</span></span>
              }
              &mdash; no tienen cuenta <code>102*</code> porque no son bancos. El universo del mes es
              <strong class="mono">{{ d.resumen.universo | number }}</strong>, no {{ d.resumen.movimientos | number }}.
            </div>
          }
        </section>

        <app-metric-strip [items]="kpis()" ariaLabel="Resumen del puente" />

        <!-- [CP.8.38] El archivo. Descargar NO es entregar, y la pantalla lo dice. -->
        @if (d.resumen.incluidas > 0 && puedeGestionar()) {
          <div class="cpp-archivo">
            <div>
              <strong>{{ d.resumen.con_asiento | number }}</strong> p&oacute;lizas armadas
              (<span class="mono">{{ d.resumen.incluidas | number }}</span> movimientos).
              <div class="cpp-archivo-n">
                Descargar <strong>no</strong> lo marca como entregado: el reloj del cuadre arranca
                cuando alguien confirme que lo carg&oacute; en ContPAQi, no cuando bajes el archivo.
              </div>
            </div>
            <button type="button" class="cpp-btn-ok" [disabled]="bajando()" (click)="descargar()">
              {{ bajando() ? 'Generando…' : 'Generar el archivo' }}
            </button>
          </div>
          @if (avisoArchivo(); as a) {
            <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
          }

          <!-- [CP.8.54] Marcar entregado: separado de Generar, y sólo con el archivo que se cargó. -->
          <div class="cpp-archivo cpp-entrega">
            <div>
              <strong>&iquest;Ya lo cargaste en ContPAQi?</strong>
              <div class="cpp-archivo-n">
                Elige el mismo archivo que importaste. La Suite lo compara con el que genera hoy para
                {{ mes() }} y, si es id&eacute;ntico, empieza a buscar esas p&oacute;lizas en ContPAQi;
                a los {{ plazoDias() }} d&iacute;as avisa de las que no aparezcan.
              </div>
            </div>
            <input #archivoCargado type="file" accept=".txt,text/plain" class="cpp-file"
                   (change)="marcarEntregado(archivoCargado)" aria-label="Archivo que se cargó en ContPAQi" />
            <button type="button" class="cpp-btn-ok" [disabled]="entregando()" (click)="archivoCargado.click()">
              <i class="pi pi-check" aria-hidden="true"></i>
              {{ entregando() ? 'Comparando…' : 'Marcar como entregado' }}
            </button>
          </div>
          @if (avisoEntrega(); as a) {
            <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
          }
        }

        <!-- ── EL RECHAZO CON DUEÑO: esto es la entrega ── -->
        <section class="cpp-sec">
          <div class="cpp-sec-h">
            <h3>El rechazo, con due&ntilde;o</h3>
            <span class="cpp-tag">esto es la entrega</span>
          </div>
          <p class="cpp-sec-p">
            Sin esta tabla la pantalla dir&iacute;a &laquo;{{ d.resumen.movimientos | number }} pendientes&raquo;,
            un n&uacute;mero que no le dice a nadie qu&eacute; hacer. El rengl&oacute;n activo se resalta cuando
            filtr&aacute;s los lotes m&aacute;s abajo.
          </p>
          <!--
            ⛔ Esta tabla NO es un control, es la lectura. El filtro vive abajo en botones de
            verdad: una fila clicable sin equivalente de teclado deja afuera a quien no usa
            mouse, y duplicar el filtro en dos lugares es dos sitios donde se desincroniza.
          -->
          <div class="card-premium card-flat cpp-tablewrap">
            <p-table [value]="d.motivos" size="small" class="surf-table" [rowHover]="true">
              <ng-template #header>
                <tr><th>Motivo</th><th class="ta-r">Movs</th><th>Participaci&oacute;n</th><th>Le toca a</th></tr>
              </ng-template>
              <ng-template #body let-m>
                <tr class="cpp-motivo" [class.sel]="filtro() === m.motivo">
                  <td>
                    <div>{{ etiqueta(m.motivo) }}</div>
                    <div class="cpp-code">{{ m.motivo }}</div>
                  </td>
                  <td class="ta-r mono" [class.muted]="esDeNadie(m.motivo)">{{ m.movimientos | number }}</td>
                  <td>
                    <span class="cpp-share">
                      <span class="cpp-bar" [class.nadie]="esDeNadie(m.motivo)">
                        <i [style.width.%]="pct(m.movimientos, d.resumen.movimientos)"></i>
                      </span>
                      <span class="cpp-pct mono">{{ pct(m.movimientos, d.resumen.movimientos) | number:'1.1-1' }}%</span>
                    </span>
                  </td>
                  <td>
                    <span class="cpp-who" [attr.data-nadie]="esDeNadie(m.motivo) ? '' : null">
                      <span class="cpp-dot"></span>{{ m.dueno }}
                    </span>
                  </td>
                </tr>
              </ng-template>
              <ng-template #footer>
                <tr><td colspan="4" class="cpp-foot">
                  <span class="mono">{{ pendientes() | number }}</span> esperan a alguien &middot;
                  <span class="mono">{{ d.resumen.incluidas | number }}</span> ya entran al asiento &middot;
                  <span class="mono">{{ deNadie() | number }}</span> no son trabajo de nadie:
                  ya se midi&oacute; que no generan p&oacute;liza.
                </td></tr>
              </ng-template>
            </p-table>
          </div>
        </section>

        <!-- ── MAESTRO-DETALLE DE LOTES ── -->
        <section class="cpp-sec">
          <div class="cpp-sec-h"><h3>Lotes del mes</h3></div>
          <p class="cpp-sec-p">
            La unidad es <strong>(cuenta de banco &times; d&iacute;a)</strong>, no el movimiento: as&iacute; es como
            la contadora arma la p&oacute;liza, y as&iacute; se reconoce su trabajo en el archivo.
          </p>

          <div class="cpp-chips">
            <button type="button" class="cpp-chip" [class.on]="filtro() === null"
                    [attr.aria-pressed]="filtro() === null" (click)="toggleMotivo(null)">
              Todos los lotes <span class="mono">{{ d.lotes.length | number }}</span>
            </button>
            @for (m of d.motivos; track m.motivo) {
              <button type="button" class="cpp-chip" [class.on]="filtro() === m.motivo"
                      [attr.aria-pressed]="filtro() === m.motivo" (click)="toggleMotivo(m.motivo)">
                {{ etiqueta(m.motivo) }} <span class="mono">{{ lotesCon(m.motivo) | number }}</span>
              </button>
            }
          </div>

          <div class="cpp-md">
            <div class="card-premium card-flat cpp-tablewrap">
              <p-table [value]="visibles()" size="small" class="surf-table" [rowHover]="true"
                       [scrollable]="true" scrollHeight="440px"
                       [paginator]="visibles().length > 120" [rows]="120"
                       selectionMode="single" [selection]="sel()" (selectionChange)="sel.set($event)"
                       dataKey="k">
                <ng-template #header>
                  <tr><th>Banco</th><th>Fecha</th><th class="ta-r">Movs</th><th class="ta-r">Asiento</th></tr>
                </ng-template>
                <ng-template #body let-l>
                  <tr [pSelectableRow]="l" class="cpp-lote">
                    <td>
                      <span class="cpp-bank">{{ banco(l) }}</span>
                      <span class="cpp-code">{{ l.cuenta_banco }}</span>
                      @if (l.tipo === 'pago_proveedor') {
                        <span class="cpp-code">pago a proveedor &middot; {{ l.cfdis | number }} CFDI</span>
                      }
                    </td>
                    <td class="muted mono">{{ l.fecha }}</td>
                    <td class="ta-r mono">{{ l.movimientos | number }}</td>
                    <td class="ta-r mono" [class.muted]="l.incluidas === 0">{{ l.incluidas | number }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="4" class="cpp-empty">Ning&uacute;n lote con ese motivo.</td></tr>
                </ng-template>
              </p-table>
            </div>

            <aside class="card-premium card-flat cpp-peek">
              @if (sel(); as l) {
                @if (l.tipo === 'pago_proveedor') {
                <div class="cpp-eyebrow">Pago a proveedor</div>
                <h4>{{ banco(l) }}</h4>
                <div class="cpp-code">{{ l.cuenta_banco }} &middot; {{ l.fecha }}</div>
                <div class="cpp-kvs">
                  <div class="cpp-kv"><span>Total</span>
                    <span class="mono">{{ l.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                  <div class="cpp-kv"><span>Renglones</span><span class="mono">{{ l.renglones | number }}</span></div>
                  <div class="cpp-kv"><span>Facturas y notas (UUID)</span><span class="mono">{{ l.cfdis | number }}</span></div>
                  <div class="cpp-kv"><span>Las facturas salen de</span><span>{{ fuente(l) }}</span></div>
                </div>
                <div class="cpp-note">
                  Una p&oacute;liza por pago, como la hace contabilidad: por factura, cargo a 2120 con el traspaso
                  de IVA/IEPS si estaba provisionada, o compra directa 501/502; las notas con su reversa; el UUID de
                  cada CFDI. Si las facturas menos las notas no dan lo pagado, no se arma.
                </div>
                } @else {
                <div class="cpp-eyebrow">Lote seleccionado</div>
                <h4>{{ banco(l) }}</h4>
                <div class="cpp-code">{{ l.cuenta_banco }} &middot; {{ l.fecha }}</div>
                <div class="cpp-kvs">
                  <div class="cpp-kv"><span>Movimientos</span><span class="mono">{{ l.movimientos | number }}</span></div>
                  <div class="cpp-kv"><span>Entran al asiento</span>
                    <span class="mono" [class.muted]="l.incluidas === 0">{{ l.incluidas | number }}</span></div>
                  @if (l.incluidas > 0) {
                    <div class="cpp-kv"><span>Renglones</span><span class="mono">{{ l.renglones | number }}</span></div>
                    <div class="cpp-kv"><span>Total</span>
                      <span class="mono">{{ l.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                  }
                </div>
                <div class="cpp-eyebrow mt">Por qu&eacute; no entran</div>
                <div class="cpp-kvs">
                  @for (m of motivosDe(l); track m.k) {
                    <div class="cpp-kv">
                      <span class="cpp-who" [attr.data-nadie]="esDeNadie(m.k) ? '' : null">
                        <span class="cpp-dot"></span>{{ etiqueta(m.k) }}
                      </span>
                      <span class="mono">{{ m.n | number }}</span>
                    </div>
                  }
                </div>
                @if (l.iva_traspaso === 'no_emitido') {
                  <div class="cpp-note">
                    ⚠️ El lote cuadra pero <strong>no lleva el traspaso de IVA</strong>. Se declara en vez
                    de emitir un rengl&oacute;n que nadie verific&oacute;.
                  </div>
                }
                <div class="cpp-note">
                  Una p&oacute;liza por lote: N cargos y <strong>un</strong> abono al banco. Un rengl&oacute;n malo
                  no tumba el lote &mdash; se cae solo y el resto sigue.
                </div>
                }
              } @else {
                <div class="cpp-eyebrow">Lote</div>
                <h4>Eleg&iacute; un lote</h4>
                <div class="cpp-note">La lista de la izquierda muestra un rengl&oacute;n por (banco &times; d&iacute;a), y uno por cada pago a proveedor armado completo.</div>
              }
            </aside>
          </div>
        </section>

        <!-- ── [CP.8.14] LAS REGLAS DE CUENTA: la firma del contador ── -->
        @if (reglasError(); as e) {
          <section class="cpp-sec">
            <div class="cpp-sec-h"><h3>Reglas de cuenta</h3></div>
            <div class="cpp-aviso mal" role="alert">No se pudieron leer las reglas: {{ e }}</div>
          </section>
        } @else if (reglas(); as rs) {
          <section class="cpp-sec">
            <div class="cpp-sec-h">
              <h3>Reglas de cuenta</h3>
              <span class="cpp-tag">la firma es del contador</span>
            </div>
            <!-- Q.1: la respuesta antes que la tabla. -->
            <p class="cpp-sec-p">
              @if (porFirmar().n > 0) {
                Firmar las <strong class="mono">{{ porFirmar().reglas }}</strong> reglas pendientes de esta lista
                pone en el archivo hasta <strong class="mono">{{ porFirmar().n | number }}</strong> movimientos de
                {{ mes() }} (<strong class="mono">{{ porFirmar().imp | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>).
                Es un techo: un movimiento puede seguir fuera por otro motivo.
              } @else {
                Ninguna regla firmable traba movimientos de {{ mes() }}.
              }
            </p>
            <div class="cpp-nota-dura">
              ⛔ El <strong>indicio</strong> sale de cruzar el banco contra las p&oacute;lizas que ya est&aacute;n en
              ContPAQi, y casi siempre sobre una muestra chica: es una pista, no una propuesta. Nada viene
              elegido. Una cuenta equivocada <strong>cuadra igual</strong> y no se ve hasta la balanza.
            </div>
            <div class="card-premium card-flat cpp-tablewrap">
              <p-table [value]="firmables()" size="small" class="surf-table" [rowHover]="true" dataKey="categoria_code">
                <ng-template #header>
                  <tr><th>Categor&iacute;a</th><th class="r">Movs del mes</th><th class="r">Importe</th>
                    <th>Evidencia</th><th>Cuenta de gasto</th><th></th></tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td>
                      <div class="cpp-bank">{{ nombreRegla(r) }}</div>
                      <div class="cpp-code">{{ r.categoria_code }}</div>
                    </td>
                    <td class="r mono" [class.muted]="r.movimientos_mes === 0">{{ r.movimientos_mes | number }}</td>
                    <td class="r mono" [class.muted]="r.movimientos_mes === 0">{{ r.importe_mes | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                    <td class="cpp-evid">
                      @if (r.indicio) {
                        <div><span class="cpp-code">indicio</span> <span class="mono">{{ r.indicio }}</span></div>
                      } @else {
                        <div class="muted">sin indicio utilizable</div>
                      }
                      @if (r.evidencia) { <div class="cpp-evid-t">{{ r.evidencia }}</div> }
                    </td>
                    <td class="cpp-cta">
                      @if (r.estado === 'aprobada') {
                        <div><span class="mono">{{ r.cuenta_gasto }}</span> {{ r.cuenta_nombre }}</div>
                        <div class="cpp-code">firmada por {{ r.aprobada_por }} &middot; {{ r.aprobada_en }}</div>
                      } @else if (puedeGestionar()) {
                        <p-select [options]="cuentas()" [ngModel]="cuentaElegida()[r.categoria_code] ?? null"
                                  (ngModelChange)="elegirCuenta(r.categoria_code, $event)"
                                  optionLabel="etiqueta" optionValue="codigo" [filter]="true" filterBy="etiqueta"
                                  placeholder="Elige la cuenta" appendTo="body" [showClear]="true"
                                  class="cpp-sel-cta" [ariaLabel]="'Cuenta de gasto para ' + r.categoria_code"></p-select>
                        @if (codigoIndicio(r); as ci) {
                          <button type="button" class="cpp-link" (click)="elegirCuenta(r.categoria_code, ci)">
                            usar el indicio ({{ ci }})
                          </button>
                        }
                        @if (r.cuenta_gasto) {
                          <div class="cpp-code">revocada; la &uacute;ltima firma era {{ r.cuenta_gasto }} ({{ r.aprobada_por }})</div>
                        }
                      } @else {
                        <span class="muted">sin firmar</span>
                      }
                    </td>
                    <td>
                      @if (puedeGestionar()) {
                        @if (r.estado === 'aprobada') {
                          <button type="button" class="cpp-btn-bad" [disabled]="firmando() === r.categoria_code"
                                  (click)="revocar(r)">{{ firmando() === r.categoria_code ? 'Revocando…' : 'Revocar' }}</button>
                        } @else {
                          <button type="button" class="cpp-btn-ok"
                                  [disabled]="!cuentaElegida()[r.categoria_code] || firmando() === r.categoria_code"
                                  (click)="firmar(r)">{{ firmando() === r.categoria_code ? 'Firmando…' : 'Firmar' }}</button>
                        }
                      }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="6" class="cpp-empty">No hay reglas que se firmen con una cuenta.</td></tr>
                </ng-template>
              </p-table>
            </div>
            @if (avisoRegla(); as a) {
              <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
            }

            @if (noFirmables().length) {
              <div class="cpp-eyebrow mt">No se firman aqu&iacute;, y por qu&eacute;</div>
              <div class="card-premium card-flat cpp-tablewrap">
                <p-table [value]="noFirmables()" size="small" class="surf-table" dataKey="categoria_code">
                  <ng-template #header>
                    <tr><th>Categor&iacute;a</th><th>Forma</th><th class="r">Movs del mes</th><th class="r">Importe</th><th>Por qu&eacute;</th></tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr>
                      <td><div>{{ nombreRegla(r) }}</div><div class="cpp-code">{{ r.categoria_code }}</div></td>
                      <td class="cpp-code">{{ r.tipo_regla }}</td>
                      <td class="r mono" [class.muted]="r.movimientos_mes === 0">{{ r.movimientos_mes | number }}</td>
                      <td class="r mono" [class.muted]="r.movimientos_mes === 0">{{ r.importe_mes | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      <td class="cpp-evid-t">{{ r.motivo_no_firmable }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            }
          </section>
        }

        <!-- ── [CP.8.37] LO QUE FALTA ENLAZAR: el rechazo con su acción al lado ── -->
        @if (porConfirmar(); as p) {
          @if (p.filas.length) {
            <section class="cpp-sec">
              <div class="cpp-sec-h">
                <h3>Proveedores por confirmar</h3>
                <span class="cpp-tag">esto destraba dinero</span>
              </div>
              <p class="cpp-sec-p">
                <strong class="mono">{{ p.filas.length }}</strong> nombres del banco que no llegan a una
                cuenta, por <strong class="mono">{{ p.total_importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>.
                Se confirma <strong>el nombre</strong>, no cada movimiento.
              </p>
              <div class="cpp-nota-dura">
                ⛔ Las sugerencias est&aacute;n ordenadas por <strong>palabras en com&uacute;n</strong>: son
                una pista, no un veredicto. Una cuenta equivocada <strong>cuadra igual</strong> y no se
                ve hasta la balanza &mdash; por eso elige una persona y queda su nombre.
              </div>
              <div class="card-premium card-flat cpp-tablewrap">
                <p-table [value]="p.filas" size="small" class="surf-table" [rowHover]="true"
                         [scrollable]="true" scrollHeight="420px">
                  <ng-template #header>
                    <tr><th class="r">Importe</th><th class="r">Movs</th><th>Dice el banco</th>
                      <th>Candidatos de ContPAQi</th><th></th></tr>
                  </ng-template>
                  <ng-template #body let-f>
                    <tr>
                      <td class="r mono">{{ f.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      <td class="r mono">{{ f.movimientos | number }}</td>
                      <td>
                        <div class="cpp-bank">{{ f.concepto_banco }}</div>
                        <div class="cpp-code">{{ f.veredicto }}</div>
                      </td>
                      <td>
                        @if (!f.sugerencias.length) {
                          <span class="muted">sin candidato parecido &mdash; hay que buscarlo en ContPAQi</span>
                        }
                        @for (s of f.sugerencias; track s.cuenta) {
                          <label class="cpp-sug">
                            <input type="radio" [name]="'sug-' + f.alias_normalizado" [value]="s.cuenta"
                                   [checked]="elegido()[f.alias_normalizado] === s.cuenta"
                                   (change)="elegir(f.alias_normalizado, s.cuenta)">
                            <span class="mono">{{ s.cuenta }}</span>
                            <span>{{ s.nombre }}</span>
                            <span class="cpp-pct mono">{{ s.parecido * 100 | number:'1.0-0' }}%</span>
                            <span class="cpp-code">{{ s.veredicto }}</span>
                          </label>
                        }
                      </td>
                      <td>
                        @if (puedeGestionar()) {
                          <button type="button" class="cpp-btn-ok"
                                  [disabled]="!elegido()[f.alias_normalizado] || guardando() === f.alias_normalizado"
                                  (click)="confirmar(f)">
                            {{ guardando() === f.alias_normalizado ? 'Guardando…' : 'Confirmar' }}
                          </button>
                        } @else {
                          <span class="cpp-code">sin permiso para confirmar</span>
                        }
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
              @if (avisoAlias(); as a) {
                <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
              }
            </section>
          }
        }

        <!-- ── [CP.8.73] PAGOS A PROVEEDOR POR CONFIRMAR: qué facturas paga cada uno ── -->
        @if (pagosError(); as pe) {
          <div class="cpp-aviso mal" role="alert">Pagos por confirmar: {{ pe }}</div>
        }
        @if (pagos(); as pc) {
          @if (pc.length) {
            <section class="cpp-sec">
              <div class="cpp-sec-h">
                <h3>Pagos a proveedor por confirmar</h3>
                <span class="cpp-tag">{{ pc.length | number }} pagos</span>
              </div>
              <p class="cpp-sec-p">
                El puente arma solo el pago cuando sabe qu&eacute; facturas paga. Estos no: elige las facturas
                (y las notas) que paga cada uno. Se puede confirmar <strong>s&oacute;lo cuando las facturas menos
                las notas dan lo pagado</strong>, y queda tu nombre.
              </p>
              <div class="cpp-md">
                <div class="card-premium card-flat cpp-tablewrap">
                  <p-table [value]="pc" size="small" class="surf-table" [rowHover]="true"
                           [scrollable]="true" scrollHeight="440px"
                           selectionMode="single" [selection]="pagoSel()" (selectionChange)="elegirPago($event)"
                           dataKey="movimiento_id">
                    <ng-template #header>
                      <tr><th>Fecha</th><th>Banco</th><th class="ta-r">Importe</th><th>Por qu&eacute;</th></tr>
                    </ng-template>
                    <ng-template #body let-p>
                      <tr [pSelectableRow]="p">
                        <td class="muted mono">{{ p.fecha }}</td>
                        <td><span class="cpp-bank">{{ p.banco_label || p.cuenta_banco }}</span>
                          <span class="cpp-code">{{ p.concepto }}</span></td>
                        <td class="ta-r mono">{{ p.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                        <td>
                          @if (p.confirmacion?.vigente) { <span class="cpp-code">confirmado por {{ p.confirmacion.confirmado_por }}</span> }
                          @else { <span class="cpp-code">{{ p.motivo }}</span> }
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                </div>

                <aside class="card-premium card-flat cpp-peek">
                  @if (pagoSel(); as s) {
                    <div class="cpp-eyebrow">Pago a proveedor</div>
                    <h4 class="mono">{{ s.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</h4>
                    <div class="cpp-code">{{ s.banco_label || s.cuenta_banco }} &middot; {{ s.fecha }} &middot; {{ s.concepto }}</div>
                    @if (!s.propuesta) {
                      <div class="cpp-note">No se sabe de qui&eacute;n es: ni Kepler tiene el pago ni el concepto lleva a un
                        proveedor. Se resuelve en Compras (el RFC del acreedor) antes de poder confirmarlo.</div>
                    } @else {
                      <div class="cpp-kvs">
                        <div class="cpp-kv"><span>Proveedor (RFC)</span><span class="mono">{{ s.propuesta.rfc }}</span></div>
                      </div>
                      @if (s.propuesta.sugerencia.length && puedeGestionar()) {
                        <button type="button" class="cpp-btn-ok mt" (click)="usarSugerencia()">
                          Usar la sugerencia ({{ s.propuesta.origen === 'kepler' ? 'lo que aplicó Kepler' : 'la única combinación por importe' }})
                        </button>
                      }
                      <div class="cpp-eyebrow mt">Facturas ({{ s.propuesta.facturas.length | number }})</div>
                      <div class="cpp-lista">
                        @for (f of candidatas(); track f.uuid) {
                          <label class="cpp-sug">
                            <input type="checkbox" [checked]="marcadasF().has(f.uuid)" [disabled]="!puedeGestionar()"
                                   (change)="alternar('f', f.uuid)">
                            <span class="mono">{{ f.folio || '—' }}</span>
                            <span class="muted mono">{{ f.fecha }}</span>
                            <span class="mono">{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                            @if (f.sugerida) { <span class="cpp-code">sugerida</span> }
                            @if (f.pagada_antes) { <span class="cpp-code"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> ya en un pago del {{ f.pagada_antes }}</span> }
                          </label>
                        }
                      </div>
                      @if (s.propuesta.notas.length) {
                        <div class="cpp-eyebrow mt">Notas de cr&eacute;dito ({{ s.propuesta.notas.length | number }})</div>
                        <div class="cpp-lista">
                          @for (n of s.propuesta.notas; track n.uuid) {
                            <label class="cpp-sug">
                              <input type="checkbox" [checked]="marcadasN().has(n.uuid)" [disabled]="!puedeGestionar()"
                                     (change)="alternar('n', n.uuid)">
                              <span class="mono">{{ n.folio || '—' }}</span>
                              <span class="muted mono">{{ n.fecha }}</span>
                              <span class="mono">{{ n.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                            </label>
                          }
                        </div>
                      }
                      @if (cuadrePago(); as c) {
                        <div class="cpp-kvs mt">
                          <div class="cpp-kv"><span>Facturas</span><span class="mono">{{ c.facturas | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                          <div class="cpp-kv"><span>&minus; Notas</span><span class="mono">{{ c.notas | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                          <div class="cpp-kv"><span>Pagado</span><span class="mono">{{ s.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                          <div class="cpp-kv"><span>Diferencia</span>
                            <span class="mono" [class.cpp-mal]="!c.cuadra">{{ c.diferencia | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                        </div>
                        @if (puedeGestionar()) {
                          <button type="button" class="cpp-btn-ok mt" [disabled]="!c.cuadra || confirmandoPago()" (click)="confirmarPago()">
                            {{ confirmandoPago() ? 'Guardando…' : 'Confirmar' }}
                          </button>
                          @if (s.confirmacion?.vigente) {
                            <button type="button" class="cpp-btn-bad mt" [disabled]="confirmandoPago()" (click)="desconfirmarPago()">Quitar la confirmaci&oacute;n</button>
                          }
                        } @else {
                          <span class="cpp-code">sin permiso para confirmar</span>
                        }
                      }
                    }
                    @if (avisoPago(); as a) {
                      <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
                    }
                  } @else {
                    <div class="cpp-eyebrow">Pago</div>
                    <h4>Elige un pago</h4>
                  }
                </aside>
              </div>
            </section>
          }
        }

        <!-- ── EL CUADRE: el vacío ES el dato ── -->
        <section class="cpp-sec">
          <div class="cpp-sec-h"><h3>Cuadre contra ContPAQi</h3></div>
          @if (cuadre(); as c) {
            @if (!c.hay_entregas) {
              <div class="card-premium card-flat cpp-vacio">
                <div class="cpp-zero mono">0%</div>
                <div>
                  <h4>Sin entregas &mdash; el denominador es cero</h4>
                  <p>
                    Nunca se import&oacute; un archivo a ContPAQi, as&iacute; que no hay nada que cuadrar.
                    Un tablero que mostrara <span class="mono">0%</span> sin decir que el denominador es
                    cero mentir&iacute;a por omisi&oacute;n, as&iacute; que el servicio devuelve
                    <code>hay_entregas = false</code> y la pantalla lo dice.
                  </p>
                  <div class="cpp-meta">
                    <span>plazo del motor <b class="mono">{{ c.plazo_dias }} d&iacute;as</b></span>
                    <span>verificadas <b class="mono">{{ c.verificadas | number }}</b></span>
                    <span>esperando <b class="mono">{{ c.esperando | number }}</b></span>
                    <span>divergentes <b class="mono">{{ c.divergentes | number }}</b></span>
                  </div>
                </div>
              </div>
            } @else {
              <div class="card-premium card-flat cpp-tablewrap">
                <div class="cpp-meta pad">
                  <span>verificadas <b class="mono">{{ c.verificadas | number }}</b></span>
                  <span>esperando <b class="mono">{{ c.esperando | number }}</b></span>
                  <span>divergentes <b class="mono">{{ c.divergentes | number }}</b></span>
                  <span>plazo <b class="mono">{{ c.plazo_dias }} d&iacute;as</b></span>
                </div>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .cpp-page { --cpp-gap: 1.25rem; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .muted { color: var(--c-text-3); }
    .ta-r { text-align: right; }

    .cpp-verdict { padding: 1.5rem 0 1.25rem; border-bottom: 1px solid var(--c-divider); }
    .cpp-eyebrow { font-size: var(--fs-micro); letter-spacing: .09em; text-transform: uppercase;
      color: var(--c-text-3); }
    .cpp-eyebrow.mt { margin-top: 1.1rem; }
    .cpp-verdict h2 { font-size: clamp(1.6rem, 4vw, 2.25rem); font-weight: 600; margin: .6rem 0 0;
      letter-spacing: -.02em; line-height: 1.15; text-wrap: balance; }
    .cpp-lede { margin: .75rem 0 0; color: var(--c-text-2); max-width: 62ch; }
    .cpp-declara { margin-top: .85rem; padding-left: .75rem; border-left: 2px solid var(--c-warn);
      color: var(--c-text-2); font-size: var(--fs-sm); max-width: 74ch; }
    .cpp-cta-fuera { display: inline-block; margin: 0 .35rem; padding: 1px 7px;
      border: 1px solid var(--c-divider); border-radius: 999px; font-size: var(--fs-xs); }

    .cpp-sec { padding: 1.5rem 0 0; }
    .cpp-sec-h { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
    .cpp-sec-h h3 { font-size: var(--fs-h3); font-weight: 600; margin: 0; letter-spacing: -.01em; }
    .cpp-tag { font-size: var(--fs-micro); letter-spacing: .07em; text-transform: uppercase;
      color: var(--action); }
    .cpp-sec-p { color: var(--c-text-2); font-size: var(--fs-sm); margin: .35rem 0 .9rem; max-width: 74ch; }
    .cpp-tablewrap { overflow: hidden; }
    .cpp-code { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--c-text-3);
      display: block; }

    .cpp-motivo { cursor: pointer; }
    .cpp-motivo.sel { background: var(--surface-selected-bg); box-shadow: inset 2px 0 0 0 var(--action); }
    .cpp-share { display: flex; align-items: center; gap: .5rem; }
    .cpp-bar { display: block; width: clamp(70px, 9vw, 130px); height: 6px; border-radius: 999px;
      background: var(--surface-200); overflow: hidden; flex: 0 0 auto; }
    .cpp-bar i { display: block; height: 100%; background: var(--c-text-3); border-radius: 999px; }
    .cpp-bar.nadie i { background: var(--c-divider); }
    .sel .cpp-bar i { background: var(--action); }
    .cpp-pct { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cpp-who { display: inline-flex; align-items: center; gap: .45rem; white-space: nowrap; }
    .cpp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-2); flex: 0 0 auto; }
    .cpp-who[data-nadie] { color: var(--c-text-3); }
    .cpp-who[data-nadie] .cpp-dot { background: transparent; border: 1px solid var(--c-text-3); }
    .cpp-foot { font-size: var(--fs-xs); color: var(--c-text-2); }

    .cpp-chips { display: flex; gap: .4rem; flex-wrap: wrap; margin-bottom: .75rem; }
    .cpp-chip { border: 1px solid var(--c-divider); background: var(--c-surface-1); color: var(--c-text-2);
      border-radius: 999px; padding: 4px 11px; font: inherit; font-size: var(--fs-xs); cursor: pointer;
      transition: background .12s var(--ease-standard, ease), border-color .12s var(--ease-standard, ease); }
    .cpp-chip:hover { background: var(--surface-hover); }
    .cpp-chip.on { border-color: var(--action); color: var(--action); background: var(--surface-selected-bg); }
    .cpp-chip .mono { margin-left: .4rem; color: var(--c-text-3); }
    .cpp-chip.on .mono { color: var(--action); }

    .cpp-md { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--cpp-gap);
      align-items: start; }
    .cpp-lote { cursor: pointer; }
    .cpp-bank { font-weight: 500; display: block; }
    .cpp-peek { padding: 1.1rem; }
    .cpp-peek h4 { margin: .35rem 0 .1rem; font-size: var(--fs-h3); font-weight: 600; }
    .cpp-kvs { margin-top: .6rem; }
    .cpp-kv { display: flex; justify-content: space-between; gap: .75rem; padding: .5rem 0;
      border-bottom: 1px solid var(--c-divider); font-size: var(--fs-sm); }
    .cpp-kv:last-child { border-bottom: 0; }
    .cpp-kv > span:first-child { color: var(--c-text-2); min-width: 0; }
    .cpp-note { margin-top: .85rem; padding-top: .85rem; border-top: 1px solid var(--c-divider);
      font-size: var(--fs-xs); color: var(--c-text-3); }

    .cpp-vacio { padding: 1.3rem; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1.1rem;
      align-items: start; }
    .cpp-zero { font-size: 2.5rem; font-weight: 500; color: var(--c-text-3); line-height: 1;
      letter-spacing: -.03em; }
    .cpp-vacio h4 { margin: 0 0 .35rem; font-size: var(--fs-h3); font-weight: 600; }
    .cpp-vacio p { margin: 0; color: var(--c-text-2); font-size: var(--fs-sm); max-width: 66ch; }
    .cpp-meta { margin-top: .75rem; display: flex; gap: 1.1rem; flex-wrap: wrap;
      font-size: var(--fs-xs); color: var(--c-text-3); }
    .cpp-meta.pad { margin: 0; padding: 1rem; }
    .cpp-meta b { color: var(--c-text-2); font-weight: 500; }
    .cpp-empty { padding: 1.5rem; text-align: center; color: var(--c-text-3); font-size: var(--fs-sm); }

    .cpp-error { display: flex; align-items: center; gap: .75rem; padding: .9rem 1rem; margin-top: 1rem;
      border: 1px solid var(--bad-border); background: var(--bad-soft-bg); color: var(--bad-soft-fg);
      border-radius: var(--radius-md); font-size: var(--fs-sm); }
    .cpp-error-d { font-size: var(--fs-xs); opacity: .85; }
    .cpp-btn { margin-left: auto; border: 1px solid currentColor; background: transparent; color: inherit;
      border-radius: var(--radius-sm); padding: 4px 10px; font: inherit; font-size: var(--fs-xs); cursor: pointer; }

    .cpp-skel { display: grid; gap: .5rem; margin-top: 1.25rem; }
    .cpp-skel-row { height: var(--row-h-md); border-radius: var(--radius-sm); background: var(--surface-200); }

    .cpp-archivo { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
      margin-top: 1rem; padding: .9rem 1rem; border: 1px solid var(--c-divider);
      border-radius: var(--r-lg); background: var(--c-surface-1); font-size: var(--fs-sm); }
    .cpp-archivo > div:first-child { flex: 1 1 24rem; min-width: 0; }
    .cpp-archivo-n { color: var(--c-text-3); font-size: var(--fs-xs); margin-top: .25rem; max-width: 72ch; }
    .cpp-entrega { margin-top: .5rem; }

    /* [CP.8.14] reglas de cuenta */
    .cpp-evid { max-width: 38ch; font-size: var(--fs-xs); }
    .cpp-evid-t { color: var(--c-text-3); font-size: var(--fs-xs); margin-top: .2rem; max-width: 60ch; }
    .cpp-cta { min-width: 18rem; }
    .cpp-sel-cta { width: 100%; }
    .cpp-link { border: 0; background: transparent; color: var(--action); padding: 2px 0; font: inherit;
      font-size: var(--fs-xs); cursor: pointer; text-decoration: underline; }
    .cpp-btn-bad { border: 1px solid var(--bad-border); background: transparent; color: var(--bad-fg);
      border-radius: var(--radius-sm); padding: 4px 12px; font: inherit; font-size: var(--fs-xs);
      cursor: pointer; white-space: nowrap; }
    .cpp-btn-bad:disabled { color: var(--c-text-3); border-color: var(--c-divider); cursor: default; }
    .cpp-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

    /* [CP.8.37] confirmar el alias */
    .cpp-nota-dura { margin: 0 0 .8rem; padding-left: .8rem; border-left: 2px solid var(--c-warn);
      color: var(--c-text-2); font-size: var(--fs-sm); max-width: 78ch; }
    .cpp-sug { display: flex; align-items: center; gap: .5rem; padding: 3px 0; cursor: pointer;
      font-size: var(--fs-sm); flex-wrap: wrap; }
    .cpp-sug input { accent-color: var(--action); flex: 0 0 auto; }
    .cpp-sug > span:nth-child(3) { color: var(--c-text-2); }
    /* [CP.8.73] Pagos por confirmar: candidatas con scroll propio, la diferencia que no cuadra se marca. */
    .cpp-lista { max-height: 16rem; overflow: auto; padding-right: .25rem; }
    .cpp-kvs.mt, .cpp-btn-ok.mt, .cpp-btn-bad.mt { margin-top: .75rem; }
    .cpp-mal { color: var(--bad-fg); font-weight: 600; }
    .cpp-btn-ok { border: 1px solid var(--action); background: transparent; color: var(--action);
      border-radius: var(--radius-sm); padding: 4px 12px; font: inherit; font-size: var(--fs-xs);
      cursor: pointer; white-space: nowrap; }
    .cpp-btn-ok:hover:not(:disabled) { background: var(--surface-selected-bg); }
    .cpp-btn-ok:disabled { border-color: var(--c-divider); color: var(--c-text-3); cursor: default; }
    .cpp-aviso { margin-top: .75rem; padding: .6rem .8rem; border-radius: var(--radius-md);
      font-size: var(--fs-sm); border: 1px solid var(--ok-border); background: var(--ok-soft-bg);
      color: var(--ok-soft-fg); }
    .cpp-aviso.mal { border-color: var(--bad-border); background: var(--bad-soft-bg);
      color: var(--bad-soft-fg); }

    @media (max-width: 56.25rem) { .cpp-md { grid-template-columns: 1fr; } }
    @media (prefers-reduced-motion: reduce) { .cpp-chip { transition: none; } }
  `],
})
export class ContabilidadContpaqiPuenteComponent implements OnInit {
  private readonly api = inject(ContpaqiPuenteService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly data = signal<LotesResp | null>(null);
  readonly cuadre = signal<CuadreResp | null>(null);
  readonly filtro = signal<string | null>(null);
  readonly sel = signal<LoteVista | null>(null);
  readonly mes = signal<string>(mesCerrado());
  // ⛔ Se llamaba `pendientes` y COLISIONABA con el `computed` del mismo nombre que ya vivía
  // más abajo (el de `[CP.8.33]`, que cuenta movimientos). Dos miembros con el mismo nombre en
  // una clase: `TS2300` + `TS2717`, y el `| number` del template recibiendo un objeto (`TS2769`).
  // Ninguna de las dos ramas podía verlo sola — se tocaron al integrarlas. El nombre sale de
  // su propio título en pantalla: «Proveedores por confirmar».
  readonly porConfirmar = signal<PendientesResp | null>(null);
  /** alias → cuenta elegida en la pantalla. ⛔ Nada se preselecciona: elegir es del humano. */
  readonly elegido = signal<Record<string, string>>({});
  readonly guardando = signal<string | null>(null);
  readonly bajando = signal(false);
  readonly avisoArchivo = signal<{ texto: string; mal: boolean } | null>(null);
  readonly entregando = signal(false);
  readonly avisoEntrega = signal<{ texto: string; mal: boolean } | null>(null);
  /** El plazo del motor, del backend: repetir la constante acá la dejaría divergir. */
  readonly plazoDias = computed(() => this.cuadre()?.plazo_dias ?? 5);

  // ── [CP.8.14] reglas de cuenta ──
  readonly reglas = signal<ReglaVista[] | null>(null);
  readonly reglasError = signal<string | null>(null);
  readonly cuentas = signal<{ codigo: string; etiqueta: string }[]>([]);
  /** categoría → cuenta elegida. ⛔ Nada se preselecciona: el indicio sólo llena si se pide. */
  readonly cuentaElegida = signal<Record<string, string>>({});
  readonly firmando = signal<string | null>(null);
  readonly avisoRegla = signal<{ texto: string; mal: boolean } | null>(null);
  readonly firmables = computed(() => (this.reglas() ?? []).filter((r) => r.firmable));
  readonly noFirmables = computed(() => (this.reglas() ?? []).filter((r) => !r.firmable));
  /** Lo que destrabaría firmar lo pendiente de la lista. Techo: otro motivo puede dejarlos fuera. */
  readonly porFirmar = computed(() => {
    const p = this.firmables().filter((r) => r.estado !== 'aprobada' && r.movimientos_mes > 0);
    return {
      reglas: p.length,
      n: p.reduce((a, r) => a + r.movimientos_mes, 0),
      imp: p.reduce((a, r) => a + Number(r.importe_mes), 0),
    };
  });
  readonly avisoAlias = signal<{ texto: string; mal: boolean } | null>(null);
  /**
   * Confirmar exige `_GESTIONAR`; mirar el pendiente sólo `_VER`.
   *
   * ⚠️ Esto esconde el botón, **no** protege nada: quien manda es el guard del endpoint. Un
   * permiso del lado del navegador es una cortesía, no una puerta.
   */
  readonly puedeGestionar = signal<boolean>(
    this.auth.user()?.permissions?.[Permission.FISCAL_CONTPAQI_BRIDGE_GESTIONAR] === true,
  );

  /** Los 12 meses cerrados hacia atrás. El mes en curso NO entra: siempre se ve incompleto. */
  readonly mesOpts = mesesAtras(12);

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    const c = this.cuadre();
    if (!d) return [];
    const fuera = d.fuera_de_lote;
    return [
      { label: 'Lotes', value: d.resumen.lotes, format: 'number', sub: 'banco × día', state: 'medido' },
      { label: 'Movimientos', value: d.resumen.movimientos, format: 'number',
        sub: 'agrupados en lote', state: 'medido' },
      { label: 'Con asiento', value: d.resumen.incluidas, format: 'number',
        tone: d.resumen.incluidas === 0 ? 'muted' : 'ok',
        sub: d.resumen.incluidas === 0 ? 'ninguna regla firmada' : 'listos para armar',
        state: 'medido' },
      // ⭐ `no_medido` NO es "cero": es "este puente no lo cubre". Son dos cosas distintas y el
      // organismo tiene vocabulario para las dos desde `[VP.MS]`.
      { label: 'Fuera de lote', value: fuera.movimientos, format: 'number', tone: 'muted',
        state: fuera.movimientos > 0 ? 'no_medido' : 'medido',
        stateNote: fuera.cuentas.map((x) => `${x.cuenta}: ${x.movimientos}`).join(' · ')
          || 'nada quedó fuera',
        sub: 'no son egresos de banco' },
      { label: 'Entregas', value: c ? (c.hay_entregas ? c.verificadas : 0) : 0, format: 'number',
        tone: 'muted',
        state: c && !c.hay_entregas ? 'no_medido' : 'medido',
        stateNote: 'nunca se importó un archivo a ContPAQi',
        sub: 'verificadas en ContPAQi' },
    ];
  });

  readonly visibles = computed<LoteVista[]>(() => {
    const d = this.data();
    if (!d) return [];
    const f = this.filtro();
    const rows = f ? d.lotes.filter((l) => (l.motivos?.[f] ?? 0) > 0) : d.lotes;
    return [...rows]
      .sort((a, b) => b.movimientos - a.movimientos || a.fecha.localeCompare(b.fecha))
      // `dataKey` de PrimeNG necesita UN campo, y la llave del lote son dos (banco y día).
      // `[CP.8.72]` La clave viene del servidor: un pago a proveedor y el lote de su día comparten banco y fecha.
      .map((l) => ({ ...l, k: l.clave ?? `${l.cuenta_banco}|${l.fecha}` }));
  });

  readonly deNadie = computed(() => contarDeNadie(this.data()?.motivos ?? []));

  /**
   * ⛔ Resta TAMBIÉN las incluidas. Mientras el puente rechazaba todo, `movimientos − no_aplica`
   * daba lo mismo; desde `[CP.8.35]` entran 144 al asiento y esa cuenta **sobredeclara el trabajo
   * pendiente**, que es justo el número que alguien mira para estimar cuánto falta.
   */
  readonly pendientes = computed(() => {
    const r = this.data()?.resumen;
    if (!r) return 0;
    return Math.max(0, r.movimientos - this.deNadie() - r.incluidas);
  });

  // ── `[CP.8.73]` Pagos a proveedor por confirmar ────────────────────────────────────────────
  readonly pagos = signal<PagoPorConfirmar[] | null>(null);
  readonly pagosError = signal<string | null>(null);
  readonly pagoSel = signal<PagoPorConfirmar | null>(null);
  readonly marcadasF = signal<ReadonlySet<string>>(new Set());
  readonly marcadasN = signal<ReadonlySet<string>>(new Set());
  readonly confirmandoPago = signal(false);
  readonly avisoPago = signal<{ texto: string; mal: boolean } | null>(null);
  /** Las facturas del pago elegido: lo sugerido primero, después las más recientes. */
  readonly candidatas = computed(() => {
    const p = this.pagoSel()?.propuesta;
    return p ? ordenarCandidatas(p.facturas, p.sugerencia) : [];
  });
  readonly cuadrePago = computed(() => {
    const p = this.pagoSel()?.propuesta;
    return p ? cuadreDePago(p.facturas, p.notas, this.marcadasF(), this.marcadasN(), p.pagado) : null;
  });

  cargarPagos(): void {
    this.pagosError.set(null);
    this.api.pagosPorConfirmar(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.pagos.set(r.pagos);
        const id = this.pagoSel()?.movimiento_id;
        this.elegirPago(r.pagos.find((x) => x.movimiento_id === id) ?? r.pagos[0] ?? null);
      },
      error: (e) => { this.pagos.set(null); this.pagosError.set(e?.error?.message ?? 'no se pudo leer los pagos por confirmar'); },
    });
  }

  /** ⛔ Al elegir un pago NO se marca la sugerencia: sólo lo ya confirmado vuelve marcado. */
  elegirPago(p: PagoPorConfirmar | null): void {
    this.pagoSel.set(p);
    this.avisoPago.set(null);
    const c = p?.confirmacion;
    this.marcadasF.set(new Set(c?.facturas ?? []));
    this.marcadasN.set(new Set(c?.notas ?? []));
  }

  usarSugerencia(): void {
    const s = this.pagoSel()?.propuesta?.sugerencia ?? [];
    this.marcadasF.set(new Set(s));
  }

  alternar(tipo: 'f' | 'n', uuid: string): void {
    const sig = tipo === 'f' ? this.marcadasF : this.marcadasN;
    const s = new Set(sig()); if (s.has(uuid)) s.delete(uuid); else s.add(uuid);
    sig.set(s);
  }

  confirmarPago(): void {
    const p = this.pagoSel(); const c = this.cuadrePago();
    if (!p || !c?.cuadra || this.confirmandoPago()) return;
    this.confirmandoPago.set(true);
    this.api.confirmarPago(p.movimiento_id, [...this.marcadasF()], [...this.marcadasN()])
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.confirmandoPago.set(false);
          this.avisoPago.set({ texto: `Confirmado: la póliza sale con ${r.renglones} renglones por ${r.total.toFixed(2)}.`, mal: false });
          this.cargar();
        },
        error: (e) => {
          this.confirmandoPago.set(false);
          this.avisoPago.set({ texto: e?.error?.message ?? 'no se pudo confirmar', mal: true });
        },
      });
  }

  desconfirmarPago(): void {
    const p = this.pagoSel();
    if (!p?.confirmacion || this.confirmandoPago()) return;
    this.confirmandoPago.set(true);
    this.api.desconfirmarPago(p.movimiento_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.confirmandoPago.set(false); this.avisoPago.set({ texto: 'Confirmación quitada.', mal: false }); this.cargar(); },
      error: (e) => { this.confirmandoPago.set(false); this.avisoPago.set({ texto: e?.error?.message ?? 'no se pudo quitar', mal: true }); },
    });
  }

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.cargarPagos();   // [CP.8.73] mismo mes, mismo momento
    this.api.lotes(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        // Completa al llegar: el primer lote ya seleccionado, no un panel en blanco.
        this.sel.set(this.visibles()[0] ?? null);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? e?.message ?? 'Error de red');
        this.loading.set(false);
      },
    });
    // ⚠️ El cuadre va aparte a propósito: si falla, la bandeja igual sirve. Lo que no puede
    // pasar es que se pinte un 0 % inventado, así que ante error queda en `null` y no se dibuja.
    this.api.cuadre().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.cuadre.set(c), error: () => this.cuadre.set(null) });

    // Igual que el cuadre: si falla, la bandeja sigue sirviendo y la sección no se dibuja.
    this.api.pendientes(this.mes()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (p) => this.porConfirmar.set(p), error: () => this.porConfirmar.set(null) });

    // [CP.8.14] ⚠️ Aquí el error SÍ se dibuja: una sección de firmas que desaparece se lee como
    // «no hay nada que firmar», y es justo lo contrario.
    this.reglasError.set(null);
    this.api.reglas(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.reglas.set(r.reglas),
      error: (e) => { this.reglas.set(null); this.reglasError.set(e?.error?.message ?? 'error de red'); },
    });
    if (!this.cuentas().length && this.puedeGestionar()) {
      this.api.cuentasGasto().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (c) => this.cuentas.set(c.cuentas.map((x) => ({ codigo: x.codigo, etiqueta: `${x.codigo} ${x.nombre}` }))),
        error: () => this.cuentas.set([]),
      });
    }
  }

  /** El nombre legible es la primera frase de la evidencia medida («Comisión bancaria.»). */
  nombreRegla(r: ReglaVista): string {
    return nombreDeRegla(r);
  }

  /** El código de 10 dígitos del indicio, sólo si existe en el catálogo que se puede firmar. */
  codigoIndicio(r: ReglaVista): string | null {
    return codigoDeIndicio(r.indicio, this.cuentas());
  }

  elegirCuenta(categoria: string, cuenta: string | null): void {
    this.cuentaElegida.update((m) => {
      const n = { ...m };
      if (cuenta) n[categoria] = cuenta; else delete n[categoria];
      return n;
    });
  }

  /** ⭐ Al firmar se recarga la bandeja entera: la firma cambia qué movimientos entran al asiento. */
  firmar(r: ReglaVista): void {
    const cuenta = this.cuentaElegida()[r.categoria_code];
    if (!cuenta || this.firmando()) return;
    this.firmando.set(r.categoria_code);
    this.avisoRegla.set(null);
    this.api.firmarRegla(r.categoria_code, cuenta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => {
        this.firmando.set(null);
        this.elegirCuenta(r.categoria_code, null);
        this.avisoRegla.set({
          texto: `${this.nombreRegla(r)} quedó firmada a ${v.cuenta_gasto} ${v.cuenta_nombre ?? ''}. `
            + 'Sus movimientos ya entran al armado; lo ya entregado no se vuelve a mandar.',
          mal: false,
        });
        this.cargar();
      },
      error: (e) => {
        this.firmando.set(null);
        this.avisoRegla.set({ texto: e?.error?.message ?? 'No se pudo firmar', mal: true });
      },
    });
  }

  revocar(r: ReglaVista): void {
    if (this.firmando()) return;
    this.firmando.set(r.categoria_code);
    this.avisoRegla.set(null);
    this.api.revocarRegla(r.categoria_code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.firmando.set(null);
        this.avisoRegla.set({
          texto: `${this.nombreRegla(r)} quedó sin firmar: sus movimientos dejan de armarse. `
            + 'Lo que ya se entregó a ContPAQi no se toca.',
          mal: false,
        });
        this.cargar();
      },
      error: (e) => {
        this.firmando.set(null);
        this.avisoRegla.set({ texto: e?.error?.message ?? 'No se pudo revocar', mal: true });
      },
    });
  }

  /**
   * `[CP.8.38]` Baja el TXT del mes.
   *
   * ⚠️ El navegador no puede leer el archivo y decidir: si el backend rechaza, llega un JSON de
   * error con `Content-Type` distinto. Por eso se pide como `blob` y se mira el tipo antes de
   * ofrecerlo — guardar un JSON de error con nombre `.txt` y que alguien lo importe a ContPAQi
   * es un modo de falla real.
   */
  descargar(): void {
    this.bajando.set(true);
    this.avisoArchivo.set(null);
    this.api.archivo(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.bajando.set(false);
        if (!blob || blob.type.includes('json')) {
          this.avisoArchivo.set({ texto: 'El servidor no devolvió un archivo de póliza.', mal: true });
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `egresos-banco-${this.mes()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        this.avisoArchivo.set({
          texto: `Archivo de ${this.mes()} generado. NO quedó marcado como entregado.`, mal: false,
        });
      },
      error: (e) => {
        this.bajando.set(false);
        this.avisoArchivo.set({ texto: e?.error?.message ?? 'No se pudo generar', mal: true });
      },
    });
  }

  /**
   * `[CP.8.54]` Marca entregado el archivo que se cargó en ContPAQi.
   *
   * ⭐ Se deshabilita en el primer clic, antes de leer el archivo: el doble clic no manda dos
   * veces (y aunque mandara, el backend no duplica). Los bytes viajan tal cual en base64 — el
   * archivo es latin1 de ancho fijo y cualquier decodificación a texto podría cambiarlo.
   */
  async marcarEntregado(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.entregando()) return;
    this.entregando.set(true);
    this.avisoEntrega.set(null);
    let b64: string;
    try {
      b64 = aBase64(new Uint8Array(await file.arrayBuffer()));
    } catch {
      this.entregando.set(false);
      this.avisoEntrega.set({ texto: 'No se pudo leer el archivo elegido.', mal: true });
      return;
    }
    const mes = this.mes();
    this.api.entregar(mes, b64).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.entregando.set(false);
        const ya = r.ya_registradas ? ` (${r.ya_registradas} ya estaban registradas)` : '';
        this.avisoEntrega.set({
          texto: `${r.nuevas} pólizas de ${r.mes} quedaron como entregadas${ya}. `
            + `La Suite las buscará en ContPAQi; las que no aparezcan en ${this.plazoDias()} días se avisan aquí.`,
          mal: false,
        });
        this.api.cuadre().pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({ next: (c) => this.cuadre.set(c), error: () => this.cuadre.set(null) });
      },
      error: (e) => {
        this.entregando.set(false);
        this.avisoEntrega.set({ texto: e?.error?.message ?? 'No se pudo marcar como entregado', mal: true });
      },
    });
  }

  elegir(alias: string, cuenta: string): void {
    this.elegido.update((m) => ({ ...m, [alias]: cuenta }));
  }

  /**
   * ⭐ Al confirmar se recarga la bandeja entera, no sólo la lista: el alias cambia **cuántos
   * movimientos entran al asiento**, y dejar los lotes con el número viejo sería mostrar un
   * resultado que ya no es cierto.
   */
  confirmar(f: PendienteProveedor): void {
    const cuenta = this.elegido()[f.alias_normalizado];
    if (!cuenta) return;
    this.guardando.set(f.alias_normalizado);
    this.avisoAlias.set(null);
    this.api.confirmarAlias({ concepto_banco: f.concepto_banco, cuenta, rubro: f.rubro })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardando.set(null);
          this.avisoAlias.set({ texto: `"${f.concepto_banco}" queda en ${cuenta}.`, mal: false });
          this.cargar();
        },
        error: (e) => {
          this.guardando.set(null);
          // El backend manda el motivo exacto (cuenta inexistente, rubro equivocado): se muestra
          // tal cual, porque es lo que hace falta leer para corregir.
          this.avisoAlias.set({ texto: e?.error?.message ?? 'No se pudo guardar', mal: true });
        },
      });
  }

  setMes(m: string): void { this.mes.set(m); this.filtro.set(null); this.sel.set(null); this.cargar(); }

  toggleMotivo(motivo: string | null): void {
    this.filtro.set(motivo !== null && this.filtro() === motivo ? null : motivo);
    this.sel.set(this.visibles()[0] ?? null);
  }

  lotesCon(motivo: string): number {
    return (this.data()?.lotes ?? []).filter((l) => (l.motivos?.[motivo] ?? 0) > 0).length;
  }

  motivosDe(l: LoteRow): { k: string; n: number }[] {
    return Object.entries(l.motivos ?? {})
      .map(([k, n]) => ({ k, n: Number(n) }))
      .sort((a, b) => b.n - a.n);
  }

  etiqueta(motivo: string): string { return etiquetaMotivo(motivo); }
  esDeNadie(motivo: string): boolean { return esDeNadie(motivo); }
  pct(n: number, total: number): number { return participacion(n, total); }

  /**
   * El rótulo sale del propio lote; si el backend no lo manda, se muestra la cuenta contable
   * tal cual. ⛔ No se inventa un alias: una cuenta mal rotulada en una pantalla de
   * contabilidad es peor que una cuenta sin rótulo.
   */
  banco(l: LoteRow): string { return l.banco_label || l.cuenta_banco; }
  fuente(l: LoteRow): string { return etiquetaFuente(l.fuente); }
}

/** Una fila de la tabla: el lote más la llave que `dataKey` necesita. */
type LoteVista = LoteRow & { k: string };

/**
 * ⭐ Etiquetas en el idioma de quien mira. La clave técnica sigue visible abajo del rótulo,
 * porque es lo que se cita al pedir el arreglo — pero no es lo primero que se lee.
 */
const ETIQUETA_MOTIVO: Record<string, string> = {
  sin_regla: 'Sin regla firmada',
  proveedor_sin_cuenta: 'Proveedor sin cuenta',
  no_aplica: 'No genera póliza',
  sin_centro_costo: 'Sin centro de costo',
  sin_medir: 'Categoría sin medir',
  contpaqi_cuenta: 'Cuenta fuera del crosswalk',
  importe_invalido: 'Importe no positivo',
  descuadre: 'Subtotal + IVA ≠ total',
  regla_sin_cuenta: 'Regla firmada sin cuenta',
  // `[CP.8.72]` Pagos a proveedor que no se arman solos: se cuentan en su lote, nunca entran incompletos.
  pago_a_confirmar: 'Pago a proveedor: confirmar qué facturas paga',
  pago_sin_resolver: 'Pago a proveedor sin identificar',
  pago_no_cuadra: 'Pago a proveedor: facturas − notas ≠ pagado',
  pago_proveedor_sin_cuenta: 'Pago a proveedor sin cuenta',
  pago_sin_facturas: 'Pago a proveedor sin facturas',
  pago_importe_invalido: 'Pago a proveedor con un CFDI en cero',
  pago_error: 'Pago a proveedor: error al armar',
};

/** `[CP.8.72]` De dónde salieron las facturas de un pago armado. */
export function etiquetaFuente(f: string | null | undefined): string {
  return f === 'cadena_kepler' ? 'lo que aplicó Kepler' : f === 'importe_una' ? 'una factura por importe'
    : f === 'confirmada' ? 'lo que confirmó contabilidad' : '—';
}

/**
 * `[CP.8.73]` Las candidatas en el orden en que se revisan: lo sugerido primero, después las más recientes.
 * (Medido: mediana 19 candidatas por pago, p90 98 — sin orden no se encuentran.)
 */
export function ordenarCandidatas(facturas: CfdiPropuesto[], sugerencia: string[]): (CfdiPropuesto & { sugerida: boolean })[] {
  const s = new Set(sugerencia);
  return facturas.map((f) => ({ ...f, sugerida: s.has(f.uuid) }))
    .sort((a, b) => (a.sugerida === b.sugerida ? (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0) : a.sugerida ? -1 : 1));
}

/**
 * `[CP.8.73]` La cuenta que decide si se puede confirmar: facturas − notas contra lo pagado. ⛔ Cuadra sólo con
 * al menos una factura y una diferencia menor a $1 (lo que el armador manda a redondeo); es la misma compuerta
 * del servidor, para que el botón no prometa lo que el servidor va a rechazar.
 */
export function cuadreDePago(
  facturas: CfdiPropuesto[], notas: CfdiPropuesto[], marcadasF: ReadonlySet<string>, marcadasN: ReadonlySet<string>, pagado: number,
): { facturas: number; notas: number; diferencia: number; cuadra: boolean } {
  const cent = (n: number): number => Math.round(Number(n) * 100);
  const f = facturas.filter((x) => marcadasF.has(x.uuid)).reduce((a, x) => a + cent(x.total), 0);
  const n = notas.filter((x) => marcadasN.has(x.uuid)).reduce((a, x) => a + cent(x.total), 0);
  const d = f - n - cent(pagado);
  return { facturas: f / 100, notas: n / 100, diferencia: d / 100, cuadra: marcadasF.size > 0 && Math.abs(d) < 100 };
}

/**
 * ⛔ **El único motivo que NO es trabajo de nadie**, y la razón de que esta pantalla exista.
 *
 * `no_aplica` significa que ya se midió que ese movimiento **no genera póliza** — no que falte
 * decidirlo. Son 148 de los 1,474 de enero (10.0 %). Sumarlos a los pendientes haría que la
 * bandeja pida trabajo que no existe, y el total es justo lo que alguien mira para estimar
 * cuánto falta.
 *
 * ⚠️ Es un conjunto, no un `if`, porque la lista va a crecer: cualquier motivo nuevo que
 * signifique «ya decidido» entra acá y en ningún otro lado.
 */
const MOTIVOS_DE_NADIE = new Set(['no_aplica']);

export function etiquetaMotivo(motivo: string): string {
  return ETIQUETA_MOTIVO[motivo] ?? motivo;
}

export function esDeNadie(motivo: string): boolean {
  return MOTIVOS_DE_NADIE.has(motivo);
}

/** ⚠️ Total cero devuelve 0, no `NaN`: una tabla con `NaN%` se lee como un defecto de datos. */
export function participacion(n: number, total: number): number {
  return total > 0 ? (n / total) * 100 : 0;
}

/** Cuántos movimientos ya están decididos y por lo tanto NO esperan a nadie. */
export function contarDeNadie(motivos: { motivo: string; movimientos: number }[]): number {
  return motivos.filter((m) => esDeNadie(m.motivo)).reduce((a, m) => a + m.movimientos, 0);
}

/** `[CP.8.14]` El nombre legible de una regla: la primera frase de su evidencia («Comisión bancaria.»). */
export function nombreDeRegla(r: { evidencia: string | null; categoria_code: string }): string {
  const f = (r.evidencia ?? '').split('.')[0].trim();
  return f && f.length <= 48 ? f : r.categoria_code;
}

/**
 * `[CP.8.14]` El código del indicio, SÓLO si está en el catálogo que se puede firmar: ofrecer
 * «usar el indicio» con una cuenta que el backend va a rechazar es invitar al error.
 */
export function codigoDeIndicio(indicio: string | null, cuentas: { codigo: string }[]): string | null {
  const m = /^(\d{10})/.exec(indicio ?? '');
  return m && cuentas.some((c) => c.codigo === m[1]) ? m[1] : null;
}

/**
 * `[CP.8.54]` Bytes → base64, por tramos: `String.fromCharCode(...bytes)` de un golpe revienta
 * la pila con un archivo de unos cientos de KB.
 */
export function aBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** El mes cerrado más reciente. ⚠️ No el actual: el mes en curso siempre se ve incompleto. */
function mesCerrado(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function mesesAtras(n: number): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  for (let i = 0; i < n; i++) {
    const v = d.toISOString().slice(0, 7);
    out.push({ value: v, label: v });
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}
