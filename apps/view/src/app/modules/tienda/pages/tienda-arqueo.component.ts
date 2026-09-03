import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, NgZone, OnInit, QueryList, ViewChildren, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectButtonModule } from 'primeng/selectbutton';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService, ScopeOption } from '../../../core/services/data-scope.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, ArqueoResult, ArqueoRow, Turno } from '../arqueo.service';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';
import { imprimirTicket } from '../ticket-arqueo';

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
    SelectButtonModule, InputTextModule, TagModule,
    ContextHelpComponent, FreshnessPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in arq-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueo de caja</h1>
          <p class="surf-page-sub">
            Contá el efectivo físico por denominación y guardalo.
            @if (revela) { Al guardar, el sistema te muestra la diferencia real. }
            @else { El cuadre lo revisa tu encargada. }
          </p>
        </div>
        <div class="arq-head-right">
          <app-freshness-pill [since]="turnosAl()" label="Kepler" [staleAfterSec]="180" />
          <app-context-help topic="arqueo" />
        </div>
      </header>

      <div class="arq-2col" [class.arq-1col]="!canCapture() || (!revela && !rows().length)">
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
                <strong>Kepler no te abrió ninguna caja.</strong>
                <p class="muted">El arqueo se habilita cuando tu turno está abierto en el punto de venta. Si ya estás cobrando y no aparece, avisale a tu encargada.</p>
                @if (revela) {
                  <p-button type="button" label="Capturar sin turno" icon="pi pi-pencil" styleClass="p-button-sm p-button-text"
                            (click)="manual.set(true)"></p-button>
                }
              </div>
            </div>
          }

          @if (turnos().length && !manual()) {
            @if (turnos().length > 1) {
              <p class="arq-lbl arq-turno-lbl">
                Tenés <strong>{{ turnos().length }} cortes pendientes</strong>. Se cierran del más viejo al más nuevo.
              </p>
              <div class="arq-turnos">
                @for (t of turnosOrdenados(); track t.folio + t.warehouse_code; let i = $index) {
                  <!-- Solo el más viejo es accionable: los cortes se cierran en orden.
                       El backend lo exige igual — esto solo lo hace visible. -->
                  <button type="button" class="arq-turno" [class.sel]="t.folio === turnoFolio()"
                          [class.bloq]="i > 0" [disabled]="i > 0"
                          [attr.title]="i > 0 ? 'Primero cerrá el corte pendiente más viejo' : null"
                          (click)="elegirTurno(t.folio)">
                    <span class="arq-turno-caja"><span class="arq-turno-n">{{ i + 1 }}º</span> Caja {{ t.caja }}</span>
                    <span class="arq-turno-meta">{{ branchLabel(t.warehouse_code) }} · {{ t.business_date | date:'dd/MM' }}</span>
                    <span class="arq-turno-meta">{{ t.abierto ? 'Abierta desde ' + (t.hora_apertura || '—') : 'Cerró ' + (t.hora_cierre || '—') }}</span>
                    @if (i === 0 && !t.abierto) { <span class="arq-pide">Te toca arquear</span> }
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
              @if (!t.abierto) {
                <!-- Kepler cerró la caja: a partir de acá el arqueo no es opcional.
                     La app lo PIDE en el mismo momento en que el ERP lo pide. -->
                <div class="arq-pide-box">
                  <i class="pi pi-bell"></i>
                  <div>
                    <strong>Kepler cerró tu caja{{ t.hora_cierre ? ' a las ' + t.hora_cierre : '' }}. Te toca arquear.</strong>
                    @if (t.cerrado_hace_min != null) { <p class="muted">Hace {{ hace(t.cerrado_hace_min) }}.</p> }
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
                <select class="arq-fld arq-sel arq-fld-suc" [(ngModel)]="aSuc" (ngModelChange)="dirty.set(true)">
                  <option value="" disabled>Elegí…</option>
                  @for (w of sucursales(); track w.value) { <option [value]="w.value">{{ w.value }} — {{ w.label }}</option> }
                </select>
              </label>
              <label class="arq-lbl">Caja <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCaja" (ngModelChange)="dirty.set(true)" placeholder="2"></label>
              <!-- Sin selector de fecha: un arqueo es de HOY. Elegir una fecha
                   pasada permitiría sellar dinero de un día que ya cerró. -->
              <label class="arq-lbl">Fecha <span class="arq-fijo">{{ hoyTxt() }}</span></label>
              <label class="arq-lbl">Cajero <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCajero" (ngModelChange)="dirty.set(true)" placeholder="código"></label>
              @if (turnos().length) {
                <p-button type="button" label="Volver a mis turnos" icon="pi pi-arrow-left" styleClass="p-button-sm p-button-text" (click)="manual.set(false)"></p-button>
              }
            </div>
          }

          @if (puedeContar()) {
            <p-selectbutton [options]="tipoOptions" [ngModel]="aTipo()" (ngModelChange)="aTipo.set($event); dirty.set(true)"
                            optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="sb-liquid arq-seg" />
            @if (aTipo() === 'relevo') {
              <label class="arq-lbl arq-block">Cajero entrante <input pInputText class="arq-fld" [(ngModel)]="aEntrante" (ngModelChange)="dirty.set(true)" placeholder="quién recibe la caja"></label>
            }

            <p-table [value]="denoms" styleClass="p-datatable-sm arq-denoms-tbl">
              <ng-template #header>
                <tr><th>Denominación</th><th class="ta-r">Cantidad</th><th class="ta-r">Subtotal</th></tr>
              </ng-template>
              <ng-template #body let-d let-i="rowIndex">
                <tr>
                  <td class="arq-denom-lbl">{{ d >= 1 ? '$' + d : (d*100) + '¢' }}</td>
                  <td class="ta-r">
                    <!-- Input de texto (no p-inputnumber) a propósito: acá ↑/↓ SALTAN de
                         casilla en vez de sumar/restar. Con el spinner puesto, una flecha
                         de más cambia el conteo del billete sin que la cajera lo note. -->
                    <input #denomInput pInputText class="arq-num" inputmode="numeric" autocomplete="off"
                           [attr.aria-label]="'Cantidad de ' + (d >= 1 ? '$' + d : (d*100) + ' centavos')"
                           [value]="denomCount[d] ?? ''" placeholder="0"
                           (input)="onDenomInput(d, $event)" (keydown)="onDenomKey($event, i)" (focus)="selectAll($event)">
                  </td>
                  <td class="ta-r muted">{{ money((denomCount[d] || 0) * d) }}</td>
                </tr>
              </ng-template>
              <ng-template #footer>
                <tr class="arq-total-row"><td>Total contado</td><td></td><td class="ta-r strong">{{ money(arqTotal()) }}</td></tr>
              </ng-template>
            </p-table>
            <p class="arq-hint"><i class="pi pi-arrows-v"></i> Usá <kbd>↑</kbd> <kbd>↓</kbd> o <kbd>Enter</kbd> para moverte entre denominaciones.</p>

            @if (aTipo() === 'cierre') {
              <label class="arq-lbl arq-block">Incidencia <span class="muted">(opcional — si hubo un motivo)</span>
                <select class="arq-fld arq-sel" [(ngModel)]="aIncidencia" (ngModelChange)="dirty.set(true)">
                  <option value="">Ninguna</option>
                  <option value="faltante_justificado">Faltante justificado</option>
                  <option value="billete_falso">Billete falso</option>
                  <option value="robo">Robo</option>
                  <option value="error_cobro">Error de cobro</option>
                  <option value="otro">Otro</option>
                </select>
              </label>
            }
            <label class="arq-lbl arq-block">Nota <input pInputText class="arq-fld" [(ngModel)]="aNota" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label>

            <!-- Barra pegada al fondo: contando billetes se scrollea todo el rato, y
                 tanto el total como el botón quedaban fuera de vista. Son las dos
                 únicas cosas que la cajera necesita a mano todo el tiempo. -->
            <div class="arq-bar">
              <div class="arq-bar-total">
                <span class="arq-bar-l">Total contado</span>
                <span class="arq-bar-v">{{ money(arqTotal()) }}</span>
              </div>
              <p-button type="button" [label]="submitLabel()" icon="pi pi-lock"
                      [disabled]="!canSubmit() || saving()" [loading]="saving()" (click)="submit()"></p-button>
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
                <p class="muted">Guardado ({{ money(r.total_contado) }}). Hay <strong>varios cortes</strong> en esta caja hoy — capturá desde el turno para comparar contra el correcto.</p>
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
          <h3 class="arq-card-title">Arqueos recientes</h3>
          <p-table [value]="rows()" styleClass="p-datatable-sm arq-table" [rowHover]="true" [loading]="loading()">
            <ng-template #header>
              <tr>
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
            <ng-template #body let-b>
              <tr>
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
            <ng-template #emptymessage><tr><td [attr.colspan]="colspan()" class="arq-empty">Sin arqueos aún.</td></tr></ng-template>
          </p-table>
        </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .arq-head-right { display: inline-flex; align-items: center; gap: .4rem; margin-left: auto; }
    .arq-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .arq-2col.arq-1col { grid-template-columns: 1fr; }
    @media (max-width: 900px) { .arq-2col { grid-template-columns: 1fr; } }
    .arq-panel { padding: 1rem; }
    .arq-bar { position: sticky; bottom: 0; z-index: 3; display: flex; align-items: center; gap: 1rem;
               margin: .8rem -1rem -1rem; padding: .7rem 1rem;
               background: var(--card-bg); border-top: 1px solid var(--border-color);
               border-radius: 0 0 var(--r-md) var(--r-md); }
    .arq-bar-total { display: flex; flex-direction: column; line-height: 1.1; }
    .arq-bar-l { font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
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
    .arq-datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: .5rem .9rem; margin-bottom: .9rem;
                 padding: .7rem .8rem; border-radius: var(--r-md); background: var(--surface-hover-bg); border: 1px solid var(--border-color); }
    :host ::ng-deep .arq-seg { margin-bottom: .7rem; }
    .arq-head { display: flex; gap: .8rem; flex-wrap: wrap; margin: .8rem 0; align-items: flex-end; }
    .arq-lbl { display: inline-flex; flex-direction: column; gap: .2rem; font-size: .76rem; color: var(--text-muted); }
    :host ::ng-deep .arq-fld { font-size: .82rem; padding: .35rem .6rem; }
    :host ::ng-deep .arq-fld-sm { width: 5.5rem; }
    .arq-fld-suc { width: 11rem; }
    :host ::ng-deep .arq-num { width: 5rem; text-align: right; font-variant-numeric: tabular-nums; padding: .25rem .4rem; }
    :host ::ng-deep .arq-date .p-datepicker-input { width: 8.5rem; }
    .arq-block { display: block; margin: .8rem 0; }
    .arq-sel { font-size: .82rem; padding: .35rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); background: var(--card-bg); color: var(--text-main); }
    .arq-block .arq-sel { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-block .arq-fld { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-print { margin-top: .35rem; }
    :host ::ng-deep .arq-denoms-tbl { font-variant-numeric: tabular-nums; margin-bottom: .4rem; }
    :host ::ng-deep .arq-denoms-tbl .p-datatable-tbody > tr > td { padding: .2rem .5rem; }
    .arq-denom-lbl { font-variant-numeric: tabular-nums; }
    .arq-hint { margin: 0 0 .8rem; font-size: .72rem; color: var(--text-muted); display: flex; align-items: center; gap: .35rem; }
    .arq-hint kbd { font-family: var(--font-mono, monospace); font-size: .68rem; padding: .05rem .3rem; border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-hover-bg); }
    :host ::ng-deep .arq-total-row td { border-top: 2px solid var(--border-color); font-weight: 700; }
    .arq-result { margin-top: 1rem; padding: .9rem; border-radius: var(--r-md); border: 1px solid var(--border-color); background: var(--surface-hover-bg); }
    .arq-result.bad { border-color: color-mix(in srgb, var(--bad-fg) 40%, transparent); background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .arq-result.ok { border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); background: color-mix(in srgb, var(--ok-fg) 6%, transparent); }
    .arq-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: .6rem 1rem; }
    .arq-ev-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); display: block; }
    .arq-ev-v { font-size: .95rem; font-variant-numeric: tabular-nums; }
    .arq-mt { margin: .6rem 0 0; font-size: .78rem; }
    .arq-table { font-variant-numeric: tabular-nums; }
    .arq-mask { display: inline-block; margin-left: .35rem; font-size: .62rem; text-transform: uppercase; letter-spacing: .04em;
                font-weight: 700; padding: .05rem .3rem; border-radius: 4px; color: var(--bad-fg);
                background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .arq-dif-l { display: block; font-size: .62rem; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
    .arq-ok { display: inline-flex; align-items: center; gap: .3rem; font-size: .76rem; color: var(--ok-fg); font-weight: 600; }
    :host ::ng-deep .arq-tag-mini { margin-left: .3rem; transform: scale(.8); }
    .arq-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); } .ok { color: var(--ok-fg); }
  `],
})
export class TiendaArqueoComponent implements OnInit, HasUnsavedChanges {
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly dataScope = inject(DataScopeService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  @ViewChildren('denomInput') private denomInputs?: QueryList<ElementRef<HTMLInputElement>>;

  /**
   * ¿Se le revela el cuadre? Solo el supervisor del motor (`RECONCILIATION_VER`).
   * Espeja la regla del backend — acá es cosmético (el backend ya no manda los
   * campos), pero evita renderizar columnas que siempre saldrían vacías.
   */
  readonly revela = this.perms.can('manage', 'all')
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
  readonly variasSucursales = computed(() => this.sucursales().length > 1);

  readonly canCapture = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.STORE_ARQUEO_CAPTURAR] === true);

  readonly tipoOptions = [
    { label: 'Cierre de día', value: 'cierre' as const },
    { label: 'Relevo (cambio de turno)', value: 'relevo' as const },
  ];

  readonly denoms = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
  denomCount: Record<number, number> = {};
  readonly aTipo = signal<'cierre' | 'relevo'>('cierre');
  aSuc = ''; aCaja = ''; aDate: Date = new Date(); aCajero = ''; aEntrante = ''; aNota = ''; aIncidencia = '';
  readonly arqTotal = signal(0);
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly validando = signal<string | null>(null);
  readonly dirty = signal(false);
  readonly result = signal<ArqueoResult | null>(null);
  readonly rows = signal<ArqueoRow[]>([]);

  readonly submitLabel = computed(() =>
    this.aTipo() === 'relevo' ? 'Sellar relevo' : (this.revela ? 'Guardar y revelar diferencia' : 'Guardar arqueo'));
  readonly colspan = computed(() => 5 + (this.variasSucursales() ? 1 : 0) + (this.revela ? 3 : 0));

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
          detalle: pronto ? `${holgura} Andá preparando el efectivo.` : `${holgura} Faltan ${min} min.`,
          pronto,
        };
  }

  /**
   * "Hace 689 min" obliga a dividir mentalmente. Arriba de una hora se dice en
   * horas, y arriba de un día en días: la cajera necesita saber si es de recién
   * o de anteayer, no el número exacto.
   */
  hace(min: number): string {
    if (min < 60) return `${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return h === 1 ? '1 hora' : `${h} horas`;
    const d = Math.round(h / 24);
    return d === 1 ? '1 día' : `${d} días`;
  }

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
      capturado_por: this.auth.user()?.username || null,
      validado_por: null, validado_at: null,
    }, { revela: this.revela });
    if (!ok) {
      this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la ventana', detail: 'Permití las ventanas emergentes de este sitio para imprimir.' });
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
  onDenomKey(ev: KeyboardEvent, i: number) {
    const salto = ev.key === 'ArrowUp' ? -1 : (ev.key === 'ArrowDown' || ev.key === 'Enter') ? 1 : 0;
    if (!salto) return;
    ev.preventDefault();
    this.focusDenom(i + salto);
  }

  private focusDenom(i: number) {
    const inputs = this.denomInputs?.toArray() ?? [];
    if (i < 0 || i >= inputs.length) return;
    const el = inputs[i].nativeElement;
    el.focus();
    el.select();
  }

  /** Al entrar a una casilla se selecciona lo que hay: retecleás encima, no atrás. */
  selectAll(ev: Event) { (ev.target as HTMLInputElement).select(); }

  recalc() {
    this.arqTotal.set(this.denoms.reduce((s, d) => s + (Number(this.denomCount[d]) || 0) * d, 0));
    this.dirty.set(true); // §13: cualquier edición ensucia; se limpia solo al guardar OK
  }

  // ─────────────────────────── guardar ───────────────────────────

  submit() {
    if (this.saving()) return; // §13 idempotencia visual: ignora re-clicks
    this.saving.set(true);
    const denominations: Record<string, number> = {};
    for (const d of this.denoms) { const n = Number(this.denomCount[d]) || 0; if (n > 0) denominations[String(d)] = n; }
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
      denominations, nota: this.aNota.trim() || undefined,
      incidencia_tipo: !relevo && this.aIncidencia ? this.aIncidencia : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false); this.result.set(r); this.dirty.set(false);
        const detail = r.tipo === 'relevo' ? `Relevo sellado (${this.money(r.total_contado)}).`
          : !r.reveal ? `Total contado ${this.money(r.total_contado)}. Falta que tu encargada lo valide.`
          : r.ambiguous ? 'Guardado. Varios cortes hoy: capturá desde el turno para comparar.'
          : (r.matched ? `${this.diffLabel(r.diff_real)}: ${this.signed(r.diff_real || 0)}` : 'Guardado (el turno aún no cerró en Kepler).');
        this.toast.add({
          severity: this.revela && (r.diff_real || 0) > 0 ? 'warn' : 'success',
          summary: r.tipo === 'relevo' ? 'Relevo guardado' : 'Arqueo guardado', detail,
        });
        this.denomCount = {}; this.arqTotal.set(0);
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
