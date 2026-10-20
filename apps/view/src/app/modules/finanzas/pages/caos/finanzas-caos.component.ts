import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { money, dmy } from '../finanzas-format';
import { MX_TZ, todayMx, toMxDateKey } from '../../../../core/utils/mx-date';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import { CaosService, type CaosMovimiento, type CaosKpi, type CaosDenominacion, type CaosPorRuta, type CaosPorOperador, type CaosConciliacion, type CaosIngresosEstado, type CaosTipo, type CaosSaldo, type CaosTipoEfecto } from '../../caos.service';
import { CaosSocketService } from '../../caos-socket.service';

/**
 * CS.2 — Reporte de movimientos de la caja fuerte CAOS (sistema externo, ADR Fase CS).
 *
 * Sólo lectura del espejo `analytics.caos_cash_movements`. Depósitos (entra efectivo) y
 * dispensaciones (sale), por denominación, por usuario, con su referencia. Se pone al día solo por
 * WS (`/caos`) + un repaso lento de red de seguridad, igual que Caja General (CG.23.2).
 *
 * ── `[CG.163]` Lo que la auditoría del 2026-10-15 cambió acá ────────────────────────────────
 *
 *  · ⛔ **Los paneles plegados ya no consultan al entrar.** `cargar()` disparaba las TRES
 *    consultas —movimientos, resumen y cuadre— en cada carga, en cada aviso del WS y en cada
 *    repaso de 60 s, con los `<details>` cerrados. El cuadre tarda **800–950 ms** y toca ~535 MB
 *    de buffers (`analytics.kepler_bank_movements` es una vista sin índices sobre el ODS). Ahora
 *    cada panel carga **al abrirse**, como ya hacía el de atribución (`[CG.58.2]`), y el repaso
 *    sólo refresca lo que está a la vista. La pantalla abre en los **8 ms** de `/movimientos`.
 *
 *  · ⛔ **Un 500 ya no se pinta como «no hubo nada».** Los dos paneles hacían
 *    `error: () => this.resumen.set(null)` y quedaban con los encabezados y cero filas —
 *    indistinguible de un rango sin movimientos. Así estuvo **oculto en producción** el 500 de
 *    `[CG.161]`. Cada panel declara ahora su propio fallo con un reintento (ADR-056).
 */
interface FilaUI extends CaosMovimiento { denom?: CaosDenominacion[]; denomTotal?: number | null }

