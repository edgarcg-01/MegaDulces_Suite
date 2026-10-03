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
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { ActivatedRoute } from '@angular/router';
import { ComprobacionesService, SolicitudSug, ProofFile, ProofFileRole, ExpenseProof,
  ExpenseClasificacion, ProofByFolio, requiereEvidencia, ROLES_COMPROBANTE, ROLES_COTIZACION,
  type ListasParaComprobar } from '../comprobaciones.service';
// [GX.14] El catálogo de formas de pago y la compuerta se IMPORTAN del contrato
// compartido: son los mismos que valida el backend. Copiarlos acá los separa.
import { FORMAS_PAGO, faltaParaMandar, type FormaPagoId, type Faltante } from '@megadulces/contracts';
import { CapturaEnVivoComponent } from '../components/captura-en-vivo.component';

/** En qué momento del ciclo está la solicitud elegida, y por tanto qué muestra la página. */
type CapMode = 'checking' | 'capturar' | 'evidencia' | 'esperando' | 'revision' | 'cerrada';

/** Solicitud de Kepler elegida (read-only) — el capturista sólo confirma que es la correcta. */
interface SelSolicitud {
  folio: string; beneficiario: string | null; importe: number; sucursal: string | null;
  solicitante: string | null; fecha: string | null; concepto: string | null;
  /** [GX.21] Lo demas que Kepler trae, para la vista previa del alta. */
  rfc?: string | null; iva?: number | null; autoriza?: string | null; referencia?: string | null;
  cuenta_clave?: string | null; usuario?: string | null; estado?: string | null;
}

/**
 * GX.8 — Vista del CAPTURISTA (rol `FINANCE_EXPENSES_CAPTURAR`). Superficie mínima:
 * pega el folio del gasto que le dieron de Kepler, sube el/los comprobante(s), envía.
 * Todo lo demás (proveedor, importe, área, solicitud) lo deriva el sistema del gasto
 * Kepler. No ve la bandeja de revisión ni valida — eso es del autorizador. Móvil-first.
 */
