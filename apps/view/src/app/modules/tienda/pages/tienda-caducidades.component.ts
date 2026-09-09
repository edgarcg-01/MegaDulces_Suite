import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { map } from 'rxjs/operators';

import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';

import {
  ComercialService,
  ExpiryEntry,
  ExpiryHoja,
  ExpiryCaptureContext,
  ExpiryWarehouseOption,
  ReviewFile,
  VoiceSlots,
} from '../../comercial/comercial.service';
import { ProductSearchComponent, ProductHit } from '../../comercial/components/product-search.component';
import { ProductScanFieldComponent } from '../../comercial/components/product-scan-field.component';
import { ExpiryVoicePanelComponent } from '../../comercial/components/expiry-voice-panel.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { clasificarPlazo, plazoSeverity, plazoIcon, formatCantidad, formatUnidad, Plazo } from '../../comercial/expiry-plazo';
// Teclear dígitos pelados (`0327` → 31/03/2027) en vez de pelear con un
// datepicker: quien captura está de pie frente al anaquel, con el teléfono en
// una mano. La función es pura y ya estaba probada en la estación de recepción.
import { parseExpiryShort, formatExpiryEcho, maskExpiryMx, digitsOf } from '../../almacen/shared/expiry-short';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';

type LineUnit = 'caja' | 'pieza' | 'bulto' | 'kg';
type Condition = 'bueno' | 'regular' | 'malo';

/**
 * Caducidades de tienda (2026-09-08) — el área que reemplazó al alta por "hoja".
 *
 * **Dos oficios en una pantalla, partidos por permiso:**
 *  - *colaborador* (`COMMERCIAL_EXPIRY_CAPTURAR`) → **da de alta**: un producto a
 *    la vez, se guarda solo, la pantalla queda limpia para el siguiente. Debajo
 *    ve *lo que capturó hoy* para cazar un dedazo, y nada más.
 *  - *encargado* (`COMMERCIAL_EXPIRY_VER`) → además ve el **expediente de su
 *    sucursal**: las últimas hojas levantadas, con folio y quién las hizo.
 *
 * **Cada producto genera su hoja.** Al guardar, el renglón recibe un folio
 * (`CAD-03-2026-00001`, consecutivo por sucursal y año) y queda archivado en el
 * expediente de esa sucursal, imprimible desde `/tienda/caducidades/hoja/<folio>`.
 *
 * **La sucursal no se elige: se hereda.** Sale de la ficha del usuario
 * (`identity.users.warehouse_code`) y la resuelve el server
 * (`GET /entries/context`). Un colaborador no puede cargarle caducidades a otra
 * sucursal ni por error ni a mano; el picker aparece solo para quien tiene
 * alcance de varias (admin). El filtro del expediente también es server-side —
 * hacerlo acá sería un adorno sobre una API abierta.
 *
 * **Una sola vista apilada**, como el arqueo: captura arriba a lo ancho, lo
 * capturado y el expediente abajo. Quien captura no está leyendo el archivo.
 *
 * **Tres caminos para el mismo renglón, porque el anaquel no es una oficina:**
 * escanear (pistola de caja o cámara), teclear, o **hablarle al asistente**
 * (P2.7). Los tres terminan en los mismos tres pasos; el asistente **prellena y
 * la persona guarda** — nunca escribe solo (co-piloto, ADR-020).
 */