@Component({
  selector: 'app-finanzas-caos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputTextModule, SelectModule, TableModule, TagModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent, ContextHelpComponent,
    CajaTabsComponent],
  template: `
    <!-- [CG.121] Captura / Expediente / Caja Fuerte son UN area, no tres reportes sueltos. -->
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja Fuerte (CAOS)</h1>
          <p class="surf-page-sub">
            Movimientos de efectivo del dispositivo de caja fuerte — depósitos y dispensaciones por
            denominación. Sólo lectura.
          </p>
        </div>
        <!-- DESIGN §P — la jerga de esta pantalla va al diccionario versionado, no redactada
             acá: «sin respaldo», «grano» y «cobertura» se leyeron al revés en la auditoría. -->
        <app-context-help topic="caja-fuerte" />
        <!-- DESIGN §9 — la edad del DATO, no la de la carga: datos_al es max(synced_at) del
             servidor, así que mide el espejo de CAOS y no cuándo se abrió la pantalla. -->
        <app-freshness-pill measures="data" [since]="kpi()?.datos_al ?? null" [staleAfterSec]="3600"
                            label="caja fuerte"></app-freshness-pill>
      </header>

      <!-- [CGA-A.33] DESIGN Q.1 answer-first: la pregunta de esta pantalla es cuanto hay en la
           caja fuerte, y no depende del rango de abajo. Tres testigos SEPARADOS: lo que dice la
           maquina, si eso cuadra con sus movimientos, y el conteo fisico (que hoy no existe). -->
      <section class="cs-saldo" aria-labelledby="cs-saldo-h">
        <h2 id="cs-saldo-h" class="cs-h2">¿Cuánto hay en la caja fuerte?</h2>
        <app-load-state [loading]="saldoCargando() && !saldoResp()" [error]="saldoError()" [isEmpty]="false"
                        [skeletonRows]="2" errorTitle="No se pudo leer el saldo de la caja fuerte"
                        (retry)="cargarSaldo()">
          <app-metric-strip [items]="saldoKpis()" ariaLabel="Saldo de la caja fuerte"></app-metric-strip>
          @if (saldoResp(); as s) {
            @if (s.saldo; as sd) {
              <table class="cs-tbl cs-mini cs-denoms">
                <caption class="sr-only">Billetes en la caja fuerte por denominación</caption>
                <thead><tr>
                  <th scope="col">Denominación</th>
                  <th scope="col" class="cs-r">Billetes</th>
                  <th scope="col" class="cs-r">Importe</th>
                  <th scope="col">Casetes</th>
                </tr></thead>
                <tbody>
                  @for (d of sd.por_denominacion; track d.denom) {
                    <tr>
                      <td class="mono">{{ money(d.denom) }}</td>
                      <td class="cs-r mono">{{ d.billetes }}</td>
                      <td class="cs-r mono">{{ money(d.importe) }}</td>
                      <td class="fin-dim">{{ casetesDe(d.denom) }}</td>
                    </tr>
                  }
                </tbody>
                <tfoot><tr>
                  <td>Total</td><td></td>
                  <td class="cs-r mono">{{ money(sd.total) }}</td><td></td>
                </tr></tfoot>
              </table>
            }
            @if (s.cuadre?.descuadres?.length) {
              <div class="cs-err cs-hallazgos" role="status">
                <strong>La máquina cambió sin un movimiento que lo explique:</strong>
                <ul>
                  @for (p of s.cuadre!.descuadres; track p.desde_id + '-' + p.hasta_id) {
                    <li>
                      entre el movimiento #{{ p.desde_id }} y el #{{ p.hasta_id }}
                      ({{ horaMx(p.desde_at) }} → {{ horaMx(p.hasta_at) }}):
                      <span class="mono">{{ money(p.diferencia) }}</span> —
                      @for (x of p.por_denominacion; track x.denom) {
                        <span class="mono">{{ x.diferencia > 0 ? '+' : '' }}{{ x.diferencia }} × {{ money(x.denom) }}</span>{{ $last ? '' : ', ' }}
                      }
                    </li>
                  }
                </ul>
              </div>
            }
            @if (s.cuadre?.no_verificables?.length) {
              <p class="fin-dim cs-nota">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                {{ s.cuadre!.no_verificables.length }} tramo(s) no se pueden verificar porque llevan un
                movimiento sin decodificar: {{ s.cuadre!.no_verificables[0].motivo }}
              </p>
            }
            <!-- [CG.162] el latido de quien toma la foto va con las cifras: si falla, la foto se
                 queda vieja y el numero de arriba deja de ser de hoy. -->
            <p class="cs-latido" [class.cs-latido-mal]="s.latido?.status === 'error' || !s.latido">
              <i class="pi pi-camera" aria-hidden="true"></i>
              @if (s.latido; as l) {
                Foto del contenido: última lectura <span class="mono">{{ l.cuando }}</span>
                @if (l.error) { — <strong class="cs-err-inline">falla: {{ l.error }}</strong> }
                @else if (l.nota) { · {{ l.nota }} }
              } @else {
                <span class="cs-err-inline">la suite todavía no lee el contenido de la máquina.</span>
              }
            </p>
          }
        </app-load-state>
      </section>

      <!-- Filtros -->
      <div class="fin-form fin-filtros">
        <div class="fin-row">
          <label for="cs-from">Desde</label>
          <input pInputText id="cs-from" type="date" [(ngModel)]="from" (change)="cargar()" />
          <label for="cs-to">Hasta</label>
          <input pInputText id="cs-to" type="date" [(ngModel)]="to" (change)="cargar()" />
          <label for="cs-tipo">Tipo</label>
          <!-- [CG.163] Las opciones salen de lo que la ventana TIENE, no de una lista a mano:
               estaba escrita con 4 tipos y en prod hay 7. -->
          <p-select inputId="cs-tipo" [options]="tiposOpc()" [(ngModel)]="tipo" optionLabel="label" optionValue="value"
                    (ngModelChange)="cargar()" [ariaLabel]="'Tipo de movimiento'"></p-select>
        </div>
        <div class="fin-row">
          <label for="cs-user">Usuario</label>
          <input pInputText id="cs-user" [(ngModel)]="usuario" (keyup.enter)="cargar()" placeholder="Nombre del operador" />
          <label for="cs-ref">Referencia</label>
          <input pInputText id="cs-ref" [(ngModel)]="ref" (keyup.enter)="cargar()" placeholder="ruta / pagos / …" />
          <p-button label="Buscar" icon="pi pi-search" size="small" (onClick)="cargar()"></p-button>
        </div>
      </div>

      <!-- KPIs: sin medir NO es cero (ADR-056) -->
      <app-metric-strip [items]="kpis()" ariaLabel="Resumen de la caja fuerte"></app-metric-strip>

      <!-- CS.4 — cuadre de total de control contra la Caja General de Kepler -->
      <details class="cs-resumen" (toggle)="alAbrirCuadre($event)">
        <summary>¿Cuadra contra la Caja General? (total de control)</summary>
        <p class="fin-dim cs-nota">
          <i class="pi pi-clock" aria-hidden="true"></i>
          Este cuadre recorre el contable de Kepler y tarda cerca de <strong>1 s</strong>: por eso
          se pide al abrir el panel y no al entrar a la pantalla.
        </p>
        @if (concError(); as msg) {
          <p class="cs-err">
            {{ msg }}
            <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarCuadre()"></p-button>
          </p>
        } @else if (conc(); as k) {
          <p class="fin-dim cs-nota">
            Por CAOS pasa <strong>{{ pct(k.cobertura.depositos) }}</strong>
            del efectivo que entra a la Caja General y <strong>{{ pct(k.cobertura.dispensado) }}</strong>
            del que sale. NO es un cuadre 1:1 — CAOS es el efectivo que pasa por la máquina; el resto
            de la caja se maneja fuera. Es informativo, no un veredicto (el feed de CAOS es más fresco
            que el contable, así que el último día puede verse descuadrado por rezago, no por error).
          </p>
          <table class="cs-tbl cs-mini">
            <thead><tr>
              <th scope="col">Día</th>
              <th scope="col" class="cs-r">CAOS depósitos</th><th scope="col" class="cs-r">Kepler ingresos</th>
              <th scope="col" class="cs-r">CAOS dispensado</th><th scope="col" class="cs-r">Kepler egresos</th>
            </tr></thead>
            <tbody>
              @for (d of k.dias; track d.dia) {
                <tr>
                  <td class="mono">{{ d.dia }}</td>
                  <td class="cs-r mono">{{ money(d.caos_dep) }}</td>
                  <td class="cs-r mono fin-dim">{{ money(d.kepler_ing) }}</td>
                  <td class="cs-r mono">{{ money(d.caos_dis) }}</td>
                  <td class="cs-r mono fin-dim">{{ money(d.kepler_egr) }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="fin-dim">Cargando el cuadre…</p>
        }
      </details>

      <!-- [CG.58.2] — el conciliador de ingresos existía, estaba desplegado y NO tenía invocador:
           ni botón, ni cron, ni enganche al arqueo. Por eso la atribución estaba en cero. -->
      <details class="cs-resumen" (toggle)="alAbrirIngresos($event)">
        <summary>¿De qué cobros es este efectivo? (atribución)</summary>
        <p class="fin-dim cs-nota">
          Ata cada depósito de la caja fuerte a los cobros de Kepler que lo explican, consumiendo
          del más viejo al más nuevo y sin reusar ninguno. Los tres montos van <strong>separados a
          propósito</strong>: «sin respaldo» es un depósito que ningún cobro anterior explica, y
          «sin depositar» es efectivo cobrado que todavía no entró al equipo. No son lo mismo y los
          arregla gente distinta.
        </p>
        @if (ingEstado(); as e) {
          <!-- ⛔ [CG.162] El latido va ARRIBA de las cifras, no debajo: cuando el carril está en
               error estas cuatro filas describen un reparto que no ocurrió, y leerlas primero fue
               exactamente cómo $18.5 M se publicaron como «sin respaldo» durante horas. -->
          <p class="cs-latido" [class.cs-latido-mal]="latido()?.status === 'error' || !latido()">
            <i class="pi pi-sync" aria-hidden="true"></i>
            Se actualiza <strong>sola, cada hora</strong> desde {{ e.desde }}.
            @if (latido(); as l) {
              Última corrida <span class="mono">{{ l.cuando }}</span>
              @if (l.error) {
                — <strong class="cs-err-inline">el carril está fallando: {{ l.error }}</strong>
                Mientras esto siga en rojo, las cifras de abajo <strong>no describen un reparto</strong>.
              } @else { · {{ l.nota }} }
            } @else {
              <span class="cs-err-inline">todavía no hay ninguna corrida registrada.</span>
            }
          </p>
          <table class="cs-tbl cs-mini">
            <tbody>
              <tr><td>Depositado en la caja fuerte</td>
                  <td class="cs-r mono">{{ money(e.monto_depositado) }}</td>
                  <td class="cs-r fin-dim">{{ e.depositos }} depósitos</td></tr>
              <tr><td>Ya atribuido a cobros</td>
                  <td class="cs-r mono">{{ money(e.monto_conciliado) }}</td>
                  <td class="cs-r fin-dim">{{ e.conciliados }} depósitos</td></tr>
              <tr><td>Sin respaldo (ningún cobro lo explica)</td>
                  <td class="cs-r mono">{{ money(e.monto_pendiente) }}</td>
                  <td class="cs-r fin-dim">{{ e.pendientes }} depósitos</td></tr>
              <tr><td>Cobrado en efectivo y <strong>no</strong> depositado</td>
                  <td class="cs-r mono">{{ money(e.monto_sin_depositar) }}</td>
                  <td class="cs-r fin-dim">no entró al equipo</td></tr>
            </tbody>
          </table>
          @if (ingError(); as msg) { <p class="cs-err">{{ msg }}</p> }
        } @else if (ingError(); as msg) {
          <p class="cs-err">
            {{ msg }}
            <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarIngEstado()"></p-button>
          </p>
        } @else {
          <p class="fin-dim">Cargando la atribución…</p>
        }
      </details>

      <!-- CS.6/CS.7 — resumen interno de CAOS (no cruza contra nada) -->
      <details class="cs-resumen" (toggle)="alAbrirResumen($event)">
        <summary>Resumen por operador y ruta</summary>
        @if (resumenError(); as msg) {
          <p class="cs-err">
            {{ msg }}
            <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarResumen()"></p-button>
          </p>
        } @else if (resumen(); as r) {
          <div class="cs-resumen-grid">
            <div>
              <h3 class="cs-h3">Por operador</h3>
              <table class="cs-tbl cs-mini">
                <thead><tr><th scope="col">Operador</th><th scope="col" class="cs-r">Depósitos</th><th scope="col" class="cs-r">Dispensado</th></tr></thead>
                <tbody>
                  @for (o of r.porOperador; track o.user_external) {
                    <tr>
                      <td>{{ o.user_external || '—' }}</td>
                      <td class="cs-r mono">{{ money(o.depositos_total) }} <span class="fin-dim">({{ o.depositos_n }})</span></td>
                      <td class="cs-r mono">{{ money(o.dispensado_total) }} <span class="fin-dim">({{ o.dispensado_n }})</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <div>
              <h3 class="cs-h3">Por ruta <span class="fin-dim">(grano declarado del depósito)</span></h3>
              <p class="fin-dim cs-nota">
                El operador escribe la referencia a mano. Cada depósito se atribuye al
                <strong>grano que su texto aguanta</strong> — ruta y día, sólo ruta, o sólo plaza —
                y lo que no declara nada se dice. No se inventa una ruta: una ruta inventada le
                cobra el depósito a un camión que no fue.
              </p>
              <table class="cs-tbl cs-mini">
                <thead><tr><th scope="col">Atribuido a</th><th scope="col">Grano</th><th scope="col" class="cs-r">Depósitos</th><th scope="col" class="cs-r">Total</th></tr></thead>
                <tbody>
                  @for (g of r.porRuta; track g.grano + '|' + (g.ruta ?? '') + '|' + (g.plaza ?? '') + '|' + g.motivo) {
                    <tr>
                      <td [attr.title]="g.motivo">{{ etiquetaGrano(g) }}</td>
                      <td><span class="cs-grano" [class.cs-grano-flojo]="g.grano !== 'ruta_dia' && g.grano !== 'ruta'">{{ g.grano }}</span></td>
                      <td class="cs-r mono">{{ g.movimientos }}</td>
                      <td class="cs-r mono">{{ money(g.total) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        } @else {
          <p class="fin-dim">Cargando el resumen…</p>
        }
      </details>

      <!-- Tabla -->
      <app-load-state [loading]="cargando()" [error]="err()" [isEmpty]="!cargando() && !err() && rows().length === 0"
                      emptyIcon="pi-lock" emptyTitle="Sin movimientos en el rango"
                      emptyHint="La caja fuerte no registró depósitos ni dispensaciones en estas fechas."
                      (retry)="cargar()">
        <!-- DESIGN O.4/D.7 — rejilla en p-table: sin ella no hay recorrido con teclado ni
             encabezado fijo, y el detalle por denominación se abría con un botón suelto. -->
        <!-- [CG.127] Paginada: son los movimientos del dispositivo, y el rango lo elige quien
             consulta. Sin paginador la unica forma de llegar al final es la rueda. -->
        <p-table [value]="rows()" dataKey="id" [expandedRowKeys]="expandidas"
                 (onRowExpand)="alExpandir($event.data)"
                 size="small" class="cs-grid surf-table--sticky"
                 [scrollable]="true" scrollHeight="flex"
                 [paginator]="rows().length > 25" [rows]="25"
                 [rowsPerPageOptions]="[25, 50, 100]"
                 [showCurrentPageReport]="true"
                 currentPageReportTemplate="{first}–{last} de {totalRecords}">
          <ng-template #caption>
            <span class="sr-only">Movimientos de la caja fuerte CAOS</span>
          </ng-template>
          <ng-template #header>
            <tr>
              <th scope="col" style="width:2.5rem"><span class="sr-only">Denominaciones</span></th>
              <th scope="col" style="width:6rem">#</th>
              <th scope="col" style="width:9rem">Fecha</th>
              <th scope="col" style="width:7rem">Contable</th>
              <th scope="col">Usuario</th>
              <th scope="col" style="width:10rem">Tipo</th>
              <th scope="col" class="cs-r" style="width:9rem">Total</th>
              <th scope="col">Referencia</th>
            </tr>
          </ng-template>
          <ng-template #body let-r let-expanded="expanded">
            <!-- Sin pSelectableRow: sin selectionMode no hace nada, y el recorrido con
                 teclado lo da el botón de cada fila (mismo criterio que almacen-movimientos). -->
            <tr>
              <td>
                <!-- DESIGN D.7 — botón NATIVO: recibe foco, responde a Enter y Espacio sin
                     cablear nada, y el lector de pantalla anuncia si la fila está abierta. -->
                <button type="button" class="cs-toggle" [pRowToggler]="r"
                        [attr.aria-expanded]="expanded"
                        [attr.aria-label]="'Ver denominaciones del movimiento ' + r.external_id">
                  <i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i>
                </button>
              </td>
              <td class="mono">{{ r.external_id }}</td>
              <td class="mono">{{ dmy(r.occurred_at) }}</td>
              <td class="mono">{{ r.accounting_date || '—' }}</td>
              <td>{{ r.user_external || '—' }}</td>
              <!-- [CGA-A.33] el color dice la DIRECCION (entra / sale / foto / sin decodificar) con el
                   mismo mapa que suma el neto; el motivo queda en el title. -->
              <td [attr.title]="efectoDe(r.type_id)?.motivo ?? null"><p-tag [value]="r.type_label" [severity]="sev(r.type_id)"></p-tag></td>
              <td class="mono cs-r">{{ money(r.total) }}</td>
              <td>{{ r.ref || '—' }}</td>
            </tr>
          </ng-template>
          <ng-template #expandedrow let-r>
            <tr class="cs-det">
              <td colspan="8">
                @if (r.denom && r.denom.length) {
                  <table class="cs-denom">
                    <thead><tr><th scope="col">Denominación</th><th scope="col">Pieza</th><th scope="col" class="cs-r">Piezas</th><th scope="col" class="cs-r">Importe</th></tr></thead>
                    <tbody>
                      @for (d of r.denom; track d.denom + '|' + d.pieza_tipo) {
                        <tr>
                          <td class="mono">{{ money(d.denom) }}</td>
                          <td class="fin-dim">{{ d.pieza_tipo === 'B' ? 'billete' : d.pieza_tipo }}</td>
                          <td class="mono cs-r">{{ d.quantity }}</td>
                          <td class="mono cs-r">{{ money(d.denom * d.quantity) }}</td>
                        </tr>
                      }
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colspan="3">Suma del desglose</td>
                        <td class="mono cs-r">{{ money(r.denomTotal) }}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <!-- ADR-056: la diferencia se DECLARA. Los dos números vienen del dispositivo y
                       no sabemos cuál miente, así que no se corrige ninguno — se muestra. -->
                  @if (descuadre(r); as dif) {
                    <p class="cs-err cs-descuadre">
                      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                      El desglose <strong>no suma el total</strong> del movimiento: declara
                      {{ money(r.total) }} y las denominaciones suman {{ money(r.denomTotal) }}
                      ({{ money(dif) }} de diferencia). Los dos datos vienen del dispositivo; no se
                      corrige ninguno.
                    </p>
                  }
                } @else if (r.denom) {
                  <span class="fin-dim">Sin desglose por denominación en este movimiento.</span>
                } @else {
                  <span class="fin-dim">Cargando denominaciones…</span>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
        @if (hasMore()) {
          <p class="fin-dim cs-rezago">La lista viene topada en {{ limite }} filas. Acota el rango para ver el resto.</p>
        }
      </app-load-state>
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    /* #9 — la consulta por contenedor necesita un contenedor declarado, o es inerte. */
    :host { display:block; min-width:0; container-type:inline-size; }
    .fin-filtros { gap:.5rem; margin-bottom:.75rem; }
    .cs-tbl { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .cs-tbl th { text-align:left; font-weight:600; color:var(--text-muted); padding:.35rem .5rem;
                 border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .cs-tbl td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color); vertical-align:top; }
    .cs-r { text-align:right; font-variant-numeric:tabular-nums; }
    .cs-grid .cs-r { text-align:right; font-variant-numeric:tabular-nums; }
    .cs-det td { background:color-mix(in srgb, var(--text-muted) 6%, var(--card-bg)); }
    .cs-denom { width:auto; border-collapse:collapse; font-size:var(--fs-xs); }
    .cs-denom th, .cs-denom td { padding:.15rem .75rem .15rem 0; text-align:left; }
    .cs-denom .cs-r { text-align:right; }
    .cs-denom tfoot td { border-top:1px solid var(--border-color); font-weight:600; }
    .cs-rezago { margin-top:.5rem; }
    .cs-toggle { display:inline-flex; align-items:center; justify-content:center; width:1.75rem;
                 height:1.75rem; padding:0; border:0; border-radius:var(--r-sm,6px);
                 background:transparent; color:var(--text-muted); cursor:pointer; }
    .cs-toggle:hover { background:color-mix(in srgb, var(--text-muted) 12%, transparent); }
    .cs-toggle:focus-visible { outline:2px solid var(--action); outline-offset:1px; }
    .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    .cs-resumen { margin:.75rem 0; border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:.5rem .75rem; }
    .cs-resumen > summary { cursor:pointer; font-size:var(--fs-sm); font-weight:600; }
    .cs-resumen-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(20rem, 1fr)); gap:1rem; margin-top:.6rem; }
    .cs-h3 { font-size:var(--fs-sm); margin:0 0 .3rem; }
    .cs-nota { font-size:var(--fs-xs); margin:0 0 .35rem; }
    .cs-mini { font-size:var(--fs-xs); }
    .cs-err { font-size:var(--fs-xs); color:var(--bad-fg); margin:.5rem 0 0; }
    .cs-err-inline { color:var(--bad-fg); }
    .cs-descuadre { max-width:46rem; }
    .cs-latido { font-size:var(--fs-xs); color:var(--text-muted); margin:.2rem 0 .5rem; }
    .cs-latido-mal { color:var(--bad-fg); border-left:2px solid var(--bad-fg); padding-left:.5rem; }
    .cs-grano { font-size:var(--fs-xs); color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .cs-grano-flojo { color:var(--warn-fg); }
    .cs-saldo { margin:0 0 1rem; }
    .cs-h2 { font-size:var(--fs-h3); font-weight:600; margin:0 0 .5rem; }
    .cs-denoms { max-width:34rem; margin-top:.6rem; }
    .cs-denoms tfoot td { border-top:1px solid var(--border-color); border-bottom:0; font-weight:600; }
    .cs-hallazgos { border-left:2px solid var(--bad-fg); padding-left:.5rem; }
    .cs-hallazgos ul { margin:.25rem 0 0; padding-left:1.1rem; }
    /* #9 — la pantalla se embebe a anchos distintos según el sidebar: en angosto las dos mitades
       del resumen se apilan y la rejilla deja de competir por el ancho. */
    @container (max-width: 44rem) {
      .cs-resumen-grid { grid-template-columns:1fr; }
      .fin-filtros .fin-row { flex-wrap:wrap; }
    }
  `],
})
export class FinanzasCaosComponent implements OnInit, OnDestroy {
  private svc = inject(CaosService);
  private sock = inject(CaosSocketService);
  private destroyRef = inject(DestroyRef);
  private zone = inject(NgZone);

