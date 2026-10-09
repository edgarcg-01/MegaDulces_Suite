import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { firstValueFrom, timeout } from 'rxjs';
import {
  AndenValeEnCurso, ErpOrderMatch, ErpPendingBranch, ErpPendingMenu, OpenSessionDto, ReceivingSession, ReceivingSessionService,
} from '../receiving-session.service';
import { ReceivingAuditorService, ReceivingCapture } from '../receiving-auditor.service';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { BinLocationService, WarehouseFreeze } from '../bin-location.service';
import { siguientePaso, avance, motivoNoCerrable, FlujoEstado, FlujoAvance } from './anden-flujo';
import { AndenState, AndenLinea } from './anden.state';
import { AndenDraftService } from './anden-draft.service';
import { AndenFolioComponent } from './components/anden-folio.component';
import { AndenSucursalesComponent } from './components/anden-sucursales.component';
import { AndenValesComponent } from './components/anden-vales.component';
import { AndenEnCursoComponent } from './components/anden-en-curso.component';
import { AndenCaducidadComponent, FechadoConfirmado, FechadoEntrada } from './components/anden-caducidad.component';
import { AndenFechaMasivaComponent, AvanceMasivo, FechadoMasivo } from './components/anden-fecha-masiva.component';
import { AndenCongeladoComponent } from './components/anden-congelado.component';
import { motivoHttp, type ErrorHttpLike } from '../shared/http-motivo';
import { ScanFieldComponent } from './components/scan-field.component';
import { formatExpiryEcho } from '../shared/expiry-short';
import { unidadDelVale } from '../shared/unidad-vale';
import { Buscable, coincide, normalizar } from './filtro.util';
import { AndenRedComponent } from './components/anden-red.component';
import { AndenOfflineService, EnvioVale } from './anden-offline.service';
import {
  TOPE, esLocal, esSinRed, incompletosLocales, menuDesdePaquetes, mismoDocumento, nuevaLlave, valeLocal,
  valesDisponibles,
} from './anden-offline';
import { hoyMexico } from './dia-mx';

/**
 * **Andén de Entrada** — del folio del papel a la mercancía con lote y caducidad.
 *
 * Con el folio aparece el vale de Kepler con sus renglones. Lo único que se
 * captura es lote, caducidad y cuántas piezas llegaron — y cuando toda la entrega
 * caduca el mismo día (el caso normal de un proveedor) se captura **una vez para
 * todos**. Ahí entra la mercancía a existencia.
 *
 * `[WMS-REC.21]` **Acomodar ya no vive acá.** Hasta el 2026-10-07 el Andén tenía una
 * segunda sección, *Ubicación*, que mandaba cada lote recién fechado a su rack
 * (regla R2 de `anden-flujo`, decisión de negocio del 2026-09-23). Se separó a
 * pedido de quien recibe: con el camión enfrente se fecha, y acomodar es otro
 * trabajo que se hace cuando se puede, en Ubicaciones («Por acomodar»). Lo fechado
 * sin lugar no se pierde: esa cola es del almacén y la arma el servidor.
 *
 * **Fechar es contar.** No hay un paso de cotejo aparte: la cantidad declarada al
 * fechar es la recibida y se escribe en `received_qty` cuando el renglón queda
 * cerrado. Eso es lo que mantiene vivos los reclamos de WMS-REC.8 — el faltante
 * contra Kepler se sigue viendo, y se levanta al cerrar el vale.
 *
 * El paso activo **no vive en la ruta**: es estado de pantalla. En la URL, el back
 * del navegador rompería el flujo a media captura.
 *
 * `[WMS-REC.20]` **Sin conexión se sigue trabajando.** Lo que se hace se guarda en el equipo
 * y se manda solo al volver la red (`AndenOfflineService`); el vale se puede abrir sin red desde
 * los vales que el equipo bajó con red. Cada escritura lleva su llave desde el primer intento, así
 * que reintentarla nunca duplica (WMS-REC.19).
 */
