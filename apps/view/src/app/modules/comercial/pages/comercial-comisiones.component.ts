import { Router } from '@angular/router';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageService, ConfirmationService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { RUTA_DIRECTA_TABS } from '../ruta-directa-tabs';
import { ComercialComisionesObjetivoComponent } from './comercial-comisiones-objetivo.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import {
  ComercialService, CommissionBoardRow, CommissionRunDetail, CommissionLine,
  CommissionGate, CommissionRecalcResult, CommissionContrast, CommissionContrastRow,
  CommissionHeadroom, CommissionHeadroomRow, CommissionRunPayload, CommissionUniverseRow,
  PadronRuta, PadronAvisoPagadas, BonoRD, EscalasRD, TierRD, SimulacionEscalaRD, SupervisorNomina,
} from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';

/** `[RD.92]` Lo que el conmutador de arriba puede mostrar. */
const VISTAS = ['quincena', 'objetivo', 'padron', 'bonos', 'tabulador'] as const;
type Vista = typeof VISTAS[number];

/**
 * RD.6 / RD.17-RD.21 — Comisiones de Ruta Directa. **Pantalla de verificacion, sin acciones.**
 *
 * ── Por que no tiene botones ─────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-07, con el liston en 500 ms:
 *
 *     tablero del año (27 quincenas + su corrida) ....     2.7 ms
 *     detalle de una corrida .........................    23.8 ms
 *     calcular UNA quincena (lo que hacia el boton) .. 5,762.0 ms
 *
 * ⭐ **El unico camino lento del modulo eran las acciones.** `Vista previa` y `Crear corrida`
 * tocan `v_rd_route_daily`, que se materializa entera en cada consulta; leer una corrida ya
 * persistida es leer una tabla de 26 filas. Quitarlas no es una concesion: es lo que vuelve
 * rapida la pantalla — y de paso honesta, porque lo que se ve es lo que de verdad quedo
 * calculado, no un numero que aparecio porque alguien apreto algo.
 *
 * ⛔ **Y no hay cron detras.** Una quincena cerrada es un valor ESTATICO: se calcula una vez,
 * con el periodo ya cerrado, y no cambia. Lo escribe un acto deliberado -- recalcular desde una
 * quincena hacia adelante -- que es el mismo tramite cuando cierra un periodo y cuando cambia
 * la escala. La quincena que todavia corre **no se guarda**: guardarla obligaba a reescribirla
 * cada media hora, o sea una cifra de nomina moviendose sola.
 *
 * Esta pantalla **solo lee**. Lo que no esta calculado lo DECLARA (`sin_calcular`), que no es
 * lo mismo que `en_curso`: al primero le falta que alguien lo calcule, al segundo que termine
 * el periodo, y pintarlos igual hacia que una quincena olvidada se viera normal.
 *
 * ── Lo que esta pantalla no esconde ──────────────────────────────────────────────────────
 *  · El **neto**, no el bruto. La deduccion del supervisor es por persona y agregada sobre sus
 *    rutas, y el motor no la restaba en ningun lado.
 *  · Las **compuertas** con su motivo, y la distincion entre `en_curso` (le falta terminar) y
 *    `bloqueada` (le falla algo): son dos cosas que se arreglan distinto.
 *  · El **markup** con su nombre y la procedencia del costo que lo respalda — el bono del
 *    supervisor cuelga de ahi y antes no se veia.
 *  · Las rutas que **venden y no comisionan**, con su veredicto.
 *  · Hasta cuando llega el dato y cuando se calculo la corrida.
 *
 * ⚠️ Las fechas llegan del servidor como texto `YYYY-MM-DD` y se formatean CORTANDO LA CADENA,
 * nunca con `new Date(...)`: un `date` de pg llega a medianoche UTC y en hora de Mexico eso es
 * el dia ANTERIOR. Es el defecto que `[LC.16]` ya pago una vez.
 */