  readonly money = money;
  readonly dmy = dmy;
  readonly limite = 500;

  from = todayMx();
  to = todayMx();
  tipo = '';
  usuario = '';
  ref = '';

  rows = signal<FilaUI[]>([]);
  kpi = signal<CaosKpi | null>(null);
  tipos = signal<CaosTipo[]>([]);

  /** `[CG.163]` El combo sale de los tipos que la ventana TIENE. Antes eran 4 a mano, y hay 7. */
  readonly tiposOpc = computed(() => [
    { label: 'Todos', value: '' },
    ...this.tipos().map((t) => ({ label: `${t.type_label} (${t.n})`, value: String(t.type_id) })),
  ]);

  // ── Paneles plegados: cada uno con su estado y su error propio ───────────────────────────
  //
  // ⛔ `[CG.163]` Los tres se cargan AL ABRIRSE. `resumen` y `conciliacion` se pedían en cada
  // `cargar()` con el panel cerrado: el cuadre tarda ~1 s y se repetía cada 60 s por el repaso.
  resumen = signal<{ porRuta: CaosPorRuta[]; porOperador: CaosPorOperador[] } | null>(null);
  readonly resumenError = signal<string | null>(null);
  private resumenAbierto = false;

  conc = signal<CaosConciliacion | null>(null);
  readonly concError = signal<string | null>(null);
  private cuadreAbierto = false;

