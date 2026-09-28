import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { MessageModule } from 'primeng/message';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CAJA_VENTANA_DIAS } from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { todayMx, toMxDateKey } from '../../../../core/utils/mx-date';
import { CashLedgerService, type ConceptoKepler, type MovimientoCaja, type AutofillResponse, type TipoMovimiento, type SaldoResponse, type CorteCaja, type TotalesCorte, type MovimientoPendiente, type CajaKepler, type ResumenLote, type Frecuente, type CoberturaResponse, type CaosCapturable, type CaosCandidato } from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import { CajaBorradorService } from './caja-borrador.service';
import { CajaSocketService } from '../../caja-socket.service';
import { imprimirComprobante as imprimirTicketComprobante, imprimirReporteDia as imprimirTicketReporte, type ComprobanteCaja, type ReporteDia } from './ticket-comprobante';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import {
  BILLETES_CAJA, motivosDeBloqueo, TEXTO_BLOQUEO, etiquetaProcedencia, etiquetaManual,
  textoCobertura, sumaDesglose, redondea, puedeAutorizarUI, puedeCerrarUI, textoSaldo, GLOSA_MIN,
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

/** CS.3.7 — Suma piezas por denominación de varias fuentes (cajero + reja) y descarta las de 0. */
function mergeDenoms(fuentes: Array<{ denominacion: number; piezas: number }>): Array<{ denominacion: number; piezas: number }> {
  const m = new Map<number, number>();
  for (const d of fuentes) {
    const den = Number(d.denominacion); const pz = Number(d.piezas) || 0;
    if (pz > 0) m.set(den, (m.get(den) ?? 0) + pz);
  }
  return [...m.entries()].map(([denominacion, piezas]) => ({ denominacion, piezas })).sort((a, b) => b.denominacion - a.denominacion);
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
    FormsModule, ButtonModule, InputTextModule, InputNumberModule, TableModule,
    SelectModule, TagModule, DialogModule, AutoCompleteModule, MessageModule, ToastModule,
    MetricStripComponent, LoadStateComponent,
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
    .cg-head-actions { display:flex; align-items:center; gap:.5rem; }

    /* La barra del corte: saldo + estado + acción, en una línea que se lee de un vistazo. */
    .fin-corte-bar { display:flex; align-items:center; flex-wrap:wrap; gap:.75rem; margin:.75rem 0 1rem; }
    .fin-saldo { font-weight:600; font-variant-numeric:tabular-nums; }

    .fin-filters { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; margin:1rem 0 .75rem; }
    .fin-filters input, .fin-filters p-select { min-width:11rem; }

    .fin-h2 { font-size:var(--fs-h3); font-weight:700; margin:1.5rem 0 .5rem; }
    .fin-dim { color:var(--text-muted); font-size:var(--fs-xs); }
    .fin-empty { text-align:center; color:var(--text-muted); padding:1.25rem 0; }
    /* ⚠️ Acá decía "var(--danger-fg, #b42318)" y --danger-fg NO EXISTE en tokens.css: ganaba
       siempre el hex de fallback, que es un rojo de tema claro. O sea que en modo oscuro un
       faltante de caja se pintaba ilegible. El token de la casa es --bad-fg y sí flipea. */
    .fin-neg { color:var(--bad-fg); }
    .d-block { display:block; }

    /* Formulario de captura. fin-row-col apila cuando el campo necesita su propia explicación
       debajo (el selector de cobro de Kepler), en vez de meterla en la misma línea. */
    .fin-form { display:flex; flex-direction:column; gap:.85rem; }
    /* CS.3.7 — Dos columnas para que la captura entre en una pantalla sin scroll. Apila en angosto. */
    .cg-grid { display:grid; grid-template-columns:1fr 1fr; gap:.85rem 1.5rem; align-items:start; }
    .cg-grid > .cg-col { display:flex; flex-direction:column; gap:.7rem; min-width:0; }
    @media (max-width:760px) { .cg-grid { grid-template-columns:1fr; } }
    .fin-row { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; }
    .fin-row > label { min-width:6.5rem; font-size:var(--fs-sm); color:var(--text-muted); }
    .fin-row-col { flex-direction:column; align-items:stretch; gap:.35rem; }
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
    .cg-arqueo { border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:.6rem .75rem; }
    .cg-arqueo-head { display:flex; align-items:baseline; justify-content:space-between;
                      flex-wrap:wrap; gap:.5rem; margin-bottom:.4rem; font-size:var(--fs-sm); }
    /* El caption es para el lector de pantalla; en pantalla la cabecera ya lo dice. */
    .cg-cap { position:absolute; width:1px; height:1px; overflow:hidden;
              clip-path:inset(50%); white-space:nowrap; }
    .cg-arqueo-tbl { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .cg-arqueo-tbl th, .cg-arqueo-tbl td { padding:.2rem .4rem; text-align:right; }
    .cg-arqueo-tbl thead th { font-weight:600; color:var(--text-muted); font-size:var(--fs-xs);
                              border-bottom:1px solid var(--border-color); }
    .cg-arqueo-tbl thead th:first-child { text-align:left; }
    .cg-arqueo-tbl tbody th, .cg-arqueo-tbl tfoot th { text-align:left; font-weight:500; }
    .cg-arqueo-tbl tfoot th, .cg-arqueo-tbl tfoot td { border-top:1px solid var(--border-color);
                                                       padding-top:.4rem; font-weight:700; }
    /* Piezas: angosto, a la derecha y tabular. Contar es teclear numeros cortos en columna. */
    .cg-arqueo-tbl input.cg-pieza, .cg-arqueo-tbl input.cg-pieza-corte {
      width:5.5rem; text-align:right; font-variant-numeric:tabular-nums; padding:.2rem .4rem; }
    .cg-arqueo-tbl input.cg-morralla-in { width:7.5rem; }
    /* El importe NO se teclea: sale del conteo. Se pinta como dato, no como campo. */
    .cg-sub { font-variant-numeric:tabular-nums; color:var(--text-muted); }
    .cg-na { text-align:center; font-size:var(--fs-xs); }
    .cg-arqueo-tbl input.cg-total { width:7.5rem; text-align:right; padding:.2rem .4rem;
                                    font-variant-numeric:tabular-nums; font-weight:700; }

    /* Los motivos de bloqueo van TODOS juntos: que se vea de una vez lo que falta. */
    .fin-blocks { margin:.25rem 0 0; padding-left:1.1rem; color:var(--warn-fg); font-size:var(--fs-sm); }

    /* CG.20 - la bandeja de entregas. Densa, tipo Operations: la persona la recorre marcando. */
    .cg-bandeja { border:1px solid var(--border-color); border-radius:var(--r-md,8px);
                  padding:.75rem .9rem; margin:1rem 0; }
    .cg-bandeja-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:.6rem; margin-bottom:.5rem; }
    .cg-bandeja-head .fin-h2 { margin:0; }
    .cg-bandeja-sp { flex:1 1 auto; }
    .cg-tbl { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .cg-tbl th { text-align:left; font-weight:600; color:var(--text-muted); padding:.35rem .5rem;
                 border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .cg-tbl td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color);
                 vertical-align:top; }
    /* La fila trabada se ve distinta PERO SIGUE VISIBLE: esconderla dejaria a la persona sin
       saber que ese movimiento existe y que alguien tiene que declarar su cuenta.
       ⚠️ El .62 de antes se comia tambien el motivo, que es justo lo que hay que poder leer:
       texto de .78rem al 62% no pasa AA. Se atenua la fila y se EXCLUYE el motivo. */
    .cg-trabada { opacity:.78; }
    .cg-trabada .fin-hint-warn { opacity:1; }
    .cg-contado { width:7.5rem; text-align:right; font-variant-numeric:tabular-nums; }
    .cg-rezago { margin:.5rem 0 0; font-size:var(--fs-xs); }
    /* El control principal de la bandeja es marcar fila por fila: un checkbox de 13px es el
       objetivo mas chico de la pantalla y el que mas se usa. */
    .cg-check { width:1.05rem; height:1.05rem; cursor:pointer; accent-color:var(--action); }
    /* CG.21 - el signo se lee de un vistazo. La flecha va ADEMAS del color, no en su lugar:
       el color solo deja fuera a quien no lo distingue.
       ⚠️ Decia var(--p-green-600) / var(--p-orange-600): son tokens de paleta de @primeuix que
       este preset NO emite, asi que siempre ganaba el hex y no flipeaba en oscuro. */
    .cg-in  { color:var(--ok-fg); }
    .cg-out { color:var(--warn-fg); }

    /* Chips de lo que mas se repite. El numero es el soporte: sin el, un chip es una opinion. */
    .cg-chips { display:flex; flex-wrap:wrap; gap:.4rem; }
    .cg-chip { display:inline-flex; align-items:center; gap:.35rem; cursor:pointer;
               border:1px solid var(--border-color); border-radius:999px;
               background:transparent; color:inherit; font:inherit; font-size:var(--fs-xs);
               padding:.3rem .7rem; min-height:2rem; }
    .cg-chip:hover { border-color:var(--action); color:var(--action); }
    .cg-chip:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .cg-chip-n { color:var(--text-muted); font-variant-numeric:tabular-nums; font-size:var(--fs-micro); }
    .cg-link { align-self:flex-start; background:none; border:0; padding:0; cursor:pointer;
      color:var(--action); font-size:var(--fs-micro); text-decoration:underline; }
    .cg-link:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .cg-caos { border-color:var(--action); }
    .cg-caos-list { display:flex; flex-direction:column; gap:.35rem; }
    .cg-caos-row { display:flex; align-items:center; gap:.75rem; width:100%; text-align:left;
      cursor:pointer; border:1px solid var(--border-color); border-radius:var(--r-sm,6px);
      background:transparent; padding:.5rem .7rem; min-height:var(--tap-min,44px); color:inherit; }
    .cg-caos-row:hover { border-color:var(--action); }
    .cg-caos-row:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .cg-caos-tag { font-size:var(--fs-micro); font-weight:600; padding:.1rem .45rem; border-radius:999px;
      border:1px solid var(--border-color); color:var(--text-muted); white-space:nowrap; }
    .cg-caos-in { color:var(--action); border-color:var(--action); }
    .cg-caos-monto { font-variant-numeric:tabular-nums; }
    .cg-caos-ref { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cg-caos-go { color:var(--action); font-size:var(--fs-micro); white-space:nowrap; }
    .cg-caos-attach { color:var(--text-muted); font-size:var(--fs-micro); }
    .cg-caos-attach.cg-caos-alta { color:var(--action); }
    .cg-caos-info { cursor:default; }
    .cg-cajero { border:1px dashed var(--border-color); border-radius:var(--r-md,8px); padding:.6rem .7rem; }
    .cg-cajero-head { display:flex; align-items:baseline; justify-content:space-between; gap:.5rem; }
    .cg-cajero-head label { margin:0; }
    /* CS.3.7 — La mención APARTE del efectivo del cajero (CAOS): ya contado por la máquina, no en la reja. */
    .cg-caja-aparte { border:1px solid var(--action); border-radius:var(--r-md,8px); padding:.5rem .7rem;
      display:flex; flex-direction:column; gap:.35rem; }
    .cg-caja-aparte-top { display:flex; align-items:baseline; flex-wrap:wrap; gap:.4rem; }
    .cg-caja-ico { color:var(--action); font-weight:700; }
    .cg-caja-denoms { display:flex; flex-wrap:wrap; gap:.15rem .6rem; font-size:var(--fs-micro); }
    /* CS.3.8 — botón de imprimir comprobante en la lista de movimientos. */
    .ta-c { text-align:center; }
    .cg-print { background:none; border:1px solid var(--border-color); border-radius:var(--r-sm,6px);
      cursor:pointer; color:var(--action); padding:.25rem .55rem; min-height:2rem; min-width:2.2rem; }
    .cg-print:hover { border-color:var(--action); }
    .cg-print:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    /* CS.3.11 — panel de conciliación caja chica vs cajero (CAOS). */
    .cg-conc { border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:.6rem .8rem;
      display:flex; flex-direction:column; gap:.3rem; max-width:34rem; }
    .cg-conc-h { font-size:var(--fs-sm); }
    .cg-conc-row { display:flex; justify-content:space-between; gap:1rem; font-size:var(--fs-sm); }
    .cg-conc-row .mono { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cg-conc-tot { border-top:1px solid var(--border-color); padding-top:.3rem; font-weight:600; }
    .cg-caos-alta { color:var(--action); border-color:var(--action); font-weight:700; }
    .cg-chip-x { background:none; border:0; cursor:pointer; color:inherit; padding:0 0 0 .25rem; }
    /* CS.3.1c — El billete que la máquina ya contó se ve BLOQUEADO (readonly), no editable. */
    .cg-arqueo-tbl input.cg-pieza:read-only { color:var(--text-muted); cursor:not-allowed;
      background:color-mix(in srgb, var(--border-color) 22%, transparent); }

    /* Fitts en tactil: el dedo no acierta un chip de 24px ni un checkbox de 16. */
    @media (pointer: coarse) {
      .cg-chip { min-height:var(--tap-min, 44px); padding:.5rem .9rem; }
      .cg-check { width:1.4rem; height:1.4rem; }
    }

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
    .cg-declara { align-items:flex-start; gap:.6rem; border:1px solid var(--border-color);
                  border-radius:var(--r-sm,6px); padding:.6rem .75rem; cursor:pointer; }
    .cg-declara span { font-size:var(--fs-sm); }
    .cg-full { width:100%; }
    .cg-sel { min-width:9rem; }
    /* El input interno del autocomplete SI es un descendiente real, y no estira solo. */
    :host ::ng-deep .cg-full .p-autocomplete-input { width:100%; }
  `],
  template: `
    <div class="surf-page in">
      <!-- El shell de página es el GLOBAL (surf-*, styles.css), el mismo que usa /finanzas/caja.
           Antes eran clases fin-* que NO EXISTEN en el repo: la página se pintaba sin un solo
           estilo. Inventar un segundo shell de página es exactamente lo que ADR-056 prohíbe. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja General</h1>
          <p class="surf-page-sub">{{ coberturaTexto() }}</p>
        </div>
        <div class="cg-head-actions">
          <!-- Sólo se bloquea con cobertura MEDIDA en cero. Si la medición falló no sabemos si hay
               conceptos, y trabar la captura por una caída transitoria es peor que dejar que el
               servidor rechace: la persona se queda sin poder registrar efectivo que ya tiene. -->
          <p-button label="Registrar movimiento" icon="pi pi-plus" size="small"
                    (onClick)="abrirCaptura()" [disabled]="!hayConceptos() && !coberturaSinMedir()"></p-button>
        </div>
      </header>

      <!-- ⚠️ Antes esto decía "No hay conceptos" también cuando la medición había FALLADO, y el
           subtítulo de arriba decía "sin medir" al mismo tiempo. Dos frases contradictorias sobre
           el mismo hecho. Ahora cada ausencia dice la suya. -->
      @if (coberturaSinMedir()) {
        <p-message severity="warn" class="cg-full">No se pudo medir la cobertura del catálogo de conceptos. No es "no hay conceptos": es que no sabemos. Se puede capturar, pero si la cuenta no existe el servidor la va a rechazar.</p-message>
      } @else if (!hayConceptos()) {
        <p-message severity="warn" class="cg-full">No hay conceptos de Kepler disponibles. No se puede capturar sin cuenta contable — revisá el carril del ODS antes de seguir.</p-message>
      }

      <div class="fin-corte-bar">
        <span class="fin-saldo">{{ textoSaldoUI() }}</span>
        <!-- ⚠️ Tres estados, no dos. Cuando el saldo NO se pudo medir no sabemos si hay corte
             abierto, y el @else pintaba "Abrir corte" -- o sea que la pantalla AFIRMABA que no
             había ninguno. Ofrecer abrir un segundo corte sobre uno vivo es el peor final. -->
        @if (saldoSinMedir()) {
          <p-tag value="Corte sin medir" severity="warn"></p-tag>
          <p-button label="Reintentar" icon="pi pi-refresh" size="small" severity="secondary"
                    [text]="true" (onClick)="cargarSaldo()"></p-button>
        } @else if (corteAbierto()) {
          <p-tag [value]="'Corte ' + corteAbierto()!.folio" severity="info"></p-tag>
          <p-button label="Cerrar corte" icon="pi pi-lock" size="small" severity="secondary"
                    (onClick)="abrirCierre()"></p-button>
        } @else {
          <p-button label="Abrir corte" icon="pi pi-unlock" size="small" severity="secondary"
                    [disabled]="abriendo()" (onClick)="abrirApertura()"></p-button>
        }
      </div>

      <!-- CS.3.11 — Arqueo final: conciliación de la caja chica contra el CAJERO (CAOS). Sólo en
           oficinas (00), con corte abierto. Modelo «cajas separadas»: el cajero es la bóveda. -->
      @if (conciliacionCajero(); as cj) {
        <div class="cg-conc">
          <strong class="cg-conc-h">Conciliación con el cajero (CAOS)</strong>
          <div class="cg-conc-row"><span>Depositado al cajero <small class="fin-dim">(salió de caja chica)</small></span>
            <span class="mono">− {{ money(cj.depositado) }}</span></div>
          <div class="cg-conc-row"><span>Dispensado del cajero <small class="fin-dim">(entró a caja chica)</small></span>
            <span class="mono">+ {{ money(cj.dispensado) }}</span></div>
          @if (cajaChicaConciliada(); as z) {
            <div class="cg-conc-row cg-conc-tot"><span>Caja chica conciliada <small class="fin-dim">(esperado − depositado + dispensado)</small></span>
              <span class="mono">{{ money(z) }}</span></div>
          } @else {
            <small class="fin-dim">La caja chica conciliada se muestra al revelar el esperado (permiso de cierre).</small>
          }
          <small class="fin-dim">{{ cj.movimientos }} movimiento(s) del cajero desde que abrió el corte. El cajero es la bóveda; la caja chica es el efectivo suelto.</small>
        </div>
      }

      <app-metric-strip [items]="kpis()"></app-metric-strip>

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
      <section class="cg-bandeja">
        <header class="cg-bandeja-head">
          <h2 class="fin-h2">Movimientos por confirmar</h2>
          <span class="fin-dim">{{ textoBandeja() }}</span>
          <span class="cg-bandeja-sp"></span>
          <p-select [options]="opcionesVentana" [ngModel]="ventanaDias()" optionLabel="label" optionValue="value"
                    (ngModelChange)="setVentana($event)" class="cg-sel" [ariaLabel]="'Desde cuándo'"></p-select>
          <p-select [options]="opcionesSigno" [ngModel]="signoBandeja()" optionLabel="label" optionValue="value"
                    (ngModelChange)="setSigno($event)" class="cg-sel" [ariaLabel]="'Signo'"></p-select>
          <p-select [options]="opcionesCaja()" [ngModel]="cajaActiva()" optionLabel="label" optionValue="value"
                    (ngModelChange)="setCaja($event)" class="cg-sel" [ariaLabel]="'Caja'"></p-select>
          <p-button [label]="'Confirmar ' + marcadas().length" icon="pi pi-check" size="small"
                    [disabled]="!marcadas().length || confirmando()" (onClick)="confirmarLote()"></p-button>
        </header>

        <!-- El recibo del lote va ARRIBA de la lista y FUERA de ella. Estaba adentro, así que al
             confirmar el último lote la lista quedaba vacía, la sección se desmontaba y el
             "12 confirmadas por $X" desaparecía justo en el caso donde más importa leerlo. -->
        @if (resultado(); as r) {
          <p-message [severity]="r.rechazados || r.no_confirmables ? 'warn' : 'success'"
                     class="cg-full">{{ textoResultado(r) }}</p-message>
        }

        <!-- Lo tecleado que sobrevivio a un refresh. Se DICE que se restauro y se puede tirar: un
             conteo que reaparece sin avisar es un conteo que nadie recuerda haber hecho. -->
        @if (restaurado(); as b) {
          <p-message [severity]="b.conteos ? 'info' : 'warn'" class="cg-full">
            {{ textoRestaurado(b) }}
            @if (b.conteos) {
              <button type="button" class="cg-chip" (click)="descartarBorrador()">Descartar</button>
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
          <table class="cg-tbl">
            <caption class="sr-only">Movimientos de Kepler pendientes de confirmar en el libro de caja</caption>
            <thead>
              <tr>
                <th scope="col" class="ta-c"><input type="checkbox" class="cg-check" [checked]="todasMarcadas()"
                                        (change)="marcarTodas($any($event.target).checked)"
                                        aria-label="Marcar todas las confirmables" /></th>
                <th scope="col">Fecha</th>
                <th scope="col"><span class="sr-only">Entra o sale</span></th>
                <th scope="col">Contraparte</th><th scope="col">Documento</th><th scope="col">Cuenta</th>
                <th scope="col" class="ta-r">Importe (ERP)</th><th scope="col" class="ta-r">Contado</th>
                <th scope="col"><span class="sr-only">Capturar a mano</span></th>
              </tr>
            </thead>
            <tbody>
              @for (p of pendientes(); track p.origen_ref) {
                <tr [class.cg-trabada]="!p.confirmable">
                  <td class="ta-c">
                    <input type="checkbox" class="cg-check" [disabled]="!p.confirmable"
                           [checked]="estaMarcada(p.origen_ref)"
                           (change)="marcar(p.origen_ref, $any($event.target).checked)"
                           [attr.aria-label]="'Confirmar ' + p.doc_tipo + ' ' + p.folio" />
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
                    @if (!p.confirmable) { <small class="fin-hint-warn d-block">{{ p.motivo_texto }}</small> }
                    @if (p.caos_match; as cm) {
                      <small class="cg-caos-attach d-block" [class.cg-caos-alta]="cm.confianza === 'alta'">
                        ⇄ del cajero {{ cm.ref || 's/ref' }} {{ money(cm.monto) }}@if (p.monto - cm.monto > 0.5) { · retiene {{ money(p.monto - cm.monto) }} } · {{ cm.confianza }}
                      </small>
                    }
                  </td>
                  <td class="mono">{{ p.doc_tipo }} {{ p.folio }}</td>
                  <td class="mono">{{ p.kepler_cuenta || '—' }}</td>
                  <td class="ta-r mono">{{ money(p.monto) }}</td>
                  <td class="ta-r">
                    <!-- Vacio = se toma el importe del ERP. Solo se escribe si se conto distinto,
                         y entonces manda lo contado: nunca se rechaza efectivo.

                         ⛔ ACA ESTABA "[disabled]=!p.confirmable", y el comentario de arriba decia
                         literalmente "se deja habilitado igual". El codigo hacia lo contrario que
                         su propio comentario. Con 0 reglas de gasto y 0 rutas firmadas TODAS las
                         filas son no-confirmables, asi que el arqueo estaba muerto en la pantalla
                         entera: no se podia teclear lo contado de un solo movimiento.
                         Contar es un HECHO FISICO; que su cuenta contable este declarada es una
                         decision administrativa. Trabar el primero por el segundo mezcla dos cosas
                         distintas -- y el efectivo ya esta en la caja, se registre o no. -->
                    <!-- Enter y las flechas bajan por la COLUMNA, que es como se cuenta: con el
                         Tab pelado son tres saltos por fila (casilla, contado, Capturar) y acá
                         entran 100 filas. Ademas, en un input numerico las flechas INCREMENTAN el
                         valor de a uno -- en un importe de caja eso es cambiar lo contado sin
                         querer, asi que quitarselas es parte del arreglo, no un efecto colateral. -->
                    <input pInputText type="number" class="cg-contado"
                           [ngModel]="contadoDe(p.origen_ref)"
                           (ngModelChange)="setContado(p.origen_ref, $event)"
                           (keydown.enter)="moverEnColumna($event, 1)"
                           (keydown.arrowdown)="moverEnColumna($event, 1)"
                           (keydown.arrowup)="moverEnColumna($event, -1)"
                           [placeholder]="'igual'" [attr.aria-label]="'Contado de ' + p.folio" />
                  </td>
                  <td>
                    <!-- La salida de una fila trabada. Sin esto, contar no servia de nada: el lote
                         la rechaza por no tener cuenta, y no habia forma de llevarla a la captura
                         manual sin retipear el documento entero. Abre el dialogo ANCLADO a este
                         documento de Kepler, con lo contado ya puesto. -->
                    <p-button [label]="p.confirmable ? 'Abrir' : 'Capturar'" size="small"
                              severity="secondary" [text]="true"
                              [title]="'Capturar a mano ' + p.doc_tipo + ' ' + p.folio"
                              (onClick)="capturarDesde(p)"></p-button>
                  </td>
                </tr>
              }
            </tbody>
          </table>

          <!-- La lista viene TOPADA. Sin esto, un movimiento más allá del tope era invisible y
               nadie lo iba a confirmar nunca: el contador de arriba mentía sobre un conjunto
               recortado y el bloque de «fuera de ventana» sólo cubre lo anterior por FECHA. -->
          @if (truncada()) {
            <p class="fin-dim cg-rezago">
              Se muestran las primeras <strong>{{ pendientes().length }}</strong> de esta ventana —
              hay más. Acotá por signo o por caja, o achicá la ventana, para verlas todas.
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
      </section>

      <!-- CS.3.6 — El cajero (CAOS) YA lo contó la máquina y se ADJUNTA solo a su cobro/gasto de
           Kepler arriba (no se captura aparte). Acá sólo se MENCIONAN los que el motor aún no pudo
           conciliar — esperan su movimiento de Kepler, o se adjuntan a mano desde la captura. -->
      @if (caosSinConciliar().length) {
        <section class="cg-bandeja cg-caos">
          <header class="cg-bandeja-head">
            <h2 class="fin-h2"><i class="pi pi-lock" aria-hidden="true"></i> Cajero (CAOS) — sin conciliar</h2>
            <span class="cg-bandeja-sp"></span>
            <small class="fin-dim">{{ caosSinConciliar().length }} ya contados por la máquina, aún sin su movimiento de Kepler</small>
          </header>
          <div class="cg-caos-list">
            @for (m of caosSinConciliar(); track m.origen_ref) {
              <div class="cg-caos-row cg-caos-info">
                <span class="cg-caos-tag" [class.cg-caos-in]="m.tipo === 'ingreso'">{{ m.type_label }}</span>
                <span class="mono cg-caos-monto">{{ money(m.monto) }}</span>
                <span class="fin-dim cg-caos-ref">{{ m.ref || 'sin referencia' }}</span>
                <span class="fin-dim">{{ m.user_external || '' }}</span>
              </div>
            }
          </div>
        </section>
      }

      <div class="fin-filters">
        <input pInputText type="date" [(ngModel)]="from" (ngModelChange)="cargar()" aria-label="Desde" />
        <input pInputText type="date" [(ngModel)]="to" (ngModelChange)="cargar()" aria-label="Hasta" />
        <p-select [options]="tiposFiltro" [(ngModel)]="tipo" (ngModelChange)="cargar()"
                  optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true"></p-select>
        <input pInputText [(ngModel)]="search" (keyup.enter)="buscar()"
               placeholder="Busca en TODO: realizados y por confirmar (folio, concepto, beneficiario, usuario…)" />
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
      <p-table [value]="rows()" size="small"
               [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Fecha</th><th>Tipo</th><th>Cuenta / Concepto</th>
            <th>Qué pasó</th><th class="ta-r">Monto</th><th>Capturó</th><th>Origen</th>
            <th class="ta-c">Comprobante</th>
          </tr>
        </ng-template>
        <ng-template #body let-m>
          <tr>
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
                <button type="button" class="cg-print" (click)="imprimirComprobante(m)"
                        title="Imprimir comprobante" aria-label="Imprimir comprobante">
                  <i class="pi pi-print" aria-hidden="true"></i>
                </button>
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
      <p-table [value]="cortes()" size="small">
        <ng-template #header>
          <tr>
            <th scope="col">Folio</th><th scope="col">Fecha</th><th scope="col">Sucursal</th><th scope="col">Estado</th>
            <th scope="col" class="ta-r">Esperado</th><th scope="col" class="ta-r">Contado</th><th scope="col" class="ta-r">Diferencia</th>
            <th scope="col">Cerró / Autorizó</th><th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-c>
          <tr>
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
    </div>

    <p-toast position="bottom-right"></p-toast>

    <p-dialog [visible]="capturaAbierta()" (visibleChange)="$event ? null : cerrarConFoco(capturaAbierta)"
              [modal]="true" [style]="{ width: '62rem', maxWidth: '96vw' }"
              header="Registrar movimiento de caja" [draggable]="false">
      <div class="fin-form">
        <div class="fin-row">
          <!-- Los <label> de este formulario NO tenían for= ni envolvían su control: un lector de
               pantalla anunciaba TODA la captura de caja como campos sin nombre. -->
          <label for="cg-tipo">Tipo</label>
          <p-select inputId="cg-tipo" [options]="tiposCaptura" [ngModel]="f().tipo" optionLabel="label" optionValue="value"
                    (ngModelChange)="onTipo($event)"></p-select>
          <label for="cg-fecha">Fecha</label>
          <input pInputText id="cg-fecha" type="date" [ngModel]="f().fecha" (ngModelChange)="setF('fecha', $event)" />
          <!-- La sucursal era TEXTO LIBRE en una captura contable: teclear "0" devolvía un catálogo
               de conceptos vacío sin decir por qué. Sale del mismo censo que ya mide la cobertura. -->
          <label for="cg-suc">Sucursal</label>
          <p-select inputId="cg-suc" [options]="opcionesSucursal()" [ngModel]="f().sucursal" optionLabel="label" optionValue="value"
                    (ngModelChange)="onSucursal($event)" [ariaLabel]="'Sucursal'"></p-select>
        </div>

        <!-- CS.3.7 — Dos columnas para que TODO entre en una pantalla sin scroll. Izquierda: el
             QUÉ/QUIÉN (documento, beneficiario, cuenta, glosa). Derecha: el CUÁNTO (cajero + arqueo). -->
        <div class="cg-grid">
        <div class="cg-col">

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
              <small class="fin-hint-ok">
                Kepler: {{ c.doc_tipo }} {{ c.folio }} · {{ c.beneficiario || c.entidad_code }} ·
                {{ money(c.monto) }}@if (c.caja_nombre) { · {{ c.caja_nombre }} }. El monto sale del arqueo, no del documento.
              </small>
              @if (contadoBandeja(); as cb) {
                <small class="fin-dim">Ya habías contado <span class="mono">{{ money(cb) }}</span> en la bandeja — desglosalo abajo.</small>
              }
              <!-- La diferencia se DICE antes de guardar: el hallazgo del servidor no sirve si la persona no la vio. -->
              @if (montoContado(); as mc) {
                <small class="fin-hint-warn">
                  Contaste {{ money(mc) }} vs documento {{ money(c.monto) }}:
                  <strong>{{ money(mc - c.monto) }}</strong> de diferencia — se registra y queda un hallazgo.
                </small>
              }
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
                <button type="button" class="cg-chip" (click)="usarFrecuente(fr)"
                        [title]="fr.kepler_cuenta + ' / ' + fr.kepler_concepto + ' — usado ' + fr.usos + ' veces'">
                  {{ fr.glosa || fr.kepler_concepto }}
                  <span class="cg-chip-n">{{ fr.usos }}</span>
                </button>
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
            <button type="button" class="cg-link" (click)="corregirCuentaDoc()">Corregir la cuenta</button>
          }
        </div>

        <div class="fin-row">
          <label for="cg-glosa">Qué pasó</label>
          <input pInputText id="cg-glosa" [ngModel]="f().glosa" (ngModelChange)="onGlosa($event)" class="cg-full"
                 (keydown.enter)="guardar()"
                 placeholder="Contá qué pasó — esto NO es el concepto contable" />
        </div>

        </div><!-- /cg-col izquierda -->
        <div class="cg-col"><!-- derecha: el CUÁNTO (cajero aparte + arqueo) -->

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
              <button type="button" class="cg-link" (click)="buscarEnCajero()" [disabled]="buscandoCajero()">
                {{ buscandoCajero() ? 'buscando…' : '¿salió del cajero? buscar retiros' }}
              </button>
            </div>
            @if (caosSugeridos().length) {
              <div class="cg-caos-list">
                @for (c of caosSugeridos(); track c.external_id) {
                  <button type="button" class="cg-caos-row" (click)="vincularCaos(c)">
                    <span class="cg-caos-tag" [class.cg-caos-alta]="c.confianza === 'alta'">{{ c.confianza }}</span>
                    <span class="mono cg-caos-monto">{{ money(c.monto) }}</span>
                    <span class="fin-dim cg-caos-ref">{{ c.ref || 'sin ref' }} · {{ dmy(c.fecha_valor) }}</span>
                    <span class="cg-caos-go" aria-hidden="true">agregar →</span>
                  </button>
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
                  <span class="cg-chip cg-caos-in">{{ money(v.monto) }} · {{ v.ref || 's/ref' }}
                    <button type="button" class="cg-chip-x" (click)="desvincularCaos(v.external_id)" aria-label="Quitar del cajero">✕</button>
                  </span>
                }
              </div>
            }
            <div class="cg-caja-denoms fin-dim mono">
              @for (d of denominacionesCajero(); track d.denominacion) {
                <span>{{ d.piezas }}×{{ money(d.denominacion) }}</span>
              }
            </div>
          </div>
        }

        <div class="cg-arqueo">
          <div class="cg-arqueo-head">
            <strong>{{ hayCajero() ? 'La diferencia, a mano' : 'Contá el efectivo' }}</strong>
            @if (cobroElegido(); as c) {
              <span class="fin-dim">El documento dice <span class="mono">{{ money(c.monto) }}</span></span>
            }
            @if (hayCajero()) {
              <span class="fin-hint-ok">El cajero ya aportó {{ money(aporteCajero()) }} — contá acá sólo lo que falta o la morralla (arranca en cero).</span>
            }
          </div>
          <table class="cg-arqueo-tbl">
            <caption class="cg-cap">Desglose del efectivo por denominación</caption>
            <thead>
              <tr>
                <th scope="col">Denominación</th>
                <th scope="col">Piezas</th>
                <th scope="col">Importe</th>
              </tr>
            </thead>
            <tbody>
              <!-- Enter y las flechas bajan por la columna, que es como se cuenta un fajo. Y en
                   un input numerico las flechas INCREMENTAN el valor de a uno, asi que
                   quitarselas es parte del arreglo, no un efecto colateral: en un arqueo eso es
                   cambiar lo contado sin querer. Mismo motivo por el que aca va un input nativo
                   y no p-inputnumber, igual que en la bandeja. -->
              @for (b of billetes; track b.key) {
                <tr>
                  <th scope="row" class="mono">{{ b.label }}</th>
                  <td>
                    <input pInputText type="number" class="cg-pieza" min="0" step="1" inputmode="numeric"
                           [ngModel]="piezasDe(b.valor)" (ngModelChange)="setPiezas(b.valor, $event)"
                           (keydown.enter)="moverEnReja($event, 1)"
                           (keydown.arrowdown)="moverEnReja($event, 1)"
                           (keydown.arrowup)="moverEnReja($event, -1)"
                           [attr.aria-label]="'Piezas de ' + b.label" />
                  </td>
                  <td class="mono cg-sub">{{ money(subtotalDe(b.valor)) }}</td>
                </tr>
              }
              <tr>
                <th scope="row">Morralla</th>
                <td class="fin-dim cg-na">—</td>
                <td>
                  <input pInputText type="number" class="cg-pieza cg-morralla-in" min="0" step="0.01"
                         inputmode="decimal"
                         [ngModel]="f().morralla" (ngModelChange)="setMorralla($event)"
                         (keydown.enter)="moverEnReja($event, 1)"
                         (keydown.arrowdown)="moverEnReja($event, 1)"
                         (keydown.arrowup)="moverEnReja($event, -1)"
                         aria-label="Importe de morralla, todas las monedas juntas" />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Monto del movimiento</th>
                <td class="fin-dim cg-na">{{ hayCajero() ? 'cajero + a mano' : 'del conteo' }}</td>
                <td>
                  <input pInputText id="cg-monto" class="mono cg-total" [value]="money(f().monto)"
                         disabled tabindex="-1" aria-label="Monto del movimiento, calculado del conteo" />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        </div><!-- /cg-col derecha -->
        </div><!-- /cg-grid -->

        <!-- ⛔ ACÁ ESTABA EL BLOQUEO DE TODO EL MÓDULO, y no era falta de trabajo: medido el
             2026-09-22, "caja_classify_rules" tenía 0 filas en prod y NO EXISTÍA NINGUNA PANTALLA
             para cargarlas. La bandeja decía "0 de 8 se confirman · el resto necesita que su
             cuenta esté declarada" y no había por dónde declararla. Se declara acá, que es donde
             la persona tiene el beneficiario delante y acaba de elegir la cuenta. -->
        @if (puedeDeclararRegla()) {
          <label class="fin-row cg-declara">
            <input type="checkbox" class="cg-check" [checked]="declararRegla()"
                   (change)="declararRegla.set($any($event.target).checked)" />
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

      <!-- ⚠️ El pie va con #footer, NO con pTemplate="footer". En PrimeNG 22 el segundo NO
           PROYECTA NADA: el diálogo se abre sin Guardar ni Cancelar, sin un solo error en
           consola y sin que el build se queje. Los 3 diálogos de esta pantalla lo tenían y
           quedaron inutilizables — medido en vivo: .p-dialog-footer no existía y el diálogo
           no tenía ningún botón. Las otras 50 pantallas del repo ya usan #footer.
           SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y lo cierran. -->
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cerrarConFoco(capturaAbierta)"></p-button>
        <p-button label="Guardar" icon="pi pi-check" size="small"
                  [disabled]="bloqueos().length > 0 || guardando()" (onClick)="guardar()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="aperturaAbierta()" (visibleChange)="$event ? null : cerrarConFoco(aperturaAbierta)"
              [modal]="true" [style]="{ width: '24rem', maxWidth: '96vw' }"
              header="Abrir corte de caja" [draggable]="false">
      <div class="fin-form">
        <div class="fin-row">
          <label for="cg-fondo">Fondo inicial</label>
          <p-inputnumber inputId="cg-fondo" [ngModel]="fondoInicial()" (ngModelChange)="fondoInicial.set($event)"
                         mode="currency" currency="MXN" locale="es-MX" />
        </div>
        <small class="fin-dim">Con qué efectivo arranca la caja. Es el punto de partida del saldo.</small>
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cerrarConFoco(aperturaAbierta)"></p-button>
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
        <table class="cg-arqueo-tbl">
          <caption class="cg-cap">Desglose del efectivo del corte</caption>
          <thead>
            <tr>
              <th scope="col">Denominación</th>
              <th scope="col">Piezas</th>
              <th scope="col">Importe</th>
            </tr>
          </thead>
          <tbody>
            @for (b of billetes; track b.key) {
              <tr>
                <th scope="row" class="mono">{{ b.label }}</th>
                <td>
                  <input pInputText type="number" class="cg-pieza-corte" min="0" step="1" inputmode="numeric"
                         [ngModel]="piezasCorteDe(b.valor)" (ngModelChange)="setPiezasCorte(b.valor, $event)"
                         (keydown.enter)="moverEnRejaCorte($event, 1)"
                         (keydown.arrowdown)="moverEnRejaCorte($event, 1)"
                         (keydown.arrowup)="moverEnRejaCorte($event, -1)"
                         [attr.aria-label]="'Piezas de ' + b.label" />
                </td>
                <td class="mono cg-sub">{{ money(subtotalCorteDe(b.valor)) }}</td>
              </tr>
            }
            <tr>
              <th scope="row">Morralla</th>
              <td class="fin-dim cg-na">—</td>
              <td>
                <input pInputText type="number" class="cg-pieza-corte cg-morralla-in" min="0" step="0.01"
                       inputmode="decimal"
                       [ngModel]="morrallaCorte()" (ngModelChange)="morrallaCorte.set($event)"
                       (keydown.enter)="moverEnRejaCorte($event, 1)"
                       (keydown.arrowdown)="moverEnRejaCorte($event, 1)"
                       (keydown.arrowup)="moverEnRejaCorte($event, -1)"
                       aria-label="Importe de morralla, todas las monedas juntas" />
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Contado</th>
              <td class="fin-dim cg-na">del conteo</td>
              <td>
                <input pInputText class="mono cg-total" [value]="money(sumaConteo())"
                       disabled tabindex="-1" aria-label="Total contado, calculado del conteo" />
              </td>
            </tr>
          </tfoot>
        </table>
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
  cerrarConFoco(cual: { set(v: boolean): void }): void {
    cual.set(false);
    const el = this.focoPrevio;
    this.focoPrevio = null;
    if (el && typeof el.focus === 'function') setTimeout(() => el.focus(), 0);
  }

  /**
   * Bajar (o subir) por la columna de Contado con Enter y las flechas.
   *
   * Es LA motion de esta pantalla: contar es recorrer una columna tecleando. Con el Tab pelado
   * son TRES saltos por fila (casilla → contado → Capturar), o sea 300 tabulaciones para las 100
   * filas que caben — y el cajero tiene el efectivo en la mano.
   */
  /**
   * Mueve el foco por una columna de inputs. Lo comparten la bandeja y las dos rejas de arqueo:
   * en las tres, la forma natural de trabajar es bajar de renglón en renglón.
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

  /** La columna "contado" de la bandeja. */
  moverEnColumna(ev: Event, dir: 1 | -1): void { this.moverFoco(ev, dir, 'input.cg-contado'); }

  /**
   * La reja de denominaciones de la captura. Selector propio, distinto del corte: los dos
   * diálogos tienen una reja y el foco de uno no puede saltar a los inputs del otro.
   */
  moverEnReja(ev: Event, dir: 1 | -1): void { this.moverFoco(ev, dir, 'input.cg-pieza'); }

  /** La reja de denominaciones del corte. */
  moverEnRejaCorte(ev: Event, dir: 1 | -1): void { this.moverFoco(ev, dir, 'input.cg-pieza-corte'); }

  readonly money = money;
  readonly dmy = dmy;
  /** Los cinco billetes de la caja. Salen del catálogo compartido, no de una lista de acá. */
  readonly billetes = BILLETES_CAJA;

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
   * Lo que la persona ya había tecleado como total en la bandeja, si vino de ahí. NO es el
   * monto: es una referencia para que no pierda ese trabajo al desglosarlo por denominación.
   */
  contadoBandeja = signal<number | null>(null);

  /** CS.3 — la segunda fuente: movimientos de CAOS (caja fuerte) capturables, y el elegido. */
  caosOpciones = signal<Array<CaosCapturable & { label: string }>>([]);
  caosSel: (CaosCapturable & { label: string }) | null = null;
  caosElegido = signal<CaosCapturable | null>(null);

  /**
   * CS.3.1c — Los movimientos de CAOS PENDIENTES de capturar, mostrados SOLOS en la bandeja (no un
   * buscador opcional): el capturista los ve sin buscarlos. Al elegir uno, el arqueo de la máquina
   * se precarga y se BLOQUEA, y sólo queda clasificar lo faltante.
   */
  caosPendientes = signal<CaosCapturable[]>([]);
  cargandoCaosPend = signal(false);

  /**
   * CS.3.6 — Los movimientos del cajero que el motor NO pudo adjuntar a ningún pendiente de Kepler
   * (sin conciliar). Informativos: ya los contó la máquina y esperan su cobro/gasto (o se adjuntan a
   * mano desde la captura). Los que SÍ casaron aparecen pegados a su fila de Kepler, no acá.
   */
  caosSinConciliar = computed(() => {
    const emparejados = new Set(this.pendientes().map((p) => p.caos_match?.origen_ref).filter(Boolean));
    return this.caosPendientes().filter((c) => !emparejados.has(c.origen_ref));
  });

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
  denominacionesCajero = computed(() => {
    const src: Array<{ denominacion: number; piezas: number }> = [];
    const o = this.caosElegido();
    if (o?.denominaciones) src.push(...o.denominaciones.map((d) => ({ denominacion: Number(d.denominacion), piezas: Number(d.piezas) })));
    for (const v of this.caosVinculados()) src.push(...v.denominaciones.map((d) => ({ denominacion: Number(d.denominacion), piezas: Number(d.piezas) })));
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
  readonly opcionesSigno = [
    { label: 'Todo', value: '' },
    { label: 'Entradas', value: 'ingreso' },
    { label: 'Salidas', value: 'gasto' },
  ];

  /**
   * ⚠️ **Puesto en 1 día (`desde ayer`) para las PRUEBAS de CG.21**, por pedido de Edgar
   * (2026-09-22). Antes de operar de verdad tiene que volver a **45**, que es la ventana con
   * razón medida (`CAJA_VENTANA_DIAS` en `@megadulces/contracts`): el rezago de captura es de
   * 4.7 días de promedio y el peor caso fueron 34, así que con 1 día la bandeja deja fuera casi
   * todo el trabajo real y lo manda al bloque de «anteriores a esta ventana».
   *
   * Es un selector y no una constante escondida justamente para que moverlo no sea un deploy.
   */
  ventanaDias = signal(1);
  readonly opcionesVentana = [
    { label: 'Desde ayer', value: 1 },
    { label: '3 días', value: 3 },
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
  /** Marcadas y lo contado por fila. `Map` y no un campo en la fila: la lista se recarga. */
  private seleccion = signal<Set<string>>(new Set());
  private contado = signal<Map<string, number | null>>(new Map());

  marcadas = computed(() => [...this.seleccion()]);
  todasMarcadas = computed(() => {
    const posibles = this.pendientes().filter((p) => p.confirmable);
    return posibles.length > 0 && posibles.every((p) => this.seleccion().has(p.origen_ref));
  });
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
  fondoInicial = signal(0);
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
   */
  conciliacionCajero = computed(() => this.saldoResp()?.cajero ?? null);
  cajaChicaConciliada = computed<number | null>(() => {
    const s = this.saldoResp(); const cj = s?.cajero;
    if (!cj || s?.saldo == null) return null;
    return Number(s.saldo) - Number(cj.depositado) + Number(cj.dispensado);
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
  bloqueos = computed<MotivoBloqueo[]>(() => motivosDeBloqueo({ ...this.f(), denominaciones: this.denominacionesParaGuardar() }));
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

  /** El renglón de contexto de la bandeja. Dice el corte REAL, el del servidor. */
  textoBandeja = computed(() => {
    const total = this.pendientes().length;
    const ok = this.confirmables();
    const srv = this.ventanaSrv();
    const dias = srv?.dias ?? this.ventanaDias();
    const partes = [`${ok} de ${total} se confirman sin elegir nada`];
    if (ok < total) partes.push('el resto necesita que su cuenta esté declarada');
    if (dias) partes.push(`últimos ${dias} día${dias === 1 ? '' : 's'}`);
    else if (srv?.desde) partes.push(`desde ${dmy(srv.desde)}`);
    // La EDAD del dato, siempre. La lista sale de una foto que refresca un carril cada minuto;
    // si ese carril se cae, la foto se congela sin dar error y esto es lo único que lo delata.
    partes.push(this.textoFrescura());
    return partes.join(' · ');
  });

  /**
   * "hace N min" o "frescura sin medir". Nunca se omite: una cifra sin edad, en una pantalla que
   * se mira para decidir sobre efectivo, es una cifra que se cree más reciente de lo que es.
   */
  textoFrescura(): string {
    const al = this.datosAl();
    if (!al) return 'frescura sin medir';
    const ms = Date.now() - new Date(al).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'frescura sin medir';
    const min = Math.floor(ms / 60000);
    if (min < 2) return 'al minuto';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
  }

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
    this.cargarCaosPendientes();
    this.cargarFrecuentes();
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
    encuestarVisible(60000, () => { this.cargarPendientes(true); this.cargarCaosPendientes(true); }, { destroyRef: this.destroyRef, zone: this.zone });
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
      this.cargarCaosPendientes(true);
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

  abrirApertura(): void { this.fondoInicial.set(0); this.abrirConFoco(this.aperturaAbierta); }

  abrirCorte(): void {
    if (this.abriendo()) return;
    this.abriendo.set(true);
    this.svc.abrirCorte({
      // `todayMx()`, no `toISOString()`: después de las 18:00 hora de México el segundo ya
      // devuelve MAÑANA, y el corte nacía con fecha de mañana.
      fecha: todayMx(),
      sucursal: this.sucursalActiva,
      fondo_inicial: this.fondoInicial(),
    }).subscribe({
      next: () => {
        this.abriendo.set(false);
        this.aperturaAbierta.set(false);
        this.avisarOk('Corte abierto', `Fondo inicial ${money(this.fondoInicial())}`);
        this.cargarSaldo(); this.cargarCortes();
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

  piezasCorteDe(d: number): number {
    return this.conteoCorte().find((x) => x.denominacion === d)?.piezas ?? 0;
  }

  /** Lo que suma ese renglón del corte. Se calcula; no hay dónde teclearlo. */
  subtotalCorteDe(d: number): number { return redondea(d * this.piezasCorteDe(d)); }

  setPiezasCorte(d: number, piezas: number): void {
    const list = this.conteoCorte().filter((x) => x.denominacion !== d);
    // Enteras y no negativas: medio billete no existe, y el CHECK del servidor lo rechaza.
    const n = Math.max(0, Math.trunc(Number(piezas) || 0));
    if (n > 0) list.push({ denominacion: d, piezas: n });
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
   * CS.3.9 — El buscador es UNIVERSAL: recarga el libro (realizados) Y la bandeja (por confirmar) con
   * el mismo término. Antes sólo tocaba el libro, así que buscar un cobro que todavía no se había
   * arqueado no devolvía nada aunque estuviera en «por confirmar».
   */
  buscar(): void {
    this.cargar();
    this.cargarPendientes();
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
    this.contadoBandeja.set(null);
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
  private tomarDocumento(c: MovimientoPendiente, contado?: number | null): void {
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
    // Lo contado en la bandeja no se tira: se guarda aparte y se muestra como referencia, para
    // que quien ya contó una vez no pierda ese trabajo al desglosarlo.
    this.montoContado.set(null);
    this.contadoBandeja.set(contado != null && Number(contado) > 0 ? Number(contado) : null);
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
   */
  capturarDesde(p: MovimientoPendiente): void {
    const contado = this.contadoDe(p.origen_ref);
    this.abrirCaptura();
    // El tipo sale del SIGNO del documento, no de lo que estuviera elegido antes.
    this.setF('tipo', (p.tipo === 'ingreso' ? 'ingreso' : 'gasto') as TipoMovimiento);
    this.cobroSel = { ...p, label: this.cobroLabel(p) };
    this.tomarDocumento(p, contado);
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
    this.contadoBandeja.set(null);
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
    this.contadoBandeja.set(null);
    this.montoContado.set(null);
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
   * CS.3.1c — Trae los movimientos de CAOS pendientes para mostrarlos SOLOS en la bandeja. Se pide
   * al cargar y en el repaso en vivo, igual que los de Kepler. Un fallo deja la sección vacía (no es
   * la fuente de verdad del libro), pero no tumba la pantalla.
   */
  cargarCaosPendientes(bg = false): void {
    if (!bg) this.cargandoCaosPend.set(true);
    this.svc.caosCapturables({ limit: 50 }).subscribe({
      next: (r) => { this.caosPendientes.set(r.rows ?? []); this.cargandoCaosPend.set(false); },
      error: () => { this.caosPendientes.set([]); this.cargandoCaosPend.set(false); },
    });
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
      // CS.3.9 — el buscador universal también filtra «por confirmar», no sólo el libro.
      search: this.search || undefined,
      limit: 100,
    }).subscribe({
      next: (r) => {
        this.pendientes.set(r.rows ?? []);
        this.confirmables.set(r.confirmables ?? 0);
        // Lo que el servidor dice que acotó, y si la lista viene topada. Los tres campos venían
        // en la respuesta desde el primer día y no se leía ninguno.
        this.ventanaSrv.set({ desde: r.desde, dias: r.ventana_dias ?? null });
        this.datosAl.set(r.datos_al ?? null);
        this.truncada.set(!!r.has_more);
        // Sólo se pinta si de verdad hay algo afuera: un "quedan 0 anteriores" es ruido.
        this.rezago.set(r.fuera_de_ventana && r.fuera_de_ventana.movimientos > 0 ? r.fuera_de_ventana : null);
        this.errPend.set(null);
        this.cargandoPend.set(false);
        // Lo tecleado que sobrevivio a un refresh. Va DESPUES de tener las filas: sin ellas no
        // se puede saber que conteos siguen aplicando.
        this.restaurarBorrador();
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

  contadoDe(ref: string): number | null { return this.contado().get(ref) ?? null; }

  /** Usuario para la clave del borrador. Sin él no se persiste: un conteo ajeno es peor que ninguno. */
  private get usuarioBorrador(): string {
    return String(this.auth.user()?.sub ?? '');
  }

  /** Se restaura UNA vez por visita: después, mandar lo que la persona tiene en pantalla. */
  private borradorRestaurado = false;
  /** Lo que se recuperó de un borrador, para poder DECIRLO. `null` = no había nada. */
  restaurado = signal<{ conteos: number; descartados: number; hace: string } | null>(null);

  /**
   * Recupera lo tecleado que sobrevivió a un refresh.
   *
   * ⚠️ Sólo se restaura lo que SIGUE pendiente. Un conteo cuya fila ya no está en la bandeja es
   * casi siempre un movimiento que otra persona confirmó mientras tanto; revivirlo en silencio
   * lo mandaría al lote para que el servidor lo rechace, o peor, lo aplicaría con un importe que
   * ya nadie está mirando. Lo que se descarta se DICE, no desaparece.
   */
  private restaurarBorrador(): void {
    if (this.borradorRestaurado) return;
    this.borradorRestaurado = true;
    const b = this.borrador.leer(this.usuarioBorrador);
    if (!b) return;

    const vivos = new Set(this.pendientes().map((p) => p.origen_ref));
    const m = new Map<string, number | null>();
    let descartados = 0;
    for (const [ref, v] of b.contado) {
      if (vivos.has(ref)) m.set(ref, v); else descartados++;
    }
    const s = new Set(b.marcadas.filter((r) => vivos.has(r)));
    // ⚠️ Acá había un `return` temprano cuando no quedaba nada que restaurar, y se comía el aviso
    // justo en el caso donde más importa: la persona contó, se fue, alguien confirmó, y al volver
    // su conteo ya no está. Callarse eso le deja creer que nunca lo tecleó. Lo encontró la prueba.
    if (!m.size && !s.size && !descartados) { this.borrador.borrar(this.usuarioBorrador); return; }
    if (!m.size && !s.size) this.borrador.borrar(this.usuarioBorrador);

    this.contado.set(m);
    this.seleccion.set(s);
    const min = Math.max(0, Math.floor((Date.now() - b.guardadoEn) / 60000));
    this.restaurado.set({
      conteos: m.size,
      descartados,
      hace: min < 2 ? 'recién' : min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h`,
    });
  }

  /**
   * Qué pasó con lo que estaba tecleado. Los dos casos se leen distinto a propósito:
   * recuperar es una buena noticia; que un conteo tuyo ya no aplique es un aviso.
   */
  textoRestaurado(b: { conteos: number; descartados: number; hace: string }): string {
    const n = (k: number, s: string) => `${k} ${s}${k === 1 ? '' : 's'}`;
    if (!b.conteos) {
      return `Tenías ${n(b.descartados, 'conteo')} sin confirmar (${b.hace}) y ya no aplican: `
        + 'esos movimientos salieron de la bandeja, casi siempre porque alguien más los confirmó.';
    }
    const base = `Se recuperaron ${n(b.conteos, 'conteo')} que tenías sin confirmar (${b.hace}).`;
    return b.descartados
      ? `${base} Otros ${n(b.descartados, 'conteo')} ya no aplican: esos movimientos salieron de la bandeja.`
      : base;
  }

  /** Tirar el borrador a propósito. Lo tecleado es de la persona: se descarta cuando ella quiere. */
  descartarBorrador(): void {
    this.contado.set(new Map());
    this.seleccion.set(new Set());
    this.borrador.borrar(this.usuarioBorrador);
    this.restaurado.set(null);
  }

  /** Persiste lo tecleado. Se llama en CADA cambio: perder el conteo es el defecto que esto arregla. */
  private persistir(): void {
    this.borrador.guardar(this.usuarioBorrador, this.contado(), this.seleccion());
  }

  setContado(ref: string, v: number | null): void {
    const m = new Map(this.contado());
    if (v == null || !(Number(v) > 0)) m.delete(ref); else m.set(ref, Number(v));
    this.contado.set(m);
    // Escribir un conteo implica que ese movimiento entra: evita el clic extra de marcarlo.
    // ⚠️ Sólo si es CONFIRMABLE. Ahora que se puede contar una fila trabada, marcarla la mandaría
    // al lote para que el servidor la rechace por no tener cuenta — ruido garantizado. Lo contado
    // en una fila trabada se usa al abrirla con «Capturar».
    const fila = this.pendientes().find((p) => p.origen_ref === ref);
    if (m.has(ref) && fila?.confirmable) this.marcar(ref, true);
    this.persistir();
  }

  confirmarLote(): void {
    const refs = this.marcadas();
    if (!refs.length || this.confirmando()) return;
    this.confirmando.set(true);
    this.svc.confirmarLote(refs.map((r) => ({ origen_ref: r, monto_contado: this.contadoDe(r) ?? undefined })))
      .subscribe({
        next: (r) => {
          this.resultado.set(r);
          this.confirmando.set(false);
          this.seleccion.set(new Set());
          this.contado.set(new Map());
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

  piezasDe(d: number): number {
    return this.f().denominaciones.find((x) => x.denominacion === d)?.piezas ?? 0;
  }

  /** Lo que suma ese renglón. Se CALCULA: no hay dónde teclearlo, y por eso va deshabilitado. */
  subtotalDe(d: number): number { return redondea(d * this.piezasDe(d)); }

  setPiezas(d: number, piezas: number): void {
    const list = this.f().denominaciones.filter((x) => x.denominacion !== d);
    // Enteras y no negativas: medio billete no existe, y el CHECK del servidor lo rechaza.
    const n = Math.max(0, Math.trunc(Number(piezas) || 0));
    if (n > 0) list.push({ denominacion: d, piezas: n });
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
    this.onMonto(sumaDesglose(this.denominacionesParaGuardar(), Number(this.f().morralla || 0)));
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
      denominaciones: this.denominacionesParaGuardar(),
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
