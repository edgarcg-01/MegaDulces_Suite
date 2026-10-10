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
  PendienteProveedor, PendientesResp,
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
 * ── ⛔ Qué NO hace esta pantalla ────────────────────────────────────────────────────────────
 * **No entrega.** `contpaqi.poliza_exports` está vacía porque nunca se importó un archivo a
 * ContPAQi (`[CP.8.24]`). Un botón de entregar sería ofrecer un camino que nadie recorrió, así
 * que no existe — y `FISCAL_CONTPAQI_BRIDGE_GESTIONAR` ya está repartido para el día que lo haya.
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
                    appendTo="body" styleClass="cpp-sel" [style]="{ minWidth: '10rem' }"
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
                  <span class="mono">{{ pendientes() | number }}</span> son trabajo de alguien &middot;
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
              } @else {
                <div class="cpp-eyebrow">Lote</div>
                <h4>Eleg&iacute; un lote</h4>
                <div class="cpp-note">La lista de la izquierda muestra un rengl&oacute;n por (banco &times; d&iacute;a).</div>
              }
            </aside>
          </div>
        </section>

        <!-- ── [CP.8.37] LO QUE FALTA ENLAZAR: el rechazo con su acción al lado ── -->
        @if (pendientes(); as p) {
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

    /* [CP.8.37] confirmar el alias */
    .cpp-nota-dura { margin: 0 0 .8rem; padding-left: .8rem; border-left: 2px solid var(--c-warn);
      color: var(--c-text-2); font-size: var(--fs-sm); max-width: 78ch; }
    .cpp-sug { display: flex; align-items: center; gap: .5rem; padding: 3px 0; cursor: pointer;
      font-size: var(--fs-sm); flex-wrap: wrap; }
    .cpp-sug input { accent-color: var(--action); flex: 0 0 auto; }
    .cpp-sug > span:nth-child(3) { color: var(--c-text-2); }
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
  readonly pendientes = signal<PendientesResp | null>(null);
  /** alias → cuenta elegida en la pantalla. ⛔ Nada se preselecciona: elegir es del humano. */
  readonly elegido = signal<Record<string, string>>({});
  readonly guardando = signal<string | null>(null);
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
      .map((l) => ({ ...l, k: `${l.cuenta_banco}|${l.fecha}` }));
  });

  readonly deNadie = computed(() => contarDeNadie(this.data()?.motivos ?? []));

  readonly pendientes = computed(() => (this.data()?.resumen.movimientos ?? 0) - this.deNadie());

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
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
      .subscribe({ next: (p) => this.pendientes.set(p), error: () => this.pendientes.set(null) });
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
};

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
