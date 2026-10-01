import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PRECIOS_TABS } from '../precios-tabs';
import { agruparCola, type FilaCola } from '../agrupar-cola';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import {
  MotorMargenService, type ResumenMotor, type ColaRow, type DetalleMotor,
  type RegistroSenales, type AccionResumen,
} from '../motor-margen.service';
import {
  ComercialMotorMargenExpedienteComponent,
} from './comercial-motor-margen-expediente.component';

/**
 * `[PR.V1]` — **Motor de margen.** Operations: tabla densa + maestro-detalle.
 *
 * ── Answer-first (§Q.1) ────────────────────────────────────────────────────────────────────
 * No abre con el grid. Abre con **qué se puede hacer hoy, cuánto vale y con qué certeza** —
 * porque la pregunta que alguien trae al entrar no es "cuántas filas hay".
 *
 * ⭐⭐ Y lo segundo que se ve es **lo que el motor NO puede ver**. Una pantalla que sólo muestra
 * las 29 señales cableadas deja creer que ésas son todas las variables que importan. Son 46, y
 * 15 **no existen** — cada una con su motivo. Esa franja no es un adorno: es la diferencia
 * entre un tablero honesto y uno que parece completo.
 *
 * ── ⛔ Lo que esta pantalla NO hace, y se ve ───────────────────────────────────────────────
 * Kepler es read-only (ADR-040): acá **no se cambia ningún precio**. Y el default del triage es
 * `sin_accion_defendible` en el 74.4 % de las celdas — se publica, no se esconde. *Un tablero
 * donde todo es urgente no prioriza nada.*
 *
 * ── El contrato de diseño, contra los cinco tells ──────────────────────────────────────────
 * 1. Sin barra de acento a la izquierda. 2. **No hay cuatro cards iguales**: las acciones son
 * una LISTA y cada renglón lleva la micro-viz que su dato pide — la barra de participación en
 * SVG, 0 KB. 3. Elevación por hairline **o** sombra, nunca las dos, y la sombra sólo en
 * overlays. 4. Cero `font-size` literal: la escala `--fs-*` es estricta. 5. Jerarquía por
 * **tipo y contraste**, nunca por caja ni por color.
 *
 * Más: `tabular-nums` en toda cifra · números a la derecha **y su `<th>` también** con la clase
 * canónica `comm-num` · fila `--row-h-md` · cero zebra · `--action` en un solo rol.
 *
 * ⭐ La **tira de cobertura** del detalle —13 segmentos, uno por familia— es la gráfica que este
 * motor pide: deja *ver* con cuánta evidencia se está opinando de ese SKU.
 */