@Component({
  selector: 'app-comercial-comisiones',
  standalone: true,
  imports: [PageTabsComponent, FormsModule, TagModule, LoadStateComponent, MetricStripComponent, SegmentedComponent, FreshnessPillComponent, TableModule, ContextHelpComponent, ComercialComisionesObjetivoComponent, ToastModule, ConfirmDialogModule, DialogModule, InputNumberModule],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="cm-page">
      <p-toast />
      <p-confirmdialog />

      <!-- [RD.84] Alta y edicion del padron. Un solo dialogo para los dos actos: dar de baja es
           editar con fecha y motivo, no un boton aparte — tenerlo aparte invitaba a la baja sin
           motivo, que es la que se traga la historia entera ([RD.84.0], $19,096.84).

           Poka-yoke (§10): el envio esta deshabilitado mientras falte algo, en vez de dejar
           cometer el error y reportarlo. Von Restorff: la baja NO comparte color con guardar. -->
      <p-dialog [(visible)]="padronAbierto" [modal]="true" [draggable]="false"
                [style]="{ width: '34rem' }"
                [header]="padronEditando() ? ('Ruta ' + padronEditando()!.route_code) : 'Dar de alta una ruta'">
        <form class="cm-form" (ngSubmit)="guardarPadron()">
          @if (!padronEditando()) {
            <label class="cm-campo">
              <span>Código de ruta</span>
              <input type="text" name="route_code" inputmode="numeric"
                     [(ngModel)]="fRuta" required />
            </label>
          }

          <p class="cm-form-sep">Quién</p>
          <label class="cm-campo"><span>Chofer</span>
            <input type="text" name="chofer" [(ngModel)]="fChofer" /></label>
          <label class="cm-campo"><span>Supervisor</span>
            <input type="text" name="supervisor" [(ngModel)]="fSupervisor" /></label>
          <label class="cm-campo"><span>Plaza o zona</span>
            <input type="text" name="zona" [(ngModel)]="fZona" /></label>

          <p class="cm-form-sep">Cuánto se le deduce</p>
          <label class="cm-campo">
            <span>Nómina de banco <span class="cm-muted">(se resta de la comisión)</span></span>
            <input type="number" name="nomina" min="0" step="0.01" [(ngModel)]="fNomina" required />
          </label>

          <p class="cm-form-sep">Desde cuándo y hasta cuándo</p>
          <label class="cm-campo">
            <span>Empieza a comisionar</span>
            <input type="date" name="desde" [(ngModel)]="fDesde" />
            <small class="cm-muted">
              Vacío = desde siempre. Con fecha, las quincenas anteriores no le pagan.
            </small>
          </label>
          @if (padronEditando()) {
            <label class="cm-campo">
              <span>Deja de comisionar</span>
              <input type="date" name="hasta" [(ngModel)]="fHasta" />
              <small class="cm-muted">
                Es el último día en que cobra. Una baja a mitad de quincena paga la quincena
                entera: el tabulador es escalonado y no se prorratea.
              </small>
            </label>
            <label class="cm-campo cm-campo--check">
              <input type="checkbox" name="activo" [(ngModel)]="fActivo" />
              <span>Sigue activa</span>
            </label>
          }

          <label class="cm-campo">
            <span>Motivo {{ esBaja() ? '' : '(opcional)' }}</span>
            <textarea name="notes" rows="2" [(ngModel)]="fNotas"></textarea>
            @if (esBaja()) {
              <small class="cm-muted">
                Obligatorio en una baja: es lo único que va a explicar esta fila dentro de seis
                meses, cuando alguien pregunte por qué esta ruta dejó de cobrar.
              </small>
            }
          </label>

          @if (padronAviso(); as a) {
            <div class="cm-gate bad">
              <strong><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Toca {{ a.quincenas }} quincena(s) ya pagada(s)</strong>
              <p class="cm-micro">
                {{ a.detalle }} — <strong>{{ a.pagado }}</strong>. Lo pagado no se recalcula solo,
                pero si alguien corre «calcular desde», esas quincenas saldrían distintas.
              </p>
              <label class="cm-campo cm-campo--check">
                <input type="checkbox" name="confirmar" [(ngModel)]="fConfirmar" />
                <span>Sí, es justamente lo que estoy corrigiendo</span>
              </label>
            </div>
          }

          @if (padronErr(); as e) {
            <p class="cm-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ e }}</p>
          }

          <div class="cm-form-pie">
            <button type="button" class="cm-btn-sec" (click)="padronAbierto.set(false)">Cancelar</button>
            <button type="submit" [disabled]="!formOk() || padronGuardando()"
                    [class]="esBaja() ? 'cm-btn cm-btn--baja' : 'cm-btn'">
              {{ padronGuardando() ? 'Guardando…' : (esBaja() ? 'Dar de baja' : 'Guardar') }}
            </button>
          </div>
        </form>
      </p-dialog>

      <!-- [RD.85] Alta y edicion de un bono. Mismo criterio que el padron: apagar es editar,
           no un boton aparte, porque un bono apagado conserva su configuracion. -->
      <p-dialog [(visible)]="bonoAbierto" [modal]="true" [draggable]="false"
                [style]="{ width: '34rem' }"
                [header]="bonoEditando() ? ('Bono · ' + bonoEditando()!.nombre) : 'Nuevo bono'">
        <form class="cm-form" (ngSubmit)="guardarBono()">
          <label class="cm-campo"><span>Nombre</span>
            <input type="text" name="bnombre" [(ngModel)]="bNombre" required />
            <small class="cm-muted">Es con lo que se lee el bono en el recibo del chofer.</small>
          </label>

          <p class="cm-form-sep">Quién y cuándo</p>
          <label class="cm-campo"><span>Para</span>
            <select name="bbenef" [(ngModel)]="bBenef">
              <option value="chofer">Chofer</option>
              <option value="supervisor">Supervisor</option>
            </select>
          </label>
          <label class="cm-campo"><span>Periodo</span>
            <select name="bperiodo" [(ngModel)]="bPeriodo">
              <option value="quincena">Quincenal — entra a esta nómina</option>
              <option value="mes">Mensual — entra una sola vez al mes</option>
            </select>
            <small class="cm-muted">
              No tiene valor por omisión a propósito: un bono mensual sin marcar entraría a las
              dos quincenas del mes y se pagaría <strong>dos veces</strong>.
            </small>
          </label>
          <label class="cm-campo"><span>Ruta <span class="cm-muted">(vacío = todas)</span></span>
            <input type="text" name="bruta" [(ngModel)]="bRuta" /></label>

          <p class="cm-form-sep">Cuándo se cumple</p>
          <label class="cm-campo"><span>Métrica</span>
            <select name="bmetrica" [(ngModel)]="bMetrica">
              <option value="venta">Venta de la quincena</option>
              <option value="markup_pct">Margen sobre costo (%)</option>
              <option value="visitas">Visitas</option>
              <option value="volumen">Volumen</option>
              <option value="manual">Manual — la marca una persona</option>
            </select>
          </label>
          <label class="cm-campo"><span>Comparador</span>
            <select name="bcomp" [(ngModel)]="bComp">
              <option value="gte">Alcanza o pasa el umbral</option>
              <option value="gt">Pasa el umbral (estricto)</option>
            </select>
          </label>
          <label class="cm-campo">
            <span>Umbral <span class="cm-muted">en {{ unidadMetrica() }}</span></span>
            <input type="number" name="bumbral" step="0.0001" [(ngModel)]="bUmbral" required />
          </label>
          <label class="cm-campo">
            <span>Venta mínima para que aplique <span class="cm-muted">(opcional)</span></span>
            <input type="number" name="bgate" step="0.01" [(ngModel)]="bGate" />
            <small class="cm-muted">
              Es una compuerta aparte del umbral: aunque la métrica se cumpla, sin esta venta
              el bono no paga.
            </small>
          </label>

          <p class="cm-form-sep">Cuánto paga</p>
          <label class="cm-campo"><span>Monto</span>
            <input type="number" name="bmonto" min="0" step="0.01" [(ngModel)]="bMonto" required /></label>

          @if (bonoEditando()) {
            <label class="cm-campo cm-campo--check">
              <input type="checkbox" name="bactivo" [(ngModel)]="bActivo" />
              <span>Activo</span>
            </label>
            <p class="cm-muted cm-micro">
              Apagarlo no lo borra: conserva su configuración y deja explicable la quincena que
              sí lo pagó.
            </p>
          }

          @if (bonoErr(); as e) {
            <p class="cm-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ e }}</p>
          }
          <div class="cm-form-pie">
            <button type="button" class="cm-btn-sec" (click)="bonoAbierto.set(false)">Cancelar</button>
            <button type="submit" class="cm-btn" [disabled]="!bonoOk() || bonoGuardando()">
              {{ bonoGuardando() ? 'Guardando…' : 'Guardar' }}
            </button>
          </div>
        </form>
      </p-dialog>
      <app-page-tabs [tabs]="tabsRD" />
      <header class="cm-head">
        <div>
          <h1>Comisiones de Ruta Directa</h1>
          <p class="cm-sub">
            Quincena de 14 días · la comisión va sobre el <strong>subtotal</strong>
            y la compuerta la abre la <strong>venta total</strong>
          </p>
        </div>
        <label class="cm-year">Año
          <select [ngModel]="anio()" (ngModelChange)="anio.set(+$event); cargar()">
            @for (y of anios; track y) { <option [value]="y">{{ y }}</option> }
          </select>
        </label>
        <!-- [AUD.1] Regla P: la jerga de esta pantalla (umbral, markup sobre costo, los siete
             motivos de no pago, los tres veredictos de costo) vive en el diccionario versionado.
             Antes vivia en SIETE atributos title, o sea solo para quien tiene mouse. -->
        <app-context-help topic="comisiones-rd" />
        <!-- [AUD-CM.7] La edad de la venta de LA CORRIDA: solo en la nómina. En Bono por objetivo convivía
             con la píldora de su propio mes y la pantalla decía «hace 6 d» y «ahora» a la vez. -->
        @if (vista() === 'quincena' && run(); as r) {
          <app-freshness-pill measures="data" [since]="r.data_as_of" label="Venta medida"
                              [staleAfterSec]="172800" />
        }
      </header>

      <!-- [AUD-A6] Todo lo que es comision de Ruta Directa vive aca. El Objetivo mensual tenia
           pantalla propia y era la misma nomina mirada por otro lado: el bono que entra a la
           quincena. ⛔ Pero NO es una pestana mas de las de abajo: aquellas son vistas de UNA
           quincena y el objetivo es MENSUAL. Colgarlo ahi haria que cambiara de significado al
           elegir otra quincena. Por eso el conmutador va a este nivel, sobre el eje del tiempo.
           ⚠️ La de Logistica (/finanzas/comisiones-logistica) NO entra: otro permiso, otra
           poblacion (choferes de embarque) y otro dominio. Fundirla filtraria nomina de RD.
           [RD.92] Quién cobra, Bonos y Tabulador suben a ESTE nivel por la misma razon: no son
           de una quincena. Colgados de las pestanas de la quincena desaparecian al elegir una
           sin corrida (Q22 a Q27), y su comentario afirmaba lo contrario. -->
      <!-- ⚠️ app-segmented emite string (sirve a toda la suite) y el signal es de una union.
           Se estrecha en un metodo: vista.set($event) tipa mal, y vitest NO tipa las
           plantillas — el error solo sale en Build & typecheck o en check-template-types. -->
      <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="verVista($event)"
                     ariaLabel="Qué se está viendo" />

      @if (vista() === 'objetivo') {
        <app-comercial-comisiones-objetivo [embebido]="true" />
      } @else if (vista() === 'padron') {
        <!-- [RD.80] El padron NO mira la corrida: mira quien esta dado de alta para cobrar
             y si su fuente sigue viva. La pestana "No comisionan" no podia contestar esto
             porque sale de las lineas del espejo del libro. -->
        @if (padronHallazgos().length) {
          <p class="cm-eyebrow cm-sec-t">Lo que no cuadra en el padrón · {{ padronHallazgos().length }}</p>
        }
        @if (padronEnRiesgo(); as n) {
          <p class="cm-falto-grito">
            <strong class="cm-neg">{{ n }}</strong>
            ruta(s) <strong>cobran comision y su fuente no da senal</strong>.
            El tabulador es escalonado: sin dias no se paga &laquo;un poco menos&raquo;,
            se paga <strong class="cm-neg">$0</strong>.
          </p>
        }
        @if (padronVendeSinCobrar(); as m) {
          <p class="cm-muted cm-micro">
            Y {{ money(m) }} de <strong>subtotal</strong> en 30 dias esta en rutas que
            <strong>no comisionan</strong>. Puede ser correcto — las vecinales no son Ruta
            Directa — pero con el monto al lado la exclusion se puede revisar.
          </p>
        }
        <div class="cm-table-wrap">
          <table class="surf-table surf-table--plain surf-table--sticky">
            <thead><tr>
              <!-- [AUD] "Vendio" decia una cosa y la celda pintaba otra: el valor es
                   subtotal_30d, y subtotal y venta difieren 6.4% ($399,857 en 30 dias).
                   El diccionario de esta misma pantalla ya ensena la diferencia, y el
                   subtotal es ademas la BASE con que se calcula la comision. -->
              <th>Ruta</th><th>Chofer</th><th>Plaza o zona</th>
              <th>Comisiona</th><th>Último día con dato</th>
              <th class="comm-num">Subtotal (30 d)</th><th>Qué pasa</th>
            </tr></thead>
            <tbody>
              @for (r of padronHallazgos(); track r.route_code) {
                <tr [class.cm-fila-grito]="r.problema === 'cobra_sin_fuente'">
                  <td class="comm-num">{{ r.route_code }}</td>
                  <td class="cm-name">{{ r.chofer_nombre || '—' }}</td>
                  <td class="cm-muted">{{ r.plaza_o_zona || '—' }}</td>
                  <td>{{ r.comisiona ? 'sí' : 'no' }}</td>
                  <td [class.cm-corta]="r.fuente_estado !== 'viva'">
                    {{ etiquetaFuente(r) }}
                    @if (r.ultimo_dia_con_dato) {
                      <span class="cm-muted cm-micro"> · {{ dia(r.ultimo_dia_con_dato) }}</span>
                    }
                  </td>
                  <td class="comm-num cm-mono">{{ money(r.subtotal_30d) }}</td>
                  <td class="cm-nota">
                    <p-tag [severity]="sevProblema(r.problema)"
                           [value]="etiquetaProblema(r.problema)" />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <!-- [RD.84] El padron EDITABLE. Va DEBAJO de los hallazgos a proposito: primero
             que pasa, despues con que se arregla. Y es otra tabla, no la misma: la de
             arriba es el universo DERIVADO del ERP (todas las rutas que existen) y no se
             puede editar; esta son las filas de commission_route_config, que si. -->
        <section class="cm-padron">
          <div class="cm-padron-tit">
            <div>
              <p class="cm-eyebrow">El padrón</p>
              <p class="cm-muted cm-micro">
                Quién cobra comisión de Ruta Directa, desde cuándo y hasta cuándo.
                Hasta hoy esto se cambiaba con una migración: mover las rutas 321 y 322 a
                Vecinal —una decisión de Comercial— costó un despliegue.
              </p>
            </div>
            @if (puedeGestionar()) {
              <button type="button" class="cm-btn" (click)="abrirAlta()">
                <i class="pi pi-plus" aria-hidden="true"></i> Dar de alta una ruta
              </button>
            }
          </div>
          <div class="cm-table-wrap">
            <table class="surf-table surf-table--plain surf-table--sticky">
              <thead><tr>
                <th>Ruta</th><th>Chofer</th><th>Supervisor</th>
                <th class="comm-num">Nómina de banco</th>
                <th>Vigencia</th><th class="comm-num">Ya pagado</th><th></th>
              </tr></thead>
              <tbody>
                @for (p of padronFilas(); track p.id) {
                  <tr [class.cm-fila-baja]="!p.activo">
                    <td class="comm-num">{{ p.route_code }}</td>
                    <td class="cm-name">{{ p.chofer_nombre || '—' }}</td>
                    <td class="cm-muted">{{ p.supervisor_nombre || '—' }}</td>
                    <td class="comm-num cm-mono">{{ money(p.nomina_banco) }}</td>
                    <td>{{ vigencia(p) }}</td>
                    <td class="comm-num cm-mono">
                      @if (p.quincenas_pagadas) {
                        {{ money(p.pagado_historico) }}
                        <span class="cm-muted cm-micro"> · {{ p.quincenas_pagadas }} q</span>
                      } @else { <span class="cm-muted">—</span> }
                    </td>
                    <td>
                      @if (puedeGestionar()) {
                        <button type="button" class="cm-btn-sec cm-btn-min"
                                (click)="abrirEdicion(p)">Editar</button>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="cm-empty">
                    El padrón está vacío: ninguna ruta cobra comisión de Ruta Directa.
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (padronErr(); as e) {
            <p class="cm-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ e }}</p>
          }
        </section>

        <!-- [RD.100] D3: al supervisor se le paga 20 % de sus rutas + bonos − su nómina de banco.
             La nómina se edita en la fila; cada cambio abre una versión desde su fecha, así una
             quincena vieja se recalcula con la nómina que tenía entonces. -->
        <section class="cm-padron">
          <div class="cm-padron-tit">
            <div>
              <p class="cm-eyebrow">Nómina de banco de los supervisores</p>
              <p class="cm-muted cm-micro">
                Se le resta al supervisor cada quincena, de su {{ pctSupervisor() }} de las comisiones
                de sus rutas más sus bonos. Sin nómina capturada, su neto no se puede calcular y
                la quincena no se aprueba.
              </p>
            </div>
          </div>
          <div class="cm-table-wrap">
            <table class="surf-table surf-table--plain surf-table--sticky">
              <thead><tr>
                <th>Supervisor</th><th>Rutas</th>
                <th class="comm-num">Nómina por quincena</th><th>Desde</th><th></th>
              </tr></thead>
              <tbody>
                @for (s of nominasSup(); track s.nombre) {
                  <tr [class.cm-fila-baja]="!s.activo">
                    <td class="cm-name">{{ s.nombre }}</td>
                    <td class="cm-muted cm-mono">{{ s.rutas.join(', ') }}</td>
                    @if (puedeGestionar()) {
                      <td class="comm-num">
                        <p-inputnumber class="cm-tier" mode="decimal" prefix="$" locale="es-MX"
                                       [minFractionDigits]="2" [maxFractionDigits]="2" [min]="0"
                                       placeholder="sin capturar"
                                       [ariaLabel]="'Nómina de banco de ' + s.nombre"
                                       [ngModel]="borradorNomina()[s.nombre]?.monto ?? s.nomina_banco"
                                       (ngModelChange)="editarNomina(s, { monto: $event })" />
                      </td>
                      <td>
                        <input type="date" [attr.aria-label]="'Desde cuándo aplica la nómina de ' + s.nombre"
                               [ngModel]="borradorNomina()[s.nombre]?.desde ?? s.valid_from"
                               (ngModelChange)="editarNomina(s, { desde: $event })" />
                      </td>
                      <td>
                        <button type="button" class="cm-btn-sec cm-btn-min"
                                [disabled]="!borradorNomina()[s.nombre] || guardandoNomina() === s.nombre"
                                (click)="guardarNomina(s)">
                          {{ guardandoNomina() === s.nombre ? 'Guardando…' : 'Guardar' }}
                        </button>
                      </td>
                    } @else {
                      <td class="comm-num cm-mono">
                        @if (s.nomina_banco !== null) { {{ money(s.nomina_banco) }} }
                        @else { <span class="cm-neg">sin capturar</span> }
                      </td>
                      <td>{{ s.valid_from ? dia(s.valid_from) : '—' }}</td>
                      <td></td>
                    }
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="cm-empty">
                    Ninguna ruta del padrón tiene supervisor.
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (supervisoresErr(); as e) {
            <p class="cm-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ e }}</p>
          }
        </section>

        <p class="cm-warn">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <span>
            <strong>La lista de arriba no decide nada: lo declara.</strong> Que una ruta siga
            cobrando con la fuente muerta, o que una que vende quede fuera, son
            <strong>decisiones de Direccion</strong> — la 321 y la 322 operan hoy en el ERP
            con codigo nuevo, y si la comision sigue al chofer o al tipo de ruta no lo puede
            resolver una pantalla. Lo que la pantalla si puede hacer es que la contradiccion
            deje de ser invisible — y, desde <strong>[RD.84]</strong>, que la decision
            <strong>se registre aqui</strong>: la tabla de abajo es el padron, y se edita.
            <br />
            <strong>De donde sale:</strong> del <em>padron derivado</em> —todas las rutas que
            existen, comisionen o no— y de su venta de los ultimos <strong>30 dias</strong>.
            <strong>No sale de la quincena</strong>, asi que no depende de que haya corrida
            ni cambia al elegir otro periodo. La pestana <em>No comisionan</em> es otra cosa:
            sale de las <strong>lineas de la corrida</strong> y habla solo de ese periodo.
          </span>
        </p>
      } @else if (vista() === 'bonos') {
        <!-- [RD.85] Los bonos se capturaban por migracion: la tabla tenia UPDATE y ningun
             INSERT. El libro pago $140,800 en bonos en 20 quincenas -- $7,040 por
             quincena, mas que la comision de varias rutas juntas. -->
        <div class="cm-padron-tit">
          <div>
            <p class="cm-eyebrow">Bonos vigentes</p>
            <p class="cm-muted cm-micro">
              Lo que se suma a la comisión cuando una ruta pasa su umbral.
              Cuelgan del <strong>tabulador vigente</strong>
              @if (bonos()[0]?.escala_desde) { (desde {{ dia(bonos()[0].escala_desde!) }}) }
              y una versión nueva los hereda.
            </p>
          </div>
          @if (puedeGestionar()) {
            <button type="button" class="cm-btn" (click)="abrirBonoAlta()">
              <i class="pi pi-plus" aria-hidden="true"></i> Nuevo bono
            </button>
          }
        </div>
        <div class="cm-table-wrap">
          <table class="surf-table surf-table--plain surf-table--sticky">
            <thead><tr>
              <th>Bono</th><th>Para</th><th>Ruta</th><th>Periodo</th>
              <th>Se cumple cuando</th><th class="comm-num">Paga</th>
              <th>Estado</th><th></th>
            </tr></thead>
            <tbody>
              @for (b of bonos(); track b.id) {
                <tr [class.cm-fila-baja]="!b.activo">
                  <td class="cm-name">{{ b.nombre }}</td>
                  <td class="cm-muted">{{ b.beneficiario }}</td>
                  <td class="comm-num">{{ b.route_code || 'todas' }}</td>
                  <td>
                    <!-- ⚠️ El periodo se pinta SIEMPRE: es lo que impide que un bono
                         mensual entre a las dos quincenas y se pague dos veces. -->
                    <p-tag severity="secondary" [value]="b.periodo === 'mes' ? 'mensual' : 'quincenal'" />
                  </td>
                  <td class="cm-nota">{{ reglaBono(b) }}</td>
                  <td class="comm-num cm-mono">{{ money(b.monto) }}</td>
                  <td>
                    <!-- [AUD-CM.3] Un bono que paga $0 no se anuncia «activo» en verde: Bono por objetivo
                         decía «hoy vale $0» del mismo bono. Y «activo» en 17 de 17 renglones no
                         distinguía nada: va en texto; lo que se sale de lo normal, con peso. -->
                    @if (!b.activo) { <strong>apagado</strong> }
                    @else if (!pagaAlgo(b)) { <strong class="cm-aviso-txt">no paga: importe $0</strong> }
                    @else { <span class="cm-muted">activo</span> }
                  </td>
                  <td>
                    @if (puedeGestionar() && !b.grupo) {
                      <button type="button" class="cm-btn-sec cm-btn-min"
                              (click)="abrirBonoEdicion(b)">Editar</button>
                    } @else if (b.grupo) {
                      <span class="cm-muted cm-micro">en «Bono por objetivo»</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="cm-empty">
                  El tabulador vigente no tiene ningún bono configurado.
                  <strong>Eso no es «nadie cobró bono»: es que no hay ninguno que cobrar.</strong>
                </td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (bonoErr(); as e) {
          <p class="cm-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ e }}</p>
        }
      } @else if (vista() === 'tabulador') {
        <!-- [RD.86] El tabulador. ⛔ Hasta hoy NINGUNA pantalla consumia /scales: el
             endpoint existia desde [RD.66] y el numero que decide el porcentaje de cada
             peso solo se podia cambiar por curl.

             La regla de esta pestana: NO se puede estrenar sin simular antes. El
             tabulador es un acantilado y mover un escalon no cambia un porcentaje --
             apaga depositos enteros. -->
        <div class="cm-padron-tit">
          <div>
            <p class="cm-eyebrow">El tabulador</p>
            <p class="cm-muted cm-micro">
              Lo que decide el porcentaje de cada peso. La compuerta la abre la
              <strong>venta</strong>; el porcentaje se aplica sobre el
              <strong>subtotal</strong>.
              @if (escalas()?.piso_editable; as piso) {
                Una versión nueva no puede empezar antes del
                <strong>{{ dia(piso) }}</strong>: lo pagado no se recalcula.
              }
            </p>
          </div>
        </div>

        <!-- [AUD-CM.12] Es una explicación, no un error: sin caja roja. -->
        <p class="cm-warn">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <span>
            <strong>Es un acantilado, no una rampa.</strong> Debajo del primer escalón no
            hay porcentaje: la comisión es <strong class="cm-neg">$0</strong>, no «un poco
            menos». Mover el piso no baja un pago — <strong>lo apaga</strong>.
          </span>
        </p>

        <div class="cm-table-wrap">
          <table class="surf-table surf-table--plain">
            <thead><tr>
              <!-- [AUD-CM.13] El escalón incluye su «desde» y excluye su «hasta» (COMMENT de
                   commission_scale_tiers): sin decirlo, 194,999.99 parecía estar en dos escalones. -->
              <th class="comm-num">Desde (venta) · incluido</th>
              <th class="comm-num">Hasta · sin incluir</th>
              <th class="comm-num">Paga sobre el subtotal</th>
              <th></th>
            </tr></thead>
            <tbody>
              @for (t of borrador(); track $index) {
                <tr>
                  <td class="comm-num">
                    <!-- [AUD-CM.13] Con formato de dinero y porcentaje: decía «189999.99» y «3.75». -->
                    <p-inputnumber class="cm-tier" [readonly]="!puedeGestionar()" mode="decimal" prefix="$" locale="es-MX"
                                   [minFractionDigits]="2" [maxFractionDigits]="2"
                                   [ngModel]="t.min_amount" [ngModelOptions]="{ standalone: true }"
                                   (ngModelChange)="setTier($index, 'min_amount', $event)"
                                   [ariaLabel]="'Escalón ' + ($index + 1) + ', desde'" />
                  </td>
                  <td class="comm-num">
                    <p-inputnumber class="cm-tier" [readonly]="!puedeGestionar()" mode="decimal" prefix="$" locale="es-MX"
                                   [minFractionDigits]="2" [maxFractionDigits]="2"
                                   [ngModel]="t.max_amount" [ngModelOptions]="{ standalone: true }"
                                   (ngModelChange)="setTier($index, 'max_amount', $event)"
                                   [placeholder]="$index === borrador().length - 1 ? 'sin techo' : ''"
                                   [ariaLabel]="'Escalón ' + ($index + 1) + ', hasta'" />
                  </td>
                  <td class="comm-num">
                    <p-inputnumber class="cm-tier cm-tier--pct" [readonly]="!puedeGestionar()" mode="decimal" suffix=" %" locale="es-MX"
                                   [minFractionDigits]="0" [maxFractionDigits]="4"
                                   [ngModel]="t.pct" [ngModelOptions]="{ standalone: true }"
                                   (ngModelChange)="setTier($index, 'pct', $event)"
                                   [ariaLabel]="'Escalón ' + ($index + 1) + ', porcentaje sobre el subtotal'" />
                  </td>
                  <td>
                    @if (puedeGestionar()) {
                      <button type="button" class="cm-btn-sec cm-btn-min"
                              (click)="quitarTier($index)">Quitar</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (huecoTabulador(); as h) {
          <p class="cm-err">
            <i class="pi pi-times-circle" aria-hidden="true"></i> {{ h }}
          </p>
        }

        @if (puedeGestionar()) {
          <div class="cm-tabul-pie">
            <button type="button" class="cm-btn-sec" (click)="agregarTier()">
              <i class="pi pi-plus" aria-hidden="true"></i> Escalón
            </button>
            <button type="button" class="cm-btn-sec" [disabled]="tabuladorSinCambios()" (click)="restaurarTabulador()">
              Descartar cambios
            </button>
            <button type="button" class="cm-btn" [disabled]="!!huecoTabulador() || simulando()"
                    (click)="simularTabulador()">
              {{ simulando() ? 'Simulando…' : 'Ver qué pasaría' }}
            </button>
          </div>
        }

        @if (simulacion(); as s) {
          <section class="cm-sim">
            <p class="cm-eyebrow">
              Sobre Q{{ s.base.period_no }}/{{ s.base.anio }} — la última quincena pagada
              ({{ dia(s.base.date_from) }} a {{ dia(s.base.date_to) }}, {{ s.base.rutas }} rutas)
            </p>
            <p class="cm-sim-grito" [class.cm-neg]="s.delta < 0">
              {{ s.delta >= 0 ? 'Pagaría' : 'Dejaría de pagar' }}
              <strong>{{ money(s.delta < 0 ? -s.delta : s.delta) }}</strong>
              @if (s.caen) {
                · <strong class="cm-neg">{{ s.caen }}</strong>
                ruta(s) se quedan <strong class="cm-neg">sin escalón</strong>
              }
              @if (s.suben) { · {{ s.suben }} ruta(s) alcanzan uno }
            </p>
            <p class="cm-muted cm-micro">
              {{ money(s.total_hoy) }} hoy &rarr; {{ money(s.total_nuevo) }} con el
              tabulador propuesto. <strong>Sólo se mueve el tabulador</strong>: bonos y
              deducciones quedan como están, para que el número conteste qué hace
              <em>este</em> escalón y no otra cosa.
            </p>
            <div class="cm-table-wrap">
              <table class="surf-table surf-table--plain surf-table--sticky">
                <thead><tr>
                  <th>Ruta</th><th>Chofer</th>
                  <th class="comm-num">Vendió</th>
                  <th class="comm-num">% hoy</th><th class="comm-num">% nuevo</th>
                  <th class="comm-num">Cobra hoy</th><th class="comm-num">Cobraría</th>
                  <th class="comm-num">Δ</th>
                </tr></thead>
                <tbody>
                  @for (f of simulacion()!.filas; track f.route_code) {
                    <tr [class.cm-fila-grito]="f.cae_del_acantilado">
                      <td class="comm-num">{{ f.route_code }}</td>
                      <td class="cm-name">{{ f.beneficiario_nombre || '—' }}</td>
                      <td class="comm-num cm-mono">{{ money(f.venta) }}</td>
                      <td class="comm-num">{{ f.pct_hoy != null ? pct(f.pct_hoy) + '%' : '—' }}</td>
                      <td class="comm-num" [class.cm-neg]="f.cae_del_acantilado">
                        {{ f.pct_nuevo != null ? pct(f.pct_nuevo) + '%' : 'sin escalón' }}
                      </td>
                      <td class="comm-num cm-mono">{{ money(f.comision_hoy) }}</td>
                      <td class="comm-num cm-mono">{{ money(f.comision_nueva) }}</td>
                      <td class="comm-num cm-mono is-strong" [class.cm-neg]="f.delta < 0">
                        {{ f.delta === 0 ? '—' : money(f.delta) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            @if (puedeGestionar()) {
              <div class="cm-tabul-pie">
                <label class="cm-campo">
                  <span>Rige desde</span>
                  <input type="date" [ngModel]="desdeTabulador()"
                         [ngModelOptions]="{ standalone: true }"
                         (ngModelChange)="desdeTabulador.set($event)"
                         [min]="minTabulador()" />
                </label>
                <!-- [RD.100] La parte del supervisor (D3) es de esta versión del tabulador. -->
                <label class="cm-campo">
                  <span>Parte del supervisor</span>
                  <p-inputnumber class="cm-tier cm-tier--pct" mode="decimal" suffix=" %" locale="es-MX"
                                 [min]="0" [max]="100" [maxFractionDigits]="2"
                                 [ngModel]="pctSupBorrador() ?? pctSupVigente()"
                                 [ngModelOptions]="{ standalone: true }"
                                 (ngModelChange)="pctSupBorrador.set($event)" />
                </label>
                <button type="button" class="cm-btn cm-btn--baja"
                        [disabled]="!desdeTabulador() || estrenando()"
                        (click)="confirmarEstreno()">
                  {{ estrenando() ? 'Estrenando…' : 'Estrenar esta versión' }}
                </button>
              </div>
            }
          </section>
        } @else if (puedeGestionar()) {
          <p class="cm-muted cm-micro">
            <strong>No se puede estrenar sin simular antes.</strong> El botón de estrenar
            aparece cuando ya viste a quién le cambia el depósito y en cuánto.
          </p>
        }

        @if (tabErr(); as e) {
          <p class="cm-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ e }}</p>
        }
      } @else {

      @if (destacada(); as d) {
        <section class="cm-answer" [class.abierta]="d.estado_calculo === 'en_curso'">
          <div class="cm-answer-que">
            <!-- ⛔ Miraba status, que viene NULL cuando el periodo no tiene corrida, asi que
                 la quincena ABIERTA se anunciaba como "Lo que toca pagar". El estado del
                 periodo lo dice estado_calculo, que para eso distingue los cuatro casos.
                 (sin acentos graves: esto vive dentro de un template literal de JS) -->
            <p class="cm-eyebrow">{{ d.estado_calculo === 'en_curso' ? 'Quincena en curso' : 'Lo que toca pagar' }}</p>
            <p class="cm-answer-q">
              Quincena {{ d.period_no }} <span class="cm-muted">· {{ rango(d) }}</span>
            </p>
            <p class="cm-answer-pie">
              <!-- [RD.92] Una fecha de pago que ya paso no se anuncia en futuro: Q21 decia
                   "Se paga el 24 oct" el 28, todavia en borrador. -->
              @if (d.pay_date && pagoVencido(d)) {
                <strong class="cm-neg">Debió pagarse el <span class="cm-mono">{{ dia(d.pay_date) }}</span></strong>
                y sigue {{ etiquetaEstado(d) }} ·
              } @else if (d.pay_date) { Se paga el <span class="cm-mono">{{ dia(d.pay_date) }}</span> · }
              <!-- Sin corrida no hay nada "calculado": decia "calculada sin fecha", que afirma
                   un calculo que no ocurrio. Los cuatro estados ya distinguen el caso. -->
              @if (d.run_id) {
                calculada {{ cuando(d.updated_at) }}
                @if (d.origen) { <span class="cm-muted">· {{ etiquetaOrigen(d.origen) }}</span> }
              } @else if (d.estado_calculo === 'en_curso') {
                @if (proyectando()) {
                  calculando cómo va…
                } @else if (proyeccionFallo()) {
                  <span class="cm-neg">no se pudo proyectar</span> · el periodo sigue abierto
                } @else if (esProyeccion()) {
                  <strong>acumulado</strong> de lo que va corrido · no es una corrida: cambia cada día
                } @else {
                  todavía corre
                }
              } @else {
                <span class="cm-neg">sin calcular</span>
              }
            </p>
          </div>
          <div>
            <!-- [RD.92] Las cifras salen de cifrasDestacada(): en la quincena en curso son las de
                 la proyeccion, que la fila del tablero no trae. Y un neto sin deduccion cargada
                 se DECLARA: antes se leia "deducciones $0.00" como si alguien la hubiera puesto. -->
            @if (cifrasDestacada(); as c) {
              <p class="cm-eyebrow">{{ d.estado_calculo === 'en_curso' ? 'Neto acumulado' : 'Neto a pagar' }}</p>
              <p class="cm-answer-monto">{{ money(c.neto) }}</p>
              <p class="cm-answer-pie">
                tras nómina {{ money(c.tras) }}
                @if (c.neto == null && c.tras != null) {
                  · <span class="cm-neg">neto sin medir: falta la deducción del supervisor</span>
                } @else {
                  − deducciones {{ money(c.ded) }}
                }
              </p>
            }
          </div>
          <p-tag [severity]="sev(d)" [value]="etiquetaEstado(d)" />
        </section>
      }

      @if (err()) { <p class="cm-err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ err() }}</p> }

      <!-- [AUD-A3] LA TIRA DEL ANO, que reemplaza al riel de 240-300 px de ancho.
           Medido en prod el 2026-10-20: el riel mostraba 599 px de 1,757 -- el 34% -- y la
           pantalla NUNCA decia cuantas quincenas habia, asi que nadie sabia que le faltaban 23.
           Y los 240 px que se llevaba eran justo los que le faltaban a la tabla densa para
           caber a 1366: "Nomina" quedaba cortada contra el borde.
           La tira muestra las 27 de un golpe en 53 px de alto. El monto va como ALTURA DE
           BARRA y no como texto: el numero exacto vive en el detalle, y lo que una tira tiene
           que dar es el patron del ano. Con texto medimos 77 px y seguia scrolleando. -->
      <div class="cm-tira" role="radiogroup" aria-label="Quincena">
        <app-load-state
          [loading]="cargando()" [isEmpty]="!board().length" [skeletonRows]="1"
          emptyIcon="pi-calendar" emptyTitle="Sin quincenas"
          [emptyHint]="'El calendario de ' + anio() + ' no tiene periodos cargados.'">
          <div class="cm-tira-celdas">
            @for (p of board(); track p.period_id) {
              <button type="button" role="radio" class="cm-q"
                      [class.sel]="sel()?.period_id === p.period_id"
                      [class.hoy]="esHoy(p)" [class.fut]="esFutura(p)"
                      [attr.aria-checked]="sel()?.period_id === p.period_id"
                      [attr.tabindex]="sel()?.period_id === p.period_id ? 0 : -1"
                      [title]="tituloQuincena(p)" (click)="elegir(p)">
                <span class="cm-q-n">Q{{ p.period_no }}</span>
                <!-- La barra es decoracion del dato, no el dato: el lector de pantalla recibe
                     el monto por el title de arriba, que es texto de verdad. -->
                <span class="cm-q-bar" aria-hidden="true"
                      [style.height.px]="alturaBarra().get(p.period_id) ?? 1"></span>
              </button>
            }
          </div>
          <p class="cm-tira-pie">
            {{ board().length }} quincenas ·
            <b>{{ pagadas() }} pagadas</b> ·
            {{ futuras().length }} por venir
            @if (sinCalcular().length) { · <b class="cm-neg">{{ sinCalcular().length }} cerradas sin calcular</b> }
          </p>
        </app-load-state>
      </div>

      <div class="cm-split">
        <section class="cm-detail">
          @if (!sel()) {
            <p class="cm-empty">Elige una quincena.</p>
          } @else if (run(); as r) {
            <!-- [RD.97] En lo acumulado de una quincena en curso, «no cerró» y «el dato no llegó
                 completo» no son problemas: son lo que significa «en curso». Pintarlos en rojo
                 como «No se puede aprobar» gritaba por el estado normal. Sólo queda lo que
                 IMPEDIRÍA aprobarla al cerrar. -->
            @if (bloqueantesVisibles(r).length) {
              <div class="cm-gate bad">
                <strong><i class="pi pi-ban" aria-hidden="true"></i>
                  {{ esProyeccion() ? 'Al cerrar, esto impediría aprobarla' : 'No se puede aprobar' }}</strong>
                <ul>@for (g of bloqueantesVisibles(r); track g.gate) { <li><b>{{ etiquetaGate(g.gate) }}</b>: {{ g.detalle }}</li> }</ul>
              </div>
            }
            @if (avisos(r).length) {
              <div class="cm-gate warn">
                <strong><i class="pi pi-exclamation-circle" aria-hidden="true"></i> Pasa, con reservas</strong>
                <ul>@for (g of avisos(r); track g.gate) { <li><b>{{ etiquetaGate(g.gate) }}</b>: {{ g.detalle }}</li> }</ul>
              </div>
            }

            @if (esProyeccion()) {
              <!-- [RD.65] El motor corrio sobre un periodo ABIERTO. La cifra es buena pero no
                   es definitiva, y la pantalla lo dice ANTES de los numeros, no al pie.
                   [RD.97] Decia «Proyeccion» y no lo es: es lo ACUMULADO, sin extrapolar. Con un
                   tabulador escalonado eso importa: a media quincena casi toda ruta sigue bajo el
                   primer escalon y sale en $0, y leido como proyeccion dice «nadie va a cobrar». -->
              <p class="cm-proy">
                <i class="pi pi-hourglass" aria-hidden="true"></i>
                <span>
                  <strong>Lo acumulado de la quincena en curso</strong>, con el dato hasta el
                  {{ r.data_as_of ? dia(r.data_as_of) : '(sin medir)' }} — no es una proyección.
                  El tabulador es escalonado: a media quincena casi toda ruta sigue debajo del
                  primer escalón y sale en $0. Eso dice dónde va, no cuánto va a cobrar.
                  Al cerrar, se calcula una sola vez como corrida.
                </span>
              </p>
            }
            <app-metric-strip [items]="kpis(r)" ariaLabel="Totales de la quincena" />

            <!-- [AUD-CM.10] «corrida hace N · origen» ya lo dice la tarjeta de arriba cuando es la misma quincena. -->
            <p class="cm-proc">
              dato hasta <b>{{ r.data_as_of ? dia(r.data_as_of) : 'sin medir' }}</b>
              @if (esProyeccion()) {
                · calculado {{ cuando(r.updated_at) }} · no es una corrida
              } @else if (!netoYaArriba()) {
                · corrida {{ cuando(r.updated_at) }}
                @if (r.origen) { · origen {{ etiquetaOrigen(r.origen) }} }
              }
            </p>

            <!-- [RD.83] El ciclo deja de ser un dibujo. Los cuatro pasos estaban pintados como
                 una lista explicativa y sólo el primero tenía botón: la pantalla CONTABA el
                 trámite en vez de hacerlo. Medido contra prod el 2026-10-20: de 20 corridas,
                 **0 tienen approved_at** — el paso de aprobar no se ha ejercido NUNCA, porque no
                 había dónde apretarlo.

                 ⛔ El acto se ofrece sólo cuando la máquina de estados del servidor lo permite
                 (setStatus ya lo valida), y 'Aprobar' desaparece si hay compuertas que
                 bloquean: una compuerta que se puede saltar es decorativa. -->
            @if (!esProyeccion()) {
              <section class="cm-actos" aria-label="Qué sigue con esta corrida">
                <div class="cm-actos-txt">
                  <p class="cm-eyebrow">{{ tituloActo(r) }}</p>
                  <p class="cm-actos-dice">{{ explicaActo(r) }}</p>
                  @if (selloAprobacion(r); as s) { <p class="cm-micro cm-muted">{{ s }}</p> }
                </div>
                <!-- [RD.101] (D6) Tres llaves: calcula Comercial, aprueba Dirección, paga Finanzas.
                     Cada botón se ofrece a quien tiene SU llave; el servidor vuelve a decidir. -->
                @if (actoPropio(r) || sePuedeAnularYo(r)) {
                  <div class="cm-actos-btns">
                    @if (actoPropio(r) === 'approve') {
                      <button type="button" class="cm-btn" [disabled]="actuando()"
                              (click)="confirmarActo(r, 'approve')">
                        {{ actuando() ? 'Aprobando…' : 'Aprobar' }}
                      </button>
                    }
                    @if (actoPropio(r) === 'pay') {
                      <button type="button" class="cm-btn" [disabled]="actuando()"
                              (click)="confirmarActo(r, 'pay')">
                        {{ actuando() ? 'Marcando…' : 'Marcar pagada' }}
                      </button>
                    }
                    @if (sePuedeAnularYo(r)) {
                      <button type="button" class="cm-btn cm-btn--ghost" [disabled]="actuando()"
                              (click)="confirmarActo(r, 'void')">Anular</button>
                    }
                  </div>
                }
                @if (porQueNoActuo(r); as motivo) {
                  <p class="cm-micro cm-muted">{{ motivo }}</p>
                }
              </section>
            }

            @if (faltoDelPeriodo().length) {
              <section class="cm-falto">
                <div class="cm-falto-tit">
                  <p class="cm-eyebrow">Lo que faltó</p>
                  @if (acantilado(); as a) {
                    <p class="cm-falto-grito">
                      <strong>{{ a.beneficiario_nombre || ('Ruta ' + a.route_code) }}</strong>
                      vendió <span class="cm-mono">{{ money(a.venta) }}</span> —
                      le faltaron <strong class="cm-neg cm-mono">{{ money(a.escalon_falta) }}</strong>
                      y cobró <strong class="cm-neg">$0</strong> en vez de
                      <span class="cm-mono">{{ money(a.escalon_ganancia) }}</span>.
                    </p>
                  } @else {
                    <!-- [AUD-CM.10] El total abre su desglose: era una caja y, aparte, una pestaña con lo mismo. -->
                    <p class="cm-falto-grito">
                      <button type="button" class="cm-link" (click)="tab.set('falto')">
                        <strong>{{ faltoDelPeriodo().length }}</strong> ruta(s) con margen para subir de escalón
                      </button>
                    </p>
                  }
                  <p class="cm-muted cm-micro">
                    El tabulador es <strong>escalonado</strong>: quedarse corto no paga «un poco
                    menos», paga el escalón de abajo o <strong>cero</strong>.
                    @if (enElTopeDelPeriodo()) {
                      · {{ enElTopeDelPeriodo() }} ruta(s) ya están en el tope — ahí no hay nada que perseguir.
                    }
                  </p>
                </div>
                @if (oportunidadDelPeriodo()) {
                  <div class="cm-falto-monto">
                    <p class="cm-eyebrow">Estuvo al alcance</p>
                    <p class="cm-answer-monto">{{ money(oportunidadDelPeriodo()) }}</p>
                    <p class="cm-answer-pie">con menos de $5,000 más de venta</p>
                  </div>
                }
              </section>
            }

            <app-segmented [options]="pestanas()" [value]="tab()" (valueChange)="tab.set($event)"
                           ariaLabel="Qué se está viendo" />

            @if (tab() === 'falto') {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky">
                  <thead><tr>
                    <th>Ruta</th><th>Chofer</th>
                    <th class="comm-num">Vendió</th><th class="comm-num">%</th>
                    <th class="comm-num">Siguiente escalón</th><th class="comm-num">Le faltó</th>
                    <th class="comm-num">Habría ganado</th>
                    <th>Bono al alcance</th><th></th>
                  </tr></thead>
                  <tbody>
                    @for (f of faltoDelPeriodo(); track f.route_code) {
                      <tr [class.cm-fila-grito]="f.cercania === 'sin_cobrar_por_poco'">
                        <td class="comm-num">{{ f.route_code }}</td>
                        <td class="cm-name">{{ f.beneficiario_nombre || '—' }}</td>
                        <td class="comm-num cm-mono">{{ money(f.venta) }}</td>
                        <td class="comm-num">{{ f.pct_aplicado != null ? (pct(f.pct_aplicado) + '%') : '—' }}</td>
                        <td class="comm-num cm-muted">
                          {{ money(f.escalon_umbral) }}
                          @if (f.escalon_pct != null) { <span class="cm-micro">· {{ pct(f.escalon_pct) }}%</span> }
                        </td>
                        <td class="comm-num is-strong cm-neg">{{ money(f.escalon_falta) }}</td>
                        <td class="comm-num is-strong">{{ money(f.escalon_ganancia) }}</td>
                        <td class="cm-micro cm-muted">
                          @if (f.bono_nombre) {
                            {{ f.bono_nombre }} {{ money(f.bono_monto) }}
                            <span class="cm-neg">(faltan {{ money(f.bono_falta) }})</span>
                          } @else { — }
                        </td>
                        <td><p-tag [severity]="sevCercania(f.cercania)" [value]="etiquetaCercania(f.cercania)" /></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="cm-warn">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>
                  <strong>«Habría ganado» mantiene el subtotal fijo</strong> y sólo mueve el
                  porcentaje: es el <em>piso</em> de lo que se habría ganado, no una proyección —
                  vender más también subiría el subtotal. Se queda corto a propósito: una pantalla
                  que promete de más sobre el sueldo de alguien se deja de leer a la segunda vez.
                </span>
              </p>
            } @else if (tab() === 'contraste') {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky">
                  <thead><tr>
                    <th>Ruta</th><th>Chofer</th>
                    <th class="comm-num">Venta libro</th><th class="comm-num">Venta motor</th>
                    <th class="comm-num">Días</th>
                    <th class="comm-num">Pagó el libro</th><th class="comm-num">Pagaría el motor</th>
                    <th class="comm-num">Δ</th><th>Veredicto</th>
                  </tr></thead>
                  <tbody>
                    @for (c of contrasteDelPeriodo(); track c.route_code) {
                      <tr>
                        <td class="comm-num">{{ c.route_code }}</td>
                        <td class="cm-name">{{ c.beneficiario_nombre || '—' }}</td>
                        <td class="comm-num cm-muted">{{ money(c.libro_venta) }}</td>
                        <td class="comm-num cm-muted">{{ money(c.motor_venta) }}</td>
                        <td class="comm-num" [class.cm-corta]="c.dias_esperados !== null && c.dias_con_venta !== null && c.dias_con_venta < c.dias_esperados">
                          {{ c.dias_con_venta !== null ? (c.dias_con_venta + ' / ' + (c.dias_esperados ?? '?')) : '—' }}
                        </td>
                        <td class="comm-num">{{ money(c.libro_a_pagar) }}</td>
                        <td class="comm-num">{{ money(c.motor_a_pagar) }}</td>
                        <td class="comm-num is-strong" [class.cm-neg]="(c.delta_a_pagar ?? 0) < 0">
                          {{ c.delta_a_pagar !== null ? money(c.delta_a_pagar) : '—' }}
                        </td>
                        <td class="cm-nota">
                          <p-tag [severity]="sevContraste(c.veredicto)" [value]="etiquetaVeredictoContraste(c.veredicto)" />
                          @if (c.causa && c.causa !== 'sin_explicar') {
                            <span class="cm-muted cm-micro"> · {{ etiquetaCausa(c.causa) }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="cm-warn">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>
                  <strong>Esto no es nómina: es una simulación.</strong> El motor corre en modo vista
                  previa sobre la misma quincena y no deja corrida. Lo que se pagó es la pestaña
                  <em>Choferes</em>; esto dice qué habría pasado si hubiera pagado el motor.
                  <strong>El veredicto lo emite el servidor</strong>, no esta pantalla.
                </span>
              </p>
            } @else if (tab() === 'supervisor') {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky">
                  <thead><tr>
                    <th>Supervisor</th><th>Zona</th><th>Rutas</th>
                    <th class="comm-num">Comisión</th><th class="comm-num">Bonos</th><th class="comm-num">Tras nómina</th>
                  </tr></thead>
                  <tbody>
                    @for (s of supervisores(); track s.clave) {
                      <tr>
                        <td class="cm-name">{{ s.nombre }}</td>
                        <td class="cm-muted">{{ s.zona || '—' }}</td>
                        <td class="cm-mono cm-micro">{{ s.rutas.join(' · ') }}</td>
                        <td class="comm-num">{{ money(s.comision) }}</td>
                        <td class="comm-num">{{ s.bonos ? money(s.bonos) : '—' }}</td>
                        <td class="comm-num is-strong">{{ money(s.trasNomina) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <!-- [AUD-A] El span NO es decorativo. La clase cm-warn es display:flex en fila con
                   flex-wrap:nowrap, asi que CADA nodo de texto y CADA strong o em suelto se
                   vuelve un item flex propio. Sin el span, esta nota se pintaba como CINCO
                   columnas con la frase entrelazada entre ellas, ilegible. Medido en prod el
                   2026-10-20: los hijos quedaban en x=577 (persona) y x=909 (contribucion)
                   sobre un ancho de 926 px. Las otras cuatro notas de esta pantalla si traian
                   su span; esta era la unica sin el, y por eso era la unica rota. -->
              <p class="cm-warn">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>
                  La deducción del supervisor es por <strong>persona</strong> y agregada sobre sus rutas, no por
                  ruta: por eso estas filas traen lo suyo <em>tras nómina</em> y el neto del periodo ya la resta
                  arriba. El total descontado de la quincena es {{ money(run()?.total_deduccion) }}.
                </span>
              </p>
            } @else if (tab() === 'fuera') {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky">
                  <thead><tr><th>Ruta</th><th>Por qué no comisiona</th><th class="comm-num">Subtotal</th></tr></thead>
                  <tbody>
                    @for (l of fuera(); track l.route_code) {
                      <tr>
                        <td class="comm-num">{{ l.route_code }}</td>
                        <td><p-tag severity="secondary" [value]="etiquetaVeredicto(l.motivo_no_pago)" /></td>
                        <td class="comm-num">{{ l.subtotal != null ? money(l.subtotal) : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="cm-warn">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Estas rutas <strong>venden y no pagan comisión de Ruta Directa</strong>. Salen con su motivo
                para que la ausencia sea una decisión y no un descuido.
              </p>
            } @else {
              @if (costoComun(); as cc) {
                @if (cc !== 'dos_fuentes') {
                  <p class="cm-muted cm-micro cm-comun">
                    Las {{ choferes().length }} rutas: <strong>{{ etiquetaCosto(cc) }}</strong> — {{ tipCosto(cc) }}
                  </p>
                }
              }
              <div class="cm-table-wrap dt-scope">
                <!--
                  [RD.UI.2] DESIGN O.4 -- la nomina de la quincena: 12 columnas por ruta. Era
                  una <table> cruda, asi que el sticky y la columna congelada ya los daba el
                  CSS de surf-table, pero el TECLADO no: sin p-table no hay pSelectableRow, y
                  esta es justo la tabla que alguien recorre renglon por renglon para verificar
                  a quien se le paga. Ahora da flechas, Home/End y roving tabindex.
                  min-width declarado: la compuerta de tablas densas la tenia marcada como la
                  peor del repo (12 columnas sin decir que hace en un telefono).
                -->
                <p-table [value]="choferes()" dataKey="route_code" size="small" [rowHover]="true"
                         selectionMode="single" [(selection)]="filaSel"
                         class="dt-stack surf-table surf-table--plain surf-table--sticky surf-table--frozen-first"
                         [tableStyle]="{ 'min-width': '78rem' }">
                  <ng-template #header>
                    <tr>
                      <th scope="col">Ruta</th><th scope="col">Chofer</th><th scope="col" class="comm-num">Días</th>
                      <th scope="col" class="comm-num">Subtotal</th><th scope="col" class="comm-num">Venta</th><th scope="col" class="comm-num">%</th>
                      <th scope="col" class="comm-num">Markup</th><th scope="col" class="comm-num">Comisión</th><th scope="col" class="comm-num">Bonos</th>
                      <th scope="col" class="comm-num">Nómina</th><th scope="col" class="comm-num">A pagar</th><th scope="col">Procedencia</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-l>
                    <tr [pSelectableRow]="l" [class.muted]="!!l.motivo_no_pago">
                      <td role="cell" data-label="Ruta" class="comm-num">{{ l.route_code }}</td>
                      <td role="cell" data-label="Chofer" class="cm-name">{{ l.beneficiario_nombre || '—' }}</td>
                      <td role="cell" data-label="Días" class="comm-num" [class.cm-corta]="diasCortos(l)" [title]="tipDias(l)">
                        {{ l.dias_con_venta != null ? (l.dias_con_venta + ' / ' + (l.dias_esperados ?? '?')) : '—' }}
                      </td>
                      <td role="cell" data-label="Subtotal" class="comm-num">{{ l.subtotal != null ? money(l.subtotal) : '—' }}</td>
                      <td role="cell" data-label="Venta" class="comm-num cm-muted">{{ l.venta != null ? money(l.venta) : '—' }}</td>
                      <td role="cell" data-label="%" class="comm-num">{{ l.pct_aplicado != null ? (pct(l.pct_aplicado) + '%') : '—' }}</td>
                      <td role="cell" data-label="Markup" class="comm-num cm-muted" [title]="tipMarkup(l)">
                        {{ l.markup_sobre_costo_pct != null ? (pct(l.markup_sobre_costo_pct) + '%') : '—' }}
                      </td>
                      <td role="cell" data-label="Comisión" class="comm-num">{{ money(l.comision) }}</td>
                      <td role="cell" data-label="Bonos" class="comm-num" [title]="bonosTip(l)">{{ l.bonos ? money(l.bonos) : '—' }}</td>
                      <!-- [AUD-CM.11] La nómina es un descuento normal, no un error: sin rojo. -->
                      <td role="cell" data-label="Nómina" class="comm-num cm-muted">{{ l.nomina_banco ? ('−' + money(l.nomina_banco)) : '—' }}</td>
                      <td role="cell" data-label="A pagar" class="comm-num is-strong">{{ l.motivo_no_pago ? '—' : money(l.a_pagar) }}</td>
                      <td role="cell" data-label="Procedencia" class="cm-nota">
                        @if (l.motivo_no_pago) { <p-tag severity="warn" [value]="etiquetaVeredicto(l.motivo_no_pago)" /> }
                        @if (l.dias_multifuente) {
                          <!-- [AUD.1] El span existia SOLO para colgar un title con la
                               definicion de «corte». Esa definicion ya vive en el diccionario
                               (topico comisiones-rd), que si se alcanza sin mouse. -->
                          <p-tag severity="secondary" value="corte" />
                        }
                        @if (l.costo_veredicto && l.costo_veredicto !== 'dos_fuentes' && l.costo_veredicto !== costoComun()) {
                          <span [title]="tipCosto(l.costo_veredicto)">
                            <p-tag [severity]="l.costo_veredicto === 'sin_costo' ? 'warn' : 'secondary'"
                                   [value]="etiquetaCosto(l.costo_veredicto)" />
                          </span>
                        }
                      </td>
                    </tr>
                  </ng-template>
                  <ng-template #footer>
                    <tr>
                      <td colspan="3">{{ pagan() }} de {{ choferes().length }} pagan</td>
                      <td class="comm-num">{{ money(sumCh('subtotal')) }}</td>
                      <td class="comm-num">{{ money(sumCh('venta')) }}</td>
                      <td></td><td></td>
                      <td class="comm-num">{{ money(sumCh('comision')) }}</td>
                      <td class="comm-num">{{ money(sumCh('bonos')) }}</td>
                      <td class="comm-num cm-muted">−{{ money(sumCh('nomina_banco')) }}</td>
                      <td class="comm-num is-strong">{{ money(sumCh('a_pagar')) }}</td>
                      <td></td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            }
          } @else if (!sel()!.run_id) {
            <div class="cm-card">
              <h2>Quincena {{ sel()!.period_no }} · {{ rango(sel()!) }}</h2>
              <p class="cm-muted cm-card-pie">
                @switch (sel()!.estado_calculo) {
                  @case ('futura') { Empieza el {{ dia(sel()!.date_from) }}: todavía no existe. }
                  @case ('en_curso') {
                    <!-- [RD.92] Esta tarjeta solo se ve mientras la proyeccion no llega o si
                         fallo: cuando llega, la pinta la rama de arriba (run()). Antes esta rama
                         iba PRIMERO y la proyeccion se pedia y nunca se dibujaba. -->
                    Está corriendo: cierra el {{ dia(sel()!.date_to) }}.
                    @if (proyectando()) {
                      Calculando cómo va…
                    } @else if (proyeccionFallo()) {
                      <span class="cm-neg">No se pudo proyectar lo que va vendido.</span>
                    }
                    No se guarda como corrida hasta que cierre — una quincena a medias no se paga.
                  }
                  @default {
                    Cerró el {{ dia(sel()!.date_to) }} y <strong>todavía no se ha calculado</strong>.
                  }
                }
              </p>

              <ol class="cm-ciclo">
                <li [class.act]="sel()!.estado_calculo === 'sin_calcular'">
                  <span class="cm-paso">1</span> Calcular
                  <span>Se hace una vez, con el periodo ya cerrado. Nace en borrador.</span>
                </li>
                <li>
                  <span class="cm-paso">2</span> Revisar
                  <span>Compuertas, cobertura y la procedencia de cada cifra.</span>
                </li>
                <li>
                  <span class="cm-paso">3</span> Aprobar
                  <span>Lo hace una persona. El motor nunca aprueba solo.</span>
                </li>
                <li>
                  <span class="cm-paso">4</span> Pagar
                  <span>Se marca pagada y queda congelada: lo pagado no se recalcula.</span>
                </li>
              </ol>

              @if (sinCalcular().length) {
                <p class="cm-warn bad">
                  <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                  <span>
                    <strong>
                      {{ sinCalcular().length === 1 ? 'Una quincena ya cerró' : sinCalcular().length + ' quincenas ya cerraron' }}
                      y no {{ sinCalcular().length === 1 ? 'tiene' : 'tienen' }} número:
                    </strong>
                    {{ listaSinCalcular() }}.
                    Se producen recalculando desde la primera — el mismo trámite que cuando
                    cambia el tabulador. No hay nada que esperar: no corre solo a propósito.
                  </span>
                </p>

                @if (puedeGestionar()) {
                  <div class="cm-tramite">
                    <p class="cm-tramite-txt">
                      Calcular desde <strong>Q{{ sinCalcular()[0].period_no }}</strong> produce ésa y
                      las {{ sinCalcular().length - 1 }} que le siguen.
                      <span class="cm-muted">
                        Nace en borrador: no aprueba ni paga. Lo ya pagado se salta.
                      </span>
                    </p>
                    <button type="button" class="cm-btn" [disabled]="recalculando()"
                            (click)="recalcularDesde(sinCalcular()[0].period_id)">
                      {{ recalculando() ? 'Calculando…' : 'Calcular desde Q' + sinCalcular()[0].period_no }}
                    </button>
                  </div>
                  @if (recalculando()) {
                    <p class="cm-muted cm-micro">
                      Cada quincena cuesta unos segundos — se leen tres fuentes de venta día por día.
                    </p>
                  }
                  @if (recalc(); as rr) {
                    <div class="cm-recalc">
                      <p><strong>{{ rr.calculadas.length }}</strong> calculada(s)
                        @if (rr.saltadas.length) { · <strong>{{ rr.saltadas.length }}</strong> saltada(s) }
                        @if (rr.fallas.length) { · <strong class="cm-neg">{{ rr.fallas.length }}</strong> con falla }
                      </p>
                      @for (s of rr.saltadas; track s.period_no) {
                        <p class="cm-micro cm-muted">Q{{ s.period_no }} no se tocó — {{ s.motivo }}</p>
                      }
                      @for (f of rr.fallas; track f) {
                        <p class="cm-micro cm-neg">{{ f }}</p>
                      }
                    </div>
                  }
                }
              }
            </div>
          } @else {
            <p class="cm-empty">Cargando la corrida…</p>
          }
        </section>
      </div>
      <!-- [AUD-CM.10] El libro contra el motor es una simulación del AÑO, no el trámite de esta quincena:
           va al final. Arriba competía con «Aprobar» (dos botones naranjas a la vez) y repetía la pestaña
           «Libro vs motor». -->
      @if (resumenContraste().length) {
        <section class="cm-contraste">
          <div class="cm-contraste-tit">
            <p class="cm-eyebrow">El libro contra el motor · {{ anio() }}</p>
            <p class="cm-muted cm-micro">
              Lo que se pagó, contra lo que el motor pagaría hoy. Es una simulación: no es nómina.
            </p>
          </div>
          <div class="cm-contraste-chips">
            @for (r of resumenContraste(); track r.veredicto) {
              <span class="cm-chip" [attr.data-sev]="sevContraste(r.veredicto)"
                    [title]="'libro ' + money(r.libro) + ' · motor ' + money(r.motor)">
                <strong>{{ r.n }}</strong> {{ etiquetaVeredictoContraste(r.veredicto) }}
                @if (r.delta) { <span class="cm-mono">{{ money(r.delta) }}</span> }
              </span>
            }
          </div>
          @if (puedeGestionar()) {
            <button type="button" class="cm-btn cm-btn-sec" [disabled]="contrastando()"
                    (click)="correrContraste()">
              @if (contrasteAvance(); as a) {
                Contrastando Q{{ a.actual }} · {{ a.hechas }} de {{ a.total }}
              } @else {
                Volver a contrastar
              }
            </button>
          }
        </section>
        @if (contrastando()) {
          <p class="cm-muted cm-micro">
            El motor corre quincena por quincena y cada una cuesta unos segundos — lee tres fuentes
            de venta día por día. No deja corrida. Sólo las quincenas con libro: las demás no tienen
            con qué compararse.
          </p>
        }
        @if (contrasteFallas().length) {
          <p class="cm-micro" role="alert">
            No se pudieron contrastar {{ contrasteFallas().length }}:
            @for (f of contrasteFallas(); track f) { <span class="cm-mono">{{ f }}</span>@if (!$last) { · } }
          </p>
        }
      }

      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; }
    .cm-page { padding:1rem 1.1rem 2rem; }
    .cm-head { display:flex; align-items:flex-start; gap:1rem; margin-bottom:1rem; }
    .cm-head h1 { margin:0; font-size:var(--fs-h2); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-sub { margin:.15rem 0 0; font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-sub strong { color:var(--c-text-2); font-weight:var(--fw-medium); }
    .cm-year { margin-left:auto; display:inline-flex; gap:.4rem; align-items:center; font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-year select { padding:.3rem .45rem; border:1px solid var(--border-color); border-radius:var(--r-sm,6px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }

    .cm-answer { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem 1.4rem; margin-bottom:.6rem;
      padding:.5rem .8rem; border:1px solid var(--border-color); border-left:3px solid var(--action);
      border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-answer.abierta { border-left-color:var(--c-text-3); }
    .cm-answer-que { flex:1 1 16rem; min-width:0; }
    .cm-eyebrow { margin:0; font-size:var(--fs-micro); letter-spacing:.07em; text-transform:uppercase; color:var(--c-text-2); }
    .cm-answer-q { margin:.2rem 0 0; font-size:var(--fs-h3); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-answer-pie { margin:.1rem 0 0; font-size:var(--fs-micro); color:var(--c-text-2); }
    .cm-answer-monto { margin:.1rem 0 0; font-family:var(--font-mono,'Geist Mono',monospace);
      font-size:1.5rem; font-weight:var(--fw-bold); font-variant-numeric:tabular-nums; color:var(--c-text-1); }

    /* RD.52 - la tira del contraste. Sin color como unica senal: cada chip lleva su numero. */
    .cm-contraste { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem 1rem; margin-bottom:1rem;
      padding:.7rem .9rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-contraste-tit { flex:1 1 15rem; min-width:0; }
    .cm-contraste-chips { display:flex; flex-wrap:wrap; gap:.35rem; }
    .cm-chip { display:inline-flex; align-items:baseline; gap:.3rem; padding:.2rem .5rem;
      border:1px solid var(--border-color); border-radius:999px; font-size:var(--fs-micro); color:var(--c-text-2); }
    .cm-chip strong { color:var(--c-text-1); font-family:var(--font-mono,'Geist Mono',monospace); }
    /* Los tokens REALES son --c-bad / --c-warn / --c-ok. Escribi --c-negative/warning/positive,
       que no existen, y el respaldo en hex los habria tapado en silencio: la compuerta de
       tokens no los vio porque se acota al diff YA commiteado. Sin respaldo a proposito. */
    .cm-chip[data-sev="danger"] { border-color:color-mix(in srgb, var(--c-bad) 45%, transparent); }
    .cm-chip[data-sev="warn"] { border-color:color-mix(in srgb, var(--c-warn) 45%, transparent); }
    .cm-chip[data-sev="success"] { border-color:color-mix(in srgb, var(--c-ok) 40%, transparent); }
    /* [AUD-CM.14] El secundario trae su propia forma: «+ Escalón» y «Descartar cambios» lo usaban sin la base
       cm-btn y se pintaban como texto suelto de 16 px. Y con cm-btn, «Volver a contrastar» salía naranja. */
    .cm-btn-sec { background:transparent; color:var(--c-text-1); border:1px solid var(--border-color);
      border-radius:var(--r-sm,6px); padding:.4rem .9rem; font-size:var(--fs-sm); font-weight:var(--fw-medium);
      cursor:pointer; white-space:nowrap; }
    .cm-btn-sec:disabled { opacity:.55; cursor:default; }
    .cm-aviso-txt { color:var(--warn-soft-fg); }
    .cm-sec-t { margin:0 0 .3rem; }
    .cm-comun { margin:0 0 .4rem; }
    .cm-link { all:unset; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
    .cm-link:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm,6px); }
    /* [AUD-CM.14] Un solo estilo de encabezado en las tablas de la pantalla (eran cuatro), y datos a 13 px. */
    :host ::ng-deep .cm-table-wrap .p-datatable-thead > tr > th { font-size:var(--fs-micro); font-weight:600;
      text-transform:uppercase; letter-spacing:.04em; color:var(--c-text-2); }
    :host ::ng-deep .cm-table-wrap .p-datatable-tbody > tr > td,
    :host ::ng-deep .cm-table-wrap .p-datatable-tfoot > tr > td { font-size:var(--fs-sm); }
    :host ::ng-deep .cm-tier .p-inputnumber-input { width:9rem; text-align:right; font:inherit; font-size:var(--fs-sm); }
    :host ::ng-deep .cm-tier--pct .p-inputnumber-input { width:6.5rem; }

    /* RD.56 - "Lo que falto". Va ARRIBA de la tabla porque es la respuesta, no un anexo. */
    .cm-falto { display:flex; flex-wrap:wrap; align-items:center; gap:.4rem 1.2rem; margin:.6rem 0;
      padding:.5rem .8rem; border:1px solid var(--border-color); border-left:3px solid var(--c-warn);
      border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-falto-tit { flex:1 1 22rem; min-width:0; }
    /* El token --fs-base NO existe: los reales son --fs-body / --fs-sm / --fs-lg. Sin respaldo. */
    .cm-falto-grito { margin:.2rem 0 .15rem; font-size:var(--fs-body); color:var(--c-text-1); }
    .cm-falto-monto { text-align:right; }
    .cm-fila-grito td { background:color-mix(in srgb, var(--c-bad) 7%, transparent); }

    /* [AUD-A3] El split deja de ser riel + detalle. El detalle se queda con TODO el ancho,
       que es lo que hace que la tabla densa quepa a 1366 sin cortar "Nomina". */
    .cm-split { display:grid; grid-template-columns:1fr; gap:1rem; align-items:start; }

    /* La tira del ano: las 27 quincenas en 53 px de alto, sin scroll horizontal.
       El flex 1 1 0 con min-width 0 es lo que las hace repartirse el ancho en vez de
       desbordar: con un min-width fijo de 46 px medimos que 27 celdas NO entran en 1366.
       (sin acentos graves aca dentro: esto vive en un template literal de JS) */
    .cm-tira { margin:.6rem 0 .9rem; }
    .cm-tira-celdas { display:flex; gap:2px; }
    .cm-q { flex:1 1 0; min-width:0; height:34px; border:0; border-bottom:2px solid var(--border-color);
      background:transparent; padding:.1rem 0 .15rem; cursor:pointer; display:flex; flex-direction:column;
      align-items:center; justify-content:flex-end; gap:2px; font:inherit; color:var(--c-text-2); }
    .cm-q:hover { background:var(--overlay-hover, rgba(0,0,0,.04)); }
    .cm-q:focus-visible { outline:2px solid var(--focus-ring, var(--action)); outline-offset:-2px; border-radius:4px; }
    .cm-q-n { font-size:var(--fs-micro); font-weight:var(--fw-medium); line-height:1; }
    .cm-q-bar { display:block; width:60%; background:var(--c-text-3); border-radius:1px; }
    .cm-q.sel { border-bottom-color:var(--action); color:var(--c-text-1); }
    .cm-q.sel .cm-q-n { font-weight:var(--fw-bold); }
    .cm-q.sel .cm-q-bar { background:var(--action); }
    .cm-q.hoy { border-bottom-style:dashed; border-bottom-color:var(--action); }
    .cm-q.fut { opacity:.45; }
    .cm-q.fut .cm-q-bar { background:transparent; border-top:1px dashed var(--c-text-3); }
    .cm-tira-pie { margin:.3rem 0 0; font-size:var(--fs-micro); color:var(--c-text-2); }
    .cm-tira-pie b { color:var(--c-text-1); }
    /* En pantalla angosta las 27 no caben legibles: se deja scrollar en vez de aplastarlas. */
    @container (max-width:48rem) {
      .cm-tira-celdas { overflow-x:auto; }
      .cm-q { flex:0 0 34px; }
    }

    .cm-rail { display:flex; flex-direction:column; max-height:78vh; overflow-y:auto; }
    .cm-mes { margin:.9rem 0 .35rem; font-size:var(--fs-micro); letter-spacing:.07em; text-transform:uppercase;
      color:var(--c-text-2); font-weight:var(--fw-medium); }
    .cm-mes:first-child { margin-top:0; }
    .cm-colapso { border:1px dashed var(--border-color); border-radius:var(--r-md,8px); margin-bottom:.4rem; }
    .cm-colapso summary { padding:.5rem .7rem; font-size:var(--fs-sm); color:var(--c-text-2); cursor:pointer; }
    .cm-colapso p { margin:0; padding:0 .7rem .55rem; font-size:var(--fs-micro); color:var(--c-text-2); }
    .cm-per { display:flex; flex-direction:column; gap:.3rem; text-align:left; margin-bottom:.3rem;
      padding:.45rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px);
      background:var(--card-bg); font:inherit; cursor:pointer; }
    .cm-per:hover { background:var(--overlay-hover); }
    .cm-per.sel { border-color:var(--action); background:color-mix(in srgb, var(--action) 8%, transparent); }
    .cm-per-top { display:flex; align-items:baseline; gap:.45rem; }
    .cm-per-bot { display:flex; align-items:center; justify-content:space-between; gap:.4rem; }
    .cm-per-no { font-weight:var(--fw-bold); font-size:var(--fs-sm); color:var(--c-text-1); font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-per-fechas { font-size:var(--fs-micro); color:var(--c-text-2); }
    .cm-per-monto { font-size:var(--fs-micro); color:var(--c-text-2); font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }
    /* Marca la cifra que es BRUTO y no neto: el subrayado punteado la distingue sin color. */
    .cm-per-monto.cm-tras-nomina { text-decoration:underline dotted; text-underline-offset:3px; }

    .cm-per.hoy { border-color:color-mix(in srgb, var(--action) 45%, var(--border-color)); }
    .cm-hoy { margin-left:auto; font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase;
      color:var(--action); font-weight:var(--fw-bold); }
    .cm-futuras { margin:.7rem 0 0; padding:.5rem .6rem; border:1px dashed var(--border-color);
      border-radius:var(--r-md,8px); font-size:var(--fs-micro); color:var(--c-text-2); text-align:center; }

    .cm-detail { min-width:0; }
    .cm-card { border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); padding:1rem 1.1rem; }
    .cm-card h2 { margin:0 0 .3rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-card p { margin:0; font-size:var(--fs-sm); }
    .cm-card-pie { margin-bottom:1rem !important; }

    /* El ciclo: lo que va a pasar solo, para que el vacío explique en vez de quedarse callado. */
    .cm-ciclo { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; margin:0;
      padding:0; list-style:none; background:var(--border-color); border:1px solid var(--border-color);
      border-radius:var(--r-md,8px); overflow:hidden; }
    @container (max-width:46rem) { .cm-ciclo { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    .cm-ciclo li { display:flex; flex-direction:column; gap:.15rem; padding:.45rem .6rem;
      background:var(--card-bg); font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--c-text-2); }
    .cm-ciclo li.act { background:color-mix(in srgb, var(--action) 7%, var(--card-bg)); color:var(--action); }
    .cm-ciclo li span:last-child { font-size:var(--fs-micro); font-weight:400; color:var(--c-text-2); }
    .cm-paso { display:inline-flex; align-items:center; justify-content:center; width:1.15rem; height:1.15rem;
      border:1px solid currentColor; border-radius:50%; font-family:var(--font-mono,'Geist Mono',monospace);
      font-size:var(--fs-micro); }

    .cm-table-wrap { overflow-x:auto; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); margin-top:.6rem; }
    .cm-table-wrap tbody tr.muted td { color:var(--c-text-2); }
    .cm-neg { color:var(--bad-fg); }
    /* Ambar y no rojo a proposito: 8 de cada 22 marcadas son legitimas (el camion no salio). */
    .cm-corta { color:var(--warn-fg); font-weight:var(--fw-medium); }
    .cm-tramite { display:flex; gap:.9rem; align-items:center; justify-content:space-between;
      flex-wrap:wrap; margin-top:.8rem; padding:.7rem .9rem;
      border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-tramite-txt { margin:0; font-size:var(--fs-sm); }
    .cm-btn { border:1px solid var(--action); background:var(--action); color:#fff;
      border-radius:var(--r-sm,6px); padding:.4rem .9rem;
      font-size:var(--fs-sm); font-weight:var(--fw-medium); cursor:pointer; white-space:nowrap; }
    .cm-btn:disabled { opacity:.55; cursor:default; }
    .cm-btn.cm-btn-sec { background:transparent; color:var(--c-text-1); border-color:var(--border-color); }
    .cm-recalc { margin-top:.6rem; font-size:var(--fs-sm); }
    .cm-recalc p { margin:.15rem 0; }
    .cm-name { max-width:14rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cm-nota { display:flex; gap:.25rem; align-items:center; flex-wrap:wrap; }
    .cm-mono { font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-micro { font-size:var(--fs-micro); }

    .cm-gate { display:block; margin:0 0 .4rem; padding:.4rem .6rem; border-radius:var(--r-md,8px); font-size:var(--fs-sm); }
    .cm-gate strong { display:flex; gap:.4rem; align-items:center; }
    .cm-gate ul { margin:.35rem 0 0; padding-left:1.4rem; color:var(--c-text-2); }
    .cm-gate.bad { border:1px solid color-mix(in srgb, var(--bad-fg) 45%, transparent);
      background:color-mix(in srgb, var(--bad-fg) 9%, transparent); color:var(--bad-fg); }
    .cm-gate.warn { border:1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent);
      background:color-mix(in srgb, var(--warn-fg) 8%, transparent); color:var(--c-text-2); }

    /* [RD.65] El aviso de proyeccion: franja de atencion, no de error. Usa el token de aviso
       y nunca un hex -- la cifra de abajo es correcta, solo que no es definitiva. */
    .cm-proy { margin:0 0 6px; padding:5px 10px; display:flex; align-items:center; gap:8px;
      border-left:3px solid var(--c-warn); border-radius:var(--r-md,8px);
      background:var(--card-bg); color:var(--c-text-2); font-size:var(--fs-sm); }
    .cm-proc { margin:.5rem 0 .6rem; font-size:var(--fs-micro); color:var(--c-text-2); }
    .cm-warn.bad { border-color:color-mix(in srgb, var(--bad-fg) 45%, transparent);
      background:color-mix(in srgb, var(--bad-fg) 9%, transparent); }
    .cm-warn { display:flex; gap:.4rem; align-items:flex-start; margin:.7rem 0 0; padding:.5rem .65rem;
      border:1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent); border-radius:var(--r-md,8px);
      background:color-mix(in srgb, var(--warn-fg) 8%, transparent); font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-err { display:flex; gap:.4rem; align-items:center; color:var(--bad-fg); font-size:var(--fs-sm); margin:.4rem 0; }
    .cm-empty { color:var(--c-text-2); font-size:var(--fs-sm); }
    .cm-muted { color:var(--c-text-2); }
    /* [RD.83] la barra de actos: el trámite se ejecuta donde se lee el número, no en otra pantalla */
    .cm-actos { display:flex; gap:var(--sp-3,.75rem); align-items:center; justify-content:space-between;
      flex-wrap:wrap; margin:.7rem 0 0; padding:.6rem .75rem; border:1px solid var(--border-color);
      border-radius:var(--r-md,8px); background:var(--overlay-hover); }
    .cm-actos-txt { min-width:0; }
    .cm-actos-dice { margin:.15rem 0 0; font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-actos-btns { display:flex; gap:var(--sp-2,.5rem); flex-shrink:0; }
    .cm-btn--ghost { background:transparent; color:var(--c-text-2); border:1px solid var(--border-color); }
    /* [RD.84] el padron editable y su dialogo */
    .cm-padron { margin:1.1rem 0 0; }
    .cm-padron-tit { display:flex; gap:var(--sp-3,.75rem); align-items:flex-start;
      justify-content:space-between; flex-wrap:wrap; margin:0 0 .5rem; }
    /* Von Restorff: una baja NO se pinta como una fila normal, y NO depende solo del color --
       lleva tambien el texto "de baja" en su columna de vigencia (forced-colors). */
    .cm-fila-baja > td { color:var(--c-text-2); }
    .cm-btn-min { padding:.15rem .5rem; font-size:var(--fs-xs); border-radius:var(--r-sm,6px); }
    .cm-btn--baja { background:var(--bad-fg); border-color:var(--bad-fg); }
    .cm-form { display:flex; flex-direction:column; gap:.55rem; }
    /* Miller: >6 campos seguidos se parten con un titulo. El formulario tiene nueve. */
    .cm-form-sep { margin:.5rem 0 0; font-size:var(--fs-xs); font-weight:600;
      text-transform:uppercase; letter-spacing:.04em; color:var(--c-text-2); }
    .cm-campo { display:flex; flex-direction:column; gap:.2rem; font-size:var(--fs-sm); }
    .cm-campo > span { color:var(--c-text-1); }
    .cm-campo input, .cm-campo textarea, .cm-campo select { padding:.35rem .5rem; border:1px solid var(--border-color);
      border-radius:var(--r-sm,6px); background:var(--c-surface-0); color:var(--c-text-1);
      font:inherit; font-size:var(--fs-sm); }
    .cm-campo--check { flex-direction:row; align-items:center; gap:.4rem; }
    .cm-campo--check input { width:auto; }
    .cm-tier-in { width:7.5rem; padding:.2rem .4rem; text-align:right; font:inherit;
      font-size:var(--fs-sm); border:1px solid var(--border-color); border-radius:var(--r-sm,6px);
      background:var(--c-surface-0); color:var(--c-text-1); }
    .cm-tabul-pie { display:flex; gap:var(--sp-2,.5rem); align-items:flex-end; flex-wrap:wrap; margin:.7rem 0 0; }
    .cm-sim { margin:1.1rem 0 0; padding-top:.8rem; border-top:1px solid var(--border-color); }
    .cm-sim-grito { margin:.2rem 0 .1rem; font-size:var(--fs-body); color:var(--c-text-1); }
    .cm-form-pie { display:flex; gap:var(--sp-2,.5rem); justify-content:flex-end; margin-top:.8rem; }
  `],
})
export class ComercialComisionesComponent {
  private readonly api = inject(ComercialService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  /**
   * ⭐ El ÚNICO control de esta pantalla, y aparece sólo cuando hay un hueco que llenar.
   *
   * No contradice el "sin botones": lo que no debe depender de que alguien apriete algo es
   * **leer**, y leer sigue costando 2.7 ms sin tocar nada. Esto es el trámite manual que se
   * pidió explícitamente — producir el número de una quincena cerrada, y reconvertir desde el
   * periodo en que aplica una escala nueva. Es el mismo acto las dos veces.
   */
  readonly puedeGestionar = computed(() => this.perms.has(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR));
  readonly recalculando = signal(false);
  readonly recalc = signal<CommissionRecalcResult | null>(null);

  readonly anios = [2026, 2027];
  readonly anio = signal(new Date().getFullYear() >= 2027 ? 2027 : 2026);
  readonly board = signal<CommissionBoardRow[]>([]);
  /**
   * ⭐ Las quincenas que YA CERRARON y no tienen número, resueltas en el servidor con su
   * `current_date` — no con el reloj del navegador, que es de quien mira y no del negocio.
   * Es el único hueco que hay que ver al abrir: vacío significa que no falta nada.
   */
  readonly sinCalcular = signal<{ period_id: string; period_no: number; date_to: string }[]>([]);
  readonly sel = signal<CommissionBoardRow | null>(null);
  readonly run = signal<CommissionRunDetail | null>(null);
  /** `[RD.65]` La proyeccion esta en vuelo: su hueco muestra esqueleto, no un guion. */
  readonly proyectando = signal(false);
  /** `[RD.65]` La proyeccion fallo. Se DECLARA en su sitio; el resto de la pantalla sigue viva. */
  readonly proyeccionFallo = signal(false);
  /** `[RD.65]` Lo que se ve NO es una corrida: es el motor mirando un periodo que aun corre. */
  readonly esProyeccion = computed(() => !!this.run() && !this.sel()?.run_id);
  /**
   * `[RD.UI.2]` D.7 -- PrimeNG como DISPOSITIVO DE ENTRADA del teclado, no como dueno del
   * estado: la seleccion marca donde esta el cursor en la nomina. `pSelectableRow` la exige
   * para dar flechas, Home/End y roving tabindex.
   */
  filaSel: CommissionLine | null = null;
  /**
   * `[AUD-A6]` El eje del tiempo de la pantalla: la **quincena** o el **mes**.
   *
   * ⛔ No es una pestaña más de `tab()`. Aquellas son vistas de UNA quincena —cambiarlas no
   * cambia el periodo—, y el objetivo es **mensual**: colgarlo ahí haría que su contenido
   * cambiara al elegir otra quincena, que es afirmar algo falso.
   */
  /**
   * ⭐ Arranca en la vista por la que entraste: `/comercial/comisiones/objetivo` abre el bono,
   * y la ruta corta abre la nómina. Los favoritos y enlaces viejos siguen llevando a donde
   * llevaban, y no al inicio de otra cosa.
   */
  readonly vista = signal<Vista>(
    inject(Router).url.includes('/objetivo') ? 'objetivo' : 'quincena');
  /**
   * `[RD.92]` Las tres últimas no son de una quincena —el padrón, los bonos y el tabulador
   * cuelgan de su propia vigencia— y por eso viven acá y no en `pestanas()`. Allá dependían de
   * que la quincena elegida tuviera corrida: con Q22 a Q27 no se podían abrir.
   */
  readonly vistas = computed<SegOption[]>(() => {
    return [
      { label: 'Nómina quincenal', value: 'quincena' },
      { label: 'Bono por objetivo (mensual)', value: 'objetivo' },
      // Los hallazgos (cobra sin fuente, vende sin cobrar) y el padrón editable: las dos caras
      // de quién cobra. Siempre visible — con cero hallazgos el padrón se sigue editando aquí.
      // [AUD-CM.6] Cuenta a quién cobra (el padrón vigente), no los hallazgos: decía «· 9» y abría
      // con 8 rutas que NO cobran. Los hallazgos llevan su propio título dentro de la vista.
      { label: `Quién cobra · ${this.padronFilas().filter((p) => p.activo).length}`, value: 'padron' },
      { label: `Bonos · ${this.bonos().filter((b) => b.activo).length}`, value: 'bonos' },
      { label: 'Tabulador', value: 'tabulador' },
    ];
  });

  /** Estrecha el `string` del control segmentado a la unión del signal. Cualquier otro valor
   *  se ignora en vez de ensuciar el estado: el control sólo ofrece esas cinco. */
  verVista(v: string): void {
    if ((VISTAS as readonly string[]).includes(v)) this.vista.set(v as Vista);
  }

  readonly tab = signal<string>('chofer');
  /** La tira del sub-módulo: sin ella la pantalla es un callejón sin salida. */
  readonly tabsRD = RUTA_DIRECTA_TABS;
  readonly cargando = signal(false);
  readonly err = signal<string | null>(null);

  /** Hoy en texto `YYYY-MM-DD`, para comparar con las fechas del servidor SIN construir `Date`. */
  private readonly hoy = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  /** La quincena que corre hoy. Existe aunque nadie la haya calculado todavia. */
  readonly enCurso = computed<CommissionBoardRow | null>(() =>
    this.board().find((p) => p.date_from <= this.hoy && this.hoy <= p.date_to) ?? null);

  /**
   * La quincena que importa. ⚠️ El ultimo recurso es **la que corre hoy, tenga corrida o no**:
   * la primera version caia a `null` cuando no habia ninguna corrida, y entonces la pantalla
   * abria sin nada que mirar y sin nada que elegir. Un tablero vacio tiene que seguir diciendo
   * en que dia vive.
   */
  readonly destacada = computed<CommissionBoardRow | null>(() => {
    const b = this.board();
    const pagable = [...b].reverse().find((r) => r.status === 'borrador' || r.status === 'aprobado');
    return pagable ?? b.find((r) => r.status === 'en_curso') ?? this.enCurso() ?? null;
  });

  readonly sinCorrida = computed(() => this.board().filter((r) => r.estado_calculo === 'sin_calcular'));

  /** "Q18, Q19 y Q20" — la lista que la pantalla nombra, sin obligar a contarlas en el rail. */
  readonly listaSinCalcular = computed(() => {
    const q = this.sinCalcular().map((p) => `Q${p.period_no}`);
    if (q.length <= 1) return q[0] ?? '';
    return `${q.slice(0, -1).join(', ')} y ${q[q.length - 1]}`;
  });

  /**
   * El rail, agrupado por mes. ⛔ La primera version filtraba `if (!p.run_id) continue` y con
   * cero corridas dejaba el rail VACIO — 27 quincenas reales escondidas y un "Elegí una
   * quincena" sin nada que elegir. Las quincenas existen aunque no esten calculadas: el chip
   * dice cual es cual, que es distinto de no mostrarlas.
   */
  readonly porMes = computed(() => {
    const out: { mes: string; filas: CommissionBoardRow[] }[] = [];
    for (const p of this.board()) {
      if (p.date_from > this.hoy) continue;   // las que no empezaron van al pie
      const m = this.MESES[Number(p.date_to.slice(5, 7)) - 1] ?? '';
      const nombre = m.charAt(0).toUpperCase() + m.slice(1) + ' ' + p.date_to.slice(0, 4);
      const ult = out[out.length - 1];
      if (ult && ult.mes === nombre) ult.filas.push(p);
      else out.push({ mes: nombre, filas: [p] });
    }
    return out;
  });

  /** Lo que todavia no empieza no es "sin corrida": es futuro, y ocupa una linea. */
  readonly futuras = computed(() => this.board().filter((p) => p.date_from > this.hoy));

  // ── [AUD-A3] La tira del año ──────────────────────────────────────────────────────────────

  esFutura(p: CommissionBoardRow): boolean { return p.date_from > this.hoy; }

  readonly pagadas = computed(() => this.board().filter((p) => p.status === 'pagado').length);

  /**
   * La altura de cada barra, en píxeles, proporcional al monto de su quincena.
   *
   * ⭐ Es un `computed` que devuelve un **Map**, no un método. Un método en la plantilla se
   * ejecuta en CADA ciclo de detección y por cada una de las 27 celdas; acá el cálculo corre
   * una vez por cambio del tablero.
   *
   * ⛔ El piso de 3 px no es cosmético: una quincena pagada con monto bajo tiene que **verse
   * distinta de una sin corrida**, que vale 1 px. Sin el piso, la más chica del año se
   * confundiría con una vacía — que es dibujar un cero sobre algo que sí se midió (ADR-056).
   *
   * ⚠️ Y el monto cae a `total_a_pagar` cuando el neto es NULL, igual que lo hacía el riel:
   * las 20 quincenas del espejo no traen neto porque falta la deducción del supervisor.
   */
  readonly alturaBarra = computed(() => {
    const MIN = 3; const MAX = 16;
    const monto = (p: CommissionBoardRow) => Number(p.total_neto ?? p.total_a_pagar ?? 0) || 0;
    const vivos = this.board().filter((p) => p.run_id);
    const tope = Math.max(...vivos.map(monto), 0);
    const out = new Map<string, number>();
    for (const p of this.board()) {
      out.set(p.period_id, !p.run_id || tope <= 0 ? 1 : MIN + Math.round((monto(p) / tope) * (MAX - MIN)));
    }
    return out;
  });

  /** Lo que la barra NO puede decir: va al `title`, que es lo que lee un lector de pantalla. */
  tituloQuincena(p: CommissionBoardRow): string {
    const cuando = `Q${p.period_no} · ${this.rango(p)}`;
    if (this.esFutura(p)) return `${cuando} · todavía no empieza`;
    if (this.esHoy(p)) return `${cuando} · en curso, cierra el ${this.dia(p.date_to)}`;
    if (!p.run_id) return `${cuando} · cerrada y SIN calcular`;
    const m = p.total_neto ?? p.total_a_pagar;
    return `${cuando} · ${this.etiquetaEstado(p)} · ${m != null ? this.money(m) : 'sin monto'}`;
  }

  esHoy(p: CommissionBoardRow): boolean {
    return p.date_from <= this.hoy && this.hoy <= p.date_to;
  }

  readonly choferes = computed(() =>
    (this.run()?.lines ?? []).filter((l) => l.beneficiario === 'chofer' && !this.esFuera(l)));

  readonly fuera = computed(() =>
    (this.run()?.lines ?? []).filter((l) => l.beneficiario === 'chofer' && this.esFuera(l)));

  /** `[AUD-CM.1]` Las rutas de chofer que comisionan en la corrida elegida (cobren o no). */
  readonly rutasQueComisionan = computed(() => new Set(this.choferes().map((l) => l.route_code)));
  /**
   * `[AUD-CM.9]` La procedencia de costo que comparten TODAS las filas («sin costo» en 11 de 11):
   * se dice una vez arriba de la tabla y no en cada renglón, donde no distinguía nada.
   */
  readonly costoComun = computed<string | null>(() => {
    const ch = this.choferes();
    const v = new Set(ch.map((l) => l.costo_veredicto ?? ''));
    return ch.length > 1 && v.size === 1 ? [...v][0] || null : null;
  });
  /** `[AUD-CM.10]` La quincena elegida es la de la tarjeta de arriba: su neto ya está a la vista. */
  readonly netoYaArriba = computed(() => !!this.sel() && this.destacada()?.period_id === this.sel()?.period_id);

  readonly supervisores = computed(() => {
    const acc = new Map<string, {
      clave: string; nombre: string; zona: string | null; rutas: string[];
      comision: number; bonos: number; trasNomina: number;
    }>();
    for (const l of this.run()?.lines ?? []) {
      if (l.beneficiario !== 'supervisor' || l.motivo_no_pago) continue;
      const nombre = l.beneficiario_nombre || '—';
      const cur = acc.get(nombre) ?? {
        clave: nombre, nombre, zona: l.zona ?? null, rutas: [], comision: 0, bonos: 0, trasNomina: 0,
      };
      cur.rutas.push(l.route_code);
      cur.comision += Number(l.comision) || 0;
      cur.bonos += Number(l.bonos) || 0;
      // `[RD.64]` Se llamaba `bruto` y acumula `a_pagar`, que YA trae la nomina restada.
      // Es la misma confusion que publicaba un BRUTO menor que la COMISION en la tira de
      // arriba. El nombre ahora dice lo que el numero es.
      cur.trasNomina += Number(l.a_pagar) || 0;
      acc.set(nombre, cur);
    }
    return [...acc.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  });

  constructor() { this.cargar(); }

  cargar() {
    this.cargando.set(true);
    this.err.set(null);
    // `[RD.52]` El contraste va en su propia llamada y NO bloquea el tablero: lee tabla (11 ms
    // medidos) y si falla, la pestaña no aparece y la pantalla sigue sirviendo igual.
    this.contraste.set(null);
    this.cargarContraste();
    this.falto.set(null);
    this.cargarFalto();
    this.padron.set([]);
    this.cargarUniverso();
    // `[RD.84]` El padrón EDITABLE va junto al universo — la pestaña muestra los dos. Pedirlo
    // sólo al abrir el diálogo dejaría la tabla vacía hasta el primer clic.
    this.cargarPadron();
    // [RD.85] Los bonos cuelgan de la escala, no de la quincena: se piden una vez.
    this.cargarBonos();
    // [RD.86] El tabulador tampoco depende de la quincena: cuelga de su propia vigencia.
    this.cargarEscalas();
    this.api.commissionBoard(this.anio()).subscribe({
      next: (b) => {
        this.board.set(b.periodos);
        this.sinCalcular.set(b.sin_calcular ?? []);
        this.cargando.set(false);
        const d = this.destacada();
        if (d) this.elegir(d);
        else { this.sel.set(null); this.run.set(null); }
      },
      error: () => { this.cargando.set(false); this.err.set('No se pudo cargar el tablero.'); },
    });
  }

  /**
   * `[RD.65]` La proyeccion con la forma que la pantalla sabe pintar.
   *
   * ⛔ Aqui habia un `d as CommissionRunDetail` y TypeScript lo rechazo con razon: al payload
   * del preview le faltan `id`, `origen`, `updated_at` y `notes`, y sus lineas no traen `id`.
   * Un `as` no convierte nada -- AFIRMA, y es el mismo defecto que `[RD.60.3]`, donde un
   * `{ rn: number }` sobre una fila de `raw()` dejo una pantalla en cero durante meses.
   *
   * Los cuatro campos se llenan con lo que de verdad son, no con relleno:
   *  · `id`: cadena vacia. NO hay corrida -- es justo lo que la distingue, y `esProyeccion()`
   *    se apoya en `sel().run_id`, no en esto.
   *  · `origen`: `proyeccion`, que es el origen real de estas cifras.
   *  · `updated_at`: AHORA, y aqui si es cierto: mide cuando se CALCULO la proyeccion, que
   *    acaba de ocurrir. No se confunde con la edad del DATO, que viaja en `data_as_of` y
   *    sale del servidor.
   *  · el `id` de cada linea: su `route_code`, que es su llave natural en este payload.
   */
  private comoCorrida(d: CommissionRunPayload): CommissionRunDetail {
    return {
      ...d,
      id: '',
      origen: 'proyeccion',
      updated_at: new Date().toISOString(),
      notes: null,
      // `[RD.97]` La tabla lee `beneficiario_nombre`, que es el nombre CONGELADO en la línea de
      // una corrida guardada. La vista previa no guarda nada y lo trae como `chofer_nombre` /
      // `supervisor_nombre`: sin esto la columna Chofer salía «—» en las 11 rutas.
      lines: d.lines.map((l) => ({
        ...l,
        id: l.route_code,
        beneficiario_nombre: l.beneficiario_nombre
          ?? (l.beneficiario === 'chofer' ? l.chofer_nombre : l.supervisor_nombre) ?? null,
      })),
    };
  }

  /**
   * `[RD.65]` Abre un periodo. Si NO tiene corrida y todavia corre, se pide la PROYECCION.
   *
   * ⛔ Antes esta funcion hacia `if (!p.run_id) return;` y se iba: la quincena en curso
   * quedaba en blanco los 14 dias, y lo unico que la pantalla decia era «todavia corre: no se
   * calcula hasta que cierre». Cierto, pero inutil -- el usuario pasa media quincena sin saber
   * como va, y la cifra SI se puede calcular: `POST /commissions/preview` existe desde
   * `[RD.22]`, corre el mismo motor con `dryRun` y no deja fila. El freno de periodo abierto
   * lo deja pasar a proposito. Nadie la llamaba.
   *
   * ⚠️ Va APARTE y no bloquea: medido contra prod, su consulta mas lenta (`SQL_COSTO_DIA`)
   * tarda 874 ms, y el tablero entero carga en 33. Pedirla en serie pondria la pantalla al
   * filo del segundo por una cifra que es secundaria. Se pide sola y llega cuando llega.
   */
  elegir(p: CommissionBoardRow) {
    this.sel.set(p);
    this.run.set(null);
    this.proyectando.set(false);
    this.proyeccionFallo.set(false);
    // ⛔ `[RD.92]` Una respuesta que llega cuando ya se eligió OTRA quincena se tira. Con la
    //    proyección por fin dibujada, la corrida de Q21 llegando tarde se habría pintado como
    //    «proyección» de Q22 (la plantilla decide por `sel().run_id`).
    const sigue = () => this.sel()?.period_id === p.period_id;
    if (p.run_id) {
      this.api.commissionRun(p.run_id).subscribe({
        next: (d) => { if (sigue()) this.run.set(d); },
        error: () => { if (sigue()) this.err.set('No se pudo cargar la corrida.'); },
      });
      return;
    }
    if (p.estado_calculo !== 'en_curso') return;
    this.proyectando.set(true);
    this.api.commissionPreview(p.period_id).subscribe({
      next: (d) => { if (!sigue()) return; this.run.set(this.comoCorrida(d)); this.proyectando.set(false); },
      // ⛔ Un fallo de la proyeccion NO es un fallo de la pantalla: el tablero, el contraste y
      //    el historial siguen sirviendo. Se declara en su sitio, no en el banner de error.
      error: () => { if (!sigue()) return; this.proyectando.set(false); this.proyeccionFallo.set(true); },
    });
  }

  /**
   * `[RD.92]` Las cifras de la tarjeta de arriba. En la quincena en curso salen de la
   * proyección —la fila del tablero no tiene corrida y las traía en NULL— y sólo si la
   * proyección es de ESA quincena.
   */
  readonly cifrasDestacada = computed(() => {
    const d = this.destacada();
    if (!d) return null;
    const r = this.run();
    const fuente = !d.run_id && r && this.sel()?.period_id === d.period_id ? r : d;
    const n = (v: string | number | null | undefined) => (v == null ? null : Number(v));
    return { neto: n(fuente.total_neto), tras: n(fuente.total_a_pagar), ded: n(fuente.total_deduccion) };
  });

  /** `[RD.92]` La fecha de pago ya pasó y la quincena no está pagada. */
  pagoVencido(p: CommissionBoardRow): boolean {
    return !!p.pay_date && p.pay_date < this.hoy && p.status !== 'pagado';
  }

  // ── Lectura ────────────────────────────────────────────────────────────────────────────

  private esFuera(l: CommissionLine): boolean {
    const DENTRO = new Set(['sin_dato_en_la_fuente', 'bajo_umbral']);
    return !!l.motivo_no_pago && !DENTRO.has(l.motivo_no_pago);
  }

  pagan(): number { return this.choferes().filter((l) => !l.motivo_no_pago).length; }

  sumCh(campo: keyof CommissionLine): number {
    return this.choferes().reduce((s, l) => s + (Number(l[campo]) || 0), 0);
  }

  bloqueantes(r: CommissionRunDetail): CommissionGate[] {
    return (r.gates ?? []).filter((g) => g.estado === 'bloquea');
  }

  /**
   * `[RD.97]` Lo que se pinta en rojo. En lo acumulado de una quincena en curso, `periodo_cerrado`
   * y `frescura` bloquean SIEMPRE — es la definición de «en curso» — y no se muestran como
   * problema. ⚠️ `proximoActo()` sigue leyendo `bloqueantes()` completo: esto es sólo la pintura.
   */
  bloqueantesVisibles(r: CommissionRunDetail): CommissionGate[] {
    const todas = this.bloqueantes(r);
    if (!this.esProyeccion()) return todas;
    return todas.filter((g) => g.gate !== 'periodo_cerrado' && g.gate !== 'frescura');
  }

  avisos(r: CommissionRunDetail): CommissionGate[] {
    return (r.gates ?? []).filter((g) => g.estado === 'advierte' || g.estado === 'no_medido');
  }

  pestanas(): SegOption[] {
    const c = this.contrasteDelPeriodo();
    return [
      // [AUD-CM.5] La pestaña cuenta los renglones que muestra (decía 7 con 11 renglones: el 7 son
      // los que cobran, y eso lo dice el pie de la tabla).
      { label: `Choferes · ${this.choferes().length}`, value: 'chofer' },
      { label: `Supervisores · ${this.supervisores().length}`, value: 'supervisor' },
      ...(this.fuera().length ? [{ label: `No comisionan · ${this.fuera().length}`, value: 'fuera' }] : []),
      ...(this.faltoDelPeriodo().length
        ? [{ label: `Lo que faltó · ${this.faltoDelPeriodo().length}`, value: 'falto' }] : []),
      ...(c.length ? [{ label: `Libro vs motor · ${c.length}`, value: 'contraste' }] : []),
      // `[RD.92]` Quién cobra, Bonos y Tabulador ya no van acá: no son de la quincena. Viven
      // en `vistas()`, el conmutador de arriba, donde no dependen de que haya corrida.
    ];
  }

  /**
   * `[RD.80]` El problema en palabras de quien paga, no en las de la vista.
   *
   * ⛔ Sin esto la pantalla publicaría `cobra_sin_fuente`, que es vocabulario de la base. El
   * usuario de esta pantalla autoriza una nómina: tiene que leer qué está mal, no cómo se llama
   * la columna.
   */
  etiquetaProblema(p: string | null): string {
    switch (p) {
      case 'cobra_sin_fuente':  return 'Cobra y su fuente no da señal';
      case 'fuente_rezagada':   return 'Le faltan días';
      case 'vende_sin_cobrar':  return 'Vende y no comisiona';
      case 'dato_imposible':    return 'Trae venta con fecha futura';
      default:                  return '—';
    }
  }

  sevProblema(p: string | null): 'danger' | 'warn' | 'info' | 'secondary' {
    if (p === 'cobra_sin_fuente') return 'danger';
    if (p === 'fuente_rezagada' || p === 'dato_imposible') return 'warn';
    if (p === 'vende_sin_cobrar') return 'secondary';
    return 'secondary';
  }

  /**
   * ⛔ `sin_fuente` NO se pinta como «hace mucho»: son dos cosas distintas. Una ruta sin ninguna
   * fila nunca reportó, y `dias_sin_dato` viene NULL justamente para no dibujar un cero que se
   * leería como «reportó hoy» (ADR-056).
   */
  etiquetaFuente(r: CommissionUniverseRow): string {
    if (r.fuente_estado === 'sin_fuente') return 'sin fuente';
    if (r.dias_sin_dato == null) return 'sin medir';
    if (r.dias_sin_dato === 0) return 'hoy';
    return r.dias_sin_dato === 1 ? 'hace 1 día' : `hace ${r.dias_sin_dato} días`;
  }

  // ── `[RD.71/RD.80]` El padrón — quién cobra y si su fuente sigue viva ─────────────────────
  //
  // ⛔ **`GET /commissions/universe` existía desde `[RD.17]` y NO tenía un solo consumidor en el
  // frontend.** El universo se derivaba, se publicaba y la pantalla nunca lo mostraba — por eso
  // la 321 pudo pasar **139 días** cobrando sin vender y nadie lo vio. La pestaña «No comisionan»
  // no servía: sale de las LÍNEAS DE LA CORRIDA, o sea del espejo del libro, y el libro no tiene
  // filas para las rutas nuevas (2V001, 2V003) ni para una ruta que dejó de aparecer.
  //
  // Esta pestaña no mira la corrida: mira el padrón entero, exista o no la quincena.

  readonly padron = signal<CommissionUniverseRow[]>([]);

  /**
   * ⛔ `[RD.84]` **Se llamaba `cargarPadron()` y carga el UNIVERSO**, que es otra cosa: todas las
   * rutas que existen según el ERP, comisionen o no. El padrón editable —las filas de
   * `commission_route_config`— lo carga `cargarPadron()` de verdad, que ahora existe. Dos
   * métodos con el mismo nombre en una clase de 2,000 líneas **no dan error: gana el último**,
   * y la pestaña habría quedado leyendo la lista equivocada en silencio.
   */
  private cargarUniverso() {
    // Mismo criterio que el contraste: no bloquea el tablero y si falla la pestaña no aparece.
    this.api.commissionUniverse().subscribe({
      next: (u) => this.padron.set(u ?? []),
      error: () => this.padron.set([]),
    });
  }

  /**
   * ⭐ Las filas que contradicen al padrón, y nada más. Dos hechos distintos, y por eso van con
   * `problema` explícito en vez de mezclarse en una lista de «rutas raras»:
   *
   *  · `cobra_sin_fuente` — comisiona y su fuente no da señal. Es dinero que se va a calcular
   *    sobre nada: el tabulador es un acantilado, así que «sin días» no paga «un poco menos»,
   *    paga CERO.
   *  · `vende_sin_cobrar` — no comisiona y sí vende. Puede ser correcto (las vecinales no son
   *    Ruta Directa), pero con el monto al lado la exclusión se puede revisar; sin él es una
   *    lista de códigos raros que nadie mira.
   *  · `dato_imposible` — trae venta con fecha futura.
   */
  readonly padronHallazgos = computed(() => this.padron()
    .map((r) => ({
      ...r,
      problema: r.comisiona && (r.fuente_estado === 'muerta' || r.fuente_estado === 'sin_fuente')
        ? 'cobra_sin_fuente'
        : r.tiene_dato_futuro ? 'dato_imposible'
          : !r.comisiona && Number(r.subtotal_30d) > 0 ? 'vende_sin_cobrar'
            : r.comisiona && r.fuente_estado === 'rezagada' ? 'fuente_rezagada' : null,
    }))
    .filter((r) => r.problema !== null)
    // Lo que cobra sin fuente primero: es lo único de esta lista que mueve un depósito.
    .sort((a, b) => {
      const peso = (p: string | null) =>
        p === 'cobra_sin_fuente' ? 0 : p === 'fuente_rezagada' ? 1 : p === 'dato_imposible' ? 2 : 3;
      const d = peso(a.problema) - peso(b.problema);
      return d !== 0 ? d : Number(b.subtotal_30d) - Number(a.subtotal_30d);
    }));

  /** Lo que se va a calcular sobre nada, en pesos de los últimos 30 días. */
  readonly padronEnRiesgo = computed(() => this.padronHallazgos()
    .filter((r) => r.problema === 'cobra_sin_fuente').length);

  /**
   * ⛔ **Suma sobre el HECHO, no sobre la etiqueta** — y la diferencia no es de estilo.
   *
   * `padronHallazgos()` asigna **una sola** etiqueta por fila con una cadena de ternarios, así
   * que una ruta que venda sin cobrar **y además** traiga una venta con fecha futura se queda
   * con `dato_imposible` y **desaparecía de este total sin avisar**. Es el Cruce 1: una cifra
   * publicada que no se puede recorrer hasta su lista.
   *
   * ⚠️ Era **latente, no vivo**: hoy la única con dato futuro es la 22, que sí comisiona. Se
   * arregla ahora porque el día que deje de ser latente, el síntoma es un total más chico —
   * y un total más chico no se nota.
   */
  readonly padronVendeSinCobrar = computed(() => this.padron()
    .filter((r) => !r.comisiona && Number(r.subtotal_30d) > 0)
    .reduce((s, r) => s + Number(r.subtotal_30d), 0));

  // ── `[RD.52]` El contraste ────────────────────────────────────────────────────────────────

  readonly contraste = signal<CommissionContrast | null>(null);
  readonly contrastando = signal(false);
  /** `[RD.98]` Por qué quincena va el contraste: se corre de a una y se ve avanzar. */
  readonly contrasteAvance = signal<{ actual: number; hechas: number; total: number } | null>(null);
  /** Las quincenas que no se pudieron contrastar, con el motivo del servidor. No se tragan. */
  readonly contrasteFallas = signal<string[]>([]);

  // ── `[RD.56]` Lo que faltó ────────────────────────────────────────────────────────────────

  readonly falto = signal<CommissionHeadroom | null>(null);

  /** Las filas de la quincena elegida que tienen algo que perseguir, lo más cerca primero. */
  readonly faltoDelPeriodo = computed<CommissionHeadroomRow[]>(() => {
    const f = this.falto(); const p = this.sel();
    if (!f || !p) return [];
    // [AUD-CM.1] Solo las rutas que comisionan en esta corrida: «Lo que faltó» le decía a 1V001
    // («no es ruta de camión») cuánto le faltó para un escalón que no le aplica (7 de 12 renglones).
    const comisionan = this.rutasQueComisionan();
    return f.filas
      .filter((x) => x.period_no === p.period_no && x.cercania !== 'en_el_tope' && comisionan.has(x.route_code))
      .sort((a, b) => (a.escalon_falta ?? 9e9) - (b.escalon_falta ?? 9e9));
  });

  /** ⭐ El caso que la pantalla tiene que gritar: quien no cobró nada por quedarse corto. */
  readonly acantilado = computed<CommissionHeadroomRow | null>(() =>
    this.faltoDelPeriodo().find((x) => x.cercania === 'sin_cobrar_por_poco') ?? null);

  /** Lo que estuvo al alcance de la mano en esta quincena, en pesos. */
  readonly oportunidadDelPeriodo = computed(() => this.faltoDelPeriodo()
    .filter((x) => x.cercania === 'sin_cobrar_por_poco' || x.cercania === 'al_alcance')
    .reduce((s, x) => s + (x.oportunidad ?? 0), 0));

  readonly enElTopeDelPeriodo = computed(() => {
    const f = this.falto(); const p = this.sel();
    if (!f || !p) return 0;
    const comisionan = this.rutasQueComisionan();
    return f.filas.filter((x) => x.period_no === p.period_no && x.cercania === 'en_el_tope' && comisionan.has(x.route_code)).length;
  });

  etiquetaCercania(c: string): string {
    const M: Record<string, string> = {
      sin_cobrar_por_poco: 'No cobró por poco', sin_cobrar: 'No cobró',
      al_alcance: 'Al alcance', cerca: 'Cerca', lejos: 'Lejos', en_el_tope: 'En el tope',
    };
    return M[c] ?? c;
  }

  sevCercania(c: string): 'danger' | 'warn' | 'secondary' | 'success' {
    if (c === 'sin_cobrar_por_poco') return 'danger';
    if (c === 'al_alcance') return 'warn';
    if (c === 'en_el_tope') return 'success';
    return 'secondary';
  }

  cargarFalto(): void {
    this.api.commissionHeadroom(this.anio()).subscribe({
      next: (f) => this.falto.set(f),
      error: () => this.falto.set(null),
    });
  }

  /** Las filas del contraste de la quincena que esté seleccionada. */
  readonly contrasteDelPeriodo = computed<CommissionContrastRow[]>(() => {
    const c = this.contraste(); const p = this.sel();
    if (!c || !p) return [];
    return c.filas.filter((f) => f.period_no === p.period_no);
  });

  /**
   * ⭐ El resumen NO se recalcula en el navegador: viene del servidor, que es donde vive el
   * veredicto. Acá sólo se ordena para que lo que no se puede juzgar quede arriba, no al final
   * donde nadie llega — mismo criterio que `ORDEN_KPI_ESTADO` de `[CDRP.2]`.
   */
  private readonly ORDEN_VEREDICTO: Record<string, number> = {
    sin_corrida_del_motor: 0, el_motor_no_paga: 1, solo_el_motor_paga: 2,
    difiere: 3, difiere_poco: 4, ninguno_paga: 5, cuadra: 6,
  };
  readonly resumenContraste = computed(() => {
    const c = this.contraste();
    if (!c) return [];
    return [...c.resumen].sort((a, b) =>
      (this.ORDEN_VEREDICTO[a.veredicto] ?? 9) - (this.ORDEN_VEREDICTO[b.veredicto] ?? 9));
  });

  etiquetaVeredictoContraste(v: string): string {
    const M: Record<string, string> = {
      cuadra: 'Cuadra', difiere_poco: 'Difiere poco', difiere: 'Difiere',
      el_motor_no_paga: 'El motor NO paga', solo_el_motor_paga: 'Sólo el motor paga',
      ninguno_paga: 'Ninguno paga', sin_corrida_del_motor: 'Sin medir',
      solo_el_motor: 'Sólo en el motor',
    };
    return M[v] ?? v;
  }

  sevContraste(v: string): 'success' | 'warn' | 'danger' | 'secondary' {
    if (v === 'cuadra') return 'success';
    if (v === 'difiere_poco' || v === 'ninguno_paga') return 'secondary';
    if (v === 'sin_corrida_del_motor') return 'warn';
    return 'danger';
  }

  etiquetaCausa(c: string | null): string {
    if (c === 'faltan_dias_en_la_fuente') return 'le faltan días a la fuente';
    if (c === 'cobertura_no_medida') return 'cobertura sin medir';
    if (c === 'sin_explicar') return 'sin explicar';
    return '';
  }

  cargarContraste(): void {
    this.api.commissionContrast(this.anio()).subscribe({
      next: (c) => this.contraste.set(c),
      // Sin contraste la pantalla sigue sirviendo: la pestaña simplemente no aparece.
      error: () => this.contraste.set(null),
    });
  }

  /**
   * `[RD.98]` Contrasta las quincenas con LIBRO, de a una. Antes era una sola petición por el año
   * (~12 s × 20 quincenas): detrás del túnel no podía terminar, y las fallas por quincena que el
   * servidor sí devolvía se tiraban sin mostrarse. Sólo las de libro: la de Q21 es del motor, y
   * contrastarla contra el motor siempre cuadraría.
   */
  correrContraste(): void {
    if (this.contrastando()) return;
    const cola = this.board()
      .filter((p) => p.origen === 'libro' && p.run_id && p.date_to < this.hoy)
      .sort((a, b) => a.period_no - b.period_no);
    this.contrasteFallas.set([]);
    if (!cola.length) {
      this.err.set('No hay quincenas con libro cargado que contrastar este año.');
      return;
    }
    this.contrastando.set(true);
    const paso = (i: number): void => {
      if (i >= cola.length) {
        this.contrastando.set(false);
        this.contrasteAvance.set(null);
        this.cargarContraste();
        return;
      }
      const p = cola[i];
      this.contrasteAvance.set({ actual: p.period_no, hechas: i, total: cola.length });
      this.api.commissionContrastRunPeriod(p.period_id).subscribe({
        next: () => paso(i + 1),
        error: (e) => {
          this.contrasteFallas.update((f) => [...f,
            `Q${p.period_no}: ${e?.error?.message ?? 'no respondió el servidor'}`]);
          paso(i + 1);
        },
      });
    };
    paso(0);
  }

  /**
   * `[RD.64]` La cifra del rail cae a `total_a_pagar` cuando el neto no se pudo calcular, y se
   * marca con subrayado punteado. ⛔ Se llamaba `esBruto` y NO es el bruto: `total_a_pagar` ya
   * trae restada la nomina de cada renglon. El bruto de verdad es comision + bonos.
   */
  esTrasNomina(p: CommissionBoardRow): boolean { return !!p.run_id && p.total_neto == null && p.total_a_pagar != null; }

  tipMonto(p: CommissionBoardRow): string {
    if (!p.run_id) return '';
    if (p.total_neto != null) return 'Neto a pagar';
    if (p.total_a_pagar != null) return 'BRUTO — el neto no se puede calcular sin la deduccion del supervisor';
    return '';
  }

  /**
   * ⛔ `libro` existía en la DB y no acá: el mapa decía `cron ? 'automático' : 'manual'`, así que
   * las 20 quincenas espejadas del workbook se publicaban como **«origen manual»** — o sea,
   * afirmando que alguien las calculó con el motor. Es lo contrario de lo que pasó.
   */
  etiquetaOrigen(o: string): string {
    if (o === 'cron') return 'automático';
    if (o === 'libro') return 'el libro (espejo)';
    // [RD.97] Lo acumulado de la quincena en curso salía «manual»: ni es corrida ni la hizo nadie.
    if (o === 'proyeccion') return 'acumulado en curso';
    return 'manual';
  }

  /**
   * `[RD.64]` El bruto DE VERDAD: comision + bonos, antes de cualquier resta.
   *
   * ⛔ No sale de la corrida: `commission_runs` no guarda el bruto -- guarda `total_comision`
   * y `total_a_pagar`, que ya trae la nomina restada. Se suma de las lineas, que es donde
   * viven los bonos. Si la corrida no trae lineas cargadas devuelve la comision sola, que es
   * el piso defendible, nunca un cero.
   */
  brutoReal(r: CommissionRunDetail): number {
    const lineas = r.lines ?? [];
    if (!lineas.length) return Number(r.total_comision) || 0;
    // ⛔ SOLO las que pagan. Una ruta con `motivo_no_pago` tiene comision calculada pero no
    //    cobra, y sumarla inflaba el bruto. Verificado contra prod: con el filtro puesto,
    //    bruto - nomina == total_a_pagar AL CENTAVO en las dos corridas pagadas (86,257.26 -
    //    33,939.84 = 52,317.42). Sin el filtro no cuadraba por 13,939.84, y esa fue la primera
    //    version de este arreglo -- la aritmetica se comprueba antes de publicarla, que es
    //    justo lo que el defecto original no hizo.
    return lineas
      .filter((l) => !l.motivo_no_pago)
      .reduce((a, l) => a + (Number(l.comision) || 0) + (Number(l.bonos) || 0), 0);
  }

  kpis(r: CommissionRunDetail): MetricStripItem[] {
    const conDato = r.rutas_con_dato ?? 0;
    const sinDato = r.rutas_sin_dato ?? 0;
    const items: MetricStripItem[] = [
      { label: 'Subtotal', value: Number(r.total_subtotal), format: 'currency' },
      // [AUD-CM.8] La comisión y el bruto suman choferes Y supervisores: sin decirlo, la tira
      // ($73,863) no cuadraba con la tabla de Choferes ($59,090.22) y nada explicaba la diferencia.
      { label: 'Comisión', value: Number(r.total_comision), format: 'currency',
        sub: `choferes ${this.money(this.sumCh('comision'))} · supervisores ${this.money(this.supervisores().reduce((s, x) => s + x.comision, 0))}` },
      // ⛔⛔ `[RD.64]` Esta tira decia **BRUTO** sobre `total_a_pagar`, y `total_a_pagar` NO es el
      //    bruto: ya trae restada la nomina de cada renglon. Medido sobre una corrida pagada:
      //    comision 76,057.26 + bonos 10,200.00 = 86,257.26 de bruto REAL, menos 47,879.68 de
      //    nomina = 52,317.42, que era lo que se publicaba como 'Bruto'. Son ~36 mil pesos de
      //    diferencia, y en pantalla quedaba un BRUTO MENOR que la COMISION de al lado -- algo
      //    imposible, que o se lee como un bug o se cree.
      //    Ahora la tira dice lo que la cifra es y pone la resta a la vista (Q.2: explicar el
      //    numero, no solo mostrarlo). El bruto real se publica aparte, que es el que cuadra
      //    con la suma de las columnas Comision y Bonos de la tabla de abajo.
      { label: 'Bruto', value: this.brutoReal(r), format: 'currency',
        sub: 'comisión + bonos de choferes y supervisores' },
      { label: 'Tras nómina', value: Number(r.total_a_pagar), format: 'currency',
        sub: `menos ${this.money(this.brutoReal(r) - Number(r.total_a_pagar))} de nómina` },
      // ⛔ `Number(null)` es **0**, y asi esta tira publicaba "NETO $0" en rojo sobre una
      // quincena en la que de verdad se pagaron $42,761. Un neto que no se puede calcular se
      // DECLARA; dibujarlo en cero es peor que no mostrarlo, porque parece una cifra.
      r.total_neto == null
        ? {
          label: 'Neto', value: '—', tone: 'warn' as const,
          sub: 'sin medir: falta la deduccion por persona del supervisor',
        }
        : {
          // [AUD-CM.11] Sin tono: el naranja es del botón principal, no de una cifra.
          label: 'Neto', value: Number(r.total_neto), format: 'currency' as const,
          sub: `menos ${this.money(r.total_deduccion)} de deducciones`,
        },
      {
        label: 'Cobertura', value: conDato, format: 'number',
        tone: sinDato ? 'warn' : 'ok',
        // [AUD-CM.4] «fuera» cuenta la MISMA lista que la pestaña «No comisionan» (decía 8 con 11
        // renglones en la pestaña: rutas_fuera se congeló con la corrida y usa otra definición).
        sub: `con dato, de ${conDato + sinDato} que comisionan${this.fuera().length ? ` · otras ${this.fuera().length} no comisionan` : ''}`,
      },
    ];
    return items.filter((k) => !(k.label === 'Neto' && this.netoYaArriba()));
  }

  // ── Formato ────────────────────────────────────────────────────────────────────────────

  private readonly MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  /**
   * ⚠️ Corta la cadena, NO construye un `Date`: un `date` de pg llega a medianoche UTC y en
   * hora de Mexico eso es el dia ANTERIOR (`[LC.16]`).
   */
  dia(iso: string | null): string {
    if (!iso) return '—';
    const d = Number(iso.slice(8, 10));
    const m = this.MESES[Number(iso.slice(5, 7)) - 1] ?? '';
    return `${d} ${m}`;
  }

  rango(p: { date_from: string; date_to: string }): string {
    const mf = Number(p.date_from.slice(5, 7));
    const mt = Number(p.date_to.slice(5, 7));
    const df = Number(p.date_from.slice(8, 10));
    return mf === mt ? `${df} – ${this.dia(p.date_to)}`
      : `${df} ${this.MESES[mf - 1]} – ${this.dia(p.date_to)}`;
  }

  /** Para un timestamp si vale `Date`: es un instante, no una fecha de negocio. */
  cuando(ts: string | null): string {
    if (!ts) return 'sin fecha';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'sin fecha';
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.round(min / 60)} h`;
    return `hace ${Math.round(min / 1440)} d`;
  }

  /**
   * ⛔ Antes todo lo que no tenía corrida decía **"sin corrida"**, y eso tapaba la distinción
   * que más importa: la quincena que está corriendo todavía no puede tener número, y la que
   * cerró hace diez días y no lo tiene es trabajo pendiente. El mismo chip gris para las dos
   * hacía que una quincena olvidada se viera normal.
   */
  /**
   * ⭐ La ruta tiene menos días con venta que sus hermanas de plaza. Medido contra el libro
   * (Q10–Q20): de 22 marcadas, **14 descuadran de verdad y 8 no** — ésas cuadran al 0.0% porque
   * el camión en serio no salió. Por eso se señala y no se tacha nada.
   */
  /**
   * ⚠️ `fallas` y `saltadas` NO se tragan ni se resumen en "listo": una quincena que el motor se
   * negó a tocar es trabajo que sigue pendiente, y esconderla haría leer como terminado lo que
   * no lo está. Se recarga el tablero igual, porque lo que SÍ se calculó ya está escrito.
   */
  recalcularDesde(periodId: string): void {
    if (this.recalculando()) return;
    this.recalculando.set(true);
    this.recalc.set(null);
    this.err.set(null);
    this.api.commissionRecalculateFrom(periodId).subscribe({
      next: (r) => {
        this.recalc.set(r);
        this.recalculando.set(false);
        this.cargar();
      },
      error: (e) => {
        this.recalculando.set(false);
        this.err.set(e?.error?.message ?? 'No se pudo calcular.');
      },
    });
  }

  // ── [RD.83] Los actos ──────────────────────────────────────────────────────────────────
  //
  // ⭐ **Por qué esto no contradice el "sin botones" de la cabecera.** Lo que se quitó en
  // `[RD.22]` fue *calcular* desde el hilo de la petición: costaba 5,762 ms y hacía lenta la
  // lectura. Aprobar, pagar y anular son `UPDATE` de una fila — ni leen venta ni materializan
  // nada. El argumento de rendimiento no los alcanza, y sin ellos el ciclo de cuatro pasos que
  // la pantalla dibuja no se puede recorrer en ningún lado.
  //
  // ⛔ **La máquina de estados NO se reimplementa acá.** El servidor ya la tiene en `setStatus`
  // y es la que manda; esto sólo decide qué ofrecer. Si las dos discrepan, gana el 409 del
  // servidor y se muestra su mensaje tal cual — una copia de la regla en el front se
  // desincroniza y termina ofreciendo un botón que siempre falla.

  /** El acto que toca, o `null` si no hay nada que hacer con esta corrida. */
  proximoActo(r: CommissionRunDetail): 'approve' | 'pay' | null {
    // ⛔ Una corrida con compuertas que bloquean NO se aprueba. La compuerta ya se pinta arriba
    // con su motivo; ofrecer el botón igual la volvería decorativa.
    if (r.status === 'borrador' && !this.bloqueantes(r).length) return 'approve';
    if (r.status === 'aprobado') return 'pay';
    return null;
  }

  /** Anular existe mientras el dinero no se haya ido. Lo pagado no se revive ni se deshace. */
  sePuedeAnular(r: CommissionRunDetail): boolean {
    return r.status === 'borrador' || r.status === 'bloqueada' || r.status === 'aprobado';
  }

  // ── [RD.101] (D6) Quién hace cada acto ─────────────────────────────────────────────────
  // ⛔ Esto sólo decide qué OFRECER: el servidor exige la llave y rechaza que apruebe quien
  // calculó. Sin la copia de la regla acá, el que calculó vería «Aprobar» y se comería un 403.

  readonly puedeAprobar = computed(() => this.perms.has(Permission.COMMERCIAL_COMMISSIONS_APROBAR));
  readonly puedePagar = computed(() => this.perms.has(Permission.COMMERCIAL_COMMISSIONS_PAGAR));
  private readonly yo = computed(() => this.auth.user()?.sub ?? null);

  /** ¿Esta persona calculó la corrida? El cron no cuenta como persona (`created_by` nulo). */
  calculeYo(r: CommissionRunDetail): boolean {
    const yo = this.yo();
    return !!yo && !!r.created_by && r.created_by === yo;
  }

  /** El acto que toca Y que esta persona puede hacer. */
  actoPropio(r: CommissionRunDetail): 'approve' | 'pay' | null {
    const acto = this.proximoActo(r);
    if (acto === 'approve') return this.puedeAprobar() && !this.calculeYo(r) ? 'approve' : null;
    if (acto === 'pay') return this.puedePagar() ? 'pay' : null;
    return null;
  }

  /** Un borrador lo anula quien calcula; una aprobada, quien aprueba (deshace la aprobación). */
  sePuedeAnularYo(r: CommissionRunDetail): boolean {
    if (!this.sePuedeAnular(r)) return false;
    return r.status === 'aprobado' ? this.puedeAprobar() : (this.puedeGestionar() || this.puedeAprobar());
  }

  /** Por qué no se ofrece el acto que toca, dicho en llano. Nulo si se ofrece o no hay acto. */
  porQueNoActuo(r: CommissionRunDetail): string | null {
    const acto = this.proximoActo(r);
    if (!acto || this.actoPropio(r)) return null;
    if (acto === 'approve' && this.puedeAprobar() && this.calculeYo(r))
      return 'Tú calculaste esta corrida: la aprueba otra persona de Dirección.';
    return acto === 'approve'
      ? 'La aprueba Dirección (permiso «Aprobar comisiones de ruta»).'
      : 'La marca pagada Finanzas (permiso «Marcar pagadas las comisiones de ruta»).';
  }

  tituloActo(r: CommissionRunDetail): string {
    switch (this.proximoActo(r)) {
      case 'approve': return 'Falta aprobarla';
      case 'pay': return 'Falta marcarla pagada';
      default:
        if (r.status === 'pagado') return 'Pagada y congelada';
        if (r.status === 'bloqueada') return 'Bloqueada';
        if (r.status === 'anulado') return 'Anulada';
        return 'Sin acto pendiente';
    }
  }

  explicaActo(r: CommissionRunDetail): string {
    switch (this.proximoActo(r)) {
      case 'approve':
        return 'El motor ya produjo el número y las compuertas pasan. Aprobar es un acto humano: '
          + 'el motor nunca aprueba solo.';
      case 'pay':
        return 'Aprobada. Al marcarla pagada queda congelada — lo pagado no se recalcula.';
      default:
        if (r.status === 'pagado') return 'No se recalcula. Para corregirla hay que anularla y volver a calcular.';
        if (r.status === 'bloqueada')
          return 'No se aprueba con compuertas abiertas: se anula, se resuelve el motivo y se vuelve a calcular.';
        if (r.status === 'anulado') return 'Quedó fuera del libro. Volver a calcular la quincena produce una nueva.';
        return 'Esta quincena todavía corre: no se aprueba ni se paga media quincena.';
    }
  }

  /**
   * ⚠️ Se DECLARA quién y cuándo, no se dibuja un hueco. Medido el 2026-10-20: las 20 corridas
   * de prod tienen `approved_at` en NULL — entraron como espejo del libro, sin pasar por el
   * trámite. Una corrida pagada sin sello de aprobación no es un error de pintura: es historia
   * que no tuvo ese paso, y decirlo es distinto de callarlo.
   */
  selloAprobacion(r: CommissionRunDetail): string | null {
    if (r.status !== 'aprobado' && r.status !== 'pagado') return null;
    const partes: string[] = [];
    if (r.approved_at) partes.push(`aprobada ${this.cuando(r.approved_at)}`);
    if (r.paid_at) partes.push(`pagada ${this.cuando(r.paid_at)}`);
    if (!partes.length) return 'sin sello de aprobación — entró como espejo del libro';
    return partes.join(' · ');
  }

  readonly actuando = signal(false);

  confirmarActo(r: CommissionRunDetail, accion: 'approve' | 'pay' | 'void'): void {
    const q = r.period ? `Q${r.period.period_no}` : 'esta quincena';
    // [RD.92] Sin neto, el diálogo decía «por $X» con el monto tras nómina como si fuera lo que
    // sale del banco. Se aprueba igual —la compuerta avisa, no bloquea (ADR-016)—, pero sabiendo.
    const monto = r.total_neto != null
      ? this.money(r.total_neto)
      : `${this.money(r.total_a_pagar)} tras nómina (el neto no está medido: falta la deducción del supervisor)`;
    const textos: Record<typeof accion, { header: string; message: string; accept: string }> = {
      approve: {
        header: `Aprobar ${q}`,
        message: `Se aprueba ${q} por ${monto} (${this.pagan()} chofer(es) que cobran). `
          + 'Aprobar no paga: habilita el paso de pago. Queda registrado con tu nombre y la hora.',
        accept: 'Aprobar',
      },
      pay: {
        header: `Marcar ${q} como pagada`,
        message: `Se marca ${q} por ${monto} como PAGADA y queda congelada: no se recalcula, `
          + 'ni cuando cambie el tabulador ni cuando llegue dato nuevo. Esto no mueve dinero — '
          + 'registra que ya se pagó.',
        accept: 'Marcar pagada',
      },
      void: {
        header: `Anular ${q}`,
        message: `Se anula la corrida de ${q} por ${monto}. Sale del libro y la quincena vuelve a `
          + 'quedar sin número, para volver a calcularla con el motivo resuelto.',
        accept: 'Anular',
      },
    };
    const t = textos[accion];
    this.confirm.confirm({
      header: t.header, message: t.message,
      acceptLabel: t.accept, rejectLabel: 'Cancelar',
      accept: () => this.actuar(r.id, accion),
    });
  }

  private actuar(runId: string, accion: 'approve' | 'pay' | 'void'): void {
    if (this.actuando()) return;
    this.actuando.set(true);
    this.err.set(null);
    this.api.commissionSetStatus(runId, accion).subscribe({
      next: (detalle) => {
        this.actuando.set(false);
        this.run.set(detalle);
        this.toast.add({
          severity: 'success',
          summary: accion === 'approve' ? 'Aprobada' : accion === 'pay' ? 'Marcada pagada' : 'Anulada',
          detail: `Queda en estado "${detalle.status}".`,
        });
        // El tablero trae el estado y el monto de cada quincena: si no se recarga, la tira de
        // arriba sigue diciendo lo de antes del acto.
        this.cargar();
      },
      error: (e) => {
        this.actuando.set(false);
        // ⭐ El 409 del servidor trae la razón exacta (qué transición no se permite, y qué
        // compuertas bloquean). Se muestra tal cual: un "no se pudo" propio la borraría.
        const msg = e?.error?.message ?? 'No se pudo completar el trámite.';
        this.err.set(msg);
        this.toast.add({ severity: 'error', summary: 'No se completó', detail: msg, life: 8000 });
      },
    });
  }

  // ── [RD.84] El padrón se administra acá ────────────────────────────────────────────────
  //
  // ⛔ **Lo que esto cierra.** Medido el 2026-10-20: el módulo sólo podía `INSERT` en cinco
  // tablas y `commission_route_config` no era una de ellas. Cada cambio de padrón —una ruta que
  // entra, un chofer que cambia, una nómina que sube— exigía escribir una migración, empujarla
  // y aplicarla a prod a mano. Mover las rutas 321 y 322 a Vecinal costó exactamente eso.
  //
  // ⚠️ Las reglas duras las hace cumplir el SERVIDOR (`CommissionPadronService`), no esta
  // pantalla. Acá se previene —el botón no se habilita hasta que el formulario está completo,
  // que es poka-yoke— pero la verdad vive del otro lado: una validación que sólo existe en el
  // front es una sugerencia.

  readonly padronFilas = signal<PadronRuta[]>([]);
  readonly padronAbierto = signal(false);
  readonly padronEditando = signal<PadronRuta | null>(null);
  readonly padronGuardando = signal(false);
  readonly padronErr = signal<string | null>(null);
  readonly padronAviso = signal<PadronAvisoPagadas | null>(null);

  readonly fRuta = signal('');
  readonly fChofer = signal<string | null>(null);
  readonly fSupervisor = signal<string | null>(null);
  readonly fZona = signal<string | null>(null);
  readonly fNomina = signal<number | null>(null);
  readonly fDesde = signal<string | null>(null);
  readonly fHasta = signal<string | null>(null);
  readonly fActivo = signal(true);
  readonly fNotas = signal<string | null>(null);
  readonly fConfirmar = signal(false);

  /** Esta edición ES una baja: cambia el color del botón y vuelve obligatorio el motivo. */
  readonly esBaja = computed(() => !!this.padronEditando() && !this.fActivo());

  /**
   * ⭐ Poka-yoke, no validación tardía: el envío está deshabilitado **mientras falte algo**, en
   * vez de dejar cometer el error y reportarlo. Las tres condiciones de la baja —apagada, con
   * fecha y con motivo— se exigen **juntas**, que es como el servidor las exige.
   */
  readonly formOk = computed(() => {
    const nom = this.fNomina();
    if (nom == null || Number(nom) < 0) return false;
    if (!this.padronEditando()) {
      // Alta: código y fecha de inicio. Sin `activo_desde` la ruta cobraría la quincena 1.
      return !!this.fRuta().trim() && !!this.fDesde();
    }
    if (this.esBaja() && (!this.fHasta() || !String(this.fNotas() ?? '').trim())) return false;
    // Si el servidor ya avisó que toca quincenas pagadas, hay que confirmarlo a propósito.
    return !this.padronAviso() || this.fConfirmar();
  });

  cargarPadron(): void {
    this.api.commissionPadron().subscribe({
      next: (f) => this.padronFilas.set(f ?? []),
      // ⛔ Error NO es vacío: un padrón vacío significa «nadie cobra», que es una afirmación
      // muy distinta de «no se pudo leer». Se DECLARA (ADR-056).
      error: (e) => this.padronErr.set(
        e?.error?.message ?? 'No se pudo leer el padrón. No es que esté vacío: no se pudo leer.'),
    });
    this.cargarSupervisores();
  }

  // ── `[RD.100]` La nómina de banco de los supervisores ────────────────────────────────────

  readonly nominasSup = signal<SupervisorNomina[]>([]);
  readonly supervisoresErr = signal<string | null>(null);
  /** Lo tecleado y sin guardar, por supervisor. Sin entrada = la fila muestra lo guardado. */
  readonly borradorNomina = signal<Record<string, { monto?: number | null; desde?: string | null }>>({});
  readonly guardandoNomina = signal<string | null>(null);

  /** El % del supervisor sale del tabulador vigente, no de un literal en la pantalla. */
  readonly pctSupervisor = computed(() => {
    const p = this.pctSupVigente();
    return p !== null ? `${p} %` : 'porcentaje';
  });

  cargarSupervisores(): void {
    this.api.commissionSupervisores().subscribe({
      next: (s) => { this.nominasSup.set(s ?? []); this.supervisoresErr.set(null); },
      error: (e) => this.supervisoresErr.set(
        e?.error?.message ?? 'No se pudo leer la nómina de los supervisores. No es que no tengan: no se pudo leer.'),
    });
  }

  editarNomina(s: SupervisorNomina, cambio: { monto?: number | null; desde?: string | null }): void {
    this.borradorNomina.update((b) => ({ ...b, [s.nombre]: { ...b[s.nombre], ...cambio } }));
  }

  guardarNomina(s: SupervisorNomina): void {
    const b = this.borradorNomina()[s.nombre];
    if (!b || this.guardandoNomina()) return;
    const monto = b.monto !== undefined ? b.monto : s.nomina_banco;
    const desde = b.desde !== undefined ? b.desde : s.valid_from;
    if (monto === null || monto === undefined || !desde) {
      this.supervisoresErr.set(`Para ${s.nombre} faltan el monto o la fecha desde la que aplica.`);
      return;
    }
    this.guardandoNomina.set(s.nombre);
    this.supervisoresErr.set(null);
    this.api.commissionFijarNominaSupervisor({ nombre: s.nombre, nomina_banco: Number(monto), valid_from: desde })
      .subscribe({
        next: (lista) => {
          this.nominasSup.set(lista ?? []);
          this.borradorNomina.update((m) => { const c = { ...m }; delete c[s.nombre]; return c; });
          this.guardandoNomina.set(null);
          this.toast.add({ severity: 'success', summary: 'Nómina guardada',
            detail: `${s.nombre}: ${this.money(monto)} desde ${this.dia(desde)}. Recalcula las quincenas afectadas para que la tomen.` });
        },
        error: (e) => {
          this.guardandoNomina.set(null);
          this.supervisoresErr.set(e?.error?.message ?? 'No se pudo guardar la nómina.');
        },
      });
  }

  /** `YYYY-MM-DD` → `DD/MM`, cortando la cadena. Ver la nota de fechas de la cabecera. */
  vigencia(p: PadronRuta): string {
    const d = p.activo_desde ? this.dia(p.activo_desde) : null;
    const h = p.activo_hasta ? this.dia(p.activo_hasta) : null;
    if (p.activo) return d ? `desde ${d}` : 'siempre';
    if (h) return `hasta ${h}`;
    // ⚠️ Baja SIN fecha: no comisiona en NINGÚN periodo, ni en los que sí trabajó. Se dice.
    return 'de baja, sin fecha';
  }

  abrirAlta(): void {
    this.padronEditando.set(null);
    this.padronAviso.set(null); this.padronErr.set(null); this.fConfirmar.set(false);
    this.fRuta.set(''); this.fChofer.set(null); this.fSupervisor.set(null);
    this.fZona.set(null); this.fNomina.set(null); this.fDesde.set(null);
    this.fHasta.set(null); this.fActivo.set(true); this.fNotas.set(null);
    this.padronAbierto.set(true);
  }

  abrirEdicion(p: PadronRuta): void {
    this.padronEditando.set(p);
    this.padronAviso.set(null); this.padronErr.set(null); this.fConfirmar.set(false);
    this.fRuta.set(p.route_code);
    this.fChofer.set(p.chofer_nombre); this.fSupervisor.set(p.supervisor_nombre);
    this.fZona.set(p.zona); this.fNomina.set(Number(p.nomina_banco));
    this.fDesde.set(p.activo_desde); this.fHasta.set(p.activo_hasta);
    this.fActivo.set(p.activo); this.fNotas.set(p.notes);
    this.padronAbierto.set(true);
  }

  guardarPadron(): void {
    // ⚠️ Idempotencia visual (§10): se bloquea en el PRIMER clic, antes de esperar respuesta.
    // Sin esto el doble clic del pánico manda dos altas y el UNIQUE devuelve un 409 confuso.
    if (this.padronGuardando() || !this.formOk()) return;
    this.padronGuardando.set(true);
    this.padronErr.set(null);

    const listo = (resumen: string) => {
      this.padronGuardando.set(false);
      this.padronAbierto.set(false);
      this.toast.add({ severity: 'success', summary: 'Padrón actualizado', detail: resumen });
      this.cargarPadron();
      // El universo derivado lee la config: si no se recarga, los hallazgos de arriba siguen
      // describiendo el padrón anterior.
      this.cargarUniverso();
    };
    const falla = (e: any) => {
      this.padronGuardando.set(false);
      const msg = e?.error?.message ?? 'No se pudo guardar.';
      this.padronErr.set(msg);
      // ⭐ El 409 de quincenas pagadas no es un error: es una pregunta. Se convierte en el
      // bloque de confirmación en vez de un mensaje rojo que no ofrece salida.
      const m = /cambia (\d+) quincena\(s\) YA PAGADA\(S\) por \$([\d.,]+) \(([^)]+)\)/.exec(msg);
      if (m) this.padronAviso.set({ quincenas: Number(m[1]), pagado: `$${m[2]}`, detalle: m[3] });
    };

    const edit = this.padronEditando();
    if (!edit) {
      this.api.commissionPadronAlta({
        route_code: this.fRuta().trim(),
        nomina_banco: Number(this.fNomina()),
        activo_desde: String(this.fDesde()),
        zona: this.fZona(), chofer_nombre: this.fChofer(),
        supervisor_nombre: this.fSupervisor(), notes: this.fNotas(),
      }).subscribe({ next: (f) => listo(`Ruta ${f.route_code} dada de alta.`), error: falla });
      return;
    }
    this.api.commissionPadronEditar(edit.id, {
      zona: this.fZona(), chofer_nombre: this.fChofer(),
      supervisor_nombre: this.fSupervisor(), nomina_banco: Number(this.fNomina()),
      activo: this.fActivo(), activo_desde: this.fDesde(), activo_hasta: this.fHasta(),
      notes: this.fNotas(), confirmar: this.fConfirmar(),
    }).subscribe({
      next: (r) => listo(this.fActivo()
        ? `Ruta ${r.fila.route_code} actualizada.`
        : `Ruta ${r.fila.route_code} de baja desde el ${this.dia(String(this.fHasta()))}.`),
      error: falla,
    });
  }

  // ── [RD.85] Los bonos ──────────────────────────────────────────────────────────────────
  //
  // ⛔ Medido el 2026-10-20: `commission_bonuses` tenía un `UPDATE` y **ningún `INSERT`**. Los
  // 17 bonos vivos se sembraron por migración. Y el libro pagó **$140,800 en bonos en 20
  // quincenas** — $7,040 por quincena, más que la comisión de varias rutas juntas.

  readonly bonos = signal<BonoRD[]>([]);
  readonly bonoAbierto = signal(false);
  readonly bonoEditando = signal<BonoRD | null>(null);
  readonly bonoGuardando = signal(false);
  readonly bonoErr = signal<string | null>(null);

  readonly bNombre = signal('');
  readonly bBenef = signal<'chofer' | 'supervisor'>('chofer');
  readonly bPeriodo = signal<'quincena' | 'mes'>('quincena');
  readonly bRuta = signal<string | null>(null);
  readonly bMetrica = signal('venta');
  readonly bComp = signal<'gt' | 'gte'>('gte');
  readonly bUmbral = signal<number | null>(null);
  readonly bGate = signal<number | null>(null);
  readonly bMonto = signal<number | null>(null);
  readonly bActivo = signal(true);

  /**
   * ⭐ La unidad del umbral cambia con la métrica, y sin decirlo **25 significa veinticinco por
   * ciento en una y veinticinco pesos en otra**. La pantalla lo rotula en vez de esperar que
   * quien captura lo sepa.
   */
  readonly unidadMetrica = computed(() => {
    switch (this.bMetrica()) {
      case 'markup_pct': return 'por ciento de margen';
      case 'venta': return 'pesos de venta';
      case 'visitas': return 'visitas';
      case 'volumen': return 'unidades';
      default: return 'la marca de una persona — el umbral no decide nada';
    }
  });

  readonly bonoOk = computed(() =>
    !!this.bNombre().trim() && this.bUmbral() != null
    && this.bMonto() != null && Number(this.bMonto()) >= 0);

  /** La regla del bono en una frase, en la unidad de su métrica. */
  reglaBono(b: BonoRD): string {
    // ⚠️ Los `numeric` de Postgres llegan como STRING por JSON. `pct()` toma number, así que
    // se convierte acá: sin el `Number()` el valor sale sin formato o no tipa.
    const u = b.metrica === 'markup_pct' ? `${this.pct(Number(b.umbral))}% de margen`
      : b.metrica === 'venta' ? `${this.money(b.umbral)} de venta`
        : b.metrica === 'manual' ? 'lo marca una persona'
          : `${Number(b.umbral)} ${b.metrica}`;
    if (b.metrica === 'manual') return u;
    const cmp = b.comparador === 'gt' ? 'pasa' : 'alcanza';
    const gate = b.gate_venta_min
      ? ` · y vendió ${this.money(b.gate_venta_min)} o más` : '';
    return `${cmp} ${u}${gate}`;
  }

  cargarBonos(): void {
    this.api.commissionBonos().subscribe({
      next: (b) => this.bonos.set(b ?? []),
      // Error ≠ vacío: «no hay bonos» es una afirmación sobre el tabulador, no sobre la red.
      error: (e) => this.bonoErr.set(
        e?.error?.message ?? 'No se pudieron leer los bonos. No es que no haya: no se pudieron leer.'),
    });
  }

  abrirBonoAlta(): void {
    this.bonoEditando.set(null); this.bonoErr.set(null);
    this.bNombre.set(''); this.bBenef.set('chofer'); this.bPeriodo.set('quincena');
    this.bRuta.set(null); this.bMetrica.set('venta'); this.bComp.set('gte');
    this.bUmbral.set(null); this.bGate.set(null); this.bMonto.set(null); this.bActivo.set(true);
    this.bonoAbierto.set(true);
  }

  abrirBonoEdicion(b: BonoRD): void {
    this.bonoEditando.set(b); this.bonoErr.set(null);
    this.bNombre.set(b.nombre);
    this.bBenef.set(b.beneficiario === 'supervisor' ? 'supervisor' : 'chofer');
    this.bPeriodo.set(b.periodo === 'mes' ? 'mes' : 'quincena');
    this.bRuta.set(b.route_code); this.bMetrica.set(b.metrica);
    this.bComp.set(b.comparador === 'gt' ? 'gt' : 'gte');
    this.bUmbral.set(Number(b.umbral));
    this.bGate.set(b.gate_venta_min == null ? null : Number(b.gate_venta_min));
    this.bMonto.set(Number(b.monto)); this.bActivo.set(b.activo);
    this.bonoAbierto.set(true);
  }

  guardarBono(): void {
    // Idempotencia visual: se bloquea en el primer clic, antes de esperar respuesta.
    if (this.bonoGuardando() || !this.bonoOk()) return;
    this.bonoGuardando.set(true);
    this.bonoErr.set(null);
    const listo = (nombre: string) => {
      this.bonoGuardando.set(false);
      this.bonoAbierto.set(false);
      this.toast.add({ severity: 'success', summary: 'Bono guardado', detail: nombre });
      this.cargarBonos();
    };
    const falla = (e: any) => {
      this.bonoGuardando.set(false);
      this.bonoErr.set(e?.error?.message ?? 'No se pudo guardar el bono.');
    };
    const comun = {
      nombre: this.bNombre().trim(), metrica: this.bMetrica(), comparador: this.bComp(),
      umbral: Number(this.bUmbral()), monto: Number(this.bMonto()),
      periodo: this.bPeriodo(),
      route_code: this.bRuta()?.trim() || null,
      gate_venta_min: this.bGate() == null ? null : Number(this.bGate()),
    };
    const edit = this.bonoEditando();
    if (!edit) {
      this.api.commissionBonoAlta({ ...comun, beneficiario: this.bBenef() })
        .subscribe({ next: (b) => listo(`${b.nombre} creado.`), error: falla });
      return;
    }
    this.api.commissionBonoEditar(edit.id, { ...comun, activo: this.bActivo() })
      .subscribe({ next: (b) => listo(`${b.nombre} actualizado.`), error: falla });
  }

  // ── [RD.86] El tabulador, con simulación obligatoria ───────────────────────────────────
  //
  // ⛔ Medido el 2026-10-20: `GET/POST /commissions/scales` existen desde `[RD.66]` y **ninguna
  // pantalla los consumía**. El número que decide el porcentaje de cada peso sólo se podía
  // cambiar por curl.
  //
  // ⭐⭐ **La regla de esta pestaña: no se puede estrenar sin simular antes.** No es fricción
  // decorativa — el tabulador es un acantilado (debajo del primer escalón `pickTier()` devuelve
  // `null` y la comisión es $0), así que mover el piso no baja un pago: **lo apaga**. Hoy hay
  // 9 ruta-periodo del contraste del lado malo, por $26,932.74.

  readonly escalas = signal<EscalasRD | null>(null);
  readonly borrador = signal<TierRD[]>([]);
  readonly simulacion = signal<SimulacionEscalaRD | null>(null);
  readonly simulando = signal(false);
  readonly estrenando = signal(false);
  readonly tabErr = signal<string | null>(null);
  readonly desdeTabulador = signal<string | null>(null);
  /** `[RD.100]` La parte del supervisor para la versión nueva; `null` = la de la vigente. */
  readonly pctSupBorrador = signal<number | null>(null);
  readonly pctSupVigente = computed<number | null>(() => {
    const v = this.escalas()?.escalas.find((e) => e.vigente);
    return v ? Number(v.share_supervisor_pct) : null;
  });

  /** La escala nueva no puede empezar antes de lo ya pagado. El servidor lo exige igual. */
  readonly minTabulador = computed(() => {
    const piso = this.escalas()?.piso_editable;
    if (!piso) return undefined;
    const d = new Date(`${piso.slice(0, 10)}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });

  /**
   * ⛔ Los escalones tienen que **tocarse exactamente**: una venta que cayera en un hueco no
   * cobraría nada. El servidor lo rechaza, pero decirlo recién al guardar es reportar el error
   * en vez de prevenirlo (poka-yoke, §10). Se valida mientras se escribe.
   */
  readonly huecoTabulador = computed<string | null>(() => {
    const t = this.borrador();
    if (!t.length) return 'Un tabulador sin escalones paga $0 a todos.';
    for (let i = 0; i < t.length; i++) {
      const min = Number(t[i].min_amount);
      const max = t[i].max_amount === null ? null : Number(t[i].max_amount);
      if (!Number.isFinite(min)) return `El escalón ${i + 1} no tiene desde.`;
      if (!Number.isFinite(Number(t[i].pct))) return `El escalón ${i + 1} no tiene porcentaje.`;
      const ultimo = i === t.length - 1;
      if (ultimo && max !== null) {
        return 'El último escalón no lleva techo: una venta arriba de él no cobraría nada.';
      }
      if (!ultimo) {
        if (max === null) return `El escalón ${i + 1} necesita un hasta.`;
        if (max <= min) return `El escalón ${i + 1} termina antes de empezar.`;
        if (Number(t[i + 1].min_amount) !== max) {
          return `Hueco entre el escalón ${i + 1} y el ${i + 2}: uno termina en ${max} y el `
            + `siguiente empieza en ${t[i + 1].min_amount}. Una venta en medio no cobraría nada.`;
        }
      }
    }
    return null;
  });

  cargarEscalas(): void {
    this.api.commissionScales().subscribe({
      next: (e) => { this.escalas.set(e); this.restaurarTabulador(); },
      error: (err) => this.tabErr.set(
        err?.error?.message ?? 'No se pudo leer el tabulador. No es que no haya: no se pudo leer.'),
    });
  }

  /** Vuelve al tabulador vigente. Descartar también borra la simulación: era de otro borrador. */
  /** `[AUD-CM.3]` Un bono con importe 0 no paga, esté o no encendido. */
  pagaAlgo(b: { monto: string | number }): boolean { return Number(b.monto) > 0; }

  /** `[AUD-CM.13]` «Descartar cambios» sólo cuando hay cambios contra la versión vigente. */
  readonly tabuladorSinCambios = computed(() => {
    const vigente = this.escalas()?.escalas.find((e) => e.vigente) ?? this.escalas()?.escalas[0];
    const base = (vigente?.tiers ?? []).map((t) => [Number(t.min_amount), t.max_amount === null ? null : Number(t.max_amount), Number(t.pct)]);
    return JSON.stringify(base) === JSON.stringify(this.borrador().map((t) => [t.min_amount, t.max_amount, t.pct]));
  });

  restaurarTabulador(): void {
    const vigente = this.escalas()?.escalas.find((e) => e.vigente)
      ?? this.escalas()?.escalas[0];
    this.borrador.set((vigente?.tiers ?? []).map((t) => ({
      min_amount: Number(t.min_amount),
      max_amount: t.max_amount === null ? null : Number(t.max_amount),
      pct: Number(t.pct),
    })));
    this.simulacion.set(null);
    this.tabErr.set(null);
  }

  setTier(i: number, campo: keyof TierRD, valor: unknown): void {
    const t = [...this.borrador()];
    const n = valor === '' || valor === null ? null : Number(valor);
    t[i] = { ...t[i], [campo]: campo === 'max_amount' ? n : (n ?? 0) };
    this.borrador.set(t);
    // ⚠️ Tocar el borrador INVALIDA la simulación: dejarla en pantalla haría estrenar una
    // versión mirando los números de otra. Es el mismo defecto que un delta sin su base.
    this.simulacion.set(null);
  }

  agregarTier(): void {
    const t = [...this.borrador()];
    const ultimo = t[t.length - 1];
    if (ultimo) {
      // El que era último pierde su «sin techo», que pasa al nuevo: si no, quedan dos abiertos.
      const corte = Number(ultimo.min_amount) + 1;
      t[t.length - 1] = { ...ultimo, max_amount: corte };
      t.push({ min_amount: corte, max_amount: null, pct: Number(ultimo.pct) });
    } else {
      t.push({ min_amount: 0, max_amount: null, pct: 0 });
    }
    this.borrador.set(t);
    this.simulacion.set(null);
  }

  quitarTier(i: number): void {
    const t = this.borrador().filter((_, j) => j !== i);
    // El nuevo último se queda sin techo, o el tabulador tendría un tope por donde se escapa.
    if (t.length) t[t.length - 1] = { ...t[t.length - 1], max_amount: null };
    this.borrador.set(t);
    this.simulacion.set(null);
  }

  simularTabulador(): void {
    if (this.simulando() || this.huecoTabulador()) return;
    this.simulando.set(true);
    this.tabErr.set(null);
    this.api.commissionScaleSimular(this.borrador()).subscribe({
      next: (s) => { this.simulando.set(false); this.simulacion.set(s); },
      error: (e) => {
        this.simulando.set(false);
        this.tabErr.set(e?.error?.message ?? 'No se pudo simular.');
      },
    });
  }

  confirmarEstreno(): void {
    const s = this.simulacion();
    const desde = this.desdeTabulador();
    if (!s || !desde || this.estrenando()) return;
    // ⭐ El mensaje dice el daño en pesos y en personas, no «¿estás seguro?». Von Restorff: la
    // confirmación de un acto que mueve nómina tiene que nombrar lo que mueve.
    const caen = s.caen
      ? ` ${s.caen} ruta(s) se quedan SIN ESCALÓN, o sea cobran $0.` : '';
    // `[RD.100]` Si cambia la parte del supervisor, se nombra: mueve el depósito de los dos.
    const ps = this.pctSupBorrador();
    const cambiaSup = ps !== null && ps !== this.pctSupVigente()
      ? ` La parte del supervisor pasa de ${this.pctSupVigente()} % a ${ps} %.` : '';
    this.confirm.confirm({
      header: 'Estrenar el tabulador',
      message: `Rige desde el ${this.dia(desde)} y la versión actual se cierra ese día. `
        + `Sobre Q${s.base.period_no} habría significado ${this.money(s.delta)}.${caen}${cambiaSup} `
        + 'Lo ya pagado no se recalcula. Los bonos se heredan a la versión nueva.',
      acceptLabel: 'Estrenar', rejectLabel: 'Cancelar',
      accept: () => this.estrenar(desde),
    });
  }

  private estrenar(desde: string): void {
    this.estrenando.set(true);
    this.tabErr.set(null);
    const ps = this.pctSupBorrador();
    this.api.commissionScaleEstrenar({
      valid_from: desde, tiers: this.borrador(),
      ...(ps !== null ? { share_supervisor_pct: ps } : {}),
    }).subscribe({
      next: (r) => {
        this.estrenando.set(false);
        this.simulacion.set(null);
        this.pctSupBorrador.set(null);
        // ⚠️ `bonos_heredados` se DICE, y un 0 no se dibuja como éxito: significa que la escala
        // nueva no paga ningún bono. Es `[RD.85.0]`, y quien la estrena tiene que verlo ahora,
        // no cuando llegue la quincena.
        this.toast.add({
          severity: r.bonos_heredados ? 'success' : 'warn',
          summary: 'Tabulador estrenado',
          detail: `${r.escalones} escalón(es) desde el ${this.dia(r.valid_from)} · `
            + (r.bonos_heredados
              ? `${r.bonos_heredados} bono(s) heredado(s).`
              : 'SIN BONOS: esta versión no paga ninguno. Revisá la pestaña Bonos.'),
          life: r.bonos_heredados ? 5000 : 12000,
        });
        this.cargarEscalas();
        this.cargarBonos();
      },
      error: (e) => {
        this.estrenando.set(false);
        this.tabErr.set(e?.error?.message ?? 'No se pudo estrenar el tabulador.');
      },
    });
  }

  diasCortos(l: CommissionLine): boolean {
    return l.dias_con_venta != null && l.dias_esperados != null && l.dias_con_venta < l.dias_esperados;
  }

  tipDias(l: CommissionLine): string {
    if (l.dias_con_venta == null) return 'Esta ruta no tuvo fuente en el periodo.';
    const esp = l.dias_esperados;
    if (esp == null) return `${l.dias_con_venta} día(s) con venta.`;
    if (l.dias_con_venta >= esp) return `${l.dias_con_venta} días, los mismos que sus hermanas de plaza.`;
    return `${l.dias_con_venta} días contra los ${esp} que trabajaron sus hermanas de plaza. `
      + 'Puede ser que el camión no salió, o que la fuente perdió el día: el motor no los distingue, '
      + 'porque la fuente es el único testigo de las dos cosas.';
  }

  etiquetaEstado(p: CommissionBoardRow): string {
    if (p.estado_calculo === 'futura') return 'no empieza';
    if (p.estado_calculo === 'en_curso') return 'en curso';
    if (p.estado_calculo === 'sin_calcular') return 'sin calcular';
    const M: Record<string, string> = {
      en_curso: 'en curso', borrador: 'borrador', bloqueada: 'bloqueada',
      aprobado: 'aprobada', pagado: 'pagada',
    };
    return p.status ? (M[p.status] ?? p.status) : 'sin corrida';
  }

  sev(p: CommissionBoardRow): 'success' | 'warn' | 'danger' | 'secondary' | 'info' {
    // Ámbar, no gris: cerró y nadie la calculó. Es lo único de este tablero que pide acción.
    if (p.estado_calculo === 'sin_calcular') return 'warn';
    if (p.status === 'pagado') return 'success';
    if (p.status === 'aprobado') return 'info';
    if (p.status === 'bloqueada') return 'danger';
    return 'secondary';
  }

  etiquetaGate(g: string): string {
    const M: Record<string, string> = {
      periodo_cerrado: 'La quincena no cerró',
      corte_de_sistema: 'Cruza un cambio de sistema',
      cobertura: 'Cobertura',
      frescura: 'El dato no llegó completo',
      bono_arbitrado: 'Bono sobre costo no arbitrado',
      // [RD.92] Faltaba: Q21 pintaba «cobertura_dias», el nombre de la compuerta en la base.
      cobertura_dias: 'Menos días que su plaza',
      deduccion_configurada: 'Deducción sin cargar',
    };
    return M[g] ?? g;
  }

  etiquetaVeredicto(v: string | null): string {
    const M: Record<string, string> = {
      bajo_umbral: 'bajo umbral',
      sin_dato_en_la_fuente: 'sin dato en la fuente',
      fuera_no_es_camion: 'no es ruta de camión',
      camion_sin_config: 'camión sin configurar',
      camion_sin_identidad: 'sin embarque documentado',
      config_inactiva: 'configuración inactiva',
      tipo_sin_declarar: 'tipo de ruta sin declarar',
    };
    return v ? (M[v] ?? v) : '';
  }

  etiquetaCosto(v: string): string {
    const M: Record<string, string> = {
      sin_costo: 'sin costo',
      solo_wincaja_reexpresado: 'costo inestable',
      una_fuente_embarque: 'costo de una fuente',
      una_fuente_erp: 'costo de una fuente',
      una_fuente: 'costo de una fuente',
    };
    return M[v] ?? v;
  }

  tipCosto(v: string): string {
    if (v === 'sin_costo') return 'No hay costo en la fuente para estos días: el markup no se puede medir y el bono del supervisor no paga.';
    if (v === 'solo_wincaja_reexpresado') return 'El único costo disponible es el que Wincaja re-expresa cada noche: el markup de un mes cerrado cambia solo.';
    return 'El markup descansa en una sola fuente de costo, sin un segundo testigo que lo arbitre.';
  }

  tipMarkup(l: CommissionLine): string {
    const p: string[] = ['Markup sobre costo = (subtotal / costo − 1) × 100. NO es margen sobre venta.'];
    if (l.margen_sobre_venta_pct != null) p.push(`Margen sobre venta: ${this.pct(l.margen_sobre_venta_pct)}%`);
    if (l.cogs_ruta != null) p.push(`Costo del embarque: ${this.money(l.cogs_ruta)}`);
    if (l.cogs_erp != null) p.push(`Costo del ERP (c62): ${this.money(l.cogs_erp)}`);
    return p.join(' · ');
  }

  bonosTip(l: CommissionLine): string {
    if (!l.bonos_detalle?.length) return '';
    return l.bonos_detalle.map((b) => `${b.nombre}: ${this.money(b.monto)} (${b.metrica} > ${b.umbral})`).join(' · ');
  }

  pct(n: number | null | undefined): string {
    if (n == null) return '—';
    return String(Math.round(Number(n) * 1000) / 1000);
  }

  money(n: number | string | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(Number(n));
  }
}