@Component({
  selector: 'app-tienda-caducidades',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TagModule, TableModule, SelectModule,
    InputTextModule, InputNumberModule, ToastModule, ConfirmDialogModule,
    ProductSearchComponent, ProductScanFieldComponent, MetricStripComponent,
    ExpiryVoicePanelComponent,
  ],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cad">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caducidades</h1>
          <p class="surf-page-sub">
            @if (ctx(); as c) {
              @switch (c.mode) {
                @case ('none') { Tu usuario no tiene sucursal asignada }
                @case ('own') { {{ c.warehouse?.name }} — registrá lo que ves en el anaquel }
                @default { Elegí la sucursal y registrá lo que ves en el anaquel }
              }
            } @else { Registrá lo que ves en el anaquel }
          </p>
        </div>

        <div class="cad-head-right">
          @if (sucursalFija(); as w) {
            <!-- La sucursal es un DATO, no un control: se muestra, no se elige. -->
            <span class="cad-suc" [title]="'Sucursal de tu usuario: ' + w.code">
              <i class="pi pi-building" aria-hidden="true"></i>
              <strong>{{ w.name }}</strong>
              <code>{{ w.code }}</code>
            </span>
          } @else if (puedeElegirSucursal()) {
            <p-select
              [options]="ctx()?.options || []" [(ngModel)]="warehouseId"
              optionLabel="name" optionValue="id" placeholder="Elegí la sucursal"
              [filter]="(ctx()?.options?.length || 0) > 8" filterBy="name,code"
              styleClass="cad-suc-pick" appendTo="body"
              (onChange)="onSucursalChange()"></p-select>
          }
        </div>
      </header>

      <!-- Sin sucursal en la ficha no hay dónde escribir: se dice acá, no en un
           403 después de teclear la captura completa. -->
      @if (ctx()?.mode === 'none') {
        <section class="cad-blocked surf-card" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <div>
            <h2>No hay dónde registrar</h2>
            <p>Tu usuario no está asignado a ninguna sucursal, y las caducidades se
              registran en la sucursal de quien las captura. Pedile al administrador
              que te asigne la tuya en tu ficha de usuario; con eso, esta pantalla
              queda lista.</p>
          </div>
        </section>
      }

      @if (kpis().length) {
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen de lo capturado hoy"></app-metric-strip>
      }

      <!-- ───────────── Captura: un producto a la vez ───────────── -->
      @if (puedeCapturar() && ctx()?.mode !== 'none') {
        <section class="cad-cap surf-card" [class.cad-cap--editando]="editandoId()">
          <div class="cad-cap-head">
            <h2>{{ editandoId() ? 'Corregir la captura' : 'Registrar una caducidad' }}</h2>
            @if (editandoId()) {
              <button pButton [text]="true" size="small" severity="secondary" (click)="cancelarEdicion()">
                <span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span> Cancelar
              </button>
            }
          </div>

          <!-- Hablarle es el cuarto atajo, no otro flujo: llena estos mismos
               tres pasos y quien guarda sigue siendo la persona. -->
          <app-expiry-voice-panel
            [defaultLocation]="ubicacion"
            (slotsChange)="aplicarVoz($event)"></app-expiry-voice-panel>

          <!-- 1 · Qué producto -->
          <div class="cad-step">
            <span class="cad-step-n" aria-hidden="true">1</span>
            <div class="cad-step-body">
              <span class="cad-lbl">Producto</span>

              @if (producto(); as p) {
                <div class="cad-prod" role="status">
                  <i class="pi pi-check-circle" aria-hidden="true"></i>
                  <div class="cad-prod-txt">
                    <strong>{{ p.nombre }}</strong>
                    <span>
                      @if (p.sku) { <code>{{ p.sku }}</code> }
                      @if (p.brand) { · {{ p.brand }} }
                      @if (p.raw) { · código {{ p.raw }} }
                    </span>
                  </div>
                  <button type="button" class="cad-prod-x" (click)="limpiarProducto()" aria-label="Cambiar producto">Cambiar</button>
                </div>
              } @else {
                <app-product-scan-field
                  [valor]="codigo()" [ocupado]="resolviendo()" [refocoTick]="refoco()"
                  etiqueta="Escaneá el código (pistola, cámara) o escribilo"
                  (valorChange)="codigo.set($event)"
                  (buscar)="resolverCodigo($event)"
                  (sinCamara)="aviso($event)"></app-product-scan-field>

                @if (candidatos().length) {
                  <div class="cad-cands">
                    <span class="cad-cands-lbl">Ese código coincide con {{ candidatos().length }} productos — elegí:</span>
                    @for (c of candidatos(); track c.id) {
                      <button type="button" class="cad-cand" (click)="elegirCandidato(c)">
                        <strong>{{ c.nombre }}</strong>
                        @if (c.sku) { <code>{{ c.sku }}</code> }
                        @if (c.brand_name) { <span>{{ c.brand_name }}</span> }
                      </button>
                    }
                  </div>
                }
                @if (avisoCodigo()) {
                  <div class="cad-miss" role="status">
                    <i class="pi pi-info-circle" aria-hidden="true"></i>
                    <span>{{ avisoCodigo() }}</span>
                    @if (codigo().trim()) {
                      <button type="button" class="cad-miss-a" (click)="usarCodigoCrudo()">Registrarlo con el código tal cual</button>
                    }
                  </div>
                }

                <div class="cad-or"><span>o buscalo por nombre</span></div>
                <app-product-search
                  placeholder="Nombre del producto…"
                  [fetch]="buscarProducto"
                  (productSelected)="elegirBusqueda($event)"></app-product-search>
              }
            </div>
          </div>

          <!-- 2 · Cuándo vence -->
          <div class="cad-step">
            <span class="cad-step-n" aria-hidden="true">2</span>
            <div class="cad-step-body">
              <label class="cad-lbl" for="cad-vence">Fecha de caducidad</label>
              <!-- Placeholder corto a propósito. Antes decía los tres formatos juntos
                   ("0327 · 150327 · 15032027") y el campo PARECÍA tener un valor ya
                   escrito en vez de estar vacío. La pista completa vive en el hint, y
                   el eco de abajo confirma la fecha entendida en cuanto se puede leer. -->
              <input pInputText id="cad-vence" class="cad-fecha" inputmode="numeric" autocomplete="off"
                [ngModel]="fechaRaw()" (ngModelChange)="onFecha($event)"
                placeholder="DD/MM/AAAA" maxlength="10" aria-describedby="cad-vence-help" />
              <small class="cad-hint" id="cad-vence-help">
                Tecleá sólo números y la diagonal se pone sola: <strong>15032027</strong> → 15/03/2027.
                Si el empaque no trae día, <strong>0327</strong> = marzo 2027 (último día del mes).
              </small>

              @if (fechaIso(); as iso) {
                <div class="cad-eco"><i class="pi pi-calendar" aria-hidden="true"></i> Vence el <strong>{{ echo(iso) }}</strong></div>
              }
              @if (plazo(); as pz) {
                <div class="cad-plazo" [attr.data-p]="pz.level">
                  <i [class]="icono(pz.level)" aria-hidden="true"></i>
                  <strong>{{ pz.title }}</strong><span>{{ pz.detail }}</span>
                </div>
              } @else if (fechaRaw().trim() && !fechaIso()) {
                <div class="cad-plazo" data-p="riesgoso">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  <strong>Fecha incompleta</strong><span>seguí escribiendo: 4, 6 u 8 dígitos</span>
                </div>
              }
            </div>
          </div>

          <!-- 3 · Cuánto hay -->
          <div class="cad-step">
            <span class="cad-step-n" aria-hidden="true">3</span>
            <div class="cad-step-body">
              <span class="cad-lbl">Cantidad</span>
              <div class="cad-qty">
                <p-inputnumber [(ngModel)]="cantidad" [min]="0" [showButtons]="true" buttonLayout="horizontal"
                  incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"
                  inputStyleClass="cad-qty-in" styleClass="cad-qty-w"
                  [ariaLabel]="'Cantidad'"></p-inputnumber>
                <div class="cad-units" role="radiogroup" aria-label="Unidad de medida">
                  @for (u of units; track u.value) {
                    <button type="button" class="cad-unit" role="radio"
                      [attr.aria-checked]="unidad() === u.value" [class.on]="unidad() === u.value"
                      [title]="u.hint" (click)="elegirUnidad(u.value)">{{ u.label }}</button>
                  }
                </div>
              </div>
              @if (unidadSugerida()) {
                <small class="cad-hint"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ unidadSugerida() }}</small>
              }
            </div>
          </div>

          <!-- Lo opcional, plegado: la captura rápida son los 3 pasos de arriba. -->
          <details class="cad-more" [open]="masAbierto()" (toggle)="masAbierto.set($any($event.target).open)">
            <summary>
              <i class="pi pi-sliders-h" aria-hidden="true"></i>
              Más detalle <span class="cad-more-hint">estado físico · ubicación · nota · foto</span>
            </summary>

            <div class="cad-more-grid">
              <div class="cad-field">
                <span class="cad-lbl">Estado físico <em>(cómo está el empaque, no la fecha)</em></span>
                <div class="cad-chips" role="radiogroup" aria-label="Estado físico">
                  @for (c of conditions; track c.value) {
                    <button type="button" class="cad-chip" role="radio" [attr.data-c]="c.value"
                      [attr.aria-checked]="condicion() === c.value" [class.on]="condicion() === c.value"
                      (click)="condicion.set(c.value)">{{ c.label }}</button>
                  }
                </div>
              </div>

              <label class="cad-field">
                <span class="cad-lbl">Ubicación</span>
                <input pInputText [(ngModel)]="ubicacion" placeholder="Anaquel 3 / bodega / exhibidor de caja" />
                <small class="cad-hint">Se recuerda para la siguiente captura.</small>
              </label>

              <label class="cad-field cad-field--wide">
                <span class="cad-lbl">Nota</span>
                <input pInputText [(ngModel)]="nota" placeholder="Lo que haya que decir de este producto" />
              </label>

              <div class="cad-field">
                <span class="cad-lbl">Foto de evidencia</span>
                @if (foto(); as f) {
                  <div class="cad-foto">
                    @if (f.preview_url) { <img [src]="f.preview_url" alt="Evidencia adjunta" /> }
                    <button type="button" class="cad-foto-x" (click)="foto.set(null)" aria-label="Quitar la foto">Quitar</button>
                  </div>
                } @else {
                  <label class="cad-foto-add" [class.on]="subiendoFoto()">
                    <i class="pi" [class.pi-camera]="!subiendoFoto()" [class.pi-spinner]="subiendoFoto()" [class.cad-spin]="subiendoFoto()" aria-hidden="true"></i>
                    {{ subiendoFoto() ? 'Subiendo…' : 'Tomar / adjuntar foto' }}
                    <input type="file" accept="image/*,application/pdf" capture="environment" (change)="onFoto($event)" [disabled]="subiendoFoto()" />
                  </label>
                }
                @if (errorFoto()) { <small class="cad-err">{{ errorFoto() }}</small> }
              </div>
            </div>
          </details>

          <!-- Barra de acción pegada al fondo: quien captura de pie no debería
               ir a buscar el botón después de teclear. -->
          <div class="cad-actions">
            <div class="cad-actions-sum">
              @if (falta(); as f) {
                <span class="cad-falta"><i class="pi pi-info-circle" aria-hidden="true"></i> Falta: {{ f }}</span>
              } @else {
                <span class="cad-listo"><i class="pi pi-check" aria-hidden="true"></i> Listo para guardar</span>
              }
            </div>
            <button pButton size="large" [disabled]="!!falta() || guardando()" [loading]="guardando()" (click)="guardar()">
              <span class="p-button-icon p-button-icon-left pi pi-save" aria-hidden="true"></span>
              {{ editandoId() ? 'Guardar corrección' : 'Guardar y seguir' }}
            </button>
          </div>
        </section>
      }

      <!-- ───────────── Lo que capturé hoy ───────────── -->
      @if (puedeCapturar() && ctx()?.mode !== 'none') {
        <section class="cad-hoy">
          <div class="cad-sec-head">
            <h2>Capturado hoy</h2>
            <span class="cad-sec-sub">{{ misEntradas().length }} {{ misEntradas().length === 1 ? 'registro' : 'registros' }} tuyos de hoy</span>
          </div>

          @if (cargandoMias()) {
            <div class="cad-skel" aria-hidden="true">
              @for (i of [1,2,3]; track i) { <div class="cad-skel-row"></div> }
            </div>
          } @else if (!misEntradas().length) {
            <div class="cad-empty">
              <i class="pi pi-inbox" aria-hidden="true"></i>
              <p>Todavía no registraste nada hoy. Empezá por el producto de arriba.</p>
            </div>
          } @else {
            <ul class="cad-list">
              @for (e of misEntradas(); track e.id) {
                <li class="cad-item" [attr.data-p]="nivelDe(e)">
                  <div class="cad-item-main">
                    <strong class="cad-item-name">{{ e.product_name || e.product_name_raw || e.product_code_raw || 'Sin producto' }}</strong>
                    <span class="cad-item-meta">
                      @if (e.folio) { <code class="cad-folio">{{ e.folio }}</code> · }
                      <span class="cad-num">{{ cant(e.quantity) }}</span> {{ uni(e.quantity, e.unit) }}
                      @if (e.sku) { · <code>{{ e.sku }}</code> }
                      @if (e.location) { · <i class="pi pi-map-marker" aria-hidden="true"></i> {{ e.location }} }
                    </span>
                  </div>
                  <div class="cad-item-vence">
                    <span class="cad-num">{{ echo(ymd(e.expiry_date)) || '—' }}</span>
                    @if (plazoDe(e); as pz) {
                      <p-tag [value]="pz.title" [severity]="sev(pz.level)"></p-tag>
                    }
                  </div>
                  <div class="cad-item-acts">
                    @if (e.fed_to_fefo) {
                      <span class="cad-fefo" title="Ya se reflejó en el control de inventario (FEFO)">
                        <i class="pi pi-check-circle" aria-hidden="true"></i> en inventario
                      </span>
                    }
                    @if (e.folio) {
                      <button pButton [text]="true" size="small" severity="secondary" (click)="verHoja(e)"
                        [attr.aria-label]="'Abrir la hoja ' + e.folio" [title]="'Hoja ' + e.folio">
                        <span class="p-button-icon pi pi-file" aria-hidden="true"></span>
                      </button>
                    }
                    <button pButton [text]="true" size="small" severity="secondary" (click)="editar(e)" aria-label="Corregir este registro">
                      <span class="p-button-icon pi pi-pencil" aria-hidden="true"></span>
                    </button>
                    <button pButton [text]="true" size="small" severity="danger" (click)="borrar(e)" aria-label="Borrar este registro">
                      <span class="p-button-icon pi pi-trash" aria-hidden="true"></span>
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }

      <!-- ───────────── Expediente de la sucursal (encargado) ───────────── -->
      @if (puedeVer()) {
        <section class="cad-hist">
          <div class="cad-sec-head">
            <h2>Expediente de la sucursal</h2>
            <span class="cad-sec-sub">Últimas hojas — una por producto, con su folio</span>
            <button pButton [text]="true" size="small" severity="secondary" class="cad-sec-btn" (click)="irAlExpediente()">
              Ver expediente completo
              <span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span>
            </button>
          </div>

          <p-table [value]="expediente()" [loading]="cargandoExp()" styleClass="p-datatable-sm surf-table"
            [paginator]="expediente().length > 10" [rows]="10">
            <ng-template #header>
              <tr>
                <th scope="col">Folio</th>
                <th scope="col">Producto</th>
                <th scope="col" class="num">Cant.</th>
                <th scope="col">Vence</th>
                <th scope="col">Plazo</th>
                <th scope="col">Levantó</th>
                <th scope="col"></th>
              </tr>
            </ng-template>
            <ng-template #body let-h>
              <tr class="cad-hrow" (click)="verHoja(h)" tabindex="0" (keydown.enter)="verHoja(h)">
                <td><span class="cad-num cad-folio">{{ h.folio || '—' }}</span></td>
                <td>{{ h.product_name || h.product_name_raw || h.product_code_raw || '—' }}</td>
                <td class="num"><span class="cad-num">{{ cant(h.quantity) }}</span> {{ uni(h.quantity, h.unit) }}</td>
                <td><span class="cad-num">{{ echo(ymd(h.expiry_date)) || '—' }}</span></td>
                <td>
                  @if (plazoDe(h); as pz) { <p-tag [value]="pz.title" [severity]="sev(pz.level)"></p-tag> }
                  @else { — }
                </td>
                <td>{{ h.levantada_por || '—' }}</td>
                <td class="num"><i class="pi pi-chevron-right cad-chev" aria-hidden="true"></i></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7" class="comm-empty-cell">
                <div class="comm-empty">
                  <div class="comm-empty-icon"><i class="pi pi-folder-open" aria-hidden="true"></i></div>
                  <h3>El expediente está vacío</h3>
                  <p>Cada producto que se registre acá genera su hoja, con folio propio y quién la levantó.</p>
                </div>
              </td></tr>
            </ng-template>
          </p-table>
        </section>
      }
    </div>
  `,
  styles: [`
    /* Operations: denso, sin decoración. Elevación = borde 1px, nunca + sombra. */
    .cad { display: grid; gap: 1rem; container-type: inline-size; }

    .cad-head-right { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .cad-suc {
      display: inline-flex; align-items: center; gap: .5rem;
      padding: .4rem .7rem; border: 1px solid var(--border-color);
      border-radius: var(--r-md, 8px); background: var(--card-bg);
      font-size: var(--fs-sm, .85rem);
    }
    .cad-suc code { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--c-text-3, var(--text-muted)); }
    /* min-width fijo = piso que no cede: en un telefono el selector medía 224px
       dentro de 358 y, con el resto del encabezado al lado, lo sacaba de la
       pantalla. El min() lo hace rendirse al ancho disponible. */
    :host ::ng-deep .cad-suc-pick { min-width: min(14rem, 100%); max-width: 100%; }

    .cad-blocked { display: flex; gap: .9rem; align-items: flex-start; padding: 1rem; }
    .cad-blocked > i { font-size: 1.4rem; color: var(--tone-warn, var(--text-muted)); flex: none; }
    .cad-blocked h2 { margin: 0 0 .25rem; font-size: var(--fs-md, 1rem); }
    .cad-blocked p { margin: 0; max-width: 62ch; color: var(--c-text-2, var(--text-muted)); font-size: var(--fs-sm, .85rem); }

    /* ── Captura ── */
    .cad-cap { display: grid; gap: 1rem; padding: 1rem; }
    .cad-cap--editando { border-color: var(--action, var(--border-color)); }
    .cad-cap-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .cad-cap-head h2 { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 700; }

    .cad-step { display: grid; grid-template-columns: 1.6rem 1fr; gap: .75rem; align-items: start; }
    .cad-step-n {
      display: grid; place-items: center; width: 1.6rem; height: 1.6rem;
      border-radius: 50%; background: color-mix(in oklab, var(--ink, #000) 8%, transparent);
      font-size: var(--fs-xs, .72rem); font-weight: 700; color: var(--c-text-2, var(--text-muted));
    }
    /* minmax(0,1fr) y no el track auto por defecto: un track auto se dimensiona
       al min-content del hijo y lo deja desbordar al padre aunque el padre
       tenga min-width: 0. Es la misma trampa de SM.31, un nivel mas abajo. */
    .cad-step-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: .4rem; min-width: 0; }
    .cad-lbl { font-size: var(--fs-sm, .85rem); font-weight: 600; color: var(--c-text-2, var(--text-muted)); }
    .cad-lbl em { font-weight: 400; font-style: normal; color: var(--c-text-3, var(--text-muted)); }
    .cad-hint { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .cad-err { font-size: var(--fs-xs, .72rem); color: var(--tone-bad, var(--text-muted)); }

    /* Producto elegido */
    .cad-prod, .cad-miss {
      display: flex; align-items: center; gap: .6rem; padding: .6rem .7rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); background: var(--card-bg);
    }
    .cad-prod > i { color: var(--tone-ok, var(--text-muted)); }
    .cad-miss > i { color: var(--tone-warn, var(--text-muted)); }
    .cad-prod-txt { display: grid; gap: .1rem; min-width: 0; flex: 1; }
    .cad-prod-txt strong { font-size: var(--fs-sm, .9rem); overflow-wrap: anywhere; }
    .cad-prod-txt span { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .cad-prod-txt code { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .cad-prod-x, .cad-foto-x, .cad-miss-a {
      min-height: 2rem; padding: 0 .6rem; border: 1px solid var(--border-color);
      border-radius: var(--r-sm, 6px); background: transparent; color: var(--c-text-2, var(--text-muted));
      font: inherit; font-size: var(--fs-xs, .72rem); cursor: pointer;
    }
    .cad-prod-x:hover, .cad-foto-x:hover, .cad-miss-a:hover { background: color-mix(in oklab, var(--ink, #000) 5%, transparent); }

    .cad-cands { display: grid; gap: .35rem; }
    .cad-cands-lbl { font-size: var(--fs-xs, .72rem); color: var(--c-text-2, var(--text-muted)); }
    .cad-cand {
      display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
      min-height: 2.75rem; padding: .5rem .7rem; text-align: left;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      background: var(--card-bg); font: inherit; cursor: pointer;
    }
    .cad-cand:hover { border-color: var(--action, var(--border-color)); }
    .cad-cand code { font-family: var(--font-mono, monospace); font-size: var(--fs-xs, .72rem); }
    .cad-cand span { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }

    .cad-or { display: flex; align-items: center; gap: .6rem; color: var(--c-text-3, var(--text-muted)); font-size: var(--fs-xs, .72rem); }
    .cad-or::before, .cad-or::after { content: ''; height: 1px; flex: 1; background: var(--border-color); }

    /* Fecha: dígitos pelados, campo grande y mono */
    .cad-fecha {
      width: 100%; max-width: 18rem; min-height: 3rem;
      font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums;
      font-size: 1.25rem; letter-spacing: .06em;
    }
    .cad-eco { font-size: var(--fs-sm, .85rem); display: flex; align-items: center; gap: .4rem; }
    .cad-eco strong { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }

    .cad-plazo {
      display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
      padding: .5rem .7rem; border-radius: var(--r-md, 8px);
      border: 1px solid var(--border-color); font-size: var(--fs-sm, .85rem);
    }
    .cad-plazo span { color: var(--c-text-2, var(--text-muted)); }
    .cad-plazo[data-p='bueno']      { border-color: color-mix(in oklab, var(--tone-ok, #2f7) 45%, var(--border-color)); }
    .cad-plazo[data-p='bueno'] > i, .cad-plazo[data-p='bueno'] strong { color: var(--tone-ok, inherit); }
    .cad-plazo[data-p='intermedio'] { border-color: color-mix(in oklab, var(--tone-warn, #fa0) 45%, var(--border-color)); }
    .cad-plazo[data-p='intermedio'] > i, .cad-plazo[data-p='intermedio'] strong { color: var(--tone-warn, inherit); }
    .cad-plazo[data-p='riesgoso'], .cad-plazo[data-p='vencido'] { border-color: color-mix(in oklab, var(--tone-bad, #d33) 45%, var(--border-color)); }
    .cad-plazo[data-p='riesgoso'] > i, .cad-plazo[data-p='riesgoso'] strong,
    .cad-plazo[data-p='vencido'] > i, .cad-plazo[data-p='vencido'] strong { color: var(--tone-bad, inherit); }

    /* Cantidad + unidad */
    .cad-qty { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    /* OJO: styleClass="cad-qty-w" NO llega al elemento - PrimeNG v22 no lo
       propaga en p-inputnumber (igual que en p-select). O sea que este
       max-width nunca aplico y el campo venia sin tope: 275px de min-content
       que en un telefono de 320 se salian de la tarjeta. Se apunta al elemento.
       inputStyleClass SI se propaga (por eso .cad-qty-in funciona). */
    :host ::ng-deep .cad-qty-w { max-width: 12rem; }
    :host ::ng-deep .cad-qty p-inputnumber { max-width: min(12rem, 100%); }
    /* Y el input de adentro tiene que poder encogerse: su ancho intrinseco
       (~20 caracteres) mas los dos botones del stepper daban 275px de piso, y
       en un flex el minimo automatico de un item ES su min-content. Con
       flex: 1 1 0 + min-width: 0 el piso pasa a ser el de los botones. */
    :host ::ng-deep .cad-qty p-inputnumber { min-width: 0; }
    :host ::ng-deep .cad-qty p-inputnumber .cad-qty-in { flex: 1 1 0; min-width: 0; }
    :host ::ng-deep .cad-qty-in { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; text-align: center; min-height: 2.75rem; }
    .cad-units, .cad-chips { display: flex; gap: .35rem; flex-wrap: wrap; }
    .cad-unit, .cad-chip {
      min-height: 2.75rem; min-width: 3.5rem; padding: 0 .8rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      background: var(--card-bg); color: var(--c-text-2, var(--text-muted));
      font: inherit; font-size: var(--fs-sm, .85rem); cursor: pointer;
      transition: transform 150ms ease-out, border-color 150ms ease-out;
    }
    .cad-unit:active, .cad-chip:active { transform: scale(.97); }
    .cad-unit.on, .cad-chip.on { border-color: var(--action, currentColor); color: var(--text-main); font-weight: 700; }
    .cad-chip[data-c='malo'].on { border-color: var(--tone-bad, currentColor); color: var(--tone-bad, inherit); }
    .cad-chip[data-c='regular'].on { border-color: var(--tone-warn, currentColor); color: var(--tone-warn, inherit); }
    .cad-chip[data-c='bueno'].on { border-color: var(--tone-ok, currentColor); color: var(--tone-ok, inherit); }

    /* Detalle plegado */
    .cad-more { border-top: 1px solid var(--border-color); padding-top: .75rem; }
    .cad-more summary {
      display: flex; align-items: center; gap: .5rem; min-height: 2.75rem;
      cursor: pointer; font-size: var(--fs-sm, .85rem); font-weight: 600;
    }
    .cad-more-hint { font-weight: 400; color: var(--c-text-3, var(--text-muted)); font-size: var(--fs-xs, .72rem); }
    .cad-more-grid { display: grid; gap: .9rem; padding-top: .75rem; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); }
    .cad-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: .35rem; min-width: 0; }
    .cad-field--wide { grid-column: 1 / -1; }

    .cad-foto { display: flex; align-items: center; gap: .6rem; }
    .cad-foto img { width: 3.5rem; height: 3.5rem; object-fit: cover; border-radius: var(--r-sm, 6px); border: 1px solid var(--border-color); }
    .cad-foto-add {
      display: inline-flex; align-items: center; gap: .5rem; min-height: 2.75rem; padding: 0 .9rem;
      border: 1px dashed var(--border-color); border-radius: var(--r-md, 8px);
      font-size: var(--fs-sm, .85rem); cursor: pointer; color: var(--c-text-2, var(--text-muted));
    }
    .cad-foto-add input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .cad-foto-add:hover { border-color: var(--action, var(--border-color)); }
    .cad-spin { animation: cad-rot 1s linear infinite; }
    @keyframes cad-rot { to { transform: rotate(360deg); } }

    /* Barra de acción */
    .cad-actions {
      position: sticky; bottom: 0; z-index: 2;
      display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap;
      margin: 0 -1rem -1rem; padding: .75rem 1rem;
      border-top: 1px solid var(--border-color);
      background: var(--card-bg);
    }
    .cad-actions-sum { font-size: var(--fs-sm, .85rem); }
    .cad-falta { color: var(--c-text-2, var(--text-muted)); display: inline-flex; align-items: center; gap: .4rem; }
    .cad-listo { color: var(--tone-ok, inherit); display: inline-flex; align-items: center; gap: .4rem; font-weight: 600; }

    /* ── Secciones ── */
    .cad-sec-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin-bottom: .5rem; }
    .cad-sec-head h2 { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 700; }
    .cad-sec-sub { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }

    .cad-num { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .cad-folio { font-weight: 600; letter-spacing: .01em; }
    .cad-sec-btn { margin-left: auto; }

    /* Lista de lo capturado hoy — filas, no tabla: se lee en teléfono. */
    .cad-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
    .cad-item {
      display: grid; gap: .5rem; align-items: center; padding: .6rem .7rem;
      grid-template-columns: 1fr auto auto;
      border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-md, 8px);
      background: var(--card-bg);
    }
    .cad-item[data-p='vencido'], .cad-item[data-p='riesgoso'] { border-left-color: var(--tone-bad, var(--border-color)); }
    .cad-item[data-p='intermedio'] { border-left-color: var(--tone-warn, var(--border-color)); }
    .cad-item[data-p='bueno'] { border-left-color: var(--tone-ok, var(--border-color)); }
    .cad-item-main { display: grid; gap: .15rem; min-width: 0; }
    .cad-item-name { font-size: var(--fs-sm, .9rem); overflow-wrap: anywhere; }
    .cad-item-meta { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .cad-item-meta code { font-family: var(--font-mono, monospace); }
    .cad-item-vence { display: grid; gap: .2rem; justify-items: end; font-size: var(--fs-xs, .72rem); }
    .cad-item-acts { display: flex; align-items: center; gap: .1rem; }
    .cad-fefo { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs, .72rem); color: var(--tone-ok, var(--text-muted)); margin-right: .3rem; }

    .cad-empty {
      display: grid; gap: .5rem; justify-items: center; text-align: center;
      padding: 1.5rem 1rem; border: 1px dashed var(--border-color); border-radius: var(--r-md, 8px);
      color: var(--c-text-3, var(--text-muted)); font-size: var(--fs-sm, .85rem);
    }
    .cad-empty i { font-size: 1.4rem; }
    .cad-empty p { margin: 0; }

    /* Skeleton dimensionado: la altura es la de la fila real → CLS 0. */
    .cad-skel { display: grid; gap: .4rem; }
    .cad-skel-row {
      height: 3.4rem; border-radius: var(--r-md, 8px);
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--ink, #000) 4%, transparent),
        color-mix(in oklab, var(--ink, #000) 8%, transparent),
        color-mix(in oklab, var(--ink, #000) 4%, transparent));
      background-size: 200% 100%; animation: cad-shimmer 1.2s ease-in-out infinite;
    }
    @keyframes cad-shimmer { to { background-position: -200% 0; } }

    /* El expediente tiene 7 columnas: en un telefono no cabe de ninguna forma, y
       sin esto su min-content (512px) arrastraba la PAGINA entera a 512 dentro
       de un viewport de 390 - con el excedente RECORTADO, no scrolleable. Ahora
       scrollea dentro de su caja y deja quieto el resto de la pantalla. */
    :host ::ng-deep .cad-hist .p-datatable-table-container { overflow-x: auto; }
    /* Y el min-width: 0 es lo que DEJA que scrollee. El overflow solo no basta:
       .cad-hist es item de un grid con 1fr (= minmax(auto,1fr)) y el minimo
       automatico de un item es el min-content de su contenido, que la tabla
       ponia en 512. Con min-width: 0 el minimo automatico es 0, el track se
       rinde al ancho real y recien entonces la tabla tiene de donde scrollear.
       Es la misma trampa de SM.31 vista desde el lado del item. */
    .cad-hist { min-width: 0; }

    .cad-hrow { cursor: pointer; }
    .cad-chev { color: var(--text-muted); }

    /* Telefono chico (320px). Cantidad y unidad en renglones separados: juntos
       piden 275px y ahi solo hay 218. Chrome mide el min-content de un flex con
       wrap mas ancho que el item mas grande, asi que envolver no alcanza - hay
       que apilar. */
    @container (max-width: 22rem) {
      /* nowrap es obligatorio junto con column: un flex column CON wrap es
         multilinea, y en un multilinea el ancho de la linea lo fija el
         contenido, no el contenedor - align-items: stretch estiraba a 275
         (el max-content de las 4 unidades) dentro de un padre de 218. Con
         nowrap hay una sola linea y ahi si manda el contenedor. */
      .cad-qty { flex-direction: column; flex-wrap: nowrap; align-items: stretch; }
      :host ::ng-deep .cad-qty p-inputnumber { max-width: none; }
    }

    /* Contenedor angosto (teléfono en el anaquel): todo a una columna. */
    @container (max-width: 40rem) {
      .cad-item { grid-template-columns: 1fr; }
      .cad-item-vence { justify-items: start; }
      .cad-actions { flex-direction: column; align-items: stretch; }
    }

    /* Botón de guardar a todo lo ancho en angosto. Un ':host ::ng-deep' NO puede
       ir anidado dentro de otro selector ('.cad-actions :host' no matchea nada),
       así que la container query envuelve la regla completa. */
    @container (max-width: 40rem) {
      :host ::ng-deep .cad-actions .p-button { width: 100%; }
    }

    /* TOUCH: objetivos >=44px (DESIGN §11, Ley de Fitts). El minimo global de
       styles.css solo cubre .comm-actions e icon-btn, y esta pantalla se usa
       CON EL TELEFONO EN LA MANO frente al anaquel. Medido antes: los campos a
       38px, el boton de guardar a 42 y el de ver expediente a 28.
       1rem de letra en los campos no es estetica: por debajo de 16px iOS hace
       zoom al enfocar y descuadra la pantalla a media captura. */
    @media (pointer: coarse) {
      :host ::ng-deep .cad input.p-inputtext,
      :host ::ng-deep .cad .p-inputnumber-input,
      :host ::ng-deep .cad textarea.p-inputtext { min-height: var(--tap-min, 44px); font-size: 1rem; }
      /* PrimeNG v22 no propaga styleClass en p-select: hay que apuntar al
         elemento (mismo hallazgo que en el arqueo). */
      :host ::ng-deep .cad p-select { min-height: var(--tap-min, 44px); align-items: center; }
      :host ::ng-deep .cad p-select .p-select-label { font-size: 1rem; }
      :host ::ng-deep .cad .p-button { min-height: var(--tap-min, 44px); }
      .cad-unit, .cad-chip { min-height: var(--tap-min, 44px); }
    }

    @media (prefers-reduced-motion: reduce) {
      .cad-skel-row, .cad-spin { animation: none; }
      .cad-unit, .cad-chip { transition: none; }
    }
  `],
})
export class TiendaCaducidadesComponent {
  readonly units: { label: string; value: LineUnit; hint: string }[] = [
    { label: 'Caja', value: 'caja', hint: 'Caja cerrada — lo común con código de anaquel' },
    { label: 'Pieza', value: 'pieza', hint: 'Suelto: piñatas, producto individual' },
    { label: 'Bulto', value: 'bulto', hint: 'Bolsa grande / costal' },
    { label: 'Kg', value: 'kg', hint: 'Granel, por peso' },
  ];

  readonly conditions: { label: string; value: Condition }[] = [
    { label: 'Bueno', value: 'bueno' },
    { label: 'Regular', value: 'regular' },
    { label: 'Malo', value: 'malo' },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  // ── permisos: los dos oficios de la pantalla ──
  // `has()` ya deja pasar a los roles de plataforma, así que no hace falta el
  // `isAdmin() || ...` a mano — y al leer del signal de permisos, la pantalla
  // reacciona si el permiso cambia sin recargar (`[ID.21]`).
  readonly puedeCapturar = computed(() => this.perms.has(Permission.COMMERCIAL_EXPIRY_CAPTURAR));
  readonly puedeVer = computed(() => this.perms.has(Permission.COMMERCIAL_EXPIRY_VER));

  // ── contexto (dónde escribo) ──
  readonly ctx = signal<ExpiryCaptureContext | null>(null);
  warehouseId = '';
  readonly sucursalFija = computed<ExpiryWarehouseOption | null>(() => {
    const c = this.ctx();
    return c?.mode === 'own' ? c.warehouse : null;
  });
  readonly puedeElegirSucursal = computed(() => {
    const m = this.ctx()?.mode;
    return m === 'all' || m === 'many';
  });

  // ── formulario de captura ──
  readonly producto = signal<{ id: string | null; nombre: string; sku: string | null; brand: string | null; raw: string | null } | null>(null);
  readonly codigo = signal('');
  readonly resolviendo = signal(false);
  readonly refoco = signal(0);
  readonly candidatos = signal<{ id: string; nombre: string | null; sku: string | null; brand_name: string | null }[]>([]);
  readonly avisoCodigo = signal('');

  readonly fechaRaw = signal('');
  readonly fechaIso = signal<string | null>(null);

  cantidad: number | null = 1;
  readonly unidad = signal<LineUnit | null>(null);
  readonly unidadSugerida = signal('');
  private unidadTocada = false;

  readonly condicion = signal<Condition | null>(null);
  ubicacion = '';
  nota = '';
  readonly foto = signal<ReviewFile | null>(null);
  readonly subiendoFoto = signal(false);
  readonly errorFoto = signal('');
  readonly masAbierto = signal(false);

  readonly guardando = signal(false);
  readonly editandoId = signal<string | null>(null);

  // ── datos ──
  readonly misEntradas = signal<ExpiryEntry[]>([]);
  readonly cargandoMias = signal(false);
  readonly expediente = signal<ExpiryHoja[]>([]);
  readonly cargandoExp = signal(false);

  /** El plazo de lo que se está capturando ahora. */
  readonly plazo = computed<Plazo | null>(() => clasificarPlazo(this.fechaIso()));

  /**
   * KPIs de la jornada. Se pintan solo si hay algo: una tira de ceros al abrir
   * la pantalla es ruido, no información.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const rows = this.misEntradas();
    if (!rows.length) return [];
    let riesgo = 0, vencidos = 0;
    for (const r of rows) {
      const n = this.nivelDe(r);
      if (n === 'vencido') vencidos++;
      else if (n === 'riesgoso') riesgo++;
    }
    return [
      { label: 'Capturado hoy', value: rows.length, format: 'number' },
      { label: 'Por vencer (≤30d)', value: riesgo, format: 'number', tone: riesgo ? 'warn' : 'default' },
      { label: 'Ya vencidos', value: vencidos, format: 'number', tone: vencidos ? 'bad' : 'default' },
    ];
  });

  /**
   * Buscador de producto del módulo de caducidades. Se pasa como `fetch` al
   * typeahead compartido: el colaborador no tiene `COMMERCIAL_PRODUCTS_VER`, así
   * que el buscador general le devolvería 403 en cada tecla.
   *
   * Arrow function a propósito: se pasa por referencia al hijo y necesita `this`.
   */
  readonly buscarProducto = (q: string) =>
    this.svc.searchExpiryProducts(q, 12).pipe(
      map((r) => (r.data || []).map((p): ProductHit => ({
        id: p.id, label: p.nombre || p.sku || '(sin nombre)', sku: p.sku, brand: p.brand_name,
      }))),
    );

  constructor() {
    this.svc.expiryCaptureContext()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (c) => {
          this.ctx.set(c);
          if (c.mode === 'own') this.warehouseId = c.warehouse?.id || '';
          else if (c.mode === 'many') this.warehouseId = c.options[0]?.id || '';
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo resolver tu sucursal', detail: 'Recargá la página; si sigue, avisá a sistemas.' }),
      });

    if (this.puedeCapturar()) this.cargarMias();
    if (this.puedeVer()) this.cargarExpediente();
  }

  // ── carga ──

  cargarMias(): void {
    this.cargandoMias.set(true);
    this.svc.myExpiryEntries(100)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.misEntradas.set(r.data || []); this.cargandoMias.set(false); },
        error: () => { this.cargandoMias.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo leer lo capturado hoy' }); },
      });
  }

  /**
   * Las últimas hojas del expediente de la sucursal. Es un asomo, no el
   * expediente completo: 25 filas para ver qué se levantó, y el botón lleva a
   * `/tienda/caducidades/expediente` donde están los filtros y las 7 sucursales.
   */
  cargarExpediente(): void {
    this.cargandoExp.set(true);
    this.svc.listExpediente({ pageSize: 25 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.expediente.set(r.data || []); this.cargandoExp.set(false); },
        error: () => { this.cargandoExp.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar el expediente' }); },
      });
  }

  onSucursalChange(): void { this.cargarMias(); }

  // ── paso 1: producto ──

  resolverCodigo(code: string): void {
    const c = code.trim();
    if (!c) return;
    this.resolviendo.set(true);
    this.candidatos.set([]);
    this.avisoCodigo.set('');

    this.svc.resolveExpiryCode(c)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.resolviendo.set(false);
          if (r.match) {
            this.fijarProducto({ id: r.match.id, nombre: r.match.nombre || r.match.sku || '(sin nombre)', sku: r.match.sku, brand: r.match.brand_name, raw: c });
            if (!this.unidadTocada && r.match.unit_hint) {
              this.unidad.set(r.match.unit_hint);
              this.unidadSugerida.set(`Unidad sugerida por el código escaneado (${r.match.scanned_unit || r.match.unit_hint}).`);
            }
            return;
          }
          if (r.candidates?.length) { this.candidatos.set(r.candidates); return; }
          this.avisoCodigo.set(r.out_of_scope
            ? 'Ese código es de una marca que no llevás. Avisale al encargado.'
            : 'Ese código no está en el catálogo. Buscalo por nombre, o registralo con el código tal cual.');
        },
        error: () => {
          this.resolviendo.set(false);
          this.avisoCodigo.set('No se pudo consultar el código. Revisá la conexión y disparalo de nuevo.');
        },
      });
  }

  elegirCandidato(c: { id: string; nombre: string | null; sku: string | null; brand_name: string | null }): void {
    this.fijarProducto({ id: c.id, nombre: c.nombre || c.sku || '(sin nombre)', sku: c.sku, brand: c.brand_name, raw: this.codigo().trim() || null });
    this.candidatos.set([]);
  }

  elegirBusqueda(p: ProductHit | null): void {
    if (!p) { this.limpiarProducto(); return; }
    this.fijarProducto({ id: p.id, nombre: p.label, sku: p.sku, brand: p.brand, raw: null });
    // Elegido por nombre: el catálogo no dice en qué unidad está en el anaquel.
    if (!this.unidadTocada) { this.unidad.set('pieza'); this.unidadSugerida.set('Sin código escaneado se asume pieza — cambialo si es caja.'); }
  }

  /** El código no existe en el catálogo pero el producto SÍ está en el anaquel. */
  usarCodigoCrudo(): void {
    const c = this.codigo().trim();
    if (!c) return;
    this.fijarProducto({ id: null, nombre: `Código ${c}`, sku: null, brand: null, raw: c });
    this.avisoCodigo.set('');
    this.toast.add({
      severity: 'warn',
      summary: 'Queda registrado sin catálogo',
      detail: 'Se guarda para que el encargado lo identifique, pero no se refleja en el inventario.',
      life: 6000,
    });
  }

  private fijarProducto(p: { id: string | null; nombre: string; sku: string | null; brand: string | null; raw: string | null }): void {
    this.producto.set(p);
    this.avisoCodigo.set('');
  }

  limpiarProducto(): void {
    this.producto.set(null);
    this.codigo.set('');
    this.candidatos.set([]);
    this.avisoCodigo.set('');
    this.refoco.update((n) => n + 1);
  }

  // ── asistente por voz (P2.7) ──

  /**
   * El asistente entendió algo: se refleja en los tres pasos **en vivo**, para
   * que el colaborador vea lo entendido y corrija ahí mismo. No guarda nada: el
   * botón sigue siendo el de la persona.
   *
   * Solo escribe lo que la voz trajo — si ya había una cantidad teclada y el
   * asistente no habló de cantidad, no se la borra.
   */
  aplicarVoz(sl: VoiceSlots): void {
    if (sl.product_id) {
      this.fijarProducto({
        id: sl.product_id,
        nombre: sl.product_name || sl.product_query || '(sin nombre)',
        sku: sl.sku || null,
        brand: null,
        raw: null,
      });
    }
    if (sl.quantity != null) this.cantidad = sl.quantity;
    if (sl.unit) {
      // Dicho a viva voz ES la decisión del operador: la sugerencia del código
      // no debe pisarla después.
      this.unidadTocada = true;
      this.unidad.set(sl.unit);
      this.unidadSugerida.set('');
    }
    if (sl.expiry_date) {
      // Se pasa por `onFecha` en DDMMAAAA para que la fecha la siga
      // interpretando `parseExpiryShort` (una sola fuente de verdad) y el campo
      // muestre lo mismo que se va a guardar.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sl.expiry_date);
      if (m) this.onFecha(m[3] + m[2] + m[1]);
    }
    if (sl.condition) this.condicion.set(sl.condition);
    if (sl.location) this.ubicacion = sl.location;
    // Esta pantalla juntó observación y acción en una sola "Nota".
    const nota = [sl.observations, sl.action].filter(Boolean).join(' · ');
    if (nota) this.nota = nota;
  }

  // ── paso 2: fecha ──

  /** Dígitos pelados → ISO. `null` mientras esté incompleta: "seguí escribiendo". */
  /**
   * La diagonal la pone la máscara; el parser sigue leyendo los MISMOS dígitos.
   *
   * `fechaRaw` guarda el texto con formato (lo que se ve) y `parseExpiryShort`
   * recibe los dígitos pelados: una sola fuente de verdad para la fecha, y el
   * campo dejó de pedirle al operador que teclee un separador.
   */
  onFecha(v: string): void {
    this.fechaRaw.set(maskExpiryMx(v));
    this.fechaIso.set(parseExpiryShort(digitsOf(v)));
  }

  echo(iso: string | null): string { return formatExpiryEcho(iso); }
  icono(l: Plazo['level']): string { return plazoIcon(l); }
  sev(l: Plazo['level']) { return plazoSeverity(l); }
  cant(v: number | string | null | undefined): string { return formatCantidad(v); }
  uni(v: number | string | null | undefined, u: string | null | undefined): string { return formatUnidad(v, u); }

  // ── paso 3: cantidad ──

  elegirUnidad(u: LineUnit): void {
    this.unidadTocada = true;
    this.unidad.set(u);
    this.unidadSugerida.set('');
  }

  // ── foto ──

  onFoto(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.errorFoto.set('');
    this.subiendoFoto.set(true);

    const reader = new FileReader();
    reader.onload = () => {
      this.svc.uploadExpiryFile(String(reader.result || ''), 'evidencia')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (f) => { this.foto.set(f); this.subiendoFoto.set(false); input.value = ''; },
          error: (e) => {
            this.subiendoFoto.set(false);
            input.value = '';
            // El motivo REAL, no un genérico: el 400 de "almacenamiento no
            // configurado" es de entorno y hay que poder leerlo en pantalla.
            const msg = e?.error?.message || e?.message || 'No se pudo subir la foto.';
            this.errorFoto.set(`${msg} El registro se puede guardar igual, pero queda sin evidencia.`);
          },
        });
    };
    reader.onerror = () => { this.subiendoFoto.set(false); this.errorFoto.set('No se pudo leer el archivo.'); };
    reader.readAsDataURL(file);
  }

  // ── guardar ──

  /** Qué falta para poder guardar, dicho en palabras. Vacío = listo. */
  readonly falta = computed<string>(() => {
    const pend: string[] = [];
    if (!this.producto()) pend.push('el producto');
    if (!this.fechaIso()) pend.push('la fecha de caducidad');
    if (!this.cantidad || this.cantidad <= 0) pend.push('la cantidad');
    if (this.puedeElegirSucursal() && !this.warehouseId) pend.push('la sucursal');
    return pend.join(' · ');
  });

  guardar(): void {
    if (this.falta() || this.guardando()) return;
    const p = this.producto()!;
    const body = {
      product_id: p.id,
      product_code_raw: p.raw || undefined,
      product_name_raw: p.id ? undefined : p.nombre,
      quantity: Number(this.cantidad),
      expiry_date: this.fechaIso(),
      unit: this.unidad() || undefined,
      condition: this.condicion() || undefined,
      location: this.ubicacion.trim() || undefined,
      observations: this.nota.trim() || undefined,
      files: this.foto() ? [this.foto()!] : undefined,
    };

    this.guardando.set(true);
    const editId = this.editandoId();
    const req$ = editId
      ? this.svc.updateExpiryEntry(editId, body)
      : this.svc.createExpiryEntry(this.puedeElegirSucursal() ? { ...body, warehouse_id: this.warehouseId } : body);

    req$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (e) => {
        this.guardando.set(false);
        this.toast.add({
          severity: 'success',
          summary: editId ? 'Corregido' : 'Registrado',
          detail: e.fed_to_fefo ? 'Ya se reflejó en el control de inventario.' : 'Guardado. No mueve inventario (falta stock o catálogo).',
          life: 3500,
        });
        this.limpiarFormulario();
        this.cargarMias();
        if (this.puedeVer()) this.cargarExpediente();
      },
      error: (err) => {
        this.guardando.set(false);
        this.toast.add({
          severity: 'error',
          summary: editId ? 'No se pudo corregir' : 'No se pudo registrar',
          detail: err?.error?.message || 'Intentá de nuevo; si sigue, avisá a sistemas.',
          life: 7000,
        });
      },
    });
  }

  /**
   * Deja la pantalla lista para el siguiente producto. **Ubicación y unidad se
   * conservan**: quien recorre un anaquel captura diez cajas del mismo estante,
   * y volver a teclear "Anaquel 3" diez veces es trabajo inventado.
   */
  private limpiarFormulario(): void {
    this.editandoId.set(null);
    this.producto.set(null);
    this.codigo.set('');
    this.candidatos.set([]);
    this.avisoCodigo.set('');
    this.fechaRaw.set('');
    this.fechaIso.set(null);
    this.cantidad = 1;
    this.condicion.set(null);
    this.nota = '';
    this.foto.set(null);
    this.errorFoto.set('');
    this.refoco.update((n) => n + 1);
  }

  // ── corregir / borrar lo del turno ──

  editar(e: ExpiryEntry): void {
    this.editandoId.set(e.id);
    this.producto.set({
      id: e.product_id || null,
      nombre: e.product_name || e.product_name_raw || e.product_code_raw || '(sin producto)',
      sku: e.sku || null,
      brand: null,
      raw: e.product_code_raw || null,
    });
    const iso = this.ymd(e.expiry_date);
    this.fechaIso.set(iso || null);
    // De vuelta a los dígitos que se teclean: ISO `2027-03-15` → `15032027`
    // (DDMMAAAA, la forma de 8 dígitos que entiende `parseExpiryShort`). Escribir
    // acá `AAMMDD` haría que el campo se re-interprete como otra fecha al tocarlo.
    this.fechaRaw.set(iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : '');
    this.cantidad = Number(e.quantity) || 0;
    this.unidad.set((e.unit as LineUnit) || null);
    this.condicion.set((e.condition as Condition) || null);
    this.ubicacion = e.location || '';
    this.nota = e.observations || '';
    this.foto.set(e.files?.length ? e.files[0] : null);
    this.masAbierto.set(true);
    // El formulario está arriba: si no se sube, el click "no hace nada".
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  cancelarEdicion(): void { this.limpiarFormulario(); }

  borrar(e: ExpiryEntry): void {
    const nombre = e.product_name || e.product_name_raw || e.product_code_raw || 'este registro';
    this.confirm.confirm({
      header: 'Borrar el registro',
      message: `¿Borrar ${nombre}? Si ya se reflejó en el inventario, se deshace también.`,
      acceptLabel: 'Borrar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.deleteExpiryEntry(e.id)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.toast.add({ severity: 'success', summary: 'Borrado' });
              if (this.editandoId() === e.id) this.limpiarFormulario();
              this.cargarMias();
              if (this.puedeVer()) this.cargarExpediente();
            },
            error: (err) => this.toast.add({
              severity: 'error',
              summary: 'No se pudo borrar',
              detail: err?.error?.message || 'Intentá de nuevo.',
              life: 8000,
            }),
          });
      },
    });
  }

  // ── expediente ──

  /** Abre el formato imprimible. Por folio cuando lo hay: la URL queda citable. */
  verHoja(h: { folio?: string | null; id: string }): void {
    this.router.navigate(['/tienda/caducidades/hoja', h.folio || h.id]);
  }

  irAlExpediente(): void { this.router.navigate(['/tienda/caducidades/expediente']); }

  // ── helpers de presentación ──

  aviso(msg: string): void { this.toast.add({ severity: 'warn', summary: 'Cámara', detail: msg, life: 6000 }); }

  /** `date` de Postgres llega como ISO completo; se usa el tramo YYYY-MM-DD. */
  ymd(v: string | null | undefined): string {
    const s = String(v || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  plazoDe(e: { expiry_date?: string | null }): Plazo | null { return clasificarPlazo(this.ymd(e.expiry_date)); }
  nivelDe(e: { expiry_date?: string | null }): Plazo['level'] | null { return this.plazoDe(e)?.level ?? null; }

  fmtFecha(v: string | null | undefined): string {
    const s = this.ymd(v);
    if (!s) return '—';
    const p = s.split('-');
    return `${p[2]}/${p[1]}/${p[0]}`;
  }
}
