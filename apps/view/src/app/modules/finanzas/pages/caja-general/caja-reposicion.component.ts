import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, OnInit, afterNextRender, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import {
  ZONAS_HOJA_GASTOS, pagableConBilletesCaos, revisarConteoCajon, warehouseName,
  type HojaGastos, type HojasDeGastos, type ReposicionDoc, type ReposicionGrupo, type ReposicionRetiro,
  type ReposicionSucursales, type ReposicionVinculo, type AprobacionPago, type PagarHojaInput,
  type ConteoCajonHoja, type HojaAbierta, type RetiroParaHoja, type PagoHojaResultado,
} from '@megadulces/contracts';
import { uuidV4 } from '../../../../core/utils/uuid';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { AuthService } from '../../../../core/services/auth.service';
import { CashLedgerService, type ResumenLote } from '../../cash-ledger.service';
import { CaosService } from '../../caos.service';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { diaMxDe, todayMx } from '../../../../core/utils/mx-date';
import { ConteoCajonComponent } from '../../components/conteo-cajon.component';
import { DescartarCambiosComponent } from '../../../../shared/components/descartar-cambios/descartar-cambios.component';
import { DevolverFocoDirective } from '../../../../shared/directives/devolver-foco.directive';

interface OpcionOrigen { label: string; value: string }

/**
 * `[LE.6.36]` Un renglón de «Por pagar hoy»: la hoja ABIERTA de una zona (`[LE.6.19]`: se paga aquí en un acto) o
 * una hoja de zona del carril viejo (aprobada, o pagada con algo sin capturar).
 */
export type FilaPagar =
  | { tipo: 'abierta'; clave: string; a: HojaAbierta }
  | { tipo: 'hoja'; clave: string; h: HojaGastos };
/** `[LE.6.36]` Un renglón del control de hojas pagadas: la hoja y su depósito. */
export interface FilaControl { clave: string; h: HojaGastos }
/** `[CGA-A.61]` Un renglón de «Otras sucursales»: lo que una sucursal pagó en un día. */
export interface FilaGrupo { tipo: 'grupo'; clave: string; g: ReposicionGrupo }
/** `[LE.6.36]` Los filtros del control: lo que espera su depósito, lo ya repuesto, o todas las hojas. */
export type VistaReposicion = 'deposito' | 'repuestas' | 'todas';
/** `[LE.6.36]` El estado del depósito en una palabra corta, con su icono y su severidad: nunca sólo color. */
export interface EstadoDeposito { texto: string; icono: string; sev: 'success' | 'info' | 'warn' | 'danger' | 'secondary' }

/** `[LE.6.19]` Lo que se está contando antes de pagar: todo lo que sale del cajón se cuenta. */
interface Conteo { clave: string; titulo: string; total: number; pagar: (conteo: ConteoCajonHoja) => void }

/**
 * Lo que dice el aviso después de «Reponer»: cuántos entraron y, de los que no, CUÁL y POR QUÉ.
 *
 * ⛔ Canindo 30/10 (2026-10-30): el aviso decía «0 de 1 egresos guardados… 1 no se pudieron: siguen en
 * la cola» y el servidor SÍ había dicho por qué —el pago va en la hoja de zona y se paga en Hoja de
 * zona—; el aviso tiraba `filas[].motivo` y no había forma de saber qué hacer. Ahora cada motivo va
 * con sus folios, y si algo no entró el aviso se queda hasta que se cierre: no se lee en 8 segundos.
 */
export function avisoDeReposicion(
  r: ResumenLote, pedidos: number, docs: ReadonlyArray<Pick<ReposicionDoc, 'origen_ref' | 'doc_tipo' | 'folio'>>,
): { severity: 'success' | 'warn' | 'error'; detail: string; sticky: boolean } {
  const nombre = new Map(docs.map((d) => [d.origen_ref, `${d.doc_tipo} ${d.folio}`.trim()]));
  const porMotivo = new Map<string, string[]>();
  let yaEstaban = 0;
  for (const f of r.filas) {
    if (f.estado === 'guardado') continue;
    if (f.estado === 'duplicado') { yaEstaban += 1; continue; }
    const m = (f.motivo ?? '').trim().replace(/\.+$/, '') || 'el servidor no dijo por qué';
    porMotivo.set(m, [...(porMotivo.get(m) ?? []), nombre.get(f.origen_ref) || f.origen_ref]);
  }
  const fallaron = r.rechazados + r.no_confirmables;
  const partes = [`${r.guardados} de ${pedidos} egresos guardados por ${money(r.monto_guardado)}`
    + (r.retiro && r.guardados ? ` · CAOS ${money(r.retiro.tomado)}, cajón ${money(r.retiro.del_cajon)}` : '')];
  if (yaEstaban) partes.push(`${yaEstaban} ya ${yaEstaban === 1 ? 'estaba capturado' : 'estaban capturados'}`);
  if (fallaron) {
    const motivos = [...porMotivo.entries()].map(([m, folios]) =>
      `${folios.slice(0, 3).join(', ')}${folios.length > 3 ? ` y ${folios.length - 3} más` : ''}: ${m}`);
    partes.push(`${fallaron === 1 ? 'No entró (sigue en la cola)' : `${fallaron} no entraron (siguen en la cola)`} — ${motivos.join(' · ')}`);
  }
  return { severity: !fallaron ? 'success' : r.guardados ? 'warn' : 'error', detail: `${partes.join('. ')}.`, sticky: fallaron > 0 };
}

/**
 * `[LE.6.34]` Lo que dice el aviso después de pagar una hoja (o reintentar su captura): lo que quedó
 * explicado y, de lo que no entró, CUÁL y POR QUÉ — todos los motivos, no sólo el del primer renglón
 * (antes `sin_capturar[0].motivo`, y con 8 segundos de vida). Como `avisoDeReposicion`: si algo quedó
 * sin capturar el aviso se queda hasta que se cierre.
 */
export function avisoDePagoHoja(
  x: Pick<PagoHojaResultado, 'sin_capturar'> & { hoja: Pick<HojaGastos, 'renglones'> },
  explicado: string, sinMotivo = 'reintenta con «Capturar lo que falta»',
): { severity: 'success' | 'warn'; detail: string; sticky: boolean } {
  const faltan = x.sin_capturar.length;
  if (!faltan) return { severity: 'success', detail: explicado, sticky: false };
  const nombre = new Map((x.hoja.renglones ?? []).map((r) => [r.origen_ref, `${r.doc_tipo} ${r.folio}`.trim()]));
  const porMotivo = new Map<string, string[]>();
  for (const f of x.sin_capturar) {
    const m = (f.motivo ?? '').trim().replace(/\.+$/, '') || sinMotivo;
    porMotivo.set(m, [...(porMotivo.get(m) ?? []), nombre.get(f.origen_ref) || f.origen_ref]);
  }
  const motivos = [...porMotivo.entries()].map(([m, folios]) =>
    `${folios.slice(0, 3).join(', ')}${folios.length > 3 ? ` y ${folios.length - 3} más` : ''}: ${m}`);
  const cab = `${faltan} sin capturar`;
  return { severity: 'warn', detail: `${explicado} ${cab} — ${motivos.join(' · ')}.`.trim(), sticky: true };
}

/**
 * ⭐ `[LE.6.36]` **Reposición: control por hoja** (PM, 2026-11-19: *«la interfaz de reposición es muy complicada
 * para que el usuario lleve un control de reposiciones»*). Medido ese día en prod: la ventana se abre ~45 veces al
 * día; Carmen y Mayra pagan ~20 hojas en 12 días; hay 27 hojas, todas pagadas, y ~20 siguen sin su depósito. El
 * trabajo diario son DOS actos —pagar la hoja de cada zona y vigilar que llegue el depósito de cada hoja pagada— y
 * la ventana los mezclaba con la reposición por sucursal, tres tiras de cifras, un plegable por zona y párrafos
 * largos en cada renglón.
 *
 * Las cinco preguntas (skill `diseno` §0b), contestadas antes de escribir la plantilla:
 *  1. **Qué ve y en qué orden:** primero lo que hay que PAGAR hoy, una fila por zona con su botón (acto 1); después
 *     el control de las hojas pagadas, que abre en «Esperan depósito» con lo vencido primero (acto 2).
 *  2. **Qué NO ve de entrada:** la explicación larga del depósito (baja al detalle del renglón: una línea corta con
 *     qué falta y quién, y lo que se buscó plegado), las tres tiras viejas de cifras (las reemplaza UNA tira de tres
 *     cifras, una por pregunta: por pagar hoy, esperan depósito, repuestas; más los conteos de los filtros) y los
 *     plegables por zona (lo que no va en la hoja queda en un solo plegable al final).
 *  3. **Accesibilidad:** los filtros son `app-segmented` (radiogroup, el conteo dentro del nombre); el estado del
 *     depósito es palabra + icono en un `p-tag` (nunca sólo color); cada renglón desplegable tiene su botón con
 *     `aria-expanded`; los montos van en `tabular-nums`; todo se alcanza con teclado (flechas en el filtro, Enter
 *     en la fila abre su detalle).
 *  4. **Ligado a:** la cola de Captura (un pago «en hoja» abre esta ventana con `abrirEn(ref)`, `[LE.6.35]`),
 *     Kepler (el `U-A-5` del depósito), la cuenta bancaria de la zona (segundo testigo) y CAOS (el retiro con que
 *     se pagó, en el detalle).
 *  5. **¿Le toca a esta pantalla?:** sí, pagar y vigilar las hojas de zona. La reposición POR SUCURSAL (`[CGA-A.61]`,
 *     grupos accionables / sin retiro / explicados) sigue viva con sus acciones intactas, en una sección compacta
 *     al final, «Otras sucursales (sin hoja de zona)», plegada si no tiene nada accionable.
 *
 * Jerarquía (Q.5): primario = la fila de cada zona por pagar y la etiqueta del depósito de cada hoja; secundario =
 * hoja, zona, día y monto; terciario = los pagos, el retiro, lo que se buscó y la reposición por sucursal.
 *
 * Lo que viene de antes y se conserva (`[CGA-A.61]`–`[LE.6.35]`): los flujos de pago (retiro que cuadra ya elegido,
 * arqueo de lo que sale del cajón, descartar con pregunta), «Capturar lo que falta», «Cambiar retiro», confirmar la
 * propuesta de vínculos, los avisos con todos sus motivos y el «llévame a su hoja» desde la cola.
 *
 * ⚠️ Quién hace qué lo vuelve a exigir el servidor: «Reponer» y «Pagar» son de quien gestiona la caja;
 * vincular y cambiar de retiro, de superadmin (`[CGA-A.58]`); y quien aprobó una hoja no la paga.
 */
