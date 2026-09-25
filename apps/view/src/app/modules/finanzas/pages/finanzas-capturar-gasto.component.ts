import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { ComprobacionesService, SolicitudSug, ProofFile, ProofFileRole, ProofPhotoOcr, ExpenseProof, ExpenseClasificacion, ProofByFolio, requiereEvidencia, type ListasParaComprobar } from '../comprobaciones.service';
// [GX.14] El catálogo de formas de pago y la compuerta se IMPORTAN del contrato
// compartido: son los mismos que valida el backend. Copiarlos acá los separa.
import { FORMAS_PAGO, faltaParaMandar, type FormaPagoId, type Faltante } from '@megadulces/contracts';
import { CapturaEnVivoComponent } from '../components/captura-en-vivo.component';

/** En qué momento del ciclo está la solicitud elegida, y por tanto qué muestra la página. */
type CapMode = 'checking' | 'capturar' | 'evidencia' | 'esperando' | 'revision' | 'cerrada';

/** Solicitud de Kepler elegida (read-only) — el capturista sólo confirma que es la correcta. */
interface SelSolicitud { folio: string; beneficiario: string | null; importe: number; sucursal: string | null; solicitante: string | null; fecha: string | null; concepto: string | null; }

/**
 * GX.8 — Vista del CAPTURISTA (rol `FINANCE_EXPENSES_CAPTURAR`). Superficie mínima:
 * pega el folio del gasto que le dieron de Kepler, sube el/los comprobante(s), envía.
 * Todo lo demás (proveedor, importe, área, solicitud) lo deriva el sistema del gasto
 * Kepler. No ve la bandeja de revisión ni valida — eso es del autorizador. Móvil-first.
 */
