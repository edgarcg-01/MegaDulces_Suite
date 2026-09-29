import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, ViewChild,
  computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { AuthService } from '../../../core/services/auth.service';
import {
  FaltantesService, MOTIVOS, ETIQUETA_MOTIVO, ETIQUETA_DECISION,
  type CodigoQueFalla, type ConsultaFaltante, type Faltante, type MotivoUi,
  type ReportarResultado, type StockoutDecision, type StockoutKind,
} from '../faltantes.service';
import { VerificadorService, type SucursalVerificador } from '../verificador.service';

type Pestana = 'reportar' | 'nocat' | 'fallan';
type Aviso = { tono: 'ok' | 'warn' | 'bad' | 'info'; texto: string; detalle?: string } | null;
type Hallado = { codigo: string; nombre: string; precio: number | null; unidad: string | null };

/**
 * `[FLT.9]` LISTA DE FALTANTES (`/tienda/faltantes`) — el kiosco donde el piso registra la venta
 * que NO ocurrió.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Todo lo demás en esta suite se deriva del ERP. Esto no puede: una venta que no pasó no deja
 * rastro en ninguna fuente — no hay ticket, no hay movimiento, no hay renglón en `kepler_ods`. El
 * cliente preguntó, no lo había, y se fue. **La persona del mostrador es el único instrumento
 * capaz de registrar ese hecho**, y por eso esta pantalla es de captura y no de reporte.
 *
 * ── `[FLT.2x]` Lo que cambió después de medir cinco días en producción ──────────────────────
 * La primera versión era un FORMULARIO: pedía capturar y contestaba "gracias". Todo el beneficio
 * caía en Compras, tres días después. Medido: **9 reportes en 5 días, 3 de cuentas de prueba, y
 * UNA sola persona de piso de 19 cajeras**. Nadie hace captura para beneficio ajeno con un cliente
 * enfrente. Tres correcciones, cada una con su medición:
 *
 *  · **La pantalla contesta primero** (`[FLT.22]`): al resolver el producto dice si hay existencia,
 *    que es la pregunta que trae a la cajera y al anaquelista — *¿vale la pena ir a la bodega?*
 *    El reporte queda como consecuencia de una consulta útil, no como trámite.
 *  · **Una sola caja** (`[FLT.20]`): código, clave y nombre entran por el mismo campo y el
 *    catálogo se despliega para tocarlo. Antes el nombre vivía en otra pestaña que ni siquiera
 *    llevaba a reportar.
 *  · **«Producto no catalogado» con entrada directa** (`[FLT.20]`): antes el texto libre sólo
 *    aparecía DESPUÉS de que un código fallara — y un producto que no vendemos no tiene código
 *    que escanear. Medido: **0 de 9** reportes usaron ese motivo, el que justifica la fase.
 *
 * ── Tres pestañas, un solo oficio ────────────────────────────────────────────────────────────
 *  1. **Reportar** — una caja para todo, la respuesta de existencia, y el motivo en un toque.
 *  2. **Producto no catalogado** — lo único que ningún feed puede ver.
 *  3. **Los que no pasan** — la herramienta de caja. ⚠️ NO es "los productos sin código de barras":
 *     eso se midió (2026-09-19) y son **139 SKUs = 1.5% del catálogo** que valen **0.01% de la
 *     venta** de 90 días, y la mayoría ni son mercancía (códigos de promoción, etiquetas de
 *     anaquel). La lista que sí ahorra búsquedas es ésta: la de los que **de verdad fallan**,
 *     medida por frecuencia real en SU sucursal.
 *
 * ── Superficie ───────────────────────────────────────────────────────────────────────────────
 * DESIGN Operations §O.3 (Mostrador/POS): keyboard-first, el foco vuelve solo a la captura, los
 * blancos de toque son grandes porque se usa con prisa y a veces con guantes.
 *
 * ⚠️ **Decisión de diseño que queda ABIERTA para Edgar.** Esta pantalla usa los tokens estándar de
 * Operations (Hanken Grotesk, Geist Mono, zinc, sunset) y respeta el modo oscuro. NO copia la piel
 * del verificador (Sniglet, paleta `--vf-*`, tema claro fijo), porque esa es una **excepción
 * autorizada explícitamente** para esa pantalla y su propio comentario dice «no repetir el patrón
 * en otro módulo sin la misma autorización». Si el mostrador quiere las dos pantallas idénticas,
 * es una decisión de Edgar y se aplica después — cambiar la piel no toca ninguna de las reglas de
 * correctud de acá.
 *
 * ── Sin modo sin red, a propósito ────────────────────────────────────────────────────────────
 * Reportar ESCRIBE. Una escritura guardada sólo en el navegador de una caja es un dato que nadie
 * va a ver nunca, así que un fallo de red se DICE y se deja reintentar — no se finge guardado.
 * La pestaña de búsqueda sí funciona sin red, porque sólo lee.
 */