@Component({
  selector: 'app-caja-reposicion',
  standalone: true,
  imports: [
    FormsModule, RouterLink, NgTemplateOutlet, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ConteoCajonComponent,
    DescartarCambiosComponent, DevolverFocoDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- [LE.6.36] Piezas que se usan en los dos bloques (por pagar y pagadas): una sola plantilla, no dos copias. -->
    <ng-template #renglonesHoja let-rs>
      <p-table [value]="rs" size="small" class="rp-mini">
        <ng-template #header>
          <tr><th>Sucursal</th><th>Día de pago</th><th>Documento de Kepler</th><th>Beneficiario</th><th class="rp-num-h">Importe</th></tr>
        </ng-template>
        <ng-template #body let-r>
          <tr [attr.data-rp-ref]="r.origen_ref" [class.rp-buscado]="r.origen_ref === resaltado()">
            <td data-label="Sucursal" role="cell">{{ nombre(r.sucursal) }}</td>
            <td class="rp-mono" data-label="Día de pago" role="cell">{{ dmy(r.fecha_pago) }}</td>
            <td class="rp-mono dt-id" data-label="Documento de Kepler" role="cell">{{ r.doc_tipo }} {{ r.folio }}</td>
            <td data-label="Beneficiario" role="cell">{{ r.beneficiario ?? '—' }}</td>
            <td class="rp-num dt-num" data-label="Importe" role="cell">{{ money(r.importe) }}</td>
          </tr>
        </ng-template>
      </p-table>
    </ng-template>

    <!-- [LE.6.24] Lo que se repone contra el depósito que lo repuso: su folio de Kepler y si cuadra. La nota
         larga de por qué falta NO va aquí: va plegada en «Lo que se buscó». -->
    <ng-template #depositoHoja let-h>
      @if (h.pago; as p) {
        <p class="rp-desglose" data-testid="rp-hoja-deposito">
          Se repone <span class="rp-mono">{{ money(h.total) }}</span> ·
          @if (p.deposito.depositos?.[0]; as d) {
            @if (d.folio) {
              depósito <span class="rp-mono">U-A-5 {{ d.folio }}</span> de {{ nombre(d.sucursal ?? '') }}, {{ dmy(d.dia) }}, a la cuenta {{ d.banco }}:
            } @else {
              depósito del {{ dmy(d.dia) }}:
            }
            <span class="rp-mono">{{ money(d.importe) }}</span> · <strong>cuadra</strong>
            @if (p.deposito.diferencia) { <span class="fin-dim">({{ diferenciaTexto(p.deposito.diferencia) }} de redondeo)</span> }
            @if (p.deposito.banco; as b) { <span class="d-block" data-testid="rp-hoja-banco">{{ b.texto }}</span> }
          } @else {
            <strong>sin depósito que cuadre</strong>
          }
        </p>
      }
    </ng-template>

    <!-- [CGA-A.63] Ventana y no cajón: mientras se repone, la cola pasa a segundo plano.
         Sin aboveModals: adentro hay p-select y se abre el p-dialog de cambiar de retiro. -->
    <app-side-peek mode="window" [width]="1100" [open]="abierta()" (openChange)="$event ? null : cerrarVentana()"
                   title="Reposición" [subtitle]="subtitulo()">
    <div class="rp">
      <header class="rp-head">
        <span class="sr-only" aria-live="polite" aria-atomic="true">{{ anuncio() }}</span>
        @if (datos(); as d) {
          @if (d.datos_al) {
            <app-freshness-pill measures="data" [since]="d.datos_al" label="Kepler" />
          } @else {
            <span class="rp-warn">Kepler sin medir</span>
          }
          @if (d.caos_al) {
            <app-freshness-pill measures="data" [since]="d.caos_al" label="CAOS" />
          } @else {
            <span class="rp-warn">CAOS sin medir</span>
          }
        }
        <span class="rp-sp"></span>
        <p-button icon="pi pi-refresh" size="small" severity="secondary" [text]="true" [loading]="cargando()"
                  ariaLabel="Volver a leer la reposición" (onClick)="cargar()"></p-button>
      </header>

      <!-- [LE.6.35] Se llegó desde un pago «en hoja» de la cola: dónde está, en palabras. -->
      @if (avisoBuscado(); as av) {
        <p class="rp-buscado-aviso" role="status" data-testid="rp-buscado">{{ av }}</p>
      }

      <!-- [CGA-A.65] Lo que quedó del carril viejo esperando a otra persona: una hoja cerrada sin aprobar. -->
      @if (enEspera().length) {
        <p class="rp-hojas" role="status">
          <i class="pi pi-file-check" aria-hidden="true"></i>
          <span>@for (x of enEspera(); track x.clave) { {{ x.texto }}@if (!$last) { · } }</span>
        </p>
      }

      <!-- [LE.6.36] La respuesta primero (Q.1): por pagar hoy, lo que espera depósito y lo repuesto. -->
      <app-metric-strip class="rp-kpis" [items]="kpis()"></app-metric-strip>

      <!-- ═══ ACTO 1: lo que hay que pagar hoy, una fila por zona con su botón ═══ -->
      <section class="rp-bloque" aria-labelledby="rp-t-pagar" data-testid="rp-por-pagar">
        <h3 class="rp-t" id="rp-t-pagar">
          Por pagar hoy
          @if (hojas() && porPagar().length) {
            <span class="rp-t-cifra" data-testid="rp-total-pagar">{{ money(totalPorPagar()) }}</span>
          }
        </h3>
        <app-load-state class="dt-scope" [loading]="leyendoHojas() && !hojas() && !hojasNoLeidas()" [skeletonRows]="2"
                        [error]="hojasNoLeidas() ? 'Su reposición no aparece aquí hasta que se lean: no se sabe qué hay por pagar.' : null"
                        errorTitle="Las hojas de zona no se pudieron leer" (retry)="cargar()"
                        [isEmpty]="!porPagar().length" emptyIcon="pi-check-circle" emptyTitle="Nada por pagar hoy"
                        emptyHint="Ninguna zona tiene pagos esperando su reposición.">
          <p-table [value]="porPagar()" size="small" dataKey="clave" [expandedRowKeys]="abiertas()" class="rp-pagar dt-stack"
                   selectionMode="single" [metaKeySelection]="false" [selection]="filaActiva()"
                   (selectionChange)="filaActiva.set($any($event))">
            <ng-template #header>
              <tr>
                <th class="rp-col-tog"><span class="sr-only">Detalle</span></th>
                <th>Zona</th>
                <th class="rp-num-h">Pagos</th>
                <th class="rp-num-h">Monto</th>
                <th>Qué sigue</th>
              </tr>
            </ng-template>
            <ng-template #body let-f let-expanded="expanded">
              <tr [pSelectableRow]="f" (keydown.enter)="enterEnFila($event, f.clave)" data-testid="rp-pagar-fila">
                <td class="rp-col-tog dt-actions" data-label="Detalle" role="cell">
                  <button pButton type="button" text severity="secondary" class="p-button-sm rp-tog" [attr.aria-expanded]="!!expanded"
                          [attr.aria-label]="(expanded ? 'Ocultar' : 'Ver') + ' los pagos de ' + quienPagar(f)" (click)="alternar(f.clave)">
                    <span class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></span>
                  </button>
                </td>
                @if (f.tipo === 'abierta') {
                  <!-- [LE.6.19] La hoja abierta de la zona: se cierra y se paga en un acto, sin aprobarla aparte. -->
                  <td class="rp-quien dt-id" data-label="Zona" role="cell"><strong>{{ f.a.nombre }}</strong></td>
                  <td class="rp-num dt-num" data-label="Pagos" role="cell">
                    {{ f.a.renglones.length }} {{ f.a.renglones.length === 1 ? 'pago' : 'pagos' }}
                    @if (f.a.detenidos.length) { <small class="rp-sub">{{ f.a.detenidos.length }} sin aprobar</small> }
                  </td>
                  <td class="rp-cifra dt-num" data-label="Monto" role="cell"><strong>{{ money(f.a.total) }}</strong></td>
                  <td class="rp-que dt-actions" data-label="Qué sigue" role="cell">
                    @if (!puedeGestionar()) {
                      <small class="fin-dim">La paga quien gestiona la caja.</small>
                    } @else {
                      <div class="rp-accion">
                        <p-select [options]="opcionesAbierta(f.a)" [ngModel]="eleccionAbierta(f.a)" (ngModelChange)="elegirAbierta(f.a, $event)"
                                  optionLabel="label" optionValue="value" placeholder="¿Con qué retiro?" size="small"
                                  appendTo="body" class="rp-sel" [ariaLabel]="'Con qué se paga la reposición de ' + f.a.nombre"></p-select>
                        <p-button [label]="'Pagar ' + f.a.nombre" icon="pi pi-check" size="small"
                                  [disabled]="!eleccionAbierta(f.a) || !!ocupado()" [loading]="ocupado() === f.clave"
                                  (onClick)="pagarAbierta(f.a)"></p-button>
                      </div>
                      <small class="fin-dim">{{ textoCuadreAbierta(f.a) }}</small>
                    }
                    @if (f.a.detenidos.length) {
                      <!-- [LE.6.20] El enlace afirma que se puede abrir: sólo a quien aprueba gastos; a los demás, en texto. -->
                      @if (puedeAprobar()) {
                        <a class="rp-link" routerLink="/finanzas/aprobacion-gastos">
                          <i class="pi pi-arrow-right" aria-hidden="true"></i>
                          {{ f.a.detenidos.length === 1 ? '1 pago espera su aprobación y no entra' : f.a.detenidos.length + ' pagos esperan su aprobación y no entran' }}. Ir a Aprobación de gastos
                        </a>
                      } @else {
                        <small class="fin-dim">{{ f.a.detenidos.length === 1 ? '1 pago espera su aprobación en Aprobación de gastos y no entra' : f.a.detenidos.length + ' pagos esperan su aprobación en Aprobación de gastos y no entran' }}.</small>
                      }
                    }
                  </td>
                } @else {
                  <td class="rp-quien dt-id" data-label="Zona" role="cell">
                    <strong>{{ f.h.nombre_zona }}</strong>
                    <small class="rp-mono">{{ f.h.folio }} · venta del {{ dmy(f.h.venta_del_dia) }}</small>
                  </td>
                  <td class="rp-num dt-num" data-label="Pagos" role="cell">{{ f.h.renglones.length }} {{ f.h.renglones.length === 1 ? 'pago' : 'pagos' }}</td>
                  <td class="rp-cifra dt-num" data-label="Monto" role="cell"><strong>{{ money(f.h.total) }}</strong></td>
                  <td class="rp-que dt-actions" data-label="Qué sigue" role="cell">
                    @if (f.h.estado === 'aprobada') {
                      @if (!puedeGestionar()) {
                        <small class="fin-dim">La paga quien gestiona la caja, con un solo retiro de CAOS.</small>
                      } @else if (f.h.aprobada_por === yo()) {
                        <small class="fin-dim">La aprobaste tú: la paga otra persona.</small>
                      } @else {
                        <div class="rp-accion">
                          <p-select [options]="opcionesHoja(f.h)" [ngModel]="eleccionHoja(f.h)" (ngModelChange)="elegirHoja(f.h, $event)"
                                    optionLabel="label" optionValue="value" placeholder="¿Con qué retiro?" size="small"
                                    appendTo="body" class="rp-sel" [ariaLabel]="'Con qué se paga ' + f.h.folio"></p-select>
                          <p-button [label]="'Pagar ' + f.h.folio" icon="pi pi-check" size="small"
                                    [disabled]="!eleccionHoja(f.h) || !!ocupado()" [loading]="ocupado() === f.clave"
                                    (onClick)="pagarHoja(f.h)"></p-button>
                        </div>
                        <small class="fin-dim">{{ textoCuadreHoja(f.h) }}</small>
                      }
                    } @else {
                      <!-- Pagada, con renglones que no entraron al libro: se termina aquí. -->
                      @if (puedeGestionar()) {
                        <p-button [label]="'Capturar lo que falta (' + (f.h.pago?.sin_capturar ?? 0) + ')'" icon="pi pi-refresh" size="small"
                                  [disabled]="!!ocupado()" [loading]="ocupado() === f.clave" (onClick)="capturarHoja(f.h)"></p-button>
                      }
                      <small class="fin-dim">Pagada, pero {{ f.h.pago?.sin_capturar }} {{ f.h.pago?.sin_capturar === 1 ? 'pago no ha entrado' : 'pagos no han entrado' }} al libro (casi siempre, la cuenta del beneficiario).</small>
                    }
                  </td>
                }
              </tr>
            </ng-template>
            <ng-template #expandedrow let-f>
              <tr>
                <td colspan="5" class="rp-det" role="cell">
                  @if (f.tipo === 'abierta') {
                    <p class="rp-desglose">
                      Al pagarla, sus {{ f.a.renglones.length }} pagos quedan ligados a un solo retiro y se deposita el total en la cuenta de la zona.
                      Lo que sale del cajón se cuenta por pieza antes de pagar.
                    </p>
                    <ng-container *ngTemplateOutlet="renglonesHoja; context: { $implicit: f.a.renglones }" />
                    @if (f.a.detenidos.length) {
                      <p class="rp-desglose">Esperan su aprobación y no entran a esta reposición:</p>
                      <p-table [value]="f.a.detenidos" size="small" class="rp-mini" data-testid="rp-detenidos">
                        <ng-template #header>
                          <tr><th>Sucursal</th><th>Documento de Kepler</th><th>Beneficiario</th><th class="rp-num-h">Importe</th><th>Por qué</th></tr>
                        </ng-template>
                        <ng-template #body let-r>
                          <tr [attr.data-rp-ref]="r.origen_ref" [class.rp-buscado]="r.origen_ref === resaltado()">
                            <td data-label="Sucursal" role="cell">{{ nombre(r.sucursal) }}</td>
                            <td class="rp-mono dt-id" data-label="Documento de Kepler" role="cell">{{ r.doc_tipo }} {{ r.folio }}</td>
                            <td data-label="Beneficiario" role="cell">{{ r.beneficiario ?? '—' }}</td>
                            <td class="rp-num dt-num" data-label="Importe" role="cell">{{ money(r.importe) }}</td>
                            <td data-label="Por qué" role="cell">{{ r.motivo }}</td>
                          </tr>
                        </ng-template>
                      </p-table>
                    }
                  } @else {
                    <p class="rp-desglose">
                      Cerró {{ f.h.cerrada_por_nombre ?? 'sin nombre' }} · aprobó {{ f.h.aprobada_por_nombre ?? 'sin nombre' }} ·
                      al pagarla, sus {{ f.h.renglones.length }} pagos quedan ligados a un solo retiro y se deposita el total en la cuenta de la zona.
                    </p>
                    <ng-container *ngTemplateOutlet="depositoHoja; context: { $implicit: f.h }" />
                    <ng-container *ngTemplateOutlet="renglonesHoja; context: { $implicit: f.h.renglones }" />
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </section>

      <!-- ═══ ACTO 2: vigilar que llegue el depósito de cada hoja pagada ═══ -->
      <section class="rp-bloque" aria-labelledby="rp-t-control" data-testid="rp-control">
        <div class="rp-control-head">
          <h3 class="rp-t" id="rp-t-control">Hojas pagadas y su depósito</h3>
          @if (hojas()) {
            <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="vista.set($any($event))"
                           ariaLabel="Qué hojas ver" />
          }
        </div>
        <!-- [LE.6.20] Una zona cuya cuenta de depósito no está medida se dice UNA vez, aquí, no en cada renglón. -->
        @for (z of zonasSinMedir(); track z.zona) {
          <p class="rp-nota" data-testid="rp-cuenta-sin-medir"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ z.texto }}</p>
        }
        <app-load-state class="dt-scope" [loading]="leyendoHojas() && !hojas() && !hojasNoLeidas()" [skeletonRows]="3"
                        [error]="hojasNoLeidas() ? 'No se sabe qué hojas esperan su depósito.' : null"
                        errorTitle="Las hojas de zona no se pudieron leer" (retry)="cargar()"
                        [isEmpty]="!hojasControl().length" emptyIcon="pi-check-circle"
                        [emptyTitle]="vacioControl().titulo" [emptyHint]="vacioControl().pista">
          <p-table [value]="hojasControl()" size="small" dataKey="clave" [expandedRowKeys]="abiertas()" class="rp-ctl dt-stack"
                   selectionMode="single" [metaKeySelection]="false" [selection]="filaActiva()"
                   (selectionChange)="filaActiva.set($any($event))">
            <ng-template #header>
              <tr>
                <th class="rp-col-tog"><span class="sr-only">Detalle</span></th>
                <th>Hoja</th>
                <th>Zona</th>
                <th>Pagada</th>
                <th class="rp-num-h">Monto</th>
                <th>Depósito</th>
              </tr>
            </ng-template>
            <ng-template #body let-f let-expanded="expanded">
              <tr [pSelectableRow]="f" (keydown.enter)="enterEnFila($event, f.clave)" data-testid="rp-ctl-fila" [attr.data-hoja]="f.h.folio">
                <td class="rp-col-tog dt-actions" data-label="Detalle" role="cell">
                  <button pButton type="button" text severity="secondary" class="p-button-sm rp-tog" [attr.aria-expanded]="!!expanded"
                          [attr.aria-label]="(expanded ? 'Ocultar' : 'Ver') + ' el detalle de ' + f.h.folio" (click)="alternar(f.clave)">
                    <span class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></span>
                  </button>
                </td>
                <td class="rp-mono dt-id" data-label="Hoja" role="cell">{{ f.h.folio }}</td>
                <td data-label="Zona" role="cell">{{ f.h.nombre_zona }}</td>
                <td class="rp-mono" data-label="Pagada" role="cell">
                  @if (f.h.pago; as p) { {{ dmy(diaMx(p.pagada_at)) }} } @else { <span class="rp-dim">sin pagar</span> }
                </td>
                <td class="rp-num dt-num" data-label="Monto" role="cell">{{ money(f.h.total) }}</td>
                <td data-label="Depósito" role="cell" data-testid="rp-deposito" [attr.data-vencido]="f.h.pago?.deposito?.vencido ?? null">
                  @let e = estadoDeposito(f.h);
                  <p-tag [severity]="e.sev" [icon]="e.icono" [value]="e.texto"></p-tag>
                </td>
              </tr>
            </ng-template>
            <ng-template #expandedrow let-f>
              <tr>
                <td colspan="6" class="rp-det" role="cell">
                  <!-- En una línea: qué falta y quién. Lo largo, plegado debajo. -->
                  <p class="rp-falta-linea" data-testid="rp-que-falta">{{ queFalta(f.h) }}</p>
                  @if (f.h.pago; as p) {
                    <p class="rp-desglose">Pagada <span class="rp-pagado">{{ textoPagoHoja(f.h) }}</span>@if (p.pagada_por_nombre) { · la pagó {{ p.pagada_por_nombre }} }.</p>
                    <ng-container *ngTemplateOutlet="depositoHoja; context: { $implicit: f.h }" />
                    @if (!depositoValidado(f.h) && !p.sin_capturar) {
                      <details class="rp-porque">
                        <summary>Lo que se buscó</summary>
                        <!-- [LE.6.30] La incidencia (vencido) no se ve igual que la espera: lo dice el texto, el color sólo acompaña. -->
                        <p data-testid="rp-falta-deposito" [attr.data-vencido]="p.deposito.vencido ?? null">
                          <strong [class.rp-vencido]="depositoVencido(f.h)">{{ etiquetaSinDeposito(f.h) }}:</strong>
                          {{ p.deposito.nota ?? 'no se pudo leer si llegó.' }}
                          <!-- [LE.6.31] El segundo testigo: si el dinero llegó a la cuenta de la zona. -->
                          @if (p.deposito.banco; as b) { <span class="d-block" data-testid="rp-banco">{{ b.texto }}</span> }
                        </p>
                      </details>
                    }
                  } @else {
                    <p class="rp-desglose">
                      Cerró {{ f.h.cerrada_por_nombre ?? 'sin nombre' }}@if (f.h.aprobada_por_nombre) { · aprobó {{ f.h.aprobada_por_nombre }} }@if (f.h.motivo) { · {{ f.h.motivo }} }.
                    </p>
                  }
                  <ng-container *ngTemplateOutlet="renglonesHoja; context: { $implicit: f.h.renglones }" />
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </section>

      <!-- [LE.6.20] Pagos de la zona que NO van en la hoja: lo que el banco cubre sin depósito y lo que ya se
           repuso (hoja en papel o depósito). Un solo plegable para todas las zonas, no uno por zona. -->
      @if (fueraDeHoja().length) {
        <details class="rp-plegable" data-testid="rp-repuesto">
          <summary>
            <strong>Pagos de zona que no van en una hoja</strong>
            <span class="rp-dim"> · {{ resumenFuera() }}</span>
          </summary>
          @if (nSinDeposito()) {
            <p class="rp-desglose">Sin depósito que los reponga: no se reponen aquí. Si se repusieron en partes, los liga una persona a su retiro; si son gasto normal, se pagan en la cola.</p>
          }
          @if (bancosDeZonas()) { <p class="rp-desglose rp-dim">{{ bancosDeZonas() }}.</p> }
          <p-table [value]="fueraDeHoja()" size="small" class="rp-mini" data-testid="rp-sin-deposito">
            <ng-template #header>
              <tr><th>Zona</th><th>Días de pago</th><th class="rp-num-h">Pagos</th><th class="rp-num-h">Total</th><th>Qué pasó</th></tr>
            </ng-template>
            <ng-template #body let-d>
              <tr>
                <td data-label="Zona" role="cell">{{ d.zona }}</td>
                <td class="rp-mono" data-label="Días de pago" role="cell">{{ dmy(d.desde) }}@if (d.hasta !== d.desde) { – {{ dmy(d.hasta) }} }</td>
                <td class="rp-num dt-num" data-label="Pagos" role="cell">{{ d.n }}</td>
                <td class="rp-num dt-num" data-label="Total" role="cell">{{ money(d.total) }}</td>
                <td data-label="Qué pasó" role="cell">{{ d.texto }}</td>
              </tr>
            </ng-template>
          </p-table>
        </details>
      }

      <!-- [CGA-A.61] La reposición POR SUCURSAL sigue viva, con sus acciones intactas: aquí abajo y plegada
           si no tiene nada que se resuelva en la fila. -->
      <details class="rp-plegable" data-testid="rp-otras" [open]="otrasAbiertas()">
        <summary>
          <strong>Otras sucursales (sin hoja de zona)</strong>
          <span class="rp-dim"> · {{ resumenOtras() }}</span>
        </summary>
        <app-load-state class="dt-scope" [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!filasGrupo().length" [skeletonRows]="3"
                        errorTitle="No se pudo leer la reposición" emptyIcon="pi-check-circle"
                        emptyTitle="Nada por reponer"
                        emptyHint="Sin documentos de caja de sucursal pendientes en estos días."
                        (retry)="cargar()">
          <p-table [value]="filasGrupo()" size="small" dataKey="clave" [expandedRowKeys]="abiertas()" class="rp-tbl dt-stack"
                   selectionMode="single" [metaKeySelection]="false" [selection]="filaActiva()"
                   (selectionChange)="filaActiva.set($any($event))">
            <ng-template #header>
              <tr>
                <th class="rp-col-tog"><span class="sr-only">Detalle</span></th>
                <th>Sucursal</th>
                <th class="rp-num-h">Por resolver</th>
                <th>Qué sigue</th>
              </tr>
            </ng-template>
            <ng-template #body let-f let-expanded="expanded">
              <tr [pSelectableRow]="f" (keydown.enter)="enterEnFila($event, f.clave)">
                <td class="rp-col-tog dt-actions" data-label="Detalle" role="cell">
                  <button pButton type="button" text severity="secondary" class="p-button-sm rp-tog" [attr.aria-expanded]="!!expanded"
                          [attr.aria-label]="(expanded ? 'Ocultar' : 'Ver') + ' el desglose de ' + quienGrupo(f.g)" (click)="alternar(f.clave)">
                    <span class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></span>
                  </button>
                </td>
                <td class="rp-quien dt-id" data-label="Sucursal" role="cell">
                  <strong>{{ nombre(f.g.sucursal) }}</strong>
                  <small>{{ dmy(f.g.fecha) }} · {{ textoDocs(f.g) }}</small>
                </td>
                <td class="rp-cifra dt-num" [attr.data-label]="f.g.estado === 'explicada' ? 'Total' : 'Por resolver'" role="cell">
                  @if (f.g.estado === 'explicada') {
                    <strong>{{ money(f.g.total) }}</strong>
                  } @else {
                    <strong>{{ money(porResolverDe(f.g)) }}</strong>
                    <small>de {{ money(f.g.total) }}</small>
                  }
                </td>
                <td class="rp-que dt-actions" [attr.data-label]="f.g.estado === 'explicada' ? 'Con qué se pagó' : 'Qué sigue'" role="cell">
                  <span class="rp-tags">
                    @if (f.g.estado !== 'explicada') {
                      <p-tag severity="secondary" [value]="textoEstado(f.g)"></p-tag>
                    }
                    @if (f.g.n_sin_aprobar) {
                      <p-tag severity="danger" [value]="f.g.n_sin_aprobar + ' sin aprobar'"></p-tag>
                    }
                    @if (f.g.n_pagado_antes_de_aprobar) {
                      <p-tag severity="secondary" [value]="f.g.n_pagado_antes_de_aprobar + ' pagado antes de aprobar'"></p-tag>
                    }
                  </span>
                  @switch (f.g.estado) {
                    @case ('por_capturar') {
                      @if (puedeGestionar() && reponibles(f.g).length) {
                        <div class="rp-accion">
                          <p-select [options]="opcionesOrigen()" [ngModel]="eleccion(f.g)" (ngModelChange)="elegir(f.g, $event)"
                                    optionLabel="label" optionValue="value" placeholder="¿De dónde sale?" size="small"
                                    appendTo="body" class="rp-sel" [ariaLabel]="'De dónde sale el dinero de ' + nombre(f.g.sucursal)"></p-select>
                          <p-button [label]="'Reponer ' + reponibles(f.g).length" icon="pi pi-check" size="small"
                                    [disabled]="!eleccion(f.g) || !!ocupado()" [loading]="ocupado() === f.clave"
                                    (onClick)="reponer(f.g)"></p-button>
                        </div>
                      }
                      @if (reponibles(f.g).length) {
                        <small class="fin-dim">{{ f.g.por_hoja ? textoZona
                          : f.g.retiro_sugerido ? f.g.retiro_sugerido.razon
                          : 'Saca ' + money(pagable(montoReponible(f.g))) + ' de CAOS; el retiro aparece aquí cuando se sincroniza.' }}</small>
                      }
                    }
                    @case ('sin_vincular') {
                      @if (f.g.propuesta) {
                        <p-button [label]="esSuperadmin() ? 'Revisar y vincular' : 'Ver la propuesta'" icon="pi pi-link" size="small"
                                  severity="secondary" [outlined]="true" (onClick)="abrir(f.clave)"></p-button>
                      } @else if (f.g.por_hoja) {
                        <!-- [CGA-A.65] «Sin retiro claro» sería falso: el retiro existe, es de las dos sucursales y no del renglón. -->
                        <small class="fin-dim">{{ textoZona }}</small>
                      } @else {
                        <small class="fin-dim">Sin retiro claro de esta sucursal y de estos días.</small>
                      }
                    }
                    @default {
                      <!-- [LE.6.21] Lo explicado dice con qué retiro (o del cajón), no «Nada pendiente». -->
                      <span class="rp-pagado">{{ textoPagoGrupo(f.g) }}</span>
                    }
                  }
                  @if (f.g.n_sin_aprobar) {
                    <!-- [CGA-A.62] Sin aprobación no se repone: se firma en su pantalla y vuelve solo. -->
                    @if (puedeAprobar()) {
                      <a class="rp-link" routerLink="/finanzas/aprobacion-gastos">
                        <i class="pi pi-arrow-right" aria-hidden="true"></i>
                        {{ f.g.n_sin_aprobar === 1 ? '1 gasto espera' : f.g.n_sin_aprobar + ' gastos esperan' }} firma o se rechazó: no se repone. Ir a Aprobación de gastos
                      </a>
                    } @else {
                      <small class="fin-dim">{{ f.g.n_sin_aprobar === 1 ? '1 gasto espera' : f.g.n_sin_aprobar + ' gastos esperan' }} firma en Aprobación de gastos o se rechazó: no se repone.</small>
                    }
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #expandedrow let-f>
              <tr>
                <td colspan="4" class="rp-det" role="cell">
                  <p class="rp-desglose">
                    Kepler <span class="rp-mono">{{ money(f.g.total) }}</span> = de CAOS <span class="rp-mono">{{ money(f.g.caos) }}</span>
                    + del cajón <span class="rp-mono">{{ money(f.g.cajon) }}</span>
                    + por resolver <span class="rp-mono">{{ money(porResolverDe(f.g)) }}</span>
                  </p>
                  @if (f.g.propuesta; as p) {
                    <div class="rp-prop" role="group" [attr.aria-label]="'Propuesta de vínculos para ' + nombre(f.g.sucursal)">
                      <p class="rp-prop-t"><i class="pi pi-bolt" aria-hidden="true"></i> <strong>Propuesta del sistema</strong> <span class="fin-dim">— la confirma una persona</span></p>
                      <p class="rp-razon">{{ p.razon }}.</p>
                      <p-table [value]="p.asignaciones" size="small" class="rp-mini">
                        <ng-template #header>
                          <tr><th>Egreso</th><th>Documento</th><th>Retiro de CAOS</th><th class="rp-num-h">Monto</th></tr>
                        </ng-template>
                        <ng-template #body let-a>
                          <tr>
                            <td class="rp-mono dt-id" data-label="Egreso" role="cell">{{ a.cg_folio }}</td>
                            <td class="rp-mono rp-dim" data-label="Documento" role="cell">{{ folioDoc(a.origen_ref) }}</td>
                            <td data-label="Retiro de CAOS" role="cell"><span>«{{ a.ref ?? ('retiro ' + a.external_id) }}» <span class="rp-dim">· {{ a.external_id }}</span></span></td>
                            <td class="rp-num dt-num" data-label="Monto" role="cell">{{ money(a.monto) }}</td>
                          </tr>
                        </ng-template>
                      </p-table>
                      <div class="rp-prop-pie">
                        @if (esSuperadmin()) {
                          <p-button [label]="'Confirmar ' + p.asignaciones.length + (p.asignaciones.length === 1 ? ' vínculo por ' : ' vínculos por ') + money(p.monto)"
                                    icon="pi pi-check" size="small" [disabled]="!!ocupado()" [loading]="ocupado() === f.clave"
                                    (onClick)="vincular(f.g)"></p-button>
                          <small class="fin-dim">Se guardan todos o ninguno.@if (p.queda > 0) { Quedan {{ money(p.queda) }} sin retiro. }</small>
                        } @else {
                          <small class="fin-dim">Vincular es de superadmin: pídeselo a supervisión.</small>
                        }
                      </div>
                    </div>
                  }
                  <p-table [value]="f.g.docs" size="small" class="rp-mini">
                    <ng-template #header>
                      <tr>
                        <th>Documento de Kepler</th><th>Beneficiario</th><th>Clase</th><th>Aprobación</th><th>Egreso</th>
                        <th>De dónde salió</th><th class="rp-num-h">Falta</th><th class="rp-num-h">Monto</th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-d>
                      <tr>
                        <td class="rp-mono dt-id" data-label="Documento de Kepler" role="cell">{{ d.doc_tipo }} {{ d.folio }}
                          @if (!d.en_kepler) { <p-tag severity="warn" value="ya no está en Kepler"></p-tag> }
                        </td>
                        <td data-label="Beneficiario" role="cell">{{ d.beneficiario ?? '—' }}</td>
                        <td data-label="Clase" role="cell">{{ d.clase === 'nomina' ? 'Nómina' : 'Gasto' }}</td>
                        <td class="rp-aprob rp-apila" data-label="Aprobación" role="cell">
                          @if (d.aprobacion; as a) {
                            <p-tag [severity]="severidadAprobacion(a)" [value]="etiquetaAprobacion(a)"></p-tag>
                            @if (a.estado !== 'aprobado_antes') { <small class="rp-dim">{{ a.texto }}</small> }
                          } @else {
                            <span class="rp-dim">sin medir</span>
                          }
                        </td>
                        <td class="rp-mono" data-label="Egreso" role="cell">{{ d.cg_folio ?? 'por capturar' }}</td>
                        <td class="rp-apila" data-label="De dónde salió" role="cell">
                          @for (v of d.vinculos; track v.link_id) {
                            <div class="rp-vinc">
                              <span>«{{ v.ref ?? ('retiro ' + v.external_id) }}» <span class="rp-mono">{{ money(v.monto) }}</span></span>
                              @if (esSuperadmin()) {
                                <p-button label="Cambiar retiro" icon="pi pi-arrow-right-arrow-left" size="small" severity="secondary"
                                          [text]="true" [disabled]="!!ocupado()" (onClick)="abrirMover(v, d)"></p-button>
                              }
                            </div>
                          } @empty {
                            <span class="rp-dim">{{ textoOrigen(d) }}</span>
                          }
                        </td>
                        <td class="rp-num dt-num" data-label="Falta" role="cell" [class.rp-falta]="d.estado === 'sin_vincular'">{{ d.falta > 0 ? money(d.falta) : '—' }}</td>
                        <td class="rp-num dt-num" data-label="Monto" role="cell">{{ money(d.monto) }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </details>

      <!-- [LE.6.25] Lo que oficinas pagó a cuenta de una sucursal: se le CARGA, no se le repone. Va aparte
           para que nadie lo busque en la reposición ni lo confunda con ella. -->
      @if (cargosOficinas().length) {
        <details class="rp-plegable" data-testid="rp-oficinas">
          <summary>
            <strong>Pagado por oficinas a cuenta de una sucursal:</strong>
            {{ cargosOficinas().length }} {{ cargosOficinas().length === 1 ? 'pago' : 'pagos' }} ({{ money(totalCargosOficinas()) }})
            <span class="rp-dim"> · no se repone: se le carga a la sucursal</span>
          </summary>
          <p class="rp-desglose">Salieron de la caja de oficinas con el centro de costo «Compra proveedor» de la sucursal en Kepler. Los gastos de oficinas no dicen sucursal: no están aquí.</p>
          <p-table [value]="cargosOficinas()" size="small" class="rp-mini">
            <ng-template #header>
              <tr><th>Se carga a</th><th>Día</th><th>Documento de Kepler</th><th>Beneficiario</th><th class="rp-num-h">Importe</th></tr>
            </ng-template>
            <ng-template #body let-c>
              <tr>
                <td data-label="Se carga a" role="cell">
                  {{ c.sucursal ? nombre(c.sucursal) : 'sin sucursal' }}
                  <small class="rp-dim d-block">{{ c.centro }}{{ c.centro_nombre ? ' · ' + c.centro_nombre : '' }}</small>
                </td>
                <td class="rp-mono" data-label="Día" role="cell">{{ dmy(c.fecha_valor) }}</td>
                <td class="rp-mono dt-id" data-label="Documento de Kepler" role="cell">X-D-26 {{ c.folio }}@if (c.referencia) { <small class="rp-dim d-block">{{ c.referencia }}</small> }</td>
                <td data-label="Beneficiario" role="cell">{{ c.beneficiario ?? '—' }}</td>
                <td class="rp-num dt-num" data-label="Importe" role="cell">{{ money(c.importe) }}</td>
              </tr>
            </ng-template>
          </p-table>
        </details>
      }

      @if (datos(); as d) {
        <p class="rp-universo fin-dim">
          @for (z of d.universo.en_hoja ?? []; track z.zona) {
            {{ nombreZona(z.zona) }}: {{ z.n }} {{ z.n === 1 ? 'pago' : 'pagos' }} de estos días ({{ money(z.total) }}) van en su hoja, no en la lista por sucursal.
          }
          @for (z of d.universo.antes_de_hoja ?? []; track z.zona) {
            {{ nombreZona(z.zona) }}: {{ z.n }} {{ z.n === 1 ? 'pago' : 'pagos' }} de antes del {{ dmy(z.desde) }} ({{ money(z.total) }}) nunca entraron al libro; no se capturan hoy (caerían en el corte de hoy).
          }
          @if (d.universo.sin_documentos.length) {
            Sin documentos de caja en estos días: {{ nombres(d.universo.sin_documentos) }}.
          }
          {{ textoAprobacion() }}
          Oficinas no se repone: Caja General paga directo lo suyo.
          <!-- [LE.6.25] Sin cargos se DICE (el bloque no aparece); una API vieja no manda el campo y se calla. -->
          @if (d.cargado_por_oficinas?.length === 0) {
            <span data-testid="rp-oficinas-cero">En estos días oficinas no pagó nada a cuenta de una sucursal.</span>
          }
        </p>
      }
    </div>
    </app-side-peek>

    <!-- appendTo body: se abre DESDE la ventana y tiene que quedar encima de ella, no adentro. -->
    <!-- [LE.6.34] Mientras el cambio va en camino no se cierra: con la X o Esc PrimeNG se ocultaba, cerrarMover()
         lo ignoraba y la ventana quedaba trabada (oculta para PrimeNG, abierta para la pantalla). -->
    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="mover() !== null" (visibleChange)="$event ? null : cerrarMover()" [modal]="true" appendTo="body"
              [closable]="ocupado() !== 'mover'" [closeOnEscape]="ocupado() !== 'mover'"
              header="Cambiar de retiro" [style]="{ width: '34rem' }" [draggable]="false">
      @if (mover(); as m) {
        <div class="rp-mover">
          <p>{{ m.folio }} toma hoy <strong class="rp-mono">{{ money(m.vinculo.monto) }}</strong> de «{{ m.vinculo.ref ?? ('retiro ' + m.vinculo.external_id) }}». Pásalo a:</p>
          <p-select [options]="opcionesDestino()" [(ngModel)]="destinoMover" optionLabel="label" optionValue="value"
                    placeholder="Elige el retiro" appendTo="body" class="rp-sel-ancho" ariaLabel="Retiro destino"></p-select>
          <label class="rp-lbl" for="rp-motivo">Por qué (mínimo 10 letras)</label>
          <input pInputText id="rp-motivo" [(ngModel)]="motivoMover" class="rp-sel-ancho"
                 placeholder="Ej. la nómina de Canindo salió de «nom canindo»" />
          <small class="fin-dim">La baja queda con tu nombre y el motivo; si el destino tiene menos libre, toma lo que alcance y el resto se dice.</small>
        </div>
      }
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" [text]="true" [disabled]="ocupado() === 'mover'" (onClick)="cerrarMover()"
                  data-testid="rp-mover-cancelar"></p-button>
        <p-button label="Cambiar de retiro" icon="pi pi-check" [disabled]="!destinoMover || motivoMover.trim().length < 10 || !!ocupado()"
                  [loading]="ocupado() === 'mover'" (onClick)="confirmarMover()"></p-button>
      </ng-template>
    </p-dialog>

    <!-- Edgar, 2026-10-30: «cuando sea de cajón que se haga un arqueo». [LE.6.19] PM, 2026-11-06: «toda reposición
         que salga del cajón se hace con arqueo» — también el pico que el cajón pone a un retiro de CAOS. -->
    <!-- [LE.6.34] Con piezas contadas la ventana no se cierra sola (X, Esc o «Volver» preguntan antes de tirar
         el conteo), y mientras paga no se cierra: cerrarla a medio envío perdía el resultado. -->
    <p-dialog appDevolverFoco closeAriaLabel="Cerrar" [visible]="contando() !== null" (visibleChange)="$event ? null : cerrarConteo()" [modal]="true" appendTo="body"
              [closable]="!conteoTrabado()" [closeOnEscape]="!conteoTrabado()"
              [header]="'Pagar ' + (contando()?.titulo ?? '') + ': arqueo de lo que sale del cajón'" [style]="{ width: '38rem' }" [draggable]="false">
      @if (contando(); as c) {
        <app-conteo-cajon [total]="c.total" [(piezas)]="conteoPiezas" [(morralla)]="conteoMorralla" />
      }
      <!-- El error del pago va aquí, junto al conteo: un toast detrás de la ventana no se lee. -->
      @if (conteoErr(); as e) { <p class="rp-conteo-err" role="alert" data-testid="rp-conteo-err">{{ e }}</p> }
      <ng-template #footer>
        <app-descartar-cambios etiqueta="Volver" [sucio]="hayPiezas()" [bloqueado]="!!ocupado()" (cerrar)="descartarConteo()" />
        <!-- data-conteo-siguiente: Enter desde la última pieza viene aquí, no a «Volver». -->
        <p-button data-conteo-siguiente data-testid="rp-pagar-conteo" [label]="'Pagar ' + (contando()?.titulo ?? '')" icon="pi pi-check"
                  [disabled]="!conteoListo() || !!ocupado()"
                  [loading]="ocupado() === contando()?.clave" (onClick)="pagarConCajon()"></p-button>
      </ng-template>
    </p-dialog>
  `,
  styles: [
    FINANZAS_SHARED_STYLES,
    `
    /* [CGA-A.63] Sin container-type: lo único que pinta es la ventana, y las consultas de la tabla
       ya miden su propia caja (el dt-scope de app-load-state). */
    :host { display:block; }
    /* En teléfono la tabla se apila (dt-stack) y el apilado ALCANZA a las tablas del desglose: viven
       adentro, así que también pierden su encabezado; por eso todas sus celdas llevan data-label. */
    @container densetable (max-width: 34rem) {
      .rp-apila { flex-direction:column; align-items:flex-start; }
      .rp-col-tog { width:auto; }
      .rp-cifra { text-align:left; }
    }
    /* Encabezado de columna: --fs-micro, mayúsculas y atenuado (DESIGN.md, escala tipográfica). Antes
       heredaba el tamaño del cuerpo y en negritas: pesaba más que las cifras que nombra. */
    :host ::ng-deep .rp-tbl .p-datatable-thead > tr > th,
    :host ::ng-deep .rp-pagar .p-datatable-thead > tr > th,
    :host ::ng-deep .rp-ctl .p-datatable-thead > tr > th,
    :host ::ng-deep .rp-mini .p-datatable-thead > tr > th {
      font-family:var(--font-body); font-size:var(--fs-micro); font-weight:700; text-transform:uppercase;
      letter-spacing:.06em; color:var(--text-muted);
    }
    .rp-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin-bottom:var(--sp-2); }
    .rp-sp { flex:1 1 auto; }
    .rp-warn { color:var(--warn-soft-fg); font-size:var(--fs-xs); }
    .rp-kpis { display:block; margin-bottom:var(--sp-3); }
    .rp-hojas { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin:0 0 var(--sp-2);
                font-size:var(--fs-sm); color:var(--fg-2); }
    /* [LE.6.36] Dos bloques, uno por acto. El grupo lo hace el espacio, no una caja (Gestalt). */
    .rp-bloque { margin:0 0 var(--sp-5); }
    .rp-t { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin:0 0 var(--sp-2);
            font-size:var(--fs-sm); font-weight:700; color:var(--fg-1); }
    .rp-t-cifra { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-lg); }
    .rp-control-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); justify-content:space-between; }
    .rp-nota { margin:0 0 var(--sp-2); font-size:var(--fs-xs); color:var(--text-muted); }
    .rp-sub { display:block; font-family:var(--font-body); font-size:var(--fs-xs); color:var(--text-muted); }
    .rp-tog { width:2rem; height:2rem; padding:0; }
    .rp-falta-linea { margin:0 0 var(--sp-2); font-weight:600; color:var(--fg-1); }
    .rp-porque { margin:0 0 var(--sp-2); font-size:var(--fs-sm); color:var(--fg-2); }
    .rp-porque > summary { cursor:pointer; color:var(--text-muted); }
    .rp-porque > p { margin:var(--sp-1) 0 0; max-width:70rem; }
    .rp-plegable { margin:0 0 var(--sp-2); font-size:var(--fs-sm); color:var(--fg-2); }
    .rp-plegable > summary { cursor:pointer; padding:var(--sp-1) 0; }
    .rp-pagado { font-size:var(--fs-sm); color:var(--fg-2); }
    .rp-plegable > summary:focus-visible, .rp-porque > summary:focus-visible { outline:2px solid var(--focus-ring, var(--action)); outline-offset:2px; }
    .rp-dim { color:var(--text-muted); }
    .rp-num-h { text-align:right; }
    .rp-num { text-align:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .rp-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    /* Dos líneas por celda: lo que importa arriba, su contexto abajo (Q.5 por tamaño y contraste, sin color). */
    .rp-quien, .rp-cifra { vertical-align:top; }
    .rp-quien strong { display:block; font-weight:600; color:var(--fg-1); }
    .rp-quien small, .rp-cifra small { display:block; font-size:var(--fs-xs); color:var(--text-muted); }
    .rp-cifra { text-align:right; white-space:nowrap; }
    .rp-cifra strong { display:block; font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-body); font-weight:700; color:var(--fg-1); }
    .rp-dim { color:var(--text-muted); }
    .rp-falta { font-weight:600; color:var(--fg-1); }
    .rp-vencido { color:var(--bad-fg); }
    .rp-col-tog { width:2.5rem; }
    .rp-que { min-width:18rem; }
    .rp-que small { display:block; margin-top:var(--sp-1); max-width:30rem; }
    .rp-accion { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin-top:var(--sp-1); }
    .rp-sel { min-width:14rem; }
    .rp-det { background:var(--surface-2); padding:var(--sp-3); }
    .rp-desglose { margin:0 0 var(--sp-2); color:var(--fg-2); }
    /* [LE.6.35] El renglon que se busco desde la cola: un borde, no un color de fondo que compita con los avisos. */
    .rp-buscado > td { box-shadow: inset 0 0 0 2px var(--focus-ring, var(--action)); }
    .rp-buscado-aviso { margin:0 0 var(--sp-3); padding:var(--sp-2) var(--sp-3); border-radius:var(--r-sm,8px); background:var(--surface-2, var(--card-bg)); border:1px solid var(--border-color); color:var(--text-main); }
    .rp-prop { border:1px solid var(--border-color); border-radius:var(--r-md, 8px); padding:var(--sp-3); margin-bottom:var(--sp-3);
               display:flex; flex-direction:column; gap:var(--sp-2); }
    .rp-prop-t { margin:0; }
    .rp-razon { margin:0; color:var(--fg-2); max-width:70rem; }
    .rp-prop-pie { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); }
    .rp-vinc { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-1); }
    .rp-universo { margin:var(--sp-2) 0 0; }
    .rp-tags { display:flex; flex-wrap:wrap; gap:var(--sp-1); }
    .rp-aprob { min-width:10rem; }
    .rp-aprob small { display:block; margin-top:var(--sp-1); max-width:22rem; }
    .rp-link { display:block; margin-top:var(--sp-1); font-size:var(--fs-xs); color:var(--bad-fg, var(--warn-soft-fg)); }
    .rp-link:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .rp-mover { display:flex; flex-direction:column; gap:var(--sp-2); }
    .rp-mover p { margin:0; }
    .rp-lbl { font-size:var(--fs-xs); color:var(--text-muted); }
    .rp-sel-ancho { width:100%; }
    .rp-conteo-err { margin:var(--sp-3) 0 0; color:var(--bad-fg); font-size:var(--fs-sm); }
    `,
  ],
})
export class CajaReposicionComponent implements OnInit {
  private readonly api = inject(CashLedgerService);
  private readonly caos = inject(CaosService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  // El p-toast lo pone Captura (providers: [MessageService]): este componente vive adentro.
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Reponer es el lote de la cola, y pagar una hoja, su retiro: lo puede quien gestiona la caja. */
  readonly puedeGestionar = input(false);
  /** El libro y la cola cambiaron: Captura los vuelve a leer. */
  readonly cambio = output<void>();

  readonly money = money;
  readonly dmy = dmy;
  readonly pagable = pagableConBilletesCaos;
  /**
   * `[CGA-A.65]` Abastos y Madero: el motor no les propone retiro por sucursal (la hoja en papel los
   * juntaba, y por día les daba el retiro de otra hoja). Lo que espera su hoja de la Suite ya no está
   * en esta lista; lo que queda (antes de la hoja, nómina, compras) lo elige una persona.
   */
  readonly textoZona = 'Se repone por hoja de zona: Abastos y Madero con un solo retiro. El motor no propone uno por sucursal; elige el de su hoja.';

  readonly datos = signal<ReposicionSucursales | null>(null);
  /** `[LE.6.25]` Lo pagado por oficinas a cuenta de una sucursal en la ventana (una API anterior no lo manda). */
  readonly cargosOficinas = computed(() => this.datos()?.cargado_por_oficinas ?? []);
  readonly totalCargosOficinas = computed(() => Math.round(this.cargosOficinas().reduce((a, c) => a + c.importe, 0) * 100) / 100);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /** `[CGA-A.65]` Las hojas de zona. `null` + `hojasNoLeidas` = no se pudo leer: se dice, no se pinta vacío. */
  readonly hojas = signal<HojasDeGastos | null>(null);
  readonly hojasNoLeidas = signal(false);
  /** `[LE.6.36]` Las hojas van en camino: «cargando» no es «nada por pagar». */
  readonly leyendoHojas = signal(false);
  /** `[LE.6.36]` El día de hoy (México) con que se cuentan los días desde el pago; se toma al leer. */
  readonly hoy = signal(todayMx());
  /** `[CGA-A.63]` La ventana de la reposición; la abre el botón de la barra de Captura. */
  readonly abierta = signal(false);
  /** El botón que la abrió: al cerrar, el foco vuelve ahí y no al `<body>`. */
  private origen: HTMLElement | null = null;
  /**
   * ⭐ `[LE.6.36]` El filtro del control de hojas pagadas. Abre en «Esperan depósito», lo vencido primero: es el
   * acto 2 del día (vigilar que llegue). Reemplaza las pestañas «Reposiciones / Historial» (`[LE.6.21]`): lo que
   * hay que PAGAR ya no depende del filtro, va siempre arriba.
   */
  readonly vista = signal<VistaReposicion>('deposito');
  readonly abiertas = signal<Record<string, boolean>>({});
  /** D.7: la fila con el foco de teclado (flechas por `pSelectableRow`; Enter abre su desglose). */
  readonly filaActiva = signal<FilaPagar | FilaControl | FilaGrupo | null>(null);
  /** Lo que está escribiendo (idempotencia visual): la clave de la fila, o `'mover'`. */
  readonly ocupado = signal<string | null>(null);
  private readonly elegidos = signal<Record<string, string>>({});
  /** Lo que se está contando antes de pagar: lo que sale del cajón, todo o el pico del retiro. */
  readonly contando = signal<Conteo | null>(null);
  readonly conteoPiezas = signal<Record<string, number>>({});
  readonly conteoMorralla = signal<number | null>(null);
  readonly conteoListo = computed(() => {
    const c = this.contando();
    return !!c && revisarConteoCajon({ piezas: this.conteoPiezas(), morralla: Number(this.conteoMorralla() ?? 0) }, c.total).ok;
  });
  /** `[LE.6.34]` Hay algo contado: cerrar la ventana lo tira, y se pregunta antes. */
  readonly hayPiezas = computed(() => Object.values(this.conteoPiezas()).some((n) => Number(n) > 0) || Number(this.conteoMorralla() ?? 0) > 0);
  /** `[LE.6.34]` La ventana del conteo no se cierra sola: con piezas (pregunta) o mientras paga. */
  readonly conteoTrabado = computed(() => this.hayPiezas() || !!this.ocupado());
  /** `[LE.6.34]` Por qué no se pagó, dentro de la ventana del conteo (no en un toast detrás de ella). */
  readonly conteoErr = signal<string | null>(null);
  /** De qué pago son las piezas contadas: reabrir el mismo no las borra. */
  private conteoDe: string | null = null;
  private readonly elegidosHoja = signal<Record<string, string>>({});
  /** `[LE.6.19]` La llave de cada pago de una abierta: un reintento (o el doble clic) no paga dos hojas. */
  private readonly llavesAbierta: Record<string, string> = {};
  readonly mover = signal<{ vinculo: ReposicionVinculo; folio: string } | null>(null);
  destinoMover: string | null = null;
  motivoMover = '';

  readonly esSuperadmin = computed(() => this.perms.isSuperadmin());
  /** `[LE.6.20]` ¿Puede abrir Aprobación de gastos? Un enlace a otra pantalla afirma que se puede (su guard pide COMPROBAR). */
  readonly puedeAprobar = computed(() => !this.perms.cargado() || this.perms.has(Permission.FINANCE_EXPENSES_COMPROBAR));
  readonly yo = computed(() => this.auth.user()?.sub ?? null);
  readonly grupos = computed(() => this.datos()?.grupos ?? []);
  /** Se resuelven en la fila: lo que sigue en la cola, o egresos con propuesta de retiro. */
  readonly accionables = computed(() => this.grupos().filter((g) => g.estado === 'por_capturar' || g.n_sin_aprobar > 0
    || (g.estado === 'sin_vincular' && !!g.propuesta)));
  /** Egresos que ningún retiro de su sucursal y de esos días explica. */
  readonly sinRetiro = computed(() => this.grupos().filter((g) => g.estado === 'sin_vincular' && !g.propuesta));
  readonly explicadas = computed(() => this.grupos().filter((g) => g.estado === 'explicada'));
  /** `[CGA-A.65]` Las hojas que paga Caja General: aprobadas, o pagadas con renglones que no entraron al libro. */
  readonly hojasPorPagar = computed(() => (this.hojas()?.cerradas ?? [])
    .filter((h) => h.estado === 'aprobada' || (h.estado === 'pagada' && (h.pago?.sin_capturar ?? 0) > 0)));
  /** `[LE.6.19]` La hoja abierta de cada zona con algo que pagar: se paga aquí, en un acto. */
  readonly abiertasPorPagar = computed(() => (this.hojas()?.abiertas ?? []).filter((a) => a.renglones.length > 0));
  readonly nPorResolver = computed(() => this.accionables().length + this.hojasPorPagar().length + this.abiertasPorPagar().length);
  /**
   * ⭐ `[LE.6.27]` PM, 2026-11-09: el folio del depósito se ve en Reposiciones «para validar que hubo un
   * depósito y que no se regresa dinero que nunca salió». Una hoja pagada sin su `U-A-5` en Kepler (o con
   * el depósito sin medir o ambiguo) NO está validada: se queda en «Esperan depósito» hasta que aparezca.
   * Medido en prod el 9/11: 4 de 13 hojas pagadas tienen su depósito.
   */
  depositoValidado(h: HojaGastos): boolean { return h.pago?.deposito?.estado === 'depositada'; }
  readonly hojasSinDeposito = computed(() => (this.hojas()?.cerradas ?? [])
    .filter((h) => h.estado === 'pagada' && !(h.pago?.sin_capturar ?? 0) && !this.depositoValidado(h)));
  /**
   * ⭐ `[LE.6.30]` PM, 2026-11-11: *«es por eso que te pedí mostrar los depósitos, para que no pasen estas
   * incidencias»*. VENCIDO = la sucursal ya capturó depósitos después del pago y éste no está: es la
   * incidencia, va PRIMERO en la lista. En espera = Kepler todavía no trae depósitos de esos días.
   */
  depositoVencido(h: HojaGastos): boolean { return h.pago?.deposito?.vencido === true; }
  /**
   * ⭐ `[LE.6.31]` El estado de cuenta de la zona es el segundo testigo: el dinero está en el banco y sólo falta su
   * `U-A-5` en Kepler. No es vencido; se queda en «Esperan depósito» hasta que se capture.
   */
  enBancoSinKepler(h: HojaGastos): boolean { return !this.depositoValidado(h) && h.pago?.deposito?.banco?.estado === 'encontrado'; }
  /** La etiqueta larga de lo que se buscó (va al detalle, con la nota del servidor). */
  etiquetaSinDeposito(h: HojaGastos): string {
    const b = h.pago?.deposito?.banco?.estado;
    if (b === 'encontrado') return 'En el banco, falta en Kepler';
    if (b === 'no_aparece') return 'No llegó al banco';
    const v = h.pago?.deposito?.vencido;
    return v === true ? 'Depósito vencido' : v === false ? 'Esperando el depósito' : 'Falta el depósito';
  }
  readonly hojasVencidas = computed(() => this.hojasSinDeposito().filter((h) => this.depositoVencido(h)));
  readonly hojasEnEspera = computed(() => this.hojasSinDeposito().filter((h) => !this.depositoVencido(h)));
  /** `[LE.6.21]` Las hojas de zona ya pagadas, con todo en el libro y (`[LE.6.27]`) su depósito: «Repuestas». */
  readonly hojasPagadas = computed(() => (this.hojas()?.cerradas ?? [])
    .filter((h) => h.estado === 'pagada' && !(h.pago?.sin_capturar ?? 0) && this.depositoValidado(h)));

  // ── `[LE.6.36]` Acto 1: lo que hay que pagar hoy ──────────────────────────────────────────────

  /** Una fila por zona con algo que pagar (la abierta) y lo que quedó del carril viejo con su acción. */
  readonly porPagar = computed<FilaPagar[]>(() => [
    ...this.abiertasPorPagar().map((a) => ({ tipo: 'abierta' as const, clave: `abierta|${a.zona}`, a })),
    ...this.hojasPorPagar().map((h) => ({ tipo: 'hoja' as const, clave: `hoja|${h.id}`, h })),
  ]);
  /** Lo que sale hoy: las abiertas y las aprobadas. Una pagada con algo sin capturar ya salió: no suma. */
  readonly totalPorPagar = computed(() => Math.round((this.abiertasPorPagar().reduce((t, a) => t + a.total, 0)
    + this.hojasPorPagar().filter((h) => h.estado === 'aprobada').reduce((t, h) => t + h.total, 0)) * 100) / 100);

  /**
   * ⭐ `[LE.6.36]` La respuesta en una línea (Q.1): tres cifras, una por pregunta del día, cada una de SU lista.
   * Reemplazan las tres tiras viejas (no se suman a ellas). Sin hojas leídas se declaran «no medido», nunca $0.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    if (!this.hojas()) {
      const nota = this.hojasNoLeidas() ? 'Las hojas de zona no se pudieron leer' : 'Leyendo las hojas de zona';
      return (['Por pagar hoy', 'Esperan depósito', 'Repuestas'] as const).map((label) => ({
        label, value: this.hojasNoLeidas() ? 'sin leer' : 'leyendo…', format: 'text' as const, state: 'no_medido' as const, stateNote: nota,
      }));
    }
    const zonas = this.porPagar().length;
    const espera = this.hojasSinDeposito();
    const nv = this.hojasVencidas().length;
    const repuestas = this.hojasPagadas().length;
    // `[LE.6.31]` La que ya está en el banco sigue esperando su U-A-5 (está en la lista), pero se dice aparte.
    const enBanco = espera.filter((h) => this.enBancoSinKepler(h)).length;
    return [
      { label: 'Por pagar hoy', value: this.totalPorPagar(), format: 'currency2', tone: 'default',
        sub: zonas ? `${zonas} ${zonas === 1 ? 'renglón' : 'renglones'} con su botón` : 'nada por pagar' },
      { label: 'Esperan depósito', value: Math.round(espera.reduce((t, h) => t + h.total, 0) * 100) / 100, format: 'currency2',
        tone: nv ? 'bad' : espera.length ? 'warn' : 'ok',
        sub: `${espera.length} ${espera.length === 1 ? 'hoja' : 'hojas'}${nv ? ` · ${nv} ${nv === 1 ? 'vencida' : 'vencidas'}` : ''}`
          + (enBanco ? ` · ${enBanco} ya en el banco` : '') },
      { label: 'Repuestas', value: repuestas, format: 'number', tone: 'muted', sub: 'con su U-A-5 en Kepler' },
    ];
  });

  // ── `[LE.6.36]` Acto 2: vigilar el depósito de cada hoja pagada ────────────────────────────────

  /**
   * Las hojas del filtro. «Esperan depósito»: lo vencido primero, después lo que espera. «Repuestas»: las que ya
   * tienen su `U-A-5`. «Todas»: cada hoja que mandó el servidor (también las del carril viejo), lo vencido primero.
   */
  readonly hojasControl = computed<FilaControl[]>(() => {
    const v = this.vista();
    const vencidas = this.hojasVencidas();
    const lista = v === 'deposito' ? [...vencidas, ...this.hojasEnEspera()]
      : v === 'repuestas' ? this.hojasPagadas()
        : [...vencidas, ...(this.hojas()?.cerradas ?? []).filter((h) => !vencidas.includes(h))];
    return lista.map((h) => ({ clave: `ctl|${h.id}`, h }));
  });
  /** Los conteos van DENTRO del nombre del filtro: sin hojas leídas no hay conteo (no se dibuja un cero). */
  readonly opcionesVista = computed<SegOption[]>(() => {
    const h = this.hojas();
    return [
      { label: 'Esperan depósito', value: 'deposito', count: h ? this.hojasSinDeposito().length : undefined },
      { label: 'Repuestas', value: 'repuestas', count: h ? this.hojasPagadas().length : undefined },
      { label: 'Todas', value: 'todas', count: h ? h.cerradas.length : undefined },
    ];
  });
  readonly vacioControl = computed(() => {
    const v = this.vista();
    if (v === 'deposito') return { titulo: 'Ninguna hoja espera su depósito', pista: 'Cada hoja pagada ya tiene su U-A-5 en Kepler.' };
    if (v === 'repuestas') return { titulo: 'Ninguna hoja repuesta todavía', pista: 'Una hoja pasa aquí cuando aparece su U-A-5 en Kepler.' };
    return { titulo: 'Sin hojas de zona', pista: 'Todavía no se ha cerrado ninguna hoja.' };
  });

  /** El día de México de una marca de tiempo del servidor. */
  diaMx(valor: string | null | undefined): string { return diaMxDe(valor); }

  /** Días desde el ancla del depósito (el día del retiro, o el del pago si salió del cajón), como el servidor. */
  diasDesdePago(h: HojaGastos): number | null {
    const p = h.pago;
    if (!p) return null;
    const ancla = p.retiro?.dia ?? diaMxDe(p.pagada_at);
    const hoy = this.hoy();
    if (!/^\d{4}-\d{2}-\d{2}/.test(ancla) || !/^\d{4}-\d{2}-\d{2}/.test(hoy)) return null;
    const dia = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
    return Math.max(0, Math.round((dia(hoy) - dia(ancla)) / 86_400_000));
  }

  /**
   * ⭐ `[LE.6.36]` El depósito en una frase corta (≤ 8 palabras), con icono y severidad. Lo largo va al detalle.
   * ⛔ Sin medir no es vencido ni «$0»: es «cuenta sin medir». La incidencia (vencido, no llegó) es la única roja.
   */
  estadoDeposito(h: HojaGastos): EstadoDeposito {
    const p = h.pago;
    if (!p) {
      if (h.estado === 'aprobada') return { texto: 'por pagar', icono: 'pi pi-arrow-up', sev: 'secondary' };
      if (h.estado === 'cerrada') return { texto: 'espera aprobación', icono: 'pi pi-clock', sev: 'secondary' };
      return { texto: h.estado === 'rechazada' ? 'rechazada' : h.estado === 'cancelada' ? 'cancelada' : 'sin pagar', icono: 'pi pi-ban', sev: 'secondary' };
    }
    if (p.sin_capturar) return { texto: `falta capturar ${p.sin_capturar}`, icono: 'pi pi-exclamation-circle', sev: 'warn' };
    const d = p.deposito;
    if (d.estado === 'depositada') {
      const f = d.depositos?.[0]?.folio;
      return { texto: f ? `U-A-5 ${f}` : 'depositada', icono: 'pi pi-check-circle', sev: 'success' };
    }
    if (d.estado === 'sin_medir') return { texto: 'cuenta sin medir', icono: 'pi pi-question-circle', sev: 'secondary' };
    if (d.estado === 'ambiguo') return { texto: 'varios depósitos posibles', icono: 'pi pi-question-circle', sev: 'warn' };
    const b = d.banco?.estado;
    if (b === 'encontrado') return { texto: 'en el banco, falta en Kepler', icono: 'pi pi-building', sev: 'info' };
    if (b === 'no_aparece') return { texto: 'no llegó al banco', icono: 'pi pi-times-circle', sev: 'danger' };
    const n = this.diasDesdePago(h);
    if (d.vencido === true) {
      return { texto: n === null ? 'vencido' : `vencido · ${n} ${n === 1 ? 'día' : 'días'}`, icono: 'pi pi-times-circle', sev: 'danger' };
    }
    if (d.vencido === false) {
      const t = n === null ? 'esperando' : n === 0 ? 'esperando · pagada hoy' : n <= 7 ? `esperando · día ${n} de 7` : `esperando · ${n} días`;
      return { texto: t, icono: 'pi pi-clock', sev: 'secondary' };
    }
    return { texto: 'falta el depósito', icono: 'pi pi-exclamation-circle', sev: 'warn' };
  }

  /** Quién deposita y captura el `U-A-5` de una zona: sus sucursales, por nombre. */
  private sucursalesDe(h: HojaGastos): string {
    const z = ZONAS_HOJA_GASTOS.find((x) => x.clave === h.zona);
    const suc = z ? [...z.sucursales] : h.por_sucursal.filter((s) => s.renglones).map((s) => s.sucursal);
    return suc.length ? suc.map((s) => warehouseName(s)).join(' o ') : h.nombre_zona;
  }

  /** ⭐ `[LE.6.36]` En una línea: qué falta y quién lo hace. La explicación completa va plegada debajo. */
  queFalta(h: HojaGastos): string {
    const p = h.pago;
    if (!p) {
      if (h.estado === 'aprobada') return 'Falta pagarla: arriba, en «Por pagar hoy».';
      if (h.estado === 'cerrada') return 'Falta que finanzas la apruebe (carril de antes).';
      return `${h.estado === 'rechazada' ? 'Rechazada' : 'Cancelada'}: no se paga.`;
    }
    if (p.sin_capturar) return `Faltan ${p.sin_capturar} ${p.sin_capturar === 1 ? 'pago' : 'pagos'} en el libro: «Capturar lo que falta», arriba.`;
    const d = p.deposito;
    const quien = this.sucursalesDe(h);
    if (d.estado === 'depositada') return 'Nada: su depósito está en Kepler y cuadra.';
    if (d.estado === 'sin_medir') return 'No se puede validar: la clave de banco de la zona no está medida.';
    if (d.estado === 'ambiguo') return 'Falta que una persona ligue cuál de los depósitos es el suyo.';
    if (d.banco?.estado === 'encontrado') return `Falta capturar su U-A-5 en Kepler: lo captura ${quien}.`;
    if (d.banco?.estado === 'no_aparece') return `Falta que ${quien} deposite ${money(h.total)} en la ${d.banco.cuenta ?? 'cuenta de la zona'}.`;
    if (d.vencido === true) return `Falta su depósito de ${money(h.total)}: lo deposita y lo captura ${quien}.`;
    if (d.vencido === false) return `Falta su depósito: ${quien} todavía no captura depósitos de después del pago.`;
    return `Falta su depósito de ${money(h.total)}: lo deposita y lo captura ${quien}.`;
  }

  /**
   * ⭐ `[LE.6.36]` La zona cuya cuenta de depósito no está medida, dicha UNA vez junto al filtro (Canindo hoy: su
   * cuenta no está en el catálogo de bancos). Junta lo que dice la hoja abierta (`banco.cuenta: null`) y lo que
   * dicen las pagadas (banco `sin_cuenta`, o la clave de Kepler sin medir).
   */
  readonly zonasSinMedir = computed<Array<{ zona: string; texto: string }>>(() => {
    const h = this.hojas();
    if (!h) return [];
    const zonas = new Map<string, { nombre: string; banco: boolean; kepler: boolean }>();
    const marca = (zona: string, nombre: string, que: 'banco' | 'kepler') => {
      const z = zonas.get(zona) ?? { nombre, banco: false, kepler: false };
      z[que] = true;
      zonas.set(zona, z);
    };
    for (const a of h.abiertas ?? []) {
      if (!a.banco?.cuenta && (a.renglones.length || (a.sin_deposito ?? []).length)) marca(a.zona, a.nombre, 'banco');
    }
    for (const c of h.cerradas ?? []) {
      const d = c.pago?.deposito;
      if (!d) continue;
      if (d.banco?.estado === 'sin_cuenta') marca(c.zona, c.nombre_zona, 'banco');
      if (d.estado === 'sin_medir') marca(c.zona, c.nombre_zona, 'kepler');
    }
    return [...zonas.entries()].map(([zona, z]) => ({
      zona,
      texto: z.kepler
        ? `${z.nombre}: la clave de banco donde se deposita su reposición no está medida; su depósito no se puede validar.`
        : `${z.nombre}: la cuenta donde se deposita su reposición no está medida: no se sabe qué ya se repuso por banco; su depósito se valida sólo con el U-A-5 de Kepler.`,
    }));
  });

  /**
   * `[LE.6.20]` Lo de cada zona que NO va en la hoja: lo que el banco cubre sin depósito (por día, con su motivo) y
   * los tramos ya repuestos (hoja en papel o depósito, con su testigo). Una sola tabla, no un plegable por zona.
   */
  readonly fueraDeHoja = computed(() => (this.hojas()?.abiertas ?? []).flatMap((a) => {
    const porDia = new Map<string, { zona: string; desde: string; hasta: string; n: number; total: number; texto: string; sin: true }>();
    for (const r of a.sin_deposito ?? []) {
      const x = porDia.get(r.fecha_pago) ?? { zona: a.nombre, desde: r.fecha_pago, hasta: r.fecha_pago, n: 0, total: 0, texto: `Sin depósito: ${r.motivo}`, sin: true as const };
      x.n += 1;
      x.total = Math.round((x.total + r.importe) * 100) / 100;
      porDia.set(r.fecha_pago, x);
    }
    const sin = [...porDia.values()].sort((p, q) => p.desde.localeCompare(q.desde));
    const ya = (a.ya_repuestos ?? []).map((d) => ({ zona: a.nombre, desde: d.desde, hasta: d.hasta, n: d.renglones, total: d.total,
      texto: `Ya se repuso con ${d.como === 'papel' ? 'hoja en papel: ' : ''}${d.testigo}`, sin: false as const }));
    return [...sin, ...ya];
  }));
  /** `[LE.6.20]` Hasta qué día se ve el banco de cada zona: sin eso, «sin depósito» no se puede leer. */
  readonly bancosDeZonas = computed(() => (this.hojas()?.abiertas ?? []).filter((a) => a.banco?.cuenta)
    .map((a) => `${a.nombre}: cuenta ${a.banco.cuenta} cargada al ${a.banco.cargado_hasta ? dmy(a.banco.cargado_hasta) : 'sin movimientos'}`).join(' · '));
  readonly nSinDeposito = computed(() => this.fueraDeHoja().filter((d) => d.sin).reduce((t, d) => t + d.n, 0));
  readonly resumenFuera = computed(() => {
    const sin = this.fueraDeHoja().filter((d) => d.sin);
    const ya = this.fueraDeHoja().filter((d) => !d.sin);
    const partes: string[] = [];
    const n = this.nSinDeposito();
    if (n) partes.push(`${n} ${n === 1 ? 'pago' : 'pagos'} sin depósito (${money(Math.round(sin.reduce((t, d) => t + d.total, 0) * 100) / 100)})`);
    if (ya.length) partes.push(`${ya.length} ${ya.length === 1 ? 'tramo ya repuesto' : 'tramos ya repuestos'} (${money(Math.round(ya.reduce((t, d) => t + d.total, 0) * 100) / 100)})`);
    return partes.join(' · ');
  });

  // ── `[CGA-A.61]` Otras sucursales: la reposición por sucursal, con sus acciones intactas ──────────

  /** Lo que se resuelve en la fila primero; lo que ningún retiro explica después (la señal de descuadre); lo explicado al final. */
  readonly filasGrupo = computed<FilaGrupo[]>(() => [...this.accionables(), ...this.sinRetiro(), ...this.explicadas()]
    .map((g) => ({ tipo: 'grupo' as const, clave: g.clave, g })));
  /** Abierta si tiene algo que se resuelve en la fila, o si no se pudo leer (el error no se esconde). */
  readonly otrasAbiertas = computed(() => this.accionables().length > 0 || !!this.error());
  readonly resumenOtras = computed(() => {
    const d = this.datos();
    if (!d) return this.error() ? 'no se pudo leer' : 'leyendo…';
    const partes = [`pago del ${dmy(d.desde)} al ${dmy(d.hasta)}`];
    const a = this.accionables().length;
    const s = this.sinRetiro().length;
    const e = this.explicadas().length;
    if (a) partes.push(`${a} por resolver`);
    if (s) partes.push(`${s} sin retiro`);
    if (e) partes.push(`${e} ${e === 1 ? 'explicada' : 'explicadas'}`);
    if (!a && !s && !e) partes.push('nada');
    return partes.join(' · ');
  });

  readonly enEspera = computed<Array<{ clave: string; texto: string }>>(() => (this.hojas()?.cerradas ?? [])
    .filter((c) => c.estado === 'cerrada')
    .map((c) => ({ clave: `c|${c.id}`, texto: `${c.folio} (${c.nombre_zona}, ${money(c.total)}) quedó cerrada en el carril de antes y espera aprobación` })));

  /**
   * `[CGA-A.63]` Lo que dice el botón de la barra sin abrir nada: las mismas cuentas que la ventana, para que
   * lo de afuera y lo de adentro digan lo mismo. Sin importes: el botón es la puerta, la cifra está adentro
   * con su desglose. Lo que no se midió se dice; un Kepler sin medir no es «nada pendiente». `[LE.6.36]` Y los
   * depósitos vencidos, que son la incidencia del acto 2.
   */
  readonly resumen = computed(() => {
    const d = this.datos();
    if (!d) return this.error() ? 'no se pudo leer' : 'leyendo…';
    if (!d.datos_al) return 'Kepler sin medir';
    const partes: string[] = [];
    if (this.nPorResolver()) partes.push(`${this.nPorResolver()} por resolver`);
    if (this.sinRetiro().length) partes.push(`${this.sinRetiro().length} sin retiro`);
    const v = this.hojasVencidas().length;
    if (v) partes.push(`${v} ${v === 1 ? 'depósito vencido' : 'depósitos vencidos'}`);
    if (this.hojasNoLeidas()) partes.push('hojas de zona sin leer');
    if (!d.caos_al) partes.push('CAOS sin medir');
    return partes.length ? partes.join(' · ') : 'nada pendiente';
  });
  /** Lo que se anuncia al lector de pantalla cuando cambia: lo mismo que se ve arriba de cada bloque. */
  readonly anuncio = computed(() => {
    if (!this.hojas()) return this.hojasNoLeidas() ? 'Las hojas de zona no se pudieron leer' : '';
    const n = this.porPagar().length;
    const v = this.hojasVencidas().length;
    return `${n ? n + ' por pagar' : 'Nada por pagar'} · ${this.hojasSinDeposito().length} esperan depósito${v ? `, ${v} vencidas` : ''}`;
  });
  /** El título repite el rótulo del botón —como «Tu jornada»—; el resto va aquí. */
  readonly subtitulo = computed(() => 'pagar cada hoja de zona y vigilar que llegue su depósito');

  /** `[CGA-A.62]` La aprobación de los días de la ventana, en una frase: antes era una cifra en cero. */
  readonly textoAprobacion = computed(() => {
    const sinAprobar = this.grupos().reduce((a, g) => a + g.n_sin_aprobar, 0);
    const antes = this.grupos().reduce((a, g) => a + g.n_pagado_antes_de_aprobar, 0);
    if (!sinAprobar && !antes) return 'Nada espera firma ni se pagó antes de aprobarse.';
    return `${sinAprobar} ${sinAprobar === 1 ? 'gasto espera' : 'gastos esperan'} firma o se rechazó; ${antes} ${antes === 1 ? 'se pagó' : 'se pagaron'} antes de aprobarse.`;
  });

  /** `[LE.6.21]` Con qué se pagó lo explicado: los retiros de CAOS de sus documentos, y lo que puso el cajón. */
  textoPagoGrupo(g: ReposicionGrupo): string {
    const retiros = new Map<string, { ref: string; monto: number }>();
    for (const d of g.docs) {
      for (const v of d.vinculos) {
        const k = `${v.device}|${v.external_id}`;
        const x = retiros.get(k) ?? { ref: v.ref ? `«${v.ref}»` : `retiro ${v.external_id}`, monto: 0 };
        x.monto = Math.round((x.monto + v.monto) * 100) / 100;
        retiros.set(k, x);
      }
    }
    const partes = [...retiros.values()].map((r) => `${r.ref} · ${money(r.monto)}`);
    if (g.cajon > 0.005) partes.push(`del cajón · ${money(g.cajon)}`);
    return partes.length ? partes.join(' + ') : 'Explicada';
  }

  /** `[LE.6.21]` La hoja pagada: con qué salió y si su depósito ya llegó a la cuenta de la zona. */
  textoPagoHoja(h: HojaGastos): string {
    const p = h.pago;
    if (!p) return 'Pagada';
    const con = p.retiro ? `«${p.retiro.ref ?? p.retiro.external_id}» del ${dmy(p.retiro.dia)}${p.cajon > 0.005 ? ` + cajón ${money(p.cajon)}` : ''}`
      : `del cajón · ${money(p.cajon)}`;
    // `[LE.6.24]` El depósito por su folio de Kepler: así se encuentra en la sucursal y en el banco.
    const d = p.deposito.depositos?.[0];
    const dep = p.deposito.estado === 'depositada'
      ? (d?.folio ? `depósito U-A-5 ${d.folio} de ${this.nombre(d.sucursal ?? '')} · cuadra` : 'depositada')
      : p.deposito.estado === 'no_aparece'
        ? (p.deposito.banco?.estado === 'encontrado' ? `el depósito está en la ${p.deposito.banco.cuenta}, falta su U-A-5 en Kepler` : 'el depósito todavía no aparece')
        : p.deposito.estado === 'ambiguo' ? 'el depósito lo liga una persona' : 'depósito sin medir';
    return `${con} · ${dep}`;
  }

  /** `[LE.6.24]` La diferencia del depósito con la hoja, con su signo: «+$0.11», «−$0.23». */
  diferenciaTexto(n: number): string {
    return `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`;
  }

  /** Las opciones de «¿de dónde sale?»: los retiros con dinero libre y el cajón. */
  readonly opcionesOrigen = computed<OpcionOrigen[]>(() => [
    ...(this.datos()?.retiros ?? []).map((r) => ({ label: this.etiquetaRetiro(r), value: this.llave(r) })),
    { label: 'Del cajón (sin retiro)', value: 'cajon' },
  ]);

  /** Los retiros a los que se puede pasar el vínculo abierto: todos menos el suyo. */
  readonly opcionesDestino = computed<OpcionOrigen[]>(() => {
    const m = this.mover();
    return (this.datos()?.retiros ?? [])
      .filter((r) => !m || this.llave(r) !== `${m.vinculo.device}|${m.vinculo.external_id}`)
      .map((r) => ({ label: this.etiquetaRetiro(r), value: this.llave(r) }));
  });

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.reposicion().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.cargando.set(false); },
      error: (e) => { this.error.set(this.textoError(e)); this.cargando.set(false); },
    });
    // `[CGA-A.65]` Las hojas van aparte: si no se pueden leer, la reposición se ve igual y se dice.
    this.hoy.set(todayMx());
    this.leyendoHojas.set(true);
    this.api.hojasDeGastos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => { this.hojas.set(h); this.hojasNoLeidas.set(false); this.leyendoHojas.set(false); this.ubicarBuscado(); },
      error: () => { this.hojas.set(null); this.hojasNoLeidas.set(true); this.leyendoHojas.set(false); this.ubicarBuscado(); },
    });
  }

  /**
   * ⭐ `[LE.6.35]` **Desde la cola, un pago «en hoja» lleva a SU hoja** (PM, 2026-11-19: *«cuando le doy al movimiento
   * de en hoja, no me lleva a la hoja en la que se encuentra»*). Antes la fila abría una captura que el servidor iba a
   * rechazar, y el aviso mandaba a «Finanzas › Gastos › Hoja de zona», una pantalla retirada en LE.6.19.
   * Abre la ventana, y cuando llegan las hojas despliega la de la zona y resalta el renglón; si el pago no está en
   * ninguna hoja que se pague aquí, dice dónde está y por qué.
   *
   * `[LE.6.36]` Ya no fuerza un filtro: un pago de la hoja abierta (o de una aprobada) cae en «Por pagar hoy», que
   * siempre se ve; uno de una hoja ya pagada pone el filtro del control donde está esa hoja (`ubicarBuscado`).
   */
  abrirEn(origenRef: string, origen?: HTMLElement): void {
    this.buscado = origenRef;
    this.resaltado.set(null);
    this.avisoBuscado.set(null);
    this.abrirVentana(origen);
  }
  private buscado: string | null = null;
  /** El renglón que se buscó desde la cola: se resalta en su tabla. */
  readonly resaltado = signal<string | null>(null);
  /** Dónde está (o por qué no está) el pago que se buscó, en palabras. */
  readonly avisoBuscado = signal<string | null>(null);

  private ubicarBuscado(): void {
    const ref = this.buscado;
    if (!ref) return;
    this.buscado = null;
    const doc = this.folioDoc(ref);
    const h = this.hojas();
    if (!h) { this.avisoBuscado.set(`No se pudieron leer las hojas de zona: no se puede ubicar ${doc}. Pulsa Actualizar.`); return; }
    const tiene = (xs: ReadonlyArray<{ origen_ref: string }> | undefined) => !!xs?.some((x) => x.origen_ref === ref);
    for (const a of h.abiertas ?? []) {
      const enFila = a.renglones.length > 0;
      if (tiene(a.renglones) || (enFila && tiene(a.detenidos))) {
        this.abiertas.update((m) => ({ ...m, [`abierta|${a.zona}`]: true }));
        this.resaltado.set(ref);
        this.avisoBuscado.set(tiene(a.renglones)
          ? `${doc} va en la reposición abierta de ${a.nombre}: se paga con ella, en «Por pagar hoy».`
          : `${doc} va en la reposición de ${a.nombre}, pero espera su aprobación: no entra hasta aprobarse.`);
        this.llevarA(ref);
        return;
      }
      const det = a.detenidos.find((x) => x.origen_ref === ref);
      if (det) { this.avisoBuscado.set(`${doc} va en la reposición de ${a.nombre}, pero no entra: ${det.motivo}.`); return; }
      const sd = (a.sin_deposito ?? []).find((x) => x.origen_ref === ref);
      if (sd) { this.avisoBuscado.set(`${doc} es de ${a.nombre} y no se repone aquí: ${sd.motivo}.`); return; }
      const ap = (a.pagados_aparte ?? []).find((x) => x.origen_ref === ref);
      if (ap) { this.avisoBuscado.set(`${doc} ya salió ${ap.como === 'cajon' ? 'del cajón' : 'de un retiro'}${ap.cg_folio ? ` (${ap.cg_folio})` : ''}: ya no se repone.`); return; }
      const fu = a.fuera.find((x) => x.origen_ref === ref);
      if (fu) { this.avisoBuscado.set(`${doc} no va en la reposición de ${a.nombre} (${fu.motivo}): se captura en la cola.`); return; }
    }
    for (const c of h.cerradas ?? []) {
      if (tiene(c.renglones)) {
        // `[LE.6.36]` Arriba si todavía se paga aquí; si no, en el control, con el filtro donde está la hoja.
        if (this.porPagar().some((f) => f.clave === `hoja|${c.id}`)) {
          this.abiertas.update((m) => ({ ...m, [`hoja|${c.id}`]: true }));
          this.avisoBuscado.set(`${doc} va en la hoja ${c.folio} de ${c.nombre_zona}: está en «Por pagar hoy».`);
        } else {
          this.vista.set(this.hojasSinDeposito().includes(c) ? 'deposito' : this.hojasPagadas().includes(c) ? 'repuestas' : 'todas');
          this.abiertas.update((m) => ({ ...m, [`ctl|${c.id}`]: true }));
          this.avisoBuscado.set(`${doc} va en la hoja ${c.folio} de ${c.nombre_zona} (${c.estado}): está abierta en «Hojas pagadas y su depósito».`);
        }
        this.llevarA(ref);
        return;
      }
    }
    this.avisoBuscado.set(`${doc} no aparece en ninguna reposición de esta ventana: puede ser de antes de que su zona empezara a reponerse por hoja.`);
  }

  /** Resalta el renglón buscado y lo trae a la vista cuando ya se pintó. */
  private llevarA(ref: string): void {
    this.resaltado.set(ref);
    afterNextRender(() => this.host.nativeElement.ownerDocument
      .querySelector(`[data-rp-ref="${CSS.escape(ref)}"]`)?.scrollIntoView({ block: 'center' }), { injector: this.injector });
  }

  /** Abre la ventana y RELEE: lo que la cola confirmó desde que se cargó ya no está por capturar. */
  abrirVentana(origen?: HTMLElement): void {
    this.origen = origen ?? null;
    // Abierta desde la barra (no desde un pago buscado): sin aviso ni resaltado de una búsqueda vieja.
    if (!this.buscado) { this.resaltado.set(null); this.avisoBuscado.set(null); }
    this.abierta.set(true);
    this.cargar();
  }

  cerrarVentana(): void {
    this.abierta.set(false);
    // Después del cierre: el cajón todavía tiene el foco en este tick.
    queueMicrotask(() => this.origen?.focus());
  }

  nombre(sucursal: string): string { return warehouseName(sucursal); }
  nombres(sucursales: string[]): string { return sucursales.map((s) => warehouseName(s)).join(' · '); }
  nombreZona(clave: string): string { return ZONAS_HOJA_GASTOS.find((z) => z.clave === clave)?.nombre ?? clave; }
  folioDoc(origenRef: string): string { const [, tipo, folio] = origenRef.split('|'); return `${tipo} ${folio}`; }
  porResolverDe(g: ReposicionGrupo): number { return Math.round((g.sin_vincular + g.por_capturar) * 100) / 100; }
  quienPagar(f: FilaPagar): string { return f.tipo === 'abierta' ? `la reposición de ${f.a.nombre}` : f.h.folio; }
  quienGrupo(g: ReposicionGrupo): string { return `${this.nombre(g.sucursal)} del ${dmy(g.fecha)}`; }

  /** `[CGA-A.62]` Lo que sigue en la cola y SÍ se puede reponer: lo que espera firma o se rechazó, no. */
  reponibles(g: ReposicionGrupo): ReposicionDoc[] {
    return g.docs.filter((d) => d.estado === 'por_capturar' && !d.aprobacion?.bloquea);
  }
  montoReponible(g: ReposicionGrupo): number { return this.reponibles(g).reduce((a, d) => a + d.monto, 0); }

  severidadAprobacion(a: AprobacionPago): 'success' | 'warn' | 'danger' | 'secondary' {
    if (a.bloquea) return 'danger';
    if (a.alerta) return 'warn';
    return a.estado === 'aprobado_antes' ? 'success' : 'secondary';
  }

  etiquetaAprobacion(a: AprobacionPago): string {
    const t: Record<AprobacionPago['estado'], string> = {
      aprobado_antes: 'Aprobado antes', aprobado_despues: 'Aprobado después', vale_despues: 'Vale después del pago',
      solicitud_despues: 'Solicitud después', aprobado_sin_hora: 'Aprobado (sin hora)', cerrado_por_kepler: 'Cerró Kepler',
      sin_firma: 'Espera firma', rechazado: 'Rechazado', sin_vale: 'Sin vale', sin_solicitud: 'Sin solicitud',
    };
    return t[a.estado];
  }

  textoDocs(g: ReposicionGrupo): string {
    const nom = g.docs.filter((d) => d.clase === 'nomina').length;
    const gas = g.docs.length - nom;
    return [gas ? `${gas} ${gas === 1 ? 'gasto' : 'gastos'}` : '', nom ? `${nom} ${nom === 1 ? 'nómina' : 'nóminas'}` : '']
      .filter(Boolean).join(' · ');
  }

  textoEstado(g: ReposicionGrupo): string {
    if (g.estado === 'por_capturar') return `${g.n_por_capturar} por capturar`;
    if (g.estado === 'sin_vincular') return `${g.n_sin_vincular} sin vincular`;
    return 'Explicada';
  }

  textoOrigen(d: ReposicionDoc): string {
    if (d.estado === 'por_capturar') return 'Sigue en la cola';
    if (d.estado === 'sin_vincular') return 'Ningún retiro';
    return d.origen_efectivo === 'cajon' ? 'Del cajón' : 'Cajón (menos de un billete)';
  }

  // ── `[CGA-A.65]` La hoja de zona aprobada: un solo retiro para todos sus pagos ─────────────────

  textoHoja(h: HojaGastos): string {
    const sucursales = h.por_sucursal.filter((s) => s.renglones).map((s) => this.nombre(s.sucursal)).join(' y ');
    return `venta del ${dmy(h.venta_del_dia)} · ${h.renglones.length} ${h.renglones.length === 1 ? 'pago' : 'pagos'} de ${sucursales}`;
  }

  opcionesHoja(h: HojaGastos): OpcionOrigen[] {
    return [
      ...h.retiros_que_cuadran.map((r) => ({
        label: `«${r.ref ?? 'retiro ' + r.external_id}» · ${dmy(r.dia)} · ${money(r.total)} · cajón ${money(r.cajon)}`,
        value: this.llave(r),
      })),
      { label: 'Del cajón entero (excepción, sin retiro)', value: 'cajon' },
    ];
  }

  /** La propuesta ya elegida cuando UN solo retiro cuadra; con varios o ninguno, elige la persona. */
  eleccionHoja(h: HojaGastos): string | null {
    const elegido = this.elegidosHoja()[h.id];
    if (elegido) return elegido;
    return h.retiros_que_cuadran.length === 1 ? this.llave(h.retiros_que_cuadran[0]) : null;
  }

  elegirHoja(h: HojaGastos, valor: string | null): void {
    this.elegidosHoja.update((e) => ({ ...e, [h.id]: valor ?? '' }));
  }

  textoCuadreHoja(h: HojaGastos): string {
    const rs = h.retiros_que_cuadran;
    if (rs.length === 1) return `Cuadra «${rs[0].ref ?? rs[0].external_id}» del ${dmy(rs[0].dia)}: sus ${h.renglones.length} pagos quedan ligados a ese retiro y el cajón pone ${money(rs[0].cajon)}.`;
    if (rs.length > 1) return `${rs.length} retiros cuadran con la hoja: elige el suyo.`;
    return `Ningún retiro libre cuadra: saca ${money(h.instruccion.retiro)} de CAOS (el cajón pone ${money(h.instruccion.cajon)}) y vuelve a leer.`;
  }

  pagarHoja(h: HojaGastos): void {
    const e = this.eleccionHoja(h);
    if (!e || this.ocupado()) return;
    const r = h.retiros_que_cuadran.find((x) => this.llave(x) === e);
    if (e !== 'cajon' && !r) return;
    // Con el cajón primero se cuenta: la ventana del conteo manda el pago.
    if (!r) {
      this.contar({ clave: `hoja|${h.id}`, titulo: h.folio, total: h.total, pagar: (conteo) => this.enviarPagoHoja(h, { medio: 'cajon', conteo }, false) });
      return;
    }
    this.enviarPagoHoja(h, { medio: 'caos', device: r.device, external_id: r.external_id }, true);
  }

  private contar(c: Conteo): void {
    // `[LE.6.34]` Lo contado para ESTE pago se conserva si la ventana se cerró sin descartarlo.
    if (this.conteoDe !== c.clave) this.limpiarConteo();
    this.conteoDe = c.clave;
    this.conteoErr.set(null);
    this.contando.set(c);
  }

  /** La X o Esc de PrimeNG (sólo con la ventana limpia y sin pago en vuelo). */
  cerrarConteo(): void {
    if (this.ocupado()) return;
    this.contando.set(null);
  }

  /** «Volver»: sin piezas, o confirmando que se tiran. */
  descartarConteo(): void {
    if (this.ocupado()) return;
    this.limpiarConteo();
    this.contando.set(null);
  }

  private limpiarConteo(): void {
    this.conteoPiezas.set({});
    this.conteoMorralla.set(null);
    this.conteoErr.set(null);
    this.conteoDe = null;
  }

  /** Un pago que salió bien: la ventana se cierra y lo contado ya no sirve para otro. */
  private conteoPagado(): void {
    this.limpiarConteo();
    this.contando.set(null);
  }

  /** El error del pago: dentro de la ventana si el conteo sigue abierto; si no, en el aviso. */
  private errorDePago(clave: string, summary: string, err: unknown): void {
    if (this.contando()?.clave === clave) { this.conteoErr.set(`${summary}: ${this.textoError(err)}`); return; }
    this.toast.add({ severity: 'error', summary, detail: this.textoError(err), life: 10000 });
  }

  /** El pago, ya contado lo que sale del cajón. */
  pagarConCajon(): void {
    const c = this.contando();
    if (!c || !this.conteoListo() || this.ocupado()) return;
    this.conteoErr.set(null);
    c.pagar({ piezas: this.conteoPiezas(), morralla: Number(this.conteoMorralla() ?? 0) });
  }

  // ── `[LE.6.19]` La hoja abierta de la zona: se cierra y se paga aquí, en un acto ───────────────

  opcionesAbierta(a: HojaAbierta): OpcionOrigen[] {
    return [
      ...a.retiros_que_cuadran.map((r) => ({
        label: `«${r.ref ?? 'retiro ' + r.external_id}» · ${dmy(r.dia)} · ${money(r.total)}${r.cajon > 0 ? ` · cajón ${money(r.cajon)}` : ''}`,
        value: this.llave(r),
      })),
      { label: 'Del cajón entero (sin retiro)', value: 'cajon' },
    ];
  }

  /** La propuesta ya elegida cuando UN solo retiro cuadra; con varios o ninguno, elige la persona. */
  eleccionAbierta(a: HojaAbierta): string | null {
    const elegido = this.elegidosHoja()[`abierta|${a.zona}`];
    if (elegido) return elegido;
    return a.retiros_que_cuadran.length === 1 ? this.llave(a.retiros_que_cuadran[0]) : null;
  }

  elegirAbierta(a: HojaAbierta, valor: string | null): void {
    this.elegidosHoja.update((e) => ({ ...e, [`abierta|${a.zona}`]: valor ?? '' }));
  }

  textoCuadreAbierta(a: HojaAbierta): string {
    const rs = a.retiros_que_cuadran;
    const i = a.instruccion;
    if (rs.length === 1) {
      return `Cuadra «${rs[0].ref ?? rs[0].external_id}» del ${dmy(rs[0].dia)}`
        + (rs[0].cajon > 0 ? `; el cajón pone ${money(rs[0].cajon)} y se cuenta al pagar.` : '.');
    }
    if (rs.length > 1) return `${rs.length} retiros cuadran: elige el suyo.`;
    return i ? `Ningún retiro libre cuadra: saca ${money(i.retiro)} de CAOS y vuelve a leer, o págala del cajón contándolo.` : '';
  }

  /** Lo que sale del cajón se cuenta antes; si nada sale del cajón, se paga directo. */
  pagarAbierta(a: HojaAbierta): void {
    const e = this.eleccionAbierta(a);
    if (!e || this.ocupado()) return;
    const r = a.retiros_que_cuadran.find((x) => this.llave(x) === e) ?? null;
    if (e !== 'cajon' && !r) return;
    const cajon = r ? r.cajon : a.total;
    const pagar = (conteo?: ConteoCajonHoja) => this.enviarPagoAbierta(a, r, conteo);
    if (cajon > 0.005) {
      this.contar({ clave: `abierta|${a.zona}`, titulo: a.nombre, total: cajon, pagar: (conteo) => pagar(conteo) });
      return;
    }
    pagar();
  }

  private enviarPagoAbierta(a: HojaAbierta, r: RetiroParaHoja | null, conteo?: ConteoCajonHoja): void {
    const clave = `abierta|${a.zona}`;
    const pago: PagarHojaInput = r
      ? { medio: 'caos', device: r.device, external_id: r.external_id, ...(conteo ? { conteo } : {}) }
      : { medio: 'cajon', conteo: conteo as ConteoCajonHoja };
    const llave = this.llavesAbierta[clave] ??= uuidV4();
    this.ocupado.set(clave);
    this.api.pagarHojaAbierta(a.zona, { origen_refs: a.renglones.map((x) => x.origen_ref), client_key: llave, pago })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (x) => {
          delete this.llavesAbierta[clave];
          this.ocupado.set(null);
          this.conteoPagado();
          const av = avisoDePagoHoja(x,
            `${x.capturados + x.ligados} ${x.capturados + x.ligados === 1 ? 'pago quedó explicado' : 'pagos quedaron explicados'} por ${r ? 'el retiro' : 'el cajón'}.`);
          this.toast.add({ severity: av.severity, summary: `${a.nombre}: ${x.hoja.folio} pagada`, detail: av.detail,
            ...(av.sticky ? { sticky: true } : { life: 8000 }) });
          this.cargar();
          this.cambio.emit();
        },
        error: (err) => {
          this.ocupado.set(null);
          // Un rechazo del servidor no pagó nada: la siguiente vez es otro intento, con otra llave.
          if (err?.status && err.status < 500) delete this.llavesAbierta[clave];
          this.errorDePago(clave, `No se pagó la reposición de ${a.nombre}`, err);
          this.cargar();
        },
      });
  }

  private enviarPagoHoja(h: HojaGastos, body: PagarHojaInput, conRetiro: boolean): void {
    const clave = `hoja|${h.id}`;
    const r = conRetiro;
    this.ocupado.set(clave);
    this.api.pagarHojaDeGastos(h.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        if (this.contando()?.clave === clave) this.conteoPagado();
        const av = avisoDePagoHoja(x,
          `${x.capturados + x.ligados} ${x.capturados + x.ligados === 1 ? 'pago quedó explicado' : 'pagos quedaron explicados'} por ${r ? 'el retiro' : 'el cajón'}.`);
        this.toast.add({ severity: av.severity, summary: `${x.hoja.folio} pagada`, detail: av.detail,
          ...(av.sticky ? { sticky: true } : { life: 8000 }) });
        this.cargar();
        this.cambio.emit();
      },
      error: (err) => {
        this.ocupado.set(null);
        this.errorDePago(clave, `No se pagó ${h.folio}`, err);
        this.cargar();
      },
    });
  }

  capturarHoja(h: HojaGastos): void {
    const clave = `hoja|${h.id}`;
    if (this.ocupado()) return;
    this.ocupado.set(clave);
    this.api.capturarHojaDeGastos(h.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        const av = avisoDePagoHoja(x, x.sin_capturar.length ? '' : 'Todos sus pagos ya están en el libro.', 'revisa su cuenta contable');
        this.toast.add({ severity: av.severity, summary: `${x.hoja.folio}: ${x.capturados} ${x.capturados === 1 ? 'capturado' : 'capturados'}`,
          detail: av.detail, ...(av.sticky ? { sticky: true } : { life: 8000 }) });
        this.cargar();
        this.cambio.emit();
      },
      error: (err) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'error', summary: `No se capturó ${h.folio}`, detail: this.textoError(err), life: 10000 });
      },
    });
  }

  alternar(clave: string): void {
    this.abiertas.update((a) => { const n = { ...a }; if (n[clave]) delete n[clave]; else n[clave] = true; return n; });
  }

  /** Enter sobre la FILA abre su desglose; sobre un botón o un selector de adentro, no (ya hacen lo suyo). */
  enterEnFila(ev: Event, clave: string): void {
    if (ev.target === ev.currentTarget) this.alternar(clave);
  }

  abrir(clave: string): void {
    this.abiertas.update((a) => ({ ...a, [clave]: true }));
  }

  eleccion(g: ReposicionGrupo): string | null {
    const elegido = this.elegidos()[g.clave];
    if (elegido) return elegido;
    return g.retiro_sugerido ? `${g.retiro_sugerido.device}|${g.retiro_sugerido.external_id}` : null;
  }

  elegir(g: ReposicionGrupo, valor: string | null): void {
    this.elegidos.update((e) => ({ ...e, [g.clave]: valor ?? '' }));
  }

  /** Lo que sigue en la cola de este grupo, en un lote: el retiro elegido o el cajón. */
  reponer(g: ReposicionGrupo): void {
    const e = this.eleccion(g);
    if (!e || this.ocupado()) return;
    this.ocupado.set(g.clave);
    // `[CGA-A.62]` Sólo lo aprobado: lo que espera firma o se rechazó se queda en la cola.
    const items = this.reponibles(g).map((d) => ({ origen_ref: d.origen_ref }));
    if (!items.length) { this.ocupado.set(null); return; }
    const retiro = e === 'cajon' ? null : this.retiroDe(e);
    this.api.confirmarLote(items, retiro ? { device: retiro.device, external_id: retiro.external_id } : null, e === 'cajon' ? 'cajon' : null)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.ocupado.set(null);
          const a = avisoDeReposicion(r, items.length, g.docs);
          this.toast.add({
            severity: a.severity,
            summary: `${this.nombre(g.sucursal)} ${dmy(g.fecha)}`,
            detail: a.detail,
            ...(a.sticky ? { sticky: true } : { life: 8000 }),
          });
          this.cargar();
          this.cambio.emit();
        },
        error: (err) => {
          this.ocupado.set(null);
          this.toast.add({ severity: 'error', summary: 'No se repuso', detail: this.textoError(err), life: 10000 });
        },
      });
  }

  /** La propuesta del motor, confirmada por superadmin: todo o nada. */
  vincular(g: ReposicionGrupo): void {
    const p = g.propuesta;
    if (!p || this.ocupado()) return;
    this.ocupado.set(g.clave);
    this.caos.vincularLote({
      asignaciones: p.asignaciones.map((a) => ({ ledger_id: a.ledger_id, device: a.device, external_id: a.external_id, monto: a.monto })),
      motivo: `Reposición ${this.nombre(g.sucursal)} ${dmy(g.fecha)}`,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'success', summary: 'Vinculados',
          detail: `${r.vinculos} ${r.vinculos === 1 ? 'vínculo' : 'vínculos'} por ${money(r.monto)} · ${this.nombre(g.sucursal)} ${dmy(g.fecha)}.`, life: 8000 });
        this.cargar();
        this.cambio.emit();
      },
      error: (err) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'error', summary: 'No se guardó ningún vínculo', detail: this.textoError(err), life: 12000 });
      },
    });
  }

  abrirMover(v: ReposicionVinculo, d: ReposicionDoc): void {
    this.destinoMover = null;
    this.motivoMover = '';
    this.mover.set({ vinculo: v, folio: d.cg_folio ?? d.folio });
  }

  cerrarMover(): void {
    if (this.ocupado() === 'mover') return;
    this.mover.set(null);
  }

  confirmarMover(): void {
    const m = this.mover();
    const destino = this.destinoMover ? this.retiroDe(this.destinoMover) : null;
    if (!m || !destino || this.motivoMover.trim().length < 10 || this.ocupado()) return;
    this.ocupado.set('mover');
    this.caos.moverVinculo(m.vinculo.link_id, { device: destino.device, external_id: destino.external_id, motivo: this.motivoMover.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.ocupado.set(null);
          this.mover.set(null);
          this.toast.add({
            severity: r.queda > 0 ? 'warn' : 'success', summary: `${m.folio} cambió de retiro`,
            detail: `«${destino.ref ?? destino.external_id}» toma ${money(r.monto)}` + (r.queda > 0 ? `; ${money(r.queda)} quedan sin retiro.` : '.'),
            life: 8000,
          });
          this.cargar();
          this.cambio.emit();
        },
        error: (err) => {
          this.ocupado.set(null);
          this.toast.add({ severity: 'error', summary: 'No se cambió', detail: this.textoError(err), life: 10000 });
        },
      });
  }

  private llave(r: { device: string; external_id: number }): string { return `${r.device}|${r.external_id}`; }

  private retiroDe(llave: string): ReposicionRetiro | null {
    return (this.datos()?.retiros ?? []).find((r) => this.llave(r) === llave) ?? null;
  }

  private etiquetaRetiro(r: ReposicionRetiro): string {
    return `«${r.ref ?? 'retiro ' + r.external_id}» · ${dmy(r.dia)} · libre ${money(r.libre)}`;
  }

  private textoError(e: unknown): string {
    const err = e as { error?: { message?: string | string[] }; message?: string };
    const m = err?.error?.message ?? err?.message;
    return Array.isArray(m) ? m.join(' · ') : String(m ?? 'Error de red');
  }
}
