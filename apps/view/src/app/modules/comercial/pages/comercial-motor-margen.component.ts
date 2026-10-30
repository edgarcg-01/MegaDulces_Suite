import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { etiquetaAccion, glosaAccion, precioPropuesto, textoCerteza, type PrecioPropuesto } from '../precios-vocabulario';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PRECIOS_APARTADO_TABS } from '../precios-apartado-tabs';
import { agruparCola, montoDe, type FilaCola } from '../agrupar-cola';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, map, of, switchMap, tap } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import {
  MotorMargenService, type ResumenMotor, type ColaRow, type ColaRespuesta,
  type RegistroSenales, type AccionResumen,
} from '../motor-margen.service';
import {
  ComercialMotorMargenExpedienteComponent,
} from './comercial-motor-margen-expediente.component';

/**
 * `[PR.V1]` — **Motor de margen.** Operations: tabla densa + el expediente en una ventana.
 *
 * ── Answer-first (§Q.1) ────────────────────────────────────────────────────────────────────
 * No abre con el grid. Abre con **qué se puede hacer hoy, cuánto vale y con qué certeza** —
 * porque la pregunta que alguien trae al entrar no es "cuántas filas hay".
 *
 * Primario = el dinero de cada acción que se puede mover hoy · secundario = la cola, con el
 * precio que el motor propone · terciario = lo que el motor no puede ver y la edad del cálculo.
 *
 * ── `[PR.V11]` Lo que corrigió la auditoría del 2026-10-30 ─────────────────────────────────
 * · **Tres unidades, tres lugares.** El flujo de 30 días comparte barra; el saldo de inventario
 *   y la venta expuesta de la escalera van aparte. La pantalla agrupa por `monto_unidad`, que
 *   declara la vista, y no por qué columna llegó NULL: así la escalera caía en «Sin decisión».
 * · **La cola llega a lo que la tarjeta promete.** De entrada muestra sólo lo que se puede mover
 *   hoy (de las primeras 200 filas, 137 estaban bloqueadas), dice «N de M» y avisa el tope.
 * · **El precio propuesto se ve.** Viajaba en todas las filas de aterrizar y subir, y no se pintaba.
 * · **Cargando, vacío y error son tres cosas.** Antes, una cola que fallaba decía «Nada que
 *   proponer con la evidencia de hoy», con palomita.
 * · **La edad del cálculo** se ve arriba y no depende de que cargue otra consulta.
 *
 * ── ⛔ Lo que esta pantalla NO hace, y se ve ───────────────────────────────────────────────
 * Kepler es read-only (ADR-040): acá **no se cambia ningún precio**. Y el default del triage es
 * `sin_accion_defendible` en el 74 % de las celdas — se publica, no se esconde.
 */