  readonly ingEstado = signal<CaosIngresosEstado | null>(null);
  readonly ingError = signal<string | null>(null);
  private ingAbierto = false;

  /** Filas abiertas de la rejilla. `p-table` la lee y la escribe por `dataKey`. */
  expandidas: Record<string, boolean> = {};

  /**
   * `[CG.58.5]` El latido del carril que hace esto solo. Se lee del mismo estado, no de un
   * endpoint aparte: las cifras sin saber cuándo se calcularon no responden «¿está al día?».
   *
   * ⚠️ Lee `ingEstado()` **incondicionalmente** (lo asigna antes de cualquier corte): un
   * `computed` detrás de un `&&` que corta antes de leer el signal queda sin dependencias y no
   * recalcula nunca — hay compuerta `reactividad` por eso.
   */
  readonly latido = computed(() => this.ingEstado()?.latido ?? null);
  cargando = signal(false);
  err = signal<string | null>(null);
  hasMore = signal(false);
  private firmaVista: string | null = null;

  kpis = computed<MetricStripItem[]>(() => {
    const k = this.kpi();
    // Sin medición NO se dibuja $0.00 (ADR-056): se declara "sin medir".
    if (!k) return [
      { label: 'Movimientos', value: 'sin medir', state: 'no_medido' },
      { label: 'Depósitos', value: 'sin medir', state: 'no_medido' },
      { label: 'Dispensado', value: 'sin medir', state: 'no_medido' },
      { label: 'Neto del rango', value: 'sin medir', state: 'no_medido' },
    ];
    const indet = Number(k.indeterminados_n) || 0;
    const dotado = Number(k.dotado) || 0;
    const vaciado = Number(k.vaciado) || 0;
    const items: MetricStripItem[] = [
      { label: 'Movimientos', value: Number(k.movimientos) || 0, format: 'number',
        sub: Number(k.fotos_n) ? `${k.fotos_n} foto(s) de fin de día, no son dinero` : undefined },
      { label: 'Depósitos', value: money(k.depositos) },
      { label: 'Dispensado', value: money(k.dispensado) },
    ];
    // Sólo cuando hubo mantenimiento de casetes en el rango: un «$0.00» fijo sería ruido.
    if (dotado || vaciado) {
      items.push({ label: 'Dotar − vaciar', value: money(dotado - vaciado),
        sub: `dotó ${money(dotado)} · vació ${money(vaciado)}` });
    }
    /**
     * ⭐ `[CGA-A.33]` Antes «Depósitos − dispensado», con una nota que decía que el signo de
     * `Dotar` y `Vaciar Stocks` no estaba decodificado. Ya lo está (medido contra el equipo), así
     * que el neto los incluye. ⛔ Y sigue sin ser el saldo: es lo que se movió EN EL RANGO, y el
     * rango casi nunca arranca con la máquina vacía. El saldo es el bloque de arriba.
     */
    items.push({
      label: 'Neto del rango',
      value: money(k.neto),
      state: indet ? 'parcial' : undefined,
      stateNote: indet
        ? `No incluye ${indet} movimiento(s) sin decodificar (Cambio, Contenido Modificado) por ${money(k.indeterminados_total)}.`
        : 'Lo que entró menos lo que salió en estas fechas. No es el saldo: el saldo está arriba.',
    });
    return items;
  });

