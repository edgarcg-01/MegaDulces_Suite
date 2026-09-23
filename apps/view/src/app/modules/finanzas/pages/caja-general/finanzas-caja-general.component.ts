import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
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
import { CashLedgerService, type ConceptoKepler, type MovimientoCaja, type AutofillResponse, type TipoMovimiento, type SaldoResponse, type CorteCaja, type TotalesCorte, type MovimientoPendiente, type CajaKepler, type ResumenLote, type Frecuente, type CoberturaResponse } from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import {
  DENOMINACIONES, estadoArqueo, motivosDeBloqueo, TEXTO_BLOQUEO, etiquetaProcedencia, etiquetaManual,
  textoCobertura, sumaDesglose, puedeAutorizarUI, puedeCerrarUI, textoSaldo, GLOSA_MIN,
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

    .fin-h2 { font-size:1rem; font-weight:700; margin:1.5rem 0 .5rem; }
    .fin-dim { color:var(--text-muted); font-size:.78rem; }
    .fin-empty { text-align:center; color:var(--text-muted); padding:1.25rem 0; }
    /* ⚠️ Acá decía "var(--danger-fg, #b42318)" y --danger-fg NO EXISTE en tokens.css: ganaba
       siempre el hex de fallback, que es un rojo de tema claro. O sea que en modo oscuro un
       faltante de caja se pintaba ilegible. El token de la casa es --bad-fg y sí flipea. */
    .fin-neg { color:var(--bad-fg); }
    .d-block { display:block; }

    /* Formulario de captura. fin-row-col apila cuando el campo necesita su propia explicación
       debajo (el selector de cobro de Kepler), en vez de meterla en la misma línea. */
    .fin-form { display:flex; flex-direction:column; gap:.85rem; }
    .fin-row { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; }
    .fin-row > label { min-width:6.5rem; font-size:.8rem; color:var(--text-muted); }
    .fin-row-col { flex-direction:column; align-items:stretch; gap:.35rem; }
    .fin-row-col > label { min-width:0; }
    .w-full { width:100%; }

    .fin-hint-ok   { color:var(--ok-fg); font-size:.78rem; }
    .fin-hint-warn { color:var(--warn-fg); font-size:.78rem; }

    .fin-details { border:1px solid var(--border-color); border-radius:var(--r-sm,6px); padding:.5rem .75rem; }
    .fin-details > summary { cursor:pointer; font-size:.82rem; }

    /* Reja de denominaciones: fija y ancha para que contar sea teclear en orden, no buscar. */
    .fin-denoms { display:grid; grid-template-columns:repeat(auto-fill, minmax(8.5rem, 1fr)); gap:.5rem; margin-top:.6rem; }
    .fin-denom { display:flex; align-items:center; justify-content:space-between; gap:.4rem;
                 border:1px solid var(--border-color); border-radius:var(--r-sm,6px); padding:.3rem .5rem; }
    .fin-denom .mono { font-variant-numeric:tabular-nums; font-size:.8rem; }

    /* Los motivos de bloqueo van TODOS juntos: que se vea de una vez lo que falta. */
    .fin-blocks { margin:.25rem 0 0; padding-left:1.1rem; color:var(--warn-fg); font-size:.8rem; }

    /* CG.20 - la bandeja de entregas. Densa, tipo Operations: la persona la recorre marcando. */
    .cg-bandeja { border:1px solid var(--border-color); border-radius:var(--r-md,8px);
                  padding:.75rem .9rem; margin:1rem 0; }
    .cg-bandeja-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:.6rem; margin-bottom:.5rem; }
    .cg-bandeja-head .fin-h2 { margin:0; }
    .cg-bandeja-sp { flex:1 1 auto; }
    .cg-tbl { width:100%; border-collapse:collapse; font-size:.82rem; }
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
    .cg-rezago { margin:.5rem 0 0; font-size:.78rem; }
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
               background:transparent; color:inherit; font:inherit; font-size:.78rem;
               padding:.3rem .7rem; min-height:2rem; }
    .cg-chip:hover { border-color:var(--action); color:var(--action); }
    .cg-chip:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .cg-chip-n { color:var(--text-muted); font-variant-numeric:tabular-nums; font-size:.72rem; }

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
                    <input pInputText type="number" class="cg-contado"
                           [ngModel]="contadoDe(p.origen_ref)"
                           (ngModelChange)="setContado(p.origen_ref, $event)"
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

      <div class="fin-filters">
        <input pInputText type="date" [(ngModel)]="from" (ngModelChange)="cargar()" aria-label="Desde" />
        <input pInputText type="date" [(ngModel)]="to" (ngModelChange)="cargar()" aria-label="Hasta" />
        <p-select [options]="tiposFiltro" [(ngModel)]="tipo" (ngModelChange)="cargar()"
                  optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true"></p-select>
        <input pInputText [(ngModel)]="search" (keyup.enter)="cargar()" placeholder="Folio, glosa o beneficiario" />
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
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8" class="fin-empty">Sin movimientos en el periodo.</td></tr>
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

    <p-dialog [visible]="capturaAbierta()" (visibleChange)="capturaAbierta.set($event)"
              [modal]="true" [style]="{ width: '46rem', maxWidth: '96vw' }"
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
                Tomado de Kepler: {{ c.doc_tipo }} {{ c.folio }} ·
                {{ c.beneficiario || c.entidad_code }} · {{ money(c.monto) }}
                @if (c.caja_nombre) { · {{ c.caja_nombre }} }.
                El importe lo pone el documento; si contaste distinto, cambiá el monto.
              </small>
              <!-- La diferencia se DICE antes de guardar. Que el servidor levante el hallazgo no
                   sirve si la persona no supo que estaba registrando un descuadre. -->
              @if (montoContado(); as mc) {
                <small class="fin-hint-warn">
                  Contaste {{ money(mc) }} y el documento dice {{ money(c.monto) }}:
                  <strong>{{ money(mc - c.monto) }}</strong> de diferencia. Se registra lo que
                  contaste —el efectivo no se rechaza— y queda un hallazgo con la diferencia.
                </small>
              }
            } @else {
              <small class="fin-dim">
                Sin documento elegido: esto se registra como captura manual y queda marcado así en
                la cobertura. Está bien — cerca de la mitad del ingreso todavía no tiene documento
                en el ERP —, pero si el movimiento ya está en Kepler, elegirlo hace que el importe
                lo ponga el documento y no el teclado.
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
                          optionLabel="label" [delay]="250" [minQueryLength]="2" [showClear]="true"
                          placeholder="Buscá por nombre, cuenta o código" appendTo="body"
                          class="cg-full"></p-autocomplete>
          <small [class]="etiquetaConcepto().tono === 'propuesto' ? 'fin-hint-ok' : 'fin-hint-warn'">
            {{ etiquetaConcepto().texto }}
          </small>
        </div>

        <div class="fin-row">
          <label for="cg-glosa">Qué pasó</label>
          <input pInputText id="cg-glosa" [ngModel]="f().glosa" (ngModelChange)="onGlosa($event)" class="cg-full"
                 placeholder="Contá qué pasó — esto NO es el concepto contable" />
        </div>

        <div class="fin-row">
          <label for="cg-monto">Monto</label>
          <!-- ⛔ Esto era "[readonly]="!!cobroElegido()"" con el motivo "el servidor lo ignora
               igual y toma el del documento". Eso YA NO ES CIERTO: el backend resuelve el importe
               con "monto_contado", un campo propio que MANDA sobre el del ERP. Dejarlo de sólo
               lectura hacía imposible **arquear** un movimiento anclado — que es justo el caso que
               importa: el documento dice una cifra y en la caja hay otra. Ahora se edita, y la
               pantalla marca abajo que el importe salió de un conteo y no del documento.
               No se rechaza efectivo: se acepta lo contado y el servidor levanta el hallazgo. -->
          <p-inputnumber inputId="cg-monto" [ngModel]="f().monto" (ngModelChange)="onMonto($event)"
                         mode="currency" currency="MXN" locale="es-MX" />
          <label for="cg-morralla">Morralla</label>
          <p-inputnumber inputId="cg-morralla" [ngModel]="f().morralla" (ngModelChange)="setF('morralla', $event)"
                         mode="currency" currency="MXN" locale="es-MX" />
        </div>

        <details class="fin-details">
          <summary>Desglose por denominación (opcional) — {{ textoArqueo() }}</summary>
          <div class="fin-denoms">
            @for (d of denominaciones; track d) {
              <label class="fin-denom">
                <span class="mono">{{ money(d) }}</span>
                <p-inputnumber [ngModel]="piezasDe(d)" (ngModelChange)="setPiezas(d, $event)" [min]="0" />
              </label>
            }
          </div>
        </details>

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
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="capturaAbierta.set(false)"></p-button>
        <p-button label="Guardar" icon="pi pi-check" size="small"
                  [disabled]="bloqueos().length > 0 || guardando()" (onClick)="guardar()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="aperturaAbierta()" (visibleChange)="aperturaAbierta.set($event)"
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
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="aperturaAbierta.set(false)"></p-button>
        <!-- Sin bandera de ocupado, el doble clic abría DOS cortes. -->
        <p-button label="Abrir" icon="pi pi-check" size="small"
                  [disabled]="abriendo()" (onClick)="abrirCorte()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="cierreAbierto()" (visibleChange)="cierreAbierto.set($event)"
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
        <div class="fin-denoms">
          @for (d of denominaciones; track d) {
            <label class="fin-denom">
              <span class="mono">{{ money(d) }}</span>
              <p-inputnumber [ngModel]="piezasCorteDe(d)" (ngModelChange)="setPiezasCorte(d, $event)" [min]="0" />
            </label>
          }
        </div>
        <div class="fin-row">
          <label for="cg-morralla-corte">Morralla</label>
          <p-inputnumber inputId="cg-morralla-corte" [ngModel]="morrallaCorte()" (ngModelChange)="morrallaCorte.set($event)"
                         mode="currency" currency="MXN" locale="es-MX" />
        </div>
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
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cierreAbierto.set(false)"></p-button>
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
export class FinanzasCajaGeneralComponent implements OnInit {
  private svc = inject(CashLedgerService);
  private auth = inject(AuthService);
  private toast = inject(MessageService);

  readonly money = money;
  readonly dmy = dmy;
  readonly denominaciones = DENOMINACIONES;

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
  bloqueos = computed<MotivoBloqueo[]>(() => motivosDeBloqueo(this.f()));
  /**
   * De dónde salió el concepto. Ahora depende TAMBIÉN de si se eligió a mano: antes sólo leía
   * `propuesta()`, así que después de elegir en el buscador seguía diciendo "Propuesto de la
   * sesión — 12 antecedentes" sobre algo tecleado. La etiqueta existe justamente para separar
   * propuesto de tecleado; diciendo lo contrario era peor que no estar.
   */
  etiquetaConcepto = computed(() => {
    // El signal se lee PRIMERO e incondicional: un `&&` que corte antes dejaría al computed sin
    // dependencias, que es la misma familia de bug que tenía `bloqueos`.
    const manual = this.conceptoManual();
    if (manual) return etiquetaManual();
    return etiquetaProcedencia(this.propuesta()?.concepto);
  });
  /** `true` en cuanto la persona elige o teclea el concepto ella misma. */
  conceptoManual = signal(false);

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
    this.cargarFrecuentes();
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

  abrirApertura(): void { this.fondoInicial.set(0); this.aperturaAbierta.set(true); }

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
    this.cierreAbierto.set(true);
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

  setPiezasCorte(d: number, piezas: number): void {
    const list = this.conteoCorte().filter((x) => x.denominacion !== d);
    if (Number(piezas) > 0) list.push({ denominacion: d, piezas: Number(piezas) });
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
      glosa: '', beneficiario: '', monto: null, morralla: 0,
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

  abrirCaptura(): void {
    this.f.set(this.formVacio());
    this.conceptoSel = null;
    this.conceptoManual.set(false);
    this.propuesta.set(null);
    // El cobro elegido NO sobrevive al diálogo anterior: arrastrarlo aplicaría el documento de
    // una entrega a otra, que es justo el error que el índice único frena del lado del servidor.
    this.cobroSel = null;
    this.cobroElegido.set(null);
    this.montoContado.set(null);
    this.cobros.set([]);
    this.capturaAbierta.set(true);
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
    this.cobroElegido.set(c);
    // El conteo viaja aparte, en su propio campo: es lo que el servidor necesita para distinguir
    // "conté distinto" de "el front mandó mal el importe".
    const hayConteo = contado != null && Number(contado) > 0;
    this.montoContado.set(hayConteo ? Number(contado) : null);
    this.f.update((v) => ({
      ...v,
      // Si la persona ya contó en la bandeja, MANDA lo contado: nunca se rechaza efectivo. Sin
      // conteo, el importe lo pone el documento. `monto` es siempre el importe RESUELTO, que es
      // contra el que tiene que cuadrar el desglose por denominación.
      monto: hayConteo ? Number(contado) : Number(c.monto),
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
      // El desglose viejo dejaría de cuadrar contra el monto nuevo: se limpia y se vuelve a contar.
      denominaciones: [],
    }));
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
  }

  /** Soltar el cobro devuelve el formulario a captura manual, sin arrastrar el monto del ERP. */
  soltarCobro(): void {
    this.cobroElegido.set(null);
    this.montoContado.set(null);
    this.f.update((v) => ({ ...v, monto: null, denominaciones: [] }));
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

  cargarPendientes(): void {
    this.cargandoPend.set(true);
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
  }

  /** Marca sólo las CONFIRMABLES: ofrecer marcar una trabada es prometer algo que va a fallar. */
  marcarTodas(on: boolean): void {
    this.seleccion.set(on
      ? new Set(this.pendientes().filter((p) => p.confirmable).map((p) => p.origen_ref))
      : new Set());
  }

  contadoDe(ref: string): number | null { return this.contado().get(ref) ?? null; }

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

  setPiezas(d: number, piezas: number): void {
    const list = this.f().denominaciones.filter((x) => x.denominacion !== d);
    if (Number(piezas) > 0) list.push({ denominacion: d, piezas: Number(piezas) });
    this.f.update((v) => ({ ...v, denominaciones: list }));
  }

  textoArqueo(): string {
    const f = this.f();
    const r = estadoArqueo(Number(f.monto), f.denominaciones, Number(f.morralla || 0));
    if (r.estado === 'sin_desglose') return 'sin contar';
    if (r.estado === 'cuadra') return `cuadra: ${money(r.desglosado)}`;
    return `NO cuadra: ${money(r.desglosado)} (${r.diferencia > 0 ? 'sobran' : 'faltan'} ${money(Math.abs(r.diferencia))})`;
  }

  textoBloqueo(b: MotivoBloqueo): string { return TEXTO_BLOQUEO[b]; }

  sevTipo(t: string): 'success' | 'danger' | 'info' {
    return t === 'ingreso' ? 'success' : t === 'gasto' ? 'danger' : 'info';
  }

  guardar(): void {
    if (this.bloqueos().length || this.guardando()) return;
    this.guardando.set(true);
    const cobro = this.cobroElegido();
    const f = this.f();
    this.svc.crear({
      ...f,
      // ⭐ CG.19 — la llave del documento de Kepler. Con esto el servidor RELEE el monto del ERP y
      // descarta el del formulario, y el índice único impide que el mismo documento entre dos veces.
      // ⛔ Acá estaba clavado en 'cobro'. Con CG.21 el diálogo puede anclar TAMBIÉN un pago, y un
      // `X-D-26` guardado como 'cobro' es un origen mal etiquetado: el backend decide si relee el
      // importe del ERP con `ORIGEN_ANCLADO = ['cobro','pago_proveedor']`, y el CHECK admite los
      // dos. La fila ya trae su propio `origen_tipo` (la vista lo emite por signo) — se usa ése,
      // igual que hace el lote; el fallback por signo es sólo por si la vista no lo mandara.
      origen_tipo: cobro ? (cobro.origen_tipo || (cobro.tipo === 'ingreso' ? 'cobro' : 'pago_proveedor')) : null,
      origen_ref: cobro ? cobro.origen_ref : null,
      // ⭐ Lo CONTADO, en su campo propio. Sin esto el servidor relee el importe del documento y
      // descarta el conteo: la diferencia llegaba al hallazgo pero NO al libro, o sea que la caja
      // guardaba lo que decía Kepler y el efectivo de más (o de menos) se evaporaba. El backend ya
      // tenía `monto_contado` resuelto; lo que faltaba era que la pantalla lo mandara.
      monto_contado: this.montoContado() ?? undefined,
      // La procedencia viaja con el movimiento: qué campo propuso el motor y con qué respaldo.
      autofill: this.propuesta()?.provenance ?? null,
      client_uuid: this.nuevoUuid(),
    }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.capturaAbierta.set(false);
        this.avisarOk('Movimiento registrado', `${this.etiquetaTipo(f.tipo)} por ${money(f.monto)}`);
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
  private nuevoUuid(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}
