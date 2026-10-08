import {
  ChangeDetectionStrategy, Component, ElementRef, OnInit, ViewChild,
  computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import {
  ComercialService, RouteCountSheet, RouteCountSheetLine, RouteCountResult,
} from '../../comercial/comercial.service';

/** Un renglón de la hoja más lo que la persona dijo de él. */
interface Renglon extends RouteCountSheetLine {
  estado: 'pendiente' | 'igual' | 'difiere';
  /** Lo CONTADO. `null` mientras está pendiente — nunca 0 por defecto. */
  contado: number | null;
}

/** Versión del borrador local. Si cambia la forma, los borradores viejos se descartan solos. */
const BORRADOR_V = 'rd.conteo.v1';

/**
 * `[RD.45]` **Contar un camión: el producto en grande, «Igual» o «Difiere», y seguir.**
 *
 * Reemplaza la hoja impresa que hoy se recorre con una regla. El proceso es el mismo —la persona
 * ve lo que el camión dice que trae y lo confirma o lo corrige— y eso es deliberado: la
 * transición no le pide a nadie reaprender su trabajo.
 *
 * ── Lo que esta pantalla NO es, y conviene decirlo ──────────────────────────────────────────
 *
 * ⚠️ **No es un conteo ciego.** Muestra el esperado, así que ancla a quien cuenta: es más fácil
 * tocar «Igual» que contar. Es exactamente el sesgo que ya existe en el papel (la hoja impresa
 * trae la cantidad), así que esto no lo empeora — pero tampoco lo arregla, y nadie debería leer
 * un conteo de aquí como si fuera independiente. Lo que sí agrega sobre el papel: queda
 * registrado **quién**, **cuándo** y **qué contó de distinto**, que en la hoja no queda.
 *
 * ── Los dos frenos que la pantalla sí impone ────────────────────────────────────────────────
 *
 * ⛔ **No se puede cerrar incompleto.** `registerRouteCount` RESETEA: lo que no viaja en la hoja
 * queda en CERO. Un conteo a medias enviado por error mandaría a cero cientos de productos que
 * están en el camión. Por eso el botón de cerrar está apagado mientras quede un pendiente, y el
 * contador de pendientes está siempre a la vista.
 *
 * ⛔ **«No está» se captura como Difiere con 0, no se omite.** Omitir un renglón y contar cero
 * producen el mismo efecto en el ledger, pero no son la misma afirmación: una persona que miró
 * y no encontró el producto está declarando algo. El flujo la obliga a decirlo.
 *
 * ── Avance guardado ─────────────────────────────────────────────────────────────────────────
 *
 * El avance se guarda en el navegador en cada toque, así que cerrar la pestaña o quedarse sin
 * señal no pierde el trabajo. ⚠️ Es **por dispositivo**: no se puede empezar en una tablet y
 * seguir en otra, y la pantalla lo dice. Si la foto del camión cambió desde que se empezó, el
 * borrador se descarta y se avisa — seguir contra una hoja vieja sería peor que volver a
 * empezar.
 */
@Component({
  selector: 'app-almacen-rutas-contar',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule, TooltipModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in rk-page">
      <p-toast position="top-center"></p-toast>

      @if (fase() === 'cargando') {
        <div class="rk-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Abriendo la hoja de la ruta {{ ruta() }}…</div>
      } @else if (error() && fase() !== 'contando') {
        <div class="rk-msg rk-bad">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}
          <button pButton size="small" severity="secondary" (click)="salir()">
            <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Volver
          </button>
        </div>
      }

      <!-- ─────────── CONTANDO: el acto. Una cosa a la vez, en grande. ─────────── -->
      @if (fase() === 'contando') {
        <header class="rk-top">
          <button pButton [text]="true" size="small" severity="secondary" (click)="salir()">
            <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Salir
          </button>
          <div class="rk-top-mid">
            <strong>Ruta {{ ruta() }}</strong>
            <span class="rk-top-foto" [pTooltip]="tooltipFoto()">lo que declaró el {{ hoja()?.foto_fecha }}</span>
          </div>
          <div class="rk-top-prog">{{ resueltos() }} / {{ renglones().length }}</div>
        </header>

        <div class="rk-barra" role="progressbar" [attr.aria-valuenow]="resueltos()"
             [attr.aria-valuemin]="0" [attr.aria-valuemax]="renglones().length">
          <span [style.width.%]="avance()"></span>
        </div>

        @if (actual(); as r) {
          <section class="rk-card" [class.rk-card-hecho]="r.estado !== 'pendiente'">
            <p class="rk-pos">Renglón {{ idx() + 1 }} de {{ renglones().length }}</p>

            <h2 class="rk-prod">{{ r.producto }}</h2>
            <p class="rk-meta">
              <span class="rk-sku">{{ r.sku }}</span>
              <span class="rk-unidad">{{ r.unidad }}</span>
            </p>

            <div class="rk-esperado">
              <span class="rk-esperado-l">Debe haber</span>
              <span class="rk-esperado-n">{{ r.esperado | number:'1.0-3' }}</span>
            </div>

            @if (!difiriendo()) {
              <div class="rk-acciones">
                <button type="button" class="rk-btn rk-btn-ok" (click)="marcarIgual()">
                  <i class="pi pi-check" aria-hidden="true"></i>
                  <span>Igual</span>
                </button>
                <button type="button" class="rk-btn rk-btn-dif" (click)="abrirDifiere()">
                  <i class="pi pi-pencil" aria-hidden="true"></i>
                  <span>Difiere</span>
                </button>
              </div>
              <p class="rk-tip">
                Enter confirma «Igual». Si tecleás un número directo, se captura como diferencia.
              </p>
            } @else {
              <div class="rk-dif">
                <label class="rk-dif-l" for="rk-cant">¿Cuántos hay de verdad?</label>
                <input id="rk-cant" #cantInput class="rk-dif-input" type="number" inputmode="decimal"
                       step="any" min="0" [ngModel]="borrador()" (ngModelChange)="borrador.set($event)" (keydown.enter)="confirmarDifiere()"
                       (keydown.escape)="cancelarDifiere()" autocomplete="off" />
                <div class="rk-dif-acc">
                  <button pButton severity="secondary" [outlined]="true" (click)="cancelarDifiere()">Cancelar</button>
                  <button pButton [disabled]="!borradorValido()" (click)="confirmarDifiere()">
                    <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Guardar
                  </button>
                </div>
                <!-- "No esta" es una AFIRMACION, no una omision: se captura como cero. -->
                <button pButton [text]="true" severity="danger" size="small" (click)="marcarCero()">
                  No está en el camión (0)
                </button>
              </div>
            }

            @if (r.estado !== 'pendiente') {
              <p class="rk-yacont">
                Ya lo contaste:
                <strong>{{ r.contado | number:'1.0-3' }}</strong>
                @if (r.estado === 'difiere') {
                  <span class="rk-delta">({{ delta(r) > 0 ? '+' : '' }}{{ delta(r) | number:'1.0-3' }})</span>
                }
                · <button pButton [text]="true" size="small" (click)="rehacer()">cambiar</button>
              </p>
            }
          </section>

          <nav class="rk-nav">
            <button pButton severity="secondary" [outlined]="true" [disabled]="idx() === 0" (click)="anterior()">
              <span class="p-button-icon p-button-icon-left pi pi-chevron-left" aria-hidden="true"></span> Anterior
            </button>
            <button pButton severity="secondary" [outlined]="true" (click)="saltar()">
              Saltar por ahora
              <span class="p-button-icon p-button-icon-right pi pi-chevron-right" aria-hidden="true"></span>
            </button>
          </nav>
        }

        <section class="rk-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input class="rk-buscar-input" type="text" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                 (keydown.enter)="irAlPrimero()" autocomplete="off"
                 placeholder="Escaneá el código o escribí el nombre para saltar a ese producto" />
          @if (busqueda()) {
            <button pButton [text]="true" size="small" severity="secondary" (click)="busqueda.set('')">Limpiar</button>
          }
        </section>
        @if (busqueda() && coincidencias().length) {
          <ul class="rk-hits">
            @for (h of coincidencias(); track h.i) {
              <li>
                <button type="button" (click)="irA(h.i); busqueda.set('')">
                  <span class="rk-hit-n">{{ h.r.producto }}</span>
                  <span class="rk-hit-m">{{ h.r.sku }} · {{ h.r.unidad }}</span>
                  @if (h.r.estado !== 'pendiente') { <p-tag severity="success" value="contado"></p-tag> }
                </button>
              </li>
            }
          </ul>
        } @else if (busqueda()) {
          <p class="rk-sinhit">Ningún renglón de esta hoja coincide con «{{ busqueda() }}».</p>
        }

        <footer class="rk-pie">
          <div class="rk-pie-n">
            <span class="rk-pend" [class.rk-pend-cero]="!pendientes()">{{ pendientes() }}</span> pendientes
            · <span class="rk-difn">{{ diferencias().length }}</span> con diferencia
          </div>
          <button pButton [disabled]="pendientes() > 0" (click)="irARevision()"
                  [pTooltip]="pendientes() > 0 ? 'Faltan ' + pendientes() + ' renglones. Un conteo incompleto manda a cero lo que no contaste.' : ''">
            <span class="p-button-icon p-button-icon-left pi pi-flag" aria-hidden="true"></span>
            Revisar y cerrar
          </button>
        </footer>
        <p class="rk-local">
          <i class="pi pi-save" aria-hidden="true"></i>
          Tu avance se guarda en este dispositivo. Si cambiás de equipo, empieza de cero.
        </p>
      }

      <!-- ─────────── REVISIÓN: qué se va a registrar, antes de registrarlo. ─────────── -->
      @if (fase() === 'revision') {
        <header class="surf-page-head">
          <div class="surf-page-head-text">
            <h1>Cerrar el conteo de la ruta {{ ruta() }}</h1>
            <p class="surf-page-sub">
              Contaste los <strong>{{ renglones().length }}</strong> renglones.
              Esto es lo que vas a registrar.
            </p>
          </div>
        </header>

        <div class="rk-kpis">
          <div class="rk-kpi">
            <span class="rk-kpi-n">{{ diferencias().length }}</span>
            <span class="rk-kpi-l">Renglones distintos</span>
          </div>
          <div class="rk-kpi">
            <span class="rk-kpi-n">{{ valorEsperado() | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            <span class="rk-kpi-l">Lo que declaraba</span>
          </div>
          <div class="rk-kpi">
            <span class="rk-kpi-n">{{ valorContado() | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            <span class="rk-kpi-l">Lo que contaste</span>
          </div>
          <div class="rk-kpi" [class.rk-bad]="valorContado() - valorEsperado() < 0">
            <span class="rk-kpi-n">{{ (valorContado() - valorEsperado()) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            <span class="rk-kpi-l">Diferencia</span>
          </div>
        </div>

        @if (sinCosto() > 0) {
          <p class="rk-aviso">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            {{ sinCosto() }} renglón(es) no traen costo, así que <strong>no entran en los importes
            de arriba</strong>. Las cantidades sí se registran completas.
          </p>
        }

        <div class="rk-campos">
          <label class="rk-campo">
            <span>Fecha del conteo</span>
            <input type="date" [ngModel]="countDate()" (ngModelChange)="countDate.set($event)" />
            <!-- La fecha la DECLARA quien cuenta (RD.31). El default lo pone el servidor en
                 hora de Mexico, no el reloj de esta maquina. -->
            <small>Es el saldo de cierre de ese día: lo que se venda después se resta encima.</small>
          </label>
          <label class="rk-campo rk-campo-ancho">
            <span>Nota (opcional)</span>
            <input type="text" [ngModel]="nota()" (ngModelChange)="nota.set($event)" maxlength="200" placeholder="Quién acompañó, condiciones, lo que haga falta recordar" />
          </label>
        </div>

        @if (diferencias().length) {
          <h3 class="rk-h3">Lo que salió distinto</h3>
          <p-table [value]="diferencias()" [scrollable]="true" scrollHeight="40vh"
                   class="dt-stack surf-table surf-table--sticky" size="small" [rowHover]="true"
                   [tableStyle]="{ 'min-width': '42rem' }">
            <ng-template #header>
              <tr>
                <th>Producto</th>
                <th>Unidad</th>
                <th class="rk-num">Declaraba</th>
                <th class="rk-num">Contaste</th>
                <th class="rk-num">Diferencia</th>
                <th class="rk-num">En dinero</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td>{{ r.producto }} <small class="rk-sku-cell">{{ r.sku }}</small></td>
                <td>{{ r.unidad }}</td>
                <td class="rk-num">{{ r.esperado | number:'1.0-3' }}</td>
                <td class="rk-num"><strong>{{ r.contado | number:'1.0-3' }}</strong></td>
                <td class="rk-num" [class.rk-neg]="delta(r) < 0">
                  {{ delta(r) > 0 ? '+' : '' }}{{ delta(r) | number:'1.0-3' }}
                </td>
                <td class="rk-num" [class.rk-neg]="delta(r) < 0">
                  {{ r.costo_unitario != null
                      ? ((delta(r) * r.costo_unitario) | currency:'MXN':'symbol-narrow':'1.2-2')
                      : 'sin costo' }}
                </td>
              </tr>
            </ng-template>
          </p-table>
        } @else {
          <p class="rk-aviso">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            Ningún renglón salió distinto: el camión trae exactamente lo que declaraba.
          </p>
        }

        <p class="rk-aviso rk-aviso-fuerte">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          Al registrarlo, este conteo <strong>reemplaza</strong> el saldo publicado de la ruta
          {{ ruta() }}: a partir del {{ countDate() }} el inventario de ese camión arranca en lo
          que acabás de contar.
        </p>

        @if (error()) { <p class="rk-msg rk-bad">{{ error() }}</p> }

        <footer class="rk-pie">
          <button pButton severity="secondary" [outlined]="true" [disabled]="enviando()" (click)="fase.set('contando')">
            <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Seguir contando
          </button>
          <button pButton [disabled]="enviando() || !countDate()" (click)="cerrar()">
            @if (enviando()) { <span class="p-button-icon p-button-icon-left pi pi-spin pi-spinner" aria-hidden="true"></span> }
            @else { <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> }
            Registrar el conteo
          </button>
        </footer>
      }

      <!-- ─────────── LISTO ─────────── -->
      @if (fase() === 'listo' && resultado(); as res) {
        <div class="rk-listo">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <h2>Conteo registrado</h2>
          <p>
            Ruta <strong>{{ res.route_no }}</strong> · {{ res.count_date }} ·
            {{ res.renglones | number }} renglones ·
            {{ res.importe_sumado | currency:'MXN':'symbol-narrow':'1.2-2' }}
          </p>
          <p class="rk-listo-aviso">{{ res.aviso }}</p>
          <button pButton (click)="salir()">Volver a los camiones</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .rk-page { max-width: 54rem; }
    .rk-msg { display: flex; align-items: center; gap: .6rem; padding: 1.5rem; color: var(--text-muted); }
    .rk-msg.rk-bad { color: var(--bad-fg); }

    .rk-top { display: flex; align-items: center; gap: .75rem; margin-bottom: .5rem; }
    .rk-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .rk-top-mid strong { font-size: var(--fs-h3); }
    .rk-top-foto { font-size: var(--fs-xs); color: var(--text-muted); }
    .rk-top-prog { font-variant-numeric: tabular-nums; font-weight: 800; font-size: var(--fs-lg); }

    .rk-barra { height: 6px; border-radius: 3px; background: var(--surface-border); overflow: hidden; margin-bottom: 1rem; }
    .rk-barra > span { display: block; height: 100%; background: var(--action); transition: width .18s ease; }

    /* La tarjeta del producto: una sola cosa en pantalla, legible a un brazo de distancia. */
    .rk-card { background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: var(--radius-lg); padding: 1.5rem 1.25rem; text-align: center; }
    .rk-card-hecho { border-color: var(--ok-fg); }
    .rk-pos { margin: 0 0 .5rem; font-size: var(--fs-xs); color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .05em; }
    .rk-prod { margin: 0 0 .4rem; font-size: clamp(1.5rem, 5vw, 2.25rem); line-height: 1.15; font-weight: 800; }
    .rk-meta { margin: 0 0 1.25rem; display: flex; gap: .6rem; justify-content: center;
      font-size: var(--fs-body); color: var(--text-muted); }
    .rk-sku { font-family: var(--font-mono); }
    .rk-unidad { font-weight: 700; letter-spacing: .03em; }

    .rk-esperado { display: flex; flex-direction: column; align-items: center; gap: .15rem; margin-bottom: 1.5rem; }
    .rk-esperado-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
    .rk-esperado-n { font-size: clamp(3rem, 14vw, 5rem); font-weight: 900; line-height: 1;
      font-variant-numeric: tabular-nums; }

    /* Dos botones grandes: el gesto es del pulgar, no del cursor. */
    .rk-acciones { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .rk-btn { display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: .3rem; min-height: 5.5rem; border-radius: 12px; border: 2px solid transparent;
      font-size: var(--fs-lg); font-weight: 800; cursor: pointer; }
    .rk-btn i { font-size: var(--fs-h2); }
    .rk-btn-ok { background: var(--ok-soft-bg); color: var(--ok-fg); border-color: var(--ok-fg); }
    .rk-btn-dif { background: var(--surface-card); color: var(--text-main); border-color: var(--surface-border); }
    .rk-btn:hover { filter: brightness(.97); }
    .rk-btn:focus-visible { outline: 3px solid var(--action); outline-offset: 2px; }
    .rk-tip { margin: .75rem 0 0; font-size: var(--fs-xs); color: var(--text-muted); }

    .rk-dif { display: flex; flex-direction: column; align-items: center; gap: .75rem; }
    .rk-dif-l { font-size: var(--fs-body); color: var(--text-muted); font-weight: 600; }
    /* El campo de la cantidad es el gesto mas importante de la pantalla: se escribe mirando el
       producto, no la pantalla, asi que el numero tiene que leerse de reojo. Escala con el ancho
       para no desbordar en un telefono. */
    .rk-dif-input { width: 100%; max-width: 16rem; text-align: center; font-size: clamp(2.25rem, 10vw, 3rem);
      font-weight: 900; font-variant-numeric: tabular-nums; padding: .4rem .6rem;
      border: 2px solid var(--action); border-radius: 10px; background: var(--surface-card);
      color: var(--text-main); }
    .rk-dif-acc { display: flex; gap: .6rem; }
    .rk-yacont { margin: 1rem 0 0; font-size: var(--fs-body); color: var(--text-muted); }
    .rk-delta { font-weight: 700; }

    .rk-nav { display: flex; justify-content: space-between; gap: .6rem; margin: .75rem 0 1rem; }

    .rk-buscar { display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem;
      border: 1px solid var(--surface-border); border-radius: 10px; background: var(--surface-card); }
    .rk-buscar i { color: var(--text-muted); }
    .rk-buscar-input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text-main);
      font-size: var(--fs-body); padding: .25rem 0; }
    /* El contorno se quita del :focus porque el campo ya vive dentro de una caja con borde,
       pero se devuelve en :focus-visible: quien navega con teclado tiene que ver dónde está. */
    .rk-buscar-input:focus { outline: none; }
    .rk-buscar-input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 6px; }
    .rk-hits { list-style: none; margin: .4rem 0 0; padding: 0; border: 1px solid var(--surface-border);
      border-radius: 10px; overflow: hidden; }
    .rk-hits li + li { border-top: 1px solid var(--surface-border); }
    .rk-hits button { width: 100%; display: flex; align-items: center; gap: .6rem; padding: .55rem .75rem;
      background: transparent; border: 0; cursor: pointer; text-align: left; color: var(--text-main); }
    .rk-hits button:hover { background: var(--surface-hover); }
    .rk-hit-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rk-hit-m { font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-mono); }
    .rk-sinhit { margin: .4rem 0 0; font-size: var(--fs-xs); color: var(--text-muted); }

    .rk-pie { display: flex; align-items: center; justify-content: space-between; gap: .75rem;
      margin-top: 1.25rem; padding-top: .9rem; border-top: 1px solid var(--surface-border); }
    .rk-pie-n { font-size: var(--fs-body); color: var(--text-muted); }
    .rk-pend { font-weight: 800; color: var(--warn-fg); font-variant-numeric: tabular-nums; }
    .rk-pend-cero { color: var(--ok-fg); }
    .rk-difn { font-weight: 800; font-variant-numeric: tabular-nums; }
    .rk-local { display: flex; align-items: center; gap: .4rem; margin: .6rem 0 0;
      font-size: var(--fs-xs); color: var(--text-muted); }

    .rk-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 0 0 1rem; }
    .rk-kpi { background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; }
    .rk-kpi-n { font-size: var(--fs-h2); font-weight: 800; font-variant-numeric: tabular-nums; }
    .rk-kpi-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .rk-kpi.rk-bad .rk-kpi-n { color: var(--bad-fg); }

    .rk-campos { display: grid; grid-template-columns: 14rem 1fr; gap: .75rem; margin: 1rem 0; }
    .rk-campo { display: flex; flex-direction: column; gap: .25rem; }
    .rk-campo > span { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; }
    .rk-campo input { padding: .45rem .6rem; border: 1px solid var(--surface-border); border-radius: 8px;
      background: var(--surface-card); color: var(--text-main); font-size: var(--fs-body); }
    .rk-campo small { font-size: var(--fs-xs); color: var(--text-muted); }

    .rk-h3 { margin: 1.25rem 0 .5rem; font-size: var(--fs-h3); }
    .rk-num { text-align: right; font-variant-numeric: tabular-nums; }
    .rk-neg { color: var(--bad-fg); }
    .rk-sku-cell { color: var(--text-muted); font-family: var(--font-mono); margin-left: .4rem; }
    .rk-aviso { display: flex; align-items: flex-start; gap: .5rem; margin: .75rem 0;
      font-size: var(--fs-body); color: var(--text-muted); }
    .rk-aviso-fuerte { color: var(--warn-fg); font-weight: 600; }

    .rk-listo { text-align: center; padding: 3rem 1rem; }
    .rk-listo i { font-size: var(--fs-display); color: var(--ok-fg); }
    .rk-listo h2 { margin: .75rem 0 .35rem; }
    .rk-listo-aviso { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: 1.25rem; }

    @media (max-width: 46rem) {
      .rk-kpis { grid-template-columns: repeat(2, 1fr); }
      .rk-campos { grid-template-columns: 1fr; }
      .rk-pie { flex-direction: column; align-items: stretch; }
    }
  `],
})
export class AlmacenRutasContarComponent implements OnInit {
  private readonly api = inject(ComercialService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  @ViewChild('cantInput') cantInput?: ElementRef<HTMLInputElement>;

  readonly ruta = signal('');
  readonly hoja = signal<RouteCountSheet | null>(null);
  readonly renglones = signal<Renglon[]>([]);
  readonly idx = signal(0);
  readonly fase = signal<'cargando' | 'contando' | 'revision' | 'listo'>('cargando');
  readonly difiriendo = signal(false);
  /**
   * Lo tecleado en «Difiere», **sin tipar a `string`**: el campo es `type="number"`, así que
   * `ngModelChange` emite un **número** en cuanto el valor es numérico y una cadena vacía
   * cuando se borra. Declararlo `string` compila igual (el evento es `any`) y revienta en
   * runtime a la primera cifra, en `.trim()`. El valor se normaliza al leerlo, no al escribirlo.
   */
  readonly borrador = signal<string | number>('');
  readonly busqueda = signal('');
  readonly countDate = signal('');
  readonly nota = signal('');
  readonly enviando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resultado = signal<RouteCountResult | null>(null);

  readonly actual = computed<Renglon | null>(() => this.renglones()[this.idx()] ?? null);
  readonly resueltos = computed(() => this.renglones().filter((r) => r.estado !== 'pendiente').length);
  readonly pendientes = computed(() => this.renglones().length - this.resueltos());
  readonly avance = computed(() => {
    const n = this.renglones().length;
    return n ? (this.resueltos() / n) * 100 : 0;
  });
  readonly diferencias = computed(() =>
    this.renglones().filter((r) => r.estado === 'difiere' && r.contado !== r.esperado));
  /** Importes sólo sobre lo que TIENE costo. Lo que no lo tiene se declara aparte, no se suma como 0. */
  readonly valorEsperado = computed(() => this.renglones()
    .filter((r) => r.costo_unitario != null)
    .reduce((a, r) => a + r.esperado * (r.costo_unitario as number), 0));
  readonly valorContado = computed(() => this.renglones()
    .filter((r) => r.costo_unitario != null)
    .reduce((a, r) => a + (r.contado ?? 0) * (r.costo_unitario as number), 0));
  readonly sinCosto = computed(() => this.renglones().filter((r) => r.costo_unitario == null).length);
  readonly borradorValido = computed(() => {
    const txt = String(this.borrador() ?? '').trim();
    const n = Number(txt);
    return txt !== '' && Number.isFinite(n) && n >= 0;
  });
  readonly tooltipFoto = computed(() => {
    const h = this.hoja();
    if (!h) return '';
    return `La camioneta reportó su existencia el ${h.foto_fecha}. Si contás contra una foto vieja, el conteo sigue siendo válido — pero sabé cuál es.`;
  });

  /** Hasta 8 coincidencias, para que un empate se vea en vez de elegirse solo. */
  readonly coincidencias = computed(() => {
    const t = this.busqueda().trim().toLowerCase();
    if (!t) return [];
    return this.renglones()
      .map((r, i) => ({ r, i }))
      .filter(({ r }) =>
        r.sku.toLowerCase() === t
        || (r.barcode ?? '').toLowerCase() === t
        || r.producto.toLowerCase().includes(t)
        || r.sku.toLowerCase().includes(t))
      .slice(0, 8);
  });

  ngOnInit(): void {
    const ruta = String(this.route.snapshot.paramMap.get('ruta') ?? '').trim();
    this.ruta.set(ruta);
    if (!ruta) { this.error.set('No se indicó la ruta.'); this.fase.set('revision'); return; }

    this.api.routeCountSheet(ruta).subscribe({
      next: (h) => {
        if (!h.lines.length) {
          this.error.set(`La ruta ${ruta} no reportó existencia: no hay hoja contra la cual contar.`);
          this.fase.set('listo');
          this.resultado.set(null);
          return;
        }
        this.hoja.set(h);
        this.countDate.set(h.hoy);
        this.renglones.set(h.lines.map((l) => ({ ...l, estado: 'pendiente' as const, contado: null })));
        this.restaurar();
        this.fase.set('contando');
        this.irAPendiente(0);
      },
      error: (e) => {
        this.error.set(e?.error?.message || 'No se pudo abrir la hoja de esta ruta.');
        this.fase.set('revision');
      },
    });
  }

  // ── El acto de contar ────────────────────────────────────────────────────────────────────

  marcarIgual(): void {
    const r = this.actual();
    if (!r) return;
    this.aplicar(this.idx(), 'igual', r.esperado);
    this.avanzar();
  }

  abrirDifiere(): void {
    this.borrador.set('');
    this.difiriendo.set(true);
    setTimeout(() => this.cantInput?.nativeElement.focus(), 0);
  }

  cancelarDifiere(): void {
    this.difiriendo.set(false);
    this.borrador.set('');
  }

  confirmarDifiere(): void {
    if (!this.borradorValido()) return;
    this.aplicar(this.idx(), 'difiere', Number(String(this.borrador()).trim()));
    this.cancelarDifiere();
    this.avanzar();
  }

  /** «No está» es una afirmación: se captura como cero contado, no como renglón omitido. */
  marcarCero(): void {
    this.aplicar(this.idx(), 'difiere', 0);
    this.cancelarDifiere();
    this.avanzar();
  }

  rehacer(): void {
    const i = this.idx();
    const rs = [...this.renglones()];
    rs[i] = { ...rs[i], estado: 'pendiente', contado: null };
    this.renglones.set(rs);
    this.guardar();
  }

  private aplicar(i: number, estado: Renglon['estado'], contado: number): void {
    const rs = [...this.renglones()];
    if (!rs[i]) return;
    rs[i] = { ...rs[i], estado, contado };
    this.renglones.set(rs);
    this.guardar();
  }

  // ── Movimiento por la hoja ───────────────────────────────────────────────────────────────

  irA(i: number): void {
    if (i < 0 || i >= this.renglones().length) return;
    this.cancelarDifiere();
    this.idx.set(i);
  }

  anterior(): void { this.irA(this.idx() - 1); }

  /** Saltar deja el renglón PENDIENTE: no se da por contado lo que nadie miró. */
  saltar(): void { this.avanzar(); }

  irAlPrimero(): void {
    const c = this.coincidencias();
    if (c.length === 1) { this.irA(c[0].i); this.busqueda.set(''); }
  }

  irARevision(): void {
    if (this.pendientes() > 0) return;
    this.error.set(null);
    this.fase.set('revision');
  }

  /** Siguiente pendiente desde la posición actual; si no queda ninguno adelante, da la vuelta. */
  private avanzar(): void {
    const n = this.renglones().length;
    const desde = this.idx() + 1;
    if (!this.irAPendiente(desde)) {
      if (!this.irAPendiente(0)) {
        // Todo resuelto: la pantalla no salta sola a revisión — que el cierre sea un acto
        // deliberado y no la consecuencia de haber tocado un botón 300 veces.
        this.idx.set(Math.min(this.idx(), n - 1));
      }
    }
  }

  private irAPendiente(desde: number): boolean {
    const rs = this.renglones();
    for (let i = desde; i < rs.length; i++) {
      if (rs[i].estado === 'pendiente') { this.irA(i); return true; }
    }
    return false;
  }

  delta(r: Renglon): number { return (r.contado ?? 0) - r.esperado; }

  // ── Borrador local ───────────────────────────────────────────────────────────────────────

  private clave(): string { return `${BORRADOR_V}.${this.ruta()}`; }

  private guardar(): void {
    const h = this.hoja();
    if (!h) return;
    const marcas: Record<string, number> = {};
    for (const r of this.renglones()) {
      if (r.estado !== 'pendiente' && r.contado != null) marcas[`${r.sku}|${r.unidad}`] = r.contado;
    }
    try {
      localStorage.setItem(this.clave(), JSON.stringify({
        foto_fecha: h.foto_fecha, renglones: h.lines.length, guardado_en: new Date().toISOString(), marcas,
      }));
    } catch {
      // Sin almacenamiento (modo privado, cuota llena) el conteo sigue funcionando en memoria.
      // No se avisa en cada toque: se avisaría 300 veces.
    }
  }

  private restaurar(): void {
    const h = this.hoja();
    if (!h) return;
    let crudo: string | null = null;
    try { crudo = localStorage.getItem(this.clave()); } catch { return; }
    if (!crudo) return;
    let b: { foto_fecha?: string | null; marcas?: Record<string, number> };
    try { b = JSON.parse(crudo); } catch { return; }

    // ⛔ Si la foto cambió, el borrador es de OTRA hoja: seguir pegándole marcas viejas
    // mezclaría dos conteos. Se descarta y se avisa.
    if ((b.foto_fecha ?? null) !== (h.foto_fecha ?? null)) {
      try { localStorage.removeItem(this.clave()); } catch { /* nada que limpiar */ }
      this.toast.add({
        severity: 'warn', life: 8000, summary: 'Se descartó el avance anterior',
        detail: 'La camioneta volvió a reportar desde que empezaste, así que la hoja cambió. Hay que contar sobre la nueva.',
      });
      return;
    }

    const marcas = b.marcas ?? {};
    let n = 0;
    const rs = this.renglones().map((r) => {
      const v = marcas[`${r.sku}|${r.unidad}`];
      if (v == null) return r;
      n++;
      return { ...r, contado: v, estado: (v === r.esperado ? 'igual' : 'difiere') as Renglon['estado'] };
    });
    if (!n) return;
    this.renglones.set(rs);
    this.toast.add({
      severity: 'info', life: 6000, summary: 'Seguimos donde ibas',
      detail: `${n} de ${rs.length} renglones ya estaban contados en este dispositivo.`,
    });
  }

  // ── Cierre ───────────────────────────────────────────────────────────────────────────────

  cerrar(): void {
    const h = this.hoja();
    if (!h || this.enviando()) return;
    if (this.pendientes() > 0) {
      this.error.set(`Faltan ${this.pendientes()} renglones. Un conteo incompleto manda a cero lo que no contaste.`);
      return;
    }
    this.enviando.set(true);
    this.error.set(null);
    this.api.registerRouteCount({
      route_no: this.ruta(),
      count_date: this.countDate(),
      source: 'manual',
      // `declared_total` queda NULL a propósito: es "lo que el papel dice que suma", o sea un
      // testigo independiente. Mandar nuestra propia suma lo volvería un espejo que siempre
      // cuadra, y `cuadra` pasaría a ser un true sin contenido (ADR-056).
      declared_total: null,
      note: this.nota().trim() || null,
      lines: this.renglones().map((r) => ({
        sku: r.sku,
        unidad: r.unidad,
        qty: r.contado ?? 0,
        descripcion: r.producto,
        costo_unitario: r.costo_unitario,
        importe: r.costo_unitario != null ? Math.round((r.contado ?? 0) * r.costo_unitario * 100) / 100 : null,
      })),
    }).subscribe({
      next: (res) => {
        this.resultado.set(res);
        this.enviando.set(false);
        this.fase.set('listo');
        try { localStorage.removeItem(this.clave()); } catch { /* ya no importa */ }
      },
      error: (e) => {
        this.enviando.set(false);
        this.error.set(e?.error?.message || 'No se pudo registrar el conteo. El avance sigue guardado.');
      },
    });
  }

  salir(): void { void this.router.navigate(['/almacen/rutas/conteos']); }
}
