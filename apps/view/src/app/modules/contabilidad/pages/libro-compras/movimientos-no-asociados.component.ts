import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import type { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { RadioButtonModule } from 'primeng/radiobutton';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';
import { LibroComprasService, MesNoAsociado, MesDetalle, FacturaMes, ImpuestosModo, FacturaRespaldo, MovimientoRespaldo, CoberturaUuid, SugerenciasCuenta } from '../../libro-compras.service';
import { exportXlsx } from '../../../../shared/export/xlsx-export';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { SelectModule } from 'primeng/select';
import { MOTIVOS_EXCLUSION, PreparacionMes } from '../../libro-compras.service';
import type { Freshness } from '@megadulces/contracts';
import { LIBRO_COMPRAS_STYLES, NO_ASOCIADOS_STYLES } from './libro-compras.styles';

/**
 * Los cuatro grupos en que cae una factura del mes. Son excluyentes y cubren el total, así
 * que los chips se leen como un desglose y no como filtros sueltos. (El conteo del chip
 * "Entran al TXT" es el de las marcadas, no el del grupo — ver `chips`.)
 *
 * Coinciden por construcción con el `entran` del rail y con `resumen.incluidas`: los tres
 * salen de `con cuenta AND NOT ya en póliza AND NOT cancelada AND con historial`. Si alguna
 * vez divergen, es que el backend cambió una de las dos definiciones y no la otra.
 *
 * `sin_historial` (LC.18): con cuenta y sin postear, pero el proveedor no entró al libro en
 * los últimos 6 meses. Medido: ~115 facturas al mes así nunca entraron al libro manual, y
 * nada en el CFDI las distingue — por eso no entran solas y se juzgan acá.
 */
type Grupo = 'entran' | 'sin_historial' | 'sin_cuenta' | 'revisar' | 'ya_libro';

/** LC.18 — lo que agrega esta fase. Vive aca y no en libro-compras.styles para no tocar la hoja
 *  compartida con la pantalla del libro completo. (Sin acentos graves: es un template literal.) */
const LC18_STYLES = `
.na-ctas-imp { font-size: var(--fs-xs); }
.na-dlg-prov { display: inline; margin-right: .35rem; color: var(--text-main); }
.na-sug { list-style: none; margin: 0 0 .9rem; padding: 0; display: grid; gap: .45rem; }
.na-sug li { display: flex; align-items: baseline; gap: .5rem; font-size: var(--fs-sm); }
.na-sug label { cursor: pointer; }
.na-sug .mono { font-family: var(--font-mono); }
.na-link-sutil { margin-left: .35rem; font-size: var(--fs-xs); color: var(--text-muted); }
.na-fresc { display: inline-flex; gap: .6rem; align-items: center; }
.na-prep { display: flex; align-items: center; gap: .45rem; margin: -.25rem 0 .75rem; font-size: var(--fs-sm); }
.na-motivo { margin-top: .2rem; }
.na-sat { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem; margin: -.25rem 0 .75rem; font-size: var(--fs-sm); }
`;

/**
 * Fase LC (ADR-052) — Movimientos no asociados.
 *
 * Es el propósito del módulo: sacar en TXT **lo que ContPAQi no tiene atado a ninguna
 * póliza**, para que contabilidad lo suba y cierre el trámite. No es el libro del mes
 * completo (eso es la otra pantalla, y solo aplica a un mes que nunca se subió).
 *
 * Dos cosas que la pantalla tiene que dejar claras porque cuestan dinero:
 *   1. **Cuánto falta**, por mes. Ago-2026 son 724 facturas por $48.2M sin contabilizar.
 *   2. **Qué NO hay que volver a mandar**: 271 facturas de 2026 por $32.6M no tienen marca
 *      de asociación pero su importe YA está en la póliza del mes. Pasa porque nuestro
 *      propio TXT no lleva UUID. Van marcadas y excluidas; incluirlas duplica el asiento.
 *
 * Layout de sector Fiscal/Contable (DESIGN §14): master-detail permanente + answer-first.
 */
@Component({
  selector: 'app-movimientos-no-asociados',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, DialogModule,
    SelectButtonModule, CheckboxModule, InputTextModule, ToastModule, TooltipModule, RadioButtonModule,
    FreshnessPillComponent, SelectModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Los dos por separado, no concatenados con `${}`: ver la nota en `libro-compras.styles.ts`.
  styles: [LIBRO_COMPRAS_STYLES, NO_ASOCIADOS_STYLES, LC18_STYLES],
  template: `
    <p-toast />

    <header class="lc-head">
      <div>
        <h1>Movimientos no asociados</h1>
        <!-- Una linea, no dos: el parrafo se envolvia y ocupaba alto arriba de todo para
             decir algo que la pestana ya dice. Quien sube el archivo es proceso conocido. -->
        <p class="muted">Las facturas que ContPAQi no tiene ligadas a ninguna póliza.</p>
      </div>
      <!-- Componente p-button, NO la directiva con label/icon: en PrimeNG 22 la directiva
           pButton ya no tiene esos inputs, sólo props de estilo (text, outlined, severity,
           size, loading). Angular ignora los atributos sobrantes en un button nativo y el
           botón sale VACÍO: se veía como una pastilla naranja sin texto. Con la directiva
           habría que proyectar el contenido a mano.
           (Y ojo: nada de acentos graves en estos comentarios, que van dentro del template
           literal del decorador y lo cortan a la mitad.) -->
      <p-button type="button" icon="pi pi-refresh" styleClass="p-button-text"
                (click)="cargarMeses()" [loading]="cargandoMeses()"
                ariaLabel="Recargar los meses" />
    </header>

    <div class="lc-layout">
      <!-- ── Master: los meses, ordenados por lo que falta ─────────────────── -->
      <aside class="lc-meses" aria-label="Meses con movimientos sin asociar">
        @if (cargandoMeses()) {
          @for (i of [1,2,3,4,5,6]; track i) { <div class="lc-mes-skel"></div> }
        } @else if (!meses().length) {
          <div class="lc-empty">
            <i class="pi pi-inbox"></i>
            <p>No hay CFDIs recibidos cargados todavía.</p>
            <small class="muted">El feed del ADD de ContPAQi los trae; revisa que esté corriendo.</small>
          </div>
        } @else {
          @for (a of anios(); track a.anio) {
          <!-- Agrupado por ano: el rail pide 24 meses y son ~5rem cada uno, o sea tres
               pantallas de scroll propio para llegar al ano pasado. El ano en curso queda
               abierto y los demas se piden. El encabezado lleva el pendiente del ano, asi
               que un ano cerrado con trabajo adentro no se puede confundir con uno limpio. -->
          <div class="na-anio">
            <button type="button" class="na-anio-cab" [class.abierto]="abierto(a.anio)"
                    [attr.aria-expanded]="abierto(a.anio)" (click)="alternarAnio(a.anio)">
              <i class="pi" [class.pi-chevron-down]="abierto(a.anio)"
                 [class.pi-chevron-right]="!abierto(a.anio)" aria-hidden="true"></i>
              <span class="na-anio-n">{{ a.anio }}</span>
              @if (a.entran) {
                <span class="na-anio-pend">{{ a.entran }} por entregar</span>
              } @else {
                <span class="na-anio-pend cero">al día</span>
              }
            </button>
          @if (abierto(a.anio)) {
          @for (m of a.meses; track m.anio_mes) {
            <button type="button" class="lc-mes" [class.sel]="mesSel() === m.anio_mes"
                    [attr.aria-current]="mesSel() === m.anio_mes" (click)="abrirMes(m.anio_mes)">
              <div class="lc-mes-top">
                <span class="lc-mes-nombre">{{ nombreMes(m.anio_mes) }}</span>
                <!-- Punto + texto, NO pastilla llena: son 105 meses en el rail y 105
                     pastillas de color le compiten a la única acción naranja de la pantalla.
                     El estado del mes es orientación, no alarma. -->
                <span class="na-estado" [class]="'e-' + severidadEstado(m)">
                  <i class="na-dot" aria-hidden="true"></i>{{ etiquetaEstado(m) }}
                </span>
              </div>
              <!-- La tarjeta muestra lo ACCIONABLE (lo que entra al TXT), el mismo número
                   que el encabezado del detalle. Mostrar aquí el total sin asociar y allá
                   el que entra hacía que el mismo mes se leyera con dos cifras distintas,
                   las dos rotuladas "por asociar". -->
              <div class="lc-mes-cifras">
                <span class="na-falta" [class.cero]="!m.entran">
                  {{ m.entran ? m.entran + ' entran al TXT' : 'nada que entregar' }}
                </span>
                @if (m.entran) {
                  <span class="mono">{{ m.monto_entran | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                }
              </div>
              @if (!m.existe_libro && m.cfdis) {
                <span class="na-mes-sinlibro">El mes no tiene póliza de compras</span>
              }
              @if (m.ya_posteados || m.fuera_catalogo) {
                <span class="na-mes-nota">
                  @if (m.ya_posteados) { {{ m.ya_posteados }} ya posteadas }
                  @if (m.ya_posteados && m.fuera_catalogo) { · }
                  @if (m.fuera_catalogo) { {{ m.fuera_catalogo }} de gasto }
                </span>
              }
            </button>
          }
          }
          </div>
          }
        }
      </aside>

      <!-- ── Detail ────────────────────────────────────────────────────────── -->
      <section class="lc-detalle">
        @if (!mesSel()) {
          <div class="lc-empty lc-empty-lg">
            <i class="pi pi-link"></i>
            <p>Elige un mes para ver qué facturas quedaron sin asociar.</p>
          </div>
        } @else if (cargandoMes()) {
          <div class="lc-skel-bloque"></div>
        } @else if (detalle(); as d) {
          <div class="lc-veredicto" [class]="'v-' + veredicto().tono">
            <i [class]="veredicto().icono"></i>
            <div>
              <strong>{{ veredicto().titulo }}</strong>
              <span class="muted">{{ veredicto().detalle }}</span>
            </div>
            <div class="lc-acciones">
              @if (puedeGestionar()) {
                <p-button type="button" label="Generar TXT" icon="pi pi-file-export"
                          [disabled]="!!d.bloqueantes.length || !d.resumen.incluidas || generando() || estadoRun() === 'entregado' || estadoRun() === 'aplicado'"
                          [loading]="generando()" (click)="generar()" />
                <!-- LC.17: los tres botones del archivo sólo si el archivo guardado SIRVE. El de
                     jul-2026 tenía el formato viejo y se descargaba igual; el de jun-2026 tenía
                     la firma sin el contenido y los botones daban 404. -->
                @if (archivoVigente()) {
                  <!-- LC.19.6: lo que se sube a ContPAQi son los tres archivos; un clic los baja
                       todos. Los tres botones sueltos se quedan para cuando sólo hace falta uno. -->
                  <p-button type="button" label="Descargar todo" icon="pi pi-download"
                            [loading]="bajandoTodo()" (click)="descargarTodo()" />
                  <p-button type="button" label="Descargar TXT" icon="pi pi-download"
                            styleClass="p-button-outlined p-button-secondary" (click)="descargar()" />
                  <!-- A ContPAQi va el TXT Y su respaldo: nadie sube millones a la
                       contabilidad de la empresa desde un archivo de longitud fija que no
                       puede leer. Esta hoja es la que reemplaza al Excel manual. -->
                  <p-button type="button" label="Respaldo en Excel" icon="pi pi-file-excel"
                            styleClass="p-button-outlined p-button-secondary"
                            [loading]="bajandoRespaldo()" (click)="exportarRespaldo()" />
                  <!-- El TXT no lleva campo de UUID: sin este listado ContPAQi contabiliza
                       la factura y nadie la asocia, el flag se queda en false, y el
                       anti-duplicado vuelve a depender del cruce por importe. -->
                  <p-button type="button" label="CSV del asociador" icon="pi pi-link"
                            styleClass="p-button-text p-button-secondary"
                            pTooltip="Listado movimiento ↔ UUID para el Asociador de CFDI de ContPAQi"
                            (click)="descargarAsociador()" />
                }
                <!-- LC.19.6: «Marcar entregado» ya no es un paso. Aplicado se marca solo cuando la
                     poliza de ContPAQi casa renglon por renglon con el archivo; el boton queda
                     para cuando casa a medias (alguien la edito al importar), y el servidor lo
                     rechaza si ContPAQi todavia no tiene el folio. -->
                @if ((estadoRun() === 'generado' && archivoVigente()) || estadoRun() === 'entregado') {
                  <p-button type="button" label="Marcar aplicado" icon="pi pi-check-circle"
                            styleClass="p-button-text p-button-secondary" (click)="marcar('aplicado')" />
                }
                @if (estadoRun() === 'entregado') {
                  <!-- La salida cuando ContPAQi rechazó el archivo: sin ella, el error de
                       generar decía "cancélala" y no había dónde. Destructiva: rojo y con
                       confirmación, nunca un clic suelto. -->
                  <p-button type="button" label="Cancelar entrega" icon="pi pi-times"
                            styleClass="p-button-text p-button-danger" (click)="dlgCancelar.set(true)" />
                }
              }
            </div>
          </div>
          <!-- LC.19.6: lo que el mes esta haciendo solo, en una linea. Sin cron: arranca al abrirlo. -->
          @if (preparando(); as p) {
            <p class="na-prep muted"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> {{ p }}</p>
          }

          <!-- La tira de 5 mosaicos vivía acá y se fue al PIE de la tabla (LC.16.3). Cuatro
               de los cinco eran los totales de cuatro columnas de la tabla, y el quinto
               repetía el número que ya dice el veredicto tres renglones arriba. Al pie,
               alineados bajo su columna, se leen como el asiento que son: 0% + c/IVA + IEPS
               + IVA = total. Y ahí sirven — cuando estás en el renglón 400 de agosto
               revisando, arriba no hay ningún total a la vista. -->

          <!-- Los BLOQUEANTES nunca se colapsan: son lo que impide generar el archivo, o
               sea la razon por la que el boton de arriba esta apagado. Esconderlos detras
               de un click dejaria un boton muerto sin explicacion a la vista. -->
          @if (d.bloqueantes.length) {
            <ul class="lc-avisos lc-bloq" aria-label="Lo que impide generar">
              @for (a of d.bloqueantes; track a) { <li><i class="pi pi-times-circle"></i>{{ a }}</li> }
            </ul>
            <!-- LC.19.1: la salida del bloqueo del SAT esta junto al bloqueo, no en otro lado.
                 No hay override: lo que el SAT no encuentre se desmarca. -->
            @if (puedeGestionar() && (d.resumen.sin_verificar_sat ?? 0) > 0 && !preparando()) {
              <div class="na-sat">
                <p-button type="button" label="Verificar en el SAT" icon="pi pi-shield"
                          styleClass="p-button-outlined p-button-secondary"
                          [loading]="verificandoSat()" [disabled]="verificandoSat()" (click)="verificarSat()" />
                <span class="muted">
                  @if (progresoSat(); as p) { {{ p }} }
                  @else { Consulta cada factura en el servicio público del SAT (~4 por segundo). Lo que no aparezca vigente no entra al TXT. }
                </span>
              </div>
            }
          }

          <!-- Cobertura + lo que queda fuera + avisos del mes eran cuatro bloques apilados
               que se comian ~30% del alto antes de la primera factura. Van en un solo
               renglon que se abre. Nada se pierde: el conteo dice que hay algo adentro. -->
          @if (cuantasNotas() > 0) {
            <details class="na-notas">
              <summary>
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                {{ cuantasNotas() }} {{ cuantasNotas() === 1 ? 'nota' : 'notas' }} sobre este mes
                <span class="muted">— cobertura del anti-duplicado, lo que queda fuera, avisos</span>
              </summary>
              <div class="na-notas-cuerpo">
                <!-- El límite del anti-duplicado exacto. Si el histórico no está cargado la
                     puerta por UUID no cubre nada, y un no-op se lee igual que "no hay
                     duplicados" — el modo de falla que dejó analytics.customer_receivables
                     en prod como tabla vacía durante meses. -->
                @if (cobertura(); as cob) {
                  <p class="na-cobertura" [class.vacia]="!cob.cargado">
                    <i [class]="cob.cargado ? 'pi pi-shield' : 'pi pi-exclamation-triangle'"></i>
                    @if (cob.cargado) {
                      Anti-duplicado <strong>exacto por UUID</strong> hasta <strong>{{ cob.cubre_hasta }}</strong>
                      ({{ cob.uuids | number }} facturas del libro histórico).
                      De ahí en adelante el control es por importe, que tiene falsos positivos.
                    } @else {
                      <strong>El histórico por UUID no está cargado</strong>: el anti-duplicado
                      sólo compara importes. Corre <code>import-purchase-book-history.js --apply</code>.
                    }
                  </p>
                }

                @if (contexto().length) {
                  <p class="na-contexto">
                    <span class="muted">Queda fuera del TXT:</span>
                    @for (c of contexto(); track c.texto; let last = $last) {
                      <span [class.warn]="c.tono === 'warn'">
                        {{ c.texto }}@if (c.monto) { <span class="mono"> ({{ c.monto | currency:'MXN':'symbol-narrow':'1.0-0' }})</span> }
                      </span>@if (!last) { <span class="muted"> · </span> }
                    }
                  </p>
                }

                @if (d.avisos.length) {
                  <ul class="lc-avisos lc-info" aria-label="Cosas que vale la pena revisar">
                    @for (a of d.avisos; track a) { <li><i class="pi pi-info-circle"></i>{{ a }}</li> }
                  </ul>
                }
              </div>
            </details>
          }

          <div class="lc-opciones">
            <label>
              <span class="muted">Impuestos</span>
              <p-selectbutton [options]="opcImpuestos" [(ngModel)]="impuestosModo" optionLabel="label"
                              optionValue="value" [allowEmpty]="false" aria-label="Cómo postear IVA e IEPS" />
            </label>
            <label class="lc-chk">
              <p-checkbox [(ngModel)]="incluirUuid" [binary]="true" inputId="na-uuid" />
              <span for="na-uuid">Poner el UUID en cada renglón</span>
            </label>
            <span class="lc-cuadre">
              @if (puedeGestionar() && estadoRun() !== 'aplicado' && estadoRun() !== 'entregado') {
                <button type="button" class="na-caratula" (click)="abrirCaratula()"
                        title="Cambiar con qué folio y concepto entra la póliza">
                  Póliza {{ folioPoliza() }} del Diario
                  <i class="pi pi-pencil"></i>
                </button>
              } @else {
                <span>Póliza {{ folioPoliza() }} del Diario</span>
              }
              · {{ d.resumen.incluidas }} facturas
            </span>
            <!-- LC.18: las cuentas de impuesto ya no son fijas. Salen del ultimo libro, y en
                 sep-2026 cambiaron: decir de donde salieron es lo que deja revisarlas. -->
            <!-- LC.19.2: la edad de las dos fuentes, medida por el latido de su carril (dato, no
                 hora de carga). Sin medicion se declara sin medir, no se esconde. -->
            <span class="na-fresc">
              @for (fi of fuentesFrescura(); track fi.label) {
                <app-freshness-pill measures="data" [freshness]="fi.f" [label]="fi.label" />
              }
            </span>
            @if (d.cuentas_impuesto; as ci) {
              <span class="muted na-ctas-imp">
                IVA a {{ ci.iva.cuenta }} · IEPS a {{ ci.ieps.cuenta }}
                @if (ci.desde) { (como el libro de {{ nombreMes(ci.desde) }}) } @else { (las de siempre: no hay libro previo) }
              </span>
            }
          </div>

          <!-- El trabajo de la contadora no es toda la tabla: en ago-2026 son 725 renglones
               y 214 de ellos no puede tocarlos. Sin chips ni buscador tenia que scrollear
               a mano para encontrar un proveedor. Arranca en "Entran al TXT" — lo
               accionable — y el resto lo pide si lo quiere ver. -->
          <div class="na-filtros">
            <div class="na-chips" role="group" aria-label="Filtrar la tabla">
              @for (c of chips(); track c.key) {
                <button type="button" class="na-chip" [class.on]="filtro() === c.key"
                        [class.vacio]="!c.n" [disabled]="!c.n && c.key !== 'todas'"
                        [attr.aria-pressed]="filtro() === c.key" (click)="filtro.set(c.key)">
                  {{ c.label }}<span class="na-chip-n">{{ c.n }}</span>
                </button>
              }
            </div>
            <span class="na-buscar">
              <i class="pi pi-search" aria-hidden="true"></i>
              <input pInputText [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                     placeholder="Proveedor, RFC o folio" aria-label="Buscar en la tabla" />
              @if (busqueda()) {
                <button type="button" class="na-buscar-x" (click)="busqueda.set('')"
                        aria-label="Limpiar la busqueda"><i class="pi pi-times"></i></button>
              }
            </span>
          </div>

          <div class="lc-tablewrap">
            <!-- El scroll interno se QUEDA, contra lo que decia el plan. Con el preambulo
                 colapsado (LC.16.6) la pagina ya casi no scrollea, asi que este deja de ser
                 un scroll anidado en la practica — y es lo que mantiene clavados el
                 encabezado y el pie de totales, que es justo lo que se necesita en el
                 renglon 400 de agosto. Sube a 58vh porque arriba se libero alto. -->
            <p-table [value]="filtradas()" styleClass="p-datatable-sm" [rowHover]="true"
                     [scrollable]="true" scrollHeight="58vh" [paginator]="filtradas().length > 100"
                     [rows]="100" dataKey="uuid">
              <ng-template #header>
                <tr>
                  <th class="c-chk"><span class="sr-only">Seleccionar</span></th>
                  <th>Proveedor</th>
                  <th class="c-num">Folio</th>
                  <th class="c-num">Fecha</th>
                  <th class="c-num">Exento</th>
                  <th class="c-num">Gravado 16%</th>
                  <th class="c-num">IEPS 8%</th>
                  <th class="c-num">IVA</th>
                  <th class="c-num">Total</th>
                  <!-- Estaban en una sola columna rotulada "Estado" cuyo valor mas comun
                       (52% en sept, 70% en ago) era un numero de cuenta — y un numero de
                       cuenta no es un estado. Cuenta es dato, Estado es juicio. -->
                  <th class="c-cta">Cuenta</th>
                  <th class="c-cta">Estado</th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <!-- La clase dup es SÓLO la sospecha por importe (ámbar = hay que juzgarla).
                     La certeza exacta lleva su propia clase, neutra: antes las dos caían en
                     dup y encima exacta le pintaba el filo en rojo.
                     (Nada de acentos graves en estos comentarios: van dentro del template
                     literal del decorador y lo cortan a la mitad. Ya pasó tres veces.) -->
                <tr [class.excluida]="!f.incluida"
                    [class.dup]="f.prueba_certeza === 'por_importe'"
                    [class.exacta]="f.prueba_certeza === 'exacta'">
                  <td class="c-chk">
                    <!-- Con prueba EXACTA el checkbox se apaga: es el mismo folio fiscal, no
                         hay nada que juzgar. Con sospecha por importe queda habilitado —
                         el cruce tiene falsos positivos por diseño y quien lleva el libro
                         es quien sabe. -->
                    <p-checkbox [ngModel]="f.incluida" [binary]="true"
                                [disabled]="!puedeGestionar() || f.prueba_certeza === 'exacta' || f.estatus_sat === 'cancelado'"
                                (ngModelChange)="alternar(f, $event)"
                                [ariaLabel]="'Incluir ' + f.emisor_nombre" />
                  </td>
                  <td>
                    <span class="lc-prov">{{ f.emisor_nombre }}</span>
                    <small class="muted mono">{{ f.emisor_rfc }}</small>
                    @if (f.ieps_no_acreditable > 0.004) {
                      <!-- LC.18: el IEPS que no es al 8 % se queda en el costo, como en el libro
                           manual. Se marca porque es una decision contable, no un dato. -->
                      <p-tag [value]="'IEPS al costo ' + (f.ieps_no_acreditable | currency:'MXN':'symbol-narrow':'1.2-2')"
                             severity="secondary" [rounded]="true" />
                    }
                    @if (!f.incluida && f.motivo_exclusion) {
                      <small class="muted">Excluida: {{ f.motivo_exclusion }}</small>
                    } @else if (!f.incluida && puedeGestionar() && f.cuenta_existe && f.en_libro_reciente && !f.prueba_certeza) {
                      <!-- LC.19.6: la regla de que entra no se puede derivar de los datos (74 % de las
                           extras son de proveedores con unas facturas dentro y otras fuera). Lo que se
                           puede es juntar el POR QUE de la contadora en una lista cerrada para medirlo
                           despues. Opcional: excluir sigue siendo un solo clic. -->
                      <div class="na-motivo">
                        <p-select [options]="motivosExclusion" optionLabel="label" optionValue="value" [ngModel]="null" (ngModelChange)="elegirMotivo(f, $event)"
                                  placeholder="¿Por qué no va?" size="small"
                                  [ariaLabel]="'Por qué no va la factura de ' + f.emisor_nombre" appendTo="body" />
                      </div>
                    }
                  </td>
                  <td class="c-num mono">{{ f.folio }}</td>
                  <!-- El backend manda 'YYYY-MM-DD' pelado. Angular parsea las fechas ISO
                       SIN marca de zona con setFullYear local, o sea no corre el dia. Si
                       alguna vez el backend manda un timestamp completo, el pipe pasa a
                       UTC y vuelve el bug de restar un dia: mandar solo la fecha. -->
                  <td class="c-num mono">{{ f.fecha | date:'dd/MM/yy' }}</td>
                  <!-- Guion en vez de $0.00: medido en prod, 51-55% de las celdas de
                       impuesto van en cero, o sea la MITAD de la tinta numerica de la tabla
                       eran ceros con el mismo peso que un importe real. Las dos columnas de
                       base NO se funden a proposito: son las dos cuentas del asiento (501 al
                       0% y 502 gravado), y fundirlas esconderia la distincion sobre la que
                       esta armado el TXT. -->
                  <td class="c-num mono">
                    @if (f.base_exenta > 0.004) { {{ f.base_exenta | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else { <span class="na-cero">—</span> }
                  </td>
                  <td class="c-num mono">
                    @if (f.subtotal16 > 0.004) { {{ f.subtotal16 | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else { <span class="na-cero">—</span> }
                  </td>
                  <td class="c-num mono">
                    @if (f.ieps > 0.004) { {{ f.ieps | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else { <span class="na-cero">—</span> }
                  </td>
                  <td class="c-num mono">
                    @if (f.iva > 0.004) { {{ f.iva | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else { <span class="na-cero">—</span> }
                  </td>
                  <td class="c-num mono strong">{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-cta mono muted">{{ f.cuenta_proveedor ?? '—' }}</td>
                  <!-- El ROJO dice una sola cosa: esto impide generar el TXT.
                       Medido en prod antes de cambiarlo: en jul-2026 el 58% de la tabla
                       estaba en rojo y el 62% de esos rojos eran "Ya en el libro", o sea
                       "listo, no lo toques". Si más de la mitad grita, nada grita. -->
                  <td class="c-cta">
                    @if (f.estatus_sat === 'cancelado') {
                      <p-tag value="Cancelada en el SAT" severity="danger" />
                    } @else if (f.prueba_certeza === 'exacta') {
                      <!-- Camino feliz: mismo folio fiscal, asunto cerrado. Se apaga, no se
                           marca. Sigue visible porque esconderlo haría creer que el mes
                           tiene menos de lo que tiene. -->
                      <span class="na-listo" [pTooltip]="f.prueba_detalle ?? ''">
                        <i class="pi pi-check" aria-hidden="true"></i>Ya en el libro
                      </span>
                    } @else if (f.prueba_certeza === 'por_importe') {
                      <p-tag value="Importe ya posteado" severity="warn" [pTooltip]="f.prueba_detalle ?? ''" />
                    } @else if (!f.account_suffix) {
                      <!-- LC.18: cada mes llegan proveedores nuevos. Sin esta salida la factura
                           quedaba fuera para siempre: el mapa no se podia tocar desde ningun lado. -->
                      <!-- LC.18 (e2e): en oct-2026 eran 262 sin cuenta, casi todas de GASTO, y todas
                           ofrecian Asignar igual. Ahora la accion se destaca solo donde ContPAQi
                           tiene una 212 libre con el mismo nombre; en las demas queda discreta.
                           Y ya no es rojo: excluida, no impide generar. -->
                      @if (puedeGestionar() && f.cuenta_sugerida) {
                        <button type="button" class="na-link" (click)="abrirAsignar(f)">
                          <i class="pi pi-link" aria-hidden="true"></i> Asignar {{ f.cuenta_sugerida.cuenta }}
                        </button>
                      } @else {
                        <span class="na-cero">Sin cuenta</span>
                        @if (puedeGestionar()) {
                          <button type="button" class="na-link na-link-sutil" (click)="abrirAsignar(f)">asignar</button>
                        }
                      }
                    } @else if (!f.cuenta_existe) {
                      <p-tag value="Cuenta inexistente" severity="danger" />
                    } @else if (!f.en_libro_reciente) {
                      <!-- El porque va en el renglon (motivo de exclusion), no en un tooltip. -->
                      <p-tag value="Sin libro reciente" severity="secondary" />
                    } @else if (f.incluida && f.estatus_sat !== 'vigente') {
                      <!-- LC.19.1: tenue, no ambar. El bloqueo ya grita arriba con su monto; si los
                           275 renglones de octubre fueran ambar, nada en la tabla se leeria. -->
                      <span class="na-cero">SAT sin verificar</span>
                    } @else {
                      <span class="na-cero">—</span>
                    }
                  </td>
                </tr>
              </ng-template>

              <!-- El desglose que estaba arriba en 5 mosaicos, alineado bajo su columna y
                   pegado al fondo del scroll. Suma lo que estas VIENDO (filtro + busqueda),
                   asi que filtrar a "Sin cuenta" te dice cuanto dinero esta trabado. Por eso
                   la primera celda dice cual filtro esta puesto: sin eso, el pie se leeria
                   como "lo que va al TXT" estando en cualquier otro grupo. -->
              <ng-template #footer>
                <tr class="na-tot">
                  <td class="c-chk"></td>
                  <td>{{ etiquetaFiltro() }} <span class="muted">· {{ totales().n }} facturas</span></td>
                  <td class="c-num"></td>
                  <td class="c-num"></td>
                  <td class="c-num mono">{{ totales().exento | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono">{{ totales().gravado | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono">{{ totales().ieps | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono">{{ totales().iva | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono strong">{{ totales().total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-cta"></td>
                  <td class="c-cta"></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="11">
                  <div class="lc-empty">
                    <!-- Vacío por el filtro y vacío de verdad NO son lo mismo: decir "no
                         tiene movimientos sin asociar" con un filtro puesto es mentira. -->
                    @if (busqueda() || filtro() !== 'todas') {
                      <i class="pi pi-filter-slash"></i>
                      <p>Nada coincide con el filtro.</p>
                      <small class="muted">
                        El mes tiene {{ d.facturas.length }} facturas sin asociar — toca
                        <button type="button" class="na-link" (click)="verTodas()">Todas</button>
                        para verlas.
                      </small>
                    } @else {
                      <i class="pi pi-check-circle"></i>
                      <p>{{ nombreMes(mesSel()!) }} no tiene movimientos sin asociar.</p>
                      <small class="muted">Todas sus facturas ya están ligadas a una póliza.</small>
                    }
                  </div>
                </td></tr>
              </ng-template>
            </p-table>
          </div>
        }
      </section>
    </div>

    <p-dialog header="Marcar como entregado" [(visible)]="dlgEntregaVisible" [modal]="true" [style]="{ width: '26rem' }">
      <label class="lc-campo">
        <span>¿A quién se le entregó?</span>
        <input pInputText [(ngModel)]="entregadoA" placeholder="Nombre de quien lo sube a ContPAQi" />
      </label>
      <ng-template #footer>
        <p-button type="button" label="Cancelar" styleClass="p-button-text" (click)="dlgEntrega.set(false)" />
        <p-button type="button" label="Confirmar" (click)="marcar('entregado')" />
      </ng-template>
    </p-dialog>

    <!-- LC.18: la cuenta 212 de un proveedor nuevo. El servidor rechaza una cuenta que no
         exista en ContPAQi o que ya sea de otro RFC: aca solo se elige. -->
    <p-dialog header="Asignar cuenta de proveedor" [(visible)]="dlgAsignarVisible" [modal]="true" [style]="{ width: '34rem' }">
      @if (asignarPara(); as a) {
        <p class="na-dlg-nota">
          <strong class="na-dlg-prov">{{ a.emisor_nombre }}</strong>
          <span class="mono">{{ a.emisor_rfc }}</span> no está en el mapa de cuentas del libro.
          Elige su cuenta 212 de ContPAQi; la 501 y la 502 salen del mismo número.
        </p>
        @if (cargandoSug()) {
          <p class="muted">Buscando cuentas parecidas…</p>
        } @else if (sugerencias(); as s) {
          @if (s.candidatas.length) {
            <ul class="na-sug" aria-label="Cuentas candidatas">
              @for (c of s.candidatas; track c.cuenta) {
                <li>
                  <p-radiobutton name="na-sug" [value]="c.cuenta" [(ngModel)]="cuentaElegida"
                                 [disabled]="!!c.asignada_a" [inputId]="'na-sug-' + c.cuenta" />
                  <label [for]="'na-sug-' + c.cuenta">
                    <span class="mono">{{ c.cuenta }}</span> {{ c.nombre }}
                    <small class="muted">· {{ c.razon }}@if (c.asignada_a) { · ya es del RFC {{ c.asignada_a }}}</small>
                  </label>
                </li>
              }
            </ul>
          } @else {
            <p class="muted">No hay ninguna cuenta 212 con un nombre parecido. Si es un proveedor de compras, dale de alta su cuenta en ContPAQi y escríbela abajo.</p>
          }
        }
        <label class="lc-campo">
          <span>Cuenta 212</span>
          <input pInputText [(ngModel)]="cuentaElegida" placeholder="2120000000" inputmode="numeric" maxlength="10" />
        </label>
        <p class="na-dlg-aviso">Si es de gasto o servicio, no le asignes cuenta: no va al libro de compras.</p>
      }
      <ng-template #footer>
        <p-button type="button" label="Cancelar" styleClass="p-button-text" (click)="dlgAsignar.set(false)" />
        <p-button type="button" label="Asignar" [loading]="asignando()"
                  [disabled]="!cuentaValida() || asignando()" (click)="asignar()" />
      </ng-template>
    </p-dialog>

    <!-- LC.18: incluir algo cuyo importe ya esta posteado exige decir por que. El servidor lo
         pedia desde LC.14 y la pantalla no tenia donde escribirlo. -->
    <p-dialog header="Incluir facturas con importe ya posteado" [(visible)]="dlgForzarVisible" [modal]="true" [style]="{ width: '30rem' }">
      <p class="na-dlg-nota">
        {{ sospechosasIncluidas() }} factura(s) marcadas tienen un importe igual a algo que ya está en una
        póliza del mes. Si de verdad son otras facturas, explica por qué: el motivo queda guardado en la corrida.
      </p>
      <label class="lc-campo">
        <span>Motivo</span>
        <input pInputText [(ngModel)]="motivoForzar" placeholder="Ej. son dos facturas distintas del mismo monto" />
      </label>
      <ng-template #footer>
        <p-button type="button" label="Volver" styleClass="p-button-text" (click)="dlgForzar.set(false)" />
        <p-button type="button" label="Generar de todos modos" [disabled]="!motivoForzar.trim() || generando()"
                  (click)="generar(true)" />
      </ng-template>
    </p-dialog>

    <p-dialog header="Cancelar la entrega" [(visible)]="dlgCancelarVisible" [modal]="true" [style]="{ width: '28rem' }">
      <p class="na-dlg-nota">
        Úsalo sólo si ContPAQi <strong>rechazó</strong> el archivo o nunca se subió. Las facturas
        vuelven a quedar pendientes y podrás generar un archivo nuevo.
      </p>
      <label class="lc-campo">
        <span>¿Por qué se cancela?</span>
        <input pInputText [(ngModel)]="motivoCancelar" placeholder="Ej. ContPAQi rechazó el archivo" />
      </label>
      <p class="na-dlg-aviso">
        Si ContPAQi ya tiene la póliza en el folio {{ folioPoliza() }}, no se cancela: se marca aplicado.
      </p>
      <ng-template #footer>
        <p-button type="button" label="Volver" styleClass="p-button-text" (click)="dlgCancelar.set(false)" />
        <p-button type="button" label="Cancelar entrega" severity="danger"
                  [disabled]="!motivoCancelar.trim()" (click)="marcar('cancelado')" />
      </ng-template>
    </p-dialog>

    <p-dialog header="Carátula de la póliza" [(visible)]="dlgCaratulaVisible" [modal]="true" [style]="{ width: '30rem' }">
      <p class="na-dlg-nota">
        Con qué folio y concepto entra la póliza en ContPAQi. El folio 1 del Diario es
        siempre el registro de compras del mes; el complemento va en el 2.
        @if (!existeLibroDelMes()) {
          <strong>Este mes no tiene póliza de compras, así que lo que falta ES el libro: ponlo en folio 1.</strong>
        }
      </p>
      <label class="lc-campo">
        <span>Folio de la póliza</span>
        <input pInputText type="number" min="1" [(ngModel)]="caratulaFolio" />
      </label>
      <label class="lc-campo">
        <span>Concepto</span>
        <input pInputText [(ngModel)]="caratulaConcepto" placeholder="REGISTRO DE COMPRAS DEL MES" />
      </label>
      <p class="na-dlg-aviso">
        Si ya hay un archivo generado, cambiar esto lo invalida y hay que volver a generarlo.
      </p>
      <ng-template #footer>
        <p-button type="button" label="Cancelar" styleClass="p-button-text" (click)="dlgCaratula.set(false)" />
        <p-button type="button" label="Guardar" [loading]="guardandoCaratula()" (click)="guardarCaratula()" />
      </ng-template>
    </p-dialog>
  `,
})
export class MovimientosNoAsociadosComponent implements OnInit {
  private svc = inject(LibroComprasService);
  private toast = inject(MessageService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly opcImpuestos = [
    { label: 'Un renglón al mes', value: 'global' as ImpuestosModo },
    { label: 'Por proveedor', value: 'por-cuenta' as ImpuestosModo },
  ];

  meses = signal<MesNoAsociado[]>([]);
  detalle = signal<MesDetalle | null>(null);
  mesSel = signal<string | null>(null);
  filtro = signal<Grupo | 'todas'>('entran');
  busqueda = signal('');
  cargandoMeses = signal(false);
  cargandoMes = signal(false);
  generando = signal(false);
  /** LC.19.1: la verificación ante el SAT corre por lotes; esto dice en cuál va. */
  verificandoSat = signal(false);
  progresoSat = signal<string | null>(null);
  /** LC.19.6: lo que el mes está haciendo solo (null = nada en curso). */
  preparando = signal<string | null>(null);
  bajandoTodo = signal(false);
  readonly motivosExclusion = MOTIVOS_EXCLUSION.map((m) => ({ label: m, value: m }));
  /** Meses ya preparados en esta visita: reabrir el mes tras prepararlo no lo vuelve a disparar. */
  private preparados = new Set<string>();
  private rePreparar: ReturnType<typeof setTimeout> | null = null;
  dlgEntrega = signal(false);
  dlgCaratula = signal(false);
  guardandoCaratula = signal(false);
  bajandoRespaldo = signal(false);
  cobertura = signal<CoberturaUuid | null>(null);
  impuestosModo: ImpuestosModo = 'global';
  incluirUuid = true;
  entregadoA = '';
  caratulaFolio: number | null = null;
  caratulaConcepto = '';

  get dlgEntregaVisible() { return this.dlgEntrega(); }
  set dlgEntregaVisible(v: boolean) { this.dlgEntrega.set(v); }
  get dlgCaratulaVisible() { return this.dlgCaratula(); }
  set dlgCaratulaVisible(v: boolean) { this.dlgCaratula.set(v); }
  dlgCancelar = signal(false);
  get dlgCancelarVisible() { return this.dlgCancelar(); }
  set dlgCancelarVisible(v: boolean) { this.dlgCancelar.set(v); }
  motivoCancelar = '';

  // LC.18 — proveedor nuevo
  dlgAsignar = signal(false);
  get dlgAsignarVisible() { return this.dlgAsignar(); }
  set dlgAsignarVisible(v: boolean) { this.dlgAsignar.set(v); }
  asignarPara = signal<FacturaMes | null>(null);
  sugerencias = signal<SugerenciasCuenta | null>(null);
  cargandoSug = signal(false);
  asignando = signal(false);
  cuentaElegida = '';

  // LC.18 — incluir lo que casa por importe, con motivo
  dlgForzar = signal(false);
  get dlgForzarVisible() { return this.dlgForzar(); }
  set dlgForzarVisible(v: boolean) { this.dlgForzar.set(v); }
  motivoForzar = '';
  sospechosasIncluidas = computed(() =>
    (this.detalle()?.facturas ?? []).filter((f) => f.incluida && f.prueba_certeza === 'por_importe').length);

  /** B5: la carga del mes en curso. Se cancela al pedir otro mes, o la respuesta vieja pisa la nueva. */
  private cargaMes: Subscription | null = null;

  /**
   * El rail agrupado por año. El año más reciente arranca abierto y los demás se piden:
   * son 24 meses de ~5rem cada uno, o sea tres pantallas de scroll propio para llegar al
   * año pasado. El encabezado del año lleva su pendiente, para que un año cerrado con
   * trabajo adentro no se pueda confundir con uno limpio.
   */
  anios = computed(() => {
    const grupos = new Map<string, MesNoAsociado[]>();
    for (const m of this.meses()) {
      const y = m.anio_mes.slice(0, 4);
      const g = grupos.get(y);
      if (g) g.push(m); else grupos.set(y, [m]);
    }
    return [...grupos.entries()].map(([anio, meses]) => ({
      anio, meses,
      entran: meses.reduce((a, m) => a + m.entran, 0),
    }));
  });

  /** Años cerrados a mano. Vacío = sólo el más reciente abierto (ver `abierto`). */
  private aniosCerrados = signal<ReadonlySet<string>>(new Set());
  private aniosAbiertos = signal<ReadonlySet<string>>(new Set());

  abierto(anio: string) {
    if (this.aniosCerrados().has(anio)) return false;
    if (this.aniosAbiertos().has(anio)) return true;
    // Por default sólo el más reciente, y siempre el año del mes que estés viendo — si
    // llegaste por la URL con ?mes=2025-03 el rail tiene que mostrarte dónde estás parada.
    const sel = this.mesSel()?.slice(0, 4);
    return anio === this.anios()[0]?.anio || anio === sel;
  }

  alternarAnio(anio: string) {
    const abrir = !this.abierto(anio);
    const cerr = new Set(this.aniosCerrados());
    const abre = new Set(this.aniosAbiertos());
    if (abrir) { cerr.delete(anio); abre.add(anio); } else { abre.delete(anio); cerr.add(anio); }
    this.aniosCerrados.set(cerr);
    this.aniosAbiertos.set(abre);
  }

  /** Si ContPAQi ya tiene la póliza de compras del mes. Si no, lo que falta ES el libro. */
  existeLibroDelMes = computed(() => {
    const mes = this.mesSel();
    return this.meses().find((m) => m.anio_mes === mes)?.existe_libro === true;
  });

  puedeGestionar = computed(() => {
    const u = this.auth.user();
    return u?.permissions?.[Permission.FISCAL_PURCHASE_BOOK_GESTIONAR] === true
      || u?.role_name === 'admin' || u?.role_name === 'superadmin';
  });

  estadoRun = computed(() => (this.detalle()?.run?.['estado'] as string) ?? 'sin_iniciar');
  // LC.18 (e2e): sin corrida, el folio que el servidor va a usar — el del rail (1 si ContPAQi no
  // tiene el libro del mes). Caer a un 2 fijo decía «Póliza 2» y el archivo salía en folio 1.
  folioPoliza = computed(() => {
    const d = this.detalle();
    const delRail = this.meses().find((m) => m.anio_mes === d?.mes)?.folio_poliza;
    return Number(d?.run?.['folio_poliza'] ?? delRail ?? 2);
  });
  /** LC.17 — el servidor dice si el archivo GUARDADO se puede entregar, y si no, por qué. */
  archivoVigente = computed(() => this.detalle()?.run?.['archivo_vigente'] === true);
  archivoMotivo = computed(() => (this.detalle()?.run?.['archivo_motivo'] as string | null) ?? null);

  /**
   * El desglose del asiento, al pie de la tabla y bajo su propia columna:
   * `0% + c/IVA + IEPS + IVA = Total`. Cuadra a la vista, de izquierda a derecha.
   *
   * Suma lo FILTRADO, no lo incluido: así "Sin cuenta" contesta cuánto dinero está trabado
   * y "Ya en el libro" cuánto no hay que volver a mandar. Cuál está puesto lo dice la
   * primera celda del pie — un total sin su alcance es una cifra que miente.
   */
  totales = computed(() => {
    const fs = this.filtradas();
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const suma = (get: (f: FacturaMes) => number) => r2(fs.reduce((a, f) => a + get(f), 0));
    return {
      n: fs.length,
      exento: suma((f) => f.base_exenta),
      gravado: suma((f) => f.subtotal16),
      ieps: suma((f) => f.ieps),
      iva: suma((f) => f.iva),
      total: suma((f) => f.total),
    };
  });

  etiquetaFiltro = computed(() => {
    const g = this.filtro();
    const chip = this.chips().find((c) => c.key === g);
    const base = chip?.label ?? 'Todas';
    return this.busqueda().trim() ? `${base}, filtrado` : base;
  });

  /**
   * En qué grupo cae la factura, para los chips y el filtro.
   *
   * Por ELEGIBILIDAD, no por el checkbox: si el grupo dependiera de `incluida`, destildar
   * una fila la haría desaparecer de la lista que estás mirando y habría que cambiar de
   * filtro para volver a marcarla. El checkbox dice si entra; el grupo dice qué clase de
   * renglón es.
   *
   * El orden importa: "ya está en el libro" gana sobre "no tiene cuenta", porque si ya
   * está posteada su cuenta da igual — no es un bloqueante.
   */
  private grupo(f: FacturaMes): Grupo {
    if (f.prueba_certeza === 'exacta') return 'ya_libro';
    if (f.estatus_sat === 'cancelado' || f.prueba_certeza === 'por_importe') return 'revisar';
    if (!f.account_suffix || !f.cuenta_existe) return 'sin_cuenta';
    if (!f.en_libro_reciente) return 'sin_historial';
    return 'entran';
  }

  /** Sin acentos y en minúsculas: en el catálogo conviven "PEÑA" y "PENA". Con
   *  \p{Diacritic} y no con un rango de combinantes literales, que en el editor son
   *  caracteres invisibles y cualquiera los borra sin darse cuenta. */
  private norm(s: string) {
    return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  }

  filtradas = computed<FacturaMes[]>(() => {
    const d = this.detalle();
    if (!d) return [];
    const g = this.filtro();
    const q = this.norm(this.busqueda().trim());
    return d.facturas.filter((f) => {
      if (g !== 'todas' && this.grupo(f) !== g) return false;
      if (!q) return true;
      return this.norm(`${f.emisor_nombre} ${f.emisor_rfc} ${f.serie ?? ''} ${f.folio ?? ''}`).includes(q);
    });
  });

  /** Los chips SIEMPRE se muestran, aunque vayan en cero: un cero dice "no hay canceladas",
   *  y un chip que aparece y desaparece hace saltar la fila de filtros. En cero va apagado
   *  y no se puede tocar, para no meterte a una lista vacía.
   *
   *  El conteo de "Entran al TXT" cuenta las MARCADAS, no las elegibles. Los otros tres
   *  cuentan su grupo entero. Es a propósito y es la única asimetría: el número rotulado
   *  "entran al TXT" tiene que ser el que entra al archivo — si excluís tres a mano, tiene
   *  que bajar a 479. Las tres siguen visibles en la lista, destildadas. */
  chips = computed(() => {
    const d = this.detalle();
    const n: Record<Grupo, number> = { entran: 0, sin_historial: 0, sin_cuenta: 0, revisar: 0, ya_libro: 0 };
    for (const f of d?.facturas ?? []) {
      const g = this.grupo(f);
      if (g !== 'entran') n[g]++;
      // LC.18: TODAS las marcadas, de cualquier grupo. Una «sin libro reciente» que se marca a
      // mano entra al archivo, y este número tiene que ser el del archivo (= resumen.incluidas).
      if (f.incluida) n.entran++;
    }
    return [
      { key: 'entran' as const, label: 'Entran al TXT', n: n.entran },
      { key: 'sin_historial' as const, label: 'Sin libro reciente', n: n.sin_historial },
      { key: 'sin_cuenta' as const, label: 'Sin cuenta', n: n.sin_cuenta },
      { key: 'revisar' as const, label: 'Revisar', n: n.revisar },
      { key: 'ya_libro' as const, label: 'Ya en el libro', n: n.ya_libro },
      { key: 'todas' as const, label: 'Todas', n: d?.facturas.length ?? 0 },
    ];
  });

  verTodas() {
    this.filtro.set('todas');
    this.busqueda.set('');
  }

  /** Cuántas cosas hay dentro del renglón colapsado. Va en el resumen para que se sepa que
   *  hay algo adentro sin tener que abrirlo — un acordeón sin conteo se lee como vacío. */
  cuantasNotas = computed(() =>
    (this.cobertura() ? 1 : 0) + this.contexto().length + (this.detalle()?.avisos.length ?? 0));

  /** Lo que queda FUERA del TXT, con su razón. Es control, no acción. */
  contexto = computed(() => {
    const d = this.detalle();
    if (!d) return [];
    const r = d.resumen;
    const out: { texto: string; monto: number; tono: string }[] = [];
    if (r.ya_posteadas) {
      out.push({ texto: `${r.ya_posteadas} ya están en la póliza del mes`, monto: r.monto_ya_posteadas, tono: 'warn' });
    }
    // LC.18: se cuentan por grupo y no por resta. Antes «lo que no entra» = todo lo demás, y
    // con el grupo «sin libro reciente» la resta llamaba «gasto o servicio» a facturas de
    // proveedores de compras.
    const suma = (fs: FacturaMes[]) => fs.reduce((a, f) => a + f.total, 0);
    const sinHist = d.facturas.filter((f) => this.grupo(f) === 'sin_historial' && !f.incluida);
    if (sinHist.length) {
      out.push({ texto: `${sinHist.length} de proveedores sin libro reciente, por revisar`, monto: suma(sinHist), tono: 'warn' });
    }
    const sinCta = d.facturas.filter((f) => this.grupo(f) === 'sin_cuenta');
    if (sinCta.length) {
      out.push({ texto: `${sinCta.length} sin cuenta de proveedor (gasto o servicio, o proveedor nuevo)`, monto: suma(sinCta), tono: 'muted' });
    }
    return out;
  });

  /** El veredicto del mes en una línea, antes de la tabla (DESIGN §15 answer-first). */
  /**
   * LC.19.2 — Una píldora por fuente (CFDIs, pólizas), cada una con SU veredicto del servidor.
   * Si el servidor no pudo medir nada (`inputs` vacío) va una sola, que dice «sin medir».
   */
  fuentesFrescura = computed((): { label: string; f: Freshness }[] => {
    const fr = this.detalle()?.frescura;
    if (!fr) return [];
    if (!fr.inputs.length) return [{ label: 'fuentes', f: fr }];
    return fr.inputs.map((i) => ({
      label: i.key === 'cfdis' ? 'CFDIs' : i.key === 'polizas' ? 'pólizas' : i.label,
      f: { data_as_of: i.at, status: i.status, stale: i.stale, age_human: i.age_human, inputs: [i] },
    }));
  });

  veredicto = computed(() => {
    const d = this.detalle();
    if (!d) return { tono: 'neutral', icono: 'pi pi-circle', titulo: '', detalle: '' };
    const estado = this.estadoRun();
    const r = d.resumen;
    if (estado === 'aplicado') {
      return { tono: 'ok', icono: 'pi pi-check-circle', titulo: 'Póliza aplicada',
        detalle: 'Lo que faltaba de este mes ya está en ContPAQi.' };
    }
    if (!r.cfdis_del_mes) {
      // LC.19.2: un cero con el feed de CFDIs parado no es «al día», es «sin datos». Con el feed
      // muerto, este verde era indistinguible de un mes limpio.
      const fc = d.frescura?.inputs.find((i) => i.key === 'cfdis');
      if (!fc || fc.status !== 'fresh') {
        return { tono: 'warn', icono: 'pi pi-exclamation-triangle', titulo: 'Sin facturas por asociar, pero sin datos al día',
          detalle: fc?.at
            ? `Los CFDIs del ADD no se actualizan desde hace ${fc.age_human}: el cero puede ser falta de datos.`
            : 'No se pudo medir cuándo se actualizaron los CFDIs del ADD: el cero no se puede afirmar.' };
      }
      return { tono: 'ok', icono: 'pi pi-check-circle', titulo: 'Nada pendiente',
        detalle: 'Todas las facturas del mes están ligadas a una póliza.' };
    }
    if (d.bloqueantes.length) {
      return { tono: 'bad', icono: 'pi pi-exclamation-circle', titulo: 'No se puede generar todavía',
        detalle: 'Hay facturas que ContPAQi rechazaría. Resuélvelas o exclúyelas.' };
    }
    if (estado === 'entregado') {
      return { tono: 'warn', icono: 'pi pi-send', titulo: 'Entregado, falta confirmar',
        detalle: 'Cuando aparezca la póliza en ContPAQi, márcalo aplicado.' };
    }
    // LC.17: un "Archivo generado" que ContPAQi rechaza es una afirmación falsa.
    if (estado === 'generado' && !this.archivoVigente()) {
      return { tono: 'bad', icono: 'pi pi-exclamation-circle', titulo: 'El archivo guardado ya no sirve',
        // El motivo del servidor ya termina en «hay que generarlo de nuevo»: no se repite.
        detalle: this.mayuscula(this.archivoMotivo() ?? 'no se puede entregar: hay que generarlo de nuevo') + '.' };
    }
    if (estado === 'generado') {
      return { tono: 'warn', icono: 'pi pi-file-check', titulo: 'Archivo generado',
        detalle: 'Descárgalo y pásalo a quien lo sube a ContPAQi.' };
    }
    if (!r.incluidas) {
      return { tono: 'warn', icono: 'pi pi-info-circle', titulo: 'Nada que entregar',
        detalle: `Las ${r.cfdis_del_mes} sin asociar son de proveedores fuera del catálogo de compras o ya están posteadas.` };
    }
    // LC.19.3: decía «Faltan N por asociar — $X sin contabilizar», como si las N fueran un hecho.
    // No lo son: entran por una REGLA (proveedor con cuenta que salió en el libro de los últimos
    // 6 meses), y medido sobre jul/ago/sep entre 46 y 65 al mes nunca entraron al libro manual.
    // Se dice qué es (una propuesta), por qué entra, y cuánto quedó fuera esperando revisión.
    const sh = this.sinHistorial();
    return { tono: 'bad', icono: 'pi pi-exclamation-triangle',
      titulo: `${r.incluidas} facturas sin asociar propuestas para el TXT · ${this.money(r.total)}`,
      detalle: 'Entran porque el proveedor tiene cuenta y salió en el libro de los últimos 6 meses: revísalas antes de generar.'
        + (sh.n ? ` Otras ${sh.n} (${this.money(sh.monto)}) esperan revisión en «Sin libro reciente».` : '') };
  });

  /** LC.19.3: las que la regla del historial dejó fuera — el banner las nombra con su monto. */
  sinHistorial = computed(() => {
    const fs = (this.detalle()?.facturas ?? []).filter((f) => this.grupo(f) === 'sin_historial');
    return { n: fs.length, monto: fs.reduce((a, f) => a + f.total, 0) };
  });

  ngOnInit() {
    this.cargarMeses();
    // Best-effort: si el endpoint no responde, el renglón simplemente no sale — pero un
    // error acá NO debe tumbar la pantalla.
    this.svc.coberturaUuid().subscribe({
      next: (c) => this.cobertura.set(c),
      error: () => this.cobertura.set(null),
    });
    const mes = this.route.snapshot.queryParamMap.get('mes');
    if (mes) this.abrirMes(mes);
  }

  private money(n: number) {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
  }

  nombreMes(anioMes: string) {
    const [y, m] = anioMes.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, 1)));
  }

  etiquetaEstado(m: MesNoAsociado) {
    // LC.18 (e2e): una entrega cancelada deja el mes PENDIENTE otra vez. Decir «Cancelado» en
    // rojo se leia como un error del mes, cuando lo que hay que hacer es volver a generar.
    if (m.estado === 'sin_iniciar' || m.estado === 'cancelado') return m.faltan ? 'Pendiente' : 'Al día';
    return { borrador: 'Borrador', generado: 'Generado', entregado: 'Entregado', aplicado: 'Aplicado' }[m.estado] ?? m.estado;
  }

  severidadEstado(m: MesNoAsociado): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    if (m.estado === 'aplicado') return 'success';
    if (m.estado === 'entregado' || m.estado === 'generado') return 'warn';
    if (!m.faltan) return 'success';
    // Un mes sin póliza de compras no es un pendiente más: es el mes entero sin contabilizar.
    return m.existe_libro ? 'warn' : 'danger';
  }

  cargarMeses() {
    this.cargandoMeses.set(true);
    this.svc.listNoAsociados().subscribe({
      next: (r) => { this.meses.set(r); this.cargandoMeses.set(false); },
      error: (e) => { this.cargandoMeses.set(false); this.error('No se pudieron cargar los meses', e); },
    });
  }

  abrirMes(mes: string) {
    this.mesSel.set(mes);
    this.cargandoMes.set(true);
    // El filtro y la búsqueda se reinician al cambiar de mes: arrastrar "Sin cuenta" de
    // agosto a septiembre haría que el mes nuevo se vea vacío sin razón visible.
    this.filtro.set('entran');
    this.busqueda.set('');
    // El mes queda en la URL para poder compartir la vista (DESIGN §10).
    this.router.navigate([], { relativeTo: this.route, queryParams: { mes }, replaceUrl: true });
    // B5 (LC.18): si el mes es OTRO, se limpia la tabla — si la carga falla, no puede quedar
    // a la vista la del mes anterior bajo el título del nuevo. Y se cancela la carga en curso:
    // con clics rápidos la respuesta vieja llegaba después y la inclusión se escribía en otro mes.
    if (this.detalle()?.mes !== mes) this.detalle.set(null);
    this.cargaMes?.unsubscribe();
    this.cargaMes = this.svc.getNoAsociados(mes).subscribe({
      next: (d) => {
        if (this.mesSel() !== mes) return;
        this.detalle.set(d);
        this.impuestosModo = (d.run?.['impuestos_modo'] as ImpuestosModo) ?? 'global';
        // LC.18 (e2e): la opción de un archivo YA generado se respeta; la de un borrador no —
        // su valor era el default de la columna (false) y desmarcaba el UUID sin que nadie lo
        // pidiera. Así salió el TXT de oct-2026 sin UUID.
        // Una cancelada tampoco cuenta: oct-2026 quedó cancelada con incluye_uuid = false.
        const conArchivo = ['generado', 'entregado', 'aplicado'].includes(String(d.run?.['estado'] ?? ''));
        this.incluirUuid = conArchivo ? d.run?.['incluye_uuid'] !== false : true;
        this.cargandoMes.set(false);
        // LC.19.6: sin cron — abrir el mes ES el evento que lo prepara.
        this.prepararMes(mes);
      },
      error: (e) => { this.cargandoMes.set(false); this.error('No se pudo abrir el mes', e); },
    });
  }

  // ── LC.18: proveedor nuevo ─────────────────────────────────────────────────────────
  abrirAsignar(f: FacturaMes) {
    this.asignarPara.set(f);
    this.sugerencias.set(null);
    this.cuentaElegida = '';
    this.cargandoSug.set(true);
    this.dlgAsignar.set(true);
    this.svc.sugerirCuenta(f.emisor_rfc).subscribe({
      next: (s) => {
        this.sugerencias.set(s);
        // La sugerencia fuerte (ContPAQi le asoció un CFDI de este RFC) se deja elegida; el
        // resto no: con el nombre solo, la decisión es de quien lleva el libro.
        const fuerte = s.candidatas.find((c) => c.fuerte && !c.asignada_a);
        if (fuerte) this.cuentaElegida = fuerte.cuenta;
        // La del renglón (mismo nombre, ≥ 80 %) también se deja elegida: es la que el botón dijo.
        else if (f.cuenta_sugerida && s.candidatas.some((c) => c.cuenta === f.cuenta_sugerida!.cuenta && !c.asignada_a)) {
          this.cuentaElegida = f.cuenta_sugerida.cuenta;
        }
        this.cargandoSug.set(false);
      },
      error: (e) => { this.cargandoSug.set(false); this.error('No se pudieron buscar cuentas', e); },
    });
  }

  private mayuscula(s: string) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  cuentaValida() {
    return /^212\d{7}$/.test(this.cuentaElegida.trim());
  }

  asignar() {
    const f = this.asignarPara(); const mes = this.mesSel();
    if (!f || !mes || !this.cuentaValida() || this.asignando()) return;
    this.asignando.set(true);
    this.svc.asignarCuenta(f.emisor_rfc, this.cuentaElegida.trim()).subscribe({
      next: (r) => {
        this.asignando.set(false); this.dlgAsignar.set(false);
        const faltan = [!r.compra_exenta_existe ? '501' : null, !r.compra_iva_existe ? '502' : null].filter(Boolean);
        this.toast.add({
          severity: faltan.length ? 'warn' : 'success', summary: 'Cuenta asignada',
          detail: `${f.emisor_nombre} → ${r.cuenta_proveedor}.`
            + (faltan.length ? ` Falta dar de alta la ${faltan.join(' y la ')} en ContPAQi.` : ''),
          life: faltan.length ? 9000 : 4000,
        });
        this.abrirMes(mes); this.cargarMeses();
      },
      error: (e) => { this.asignando.set(false); this.error('No se pudo asignar la cuenta', e); },
    });
  }

  /** Optimista: la fila cambia de inmediato y se revierte si el server dice que no. */
  alternar(f: FacturaMes, incluida: boolean) {
    const mes = this.mesSel(); if (!mes) return;
    // Incluir una que ya está posteada duplica el asiento. Se avisa y se deja pasar: puede
    // ser un falso positivo del cruce por importe (dos facturas del mismo monto), y quien
    // lleva el libro es quien sabe. El generador vuelve a frenar si sigue marcada.
    if (incluida && f.ya_en_poliza) {
      this.toast.add({ severity: 'warn', summary: 'Cuidado: se duplicaría',
        detail: `${this.money(f.total)} de ${f.emisor_nombre} ya aparece en la póliza del mes. Solo inclúyela si comprobaste que es otra factura.`,
        life: 9000 });
    }
    const antes = f.incluida;
    this.aplicarInclusionLocal(f.uuid, incluida);
    this.svc.setInclusionNoAsociados(mes, [f.uuid], incluida).subscribe({
      // LC.19.6: un cambio invalida el archivo generado; el mes se vuelve a preparar solo cuando
      // dejas de mover casillas (no uno por clic).
      next: () => this.programarPreparacion(mes),
      error: (e) => { this.aplicarInclusionLocal(f.uuid, antes); this.error('No se pudo cambiar la factura', e); },
    });
  }

  /** LC.19.6 — el porqué de una exclusión, de la lista cerrada. Queda en la decisión guardada. */
  elegirMotivo(f: FacturaMes, motivo: string | null) {
    const mes = this.mesSel(); if (!mes || !motivo) return;
    this.svc.setInclusionNoAsociados(mes, [f.uuid], false, motivo).subscribe({
      next: () => {
        const d = this.detalle(); if (!d) return;
        this.detalle.set({ ...d, facturas: d.facturas.map((x) => (x.uuid === f.uuid ? { ...x, motivo_exclusion: motivo } : x)) });
      },
      error: (e) => this.error('No se pudo guardar el motivo', e),
    });
  }

  private programarPreparacion(mes: string) {
    if (this.rePreparar) clearTimeout(this.rePreparar);
    this.rePreparar = setTimeout(() => {
      this.rePreparar = null;
      this.preparados.delete(mes);
      if (this.mesSel() === mes) this.prepararMes(mes);
    }, 4000);
  }

  /**
   * LC.19.6 — Lo que el mes hace solo (POST /preparar), disparado al abrirlo: «aplicado» si ContPAQi
   * ya casa con el archivo, cuentas de proveedores con nombre idéntico, la verificación ante el SAT
   * por lotes y, en el mes que toca, el archivo. Sólo con GESTIONAR. Repite mientras el SAT tenga
   * pendientes; al final reabre el mes una vez y dice qué hizo.
   */
  private prepararMes(mes: string) {
    if (!this.puedeGestionar() || this.preparados.has(mes)) return;
    this.preparados.add(mes);
    this.preparando.set('Preparando el mes…');
    const hecho = { aplicado: null as string | null, cuentas: [] as string[], consultadas: 0, vigentes: 0, otras: 0, generado: null as string | null };
    const vuelta = (n: number) => this.svc.prepararMes(mes).subscribe({
      next: (p: PreparacionMes) => {
        if (p.aplicado.hecho) hecho.aplicado = p.aplicado.motivo;
        hecho.cuentas.push(...p.cuentas_asignadas.map((c) => `${c.nombre} → ${c.cuenta}`));
        if (p.sat) {
          hecho.consultadas += p.sat.consultados; hecho.vigentes += p.sat.vigentes;
          hecho.otras += p.sat.cancelados + p.sat.no_encontrados + p.sat.fallidos;
        }
        if (p.generado.hecho) hecho.generado = `${p.generado.facturas} facturas, póliza ${p.generado.folio}`;
        if (p.restantes > 0 && (p.sat?.consultados ?? 0) > 0 && n < 30 && this.mesSel() === mes) {
          this.preparando.set(`Verificando en el SAT… ${hecho.consultadas} consultadas, faltan ${p.restantes}`);
          vuelta(n + 1);
          return;
        }
        this.preparando.set(null);
        const partes = [
          hecho.aplicado ? `aplicado: ${hecho.aplicado}` : '',
          hecho.cuentas.length ? `cuenta asignada: ${hecho.cuentas.join(', ')}` : '',
          hecho.consultadas ? `SAT: ${hecho.vigentes} vigentes${hecho.otras ? `, ${hecho.otras} sin confirmar` : ''}` : '',
          hecho.generado ? `archivo listo: ${hecho.generado}` : '',
        ].filter(Boolean);
        if (!partes.length) return;
        this.toast.add({ severity: hecho.otras ? 'warn' : 'info', summary: 'El mes se preparó solo', detail: partes.join(' · '), life: 9000 });
        if (this.mesSel() === mes) this.abrirMes(mes);
        this.cargarMeses();
      },
      error: (e) => { this.preparando.set(null); this.error('No se pudo preparar el mes solo', e); },
    });
    vuelta(0);
  }

  /** LC.19.6 — los tres archivos que van a ContPAQi, de un clic (con el código de cada uno). */
  descargarTodo() {
    if (this.bajandoTodo()) return;
    this.bajandoTodo.set(true);
    this.descargar();
    this.exportarRespaldo();
    this.descargarAsociador();
    setTimeout(() => this.bajandoTodo.set(false), 1500);
  }

  private aplicarInclusionLocal(uuid: string, incluida: boolean) {
    const d = this.detalle(); if (!d) return;
    const facturas = d.facturas.map((x) => (x.uuid === uuid ? { ...x, incluida } : x));
    const dentro = facturas.filter((x) => x.incluida);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    this.detalle.set({
      ...d, facturas,
      resumen: {
        ...d.resumen,
        incluidas: dentro.length,
        excluidas: facturas.length - dentro.length,
        total: r2(dentro.reduce((a, x) => a + x.total, 0)),
        subtotal_exento: r2(dentro.reduce((a, x) => a + x.base_exenta, 0)),
        subtotal_gravado: r2(dentro.reduce((a, x) => a + x.subtotal16, 0)),
        iva: r2(dentro.reduce((a, x) => a + x.iva, 0)),
        ieps: r2(dentro.reduce((a, x) => a + x.ieps, 0)),
      },
    });
  }

  abrirCaratula() {
    const d = this.detalle(); if (!d) return;
    this.caratulaFolio = this.folioPoliza();
    this.caratulaConcepto = String(d.run?.['concepto'] ?? '');
    // El mes sin libro necesita entrar como folio 1: se sugiere ya escrito, no se impone.
    if (!this.existeLibroDelMes() && this.caratulaFolio === 2) {
      this.caratulaFolio = 1;
      this.caratulaConcepto = `REGISTRO DE COMPRAS DEL MES ${d.mes}`;
    }
    this.dlgCaratula.set(true);
  }

  guardarCaratula() {
    const mes = this.mesSel(); if (!mes) return;
    const folio = Number(this.caratulaFolio);
    if (!Number.isInteger(folio) || folio < 1) {
      this.toast.add({ severity: 'warn', summary: 'Folio inválido', detail: 'Tiene que ser un entero mayor o igual a 1.' });
      return;
    }
    this.guardandoCaratula.set(true);
    this.svc.setCaratulaNoAsociados(mes, { folio_poliza: folio, concepto: this.caratulaConcepto.trim() }).subscribe({
      next: (r) => {
        this.guardandoCaratula.set(false); this.dlgCaratula.set(false);
        this.toast.add({ severity: 'success', summary: 'Carátula guardada', detail: `Entra como folio ${r.folio_poliza} del Diario.` });
        this.abrirMes(mes); this.cargarMeses();
      },
      error: (e) => { this.guardandoCaratula.set(false); this.error('No se pudo cambiar la carátula', e); },
    });
  }

  generar(forzar = false) {
    const mes = this.mesSel(); if (!mes || this.generando()) return;
    // LC.18: si hay marcadas que casan por importe con algo ya posteado, el servidor exige un
    // motivo. Se pide ANTES, no después de un error.
    if (!forzar && this.sospechosasIncluidas() > 0) {
      this.motivoForzar = '';
      this.dlgForzar.set(true);
      return;
    }
    this.generando.set(true);
    const motivo = forzar ? this.motivoForzar.trim() : '';
    this.svc.generarNoAsociados(mes, this.impuestosModo, this.incluirUuid, motivo ? { motivo } : undefined).subscribe({
      next: (r) => {
        this.generando.set(false); this.dlgForzar.set(false);
        this.toast.add({ severity: 'success', summary: r.folio === 1 ? 'Libro de compras generado' : 'Complemento generado',
          detail: `${r.facturas} facturas · ${r.renglones} renglones · ${this.money(r.cargos)} · póliza ${r.folio}` });
        this.abrirMes(mes); this.cargarMeses();
      },
      error: (e) => { this.generando.set(false); this.error('No se pudo generar', e); },
    });
  }

  /**
   * LC.19.1 — Verifica ante el SAT las facturas del mes, un lote (~100, ~25 s) por llamada, y
   * repite mientras el servidor diga que quedan. Si cambias de mes se detiene: el resultado de
   * otro mes no se mezcla con éste. Al final reabre el mes, que es quien decide qué bloquea.
   */
  verificarSat() {
    const mes = this.mesSel(); if (!mes || this.verificandoSat()) return;
    this.verificandoSat.set(true);
    const acum = { consultados: 0, vigentes: 0, cancelados: 0, no_encontrados: 0, fallidos: 0 };
    let total = 0;
    const terminar = (resumen?: string, sev: 'success' | 'warn' = 'success') => {
      this.verificandoSat.set(false); this.progresoSat.set(null);
      if (resumen) this.toast.add({ severity: sev, summary: 'Verificación ante el SAT', detail: resumen, life: 8000 });
      if (this.mesSel() === mes) this.abrirMes(mes);
    };
    const vuelta = () => this.svc.verificarSat(mes).subscribe({
      next: (r) => {
        if (!r.disponible) {
          terminar('El servidor no tiene con qué consultar al SAT: no se verificó nada y nada se dio por vigente.', 'warn');
          return;
        }
        total = total || r.por_verificar;
        acum.consultados += r.consultados; acum.vigentes += r.vigentes; acum.cancelados += r.cancelados;
        acum.no_encontrados += r.no_encontrados; acum.fallidos += r.fallidos;
        this.progresoSat.set(`Verificando… ${acum.consultados} de ${total} consultadas`);
        if (r.restantes > 0 && r.consultados > 0 && this.mesSel() === mes) { vuelta(); return; }
        const otros = acum.cancelados + acum.no_encontrados + acum.fallidos;
        terminar(`${acum.vigentes} vigentes · ${acum.cancelados} canceladas · ${acum.no_encontrados} que el SAT no encontró · `
          + `${acum.fallidos} sin respuesta${otros ? '. Las que no salieron vigentes siguen sin poder entrar al TXT.' : '.'}`,
          otros ? 'warn' : 'success');
      },
      error: (e) => { this.verificandoSat.set(false); this.progresoSat.set(null); this.error('No se pudo verificar ante el SAT', e); },
    });
    vuelta();
  }

  /**
   * El respaldo humano-legible del archivo entregado. Dos hojas, y las dos describen el
   * **TXT**, no los datos de hoy: la de movimientos sale de los renglones del archivo, y la
   * de facturas de los UUID que esos renglones llevan. Así el respaldo siempre cuadra
   * contra lo que se entregó, aunque después hayan entrado CFDIs nuevos al mes.
   *
   * La hoja de movimientos es, además, el listado movimiento-a-UUID que necesita el
   * Asociador de CFDI de ContPAQi.
   */
  exportarRespaldo() {
    const mes = this.mesSel(); if (!mes) return;
    this.bajandoRespaldo.set(true);
    this.svc.respaldoNoAsociados(mes).subscribe({
      next: async (r) => {
        const cargos = r.movimientos.filter((m) => !m.abono).reduce((a, m) => a + m.importe, 0);
        const pie = `Póliza ${r.folio_poliza} del Diario · ${r.concepto} · ${r.movimientos.length} renglones · `
          + `${this.money(cargos)} · archivo ${r.archivo_nombre ?? ''} (sha256 ${String(r.archivo_hash ?? '').slice(0, 12)})`;
        await exportXlsx(`respaldo-compras-${mes}`, [
          {
            name: 'Facturas',
            title: `Facturas del complemento ${mes}`,
            subtitle: r.facturas_origen === 'archivo'
              ? `${pie} · las facturas salen de los UUID del propio archivo`
              : `${pie} · el archivo no lleva UUID: las facturas salen de la decisión registrada`,
            rows: r.facturas,
            cols: [
              { header: 'Proveedor', get: (f: FacturaRespaldo) => f.emisor_nombre, width: 38 },
              { header: 'RFC', get: (f: FacturaRespaldo) => f.emisor_rfc, width: 15 },
              { header: 'Serie', get: (f: FacturaRespaldo) => f.serie ?? '', width: 8 },
              { header: 'Folio', get: (f: FacturaRespaldo) => f.folio ?? '', width: 12 },
              { header: 'Fecha', get: (f: FacturaRespaldo) => f.fecha, type: 'date' as const, width: 12 },
              { header: 'Cta. proveedor', get: (f: FacturaRespaldo) => f.cuenta_proveedor ?? '', width: 15 },
              { header: 'Cta. compras 0%', get: (f: FacturaRespaldo) => f.cuenta_compra_exenta ?? '', width: 15 },
              { header: 'Cta. compras IVA', get: (f: FacturaRespaldo) => f.cuenta_compra_iva ?? '', width: 15 },
              { header: 'Base 0%', get: (f: FacturaRespaldo) => f.base_exenta, type: 'money' as const, total: true },
              { header: 'Base 16%', get: (f: FacturaRespaldo) => f.subtotal16, type: 'money' as const, total: true },
              { header: 'IEPS', get: (f: FacturaRespaldo) => f.ieps, type: 'money' as const, total: true },
              { header: 'IVA', get: (f: FacturaRespaldo) => f.iva, type: 'money' as const, total: true },
              { header: 'Total', get: (f: FacturaRespaldo) => f.total, type: 'money' as const, total: true },
              { header: 'UUID', get: (f: FacturaRespaldo) => f.uuid, width: 38 },
            ],
          },
          {
            name: 'Movimientos',
            title: `Renglones del TXT ${mes}`,
            subtitle: `${pie} · es el listado movimiento ↔ UUID para el Asociador de CFDI`,
            rows: r.movimientos.map((m, i) => ({ ...m, n: i + 1 })),
            cols: [
              { header: '#', get: (m: MovimientoRespaldo & { n: number }) => m.n, type: 'int' as const, width: 7 },
              { header: 'Cuenta', get: (m: MovimientoRespaldo & { n: number }) => m.cuenta, width: 16 },
              { header: 'Referencia', get: (m: MovimientoRespaldo & { n: number }) => m.referencia, width: 13 },
              { header: 'Tipo', get: (m: MovimientoRespaldo & { n: number }) => (m.abono ? 'Abono' : 'Cargo'), width: 9 },
              { header: 'Cargo', get: (m: MovimientoRespaldo & { n: number }) => (m.abono ? null : m.importe), type: 'money' as const, total: true },
              { header: 'Abono', get: (m: MovimientoRespaldo & { n: number }) => (m.abono ? m.importe : null), type: 'money' as const, total: true },
              { header: 'UUID del CFDI', get: (m: MovimientoRespaldo & { n: number }) => m.concepto, width: 38 },
            ],
          },
        ]);
        this.bajandoRespaldo.set(false);
      },
      error: (e) => { this.bajandoRespaldo.set(false); this.error('No se pudo armar el respaldo', e); },
    });
  }

  descargarAsociador() {
    const mes = this.mesSel(); if (!mes) return;
    this.svc.asociadorNoAsociados(mes).subscribe({
      next: (blob) => this.bajar(blob, `asociador-cfdi-${mes}.csv`),
      error: (e) => this.error('No se pudo armar el listado del asociador', e),
    });
  }

  /** Blob autenticado → descarga. Por HttpClient y no <a href>: la ruta va tras el guard. */
  private bajar(blob: Blob, nombre: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    a.click(); URL.revokeObjectURL(url);
  }

  descargar() {
    const mes = this.mesSel(); if (!mes) return;
    this.svc.descargarNoAsociados(mes).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        // LC.19.6: el nombre es el que guardó la corrida (poliza-compras-* para el libro del mes,
        // complemento-* para lo demás). Antes se fijaba aquí y pisaba al del servidor.
        a.href = url; a.download = String(this.detalle()?.run?.['archivo_nombre'] ?? `complemento-compras-${mes}.txt`);
        a.click(); URL.revokeObjectURL(url);
      },
      error: (e) => this.error('No se pudo descargar', e),
    });
  }

  marcar(estado: 'entregado' | 'aplicado' | 'cancelado') {
    const mes = this.mesSel(); if (!mes) return;
    const notas = estado === 'cancelado' ? `Entrega cancelada: ${this.motivoCancelar.trim()}` : undefined;
    this.svc.marcarNoAsociados(mes, estado, { entregado_a: this.entregadoA || undefined, notas }).subscribe({
      next: () => {
        this.dlgEntrega.set(false); this.entregadoA = '';
        this.dlgCancelar.set(false); this.motivoCancelar = '';
        this.toast.add({ severity: 'success', summary: 'Trámite actualizado', detail: `Póliza marcada como ${estado}.` });
        this.abrirMes(mes); this.cargarMeses();
      },
      error: (e) => this.error('No se pudo actualizar el trámite', e),
    });
  }

  private error(resumen: string, e: unknown) {
    const detalle = (e as { error?: { message?: string } })?.error?.message ?? 'Intenta de nuevo.';
    this.toast.add({ severity: 'error', summary: resumen, detail: detalle, life: 8000 });
  }
}
