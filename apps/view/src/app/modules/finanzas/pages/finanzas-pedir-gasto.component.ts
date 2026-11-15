import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, distinctUntilChanged, map, of, switchMap } from 'rxjs';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  FORMAS_PAGO, MAX_ARCHIVO_GASTO_BYTES, MAX_ARCHIVO_GASTO_MB, MAX_RENGLONES, avisoDeFechas, cfdiCuadra, detallePagoOpcional, exigeDetalle, faltaParaPedir,
  totalesDeLaSolicitud, type AcreedorDeGasto, type CatalogoDeLaSolicitud, type DuplicadoProbable, type FuenteDelDato,
  type LecturaDelComprobante, type SolicitudGastoCreada, type TipoComprobante,
} from '@megadulces/contracts';

import { AuthService } from '../../../core/services/auth.service';
import { STORE_BRANCHES, branchLabel } from '../../../core/constants/store-branches';
import { ComprobacionesService, type ProofFile, type ProofFileRole } from '../comprobaciones.service';
import { SolicitudGastoService } from '../solicitud-gasto.service';
import { CapturaEnVivoComponent } from '../components/captura-en-vivo.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

/** Un renglón en captura (lo que va a kdm6), con de dónde salió cada valor. */
interface RenglonEnCaptura { concepto: string | null; proyecto: string | null; departamento: string | null; importe: number | null }

const FUENTE_TEXTO: Record<FuenteDelDato, string> = {
  cfdi: 'de la factura del SAT', ticket: 'leído del comprobante', habito: 'como la última vez', sesion: 'de tu sesión', persona: 'lo escribiste tú',
};

/** `YYYY-MM-DD` de un Date en la hora local (la del navegador, que en la flota es la de México). */
const iso = (d: Date | null | undefined): string | null =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
const deIso = (s: string | null | undefined): Date | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : null);

