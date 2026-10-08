import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { CheckboxModule } from 'primeng/checkbox';
import { ChipModule } from 'primeng/chip';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { MessageModule } from 'primeng/message';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CAJA_VENTANA_DIAS, CAJA_JORNADA_DIAS, evaluarCambio, type Denominacion } from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
// `[CG.45]` Tres piezas del repertorio compartido que esta pantalla se había construido a mano
// (o no tenía). De 13 componentes compartidos usaba 2; el resto del módulo finanzas ya los usa.
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent } from '../../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { todayMx, toMxDateKey, parseLocalDate } from '../../../../core/utils/mx-date';
import { CashLedgerService, type ConceptoKepler, type MovimientoCaja, type AutofillResponse, type TipoMovimiento, type SaldoResponse, type CorteCaja, type TotalesCorte, type MovimientoPendiente, type CajaKepler, type ResumenLote, type Frecuente, type CoberturaResponse, type CaosCapturable, type CaosCandidato, type ArqueoDia, type RecurrentesResponse,
  type RecurrenteSinRegla } from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import { CajaBorradorService } from './caja-borrador.service';
import { CajaSocketService } from '../../caja-socket.service';
import { imprimirComprobante as imprimirTicketComprobante, imprimirReporteDia as imprimirTicketReporte, type ComprobanteCaja, type ReporteDia } from './ticket-comprobante';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import {
  BILLETES_CAJA, MONEDAS_CAJA, motivosDeBloqueo, TEXTO_BLOQUEO, etiquetaProcedencia, etiquetaManual,
  textoCobertura, sumaDesglose, redondea, puedeAutorizarUI, puedeCerrarUI, textoSaldo, GLOSA_MIN, ARQUEO_EPSILON,
  type DenominacionCapturada, type MotivoBloqueo, type CorteVista,
} from './caja-captura.util';

