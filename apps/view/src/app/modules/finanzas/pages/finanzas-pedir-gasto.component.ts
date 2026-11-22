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
import { ConfirmationService, MessageService } from 'primeng/api';
import {
  DIAS_MAXIMOS_COMPROBANTE, LARGO_DESCRIPCION_ACTIVO, MAX_CANTIDAD_ACTIVO, UMBRAL_ACTIVO_POR_UNIDAD, esCuentaDeActivo, importePorUnidad,
  FORMAS_PAGO, MAX_ARCHIVO_GASTO_BYTES, MAX_ARCHIVO_GASTO_MB, MAX_RENGLONES, PLAZOS_DE_PAGO, avisoDeFechas, cfdiCuadra, correoValido, cuentaDePago,
  detallePagoOpcional, exigeDetalle, faltaParaPedir, fechaDePago, hayInformacionDePago, lecturaParaGuardar, motivoParaNoOfrecer, totalesDeLaSolicitud,
  type AcreedorDeGasto, type AlcanceDeLaBase, type CatalogoDeLaSolicitud, type DuplicadoProbable, type FacturaPorRegistrar, type FuenteDelDato,
  type InformacionDePago, type LecturaDelComprobante, type SolicitudGastoCreada, type TipoComprobante, type FaltanteSolicitud,
} from '@megadulces/contracts';