@Component({
  selector: 'app-finanzas-capturar-gasto',
  standalone: true,
  imports: [CommonModule, FormsModule, AutoCompleteModule, TagModule, ButtonModule, InputTextModule, TextareaModule, SelectButtonModule, ToastModule, CapturaEnVivoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cap">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Capturar gasto</h1>
          <p class="surf-page-sub">Pega el folio de la solicitud (Kepler), sube la solicitud firmada y —si aplica— el comprobante. Lo demás lo llena el sistema.</p>
        </div>
      </header>

      <div class="card-premium card-flat cap-card">
        <!-- 1) Folio del gasto -->
        @if (!gasto()) {
          <label class="cap-f"><span>1 · Folio de la solicitud (Kepler)</span>
            <p-autocomplete [(ngModel)]="sel" [suggestions]="sug()" (completeMethod)="buscar($event)"
              (onSelect)="pick($event)" optionLabel="label" [forceSelection]="false" [showClear]="true"
              placeholder="Últimos 4 dígitos, ej. 8489" appendTo="body" styleClass="w-full"
              [emptyMessage]="vacioMsg()" />
            <em class="cap-hint">Con los últimos dígitos basta: el 23 encuentra el folio 0000023. También podés buscar por beneficiario.</em>
          </label>
        } @else {
          <div class="cap-gasto">
            <div class="cap-g-top">
              <div>
                <div class="cap-g-folio">Solicitud <span class="mono">{{ gasto()!.folio }}</span></div>
                <div class="cap-g-prov">{{ gasto()!.beneficiario || '—' }}</div>
              </div>
              <div class="cap-g-imp">{{ moneyFull(gasto()!.importe) }}</div>
            </div>
            <div class="cap-g-meta">
              @if (gasto()!.sucursal) { <span><i class="pi pi-map-marker" aria-hidden="true"></i> {{ gasto()!.sucursal }}</span> }
              @if (gasto()!.solicitante) { <span><i class="pi pi-user" aria-hidden="true"></i> {{ gasto()!.solicitante }}</span> }
              @if (gasto()!.fecha) { <span><i class="pi pi-calendar" aria-hidden="true"></i> {{ gasto()!.fecha | date:'dd/MM/yy' }}</span> }
            </div>
            @if (gasto()!.concepto) { <div class="cap-g-meta"><span><i class="pi pi-align-left" aria-hidden="true"></i> {{ gasto()!.concepto }}</span></div> }
            <button type="button" class="cap-link" (click)="reset()">cambiar solicitud</button>
          </div>

          @switch (modo()) {
            @case ('checking') { <div class="cap-muted"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Revisando el estado de esta solicitud…</div> }

            <!-- ── Capturar el expediente completo: firmada + tipo + el ticket (GX.11). -->
            @case ('capturar') {
              @if (yaRechazada()) {
                <div class="cap-val warn"><i class="pi pi-replay" aria-hidden="true"></i> Esta solicitud fue devuelta. Vuelve a capturarla.</div>
              }
              <!-- 2) Solicitud firmada: OBLIGATORIA siempre (la autorización que respalda la
                   salida de dinero). Va en los tres tipos de gasto, incluso no comprobable. -->
              <div class="cap-step">2 · Sube la solicitud firmada</div>
              @if (!names()['solicitud_kepler']) {
                <div class="cap-drop" [class.drag]="dragSol()" (dragover)="overSol($event)" (dragleave)="leaveSol($event)" (drop)="dropSol($event)">
                  <i class="pi pi-file-edit cap-drop-ic" aria-hidden="true"></i>
                  <div>Arrastra la <strong>solicitud de gasto firmada</strong> (foto o PDF)</div>
                  <label class="cap-pick"><i class="pi pi-upload" aria-hidden="true"></i> Elegir / tomar foto
                    <input type="file" accept="image/*,application/pdf" capture="environment" (change)="onFile($event, 'solicitud_kepler')" hidden />
                  </label>
                </div>
              } @else {
                <div class="cap-done">
                  <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()['solicitud_kepler'] }}</span>
                  <button type="button" class="cap-link" (click)="clearFile('solicitud_kepler')">cambiar</button>
                </div>
              }

              <!-- 3) Clasificación del gasto: decide si lleva ticket o motivo. -->
              <div class="cap-step">3 · ¿Qué tipo de gasto es?</div>
              <p-selectbutton [options]="clasOpts" [(ngModel)]="clasificacionV" (ngModelChange)="onClasChange()"
                              optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="cap-clas"
                              ariaLabel="Tipo de gasto" />
              @if (clasificacion()) { <em class="cap-hint">{{ clasHint() }}</em> }

              @if (clasificacion()) {
                <!-- [GX.14] Paso propio, y ANTES de la foto: se pregunta en los tres tipos
                     de gasto, porque el dinero salió de algún lado aunque no haya papel.
                     Kepler tiene la columna y nadie la llena — 5,410 de 10,082 vacías. -->
                <div class="cap-step">4 · ¿Cómo se pagó?</div>
                <div class="cap-fp">
                  @for (f of formasPago; track f.id) {
                    <button type="button" class="cap-fp-b" [class.on]="formaPago() === f.id"
                            [attr.aria-pressed]="formaPago() === f.id" (click)="elegirForma(f.id)">
                      <span class="cap-fp-t">{{ f.label }}</span>
                      <span class="cap-fp-c">{{ f.codigo_kepler }}</span>
                    </button>
                  }
                </div>
                @if (formaSel(); as fs) {
                  @if (fs.detalle_label) {
                    <label class="cap-f"><span>{{ fs.detalle_label }}</span>
                      <input pInputText [(ngModel)]="formaPagoDetalleV" [placeholder]="fs.detalle_ejemplo || ''" class="w-full" />
                    </label>
                  }
                }

                @if (llevaEvidencia()) {
                  <!-- GX.11 — la evidencia se sube ACÁ. Antes se difería hasta después de
                       aprobar; como el expediente siempre se captura DESPUÉS de gastar, el
                       ticket ya existe y diferirlo sólo dejaba expedientes a medias. -->
                  <div class="cap-step">5 · Tomá {{ clasificacion() === 'fiscal' ? 'la factura' : 'el ticket' }}</div>
                  @if (!names()['comprobante_1']) {
                    <!-- [GX.14] Se fue el input de archivo y el arrastrar-y-soltar. El
                         atributo capture="environment" de antes era una sugerencia: en escritorio
                         abría el explorador y en móvil la galería seguía disponible. -->
                    <md-captura-en-vivo (capturada)="onCaptura($event)" />
                  } @else {
                    <div class="cap-done">
                      <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()['comprobante_1'] }}</span>
                      @if (photoLoading()) { <span class="cap-proc"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> leyendo…</span> }
                      <button type="button" class="cap-link" (click)="clearPhoto()">cambiar</button>
                    </div>
                    @if (photoResult(); as pr) {
                      @if (pr.ocr_status === 'ok' && pr.monto_match) { <div class="cap-val ok"><i class="pi pi-check-circle" aria-hidden="true"></i> El monto de la foto cuadra con el gasto.</div> }
                      @else if (pr.ocr_status === 'ok') { <div class="cap-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> El monto no cuadra — igual puedes enviarlo; quedará en revisión.</div> }
                      @else if (pr.ocr_status === 'sin_key') { <div class="cap-val warn"><i class="pi pi-info-circle" aria-hidden="true"></i> Se enviará para revisión manual.</div> }
                      @else { <div class="cap-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No pude leer la foto — quedará en revisión.</div> }
                    }
                  }
                  <label class="cap-f"><span>Comentarios (opcional)</span>
                    <textarea pTextarea [(ngModel)]="comentarios" rows="2" class="w-full" placeholder="Nota para quien autoriza…"></textarea></label>
                } @else {
                  <!-- No comprobable: sin foto nunca, pero el motivo es obligatorio y auditable. -->
                  <div class="cap-step">4 · ¿Por qué no se puede comprobar?</div>
                  <textarea pTextarea [(ngModel)]="comentarios" rows="3" class="w-full"
                            placeholder="Ej. propina, gasto en efectivo sin recibo, viático sin factura…"></textarea>
                  <em class="cap-hint">Este gasto se registra <strong>sin evidencia</strong>. El motivo lo lee quien aprueba.</em>
                }
              }

              @if (formError()) { <div class="cap-err">{{ formError() }}</div> }
              <!-- [GX.14] Qué falta, dicho antes de apretar. La lista NO se arma acá: sale
                   de faltaParaMandar(), la misma función que devuelve el 400 del backend. -->
              @if (clasificacion() && faltan().length) {
                <ul class="cap-faltan">
                  @for (f of faltan(); track f.id) { <li><i class="pi pi-circle" aria-hidden="true"></i> {{ f.label }}</li> }
                </ul>
              }
              <button pButton type="button" class="cap-send" [loading]="saving()"
                      [disabled]="!puedeEnviar() || saving()" [title]="enviarTitle()" (click)="submit()">
                <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">Enviar a aprobación</span>
              </button>
            }

            <!-- ── MOMENTO 3 · el gasto ya fue APROBADO y es comprobable: sube la evidencia. -->
            @case ('evidencia') {
              <div class="cap-val ok"><i class="pi pi-check-circle" aria-hidden="true"></i>
                Solicitud <strong>aprobada</strong>. Sube la {{ existing()?.clasificacion === 'fiscal' ? 'factura' : 'evidencia' }} para cerrarla.</div>
              <div class="cap-step">Sube la evidencia</div>
              @if (!names()['comprobante_1']) {
                <!-- [GX.14] Misma regla que en la captura: si acá quedara el input de
                     archivo, la compuerta de arriba sería decorativa — bastaba con esperar
                     la aprobación para subir cualquier cosa. -->
                <md-captura-en-vivo (capturada)="onCaptura($event)" etiqueta="Capturar evidencia" />
              } @else {
                <div class="cap-done">
                  <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()['comprobante_1'] }}</span>
                  @if (photoLoading()) { <span class="cap-proc"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> leyendo…</span> }
                  <button type="button" class="cap-link" (click)="clearPhoto()">cambiar</button>
                </div>
                @if (photoResult(); as pr) {
                  @if (pr.ocr_status === 'ok' && pr.monto_match) { <div class="cap-val ok"><i class="pi pi-check-circle" aria-hidden="true"></i> El monto de la foto cuadra con el gasto.</div> }
                  @else if (pr.ocr_status === 'ok') { <div class="cap-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> El monto no cuadra — igual puedes enviarlo; quedará en revisión.</div> }
                  @else if (pr.ocr_status === 'sin_key') { <div class="cap-val warn"><i class="pi pi-info-circle" aria-hidden="true"></i> Se enviará para revisión manual.</div> }
                  @else { <div class="cap-val warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No pude leer la foto — quedará en revisión.</div> }
                }
              }
              <label class="cap-f"><span>Comentarios (opcional)</span>
                <textarea pTextarea [(ngModel)]="comentarios" rows="2" class="w-full" placeholder="Nota para quien valida…"></textarea></label>

              @if (formError()) { <div class="cap-err">{{ formError() }}</div> }
              <button pButton type="button" class="cap-send" [loading]="saving()"
                      [disabled]="!puedeEnviar() || saving() || photoLoading()" [title]="enviarTitle()" (click)="submit()">
                <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">Enviar evidencia</span>
              </button>
            }

            <!-- ── Estados sin acción para el capturista. -->
            @case ('esperando') {
              <div class="cap-state"><i class="pi pi-clock" aria-hidden="true"></i>
                Ya la capturaste. Está <strong>esperando aprobación</strong>. Cuando la aprueben, si lleva evidencia, aquí podrás subirla.</div>
            }
            @case ('revision') {
              <div class="cap-state"><i class="pi pi-hourglass" aria-hidden="true"></i>
                La evidencia ya está subida y la revisa Tesorería. No hace falta nada de tu parte.</div>
            }
            @case ('cerrada') {
              <div class="cap-state ok"><i class="pi pi-check-circle" aria-hidden="true"></i>
                Esta solicitud ya está <strong>validada / cerrada</strong>. No hay nada que capturar.</div>
            }
          }
        }
      </div>

      <!-- [GX.15] Lo que Kepler ya autorizo y aplico: la comprobacion queda lista sola. -->
      <div class="cap-mine">
        <div class="cap-mine-h">
          <h2>Listas para comprobar</h2>
          <button type="button" class="cap-link" (click)="loadListas()"><i class="pi pi-refresh" aria-hidden="true"></i> actualizar</button>
        </div>
        @if (listasLoading()) { <div class="cap-muted">Cargando…</div> }
        @else if (listas(); as lp) {
          @if (!lp.medido) {
            <div class="cap-muted">No se puede saber cuáles son tuyas: {{ lp.motivo }}</div>
          } @else if (!lp.rows.length) {
            <div class="cap-muted">Nada por comprobar en los últimos {{ lp.ventana_dias }} días.</div>
          } @else {
            <p class="cap-muted">{{ lp.rows.length }} gasto(s) ya aplicados en Kepler, esperando su comprobación.</p>
            <div class="cap-list">
              @for (g of lp.rows; track g.folio_gasto) {
                <div class="cap-item">
                  <div class="cap-it-main">
                    <strong>{{ g.concepto || g.beneficiario || "—" }}</strong>
                    <span class="cap-it-prov">gasto {{ g.folio_gasto }} · solicitud {{ g.solicitud_folio }}</span>
                    <span class="cap-it-date">{{ g.fecha_gasto | date: "dd/MM/yy" }}</span>
                  </div>
                  <div class="cap-it-side">
                    <span class="cap-it-imp">{{ moneyFull(g.importe) }}</span>
                    @if (g.cuadra_con_solicitud === false) {
                      <span class="cap-it-note warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                        no cuadra con lo solicitado ({{ moneyFull(g.solicitud_importe) }})</span>
                    }
                    <button type="button" class="cap-link" [disabled]="pdfCargando() === g.solicitud_folio"
                            (click)="verExpediente(g.sucursal, g.solicitud_folio)">
                      <i class="pi pi-file-pdf" aria-hidden="true"></i>
                      {{ pdfCargando() === g.solicitud_folio ? "armando…" : "expediente" }}
                    </button>
                  </div>
                </div>
              }
            </div>
          }
        }
      </div>

      <!-- Mis capturas -->
      <div class="cap-mine">
        <div class="cap-mine-h"><h2>Mis últimas capturas</h2><button type="button" class="cap-link" (click)="loadMine()"><i class="pi pi-refresh" aria-hidden="true"></i> actualizar</button></div>
        @if (mineLoading()) { <div class="cap-muted">Cargando…</div> }
        @else if (!mine().length) { <div class="cap-muted">Aún no has capturado comprobantes.</div> }
        @else {
          <div class="cap-list">
            @for (m of mine(); track m.id) {
              <div class="cap-item">
                <div class="cap-it-main">
                  <span class="mono">{{ m.folio_solicitud }}</span>
                  <span class="cap-it-prov">{{ m.proveedor }}</span>
                </div>
                <div class="cap-it-side">
                  <span class="cap-it-imp">{{ moneyFull(m.importe) }}</span>
                  <p-tag [value]="statusLabel(m.status)" [severity]="statusSev(m.status)" />
                  <span class="cap-it-date">{{ m.created_at | date:'dd/MM HH:mm' }}</span>
                </div>
                @if (m.status === 'rechazada' && m.motivo_rechazo) { <div class="cap-it-note bad"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ m.motivo_rechazo }} — vuelve a capturar el folio {{ m.folio_solicitud }}.</div> }
                @else if (m.status === 'revision' && m.revision_nota) { <div class="cap-it-note warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ m.revision_nota }}</div> }
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    /* Columna angosta: esto es un flujo de un solo hilo (elegí, subí, enviá), no una
       bandeja. El resto de Operations es full-width porque ahí sí se compara. */
    .cap { max-width: 44rem; margin: 0 auto; }
    .card-premium.cap-card { display: flex; flex-direction: column; gap: var(--sp-4);
      padding: var(--sp-4); box-shadow: none; }
    .card-premium.cap-card:hover { box-shadow: none; }
    .cap-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .cap-f > span { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .cap-hint { font-size: var(--fs-xs); color: var(--fg-3); font-style: normal; }
    .w-full { width: 100%; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    /* Ficha de la solicitud elegida, hundida respecto de la card.
       Ojo: --surface-sunken NO existe en tokens.css, así que el fallback la dejaba del
       mismo color que la card y el hundido no se veía nunca. */
    .cap-gasto { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cap-g-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); }
    .cap-g-folio { font-size: var(--fs-xs); color: var(--fg-3); }
    .cap-g-prov { margin-top: 1px; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cap-g-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--fg-1); white-space: nowrap; }
    .cap-g-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3);
      font-size: var(--fs-xs); color: var(--fg-2); }
    .cap-g-meta span { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .cap-cuadre { display: inline-flex; align-items: center; gap: var(--sp-1);
      padding: var(--sp-1) var(--sp-2); font-size: var(--fs-xs);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); color: var(--fg-2); }
    .cap-cuadre.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .cap-cuadre.bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cap-link { align-self: flex-start; min-height: max(1.5rem, var(--tap-min)); padding: 0; border: 0;
      background: none; font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer;
      text-decoration: underline; text-underline-offset: 2px; }
    .cap-link:hover { color: var(--action-hover); }
    .cap-link:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .cap-step { padding-top: var(--sp-3); border-top: 1px solid var(--border-color);
      font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    /* Clasificación: que las 3 opciones quepan y envuelvan en móvil. */
    :host ::ng-deep .cap-clas { display: flex; flex-wrap: wrap; }
    :host ::ng-deep .cap-clas .p-togglebutton, :host ::ng-deep .cap-clas .p-button { flex: 1 1 auto; }

    .cap-drop { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      padding: var(--sp-6) var(--sp-4); text-align: center; font-size: var(--fs-sm); color: var(--fg-2);
      border: 2px dashed var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cap-drop.drag { border-color: var(--action); background: var(--overlay-selected); }
    /* Ícono de la zona: neutro. El naranja es de la acción, no de la decoración. */
    .cap-drop-ic { font-size: var(--fs-h1); color: var(--fg-3); }
    /* Se ve como botón secundario porque ES el botón. El input va oculto para poder ofrecer
       cámara y arrastrar-soltar, que p-fileupload en modo básico no da. */
    .cap-pick { display: inline-flex; align-items: center; gap: var(--sp-2);
      min-height: max(2.25rem, var(--tap-min)); padding: 0 var(--sp-4);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg);
      font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); cursor: pointer;
      transition: border-color var(--dur-short) var(--ease-standard), color var(--dur-short) var(--ease-standard); }
    .cap-pick:hover { border-color: var(--action); color: var(--action); }
    .cap-pick:focus-within { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    .cap-done { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-sm); border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--surface-ground); }
    .cap-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap-ok { color: var(--ok-fg); }
    .cap-proc { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--fg-2); }
    /* Veredicto de la lectura: ícono + texto; el color acompaña, no carga solo. */
    .cap-val { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-xs); line-height: 1.4; border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .cap-val.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .cap-val.warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .cap-val.info { color: var(--fg-2); background: var(--surface-ground); }
    /* Estado sin acción para el capturista (esperando/en revisión/cerrada): informativo,
       centrado, sin gritar. Icono + texto, nunca sólo color. */
    .cap-state { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-4);
      font-size: var(--fs-sm); line-height: 1.45; color: var(--fg-2);
      border: 1px dashed var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cap-state > i { font-size: var(--fs-h3); color: var(--fg-3); }
    .cap-state.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); border-style: solid; }
    .cap-state.ok > i { color: var(--ok-fg); }
    .cap-err { font-size: var(--fs-xs); color: var(--bad-fg); }
    .cap-send { justify-content: center; }

    .cap-mine { margin-top: var(--sp-6); }
    .cap-mine-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-4); }
    .cap-mine-h h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cap-muted { font-size: var(--fs-sm); color: var(--fg-2); }
    .cap-list { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cap-item { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .cap-it-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); }
    .cap-it-prov { font-size: var(--fs-sm); color: var(--fg-2); }
    .cap-it-side { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); }
    .cap-it-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .cap-it-date { margin-left: auto; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-xs); color: var(--fg-3); }
    .cap-it-note { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); }
    .cap-it-note.bad { color: var(--bad-fg); }
    .cap-it-note.warn { color: var(--warn-fg); }
  `],
})
export class FinanzasCapturarGastoComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly gasto = signal<SelSolicitud | null>(null);
  readonly sug = signal<(SolicitudSug & { label: string })[]>([]);
  sel: (SolicitudSug & { label: string }) | string | null = null;
  comentarios = '';

  /** Expediente ya existente para el folio elegido — decide en qué MOMENTO está la captura. */
  readonly existing = signal<ProofByFolio | null>(null);
  readonly checking = signal(false);
  readonly yaRechazada = computed(() => this.existing()?.status === 'rechazada');
  /**
   * Modo de la página. Dos momentos separados: capturar la solicitud (recibida) y —sólo
   * tras aprobar un gasto comprobable— subir la evidencia (aprobada). El resto son estados
   * sin acción para el capturista.
   */
  readonly modo = computed<CapMode>(() => {
    if (this.checking()) return 'checking';
    const p = this.existing();
    if (!p || p.status === 'rechazada') return 'capturar';
    if (p.status === 'recibida') return 'esperando';
    if (p.status === 'aprobada') return (p.requiere_evidencia && !p.comprobante) ? 'evidencia' : 'cerrada';
    if (p.status === 'revision') return 'revision';
    return 'cerrada'; // validada
  });

  /** Clasificación del gasto: decide si lleva evidencia. Obligatoria para enviar. */
  readonly clasificacion = signal<ExpenseClasificacion | null>(null);
  /** ngModel del selectbutton (no toma signal directo). */
  clasificacionV: ExpenseClasificacion | null = null;
  readonly clasOpts = [
    { label: 'Con factura', value: 'fiscal' },
    { label: 'Sólo ticket o recibo', value: 'no_fiscal_comprobable' },
    { label: 'Sin comprobante', value: 'no_comprobable' },
  ];
  readonly llevaEvidencia = computed(() => requiereEvidencia(this.clasificacion()));
  onClasChange() { this.clasificacion.set(this.clasificacionV); this.formError.set(''); }
  clasHint(): string {
    switch (this.clasificacion()) {
      case 'fiscal': return 'Te dieron factura. Adjuntala.';
      case 'no_fiscal_comprobable': return 'No hay factura, pero sí ticket o recibo. Adjunta la foto.';
      case 'no_comprobable': return 'No hay documento que lo respalde. Se registra con un motivo, sin foto.';
      default: return '';
    }
  }
  /** Poka-yoke del envío: la solicitud firmada es obligatoria SIEMPRE; la clasificación
   *  decide si además falta evidencia o motivo. */
  /**
   * `[GX.14]` Lo que falta para poder mandar, según la MISMA función que usa el backend
   * para devolver el 400 (`faltaParaMandar`, en `@megadulces/contracts`).
   *
   * Antes esta lógica estaba escrita acá y otra vez en el servicio. Con dos copias, la
   * regla se separa en cuanto una cambia — el defecto que ADR-056 midió ocho veces.
   */
  readonly faltan = computed<Faltante[]>(() => faltaParaMandar({
    forma_pago: this.formaPago(),
    forma_pago_detalle: this.formaPagoDetalleV,
    // El sello viaja por rol: `names` sólo dice que hay archivo, no de dónde salió.
    archivos: Object.keys(this.names()).map((role) => ({ role, live: this.sellos()[role]?.live === true })),
    exige_evidencia: this.llevaEvidencia(),
  }));

  puedeEnviar(): boolean {
    if (!this.gasto()) return false;
    if (this.modo() === 'evidencia') return !!this.names()['comprobante_1'] && !this.photoLoading();
    if (this.modo() !== 'capturar') return false;
    if (!this.clasificacion()) return false;
    if (!this.names()['solicitud_kepler']) return false;   // la firma va en los 3 tipos
    if (this.photoLoading()) return false;
    // GX.14 — la compuerta compartida cubre forma de pago + foto en vivo. El motivo del
    // no_comprobable NO está ahí a propósito: es una regla de ESTA pantalla (el backend la
    // valida aparte contra `comentarios`), y meterla en el contrato la haría depender de
    // un campo que el contrato no ve.
    if (this.faltan().length) return false;
    return this.llevaEvidencia() ? true : !!this.comentarios.trim();
  }
  enviarTitle(): string {
    if (this.modo() === 'evidencia') return this.names()['comprobante_1'] ? 'Enviar evidencia' : 'Falta capturar la evidencia';
    if (!this.names()['solicitud_kepler']) return 'Falta la solicitud firmada';
    if (!this.clasificacion()) return 'Elige el tipo de gasto';
    // [GX.14] El primer faltante de la compuerta manda el texto: es el que hay que
    // resolver primero, y sale de la misma lista que ve la persona en pantalla.
    const f = this.faltan()[0];
    if (f) return `Falta: ${f.label}`;
    if (!this.llevaEvidencia() && !this.comentarios.trim()) return 'Falta el motivo';
    return 'Enviar a aprobación';
  }

  /** `[GX.14]` El catálogo, tal cual viene del contrato. La plantilla lo recorre. */
  readonly formasPago = FORMAS_PAGO;
  readonly formaPago = signal<FormaPagoId | null>(null);
  /** ngModel del detalle (caja, últimos 4, referencia…). */
  formaPagoDetalleV = '';
  readonly formaSel = computed(() => FORMAS_PAGO.find((f) => f.id === this.formaPago()) ?? null);

  /**
   * `[GX.14]` De dónde salió cada archivo, por rol.
   *
   * Va aparte de `names` a propósito: `names` contesta «hay archivo» y esto contesta
   * «se tomó en el momento», que son dos preguntas distintas — y la compuerta necesita
   * la segunda. Mezclarlas obligaría a inferir el sello del nombre del archivo.
   */
  readonly sellos = signal<Record<string, { live: boolean; captured_at: string }>>({});

  elegirForma(id: FormaPagoId) {
    // Cambiar de forma borra el detalle: un número de cheque no sirve como referencia
    // de transferencia, y dejarlo ahí lo mandaría con la etiqueta equivocada.
    if (this.formaPago() !== id) this.formaPagoDetalleV = '';
    this.formaPago.set(id);
  }

  /** `[GX.14]` Llega una foto recién tomada: se guarda como el comprobante, con su sello. */
  onCaptura(ev: { dataUrl: string; capturedAt: string }) {
    const role = 'comprobante_1';
    this.formError.set('');
    this.guardarCaptura(role, ev.dataUrl, ev.capturedAt);
  }

  readonly photoLoading = signal(false);
  readonly photoResult = signal<ProofPhotoOcr | null>(null);
  readonly names = signal<Record<string, string>>({});
  private fileData: Record<string, string> = {};
  private uploaded: Record<string, ProofFile> = {};
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly drag = signal(false);
  /** Drag propio de la zona de la solicitud firmada (para no encender ambas zonas a la vez). */
  readonly dragSol = signal(false);

  /** `[GX.15]` Lo que ya se puede comprobar (Kepler autorizó y aplicó el gasto). */
  readonly listas = signal<ListasParaComprobar | null>(null);
  readonly listasLoading = signal(false);
  /** Folio cuyo PDF se está armando, para no dejar el botón mudo mientras tarda. */
  readonly pdfCargando = signal<string | null>(null);

  readonly mine = signal<ExpenseProof[]>([]);
  readonly mineLoading = signal(false);

  constructor() { this.loadMine(); this.loadListas(); }

  /** Último término buscado, para poder explicar un resultado vacío. */
  private readonly ultimo = signal('');
  /**
   * Un desplegable vacío sin explicación es el peor resultado posible: no se distingue
   * «ese folio no existe» de «no tenés alcance para verlo». Se dice cuál de las dos.
   */
  vacioMsg(): string {
    const q = this.ultimo();
    if (!q) return 'Escribí el folio de la solicitud.';
    if (/^[0-9]+$/.test(q)) return `No hay ninguna solicitud con folio ${q}. Revisá el número — el folio del gasto y el de la solicitud NO son el mismo.`;
    return 'Sin coincidencias. Si buscás por nombre y no sale nada, puede que no tengas áreas de gasto asignadas: buscá por folio exacto.';
  }

  buscar(ev: { query: string }) {
    const q = (ev.query || '').trim();
    this.ultimo.set(q);
    if (!q.length || (q.length < 2 && !/^[0-9]+$/.test(q))) { this.sug.set([]); return; }
    this.svc.searchSolicitudes(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((rows) => {
      this.sug.set((rows || []).map((r) => ({ ...r, label: `${r.folio} · suc ${r.sucursal || '?'} · ${r.beneficiario || '—'} · ${this.moneyFull(r.importe)}` })));
      this.cdr.markForCheck();
    });
  }

  pick(ev: { value: SolicitudSug & { label: string } } | (SolicitudSug & { label: string })) {
    const g = (ev as { value: SolicitudSug & { label: string } }).value ?? (ev as SolicitudSug & { label: string });
    if (!g || typeof g === 'string') return;
    this.gasto.set({ folio: g.folio, beneficiario: g.beneficiario, importe: Number(g.importe) || 0,
      sucursal: g.sucursal, solicitante: g.solicitante, fecha: g.fecha, concepto: g.concepto });
    this.sel = null;
    this.checkFolio(g.folio, g.sucursal ?? undefined);
  }

  /** Averigua en qué momento está el folio para elegir el modo de la página (capturar
   *  solicitud vs subir evidencia post-aprobación vs sin acción). */
  private checkFolio(folio: string, sucursal?: string) {
    this.existing.set(null);
    this.checking.set(true);
    // La sucursal desambigua: el folio de Kepler es único por plaza, no global (373 folios
    // viven en más de una). Viene de la solicitud elegida en el autocomplete.
    this.svc.proofByFolio(folio, sucursal).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.existing.set(p || null);
        this.checking.set(false);
        // En modo evidencia la clasificación ya la fijó la captura: reflejarla para el copy.
        if (p && p.status === 'aprobada' && p.clasificacion) {
          this.clasificacion.set(p.clasificacion as ExpenseClasificacion);
          this.clasificacionV = p.clasificacion as ExpenseClasificacion;
        }
        this.cdr.markForCheck();
      },
      error: () => { this.checking.set(false); this.cdr.markForCheck(); },
    });
  }

  reset() {
    this.gasto.set(null); this.clearPhoto(); this.clearFile('solicitud_kepler'); this.sel = null; this.comentarios = '';
    this.clasificacion.set(null); this.clasificacionV = null; this.formError.set('');
    this.formaPago.set(null); this.formaPagoDetalleV = ''; this.sellos.set({});
    this.existing.set(null); this.checking.set(false);
  }

  onFile(ev: Event, role: string) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.handle(file, role);
  }
  over(e: DragEvent) { e.preventDefault(); e.stopPropagation(); if (!this.drag()) this.drag.set(true); }
  leave(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.drag.set(false); }
  drop(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.drag.set(false); const f = e.dataTransfer?.files?.[0]; if (f) this.handle(f, 'comprobante_1'); }
  overSol(e: DragEvent) { e.preventDefault(); e.stopPropagation(); if (!this.dragSol()) this.dragSol.set(true); }
  leaveSol(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.dragSol.set(false); }
  dropSol(e: DragEvent) { e.preventDefault(); e.stopPropagation(); this.dragSol.set(false); const f = e.dataTransfer?.files?.[0]; if (f) this.handle(f, 'solicitud_kepler'); }
  /** Quita un archivo elegido por rol. El comprobante además limpia su lectura de visión. */
  clearFile(role: string) {
    delete this.fileData[role]; delete this.uploaded[role];
    this.names.update((m) => { const n = { ...m }; delete n[role]; return n; });
    // [GX.14] El sello se va con el archivo. Si quedara, la compuerta creería que la
    // foto siguiente también se tomó en vivo aunque haya entrado por otro lado.
    this.sellos.update((m) => { const n = { ...m }; delete n[role]; return n; });
    if (role === 'comprobante_1') this.photoResult.set(null);
  }

  /** `[GX.14]` Guarda la foto recién tomada y dispara su lectura por visión. */
  private guardarCaptura(role: string, dataUri: string, capturedAt: string) {
    this.fileData[role] = dataUri;
    delete this.uploaded[role];
    // El nombre lo ponemos nosotros: no hay archivo de origen del cual tomarlo.
    const hora = new Date(capturedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    this.names.update((m) => ({ ...m, [role]: `Foto tomada ${hora}` }));
    this.sellos.update((m) => ({ ...m, [role]: { live: true, captured_at: capturedAt } }));
    if (role === 'comprobante_1') this.validate(dataUri);
    this.cdr.markForCheck();
  }
  clearPhoto() { this.clearFile('comprobante_1'); }

  private handle(file: File, role: string) {
    if (file.size > 10 * 1024 * 1024) { this.formError.set(`"${file.name}" supera 10 MB.`); return; }
    this.formError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri;
      delete this.uploaded[role];
      this.names.update((m) => ({ ...m, [role]: file.name }));
      if (role === 'comprobante_1') this.validate(dataUri);
      this.cdr.markForCheck();
    };
    reader.readAsDataURL(file);
  }

  private validate(dataUri: string) {
    this.photoLoading.set(true);
    this.photoResult.set(null);
    this.svc.validatePhoto(dataUri, Number(this.gasto()?.importe) || 0).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.photoLoading.set(false); this.photoResult.set(r); this.cdr.markForCheck(); },
      error: () => { this.photoLoading.set(false); },
    });
  }

  submit() {
    const g = this.gasto();
    if (!g) { this.formError.set('Elige el gasto.'); return; }
    if (this.modo() === 'evidencia') { this.submitEvidencia(g); return; }
    if (this.modo() !== 'capturar') return;
    // MOMENTO 1 — capturar la solicitud (firmada + clasificación). Sin evidencia.
    if (!this.clasificacion()) { this.formError.set('Elige el tipo de gasto.'); return; }
    if (!this.fileData['solicitud_kepler'] && !this.uploaded['solicitud_kepler']) { this.formError.set('Sube la solicitud firmada.'); return; }
    if (!this.llevaEvidencia() && !this.comentarios.trim()) { this.formError.set('Escribe por qué no se puede comprobar.'); return; }
    // [GX.14] Se frena ANTES de subir nada al bucket: mandar los bytes para que el 400
    // los rechace después deja archivos huérfanos pagados y a la persona esperando.
    const faltan = this.faltan();
    if (faltan.length) { this.formError.set(faltan.map((f) => f.motivo).join('. ')); return; }
    this.formError.set('');
    this.saving.set(true);
    this.uploadThen(['solicitud_kepler'], () => this.createSolicitud(g));
  }

  // MOMENTO 3 — el gasto ya está aprobado y comprobable: sube la evidencia.
  private submitEvidencia(g: SelSolicitud) {
    const id = this.existing()?.id;
    if (!id) { this.formError.set('No encuentro el expediente aprobado. Vuelve a elegir el folio.'); return; }
    if (!this.fileData['comprobante_1'] && !this.uploaded['comprobante_1']) { this.formError.set('Sube la evidencia.'); return; }
    if (this.photoLoading()) { this.formError.set('Espera a que termine de leerse la foto…'); return; }
    this.formError.set('');
    this.saving.set(true);
    this.uploadThen(['comprobante_1'], () => this.enviarEvidencia(id, g));
  }

  /** Sube al bucket los roles pendientes; si TODOS entran, sigue con `done`. */
  private uploadThen(roles: ProofFileRole[], done: () => void) {
    const toUpload = roles.filter((r) => this.fileData[r] && !this.uploaded[r]);
    if (!toUpload.length) { done(); return; }
    // [GX.14] El sello viaja con cada archivo. Sin él el backend lo trata como archivo
    // suelto y su propia compuerta lo rechaza — que es exactamente lo que queremos.
    const ups = toUpload.map((r) => this.svc.uploadFile(this.fileData[r], r, this.sellos()[r]).pipe(
      map((file) => ({ role: r, file: file as ProofFile | null })), catchError(() => of({ role: r, file: null as ProofFile | null })),
    ));
    forkJoin(ups).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((results) => {
      for (const res of results) { if (res.file) { this.uploaded[res.role] = res.file; delete this.fileData[res.role]; } }
      if (results.some((r) => !r.file)) { this.saving.set(false); this.formError.set('No se pudo subir el archivo. Reintenta.'); return; }
      done();
    });
  }

  private createSolicitud(g: SelSolicitud) {
    const lleva = this.llevaEvidencia();
    const files = [this.uploaded['solicitud_kepler']].filter(Boolean) as ProofFile[];
    this.svc.create({
      folio_solicitud: g.folio, sucursal: g.sucursal || undefined,
      solicitante: g.solicitante || undefined, proveedor: g.beneficiario || undefined,
      fecha_gasto: g.fecha ? String(g.fecha).slice(0, 10) : undefined, importe: g.importe || undefined,
      clasificacion: this.clasificacion()!,
      forma_pago: this.formaPago() ?? undefined,
      forma_pago_detalle: this.formaPagoDetalleV.trim() || undefined,
      // No comprobable: el motivo ES el comentario (obligatorio). Comprobable: nota opcional.
      comentarios: this.comentarios || (lleva ? g.concepto || undefined : undefined), files,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Enviada a aprobación', detail: `Solicitud ${g.folio}` }); this.uploaded = {}; this.reset(); this.loadMine(); },
      error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar.'); },
    });
  }

  private enviarEvidencia(id: string, g: SelSolicitud) {
    const pr = this.photoResult();
    const files = [this.uploaded['comprobante_1']].filter(Boolean) as ProofFile[];
    this.svc.addEvidence(id, {
      files, comentarios: this.comentarios || undefined,
      monto_ocr: pr?.monto_ocr ?? pr?.total ?? undefined, subtotal_ocr: pr?.subtotal ?? undefined,
      receipt_legible: pr ? pr.ocr_status === 'ok' : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Evidencia enviada', detail: `Solicitud ${g.folio} · ${r.status === 'validada' ? 'validada' : 'en revisión'}` }); this.uploaded = {}; this.reset(); this.loadMine(); },
      error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar la evidencia.'); },
    });
  }

  loadListas() {
    this.listasLoading.set(true);
    this.svc.listasParaComprobar().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.listas.set(r); this.listasLoading.set(false); this.cdr.markForCheck(); },
      // Un error NO se pinta como lista vacía: eso diría «no tenés nada», que es otra cosa.
      error: () => { this.listas.set({ medido: false, motivo: "no se pudo consultar; reintentá", ventana_dias: 0, rows: [] }); this.listasLoading.set(false); this.cdr.markForCheck(); },
    });
  }

  /**
   * `[GX.15]` Abre el expediente en PDF.
   *
   * Se baja como blob y se abre con una URL de objeto: la ruta exige el token, y un
   * `<a href>` directo lo manda sin cabecera de autorización — se vería como un PDF roto.
   */
  verExpediente(sucursal: string, folio: string) {
    if (this.pdfCargando()) return; // doble clic: armar el PDF tarda, no se encolan dos
    this.pdfCargando.set(folio);
    this.svc.expedientePdf(sucursal, folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        // Se revoca después: revocarla de inmediato deja la pestaña sin nada que mostrar.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.pdfCargando.set(null);
        this.cdr.markForCheck();
      },
      error: () => {
        this.pdfCargando.set(null);
        this.toast.add({ severity: "error", summary: "No se pudo armar el expediente", detail: `Solicitud ${folio}` });
        this.cdr.markForCheck();
      },
    });
  }

  loadMine() {
    this.mineLoading.set(true);
    this.svc.mine(50).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.mine.set(r.rows || []); this.mineLoading.set(false); },
      error: () => { this.mineLoading.set(false); },
    });
  }

  statusLabel(s: string): string { return ({ recibida: 'Recibida', validada: 'Validada', rechazada: 'Rechazada', revision: 'En revisión' } as Record<string, string>)[s] || s; }
  statusSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibida: 'secondary', validada: 'success', rechazada: 'danger', revision: 'warn' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[s] || 'secondary'; }
  moneyFull(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
}
