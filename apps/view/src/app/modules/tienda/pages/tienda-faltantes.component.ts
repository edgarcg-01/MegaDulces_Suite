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
  type CodigoQueFalla, type Faltante, type ReportarResultado, type StockoutKind,
} from '../faltantes.service';
import { VerificadorService, type SucursalVerificador } from '../verificador.service';

type Pestana = 'reportar' | 'buscar' | 'fallan';
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
 * ── Tres pestañas, un solo oficio ────────────────────────────────────────────────────────────
 *  1. **Reportar** — escanea o teclea, elige el motivo, listo. Un toque.
 *  2. **Buscar por nombre** — la salida cuando el código no pasa. Corre contra el catálogo que el
 *     verificador YA baja a IndexedDB, así que es instantánea, funciona sin red y no agregó ni un
 *     endpoint: el nombre estaba en el snapshot desde siempre, sin usarse.
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
          <label class="fl-lbl" for="fl-code">Escanea o teclea el código</label>
          <div class="fl-capture">
            <input #captura id="fl-code" type="text" class="fl-input" [(ngModel)]="codigo"
                   (keyup.enter)="resolver()" [disabled]="buscando()"
                   placeholder="Código de barras o clave" autocomplete="off"
                   inputmode="numeric" aria-describedby="fl-capture-help" />
            <p-button label="Buscar" icon="pi pi-search" (onClick)="resolver()"
                      [loading]="buscando()" [disabled]="!codigo.trim()" styleClass="fl-btn-main" />
          </div>
          <small id="fl-capture-help" class="fl-help">
            Si el código no pasa, usa <button type="button" class="fl-link" (click)="irA('buscar')">buscar por nombre</button>.
          </small>

          @if (avisoCaptura(); as a) {
            <div class="fl-aviso" [class]="'t-' + a.tono" role="status">
              <strong>{{ a.texto }}</strong>
              @if (a.detalle) { <span>{{ a.detalle }}</span> }
            </div>
          }

          <!-- Producto resuelto -> los 4 motivos. Un toque y queda reportado. -->
          @if (encontrado(); as p) {
            <div class="fl-prod">
              <span class="fl-prod-sku">{{ p.codigo }}</span>
              <span class="fl-prod-name">{{ p.nombre }}</span>
              @if (p.precio !== null) {
                <span class="fl-prod-price">{{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
              }
            </div>
          }

          @if (encontrado() || textoLibre().trim()) {
            <p class="fl-lbl fl-lbl-sep">¿Por qué no se vendió?</p>
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
          }

          <!-- No resolvió: el caso que ninguna fuente puede ver. Se escribe a mano. -->
          @if (noResuelto()) {
            <div class="fl-libre">
              <label class="fl-lbl" for="fl-libre">¿Qué te pidieron? Escríbelo como lo dijo el cliente</label>
              <!-- El valor vive en una SEÑAL, no en una propiedad suelta: de ella depende que
                   aparezca el botón de motivo. Con ngModel de dos vías sobre una propiedad, el
                   template leía una señal que nadie actualizaba y el botón no salía nunca.
                   SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y lo cierran. -->
              <input id="fl-libre" type="text" class="fl-input" [ngModel]="textoLibre()"
                     (ngModelChange)="textoLibre.set($event)"
                     placeholder="Ej: chicle rosa del norte" autocomplete="off" />
            </div>
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

      <!-- ══ 2. BUSCAR POR NOMBRE ════════════════════════════════════════════════════ -->
      @if (pestana() === 'buscar') {
        <section class="fl-card">
          <label class="fl-lbl" for="fl-nom">Busca por nombre</label>
          <input id="fl-nom" type="text" class="fl-input" [(ngModel)]="nombre"
                 (ngModelChange)="buscarNombre($event)" placeholder="Ej: chiqui chile"
                 autocomplete="off" aria-describedby="fl-nom-help" />
          <small id="fl-nom-help" class="fl-help">
            Escribe las palabras que recuerdes, en cualquier orden. Funciona sin internet.
          </small>

          @if (sinRespaldo()) {
            <!-- "no puedo buscar" nunca se dibuja como "no hay resultados": son cosas distintas. -->
            <div class="fl-aviso t-warn">
              <strong>No hay catálogo descargado en esta tableta.</strong>
              <span>Abre el Verificador de precios una vez con internet y vuelve.</span>
            </div>
          } @else if (nombre.trim().length && !resultados().length) {
            <div class="fl-empty sm">
              <i class="pi pi-search" aria-hidden="true"></i>
              <p><strong>Nada con ese nombre.</strong></p>
              <span>Puede que no lo trabajemos — repórtalo en la pestaña anterior.</span>
            </div>
          } @else if (resultados().length) {
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
    .fl-aviso.t-ok   { border-color: color-mix(in srgb, var(--tone-ok) 45%, transparent); }
    .fl-aviso.t-warn { border-color: color-mix(in srgb, var(--tone-warn) 45%, transparent); }
    .fl-aviso.t-bad  { border-color: color-mix(in srgb, var(--tone-bad) 45%, transparent); }

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

    .fl-ok { border-color: color-mix(in srgb, var(--tone-ok) 45%, transparent); }
    .fl-ok-head { display: flex; align-items: center; gap: .45rem; font-size: var(--fs-md, .92rem); }
    .fl-ok-head i { color: var(--tone-ok); }
    .fl-ok-kind { font-size: var(--fs-xs, .72rem); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: 999px; padding: .1rem .5rem; }
    .fl-ok-name { margin: 0; font-weight: 700; color: var(--text-main); }
    .fl-ok-facts { display: flex; gap: 1rem; flex-wrap: wrap; font-size: var(--fs-sm, .82rem);
      color: var(--text-muted); }
    .fl-ok-facts b { color: var(--text-main); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .fl-contra { margin: 0; display: flex; align-items: flex-start; gap: .4rem;
      font-size: var(--fs-sm, .8rem); color: var(--text-main); }
    .fl-contra i { color: var(--tone-warn); margin-top: .15rem; }
    .fl-contra b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .fl-res { list-style: none; margin: 0; padding: 0; max-height: 26rem; overflow-y: auto; }
    .fl-res-row { display: grid; grid-template-columns: 5rem 1fr auto; gap: .6rem; align-items: baseline;
      width: 100%; min-height: var(--tap-min, 44px); padding: .5rem .3rem; text-align: left;
      background: none; border: 0; border-bottom: 1px solid var(--border-color);
      color: var(--text-main); font: inherit; cursor: pointer; }
    .fl-res-row:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
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
      background: color-mix(in srgb, var(--ink) 7%, transparent); animation: flPulse 1.4s ease-in-out infinite; }
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
    { id: 'buscar', label: 'Buscar por nombre', icon: 'pi pi-search' },
    { id: 'fallan', label: 'Los que no pasan', icon: 'pi pi-ban' },
  ];
  readonly MOTIVOS = MOTIVOS;

  readonly pestana = signal<Pestana>('reportar');
  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly sucursal = signal<string | null>(null);

  codigo = '';
  nombre = '';

  readonly buscando = signal(false);
  readonly enviando = signal(false);
  readonly encontrado = signal<Hallado | null>(null);
  readonly noResuelto = signal(false);
  readonly avisoCaptura = signal<Aviso>(null);
  readonly ultimo = signal<ReportarResultado | null>(null);
  readonly textoLibre = signal('');

  readonly resultados = signal<Hallado[]>([]);
  readonly sinRespaldo = signal(false);

  readonly fallan = signal<CodigoQueFalla[]>([]);
  readonly mios = signal<Faltante[]>([]);
  readonly cargandoFallan = signal(false);

  /**
   * Los motivos que tiene sentido ofrecer.
   *
   * Cuando NO hay producto resuelto el único motivo honesto es «no lo trabajamos»: los otros tres
   * afirman cosas sobre un producto del catálogo, y el backend rechazaría `no_en_catalogo` con
   * producto. Ofrecer botones que van a dar error es enseñarle a la persona que la pantalla falla.
   */
  readonly motivosVisibles = computed(() =>
    this.encontrado() ? MOTIVOS : MOTIVOS.filter((m) => m.kind === 'no_en_catalogo'),
  );

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
        if (code && elegida) { this.codigo = code; this.resolver(); }
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
    this.textoLibre.set('');
  }

  // ── Reportar ──────────────────────────────────────────────────────────────────────────────

  resolver(): void {
    const code = this.codigo.trim();
    const suc = this.sucursal();
    if (!code || !suc) return;

    this.buscando.set(true);
    this.limpiar();
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
        } else if (r.estado === 'no_encontrado') {
          // El servidor dijo que no existe: es autoritativo y se ofrece escribirlo a mano.
          this.noResuelto.set(true);
          this.avisoCaptura.set({
            tono: 'warn',
            texto: 'Ese código no está en el catálogo.',
            detalle: 'Escribe qué te pidieron y repórtalo como "no lo trabajamos".',
          });
          this.enfocarLibre();
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

  private enfocarLibre(): void {
    setTimeout(() => document.getElementById('fl-libre')?.focus(), 0);
  }

  reportar(kind: StockoutKind): void {
    const suc = this.sucursal();
    if (!suc || this.enviando()) return;

    const p = this.encontrado();
    const texto = this.textoLibre().trim();
    if (!p && !texto) {
      this.avisoCaptura.set({ tono: 'warn', texto: 'Escribe qué te pidieron antes de reportar.' });
      this.enfocarLibre();
      return;
    }

    // Se deshabilita SÍNCRONO en el primer clic: en mostrador el doble toque es la norma, y
    // aunque el UPSERT es idempotente por semana, un segundo toque subiría el contador de más.
    this.enviando.set(true);

    this.api.reportar({
      warehouse_code: suc,
      kind,
      sku: p?.codigo,
      scanned_code: this.codigo.trim() || undefined,
      product_name: p ? undefined : texto,
      source: 'verificador',
    }).subscribe({
      next: (r) => {
        this.enviando.set(false);
        this.ultimo.set(r);
        this.codigo = '';
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

  // ── Buscar por nombre ─────────────────────────────────────────────────────────────────────

  buscarNombre(texto: string): void {
    const suc = this.sucursal();
    if (!suc) return;
    if (this.debounce) clearTimeout(this.debounce);
    // 200ms: corre en memoria, así que sólo hace falta no re-filtrar en cada tecla.
    this.debounce = setTimeout(async () => {
      const q = (texto || '').trim();
      if (!q) { this.resultados.set([]); this.sinRespaldo.set(false); return; }
      const r = await this.verificador.buscarPorNombre(suc, q);
      if (r === null) { this.sinRespaldo.set(true); this.resultados.set([]); return; }
      this.sinRespaldo.set(false);
      this.resultados.set(r);
    }, 200);
  }

  /** Elegir un resultado lleva su clave a la captura: buscar por nombre existe para poder reportar. */
  usarResultado(r: Hallado): void {
    this.codigo = r.codigo;
    this.pestana.set('reportar');
    this.encontrado.set(r);
    this.noResuelto.set(false);
    this.avisoCaptura.set(null);
    this.ultimo.set(null);
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
  etiquetaDecision(d: string): string { return (ETIQUETA_DECISION as any)[d] ?? d; }

  /** Severidad del tag. El motivo, además del color, siempre viaja escrito. */
  severidad(k: StockoutKind): 'danger' | 'warn' | 'info' | 'secondary' {
    if (k === 'agotado') return 'danger';
    if (k === 'no_en_catalogo') return 'warn';
    if (k === 'codigo_no_pasa') return 'info';
    return 'secondary';
  }
}