import { STORE_BRANCHES, branchLabel } from '../../../core/constants/store-branches';
import { ComprobacionesService, type ProofFile, type ProofFileRole } from '../comprobaciones.service';
import { SolicitudGastoService } from '../solicitud-gasto.service';
import { CapturaEnVivoComponent } from '../components/captura-en-vivo.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { FacturasSatBandejaComponent, type ProveedorDeLaBandeja } from '../components/facturas-sat-bandeja.component';
import { ACTIVO_VACIO, FUENTE_TEXTO, campoQueFalta, type ActivoEnCaptura, enLista, loQueReemplaza, origenDelRenglon, sinBaseTexto, textoDelPlazo, type RenglonEnCaptura } from './pedir-gasto.ayudas';

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
 * Qué ve y en qué orden (S.17, Francisco 2026-11-16, anexo S §15): (1) la BASE —con un solo almacén, fija; con
 * varios, se elige, sin preselección—, (2) el PROVEEDOR —y debajo, sus facturas del SAT sin gasto—, (3) el
 * comprobante —la factura del SAT, o la foto que se LEE sola—, (4) qué y cuánto —«como la última vez»—, (5) cómo se
 * paga: la forma, el plazo y, si hace falta, la información de pago (cuenta y correo); y en la barra de abajo, el
 * total, lo que falta y UN botón. Cada dato dice de dónde salió; lo que ninguna fuente contestó es lo único que se
 * pregunta. La lectura propone y nunca decide (GX.32/33).
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
    MetricStripComponent, FreshnessPillComponent, FacturasSatBandejaComponent,
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

      <!-- 1 · La base: en qué servidor de Kepler se pide (DS27). Una → fija; varias → se elige, sin preselección. -->
      <fieldset class="pg-bloque" id="pg-base">
        <legend class="pg-legend" id="pg-base-t" tabindex="-1"><span class="pg-num">1</span> Base</legend>
        @if (sucursales().length > 1) {
          @if (sucursales().length <= 5) {
            <p-selectbutton [options]="opcionesBase()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)"
              [allowEmpty]="false" ariaLabelledBy="pg-base-t" />
          } @else {
            <p-select inputId="pg-sucursal" appendTo="body" [options]="opcionesBase()" optionLabel="label" optionValue="value" ariaLabelledBy="pg-base-t"
              [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)" [fluid]="true" placeholder="Elige la base" />
          }
        } @else if (sucursal()) {
          <!-- «tu almacén» sólo si de verdad es el único suyo; con varias o todas, es la única ABIERTA (no se afirma de más). -->
          <p class="pg-suc-fija"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ nombreSucursal() }} <span class="pg-fuente">· {{ porQueUnaBase() }}</span></p>
        }
        @if (disponible()) {
          <p class="pg-catalogo">Catálogo de Kepler de esta base <app-freshness-pill measures="fetch" [since]="catalogoLeidoEn()" label="leído" /></p>
        }
      </fieldset>
      <app-load-state [loading]="cargando()" [error]="errorCarga()" (retry)="reintentarCarga()" [skeletonRows]="5"
        errorTitle="No se pudo abrir la solicitud">
        @if (!sucursal()) {
          <p class="pg-elige" role="status"><i class="pi pi-map-marker" aria-hidden="true"></i>
            {{ sucursales().length ? 'Elige la base para empezar.' : textoSinBase() }}</p>
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
          <!-- S.17: la cifra nace con su valor (contaba desde 0: la franja decía «7 FALTA» con la barra en «Faltan 8», como S.13 H2). -->
          <app-metric-strip [items]="resumen()" density="compact" [instant]="true" ariaLabel="Cómo va la solicitud" />

          <!-- 2 · El proveedor, y debajo SUS facturas del SAT sin gasto (DS28) -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend" id="pg-prov-t"><span class="pg-num">2</span> Proveedor</legend>
            <div class="pg-campo">
              <label for="pg-acreedor">Proveedor (acreedor de Kepler) <span class="pg-req" aria-hidden="true">*</span></label>
              <p-autocomplete inputId="pg-acreedor" [required]="true" [invalid]="mal('pg-acreedor')" [ngModel]="acreedorSel()" (ngModelChange)="acreedorTecleado($event)" [suggestions]="acreedoresSug()"
                (completeMethod)="buscarAcreedor($event.query)" (onSelect)="elegirAcreedor($event.value)" optionLabel="nombre"
                [forceSelection]="true" [dropdown]="true" [showClear]="true" appendTo="body" [fluid]="true"
                placeholder="Nombre, clave o RFC" [emptyMessage]="buscarFallo() ? 'No se pudo buscar: intenta otra vez' : 'Sin acreedores de gasto con eso en esta base'">
                <ng-template let-a #item>
                  <div class="pg-ac-op"><span class="pg-ac-n">{{ a.nombre }}</span><span class="pg-ac-c">{{ a.clave }}@if (a.usos) { · {{ a.usos }} en 6 meses }</span></div>
                </ng-template>
              </p-autocomplete>
              @if (fuente('acreedor'); as f) { <small class="pg-fuente">{{ f }}</small> }
              @if (buscarFallo()) { <small class="pg-nota-aviso" role="status">No se pudo buscar acreedores: revisa tu conexión e intenta otra vez.</small> }
              @if (avisoAcreedor(); as aa) { <small class="pg-nota-aviso" role="status">{{ aa }}</small> }
            </div>
            <!-- S.13 + S.17: sin proveedor, los que tienen facturas sin gasto; con proveedor, SUS facturas. -->
            <app-facturas-sat-bandeja [sucursal]="sucursal()" [acreedor]="proveedorDeLaBandeja()" [enUso]="cfdiUuid()" [refrescar]="bandejaVersion()"
              [bloqueado]="enviando()" (registrar)="usarFactura($event)" (elegirProveedor)="elegirDesdeFactura($event)" />
            @if (!acreedorSel() && frecuentes().length) {
              <!-- comm-actions: con el dedo, 44 px (la regla global de toque). -->
              <div class="pg-chips comm-actions" role="group" aria-labelledby="pg-frec-t">
                <span class="pg-chips-t" id="pg-frec-t">Frecuentes</span>
                @for (a of frecuentes(); track a.clave) {
                  <!-- Neutros, como los de «Con facturas del SAT»: el color de acción es sólo de «Mandar a firma» (S.13 H3). -->
                  <button pButton type="button" size="small" [outlined]="true" [plain]="true" (click)="elegirAcreedor(a)">{{ a.nombre }}</button>
                }
              </div>
            }
          </fieldset>

          <!-- 3 · El comprobante -->
          <fieldset class="pg-bloque" id="pg-documento">
            <legend class="pg-legend" id="pg-doc-t" tabindex="-1"><span class="pg-num">3</span> El comprobante</legend>
            <app-segmented [options]="tiposDoc" [value]="tipo()" (valueChange)="setTipo($event)" ariaLabel="Qué documento ampara el gasto" />
            <div class="pg-arch">
              @if (tipo() !== 'cotizacion') {
                <!-- H20: con la factura casada al SAT la foto sobra: el botón deja de ser el principal y lo dice. -->
                <md-captura-en-vivo [etiqueta]="cfdiUuid() ? 'Tomar foto (opcional)' : 'Tomar foto'" [secundario]="!!cfdiUuid()" (capturada)="alCapturar($event)" />
              }
              <label class="pg-subir" [class.pg-subir-mal]="mal('pg-doc-t')">
                <i class="pi pi-upload" aria-hidden="true"></i>
                <span>{{ tipo() === 'cotizacion' ? 'Subir la cotización' : 'Subir archivo' }}</span>
                <input type="file" accept="image/*,application/pdf" (change)="alElegirArchivo($event)" aria-describedby="pg-arch-estado" />
              </label>
            </div>
            <!-- [PGP.122.9] La región de estado EXISTE siempre y sólo cambia de texto: una que aparece ya con su texto no se
                 anuncia de forma fiable (modern-web-guidance: required-field-feedback). El enlace va fuera de ella. -->
            <p class="pg-leido">
              @if (archivo(); as a) { <a [href]="a.url" target="_blank" rel="noopener"><i class="pi pi-file" aria-hidden="true"></i> Ver el archivo</a> }
              <span id="pg-arch-estado" class="pg-leido-t" role="status">{{ estadoArchivo() }}</span>
            </p>
            @if (errorArchivo(); as ea) { <p class="pg-error" role="alert"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ ea }}</p> }
            <div class="pg-grid">
              <div class="pg-campo">
                <label for="pg-folio">Folio del {{ tipo() === 'cfdi' ? 'CFDI' : tipo() === 'cotizacion' ? 'documento' : 'ticket' }}</label>
                <input pInputText id="pg-folio" [ngModel]="folioDoc()" (ngModelChange)="folioDoc.set($event); marcar('folio')" maxlength="40" autocomplete="off" inputmode="text" />
                @if (fuente('folio'); as f) { <small class="pg-fuente">{{ f }}</small> }
              </div>
              <div class="pg-campo">
                <label for="pg-fecha">Fecha del documento <span class="pg-req" aria-hidden="true">*</span></label>
                <p-datepicker inputId="pg-fecha" [ngModel]="fechaDoc()" (ngModelChange)="fechaDoc.set($event); marcar('fecha')" dateFormat="dd/mm/yy"
                  [showIcon]="true" appendTo="body" [maxDate]="hoyDate()" [fluid]="true" [required]="true" [invalid]="mal('pg-fecha')"
                  placeholder="dd/mm/aaaa" ariaLabelledBy="pg-fecha-l" />
                <small id="pg-fecha-l" class="sr-only">Fecha del documento, día/mes/año</small>
                <!-- [PGP.122.13] Junto a la fecha que propuso el lector, lo que dice el papel: la persona compara de un vistazo.
                     Si leyó algo que no es fecha (o es futura), no se propone nada y se dice qué leyó. -->
                @if (fuente('fecha'); as f) { <small class="pg-fuente">{{ f }}@if (fechaImpresaPropuesta(); as t) {: «{{ t }}»}</small> }
                @else if (fechaImpresaSinUsar(); as t) { <small class="pg-fuente">Se leyó «{{ t }}», pero no se propone (sólo una fecha completa de los últimos {{ diasMaximosLectura }} días): escríbela viendo el comprobante.</small> }
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

          <!-- 4 · Qué y cuánto -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend" id="pg-que" tabindex="-1"><span class="pg-num">4</span> Qué es y cuánto</legend>
            @for (r of renglones(); track $index; let i = $index) {
              <div class="pg-renglon" role="group" [attr.aria-label]="'Renglón ' + (i + 1)">
                <div class="pg-campo pg-ren-concepto">
                  <!-- [PGP.122.9] El combobox de p-select es un <span>: un <label for> no lo nombra. Se nombra por id del
                       label (ariaLabelledBy); si no, su nombre era el valor elegido (modern-web-guidance: accessibility). -->
                  <label [for]="'pg-con-' + i" [id]="'pg-con-l-' + i">Concepto <span class="pg-req" aria-hidden="true">*</span></label>
                  <!-- [PGP.122.14] Lo que no se puede pedir aparece al final, deshabilitado y con su motivo: buscarlo lo encuentra. -->
                  <p-select [inputId]="'pg-con-' + i" [ariaLabelledBy]="'pg-con-l-' + i" [required]="true" [invalid]="mal('pg-con-' + i)" appendTo="body" [options]="opcionesConcepto()" optionLabel="etiqueta" optionValue="codigo"
                    optionDisabled="bloqueado" [filter]="true" filterBy="etiqueta" [ngModel]="r.concepto" (ngModelChange)="cambiarRenglon(i, 'concepto', $event)" [fluid]="true" placeholder="Elige el concepto">
                    <!-- PrimeNG 22 no pone aria-disabled en la opción (sólo data-p-disabled): el lector de pantalla lo oye aquí. -->
                    <ng-template #item let-c>
                      <span class="pg-opcion">{{ c.etiqueta }}@if (c.motivo) {<small class="pg-opcion-motivo"><span class="sr-only">No se puede elegir: </span>{{ c.motivo }}</small>}</span>
                    </ng-template>
                  </p-select>
                </div>
                <div class="pg-campo">
                  <label [for]="'pg-pro-' + i" [id]="'pg-pro-l-' + i">Proyecto <span class="pg-req" aria-hidden="true">*</span></label>
                  <p-select [inputId]="'pg-pro-' + i" [ariaLabelledBy]="'pg-pro-l-' + i" [required]="true" [invalid]="mal('pg-pro-' + i)" appendTo="body" [options]="proyectos()" optionLabel="etiqueta" optionValue="codigo" [filter]="true"
                    filterBy="etiqueta" [ngModel]="r.proyecto" (ngModelChange)="cambiarRenglon(i, 'proyecto', $event)" [fluid]="true" placeholder="Proyecto" />
                </div>
                <div class="pg-campo">
                  <label [for]="'pg-dep-' + i" [id]="'pg-dep-l-' + i">Departamento <span class="pg-req" aria-hidden="true">*</span></label>
                  <p-select [inputId]="'pg-dep-' + i" [ariaLabelledBy]="'pg-dep-l-' + i" [required]="true" [invalid]="mal('pg-dep-' + i)" appendTo="body" [options]="departamentos()" optionLabel="etiqueta" optionValue="codigo" [filter]="true"
                    filterBy="etiqueta" [ngModel]="r.departamento" (ngModelChange)="cambiarRenglon(i, 'departamento', $event)" [fluid]="true" placeholder="Departamento" />
                </div>
                <div class="pg-campo pg-ren-importe">
                  <label [for]="'pg-imp-' + i">Importe sin IVA <span class="pg-req" aria-hidden="true">*</span></label>
                  <p-inputnumber [inputId]="'pg-imp-' + i" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2" [maxFractionDigits]="2" [min]="0"
                    [ariaRequired]="true" [invalid]="mal('pg-imp-' + i)"
                    [ngModel]="r.importe" (ngModelChange)="cambiarRenglon(i, 'importe', $event)" [fluid]="true" />
                </div>
                @if (renglones().length > 1) {
                  <p-button type="button" styleClass="pg-quitar" icon="pi pi-times" [text]="true" size="small" [ariaLabel]="'Quitar el renglón ' + (i + 1)" (onClick)="quitarRenglon(i)" />
                }
              </div>
              <!-- H1: cada campo con SU origen («de la factura» era sólo el importe; el concepto salió del hábito). -->
              @if (origenRenglon(i); as o) { <small class="pg-fuente">{{ o }}</small> }
              <!-- [PGP.122.17] El concepto de activo (cuenta 150) abre su formulario (DS47/DS48): qué es, cuántos y dónde va.
                   El resguardo no se pide aquí: lo asigna Control de Activos en el alta (DS56). Anexo S §20. -->
              @if (esActivo(i)) {
                <div class="pg-activo" role="group" [attr.aria-labelledby]="'pg-act-t-' + i">
                  <span class="pg-activo-titulo" [id]="'pg-act-t-' + i">Compra de activo · renglón {{ i + 1 }}</span>
                  <div class="pg-campo">
                    <span class="pg-label" [id]="'pg-act-tipo-l-' + i">¿Qué compras? <span class="pg-req" aria-hidden="true">*</span></span>
                    <p-selectbutton [id]="'pg-act-tipo-' + i" [options]="tiposDeActivo" optionLabel="label" optionValue="value" [allowEmpty]="false"
                      [ariaLabelledBy]="'pg-act-tipo-l-' + i" [ngModel]="r.activo?.tipo ?? null" (ngModelChange)="cambiarActivo(i, 'tipo', $event)" />
                  </div>
                  @if (r.activo?.tipo === 'gasto') {
                    <p class="pg-nota-aviso" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i>
                      <span>Una reparación, refacción o consumible es gasto, no activo: elige un concepto de gasto.</span>
                      <p-button type="button" label="Cambiar el concepto" [text]="true" size="small" (onClick)="cambiarConceptoAGasto(i)" />
                    </p>
                  } @else {
                    <small class="pg-fuente">{{ grupoTexto(i) }}</small>
                    <div class="pg-activo-grid">
                      <div class="pg-campo">
                        <label [for]="'pg-act-que-' + i">Qué es <span class="pg-req" aria-hidden="true">*</span></label>
                        <input pInputText [id]="'pg-act-que-' + i" [maxlength]="largoDescripcion" [class.ng-invalid]="mal('pg-act-que-' + i)" [class.ng-dirty]="mal('pg-act-que-' + i)"
                          [ngModel]="r.activo?.descripcion ?? ''" (ngModelChange)="cambiarActivo(i, 'descripcion', $event)" placeholder="El bien, con marca y modelo" />
                      </div>
                      <div class="pg-campo">
                        <label [for]="'pg-act-cuantos-' + i">Cuántos <span class="pg-req" aria-hidden="true">*</span></label>
                        <p-inputnumber [inputId]="'pg-act-cuantos-' + i" [min]="1" [max]="maxCantidad" [useGrouping]="false" inputmode="numeric" [invalid]="mal('pg-act-cuantos-' + i)"
                          [ngModel]="r.activo?.cantidad ?? null" (ngModelChange)="cambiarActivo(i, 'cantidad', $event)" [fluid]="true" />
                      </div>
                      <div class="pg-campo">
                        <label [for]="'pg-act-lugar-' + i">Lugar</label>
                        <input pInputText [id]="'pg-act-lugar-' + i" [maxlength]="largoDescripcion" [ngModel]="r.activo?.lugar ?? ''"
                          (ngModelChange)="cambiarActivo(i, 'lugar', $event)" placeholder="Además de la sucursal y el departamento" />
                      </div>
                    </div>
                    @if (porUnidad(i); as u) {
                      <small class="pg-fuente" [class.pg-mal]="u <= umbralActivo">Por unidad: {{ dinero(u) }} sin IVA{{ u <= umbralActivo ? ' — es gasto, no activo: es activo si pasa de ' + dinero(umbralActivo) + ' por unidad' : '' }}</small>
                    }
                  }
                </div>
              }
            }
            <!-- R14: el concepto que va a otro rubro que en CEDIS no se ofrece, pero se dice por qué (no se esconde). -->
            @if (habitoBloqueado(); as hb) {
              <p class="pg-nota-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> El concepto que usa este proveedor no se ofrece aquí: {{ hb }}.</p>
            } @else {
              @for (cb of conceptosBloqueados(); track cb.codigo) {
                <p class="pg-nota-aviso"><i class="pi pi-info-circle" aria-hidden="true"></i> No se ofrece: {{ cb.distinto_de_cedis }}.</p>
              }
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

          <!-- 5 · Cómo se paga: la forma, el plazo (DS30) y, si hace falta, la información de pago (DS31) -->
          <fieldset class="pg-bloque">
            <legend class="pg-legend" id="pg-como" tabindex="-1"><span class="pg-num">5</span> {{ tipo() === 'cotizacion' ? 'Cómo se va a pagar' : 'Cómo se paga' }}</legend>
            <div class="pg-campo">
              <span class="pg-label" id="pg-forma-t">Forma de pago <span class="pg-req" aria-hidden="true">*</span></span>
              <!-- [PGP.122.9] Una sola opción de seis: radiogroup con flechas («1 de 6»), no seis botones con aria-pressed. -->
              <app-segmented [options]="formasPagoSeg" [value]="formaPago()" (valueChange)="formaPago.set($event); marcar('forma_pago')" ariaLabel="Forma de pago"
                [class.pg-seg-mal]="mal('pg-como')" />
              @if (fuente('forma_pago'); as f) { <small class="pg-fuente">{{ f }}</small> }
            </div>
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
            <div class="pg-campo">
              <span class="pg-label" id="pg-plazo-t">Plazo</span>
              <app-segmented [options]="plazosSeg" [value]="plazoSel()" (valueChange)="elegirPlazo($event)" ariaLabel="Plazo" />
              @if (plazoSel() === 'otra') {
                <div class="pg-campo pg-otra">
                  <label for="pg-fecha-pago">Fecha de pago</label>
                  <p-datepicker inputId="pg-fecha-pago" [ngModel]="fechaOtra()" (ngModelChange)="fechaOtra.set($event); marcar('plazo')" dateFormat="dd/mm/yy"
                    [showIcon]="true" appendTo="body" [minDate]="hoyDate()" [fluid]="true" />
                </div>
              }
              <small class="pg-fuente" aria-live="polite">{{ textoPlazo() }}@if (fuente('plazo'); as f) { · {{ f }} }</small>
            </div>
            @if (!pagoAbierto()) {
              <span class="pg-mas-pago comm-actions">
                <p-button type="button" icon="pi pi-plus" label="Agregar información de pago" [text]="true" size="small" (onClick)="abrirPago()" />
              </span>
            } @else {
              <div class="pg-pago" role="group" aria-labelledby="pg-pago-t">
                <div class="pg-pago-head">
                  <span class="pg-label" id="pg-pago-t">Información de pago</span>
                  <span class="comm-actions">
                    <p-button type="button" label="Quitar" [text]="true" size="small" severity="secondary" ariaLabel="Quitar la información de pago" (onClick)="quitarPago()" />
                  </span>
                </div>
                <div class="pg-grid">
                  <div class="pg-campo">
                    <label for="pg-cuenta">Cuenta o CLABE</label>
                    <input pInputText id="pg-cuenta" [ngModel]="pagoCuenta()" (ngModelChange)="pagoCuenta.set($event); marcar('pago_cuenta')" autocomplete="off"
                      inputmode="numeric" maxlength="30" [invalid]="cuentaMal()" [attr.aria-invalid]="cuentaMal() ? true : null" aria-describedby="pg-cuenta-ayuda" />
                    <small id="pg-cuenta-ayuda" class="pg-fuente" [class.pg-mal]="cuentaMal()">{{ textoCuenta() }}</small>
                  </div>
                  <div class="pg-campo">
                    <label for="pg-banco">Banco (opcional)</label>
                    <input pInputText id="pg-banco" [ngModel]="pagoBanco()" (ngModelChange)="pagoBanco.set($event); marcar('pago_banco')" autocomplete="off" maxlength="40" />
                    @if (fuente('pago_banco'); as f) { <small class="pg-fuente">{{ f }}</small> }
                  </div>
                </div>
                <div class="pg-campo">
                  <label for="pg-correo">Correo para mandar el comprobante del pago</label>
                  <input pInputText id="pg-correo" type="email" [ngModel]="pagoCorreo()" (ngModelChange)="pagoCorreo.set($event); marcar('pago_correo')" autocomplete="off"
                    inputmode="email" maxlength="120" [invalid]="correoMal()" [attr.aria-invalid]="correoMal() ? true : null" aria-describedby="pg-correo-ayuda" />
                  <small id="pg-correo-ayuda" class="pg-fuente" [class.pg-mal]="correoMal()">{{ correoMal() ? 'Escribe una sola dirección, con @ y su dominio.' : (fuente('pago_correo') ?? 'Una sola dirección.') }}</small>
                </div>
              </div>
            }
          </fieldset>

          <details class="pg-mas">
            <summary>Más datos (opcional): periodo, unidad, nota</summary>
            <div class="pg-grid">
              <div class="pg-campo"><label for="pg-del">Periodo del</label>
                <p-datepicker inputId="pg-del" [ngModel]="periodoDel()" (ngModelChange)="periodoDel.set($event)" dateFormat="dd/mm/yy" appendTo="body" [fluid]="true" /></div>
              <div class="pg-campo"><label for="pg-al">al</label>
                <p-datepicker inputId="pg-al" [ngModel]="periodoAl()" (ngModelChange)="periodoAl.set($event)" dateFormat="dd/mm/yy" appendTo="body" [fluid]="true" /></div>
              <div class="pg-campo"><label for="pg-unidad">Unidad o placa</label>
                <input pInputText id="pg-unidad" [ngModel]="unidad()" (ngModelChange)="unidad.set($event)" maxlength="20" autocomplete="off" /></div>
            </div>
            <div class="pg-campo"><label for="pg-nota">Nota para Kepler</label>
              <input pInputText id="pg-nota" [ngModel]="nota()" (ngModelChange)="nota.set($event)" maxlength="60" autocomplete="off" aria-describedby="pg-nota-ayuda" />
              <small id="pg-nota-ayuda" class="pg-fuente">Si no la escribes, se arma del concepto, el periodo y la unidad.</small></div>
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

          <!-- [PGP.122.9] El resumen de lo que falta sale DESPUÉS de intentar mandarlo, no al abrir la pantalla (salían 8
               faltantes con el formulario vacío). Cada renglón lleva al campo (modern-web-guidance: forms,
               accessible-error-announcement). Mientras no se intente, la franja de arriba dice cuánto falta, sin regañar. -->
          @if (intento() && faltan().length) {
            <div class="pg-faltan" id="pg-faltan" tabindex="-1" aria-labelledby="pg-faltan-t">
              <p class="pg-faltan-t" id="pg-faltan-t">Para mandarlo a firma falta{{ faltan().length === 1 ? '' : 'n' }} {{ faltan().length }} dato{{ faltan().length === 1 ? '' : 's' }}:</p>
              <ul>@for (f of faltan(); track f.motivo) {
                <li><button type="button" class="pg-faltan-ir" (click)="irAlCampo(f)">{{ f.motivo }}</button></li>
              }</ul>
            </div>
          }
        }
      </app-load-state>

      @if (creada(); as c) {
        <!-- [PGP.122.9] El foco viene aquí al mandarlo (el formulario se vacía y el botón ya no existe para el foco);
             sin toast encima: dos avisos a la vez se pisan en el lector de pantalla. -->
        <div class="pg-hecho" id="pg-hecho" tabindex="-1" role="status">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <div>
            <p><strong>Listo: {{ dinero(c.total) }} espera firma.</strong> Al firmarse se escribe en Kepler; su folio aparece en Mis gastos.</p>
            @if (c.duplicados.length) {
              <p class="pg-nota-aviso">Ojo: hoy ya había {{ c.duplicados.length === 1 ? 'otro gasto' : c.duplicados.length + ' gastos' }} al mismo acreedor por el mismo total@for (d of c.duplicados; track $index) { · {{ d.donde === 'kepler' ? 'Kepler' : 'Suite' }}@if (d.folio) { {{ d.folio }} } }. Si es el mismo, avisa a quien firma.</p>
            }
            <!-- [PGP.122.10] Al vale recién pedido, ya abierto: en una bandeja de 40+ vales del día quedaba al fondo. -->
            <a routerLink="/finanzas/mis-gastos" [queryParams]="{ vale: c.id }">Ver el vale en Mis gastos</a>
          </div>
        </div>
      }

      @if (disponible()) {
        <div class="pg-barra">
          <div class="pg-barra-t">
            <span class="pg-barra-total comm-num">{{ dinero(totales().total) }}</span>
            <span class="pg-barra-falta">{{ faltan().length ? 'Faltan ' + faltan().length : 'Listo para firma' }}</span>
          </div>
          <!-- [PGP.122.9] Habilitado aunque falte algo: al tocarlo dice qué falta y lleva al campo. Sólo se bloquea mientras
               se manda, para no mandar dos veces («DON'T disable submit buttons to block validation»). -->
          <p-button type="button" styleClass="pg-enviar" icon="pi pi-send" [label]="tipo() === 'cotizacion' ? 'Pedir firma' : 'Mandar a firma'"
            [disabled]="enviando()" [loading]="enviando()" (onClick)="enviar()" />
        </div>
        @if (errorEnvio(); as ee) {
          <!-- Se queda hasta que se corrige o se vuelve a mandar: un toast se cerraba solo y el motivo no quedaba escrito. -->
          <p class="pg-error" role="alert"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ ee }}</p>
        }
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
    /* [PGP.122.14] La opción que no se puede pedir lleva su motivo debajo. PrimeNG la atenúa al 60 %: con --fg-1 el motivo
       queda en 5.3:1 (claro) y 6.8:1 (oscuro); con --fg-2 bajaría a 2.9:1. La jerarquía la da el tamaño, no el gris. */
    .pg-opcion { display: flex; flex-direction: column; gap: 2px; white-space: normal; min-width: 0; }
    .pg-opcion-motivo { color: var(--fg-1); font-size: var(--fs-xs); }
    .pg-arch { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
    .pg-subir { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 2.75rem; padding: 0 var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-md); cursor: pointer; color: var(--text-main); }
    .pg-subir input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .pg-subir:focus-within { outline: 2px solid var(--action); outline-offset: 2px; }
    .pg-leido { margin: 0; display: flex; flex-wrap: wrap; gap: var(--sp-3); font-size: var(--fs-sm); }
    .pg-leido-t { color: var(--text-muted); }
    .pg-sat { margin: 0; font-size: var(--fs-sm); color: var(--text-main); display: flex; gap: var(--sp-2); align-items: center; overflow-wrap: anywhere; }
    .pg-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; justify-content: flex-start; }
    .pg-chips-t { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin-right: var(--sp-1); }
    .pg-mas-pago { justify-content: flex-start; }
    .pg-pago { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .pg-pago-head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); }
    .pg-otra { max-width: 16rem; }
    /*
     * S.17 (prueba visual a 390 px): la forma de pago cortaba sus etiquetas («Transferenc», «Efectivc») y el plazo partía
     * cada botón en dos renglones. El grupo se envuelve y cada botón conserva su etiqueta completa.
     */
    :host ::ng-deep .pg-bloque .p-selectbutton { display: flex; flex-wrap: wrap; max-width: 100%; }
    :host ::ng-deep .pg-bloque .p-selectbutton .p-togglebutton { flex: 0 0 auto; white-space: nowrap; }
    /*
     * Contraste (medido): la opción NO elegida de Aura va en zinc-500 y sobre el fondo zinc-100 de Operations da 4.40:1,
     * bajo el 4.5 de AA. En la base, sin preselección, TODAS están así y hay que leerlas para elegir: van en el texto
     * atenuado de la Suite (--text-muted). La causa es del preset (operations-preset.ts): hallazgo de sistema para Edgar.
     */
    :host ::ng-deep .pg-bloque .p-selectbutton .p-togglebutton:not(.p-togglebutton-checked) { color: var(--text-muted); }
    /* Con el dedo, 44 px (la regla global de toque no alcanza a los botones de un p-selectbutton: medían 35). */
    @media (pointer: coarse) { :host ::ng-deep .pg-bloque .p-selectbutton .p-togglebutton { min-height: var(--tap-min); } }
    .pg-mal { color: var(--bad-soft-fg); }
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
    /* [PGP.122.9] Cada faltante lleva a su campo; los obligatorios se ven (*) y lo que falta se marca DESPUÉS de intentar. */
    .pg-faltan { border-color: var(--bad-border); }
    .pg-faltan:focus-visible, .pg-hecho:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .pg-faltan-ir { background: none; border: 0; padding: 0; color: var(--bad-soft-fg); text-decoration: underline; cursor: pointer; font: inherit; text-align: left; min-height: 1.5rem; }
    .pg-faltan-ir:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .pg-req { color: var(--bad-fg); }
    .pg-error { margin: 0; display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
    .pg-subir-mal { border-color: var(--bad-fg); }
    .pg-seg-mal { display: block; outline: 1px solid var(--bad-fg); border-radius: var(--r-md); }
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
    /* [PGP.122.17] La compra de un activo, bajo su renglón: se agrupa por sangría y espacio, no con una caja. */
    .pg-activo { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0 0 var(--sp-2) var(--sp-4); }
    .pg-activo-titulo { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .pg-activo-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 1fr) minmax(0, 2fr); gap: var(--sp-3); align-items: end; }
    /* Al dedo, lo que se toca en el bloque mide 44 px (VALORES.md, objetivo táctil): medido en Fold 7, el botón medía 28 y
       los campos 38. Los campos de arriba del formulario siguen en ~38: deuda con nombre, fuera de este bloque. */
    @media (pointer: coarse) {
      :host ::ng-deep .pg-activo .p-inputtext, :host ::ng-deep .pg-activo .pg-nota-aviso .p-button { min-height: var(--tap-min); }
    }
    /* En el celular el botón se partía en tres renglones junto a la nota: va en una línea y, si no cabe, baja. */
    .pg-activo .pg-nota-aviso { flex-wrap: wrap; }
    .pg-activo .pg-nota-aviso > span { flex: 1 1 16rem; }
    :host ::ng-deep .pg-activo .pg-nota-aviso .p-button { white-space: nowrap; }
    @container (max-width: 40rem) {
      .pg-grid { grid-template-columns: minmax(0, 1fr); }
      .pg-renglon { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
      .pg-quitar { justify-self: end; }
      .pg-activo { margin-left: 0; }
      .pg-activo-grid { grid-template-columns: minmax(0, 1fr); }
    }
  `],
})
export class FinanzasPedirGastoComponent {
  private readonly api = inject(SolicitudGastoService);
  private readonly archivos = inject(ComprobacionesService);
  private readonly toast = inject(MessageService);
  /** El diálogo de confirmación vive en la raíz (`app.component`); su servicio es global. */
  private readonly confirmar = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly maxRenglones = MAX_RENGLONES;
  // [PGP.122.17] La compra de un activo (anexo S §20).
  readonly umbralActivo = UMBRAL_ACTIVO_POR_UNIDAD;
  readonly maxCantidad = MAX_CANTIDAD_ACTIVO;
  readonly largoDescripcion = LARGO_DESCRIPCION_ACTIVO;
  readonly tiposDeActivo = [{ label: 'Un bien nuevo', value: 'bien' }, { label: 'Reparación, refacción o consumible', value: 'gasto' }];
  /** `[PGP.122.13]` La lectura sólo propone una fecha de estos últimos días (`fechaLeidaProponible`): la pantalla lo dice. */
  readonly diasMaximosLectura = DIAS_MAXIMOS_COMPROBANTE;
  /** «Hoy» se refresca: la pantalla puede quedarse abierta de un día para otro (al volver a la pestaña y cada 5 min). */
  readonly hoyIso = signal(iso(new Date()) ?? '');
  readonly hoyDate = computed(() => deIso(this.hoyIso()) ?? new Date());
  readonly hoy = computed(() => this.hoyIso());
  /** Copia mutable: `p-selectbutton` pide un arreglo y el catálogo del contrato es `readonly` (TS4104). */
  readonly formasPago = [...FORMAS_PAGO];
  /** `[PGP.122.9]` Forma de pago y plazo como radiogroup (`app-segmented`): una opción de varias. */
  readonly formasPagoSeg: SegOption[] = FORMAS_PAGO.map((f) => ({ label: f.label, value: f.id }));
  readonly tiposDoc: SegOption[] = [
    { label: 'Ticket o nota', value: 'ticket' },
    { label: 'Factura', value: 'cfdi' },
    { label: 'Cotización (antes de gastar)', value: 'cotizacion' },
  ];

  /**
   * S.17 (DS27): las bases donde ESTA persona puede pedir hoy — las abiertas que son de sus almacenes. Las decide el
   * servidor (el mismo alcance de la bandeja del SAT, ADR-050), no la sesión: `null` = todavía no contesta.
   */
  readonly abiertas = signal<string[] | null>(null);
  /** Cómo se decidió (una, varias, todas, sin almacén en su ficha…): para decir por qué no hay ninguna. */
  readonly alcanceBase = signal<AlcanceDeLaBase | null>(null);
  readonly sucursales = computed(() => {
    const abiertas = this.abiertas() ?? [];
    return STORE_BRANCHES.filter((b) => abiertas.includes(b.code));
  });
  readonly opcionesBase = computed(() => this.sucursales().map((b) => ({ label: branchLabel(b.code), value: b.code })));
  readonly textoSinBase = computed(() => sinBaseTexto(this.alcanceBase()));
  /** Por qué la base está fija: sólo con UN almacén es «el tuyo»; con varias o todas, es la única abierta hoy. */
  readonly porQueUnaBase = computed(() => {
    const a = this.alcanceBase();
    return a === 'una' ? 'tu almacén' : a === 'varias' ? 'la única de tus almacenes abierta hoy' : 'la única base abierta hoy';
  });
  readonly sucursal = signal<string>('');
  readonly nombreSucursal = computed(() => branchLabel(this.sucursal()) || 'esta base');

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

  /**
   * `[PGP.122.14]` TODO el catálogo para el selector: primero lo que se puede pedir y al final, deshabilitado, lo que no,
   * cada uno con su motivo (activo fijo, SUA, impuestos, capital, sin cuenta o R14). Antes desaparecía sin decir por qué:
   * se buscaba el 364 «PC VERIFICADOR DE PRECIO» y no salía nada.
   */
  readonly opcionesConcepto = computed(() => {
    const todas = (this.catalogo()?.conceptos ?? []).map((c) => {
      const motivo = motivoParaNoOfrecer(c);
      return { ...c, etiqueta: `${c.nombre} · ${c.codigo}`, motivo, bloqueado: !!motivo };
    });
    return [...todas.filter((c) => !c.bloqueado), ...todas.filter((c) => c.bloqueado)];
  });
  /** Lo que SÍ se puede pedir. Lo que la pantalla propone sola (hábito, factura) sale sólo de aquí. */
  readonly conceptos = computed(() => this.opcionesConcepto().filter((c) => !c.bloqueado));
  /**
   * R14 (anexo S §16): conceptos que en el Kepler de esta sucursal van a OTRO rubro que en CEDIS (el 074 «Capitán de
   * marca» a caja y bancos). No se ofrecen —el servidor los rechaza—, pero se DICEN: esconderlos sin explicar dejaba a
   * la persona buscando un concepto que no aparece.
   */
  readonly conceptosBloqueados = computed(() => (this.catalogo()?.conceptos ?? []).filter((c) => !c.fuera_de_alcance && !!c.distinto_de_cedis));
  /** El concepto de siempre de este proveedor no se puede pedir aquí (R14, y desde PGP.122.14 cualquier motivo): se dice. */
  readonly habitoBloqueado = signal<string | null>(null);
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
  /** S.17 (DS30): el plazo elegido: '0' de contado, '7' / '15' / '30' días, u 'otra' fecha. */
  readonly plazoSel = signal<string>('0');
  readonly fechaOtra = signal<Date | null>(null);
  /** S.17 (DS31): la información de pago (cuenta y correo), opcional; nace cerrada salvo que el acreedor ya la traiga. */
  readonly pagoAbierto = signal(false);
  readonly pagoCuenta = signal('');
  readonly pagoBanco = signal('');
  readonly pagoCorreo = signal('');
  readonly duplicados = signal<DuplicadoProbable[]>([]);
  readonly duplicadosFallo = signal(false);
  readonly enviando = signal(false);
  readonly creada = signal<SolicitudGastoCreada | null>(null);
  /** Sube al mandar una solicitud: la bandeja del SAT se vuelve a leer (la factura registrada sale sola). */
  readonly bandejaVersion = signal(0);
  /**
   * De dónde salió cada dato (campo → fuente). Lo que la persona cambia pasa a «persona». Los del renglón van por
   * número (`concepto_1`, `importe_2`…) y `renglon_N` es lo que se guarda como origen del renglón.
   */
  private readonly fuentes = signal<Record<string, FuenteDelDato>>({});
  /** Una vez por solicitud: si el envío se repite (la respuesta se perdió), el servidor devuelve la misma. */
  private idCliente = nuevoId();

  readonly totales = computed(() => totalesDeLaSolicitud(this.renglones().map((r) => ({ importe: Number(r.importe ?? 0) })), this.iva()));

  // ── S.17 · El plazo (DS30) ─────────────────────────────────────────────────────────────────
  /** Copia mutable para `p-selectbutton` (el catálogo del contrato es `readonly`, TS4104). */
  readonly plazos = [...PLAZOS_DE_PAGO.map((d) => ({ id: String(d), label: d === 0 ? 'De contado' : `${d} días` })), { id: 'otra', label: 'Otra fecha' }];
  readonly plazosSeg: SegOption[] = this.plazos.map((p) => ({ label: p.label, value: p.id }));
  /** El plazo corre desde la fecha del documento (factura o ticket); una cotización todavía no se gasta: desde hoy. */
  private readonly desdePlazo = computed(() => (this.tipo() === 'cotizacion' ? null : iso(this.fechaDoc())));
  readonly pagoCalculado = computed(() => {
    const p = this.plazoSel();
    if (p === 'otra') return { fecha: iso(this.fechaOtra()), vencio: null, desde: 'hoy' as const, dias: null as number | null };
    const r = fechaDePago({ dias: Number(p), desde: this.desdePlazo(), hoy: this.hoy() });
    return { ...r, dias: Number(p) as number | null };
  });
  /** Lo que viaja como fecha de pago (`c18`): de contado no manda nada (Kepler pone la de solicitud, como hoy). */
  readonly necesitaParaIso = computed(() => (this.plazoSel() === '0' ? null : this.pagoCalculado().fecha));
  readonly textoPlazo = computed(() => {
    const c = this.pagoCalculado();
    return textoDelPlazo({ dias: c.dias, fecha: c.fecha, vencio: c.vencio, desde: c.desde, fechaLarga: (d) => this.fechaLarga(d) });
  });

  // ── S.17 · La información de pago (DS31) ───────────────────────────────────────────────────
  readonly cuentaLeida = computed(() => cuentaDePago(this.pagoCuenta()));
  readonly cuentaMal = computed(() => this.cuentaLeida()?.ok === false);
  readonly correoMal = computed(() => !!this.pagoCorreo().trim() && !correoValido(this.pagoCorreo()));
  readonly textoCuenta = computed(() => {
    const c = this.cuentaLeida();
    if (!c) return this.fuente('pago_cuenta') ?? 'CLABE de 18 dígitos, tarjeta de 16 o número de cuenta.';
    if (!c.ok) return c.motivo;
    const que = c.tipo === 'clabe' ? 'CLABE con su dígito de control correcto' : c.tipo === 'tarjeta' ? 'Tarjeta' : 'Cuenta';
    const f = this.fuente('pago_cuenta');
    return f ? `${que} · ${f}` : que;
  });
  /** Lo que se manda: sólo si el bloque está abierto y trae algo (vacío no se guarda). */
  readonly pagoDto = computed((): InformacionDePago | null => {
    if (!this.pagoAbierto()) return null;
    const p = { cuenta: this.pagoCuenta(), banco: this.pagoBanco(), correo: this.pagoCorreo() };
    return hayInformacionDePago(p) ? p : null;
  });
  /** Para la bandeja del SAT: con el proveedor elegido, muestra sus facturas (S.17, DS28). */
  readonly proveedorDeLaBandeja = computed((): ProveedorDeLaBandeja | null => {
    const a = this.acreedorSel();
    return a ? { clave: a.clave, nombre: a.nombre, rfc: a.rfc } : null;
  });
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

  // ── `[PGP.122.9]` Validación después de intentar, errores que se quedan escritos ─────────────────────
  /** Se intentó mandar con datos faltantes: desde aquí se marcan los campos y se muestra el resumen. */
  readonly intento = signal(false);
  /** El último rechazo al mandar (o «no se sabe si llegó»): visible hasta corregir o volver a mandar. */
  readonly errorEnvio = signal<string | null>(null);
  /** Archivo muy grande o que no se subió: junto al botón de subir, no en un aviso que se cierra solo. */
  readonly errorArchivo = signal<string | null>(null);
  /** El texto de la región de estado del archivo (siempre presente; sólo cambia de texto). */
  readonly estadoArchivo = computed(() => this.leyendo() ? 'Subiendo y leyendo el comprobante…' : this.archivo() ? this.estadoLectura() : '');
  /** Los ids de los campos que faltan, sólo después de intentar mandarlo. */
  private readonly marcados = computed((): ReadonlySet<string> => {
    if (!this.intento()) return new Set();
    const rs = this.renglones();
    const ids = new Set<string>();
    for (const f of this.faltan()) { const id = campoQueFalta([f], rs); if (id) ids.add(id); }
    rs.forEach((r, i) => {
      if (!r.concepto) ids.add(`pg-con-${i}`);
      if (!r.proyecto) ids.add(`pg-pro-${i}`);
      if (!r.departamento) ids.add(`pg-dep-${i}`);
      if (!(Number(r.importe ?? 0) > 0)) ids.add(`pg-imp-${i}`);
    });
    return ids;
  });
  mal(id: string): boolean { return this.marcados().has(id); }
  /** Desde el resumen: al campo de ESE faltante. */
  irAlCampo(f: FaltanteSolicitud): void {
    const destino = document.getElementById(campoQueFalta([f], this.renglones()) ?? 'pg-que');
    destino?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    destino?.focus({ preventScroll: true });
  }
  private enfocar(id: string): void {
    setTimeout(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
    }, 0);
  }

  /** La MISMA compuerta que el 400 del servidor (`faltaParaPedir`, del contrato). */
  readonly faltan = computed(() => faltaParaPedir({
    sucursal: this.sucursal(), acreedor: this.acreedorSel()?.clave ?? '',
    renglones: this.renglones().map((r) => ({ concepto: r.concepto ?? '', proyecto: r.proyecto ?? '', departamento: r.departamento ?? '', importe: Number(r.importe ?? 0),
      cuenta: this.catalogo()?.conceptos.find((c) => c.codigo === r.concepto)?.cuenta ?? null,
      activo: r.activo ? { tipo: r.activo.tipo, descripcion: r.activo.descripcion, cantidad: r.activo.cantidad, lugar: r.activo.lugar || null } : null })),
    iva: this.iva(), fecha_solicitud: this.hoy(),
    comprobante: { tipo: this.tipo(), folio: this.folioDoc() || null, fecha: iso(this.fechaDoc()), uuid: this.cfdiUuid() },
    forma_pago: this.formaPago(), forma_pago_detalle: this.detalle(),
    archivos: this.archivo() ? [{ role: this.rolDelArchivo(), live: this.archivo()!.live ?? null }] : [],
    motivo_fecha: this.motivoFecha(),
    pago: this.pagoDto(),
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
        this.alcanceBase.set(r.alcance ?? null);
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

  /** `[PGP.122.13]` Lo impreso en el comprobante, cuando la fecha la puso el lector (no la factura del SAT ni la persona). */
  readonly fechaImpresaPropuesta = computed(() => (this.fuentes()['fecha'] === 'ticket' ? this.lectura()?.leido?.fecha_impresa ?? null : null));
  /**
   * `[PGP.122.13]` El lector vio algo en la fecha y el servidor no lo propuso —no se pudo leer completa, era futura o de
   * hace más de 30 días, como un año mal leído— y la persona aún no escribe ninguna. Dice «se leyó», no «el comprobante
   * dice»: la lectura puede estar mal, y fue justo lo que pasó con las dos primeras usuarias.
   */
  readonly fechaImpresaSinUsar = computed(() => {
    const l = this.lectura()?.leido;
    return l && !l.fecha && l.fecha_impresa && !this.fechaDoc() ? l.fecha_impresa : null;
  });

  origenRenglon(i: number): string | null {
    return origenDelRenglon(this.fuentes(), i + 1);
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

  /** «lun 1 dic»: la fecha de pago, como la lee la gente. */
  fechaLarga(isoFecha: string): string {
    const d = deIso(isoFecha);
    return d ? d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }) : isoFecha;
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
    this.errorArchivo.set(null);
    if (f.size > MAX_ARCHIVO_GASTO_BYTES) {
      this.errorArchivo.set(`El archivo es muy grande: el máximo es ${MAX_ARCHIVO_GASTO_MB} MB.`);
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
      error: (e) => { this.leyendo.set(false); this.errorArchivo.set(`No se subió el archivo: ${e?.error?.message || 'intenta de nuevo'}.`); },
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

  /**
   * S.17 (DS28) — El proveedor elegido desde sus facturas del SAT sin gasto: queda en «Proveedor» (de la factura del SAT)
   * y la bandeja muestra sus facturas para usar una.
   */
  elegirDesdeFactura(p: ProveedorDeLaBandeja): void {
    if (this.enviando()) return;
    this.elegirAcreedor({ clave: p.clave, nombre: p.nombre, rfc: p.rfc, usos: 0 });
    this.poner('acreedor', 'cfdi');
  }

  /**
   * S.17 (DS29) — «Usar esta factura»: el COMPROBANTE se llena con ella (el UUID ya verificado, folio, fecha, IVA del
   * CFDI y el renglón = total − IVA, que cuadra al centavo). El proveedor y lo que puso su hábito (concepto, área, forma
   * de pago, plazo) se quedan: elegir al proveedor y luego su factura es el camino normal. Sólo se pregunta si reemplaza
   * un comprobante ya capturado (foto, folio u otra factura), con el foco en «No».
   */
  usarFactura(f: FacturaPorRegistrar): void {
    if (this.enviando()) return;
    const a = f.acreedores.find((x) => x.en_la_sucursal && x.registrable);
    if (!a) {
      this.toast.add({ severity: 'warn', summary: 'No se puede usar en esta base', life: 8000,
        detail: f.acreedores.find((x) => x.en_la_sucursal)?.por_que_no
          ?? `${f.emisor_nombre || f.emisor_rfc} no está en el catálogo de Kepler de ${this.nombreSucursal()}: pídele a Finanzas que lo dé de alta.` });
      return;
    }
    const reemplaza = loQueReemplaza({ archivo: this.archivo(), folio: this.folioDoc(), uuid: this.cfdiUuid(), fuentes: this.fuentes() }, f.uuid);
    if (!reemplaza.length) { this.llenarConFactura(f, a); return; }
    this.confirmar.confirm({
      header: 'Ya hay un comprobante capturado',
      message: `Usar la factura ${f.serie_folio || 'sin folio'} (${this.dinero(f.total)}) reemplaza ${enLista(reemplaza)}. El proveedor y lo demás se quedan. ¿Sigues?`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, usar la factura', rejectLabel: 'No, dejo el mío',
      // H7: el foco nace en «No» y «Sí» no lleva el color de acción: un Enter distraído no reemplaza lo capturado.
      defaultFocus: 'reject',
      acceptButtonStyleClass: 'p-button-sm p-button-secondary p-button-outlined', rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => this.llenarConFactura(f, a),
    });
  }

  private llenarConFactura(f: FacturaPorRegistrar, a: FacturaPorRegistrar['acreedores'][number]): void {
    // Sólo lo del comprobante; quien eligió reemplazarlo ya no es «lo escribiste tú» para el importe y el IVA.
    this.archivo.set(null); this.lectura.set(null); this.cfdiPropuesto.set(null); this.avisoCfdi.set(null); this.motivoFecha.set('');
    this.fuentes.update((m) => Object.fromEntries(Object.entries(m).filter(([k, v]) => !(v === 'persona' && ['importe_1', 'iva', 'folio', 'fecha'].includes(k)))) as Record<string, FuenteDelDato>);
    this.tipo.set('cfdi');
    this.poner('tipo', 'cfdi');
    this.cfdiUuid.set(f.uuid);
    this.folioDoc.set(f.serie_folio ?? '');
    if (f.serie_folio) this.poner('folio', 'cfdi');
    this.fechaDoc.set(deIso(f.fecha));
    this.poner('fecha', 'cfdi');
    if (f.iva !== null) {
      // El IVA del CFDI y el renglón = total − IVA (el IEPS, si lo hay, va en el renglón): cuadra al centavo.
      const iva = Math.round(Number(f.iva) * 100) / 100;
      this.iva.set(iva);
      this.poner('iva', 'cfdi');
      this.llenarImporte(Math.round((Number(f.total) - iva) * 100) / 100, 'cfdi');
    }
    const otro = this.acreedorSel()?.clave !== a.clave;
    if (otro) {
      // Desde la factura de otro proveedor (o sin proveedor): el de la factura, con su hábito; el foco espera al hábito.
      this.elegirAcreedor({ clave: a.clave, nombre: a.nombre || f.emisor_nombre || a.clave, rfc: f.emisor_rfc, usos: 0 }, () => this.enfocarLoQueFalta());
      this.poner('acreedor', 'cfdi');
    } else {
      this.enfocarLoQueFalta();
    }
    this.toast.add({ severity: 'info', summary: 'Factura del SAT en la solicitud',
      detail: f.iva === null
        ? `${f.serie_folio || 'Sin folio'} · ${this.dinero(f.total)}: el SAT no trae su IVA desglosado; captura el importe y el IVA.`
        : `${f.serie_folio || 'Sin folio'} · ${this.dinero(f.total)}: revisa el concepto y el área, y mándala a firma.` });
  }

  /**
   * El foco al primer dato que falta, en el orden de la pantalla. Si no falta nada, a «Qué es y cuánto»: el concepto
   * y el área los puso el hábito y son lo que la persona revisa. El siguiente Tab ya no regresa a la bandeja.
   */
  private enfocarLoQueFalta(): void {
    setTimeout(() => {
      const destino = document.getElementById(campoQueFalta(this.faltan(), this.renglones()) ?? 'pg-que');
      destino?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      destino?.focus({ preventScroll: true });
    }, 0);
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

  /** `alLlegar`: lo que sigue cuando el hábito ya llenó lo suyo (o no pudo); no corre si en tanto se eligió otro. */
  elegirAcreedor(a: AcreedorDeGasto, alLlegar?: () => void): void {
    this.acreedorSel.set(a);
    this.marcar('acreedor');
    // Lo que puso el hábito del acreedor ANTERIOR ya no aplica.
    this.limpiarHabito();
    this.api.precarga(this.sucursal(), a.clave).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => { if (this.acreedorSel()?.clave === a.clave) alLlegar?.(); },
      next: (p) => {
        if (this.acreedorSel()?.clave !== a.clave) return;
        const yo = this.fuentes();
        const rs = this.renglones();
        // Sólo códigos que el catálogo ofrece: uno que ya no tiene cuenta dejaría un valor invisible en el select.
        const ofrecido = (lista: Array<{ codigo: string }>, cod: string | null | undefined) => (cod && lista.some((x) => x.codigo === cod) ? cod : null);
        if (rs.length === 1) {
          const r0 = { ...rs[0] };
          let puso = false;
          const propuesto = p.ultimo?.concepto ?? p.conceptos[0]?.codigo;
          // [PGP.122.14] El concepto de siempre de este proveedor que no se puede pedir aquí (R14, activo fijo, sin cuenta…)
          // se dice con su motivo, en vez de dejar el campo vacío sin razón.
          this.habitoBloqueado.set(this.opcionesConcepto().find((c) => c.codigo === propuesto && c.bloqueado)?.motivo ?? null);
          const concepto = ofrecido(this.conceptos(), propuesto);
          if (yo['concepto_1'] !== 'persona' && concepto) {
            r0.concepto = concepto;
            // [PGP.122.17] El de siempre puede ser de activo: su bloque nace igual que al elegirlo a mano (cuántos = 1).
            r0.activo = esCuentaDeActivo(this.cuentaDe(concepto)) ? (r0.activo ?? { ...ACTIVO_VACIO }) : null;
            this.poner('concepto_1', 'habito'); puso = true;
          }
          const proyecto = ofrecido(this.proyectos(), p.ultimo?.proyecto);
          if (yo['proyecto_1'] !== 'persona' && proyecto) { r0.proyecto = proyecto; this.poner('proyecto_1', 'habito'); puso = true; }
          const depto = ofrecido(this.departamentos(), p.ultimo?.departamento);
          if (yo['departamento_1'] !== 'persona' && depto) { r0.departamento = depto; this.poner('departamento_1', 'habito'); puso = true; }
          this.renglones.set([r0]);
          if (puso && !yo['renglon_1']) this.poner('renglon_1', 'habito');
        }
        if (yo['forma_pago'] !== 'persona' && p.forma_pago) { this.formaPago.set(p.forma_pago); this.poner('forma_pago', 'habito'); }
        // S.17 (DS30): el plazo de Kepler (días de crédito) o el de su última solicitud; uno que no está a un toque, como fecha.
        if (yo['plazo'] !== 'persona' && p.plazo) {
          const d = p.plazo.dias;
          if (PLAZOS_DE_PAGO.includes(d)) this.plazoSel.set(String(d));
          else { this.plazoSel.set('otra'); this.fechaOtra.set(deIso(fechaDePago({ dias: d, desde: this.desdePlazo(), hoy: this.hoy() }).fecha)); }
          this.poner('plazo', p.plazo.fuente);
        }
        // S.17 (DS31): la información de pago que ya se conoce nace abierta, cada dato con su origen.
        if (p.pago && yo['pago'] !== 'persona') {
          let puso = false;
          if (yo['pago_cuenta'] !== 'persona' && p.pago.cuenta) { this.pagoCuenta.set(p.pago.cuenta); this.poner('pago_cuenta', p.pago.fuente_cuenta ?? 'habito'); puso = true; }
          if (yo['pago_banco'] !== 'persona' && p.pago.banco) { this.pagoBanco.set(p.pago.banco); this.poner('pago_banco', p.pago.fuente_cuenta ?? 'habito'); puso = true; }
          if (yo['pago_correo'] !== 'persona' && p.pago.correo) { this.pagoCorreo.set(p.pago.correo); this.poner('pago_correo', p.pago.fuente_correo ?? 'habito'); puso = true; }
          if (puso) this.pagoAbierto.set(true);
        }
        alLlegar?.();
      },
    });
  }

  /** Quita lo que llenó el hábito o el catálogo (es del acreedor anterior): vuelve a quedar vacío y sin rótulo. */
  private limpiarHabito(): void {
    this.habitoBloqueado.set(null);
    const yo = this.fuentes();
    const delAnterior = (campo: string) => yo[campo] === 'habito' || yo[campo] === 'catalogo';
    const rs = this.renglones();
    if (rs.length) {
      const r0 = { ...rs[0] };
      for (const k of ['concepto', 'proyecto', 'departamento'] as const) if (yo[`${k}_1`] === 'habito') r0[k] = null;
      this.renglones.set([r0, ...rs.slice(1)]);
    }
    if (yo['forma_pago'] === 'habito') this.formaPago.set('');
    if (delAnterior('plazo')) { this.plazoSel.set('0'); this.fechaOtra.set(null); }
    if (delAnterior('pago_cuenta')) this.pagoCuenta.set('');
    if (delAnterior('pago_banco')) this.pagoBanco.set('');
    if (delAnterior('pago_correo')) this.pagoCorreo.set('');
    if (['pago_cuenta', 'pago_banco', 'pago_correo'].some(delAnterior) && !this.pagoCuenta() && !this.pagoBanco() && !this.pagoCorreo()) this.pagoAbierto.set(false);
    this.fuentes.update((m) => Object.fromEntries(Object.entries(m).filter(([, f]) => f !== 'habito' && f !== 'catalogo')) as Record<string, FuenteDelDato>);
  }

  // ── S.17 · El plazo y la información de pago ───────────────────────────────────────────────
  elegirPlazo(v: string): void {
    this.plazoSel.set(v);
    this.marcar('plazo');
    if (v === 'otra') setTimeout(() => document.getElementById('pg-fecha-pago')?.focus(), 0);
  }

  abrirPago(): void {
    this.pagoAbierto.set(true);
    setTimeout(() => document.getElementById('pg-cuenta')?.focus(), 0);
  }

  /** «Quitar»: se vacía y no vuelve sola con el siguiente hábito (la persona decidió que no va). */
  quitarPago(): void {
    this.pagoCuenta.set(''); this.pagoBanco.set(''); this.pagoCorreo.set('');
    this.pagoAbierto.set(false);
    this.fuentes.update((m) => ({ ...Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('pago_'))), pago: 'persona' }) as Record<string, FuenteDelDato>);
    setTimeout(() => document.querySelector<HTMLElement>('.pg-mas-pago button')?.focus(), 0);
  }

  // ── Renglones ──────────────────────────────────────────────────────────────────────────────────
  cambiarRenglon(i: number, campo: keyof RenglonEnCaptura, v: string | number | null): void {
    this.renglones.update((rs) => rs.map((r, j) => {
      if (j !== i) return r;
      const nuevo: RenglonEnCaptura = { ...r, [campo]: v };
      // [PGP.122.17] Con un concepto de activo nace su bloque (cuántos = 1); con otro, se va.
      if (campo === 'concepto') nuevo.activo = esCuentaDeActivo(this.cuentaDe(v as string | null)) ? (r.activo ?? { ...ACTIVO_VACIO }) : null;
      return nuevo;
    }));
    this.marcar(`renglon_${i + 1}`);
    this.marcar(`${campo}_${i + 1}`);
  }

  /** `[PGP.122.17]` La cuenta de un concepto en el catálogo de la base. */
  private cuentaDe(codigo: string | null | undefined): string | null {
    return codigo ? this.catalogo()?.conceptos.find((c) => c.codigo === codigo)?.cuenta ?? null : null;
  }
  /** ¿El renglón es de activo (cuenta 150)? Entonces abre «Compra de activo» (DS47). */
  esActivo(i: number): boolean { return esCuentaDeActivo(this.cuentaDe(this.renglones()[i]?.concepto)); }
  /** El grupo de Kepler del concepto y su vida fiscal; sin grupo, se dice (DS54). */
  grupoTexto(i: number): string {
    const g = this.catalogo()?.conceptos.find((c) => c.codigo === this.renglones()[i]?.concepto)?.activo;
    if (!g?.grupo) return 'Grupo: Contabilidad aún no lo define en Kepler, así que todavía no tiene vida fiscal.';
    const nombre = (g.nombre ?? g.grupo).toLowerCase().replace(/^./, (x) => x.toUpperCase());
    return g.vida_meses ? `Grupo: ${nombre} · vida fiscal ${g.vida_meses} meses (${g.tasa} % al año), de Kepler.` : `Grupo: ${nombre} · no se deprecia, de Kepler.`;
  }
  /** El importe por unidad (sin IVA), para la regla de los $5,000 (DS53). */
  porUnidad(i: number): number | null {
    const r = this.renglones()[i];
    return Number(r?.importe ?? 0) > 0 ? importePorUnidad(r?.importe ?? null, r?.activo?.cantidad ?? null) : null;
  }
  cambiarActivo(i: number, campo: keyof ActivoEnCaptura, v: unknown): void {
    this.renglones.update((rs) => rs.map((r, j) => (j === i ? { ...r, activo: { ...(r.activo ?? ACTIVO_VACIO), [campo]: v } } : r)));
    this.marcar(`activo_${i + 1}`);
  }
  /** «Es una reparación, refacción o consumible»: se quita el concepto de activo y el foco va a elegir uno de gasto. */
  cambiarConceptoAGasto(i: number): void {
    this.renglones.update((rs) => rs.map((r, j) => (j === i ? { ...r, concepto: null, activo: null } : r)));
    this.enfocar(`pg-con-${i}`);
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
    if (this.enviando()) return;
    if (this.faltan().length) {
      // [PGP.122.9] El botón no se bloquea: se marca lo que falta y el foco va al resumen, que lleva a cada campo.
      this.intento.set(true);
      this.enfocar('pg-faltan');
      return;
    }
    this.errorEnvio.set(null);
    this.enviando.set(true);
    const a = this.archivo();
    this.api.crear({
      id_cliente: this.idCliente,
      sucursal: this.sucursal(), acreedor: this.acreedorSel()!.clave,
      renglones: this.renglones().map((r) => ({ concepto: r.concepto ?? '', proyecto: r.proyecto ?? '', departamento: r.departamento ?? '', importe: Number(r.importe ?? 0),
        // [PGP.122.17] Sólo en el renglón de activo; el servidor lo vuelve a validar con la cuenta del catálogo.
        ...(esCuentaDeActivo(this.cuentaDe(r.concepto)) && r.activo
          ? { activo: { tipo: r.activo.tipo, descripcion: r.activo.descripcion, cantidad: r.activo.cantidad, lugar: r.activo.lugar || null } } : {}) })),
      iva: this.iva(),
      comprobante: { tipo: this.tipo(), folio: this.folioDoc() || null, fecha: iso(this.fechaDoc()), uuid: this.cfdiUuid() },
      forma_pago: this.formaPago(), forma_pago_detalle: this.detalle() || null,
      files: a ? [{ ...a, role: this.rolDelArchivo() }] : [], comentario: this.nota() || null,
      periodo_del: iso(this.periodoDel()), periodo_al: iso(this.periodoAl()), unidad: this.unidad() || null,
      necesita_para: this.necesitaParaIso(), motivo_fecha: this.motivoFecha() || null, pago: this.pagoDto(), fuentes: this.fuentes(),
      // [PGP.122.13] Lo que propuso el lector, para medir cuánto lo corrige la gente (no decide nada).
      lectura: lecturaParaGuardar(this.lectura()?.leido ?? null),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => {
        this.enviando.set(false);
        this.creada.set(c);
        this.reiniciar(false);
        this.bandejaVersion.update((v) => v + 1);
        this.enfocar('pg-hecho');
      },
      error: (e) => {
        this.enviando.set(false);
        const status = Number(e?.status ?? 0);
        if (status === 0 || status >= 500) {
          // No se sabe si llegó. Mandarla otra vez es seguro: lleva el mismo identificador y no se duplica.
          this.errorEnvio.set('No se sabe si llegó. Revisa Mis gastos o vuelve a mandarla: si ya había llegado, no se duplica.');
        } else {
          this.errorEnvio.set(`No se mandó: ${e?.error?.message || 'intenta de nuevo'}.`);
        }
      },
    });
  }

  private reiniciar(borrarCreada = true): void {
    this.archivo.set(null); this.lectura.set(null); this.folioDoc.set(''); this.fechaDoc.set(null); this.cfdiUuid.set(null); this.motivoFecha.set('');
    this.cfdiPropuesto.set(null); this.avisoCfdi.set(null); this.buscarFallo.set(false);
    this.acreedorSel.set(null); this.renglones.set([{ concepto: null, proyecto: null, departamento: null, importe: null }]); this.iva.set(0);
    this.formaPago.set(''); this.detalle.set(''); this.periodoDel.set(null); this.periodoAl.set(null); this.unidad.set(''); this.nota.set('');
    this.plazoSel.set('0'); this.fechaOtra.set(null);
    this.pagoAbierto.set(false); this.pagoCuenta.set(''); this.pagoBanco.set(''); this.pagoCorreo.set('');
    this.duplicados.set([]); this.duplicadosFallo.set(false); this.fuentes.set({}); this.tipo.set('ticket');
    this.intento.set(false); this.errorEnvio.set(null); this.errorArchivo.set(null);
    this.idCliente = nuevoId();
    if (borrarCreada) this.creada.set(null);
  }
}