  // ── `[CGA-A.33]` El saldo de la caja fuerte ───────────────────────────────────────────────
  readonly saldoResp = signal<CaosSaldo | null>(null);
  readonly saldoError = signal<string | null>(null);
  readonly saldoCargando = signal(false);
  /** El mapa tipo → efecto llega del backend con los movimientos (una sola fuente). */
  readonly efectos = signal<Record<string, CaosTipoEfecto>>({});

  readonly saldoKpis = computed<MetricStripItem[]>(() => {
    const s = this.saldoResp();
    const fisico: MetricStripItem = {
      label: 'Conteo físico', value: 'sin medir', state: 'no_medido',
      stateNote: s?.conteo_fisico.motivo ?? 'Ningún dato registra un conteo a mano de la máquina.',
    };
    if (!s || s.estado !== 'medido' || !s.saldo || !s.maquina || !s.cuadre || !s.posteriores) {
      return [
        {
          label: 'En la caja fuerte', value: 'sin medir', state: 'no_medido',
          stateNote: s?.estado === 'sin_tabla'
            ? 'La suite todavía no guarda la foto del contenido de la máquina: falta aplicar su migración.'
            : 'La máquina todavía no ha reportado su contenido a la suite.',
        },
        { label: 'Cuadre con los movimientos', value: 'sin medir', state: 'no_medido',
          stateNote: 'Se mide comparando dos fotos de la máquina contra lo que se movió entre ellas.' },
        fisico,
      ];
    }
    const { maquina: m, saldo, cuadre: c, posteriores: p } = s;
    const notas: string[] = [];
    if (m.con_miscount) notas.push('La máquina marca conteo dudoso en algún casete.');
    if (saldo.parcial) notas.push(`Después de la foto hay movimientos sin decodificar: ${p.ambiguos.join(' · ')}`);
    const descuadre = c.descuadres.reduce((a, x) => a + Number(x.diferencia), 0);
    return [
      {
        label: 'En la caja fuerte',
        value: money(saldo.total),
        sub: saldo.origen === 'maquina'
          ? `según la máquina · ${this.horaMx(m.confirmada_at)}`
          : `foto de ${this.horaMx(m.tomada_at)} · ${p.movimientos} mov. después (${p.neto < 0 ? '−' : '+'}${money(Math.abs(p.neto))})`,
        state: notas.length ? 'parcial' : 'medido',
        stateNote: notas.length ? notas.join(' ') : undefined,
        tone: m.con_miscount ? 'warn' : undefined,
      },
      c.pares
        ? {
            label: 'Cuadre con los movimientos',
            value: `${c.cuadran} de ${c.pares}`,
            tone: c.descuadres.length ? 'bad' : 'ok',
            sub: c.descuadres.length
              ? `${c.descuadres.length} descuadre(s) por ${money(descuadre)}`
              : 'fotos de 30 días, billete por billete',
          }
        : {
            label: 'Cuadre con los movimientos', value: 'sin medir', state: 'no_medido',
            stateNote: 'Hace falta una segunda foto de la máquina para comparar.',
          },
      fisico,
    ];
  });