@Component({
  selector: 'app-comercial-motor-margen',
  standalone: true,
  imports: [CommonModule, PageTabsComponent, TableModule, ButtonModule, SkeletonModule,
    ComercialMotorMargenExpedienteComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div class="surf-page mm">

  <div class="pr-tabs"><app-page-tabs [tabs]="tabs" variant="liquid" /></div>

  <header class="surf-page-head">
    <div class="surf-page-head-text">
      <h1>Motor de margen</h1>
      <p class="surf-page-sub">
        Triage de precio por SKU y plaza: <strong>qué se puede hacer, cuánto vale y con qué
        certeza</strong>. No cambia ningún precio &mdash; la captura sigue siendo en Kepler.
      </p>
    </div>
    <button type="button" pButton class="p-button-text p-button-sm"
            icon="pi pi-refresh" label="Actualizar"
            [loading]="cargando()" (click)="recargar()"></button>
  </header>

  @if (error(); as e) {
    <div class="mm-err" role="alert">
      <span>{{ e }}</span>
      <button type="button" pButton class="p-button-sm p-button-text" label="Reintentar"
              (click)="recargar()"></button>
    </div>
  }

  @if (cargando()) {
    <div class="mm-skel">@for (i of [1,2,3,4,5,6]; track i) { <p-skeleton height="2rem" /> }</div>
  } @else if (resumen(); as r) {

    <!-- ══ 1 · DINERO EN JUEGO — sólo FLUJO, y las barras comparten escala ═══════════ -->
    <div class="mm-sec-h">
      <span class="mm-sec-t">Dinero en juego</span>
      <span class="mm-sec-s">flujo de 30 días &middot; las barras comparten escala</span>
    </div>
    <section class="mm-flu" aria-label="Acciones con flujo de dinero">
      @for (a of accionesFlujo(); track a.accion) {
        <button type="button" class="mm-card" [class.is-sel]="filtroAccion() === a.accion"
                (click)="filtrarPor(a.accion)">
          <span class="mm-card-t">{{ etiqueta(a.accion) }}</span>
          <span class="mm-card-m comm-num">{{ dinero(a) }}</span>
          <span class="mm-card-bar" aria-hidden="true">
            <span class="mm-card-bar-f" [style.width.%]="parte(a)"></span>
          </span>
          <span class="mm-card-n">
            <strong class="comm-num">{{ a.libres | number }}</strong> listas
            &middot; {{ (a.celdas - a.libres) | number }} con bloqueo
          </span>
          <span class="mm-cert" [attr.data-c]="a.certeza">{{ certezaTxt(a.certeza) }}</span>
        </button>
      }
    </section>

    <!-- ══ 2 · SALDO — deliberadamente APARTE: no es la misma unidad ══════════════════ -->
    <div class="mm-row2">
      @if (accionSaldo(); as c) {
        <button type="button" class="mm-saldo-b" [class.is-sel]="filtroAccion() === c.accion"
                (click)="filtrarPor(c.accion)">
          <span class="mm-saldo-l">
            <span class="mm-sec-t">Capital inmovilizado</span>
            <span class="mm-card-m comm-num">{{ soloMonto(c) }}</span>
          </span>
          <span class="mm-saldo-sep" aria-hidden="true"></span>
          <span class="mm-saldo-x">
            <strong>Es un saldo, no un flujo</strong> &mdash; por eso no lleva barra y no se ordena
            contra los de arriba. Convertirlo exige la tasa de costo de capital, que no existe
            (señal <strong>E5</strong>, declarada).
            <span class="comm-num">{{ c.libres | number }}</span> celdas listas de
            <span class="comm-num">{{ c.celdas | number }}</span>.
          </span>
        </button>
      }
      <div class="mm-nodec">
        <span class="mm-sec-t">Sin decisión posible</span>
        @for (a of accionesSinDecision(); track a.accion) {
          <span class="mm-nodec-r">
            <span>{{ etiqueta(a.accion) }}</span>
            <span class="comm-num">{{ a.celdas | number }}</span>
          </span>
        }
        <span class="mm-nodec-r">
          <span>Sin acción defendible <em>el default, y es la mayoría</em></span>
          <span class="comm-num">{{ r.sin_accion.celdas | number }}</span>
        </span>
      </div>
    </div>

    <!-- ══ ⭐⭐ LO QUE EL MOTOR NO PUEDE VER ═══════════════════════════════════════════════ -->
    @if (reg(); as g) {
      <section class="mm-cob">
        <p class="mm-cob-l">
          <strong>{{ g.conteo.cableadas }}</strong> de {{ g.conteo.total }} señales cableadas
          &middot; <strong>{{ g.conteo.no_existen }}</strong> no existen
          &middot; {{ g.conteo.refutadas }} refutadas con medición
          @if (r.total.calculado_al) { &middot; calculado {{ r.total.calculado_al | date:'d MMM HH:mm' }} }
        </p>
        <button type="button" class="mm-lnk" (click)="verHuecos.set(!verHuecos())">
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
    }

    <div class="mm-split" [class.has-det]="!!det()">
      <!-- ══ LA COLA ══════════════════════════════════════════════════════════════════════ -->
      <section class="mm-main">
        <div class="mm-h2-row">
          <h2 class="mm-h2">
            Cola priorizada por dinero
            @if (filtroAccion(); as f) { &middot; {{ etiqueta(f) }} }
          </h2>
          @if (filtroAccion()) {
            <button type="button" class="mm-lnk" (click)="filtrarPor(null)">Ver todas</button>
          }
        </div>

        <!-- ⚠️ Atributo class y NO styleClass: el gate check-primeng-api.js marca styleClass
             en p-table como retirado en v22. No se puede resolver leyendo el codigo -el propio
             CSS de styles.css lo documenta al reves- asi que se usa el atributo DOM, que
             aterriza en el host pase lo que pase. Los selectores son descendentes e igual
             funcionan. (Y este comentario NO lleva acentos graves: adentro de un template
             literal lo TERMINAN. Van nueve veces en este repo.) -->
        <p-table [value]="colaAgrupada()" class="p-datatable-sm surf-table surf-table--sticky"
                 [rowHover]="true" dataKey="key">
          <ng-template #header>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col">Qué hacer</th>
              <th scope="col" class="comm-num">Precio</th>
              <th scope="col" class="comm-num">Costo</th>
              <th scope="col" class="comm-num">Margen vs meta</th>
              <th scope="col" class="comm-num">En juego 30 d</th>
              <th scope="col" class="mm-th-go"><span class="sr-only">Abrir</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr class="mm-tr" [class.is-bloq]="!f.row.accionable" [class.is-grp]="f.plazas > 1"
                [class.is-open]="abiertos().has(f.key)"
                tabindex="0" role="button"
                [attr.aria-expanded]="f.plazas > 1 ? abiertos().has(f.key) : null"
                (click)="clic(f)" (keydown.enter)="clic(f)" (keydown.space)="clic(f)">
              <td>
                <div class="mm-nom-l">
                  <span class="mm-sku">{{ f.plazas > 1 ? f.row.sku : f.row.sucursal + '/' + f.row.sku }}</span>
                  <span class="mm-nom">{{ f.row.nombre }}</span>
                </div>
                <div class="mm-meta">
                  @if (f.plazas > 1) {
                    <span class="mm-grp-n">La misma decisión en {{ f.plazas }} plazas de esta lista</span>
                  } @else {
                    <span>{{ f.row.sucursal }}</span>
                  }
                  @if (!f.row.accionable) { <span class="mm-bloq">{{ bloqueosTxt(f.row.bloqueos) }}</span> }
                </div>
              </td>
              <td>
                <div class="mm-acc-c">
                  <span class="mm-acc-tag">{{ etiqueta(f.row.accion) }}</span>
                  <span class="mm-cert" [attr.data-c]="f.row.certeza">{{ certezaTxt(f.row.certeza) }}</span>
                </div>
              </td>
              <td class="comm-num">{{ f.row.precio_actual | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="comm-num mm-dim">
                @if (f.row.a1_costo_hoy !== null) {
                  {{ f.row.a1_costo_hoy | currency:'MXN':'symbol-narrow':'1.2-2' }}
                } @else { <span class="mm-nd">&mdash;</span> }
              </td>
              <td class="comm-num">
                @if (f.row.margen_realizado_pct !== null) {
                  <span>{{ f.row.margen_realizado_pct }}%</span>
                  <div class="mm-delta" [attr.data-d]="signoDelta(f.row)">{{ deltaTxt(f.row) }}</div>
                } @else { <span class="mm-nd">&mdash;</span> }
              </td>
              <td class="comm-num">
                <div class="mm-monto">{{ montoTxt(f) }}</div>
                @if (f.row.s1_senal) {
                  <div class="mm-s1">{{ senalTxt(f.row.s1_senal) }}</div>
                }
              </td>
              <td class="mm-go" aria-hidden="true">{{ f.plazas > 1 ? (abiertos().has(f.key) ? '−' : '+') : '›' }}</td>
            </tr>

            @if (f.plazas > 1 && abiertos().has(f.key)) {
              @for (h of f.hijos; track h.sucursal) {
                <tr class="mm-sub" tabindex="0" role="button"
                    (click)="abrirFila(h)" (keydown.enter)="abrirFila(h)">
                  <td><span class="mm-sub-p">{{ h.sucursal }}</span></td>
                  <td class="mm-dim">
                    @if (!h.accionable) { <span class="mm-bloq">{{ bloqueosTxt(h.bloqueos) }}</span> }
                  </td>
                  <td class="comm-num mm-dim">{{ h.precio_actual | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td></td>
                  <td class="comm-num mm-dim">
                    @if (h.margen_realizado_pct !== null) { {{ h.margen_realizado_pct }}% }
                  </td>
                  <td class="comm-num">{{ h.monto_en_juego_mxn | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="mm-go" aria-hidden="true">&rsaquo;</td>
                </tr>
              }
            }
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="7">
              <div class="comm-empty">
                <i class="pi pi-check-circle" aria-hidden="true"></i>
                <h3>Nada que proponer con la evidencia de hoy</h3>
                <p>
                  El triage no encontró ninguna acción defendible con este filtro. No significa
                  que no haya margen: significa que las señales disponibles no alcanzan para
                  sostener una propuesta.
                </p>
                <button type="button" pButton class="p-button-sm p-button-text"
                        label="Ver todas las acciones" (click)="filtrarPor(null)"></button>
              </div>
            </td></tr>
          </ng-template>
        </p-table>
      </section>

    </div>

    <!-- ══ ⭐ LA VENTANA · el expediente del SKU ═══════════════════════════════════════ -->
    <app-motor-margen-expediente
      [sucursal]="expSuc()" [sku]="expSku()" (cerrado)="cerrar()" />
  }
</div>
  `,
  styles: [`
    /* [PR.V2] El selector segmentado va ARRIBA del encabezado de la pagina, como en
       Almacen y Contabilidad. El padding horizontal ya lo pone .surf-page: aca solo
       hace falta separarlo del borde superior y del titulo.
       Y SIN acentos graves: adentro de un template literal lo TERMINAN. Van diez. */
    .pr-tabs { padding-top: var(--sp-3); margin-bottom: var(--sp-3); }
    .mm { display: flex; flex-direction: column; gap: var(--sp-4); }

    .mm-err {
      display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      border: 1px solid var(--bad-fg); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--bad-soft-fg);
    }
    .mm-skel { display: flex; flex-direction: column; gap: var(--sp-2); }

    /* ══ [PR.V3] Rotulo de seccion ══════════════════════════════════════════════════════ */
    .mm-sec-h { display: flex; align-items: baseline; gap: var(--sp-2); }
    .mm-sec-t {
      font-size: var(--fs-micro); letter-spacing: .08em; text-transform: uppercase;
      font-weight: 700; color: var(--fg-2);
    }
    .mm-sec-s { font-size: var(--fs-xs); color: var(--fg-3); }

    /* ══ FLUJO: cuatro tarjetas que COMPARTEN escala de barra ═══════════════════════════ */
    .mm-flu {
      display: grid; gap: var(--sp-2); margin-top: var(--sp-2);
      grid-template-columns: repeat(4, minmax(0, 1fr));
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
    .mm-card-t { font-size: var(--fs-sm); font-weight: 600; line-height: 1.25; min-height: 2.2em; }
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

    /* ══ SALDO: aparte, con borde punteado, SIN barra ═══════════════════════════════════ */
    .mm-row2 { display: grid; grid-template-columns: 1fr 21rem; gap: var(--sp-2); }
    .mm-saldo-b {
      display: flex; align-items: center; gap: var(--sp-4);
      padding: var(--sp-3); text-align: left; cursor: pointer;
      border: 1px dashed var(--neutral-300); border-radius: var(--r-lg);
      background: var(--surface-card); color: inherit; font: inherit;
    }
    .mm-saldo-b:hover { background: var(--surface-hover); }
    .mm-saldo-b.is-sel { border-color: var(--action); }
    .mm-saldo-l { display: flex; flex-direction: column; gap: var(--sp-1); flex-shrink: 0; }
    .mm-saldo-sep { width: 1px; align-self: stretch; background: var(--border-color); }
    .mm-saldo-x { font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.55; }
    .mm-saldo-x strong { color: var(--fg-1); font-weight: 600; }

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

    /* ══ LA COLA ════════════════════════════════════════════════════════════════════════ */
    .mm-tr { cursor: pointer; }
    .mm-tr.is-grp { background: var(--surface-2); }
    .mm-nom-l { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
    .mm-meta {
      display: flex; align-items: center; gap: var(--sp-2); margin-top: 2px;
      font-size: var(--fs-xs); color: var(--fg-2);
    }
    .mm-grp-n { color: var(--brand-900); font-weight: 600; }
    /* Los dos chips en COLUMNA: pegados en una linea fue el defecto que publicaba
       "Corregir la escaleraARITMETICA" sin un solo espacio entre ellos. */
    .mm-acc-c { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
    .mm-dim { color: var(--fg-2); }
    .mm-monto { font-size: var(--fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
    .mm-delta { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; margin-top: 1px; }
    .mm-delta[data-d='ok']  { color: var(--ok-fg); }
    .mm-delta[data-d='bad'] { color: var(--bad-fg); }
    .mm-delta[data-d='eq'], .mm-delta[data-d='nd'] { color: var(--fg-3); }
    .mm-th-go, .mm-go { width: 1.5rem; text-align: right; }
    .mm-go { color: var(--fg-3); font-size: var(--fs-body); line-height: 1; }
    .mm-tr:hover .mm-go { color: var(--action); }
    .mm-sub { cursor: pointer; background: var(--surface-2); }
    .mm-sub:hover { background: var(--surface-hover); }
    .mm-sub-p { padding-left: var(--sp-4); font-size: var(--fs-xs); color: var(--fg-2); }

    @media (max-width: 1100px) {
      .mm-flu { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mm-row2 { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .mm-flu { grid-template-columns: 1fr; }
      .mm-saldo-b { flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
      .mm-saldo-sep { display: none; }
    }

    /* ══ Las acciones: una LISTA, no cuatro cards iguales. ═══════════════════════════════ */
    .mm-acc {
      display: flex; flex-direction: column;
      border: 1px solid var(--border-color); border-radius: var(--r-lg);
      overflow: hidden; background: var(--surface-card);
    }
    .mm-acc-row {
      display: grid; align-items: center; gap: var(--sp-3);
      grid-template-columns: minmax(9rem, 1fr) 7.5rem 8rem 7.5rem 6rem;
      padding: 0 var(--sp-3); min-height: var(--row-h-md);
      border: none; border-bottom: 1px solid var(--border-color);
      background: none; text-align: left; width: 100%; cursor: pointer;
      color: inherit; font: inherit;
      transition: background-color 140ms ease;
    }
    .mm-acc-row:last-child { border-bottom: none; }
    .mm-acc-row:hover:not(.is-mute) { background: var(--surface-hover); }
    .mm-acc-row.is-sel { background: var(--surface-hover); }
    .mm-acc-row.is-mute { cursor: default; opacity: .74; }
    .mm-acc-row:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    @media (max-width: 860px) {
      .mm-acc-row { grid-template-columns: minmax(0, 1fr) 6rem 6rem; }
      .mm-acc-row .mm-bar, .mm-acc-row .mm-acc-note { display: none; }
    }

    .mm-acc-nom { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); }
    .mm-acc-n { font-size: var(--fs-sm); color: var(--fg-2); }
    .mm-de { color: var(--fg-3); font-size: var(--fs-micro); }
    .mm-acc-m { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    .mm-acc-note { font-size: var(--fs-micro); color: var(--fg-3); }

    /**
     * ⭐ La CERTEZA es la jerarquía de esta pantalla. Se distingue por peso y contraste, no por
     *    color de fondo: lo aritmético pesa, lo no medido recede.
     */
    .mm-cert {
      font-size: var(--fs-nano); text-transform: uppercase; letter-spacing: .06em;
      color: var(--fg-3); font-weight: var(--fw-medium);
    }
    .mm-cert[data-c="aritmetica"] { color: var(--fg-1); font-weight: var(--fw-bold); }
    .mm-cert[data-c="efecto_no_medido"] { color: var(--warn-soft-fg); }
    .mm-cert[data-c="fuera_de_alcance"] { color: var(--fg-3); font-style: italic; }

    /* Micro-viz en SVG crudo. Sin librería. */
    .mm-bar { width: 100%; height: 4px; display: block; }
    .mm-bar-bg { fill: var(--border-color); }
    .mm-bar-fg { fill: color-mix(in srgb, var(--fg-1) 45%, transparent); }

    /* ══ La declaración de cobertura ════════════════════════════════════════════════════ */
    .mm-cob {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: var(--sp-3); flex-wrap: wrap;
    }
    .mm-cob-l { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
    .mm-cob-l strong { color: var(--fg-1); font-weight: var(--fw-bold); }
    .mm-lnk {
      border: none; background: none; padding: 0; cursor: pointer;
      font-size: var(--fs-xs); color: var(--action); font-weight: var(--fw-medium);
    }
    .mm-lnk:hover { text-decoration: underline; }

    .mm-huecos {
      list-style: none; margin: 0; padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-lg);
      display: flex; flex-direction: column; gap: var(--sp-2);
    }
    .mm-huecos li { display: grid; grid-template-columns: 3rem 12rem minmax(0, 1fr); gap: var(--sp-2); }
    @media (max-width: 760px) { .mm-huecos li { grid-template-columns: 3rem minmax(0, 1fr); } }
    .mm-h-k { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-3); }
    .mm-h-n { font-size: var(--fs-xs); color: var(--fg-1); }
    .mm-h-m { font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.5; }

    /* ══ Maestro-detalle por CSS, sin drawer. ═══════════════════════════════════════════ */
    .mm-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); }
    .mm-split.has-det { grid-template-columns: minmax(0, 1fr) 27rem; }
    @media (max-width: 1150px) { .mm-split.has-det { grid-template-columns: minmax(0, 1fr); } }
    .mm-main { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }

    .mm-h2-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
    .mm-h2 {
      margin: var(--sp-2) 0 0; font-size: var(--fs-micro); font-weight: var(--fw-bold);
      letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3);
    }

    .mm-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2); }
    .mm-nom { font-size: var(--fs-sm); color: var(--fg-1); }
    .mm-bloq { font-size: var(--fs-nano); color: var(--warn-soft-fg); }
    tr.is-bloq td { opacity: .66; }

    .mm-acc-tag { font-size: var(--fs-xs); color: var(--fg-1); }
    .mm-s1 { font-size: var(--fs-xs); color: var(--fg-2); }
    .mm-s1-m { font-size: var(--fs-xs); color: var(--fg-3); margin-left: var(--sp-2); }
    /* El saldo NO es flujo: se distingue en la propia celda. */
    .mm-saldo { color: var(--fg-3); }
    /* Tres glifos, tres significados. n/d = no se pudo medir, con su motivo en el title. */
    .mm-nd { color: var(--fg-3); font-style: italic; }

    /* ══ El detalle ═════════════════════════════════════════════════════════════════════ */
    .mm-det {
      position: sticky; top: var(--sp-4); align-self: start;
      max-height: calc(100vh - var(--sp-8)); overflow: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-lg);
      background: var(--surface-card); padding: var(--sp-4);
      display: flex; flex-direction: column; gap: var(--sp-2);
    }
    .mm-det-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-2); }
    .mm-det-head h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); line-height: 1.25; }
    .mm-det-sub { margin: 0; font-size: var(--fs-micro); color: var(--fg-3); font-family: var(--font-mono); }
    .mm-det-h3 {
      margin: var(--sp-3) 0 0; font-size: var(--fs-micro); font-weight: var(--fw-bold);
      letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3);
    }
    .mm-det-acc { margin: 0; display: flex; align-items: baseline; gap: var(--sp-2); }

    /**
     * ⭐ LA TIRA DE COBERTURA. 13 segmentos, uno por familia. No es una barra de progreso
     *    genérica: cada segmento es una familia concreta y su hueco se puede señalar con el dedo.
     */
    .mm-tira { display: flex; gap: 2px; margin-top: var(--sp-1); }
    .mm-seg {
      flex: 1; height: 10px; border-radius: 1px;
      background: var(--border-color);
    }
    .mm-seg[data-c="completa"] { background: color-mix(in srgb, var(--fg-1) 55%, transparent); }
    .mm-seg[data-c="parcial"] { background: color-mix(in srgb, var(--fg-1) 24%, transparent); }
    .mm-tira-l { margin: 0; font-size: var(--fs-micro); color: var(--fg-3); }
    .mm-tira-l strong { color: var(--fg-1); }

    .mm-nota { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.55; }
    .mm-warn { color: var(--warn-soft-fg); }

    .mm-ap { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    .mm-ap td { padding: var(--sp-1) 0; border-bottom: 1px solid var(--border-color); color: var(--fg-2); }
    .mm-ap tr:last-child td { border-bottom: none; }
    .mm-ap td.comm-num { color: var(--fg-1); font-weight: var(--fw-medium); }
    .mm-ap td.is-neg { color: var(--bad-soft-fg); }

    .mm-fam { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .mm-fam li { padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .mm-fam li:last-child { border-bottom: none; }
    /* Lo que no tiene evidencia recede; no se pinta de rojo — no es un error, es un hueco. */
    .mm-fam li[data-c="sin_dato"] { opacity: .6; }
    .mm-fam-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
    .mm-fam-n { font-size: var(--fs-xs); color: var(--fg-1); }
    .mm-fam-v { font-size: var(--fs-nano); color: var(--fg-3); font-family: var(--font-mono); }
    .mm-fam-m { margin: 2px 0 0; font-size: var(--fs-nano); color: var(--fg-3); line-height: 1.5; }
  `],
})
export class ComercialMotorMargenComponent {
  /** `[PR.V2]` El selector segmentado: el motor y sus experimentos, bajo una sola
   *  entrada del sidebar. `PageTabs` esconde la barra si el rol sólo alcanza una. */
  readonly tabs = PRECIOS_TABS;

  private readonly api = inject(MotorMargenService);
  private readonly destroyRef = inject(DestroyRef);

  readonly resumen = signal<ResumenMotor | null>(null);
  readonly reg = signal<RegistroSenales | null>(null);
  readonly cola = signal<ColaRow[]>([]);
  readonly det = signal<DetalleMotor | null>(null);
  /** `[PR.X5]` El par que la ventana esta mostrando. Null en cualquiera de los dos = cerrada. */
  readonly expSuc = signal<string | null>(null);
  readonly expSku = signal<string | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly filtroAccion = signal<string | null>(null);
  readonly verHuecos = signal(false);
  /** Grupos desplegados de la cola. */
  readonly abiertos = signal<Set<string>>(new Set());

  /**
   * `[PR.V3]` El resumen se parte en TRES porque son tres unidades distintas, y mezclarlas
   * en una sola lista con una sola columna de barras fue el defecto que la pantalla publicaba:
   * $60.46M de SALDO compartiendo escala con $105k de FLUJO dejaba la barra mas grande vacia.
   */
  readonly accionesFlujo = computed(() =>
    (this.resumen()?.acciones ?? []).filter((a) => Math.abs(Number(a.flujo_libre ?? 0)) > 0));

  readonly accionSaldo = computed(() =>
    (this.resumen()?.acciones ?? []).find((a) =>
      !Number(a.flujo_libre ?? 0) && Math.abs(Number(a.capital ?? 0)) > 0) ?? null);

  readonly accionesSinDecision = computed(() =>
    (this.resumen()?.acciones ?? []).filter((a) =>
      !Number(a.flujo_libre ?? 0) && !Number(a.capital ?? 0)));

  /**
   * ⭐ La cola agrupada por SKU cuando la decision es LA MISMA (misma accion y mismo precio).
   *
   * ⚠️ Agrupa SOLO lo que vino en esta pagina, y la etiqueta lo dice: "en N plazas de esta
   *    lista". El servidor manda el top por dinero (limite 200), asi que las plazas chicas del
   *    mismo SKU pueden quedar fuera -- prometer "en N plazas" a secas seria un total falso.
   *    Agrupar del lado del servidor se midio y no se paga: la repeticion en el top 100 real es
   *    del 19% y el grupo mas grande suma $6,897.
   */
  /**
   * La cola agrupada. La logica vive en `agrupar-cola.ts` y se prueba sola: el conteo de plazas
   * y la suma con NULLs son justo lo que se rompe en silencio, y un computed dentro de un
   * componente con servicios inyectados no se puede probar sin montar medio TestBed.
   */
  readonly colaAgrupada = computed<FilaCola[]>(() => agruparCola(this.cola()));

  /** Un grupo despliega; una fila sola abre el expediente. */
  clic(f: FilaCola): void {
    if (f.plazas > 1) {
      const s = new Set(this.abiertos());
      if (s.has(f.key)) s.delete(f.key); else s.add(f.key);
      this.abiertos.set(s);
      return;
    }
    this.abrirFila(f.row);
  }

  abrirFila(r: ColaRow): void {
    this.expSuc.set(r.sucursal);
    this.expSku.set(r.sku);
    this.abrir(r);
  }

  /** El saldo se rotula aparte del flujo; lo que no se pudo medir dice n/d con su motivo. */
  montoTxt(f: FilaCola): string {
    if (f.monto !== null) return `$${Math.round(f.monto).toLocaleString('es-MX')}`;
    const c = f.row.capital_inmovilizado_mxn;
    if (c !== null) return `$${Math.round(Number(c)).toLocaleString('es-MX')} · saldo`;
    return 'n/d';
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

  /** El monto del saldo, sin el sufijo que `dinero()` le pega para distinguirlo del flujo. */
  soloMonto(a: AccionResumen): string {
    const c = Number(a.capital ?? 0);
    return c ? `$${Math.round(c).toLocaleString('es-MX')}` : '—';
  }


  /** Lo que NO existe, ordenado para que lo primero sea lo del núcleo del v1. */
  readonly huecos = computed(() => (this.reg()?.senales ?? [])
    .filter((s) => s.estado === 'no_existe' || s.estado === 'refutada')
    .sort((a, b) => Number(b.nucleo) - Number(a.nucleo)));

  /** El mayor flujo de la lista, para escalar la barra. Nunca divide entre cero. */
  private readonly topFlujo = computed(() => Math.max(
    1, ...(this.resumen()?.acciones ?? []).map((a) => Math.abs(Number(a.flujo_libre ?? 0)))));

  constructor() { this.recargar(); }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.resumen().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resumen.set(r); this.cargando.set(false); },
      error: (e) => { this.error.set(this.msg(e)); this.cargando.set(false); },
    });
    this.api.senales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (g) => this.reg.set(g), error: () => this.reg.set(null) });
    this.traerCola();
  }

  private traerCola(): void {
    this.api.cola({ accion: this.filtroAccion() ?? undefined, limit: 200 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.cola.set(c), error: (e) => this.error.set(this.msg(e)) });
  }

  filtrarPor(a: string | null): void {
    this.filtroAccion.set(this.filtroAccion() === a ? null : a);
    this.cerrar();
    this.traerCola();
  }

  abrir(r: ColaRow | null): void {
    if (!r) { this.det.set(null); return; }
    this.api.detalle(r.sucursal, r.sku).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.det.set(d), error: (e) => this.error.set(this.msg(e)) });
  }

  cerrar(): void { this.det.set(null); this.expSuc.set(null); this.expSku.set(null); }

  /** ⭐ Los tres aportes, ya ordenados por el servidor. Acá sólo se arman para pintarlos. */
  aportes(d: DetalleMotor): { senal: string; mxn: string }[] {
    const a = d.accion;
    return [
      { senal: a.s1_senal, mxn: a.s1_mxn },
      { senal: a.s2_senal, mxn: a.s2_mxn },
      { senal: a.s3_senal, mxn: a.s3_mxn },
    ].filter((x): x is { senal: string; mxn: string } => !!x.senal && x.mxn !== null);
  }

  parte(a: AccionResumen): number {
    return Math.round((Math.abs(Number(a.flujo_libre ?? 0)) / this.topFlujo()) * 100);
  }

  /** El saldo se rotula distinto del flujo: son unidades distintas y no se ordenan juntas. */
  dinero(a: AccionResumen): string {
    const f = Number(a.flujo_libre ?? 0);
    if (f) return `$${Math.round(f).toLocaleString('es-MX')}`;
    const c = Number(a.capital ?? 0);
    if (c) return `$${Math.round(c).toLocaleString('es-MX')} · saldo`;
    return '—';
  }

  etiqueta(a: string): string {
    return ({
      corregir_escalera: 'Corregir la escalera',
      revisar_costo: 'Revisar el costo',
      aterrizar_precio: 'Aterrizar el precio',
      subir_precio: 'Subir el precio',
      liberar_capital: 'Liberar capital',
      precio_atipico: 'Precio atípico',
      sin_accion_defendible: 'Sin acción defendible',
    } as Record<string, string>)[a] ?? a;
  }

  certezaTxt(c: string): string {
    return ({
      aritmetica: 'aritmética',
      efecto_no_medido: 'efecto no medido',
      regla_de_operacion: 'regla de operación',
      fuera_de_alcance: 'fuera de alcance',
      sin_evidencia: 'sin evidencia',
    } as Record<string, string>)[c] ?? c;
  }

  senalTxt(s: string): string {
    return ({
      deriva_de_costo: 'Deriva del costo',
      contra_meta_de_ficha: 'Contra la meta de la ficha',
      aterrizaje_del_precio: 'Aterrizaje del precio',
      descuento_dado: 'Descuento dado',
    } as Record<string, string>)[s] ?? s;
  }

  bloqueosTxt(b: string[] | null | undefined): string {
    const m: Record<string, string> = {
      sin_existencia: 'sin existencia',
      promocion_vigente: 'promoción vigente',
      movido_hace_menos_de_21_dias: 'movido hace menos de 21 días',
      el_mostrador_lo_reporto_faltante: 'reportado faltante en el mostrador',
    };
    return (b ?? []).map((x) => m[x] ?? x).join(' · ');
  }

  private msg(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo leer el motor de margen.';
  }
}