/** UUID v4 para la solicitud (idempotencia del envío): `crypto.randomUUID` donde exista. */
function nuevoId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c?.getRandomValues?.(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type FacturaDelSat = NonNullable<LecturaDelComprobante['cfdi']>;

/**
 * `[PGP.122]` S.9 — **Registrar o pedir un gasto: la Suite llena, la persona valida.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md` §7 (las cinco preguntas, por escrito).
 * El propósito en una frase: «dar de alta UN gasto, ya lleno, para que lo firmen». Al firmarse, la Suite lo
 * escribe en Kepler ya autorizado: nadie lo vuelve a teclear (hoy se teclea dos veces en el 94.4 %).
 *
 * Qué ve y en qué orden: (1) el documento que ampara el gasto —la foto se LEE sola y, si es factura, se busca
 * en el SAT—, (2) a quién se le paga —por RFC, o sus frecuentes—, (3) qué y cuánto —«como la última vez»—,
 * (4) cómo se pagó; y en la barra de abajo, el total, lo que falta y UN botón. Cada dato dice de dónde salió;
 * lo que ninguna fuente contestó es lo único que se pregunta. La lectura propone y nunca decide (GX.32/33).
 *
 * Qué no ve: cuenta contable, RFC, moneda, paridad, «autoriza»: los pone el catálogo del servidor.
 * Celular: 103 persona-días en 30 días (14 personas, cajeros, encargados, ruta): barra con la acción
 * principal pegada abajo y sobre el indicador del iPhone; importes con teclado decimal.
 *
 * La puerta sólo se abre donde la escritura en Kepler está encendida de punta a punta (`disponibilidad`): lo
 * pedido aquí que no llegara a Kepler dejaría a Finanzas sin solicitud donde aplicar el gasto.
 */
@Component({
  selector: 'app-finanzas-pedir-gasto',
  standalone: true,
  imports: [
    FormsModule, RouterLink, AutoCompleteModule, ButtonModule, DatePickerModule, InputNumberModule, InputTextModule, SelectModule,
    SelectButtonModule, TagModule, TextareaModule, ToastModule, CapturaEnVivoComponent, LoadStateComponent, SegmentedComponent,
    MetricStripComponent, FreshnessPillComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast />
    <section class="pg" aria-labelledby="pg-titulo">
      <header class="pg-head">
        <h2 id="pg-titulo" class="pg-titulo">Registrar o pedir un gasto</h2>
        <p class="pg-sub">La Suite llena lo que ya sabe; tú revisas y lo mandas a firma. Al firmarse se escribe en Kepler: no se vuelve a teclear.</p>
      </header>

      @if (sucursales().length > 1) {
        <div class="pg-campo pg-suc">
          <label for="pg-sucursal">Sucursal</label>
          <p-select inputId="pg-sucursal" appendTo="body" [options]="sucursales()" optionLabel="name" optionValue="code"
            [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)" [fluid]="true" placeholder="Elige la sucursal" />
        </div>
      } @else if (sucursal()) {
        <p class="pg-suc-fija"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ nombreSucursal() }}</p>
      }
      @if (disponible()) {
        <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Cómo va la solicitud" />
        <p class="pg-catalogo">Catálogo de Kepler de esta sucursal <app-freshness-pill measures="fetch" [since]="catalogoLeidoEn()" label="leído" /></p>
      }

      <app-load-state [loading]="cargando()" [error]="errorCarga()" (retry)="reintentarCarga()" [skeletonRows]="5"
        errorTitle="No se pudo abrir la solicitud">
        @if (!sucursal()) {
          <p class="pg-elige" role="status"><i class="pi pi-map-marker" aria-hidden="true"></i>
            {{ sucursales().length ? 'Elige la sucursal para empezar.' : 'La solicitud en la Suite todavía no está abierta en ninguna de tus sucursales.' }}</p>
        } @else if (consultada() && !disponible()) {
          <div class="pg-cerrado" role="status">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <div>
              <p class="pg-cerrado-t">La solicitud en la Suite todavía no está abierta en {{ nombreSucursal() }}.</p>
              <p class="pg-cerrado-d">Mientras tanto, captura en Kepler y usa «Tengo un folio de Kepler». Se abre cuando Sistemas enciende la escritura en este servidor.</p>
              @if (motivos().length) {
                <details class="pg-motivos"><summary>Detalle para Sistemas</summary>
                  <ul>@for (m of motivos(); track m) { <li>{{ m }}</li> }</ul>
                </details>
              }
            </div>
          </div>
        } @else if (disponible()) {
          <!-- 1 · El documento -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend"><span class="pg-num">1</span> El documento que ampara el gasto</legend>
            <app-segmented [options]="tiposDoc" [value]="tipo()" (valueChange)="setTipo($event)" ariaLabel="Qué documento ampara el gasto" />
            <div class="pg-arch">
              @if (tipo() !== 'cotizacion') {
                <md-captura-en-vivo etiqueta="Tomar foto" (capturada)="alCapturar($event)" />
              }
              <label class="pg-subir">
                <i class="pi pi-upload" aria-hidden="true"></i>
                <span>{{ tipo() === 'cotizacion' ? 'Subir la cotización' : 'Subir archivo' }}</span>
                <input type="file" accept="image/*,application/pdf" (change)="alElegirArchivo($event)" />
              </label>
            </div>
            @if (archivo(); as a) {
              <p class="pg-leido" aria-live="polite">
                <a [href]="a.url" target="_blank" rel="noopener"><i class="pi pi-file" aria-hidden="true"></i> Ver el archivo</a>
                <span class="pg-leido-t">{{ estadoLectura() }}</span>
              </p>
            }
            <div class="pg-grid">
              <div class="pg-campo">
                <label for="pg-folio">Folio del {{ tipo() === 'cfdi' ? 'CFDI' : tipo() === 'cotizacion' ? 'documento' : 'ticket' }}</label>
                <input pInputText id="pg-folio" [ngModel]="folioDoc()" (ngModelChange)="folioDoc.set($event); marcar('folio')" maxlength="40" autocomplete="off" inputmode="text" />
                @if (fuente('folio'); as f) { <small class="pg-fuente">{{ f }}</small> }
              </div>
              <div class="pg-campo">
                <label for="pg-fecha">Fecha del documento</label>
                <p-datepicker inputId="pg-fecha" [ngModel]="fechaDoc()" (ngModelChange)="fechaDoc.set($event); marcar('fecha')" dateFormat="dd/mm/yy"
                  [showIcon]="true" appendTo="body" [maxDate]="hoyDate()" [fluid]="true" />
                @if (fuente('fecha'); as f) { <small class="pg-fuente">{{ f }}</small> }
              </div>
            </div>
            @if (cfdiUuid()) {
              <p class="pg-sat"><i class="pi pi-verified" aria-hidden="true"></i> Factura encontrada en el SAT: no hace falta foto. UUID {{ cfdiUuid() }}</p>
            } @else if (cfdiPropuesto(); as cp) {
              <div class="pg-aviso" role="status">
                <i class="pi pi-verified" aria-hidden="true"></i>
                <div>
                  <p>Encontramos esta factura en el SAT: {{ cp.folio || 'sin folio' }} del {{ cp.fecha }}, por {{ dinero(cp.total) }}.</p>
                  <p-button type="button" label="Usar la factura del SAT" size="small" [outlined]="true" (onClick)="usarCfdiPropuesto()" />
                </div>
              </div>
            }
            @if (avisoCfdi(); as ac) { <p class="pg-nota-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ ac }}</p> }
            @if (avisoFecha(); as af) {
              <div class="pg-campo">
                <label for="pg-motivo-fecha">{{ af }}</label>
                <textarea pTextarea id="pg-motivo-fecha" rows="2" [ngModel]="motivoFecha()" (ngModelChange)="motivoFecha.set($event)" maxlength="200"></textarea>
              </div>
            }
          </fieldset>

          <!-- 2 · A quién -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend"><span class="pg-num">2</span> A quién se le paga</legend>
            <div class="pg-campo">
              <label for="pg-acreedor">Acreedor</label>
              <p-autocomplete inputId="pg-acreedor" [ngModel]="acreedorSel()" (ngModelChange)="acreedorTecleado($event)" [suggestions]="acreedoresSug()"
                (completeMethod)="buscarAcreedor($event.query)" (onSelect)="elegirAcreedor($event.value)" optionLabel="nombre"
                [forceSelection]="true" [dropdown]="true" [showClear]="true" appendTo="body" [fluid]="true"
                placeholder="Nombre, clave o RFC" [emptyMessage]="buscarFallo() ? 'No se pudo buscar: intenta otra vez' : 'Sin acreedores de gasto con eso en esta sucursal'">
                <ng-template let-a #item>
                  <div class="pg-ac-op"><span class="pg-ac-n">{{ a.nombre }}</span><span class="pg-ac-c">{{ a.clave }}@if (a.usos) { · {{ a.usos }} en 6 meses }</span></div>
                </ng-template>
              </p-autocomplete>
              @if (fuente('acreedor'); as f) { <small class="pg-fuente">{{ f }}</small> }
              @if (buscarFallo()) { <small class="pg-nota-aviso" role="status">No se pudo buscar acreedores: revisa tu conexión e intenta otra vez.</small> }
              @if (avisoAcreedor(); as aa) { <small class="pg-nota-aviso" role="status">{{ aa }}</small> }
            </div>
            @if (!acreedorSel() && frecuentes().length) {
              <div class="pg-chips" role="group" aria-label="Acreedores frecuentes">
                @for (a of frecuentes(); track a.clave) {
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="elegirAcreedor(a)">{{ a.nombre }}</button>
                }
              </div>
            }
          </fieldset>

          <!-- 3 · Qué y cuánto -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend"><span class="pg-num">3</span> Qué es y cuánto</legend>
            @for (r of renglones(); track $index; let i = $index) {
              <div class="pg-renglon" role="group" [attr.aria-label]="'Renglón ' + (i + 1)">
                <div class="pg-campo pg-ren-concepto">
                  <label [for]="'pg-con-' + i">Concepto</label>
                  <p-select [inputId]="'pg-con-' + i" appendTo="body" [options]="conceptos()" optionLabel="etiqueta" optionValue="codigo" [filter]="true"
                    filterBy="etiqueta" [ngModel]="r.concepto" (ngModelChange)="cambiarRenglon(i, 'concepto', $event)" [fluid]="true" placeholder="Elige el concepto" />
                </div>
                <div class="pg-campo">
                  <label [for]="'pg-pro-' + i">Proyecto</label>
                  <p-select [inputId]="'pg-pro-' + i" appendTo="body" [options]="proyectos()" optionLabel="etiqueta" optionValue="codigo" [filter]="true"
                    filterBy="etiqueta" [ngModel]="r.proyecto" (ngModelChange)="cambiarRenglon(i, 'proyecto', $event)" [fluid]="true" placeholder="Proyecto" />
                </div>
                <div class="pg-campo">
                  <label [for]="'pg-dep-' + i">Departamento</label>
                  <p-select [inputId]="'pg-dep-' + i" appendTo="body" [options]="departamentos()" optionLabel="etiqueta" optionValue="codigo" [filter]="true"
                    filterBy="etiqueta" [ngModel]="r.departamento" (ngModelChange)="cambiarRenglon(i, 'departamento', $event)" [fluid]="true" placeholder="Departamento" />
                </div>
                <div class="pg-campo pg-ren-importe">
                  <label [for]="'pg-imp-' + i">Importe sin IVA</label>
                  <p-inputnumber [inputId]="'pg-imp-' + i" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2" [maxFractionDigits]="2" [min]="0"
                    [ngModel]="r.importe" (ngModelChange)="cambiarRenglon(i, 'importe', $event)" [fluid]="true" />
                </div>
                @if (renglones().length > 1) {
                  <p-button type="button" styleClass="pg-quitar" icon="pi pi-times" [text]="true" size="small" [ariaLabel]="'Quitar el renglón ' + (i + 1)" (onClick)="quitarRenglon(i)" />
                }
              </div>
              @if (fuente('renglon_' + (i + 1)); as f) { <small class="pg-fuente">{{ f }}</small> }
            }
            @if (renglones().length < maxRenglones) {
              <p-button type="button" icon="pi pi-plus" label="Agregar renglón" [text]="true" size="small" (onClick)="agregarRenglon()" />
            }
            <div class="pg-grid">
              <div class="pg-campo">
                <label for="pg-iva">IVA</label>
                <p-inputnumber inputId="pg-iva" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2" [maxFractionDigits]="2" [min]="0"
                  [ngModel]="iva()" (ngModelChange)="iva.set($event ?? 0); marcar('iva')" [fluid]="true" />
                @if (fuente('iva'); as f) { <small class="pg-fuente">{{ f }}</small> }
              </div>
              <div class="pg-campo">
                <span class="pg-label">Total</span>
                <strong class="pg-total comm-num">{{ dinero(totales().total) }}</strong>
              </div>
            </div>
          </fieldset>

          <!-- 4 · Cómo se pagó -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend"><span class="pg-num">4</span> {{ tipo() === 'cotizacion' ? 'Cómo se va a pagar' : 'Cómo se pagó' }}</legend>
            <p-selectbutton [options]="formasPago" optionLabel="label" optionValue="id" [ngModel]="formaPago()" (ngModelChange)="formaPago.set($event); marcar('forma_pago')"
              [allowEmpty]="false" />
            @if (fuente('forma_pago'); as f) { <small class="pg-fuente">{{ f }}</small> }
            @if (detalleLabel(); as dl) {
              <div class="pg-campo">
                <label for="pg-detalle">{{ dl }}{{ detalleOpcional() ? ' (opcional)' : '' }}</label>
                <input pInputText id="pg-detalle" [ngModel]="detalle()" (ngModelChange)="detalle.set($event)" autocomplete="off"
                  [attr.inputmode]="formaPago() === 'tarjeta' || formaPago() === 'cheque' ? 'numeric' : 'text'" maxlength="60"
                  [attr.aria-describedby]="detalleOpcional() ? 'pg-detalle-ayuda' : null" />
                @if (detalleOpcional()) {
                  <small id="pg-detalle-ayuda" class="pg-fuente">Si ya se pagó, escríbela; si no, la pone Tesorería al pagar.</small>
                }
              </div>
            }
          </fieldset>

          <details class="pg-mas">
            <summary>Más datos (opcional): periodo, unidad, nota, para cuándo</summary>
            <div class="pg-grid">
              <div class="pg-campo"><label for="pg-del">Periodo del</label>
                <p-datepicker inputId="pg-del" [ngModel]="periodoDel()" (ngModelChange)="periodoDel.set($event)" dateFormat="dd/mm/yy" appendTo="body" [fluid]="true" /></div>
              <div class="pg-campo"><label for="pg-al">al</label>
                <p-datepicker inputId="pg-al" [ngModel]="periodoAl()" (ngModelChange)="periodoAl.set($event)" dateFormat="dd/mm/yy" appendTo="body" [fluid]="true" /></div>
              <div class="pg-campo"><label for="pg-unidad">Unidad o placa</label>
                <input pInputText id="pg-unidad" [ngModel]="unidad()" (ngModelChange)="unidad.set($event)" maxlength="20" autocomplete="off" /></div>
              <div class="pg-campo"><label for="pg-necesita">Se necesita pagar el</label>
                <p-datepicker inputId="pg-necesita" [ngModel]="necesitaPara()" (ngModelChange)="necesitaPara.set($event)" dateFormat="dd/mm/yy" appendTo="body" [minDate]="hoyDate()" [fluid]="true" /></div>
            </div>
            <div class="pg-campo"><label for="pg-nota">Nota para Kepler (si no, se arma del concepto, el periodo y la unidad)</label>
              <input pInputText id="pg-nota" [ngModel]="nota()" (ngModelChange)="nota.set($event)" maxlength="60" autocomplete="off" /></div>
          </details>

          @if (duplicados().length) {
            <div class="pg-aviso" role="status">
              <i class="pi pi-copy" aria-hidden="true"></i>
              <div>
                <p><strong>Ya hay {{ duplicados().length === 1 ? 'otro gasto' : duplicados().length + ' gastos' }} al mismo acreedor por el mismo total hoy.</strong> Revisa que no sea el mismo.</p>
                <ul>@for (d of duplicados(); track $index) {
                  <li>{{ d.donde === 'kepler' ? 'En Kepler' : 'En la Suite' }}@if (d.folio) { · folio {{ d.folio }} } · {{ dinero(d.total) }}</li>
                }</ul>
              </div>
            </div>
          } @else if (duplicadosFallo()) {
            <p class="pg-nota-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo revisar si ya hay un gasto igual hoy.</p>
          }

          @if (faltan().length) {
            <div class="pg-faltan">
              <p class="pg-faltan-t">Falta para mandarlo a firma:</p>
              <ul>@for (f of faltan(); track f.motivo) { <li>{{ f.motivo }}</li> }</ul>
            </div>
          }
        }
      </app-load-state>

      @if (creada(); as c) {
        <div class="pg-hecho" role="status">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <div>
            <p><strong>Listo: {{ dinero(c.total) }} espera firma.</strong> Al firmarse se escribe en Kepler; su folio aparece en Mis gastos.</p>
            @if (c.duplicados.length) {
              <p class="pg-nota-aviso">Ojo: hoy ya había {{ c.duplicados.length === 1 ? 'otro gasto' : c.duplicados.length + ' gastos' }} al mismo acreedor por el mismo total@for (d of c.duplicados; track $index) { · {{ d.donde === 'kepler' ? 'Kepler' : 'Suite' }}@if (d.folio) { {{ d.folio }} } }. Si es el mismo, avisa a quien firma.</p>
            }
            <a routerLink="/finanzas/mis-gastos">Ver en Mis gastos</a>
          </div>
        </div>
      }

      @if (disponible()) {
        <div class="pg-barra">
          <div class="pg-barra-t">
            <span class="pg-barra-total comm-num">{{ dinero(totales().total) }}</span>
            <span class="pg-barra-falta">{{ faltan().length ? 'Faltan ' + faltan().length : 'Listo para firma' }}</span>
          </div>
          <p-button type="button" styleClass="pg-enviar" icon="pi pi-send" [label]="tipo() === 'cotizacion' ? 'Pedir firma' : 'Mandar a firma'"
            [disabled]="enviando() || faltan().length > 0" [loading]="enviando()" (onClick)="enviar()" />
        </div>
      }
    </section>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .pg { display: flex; flex-direction: column; gap: var(--sp-4); padding-bottom: calc(var(--sp-12) + env(safe-area-inset-bottom)); }
    .pg-titulo { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .pg-sub { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .pg-catalogo { margin: 0; display: flex; gap: var(--sp-2); align-items: center; color: var(--text-faint); font-size: var(--fs-xs); }
    .pg-suc-fija { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); display: flex; gap: var(--sp-2); align-items: center; }
    .pg-bloque { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); margin: 0; display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
    .pg-legend { font-weight: 700; color: var(--text-main); padding: 0 var(--sp-2); display: flex; align-items: center; gap: var(--sp-2); }
    .pg-num { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border-radius: var(--r-pill); border: 1px solid var(--border-color); font-size: var(--fs-xs); }
    .pg-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
    .pg-campo { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .pg-campo label, .pg-label { font-size: var(--fs-sm); color: var(--text-muted); }
    .pg-fuente { color: var(--text-faint); font-size: var(--fs-xs); }
    .pg-arch { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
    .pg-subir { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 2.75rem; padding: 0 var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-md); cursor: pointer; color: var(--text-main); }
    .pg-subir input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .pg-subir:focus-within { outline: 2px solid var(--action); outline-offset: 2px; }
    .pg-leido { margin: 0; display: flex; flex-wrap: wrap; gap: var(--sp-3); font-size: var(--fs-sm); }
    .pg-leido-t { color: var(--text-muted); }
    .pg-sat { margin: 0; font-size: var(--fs-sm); color: var(--text-main); display: flex; gap: var(--sp-2); align-items: center; overflow-wrap: anywhere; }
    .pg-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .pg-ac-op { display: flex; flex-direction: column; }
    .pg-ac-n { color: var(--text-main); }
    .pg-ac-c { color: var(--text-faint); font-size: var(--fs-xs); }
    .pg-renglon { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.2fr) auto; gap: var(--sp-3); align-items: end; }
    .pg-quitar { align-self: end; }
    .pg-total { font-size: var(--fs-lg); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pg-mas summary { cursor: pointer; color: var(--text-muted); font-size: var(--fs-sm); min-height: 2.75rem; display: flex; align-items: center; }
    .pg-mas[open] { display: flex; flex-direction: column; gap: var(--sp-3); }
    .pg-cerrado, .pg-aviso, .pg-hecho, .pg-faltan { display: flex; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .pg-cerrado p, .pg-aviso p, .pg-hecho p { margin: 0; }
    .pg-cerrado-t { font-weight: 600; color: var(--text-main); }
    .pg-cerrado-d, .pg-motivos { color: var(--text-muted); font-size: var(--fs-sm); }
    .pg-faltan { flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .pg-faltan-t { margin: 0; font-weight: 600; color: var(--text-main); }
    .pg-faltan ul, .pg-aviso ul, .pg-motivos ul { margin: 0; padding-left: var(--sp-5); }
    .pg-motivos summary { cursor: pointer; }
    .pg-elige { margin: 0; color: var(--text-muted); display: flex; gap: var(--sp-2); align-items: center; }
    .pg-nota-aviso { margin: 0; color: var(--text-main); font-size: var(--fs-sm); display: flex; gap: var(--sp-2); align-items: flex-start; }
    .pg-barra { position: sticky; bottom: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3);
      padding: var(--sp-3) var(--sp-4) calc(var(--sp-3) + env(safe-area-inset-bottom)); background: var(--card-bg); border-top: 1px solid var(--border-color); }
    .pg-barra-t { display: flex; flex-direction: column; }
    .pg-barra-total { font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pg-barra-falta { font-size: var(--fs-xs); color: var(--text-muted); }
    .pg-enviar { min-height: 2.75rem; }
    @container (max-width: 40rem) {
      .pg-grid { grid-template-columns: minmax(0, 1fr); }
      .pg-renglon { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
      .pg-quitar { justify-self: end; }
    }
  `],
})
export class FinanzasPedirGastoComponent {
  private readonly api = inject(SolicitudGastoService);
  private readonly archivos = inject(ComprobacionesService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly maxRenglones = MAX_RENGLONES;
  /** «Hoy» se refresca: la pantalla puede quedarse abierta de un día para otro (al volver a la pestaña y cada 5 min). */
  readonly hoyIso = signal(iso(new Date()) ?? '');
  readonly hoyDate = computed(() => deIso(this.hoyIso()) ?? new Date());
  readonly hoy = computed(() => this.hoyIso());
  /** Copia mutable: `p-selectbutton` pide un arreglo y el catálogo del contrato es `readonly` (TS4104). */
  readonly formasPago = [...FORMAS_PAGO];
  readonly tiposDoc: SegOption[] = [
    { label: 'Ticket o nota', value: 'ticket' },
    { label: 'Factura', value: 'cfdi' },
    { label: 'Cotización (antes de gastar)', value: 'cotizacion' },
  ];

  /** Las sucursales donde hoy se puede pedir (`null` = todavía no contesta). */
  readonly abiertas = signal<string[] | null>(null);
  /** La sucursal de la sesión; sin ella (oficinas, plataforma) se elige entre las nueve, por nombre. Sólo las ABIERTAS. */
  private readonly sucursalDeSesion = computed(() => String(this.auth.user()?.warehouse_code ?? '').trim());
  readonly sucursales = computed(() => {
    const abiertas = this.abiertas() ?? [];
    const s = this.sucursalDeSesion();
    const base = s ? STORE_BRANCHES.filter((b) => b.code === s) : STORE_BRANCHES.filter((b) => /^\d{2}$/.test(b.code) && Number(b.code) <= 8);
    return base.filter((b) => abiertas.includes(b.code));
  });
  readonly sucursal = signal<string>('');
  readonly nombreSucursal = computed(() => branchLabel(this.sucursal()) || 'esta sucursal');

  readonly cargando = signal(false);
  readonly errorCarga = signal<string | null>(null);
  /** Ya contestó `disponibilidad` para la sucursal elegida: sin esto, «no está abierta» se decía antes de preguntar. */
  readonly consultada = signal(false);
  readonly disponible = signal(false);
  readonly motivos = signal<string[]>([]);
  readonly catalogo = signal<CatalogoDeLaSolicitud | null>(null);
  /** Cuándo se leyó el catálogo (del ODS, casi en vivo): el escritor vuelve a validar contra el Kepler vivo. */
  readonly catalogoLeidoEn = signal<Date | null>(null);
  readonly frecuentes = signal<AcreedorDeGasto[]>([]);

  readonly conceptos = computed(() => (this.catalogo()?.conceptos ?? []).filter((c) => !c.fuera_de_alcance).map((c) => ({ ...c, etiqueta: `${c.nombre} · ${c.codigo}` })));
  readonly proyectos = computed(() => (this.catalogo()?.proyectos ?? []).map((p) => ({ ...p, etiqueta: `${p.nombre || p.codigo} · ${p.codigo}` })));
  readonly departamentos = computed(() => (this.catalogo()?.departamentos ?? []).map((d) => ({ ...d, etiqueta: `${d.nombre || d.codigo} · ${d.codigo}` })));

  // ── Lo capturado ─────────────────────────────────────────────────────────────────────────────
  readonly tipo = signal<TipoComprobante>('ticket');
  readonly archivo = signal<ProofFile | null>(null);
  readonly leyendo = signal(false);
  readonly lectura = signal<LecturaDelComprobante | null>(null);
  readonly folioDoc = signal('');
  readonly fechaDoc = signal<Date | null>(null);
  readonly cfdiUuid = signal<string | null>(null);
  /** La factura del SAT encontrada cuando la persona ya había elegido otro tipo: se PROPONE, no se impone. */
  readonly cfdiPropuesto = signal<FacturaDelSat | null>(null);
  /** La factura del SAT que no se puede usar tal cual (retenciones, impuestos locales): se dice por qué. */
  readonly avisoCfdi = signal<string | null>(null);
  readonly motivoFecha = signal('');
  readonly acreedorSel = signal<AcreedorDeGasto | null>(null);
  readonly acreedoresSug = signal<AcreedorDeGasto[]>([]);
  /** La búsqueda de acreedores FALLÓ (no es lo mismo que «no hay»). */
  readonly buscarFallo = signal(false);
  readonly renglones = signal<RenglonEnCaptura[]>([{ concepto: null, proyecto: null, departamento: null, importe: null }]);
  readonly iva = signal<number>(0);
  readonly formaPago = signal<string>('');
  readonly detalle = signal('');
  readonly periodoDel = signal<Date | null>(null);
  readonly periodoAl = signal<Date | null>(null);
  readonly unidad = signal('');
  readonly nota = signal('');
  readonly necesitaPara = signal<Date | null>(null);
  readonly duplicados = signal<DuplicadoProbable[]>([]);
  readonly duplicadosFallo = signal(false);
  readonly enviando = signal(false);
  readonly creada = signal<SolicitudGastoCreada | null>(null);
  /**
   * De dónde salió cada dato (campo → fuente). Lo que la persona cambia pasa a «persona». Los del renglón van por
   * número (`concepto_1`, `importe_2`…) y `renglon_N` es lo que se guarda como origen del renglón.
   */
  private readonly fuentes = signal<Record<string, FuenteDelDato>>({});
  /** Una vez por solicitud: si el envío se repite (la respuesta se perdió), el servidor devuelve la misma. */
  private idCliente = nuevoId();

  readonly totales = computed(() => totalesDeLaSolicitud(this.renglones().map((r) => ({ importe: Number(r.importe ?? 0) })), this.iva()));
  readonly detalleLabel = computed(() => (exigeDetalle(this.formaPago()) ? FORMAS_PAGO.find((f) => f.id === this.formaPago())?.detalle_label ?? null : null));
  /** DS17: al pedir, la referencia o el cheque llegan al pagar (la misma regla que lee `faltaParaPedir`). */
  readonly detalleOpcional = computed(() => detallePagoOpcional({ forma_pago: this.formaPago(), se_paga_despues: true }));
  /** El archivo viaja con el rol del TIPO de documento elegido al mandar, no con el del momento de subirlo. */
  private readonly rolDelArchivo = computed((): ProofFileRole => (this.tipo() === 'cotizacion' ? 'cotizacion' : 'comprobante_1'));
  readonly avisoFecha = computed(() => {
    const d = iso(this.fechaDoc());
    if (!d) return null;
    const a = avisoDeFechas(d, this.hoy());
    return !a.ok && !a.bloquea ? a.motivo : null;
  });
  readonly estadoLectura = computed(() => {
    if (this.leyendo()) return 'Leyendo el comprobante…';
    const l = this.lectura();
    if (!l) return '';
    if (!l.legible) return l.motivo ?? 'No se pudo leer: captúralo a mano';
    if (l.cfdi) return 'Leído y encontrado en el SAT';
    return 'Leído: revisa lo que llenó';
  });
  /** El acreedor de la factura (por su RFC) no es el elegido: se dice, no se cambia solo. */
  readonly avisoAcreedor = computed(() => {
    const l = this.lectura();
    const sel = this.acreedorSel();
    return l?.acreedor && sel && l.acreedor.clave !== sel.clave
      ? `El comprobante es de ${l.acreedor.nombre} (${l.acreedor.clave}) y elegiste a ${sel.nombre}: revisa que sea el acreedor correcto.`
      : null;
  });

  /** La MISMA compuerta que el 400 del servidor (`faltaParaPedir`, del contrato). */
  readonly faltan = computed(() => faltaParaPedir({
    sucursal: this.sucursal(), acreedor: this.acreedorSel()?.clave ?? '',
    renglones: this.renglones().map((r) => ({ concepto: r.concepto ?? '', proyecto: r.proyecto ?? '', departamento: r.departamento ?? '', importe: Number(r.importe ?? 0),
      cuenta: this.catalogo()?.conceptos.find((c) => c.codigo === r.concepto)?.cuenta ?? null })),
    iva: this.iva(), fecha_solicitud: this.hoy(),
    comprobante: { tipo: this.tipo(), folio: this.folioDoc() || null, fecha: iso(this.fechaDoc()), uuid: this.cfdiUuid() },
    forma_pago: this.formaPago(), forma_pago_detalle: this.detalle(),
    archivos: this.archivo() ? [{ role: this.rolDelArchivo(), live: this.archivo()!.live ?? null }] : [],
    motivo_fecha: this.motivoFecha(),
  }));

  /** Los datos que cuentan para «la Suite llena» (la métrica de automatización del anexo). */
  private readonly camposClave = ['folio', 'fecha', 'acreedor', 'renglon_1', 'iva', 'forma_pago'] as const;
  /** Answer-first (Q.1): el total, cuánto llenó la Suite sola y qué falta, antes que el formulario. */
  readonly resumen = computed((): MetricStripItem[] => {
    const fu = this.fuentes();
    const llenos = this.camposClave.filter((c) => fu[c] && fu[c] !== 'persona').length;
    const faltan = this.faltan().length;
    return [
      { label: 'Total', value: this.totales().total, format: 'currency2' },
      { label: 'Llenó la Suite', value: llenos + ' de ' + this.camposClave.length, format: 'text', tone: llenos ? 'ok' : 'muted' },
      { label: 'Falta', value: faltan, format: 'number', tone: faltan ? 'warn' : 'ok' },
    ];
  });

  /** La llave de la revisión de duplicados: el acreedor, el TOTAL (con IVA) y el día. */
  private readonly claveDuplicados = computed(() => {
    const a = this.acreedorSel();
    const t = this.totales().total;
    const s = this.sucursal();
    return a && s && t > 0 ? `${s}|${a.clave}|${t.toFixed(2)}|${this.hoy()}` : '';
  });

  constructor() {
    const refrescar = (): void => this.hoyIso.set(iso(new Date()) ?? '');
    const intervalo = setInterval(refrescar, 5 * 60_000);
    document.addEventListener('visibilitychange', refrescar);
    this.destroyRef.onDestroy(() => { clearInterval(intervalo); document.removeEventListener('visibilitychange', refrescar); });

    // Duplicados: se revisan solos cuando cambian el acreedor o el total, con un respiro; si falla, se dice.
    toObservable(this.claveDuplicados).pipe(
      debounceTime(400),
      distinctUntilChanged(),
      switchMap((k) => {
        if (!k) return of({ ok: true, d: [] as DuplicadoProbable[] });
        const [s, a, t, h] = k.split('|');
        return this.api.duplicados(s, a, Number(t), h).pipe(
          map((d) => ({ ok: true, d })),
          catchError(() => of({ ok: false, d: [] as DuplicadoProbable[] })),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => { this.duplicados.set(r.d); this.duplicadosFallo.set(!r.ok); });

    this.cargarAbiertas();
  }

  /** Primero, dónde se puede pedir; si hay UNA sucursal posible, se abre sola. */
  private cargarAbiertas(): void {
    this.cargando.set(true);
    this.errorCarga.set(null);
    this.api.abiertas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.abiertas.set(r.sucursales ?? []);
        this.cargando.set(false);
        const s = this.sucursales();
        if (s.length === 1) { this.sucursal.set(s[0].code); this.cargar(); }
      },
      error: (e) => { this.errorCarga.set(e?.error?.message || 'No se pudo saber en qué sucursales está abierta la solicitud'); this.cargando.set(false); },
    });
  }

  /** «Reintentar» del estado de error: lo que falló (saber dónde está abierta, o abrir la sucursal elegida). */
  reintentarCarga(): void {
    if (this.abiertas() === null) this.cargarAbiertas();
    else this.cargar();
  }

  fuente(campo: string): string | null {
    const f = this.fuentes()[campo];
    return f && f !== 'persona' ? FUENTE_TEXTO[f] : null;
  }

  marcar(campo: string): void {
    this.fuentes.update((m) => ({ ...m, [campo]: 'persona' }));
  }

  private poner(campo: string, f: FuenteDelDato): void {
    this.fuentes.update((m) => ({ ...m, [campo]: f }));
  }

  dinero(n: number | null | undefined): string {
    return Number(n ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  cambiarSucursal(s: string): void {
    this.sucursal.set(s);
    this.reiniciar();
    this.cargar();
  }

  cargar(): void {
    const s = this.sucursal();
    if (!s) return;
    // Lo de la sucursal anterior se limpia ANTES de preguntar, y cada respuesta revisa que siga siendo la elegida.
    this.cargando.set(true);
    this.errorCarga.set(null);
    this.consultada.set(false);
    this.disponible.set(false);
    this.motivos.set([]);
    this.catalogo.set(null);
    this.catalogoLeidoEn.set(null);
    this.frecuentes.set([]);
    const vigente = (): boolean => this.sucursal() === s;
    this.api.disponibilidad(s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        if (!vigente()) return;
        this.motivos.set(d.motivos ?? []);
        if (!d.disponible) { this.consultada.set(true); this.cargando.set(false); return; }
        this.api.catalogo(s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (c) => {
            if (!vigente()) return;
            this.catalogo.set(c);
            this.catalogoLeidoEn.set(new Date());
            this.disponible.set(true);
            this.consultada.set(true);
            this.cargando.set(false);
          },
          error: (e) => { if (!vigente()) return; this.errorCarga.set(e?.error?.message || 'No se pudo leer el catálogo de Kepler de esta sucursal'); this.cargando.set(false); },
        });
        this.api.acreedores(s, '', 6).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (a) => { if (vigente()) this.frecuentes.set(a); },
          error: () => { if (vigente()) this.frecuentes.set([]); },
        });
      },
      error: (e) => { if (!vigente()) return; this.errorCarga.set(e?.error?.message || 'No se pudo saber si la solicitud está abierta en esta sucursal'); this.cargando.set(false); },
    });
  }

  setTipo(t: string): void {
    this.tipo.set(t as TipoComprobante);
    this.marcar('tipo');
    if (t !== 'cfdi') this.cfdiUuid.set(null);
    else if (this.cfdiPropuesto()) this.usarCfdiPropuesto();
  }

  // ── El documento: subir, leer y llenar ─────────────────────────────────────────────────────────
  alCapturar(e: { dataUrl: string; capturedAt: string }): void {
    this.subir(e.dataUrl, { live: true, captured_at: e.capturedAt });
  }

  alElegirArchivo(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > MAX_ARCHIVO_GASTO_BYTES) {
      this.toast.add({ severity: 'warn', summary: 'Archivo muy grande', detail: `El máximo es ${MAX_ARCHIVO_GASTO_MB} MB.` });
      return;
    }
    const lector = new FileReader();
    lector.onload = () => this.subir(String(lector.result), undefined);
    lector.readAsDataURL(f);
  }

  private subir(dataUrl: string, sello?: { live?: boolean; captured_at?: string }): void {
    const s = this.sucursal();
    this.leyendo.set(true);
    this.archivos.uploadFile(dataUrl, this.rolDelArchivo(), sello).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => {
        if (this.sucursal() !== s) { this.leyendo.set(false); return; }
        this.archivo.set(a);
        this.api.leerComprobante(s, { public_id: a.public_id, url: a.url, kind: a.kind }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (l) => { if (this.sucursal() !== s) return; this.lectura.set(l); this.leyendo.set(false); this.aplicarLectura(l); },
          error: () => { this.leyendo.set(false); this.lectura.set({ legible: false, motivo: 'No se pudo leer: captúralo a mano', leido: null, acreedor: null, cfdi: null }); },
        });
      },
      error: (e) => { this.leyendo.set(false); this.toast.add({ severity: 'error', summary: 'No se subió el archivo', detail: e?.error?.message || 'Intenta de nuevo' }); },
    });
  }

  /** Lo leído PROPONE; nada que la persona ya escribió (ni el tipo que eligió) se pisa (GX.33: la lectura nunca decide). */
  private aplicarLectura(l: LecturaDelComprobante): void {
    this.cfdiPropuesto.set(null);
    this.avisoCfdi.set(null);
    if (!l.legible) return;
    const yo = this.fuentes();
    const libre = (campo: string) => yo[campo] !== 'persona';
    if (l.cfdi) {
      const c = l.cfdi;
      if (libre('folio') && c.folio) { this.folioDoc.set(c.folio); this.poner('folio', 'cfdi'); }
      if (libre('fecha')) { this.fechaDoc.set(deIso(c.fecha)); this.poner('fecha', 'cfdi'); }
      if (!cfdiCuadra(c)) {
        // La solicitud sólo modela importe + IVA: con retenciones o impuestos locales Kepler recibiría otro total.
        this.avisoCfdi.set(`La factura del SAT${c.folio ? ' ' + c.folio : ''} trae retenciones o impuestos locales: su total (${this.dinero(c.total)}) no es importe + IVA. Captura los importes y adjunta su foto.`);
      } else if (yo['tipo'] === 'persona' && this.tipo() !== 'cfdi') {
        this.cfdiPropuesto.set(c);
      } else {
        this.aplicarCfdi(c);
      }
    } else if (l.leido) {
      if (libre('folio') && l.leido.folio) { this.folioDoc.set(l.leido.folio); this.poner('folio', 'ticket'); }
      if (libre('fecha') && l.leido.fecha) { this.fechaDoc.set(deIso(l.leido.fecha)); this.poner('fecha', 'ticket'); }
      if (libre('iva') && l.leido.iva != null) { this.iva.set(l.leido.iva); this.poner('iva', 'ticket'); }
      const sub = l.leido.subtotal ?? (l.leido.total != null ? l.leido.total - (l.leido.iva ?? 0) : null);
      if (sub != null) this.llenarImporte(sub, 'ticket');
    }
    if (l.acreedor && !this.acreedorSel()) { this.elegirAcreedor(l.acreedor); this.poner('acreedor', l.cfdi ? 'cfdi' : 'ticket'); }
  }

  private aplicarCfdi(c: FacturaDelSat): void {
    this.tipo.set('cfdi');
    this.cfdiUuid.set(c.uuid);
    if (this.fuentes()['iva'] !== 'persona') { this.iva.set(c.iva); this.poner('iva', 'cfdi'); }
    this.llenarImporte(Math.round((c.subtotal - (c.descuento ?? 0)) * 100) / 100, 'cfdi');
  }

  usarCfdiPropuesto(): void {
    const c = this.cfdiPropuesto();
    if (!c) return;
    this.cfdiPropuesto.set(null);
    this.aplicarCfdi(c);
  }

  private llenarImporte(subtotal: number, f: FuenteDelDato): void {
    const rs = this.renglones();
    if (rs.length !== 1 || this.fuentes()['importe_1'] === 'persona') return;
    this.renglones.set([{ ...rs[0], importe: Math.round(subtotal * 100) / 100 }]);
    this.poner('importe_1', f);
    if (this.fuentes()['renglon_1'] !== 'persona') this.poner('renglon_1', f);
  }

  // ── A quién: búsqueda y «como la última vez» ───────────────────────────────────────────────────
  buscarAcreedor(q: string): void {
    const s = this.sucursal();
    this.api.acreedores(s, q ?? '', 20).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => { if (this.sucursal() !== s) return; this.buscarFallo.set(false); this.acreedoresSug.set(a); },
      error: () => { if (this.sucursal() !== s) return; this.buscarFallo.set(true); this.acreedoresSug.set([]); },
    });
  }

  acreedorTecleado(v: AcreedorDeGasto | string | null): void {
    if ((!v || typeof v === 'string') && this.acreedorSel()) {
      this.acreedorSel.set(null);
      this.limpiarHabito();
    }
  }

  elegirAcreedor(a: AcreedorDeGasto): void {
    this.acreedorSel.set(a);
    this.marcar('acreedor');
    // Lo que puso el hábito del acreedor ANTERIOR ya no aplica.
    this.limpiarHabito();
    this.api.precarga(this.sucursal(), a.clave).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        if (this.acreedorSel()?.clave !== a.clave) return;
        const yo = this.fuentes();
        const rs = this.renglones();
        // Sólo códigos que el catálogo ofrece: uno que ya no tiene cuenta dejaría un valor invisible en el select.
        const ofrecido = (lista: Array<{ codigo: string }>, cod: string | null | undefined) => (cod && lista.some((x) => x.codigo === cod) ? cod : null);
        if (rs.length === 1) {
          const r0 = { ...rs[0] };
          let puso = false;
          const concepto = ofrecido(this.conceptos(), p.ultimo?.concepto ?? p.conceptos[0]?.codigo);
          if (yo['concepto_1'] !== 'persona' && concepto) { r0.concepto = concepto; this.poner('concepto_1', 'habito'); puso = true; }
          const proyecto = ofrecido(this.proyectos(), p.ultimo?.proyecto);
          if (yo['proyecto_1'] !== 'persona' && proyecto) { r0.proyecto = proyecto; this.poner('proyecto_1', 'habito'); puso = true; }
          const depto = ofrecido(this.departamentos(), p.ultimo?.departamento);
          if (yo['departamento_1'] !== 'persona' && depto) { r0.departamento = depto; this.poner('departamento_1', 'habito'); puso = true; }
          this.renglones.set([r0]);
          if (puso && !yo['renglon_1']) this.poner('renglon_1', 'habito');
        }
        if (yo['forma_pago'] !== 'persona' && p.forma_pago) { this.formaPago.set(p.forma_pago); this.poner('forma_pago', 'habito'); }
      },
    });
  }

  /** Quita lo que llenó el hábito (es del acreedor anterior): vuelve a quedar vacío y sin rótulo. */
  private limpiarHabito(): void {
    const yo = this.fuentes();
    const rs = this.renglones();
    if (rs.length) {
      const r0 = { ...rs[0] };
      for (const k of ['concepto', 'proyecto', 'departamento'] as const) if (yo[`${k}_1`] === 'habito') r0[k] = null;
      this.renglones.set([r0, ...rs.slice(1)]);
    }
    if (yo['forma_pago'] === 'habito') this.formaPago.set('');
    this.fuentes.update((m) => Object.fromEntries(Object.entries(m).filter(([, f]) => f !== 'habito')) as Record<string, FuenteDelDato>);
  }

  // ── Renglones ──────────────────────────────────────────────────────────────────────────────────
  cambiarRenglon(i: number, campo: keyof RenglonEnCaptura, v: string | number | null): void {
    this.renglones.update((rs) => rs.map((r, j) => (j === i ? { ...r, [campo]: v } : r)));
    this.marcar(`renglon_${i + 1}`);
    this.marcar(`${campo}_${i + 1}`);
  }

  agregarRenglon(): void {
    const ultimo = this.renglones()[this.renglones().length - 1];
    this.renglones.update((rs) => [...rs, { concepto: null, proyecto: ultimo?.proyecto ?? null, departamento: ultimo?.departamento ?? null, importe: null }]);
  }

  quitarRenglon(i: number): void {
    this.renglones.update((rs) => rs.filter((_, j) => j !== i));
    // Las fuentes van por número de renglón: las del que se quita se borran y las de abajo suben uno.
    const quitado = i + 1;
    this.fuentes.update((m) => {
      const out: Record<string, FuenteDelDato> = {};
      for (const [k, f] of Object.entries(m)) {
        const r = /^(renglon|concepto|proyecto|departamento|importe)_(\d+)$/.exec(k);
        if (!r) { out[k] = f; continue; }
        const n = Number(r[2]);
        if (n === quitado) continue;
        out[`${r[1]}_${n > quitado ? n - 1 : n}`] = f;
      }
      return out;
    });
  }

  // ── Mandar a firma ─────────────────────────────────────────────────────────────────────────────
  enviar(): void {
    if (this.enviando() || this.faltan().length) return;
    this.enviando.set(true);
    const a = this.archivo();
    this.api.crear({
      id_cliente: this.idCliente,
      sucursal: this.sucursal(), acreedor: this.acreedorSel()!.clave,
      renglones: this.renglones().map((r) => ({ concepto: r.concepto ?? '', proyecto: r.proyecto ?? '', departamento: r.departamento ?? '', importe: Number(r.importe ?? 0) })),
      iva: this.iva(),
      comprobante: { tipo: this.tipo(), folio: this.folioDoc() || null, fecha: iso(this.fechaDoc()), uuid: this.cfdiUuid() },
      forma_pago: this.formaPago(), forma_pago_detalle: this.detalle() || null,
      files: a ? [{ ...a, role: this.rolDelArchivo() }] : [], comentario: this.nota() || null,
      periodo_del: iso(this.periodoDel()), periodo_al: iso(this.periodoAl()), unidad: this.unidad() || null,
      necesita_para: iso(this.necesitaPara()), motivo_fecha: this.motivoFecha() || null, fuentes: this.fuentes(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => {
        this.enviando.set(false);
        this.creada.set(c);
        this.toast.add({ severity: 'success', summary: 'Mandado a firma', detail: `${this.dinero(c.total)} · al firmarse se escribe en Kepler` });
        this.reiniciar(false);
      },
      error: (e) => {
        this.enviando.set(false);
        const status = Number(e?.status ?? 0);
        if (status === 0 || status >= 500) {
          // No se sabe si llegó. Mandarla otra vez es seguro: lleva el mismo identificador y no se duplica.
          this.toast.add({ severity: 'warn', summary: 'No se sabe si llegó', life: 10000, detail: 'Revisa Mis gastos o vuelve a mandarla: si ya había llegado, no se duplica.' });
        } else {
          this.toast.add({ severity: 'error', summary: 'No se mandó', detail: e?.error?.message || 'Intenta de nuevo', life: 8000 });
        }
      },
    });
  }

  private reiniciar(borrarCreada = true): void {
    this.archivo.set(null); this.lectura.set(null); this.folioDoc.set(''); this.fechaDoc.set(null); this.cfdiUuid.set(null); this.motivoFecha.set('');
    this.cfdiPropuesto.set(null); this.avisoCfdi.set(null); this.buscarFallo.set(false);
    this.acreedorSel.set(null); this.renglones.set([{ concepto: null, proyecto: null, departamento: null, importe: null }]); this.iva.set(0);
    this.formaPago.set(''); this.detalle.set(''); this.periodoDel.set(null); this.periodoAl.set(null); this.unidad.set(''); this.nota.set('');
    this.necesitaPara.set(null); this.duplicados.set([]); this.duplicadosFallo.set(false); this.fuentes.set({}); this.tipo.set('ticket');
    this.idCliente = nuevoId();
    if (borrarCreada) this.creada.set(null);
  }
}