@Component({
  selector: 'app-comercial-motor-margen',
  standalone: true,
  imports: [CommonModule, PageTabsComponent, ContextHelpComponent, LoadStateComponent,
    FreshnessPillComponent, TableModule, ButtonModule, ComercialMotorMargenExpedienteComponent,
    SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div class="surf-page mm">

  <div class="pr-tabs"><app-page-tabs [tabs]="tabs" /></div>

  <header class="surf-page-head">
    <div class="surf-page-head-text">
      <h1>Motor de margen</h1>
      <p class="surf-page-sub">
        Triage de precio por producto y plaza: <strong>qué se puede hacer, cuánto vale y con qué
        certeza</strong>. No cambia ningún precio &mdash; la captura sigue siendo en Kepler.
      </p>
    </div>
    <div class="mm-head-acc">
      @if (resumen()?.total?.calculado_al; as calc) {
        <!-- El motor se calcula una vez al dia: despues de 30 h ya se salto una corrida. -->
        <app-freshness-pill measures="data" label="calculado" [since]="calc" [staleAfterSec]="108000" />
      }
      <app-context-help topic="control-de-margen" label="Cómo se usa" />
      <app-context-help topic="motor-margen" label="Qué significa" />
      <p-button type="button" icon="pi pi-refresh" label="Volver a leer" [loading]="cargando()" (click)="recargar()" styleClass="p-button-text p-button-sm" />
    </div>
  </header>

  <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" [skeletonRows]="4"
                  errorTitle="No se pudo leer el resumen del motor" (retry)="recargar()">
    @if (resumen(); as r) {

      <!-- ══ 1 · DINERO EN JUEGO — sólo FLUJO, y las barras comparten escala ═══════════ -->
      <div class="mm-sec-h">
        <span class="mm-sec-t">Dinero en juego</span>
        <span class="mm-sec-s">flujo de 30 días, sólo lo que se puede mover hoy &middot; las barras comparten escala</span>
      </div>
      <section class="mm-flu" aria-label="Acciones con flujo de dinero">
        @for (a of accionesFlujo(); track a.accion) {
          <button type="button" class="mm-card" [class.is-sel]="filtroAccion() === a.accion"
                  [attr.aria-pressed]="filtroAccion() === a.accion" (click)="filtrarPor(a.accion)">
            <span class="mm-card-t">{{ etiqueta(a.accion) }}</span>
            <span class="mm-card-g">{{ glosa(a.accion) }}</span>
            <span class="mm-card-m comm-num">{{ pesos(a.flujo_libre) }}</span>
            <span class="mm-card-bar" aria-hidden="true">
              <span class="mm-card-bar-f" [style.width.%]="parte(a)"></span>
            </span>
            <span class="mm-card-n">
              <strong class="comm-num">{{ a.libres | number }}</strong> se pueden mover
              &middot; {{ a.bloqueadas | number }} bloqueadas
            </span>
            <span class="mm-cert" [attr.data-c]="a.certeza">{{ certezaTxt(a.certeza) }}</span>
          </button>
        }
      </section>

      <!-- ══ 2 · OTRAS UNIDADES — deliberadamente APARTE: no se suman ni se comparan ═════ -->
      <div class="mm-row2">
        @if (accionSaldo(); as c) {
          <button type="button" class="mm-otra" [class.is-sel]="filtroAccion() === c.accion"
                  [attr.aria-pressed]="filtroAccion() === c.accion" (click)="filtrarPor(c.accion)">
            <span class="mm-sec-t">Inventario en sobrestock</span>
            <span class="mm-card-m comm-num">{{ pesos(c.capital_libre) }}</span>
            <span class="mm-otra-x">
              <strong>Es un saldo, no un flujo</strong>: la existencia de esos productos valuada a
              costo, por eso no lleva barra. Es la existencia entera, no lo que sobra &mdash; la
              cobertura objetivo no está fijada.
              <span class="comm-num">{{ c.libres | number }}</span> se pueden mover &middot;
              <span class="comm-num">{{ c.bloqueadas | number }}</span> bloqueadas.
            </span>
          </button>
        }
        @if (accionVenta(); as e) {
          <button type="button" class="mm-otra" [class.is-sel]="filtroAccion() === e.accion"
                  [attr.aria-pressed]="filtroAccion() === e.accion" (click)="filtrarPor(e.accion)">
            <span class="mm-sec-t">{{ etiqueta(e.accion) }}</span>
            <span class="mm-card-m comm-num">{{ pesos(e.venta_libre) }}</span>
            <span class="mm-otra-x">
              <strong>Venta expuesta en 30 días, no un incremento</strong>: {{ glosa(e.accion) }}.
              Cuánto cambia al corregirla depende de qué escalón se mueva.
              <span class="comm-num">{{ e.libres | number }}</span> se pueden corregir &middot;
              <span class="comm-num">{{ e.bloqueadas | number }}</span> bloqueadas.
            </span>
            <span class="mm-cert" [attr.data-c]="e.certeza">{{ certezaTxt(e.certeza) }}</span>
          </button>
        }
        <div class="mm-nodec">
          <span class="mm-sec-t">Sin decisión posible</span>
          @for (a of accionesSinDecision(); track a.accion) {
            <span class="mm-nodec-r">
              <span>{{ etiqueta(a.accion) }} <em>{{ glosa(a.accion) }}</em></span>
              <span class="comm-num">{{ a.celdas | number }}</span>
            </span>
          }
          <span class="mm-nodec-r">
            <span>Sin acción defendible <em>el default: la mayoría de las celdas, y casi no venden
              ({{ pesos(r.sin_accion.venta) }} en 30 días)</em></span>
            <span class="comm-num">{{ r.sin_accion.celdas | number }}</span>
          </span>
        </div>
      </div>
    }
  </app-load-state>

  <!-- ══ ⭐⭐ LO QUE EL MOTOR NO PUEDE VER ═══════════════════════════════════════════════ -->
  @if (reg(); as g) {
    <section class="mm-cob">
      <p class="mm-cob-l">
        <strong>{{ g.conteo.cableadas }}</strong> de {{ g.conteo.total }} señales cableadas
        &middot; <strong>{{ g.conteo.no_existen }}</strong> no existen
        &middot; {{ g.conteo.refutadas }} refutadas con medición
      </p>
      <button type="button" class="mm-lnk" [attr.aria-expanded]="verHuecos()" (click)="verHuecos.set(!verHuecos())">
        {{ verHuecos() ? 'Ocultar' : 'Ver qué falta' }}
      </button>
    </section>
    @if (verHuecos()) {
      <ul class="mm-huecos">
        @for (s of huecos(); track s.clave) {
          <li>
            <span class="mm-h-k">{{ s.clave }}</span>
            <span class="mm-h-n">{{ s.nombre }}</span>
            <span class="mm-h-m">{{ s.motivo_ausencia }}</span>
          </li>
        }
      </ul>
    }
  } @else if (regError()) {
    <!-- Si esto falla se DICE: esconder la franja haria pasar el motor por completo. -->
    <section class="mm-cob" role="status">
      <p class="mm-cob-l mm-cob-err">
        No se pudo leer el registro de señales: ahora mismo no se sabe qué no puede ver el motor.
      </p>
      <button type="button" class="mm-lnk" (click)="leerSenales()">Reintentar</button>
    </section>
  }

  <!-- ══ LA COLA ════════════════════════════════════════════════════════════════════════ -->
  <section class="mm-main">
    <div class="mm-h2-row">
      <h2 class="mm-h2">
        Cola priorizada por dinero
        @if (filtroAccion(); as f) { &middot; {{ etiqueta(f) }} }
      </h2>
      <div class="mm-h2-acc">
        @if (colaRes(); as c) {
          <span class="mm-cuenta comm-num">
            {{ c.rows.length | number }} de {{ c.total | number }}
            @if (c.has_more) { &middot; las primeras por dinero }
          </span>
        }
        <button type="button" class="mm-lnk" [attr.aria-pressed]="conBloqueadas()" (click)="alternarBloqueadas()">
          {{ conBloqueadas() ? 'Sólo las que se pueden mover' : 'Incluir bloqueadas' }}
        </button>
        @if (filtroAccion()) {
          <button type="button" class="mm-lnk" (click)="filtrarPor(null)">Ver todas las acciones</button>
        }
      </div>
    </div>

    <app-load-state class="dt-scope" [loading]="colaCargando()" [error]="colaError()" [isEmpty]="!colaAgrupada().length"
                    [skeletonRows]="8" errorTitle="No se pudo leer la cola" (retry)="traerCola()"
                    emptyIcon="pi-check-circle" emptyTitle="Nada que proponer con la evidencia de hoy"
                    [emptyHint]="vacioTxt()" [emptyCta]="filtroAccion() ? 'Ver todas las acciones' : null"
                    emptyCtaIcon="pi pi-list" (cta)="filtrarPor(null)">
      <!-- Atributo class y NO styleClass: el gate check-primeng-api.js marca styleClass en
           p-table como retirado en v22. Y sin acentos graves en este comentario. -->
      <p-table [value]="colaAgrupada()" class="p-datatable-sm surf-table surf-table--sticky dt-stack"
               [rowHover]="true" dataKey="key">
        <ng-template #header>
          <tr>
            <th scope="col">Producto</th>
            <th scope="col">Qué hacer</th>
            <th scope="col" class="comm-num">Precio</th>
            <th scope="col" class="comm-num">Propuesto</th>
            <th scope="col" class="comm-num">Costo</th>
            <th scope="col" class="comm-num">Margen vs meta</th>
            <th scope="col" class="comm-num">Dinero en juego</th>
            <th scope="col" class="mm-th-go"><span class="sr-only">Abrir</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-f>
          <tr class="mm-tr" [class.is-bloq]="!f.row.accionable" [class.is-grp]="f.plazas > 1"
              tabindex="0" role="button"
              [attr.aria-expanded]="f.plazas > 1 ? abiertos().has(f.key) : null"
              (click)="clic(f)" (keydown.enter)="clic(f)" (keydown.space)="clic(f, $event)">
            <td class="dt-id" data-label="Producto" role="cell">
              <div class="mm-nom-l">
                <span class="mm-sku">{{ f.row.sku }}</span>
                <span class="mm-nom">{{ f.row.nombre }}</span>
              </div>
              <div class="mm-meta">
                @if (f.plazas > 1) {
                  <span class="mm-grp-n">La misma decisión en {{ f.plazas }} plazas de esta página</span>
                } @else {
                  <span>{{ f.row.sucursal | sucursal }}</span>
                }
                @if (!f.row.accionable) { <span class="mm-bloq">{{ bloqueosTxt(f.row) }}</span> }
              </div>
            </td>
            <td data-label="Qué hacer" role="cell">
              <div class="mm-acc-c">
                <span class="mm-acc-tag">{{ etiqueta(f.row.accion) }}</span>
                <span class="mm-cert" [attr.data-c]="f.row.certeza">{{ certezaTxt(f.row.certeza) }}</span>
              </div>
            </td>
            <td class="comm-num dt-num" data-label="Precio" role="cell">{{ f.row.precio_actual | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="comm-num dt-num" data-label="Propuesto" role="cell">
              @if (propuesto(f.row); as p) {
                <span class="mm-prop">{{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                @if (p.alzaPct !== null) { <div class="mm-delta">+{{ p.alzaPct | number:'1.2-2' }}%</div> }
              } @else { <span class="mm-nd" aria-label="esta acción no propone un precio">&mdash;</span> }
            </td>
            <td class="comm-num mm-dim dt-num" data-label="Costo" role="cell">
              @if (f.row.a1_costo_hoy !== null) {
                {{ f.row.a1_costo_hoy | currency:'MXN':'symbol-narrow':'1.2-2' }}
              } @else { <span class="mm-nd" aria-label="sin costo">n/d</span> }
            </td>
            <td class="comm-num dt-num" data-label="Margen vs meta" role="cell">
              @if (f.row.margen_realizado_pct !== null) {
                <span>{{ f.row.margen_realizado_pct }}%</span>
                <div class="mm-delta" [attr.data-d]="signoDelta(f.row)">{{ deltaTxt(f.row) }}</div>
              } @else { <span class="mm-nd" aria-label="sin margen medido">n/d</span> }
            </td>
            <td class="comm-num dt-num" data-label="Dinero en juego" role="cell">
              <div class="mm-monto">{{ montoTxt(f.monto, f.unidad) }}</div>
              @if (f.row.s1_senal) {
                <div class="mm-s1">{{ senalTxt(f.row.s1_senal) }}</div>
              }
            </td>
            <td class="mm-go dt-actions" aria-hidden="true">{{ f.plazas > 1 ? (abiertos().has(f.key) ? '−' : '+') : '›' }}</td>
          </tr>

          @if (f.plazas > 1 && abiertos().has(f.key)) {
            @for (h of f.hijos; track h.sucursal) {
              <tr class="mm-sub" tabindex="0" role="button"
                  (click)="abrirFila(h)" (keydown.enter)="abrirFila(h)" (keydown.space)="abrirFila(h, $event)">
                <td class="dt-id" data-label="Sucursal" role="cell"><span class="mm-sub-p">{{ h.sucursal | sucursal }}</span></td>
                <td class="mm-dim" data-label="Bloqueo" role="cell">
                  @if (!h.accionable) { <span class="mm-bloq">{{ bloqueosTxt(h) }}</span> }
                </td>
                <td class="comm-num mm-dim dt-num" data-label="Precio" role="cell">{{ h.precio_actual | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="dt-num" data-label="Propuesto" role="cell"></td>
                <td class="comm-num mm-dim dt-num" data-label="Costo" role="cell">
                  @if (h.a1_costo_hoy !== null) { {{ h.a1_costo_hoy | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                </td>
                <td class="comm-num mm-dim dt-num" data-label="Margen vs meta" role="cell">
                  @if (h.margen_realizado_pct !== null) { {{ h.margen_realizado_pct }}% }
                </td>
                <td class="comm-num dt-num" data-label="Dinero en juego" role="cell">{{ montoTxt(montoFila(h), h.monto_unidad) }}</td>
                <td class="mm-go dt-actions" aria-hidden="true">&rsaquo;</td>
              </tr>
            }
          }
        </ng-template>
      </p-table>
    </app-load-state>
  </section>

  <!-- ══ ⭐ LA VENTANA · el expediente del producto ═════════════════════════════════════ -->
  <app-motor-margen-expediente
    [sucursal]="expSuc()" [sku]="expSku()" (cerrado)="cerrar()" />
</div>
  `,
  styles: [`
    /* [PR.V2] El selector segmentado va ARRIBA del encabezado de la pagina, como en
       Almacen y Contabilidad. SIN acentos graves: adentro de un template literal lo TERMINAN. */
    :host { display: block; }
    .pr-tabs { padding-top: var(--sp-3); margin-bottom: var(--sp-3); }
    .mm { display: flex; flex-direction: column; gap: var(--sp-4); }

    .mm-head-acc { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .mm-sec-h { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
    .mm-sec-t {
      font-size: var(--fs-micro); letter-spacing: .08em; text-transform: uppercase;
      font-weight: 700; color: var(--fg-2);
    }
    .mm-sec-s { font-size: var(--fs-xs); color: var(--fg-3); }

    /* ══ FLUJO: tarjetas que COMPARTEN escala de barra ═══════════════════════════════════ */
    .mm-flu {
      display: grid; gap: var(--sp-2); margin-top: var(--sp-2);
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .mm-card {
      display: flex; flex-direction: column; gap: var(--sp-2); align-items: flex-start;
      padding: var(--sp-3); text-align: left; cursor: pointer;
      border: 1px solid var(--border-color); border-radius: var(--r-lg);
      background: var(--surface-card); color: inherit; font: inherit;
      transition: border-color 140ms ease, background-color 140ms ease;
    }
    .mm-card:hover { background: var(--surface-hover); }
    .mm-card.is-sel { border-color: var(--action); }
    .mm-card:focus-visible, .mm-otra:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .mm-card-t { font-size: var(--fs-sm); font-weight: 600; line-height: 1.25; }
    .mm-card-g { font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.35; min-height: 2.5em; }
    .mm-card-m {
      font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.02em;
      font-variant-numeric: tabular-nums;
    }
    .mm-card-bar {
      display: block; width: 100%; height: 4px; border-radius: 2px;
      background: var(--surface-2); overflow: hidden;
    }
    .mm-card-bar-f { display: block; height: 100%; background: var(--action); border-radius: 2px; }
    .mm-card-n { font-size: var(--fs-xs); color: var(--fg-2); font-variant-numeric: tabular-nums; }

    /* ══ OTRAS UNIDADES: aparte, con borde punteado, SIN barra ════════════════════════════ */
    .mm-row2 {
      display: grid; gap: var(--sp-2); margin-top: var(--sp-2);
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 21rem;
    }
    .mm-otra {
      display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2);
      padding: var(--sp-3); text-align: left; cursor: pointer;
      border: 1px dashed var(--neutral-300); border-radius: var(--r-lg);
      background: var(--surface-card); color: inherit; font: inherit;
    }
    .mm-otra:hover { background: var(--surface-hover); }
    .mm-otra.is-sel { border-color: var(--action); }
    .mm-otra-x { font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.55; }
    .mm-otra-x strong { color: var(--fg-1); font-weight: 600; }

    .mm-nodec {
      display: flex; flex-direction: column; gap: var(--sp-1);
      padding: var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-lg); background: var(--surface-2);
    }
    .mm-nodec-r {
      display: flex; justify-content: space-between; gap: var(--sp-3);
      font-size: var(--fs-xs); color: var(--fg-2); font-variant-numeric: tabular-nums;
    }
    .mm-nodec-r em { font-style: normal; color: var(--fg-3); }

    @media (max-width: 68.75rem) {
      .mm-flu { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mm-row2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mm-nodec { grid-column: 1 / -1; }
    }
    @media (max-width: 40rem) {
      .mm-flu, .mm-row2 { grid-template-columns: 1fr; }
    }

    /* ⭐ La CERTEZA se distingue por peso y contraste, no por color de fondo. */
    .mm-cert {
      font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em;
      color: var(--fg-3); font-weight: var(--fw-medium);
    }
    .mm-cert[data-c="aritmetica"] { color: var(--fg-1); font-weight: var(--fw-bold); }
    .mm-cert[data-c="efecto_no_medido"] { color: var(--warn-soft-fg); }
    .mm-cert[data-c="fuera_de_alcance"] { color: var(--fg-3); font-style: italic; }

    /* ══ La declaración de cobertura ════════════════════════════════════════════════════ */
    .mm-cob {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: var(--sp-3); flex-wrap: wrap;
    }
    .mm-cob-l { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
    .mm-cob-l strong { color: var(--fg-1); font-weight: var(--fw-bold); }
    .mm-cob-err { color: var(--warn-soft-fg); }
    .mm-lnk {
      border: none; background: none; padding: 0; cursor: pointer;
      font-size: var(--fs-xs); color: var(--action); font-weight: var(--fw-medium);
    }
    .mm-lnk:hover { text-decoration: underline; }
    .mm-lnk:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 2px; }

    .mm-huecos {
      list-style: none; margin: 0; padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-lg);
      display: flex; flex-direction: column; gap: var(--sp-2);
    }
    .mm-huecos li { display: grid; grid-template-columns: 3rem 12rem minmax(0, 1fr); gap: var(--sp-2); }
    @media (max-width: 47.5rem) { .mm-huecos li { grid-template-columns: 3rem minmax(0, 1fr); } }
    .mm-h-k { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-3); }
    .mm-h-n { font-size: var(--fs-xs); color: var(--fg-1); }
    .mm-h-m { font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.5; }

    /* ══ LA COLA ════════════════════════════════════════════════════════════════════════ */
    .mm-main { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    .mm-h2-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
    .mm-h2 {
      margin: var(--sp-2) 0 0; font-size: var(--fs-micro); font-weight: var(--fw-bold);
      letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3);
    }
    .mm-h2-acc { display: flex; align-items: baseline; gap: var(--sp-3); flex-wrap: wrap; }
    .mm-cuenta { font-size: var(--fs-xs); color: var(--fg-2); }

    .mm-tr { cursor: pointer; }
    .mm-tr.is-grp { background: var(--surface-2); }
    .mm-nom-l { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
    .mm-meta {
      display: flex; align-items: center; gap: var(--sp-2); margin-top: 2px;
      font-size: var(--fs-xs); color: var(--fg-2);
    }
    .mm-grp-n { color: var(--brand-900); font-weight: 600; }
    /* Los dos chips en COLUMNA: pegados en una linea publicaban
       "Corregir la escaleraARITMETICA" sin un solo espacio entre ellos. */
    .mm-acc-c { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
    .mm-acc-tag { font-size: var(--fs-xs); color: var(--fg-1); }
    .mm-dim { color: var(--fg-2); }
    .mm-prop { font-weight: 600; color: var(--fg-1); }
    .mm-monto { font-size: var(--fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
    .mm-delta { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; margin-top: 1px; color: var(--fg-3); }
    .mm-delta[data-d='ok']  { color: var(--ok-fg); }
    .mm-delta[data-d='bad'] { color: var(--bad-fg); }
    .mm-th-go, .mm-go { width: 1.5rem; text-align: right; }
    .mm-go { color: var(--fg-3); font-size: var(--fs-body); line-height: 1; }
    .mm-tr:hover .mm-go { color: var(--action); }
    .mm-sub { cursor: pointer; background: var(--surface-2); }
    .mm-sub:hover { background: var(--surface-hover); }
    .mm-sub-p { padding-left: var(--sp-4); font-size: var(--fs-xs); color: var(--fg-2); }
    .mm-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2); }
    .mm-nom { font-size: var(--fs-sm); color: var(--fg-1); }
    .mm-bloq { font-size: var(--fs-micro); color: var(--warn-soft-fg); }
    tr.is-bloq td { opacity: .66; }
    .mm-s1 { font-size: var(--fs-xs); color: var(--fg-2); }
    /* n/d = no se pudo medir; el guion = la accion no lleva ese dato. */
    .mm-nd { color: var(--fg-3); font-style: italic; }
  `],
})
export class ComercialMotorMargenComponent {
  /** `[NAV.8]` La barra del apartado «Precios». `PageTabs` la esconde si el rol sólo alcanza una. */
  readonly tabs = PRECIOS_APARTADO_TABS;

  private readonly api = inject(MotorMargenService);
  private readonly destroyRef = inject(DestroyRef);

  readonly resumen = signal<ResumenMotor | null>(null);
  readonly reg = signal<RegistroSenales | null>(null);
  readonly regError = signal(false);
  readonly colaRes = signal<ColaRespuesta | null>(null);
  readonly colaCargando = signal(true);
  readonly colaError = signal<string | null>(null);
  /** `[PR.X5]` El par que la ventana está mostrando. Null en cualquiera de los dos = cerrada. */
  readonly expSuc = signal<string | null>(null);
  readonly expSku = signal<string | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly filtroAccion = signal<string | null>(null);
  /**
   * `[PR.V11]` De entrada, sólo lo que se puede mover hoy. Medido el 2026-10-30: de las 200
   * primeras filas por dinero, 137 estaban bloqueadas y las cuatro primeras también. Las
   * bloqueadas no se esconden: se cuentan en cada tarjeta y se ven con un clic.
   */
  readonly conBloqueadas = signal(false);
  readonly verHuecos = signal(false);
  /** Grupos desplegados de la cola. */
  readonly abiertos = signal<Set<string>>(new Set());

  /**
   * `[PR.V3]`+`[PR.V10]` El resumen se parte por la UNIDAD que declara la vista. Antes se
   * adivinaba por qué columna llegaba NULL, y una acción sin flujo caía en «Sin decisión».
   */
  private readonly acciones = computed(() => this.resumen()?.acciones ?? []);
  readonly accionesFlujo = computed(() => this.acciones().filter((a) => a.monto_unidad === 'flujo_30d'));
  readonly accionSaldo = computed(() => this.acciones().find((a) => a.monto_unidad === 'saldo_existencia') ?? null);
  readonly accionVenta = computed(() => this.acciones().find((a) => a.monto_unidad === 'venta_expuesta_30d') ?? null);
  readonly accionesSinDecision = computed(() => this.acciones().filter((a) => a.monto_unidad === null));

  /**
   * La cola agrupada. La lógica vive en `agrupar-cola.ts` y se prueba sola: el conteo de plazas
   * y la suma con NULLs son justo lo que se rompe en silencio.
   */
  readonly colaAgrupada = computed<FilaCola[]>(() => agruparCola(this.colaRes()?.rows ?? []));

  readonly vacioTxt = computed(() => this.conBloqueadas()
    ? 'El triage no encontró ninguna acción defendible con este filtro. No significa que no haya margen: significa que las señales disponibles no alcanzan para sostener una propuesta.'
    : 'No hay ninguna que se pueda mover hoy con este filtro. Puede haber bloqueadas: míralas con «Incluir bloqueadas».');

  /** Lo que NO existe, ordenado para que lo primero sea lo del núcleo del v1. */
  readonly huecos = computed(() => (this.reg()?.senales ?? [])
    .filter((s) => s.estado === 'no_existe' || s.estado === 'refutada')
    .sort((a, b) => Number(b.nucleo) - Number(a.nucleo)));

  /** El mayor flujo de las tarjetas que comparten barra. Nunca divide entre cero. */
  private readonly topFlujo = computed(() => Math.max(
    1, ...this.accionesFlujo().map((a) => Math.abs(Number(a.flujo_libre ?? 0)))));

  /**
   * ⭐ `switchMap`: si alguien cambia de filtro dos veces seguidas, la respuesta vieja se
   * descarta. Antes podían quedar las filas de un filtro bajo el título de otro.
   */
  private readonly pedirCola = new Subject<void>();

  constructor() {
    this.pedirCola.pipe(
      tap(() => { this.colaCargando.set(true); this.colaError.set(null); }),
      switchMap(() => this.api.cola({
        accion: this.filtroAccion() ?? undefined,
        soloLibres: !this.conBloqueadas(),
        limit: 200,
      }).pipe(
        map((c) => ({ c, e: null as string | null })),
        catchError((e: unknown) => of({ c: null, e: this.msg(e) })),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(({ c, e }) => {
      this.colaRes.set(c);
      this.colaError.set(e);
      this.colaCargando.set(false);
    });
    this.recargar();
  }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.resumen().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resumen.set(r); this.cargando.set(false); },
      error: (e) => { this.error.set(this.msg(e)); this.cargando.set(false); },
    });
    this.leerSenales();
    this.traerCola();
  }

  leerSenales(): void {
    this.regError.set(false);
    this.api.senales().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (g) => this.reg.set(g),
      error: () => { this.reg.set(null); this.regError.set(true); },
    });
  }

  traerCola(): void {
    this.abiertos.set(new Set());
    this.pedirCola.next();
  }

  filtrarPor(a: string | null): void {
    this.filtroAccion.set(this.filtroAccion() === a ? null : a);
    this.cerrar();
    this.traerCola();
  }

  alternarBloqueadas(): void {
    this.conBloqueadas.set(!this.conBloqueadas());
    this.traerCola();
  }

  /** Un grupo despliega; una fila sola abre el expediente. */
  clic(f: FilaCola, ev?: Event): void {
    // La barra espaciadora en un role=button no debe además desplazar la página.
    ev?.preventDefault();
    if (f.plazas > 1) {
      const s = new Set(this.abiertos());
      if (s.has(f.key)) s.delete(f.key); else s.add(f.key);
      this.abiertos.set(s);
      return;
    }
    this.abrirFila(f.row);
  }

  abrirFila(r: ColaRow, ev?: Event): void {
    ev?.preventDefault();
    this.expSuc.set(r.sucursal);
    this.expSku.set(r.sku);
  }

  cerrar(): void { this.expSuc.set(null); this.expSku.set(null); }

  /** `[PR.V11]` El precio que el motor propone, sólo en las acciones que proponen uno. */
  propuesto(r: ColaRow): PrecioPropuesto | null { return precioPropuesto(r); }

  /** El dinero de una celda suelta, en su unidad: el MISMO resolvedor que usa el grupo. */
  montoFila(r: ColaRow): number | null {
    const v = montoDe(r);
    return v === null ? null : Number(v);
  }

  /**
   * ⛔ El saldo y la venta expuesta llevan su unidad escrita en la celda: comparten columna con
   * el flujo pero no son lo mismo. Lo que no se pudo medir dice n/d.
   */
  montoTxt(m: number | null, unidad: string | null): string {
    if (m === null || unidad === null) return 'n/d';
    const s = `$${Math.round(m).toLocaleString('es-MX')}`;
    if (unidad === 'saldo_existencia') return `${s} · saldo`;
    if (unidad === 'venta_expuesta_30d') return `${s} · venta`;
    return s;
  }

  signoDelta(r: ColaRow): string {
    if (r.dif_vs_meta_pp === null) return 'nd';
    const d = Number(r.dif_vs_meta_pp);
    return d > 0 ? 'ok' : d < 0 ? 'bad' : 'eq';
  }

  deltaTxt(r: ColaRow): string {
    if (r.dif_vs_meta_pp === null) {
      return r.meta_margen_pct !== null ? `meta ${Number(r.meta_margen_pct).toFixed(2)}%` : '';
    }
    const d = Number(r.dif_vs_meta_pp);
    return `${d > 0 ? '+' : ''}${d.toFixed(2)} pp`;
  }

  /** Un monto del resumen. NULL se dice con un guion: esa acción no lleva esa cifra. */
  pesos(v: string | null): string {
    if (v === null) return '—';
    return `$${Math.round(Number(v)).toLocaleString('es-MX')}`;
  }

  parte(a: AccionResumen): number {
    return Math.round((Math.abs(Number(a.flujo_libre ?? 0)) / this.topFlujo()) * 100);
  }

  /**
   * `[PR.V5]` Qué significa cada verbo, en una línea. Va EN la tarjeta y no en la ayuda:
   * mandar a abrir un cajón para entender la pantalla que ya se está mirando es un clic de más.
   */
  glosa(a: string): string { return glosaAccion(a); }

  etiqueta(a: string): string { return etiquetaAccion(a); }

  certezaTxt(c: string): string { return textoCerteza(c); }

  senalTxt(s: string): string {
    return ({
      deriva_de_costo: 'Deriva del costo',
      contra_meta_de_ficha: 'Contra la meta de la ficha',
      aterrizaje_del_precio: 'Aterrizaje del precio',
      descuento_dado: 'Descuento dado',
    } as Record<string, string>)[s] ?? s;
  }

  bloqueosTxt(r: Pick<ColaRow, 'bloqueos' | 'h3_categoria_iscam' | 'h4_periodo_iscam'>): string {
    // [PR.V15] El de ISCAM dice la categoria y el MES de la medicion: es un dato de un tercero,
    // llega una vez al mes, y sin su fecha se leeria como de hoy.
    const mes = r.h4_periodo_iscam
      ? new Date(r.h4_periodo_iscam).toLocaleDateString('es-MX', { month: 'short', year: 'numeric', timeZone: 'UTC' })
      : null;
    const m: Record<string, string> = {
      sin_existencia: 'sin existencia',
      promocion_vigente: 'promoción vigente',
      movido_hace_menos_de_21_dias: 'movido hace menos de 21 días',
      el_mostrador_lo_reporto_faltante: 'reportado faltante en el mostrador',
      pierde_terreno_en_la_categoria: `pierde terreno en ${r.h3_categoria_iscam ?? 'su categoría'}${mes ? ` (ISCAM ${mes})` : ' (ISCAM)'}`,
    };
    return (r.bloqueos ?? []).map((x) => m[x] ?? x).join(' · ');
  }

  private msg(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo leer el motor de margen.';
  }
}
