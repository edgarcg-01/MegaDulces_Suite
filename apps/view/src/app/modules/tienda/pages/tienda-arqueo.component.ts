import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, NgZone, OnInit, QueryList, ViewChild, ViewChildren, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService, ScopeOption } from '../../../core/services/data-scope.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, ArqueoResult, ArqueoRow, ArqueoTipo, Turno, TurnoCorte } from '../arqueo.service';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ARQUEO_TABS } from '../arqueo-tabs';
import { imprimirTicket } from '../ticket-arqueo';

/** Los cortes de una persona, tal como los pide la fila desplegada. */
interface CortesPersona {
  loading: boolean; error: boolean;
  turnos: TurnoCorte[];
  /** Cuantos de esos cortes tienen arqueo nuestro - el resto es dinero sin verificar. */
  arqueados: number; pct: number;
}

/**
 * Proyecto Tienda — Arqueo ciego de caja para CAJERAS (/tienda/arqueo).
 *
 * **El turno lo manda Kepler.** El ERP ya sabe qué caja le tocó a quién y desde qué
 * hora: abre el renglón del corte con la caja, la cajera asignada y la hora de
 * apertura. Así que acá no se teclea nada del encabezado — sucursal, caja, fecha y
 * cajero **salen del turno** y se muestran de solo lectura. Sin turno abierto no hay
 * arqueo: eso evita arquear la caja de otra o un turno que no existió. El supervisor
 * conserva una captura manual para relevo/contingencia.
 *
 * **La cajera solo ve lo suyo**: su total contado y su historial. No ve el esperado
 * ni su diferencia — mostrarle la diferencia equivale a mostrarle el esperado
 * (esperado = contado + diferencia), y con eso el arqueo deja de ser ciego: se puede
 * recapturar "ajustando". El supervisor revela en /almacen/cuadre. El descuadre se
 * levanta igual en su bandeja (autolineado SM.9): la cajera no lo ve, pero pasa.
 *
 * La encargada cierra el circuito **validando presencialmente** desde el historial.
 *
 * Superficie Operations, PrimeNG denso, dark-safe. §13: captura de dinero → guard de
 * estado sucio + botón que se auto-deshabilita síncrono al 1er clic (anti doble-corte).
 */