  /** Qué casetes guardan una denominación, según la última foto («#6, #7, #8»). */
  casetesDe(denom: number): string {
    const cs = this.saldoResp()?.maquina?.contenedores ?? [];
    const lst = cs.filter((x) => Number(x.denom) === Number(denom) && x.billetes > 0)
      .map((x) => `${x.tipo === 'bag' ? 'bolsa ' : ''}#${x.indice}${x.miscount ? ' (dudoso)' : ''}`);
    return lst.length ? lst.join(', ') : '—';
  }

  private readonly fmtHora = new Intl.DateTimeFormat('es-MX', {
    timeZone: MX_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  /** Instante → «20/10 10:04», en hora de México. */
  horaMx(v: string | null | undefined): string {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : this.fmtHora.format(d);
  }

  efectoDe(typeId: number): CaosTipoEfecto | null {
    return this.efectos()[String(typeId)] ?? null;
  }

  cargarSaldo(): void {
    this.saldoCargando.set(true);
    this.svc.saldo().subscribe({
      next: (s) => { this.saldoResp.set(s); this.saldoError.set(null); this.saldoCargando.set(false); },
      error: (e) => { this.saldoResp.set(null); this.saldoError.set(this.textoError(e)); this.saldoCargando.set(false); },
    });
  }

  ngOnInit(): void {
    // `[CG.163]` El día de negocio es México. `toISOString()` daba el día en UTC mientras `to`
    // usaba `todayMx()`, así que después de las 18:00 la ventana por omisión se corría un día.
    this.from = toMxDateKey(new Date(Date.now() - 7 * 86400000));
    this.cargar();
    this.cargarSaldo();
    this.enVivo();
  }

  ngOnDestroy(): void { this.sock.disconnect(); }

  /** La consulta barata: es la única que corre al entrar y en cada repaso. */
  cargar(): void {
    this.cargando.set(true);
    this.svc.movimientos({ from: this.from, to: this.to, tipo: this.tipo || undefined, usuario: this.usuario || undefined, ref: this.ref || undefined, limit: this.limite })
      .subscribe({
        next: (r) => {
          this.rows.set((r.rows || []) as FilaUI[]);
          this.kpi.set(r.kpi ?? null);
          this.tipos.set(r.tipos || []);
          this.efectos.set(r.efectos ?? {});
          this.hasMore.set(!!r.has_more);
          this.expandidas = {};
          this.err.set(null);
          this.cargando.set(false);
        },
        error: (e) => {
          this.rows.set([]); this.kpi.set(null);
          this.err.set(this.textoError(e)); this.cargando.set(false);
        },
      });
    // Los paneles sólo se re-piden si están ABIERTOS: cerrados no cuestan nada.
    if (this.resumenAbierto) this.cargarResumen();
    if (this.cuadreAbierto) this.cargarCuadre();
    if (this.ingAbierto) this.cargarIngEstado();
  }

  /** Porcentaje de cobertura; `null` se declara "sin medir", nunca 0% (ADR-056). */
  pct(x: number | null): string { return x == null ? 'sin medir' : Math.round(x * 100) + '%'; }

  /**
   * `[CG.163]` Cómo se nombra una fila del panel por ruta. El grano manda: `plaza` NO se
   * convierte en una ruta, y `sin_declarar` se separa de «el carril todavía no lo vio».
   */
  etiquetaGrano(g: CaosPorRuta): string {
    if (g.ruta) return `Ruta ${g.ruta}`;
    if (g.plaza) return `Plaza ${g.plaza}`;
    if (g.grano === 'sin_clasificar') return 'sin clasificar todavía';
    return g.motivo.startsWith('es ruta vecinal') ? 'Vecinal (otro circuito)' : 'sin ruta declarada';
  }

  /** La diferencia entre el total declarado y lo que suman sus denominaciones. 0 = cuadra. */
  descuadre(r: FilaUI): number | null {
    if (r.denomTotal == null) return null;
    const dif = Number(r.denomTotal) - Number(r.total);
    return Math.abs(dif) > 0.005 ? dif : null;
  }

  /**
   * `[CG.58.2]` La primera apertura del panel dispara la carga. ⚠️ `toggle` también se emite al
   * CERRAR, así que se mira `open` — si no, cerrarlo volvería a pedir la consulta cara.
   */
  alAbrirIngresos(ev: Event): void {
    if (!(ev.target as HTMLDetailsElement)?.open || this.ingAbierto) return;
    this.ingAbierto = true;
    this.cargarIngEstado();
  }

  alAbrirResumen(ev: Event): void {
    if (!(ev.target as HTMLDetailsElement)?.open || this.resumenAbierto) return;
    this.resumenAbierto = true;
    this.cargarResumen();
  }

  alAbrirCuadre(ev: Event): void {
    if (!(ev.target as HTMLDetailsElement)?.open || this.cuadreAbierto) return;
    this.cuadreAbierto = true;
    this.cargarCuadre();
  }

  cargarIngEstado(): void {
    this.svc.ingresosEstado().subscribe({
      next: (e) => { this.ingEstado.set(e); this.ingError.set(null); },
      error: (e) => { this.ingEstado.set(null); this.ingError.set(this.textoError(e)); },
    });
  }

  /**
   * ⛔ `[CG.163]` Antes era `error: () => this.resumen.set(null)` y el panel quedaba con los
   * encabezados y cero filas: un 500 se leía igual que «no hubo movimientos». Así vivió oculto
   * el 500 de `[CG.161]`. El fallo se DECLARA, con su reintento.
   */
  cargarResumen(): void {
    this.svc.resumen({ from: this.from, to: this.to }).subscribe({
      next: (r) => {
        this.resumen.set({ porRuta: r.porRuta || [], porOperador: r.porOperador || [] });
        this.resumenError.set(null);
      },
      error: (e) => { this.resumen.set(null); this.resumenError.set(this.textoError(e)); },
    });
  }

  cargarCuadre(): void {
    this.svc.conciliacion({ from: this.from, to: this.to }).subscribe({
      next: (r) => { this.conc.set(r); this.concError.set(null); },
      error: (e) => { this.conc.set(null); this.concError.set(this.textoError(e)); },
    });
  }

  /** El detalle por denominación se pide una sola vez por fila, al expandirla. */
  alExpandir(r: FilaUI): void {
    if (r.denom) return;
    this.svc.detalle(r.id).subscribe({
      next: (d) => {
        r.denom = d.denominaciones || [];
        r.denomTotal = d.denominaciones_total ?? null;
        this.rows.set([...this.rows()]);
      },
      error: () => { r.denom = []; r.denomTotal = null; this.rows.set([...this.rows()]); },
    });
  }

  /**
   * `[CGA-A.33]` El color dice la dirección, con el mapa del backend: antes `Vaciar Stocks`
   * salía igual que `Dotar` (los dos «info») y la etiqueta no decía que uno saca y otro mete.
   */
  sev(typeId: number): 'success' | 'danger' | 'info' | 'warn' | 'secondary' {
    switch (this.efectoDe(typeId)?.efecto) {
      case 'suma': return 'success';
      case 'resta': return 'danger';
      case 'foto': return 'secondary';
      case 'indeterminado': return 'warn';
      default: return 'info';               // el mapa todavía no llegó
    }
  }

  private enVivo(): void {
    // El canal en vivo es un EXTRA: si no abre, queda el repaso. No puede tumbar la pantalla.
    try {
      this.sock.connect();
      this.sock.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
        const firma = e.firma ?? `${e.filas}|${e.max_id}`;
        if (firma === this.firmaVista) return;
        this.firmaVista = firma;
        this.cargar();
        // Un movimiento o una foto nueva cambian el saldo; el rango de abajo no lo filtra.
        this.cargarSaldo();
      });
    } catch (e) {
      console.warn('[caos] sin avisos en vivo; queda el repaso:', e);
    }
    // Red de seguridad: NOTIFY no se persiste, un socket caído no deja rastro.
    encuestarVisible(60000, () => { this.cargar(); this.cargarSaldo(); }, { destroyRef: this.destroyRef, zone: this.zone });
  }

  private textoError(e: unknown): string {
    const err = e as { status?: number; error?: { message?: string } };
    if (err?.status === 0) return 'No hay conexión con el servidor.';
    return err?.error?.message || 'No se pudo cargar el reporte de la caja fuerte.';
  }
}
