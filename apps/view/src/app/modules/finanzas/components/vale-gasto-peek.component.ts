import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { branchLabel } from '../../../core/constants/store-branches';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { VisorEvidenciaComponent, type DocEvidencia } from './visor-evidencia.component';
import { parseLocalDate } from '../../../core/utils/mx-date';
import {
  CLASIFICACION_LABEL, type DepartamentoDelVale, type ExpenseClasificacion, type ProofFile, type ValeGasto,
} from '../comprobaciones.service';
import { aceptaEvidenciaAdicional, detallesParaMostrar, esEvidenciaAdicional } from '@megadulces/contracts';

/** Qué se puede hacer con el vale desde acá. Lo decide la PÁGINA, no este visor. */
export type AccionVale = 'aprobar' | 'comprobar' | 'rechazar' | 'pedir_reapertura'
  /** `[GX.87]` Sumar evidencia con su porqué. NO es una decisión: no va al pie ni lo mueve. */
  | 'agregar_evidencia';

/**
 * `[GX.30]` Lo que viaja al aprobar. **No es sólo el vale**: quien firma puede decir que
 * lo que está viendo es una prefactura o una cotización y no el comprobante definitivo.
 *
 * (!) Sin fecha esperada la deuda no envejece y nadie la reclama nunca: el servidor la
 * pone a 15 días cuando se marca sin fecha. Se decide allá, no acá, para que valga igual
 * si la aprobación entra por otra vía.
 */
export interface AprobacionVale {
  vale: ValeGasto;
  provisional: boolean;
  comprobante_esperado_at: string | null;
}

const FORMA_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia',
  cheque: 'Cheque', vales: 'Vales', otro: 'Otro',
};

/** Cómo se llama cada estado en voz alta. La clave cruda es cómo se guarda, no cómo se dice. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma',
  aprobada: 'Aprobado · falta ejercer',
  revision: 'Falta revisarla',
  validada: 'Comprobado',
  rechazada: 'Rechazado',
};

/** Cómo se llama cada adjunto. La clave (`comprobante_1`) es el rol, no el nombre. */
const ARCHIVO_LABEL: Record<string, string> = {
  comprobante_1: 'Comprobante — hoja 1', comprobante_2: 'Comprobante — hoja 2',
  solicitud_kepler: 'Solicitud de gasto firmada', cotizacion: 'Cotización',
  evidencia_1: 'Evidencia 1', evidencia_2: 'Evidencia 2', evidencia_3: 'Evidencia 3',
  adicional: 'Evidencia adicional',
};

/**
 * Un adjunto listo para pintar.
 *
 * ⚠️ `safeUrl` se sanitiza **una vez**. Hacerlo en el template recrearía el `iframe` en cada
 * ciclo de detección — o sea que el PDF se recargaría solo, sin parar.
 */
type DocDelExpediente = DocEvidencia;

/**
 * `[GX.27]` — **El vale de gasto, completo.** Panel lateral compartido.
 *
 * Nació dentro de la pantalla de Aprobación (`[GX.20.10]`) y se extrajo acá en cuanto el
 * **Historial** necesitó lo mismo: un visor duplicado son dos sitios donde arreglar el mismo
 * error, y dos sitios que pueden empezar a mostrar cosas distintas del mismo expediente.
 *
 * ## ⛔ El visor no decide ni pide nada
 * No llama al servidor y no sabe qué se puede hacer con el vale: recibe el expediente ya
 * cargado y la lista de acciones permitidas, y **emite**. Quien manda es la página — que es
 * la que conoce el permiso de quien mira. Así el Historial lo usa de sólo lectura sin tener
 * que apagar botones uno por uno.
 *
 * ## ⚠️ «No vino el dato» no es «no hay dato»
 * `created_hora` y `concepto` llegan `undefined` desde los endpoints que no los seleccionan.
 * En ese caso **se omiten**, no se pintan como «—»: un guion afirma que el expediente no lo
 * tiene, y eso sería falso.
 */
