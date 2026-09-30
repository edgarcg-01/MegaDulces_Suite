import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import {
  MotorMargenService, type ResumenMotor, type ColaRow, type DetalleMotor,
  type RegistroSenales, type AccionResumen,
} from '../motor-margen.service';

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
  imports: [CommonModule, TableModule, ButtonModule, SkeletonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div class="surf-page mm">

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

    <!-- ══ ANSWER-FIRST · qué se puede hacer, y con qué certeza ══════════════════════════ -->
    <section class="mm-acc" aria-label="Acciones disponibles">
      @for (a of r.acciones; track a.accion) {
        <button type="button" class="mm-acc-row" [class.is-sel]="filtroAccion() === a.accion"
                (click)="filtrarPor(a.accion)">
          <span class="mm-acc-nom">{{ etiqueta(a.accion) }}</span>
          <!-- La certeza es la jerarquía: lo aritmético pesa, lo no medido recede. -->
          <span class="mm-cert" [attr.data-c]="a.certeza">{{ certezaTxt(a.certeza) }}</span>
          <span class="mm-acc-n comm-num">{{ a.libres | number }}<span class="mm-de"> de {{ a.celdas | number }}</span></span>
          <span class="mm-acc-m comm-num">{{ dinero(a) }}</span>
          <!-- ⭐ Micro-viz en SVG crudo: participación en el dinero. 0 KB. -->
          <svg class="mm-bar" [attr.viewBox]="'0 0 100 4'" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="1.4" width="100" height="1.2" class="mm-bar-bg"></rect>
            <rect x="0" y="0" [attr.width]="parte(a)" height="4" class="mm-bar-fg"></rect>
          </svg>
        </button>
      }
      <div class="mm-acc-row is-mute">
        <span class="mm-acc-nom">Sin acción defendible</span>
        <span class="mm-cert" data-c="sin_evidencia">sin evidencia</span>
        <span class="mm-acc-n comm-num">{{ r.sin_accion.celdas | number }}</span>
        <span class="mm-acc-m comm-num">&mdash;</span>
        <span class="mm-acc-note">el default, y es la mayoría</span>
      </div>
    </section>

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

        <p-table [value]="cola()" styleClass="p-datatable-sm surf-table surf-table--sticky"
                 [rowHover]="true" selectionMode="single"
                 [(selection)]="seleccion" (selectionChange)="abrir($event)" dataKey="sku">
          <ng-template #header>
            <tr>
              <th scope="col">SKU</th>
              <th scope="col">Producto</th>
              <th scope="col">Qué hacer</th>
              <th scope="col" class="comm-num">Precio</th>
              <th scope="col" class="comm-num">En juego</th>
              <th scope="col">Lo que más pesó</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr [pSelectableRow]="r" [class.is-bloq]="!r.accionable">
              <td class="mm-sku">{{ r.sucursal }}/{{ r.sku }}</td>
              <td>
                <div class="mm-nom">{{ r.nombre }}</div>
                @if (!r.accionable) {
                  <div class="mm-bloq">{{ bloqueosTxt(r.bloqueos) }}</div>
                }
              </td>
              <td>
                <span class="mm-acc-tag">{{ etiqueta(r.accion) }}</span>
                <span class="mm-cert" [attr.data-c]="r.certeza">{{ certezaTxt(r.certeza) }}</span>
              </td>
              <td class="comm-num">{{ r.precio_actual | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="comm-num">
                @if (r.monto_en_juego_mxn !== null) {
                  {{ r.monto_en_juego_mxn | currency:'MXN':'symbol-narrow':'1.0-0' }}
                } @else if (r.capital_inmovilizado_mxn !== null) {
                  <span class="mm-saldo">{{ r.capital_inmovilizado_mxn | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                } @else {
                  <span class="mm-nd" [title]="r.monto_motivo || ''">n/d</span>
                }
              </td>
              <td>
                @if (r.s1_senal) {
                  <span class="mm-s1">{{ senalTxt(r.s1_senal) }}</span>
                  <span class="mm-s1-m comm-num">{{ r.s1_mxn | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                } @else { <span class="mm-nd">&mdash;</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="6">
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

      <!-- ══ EL PLAN DE MARGEN DEL SKU ════════════════════════════════════════════════════ -->
      @if (det(); as d) {
        <aside class="mm-det" aria-label="Plan de margen del producto">
          <div class="mm-det-head">
            <div>
              <h2>{{ d.accion.nombre }}</h2>
              <p class="mm-det-sub">{{ d.accion.sucursal }} &middot; SKU {{ d.accion.sku }}</p>
            </div>
            <button type="button" pButton class="p-button-text p-button-sm" icon="pi pi-times"
                    aria-label="Cerrar" (click)="cerrar()"></button>
          </div>

          <!-- ⭐ LA TIRA DE COBERTURA: con cuánta evidencia se está opinando de este SKU. -->
          <div class="mm-tira" role="img"
               [attr.aria-label]="'Evidencia: ' + d.accion.familias_con_evidencia + ' de ' + d.accion.familias_totales + ' familias'">
            @for (f of d.familias; track f.n) {
              <span class="mm-seg" [attr.data-c]="f.cobertura" [title]="f.nombre + ' — ' + (f.cobertura || 'sin dato')"></span>
            }
          </div>
          <p class="mm-tira-l">
            <strong>{{ d.accion.familias_con_evidencia }}</strong> de
            {{ d.accion.familias_totales }} familias con evidencia
          </p>

          <h3 class="mm-det-h3">Qué hacer</h3>
          <p class="mm-det-acc">
            <span class="mm-acc-tag">{{ etiqueta(d.accion.accion) }}</span>
            <span class="mm-cert" [attr.data-c]="d.accion.certeza">{{ certezaTxt(d.accion.certeza) }}</span>
          </p>
          @if (d.accion.monto_motivo) { <p class="mm-nota">{{ d.accion.monto_motivo }}</p> }
          @if (d.accion.bloqueos?.length) {
            <p class="mm-nota mm-warn">Bloqueado por: {{ bloqueosTxt(d.accion.bloqueos) }}</p>
          }

          <!-- ⭐⭐ R7: las tres señales que más pesaron, MEDIDAS EN PESOS. -->
          <h3 class="mm-det-h3">Lo que más pesó, en pesos</h3>
          @if (d.accion.s1_senal) {
            <table class="mm-ap">
              <tbody>
                @for (a of aportes(d); track a.senal) {
                  <tr>
                    <td>{{ senalTxt(a.senal) }}</td>
                    <td class="comm-num" [class.is-neg]="(+a.mxn) < 0">
                      {{ a.mxn | currency:'MXN':'symbol-narrow':'1.0-0' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="mm-nota">
              El orden lo da el <strong>dinero</strong>, no un coeficiente: no hay pesos
              inventados en este motor.
            </p>
          } @else {
            <p class="mm-nota">
              <span class="mm-nd">n/d</span> &mdash; ninguna señal de este SKU se pudo expresar
              en pesos sobre la venta de 30 días.
            </p>
          }

          <h3 class="mm-det-h3">Las 13 familias de señales</h3>
          <ul class="mm-fam">
            @for (f of d.familias; track f.n) {
              <li [attr.data-c]="f.cobertura">
                <div class="mm-fam-h">
                  <span class="mm-fam-n">{{ f.nombre }}</span>
                  <span class="mm-fam-v">{{ f.veredicto || 'n/d' }}</span>
                </div>
                @if (f.motivo) { <p class="mm-fam-m">{{ f.motivo }}</p> }
              </li>
            }
          </ul>
        </aside>
      }
    </div>
  }
</div>
  `,
  styles: [`
    .mm { display: flex; flex-direction: column; gap: var(--sp-4); }

    .mm-err {
      display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      border: 1px solid var(--bad-fg); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--bad-soft-fg);
    }
    .mm-skel { display: flex; flex-direction: column; gap: var(--sp-2); }

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
  private readonly api = inject(MotorMargenService);
  private readonly destroyRef = inject(DestroyRef);

  readonly resumen = signal<ResumenMotor | null>(null);
  readonly reg = signal<RegistroSenales | null>(null);
  readonly cola = signal<ColaRow[]>([]);
  readonly det = signal<DetalleMotor | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly filtroAccion = signal<string | null>(null);
  readonly verHuecos = signal(false);
  seleccion: ColaRow | null = null;

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

  cerrar(): void { this.det.set(null); this.seleccion = null; }

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