@Component({
  selector: 'app-tienda-faltantes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fl-page">

      <!-- ── Cabecera: sucursal + pestañas ─────────────────────────────────────────── -->
      <header class="fl-head">
        <div class="fl-title">
          <h1>Lista de faltantes</h1>
          <p>Lo que el cliente pidió y no había. Llega a Compras.</p>
        </div>
        <div class="fl-head-right">
          <p-select
            [options]="sucursales()" [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)"
            optionLabel="nombre" optionValue="codigo" placeholder="Sucursal"
            styleClass="fl-sel" [filter]="sucursales().length > 8" appendTo="body"
            ariaLabel="Sucursal donde se reporta">
          </p-select>
        </div>
      </header>

      <nav class="fl-tabs" role="tablist" aria-label="Secciones de faltantes">
        @for (t of TABS; track t.id) {
          <button type="button" role="tab" class="fl-tab" [class.on]="pestana() === t.id"
                  [attr.aria-selected]="pestana() === t.id" (click)="irA(t.id)">
            <i [class]="t.icon" aria-hidden="true"></i><span>{{ t.label }}</span>
          </button>
        }
      </nav>

      <!-- Sin sucursal no se puede hacer nada: el mismo código tiene precio y surtido distinto
           por plaza, y adivinarla escribiría el faltante en la tienda equivocada. -->
      @if (!sucursal()) {
        <div class="fl-empty">
          <i class="pi pi-map-marker" aria-hidden="true"></i>
          <p><strong>Elige la sucursal para empezar.</strong></p>
          <span>Cada tienda maneja su propio surtido, así que la pantalla no la adivina.</span>
        </div>
      } @else {

      <!-- ══ 1. REPORTAR ═════════════════════════════════════════════════════════════ -->
      @if (pestana() === 'reportar') {
        <section class="fl-card">
          <label class="fl-lbl" for="fl-code">¿Qué te pidieron?</label>

          <!-- UNA sola caja: la pistola dispara y manda Enter, la clave se teclea, y el nombre
               despliega el catálogo para tocar el producto. Antes eran dos pestañas distintas y
               la de nombre ni siquiera llevaba a reportar. -->
          <div class="fl-capture">
            <input #captura id="fl-code" type="text" class="fl-input" [ngModel]="termino()"
                   (ngModelChange)="alEscribir($event)" (keyup.enter)="resolver()"
                   [disabled]="buscando()" placeholder="Escanea, o escribe la clave o el nombre"
                   autocomplete="off" aria-describedby="fl-capture-help" />
            <p-button label="Buscar" icon="pi pi-search" (onClick)="resolver()"
                      [loading]="buscando()" [disabled]="!termino().trim()" styleClass="fl-btn-main" />
          </div>
          <small id="fl-capture-help" class="fl-help">
            Si no aparece porque no lo vendemos, usa
            <button type="button" class="fl-link" (click)="irA('nocat')">producto no catalogado</button>.
          </small>

          @if (avisoCaptura(); as a) {
            <div class="fl-aviso" [class]="'t-' + a.tono" role="status">
              <strong>{{ a.texto }}</strong>
              @if (a.detalle) { <span>{{ a.detalle }}</span> }
            </div>
          }

          <!-- Catálogo filtrado por nombre: se toca el producto y pasa a la respuesta. -->
          @if (!encontrado() && resultados().length) {
            <ul class="fl-res" role="list">
              @for (r of resultados(); track r.codigo) {
                <li>
                  <button type="button" class="fl-res-row" (click)="usarResultado(r)">
                    <span class="fl-res-sku">{{ r.codigo }}</span>
                    <span class="fl-res-name">{{ r.nombre }}</span>
                    <span class="fl-res-price">
                      @if (r.precio !== null) {
                        {{ r.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                      } @else { <em class="fl-muted">sin precio</em> }
                    </span>
                  </button>
                </li>
              }
            </ul>
          }

          <!-- ⭐ La RESPUESTA antes de pedir nada. Es lo que hace que la pantalla le sirva a
               quien la abre: contesta si vale la pena caminar a la bodega. -->
          @if (encontrado(); as p) {
            <div class="fl-prod">
              <span class="fl-prod-sku">{{ p.codigo }}</span>
              <span class="fl-prod-name">{{ p.nombre }}</span>
              @if (p.precio !== null) {
                <span class="fl-prod-price">{{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
              }
            </div>

            @if (consulta(); as c) {
              <div class="fl-veredicto" [class]="'v-' + (c.veredicto ?? 'no_medido')" role="status">
                @switch (c.veredicto) {
                  @case ('hay_en_tienda') {
                    <i class="pi pi-check-circle" aria-hidden="true"></i>
                    <div class="fl-ver-txt">
                      <strong>Sí hay en la tienda: {{ c.existencia }}</strong>
                      <span>Pídelo a piso o a bodega — la venta se puede salvar ahora.</span>
                    </div>
                  }
                  @case ('sin_existencia') {
                    <i class="pi pi-times-circle" aria-hidden="true"></i>
                    <div class="fl-ver-txt">
                      <strong>No hay en la tienda</strong>
                      <span>Existencia 0. Esto le toca a Compras.</span>
                    </div>
                  }
                  @case ('no_medido') {
                    <!-- "no sé" NUNCA se dibuja como "no hay": mandan a hacer cosas opuestas. -->
                    <i class="pi pi-question-circle" aria-hidden="true"></i>
                    <div class="fl-ver-txt">
                      <strong>No se pudo consultar la existencia</strong>
                      <span>No es cero: es que no se pudo leer. Conviene ir a revisar.</span>
                    </div>
                  }
                  @default {
                    <!-- El verificador lo encontró y el catálogo del servidor no. Pasa, porque no
                         resuelven por la misma tabla. Sin este caso el @switch no pinta nada y
                         queda una caja de color VACÍA, que se lee como que ya contestó algo. -->
                    <i class="pi pi-question-circle" aria-hidden="true"></i>
                    <div class="fl-ver-txt">
                      <strong>No se pudo confirmar la existencia</strong>
                      <span>El catálogo del servidor no resolvió ese código. No es cero.</span>
                    </div>
                  }
                }
              </div>
            }
          }

          @if (encontrado() || textoLibre().trim()) {
            <p class="fl-lbl fl-lbl-sep">{{ encontrado() ? '¿Qué pasó?' : '¿Por qué no se vendió?' }}</p>
            <div class="fl-motivos">
              @for (m of motivosVisibles(); track m.kind) {
                <button type="button" class="fl-motivo" (click)="reportar(m.kind)"
                        [disabled]="enviando()" [attr.aria-label]="m.label + ': ' + m.ayuda">
                  <i [class]="m.icon" aria-hidden="true"></i>
                  <span class="fl-motivo-l">{{ m.label }}</span>
                  <span class="fl-motivo-a">{{ m.ayuda }}</span>
                </button>
              }
            </div>
            @if (encontrado()) {
              <button type="button" class="fl-link fl-descartar" (click)="limpiarTodo()">
                Ya lo resolví, no hace falta reportar
              </button>
            }
          }
        </section>

        <!-- Confirmación: lo que se guardó, en los términos de quien lo reportó. -->
        @if (ultimo(); as u) {
          <section class="fl-card fl-ok" role="status" aria-live="polite">
            <div class="fl-ok-head">
              <i class="pi pi-check-circle" aria-hidden="true"></i>
              <strong>Reportado</strong>
              <span class="fl-ok-kind">{{ etiquetaMotivo(u.kind) }}</span>
            </div>
            <p class="fl-ok-name">{{ u.product_name || 'Sin nombre' }}</p>
            <div class="fl-ok-facts">
              <span><b>{{ u.times_reported }}</b> {{ u.times_reported === 1 ? 'vez' : 'veces' }} esta semana</span>
              @if (u.est_lost_revenue !== null) {
                <span>Venta perdida estimada <b>{{ u.est_lost_revenue | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</b></span>
              } @else {
                <!-- Nunca $0: no tener precio con qué valorar NO es valer cero (ADR-056). -->
                <span class="fl-muted">Sin precio para valorarlo</span>
              }
            </div>
            @if (u.contradice_al_erp) {
              <p class="fl-contra">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                El sistema dice que sí hay <b>{{ u.on_hand_at_report }}</b>.
                Puede estar guardado o mal contado — se revisa como diferencia de inventario.
              </p>
            }
          </section>
        }
      }

      <!-- ══ 2. PRODUCTO NO CATALOGADO ══════════════════════════════════════════════
           Entrada DIRECTA, sin escaneo previo. Antes el texto libre sólo aparecía después de
           que un código fallara — y un producto que no vendemos no tiene código que escanear.
           Medido: 0 de 9 reportes usaron este motivo, el que justifica la fase entera. -->
      @if (pestana() === 'nocat') {
        <section class="fl-card">
          <h2 class="fl-h2">El cliente pidió algo que no vendemos</h2>
          <p class="fl-sub">
            Escríbelo como lo dijo. Esto es lo único que ningún sistema puede ver solo: nadie lo
            compra, así que no deja rastro en ninguna parte.
          </p>

          <label class="fl-lbl" for="fl-nocat">¿Qué te pidieron?</label>
          <input id="fl-nocat" type="text" class="fl-input" [ngModel]="textoLibre()"
                 (ngModelChange)="textoLibre.set($event)"
                 placeholder="Ej: gomitas de chamoy marca Lucas" autocomplete="off" />

          @if (avisoNoCat(); as a) {
            <div class="fl-aviso" [class]="'t-' + a.tono" role="status">
              <strong>{{ a.texto }}</strong>
              @if (a.detalle) { <span>{{ a.detalle }}</span> }
            </div>
          }

          <div class="fl-motivos">
            <button type="button" class="fl-motivo" (click)="reportarNoCatalogado()"
                    [disabled]="enviando() || !textoLibre().trim()"
                    aria-label="Reportar producto no catalogado">
              <i class="pi pi-question-circle" aria-hidden="true"></i>
              <span class="fl-motivo-l">No lo trabajamos</span>
              <span class="fl-motivo-a">Avisar a Compras para que lo evalúen</span>
            </button>
          </div>
        </section>
      }

      <!-- ══ 3. LOS QUE NO PASAN ═════════════════════════════════════════════════════ -->
      @if (pestana() === 'fallan') {
        <section class="fl-card">
          <h2 class="fl-h2">Códigos que no pasan en esta tienda</h2>
          <p class="fl-sub">
            Ordenados por las veces que fallaron de verdad. Ténlos a la mano para no buscar a mano.
          </p>

          @if (cargandoFallan()) {
            <div class="fl-skel" aria-hidden="true">
              @for (i of [1,2,3,4,5]; track i) { <div class="fl-skel-row"></div> }
            </div>
          } @else if (!fallan().length) {
            <div class="fl-empty sm">
              <i class="pi pi-check-circle" aria-hidden="true"></i>
              <p><strong>Todavía no hay ninguno.</strong></p>
              <span>Cada vez que un código no pase, repórtalo y aparecerá aquí.</span>
            </div>
          } @else {
            <table class="fl-tabla">
              <thead>
                <tr><th scope="col">Clave</th><th scope="col">Producto</th>
                    <th scope="col">Código leído</th><th scope="col" class="num">Veces</th></tr>
              </thead>
              <tbody>
                @for (f of fallan(); track f.scanned_code || f.sku) {
                  <tr>
                    <td class="mono">{{ f.sku || '—' }}</td>
                    <td>{{ f.product_name || 'Sin nombre' }}</td>
                    <td class="mono">{{ f.scanned_code || '—' }}</td>
                    <td class="num mono"><b>{{ f.veces }}</b></td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        <!-- Lo reportado en la sucursal: el encargado ve qué pasó y qué contestó Compras. -->
        <section class="fl-card">
          <h2 class="fl-h2">Lo reportado en esta tienda</h2>
          @if (!mios().length) {
            <div class="fl-empty sm">
              <i class="pi pi-inbox" aria-hidden="true"></i>
              <p><strong>Nada reportado en las últimas 4 semanas.</strong></p>
            </div>
          } @else {
            <table class="fl-tabla">
              <thead>
                <tr><th scope="col">Producto</th><th scope="col">Motivo</th>
                    <th scope="col" class="num">Veces</th><th scope="col">Respuesta de Compras</th></tr>
              </thead>
              <tbody>
                @for (m of mios(); track m.id) {
                  <tr>
                    <td>{{ m.product_name || m.scanned_code || 'Sin nombre' }}</td>
                    <td><p-tag [value]="etiquetaMotivo(m.kind)" [severity]="severidad(m.kind)" /></td>
                    <td class="num mono"><b>{{ m.times_reported }}</b></td>
                    <td>
                      @if (m.decision) {
                        <span class="fl-dec">{{ etiquetaDecision(m.decision) }}</span>
                        @if (m.decision_note) { <span class="fl-dec-note">{{ m.decision_note }}</span> }
                      } @else {
                        <span class="fl-muted">Todavía sin respuesta</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }

      }
    </div>
  `,
  styles: [`
    /* Operations (DESIGN §O). Cero hex crudo: todo por token, para que dark funcione solo. */
    .fl-page { padding: 1rem 1.15rem 2rem; max-width: 62rem; margin: 0 auto;
      display: flex; flex-direction: column; gap: 1rem; }

    .fl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .fl-title h1 { font-size: var(--fs-lg, 1.15rem); font-weight: 800; margin: 0; color: var(--text-main); }
    .fl-title p { margin: .2rem 0 0; font-size: var(--fs-sm, .82rem); color: var(--text-muted); }

    .fl-tabs { display: flex; gap: .35rem; border-bottom: 1px solid var(--border-color); }
    .fl-tab { display: inline-flex; align-items: center; gap: .4rem; background: none; border: 0;
      border-bottom: 2px solid transparent; padding: .6rem .8rem; min-height: var(--tap-min, 44px);
      font: inherit; font-size: var(--fs-sm, .82rem); font-weight: 700; color: var(--text-muted);
      cursor: pointer; transition: color 150ms ease-out, border-color 150ms ease-out; }
    .fl-tab:hover { color: var(--text-main); }
    .fl-tab.on { color: var(--action); border-bottom-color: var(--action); }
    .fl-tab:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; border-radius: var(--r-sm, 6px); }

    .fl-card { border: 1px solid var(--border-color); border-radius: var(--r-md, 10px);
      background: var(--card-bg); padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .6rem; }

    .fl-h2 { font-size: var(--fs-sm, .82rem); text-transform: uppercase; letter-spacing: .06em;
      color: var(--text-muted); font-weight: 700; margin: 0; }
    .fl-sub { margin: 0; font-size: var(--fs-sm, .8rem); color: var(--text-muted); }
    .fl-lbl { font-size: var(--fs-sm, .8rem); font-weight: 700; color: var(--text-main); }
    .fl-lbl-sep { margin: .4rem 0 0; }
    .fl-help { font-size: var(--fs-xs, .72rem); color: var(--text-muted); }
    .fl-muted { color: var(--text-muted); }

    .fl-link { background: none; border: 0; padding: 0; font: inherit; color: var(--action);
      text-decoration: underline; cursor: pointer; }
    .fl-link:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    .fl-capture { display: flex; gap: .5rem; align-items: stretch; flex-wrap: wrap; }
    /* ⚠️ El flex va SOLO dentro de la fila de captura. Puesto en .fl-input a secas, el input de
       la pestaña de búsqueda —que cuelga directo de .fl-card, un flex COLUMNA— tomaba flex-grow 1
       sobre el eje vertical y se estiraba a todo el alto de la tarjeta.
       SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y lo cierran. */
    .fl-capture .fl-input { flex: 1 1 14rem; }
    .fl-input { width: 100%; min-height: var(--tap-min, 44px); padding: .5rem .8rem;
      font-family: var(--font-mono); font-size: 1rem; font-variant-numeric: tabular-nums;
      color: var(--text-main); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); }
    .fl-input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .fl-input:disabled { opacity: .6; cursor: not-allowed; }

    /* Aviso: color NUNCA es el único portador — siempre lleva texto que lo explica. */
    .fl-aviso { display: flex; flex-direction: column; gap: .15rem; padding: .6rem .8rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      font-size: var(--fs-sm, .82rem); }
    .fl-aviso span { color: var(--text-muted); font-size: var(--fs-xs, .74rem); }
    .fl-aviso.t-ok   { border-color: color-mix(in srgb, var(--ok-fg) 45%, transparent); }
    .fl-aviso.t-warn { border-color: color-mix(in srgb, var(--warn-fg) 45%, transparent); }
    .fl-aviso.t-bad  { border-color: color-mix(in srgb, var(--bad-fg) 45%, transparent); }

    .fl-prod { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap;
      padding: .6rem .8rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); }
    .fl-prod-sku { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm, .8rem); color: var(--text-muted); }
    .fl-prod-name { font-weight: 700; color: var(--text-main); flex: 1 1 12rem; }
    .fl-prod-price { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 800; color: var(--text-main); }

    /* Blancos grandes: se usa con prisa, de pie y a veces con guantes. */
    .fl-motivos { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .5rem; }
    .fl-motivo { display: flex; flex-direction: column; align-items: flex-start; gap: .1rem;
      min-height: 4.2rem; padding: .7rem .8rem; text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      transition: border-color 150ms ease-out, transform 150ms ease-out; }
    .fl-motivo i { color: var(--text-muted); font-size: .85rem; }
    .fl-motivo:hover:not(:disabled) { border-color: var(--action); }
    .fl-motivo:active:not(:disabled) { transform: translateY(1px); }
    .fl-motivo:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .fl-motivo:disabled { opacity: .55; cursor: progress; }
    .fl-motivo-l { font-weight: 700; font-size: var(--fs-md, .92rem); }
    .fl-motivo-a { font-size: var(--fs-xs, .72rem); color: var(--text-muted); }

    .fl-libre { display: flex; flex-direction: column; gap: .35rem; }

    /* La RESPUESTA. Es lo primero que la persona necesita leer, así que pesa más que el resto:
       tipografía más grande y un borde de color que NUNCA va solo (siempre con icono y texto). */
    .fl-veredicto { display: flex; align-items: flex-start; gap: .6rem; padding: .8rem 1rem;
      border: 1px solid var(--border-color); border-left-width: 4px; border-radius: var(--r-sm, 8px); }
    .fl-veredicto i { font-size: 1.25rem; margin-top: .1rem; }
    .fl-ver-txt { display: flex; flex-direction: column; gap: .1rem; }
    .fl-ver-txt strong { font-size: var(--fs-md, 1rem); color: var(--text-main); }
    .fl-ver-txt span { font-size: var(--fs-sm, .82rem); color: var(--text-muted); }
    .fl-veredicto.v-hay_en_tienda { border-left-color: var(--ok-fg); }
    .fl-veredicto.v-hay_en_tienda i { color: var(--ok-fg); }
    .fl-veredicto.v-sin_existencia { border-left-color: var(--bad-fg); }
    .fl-veredicto.v-sin_existencia i { color: var(--bad-fg); }
    /* "No sé" tiene su propio color a propósito: no es el rojo de "no hay" (ADR-056). */
    .fl-veredicto.v-no_medido { border-left-color: var(--warn-fg); }
    .fl-veredicto.v-no_medido i { color: var(--warn-fg); }

    .fl-descartar { align-self: flex-start; font-size: var(--fs-sm, .8rem); margin-top: .2rem; }

    .fl-ok { border-color: color-mix(in srgb, var(--ok-fg) 45%, transparent); }
    .fl-ok-head { display: flex; align-items: center; gap: .45rem; font-size: var(--fs-md, .92rem); }
    .fl-ok-head i { color: var(--ok-fg); }
    .fl-ok-kind { font-size: var(--fs-xs, .72rem); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: 999px; padding: .1rem .5rem; }
    .fl-ok-name { margin: 0; font-weight: 700; color: var(--text-main); }
    .fl-ok-facts { display: flex; gap: 1rem; flex-wrap: wrap; font-size: var(--fs-sm, .82rem);
      color: var(--text-muted); }
    .fl-ok-facts b { color: var(--text-main); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .fl-contra { margin: 0; display: flex; align-items: flex-start; gap: .4rem;
      font-size: var(--fs-sm, .8rem); color: var(--text-main); }
    .fl-contra i { color: var(--warn-fg); margin-top: .15rem; }
    .fl-contra b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .fl-res { list-style: none; margin: 0; padding: 0; max-height: 26rem; overflow-y: auto; }
    .fl-res-row { display: grid; grid-template-columns: 5rem 1fr auto; gap: .6rem; align-items: baseline;
      width: 100%; min-height: var(--tap-min, 44px); padding: .5rem .3rem; text-align: left;
      background: none; border: 0; border-bottom: 1px solid var(--border-color);
      color: var(--text-main); font: inherit; cursor: pointer; }
    .fl-res-row:hover { background: color-mix(in srgb, var(--text-main) 4%, transparent); }
    .fl-res-row:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .fl-res-sku, .fl-res-price { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm, .8rem); }
    .fl-res-sku { color: var(--text-muted); }
    .fl-res-price { font-weight: 700; text-align: right; }
    .fl-res-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .fl-tabla { width: 100%; border-collapse: collapse; font-size: var(--fs-sm, .82rem); }
    .fl-tabla th { text-align: left; font-size: var(--fs-xs, .7rem); text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-muted); font-weight: 700;
      padding: .4rem .5rem; border-bottom: 1px solid var(--border-color); position: sticky; top: 0;
      background: var(--card-bg); }
    .fl-tabla td { padding: .45rem .5rem; border-bottom: 1px solid var(--border-color);
      color: var(--text-main); vertical-align: top; }
    .fl-tabla .num { text-align: right; }
    .fl-tabla .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .fl-dec { font-weight: 700; }
    .fl-dec-note { display: block; font-size: var(--fs-xs, .72rem); color: var(--text-muted); }

    .fl-empty { display: flex; flex-direction: column; align-items: center; gap: .3rem;
      padding: 2.5rem 1rem; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-color); border-radius: var(--r-md, 10px); }
    .fl-empty.sm { padding: 1.5rem 1rem; border: 0; }
    .fl-empty i { font-size: 1.4rem; }
    .fl-empty p { margin: 0; color: var(--text-main); }
    .fl-empty span { font-size: var(--fs-sm, .8rem); }

    /* Skeleton dimensionado: reserva el alto real para que no salte el layout (CLS 0). */
    .fl-skel { display: flex; flex-direction: column; gap: .4rem; }
    .fl-skel-row { height: 2.1rem; border-radius: var(--r-sm, 6px);
      background: color-mix(in srgb, var(--text-main) 7%, transparent); animation: flPulse 1.4s ease-in-out infinite; }
    @keyframes flPulse { 0%, 100% { opacity: .5 } 50% { opacity: .9 } }
    @media (prefers-reduced-motion: reduce) {
      .fl-skel-row { animation: none; }
      .fl-tab, .fl-motivo { transition: none; }
    }

    @media (max-width: 34rem) {
      .fl-page { padding: .8rem .7rem 2rem; }
      .fl-tabs { overflow-x: auto; }
      .fl-res-row { grid-template-columns: 1fr auto; }
      .fl-res-sku { display: none; }
    }
  `],
})
export class TiendaFaltantesComponent implements OnInit {
  private readonly api = inject(FaltantesService);
  private readonly verificador = inject(VerificadorService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('captura') capturaRef?: ElementRef<HTMLInputElement>;

  readonly TABS: ReadonlyArray<{ id: Pestana; label: string; icon: string }> = [
    { id: 'reportar', label: 'Reportar', icon: 'pi pi-flag' },
    // `[FLT.20]` Se llamaba "Buscar por nombre" y describía el MECANISMO, no el caso de uso. La
    // búsqueda por nombre se fusionó a la caja de Reportar; acá queda el motivo que ninguna
    // fuente puede ver, con su nombre de negocio.
    { id: 'nocat', label: 'Producto no catalogado', icon: 'pi pi-question-circle' },
    { id: 'fallan', label: 'Los que no pasan', icon: 'pi pi-ban' },
  ];
  readonly MOTIVOS = MOTIVOS;

  readonly pestana = signal<Pestana>('reportar');
  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly sucursal = signal<string | null>(null);

  /** El término de la caja única: código escaneado, clave tecleada o nombre. */
  readonly termino = signal('');

  readonly buscando = signal(false);
  readonly enviando = signal(false);
  readonly encontrado = signal<Hallado | null>(null);
  readonly noResuelto = signal(false);
  readonly avisoCaptura = signal<Aviso>(null);
  readonly avisoNoCat = signal<Aviso>(null);
  readonly ultimo = signal<ReportarResultado | null>(null);
  readonly textoLibre = signal('');

  /** `[FLT.22]` La respuesta de existencia. `null` = todavía no se consultó. */
  readonly consulta = signal<ConsultaFaltante | null>(null);

  readonly resultados = signal<Hallado[]>([]);
  readonly sinRespaldo = signal(false);

  readonly fallan = signal<CodigoQueFalla[]>([]);
  readonly mios = signal<Faltante[]>([]);
  readonly cargandoFallan = signal(false);

  /**
   * `[FLT.21]` Los motivos que tiene sentido ofrecer, y que dependen de la RESPUESTA.
   *
   * Preguntarle a la cajera si está agotado o si sólo falta en el anaquel es pedirle algo que no
   * puede saber — el sistema sí lo sabe. Así que la existencia decide qué se le ofrece:
   *
   *  · hay existencia  → «no estaba en el anaquel» (va a piso, se recupera hoy) y, como salida
   *    secundaria, «busqué y no hay» — que es la ÚNICA forma honesta de afirmar un descuadre:
   *    después de que alguien fue a buscarlo.
   *  · sin existencia  → «no hay en la tienda» y «no se maneja aquí».
   *  · sin producto    → sólo «no lo trabajamos»; los otros afirman cosas de un producto del
   *    catálogo y el backend los rechazaría. Ofrecer botones que dan error enseña que la
   *    pantalla falla.
   */
  readonly motivosVisibles = computed<ReadonlyArray<MotivoUi>>(() => {
    // Sin producto identificado hay una sola verdad reportable: no está en el catálogo.
    if (!this.encontrado()) return MOTIVOS.filter((m) => m.kind === 'no_en_catalogo');

    const v = this.consulta()?.veredicto;   // undefined = la respuesta TODAVÍA viaja

    // "El código no pasó" no depende de la existencia: es un problema de dato maestro. Lo necesita
    // justo quien llegó acá porque el lector falló y tuvo que buscar por nombre, y a esa persona
    // el producto le aparece CON existencia. Ofrecerlo sólo cuando no hay stock dejaba sin reportar
    // la hoja de códigos que falla, que es la mitad de por qué existe esta pantalla.
    const codigo = (m: MotivoUi) => m.kind === 'codigo_no_pasa';

    if (v === 'sin_existencia') {
      return MOTIVOS.filter((m) => m.kind === 'agotado' || m.kind === 'no_en_sucursal' || codigo(m));
    }
    // ⚠️ `undefined` cae ACÁ a propósito, junto con `no_medido` y `hay_en_tienda`. Mientras la
    // existencia no contesta no se sabe si hay, y tratarlo como "no hay" escondía
    // "no estaba en el anaquel" justo en la ventana en que la cajera está eligiendo — o sea que
    // empujaba al motivo equivocado en el único caso que se recupera el mismo día (ADR-056).
    return MOTIVOS.filter((m) => m.kind === 'no_en_anaquel' || m.kind === 'agotado' || codigo(m));
  });

  private debounce?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    this.verificador.sucursales().subscribe({
      next: (s) => {
        this.sucursales.set(s ?? []);
        // Precedencia: `?sucursal=NN` (la máquina del mostrador sin cuenta de esa tienda) →
        // la sucursal de la ficha → nada, y entonces se pide. Nunca se adivina.
        const q = this.route.snapshot.queryParamMap.get('sucursal');
        const propia = this.auth.user()?.warehouse_code ?? null;
        const elegida = [q, propia].find((c) => c && (s ?? []).some((x) => x.codigo === c)) ?? null;
        if (elegida) this.cambiarSucursal(elegida);

        // `[FLT.16]` Viene del verificador con el código que NO encontró. Se resuelve solo, para
        // que la persona no lo vuelva a teclear en el mostrador con el cliente esperando.
        const code = this.route.snapshot.queryParamMap.get('codigo');
        if (code && elegida) { this.termino.set(code); this.resolver(); }
      },
      error: () => this.sucursales.set([]),
    });

    this.destroyRef.onDestroy(() => { if (this.debounce) clearTimeout(this.debounce); });
  }

  irA(p: Pestana): void {
    this.pestana.set(p);
    if (p === 'fallan') this.cargarFallan();
    if (p === 'reportar') this.enfocar();
  }

  cambiarSucursal(code: string | null): void {
    this.sucursal.set(code);
    this.limpiar();
    this.resultados.set([]);
    this.sinRespaldo.set(false);
    if (this.pestana() === 'fallan') this.cargarFallan();
    this.enfocar();
  }

  /** El foco vuelve a la captura: el mostrador es keyboard-first y la pistola teclea sola. */
  private enfocar(): void {
    setTimeout(() => this.capturaRef?.nativeElement?.focus(), 0);
  }

  private limpiar(): void {
    this.encontrado.set(null);
    this.noResuelto.set(false);
    this.avisoCaptura.set(null);
    this.consulta.set(null);
    this.textoLibre.set('');
  }

  /** Lo que hace el enlace «ya lo resolví»: borra sin reportar. No todo hallazgo es un faltante. */
  limpiarTodo(): void {
    this.termino.set('');
    this.resultados.set([]);
    this.limpiar();
    this.ultimo.set(null);
    this.enfocar();
  }

  // ── Reportar ──────────────────────────────────────────────────────────────────────────────

  /**
   * `[FLT.20]` La caja única. La pistola dispara y manda Enter, así que el código resuelve por
   * `resolver()`; mientras la persona TECLEA, esto decide si además vale la pena buscar por nombre.
   *
   * El criterio es "tiene letras": un código de barras y una clave son dígitos, un nombre no. No se
   * busca por nombre con menos de 3 caracteres, o el catálogo entero entra por la ventana.
   */
  alEscribir(v: string): void {
    this.termino.set(v ?? '');
    const q = (v ?? '').trim();
    if (this.encontrado()) this.limpiar();      // cambió el término: la respuesta anterior ya no aplica
    if (this.debounce) clearTimeout(this.debounce);
    if (q.length < 3 || !/[a-zá-úñ]/i.test(q)) { this.resultados.set([]); return; }
    this.debounce = setTimeout(() => { void this.buscarNombre(q); }, 250);
  }

  resolver(): void {
    const code = this.termino().trim();
    const suc = this.sucursal();
    if (!code || !suc) return;

    this.buscando.set(true);
    this.limpiar();
    this.resultados.set([]);
    this.ultimo.set(null);

    this.verificador.buscar(code, suc).subscribe({
      next: (r) => {
        this.buscando.set(false);
        if (r.estado === 'encontrado') {
          const base = r.producto.unidades?.[0];
          this.encontrado.set({
            codigo: r.producto.codigo,
            nombre: r.producto.nombre,
            precio: base?.precio_con_iva ?? null,
            unidad: base?.u ?? null,
          });
          this.preguntarSiLoTenemos(r.producto.codigo);
        } else if (r.estado === 'no_encontrado') {
          // ⚠️ "No existe como CÓDIGO" NO es "no existe". La caja es una sola y acepta nombres, y
          // la pistola no es la única que escribe acá. Sin este paso, teclear "boing mango" y dar
          // Enter declaraba fuera de catálogo un producto que sí está — y el reporte que salía de
          // ahí era dato falso, que es peor que no tener el reporte.
          void this.trasNoResolver(code);
        } else {
          // `sin_datos` = no se pudo consultar. NO es "no existe": no se ofrece darlo de alta.
          this.avisoCaptura.set({
            tono: 'bad',
            texto: 'No se pudo consultar el catálogo.',
            detalle: 'Revisa la conexión y vuelve a intentar.',
          });
        }
      },
      error: () => {
        this.buscando.set(false);
        this.avisoCaptura.set({
          tono: 'bad', texto: 'No se pudo consultar.', detalle: 'Revisa la conexión y vuelve a intentar.',
        });
      },
    });
  }

  /**
   * `[FLT.22]` La pregunta que la pantalla le contesta a quien la abre: **¿lo tenemos?**
   *
   * Si falla, NO se inventa un cero. Se deja `no_medido`, que ofrece los mismos motivos que
   * "sí hay" a propósito: ante la duda conviene que alguien vaya a mirar, no que se declare
   * agotado algo que quizás está en la bodega (ADR-056).
   */
  private preguntarSiLoTenemos(sku: string): void {
    const suc = this.sucursal();
    if (!suc) return;
    this.api.consultar(suc, sku).subscribe({
      next: (c) => this.consulta.set(c),
      error: () => this.consulta.set({
        encontrado: true, termino: sku, warehouse_code: suc, warehouse_name: null,
        existencia: null, veredicto: 'no_medido',
      }),
    });
  }

  reportar(kind: StockoutKind): void {
    const suc = this.sucursal();
    if (!suc || this.enviando()) return;

    const p = this.encontrado();
    const texto = this.textoLibre().trim();
    if (!p && !texto) {
      this.avisoCaptura.set({ tono: 'warn', texto: 'Escribe qué te pidieron antes de reportar.' });
      return;
    }

    // Se deshabilita SÍNCRONO en el primer clic: en mostrador el doble toque es la norma, y
    // aunque el UPSERT es idempotente por semana, un segundo toque subiría el contador de más.
    this.enviando.set(true);

    this.api.reportar({
      warehouse_code: suc,
      kind,
      sku: p?.codigo,
      scanned_code: this.termino().trim() || undefined,
      product_name: p ? undefined : texto,
      source: 'verificador',
    }).subscribe({
      next: (r) => {
        this.enviando.set(false);
        this.ultimo.set(r);
        this.termino.set('');
        this.resultados.set([]);
        this.limpiar();
        this.enfocar();
      },
      error: (e) => {
        this.enviando.set(false);
        // Reportar es ESCRIBIR: si falló, se dice. Nunca se finge guardado.
        this.avisoCaptura.set({
          tono: 'bad',
          texto: 'No se pudo guardar el reporte.',
          detalle: e?.error?.message || 'Revisa la conexión e intenta de nuevo.',
        });
      },
    });
  }

  // ── Buscar por nombre (dentro de la MISMA caja) ───────────────────────────────────────────

  /**
   * `[FLT.23]` Busca en el catálogo local y, si no está, **lo baja sola**.
   *
   * Antes dependía de que alguien hubiera abierto el Verificador en esa tableta: esta pantalla
   * sólo LEÍA el respaldo de IndexedDB y nunca lo descargaba. En una caja que nunca abrió el
   * verificador, la búsqueda por nombre contestaba "no hay catálogo descargado" y ahí moría —
   * un muro que no tenía por qué existir, porque el endpoint ya estaba.
   */
  private async buscarNombre(q: string): Promise<'hallado' | 'vacio' | 'no_pude'> {
    const suc = this.sucursal();
    if (!suc || !q) { this.resultados.set([]); return 'no_pude'; }

    let r = await this.verificador.buscarPorNombre(suc, q);
    if (r === null) {
      // Sin respaldo: se baja una vez y se reintenta. Si tampoco se puede, se DECLARA —
      // "no puedo buscar" nunca se dibuja como "no hay resultados".
      this.sinRespaldo.set(true);
      try {
        await new Promise<void>((ok, fail) =>
          this.verificador.descargarSnapshot(suc).subscribe({ next: () => ok(), error: fail }));
        r = await this.verificador.buscarPorNombre(suc, q);
      } catch { r = null; }
    }
    if (r === null) { this.resultados.set([]); return 'no_pude'; }
    this.sinRespaldo.set(false);
    this.resultados.set(r);
    return r.length ? 'hallado' : 'vacio';
  }

  /**
   * Lo que pasa cuando el resolvedor de códigos dice que no. Tres respuestas distintas, porque
   * son tres situaciones distintas y mezclarlas produce el dato falso:
   *
   *  · hay productos con ese nombre  → no era un código, era un nombre. Se muestra la lista.
   *  · no hay ninguno                → ahí sí, el catálogo no lo tiene. Recién ahí se ofrece el
   *                                    alta, que es la única puerta que crea un reporte sin producto.
   *  · no se pudo buscar             → se DECLARA. "No pude preguntar" nunca se dibuja como
   *                                    "no existe" (ADR-056), porque de ese dibujo sale un alta
   *                                    de catálogo para algo que ya estaba dado de alta.
   */
  private async trasNoResolver(q: string): Promise<void> {
    // Sólo tiene sentido reintentar por nombre si hay letras: un código puro no va a aparecer en
    // una búsqueda por nombre, y el rodeo nada más retrasaría la respuesta en la caja.
    if (/[a-zá-úñ]/i.test(q)) {
      const r = await this.buscarNombre(q);
      if (r === 'hallado') {
        this.avisoCaptura.set({
          tono: 'warn',
          texto: 'Eso no es un código, pero hay productos con ese nombre.',
          detalle: 'Elige abajo el que te pidieron.',
        });
        return;
      }
      if (r === 'no_pude') {
        this.avisoCaptura.set({
          tono: 'bad',
          texto: 'No se pudo buscar por nombre.',
          detalle: 'Revisa la conexión. No se da por hecho que no exista.',
        });
        return;
      }
    }
    // El catálogo contestó que no, y se le pudo preguntar. Es autoritativo.
    this.noResuelto.set(true);
    this.avisoCaptura.set({
      tono: 'warn',
      texto: 'Eso no está en el catálogo.',
      detalle: 'Repórtalo en «Producto no catalogado» — se lleva lo que escribas.',
    });
  }

  /** `[FLT.20]` El reporte de la pestaña «Producto no catalogado»: sin escaneo previo. */
  reportarNoCatalogado(): void {
    const texto = this.textoLibre().trim();
    if (!texto) {
      this.avisoNoCat.set({ tono: 'warn', texto: 'Escribe qué te pidieron.' });
      return;
    }
    this.avisoNoCat.set(null);
    this.encontrado.set(null);   // por definición no hay producto: el backend lo exige
    this.reportar('no_en_catalogo');
  }

  /** Elegir un resultado lleva su clave a la captura: buscar por nombre existe para poder reportar. */
  usarResultado(r: Hallado): void {
    this.termino.set(r.codigo);
    this.resultados.set([]);
    this.pestana.set('reportar');
    this.encontrado.set(r);
    this.noResuelto.set(false);
    this.avisoCaptura.set(null);
    this.ultimo.set(null);
    // Tocar un producto del catálogo tiene que contestar lo mismo que escanearlo.
    this.preguntarSiLoTenemos(r.codigo);
  }

  // ── Los que no pasan ──────────────────────────────────────────────────────────────────────

  private cargarFallan(): void {
    const suc = this.sucursal();
    if (!suc) return;
    this.cargandoFallan.set(true);
    this.api.codigosQueFallan(suc).subscribe({
      next: (r) => { this.fallan.set(r ?? []); this.cargandoFallan.set(false); },
      error: () => { this.fallan.set([]); this.cargandoFallan.set(false); },
    });
    this.api.porSucursal(suc, 4).subscribe({
      next: (r) => this.mios.set(r ?? []),
      error: () => this.mios.set([]),
    });
  }

  // ── Etiquetas ─────────────────────────────────────────────────────────────────────────────

  etiquetaMotivo(k: StockoutKind): string { return ETIQUETA_MOTIVO[k] ?? k; }
  etiquetaDecision(d: string): string { return ETIQUETA_DECISION[d as StockoutDecision] ?? d; }

  /** Severidad del tag. El motivo, además del color, siempre viaja escrito. */
  severidad(k: StockoutKind): 'danger' | 'warn' | 'info' | 'secondary' {
    if (k === 'agotado') return 'danger';
    if (k === 'no_en_catalogo') return 'warn';
    if (k === 'codigo_no_pasa') return 'info';
    return 'secondary';
  }
}