@Component({
  selector: 'app-tienda-arqueo',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, ToastModule,
    SelectModule, SegmentedComponent, InputTextModule, TagModule, DialogModule,
    ContextHelpComponent, FreshnessPillComponent, PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in arq-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="arqueoTabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueo de caja</h1>
          <p class="surf-page-sub">
            Cuenta el efectivo físico de <strong>hoy</strong> por denominación y guárdalo.
            @if (revela) { Al guardar, el sistema te muestra la diferencia real. }
            @else { El cuadre lo revisa tu encargada. }
          </p>
        </div>
        <div class="arq-head-right">
          <!-- [VP.0.2] Decía label="Kepler" sobre un new Date() del navegador: se leía como "los datos
               de Kepler tienen 3 minutos" y era la hora en que cargó esta pantalla. -->
          <app-freshness-pill measures="fetch" [since]="turnosAl()" [staleAfterSec]="180" />
          <app-context-help topic="arqueo" />
        </div>
      </header>

      <!-- Apilado, no dos columnas: en paralelo la captura quedaba en una columna
           angosta —las denominaciones en una sola fila y los medios amontonados—
           mientras el historial ocupaba el doble de ancho para una tabla que se
           mira después, no mientras se cuenta. A lo ancho, el conteo respira y el
           historial queda donde va: abajo. -->
      <div class="arq-stack">
        <!-- Captura -->
        @if (canCapture()) {
        <div class="card-premium card-flat arq-panel">
          <h3 class="arq-card-title">Nuevo arqueo</h3>

          @if (cargandoTurnos()) {
            <p class="muted arq-msg">Buscando tus turnos en Kepler…</p>
          } @else if (!turnos().length && !manual()) {
            <!-- Sin turno no hay arqueo: es la guarda que impide inventar un corte. -->
            <div class="arq-vacio">
              <i class="pi pi-clock"></i>
              <div>
                <strong>Hoy no tienes cortes por arquear.</strong>
                <p class="muted">El arqueo aparece aquí cuando Kepler cierra tu caja. Si ya cortaste en el punto de venta y no lo ves, avísale a tu encargada.</p>
                @if (revela) {
                  <p-button type="button" label="Capturar sin turno" icon="pi pi-pencil" styleClass="p-button-sm p-button-text"
                            (click)="manual.set(true)"></p-button>
                }
              </div>
            </div>
          }

          @if (turnos().length && !manual()) {
            @if (turnos().length > 1) {
              <!-- En una sola línea: partido en tres, el navegador colapsaba los saltos
                   y dejaba el punto huérfano al principio del renglón siguiente. -->
              <p class="arq-lbl arq-turno-lbl">Tienes <strong>{{ turnos().length }} cortes de hoy</strong> sin arquear. Se cierran del más viejo al más nuevo, y el que está abierto también se puede contar.</p>
              <div class="arq-turnos">
                @for (t of turnosOrdenados(); track t.folio + t.warehouse_code; let i = $index) {
                  <!-- Solo el más viejo es accionable: los cortes se cierran en orden.
                       El backend lo exige igual — esto solo lo hace visible. -->
                  <button type="button" class="arq-turno" [class.sel]="t.folio === turnoFolio()"
                          [class.bloq]="i > 0" [disabled]="i > 0"
                          [attr.title]="i > 0 ? 'Primero cierra el corte pendiente más viejo' : null"
                          (click)="elegirTurno(t.folio)">
                    <span class="arq-turno-caja"><span class="arq-turno-n">{{ i + 1 }}º</span> Caja {{ t.caja }}</span>
                    <span class="arq-turno-meta">{{ branchLabel(t.warehouse_code) }} · {{ t.business_date | date:'dd/MM' }}</span>
                    <span class="arq-turno-meta">{{ t.abierto ? 'Abierta desde ' + (t.hora_apertura || '—') : 'Cerró ' + (t.hora_cierre || '—') }}</span>
                    <!-- SM.34 — el turno abierto TAMBIÉN se arquea: contar antes del
                         corte es la única ventana en que el efectivo de las sangrías
                         todavía está en el cajón. Antes este chip sólo salía con la
                         caja cerrada y la pantalla se leía como "esperá el cierre". -->
                    @if (i === 0) {
                      <span class="arq-pide">{{ t.abierto ? 'Podés arquear ahora' : 'Te toca arquear' }}</span>
                    }
                    @if (i > 0) { <span class="arq-bloq-txt">Después de cerrar el anterior</span> }
                  </button>
                }
              </div>
            }

            @if (turnoSel(); as t) {
              @if (t.abierto && avisoCorte(t); as a) {
                <!-- Su caja tiene un horario propio y es predecible: se avisa antes
                     de que Kepler cierre, para que cuente con calma en vez de a las
                     apuradas. Solo cuando el histórico es consistente. -->
                <div class="arq-prox" [class.ya]="a.pronto">
                  <i class="pi pi-clock"></i>
                  <div>
                    <strong>{{ a.titulo }}</strong>
                    <p class="muted">{{ a.detalle }}</p>
                  </div>
                </div>
              }
              @if (t.abierto) {
                <!-- SM.34 — Tu caja sigue abierta y eso NO es un impedimento: se
                     cuenta ahora. El backend siempre lo aceptó; lo que faltaba era
                     que la pantalla lo dijera en vez de sugerir la espera. -->
                <div class="arq-pide-box">
                  <i class="pi pi-inbox"></i>
                  <div>
                    <strong>Tu caja sigue abierta{{ t.hora_apertura ? ' desde las ' + t.hora_apertura : '' }} — podés contar ahora.</strong>
                    <p class="muted">No hace falta esperar el corte. Lo que cuentes queda a tu nombre.</p>
                  </div>
                </div>
              } @else {
                <!-- Kepler cerró la caja: el arqueo sigue siendo lo que toca. Se
                     quitó el "hace N minutos" — era el cronómetro, y medía el
                     momento equivocado: para cuando cierra, el efectivo de las
                     sangrías ya salió del cajón. -->
                <div class="arq-pide-box">
                  <i class="pi pi-bell"></i>
                  <div>
                    <strong>Kepler cerró tu caja{{ t.hora_cierre ? ' a las ' + t.hora_cierre : '' }}. Te toca arquear.</strong>
                  </div>
                </div>
              }
              <!-- Encabezado NO editable: cada dato viene del turno de Kepler. -->
              <div class="arq-datos">
                <div><span class="arq-ev-k">Sucursal</span><span class="arq-ev-v">{{ branchLabel(t.warehouse_code) }}</span></div>
                <div><span class="arq-ev-k">Caja</span><span class="arq-ev-v strong">{{ t.caja }}</span></div>
                <div><span class="arq-ev-k">Fecha</span><span class="arq-ev-v">{{ t.business_date | date:'dd/MM/yy' }}</span></div>
                <div><span class="arq-ev-k">Cajero</span><span class="arq-ev-v">{{ t.cajero_code || '—' }}</span></div>
                <div><span class="arq-ev-k">{{ t.abierto ? 'Abrió' : 'Cerró' }}</span><span class="arq-ev-v">{{ (t.abierto ? t.hora_apertura : t.hora_cierre) || '—' }}</span></div>
                <div><span class="arq-ev-k">Turno Kepler</span><span class="arq-ev-v">#{{ t.folio }}</span></div>
              </div>
            }
          }

          @if (manual()) {
            <!-- Escape hatch del supervisor: relevo, contingencia, caja sin Kepler. -->
            <div class="arq-head">
              <label class="arq-lbl">Sucursal
                <p-select #hcell [options]="sucursalOptions()" [(ngModel)]="aSuc" (ngModelChange)="dirty.set(true)"
                          optionLabel="label" optionValue="value" styleClass="arq-fld arq-fld-suc"
                          appendTo="body" placeholder="Elige…" [filter]="sucursales().length > 8" filterBy="label"
                          (keydown)="onHeadKey($event, 0)" />
              </label>
              <label class="arq-lbl">Caja <input #hcell pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCaja" (ngModelChange)="dirty.set(true)" placeholder="2" (keydown)="onHeadKey($event, 1)" (focus)="selectAll($event)"></label>
              <!-- Sin selector de fecha: un arqueo es de HOY. Elegir una fecha
                   pasada permitiría sellar dinero de un día que ya cerró. -->
              <label class="arq-lbl">Fecha <span class="arq-fijo">{{ hoyTxt() }}</span></label>
              <label class="arq-lbl">Cajero <input #hcell pInputText class="arq-fld arq-fld-cajero" [(ngModel)]="aCajero" (ngModelChange)="dirty.set(true)" placeholder="código" (keydown)="onHeadKey($event, 2)" (focus)="selectAll($event)"></label>
              @if (turnos().length) {
                <p-button type="button" label="Volver a mis turnos" icon="pi pi-arrow-left" styleClass="p-button-sm p-button-text" (click)="manual.set(false)"></p-button>
              }
            </div>
          }

          @if (puedeContar()) {
            <app-segmented [options]="tipoOptions" [value]="aTipo()" (valueChange)="elegirTipo($event)"
                           (saltarAbajo)="focusHead(0)" ariaLabel="Tipo de arqueo" />
            @if (aTipo() === 'relevo') {
              <label class="arq-lbl arq-block">Cajero entrante <input pInputText class="arq-fld" [(ngModel)]="aEntrante" (ngModelChange)="dirty.set(true)" placeholder="quién recibe la caja"></label>
            }

            <!-- SM.27 — Tres bloques a lo ancho, el formato de la hoja que ya se usa
                 en piso: BILLETES | MONEDAS | MEDIOS. El billete y la moneda se
                 cuentan por separado (dos fajos distintos, dos totales que se
                 verifican aparte) y los medios quedan **al lado** de las monedas,
                 no debajo: la columna de monedas es corta y ese hueco era el lugar
                 natural del voucher y los cheques. Grid intrínseco (§9): en una
                 pantalla angosta las tres columnas se apilan solas. -->
            <div class="arq-cols">
              <section class="arq-col" role="group" aria-label="Registro detallado de billetes">
                <h4 class="arq-col-t">Registro detallado de billetes</h4>
                <div class="arq-col-rows">
                  @for (d of billetes; track d; let i = $index) {
                    <label class="arq-den">
                      <span class="arq-den-lbl">{{ '$' + d }}</span>
                      <!-- Input de texto (no p-inputnumber) a propósito: acá ↑/↓ SALTAN de
                           casilla en vez de sumar/restar. Con el spinner puesto, una flecha
                           de más cambia el conteo del billete sin que la cajera lo note. -->
                      <input #denomInput pInputText class="arq-num" inputmode="numeric" autocomplete="off"
                             [attr.aria-label]="'Cantidad de billetes de $' + d"
                             [value]="denomCount[d] ?? ''" placeholder="0"
                             (input)="onDenomInput(d, $event)" (keydown)="onCellKey($event, 0, i)" (focus)="selectAll($event)">
                      <span class="arq-den-sub">{{ (denomCount[d] || 0) ? money((denomCount[d] || 0) * d) : '' }}</span>
                    </label>
                  }
                </div>
                <div class="arq-col-tot">
                  <span>Total</span>
                  <span class="arq-col-pz">{{ pzasBilletes() }} pzas</span>
                  <span class="arq-col-mn">{{ money(totBilletes()) }}</span>
                </div>
              </section>

              <section class="arq-col" role="group" aria-label="Registro detallado de monedas">
                <h4 class="arq-col-t">Registro detallado de monedas</h4>
                <div class="arq-col-rows">
                  @for (d of monedas; track d; let i = $index) {
                    <label class="arq-den">
                      <span class="arq-den-lbl">{{ d >= 1 ? '$' + d : (d*100) + '¢' }}</span>
                      <input #denomInput pInputText class="arq-num" inputmode="numeric" autocomplete="off"
                             [attr.aria-label]="'Cantidad de monedas de ' + (d >= 1 ? '$' + d : (d*100) + ' centavos')"
                             [value]="denomCount[d] ?? ''" placeholder="0"
                             (input)="onDenomInput(d, $event)" (keydown)="onCellKey($event, 1, i)" (focus)="selectAll($event)">
                      <span class="arq-den-sub">{{ (denomCount[d] || 0) ? money((denomCount[d] || 0) * d) : '' }}</span>
                    </label>
                  }
                </div>
                <div class="arq-col-tot">
                  <span>Total</span>
                  <span class="arq-col-pz">{{ pzasMonedas() }} pzas</span>
                  <span class="arq-col-mn">{{ money(totMonedas()) }}</span>
                </div>
              </section>

              <!-- SM.24 — El corte no es solo efectivo: Kepler arquea seis renglones.
                   Acá se declara el total de cada uno (el voucher de la terminal, el
                   fajo de cheques, los vales). El efectivo NO se repite: sale del
                   conteo de las dos columnas de la izquierda. -->
              @if (aTipo() !== 'relevo') {
                <section class="arq-col arq-col--medios" role="group" aria-label="Medios de pago y movimientos">
                  <h4 class="arq-col-t">Medios de pago y movimientos</h4>
                  <div class="arq-col-rows">
                    @for (m of mediosCampos; track m.key; let i = $index) {
                      <label class="arq-den arq-medio">
                        <span class="arq-medio-lbl">{{ m.label }}</span>
                        <!-- Mismo #medioInput y mismo handler que las denominaciones: la
                             cadena de saltos es UNA sola de punta a punta (↓ en 50¢ cae en
                             Tarjeta). Si los medios quedan fuera, el operario teclea seis
                             casillas con el pulgar y toca la pantalla con guantes. -->
                        <input #medioInput pInputText class="arq-num arq-medio-num" inputmode="decimal" autocomplete="off"
                               [attr.aria-label]="m.label"
                               [value]="medios[m.key] ?? ''" placeholder="0.00"
                               (input)="onMedioInput(m.key, $event)" (keydown)="onCellKey($event, 2, i)" (focus)="selectAll($event)">
                      </label>
                    }
                  </div>
                  <div class="arq-col-tot">
                    <span>Total</span>
                    <span class="arq-col-mn">{{ money(totMedios()) }}</span>
                  </div>
                  @if (aTipo() === 'cierre') {
                    <label class="arq-lbl arq-inc">Incidencia
                      <p-select [options]="incidenciaOptions" [(ngModel)]="aIncidencia" (ngModelChange)="dirty.set(true)"
                                optionLabel="label" optionValue="value" styleClass="arq-fld" appendTo="body" placeholder="Ninguna" />
                    </label>
                  }
                </section>
              }
            </div>
            <p class="arq-hint"><i class="pi pi-arrows-alt" aria-hidden="true"></i>
              Usa <kbd>↑</kbd> <kbd>↓</kbd> dentro de la columna, <kbd>←</kbd> <kbd>→</kbd> para cambiar de columna,
              y <kbd>Enter</kbd> para avanzar. Abajo de la última casilla está el botón de guardar.</p>
            <label class="arq-lbl arq-block">Nota <input pInputText class="arq-fld" [(ngModel)]="aNota" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label>

            <!-- Barra pegada al fondo: contando billetes se scrollea todo el rato, y
                 tanto el total como el botón quedaban fuera de vista. Son las dos
                 únicas cosas que la cajera necesita a mano todo el tiempo. -->
            <div class="arq-bar">
              <div class="arq-bar-total">
                <span class="arq-bar-l">Total contado</span>
                <span class="arq-bar-v">{{ money(totalTurno()) }}</span>
                <!-- El total del turno es uno, pero se dice de qué está hecho: el
                     efectivo es lo único que se cuenta a ciegas y lo único que se
                     compara contra el efectivo esperado del corte. Sin esta línea,
                     un total que incluye tarjeta se lee como "esto es lo que hay en
                     el cajón" y no lo es. -->
                @if (totMedios() > 0) {
                  <span class="arq-bar-desg">Efectivo {{ money(arqTotal()) }} · Otros medios {{ money(totMedios()) }}</span>
                }
              </div>
              <!-- El botón es el último eslabón de la cadena: ↓ en la última casilla de
                   cualquier columna cae acá, y ↑ vuelve a esa misma casilla. Así el
                   arqueo entero se captura y se sella sin soltar el teclado. -->
              <p-button #btnGuardar type="button" [label]="submitLabel()" icon="pi pi-lock"
                      [disabled]="!canSubmit() || saving()" [loading]="saving()"
                      (keydown)="onBotonKey($event)" (click)="confirmar()"></p-button>
            </div>
          }

          @if (result(); as r) {
            <div class="arq-result" [class.bad]="revela && (r.diff_real || 0) > 0" [class.ok]="revela && (r.diff_real || 0) < 0">
              @if (r.tipo === 'relevo') {
                <p class="muted">Relevo sellado: {{ money(r.total_contado) }} entregados a {{ aEntrante || '—' }}.</p>
              } @else if (!r.reveal) {
                <!-- Cajera: se confirma el hecho, no el cuadre. -->
                <div class="arq-cmp">
                  <div><span class="arq-ev-k">Guardado — total contado</span><span class="arq-ev-v strong">{{ money(r.total_contado) }}</span></div>
                </div>
                <p class="muted arq-mt">Quedó sellado con la hora. Falta que tu encargada lo valide en tu lugar.</p>
              } @else if (r.ambiguous) {
                <p class="muted">Guardado ({{ money(r.total_contado) }}). Hay <strong>varios cortes</strong> en esta caja hoy — captura desde el turno para comparar contra el correcto.</p>
              } @else if (!r.matched) {
                <p class="muted">Guardado. El turno todavía no cerró en Kepler — la diferencia aparece cuando se procese el corte.</p>
              } @else {
                <div class="arq-cmp">
                  <div><span class="arq-ev-k">Contado</span><span class="arq-ev-v strong">{{ money(r.total_contado) }}</span></div>
                  <div><span class="arq-ev-k">Esperado</span><span class="arq-ev-v">{{ money(r.esperado || 0) }}</span></div>
                  <div><span class="arq-ev-k">{{ diffLabel(r.diff_real) }}</span><span class="arq-ev-v strong" [class.bad]="(r.diff_real||0)>0" [class.ok]="(r.diff_real||0)<0">{{ signed(r.diff_real || 0) }}</span></div>
                </div>
              }
              @if (r.tipo !== 'relevo') {
                <!-- El respaldo se imprime ACÁ, con el cajón todavía abierto y las
                     dos personas presentes. Mandarlas al historial a buscarlo es
                     pedirles que firmen un papel media hora después del conteo. -->
                <button pButton type="button" class="p-button-sm p-button-text arq-print" (click)="imprimir(r)">
                  <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span>
                  <span class="p-button-label">Imprimir ticket</span>
                </button>
              }
            </div>
          }
        </div>
        }

        <!-- Historial. A la cajera sin arqueos no se le muestra una tabla vacía:
             ocupaba media pantalla para decir "nada todavía" en el momento en que
             está contando billetes de pie frente a la caja. -->
        @if (revela || rows().length) {
        <div class="card-premium card-flat arq-panel">
          <!-- SM.33 - El rotulo cambia porque el CONTENIDO cambia: sin
               supervision el backend devuelve solo el dia (no es un filtro
               de pantalla). Decir "recientes" sobre una lista de hoy es
               mentir sobre lo que hay, y la cajera creeria que perdio
               arqueos viejos. -->
          <h3 class="arq-card-title">{{ revela ? 'Arqueos recientes' : 'Tus cortes de hoy' }}</h3>
          <p-table [value]="rows()" dataKey="id" styleClass="p-datatable-sm arq-table" [rowHover]="true" [loading]="loading()">
            <ng-template #header>
              <tr>
                <th class="arq-ex-th" scope="col"><span class="sr-only">Detalle</span></th>
                <th>Fecha</th>
                @if (variasSucursales()) { <th>Sucursal</th> }
                <th>Caja</th><th>Cajero</th>
                @if (revela) {
                  <!-- Los tres números de la validación, en el orden en que se leen:
                       lo que debería haber · lo que Kepler declara · lo que contamos. -->
                  <th class="ta-r">Esperado</th>
                  <th class="ta-r">Arqueo Kepler</th>
                  <th class="ta-r">Nuestro arqueo</th>
                  <th class="ta-r">Diferencia</th>
                } @else {
                  <th class="ta-r">Contado</th>
                }
                <th>Validado</th>
              </tr>
            </ng-template>
            <ng-template #body let-b let-expanded="expanded">
              <tr>
                <td class="arq-ex-td">
                  <p-button type="button" [text]="true" size="small"
                            [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
                            [ariaLabel]="expanded ? 'Cerrar el detalle' : 'Ver el conteo y los cortes de esta persona'"
                            [pRowToggler]="b" (click)="onExpand(b)"></p-button>
                </td>
                <td>{{ b.business_date | date:'dd/MM/yy' }}</td>
                @if (variasSucursales()) { <td>{{ branchLabel(b.warehouse_code) }}</td> }
                <td>{{ b.caja }}@if (b.tipo === 'relevo') { <p-tag value="Relevo" severity="info" styleClass="arq-tag-mini" /> }</td>
                <td>{{ b.cajero_nombre || b.cajero_code || '—' }}@if (b.tipo === 'relevo' && b.cajero_entrante) { <span class="muted"> → {{ b.cajero_entrante }}</span> }</td>
                @if (revela) {
                  <td class="ta-r muted">{{ b.esperado != null ? money(b.esperado) : '—' }}</td>
                  <td class="ta-r">
                    {{ b.kepler_contado != null ? money(b.kepler_contado) : '—' }}
                    @if (b.kepler_enmascaro) {
                      <!-- Kepler cerró el corte "cuadrado" y el conteo real dice otra cosa. -->
                      <span class="arq-mask" title="Kepler dio este corte por cuadrado">enmascaró</span>
                    }
                  </td>
                  <!-- El nuestro es el que vale: va destacado. -->
                  <td class="ta-r strong">{{ money(b.total_contado) }}</td>
                  <td class="ta-r strong" [class.bad]="(b.diff_real||0)>0" [class.ok]="(b.diff_real||0)<0">
                    {{ b.diff_real != null ? signed(b.diff_real) : '—' }}
                    @if (b.diff_real != null && b.diff_real !== 0) { <span class="arq-dif-l">{{ b.diff_real > 0 ? 'faltan' : 'sobran' }}</span> }
                  </td>
                } @else {
                  <td class="ta-r strong">{{ money(b.total_contado) }}</td>
                }
                <td>
                  @if (b.validado_at) {
                    <span class="arq-ok" [title]="'Validado por ' + (b.validado_por || '?')"><i class="pi pi-check-circle"></i> {{ b.validado_por || 'sí' }}</span>
                  } @else if (revela) {
                    <p-button type="button" label="Validar" icon="pi pi-check" styleClass="p-button-sm p-button-text"
                              [disabled]="validando() === b.id" (click)="validar(b)"></p-button>
                  } @else {
                    <span class="muted">Pendiente</span>
                  }
                </td>
              </tr>
            </ng-template>
            <!-- SM.25 - La fila se abre a lo que RESPALDA el numero. Dos cosas, en
                 el orden en que se preguntan: (1) el conteo pieza por pieza - lo
                 unico que Kepler no tiene, y por lo tanto la unica evidencia de
                 como se llego al total - contra el desglose grueso del ERP; y
                 (2) los cortes que Kepler le abrio a esa persona, **incluidos los
                 que nadie arqueo**, que son los que hay que perseguir. Se carga al
                 desplegar, no antes: son 30 dias de cortes por persona y la
                 pantalla arranca con una cajera contando billetes, no auditando. -->
            <ng-template #expandedrow let-b>
              <tr class="arq-exp-tr">
                <td [attr.colspan]="colspan()" class="arq-exp">
                  <div class="arq-exp-grid">
                    <section class="arq-exp-block">
                      <h4 class="arq-exp-t">Nuestro conteo</h4>
                      @if (b.denominaciones?.length) {
                        <table class="arq-mini-t">
                          <tbody>
                            @for (d of b.denominaciones; track d.denominacion) {
                              <tr>
                                <td class="arq-mono">{{ d.denominacion >= 1 ? '$' + d.denominacion : (d.denominacion * 100) + '¢' }}</td>
                                <td class="arq-mono muted">× {{ d.cantidad }}</td>
                                <td class="ta-r">{{ money(d.subtotal) }}</td>
                              </tr>
                            }
                          </tbody>
                          <tfoot>
                            <tr class="arq-mini-total"><td>Total contado</td><td></td><td class="ta-r strong">{{ money(b.total_contado) }}</td></tr>
                          </tfoot>
                        </table>
                        <p class="arq-exp-note">Billetes {{ money(b.nuestro_billetes) }} · Monedas {{ money(b.nuestro_monedas) }}</p>
                      } @else {
                        <p class="muted arq-exp-note">Se guardó sin desglose por denominación.</p>
                      }
                    </section>

                    <!-- El bloque de Kepler es del supervisor: sus billetes y monedas
                         SUMAN el contado declarado, asi que mostrarlos a la cajera es
                         mostrarle el esperado en partes - y el arqueo deja de ser ciego. -->
                    @if (revela) {
                    <section class="arq-exp-block">
                      <h4 class="arq-exp-t">Kepler declara</h4>
                      @if (b.tipo !== 'cierre') {
                        <p class="muted arq-exp-note">Un {{ b.tipo }} es intra-turno: el corte todavía no existe, no hay contra qué comparar.</p>
                      } @else if (b.kepler_contado == null && b.esperado == null) {
                        <p class="muted arq-exp-note">El turno todavía no cerró en el ERP.</p>
                      } @else {
                        <table class="arq-mini-t">
                          <tbody>
                            <tr><td>Billetes</td><td></td><td class="ta-r">{{ b.kepler_billetes != null ? money(b.kepler_billetes) : '—' }}</td></tr>
                            <tr><td>Monedas</td><td></td><td class="ta-r">{{ b.kepler_monedas != null ? money(b.kepler_monedas) : '—' }}</td></tr>
                            <tr><td>Retirado</td><td></td><td class="ta-r">{{ b.kepler_retirado != null ? money(b.kepler_retirado) : '—' }}</td></tr>
                          </tbody>
                          <tfoot>
                            <tr class="arq-mini-total"><td>Contado declarado</td><td></td><td class="ta-r strong">{{ b.kepler_contado != null ? money(b.kepler_contado) : '—' }}</td></tr>
                            <tr><td>Esperado</td><td></td><td class="ta-r">{{ b.esperado != null ? money(b.esperado) : '—' }}</td></tr>
                          </tfoot>
                        </table>
                        @if (b.kepler_desglose_cuadra === false) {
                          <p class="arq-exp-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                            Billetes + monedas + retirado no dan el contado: {{ money(b.kepler_desglose_faltante || 0) }} sin explicar (suele ser un retiro que nadie registró).</p>
                        }
                        @if (b.kepler_enmascaro) {
                          <p class="arq-exp-warn"><i class="pi pi-eye-slash" aria-hidden="true"></i>
                            Kepler dio el corte por cuadrado y nuestro conteo dice otra cosa.</p>
                        }
                      }
                    </section>
                    }
                  </div>

                  <div class="arq-exp-meta">
                    @if (b.cash_cut_folio) { <span><span class="arq-ev-k">Corte</span><span class="arq-mono">#{{ b.cash_cut_folio }}</span></span> }
                    @if (b.turno) { <span><span class="arq-ev-k">Turno</span>{{ b.turno }}</span> }
                    @if (b.incidencia_tipo) { <span><span class="arq-ev-k">Incidencia</span>{{ incidenciaLabel(b.incidencia_tipo) }}</span> }
                    <span><span class="arq-ev-k">Capturó</span>{{ b.captured_by || '—' }}@if (b.captured_at) { <span class="muted"> · {{ b.captured_at | date:'dd/MM HH:mm' }}</span> }</span>
                    <span><span class="arq-ev-k">Validado</span>@if (b.validado_at) { {{ b.validado_por || 'sí' }}<span class="muted"> · {{ b.validado_at | date:'dd/MM HH:mm' }}</span> } @else { <span class="muted">pendiente</span> }</span>
                    @if (b.nota) { <span class="arq-exp-nota"><span class="arq-ev-k">Nota</span>{{ b.nota }}</span> }
                  </div>

                  <section class="arq-exp-block arq-exp-cortes">
                    <h4 class="arq-exp-t">
                      Sus cortes y arqueos
                      <span class="muted">— {{ b.cajero_nombre || b.cajero_code || 'sin cajero' }} · últimos {{ cortesDias }} días</span>
                    </h4>
                    @if (!b.cajero_code) {
                      <p class="muted arq-exp-note">Este arqueo no quedó a nombre de nadie, así que no hay cortes que cruzar.</p>
                    } @else if (cortesDe(b); as c) {
                      @if (c.loading) {
                        <p class="muted arq-exp-note"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando sus cortes en Kepler…</p>
                      } @else if (c.error) {
                        <div class="arq-exp-warn">
                          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudieron traer los cortes.
                          <p-button type="button" label="Reintentar" [text]="true" size="small" (click)="onExpand(b, true)"></p-button>
                        </div>
                      } @else if (!c.turnos.length) {
                        <p class="muted arq-exp-note">Kepler no le abrió ningún corte en el período.</p>
                      } @else {
                        <table class="arq-mini-t arq-cortes-t">
                          <thead>
                            <tr>
                              <th scope="col">Fecha</th><th scope="col">Caja</th><th scope="col">Corte</th><th scope="col">Turno</th>
                              <th scope="col">Arqueo</th><th scope="col" class="ta-r">Contado</th>
                              @if (revela) { <th scope="col" class="ta-r">Diferencia</th> }
                            </tr>
                          </thead>
                          <tbody>
                            @for (t of c.turnos; track t.business_date + '|' + t.caja + '|' + t.folio) {
                              <!-- El corte de ESTA fila va marcado: si no, en una lista de 30
                                   no se sabe cual de todos es el que se esta mirando. -->
                              <tr [class.sel]="!!t.arqueo_id && t.arqueo_id === b.id">
                                <td>{{ t.business_date | date:'dd/MM/yy' }}</td>
                                <td>{{ t.caja }}</td>
                                <td class="arq-mono muted">#{{ t.folio }}</td>
                                <td class="muted">{{ (t.hora_apertura || '—') | slice:0:5 }} → {{ t.hora_cierre ? (t.hora_cierre | slice:0:5) : 'abierta' }}</td>
                                <td>
                                  @if (t.arqueo_id) {
                                    <span class="arq-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> {{ t.capturado_at ? (t.capturado_at | date:'HH:mm') : 'sí' }}</span>
                                  } @else if (t.hora_cierre) {
                                    <!-- Corte cerrado sin conteo: el dinero de ese turno nunca se verifico. -->
                                    <span class="arq-sin"><i class="pi pi-times-circle" aria-hidden="true"></i> sin arqueo</span>
                                  } @else {
                                    <span class="muted">turno abierto</span>
                                  }
                                </td>
                                <td class="ta-r strong">{{ t.nuestro_contado != null ? money(t.nuestro_contado) : '—' }}</td>
                                @if (revela) {
                                  <td class="ta-r strong" [class.bad]="(t.diff_real || 0) > 0" [class.ok]="(t.diff_real || 0) < 0">{{ t.diff_real != null ? signed(t.diff_real) : '—' }}</td>
                                }
                              </tr>
                            }
                          </tbody>
                        </table>
                        <p class="arq-exp-note">
                          <strong>{{ c.arqueados }}</strong> de {{ c.turnos.length }} cortes con arqueo ({{ c.pct }}%){{ c.turnos.length - c.arqueados ? ' · ' + (c.turnos.length - c.arqueados) + ' sin contar' : '' }}
                        </p>
                      }
                    }
                  </section>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td [attr.colspan]="colspan()" class="arq-empty">{{ revela ? 'Sin arqueos aún.' : 'Todavía no capturaste ningún corte hoy.' }}</td></tr></ng-template>
          </p-table>
        </div>
        }
      </div>

    <!-- §13 poka-yoke del dinero: sellar un corte es irreversible (queda con hora y
         se imprime el respaldo), así que antes se muestra QUÉ se va a sellar. No es
         un "¿estás seguro?" vacío: es el resumen que la persona compara contra los
         fajos que tiene en la mano. El ticket sale después del sí, no antes. -->
    <p-dialog [(visible)]="confirmando" [modal]="true" [draggable]="false" [resizable]="false"
              [dismissableMask]="true" [style]="{ width: '30rem', maxWidth: '95vw' }"
              styleClass="arq-cfm-dlg" [header]="confirmTitulo()">
      <div class="arq-cfm">
        <div class="arq-cfm-hd">
          @if (turnoSel(); as t) {
            <span>{{ branchLabel(t.warehouse_code) }} · Caja {{ t.caja }}</span>
            <span class="muted">{{ t.cajero_code || '—' }} · {{ t.business_date | date:'dd/MM/yy' }}</span>
          } @else {
            <span>{{ branchLabel(aSuc) || '—' }} · Caja {{ aCaja || '—' }}</span>
            <span class="muted">{{ aCajero || '—' }} · {{ hoyTxt() }}</span>
          }
        </div>

        <table class="arq-cfm-t">
          <tbody>
            <tr>
              <td>Billetes</td>
              <td class="ta-r muted">{{ pzasBilletes() }} pzas</td>
              <td class="ta-r">{{ money(totBilletes()) }}</td>
            </tr>
            <tr>
              <td>Monedas</td>
              <td class="ta-r muted">{{ pzasMonedas() }} pzas</td>
              <td class="ta-r">{{ money(totMonedas()) }}</td>
            </tr>
            <tr class="arq-cfm-sub">
              <td>Efectivo contado</td>
              <td class="ta-r muted">{{ pzasBilletes() + pzasMonedas() }} pzas</td>
              <td class="ta-r strong">{{ money(arqTotal()) }}</td>
            </tr>
            <!-- Solo los medios declarados: cinco ceros no son información. -->
            @for (m of mediosDeclarados(); track m.key) {
              <tr><td>{{ m.label }}</td><td></td><td class="ta-r">{{ money(m.monto) }}</td></tr>
            }
          </tbody>
          <tfoot>
            <tr><td>Total del turno</td><td></td><td class="ta-r strong">{{ money(totalTurno()) }}</td></tr>
          </tfoot>
        </table>

        @if (aTipo() === 'relevo' && aEntrante.trim()) {
          <p class="arq-cfm-n">Se entrega a <strong>{{ aEntrante }}</strong>.</p>
        }
        @if (aIncidencia) { <p class="arq-cfm-n">Incidencia: <strong>{{ incidenciaLabel(aIncidencia) }}</strong></p> }
        @if (aNota.trim()) { <p class="arq-cfm-n">Nota: {{ aNota }}</p> }

        <p class="arq-cfm-w">
          <i class="pi pi-lock" aria-hidden="true"></i>
          Queda sellado con la hora y se imprime el respaldo.
          @if (revela) { Al guardar se te muestra la diferencia. } @else { Tu encargada lo valida después. }
        </p>
      </div>

      <ng-template #footer>
        <p-button type="button" label="Revisar de nuevo" [text]="true" severity="secondary"
                  [disabled]="saving()" (click)="confirmando.set(false)"></p-button>
        <p-button type="button" [label]="confirmCta()" icon="pi pi-check"
                  [disabled]="saving()" [loading]="saving()" (click)="submit()"></p-button>
      </ng-template>
    </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .arq-head-right { display: inline-flex; align-items: center; gap: .4rem; margin-left: auto; }
    /* minmax(0,1fr), no 1fr: 1fr es minmax(auto,1fr) y no baja del
       min-content de la tarjeta. Con auto el historial (tabla de 10 columnas)
       estiraba la columna mas alla del ancho de la pantalla. */
    .arq-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    /* SM.31 - El panel es el contenedor de consulta (DESIGN §9: @container para
       componente, @media solo para chrome y densidad por puntero). Ademas de
       habilitar las queries de abajo, container-type: inline-size CORTA la
       contribucion de min-content del contenido al track del grid padre: era lo
       que hacia que la tarjeta midiera 434px dentro de 333 y se saliera de la
       pantalla en un telefono (el .arq-hint, un flex sin wrap con 10 hijos,
       ponia el piso). Los overlays de PrimeNG salen por appendTo, asi que la
       contencion no los recorta (§R, la trampa de container-type). */
    .arq-panel { --arq-pad: 1rem; padding: var(--arq-pad);
                 container-type: inline-size; container-name: arqpanel; }
    /* Los margenes negativos se derivan del padding del panel: si el panel se
       aprieta en un telefono, la barra sigue pegada a los bordes sin recalcular. */
    .arq-bar { position: sticky; bottom: 0; z-index: 3; display: flex; align-items: center;
               flex-wrap: wrap; gap: .6rem 1rem;
               margin: .8rem calc(-1 * var(--arq-pad)) calc(-1 * var(--arq-pad));
               padding: .7rem var(--arq-pad);
               background: var(--card-bg); border-top: 1px solid var(--border-color);
               border-radius: 0 0 var(--r-md) var(--r-md); }
    .arq-bar-total { display: flex; flex-direction: column; line-height: 1.1; }
    .arq-bar-l { font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .arq-bar-desg { font-size: .68rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .arq-cfm-hd { display: flex; flex-direction: column; gap: .1rem; font-size: .82rem; font-weight: 600; margin-bottom: .7rem; }
    .arq-cfm-hd .muted { font-weight: 400; font-size: .74rem; }
    .arq-cfm-t { width: 100%; border-collapse: collapse; font-size: .82rem; font-variant-numeric: tabular-nums; }
    .arq-cfm-t td { padding: .22rem .1rem; border-bottom: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent); }
    .arq-cfm-sub td { border-bottom: 1px solid var(--border-color); }
    .arq-cfm-t tfoot td { padding-top: .35rem; border-bottom: 0; font-size: .95rem; font-weight: 800; }
    .arq-cfm-n { margin: .5rem 0 0; font-size: .78rem; }
    .arq-cfm-w { display: flex; align-items: baseline; gap: .4rem; margin: .8rem 0 0; padding-top: .6rem;
                 border-top: 1px solid var(--border-color); font-size: .76rem; color: var(--text-muted); }
    .arq-bar-v { font-size: 1.5rem; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
    .arq-bar :host ::ng-deep .p-button, .arq-bar ::ng-deep .p-button { margin-left: auto; }
    .arq-turno-n { display: inline-block; margin-right: .3rem; padding: 0 .3rem; border-radius: var(--r-sm);
                   background: var(--action); color: #fff; font-size: .62rem; font-weight: 700; vertical-align: middle; }
    .arq-turno.bloq .arq-turno-n { background: var(--text-muted); }
    .arq-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    .arq-msg { font-size: .82rem; margin: .4rem 0; }
    .arq-vacio { display: flex; gap: .8rem; align-items: flex-start; padding: .9rem; border: 1px dashed var(--border-color); border-radius: var(--r-md); }
    .arq-vacio i { color: var(--action); margin-top: .15rem; }
    .arq-vacio p { margin: .25rem 0 .4rem; font-size: .82rem; }
    .arq-turno-lbl { margin: .2rem 0 .4rem; }
    .arq-turnos { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .arq-turno { display: flex; flex-direction: column; gap: .12rem; align-items: flex-start; text-align: left; cursor: pointer;
                 padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: inherit; }
    .arq-turno:hover { background: var(--surface-hover-bg); }
    .arq-turno.sel { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .arq-turno-caja { font-size: .85rem; font-weight: 700; }
    .arq-turno.bloq { opacity: .5; cursor: not-allowed; }
    .arq-turno.bloq:hover { background: var(--card-bg); }
    .arq-bloq-txt { display: block; margin-top: .2rem; font-size: .6rem; text-transform: uppercase;
                    letter-spacing: .04em; color: var(--text-muted); }
    .arq-pide { display: block; margin-top: .2rem; font-size: .6rem; font-weight: 700; text-transform: uppercase;
                letter-spacing: .04em; color: var(--action); }
    .arq-prox { display: flex; gap: .7rem; align-items: flex-start; padding: .7rem .85rem; margin-bottom: .9rem;
                border: 1px solid var(--border-color); background: var(--surface-hover-bg); border-radius: var(--r-md); }
    .arq-prox i { color: var(--text-muted); margin-top: .15rem; }
    .arq-prox p { margin: .15rem 0 0; font-size: .78rem; }
    .arq-prox.ya { border-color: color-mix(in srgb, var(--warn-fg) 45%, transparent);
                   background: color-mix(in srgb, var(--warn-fg) 8%, transparent); }
    .arq-prox.ya i { color: var(--warn-fg); }
    .arq-pide-box { display: flex; gap: .7rem; align-items: flex-start; padding: .75rem .85rem; margin-bottom: .9rem;
                    border: 1px solid color-mix(in srgb, var(--action) 45%, transparent);
                    background: color-mix(in srgb, var(--action) 8%, transparent); border-radius: var(--r-md); }
    .arq-pide-box i { color: var(--action); margin-top: .15rem; }
    .arq-pide-box p { margin: .15rem 0 0; font-size: .78rem; }
    .arq-turno-meta { font-size: .7rem; color: var(--text-muted); }
    .arq-datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(6rem, 100%), 1fr)); gap: .5rem .9rem; margin-bottom: .9rem;
                 padding: .7rem .8rem; border-radius: var(--r-md); background: var(--surface-hover-bg); border: 1px solid var(--border-color); }
    :host ::ng-deep .arq-seg { margin-bottom: .7rem; }
    .arq-head { display: flex; gap: .8rem; flex-wrap: wrap; margin: .8rem 0; align-items: flex-end; }
    .arq-lbl { display: inline-flex; flex-direction: column; gap: .2rem; font-size: .76rem; color: var(--text-muted); }
    :host ::ng-deep .arq-fld { font-size: .82rem; padding: .35rem .6rem; }
    :host ::ng-deep .arq-fld-sm { width: min(5.5rem, 100%); }
    /* El codigo de cajera no es un numero corto como la caja: va de 10C02 a
       DAVID_CISNEROS. Con el ancho de "Caja" se cortaba el nombre de quien firma
       el conteo, que es justo el dato que no puede quedar a medias. */
    :host ::ng-deep .arq-fld-cajero { width: min(12rem, 100%); }
    .arq-fld-suc { width: min(11rem, 100%); }
    /* width:100% + tope: llena el track que le toque (en touch el tope se
       levanta, abajo) pero puede encogerse - con width:5rem fijo el input era
       un piso de 80px que no cedia en una pantalla angosta. */
    :host ::ng-deep .arq-num { width: 100%; min-width: 0; max-width: 5rem;
                               text-align: right; font-variant-numeric: tabular-nums; padding: .25rem .4rem; }
    :host ::ng-deep .arq-date .p-datepicker-input { width: 8.5rem; }
    .arq-block { display: block; margin: .8rem 0; }
    .arq-sel { font-size: .82rem; padding: .35rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); background: var(--card-bg); color: var(--text-main); }
    .arq-block .arq-sel { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-block .arq-fld { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-print { margin-top: .35rem; }
    /* Grid intrínseco (§9): dos columnas donde caben, una donde no. Sin breakpoints. */
    /* Tres bloques del formato de piso: billetes | monedas | medios. Grid
       intrinseco, sin breakpoints: se apilan solos cuando no entran (DESIGN §9). */
    /* min(15.5rem, 100%) en vez de 15.5rem pelado: con el minimo fijo, en un
       telefono la unica columna medía 248px dentro de un contenedor de 230 y se
       desbordaba. Con el min() el track se rinde al ancho disponible. */
    .arq-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(15.5rem, 100%), 1fr));
                gap: .8rem 1.4rem; margin: .2rem 0 .4rem; }
    .arq-col { min-width: 0; display: flex; flex-direction: column; }
    .arq-col-t { margin: 0 0 .4rem; padding-bottom: .3rem; border-bottom: 1px solid var(--border-color);
                 font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .arq-col-rows { display: flex; flex-direction: column; gap: .1rem; }
    /* El total de cada fajo se verifica aparte: el de billetes contra el de
       monedas es la primera pista de un conteo mal capturado. */
    .arq-col-tot { display: flex; align-items: baseline; gap: .5rem; margin-top: auto; padding-top: .35rem;
                   border-top: 1px solid var(--border-color); font-size: .76rem; font-weight: 700; }
    .arq-col-pz { margin-left: auto; font-size: .68rem; font-weight: 500; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .arq-col-mn { min-width: 5.5rem; text-align: right; font-variant-numeric: tabular-nums; }
    .arq-col--medios .arq-den { grid-template-columns: minmax(0, 1fr) 6.5rem; }
    .arq-inc { display: block; margin-top: .55rem; }
    :host ::ng-deep .arq-inc .arq-fld { display: block; width: 100%; margin-top: .2rem; }
    /* El track del medio es minmax(0,1fr): con 1fr no bajaba del ancho fijo
       del input y la fila entera empujaba la tarjeta fuera de la pantalla. */
    .arq-den { display: grid; grid-template-columns: 3.2rem minmax(0, 1fr) 5.5rem; align-items: center; gap: .5rem;
               padding: .12rem 0; font-variant-numeric: tabular-nums; }
    .arq-den-lbl { font-size: .82rem; font-weight: 600; text-align: right; }
    .arq-den-sub { font-size: .74rem; color: var(--text-muted); text-align: right; }
    .arq-medio { display: grid; grid-template-columns: minmax(0, 1fr) 6.5rem; align-items: center; gap: .5rem; padding: .12rem 0; }
    .arq-medio-lbl { font-size: .82rem; }
    :host ::ng-deep .arq-medio-num { text-align: right; }
    /* flex-wrap obligatorio: son ~10 hijos flex (los <kbd> cuentan uno cada
       uno) y sin envolver su min-content era ~400px - el piso real que sacaba la
       tarjeta de la pantalla en un telefono. */
    .arq-hint { margin: 0 0 .8rem; font-size: .72rem; color: var(--text-muted);
                display: flex; align-items: center; flex-wrap: wrap; gap: .2rem .35rem; }
    .arq-hint kbd { font-family: var(--font-mono, monospace); font-size: .68rem; padding: .05rem .3rem; border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-hover-bg); }
    .arq-result { margin-top: 1rem; padding: .9rem; border-radius: var(--r-md); border: 1px solid var(--border-color); background: var(--surface-hover-bg); }
    .arq-result.bad { border-color: color-mix(in srgb, var(--bad-fg) 40%, transparent); background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .arq-result.ok { border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); background: color-mix(in srgb, var(--ok-fg) 6%, transparent); }
    .arq-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(7rem, 100%), 1fr)); gap: .6rem 1rem; }
    .arq-ev-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); display: block; }
    .arq-ev-v { font-size: .95rem; font-variant-numeric: tabular-nums; }
    .arq-mt { margin: .6rem 0 0; font-size: .78rem; }
    .arq-table { font-variant-numeric: tabular-nums; }
    /* El historial tiene hasta 10 columnas: en un telefono no cabe de ninguna
       forma. Scrollea DENTRO de su contenedor - que la pagina entera se corra en
       horizontal mueve tambien el encabezado y la barra de guardar. */
    :host ::ng-deep .arq-table .p-datatable-table-container { overflow-x: auto; }
    .arq-mask { display: inline-block; margin-left: .35rem; font-size: .62rem; text-transform: uppercase; letter-spacing: .04em;
                font-weight: 700; padding: .05rem .3rem; border-radius: 4px; color: var(--bad-fg);
                background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .arq-dif-l { display: block; font-size: .62rem; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
    .arq-ok { display: inline-flex; align-items: center; gap: .3rem; font-size: .76rem; color: var(--ok-fg); font-weight: 600; }
    :host ::ng-deep .arq-tag-mini { margin-left: .3rem; transform: scale(.8); }
    .arq-ex-th { width: 2.4rem; }
    .arq-ex-td { width: 2.4rem; }
    /* ::ng-deep: la fila desplegada la renderiza p-table (vendor), el estilo no llega scopeado. */
    :host ::ng-deep .arq-exp-tr > td.arq-exp { padding: .9rem 1rem 1rem; background: var(--surface-hover-bg); }
    .arq-exp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .9rem 1.6rem; }
    .arq-exp-block { min-width: 0; }
    .arq-exp-t { margin: 0 0 .45rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .arq-exp-t .muted { font-weight: 500; text-transform: none; letter-spacing: 0; }
    .arq-mini-t { width: 100%; border-collapse: collapse; font-size: .78rem; font-variant-numeric: tabular-nums; }
    .arq-mini-t th { text-align: left; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em;
                     color: var(--text-muted); padding: .2rem .45rem; border-bottom: 1px solid var(--border-color); }
    .arq-mini-t td { padding: .18rem .45rem; border-bottom: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent); }
    .arq-mini-t tbody tr:last-child td { border-bottom: 0; }
    .arq-mini-t tfoot td { border-top: 1px solid var(--border-color); border-bottom: 0; padding-top: .3rem; }
    .arq-mini-total td { font-weight: 700; }
    .arq-mono { font-family: var(--font-mono, monospace); }
    .arq-exp-note { margin: .4rem 0 0; font-size: .72rem; color: var(--text-muted); }
    .arq-exp-warn { display: flex; align-items: baseline; gap: .35rem; flex-wrap: wrap; margin: .45rem 0 0; font-size: .74rem; color: var(--bad-fg); }
    .arq-exp-meta { display: flex; flex-wrap: wrap; gap: .35rem 1.2rem; margin-top: .85rem; padding-top: .6rem;
                    border-top: 1px solid var(--border-color); font-size: .74rem; }
    .arq-exp-meta > span { display: inline-flex; align-items: baseline; gap: .35rem; }
    .arq-exp-meta .arq-ev-k { display: inline; }
    .arq-exp-nota { flex: 1 1 100%; }
    .arq-exp-cortes { margin-top: .9rem; padding-top: .75rem; border-top: 1px solid var(--border-color); }
    .arq-cortes-t tbody tr.sel { background: color-mix(in srgb, var(--action) 9%, transparent); }
    .arq-cortes-t tbody tr.sel td:first-child { box-shadow: inset 2px 0 0 var(--action); }
    .arq-sin { display: inline-flex; align-items: center; gap: .25rem; font-size: .72rem; font-weight: 600; color: var(--bad-fg); }
    .arq-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); } .ok { color: var(--ok-fg); }

    /* ====================================================================
       SM.31 - RESPONSIVO. Dos capas, cada una con su trabajo (DESIGN §9):

       @container arqpanel = COMO se reordena el panel segun el ancho que le
       dio la pagina. No @media: el mismo panel vive con y sin sidebar, y en
       la tablet en horizontal el viewport dice "grande" mientras el panel es
       angosto - el viewport es la medida equivocada.

       @media (pointer: coarse) = DENSIDAD por metodo de entrada. Es lo unico
       que decide el dispositivo y no el ancho: un dedo mide igual en un
       telefono que en una tablet de 12".
       ==================================================================== */

    /* Panel angosto (telefono, o tablet en vertical con el sidebar abierto):
       una sola columna de verdad - los campos del encabezado a lo ancho, las
       tarjetas de turno a lo ancho, y el boton de guardar en su propio renglon
       en vez de pelearse con el total. */
    @container arqpanel (max-width: 30rem) {
      .arq-head { gap: .55rem; }
      .arq-head .arq-lbl { width: 100%; }
      :host ::ng-deep .arq-head .arq-fld { width: 100%; }
      .arq-turnos .arq-turno { flex: 1 1 100%; }
      /* Las pestanas de tipo de arqueo, a lo ancho: es ESTA pagina la que lo
         pide (el control lo comparten 14 pantallas y no decide por ellas). */
      :host ::ng-deep app-segmented .seg { display: flex; }
      :host ::ng-deep app-segmented .seg-btn { flex: 1 1 auto; }
      /* Apiladas, las tres columnas del formato necesitan mas aire entre si:
         con .8rem se leian como una sola lista de 20 renglones. */
      .arq-cols { gap: 1.3rem; }
      /* El total en una linea (rotulo + monto al lado) en vez de dos: en un
         telefono la barra pegada se comia 112px de los 844 de alto. */
      .arq-bar-total { flex-flow: row wrap; align-items: baseline; column-gap: .45rem; }
      .arq-bar-desg { flex: 1 0 100%; }
      .arq-bar-v { font-size: 1.35rem; }
      /* El hijo flex de la barra es el elemento <p-button>, NO el .p-button que
         renderiza adentro: estirar el de adentro no mueve nada en el layout del
         padre. Medido en el navegador — el boton envolvia a su renglon pero se
         quedaba en 221px. Se estiran los dos. */
      :host ::ng-deep .arq-bar p-button { flex: 1 0 100%; }
      :host ::ng-deep .arq-bar p-button .p-button { width: 100%; margin-left: 0; }
    }

    /* Panel muy angosto (telefono chico, 320px): los rotulos de denominacion y
       el subtotal ceden ancho para que la casilla siga siendo tecleable. */
    @container arqpanel (max-width: 20rem) {
      .arq-den { grid-template-columns: 2.6rem minmax(0, 1fr) 4.5rem; gap: .35rem; }
      .arq-den-sub { font-size: .68rem; }
      .arq-col--medios .arq-den { grid-template-columns: minmax(0, 1fr) 5.5rem; }
      .arq-medio { grid-template-columns: minmax(0, 1fr) 5.5rem; }
    }

    /* TOUCH. Objetivos >=44px (DESIGN §11, Ley de Fitts). El minimo global de
       styles.css solo cubre .comm-actions e icon-btn, asi que los campos
       de esta pantalla -donde se teclea DINERO con el cajon abierto- se suben
       aca. 1rem de letra en las casillas no es estetica: por debajo de 16px
       Safari en iOS hace zoom al enfocar y descuadra la pantalla a media
       captura. */
    @media (pointer: coarse) {
      :host ::ng-deep .arq-fld { min-height: var(--tap-min, 44px); font-size: 1rem; }
      /* PrimeNG v22 NO propaga styleClass en p-select: la clase arq-fld nunca
         llega al elemento, asi que la regla de arriba no lo toca y los dos
         selectores (Sucursal e Incidencia) se quedaban en 35px. Se apunta al
         elemento. Ya es display:flex, asi que align-items centra el rotulo. */
      :host ::ng-deep .arq-panel p-select { min-height: var(--tap-min, 44px); align-items: center; }
      :host ::ng-deep .arq-panel p-select .p-select-label { font-size: 1rem; }
      :host ::ng-deep .arq-num { max-width: none; min-height: var(--tap-min, 44px);
                                 font-size: 1rem; padding: .4rem .55rem; }
      .arq-den { gap: .5rem; padding: .18rem 0; }
      .arq-turno { min-height: var(--tap-min, 44px); padding: .6rem .8rem; }
      :host ::ng-deep .arq-panel .p-button { min-height: var(--tap-min, 44px); }
      /* El dialogo de confirmacion cuelga de .surf-page, no del panel: sus dos
         botones (y la X de cerrar) median 35px. Son los que SELLAN el conteo. */
      :host ::ng-deep .arq-cfm-dlg .p-button { min-height: var(--tap-min, 44px); }
      /* La pista habla de las flechas del teclado y de Enter: con el dedo no
         aplica, y son cinco renglones de texto encima de lo que se cuenta. */
      .arq-hint { display: none; }
    }
  `],
})
export class TiendaArqueoComponent implements OnInit, HasUnsavedChanges {
  /** Para llegar al `app-segmented`, que es un componente hijo sin ref propia. */
  private readonly host = inject(ElementRef) as ElementRef<HTMLElement>;
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly dataScope = inject(DataScopeService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  @ViewChildren('denomInput') private denomInputs?: QueryList<ElementRef<HTMLInputElement>>;
  @ViewChildren('medioInput') private medioInputs?: QueryList<ElementRef<HTMLInputElement>>;
  @ViewChild('btnGuardar', { read: ElementRef }) private btnGuardar?: ElementRef<HTMLElement>;
  /** Campos del encabezado (Sucursal · Caja · Cajero) en orden de DOM. `Fecha` no
   *  entra: es texto fijo, no un campo — un arqueo es de HOY (ver el template). */
  @ViewChildren('hcell', { read: ElementRef }) private headCells?: QueryList<ElementRef<HTMLElement>>;

  /**
   * ¿Se le revela el cuadre? Solo el supervisor del motor (`RECONCILIATION_VER`).
   * Espeja la regla del backend — acá es cosmético (el backend ya no manda los
   * campos), pero evita renderizar columnas que siempre saldrían vacías.
   */
  /** El arqueo es UNA seccion con dos vistas (el acto / la persona). */
  readonly arqueoTabs = ARQUEO_TABS;

  readonly revela = this.perms.isAdmin()
    || this.auth.user()?.permissions?.[Permission.RECONCILIATION_VER] === true;

  /** Turnos que Kepler abrió a nombre del usuario. Sin turno no hay arqueo. */
  readonly turnos = signal<Turno[]>([]);
  readonly turnoFolio = signal<string>('');
  readonly cargandoTurnos = signal(true);
  /** Última lectura de Kepler — alimenta la píldora de frescura. */
  readonly turnosAl = signal<string | null>(null);
  /** Fecha de negocio en hora de México (§10: no re-convertir con `new Date()` suelto). */
  readonly hoyTxt = computed(() => new Date().toLocaleDateString('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit',
  }));
  /**
   * Turnos del más viejo al más nuevo. El backend ya ordena por fecha, pero dos
   * cortes del MISMO día se desempataban por número de caja, no por hora — y el
   * `i > 0` del template convertía esa posición en "quién puede arquear". O sea:
   * el orden visual mandaba sobre la regla. Acá se ordena por el instante real de
   * cierre (fecha + hora) para que "el más viejo" sea el más viejo de verdad.
   */
  readonly turnosOrdenados = computed(() => [...this.turnos()].sort((a, b) => {
    const ka = `${a.business_date} ${(a.hora_cierre || a.hora_apertura || '00:00')}`;
    const kb = `${b.business_date} ${(b.hora_cierre || b.hora_apertura || '00:00')}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }));
  /** El único accionable: los cortes se cierran en orden y el backend lo exige igual. */
  readonly turnoQueToca = computed(() => this.turnosOrdenados()[0] ?? null);
  readonly turnoSel = computed(() => this.turnos().find((t) => t.folio === this.turnoFolio()) ?? null);
  /** Captura a mano (solo supervisor): relevo, contingencia, caja sin Kepler. */
  readonly manual = signal(false);
  readonly puedeContar = computed(() => !!this.turnoSel() || this.manual());

  /** Sucursales del ALCANCE del usuario — solo se usan en la captura manual. */
  readonly sucursales = signal<ScopeOption[]>([]);
  /** Con el código adelante: la encargada las conoce por número, no por nombre. */
  readonly sucursalOptions = computed(() =>
    this.sucursales().map((w) => ({ value: w.value, label: `${w.value} — ${w.label}` })));
  readonly variasSucursales = computed(() => this.sucursales().length > 1);

  readonly canCapture = computed(() =>
    this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.STORE_ARQUEO_CAPTURAR] === true);

  readonly tipoOptions = [
    { label: 'Cierre de día', value: 'cierre' as const },
    // La sangría que Kepler pide al llegar al límite de la caja. Va primero
    // después del cierre porque es la MÁS frecuente: una caja hace un cierre al
    // día y tres o cuatro retiros.
    { label: 'Retiro', value: 'retiro' as const },
    { label: 'Relevo', value: 'relevo' as const },
  ];

  readonly incidenciaOptions = [
    { label: 'Ninguna', value: '' },
    { label: 'Faltante justificado', value: 'faltante_justificado' },
    { label: 'Billete falso', value: 'billete_falso' },
    { label: 'Robo', value: 'robo' },
    { label: 'Error de cobro', value: 'error_cobro' },
    { label: 'Otro', value: 'otro' },
  ];

  /**
   * Los conceptos no-efectivo del corte. `cuadra` marca los que tienen columna
   * verificada en Kepler; los otros se guardan igual —tener el dato declarado es
   * lo que permitirá confirmar su columna— pero no se comparan contra nada.
   */
  readonly mediosCampos = [
    { key: 'tarjeta', label: 'Tarjeta', cuadra: true },
    { key: 'transferencia', label: 'Transferencia', cuadra: true },
    { key: 'retiros', label: 'Retiros', cuadra: true },
    { key: 'creditos', label: 'Créditos', cuadra: false },
    { key: 'cheques', label: 'Cheques', cuadra: false },
  ];
  medios: Record<string, number> = {};

  /**
   * Billete y moneda van separados porque se cuentan separados: son dos fajos
   * distintos y cada total se verifica aparte. El corte en $20 es el mismo que usa
   * `blind-count.service` para partir nuestro conteo contra el de Kepler — si uno
   * se mueve, el otro tambien.
   */
  readonly billetes = [1000, 500, 200, 100, 50, 20];
  readonly monedas = [10, 5, 2, 1, 0.5];
  /** El orden importa: es el de los inputs en pantalla (navegacion ↑/↓). */
  readonly denoms = [...this.billetes, ...this.monedas];
  denomCount: Record<number, number> = {};
  readonly aTipo = signal<ArqueoTipo>('cierre');
  aSuc = ''; aCaja = ''; aDate: Date = new Date(); aCajero = ''; aEntrante = ''; aNota = ''; aIncidencia = '';
  readonly arqTotal = signal(0);
  /** Totales por fajo — los pide el formato y delatan un conteo mal capturado. */
  readonly totBilletes = signal(0);
  /**
   * Lo declarado en los otros medios. Entra al TOTAL DEL TURNO que se ve en
   * pantalla — el turno es una sola cantidad — pero **no** al `total_contado` que
   * viaja al backend: ese se compara contra el **efectivo** esperado del corte, y
   * sumarle tarjeta/transferencia inventaría un sobrante del tamaño de la venta
   * con tarjeta. Es el mismo error que SM.23 sacó del código (acusaba a una cajera
   * honesta de $18,587). Cada medio se cuadra contra SU columna de Kepler (SM.24).
   */
  readonly totMedios = signal(0);
  /** Efectivo + medios: el número grande de la barra y del diálogo. */
  readonly totalTurno = computed(() => Math.round((this.arqTotal() + this.totMedios()) * 100) / 100);
  readonly totMonedas = signal(0);
  readonly pzasBilletes = signal(0);
  readonly pzasMonedas = signal(0);
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly validando = signal<string | null>(null);
  readonly dirty = signal(false);
  readonly result = signal<ArqueoResult | null>(null);
  readonly rows = signal<ArqueoRow[]>([]);

  readonly submitLabel = computed(() => {
    const t = this.aTipo();
    if (t === 'relevo') return 'Sellar relevo';
    // El retiro NO revela diferencia ni al supervisor: el corte todavía no existe,
    // así que no hay contra qué comparar. Se cuadra al cerrar el turno.
    if (t === 'retiro') return 'Guardar retiro';
    return this.revela ? 'Guardar y revelar diferencia' : 'Guardar arqueo';
  });
  /** +1 por la columna del expander. */
  readonly colspan = computed(() => 6 + (this.variasSucursales() ? 1 : 0) + (this.revela ? 3 : 0));

  /** §13 — el diálogo de confirmación: sellar un corte no se hace de un clic. */
  readonly confirmando = signal(false);

  readonly confirmTitulo = computed(() => {
    const t = this.aTipo();
    if (t === 'relevo') return '¿Confirmas el relevo?';
    if (t === 'retiro') return '¿Confirmas el retiro?';
    return '¿Confirmas el corte?';
  });
  readonly confirmCta = computed(() => {
    const t = this.aTipo();
    if (t === 'relevo') return 'Sí, sellar relevo';
    if (t === 'retiro') return 'Sí, guardar retiro';
    return 'Sí, guardar y sellar';
  });

  /** El botón de la barra ya no guarda: pide confirmación con el resumen. */
  confirmar() {
    if (!this.canSubmit() || this.saving()) return;
    this.confirmando.set(true);
  }

  /** §13 estado sucio — hay conteo capturado sin guardar. */
  hasUnsavedChanges(): boolean { return this.dirty(); }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent) { if (this.hasUnsavedChanges()) e.preventDefault(); }

  ngOnInit() {
    // Solo se usa en la captura manual del supervisor: en el flujo normal la
    // sucursal la dice el turno.
    const u = this.auth.user()?.username;
    if (u) this.aCajero = u.toUpperCase();
    this.dataScope.warehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (w) => { this.sucursales.set(w); if (w.length === 1) this.aSuc = w[0].value; },
      error: () => { /* el backend recorta igual */ },
    });
    this.cargarTurnos();
    this.load();
    // Poll fuera de Angular: es un timer de fondo, no debe disparar CD cada 45s.
    this.zone.runOutsideAngular(() => {
      const id = setInterval(() => this.zone.run(() => this.tick()), 45_000);
      this.destroyRef.onDestroy(() => clearInterval(id));
    });
  }

  /**
   * Va A LA PAR de Kepler: la lista se repregunta sola cada 45s y al volver a la
   * pestaña. Sin esto, la cajera que dejó la pantalla abierta no se entera de que
   * el ERP ya cerró su caja — y el arqueo tiene que pedirse **cuando Kepler lo
   * pide**, no cuando a alguien se le ocurre recargar.
   */
  private cargarTurnos(silencioso = false) {
    if (!silencioso) this.cargandoTurnos.set(true);
    this.svc.turnos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (t) => {
        this.turnos.set(t);
        this.turnosAl.set(new Date().toISOString());
        // Un solo turno abierto es el caso normal: se elige solo, la cajera solo cuenta.
        // Se preselecciona el que TOCA (el más viejo), no el primero que llegó.
        if (t.length && !this.turnoSel()) this.turnoFolio.set(this.turnoQueToca()?.folio ?? t[0].folio);
        this.cargandoTurnos.set(false);
      },
      error: () => this.cargandoTurnos.set(false),
    });
  }

  /** No se refresca mientras hay un conteo a medio capturar: pisaría el trabajo. */
  private tick() {
    if (document.visibilityState !== 'visible' || this.dirty() || this.saving()) return;
    this.cargarTurnos(true);
  }

  @HostListener('document:visibilitychange')
  onVisible() { this.tick(); }

  /**
   * SM.17 — Aviso de "se acerca tu corte".
   *
   * Solo si el pronóstico es confiable: hay cajas con dispersión de ±3 min y otras
   * de ±210. Con un IQR grande la hora "típica" es un promedio de dos costumbres
   * distintas y avisar sería ruido — peor que no avisar, porque entrena a ignorar.
   */
  avisoCorte(t: Turno): { titulo: string; detalle: string; pronto: boolean } | null {
    const min = t.corte_en_min;
    const iqr = t.corte_iqr_min;
    if (t.corte_tipico == null || min == null || iqr == null) return null;
    if (iqr > 60 || min < -15 || min > 240) return null;   // impredecible o muy lejos
    const pronto = min <= 30;
    const holgura = `Suele cortar a las ${t.corte_tipico} (±${iqr} min).`;
    return min <= 0
      ? { titulo: 'Ya pasó tu hora habitual de corte.', detalle: `${holgura} Kepler todavía no la cierra.`, pronto: true }
      : {
          titulo: pronto ? `Tu corte es en ${min} min.` : `Tu corte es a las ${t.corte_tipico}.`,
          detalle: pronto ? `${holgura} Ve preparando el efectivo.` : `${holgura} Faltan ${min} min.`,
          pronto,
        };
  }


  onMedioInput(key: string, ev: Event) {
    const v = Number(String((ev.target as HTMLInputElement).value).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(v) && v > 0) this.medios[key] = v; else delete this.medios[key];
    this.recalcMedios();
    this.dirty.set(true);
  }

  elegirTipo(v: string) { this.aTipo.set(v as ArqueoTipo); this.dirty.set(true); }

  elegirTurno(folio: string) { this.turnoFolio.set(folio); this.result.set(null); }

  /**
   * Ticket del arqueo recién capturado. Las denominaciones salen del formulario,
   * no del servidor: es lo que la persona acaba de contar y el papel tiene que
   * decir exactamente eso.
   *
   * `revela` decide si lleva el bloque contra Kepler. En manos de la cajera
   * imprime su conteo y las firmas, sin esperado ni diferencia — el papel no puede
   * filtrar lo que la pantalla le oculta.
   */
  imprimir(r: ArqueoResult) {
    const t = this.turnoSel();
    const denominaciones = this.denoms
      .map((d) => ({ denominacion: d, cantidad: Number(this.denomCount[d]) || 0, subtotal: (Number(this.denomCount[d]) || 0) * d }))
      .filter((x) => x.cantidad > 0);
    const ok = imprimirTicket({
      sucursal: this.branchLabel(t?.warehouse_code ?? this.aSuc),
      caja: t?.caja ?? this.aCaja,
      fecha: t?.business_date ?? this.fmtDate(this.aDate),
      folio: t?.folio ?? null,
      cajera: this.aCajero || '',
      hora_apertura: t?.hora_apertura ?? null,
      hora_cierre: t?.hora_cierre ?? null,
      denominaciones,
      total_contado: r.total_contado,
      esperado: r.esperado, diff_real: r.diff_real,
      kepler_contado: r.kepler_contado, kepler_billetes: r.kepler_billetes,
      kepler_monedas: r.kepler_monedas, kepler_retirado: r.kepler_retirado,
      // Lo mismo que confirmo en el dialogo, para que el papel diga el mismo total.
      medios_declarados: this.mediosDeclarados().map((m) => ({ label: m.label, monto: m.monto })),
      // Lo que la persona acaba de declarar: sale del formulario, no del server.
      tipo: r.tipo, cajero_entrante: this.aEntrante || null,
      turno: t?.turno ?? null,
      incidencia_tipo: this.aIncidencia || null, nota: this.aNota || null,
      capturado_at: new Date().toISOString(),
      capturado_por: this.auth.user()?.username || null,
      validado_por: null, validado_at: null,
    }, { revela: this.revela });
    if (!ok) {
      this.toast.add({ severity: 'warn', summary: 'No se pudo abrir la impresión', detail: 'Usa el botón Imprimir ticket para reintentar.' });
    }
  }

  branchLabel(code?: string | null): string {
    if (!code) return '';
    const o = this.sucursales().find((w) => w.value === code);
    return o?.label || branchName(code);
  }

  canSubmit(): boolean {
    if (this.arqTotal() <= 0) return false;
    if (this.turnoSel()) return true;
    return this.manual() && !!(this.aSuc.trim()) && !!this.aCaja.trim() && !!this.aDate;
  }

  // ─────────────────── pad de denominaciones ───────────────────

  /** Solo dígitos: es un conteo de billetes, no una fórmula. */
  onDenomInput(denom: number, ev: Event) {
    const el = ev.target as HTMLInputElement;
    const limpio = (el.value || '').replace(/\D/g, '');
    if (limpio !== el.value) el.value = limpio;
    if (limpio) this.denomCount[denom] = Number(limpio);
    else delete this.denomCount[denom];
    this.recalc();
  }

  /**
   * ↑/↓ SALTAN de casilla (y Enter avanza), en vez de incrementar el conteo —
   * por eso este input no es un `p-inputnumber`. Contar efectivo es teclear un
   * número y bajar; una flecha que suma un billete sin aviso es un descuadre.
   */
  /**
   * **La captura se mueve como se ve: en dos dimensiones.**
   *
   * La pantalla son tres columnas (billetes | monedas | medios), no una lista, y
   * con una cadena lineal bajar de `$1000` a `Tarjeta` costaba 11 pulsaciones.
   * Ahora:
   *
   *  - `↑` / `↓` → dentro de la columna;
   *  - `←` / `→` → a la columna de al lado, **mismo renglón** (si la vecina es más
   *    corta — monedas tiene 5 y billetes 6 — cae en su último renglón, no al vacío);
   *  - `Enter` → igual que `↓`, para no romper el hábito de quien ya lo usa;
   *  - `↓` (o `Enter`) en la **última** casilla de una columna → **el botón de
   *    guardar**, que es a dónde iba a ir la mano de todos modos.
   *
   * Las coordenadas las manda el template (`col`, `row`) y la grilla se arma de
   * los `@ViewChildren` en orden de DOM, así que si una columna no se renderiza
   * (el relevo no declara medios) no hay que tocar nada acá.
   */
  onCellKey(ev: KeyboardEvent, col: number, row: number) {
    const k = ev.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Enter') return;
    ev.preventDefault();
    const g = this.grilla();
    if (!g[col]) return;

    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const destino = g[col + (k === 'ArrowLeft' ? -1 : 1)];
      if (!destino?.length) return;
      // Clamp al último renglón de la vecina: columnas de distinto largo.
      this.enfocar(destino[Math.min(row, destino.length - 1)]);
      return;
    }

    if (k === 'ArrowUp') {
      if (row > 0) { this.enfocar(g[col][row - 1]); return; }
      // Primera fila: ↑ sale de la grilla hacia el encabezado (SM.30). Antes no
      // hacía nada y la cadena era de ida nomás.
      this.focusHead(this.headCells?.length ? this.headCells.length - 1 : 0);
      return;
    }

    // ↓ o Enter
    const siguiente = g[col][row + 1];
    if (siguiente) { this.enfocar(siguiente); return; }
    this.ultimaCelda = { col, row };
    this.focusGuardar();
  }

  /**
   * **El encabezado también se recorre con flechas (SM.30).**
   *
   * Faltaba el primer tramo de la cadena: la sucursal, la caja y el cajero sólo
   * se alcanzaban con Tab, así que el arqueo empezaba con la mano en el mouse y
   * seguía con el teclado. Ahora la cadena completa es
   * **pestañas → encabezado → grilla → botón de guardar**, y `↑` la desanda.
   *
   *   ← →   entre los campos del encabezado
   *   ↓ / Enter   baja a la grilla (a `$1000`, que es donde empieza a contarse)
   *   ↑     sube a las pestañas
   *
   * **El `p-select` de Sucursal es el caso delicado.** Sus propias flechas abren
   * y recorren el desplegable, así que sólo se interceptan **con el desplegable
   * CERRADO**; abierto, las flechas son suyas. Abrirlo sigue siendo `Enter` o
   * espacio, que es su activación nativa. Mismo criterio que dejó a Incidencia
   * fuera de la cadena en SM.29: una flecha que despliega opciones cuando el
   * operario quería bajar de campo es peor que no tener la flecha.
   */
  onHeadKey(ev: KeyboardEvent, idx: number) {
    const k = ev.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Enter') return;

    // Desplegable abierto → las flechas son del select, no de la cadena.
    if (this.selectAbierto(ev.target as HTMLElement)) return;

    const cells = this.headCells?.toArray() ?? [];
    if (!cells.length) return;

    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const destino = idx + (k === 'ArrowLeft' ? -1 : 1);
      if (destino < 0 || destino >= cells.length) return;
      ev.preventDefault();
      this.focusHead(destino);
      return;
    }

    if (k === 'ArrowUp') {
      ev.preventDefault();
      this.focusSegmented();
      return;
    }

    // ↓ o Enter → a contar
    const g = this.grilla();
    const primera = g[0]?.[0];
    if (!primera) return;
    ev.preventDefault();
    this.enfocar(primera);
  }

  /** Enfoca un campo del encabezado. El `p-select` no es un input: su foco vive
   *  en el elemento con `role="combobox"` que PrimeNG pinta adentro. */
  focusHead(idx: number): void {
    const el = this.headCells?.toArray()[idx]?.nativeElement;
    if (!el) return;
    const foco = el.matches('input, button')
      ? el
      : el.querySelector<HTMLElement>('[role="combobox"], input, button, [tabindex]');
    (foco ?? el).focus?.();
  }

  /** Sube a las pestañas (Cierre de día / Retiro / Relevo): la activa es el
   *  único stop de tabulador del grupo, así que es la que recibe el foco. */
  private focusSegmented(): void {
    this.host?.nativeElement
      ?.querySelector<HTMLElement>('app-segmented .seg-btn.on, app-segmented .seg-btn')
      ?.focus();
  }

  /** ¿El desplegable del select está abierto? PrimeNG lo marca en el disparador. */
  private selectAbierto(target: HTMLElement | null): boolean {
    if (!target) return false;
    const trigger = target.closest('[role="combobox"], .p-select');
    return trigger?.getAttribute('aria-expanded') === 'true';
  }

  /**
   * `↑` (o `←`) desde el botón devuelve el foco a la casilla exacta de donde se
   * bajó — si volviera siempre a la misma, corregir el último número después de
   * mirar el botón obligaría a navegar de nuevo toda la columna. `Enter` y espacio
   * NO se interceptan: son la activación nativa del botón.
   */
  onBotonKey(ev: KeyboardEvent) {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowLeft') return;
    const { col, row } = this.ultimaCelda;
    const g = this.grilla();
    const celda = g[col]?.[row] ?? g[g.length - 1]?.slice(-1)[0];
    if (!celda) return;
    ev.preventDefault();
    this.enfocar(celda);
  }

  /** De dónde se bajó al botón, para que `↑` vuelva ahí. */
  private ultimaCelda = { col: 0, row: 0 };

  /**
   * La grilla real: `[billetes, monedas, medios]`. Los 11 inputs de denominación
   * son UNA sola `QueryList` en orden de DOM, así que se parte por la cantidad de
   * billetes; los medios son su propia lista y **se omiten si no se renderizaron**.
   */
  private grilla(): HTMLInputElement[][] {
    const den = (this.denomInputs?.toArray() ?? []).map((r) => r.nativeElement);
    const med = (this.medioInputs?.toArray() ?? []).map((r) => r.nativeElement);
    const cols = [den.slice(0, this.billetes.length), den.slice(this.billetes.length)];
    if (med.length) cols.push(med);
    return cols;
  }

  private enfocar(el: HTMLInputElement) {
    el.focus();
    el.select();
  }

  /**
   * El botón de guardar, dentro del `p-button`. Si está deshabilitado (no hay nada
   * que guardar) el `focus()` no hace nada y el foco se queda donde estaba, que es
   * lo correcto: no hay a dónde bajar todavía.
   */
  private focusGuardar() {
    this.btnGuardar?.nativeElement.querySelector('button')?.focus();
  }

  /** Al entrar a una casilla se selecciona lo que hay: retecleás encima, no atrás. */
  selectAll(ev: Event) { (ev.target as HTMLInputElement).select(); }

  recalc() {
    this.recalcTotales();
    this.dirty.set(true); // §13: cualquier edición ensucia; se limpia solo al guardar OK
  }

  /** Solo los números — sin tocar `dirty`, para poder limpiar tras guardar. */
  private recalcTotales() {
    const monto = (l: number[]) => l.reduce((s, d) => s + (Number(this.denomCount[d]) || 0) * d, 0);
    const pzas = (l: number[]) => l.reduce((s, d) => s + (Number(this.denomCount[d]) || 0), 0);
    const b = monto(this.billetes), m = monto(this.monedas);
    this.totBilletes.set(b); this.totMonedas.set(m);
    this.recalcMedios();
    this.pzasBilletes.set(pzas(this.billetes)); this.pzasMonedas.set(pzas(this.monedas));
    this.arqTotal.set(Math.round((b + m) * 100) / 100);
  }

  // ─────────────────────────── guardar ───────────────────────────

  submit() {
    if (this.saving()) return; // §13 idempotencia visual: ignora re-clicks
    if (!this.canSubmit()) return;
    this.saving.set(true);
    this.confirmando.set(false);
    const denominations: Record<string, number> = {};
    for (const d of this.denoms) { const n = Number(this.denomCount[d]) || 0; if (n > 0) denominations[String(d)] = n; }
    const medios = Object.keys(this.medios).length ? { ...this.medios } : undefined;
    const relevo = this.aTipo() === 'relevo';
    const t = this.turnoSel();
    // Con turno, el encabezado sale de Kepler; el backend lo vuelve a resolver
    // por folio, así que esto es solo lo que se muestra.
    const cabecera = t
      ? { cash_cut_folio: t.folio, warehouse_code: t.warehouse_code, caja: t.caja, business_date: t.business_date, cajero_code: t.cajero_code || undefined }
      : { warehouse_code: this.aSuc.trim() || undefined, caja: this.aCaja.trim(), business_date: this.fmtDate(this.aDate), cajero_code: this.aCajero.trim() || undefined };
    this.svc.submit({
      ...cabecera, tipo: this.aTipo(),
      cajero_entrante: relevo ? (this.aEntrante.trim() || undefined) : undefined,
      denominations, medios, nota: this.aNota.trim() || undefined,
      incidencia_tipo: !relevo && this.aIncidencia ? this.aIncidencia : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false); this.result.set(r); this.dirty.set(false);
        const detail = r.tipo === 'relevo' ? `Relevo sellado (${this.money(r.total_contado)}).`
          : !r.reveal ? `Total contado ${this.money(r.total_contado)}. Falta que tu encargada lo valide.`
          : r.ambiguous ? 'Guardado. Varios cortes hoy: captura desde el turno para comparar.'
          : (r.matched ? `${this.diffLabel(r.diff_real)}: ${this.signed(r.diff_real || 0)}` : 'Guardado (el turno aún no cerró en Kepler).');
        this.toast.add({
          severity: this.revela && (r.diff_real || 0) > 0 ? 'warn' : 'success',
          summary: r.tipo === 'relevo' ? 'Relevo guardado' : 'Arqueo guardado', detail,
        });
        // El ticket sale SOLO, antes de limpiar el formulario: es el respaldo que se
        // firma en el momento, con la encargada al lado. Pedirle a la cajera que
        // además se acuerde de darle a un botón es perder el papel la mitad de las
        // veces — y el papel es la prueba física del conteo.
        this.imprimir(r);
        this.denomCount = {}; this.medios = {}; this.recalcTotales();
        this.cargarTurnos();  // el turno arqueado sale de la lista
        this.load();
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  /** La encargada firma el arqueo después de contarlo en el lugar. */
  validar(b: ArqueoRow) {
    if (this.validando()) return;
    this.validando.set(b.id);
    this.svc.validar(b.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.validando.set(null);
        this.toast.add({ severity: 'success', summary: 'Arqueo validado', detail: `Caja ${b.caja} · ${this.money(b.total_contado)}` });
        this.load();
      },
      error: (e) => { this.validando.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo validar.' }); },
    });
  }

  // --------------- despliegue de la fila: cortes de la persona ---------------
  /**
   * Ventana de los cortes que se traen al desplegar. 30 días es el horizonte con
   * el que se persigue un turno sin arquear; más atrás ya es auditoría, y para eso
   * está `/tienda/arqueo-historial`.
   */
  readonly cortesDias = 30;
  private readonly cortesCache = signal<Record<string, CortesPersona>>({});

  /** El estado va por persona×sucursal, no por fila: dos arqueos suyos comparten la lista. */
  private cortesKey(b: ArqueoRow): string { return `${(b.cajero_code || '').toUpperCase()}|${b.warehouse_code}`; }

  cortesDe(b: ArqueoRow): CortesPersona | null { return this.cortesCache()[this.cortesKey(b)] ?? null; }

  /**
   * Se dispara al desplegar. Cachea por persona y **no repregunta** si ya trajo la
   * lista: abrir y cerrar tres filas de la misma cajera es una sola llamada. El
   * `force` es del botón de reintento.
   */
  onExpand(b: ArqueoRow, force = false) {
    if (!b.cajero_code) return;
    const key = this.cortesKey(b);
    const prev = this.cortesCache()[key];
    if (prev && !force && !prev.error) return;
    this.setCortes(key, { loading: true, error: false, turnos: [], arqueados: 0, pct: 0 });
    this.svc.porCajera({ cajero: b.cajero_code, from: this.desdeHace(this.cortesDias), limit: 400 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const mismo = (c: string | null) => (c || '').toUpperCase() === (b.cajero_code || '').toUpperCase();
          // El backend puede devolver la misma persona en varias sucursales (mismo
          // codigo en dos tiendas): gana la de la fila que se abrio.
          const card = r.cajeras.find((c) => mismo(c.cajero_code) && c.warehouse_code === b.warehouse_code)
            ?? r.cajeras.find((c) => mismo(c.cajero_code))
            ?? null;
          const turnos = [...(card?.turnos ?? [])].sort((x, y) =>
            `${y.business_date}${y.hora_cierre || ''}`.localeCompare(`${x.business_date}${x.hora_cierre || ''}`));
          const arqueados = turnos.filter((t) => !!t.arqueo_id).length;
          this.setCortes(key, {
            loading: false, error: false, turnos, arqueados,
            pct: turnos.length ? Math.round((arqueados / turnos.length) * 100) : 0,
          });
        },
        error: () => this.setCortes(key, { loading: false, error: true, turnos: [], arqueados: 0, pct: 0 }),
      });
  }

  /** Suma de los medios declarados. Se llama también al teclear un medio. */
  private recalcMedios() {
    const t = this.mediosCampos.reduce((s, m) => s + (Number(this.medios[m.key]) || 0), 0);
    this.totMedios.set(Math.round(t * 100) / 100);
  }

  /** Solo los medios con monto: cinco ceros en el resumen no son información. */
  mediosDeclarados(): { key: string; label: string; monto: number }[] {
    return this.mediosCampos
      .map((m) => ({ key: m.key, label: m.label, monto: Number(this.medios[m.key]) || 0 }))
      .filter((m) => m.monto > 0);
  }

  private setCortes(key: string, v: CortesPersona) { this.cortesCache.update((m) => ({ ...m, [key]: v })); }

  /** 'YYYY-MM-DD' de hace N días, en la fecha local (la misma que usa el resto). */
  private desdeHace(dias: number): string {
    const d = new Date(); d.setDate(d.getDate() - dias); return this.fmtDate(d);
  }

  incidenciaLabel(v?: string | null): string {
    if (!v) return '—';
    return this.incidenciaOptions.find((o) => o.value === v)?.label ?? v;
  }

  private load() {
    this.loading.set(true);
    this.svc.list({ limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.rows.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  /** Fecha local → 'YYYY-MM-DD' sin corrimiento de TZ (§10: no re-convertir). */
  private fmtDate(d: Date): string {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  diffLabel(diff: number | null | undefined): string {
    if (diff == null) return 'Diferencia';
    if (diff > 0) return 'Faltante';
    if (diff < 0) return 'Sobrante';
    return 'Cuadrado';
  }
  // Pantalla de conteo de efectivo (incl. denominación de 50¢): SIEMPRE con centavos,
  // si no, 3×$0.50 se vería "$2" y una diferencia real de centavos parecería cuadrada.
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  signed(v: number): string { return (v > 0 ? '+' : '') + this.money(v); }
}