@Component({
  selector: 'app-vale-gasto-peek',
  standalone: true,
  imports: [CommonModule, ButtonModule, SidePeekComponent, VisorEvidenciaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <!-- ── El vale, completo ──────────────────────────────────────────────────── -->
  <!-- 820px: adentro va el comprobante, y un documento financiero no se lee en un
       overlay apretado (DESIGN.md O.1). [GX.99] 1120px: el usuario pidió la evidencia completa
       abajo «o la pantalla de vista más grande»; más ancho, los datos van en tres columnas y ocupan
       menos alto. En pantallas chicas el panel no pasa del ancho de la ventana. -->
  <app-side-peek [open]="open()" (openChange)="open.set($event)" [width]="1120"
                 title="Vale de gasto" [subtitle]="subtituloPeek()">
    @if (vale(); as p) {
      <div class="vp">
        <div class="vp-top">
          <div>
            <div class="vp-imp">{{ money(p.importe) }}</div>
            <div class="vp-prov">{{ p.proveedor || '—' }}</div>
          </div>
          <span class="ap-chip" [class.ok]="p.status === 'validada'"
                [class.warn]="p.status === 'revision'" [class.bad]="p.status === 'rechazada'">
            {{ estado(p.status) }}
          </span>
        </div>

        @if (p.concepto) { <p class="vp-con">{{ p.concepto }}</p> }

        <dl class="vp-datos">
          <div><dt>Folio</dt><dd class="vp-mono">{{ p.folio_solicitud || 'sin folio' }}</dd></div>
          <div><dt>Sucursal</dt><dd>{{ branchLabel(p.sucursal) || '—' }}</dd></div>
          <!-- [GX.98] El departamento de Kepler, con la parte de cada uno si está repartido. El
               capturado («Sucursal NN») no es un departamento. -->
          <div><dt>{{ (p.departamentos?.length ?? 0) > 1 ? 'Departamentos' : 'Departamento' }}</dt><dd>
            @if (p.departamentos === undefined) { {{ p.solicitante || 'sin medir' }} }
            @else if (p.departamentos === null) { sin leer en Kepler }
            @else if (!p.departamentos.length) { sin departamento en Kepler }
            @else if (p.departamentos.length === 1) { {{ nombreDep(p.departamentos[0]) }} }
            @else {
              <ul class="vp-deps">
                @for (x of p.departamentos; track x.clave) { <li>{{ nombreDep(x) }} <span class="vp-mono">{{ money(x.importe) }}</span></li> }
              </ul>
            }
          </dd></div>
          <div><dt>Levantado</dt><dd>{{ diaLocal(p.created_at) | date: 'dd/MM/yy' }}@if (p.created_hora) { {{ p.created_hora }} } · {{ p.created_by || '—' }}</dd></div>
          <!-- Las dos fechas, siempre: el gasto puede ser de otro día que el levantamiento. -->
          <div><dt>Fecha del gasto</dt><dd>{{ p.fecha_gasto ? (diaLocal(p.fecha_gasto) | date: 'dd/MM/yy') : 'no declarada' }}</dd></div>
          @if (p.clasificacion !== undefined) {
                <div><dt>Tipo</dt><dd>{{ p.clasificacion ? tipoGasto(p.clasificacion) : 'sin clasificar' }}</dd></div>
              }
          @if (p.forma_pago !== undefined) {
                <div><dt>Pago</dt><dd>{{ p.forma_pago ? formaPago(p.forma_pago) : 'sin forma de pago' }}@if (p.forma_pago_detalle) { · {{ detallePago(p.forma_pago_detalle) }} }</dd></div>
              }
          @if (p.validated_by) { <div><dt>Cerrado por</dt><dd>{{ p.validated_by }}</dd></div> }
        </dl>

        @if (p.comentarios) { <p class="vp-nota">“{{ p.comentarios }}”</p> }
        @if (p.revision_nota) { <p class="vp-nota warn">{{ p.revision_nota }}</p> }
        @if (p.motivo_rechazo) { <p class="vp-nota bad">Rechazado: {{ p.motivo_rechazo }}</p> }

        <!--
          [GX.48] La CONSTANCIA de autorizacion de Kepler. Va ANTES de la evidencia porque es
          el permiso, no el comprobante: primero por que se pudo gastar, despues en que.

          Kepler NO genera ningun documento al autorizar -- se midio de cinco formas (ver
          ejercicio.contract.ts). Esto se GENERA con lo que Kepler si tiene, y por eso el
          bloque declara que NO consta. Se deriva: si alla cancelan el vale, desaparece sola.
        -->
        @if (p.autorizacion_kepler; as a) {
          <h3 class="vp-h">Autorización de gasto — Kepler</h3>
          <div class="vp-aut">
            <div class="vp-aut-h">
              <span class="vp-aut-doc mono">{{ a.documento }}</span>
              <span class="vp-aut-ok">{{ a.autorizado_label }}</span>
            </div>
            <dl class="vp-dl">
              <div><dt>Monto</dt><dd>{{ money(a.monto) }}</dd></div>
              <div><dt>Fecha del documento</dt><dd>{{ a.fecha_documento || 'no declarada' }}</dd></div>
              <div><dt>Destinatario</dt><dd>{{ a.destinatario || 'no declarado' }}</dd></div>
              <div><dt>Concepto</dt><dd>{{ a.concepto || 'no declarado' }}</dd></div>
              <div><dt>Área que autoriza</dt><dd>{{ a.area_autoriza || 'no declarada' }}</dd></div>
            </dl>
            <!--
              Lo que Kepler NO registra, dicho. Sin esto la constancia se lee como completa y
              alguien podria citarla como prueba de quien autorizo y cuando.
            -->
            @if (a.no_consta.length) {
              <p class="vp-aut-falta">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Kepler no registra: {{ a.no_consta.join(' · ') }}.
              </p>
            }
          </div>
        }

        <!-- ── Los papeles ──────────────────────────────────────────────────── -->
        <div class="vp-h-row">
          <h3 class="vp-h">Evidencia</h3>
          <!-- [GX.87] Sumar lo que llegó después, con su porqué. Lo ofrece la página (dueño o
               quien aprueba) y nunca en un vale rechazado: ése se vuelve a capturar. -->
          @if (puedeAgregarEvidencia()) {
            <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="ocupado()"
                    (click)="agregarEvidencia.emit(p)">
              <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
              <span class="p-button-label">Agregar evidencia</span></button>
          }
        </div>
        @if (!docs().length) {
          <!-- «No hay archivos» y «no los puedo mostrar» son dos cosas distintas. -->
          <div class="vp-sin">
            <i class="pi pi-file-excel" aria-hidden="true"></i>
            <span>Este vale no trae ningún archivo adjunto.</span>
          </div>
        } @else {
          <!-- [GX.99] Cada archivo ENTERO y sin scroll (pedido del usuario: «la vista completa pero sin
               que haga scroll»). Antes iba a lo ancho, uno debajo de otro, y el PDF con su propio
               scroll. Ahora van lado a lado, cada uno ajustado a su recuadro; tocarlo abre el visor
               grande para acercar y pasar de uno a otro. -->
          <div class="vp-minis">
            @for (d of docs(); track d.url; let i = $index) {
              <button type="button" class="vp-mini" (click)="verEvidencia(i)" [attr.aria-label]="'Ver ' + d.label + ' en grande'">
                <span class="vp-mini-img">
                  @if (d.isPdf) {
                    <!-- La página entera, ajustada y sin barras. El iframe no recibe el clic: lo recibe el botón. -->
                    <iframe [src]="d.safeUrlVista" [title]="d.label" tabindex="-1" aria-hidden="true" loading="lazy"></iframe>
                  }
                  @else if (d.esOtro || fallidos().has(d.url)) { <i class="pi pi-file" aria-hidden="true"></i> }
                  @else { <img [src]="d.url" alt="" loading="lazy" (error)="fallo(d.url)" /> }
                  <span class="vp-mini-ver"><i class="pi pi-window-maximize" aria-hidden="true"></i></span>
                </span>
                <span class="vp-mini-t">{{ d.label }}</span>
                <!-- Que la imagen no cargue NO es que no exista: se dice cuál de las dos. -->
                @if (fallidos().has(d.url)) { <span class="vp-fallo">No se pudo mostrar el archivo. Ábrelo en grande o aparte.</span> }
                @if (d.nota) { <span class="vp-doc-nota">{{ d.nota }}</span> }
              </button>
            }
          </div>
          <p class="vp-mini-ayuda">Toca un archivo para verlo en grande, acercarlo y pasar al siguiente.</p>
        }
        <app-visor-evidencia [(open)]="visorAbierto" [(indice)]="visorIndice" [docs]="docs()"
                             [titulo]="(p.folio_solicitud || 'sin folio') + ' · ' + money(p.importe)" />

        <!-- ── La decisión, al pie del documento ───────────────────────────── -->
        <!-- [GX.30] La marca provisional viaja DENTRO del pie pegajoso, con los botones.
             Medido en pantalla: puesta antes del pie se iba con el scroll mientras los
             botones se quedaban, o sea que quien firma veía «Aprobar» y no veía la marca
             — un control que no está a la vista en el momento de decidir no existe. -->
        <div class="vp-pie">
        @if (acciones().includes('aprobar')) {
          <label class="vp-prov-chk">
            <input type="checkbox" [checked]="provisional()" (change)="marcarProvisional($event)" />
            <span>Esto es una <strong>prefactura o cotización</strong>, todavía falta el comprobante</span>
          </label>
          <!--
            [GX.51] Aca vivia «Se espera el comprobante para» con su fecha y el default de 15
            dias. Se retiro por pedido del usuario: la factura del pago llega cuando llega, y
            ponerle vencimiento a algo que no depende de nadie de la casa era inventar un plazo.

            ⚠️ Lo que la fecha cuidaba —que la deuda no se olvide— NO se pierde: se sigue
            sabiendo cuanto lleva esperando, contado desde que se aprobo (validated_at). Lo
            que se deja de afirmar es CUANDO vence, que es lo que nadie podia saber.
          -->
          @if (provisional()) {
            <p class="vp-prov-libre">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Queda abierto sin fecha límite: el comprobante se sube cuando llegue la factura.
            </p>
          }
        }

        @if (decisiones().length) {
          <div class="vp-act">
            @if (p.status === 'aprobada' && p.requiere_evidencia && !p.tiene_evidencia) {
              <!-- La evidencia la sube quien capturó, no quien firma. Decirlo evita que
                   el aprobador busque un botón que no le toca. -->
              <span class="ap-faint">la evidencia la sube quien lo levantó</span>
            }
            <span class="ap-grow"></span>
            @if (acciones().includes('pedir_reapertura')) {
              <!-- [GX.29] El capturista no reabre: PIDE. Quien decide es quien firmó. -->
              <button pButton type="button" class="p-button-outlined" [loading]="ocupado()"
                      (click)="pedirReapertura.emit(p)">Pedir que lo reabran</button>
            } @else {
              <button pButton type="button" class="p-button-text" [disabled]="ocupado()"
                      (click)="rechazar.emit(p)">Rechazar</button>
              @if (acciones().includes('aprobar')) {
                <!--
                  [GX.58] «Aprobar» pasó a decir «Revisado» (pedido del usuario, 2026-10-01).
                  ⚠️ Cambia la PALABRA del botón, no lo que hace: sigue llamando a la misma
                  acción y el vale sigue quedando en estado aprobada. Los rótulos de estado
                  («Aprobado · falta ejercer») y el aviso de éxito son otro texto, y se
                  declaran aparte en vez de tocarlos de arrastre.
                -->
                <button pButton type="button" [loading]="ocupado()" (click)="emitirAprobacion(p)">
                  {{ provisional() ? 'Revisado como provisional' : 'Revisado' }}
                </button>
              } @else {
                <button pButton type="button" class="p-button-outlined" [loading]="ocupado()"
                        (click)="comprobar.emit(p)">Dar por comprobado</button>
              }
            }
          </div>
        } @else {
          <p class="ap-faint vp-cerrado">Este vale ya se resolvió: no hay nada que decidir.</p>
        }
        </div>
      </div>
    }
  </app-side-peek>
  `,
  styles: [`
  /* [GX.51] La nota de «queda abierto», donde estaba la fecha limite. */
  .vp-prov-libre { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--fg-3);
    display: flex; align-items: center; gap: var(--sp-1); }
  /* [GX.48] La constancia de autorizacion. Enmarcada: es un documento, no un dato suelto. */
  .vp-aut { border: 1px solid var(--border); border-radius: var(--r-md);
    padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
  .vp-aut-h { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
    flex-wrap: wrap; }
  .vp-aut-doc { font-weight: var(--fw-bold); color: var(--fg-1); }
  .vp-aut-ok { font-size: var(--fs-xs); color: var(--ok-fg, var(--fg-2)); }
  .vp-aut-falta { margin: 0; font-size: var(--fs-xs); color: var(--fg-3);
    display: flex; align-items: flex-start; gap: var(--sp-1); }
  /* ── El vale, completo ──────────────────────────────────────────────────── */
  /* [GX.61] La MISMA escala que la pantalla de aprobacion: este panel es donde de verdad se
     lee el vale antes de firmarlo. Dejarlo chico habria agrandado la lista y no lo que se
     mira para decidir. Alcanza tambien al Expediente y al Historial, que reusan el visor. */
  .vp {
    --fs-nano:  0.6875rem;
    --fs-micro: 0.75rem;
    --fs-xs:    0.8125rem;
    --fs-sm:    0.875rem;
    --fs-body:  0.9375rem;
  }
  .vp { display: flex; flex-direction: column; gap: var(--sp-3); }
  .vp-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
  .vp-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: var(--fs-h1); font-weight: var(--fw-bold); line-height: 1.1; }
  .vp-prov { font-size: var(--fs-sm); color: var(--fg-2); }
  .vp-con { font-size: var(--fs-sm); color: var(--fg-1); margin: 0; }
  .vp-datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-2) var(--sp-4);
    margin: 0; padding: var(--sp-3); background: var(--layout-bg); border-radius: var(--r-md); }
  .vp-datos dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
  .vp-datos dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
  .vp-mono { font-family: var(--font-mono); }
  .vp-nota { font-size: var(--fs-sm); color: var(--fg-2); font-style: italic; margin: 0; }
  .vp-nota.warn { color: var(--warn-fg); font-style: normal; }
  .vp-nota.bad { color: var(--bad-fg); font-style: normal; }
  .vp-h-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
    margin: var(--sp-2) 0 0; }
  .vp-h-row .vp-h { margin: 0; }
  /* [GX.87] El porqué de la evidencia adicional, pegado a su rótulo. */
  .vp-doc-nota { display: block; color: var(--fg-3); }
  .vp-h { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em;
    color: var(--fg-3); margin: var(--sp-2) 0 0; }
  .vp-sin { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--fg-2);
    padding: var(--sp-4); border: 1px dashed var(--border-color); border-radius: var(--r-md); }
  /* [GX.99] Las miniaturas de la evidencia. */
  /* Lado a lado y del alto de una pantalla de panel: todo se ve de un vistazo, sin scroll. */
  .vp-minis { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-2); }
  .vp-mini { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-1); text-align: left; cursor: pointer;
    border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); font: inherit; color: var(--fg-1); }
  .vp-mini:hover { border-color: var(--action); }
  .vp-mini:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .vp-mini-img { position: relative; height: clamp(10rem, calc(100vh - 39rem), 24rem); display: grid; place-items: center; background: var(--layout-bg);
    border-radius: var(--r-sm); overflow: hidden; color: var(--fg-3); }
  /* contain: el archivo ENTERO, sin recortar. */
  .vp-mini-img img { width: 100%; height: 100%; object-fit: contain; }
  .vp-mini-img iframe { width: 100%; height: 100%; border: 0; pointer-events: none; background: var(--card-bg); }
  .vp-mini-ver { position: absolute; top: var(--sp-1); right: var(--sp-1); width: 1.75rem; height: 1.75rem; border-radius: var(--r-sm);
    display: grid; place-items: center; background: var(--card-bg); color: var(--fg-2); border: 1px solid var(--border-color); }
  .vp-mini:hover .vp-mini-ver { color: var(--action); border-color: var(--action); }
  .vp-mini-img .pi { font-size: 1.8rem; }
  .vp-mini-img em { font-style: normal; font-size: var(--fs-nano); }
  .vp-mini-t { font-size: var(--fs-xs); }
  .vp-mini .vp-doc-nota { font-size: var(--fs-nano); line-height: 1.3; }
  .vp-mini-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
  .vp-deps { margin: 0; padding-left: 1rem; }
  .vp-doc { margin: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
  .vp-doc figcaption { display: flex; align-items: center; justify-content: space-between;
    gap: var(--sp-2); padding: 6px var(--sp-3); background: var(--layout-bg);
    font-size: var(--fs-xs); color: var(--fg-2); }
  .vp-doc figcaption a { font-size: var(--fs-xs); }
  .vp-doc img { display: block; width: 100%; height: auto; background: var(--layout-bg); }
  .vp-doc iframe { display: block; width: 100%; height: 62vh; border: 0; background: var(--layout-bg); }
  .vp-fallo { font-size: var(--fs-xs); color: var(--warn-soft-fg); padding: var(--sp-1) 0; margin: 0; }
  .vp-otro { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-4);
    font-size: var(--fs-sm); color: var(--fg-2); text-decoration: none; background: var(--layout-bg); }
  .vp-otro:hover { color: var(--action); }
  .vp-otro .pi { font-size: 1.3rem; }
  /* El pie completo se pega abajo: la marca y los botones son UNA sola decisión. */
  .vp-pie { position: sticky; bottom: 0; margin-top: var(--sp-2); padding-top: var(--sp-2);
    display: flex; flex-direction: column; gap: var(--sp-2); background: var(--card-bg);
    border-top: 1px solid var(--c-divider); }
  .vp-act { display: flex; align-items: center; gap: var(--sp-2); padding-bottom: var(--sp-2); }
  .vp-cerrado { padding: var(--sp-2) 0; margin: 0; }
  .vp-prov-chk { display: flex; align-items: flex-start; gap: var(--sp-2); font-size: var(--fs-sm);
    color: var(--fg-1); cursor: pointer; padding: var(--sp-2) var(--sp-3);
    background: var(--layout-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
  .vp-prov-chk input { margin-top: 2px; }
  .vp-prov-fecha { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2);
    font-size: var(--fs-sm); color: var(--fg-2); padding: 0 var(--sp-3);
    margin-top: calc(var(--sp-2) * -1); }
  .vp-prov-fecha input { font: inherit; color: var(--fg-1); background: var(--card-bg);
    border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 4px 8px; }

  @media (max-width: 48rem) { .vp-datos { grid-template-columns: 1fr; } }
  `],
})
export class ValeGastoPeekComponent {
  /** `[GX.68]` La sucursal del vale se nombra con clave + nombre (`02 La Piedad Abastos`). */
  readonly branchLabel = branchLabel;
  private readonly sanitizer = inject(DomSanitizer);

  readonly open = model(false);
  /** El expediente a mostrar. `null` = no hay nada que ver. */
  readonly vale = input<ValeGasto | null>(null);
  /** Qué botones ofrece el pie. Vacío = sólo lectura. Lo decide la página. */
  readonly acciones = input<readonly AccionVale[]>([]);
  /** La página está resolviendo algo sobre este vale: los botones se bloquean. */
  readonly ocupado = input(false);

  /** `[GX.30]` Aprobar viaja con la marca: ver `AprobacionVale`. */
  readonly aprobar = output<AprobacionVale>();
  readonly comprobar = output<ValeGasto>();
  readonly rechazar = output<ValeGasto>();
  /** `[GX.29]` El capturista pide la reapertura. La página se encarga del motivo. */
  readonly pedirReapertura = output<ValeGasto>();
  /** `[GX.87]` Sumar evidencia. La página abre el diálogo y vuelve a pedir el detalle. */
  readonly agregarEvidencia = output<ValeGasto>();

  /**
   * `[GX.87]` Las acciones que DECIDEN sobre el vale (las del pie). Agregar evidencia no
   * cuenta: sin este filtro, un vale que sólo ofrece «Agregar evidencia» pintaba el pie de
   * decisión con un «Rechazar» que nadie le ofreció.
   */
  readonly decisiones = computed(() => this.acciones().filter((a) => a !== 'agregar_evidencia'));
  readonly puedeAgregarEvidencia = computed(() =>
    this.acciones().includes('agregar_evidencia') && aceptaEvidenciaAdicional(this.vale()?.status));

  /** `[GX.30]` La marca, mientras se mira ESTE vale. Se limpia al abrir otro (ver abajo). */
  readonly provisional = signal(false);
  /** `[GX.51]` Se conserva en null: la fecha limite se retiro, el campo del contrato no. */
  readonly esperado = signal('');

  constructor() {
    // (!) Sin esto la marca se PEGA de un vale al siguiente: quien aprueba uno con
    // prefactura y abre el de al lado se lo encuentra tildado, y firma una deuda
    // documental que nunca declaró. Se limpia cuando cambia el expediente.
    effect(() => {
      this.vale();
      this.provisional.set(false);
      this.esperado.set('');
      // `[GX.99]` El visor grande es del vale que se miraba: al cambiar de vale se cierra.
      this.visorAbierto.set(false);
      this.visorIndice.set(0);
    }, { allowSignalWrites: true });
  }

  marcarProvisional(e: Event): void {
    this.provisional.set((e.target as HTMLInputElement)?.checked === true);
  }

  emitirAprobacion(vale: ValeGasto): void {
    this.aprobar.emit({
      vale,
      provisional: this.provisional(),
      // `[GX.51]` Siempre `null`: ya no hay fecha limite que mandar. El campo se conserva en
      // el contrato porque hay expedientes viejos que la tienen, y borrarla del tipo los
      // volveria ilegibles.
      comprobante_esperado_at: null,
    });
  }

  /** Las urls que el navegador no pudo pintar. Ver `fallo()`. */
  private readonly fallidosSet = signal<ReadonlySet<string>>(new Set());
  readonly fallidos = this.fallidosSet.asReadonly();

  subtituloPeek(): string {
    const p = this.vale();
    if (!p) return '';
    // `[GX.98]` El departamento de Kepler (el de más importe). El capturado dice «Sucursal NN».
    const deps = p.departamentos;
    const dep = deps?.length ? (deps.length > 1 ? `${this.nombreDep(deps[0])} y ${deps.length - 1} más` : this.nombreDep(deps[0]))
      : deps === undefined ? (p.solicitante || 'sin departamento') : 'sin departamento en Kepler';
    return `${p.folio_solicitud || 'sin folio'} · ${dep}`;
  }

  readonly docs = computed<DocDelExpediente[]>(() => {
    const p = this.vale();
    if (!p) return [];
    return (p.files ?? []).filter((f: ProofFile) => f?.url).map((f: ProofFile) => {
      const role = String(f.role ?? '');
      const isPdf = f.kind === 'pdf' || /\.pdf(\?|$)/i.test(f.url);
      // ⚠️ `kind` sólo dice 'otro' desde `[GX.33]`. Los adjuntos ANTERIORES lo traen como
      // 'image' aunque no lo fueran, así que para ésos sigue valiendo el `(error)` del
      // `<img>`: se pinta el fallo, no se los da por perdidos.
      const esOtro = f.kind === 'otro';
      return {
        role,
        label: ARCHIVO_LABEL[role] ?? role ?? 'Archivo',
        url: f.url,
        isPdf,
        esOtro,
        safeUrl: isPdf ? this.sanitizer.bypassSecurityTrustResourceUrl(f.url) : null,
        // `[GX.99]` La vista del panel: la página entera ajustada, sin barras ni panel lateral del lector.
        safeUrlVista: isPdf ? this.sanitizer.bypassSecurityTrustResourceUrl(`${f.url.split('#')[0]}#view=Fit&toolbar=0&navpanes=0&scrollbar=0`) : null,
        nota: esEvidenciaAdicional(f) ? notaAdicional(f) : null,
      };
    });
  });

  /** `[GX.99]` El visor grande: abierto o no, y en qué archivo. Se cierra solo al cambiar de vale. */
  readonly visorAbierto = signal(false);
  readonly visorIndice = signal(0);
  verEvidencia(i: number): void { this.visorIndice.set(i); this.visorAbierto.set(true); }

  nombreDep(d: DepartamentoDelVale): string { return d.nombre ?? d.clave; }

  /** Que el navegador no pueda pintarlo NO es que el archivo no exista: se dice cuál de las dos. */
  fallo(url: string): void {
    this.fallidosSet.update((s) => new Set(s).add(url));
  }

  /**
   * La fecha ISO como `Date` **local**, para que el pipe no corra el día.
   *
   * ⚠️ `new Date('2026-09-25')` es medianoche **UTC**, y en México (−06:00) eso es el 24 a las
   * 18:00 — el pipe imprimiría «24 sep». Se usa el helper compartido del repo.
   */
  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  formaPago(id: string): string { return FORMA_PAGO_LABEL[id] ?? id; }
  /** `[GX.74]` Varios renglones de detalle (dos tarjetas, dos referencias) en una línea. */
  readonly detallePago = detallesParaMostrar;
  estado(s: string): string { return ESTADO_LABEL[s] ?? s; }
  /** El tipo de gasto en palabras. Sin la clave cruda: `no_fiscal_comprobable` es cómo se
   *  guarda, no cómo se dice. */
  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }
}

/**
 * `[GX.87]` «por qué · quién · cuándo» de una evidencia adicional. Lo que no vino se omite:
 * un expediente viejo sin autor no se pinta como si alguien sin nombre lo hubiera subido.
 */
export function notaAdicional(f: ProofFile): string {
  const cuando = f.agregado_at ? new Date(f.agregado_at) : null;
  const fecha = cuando && !Number.isNaN(cuando.getTime())
    ? cuando.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;
  return [f.motivo ? `«${f.motivo}»` : null, f.agregado_por || null, fecha].filter(Boolean).join(' · ');
}