@Component({
  selector: 'app-finanzas-capturar-gasto',
  standalone: true,
  imports: [CommonModule, FormsModule, AutoCompleteModule, TagModule, ButtonModule, InputTextModule, TextareaModule, SelectButtonModule, ToastModule, DialogModule, CapturaEnVivoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cap">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Capturar gasto</h1>
          <p class="surf-page-sub">Pegá el folio de la solicitud de HOY, decí cómo se pagó y tomá la foto. Lo demás lo llena el sistema.</p>
        </div>
      </header>

      <div class="card-premium card-flat cap-card">
        <!-- 1) Folio del gasto -->
        @if (!gasto()) {
          <label class="cap-f"><span>1 · Folio de la solicitud (Kepler)</span>
            <p-autocomplete [(ngModel)]="sel" [suggestions]="sug()" (completeMethod)="buscar($event)"
              (onSelect)="pick($event)" optionLabel="label" [forceSelection]="false" [showClear]="true"
              placeholder="Últimos 4 dígitos, ej. 8489" appendTo="body"
              inputStyleClass="w-full" panelStyleClass="cap-ac-panel"
              [emptyMessage]="vacioMsg()">
              <!--
                [GX.17] Cada coincidencia, DESGLOSADA. Antes «optionLabel» pintaba una sola
                línea pegada -- folio, sucursal, beneficiario e importe separados por puntos --
                y con dos o tres resultados no se distinguía cuál era cuál. Acá el folio y el
                importe (lo que de verdad decide) van con su propio peso, y el concepto abajo.

                Ojo: «styleClass» en «p-autocomplete» **no existe en PrimeNG 22** -- era un
                atributo muerto, sin error ni aviso. Va «inputStyleClass», que sí existe.
              -->
              <ng-template let-s #item>
                <div class="cap-ac">
                  <div class="cap-ac-l">
                    <div class="cap-ac-top">
                      <span class="cap-ac-folio mono">{{ s.folio }}</span>
                      <span>suc {{ s.sucursal || '?' }}</span>
                      @if (s.fecha) { <span>{{ s.fecha | date:'dd/MM/yy' }}</span> }
                    </div>
                    <div class="cap-ac-benef">{{ s.beneficiario || '—' }}</div>
                    @if (s.concepto) { <div class="cap-ac-con">{{ s.concepto }}</div> }
                  </div>
                  <span class="cap-ac-imp mono">{{ moneyFull(s.importe) }}</span>
                </div>
              </ng-template>
            </p-autocomplete>
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
            <!--
              [GX.28] Lo que Kepler decidió sobre este vale. Alguien lo abre allá y le pone
              N o A; ese flag es «c43» y ya viajaba en la vista sin que nadie lo mostrara.

              ⚠️ «Autoriza» es un ÁREA, no una persona: la migración que trajo esa columna
              (20260821200000) la midió y conviven «FINANZAS / DPTO FINANZAS /
              DEPARTAMENTO DE FINANSAS». Se rotula como área a propósito -- ponerle «por»
              delante la haría leer como el nombre de quien firmó, que es otra cosa y
              todavía no sabemos en qué columna vive.
            -->
            <div class="cap-g-meta">
              @if (estadoKepler(); as e) {
                <span class="cap-g-est" [class]="'k-' + e.clave"><i class="pi pi-verified" aria-hidden="true"></i> Kepler: {{ e.label }}</span>
              }
              @if (gasto()!.autoriza) { <span><i class="pi pi-sitemap" aria-hidden="true"></i> área que autoriza: {{ gasto()!.autoriza }}</span> }
            </div>
            <div class="cap-g-acc">
              <button type="button" class="cap-link" (click)="reset()">cambiar solicitud</button>
              <!--
                [GX.21] El disparador de la vista previa es DISCRETO a proposito: un enlace
                de texto al pie de la ficha, no un boton que compita con «Enviar». Quien
                captura no necesita abrirlo: es para cuando alguien duda de si el folio es
                el correcto, o de como va a quedar el alta.
              -->
              <button type="button" class="cap-link" (click)="verPrevia()">ver alta completa</button>
            </div>
          </div>

          @switch (modo()) {
            @case ('checking') { <div class="cap-muted"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Revisando el estado de esta solicitud…</div> }

            <!-- ── Capturar el expediente completo: firmada + tipo + el ticket (GX.11). -->
            @case ('capturar') {
              @if (yaRechazada()) {
                <div class="cap-val warn"><i class="pi pi-replay" aria-hidden="true"></i> Esta solicitud fue devuelta. Vuelve a capturarla.</div>
              }
              <!--
                [GX.18] Se retiro el paso «Sube la solicitud firmada». Pedido del usuario:
                de este lado solo hace falta la FOTO de la evidencia. El rol
                «solicitud_kepler» sigue existiendo en el contrato de archivos -- los
                expedientes viejos lo tienen y el expediente en PDF lo sigue mostrando.
              -->
              <!--
                [GX.19] Se retiro el paso «¿Que tipo de gasto es?». De la solicitud, Kepler ya
                sabe TODO: que se compro, a quien, cuanto y de que cuenta sale. Lo unico que
                el ERP no tiene -- y por eso existe esta pantalla -- son tres cosas:

                  1. como se pago            (Kepler tiene la columna y nadie la llena)
                  2. la foto del vale autorizado
                  3. la cotizacion, cuando el gasto la tiene

                Pedirle ademas que clasifique el gasto era hacerle repetir lo que el sistema
                ya sabe, y de paso trababa el formulario: sin elegir tipo no aparecia nada.
              -->
              @if (true) {
                <!-- [GX.14] Paso propio, y ANTES de la foto: se pregunta en los tres tipos
                     de gasto, porque el dinero salió de algún lado aunque no haya papel.
                     Kepler tiene la columna y nadie la llena — 5,410 de 10,082 vacías. -->
                <div class="cap-step">2 · Método de pago</div>
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
                      <!--
                        [GX.53] El tope y el tipo salen del CATALOGO, no de un numero suelto
                        aca: «Ultimos 4 digitos» aceptaba 19 y ahi cabia una tarjeta entera.
                        El maxlength es comodidad; quien decide es la compuerta, que el
                        backend tambien lee -- un limite solo en el input se salta por la API.
                      -->
                      <input pInputText [ngModel]="formaPagoDetalle()" (ngModelChange)="formaPagoDetalle.set($event)"
                             [placeholder]="fs.detalle_ejemplo || ''" class="w-full"
                             [attr.maxlength]="fs.detalle_max" [attr.inputmode]="fs.detalle_solo_digitos ? 'numeric' : null" />
                    </label>
                  }
                }

                <!--
                  GX.11 -- la evidencia se sube ACA. [GX.18] Y ahora en los TRES tipos: el
                  «Vale autorizado» tambien se fotografia en el momento, por pedido del
                  usuario. Antes ese caso se registraba sin ninguna imagen, solo con un
                  motivo escrito -- o sea, sin nada que mirar.
                -->
                <!--
                  [GX.20] Un solo paso, dos botones. Antes eran dos pasos numerados -- el vale
                  y la cotizacion -- y eso los ponia al mismo nivel: la persona contaba cuatro
                  obligaciones cuando en realidad hay UNA evidencia que dar, por dos caminos.

                  La diferencia entre los dos botones es real y por eso no se puede fundir en
                  uno: el VALE se toma en el momento (es el papel que se firma al gastar) y la
                  COTIZACION se adjunta (existe antes, llega por correo o en PDF). Pedirle
                  camara a la cotizacion seria pedir la foto de una pantalla.

                  La cotizacion no muestra su zona de arrastre: es un boton que abre el
                  explorador y, elegido el archivo, ya esta. Sin superficie que ocupe alto
                  esperando algo que la mayoria de los gastos no tiene.
                -->
                <div class="cap-step">3 · Capturá la evidencia de tu gasto</div>
                <div class="cap-ev">
                  <div class="cap-ev-c">
                    <!--
                      [GX.23] Varias fotos, no una. Un gasto puede llevar el vale de ida y el
                      de vuelta, o el ticket y su detalle. El boton sigue siendo el mismo y
                      cambia de texto: la primera vez «Tomar foto del vale», despues «Agregar
                      otra foto» -- la accion es la misma, lo que cambia es que ya hay una.
                    -->
                    @if (comprobantes().length < MAX_COMPROBANTES) {
                      <md-captura-en-vivo [etiqueta]="comprobantes().length ? 'Agregar otra foto' : 'Tomar foto del vale'"
                                          (capturada)="onCaptura($event)" />
                    } @else {
                      <p class="cap-ev-nota"><i class="pi pi-info-circle" aria-hidden="true"></i> Ya hay {{ MAX_COMPROBANTES }} fotos, el máximo.</p>
                    }
                    @for (r of comprobantes(); track r) {
                      <div class="cap-done">
                        <!--
                          [GX.24] La miniatura. Antes el unico rastro de la foto era el texto
                          «Foto tomada 18:42»: la persona no podia comprobar que hubiera
                          salido el ticket y no el mostrador, ni el dedo sobre el lente.
                          Se abre en grande al tocarla -- en un telefono, 48 px no alcanzan
                          para leer un total.
                        -->
                        @if (miniaturas()[r]; as src) {
                          <button type="button" class="cap-mini" (click)="verFoto(r)"
                                  [attr.aria-label]="'Ver ' + names()[r] + ' en grande'">
                            <img [src]="src" alt="" />
                          </button>
                        }
                        <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()[r] }}</span>
                        <button type="button" class="cap-link" (click)="clearFile(r)">quitar</button>
                      </div>
                    }
                  </div>
                  <div class="cap-ev-c">
                    @if (cotizaciones().length < MAX_COTIZACIONES) {
                      <label class="cap-ev-b">
                        <i class="pi pi-upload" aria-hidden="true"></i> {{ cotizaciones().length ? 'Agregar otra' : 'Subir cotización' }}
                        <input type="file" (change)="onFileCotizacion($event)" hidden />
                      </label>
                      @if (!cotizaciones().length) {
                        <p class="cap-ev-nota"><i class="pi pi-paperclip" aria-hidden="true"></i> Si el gasto la tiene. Cualquier archivo.</p>
                      }
                    }
                    <!--
                      [GX.36] El vale ESCANEADO. Sube al mismo cajón que la foto
                      (comprobante_1..4) porque ES el comprobante: acá los vales se escanean,
                      y un escaneo del vale firmado vale lo mismo que la foto del vale
                      firmado. Antes esto subía a evidencia_1..3 -- un cajón aparte que la
                      compuerta no miraba, asi que el boton seguia diciendo «Falta: La foto
                      del comprobante» con el documento ya adjunto.
                    -->
                    @if (comprobantes().length < MAX_COMPROBANTES) {
                      <label class="cap-ev-b">
                        <i class="pi pi-file" aria-hidden="true"></i> {{ comprobantes().length ? 'Subir otro archivo' : 'Subir vale escaneado' }}
                        <input type="file" (change)="onFileComprobante($event)" hidden />
                      </label>
                      <p class="cap-ev-nota"><i class="pi pi-info-circle" aria-hidden="true"></i> El vale escaneado o su archivo. Cualquier tipo: PDF, Word, Excel, imagen…</p>
                    }
                    @for (r of cotizaciones(); track r) {
                      <div class="cap-done">
                        <!-- Un PDF no tiene miniatura: se DICE con su icono, no se deja el hueco. -->
                        @if (miniaturas()[r]; as src) {
                          <button type="button" class="cap-mini" (click)="verFoto(r)"
                                  [attr.aria-label]="'Ver ' + names()[r] + ' en grande'">
                            <img [src]="src" alt="" />
                          </button>
                        } @else {
                          <span class="cap-mini cap-mini-pdf" aria-hidden="true"><i class="pi pi-file-pdf"></i></span>
                        }
                        <i class="pi pi-check-circle cap-ok" aria-hidden="true"></i> <span class="cap-nm">{{ names()[r] }}</span>
                        <button type="button" class="cap-link" (click)="clearFile(r)">quitar</button>
                      </div>
                    }
                  </div>
                </div>
                  <!-- [GX.32] Acá iban los cuatro mensajes del cuadre por visión
                       («el monto cuadra» / «no cuadra, quedará en revisión» / …). Se
                       retiraron con la visión: la foto se toma y se manda, y quien firma
                       decide mirándola. -->

                <!--
                  [GX.57] El concepto dejó de ser opcional (pedido del usuario). El rótulo lo
                  dice con una marca visible: un campo obligatorio que se anuncia sólo cuando
                  el botón se apaga hace teclear a ciegas.

                  ⚠️ ngModel + ngModelChange por separado, NO el banana-in-a-box: el campo es una SEÑAL
                  y la forma corta no sabe escribirla. Mismo patrón que el dato del pago.
                -->
                <label class="cap-f"><span>Concepto <b class="cap-req">obligatorio</b></span>
                  <textarea pTextarea [ngModel]="comentarios()" (ngModelChange)="comentarios.set($event)"
                            rows="2" class="w-full" placeholder="En una frase: qué se compró o para qué fue el gasto"></textarea></label>
              }

              @if (formError()) { <div class="cap-err">{{ formError() }}</div> }
              <!--
                [GX.17] Se retiró la lista de faltantes que iba acá («Cómo se pagó» / «La foto
                del comprobante»): con los pasos numerados a la vista, repetía lo que la propia
                pantalla ya dice. Pedido del usuario.

                ⚠️ Lo que la lista SÍ hacía era explicar por qué el botón está apagado, y el
                «title» de un botón deshabilitado no se lee: no hay hover en táctil y varios
                navegadores ni lo muestran. Por eso el faltante pasa a la ETIQUETA del botón,
                donde se ve sin apuntarle. La compuerta no cambia: sigue saliendo de
                faltaParaMandar(), la misma función que devuelve el 400 del backend.
              -->
              <button pButton type="button" class="cap-send" [loading]="saving()"
                      [disabled]="!puedeEnviar() || saving()" [title]="enviarTitle()" (click)="submit()">
                <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">{{ enviarLabel() }}</span>
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
                  <button type="button" class="cap-link" (click)="clearPhoto()">cambiar</button>
                </div>

              }
              <!--
                [GX.57] ⚠️ Éste SIGUE siendo opcional, a propósito. Lo obligatorio es el
                concepto del ALTA (la pantalla que el usuario señaló); acá el gasto ya tiene
                su concepto desde que se capturó y esto es una nota para quien valida. Si
                también debe exigirse, es una línea — pero es otra decisión, y se declara
                en vez de extenderla sola.
              -->
              <label class="cap-f"><span>Comentarios (opcional)</span>
                <textarea pTextarea [ngModel]="comentarios()" (ngModelChange)="comentarios.set($event)"
                          rows="2" class="w-full" placeholder="Nota para quien valida…"></textarea></label>

              @if (formError()) { <div class="cap-err">{{ formError() }}</div> }
              <button pButton type="button" class="cap-send" [loading]="saving()"
                      [disabled]="!puedeEnviar() || saving()" [title]="enviarTitle()" (click)="submit()">
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

      <!-- [GX.24] La foto en grande. Sin recortes: se mira para comprobar que se lee. -->
      <p-dialog [(visible)]="fotoAbierta" [modal]="true" [draggable]="false" [dismissableMask]="true"
                [style]="{ width: 'min(42rem, 94vw)' }" [header]="fotoTitulo()">
        @if (fotoSrc(); as src) { <img [src]="src" class="cap-foto-grande" alt="" /> }
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="fotoAbierta = false">Cerrar</button>
        </ng-template>
      </p-dialog>

      <!--
        [GX.21] La vista previa del alta: a la izquierda lo que Kepler ya sabe, a la derecha
        lo que esta pantalla agrega. Puestas lado a lado se ve de un golpe que el trabajo de
        la persona son tres renglones y el resto viene solo.

        ⚠️ Un campo que Kepler no trae sale con un GUION, nunca vacio ni en cero: un espacio
        en blanco se lee como «no hay dato» igual que como «no se cargo», y son cosas
        distintas. El guion dice que se miro y no habia.
      -->
      <p-dialog [(visible)]="previaAbierta" [modal]="true" [draggable]="false" [style]="{ width: '44rem' }"
                header="Vista previa del alta">
        @if (gasto(); as g) {
          <div class="cap-prev">
            <section>
              <h3><i class="pi pi-database" aria-hidden="true"></i> Lo que trae Kepler</h3>
              <dl>
                <dt>Folio</dt><dd class="mono">{{ g.folio }}</dd>
                <dt>Sucursal</dt><dd>{{ g.sucursal || '—' }}</dd>
                <dt>Fecha</dt><dd>{{ g.fecha ? (g.fecha | date:'dd/MM/yy') : '—' }}</dd>
                <dt>Beneficiario</dt><dd>{{ g.beneficiario || '—' }}</dd>
                <dt>RFC</dt><dd class="mono">{{ g.rfc || '—' }}</dd>
                <dt>Concepto</dt><dd>{{ g.concepto || '—' }}</dd>
                <dt>Cuenta</dt><dd class="mono">{{ g.cuenta_clave || '—' }}</dd>
                <dt>Solicita</dt><dd>{{ g.solicitante || '—' }}</dd>
                <dt>Autoriza</dt><dd>{{ g.autoriza || '—' }}</dd>
                <dt>Referencia</dt><dd class="mono">{{ g.referencia || '—' }}</dd>
                <dt>Capturo</dt><dd>{{ g.usuario || '—' }}</dd>
                <dt>IVA</dt><dd class="mono">{{ g.iva ? moneyFull(g.iva) : '—' }}</dd>
                <dt>Importe</dt><dd class="mono cap-prev-imp">{{ moneyFull(g.importe) }}</dd>
              </dl>
            </section>
            <section>
              <h3><i class="pi pi-pencil" aria-hidden="true"></i> Lo que agregas vos</h3>
              <dl>
                <dt>Método de pago</dt>
                <dd>
                  @if (formaSel(); as fs) { {{ fs.label }} <span class="cap-prev-cod mono">{{ fs.codigo_kepler }}</span> }
                  @else { <span class="cap-prev-falta">sin elegir</span> }
                </dd>
                <dt>Evidencia</dt>
                <dd>
                  @if (names()['comprobante_1']; as n) { <span class="cap-prev-ok">✓</span> {{ n }} }
                  @else { <span class="cap-prev-falta">falta la foto</span> }
                </dd>
                <dt>Cotización</dt>
                <dd>
                  @if (names()['cotizacion']; as n) { <span class="cap-prev-ok">✓</span> {{ n }} }
                  @else { <span class="cap-prev-opt">no se adjuntó — es opcional</span> }
                </dd>
                <dt>Concepto</dt>
                <dd>{{ comentarios().trim() || '—' }}</dd>
              </dl>
              @if (faltan().length) {
                <p class="cap-prev-pend"><i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                  Así como está <strong>no se puede enviar</strong>: {{ faltan()[0].label }}.</p>
              } @else {
                <p class="cap-prev-listo"><i class="pi pi-check-circle" aria-hidden="true"></i>
                  Listo para enviar a aprobación.</p>
              }
            </section>
          </div>
        }
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="previaAbierta = false">Cerrar</button>
        </ng-template>
      </p-dialog>

      <!--
        [GX.18] Se retiro el bloque «Listas para comprobar» (lo que Kepler ya autorizo y
        aplico). Pedido del usuario: esta pantalla es para LEVANTAR el gasto, y esa lista
        era una bandeja de seguimiento -- otro oficio, y empujaba la captura hacia abajo.
        El endpoint «listasParaComprobar» sigue existiendo: se quito la vista, no el dato.
      -->
      <!--
        [GX.18] Se retiro «Mis ultimas capturas». Pedido del usuario. Era la bitacora de lo
        ya enviado -- seguimiento, no levantamiento -- y ocupaba mas alto que el formulario
        que la persona viene a llenar. El endpoint «mine» sigue vivo: se quito la vista, no el dato.
      -->
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
    /* [GX.57] La marca de campo obligatorio. Se lee ANTES de teclear; el botón apagado
       recién lo diría después. */
    .cap-req { color: var(--action); font-weight: var(--fw-bold); letter-spacing: .06em; }
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
    /* [GX.28] El estado de Kepler se lee por PALABRA; el color solo acompaña. */
    .cap-g-est { padding: 1px var(--sp-2); border-radius: var(--r-sm);
      border: 1px solid var(--border-color); color: var(--fg-2); }
    .cap-g-est.k-a { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .cap-g-est.k-c { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cap-cuadre { display: inline-flex; align-items: center; gap: var(--sp-1);
      padding: var(--sp-1) var(--sp-2); font-size: var(--fs-xs);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); color: var(--fg-2); }
    .cap-cuadre.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .cap-cuadre.bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cap-link { align-self: flex-start; min-height: max(1.5rem, var(--tap-min)); padding: 0; border: 0;
      background: none; font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer;
      text-decoration: underline; text-underline-offset: 2px; }
    .cap-link:hover { color: var(--action-hover); }
    .cap-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    /* [GX.17] El desglose de cada coincidencia del buscador. */
    .cap-ac { display: flex; align-items: flex-start; justify-content: space-between;
      gap: var(--sp-3); width: 100%; }
    .cap-ac-l { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .cap-ac-top { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2);
      font-size: var(--fs-xs); color: var(--fg-3); }
    .cap-ac-folio { font-weight: var(--fw-bold); color: var(--fg-1); }
    .cap-ac-benef { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap-ac-con { font-size: var(--fs-xs); color: var(--fg-2);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap-ac-imp { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1);
      white-space: nowrap; }

    /* [GX.17] «¿Cómo se pagó?» salía como texto pegado -- «Efectivo01Tarjeta04…» -- porque
       estas cuatro clases se usaban en la plantilla desde GX.14 y **nunca se definieron**.
       Un «class="…"» que no existe es HTML válido: sin error, sin aviso, build verde. */
    .cap-fp { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
      gap: var(--sp-2); }
    .cap-fp-b { display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      min-height: var(--tap-min); padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: transparent; font: inherit; text-align: left; cursor: pointer; }
    .cap-fp-b:hover { border-color: var(--action); }
    .cap-fp-b:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cap-fp-b.on { border-color: var(--action); background: var(--overlay-selected); }
    .cap-fp-t { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); }
    .cap-fp-b.on .cap-fp-t { color: var(--action); }
    /* El código de Kepler es contexto, no el nombre: va chico y en mono. */
    .cap-fp-c { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-3);
      letter-spacing: .04em; }

    /* [GX.24] La miniatura de lo capturado. Es un boton: se abre en grande al tocarla. */
    .cap-mini { flex-shrink: 0; width: 40px; height: 40px; padding: 0; overflow: hidden;
      border: 1px solid var(--border-color); border-radius: var(--r-sm);
      background: var(--surface-ground); cursor: pointer; display: flex;
      align-items: center; justify-content: center; }
    .cap-mini img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cap-mini:hover { border-color: var(--action); }
    .cap-mini:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cap-mini-pdf { cursor: default; color: var(--fg-3); }
    .cap-foto-grande { display: block; width: 100%; height: auto; border-radius: var(--r-sm); }

    /* [GX.21] La vista previa: dos columnas que se apilan en movil. */
    .cap-g-acc { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
    .cap-prev { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); }
    @media (max-width: 40rem) { .cap-prev { grid-template-columns: 1fr; } }
    .cap-prev h3 { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2);
      font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cap-prev dl { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-1) var(--sp-3);
      margin: 0; font-size: var(--fs-xs); }
    .cap-prev dt { color: var(--fg-3); white-space: nowrap; }
    .cap-prev dd { margin: 0; color: var(--fg-1); overflow-wrap: anywhere; }
    .cap-prev-imp { font-weight: var(--fw-bold); }
    .cap-prev-cod { color: var(--fg-3); font-size: var(--fs-micro); }
    .cap-prev-ok { color: var(--ok-fg); font-weight: var(--fw-bold); }
    /* Lo que falta y lo que es opcional NO se pintan igual: uno frena el envio, el otro no. */
    .cap-prev-falta { color: var(--bad-fg); }
    .cap-prev-opt { color: var(--fg-3); font-style: italic; }
    .cap-prev-pend, .cap-prev-listo { display: flex; align-items: flex-start; gap: var(--sp-2);
      margin: var(--sp-3) 0 0; font-size: var(--fs-xs); line-height: 1.45; }
    .cap-prev-pend { color: var(--bad-fg); }
    .cap-prev-listo { color: var(--ok-fg); }

    /* [GX.20] Los dos caminos de la evidencia, lado a lado. El de la camara es el
       primario (lo pinta el propio componente); el de la cotizacion es secundario,
       porque la mayoria de los gastos no la tiene. */
    .cap-ev { display: flex; gap: var(--sp-2); align-items: flex-start; }
    .cap-ev-c { flex: 1 1 0; min-width: 0; }
    .cap-ev-b { display: flex; align-items: center; justify-content: center; gap: 7px;
      width: 100%; height: 40px; box-sizing: border-box;
      border: 1px solid var(--border-color); border-radius: var(--r-sm);
      background: transparent; color: var(--fg-1); font-size: var(--fs-body);
      font-weight: var(--fw-medium); cursor: pointer; }
    .cap-ev-b:hover { border-color: var(--action); color: var(--action); }
    .cap-ev-b:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cap-ev-nota { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0;
      font-size: var(--fs-xs); line-height: 1.45; color: var(--fg-3); }
    /* [GX.19] El paso opcional se ve distinto del obligatorio: si los cuatro pesan igual,
       la persona cree que le falta uno y se queda esperando. */
    .cap-step-opt span { margin-left: var(--sp-2); font-weight: var(--fw-regular);
      font-size: var(--fs-xs); color: var(--fg-3); }
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
    .cap-pick:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

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
  // `[GX.41]` Para llegar con el folio ya puesto desde «Mis gastos».
  private readonly route = inject(ActivatedRoute);

  readonly gasto = signal<SelSolicitud | null>(null);
  readonly sug = signal<(SolicitudSug & { label: string })[]>([]);
  /** [GX.21] La vista previa del alta. Se abre desde el enlace discreto de la ficha. */
  previaAbierta = false;
  verPrevia() { this.previaAbierta = true; }

  /**
   * [GX.24] Lo que se ve de cada archivo, como data URI. Solo imagenes: un PDF no tiene
   * miniatura y eso se dice con su icono en vez de dejar el hueco.
   *
   * ⚠️ Vive en una senal aparte de `fileData` porque esa es privada y se VACIA al subir
   * (`uploadThen` borra el data URI cuando el archivo ya esta en el bucket). La miniatura
   * tiene que sobrevivir a eso: la persona sigue viendo su foto mientras el envio corre.
   */
  readonly miniaturas = signal<Record<string, string>>({});
  fotoAbierta = false;
  readonly fotoRol = signal<string>('');
  fotoSrc() { return this.miniaturas()[this.fotoRol()] ?? null; }
  fotoTitulo() { return this.names()[this.fotoRol()] ?? 'Foto'; }
  verFoto(role: string) { this.fotoRol.set(role); this.fotoAbierta = true; }
  sel: (SolicitudSug & { label: string }) | string | null = null;
  /**
   * `[GX.57]` El concepto del gasto. **SEÑAL, no campo suelto** — la misma razón que
   * `formaPagoDetalle` (GX.22): desde ahora lo lee el `computed` de la compuerta, y un
   * `computed` sólo se recalcula cuando cambia una SEÑAL que leyó. Como propiedad plana,
   * escribir el concepto no invalidaría nada y el botón quedaría apagado de por vida
   * diciendo «Falta: El concepto» — es el defecto que `scripts/check-signal-reactivity.js`
   * vigila, y el mismo que CG.22 encontró en Caja General.
   */
  readonly comentarios = signal('');

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
    /**
     * `[GX.55]` ⛔ **Un vale PROVISIONAL siempre puede recibir su comprobante.**
     *
     * Aca estaba `(p.requiere_evidencia && !p.comprobante)` a secas, y eso cerraba el unico
     * caso que importa: GX.19 fija la captura en `no_comprobable`, asi que
     * `requiere_evidencia` es **false** y un vale aprobado con cotizacion caia en `cerrada`.
     * La pantalla lo daba por terminado y no habia por donde subir la factura — con el chip
     * diciendole a la persona «te toca subir la factura del pago».
     *
     * `provisional` es, literalmente, «aprobado pero debiendo el comprobante»: si esta puesto
     * y el comprobante no llego, hay algo que subir. No depende de la clasificacion.
     */
    if (p.status === 'aprobada') {
      const debe = (p.requiere_evidencia || p.provisional === true) && !p.comprobante;
      return debe ? 'evidencia' : 'cerrada';
    }
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
    { label: 'Vale autorizado', value: 'no_comprobable' },
  ];
  /**
   * [GX.18] Los TRES tipos llevan foto. El «Vale autorizado» (antes «Sin comprobante»)
   * tambien se fotografia en el momento: era el unico que se registraba sin ninguna
   * imagen, solo con un motivo escrito. `requiereEvidencia()` del servicio NO se toca --
   * lo leen otras pantallas y significa otra cosa ahi.
   */
  readonly llevaEvidencia = computed(() => !!this.clasificacion());
  onClasChange() { this.clasificacion.set(this.clasificacionV); this.formError.set(''); }
  /**
   * [GX.18] Que se le pide fotografiar, segun el tipo. Los tres piden foto EN VIVO -- lo
   * que cambia es el papel: la factura, el ticket, o el vale firmado.
   */
  tituloEvidencia(): string {
    switch (this.clasificacion()) {
      case 'fiscal': return 'Tomá la factura';
      case 'no_comprobable': return 'Tomá el vale autorizado';
      default: return 'Tomá el ticket';
    }
  }

  clasHint(): string {
    switch (this.clasificacion()) {
      case 'fiscal': return 'Te dieron factura. Adjuntala.';
      case 'no_fiscal_comprobable': return 'No hay factura, pero sí ticket o recibo. Tomá la foto y subí la cotización.';
      case 'no_comprobable': return 'Sacale foto al vale firmado, o subí el vale escaneado.';
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
    forma_pago_detalle: this.formaPagoDetalle(),
    // El sello viaja por rol: `names` sólo dice que hay archivo, no de dónde salió.
    archivos: Object.keys(this.names()).map((role) => ({ role, live: this.sellos()[role]?.live === true })),
    exige_evidencia: this.llevaEvidencia(),
    // `[GX.57]` El concepto entra a la compuerta compartida. Es una SEÑAL justamente para
    // que este `computed` se entere cuando la persona lo escribe.
    concepto: this.comentarios(),
  }));

  puedeEnviar(): boolean {
    if (!this.gasto()) return false;
    if (this.modo() === 'evidencia') return !!this.names()['comprobante_1'];
    if (this.modo() !== 'capturar') return false;
    if (!this.clasificacion()) return false;
    // `[GX.31]` Acá había un `if (!this.names()['solicitud_kepler']) return false;`.
    // GX.18 retiró la ÚNICA pantalla que subía ese archivo, así que la condición no se
    // podía cumplir nunca: el botón quedaba apagado de por vida, y encima diciendo
    // «Enviar a aprobación» porque GX.18 también sacó de `enviarTitle()` la rama que lo
    // explicaba. El respaldo ahora es la foto en vivo del vale, y la exige `faltan()`
    // —la misma regla que devuelve el 400 del servidor—, dos líneas más abajo.
    // `[GX.57]` La compuerta compartida cubre AHORA las tres: forma de pago, archivo y
    // concepto. Acá colgaba un `return this.llevaEvidencia() ? true : !!comentarios.trim()`
    // — la regla del concepto escrita por segunda vez, y encima distinta de la del servidor
    // (acá sólo para el no comprobable, allá igual). Se fue al contrato, que es el único
    // lugar donde las dos puntas la leen igual.
    return !this.faltan().length;
  }
  /**
   * [GX.17] Lo que dice el BOTÓN. Mientras falte algo lo nombra; cuando no falta nada,
   * nombra la acción. Reemplaza a la lista de faltantes que vivía encima -- un botón
   * apagado sin motivo visible es el mismo callejon que un botón que no hace nada.
   */
  enviarLabel(): string {
    if (this.saving()) return 'Enviando…';
    /**
     * ⚠️ Acá filtraba por `startsWith('Falta')` y se comía «Elige el tipo de gasto»: el botón
     * quedaba apagado diciendo «Enviar a aprobación», o sea mintiendo. Lo agarró la prueba de
     * al lado el mismo día que se escribió.
     *
     * La pregunta correcta no es cómo empieza el texto — es si se puede enviar. Si no se
     * puede, se muestra el motivo, sea cual sea.
     */
    return this.puedeEnviar() ? 'Enviar a aprobación' : this.enviarTitle();
  }

  enviarTitle(): string {
    if (this.modo() === 'evidencia') return this.names()['comprobante_1'] ? 'Enviar evidencia' : 'Falta capturar la evidencia';
    // [GX.18] El paso de la solicitud firmada se retiro: el boton ya no lo puede pedir.
    if (!this.clasificacion()) return 'Elige el tipo de gasto';
    // [GX.14] El primer faltante de la compuerta manda el texto: es el que hay que
    // resolver primero, y sale de la misma lista que ve la persona en pantalla.
    const f = this.faltan()[0];
    if (f) return `Falta: ${f.label}`;
    // `[GX.57]` El «Falta el motivo» que iba acá ya lo nombra la compuerta («El concepto»).
    return 'Enviar a aprobación';
  }

  /** `[GX.14]` El catálogo, tal cual viene del contrato. La plantilla lo recorre. */
  readonly formasPago = FORMAS_PAGO;
  readonly formaPago = signal<FormaPagoId | null>(null);
  /** ngModel del detalle (caja, últimos 4, referencia…). */
  /**
   * [GX.22] SENAL, no campo suelto. Estaba como propiedad plana y la leia el `computed`
   * de la compuerta -- que solo se recalcula cuando cambia una SENAL que leyo. O sea:
   * escribir la referencia del banco no invalidaba nada, el boton seguia diciendo
   * «Falta: El dato del pago» y **no se podia enviar el gasto**.
   *
   * Lo agarro `scripts/check-signal-reactivity.js`, que ya venia en rojo por esta misma
   * linea. Un candado que nadie mira es un candado apagado.
   */
  readonly formaPagoDetalle = signal('');
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
    if (this.formaPago() !== id) this.formaPagoDetalle.set('');
    this.formaPago.set(id);
  }

  /** [GX.23] Tope de cada familia. Vienen del catalogo de roles: no se inventan aca. */
  readonly MAX_COMPROBANTES = ROLES_COMPROBANTE.length;
  readonly MAX_COTIZACIONES = ROLES_COTIZACION.length;


  /** Los roles de esta familia que YA tienen archivo, en el orden del catalogo. */
  readonly comprobantes = computed(() => ROLES_COMPROBANTE.filter((r) => !!this.names()[r]));
  readonly cotizaciones = computed(() => ROLES_COTIZACION.filter((r) => !!this.names()[r]));
  // `[GX.36]` Se fue `evidencias()`: el archivo escaneado ya no vive en un cajón aparte,
  // sube como comprobante — que es lo que es.

  /** El primer rol libre de la familia, o `null` si ya no queda. */
  private libre(roles: ProofFileRole[]): ProofFileRole | null {
    return roles.find((r) => !this.names()[r]) ?? null;
  }

  /**
   * `[GX.14]` Llega una foto recien tomada. [GX.23] Va al primer hueco libre, no siempre
   * a `comprobante_1`: un gasto puede llevar varias.
   */
  onCaptura(ev: { dataUrl: string; capturedAt: string }) {
    const role = this.libre(ROLES_COMPROBANTE);
    if (!role) { this.formError.set(`Ya hay ${this.MAX_COMPROBANTES} fotos, el maximo.`); return; }
    this.formError.set('');
    this.guardarCaptura(role, ev.dataUrl, ev.capturedAt);
  }

  /** Lo mismo del lado de la cotizacion, que entra por archivo. */
  onFileCotizacion(ev: Event) {
    const role = this.libre(ROLES_COTIZACION);
    if (!role) { this.formError.set(`Ya hay ${this.MAX_COTIZACIONES} cotizaciones, el maximo.`); return; }
    this.onFile(ev, role);
  }

  /**
   * `[GX.36]` El vale ESCANEADO, o el archivo que lo respalde. Va al mismo cajón que la
   * foto: es el comprobante, sólo que entró por el escáner y no por la cámara.
   */
  onFileComprobante(ev: Event) {
    const role = this.libre(ROLES_COMPROBANTE);
    if (!role) { this.formError.set(`Ya hay ${this.MAX_COMPROBANTES} comprobantes, el maximo.`); return; }
    this.onFile(ev, role);
  }

  // `[GX.32]` Se fueron `photoLoading` y `photoResult`: eran la espera y el resultado de
  // la lectura por visión. Sin visión no hay nada que esperar — la foto se adjunta y ya.
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

  constructor() {
    this.loadMine();
    this.loadListas();
    this.abrirDesdeLaUrl();
  }

  /**
   * `[GX.41]` **Llegar acá con el folio ya puesto**, desde «Mis gastos» → «Subir evidencia».
   *
   * ⭐ No arma el estado a mano: **busca el folio y llama a `pick()`**, el mismo camino que
   * usa quien lo teclea. Copiar lo que hace `pick()` habria dejado dos formas de seleccionar
   * una solicitud, y la de la URL se habria quedado atras en el primer cambio — sin que nadie
   * lo note, porque la pantalla se ve igual.
   *
   * ⚠️ Si el folio no aparece **no se inventa nada**: se deja el buscador vacio con el texto
   * escrito, para que la persona vea que ese folio no esta y pueda buscar otro. Pasa de
   * verdad: el feed del ODS puede no haberlo traido todavia.
   */
  private abrirDesdeLaUrl(): void {
    const qp = this.route.snapshot.queryParamMap;
    const folio = (qp.get('folio') || '').trim();
    if (!folio) return;
    const suc = (qp.get('sucursal') || '').trim();
    /**
     * ⭐ `[GX.49]` **Por `solicitudExacta`, NO por el buscador.** El buscador filtra a las
     * solicitudes de HOY (GX.18, para que el desplegable no traiga ruido) — y un vale que
     * Kepler asigno puede ser de ayer o de la semana pasada. Con el buscador, «Subir
     * evidencia» abria esta pantalla **vacia**: sin solicitud no hay botones que mostrar, y
     * se lee como que los botones no funcionan. Medido: `search-solicitudes?q=0097001`
     * devolvia 0 para un vale de hace tres dias.
     *
     * ⚠️ Sin sucursal se cae al buscador: `solicitudExacta` exige las dos cosas a proposito
     * (sin la fecha, un folio suelto dejaria enumerar 10,082 solicitudes en vez de ~30).
     */
    const fuente = suc ? this.svc.solicitudExacta(folio, suc) : this.svc.searchSolicitudes(folio);
    fuente.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((rows) => {
      // ⛔ Con la sucursal a mano se exige exacta: 373 folios viven en mas de una plaza y
      // tomar la primera abriria el vale de otra tienda con el importe de otra tienda.
      const hit = (rows || []).find((r) => r.folio === folio && (!suc || String(r.sucursal || '') === suc));
      if (!hit) { this.sel = folio; this.cdr.markForCheck(); return; }
      this.pick(hit as never);
      this.cdr.markForCheck();
    });
  }

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
      sucursal: g.sucursal, solicitante: g.solicitante, fecha: g.fecha, concepto: g.concepto,
      rfc: g.rfc, iva: g.iva, autoriza: g.autoriza, referencia: g.referencia,
      cuenta_clave: g.cuenta_clave, usuario: g.usuario, estado: g.estado });
    this.sel = null;
    /**
     * [GX.19] La clasificacion deja de preguntarse y se fija en `no_comprobable`, que es
     * exactamente lo que la persona aporta: el VALE AUTORIZADO fotografiado.
     *
     * ⚠️ La columna sigue existiendo con su CHECK de tres valores y su chip en Aprobacion,
     * asi que todo lo que se levante por esta pantalla va a decir «Vale autorizado». Si mas
     * adelante hace falta distinguir factura de ticket, la distincion NO se recupera sola:
     * hay que volver a preguntarla o derivarla de la cuenta de Kepler.
     */
    this.clasificacionV = 'no_comprobable';
    this.clasificacion.set('no_comprobable');
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
    this.gasto.set(null); this.clearPhoto(); this.clearFile('solicitud_kepler'); this.sel = null; this.comentarios.set('');
    this.clasificacion.set(null); this.clasificacionV = null; this.formError.set('');
    this.formaPago.set(null); this.formaPagoDetalle.set(''); this.sellos.set({});
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
    this.miniaturas.update((m) => { const n = { ...m }; delete n[role]; return n; });
  }

  /** `[GX.14]` Guarda la foto recién tomada y dispara su lectura por visión. */
  private guardarCaptura(role: string, dataUri: string, capturedAt: string) {
    this.fileData[role] = dataUri;
    delete this.uploaded[role];
    // El nombre lo ponemos nosotros: no hay archivo de origen del cual tomarlo.
    const hora = new Date(capturedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    this.names.update((m) => ({ ...m, [role]: `Foto tomada ${hora}` }));
    this.miniaturas.update((m) => ({ ...m, [role]: dataUri }));
    this.sellos.update((m) => ({ ...m, [role]: { live: true, captured_at: capturedAt } }));
    // [GX.32] Acá se leía la foto recién tomada con Claude Vision. Se retiró.
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
      // [GX.24] La miniatura, solo si es imagen. Un PDF no la tiene y la pantalla lo DICE
      // con su icono: dejar el hueco se lee como «no cargo», que es otra cosa.
      if (dataUri.startsWith('data:image/')) this.miniaturas.update((m) => ({ ...m, [role]: dataUri }));
      // `[GX.32]` Acá se llamaba a `validate()` para que Claude Vision leyera la foto y
      // dijera si el monto cuadraba. Se retiró: la foto se adjunta y listo.
      this.cdr.markForCheck();
    };
    reader.readAsDataURL(file);
  }


  submit() {
    const g = this.gasto();
    if (!g) { this.formError.set('Elige el gasto.'); return; }
    if (this.modo() === 'evidencia') { this.submitEvidencia(g); return; }
    if (this.modo() !== 'capturar') return;
    // MOMENTO 1 — capturar la solicitud (firmada + clasificación). Sin evidencia.
    if (!this.clasificacion()) { this.formError.set('Elige el tipo de gasto.'); return; }
    // [GX.18] Se fue el freno de la solicitud firmada: ese paso ya no existe en la pantalla.
    // Y se fue el del motivo obligatorio, porque el «Vale autorizado» ahora lleva su foto.
    // [GX.14] Se frena ANTES de subir nada al bucket: mandar los bytes para que el 400
    // los rechace después deja archivos huérfanos pagados y a la persona esperando.
    const faltan = this.faltan();
    if (faltan.length) { this.formError.set(faltan.map((f) => f.motivo).join('. ')); return; }
    this.formError.set('');
    this.saving.set(true);
    /**
     * [GX.18] Sube lo que de verdad viaja: la foto del comprobante y -- si es ticket o
     * recibo -- la cotizacion.
     *
     * ⚠️ Antes esto subia SOLO `solicitud_kepler`, asi que la foto que la compuerta EXIGIA
     * se quedaba en memoria y `reset()` la tiraba: el expediente nacia sin la imagen por la
     * que se la habia pedido a la persona.
     */
    // [GX.23] Todas las que haya, no la primera de cada una.
    // `[GX.33]` Los documentos sueltos suben con el resto. Sin esto se quedaban en el
    // navegador: la pantalla los mostraba adjuntos y el expediente llegaba sin ellos.
    this.uploadThen([...ROLES_COMPROBANTE, ...ROLES_COTIZACION], () => this.createSolicitud(g));
  }

  // MOMENTO 3 — el gasto ya está aprobado y comprobable: sube la evidencia.
  private submitEvidencia(g: SelSolicitud) {
    const id = this.existing()?.id;
    if (!id) { this.formError.set('No encuentro el expediente aprobado. Vuelve a elegir el folio.'); return; }
    if (!this.fileData['comprobante_1'] && !this.uploaded['comprobante_1']) { this.formError.set('Sube la evidencia.'); return; }
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
    /**
     * `[GX.37]` **El motivo del servidor VIAJA.** Acá el `catchError` se comía el error y
     * la pantalla decía «No se pudo subir el archivo. Reintenta» para TODO. Medido en
     * local: el servidor contestaba «Almacenamiento no configurado (faltan env S3_*)» —
     * o sea, reintentar no iba a funcionar NUNCA, y la persona quedaba en un lazo
     * dándole al botón. Un mensaje que pide reintentar ante un problema que no se
     * arregla reintentando es peor que no decir nada: manda a perder el tiempo.
     */
    const ups = toUpload.map((r) => this.svc.uploadFile(this.fileData[r], r, this.sellos()[r]).pipe(
      map((file) => ({ role: r, file: file as ProofFile | null, motivo: '' })),
      catchError((e: { error?: { message?: string } }) => of({
        role: r, file: null as ProofFile | null,
        motivo: String(e?.error?.message || '').trim(),
      })),
    ));
    forkJoin(ups).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((results) => {
      for (const res of results) { if (res.file) { this.uploaded[res.role] = res.file; delete this.fileData[res.role]; } }
      const fallo = results.find((r) => !r.file);
      if (fallo) {
        this.saving.set(false);
        // El nombre del archivo, para que con varios adjuntos se sepa CUÁL falló.
        const cual = this.names()[fallo.role] ? ` («${this.names()[fallo.role]}»)` : '';
        this.formError.set(fallo.motivo
          ? `No se pudo subir el archivo${cual}: ${fallo.motivo}`
          : `No se pudo subir el archivo${cual}. Reintentá.`);
        return;
      }
      done();
    });
  }

  private createSolicitud(g: SelSolicitud) {
    const files = [...ROLES_COMPROBANTE, ...ROLES_COTIZACION]
      .map((r) => this.uploaded[r]).filter(Boolean) as ProofFile[];
    this.svc.create({
      folio_solicitud: g.folio, sucursal: g.sucursal || undefined,
      solicitante: g.solicitante || undefined, proveedor: g.beneficiario || undefined,
      fecha_gasto: g.fecha ? String(g.fecha).slice(0, 10) : undefined, importe: g.importe || undefined,
      clasificacion: this.clasificacion()!,
      forma_pago: this.formaPago() ?? undefined,
      forma_pago_detalle: this.formaPagoDetalle().trim() || undefined,
      /**
       * `[GX.57]` El concepto, siempre el que ESCRIBIÓ la persona.
       *
       * ⛔ Acá había un respaldo: `this.comentarios || (lleva ? g.concepto : undefined)` —
       * si la caja venía vacía se mandaba el concepto que traía el vale de Kepler. O sea
       * que el expediente guardaba un concepto que nadie tecleó, y el campo decía
       * «opcional» con razón. Con el concepto obligatorio ese respaldo no puede dispararse
       * nunca; dejarlo sería una rama muerta que aparenta cubrir algo.
       */
      comentarios: this.comentarios().trim(), files,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Enviada a aprobación', detail: `Solicitud ${g.folio}` }); this.uploaded = {}; this.reset(); this.loadMine(); },
      error: (e) => { this.saving.set(false); this.formError.set(e?.error?.message || 'No se pudo enviar.'); },
    });
  }

  private enviarEvidencia(id: string, g: SelSolicitud) {
    const files = [this.uploaded['comprobante_1']].filter(Boolean) as ProofFile[];
    // `[GX.32]` Ya no viajan `monto_ocr`, `subtotal_ocr` ni `receipt_legible`: los llenaba
    // la lectura por visión, que se retiró. El servidor tampoco los recibe.
    this.svc.addEvidence(id, {
      files, comentarios: this.comentarios().trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Evidencia enviada', detail: `Solicitud ${g.folio} · la revisa quien autoriza` }); this.uploaded = {}; this.reset(); this.loadMine(); },
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
  /**
   * [GX.28] El estado que Kepler le puso al vale. «c43» en el ERP, `estado` en la vista.
   *
   * Los cuatro valores están decodificados y documentados (`derivarEtapa` del expediente
   * usa los mismos). Un valor que no sea uno de esos se muestra CRUDO en vez de caer a
   * «desconocido»: si Kepler empieza a mandar una quinta letra, queremos verla, no que la
   * pantalla la esconda detrás de una palabra tranquilizadora.
   */
  estadoKepler(): { clave: string; label: string } | null {
    const e = String(this.gasto()?.estado || '').trim().toUpperCase();
    if (!e) return null;
    switch (e) {
      case 'N': return { clave: 'n', label: 'por ejercer' };
      case 'A': return { clave: 'a', label: 'autorizada' };
      case 'F': return { clave: 'f', label: 'aplicada' };
      case 'C': return { clave: 'c', label: 'cancelada' };
      default: return { clave: 'x', label: e };
    }
  }

  moneyFull(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
}