/** Etiquetas de lo que se PINTA. El enum de la columna (`deposito`, `sin_contar`) es de la DB. */
const ETIQUETA_TIPO: Record<string, string> = {
  ingreso: 'Ingreso', gasto: 'Gasto', deposito: 'Depósito',
};
const ETIQUETA_ESTADO_CORTE: Record<string, string> = {
  borrador: 'Abierto', cerrado: 'Cerrado', autorizado: 'Autorizado',
};
const ETIQUETA_VEREDICTO: Record<string, string> = {
  cuadra: 'Cuadra', sobra: 'Sobra efectivo', falta: 'Falta efectivo', sin_contar: 'Sin contar',
  // `[CG.42]` NO dice "no cuadra": dice que la pregunta no tiene respuesta. Sin esta entrada el
  // tag imprimía la clave cruda `sin_base`, porque el mapa cae a `?? v`.
  sin_base: 'Sin fondo medido',
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
    FormsModule, ButtonModule, InputTextModule, InputNumberModule, TableModule, CheckboxModule,
    ChipModule, DatePickerModule, SelectModule, TagModule, DialogModule, AutoCompleteModule,
    MessageModule, ToastModule,
    MetricStripComponent, LoadStateComponent,
    FreshnessPillComponent, SegmentedComponent, ContextHelpComponent,
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

    .fin-filters { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin:var(--sp-4) 0 var(--sp-3); }
    .fin-filters input, .fin-filters p-select { min-width:11rem; }

    .fin-h2 { font-size:var(--fs-h3); font-weight:700; margin:var(--sp-6) 0 var(--sp-2); }
    .fin-dim { color:var(--text-muted); font-size:var(--fs-xs); }
    .fin-empty { text-align:center; color:var(--text-muted); padding:var(--sp-5) 0; }
    /* ⚠️ Acá decía "var(--danger-fg, #b42318)" y --danger-fg NO EXISTE en tokens.css: ganaba
       siempre el hex de fallback, que es un rojo de tema claro. O sea que en modo oscuro un
       faltante de caja se pintaba ilegible. El token de la casa es --bad-fg y sí flipea. */
    .fin-neg { color:var(--bad-fg); }
    .d-block { display:block; }

    /* Formulario de captura. fin-row-col apila cuando el campo necesita su propia explicación
       debajo (el selector de cobro de Kepler), en vez de meterla en la misma línea. */
    .fin-form { display:flex; flex-direction:column; gap:var(--sp-3); }
    /* CS.3.7 — Dos columnas para que la captura entre en una pantalla sin scroll. Apila en angosto. */
    .cg-grid { display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-3) var(--sp-6); align-items:start; }
    /* ⛔ [CG.57] CADA COLUMNA ES SU PROPIO CONTENEDOR DE CONSULTA, y sin esto el diseño se rompe.
       La reja del arqueo pregunta "@container (max-width:26rem)" para apilarse, pero el único
       container-type estaba en .cg-detail-cuerpo: la consulta medía los 646px del PANEL en vez de
       los ~311px de la COLUMNA donde la reja vive de verdad. Nunca disparaba, así que la reja
       quedaba en dos columnas dentro de una de 311px -- cada sub-tabla a ~150px, con scroll
       horizontal y la columna "Importe" cortada. Reportado por Edgar con captura.
       Con esto se corrige sola en los dos sentidos: panel lado a lado -> la columna mide 19rem y
       la reja se apila (y no hace falta que no se apile, porque el panel YA son dos columnas);
       panel apilado -> la columna mide 40rem y la reja se abre en dos, que es donde la altura
       importaba. */
    .cg-grid > .cg-col { display:flex; flex-direction:column; gap:var(--sp-3); min-width:0;
                         container-type:inline-size; }
    /* ⛔ [CG.46] Acá había un "@media (max-width:47.5rem)". Con el formulario dentro del panel de
       detalle eso es el antipatrón que DESIGN.md §R nombra: el ancho que decide el layout de este
       bloque es el del PANEL (32rem), no el de la ventana. En un monitor ancho el media query
       jamás se dispara y las dos columnas se desbordarían del panel. @container mira al
       contenedor, que es lo correcto — y sigue siendo mejora progresiva: sin soporte queda en una
       columna, que es el caso que de todos modos aplica a 32rem. */
    /* [CG.52] El umbral baja de 46rem a 39rem, MEDIDO y no a ojo: con el panel ensanchado a 42rem
       el contenedor de consulta (.cg-detail-cuerpo) mide 672 - 2 de borde - 24 de padding = 646px
       = 40.4rem. Con 46 no entraba por 90px y el formulario se apilaba igual. Cada columna queda
       en ~311px, que es lo que necesitan una etiqueta de 6.5rem y su control. */
    @container (max-width:39rem) { .cg-grid { grid-template-columns:1fr; } }
    @supports not (container-type: inline-size) { .cg-grid { grid-template-columns:1fr; } }
    /* [CG.49] Apilado manda el orden del DOM, y ahi el arqueo va primero porque es la tarea. Estas
       dos reglas fijan la posicion para el caso ancho, para que el diseno de CS.3.7 -- QUE a la
       izquierda, CUANTO a la derecha -- no dependa de en que orden esten escritas las columnas.
       ⚠️ Esto decia "lo que pasa SIEMPRE dentro del aside de 32rem", y desde [CG.52] ya no es
       siempre: capturando el panel mide 42rem y las dos columnas SI entran. */
    /* ⚠️ [CG.52] Este umbral es el COMPLEMENTO EXACTO del de arriba, y tiene que seguir siéndolo:
       si el colapso cae en 39rem y la posición se fija recién en 46, entre medio hay dos columnas
       SIN posición asignada — gana el orden del DOM y el CUÁNTO se va a la izquierda. Dos columnas
       invertidas y en silencio. Por eso van pegados, no sueltos. */
    @container (min-width:39.01rem) {
      .cg-grid > .cg-col-que    { grid-column:1; grid-row:1; }
      .cg-grid > .cg-col-cuanto { grid-column:2; grid-row:1; }
    }

    /* Angosto: se apila. El detalle VACÍO se esconde acá —y sólo acá—: con la pantalla apilada,
       una caja que dice "nada elegido" empuja la bandeja fuera de la vista. Con algo elegido sí
       se pinta, debajo de la lista, y su botón de cerrar hace de "volver". */
    @media (max-width:64rem) {
      .cg-split { grid-template-columns:1fr; }
      .cg-detail { position:static; max-height:none; }
      .cg-detail-vacio { display:none; }
    }
    .fin-row { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); }
    .fin-row > label { min-width:6.5rem; font-size:var(--fs-sm); color:var(--text-muted); }
    .fin-row-col { flex-direction:column; align-items:stretch; gap:var(--sp-1); }
    .fin-row-col > label { min-width:0; }
    .w-full { width:100%; }

    .fin-hint-ok   { color:var(--ok-fg); font-size:var(--fs-xs); }
    .fin-hint-warn { color:var(--warn-fg); font-size:var(--fs-xs); }

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
    /* [CG.52] EL ANCHO SIGUE A LA TAREA.
       Mientras se recorre la bandeja, el panel es angosto y la lista manda. Al capturar se invierte:
       el panel se ensancha hasta que sus DOS columnas caben, y el movimiento entra entero sin
       scroll. Antes era 32rem fijo -- o sea un contenedor de ~486px contra un umbral de 736px: la
       condicion para mostrar dos columnas era INALCANZABLE, y por eso el formulario se apilaba y
       pedia scroll. Reordenarlo ([CG.49]) puso el arqueo arriba pero no devolvio el ancho. */
    .cg-split { display:grid; grid-template-columns:minmax(0,1fr) 24rem; gap:var(--sp-6);
                align-items:start; }
    /* El ensanche pide pantalla: por debajo de esto, robarle 42rem a la bandeja la deja en ~300px
       y se rompe lo que se venia a arreglar. Va en @media y no en @container porque es cromo de
       pagina, no del componente (DESIGN R). */
    @media (min-width:74rem) {
      .cg-split-capturando { grid-template-columns:minmax(0,1fr) 42rem; }
    }
    .cg-main { min-width:0; }
    /* Pegado: la bandeja es larga y el detalle tiene que seguir ahi mientras se recorre. La caja
       lleva borde 1px y NINGUNA sombra -- in-page es una de las dos, nunca las dos. */
    .cg-detail { position:sticky; top:var(--sp-4); max-height:calc(100vh - var(--sp-12));
                 display:flex; flex-direction:column; overflow:hidden;
                 border:1px solid var(--border-color); border-radius:var(--r-md); }
    .cg-detail-head { display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-3);
                      border-bottom:1px solid var(--border-color); }
    .cg-detail-h { font-size:var(--fs-h3); font-weight:700; }
    /* [CG.49] El titulo y el documento anclado, en dos renglones de una sola fila. */
    .cg-detail-titulo { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .cg-detail-sub { font-size:var(--fs-xs); color:var(--text-muted);
                     overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* El contenedor de consulta vive ACA y no en el aside, para no mezclar la contencion con el
       position:sticky de arriba. */
    .cg-detail-cuerpo { flex:1 1 auto; overflow:auto; padding:var(--sp-3);
                        container-type:inline-size; }
    .cg-detail-pie { display:flex; justify-content:flex-end; gap:var(--sp-2); padding:var(--sp-3);
                     border-top:1px solid var(--border-color); }
    .cg-detail-nada { display:flex; flex-direction:column; align-items:flex-start; gap:var(--sp-2);
                      padding:var(--sp-6) var(--sp-4); color:var(--text-muted);
                      font-size:var(--fs-sm); }
    /* Vacio operacional: NO centrado -- DESIGN lista "centered everything en empties" como
       antipatron de Operations. */
    .cg-detail-nada i { font-size:var(--fs-h2); color:var(--text-faint); }
    .cg-detail-nada strong { color:var(--fg-1); font-size:var(--fs-body); }
    .cg-detail-nada p { margin:0; }

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
    /* ⛔ [CG.48] Acá vivía ".cg-contado", el input de conteo por renglón de la bandeja. Se fue
       con su columna: era la única forma de meter una cifra contada al libro SIN desglose. */
    .cg-rezago { margin:var(--sp-2) 0 0; font-size:var(--fs-xs); }
    /* [CG.56] La columna de la MARCA. Ya no hay casilla: la fila es el control y esta celda sólo
       publica el estado. Angosta a proposito -- es una senial, no un boton. */
    .cg-th-marca, .cg-td-marca { width:2.25rem; text-align:center; padding-left:var(--sp-2); }
    .cg-td-marca > i { font-size:var(--fs-xs); color:var(--action); }
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

    /* [CG.53] La reja en dos columnas y el numero grande. Una caja con borde y SIN sombra -- in-page
       es una de las dos, nunca las dos. */
    .cg-reja2 { display:grid; grid-template-columns:minmax(0,1fr) 1px minmax(0,1fr);
                border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; }
    .cg-reja-sep { background:var(--border-color); }
    .cg-reja-col { min-width:0; padding:var(--sp-1) var(--sp-2) var(--sp-2); }
    .cg-reja-mor { grid-column:1 / -1; border-top:1px solid var(--border-color);
                   display:flex; align-items:center; gap:var(--sp-2);
                   padding:var(--sp-2) var(--sp-3); font-size:var(--fs-sm); }
    /* ⛔ Con el panel angosto las dos columnas se desbordarian: se apilan, igual que el formulario.
       Mismo umbral complementario que .cg-grid, por la misma razon. */
    @container (max-width:26rem) {
      .cg-reja2 { grid-template-columns:1fr; }
      .cg-reja-sep { display:none; }
    }

    /* EL numero de la pantalla. --fs-display es "headline metric, UNA por vista" y esta pantalla
       no lo usaba en ningun lado: lo contado es exactamente la cifra que lo merece. */
    .cg-total-bloque { display:flex; align-items:center; gap:var(--sp-3); margin-top:var(--sp-2);
                       padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color);
                       border-radius:var(--r-md); }
    .cg-total-bloque.es-ok   { background:var(--ok-soft-bg);   border-color:var(--ok-border); }
    .cg-total-bloque.es-warn { background:var(--warn-soft-bg); border-color:var(--warn-border); }
    .cg-lbl-micro { font-size:var(--fs-nano); font-weight:500; color:var(--text-muted);
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
    .cg-app { height:100vh; overflow:hidden; display:flex; flex-direction:column;
              padding-top:0; padding-bottom:0; }
    .cg-app > .cg-split { flex:1 1 auto; min-height:0; }
    .cg-bar { display:flex; align-items:center; gap:var(--sp-3); flex:none;
              padding:var(--sp-2) 0; border-bottom:1px solid var(--border-color); }
    .cg-bar-id > h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.02em; }
    /* El desplegable: un <button> con su aria-expanded, no un div con (click). */
    .cg-jornada-btn { display:inline-flex; align-items:center; gap:var(--sp-2); cursor:pointer;
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
    .cg-jornada { flex:none; max-height:52vh; overflow:auto; padding:var(--sp-3) 0; }

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
    .cg-cajero { border:1px dashed var(--border-color); border-radius:var(--r-md,8px); padding:var(--sp-3); }
    .cg-cajero-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); }
    .cg-cajero-head label { margin:0; }
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
    /* [CG.26] .ta-r se usaba 12 veces en esta plantilla y NO ESTABA DEFINIDA en ningun lado
       alcanzable: el bloque local define .ta-c, FINANZAS_SHARED_STYLES la excluye a proposito, y
       en styles.css solo existe ".ta-r > .surf-sort". O sea que los importes de la bandeja y del
       libro nunca estuvieron alineados a la derecha. Otras ~10 pantallas la definen local. */
    .ta-r { text-align:right; }
    /* ⛔ ".cg-print" retirada: era un <button> con la impresora adentro, con su borde, su hover
       y su anillo a mano. Hoy es un p-button redondo de icono. */
    /* CS.3.11 — panel de conciliación caja chica vs cajero (CAOS). */
    .cg-conc { border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:var(--sp-3);
      display:flex; flex-direction:column; gap:var(--sp-1); max-width:34rem; }
    .cg-conc-h { font-size:var(--fs-sm); }
    .cg-conc-row { display:flex; justify-content:space-between; gap:var(--sp-4); font-size:var(--fs-sm); }
    .cg-conc-row .mono { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cg-conc-tot { border-top:1px solid var(--border-color); padding-top:var(--sp-1); font-weight:600; }
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
    @media (max-width:47.5rem) { .cg-conc-cols { grid-template-columns:1fr; } }
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
      <header class="cg-bar">
        <div class="cg-bar-id">
          <h1>Caja General</h1>
        </div>

        <span class="cg-bandeja-sp"></span>

        <button type="button" class="cg-jornada-btn" (click)="jornadaAbierta.set(!jornadaAbierta())"
                [attr.aria-expanded]="jornadaAbierta()">
          <i class="pi" [class.pi-chevron-down]="!jornadaAbierta()"
             [class.pi-chevron-up]="jornadaAbierta()" aria-hidden="true"></i>
          <strong>Tu jornada</strong>
          <span class="cg-jornada-sep" aria-hidden="true"></span>
          <span class="cg-jornada-res">{{ subtituloJornada() }}</span>
        </button>

        <p-button label="Registrar movimiento" icon="pi pi-plus" size="small"
                  (onClick)="abrirCaptura()" [disabled]="!hayConceptos() && !coberturaSinMedir()"></p-button>
      </header>

      <!-- El 10%: lo que NO es la tarea. Arranca cerrado y scrollea solo. -->
      @if (jornadaAbierta()) {
        <div class="cg-jornada">
          <p class="fin-dim cg-sub-dim">{{ coberturaTexto() }}</p>

      <!-- ⚠️ Antes esto decía "No hay conceptos" también cuando la medición había FALLADO, y el
           subtítulo de arriba decía "sin medir" al mismo tiempo. Dos frases contradictorias sobre
           el mismo hecho. Ahora cada ausencia dice la suya. -->
      @if (coberturaSinMedir()) {
        <p-message severity="warn" class="cg-full">No se pudo medir la cobertura del catálogo de conceptos. No es "no hay conceptos": es que no sabemos. Se puede capturar, pero si la cuenta no existe el servidor la va a rechazar.</p-message>
      } @else if (!hayConceptos()) {
        <p-message severity="warn" class="cg-full">No hay conceptos de Kepler disponibles. No se puede capturar sin cuenta contable — revisá el carril del ODS antes de seguir.</p-message>
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
          @if (saldoSinMedir()) {
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
          @if (saldoSinMedir()) {
            <p-button label="Reintentar" icon="pi pi-refresh" size="small" severity="secondary"
                      [text]="true" (onClick)="cargarSaldo()"></p-button>
          } @else {
            <p-button [label]="corteAbierto() ? 'Rendir cuentas del dia' : 'Cerrar jornada y rendir cuentas'"
                      icon="pi pi-lock" size="small" [disabled]="abriendo()"
                      (onClick)="cerrarJornada()"></p-button>
          }
        </div>

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

          <div class="cg-conc-cols" [hidden]="!verDetalleCierre()">

            <!-- IZQUIERDA: nuestro libro -->
            <div class="cg-conc-col">
              <strong class="cg-conc-sub">Caja general <small class="fin-dim">(nuestro libro)</small></strong>
              <div class="cg-conc-row"><span>Ingresos</span>
                <span class="mono">+ {{ money(a.caja_general.ingresos) }}</span></div>
              <div class="cg-conc-row"><span>Gastos</span>
                <span class="mono">&minus; {{ money(a.caja_general.gastos) }}</span></div>
              <div class="cg-conc-row"><span>Depositos al banco</span>
                <span class="mono">&minus; {{ money(a.caja_general.depositos) }}</span></div>
              <div class="cg-conc-row cg-conc-tot"><span>Movimiento del dia</span>
                <span class="mono">{{ money(a.caja_general.neto) }}</span></div>
              <small class="fin-dim">
                {{ a.caja_general.movimientos }} movimiento(s) registrado(s){{ a.caja_general.cancelados ? ', ' + a.caja_general.cancelados + ' cancelado(s)' : '' }}.
              </small>

              <!-- ⛔ CG.19 sigue intacto: el ESPERADO no se compone aca. La suma
                   "fondo + ingresos - egresos - depositos" ES el esperado, y publicarla mientras
                   alguien cuenta a ciegas seria devolverle por la ventana lo que se le oculta.
                   Lo unico que se dice es SI hay corte, que no es secreto. -->
              @if (a.corte_abierto; as c) {
                <small class="fin-hint-ok d-block">Corte {{ c.folio }} abierto: el esperado se revela al sellar el conteo.</small>
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
                    <tr><th scope="col">Tipo</th><th scope="col" class="ta-r">Movs</th><th scope="col" class="ta-r">Monto</th></tr>
                  </ng-template>
                  <ng-template #body let-t>
                    <tr [class.cg-trabada]="t.desconocido">
                      <td>
                        {{ t.etiqueta }}
                        @if (t.desconocido) {
                          <small class="fin-hint-warn d-block">Tipo que no conocemos: NO se sumo a ninguna pierna.</small>
                        }
                      </td>
                      <td class="ta-r mono">{{ t.movimientos }}</td>
                      <td class="ta-r mono">{{ money(t.monto) }}</td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage>
                    <tr><td colspan="3"><small class="fin-dim">El cajero no se movio en esta jornada.</small></td></tr>
                  </ng-template>
                </p-table>
                <div class="cg-conc-row"><span>Entra <small class="fin-dim">(deposito + dotar)</small></span>
                  <span class="mono">+ {{ money(cj.entra) }}</span></div>
                <div class="cg-conc-row"><span>Sale <small class="fin-dim">(dispensar + vaciar)</small></span>
                  <span class="mono">&minus; {{ money(cj.sale) }}</span></div>
                <!-- ⛔ "Movimiento del dia", NUNCA "saldo": CAOS no publica su contenido y el
                     acumulado del flujo da negativo porque el efectivo anterior al feed no se sabe. -->
                <div class="cg-conc-row cg-conc-tot"><span>Movimiento del dia</span>
                  <span class="mono">{{ money(cj.neto) }}</span></div>
                <small class="fin-dim">
                  {{ cj.movimientos }} movimiento(s) del cajero en la jornada.
                </small>
              } @else {
                <small class="fin-dim">Sin cajero que cuadrar en esta sucursal. El motivo esta abajo.</small>
              }
            </div>
          </div>

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
            <p-button [label]="(limitesAbiertos() ? 'Ocultar' : 'Que NO cubre este cuadre') + ' (' + a.limites!.length + ')'"
                      [icon]="limitesAbiertos() ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                      size="small" severity="secondary" [text]="true"
                      (onClick)="limitesAbiertos.set(!limitesAbiertos())"></p-button>
            @if (limitesAbiertos()) {
              <ul class="cg-conc-lim">
                @for (m of a.limites!; track m) { <li>{{ m }}</li> }
              </ul>
            }
          }
        } @else {
          <!-- Tercer estado. "Sin medir" no es "el dia estuvo en cero". -->
          <small class="fin-hint-warn">No se pudo medir la jornada. No es que no haya movimiento: es que no se pudo leer.</small>
        }
      </div>
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
                <span class="fin-dim">{{ g.fecha_valor }}</span>
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
                <th scope="col" class="ta-r">Pagos</th>
                <th scope="col" class="ta-r">Monto</th>
                <th scope="col">Importe</th>
                <th scope="col">Cuenta</th>
                <th scope="col" class="ta-r">Sin cobrar</th>
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
                  <td class="ta-r mono">{{ r.pagos }}</td>
                  <td class="ta-r mono">{{ money(r.monto) }}</td>
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
                  <td class="ta-r mono">
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

      <section class="cg-historial">
        <button type="button" class="cg-historial-h" (click)="historialAbierto.set(!historialAbierto())"
                [attr.aria-expanded]="historialAbierto()">
          <i class="pi" [class.pi-chevron-right]="!historialAbierto()"
             [class.pi-chevron-down]="historialAbierto()" aria-hidden="true"></i>
          <span class="cg-historial-t">Historial</span>
          <small class="fin-dim">
            del {{ dmy(from) }} al {{ dmy(to) }} ·
            {{ rows().length }} movimiento(s) en el libro · {{ cortes().length }} corte(s)
          </small>
        </button>

        @if (historialAbierto()) {
      <!-- ⚠️ [CG.29] Esta tira es del LIBRO (el rango de acá abajo), no del día. Sin rótulo, su
           "Gastos $130,000.00" quedaba pegado al "Gastos $0.00" del cierre de la jornada: dos
           números con la misma etiqueta, distinto periodo y un centímetro de distancia.
           [CG.37] Y ahora vive donde está lo que resume, no 340 líneas más arriba. -->
      <h2 class="fin-h2 cg-kpi-h">El libro, del {{ dmy(from) }} al {{ dmy(to) }}</h2>
      <app-metric-strip [items]="kpis()"></app-metric-strip>

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
        <!-- CS.3.10 — Reporte diario en la térmica: los movimientos del rango/filtros + totales. -->
        <p-button label="Reporte del día" icon="pi pi-print" severity="secondary" size="small"
                  [loading]="imprimiendoReporte()" (onClick)="imprimirReporteDia()"></p-button>
      </div>

      <!-- size="small" SÍ es un input de p-table en v22; styleClass="p-datatable-sm" NO lo es y
           era redundante además de muerto. El estado lo lleva app-load-state, que distingue el
           500 del periodo vacío — en una pantalla de dinero eso no puede verse igual. -->
      <app-load-state [loading]="cargando()" [error]="errLibro()" [isEmpty]="!rows().length"
                      errorTitle="No se pudo leer el libro de caja"
                      emptyIcon="pi-book" emptyTitle="Sin movimientos en el periodo"
                      emptyHint="Probá con otro rango de fechas o quitá el filtro de tipo."
                      (retry)="cargar()">
      <p-table [value]="rows()" size="small" dataKey="id" selectionMode="single" [(selection)]="filaLibro"
               [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <!-- scope="col" como en las otras tres tablas de la pantalla: sin el, un lector de
                 pantalla no liga la celda con su encabezado y lee nueve valores sueltos. -->
            <th scope="col">Folio</th><th scope="col">Fecha</th><th scope="col">Tipo</th><th scope="col">Cuenta / Concepto</th>
            <th scope="col">Qué pasó</th><th scope="col" class="ta-r">Monto</th><th scope="col">Capturó</th><th scope="col">Origen</th>
            <th scope="col" class="ta-c">Comprobante</th>
          </tr>
        </ng-template>
        <ng-template #body let-m>
          <tr [pSelectableRow]="m">
            <td class="mono">{{ m.folio }}</td>
            <td>{{ dmy(m.fecha) }}</td>
            <td><p-tag [value]="etiquetaTipo(m.tipo)" [severity]="sevTipo(m.tipo)"></p-tag></td>
            <td>
              <span class="mono">{{ m.kepler_cuenta }} / {{ m.kepler_concepto }}</span>
              <small class="fin-dim d-block">{{ m.kepler_concepto_nombre }}</small>
            </td>
            <td>{{ m.glosa }}</td>
            <td class="ta-r mono">{{ money(m.monto) }}</td>
            <td>{{ m.created_by_username || '—' }}</td>
            <td>
              @if (m.autofill) {
                <span title="Parte de este movimiento la propuso el sistema">
                  <p-tag value="autorrellenado" severity="info"></p-tag>
                </span>
              } @else { <small class="fin-dim">manual</small> }
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
        <ng-template #emptymessage>
          <tr><td colspan="9" class="fin-empty">Sin movimientos en el periodo.</td></tr>
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
            <th scope="col" class="ta-r">Esperado</th><th scope="col" class="ta-r">Contado</th><th scope="col" class="ta-r">Diferencia</th>
            <th scope="col">Cerró / Autorizó</th><th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-c>
          <tr [pSelectableRow]="c">
            <td class="mono">{{ c.folio }}</td>
            <td>{{ dmy(c.fecha) }}</td>
            <td>{{ c.sucursal }}</td>
            <td><p-tag [value]="etiquetaEstadoCorte(c.estado)" [severity]="sevEstadoCorte(c.estado)"></p-tag></td>
            <td class="ta-r mono">{{ c.esperado === null ? '—' : money(c.esperado) }}</td>
            <td class="ta-r mono">{{ c.contado === null ? '—' : money(c.contado) }}</td>
            <td class="ta-r mono" [class.fin-neg]="c.diferencia < 0">
              {{ c.diferencia === null ? '—' : money(c.diferencia) }}
            </td>
            <td>
              <small class="fin-dim">{{ c.closed_by_username || '—' }} / {{ c.authorized_by_username || '—' }}</small>
            </td>
            <td>
              @if (c.estado === 'cerrado') {
                @if (gateAutorizar(c).ok) {
                  <p-button label="Autorizar" size="small" severity="secondary"
                            [disabled]="autorizando()" (onClick)="autorizar(c)"></p-button>
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
        </div>
      }


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
      <div class="cg-split" [class.cg-split-capturando]="capturaAbierta()">
        <div class="cg-main">
      <section class="cg-bandeja">
        <header class="cg-bandeja-head">
          <h2 class="fin-h2">Movimientos por confirmar</h2>
          <!-- ⛔ [CG.45] Acá iba UNA frase gris con CINCO hechos pegados con puntos medios:
               "N de las M que se ven se confirman sin elegir nada · el resto necesita que su
               cuenta esté declarada · últimos 45 días · hace 3 min". Cinco cosas de distinto
               tipo, todas al mismo peso y al mismo color, o sea cero jerarquía (Q.5).
               Ahora: la cifra accionable primero y con peso, el resto subordinado, y la EDAD
               del dato en su píldora -- que es la que se pone ámbar sola. Como prosa gris,
               "hace 3 min" y "hace 9 horas" se veían idénticos. -->
          <span class="cg-lead">{{ confirmables() }} <span class="cg-lead-sub">de {{ pendientes().length }} se confirman de un clic</span></span>
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
          <p-select [options]="opcionesVentana" [ngModel]="ventanaDias()" optionLabel="label" optionValue="value"
                    (ngModelChange)="setVentana($event)" class="cg-sel" [ariaLabel]="'Desde cuándo'"></p-select>
          <!-- Tres valores excluyentes = control segmentado, no un desplegable: se ve el estado
               actual y las dos alternativas sin abrir nada. Es el patrón canónico del repertorio. -->
          <app-segmented [options]="opcionesSigno" [value]="signoBandeja()"
                         (valueChange)="setSigno($any($event))" ariaLabel="Signo" />
          <p-select [options]="opcionesCaja()" [ngModel]="cajaActiva()" optionLabel="label" optionValue="value"
                    (ngModelChange)="setCaja($event)" class="cg-sel" [ariaLabel]="'Caja'"></p-select>
          <!-- CS.3.9 — El buscador universal es de «por confirmar»: acá se busca el movimiento que se
               va a capturar (folio de Kepler, concepto, beneficiario, doc). El libro tiene el suyo. -->
          <input pInputText [(ngModel)]="searchPend" (keyup.enter)="cargarPendientes()" class="cg-sel cg-buscar"
                 placeholder="Buscar: folio Kepler, concepto, beneficiario…" aria-label="Buscar en por confirmar" />
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
          <p-button [label]="marcadas().length ? 'Confirmar ' + marcadas().length : 'Confirmar'"
                    icon="pi pi-check" size="small"
                    [severity]="marcadas().length ? undefined : 'secondary'"
                    [disabled]="!marcadas().length || confirmando()" (onClick)="confirmarLote()"></p-button>
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
                   selectionMode="multiple" [metaKeySelection]="false"
                   [selection]="filasMarcadas()" (selectionChange)="onSeleccionTabla($event)">
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
                <th scope="col">Contraparte</th><th scope="col">Documento</th><th scope="col">Cuenta</th>
                <!-- [CG.48] Acá había una columna "Contado" por renglón, y se retiró: era una
                     TERCERA forma de contar el mismo dinero, y la única sin desglose. El conteo
                     va al arqueo -- de un movimiento en «Capturar», de todo el día en el corte. -->
                <th scope="col" class="ta-r">Importe (ERP)</th>
                <th scope="col"><span class="sr-only">Capturar a mano</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-p>
                <tr [class.cg-trabada]="!p.confirmable" [pSelectableRow]="p"
                    [class.cg-fila-marcada]="estaMarcada(p.origen_ref)">
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
                      <small class="fin-hint-warn d-block">fecha posterior a hoy — revisá el documento</small>
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
                    {{ p.beneficiario || p.entidad_code || '—' }}
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
                  </td>
                  <td class="mono">{{ p.doc_tipo }} {{ p.folio }}</td>
                  <td class="mono">{{ p.kepler_cuenta || '—' }}</td>
                  <td class="ta-r mono">{{ money(p.monto) }}</td>
                  <td>
                    <!-- La salida de una fila trabada, y desde [CG.48] tambien la de una fila
                         que se conto DISTINTO: el lote espeja al ERP y no admite un importe
                         propio, asi que contar distinto es abrir el documento y desglosarlo.
                         Abre el dialogo ANCLADO a este documento de Kepler. -->
                    <p-button [label]="p.confirmable ? 'Abrir' : 'Capturar'" size="small"
                              severity="secondary" [text]="true"
                              [title]="'Capturar a mano ' + p.doc_tipo + ' ' + p.folio"
                              (onClick)="capturarDesde(p)"></p-button>
                  </td>
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
              de esta ventana. Acotá por signo o por caja, o achicá la ventana, para verlas todas.
            </p>
          }
        </app-load-state>

        <!-- Lo que la ventana deja fuera se DICE. Una bandeja acotada que no publica su corte
             se lee igual que una bandeja vacia, y aca el rezago es de 12 mil movimientos.
             Va FUERA del load-state a propósito: con la bandeja vacía es cuando más hay que
             poder leer que el trabajo está del otro lado del corte. -->
        @if (rezago(); as rz) {
          <p class="fin-dim cg-rezago">
            Quedan <strong>{{ rz.movimientos }}</strong> movimientos anteriores a esta ventana,
            por {{ money(rz.monto) }}. No son trabajo del día: son lo que el sistema anterior ya
            registró, y hasta dónde se traen es una decisión aparte.
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
        </div><!-- /cg-main -->

        <!-- El detalle. PERMANENTE: cuando no hay nada elegido NO desaparece -- dice que
             esta esperando y ofrece la captura desde cero. Un panel que aparece y se va
             mueve la lista debajo del cursor justo cuando se esta marcando. -->
        <aside class="cg-detail" [class.cg-detail-vacio]="!capturaAbierta()"
               aria-label="Detalle del movimiento">
          @if (capturaAbierta()) {
            <!-- [CG.49] El documento anclado sube AL ENCABEZADO. Con el arqueo arriba, lo primero
                 que se ve son las denominaciones, y contar sin saber contra que documento es contar
                 a ciegas del lado equivocado: el detalle del movimiento quedo debajo de la reja. Es
                 una linea, no una ficha -- la ficha completa sigue abajo, en su columna. -->
            <div class="cg-detail-head">
              <div class="cg-detail-titulo">
                <strong class="cg-detail-h">Registrar movimiento de caja</strong>
                @if (cobroElegido(); as c) {
                  <small class="cg-detail-sub mono">{{ c.doc_tipo }} {{ c.folio }} · {{ money(c.monto) }}</small>
                }
              </div>
              <span class="cg-bandeja-sp"></span>
              <p-button icon="pi pi-times" size="small" severity="secondary" [text]="true" [rounded]="true"
                        ariaLabel="Cerrar la captura y volver a la lista"
                        (onClick)="cerrarConFoco(capturaAbierta)"></p-button>
            </div>
            <div class="cg-detail-cuerpo">
            <div class="fin-form">

              <!-- CS.3.7 — Dos columnas para que TODO entre en una pantalla sin scroll. Izquierda: el
                   QUÉ/QUIÉN (documento, beneficiario, cuenta, glosa). Derecha: el CUÁNTO (cajero + arqueo). -->
              <div class="cg-grid">
              <!-- [CG.49] EL ARQUEO VA PRIMERO, y es un cambio de ORDEN, no de contenido.

                   Reportado por Edgar sobre la pantalla en vivo: "tengo que hacer scroll para ver
                   todo el contenido, al menos el importante que es el arqueo".

                   La causa NO era falta de diseno: estas dos columnas existen justamente "para que
                   TODO entre en una pantalla sin scroll". Lo que paso es que [CG.46] mudo la captura
                   de un p-dialog ancho a este aside. Lo arreglo [CG.52] ensanchando el panel a 42rem al capturar; antes media 32rem fijo y .cg-grid
                   colapsa a una columna por debajo de 46rem. O sea que la condicion para mostrar dos
                   columnas NO SE PUEDE CUMPLIR aca, y al apilarse el arqueo quedaba detras de todo el
                   contexto: la tarea, al final. Fue una regresion de [CG.46] que ningun gate ve.

                   Apilado manda el orden del DOM, asi que el CUANTO va primero. Las reglas de
                   @container (min-width:39.01rem) fijan la posicion de cada columna, para que si algun
                   dia esto vive en un contenedor ancho el QUE siga a la izquierda y el CUANTO a la
                   derecha: el diseno de CS.3.7 intacto, sin depender del orden del DOM. -->
              <div class="cg-col cg-col-cuanto"><!-- el CUANTO: cajero aparte + arqueo. Va PRIMERO porque es la tarea -->

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
              <!-- CS.3.4 — El detector: ¿este gasto salió del cajero (CAOS)? Propone los retiros por
                   patrones (mismo día + ref + monto + aprendido); al vincular uno, su efectivo se suma al
                   arqueo y el resto se cuenta a mano. NO aparece si la captura YA es un movimiento de CAOS. -->
              @if (!caosElegido()) {
                <div class="fin-row fin-row-col cg-cajero">
                  <div class="cg-cajero-head">
                    <label>Del cajero (CAOS)</label>
                    <!-- El "buscando…" deja de ser un rotulo que se cambia a mano: [loading] pone el
                         spinner Y desactiva el boton, que es lo que evita la segunda busqueda. -->
                    <p-button label="¿salió del cajero? buscar retiros" icon="pi pi-search" size="small"
                              severity="secondary" [text]="true" [loading]="buscandoCajero()"
                              (onClick)="buscarEnCajero()"></p-button>
                  </div>
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
                </div>
              }

              <!-- CS.3.7 — El efectivo del cajero (CAOS) se muestra APARTE, ya contado por la máquina. NO
                   entra en la reja de abajo: ésa queda para la DIFERENCIA (morralla, un faltante). Sólo se
                   muestra o se menciona; nunca se re-teclea. -->
              @if (hayCajero()) {
                <div class="cg-caja-aparte">
                  <div class="cg-caja-aparte-top">
                    <span class="cg-caja-ico mono" aria-hidden="true">⇄</span>
                    <strong>Del cajero (CAOS): {{ money(aporteCajero()) }}</strong>
                    <span class="fin-dim">ya contado por la máquina</span>
                  </div>
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
                  <div class="cg-caja-denoms fin-dim mono">
                    @for (d of denominacionesCajero(); track d.denom_key) {
                      <span>{{ d.piezas }}×{{ money(d.denominacion) }}</span>
                    }
                  </div>
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
                         [ngModel]="ventaCredito()" (ngModelChange)="setVentaCredito($event)"
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
                  <strong>{{ hayCajero() ? 'La diferencia, a mano' : 'Contá el efectivo' }}</strong>
                  <!-- ⛔ [CG.54] Acá decía "El documento dice $144.00". Lo dice el bloque del número,
                       tres renglones abajo y PEGADO a la cifra con la que se compara, que es donde
                       sirve. Repetirlo arriba no agrega el dato: agrega una segunda cifra en pantalla
                       que hay que verificar que sea la misma. -->
                  @if (hayCajero()) {
                    <span class="fin-dim">El cajero ya aportó {{ money(aporteCajero()) }} — contá acá sólo lo que falta o la morralla (arranca en cero).</span>
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
                            <input pInputText type="number" class="cg-pieza" min="0" step="1" inputmode="numeric"
                                   [ngModel]="piezasDe(b)" (ngModelChange)="setPiezas(b, $event)"
                                   (keydown.enter)="moverEnReja($event, 1)"
                                   (keydown.arrowdown)="moverEnReja($event, 1)"
                                   (keydown.arrowup)="moverEnReja($event, -1)"
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
                            <input pInputText type="number" class="cg-pieza" min="0" step="1" inputmode="numeric"
                                   [ngModel]="piezasDe(b)" (ngModelChange)="setPiezas(b, $event)"
                                   (keydown.enter)="moverEnReja($event, 1)"
                                   (keydown.arrowdown)="moverEnReja($event, 1)"
                                   (keydown.arrowup)="moverEnReja($event, -1)"
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
                           [ngModel]="f().morralla" (ngModelChange)="setMorralla($event)"
                           (keydown.enter)="moverEnReja($event, 1)"
                           (keydown.arrowdown)="moverEnReja($event, 1)"
                           (keydown.arrowup)="moverEnReja($event, -1)"
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
                            <input pInputText type="number" class="cg-pieza-dev" min="0" step="1" inputmode="numeric"
                                   [ngModel]="piezasDevueltasDe(b)" (ngModelChange)="setPiezasDevueltas(b, $event)"
                                   (keydown.enter)="moverEnRejaDev($event, 1)"
                                   (keydown.arrowdown)="moverEnRejaDev($event, 1)"
                                   (keydown.arrowup)="moverEnRejaDev($event, -1)"
                                   [attr.aria-label]="'Piezas devueltas de ' + b.label" />
                          </td>
                          <td class="mono cg-sub">{{ money(b.valor * piezasDevueltasDe(b)) }}</td>
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

              </div><!-- /cg-col del CUANTO -->
              <div class="cg-col cg-col-que"><!-- el QUE/QUIEN: tipo, fecha, sucursal, documento, beneficiario, cuenta, glosa -->
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

              <!-- ⭐ CG.19 Capa 1 — el movimiento se ELIGE, no se teclea. El monto viaja de Kepler.
                   ⛔ Acá decía "Sólo para ingresos: un gasto o un depósito no tienen un cobro del ERP
                   detrás", y CG.21 REFUTÓ eso con medición: el egreso de la caja cuadra al 100% contra
                   Kepler en 5 meses cerrados ($44,108,221.92 vs $44,123,427.09). El servicio ya pedía
                   los dos signos ("tipo: ... === 'gasto' ? 'gasto' : 'ingreso'") y la plantilla lo
                   escondía, así que para un GASTO no había forma de anclar al documento: había que
                   retipearlo entero a mano. El depósito sí queda fuera, y con motivo: es una salida a
                   banco, no un pago, y su pierna doble ("N-A-26") está declarada fuera de alcance. -->
              @if (f().tipo === 'ingreso' || f().tipo === 'gasto') {
                <div class="fin-row fin-row-col">
                  <label for="cg-cobro">{{ f().tipo === 'gasto' ? 'Comprobante contra un pago de Kepler' : 'Entrega contra un cobro de Kepler' }}</label>
                  <p-autocomplete inputId="cg-cobro" [(ngModel)]="cobroSel" [suggestions]="cobros()"
                                  (completeMethod)="buscarCobros($event)" (onSelect)="elegirCobro($event)"
                                  (onClear)="soltarCobro()" optionLabel="label" [delay]="250"
                                  [minQueryLength]="0" [showClear]="true" appendTo="body" class="cg-full"
                                  placeholder="Buscá por cliente, folio o ruta — o dejalo vacío y capturá a mano"></p-autocomplete>
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
                    <small class="fin-dim">Sin documento: captura manual (marcada así en la cobertura). Si ya está en Kepler, elegilo y el importe lo pone el documento.</small>
                  }
                </div>

                <!-- CS.3 — La segunda fuente: la caja fuerte (CAOS). Al elegir un movimiento, el arqueo de
                     abajo se PRECARGA con el conteo de la máquina; lo que falte se cuenta a mano. -->
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
                  }
                </div>
              }

              <!-- CG.20 - Lo que esta persona repite se ofrece, no se reescribe. Medido: 57% de los
                   gastos cae en un par (cuenta, concepto) ya usado 3+ veces, y Krmn tecleo 61 en una
                   hora. Un toque llena cuenta + concepto + beneficiario; solo queda el importe.
                   El gasto NO se deriva de Kepler, asi que esto baja clics pero no vuelve auditable
                   el dato -- y por eso el bloque lo dice. -->
              @if (f().tipo === 'gasto' && frecuentes().length) {
                <div class="fin-row fin-row-col">
                  <label>Lo que más repetís en la sucursal {{ f().sucursal }}</label>
                  <div class="cg-chips">
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
                  <small class="fin-dim">Llenan cuenta, concepto y beneficiario. El importe siempre se escribe.</small>
                </div>
              }

              <div class="fin-row">
                <label for="cg-benef">Beneficiario</label>
                <input pInputText id="cg-benef" [ngModel]="f().beneficiario" (ngModelChange)="setF('beneficiario', $event)"
                       (blur)="pedirPropuesta()" class="cg-full" [readonly]="!!cobroElegido()" />
              </div>

              <div class="fin-row fin-row-col">
                <label for="cg-concepto">Cuenta y concepto de Kepler</label>
                <p-autocomplete inputId="cg-concepto" [(ngModel)]="conceptoSel" [suggestions]="conceptos()"
                                (completeMethod)="buscarConceptos($event)" (onSelect)="elegirConcepto($event)"
                                optionLabel="label" [delay]="250" [minQueryLength]="cuentaFuenteDoc() ? 0 : 2"
                                [dropdown]="!!cuentaFuenteDoc()" [showClear]="true"
                                placeholder="Buscá por nombre, cuenta o código" appendTo="body"
                                class="cg-full"></p-autocomplete>
                <small [class]="etiquetaConcepto().tono === 'propuesto' ? 'fin-hint-ok' : 'fin-hint-warn'">
                  {{ etiquetaConcepto().texto }}
                </small>
                @if (cuentaFuenteDoc()) {
                  <p-button label="Corregir la cuenta" icon="pi pi-pencil" size="small"
                            severity="secondary" [text]="true" (onClick)="corregirCuentaDoc()"></p-button>
                }
              </div>

              <div class="fin-row">
                <label for="cg-glosa">Qué pasó</label>
                <input pInputText id="cg-glosa" [ngModel]="f().glosa" (ngModelChange)="onGlosa($event)" class="cg-full"
                       (keydown.enter)="guardar()"
                       placeholder="Contá qué pasó — esto NO es el concepto contable" />
              </div>

              </div><!-- /cg-col del QUE -->
              </div><!-- /cg-grid -->

              <!-- ⛔ ACÁ ESTABA EL BLOQUEO DE TODO EL MÓDULO, y no era falta de trabajo: medido el
                   2026-09-22, "caja_classify_rules" tenía 0 filas en prod y NO EXISTÍA NINGUNA PANTALLA
                   para cargarlas. La bandeja decía "0 de 8 se confirman · el resto necesita que su
                   cuenta esté declarada" y no había por dónde declararla. Se declara acá, que es donde
                   la persona tiene el beneficiario delante y acaba de elegir la cuenta. -->
              @if (puedeDeclararRegla()) {
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

              @if (bloqueos().length) {
                <ul class="fin-blocks">
                  @for (b of bloqueos(); track b) { <li>{{ textoBloqueo(b) }}</li> }
                </ul>
              }
            </div>
            </div>
            <!-- El pie queda pegado abajo del panel: con la reja de denominaciones abierta,
                 Guardar caia fuera de la vista y habia que ir a buscarlo. -->
            <div class="cg-detail-pie">
            <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cerrarConFoco(capturaAbierta)"></p-button>
            <p-button label="Guardar" icon="pi pi-check" size="small"
                      [disabled]="bloqueos().length > 0 || guardando()" (onClick)="guardar()"></p-button>
            </div>
          } @else {
            <!-- Vacio operacional: icono, titulo neutral, que hacer, y una accion real. -->
            <div class="cg-detail-nada">
              <i class="pi pi-wallet" aria-hidden="true"></i>
              <strong>Nada elegido todavia</strong>
              <p>Elegi un movimiento de la lista para confirmarlo o capturarlo. Se abre aca,
                 al lado, sin taparte la cola de trabajo.</p>
              <!-- ⛔ [CG.47] Esto estaba en --action y es LA MISMA ACCION que "Registrar
                   movimiento" de la cabecera: dos botones naranjas, con dos rotulos distintos,
                   llamando al mismo metodo. DESIGN reserva el color de marca para la accion
                   obvia; cuando hay cuatro naranjas en pantalla ninguna lo es. Este queda
                   secundario: el CTA de registrar vive arriba, aca es una salida del vacio. -->
              <p-button label="Registrar uno nuevo" icon="pi pi-plus" size="small"
                        severity="secondary" [outlined]="true"
                        [disabled]="!hayConceptos() && !coberturaSinMedir()"
                        (onClick)="abrirCaptura()"></p-button>
            </div>
          }
        </aside>
      </div><!-- /cg-split -->
    </div>

    <p-toast position="bottom-right"></p-toast>


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
        <small class="fin-dim">Al confirmar seguís directo al conteo del efectivo.</small>
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cancelarApertura()"></p-button>
        <!-- Sin bandera de ocupado, el doble clic abría DOS cortes. -->
        <p-button label="Abrir" icon="pi pi-check" size="small"
                  [disabled]="abriendo()" (onClick)="abrirCorte()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="cierreAbierto()" (visibleChange)="$event ? null : cerrarConFoco(cierreAbierto)"
              [modal]="true" [style]="{ width: '40rem', maxWidth: '96vw' }"
              header="Cerrar corte — contá el efectivo" [draggable]="false">
      <div class="fin-form">
        <!-- CG.19 Capa 1b: el arqueo es CIEGO. Acá se pintaba "Esperado / Diferencia" mientras la
             persona tecleaba, o sea que contaba hasta que la diferencia diera cero. Ahora sólo se
             ve lo que ella misma sumó; el resultado aparece al SELLAR. -->
        @if (revelado(); as r) {
          <!-- ⛔ ACÁ SE PUBLICABA $0.00 SOBRE UN DATO REDACTADO. "esperado", "diferencia" y
               "veredicto" son OPCIONALES a propósito: el servidor los recorta para quien no
               autoriza y avisa con "oculto: true". "oculto" no se leía nunca y money(undefined)
               devuelve "$0.00", así que el arqueo de un cajero se veía CUADRADO A CERO — que es
               lo contrario de "este dato no es para vos". -->
          @if (r.oculto) {
            <p class="fin-dim">Contado: <strong>{{ money(r.contado) }}</strong></p>
            <p-message severity="info" class="cg-full">El esperado y la diferencia no se te muestran: el arqueo es ciego y el resultado lo ve quien autoriza. Tu conteo quedó sellado.</p-message>
          } @else {
            <p class="fin-dim">Esperado: <strong>{{ money(r.esperado) }}</strong> ·
              Contado: <strong>{{ money(r.contado) }}</strong> ·
              Diferencia: <strong [class.fin-neg]="(r.diferencia ?? 0) < 0">{{ money(r.diferencia) }}</strong></p>
            <p-tag [value]="etiquetaVeredicto(r.veredicto)" [severity]="sevVeredicto(r.veredicto || '')"></p-tag>
          }
        } @else {
          <p class="fin-dim">Contado hasta ahora: <strong>{{ money(sumaConteo()) }}</strong></p>
          <p-message severity="info" class="cg-full">Contá sin ver el esperado. Al guardar el conteo se revela la diferencia — y a partir de ahí sólo se puede recontar UNA vez, con motivo.</p-message>
        }
        <!-- CG.23 - La misma reja que la captura, por el mismo motivo: se cuentan piezas, los
             importes se calculan, y las flechas bajan por la columna en vez de incrementar el
             valor. La clase es distinta ("cg-pieza-corte") a proposito: el foco de este dialogo
             no puede saltar a los inputs del otro. -->
        <p class="cg-cap">Desglose del efectivo del corte</p>
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
                <input pInputText type="number" class="cg-pieza-corte" min="0" step="1" inputmode="numeric"
                       [ngModel]="piezasCorteDe(b)" (ngModelChange)="setPiezasCorte(b, $event)"
                       (keydown.enter)="moverEnRejaCorte($event, 1)"
                       (keydown.arrowdown)="moverEnRejaCorte($event, 1)"
                       (keydown.arrowup)="moverEnRejaCorte($event, -1)"
                       [attr.aria-label]="'Piezas de ' + (b.familia === 'moneda' ? 'la moneda de ' : 'el billete de ') + b.label" />
              </td>
              <td class="mono cg-sub">{{ money(subtotalCorteDe(b)) }}</td>
            </tr>
          </ng-template>
          <ng-template #footer>
            <tr>
              <!-- Mismo rotulo que la reja de la captura: la morralla es el metal de menos de 50
                   centavos, el unico que no tiene renglon propio desde [CG.38]. -->
              <th scope="row">Morralla <span class="fin-dim">· menos de 50&cent;</span></th>
              <td class="fin-dim cg-na">—</td>
              <td>
                <input pInputText type="number" class="cg-pieza-corte cg-morralla-in" min="0" step="0.01"
                       inputmode="decimal"
                       [ngModel]="morrallaCorte()" (ngModelChange)="morrallaCorte.set($event)"
                       (keydown.enter)="moverEnRejaCorte($event, 1)"
                       (keydown.arrowdown)="moverEnRejaCorte($event, 1)"
                       (keydown.arrowup)="moverEnRejaCorte($event, -1)"
                       aria-label="Importe de morralla del corte: el metal de menos de 50 centavos, que no tiene renglón" />
              </td>
            </tr>
            <tr>
              <th scope="row">Contado</th>
              <td class="fin-dim cg-na">del conteo</td>
              <td>
                <input pInputText class="mono cg-total" [value]="money(sumaConteo())"
                       disabled tabindex="-1" aria-label="Total contado, calculado del conteo" />
              </td>
            </tr>
          </ng-template>
        </p-table>
        @if (revelado() && revelado()!.veredicto !== 'cuadra' && puedeRecontar()) {
          <div class="fin-row">
            <label for="cg-motivo">Motivo del reconteo</label>
            <input pInputText id="cg-motivo" [ngModel]="motivoReconteo()" (ngModelChange)="motivoReconteo.set($event)"
                   class="cg-full"
                   placeholder="Por qué se vuelve a contar — queda guardado junto al primer conteo" />
          </div>
        }
        <small [class]="gateCierre().ok ? 'fin-hint-ok' : 'fin-hint-warn'">{{ gateCierre().texto }}</small>
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cerrarConFoco(cierreAbierto)"></p-button>
        @if (!revelado()) {
          <!-- Sellar ANTES de revelar: si se revelara sin guardar, bastaba mirar el resultado y
               corregir el conteo, y el arqueo ciego dejaría de serlo. -->
          <p-button label="Guardar conteo" icon="pi pi-lock" size="small"
                    [disabled]="sumaConteo() <= 0 || sellando()" (onClick)="sellarConteo()"></p-button>
        } @else {
          @if (revelado()!.veredicto !== 'cuadra' && puedeRecontar()) {
            <p-button label="Recontar" icon="pi pi-replay" size="small" severity="secondary"
                      [disabled]="motivoReconteo().trim().length < GLOSA_MIN || sellando()" (onClick)="recontar()"></p-button>
          }
          <p-button label="Cerrar corte" icon="pi pi-check" size="small"
                    [disabled]="!gateCierre().ok || cerrando()" (onClick)="cerrarCorte()"></p-button>
        }
      </ng-template>
    </p-dialog>
  `,
})
export class FinanzasCajaGeneralComponent implements OnInit, OnDestroy {
  private svc = inject(CashLedgerService);
  private auth = inject(AuthService);
  private toast = inject(MessageService);
  private borrador = inject(CajaBorradorService);
  private caja = inject(CajaSocketService);
  private destroyRef = inject(DestroyRef);
  // `encuestarVisible` se llama desde `ngOnInit`, que NO es contexto de inyección: si no se le
  // pasan `destroyRef` y `zone`, su `inject()` interno revienta. Por eso se toman acá.
  private zone = inject(NgZone);
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
  private enfocarDetalle(): void {
    setTimeout(() => {
      const panel = this.host.nativeElement.querySelector('.cg-detail');
      const campo = panel?.querySelector<HTMLElement>(
        'input,select,textarea,button,[tabindex]:not([tabindex="-1"])');
      campo?.focus();
    }, 0);
  }

  cerrarConFoco(cual: { set(v: boolean): void }): void {
    cual.set(false);
    const el = this.focoPrevio;
    this.focoPrevio = null;
    if (el && typeof el.focus === 'function') setTimeout(() => el.focus(), 0);
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
    const inputs = Array.from(
      this.host.nativeElement.querySelectorAll(selector),
    ) as HTMLInputElement[];
    const vivos = inputs.filter((x) => !x.disabled);
    const i = vivos.indexOf(e.target as HTMLInputElement);
    if (i < 0) return;
    e.preventDefault();
    const sig = vivos[i + dir];
    if (!sig) return;
    sig.focus();
    sig.select();
  }

  /**
   * La reja de denominaciones de la captura. Selector propio, distinto del corte: los dos
   * diálogos tienen una reja y el foco de uno no puede saltar a los inputs del otro.
   */
  moverEnReja(ev: Event, dir: 1 | -1): void { this.moverFoco(ev, dir, 'input.cg-pieza'); }

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
  readonly opcionesSigno = [
    { label: 'Todo', value: '' },
    { label: 'Entradas', value: 'ingreso' },
    { label: 'Salidas', value: 'gasto' },
  ];

  /**
   * ⭐ `[CG.51]` **Arranca en LA JORNADA (3 días), no en los 45.**
   *
   * Pedido de Edgar el 2026-10-07: *"por default sólo deben ser los movimientos del día"*.
   *
   * ⛔ **«El día» literal NO se puede.** Y no es una opinión: ya se intentó. El default estuvo en
   * **1 día** desde el 2026-09-22 y se revirtió, porque la bandeja devolvía **7 filas y las 7 eran
   * documentos mal fechados** — la ventana no tenía tope de arriba, así que lo único que pasaba un
   * filtro de «último día» eran los de diciembre. Con el tope ya puesto, 1 día devuelve **cero**:
   * `fecha_valor` es la fecha del DOCUMENTO en Kepler y el ERP captura con una mediana de **3 días**
   * de rezago, así que ningún documento legítimo tiene fecha de hoy.
   *
   * Re-medido contra prod el 2026-10-07, antes de tocar esto: **hoy = 0 movimientos**, hoy+ayer = 7,
   * 7 días = 201, la ventana de 45 = **12,976**, y el día más reciente con volumen real es el 05/10
   * con 40. Un default de «hoy» abriría la pantalla vacía todos los días.
   *
   * Por eso arranca en `CAJA_JORNADA_DIAS`: la jornada **y su rezago normal**, que es lo que de
   * verdad llegó para trabajarse hoy. La serie histórica por ventana (filas · gastos · ingresos),
   * medida el 2026-09-30: 1d → 7·6·1 (todas basura) · 3d → 19·6·13 · 7d → 115·24·91 ·
   * 45d → 1,777·1,217·560.
   *
   * ⚠️ Lo de atrás NO se esconde: `rezago()` publica cuántos quedan antes del corte y por cuánto
   * dinero, y lo calcula el servidor contra **esta** ventana, no contra la suya — al angostarla, el
   * aviso crece solo. Y sigue siendo un selector, no una constante escondida, para que moverlo no
   * sea un deploy.
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

  ventanaDias = signal<number>(CAJA_JORNADA_DIAS);
  readonly opcionesVentana = [
    { label: 'Desde ayer', value: 1 },
    { label: 'La jornada', value: CAJA_JORNADA_DIAS },
    { label: '7 días', value: 7 },
    // El 45 se reteclaba acá teniendo la constante a mano. Así es como terminan "cinco familias
    // de constantes duplicadas" (ADR-056): el día que el rezago se re-mida, esto queda viejo.
    { label: `${CAJA_VENTANA_DIAS} días`, value: CAJA_VENTANA_DIAS },
    { label: 'Todo', value: 0 },
  ];
  /**
   * Lo que el SERVIDOR dijo que acotó. La píldora publicaba el selector local, o sea su propia
   * intención: si el backend corta distinto (y tiene su propio default), la pantalla mentía.
   */
  ventanaSrv = signal<{ desde?: string; dias?: number | null } | null>(null);
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
  filasMarcadas = computed(() => {
    const s = this.seleccion();
    return this.pendientes().filter((p) => s.has(p.origen_ref));
  });

  /**
   * Lo que la tabla reporta al marcar con el teclado o con el clic en la fila.
   *
   * ⛔ Se FILTRA por `confirmable` por la misma razón que `marcarTodas`: una fila sin cuenta
   * declarada iría al lote para que el servidor la rechace, y su casilla ya está deshabilitada.
   * Con el teclado no hay casilla que apagar, así que el freno tiene que estar acá.
   */
  onSeleccionTabla(filas: readonly MovimientoPendiente[]): void {
    this.seleccion.set(new Set((filas ?? []).filter((f) => f?.confirmable).map((f) => f.origen_ref)));
    this.persistir();
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
  propuesta = signal<AutofillResponse | null>(null);
  kpiRaw = signal<{ movimientos: number; ingresos: number; gastos: number; depositos: number } | null>(null);

  /**
   * ⚠️ Señales, no campos planos. La app corre ZONELESS: un callback de HttpClient no agenda
   * detección de cambios por sí solo, así que cerrar un diálogo desde un `next` dependía de que
   * alguna señal hermana cambiara en el mismo turno. `abrirCorte()` no tenía ninguna.
   */
  capturaAbierta = signal(false);
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
   */
  revelado = signal<TotalesCorte | null>(null);
  puedeRecontar = signal(false);
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

  coberturaTexto = computed(() => textoCobertura(this.cobertura()));
  textoSaldoUI = computed(() => textoSaldo(this.saldoResp()));
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
    const c = this.corteAbierto();
    return c ? { id: c.id, folio: c.folio, estado: 'borrador' } : null;
  });
  /** No se cierra sin haber SELLADO el conteo: sin revelación no hay nada firmado que cerrar. */
  gateCierre = computed(() => {
    const r = this.revelado();
    if (!r) return { ok: false, texto: 'Guardá el conteo primero: el resultado se revela al sellarlo.' };
    return puedeCerrarUI(this.corteVista(), r.veredicto ?? 'sin_contar');
  });
  hayConceptos = computed(() => this.cobertura().reduce((a, r) => a + Number(r.usables || 0), 0) > 0);
  /** Sin saldo no sabemos si hay corte abierto. No es lo mismo que saber que no hay. */
  saldoSinMedir = computed(() => this.saldoResp() === null);
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
    return etiquetaProcedencia(this.propuesta()?.concepto);
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
    if (!rows.length) return [{ label: '00 · CEDIS', value: '00' }];
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
  textoAlcance = computed(() => {
    const enPagina = this.pendientes().length;
    const ok = this.confirmables();
    const srv = this.ventanaSrv();
    const dias = srv?.dias ?? this.ventanaDias();
    const partes: string[] = [];
    if (ok < enPagina) partes.push('el resto necesita que su cuenta esté declarada');
    if (dias) partes.push(`últimos ${dias} día${dias === 1 ? '' : 's'}`);
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
    return [
      { label: 'Movimientos', value: String(k.movimientos ?? 0) },
      { label: 'Ingresos', value: money(k.ingresos) },
      { label: 'Gastos', value: money(k.gastos) },
      { label: 'Depósitos', value: money(k.depositos) },
    ];
  });

  ngOnInit(): void {
    this.cargarCobertura();
    this.cargar();
    this.cargarSaldo();
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

  ngOnDestroy(): void {
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

    // El repaso lento. Va a 60 s a propósito: es la red de seguridad, no el mecanismo — si el
    // socket anda, la bandeja ya se puso al día mucho antes y esta consulta no encuentra nada
    // nuevo. `encuestarVisible` pausa con la pestaña oculta y se pone al día al volver.
    encuestarVisible(60000, () => this.cargarPendientes(true), { destroyRef: this.destroyRef, zone: this.zone });
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
  }

  // ── Avisos ───────────────────────────────────────────────────────────────────────────────────
  //
  // ⛔ La pantalla NO TENÍA NINGUNO: cero MessageService, cero p-toast en 1,132 líneas. Guardar,
  // abrir corte, cerrar, autorizar y confirmar el lote fallaban en silencio — la persona hacía
  // clic y no pasaba nada, indistinguible de un botón muerto. Tres de esas cinco ni siquiera
  // tenían rama `error`, así que el fallo no llegaba a ningún lado.

  private textoError(e: unknown): string {
    const err = e as { status?: number; error?: { message?: string } };
    if (err?.status === 0) return 'No hay conexión con el servidor.';
    if (err?.status === 403) return 'No tenés permiso para esta acción.';
    if (err?.status === 409) return err?.error?.message || 'Ese movimiento ya estaba aplicado.';
    return err?.error?.message || 'El servidor respondió con un error.';
  }

  private avisarError(e: unknown, titulo: string): void {
    this.toast.add({ severity: 'error', summary: titulo, detail: this.textoError(e), life: 7000 });
  }

  private avisarOk(titulo: string, detalle?: string): void {
    this.toast.add({ severity: 'success', summary: titulo, detail: detalle, life: 4000 });
  }

  cargarCobertura(): void {
    this.svc.cobertura().subscribe({
      next: (c) => { this.cobertura.set(c.catalogo ?? []); this.coberturaSinMedir.set(false); },
      // Un error de red NO puede verse como "no hay conceptos": se DECLARA sin medir. Antes se
      // vaciaba la lista, y entonces el subtítulo decía "sin medir" mientras el aviso de abajo
      // afirmaba "No hay conceptos de Kepler" — dos frases contradictorias sobre el mismo hecho.
      error: () => { this.cobertura.set([]); this.coberturaSinMedir.set(true); },
    });
  }

  cargarCortes(): void {
    this.cargandoCortes.set(true);
    this.svc.cortes({ from: this.from, to: this.to, limit: 50 }).subscribe({
      next: (r) => { this.cortes.set(r.rows ?? []); this.errCortes.set(null); this.cargandoCortes.set(false); },
      error: (e) => { this.cortes.set([]); this.errCortes.set(this.textoError(e)); this.cargandoCortes.set(false); },
    });
  }

  sevEstadoCorte(e: string): 'secondary' | 'warn' | 'success' {
    return e === 'borrador' ? 'secondary' : e === 'cerrado' ? 'warn' : 'success';
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
    return puedeAutorizarUI(c as unknown as CorteVista, this.auth.user()?.sub ?? null);
  }

  autorizar(c: CorteCaja): void {
    if (!this.gateAutorizar(c).ok || this.autorizando()) return;
    this.autorizando.set(true);
    this.svc.autorizarCorte(c.id).subscribe({
      next: () => { this.autorizando.set(false); this.avisarOk('Corte autorizado', c.folio); this.cargarCortes(); },
      error: (e) => { this.autorizando.set(false); this.avisarError(e, 'No se pudo autorizar el corte'); },
    });
  }

  /** Sucursal del corte. Por ahora fija; cuando haya selector de corte, sale de ahí. */
  private sucursalActiva = '00';

  cargarSaldo(): void {
    this.svc.saldo(this.sucursalActiva).subscribe({
      next: (r) => this.saldoResp.set(r),
      // Un error de red NO es "saldo 0": se declara como sin medir. Y la barra de arriba ya NO
      // pinta "Abrir corte" en ese caso — no sabemos si hay uno abierto.
      error: () => this.saldoResp.set(null),
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
    this.svc.arqueoDia({ fecha: this.arqueoFecha(), sucursal: this.sucursalActiva }).subscribe({
      next: (r) => { this.arqueo.set(r); this.cargandoArqueo.set(false); },
      error: () => { this.arqueo.set(null); this.cargandoArqueo.set(false); },
    });
  }

  /** `[CG.29]` Los límites estructurales arrancan plegados: salen todos los días. */
  limitesAbiertos = signal(false);

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
    if (this.abriendo()) return;
    if (this.corteAbierto()) { this.abrirCierre(); return; }
    // Sin corte: se pide el fondo y, cuando el servidor confirme, se sigue al conteo.
    this.cerrarTrasAbrir.set(true);
    this.abrirApertura();
  }

  /** Marca que la apertura vino de "rendir cuentas": al confirmarla se sigue al conteo. */
  private cerrarTrasAbrir = signal(false);

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
    if (this.saldoSinMedir()) return `${trabajo} · no se pudo medir si hay corte abierto`;
    const c = this.corteAbierto();
    return c
      ? `${trabajo} · corte ${c.folio} abierto, falta rendir cuentas`
      : `${trabajo} · todavía no rendiste cuentas de esta jornada`;
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
  setDesde(d: Date | null): void { const k = this.claveDe(d); if (k) { this.from = k; this.cargar(); } }
  setHasta(d: Date | null): void { const k = this.claveDe(d); if (k) { this.to = k; this.cargar(); } }

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
    this.svc.recurrentesSinRegla().subscribe({
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

  abrirApertura(): void { this.fondoInicial.set(null); this.abrirConFoco(this.aperturaAbierta); }

  /** Si se cancela la apertura, la intención de cerrar NO queda colgada esperando. */
  cancelarApertura(): void { this.cerrarTrasAbrir.set(false); this.cerrarConFoco(this.aperturaAbierta); }

  abrirCorte(): void {
    if (this.abriendo()) return;
    this.abriendo.set(true);
    this.svc.abrirCorte({
      // `todayMx()`, no `toISOString()`: después de las 18:00 hora de México el segundo ya
      // devuelve MAÑANA, y el corte nacía con fecha de mañana.
      fecha: todayMx(),
      sucursal: this.sucursalActiva,
      // `null` → `undefined`: es la forma exacta que `abrir()` traduce a `NULL` + `sin_medir`.
      // Mandar `null` NO sirve: el servicio compara contra `undefined`.
      fondo_inicial: this.fondoInicial() ?? undefined,
    }).subscribe({
      next: () => {
        this.abriendo.set(false);
        this.aperturaAbierta.set(false);
        const f = this.fondoInicial();
        this.avisarOk('Corte abierto', f == null
          ? 'Sin fondo inicial medido: el arqueo no va a poder decir si cuadra.'
          : `Fondo inicial ${money(f)}`);
        this.cargarSaldo(); this.cargarCortes(); this.cargarArqueo();
        // [CG.29] Si la apertura vino de "rendir cuentas", se sigue DERECHO al conteo: el gesto
        // es uno solo. Sin esto la persona quedaba con el corte abierto y sin saber que le
        // faltaba un segundo clic en otro lado.
        if (this.cerrarTrasAbrir()) { this.cerrarTrasAbrir.set(false); this.abrirCierre(); }
      },
      error: (e) => { this.abriendo.set(false); this.avisarError(e, 'No se pudo abrir el corte'); },
    });
  }

  /**
   * CG.19 Capa 1b — el arqueo es CIEGO: se abre sin revelación y sin motivo de reconteo.
   * El esperado aparece cuando el servidor lo devuelve, y sólo después de SELLAR el conteo.
   */
  abrirCierre(): void {
    this.conteoCorte.set([]); this.morrallaCorte.set(0);
    this.revelado.set(null); this.motivoReconteo.set('');
    this.abrirConFoco(this.cierreAbierto);
  }

  /** Lo que la persona lleva sumado. No revela nada: es su propia suma. */
  sumaConteo(): number {
    return sumaDesglose(this.conteoCorte(), this.morrallaCorte());
  }

  /** Sella el conteo y recibe la revelación. A partir de acá el conteo ya no se retoca en silencio. */
  sellarConteo(): void {
    const c = this.corteAbierto();
    if (!c || this.sellando()) return;
    this.sellando.set(true);
    this.svc.contarCorte(c.id, this.conteoCorte(), this.morrallaCorte()).subscribe({
      next: (r) => {
        this.revelado.set(r.totales); this.puedeRecontar.set(r.puede_recontar); this.sellando.set(false);
        this.avisarOk('Conteo sellado', r.totales?.oculto ? 'El resultado lo ve quien autoriza.' : undefined);
      },
      error: (e) => { this.sellando.set(false); this.avisarError(e, 'No se pudo sellar el conteo'); },
    });
  }

  /** Segundo y último conteo. El motivo es obligatorio y el primero se conserva en el corte. */
  recontar(): void {
    const c = this.corteAbierto();
    if (!c || this.motivoReconteo().trim().length < GLOSA_MIN || this.sellando()) return;
    this.sellando.set(true);
    this.svc.recontarCorte(c.id, this.conteoCorte(), this.morrallaCorte(), this.motivoReconteo().trim()).subscribe({
      next: (r) => {
        this.revelado.set(r.totales); this.puedeRecontar.set(false); this.sellando.set(false);
        this.avisarOk('Reconteo guardado');
      },
      error: (e) => { this.sellando.set(false); this.avisarError(e, 'No se pudo recontar'); },
    });
  }

  /** ⚠️ `[CG.38]` Por denominación entera, no por valor — el mismo motivo que en la otra reja. */
  piezasCorteDe(d: Denominacion): number {
    return this.conteoCorte().find((x) => x.denom_key === d.key)?.piezas ?? 0;
  }

  /** Lo que suma ese renglón del corte. Se calcula; no hay dónde teclearlo. */
  subtotalCorteDe(d: Denominacion): number { return redondea(d.valor * this.piezasCorteDe(d)); }

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
    const c = this.corteAbierto();
    if (!c || !this.gateCierre().ok || this.cerrando()) return;
    this.cerrando.set(true);
    this.svc.cerrarCorte(c.id, this.conteoCorte(), this.morrallaCorte()).subscribe({
      next: () => {
        this.cerrando.set(false);
        this.cierreAbierto.set(false);
        this.avisarOk('Corte cerrado', 'Queda pendiente de autorizar por otra persona.');
        this.cargarSaldo(); this.cargar(); this.cargarCortes();
      },
      error: (e) => { this.cerrando.set(false); this.avisarError(e, 'No se pudo cerrar el corte'); },
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
    this.svc.libro({ from: this.from, to: this.to, tipo: this.tipo ?? undefined, search: this.search || undefined })
      .subscribe({
        next: (r) => {
          this.rows.set(r.rows ?? []); this.kpiRaw.set(r.kpi);
          this.errLibro.set(null); this.cargando.set(false); this.cargarCortes();
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
  imprimirReporteDia(): void {
    this.imprimiendoReporte.set(true);
    this.svc.libro({ from: this.from, to: this.to, tipo: this.tipo ?? undefined, search: this.search || undefined, limit: 500 })
      .subscribe({
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
            },
            generado_por: this.auth.user()?.username ?? null,
            truncado: !!r.has_more,
          };
          if (!imprimirTicketReporte(rep)) this.avisarError(null, 'El navegador no dejó abrir la impresión del reporte');
        },
        error: (e) => { this.imprimiendoReporte.set(false); this.avisarError(e, 'No se pudo generar el reporte del día'); },
      });
  }

  abrirCaptura(): void {
    this.f.set(this.formVacio());
    this.conceptoSel = null;
    this.conceptoManual.set(false);
    this.cuentaFuenteDoc.set(null);
    this.declararRegla.set(false);
    this.propuesta.set(null);
    // El cobro elegido NO sobrevive al diálogo anterior: arrastrarlo aplicaría el documento de
    // una entrega a otra, que es justo el error que el índice único frena del lado del servidor.
    this.cobroSel = null;
    this.cobroElegido.set(null);
    this.montoContado.set(null);
    // CS.3.13 — la venta a crédito tampoco sobrevive al diálogo anterior.
    this.ventaCredito.set(0);
    this.clienteCredito.set(false);
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

  onTipo(v: TipoMovimiento): void { this.setF('tipo', v); this.pedirPropuesta(); }
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
    }).subscribe({
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
    }).subscribe({
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
    }).subscribe({
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
    this.svc.cajas(this.ventanaDias() || undefined).subscribe({
      next: (r) => this.cajas.set(r.rows ?? []),
      error: () => { /* se conserva lo último conocido; el computed cae a la CAJA GENERAL */ },
    });
  }

  /** Cambiar cualquiera de los tres filtros: limpia el recibo viejo y vuelve a pedir. */
  setVentana(v: number): void { this.ventanaDias.set(Number(v)); this.cargarCajas(); this.refiltrar(); }
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
    const d = this.ventanaSrv()?.dias ?? this.ventanaDias();
    if (d) partes.push(`últimos ${d} día${d === 1 ? '' : 's'}`);
    const filtro = partes.length ? ` (${partes.join(', ')})` : '';
    return `Kepler no registró movimientos de esta caja en el corte elegido${filtro}. Ampliá la ventana o cambiá el signo.`;
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

  cargarPendientes(bg = false): void {
    if (!bg) this.cargandoPend.set(true);
    // `0` = «Todo»: se manda una fecha muy vieja en vez de omitir `from`, porque omitirlo le
    // devolvería el default del servidor y la persona habría pedido otra cosa.
    const dias = this.ventanaDias();
    const desde = dias === 0
      ? '2000-01-01'
      // El corrimiento se hace sobre el día DE MÉXICO. Con `toISOString()` la ventana corría un
      // día después de las 18:00 locales.
      : toMxDateKey(new Date(Date.now() - dias * 86400000));
    this.svc.movimientosPendientes({
      tipo: this.signoBandeja() || undefined,
      caja: this.cajaActiva() || undefined,
      from: desde,
      // CS.3.9 — el buscador universal de «por confirmar»: folio de Kepler, concepto, beneficiario, doc.
      search: this.searchPend() || undefined,
      limit: 100,
    }).subscribe({
      next: (r) => {
        this.pendientes.set(r.rows ?? []);
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
        this.ventanaSrv.set({ desde: r.desde, dias: r.ventana_dias ?? null });
        this.datosAl.set(r.datos_al ?? null);
        this.truncada.set(!!r.has_more);
        // Sólo se pinta si de verdad hay algo afuera: un "quedan 0 anteriores" es ruido.
        this.rezago.set(r.fuera_de_ventana && r.fuera_de_ventana.movimientos > 0 ? r.fuera_de_ventana : null);
        // [CG.28] Los que el ERP fechó adelante. Fuera de la lista, pero a la vista: alguien tiene
        // que ir a corregirlos en Kepler, que es lo unico que los saca de verdad.
        this.malFechados.set(r.mal_fechados && r.mal_fechados.movimientos > 0 ? r.mal_fechados : null);
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

  /** ¿El documento está fechado después de hoy? Casi siempre es un error de captura en Kepler. */
  esFutura(f: string | null | undefined): boolean {
    if (!f) return false;
    // Contra el día de MÉXICO: con `toISOString()` este aviso se apagaba solo a partir de las
    // 18:00 locales, que es justo cuando se captura el cierre del día.
    return String(f).slice(0, 10) > todayMx();
  }

  estaMarcada(ref: string): boolean { return this.seleccion().has(ref); }

  marcar(ref: string, on: boolean): void {
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
    if (!refs.length || this.confirmando()) return;
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
    this.svc.frecuentes({ tipo: 'gasto', sucursal: this.f().sucursal, limit: 10 }).subscribe({
      next: (r) => this.frecuentes.set(r.rows ?? []),
      error: () => this.frecuentes.set([]),
    });
  }

  /** Un toque llena cuenta, concepto, glosa y beneficiario. El importe NUNCA se pre-llena. */
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
    this.svc.conceptos(this.f().sucursal || undefined, e.query || '', 30).subscribe({
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
    if (!f.tipo && !f.beneficiario && !f.glosa) return;
    this.svc.autofill({
      tipo: f.tipo, sucursal: f.sucursal,
      glosa: f.glosa || undefined, beneficiario: f.beneficiario || undefined,
    }).subscribe({
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
  piezasDe(d: Denominacion): number {
    return this.f().denominaciones.find((x) => x.denom_key === d.key)?.piezas ?? 0;
  }

  /** Lo que suma ese renglón. Se CALCULA: no hay dónde teclearlo, y por eso va deshabilitado. */
  subtotalDe(d: Denominacion): number { return redondea(d.valor * this.piezasDe(d)); }

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

  piezasDevueltasDe(d: Denominacion): number {
    return this.devuelto().find((x) => x.denom_key === d.key)?.piezas ?? 0;
  }

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
    this.svc.detalle(m.id).subscribe({
      next: (d) => {
        if (!imprimirTicketComprobante(this.comprobanteDe(d, d.denominaciones ?? []))) {
          this.avisarError(null, 'El navegador no dejó abrir la impresión del comprobante');
        }
      },
      error: (e) => this.avisarError(e, 'No se pudo abrir el comprobante'),
    });
  }

  guardar(): void {
    if (this.bloqueos().length || this.guardando()) return;
    this.guardando.set(true);
    const cobro = this.cobroElegido();
    const caos = this.caosElegido();
    const f = this.f();
    // Se lee ANTES de emitir: el `next` corre despues y para entonces el dialogo ya se cerro.
    const declarar = this.declararRegla() && this.puedeDeclararRegla();
    // CS.3.8 — el desglose que va al servidor, capturado ACÁ para imprimir el comprobante en el
    // `next` (después la reja ya se reseteó). Es el arqueo completo (cajero + reja).
    const densComprobante = this.denominacionesParaGuardar();
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
      // ⭐ Lo CONTADO, en su campo propio. Sin esto el servidor relee el importe del documento y
      // descarta el conteo: la diferencia llegaba al hallazgo pero NO al libro, o sea que la caja
      // guardaba lo que decía Kepler y el efectivo de más (o de menos) se evaporaba. El backend ya
      // tenía `monto_contado` resuelto; lo que faltaba era que la pantalla lo mandara.
      monto_contado: this.montoContado() ?? undefined,
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
      client_uuid: this.nuevoUuid(),
    }).subscribe({
      next: (m) => {
        this.guardando.set(false);
        this.capturaAbierta.set(false);
        this.avisarOk('Movimiento registrado', `${this.etiquetaTipo(f.tipo)} por ${money(f.monto)}`);
        // CS.3.8 — el comprobante sale solo a la térmica con lo recién guardado (folio nuestro,
        // desglose, concepto, recibido, total, firma). Se re-imprime cuando haga falta desde la lista.
        if (m?.folio) imprimirTicketComprobante(this.comprobanteDe(m, densComprobante));
        // La regla va DESPUÉS de que el movimiento se guardó, y en su propia petición: si
        // declararla falla, el registro del efectivo ya está hecho y no se pierde.
        if (declarar) this.declararCuenta(f);
        this.cargar(); this.cargarSaldo();
      },
      error: (e) => { this.guardando.set(false); this.avisarError(e, 'No se pudo guardar el movimiento'); },
    });
  }

  /**
   * `crypto.randomUUID` sólo existe en contexto seguro: sobre `http://` en la LAN —que es como se
   * abre esta pantalla en las sucursales— es `undefined` y `guardar()` reventaba ANTES de emitir
   * la petición, con el error tragado encima. La llave de idempotencia no puede depender de eso.
   */
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

  private nuevoUuid(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}
