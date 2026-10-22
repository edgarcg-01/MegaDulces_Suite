import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, OnDestroy, OnInit, computed, inject, signal, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { SucursalPipe } from '../../../../shared/pipes/sucursal.pipe';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { CheckboxModule } from 'primeng/checkbox';
import { TextareaModule } from 'primeng/textarea';
import { ChipModule } from 'primeng/chip';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { MessageModule } from 'primeng/message';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { evaluarCambio, type Denominacion, firmaSigueValiendo, diaCorto, SUCURSAL_CAJA_GENERAL, CAJA_CONFIRMAR_UMBRAL_DIAS } from '@megadulces/contracts';
import { prepararFirma, pintarQr, filtrarPorBusqueda, type FirmaCanvas } from '@megadulces/ui-web';

/**
 * `[CG.74]` La página que abre el teléfono para firmar. Vive acá como constante porque la dicen
 * DOS lugares —el QR y el texto de respaldo— y escribirla dos veces es la forma barata de que una
 * de las dos quede vieja el día que la ruta cambie.
 */
// ⭐ `[CG.84]` Apunta a la ruta PÚBLICA. La vieja (`/finanzas/caja-general/firma`) sigue viva
// para un teléfono con sesión, pero el QR y la ruta que se dicta van acá: ésta no exige iniciar
// sesión ni carga el shell de la Suite en un teléfono que se le presta a quien viene a firmar.
const RUTA_FIRMA = '/firmar';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
// `[CG.45]` Tres piezas del repertorio compartido que esta pantalla se había construido a mano
// (o no tenía). De 13 componentes compartidos usaba 2; el resto del módulo finanzas ya los usa.
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { todayMx, toMxDateKey, parseLocalDate } from '../../../../core/utils/mx-date';
import { uuidV4 } from '../../../../core/utils/uuid';
import { moneyOSinMedir } from '../../../../shared/util';
import { CashLedgerService, type CandadoCaja, type ConceptoKepler, type MovimientoCaja, type AutofillResponse, type TipoMovimiento, type SaldoResponse, type CorteCaja, type TotalesCorte, type MovimientoPendiente, type CajaKepler, type ResumenLote, type Frecuente, type CoberturaResponse, type CaosCapturable, type CaosCandidato, type ArqueoDia, type ArqueoMovimientoDia, type RecurrentesResponse,
  type RecurrenteSinRegla, type CorteRow, type ConteoSellado, type RevelacionVista,
  type JornadasPendientes, type PendientesResponse } from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { CajaBorradorService } from './caja-borrador.service';
import { CajaSocketService } from '../../caja-socket.service';
import { imprimirComprobante as imprimirTicketComprobante, imprimirReporteDia as imprimirTicketReporte, cuerpoReporteDia, type ComprobanteCaja, type ReporteDia } from './ticket-comprobante';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import {
  BILLETES_CAJA, MONEDAS_CAJA, motivosDeBloqueo, TEXTO_BLOQUEO, etiquetaProcedencia, etiquetaManual,
  textoCobertura, sumaDesglose, redondea, puedeAutorizarUI, puedeCerrarUI, textoSaldo, GLOSA_MIN, ARQUEO_EPSILON,
  type DenominacionCapturada, type MotivoBloqueo, type CorteVista, conflictoDeEsperado, type ConflictoEsperado,
  pasoDelCorte, textoPaso, type PasoCorte, textoDeError, separarPorFlujo,
  GRUPOS_COLA, GRUPO_SIN_CLASIFICAR, grupoDe, CAPTURA_MANUAL_HABILITADA, puedeSellarUI,
} from './caja-captura.util';
import { CajaPasosComponent } from '../../components/caja-pasos.component';
import { CajaTabsComponent } from '../../caja-tabs.component';

/**
 * `[CGP-V.2]` Lo que el servidor respondió al sellar o recontar EN ESTA sesión, atado a SU corte, con
 * la reja que se mandó (es la que el servidor aceptó). Cubre el rato entre la respuesta y la
 * relectura del saldo, y no se pierde si la relectura falla.
 */
interface SelladoEnSesion {
  corteId: string;
  totales: TotalesCorte;
  puedeRecontar: boolean;
  conteo: DenominacionCapturada[];
  morralla: number;
}

/** Etiquetas de lo que se PINTA. El enum de la columna (`deposito`, `sin_contar`) es de la DB. */
const ETIQUETA_TIPO: Record<string, string> = {
  ingreso: 'Ingreso', gasto: 'Gasto', deposito: 'Depósito',
};
const ETIQUETA_ESTADO_CORTE: Record<string, string> = {
  borrador: 'Abierto', cerrado: 'Cerrado', autorizado: 'Autorizado',
  // `[CGS.18]` La supervisora lo revisó y lo devolvió con un motivo: espera la respuesta de la caja.
  observado: 'Observado',
};
const ETIQUETA_VEREDICTO: Record<string, string> = {
  cuadra: 'Cuadra', sobra: 'Sobra efectivo', falta: 'Falta efectivo', sin_contar: 'Sin contar',
  // `[CG.42]` NO dice "no cuadra": dice que la pregunta no tiene respuesta. Sin esta entrada el
  // tag imprimía la clave cruda `sin_base`, porque el mapa cae a `?? v`.
  sin_base: 'Sin fondo medido',
  // `[CG.160]` Sin esta entrada el tag imprimía la clave cruda `sin_medir` — el mapa cae a `?? v`.
  // Y NO dice "no cuadra": el efectivo se contó, lo que falta es el esperado con que compararlo.
  sin_medir: 'Conteo sellado, sin veredicto guardado',
  // `[CG.195]` Tampoco dice "no cuadra": el esperado dio bajo cero, así que no hay con qué comparar.
  esperado_imposible: 'Esperado bajo cero, sin veredicto',
};

/**
 * El formulario de captura. Es el tipo CONCRETO que la pantalla mantiene; `FormularioCaja` del
 * util es el contrato laxo (todo opcional) que consume `motivosDeBloqueo`, y este encaja en aquél.
 */
interface FormularioCajaUI {
  tipo: TipoMovimiento; fecha: string; sucursal: string;
  kepler_cuenta: string | null; kepler_concepto: string | null;
  glosa: string; beneficiario: string; monto: number | null; morralla: number;
  denominaciones: DenominacionCapturada[];
}

/**
 * CS.3.7 — Suma piezas de varias fuentes (cajero + reja) y descarta las de 0.
 *
 * ⛔ `[CG.38]` Agrupa por **`denom_key`**, no por el valor. Agrupaba por el número, y con monedas
 * eso junta el billete de $20 con la moneda de $20 en un solo renglón: dos pilas distintas de
 * dinero fundidas en una, y el desglose deja de poder reconstruirse. Mientras la caja contaba
 * sólo billetes no mordía; ahora sí.
 */
/**
 * La llave del BILLETE de ese valor. El catálogo compartido la define como el valor a secas
 * (`'20'`), y la moneda que colisiona lleva sufijo (`'20m'`) — ver SM.39.
 */
/** [CGA-A.49] El día anterior a una fecha YYYY-MM-DD (aritmética de calendario, sin zona). */
function diaAntes(dia: string): string {
  const d = new Date(dia + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function llaveBillete(valor: number): string {
  return valor === 0.5 ? '0.5' : String(valor);
}

function mergeDenoms(fuentes: DenominacionCapturada[]): DenominacionCapturada[] {
  const m = new Map<string, DenominacionCapturada>();
  for (const d of fuentes) {
    const pz = Number(d.piezas) || 0;
    if (pz <= 0) continue;
    const prev = m.get(d.denom_key);
    if (prev) prev.piezas += pz;
    else m.set(d.denom_key, { denom_key: d.denom_key, denominacion: Number(d.denominacion), piezas: pz });
  }
  // Del mayor al menor, y con el billete antes que la moneda del mismo valor (la llave del
  // billete es el numero a secas, asi que ordena antes que la que lleva sufijo).
  return [...m.values()].sort((a, b) => b.denominacion - a.denominacion || a.denom_key.localeCompare(b.denom_key));
}

/**
 * CG.14 — Caja General: la pantalla donde la plataforma REGISTRA el efectivo (ADR-070).
 *
 * Reemplaza las 6 formas del Access "Control" ("Fichas de Efectivo por Cobranza",
 * "Fichas de Otros Ingresos", "Comprobante de Gasto", "Comprobación de Gasto",
 * "Depósitos al banco") **con los mismos nombres que la gente ya usa**: reestructurar es
 * renombrar y reordenar, no rediseñar.
 *
 * ⚠️ Acá se citaba con acento grave y se cambió a comillas a propósito: este archivo tiene DOS
 * literales de plantilla (`styles` y `template`) y un acento grave suelto en un comentario los
 * cierra. Pasó siete veces en el repo — la séptima, en el comentario CSS de abajo, en esta misma
 * sesión. Comillas dobles en los comentarios de este archivo, siempre.
 *
 * Tres cosas que esta pantalla hace y la de Access no podía:
 *   · El concepto contable de Kepler es un buscador sobre el catálogo vivo, no un número que
 *     hay que saberse. Y es POR SUCURSAL, porque el mismo par tiene nombre distinto por plaza.
 *   · Lo que el motor propone se ve COMO PROPUESTA, con su respaldo. Un campo autorrellenado
 *     que se pinta igual que uno tecleado se acepta sin mirarlo.
 *   · La cobertura del catálogo está SIEMPRE a la vista: "0 conceptos" por carril caído no
 *     puede leerse igual que "esta sucursal no tiene conceptos".
 *
 * La lógica de decisión vive en caja-captura.util.ts (puro, con pruebas unitarias).
 */
@Component({
  selector: 'app-finanzas-caja-general',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, InputTextModule, InputNumberModule, TableModule, CheckboxModule, TextareaModule,
    ChipModule, DatePickerModule, SelectModule, TagModule, DialogModule, AutoCompleteModule,
    MessageModule, ToastModule,
    MetricStripComponent, LoadStateComponent,
    FreshnessPillComponent, SegmentedComponent, ContextHelpComponent, SucursalPipe, CajaPasosComponent,
    SidePeekComponent, CajaTabsComponent,
  ],
  // Sin esto NINGUNA escritura de la pantalla avisaba: guardar, abrir corte, cerrar, autorizar y
  // confirmar el lote fallaban en silencio y se veían igual que un botón muerto.
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  /**
   * ⛔ Esta pantalla se pintaba SIN UN SOLO ESTILO. Usaba 19 clases fin-* que no existen en
   * ningún lado del repo: FINANZAS_SHARED_STYLES define 63 clases y ni una empieza con fin-.
   * Nadie lo vio porque nadie abrió la página; la validación visual quedó declarada como pendiente
   * dos veces y el hueco era esto.
   *
   * El shell (página, encabezado, subtítulo) pasa al global surf-*. Lo de acá abajo es lo que sí
   * es propio de una captura de caja —la barra del corte, el formulario, la reja de denominaciones—
   * y vive local con el mismo criterio que cg-* en /finanzas/caja. Se conservan los nombres
   * fin-* en vez de renombrar 19 usos: el arreglo es que EXISTAN, no cómo se llamen.
   */
  styles: [FINANZAS_SHARED_STYLES, `
    .cg-head-actions { display:flex; align-items:center; gap:var(--sp-2); }

    /* La barra del corte: saldo + estado + acción, en una línea que se lee de un vistazo. */
    .fin-corte-bar { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-3); margin:var(--sp-3) 0 var(--sp-4); }
    .fin-saldo { font-weight:600; font-variant-numeric:tabular-nums; }
    /* [CG.71] El saldo en la barra: cede antes que el titulo y que los dos controles, y se corta
       con puntos suspensivos en vez de empujarlos fuera (el texto entero queda en el title). */
    .cg-saldo { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis;
      white-space:nowrap; font-size:var(--fs-sm); color:var(--text-muted); }

    .fin-filters { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin:var(--sp-4) 0 var(--sp-3); }
    .fin-filters input, .fin-filters p-select { min-width:11rem; }

    .fin-h2 { font-size:var(--fs-h3); font-weight:700; margin:var(--sp-6) 0 var(--sp-2); }
    /* .fin-dim, .fin-form y la familia .fin-row se mudaron a FINANZAS_SHARED_STYLES: las usa
       también caos, y ahí no llegaban. Ver el porqué en esa constante. */
    .fin-empty { text-align:center; color:var(--text-muted); padding:var(--sp-5) 0; }
    /* ⚠️ Acá decía "var(--danger-fg, #b42318)" y --danger-fg NO EXISTE en tokens.css: ganaba
       siempre el hex de fallback, que es un rojo de tema claro. O sea que en modo oscuro un
       faltante de caja se pintaba ilegible. El token de la casa es --bad-fg y sí flipea. */
    .fin-neg { color:var(--bad-fg); }
    .d-block { display:block; }

    /* ⛔⛔ [CG.60] ACA VIVIAN ".cg-grid" Y ".cg-col", las dos columnas del formulario de captura
       (CS.3.7: el QUE a la izquierda, el CUANTO a la derecha). Se retiran enteras porque esas dos
       columnas SON AHORA LOS DOS APARTADOS: el QUE es el apartado 1 y el CUANTO el apartado 2.

       Lo que se lleva puesto, y hay que decirlo: con ellas se van los dos umbrales de @container
       (colapso en 39rem, posicion en 39.01rem) que [CG.52] tuvo que medir dos veces y la regla de
       [CG.57] que le daba a cada columna su propio container-type. Nada de eso se perdio -- el
       container-type se mudo a .cg-ap-cuerpo (ver arriba), que es la caja que la reja mide de
       verdad, y los umbrales ya no hacen falta porque las dos mitades no colapsan una sobre otra:
       las fija .cg-split. Tres commits de ancho condicional, resueltos quitando la condicion. */
    /* ⭐ [CG.60] ANGOSTO: SE SUELTA EL ALTO, NO SOLO LAS COLUMNAS.
       Acá sólo se apilaban las dos columnas, y eso ahora NO ALCANZA: con .cg-app clavado en
       100vh/overflow:hidden ([CG.59]), apilar los dos apartados deja el segundo -- el arqueo --
       fuera de la pantalla y SIN forma de llegar a él, porque la página no scrollea. Dos mitades
       lado a lado es un lujo de pantalla ancha; cuando no la hay, el alto se devuelve a la página
       y se baja a leer, que es peor que verlo todo pero infinitamente mejor que no poder verlo.
       El vacío del apartado 1 se esconde acá -- y sólo acá -- porque apilado empuja la cola fuera
       de la vista; con algo elegido sí se pinta, y su botón de cerrar hace de "volver". */
    @container (max-width:64rem) {
      .cg-app { height:auto; overflow:visible; }
      .cg-split { grid-template-columns:1fr; }
      .cg-ap { max-height:none; }
      .cg-ap-cuerpo { overflow:visible; }
      .cg-ficha { position:static; }
      .cg-detail-vacio { display:none; }
    }
    .w-full { width:100%; }

    .fin-hint-ok   { color:var(--ok-fg); font-size:var(--fs-xs); }
    /* ⛔⛔ [CGA-LEG.6] --warn-fg ES PARA ICONOS Y BORDES, NO PARA TEXTO. Medido el 2026-10-19
       sobre el fondo vivo: #F59E0B da contraste 1.95, menos de la mitad del minimo AA -- y lo
       que lleva esta clase son los avisos que explican por que algo NO se puede hacer todavia
       ("frescura sin medir", "N cosa(s) por resolver"). Un aviso que no se lee es indistinguible
       de no haberlo puesto.
       --warn-soft-fg (#92400E) ya existe en la escala exactamente para texto de advertencia, y
       voltea solo en oscuro (#FCD34D). No se inventa un color: se usa el que el sistema tenia
       para este rol y que nadie estaba usando. */
    .fin-hint-warn { color:var(--warn-soft-fg); font-size:var(--fs-xs); }

    /* CG.23 - El arqueo. Una TABLA y no la reja de cajitas que habia antes: esto es dato
       tabular (denominacion x piezas x importe), asi el encabezado de columna existe de
       verdad para un lector de pantalla en vez de repetir una etiqueta por celda, y sobre
       todo queda en UNA columna -- que es lo que hace que bajar con la flecha coincida con
       lo que ve el ojo. Con la reja de "auto-fill" el orden visual dependia del ancho.
       Se fueron con el cambio ".fin-denoms", ".fin-denom" y ".fin-details": el desglose ya
       no es un detalle plegable. */
    .cg-arqueo { border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:var(--sp-3); }
    .cg-arqueo-head { display:flex; align-items:baseline; justify-content:space-between;
                      flex-wrap:wrap; gap:var(--sp-2); margin-bottom:var(--sp-2); font-size:var(--fs-sm); }
    /* El caption es para el lector de pantalla; en pantalla la cabecera ya lo dice. */
    .cg-cap { position:absolute; width:1px; height:1px; overflow:hidden;
              clip-path:inset(50%); white-space:nowrap; }
    /* ⚠️ Ojo con el DUENO de cada declaracion ahora que esto es un p-table: la clase cae en el
       HOST <p-table>, y la <table> de adentro la pinta PrimeNG. Por eso aca solo queda lo que
       CASCADEA (font-size) o aplica al host (display); el ancho y el colapso de bordes los
       gobierna el componente. Los selectores de abajo SI llegan: th/td viven en nuestras
       <ng-template>, asi que llevan el atributo de encapsulacion de esta pantalla. */
    .cg-arqueo-tbl { display:block; font-size:var(--fs-sm); }
    .cg-arqueo-tbl th, .cg-arqueo-tbl td { padding:var(--sp-1) var(--sp-2); text-align:right; }
    .cg-arqueo-tbl thead th { font-weight:600; color:var(--text-muted); font-size:var(--fs-xs);
                              border-bottom:1px solid var(--border-color); }
    .cg-arqueo-tbl thead th:first-child { text-align:left; }
    .cg-arqueo-tbl tbody th, .cg-arqueo-tbl tfoot th { text-align:left; font-weight:500; }
    .cg-arqueo-tbl tfoot th, .cg-arqueo-tbl tfoot td { border-top:1px solid var(--border-color);
                                                       padding-top:var(--sp-2); font-weight:700; }
    /* Piezas: angosto, a la derecha y tabular. Contar es teclear numeros cortos en columna. */
    /* [CG.38] El bloque del cambio devuelto. Separado por una línea y atenuado: es la excepción,
       no el camino. */
    .cg-cambio { margin-top:var(--sp-2); border-top:1px solid var(--border-color); padding-top:var(--sp-2); }
    .cg-cambio-head { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cg-cambio-cuenta { margin:var(--sp-1) 0 var(--sp-1); }
    .cg-arqueo-tbl input.cg-pieza, .cg-arqueo-tbl input.cg-pieza-corte, .cg-arqueo-tbl input.cg-pieza-dev {
      width:5.5rem; text-align:right; font-variant-numeric:tabular-nums; padding:var(--sp-1) var(--sp-2); }
    .cg-arqueo-tbl input.cg-morralla-in { width:7.5rem; }
    /* [CG.38] La reja pasó de 5 renglones a 11: hay que poder ver de un vistazo dónde empieza el
       metal. La marca es TEXTO, no sólo un tono -- el color nunca es el único portador (DESIGN).
       La línea va en la PRIMERA moneda, no en todas: es un corte, no un borde por fila. */
    .cg-fam { font-size:var(--fs-micro); color:var(--text-muted); margin-left:var(--sp-1);
      font-family:var(--font-body); }
    /* ⚠️ El selector es el HERMANO, no ":first-of-type". Todos los renglones son <tr>, así que
       ":first-of-type" habría marcado el PRIMER renglón de la tabla —un billete— y la línea
       nunca habría caído donde empieza el metal. Habría quedado puesta y sin efecto visible. */
    tr:not(.cg-fila-moneda) + tr.cg-fila-moneda th,
    tr:not(.cg-fila-moneda) + tr.cg-fila-moneda td {
      border-top:1px solid var(--border-color); padding-top:var(--sp-1); }
    /* El importe NO se teclea: sale del conteo. Se pinta como dato, no como campo. */
    .cg-sub { font-variant-numeric:tabular-nums; color:var(--text-muted); }
    .cg-na { text-align:center; font-size:var(--fs-xs); }
    .cg-arqueo-tbl input.cg-total { width:7.5rem; text-align:right; padding:var(--sp-1) var(--sp-2);
                                    font-variant-numeric:tabular-nums; font-weight:700; }

    /* Los motivos de bloqueo van TODOS juntos: que se vea de una vez lo que falta. */
    .fin-blocks { margin:var(--sp-1) 0 0; padding-left:var(--sp-4); color:var(--warn-fg); font-size:var(--fs-sm); }

    /* ⭐ [CG.46] O.1 — MASTER-DETAIL PERMANENTE. El ancho del detalle (32rem) cae dentro de la
       banda que datos densos 8 fija para el panel de detalle (480-560px) y le deja al maestro lo
       suficiente para sus nueve columnas. */
    /* ⭐⭐ [CG.60] LOS DOS APARTADOS, A MITADES FIJAS.
       Aca vivia ".cg-split-capturando", que ensanchaba el panel de 24rem a 42rem MIENTRAS se
       capturaba. Se retira entero, y no por gusto: el ancho del arqueo venia dependiendo de una
       condicion, y esa condicion ya fallo dos veces -- [CG.49] descubrio que el umbral de dos
       columnas era INALCANZABLE por construccion, y [CG.57] que la consulta medía el panel en vez
       de la columna. Media pantalla reservada SIEMPRE no se puede romper asi.
       Las dos mitades son iguales a proposito: ninguna de las dos es "el detalle" de la otra. */
    /* ⭐⭐ YA NO HAY SPLIT: LA LISTA OCUPA LA PANTALLA ENTERA. Pedido de Edgar el 2026-10-16:
       "usemos toda la pantalla para presentar los movimientos y desplegamos una barra lateral a
       la izquierda con el arqueo".

       ⛔ Esto deroga "media pantalla reservada SIEMPRE" del parrafo de arriba. Hay que decir por
       que NO reintroduce lo que [CG.60] protegia: sus dos fallas eran de MEDICION -- [CG.49]
       encontro que el umbral de dos columnas era INALCANZABLE por construccion, y [CG.57] que la
       consulta medía el panel en vez de la columna. El pecado no era "el ancho depende de algo":
       era que dependia de un ancho MEDIDO. Aca no hay nada que medir, porque **no hay reparto**:
       una sola columna, y el arqueo encima en un cajon de ancho fijo.

       Y lo que [CG.60] queria -- que el arqueo nunca quede exprimido -- se cumple mejor que
       antes: en el cajon tiene 560px propios, no una mitad que compite con nueve columnas.

       ⚠️ .cg-split se CONSERVA como nombre aunque ya no parta nada: es el contenedor que
       recibe el alto restante de .cg-app (flex:1 1 auto; min-height:0), y esa cadena es lo que
       sostiene el "sin scroll de pagina" de [CG.113]. Renombrarlo es otro cambio. */
    .cg-split { display:grid; grid-template-columns:minmax(0,1fr);
                gap:var(--sp-4); align-items:stretch; }
    /* El cuerpo del arqueo dentro del cajon: el cajon ya da su propio scroll (.sp-body), asi
       que aca NO se vuelve a declarar overflow -- dos contenedores scrolleables anidados dejan
       la rueda del mouse decidiendo cual mueve, que es el defecto que nadie reporta y todos sufren. */
    /* ⛔⛔ [CG.115] SIN height:100% EL PIE ANCLADO NO SE PEGA A NADA, y Guardar se iba de la
       pantalla. Medido 2026-10-19 en el navegador, con un conteo que no cuadra (ahi aparece la
       explicacion del sobrante y el contenido crece):

           .cg-pie-arqueo   position:sticky bottom:0   -> termina en 954px, pliegue en 918
           .cg-ap-cuerpo    874 alto · overflow-y:auto · desborda 0   <- NO scrollea
           .sp-body         846 alto · overflow-y:auto · desborda 68  <- el que SI scrollea

       sticky se ancla al contenedor desplazable MAS CERCANO. Como .cg-ap-cuerpo declara
       overflow-y:auto, se lleva ese papel -- pero al no tener altura acotada crece con el
       contenido (874 dentro de un .sp-body de 846) y nunca se mueve, asi que el pie se queda
       en su sitio estatico mientras el scroll real pasa un nivel mas arriba.

       ⭐ Es la MISMA familia que [CG.113b]: un elemento que DECLARA la barra sin recibir
       altura. Alla era el host contra el armazon; aca es el cuerpo del arqueo contra el cajon.
       Declarar overflow no crea un scroller util si el alto es auto.

       Con height:100% el cuerpo se ajusta al cajon, el desborde vuelve a ser SUYO, y el pie
       sticky se pega a su borde: Guardar queda siempre a la vista, que es [CG.62]. */
    .cg-arqueo-cajon { display:block; height:100%; min-height:0; }
    /* La tarjeta de cada apartado: borde 1px y NINGUNA sombra -- in-page es una de las dos. */
    .cg-ap { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden;
             border:1px solid var(--border-color); border-radius:var(--r-md); }
    .cg-ap-head { flex:none; display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2);
                  padding:var(--sp-3) var(--sp-3) var(--sp-2); }
    /* El numero de orden: no es decoracion, es el ORDEN en que se hace el trabajo. */
    .cg-ap-n { flex:none; display:inline-flex; align-items:center; justify-content:center;
               width:1.25rem; height:1.25rem; border-radius:999px; align-self:center;
               background:var(--action); color:var(--action-ink);
               font-size:var(--fs-xs); font-weight:700; font-variant-numeric:tabular-nums; }
    .cg-ap-t { margin:0; font-size:var(--fs-body); font-weight:700; letter-spacing:-.01em; }
    .cg-ap-hint { font-size:var(--fs-xs); color:var(--text-muted); }
    /* ⭐ [CG.62] El atajo, ESCRITO. D.5: "un atajo que nadie sabe que existe no existe" -- y la
       navegacion por flechas de la reja llevaba varios commits funcionando sin que nada la
       anunciara. Las teclas van en <kbd>, que es lo que son. */
    .cg-ap-atajo { font-size:var(--fs-xs); color:var(--text-muted); white-space:nowrap; }
    /* [CGA-LEG.9] El atajo de la cola comparte renglon con los filtros, que ya van apretados:
       se permite que baje de linea en vez de empujar un control fuera de la vista. Es lo ultimo
       que tiene que caber, no lo primero que rompe. */
    .cg-atajo-cola { white-space:normal; }
    .cg-ap-atajo kbd { font-family:var(--font-mono); font-size:var(--fs-xs);
                       border:1px solid var(--border-color); border-radius:var(--r-sm);
                       padding:0 var(--sp-1); margin:0 1px; background:var(--surface-2); }
    /* ⛔ [CG.57] EL CONTENEDOR DE CONSULTA VIVE ACA. La reja del arqueo pregunta
       "@container (max-width:26rem)" para apilarse; si esto no declara container-type, la consulta
       sube hasta el ancestro que lo declare y contesta sobre OTRA caja -- que es justo el defecto
       que [CG.57] midio: la reja quedaba en dos columnas dentro de una de 311px, con scroll
       horizontal y la columna "Importe" cortada. */
    .cg-ap-cuerpo { flex:1 1 auto; min-height:0; overflow:auto; padding:0 var(--sp-3) var(--sp-3);
                    container-type:inline-size; }
    /* Dentro de un apartado, la bandeja ya NO es una tarjeta: seria un borde adentro de otro. */
    .cg-ap-cuerpo > .cg-bandeja { border:0; border-radius:0; padding:0; margin:var(--sp-3) 0 0;
                                  border-top:1px solid var(--border-color); padding-top:var(--sp-3); }
    .cg-detail { display:flex; flex-direction:column; gap:var(--sp-3); }
    /* El envoltorio que el @if inserta: hereda el reparto vertical de .cg-detail, o al meterlo
       en el medio el gap entre ficha, formulario y pie se perderia. */
    .cg-captura { display:flex; flex-direction:column; gap:var(--sp-3); min-width:0; }

    /* ⭐ [CG.63] LA ENTRADA DE LA CAPTURA. Reportado por Edgar: "al abrir no hace una animacion
       fluida". Hasta aca los dos apartados cambiaban de golpe -- el vacio desaparecia y el
       formulario aparecia en el mismo fotograma, sin nada que ligara el clic con el resultado.

       Las dos mitades entran como UN gesto: la ficha primero y el arqueo 60ms despues. El
       escalonado no es adorno, es el orden de lectura que esta pantalla ya declara (1 que vas a
       arquear, 2 el arqueo) hecho visible una vez.

       ⛔ Solo transform + opacity (DESIGN 8 / §Motion): nada de width/height/margin, que disparan
       layout y que check:motion rechaza. 250ms = --dur-standard, bien debajo del techo de 350. */
    @keyframes cgEntra {
      from { opacity:0; transform:translateY(6px); }
      to   { opacity:1; transform:translateY(0); }
    }
    .cg-entra      { animation:cgEntra var(--dur-standard) var(--ease-decelerate) both; }
    .cg-entra-tras { animation-delay:60ms; }
    /* ⚠️ Quien pide menos movimiento NO recibe una version mas lenta: recibe NINGUNA. El contenido
       tiene que quedar visible igual, asi que se anula la animacion entera y no solo su duracion
       -- con animation-duration en 0s y fill both el elemento se queda en el fotograma inicial. */
    @media (prefers-reduced-motion: reduce) {
      .cg-entra { animation:none; }
    }
    .cg-detail-pie { display:flex; align-items:center; justify-content:flex-end; gap:var(--sp-2);
                     padding-top:var(--sp-3); border-top:1px solid var(--border-color); }
    /* ⭐ [CG.62] El pie del ARQUEO queda pegado abajo. No es adorno: con el cambio devuelto
       abierto la columna pasa el alto de la pantalla, y un Guardar al final del contenido hay que
       ir a buscarlo scrolleando -- el mismo defecto que [CG.46] ya habia arreglado una vez. */
    .cg-pie-arqueo { position:sticky; bottom:0; z-index:2; background:var(--card-bg);
                     margin-top:var(--sp-3); padding-bottom:var(--sp-2); }
    .cg-pie-falta { font-size:var(--fs-xs); }
    /* Cancelar se queda con la ficha y en texto: es la salida, no la accion. Con los dos botones
       juntos abajo, el que cierra sin guardar quedaba del mismo tamano que el que guarda. */
    .cg-pie-cancelar { justify-content:flex-start; }
    .cg-conf { display:flex; flex-direction:column; gap:var(--sp-3); }
    /* ⭐ [CG.67] El recuadro de la firma. Va pegado al pie del arqueo: se firma el monto
       CONTADO, asi que no puede estar arriba de donde se cuenta. */
    .cg-firma { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-3);
                padding-top:var(--sp-3); border-top:1px solid var(--border-color); }
    .cg-firma-head { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cg-firma-ok { display:inline-flex; align-items:center; gap:var(--sp-1);
                   font-size:var(--fs-xs); font-weight:700; color:var(--ok-soft-fg); }
    .cg-firma-falta { font-size:var(--fs-xs); }
    /* ⛔ touch-action:none es lo que impide que el dedo SCROLLEE en vez de dibujar. Sin esto,
       en un telefono la firma es imposible: el gesto se lo come la pagina. */
    /* [CG.68] El codigo se dicta en voz alta o se lee de lejos. */
    .cg-firma-codigo { display:flex; align-items:center; gap:var(--sp-4);
                       padding:var(--sp-3); border:1px dashed var(--action);
                       border-radius:var(--r-md); background:var(--action-ring); }
    .cg-firma-cod-txt { display:flex; flex-direction:column; align-items:flex-start; gap:var(--sp-1);
                        flex:1 1 auto; min-width:0; }
    .cg-firma-cod { font-size:var(--fs-h1); font-weight:700; letter-spacing:.18em; line-height:1; }
    /* [CG.74] El QR. Fondo BLANCO siempre, tambien en tema oscuro: un QR invertido no lo lee
       ninguna camara, y esta pantalla se usa en oscuro. El padding es la zona de silencio que
       el lector necesita alrededor del patron. */
    .cg-firma-qr { flex:none; background:#FFFFFF; padding:var(--sp-2); border-radius:var(--r-sm,4px);
                   line-height:0; }
    .cg-firma-qr svg { display:block; }
    .cg-firma-elegir { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap;
                       font-size:var(--fs-xs); }
    .cg-firma-remota { display:flex; flex-direction:column; gap:var(--sp-2); }
    .cg-firma-img { width:100%; max-height:9rem; object-fit:contain; background:#FFFFFF;
                    border:1px solid var(--border-color); border-radius:var(--r-md); }
    .cg-firma-remota-pie { display:flex; align-items:center; gap:var(--sp-2); }
    /* Con la firma del telefono puesta, el canvas no se esconde con @if: perderia el trazo y el
       ViewChild, y "Rehacer" tendria que re-prepararlo. Se oculta nada mas. */
    .cg-oculto { display:none; }
    .cg-firma-pad { width:100%; height:9rem; touch-action:none; cursor:crosshair;
                    background:#FFFFFF; border:1px dashed var(--border-color);
                    border-radius:var(--r-md); }
    .cg-conf-que { margin:0; font-size:var(--fs-sm); line-height:1.5; }
    .cg-detail-nada, .cg-ap-nada {
                      display:flex; flex-direction:column; align-items:flex-start; gap:var(--sp-2);
                      padding:var(--sp-6) var(--sp-2); color:var(--text-muted);
                      font-size:var(--fs-sm); }
    /* Vacio operacional: NO centrado -- DESIGN lista "centered everything en empties" como
       antipatron de Operations. */
    .cg-detail-nada i, .cg-ap-nada i { font-size:var(--fs-h2); color:var(--text-faint); }
    .cg-detail-nada strong, .cg-ap-nada strong { color:var(--fg-1); font-size:var(--fs-body); }
    .cg-detail-nada p, .cg-ap-nada p { margin:0; }

    /* ⭐ [CG.60] LA FICHA: que se va a arquear. El arqueo CONTESTA esta pregunta, y hasta ahora
       la pregunta se leia en un renglon gris de 11px al lado del titulo del panel. */
    .cg-ficha { display:flex; flex-direction:column; gap:var(--sp-2);
                position:sticky; top:0; z-index:2; background:var(--card-bg);
                padding-bottom:var(--sp-2); border-bottom:1px solid var(--border-color); }
    .cg-ficha-top { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cg-ficha-doc { font-size:var(--fs-xs); color:var(--text-muted); }
    /* Misma cuenta que .cg-fila-doc: --text-faint no pasa AA en NINGUNA de las cuatro superficies
       de esta pantalla, en ninguno de los dos temas (2.33 claro / 3.67 oscuro sobre card-bg,
       contra el piso de 4.5). Y esto es la FECHA DE VALOR del movimiento que se esta capturando:
       se lee, no se decora. --text-muted da 7.73 en claro y 6.91 en oscuro. */
    .cg-ficha-fecha { font-size:var(--fs-xs); color:var(--text-muted); }
    .cg-ficha-nombre { margin:0; font-size:var(--fs-h3); font-weight:700; letter-spacing:-.02em;
                       line-height:1.25; overflow-wrap:anywhere; }
    .cg-ficha-cifra { display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; }
    .cg-ficha-monto { font-size:var(--fs-h1); font-weight:700; letter-spacing:-.02em; line-height:1; }
    /* Sin documento no hay contra que cuadrar: el numero se atenua para que no se lea como
       "el ERP dice esto". Declarar la ausencia, no dibujar un cero con el mismo peso. */
    .cg-ficha-libre { color:var(--text-muted); }
    .cg-ficha-pie { font-size:var(--fs-xs); color:var(--text-muted); }
    /* El signo, en pildora: lo primero que se mira y lo unico que no se puede equivocar. */
    .cg-signo { flex:none; display:inline-flex; align-items:center; gap:var(--sp-1);
                padding:2px var(--sp-2); border-radius:999px; font-size:var(--fs-xs); font-weight:700;
                background:var(--warn-soft-bg); color:var(--warn-soft-fg);
                border:1px solid var(--warn-border); }
    .cg-signo-in { background:var(--ok-soft-bg); color:var(--ok-soft-fg);
                   border-color:var(--ok-border); }
    .cg-signo > i { font-size:var(--fs-xs); }

    /* CG.20 - la bandeja de entregas. Densa, tipo Operations: la persona la recorre marcando. */
    .cg-bandeja { border:1px solid var(--border-color); border-radius:var(--r-md,8px);
                  padding:var(--sp-3); margin:var(--sp-4) 0; }
    .cg-bandeja-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin-bottom:var(--sp-2); }
    /* [CG.47] El segundo renglón: los controles. Separado del título a propósito — mezclarlos en
       un solo flex dejaba el reparto al azar del ancho. El buscador es el que cede espacio. */
    .cg-bandeja-controles { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2);
                            margin-bottom:var(--sp-2); }
    .cg-bandeja-controles .cg-buscar { flex:1 1 14rem; min-width:10rem; }
    /* [CG.45] Los TRES niveles de Q.5, por tipo y contraste -- nunca por color ni por otra caja.
       Primario: la cifra accionable, mono tabular para que se lea como cifra. Secundario: de
       cuantas. Terciario: el alcance, que ya lo pinta .fin-dim. */
    .cg-lead { font-family:var(--font-mono); font-variant-numeric:tabular-nums;
               font-size:var(--fs-sm); font-weight:700; color:var(--fg-1); }
    .cg-lead-sub { font-family:var(--font-body); font-weight:400; color:var(--text-muted); }
    .cg-bandeja-head .fin-h2 { margin:0; }
    .cg-bandeja-sp { flex:1 1 auto; }
    /* ⛔ ACA VIVIA ".cg-tbl": una tabla entera dibujada a mano (ancho, colapso de bordes, color
       de cabecera, borde inferior de cada celda). Eran TRES tablas de datos usandola mientras
       otras dos en la MISMA pantalla ya eran p-table -- o sea dos tablas con distinto borde,
       distinto alto de fila y distinto flip a oscuro, una al lado de la otra. Las tres pasaron
       a p-table y la clase se retira completa. */
    /* La fila trabada se ve distinta PERO SIGUE VISIBLE: esconderla dejaria a la persona sin
       saber que ese movimiento existe y que alguien tiene que declarar su cuenta.
       ⚠️ El .62 de antes se comia tambien el motivo, que es justo lo que hay que poder leer:
       texto de .78rem al 62% no pasa AA. Se atenua la fila y se EXCLUYE el motivo. */
    .cg-trabada { opacity:.78; }
    .cg-trabada .fin-hint-warn { opacity:1; }
    /* [CG.33] Misma exclusion para la marca nueva: con el .78 de la fila, --text-muted cae a
       4.10 y deja de pasar AA. Medido en vivo, no estimado. */
    /* ⛔ [CG.47] DOS fallas apiladas, y ninguna daba error.
       1) Acá decía ".cg-motivo" y la clase real es ".cg-motivo-tag": el selector no casaba.
       2) Y aunque hubiera casado, tampoco servía: la marca se pintaba con
          styleClass="cg-motivo-tag" y **p-tag de PrimeNG 22 NO tiene ese input** (0 menciones en
          su bundle, verificado). Angular lo dejaba como atributo HTML crudo —se ve
          styleclass="..." en el DOM— y la clase nunca llegaba al elemento. Se cambió a class=,
          que Angular sí fusiona con las clases del componente.
       O sea que la exclusión que [CG.33] escribió después de MEDIR el contraste en vivo ("con el
       .78 de la fila, --text-muted cae a 4.10 y deja de pasar AA") nunca se aplicó, y lo mismo
       el tamaño y el margen de la marca. ⚠️ El repo tiene 99 p-tag con styleClass: todos inertes. */
    .cg-trabada .cg-motivo-tag { opacity:1; }
    /* ⭐ TERCERA exclusion, por la MISMA cuenta de [CG.33] y la misma razon: el folio. Es el
       identificador con el que se coteja la fila contra el documento del ERP, y con el .78 encima
       su --text-muted cae a 4.12 -- el mismo 4.10 que [CG.33] midio y que lo decidio a excluir el
       motivo. ⚠️ Y pesa aca mas que en ningun lado: medido abajo, ~74% de la cola es fila trabada,
       asi que "atenuado" es el estado NORMAL del folio, no la excepcion. */
    .cg-trabada .cg-fila-doc { opacity:1; }
    /* ⭐⭐ [CG.77] LA FILA TRABADA OCUPA MENOS ALTO. Pedido de Edgar el 2026-10-09: "lo que no es
       seleccionable hacerlo mas pequeño, visible pero que no quite espacio".

       ⛔ Y no es una fila de cada tantas: MEDIDO en prod ese dia, la cola tiene 2,035 movimientos
       en su ventana de 45 dias -- 537 ingresos (431 con ruta declarada, o sea confirmables) y
       **1,498 gastos contra UNA sola regla de clasificacion**. O sea que ~74% de la tabla es fila
       trabada. Lo que llena la pantalla no es el trabajo: es lo que todavia NO se puede hacer.

       Dos cambios, ninguno de color ni de contraste -- el color ya se neutralizo en [CG.47] y la
       legibilidad del motivo se midio en vivo en [CG.33]:

         1) la marca del motivo sube AL RENGLON del nombre. Hoy entra con margin-top y abre un
            segundo renglon dentro de la celda: con 1,498 filas eso son 1,498 renglones de alto
            que no dicen nada nuevo (el motivo ya va agrupado y contado arriba, [CG.37]).
         2) las celdas pierden la mitad del alto vertical.

       ⚠️ Lo que NO se toca, a proposito: la opacidad de la fila (.78, ya calibrada), el tamaño de
       la marca ni el del nombre. Achicar la tipografia de una fila ya atenuada es justo lo que
       [CG.33] midio que tiraba el contraste abajo de AA -- "mas chico" se consigue con el alto,
       no con la letra. Y la fila SIGUE en la lista y SIGUE seleccionable para abrirla a mano:
       esconderla dejaria a la persona sin saber que el movimiento existe. */
    .cg-trabada > td { padding-top:var(--sp-1); padding-bottom:var(--sp-1); }
    .cg-trabada .cg-motivo-tag { margin-top:0; margin-left:var(--sp-2); vertical-align:middle; }
    /* ⛔ [CG.48] Acá vivía ".cg-contado", el input de conteo por renglón de la bandeja. Se fue
       con su columna: era la única forma de meter una cifra contada al libro SIN desglose. */
    /* [CG.87] El reporte en pantalla. Mono y sin envolver: el cuerpo viene alineado en columnas
       de ancho fijo desde el mismo armador que el papel; con tipografia proporcional los totales
       se desalinean y el reporte deja de leerse de un vistazo. El scroll horizontal es
       PREFERIBLE a romper las columnas. */
    .cg-reporte { margin:0; max-height:60vh; overflow:auto; font-family:var(--font-mono);
                  font-size:var(--fs-xs); line-height:1.45; white-space:pre; color:var(--text); }
    .cg-rezago { margin:var(--sp-2) 0 0; font-size:var(--fs-xs); }
    /* [CGS.7] El folio para anotar. Mono y tabular porque se copia DIGITO POR DIGITO a un papel:
       con tipografia proporcional el 0 y la O, y el 1 y la l, se confunden al transcribir. */
    .cg-folio-num { margin:0; text-align:center; font-family:var(--font-mono);
                    font-size:var(--fs-display); font-variant-numeric:tabular-nums;
                    letter-spacing:.04em; color:var(--text-main); overflow-wrap:anywhere; }
    .cg-folio-pie { margin:var(--sp-2) 0 0; text-align:center; font-size:var(--fs-xs);
                    color:var(--text-muted); }
    /* [CG.56] La columna de la MARCA. Ya no hay casilla: la fila es el control y esta celda sólo
       publica el estado. Angosta a proposito -- es una senial, no un boton. */
    .cg-th-marca, .cg-td-marca { width:2.25rem; text-align:center; padding-left:var(--sp-2); }
    .cg-td-marca > i { font-size:var(--fs-xs); color:var(--action); }
    /* ⭐ [CG.61] LA COLA, COMPACTA. Con la cola dentro del apartado 1 la tabla tiene MEDIA
       pantalla: la contraparte es la que cede, porque es la unica de ancho libre. El nombre se
       corta con puntos suspensivos y el documento baja a una segunda linea chica. */
    /* ⛔ [CG.63] Y ACA [CG.61] SE PASO DE ROSCA. Reportado por Edgar: "el boton de capturar se ve
       muy poco". Al pasarlo a icono le puse ademas [text]=true, que en PrimeNG es SIN fondo y SIN
       borde: en una tabla densa eso no se lee como un boton, se lee como un glifo suelto. El
       ancho que habia que recuperar eran los ~5rem del rotulo, no la affordance.
       Queda delineado (ver la plantilla) y la celda le da aire para que el borde no se recorte. */
    .cg-th-abrir, .cg-td-abrir { width:2.75rem; text-align:center; padding:0 var(--sp-1); }
    .cg-fila-nom { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* ⛔⛔ EL FOLIO FALLABA AA EN TODAS LAS FILAS, no solo en las trabadas. Medido sobre el
       MISMO fondo que midio [CG.33] --rgb(244,244,245), el del DOM vivo de prod-- contra el piso
       AA de 4.5 para texto chico:
         --text-faint (#A1A1AA)  2.33  FALLA   (y dentro de .cg-trabada, al 78%: 1.89)
         --text-muted (#52525B)  7.03  pasa    (al 78%: 4.12, FALLA)
       El 4.12 de --text-muted al 78% reproduce el 4.10 que [CG.33] ya habia medido por su cuenta,
       o sea que las dos mediciones concuerdan y esta no es una cuenta nueva: es la MISMA regla
       aplicada a la celda que quedo afuera.
       ⭐ Y esto NO es "el folio se ve tenue": el folio es el identificador con el que se coteja
       el renglon contra el documento del ERP (X-D-26 0000346). Es el dato que se va a leer
       caracter por caracter, y estaba en el color mas claro de la escala.
       Pasa a --text-muted (7.03) Y sale de la atenuacion de .cg-trabada, que es exactamente lo
       que [CG.33] hizo con .fin-hint-warn y .cg-motivo-tag por la misma razon. Sigue siendo
       terciario: lo subordina el TAMANO, no un color que no se lee.
       ⚠️ Queda DECLARADO lo que no se arregla aca: --text-faint da 2.33 y lo usan 112 archivos de
       apps/view. Repuntar el token es decision de Edgar, no de esta pantalla. Y --fs-nano (10px)
       para un folio que se transcribe sigue siendo chico aunque ahora contraste. */
    /* ⭐ [CGA-LEG.4] SE CIERRA LA DEUDA QUE EL BLOQUE DE ARRIBA DEJO DECLARADA -- textual:
       "--fs-nano (10px) para un folio que se transcribe sigue siendo chico aunque ahora
       contraste". Medido el 2026-10-19: el folio salia a 10px mientras su importe iba a 24.8.
       La cifra en grande y su identificador en lo mas chico de la pantalla, cuando lo que se
       lee caracter por caracter contra el papel es el folio. Sube a --fs-sm (13px), el mismo
       peldano del cuerpo de la tabla: deja de ser terciario por TAMANO y queda subordinado por
       color, que es lo que [CG.33] ya habia decidido para este mismo dato. */
    .cg-fila-doc { color:var(--text-muted); font-size:var(--fs-sm); }
    /* ⭐ [CGA-A.15] La ruta. Mismo par color/tamano que .cg-fila-doc, que YA paso la auditoria
       de contraste AA sobre el fondo vivo de prod (ver el bloque de arriba): se reusa en vez de
       elegir un color nuevo que habría que volver a medir. */
    /* El concepto del ERP puede ser largo: se recorta con elipsis, igual que el nombre de la
       contraparte. Se recorta en CSS y no en TS a proposito -- asi no se pierde texto, se
       adapta al ancho real de la celda, y la ficha de la fila sigue teniendo el concepto entero. */
    .cg-fila-ruta { display:block; color:var(--text-muted); font-size:var(--fs-xs); font-weight:600;
                    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* ⚠️ Lo que una casilla daba y una fila seleccionada no: que el estado se lea de un vistazo.
       Fondo propio MAS una barra en --action, para que no dependa de que el tema pinte su
       p-highlight ni del contraste de un fondo solo. */
    /* ⛔ Acá escribí "var(--action-soft-bg)" y ESE TOKEN NO EXISTE: la familia --action son
       action/hover/press/ink/ring, sin fondo suave. Una declaración con un token inexistente no
       falla: se cae en silencio y la fila marcada se habría visto igual que las demás --
       justo lo único que esta celda viene a resolver. Lo agarró check:tokens.
       Se usa --action-ring, que ES el translúcido de esta familia, y la barra sólida al borde. */
    .cg-fila-marcada > td, .cg-fila-marcada > th { background:var(--action-ring); }
    .cg-fila-marcada > td:first-child { box-shadow:inset 3px 0 0 0 var(--action); }
    /* ⭐⭐ [CG.63] LA FILA ES EL BOTON. Edgar: "es el boton principal de la interaccion... al
       darle clic a todo el movimiento se despliegue el menu". Un renglon que abre algo tiene que
       DECIRLO antes del clic, y eso son tres cosas: el cursor, el fondo al pasar por encima, y el
       galon que apunta a donde va. Sin las tres, un renglon clicable se descubre por accidente. */
    .cg-bandeja-tbl tbody tr { cursor:pointer; }
    .cg-bandeja-tbl tbody tr:hover > td { background:var(--surface-2); }
    .cg-td-abrir > i { color:var(--text-faint); font-size:var(--fs-xs); }
    .cg-bandeja-tbl tbody tr:hover .cg-td-abrir > i { color:var(--action); }
    /* ⚠️ ABIERTA y MARCADA son DOS cosas distintas y no se pueden pintar igual: una es "en esto
       estoy trabajando" y la otra "esto entra al lote". El galon en --action y el borde dicen
       cual esta abierta; el fondo y la barra izquierda, cual esta marcada. */
    .cg-fila-abierta > td { box-shadow:inset 0 -1px 0 0 var(--action), inset 0 1px 0 0 var(--action); }
    /* ⭐ EL GALON GIRA, no se corre. Era translateX(2px): 2 pixeles de desplazamiento con el MISMO
       color que ya tiene el hover, o sea que "abierta" se distinguia de "el mouse esta encima"
       por nada. Apuntando hacia abajo la diferencia es de FORMA, que es la unica que sobrevive a
       los tres modos -- y de paso dice lo que hace: lo de abajo se desplego. */
    .cg-fila-abierta .cg-td-abrir > i { color:var(--action); transform:rotate(90deg); }
    /* ⛔⛔ EN ALTO CONTRASTE DE WINDOWS, "abierta" DESAPARECIA. La flota es Windows y
       forced-colors es el tercer modo (DESIGN.md), no un extra: ahi el box-shadow de arriba
       NO SE DIBUJA --lo documenta libs/ui-web/src/forced-colors.css, que por eso rehace el anillo
       de foco con outline-- y el color de la familia action del galon lo sustituye el sistema.
       Las dos senales de la fila abierta se caian juntas y quedaba identica a las otras.
       La hermana no tenia el problema: .cg-fila-marcada ademas pinta un icono de palomita en su
       celda, que es un GLIFO y se ve en cualquier modo. Esta no tenia redundante.
       El borde SI se dibuja en forced-colors, asi que reconstruye la misma banda de arriba y
       abajo que el box-shadow pinta en los otros dos modos. Mismo mensaje, otra propiedad. */
    @media (forced-colors: active) {
      .cg-fila-abierta > td { border-top:2px solid Highlight; border-bottom:2px solid Highlight; }
    }

    /* [CG.53] La reja en dos columnas y el numero grande. Una caja con borde y SIN sombra -- in-page
       es una de las dos, nunca las dos. */
    .cg-reja2 { display:grid; grid-template-columns:minmax(0,1fr) 1px minmax(0,1fr);
                border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; }
    .cg-reja-sep { background:var(--border-color); }
    .cg-reja-col { min-width:0; padding:var(--sp-1) var(--sp-2) var(--sp-2); }
    .cg-reja-mor { grid-column:1 / -1; border-top:1px solid var(--border-color);
                   display:flex; align-items:center; gap:var(--sp-2);
                   padding:var(--sp-2) var(--sp-3); font-size:var(--fs-sm); }
    /* ⛔ Con el apartado angosto las dos columnas de la reja se desbordarian: se apilan.
       [CG.60] La caja que esta consulta mide es .cg-ap-cuerpo, el apartado 2 -- antes era la
       columna .cg-col y, antes de [CG.57], el panel entero, que es de donde salio el defecto.
       Es @container y no @media por DESIGN §R: lo que decide el layout de la reja es el ancho de
       SU apartado, no el de la ventana; en un monitor ancho un @media no dispararia nunca. */
    @container (max-width:26rem) {
      .cg-reja2 { grid-template-columns:1fr; }
      .cg-reja-sep { display:none; }
    }

    /* ⛔⛔ [CG.114] LAS REGLAS "MOVILES" DE styles.css SE COMIAN LA REJA. Medido 2026-10-19 en
       el navegador, con el arqueo abierto:

           cada tabla pedia  304px   y su contenedor daba  210px   -> 94px de desborde
           cabecera Piezas   x=154..258
           cabecera Importe  x=164          <- dibujada ENCIMA, se leia "IPieporzaste"

       styles.css:931 tiene un bloque "Mobile table optimizations" bajo
       @container (max-width: 48rem) que le pone a TODA celda de p-datatable un
       min-width de 120px, y a la ULTIMA columna min-width 100px + position:sticky + right:0
       -- pensado para fijar una columna de acciones en un telefono.

       ⭐ Nunca habian disparado acá porque la caja que esa consulta mide es .cg-ap-cuerpo, y
       como apartado del split medía mas de 768px. Al mudar el arqueo a un cajon de 560 el
       cuerpo quedo en 504px: por debajo del umbral movil. O sea que la regresion no fue tocar
       la reja -- fue cambiarle el ANCHO A SU CONTENEDOR, y una consulta de contenedor ajena
       cambio de rama sola.

       Los dos sintomas son uno: con min-width de 120px la tabla no entra, aparece el desborde
       horizontal, y recien ahi el sticky de la ultima columna tiene contra que pegarse y se
       monta sobre la vecina. Quitando el minimo desaparecen los dos.

       Esto NO es una tabla de datos con columnas de sobra: son tres columnas de ancho conocido
       (denominacion, piezas, importe) que deben caber en su mitad. El minimo generico sobra.
       Se neutraliza SOLO acá, por la clase de esta tabla -- la regla global sigue sirviendo a
       las tablas anchas para las que se escribio. */
    :host ::ng-deep .cg-arqueo-tbl .p-datatable-thead > tr > th,
    :host ::ng-deep .cg-arqueo-tbl .p-datatable-tbody > tr > th,
    :host ::ng-deep .cg-arqueo-tbl .p-datatable-tbody > tr > td { min-width:0 !important; }
    :host ::ng-deep .cg-arqueo-tbl .p-datatable-thead > tr > th:last-child,
    :host ::ng-deep .cg-arqueo-tbl .p-datatable-tbody > tr > td:last-child {
      position:static !important; box-shadow:none !important;
    }

    /* EL numero de la pantalla. --fs-display es "headline metric, UNA por vista" y esta pantalla
       no lo usaba en ningun lado: lo contado es exactamente la cifra que lo merece. */
    .cg-total-bloque { display:flex; align-items:center; gap:var(--sp-3); margin-top:var(--sp-2);
                       padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color);
                       border-radius:var(--r-md); }
    .cg-total-bloque.es-ok   { background:var(--ok-soft-bg);   border-color:var(--ok-border); }
    .cg-total-bloque.es-warn { background:var(--warn-soft-bg); border-color:var(--warn-border); }
    .cg-lbl-micro { font-size:var(--fs-xs); font-weight:500; color:var(--text-muted);
                    text-transform:uppercase; letter-spacing:.06em; }
    .cg-total-n { font-size:var(--fs-display); font-weight:700; line-height:1.05;
                  letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
    .cg-total-bloque.es-ok   .cg-total-n { color:var(--ok-soft-fg); }
    .cg-total-bloque.es-warn .cg-total-n { color:var(--warn-soft-fg); }
    .cg-total-der { text-align:right; min-width:0; }
    .cg-total-v { display:inline-flex; align-items:center; gap:var(--sp-1);
                  font-size:var(--fs-sm); font-weight:700; color:var(--text-muted); }
    .cg-total-bloque.es-ok   .cg-total-v { color:var(--ok-soft-fg); }
    .cg-total-bloque.es-warn .cg-total-v { color:var(--warn-soft-fg); }
    .cg-total-esp { font-size:var(--fs-xs); color:var(--text-muted); margin-top:var(--sp-1); }
    .cg-total-regla { margin:var(--sp-1) 0 0; font-size:var(--fs-xs); color:var(--text-muted); line-height:1.45; }
    /* ⭐ [CG.59] LA PANTALLA ES LA TAREA. Alto fijo y sin scroll de pagina: arriba la barra
       (el 10%), abajo los dos apartados (el 90%). Lo que scrollea es el contenido de cada
       apartado, nunca la pagina -- con la pagina scrolleando, el arqueo se iba de la vista justo
       mientras se cuenta. */
    /* ⛔⛔ [CG.113] FALTABA, y es la regla que DESIGN.md llama no negociable: sin
       ":host { display:block }" el <app-...> es INLINE, no establece bloque, y el alto que su
       hijo pide no tiene contra que resolverse. Es lo primero que hay que mirar cuando alguien
       reporta que una pantalla "no llena" o "se arrastra". */
    /* ⛔⛔ [CG.113b] EL height:100% DE ABAJO ESTABA INERTE, y por eso la pantalla scrolleaba
       igual. MEDIDO el 2026-10-19 en el navegador, con la app corriendo:

           section.pane.flex-1             542px   block   overflow-y:auto   <-- el scroller
             div.motion-safe:...fade-in-up 1539px  block   height:AUTO       <-- el eslabon que falta
               app-finanzas-caja-general   1539px                            <-- 3x su lugar

       El comentario de [CG.113] traza la cadena del layout pero SE SALTA ese div: el armazon
       envuelve al router-outlet en un bloque sin alto (layout.component.html:464). Y un
       height:100% contra un padre height:auto **se resuelve como auto, sin aviso** -- no hay
       error, no hay warning, la regla simplemente no hace nada. La cadena interna de
       min-height:0 estaba bien escrita todo este tiempo; nunca recibio contra que resolver.

       ⭐ Por eso leer el componente solo no alcanzaba para verlo, y yo mismo lo di por
       resuelto dos veces: el defecto no esta en esta hoja, esta en el eslabon de arriba.

       position:absolute + inset:0 se ancla a section.pane, que YA es relative, y salta el div
       sin alto. Asi el host mide exactamente el hueco disponible y la cadena de abajo por fin
       tiene contra que trabajar. Se queda el height:100% como respaldo para el dia que el
       armazon le de alto al envoltorio.

       ⛔ NO se toca el armazon: ese div lo comparten las 255 pantallas de la app, y casi todas
       SI quieren scrollear. Esta pantalla es la excepcion ([CG.59]: la pantalla es la tarea),
       asi que la excepcion se declara aca, no alla. */
    :host { display:block; position:absolute; inset:0; height:100%; min-height:0; }

    /* ⛔⛔ [CG.113] ACA DECIA "height:100vh", Y ESE ERA EL SCROLL QUE EDGAR VE.
       Medida la cadena del layout:

           <div class="h-[100dvh] overflow-hidden">        la ventana entera
             <header>  la barra superior de la Suite  </header>
             <main class="flex-1 min-h-0 overflow-hidden">
               <section class="overflow-y-auto">          <-- el que scrollea
                 ESTA PANTALLA

       O sea que el espacio disponible vale "100dvh menos la barra", y pedir 100vh pide una
       VENTANA ENTERA adentro de el. Sobra siempre exactamente el alto de la barra: scroll
       permanente por construccion, y el overflow:hidden de aca recorta justo lo de abajo --
       que es donde vive el arqueo. El sintoma que reporto Edgar ("mucho scroll", "se pierde el
       foco") no era de maquetacion densa: era esta unidad.

       100% mide el CONTENEDOR, que es lo que [CG.59] queria decir con "la pantalla es la tarea".
       ⚠️ Y 100% necesita que el ancestro tenga alto: por eso el :host de arriba, que ademas lo
       declara explicito en vez de confiar en que el layout no cambie. */
    .cg-app { height:100%; min-height:0; overflow:hidden; display:flex; flex-direction:column;
              padding-top:0; padding-bottom:0; }
    .cg-app > .cg-split { flex:1 1 auto; min-height:0; }

    /* [CG.125] EL DESPLEGABLE DEL LIBRO. Rejilla de fichas: cada dato con su rotulo encima, en
       vez de una lista de "clave: valor" que obliga a leer renglon por renglon.
       auto-fit + minmax hace que en angosto caiga a una columna sin un solo breakpoint. */
    .cg-det-rejilla { display:grid; gap:var(--sp-3);
                      grid-template-columns:repeat(auto-fit, minmax(13rem, 1fr));
                      padding:var(--sp-3); background:var(--layout-bg);
                      border-radius:var(--r-sm,6px); }
    .cg-det-rejilla > div { min-width:0; font-size:var(--fs-sm); overflow-wrap:anywhere; }
    .cg-det-ancho { grid-column:1 / -1; }
    /* El rotulo NO va en gris claro: es la unica pista de que es cada dato. Peso, no color.
       (Lo que la fase de legibilidad midio: 41 atenuados contra 5 enfatizados.) */
    .cg-det-r { display:block; font-size:var(--fs-xs); font-weight:700;
                letter-spacing:.04em; text-transform:uppercase; color:var(--text-muted);
                margin-bottom:var(--sp-1); }
    .cg-libro-det > td { padding:0 !important; }
    /* Los dos filtros del libro, separados de los calendarios: filtran OTRA cosa. Cada uno con
       su rotulo encima, porque dos segmented pegados sin nombre se leen como un solo control
       partido -- y son dos preguntas distintas. */
    .cg-libro-filtros { display:flex; flex-wrap:wrap; gap:var(--sp-4);
                        margin:var(--sp-2) 0 var(--sp-3); }
    .cg-libro-filtros > div { min-width:0; }
    /* [CG.121] La barra del area toma su alto natural y NO cede. El default de un hijo flex es
       flex:0 1 auto -- no crece, pero SI se encoge -- y un selector aplastado deja de leerse
       justo cuando la cola se llena, que es cuando mas hace falta cambiar de pantalla. */
    .cg-app > app-caja-tabs { flex:none; }
    /* ⛔ [CG.73] El saldo que [CG.71] metio en esta barra APRETABA a sus vecinos: medido en la
       pagina viva, el titulo caia a DOS lineas (60px) y el desplegable de la jornada a 57px.
       La barra no declaraba quien cede: ".cg-saldo" ya se encogia, pero el h1 y el boton tambien,
       y un titulo partido en "Caja / General" se lee como un defecto de la pantalla.
       Ahora cede SOLO el saldo. Medido con la regla puesta en vivo: titulo 60 -> 30px (una linea),
       boton 57 -> 37px, y el saldo hasta gana ancho (317 -> 350px).
       El flex-wrap es el piso: si en una pantalla angosta ni encogiendo el saldo entra todo,
       la barra baja a dos renglones en vez de desbordar. */
    .cg-bar { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-3); flex:none;
              padding:var(--sp-2) 0; border-bottom:1px solid var(--border-color); }
    .cg-bar-id { flex:none; }
    .cg-bar-id > h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.02em;
                      white-space:nowrap; }
    /* El desplegable: un <button> con su aria-expanded, no un div con (click). */
    .cg-candado { display:flex; gap:var(--sp-3); align-items:flex-start; margin-block:var(--sp-3); padding:var(--sp-3);
                  border:1px solid var(--bad-fg); border-radius:var(--r-md); color:var(--text-main); }
    .cg-candado > .pi { color:var(--bad-fg); margin-top:var(--sp-1); }
    .cg-candado--llave { border-color:var(--border-color); }
    .cg-candado--llave > .pi { color:var(--text-muted); }
    .cg-candado-txt { display:flex; flex-direction:column; gap:var(--sp-2); }
    .cg-candado-acc { display:flex; gap:var(--sp-2); flex-wrap:wrap; align-items:center; }
    .cg-resp-obs { margin:0 0 var(--sp-3); color:var(--text-main); }
    .cg-resp-label { display:block; font-size:var(--fs-sm); font-weight:600; margin-bottom:var(--sp-1); }
    .cg-resp-texto { width:100%; }
    .cg-resp-ayuda { display:block; margin-top:var(--sp-2); color:var(--text-muted); font-size:var(--fs-sm); }
    .cg-jornada-btn { display:inline-flex; flex:none; align-items:center; gap:var(--sp-2); cursor:pointer;
                      font-family:inherit; color:var(--fg-1); text-align:left;
                      background:var(--card-bg); border:1px solid var(--border-color);
                      border-radius:var(--r-md); padding:var(--sp-2) var(--sp-3); }
    .cg-jornada-btn > i { font-size:var(--fs-xs); color:var(--text-muted); }
    .cg-jornada-btn > strong { font-size:var(--fs-sm); font-weight:600; }
    .cg-jornada-sep { width:1px; height:1rem; background:var(--border-color); }
    .cg-jornada-res { font-size:var(--fs-sm); color:var(--text-muted); white-space:nowrap; }
    .cg-jornada-btn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
    /* Abierta, la jornada tiene SU scroll y un techo: no puede empujar la tarea fuera de la
       pantalla, que es exactamente lo que hacia antes de plegarse. */
    /* ⛔⛔ [CG.113] DECIA "flex:none; max-height:52vh", y las dos mitades estaban mal.
     *
     * (1) 52vh es MAS DE MEDIA PANTALLA para lo que el propio comentario de la plantilla llama
     *     "el 10%: lo que NO es la tarea". Con la jornada abierta, al arqueo -- que es el
     *     trabajo -- le quedaba menos de la mitad. Edgar, con la pantalla a la vista:
     *     "perdida del foco (Arqueo y movs)". Era literal, estaba en el CSS.
     *
     * (2) "flex:none" significa NO SE ENCOGE: cuando faltaba espacio, el que cedia era el
     *     arqueo, nunca este panel. La prioridad declarada estaba invertida en el codigo.
     *
     * (3) Y "vh" es la misma unidad equivocada que [CG.113] corrigio en .cg-app: mide la
     *     VENTANA, no el contenedor, que vale una barra superior menos. 40% mide el padre.
     *
     * Con 40% y "flex:0 1 auto", el arqueo conserva 60% SIEMPRE y este panel cede primero. */
    /* [CG.116] Ya no es un hijo flex del tablero: vive dentro de una ventana, que le pone su
       propio alto maximo y su propio scroll. Topar el alto ACA ademas del contentStyle daria dos
       barras de scroll anidadas -- el defecto que [CG.113] vino a quitar, de vuelta. */
    .cg-jornada { padding:var(--sp-2) 0; }
    /* El dialogo manda su contenido a un contexto propio, asi que las clases cg-* de adentro se
       apoyan en los estilos GLOBALES; lo unico que hace falta es que el ancho no se desborde. */
    :host ::ng-deep .cg-jornada-dlg .p-dialog-content { padding-top:var(--sp-2); }

    /* [CG.115] Lo suelto de otras jornadas. Va en caja propia y en tono de aviso porque no es
       parte del cuadre: es trabajo pendiente que el cuadre decidio NO tragarse. */
    .cg-fuera { margin-top:var(--sp-3); padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color);
                border-left:3px solid var(--warn-fg); border-radius:var(--r-sm,8px);
                background:var(--overlay-hover); }
    .cg-fuera-h { display:flex; align-items:center; gap:var(--sp-2); font-size:var(--fs-sm); }
    .cg-fuera-h > i { color:var(--warn-fg); }

    /* [CG.51] La cabecera del historial plegado. Es un <button> y no un <h2> con (click): lo que
       hace es abrir y cerrar, asi que el teclado lo alcanza solo y anuncia su aria-expanded. */
    .cg-historial { margin-top:var(--sp-5); }
    .cg-historial-h { display:flex; align-items:baseline; gap:var(--sp-2); width:100%;
                      background:none; border:0; padding:var(--sp-2) 0; cursor:pointer;
                      font-family:inherit; color:var(--fg-1); text-align:left; }
    .cg-historial-h > i { font-size:var(--fs-xs); color:var(--text-muted); align-self:center; }
    .cg-historial-t { font-size:var(--fs-h3); font-weight:700; letter-spacing:-.01em; }
    .cg-historial-h:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px;
                                    border-radius:var(--r-sm); }
    /* ⛔ ACA VIVIA ".cg-check", un <input type="checkbox"> nativo con alto y accent-color a mano.
       El control principal de la bandeja es marcar fila por fila, asi que era el objetivo mas
       chico de la pantalla Y el mas usado. Hoy es p-checkbox: el alto, el anillo de foco y el
       par de colores los pone el tema, y en oscuro deja de pintarlo el sistema operativo. */
    /* CG.21 - el signo se lee de un vistazo. La flecha va ADEMAS del color, no en su lugar:
       el color solo deja fuera a quien no lo distingue.
       ⚠️ Decia var(--p-green-600) / var(--p-orange-600): son tokens de paleta de @primeuix que
       este preset NO emite, asi que siempre ganaba el hex y no flipeaba en oscuro. */
    .cg-in  { color:var(--ok-fg); }
    .cg-out { color:var(--warn-fg); }

    /* Chips de lo que mas se repite. El numero es el soporte: sin el, un chip es una opinion
       -- y ahora ese numero es el [badge] del propio p-button, no un <span> aparte.
       ⛔ Aca vivian ".cg-chip", ".cg-chip-n", ".cg-chip-x" y ".cg-link": cuatro controles
       dibujados a mano (borde, radio, hover, anillo de foco y alto de toque, todo repetido).
       Los cubren p-button y p-chip. Queda SOLO el contenedor, que es reparto, no control. */
    .cg-chips { display:flex; flex-wrap:wrap; gap:var(--sp-2); }
    .cg-caos-list { display:flex; flex-direction:column; gap:var(--sp-1); }
    /* El renglon del cajero: el borde, el hover, el foco y el alto los da el p-button que lo
       envuelve. Esta regla ya solo REPARTE el contenido proyectado -- que es nuestro, asi que
       la agarra el CSS encapsulado sin ::ng-deep. */
    .cg-caos-row { display:flex; align-items:center; gap:var(--sp-3); width:100%; text-align:left; }
    .cg-caos-tag { font-size:var(--fs-micro); font-weight:600; padding:.1rem .45rem; border-radius:999px;
      border:1px solid var(--border-color); color:var(--text-muted); white-space:nowrap; }
    /* Sobre el p-chip del cajero: el color CASCADEA hasta su rotulo. El borde lo pinta el
       componente, asi que un border-color aca seria una declaracion muerta. */
    .cg-caos-in { color:var(--action); }
    .cg-caos-monto { font-variant-numeric:tabular-nums; }
    .cg-caos-ref { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cg-caos-go { color:var(--action); font-size:var(--fs-micro); white-space:nowrap; }
    .cg-caos-attach { color:var(--text-muted); font-size:var(--fs-micro); }
    .cg-caos-attach.cg-caos-alta { color:var(--action); }
    /* ⛔ [CG.70] Aca vivian ".cg-cajero" (recuadro punteado) y ".cg-cajero-head": el SEGUNDO panel
       del cajero, el que repetia el rotulo. Se fueron con el; el que queda es el neutro de abajo.
       Se borran y no se dejan huerfanas a proposito: una regla sin dueño es la que despues alguien
       reusa por el nombre -- y eso fue exactamente [CG.69], que dejo dos apartados en 1x1 pixel. */
    /* CS.3.7 — La mención APARTE del efectivo del cajero (CAOS): ya contado por la máquina, no en la reja.
       ⛔ [CG.37] El borde y el icono iban en --action. DESIGN.md reserva el color de marca para
       CTA, chip activo, badge, "en vivo" y anillo de foco -- este panel no es ninguno de los
       cinco: es informativo. Y el costo era concreto: el recuadro naranja es la superficie de
       color MAS GRANDE del dialogo, asi que competia con "Guardar", que es el unico control que
       escribe en la base. Cuando el naranja significa cuatro cosas deja de significar "apreta
       aca". Panel en neutro; el acento queda para el boton. */
    .cg-caja-aparte { border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:var(--sp-3);
      display:flex; flex-direction:column; gap:var(--sp-1); }
    .cg-caja-aparte-top { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); }
    .cg-caja-ico { color:var(--text-muted); font-weight:700; }
    .cg-caja-denoms { display:flex; flex-wrap:wrap; gap:var(--sp-1) var(--sp-2); font-size:var(--fs-micro); }
    /* CS.3.8 — botón de imprimir comprobante en la lista de movimientos. */
    .ta-c { text-align:center; }
    /* [CG.26] Aca vivia .ta-r, que no estaba definida en ningun lado alcanzable: los importes nunca
       se alinearon a la derecha. [CGP-V.11] Las celdas numericas pasan a comm-num (global, DESIGN):
       derecha + mono + cifras tabulares, y la regla local se retira. */
    /* ⛔ ".cg-print" retirada: era un <button> con la impresora adentro, con su borde, su hover
       y su anillo a mano. Hoy es un p-button redondo de icono. */
    /* CS.3.11 — panel de conciliación caja chica vs cajero (CAOS). */
    .cg-conc { border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:var(--sp-3);
      display:flex; flex-direction:column; gap:var(--sp-1); max-width:34rem; }
    .cg-conc-h { font-size:var(--fs-sm); }
    .cg-conc-row { display:flex; justify-content:space-between; gap:var(--sp-4); font-size:var(--fs-sm); }
    .cg-conc-row .mono { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cg-conc-tot { border-top:1px solid var(--border-color); padding-top:var(--sp-1); font-weight:600; }
    /* [CG.137] La cuenta T. La base (ancho, interlineado, encabezado, divisores) la pone
       surf-table--plain; aca va SOLO lo que hace que se lea como una T y no como una tabla de
       tres columnas:
         1. la barra vertical que separa cargo de abono -- es la pata de la T, y sin ella las dos
            columnas de numeros se leen como una sola lista a la derecha;
         2. la celda vacia del lado contrario, que NO se deja en blanco a secas: un blanco se lee
            como "no se midio". Lleva un guion tenue, que se lee como "de este lado no va";
         3. el pie, que es el saldo y por eso pesa.
       Sin fondo ni caja propia: la profundidad de este sistema la lleva el hairline (12b). */
    .cg-t { margin:var(--sp-2) 0 var(--sp-1); }
    .cg-t thead th:last-child,
    .cg-t tbody td:last-child,
    .cg-t tfoot td:last-child { border-left:1px solid var(--border-color); }
    .cg-t tbody th { font-weight:400; text-align:left; }
    /* ⛔ El pie es UNA fila y hay que tratarlo como tal. La base pinta fondo, borde y peso en
       .surf-table--plain > tfoot > tr > td -- o sea SOLO en la celda de la cifra. Como el rotulo
       del saldo es un th (lo correcto: es el encabezado de su fila), quedaba fuera de esa regla:
       la etiqueta sobre el fondo normal y el numero sobre un bloque oscuro al lado. Edgar lo vio
       en pantalla antes que yo. El th repite el mismo trato para que el total se lea como un
       total y no como una barra pegada a un texto suelto. */
    .cg-t > tfoot > tr > th { padding:var(--sp-2) var(--sp-3); border-top:1px solid var(--border-color);
                              background:var(--surface-2); font-weight:600; text-align:left; }
    /* ⛔ El guion va como CARACTER, no como codigo CSS. Intentarlo con el codigo falla DOS veces
       y por dos motores distintos: primero JS lo lee como secuencia octal dentro del template
       literal (lo atrapo check:templates); y al escapar la barra para sortear eso, Angular
       vuelve a inlinear este mismo CSS dentro de un string de JS -- virtual:angular:jit:style --
       donde la secuencia es octal OTRA VEZ y Rollup la rechaza en modo estricto.
       ⚠️ Ese segundo viaje NO lo ve check:templates, que parsea el .ts y ahi la version escapada
       es legal: lo encontro la corrida de pruebas. Una compuerta verde no es un build verde. */
    .cg-t-vacia::before { content:"–"; color:var(--text-faint); }
    /* ⭐ [CG.140] Verde lo que entra, rojo lo que sale. Pedido de Edgar con la pantalla a la
       vista, y va con los tokens semanticos -- NO con un rojo y un verde crudos: estos se
       desaturan y se voltean solos en oscuro, que es donde esta pantalla se usa.
       ⚠️ Y va ENCIMA de una marca que no es color, no en su lugar. Dos motivos medidos:
         · la flota es Windows y en Alto Contraste del SO el navegador FUERZA todos los colores:
           el verde y el rojo colapsan en el mismo. La regla #5 del pre-vuelo pide exactamente
           esto -- que ningun estado dependa solo del color;
         · rojo contra verde es el peor par posible para daltonismo (~8% de los hombres).
       La marca que sobrevive las dos cosas ya estaba: la COLUMNA en la que cae el numero, y el
       guion tenue del lado contrario. El color se suma a eso; si se apaga, la tabla se sigue
       leyendo. */
    .cg-cargo { color:var(--ok-fg); }
    .cg-abono { color:var(--bad-fg); }
    /* [CG.194] El renglon que dice que le descontaron al de arriba. Es una ACLARACION de su
       fila, no una fila mas de la cuenta: por eso no lleva el color de cargo/abono -- pintarlo
       de verde o rojo lo haria leer como un movimiento que suma, y no suma: ya esta restado.
       Se apoya en .fin-dim, que es el tono tenue que esta pantalla ya usa para lo derivado.
       El sangrado lo da el texto (dos espacios duros), igual que los renglones "de eso, ..." de
       abajo, para no inventar una segunda convencion de jerarquia en la misma columna. */
    .cg-t-sub > th, .cg-t-sub > td { padding-top:0; border-top:0; }

    /* [CG.26] El cierre de la jornada reusa el mismo panel, en dos columnas: nuestro libro y el
       cajero. Se ensancha porque ahora lleva la tabla de tipos del cajero, que antes no existia. */
    /* [CG.27] La lista de recurrentes sin regla. */
    .cg-rec td { vertical-align:top; }
    .cg-cv { font-size:var(--fs-xs); color:var(--text-soft); }
    .cg-cv-fijo { color:var(--ok-fg, var(--action)); font-weight:600; }
    /* ⛔ [CG.34] LOS DOS SUBTITULOS SALIAN PEGADOS: "...de esta jornada2,777 conceptos de 2,954".
       La causa NO estaba en el HTML -- son dos <p> hermanos, correctos-- ni en esta clase:
       .surf-page-sub (styles.css) declara display:inline-flex, pensada para UN subtitulo que
       lleva chips en linea (de ahi su gap y su flex-wrap). Apilar DOS cae en el mismo renglon.
       Medido: de todo apps/view, esta es la UNICA pantalla que apila dos. No es un bug del
       sistema, es un mal uso local -- asi que se corrige aca y NO se toca la clase compartida.
       ⚠️ La primera busqueda concluyo "no tiene display" habiendo leido 5 lineas de una regla
       de 9. Leer media regla y concluir sobre el todo. */
    .cg-sub-dim { display:block; opacity:.62; font-size:var(--fs-xs); margin-top:var(--sp-1); }
    /* [CG.33] EL RESUMEN agrupado + la marca del motivo. MEDIDO EN EL DOM VIVO de prod, no
       razonado: el contraste de cada candidato sobre el fondo real (rgb 244,244,245), a 12px,
       contra el piso AA de 4.5 --
         --warn-fg    1.95  FALLA   (y al 78% de cg-trabada: 1.70)
         --text-muted 7.03  pasa    (al 78%: 4.10, FALLA)
         --text-main 18.10  pasa    (al 78%: 9.87, pasa)
       ⛔ O sea que el naranja que la fila usaba NUNCA paso AA: el comentario de abajo ataco la
       OPACIDAD (sintoma) y no el COLOR (causa), y yo lo di por bueno sin medirlo. Por eso el
       motivo va en --text-muted Y excluido de la atenuacion: 7.03, legible, sin muro naranja.
       La cifra del resumen va en --text-main (18.10) porque es el dato que hay que leer.
       Lo que hacia el muro tampoco era el color: era repetir 85 veces una frase de 80
       caracteres. El texto largo NO vive en un title -- no se alcanza por teclado (checklist 11)
       y DESIGN.md lo lista como antipatron explicito de Operations. */
    /* El p-tag del motivo: su color y su forma son del tema. Lo unico propio es que ocupe su
       renglon y no compita de tamano con el beneficiario, que es el dato de la celda. */
    .cg-motivo-tag { display:inline-flex; margin-top:var(--sp-1); font-size:var(--fs-xs); }
    /* [CG.37] Era una columna: un renglon por motivo, porque cada uno llevaba su frase al lado.
       Ahora es UNA fila que envuelve -- los motivos son tres etiquetas cortas y entran juntas. */
    .cg-motivos-res { margin:var(--sp-1) 0 var(--sp-2); display:flex; align-items:center;
      flex-wrap:wrap; gap:var(--sp-2); font-size:var(--fs-xs); }
    /* El p-tag trae su color y su forma del tema; lo unico propio es la CIFRA en mono tabular
       (checklist 4: toda cifra, sin excepcion). Sin ::ng-deep: va proyectada adentro. */
    .cg-motivos-n { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:600; }
    /* El porque, desplegado. Neutro a proposito: el aviso ya lo dio la etiqueta de arriba, y
       repetirlo en naranja convertia el bloque en un muro de color. */
    .cg-motivos-por { list-style:none; margin:calc(-1 * var(--sp-1)) 0 var(--sp-2); padding:0; display:flex;
      flex-direction:column; gap:var(--sp-1); font-size:var(--fs-xs); color:var(--text-muted); }
    /* [CG.32] El renglon que queda cuando el cuadre esta plegado. */
    .cg-conc-plegado { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap;
      font-size:var(--fs-sm); color:var(--text-muted); padding:var(--sp-1) 0; }
    /* ⛔ ACA VIVIA ".cg-lim-tog" MAS un @media (pointer: coarse) que le subia el alto a 44px,
       porque la clase medía ~20px (padding .25rem) y era la UNICA forma de abrir el cuadre en
       el telefono. Las dos se retiran juntas: el p-button que la reemplaza ya nace con su alto
       de toque, su anillo de foco y su hover. Es exactamente el tipo de regla que PrimeNG-first
       evita tener que acordarse de escribir. */
    .cg-kpi-h { margin-top:var(--sp-5); }
    .cg-conc-lim-h { margin:var(--sp-3) 0 0; font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); }
    .cg-conc-lim { margin:var(--sp-1) 0 0; padding-left:var(--sp-4); font-size:var(--fs-xs);
      color:var(--text-soft); display:flex; flex-direction:column; gap:var(--sp-1); }
    .cg-conc-wide { max-width:none; }
    .cg-conc-head { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap; }
    .cg-conc-fecha { max-width:11rem; }
    .cg-conc-cols { display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-4) var(--sp-6); margin-top:var(--sp-1); }
    /* [CG.32] SIN esta linea el [hidden] no oculta NADA: el display:grid de arriba le gana al
       display:none que el navegador le da a [hidden], y el bloque se seguiria viendo plegado.
       Es el mismo descuido que hace creer que un toggle no funciona. */
    .cg-conc-cols[hidden] { display:none; }
    /* [CG.91] El historial del dia: ancho completo, debajo del resumen. */
    .cg-hist { margin-top:var(--sp-4); }
    /* [CG.139] El selector va sobre la lista y alineado a la derecha, donde ya viven los otros
       controles de esta pantalla. El p de adentro es el caption, que sigue siendo invisible. */
    .cg-hist-cap { display:flex; justify-content:flex-end; margin-bottom:var(--sp-2); }
    .cg-hist-canc > td { opacity:.55; text-decoration:line-through; }
    .cg-hist-tag { margin-left:var(--sp-2); font-size:var(--fs-xs); color:var(--text-muted);
                   border:1px solid var(--border); border-radius:var(--radius-sm); padding:0 var(--sp-1); }
    /* [CG.140] Aca vivia .cg-hist-in, el verde que pintaba el signo del ingreso cuando el
       historial tenia UNA columna de importe. Al partirlo en Cargo/Abono ([CG.139]) se quedo sin
       un solo usuario, y el color ahora lo ponen .cg-cargo/.cg-abono, que sirven a las tres
       tablas. Una clase que ya no usa nadie no es inofensiva: la proxima sesion la mantiene. */
    .cg-hist-benef { font-weight:600; }
    /* ⛔ [CG.97.1] El color sigue al SIGNO. Antes era verde fijo, y un negativo en verde es la
       clase de cosa por la que se deja de confiar en un tablero entero. */
    .cg-cajon-pos .mono { color:var(--ok-fg); }
    .cg-cajon-neg .mono { color:var(--warn-fg); }
    /* [CG.91.2] El pie: separado por una linea, no por color -- es un total, no una alerta. */
    .cg-hist-pie > td { border-top:2px solid var(--border); padding-top:var(--sp-2);
                        color:var(--text-muted); font-size:var(--fs-sm); }
    .cg-hist-pie .cg-hist-neto { color:var(--text); font-weight:700; font-size:var(--fs-body); }
    @container (max-width:47.5rem) { .cg-conc-cols { grid-template-columns:1fr; } }
    .cg-conc-col { display:flex; flex-direction:column; gap:var(--sp-1); min-width:0; }
    .cg-conc-sub { font-size:var(--fs-sm); }
    .cg-conc-tbl { margin-bottom:var(--sp-1); }
    /* Lo no medido se ve COMO aviso, no como letra chica decorativa: es la diferencia entre
       "movimiento del dia" y "cuanto hay en el cajero". */
    .cg-conc-nm { margin:var(--sp-2) 0 0; padding-left:var(--sp-4); font-size:var(--fs-xs);
      color:var(--warn-fg, var(--text-soft)); display:flex; flex-direction:column; gap:var(--sp-1); }
    /* CS.3.13 — campo «venta a crédito» (se descuenta del efectivo esperado). */
    .cg-credito { display:flex; flex-direction:column; gap:var(--sp-1); border:1px solid var(--border-color);
      border-radius:var(--r-md,8px); padding:var(--sp-3); }
    .cg-credito-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; }
    .cg-credito-head label { margin:0; font-size:var(--fs-sm); color:var(--text-muted); }
    input.cg-vcredito { width:9rem; text-align:right; font-variant-numeric:tabular-nums; padding:var(--sp-1) var(--sp-2); }
    .cg-caos-alta { color:var(--action); border-color:var(--action); font-weight:700; }
    /* CS.3.1c — El billete que la máquina ya contó se ve BLOQUEADO (readonly), no editable. */
    .cg-arqueo-tbl input.cg-pieza:read-only { color:var(--text-muted); cursor:not-allowed;
      background:color-mix(in srgb, var(--border-color) 22%, transparent); }

    /* ⛔ Tercer bloque de alto-de-toque retirado. Decia: "Fitts en tactil: el dedo no acierta un
       chip de 24px ni un checkbox de 16" -- cierto, y por eso la pantalla lo venia parchando en
       TRES lugares distintos (.cg-chip, .cg-check y .cg-lim-tog). p-button, p-chip y p-checkbox
       lo traen de serie, y ahi no hay que acordarse. */

    /* ⛔ ACA VIVIA UN BUG MUDO. Estos anchos se pedian con styleClass="w-full" / "cg-sel", y
       PrimeNG 22 RETIRO el input styleClass de p-select, p-message, p-table, p-autocomplete y
       p-inputnumber (verificado en node_modules/primeng/types: solo p-dialog lo conserva). Como
       es un atributo estatico, Angular no se queja y la clase nunca llega al elemento: los tres
       selectores de la bandeja salian truncados y los dos buscadores del dialogo, angostos.
       Se reemplaza por regla propia. El ::ng-deep es para entrar al DOM de PrimeNG y es el
       patron que ya usan las pantallas hermanas (comercial-inventory-aisles). */
    /* ⛔ SEGUNDO ERROR MIO, EN EL MISMO LUGAR. El primer intento fue
         .cg-sel  { display:inline-block; min-width:9rem }
         .cg-full { display:block; width:100% }
       y eso ROMPIO los controles en vivo: en PrimeNG 22 la clase del componente va en el HOST
       (host: { '[class]': "cx('root')" }), o sea que .cg-sel Y .p-select son EL MISMO elemento.
       Dos consecuencias, las dos medidas en node_modules:
         1. ".cg-sel .p-select" (descendiente) no matchea NADA: no hay tal hijo.
         2. mi "display" le gana al del componente por especificidad (la encapsulacion le suma
            un atributo) y le tira el layout interno: .p-select y .p-autocomplete son
            "inline-flex" y .p-message es "display: grid". Con display:inline-block/block el
            selector quedaba con la etiqueta cortada a UNA LETRA y el chevron abajo.
       La regla que queda: sobre un componente de PrimeNG se toca el ANCHO, nunca el "display".
       Un inline-flex con width:100% ya ocupa todo; un grid tambien. */
    .cg-declara { align-items:flex-start; gap:var(--sp-2); border:1px solid var(--border-color);
                  border-radius:var(--r-sm,6px); padding:var(--sp-3); cursor:pointer; }
    .cg-declara span { font-size:var(--fs-sm); }
    .cg-full { width:100%; }
    .cg-sel { min-width:9rem; }
    /* [CGP-V.3b] La jornada del corte, en PRIMARIO: escala + peso + contraste, nunca color (Q.5).
       Era un .fin-dim terciario y es el dato que decide a que dia se pega el conteo. */
    .cg-jornada { margin:0; font-size:var(--fs-lg); font-weight:600; color:var(--text-main);
                  font-variant-numeric:tabular-nums; }
    /* El borde marca la jornada atrasada. El color NO es el unico portador: el texto lo dice,
       el aviso lo repite y la confirmacion lo exige (forced-colors lo respeta). */
    .cg-jornada-atrasada { border-left:3px solid var(--warn-fg); padding-left:var(--sp-2); }
    .fin-check { display:flex; align-items:flex-start; gap:var(--sp-2); }
    .fin-check label { font-size:var(--fs-sm); color:var(--text-main); cursor:pointer; }
    /* El input interno del autocomplete SI es un descendiente real, y no estira solo. */
    :host ::ng-deep .cg-full .p-autocomplete-input { width:100%; }
  `],
  template: `
    <div class="surf-page in cg-app">
      <!-- El shell de página es el GLOBAL (surf-*, styles.css), el mismo que usa /finanzas/caja.
           Antes eran clases fin-* que NO EXISTEN en el repo: la página se pintaba sin un solo
           estilo. Inventar un segundo shell de página es exactamente lo que ADR-056 prohíbe. -->
      <!-- ⭐ [CG.59] LA BARRA. El encabezado de pagina mas el bloque "Cierre de la jornada"
           se comian ~360px antes de que empezara el trabajo. Edgar: "el 90% de la pantalla
           debe ser ESTOS DOS APARTADOS... en ese 10% mostrarle un desplegable de como va su
           jornada".

           ⚠️ Plegar NO es esconder: cerrada, la barra YA dice como va -- cuanto falta
           confirmar y si se rindio cuentas. Abierta da los numeros, el cuadre del dia, lo que
           repite sin cuenta declarada y el libro. Nada se borro: todo se MUDO aca adentro. -->
      <!-- [CG.121] EL SELECTOR DEL AREA: Captura / Expediente / Caja Fuerte.
           Entra COMO HIJA de .cg-app -- que ya es la columna flex que reparte el alto -- y no
           como hermana de afuera: el host de esta pantalla es position:absolute + inset:0
           ([CG.113b]) y colgarle un hermano arriba vuelve a romper la cadena de altura que ese
           arreglo acaba de enderezar. Toma su alto natural, igual que la barra de abajo; el
           unico hijo que recibe el alto restante sigue siendo .cg-split. -->
      <app-caja-tabs class="cj-sin-margen" />

      <header class="cg-bar">
        <div class="cg-bar-id">
          <h1>Caja General</h1>
        </div>

        <span class="cg-bandeja-sp"></span>

        <!-- ⭐ [CG.71] EL SALDO DE LA CAJA, QUE SE PEDIA Y NO SE PINTABA.
             Pedido de Edgar: "hay que agregar un apartado para ver el saldo actual de la caja
             chica". Medido antes de construir: NO faltaba el dato ni el calculo. cargarSaldo()
             le pregunta al servidor en SIETE momentos distintos (al entrar, al guardar, al abrir
             corte, al cerrarlo, al confirmar un lote, al llegar un aviso...), y textoSaldoUI
             lo traducia a texto desde la linea 3241 -- y la plantilla no lo usaba NI UNA VEZ.
             La clase ".fin-saldo" tampoco: estaba definida con el comentario "la barra del corte:
             saldo + estado + accion, en una linea", o sea que la barra se diseño con el saldo
             adentro y el saldo se cayo en el camino.
             Va aca y no en un apartado nuevo: los apartados son DOS por decision de [CG.59]/[CG.60]
             (90% la tarea), y un tercero rompe el tablero aprobado. Aca se ve sin un clic, que es
             lo que "saldo actual" pide.
             ⚠️ Lo que se pinta respeta el arqueo CIEGO: a quien captura el servidor le oculta el
             esperado y el texto lo DECLARA ("oculto hasta sellar"), nunca lo dibuja en 0. -->
        <span class="fin-saldo cg-saldo" [title]="textoSaldoUI()">{{ textoSaldoUI() }}</span>

        <!-- ⛔⛔ [CG.116] ESTO ERA UN DESPLEGABLE Y EDGAR LO PIDIO TRES VECES: "al hacer que el
             usuario despliegue y deslice hacia abajo pierde el enfoque... que esto viva en un
             selector para no tener esa perdida de la pantalla principal, o se abre una pestaña
             nueva o se despliega una ventana".
             El defecto no era el alto del panel -- [CG.113] ya lo habia topado al 40% -- es que
             un desplegable EMPUJA: abrirlo mueve el arqueo y los movimientos de lugar, y el que
             estaba contando pierde el renglon donde iba. Una ventana no mueve nada: se abre
             encima, se cierra con Esc y la pantalla de atras queda intacta.
             Por eso ahora es "aria-haspopup=dialog" y no "aria-expanded": lo que anuncia el
             lector de pantalla tiene que ser lo que de verdad pasa. -->
        <button type="button" class="cg-jornada-btn" (click)="jornadaAbierta.set(true)"
                aria-haspopup="dialog">
          <i class="pi pi-window-maximize" aria-hidden="true"></i>
          <strong>Tu jornada</strong>
          <span class="cg-jornada-sep" aria-hidden="true"></span>
          <span class="cg-jornada-res">{{ subtituloJornada() }}</span>
        </button>

        <!-- [CGP-V.6] Sin el permiso de captura el boton no se ofrece: se dice, una vez, aca arriba. -->
        @if (puedeGestionar()) {
          <!-- ⛔⛔ [CG.120] LA CAPTURA A MANO SE RETIRA (Edgar, 2026-10-19). Un movimiento
               tecleado nace SIN origen_ref, o sea sin nada contra que cuadrarlo: no lo alcanza el
               candado de duplicados del servidor (que es por origen_tipo + origen_ref), no entra
               en el descuento de la cola, y en la conciliacion aparece como una fila que no
               corresponde a ningun documento. Era la unica puerta de esta pantalla por la que
               entraba dinero sin procedencia.

               ⭐ Se RETIRA, no se pinta en gris. Esta misma pantalla ya tiene escrita la regla,
               400 lineas mas abajo: "un boton que se apaga sin decir por que se lee igual que un
               boton roto, y el gesto siguiente es volver a tocarlo". Un gris permanente invita a
               reportar una falla que no existe. Y no se deja un aviso fijo en su lugar porque el
               encabezado ya dice que hacer -- "elige uno de la cola y el arqueo se abre al lado".

               ⛔ Apaga EL BOTON, no abrirCaptura(): esa funcion la comparten la cola del ERP, la
               boveda y los recurrentes sin regla. Guardarla por dentro apagaria el arqueo entero.
               El interruptor, con su porque, vive en CAPTURA_MANUAL_HABILITADA. -->
          @if (capturaManualHabilitada) {
            <p-button label="Registrar movimiento" icon="pi pi-plus" size="small"
                      (onClick)="abrirCaptura()" [disabled]="!hayConceptos() && !coberturaSinMedir()"></p-button>
          }
        } @else {
          <small class="fin-hint-warn">Sólo lectura: capturar, confirmar y rendir cuentas necesitan el
            permiso «Capturar en Caja General».</small>
        }
      </header>

      <!-- [CGS.14] EL CANDADO, antes que todo: si la caja no puede capturar, lo primero que se lee
           es por que y que lo destraba. Avisar DESPUES de teclear un movimiento entero seria
           cobrarle a la persona el trabajo de descubrir la regla. -->
      @if (candadoCaja(); as k) {
        @if (k.bloqueado) {
          <div class="cg-candado" role="alert">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <div class="cg-candado-txt">
              <b>La caja está bloqueada.</b> {{ k.texto }}
              <div class="cg-candado-acc">
                <p-button label="Rendir cuentas de esa jornada" icon="pi pi-calendar" size="small"
                          (onClick)="cerrarJornada()"></p-button>
              </div>
            </div>
          </div>
        } @else if (k.con_llave) {
          <div class="cg-candado cg-candado--llave" role="status">
            <i class="pi pi-key" aria-hidden="true"></i>
            <div class="cg-candado-txt">
              Capturas con <b>llave de emergencia</b> de {{ k.con_llave.otorgada_por_username || 'la supervisión' }}
              hasta que termine el día: «{{ k.con_llave.motivo }}».
              @if (k.jornada) { La jornada del {{ dmy(k.jornada) }} sigue sin corte cerrado. }
            </div>
          </div>
        } @else if (!k.activo) {
          <small class="fin-hint-warn">El candado de la caja está apagado por configuración: se puede capturar aunque falte un corte.</small>
        }
      }

      <!-- [CGS.18] Lo que la supervisora DEVOLVIO: la caja lo ve al entrar, no escondido en el
           historial plegado de Tu jornada. -->
      @if (observados().length) {
        <div class="cg-candado" role="status">
          <i class="pi pi-replay" aria-hidden="true"></i>
          <div class="cg-candado-txt">
            <b>{{ observados().length === 1 ? 'La supervisora observó un corte.' : 'La supervisora observó ' + observados().length + ' cortes.' }}</b>
            @for (c of observados(); track c.id) {
              <div class="cg-candado-acc">
                <span>{{ c.folio }} ({{ dmy(c.fecha) }}) · {{ c.observed_by_username || 'supervisión' }}: «{{ c.observacion }}»</span>
                @if (puedeGestionar()) {
                  <p-button label="Responder" icon="pi pi-reply" size="small" severity="secondary" [outlined]="true"
                            (onClick)="abrirRespuesta(c)"></p-button>
                }
              </div>
            }
          </div>
        </div>
      }

      <!-- El 10%: lo que NO es la tarea. Vive en una VENTANA, no en un desplegable ([CG.116]):
           abrirla no mueve ni un pixel del arqueo que hay detras. -->
      <p-dialog [visible]="jornadaAbierta()" (visibleChange)="jornadaAbierta.set($event)"
                [modal]="true" [dismissableMask]="true" [draggable]="false" [maximizable]="true"
                [style]="{ width: 'min(1180px, 96vw)' }" [contentStyle]="{ 'max-height': '78vh' }"
                styleClass="cg-jornada-dlg" header="Tu jornada">
        <div class="cg-jornada">
          <!-- ⭐⭐ [CG.123] EL SELECTOR, Y POR QUE ESTE DIALOGO LO NECESITABA.
               Medido lo VISIBLE al abrir (no la plantilla, que incluye lo plegado): 3 rejillas,
               39 cifras, 7 botones, 41 textos atenuados contra 5 enfatizados. Un solo
               desplazamiento con todo eso no se lee: se recorre hasta encontrar.

               DESIGN.md §10, las tres leyes que esto cumple:
                 Miller  -> 39 cifras seguidas sin separador declarado es justo lo que prohibe.
                 Hick    -> se elige QUE mirar en vez de recorrerlo todo.
                 Tesler  -> y por eso NO es un acordeon "por limpieza": nada se esconde. Las tres
                            partes van nombradas, a un clic, y con su cifra DENTRO del boton, asi
                            que se ve que existen y cuanto hay sin entrar a cada una.

               ⛔ Y el nombre mentia sobre dos tercios: las bandejas son trabajo pendiente y el
               Historial es OTRO rango de fechas (trae sus propios calendarios). Separarlos es
               dejar de llamar "tu jornada" a cosas que no lo son. -->
          <app-segmented [options]="seccionesJornada()" [value]="seccionJornada()"
                         (valueChange)="seccionJornada.set($any($event))"
                         ariaLabel="Qué parte de la jornada querés ver"></app-segmented>

          <!-- ⛔⛔ [CG.123] LO QUE DECLARA UN HUECO NO ENTRA AL SELECTOR, Y ESTO LO CAZARON LAS
               PRUEBAS, NO YO.
               Primer intento: las tres regiones detras del selector y listo. Nueve pruebas se
               pusieron rojas y tenian razon -- con los cortes caidos, el aviso "no se pudieron
               leer" vivia DENTRO de la seccion Historial, asi que en la vista por default una
               lectura FALLIDA quedaba invisible. Publicar nada es peor que publicar un cero
               (ADR-056), y es exactamente el defecto que [CG.181] vino a arreglar: un cero que
               afirmaba algo que nadie midio.
               ⭐ Por eso los conteos van DENTRO de los botones del selector (se ve cuanto hay sin
               entrar) y lo que no se pudo medir sube ACA, donde se lee se mire la seccion que se
               mire. Eso es Tesler: se ordena, no se esconde. -->
          @if (errLibro() || errCortes() || !recurrentes()) {
            <p class="cg-jornada-dec">
              @if (!recurrentes()) {
                <span class="fin-hint-warn">Repiten y nadie declaro su cuenta &mdash; Sin medir: no se pudo leer la lista.</span>
              }
              @if (errLibro()) { <span class="fin-hint-warn">el libro no se pudo leer</span> }
              @if (errCortes()) { <span class="fin-hint-warn">los cortes no se pudieron leer</span> }
            </p>
          }

          <!-- [CG.128] Las DOS secciones cuelgan de aca porque las dos necesitan el mismo
               bloque de arqueo de mas abajo: el cuadre y el diario salen de la misma lectura.
               Adentro, cada bloque va a la suya. La cabecera (Cierre de la jornada, los pasos,
               las jornadas atrasadas) se ve en las dos a proposito: son ~150px y son el contexto
               del dia, no contenido de una seccion. -->
          @if (seccionJornada() === 'hoy' || seccionJornada() === 'movimientos') {
          <p class="fin-dim cg-sub-dim">{{ coberturaTexto() }}</p>

          <!-- ⭐⭐ [CG.180] DE DONDE SALE EL AUTOLLENADO, Y SI SU FUENTE ESTA VIVA.
               Lo midio la sesion de backend: la copia del historial llego a produccion POBLADA Y
               CON CERO FILAS -la migracion lee una vista filtrada por current_tenant_id() y nunca
               fijo el tenant; misma sesion y mismo instante, sin tenant 0 filas, con tenant
               13,302-. Con la copia vacia el motor contesta "sin historia" para TODA entidad, asi
               que esta pantalla le afirmaba al capturista que Kepler no tenia historia de ese
               beneficiario. La frase ya se arreglo donde se dice (etiquetaProcedencia); esto es el
               otro lado: que la cobertura DECLARE el estado de la fuente en vez de que haya que
               deducirlo de una propuesta que no llega.
               ⚠️ TRES casos y no dos: "esta version del servidor no lo informa" (deploy parcial)
               no es "la copia esta vacia". Solo la segunda es un problema del dato. -->
          @if (autofill(); as af) {
            <p class="fin-dim cg-sub-dim">
              Autollenado: {{ af.declarada.toLocaleString('es-MX') }} cuenta(s) declarada(s) ·
              {{ af.derivada.toLocaleString('es-MX') }} derivada(s) del historial
              @if (af.latido) {
                <app-freshness-pill measures="data" [freshness]="af.latido" label="Autollenado" />
              } @else {
                <!-- "Nunca corrio" es su propio estado: no es un refresco viejo ni un cero. -->
                <span class="fin-hint-warn">el carril nunca corrió</span>
              }
            </p>
            @if (autofillFuenteVacia()) {
              <p-message severity="warn" class="cg-full">La copia del historial está vacía: el
                autollenado no tiene con qué proponer, y va a decir «sin propuesta» en cada
                captura. No es que los beneficiarios no tengan historia — lo revisa Sistemas.</p-message>
            }
          } @else {
            <p class="fin-dim cg-sub-dim">Autollenado: sin medir — esta versión del servidor no
              informa el estado de su fuente.</p>
          }

      <!-- ⚠️ Antes esto decía "No hay conceptos" también cuando la medición había FALLADO, y el
           subtítulo de arriba decía "sin medir" al mismo tiempo. Dos frases contradictorias sobre
           el mismo hecho. Ahora cada ausencia dice la suya. -->
      @if (coberturaSinMedir()) {
        <p-message severity="warn" class="cg-full">No se pudo medir la cobertura del catálogo de conceptos. No es "no hay conceptos": es que no sabemos. Se puede capturar, pero si la cuenta no existe el servidor la va a rechazar.</p-message>
      } @else if (!hayConceptos()) {
        <p-message severity="warn" class="cg-full">No hay conceptos de Kepler disponibles. No se puede capturar sin cuenta contable — revisa el carril del ODS antes de seguir.</p-message>
      }

      <!-- ⭐ [CG.26] EL CIERRE DE LA JORNADA: como quedo el dia en caja general y en el cajero.

           Este bloque YA EXISTIA y NUNCA lo vio nadie: colgaba de "@if (corteAbierto())" y en prod
           hay CERO cortes. Se le cambio la fuente, no la forma -- reestructurar es renombrar y
           reordenar, no rediseniar. Ahora sale de "arqueo-dia", que no depende de que alguien se
           haya acordado de abrir un corte.

           (Sin acentos graves aca adentro: esto vive en un template literal y un backtick lo
            CIERRA. Es la quinta vez que pasa en el repo.) -->
      <div class="cg-conc cg-conc-wide">
        <div class="cg-conc-head">
          <strong class="cg-conc-h">Cierre de la jornada</strong>
          <span class="cg-bandeja-sp"></span>

          <!-- ⚠️ Tres estados, no dos. Cuando el saldo NO se pudo medir no sabemos si hay corte
               abierto, y ofrecer abrirlo sobre uno vivo es el peor final. -->
          <!-- [CGP-V.4] Midiendo no es sin medir: mientras la lectura esta en vuelo no hay etiqueta. -->
          @if (saldoSinMedir() && !cargandoSaldo()) {
            <p-tag value="Corte sin medir" severity="warn"></p-tag>
          } @else if (corteAbierto(); as c) {
            <p-tag [value]="'Corte ' + c.folio" severity="info"></p-tag>
          }

          <!-- [CG.37] Calendario de PrimeNG, no el nativo del sistema operativo. El nativo se
               pinta con el tema de Windows: otro alto, otro foco y, en oscuro, otro color que
               no sale de nuestros tokens. Es el antipatron que DESIGN.md nombra -- control
               nativo conviviendo con su equivalente de PrimeNG en la MISMA vista. -->
          <p-datepicker class="cg-conc-fecha" [ngModel]="fechaD(arqueoFecha())"
                        (onSelect)="setArqueoFecha(claveDe($event))"
                        dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                        ariaLabel="Jornada a revisar" />

          <!-- ⭐ [CG.29] LA ACCION QUE FALTABA, Y ERA EL PEOR DEFECTO DE LA PANTALLA.
               Este bloque se llamaba "Cierre de la jornada" y no tenia UN SOLO BOTON: prometia un
               acto y entregaba un informe. Quien venia a rendir cuentas leia el titulo, no
               encontraba con que, y se iba.
               El mecanismo existia -- abrir corte, contar a ciegas, sellar, cerrar, autorizar --
               pero entraba por un boton "Abrir corte" gris y chico, en medio de una linea de
               texto. Nadie busca "corte" cuando quiere rendir cuentas del dia. -->
          <!-- [CGP-V.3] Tambien se reintenta cuando no se sabe si hay jornadas atrasadas: abrir hoy
               a ciegas puede dejarlas sin poder cerrarse, y eso no se deshace desde aqui. -->
          <!-- [CGP-V.4] Mientras el saldo se mide el boton espera: Reintentar mandaria mas lecturas
               contra el mismo limite que la esta frenando. -->
          <!-- [CGP-V.6] Sin el permiso no se ofrece el boton: se dice cual falta. -->
          @if (!puedeGestionar()) {
            <small class="fin-hint-warn">Rendir cuentas necesita el permiso «Capturar en Caja General»:
              este usuario sólo puede ver.</small>
          } @else if (cierreSinMedir() && !cargandoSaldo()) {
            <p-button label="Reintentar" icon="pi pi-refresh" size="small" severity="secondary"
                      [text]="true" (onClick)="reintentarCierre()"></p-button>
          } @else {
            <p-button [label]="etiquetaCierre()"
                      icon="pi pi-lock" size="small"
                      [loading]="abriendo() || midiendoAtrasadas() || cargandoSaldo()"
                      [disabled]="abriendo() || midiendoAtrasadas() || cargandoSaldo()"
                      (onClick)="cerrarJornada()"></p-button>
          }
        </div>

        <!-- [CGP-V.1] En que paso va el corte y que sigue, siempre a la vista. Sale del servidor; sin
             saldo medido no se afirma ningun paso (la etiqueta de arriba ya dice "sin medir"). -->
        @if (pasoPagina(); as paso) {
          <app-caja-pasos [paso]="paso" [texto]="textoPasoPagina()" />
        }
        <!-- [CGP-V.5] Abrir desde rendir cuentas no pasa por un dialogo: el error va junto al boton. -->
        @if (errorApertura() && !aperturaAbierta()) {
          <p-message severity="error" class="cg-full">{{ errorApertura() }}</p-message>
        }

        <!-- [CGP-V.3] LAS JORNADAS ATRASADAS, EN ORDEN. El boton de arriba ya abre la mas vieja y lo
             dice en su etiqueta; esto dice cuales faltan y por que el orden importa.
             (Sin acentos graves aca adentro: esto vive en un template literal.) -->
        @if (atrasadas().length) {
          <p-message severity="warn" class="cg-full">{{ textoAtrasadas() }} Se cierran en orden, de
            la más vieja a la más nueva: si se abre primero el corte de hoy, las de atrás ya no se
            pueden cerrar desde aquí.</p-message>
        } @else if (cierreSinMedir() && !saldoSinMedir()) {
          <small class="fin-hint-warn">No se pudo saber si hay jornadas sin corte antes de hoy.
            Abrir el corte de hoy sin saberlo podría dejarlas sin poder cerrarse.</small>
        } @else if (jornadasAtrasadas().estado === 'no_informa') {
          <small class="fin-dim">Esta versión del servidor no informa las jornadas sin corte.</small>
        }

        @if (cargandoArqueo()) {
          <small class="fin-dim">Midiendo la jornada...</small>
        } @else if (arqueo(); as a) {

          <!-- ⭐ [CG.32] Cuando el libro esta EN CERO y hay cola, este bloque se pliega.
               Medido: ocupaba la mitad de la pantalla para publicar cuatro ceros, y lo unico que
               habia para hacer -1,887 movimientos- empezaba al 70% del alto, debajo del pliegue.
               Lo que vale $0 no puede tapar lo que si hay que hacer.
               Se PLIEGA, no se esconde: queda su renglon, su boton, y los avisos de abajo
               -incluida la contradiccion libro-vs-boveda- siguen a la vista siempre. -->
          @if (!verDetalleCierre()) {
            <div class="cg-conc-plegado">
              <span>El libro no registro movimiento en esta jornada.</span>
              <!-- PrimeNG-first (checklist 3): p-button, no un <button> con clase propia. Ghost
                   NEUTRO -- la accion en --action de esta cabecera es "Cerrar jornada", y dos
                   acciones de marca en la misma fila dejan de distinguir cual escribe en la DB. -->
              <p-button label="Ver el cuadre" size="small" severity="secondary" [text]="true"
                        icon="pi pi-chevron-down" (onClick)="cuadreAbierto.set(true)"></p-button>
            </div>
          }

          <!-- [CG.128] El cuadre (543px medidos) es de "Hoy": contesta CUANTO HAY EN CADA CAJA.
               En "Movimientos" estorba, porque alli la pregunta es otra. -->
          @if (seccionJornada() === 'hoy') {
          <div class="cg-conc-cols" [hidden]="!verDetalleCierre()">

            <!-- IZQUIERDA: nuestro libro -->
            <div class="cg-conc-col">
              <strong class="cg-conc-sub">Caja general <small class="fin-dim">(nuestro libro)</small></strong>
              <!-- ⭐ [CG.137] CUENTA T. Antes eran tres renglones con el signo pegado al numero
                   (+ ingresos, - gastos, - depositos). Esa es la forma NETA: obliga a leer el
                   signo de cada cifra y a sumarlos de cabeza. La caja es una cuenta de activo y
                   la forma que le corresponde es la BRUTA: lo que entra de un lado, lo que sale
                   del otro, y el saldo se sigue solo.
                   El vocabulario es el que este repo ya usa -Cargo y Abono-, el mismo de
                   /contabilidad/polizas y /finanzas/estado-cuenta-acreedores. No se inventa
                   "Debe/Haber", que seria un cuarto dialecto para el mismo par.
                   ⚠️ De esa pantalla se toma la SEMANTICA (celda vacia del lado contrario, total
                   al pie), no su CSS: ahi la tabla es cruda con su propia clase de numero
                   (comm-num 0, app-load-state 0), o sea deuda. La base va con surf-table--plain
                   y comm-num, que es la que existe una sola vez.
                   ⛔ [CG.112] El rotulo del pie dice "del libro" y no "del dia": el cajero, en la
                   columna de al lado, tenia el MISMO rotulo con otra cifra. Cada columna nombra
                   lo suyo.
                   (Sin acentos graves aca adentro: template literal.) -->
              <table class="surf-table surf-table--plain is-dense cg-t">
                <caption class="sr-only">Caja general: lo que entro y lo que salio en la jornada</caption>
                <thead>
                  <tr>
                    <th scope="col">Concepto</th>
                    <th scope="col" class="comm-num">Cargo</th>
                    <th scope="col" class="comm-num">Abono</th>
                  </tr>
                </thead>
                <tbody>
                  <!-- ⭐⭐ [CG.194] CADA RENGLON DICE LO QUE YA LE DESCONTARON, PEGADO A EL.
                       "Gastos" publicaba $3,109.00 mientras el libro tenia $8,179.00: la
                       diferencia son $5,070 que se pagaron con efectivo de la maquina, y el
                       servidor los resta bien -ese dinero nunca paso por el cajon-. Lo que
                       faltaba era decirlo. Va DENTRO de la tabla y no como nota al pie porque
                       es el unico lugar donde no hay duda de que renglon corrige.
                       ⚠️ Las dos piernas NO se suman: un ingreso que se trago la maquina y un
                       gasto que salio de ella van en sentidos contrarios, y un total unico los
                       compensaria. Cada una corrige SU renglon o no se pinta. -->
                  <tr>
                    <th scope="row">Ingresos</th>
                    <td class="comm-num cg-cargo">{{ money(a.caja_general.ingresos) }}</td>
                    <td class="comm-num cg-t-vacia" aria-label="sin abono"></td>
                  </tr>
                  @if (bovedaCifras(); as bv) {
                    @if (bv.ingresos > 0) {
                      <tr class="cg-t-sub">
                        <th scope="row"><span class="fin-dim">&nbsp;&nbsp;no incluye lo que entró directo a la bóveda</span></th>
                        <td class="comm-num fin-dim">{{ money(bv.ingresos) }}</td>
                        <td class="comm-num cg-t-vacia" aria-label="sin abono"></td>
                      </tr>
                    }
                  }
                  <tr>
                    <th scope="row">Gastos</th>
                    <td class="comm-num cg-t-vacia" aria-label="sin cargo"></td>
                    <td class="comm-num cg-abono">{{ money(a.caja_general.gastos) }}</td>
                  </tr>
                  @if (bovedaCifras(); as bv) {
                    @if (bv.gastos > 0) {
                      <tr class="cg-t-sub">
                        <th scope="row"><span class="fin-dim">&nbsp;&nbsp;no incluye lo que se pagó con efectivo de la bóveda</span></th>
                        <td class="comm-num cg-t-vacia" aria-label="sin cargo"></td>
                        <td class="comm-num fin-dim">{{ money(bv.gastos) }}</td>
                      </tr>
                    }
                  }
                  <tr>
                    <th scope="row">Depositos al banco</th>
                    <td class="comm-num cg-t-vacia" aria-label="sin cargo"></td>
                    <td class="comm-num cg-abono">{{ money(a.caja_general.depositos) }}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Movimiento del libro</th>
                    <td class="comm-num" colspan="2">{{ money(a.caja_general.neto) }}</td>
                  </tr>
                </tfoot>
              </table>

              <!-- ⭐ [CG.194] POR QUE UN MOVIMIENTO APARECE RECORTADO EN DOS RENGLONES A LA VEZ.
                   El reparto es por PESO, no por movimiento: un cobro de ruta entra como UNO y
                   se parte -los billetes se los traga la maquina, la morralla llega al cajon-.
                   Sin este conteo, los dos renglones de arriba parecen dos hechos distintos.
                   ⚠️ "Ausente" no es cero: una version vieja del servidor no manda el campo, y
                   dibujar 0 ahi afirmaria que no se partio nada. Se declara. -->
              @if (boveda() === 'sin_medir') {
                <small class="fin-hint-warn">No se puede decir cuánto de esta jornada se quedó en
                  la bóveda: esta versión del servidor no lo informa. Los renglones de arriba
                  pueden venir recortados sin avisar.</small>
              } @else if (bovedaCifras(); as bv) {
                <small class="fin-dim">{{ bv.movimientos }} movimiento(s) tocaron las dos cajas: el
                  importe se parte, no el movimiento.</small>
              }
              <!-- ⭐⭐ [CG.97] "Movimiento del dia" es correcto -el dinero entro y se registro- pero
                   se LEE como "esto hay en la caja", y no lo hay: la maquina se traga los billetes
                   de los cobros de ruta y al cajon llega la morralla. Modelo "cajas separadas",
                   el mismo que ya declara conciliacionCajero. Sin esto el arqueo sale a contar
                   decenas de miles que estan dentro del cajero. -->
              <!-- ⛔ [CG.180] UNA guarda para las DOS mitades. Acá la condición era
                   "en_el_cajon != null" y tres lineas abajo se pintaba "a_la_boveda!" -- otro
                   campo, nullable por su cuenta, con un signo de admiracion tapandole la boca al
                   compilador. No rompia porque el servidor los manda juntos; bastaba que uno
                   dejara de venir para que money(null) dibujara $0.00, o sea un cero afirmando
                   que no quedo nada en el cajon. Ahora las dos salen del mismo objeto. -->
              @if (cajon(); as cj) {
                <div class="cg-conc-row"><span class="fin-dim">&nbsp;&nbsp;de eso, a la bóveda</span>
                  <span class="mono fin-dim">{{ money(cj.a_la_boveda) }}</span></div>
                <!-- ⛔ [CG.97.1] Esto NO es un saldo y el rotulo decia que si ("Queda en el cajon"),
                     con un NEGATIVO pintado de VERDE. Es el MOVIMIENTO del cajon en la jornada, y
                     puede ser negativo de verdad: un gasto de hoy pagado con efectivo que el cajero
                     dispenso ANTEAYER sale del cajon hoy y entro hace dos dias. Lo que hay en el
                     cajon = fondo inicial + esto, y el fondo se declara una vez. -->
                <div class="cg-conc-row"><span class="fin-dim">&nbsp;&nbsp;le dejó al cajón</span>
                  <span class="mono fin-dim">{{ money(cj.en_el_cajon) }}</span></div>
                <!-- ⭐ [CG.99] Con el fondo, la resta se vuelve un SALDO que se puede ir a contar.
                     Sin el, "le dejo al cajon" es solo un movimiento y puede salir negativo de
                     forma legitima -- un gasto de hoy pagado con efectivo dispensado anteayer. -->
                @if (a.caja_general.fondo_inicial != null) {
                  <div class="cg-conc-row"><span class="fin-dim">&nbsp;&nbsp;fondo con el que arrancó</span>
                    <span class="mono fin-dim">{{ money(a.caja_general.fondo_inicial!) }}</span></div>
                  <div class="cg-conc-row cg-conc-tot"
                       [class.cg-cajon-neg]="hayEnCajon()! < 0" [class.cg-cajon-pos]="hayEnCajon()! >= 0">
                    <span>Hay en el cajón</span>
                    <span class="mono">{{ money(hayEnCajon()!) }}</span></div>
                  <small class="fin-dim">Esto es lo que se cuenta a mano. Los billetes que el cajero
                    se tragó se quedan en la bóveda y los cuenta la máquina.</small>
                } @else {
                  <!-- ⛔ No se dibuja un cero ni se publica el movimiento como si fuera un saldo:
                       se DICE que falta la base y se ofrece declararla, una sola vez. -->
                  <small class="fin-hint-warn">No se puede decir cuánto hay en el cajón: falta
                    declarar con cuánto arrancó. Se hace una vez y de ahí cada jornada lo hereda
                    del conteo anterior.</small>
                  <p-button label="Declarar con cuánto arrancó la caja" icon="pi pi-pencil" size="small"
                            severity="secondary" [text]="true" (onClick)="abrirApertura()"></p-button>
                }
              }
              <small class="fin-dim">
                {{ a.caja_general.movimientos }} movimiento(s) registrado(s){{ a.caja_general.cancelados ? ', ' + a.caja_general.cancelados + ' cancelado(s)' : '' }}.
              </small>

              <!-- ⭐ [CG.115] LO QUE QUEDO SUELTO DE OTROS DIAS. Antes esto no se declaraba porque
                   no hacia falta: el corte se lo tragaba todo, y por eso el esperado daba
                   -$206,008.34 sumando el 25-sep, el 10-dic y la captura de hoy. Ahora el corte
                   solo barre SU jornada, asi que lo de otros dias tiene que tener donde VERSE --
                   si no, cambiar el barrido lo habria desaparecido en vez de arreglarlo. -->
              @if (sueltosFuera(); as sf) {
                <div class="cg-fuera">
                  <strong class="cg-fuera-h"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    Fuera de esta jornada</strong>
                  @if (sf.anteriores.movimientos) {
                    <div class="cg-conc-row"><span>{{ sf.anteriores.movimientos }} de días anteriores
                      <small class="fin-dim">@if (sf.desde) {(desde el {{ diaCorto(sf.desde) }}) }— su jornada nunca se cerró</small></span>
                      <span class="mono">{{ money(sf.anteriores.neto) }}</span></div>
                  }
                  @if (sf.posteriores.movimientos) {
                    <div class="cg-conc-row"><span>{{ sf.posteriores.movimientos }} con fecha posterior
                      <small class="fin-dim">@if (sf.hasta) {(hasta el {{ diaCorto(sf.hasta) }}) }— o es captura adelantada, o la fecha está mal</small></span>
                      <span class="mono">{{ money(sf.posteriores.neto) }}</span></div>
                  }
                  <small class="fin-dim">No entran a este corte ni a su esperado. Siguen sueltos,
                    esperando el corte de su propio día.</small>
                </div>
              }

              <!-- ⛔ CG.19 sigue intacto: el ESPERADO no se compone aca. La suma
                   "fondo + ingresos - egresos - depositos" ES el esperado, y publicarla mientras
                   alguien cuenta a ciegas seria devolverle por la ventana lo que se le oculta.
                   Lo unico que se dice es SI hay corte, que no es secreto. -->
              @if (a.corte_abierto; as c) {
                <!-- ⛔ [CG.99] ESTA FRASE Y EL NUMERO DE ABAJO SE CONTRADECIAN EN LA MISMA
                     PANTALLA. Decia "el esperado se revela al sellar el conteo" SIEMPRE que
                     hubiera corte abierto, y tres renglones mas abajo imprimia "Esperado en caja
                     general $3,402.45" a quien tiene permiso de cierre. El dato estaba bien
                     gateado -- el servidor manda saldo:null cuando recorta, y arqueoFinal() es
                     null mientras este oculto -- pero el TEXTO no se condiciono a lo mismo que
                     el numero, asi que para quien si lo ve la frase era falsa.
                     Es el mismo defecto que el comentario de la cobertura, 40 lineas mas arriba,
                     ya denuncia: "dos frases contradictorias sobre el mismo hecho".
                     Ahora cada caso dice lo suyo, y la condicion es la MISMA que pinta el
                     numero: arqueoFinal(). -->
                @if (arqueoFinal()) {
                  <small class="fin-hint-ok d-block">Corte {{ c.folio }} abierto.</small>
                } @else {
                  <small class="fin-hint-ok d-block">Corte {{ c.folio }} abierto: el esperado se revela al sellar el conteo.</small>
                }
                <!-- ⛔ [CG.112] ACA HABIA UN SEGUNDO BOTON "Declarar con cuanto arranco la caja",
                     identico al de 18 lineas mas arriba: misma etiqueta, misma accion, mismo
                     hecho. Sus dos condiciones (hayEnCajon() nulo / c.fondo_inicial nulo) son la
                     MISMA ausencia vista desde dos lados, asi que se pintaban los dos juntos.
                     Edgar, con la pantalla a la vista: "informacion traslapada".
                     Un boton repetido no es redundancia inofensiva: obliga a decidir cual de los
                     dos es el bueno antes de poder hacer lo unico que hay que hacer. -->

                <!-- El esperado y la caja chica conciliada SOLO existen cuando el servidor ya los
                     revelo (permiso de cierre). "arqueoFinal()" devuelve null mientras esten
                     ocultos, asi que este bloque no se pinta y no hay nada que tapar. -->
                @if (arqueoFinal(); as af) {
                  <div class="cg-conc-row cg-conc-tot"><span>Esperado en caja general</span>
                    <span class="mono">{{ money(af.esperado) }}</span></div>
                  @if (af.conciliada !== null) {
                    <div class="cg-conc-row"><span>Caja chica conciliada <small class="fin-dim">(esperado &minus; depositado + dispensado)</small></span>
                      <span class="mono">{{ money(af.conciliada) }}</span></div>
                  }
                }
              }
            </div>

            <!-- DERECHA: el cajero (CAOS), con SUS SEIS TIPOS -->
            <div class="cg-conc-col">
              <strong class="cg-conc-sub">Cajero (CAOS) <small class="fin-dim">(la boveda)</small></strong>
              @if (a.cajero; as cj) {
                <!-- ⚠️ El texto va AFUERA y sigue siendo solo para lector de pantalla. El
                     "#caption" de p-table NO es un <caption>: lo pinta en .p-datatable-header,
                     o sea una barra VISIBLE. Estos cuatro rotulos nacieron ocultos a proposito
                     (describen la tabla, no la titulan), asi que usarlo los habria sacado a la
                     pantalla sin que nadie lo pidiera. -->
                <p class="cg-cap">Movimientos del cajero en la jornada, por tipo</p>
                <p-table [value]="cj.por_tipo" size="small" class="cg-conc-tbl">
                  <ng-template #header>
                    <tr><th scope="col">Tipo</th><th scope="col" class="comm-num">Movs</th><th scope="col" class="comm-num">Monto</th></tr>
                  </ng-template>
                  <ng-template #body let-t>
                    <tr [class.cg-trabada]="t.desconocido">
                      <td>
                        {{ t.etiqueta }}
                        @if (t.desconocido) {
                          <small class="fin-hint-warn d-block">Tipo que no conocemos: NO se sumo a ninguna pierna.</small>
                        }
                      </td>
                      <td class="comm-num">{{ t.movimientos }}</td>
                      <td class="comm-num">{{ money(t.monto) }}</td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage>
                    <tr><td colspan="3"><small class="fin-dim">El cajero no se movio en esta jornada.</small></td></tr>
                  </ng-template>
                </p-table>
                <!-- ⭐ [CG.137] La misma cuenta T que la columna de al lado, para que las dos se
                     lean igual. La tabla de arriba es el DESGLOSE por tipo de movimiento del
                     cajero; esto es la cuenta.
                     ⛔ "Movimiento", NUNCA "saldo": CAOS no publica su contenido y el acumulado
                     del flujo da negativo porque el efectivo anterior al feed no se sabe. Por eso
                     el pie de esta T no se rotula "Saldo" aunque la forma sea la de una cuenta:
                     la forma no autoriza a afirmar lo que el dato no dice.
                     [CG.112] Y dice "de la boveda", no "del dia": el de al lado tambien era "del
                     dia" con otra cifra. -->
                <table class="surf-table surf-table--plain is-dense cg-t">
                  <caption class="sr-only">Cajero: lo que entro y lo que salio de la boveda</caption>
                  <thead>
                    <tr>
                      <th scope="col">Concepto</th>
                      <th scope="col" class="comm-num">Cargo</th>
                      <th scope="col" class="comm-num">Abono</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Entra <small class="fin-dim">(deposito + dotar)</small></th>
                      <td class="comm-num cg-cargo">{{ money(cj.entra) }}</td>
                      <td class="comm-num cg-t-vacia" aria-label="sin abono"></td>
                    </tr>
                    <tr>
                      <th scope="row">Sale <small class="fin-dim">(dispensar + vaciar)</small></th>
                      <td class="comm-num cg-t-vacia" aria-label="sin cargo"></td>
                      <td class="comm-num cg-abono">{{ money(cj.sale) }}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Movimiento de la bóveda</th>
                      <td class="comm-num" colspan="2">{{ money(cj.neto) }}</td>
                    </tr>
                  </tfoot>
                </table>
                <small class="fin-dim">
                  {{ cj.movimientos }} movimiento(s) del cajero en la jornada.
                </small>
              } @else {
                <small class="fin-dim">Sin cajero que cuadrar en esta sucursal. El motivo esta abajo.</small>
              }
            </div>
          </div>
          }

          <!-- ⭐ [CG.91] EL HISTORIAL DE LO QUE LLEVO HECHO. Pedido dos veces.
               La primera: "un historial de movimientos para que el usuario vea que movimientos ya
               hizo". Se entrego un filtro ("los mios") y un reporte en texto: ninguna es la lista.
               La segunda, con la pantalla a la vista: "ni siquiera me muestra un historial de lo
               que llevo hecho, como te lo pedi".
               Acá estaba el defecto: el cuadro decia "7 movimiento(s) registrado(s)" y ahi
               terminaba. Un contador no es un historial -- y un total que no se puede revisar
               contra sus renglones no se puede revisar.
               Va a lo ANCHO y debajo de las dos columnas a proposito: el cuadro de arriba es el
               resumen, esto es el cuerpo. De paso empareja el bloque, que tenia una tabla de un
               lado y cuatro renglones del otro. -->
          <!-- ⭐⭐ [CG.128] EL DIARIO DEL DIA, EN SU PROPIA SECCION.
               Medido en la pantalla viva: este bloque solo pesaba 1,058px de los 2,023 de "Hoy"
               -- el 55%. Y no es el cuadre: el cuadre dice CUANTO HAY EN CADA CAJA, esto dice QUE
               HICISTE. Dos preguntas distintas, y por eso dos secciones. -->
          @if (seccionJornada() === 'movimientos' && a.movimientos_del_dia?.length) {
            <div class="cg-hist">
              <!-- ⭐ [CG.139] A QUE CAJA FUE EL DINERO. El eje no es el tipo -eso ya lo dicen las
                   dos columnas Cargo/Abono- sino en que caja quedo: de un cobro de ruta la maquina
                   se traga los billetes y al cajon llega la morralla. Por eso el selector cambia
                   el IMPORTE de cada renglon y no esconde renglones: un cobro sale en las tres
                   vistas, con la cifra que le toca a cada caja. -->
              <div class="cg-hist-cap">
                <p class="cg-cap">Movimientos que registraste en esta jornada</p>
                <app-segmented [options]="opcionesDondeEntro" [value]="dondeEntro()"
                               (valueChange)="dondeEntro.set($any($event))"
                               ariaLabel="A qué caja fue el dinero"></app-segmented>
              </div>
              <!-- [CG.127] Paginada: el servidor la topa en 200 y el dia mas cargado de las
                   ultimas dos semanas tuvo 52 filas (medido en prod). Dentro de un dialogo de
                   78vh, 52 renglones empujan el pie fuera de la vista y el total deja de poder
                   revisarse contra la lista -- que es para lo que el pie existe. -->
              <p-table [value]="a.movimientos_del_dia!" size="small" class="cg-conc-tbl"
                       [paginator]="(a.movimientos_del_dia || []).length > 20" [rows]="20"
                       [showCurrentPageReport]="true"
                       currentPageReportTemplate="{first}–{last} de {totalRecords}">
                <ng-template #header>
                  <!-- [CG.91.2] El orden sigue a lo que la persona RECONOCE: la hora, con quien
                       fue y cuanto. El folio interno (CI-2026-00007) y la cuenta son respaldo, no
                       lo que se busca con la vista. -->
                  <tr>
                    <th scope="col">Hora</th>
                    <th scope="col">Contraparte</th>
                    <th scope="col">De dónde salió</th>
                    <th scope="col">Cuenta</th>
                    <!-- ⭐ [CG.139] Era UNA columna "Importe" con el signo pegado al numero y el
                         verde para distinguir la entrada. Partida en dos, el lado ya dice el
                         signo: el diario es columnar por eso, y asi el color deja de ser lo que
                         separa una entrada de una salida (DESIGN: el color nunca es el unico
                         portador). Mismo par Cargo/Abono que las dos cuentas T de arriba. -->
                    <th scope="col" class="comm-num">Cargo</th>
                    <th scope="col" class="comm-num">Abono</th>
                  </tr>
                </ng-template>
                <ng-template #body let-m>
                  <!-- El cancelado NO se esconde: se marca. Esconderlo haria que la lista no
                       explique su propio contador, que los cuenta aparte. -->
                  <tr [class.cg-hist-canc]="m.estado === 'cancelado'">
                    <td class="mono">{{ m.hora }}</td>
                    <td>
                      <span class="cg-hist-benef">{{ m.beneficiario || '—' }}</span>
                      @if (m.estado === 'cancelado') { <span class="cg-hist-tag">cancelado</span> }
                      <small class="mono fin-dim d-block">{{ m.folio }}</small>
                    </td>
                    <!-- Sale del origen_ref, que lo arma el servidor — no de la glosa. -->
                    <td class="mono fin-dim">{{ m.documento || 'captura a mano' }}</td>
                    <td class="fin-dim">{{ m.cuenta ? m.cuenta + (m.concepto ? ' · ' + m.concepto : '') : '—' }}</td>
                    <!-- [CG.139] El lado dice el signo, asi que ni el + / - ni el verde hacen
                         falta ya. La celda del lado contrario lleva el mismo guion tenue que las
                         T de arriba: un blanco se leeria como "no se midio". -->
                    <td class="comm-num cg-cargo" [class.cg-t-vacia]="m.tipo !== 'ingreso'">
                      @if (m.tipo === 'ingreso') { {{ money(montoDe(m)) }} }
                    </td>
                    <td class="comm-num cg-abono" [class.cg-t-vacia]="m.tipo === 'ingreso'">
                      @if (m.tipo !== 'ingreso') { {{ money(montoDe(m)) }} }
                    </td>
                  </tr>
                </ng-template>
                <!-- ⭐ [CG.91.2] EL PIE QUE CIERRA. Sin esto la lista no se puede revisar contra
                     nada: el cuadro de arriba dice "Movimiento del dia" y abajo habia renglones
                     sueltos que nadie podia sumar con la vista. Aca se suman los MISMOS renglones
                     que estan a la vista, y el total tiene que dar igual al de arriba. Si no da,
                     eso YA es informacion -- quiere decir que la lista esta topada o que hay algo
                     fuera del reloj de la jornada. -->
                <ng-template #footer>
                  <!-- [CG.139] El pie de un diario son las SUMAS DE SUS COLUMNAS, cada una bajo
                       la suya. Antes las dos iban como texto corrido dentro de un colspan y el
                       neto solo en la ultima celda: habia que leer una frase para enterarse de
                       cuanto sumaba cada lado, y ninguna de las dos cifras caia debajo de los
                       numeros que resumia.
                       ⛔ Y el segundo renglon NO se llama "Movimiento del libro" aunque mida casi
                       lo mismo. Ese rotulo ya es el del pie de la cuenta T de arriba, que sale
                       del SERVIDOR; este sale de sumar los renglones VISIBLES. [CG.112] ya costo
                       una vez tener el mismo rotulo sobre dos cifras distintas a la vista. Que
                       las dos tengan que coincidir es justamente el control: si no coinciden, la
                       lista esta topada o hay algo fuera del reloj de la jornada. -->
                  <tr class="cg-hist-pie">
                    <td colspan="4">Suma de los renglones a la vista
                      @if (totalHistorial().cancelados) {
                        <small class="fin-dim">&nbsp;· {{ totalHistorial().cancelados }} cancelado(s), fuera del total</small>
                      }
                      <!-- [CG.139] Que estos importes son UNA PARTE del movimiento se DICE, o el
                           pie se leeria como el total del dia con cifras mas chicas. -->
                      @if (dondeEntro() !== 'todo') {
                        <small class="fin-dim">&nbsp;· sólo la parte que
                          {{ dondeEntro() === 'boveda' ? 'se llevó la máquina' : 'quedó en el cajón' }}</small>
                      }
                    </td>
                    <td class="comm-num cg-cargo">{{ money(totalHistorial().ingresos) }}</td>
                    <td class="comm-num cg-abono">{{ money(totalHistorial().gastos) }}</td>
                  </tr>
                  <tr class="cg-hist-pie">
                    <td colspan="4">Diferencia</td>
                    <td class="comm-num cg-hist-neto" colspan="2">{{ money(totalHistorial().neto) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }

          <!-- ⛔ Lo que NO se puede afirmar se PINTA. Un hueco callado se lee como cero, y aca la
               diferencia entre "flujo del dia" y "cuanto hay en el cajero" es justamente esto. -->
          <!-- ⭐ [CG.29] DOS listas, no una. Antes eran tres avisos naranjas iguales y dos de
               ellos eran permanentes -- salian todos los dias y nadie podia resolverlos. Un aviso
               inmutable que grita se deja de leer, y se lleva puesto al que si importaba.
               Arriba, lo que ESTA jornada no pudo afirmar y alguien puede cambiar hoy. -->
          @if (a.no_medido.length) {
            <ul class="cg-conc-nm">
              @for (m of a.no_medido; track m) { <li>{{ m }}</li> }
            </ul>
          }
          <!-- Abajo y en gris, lo que este cuadre NUNCA va a cubrir. No se esconde: se ordena. -->
          @if (a.limites?.length) {
            <!-- PrimeNG-first (checklist 3): el alto de toque y el anillo de foco los pone el
                 componente, no una regla a mano por pantalla. -->
            <!-- [CG.116] ERA EL TERCER DESPLEGABLE DE LA PANTALLA y es el que aparece en el
                 pantallazo de Edgar. Ahora que todo esto vive dentro de una ventana, plegarlo no
                 protege nada: la pantalla de atras no se mueve igual. Lo que si hacia era
                 esconder DOS renglones de texto detras de un clic, y despues empujar lo de abajo
                 al abrirlos. Se pinta y ya. -->
            <p class="cg-conc-lim-h">Que NO cubre este cuadre ({{ a.limites!.length }})</p>
            <ul class="cg-conc-lim">
              @for (m of a.limites!; track m) { <li>{{ m }}</li> }
            </ul>
          }
        } @else {
          <!-- Tercer estado. "Sin medir" no es "el dia estuvo en cero". -->
          <small class="fin-hint-warn">No se pudo medir la jornada. No es que no haya movimiento: es que no se pudo leer.</small>
        }
      </div>
          }

          <!-- [CG.123] PENDIENTES: lo que espera trabajo. No es "tu jornada" -- son documentos
               por pagar y gastos que repiten sin cuenta declarada. Vivian pegados debajo del
               cuadre del dia, al mismo peso, y por eso el dia y el pendiente se leian igual. -->
          @if (seccionJornada() === 'pendientes') {
      @if (pagables().length) {
        <section class="cg-bandeja">
          <header class="cg-bandeja-head">
            <h2 class="fin-h2"><i class="pi pi-file" aria-hidden="true"></i> Gastos y órdenes de entrada</h2>
            <span class="cg-bandeja-sp"></span>
            <small class="fin-dim">{{ pagables().length }} documento(s) por pagar que coinciden con la búsqueda — aún no son movimientos de caja</small>
          </header>
          <div class="cg-caos-list">
            @for (g of pagables(); track g.origen_ref) {
              <div class="cg-caos-row">
                <span class="cg-caos-tag">{{ g.pagable_label }}</span>
                <span class="mono">{{ g.folio }}</span>
                <span class="fin-dim">{{ dmy(g.fecha_valor) }}</span>
                <span class="cg-caos-ref">{{ g.beneficiario || 'sin beneficiario' }}
                  @if (g.concepto) { <small class="fin-dim">· {{ g.concepto }}</small> }
                </span>
                <span class="mono cg-caos-monto">{{ money(g.monto) }}</span>
                <p-button label="Pagar en efectivo" icon="pi pi-wallet" size="small" [text]="true"
                          (onClick)="capturarDesdePagable(g)"></p-button>
              </div>
            }
          </div>
        </section>
      }

      <section class="cg-bandeja cg-rec">
        <div class="cg-bandeja-head">
          <strong>Repiten y nadie declaro su cuenta</strong>
          <span class="cg-bandeja-sp"></span>
          @if (recurrentes(); as rc) {
            <small class="fin-dim">{{ textoRecurrentes(rc) }}</small>
            <p-button size="small" severity="secondary" [text]="true"
                      [label]="recAbierto() ? 'Ocultar' : 'Ver los ' + rc.medido.sin_regla"
                      (onClick)="recAbierto.set(!recAbierto())"></p-button>
          } @else {
            <!-- Tercer estado: no es "no hay ninguno", es que no se midio. -->
            <small class="fin-hint-warn">Sin medir: no se pudo leer la lista.</small>
          }
        </div>

        @if (recAbierto()) {
        @if (recurrentes(); as rc) {
          <p class="cg-cap">Beneficiarios recurrentes sin regla de clasificacion declarada</p>
              <!-- [CG.50] D.7: sus filas llevan acciones (comprobante, declarar, autorizar) y sin esto el teclado solo llega tabulando fila por fila. pSelectableRow = roving tabindex + flechas + Home/End, y la tabla entera es UN stop. -->
          <p-table [value]="rc.rows" size="small" dataKey="beneficiario" selectionMode="single" [(selection)]="filaRecurrente">
            <ng-template #header>
              <tr>
                <th scope="col">Beneficiario</th>
                <th scope="col" class="comm-num">Pagos</th>
                <th scope="col" class="comm-num">Monto</th>
                <th scope="col">Importe</th>
                <th scope="col">Cuenta</th>
                <th scope="col" class="comm-num">Sin cobrar</th>
                <th scope="col"><span class="sr-only">Declarar</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
                <tr [pSelectableRow]="r">
                  <td>
                    {{ r.beneficiario }}
                    @if (r.pagos_con_regla > 0) {
                      <!-- Cobertura PARCIAL: una regla con match_glosa puede clasificar una parte de
                           sus movimientos y no el resto. Un si/no lo esconderia. -->
                      <small class="fin-hint-warn d-block">{{ r.pagos_con_regla }} de sus pagos ya los clasifica una regla.</small>
                    }
                  </td>
                  <td class="comm-num">{{ r.pagos }}</td>
                  <td class="comm-num">{{ money(r.monto) }}</td>
                  <td>
                    <!-- ⭐ El CV decide QUE se le puede proponer. Es lo unico que discrimina: la
                         cadencia da 2-5 dias para todos. -->
                    <span class="cg-cv" [class.cg-cv-fijo]="esImporteProponible(r)">{{ textoImporte(r) }}</span>
                  </td>
                  <td>
                    @if (r.propuesta_contable; as p) {
                      <span class="fin-hint-ok">{{ p.kepler_cuenta }} / {{ p.kepler_concepto }}</span>
                      <small class="fin-dim d-block">{{ p.soporte }} antecedentes, {{ pctDominancia(p) }}% coinciden</small>
                    } @else {
                      <small class="fin-dim">Sin de donde proponer: la contabilidad no tiene su par.</small>
                    }
                  </td>
                  <td class="comm-num">
                    @if (r.dias_sin_pago !== null) {
                      <span [class.fin-neg]="r.dias_sin_pago > rc.caido_dias">{{ r.dias_sin_pago }} d</span>
                    } @else { <span class="cg-na">&mdash;</span> }
                  </td>
                  <td class="ta-c">
                    <!-- Se abre la captura con el beneficiario puesto: declarar la regla es el
                         checkbox que ya existe, ahi mismo. No se inventa una segunda puerta. -->
                    <p-button size="small" severity="secondary" [text]="true" icon="pi pi-pencil"
                              [ariaLabel]="'Declarar la cuenta de ' + r.beneficiario"
                              (onClick)="declararDesdeRecurrente(r)"></p-button>
                  </td>
                </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7"><small class="fin-dim">Ninguno: todos los que repiten tienen su cuenta declarada.</small></td></tr>
            </ng-template>
          </p-table>

          @if (rc.medido.caidos > 0) {
            <!-- [CG.27-B.3] Que un recurrente deje de cobrar es una senial: se fue, o alguien dejo
                 de pagarle. No va a la bandeja de hallazgos: aca el trabajo cierra solo. -->
            <small class="fin-hint-warn d-block">
              {{ rc.medido.caidos }} lleva(n) mas de {{ rc.caido_dias }} dias sin cobrar, marcados en rojo.
            </small>
          }
        }
        }
      </section>

          }

          <!-- [CG.123] HISTORIAL: el libro y los cortes, por un rango de fechas PROPIO -- trae
               sus calendarios adentro. O sea que por definicion NO es la jornada de hoy, y
               tenerlo aca abajo era la parte mas enganosa del titulo. -->
          @if (seccionJornada() === 'historial') {
      <section class="cg-historial">
        <button type="button" class="cg-historial-h" (click)="historialAbierto.set(!historialAbierto())"
                [attr.aria-expanded]="historialAbierto()">
          <i class="pi" [class.pi-chevron-right]="!historialAbierto()"
             [class.pi-chevron-down]="historialAbierto()" aria-hidden="true"></i>
          <span class="cg-historial-t">Historial</span>
          <!-- ⛔⛔ [CG.181] ACÁ SE PUBLICABA UN CERO QUE ERA UN FALLO. Medido en producción el
               2026-10-14: la pantalla imprimía "0 corte(s)" mientras el endpoint devolvía 1
               (CC-2026-00001). La petición se había repetido y la segunda volvió 429; el
               manejador de error vacía la lista, así que el conteo salía en cero — con la misma
               cara que un periodo sin cortes.
               El error YA se guardaba en errLibro/errCortes y esta línea no lo miraba: el
               app-load-state de más abajo lo declara, pero este resumen se lee ANTES y gana.
               Es el defecto que esta pantalla persigue desde [CG.99]: un cero afirmando algo que
               nadie midió. Ahora cada mitad dice lo suyo y por separado -- un fallo del libro no
               puede tapar un conteo de cortes que sí se midió. -->
          <small class="fin-dim">
            del {{ dmy(from) }} al {{ dmy(to) }} ·
            @if (errLibro()) { <span class="fin-hint-warn">el libro no se pudo leer</span> }
            @else { {{ rows().length }} movimiento(s) en el libro }
            ·
            @if (errCortes()) { <span class="fin-hint-warn">los cortes no se pudieron leer</span> }
            @else { {{ cortes().length }} corte(s) }
          </small>
        </button>

        @if (historialAbierto()) {
      <!-- ⚠️ [CG.29] Esta tira es del LIBRO (el rango de acá abajo), no del día. Sin rótulo, su
           "Gastos $130,000.00" quedaba pegado al "Gastos $0.00" del cierre de la jornada: dos
           números con la misma etiqueta, distinto periodo y un centímetro de distancia.
           [CG.37] Y ahora vive donde está lo que resume, no 340 líneas más arriba. -->
      <h2 class="fin-h2 cg-kpi-h">El libro, del {{ dmy(from) }} al {{ dmy(to) }}</h2>
      <app-metric-strip class="cg-kpis-libro" [items]="kpis()"></app-metric-strip>

      <div class="fin-filters">
        <p-datepicker [ngModel]="fechaD(from)" (onSelect)="setDesde($event)"
                      dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                      placeholder="Desde" ariaLabel="Desde" />
        <p-datepicker [ngModel]="fechaD(to)" (onSelect)="setHasta($event)"
                      dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                      placeholder="Hasta" ariaLabel="Hasta" />
        <p-select [options]="tiposFiltro" [(ngModel)]="tipo" (ngModelChange)="cargar()"
                  optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true"></p-select>
        <input pInputText [(ngModel)]="search" (keyup.enter)="cargar()"
               placeholder="Buscar en realizados: folio, concepto, beneficiario, usuario…" />
        <!-- CS.3.10 — Reporte diario: los movimientos del rango/filtros + totales.
             [CG.87] VER va primero y imprimir queda al lado: hasta hoy el reporte sólo existía
             en papel, así que para leerlo había que gastar un ticket. Los dos salen del MISMO
             armador (cuerpoReporteDia), no de dos maquetas que se desalinean. -->
        <p-button label="Reporte del día" icon="pi pi-file" severity="secondary" size="small"
                  [loading]="imprimiendoReporte()" (onClick)="verReporteDia()"></p-button>
        <!-- ⚠️ [CG.136] ESTE title SE QUEDA, Y NO ES UN DESCUIDO. La compuerta check:pantalla lo
             marca con la regla TBL ("definicion fija escondida en un title"), pero aca no es una
             definicion: es la UNICA etiqueta visible de un boton sin texto, y su lectura para
             asistencia ya viaja en ariaLabel. Borrarlo para apagar el aviso dejaria el icono
             mudo para quien ve. Lo mismo vale para el de "Imprimir comprobante", abajo.
             Medido en apps/view: de 363 title fijos, 292 estan sobre elementos NO interactivos
             (th/span/i/td) --esos si son definiciones-- y 71 sobre button/a, que son etiquetas
             de control. La regla no separa los dos casos; afinarla es decision de Edgar, porque
             esa compuerta corre sobre 255 pantallas.
             (Sin acentos graves aca adentro: esto vive en un template literal y un backtick lo
              CIERRA. Me acaba de pasar escribiendo este mismo comentario.) -->
        <p-button icon="pi pi-print" severity="secondary" size="small" [text]="true"
                  title="Imprimir el reporte en la térmica" ariaLabel="Imprimir el reporte del día"
                  [loading]="imprimiendoReporte()" (onClick)="imprimirReporteDia()"></p-button>
        <!-- [CG.86] «Sólo los míos»: filtra por el id de quien pregunta, no por su nombre. -->
        <p-button [label]="soloMios() ? 'Viendo: los míos' : 'Todo el libro'"
                  [icon]="soloMios() ? 'pi pi-user' : 'pi pi-users'"
                  [severity]="soloMios() ? 'primary' : 'secondary'" size="small" [outlined]="!soloMios()"
                  (onClick)="alternarMios()"></p-button>
      </div>

      <!-- size="small" SÍ es un input de p-table en v22; styleClass="p-datatable-sm" NO lo es y
           era redundante además de muerto. El estado lo lleva app-load-state, que distingue el
           500 del periodo vacío — en una pantalla de dinero eso no puede verse igual. -->
      <app-load-state [loading]="cargando()" [error]="errLibro()" [isEmpty]="!rows().length"
                      errorTitle="No se pudo leer el libro de caja"
                      emptyIcon="pi-book" emptyTitle="Sin movimientos en el periodo"
                      emptyHint="Prueba con otro rango de fechas o quita el filtro de tipo."
                      (retry)="cargar()">
      <!-- [CG.125] EL FILTRO QUE FALTABA. La pregunta de la supervision es "¿que entro SIN
           documento?", y hasta hoy habia que leer las 233 filas para contestarla. Va como
           segmented con su cifra dentro: se ve cuanto hay en cada uno sin tocarlo. -->
      <div class="cg-libro-filtros">
        <div>
          <span class="cg-det-r">Con qué se concilió</span>
          <app-segmented [options]="opcionesOrigen()" [value]="origenFiltro()"
                         (valueChange)="origenFiltro.set($any($event))"
                         ariaLabel="Con qué se concilió"></app-segmented>
        </div>
        <!-- [CG.126] Son DOS preguntas distintas y por eso dos controles: de donde salio el papel
             no dice a que caja entro el efectivo. Un cobro puede venir de un documento de Kepler
             y terminar en la maquina de CAOS. -->
        <div>
          <span class="cg-det-r">A qué caja entró</span>
          <app-segmented [options]="opcionesCajaDestino()" [value]="cajaFiltro()"
                         (valueChange)="cajaFiltro.set($any($event))"
                         ariaLabel="A qué caja entró el dinero"></app-segmented>
        </div>
      </div>

      <!-- ⛔ [CG.125] expandedRowKeys va de UNA SOLA VIA, no [( )]. En PrimeNG v22 la tabla
           declara el input pero NO su salida expandedRowKeysChange, asi que el binding de dos
           vias falla con NG8007 y Angular lo lee como un evento NATIVO del elemento. La tabla
           muta el objeto en el lugar, que es todo lo que hace falta para recordar que esta
           desplegado. -->
      <!-- ⛔⛔ [CG.127] EL AVISO DE TOPE VA ARRIBA DE LA TABLA, NO ABAJO.
           Si el servidor topo en 500, hay movimientos del periodo que NO estan en la pantalla y
           el encabezado igual publica el total. Abajo del paginador nadie lo ve: quien llega al
           pie ya saco su conclusion. -->
      @if (libroTopado()) {
        <p-message severity="warn" class="cg-full">
          La lista está topada en 500 movimientos y este periodo tiene más. Lo de arriba cuenta
          TODO el periodo; la lista no. Achicá el rango de fechas o usá los filtros.
        </p-message>
      }

      <!-- ⭐ [CG.127] PAGINADOR. Pedido de Edgar: "hay que paginar las tablas que se generen".
           25 por pagina: la rejilla vive dentro de un dialogo con max-height 78vh, asi que una
           pagina tiene que caber sin pelearle el alto a la ventana.
           [rowsPerPageOptions] porque 248 movimientos se revisan distinto que 20.
           ⚠️ Pagina lo TRAIDO. Por eso lo de arriba: sin el aviso de tope, un paginador es la
           forma mas convincente de esconder lo que falta -- dice "1-25 de 100" con total
           seguridad mientras el encabezado dice 248. -->
      <p-table [value]="filasLibro()" size="small" dataKey="id" selectionMode="single" [(selection)]="filaLibro"
               [scrollable]="true" scrollHeight="flex"
               [paginator]="filasLibro().length > 25" [rows]="25"
               [rowsPerPageOptions]="[25, 50, 100]"
               [showCurrentPageReport]="true"
               currentPageReportTemplate="{first}–{last} de {totalRecords}"
               [expandedRowKeys]="libroDesplegado">
        <ng-template #header>
          <tr>
            <!-- scope="col" como en las otras tres tablas de la pantalla: sin el, un lector de
                 pantalla no liga la celda con su encabezado y lee nueve valores sueltos.
                 [CG.125] Y ahora ORDENAN: pSortableColumn + p-sort-icon, que es el orden asc/desc
                 que PrimeNG ya trae -- no se escribe uno a mano (Jakob: la tabla se comporta
                 como un Excel, que es lo que la persona ya sabe usar).
                 ⛔ El elemento es p-sort-icon, NO p-sortIcon: en v22 el selector es
                 "p-sort-icon, p-sorticon" y la forma camelCase da NG8001 "is not a known
                 element". Es un error de PLANTILLA, asi que ni vitest ni el chequeo semantico
                 de check:pantalla lo ven -- sale recien en Build & typecheck. -->
            <th scope="col" class="ta-c"><span class="sr-only">Desplegar</span></th>
            <th scope="col" pSortableColumn="folio">Folio <p-sort-icon field="folio" /></th>
            <th scope="col" pSortableColumn="fecha">Fecha <p-sort-icon field="fecha" /></th>
            <th scope="col" pSortableColumn="tipo">Tipo <p-sort-icon field="tipo" /></th>
            <th scope="col" pSortableColumn="glosa">Qué pasó <p-sort-icon field="glosa" /></th>
            <th scope="col" class="comm-num" pSortableColumn="monto">Monto <p-sort-icon field="monto" /></th>
            <!-- [CG.125] El efectivo NO ordena, y se dice por que: sale de monto - venta_credito,
                 o sea que no es un campo de la fila y p-table ordena por campo. Rotularlo como
                 ordenable y que no ordenara seria peor que no ofrecerlo. -->
            <th scope="col" class="comm-num">Entró a caja</th>
            <th scope="col" pSortableColumn="created_by_username">Capturó <p-sort-icon field="created_by_username" /></th>
            <th scope="col" pSortableColumn="origen_tipo">Origen <p-sort-icon field="origen_tipo" /></th>
            <th scope="col" class="ta-c">Comprobante</th>
          </tr>
        </ng-template>
        <ng-template #body let-m let-expandido="expanded">
          <tr [pSelectableRow]="m">
            <td class="ta-c">
              <p-button [pRowToggler]="m" size="small" severity="secondary" [text]="true" [rounded]="true"
                        [icon]="expandido ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
                        [ariaLabel]="(expandido ? 'Ocultar' : 'Ver') + ' el detalle de ' + m.folio"></p-button>
            </td>
            <td class="mono">{{ m.folio }}</td>
            <td>{{ dmy(m.fecha) }}</td>
            <td><p-tag [value]="etiquetaTipo(m.tipo)" [severity]="sevTipo(m.tipo)"></p-tag></td>
            <td>{{ m.glosa }}</td>
            <td class="comm-num">{{ money(m.monto) }}</td>
            <!-- ⭐ [CG.126] A QUE CAJA ENTRO. La cifra de arriba es el cajon de Caja General,
                 que es el tema de esta pantalla; debajo se nombra lo que se fue a la maquina.
                 Cuando no toca la boveda no se imprime "$0.00 a CAOS": un cero repetido en 233
                 filas es ruido, y el renglon ya dice que todo quedo en el cajon.
                 ⚠️ Y si el servidor no mando el reparto se DECLARA, no se dibuja un cero. -->
            <td class="comm-num">
              @if (repartoDe(m); as r) {
                @if (!r.medido) {
                  <small class="fin-hint-warn">sin repartir</small>
                } @else if (tocaBoveda(m)) {
                  {{ money(r.cajon) }}
                  <small class="fin-dim d-block">{{ money(r.boveda) }} a caja fuerte</small>
                } @else {
                  {{ money(r.cajon) }}
                }
              }
              @if (m.venta_credito) {
                <small class="fin-dim d-block">{{ money(m.venta_credito) }} a crédito</small>
              }
            </td>
            <td>{{ m.created_by_username || '—' }}</td>
            <!-- ⛔ [CG.125] ACA DECIA "autorrellenado"/"manual", que es si el motor propuso la
                 CUENTA -- no de donde salio el dinero. Ver origenDe(). -->
            <td>
              @if (origenDe(m); as o) {
                <span [class.fin-hint-warn]="o.tono === 'warn'">{{ o.sistema }}</span>
                <small class="fin-dim d-block mono">{{ o.ref }}</small>
              }
            </td>
            <td class="ta-c">
              <!-- CS.3.8 — re-imprime el comprobante en la térmica (folio nuestro, desglose, concepto,
                   recibido, total, firma). No para los cancelados: su comprobante ya no vale. -->
              @if (m.estado !== 'cancelado') {
                <p-button icon="pi pi-print" size="small" severity="secondary" [text]="true"
                          [rounded]="true" title="Imprimir comprobante"
                          ariaLabel="Imprimir comprobante"
                          (onClick)="imprimirComprobante(m)"></p-button>
              }
            </td>
          </tr>
        </ng-template>

        <!-- ⭐ [CG.125] EL DESPLEGABLE. Pedido de Edgar: "quiero un desplegable que me diga toda
             la informacion". Lo que salio de la rejilla (la cuenta contable) vive aca, junto con
             todo lo que ya viajaba en la fila y nunca se pintaba. La rejilla queda con lo que se
             RECONOCE de un vistazo; el respaldo se abre cuando hace falta. -->
        <ng-template #expandedrow let-m>
          <tr class="cg-libro-det">
            <td colspan="10">
              <div class="cg-det-rejilla">
                <div><span class="cg-det-r">Cuenta / Concepto</span>
                  <span class="mono">{{ m.kepler_cuenta }} / {{ m.kepler_concepto }}</span>
                  <small class="fin-dim d-block">{{ m.kepler_concepto_nombre || 'sin nombre de concepto' }}</small></div>
                <div><span class="cg-det-r">Beneficiario</span>
                  {{ m.beneficiario || '—' }}
                  @if (m.beneficiario_rfc) { <small class="fin-dim d-block mono">{{ m.beneficiario_rfc }}</small> }</div>
                <div><span class="cg-det-r">Sucursal</span>{{ m.sucursal | sucursal }}</div>
                <div><span class="cg-det-r">Capturado</span>{{ dmy(m.fecha) }}@if (m.hora) { · {{ m.hora }} }
                  <small class="fin-dim d-block">{{ m.created_by_username || 'sin usuario' }}</small></div>

                <div><span class="cg-det-r">Conciliado con</span>
                  @if (origenDe(m); as o) {
                    <span [class.fin-hint-warn]="o.tono === 'warn'">{{ o.sistema }}</span>
                    <small class="fin-dim d-block mono">{{ o.ref }}</small>
                  }</div>
                <!-- [CG.126] El reparto completo, nombrando las DOS cajas aunque una este en
                     cero: aca si vale, porque el desplegable se abre para entender UN movimiento
                     y "cero a la boveda" es la respuesta, no ruido. -->
                <div><span class="cg-det-r">A caja general (cajón)</span>
                  @if (repartoDe(m); as r) {
                    @if (r.medido) { <span class="mono">{{ money(r.cajon) }}</span> }
                    @else { <small class="fin-hint-warn">no se pudo repartir entre las dos cajas</small> }
                  }</div>
                <div><span class="cg-det-r">A caja fuerte (CAOS)</span>
                  @if (repartoDe(m); as r) {
                    @if (r.medido) { <span class="mono">{{ money(r.boveda) }}</span> }
                    @else { <small class="fin-hint-warn">sin medir</small> }
                  }</div>
                <div><span class="cg-det-r">Total del movimiento</span>
                  <span class="mono">{{ money(m.monto) }}</span>
                  @if (m.venta_credito) {
                    <small class="fin-dim d-block">{{ money(m.venta_credito) }} fue a crédito, no entró en efectivo</small>
                  }</div>
                <div><span class="cg-det-r">Morralla</span><span class="mono">{{ money(m.morralla || 0) }}</span></div>
                <div><span class="cg-det-r">Corte</span>
                  @if (m.corte_id) { <span class="mono">{{ m.corte_id }}</span> }
                  @else { <small class="fin-dim">todavía no entró a ningún corte</small> }</div>

                <!-- La CLASIFICACION, que es lo que la vieja columna "Origen" decia en realidad. -->
                <div><span class="cg-det-r">Clasificación contable</span>
                  @if (m.autofill) { <p-tag value="la propuso el sistema" severity="info"></p-tag> }
                  @else { <small class="fin-dim">la tecleó una persona</small> }</div>
                <div><span class="cg-det-r">Firma</span>
                  @if (m.firma_nombre) { {{ m.firma_nombre }}
                    <small class="fin-dim d-block">{{ m.firma_estado || 'sin estado' }}</small> }
                  @else { <small class="fin-dim">sin firma</small> }</div>
                @if (m.sin_documento_motivo) {
                  <div class="cg-det-ancho"><span class="cg-det-r">Por qué no trae documento</span>
                    <span class="fin-hint-warn">{{ m.sin_documento_motivo }}</span></div>
                }
                @if (m.estado === 'cancelado') {
                  <div class="cg-det-ancho"><span class="cg-det-r">Cancelado</span>
                    <span class="fin-hint-warn">{{ m.cancel_reason || 'sin motivo declarado' }}</span>
                    <small class="fin-dim d-block">{{ m.cancelled_by_username || 'sin usuario' }}</small></div>
                }
              </div>
            </td>
          </tr>
        </ng-template>

        <ng-template #emptymessage>
          <tr><td colspan="10" class="fin-empty">Sin movimientos en el periodo.</td></tr>
        </ng-template>
      </p-table>
      </app-load-state>

      <h2 class="fin-h2">Cortes</h2>
      <app-load-state [loading]="cargandoCortes()" [error]="errCortes()" [isEmpty]="!cortes().length"
                      [skeletonRows]="3" errorTitle="No se pudieron leer los cortes"
                      emptyIcon="pi-lock-open" emptyTitle="Sin cortes en el periodo"
                      emptyHint="Los cortes se listan por el mismo rango de fechas de arriba."
                      (retry)="cargarCortes()">
      <p-table [value]="cortes()" size="small" dataKey="id" selectionMode="single" [(selection)]="filaCorte">
        <ng-template #header>
          <tr>
            <th scope="col">Folio</th><th scope="col">Fecha</th><th scope="col">Sucursal</th><th scope="col">Estado</th>
            <th scope="col" class="comm-num">Esperado</th><th scope="col" class="comm-num">Contado</th><th scope="col" class="comm-num">Diferencia</th>
            <th scope="col">Cerró / Autorizó</th><th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-c>
          <tr [pSelectableRow]="c">
            <td class="mono">{{ c.folio }}</td>
            <td>{{ dmy(c.fecha) }}</td>
            <td>{{ c.sucursal | sucursal }}</td>
            <td><p-tag [value]="etiquetaEstadoCorte(c.estado)" [severity]="sevEstadoCorte(c.estado)"></p-tag></td>
            <td class="comm-num">{{ c.esperado === null ? '—' : money(c.esperado) }}</td>
            <td class="comm-num">{{ c.contado === null ? '—' : money(c.contado) }}</td>
            <td class="comm-num" [class.fin-neg]="c.diferencia < 0">
              {{ c.diferencia === null ? '—' : money(c.diferencia) }}
            </td>
            <td>
              <small class="fin-dim">{{ c.closed_by_username || '—' }} / {{ c.authorized_by_username || '—' }}</small>
            </td>
            <td>
              @if (c.estado === 'cerrado') {
                @if (gateAutorizar(c).ok) {
                  <p-button label="Autorizar" size="small" severity="secondary"
                            [loading]="autorizando()" [disabled]="autorizando()"
                            (onClick)="autorizar(c)"></p-button>
                  @if (errorAutorizar()?.id === c.id) {
                    <small class="fin-hint-warn" role="alert">{{ errorAutorizar()?.texto }}</small>
                  }
                } @else {
                  <!-- El porqué NO puede vivir en un [title] de un botón deshabilitado: ahí no lo
                       alcanza el teclado, ni el lector de pantalla, ni un dedo. Se dice. -->
                  <small class="fin-hint-warn">{{ gateAutorizar(c).texto }}</small>
                }
              } @else {
                <small class="fin-dim">{{ gateAutorizar(c).texto }}</small>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9" class="fin-empty">Sin cortes en el periodo.</td></tr>
        </ng-template>
      </p-table>
      </app-load-state>
        }
      </section>
          }
        </div>
      </p-dialog>


      <!-- ⛔ [CG.37] ACA ESTABAN EL TITULO "El libro" Y SU TIRA DE KPIs, y bajaron 340 lineas
           hasta su propia tabla. [CG.29] le habia puesto el rotulo correcto -- la tira es del
           LIBRO, no de la jornada -- pero la dejo donde estaba, o sea arriba del trabajo y
           lejos de lo que resume.

           Lo que costaba, medido sobre la captura de prod: el titulo, la tira y su margen se
           comen ~100px JUSTO ANTES de la bandeja, que es la accion principal de la pantalla.
           Con eso, la primera fila por confirmar nacia debajo del pliegue -- y los cuatro
           mosaicos que la empujaban decian "$0.00" cuatro veces.

           Reordenar, no rediseniar: no se quita ni un dato. El encabezado de la bandeja queda
           pegado a sus filas, y la tira cae junto a los renglones que suma. -->

      <!-- CG.21 - Movimientos por confirmar, los DOS signos. Es la accion PRINCIPAL de la
           pantalla, no un accesorio: medido sobre 5 meses cerrados, el egreso de la caja cuadra
           al 100% contra Kepler ($44,108,221.92 vs $44,123,427.09) y el ingreso de julio con
           $19.88 de diferencia en $10.45M. La persona no deberia capturarlos: confirmarlos. -->
      <!-- ⛔ ACÁ ESTABA EL PEOR DEFECTO DE USO. La sección se montaba con
           "@if (pendientes().length || cargandoPend())" y adentro el vacío preguntaba
           "@if (!pendientes().length && !cargandoPend())" — las dos condiciones son
           EXCLUYENTES, así que ese vacío era código inalcanzable y lo que pasaba de verdad era
           que al filtrar sin resultados desaparecía la sección ENTERA, con los tres selectores
           adentro. La persona quedaba encerrada, sin forma de deshacer el filtro.
           Ahora la sección se pinta SIEMPRE y los tres estados (cargando / error / vacío) los
           distingue app-load-state, que existe justamente para matar el "error === vacío". -->
      <!-- ⭐ [CG.46] O.1 (BINDING): /finanzas/* va en MASTER-DETAIL PERMANENTE.
           La captura vivia en un modal de 62rem que tapaba la bandeja entera. O.1 reserva
           el modal para "confirmar/crear CORTO" y manda split para el documento extenso;
           datos densos 8 agrega que un create multi-seccion complejo va a superficie propia.
           Este formulario tiene documento, contraparte, cuenta, concepto, glosa, monto, la
           reja de 16 denominaciones y el panel del cajero: de corto no tiene nada.
           Ahora la lista queda a la izquierda y lo elegido al lado, sin perder la cola. -->
      <!-- ⭐⭐ [CG.60] LOS DOS APARTADOS, con su contenido.

           Edgar, sobre el tablero: "lo primero que debe ver el usuario es que ingreso o egreso
           va a arquear, luego el arqueo". [CG.59] dejo el esqueleto -- 100vh, la jornada
           plegada arriba -- y aca entra lo que va adentro.

           Lo que CAMBIA de fondo: el arqueo deja de ser una columna de un formulario dentro de
           un panel lateral y pasa a ser un APARTADO, con la mitad de la pantalla reservada
           SIEMPRE. Antes su ancho dependia de .cg-split-capturando y, antes de eso, de que el
           panel midiera mas de 39rem -- una condicion que [CG.49] descubrio que era inalcanzable
           por construccion. Media pantalla fija no se puede romper asi.

           ⚠️ .cg-grid y .cg-col se RETIRAN: sus dos columnas SON estos dos apartados. El
           container-type que [CG.57] tuvo que poner en .cg-col vive ahora en .cg-ap-cuerpo, que
           es la caja que la reja mide de verdad. -->
      <!-- Una sola columna, siempre: la lista de movimientos ocupa la pantalla entera y el
           arqueo entra por el cajon de la izquierda, no robandole la mitad. -->
      <div class="cg-split">

        <!-- 1 - QUE VAS A ARQUEAR -->
        <section class="cg-ap cg-ap-que" aria-labelledby="cg-ap1-t">
          <div class="cg-ap-head">
            <span class="cg-ap-n" aria-hidden="true">1</span>
            <h2 class="cg-ap-t" id="cg-ap1-t">Qué vas a arquear</h2>
            <!-- ⭐ El rótulo CAMBIA con el estado, porque ahora carga la guía que el vacío del
                 apartado 2 daba antes de retirarse. Sin movimiento elegido dice qué hacer; con
                 uno elegido dice qué es lo que se está por cuadrar. Un rótulo fijo acá dejaría
                 a la persona sin saber que la cola es clicable. -->
            <span class="cg-ap-hint">
              @if (capturaAbierta()) { el movimiento del ERP que estás por cuadrar }
              @else { elige uno de la cola y el arqueo se abre al lado }
            </span>
          </div>

          <div class="cg-ap-cuerpo">
            <!-- ⭐⭐ LA TIRA ANSWER-FIRST (regla Q.1): primero el VEREDICTO, después la rejilla.
                 La pantalla abría con la cola cruda, así que lo primero que se veía eran N filas
                 y había que sumarlas con la vista para saber si el día iba bien.
                 ⚠️ Es app-metric-strip, la pieza SIN caja del repertorio — no tarjetas de KPI:
                 cuatro cajas de 120px no agregan jerarquía, le quitan alto a la lista, que es el
                 trabajo. Y lo que no se pudo medir se DECLARA: totalPend en null no sale como
                 cero, sale como no_medido (ADR-056). -->
            <app-metric-strip class="cg-kpis-cola" [items]="kpisCola()"></app-metric-strip>

            <!-- ⛔ EL VACÍO GRANDE SE FUE. Decía "Nada elegido todavía · Elegí un movimiento de
                 la cola" en ~200px arriba de la cola misma — o sea que le explicaba a la persona
                 lo que estaba mirando, quitándole el espacio para mirarlo. Con el paso 1 a
                 pantalla completa eso es justo lo que no se puede gastar.
                 La guía no se perdió: vive en el rótulo del apartado, que cambia con el estado. -->
            @if (capturaAbierta()) {
            <div class="cg-detail">
            <div class="cg-captura cg-entra">
            <!-- ⭐ [CG.60] LA FICHA. El tablero la pone primero y grande, y tiene razon: el
                 arqueo CONTESTA una pregunta -- "cuanto dice el documento" -- y hasta ahora esa
                 pregunta vivia en un renglon gris de 11px al lado del titulo del panel. Contar
                 contra una cifra que no se lee es contar a ciegas del lado equivocado.
                 ⚠️ Sin documento anclado la ficha NO se calla ni dibuja un cero: dice que
                 el movimiento es libre, que es un hecho distinto de "el documento dice 0". -->
            <div class="cg-ficha">
              <div class="cg-ficha-top">
                <span class="cg-signo" [class.cg-signo-in]="f().tipo === 'ingreso'">
                  <i class="pi" [class.pi-arrow-down]="f().tipo === 'ingreso'"
                     [class.pi-arrow-up]="f().tipo !== 'ingreso'" aria-hidden="true"></i>
                  {{ f().tipo === 'ingreso' ? 'Entra a la caja' : 'Sale de la caja' }}
                </span>
                @if (cobroElegido(); as c) {
                  <span class="mono cg-ficha-doc">{{ c.doc_tipo }} {{ c.folio }}</span>
                } @else {
                  <span class="cg-ficha-doc fin-dim">sin documento del ERP</span>
                }
                <span class="cg-bandeja-sp"></span>
                <span class="mono cg-ficha-fecha">{{ dmy(f().fecha) }}</span>
                <p-button icon="pi pi-times" size="small" severity="secondary" [text]="true" [rounded]="true"
                          ariaLabel="Cerrar la captura y volver a la cola"
                          (onClick)="cerrarConFoco(capturaAbierta)"></p-button>
              </div>

              <h3 class="cg-ficha-nombre">{{ f().beneficiario || cobroElegido()?.entidad_code || 'Movimiento sin contraparte' }}</h3>

              <!-- El numero grande de ESTA mitad. El del arqueo es el OTRO lado de la misma
                   pregunta y vive en el apartado 2: nunca se ven los dos como titulo de lo mismo. -->
              <div class="cg-ficha-cifra">
                @if (cobroElegido(); as c) {
                  <strong class="mono cg-ficha-monto">{{ money(c.monto) }}</strong>
                  <span class="cg-ficha-pie">según el documento del ERP</span>
                } @else {
                  <strong class="mono cg-ficha-monto cg-ficha-libre">{{ money(f().monto) }}</strong>
                  <span class="cg-ficha-pie">lo que llevas contado — no hay documento contra qué cuadrar</span>
                }
              </div>
            </div>

            <div class="fin-form">
              <!-- ⭐⭐ [CG.94] Con documento, estos tres los FIJA el documento: ni se preguntan.
                   El tipo ya lo dice el chip "Sale de la caja", la fecha esta en el encabezado y la
                   sucursal es la del folio. Ver fichaSolaLectura. -->
              @if (!fichaSolaLectura()) {
              <div class="fin-row">
                <!-- Los <label> de este formulario NO tenían for= ni envolvían su control: un lector de
                     pantalla anunciaba TODA la captura de caja como campos sin nombre. -->
                <label for="cg-tipo">Tipo</label>
                <p-select inputId="cg-tipo" [options]="tiposCaptura" [ngModel]="f().tipo" optionLabel="label" optionValue="value"
                          (ngModelChange)="onTipo($event)"></p-select>
                <label for="cg-fecha">Fecha</label>
                <p-datepicker inputId="cg-fecha" [ngModel]="fechaD(f().fecha)"
                              (onSelect)="setF('fecha', claveDe($event))"
                              dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" />
                <!-- La sucursal era TEXTO LIBRE en una captura contable: teclear "0" devolvía un catálogo
                     de conceptos vacío sin decir por qué. Sale del mismo censo que ya mide la cobertura. -->
                <label for="cg-suc">Sucursal</label>
                <p-select inputId="cg-suc" [options]="opcionesSucursal()" [ngModel]="f().sucursal" optionLabel="label" optionValue="value"
                          (ngModelChange)="onSucursal($event)" [ariaLabel]="'Sucursal'"></p-select>
              </div>
              }

              <!-- ⭐ CG.19 Capa 1 — el movimiento se ELIGE, no se teclea. El monto viaja de Kepler.
                   ⛔ Acá decía "Sólo para ingresos: un gasto o un depósito no tienen un cobro del ERP
                   detrás", y CG.21 REFUTÓ eso con medición: el egreso de la caja cuadra al 100% contra
                   Kepler en 5 meses cerrados ($44,108,221.92 vs $44,123,427.09). El servicio ya pedía
                   los dos signos ("tipo: ... === 'gasto' ? 'gasto' : 'ingreso'") y la plantilla lo
                   escondía, así que para un GASTO no había forma de anclar al documento: había que
                   retipearlo entero a mano. El depósito sí queda fuera, y con motivo: es una salida a
                   banco, no un pago, y su pierna doble ("N-A-26") está declarada fuera de alcance. -->
              @if (f().tipo === 'ingreso' || f().tipo === 'gasto') {
                <!-- ⛔ [CG.94] El selector de documento NO se pinta cuando ya hay uno elegido: seria
                     ofrecer elegir lo que ya esta elegido, y el encabezado lo muestra con su ✕ para
                     soltarlo. Era la peor de las siete repeticiones -- un buscador cuyo unico
                     contenido posible ya estaba arriba, dos centimetros mas alto. -->
                @if (!fichaSolaLectura()) {
                <div class="fin-row fin-row-col">
                  <label for="cg-cobro">{{ f().tipo === 'gasto' ? 'Comprobante contra un pago de Kepler' : 'Entrega contra un cobro de Kepler' }}</label>
                  <p-autocomplete inputId="cg-cobro" [(ngModel)]="cobroSel" [suggestions]="cobros()"
                                  (completeMethod)="buscarCobros($event)" (onSelect)="elegirCobro($event)"
                                  (onClear)="soltarCobro()" optionLabel="label" [delay]="250"
                                  [minQueryLength]="0" [showClear]="true" appendTo="body" class="cg-full"
                                  placeholder="Busca por cliente, folio o ruta — o déjalo vacío y captura a mano"></p-autocomplete>
                  @if (cobroElegido(); as c) {
                    <!-- ⛔ [CG.54] Acá vivia el eco del documento: "Kepler: X-D-26 0022707 ·
                         BENEFICIARIO · $144.00 · CAJA GENERAL. El monto sale del arqueo, no del
                         documento." Dos renglones para repetir lo que ya estaba en otros cuatro
                         lugares del MISMO panel. Medido: el importe del documento aparecia CINCO
                         veces (encabezado, esta pista, el pie del credito, la cabecera del arqueo y
                         el bloque del numero). Quedan DOS, y cada una tiene su oficio: el encabezado
                         dice CUAL documento es, y el bloque del numero dice contra CUANTO cuadra.
                         ⛔ Y la pista de la diferencia tambien se fue de aca: la cifra, el veredicto
                         y la consecuencia viajan juntos en el bloque del numero, que es donde esta
                         lo contado. Decir "contaste 1100 vs documento 1060" al lado del selector de
                         documento era mandar a la persona a buscar el dato al otro extremo. -->
                  } @else {
                    <small class="fin-dim">Sin documento: captura manual (marcada así en la cobertura). Si ya está en Kepler, elígelo y el importe lo pone el documento.</small>
                  }
                </div>
                }

                <!-- CS.3 — La segunda fuente: la caja fuerte (CAOS). Al elegir un movimiento, el arqueo de
                     abajo se PRECARGA con el conteo de la máquina; lo que falte se cuenta a mano.

                     ⛔⛔ [CG.111] SÓLO SI NO HAY DOCUMENTO, y eso es una corrección, no un detalle.
                     Este campo llama a tomarMovimientoCaos, que hace cobroElegido.set(null):
                     es EXCLUYENTE. Estaba visible también con un documento ya elegido, así que
                     usarlo ahí BORRABA el documento en silencio -- se iban fecha, sucursal,
                     beneficiario y la cuenta de la póliza, y origen_tipo pasaba de
                     pago_proveedor a caos, o sea que el movimiento dejaba de estar anclado al
                     ERP. Medido en prod: 11 de 30 movimientos quedaron con origen caos contra
                     16 anclados al documento.

                     ⭐ Con documento, el camino correcto es OTRO y ya existe: caosVinculados
                     (más abajo, "retiros del cajero que financiaron este gasto"), que CONSERVA el
                     ancla y adjunta las dispensaciones. Es el que dejó las 6 filas vivas en
                     finance.caos_cash_links. Edgar: "a lo mucho enlazarlo con un movimiento de
                     caos" -- enlazar, no reemplazar. -->
                @if (!cobroElegido()) {
                <div class="fin-row fin-row-col">
                  <label for="cg-caos">…o traer de la caja fuerte (CAOS)</label>
                  <p-autocomplete inputId="cg-caos" [(ngModel)]="caosSel" [suggestions]="caosOpciones()"
                                  (completeMethod)="buscarCaos($event)" (onSelect)="elegirCaos($event)"
                                  (onClear)="soltarCaos()" optionLabel="label" [delay]="250"
                                  [minQueryLength]="0" [showClear]="true" appendTo="body" class="cg-full"
                                  placeholder="Depósito o dispensación de la máquina — el arqueo se precarga solo"></p-autocomplete>
                  @if (caosElegido(); as m) {
                    <small class="fin-hint-ok">
                      De la caja fuerte: {{ m.type_label }} #{{ m.external_id }} ·
                      {{ m.user_external }} · {{ money(m.monto) }}@if (m.ref) { · «{{ m.ref }}»}.
                      El arqueo se precargó con el conteo de la máquina; la morralla y lo que falte, a mano.
                    </small>
                    <!-- [CGA-A.10b] Si venía de un documento anclado, su LLAVE se conserva y se
                         DICE. Antes se perdía en silencio y sólo quedaba su texto en la glosa,
                         con lo que la cola no podía saber de qué sucursal era. -->
                    @if (docDeclarado(); as ref) {
                      <small class="fin-hint-ok">Declara pagar el documento <strong>{{ ref }}</strong>.</small>
                    }
                  }
                </div>
                }
              }

              <!-- CG.20 - Lo que esta persona repite se ofrece, no se reescribe. Medido: 57% de los
                   gastos cae en un par (cuenta, concepto) ya usado 3+ veces, y Krmn tecleo 61 en una
                   hora. Un toque llena cuenta + concepto + beneficiario; solo queda el importe.
                   El gasto NO se deriva de Kepler, asi que esto baja clics pero no vuelve auditable
                   el dato -- y por eso el bloque lo dice. -->
              <!-- [CG.94] Los atajos de cuenta no aplican con documento: su cuenta ya salio de la
                   poliza, y ofrecer un atajo para pisarla es invitar a desalinearla.
                   ⭐ [CG.97] Esa regla decia "con documento" y la guarda preguntaba por el TIPO
                   ('gasto'), que era su proxy: el gasto es el unico que no se deriva de Kepler.
                   El proxy costaba los otros dos tipos enteros -- un ingreso o un deposito
                   capturado a mano tampoco tiene poliza y se quedaba sin atajo. Ahora la guarda
                   dice la regla: se ofrece cuando NO hay documento elegido, sea cual sea el tipo.
                   El universo de chips lo acota el servidor, que ya filtra por (tipo, sucursal,
                   persona) -- aca solo se decide si la oferta corresponde. -->
              @if (!fichaSolaLectura() && !cobroElegido() && frecuentes().length) {
                <div class="fin-row fin-row-col">
                  <label id="cg-frec-lbl">Lo que más repites en {{ f().sucursal | sucursal }}</label>
                  <!-- ⭐ [CG.98] role="toolbar" + roving tabindex (installToolbarNav, global en
                       main.ts). Son ACCIONES, no una elección: por eso toolbar y no radiogroup
                       -- un lector de pantalla anunciaría "no seleccionado" sobre un botón que
                       llena un formulario, y la flecha NO activa (activar al mover pisaría la
                       captura una vez por tecla).
                       Lo que arregla: con diez chips, el tabulador paraba diez veces antes del
                       siguiente campo (D.4a). Ahora se entra con UN tabulador y se recorre con
                       flechas, que es lo que vuelve usable un atajo pensado para no usar el
                       mouse en una pantalla de captura (§O.3 keyboard-first). -->
                  <div class="cg-chips" role="toolbar" aria-labelledby="cg-frec-lbl">
                    @for (fr of frecuentes(); track fr.rango) {
                      <!-- El conteo va en el "badge" del propio p-button, no en un <span> con clase
                           propia: asi el par fondo/texto del contador lo calibra el tema y flipea solo
                           en oscuro, que es justo lo que esta pantalla venia declarando a mano. -->
                      <p-button [label]="fr.glosa || fr.kepler_concepto" [badge]="fr.usos + ''"
                                badgeSeverity="secondary" size="small" severity="secondary"
                                [outlined]="true" (onClick)="usarFrecuente(fr)"
                                [title]="fr.kepler_cuenta + ' / ' + fr.kepler_concepto + ' — usado ' + fr.usos + ' veces'"></p-button>
                    }
                  </div>
                  <!-- [CG.62] El atajo, ESCRITO. D.5: "un atajo que nadie sabe que existe no
                       existe" -- y la navegación por flechas llevaba varios commits funcionando
                       en la reja sin que nada la anunciara. Las teclas van en <kbd>. -->
                  <small class="fin-dim">Llenan cuenta, concepto y beneficiario. El importe siempre se escribe.
                    <span class="cg-ap-atajo">Se recorren con <kbd>←</kbd><kbd>→</kbd> y se usan con <kbd>Enter</kbd>.</span>
                  </small>
                </div>
              }

              <!-- [CG.94] El beneficiario con documento ya es el TITULO de la ficha, arriba. -->
              @if (!fichaSolaLectura()) {
              <div class="fin-row">
                <label for="cg-benef">Beneficiario</label>
                <input pInputText id="cg-benef" [ngModel]="f().beneficiario" (ngModelChange)="setF('beneficiario', $event)"
                       (blur)="pedirPropuesta()" class="cg-full" [readonly]="!!cobroElegido()" />
              </div>
              }

              <!-- ⭐ [CG.94] LA CUENTA, EN MODO FICHA: un renglon que la DICE, no un buscador que la
                   pregunta. La cuenta sale de la poliza del propio documento y es autoritativa; el
                   buscador la ofrecia editable y con el dropdown abierto, que invita a cambiarla. -->
              @if (fichaSolaLectura()) {
                <div class="fin-row fin-row-col cg-ficha-cta">
                  <span class="fin-dim">Cuenta de Kepler</span>
                  <strong class="mono">{{ f().kepler_cuenta || '—' }} / {{ f().kepler_concepto || '—' }}</strong>
                  <small [class]="etiquetaConcepto().tono === 'propuesto' ? 'fin-hint-ok' : 'fin-hint-warn'">
                    {{ etiquetaConcepto().texto }}
                  </small>
                  <!-- La puerta de salida: Kepler se equivoca, y una captura que no se puede
                       corregir obliga a cancelar y rehacer. Abre el formulario completo. -->
                  <p-button label="Corregir" icon="pi pi-pencil" size="small"
                            severity="secondary" [text]="true"
                            (onClick)="corrigiendo.set(true)"></p-button>
                </div>
              } @else {
              <div class="fin-row fin-row-col">
                <label for="cg-concepto">Cuenta y concepto de Kepler</label>
                <p-autocomplete inputId="cg-concepto" [(ngModel)]="conceptoSel" [suggestions]="conceptos()"
                                (completeMethod)="buscarConceptos($event)" (onSelect)="elegirConcepto($event)"
                                optionLabel="label" [delay]="250" [minQueryLength]="cuentaFuenteDoc() ? 0 : 2"
                                [dropdown]="!!cuentaFuenteDoc()" [showClear]="true"
                                placeholder="Busca por nombre, cuenta o código" appendTo="body"
                                class="cg-full"></p-autocomplete>
                <small [class]="etiquetaConcepto().tono === 'propuesto' ? 'fin-hint-ok' : 'fin-hint-warn'">
                  {{ etiquetaConcepto().texto }}
                </small>
                @if (cuentaFuenteDoc()) {
                  <p-button label="Corregir la cuenta" icon="pi pi-pencil" size="small"
                            severity="secondary" [text]="true" (onClick)="corregirCuentaDoc()"></p-button>
                }
              </div>
              }

              <!-- ⭐⭐ [CG.182] EL CORTE DE CAJA, QUE ES LO QUE LA PERSONA TIENE EN LA MANO.
                   Medido en prod: la unica declaracion humana de donde salio un deposito es texto
                   libre -- 708 referencias distintas en 749 depositos, cero parseables, la misma
                   ruta escrita "ruta 21 09 26", "rd 21 04/07", "ruta 21 13 10 26". Y se ve por
                   plaza: en la 00, 31 de 34 cobros declaran ruta y fecha; en Morelia, 0 de 16.
                   Elegir el corte ESCRIBE la glosa con su caja, su plaza y su fecha. No ancla
                   nada: la liga estructural es la version siguiente y vive en el servidor. Lo que
                   entrega hoy es que la declaracion salga estructurada del lugar donde se hace.
                   ⛔ Solo en el INGRESO y sin documento: con un documento de Kepler la glosa ya
                   sale de el, y en un gasto o un deposito al banco no hay corte que declarar. -->
              @if (!fichaSolaLectura() && f().tipo === 'ingreso' && !cobroElegido()) {
                <div class="fin-row fin-row-col">
                  <label for="cg-corte">¿De qué corte de caja salió?</label>
                  <p-autocomplete inputId="cg-corte" [(ngModel)]="cortesSel" [suggestions]="cortesOpciones()"
                                  (completeMethod)="buscarCortes($event)" (onSelect)="usarCorte($event)"
                                  (onClear)="soltarCorte()" optionLabel="label" [delay]="250"
                                  [minQueryLength]="0" [dropdown]="true" [showClear]="true"
                                  appendTo="body" class="cg-full"
                                  placeholder="Últimos 7 días de esta sucursal — busca por caja, plaza o fecha"></p-autocomplete>
                  <!-- ⛔ Cuatro estados. "Vacio" y "no se pudo leer" son ausencias distintas, y la
                       de hoy tiene dueno distinto: el rezago de carga no lo resuelve quien captura. -->
                  @if (cortesAviso(); as av) {
                    <small class="fin-dim">{{ av }}</small>
                  } @else {
                    <small class="fin-dim">Al elegirlo se escribe el «Qué pasó» con su caja, su plaza y su
                      fecha. El importe no se copia: se guarda lo que contaste.</small>
                  }
                </div>
              }

              <!-- [CG.94] La glosa con documento se arma del documento (X-D-26 0023028 · …).
                   Preguntarla es pedir que alguien reescriba lo que ya quedo escrito. -->
              @if (!fichaSolaLectura()) {
              <div class="fin-row">
                <label for="cg-glosa">Qué pasó</label>
                <input pInputText id="cg-glosa" [ngModel]="f().glosa" (ngModelChange)="onGlosa($event)" class="cg-full"
                       (keydown.enter)="guardar()"
                       placeholder="Cuenta qué pasó — esto NO es el concepto contable" />
              </div>
              }


              <!-- ⛔ ACÁ ESTABA EL BLOQUEO DE TODO EL MÓDULO, y no era falta de trabajo: medido el
                   2026-09-22, "caja_classify_rules" tenía 0 filas en prod y NO EXISTÍA NINGUNA PANTALLA
                   para cargarlas. La bandeja decía "0 de 8 se confirman · el resto necesita que su
                   cuenta esté declarada" y no había por dónde declararla. Se declara acá, que es donde
                   la persona tiene el beneficiario delante y acaba de elegir la cuenta. -->
              <!-- ⛔ [CG.94] Con documento NO se ofrece declarar regla, y no es cosmetico: la cuenta
                   de este movimiento salio de SU poliza, asi que el proximo movimiento de ese mismo
                   beneficiario tambien la va a traer. Declarar una regla aca es fijar a mano algo que
                   el ERP ya resuelve por si solo -- y si el beneficiario usa mas de una cuenta, la
                   regla lo clasifica MAL (es lo que CG.88 frena del lado del servidor). -->
              @if (!fichaSolaLectura() && puedeDeclararRegla()) {
                <label class="fin-row cg-declara">
                  <p-checkbox [binary]="true" [ngModel]="declararRegla()"
                              (ngModelChange)="declararRegla.set($event)"></p-checkbox>
                  <span>
                    De ahora en adelante, <strong>{{ f().beneficiario }}</strong> va a
                    <span class="mono">{{ f().kepler_cuenta }} / {{ f().kepler_concepto }}</span>.
                    <small class="fin-dim d-block">
                      Los próximos movimientos de este beneficiario se van a poder confirmar de un clic
                      desde la bandeja, sin volver a elegir la cuenta.
                    </small>
                  </span>
                </label>
              }

              <!--
                [CG.160] El motivo de "sin documento". El servidor lo exige desde [CG.124] y la
                pantalla no lo tenia: quien captura cobranza de ruta chocaba con un 400 que le
                explicaba que hacer y no le daba donde. Aparece SOLO cuando no hay documento ni
                movimiento del cajero elegido, que es cuando el servidor lo pide.
              -->
              @if (!cobroElegido() && !caosElegido()) {
                <!-- [CGP-V.11] Era fin-field/fin-label/fin-input, que no existen en ningun lado, sobre
                     un textarea crudo: se pintaba sin estilo. Ahora el patron de la pantalla. -->
                <div class="fin-row fin-row-col cg-sin-doc">
                  <label for="cg-sin-doc">Por qué este movimiento no tiene documento</label>
                  <textarea
                    pTextarea id="cg-sin-doc"
                    rows="2"
                    class="cg-full"
                    [ngModel]="sinDocumentoMotivo()"
                    (ngModelChange)="sinDocumentoMotivo.set($event)"
                    [ngModelOptions]="{ standalone: true }"
                    placeholder="Ej: cobranza de la ruta 501 que nadie registró en Kepler"
                    maxlength="300"></textarea>
                  <small class="fin-dim">
                    No está enlazado a Kepler ni al cajero, así que hay que decir por qué.
                    Un movimiento sin origen y sin motivo no se puede auditar después.
                  </small>
                </div>
              }

              @if (bloqueos().length) {
                <ul class="fin-blocks">
                  @for (b of bloqueos(); track b) { <li>{{ textoBloqueo(b) }}</li> }
                </ul>
              }
            </div>
            <!-- ⛔⛔ [CG.62] ACA ESTABAN "Cancelar" Y "Guardar", Y SE MUDARON AL PIE DEL ARQUEO.
                 Edgar: "el boton de guardar se debe mostrar abajo de arqueo. para solo pasar del
                 arqueo a guardar".
                 Tiene razon y el motivo es de ORDEN DE TRABAJO: lo ultimo que se hace antes de
                 guardar es contar, y contar pasa en el apartado 2. Con Guardar aca, terminar el
                 conteo exigia cruzar la pantalla de vuelta -- con el mouse y, peor, con el
                 teclado. Ahora la ultima pieza contada y el boton son vecinos.
                 ⚠️ Lo que [CG.60] decia aca ("el pie va pegado a la ficha") queda SUPERADO: era
                 cierto contra el defecto de entonces (un Guardar flotando sobre la cola), pero
                 resolvia el lugar equivocado. -->
            <div class="cg-detail-pie cg-pie-cancelar">
            <p-button label="Cancelar" severity="secondary" size="small" [text]="true"
                      (onClick)="cerrarConFoco(capturaAbierta)"></p-button>
            </div>
            </div>
            </div>
          }

            <!-- LA COLA. Es el MEDIO para elegir el siguiente, no el protagonista: por eso vive
                 dentro del apartado 1 y debajo de la ficha, no al lado como seccion propia. El
                 tablero la pone igual. -->
      <section class="cg-bandeja">
        <header class="cg-bandeja-head">
          <!-- [CG.60] h3: el h2 de esta seccion es el del apartado que la contiene. -->
          <h3 class="fin-h2">La cola &mdash; movimientos por confirmar</h3>
          <!-- ⛔ [CG.45] Acá iba UNA frase gris con CINCO hechos pegados con puntos medios:
               "N de las M que se ven se confirman sin elegir nada · el resto necesita que su
               cuenta esté declarada · últimos 45 días · hace 3 min". Cinco cosas de distinto
               tipo, todas al mismo peso y al mismo color, o sea cero jerarquía (Q.5).
               Ahora: la cifra accionable primero y con peso, el resto subordinado, y la EDAD
               del dato en su píldora -- que es la que se pone ámbar sola. Como prosa gris,
               "hace 3 min" y "hace 9 horas" se veían idénticos. -->
          <!-- ⭐ LA COLA LA MUEVE EL SOCKET, ASÍ QUE SU CIFRA SE ANUNCIA. El canal change$ recarga la
               bandeja sin que nadie toque nada: entran movimientos nuevos mientras la persona está
               contando efectivo del otro lado de la pantalla. Sin región viva eso es invisible para
               un lector de pantalla, y con él la única forma de enterarse es volver a pasar por acá.

               Va SOBRE el cg-lead que ya existe, no en un sr-only aparte: el texto del span ya
               es la frase completa ("18 de 19 se confirman de un clic"), así que duplicarlo sólo
               lograría que quien navega hasta acá lo escuche dos veces.

               ⚠️ No hace ruido en el repaso de 60 s: polite con texto IDÉNTICO no se re-anuncia
               —la AT compara el contenido—, así que una recarga que no cambió la cuenta es muda.
               Y atomic porque "18" suelto, sin "de 19", no es un dato. -->
          <span class="cg-lead" aria-live="polite" aria-atomic="true">{{ confirmables() }} <span class="cg-lead-sub">de {{ pendientes().length }} se confirman de un clic</span></span>
          <span class="fin-dim">{{ textoAlcance() }}</span>
          <!-- §9 + inventario: la frescura es un COMPONENTE, no una frase. measures="data" es
               honesto: datos_al lo manda el servidor, no es el reloj del navegador. -->
          @if (datosAl(); as al) {
            <app-freshness-pill measures="data" [since]="al" label="Kepler" />
          } @else {
            <span class="fin-hint-warn">frescura sin medir</span>
          }
          <span class="cg-bandeja-sp"></span>
          <!-- Regla P: la jerga de esta pantalla (corte, arqueo, fondo, veredicto, contracuenta,
               ventana, rezago) se explica desde el diccionario versionado, sin salir de acá. -->
          <app-context-help topic="caja-general" />
        </header>

        <!-- ⛔ [CG.47] Los NUEVE controles vivían en el mismo contenedor flex que el título, con un
             espaciador en medio. Al envolver, el reparto quedaba al azar: medido en la captura
             real, la cabecera salía en TRES renglones y "Confirmar" -la acción de la sección-
             terminaba a media fila, ni alineada a la derecha ni junto a su lista.
             Dos renglones DELIBERADOS: arriba quién es y qué tan fresco; abajo con qué se acota,
             y la acción al extremo derecho, que es donde se la busca. -->
        <div class="cg-bandeja-controles">
          <!-- [CGA-A.43] Aca vivia el selector de ventana (Desde ayer / La jornada / 7 / 45 dias / Todo).
               Se quito: la cola arranca en el primer corte del libro y desde ahi es exacta. -->
          <!-- Tres valores excluyentes = control segmentado, no un desplegable: se ve el estado
               actual y las dos alternativas sin abrir nada. Es el patrón canónico del repertorio. -->
          <app-segmented [options]="opcionesSigno" [value]="signoBandeja()"
                         (valueChange)="setSigno($any($event))" ariaLabel="Signo" />
          <!-- ⭐ [CGA11Y-O3b] LA TIRA DE ACCESOS RAPIDOS, con su conteo.
               Se pinta SOLO si el servidor mando los grupos: sin medicion no hay tira, en vez de
               una tira de ceros que afirma que no hay trabajo (ADR-056). Por eso el @if mira el
               largo de las opciones, que es null-safe, y no un booleano aparte que se desincronice.
               El teclado lo da el propio control: UNA parada de Tab y las flechas mueven. -->
          @if (opcionesGrupo().length) {
            <app-segmented [options]="opcionesGrupo()" [value]="grupoActivo()"
                           (valueChange)="setGrupo($any($event))"
                           ariaLabel="Grupo de movimientos" />
          }
          <p-select [options]="opcionesCaja()" [ngModel]="cajaActiva()" optionLabel="label" optionValue="value"
                    (ngModelChange)="setCaja($event)" class="cg-sel" [ariaLabel]="'Caja'"></p-select>
          <!-- CS.3.9 — El buscador universal es de «por confirmar»: acá se busca el movimiento que se
               va a capturar (folio de Kepler, concepto, beneficiario, doc). El libro tiene el suyo.
               ⭐ [CG.116] Y el IMPORTE, que es lo que el papel en la mano trae grande. Se nombra
               primero en el rótulo porque es el caso nuevo: una funcion que no se anuncia no
               existe (D.5), y el buscador no tiene forma de insinuarla sola. -->
          <input pInputText [(ngModel)]="searchPend" (keyup.enter)="cargarPendientes()" class="cg-sel cg-buscar"
                 placeholder="Buscar: importe, folio Kepler, concepto, beneficiario…"
                 aria-label="Buscar en por confirmar por importe, folio de Kepler, concepto o beneficiario" />
          <span class="cg-bandeja-sp"></span>
          <!-- [CG.56] "Marcar todas" vivia como una casilla en el encabezado de la columna. Al
               retirarse la columna entera, una casilla suelta en un th sin casillas debajo no
               significa nada: la accion se muda a la barra, al lado de la accion que habilita, y
               DICE CUANTAS son -- que es el dato que la casilla nunca pudo dar. -->
          @if (confirmables(); as n) {
            @if (n > 0) {
              <p-button [label]="todasMarcadas() ? 'Quitar la marca' : 'Marcar las ' + n"
                        [icon]="todasMarcadas() ? 'pi pi-times' : 'pi pi-check-square'"
                        size="small" severity="secondary" [text]="true"
                        (onClick)="marcarTodas(!todasMarcadas())"></p-button>
            }
          }
          <!-- ⛔ [CG.47] "Confirmar 0" se pintaba en --action estando APAGADO: un boton de marca,
               grande y naranja, que no hace nada y ademas publica un cero. El color de marca
               significa "apreta aca"; en el estado en el que arranca la pantalla -sin nada
               marcado- no hay donde apretar. Con algo marcado SI es la accion obvia de la
               bandeja y recupera el naranja, con su cuenta. -->
          @if (puedeGestionar()) {
            <p-button [label]="marcadas().length ? 'Confirmar ' + marcadas().length : 'Confirmar'"
                      icon="pi pi-check" size="small"
                      [severity]="marcadas().length ? undefined : 'secondary'"
                      [loading]="confirmando()"
                      [disabled]="!marcadas().length || confirmando()" (onClick)="confirmarLote()"></p-button>
          }
          <!-- ⭐ [CGA-LEG.9] EL RECORRIDO PRINCIPAL, ESCRITO. D.5: un atajo que nadie sabe que
               existe no existe -- y para quien cuenta con las manos ocupadas el atajo ES la
               interfaz. Medido el 2026-10-19: la plantilla tiene 23 bindings de teclado y solo
               5 teclas estaban anunciadas, todas dentro del arqueo. El bucle que la persona
               repite decenas de veces al dia -elegir, arquear, volver- no decia una palabra.

               ⛔ Se anuncia SOLO lo que el codigo responde, verificado uno por uno:
                 ← →    las dos tiras son app-segmented, que mueve con flechas (spec propia)
                 ↑ ↓    pSelectableRow en el <tr> de la cola: flechas, Home/End y UN stop de Tab
                 Enter  (keydown.enter)="abrirDeLaCola(p)" en esa misma fila
                 Esc    lo cierra app-side-peek y devuelve el foco (cerrarConFoco)
               NO se anuncia "/ buscar": el prototipo lo tenia, esta pantalla NO -- no hay
               ningun manejador global de "/". Un atajo escrito que no funciona es peor que
               ninguno: se prueba una vez, no pasa nada, y deja de creerse el resto del renglon.

               Va al final de la barra y no bajo el titulo: comparte renglon con lo que ya esta
               (O3 pide MENOS cosas sobre el pliegue, no mas), y en --fs-xs/--text-muted queda
               subordinado a los controles que acompaña. -->
          <span class="cg-ap-atajo cg-atajo-cola">
            <kbd>&larr;</kbd><kbd>&rarr;</kbd> acceso &middot;
            <kbd>&uarr;</kbd><kbd>&darr;</kbd> fila &middot;
            <kbd>Enter</kbd> arquear &middot;
            <kbd>Esc</kbd> volver
          </span>
        </div>

        <!-- El recibo del lote va ARRIBA de la lista y FUERA de ella. Estaba adentro, así que al
             confirmar el último lote la lista quedaba vacía, la sección se desmontaba y el
             "12 confirmadas por $X" desaparecía justo en el caso donde más importa leerlo. -->
        @if (resultado(); as r) {
          <p-message [severity]="r.rechazados || r.no_confirmables ? 'warn' : 'success'"
                     class="cg-full">{{ textoResultado(r) }}</p-message>
        }

        <!-- Lo marcado que sobrevivio a un refresh. Se DICE que se restauro y se puede tirar: una
             marca que reaparece sin avisar es trabajo que nadie recuerda haber hecho. -->
        @if (restaurado(); as b) {
          <p-message [severity]="b.marcadas ? 'info' : 'warn'" class="cg-full">
            {{ textoRestaurado(b) }}
            @if (b.marcadas) {
              <p-button label="Descartar" icon="pi pi-trash" size="small" severity="secondary"
                        [text]="true" (onClick)="descartarBorrador()"></p-button>
            }
          </p-message>
        }

        <app-load-state [loading]="cargandoPend()" [error]="errPend()"
                        [isEmpty]="!pendientes().length" [skeletonRows]="5"
                        errorTitle="No se pudo leer la bandeja"
                        emptyIcon="pi-check-circle"
                        emptyTitle="Nada por confirmar con este filtro"
                        [emptyHint]="pistaVacio()"
                        (retry)="cargarPendientes()">
          <!-- [CG.33] POR QUE no se pueden confirmar, agrupado y CONTADO, una sola vez.
               Repetir la misma frase en 85 filas no decia lo unico accionable: cuantas rutas hay
               que dar de alta. Aca se dice una vez y con su numero. -->
          <!-- [CG.37] Los motivos pasan de TRES RENGLONES a UNO. Cada uno ocupaba su propia
               linea porque llevaba su frase de ~70 caracteres al lado, y las tres juntas
               empujaban la primera fila por confirmar debajo del pliegue.

               Lo que SE VE siempre es lo accionable: el conteo y el motivo. La frase explica el
               motivo, se lee una vez y no cambia de un dia para el otro -- asi que se PLIEGA,
               que es el mismo patron que esta pantalla ya usa dos veces ("Ver el cuadre", "Que
               NO cubre este cuadre"). ⛔ Plegar NO es esconderla en un title: eso no se alcanza
               por teclado y DESIGN.md lo lista como antipatron de Operations. Es un boton. -->
          @if (motivosAgrupados().length) {
            <div class="cg-motivos-res">
              @for (g of motivosAgrupados(); track g.motivo) {
                <!-- PrimeNG-first (checklist 3): el conteo va en p-tag, no en un span con clase
                     propia. severity="warn" trae el color por TOKEN del tema (flipea solo en
                     dark) en vez de que lo declare esta pantalla.
                     Se PROYECTA el contenido en vez de usar [value] para poder marcar la cifra
                     como mono tabular (checklist 4) sin un ::ng-deep sobre el componente: el
                     doc permite ::ng-deep solo para vendor y como ultimo recurso. -->
                <p-tag severity="warn">
                  <span class="cg-motivos-n">{{ g.n }}</span>&nbsp;{{ g.motivo }}
                </p-tag>
              }
              @if (hayPorque()) {
                <p-button [label]="motivosAbiertos() ? 'Ocultar el porqué' : 'Qué significan'"
                          [icon]="motivosAbiertos() ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                          size="small" severity="secondary" [text]="true"
                          (onClick)="motivosAbiertos.set(!motivosAbiertos())"></p-button>
              }
            </div>
            @if (motivosAbiertos()) {
              <ul class="cg-motivos-por">
                @for (g of motivosAgrupados(); track g.motivo) {
                  @if (g.texto) { <li><strong>{{ g.motivo }}</strong> — {{ g.texto }}</li> }
                }
              </ul>
            }
          }
          <p class="sr-only">Movimientos de Kepler pendientes de confirmar en el libro de caja</p>
          <!-- [CG.50] D.7 — la bandeja se RECORRE con las flechas. Medido antes de tocarla: las 9
               tablas de esta pantalla tenian CERO pSelectableRow, asi que con 100 filas el teclado
               solo podia tabular (casilla, Abrir, casilla, Abrir...) = 200 paradas.
               pSelectableRow da ↑↓, Home/End, Enter/Space y roving tabindex (la tabla entera es UN
               stop), y la guarda global installRowNavGuard —ya instalada en main.ts— impide que le
               robe las teclas a los campos de la fila.
               ⚠️ La verdad de la seleccion sigue siendo la senal "seleccion": PrimeNG entra como
               DISPOSITIVO DE ENTRADA, no como segundo dueno del estado. Por eso [selection] va de
               una via y (selectionChange) escribe en la senal. -->
          <p-table [value]="pendientes()" size="small" class="cg-bandeja-tbl" dataKey="origen_ref"
                   selectionMode="single" [metaKeySelection]="false"
                   [selection]="filaEnCaptura()">
            <ng-template #header>
              <tr>
                <!-- ⛔ [CG.56] ACA VIVIA LA COLUMNA DE CASILLAS, y se retiro entera por decision de
                     Edgar: "no son necesarias".

                     El camino quedo UNO: la fila ES el control. pSelectableRow ([CG.50]) ya la hace
                     seleccionable con el clic, con Space y con las flechas, y PrimeNG le pone
                     aria-selected. La casilla era una segunda forma de hacer lo mismo, y encima
                     aparecia 44 veces para 23 acciones posibles ([CG.55]).

                     ⚠️ Lo que una casilla SI daba y una fila seleccionada no: el estado se ve de
                     un vistazo. Por eso la fila marcada lleva fondo propio y una barra en
                     --action a la izquierda (.cg-fila-marcada), que no depende del tema. -->
                <th scope="col" class="cg-th-marca"><span class="sr-only">Marcada</span></th>
                <th scope="col">Fecha</th>
                <th scope="col"><span class="sr-only">Entra o sale</span></th>
                <!-- ⭐ [CG.61] ACA HABIA DOS COLUMNAS MAS: "Documento" y "Cuenta". Con la cola
                     dentro del apartado 1 ([CG.60]) la tabla tiene MEDIA pantalla, y ocho columnas
                     ahi no se leen: check:dense-tables la marco en deuda por ancho ([UIM.2]).
                     El DOCUMENTO no se pierde -- baja a su fila, bajo la contraparte, que es donde
                     el tablero lo pone. La CUENTA si sale de la cola: cuando falta, la marca "sin
                     regla" ya lo dice, y cuando esta, es dato de clasificacion y vive en la ficha.
                     [CG.48] Y antes de eso vivia aca una columna "Contado" por renglon: era una
                     TERCERA forma de contar el mismo dinero, y la unica sin desglose. El conteo
                     va al arqueo -- de un movimiento en la ficha, de todo el dia en el corte. -->
                <th scope="col">Contraparte</th>
                <th scope="col" class="comm-num">Importe (ERP)</th>
                <th scope="col" class="cg-th-abrir"><span class="sr-only">Capturar a mano</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-p>
                <!-- ⭐⭐ [CG.64] EL CLIC ES NUESTRO, NO DE PrimeNG. Reportado por Edgar: "estoy
                     dando clic y no me despliega la informacion".

                     [CG.63] colgaba la accion principal de la pantalla de "(selectionChange)", o
                     sea del "handleRowClick" de p-table -- y ese metodo SE DESCARTA SOLO. Leido en
                     @primeuix/utils: no atiende el clic si el blanco (o su padre) es INPUT,
                     TEXTAREA, BUTTON o A, ni si hace "closest('.p-button, .p-checkbox,
                     .p-radiobutton')". La fila lleva componentes de PrimeNG adentro, asi que esa
                     lista es una superficie que no controlamos y que puede crecer con cada
                     version.

                     ⛔ La interaccion principal de una pantalla no se cuelga de la lista de
                     descarte de una libreria. El (click) va en el <tr>, es nuestro, y abre siempre.
                     pSelectableRow SE QUEDA -- da el recorrido con flechas, el roving tabindex y
                     el resalte (D.7) -- pero ya no decide si esto abre o no. -->
                <tr [class.cg-trabada]="!p.confirmable" [pSelectableRow]="p"
                    [class.cg-fila-marcada]="estaMarcada(p.origen_ref)"
                    [class.cg-fila-abierta]="p.origen_ref === cobroElegido()?.origen_ref"
                    (click)="abrirDeLaCola(p)" (keydown.enter)="abrirDeLaCola(p)">
                  <!-- [CG.56] La celda de la marca: una barra, no una casilla. Lo que se ve es el
                       ESTADO (marcada o no); el acto de marcar es la fila entera. -->
                  <td class="cg-td-marca">
                    @if (estaMarcada(p.origen_ref)) {
                      <i class="pi pi-check" [attr.aria-label]="'Marcada: ' + p.doc_tipo + ' ' + p.folio"></i>
                    }
                  </td>
                  <td>
                    {{ dmy(p.fecha_valor) }}
                    <!-- Un documento fechado ADELANTE del día de hoy casi siempre es un error de
                         captura en Kepler, no un hecho futuro. Medido el 2026-09-22: los 8 que
                         hay dicen en su propio concepto "30-01-2026", "28-01-2026", "21-01" -- son
                         gastos de ENERO con fecha de diciembre. Y como la bandeja ordena por fecha
                         desc, salen SIEMPRE primero. Se marcan para que nadie los confirme creyendo
                         que son de hoy. -->
                    @if (esFutura(p.fecha_valor)) {
                      <small class="fin-hint-warn d-block">fecha posterior a hoy — revisa el documento</small>
                    } @else if (diasPendiente(p.fecha_valor); as d) {
                      <!-- [CGA-A.49] La antigüedad, con el umbral de «Mi trabajo»: pasado, se pinta de aviso. -->
                      <small class="d-block" [class.fin-hint-warn]="d > UMBRAL_ATRASO" [class.fin-dim]="d <= UMBRAL_ATRASO">hace {{ d }} día{{ d === 1 ? '' : 's' }}</small>
                    }
                  </td>
                  <td class="ta-c">
                    <!-- role="img" no es adorno: un aria-label sobre un <i> sin rol NO se expone,
                         así que la única señal del signo para un lector de pantalla era ninguna. -->
                    <i role="img"
                       [class]="p.tipo === 'ingreso' ? 'pi pi-arrow-down cg-in' : 'pi pi-arrow-up cg-out'"
                       [attr.aria-label]="p.tipo === 'ingreso' ? 'Entra a la caja' : 'Sale de la caja'"
                       [attr.title]="p.tipo === 'ingreso' ? 'Entra a la caja' : 'Sale de la caja'"></i>
                  </td>
                  <td>
                    <span class="cg-fila-nom">{{ p.beneficiario || p.entidad_code || '—' }}</span>
                    <!-- ⭐ [CGA-A.15] DE QUÉ RUTA viene el cobro. Con nueve camionetas entregando,
                         la bandeja mostraba una pila de CONTADO + U-A-5 0000014 identicas y el
                         folio no desempata: es consecutivo POR UNIDAD, asi que se repite entre
                         rutas el mismo dia (la causa de GOTCHAS §86).
                         La ruta solo se pinta si la vista la AFIRMA. Cuando no la afirma NO se
                         inventa: se cae al concepto del ERP, que dice de donde viene con sus
                         propias palabras (VENTAS 16-10-2026 RV CANDY Y DON RAFA). Solo en las
                         filas cuya contraparte no dice nada -- CONTADO generico. -->
                    @if (procedencia(p); as proc) {
                      <small class="cg-fila-ruta">{{ proc }}</small>
                    }
                    <!-- [CG.33] La fila lleva una MARCA, no el parrafo. El texto entero se repetia
                         identico en cada renglon y convertia la tabla en un muro naranja donde el
                         aviso pesaba mas que el monto. El porque completo esta arriba (agrupado,
                         con su conteo) y aca en el title de la marca. -->
                    @if (!p.confirmable) {
                      <!-- PrimeNG-first (checklist 3): p-tag, no un <small> con clase propia.
                           Trae su color del TEMA (par fondo/texto ya calibrado, y flipea en dark),
                           que es justo lo que esta pantalla venia declarando a mano con --warn-fg
                           -- y ese, medido en vivo, daba 1.95 de contraste en light. -->
                      <!-- ⛔ [CG.47] Esto iba en severity="warn" (ámbar) y volvía a levantar el
                           muro naranja que [CG.33] había tirado. Medido en la captura: las 6
                           filas visibles llevan la MISMA marca ámbar, y arriba el contador ya
                           dice "99 beneficiario sin regla" — o sea el mismo hecho repetido 99
                           veces, al mismo peso y color que el único renglón accionable.
                           Una marca que aparece en el 100% de las filas no distingue nada.
                           Queda NEUTRA: la fila ya se atenúa y su casilla ya está apagada, así
                           que la señal no se pierde; el ámbar vuelve a significar algo porque
                           queda sólo donde hay que actuar (el contador agrupado). -->
                      <p-tag [value]="motivoCorto(p.motivo)" severity="secondary" class="cg-motivo-tag"></p-tag>
                    }
                    @if (p.caos_match; as cm) {
                      <small class="cg-caos-attach d-block" [class.cg-caos-alta]="cm.confianza === 'alta'">
                        ⇄ del cajero {{ cm.ref || 's/ref' }} {{ money(cm.monto) }}@if (p.monto - cm.monto > 0.5) { · retiene {{ money(p.monto - cm.monto) }} } · {{ cm.confianza }}
                      </small>
                    }
                    <!-- ⭐ [CG.61] El documento BAJA a su fila: era una columna propia y en media
                         pantalla no entraba. Acá abajo sigue siendo buscable con los ojos y no le
                         roba ancho a la contraparte, que es lo que se lee primero. -->
                    <small class="cg-fila-doc mono d-block">{{ p.doc_tipo }} {{ p.folio }}</small>
                  </td>
                  <td class="comm-num">{{ money(p.monto) }}</td>
                  <!-- ⭐ [CG.63] ACA VIVIA UN BOTON POR FILA, y se retira: la FILA es el boton.
                       Edgar: "no le estas dando visibilidad, ademas lo especificas como si fuera
                       algo secundario, es el boton principal de la interaccion. me gustaria que
                       al darle clic a todo el movimiento se despliegue el menu".
                       Tiene razon, y el arreglo NO era pintarlo mas fuerte: un boton de 2rem en
                       el borde derecho no podia ser el control principal de un renglon entero.
                       Queda el galon, que no es un boton -- es la senal de que esto abre. -->
                  <td class="cg-td-abrir" aria-hidden="true"><i class="pi pi-chevron-right"></i></td>
                </tr>
            </ng-template>
          </p-table>

          <!-- La lista viene TOPADA. Sin esto, un movimiento más allá del tope era invisible y
               nadie lo iba a confirmar nunca: el contador de arriba mentía sobre un conjunto
               recortado y el bloque de «fuera de ventana» sólo cubre lo anterior por FECHA. -->
          <!-- [CG.30.1] Con el total medido se dice CUANTAS faltan, no un "hay mas" sin tamano:
               "las primeras 100 de 1,875" ubica el esfuerzo; "hay mas" no dice si son 3 o 12,000. -->
          @if (truncada()) {
            <p class="fin-dim cg-rezago">
              Se muestran las primeras <strong>{{ pendientes().length }}</strong>
              @if (totalPend(); as t) { de <strong>{{ t.toLocaleString('es-MX') }}</strong> }
              de esta ventana. Acota por signo o por caja, o achica la ventana, para verlas todas.
            </p>
          }
        </app-load-state>

        <!-- Lo que la ventana deja fuera se DICE. Una bandeja acotada que no publica su corte
             se lee igual que una bandeja vacia, y aca el rezago es de 12 mil movimientos.
             Va FUERA del load-state a propósito: con la bandeja vacía es cuando más hay que
             poder leer que el trabajo está del otro lado del corte. -->
        @if (rezago(); as rz) {
          <p class="fin-dim cg-rezago">
            Quedan <strong>{{ rz.movimientos }}</strong> movimientos de Kepler anteriores al
            {{ ventanaSrv()?.desde ? dmy(ventanaSrv()!.desde!) : 'inicio de la cola' }}, por {{ money(rz.monto) }}. Son de la era
            Control (el Access), que ya los saldó: se revisan en Control (histórico), no aquí.
          </p>
        }
        @if (malFechados(); as mf) {
          <!-- ⛔ [CG.28] No es trabajo de caja: es un error de captura del ERP. Se dice cuantos son
               y que se arreglan ALLA, porque es lo unico que los saca de la cola. -->
          <small class="fin-hint-warn d-block cg-malfecha">
            {{ mf.movimientos }} documento(s) del ERP por {{ money(mf.monto) }} vienen fechados
            despues de hoy y quedan fuera de la lista. Se corrigen en Kepler; aca se actualizan solos.
          </small>
        }
      </section>

      <!-- CG — Lo que el BUSCADOR encuentra FUERA del efectivo que inferimos: documentos POR PAGAR,
           gastos (XA1001) y órdenes de entrada (XA2001). Aparecen SÓLO al buscar — la bandeja de
           arriba es la cola de efectivo, y un documento por pagar todavía no es un movimiento de
           caja. Reusa las clases de fila de la lista del cajero (mismos primitivos visuales). -->
          </div>
        </section>

      </div><!-- /cg-split -->

      <!-- ⭐⭐ 2 - EL ARQUEO, AHORA EN UN CAJON A LA IZQUIERDA. Pedido de Edgar el 2026-10-16:
           "usemos toda la pantalla para presentar los movimientos y desplegamos una barra lateral
           a la izquierda con el arqueo".

           Deja de ser una columna del split: la lista ocupa la pantalla SIEMPRE y el arqueo entra
           por encima cuando hay algo que contar. Se reusa app-side-peek -el organismo canonico de
           detalle (DESIGN.md regla #8)- en vez de escribir otro panel: ya resuelve foco al abrir,
           Esc, clic en el fondo, bloqueo de scroll y role=dialog, y lo montan 31 pantallas.

           ⚠️ IZQUIERDA y no derecha, que es el default: a la derecha el panel tapa la columna del
           IMPORTE -la cifra contra la que se esta contando- justo mientras se cuenta. A la
           izquierda tapa la fecha, que ya se leyo. La variante entro ADITIVA al organismo.

           ⚠️ CAMBIO DE CONDUCTA, declarado: el cajon es MODAL (backdrop + aria-modal), asi que
           con el arqueo abierto ya no se puede tocar otra fila de la cola sin cerrarlo. Antes si.
           Es como funcionan las 31 pantallas que montan este organismo, y el costo de salir es un
           Esc -- pero es un cambio, no un detalle.

           ⛔ SIN aboveModals: adentro hay p-select, p-autocomplete y se abre el p-dialog de
           confirmar. Esos nacen en 1000/1100 y con el cajon en 1200 quedarian TAPADOS; el propio
           organismo lo documenta. -->
      <!-- ⛔ [CG.114] 560 NO ALCANZABA, y se medía mal con la reja vacía. Con todos los importes
           en $0.00 la tabla colapsa a 223px y parece entrar; con un conteo real
           ($34,000.00) pide 250px contra los 210px que da media mitad de 560 -> 40px de
           desborde horizontal, justo en la pantalla donde se cuenta efectivo.
           MEDIDO 2026-10-19 con dos conteos cargados, buscando el primer ancho sin desborde:
               560 -> 40px y 12px     600 -> 20px y 0     640 -> 0 y 0     680 -> 0 y 0
           Va 680 y no 640: 640 da cero justo, y un importe de siete cifras suma ~18px y lo
           devuelve. ⚠️ El alto no se resiente -- medido, cuerpo sin desborde vertical. -->
      <!-- ⚠️ [CG.118] Vuelve a la DERECHA, que es el default del organismo. Lo que se pierde,
           dicho para que no se redescubra: el cajon tapa la columna del IMPORTE de la cola, que
           es la cifra con la que se reconoce la fila. No es grave porque el importe del
           movimiento elegido se repite DENTRO del arqueo (la ficha y el renglon "documento"),
           asi que la cifra no desaparece de la pantalla -- cambia de lugar. -->
      <app-side-peek [width]="680"
                     [open]="capturaAbierta()"
                     (openChange)="$event ? null : cerrarConFoco(capturaAbierta)"
                     title="2 · El arqueo" subtitle="cuenta el efectivo, pieza por pieza">
          <!-- cg-ap-arqueo SE CONSERVA aunque ya no sea una <section> del split: es el ancla
               de seis candados que afirman cosas que siguen siendo ciertas -- que Guardar vive al
               pie del arqueo, que la reja no se mezcla con la clasificación, que el cajero se
               nombra una sola vez. Lo que cambió es DÓNDE vive el bloque, no qué contiene. -->
          <div class="cg-ap-cuerpo cg-ap-arqueo cg-arqueo-cajon">
          <!-- ⭐ [CG.62] EL ATAJO SE ESCRIBE, y casi se pierde en esta mudanza: vivia en la
               cabecera del apartado, que el cajon reemplaza por la suya. D.5 lo exige -- "un
               atajo que nadie sabe que existe no existe" -- y lo agarro su propio candado, no
               yo. Entra al cuerpo, que es lo que el cajon proyecta. -->
          <div class="cg-ap-head cg-arqueo-atajos">
            <span class="cg-bandeja-sp"></span>
            <span class="cg-ap-atajo"><kbd>&uarr;</kbd><kbd>&darr;</kbd> entre renglones &middot; <kbd>&darr;</kbd> al final, a Guardar</span>
          </div>
          @if (capturaAbierta()) {
            <div class="cg-captura cg-entra cg-entra-tras">

              <!-- ⛔ CG.23 - EL ARQUEO, QUE ANTES ERA OPCIONAL Y PLEGADO.
                   Esto era un "details" rotulado "Desglose por denominacion (opcional)" y, arriba, un
                   Monto que se TECLEABA suelto. O sea: el camino facil era registrar efectivo sin
                   contarlo, y cuando alguien si contaba quedaban DOS cifras que podian discrepar
                   ("arqueo_no_cuadra") y habia que conciliarlas a mano.
                   Decision de Edgar (2026-09-23): el desglose no es opcional.
                   Ahora se cuentan PIEZAS y nada mas. El importe de cada renglon y el monto del
                   movimiento se CALCULAN, y por eso van deshabilitados: un total tecleado al lado de
                   un conteo es una segunda version de la verdad, y la que gana no la decide nadie.
                   Con eso "arqueo_no_cuadra" ya no puede ocurrir por construccion.
                   Billetes de 500 a 20 (los que circulan en la caja); el metal entero va en Morralla,
                   que es lo unico editable de la columna de importes porque es un importe, no piezas. -->
              <!-- ⛔ [CG.70] ACA HABIA DOS BLOQUES Y LOS DOS SE ROTULABAN "Del cajero (CAOS)".
                   CS.3.4 traia el detector (buscar retiros) y CS.3.7 la mencion aparte del efectivo
                   ya contado, cada uno en SU recuadro, uno debajo del otro. Sus condiciones no son
                   excluyentes: en el camino normal -- anclar un cobro de Kepler, buscar, vincular un
                   retiro -- "no hay CAOS anclado" y "hay efectivo del cajero" son verdaderas A LA
                   VEZ (es decir: !caosElegido() y hayCajero() al mismo tiempo), asi que la
                   pantalla decia dos veces lo mismo y el capturista tenia que adivinar en que se
                   diferencian. Y la unica vez que NO se repetia era anclando un movimiento de CAOS,
                   el caso menos frecuente.
                   Es UN solo asunto: cuanto del efectivo lo puso la boveda. Un panel y un rotulo --
                   el monto cuando hay, el boton de buscar mientras se pueda, y debajo lo vinculado
                   con su desglose. El boton tambien deja de repetirlo ("¿salio del cajero? buscar
                   retiros" bajo un titulo que ya dice "Del cajero").
                   ⚠️ Cuando aparece NO cambio: el panel se muestra en los mismos estados en que se
                   mostraba alguno de los dos. Queda el recuadro NEUTRO de CS.3.7 ([CG.37] ya habia
                   retirado el naranja por competir con Guardar) y se va el punteado de CS.3.4. -->
              @if (hayCajero() || !caosElegido()) {
                <div class="fin-row fin-row-col cg-caja-aparte">
                  <div class="cg-caja-aparte-top">
                    <span class="cg-caja-ico mono" aria-hidden="true">⇄</span>
                    <strong>Del cajero (CAOS)</strong>
                    @if (hayCajero()) {
                      <strong class="mono cg-caos-monto">{{ money(aporteCajero()) }}</strong>
                      <span class="fin-dim">ya contado por la máquina</span>
                    } @else {
                      <span class="fin-dim">¿parte de esto salió de la bóveda?</span>
                    }
                    @if (!caosElegido()) {
                      <span class="cg-bandeja-sp"></span>
                      <!-- El "buscando…" deja de ser un rotulo que se cambia a mano: [loading] pone el
                           spinner Y desactiva el boton, que es lo que evita la segunda busqueda. -->
                      <p-button label="buscar retiros" icon="pi pi-search" size="small"
                                severity="secondary" [text]="true" [loading]="buscandoCajero()"
                                (onClick)="buscarEnCajero()"></p-button>
                    }
                  </div>
                  <!-- CS.3.4 — El detector: propone los retiros por patrones (mismo día + ref + monto +
                       aprendido); al vincular uno, su efectivo se suma al arqueo y el resto se cuenta a
                       mano. No se ofrece si la captura YA es un movimiento de CAOS: ahí el origen es el
                       movimiento entero, no un retiro suelto. -->
                  @if (caosSugeridos().length) {
                    <div class="cg-caos-list">
                      @for (c of caosSugeridos(); track c.external_id) {
                        <!-- Renglon rico: el contenido va PROYECTADO dentro del p-button (sin label).
                             El reparto horizontal lo hace un <span> NUESTRO, no el boton de PrimeNG:
                             asi la regla la agarra el CSS encapsulado y no hace falta ::ng-deep para
                             entrar al DOM del componente. El ancho completo lo da [fluid]. -->
                        <p-button severity="secondary" [text]="true" [fluid]="true"
                                  [ariaLabel]="'Agregar el retiro de ' + money(c.monto) + ' del cajero'"
                                  (onClick)="vincularCaos(c)">
                          <span class="cg-caos-row">
                            <span class="cg-caos-tag" [class.cg-caos-alta]="c.confianza === 'alta'">{{ c.confianza }}</span>
                            <span class="mono cg-caos-monto">{{ money(c.monto) }}</span>
                            <span class="fin-dim cg-caos-ref">{{ c.ref || 'sin ref' }} · {{ dmy(c.fecha_valor) }}</span>
                            <span class="cg-caos-go" aria-hidden="true">agregar <i class="pi pi-arrow-right"></i></span>
                          </span>
                        </p-button>
                      }
                    </div>
                  }
                  @if (caosVinculados().length) {
                    <div class="cg-chips">
                      @for (v of caosVinculados(); track v.external_id) {
                        <!-- Esto ES un chip removible: p-chip lo trae con su boton de quitar, su icono
                             y su foco. Antes era un <span> con un <button> adentro y una "✕" tecleada. -->
                        <p-chip [label]="money(v.monto) + ' · ' + (v.ref || 's/ref')" class="cg-caos-in"
                                [removable]="true" removeIcon="pi pi-times"
                                (onRemove)="desvincularCaos(v.external_id)"></p-chip>
                      }
                    </div>
                  }
                  <!-- CS.3.7 — Lo que la maquina ya conto NO entra en la reja de abajo: esa queda para la
                       DIFERENCIA (morralla, un faltante). Aca solo se muestra; nunca se re-teclea. -->
                  @if (hayCajero()) {
                    <div class="cg-caja-denoms fin-dim mono">
                      @for (d of denominacionesCajero(); track d.denom_key) {
                        <span>{{ d.piezas }}×{{ money(d.denominacion) }}</span>
                      }
                    </div>
                  }
                </div>
              }

              <!-- CS.3.13 — Venta a crédito: la parte que NO llega en efectivo (queda como saldo del cliente).
                   Se auto-rellena con el total cuando el cliente es de crédito; SIEMPRE editable. Se descuenta
                   del efectivo esperado. Sólo con un cobro anclado (que trae el cliente).

                   ⛔ [CG.54] Y sólo en un INGRESO. Acá colgaba de cobroElegido() a secas, y desde que
                   CG.21 dejó anclar también el egreso, un comprobante de GASTO mostraba un campo
                   "Venta a crédito" — que ahí no significa nada: una venta a crédito es, por
                   definición, parte de un cobro que no llegó en efectivo. El servidor no lo frena
                   (acepta venta_credito sin mirar el tipo), así que el freno va acá. -->
              @if (f().tipo === 'ingreso' && cobroElegido(); as c) {
                <div class="cg-credito">
                  <div class="cg-credito-head">
                    <label for="cg-vcredito">Venta a crédito</label>
                    @if (clienteCredito()) {
                      <span class="fin-dim">cliente de crédito — auto-rellenado, editable</span>
                    }
                  </div>
                  <input pInputText id="cg-vcredito" type="number" min="0" step="0.01" inputmode="decimal" class="cg-vcredito"
                         [ngModel]="ventaCreditoVista()" (ngModelChange)="setVentaCredito($event)" placeholder="0.00"
                         aria-label="Monto de la venta a crédito" />
                  <!-- La fórmula sólo cuando hay crédito: con 0 era "documento $144 − crédito $0.00 =
                       $144", o sea un renglón para publicar una resta de cero. -->
                  @if (ventaCredito() > 0) {
                    <small class="fin-dim">
                      Efectivo esperado = documento {{ money(c.monto) }} − crédito {{ money(ventaCredito()) }} =
                      <strong>{{ money(c.monto - ventaCredito()) }}</strong>
                    </small>
                  }
                </div>
              }

              <div class="cg-arqueo">
                <div class="cg-arqueo-head">
                  <strong>{{ hayCajero() ? 'La diferencia, a mano' : 'Cuenta el efectivo' }}</strong>
                  <!-- ⛔ [CG.54] Acá decía "El documento dice $144.00". Lo dice el bloque del número,
                       tres renglones abajo y PEGADO a la cifra con la que se compara, que es donde
                       sirve. Repetirlo arriba no agrega el dato: agrega una segunda cifra en pantalla
                       que hay que verificar que sea la misma. -->
                  @if (hayCajero()) {
                    <span class="fin-dim">El cajero ya aportó {{ money(aporteCajero()) }} — cuenta acá sólo lo que falta o la morralla (arranca en cero).</span>
                  }
                </div>
                <!-- ⛔ Los INPUTS de esta reja se quedan nativos con pInputText, y es una decision
                     medida, no deuda: en un p-inputnumber las flechas INCREMENTAN el valor de a uno y
                     aca las flechas BAJAN POR LA COLUMNA, que es como se cuenta un fajo. Cambiarlas
                     seria cambiar lo contado sin querer. La tabla si pasa a p-table: asi el borde, la
                     cabecera y el flip a oscuro los pone el tema y no una regla a mano por pantalla. -->
                <!-- ⭐ [CG.53] LA REJA, EN DOS COLUMNAS. Once renglones apilados son ~470px de alto
                     dentro de un panel que tiene ~780: el arqueo solo ya pedia scroll.
                     Billetes (5) y monedas (6) lado a lado lo bajan a ~230.

                     ⚠️ Siguen siendo DOS <p-table>, no una reja de divs con aria-label. [CG.23] eligio
                     tabla a proposito --"esto es dato tabular, asi el encabezado de columna existe de
                     verdad para un lector de pantalla en vez de repetir una etiqueta por celda"-- y eso
                     no caduca por acomodarlas distinto. Con dos tablas cada una conserva sus <th>.

                     ⚠️ Y el teclado tampoco se rompe: moverFoco recorre 'input.cg-pieza' en orden del
                     DOM, o sea los 5 billetes y despues las 6 monedas. Cada sub-columna se lee de
                     arriba a abajo, asi que bajar con la flecha sigue coincidiendo con lo que ve el
                     ojo -- que es la razon por la que [CG.23] las queria en una sola columna. -->
                <div class="cg-reja2">
                  <div class="cg-reja-col">
                    <p-table [value]="rejaBilletes" size="small" class="cg-arqueo-tbl">
                      <ng-template #header>
                        <tr>
                          <th scope="col">Billetes</th>
                          <th scope="col">Piezas</th>
                          <th scope="col">Importe</th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-b>
                        <tr>
                          <th scope="row" class="mono">{{ b.label }}</th>
                          <td>
                            <input pInputText type="number" class="cg-pieza" min="0" step="1" inputmode="numeric" placeholder="0"
                                   [ngModel]="piezasDe(b)" (ngModelChange)="setPiezas(b, $event)"
                                   (keydown.enter)="moverEnReja($event, 1)"
                                   (keydown.arrowdown)="moverEnReja($event, 1)"
                                   (keydown.arrowup)="moverEnReja($event, -1)"
                                   aria-keyshortcuts="ArrowUp ArrowDown Enter"
                                   [attr.aria-label]="'Piezas del billete de ' + b.label" />
                          </td>
                          <td class="mono cg-sub">{{ money(subtotalDe(b)) }}</td>
                        </tr>
                      </ng-template>
                    </p-table>
                  </div>

                  <div class="cg-reja-sep" aria-hidden="true"></div>

                  <div class="cg-reja-col">
                    <p-table [value]="rejaMonedas" size="small" class="cg-arqueo-tbl">
                      <ng-template #header>
                        <tr>
                          <th scope="col">Monedas</th>
                          <th scope="col">Piezas</th>
                          <th scope="col">Importe</th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-b>
                        <tr>
                          <!-- El "moneda" por fila se fue: lo dice el encabezado de SU tabla. Repetirlo
                               once veces era la informacion repetitiva que el rediseno vino a sacar. -->
                          <th scope="row" class="mono">{{ b.label }}</th>
                          <td>
                            <input pInputText type="number" class="cg-pieza" min="0" step="1" inputmode="numeric" placeholder="0"
                                   [ngModel]="piezasDe(b)" (ngModelChange)="setPiezas(b, $event)"
                                   (keydown.enter)="moverEnReja($event, 1)"
                                   (keydown.arrowdown)="moverEnReja($event, 1)"
                                   (keydown.arrowup)="moverEnReja($event, -1)"
                                   aria-keyshortcuts="ArrowUp ArrowDown Enter"
                                   [attr.aria-label]="'Piezas de la moneda de ' + b.label" />
                          </td>
                          <td class="mono cg-sub">{{ money(subtotalDe(b)) }}</td>
                        </tr>
                      </ng-template>
                    </p-table>
                  </div>

                  <!-- ⚠️ [CG.48] Acá decia "Morralla" a secas y su aria-label "todas las monedas
                       juntas". Eso era cierto hasta [CG.38], que le dio renglon propio a las seis
                       monedas: hoy la morralla es SOLO el metal de menos de 50 centavos. El rotulo
                       viejo invitaba a volcar ahi monedas que si tienen renglon, y un bulto dentro
                       del arqueo es justo lo que el arqueo existe para que no haya. -->
                  <div class="cg-reja-mor">
                    <label for="cg-morralla">Morralla <span class="fin-dim">· menos de 50&cent;</span></label>
                    <span class="cg-bandeja-sp"></span>
                    <input pInputText id="cg-morralla" type="number" class="cg-pieza cg-morralla-in"
                           min="0" step="0.01" inputmode="decimal"
                           [ngModel]="morrallaVista()" (ngModelChange)="setMorralla($event)" placeholder="0.00"
                           (keydown.enter)="moverEnReja($event, 1)"
                           (keydown.arrowdown)="moverEnReja($event, 1)"
                           (keydown.arrowup)="moverEnReja($event, -1)"
                                   aria-keyshortcuts="ArrowUp ArrowDown Enter"
                           aria-label="Importe de morralla: el metal de menos de 50 centavos, que no tiene renglón" />
                  </div>
                </div>

                <!-- ⭐ [CG.53] EL NUMERO DE LA PANTALLA. Esto era un <input disabled> en el pie de la
                     tabla, rotulado "Monto del movimiento": el resultado de contar, en gris, del
                     tamano de una celda y con cara de campo apagado. Es LA cifra de la pantalla y
                     ahora se ve como tal -- --fs-display, que es el token de "headline metric, UNA por
                     vista" y que esta pantalla no estaba usando en ningun lado.

                     El veredicto viaja con el numero, no en una pista aparte tres bloques abajo, y
                     distingue TRES ausencias (ADR-056): sin contar / sin documento contra que cuadrar
                     / cuadra. Las dos primeras no son lo mismo y no se pintan igual. -->
                @if (arqueoVeredicto(); as v) {
                  <div class="cg-total-bloque"
                       [class.es-ok]="v.estado === 'cuadra'"
                       [class.es-warn]="v.estado === 'sobra' || v.estado === 'falta'">
                    <div class="cg-total-izq">
                      <div class="cg-lbl-micro">{{ hayCajero() ? 'Contado · cajero + a mano' : 'Contado' }}</div>
                      <div class="cg-total-n mono">{{ money(f().monto) }}</div>
                    </div>
                    <span class="cg-bandeja-sp"></span>
                    <div class="cg-total-der">
                      <div class="cg-total-v">
                        <i class="pi" aria-hidden="true"
                           [class.pi-check]="v.estado === 'cuadra'"
                           [class.pi-exclamation-circle]="v.estado === 'sobra' || v.estado === 'falta'"
                           [class.pi-minus-circle]="v.estado === 'sin_contar' || v.estado === 'sin_documento'"></i>
                        {{ textoVeredicto(v) }}
                      </div>
                      @if (v.esperado !== null) {
                        <div class="mono cg-total-esp">documento {{ money(v.esperado) }}</div>
                      }
                    </div>
                  </div>
                  <!-- [CG.54] La CONSECUENCIA, que es lo unico que la pista vieja agregaba y que el
                       veredicto solo no dice. Va pegada a la diferencia, no al selector de documento
                       del otro extremo del panel. El efectivo nunca se rechaza: se guarda lo contado. -->
                  @if (v.estado === 'sobra' || v.estado === 'falta') {
                    <p class="cg-total-regla">
                      El efectivo <strong>no se rechaza</strong>: se guarda lo contado y la diferencia
                      queda como hallazgo a nombre de quien confirma.
                    </p>
                  }

                  <!-- ⭐ LA CIFRA SE DICE, NO SÓLO SE PINTA. El bloque de arriba es la única salida
                       del conteo y cambia en CADA tecla de la reja; sin región viva, quien usa lector
                       de pantalla teclea once renglones de denominación y nunca se entera del total
                       ni del veredicto — tiene que irse a buscarlos.

                       · polite y no assertive: el lector lo dice cuando la persona deja de
                         teclear, en vez de interrumpir cada dígito. El coalescing lo hace la AT.
                       · atomic: la cifra sin su veredicto ("$460.00") no dice nada; el par
                         ("$460.00 contado, cuadra con el documento") sí. Se lee entero o no se lee.
                       · Va DENTRO del bloque condicional, y es seguro: arqueoVeredicto() nunca
                         devuelve null —siempre cae en alguno de los cinco estados—, así que la
                         región existe en el DOM desde antes del primer cambio, que es lo que exige
                         que se anuncie.
                       · sr-only y no aria-label sobre el bloque: el rótulo describiría el
                         contenedor, no anunciaría su cambio. Son dos mecanismos distintos. -->
                  <p class="sr-only" aria-live="polite" aria-atomic="true">
                    {{ money(f().monto) }} contado. {{ textoVeredicto(v) }}
                  </p>
                }

                <!-- ⭐ [CG.38] EL CAMBIO QUE SE DEVUELVE. Hasta hoy no había dónde registrarlo: si te
                     daban $5,000 por un documento de $4,830, los $170 que volvían al cliente no
                     existían en ningún lado y la caja declaraba efectivo que ya no tenía.

                     Plegado por default: la mayoría de los movimientos no devuelven cambio, y once
                     campos abiertos convierten el caso común en el caso lento. Se abre de un clic. -->
                <div class="cg-cambio">
                  <div class="cg-cambio-head">
                    <p-button [label]="(cambioAbierto() || hayDevuelto()) ? 'Ocultar el cambio' : '¿Diste cambio?'"
                              [icon]="(cambioAbierto() || hayDevuelto()) ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                              size="small" severity="secondary" [text]="true"
                              (onClick)="cambioAbierto.set(!cambioAbierto())"></p-button>
                    @if (hayDevuelto()) {
                      <p-tag severity="info" [value]="'devolviste ' + money(totalDevuelto())"></p-tag>
                    }
                  </div>

                  @if (cambioAbierto() || hayDevuelto()) {
                    <p class="cg-cap">Desglose del cambio que salió de la caja</p>
                    <p-table [value]="reja" size="small" class="cg-arqueo-tbl">
                      <ng-template #header>
                        <tr>
                          <th scope="col">Denominación</th>
                          <th scope="col">Piezas</th>
                          <th scope="col">Importe</th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-b>
                        <tr [class.cg-fila-moneda]="b.familia === 'moneda'">
                          <th scope="row" class="mono">{{ b.label }}<!--
                            --><span class="cg-fam" aria-hidden="true">{{ b.familia === 'moneda' ? 'moneda' : '' }}</span></th>
                          <td>
                            <input pInputText type="number" class="cg-pieza-dev" min="0" step="1" inputmode="numeric" placeholder="0"
                                   [ngModel]="piezasDevueltasDe(b)" (ngModelChange)="setPiezasDevueltas(b, $event)"
                                   (keydown.enter)="moverEnRejaDev($event, 1)"
                                   (keydown.arrowdown)="moverEnRejaDev($event, 1)"
                                   (keydown.arrowup)="moverEnRejaDev($event, -1)"
                                   [attr.aria-label]="'Piezas devueltas de ' + b.label" />
                          </td>
                          <td class="mono cg-sub">{{ money(subtotalDevueltasDe(b)) }}</td>
                        </tr>
                      </ng-template>
                      <ng-template #footer>
                        <tr>
                          <th scope="row">Devuelto</th>
                          <td class="fin-dim cg-na">sale de la caja</td>
                          <td class="mono cg-sub">{{ money(totalDevuelto()) }}</td>
                        </tr>
                      </ng-template>
                    </p-table>

                    <!-- La cuenta en llano: entró, salió, queda. El monto del movimiento es el NETO. -->
                    @if (resumenCambio(); as r) {
                      <p class="fin-dim cg-cambio-cuenta">
                        Entró <span class="mono">{{ money(r.entra) }}</span> ·
                        devolviste <span class="mono">{{ money(r.sale) }}</span> ·
                        queda en la caja <strong class="mono">{{ money(r.neto) }}</strong>
                      </p>
                      <!-- ⛔ El motor no se limita a sumar: NOMBRA el problema con su monto. Devolver
                           más de lo que entró, o un canje que no cuadra, son dinero que se va sin
                           registro -- y eso es exactamente lo que el pedido vino a evitar. -->
                      @if (r.problema) {
                        <p-message severity="warn" class="cg-full">{{ r.problema }}</p-message>
                      }
                    }
                  }
                </div>
              </div>

            <!-- ⭐⭐ [CG.62] EL PIE DEL ARQUEO. Pedido de Edgar: "el boton de guardar se debe
                 mostrar abajo de arqueo, para solo pasar del arqueo a guardar".
                 Va PEGADO ABAJO (sticky) y no al final del contenido: con el cambio devuelto
                 abierto la columna pasa el alto de la pantalla, y un Guardar que hay que ir a
                 buscar scrolleando es el mismo defecto que [CG.46] ya habia arreglado una vez.
                 ⚠️ Y el ultimo campo de la reja llega hasta aca con la flecha: ver moverEnReja. -->
            <!-- ⭐⭐ [CG.67] LA FIRMA DE CONFORMIDAD. Edgar: "necesito que anejemos una firma
                 digital... para que pueda firmar e imprimir su ticket digital".

                 Va ACA, entre el conteo y Guardar, y no en el apartado 1 con los demas datos de
                 la persona: se firma DESPUES de contar, porque lo que se firma es el monto
                 contado. Puesta arriba, se firmaria sobre una cifra que todavia puede cambiar.

                 ⚠️ Solo en el GASTO. Decision de Edgar: "firma quien RECIBE el efectivo que
                 sale". El deposito tambien sale y NO la pide, con motivo: quien lo recibe es el
                 banco y su respaldo es la ficha de deposito, que Fase CC ya guarda con su OCR.
                 ⚠️ Y NO bloquea el guardado: el efectivo ya se movio, y una caja que no puede
                 cerrar un movimiento es una caja parada. Sin firma se guarda y queda marcado
                 "sin firma" -- declarar, no frenar (ADR-056). -->
            @if (firmaPide()) {
              <div class="cg-firma">
                <div class="cg-firma-head">
                  <span class="cg-lbl-micro">Recibí conforme</span>
                  @if (firmaHecha()) {
                    <span class="cg-firma-ok"><i class="pi pi-check" aria-hidden="true"></i> firmado</span>
                  } @else {
                    <span class="fin-dim cg-firma-falta">sin firma — se puede guardar igual</span>
                  }
                  <span class="cg-bandeja-sp"></span>
                  <p-button label="Limpiar" icon="pi pi-eraser" size="small" severity="secondary"
                            [text]="true" [disabled]="!firmaHecha()"
                            (onClick)="firmaLimpiar()"></p-button>
                </div>
                <!-- ⭐⭐ [CG.68] FIRMAR DESDE EL TELEFONO DEL MOSTRADOR. Edgar: "si esto lo estoy
                     usando en pc, como hago que esto se envie a mi telefono para que se firme".
                     La PC pide un codigo, el telefono lo teclea en /finanzas/caja-general/firma,
                     y el PNG vuelve por una room que es de los DOS. -->
                @if (firmaRemotaPng(); as png) {
                  <div class="cg-firma-remota">
                    <img [src]="png" alt="Firma recibida del teléfono" class="cg-firma-img" />
                    <div class="cg-firma-remota-pie">
                      <span class="cg-firma-ok"><i class="pi pi-mobile" aria-hidden="true"></i>
                        firmada en el teléfono</span>
                      <span class="cg-bandeja-sp"></span>
                      <p-button label="Rehacer" icon="pi pi-replay" size="small" severity="secondary"
                                [text]="true" (onClick)="firmaLimpiar()"></p-button>
                    </div>
                  </div>
                } @else if (firmaCodigo(); as cod) {
                  <!-- ⛔ [CG.74] ACA DECIA "Abri Caja General > Firmar en el telefono", Y ESA
                       ENTRADA DE MENU NO EXISTE. Medido: la ruta /finanzas/caja-general/firma
                       esta registrada y NADA en la navegacion apunta ahi -- la unica mencion en
                       todo el repo era un comentario en este archivo. O sea que el procedimiento
                       real era teclear una URL de memoria, en un telefono, con un codigo que vive
                       TRES MINUTOS. Lo encontro Edgar del modo mas directo: "como hago esto".
                       Ahora el camino corto es el QR y el codigo queda como respaldo -- se sigue
                       dictando en voz alta cuando el telefono no puede escanear. -->
                  <div class="cg-firma-codigo">
                    <div class="cg-firma-cod-txt">
                      <span class="cg-lbl-micro">Escanea el QR con el teléfono</span>
                      <strong class="mono cg-firma-cod">{{ cod }}</strong>
                      <small class="fin-dim">{{ firmaTelefonoListo() ? 'El teléfono ya está — esperando la firma…' : 'o entra a ' + rutaFirmaCorta() + ' y escribe el código' }}</small>
                      <p-button label="Cancelar" size="small" severity="secondary" [text]="true"
                                (onClick)="firmaCerrarRemota()"></p-button>
                    </div>
                    <!-- El SVG lo inyecta pintarQr cuando cambia el codigo: el escritor de
                         @zxing devuelve un ELEMENTO, no una cadena, asi que NO hace falta
                         bypassSecurityTrustHtml -- que es por donde se cuela el XSS. -->
                    <div class="cg-firma-qr" #qrFirma></div>
                  </div>
                } @else {
                  <div class="cg-firma-elegir">
                    <p-button label="Firmar en el teléfono" icon="pi pi-mobile" size="small"
                              severity="secondary" [outlined]="true"
                              [loading]="firmaPidiendo()"
                              [disabled]="firmaPidiendo() || !socketVivo()"
                              (onClick)="firmaPedirEnTelefono()"></p-button>
                    <span class="fin-dim">o firma acá abajo</span>
                    @if (!socketVivo()) {
                      <!-- ⚠️ Se DICE por que no se puede, en vez de dejar un boton apagado sin
                           motivo: sin conexion en vivo el emparejamiento no existe. -->
                      <small class="fin-hint-warn d-block">Sin conexión en vivo: por ahora sólo se
                        puede firmar en esta pantalla.</small>
                    }
                  </div>
                }
                @if (firmaAviso(); as a) { <p-message severity="warn" class="cg-full">{{ a }}</p-message> }

                <!-- touch-action:none es lo que impide que el dedo scrollee la pantalla en vez
                     de dibujar. Sin eso, en un telefono no se puede firmar. -->
                <canvas #firmaCanvas class="cg-firma-pad" [class.cg-oculto]="!!firmaRemotaPng()"
                        (pointerdown)="firmaAbajo($event)" (pointermove)="firmaMueve($event)"
                        (pointerup)="firmaArriba()" (pointerleave)="firmaArriba()"
                        aria-label="Firma de quien recibe el efectivo"></canvas>
                <div class="fin-row">
                  <label for="cg-firma-nombre">Nombre</label>
                  <input pInputText id="cg-firma-nombre" class="w-full"
                         [ngModel]="firmaNombre()" (ngModelChange)="firmaNombre.set($event)"
                         placeholder="Quién recibe el efectivo" maxlength="120" />
                </div>
                <!-- ⚠️ Se DICE lo que esto es y lo que no. Es el renglon "Recibi conforme" del
                     ticket, ahora como dato; no es una firma electronica con valor legal. -->
                <small class="fin-dim">Vale como evidencia de conformidad, igual que la firma del
                  ticket en papel. No es una firma electrónica con validez fiscal.</small>
              </div>
            }
            <div class="cg-detail-pie cg-pie-arqueo">
              @if (bloqueos().length) {
                <span class="fin-hint-warn cg-pie-falta">{{ bloqueos().length }} cosa(s) por resolver</span>
              }
              <span class="cg-bandeja-sp"></span>
              <!-- ⚠️ La flecha hacia arriba vuelve a la ultima pieza contada: la cadena del
                   arqueo se recorre en los DOS sentidos, o quien baja de mas queda atrapado en el
                   boton y tiene que volver con el mouse. -->
              <!-- ⛔⛔ [AUD] Va con loading, no sólo con disabled. La pantalla ya tenía la
                   convención escrita 400 lineas mas arriba -"[loading] pone el spinner Y desactiva el boton,
                   que es lo que evita la segunda busqueda"- y la aplicaba en las CUATRO acciones
                   que LEEN (el reporte, la impresion, buscar retiros) y en NINGUNA de las ocho que
                   ESCRIBEN. Un boton que se apaga sin decir por que se lee igual que un boton
                   roto, y el gesto siguiente es volver a tocarlo: justo sobre el unico boton de
                   esta pantalla que mueve dinero. -->
              <p-button label="Guardar" icon="pi pi-check" size="small" styleClass="cg-guardar"
                        [loading]="guardando()"
                        [disabled]="bloqueos().length > 0 || guardando()"
                        (keydown.arrowup)="moverEnReja($event, -1)" aria-keyshortcuts="ArrowUp"
                        (onClick)="pedirConfirmacion()"></p-button>
            </div>

            </div>
          }
          <!-- ⛔ Acá vivia el @else con "Nada que contar todavía". Quedo MUERTO: el cajon sólo
               se monta con capturaAbierta(), asi que esa rama ya no es alcanzable. Se retira en
               vez de dejarla — codigo inalcanzable que describe un estado que la pantalla ya no
               tiene se lee como una funcion que falta. Lo que decia ("elegí uno de la cola") lo
               dice ahora el rótulo del apartado 1, que es donde la persona está mirando. -->
          </div>
      </app-side-peek>
    </div>

    <p-toast position="bottom-right"></p-toast>


    <!-- ⭐⭐ [CG.62] "SEGURO QUE QUERES GUARDAR". Pedido de Edgar junto con bajar el boton.
         ⚠️ Un "¿estás seguro?" que no DICE QUE va a pasar no es una guarda: es un clic de peaje
         que la gente aprende a tirar sin leer, y entonces estorba sin proteger. Este repite las
         tres cosas que el arqueo acaba de establecer -- que movimiento es, cuanto se conto, y si
         cuadra -- porque son justo las que no se pueden deshacer despues.
         ⛔ Y cuando NO cuadra no se limita a avisar: nombra la consecuencia (la diferencia queda
         como hallazgo a nombre de quien confirma), que es la unica razon por la que alguien
         querria volver al conteo en vez de seguir. -->
    <p-dialog [visible]="confirmarGuardar()" (visibleChange)="$event ? null : cerrarConFoco(confirmarGuardar)"
              [modal]="true" [style]="{ width: '26rem', maxWidth: '96vw' }"
              header="¿Guardas este movimiento?" [draggable]="false">
      <!-- ⚠️ Clase propia y NO fin-form: el candado de O.1 ("la captura no vive en un modal")
           busca .fin-form dentro de cualquier p-dialog. Con fin-form aca, el dia que alguien
           abra esta ventana en una prueba el candado se pondria rojo por el motivo equivocado --
           y un candado que grita en falso se termina aflojando. -->
      <div class="cg-conf">
        <p class="cg-conf-que">
          <strong>{{ f().tipo === 'ingreso' ? 'Entra a la caja' : 'Sale de la caja' }}</strong>
          @if (f().beneficiario) { · {{ f().beneficiario }} }
          @if (cobroElegido(); as c) { <br /><span class="mono fin-dim">{{ c.doc_tipo }} {{ c.folio }}</span> }
        </p>

        @if (arqueoVeredicto(); as v) {
          <div class="cg-total-bloque"
               [class.es-ok]="v.estado === 'cuadra'"
               [class.es-warn]="v.estado === 'sobra' || v.estado === 'falta'">
            <div class="cg-total-izq">
              <div class="cg-lbl-micro">Se guarda</div>
              <div class="cg-total-n mono">{{ money(f().monto) }}</div>
            </div>
            <span class="cg-bandeja-sp"></span>
            <div class="cg-total-der">
              <div class="cg-total-v">{{ textoVeredicto(v) }}</div>
              @if (v.esperado !== null) {
                <div class="mono cg-total-esp">documento {{ money(v.esperado) }}</div>
              }
            </div>
          </div>
          @if (v.estado === 'sobra' || v.estado === 'falta') {
            <p class="cg-total-regla">
              El efectivo <strong>no se rechaza</strong>: se guarda lo contado y la diferencia
              queda como hallazgo <strong>a tu nombre</strong>.
            </p>
          }
          @if (v.estado === 'sin_contar') {
            <p class="cg-total-regla">Todavía no contaste nada. Se va a guardar en cero.</p>
          }
        }

        <!-- ⚠️ [CG.67] La ventana DICE si va firmado. Es lo ultimo que se puede corregir sin
             deshacer nada: despues, el movimiento ya esta en el libro. -->
        @if (firmaPide()) {
          @if (firmaHecha()) {
            <p class="cg-total-regla">Va <strong>firmado</strong>@if (firmaNombre().trim()) { por {{ firmaNombre().trim() }} }.</p>
          } @else {
            <p class="cg-total-regla">Va <strong>sin firma</strong>: se guarda igual y queda
               marcado asi en el libro, para que alguien lo pueda resolver.</p>
          }
        }
      </div>
      <ng-template #footer>
        <p-button label="Volver al conteo" severity="secondary" size="small"
                  (onClick)="cerrarConFoco(confirmarGuardar)"></p-button>
        <!-- ⭐ [CG.122] El acceso directo al ticket. Va ACA porque es donde se decide, con la
             persona enfrente, y NO deshace [CG.81]: "Sí, guardar" sigue sin imprimir nada, que
             es lo que evita los ~84 tickets diarios que nadie pedia. Imprimir es el que se
             pide, no el default.
             ⚠️ En secundario y a la izquierda del principal: el camino normal es guardar sin
             papel, y dos botones del mismo peso al lado del unico que mueve dinero convierten
             una excepcion en una pregunta. -->
        <p-button label="Guardar e imprimir" icon="pi pi-print" severity="secondary" size="small"
                  title="Guarda el movimiento y manda el ticket a la térmica"
                  [loading]="guardando()" [disabled]="guardando()" (onClick)="guardar(true)"></p-button>
        <p-button label="Sí, guardar" icon="pi pi-check" size="small"
                  [loading]="guardando()" [disabled]="guardando()" (onClick)="guardar()"></p-button>
      </ng-template>
    </p-dialog>

    <!-- ⭐ [CGS.7] EL FOLIO EN GRANDE, PARA ANOTARLO. Pedido de Edgar: al pagar algo hay que
         escribir el folio en el papel, y hasta hoy salia en un aviso de 4 s junto al monto --
         tipografia de cuerpo, esquina de la pantalla y se iba solo mientras la persona buscaba
         la pluma.
         ⚠️ Sin boton de cerrar a proposito: sin la X, el unico elemento enfocable del dialogo es
         el boton, y PrimeNG enfoca el primero al abrir (focusOnShow, verificado en node_modules
         por [CG.46]). Asi ENTER lo activa sin escribir una sola linea de teclado -- es el
         navegador haciendo el trabajo. -->
    <!-- [CGS.18] Responder una observacion: no cambia ninguna cifra; si lo que estaba mal es un
         movimiento, la correccion es un ajuste en la jornada abierta. -->
    <p-dialog [visible]="respondiendo() !== null" (visibleChange)="$event ? null : cerrarRespuesta()"
              [modal]="true" [style]="{ width: '32rem', maxWidth: '96vw' }" [draggable]="false"
              [header]="'Responder la observación de ' + (respondiendo()?.folio ?? '')">
      @if (respondiendo(); as c) {
        <p class="cg-resp-obs">{{ c.observed_by_username || 'La supervisión' }} escribió: «{{ c.observacion }}»</p>
        <label class="cg-resp-label" for="cg-resp-texto">Tu respuesta (al menos 10 caracteres)</label>
        <textarea pTextarea id="cg-resp-texto" rows="4" class="cg-resp-texto"
                  [ngModel]="textoRespuesta()" (ngModelChange)="textoRespuesta.set($event)"></textarea>
        <small class="cg-resp-ayuda">El corte no cambia: vuelve a la supervisora con tu explicación. Si un movimiento estaba mal, regístralo como ajuste en la jornada de hoy.</small>
        @if (errRespuesta()) { <p class="fin-hint-warn" role="alert">{{ errRespuesta() }}</p> }
      }
      <ng-template #footer>
        <p-button label="Cancelar" size="small" severity="secondary" [text]="true" (onClick)="cerrarRespuesta()"></p-button>
        <p-button label="Enviar respuesta" icon="pi pi-send" size="small"
                  [disabled]="textoRespuesta().trim().length < 10 || enviandoRespuesta()" [loading]="enviandoRespuesta()"
                  (onClick)="enviarRespuesta()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="folioPagado() !== null" (visibleChange)="$event ? null : cerrarFolio()"
              [modal]="true" [style]="{ width: '24rem', maxWidth: '96vw' }"
              header="Anota este folio" [draggable]="false" [resizable]="false" [closable]="false">
      <p class="cg-folio-num">{{ folioPagado() }}</p>
      <p class="cg-folio-pie">Se cierra solo en 10 segundos · Enter para cerrarlo ya</p>
      <ng-template #footer>
        <p-button label="Listo" size="small" (onClick)="cerrarFolio()"></p-button>
      </ng-template>
    </p-dialog>

    <!-- [CG.87] El reporte del dia EN PANTALLA. El cuerpo es el MISMO que sale a la termica
         (cuerpoReporteDia, funcion pura): dos superficies, un solo armador. Va en <pre> con fuente
         mono porque el texto esta alineado en columnas de ancho fijo -- renderizarlo con tipografia
         proporcional desalinea los totales y el reporte deja de poder leerse de un vistazo. -->
    <p-dialog [visible]="reporteAbierto()" (visibleChange)="$event ? null : cerrarConFoco(reporteAbierto)"
              [modal]="true" [style]="{ width: '34rem', maxWidth: '96vw' }"
              header="Reporte de movimientos" [draggable]="false">
      <pre class="cg-reporte">{{ reporteTexto() }}</pre>
      <ng-template #footer>
        <p-button label="Imprimir" icon="pi pi-print" severity="secondary"
                  [loading]="imprimiendoReporte()" (onClick)="imprimirReporteDia()"></p-button>
        <p-button label="Cerrar" severity="secondary" [text]="true"
                  (onClick)="cerrarConFoco(reporteAbierto)"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="aperturaAbierta()" (visibleChange)="$event ? null : cerrarConFoco(aperturaAbierta)"
              [modal]="true" [style]="{ width: '24rem', maxWidth: '96vw' }"
              header="Con cuanto arranco la caja" [draggable]="false">
      <div class="fin-form">
        <div class="fin-row">
          <label for="cg-fondo">Fondo inicial</label>
          <p-inputnumber inputId="cg-fondo" [ngModel]="fondoInicial()" (ngModelChange)="fondoInicial.set($event)"
                         mode="currency" currency="MXN" locale="es-MX" />
        </div>
        <small class="fin-dim">Con qué efectivo arranca la caja. Es el punto de partida del saldo.</small>
        <!-- [CG.29] Se dice que esto NO termina acá: el gesto sigue en el conteo. Sin decirlo, la
             persona confirma y cree que ya rindió cuentas. -->
        <small class="fin-dim">Al confirmar sigues directo al conteo del efectivo.</small>
        <!-- [CGP-V.3] Esta puerta tambien abre la atrasada mas vieja, y lo dice. -->
        @if (aperturaAtrasada(); as dia) {
          <small class="fin-hint-warn">Se abre el corte de la jornada del {{ dia }}: es la más
            vieja sin corte, y las jornadas se cierran en orden.</small>
        }
        <!-- [CGP-V.5] Si abrir falla, se dice aca adentro. -->
        @if (errorApertura(); as er) {
          <p-message severity="error" class="cg-full">{{ er }}</p-message>
        }
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cancelarApertura()"></p-button>
        <!-- Sin bandera de ocupado, el doble clic abría DOS cortes. -->
        <p-button label="Abrir" icon="pi pi-check" size="small"
                  [loading]="abriendo()" [disabled]="abriendo()" (onClick)="abrirCorte()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="cierreAbierto()" (visibleChange)="$event ? null : cerrarConFoco(cierreAbierto)"
              [modal]="true" [style]="{ width: '40rem', maxWidth: '96vw' }"
              header="Cerrar corte — cuenta el efectivo" [draggable]="false">
      <div class="fin-form">
        <!-- [CGP-V.1] Los pasos, sin texto: el dialogo ya dice que sigue en sus propios avisos. -->
        @if (pasoCorte(); as paso) {
          <app-caja-pasos [paso]="paso" />
        }
        <!-- [CGP-V.3] De que jornada es el corte. Con atrasadas, el corte abierto puede no ser el
             de hoy, y la persona tiene que saberlo antes de contar. -->
        <!-- [CGP-V.5] El error del servidor se queda aca, con su frase, hasta el siguiente intento. -->
        @if (errorCierre(); as er) {
          <p-message severity="error" class="cg-full">{{ er }}</p-message>
        }
        <!-- ⭐⭐ [CGP-V.3b] DE QUE JORNADA ES ESTE CORTE, EN PRIMARIO.
             Estaba como <small class="fin-dim"> -- terciario -- y es el dato que MAS importa
             mientras se cuenta: la pantalla pide contar el efectivo ANTES de decir de que dia es
             el corte, y despues lo pega a la jornada atrasada mas vieja. Medido: de 7 cortes, 4
             quedaron con el conteo de otro dia ($19,811.50 de diferencia). Q.5: el primario se
             expresa por escala + peso + contraste, no por color. -->
        @if (rotuloCorte(); as rc) {
          <p class="cg-jornada" [class.cg-jornada-atrasada]="corteAtrasado()">{{ rc }}</p>
        }
        @if (corteAtrasado()) {
          <p-message severity="warn" class="cg-full">Esta jornada ya pasó. El efectivo que tienes
            enfrente puede ser de hoy, no de ese día.</p-message>
          <!-- ⛔ El candado: con jornada atrasada no se sella sin decir que el efectivo es de ESE
               dia. No es burocracia -- es el unico momento en que alguien puede notarlo, y es
               exactamente lo que no ocurrio el 15-oct. -->
          <div class="fin-check">
            <p-checkbox inputId="cg-conf-jornada" [binary]="true"
                        [ngModel]="jornadaConfirmada()" (ngModelChange)="jornadaConfirmada.set($event)"
                        [ngModelOptions]="{ standalone: true }"></p-checkbox>
            <label for="cg-conf-jornada">El efectivo que conté es de la jornada del
              {{ diaDelCorte() }}, no de otro día.</label>
          </div>
        }
        <!-- CG.19 Capa 1b: el arqueo es CIEGO. Acá se pintaba "Esperado / Diferencia" mientras la
             persona tecleaba, o sea que contaba hasta que la diferencia diera cero. Ahora sólo se
             ve lo que ella misma sumó; el resultado aparece al SELLAR. -->
        @if (revelacion(); as r) {
          <!-- ⛔ ACÁ SE PUBLICABA $0.00 SOBRE UN DATO REDACTADO. "esperado", "diferencia" y
               "veredicto" son OPCIONALES a propósito: el servidor los recorta para quien no
               autoriza y avisa con "oculto: true". "oculto" no se leía nunca y money(undefined)
               devuelve "$0.00", así que el arqueo de un cajero se veía CUADRADO A CERO — que es
               lo contrario de "este dato no es para vos". -->
          @if (r.oculto) {
            <p class="fin-dim">Contado: <strong>{{ money(r.contado) }}</strong></p>
            <p-message severity="info" class="cg-full">El esperado y la diferencia no se te muestran: el arqueo es ciego y el resultado lo ve quien autoriza. Tu conteo quedó sellado.</p-message>
          } @else if (r.esperado == null || r.diferencia == null) {
            <!-- CG.160 - ACA TAMBIEN SE DIBUJABA $0.00 SOBRE UN DATO AUSENTE. Un conteo
                 sellado antes de CG.156 trae "contado" real con "esperado"/"diferencia" en
                 NULL, y money(null) devuelve "$0.00": la pantalla iba a AFIRMAR que cuadra
                 justo en el corte donde nadie calculo con que comparar. Es el mismo error que
                 r.oculto arriba, por otra puerta - y es exactamente el caso de CC-2026-00001. -->
            <p class="fin-dim">Contado: <strong>{{ money(r.contado) }}</strong> ·
              Esperado: <strong>sin medir</strong></p>
            <p-tag [value]="etiquetaVeredicto(r.veredicto)" severity="secondary"></p-tag>
            <p-message severity="warn" class="cg-full">Tu conteo está sellado, pero el esperado de ese momento no quedó guardado: se puede cerrar, y el cierre va a calcularlo y registrar la diferencia.</p-message>
          } @else {
            <p class="fin-dim">Esperado: <strong>{{ money(r.esperado) }}</strong> ·
              Contado: <strong>{{ money(r.contado) }}</strong> ·
              Diferencia: <strong [class.fin-neg]="(r.diferencia ?? 0) < 0">{{ money(r.diferencia) }}</strong></p>
            <p-tag [value]="etiquetaVeredicto(r.veredicto)" [severity]="sevVeredicto(r.veredicto || '')"></p-tag>
          }
        } @else {
          <!-- [CGP-V.2] Un solo Contado: lo que se lleva sumado es el total de la reja, abajo. -->
          <p-message severity="info" class="cg-full">Cuenta sin ver el esperado. Al guardar el conteo se revela la diferencia — y a partir de ahí sólo se puede recontar UNA vez, con motivo.</p-message>
        }
        <!-- CG.23 - La misma reja que la captura, por el mismo motivo: se cuentan piezas, los
             importes se calculan, y las flechas bajan por la columna en vez de incrementar el
             valor. La clase es distinta ("cg-pieza-corte") a proposito: el foco de este dialogo
             no puede saltar a los inputs del otro. -->
        @if (conflictoEsperado(); as cf) {
          <!-- CGP-V.12: el esperado cambio despues de contar porque entro o cambio un movimiento de
               la jornada. Se dice aca, con las dos cifras, y el boton de abajo confirma la nueva.
               Antes era un aviso de 7 segundos sin salida: un callejon como el del 12-oct. -->
          <p-message severity="warn" class="cg-full">{{ cf.mensaje }}</p-message>
        }
        <!-- [CGP-V.2] Revelado el conteo, la reja muestra LO SELLADO y ya no se teclea: la unica via
             para cambiarlo es Recontar, que pide motivo. Antes seguia abierta y Cerrar mandaba lo que
             hubiera en ella; al reabrir salia en blanco junto a un Contado con cifra. -->
        @if (rejaEditable() || desgloseSellado()) {
          <p class="cg-cap">{{ !rejaEditable() ? 'Desglose sellado' : recontando() ? 'Reconteo del efectivo' : 'Desglose del efectivo del corte' }}</p>
          <p-table [value]="reja" size="small" class="cg-arqueo-tbl">
            <ng-template #header>
              <tr>
                <th scope="col">Denominación</th>
                <th scope="col">Piezas</th>
                <th scope="col">Importe</th>
              </tr>
            </ng-template>
            <ng-template #body let-b>
              <tr [class.cg-fila-moneda]="b.familia === 'moneda'">
                <th scope="row" class="mono">{{ b.label }}<!--
                  --><span class="cg-fam" aria-hidden="true">{{ b.familia === 'moneda' ? 'moneda' : '' }}</span></th>
                <td>
                  @if (rejaEditable()) {
                    <input pInputText type="number" class="cg-pieza-corte" min="0" step="1" inputmode="numeric" placeholder="0"
                           [ngModel]="piezasCorteDe(b)" (ngModelChange)="setPiezasCorte(b, $event)"
                           (keydown.enter)="moverEnRejaCorte($event, 1)"
                           (keydown.arrowdown)="moverEnRejaCorte($event, 1)"
                           (keydown.arrowup)="moverEnRejaCorte($event, -1)"
                           [attr.aria-label]="'Piezas de ' + (b.familia === 'moneda' ? 'la moneda de ' : 'el billete de ') + b.label" />
                  } @else {
                    <span class="mono">{{ piezasSelladasDe(b) }}</span>
                  }
                </td>
                <td class="mono cg-sub">{{ money(rejaEditable() ? subtotalCorteDe(b) : subtotalSelladoDe(b)) }}</td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr>
                <!-- Mismo rotulo que la reja de la captura: la morralla es el metal de menos de 50
                     centavos, el unico que no tiene renglon propio desde [CG.38]. -->
                <th scope="row">Morralla <span class="fin-dim">· menos de 50&cent;</span></th>
                <td class="fin-dim cg-na">—</td>
                <td>
                  @if (rejaEditable()) {
                    <input pInputText type="number" class="cg-pieza-corte cg-morralla-in" min="0" step="0.01"
                           inputmode="decimal"
                           [ngModel]="morrallaCorteVista()" (ngModelChange)="morrallaCorte.set($event || 0)" placeholder="0.00"
                           (keydown.enter)="moverEnRejaCorte($event, 1)"
                           (keydown.arrowdown)="moverEnRejaCorte($event, 1)"
                           (keydown.arrowup)="moverEnRejaCorte($event, -1)"
                           aria-label="Importe de morralla del corte: el metal de menos de 50 centavos, que no tiene renglón" />
                  } @else {
                    <span class="mono cg-sub">{{ money(desgloseSellado()?.morralla ?? 0) }}</span>
                  }
                </td>
              </tr>
              <!-- Un solo Contado: revelado, es el de la linea de arriba, que sale del servidor. -->
              @if (rejaEditable()) {
                <tr>
                  <th scope="row">{{ recontando() ? 'Reconteo' : 'Contado' }}</th>
                  <td class="fin-dim cg-na">del conteo</td>
                  <td>
                    <input pInputText class="mono cg-total" [value]="money(sumaConteo())"
                           disabled tabindex="-1" aria-label="Total contado, calculado del conteo" />
                  </td>
                </tr>
              }
            </ng-template>
          </p-table>
        } @else {
          <!-- Sin desglose (API anterior) o con una pieza que la reja no tiene: se dice, no se pinta a medias. -->
          <small class="fin-dim">El desglose de este conteo no se puede mostrar pieza por pieza. Lo sellado es el total
            de arriba, y el corte se cierra con ese.</small>
        }
        <!-- [CGP-V.9] Con la reja en cero, sellar exige decir que se conto y no hay efectivo: es
             distinto de no haber contado. Se dice aca por que el boton esta apagado. -->
        @if (rejaEditable() && sumaConteo() === 0) {
          <label class="fin-row cg-declara">
            <p-checkbox [binary]="true" [ngModel]="ceroDeclarado()"
                        (ngModelChange)="ceroDeclarado.set($event)"></p-checkbox>
            <span>Conté y no hay efectivo en la caja.
              <small class="fin-dim d-block">Con la reja en cero el conteo no se puede guardar sin esta
                confirmación: «no hay efectivo» es un conteo, «no conté» no.</small>
            </span>
          </label>
        }
        @if (recontando()) {
          <div class="fin-row">
            <label for="cg-motivo">Motivo del reconteo</label>
            <input pInputText id="cg-motivo" [ngModel]="motivoReconteo()" (ngModelChange)="motivoReconteo.set($event)"
                   class="cg-full"
                   placeholder="Por qué se vuelve a contar — queda guardado junto al primer conteo" />
          </div>
          <small class="fin-hint-warn">Cuenta todo otra vez, desde cero. Este reconteo es el último y
            reemplaza al primero, que queda guardado con su motivo.</small>
        } @else {
          <small [class]="gateCierre().ok ? 'fin-hint-ok' : 'fin-hint-warn'">{{ gateCierre().texto }}</small>
        }
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cerrarConFoco(cierreAbierto)"></p-button>
        @if (!revelacion()) {
          <!-- Sellar ANTES de revelar: si se revelara sin guardar, bastaba mirar el resultado y
               corregir el conteo, y el arqueo ciego dejaría de serlo. -->
          <p-button [label]="ceroVigente() ? 'Sellar en $0.00' : 'Guardar conteo'" icon="pi pi-lock" size="small"
                    [loading]="sellando()"
                    [disabled]="!puedeSellar() || sellando()" (onClick)="sellarConteo()"></p-button>
        } @else if (recontando()) {
          <!-- [CGP-V.2] Recontar es un modo: la reja se abre vacia y Cerrar no se ofrece hasta guardar
               el reconteo o volver al conteo sellado. Cerrar a mitad de un reconteo firmaria el primero. -->
          <p-button label="Volver al conteo sellado" severity="secondary" size="small" [text]="true"
                    [disabled]="sellando()" (onClick)="cancelarReconteo()"></p-button>
          <p-button label="Guardar reconteo" icon="pi pi-lock" size="small"
                    [loading]="sellando()"
                    [disabled]="motivoReconteo().trim().length < GLOSA_MIN || !puedeSellar() || sellando()"
                    (onClick)="recontar()"></p-button>
        } @else {
          @if (ofreceRecontar()) {
            <p-button label="Recontar" icon="pi pi-replay" size="small" severity="secondary"
                      (onClick)="empezarReconteo()"></p-button>
          }
          <p-button [label]="conflictoEsperado() ? 'Confirmar ' + money(conflictoEsperado()!.actual) + ' y cerrar' : 'Cerrar corte'"
                    icon="pi pi-check" size="small"
                    [loading]="cerrando()"
                    [disabled]="!gateCierre().ok || cerrando()" (onClick)="cerrarCorte()"></p-button>
        }
      </ng-template>
    </p-dialog>
  `,
})
export class FinanzasCajaGeneralComponent implements OnInit, OnDestroy {
  private svc = inject(CashLedgerService);
  private auth = inject(AuthService);
  private perms = inject(PermissionsService);
  private toast = inject(MessageService);
  private borrador = inject(CajaBorradorService);
  private caja = inject(CajaSocketService);
  private destroyRef = inject(DestroyRef);
  // `encuestarVisible` se llama desde `ngOnInit`, que NO es contexto de inyección: si no se le
  // pasan `destroyRef` y `zone`, su `inject()` interno revienta. Por eso se toman acá.
  private zone = inject(NgZone);
  /** [CG.58.7] Para que una liga externa pueda abrir la pantalla YA puesta en un folio. */
  private rutaActiva = inject(ActivatedRoute);
  private host: ElementRef<HTMLElement> = inject(ElementRef);

  // ── Teclado ─────────────────────────────────────────────────────────────────────────────────
  //
  // Medido antes de tocar nada: el archivo no tenía UN SOLO manejo de foco (0 `focus()`,
  // 0 `keydown`), y de PrimeNG se verificó qué trae de verdad — `closeOnEscape`, `focusOnShow` y
  // `focusTrap` vienen en `true`, pero **el retorno del foco al cerrar NO existe** (cero
  // coincidencias de `previousFocus`/`restoreAppFocus` en su runtime). DESIGN.md lo pide y avisa
  // que "no es gratis: se verifica, no se asume". Se verificó, y había que escribirlo.

  /** Quién tenía el foco antes de abrir un diálogo, para devolvérselo al cerrar. */
  private focoPrevio: HTMLElement | null = null;

  private abrirConFoco(cual: { set(v: boolean): void }): void {
    this.focoPrevio = (document.activeElement as HTMLElement) ?? null;
    cual.set(true);
  }

  /**
   * Devuelve el foco a donde estaba. Sin esto, cerrar un diálogo deja el foco en el `<body>` y
   * quien navega con teclado tiene que recorrer la pantalla entera para volver a donde estaba.
   */
  /**
   * `[CG.46]` Lleva el foco DENTRO del panel de detalle al abrirlo.
   *
   * Con el modal esto era gratis: PrimeNG enfocaba y atrapaba el foco. En un split no hay trampa
   * —y está bien que no la haya, porque el panel convive con la lista— pero el foco sí tiene que
   * entrar, o el teclado se queda en la tabla mientras el panel cambia a su lado.
   *
   * ⚠️ Va en `setTimeout(0)` porque el `@if` del aside todavía no pintó cuando esto corre: la
   * señal acaba de cambiar y Angular aún no reconcilió. En angosto, además, `focus()` arrastra el
   * panel a la vista, que es justo lo que hace falta cuando queda apilado debajo de la lista.
   */
  /**
   * ⛔⛔ [CG.117] ESTO APUNTABA A UN CONTENEDOR QUE YA NO EXISTE, y por eso al elegir un
   * movimiento el foco no se movia.
   *
   * Buscaba ".cg-detail", que era el panel de detalle del split. Al mudar el arqueo a un cajon
   * ese nodo se retiro: querySelector devolvia null, el "?." se lo tragaba en silencio y el
   * foco se quedaba donde estuviera -- medido en el navegador, terminaba en un boton del
   * control segmentado ("Caja general"). O sea que para empezar a contar habia que ir al
   * primer campo con el mouse, que es justo lo que [CG.46] habia arreglado una vez.
   *
   * ⚠️ Un selector que no encuentra nada NO es un error: es una funcion que se vuelve muda.
   * El codigo seguia pareciendo correcto y nadie lo probaba porque jsdom tampoco mira el foco
   * real. Por eso ahora, si no hay a donde ir, se dice en la consola en vez de no hacer nada.
   *
   * ⭐ Y va al PRIMER CAMPO DE PIEZAS, no al primer enfocable: lo primero del cajon es el
   * buscador de retiros de CAOS, que es la excepcion. Contar empieza en el billete de $1,000,
   * y desde ahi las flechas ya recorren la reja entera hasta Guardar. Si la fila todavia no se
   * puede arquear (le falta declarar su cuenta) no hay reja, y entonces se cae al primer
   * enfocable -- que ahi SI es lo que hay que resolver.
   */
  private enfocarDetalle(): void {
    setTimeout(() => {
      const cajon = this.host.nativeElement.querySelector('.cg-arqueo-cajon');
      if (!cajon) return;
      const campo =
        cajon.querySelector<HTMLElement>('input.cg-pieza') ??
        cajon.querySelector<HTMLElement>('input,select,textarea,button,[tabindex]:not([tabindex="-1"])');
      if (campo) campo.focus();
      else console.warn('[caja] el arqueo abrio sin ningun campo al que mandar el foco');
    }, 0);
  }

  cerrarConFoco(cual: { set(v: boolean): void }): void {
    cual.set(false);
    const el = this.focoPrevio;
    this.focoPrevio = null;
    if (el && typeof el.focus === 'function') setTimeout(() => el.focus(), 0);
  }

  /**
   * ⭐ `[CGS.7]` **El folio del movimiento recién guardado, en grande, para anotarlo.**
   *
   * Pedido de Edgar: *«cuando se pague algo, que aparezca en pantalla el folio en grande para que
   * lo anoten, 10 segundos y un botón de salir que se vincule con el enter»*.
   */
  readonly folioPagado = signal<string | null>(null);
  private folioTimer: ReturnType<typeof setTimeout> | null = null;

  /** @param folio `null`/vacío = el servidor no devolvió folio: no se abre un diálogo vacío. */
  private mostrarFolio(folio: unknown): void {
    const f = folio == null ? '' : String(folio).trim();
    if (!f) return;
    this.focoPrevio = (document.activeElement as HTMLElement) ?? null;
    this.folioPagado.set(f);
    // Un segundo pago antes de que cierre el anterior reinicia la cuenta; sin esto el timer viejo
    // cerraría el folio nuevo a los pocos segundos de aparecer.
    if (this.folioTimer) clearTimeout(this.folioTimer);
    this.folioTimer = setTimeout(() => this.cerrarFolio(), 10000);
  }

  cerrarFolio(): void {
    if (this.folioTimer) { clearTimeout(this.folioTimer); this.folioTimer = null; }
    this.cerrarConFoco({ set: () => this.folioPagado.set(null) });
  }

  /**
   * Mueve el foco por una columna de inputs. Lo comparten las rejas de arqueo (captura, cambio
   * devuelto y corte): en todas, la forma natural de trabajar es bajar de renglón en renglón.
   *
   * ⚠️ `[CG.48]` Lo estrenó la columna "Contado" de la bandeja, que ya no existe. El mecanismo
   * se queda porque las rejas del arqueo son justamente donde contar es recorrer una columna.
   *
   * ⛔ El `preventDefault` va ANTES de saber si hay renglón siguiente, y eso NO es cosmético:
   * estos son `input type=number`, donde la flecha INCREMENTA el valor de a uno. Con el
   * `return` temprano que tenía, en el PRIMER y en el ÚLTIMO renglón —justo donde no hay a
   * dónde ir— la flecha caía al comportamiento nativo y **cambiaba lo contado sin que nadie
   * lo tecleara**. En un arqueo eso es dinero que aparece o desaparece solo.
   */
  private moverFoco(ev: Event, dir: 1 | -1, selector: string): void {
    const e = ev as KeyboardEvent;
    // ⚠️ `[CG.62]` Esto era `HTMLInputElement[]` y llamaba `.select()` sin preguntar. Desde que la
    // cadena termina en un BOTON (Guardar), hay un nodo que no tiene `select` -- y con el tipo
    // viejo el compilador no avisaba: el cast lo tapaba y reventaba en runtime, en la ultima
    // flecha del arqueo, que es justo la que nadie prueba a mano.
    const nodos = Array.from(this.host.nativeElement.querySelectorAll(selector)) as HTMLElement[];
    const vivos = nodos.filter((x) => !(x as HTMLInputElement | HTMLButtonElement).disabled);
    const i = vivos.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const sig = vivos[i + dir];
    if (!sig) return;
    sig.focus();
    const sel = (sig as HTMLInputElement).select;
    if (typeof sel === 'function') (sig as HTMLInputElement).select();
  }

  /**
   * La reja de denominaciones de la captura. Selector propio, distinto del corte: los dos
   * diálogos tienen una reja y el foco de uno no puede saltar a los inputs del otro.
   */
  /**
   * ⭐ `[CG.62]` La cadena de la reja TERMINA EN GUARDAR, y es textualmente lo que pidió Edgar:
   * *"para solo pasar del arqueo a guardar"*. La última pieza contada y el botón quedan a una
   * flecha de distancia, sin cruzar la pantalla ni tabular por el resto del formulario.
   *
   * ⚠️ El orden lo da el DOM (`querySelectorAll`), y por eso el botón tiene que vivir DESPUÉS de
   * la reja: con el pie en el apartado 1 — donde estaba hasta `[CG.60]` — la flecha hacia abajo
   * desde la morralla habría saltado hacia ATRÁS en la pantalla.
   *
   * ⛔ `cg-guardar` va en el `styleClass` del `p-button`, no en una clase del host: verificado en
   * `primeng-button.mjs` que PrimeNG lo compone en el `[class]` del `<button>` real
   * (`cn(cx('root'), styleClass(), …)`). Sobre el host no sería enfocable.
   */
  moverEnReja(ev: Event, dir: 1 | -1): void {
    this.moverFoco(ev, dir, 'input.cg-pieza, button.cg-guardar');
  }

  /**
   * ⭐ `[CG.62]` *"una ventana de «seguro que querés guardar»"*. No guarda: PIDE.
   * El guardado de verdad sigue en `guardar()`, que el diálogo llama.
   */
  pedirConfirmacion(): void {
    if (this.bloqueos().length || this.guardando() || !this.puedeGestionar()) return;
    this.abrirConFoco(this.confirmarGuardar);
  }

  /** La reja de denominaciones del corte. */
  moverEnRejaCorte(ev: Event, dir: 1 | -1): void { this.moverFoco(ev, dir, 'input.cg-pieza-corte'); }

  /**
   * `[CG.38]` La reja del cambio devuelto. Clase propia y NO `cg-pieza`: si compartieran
   * selector, la flecha saltaría de lo que entró a lo que salió sin que nadie lo note, y en un
   * arqueo eso es teclear piezas en la columna equivocada.
   */
  moverEnRejaDev(ev: Event, dir: 1 | -1): void { this.moverFoco(ev, dir, 'input.cg-pieza-dev'); }

  readonly money = money;
  readonly dmy = dmy;
  // `[CGP-V.7]` Para lo que puede no haberse medido: dice «sin medir» en vez de $0.00.
  readonly moneyOSinMedir = moneyOSinMedir;
  readonly diaCorto = diaCorto;
  /**
   * `[CG.38]` Lo que la caja cuenta: **cinco billetes y seis monedas**, del mayor al menor.
   * Salen del catálogo compartido, no de una lista de acá.
   *
   * ⚠️ Se llamaba `billetes` y hoy sería un nombre que miente: la morralla dejó de ser un campo
   * suelto y se cuenta pieza por pieza. `reja` es como la nombra el resto de esta pantalla.
   *
   * ⚠️ La copia NO es adorno y NO se puede volver a `= BILLETES_CAJA`. El catálogo es
   * `readonly Denominacion[]` a propósito —nadie debe empujarle una denominación— pero `[value]`
   * de `p-table` pide un array mutable, así que con la constante directo el compilador de
   * Angular tira TS4104. Mientras eran dos `@for` daba igual; con p-table no.
   *
   * ⛔ Y la copia va ACÁ, una sola vez, NO `[value]="reja.slice()"` en la plantilla: ahí
   * devolvería un array nuevo en CADA ciclo de detección, y p-table reprocesaría su valor en
   * cada tick aunque las denominaciones no cambien nunca. La identidad estable es la mitad del
   * arreglo.
   */
  readonly reja = [...BILLETES_CAJA, ...MONEDAS_CAJA];
  /**
   * `[CG.53]` Las dos mitades de la reja, para pintarlas lado a lado. `reja` sigue existiendo y
   * sigue siendo la misma lista: lo que cambia es cómo se acomoda, no qué se cuenta.
   *
   * ⛔ Copia, igual que `reja` y por la misma razón (ver arriba): con `= BILLETES_CAJA` directo
   * el `[value]` de `p-table` tira TS4104 y rompió el build de `main`.
   */
  readonly rejaBilletes = [...BILLETES_CAJA];
  readonly rejaMonedas = [...MONEDAS_CAJA];

  /**
   * `[CG.53]` El veredicto del arqueo, pegado al número en vez de en una pista tres bloques abajo.
   *
   * ⚠️ **Tres ausencias distintas** (ADR-056), y las tres se dicen distinto:
   *   · `sin_contar` — todavía no hay efectivo contado. No es que no cuadre: es que no hay cifra.
   *   · `sin_documento` — hay conteo pero **no hay contra qué cuadrarlo** (captura libre, sin ancla
   *     en Kepler). Lo contado ES la verdad y no hay veredicto que dar; pintarlo verde sería
   *     afirmar un cuadre que nadie comprobó.
   *   · `cuadra` / `sobra` / `falta` — hay documento y hay conteo.
   */
  arqueoVeredicto = computed<{ estado: 'sin_contar' | 'sin_documento' | 'cuadra' | 'sobra' | 'falta'; dif: number; esperado: number | null }>(() => {
    const contado = Number(this.f().monto) || 0;
    const doc = this.cobroElegido();
    const esperado = doc ? Number(doc.monto) : null;
    if (!(contado > 0)) return { estado: 'sin_contar', dif: 0, esperado };
    if (esperado === null) return { estado: 'sin_documento', dif: 0, esperado: null };
    const dif = redondea(contado - esperado);
    if (Math.abs(dif) < ARQUEO_EPSILON) return { estado: 'cuadra', dif: 0, esperado };
    return { estado: dif > 0 ? 'sobra' : 'falta', dif, esperado };
  });

  textoVeredicto(v: { estado: string; dif: number }): string {
    switch (v.estado) {
      case 'sin_contar': return 'Sin contar';
      case 'sin_documento': return 'Sin documento contra qué cuadrar';
      case 'cuadra': return 'Cuadra con el documento';
      case 'sobra': return `Sobra ${money(Math.abs(v.dif))}`;
      default: return `Falta ${money(Math.abs(v.dif))}`;
    }
  }

  readonly GLOSA_MIN = GLOSA_MIN;
  /** `[CG.120]` El interruptor de la captura a mano, para la plantilla. El porqué vive en la constante. */
  readonly capturaManualHabilitada = CAPTURA_MANUAL_HABILITADA;

  rows = signal<MovimientoCaja[]>([]);
  cargando = signal(false);
  guardando = signal(false);
  /**
   * ⛔ Los tres errores de lectura, por separado y con TEXTO. Antes no existía ninguno: un 500 se
   * veía exactamente igual que "no hay datos", que es el anti-patrón que `app-load-state` existe
   * para matar y el más caro de todos en una pantalla de dinero.
   */
  errLibro = signal<string | null>(null);
  errCortes = signal<string | null>(null);
  errPend = signal<string | null>(null);
  cargandoCortes = signal(false);
  /** Banderas de ocupado: sin ellas el doble clic abría dos cortes y autorizaba dos veces. */
  abriendo = signal(false);
  cerrando = signal(false);
  /**
   * `[CGP-V.12]` El esperado cambió desde que se contó (el 409 de `[CGP-L.2]`): las dos cifras y la
   * frase del servidor. Mientras exista, el diálogo lo muestra y el botón confirma la cifra nueva.
   */
  conflictoEsperado = signal<ConflictoEsperado | null>(null);
  autorizando = signal(false);
  conceptos = signal<Array<ConceptoKepler & { label: string }>>([]);
  /** CG.19 — los movimientos de Kepler sin aplicar, y cuál se eligió en el diálogo. */
  cobros = signal<Array<MovimientoPendiente & { label: string }>>([]);
  cobroElegido = signal<MovimientoPendiente | null>(null);
  cobroSel: (MovimientoPendiente & { label: string }) | null = null;
  /**
   * Lo que se CONTÓ, cuando difiere del documento del ERP.
   *
   * Campo propio y explícito, igual que del lado del servidor (`monto_contado`), y por la misma
   * razón que su comentario da: si se dedujera de que `monto` no coincide con el documento,
   * "conté distinto" y "el front mandó mal el importe" serían el mismo síntoma, y sólo uno de los
   * dos se arregla en el código. Cuando viaja, MANDA sobre el importe de Kepler y la diferencia
   * se levanta como hallazgo — nunca se rechaza el efectivo.
   */
  montoContado = signal<number | null>(null);
  /**
   * CS.3.13 — La parte del movimiento que quedó A CRÉDITO (no llegó en efectivo). El monto del
   * movimiento = efectivo (arqueo) + venta a crédito. Se auto-rellena cuando el cliente del cobro es
   * de crédito (`cliente_credito`), pero SIEMPRE queda editable (decisión del usuario).
   */
  ventaCredito = signal<number>(0);
  /**
   * ⛔⛔ `[CG.160]` **Por qué este movimiento no tiene documento.** El servidor lo exige desde
   * `[CG.124]` y la pantalla no tenía dónde escribirlo: quien captura cobranza de ruta sin
   * documento en Kepler chocaba con un 400 que le explicaba qué hacer y no le daba cómo.
   */
  sinDocumentoMotivo = signal<string>('');
  /** ¿El cliente del cobro anclado es de crédito? (para mostrar el campo y el aviso del auto-relleno). */
  clienteCredito = signal<boolean>(false);
  /* ⛔ `[CG.48]` Acá vivía `contadoBandeja`: el total tecleado en la columna "Contado" de la
     bandeja, arrastrado al diálogo como referencia. Murió con la columna — ya no hay un conteo
     anterior que recordar, porque contar ocurre UNA vez y con desglose. */

  /** CS.3 — la segunda fuente: movimientos de CAOS (caja fuerte) capturables, y el elegido. */
  caosOpciones = signal<Array<CaosCapturable & { label: string }>>([]);
  caosSel: (CaosCapturable & { label: string }) | null = null;
  caosElegido = signal<CaosCapturable | null>(null);

  /**
   * ⭐⭐ `[CGA-A.10b]` **Qué documento DECLARA pagar una captura de CAOS, por LLAVE.**
   *
   * Lleva el `origen_ref` completo del documento (`01-005|U-A-5|0000015|0011`), que es lo que
   * la cola compara. Se llena solo cuando el capturista ancló un documento y después eligió
   * CAOS como origen: hasta hoy esa secuencia **conservaba el texto en la glosa y tiraba la
   * llave**, y la cola tenía que adivinar la sucursal comparando prosa. Medido: una captura así
   * tapó **siete cobros de siete sucursales** (`GOTCHAS` §86).
   *
   * `null` = la captura no declara documento, y eso está bien: no todo depósito paga uno.
   */
  docDeclarado = signal<string | null>(null);

  /**
   * CG — Los documentos POR PAGAR que el BUSCADOR encontró fuera del efectivo inferido: gastos
   * (`XA1001`) y órdenes de entrada (`XA2001`). Sólo se llenan al buscar.
   *
   * ⛔ Los movimientos del cajero (CAOS) SIN CONCILIAR ya no se listan. CAOS es el MISMO efectivo
   * que la caja general de Kepler (`c45='0011'`), no una fuente aparte: mostrarlos sueltos invitaba
   * a capturarlos como asiento propio y eso es doble conteo. Los que el motor SÍ concilia siguen
   * viniendo pegados a su fila de Kepler (`caos_match`), que es donde sirven: autorrellenan el arqueo.
   */
  pagables = signal<Array<MovimientoPendiente & { pagable_label: string }>>([]);

  /**
   * CS.3.4 — El detector DENTRO de la captura: candidatos del cajero propuestos para ESTE gasto y
   * los que el capturista ya vinculó (su efectivo se suma al arqueo y se enlaza al guardar).
   */
  caosSugeridos = signal<CaosCandidato[]>([]);
  caosVinculados = signal<Array<{ device: string; external_id: number; monto: number; ref: string | null; denominaciones: Array<{ denominacion: number; piezas: number }>; senales: Record<string, unknown> }>>([]);
  buscandoCajero = signal(false);

  /**
   * CS.3.7 — El efectivo que el cajero (CAOS) YA contó, MOSTRADO aparte y NUNCA tecleado en la reja.
   * Suma el origen (captura anclada a un movimiento de CAOS) + los vínculos (retiros de un cobro/gasto).
   * La reja de abajo queda para la DIFERENCIA (morralla, monedas, un faltante), arrancando en cero.
   */
  /**
   * ⚠️ `[CG.38]` El cajero (CAOS) reporta **sólo el valor**, no la llave: es un feed externo y no
   * lo podemos cambiar. Sus piezas se leen como BILLETES, y no es una adivinanza — CAOS es un
   * dispensador de billetes, no da monedas. El único valor ambiguo en México es el `20`, y un
   * dispensador que entrega `20` entregó el billete.
   *
   * Si algún día CAOS dispensara monedas, esto las contaría como billetes del mismo valor: el
   * total seguiría bien y el desglose mentiría. Queda dicho acá, que es donde se decide.
   */
  denominacionesCajero = computed<DenominacionCapturada[]>(() => {
    const src: DenominacionCapturada[] = [];
    const comoBillete = (d: { denominacion: number | string; piezas: number | string }) => ({
      denom_key: llaveBillete(Number(d.denominacion)),
      denominacion: Number(d.denominacion),
      piezas: Number(d.piezas),
    });
    const o = this.caosElegido();
    if (o?.denominaciones) src.push(...o.denominaciones.map(comoBillete));
    for (const v of this.caosVinculados()) src.push(...v.denominaciones.map(comoBillete));
    return mergeDenoms(src);
  });

  /** El aporte del cajero, en pesos: la suma de sus billetes (origen + vínculos). */
  aporteCajero = computed(() => this.denominacionesCajero().reduce((a, d) => a + d.denominacion * d.piezas, 0));

  /** ¿Hay efectivo del cajero en esta captura? (para mostrar la mención aparte). */
  hayCajero = computed(() => this.denominacionesCajero().length > 0);

  /**
   * Lo que se MANDA al servidor: el arqueo COMPLETO = el del cajero (aparte en la UI) + la reja
   * manual. El servidor exige que el desglose cuadre con el monto (`assertArqueo`), así que las dos
   * partes se fusionan sólo al guardar; en pantalla siguen separadas.
   */
  denominacionesParaGuardar = computed(() => mergeDenoms([...this.denominacionesCajero(), ...this.f().denominaciones]));

  // ── CG.20/CG.21 — la bandeja de movimientos y los frecuentes del gasto sin documento ─────────
  pendientes = signal<MovimientoPendiente[]>([]);
  confirmables = signal(0);
  /**
   * `[CG.30]` El universo de la bandeja dentro de la ventana, medido por el servidor.
   * `null` = el servidor no lo mandó (API vieja) → el subtítulo cae a un texto que **no afirma**
   * un total, en vez de volver a publicar el tamaño de la página como si fuera el trabajo.
   */
  totalPend = signal<number | null>(null);
  /**
   * `[CG.32]` Si el usuario abrió el cuadre a mano. `null` = decide la pantalla.
   * Una vez abierto NO se vuelve a plegar solo: plegarle algo que acaba de abrir sería pelearle.
   *
   * ⚠️ **Se llama `cuadreAbierto`, NO `cierreAbierto`, y la distinción no es estética:**
   * `cierreAbierto` ya existe más abajo y es el **diálogo de cerrar la jornada** — el acto que
   * sella el día. La primera versión de esto reusó ese nombre, lo PISÓ (en una clase gana la
   * última declaración) y el botón «Ver el cuadre» quedó abriendo el diálogo que rinde cuentas.
   * ⛔ Ni `tsc` ni los diagnósticos del editor lo marcaron: lo cazó una prueba negativa que
   * esperaba `null` y recibió `false`.
   */
  cuadreAbierto = signal<boolean | null>(null);
  /**
   * `[CG.32]` El cuadre se pliega SÓLO si no hay nada que mostrar **y** hay trabajo que sí.
   * Con el libro en cero y la bandeja vacía queda abierto: ahí los ceros son la respuesta.
   * Si la bandeja todavía no se midió (`null`), tampoco se pliega — no se esconde nada por una
   * medición que falta.
   */
  verDetalleCierre = computed(() => {
    const manual = this.cuadreAbierto();
    if (manual !== null) return manual;
    const a = this.arqueo();
    const total = this.totalPend();
    return !(a && a.caja_general.movimientos === 0 && total !== null && total > 0);
  });
  cargandoPend = signal(false);
  /** Lo que la ventana deja fuera. `null` = no hay corte que declarar. */
  rezago = signal<{ movimientos: number; monto: number } | null>(null);
  /**
   * De cuando es la foto que se esta leyendo. `null` = SIN MEDIR, y se dice asi.
   * La lista sale de un matview que refresca un carril cada minuto; si ese carril se cae, el
   * matview sirve datos viejos SIN UN SOLO ERROR y la bandeja se leeria como "no hay trabajo".
   */
  datosAl = signal<string | null>(null);
  frecuentes = signal<Frecuente[]>([]);
  confirmando = signal(false);
  resultado = signal<ResumenLote | null>(null);

  /**
   * Signo y caja de la bandeja.
   *
   * ⚠️ `cajaActiva` arranca en `0011` (CAJA GENERAL) porque es la única con operación: medido a
   * 180 días, tiene **9,142 documentos / $98,531,597.07**, mientras `0010` Padre Hidalgo lleva
   * **1 documento** y `0030` / `0040` / `0050` llevan **cero**. Las cinco están en el selector —
   * se cablean por clave, no por caso, así que aparecen solas el día que se usen— pero arrancar
   * en una caja dormida sería abrir la pantalla vacía.
   */
  signoBandeja = signal<'' | 'ingreso' | 'gasto'>('');
  cajaActiva = signal('0011');
  /** CS.3.9 — Término del buscador universal de «por confirmar» (folio Kepler, concepto, beneficiario, doc). */
  searchPend = signal('');
  /**
   * `[CGA11Y-O3b]` LA TIRA DE ACCESOS RÁPIDOS.
   *
   * `null` = el servidor desplegado todavía no manda `grupos`. **No es un arreglo vacío**: sin
   * medición la tira NO se dibuja, en vez de dibujarse con ceros que afirman que no hay trabajo
   * (ADR-056). Es la misma distinción que `totalPend`.
   */
  grupos = signal<Array<{ doc_tipo: string; tipo: string; movimientos: number; monto: number }> | null>(null);

  /** El grupo elegido (clave de `GRUPOS_COLA`), o `''` = todos. */
  grupoActivo = signal<string>('');

  /**
   * El `doc_tipo` que se le manda al servidor. ⚠️ Hoy cada grupo con MÁS de un doctype no se
   * puede filtrar en el servidor con un solo parámetro — y en vez de mandar el primero y mentir,
   * **no se filtra**: el grupo se publica con su conteo pero su acceso queda informativo.
   * Queda declarado acá; resolverlo es que el endpoint acepte una lista.
   */
  docTipoGrupo = computed<string>(() => {
    const g = GRUPOS_COLA.find((x) => x.clave === this.grupoActivo());
    return g && g.docTipos.length === 1 ? g.docTipos[0] : '';
  });

  /**
   * Las opciones de la tira, con su conteo. Se arman de lo que el servidor DEVOLVIÓ, no de la
   * lista de grupos: un acceso que siempre existe aunque nunca tenga filas es ruido, y uno que
   * tiene trabajo y no aparece es trabajo escondido.
   *
   * ⭐ «Sin clasificar» entra **sólo si hay algo que no cayó en el mapa**, y entonces es de
   * primera clase: un `doc_tipo` nuevo de Kepler tiene que verse, no repartirse a ojo.
   */
  opcionesGrupo = computed<SegOption[]>(() => {
    const gs = this.grupos();
    if (!gs) return [];
    const porClave = new Map<string, number>();
    for (const g of gs) {
      const k = grupoDe(g.doc_tipo);
      porClave.set(k, (porClave.get(k) ?? 0) + g.movimientos);
    }
    const total = gs.reduce((a, g) => a + g.movimientos, 0);
    const ops: SegOption[] = [{ label: 'Todos', value: '', count: total }];
    for (const g of GRUPOS_COLA) {
      const n = porClave.get(g.clave);
      if (n !== undefined) ops.push({ label: g.label, value: g.clave, count: n });
    }
    const sin = porClave.get(GRUPO_SIN_CLASIFICAR);
    if (sin !== undefined) ops.push({ label: 'Sin clasificar', value: GRUPO_SIN_CLASIFICAR, count: sin });
    return ops;
  });

  setGrupo(v: string): void { this.grupoActivo.set(v); this.refiltrar(); }

  readonly opcionesSigno = [
    { label: 'Todo', value: '' },
    { label: 'Entradas', value: 'ingreso' },
    { label: 'Salidas', value: 'gasto' },
  ];

  /**
   * ⛔ `[CGA-A.43]` **Aquí vivía el selector de ventana de la cola** (Desde ayer · La jornada ·
   * 7 días · 45 días · Todo), con su default en 3 días (`[CG.51]`). Se quitó (Edgar, 2026-10-20:
   * «ya sabemos qué movimientos están pendientes»): el servidor acota la cola en el PRIMER CORTE
   * DEL LIBRO (`caja-relevo.ts`). Lo anterior es de la era Control, que ya lo saldó; desde el
   * corte la cola es exacta (medido: 61 documentos). La ventana de 3 días escondía 32 de ellos.
   */
  /**
   * `[CG.51]` El historial (el libro + los cortes) arranca CERRADO. Es referencia, no la tarea.
   * Su cabecera publica el rango y los conteos, así que plegado no es escondido.
   */
  historialAbierto = signal(false);

  /**
   * `[CG.59]` La jornada arranca CERRADA, y es el 10% de la pantalla.
   *
   * Edgar: *"el 90% de la pantalla debe ser ESTOS DOS APARTADOS, ES NUESTRA PRIORIDAD, EN ESE 10%
   * MOSTRARLE UN DESPLEGABLE DE CÓMO VA SU JORNADA"*.
   *
   * ⚠️ Cerrada **ya dice cómo va**: la barra publica `subtituloJornada()` —cuánto falta confirmar y
   * si se rindió cuentas—, así que plegar no es esconder. Abierta trae lo que se mudó acá adentro:
   * el cuadre del día, lo que repite sin cuenta declarada, los documentos por pagar y el libro.
   * **Nada se borró.**
   */
  jornadaAbierta = signal(false);

  /**
   * Lo que el SERVIDOR dijo que acotó. La píldora publicaba el selector local, o sea su propia
   * intención: si el backend corta distinto (y tiene su propio default), la pantalla mentía.
   */
  ventanaSrv = signal<{ desde?: string; dias?: number | null; motivo?: 'pedido' | 'relevo' | 'ventana'; relevo?: string | null; saldados?: number; cola?: PendientesResponse['cola'] } | null>(null);
  /** La lista viene topada. Sin decirlo, un movimiento más allá del tope es invisible para siempre. */
  truncada = signal(false);
  /**
   * Las filas marcadas. `Set` y no un campo en la fila: la lista se recarga.
   *
   * ⛔ `[CG.48]` Acá al lado vivía `contado`, un `Map<origen_ref, número>` con el conteo por
   * renglón. Se retiró con su columna: el lote **espeja** al ERP y no lleva importe propio.
   * Contar distinto es un arqueo, y un arqueo tiene desglose — se hace en «Capturar» (un
   * movimiento) o en el corte (todo el día).
   */
  private seleccion = signal<Set<string>>(new Set());

  marcadas = computed(() => [...this.seleccion()]);
  todasMarcadas = computed(() => {
    const posibles = this.pendientes().filter((p) => p.confirmable);
    return posibles.length > 0 && posibles.every((p) => this.seleccion().has(p.origen_ref));
  });

  /**
   * `[CG.50]` Las FILAS marcadas, en el formato que `p-table` entiende.
   *
   * ⚠️ Es una PROYECCIÓN de `seleccion`, no un segundo estado. La tabla entra como dispositivo de
   * entrada —flechas, Space, Home/End— y la verdad sigue viviendo en la señal, que es la que
   * persiste el borrador, la que poda `podarSeleccion` y la que arma el lote. Dos dueños del mismo
   * estado es exactamente cómo una selección se desincroniza de lo que se confirma.
   */
  /**
   * `[CG.63]` Qué fila está ABIERTA en la ficha. Reemplaza a `filasMarcadas`, que proyectaba el
   * lote sobre la selección de la tabla: desde que el clic abre en vez de marcar, lo que la tabla
   * selecciona es el movimiento en el que se está trabajando, no el lote.
   *
   * ⚠️ Sigue siendo una PROYECCIÓN, no un segundo estado: la verdad es `cobroElegido`. PrimeNG
   * entra como dispositivo de entrada, nunca como segundo dueño del dato.
   */
  filaEnCaptura = computed(() => {
    // ⛔⛔ `[CG.64]` ACÁ ESTABA EL DEFECTO QUE EDGAR REPORTÓ: *"estoy dando clic y no me despliega
    // la información"*. Y no era de PrimeNG: era de esta línea.
    //
    // `cobroElegido` NO se limpia al cerrar la captura — a propósito, porque `guardar()` lo lee.
    // Pero esta proyección lo ignoraba, así que después de cancelar, la fila SEGUÍA contando como
    // seleccionada para `p-table`. Y con `metaKeySelection=false`, hacer clic en una fila ya
    // seleccionada la DESELECCIONA: emitía `null`, y el guarda de «no cerrar con null» convertía
    // eso en silencio absoluto. Cerrar y volver a tocar el MISMO movimiento no hacía nada.
    //
    // ⭐ Medido: reconstruida la configuración de `[CG.63]`, la primera celda abría y la segunda
    // ya no. El error no era «el clic no llega» sino «el clic llega y significa deseleccionar».
    //
    // La definición correcta es ésta: no puede haber una fila EN CAPTURA si no hay captura.
    if (!this.capturaAbierta()) return null;
    const ref = this.cobroElegido()?.origen_ref;
    return ref ? (this.pendientes().find((x) => x.origen_ref === ref) ?? null) : null;
  });

  /**
   * Lo que la tabla reporta al marcar con el teclado o con el clic en la fila.
   *
   * ⛔ Se FILTRA por `confirmable` por la misma razón que `marcarTodas`: una fila sin cuenta
   * declarada iría al lote para que el servidor la rechace, y su casilla ya está deshabilitada.
   * Con el teclado no hay casilla que apagar, así que el freno tiene que estar acá.
   */
  /**
   * `[CG.63]` El clic en la fila ABRE el movimiento. Antes marcaba para el lote.
   *
   * ⭐ `[CG.64]` Lo llama el `(click)` del `<tr>`, NO el `(selectionChange)` de `p-table`:
   * `handleRowClick` se descarta solo cuando el blanco es `INPUT/TEXTAREA/BUTTON/A` o tiene un
   * `.p-button/.p-checkbox/.p-radiobutton` por encima, y la acción principal de la pantalla no
   * puede depender de una lista de descarte ajena. Acepta `null` porque la firma sigue sirviendo
   * al camino de la selección si alguna vez vuelve.
   *
   * ⚠️ Y hay que decir lo que cuesta: marcar fila por fila CON EL MOUSE ya no existe. El lote se
   * arma con "Marcar las N" de la barra: todas las confirmables del filtro, de un golpe.
   *
   * ⛔ Y se corrige una afirmación que escribí mal acá hace diez minutos: NO queda Space para
   * marcar de a una. Con `selectionMode="single"`, Space sobre la fila hace lo MISMO que el clic
   * — abre. Marcar de a una no existe por ningún camino. Si hiciera falta
   * elegir a dedo con el mouse, hay que devolverle a la fila una casilla propia — que es
   * justamente lo que `[CG.56]` retiró cuando el clic significaba marcar.
   *
   * ⚠️ Con `metaKeySelection=false`, volver a hacer clic en la fila abierta emite `null`. NO se
   * cierra la captura por eso: cerrar es una acción propia (Cancelar), no el efecto de tocar dos
   * veces lo mismo.
   */
  abrirDeLaCola(fila: MovimientoPendiente | null): void {
    if (fila) this.capturarDesde(fila);
  }

  /**
   * ⭐⭐ `[CG.93]` **LO ÚNICO QUE TIENE QUE HACER LA PERSONA ES CONTAR.**
   *
   * Edgar: *"lo único que debe hacer el usuario es arquear, no debe seleccionar ningún botón ni
   * rellenar nada; a lo máximo alinearlo con algún movimiento de CAOS"*.
   *
   * El trabajo real es contar billetes contra un documento. Todo lo demás —elegir la fila, elegir
   * la cuenta, elegir el concepto, buscar el retiro del cajero— es trámite que el sistema puede
   * resolver, y cada trámite es una oportunidad de equivocarse. Hoy ya resuelve la cuenta y el
   * concepto (`[CS.3.1b]`/`[CS.3.8]`) y engancha el CAOS (`[CS.3.6]`/`[CS.3.7]`); lo que quedaba
   * era que alguien tuviera que ELEGIR la fila, una por una, 165 veces.
   *
   * Acá la cola se abre sola en el siguiente movimiento resoluble, y al guardar avanza al que
   * sigue. La persona cuenta, guarda, cuenta, guarda.
   *
   * ⛔ **Sólo avanza si NO hay nada abierto.** La lista se recarga sola cada 60 s; si esto corriera
   * con una captura en curso, le arrancaría el documento de las manos a alguien que está contando
   * — y el conteo a medias se perdería. Que una pantalla se mueva sola mientras se trabaja en ella
   * es peor que un clic de más.
   *
   * ⛔ **Sólo toma `confirmable`.** Lo que necesita que una persona decida algo (ruta sin declarar,
   * documento sin contra-cuenta) NO se abre solo: abrirlo sería dejarla frente a un formulario que
   * no puede cerrar, que es exactamente el trámite que esto viene a sacar. Esas filas se quedan en
   * la lista, marcadas, para que alguien las resuelva a propósito.
   *
   * ⚠️ No captura nada: sólo ELIGE. Guardar sigue exigiendo el conteo del efectivo, que es el acto
   * que esto protege.
   */
  private avanzarAlSiguiente(): void {
    if (this.capturaAbierta()) return;
    const siguiente = this.pendientes().find((p) => p.confirmable);
    if (siguiente) this.capturarDesde(siguiente);
  }

  /**
   * `[CG.50]` La fila enfocada de las tres tablas de LECTURA con acciones (recurrentes, libro,
   * cortes). `selectionMode="single"` necesita dónde guardar lo elegido, y sin eso `pSelectableRow`
   * no enciende el roving tabindex. No alimenta ninguna decisión: es sólo el cursor del teclado.
   */
  filaRecurrente: unknown = null;
  filaLibro: unknown = null;
  filaCorte: unknown = null;
  /**
   * El tipo real del endpoint, no uno recortado a mano: la fila TRAE `sucursal` y acá se estaba
   * tirando, que es justo lo que hacía falta para que la sucursal deje de ser texto libre.
   */
  cobertura = signal<CoberturaResponse['catalogo']>([]);
  /** Medir CERO y NO PODER medir son cosas distintas y se dicen distinto (ADR-056). */
  coberturaSinMedir = signal(false);

  /**
   * `[CG.180]` **De dónde sale el autollenado.** `undefined` = la API desplegada no lo informa
   * (deploy parcial); con valor, `derivada === 0` significa que la copia del historial está
   * VACÍA. Las dos son ausencias y sólo la segunda es un problema del dato.
   */
  autofill = signal<NonNullable<CoberturaResponse['autofill']> | undefined>(undefined);

  /**
   * ⛔ La fuente del autollenado está vacía: no hay con qué proponer.
   *
   * De esto cuelga la frase que ve quien captura. Con la copia vacía, el motor contesta
   * `sin_historia` para TODA entidad y la pantalla decía *"no hay historia de este proveedor"* —
   * una afirmación sobre el proveedor cuando el hecho es sobre nosotros.
   *
   * ⚠️ `undefined` NO cuenta como vacía: no saber no es saber que está vacía.
   */
  autofillFuenteVacia = computed(() => {
    const a = this.autofill();          // se lee SIEMPRE: un corte antes mataría la dependencia
    return !!a && a.derivada === 0;
  });
  propuesta = signal<AutofillResponse | null>(null);
  kpiRaw = signal<{ movimientos: number; ingresos: number; gastos: number; depositos: number; cancelados?: number; monto_cancelado?: number } | null>(null);

  /**
   * ⚠️ Señales, no campos planos. La app corre ZONELESS: un callback de HttpClient no agenda
   * detección de cambios por sí solo, así que cerrar un diálogo desde un `next` dependía de que
   * alguna señal hermana cambiara en el mismo turno. `abrirCorte()` no tenía ninguna.
   */
  capturaAbierta = signal(false);

  /**
   * ⭐⭐ `[CG.94]` **CUANDO EL MOVIMIENTO VIENE DE UN DOCUMENTO, NADA SE EDITA.**
   *
   * Edgar, con la captura abierta: *"nada aquí puede ser editable. te mencioné que ya existe.
   * ¿por qué preguntar dos veces los movimientos?"*.
   *
   * Tenía razón y el screenshot lo prueba solo. El encabezado ya decía
   * `X-D-26 0023028 · MANIOBRAS Y DESCARGAS · $100.00 · 10/10/26`, y abajo el formulario volvía a
   * preguntar **lo mismo siete veces**, todo editable:
   *
   *     Tipo         Comprobante de gasto      ← lo dice el documento
   *     Fecha        10/10/2026                ← lo dice el documento
   *     Sucursal     00 · CEDIS                ← lo dice el documento
   *     Comprobante  X-D-26 0023028 …          ← ES el documento que ya estaba elegido
   *     Beneficiario MANIOBRAS Y DESCARGAS     ← lo dice el documento
   *     Cuenta       201 / 201                 ← lo dice la póliza del documento
   *     Qué pasó     X-D-26 0023028 · MANIO…   ← armado del documento
   *
   * Ninguno de esos campos es una decisión: los siete salen del mismo lugar. Ofrecerlos editables
   * no es dar flexibilidad — es pedirle a alguien que revise siete veces un dato que el ERP ya
   * fijó, y abrir siete formas de desalinear la captura respecto del documento contra el que se
   * supone que cuadra.
   *
   * Lo que SÍ queda a la vista es lo único que la persona aporta: **el conteo del efectivo**, y
   * **la alineación con CAOS**, que es la excepción que el propio Edgar marcó (*"a lo máximo
   * alinearlo con algún movimiento de CAOS"*).
   *
   * ⚠️ No se CIERRA la puerta, se cierra el default: `Corregir` revela el formulario completo,
   * tal cual era. Kepler se equivoca —de ahí salió `corregirCuentaDoc()`— y una captura que no se
   * puede corregir obliga a cancelar y rehacer.
   *
   * ⚠️ Sin documento (captura a mano) el formulario sigue entero: ahí no hay de dónde sacar nada
   * y cada campo sí es una decisión.
   */
  corrigiendo = signal(false);
  fichaSolaLectura = computed(() => !!this.cobroElegido() && !this.corrigiendo());

  /**
   * `[CG.91.2]` El pie del historial: suma LOS RENGLONES QUE ESTÁN A LA VISTA, no los del
   * servidor. Es a propósito — el total de arriba ya viene del servidor, y si los dos salieran de
   * la misma fuente el pie no comprobaría nada. Sumando lo visible, una diferencia entre el pie y
   * el cuadro ES información: la lista está topada, o hay algo fuera del reloj de la jornada.
   *
   * ⚠️ Los cancelados quedan fuera del total y se cuentan aparte, igual que arriba.
   */
  /**
   * `[CG.99]` Lo que hay en el cajón = fondo con el que arrancó + lo que el día le dejó.
   * `null` si falta cualquiera de los dos — no se completa con un cero, que afirmaría un saldo
   * que nadie midió.
   */
  hayEnCajon = computed(() => {
    const cg = this.arqueo()?.caja_general;
    // `[CG.180]` La mitad del cajón sale del resolvedor acoplado, no del campo plano: así las dos
    // cifras que esta pantalla publica del cajón vienen de la misma fuente y no pueden divergir.
    const c = this.cajon();
    if (!cg || cg.fondo_inicial == null || c == null) return null;
    return Number((Number(cg.fondo_inicial) + Number(c.en_el_cajon)).toFixed(2));
  });

  /**
   * ⭐⭐ `[CG.139]` **DÓNDE ENTRÓ EL DINERO: el selector del historial.**
   *
   * Edgar: *"necesitamos aquí un selector para ver el movimiento considerando sólo lo que entró a
   * caja general, lo que entró a CAOS, y todo"*.
   *
   * El eje NO es el tipo de movimiento (eso ya lo dicen las dos columnas Cargo/Abono) sino **a
   * qué caja entró**, que es la distinción que el bloque de arriba acababa de corregir: hoy el
   * 68% de lo que se publicaba como ingreso de caja general eran fajos que un vendedor metió al
   * cajero.
   *
   * ⛔ El discriminante es `origen === 'caos'` —el movimiento **nació** del feed de la máquina—
   * y no un enlace: *"si se asocia no quiere decir que lo tocó"*.
   */
  /**
   * ⛔⛔ `[CG.125]` **LA COLUMNA «ORIGEN» NO DECÍA EL ORIGEN, Y LO DESTAPÓ EDGAR PREGUNTANDO.**
   *
   * *«origen (dime a qué te refieres con origen)»*. La pregunta era el hallazgo: esa columna
   * pintaba `autorrellenado` o `manual` según `m.autofill`, que es **si el motor propuso la
   * cuenta contable** — nada que ver con de dónde salió el dinero. Por eso en su captura 233
   * movimientos con `U-A-5 0000015 · CONTADO` escrito en «Qué pasó» salían todos como
   * **«manual»**: el documento estaba ahí, la columna hablaba de otra cosa.
   *
   * ⭐ Un rótulo que nombra una cosa y muestra otra es peor que no tener la columna: se lee, se
   * cree, y manda a buscar un problema que no existe (*«¿por qué nadie ancla documentos?»*).
   *
   * El ORIGEN de verdad son `origen_tipo` + `origen_ref`, que ya viajaban y no se pintaban:
   *  · `cobro` / `pago_proveedor` / … → el documento de **Kepler** con el que se concilió.
   *  · `caos` → el movimiento de la **caja fuerte** con el que se concilió (`device|external_id`).
   *  · vacío → **no se concilió con nada**, y entonces lo que importa es el motivo declarado.
   *
   * Lo de antes no se borra: «autorrellenado» pasa a llamarse por su nombre dentro del
   * desplegable, donde es lo que es — procedencia de la CLASIFICACIÓN, no del dinero.
   */
  origenDe(m: MovimientoCaja): { sistema: string; ref: string; tono: 'ok' | 'warn' } {
    const t = String(m.origen_tipo ?? '').trim();
    const ref = String(m.origen_ref ?? '').trim();
    if (!t && !ref) return { sistema: 'Sin documento', ref: m.sin_documento_motivo || 'sin motivo declarado', tono: 'warn' };
    if (t === 'caos') return { sistema: 'Caja fuerte', ref: m.declared_doc_ref || ref || '—', tono: 'ok' };
    return { sistema: 'Kepler', ref: ref || '—', tono: 'ok' };
  }

  /**
   * ⭐⭐ `[CG.126]` **A qué caja entró: el cajón de Caja General, o la bóveda (CAOS).**
   *
   * Edgar: *«debemos diferenciar lo que entra a caja general vs lo que entra a CAOS»*. El cuadre
   * del día ya lo separa desde `[CG.139]`; el libro publicaba sólo el total, y leer eso como
   * «entró a caja general» **sobredeclara el cajón por todo lo que se fue a la máquina**.
   *
   * ⛔ El reparto **no se calcula acá**: lo manda el servidor desde
   * `analytics.v_caja_reparto_movimiento`, que es el mismo resolvedor del cuadre. Si la pantalla
   * lo derivara por su cuenta habría dos restas para el mismo dinero, y el día que difieran nadie
   * sabría cuál manda. Esta función sólo LEE lo que vino.
   *
   * ⚠️ `medido:false` cuando el servidor no mandó el reparto (deploy parcial, o el movimiento no
   * está en la vista). **No se dibuja un cero**: un cero en «bóveda» afirma que a la máquina no
   * llegó nada, y eso es justo lo que no se sabe (ADR-056).
   */
  repartoDe(m: MovimientoCaja): { medido: boolean; cajon: number; boveda: number } {
    if (m.en_cajon == null && m.en_boveda == null) {
      return { medido: false, cajon: 0, boveda: 0 };
    }
    const boveda = Number(m.en_boveda ?? 0);
    // Si sólo vino una de las dos, la otra sale de la resta — misma formula que el servidor.
    const cajon = m.en_cajon == null ? Number(m.monto ?? 0) - boveda : Number(m.en_cajon);
    return { medido: true, cajon, boveda };
  }

  /** `[CG.126]` ¿Este movimiento tocó la bóveda? Decide si se pinta el reparto o una sola cifra. */
  tocaBoveda(m: MovimientoCaja): boolean {
    const r = this.repartoDe(m);
    return r.medido && Math.abs(r.boveda) > 0.005;
  }

  /** `[CG.125]` Las filas del libro desplegadas, por `id`. */
  libroDesplegado: Record<string, boolean> = {};

  /**
   * ⛔⛔ `[CG.127]` **¿El servidor topó la lista?** `true` = hay movimientos del periodo que NO
   * están en la pantalla.
   *
   * Es la pieza que faltaba: `has_more` venía en la respuesta desde siempre y `cargar()` lo
   * descartaba, así que la lista se cortaba **en silencio**. Medido en prod: 248 movimientos
   * del 01→19 oct y 100 pintados — 148 filas, $1,943,998.57, invisibles.
   *
   * ⚠️ Un paginador NO arregla esto por sí solo: paginaría lo traído y publicaría «de 100»
   * mientras el encabezado dice 248. Lo que hace falta es traer el periodo y DECLARAR cuando ni
   * así alcanza (ADR-056).
   */
  libroTopado = signal(false);

  /**
   * `[CG.125]` Filtro por cómo se concilió. Es el que faltaba: la pregunta operativa de la
   * supervisión es «¿qué entró sin documento?», y hasta hoy había que leer 233 filas para saberlo.
   */
  origenFiltro = signal<'todo' | 'kepler' | 'caos' | 'sin'>('todo');
  readonly opcionesOrigen = computed<SegOption[]>(() => {
    const r = this.rows();
    const n = (f: (m: MovimientoCaja) => boolean) => r.filter(f).length;
    return [
      { label: 'Todo', value: 'todo', count: r.length },
      { label: 'Kepler', value: 'kepler', count: n((m) => !!m.origen_tipo && m.origen_tipo !== 'caos') },
      { label: 'Caja fuerte', value: 'caos', count: n((m) => m.origen_tipo === 'caos') },
      { label: 'Sin documento', value: 'sin', count: n((m) => !m.origen_tipo) },
    ];
  });

  /**
   * ⭐ `[CG.126]` **El segundo filtro: a qué caja ENTRÓ el dinero.**
   *
   * ⛔ Es otra pregunta que la de arriba y por eso es otro control. «Origen» es **con qué se
   * concilió** (de dónde salió el papel); esto es **a dónde fue el efectivo**. Un cobro puede
   * venir de un documento de Kepler y terminar en la máquina de CAOS: mezclarlos en un solo
   * filtro obligaría a elegir cuál de las dos preguntas se puede hacer.
   */
  cajaFiltro = signal<'todo' | 'cajon' | 'boveda' | 'sin_repartir'>('todo');
  readonly opcionesCajaDestino = computed<SegOption[]>(() => {
    const r = this.rows();
    const sinRepartir = r.filter((m) => !this.repartoDe(m).medido).length;
    return [
      { label: 'Las dos cajas', value: 'todo', count: r.length },
      { label: 'Caja general', value: 'cajon', count: r.filter((m) => this.repartoDe(m).cajon !== 0).length },
      { label: 'Caja fuerte', value: 'boveda', count: r.filter((m) => this.tocaBoveda(m)).length },
      // Lo que no se pudo repartir se OFRECE como filtro sólo si existe: es trabajo, no un cero.
      ...(sinRepartir ? [{ label: 'Sin repartir', value: 'sin_repartir', count: sinRepartir }] : []),
    ];
  });

  /** Las filas que se pintan: los dos filtros se aplican en el navegador, sobre lo ya traído. */
  readonly filasLibro = computed<MovimientoCaja[]>(() => {
    const o = this.origenFiltro();
    const c = this.cajaFiltro();
    let r = this.rows();
    if (o === 'caos') r = r.filter((m) => m.origen_tipo === 'caos');
    else if (o === 'sin') r = r.filter((m) => !m.origen_tipo);
    else if (o === 'kepler') r = r.filter((m) => !!m.origen_tipo && m.origen_tipo !== 'caos');
    if (c === 'boveda') r = r.filter((m) => this.tocaBoveda(m));
    else if (c === 'cajon') r = r.filter((m) => this.repartoDe(m).cajon !== 0);
    else if (c === 'sin_repartir') r = r.filter((m) => !this.repartoDe(m).medido);
    return r;
  });

  /**
   * `[CG.123]` **En qué parte de «Tu jornada» está parada la persona.**
   *
   * Edgar, 2026-10-19: *«"tu jornada" es un asco»*. Medido antes de tocarlo, sobre lo que se ve
   * AL ABRIR (no sobre la plantilla, que incluye lo plegado): **3 rejillas, 39 cifras, 7 botones,
   * 41 textos atenuados contra 5 enfatizados y 36 `<small>`**, todo en un solo desplazamiento.
   *
   * ⛔ Y el nombre mentía sobre la mitad: de sus tres regiones, **dos no son «tu jornada»** — las
   * bandejas son trabajo pendiente, y el Historial es **otro rango de fechas** (tiene sus propios
   * calendarios adentro). Un título que describe un tercio de lo que contiene no orienta: desorienta.
   *
   * Lo que manda `DESIGN.md` §10, y que esto viene a cumplir:
   *  · **Miller (chunking)** — nada de 39 cifras seguidas sin separador declarado.
   *  · **Hick** — curaduría antes de enumerar: se elige QUÉ mirar, no se recorre todo.
   *  · **Tesler** — ⛔ y por eso NO es un acordeón «por limpieza»: nada se esconde. Las tres
   *    partes están nombradas y a un clic, con su cifra adentro del botón, así que la persona ve
   *    que existen y cuánto hay en cada una sin tener que entrar.
   */
  seccionJornada = signal<'hoy' | 'movimientos' | 'pendientes' | 'historial'>('hoy');

  /**
   * `[CG.123]` Las tres partes, con cuánto hay detrás de cada una.
   *
   * ⚠️ `count` es ADITIVO y `undefined` ≠ `0` (ADR-056): si la bandeja no se midió, el botón no
   * dibuja un cero que se leería como «no hay nada».
   */
  readonly seccionesJornada = computed<SegOption[]>(() => {
    const rc = this.recurrentes();
    const pend = this.pagables().length + (rc?.medido?.sin_regla ?? 0);
    const movs = this.rows().length;
    /**
     * ⭐⭐ `[CG.128]` **«Movimientos» se separa del cuadre, y esto salió de MEDIR LA PANTALLA VIVA.**
     *
     * `[CG.123]` partió el diálogo en tres y dio por bueno el resultado leyendo el fuente. Medido
     * después en el navegador, con datos reales, la sección «Hoy» **seguía siendo un muro**:
     *
     *     2,023 px de alto dentro de un diálogo de 577 -> 3.5 pantallas de scroll
     *     71 cifras · 4 rejillas · 83 textos atenuados contra 4 enfatizados
     *
     * ⛔ Y mis cifras leídas del fuente se habían quedado **cortas casi al doble** (39 contra 71):
     * la plantilla no sabe cuántas filas trae el día. Es, textual, la diferencia entre el nivel C
     * y el nivel A de `docs/ESTANDAR_DE_INTERFACES.md`.
     *
     * ⭐ El 55 % de ese alto era UN bloque: «Movimientos que registraste en esta jornada», 1,058 px.
     * Y no es el cuadre: el cuadre dice **cuánto hay en cada caja**, esto es **el diario de lo que
     * hiciste**. Dos preguntas, dos secciones — la prueba de la frase del §4.0b del estándar.
     */
    const delDia = this.arqueo()?.movimientos_del_dia?.length ?? 0;
    return [
      { label: 'Hoy', value: 'hoy' },
      { label: 'Movimientos', value: 'movimientos', count: this.cargandoArqueo() ? undefined : delDia },
      { label: 'Pendientes', value: 'pendientes', count: pend },
      { label: 'Historial', value: 'historial', count: this.errLibro() ? undefined : movs },
    ];
  });

  readonly opcionesDondeEntro = [
    { label: 'Caja general', value: 'cajon' },
    { label: 'Se fue a CAOS', value: 'boveda' },
    { label: 'Todo', value: 'todo' },
  ];
  /**
   * Arranca en `cajon` a propósito: es el tema de la pantalla, y así el pie del historial cuadra
   * contra el cuadro de arriba, que ahora también publica sólo la parte del cajón.
   */
  dondeEntro = signal<'cajon' | 'boveda' | 'todo'>('cajon');

  /**
   * ⭐⭐ `[CG.139]` **El selector cambia el DINERO, no las filas.**
   *
   * Edgar: *"se engloban en movimiento pero se separan en dinero"*. Un cobro de ruta es UN
   * movimiento con dos destinos —$49,400 de billetes a la máquina y $57 de morralla al cajón—,
   * así que esconderlo en la vista «Caja general» sería tan falso como mostrarlo por su monto
   * entero. Sale en las tres vistas, con la cifra que le toca a cada una.
   *
   * ⚠️ Si el API no manda el reparto (deploy parcial), cae al `monto` entero en vez de dibujar un
   * cero: un cero afirmaría que a esa caja no llegó nada.
   */
  montoDe = (m: ArqueoMovimientoDia): number => {
    const d = this.dondeEntro();
    if (d === 'todo') return Number(m.monto);
    if (d === 'boveda') return Number(m.en_boveda ?? 0);
    return m.en_cajon == null ? Number(m.monto) : Number(m.en_cajon);
  };

  totalHistorial = computed(() => {
    /**
     * ⚠️ `[CG.139]` Suma el MISMO dinero que la lista muestra, o sea el del selector. Si sumara
     * siempre el monto entero, el pie quedaría por encima del cuadro de arriba —que publica la
     * parte del cajón— **todos los días y por construcción**, y un control que siempre grita
     * deja de leerse.
     */
    const ms = this.arqueo()?.movimientos_del_dia ?? [];
    let ingresos = 0; let gastos = 0; let cancelados = 0;
    for (const m of ms) {
      if (m.estado === 'cancelado') { cancelados++; continue; }
      const v = this.montoDe(m);
      if (m.tipo === 'ingreso') ingresos += v; else gastos += v;
    }
    return {
      ingresos: Number(ingresos.toFixed(2)), gastos: Number(gastos.toFixed(2)), cancelados,
      neto: Number((ingresos - gastos).toFixed(2)),
    };
  });
  /** `[CG.62]` La ventana de "seguro que queres guardar". Es una PREGUNTA, no el guardado. */
  confirmarGuardar = signal(false);

  // ── `[CG.67]` LA FIRMA DE CONFORMIDAD ───────────────────────────────────────────────────
  //
  // El dibujo lo hace `prepararFirma` de `@megadulces/ui-web` (`[CG.66]`), compartido con la
  // firma del cliente en la entrega a domicilio. Acá vive sólo el pegamento con Angular.

  @ViewChild('firmaCanvas') firmaRef?: ElementRef<HTMLCanvasElement>;

  /** `[CG.74]` El hueco donde se inyecta el SVG del QR. */
  @ViewChild('qrFirma') qrRef?: ElementRef<HTMLElement>;

  /** La ruta que se dicta cuando el teléfono no puede escanear. Sin el `https://`, que nadie dicta. */
  rutaFirmaCorta(): string {
    return `${location.host}${RUTA_FIRMA}`;
  }

  /**
   * `[CG.74]` La URL absoluta que va dentro del QR, **con el código ya puesto**.
   *
   * ⚠️ `location.origin` y no una constante: la misma pantalla corre en `localhost:4200` y en
   * `megadulcessuite.com`, y un QR con el dominio clavado mandaría el teléfono a producción
   * mientras alguien prueba en local — o al revés, que es peor.
   */
  private urlFirmaTelefono(codigo: string): string {
    // ⭐ `[CG.84]` Con pase, el teléfono entra sin sesión y con su código ya puesto. El `c=` se
    // manda igual: es el que se dicta en voz alta cuando el teléfono no puede escanear, y es el
    // que usa un teléfono que SÍ tiene sesión. Los dos caminos siguen vivos.
    const pase = this.firmaPase();
    const q = `?c=${encodeURIComponent(codigo)}`
      + (pase ? `&pase=${encodeURIComponent(pase)}` : '');
    return `${location.origin}${RUTA_FIRMA}${q}`;
  }

  /**
   * Pinta el QR del código vivo, o limpia el hueco si ya no hay código.
   *
   * ⚠️ El hueco vive dentro de un `@if`: en el mismo turno en que aparece el código todavía puede
   * no estar montado, y `@ViewChild` se resuelve después. Si no está, se reintenta **una vez** en
   * el turno siguiente — no en bucle: un reintento sin techo sobre un panel que el usuario acaba
   * de cerrar gira para siempre.
   */
  private pintarQrFirma(reintentar = true): void {
    const cod = this.firmaCodigo();
    // `[CG.74]` `pintarQr` pasó a ser asincrónica: el codificador de QR se carga diferido para no
    // meter 449 kB en el paquete inicial de TODA la app (rompió el presupuesto de Angular y dejó
    // `main` sin poder desplegar). Acá no se espera a nadie — se encadena el reintento, que es lo
    // único que dependía del resultado. El método sigue devolviendo `void` a propósito: quien lo
    // llama lo hace desde un efecto de vista y no tiene nada que hacer con la promesa.
    void pintarQr(this.qrRef?.nativeElement ?? null, cod ? this.urlFirmaTelefono(cod) : null, 148)
      .then((ok) => {
        /**
         * ⚠️ `[CG.74b]` Entre que se pide y que se pinta **pasa tiempo** (se baja el trozo
         * diferido), y en ese hueco el código puede haber cambiado: el cajero canceló, o pidió
         * otro. Lo que acaba de aterrizar sería entonces el QR **viejo** — y uno vencido en
         * pantalla es peor que ninguno, porque se escanea igual y falla recién del otro lado.
         * Se vuelve a pintar con el código que está vivo AHORA, sin reintento (ya hubo uno).
         */
        if (this.firmaCodigo() !== cod) { this.pintarQrFirma(false); return; }
        if (!ok && cod && reintentar) setTimeout(() => this.pintarQrFirma(false));
      });
  }
  private firmaPad: FirmaCanvas | null = null;
  /** El canvas sobre el que se preparó `firmaPad`. Cambia cada vez que el `@if` lo re-crea. */
  private firmaEl: HTMLCanvasElement | null = null;

  /**
   * ⚠️ Señal y no un `computed` sobre el primitivo: el primitivo NO es reactivo (es un objeto
   * con estado, no una señal), así que la plantilla no se enteraría de que alguien firmó. Esto
   * es el puente, y se mueve en los tres lugares que mueven el trazo.
   */
  firmaHecha = signal(false);
  firmaNombre = signal('');

  /** Sólo el gasto la pide. El depósito lo respalda la ficha del banco (Fase CC). */
  firmaPide = computed(() => this.f().tipo === 'gasto');

  /**
   * ⛔ Se re-prepara cuando el `<canvas>` cambia de identidad. El `@if` de la captura destruye y
   * re-crea el elemento, y un `FirmaCanvas` apuntando a un canvas desprendido dibuja en la nada:
   * la persona firma, no ve nada, y el guardado manda una firma vacía.
   */
  private pad(): FirmaCanvas | null {
    const c = this.firmaRef?.nativeElement;
    if (!c) return null;
    if (!this.firmaPad || this.firmaEl !== c) {
      this.firmaPad = prepararFirma(c);
      this.firmaEl = c;
    }
    return this.firmaPad;
  }

  firmaAbajo(ev: PointerEvent): void { this.pad()?.abajo(ev.offsetX, ev.offsetY); }
  firmaMueve(ev: PointerEvent): void {
    const p = this.pad();
    if (!p) return;
    p.mueve(ev.offsetX, ev.offsetY);
    // Se avisa en cuanto el trazo alcanza el mínimo, no al soltar: el rótulo "firmado" tiene que
    // aparecer mientras la persona todavía tiene el dedo apoyado, o parece que no tomó nada.
    if (p.firmada() !== this.firmaHecha()) this.firmaHecha.set(p.firmada());
  }
  firmaArriba(): void {
    const p = this.pad();
    if (!p) return;
    p.arriba();
    this.firmaHecha.set(p.firmada());
  }
  firmaLimpiar(): void {
    this.pad()?.limpiar();
    this.firmaRemotaPng.set(null);
    this.firmaRemotaMonto.set(null);
    this.firmaHecha.set(false);
  }

  // ── `[CG.68]` FIRMAR DESDE EL TELEFONO DEL MOSTRADOR ────────────────────────────────────

  /** El codigo que la PC muestra, mientras el emparejamiento esta vivo. */
  firmaCodigo = signal<string | null>(null);
  firmaPidiendo = signal(false);
  firmaTelefonoListo = signal(false);
  firmaAviso = signal<string | null>(null);
  /** La firma que llego del telefono. Es una IMAGEN, no un trazo en el canvas de esta pantalla. */
  firmaRemotaPng = signal<string | null>(null);
  /**
   * ⭐ El monto que se le MOSTRO a quien firmo. Si el importe cambia despues, la firma deja de
   * corresponder -- y sin esto la pantalla seguiria diciendo "firmado" sobre otra cifra.
   */
  firmaRemotaMonto = signal<number | null>(null);

  socketVivo = computed(() => this.caja.connected());

  /**
   * ⛔ La firma remota se INVALIDA sola si el monto cambio. Es un computed y no una bandera
   * porque el monto sale del conteo: cambia con cada pieza que se agrega, y nadie se va a
   * acordar de revalidar a mano.
   */
  firmaRemotaVale = computed(() => {
    const png = this.firmaRemotaPng();
    const m = this.firmaRemotaMonto();
    if (!png || m === null) return false;
    return firmaSigueValiendo(m, Number(this.f().monto) || 0);
  });

  /**
   * ⭐⭐ `[CG.84]` **El pase que va dentro del QR, para que el teléfono NO tenga que loguearse.**
   *
   * Edgar: *"el no password para firmar"*. Lo emite el servidor cuando esta PC —ya con sesión y
   * con permiso de gestionar— pide el código, y vive los mismos 3 minutos. El teléfono lo
   * presenta en lugar de un usuario y entra como invitado atado a ESE código.
   *
   * ⚠️ No se guarda en ningún lado ni se muestra como texto: vive en memoria mientras el panel
   * está abierto y se borra al cerrarlo. Es una llave, no un dato.
   */
  readonly firmaPase = signal<string | null>(null);

  async firmaPedirEnTelefono(): Promise<void> {
    this.firmaAviso.set(null);
    this.firmaPidiendo.set(true);
    try {
      const c = this.cobroElegido();
      const r = await this.caja.abrirFirma({
        tipo: this.f().tipo,
        monto: Number(this.f().monto) || 0,
        beneficiario: this.f().beneficiario || null,
        documento: c ? `${c.doc_tipo} ${c.folio}` : null,
      });
      if (!r.ok || !r.codigo) {
        // ⚠️ El motivo se DICE. Un boton que no hace nada manda a la persona a adivinar.
        this.firmaAviso.set(this.textoFalloFirma(String((r as { error?: string }).error ?? '')));
        return;
      }
      this.firmaCodigo.set(r.codigo);
      // `[CG.84]` El pase ANTES de pintar: el QR lo lee de acá. Si el servidor es viejo y no lo
      // manda, queda `null` y el QR sale con el código solo — el camino de antes, que sigue vivo.
      this.firmaPase.set(r.pase ?? null);
      this.firmaTelefonoListo.set(false);
      this.pintarQrFirma();   // `[CG.74]` el QR del codigo que acaba de nacer
    } finally {
      this.firmaPidiendo.set(false);
    }
  }

  firmaCerrarRemota(): void {
    // Se le avisa al servidor: si no, el codigo queda reclamable los 3 minutos completos y un
    // telefono podria ver el contexto de un pedido que el cajero ya cancelo.
    if (this.firmaCodigo()) void this.caja.cerrarFirma();
    this.firmaCodigo.set(null);
    this.firmaPase.set(null);   // `[CG.84]` la llave se va con el panel
    this.firmaTelefonoListo.set(false);
    this.firmaAviso.set(null);
    // `[CG.74]` Y se borra el QR: uno vencido en pantalla es peor que ninguno — alguien lo
    // escanea, la pagina dice "ese codigo no existe", y queda buscando el error donde no esta.
    this.pintarQrFirma(false);
  }

  /** Traduce el fallo del canal a algo que se pueda leer y actuar. */
  textoFalloFirma(e: string): string {
    switch (e) {
      case 'sin_conexion': return 'Sin conexión en vivo con el servidor: firma en esta pantalla.';
      case 'sin_respuesta': return 'El servidor no contestó. Prueba de nuevo o firma acá.';
      case 'sin_permiso': return 'Tu usuario no puede pedir firma remota (hace falta gestionar la caja).';
      case 'sin_codigo_libre': return 'No se pudo generar un código. Prueba de nuevo.';
      default: return 'No se pudo pedir la firma al teléfono. Firma en esta pantalla.';
    }
  }
  aperturaAbierta = signal(false);
  cierreAbierto = signal(false);
  /**
   * `[CG.42]` **`null` = no se midió**, y es el estado INICIAL. Antes arrancaba en `0` y el
   * formulario siempre mandaba un número, así que el `undefined` que `[CG.39]` necesitaba para
   * guardar `NULL` **no se podía producir desde la pantalla**: la única vía real de abrir caja
   * seguía afirmando "arrancó vacía", ahora encima rotulada como `contado`.
   */
  fondoInicial = signal<number | null>(null);
  morrallaCorte = signal(0);
  conteoCorte = signal<DenominacionCapturada[]>([]);
  saldoResp = signal<SaldoResponse | null>(null);
  cortes = signal<CorteCaja[]>([]);
  /**
   * CG.19 Capa 1b — null mientras se cuenta a ciegas; con valor una vez SELLADO el conteo.
   * No se inicializa con los totales del saldo a propósito: ahí está justamente lo que hay que
   * ocultar, y el servidor ya no lo manda a quien no autoriza.
   *
   * ⭐ `[CGP-V.2]` Va ATADO a su corte (`SelladoEnSesion`) y `abrirCierre()` ya no lo borra. Antes
   * se ponía en `null` al reabrir el diálogo y, como después de sellar no se volvía a pedir el saldo,
   * el diálogo reabierto ofrecía otra vez «Guardar conteo» y el servidor respondía 400: el callejón
   * de `[CG.160]`, esta vez sin recargar la pestaña.
   */
  revelado = signal<SelladoEnSesion | null>(null);
  /**
   * `[CGP-V.2]` El corte que el diálogo de cierre tiene en la mano, tomado al abrirlo. Las acciones
   * del diálogo van a ESTE corte aunque la relectura del saldo falle: un saldo que no volvía dejaba
   * `corteAbierto()` en `null` y «Cerrar corte» salía por el `return` sin decir nada. Con el
   * diálogo cerrado manda el saldo: así un corte que otra sesión cerró no queda pegado acá.
   */
  private corteDelCierre = signal<{ id: string; folio: string; fecha?: string } | null>(null);
  corteEnCierre = computed(() => {
    const d = this.corteDelCierre();
    const enDialogo = this.cierreAbierto();
    const ca = this.corteAbierto();
    if (enDialogo && d) return d;
    return ca ? { id: ca.id, folio: ca.folio, fecha: ca.fecha } : null;
  });
  /**
   * ⭐⭐ `[CG.160]` **El conteo que ya estaba sellado en la base.**
   *
   * Era una foto (`selladoPrevio`) tomada al abrir el diálogo; desde `[CGP-V.2]` se deriva del
   * saldo, que se vuelve a pedir después de cada acción. Y sólo vale para el corte del diálogo.
   *
   * `revelado` sólo se llenaba cuando se sellaba en esta sesión, y `abrirCierre()` lo ponía en `null`.
   * O sea que recargar la pestaña borraba la revelación de un conteo que en la base es
   * INMUTABLE: el diálogo volvía a ofrecer «Guardar conteo», el servidor contestaba *«este corte
   * ya tiene un conteo sellado»*, y «Cerrar corte» no se pintaba nunca. Sin salida.
   *
   * ⛔ **Esto NO afloja el arqueo ciego, y la distinción es exacta.** Sin sellar vale `null` y el
   * esperado sigue oculto; ya sellado, la revelación **ya ocurrió** y el conteo no se puede
   * retocar sin `recontar()`, que pide motivo y conserva el primero. Esconderla acá no protege
   * nada: sólo obliga a re-teclear lo que ya es inmutable, con el riesgo de teclearlo distinto.
   *
   * ⚠️ Medido en producción el 2026-10-14: `CC-2026-00001` —el único corte que existió— llevaba
   * **tres jornadas** sin poder cerrarse por esto, y como `ux_cash_cut_abierto` deja un solo
   * borrador por sucursal, tampoco se podía abrir el del día siguiente. Un corte trabado tranca
   * todos los que vienen detrás.
   */
  selladoServidor = computed<ConteoSellado | null>(() => {
    const ca = this.corteAbierto();
    const c = this.corteEnCierre();
    return ca && c && ca.id === c.id ? ca.conteo_sellado ?? null : null;
  });
  /** `[CGP-V.2]` Lo sellado en esta sesión, sólo si es de ESTE corte. */
  reveladoVigente = computed<SelladoEnSesion | null>(() => {
    const r = this.revelado();
    const c = this.corteEnCierre();
    return r && c && r.corteId === c.id ? r : null;
  });
  /**
   * `[CG.160]` Lo sellado en esta sesión manda; si no, lo que dice el servidor. Las dos formas
   * encajan en `RevelacionVista`, así que el diálogo no tiene que saber de cuál vino.
   */
  revelacion = computed<RevelacionVista | null>(() => {
    const r = this.reveladoVigente();
    const s = this.selladoServidor();
    return r ? r.totales : s;
  });
  /** Recontar es de UNA vez. Sale de la misma fuente que la revelación, no de un flag aparte. */
  puedeRecontar = computed(() => {
    const r = this.reveladoVigente();
    const s = this.selladoServidor();
    return r ? r.puedeRecontar : s ? !s.ya_reconto : false;
  });
  /** Se ofrece recontar con conteo sellado, con diferencia y con el reconteo sin usar. */
  ofreceRecontar = computed(() => {
    const r = this.revelacion();
    const p = this.puedeRecontar();
    return !!r && r.veredicto !== 'cuadra' && p;
  });
  /** `[CGP-V.2]` La persona eligió recontar: la reja vuelve a abrirse, vacía, y pide motivo. */
  recontando = signal(false);
  /**
   * `[CGP-V.9]` «Conté y no hay efectivo». Con la caja en $0 «Guardar conteo» quedaba deshabilitado
   * sin explicación y el corte no se podía cerrar nunca. Sólo vale con la reja en cero: si después se
   * teclea una pieza, deja de valer (el servidor rechaza la contradicción).
   */
  ceroDeclarado = signal(false);
  ceroVigente = computed(() => {
    const declarado = this.ceroDeclarado();
    const suma = sumaDesglose(this.conteoCorte(), this.morrallaCorte());
    return declarado && suma === 0;
  });
  /** Se sella con algo contado, o con el cero declarado. */
  /**
   * ⚠️ Los CUATRO signals se leen INCONDICIONALMENTE, antes de cualquier corto-circuito: un `&&`
   * que corta antes deja al computed sin esa dependencia y **no vuelve a recalcular nunca** — la
   * regla de reactividad que ya dejó muerto el botón «Guardar» en esta misma pantalla.
   *
   * La decisión vive en `puedeSellarUI` (util puro, con su prueba negativa): acá sólo se le pasan
   * los signals.
   */
  puedeSellar = computed(() => {
    const contado = sumaDesglose(this.conteoCorte(), this.morrallaCorte());
    const ceroDeclarado = this.ceroVigente();
    const atrasado = this.corteAtrasado();
    const jornadaConfirmada = this.jornadaConfirmada();
    return puedeSellarUI({ contado, ceroDeclarado, atrasado, jornadaConfirmada }).ok;
  });
  /** La reja se teclea mientras se cuenta o se recuenta; revelado el conteo, muestra lo sellado. */
  rejaEditable = computed(() => {
    const r = this.revelacion();
    const re = this.recontando();
    return !r || re;
  });
  /**
   * `[CGP-V.2]` Lo sellado, pieza por pieza: lo que esta sesión mandó y el servidor aceptó o, si no,
   * lo que publica `saldo()`. `null` = no se puede mostrar pieza por pieza: un API anterior no
   * manda el desglose, o trae una pieza que esta reja no tiene (el servidor acepta todo el catálogo,
   * con el billete de $1,000). Pintarla a medias haría que la reja no sumara lo sellado.
   */
  desgloseSellado = computed<{ conteo: Array<{ denom_key?: string | null; piezas: number }>; morralla: number } | null>(() => {
    const r = this.reveladoVigente();
    const s = this.selladoServidor();
    const d = r ? { conteo: r.conteo, morralla: r.morralla }
      : s?.desglose ? { conteo: s.desglose, morralla: Number(s.morralla ?? 0) } : null;
    if (!d) return null;
    const enReja = new Set(this.reja.map((x) => x.key));
    return d.conteo.every((x) => !(Number(x.piezas) > 0) || enReja.has(String(x.denom_key))) ? d : null;
  });
  sellando = signal(false);
  motivoReconteo = signal('');
  conceptoSel: (ConceptoKepler & { label: string }) | null = null;
  /** Primer día del mes EN MÉXICO. `toISOString()` lo calculaba en UTC y corría el día. */
  from = todayMx().slice(0, 8) + '01';
  to = todayMx();
  tipo: string | null = null;
  search = '';

  /**
   * ⛔⛔ EL DEFECTO MÁS GRAVE DE LA PANTALLA VIVÍA ACÁ, y no se veía.
   *
   * Esto era un campo PLANO y `bloqueos` un `computed(() => motivosDeBloqueo(this.f))`. Un
   * computed de Angular sólo se invalida cuando le avisa un productor reactivo; leyendo un objeto
   * plano NO TIENE NINGUNO, así que se evaluaba una sola vez —al abrir el diálogo, con el
   * formulario vacío— y cacheaba ese resultado PARA SIEMPRE.
   *
   * Consecuencia medida ejecutando el runtime real de Angular: la persona llenaba todo bien y
   * `bloqueos()` seguía publicando los motivos del formulario vacío, así que
   * `[disabled]="bloqueos().length > 0"` dejaba **Guardar inhabilitado de por vida** — y
   * `guardar()` encima volvía a preguntar lo mismo y salía por el `return`. La acción principal
   * de la pantalla no funcionaba, y ni el build, ni el typecheck, ni check:templates lo veían.
   *
   * Regla que queda: si un `computed` va a depender de algo, ese algo es una SEÑAL. Y el signal
   * se lee primero e incondicional — un `&&` que corta antes deja al computed sin dependencias.
   */
  f = signal<FormularioCajaUI>(this.formVacio());

  readonly tiposFiltro = [
    { label: 'Ingresos', value: 'ingreso' }, { label: 'Gastos', value: 'gasto' }, { label: 'Depósitos', value: 'deposito' },
  ];
  readonly tiposCaptura = [
    { label: 'Ficha de efectivo por cobranza', value: 'ingreso' },
    { label: 'Comprobante de gasto', value: 'gasto' },
    { label: 'Depósito al banco', value: 'deposito' },
  ];

  /**
   * `[CG.180]` **Las dos mitades del cajón, en UN objeto o en ninguno.**
   *
   * La plantilla pintaba `a_la_boveda!` bajo la guarda de `en_el_cajon != null`: dos campos
   * nullables por separado, una sola guarda y un `!` que le tapaba la boca al compilador. Hoy no
   * rompe porque el servidor los emite juntos, pero bastaba que uno se volviera null por su
   * cuenta para que `money(null)` dibujara **$0.00** — un cero afirmando que no quedó nada en el
   * cajón, que es otra cosa que no poder saberlo.
   *
   * ⚠️ El `??` NO es cosmético: mientras la API desplegada no mande `cajon`, esto lo arma de los
   * dos planos, y exige los DOS. Si llegara sólo uno, devuelve `null` — que es la respuesta
   * honesta, no medio cajón.
   */
  cajon = computed(() => {
    const cg = this.arqueo()?.caja_general;
    if (!cg) return null;
    if (cg.cajon !== undefined) return cg.cajon;          // API nueva: manda lo que diga, null incluido
    const en = cg.en_el_cajon;
    const bov = cg.a_la_boveda;
    return en == null || bov == null ? null : { en_el_cajon: en, a_la_boveda: bov };
  });

  /**
   * ⭐⭐ `[CG.194]` **LO QUE LA TABLA DE ARRIBA YA DESCONTÓ, CON NOMBRE Y CIFRA.**
   *
   * Medido en prod el 2026-10-19, jornada del día: el libro tiene **$8,179.00** de gastos y la
   * pantalla publicaba **$3,109.00** bajo un renglón que dice «Gastos», dentro de una tabla
   * titulada «Caja general (nuestro libro)». La diferencia —**$5,070.00**— es un gasto pagado con
   * efectivo que dispensó la máquina: el servidor lo resta de `gastos` (son `gastosCajon`) y hace
   * bien, porque ese dinero nunca pasó por el cajón.
   *
   * ⛔ Lo que estaba mal es que **no se decía en ningún lado**, y el mismo importe reaparecía
   * sumado del otro lado: «de eso, a la bóveda $270,200.00» contra «Movimiento de la bóveda
   * $265,130.00», dos cifras de la bóveda lado a lado separadas por exactamente esos $5,070.
   * Las tres son correctas; ninguna explicaba a las otras.
   *
   * ⭐ El dato **ya viajaba**: el backend publica `se_fue_a_boveda` desde `[CG.139]` —con sus dos
   * piernas y el conteo de los que tocaron las dos cajas— y esta pantalla nunca lo leyó. No hace
   * falta tocar el servidor ni la cifra: hace falta pintarlo.
   *
   * ⚠️ **Las dos piernas NO se suman en un total.** Un ingreso que se tragó la máquina y un gasto
   * que salió de ella se mueven en sentidos contrarios; un solo número los compensaría y volvería
   * a esconder justamente lo que esto viene a mostrar. Cada una corrige SU renglón.
   *
   * ⚠️ Tres casos, no dos (el criterio que ya aplica `autofill()` 300 líneas arriba):
   *   · ausente        → esta versión del servidor no lo informa. **No es cero**: se declara.
   *   · presente en 0  → no se partió nada. Es un cero de verdad y no se dibuja nada.
   *   · presente > 0   → se pinta la pierna que corresponda.
   */
  boveda = computed<{ ingresos: number; gastos: number; movimientos: number } | 'sin_medir' | null>(() => {
    const cg = this.arqueo()?.caja_general;
    if (!cg) return null;
    const b = cg.se_fue_a_boveda;
    if (b === undefined) return 'sin_medir';
    return Number(b.ingresos) > 0 || Number(b.gastos) > 0 ? b : null;
  });
  /** La forma con cifras, para que la plantilla no repita el `=== 'sin_medir'` en cada renglón. */
  bovedaCifras = computed(() => {
    const b = this.boveda();
    return b && b !== 'sin_medir' ? b : null;
  });

  coberturaTexto = computed(() => textoCobertura(this.cobertura()));
  /** `[CGP-V.4]` Midiendo no es «sin medir»: la primera lectura del saldo todavía no volvió. */
  textoSaldoUI = computed(() => {
    const cargando = this.cargandoSaldo();
    const r = this.saldoResp();
    return cargando && !r ? 'Saldo: midiendo…' : textoSaldo(r);
  });
  corteAbierto = computed(() => this.saldoResp()?.corte_abierto ?? null);
  /**
   * CS.3.11 — Conciliación con el CAJERO (CAOS): el movimiento de la bóveda desde que abrió el corte.
   * `cajaChicaConciliada` = esperado − depositado al cajero + dispensado del cajero (modelo cajas
   * separadas). Sólo cuando el esperado está REVELADO (`saldo != null`); si no, se declara.
   *
   * ⚠️ `[CG.26]` retiró `conciliacionCajero` (era `saldoResp()?.cajero`): su único uso era pintar
   * "N movimientos del cajero desde que abrió el corte" mientras el arqueo estaba ciego, y el
   * panel nuevo publica el movimiento del cajero **siempre**, con sus seis tipos y sin depender de
   * que haya corte. Un computed que ya no tiene lector se borra, no se deja "por si acaso".
   */
  cajaChicaConciliada = computed<number | null>(() => {
    const s = this.saldoResp(); const cj = s?.cajero;
    if (!cj || s?.saldo == null) return null;
    return Number(s.saldo) - Number(cj.depositado) + Number(cj.dispensado);
  });

  /**
   * CG — El ARQUEO FINAL DEL DÍA: cómo quedó la caja general considerando los ingresos y egresos
   * del corte y las dos piernas del cajero (CAOS).
   *
   *     fondo inicial + ingresos − egresos − depósitos = esperado
   *     esperado − depositado al cajero + dispensado del cajero = caja chica conciliada
   *
   * ⛔ CG.19 — Devuelve `null` mientras el esperado esté OCULTO, y la pantalla lo declara. No es
   * cosmética: esa suma **ES** el esperado, así que componerla para quien cuenta a ciegas sería
   * exactamente la fuga que la Capa 1b cerró (ahí el bug fue calcular el veredicto en el
   * navegador). El servidor manda `saldo: null` cuando recorta; ése es el único permiso que se
   * consulta acá — no se re-deriva de un rol en el cliente.
   */
  arqueoFinal = computed(() => {
    const s = this.saldoResp(); const co = s?.corte_abierto;
    if (!s || !co || s.saldo == null) return null;
    const t = s.totales;
    return {
      // `[CG.42]` `null` se conserva: "no se midió" no es "arrancó en cero".
      fondo: co.fondo_inicial == null ? null : Number(co.fondo_inicial),
      ingresos: Number(t?.ingresos) || 0,
      gastos: Number(t?.gastos) || 0,
      depositos: Number(t?.depositos) || 0,
      esperado: Number(s.saldo),
      cajero: s.cajero ?? null,
      conciliada: this.cajaChicaConciliada(),
    };
  });
  /**
   * ⛔ CG.19 Capa 1b — acá estaba la fuga. esperadoCorte leía saldoResp().totales.esperado y
   * veredicto calculaba la diferencia EN EL NAVEGADOR mientras la persona tecleaba: se contaba
   * hasta que diera cero. Las dos se retiran.
   *
   * El veredicto ahora lo produce el SERVIDOR al sellar el conteo (revelado()), que es el único
   * momento en que el conteo ya no se puede retocar. Calcularlo del lado del cliente sería
   * devolverle el esperado por la ventana: con esperado en el bundle, taparlo en la plantilla
   * no tapa nada.
   */
  corteVista = computed<CorteVista | null>(() => {
    // `[CGP-V.2]` El corte del diálogo, no el del último saldo: si la relectura falla, se sigue
    // pudiendo cerrar el corte que se tiene en la mano.
    const c = this.corteEnCierre();
    return c ? { id: c.id, folio: c.folio, estado: 'borrador' } : null;
  });
  /** No se cierra sin haber SELLADO el conteo: sin revelación no hay nada firmado que cerrar. */
  gateCierre = computed(() => {
    // `[CG.160]` `revelacion()`, no `revelado()`: un conteo sellado en una sesión anterior es
    // tan firme como el de ésta — más, porque ya no se puede retocar sin dejar rastro.
    const r = this.revelacion();
    if (!r) return { ok: false, texto: 'Guarda el conteo primero: el resultado se revela al sellarlo.' };
    return puedeCerrarUI(this.corteVista(), r.veredicto ?? 'sin_contar');
  });
  hayConceptos = computed(() => this.cobertura().reduce((a, r) => a + Number(r.usables || 0), 0) > 0);
  /** Sin saldo no sabemos si hay corte abierto. No es lo mismo que saber que no hay. */
  saldoSinMedir = computed(() => this.saldoResp() === null);
  /**
   * `[CGP-V.4]` Una lectura del saldo en vuelo. Sin esto, mientras cargaba, la pantalla decía
   * «Corte sin medir» y ofrecía «Reintentar» — y reintentar mandaba MÁS lecturas contra el mismo
   * límite de 10 por segundo que la estaba frenando. Mientras mide, el botón espera.
   */
  cargandoSaldo = signal(false);

  /**
   * `[CG.115]` Lo suelto de otras jornadas. El signal se lee **incondicionalmente** (no detrás de
   * un `&&`): un `computed()` que corta antes de leer su dependencia queda sin dependencias y no
   * recalcula nunca — es la compuerta `reactividad` del sistema de diseño.
   */
  sueltosFuera = computed(() => this.saldoResp()?.sueltos_fuera ?? null);
  // CS.3.7 — El arqueo se valida contra el desglose COMPLETO (cajero + reja), que es lo que va al
  // servidor y lo que cuadra con el monto. Validar sólo la reja (vacía cuando el cajero aportó todo)
  // bloquearía el guardado con 'arqueo_no_cuadra' pese a que el arqueo real sí cuadra.
  // `todayMx()` viaja como argumento (no lo lee el util) para que la lógica pura siga siendo
  // probable con un día fijo. Ver `motivosDeBloqueo`.
  bloqueos = computed<MotivoBloqueo[]>(() => motivosDeBloqueo(
    {
      ...this.f(), denominaciones: this.denominacionesParaGuardar(), venta_credito: this.ventaCredito(),
      // ⛔ [CG.38] Sin esto, devolver cambio trababa el guardado con `arqueo_no_cuadra`: el
      // desglose sumaba lo que ENTRÓ y el monto ya era el NETO, así que la diferencia era
      // exactamente el cambio. El botón quedaba apagado justo en el caso que la fase vino a
      // habilitar. Lo encontró la prueba del envío, no la lectura del código.
      devuelto: this.devuelto(),
      // `[CG.160]` Las dos mitades de la conciliación, para que el botón se apague con su motivo
      // en vez de que la persona choque contra el 400 del servidor. ⚠️ `origen_ref` se arma IGUAL
      // que en `guardar()`: si acá se leyera distinto, el botón diría una cosa y el envío otra.
      origen_ref: this.caosElegido()?.origen_ref ?? this.cobroElegido()?.origen_ref ?? null,
      sin_documento_motivo: this.sinDocumentoMotivo(),
    },
    todayMx(),
  ));
  /**
   * De dónde salió el concepto. Ahora depende TAMBIÉN de si se eligió a mano: antes sólo leía
   * `propuesta()`, así que después de elegir en el buscador seguía diciendo "Propuesto de la
   * sesión — 12 antecedentes" sobre algo tecleado. La etiqueta existe justamente para separar
   * propuesto de tecleado; diciendo lo contrario era peor que no estar.
   */
  etiquetaConcepto = computed(() => {
    // Los signals se leen PRIMERO e incondicionales: un `&&` que corte antes dejaría al computed
    // sin dependencias, que es la misma familia de bug que tenía `bloqueos`.
    const doc = this.cuentaFuenteDoc();
    const manual = this.conceptoManual();
    // La cuenta del documento manda sobre todo: es el dato de Kepler, no una propuesta.
    if (doc) return { tono: 'propuesto' as const,
      texto: `Cuenta ${doc.cuenta} de la póliza del documento (Kepler)${doc.conceptos.length > 1 ? ' — elegí el concepto' : ''}.` };
    if (manual) return etiquetaManual();
    // `[CG.180]` La fuente se lee ACÁ y no dentro del util: el util es puro y se prueba solo.
    return etiquetaProcedencia(this.propuesta()?.concepto, this.autofillFuenteVacia());
  });
  /** `true` en cuanto la persona elige o teclea el concepto ella misma. */
  conceptoManual = signal(false);

  /**
   * CS.3.1b — Cuando el movimiento anclado trae su cuenta de la PROPIA póliza del documento, la
   * cuenta es autoritativa y se BLOQUEA: el buscador de conceptos se acota a los de esa cuenta (no
   * busca en todo el catálogo). `corregirCuentaDoc()` lo suelta si de verdad hace falta. `null` =
   * captura normal (regla/propuesta/manual).
   */
  cuentaFuenteDoc = signal<{ cuenta: string; cuenta_nombre: string | null; conceptos: Array<{ concepto: string; concepto_nombre: string | null }> } | null>(null);
  /**
   * CG.22.6 - ¿esta cuenta vale para este beneficiario de ahora en adelante?
   *
   * Medido: `finance.caja_classify_rules` tenia 0 filas en prod y NO habia ninguna pantalla
   * para cargarlas. Por eso la bandeja decia "0 de 8 se confirman" y no habia forma de mejorar
   * ese numero. Nace apagado: declarar una regla contable es una decision, no un default.
   */
  declararRegla = signal(false);

  /**
   * Solo se ofrece donde la regla APLICA: el motor de reglas clasifica EGRESOS por beneficiario
   * (`cuentaPorRegla`), asi que ofrecerlo en un ingreso o un deposito seria prometer un efecto
   * que no va a ocurrir. Y sin beneficiario o sin el par completo no hay nada que declarar.
   */
  puedeDeclararRegla = computed(() => {
    const v = this.f();
    return v.tipo === 'gasto' && !!v.beneficiario?.trim() && !!v.kepler_cuenta && !!v.kepler_concepto;
  });

  /** Las sucursales que el propio censo de cobertura ya mide, con sus conceptos usables. */
  opcionesSucursal = computed(() => {
    const rows = this.cobertura().filter((r) => r.sucursal);
    // [CGP-L.9] Kepler '00' es OFICINAS (ERP_KEPLER §2.3; el servidor lo corrige igual en keplerSucursal).
    if (!rows.length) return [{ label: SUCURSAL_CAJA_GENERAL + ' · Oficinas', value: SUCURSAL_CAJA_GENERAL }];
    return rows
      .slice()
      .sort((a, b) => String(a.sucursal).localeCompare(String(b.sucursal)))
      .map((r) => ({
        label: r.usables ? `${r.sucursal} · ${r.usables} conceptos` : `${r.sucursal} · sin conceptos`,
        value: r.sucursal,
      }));
  });

  /**
   * El renglón de contexto de la bandeja. Dice el corte REAL, el del servidor.
   *
   * ⛔ `[CG.30.1]` **El mismo defecto que `[CG.30]`, en el renglón de al lado — y se me pasó.**
   * Acá decía `${ok} de ${total}` con `total = pendientes().length`, o sea el tamaño de la página:
   * publicaba *«22 de 100»* mientras el subtítulo de arriba, ya corregido, decía **1,875**. La
   * misma pantalla afirmando dos universos distintos a cinco centímetros de distancia.
   *
   * ⚠️ Acá NO se repite el total: eso ya lo dice el subtítulo de la página. Este renglón dice lo
   * suyo —cuántas de las que se VEN salen de un clic— y lo dice declarando su alcance.
   * *Corregir un primitivo en un lugar y no en su vecino es cómo se vuelven a separar las copias.*
   */
  /**
   * `[CG.33]` La etiqueta CORTA del motivo, para la fila. El texto largo sigue existiendo entero
   * en el `title` y, agrupado, en el resumen de arriba.
   *
   * ⚠️ Lo que no está mapeado se muestra tal cual en vez de caer a un genérico: una clave nueva
   * del servidor tiene que **verse**, no disfrazarse de «sin declarar».
   */
  private readonly MOTIVO_CORTO: Record<string, string> = {
    sin_mapa: 'ruta sin declarar',
    sin_confirmar: 'identidad sin firmar',
    sin_cuenta: 'sin cuenta contable',
    sin_monto: 'sin importe en el ERP',
    sin_regla: 'beneficiario sin regla',
    elegir_concepto: 'falta elegir concepto',
    fecha_futura: 'fecha posterior a hoy',
  };
  motivoCorto(m: string | null | undefined): string {
    if (!m) return 'no confirmable';
    return this.MOTIVO_CORTO[m] ?? m;
  }

  /**
   * ⭐ `[CGA-A.15]` `ruta_27` → `Ruta 27`. Sólo cosmética: lo que decide es la vista.
   *
   * ⚠️ Lo que NO reconoce se muestra **tal cual**, no se descarta ni se disfraza. Una unidad
   * nueva con otro patrón de nombre tiene que **verse**, igual que hace `motivoCorto` con una
   * clave que el servidor empiece a mandar.
   */
  /**
   * ⭐⭐ `[CGA-A.15b]` **De dónde viene el movimiento, con lo que se puede PROBAR.**
   *
   * Tres escalones, en orden de fuerza — y ninguno inventa:
   *
   *  1. **La ruta**, si la vista la afirma. Sale de la procedencia del renglón
   *     (`analytics.route_collections.truck`), no de cómo se ve el código de sucursal.
   *  2. **El concepto del ERP**, si no hay ruta. Dice de dónde viene con sus propias palabras:
   *     `VENTAS 16-10-2026 RV CANDY Y DON RAFA`, `DEPOSITO EFECTIVO BBVA 4176 CAJA GENERAL`.
   *  3. **Nada.** Una fila sin procedencia demostrable se queda callada.
   *
   * ⚠️ **`ruta` nula NO significa «no es ruta».** Significa «no se puede probar por procedencia».
   * Medido el 2026-10-19: de los 36 cobros `CONTADO` que no vienen de camioneta, los de la
   * sucursal `01` son **vecinales** (`RV CANDY Y DON RAFA`) — rutas de verdad, que entran por
   * el carril del ODS. Confundir «no demostrable» con «no es» es cómo se pierde media verdad.
   *
   * ⛔ **Por qué no se traduce la sucursal a un nombre.** `analytics.caja_sucursales_catalog`
   * existe, pero está **duplicado y es de departamentos, no de plazas**: la sucursal `01`
   * devuelve «Sistemas» *y* «Departamento»; la `03`, «Compras» *y* «Mercadotecnia». Usarlo
   * pondría una etiqueta confiada y equivocada al lado de una correcta, que es peor que el
   * silencio. Arreglar ese catálogo va aparte.
   *
   * ⚠️ Sólo se ofrece donde la contraparte **no dice nada** (`CONTADO` genérico). Donde hay un
   * beneficiario real —un proveedor, un cliente con nombre— la fila ya se explica sola y
   * agregarle el concepto sería ruido en 13 mil renglones.
   */
  procedencia(p: MovimientoPendiente): string {
    if (p.ruta) return this.etiquetaRuta(p.ruta);
    const nom = (p.beneficiario || p.entidad_code || '').trim().toUpperCase();
    if (nom !== 'CONTADO') return '';
    return (p.concepto || '').trim();
  }

  etiquetaRuta(r: string): string {
    return r.split(' · ').map((u) => {
      const m = /^ruta_(\w+)$/i.exec(u.trim());
      return m ? `Ruta ${m[1]}` : u.trim();
    }).join(' · ');
  }

  /**
   * `[CG.33]` Por qué NO se puede confirmar lo que se ve, **agrupado y contado**.
   *
   * ⛔ El motivo se pintaba entero en cada fila y era el mismo texto en casi todas: con 9 filas a
   * la vista la tabla era un muro naranja donde el aviso pesaba más que el monto. Y repetir 85
   * veces la misma frase tampoco decía lo único accionable — **cuántas** rutas hay que dar de alta.
   *
   * Es sobre las filas que se VEN, igual que `confirmables`, y el texto lo dice.
   */
  /**
   * [CG.37] Si el porqué de los motivos está desplegado. Arranca cerrado: lo accionable es el
   * conteo, y la explicación no cambia de un día para el otro.
   *
   * ⚠️ Nombre verificado contra el resto de la clase antes de declararlo. En `[CG.33]` elegí
   * `cierreAbierto` para una cosa nueva sin mirar que ya existía: en una clase gana la ÚLTIMA
   * declaración, así que el botón nuevo habría abierto el diálogo que SELLA el día. Ni `tsc` ni
   * el editor dijeron nada — lo cazó una prueba negativa.
   */
  motivosAbiertos = signal(false);

  /** El botón sólo existe si hay algo que desplegar: uno que no revela nada es ruido. */
  hayPorque = computed(() => this.motivosAgrupados().some((g) => !!g.texto));

  motivosAgrupados = computed(() => {
    const cuenta = new Map<string, { n: number; texto: string }>();
    for (const p of this.pendientes()) {
      if (p.confirmable) continue;
      const k = this.motivoCorto(p.motivo);
      const prev = cuenta.get(k);
      // El texto LARGO viaja con el grupo: así el porqué completo queda en el DOM, legible y una
      // sola vez. ⛔ No puede vivir sólo en un `title`: un tooltip no es alcanzable por teclado
      // ni lo anuncian los lectores de pantalla de forma confiable (checklist §11).
      cuenta.set(k, { n: (prev?.n ?? 0) + 1, texto: prev?.texto || p.motivo_texto || '' });
    }
    return [...cuenta.entries()]
      .map(([motivo, v]) => ({ motivo, n: v.n, texto: v.texto }))
      .sort((a, b) => b.n - a.n);
  });

  /**
   * ⛔ `[CG.45]` **Esto era UNA frase con cinco hechos pegados con puntos medios**, toda en
   * `--fs-xs` y `--text-muted`: la cifra accionable, la explicación del resto, la ventana y la
   * edad del dato, las cuatro al mismo peso. Q.5 pide tres niveles explícitos por **tipo y
   * contraste**; esto tenía uno solo.
   *
   * Ahora se reparte: la cifra va con peso en la cabecera, **el alcance** (lo que esta consulta
   * abarca) queda acá subordinado, y la **edad del dato** se fue a app-freshness-pill, que es
   * el componente del repertorio y el único que se pone ámbar solo. Como prosa gris al final de
   * una frase, "hace 3 min" y "hace 9 horas" se leían exactamente igual.
   */
  /**
   * ⭐⭐ LA TIRA ANSWER-FIRST DE LA COLA (regla Q.1). La pantalla abría con la rejilla cruda:
   * lo primero que veía la persona eran N filas y tenía que sumarlas con la vista para saber
   * si el día iba bien. Esto pone el veredicto antes que el grid.
   *
   * ⚠️ Cada cifra DECLARA con qué se calculó (ADR-056):
   *  · totalPend en null NO es cero — es que la consulta del universo no volvió, y un cero
   *    ahí se lee como «ya no hay trabajo», que es la trampa que esta pantalla persigue desde
   *    [CG.99]. Sale no_medido con su motivo.
   *  · «de un clic» es sobre lo DEVUELTO, no sobre el total: se marca parcial con su ventana,
   *    porque saberlo del universo exigiría resolver la cuenta de los 13 mil y extrapolar el
   *    porcentaje de la página sería inventar.
   *  · los mal fechados se publican aunque sean cero: su ausencia es un hecho medido.
   */
  kpisCola = computed<MetricStripItem[]>(() => {
    const total = this.totalPend();
    const mal = this.malFechados();
    const c = this.corteAbierto();
    const atr = this.atrasadas().length;
    const items: MetricStripItem[] = [
      total === null
        ? { label: 'Por confirmar', value: '—', state: 'no_medido',
            stateNote: 'la consulta del universo no volvió; un cero acá se leería como «no hay trabajo»' }
        : { label: 'Por confirmar', value: total, format: 'number' },
      { label: 'De un clic', value: this.confirmables(), format: 'number',
        tone: this.confirmables() > 0 ? 'ok' : undefined,
        state: 'parcial', stateNote: 'sobre las filas devueltas, no sobre el universo',
        sub: 'el resto necesita su cuenta declarada' },
    ];
    // Sólo cuando hay algo que declarar: una métrica en cero permanente es ruido.
    if (mal && mal.movimientos > 0) {
      items.push({ label: 'Mal fechados', value: mal.movimientos, format: 'number', tone: 'warn',
                   sub: 'se corrigen en Kepler, no acá' });
    }
    if (atr > 0) {
      items.push({ label: 'Jornadas sin corte', value: atr, format: 'number', tone: 'warn',
                   sub: 'desde el ' + diaCorto(this.atrasadas()[0].fecha) });
    }
    if (c) {
      items.push({ label: 'Corte abierto', value: c.folio, sub: 'falta rendir cuentas' });
    }
    return items;
  });

  textoAlcance = computed(() => {
    const enPagina = this.pendientes().length;
    const ok = this.confirmables();
    const srv = this.ventanaSrv();
    const dias = srv?.dias ?? null;
    const partes: string[] = [];
    if (ok < enPagina) partes.push('el resto necesita que su cuenta esté declarada');
    // [CGA-A.43] El alcance lo dice el servidor: desde el primer corte del libro, o su ventana.
    // [CGA-A.44] Desde el 1 del mes del relevo; antes del corte, sólo lo que el Control no concilió
    // (por día, como el Cuadre: un cobro que el Control anotó otro día sigue apareciendo).
    if (srv?.motivo === 'relevo' && srv.desde && srv.relevo && srv.desde < srv.relevo) {
      // [CGA-A.49] Partido en sus dos colas: «del libro» es la MISMA que cuentan la campana y
      // «Mi trabajo»; sin partirlo, la responsable ve dos números y no sabe cuál es el bueno.
      const c = srv.cola;
      partes.push(c
        ? `${c.del_libro.n} desde el ${dmy(srv.relevo)} (primer corte del libro) + ${c.rezago_control.n} del ${dmy(srv.desde)} al ${dmy(diaAntes(srv.relevo))} que el Control no concilió`
        : `desde el ${dmy(srv.desde)}; antes del ${dmy(srv.relevo)} (primer corte del libro) sólo lo que el Control no concilió`);
    } else if (srv?.motivo === 'relevo' && srv.desde) partes.push(`desde el ${dmy(srv.desde)} (primer corte del libro)`);
    else if (dias) partes.push(`últimos ${dias} día${dias === 1 ? '' : 's'}`);
    else if (srv?.desde) partes.push(`desde ${dmy(srv.desde)}`);
    return partes.join(' · ');
  });

  // ⛔ `[CG.45]` Acá vivía `textoFrescura()`: "hace N min" calculado a mano y devuelto como
  // TEXTO, que terminaba pegado al final de una frase gris. El contrato que cumplía —nunca
  // omitir la edad del dato— se mantiene, pero lo cumple app-freshness-pill, que además hace
  // lo que una cadena no puede: pasar a ámbar cuando el dato envejece, refrescarse sola cada
  // 15 s y declarar el tercer estado. Un helper propio que duplica un componente del repertorio
  // es el antipatrón #1 de Atomic Design, y acá encima perdía la señal.

  /**
   * ⛔ Acá se DIBUJABAN CEROS. `String(k?.movimientos ?? 0)` y `money(k?.ingresos ?? 0)` publicaban
   * "0" y "$0.00" —con animación de count-up— cuando el libro NO se había podido leer, o sea
   * exactamente igual que un periodo real sin movimiento. Es lo que ADR-056 prohíbe de frente.
   * `MetricStrip.isText()` ya sabe pintar un texto sin contarlo: sólo había que dejar de mentirle.
   */
  kpis = computed<MetricStripItem[]>(() => {
    const k = this.kpiRaw();
    if (!k) {
      return [
        { label: 'Movimientos', value: '—', format: 'text' as const, sub: 'sin medir' },
        { label: 'Ingresos', value: '—', format: 'text' as const, sub: 'sin medir' },
        { label: 'Gastos', value: '—', format: 'text' as const, sub: 'sin medir' },
        { label: 'Depósitos', value: '—', format: 'text' as const, sub: 'sin medir' },
      ];
    }
    /**
     * ⭐ `[CG.72]` La parte cancelada se DECLARA, no se esconde ni se mezcla.
     *
     * El servidor dejó de sumar los cancelados en los importes (eran dinero que no se movió),
     * pero la lista sí los muestra —son auditoría— así que el encabezado tiene que explicar la
     * diferencia. Sin este subtítulo, «Movimientos 3 · Gastos $131,060» contra una lista de 3
     * filas que suman $131,080 se lee como un error de la pantalla.
     *
     * ⚠️ Sólo aparece si hay alguno: un «0 cancelados» permanente es ruido que entrena a no leer.
     */
    const canc = Number(k.cancelados ?? 0);
    const subCancelados = canc > 0
      ? `incluye ${canc} cancelado${canc === 1 ? '' : 's'} por ${moneyOSinMedir(k.monto_cancelado)}, fuera de los importes`
      : undefined;
    return [
      { label: 'Movimientos', value: String(k.movimientos ?? 0), sub: subCancelados },
      { label: 'Ingresos', value: money(k.ingresos) },
      { label: 'Gastos', value: money(k.gastos) },
      { label: 'Depósitos', value: money(k.depositos) },
    ];
  });

  ngOnInit(): void {
    /**
     * [CG.58.7] Una liga que manda a la pantalla y te deja buscando a mano no es una liga.
     * /comercial/ventas-por-ruta enlaza cada deposito de la caja fuerte con SU entrada aca, y
     * para eso manda el folio en ?q= con su dia en ?from=/?to= -- el rango por omision es el mes
     * en curso, asi que sin acotarlo un folio de hace dos meses no estaria en la lista.
     *
     * Se lee del snapshot y ANTES de cargar(): asignarlo despues dispararia dos consultas y la
     * primera traeria el rango equivocado. Y va antes de cargarCortes(), que desde [CG.181] cuelga
     * de ngOnInit y no de cargar(), para que la lista de cortes tome la misma ventana.
     *
     * ⚠️ La fecha se VALIDA antes de asignarse. Con basura (?from=ayer) el datepicker deja el
     * control vacio y la tabla sale sin filas: la pantalla se leeria como "no hubo movimientos"
     * cuando lo cierto es que la liga venia mal. Una ausencia se declara, no se dibuja -- asi que
     * una fecha que no es fecha se ignora y manda el rango por omision.
     */
    const RX_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
    const qp = this.rutaActiva.snapshot.queryParamMap;
    const qFolio = qp.get('q');
    const qFrom = qp.get('from');
    const qTo = qp.get('to');
    if (qFolio) this.search = qFolio;
    if (qFrom && RX_FECHA_ISO.test(qFrom)) this.from = qFrom;
    if (qTo && RX_FECHA_ISO.test(qTo)) this.to = qTo;

    this.cargarCobertura();
    this.cargar();
    this.cargarSaldo();
    this.cargarJornadasAtrasadas();
    this.cargarCortes();
    // CG.20/CG.21 — la bandeja y los frecuentes se piden al abrir: son la acción principal, no
    // algo que aparezca después de un clic.
    this.cargarCajas();
    this.cargarPendientes();
    this.cargarFrecuentes();
    // [CG.26] El cierre de la jornada se pide al abrir, como todo lo demás: si hubiera que pedirlo
    // con un clic, nadie cerraría el día.
    this.cargarArqueo();
    this.cargarRecurrentes();
    this.enVivo();
  }

  /**
   * ⚠️ El debounce del autofill NO lo cubre `takeUntilDestroyed`: la guarda vive en la
   * suscripción, y acá todavía no hay suscripción — hay un `setTimeout` pendiente que, si la
   * persona sale de la pantalla dentro de los 350 ms de haber tecleado, dispara `pedirPropuesta()`
   * sobre un componente ya destruido y recién ahí emite la petición. Se cancela el temporizador,
   * que es donde está el pendiente de verdad.
   */
  ngOnDestroy(): void {
    clearTimeout(this.debounce);
    if (this.folioTimer) clearTimeout(this.folioTimer);
    this.caja.disconnect();
  }

  // ── CG.23.2 · Que el movimiento aparezca solo ────────────────────────────────────────────────
  //
  // ⛔ Antes de esto, la pantalla NO SE REFRESCABA NUNCA: `cargarPendientes()` corría al entrar y
  // después de guardar, y nada más. Una caja abierta toda la mañana mostraba la foto del momento
  // en que se abrió, sin ningún aviso de que estaba vieja — que es exactamente cómo se ve una
  // bandeja sin trabajo.
  //
  // Van DOS caminos, y los dos hacen falta:
  //   · el rápido — `caja_changed` por WebSocket, que dispara el carril al refrescar el corte;
  //   · el lento — un repaso mientras la pestaña se ve, que es el que GARANTIZA.
  //
  // El lento no sobra: `NOTIFY` no se persiste y un socket caído no deja rastro, así que sin él
  // una desconexión de tres segundos sería un movimiento que no aparece nunca y nadie se entera.

  /** Firma del corte que la pantalla tiene delante. Si el aviso trae otra, hay que ir a buscar. */
  private firmaVista: string | null = null;

  private enVivo(): void {
    // ⛔ El canal en vivo va ENVUELTO, y el repaso queda FUERA del try. Es un extra: si no se
    // puede abrir —sin sesión, un proxy que bloquea el websocket, el backend sin desplegar— la
    // pantalla tiene que seguir funcionando. Sin esto, cualquier tropiezo del socket revienta
    // `ngOnInit` y la caja entera queda en blanco; medido acá mismo, un `AuthService` sin
    // `token()` tiraba las 46 pruebas del componente de una.
    try {
      this.caja.connect();
      this.suscribirCambios();
    } catch (e) {
      console.warn('[caja] sin avisos en vivo; queda el repaso:', e);
    }

    // El repaso. Es la red de seguridad, no el mecanismo — si el socket anda, la bandeja ya se
    // puso al día antes y esta consulta no encuentra nada nuevo. `encuestarVisible` pausa con la
    // pestaña oculta y se pone al día al volver.
    //
    // ⭐ `[CGS.6]` De 60 s a 20 s, y el motivo es que el socket NO cubre todo: `caja_movimientos`
    // lo dispara el refresh de `kdm1`/`kdb1`, y la cobranza que empuja una camioneta entra por
    // otro carril (tabla foránea del runner) que no avisa a nadie. Para ESA llegada el repaso es
    // el único mecanismo, así que su periodo es el techo de latencia. Medido el 2026-10-20: el
    // cobro de la ruta 26 aterrizó 17:02 y la pantalla no tenía forma de saberlo hasta el tick.
    encuestarVisible(20000, () => this.cargarPendientes(true), { destroyRef: this.destroyRef, zone: this.zone });
  }

  private suscribirCambios(): void {
    this.caja.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      const firma = e.firma ?? `${e.filas}|${e.max_folio}|${e.max_captura}`;
      // Comparar acá y no en el servidor: quien sabe qué está mostrando es la pantalla. Sin esto,
      // cada refresh del carril dispararía una consulta por pestaña abierta aunque nada cambiara.
      //
      // El aviso del libro (`origen: 'libro'`) viene SIN firma a propósito: lo dispara alguien que
      // acaba de guardar acá, y ahí sí hay que ir a ver sí o sí.
      if (e.origen === 'feed' && firma === this.firmaVista) return;
      this.firmaVista = firma;
      // Refresco de fondo (llegó un aviso): en silencio, sin prender el indicador de carga (evita el
      // micro-parpadeo de la bandeja en cada NOTIFY). El saldo no tiene indicador, va normal.
      this.cargarPendientes(true);
      this.cargarSaldo();
    });

    // `[CG.68]` Los tres avisos del emparejamiento.
    this.caja.firmaTomada$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.firmaTelefonoListo.set(true);
    });
    this.caja.firmaRecibida$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((f) => {
      if (f.codigo !== this.firmaCodigo()) return;   // no es la nuestra
      this.firmaRemotaPng.set(f.png);
      this.firmaRemotaMonto.set(Number(f.monto_firmado) || 0);
      if (f.nombre && !this.firmaNombre().trim()) this.firmaNombre.set(f.nombre);
      this.firmaHecha.set(true);
      this.firmaCodigo.set(null);
      this.firmaTelefonoListo.set(false);
    });
    this.caja.firmaCortada$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.codigo !== this.firmaCodigo()) return;
      this.firmaCerrarRemota();
      // ⚠️ Se avisa: si no, el cajero se queda mirando un codigo que ya no sirve.
      this.firmaAviso.set('Se cortó la conexión con el teléfono. Pide un código nuevo o firma acá.');
    });
    /**
     * ⭐⭐ `[CG.196]` **EL TELÉFONO SE FUE, LA FIRMA NO.**
     *
     * Acá estaba el defecto que Edgar reportó: al bloquearse el teléfono, el servidor emitía
     * `firma:cortada` y esta pantalla llamaba a `firmaCerrarRemota()` — que borra el código, el
     * pase y el QR, **y encima le manda `firma:cerrar` al servidor**. O sea que una pantalla
     * apagada destruía el emparejamiento, y el mismo teléfono al volver recibía `no_existe`.
     *
     * ⛔ **No se desarma nada.** El emparejamiento vive en el socket de la PC, que sigue acá: el
     * código sigue siendo reclamable y el QR en pantalla sigue sirviendo. Lo único que cambia es
     * que vuelve a estar libre —al caer su socket, el teléfono salió de la room, así que
     * `decidirTomar` ya no lo ve como `ya_tomado`— y por eso se baja `firmaTelefonoListo`.
     *
     * ⚠️ Se dice, igual que todo lo demás: sin el aviso, el cajero ve el «listo» apagarse solo y
     * no sabe si tiene que hacer algo. Acá no tiene que hacer nada más que esperar.
     */
    this.caja.firmaTelefonoSalio$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.codigo !== this.firmaCodigo()) return;
      this.firmaTelefonoListo.set(false);
      this.firmaAviso.set('El teléfono se desconectó. El código sigue sirviendo: que vuelva a escanear el QR.');
    });
  }

  // ── Avisos ───────────────────────────────────────────────────────────────────────────────────
  //
  // ⛔ La pantalla NO TENÍA NINGUNO: cero MessageService, cero p-toast en 1,132 líneas. Guardar,
  // abrir corte, cerrar, autorizar y confirmar el lote fallaban en silencio — la persona hacía
  // clic y no pasaba nada, indistinguible de un botón muerto. Tres de esas cinco ni siquiera
  // tenían rama `error`, así que el fallo no llegaba a ningún lado.

  // `[CGP-V.5]` La frase sale de una función pura con pruebas: un 403 con frase del servidor (la
  // doble llave) se dice tal cual, y sólo el 403 genérico se traduce a «no tenés permiso».
  private textoError(e: unknown): string { return textoDeError(e); }

  /**
   * `[CGP-V.5]` **El error se queda donde se hizo la acción, y no se va solo.** Antes todo salía en
   * un aviso de 7 s: el diálogo de cierre no conservaba ningún error y la persona volvía a intentar
   * sin saber qué había pasado. Cada uno se limpia al volver a intentar.
   */
  errorCierre = signal<string | null>(null);
  /** El de abrir: dentro del diálogo de apertura si está abierto, si no junto al botón del cierre. */
  errorApertura = signal<string | null>(null);
  /** El de autorizar, en la fila de ESE corte. */
  errorAutorizar = signal<{ id: string; texto: string } | null>(null);

  private avisarError(e: unknown, titulo: string): void {
    this.toast.add({ severity: 'error', summary: titulo, detail: this.textoError(e), life: 7000 });
  }

  private avisarOk(titulo: string, detalle?: string): void {
    this.toast.add({ severity: 'success', summary: titulo, detail: detalle, life: 4000 });
  }

  cargarCobertura(): void {
    this.svc.cobertura().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => {
        this.cobertura.set(c.catalogo ?? []);
        // `[CG.180]` Se copia tal cual, incluido el `undefined`: el campo ausente dice "esta
        // version del servidor no lo sabe" y no puede confundirse con una copia vacia.
        this.autofill.set(c.autofill);
        this.coberturaSinMedir.set(false);
      },
      // Un error de red NO puede verse como "no hay conceptos": se DECLARA sin medir. Antes se
      // vaciaba la lista, y entonces el subtítulo decía "sin medir" mientras el aviso de abajo
      // afirmaba "No hay conceptos de Kepler" — dos frases contradictorias sobre el mismo hecho.
      // `[CG.180]` El autofill también vuelve a `undefined`: con la petición caída no sabemos si
      // la copia está vacía, y dejar el valor viejo publicaría una medición que ya no se hizo.
      error: () => { this.cobertura.set([]); this.autofill.set(undefined); this.coberturaSinMedir.set(true); },
    });
  }

  // ── `[CGS.18]` Responder una observación ────────────────────────────────────────────────
  /** Los cortes que la supervisora devolvió. Salen de la lista de cortes del periodo cargado. */
  readonly observados = computed<CorteCaja[]>(() => this.cortes().filter((c) => c.estado === 'observado'));
  readonly respondiendo = signal<CorteCaja | null>(null);
  readonly textoRespuesta = signal('');
  readonly enviandoRespuesta = signal(false);
  readonly errRespuesta = signal<string | null>(null);

  abrirRespuesta(c: CorteCaja): void {
    this.respondiendo.set(c); this.textoRespuesta.set(''); this.errRespuesta.set(null);
  }
  cerrarRespuesta(): void {
    if (this.enviandoRespuesta()) return;
    this.respondiendo.set(null);
  }
  enviarRespuesta(): void {
    const c = this.respondiendo();
    const texto = this.textoRespuesta().trim();
    if (!c || texto.length < 10 || this.enviandoRespuesta()) return;
    this.enviandoRespuesta.set(true); this.errRespuesta.set(null);
    this.svc.responderCorte(c.id, texto).subscribe({
      next: () => {
        this.enviandoRespuesta.set(false); this.respondiendo.set(null);
        this.avisarOk('Respuesta enviada', `${c.folio} vuelve a la supervisora`);
        this.cargarCortes();
      },
      error: (e) => { this.enviandoRespuesta.set(false); this.errRespuesta.set(this.textoError(e)); },
    });
  }

  /** `[CGS.14]` El candado para quien está acá. `null` = todavía no se midió: no se afirma libre ni bloqueado. */
  readonly candadoCaja = signal<CandadoCaja | null>(null);
  cargarCandado(): void {
    this.svc.candado().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => this.candadoCaja.set(c),
      error: () => this.candadoCaja.set(null),
    });
  }

  cargarCortes(): void {
    this.cargandoCortes.set(true);
    this.svc.cortes({ from: this.from, to: this.to, limit: 50 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.cortes.set(r.rows ?? []); this.errCortes.set(null); this.cargandoCortes.set(false); },
      error: (e) => { this.cortes.set([]); this.errCortes.set(this.textoError(e)); this.cargandoCortes.set(false); },
    });
  }

  sevEstadoCorte(e: string): 'secondary' | 'warn' | 'danger' | 'success' {
    // `[CGS.18]` Un observado NO es verde: caía en la rama final y se pintaba como autorizado.
    if (e === 'observado') return 'danger';
    return e === 'borrador' ? 'secondary' : e === 'cerrado' ? 'warn' : e === 'autorizado' ? 'success' : 'secondary';
  }

  // Lo que se PINTA no es el enum de la columna. La pantalla publicaba `deposito`, `borrador` y
  // `sin_contar` tal cual, en minúscula y con guion bajo, en una pantalla que presume de usar
  // "los mismos nombres que la gente ya usa".
  etiquetaTipo(t: string): string { return ETIQUETA_TIPO[t] ?? t; }
  etiquetaEstadoCorte(e: string): string { return ETIQUETA_ESTADO_CORTE[e] ?? e; }
  etiquetaVeredicto(v: string | undefined): string { return v ? (ETIQUETA_VEREDICTO[v] ?? v) : '—'; }

  /**
   * La doble llave, en el boton. El sub del JWT es el MISMO id que el backend guarda en
   * closed_by (el controller resuelve id ?? sub ?? userId), asi que la comparacion es
   * valida. El candado real esta en la DB: esto solo evita el 403 sorpresa.
   */
  gateAutorizar(c: CorteCaja) {
    // `[CGP-V.6]` Primero el permiso: sin él, el botón terminaba en un 403.
    if (!this.puedeAutorizarPorPermiso()) {
      return { ok: false, texto: 'Autorizar necesita el permiso «Autorizar corte de Caja General».' };
    }
    return puedeAutorizarUI(c as unknown as CorteVista, this.auth.user()?.sub ?? null);
  }

  // ── `[CGP-V.6]` Los botones dependen del permiso, y lo dicen ─────────────────────────────────
  //
  // Quien sólo tenía VER veía «Rendir cuentas», y la fila del corte ofrecía «Autorizar» a quien no
  // podía: el clic terminaba en un 403. ⚠️ Sin permisos cargados NO se bloquea: «todavía no sé» no
  // es «no tiene», y el candado de verdad es el servidor.
  puedeGestionar = computed(() => {
    const cargado = this.perms.cargado();
    const tiene = this.perms.has(Permission.FINANCE_CAJA_GESTIONAR);
    return !cargado || tiene;
  });
  puedeAutorizarPorPermiso = computed(() => {
    const cargado = this.perms.cargado();
    const tiene = this.perms.has(Permission.FINANCE_CAJA_AUTORIZAR);
    return !cargado || tiene;
  });

  autorizar(c: CorteCaja): void {
    if (!this.gateAutorizar(c).ok || this.autorizando()) return;
    this.autorizando.set(true); this.errorAutorizar.set(null);
    this.svc.autorizarCorte(c.id).subscribe({
      next: () => { this.autorizando.set(false); this.avisarOk('Corte autorizado', c.folio); this.cargarCortes(); },
      // `[CGP-V.5]` En la fila de ESE corte, con la frase (la doble llave), y hasta el siguiente intento.
      error: (e) => { this.autorizando.set(false); this.errorAutorizar.set({ id: c.id, texto: this.textoError(e) }); },
    });
  }

  /** Sucursal del corte. Por ahora fija; cuando haya selector de corte, sale de ahí. */
  private sucursalActiva = SUCURSAL_CAJA_GENERAL;

  cargarSaldo(): void {
    // `[CGP-V.4]` El servicio ya reintenta solo un 429; esto marca que la lectura está en vuelo.
    this.cargandoSaldo.set(true);
    this.svc.saldo(this.sucursalActiva).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.saldoResp.set(r); this.cargandoSaldo.set(false); },
      // Un error de red NO es "saldo 0": se declara como sin medir. Y la barra de arriba ya NO
      // pinta "Abrir corte" en ese caso — no sabemos si hay uno abierto.
      error: () => { this.saldoResp.set(null); this.cargandoSaldo.set(false); },
    });
  }

  // ── [CG.26] El cierre de la jornada ──────────────────────────────────────────────────────
  //
  // ⭐ Va SEPARADO de `cargarSaldo()` a propósito: aquél depende de que haya corte abierto y esto
  // no. El panel de "Arqueo final del día" colgaba de `corteAbierto()` y en prod hay CERO cortes,
  // así que no lo vio nunca nadie.

  /** La jornada que se está mirando. Hoy en MÉXICO, no en UTC (a las 18:00 locales ya es mañana). */
  arqueoFecha = signal(todayMx());
  arqueo = signal<ArqueoDia | null>(null);
  /** `null` NO es "el día está en cero": es que no se pudo medir, y la pantalla lo dice. */
  arqueoSinMedir = computed(() => this.arqueo() === null);
  cargandoArqueo = signal(false);

  cargarArqueo(): void {
    this.cargandoArqueo.set(true);
    this.svc.arqueoDia({ fecha: this.arqueoFecha(), sucursal: this.sucursalActiva }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.arqueo.set(r); this.cargandoArqueo.set(false); },
      error: () => { this.arqueo.set(null); this.cargandoArqueo.set(false); },
    });
  }

  /**
   * ⭐ `[CG.29]` **RENDIR CUENTAS DE LA JORNADA, en un solo gesto.**
   *
   * ── El defecto que arregla, y es de diseño, no de código ────────────────────────────────
   * El arqueo exigía **abrir el corte primero**, con su fondo inicial. O sea: una acción a las
   * 8 de la mañana que habilita otra a las 7 de la tarde. Si nadie la hizo —y **nadie la hizo
   * nunca: hay CERO cortes en producción**— al final del día no hay nada que cerrar, y el único
   * botón a la vista dice *"Abrir corte"*, que a las 7 pm parece la acción equivocada.
   *
   * Acá el gesto es uno solo y en el momento natural: si falta el corte, se pide el fondo con el
   * que arrancó la caja y **se encadena directo al conteo**. Si ya estaba abierto, va derecho.
   *
   * ⛔ No se afloja ningún candado. El conteo sigue siendo CIEGO (el esperado se revela al
   * sellar, CG.19) y la doble llave sigue puesta: quien cierra **no** puede autorizar.
   */
  cerrarJornada(): void {
    // `[CGP-V.4]` Con el saldo en vuelo no se sabe todavía si hay un corte abierto.
    if (this.abriendo() || this.cargandoSaldo() || !this.puedeGestionar()) return;
    if (this.corteAbierto()) { this.abrirCierre(); return; }
    /**
     * ⭐⭐ `[CG.90.1]` **EL FONDO DEJA DE PREGUNTARSE. NI SIQUIERA EL DIÁLOGO.**
     *
     * Edgar, con el diálogo a la vista por segunda vez: *"sigue pidiendo el fondo inicial"*.
     * Tenía razón: `[CG.90]` enseñó al SERVIDOR a heredarlo del cierre anterior, pero la pantalla
     * seguía abriendo «Con cuánto arrancó la caja» igual — o sea que el cambio no se notaba.
     * Arreglar que el servidor sepa algo no sirve si la pantalla pregunta antes.
     *
     * Ahora se abre derecho y el servidor decide:
     *   · hay cierre anterior → hereda su `contado` y marca `cierre_anterior`;
     *   · no hay → abre con `sin_medir` y el aviso lo DICE («el arqueo no va a poder decir si
     *     cuadra»), que es un hecho distinto de «arrancó en cero».
     *
     * ⛔ Y `undefined`, no `null`: `abrirCorte()` manda `fondoInicial() ?? undefined` porque el
     * servicio compara contra `undefined`. Dejarlo en `null` haría que el fondo viaje como un
     * valor y la herencia NO se dispare — el mismo tipo de detalle que hizo que `[CG.90]` no se
     * viera.
     *
     * ⚠️ La puerta queda: `abrirApertura()` sigue existiendo y se alcanza desde el aviso de
     * «sin fondo medido», para quien SÍ sabe con cuánto arrancó y quiere declararlo.
     */
    this.cerrarTrasAbrir.set(true);
    this.fondoInicial.set(null);
    this.abrirCorte();
  }

  /** Marca que la apertura vino de "rendir cuentas": al confirmarla se sigue al conteo. */
  private cerrarTrasAbrir = signal(false);

  // ── `[CGP-V.3]` Las jornadas atrasadas ─────────────────────────────────────────────────────
  //
  // ⛔ El 13 y el 14-oct no tenían camino: la pantalla SIEMPRE abría el corte de hoy, y abrir hoy
  // primero los deja huérfanos — `[CGP-L.4]` rechaza abrir una jornada anterior a un corte que ya
  // existe. Ahora se cierran desde acá, de la más vieja a la más nueva.
  //
  // Cuatro estados y no dos, porque se resuelven distinto:
  //   · `midiendo`   — todavía no se sabe: el botón espera;
  //   · `medido`     — la lista del servidor (vacía = al día);
  //   · `sin_medir`  — falló la consulta: NO se abre hoy a ciegas, se ofrece reintentar;
  //   · `no_informa` — 404, un API anterior a `[CGP-L.4]`. No lista jornadas, pero tampoco tiene la
  //     regla que las deja huérfanas: abrir hoy ahí es lo que ya pasaba. Trabar el cierre de caja por
  //     un 404 sería peor que lo que evita.

  jornadasAtrasadas = signal<
    { estado: 'midiendo' | 'sin_medir' | 'no_informa' } | { estado: 'medido'; datos: JornadasPendientes }
  >({ estado: 'midiendo' });

  cargarJornadasAtrasadas(): void {
    // `[CGS.14]` El candado se recalcula cada vez que cambian las jornadas: abrir, cerrar, capturar.
    this.cargarCandado();
    this.jornadasAtrasadas.set({ estado: 'midiendo' });
    this.svc.jornadasPendientes(this.sucursalActiva).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (datos) => this.jornadasAtrasadas.set({ estado: 'medido', datos }),
      error: (e: { status?: number }) =>
        this.jornadasAtrasadas.set({ estado: e?.status === 404 ? 'no_informa' : 'sin_medir' }),
    });
  }

  /** El reintento re-mide las DOS cosas de las que depende abrir un corte. */
  reintentarCierre(): void { this.cargarSaldo(); this.cargarJornadasAtrasadas(); }

  /** Las atrasadas medidas, de la más vieja a la más nueva. Vacía también cuando no se midió. */
  atrasadas = computed(() => {
    const a = this.jornadasAtrasadas();
    return a.estado === 'medido' ? a.datos.jornadas : [];
  });

  /**
   * Hoy según el SERVIDOR cuando se pudo medir: es el reloj con el que rechaza una fecha futura.
   * Sin la lista, el del navegador en hora de México.
   */
  hoyCaja = computed(() => {
    const a = this.jornadasAtrasadas();
    return a.estado === 'medido' ? a.datos.hoy : todayMx();
  });

  /**
   * La jornada que abre un corte nuevo — por cualquiera de las dos puertas: la atrasada más vieja,
   * o hoy. `null` = no se sabe, y entonces no se abre nada.
   */
  fechaParaAbrir = computed<string | null>(() => {
    const a = this.jornadasAtrasadas();
    if (a.estado === 'medido') return a.datos.jornadas[0]?.fecha ?? a.datos.hoy;
    if (a.estado === 'no_informa') return todayMx();
    return null;
  });

  /**
   * Con corte abierto, la lista no hace falta: el botón va a ESE corte. Sin corte, no saber si hay
   * atrasadas se trata como no saber si hay corte — se reintenta.
   */
  cierreSinMedir = computed(() => {
    const saldo = this.saldoSinMedir();
    const c = this.corteAbierto();
    const estado = this.jornadasAtrasadas().estado;
    return saldo || (!c && estado === 'sin_medir');
  });

  midiendoAtrasadas = computed(() => {
    const c = this.corteAbierto();
    const estado = this.jornadasAtrasadas().estado;
    return !c && estado === 'midiendo';
  });

  /** La etiqueta nombra la jornada cuando no es la de hoy: el gesto no cambia, el día sí. */
  etiquetaCierre = computed(() => {
    const c = this.corteAbierto();
    const hoy = this.hoyCaja();
    const destino = this.fechaParaAbrir();
    if (c) return c.fecha && c.fecha < hoy ? `Rendir cuentas del ${diaCorto(c.fecha)}` : 'Rendir cuentas del día';
    return destino && destino < hoy ? `Rendir cuentas del ${diaCorto(destino)}` : 'Cerrar jornada y rendir cuentas';
  });

  textoAtrasadas = computed(() => {
    const atr = this.atrasadas();
    if (!atr.length) return '';
    const lista = atr
      .map((j) => `${diaCorto(j.fecha)} (${j.movimientos} ${j.movimientos === 1 ? 'movimiento' : 'movimientos'})`)
      .join(', ');
    return `${atr.length === 1 ? 'Hay una jornada sin corte' : `Hay ${atr.length} jornadas sin corte`}: ${lista}.`;
  });

  /** El diálogo de apertura lo dice cuando no abre la jornada de hoy. */
  aperturaAtrasada = computed(() => {
    const destino = this.fechaParaAbrir();
    const hoy = this.hoyCaja();
    return destino && destino < hoy ? diaCorto(destino) : null;
  });

  /** `Corte CC-… · jornada del 12-oct`. Sin fecha (API viejo), sólo el folio. */
  rotuloCorte = computed(() => {
    const c = this.corteEnCierre();
    if (!c) return null;
    return c.fecha ? `Corte ${c.folio} · jornada del ${diaCorto(c.fecha)}` : `Corte ${c.folio}`;
  });

  corteAtrasado = computed(() => {
    const c = this.corteEnCierre();
    const hoy = this.hoyCaja();
    return !!c?.fecha && c.fecha < hoy;
  });

  /**
   * ⭐⭐ `[CGP-V.3b]` **Confirmar que el efectivo contado ES de la jornada del corte.**
   *
   * ── El defecto que esto cierra, medido ──────────────────────────────────────────────────
   *
   * «Cerrar jornada y rendir cuentas» abre **la jornada atrasada más vieja** (`[CGP-V.3]`), no la
   * de hoy. O sea que la pantalla pide contar el efectivo **antes** de decidir a qué día se pega
   * ese conteo — y cuando hay atraso, lo pega al día equivocado sin que nada avise.
   *
   * Medido en prod el 2026-10-20 contra tres fotos del usuario y los arqueos de Control:
   *
   *     corte del 12-oct  sello $3,653.50  = el conteo del 13 (idéntico pieza por pieza)
   *     corte del 13-oct  sello $57,571.00 = el conteo del 15
   *     corte del 14-oct  sello $24,960.00 = sin corroboración en ningún lado
   *     corte del 15-oct  sello $11,820.00 = sin corroboración en ningún lado
   *     ──────────────────────────────────────────────────────────────────────
   *     4 de 7 cortes con el conteo de otro día · $19,811.50 de diferencia
   *
   * ⭐ El 16 y el 17 cuadran al centavo con Control: **el procedimiento funciona cuando no hay
   * atraso.** Lo que falla es exactamente el caso que esta confirmación cubre.
   *
   * ⚠️ Se pide **sólo con jornada atrasada**. Pedirla todos los días la volvería un clic reflejo
   * —el usuario la tildaría sin leer— y entonces no defendería nada el día que importa.
   *
   * ⛔ Y no reemplaza al aviso: el aviso DICE y esto EXIGE. Un aviso que no frena nada es lo que
   * ya había (`<small class="fin-dim">`) y es lo que no alcanzó.
   */
  jornadaConfirmada = signal(false);

  /** El día del corte que se está cerrando, para nombrarlo en la confirmación. */
  diaDelCorte = computed(() => {
    const f = this.corteEnCierre()?.fecha;
    return f ? diaCorto(f) : '';
  });

  // ── `[CGP-V.1]` En qué paso va el corte ────────────────────────────────────────────────────
  //
  // El paso sale de lo que dice el servidor: corte abierto, conteo sellado, corte por autorizar.
  // La decisión es pura (`pasoDelCorte`) y tiene sus pruebas; acá sólo se le pasa el estado.

  /** El último corte del cajón, si quedó cerrado y nadie lo autorizó todavía. */
  cortePorAutorizar = computed(() => {
    const cs = this.cortes();
    const ultimo = cs
      .filter((c) => c.sucursal === this.sucursalActiva)
      .reduce<CorteCaja | null>((a, c) => (!a || c.fecha > a.fecha ? c : a), null);
    return ultimo?.estado === 'cerrado' ? ultimo : null;
  });

  pasoCorte = computed<PasoCorte | null>(() => {
    const c = this.corteEnCierre();
    const sinMedir = this.saldoSinMedir();
    const r = this.revelacion();
    const ofrece = this.ofreceRecontar();
    const cf = this.conflictoEsperado();
    const re = this.recontando();
    const pa = this.cortePorAutorizar();
    return pasoDelCorte({
      corteAbierto: c ? true : sinMedir ? null : false,
      sellado: r ? { ofreceRecontar: ofrece } : null,
      conflicto: !!cf,
      porAutorizar: !!pa,
      recontando: re,
    });
  });

  /** En la página: sin saldo medido no se afirma ningún paso (la etiqueta ya dice «sin medir»). */
  pasoPagina = computed<PasoCorte | null>(() => {
    const sinMedir = this.saldoSinMedir();
    const p = this.pasoCorte();
    return sinMedir ? null : p;
  });

  textoPasoPagina = computed(() => {
    const p = this.pasoPagina();
    const pa = this.cortePorAutorizar();
    return p ? textoPaso(p, pa?.folio) : '';
  });

  /**
   * `[CG.29]` El subtítulo de la página: el estado de HOY, no la cobertura del catálogo.
   *
   * ⚠️ Los tres estados se dicen distinto a propósito. "Sin medir" no es "todo al día", y
   * "rendiste cuentas" no es lo mismo que "no hay nada que confirmar".
   */
  /**
   * ⛔ `[CG.47]` **El subtítulo repetía lo que la sección ya dice, cinco centímetros más abajo.**
   * Decía *"1,986 por confirmar · 0 de las 100 que se ven son de un clic · todavía no rendiste
   * cuentas"* mientras la cabecera de la bandeja decía *"0 de 100 se confirman de un clic"*. El
   * mismo hecho, dos veces, con dos redacciones distintas — que es exactamente el defecto que
   * `[CG.30.1]` arregló y que `[CG.45]` reintrodujo al mover la cifra a la sección sin sacarla de
   * acá.
   *
   * Reparto: **el subtítulo dice el UNIVERSO y el estado del día** (lo que no cabe en ninguna
   * sección); **la cabecera de la bandeja dice lo accionable** (cuántas se confirman de un clic),
   * que es donde está el botón que lo usa.
   */
  subtituloJornada = computed(() => {
    const enPagina = this.pendientes().length;
    const total = this.totalPend();
    const n = (v: number) => v.toLocaleString('es-MX');
    /**
     * ⛔ `[CG.30]` Acá decía `${pend} de ${total}` donde `total` era `pendientes().length` — o sea
     * **el tamaño de la página, no el trabajo**. Medido: la pantalla publicaba «31 de 100»
     * teniendo **1,887** en esa caja y **12,793** en total. Dos centímetros a la derecha, su propio
     * selector decía `CAJA GENERAL (1887)`.
     *
     * Ahora manda el universo. El «de un clic» se conserva pero **declarando su alcance**: es sobre
     * las filas que se ven, porque saberlo del total exigiría resolver la cuenta de las 12,793 y
     * extrapolar el porcentaje de la página sería inventar (ADR-056).
     */
    const trabajo = this.cargandoPend()
      ? 'Midiendo lo que falta confirmar…'
      : total === 0 || (total === null && enPagina === 0)
        ? 'Nada por confirmar en la ventana'
        : total === null
          // Sin total medido NO se afirma un universo: se declara que no se midió. Antes acá se
          // caía a «N de las M que se ven», que es justo la frase de la sección de abajo.
          ? 'Sin medir cuántos faltan por confirmar'
          : `${n(total)} por confirmar`;
    if (this.saldoSinMedir()) {
      return this.cargandoSaldo()
        ? `${trabajo} · midiendo si hay corte abierto…`
        : `${trabajo} · no se pudo medir si hay corte abierto`;
    }
    const c = this.corteAbierto();
    // [CGP-V.3] Las atrasadas van acá: el subtítulo es lo único que se ve sin abrir la ventana.
    const atr = this.atrasadas();
    const atrasadas = atr.length
      ? ` · ${atr.length === 1 ? 'una jornada' : `${atr.length} jornadas`} sin corte desde el ${diaCorto(atr[0].fecha)}`
      : '';
    if (c) return `${trabajo} · corte ${c.folio} abierto, falta rendir cuentas${atrasadas}`;
    return atr.length ? `${trabajo}${atrasadas}` : `${trabajo} · todavía no rendiste cuentas de esta jornada`;
  });

  /**
   * El `Date` que pide `<p-datepicker>`, derivado de la clave `YYYY-MM-DD` que esta pantalla
   * guarda y le manda al API. La clave sigue siendo la fuente de verdad: el calendario es
   * presentación, y el almacenamiento no cambia de tipo.
   *
   * ⛔ Se MEMOIZA por la clave, y no es microoptimización. Un `new Date(...)` evaluado en la
   * plantilla devuelve un objeto NUEVO en cada ciclo de detección, así que `ngModel` ve el
   * modelo cambiado en cada tick y el calendario puede re-renderizarse o cerrarse encima de la
   * persona mientras elige. Misma clave, misma instancia.
   *
   * ⚠️ Parsea con `parseLocalDate` (medianoche LOCAL) y NO con `new Date(iso)`, que parsea UTC
   * y en México cae al día ANTERIOR después de las 18:00 — el gotcha que documenta `mx-date.ts`.
   */
  private readonly _fechaD = new Map<string, Date>();
  fechaD(clave: string | null | undefined): Date | null {
    const k = (clave || '').slice(0, 10);
    if (!k) return null;
    let d = this._fechaD.get(k);
    if (!d) {
      const p = parseLocalDate(k);
      if (!p) return null;
      // El cache vive lo que la sesión y sólo crece con las fechas que la persona elige.
      if (this._fechaD.size > 64) this._fechaD.clear();
      d = p;
      this._fechaD.set(k, d);
    }
    return d;
  }

  /**
   * La vuelta: del `Date` del calendario a la clave de texto.
   *
   * ⛔ NO usa `toMxDateKey`, y la diferencia cambia el día. Ese helper traduce un INSTANTE a su
   * día en México; lo que devuelve el calendario no es un instante sino un DÍA a medianoche
   * LOCAL. Con el navegador fuera de MX, pasarlo por la zona horaria lo corre uno hacia atrás.
   * Acá se leen los componentes locales, que es el inverso EXACTO de `parseLocalDate`.
   */
  claveDe(d: Date | null | undefined): string {
    if (!d || isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return String(d.getFullYear()) + '-' + mm + '-' + dd;
  }

  /** Desde/Hasta del libro. Van juntos acá para no asignar campos desde la plantilla. */
  // `[CG.181]` El RANGO es el insumo de las dos listas, así que mover una fecha recarga las dos.
  // Antes los cortes colgaban del `next` de `cargar()`: se repetían en el arranque (429) y no se
  // recargaban nunca si el libro fallaba.
  setDesde(d: Date | null): void { const k = this.claveDe(d); if (k) { this.from = k; this.cargar(); this.cargarCortes(); } }
  setHasta(d: Date | null): void { const k = this.claveDe(d); if (k) { this.to = k; this.cargar(); this.cargarCortes(); } }

  setArqueoFecha(v: string): void {
    if (!v) return;
    this.arqueoFecha.set(String(v).slice(0, 10));
    this.cargarArqueo();
  }

  // ── [CG.27-B.1/B.3] Los que repiten y nadie declaró su cuenta ────────────────────────────

  recurrentes = signal<RecurrentesResponse | null>(null);
  /** Nace PLEGADO: son 57 filas. Lo que va siempre a la vista es el CONTADOR, no la tabla. */
  recAbierto = signal(false);

  cargarRecurrentes(): void {
    this.svc.recurrentesSinRegla().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // `null` NO es "no hay ninguno": la cabecera lo declara como sin medir.
      next: (r) => this.recurrentes.set(r),
      error: () => this.recurrentes.set(null),
    });
  }

  textoRecurrentes(rc: RecurrentesResponse): string {
    const m = rc.medido;
    if (!m.sin_regla) return `Los ${m.recurrentes} que repiten ya tienen su cuenta declarada.`;
    const caidos = m.caidos ? ` · ${m.caidos} dejaron de cobrar` : '';
    // Se dice cuántos puede proponer la contabilidad y cuántos NO, porque son dos trabajos
    // distintos: uno es confirmar, el otro es decidir.
    return `${m.sin_regla} de ${m.recurrentes} · ${m.pagos_sin_regla} pagos en ${rc.ventana_dias} días `
      + `· ${m.con_propuesta_contable} con propuesta, ${m.sin_de_donde_proponer} sin de dónde${caidos}`;
  }

  /** ⭐ El CV decide qué se le puede proponer. Debajo de 0.6 el importe casi no se mueve. */
  esImporteProponible(r: RecurrenteSinRegla): boolean {
    return r.cv_importe !== null && r.cv_importe < 0.6;
  }

  textoImporte(r: RecurrenteSinRegla): string {
    // ⚠️ `null` y `0` son cosas distintas: 0 es "siempre el mismo importe" (la señal más fuerte),
    // `null` es "no se pudo medir". Pintarlos igual sería perder justo la mejor señal.
    if (r.cv_importe === null) return 'sin medir';
    if (r.cv_importe < 0.6) return `~${money(r.promedio)} fijo`;
    if (r.cv_importe < 2) return 'variable';
    return 'muy variable';
  }

  pctDominancia(p: { dominancia: number }): number {
    return Math.round(p.dominancia * 100);
  }

  /**
   * Abre la captura con el beneficiario puesto. Declarar la regla es el checkbox que YA existe
   * ahí (CG.22.6): no se inventa una segunda puerta para lo mismo.
   */
  declararDesdeRecurrente(r: RecurrenteSinRegla): void {
    this.abrirCaptura();
    this.setF('tipo', 'gasto' as TipoMovimiento);
    this.setF('beneficiario', r.beneficiario);
    // Si la contabilidad tiene su par, se ofrece — con su respaldo a la vista, nunca pelado.
    if (r.propuesta_contable) {
      this.setF('kepler_cuenta', r.propuesta_contable.kepler_cuenta);
      this.setF('kepler_concepto', r.propuesta_contable.kepler_concepto);
      this.conceptoManual.set(true);
    }
    this.pedirPropuesta();
  }

  abrirApertura(): void { this.fondoInicial.set(null); this.errorApertura.set(null); this.abrirConFoco(this.aperturaAbierta); }

  /** Si se cancela la apertura, la intención de cerrar NO queda colgada esperando. */
  cancelarApertura(): void { this.cerrarTrasAbrir.set(false); this.cerrarConFoco(this.aperturaAbierta); }

  abrirCorte(): void {
    if (this.abriendo() || !this.puedeGestionar()) return;
    this.errorApertura.set(null);
    /**
     * ⭐ `[CGP-V.3]` La jornada la decide `fechaParaAbrir()`, y se decide ACÁ y no en cada botón:
     * a este método llegan las dos puertas — «rendir cuentas» y «Declarar con cuánto arrancó la
     * caja» —, y cualquiera de las dos que abriera hoy dejaría huérfanas a las atrasadas.
     */
    /**
     * ⛔ `[CGP-V.4]` Sin saldo medido no se sabe si ya hay un corte abierto, y abrir otro encima es
     * el peor final (la base lo rechaza, pero con su error). Vale para las dos puertas: la de
     * «Declarar con cuánto arrancó la caja» no pasaba por ningún freno de saldo.
     */
    if (this.saldoSinMedir() || this.cargandoSaldo()) {
      this.cerrarTrasAbrir.set(false);
      this.errorApertura.set('No se abrió el corte: todavía no se sabe si ya hay uno abierto. Espera a que termine de medir o reintenta.');
      return;
    }
    const fecha = this.fechaParaAbrir();
    if (!fecha) {
      this.cerrarTrasAbrir.set(false);
      this.errorApertura.set('No se abrió el corte: no se pudo saber si hay jornadas sin corte antes de hoy. Reintenta antes de abrir.');
      return;
    }
    this.abriendo.set(true);
    this.svc.abrirCorte({
      // La atrasada más vieja, o el hoy del SERVIDOR. Sin la lista (404), `todayMx()` — nunca
      // `toISOString()`, que después de las 18:00 hora de México ya devuelve mañana.
      fecha,
      sucursal: this.sucursalActiva,
      // `null` → `undefined`: es la forma exacta que `abrir()` traduce a `NULL` + `sin_medir`.
      // Mandar `null` NO sirve: el servicio compara contra `undefined`.
      fondo_inicial: this.fondoInicial() ?? undefined,
    }).subscribe({
      next: (abierto) => {
        this.abriendo.set(false);
        this.aperturaAbierta.set(false);
        const f = this.fondoInicial();
        this.avisarOk('Corte abierto', f == null
          ? 'Sin fondo inicial medido: el arqueo no va a poder decir si cuadra.'
          : `Fondo inicial ${money(f)}`);
        this.cargarSaldo(); this.cargarCortes(); this.cargarArqueo(); this.cargarJornadasAtrasadas();
        // [CG.29] Si la apertura vino de "rendir cuentas", se sigue DERECHO al conteo: el gesto
        // es uno solo. Sin esto la persona quedaba con el corte abierto y sin saber que le
        // faltaba un segundo clic en otro lado.
        // [CGP-V.2] El corte va de la RESPUESTA: el saldo que lo trae todavía no volvió. La fecha es
        // la que se pidió abrir (la fila trae un Date, que por JSON llega con hora).
        if (this.cerrarTrasAbrir()) {
          this.cerrarTrasAbrir.set(false);
          this.abrirCierre(abierto?.id ? { id: abierto.id, folio: abierto.folio, fecha } : null);
        }
      },
      /**
       * ⛔ `[CG.90.1]` **LA INTENCIÓN SE LIMPIA TAMBIÉN CUANDO FALLA.**
       *
       * Antes `cerrarTrasAbrir` se ponía al abrir el diálogo y `cancelarApertura()` lo limpiaba.
       * Al quitar el diálogo (`cerrarJornada` llama derecho a `abrirCorte`), ese camino de
       * limpieza desapareció: si la apertura fallaba, la intención quedaba colgada en `true` y
       * **el siguiente corte que alguien abriera por su cuenta saltaba al conteo solo**.
       *
       * Lo cazó la prueba negativa que ya existía para el defecto equivalente del diálogo. Un
       * freno puesto para una puerta sirvió para la otra — por eso se conserva en vez de borrarla
       * cuando cambia el gesto.
       */
      error: (e) => {
        this.abriendo.set(false);
        this.cerrarTrasAbrir.set(false);
        // `[CGP-V.5]` Con su frase y donde se intentó, no en un aviso de 7 s.
        this.errorApertura.set(`No se pudo abrir el corte: ${this.textoError(e)}`);
      },
    });
  }

  /**
   * CG.19 Capa 1b — el arqueo es CIEGO: se abre sin revelación y sin motivo de reconteo.
   * El esperado aparece cuando el servidor lo devuelve, y sólo después de SELLAR el conteo.
   */
  abrirCierre(corte?: { id: string; folio: string; fecha?: string } | null): void {
    this.conteoCorte.set([]); this.morrallaCorte.set(0);
    this.motivoReconteo.set(''); this.conflictoEsperado.set(null); this.recontando.set(false);
    this.errorCierre.set(null); this.ceroDeclarado.set(false);
    // `[CGP-V.3b]` Se baja SIEMPRE: una confirmación heredada de otro corte no confirma nada.
    this.jornadaConfirmada.set(false);
    /**
     * `[CG.160]` Si el corte YA tiene conteo sellado, el diálogo abre mostrándolo y ofreciendo
     * «Cerrar corte». Sin esto sólo ofrecía «Guardar conteo», que el servidor rechaza.
     *
     * ⭐ `[CGP-V.2]` Ya no se toma una foto del saldo ni se borra lo sellado en esta sesión: la
     * revelación se DERIVA (`revelacion()`), del servidor o de la respuesta a sellar, y va atada a
     * este corte. Lo único que se fija acá es cuál es el corte. Recién abierto, el saldo todavía no
     * lo trae: por eso `abrirCorte()` lo pasa de su respuesta.
     */
    const ca = this.corteAbierto();
    this.corteDelCierre.set(corte ?? (ca ? { id: ca.id, folio: ca.folio, fecha: ca.fecha } : null));
    this.abrirConFoco(this.cierreAbierto);
  }

  /** `[CGP-V.2]` Recontar es empezar de cero: la reja se abre vacía y pide motivo. */
  empezarReconteo(): void {
    this.conteoCorte.set([]); this.morrallaCorte.set(0); this.motivoReconteo.set('');
    this.recontando.set(true); this.errorCierre.set(null); this.ceroDeclarado.set(false);
  }

  /** Vuelve al conteo sellado sin tocarlo: lo tecleado del reconteo se descarta. */
  cancelarReconteo(): void {
    this.conteoCorte.set([]); this.morrallaCorte.set(0); this.motivoReconteo.set('');
    this.recontando.set(false); this.errorCierre.set(null); this.ceroDeclarado.set(false);
  }

  /** `[CGP-V.2]` Lo sellado en ese renglón. `0` y no `null`: un renglón sin piezas se contó en cero. */
  piezasSelladasDe(d: Denominacion): number {
    return this.desgloseSellado()?.conteo.find((x) => x.denom_key === d.key)?.piezas ?? 0;
  }

  subtotalSelladoDe(d: Denominacion): number { return redondea(d.valor * this.piezasSelladasDe(d)); }

  /** Lo que la persona lleva sumado. No revela nada: es su propia suma. */
  sumaConteo(): number {
    return sumaDesglose(this.conteoCorte(), this.morrallaCorte());
  }

  /** Sella el conteo y recibe la revelación. A partir de acá el conteo ya no se retoca en silencio. */
  sellarConteo(): void {
    const c = this.corteEnCierre();
    if (!c || this.sellando() || !this.puedeSellar()) return;
    // Lo que se manda es lo que se guarda como sellado: se toma ANTES de la llamada.
    const conteo = this.conteoCorte(); const morralla = this.morrallaCorte();
    this.sellando.set(true); this.errorCierre.set(null);
    this.svc.contarCorte(c.id, conteo, morralla, this.ceroVigente()).subscribe({
      next: (r) => {
        this.revelado.set({ corteId: c.id, totales: r.totales, puedeRecontar: r.puede_recontar, conteo, morralla });
        this.sellando.set(false);
        this.avisarOk('Conteo sellado', r.totales?.oculto ? 'El resultado lo ve quien autoriza.' : undefined);
        // `[CGP-V.1]` El estado sale del servidor: se vuelve a pedir después de cada acción.
        this.cargarSaldo();
      },
      error: (e) => { this.sellando.set(false); this.errorCierre.set(`No se pudo sellar el conteo: ${this.textoError(e)}`); },
    });
  }

  /** Segundo y último conteo. El motivo es obligatorio y el primero se conserva en el corte. */
  recontar(): void {
    const c = this.corteEnCierre();
    if (!c || !this.recontando() || this.motivoReconteo().trim().length < GLOSA_MIN || this.sellando() || !this.puedeSellar()) return;
    const conteo = this.conteoCorte(); const morralla = this.morrallaCorte();
    this.sellando.set(true); this.errorCierre.set(null);
    this.svc.recontarCorte(c.id, conteo, morralla, this.motivoReconteo().trim(), this.ceroVigente()).subscribe({
      next: (r) => {
        this.revelado.set({ corteId: c.id, totales: r.totales, puedeRecontar: false, conteo, morralla });
        this.sellando.set(false); this.recontando.set(false); this.motivoReconteo.set('');
        this.avisarOk('Reconteo guardado');
        this.cargarSaldo();
      },
      error: (e) => { this.sellando.set(false); this.errorCierre.set(`No se pudo recontar: ${this.textoError(e)}`); },
    });
  }

  /** ⚠️ `[CG.38]` Por denominación entera, no por valor — el mismo motivo que en la otra reja. */
  /** `[CG.114]` `null`, no `0`: ver `piezasDe`. Un cero tecleado vuelve `1` en `10`. */
  piezasCorteDe(d: Denominacion): number | null {
    return this.conteoCorte().find((x) => x.denom_key === d.key)?.piezas ?? null;
  }

  /** Lo que suma ese renglón del corte. Se calcula; no hay dónde teclearlo. */
  subtotalCorteDe(d: Denominacion): number { return redondea(d.valor * (this.piezasCorteDe(d) ?? 0)); }

  setPiezasCorte(d: Denominacion, piezas: number): void {
    const list = this.conteoCorte().filter((x) => x.denom_key !== d.key);
    // Enteras y no negativas: medio billete no existe, y el CHECK del servidor lo rechaza.
    const n = Math.max(0, Math.trunc(Number(piezas) || 0));
    if (n > 0) list.push({ denom_key: d.key, denominacion: d.valor, piezas: n });
    this.conteoCorte.set(list);
  }

  sevVeredicto(v: string): 'success' | 'warn' | 'danger' | 'secondary' {
    return v === 'cuadra' ? 'success' : v === 'sobra' ? 'warn' : v === 'falta' ? 'danger' : 'secondary';
  }

  cerrarCorte(): void {
    const c = this.corteEnCierre();
    if (!c || this.recontando() || !this.gateCierre().ok || this.cerrando()) return;
    this.cerrando.set(true); this.errorCierre.set(null);
    // [CGP-V.12] Con un conflicto a la vista, el botón confirma el esperado que la persona VIO.
    // ⭐ [CGP-V.2] La reja va VACÍA: lo que se firma es lo sellado, y el servidor lo usa cuando el
    // cuerpo no trae piezas ([CGP-L.1]; antes, el respaldo de [CG.159]). Mandar lo tecleado era
    // la otra mitad de L1: la reja seguía abierta después de revelar.
    this.svc.cerrarCorte(c.id, [], 0, undefined, this.conflictoEsperado()?.actual).subscribe({
      next: () => {
        this.cerrando.set(false);
        this.cierreAbierto.set(false); this.conflictoEsperado.set(null);
        this.corteDelCierre.set(null); this.revelado.set(null); this.recontando.set(false);
        this.avisarOk('Corte cerrado', 'Queda pendiente de autorizar por otra persona.');
        this.cargarSaldo(); this.cargar(); this.cargarCortes(); this.cargarJornadasAtrasadas();
      },
      error: (e) => {
        this.cerrando.set(false);
        // [CGP-V.12] El esperado cambió desde el conteo: se dice DENTRO del diálogo y se confirma
        // con el botón, en vez de un aviso de 7 s sin salida. Cualquier otro error sigue al aviso.
        const cf = conflictoDeEsperado(e);
        if (cf) { this.conflictoEsperado.set(cf); return; }
        this.errorCierre.set(`No se pudo cerrar el corte: ${this.textoError(e)}`);
      },
    });
  }

  private formVacio(): FormularioCajaUI {
    return {
      // `todayMx()`: con `toISOString()` el asiento nacía fechado MAÑANA después de las 18:00
      // hora de México, y encima el aviso de "fecha posterior a hoy" se apagaba a esa misma hora.
      tipo: 'gasto' as TipoMovimiento, fecha: todayMx(), sucursal: this.sucursalActiva,
      kepler_cuenta: null, kepler_concepto: null,
      // `monto: 0` y no `null`: el monto es el resultado del conteo, y un conteo vacío suma
      // cero. Un `null` acá se leería como "sin medir", que es otra cosa.
      glosa: '', beneficiario: '', monto: 0, morralla: 0,
      denominaciones: [],
    };
  }

  cargar(): void {
    this.cargando.set(true);
    this.svc.libro({
      /**
       * ⛔⛔ `[CG.127]` **ACÁ NO SE MANDABA `limit`, Y EL DEFECTO ERA GRANDE.**
       *
       * Sin `limit` el servidor usa 100 (tope 500). Medido contra prod el 2026-10-20, en el
       * MISMO periodo de la captura de Edgar (01→19 oct): **248 movimientos, la pantalla pintaba
       * 100, y 148 filas por $1,943,998.57 no se veían** — del 7 al 15 de octubre, o sea en
       * medio del rango, no al final. El encabezado publicaba «248» porque el KPI se calcula sin
       * tope: la pantalla decía un número y mostraba otro, sin una sola señal de que faltaba.
       *
       * ⚠️ Y `armarReporte()`, dos métodos más abajo, **ya pedía 500**. O sea que el reporte
       * impreso y la pantalla venían mostrando universos distintos del mismo periodo.
       *
       * ⭐ Subir el tope es barato **recién desde `[CG.127]`**: sacar `firma_png` del listado
       * bajó la fila de 5,723 bytes a texto (las firmas eran el 98.8 % del peso).
       *
       * ⚠️ 500 es el tope DURO del servidor, así que todavía es posible toparse. Por eso la
       * respuesta mira `has_more` y lo DECLARA: una lista topada en silencio es justo lo que
       * este item vino a arreglar, y dejarla topada sin aviso sería repetirlo con otro número.
       */
      limit: 500,
      from: this.from, to: this.to, tipo: this.tipo ?? undefined, search: this.search || undefined,
      // [CG.86] El filtro viaja como BANDERA, no como nombre ni como id: el servidor resuelve
      // quién es "yo" desde el token de la petición. Mandar el id desde acá volvería "los míos"
      // en "los de cualquiera que yo escriba".
      mios: this.soloMios() ? '1' : undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.rows.set(r.rows ?? []); this.kpiRaw.set(r.kpi);
          // `[CG.127]` `has_more` LLEGABA Y NADIE LO MIRABA. Esa es la mitad del defecto: el
          // servidor avisaba que había topado y la pantalla descartaba el aviso.
          this.libroTopado.set(!!r.has_more);
          this.errLibro.set(null); this.cargando.set(false);
          // ⛔ [CG.181] ACÁ COLGABA `cargarCortes()` y era la MITAD del 429 de producción: al
          // entrar, `ngOnInit` pedía los cortes y `cargar()` los volvía a pedir con los MISMOS
          // parámetros al resolverse. Dos peticiones idénticas, la segunda rebotada por el
          // throttler — y como el error vacía la lista, el conteo salía en cero.
          // Los cortes se listan por el mismo RANGO que el libro, así que ahora cuelgan de lo
          // que de verdad los cambia (`setDesde`/`setHasta`) y no del éxito del libro. De paso
          // dejan de recargarse al cambiar el tipo, la búsqueda o "los míos", que no los tocan.
          // ⚠️ Y se rompe un acoplamiento falso: con el libro caído los cortes no se recargaban
          // nunca, aunque su endpoint estuviera sano.
        },
        // `kpiRaw` a null NO es "todo en cero": la tira de KPIs ahora publica "sin medir".
        error: (e) => {
          this.rows.set([]); this.kpiRaw.set(null);
          this.errLibro.set(this.textoError(e)); this.cargando.set(false);
        },
      });
  }

  /**
   * CS.3.10 — Imprime el reporte diario de movimientos en la térmica: los del rango/filtros actuales
   * (hasta 500, no el tope de 100 de la pantalla) + los totales del período (ingresos/gastos/depósitos/
   * neto), con el mismo criterio que el corte. Es un reporte de lo REALIZADO (el libro), no de la bandeja.
   */
  imprimiendoReporte = signal(false);
  /** `[CG.87]` El texto del reporte, tal cual lo arma el papel. Vacío = nunca se pidió. */
  reporteTexto = signal('');
  reporteAbierto = signal(false);
  /** `[CG.86]` ¿El libro muestra sólo lo que capturó quien mira? */
  soloMios = signal(false);

  alternarMios(): void {
    this.soloMios.set(!this.soloMios());
    this.cargar();
  }
  /**
   * `[CG.87]` **El reporte del día, EN PANTALLA.** Pedido de Edgar: *"un reporte de movimientos
   * del día"*. Existía, pero **sólo salía a la térmica** — para leerlo había que imprimirlo.
   *
   * ⭐ Comparte el MISMO armador que el papel (`cuerpoReporteDia`, una función pura que devuelve
   * el texto). Dos superficies, un solo cuerpo: si mañana cambia un total o un renglón, cambian
   * las dos juntas. Reescribirlo en HTML habría creado una segunda versión que se desalinea en
   * silencio — y un reporte de dinero que dice algo distinto en papel y en pantalla es peor que
   * no tenerlo.
   *
   * ⚠️ Y pesa más desde `[CG.81]`: al quitar la impresión automática del comprobante, dejar el
   * reporte sólo en papel empujaba en la dirección contraria.
   */
  verReporteDia(): void {
    this.armarReporte((rep) => {
      this.reporteTexto.set(cuerpoReporteDia(rep));
      this.reporteAbierto.set(true);
    });
  }

  imprimirReporteDia(): void {
    this.armarReporte((rep) => {
      if (!imprimirTicketReporte(rep)) this.avisarError(null, 'El navegador no dejó abrir la impresión del reporte');
    });
  }

  /** El armado es UNO solo: lo que se ve y lo que se imprime salen de la misma consulta. */
  private armarReporte(usar: (r: ReporteDia) => void): void {
    this.imprimiendoReporte.set(true);
    this.svc.libro({ from: this.from, to: this.to, tipo: this.tipo ?? undefined, search: this.search || undefined, limit: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.imprimiendoReporte.set(false);
          const rep: ReporteDia = {
            desde: this.from, hasta: this.to, tipo: this.tipo, busqueda: this.search || null,
            movimientos: (r.rows ?? []).map((m) => ({
              folio: m.folio, tipo: m.tipo, monto: Number(m.monto),
              kepler_concepto_nombre: m.kepler_concepto_nombre, beneficiario: m.beneficiario,
            })),
            totales: {
              movimientos: r.kpi?.movimientos ?? (r.rows?.length ?? 0),
              ingresos: Number(r.kpi?.ingresos ?? 0), gastos: Number(r.kpi?.gastos ?? 0), depositos: Number(r.kpi?.depositos ?? 0),
              // `[CG.72]` Viaja la parte cancelada: el papel lista esos renglones, así que sin
              // esto la suma a mano no da y el ticket parece equivocado.
              cancelados: Number(r.kpi?.cancelados ?? 0), monto_cancelado: Number(r.kpi?.monto_cancelado ?? 0),
            },
            generado_por: this.auth.user()?.username ?? null,
            truncado: !!r.has_more,
          };
          usar(rep);
        },
        error: (e) => { this.imprimiendoReporte.set(false); this.avisarError(e, 'No se pudo generar el reporte del día'); },
      });
  }

  abrirCaptura(): void {
    // `[CGP-V.6]` Captura, confirmar y cerrar piden GESTIONAR en el servidor: acá también.
    if (!this.puedeGestionar()) return;
    this.f.set(this.formVacio());
    this.conceptoSel = null;
    this.conceptoManual.set(false);
    this.cuentaFuenteDoc.set(null);
    // `[CG.94]` Cada captura arranca en modo ficha. Si no se reseteara, corregir UNA dejaría
    // abierto el formulario para todas las siguientes — y el modo se elige por movimiento.
    this.corrigiendo.set(false);
    this.declararRegla.set(false);
    this.propuesta.set(null);
    // El cobro elegido NO sobrevive al diálogo anterior: arrastrarlo aplicaría el documento de
    // una entrega a otra, que es justo el error que el índice único frena del lado del servidor.
    this.cobroSel = null;
    this.cobroElegido.set(null);
    // `[CGA-A.10b]` La declaración tampoco sobrevive al diálogo anterior: arrastrarla pegaría
    // la llave de OTRO documento a esta captura — y una llave equivocada es peor que ninguna,
    // porque taparía un cobro ajeno en vez de dejarlo a la vista.
    this.docDeclarado.set(null);
    this.montoContado.set(null);
    // CS.3.13 — la venta a crédito tampoco sobrevive al diálogo anterior.
    this.ventaCredito.set(0);
    this.clienteCredito.set(false);
    // ⛔ `[CG.160]` Y el motivo de «sin documento» MENOS que ninguno: heredado de la captura
    // anterior, explicaría un movimiento que no es el suyo — y como el servidor sólo mira que
    // tenga 12 caracteres, pasaría sin que nadie lo note. Es la peor forma de fallar acá: no un
    // error, una explicación equivocada guardada como si fuera cierta.
    this.sinDocumentoMotivo.set('');
    // ⛔ [CG.38] Y el cambio devuelto TAMPOCO. Sin esta línea, la captura siguiente arranca con
    // el cambio de la anterior ya restado del monto: dinero que se va de un movimiento al que
    // no pertenece, y encima en silencio porque el bloque nace plegado.
    this.devuelto.set([]);
    this.cambioAbierto.set(false);
    this.cobros.set([]);
    // CS.3 — la fuente CAOS tampoco sobrevive al diálogo anterior.
    this.caosSel = null;
    this.caosElegido.set(null);
    this.caosOpciones.set([]);
    // CS.3.4 — el detector del cajero tampoco sobrevive al diálogo anterior.
    this.caosSugeridos.set([]);
    this.caosVinculados.set([]);
    this.buscandoCajero.set(false);
    // ⛔ `[CG.67]` La firma TAMPOCO sobrevive al movimiento anterior. Sin esto, la firma de un
    // gasto se guardaría en el siguiente: evidencia atribuida a quien no firmó, y en silencio
    // porque el trazo ya está dibujado en el canvas y se ve igual que uno recién hecho.
    this.firmaPad?.limpiar();
    this.firmaHecha.set(false);
    this.firmaNombre.set('');
    // `[CG.68]` El emparejamiento tampoco sobrevive: un codigo de la captura anterior traeria la
    // firma de otro movimiento.
    this.firmaRemotaPng.set(null);
    this.firmaRemotaMonto.set(null);
    this.firmaCerrarRemota();
    this.abrirConFoco(this.capturaAbierta);
    // ⛔ `[CG.46]` Esto lo hacía `p-dialog` solo y un `<aside>` NO. Sin esto, quien elige una fila
    // con el teclado se queda con el foco en la tabla y el panel se abre a su lado sin que nada
    // se lo diga — y para llegar a los campos tendría que tabular por el resto de la bandeja.
    // El retorno al cerrar ya lo resuelve `cerrarConFoco`.
    this.enfocarDetalle();
    // Los frecuentes son POR SUCURSAL y se pedían una sola vez en ngOnInit: al cambiar de
    // sucursal seguían siendo los de la 00. Se refrescan al abrir, con la sucursal en curso.
    this.cargarFrecuentes();
  }

  /**
   * Escribe UN campo del formulario. Reemplaza el objeto en vez de mutarlo: un signal notifica
   * por identidad, así que mutar `f().glosa` no despertaría a `bloqueos`.
   */
  setF<K extends keyof FormularioCajaUI>(campo: K, valor: FormularioCajaUI[K]): void {
    this.f.update((v) => ({ ...v, [campo]: valor }));
  }

  // `[CG.97]` El catálogo de frecuentes es por (tipo, sucursal): cambiar de tipo cambia los
  // chips, igual que cambiar de plaza. Sin esto quedaban los del tipo anterior, que es el
  // mismo defecto que `onSucursal` ya tenía resuelto de su lado.
  onTipo(v: TipoMovimiento): void { this.setF('tipo', v); this.pedirPropuesta(); this.cargarFrecuentes(); }
  onGlosa(v: string): void { this.setF('glosa', v); this.pedirPropuestaDebounced(); }

  /**
   * El monto, y si eso constituye un CONTEO.
   *
   * Con un documento anclado, que la persona cambie el importe ES "conté distinto" por
   * definición: la cifra del ERP ya se conoce. Por eso acá el conteo se marca EXPLÍCITO en vez de
   * dejar que el servidor lo deduzca de una diferencia — que es lo que su propio comentario
   * prohíbe, porque haría indistinguible un arqueo real de un bug del front.
   */
  onMonto(v: number | null): void {
    this.setF('monto', v);
    const doc = this.cobroElegido();
    if (!doc) { this.montoContado.set(null); return; }
    const n = Number(v);
    if (!(n > 0)) { this.montoContado.set(null); return; }
    // Medio centavo de tolerancia: teclear el mismo importe no es un descuadre.
    this.montoContado.set(Math.abs(n - Number(doc.monto)) < 0.005 ? null : n);
  }

  conceptoLabel = (c: ConceptoKepler) => `${c.cuenta} / ${c.concepto} — ${c.concepto_nombre}`;

  // ── CG.19 Capa 1 — elegir el cobro en vez de teclear el monto ──────────────────────────────

  /** Etiqueta del documento: primero lo que lo identifica, después el monto. */
  cobroLabel = (c: MovimientoPendiente) =>
    `${dmy(c.fecha_valor)} · ${c.beneficiario || c.entidad_code || 's/contraparte'} · ${money(c.monto)} · ${c.doc_tipo} ${c.folio}`;

  buscarCobros(e: AutoCompleteCompleteEvent): void {
    this.svc.movimientosPendientes({
      // El diálogo propone el documento del MISMO signo que se está capturando: ofrecerle un pago
      // a quien está registrando un ingreso es ruido que además puede terminar mal aplicado.
      tipo: this.f().tipo === 'gasto' ? 'gasto' : 'ingreso',
      caja: this.cajaActiva() || undefined,
      sucursal: this.f().sucursal || undefined,
      search: (e.query || '').trim() || undefined,
      limit: 40,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.cobros.set((r.rows ?? []).map((c) => ({ ...c, label: this.cobroLabel(c) }))),
      // ⚠️ El comentario que estaba acá decía "se deja la lista como estaba" y el código hacía
      // exactamente lo contrario: la vaciaba. Ahora sí se conserva, y el fallo se AVISA en vez de
      // parecer "el ERP no tiene nada pendiente", que es una afirmación distinta.
      error: (err) => this.avisarError(err, 'No se pudieron buscar cobros de Kepler'),
    });
  }

  /**
   * Toma el documento: monto, fecha, motivo y beneficiario salen del ERP.
   *
   * ⚠️ El monto que se pone acá es **cosmético**: el servidor lo relee del documento y descarta el
   * del formulario. Se escribe igual para que el arqueo por denominación pueda cuadrar contra la
   * cifra correcta antes de mandar, y para que la persona vea contra qué está contando.
   */
  elegirCobro(e: AutoCompleteSelectEvent): void {
    const c = e.value as MovimientoPendiente;
    if (!c) return;
    this.tomarDocumento(c);
  }

  /**
   * Toma el documento del ERP: monto, fecha, beneficiario y glosa salen de ahí.
   *
   * Sale del cuerpo de `elegirCobro` para que la bandeja pueda usar lo mismo (`capturarDesde`):
   * anclar un documento es una sola operación, se haya llegado por el buscador o por la fila.
   */
  private tomarDocumento(c: MovimientoPendiente): void {
    // Excluyente con CAOS: una captura tiene UN origen.
    this.caosElegido.set(null);
    this.caosSel = null;
    // `[CGA-A.10b]` Con el documento ANCLADO no hace falta declararlo aparte: su identidad ya
    // viaja en `origen_ref`. La declaración sólo existe para el caso CAOS, donde el `origen_ref`
    // es `device|external_id` y el documento queda sin llave.
    this.docDeclarado.set(null);
    this.cobroElegido.set(c);
    // CG.23 — El importe YA NO SE HEREDA del documento ni del total tecleado en la bandeja.
    //
    // Antes esta línea ponía `monto: hayConteo ? contado : c.monto`, o sea que el formulario
    // nacía con una cifra que nadie había contado todavía. Con el desglose obligatorio eso es
    // una contradicción: el monto SALE del conteo, y antes de contar el conteo es cero.
    // Dejarlo en la cifra del ERP haría lo contrario de lo que este módulo existe para hacer —
    // daría por bueno el importe del documento y el arqueo sería un trámite.
    //
    // ⛔ `[CG.48]` Acá se arrastraba `contado`, lo tecleado en la columna de la bandeja, para
    // mostrarlo como referencia. Esa columna se retiró: ya no hay un conteo previo que heredar.
    this.montoContado.set(null);
    this.f.update((v) => ({
      ...v,
      monto: 0,
      morralla: 0,
      // La fecha del documento es cuándo Kepler lo registró; la del movimiento es cuándo entró o
      // salió el efectivo. Se propone, no se impone: el capturista puede corregirla.
      fecha: String(c.fecha_valor).slice(0, 10) || v.fecha,
      sucursal: c.sucursal || v.sucursal,
      beneficiario: c.beneficiario || c.entidad_code || v.beneficiario,
      glosa: v.glosa?.trim()
        || `${c.doc_tipo} ${c.folio} · ${c.beneficiario || c.entidad_code || 'sin beneficiario'}`.slice(0, 200),
      // Si el ERP ya trae la cuenta resuelta, se propone; si no, queda para que la elija un humano.
      kepler_cuenta: c.kepler_cuenta ?? v.kepler_cuenta,
      kepler_concepto: c.kepler_concepto ?? v.kepler_concepto,
      // El desglose de otro documento no es el de éste: se limpia y se vuelve a contar.
      denominaciones: [],
    }));
    // CS.3.13 — Cliente de crédito: se auto-rellena «venta a crédito» con el TOTAL (a este cliente
    // siempre se le vende a crédito → nada llega en efectivo), SIEMPRE editable. El monto pasa a ser
    // efectivo (0) + crédito. Si no es de crédito, el campo arranca en 0.
    this.clienteCredito.set(!!c.cliente_credito);
    this.ventaCredito.set(c.cliente_credito ? Number(c.monto) || 0 : 0);
    this.recomputarMonto();
    // CS.3.1b — Si la cuenta salió de la PROPIA póliza del documento, es autoritativa: se muestra
    // y se BLOQUEA (el buscador se acota a los conceptos de esa cuenta). No se pide propuesta por
    // historia — el dato de Kepler manda.
    if (c.cuenta_fuente === 'documento' && c.kepler_cuenta) {
      const conceptos = c.conceptos_cuenta ?? [];
      this.cuentaFuenteDoc.set({ cuenta: c.kepler_cuenta, cuenta_nombre: c.kepler_cuenta_nombre ?? null, conceptos });
      this.conceptoSel = c.kepler_concepto
        ? { cuenta: c.kepler_cuenta, concepto: c.kepler_concepto, concepto_nombre: conceptos[0]?.concepto_nombre ?? '',
            sucursal: c.sucursal, cuenta_mayor: '', label: `${c.kepler_cuenta} / ${c.kepler_concepto}` }
        : null;
      this.conceptoManual.set(false);
      return;
    }
    this.cuentaFuenteDoc.set(null);
    this.pedirPropuesta();
  }

  /**
   * Abre la captura ANCLADA a una fila de la bandeja. Es la salida de un movimiento trabado:
   * el lote lo rechaza porque nadie declaró su cuenta, y sin esto la única alternativa era
   * retipear el documento entero a mano — justo lo que esta pantalla existe para evitar.
   *
   * ⭐ `[CG.48]` Y es también la salida de un movimiento que se contó DISTINTO. El lote espeja al
   * ERP y no acepta un importe propio, así que el único camino para que mande lo contado es éste,
   * donde el monto nace del desglose. Contar sin decir con qué billetes dejó de ser posible.
   */
  capturarDesde(p: MovimientoPendiente): void {
    this.abrirCaptura();
    // El tipo sale del SIGNO del documento, no de lo que estuviera elegido antes.
    this.setF('tipo', (p.tipo === 'ingreso' ? 'ingreso' : 'gasto') as TipoMovimiento);
    this.cobroSel = { ...p, label: this.cobroLabel(p) };
    this.tomarDocumento(p);
    // CS.3.6 — si el motor ya le adjuntó su CAOS, se vincula solo: su efectivo autorellena parte del
    // arqueo y se enlaza al guardar. La unión ya viene hecha; el capturista sólo revisa y guarda.
    if (p.caos_match) this.vincularCaos(p.caos_match as unknown as CaosCandidato);
  }

  /**
   * Soltar el cobro devuelve el formulario a captura manual.
   *
   * ⚠️ El CONTEO se conserva a propósito. Antes acá se hacía `denominaciones: []` porque el
   * monto venía del documento y el desglose viejo dejaba de cuadrar; ahora el monto ES el
   * conteo, y el efectivo que la persona ya contó sigue estando sobre la mesa. Borrárselo por
   * soltar el documento sería hacerle contar dos veces el mismo dinero.
   */
  soltarCobro(): void {
    this.cobroElegido.set(null);
    this.montoContado.set(null);
    // CS.3.13 — sin cobro anclado no hay cliente de crédito: la venta a crédito vuelve a 0.
    this.ventaCredito.set(0);
    this.clienteCredito.set(false);
    this.recomputarMonto();
  }

  // ── CS.3 — la segunda fuente de captura: la caja fuerte (CAOS) ────────────────────────────────
  //
  // El capturista puede anclar un movimiento de CAOS igual que un documento de Kepler. La
  // diferencia: CAOS trae el ARQUEO ya contado por la máquina, así que el desglose se precarga y
  // el monto sale de ahí. Lo que la máquina no cubre (morralla, monedas, una diferencia) se teclea.
  // Las dos fuentes conviven pero son excluyentes en UNA captura: elegir CAOS suelta el cobro y
  // viceversa, para que `guardar()` no tenga dos orígenes.

  /** Etiqueta del movimiento de CAOS: qué es, quién y cuánto. */
  caosLabel = (m: CaosCapturable) =>
    `${dmy(m.fecha_valor)} · ${m.type_label} #${m.external_id} · ${m.user_external || 's/operador'} · ${money(m.monto)}${m.ref ? ' · «' + m.ref + '»' : ''}`;

  buscarCaos(e: AutoCompleteCompleteEvent): void {
    this.svc.caosCapturables({
      tipo: this.f().tipo === 'gasto' ? 'gasto' : 'ingreso',
      search: (e.query || '').trim() || undefined,
      limit: 40,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.caosOpciones.set((r.rows ?? []).map((m) => ({ ...m, label: this.caosLabel(m) }))),
      error: (err) => this.avisarError(err, 'No se pudieron buscar movimientos de la caja fuerte (CAOS)'),
    });
  }

  elegirCaos(e: AutoCompleteSelectEvent): void {
    const m = e.value as CaosCapturable;
    if (!m) return;
    this.tomarMovimientoCaos(m);
  }

  /**
   * Ancla un movimiento de CAOS y **precarga el arqueo con el conteo de la máquina**. El monto sale
   * del desglose (recomputarMonto). NO ancla a un documento de Kepler: `guardar()` manda
   * `origen_tipo='caos'` y el servidor toma el monto del arqueo, no de un documento.
   */
  private tomarMovimientoCaos(m: CaosCapturable): void {
    /**
     * ⭐⭐ `[CGA-A.10b]` **ACÁ SE PERDÍA LA IDENTIDAD DEL DOCUMENTO, y eso volvía dinero
     * invisible.**
     *
     * El origen pasa a ser CAOS y el documento se suelta —correcto, una captura tiene UN
     * origen—, pero la **glosa se conserva** (abajo: `v.glosa?.trim() || …`). O sea que el
     * movimiento quedaba diciendo `U-A-5 0000007 · CONTADO` **sin ninguna llave que dijera de
     * qué sucursal**, y el descuento anti-duplicado de la cola tenía que adivinarlo comparando
     * ese texto. Como el folio de camioneta es consecutivo **por unidad**, una captura tapaba
     * a todos sus homónimos: medido el 2026-10-16, **una sola tapó siete cobros de siete
     * sucursales** (`GOTCHAS` §86, `[CGA-A.10c]`).
     *
     * Lo que falta no es el texto: es la **llave**. Se guarda antes de soltar el documento y
     * viaja como `declared_doc_ref` — con eso el descuento compara identidad completa y deja
     * de tapar por semejanza.
     */
    const docPrevio = this.cobroElegido();
    this.docDeclarado.set(docPrevio?.origen_ref ?? this.docDeclarado());

    // Excluyente con el cobro de Kepler: una captura tiene UN origen.
    this.cobroElegido.set(null);
    this.cobroSel = null;
    this.montoContado.set(null);
    // CS.3.13 — un movimiento de CAOS no es un cobro a cliente de crédito: sin venta a crédito.
    this.ventaCredito.set(0);
    this.clienteCredito.set(false);
    // CAOS no tiene póliza de Kepler para estos movimientos: su clasificación no se bloquea.
    this.cuentaFuenteDoc.set(null);
    this.caosElegido.set(m);
    this.f.update((v) => ({
      ...v,
      tipo: m.tipo as TipoMovimiento,
      fecha: String(m.fecha_valor).slice(0, 10) || v.fecha,
      sucursal: m.sucursal || v.sucursal,
      beneficiario: m.user_external || v.beneficiario,
      glosa: v.glosa?.trim() || `CAOS ${m.type_label} #${m.external_id}${m.ref ? ' · ' + m.ref : ''}`.slice(0, 200),
      // ⭐ CS.3.7 — El arqueo de la máquina NO se teclea en la reja: cuenta como aporte del cajero
      // (mostrado aparte, `denominacionesCajero`). La reja arranca VACÍA, para la diferencia a mano.
      denominaciones: [],
      morralla: 0,
    }));
    this.recomputarMonto();
    this.pedirPropuesta();
  }

  /** Soltar CAOS vuelve a captura manual; conserva el conteo ya precargado (no se re-teclea). */
  soltarCaos(): void {
    this.caosElegido.set(null);
    this.caosSel = null;
    // `[CGA-A.10b]` Sin origen CAOS la declaración no aplica: se suelta con él, para que no
    // viaje pegada a una captura que ya es otra cosa.
    this.docDeclarado.set(null);
    // CS.3.7 — sin el origen del cajero, su aporte sale del monto: hay que recalcular (antes el
    // efectivo vivía en la reja y quedaba; ahora va aparte y desaparece con el origen).
    this.recomputarMonto();
  }

  /** CS.3.1b — Suelta la cuenta del documento y vuelve al buscador libre (por si Kepler se equivocó). */
  corregirCuentaDoc(): void {
    this.cuentaFuenteDoc.set(null);
    this.conceptoSel = null;
    this.conceptoManual.set(true);
    this.conceptos.set([]);
    this.f.update((v) => ({ ...v, kepler_cuenta: null, kepler_concepto: null }));
  }

  /**
   * CG — Abre la captura desde un documento POR PAGAR del buscador (gasto u orden de entrada).
   *
   * Reusa `capturarDesde()` a propósito: el pagable llega con la MISMA forma que un pendiente de
   * caja, así que `guardar()` toma `origen_tipo` (`gasto`/`orden_entrada`) y `origen_ref` de la
   * propia fila — sin una segunda ruta de captura que mantener en paralelo.
   *
   * ⚠️ El importe del documento NO se hereda como monto: igual que con un documento de Kepler, el
   * monto SALE del arqueo (lo que de verdad se entrega en efectivo). El importe queda a la vista en
   * la fila para comparar — un pago parcial es legítimo y forzarlo al total sería inventar.
   */
  capturarDesdePagable(g: MovimientoPendiente & { pagable_label: string }): void {
    this.capturarDesde(g);
  }

  /**
   * CS.3.1c — Abre la captura desde un movimiento de CAOS de la bandeja: el arqueo de la máquina se
   * precarga y se bloquea; sólo queda clasificar lo faltante. Espeja `capturarDesde` (Kepler).
   */
  capturarDesdeCaos(m: CaosCapturable): void {
    this.abrirCaptura();
    this.tomarMovimientoCaos(m);
  }

  /**
   * CS.3.4 — Busca en el cajero (CAOS) qué retiros pudieron pagar ESTE gasto. Llama al detector con
   * lo que ya se sabe del gasto (fecha, monto del documento anclado si hay, beneficiario, glosa).
   */
  buscarEnCajero(): void {
    const f = this.f();
    const doc = this.cobroElegido();
    this.buscandoCajero.set(true);
    this.svc.caosCandidatos({
      fecha: f.fecha, tipo: f.tipo,
      monto: doc?.monto ?? undefined,
      beneficiario: f.beneficiario || undefined,
      concepto: f.glosa || undefined,
      sucursal: f.sucursal || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const ya = new Set(this.caosVinculados().map((v) => v.external_id));
        this.caosSugeridos.set((r.rows ?? []).filter((c) => !ya.has(c.external_id)));
        this.buscandoCajero.set(false);
      },
      error: (err) => { this.buscandoCajero.set(false); this.avisarError(err, 'No se pudo buscar en el cajero (CAOS)'); },
    });
  }

  /**
   * CS.3.4/3.7 — Vincula un retiro del cajero. Su efectivo NO se teclea en la reja: cuenta como
   * aporte del cajero (mostrado aparte) y suma al monto. La reja de abajo queda para la diferencia.
   */
  vincularCaos(c: CaosCandidato): void {
    this.caosVinculados.update((v) => [...v, {
      device: c.device, external_id: c.external_id, monto: c.monto, ref: c.ref,
      denominaciones: c.denominaciones,
      senales: { score: c.score, confianza: c.confianza, motivos: c.motivos },
    }]);
    this.caosSugeridos.update((s) => s.filter((x) => x.external_id !== c.external_id));
    this.recomputarMonto();
  }

  /** CS.3.4/3.7 — Suelta un retiro vinculado: quita su aporte del cajero y recalcula el monto. */
  desvincularCaos(externalId: number): void {
    this.caosVinculados.update((l) => l.filter((x) => x.external_id !== externalId));
    this.recomputarMonto();
  }

  // ── CG.20/CG.21 — bandeja de movimientos, los dos signos ─────────────────────────────────────

  /**
   * Las cajas del catálogo, para el selector.
   *
   * ⚠️ Cada opción dice su volumen medido. Una caja con `0 docs` es un HECHO —`0030`, `0040` y
   * `0050` no se usaron en 180 días— y tiene que verse como tal, no desaparecer del selector ni
   * parecerse a una caja activa. Si el catálogo no responde, queda la CAJA GENERAL sola: es la
   * única con operación medida, y un selector vacío dejaría la bandeja inalcanzable.
   */
  cajas = signal<CajaKepler[]>([]);
  opcionesCaja = computed(() => {
    const rows = this.cajas();
    if (!rows.length) return [{ label: 'CAJA GENERAL', value: '0011' }];
    return rows.map((c) => ({
      label: c.documentos ? `${c.nombre} (${c.documentos})` : `${c.nombre} · sin movimiento`,
      value: c.clave,
    }));
  });

  cargarCajas(): void {
    // El conteo de cada caja es "documentos EN LA VENTANA", así que se vuelve a pedir cuando la
    // ventana cambia. Antes se pedía una sola vez en ngOnInit y los números entre paréntesis
    // quedaban congelados, contradiciendo a la lista de abajo.
    this.svc.cajas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.cajas.set(r.rows ?? []),
      error: () => { /* se conserva lo último conocido; el computed cae a la CAJA GENERAL */ },
    });
  }

  /** Cambiar cualquiera de los tres filtros: limpia el recibo viejo y vuelve a pedir. */
  setSigno(v: '' | 'ingreso' | 'gasto'): void { this.signoBandeja.set(v); this.refiltrar(); }
  setCaja(v: string): void { this.cajaActiva.set(v); this.refiltrar(); }

  private refiltrar(): void {
    // El recibo del lote NO se limpiaba nunca: seguía en pantalla al cambiar de filtro,
    // publicando el resultado de otra cosa.
    this.resultado.set(null);
    this.cargarPendientes();
  }

  /** Qué decir cuando no hay nada: nombrando el filtro que lo dejó vacío, con salida. */
  pistaVacio(): string {
    const partes: string[] = [];
    const s = this.signoBandeja();
    if (s) partes.push(s === 'ingreso' ? 'sólo entradas' : 'sólo salidas');
    const filtro = partes.length ? ` (${partes.join(', ')})` : '';
    // [CGA-A.43] Ya no hay ventana que ampliar: la cola cubre todo desde el primer corte del libro.
    return `No hay movimientos de Kepler pendientes en esta caja${filtro}.${s ? ' Prueba con el otro signo.' : ''}`;
  }

  /**
   * CS.3.12 — `bg=true` en refrescos de FONDO (el poll de 60 s y el socket): NO prende el indicador
   * de carga, así la bandeja se actualiza en silencio. Prenderlo en cada repaso hacía que
   * `app-load-state` mostrara el estado de carga un instante = **micro-parpadeo cada 60 s**. Los
   * refrescos del usuario (filtro, búsqueda, inicial) sí lo prenden: ahí el "cargando" es feedback.
   */
  /**
   * `[CG.28]` Documentos que el ERP fechó DESPUÉS de hoy: fuera de la bandeja, nunca callados.
   *
   * Medído el 2026-09-30: con la ventana en 1 día, la bandeja devolvía **7 filas y las 7 eran
   * éstas**. La ventana no tenía tope de arriba, así que los únicos documentos que pasaban un
   * filtro de "último día" eran justamente los mal fechados — el ERP captura con 3 días de
   * mediana, y ninguno legitimo tiene `fecha_valor` de hoy.
   */
  malFechados = signal<{ movimientos: number; monto: number } | null>(null);

  /**
   * ⛔⛔ `encadenar` EXISTE PORQUE EL AVANCE ESTABA ATADO A LA CARGA, NO AL GUARDADO.
   *
   * `avanzarAlSiguiente()` vivía dentro de este `next`, así que abría el apartado 2 en **las
   * siete** veces que algo recarga la bandeja, no sólo después de contar:
   *
   *   · al entrar al módulo        → el paso 2 encima antes de mirar nada
   *   · al tocar un acceso rápido  → `refiltrar()`; el cajón tapa la lista que acabás de pedir
   *   · al buscar, al reintentar
   *   · cada 60 s                  → el repaso de fondo
   *   · con cada aviso del socket  → o sea, cuando OTRA persona guarda algo
   *
   * La guarda `if (this.capturaAbierta()) return` sólo evita re-abrir lo ya abierto: si lo
   * cerraste a propósito, el siguiente NOTIFY o los 60 s **te lo vuelven a abrir y se llevan el
   * foco** (`abrirConFoco` + `enfocarDetalle`), aunque estuvieras tecleando en el buscador.
   *
   * ⭐ Se notó recién ahora porque el apartado 2 dejó de ser una columna del split y pasó a ser
   * un cajón que se despliega encima: abrir algo que ya estaba a la vista no se siente igual que
   * tirarte un panel sobre la pantalla. El defecto es viejo; el rediseño lo volvió visible.
   *
   * `[CG.93]` no cambia —«lo único que tiene que hacer la persona es CONTAR»— y el encadenado
   * contar→guardar→contar sigue igual. Lo que cambia es que ahora lo pide **quien guardó**, que
   * es el único que sabe que terminó de contar.
   */
  cargarPendientes(bg = false, encadenar = false): void {
    if (!bg) this.cargandoPend.set(true);
    // [CGA-A.43] Sin `from`: el servidor acota la cola en el primer corte del libro.
    this.svc.movimientosPendientes({
      tipo: this.signoBandeja() || undefined,
      // [CGA11Y-O3b] El grupo elegido en la tira. Acota la LISTA; los conteos de la tira no lo
      // heredan (ver filtrosCon en el servicio), o cada acceso tendria numero solo al estar activo.
      doc_tipo: this.docTipoGrupo() || undefined,
      caja: this.cajaActiva() || undefined,
      // CS.3.9 — el buscador universal de «por confirmar»: folio de Kepler, concepto, beneficiario, doc.
      search: this.searchPend() || undefined,
      limit: 100,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.pendientes.set(r.rows ?? []);
        // `[CG.93]` Lo único que tiene que hacer la persona es CONTAR. Ver `avanzarAlSiguiente()`.
        // ⚠️ SÓLO cuando quien llamó venía de guardar: ver el bloque de `encadenar` arriba.
        if (encadenar) this.avanzarAlSiguiente();
        // CG — los documentos POR PAGAR (gastos / órdenes de entrada) sólo vienen con búsqueda: sin
        // término la lista llega vacía y la sección no se pinta, que es lo correcto.
        this.pagables.set(r.pagables ?? []);
        this.confirmables.set(r.confirmables ?? 0);
        // `[CG.30]` Cuántos hay DE VERDAD en la ventana. `rows.length` es cuánto cupo en la página
        // (tope 100), y el subtítulo lo estaba publicando como si fuera el trabajo pendiente.
        // `null` cuando el servidor no lo manda: el subtítulo entonces NO inventa un universo.
        this.totalPend.set(typeof r.total === 'number' ? r.total : null);
        // Lo que el servidor dice que acotó, y si la lista viene topada. Los tres campos venían
        // en la respuesta desde el primer día y no se leía ninguno.
        this.ventanaSrv.set({ desde: r.desde, dias: r.ventana_dias ?? null, motivo: r.desde_motivo, relevo: r.relevo ?? null, saldados: r.saldados_por_control, cola: r.cola ?? null });
        this.datosAl.set(r.datos_al ?? null);
        this.truncada.set(!!r.has_more);
        // Sólo se pinta si de verdad hay algo afuera: un "quedan 0 anteriores" es ruido.
        this.rezago.set(r.fuera_de_ventana && r.fuera_de_ventana.movimientos > 0 ? r.fuera_de_ventana : null);
        // [CG.28] Los que el ERP fechó adelante. Fuera de la lista, pero a la vista: alguien tiene
        // que ir a corregirlos en Kepler, que es lo unico que los saca de verdad.
        this.malFechados.set(r.mal_fechados && r.mal_fechados.movimientos > 0 ? r.mal_fechados : null);
        // [CGA11Y-O3b] Los conteos por grupo. `undefined` = el servidor desplegado todavia no
        // los manda: se deja null y la tira NO se dibuja, en vez de dibujarla con ceros.
        this.grupos.set(Array.isArray(r.grupos) ? r.grupos : null);
        this.errPend.set(null);
        this.cargandoPend.set(false);
        // `[CG.43]` La marca pertenece a la lista que se VE. Va ANTES del borrador: ese restaura
        // una vez por visita y despues no vuelve a podar nada.
        const soltadas = this.podarSeleccion(r.rows ?? []);
        // Lo tecleado que sobrevivio a un refresh. Va DESPUES de tener las filas: sin ellas no
        // se puede saber que conteos siguen aplicando.
        this.restaurarBorrador();
        if (soltadas) {
          // El borrador se reescribe con lo que QUEDO: si no, la proxima visita las resucita.
          this.persistir();
          // Se DICE. Una marca que desaparece sin motivo se lee como trabajo perdido, y la
          // persona vuelve a marcar lo mismo. No es un error: es el filtro haciendo su trabajo.
          this.toast.add({
            severity: 'info', summary: `${soltadas} marca(s) se soltaron`,
            detail: 'Esos movimientos ya no estan en la lista: cambio el filtro, o alguien mas los confirmo.',
            life: 5000,
          });
        }
      },
      // Un error de red NO es "no hay movimientos". Antes esto sólo apagaba la bandera, y en la
      // PRIMERA carga —con la lista vacía— la sección entera no se montaba: sin aviso y sin
      // reintento. Ahora se declara y app-load-state ofrece Reintentar.
      error: (e) => { this.errPend.set(this.textoError(e)); this.cargandoPend.set(false); },
    });
  }

  /**
   * `[CGA-A.49]` Cuántos días lleva esperando un pendiente (desde su fecha de documento, contra
   * el día de MÉXICO). `null` si no tiene fecha o está fechado adelante — eso ya lo dice `esFutura`.
   */
  diasPendiente(f: string | null | undefined): number | null {
    if (!f) return null;
    const d = Math.round((Date.parse(`${todayMx()}T12:00:00Z`) - Date.parse(`${String(f).slice(0, 10)}T12:00:00Z`)) / 864e5);
    return Number.isFinite(d) && d >= 0 ? d : null;
  }
  /** `[CGA-A.49]` El umbral de «atrasado»: el MISMO de la bandeja de «Mi trabajo» de la responsable. */
  protected readonly UMBRAL_ATRASO = CAJA_CONFIRMAR_UMBRAL_DIAS;

  /** ¿El documento está fechado después de hoy? Casi siempre es un error de captura en Kepler. */
  esFutura(f: string | null | undefined): boolean {
    if (!f) return false;
    // Contra el día de MÉXICO: con `toISOString()` este aviso se apagaba solo a partir de las
    // 18:00 locales, que es justo cuando se captura el cierre del día.
    return String(f).slice(0, 10) > todayMx();
  }

  estaMarcada(ref: string): boolean { return this.seleccion().has(ref); }

  /**
   * ⭐ `[CG.63]` EL FRENO SE MUDÓ ACÁ, y es lo que hace que la mudanza no pierda un invariante.
   *
   * «Nunca marcar una fila que el servidor va a rechazar» vivía en `onSeleccionTabla`, el callback
   * de la tabla — o sea atado a *un* dispositivo de entrada. Al pasar el clic de marcar a abrir,
   * ese callback desapareció y el freno se habría ido con él **sin que nada se pusiera rojo**:
   * `marcarTodas` filtra por su cuenta, así que la suite habría seguido verde con el agujero
   * abierto en el camino de a una. Ahora lo verifica el método que marca, venga de donde venga.
   *
   * ⚠️ Se marca contra lo que la cola tiene A LA VISTA: una referencia que no está en `pendientes`
   * no se puede confirmar, así que tampoco se marca. Fail-closed.
   */
  marcar(ref: string, on: boolean): void {
    if (on && !this.pendientes().some((p) => p.origen_ref === ref && p.confirmable)) return;
    const s = new Set(this.seleccion());
    if (on) s.add(ref); else s.delete(ref);
    this.seleccion.set(s);
    this.persistir();
  }

  /** Marca sólo las CONFIRMABLES: ofrecer marcar una trabada es prometer algo que va a fallar. */
  marcarTodas(on: boolean): void {
    this.seleccion.set(on
      ? new Set(this.pendientes().filter((p) => p.confirmable).map((p) => p.origen_ref))
      : new Set());
    this.persistir();
  }

  /**
   * ⛔ `[CG.43]` **La marca pertenece a la lista que se VE.**
   *
   * `seleccion` guarda referencias, no filas, y `cargarPendientes()` reemplaza las filas sin
   * tocarla. La unica poda que existia vivia dentro de `restaurarBorrador()`, que corre **una
   * vez por visita** — asi que a partir del segundo refresco la seleccion quedaba colgada.
   *
   * Lo que eso producia, medido con las dos pruebas de `[CG.43]`: la persona marca las 63
   * confirmables de la pagina, acota por signo —que es la navegacion que la PROPIA pantalla
   * recomienda cuando la lista viene topada en 100— y la bandeja trae otras filas. El boton
   * sigue diciendo "Confirmar 63", el encabezado aparece sin marcar, y al tocarlo se **escriben
   * en el libro 63 asientos de movimientos que no estan en pantalla**.
   *
   * ⚠️ Poda, NO vacia. El repaso de fondo de 60 s recarga la bandeja sin que nadie toque nada:
   * vaciar ahi le borraria las marcas a alguien que esta contando. Lo que sigue en la lista se
   * queda; lo que ya no esta, se suelta y **se dice**.
   *
   * Devuelve cuantas marcas se soltaron, para poder decirlo.
   */
  private podarSeleccion(filas: MovimientoPendiente[]): number {
    const vivos = new Set(filas.map((p) => p.origen_ref));
    const antes = this.seleccion();
    const quedan = new Set([...antes].filter((ref) => vivos.has(ref)));
    const soltadas = antes.size - quedan.size;
    if (soltadas) this.seleccion.set(quedan);
    return soltadas;
  }

  /** Usuario para la clave del borrador. Sin él no se persiste: un conteo ajeno es peor que ninguno. */
  private get usuarioBorrador(): string {
    return String(this.auth.user()?.sub ?? '');
  }

  /** Se restaura UNA vez por visita: después, mandar lo que la persona tiene en pantalla. */
  private borradorRestaurado = false;
  /** Lo que se recuperó de un borrador, para poder DECIRLO. `null` = no había nada. */
  restaurado = signal<{ marcadas: number; descartados: number; conteosViejos: number; hace: string } | null>(null);

  /**
   * Recupera lo tecleado que sobrevivió a un refresh.
   *
   * ⚠️ Sólo se restaura lo que SIGUE pendiente. Una marca cuya fila ya no está en la bandeja es
   * casi siempre un movimiento que otra persona confirmó mientras tanto; revivirla en silencio
   * la mandaría al lote para que el servidor la rechace. Lo que se descarta se DICE, no desaparece.
   */
  private restaurarBorrador(): void {
    if (this.borradorRestaurado) return;
    this.borradorRestaurado = true;
    const b = this.borrador.leer(this.usuarioBorrador);
    if (!b) return;

    const vivos = new Set(this.pendientes().map((p) => p.origen_ref));
    const s = new Set(b.marcadas.filter((r) => vivos.has(r)));
    const descartados = b.marcadas.length - s.size;
    // ⚠️ `[CG.48]` Un borrador guardado ANTES de que se retirara la columna puede traer conteos
    // por renglón. No se reviven —no hay dónde ponerlos y no llevan desglose— pero se DICEN:
    // callarlos le deja creer a la persona que nunca los tecleó. Con TTL de 12 h esto se apaga solo.
    const conteosViejos = (b.contado ?? []).length;
    // ⚠️ Acá había un `return` temprano cuando no quedaba nada que restaurar, y se comía el aviso
    // justo en el caso donde más importa: la persona marcó, se fue, alguien confirmó, y al volver
    // su marca ya no está. Callarse eso le deja creer que nunca la puso. Lo encontró la prueba.
    if (!s.size && !descartados && !conteosViejos) { this.borrador.borrar(this.usuarioBorrador); return; }
    if (!s.size) this.borrador.borrar(this.usuarioBorrador);

    this.seleccion.set(s);
    const min = Math.max(0, Math.floor((Date.now() - b.guardadoEn) / 60000));
    this.restaurado.set({
      marcadas: s.size,
      descartados,
      conteosViejos,
      hace: min < 2 ? 'recién' : min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h`,
    });
  }

  /**
   * Qué pasó con lo que estaba tecleado. Los casos se leen distinto a propósito: recuperar es
   * una buena noticia; que una marca tuya ya no aplique es un aviso; y un conteo por renglón de
   * un borrador viejo es un cambio de la pantalla, no un error de la persona.
   */
  textoRestaurado(b: { marcadas: number; descartados: number; conteosViejos: number; hace: string }): string {
    const n = (k: number, s: string) => `${k} ${s}${k === 1 ? '' : 's'}`;
    const retirados = b.conteosViejos
      ? ` Además tenías ${n(b.conteosViejos, 'conteo')} tecleado${b.conteosViejos === 1 ? '' : 's'} en la bandeja:`
        + ' esa columna se retiró, el conteo ahora va con su desglose en el arqueo.'
      : '';
    if (!b.marcadas) {
      if (!b.descartados) return `Tenías trabajo sin confirmar (${b.hace}).${retirados}`.trim();
      return `Tenías ${n(b.descartados, 'fila')} marcada${b.descartados === 1 ? '' : 's'} sin confirmar (${b.hace}) `
        + 'y ya no aplican: esos movimientos salieron de la bandeja, casi siempre porque alguien más los confirmó.'
        + retirados;
    }
    const base = `Se recuperaron ${n(b.marcadas, 'fila')} marcada${b.marcadas === 1 ? '' : 's'} sin confirmar (${b.hace}).`;
    return (b.descartados
      ? `${base} Otras ${n(b.descartados, 'fila')} ya no aplican: esos movimientos salieron de la bandeja.`
      : base) + retirados;
  }

  /** Tirar el borrador a propósito. Lo marcado es de la persona: se descarta cuando ella quiere. */
  descartarBorrador(): void {
    this.seleccion.set(new Set());
    this.borrador.borrar(this.usuarioBorrador);
    this.restaurado.set(null);
  }

  /** Persiste lo marcado. Se llama en CADA cambio: perder la selección es el defecto que esto arregla. */
  private persistir(): void {
    this.borrador.guardar(this.usuarioBorrador, this.seleccion());
  }

  confirmarLote(): void {
    const refs = this.marcadas();
    if (!refs.length || this.confirmando() || !this.puedeGestionar()) return;
    this.confirmando.set(true);
    // `[CG.48]` Sólo las referencias: el lote ESPEJA al ERP. Acá iba un `monto_contado` por fila
    // que entraba al libro sin un solo billete declarado detrás.
    this.svc.confirmarLote(refs.map((r) => ({ origen_ref: r })))
      .subscribe({
        next: (r) => {
          this.resultado.set(r);
          this.confirmando.set(false);
          this.seleccion.set(new Set());
          // Lo confirmado ya esta en el libro: el borrador cumplio y se retira.
          this.borrador.borrar(this.usuarioBorrador);
          this.restaurado.set(null);
          if (r.guardados) this.avisarOk(`${r.guardados} confirmadas`, money(r.monto_guardado));
          if (r.rechazados) this.toast.add({
            severity: 'warn', summary: `${r.rechazados} rechazadas`,
            detail: this.motivosRechazo(r), life: 8000,
          });
          // Se recarga TODO lo que el lote movió: la bandeja, el libro, el saldo y los cortes.
          this.cargarPendientes(); this.cargar(); this.cargarSaldo();
        },
        error: (e) => { this.confirmando.set(false); this.avisarError(e, 'No se pudo confirmar el lote'); },
      });
  }

  /**
   * El porqué de las que NO entraron. `ResumenLote.filas` trae `estado` y `motivo` POR FILA y el
   * resumen sólo publicaba agregados: "3 rechazadas" sin decir de qué, que obliga a adivinar.
   */
  private motivosRechazo(r: ResumenLote): string {
    const motivos = (r.filas ?? [])
      .filter((x) => x.estado === 'rechazado' && x.motivo)
      .map((x) => x.motivo as string);
    return motivos.length ? [...new Set(motivos)].join(' · ') : 'El servidor no devolvió el motivo.';
  }

  /** El resultado se cuenta por estado. "12 confirmadas" a secas esconde las 3 que no entraron. */
  textoResultado(r: ResumenLote): string {
    const p = [`${r.guardados} confirmadas por ${money(r.monto_guardado)}`];
    if (r.duplicados) p.push(`${r.duplicados} ya estaban aplicadas`);
    if (r.no_confirmables) p.push(`${r.no_confirmables} sin ruta declarada`);
    if (r.rechazados) p.push(`${r.rechazados} rechazadas`);
    return p.join(' · ');
  }

  // ── CG.20 — frecuentes del gasto ──────────────────────────────────────────────────────────────

  cargarFrecuentes(): void {
    // ⛔ Iba con `sucursalActiva`, clavada en '00', mientras la sucursal que se captura es
    // `f().sucursal`. O sea: capturando un gasto de la 03, los chips de un toque llenaban cuenta,
    // concepto y beneficiario de la 00 — en un catálogo que es POR SUCURSAL.
    //
    // ⭐ `[CG.97]` Y el `tipo` estaba clavado en 'gasto' por el mismo descuido, un eje más tarde:
    // el movimiento es 'ingreso' | 'gasto' | 'deposito' y el servidor toma el tipo que le manden
    // (`tipo: q.tipo || 'gasto'`), así que capturando un ingreso se pedían —y se ofrecían— los
    // pares de los GASTOS de esa persona. Pedir con el tipo en curso es la misma corrección que
    // ya se hizo con la sucursal: el catálogo se pide con lo que se está capturando, no con una
    // constante. Se recarga en `onTipo` por la misma razón que en `onSucursal`.
    this.svc.frecuentes({ tipo: this.f().tipo, sucursal: this.f().sucursal, limit: 10 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.frecuentes.set(r.rows ?? []),
      // ⛔ [CG.181] ACÁ SE VACIABA LA LISTA, y un 429 se veía igual que "esta persona no repite
      // nada". Medido en producción: esta petición sale dos veces al cargar y la segunda rebota.
      // Los chips son un ATAJO, no una cifra, así que no hace falta un aviso: lo que no se puede
      // es BORRAR lo que ya se había medido. Si la recarga falla, se conserva lo anterior — una
      // lista vieja es más veraz que una vacía inventada. (Mismo criterio que el cero de arriba.)
      error: () => { /* se conserva lo último que sí se midió */ },
    });
  }

  /** Un toque llena cuenta, concepto, glosa y beneficiario. El importe NUNCA se pre-llena. */
  // ══ `[CG.182]` EL CORTE DE CAJA QUE LA PERSONA TIENE EN LA MANO ════════════════════════════
  //
  // El problema, medido en prod: para declarar de dónde salió un depósito, la única declaración
  // humana que existe es texto libre — **708 referencias distintas en 749 depósitos**, cero
  // parseables, y la misma ruta escrita de tres formas. Y se ve por sucursal: en la 00, 31 de 34
  // cobros declaran ruta y fecha; en Morelia (07 y 08), **0 de 16** — todas "DEPOSITO EFECTIVO
  // CAJA GENERAL M.M. 08/10/2026", un bulto del día. Por eso unos son rastreables y otros no.
  //
  // ⭐ Lo que esto hace NO es casar: es **prellenar**. Elegir el corte escribe la glosa con su
  // caja, su plaza y su fecha, igual que `usarFrecuente` escribe cuenta y concepto. La liga
  // ESTRUCTURAL (`finance.caos_cash_links`) es la versión siguiente y vive en el backend; ésta
  // entrega hoy lo que de verdad falta: que la declaración salga estructurada del lugar donde se
  // hace, sin pedirle a nadie que cambie de hábito.
  //
  // ⛔ Y el importe **ordena, no decide**. Casar por monto es imposible y está medido: CAOS no
  // recibe monedas, los 749 depósitos son múltiplos de 10, así que una venta con centavos NUNCA
  // puede igualar a un depósito. Poner arriba el corte más cercano le ahorra la lectura a la
  // persona sin afirmar nada — el mismo criterio con el que `VERDAD_ABSOLUTA` conserva el precio
  // pero no lo deja votar. Por eso NO se rotula "sugerido": la liga la declara quien captura.

  /** Los cortes que se ofrecen. Vacío NO es "no hay": lo dice `cortesEstado()`. */
  cortesPos = signal<CorteRow[]>([]);
  /** Cuatro estados, no dos. `vacio` y `falla` son ausencias distintas y se dicen distinto. */
  cortesEstado = signal<'inicial' | 'cargando' | 'listo' | 'falla'>('inicial');
  /** El corte más reciente que trajo la ventana. `null` = no vino ninguno. */
  cortesUltimo = signal<string | null>(null);
  cortesSel: (CorteRow & { label: string }) | null = null;

  /**
   * ⚠️ **SIETE días, y la ventana no puede ser corta.** Entre el corte y su depósito pasan días:
   * el caso real que originó esto son **5** (corte del 08-oct, depósito del 13), y el rezago de
   * captura medido va de 1.7 a 3 días con máximo 7. Una ventana de 3 días le queda corta a la
   * persona justo en el caso que la hizo abrir la pantalla.
   */
  private readonly CORTES_DIAS = 7;

  /**
   * ⛔ **«Hoy» está VACÍO y hay que decirlo.** Los cortes del POS cargan con ~1 día de rezago, así
   * que una lista sin el día de hoy se lee como «no hubo cortes» cuando lo cierto es «todavía no
   * llegaron». Son dos ausencias y ésta tiene dueño distinto: no la resuelve quien captura.
   */
  cortesAviso = computed(() => {
    const estado = this.cortesEstado();            // se lee SIEMPRE: sin esto el computed no recalcula
    const ultimo = this.cortesUltimo();
    if (estado === 'falla') return 'No se pudo leer la lista de cortes. No es que no haya: no se pudo preguntar.';
    if (estado !== 'listo') return null;
    if (!this.cortesPos().length) return `Sin cortes en los últimos ${this.CORTES_DIAS} días para esta sucursal.`;
    return ultimo && ultimo < todayMx()
      ? `Lo más reciente es del ${dmy(ultimo)}: los cortes del POS cargan con un día de rezago.`
      : null;
  });

  /**
   * ⭐ El importe ORDENA, no decide. Los más cercanos a lo contado primero; a igual distancia,
   * el más reciente. Si todavía no hay monto, manda la fecha.
   *
   * ⛔ Y NO se rotula «sugerido» ni se autoselecciona: casar por monto es **imposible** y está
   * medido —CAOS no recibe monedas, los 749 depósitos son múltiplos de 10, así que una venta con
   * centavos nunca puede igualar a un depósito—. Esto es orden de lectura, no una afirmación.
   */
  private ordenarCortes(rows: readonly CorteRow[]): CorteRow[] {
    const ref = Number(this.f().monto) || 0;
    return [...rows].sort((a, b) => {
      if (ref > 0) {
        const d = Math.abs(Number(a.monto) - ref) - Math.abs(Number(b.monto) - ref);
        if (d !== 0) return d;
      }
      return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0;
    });
  }

  /** La etiqueta lleva el CÓDIGO además del nombre: el código `03` tiene dos nombres vivos
   *  («8 Esquinas» y «8ESQ») y quien trae el reporte de Kepler en la mano puede leer cualquiera. */
  corteLabel = (c: CorteRow) =>
    `${dmy(c.fecha)} · ${c.referencia || 'sin caja'} · ${c.sucursal_nombre} (${c.sucursal}) · ${money(c.monto)}`;

  cargarCortesPos(): void {
    const hasta = todayMx();
    const d = new Date(`${hasta}T12:00:00`);
    d.setDate(d.getDate() - (this.CORTES_DIAS - 1));
    const desde = toMxDateKey(d);
    this.cortesEstado.set('cargando');
    this.svc.cortesDeCaja(desde, hasta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        // Acotado a la sucursal que se está capturando: la mediana por sucursal son ~20 cortes
        // en 7 días, y la lista plana de la red son 195 — inusable.
        const suc = this.f().sucursal;
        const propios = (r.cortes ?? []).filter((c) => !suc || c.sucursal === suc);
        this.cortesPos.set(propios);
        this.cortesUltimo.set(r.ultimo_corte ?? null);
        this.cortesEstado.set('listo');
      },
      // ⛔ No se vacía la lista: un fallo no es una ausencia de cortes. Se DECLARA en `cortesAviso`.
      error: () => { this.cortesEstado.set('falla'); this.cortesUltimo.set(null); },
    });
  }

  buscarCortes(e: AutoCompleteCompleteEvent): void {
    if (this.cortesEstado() === 'inicial') { this.cargarCortesPos(); return; }
    const base = this.ordenarCortes(this.cortesPos());
    // Busca por caja, folio, plaza Y CÓDIGO. Sin el código, quien lee «03» en el papel no lo
    // encuentra, que es la mitad del problema que la lista viene a resolver.
    // ⭐ Tokenizado con el helper compartido, no `includes()`: así «pina» encuentra «PIÑA», el
    // orden de las palabras deja de importar, y «03 caja» ya no exige que estén pegadas.
    const hit = filtrarPorBusqueda(base, e.query, (c) =>
      [c.referencia, c.documento, c.sucursal_nombre, c.sucursal, c.fecha].map((v) => (v == null ? '' : String(v))));
    this.cortesOpciones.set(hit.map((c) => ({ ...c, label: this.corteLabel(c) })));
  }

  cortesOpciones = signal<Array<CorteRow & { label: string }>>([]);

  /**
   * ⭐⭐ Elegir un corte **PRELLENA**, no ancla. La glosa sale escrita con la caja, la plaza y la
   * fecha — que es exactamente lo que hoy se teclea a mano y sale distinto cada vez.
   *
   * ⛔ El MONTO no se toca: lo que se guarda es lo que se contó, no lo que vendió la caja. En el
   * caso real faltan $4,508.99 entre lo vendido y lo depositado (monedas que CAOS no toma + lo no
   * depositado), así que copiar el monto del corte inventaría un depósito que no ocurrió.
   */
  usarCorte(e: AutoCompleteSelectEvent): void {
    const c = e.value as CorteRow;
    if (!c) return;
    this.f.update((v) => ({
      ...v,
      glosa: `Corte ${c.referencia || c.documento} · ${c.sucursal_nombre} · ${dmy(c.fecha)}`,
      fecha: v.fecha,            // la fecha del movimiento es la del DEPÓSITO, no la del corte
    }));
    this.onGlosa(this.f().glosa);
  }

  soltarCorte(): void {
    this.cortesSel = null;
    this.f.update((v) => ({ ...v, glosa: '' }));
  }


  usarFrecuente(fr: Frecuente): void {
    const suc = this.f().sucursal;
    this.f.update((v) => ({
      ...v,
      kepler_cuenta: fr.kepler_cuenta,
      kepler_concepto: fr.kepler_concepto,
      glosa: fr.glosa || v.glosa,
      beneficiario: fr.beneficiario || v.beneficiario,
    }));
    // El buscador de conceptos muestra lo elegido, para que se vea de dónde salió.
    this.conceptoSel = {
      cuenta: fr.kepler_cuenta, concepto: fr.kepler_concepto,
      concepto_nombre: fr.glosa || '', sucursal: suc, cuenta_mayor: '',
      label: `${fr.kepler_cuenta} / ${fr.kepler_concepto}`,
    };
    this.conceptoManual.set(true);
  }

  buscarConceptos(e: AutoCompleteCompleteEvent): void {
    // CS.3.1b — Con la cuenta anclada al documento, el buscador se ACOTA a los conceptos de esa
    // cuenta (no busca en todo el catálogo): la cuenta no se cambia sin "corregir".
    const doc = this.cuentaFuenteDoc();
    if (doc) {
      const suc = this.f().sucursal;
      this.conceptos.set(doc.conceptos.map((x) => {
        const c: ConceptoKepler = { cuenta: doc.cuenta, concepto: x.concepto, concepto_nombre: x.concepto_nombre ?? '', sucursal: suc, cuenta_mayor: '' };
        return { ...c, label: this.conceptoLabel(c) };
      }));
      return;
    }
    this.svc.conceptos(this.f().sucursal || undefined, e.query || '', 30).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // `label` es lo que el autocomplete pinta: la vista no arma texto en la plantilla.
      next: (r) => this.conceptos.set((r.rows ?? []).map((c) => ({ ...c, label: this.conceptoLabel(c) }))),
      error: (err) => this.avisarError(err, 'No se pudo buscar el concepto'),
    });
  }

  elegirConcepto(e: AutoCompleteSelectEvent): void {
    const c = e.value as ConceptoKepler;
    this.f.update((v) => ({
      ...v, kepler_cuenta: c?.cuenta ?? null, kepler_concepto: c?.concepto ?? null,
    }));
    this.conceptoManual.set(true);
  }

  onSucursal(v: string): void {
    this.setF('sucursal', v);
    this.conceptos.set([]);
    this.conceptoSel = null;
    this.pedirPropuesta();
    // El catálogo de frecuentes es por sucursal: cambiar de plaza cambia los chips.
    this.cargarFrecuentes();
  }

  private debounce?: ReturnType<typeof setTimeout>;
  pedirPropuestaDebounced(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.pedirPropuesta(), 350);
  }

  /** Pide una PROPUESTA. Nunca pisa lo que el humano ya eligió a mano. */
  pedirPropuesta(): void {
    const f = this.f();
    const c = this.cobroElegido();
    if (!f.tipo && !f.beneficiario && !f.glosa && !c) return;
    this.svc.autofill({
      tipo: f.tipo, sucursal: f.sucursal,
      glosa: f.glosa || undefined, beneficiario: f.beneficiario || undefined,
      // ⭐ `[CG.108]` El documento abre el NIVEL 0: con él, el servidor va a la contabilidad de
      // Kepler y LEE la cuenta en vez de aprenderla. Sin esta línea el nivel existe y nunca
      // se consulta — un motor nuevo que no recibe su entrada se lee igual que uno que no
      // propone, y ése es el modo más caro de equivocarse.
      origen_ref: c?.origen_ref || undefined,
      // `[CG.109]` El tercero abre el Nivel 0.5: la regla de la entidad, que cubre lo que el
      // documento no resuelve (cajas chicas, tarjetas, cobros de ruta).
      entidad_code: c?.entidad_code || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.propuesta.set(r);
        const v = r.concepto?.value;
        if (v && !this.conceptoSel) {
          this.f.update((x) => ({ ...x, kepler_cuenta: v.kepler_cuenta, kepler_concepto: v.kepler_concepto }));
          // ⛔ Antes se escribía el par contable y NO se tocaba `conceptoSel`, que es lo que pinta
          // el buscador: el campo "Cuenta y concepto de Kepler" se veía VACÍO mientras el
          // formulario ya llevaba una cuenta adentro, y se guardaba un asiento a una cuenta que
          // la persona nunca vio. Lo propuesto se MUESTRA, con su etiqueta de procedencia.
          this.conceptoSel = {
            cuenta: v.kepler_cuenta, concepto: v.kepler_concepto,
            concepto_nombre: r.concepto?.source ? 'propuesto' : '', sucursal: f.sucursal, cuenta_mayor: '',
            label: `${v.kepler_cuenta} / ${v.kepler_concepto}`,
          };
          // Sigue siendo PROPUESTO, no manual: la etiqueta tiene que poder decirlo.
          this.conceptoManual.set(false);
        }
      },
      error: () => this.propuesta.set(null),
    });
  }

  /**
   * ⚠️ `[CG.38]` Estos tres reciben la DENOMINACIÓN entera, no su valor. Con monedas en la reja,
   * `piezasDe(20)` es ambiguo —hay billete y moneda de $20— y devolvería el renglón equivocado.
   * Pasando el objeto, la llave viaja con el valor y no hay nada que adivinar.
   */
  /**
   * ⛔⛔ `[CG.114]` **DEVOLVÍA `0`, Y ESE CERO SE ESCRIBE EN LA CAJA.**
   *
   * Edgar: *"otro error típico de pendejos es poner un 0 por default en una caja, si yo pongo 1
   * se escribe 10"*. Es literal: con un `0` ya tecleado, escribir `1` deja **`10`** — y en una
   * reja de arqueo eso no es una molestia, es un billete de más por renglón, en el campo del que
   * sale el monto del movimiento.
   *
   * ⭐ Y es el mismo defecto que ADR-056 nombra, movido al formulario: **dibujar un cero donde no
   * hubo medición**. "No conté este renglón" y "conté y había cero" son hechos distintos, y el
   * `0` los aplastaba en uno. `null` deja la caja VACÍA con su `placeholder`, que es lo que de
   * verdad hay: nada contado todavía.
   *
   * ⚠️ Del lado de la escritura no cambia nada: `setPiezas` ya hacía `Number(piezas) || 0` y sólo
   * guarda el renglón cuando es mayor que cero.
   */
  piezasDe(d: Denominacion): number | null {
    return this.f().denominaciones.find((x) => x.denom_key === d.key)?.piezas ?? null;
  }

  /** Lo que suma ese renglón. Se CALCULA: no hay dónde teclearlo, y por eso va deshabilitado. */
  subtotalDe(d: Denominacion): number { return redondea(d.valor * (this.piezasDe(d) ?? 0)); }

  setPiezas(d: Denominacion, piezas: number): void {
    const list = this.f().denominaciones.filter((x) => x.denom_key !== d.key);
    // Enteras y no negativas: medio billete no existe, y el CHECK del servidor lo rechaza.
    const n = Math.max(0, Math.trunc(Number(piezas) || 0));
    if (n > 0) list.push({ denom_key: d.key, denominacion: d.valor, piezas: n });
    this.f.update((v) => ({ ...v, denominaciones: list }));
    this.recomputarMonto();
  }

  setMorralla(v: number | null): void {
    this.setF('morralla', Math.max(0, Number(v) || 0));
    this.recomputarMonto();
  }

  /**
   * CG.23 — **El monto sale del conteo, siempre.**
   *
   * Antes el monto se tecleaba y el desglose era opcional, así que podía haber dos cifras
   * distintas para el mismo efectivo y `arqueo_no_cuadra` existía para avisar del choque.
   * Derivándolo, el choque no puede ocurrir.
   *
   * Pasa por `onMonto` a propósito y no por `setF('monto')`: ahí vive la decisión de cuándo
   * lo contado constituye un CONTEO frente al documento del ERP (`monto_contado`), que es lo
   * que el servidor necesita para distinguir "conté distinto" de "el front mandó mal el
   * importe". Un solo camino, sin copiar esa regla en dos lados.
   */
  private recomputarMonto(): void {
    // CS.3.7 — El monto = el arqueo COMPLETO (lo que aportó el cajero, mostrado aparte, + la reja
    // manual) + morralla. La reja de abajo es SÓLO la diferencia; CAOS no se teclea ahí.
    // CS.3.13 — + la VENTA A CRÉDITO (no llegó en efectivo pero es parte del total): monto = efectivo
    // + crédito. Así el monto>0 se cumple aunque la venta sea toda a crédito (efectivo 0).
    const efectivo = sumaDesglose(this.denominacionesParaGuardar(), Number(this.f().morralla || 0));
    // ⭐ [CG.38] El cambio que se devolvió SE RESTA. Sin esto, un cobro de $4,830 con un billete
    // de $5,000 se guardaba como $5,000 y los $170 que volvieron al cliente quedaban dentro del
    // movimiento: la caja declaraba tener efectivo que ya no estaba.
    this.onMonto(efectivo - this.totalDevuelto() + (Number(this.ventaCredito()) || 0));
  }

  // ── [CG.38] El cambio que se devuelve ───────────────────────────────────────────────────────

  /**
   * Arranca PLEGADO: la mayoría de los movimientos no devuelven cambio, y un bloque de once
   * campos abierto por default convierte el caso común en el caso lento. El pedido fue
   * explícito — *"que sea un proceso rápido"*.
   */
  cambioAbierto = signal(false);

  /** Lo que salió de la caja en este mismo acto. Mismo tipo que lo que entró. */
  devuelto = signal<DenominacionCapturada[]>([]);

  /**
   * ⛔ `[CG.114]` **Las tres cajas de DINERO, con el mismo defecto que las de piezas.**
   *
   * El modelo de abajo sigue siendo `number` (lo usa la aritmética del monto y cambiarle el tipo
   * se propaga a media pantalla). Lo que cambia es lo que se PINTA: cero se muestra como caja
   * vacía con su `placeholder`, y sólo se escribe lo que alguien tecleó.
   *
   * ⚠️ Son getters de VISTA, no el estado. Por eso no hay dos verdades: el valor sigue viviendo
   * en un solo lugar y esto sólo decide cómo se ve cuando vale cero.
   */
  morrallaVista(): number | null { return this.f().morralla || null; }
  ventaCreditoVista(): number | null { return this.ventaCredito() || null; }
  morrallaCorteVista(): number | null { return this.morrallaCorte() || null; }

  /** `[CG.114]` `null`, no `0`: ver `piezasDe`. Un cero tecleado vuelve `1` en `10`. */
  piezasDevueltasDe(d: Denominacion): number | null {
    return this.devuelto().find((x) => x.denom_key === d.key)?.piezas ?? null;
  }

  /** El subtotal SI es un numero: una reja vacia vale cero pesos. Lo que no puede valer
   *  cero es la CAJA, que es otra pregunta. */
  subtotalDevueltasDe(d: Denominacion): number { return redondea(d.valor * (this.piezasDevueltasDe(d) ?? 0)); }

  setPiezasDevueltas(d: Denominacion, piezas: number): void {
    const list = this.devuelto().filter((x) => x.denom_key !== d.key);
    const n = Math.max(0, Math.trunc(Number(piezas) || 0));
    if (n > 0) list.push({ denom_key: d.key, denominacion: d.valor, piezas: n });
    this.devuelto.set(list);
    this.recomputarMonto();
  }

  totalDevuelto = computed(() =>
    redondea(this.devuelto().reduce((a, d) => a + d.denominacion * d.piezas, 0)));

  /** Pasa una lista de renglones a la forma `{llave: piezas}` que pide el motor compartido. */
  private porLlave(dens: DenominacionCapturada[]): Record<string, number> {
    const m: Record<string, number> = {};
    for (const d of dens) m[d.denom_key] = (m[d.denom_key] ?? 0) + d.piezas;
    return m;
  }

  /**
   * El veredicto del motor compartido: cuánto entró, cuánto salió, el neto, y **el problema con
   * su monto** cuando no se puede guardar. El mismo motor lo va a correr el servidor: acá se
   * adelanta para que la persona se entere ANTES de mandar, no por un 400.
   */
  resumenCambio = computed(() => evaluarCambio(
    this.porLlave(this.denominacionesParaGuardar()),
    this.porLlave(this.devuelto()),
    Number(this.f().morralla || 0),
  ));

  /** Si hay algo devuelto, el bloque se queda abierto aunque se vuelva a tocar el botón. */
  hayDevuelto = computed(() => this.devuelto().length > 0);

  /** CS.3.13 — La parte a crédito. Recalcula el monto (efectivo + crédito). Siempre editable. */
  setVentaCredito(v: number | null): void {
    this.ventaCredito.set(Math.max(0, Number(v) || 0));
    this.recomputarMonto();
  }

  textoBloqueo(b: MotivoBloqueo): string { return TEXTO_BLOQUEO[b]; }

  sevTipo(t: string): 'success' | 'danger' | 'info' {
    return t === 'ingreso' ? 'success' : t === 'gasto' ? 'danger' : 'info';
  }

  /**
   * `[CGP-L.8]` El comprobante desde el DETALLE del servidor, con las dos pilas por separado: lo
   * recibido va al desglose y el cambio a su sección. Mezclarlas imprimía el cambio como recibido.
   */
  comprobanteDeDetalle(
    d: MovimientoCaja & { denominaciones?: Array<{ denominacion: number; piezas: number; flujo?: 'recibido' | 'devuelto' }> | null },
  ): ComprobanteCaja {
    const { recibido, devuelto } = separarPorFlujo(d.denominaciones);
    return { ...this.comprobanteDe(d, recibido), devuelto };
  }

  /** CS.3.8 — Arma el comprobante desde un movimiento + su desglose por denominación. */
  private comprobanteDe(m: MovimientoCaja, dens: Array<{ denominacion: number; piezas: number }>): ComprobanteCaja {
    return {
      folio: m.folio, tipo: m.tipo, fecha: dmy(m.fecha), sucursal: m.sucursal,
      beneficiario: m.beneficiario, kepler_cuenta: m.kepler_cuenta, kepler_concepto: m.kepler_concepto,
      kepler_concepto_nombre: m.kepler_concepto_nombre, glosa: m.glosa,
      denominaciones: dens, morralla: Number(m.morralla || 0), monto: Number(m.monto),
      created_by_username: m.created_by_username, created_at: m.created_at,
    };
  }

  /**
   * CS.3.8 — Imprime (o re-imprime) el comprobante de un movimiento en la térmica: trae el detalle
   * con las denominaciones y lo manda al ticket (folio nuestro, desglose, concepto, recibido, total,
   * firma). Se usa desde la lista; al guardar se imprime solo con lo recién enviado.
   */
  imprimirComprobante(m: MovimientoCaja): void {
    this.svc.detalle(m.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        if (!imprimirTicketComprobante(this.comprobanteDeDetalle(d))) {
          this.avisarError(null, 'El navegador no dejó abrir la impresión del comprobante');
        }
      },
      error: (e) => this.avisarError(e, 'No se pudo abrir el comprobante'),
    });
  }

  /**
   * `[CG.122]` `imprimir` es el ACCESO DIRECTO AL TICKET, y existe sin deshacer `[CG.81]`.
   *
   * Edgar hizo quitar la impresion automatica: el papel salia en CADA captura y en un dia
   * normal son ~84 movimientos, o sea 84 tickets que nadie pidio. Eso no cambia -- `Guardar`
   * sigue sin imprimir nada.
   *
   * Lo que faltaba era el caso contrario: cuando el ticket SI hace falta, porque quien entrega
   * el efectivo lo pide. Hasta hoy habia que guardar, salir del arqueo, buscar el movimiento en
   * el libro y apretar un icono -- con la persona esperando.
   *
   * ⭐ Va en el dialogo de confirmacion y no en el pie del arqueo a proposito: ahi es donde se
   * decide, con la persona enfrente, y no obliga a elegir antes de saber si va a hacer falta.
   * El default sigue siendo no imprimir; imprimir es el que se pide.
   *
   * ⚠️ Se imprime DESPUES de guardar y con el movimiento que devuelve el servidor, no con el
   * formulario: el ticket lleva el folio nuestro y la fecha que asigno el servidor. Imprimir
   * antes seria papel con un folio que todavia no existe.
   */
  guardar(imprimir = false): void {
    if (this.bloqueos().length || this.guardando() || !this.puedeGestionar()) return;
    this.guardando.set(true);
    // `[CG.62]` La ventana se cierra ACA, al empezar: si fallara, el aviso de error tiene que
    // quedar a la vista y la captura abierta para reintentar, no detras de un modal.
    this.cerrarConFoco(this.confirmarGuardar);
    const cobro = this.cobroElegido();
    const caos = this.caosElegido();
    const f = this.f();
    // Se lee ANTES de emitir: el `next` corre despues y para entonces el dialogo ya se cerro.
    const declarar = this.declararRegla() && this.puedeDeclararRegla();
    // ⛔ `[CG.81]` Acá se leía `densComprobante` para imprimir el comprobante en el `next`. Se fue
    // con la impresión automática: el payload de abajo vuelve a llamar a `denominacionesParaGuardar()`
    // por su cuenta, así que esta línea quedó sin un solo consumidor.
    this.svc.crear({
      ...f,
      // CS.3.7 — El arqueo que va al servidor es el COMPLETO: el del cajero (en la UI va aparte) +
      // la reja manual, fusionados. El servidor exige que el desglose cuadre con el monto; por eso
      // acá se manda todo junto aunque en pantalla el cajero y la reja se muestren separados.
      // ⭐ [CG.38] Las DOS pilas viajan juntas, separadas por `flujo`. Sin el `devuelto` el
      // servidor vería un arqueo de $5,000 contra un monto de $4,830 y lo rechazaría por no
      // cuadrar — y antes de esta fase ese cambio simplemente no se registraba en ningún lado.
      denominaciones: [
        ...this.denominacionesParaGuardar().map((d) => ({ ...d, flujo: 'recibido' as const })),
        ...this.devuelto().map((d) => ({ ...d, flujo: 'devuelto' as const })),
      ],
      // ⭐ CG.19 — la llave del documento de Kepler. Con esto el servidor RELEE el monto del ERP y
      // descarta el del formulario, y el índice único impide que el mismo documento entre dos veces.
      // ⛔ Acá estaba clavado en 'cobro'. Con CG.21 el diálogo puede anclar TAMBIÉN un pago, y un
      // `X-D-26` guardado como 'cobro' es un origen mal etiquetado: el backend decide si relee el
      // importe del ERP con `ORIGEN_ANCLADO = ['cobro','pago_proveedor']`, y el CHECK admite los
      // dos. La fila ya trae su propio `origen_tipo` (la vista lo emite por signo) — se usa ése,
      // igual que hace el lote; el fallback por signo es sólo por si la vista no lo mandara.
      // CS.3 — si el origen es CAOS, va `origen_tipo='caos'` + `origen_ref='device|external_id'` (el
      // candado del servidor garantiza que ese movimiento se capture una vez). CAOS NO ancla a un
      // documento: el monto sale del arqueo precargado, no se relee de Kepler.
      origen_tipo: caos ? 'caos' : (cobro ? (cobro.origen_tipo || (cobro.tipo === 'ingreso' ? 'cobro' : 'pago_proveedor')) : null),
      origen_ref: caos ? caos.origen_ref : (cobro ? cobro.origen_ref : null),
      // ⭐ `[CGA-A.10b]` La LLAVE del documento que esta captura declara pagar. Sólo con origen
      // CAOS: con documento anclado la identidad ya viaja en `origen_ref`. Sin esto, el
      // descuento de la cola compara la GLOSA —texto libre— y tapa a cualquier otra sucursal
      // con el mismo `doc_tipo + folio`, que en camioneta se repite a diario (`GOTCHAS` §86).
      declared_doc_ref: caos ? (this.docDeclarado() ?? undefined) : undefined,
      // `[CG.160]` Por qué no hay documento. Va SIEMPRE que no haya origen; con origen el servidor
      // lo ignora (`conciliacion()` corta en `enlazado` antes de mirarlo).
      sin_documento_motivo: (!caos && !cobro) ? (this.sinDocumentoMotivo().trim() || undefined) : undefined,
      // ⭐ Lo CONTADO, en su campo propio. Sin esto el servidor relee el importe del documento y
      // descarta el conteo: la diferencia llegaba al hallazgo pero NO al libro, o sea que la caja
      // guardaba lo que decía Kepler y el efectivo de más (o de menos) se evaporaba. El backend ya
      // tenía `monto_contado` resuelto; lo que faltaba era que la pantalla lo mandara.
      monto_contado: this.montoContado() ?? undefined,
      // ⭐ `[CG.67]` La firma viaja como imagen y nombre. ⛔ NO se manda `firma_estado`: lo
      // calcula el servidor (`revisarFirma`, ADR-076). Si la pantalla lo mandara, podría
      // declarar "firmado" sin imagen.
      // `[CG.68]` Si vino del telefono, esa manda. ⛔ Y solo si SIGUE valiendo: si el monto
      // cambio despues de firmar, la firma corresponde a otra cifra y no se manda.
      firma_png: (this.firmaRemotaVale() ? this.firmaRemotaPng() : null) ?? this.firmaPad?.aPng() ?? undefined,
      firma_nombre: this.firmaNombre().trim() || undefined,
      // CS.3.13 — la parte a crédito (no efectivo). El servidor la persiste y el arqueo la cuenta como
      // parte del total (efectivo + crédito = monto).
      venta_credito: this.ventaCredito() || undefined,
      // CS.3.4 — los retiros del cajero (CAOS) que financiaron este gasto: el servidor los enlaza
      // (consume, no se cuentan dos veces) y aprende de ellos. Sólo si el capturista vinculó alguno.
      caos_links: this.caosVinculados().length
        ? this.caosVinculados().map((v) => ({ device: v.device, external_id: v.external_id, monto: v.monto, senales: v.senales }))
        : undefined,
      // La procedencia viaja con el movimiento: qué campo propuso el motor y con qué respaldo.
      autofill: this.propuesta()?.provenance ?? null,
      // `crypto.randomUUID` sólo existe en contexto seguro: por http:// en la LAN `guardar()`
      // reventaba antes de emitir la petición. `uuidV4()` tiene el respaldo ([CGP-V.10]).
      client_uuid: uuidV4(),
    }).subscribe({
      next: (m) => {
        this.guardando.set(false);
        this.capturaAbierta.set(false);
        this.avisarOk('Movimiento registrado', `${this.etiquetaTipo(f.tipo)} por ${moneyOSinMedir(f.monto)}`);
        // `[CGS.7]` El folio en grande, para anotarlo en el papel. Va con el que devolvió el
        // servidor, no con uno armado acá: el folio lo asigna la base.
        this.mostrarFolio((m as { folio?: unknown } | null)?.folio);
        // `[CG.122]` El ticket SOLO si lo pidieron en el diálogo. Va con el movimiento que
        // devolvió el servidor —que ya trae folio y fecha— y reusa el mismo camino que el botón
        // del libro, así que no hay una segunda forma de armar el papel que se desalinee.
        if (imprimir) this.imprimirComprobante(m);
        /**
         * ⛔ `[CG.81]` **ACÁ EL COMPROBANTE SALÍA SOLO A LA TÉRMICA, y se retiró.** Pedido de
         * Edgar: *"hay que dejar de mandar el imprimible del ticket y sólo almacenarlo como un
         * historial"*.
         *
         * Era `CS.3.8`: al guardar se imprimía con lo recién enviado. El papel sale en CADA
         * captura, y en un día normal de la caja general son ~84 movimientos (medido en el libro
         * de Access el 2026-10-09) — o sea 84 tickets que nadie pidió.
         *
         * ⭐ Y no se pierde nada, verificado antes de quitarlo: el comprobante se DERIVA del
         * movimiento, no es un documento aparte. Medido en prod sobre las 5 filas vivas de
         * `finance.cash_ledger`, **las 5 tienen su desglose guardado** en
         * `finance.cash_ledger_denominations` (2, 2, 1, 2 y 7 renglones). El botón de la lista
         * reconstruye el papel pidiendo `svc.detalle(id)`, así que el historial alcanza.
         *
         * ⚠️ Por eso NO se guarda el texto renderizado del ticket: sería una copia de algo que ya
         * está, y una copia que se desalinea en silencio en cuanto cambie el formato. El historial
         * ES el movimiento con su desglose; el papel es una vista de eso.
         *
         * ⛔ **Y lo que este papel imprimía NO era lo mismo que imprime el botón** — los dos
         * difieren, y en direcciones opuestas. El desglose se guarda en DOS pilas (`flujo`
         * `recibido` y `devuelto`, `[CG.38]`), y ninguno de los dos caminos la respeta:
         *
         *   · éste mandaba sólo `denominacionesParaGuardar()` = la pila `recibido`, sin el vuelto;
         *   · el botón pide `svc.detalle(id)`, que trae las dos pilas APLANADAS — ni filtra por
         *     `flujo` ni lo devuelve (`.select('denominacion','piezas')`), y el ticket tampoco
         *     sabe de `flujo`.
         *
         * Medido: hoy **ninguno de los 5 movimientos tiene pila `devuelto`**, así que en la
         * práctica coinciden. El primero que capture con vuelto va a imprimir un desglose que
         * suma MÁS que el monto, sin que nada avise. Queda DECLARADO acá, no arreglado de paso:
         * arreglarlo de verdad es que el ticket muestre las dos pilas, y eso es otro cambio.
         */
        // La regla va DESPUÉS de que el movimiento se guardó, y en su propia petición: si
        // declararla falla, el registro del efectivo ya está hecho y no se pierde.
        if (declarar) this.declararCuenta(f);
        /**
         * ⛔ `[CG.93]` **ACÁ FALTABA `cargarPendientes()`, y se podía capturar DOS VECES lo mismo.**
         *
         * Al guardar se recargaba el libro y el saldo, pero NO la cola. La fila recién capturada
         * seguía en pantalla hasta el refresco de fondo —cada 60 s— y en esa ventana un segundo
         * clic la volvía a abrir: mismo documento, dos movimientos, dinero contado doble.
         *
         * La de-duplicación del servidor es por `origen_ref` y existe (`[CG.85]`), pero recién se
         * nota al RECARGAR; lo que la pantalla mostraba mientras tanto era trabajo que ya no
         * estaba. Una lista que no se refresca después de modificarla es una lista que miente.
         *
         * ⭐ Y de paso es lo que encadena el flujo: al volver la lista sin lo capturado,
         * `avanzarAlSiguiente()` abre el que sigue. Contar, guardar, contar, guardar.
         *
         * ⭐ **Éste es el ÚNICO lugar que encadena**, y por eso lo pide explícito. Atado a la
         * carga, el mismo avance se disparaba al entrar, al filtrar y cada 60 s — ver el bloque
         * de `encadenar` en `cargarPendientes()`.
         */
        this.cargarPendientes(false, true);
        this.cargar(); this.cargarSaldo();
      },
      error: (e) => { this.guardando.set(false); this.avisarError(e, 'No se pudo guardar el movimiento'); },
    });
  }

  /**
   * Declara el beneficiario -> cuenta. Va en su propia peticion y NO tumba nada si falla: el
   * efectivo ya quedo registrado, y una regla que no se pudo crear se vuelve a ofrecer la
   * proxima vez. Lo que NO se hace es callarselo.
   */
  private declararCuenta(f: FormularioCajaUI): void {
    this.svc.declararRegla({
      beneficiario: f.beneficiario, kepler_cuenta: f.kepler_cuenta ?? '',
      kepler_concepto: f.kepler_concepto ?? '', sucursal: f.sucursal,
    }).subscribe({
      next: (r) => {
        this.avisarOk(
          r.creada ? 'Cuenta declarada' : 'Ya estaba declarada',
          f.beneficiario + ' → ' + f.kepler_cuenta + ' / ' + f.kepler_concepto,
        );
        // La bandeja cambia: lo que estaba trabado por este beneficiario ya se puede confirmar.
        this.cargarPendientes();
      },
      error: (e) => this.avisarError(e, 'El movimiento se guardo, pero la cuenta no se declaro'),
    });
  }

}
