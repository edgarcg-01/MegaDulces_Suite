import {
  ChangeDetectionStrategy, Component, DestroyRef, OnInit,
  inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { AuthService } from '../../../core/services/auth.service';
import {
  FaltantesService, ETIQUETA_MOTIVO, ETIQUETA_DECISION,
  type CodigoQueFalla, type Faltante,
  type ReportarResultado, type StockoutDecision, type StockoutKind,
} from '../faltantes.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { SucursalPickerComponent, unCodigo } from '../../../shared/components/sucursal-picker/sucursal-picker.component';
import { FaltanteExpressComponent } from '../components/faltante-express.component';

type Pestana = 'reportar' | 'nocat' | 'fallan';
type Aviso = { tono: 'ok' | 'warn' | 'bad' | 'info'; texto: string; detalle?: string } | null;

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
  imports: [CommonModule, FormsModule, SelectModule, TagModule, SucursalPickerComponent, FaltanteExpressComponent],
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
          <!-- [ZN.7] Las sucursales salen del ALCANCE, no del catalogo PUBLICO del verificador.
               El de antes ofrecia las nueve a cualquiera, asi que una cajera de La Piedad podia
               reportar un faltante a nombre de Morelia. El endpoint ya acotaba; el selector no. -->
          <app-sucursal-picker [valor]="sucursal()" (valorChange)="cambiarSucursal(unCodigo($event))"
                               placeholder="Sucursal" etiqueta="Sucursal donde se reporta" />
        </div>
      </header>

      <nav class="fl-tabs" role="radiogroup" aria-label="Secciones de faltantes">
        @for (t of TABS; track t.id) {
          <button type="button" role="radio" class="fl-tab" [class.on]="pestana() === t.id"
                  [attr.aria-checked]="pestana() === t.id" (click)="irA(t.id)">
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
        <!-- [FLT.25] UNA caja y nada más. Todo lo que pasa después —el precio, la existencia,
             y el alta automática cuando la existencia es cero— vive dentro del componente.
             Acá no quedó nada que configurar porque ya no hay nada que preguntar: el motivo lo
             decide el veredicto, no la persona.

             ⚠️ Lo que esto RETIRA, y hay que saberlo: los otros tres motivos
             (no_en_anaquel / no_en_sucursal / codigo_no_pasa) ya no se capturan por acá. El que
             más duele es «no estaba en el anaquel», el único que se recupera el mismo día con la
             venta todavía viva. Queda declarado en la fase, no se perdió por descuido. -->
        <section class="fl-card">
          <app-faltante-express [sucursal]="sucursal()" [codigoInicial]="codigoInicial()"
                                (cambio)="recargarLoReportado()" />
        </section>
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

        <!-- [FLT.25] La confirmación vive ACÁ, con quien la produce. Estaba dentro de la
             pestaña «Reportar», que es la única que nunca la dispara: reportarNoCatalogado()
             no cambia de pestaña, así que quien daba de alta un producto se quedaba mirando el
             formulario sin saber si se guardó. Era un hueco anterior a este cambio.
             ⚠️ NO PONER ACENTOS GRAVES ACÁ: esto vive dentro de un template literal. -->
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
          </section>
        }
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
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  /** `[ZN.7]` El alcance de sucursales de quien mira: alimenta el selector y valida la preselección. */
  private readonly scope = inject(DataScopeService);
  /** El template sólo alcanza miembros de la clase; la función vive en el picker. */
  readonly unCodigo = unCodigo;

  readonly TABS: ReadonlyArray<{ id: Pestana; label: string; icon: string }> = [
    { id: 'reportar', label: 'Reportar', icon: 'pi pi-flag' },
    // `[FLT.20]` Se llamaba "Buscar por nombre" y describía el MECANISMO, no el caso de uso. La
    // búsqueda por nombre se fusionó a la caja de Reportar; acá queda el motivo que ninguna
    // fuente puede ver, con su nombre de negocio.
    { id: 'nocat', label: 'Producto no catalogado', icon: 'pi pi-question-circle' },
    { id: 'fallan', label: 'Los que no pasan', icon: 'pi pi-ban' },
  ];

  readonly pestana = signal<Pestana>('reportar');
  readonly sucursal = signal<string | null>(null);

  readonly enviando = signal(false);
  readonly avisoNoCat = signal<Aviso>(null);
  readonly ultimo = signal<ReportarResultado | null>(null);
  readonly textoLibre = signal('');

  readonly fallan = signal<CodigoQueFalla[]>([]);
  readonly mios = signal<Faltante[]>([]);
  readonly cargandoFallan = signal(false);

  /**
   * `[FLT.16]` El código con el que llega quien viene del verificador, para que el buscador lo
   * resuelva solo y la persona no lo vuelva a teclear con el cliente enfrente.
   */
  readonly codigoInicial = signal<string | null>(null);

  ngOnInit(): void {
    // `[ZN.7]` La preselección se valida contra el ALCANCE, no contra el catálogo público del
    // verificador. Antes bastaba con que la sucursal EXISTIERA, así que un `?sucursal=NN` en la
    // URL preseleccionaba cualquiera de las nueve — y el POST lo rechazaba después, cuando la
    // persona ya había escrito el faltante. Ahora el selector y el endpoint dicen lo mismo.
    this.scope.warehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ops) => {
        // Precedencia: `?sucursal=NN` (la máquina del mostrador sin cuenta de esa tienda) →
        // la sucursal de la ficha → nada, y entonces se pide. Nunca se adivina.
        const q = this.route.snapshot.queryParamMap.get('sucursal');
        const propia = this.auth.user()?.warehouse_code ?? null;
        const elegida = [q, propia].find((c) => c && ops.some((o) => o.value === c)) ?? null;
        if (elegida) this.cambiarSucursal(elegida);

        // `[FLT.16]` Viene del verificador con el código que NO encontró. Se resuelve solo, para
        // que la persona no lo vuelva a teclear en el mostrador con el cliente esperando.
        const code = this.route.snapshot.queryParamMap.get('codigo');
        if (code && elegida) this.codigoInicial.set(code);
      },
    });

  }

  irA(p: Pestana): void {
    this.pestana.set(p);
    if (p === 'fallan') this.cargarFallan();
  }

  cambiarSucursal(code: string | null): void {
    this.sucursal.set(code);
    this.textoLibre.set('');
    this.ultimo.set(null);
    this.avisoNoCat.set(null);
    if (this.pestana() === 'fallan') this.cargarFallan();
  }

  /**
   * `[FLT.25]` Lo que el buscador acaba de escribir (o de deshacer) tiene que verse en la lista.
   * Sin esto, el alta automática deja la pestaña «Los que no pasan» mostrando el estado de antes,
   * y la persona cree que su reporte se perdió.
   */
  recargarLoReportado(): void {
    const suc = this.sucursal();
    if (!suc) return;
    this.api.porSucursal(suc, 4).subscribe({
      next: (r) => this.mios.set(r ?? []),
      error: () => { /* la lista vieja es mejor que una vacía: no se borra lo que ya se vio */ },
    });
  }

  // ── Producto no catalogado ────────────────────────────────────────────────────────────────

  /**
   * `[FLT.20]` El reporte de la pestaña «Producto no catalogado»: sin escaneo previo.
   *
   * `[FLT.25]` Es el ÚNICO reporte que sigue naciendo de un clic en esta pantalla. Los demás los
   * escribe el buscador solo, a partir del veredicto de existencia. Éste no puede: un producto
   * que no vendemos no tiene existencia que consultar ni código que escanear — es exactamente
   * el dato que ninguna fuente puede ver, y por eso lo escribe una persona.
   */
  reportarNoCatalogado(): void {
    const suc = this.sucursal();
    const texto = this.textoLibre().trim();
    if (!suc || this.enviando()) return;
    if (!texto) {
      this.avisoNoCat.set({ tono: 'warn', texto: 'Escribe qué te pidieron.' });
      return;
    }
    this.avisoNoCat.set(null);
    // Se deshabilita SÍNCRONO en el primer clic: en mostrador el doble toque es la norma, y
    // aunque el UPSERT es idempotente por semana, un segundo toque subiría el contador de más.
    this.enviando.set(true);

    this.api.reportar({
      warehouse_code: suc,
      kind: 'no_en_catalogo',
      // Sin `sku` ni `scanned_code` a propósito: el CHECK de la tabla exige que este motivo vaya
      // SIN producto, porque afirma justamente que el producto no es nuestro.
      product_name: texto,
      source: 'verificador',
    }).subscribe({
      next: (r) => {
        this.enviando.set(false);
        this.ultimo.set(r);
        this.textoLibre.set('');
        this.recargarLoReportado();
      },
      error: (e) => {
        this.enviando.set(false);
        // Reportar es ESCRIBIR: si falló, se dice. Nunca se finge guardado.
        this.avisoNoCat.set({
          tono: 'bad',
          texto: 'No se pudo guardar el reporte.',
          detalle: e?.error?.message || 'Revisa la conexión e intenta de nuevo.',
        });
      },
    });
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