@Component({
  selector: 'app-anden',
  standalone: true,
  imports: [
    DecimalPipe, ButtonModule, ToastModule,
    RouterLink,
    AndenFolioComponent, AndenSucursalesComponent, AndenValesComponent, AndenEnCursoComponent, AndenCongeladoComponent,
    AndenCaducidadComponent, AndenFechaMasivaComponent, ScanFieldComponent, AndenRedComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="an">
      <p-toast />

      <header class="an-hd">
        <div class="an-id">
          <span class="an-fol">{{ s.abierto() ? s.vale()!.folio : '—' }}</span>
          <span class="an-prov">{{ s.proveedor() }}</span>
        </div>
        <div class="an-pills">
          @if (s.origen(); as o) {
            <span class="an-pill an-org" [class.an-tr]="o.kind === 'transfer'">{{ o.label }}</span>
          }
          <span class="an-pill" [class.an-on]="s.cerrado()">{{ s.estado() }}</span>
          @if (valeEnCola()) { <span class="an-pill an-cola">por mandar</span> }
          @if (s.guardado()) { <span class="an-save">Guardado ✓</span> }
        </div>
      </header>

      <!-- [WMS-REC.20] Sin conexion se sigue trabajando: esto dice que falta mandar y deja
           reintentar o descartar un vale que el servidor rechazo. -->
      <app-anden-red
        [online]="red.online()" [enviando]="red.enviando()" [pendientes]="red.pendientes()"
        [errores]="red.conError()" [paqueteAl]="paqueteAl()"
        (enviar)="mandarAhora()" (reintentar)="reintentarVale($event)" (descartar)="descartarVale($event)" />

      <!-- [WMS-REC.17] Cambiar de camion. Llega otro camion mientras se fecha este: el
           bodeguero sale al menu, lo atiende y vuelve. Lo ya fechado vive en el servidor,
           asi que salir no pierde nada; el vale queda en Incompletos. Solo se pide
           confirmacion si hay un renglon abierto, que es lo unico que todavia no se guardo. -->
      @if (s.abierto()) {
        @if (confirmandoCambio()) {
          <div class="an-cambio" role="alertdialog" aria-label="Cambiar de camión">
            <p>
              <b>{{ s.vale()!.folio }}</b> queda <b>en curso</b>: lo ya fechado está guardado y lo
              retomas desde el menú. Lo que estás escribiendo en este renglón y no guardaste se pierde.
            </p>
            <div class="an-cambio-bt">
              <button pButton type="button" size="small" (click)="cambiarDeCamion()">Ir a otro camión</button>
              <button pButton type="button" size="small" [text]="true" severity="secondary"
                (click)="confirmandoCambio.set(false)">Seguir aquí</button>
            </div>
          </div>
        } @else {
          <button type="button" class="an-volver an-cambiar" (click)="pedirCambio()">← Cambiar de camión</button>
        }
      }

      <!-- El avance del vale, siempre a la vista. Desde WMS-REC.21 cuenta sólo lo
           fechado: acomodar se sigue en Ubicaciones, sección Por acomodar. -->
      @if (s.abierto() && !congelado()?.frozen) {
        <div class="an-prog">
          <div class="an-prog-bar" role="img"
            [attr.aria-label]="'Avance: ' + (avanceVale().fraccion * 100 | number: '1.0-0') + ' por ciento'">
            <span class="an-prog-ok" [style.width.%]="avanceVale().fraccion * 100"></span>
          </div>
          <div class="an-prog-tx">
            <span><b>{{ avanceVale().renglonesListos }}</b> de {{ avanceVale().renglonesTotales }} fechados</span>
            @if (avanceVale().todoListo) {
              <span class="an-prog-ok-tx">todo fechado</span>
            }
          </div>
        </div>
      }

      <main class="an-bd">
        @if (congelado(); as cg) {
          @if (cg.frozen) {
            <!-- R1 — se sabe ANTES de capturar. El guard del servidor sigue siendo
                 la red de seguridad; esto sólo evita que el operario escriba una
                 captura entera para que el guardado la rechace.
                 WMS-REC.16: además de explicar, ahora OFRECE LA SALIDA. Antes el único
                 botón era Salir, y el folio que motivó esto llevaba 100 días acá. -->
            <app-anden-congelado
              [freeze]="cg"
              [puedeCancelar]="puedeCancelarConteo()"
              [cancelando]="cancelandoConteo()"
              (cancelar)="cancelarConteo($event)"
              (salir)="otroCamion()" />
          }
        }
        @if (congelado()?.frozen) {
          <!-- cuerpo bloqueado a propósito -->
        } @else {
          @if (!s.abierto() && modo() === 'inicio') {
            <!-- Los dos trabajos del almacén, separados en la portada: son
                 distintos y los hace gente distinta. Acomodar se hace
                 cualquier día; dar de alta, sólo cuando llega un camión.
                 WMS-REC.21: acomodar lleva a Ubicaciones, donde vive ahora. -->
            <div class="an-inicio">
              <a class="an-card" routerLink="/almacen/inventory/ubicaciones">
                <span class="an-card-ic an-card-ic--suave" aria-hidden="true">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="6" rx="1"></rect>
                    <rect x="3" y="9" width="18" height="6" rx="1"></rect>
                    <rect x="3" y="15" width="18" height="6" rx="1"></rect>
                  </svg>
                </span>
                <span class="an-card-tx">
                  <b>Acomodar mercancía</b>
                  <small>Lo ya fechado que todavía no tiene lugar, para dejarlo en su rack o tarima.</small>
                </span>
              </a>

              <button type="button" class="an-card an-card--go" (click)="irAAlta()">
                <span class="an-card-ic" aria-hidden="true">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="17" rx="2"></rect>
                    <path d="M16 2v4"></path><path d="M8 2v4"></path>
                    <path d="M3 10h18"></path><path d="M9 15h6"></path>
                  </svg>
                </span>
                <span class="an-card-tx">
                  <b>Dar de alta caducidades</b>
                  <small>Del folio del vale a la mercancía con lote y caducidad.</small>
                </span>
              </button>
            </div>
          } @else if (!s.abierto() && modo() === 'alta') {
            <!-- Paso 0: a qué sucursal entra la mercancía. Antes acá se
                 tecleaba el folio del papel; ahora el folio es el respaldo. -->
            <button type="button" class="an-volver" (click)="modo.set('inicio')">← Menú</button>
            <app-anden-en-curso
              [vales]="enCurso()" [abriendo]="s.cargando()" [error]="errorEnCurso()"
              [porEnviar]="red.valesEnCola()"
              (retomar)="retomar($event)" />
            <app-anden-sucursales
              [sucursales]="sucursales()" [cargando]="cargandoMenu()" [error]="errorMenu()"
              [alcanceAbierto]="alcanceAbierto()"
              (elegir)="elegirSucursal($event)" (verFolio)="modo.set('folio')"
              (reintentar)="cargarSucursales()" />
          } @else if (!s.abierto() && modo() === 'vales') {
            <app-anden-vales
              [sucursal]="sucursalElegida()!" [vales]="valesDelDia()"
              [cargando]="cargandoVales()" [abriendo]="s.cargando()" [error]="errorVales()"
              (abrir)="abrirVale($event)" (volver)="volverASucursales()"
              (reintentar)="elegirSucursal(sucursalElegida()!)" />
          } @else if (!s.abierto()) {
            <button type="button" class="an-volver" (click)="volverASucursales()">← Sucursales</button>
            <app-anden-folio
              [folio]="s.folio()" [buscando]="s.buscando()" [candidatos]="s.candidatos()"
              (folioChange)="s.folio.set($event)" (buscar)="buscar()" (elegir)="abrirVale($event)" />
          } @else if (masiva()) {
            <app-anden-fecha-masiva #masivo
              [lineas]="s.pendientesFechar()" [avance]="avance()"
              (aplicar)="fecharTodo($event)" (volver)="cerrarMasiva()" />
          } @else if (s.actual(); as l) {
            <app-anden-caducidad #fechar
              [linea]="l" [minShelfLife]="minShelfLife()" [existingMinExpiry]="existingMinExpiry()"
              [guardando]="s.guardando()"
              (pedirOcr)="correrOcr($event)" (confirmar)="confirmarFechado($event)"
              (cerrarRenglon)="cerrarRenglon($event)" (volver)="volverALista()" />
          } @else if (!s.pendientesFechar().length) {
            <div class="an-fin">
              <div class="an-big">✓</div>
              <h2>Todo fechado</h2>
              <p>
                {{ s.unidades() | number }} piezas entraron con lote y caducidad.
                @if (s.cerrado()) { El vale quedó cerrado. }
                @else { Lo que falte acomodar se ve en Ubicaciones, en «Por acomodar». }
              </p>
              @if (!s.cerrado()) {
                <button pButton type="button" [loading]="s.guardando()" (click)="cerrarVale()">
                  Cerrar el vale
                </button>
              }
              <button pButton type="button" [text]="true" severity="secondary" (click)="otroCamion()">
                Recibir otro camión
              </button>
            </div>
          } @else {
            <p class="an-nota">
              Captura lote y caducidad de cada renglón. La cantidad viene con lo que manda
              Kepler: <b>corrígela si llegó de menos</b>, porque de ahí sale el reclamo.
            </p>

            <!-- El caso normal de una entrega es una sola fecha para toda la tarima.
                 Va arriba de la lista porque resuelve el vale entero de un golpe. -->
            <button pButton type="button" class="an-masiva" [outlined]="true" (click)="masiva.set(true)">
              Todos caducan el mismo día →
            </button>

            <app-scan-field
              [valor]="consulta()" [visibles]="visFechar().length" [total]="s.pendientesFechar().length"
              [refocoTick]="refoco()"
              etiqueta="Escanear o buscar"
              placeholder="Escanea la caja o busca por nombre"
              (valorChange)="consulta.set($event)" (enter)="enter()"
              (sinCamara)="avisarCamara($event)" />

            @if (sinCoincidencias(visFechar())) {
              <!-- Salida accionable: que un producto no esté en el vale no
                   significa que no haya llegado. Se resuelve el código contra
                   el catálogo y se fecha igual, sin renglón: la captura suelta
                   ya es válida en el backend. -->
              <div class="an-vacio">
                <p class="an-vacio-t">
                  Nada por fechar coincide con <b>«{{ consulta() }}»</b>. Puede que ya esté
                  fechado, o que haya llegado sin venir en el vale.
                </p>
                <button pButton type="button" [outlined]="true" [loading]="resolviendo()"
                  (click)="fecharSuelto()">
                  Buscar «{{ consulta() }}» en el catálogo y fecharlo
                </button>
              </div>
            }

            <ul class="an-lista">
              @for (l of visFechar(); track l.id) {
                <li><button type="button" class="an-row" (click)="abrirFechar(l)">
                  <span class="an-row-nm">{{ nombre(l) }}</span>
                  <span class="an-row-sk">
                    {{ l.sku || l.expected_sku || '—' }} ·
                    @if (l.declarado > 0) { faltan {{ l.faltaFechar | number }} de {{ +l.expected_qty | number }} }
                    @else { sin fecha · lote NA }
                  </span>
                  <span class="an-row-qt">{{ l.faltaFechar | number }}</span>
                </button></li>
              }
            </ul>
          }
        }
      </main>
    </div>
  `,
  styles: [`
    /* Los colores salen SIEMPRE del token, nunca de un hex: la paleta clara vive
       en tokens.css y el bloque oscuro sólo redefine los mismos nombres. Un color
       declarado únicamente para un tema pinta texto de un tema sobre el fondo del
       otro, y eso no se ve hasta que alguien cambia el tema en producción. */
    :host { display: block; min-height: 100dvh; background: var(--surface-layout, var(--surface-ground)); }
    .an { max-width: min(560px, 100vw); margin: 0 auto; padding: var(--sp-3) var(--sp-3) var(--sp-8); }
    .an-hd {
      display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-3);
      padding-bottom: var(--sp-2);
    }
    .an-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

    /* Avance del vale: las dos mitades del trabajo en una barra. */
    .an-prog { display: flex; flex-direction: column; gap: var(--sp-1); padding-bottom: var(--sp-2); }
    .an-prog-bar { height: 6px; border-radius: 999px; background: var(--surface-200, #f0efed); overflow: hidden; }
    .an-prog-ok { display: block; height: 100%; background: var(--tone-ok, #15803d); transition: width .2s ease; }
    .an-prog-tx { display: flex; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .an-prog-tx b { color: var(--text-main); font-variant-numeric: tabular-nums; }
    .an-prog-ok-tx { color: var(--tone-ok, #15803d); }

    /* Almacén congelado: el cuerpo entero se reemplaza, no es un aviso al costado. */
    .an-frio { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4) 0; }
    .an-frio-hd { display: flex; gap: var(--sp-3); align-items: flex-start; color: var(--tone-bad, #b42318); }
    .an-frio-hd svg { flex: 0 0 auto; margin-top: 2px; }
    .an-frio-hd h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--text-main); line-height: 1.2; }
    .an-frio-hd p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); line-height: 1.45; color: var(--text-muted); }
    .an-frio-fol { padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .an-frio-lbl { display: block; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      letter-spacing: .07em; text-transform: uppercase; color: var(--text-muted); }
    .an-frio-fol strong { display: block; margin-top: 4px; font-family: var(--font-mono, monospace);
      font-size: var(--fs-h3); font-variant-numeric: tabular-nums; }
    .an-frio-sal { margin: 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-muted); }
    .an-frio-sal b { color: var(--text-main); }

    /* Portada: los dos trabajos del almacén. */
    .an-inicio { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-3); }
    .an-card {
      display: flex; align-items: center; gap: var(--sp-3); width: 100%;
      padding: var(--sp-4); text-align: left; text-decoration: none; cursor: pointer;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-lg, 14px); color: var(--text-main); font: inherit;
    }
    .an-card--go { border-color: var(--action); border-width: 2px; }
    .an-card-ic {
      flex: 0 0 auto; width: 52px; height: 52px; display: flex; align-items: center; justify-content: center;
      border-radius: var(--r-md); background: var(--action); color: #fff;
    }
    .an-card-ic--suave { background: var(--card-bg); border: 1px solid var(--border-color); color: var(--action); }
    .an-card-tx { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .an-card-tx b { font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .an-card-tx small { font-size: var(--fs-xs); line-height: 1.4; color: var(--text-muted); }
    .an-volver {
      align-self: flex-start; min-height: 36px; padding: 0 var(--sp-2); margin-bottom: var(--sp-2);
      background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      color: var(--text-muted); font: inherit; font-size: var(--fs-xs); cursor: pointer;
    }
    /* Cambiar de camion: el mismo boton de volver del resto del Anden, a la vista siempre. */
    .an-cambiar { display: block; margin: 0 0 var(--sp-2); }
    .an-cambio {
      display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-2);
      padding: var(--sp-2) var(--sp-3); background: var(--card-bg);
      border: 1px solid var(--border-color); border-left: 3px solid var(--action); border-radius: var(--r-sm);
    }
    .an-cambio p { margin: 0; font-size: var(--fs-xs); line-height: 1.45; color: var(--text-muted); }
    .an-cambio b { color: var(--text-main); }
    .an-cambio-bt { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .an-fol { font-size: var(--fs-h3); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .an-prov { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
    .an-pills { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; }
    .an-pill {
      font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .07em; text-transform: uppercase;
      padding: 3px 8px; border-radius: var(--r-pill);
      /* Chip NEUTRO para "en captura", no azul. DESIGN.md mata el azul en la paleta,
         y además el color acá tiene que significar algo: neutro = en curso,
         verde = cerrado. Dos chips de color distinto para dos estados que no son
         opuestos era ruido. */
      background: var(--surface-ground); color: var(--text-muted);
      border: 1px solid var(--border-color);
    }
    .an-on { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border-color: transparent; }
    /* El origen NO usa el verde de "listo" ni el naranja de acción: no es un
       estado ni una acción, es una clasificación. Traspaso lleva el ámbar de
       "ojo con esto" porque el reclamo es interno; proveedor queda neutro. */
    .an-org { font-weight: var(--fw-bold); }
    .an-tr { background: var(--warn-soft-bg); color: var(--warn-fg); border-color: transparent; }
    /* [WMS-REC.20] Algo de este vale se hizo sin conexion y no se ha mandado. */
    .an-cola { background: var(--warn-soft-bg); color: var(--warn-fg); border-color: transparent; }
    .an-save { font-size: var(--fs-micro); color: var(--text-faint); }
    .an-bd { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
    .an-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .an-nota b { color: var(--text-main); }
    .an-masiva { width: 100%; min-height: 50px; font-weight: var(--fw-bold); }
    /* El vacío por filtro dice qué hacer. "Sin resultados" a secas deja al
       bodeguero parado con el producto en la mano y sin salida. */
    .an-vacio {
      margin: 0; padding: var(--sp-3);
      background: var(--warn-soft-bg, var(--card-bg));
      border: 1px dashed var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45;
    }
    .an-vacio b { color: var(--text-main); }
    .an-vacio-t { margin: 0 0 var(--sp-2); }
    .an-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .an-row {
      display: grid; grid-template-columns: 1fr auto; gap: 2px var(--sp-3); align-items: center;
      width: 100%; min-height: 52px; padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
    }
    .an-row:hover { border-color: var(--action); }
    .an-row-nm { font-size: var(--fs-sm); font-weight: var(--fw-medium); min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .an-row-sk { font-size: var(--fs-micro); color: var(--text-faint); grid-column: 1; }
    .an-row-qt { grid-column: 2; grid-row: 1 / 3; align-self: center; font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums; }
    .an-fin { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      text-align: center; padding: var(--sp-8) var(--sp-3); }
    .an-big { font-size: 48px; font-weight: var(--fw-black); line-height: 1; color: var(--ok-fg); }
    .an-fin h2 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); }
    .an-fin p { margin: 0 0 var(--sp-2); max-width: 32ch; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class AndenComponent implements OnInit {
  private readonly sessions = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly binsSvc = inject(BinLocationService);
  private readonly drafts = inject(AndenDraftService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  /** `[WMS-REC.20]` La cola de lo hecho sin conexión. */
  readonly red = inject(AndenOfflineService);
  /** Cuándo se bajaron los vales que se están usando sin red (ISO), para decirlo. */
  readonly paqueteAl = signal<string | null>(null);
  /** Cómo llama la cola al vale abierto (su id, o `local:…` si se abrió sin red). */
  private readonly llaveActual = signal<string | null>(null);
  /** El vale abierto tiene algo hecho sin conexión que todavía no se manda. */
  readonly valeEnCola = computed(() => {
    const k = this.llaveActual();
    return !!k && !!this.s.vale() && (esLocal(k) || this.red.valesEnCola().has(k));
  });

  readonly s = new AndenState();
  readonly minShelfLife = signal<number | null>(null);
  readonly existingMinExpiry = signal<string | null>(null);

  /** Panel de "todos caducan el mismo día" abierto. */
  readonly masiva = signal(false);
  readonly avance = signal<AvanceMasivo | null>(null);

  /**
   * Lo tecleado o disparado en la barra única. **Una sola por sección**, y la
   * misma para escanear y para buscar: dos campos peleándose el foco es lo que
   * rompe una pistola en modo wedge.
   */
  readonly consulta = signal('');
  /** Se incrementa para devolverle el foco a la barra tras guardar o cerrar panel. */
  readonly refoco = signal(0);

  /**
   * Portada o alta. Vive en la pantalla y no en la ruta, igual que la sección:
   * el back del navegador a media captura rompe el flujo.
   */
  /**
   * Dónde está parado el operario antes de tener un vale abierto.
   *
   * `alta` ya no es el campo de folio: es el MENÚ de sucursales. El folio pasó a
   * ser `folio`, un respaldo al que se llega a propósito — sigue existiendo
   * porque el papel puede llegar antes que Kepler, y porque con la regla de
   * sólo-hoy hay días en que el menú sale vacío.
   */
  readonly modo = signal<'inicio' | 'alta' | 'vales' | 'folio'>('inicio');

  // ── El menú de sucursales (paso 0) ───────────────────────────────────────
  readonly sucursales = signal<ErpPendingBranch[]>([]);
  readonly cargandoMenu = signal(false);
  readonly errorMenu = signal<string | null>(null);
  /** El alcance del usuario no acota nada: la pantalla lo dice en vez de fingirlo. */
  readonly alcanceAbierto = signal(false);

  /**
   * `[WMS-REC.17]` Vales abiertos sin cerrar: a donde se vuelve despues de atender otro
   * camion. Se piden con el menu, porque otra persona pudo abrir o cerrar uno desde otro equipo.
   */
  readonly enCurso = signal<AndenValeEnCurso[]>([]);
  readonly errorEnCurso = signal<string | null>(null);
  /** Pidiendo confirmacion para salir del vale con un renglon a medio capturar. */
  readonly confirmandoCambio = signal(false);

  readonly sucursalElegida = signal<ErpPendingBranch | null>(null);
  readonly valesDelDia = signal<ErpOrderMatch[]>([]);
  readonly cargandoVales = signal(false);
  readonly errorVales = signal<string | null>(null);

  /**
   * Si el almacén del vale está congelado por un inventario físico.
   * `null` = todavía no se preguntó (o la consulta falló, y ahí NO se bloquea:
   * el guard del servidor sigue siendo el que frena de verdad).
   */
  readonly congelado = signal<WarehouseFreeze | null>(null);
  /** Cancelando el conteo que congela el almacén. */
  readonly cancelandoConteo = signal(false);

  /**
   * Si quien mira puede destrabar el almacén él mismo.
   *
   * Dos llaves a propósito: `RECONCILIAR` (quien siempre pudo) y `CANCELAR_CONTEO`
   * (WMS-REC.16, la llave acotada que sólo abandona y nunca ajusta). El servidor
   * vuelve a decidir — esto sólo evita ofrecer un botón que iba a dar 403.
   *
   * ⚠️ Lee del JWT, así que un permiso recién repartido **exige re-loguear** para
   * que el botón aparezca. El backend lo honra antes, porque lee de la DB.
   */
  readonly puedeCancelarConteo = computed(() => {
    const p = this.auth.user()?.permissions;
    return this.perms.isAdmin()
      || p?.[Permission.COMMERCIAL_INVENTORY_RECONCILIAR] === true
      || p?.[Permission.COMMERCIAL_INVENTORY_CANCELAR_CONTEO] === true;
  });

  /** Resolviendo un código que no está en el vale contra el catálogo. */
  readonly resolviendo = signal(false);

  private readonly fechar = viewChild<AndenCaducidadComponent>('fechar');
  private readonly masivo = viewChild<AndenFechaMasivaComponent>('masivo');

  constructor() {
    // [WMS-REC.20] Cuando la cola manda algo, la pantalla lo dice y, si es el vale abierto, lo recarga.
    effect(() => {
      const r = this.red.ultimoEnvio();
      if (r) untracked(() => void this.alMandar(r));
    });
  }

  ngOnInit(): void {
    // Si este equipo dejó un vale a medias, se retoma donde estaba. Es la razón
    // de existir del borrador: el bodeguero no vuelve a capturar lo ya capturado.
    // `[WMS-REC.20]` Sin red se recupera de lo que guardó el equipo, y el borrador SÓLO se borra
    // si el vale de verdad ya no existe: antes se borraba ante cualquier error, y abrir la
    // pantalla sin internet perdía el vale a medias.
    this.drafts.ultimoAbierto().then((b) => {
      if (!b) return;
      this.cargarDetalle(
        b.sessionId,
        () => {
          this.s.guardado.set(true);
          this.toast.add({ severity: 'info', summary: 'Vale recuperado', detail: `${this.s.vale()?.folio} — sigue donde lo dejaste.` });
        },
        () => this.drafts.borrar(b.sessionId),
      );
    });
  }

  nombre(l: AndenLinea): string {
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  }

  // ── Barra única ───────────────────────────────────────────────────────────

  /** Qué campos de la línea ve la barra. */
  private buscable(l: AndenLinea): Buscable {
    return {
      nombre: this.nombre(l),
      sku: l.sku || l.expected_sku,
      barcode: l.barcode_scanned,
      rack: l.binSugerido,
    };
  }

  readonly visFechar = computed(() => {
    const q = this.consulta();
    const ls = this.s.pendientesFechar();
    if (!normalizar(q)) return ls;
    return ls.filter((l) => coincide(this.buscable(l), q));
  });

  /** Vacío por filtro (hay que decir algo) vs. vacío real (ya hay otra pantalla). */
  sinCoincidencias(vis: unknown[]): boolean {
    return !!normalizar(this.consulta()) && !vis.length;
  }

  /**
   * Enter, tanto del disparo de la pistola como del teclado. **Una sola
   * coincidencia abre ese renglón**: apuntar y disparar es el gesto completo.
   * Con varias no se adivina — se deja el filtro puesto y el operario elige.
   */
  enter(): void {
    if (!normalizar(this.consulta())) return;
    const vis = this.visFechar();
    if (vis.length === 1) this.abrirFechar(vis[0]);
  }

  /**
   * **Fechar algo que no viene en el vale.**
   *
   * Pasa seguido: llegó mercancía que el vale de Kepler no trae, o el renglón ya
   * se fechó y quedó otra tarima del mismo SKU. Antes no había salida — la lista
   * solo muestra renglones del vale, así que el operario se quedaba con la caja
   * en la mano.
   *
   * El código se resuelve contra el catálogo (necesita `product_id` real; el
   * resolvedor de Conteo devuelve null y no sirve acá) y se abre el mismo panel
   * de lote/caducidad/foto. Se guarda **sin renglón**: `receiving_line_id` es
   * nullable a propósito desde WMS-REC.4, la captura suelta siempre fue válida.
   *
   * El almacén sale del vale abierto, que es lo que evita volver a preguntarlo.
   */
  fecharSuelto(): void {
    const codigo = this.consulta().trim();
    if (!codigo || this.resolviendo()) return;
    this.resolviendo.set(true);
    this.auditor.resolveForDating(codigo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.resolviendo.set(false);
        // Se arma una línea sintética: el panel de fechado pide una `AndenLinea`,
        // y sin `id` real el guardado sabe que va sin renglón.
        const suelta = {
          id: '',
          product_id: p.product_id,
          sku: p.sku,
          product_name: p.product_name,
          expected_qty: 0,
          declarado: 0,
          retenido: 0,
          faltaFechar: 0,
          uxc: null,
          binSugerido: null,
        } as unknown as AndenLinea;
        this.s.actual.set(suelta);
        this.limpiarBarra();
        this.cargarContexto(suelta);
        this.toast.add({
          severity: 'info',
          summary: 'Fuera del vale',
          detail: `${p.product_name || p.sku} se va a fechar sin renglón. Quedará como captura suelta.`,
        });
      },
      error: (e) => {
        this.resolviendo.set(false);
        if (esSinRed(e)) {
          this.toast.add({
            severity: 'warn', summary: 'Sin conexión',
            detail: 'Lo que no viene en el vale se busca en el catálogo: hazlo cuando vuelva la red.',
          });
          return;
        }
        this.toast.add({
          severity: 'warn',
          summary: 'No se encontró',
          detail: e?.error?.message || `Ningún producto del catálogo tiene el código ${codigo}.`,
        });
      },
    });
  }

  /** La cámara no abrió: se dice por qué, no se deja un botón mudo. */
  avisarCamara(motivo: string): void {
    this.toast.add({ severity: 'warn', summary: 'Cámara', detail: motivo });
  }

  /** Al abrir un renglón la consulta ya cumplió: se limpia para el siguiente. */
  private limpiarBarra(): void {
    this.consulta.set('');
  }

  /** Al volver a la lista, el foco vuelve a la barra sin que nadie la toque. */
  private volverALaBarra(): void {
    this.limpiarBarra();
    this.refoco.update((n) => n + 1);
  }

  private guardarBorrador(): void {
    const b = this.s.aBorrador();
    if (!b) return;
    this.drafts.guardar(b).then((ok) => this.s.guardado.set(ok));
  }

  /**
   * El estado que la decisión necesita, reducido. Se arma acá y se le pasa a
   * `anden-flujo`, que es puro y está probado aparte: la pantalla no vuelve a
   * decidir nada por su cuenta.
   */
  private flujo(): FlujoEstado {
    return {
      valeAbierto: this.s.abierto(),
      valeCerrado: this.s.cerrado(),
      congeladoPorFolio: this.congelado()?.frozen ? (this.congelado()?.folio ?? 'sin folio') : null,
      lineas: this.s.lineas().map((l) => ({ id: l.id, faltaFechar: l.faltaFechar })),
    };
  }

  readonly avanceVale = computed<FlujoAvance>(() => avance({
    valeAbierto: this.s.abierto(),
    valeCerrado: this.s.cerrado(),
    congeladoPorFolio: null,
    lineas: this.s.lineas().map((l) => ({ id: l.id, faltaFechar: l.faltaFechar })),
  }));

  /**
   * **Qué sigue después de guardar**: el siguiente renglón por fechar, sin
   * devolver al operario a la lista. Lo decide `anden-flujo`, que es puro.
   * `[WMS-REC.21]` Ya no salta a acomodar el lote recién fechado: eso pasó a
   * Ubicaciones, sección «Por acomodar».
   */
  private avanzar(): void {
    const paso = siguientePaso(this.flujo());
    if (paso.tipo !== 'fechar') return;
    const l = this.s.lineas().find((x) => x.id === paso.lineaId);
    if (l) this.abrirFechar(l);
  }

  /** Por qué no se puede cerrar todavía. `null` = se puede. */
  motivoCierre(): string | null {
    return motivoNoCerrable(this.flujo());
  }

  // ── Identificación del vale ───────────────────────────────────────────────

  buscar(): void {
    const folio = this.s.folio().trim();
    if (!folio) return;
    this.s.buscando.set(true);
    this.sessions.searchErpOrders(folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ms) => {
        this.s.buscando.set(false);
        this.s.candidatos.set(ms || []);
        if (!ms?.length) {
          this.toast.add({ severity: 'warn', summary: 'Sin resultados', detail: `Kepler no tiene el vale ${folio}.` });
          return;
        }
        if (ms.length === 1) this.abrirVale(ms[0]);
      },
      error: (e) => {
        this.s.buscando.set(false);
        this.toast.add({
          severity: 'error', summary: esSinRed(e) ? 'Sin conexión' : 'Error',
          detail: esSinRed(e)
            ? 'Buscar por folio necesita red. Sin conexión, abre el vale desde el menú de la sucursal.'
            : e?.error?.message || 'No se pudo buscar el vale',
        });
      },
    });
  }

  abrirVale(m: ErpOrderMatch): void {
    this.s.erp.set(m);
    this.s.cargando.set(true);
    // El almacén NO se manda: lo deriva el backend (mapa sucursal→almacén, o el destino del
    // traspaso). `[WMS-REC.17]` Un traspaso se abre desde el EMBARQUE de quien mandó: ahí
    // `sucursal` es el origen y la serie es parte de la llave (el folio se repite entre series).
    // `[WMS-REC.20]` La llave va desde el PRIMER intento: si la respuesta se pierde y se reintenta
    // (o se encola), el servidor devuelve el mismo vale en vez de abrir otro.
    const llave = nuevaLlave();
    const dto: OpenSessionDto & { client_uuid: string } = m.fuente === 'embarque'
      ? { source_kind: 'erp_transfer', erp_sucursal: m.sucursal, erp_serie: m.serie ?? undefined, erp_folio: m.folio, client_uuid: llave }
      : { source_kind: 'erp_receipt', erp_sucursal: m.sucursal, erp_folio: m.folio, client_uuid: llave };
    if (sinRedDelTodo()) {
      void this.abrirSinRed(m, dto);
      return;
    }
    this.sessions.open(dto)
      .pipe(timeout(TOPE.escritura), takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (v) => {
          this.red.marcarConRed();
          this.cargarDetalle(v.id);
        },
        error: (e) => {
          if (esSinRed(e)) {
            this.red.marcarSinRed();
            void this.abrirSinRed(m, dto);
            return;
          }
          this.s.cargando.set(false);
          const dup = /ya.*recib/i.test(e?.error?.message || '');
          this.toast.add({
            severity: dup ? 'warn' : 'error',
            summary: dup ? 'Ese folio ya tiene vale' : 'Error',
            detail: e?.error?.message || 'No se pudo abrir el vale',
          });
        },
      });
  }

  /**
   * `[WMS-REC.20]` **Abrir sin red.** El vale se arma de los que el equipo bajó con red (el paquete
   * de la sucursal) y se encola su apertura con la MISMA llave que ya se intentó: si el servidor sí
   * la recibió, al reintentar devuelve ese vale en vez de abrir otro.
   */
  private async abrirSinRed(m: ErpOrderMatch, dto: OpenSessionDto & { client_uuid: string }): Promise<void> {
    const suc = this.sucursalElegida()?.sucursal ?? m.sucursal;
    const p = await this.red.paquete(suc);
    const pv = p?.vales.find((x) => mismoDocumento(x, m));
    if (!pv) {
      this.s.cargando.set(false);
      this.toast.add({
        severity: 'warn', summary: 'Sin conexión',
        detail: `${m.folio} no está entre los vales que este equipo bajó. Se puede abrir cuando vuelva la red.`,
        life: 7000,
      });
      return;
    }
    const vale = valeLocal(pv, dto.client_uuid);
    await this.red.guardarValeLocal(vale, { sucursal: suc, erp: m });
    await this.red.encolar({ tipo: 'abrir', valeKey: vale.id, dto });
    this.s.cargando.set(false);
    await this.mostrar(vale);
    this.toast.add({
      severity: 'info', summary: 'Abierto sin conexión',
      detail: `${m.folio}: se puede fechar igual. Se manda solo al servidor cuando vuelva la red.`,
      life: 7000,
    });
  }

  /**
   * Carga un vale y lo pone en pantalla. `[WMS-REC.20]` Con red, del servidor (y queda como su
   * base en el equipo); sin red, de lo que guardó el equipo. En los dos casos lo que falta mandar
   * va encima: sin eso, lo fechado sin conexión desaparecería y el bodeguero lo fecharía otra vez.
   *
   * `siNoExiste` sólo se llama cuando el vale de verdad no está — nunca por una caída de red.
   */
  private cargarDetalle(id: string, tras?: () => void, siNoExiste?: () => void): void {
    void (async () => {
      const desdeEquipo = async (e: unknown) => {
        const v = await this.red.vista(id);
        this.s.cargando.set(false);
        if (v) {
          await this.mostrar(v);
          tras?.();
          return;
        }
        // El borrador sólo se suelta si el vale DE VERDAD no existe (404): un 500 o la red caída no
        // dicen nada de eso, y soltarlo ahí perdería el vale a medias.
        if (siNoExiste && [404, 410].includes((e as { status?: number } | null)?.status ?? 0)) {
          siNoExiste();
          return;
        }
        // No tragarse la falla: un vale vacío y un 500 se ven igual en pantalla.
        this.toast.add({
          severity: 'error', summary: 'No se pudo cargar el vale',
          detail: esSinRed(e) ? 'Sin conexión, y este equipo no tiene guardado ese vale.' : motivoHttp(e as ErrorHttpLike, 'cargar el vale'),
        });
      };
      const sesion = await this.red.sesionDe(id);
      // Un vale abierto sin red que el equipo ya no tiene: no hay de dónde sacarlo.
      if (!sesion) return desdeEquipo(esLocal(id) ? { status: 404 } : null);
      if (sinRedDelTodo()) return desdeEquipo(null);
      this.sessions.detail(sesion).pipe(timeout(TOPE.lectura), takeUntilDestroyed(this.destroyRef)).subscribe({
        next: async (v) => {
          this.red.marcarConRed();
          await this.red.registrarDetalle(v, { sucursal: this.sucursalElegida()?.sucursal ?? null, erp: this.s.erp() });
          this.s.cargando.set(false);
          await this.mostrar(await this.red.superponerCola(v));
          tras?.();
        },
        error: (e) => {
          if (esSinRed(e)) this.red.marcarSinRed();
          void desdeEquipo(e);
        },
      });
    })();
  }

  /** Pone un vale en pantalla (del servidor o del equipo) y anota cómo lo llama la cola. */
  private async mostrar(v: ReceivingSession): Promise<void> {
    this.s.cargarDesdeVale(v);
    this.llaveActual.set(await this.red.llaveDe(v.id));
    this.consultarCongelamiento();
    this.guardarBorrador();
  }

  /** Vuelve a pintar el vale con lo que tiene el equipo: su base más lo que falta mandar. */
  private async refrescarDesdeEquipo(): Promise<void> {
    const v = this.s.vale();
    if (!v) return;
    const vista = await this.red.vista(v.id);
    if (vista) await this.mostrar(vista);
  }

  /**
   * ¿Está congelado este almacén? Se pregunta al abrir el vale, no al guardar.
   *
   * Si la consulta falla NO se bloquea la pantalla: se deja en `null` y el
   * operario trabaja como siempre — el guard del servidor sigue rechazando el
   * guardado si de verdad hay un conteo. Bloquear por una consulta caída sería
   * frenar el andén por un problema que quizá no existe.
   */
  private consultarCongelamiento(): void {
    const wh = this.s.warehouseId();
    // Sin red no se pregunta: el guard del servidor sigue frenando al MANDAR, y la cola lo dice.
    if (!wh || sinRedDelTodo()) return;
    this.binsSvc.warehouseFreeze(wh).pipe(timeout(TOPE.lectura), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.congelado.set(r),
      error: () => this.congelado.set(null),
    });
  }

  /**
   * **Destraba el almacén: abandona el conteo que lo congela.**
   *
   * No ajusta ni una pieza de existencia — eso es reconciliar, y se queda donde
   * estaba. Al volver se re-pregunta por el congelamiento en vez de asumir que
   * se destrabó: si el servidor rechazó (un conteo con movimiento reciente sólo
   * lo cancela quien reconcilia), la pantalla tiene que seguir mostrando el muro.
   */
  cancelarConteo(motivo: string): void {
    const id = this.congelado()?.count_id;
    if (!id || this.cancelandoConteo()) return;
    this.cancelandoConteo.set(true);
    this.binsSvc.cancelInventoryCount(id, motivo)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.cancelandoConteo.set(false);
          this.toast.add({
            severity: 'success',
            summary: 'Almacén destrabado',
            detail: `Se canceló el folio ${r?.folio || ''}. Ya se puede fechar.`.trim(),
          });
          this.consultarCongelamiento();
        },
        error: (e) => {
          this.cancelandoConteo.set(false);
          this.toast.add({
            severity: 'warn',
            summary: 'No se canceló',
            detail: motivoHttp(e, 'No se pudo cancelar el conteo.'),
          });
          // El muro se re-mide igual: si otro lo cerró mientras tanto, se cae solo.
          this.consultarCongelamiento();
        },
      });
  }

  // ── Fechas ────────────────────────────────────────────────────────────────

  abrirFechar(l: AndenLinea): void {
    this.s.actual.set(l);
    this.limpiarBarra();
    this.cargarContexto(l);
    setTimeout(() => this.fechar()?.limpiar(), 0);
  }

  /**
   * Quedó por compatibilidad con el camino viejo (fechado masivo), que resuelve
   * varios renglones de una y no tiene "el que acabo de tocar" en la mano.
   */
  private siguienteFechar(): void {
    const l = this.s.siguienteFechar();
    if (l) this.abrirFechar(l);
  }

  /**
   * Contexto del semáforo. La caducidad más próxima ya en stock se deriva de
   * `pick-suggestion` (que ordena por caducidad). La vida útil mínima **no** se
   * calcula acá: `resolvePolicy()` sigue privado y duplicar la cascada
   * producto→departamento→proveedor la desincronizaría del backend.
   */
  private cargarContexto(l: AndenLinea): void {
    this.minShelfLife.set(null);
    this.existingMinExpiry.set(null);
    const wh = this.s.warehouseId();
    // Sin red el semáforo no tiene contexto: muestra sólo los días, como cuando la consulta falla.
    if (!wh || !l.product_id || sinRedDelTodo()) return;
    this.binsSvc.pickSuggestion(wh, l.product_id).pipe(timeout(TOPE.lectura), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ss) => {
        const fechas = (ss || []).map((x) => x.expiry_date).filter((d): d is string => !!d).sort();
        this.existingMinExpiry.set(fechas[0] ?? null);
        const bin = (ss || []).find((x) => x.bin_code)?.bin_code ?? null;
        if (bin && l.id) this.s.parchear(l.id, { binSugerido: bin });
      },
      error: () => { /* sin sugerencia: el semáforo muestra sólo los días */ },
    });
  }

  correrOcr(dataUri: string): void {
    this.auditor.ocr(dataUri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.fechar()?.aplicarOcr(r),
      error: (e) => {
        this.fechar()?.ocrFallo();
        this.toast.add({
          severity: 'warn', summary: 'OCR',
          detail: esSinRed(e)
            ? 'Sin conexión no hay lectura de la etiqueta: captura el lote y la caducidad a mano. La foto se guarda igual.'
            : 'No se distinguió lote/caducidad. Captúralo a mano.',
        });
      },
    });
  }

  /**
   * **Un renglón puede llevar VARIAS caducidades** (llegan 6 cajas de un lote y 4
   * de otro). Se guardan de a una y **en serie**: cada una escribe stock y el
   * backend le resuelve su propio veredicto, así que una puede entrar verde y la
   * siguiente quedar retenida.
   *
   * **No se corta al primer fallo y no se reporta un éxito parcial como éxito.**
   * Si la 2ª de 3 falla, la 1ª ya entró a inventario: decir "guardado" ahí
   * escondería mercancía a medio declarar. Se dice cuántas entraron, cuántas
   * quedaron retenidas y cuál falló con su motivo.
   */
  async confirmarFechado(f: FechadoConfirmado): Promise<void> {
    const v = this.s.vale();
    const wh = this.s.warehouseId();
    if (!v || !wh || !f.linea.product_id || !f.entradas.length) return;
    this.s.guardando.set(true);

    let declarado = f.linea.declarado;
    let retenidas = 0;
    let ok = 0;
    let enCola = 0;
    const fallas: string[] = [];

    for (const e of f.entradas) {
      try {
        const cap = await this.guardarUna(f.linea, e);
        ok++;
        declarado += e.cantidad;
        if (cap.verdict === 'red') retenidas++;
        if (cap.verdict === 'en_cola') enCola++;
      } catch (err: unknown) {
        const x = err as { error?: { message?: string }; message?: string };
        fallas.push(`${e.caducidadIso ? formatExpiryEcho(e.caducidadIso) : 'Sin caducidad'}: ${x?.error?.message || x?.message || 'error'}`);
      }
    }

    // El renglón se cierra con lo que de verdad se declaró, y una sola vez. Va
    // afuera del loop: mientras siga `pending` se le pueden seguir agregando lotes.
    if (ok > 0) {
      try {
        await this.cerrarSiCompleto(f.linea, declarado);
      } catch (err: unknown) {
        const x = err as { error?: { message?: string } };
        fallas.push(`cerrar el renglón: ${x?.error?.message || 'error'}`);
      }
    }

    this.s.guardando.set(false);
    this.avisarFechado(f, ok, retenidas, fallas, enCola);

    if (!ok) return;
    this.cargarDetalle(v.id, () => {
      this.s.actual.set(null);
      this.volverALaBarra();
      // Una captura suelta no destraba ningún renglón del vale: encadenar al
      // "siguiente pendiente" mandaría al operario a otro producto sin que lo
      // pidiera. Sólo se encadena cuando lo que se fechó era del vale, y sólo si
      // no quedó nada a medias que el operario tenga que mirar.
      if (f.linea.id && !fallas.length) this.avanzar();
    });
  }

  /** Lo que pasó, dicho como pasó: nada de un "listo" sobre 2 de 3. */
  private avisarFechado(f: FechadoConfirmado, ok: number, retenidas: number, fallas: string[], enCola = 0): void {
    const n = f.entradas.length;
    const unidad = unidadDelVale(f.linea.expected_unit);
    if (fallas.length) {
      this.toast.add({
        severity: 'error', summary: ok ? 'Guardado a medias' : 'No se pudo fechar',
        detail: ok
          ? `Entraron ${ok} de ${n} caducidades de ${this.nombre(f.linea)}. NO entró — ${fallas.join(' · ')}`
          : fallas.join(' · '),
        life: 9000,
      });
      return;
    }
    if (retenidas > 0) {
      this.toast.add({
        severity: 'error', summary: 'Retenida',
        detail: retenidas === n
          ? 'Fechada, pero 🔴: un supervisor tiene que liberarla antes de cerrar el vale.'
          : `${retenidas} de ${n} quedaron 🔴 y esperan a un supervisor; el resto entró.`,
        life: 7000,
      });
      return;
    }
    if (enCola > 0) {
      // Sin red no hay semáforo: el veredicto llega al mandarla, y si queda retenida se avisa entonces.
      this.toast.add({
        severity: 'info', summary: 'Guardada en el equipo',
        detail: `${this.nombre(f.linea)}: sin conexión. Se manda sola al volver la red, y ahí se ve si queda retenida.`,
        life: 6000,
      });
      return;
    }
    const cantidad = f.entradas.reduce((a, e) => a + e.cantidad, 0);
    // `[WMS-REC.22]` Lo que se declaró sin caducidad se dice así, no como "lote NA".
    const sinCaducidad = n === 1 && !f.entradas[0].caducidadIso;
    this.toast.add({
      severity: 'success', summary: sinCaducidad ? 'Guardada sin caducidad' : 'Fechada',
      detail: n === 1
        ? `${this.nombre(f.linea)} — ${cantidad} ${unidad}, ${sinCaducidad ? 'sin caducidad' : `lote ${f.entradas[0].lote}`}.`
        : `${this.nombre(f.linea)} — ${n} caducidades, ${cantidad} ${unidad} en total.`,
    });
  }

  /**
   * **Una caducidad.** Sólo evalúa; cerrar el renglón es decisión de quien la
   * llama, porque con varias fechas el renglón se cierra UNA vez al final.
   */
  private async guardarUna(linea: AndenLinea, e: FechadoEntrada): Promise<Pick<ReceivingCapture, 'verdict'> | { verdict: 'en_cola' }> {
    const v = this.s.vale()!;
    const wh = this.s.warehouseId()!;
    const key = await this.red.llaveDe(v.id);
    // `[WMS-REC.20]` La llave nace con la captura: si se encola después de un intento fallido,
    // viaja la MISMA, y si el servidor sí la había recibido no mete la mercancía dos veces.
    const payload = {
      warehouse_id: wh,
      product_id: linea.product_id!,
      supplier_code: v.supplier_code || undefined,
      quantity: e.cantidad,
      confirmed_lot: e.lote,
      // `[WMS-REC.22]` Sin caducidad no se manda: el servidor la guarda vacía y el lote como NA.
      confirmed_expiry: e.caducidadIso ?? undefined,
      photo_data_uri: e.fotoDataUri || undefined,
      client_uuid: nuevaLlave(),
    };
    const encolar = async () => {
      await this.red.encolar({ tipo: 'fechar', valeKey: key, lineaId: linea.id || '', payload });
      return { verdict: 'en_cola' as const };
    };
    if (this.red.usaCola(key)) return encolar();
    try {
      const cap = await firstValueFrom(this.auditor.evaluate({
        ...payload,
        source_ref: v.folio,
        // Sin `id` es una captura SUELTA (el producto no venía en el vale). El
        // backend acepta `receiving_line_id` nulo desde WMS-REC.4; mandarlo vacío
        // lo haría fallar la validación de UUID.
        receiving_line_id: linea.id || undefined,
      }).pipe(timeout(TOPE.captura)));
      await this.red.anotarCapturaEnviada(v.id, linea.id, e.cantidad, cap.verdict === 'red');
      return cap;
    } catch (err) {
      if (!esSinRed(err)) throw err;
      this.red.marcarSinRed();
      return encolar();
    }
  }

  /**
   * `[WMS-REC.20]` Cierra un renglón: directo si hay red, a la cola si no (o si el vale ya tiene
   * algo en la cola: saltárselo cerraría el renglón antes de mandar sus caducidades). Escribir una
   * cantidad absoluta dos veces da lo mismo, así que reintentarlo es seguro.
   */
  private async setLineOEncolar(lineaId: string, recibido: number): Promise<ReceivingSession | null> {
    const v = this.s.vale();
    if (!v) return null;
    const key = await this.red.llaveDe(v.id);
    const encolar = async () => {
      await this.red.encolar({ tipo: 'renglon', valeKey: key, lineaId, received_qty: recibido });
      return null;
    };
    if (this.red.usaCola(key)) return encolar();
    try {
      const s = await firstValueFrom(this.sessions.setLine(v.id, lineaId, { received_qty: recibido }).pipe(timeout(TOPE.escritura)));
      await this.red.registrarDetalle(s);
      return s;
    } catch (err) {
      if (!esSinRed(err)) throw err;
      this.red.marcarSinRed();
      return encolar();
    }
  }

  /**
   * Cierra el renglón con lo declarado, si con esto quedó completo.
   *
   * **Ese `setLine` es lo que mantiene vivo el reclamo.** Sin paso de cotejo, si
   * nadie escribe `received_qty` el cierre del vale marca TODO como faltante y
   * levanta reclamos por mercancía que sí llegó. Se escribe con la cantidad que
   * se declaró, que es la única que alguien miró de verdad.
   */
  private async cerrarSiCompleto(linea: AndenLinea, declarado: number): Promise<void> {
    if (!linea.id) return;
    if (declarado + linea.retenido < Number(linea.expected_qty)) return;
    await this.setLineOEncolar(linea.id, declarado);
  }

  /**
   * **Llegó de menos y no va a llegar más.** Cierra el renglón con lo declarado:
   * eso lo saca de la cola y deja el faltante FIRME, que es lo que el cierre del
   * vale convierte en reclamo. Sin esta salida, un renglón corto quedaría
   * pendiente para siempre y el vale no podría cerrarse.
   */
  async cerrarRenglon(l: AndenLinea): Promise<void> {
    const v = this.s.vale();
    if (!v || !l.id) return;
    this.s.guardando.set(true);
    try {
      const upd = await this.setLineOEncolar(l.id, l.declarado);
      if (upd) await this.mostrar(await this.red.superponerCola(upd));
      else await this.refrescarDesdeEquipo();
    } catch (e) {
      this.s.guardando.set(false);
      this.toast.add({ severity: 'error', summary: 'Error', detail: motivoHttp(e as ErrorHttpLike, 'cerrar el renglón') });
      return;
    }
    this.s.guardando.set(false);
    this.s.actual.set(null);
    this.volverALaBarra();
    const esp = Number(l.expected_qty) || 0;
    this.toast.add({
      severity: 'warn', summary: 'Faltante',
      detail: `Kepler manda ${esp} y llegaron ${l.declarado}. Al cerrar el vale se levanta el reclamo.`,
    });
    this.siguienteFechar();
  }

  cerrarMasiva(): void {
    this.masiva.set(false);
    this.avance.set(null);
    this.volverALaBarra();
  }

  /**
   * **Toda la entrega con la misma caducidad.**
   *
   * Se aplica **de a uno y en serie**, no en paralelo: cada captura escribe stock
   * y el backend resuelve la política por producto. Mandarlas todas juntas
   * ahorraría segundos y convertiría un error puntual en un lote de errores sin
   * orden. Y **no se corta al primer fallo** — los que sí se pueden fechar se
   * fechan, y los que no se listan con nombre y motivo.
   */
  async fecharTodo(m: FechadoMasivo): Promise<void> {
    const v = this.s.vale();
    if (!v || !m.lineas.length) return;
    const total = m.lineas.length;
    const fallas: { nombre: string; motivo: string }[] = [];
    let retenidas = 0;
    let enCola = 0;
    this.avance.set({ hechas: 0, total, fallas: [], retenidas: 0, terminado: false });

    for (const l of m.lineas) {
      try {
        if (!l.product_id) throw new Error('el renglón no tiene producto del catálogo');
        const cap = await this.guardarUna(l, {
          cantidad: l.faltaFechar, lote: m.lote, caducidadIso: m.caducidadIso, fotoDataUri: null,
        });
        if (cap.verdict === 'red') retenidas++;
        if (cap.verdict === 'en_cola') enCola++;
        // El renglón queda completo por construcción (se declaró lo que faltaba),
        // así que acá es donde el faltante/sobrante contra Kepler queda firme.
        await this.cerrarSiCompleto(l, l.declarado + l.faltaFechar);
      } catch (e: unknown) {
        const err = e as { error?: { message?: string }; message?: string };
        fallas.push({ nombre: this.nombre(l), motivo: err?.error?.message || err?.message || 'error desconocido' });
      }
      this.avance.update((a) => (a ? { ...a, hechas: a.hechas + 1, fallas: [...fallas], retenidas } : a));
    }

    this.avance.update((a) => (a ? { ...a, terminado: true } : a));
    if (enCola > 0)
      this.toast.add({
        severity: 'info', summary: 'Guardado en el equipo',
        detail: `${enCola} de ${total} sin conexión: se mandan solos al volver la red.`,
        life: 6000,
      });
    // El detalle se recarga UNA vez al final: recargarlo por renglón son N viajes
    // y hace parpadear la lista mientras corre.
    this.cargarDetalle(v.id);
  }

  volverALista(): void {
    this.s.actual.set(null);
    this.volverALaBarra();
  }

  /**
   * **Cerrar el vale.** Acá —y no antes— el faltante queda firme y se levantan los
   * reclamos (WMS-REC.8). El backend descuenta lo que las capturas de lote ya
   * dieron de alta, así que cerrar después de fechar **no cuenta la mercancía dos
   * veces**.
   */
  async cerrarVale(): Promise<void> {
    const v = this.s.vale();
    if (!v || this.s.cerrado()) return;
    const key = await this.red.llaveDe(v.id);
    // `[WMS-REC.20]` Sin red se cierra en el equipo y se manda después; los reclamos se levantan
    // al mandarlo. Cerrar dos veces no hace daño: el segundo cierre se toma como hecho.
    const encolar = async () => {
      await this.red.encolar({ tipo: 'cerrar', valeKey: key });
      this.s.guardando.set(false);
      await this.refrescarDesdeEquipo();
      this.toast.add({
        severity: 'info', summary: 'Vale cerrado en el equipo',
        detail: 'Sin conexión: se manda solo al volver la red, y ahí se levantan los reclamos.',
        life: 7000,
      });
    };
    if (this.red.usaCola(key)) return encolar();
    this.s.guardando.set(true);
    this.sessions.close(v.id).pipe(timeout(TOPE.escritura), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (upd) => {
        this.s.guardando.set(false);
        this.s.cargarDesdeVale(upd);
        void this.red.registrarDetalle(upd);
        this.guardarBorrador();
        const n = upd?.claims?.raised ?? 0;
        const aQuien = upd?.origin?.kind === 'transfer'
          ? (upd?.origin?.name || 'la sucursal que embarcó')
          : (upd?.origin?.name || upd?.supplier_code || 'el proveedor');
        this.toast.add({
          severity: 'success', summary: 'Vale cerrado',
          detail: n > 0
            ? `Se levantaron ${n} reclamo(s) a ${aQuien}; se siguen en Compras › Reclamos.`
            : 'Sin diferencias contra Kepler.',
          life: n > 0 ? 7000 : undefined,
        });
      },
      error: (e) => {
        if (esSinRed(e)) {
          this.red.marcarSinRed();
          void encolar();
          return;
        }
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo cerrar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  /** Entra al alta: el menú de sucursales, ya cargado. */
  irAAlta(): void {
    this.modo.set('alta');
    this.cargarSucursales();
  }

  /**
   * El menú: a qué sucursal entra la mercancía, con los vales de HOY sin abrir.
   *
   * Se pide cada vez que se entra, y no se cachea: entre un camión y el
   * siguiente pasan minutos y otra persona pudo abrir vales desde otro equipo.
   */
  cargarSucursales(): void {
    this.cargarEnCurso();
    this.cargandoMenu.set(true);
    this.errorMenu.set(null);
    if (sinRedDelTodo()) {
      void this.menuSinRed();
      return;
    }
    this.sessions.pendingErpBranches().pipe(timeout(TOPE.lectura), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.red.marcarConRed();
        this.cargandoMenu.set(false);
        this.sucursales.set(r?.sucursales ?? []);
        this.alcanceAbierto.set(r?.alcance === 'all');
        this.paqueteAl.set(null);
        this.bajarPaquetes(r);
      },
      error: (e) => {
        if (esSinRed(e)) {
          void this.menuSinRed();
          return;
        }
        this.cargandoMenu.set(false);
        // Un error NO se muestra como "hoy no hay vales": son cosas distintas y
        // confundirlas manda al bodeguero a buscar un camión que sí llegó.
        this.errorMenu.set(
          e?.status === 403
            ? 'Tu rol no tiene permiso para ver los vales de entrada.'
            : e?.error?.message || 'No se pudo leer el tablero de hoy.',
        );
      },
    });
  }

  elegirSucursal(b: ErpPendingBranch): void {
    if (!b || b.sin_almacen) return;
    this.sucursalElegida.set(b);
    this.valesDelDia.set([]);
    this.errorVales.set(null);
    this.cargandoVales.set(true);
    this.modo.set('vales');
    if (sinRedDelTodo()) {
      void this.valesSinRed(b);
      return;
    }
    this.sessions.pendingErpOrders(b.sucursal).pipe(timeout(TOPE.lectura), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.red.marcarConRed();
        this.cargandoVales.set(false);
        this.valesDelDia.set(r || []);
        // Con red, se baja lo de esta sucursal para poder seguir si se va la conexión.
        void this.red.bajarPaquete(b.sucursal);
      },
      error: (e) => {
        if (esSinRed(e)) {
          void this.valesSinRed(b);
          return;
        }
        this.cargandoVales.set(false);
        this.errorVales.set(e?.error?.message || 'No se pudieron leer los vales de esa sucursal.');
      },
    });
  }

  /**
   * `[WMS-REC.20]` Con red, el equipo baja de una vez los vales de sus sucursales para poder seguir
   * si se va la conexión. Sólo con el alcance acotado (pocas sucursales): a quien ve todas se le
   * baja la que elige, al entrar a ella.
   */
  private bajarPaquetes(r: ErpPendingMenu): void {
    if (r?.alcance === 'all') return;
    for (const b of (r?.sucursales ?? []).filter((x) => !x.sin_almacen).slice(0, 3)) void this.red.bajarPaquete(b.sucursal);
  }

  /** El menú armado con los vales que el equipo bajó: se dice de cuándo son. */
  private async menuSinRed(): Promise<void> {
    this.red.marcarSinRed();
    const [paqs, guardados] = await Promise.all([this.red.paquetes(), this.red.valesGuardados()]);
    this.cargandoMenu.set(false);
    this.alcanceAbierto.set(false);
    if (!paqs.length) {
      this.sucursales.set([]);
      this.errorMenu.set('Sin conexión, y este equipo todavía no bajó los vales de ninguna sucursal. Se bajan solos la próxima vez que haya red.');
      return;
    }
    this.sucursales.set(menuDesdePaquetes(paqs, guardados, hoyMexico()));
    this.paqueteAl.set(paqs.map((p) => p.generado_en).sort()[0] ?? null);
  }

  /** Los vales de una sucursal, de lo que bajó el equipo. */
  private async valesSinRed(b: ErpPendingBranch): Promise<void> {
    this.red.marcarSinRed();
    const [p, guardados] = await Promise.all([this.red.paquete(b.sucursal), this.red.valesGuardados()]);
    this.cargandoVales.set(false);
    if (!p) {
      this.errorVales.set('Sin conexión, y este equipo no tiene bajados los vales de esta sucursal.');
      return;
    }
    this.valesDelDia.set(valesDisponibles(p, guardados));
    this.paqueteAl.set(p.generado_en);
  }

  /** Vuelve al menú y lo recarga: lo que se abrió ya no debe seguir contado. */
  volverASucursales(): void {
    this.sucursalElegida.set(null);
    this.valesDelDia.set([]);
    this.errorVales.set(null);
    this.modo.set('alta');
    this.cargarSucursales();
  }

  otroCamion(): void {
    const v = this.s.vale();
    if (v) this.drafts.borrar(v.id);
    this.masiva.set(false);
    this.avance.set(null);
    this.confirmandoCambio.set(false);
    // El muro del inventario fisico es del ALMACEN del vale que se deja. Si se quedara puesto,
    // tapaba el menu entero: el boton "Salir" del muro llamaba aca y no se veia nada.
    this.congelado.set(null);
    this.consulta.set('');
    this.s.reset();
    this.volverASucursales();
  }

  /**
   * `[WMS-REC.17]` **Cambiar de camion a media captura.**
   *
   * Sin renglon abierto se sale directo: todo lo fechado ya esta en el servidor.
   * Con un renglon (o el fechado masivo) abierto se pide confirmacion, porque eso que se esta
   * escribiendo es lo UNICO que todavia no se guardo.
   */
  pedirCambio(): void {
    if (this.s.actual() || this.masiva()) {
      this.confirmandoCambio.set(true);
      return;
    }
    this.cambiarDeCamion();
  }

  /**
   * Sale al menu SIN cancelar el vale: queda abierto en el servidor y aparece en «Incompletos».
   * El borrador local se borra a proposito — si quedara, al volver a entrar la pantalla
   * reabriria este vale sola, y el bodeguero ya esta con otro camion.
   */
  cambiarDeCamion(): void {
    const v = this.s.vale();
    const sigueAbierto = !!v && !this.s.cerrado();
    this.otroCamion();
    if (v && sigueAbierto) {
      this.toast.add({
        severity: 'info',
        summary: 'Vale en curso',
        detail: `${v.folio} quedó en «Incompletos». Tócalo en el menú para seguir donde lo dejaste.`,
      });
    }
  }

  /** Los vales abiertos sin cerrar, para el menu. Si falla, se DICE (no se pinta "no hay"). */
  cargarEnCurso(): void {
    this.errorEnCurso.set(null);
    // `[WMS-REC.20]` Van primero los del equipo que el servidor todavía no ve completos: los
    // abiertos sin red y los que tienen algo por mandar. Esos tapan su versión del servidor.
    const conLosDelEquipo = async (servidor: AndenValeEnCurso[]) => {
      const enCola = this.red.valesEnCola();
      const propios = (await this.red.valesGuardados()).filter((g) => !g.sessionId || enCola.has(g.key));
      const tapados = new Set(propios.map((g) => g.sessionId).filter((x): x is string => !!x));
      this.enCurso.set([...incompletosLocales(propios, this.red.ops()), ...servidor.filter((v) => !tapados.has(v.id))]);
    };
    if (sinRedDelTodo()) {
      void conLosDelEquipo([]);
      return;
    }
    this.sessions.enCurso().pipe(timeout(TOPE.lectura), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.red.marcarConRed();
        void conLosDelEquipo(r ?? []);
        void this.guardarIncompletos(r ?? []);
      },
      error: (e) => {
        if (esSinRed(e)) {
          void conLosDelEquipo([]);
          return;
        }
        this.enCurso.set([]);
        this.errorEnCurso.set(motivoHttp(e, 'leer los vales en curso'));
      },
    });
  }

  /**
   * `[WMS-REC.20]` Los incompletos se guardan en el equipo con su detalle, para poder seguirlos si se
   * va la red. Mejor esfuerzo, de a uno, sólo los que el equipo no tiene, y se corta al primer fallo.
   */
  private async guardarIncompletos(vs: AndenValeEnCurso[]): Promise<void> {
    const tiene = new Set((await this.red.valesGuardados()).map((g) => g.sessionId));
    for (const v of vs.filter((x) => !esLocal(x.id) && !tiene.has(x.id)).slice(0, 10)) {
      try {
        await this.red.registrarDetalle(await firstValueFrom(this.sessions.detail(v.id).pipe(timeout(TOPE.lectura))));
      } catch {
        return;
      }
    }
  }

  // ── La cola ───────────────────────────────────────────────────────────────

  /** Lo que pasó al mandar un vale: se dice, y si es el que está abierto se recarga. */
  private async alMandar(r: EnvioVale): Promise<void> {
    for (const a of r.avisos) this.toast.add({ severity: 'warn', summary: 'Al mandar', detail: a, life: 8000 });
    if (r.error) this.toast.add({ severity: 'error', summary: 'Un vale no se pudo mandar', detail: r.error, life: 9000 });
    else if (r.vale) this.toast.add({ severity: 'success', summary: 'Mandado', detail: `${r.vale.folio}: lo hecho sin conexión ya está en el servidor.` });
    const v = this.s.vale();
    if (v && (await this.red.llaveDe(v.id)) === r.key) {
      // Sólo si nadie está escribiendo un renglón: tumbar una captura a medias sería peor.
      if (!this.s.actual() && !this.masiva()) this.cargarDetalle(r.sessionId ?? v.id);
    } else if (!v && this.modo() === 'alta') {
      this.cargarEnCurso();
    }
  }

  mandarAhora(): void {
    void this.red.flush();
  }

  reintentarVale(key: string): void {
    void this.red.reintentar(key);
  }

  /** Tira lo pendiente de un vale (el banner ya pidió confirmación). Si es el abierto, se sale de él. */
  async descartarVale(key: string): Promise<void> {
    const v = this.s.vale();
    const eraElAbierto = !!v && (await this.red.llaveDe(v.id)) === key;
    await this.red.descartar(key);
    this.toast.add({ severity: 'warn', summary: 'Descartado', detail: 'Lo hecho sin conexión en ese vale se tiró.' });
    if (eraElAbierto) this.otroCamion();
    else if (this.modo() === 'alta') this.cargarEnCurso();
  }

  /** Vuelve a un vale que quedó a medias: el mismo camino que el borrador de este equipo. */
  retomar(v: AndenValeEnCurso): void {
    if (this.s.cargando()) return;
    this.s.reset();
    this.s.cargando.set(true);
    this.cargarDetalle(v.id, () => {
      this.toast.add({ severity: 'info', summary: 'Vale retomado', detail: `${v.folio} — sigue donde lo dejaste.` });
    });
  }
}

/**
 * `[WMS-REC.20]` El equipo SABE que no tiene red (modo avión, sin señal). Ahí ni se intenta: se va
 * directo a lo guardado. Con "poca" red el navegador dice que sí hay, y entonces se intenta con tope.
 */
function sinRedDelTodo(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
