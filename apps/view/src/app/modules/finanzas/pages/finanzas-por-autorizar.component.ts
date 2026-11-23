import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TableModule, Table } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { MOTIVO_MAX, masNuevaPrimero, proximoVencimiento, type AccionDecisionPedido, type BandejaAutorizacion, type DecisionVigente, type PedidoPorAutorizar } from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CarteraSegmentsComponent } from '../cartera-segments.component';
import { CarteraService, type CarteraDetalle } from '../cartera.service';
import { AutorizacionPedidosService } from '../autorizacion-pedidos.service';

/** Las condiciones de la regla, en el orden del anexo EA §3.1, como las lee Crédito y cobranza. */
export const CONDICIONES = [
  'Tiene límite en Kepler',
  'Lo que debe, sus otros pedidos y éste caben en el límite',
  'Nada vencido fuera de la gracia (los centavos no cuentan)',
  'No está marcado «NO TOCAR» ni «NO USAR» en Kepler',
  'Los datos son recientes',
  'La autorización automática está encendida en la sucursal',
  'El pedido no es viejo',
  'No es de la ruta vecinal',
] as const;

type Tono = 'success' | 'secondary' | 'danger' | 'contrast';

/** Lo que falló y le toca decidir a una persona. Las condiciones 5 y 6 son del sistema: se dicen una vez arriba. */
export function motivosDelCliente(p: PedidoPorAutorizar) {
  const m = p.resultado.motivos.filter((x) => x.condicion !== 5 && x.condicion !== 6);
  // En «aparte» manda por qué está aparte (ruta vecinal o viejo), no lo demás.
  if (p.resultado.decision === 'aparte' || p.ruta_vecinal) return [...m.filter((x) => x.condicion === 8 || x.condicion === 7), ...m.filter((x) => x.condicion < 7)];
  return m;
}

/** La etiqueta de la fila: palabra, no sólo color. */
export function etiquetaDe(p: PedidoPorAutorizar): { texto: string; tono: Tono } {
  if (p.es_contado) return { texto: 'Contado', tono: 'secondary' };
  if (p.ruta_vecinal) return { texto: 'Ruta vecinal', tono: 'secondary' };
  const c = motivosDelCliente(p)[0]?.condicion;
  if (c === 4) return { texto: 'Bloqueado', tono: 'contrast' };
  if (c === 2) return { texto: 'Excede', tono: 'danger' };
  if (c === 3) return { texto: 'Vencido', tono: 'danger' };
  if (c === 1) return { texto: 'Sin límite', tono: 'secondary' };
  if (c === 7) return { texto: 'Viejo', tono: 'secondary' };
  return { texto: 'Pasaría solo', tono: 'success' };
}

/** Por qué no pasó solo, en una frase. */
export function fraseDe(p: PedidoPorAutorizar): string {
  if (p.es_contado) return 'venta de contado: no usa crédito';
  return motivosDelCliente(p)[0]?.texto ?? 'cumple todo: se autorizaría solo con la autorización automática encendida';
}

/** Cuántas facturas se pintan en el panel: el resto está en el estado de cuenta. */
const FACTURAS_EN_EL_PANEL = 12;
/** Y cuántos de sus últimos pagos: lo demás está en su estado de cuenta. */
const ABONOS_EN_EL_PANEL = 6;

const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
export const dinero = (n: number) => fmt.format(n);

/** Lo que Kepler cuenta por cobrar de más contra la cartera de la Suite. null si no hay diferencia que decir. */
export function diferenciaKepler(p: PedidoPorAutorizar): number | null {
  if (p.por_cobrar_kepler == null || p.saldo_cartera == null) return null;
  const d = Math.round((p.por_cobrar_kepler - p.saldo_cartera) * 100) / 100;
  return d > 1 ? d : null;
}

/** La segunda línea de la fila: sólo si hay un dato que cambia la decisión. */
export function datoDe(p: PedidoPorAutorizar): string | null {
  const dif = diferenciaKepler(p);
  if (dif != null) return `Kepler cuenta ${dinero(dif)} más que la cartera`;
  if (p.es_contado) return null;
  if (p.pago.facturas_pagadas === 0) return 'sin historial de pago';
  if (p.pago.mediana_dias != null) {
    return `suele pagar a ${p.pago.mediana_dias} días` + (p.plazo_dias ? ` con plazo de ${p.plazo_dias}` : '');
  }
  return null;
}

/** Los 2 o 3 hechos que pesan para decidir este caso (anexo EA §3.6). */
export function hechosDe(p: PedidoPorAutorizar): string[] {
  const h: string[] = [];
  const pg = p.pago;
  // `[GP.A.5c]` Lo vencido va PRIMERO: es lo que más pesa al decidir y la lista se corta a 3 hechos.
  // Medido el 2026-11-23: de los 12 clientes que esperaban, 9 tenían TODO su saldo vencido y el panel
  // no lo decía — salían el historial de pago y los otros pedidos, y lo vencido quedaba fuera del corte.
  const venc = p.resultado.numeros.vencido_fuera_de_gracia;
  const dias = p.resultado.numeros.dias_vencido_max;
  if (venc != null && venc > 0) {
    h.push(`Debe ${dinero(venc)} vencidos${dias ? `, lo más viejo de hace ${dias} días` : ''}.`);
  }
  if (pg.facturas_pagadas > 0) {
    let t = `Pagó ${pg.facturas_pagadas} ${pg.facturas_pagadas === 1 ? 'factura' : 'facturas'}`;
    if (pg.mediana_dias != null) t += `; suele pagar a ${pg.mediana_dias} días` + (p.plazo_dias ? ` con plazo de ${p.plazo_dias}` : '');
    if (pg.a_tiempo != null) t += `; ${pg.a_tiempo} a tiempo`;
    h.push(t + '.');
    if (pg.peor_atraso) h.push(`Su peor atraso fue de ${pg.peor_atraso} días.`);
  } else if (!p.es_contado) {
    h.push('No tiene historial de pago en Kepler.');
  }
  if ((p.otros_pedidos ?? 0) > 0) h.push(`Tiene otros pedidos sin facturar por ${dinero(p.otros_pedidos ?? 0)}.`);
  if (p.resultado.numeros.resto_ignorado > 0) {
    h.push(`Quedan ${dinero(p.resultado.numeros.resto_ignorado)} de redondeo en facturas cobradas: no cuentan.`);
  }
  return h.slice(0, 3);
}

export function esperaDe(p: PedidoPorAutorizar): string {
  const d = p.dias_esperando;
  if (d == null) return '—';
  return d <= 0 ? 'hoy' : `${d} d`;
}

/**
 * `[GP.A.4]` **Por autorizar** — los pedidos de telemarketing que esperan a Crédito y cobranza (anexo EA de GP §3.6,
 * aprobada por Edgar el 2026-11-20). Vive en Cartera porque ahí trabaja Crédito y cobranza.
 *
 * La pregunta que contesta: ¿qué pedidos tengo que decidir yo? Primario: cuántos esperan; secundario: por qué no pasó
 * solo cada uno; terciario: importe y espera. El detalle se abre en el panel sin salir de la lista.
 *
 * Sólo lectura: el botón Autorizar está apagado y lo dice, hasta que exista la escritura en Kepler (GP.A.2).
 */
@Component({
  selector: 'app-finanzas-por-autorizar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonModule, TableModule, TagModule, TextareaModule, ToastModule, FreshnessPillComponent, LoadStateComponent, MetricStripComponent, SidePeekComponent, CarteraSegmentsComponent, ContextHelpComponent],
  providers: [MessageService],
  template: `
    <p-toast position="bottom-right" />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Crédito de clientes</h1>
        </div>
        <div class="pa-head-acc">
          @if (data(); as d) {
            <app-freshness-pill measures="data" [freshness]="d.freshness" [since]="d.freshness.data_as_of" label="Datos del ERP" />
          }
          <app-context-help topic="por-autorizar" />
        </div>
      </header>

      <app-cartera-segments />

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && !lista().length"
                      emptyIcon="pi-check-circle" [emptyTitle]="tituloVacio()"
                      (retry)="cargar()">
        @if (data(); as d) {
          <div class="pa-respuesta">
            <!-- Las dos cifras se abren: tocar una cambia la lista. Sin conteo animado (instant): una cifra que
                 anima publica valores que no existen. -->
            <app-metric-strip [items]="cifras()" [instant]="true" [selected]="vista()"
                              ariaLabel="Pedidos por autorizar" (drill)="verLista($event)" />
            <p class="pa-sub">
              @if (vista() === 'aparte') { Más de {{ d.parametros.pedidoViejoDias }} días sin movimiento o de la ruta vecinal: no se autorizan solos ni ocupan la lista del día. }
              @else if (vista() === 'decididos') { Decididos ya, por ti o por la regla: Kepler todavía los muestra sin autorizar. Si hay que reconsiderar uno, se decide de nuevo desde aquí. }
              @else if (!d.sucursales_encendidas.length) { La autorización automática está apagada: todos esperan aquí. }
              @if (vista() === 'pendientes' && d.contado.length) { {{ d.contado.length }} de contado no necesitan tu autorización. }
            </p>
          </div>
        }

        <!-- «Aparte» trae ~800 pedidos muertos (medido en prod el 2026-11-23) y pintarlos todos traba el
             desplazamiento. El paginador existe SIEMPRE y se esconde solo con 50 filas o menos
             (alwaysShowPaginator=false): activarlo en caliente dejaba «1–1 de 1» con 120 filas en la lista
             —PrimeNG no recalcula totalRecords al encenderlo—, medido en pantalla viva el 2026-11-23.
             La del día (15 hoy) se sigue viendo entera y la maqueta aprobada no cambia. -->
        <p-table #tabla [value]="lista()" selectionMode="single" dataKey="folio" size="small" [rowHover]="true"
                 [paginator]="true" [rows]="50" [alwaysShowPaginator]="false"
                 currentPageReportTemplate="{first}–{last} de {totalRecords}" [showCurrentPageReport]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Cliente</th>
              <th>Por qué no pasó solo</th>
              <th class="comm-num">Importe</th>
              <th class="comm-num">Espera</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p">
              <td role="cell" data-label="Cliente">
                <div class="pa-cliente">{{ p.cliente_nombre || p.cliente }}</div>
                <div class="pa-tenue">{{ p.sucursal_nombre }}</div>
              </td>
              <td role="cell" data-label="Por qué">
                <div class="pa-motivo">
                  <p-tag [value]="etiqueta(p).texto" [severity]="etiqueta(p).tono" />
                  <span>{{ frase(p) }}</span>
                </div>
                @if (dato(p); as x) { <div class="pa-tenue">{{ x }}</div> }
              </td>
              <td role="cell" data-label="Importe" class="comm-num">{{ dinero(p.importe) }}</td>
              <td role="cell" data-label="Espera" class="comm-num pa-tenue">{{ espera(p) }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <app-side-peek [open]="peekOpen()" (openChange)="peekOpen.set($event)"
                   [title]="sel()?.cliente_nombre || sel()?.cliente || 'Pedido'"
                   [subtitle]="sel() ? subtitulo(sel()!) : null"
                   [sucio]="!!motivo().trim()" textoDescartar="El motivo que escribiste no se guarda.">
      @if (sel(); as p) {
        <div class="pa-panel">
          <section class="pa-bloque">
            <p class="pa-veredicto">{{ veredicto(p) }}</p>
            <dl class="pa-numeros">
              <dt>Límite</dt><dd>{{ p.limite && p.limite > 0 ? dinero(p.limite) : 'sin límite' }}</dd>
              <dt>Por cobrar en Kepler</dt>
              <dd>{{ p.es_contado ? 'no aplica: contado' : (p.por_cobrar_kepler == null ? 'no se pudo leer' : dinero(p.por_cobrar_kepler)) }}</dd>
              @if ((p.otros_pedidos ?? 0) > 0) { <dt>Otros pedidos sin facturar</dt><dd>{{ dinero(p.otros_pedidos ?? 0) }}</dd> }
              <dt>Este pedido</dt><dd>{{ dinero(p.importe) }}</dd>
            </dl>
            @if (diferencia(p); as dif) {
              <p class="pa-nota">Kepler cuenta {{ dinero(dif) }} más que la cartera de la Suite. Suelen ser facturas de ticket sin abono aplicado.</p>
            }
            <!-- El teléfono no se pliega: es un dato de una línea y sirve para llamarle antes de decidir. -->
            @if (telefono(); as tel) {
              <p class="pa-tenue">Teléfono en {{ p.sucursal_nombre }}: <span class="pa-tel">{{ tel }}</span></p>
            }
          </section>

          @if (hechos(p).length) {
            <section class="pa-bloque">
              <h3 class="pa-h3">Para decidir</h3>
              <ul class="pa-hechos">
                @for (h of hechos(p); track h) { <li>{{ h }}</li> }
              </ul>
            </section>
          }

          <!-- [GP.A.5c] Nada de esto se pide al abrir el panel: la llamada sale cuando la persona abre el
               desglose (Edgar, 2026-11-23: «que al dar clic tenga la accesibilidad de ver esa información; lo
               que evitamos es que al cargar la interfaz suelte mucha información»). -->
          <details class="pa-detalles" (toggle)="abrirFacturas(p, $any($event.target).open)">
            <summary>Ver sus facturas{{ p.saldo_cartera ? ' · ' + dinero(p.saldo_cartera) : '' }}</summary>
            @if (cargandoDetalle()) {
              <p class="pa-tenue">Buscando sus facturas…</p>
            } @else if (errorDetalle()) {
              <p class="pa-error"><i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ errorDetalle() }}</p>
            } @else if (detalle(); as d) {
              <!-- El mismo resumen que la ficha del cliente y el PDF (resumenPeriodo / proximoVencimiento de
                   contracts): tres lugares, una sola cuenta. -->
              <dl class="pa-numeros pa-ec">
                <dt>Saldo</dt><dd>{{ dinero(d.saldo) }}</dd>
                @if (d.vencido > 0) { <dt>Vencido</dt><dd class="pa-mal-num">{{ dinero(d.vencido) }}</dd> }
                @if (proximo(); as pv) { <dt>Próximo vencimiento</dt><dd>{{ pv.fecha }} · {{ dinero(pv.monto) }}</dd> }
                @if (d.saldo_a_favor > 0) { <dt>A favor</dt><dd>{{ dinero(d.saldo_a_favor) }}</dd> }
              </dl>
              <table class="pa-facturas">
                <caption class="sr-only">Facturas con saldo de {{ p.cliente_nombre || p.cliente }}</caption>
                <thead>
                  <tr><th scope="col">Documento</th><th scope="col">Vence</th><th scope="col" class="comm-num">Saldo</th><th scope="col" class="comm-num">Días</th></tr>
                </thead>
                <tbody>
                  @for (f of facturas(); track f.folio) {
                    <tr [class.pa-f-vencida]="f.vencida">
                      <td>{{ f.doc_label }} {{ f.folio }}</td>
                      <td>{{ f.vencimiento ?? 'sin fecha' }}</td>
                      <td class="comm-num">{{ dinero(f.saldo_documento) }}</td>
                      <td class="comm-num">{{ f.vencida && f.dias_vencido ? f.dias_vencido : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              @if (aging(); as ag) {
                <p class="pa-aging">
                  <span class="sr-only">Lo vencido por antigüedad: </span>
                  @for (t of ag; track t.rotulo) {
                    <span class="pa-tramo" [class.pa-tramo--alto]="t.alto">{{ t.rotulo }} <b>{{ dinero(t.monto) }}</b></span>
                  }
                </p>
              }
              <!-- El estado de cuenta completo se VE, no se descarga: la ficha del cliente es el estado de
                   cuenta en pantalla (CXC.50/CXC.51) y abre en este cliente por el enlace profundo de CXC.26.
                   El PDF vive allá, que es donde se usa para enviárselo al cliente. -->
              <a class="pa-ec-liga" [routerLink]="['/finanzas/cartera']" [queryParams]="{ suc: p.sucursal, cliente: p.cliente }">
                @if (facturasDeMas() > 0) { Ver su estado de cuenta completo ({{ facturasDeMas() }} facturas más) }
                @else { Ver su estado de cuenta completo }
                <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
              </a>
            }
          </details>

          <!-- Los dos bloques salen del MISMO detalle que las facturas: abrirlos no pide nada nuevo. -->
          @if ((p.pago.facturas_pagadas > 0) || detalle()) {
            <details class="pa-detalles" (toggle)="abrirFacturas(p, $any($event.target).open)">
              <summary>Cómo ha pagado{{ p.pago.facturas_pagadas ? ' · ' + p.pago.facturas_pagadas + ' facturas' : '' }}</summary>
              @if (detalle(); as d) {
                @if (d.abonos.length) {
                  <table class="pa-facturas">
                    <caption class="sr-only">Sus últimos pagos</caption>
                    <thead><tr><th scope="col">Pago</th><th scope="col">Fecha</th><th scope="col" class="comm-num">Monto</th></tr></thead>
                    <tbody>
                      @for (a of abonos(); track a.folio) {
                        <tr><td>{{ a.doc_label }} {{ a.folio }}</td><td>{{ a.fecha ?? 'sin fecha' }}</td><td class="comm-num">{{ dinero(a.importe) }}</td></tr>
                      }
                    </tbody>
                  </table>
                  @if (abonosDeMas() > 0) { <p class="pa-tenue">Y {{ abonosDeMas() }} pagos más, en su estado de cuenta.</p> }
                } @else {
                  <p class="pa-tenue">No tiene pagos registrados en la cartera.</p>
                }
                @if (compromiso(); as c) {
                  <p class="pa-nota">Prometió pagar {{ dinero(c.monto_prometido) }} el {{ c.fecha_promesa }}{{ c.estado ? ' · ' + c.estado : '' }}.</p>
                } @else {
                  <p class="pa-tenue">Sin promesa de pago registrada. Se registran en la ficha del cliente.</p>
                }
              } @else if (cargandoDetalle()) { <p class="pa-tenue">Buscando sus pagos…</p> }
            </details>
          }

          @if ((p.otros_pedidos ?? 0) > 0) {
            <details class="pa-detalles">
              <summary>Sus otros pedidos sin facturar · {{ dinero(p.otros_pedidos ?? 0) }}</summary>
              <table class="pa-facturas">
                <caption class="sr-only">Otros pedidos del cliente que todavía no se facturan</caption>
                <thead><tr><th scope="col">Pedido</th><th scope="col">Fecha</th><th scope="col" class="comm-num">Importe</th></tr></thead>
                <tbody>
                  @for (o of p.otros_pedidos_detalle; track o.folio) {
                    <tr><td>{{ o.folio }}</td><td>{{ o.fecha }}</td><td class="comm-num">{{ dinero(o.importe) }}</td></tr>
                  }
                </tbody>
              </table>
              <p class="pa-tenue">Cuentan contra su crédito aunque Kepler todavía no los facture.</p>
            </details>
          }

          <details class="pa-detalles">
            <summary>Ver las condiciones</summary>
            <ul class="pa-conds">
              @for (c of condiciones(p); track c.texto) {
                <li><i [class]="c.ok ? 'pi pi-check pa-ok' : 'pi pi-times pa-mal'" aria-hidden="true"></i>
                  <span class="sr-only">{{ c.ok ? 'Cumple:' : 'No cumple:' }}</span> {{ c.texto }}</li>
              }
            </ul>
          </details>

          <section class="pa-bloque">
            @if (p.decision; as dec) {
              <p class="pa-nota">{{ loQueSeDecidio(dec) }}</p>
            }
            @if (puedeDecidir()) {
              <div class="pa-motivo-campo">
                <label class="pa-h3" for="pa-motivo">Motivo · queda con tu nombre</label>
                <!-- pTextarea: el tema pone fondo, borde y anillo de foco (antes un textarea crudo con un token
                     inventado dejaba el campo con el fondo del navegador: en oscuro, 1.04:1). -->
                <textarea pTextarea id="pa-motivo" #campoMotivo rows="2" class="pa-motivo-input"
                          [attr.maxlength]="motivoMax" [value]="motivo()" (input)="escribirMotivo($any($event.target).value)"
                          [disabled]="!!enviando()" [attr.aria-invalid]="motivoInvalido() ? 'true' : 'false'"
                          [attr.aria-describedby]="motivoInvalido() ? 'pa-motivo-error pa-motivo-ayuda' : 'pa-motivo-ayuda'"
                          placeholder="Por qué lo autorizas o lo rechazas"></textarea>
                @if (motivoInvalido()) {
                  <p class="pa-error" id="pa-motivo-error">
                    <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                    <span class="sr-only">Error: </span>Escribe el motivo: queda registrado con tu nombre.
                  </p>
                }
              </div>
              <!-- Habilitados a propósito (modern-web-guidance «required-field-feedback»): un botón deshabilitado no
                   se puede enfocar y no dice por qué. Al pulsarlo sin motivo, el foco va al campo y el error se anuncia.
                   El disabled queda sólo mientras la decisión va en camino (un clic = una escritura). -->
              <div class="pa-acciones">
                <button pButton type="button" [disabled]="!!enviando() || !escrituraEncendida(p)"
                        (click)="decidir(p, 'autorizar')">
                  <span class="p-button-label">{{ enviando() === 'autorizar' ? 'Autorizando…' : 'Autorizar' }}</span>
                </button>
                <button pButton type="button" class="p-button-outlined pa-rechazar" [disabled]="!!enviando()"
                        (click)="decidir(p, 'rechazar')">
                  <span class="p-button-label">{{ enviando() === 'rechazar' ? 'Rechazando…' : 'Rechazar' }}</span>
                </button>
              </div>
              <p class="pa-tenue" id="pa-motivo-ayuda">
                @if (!escrituraEncendida(p)) { Autorizar desde la Suite está apagado en {{ p.sucursal_nombre }}: por ahora, en Kepler › Autorización de Pedidos. Rechazar sí queda registrado aquí. }
                @else { Autorizar lo pasa a AUTORIZADO en Kepler. Rechazar no cambia Kepler: lo saca de esta lista con tu motivo. }
              </p>
              <!-- El resultado, DENTRO del panel: como es aria-modal, un toast de afuera queda inerte para un
                   lector de pantalla (modern-web-guidance «persistent-toast-notifications»). -->
              <p class="pa-resultado" role="status" aria-live="polite">{{ resultado() }}</p>
            } @else {
              <p class="pa-tenue">No tienes el permiso para autorizar pedidos. Se hace en Kepler › Autorización de Pedidos.</p>
            }
          </section>

          <div class="pa-siguiente">
            <span class="pa-tenue">{{ posicion() }}</span>
            <button pButton type="button" class="p-button-outlined p-button-sm" [disabled]="!haySiguiente()" (click)="siguiente()">
              <span class="p-button-label">Siguiente pedido</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; }
    .pa-head-acc { display: flex; gap: var(--sp-2); align-items: center; }
    .pa-respuesta { display: flex; flex-direction: column; gap: var(--sp-1); margin: var(--sp-3) 0 var(--sp-4); }
    .pa-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .pa-cliente { font-weight: 600; }
    .pa-motivo { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .pa-tenue { font-size: var(--fs-xs); color: var(--text-muted); }
    .pa-panel { display: flex; flex-direction: column; gap: var(--sp-5); }
    .pa-bloque { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pa-veredicto { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
    .pa-numeros { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-1) var(--sp-5); margin: 0; font-size: var(--fs-sm); }
    .pa-numeros dt { color: var(--text-muted); }
    .pa-numeros dd { margin: 0; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pa-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); background: var(--surface-2); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); }
    .pa-h3 { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); }
    .pa-hechos { margin: 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-body); }
    .pa-detalles { font-size: var(--fs-sm); color: var(--text-muted); }
    .pa-detalles summary { cursor: pointer; font-weight: 600; color: var(--text-main); }
    .pa-conds { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .pa-ok { color: var(--ok-soft-fg); font-weight: 700; }
    .pa-mal { color: var(--bad-soft-fg); font-weight: 700; }
    .pa-motivo-campo { display: flex; flex-direction: column; gap: var(--sp-1); }
    /* Fondo, borde y anillo de foco los pone pTextarea (el tema). Acá sólo el ancho y el alto mínimo. */
    .pa-motivo-input { width: 100%; resize: vertical; font-size: var(--fs-sm); }
    .pa-error { margin: 0; font-size: var(--fs-xs); color: var(--bad-soft-fg); display: flex; gap: var(--sp-1); align-items: center; }
    .pa-facturas { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); margin: var(--sp-2) 0; }
    .pa-facturas th { text-align: left; font-weight: 600; color: var(--text-muted); padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .pa-facturas td { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .pa-ec { margin-bottom: var(--sp-2); }
    .pa-aging { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .pa-tramo b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-main); font-weight: 600; }
    .pa-tramo--alto b { color: var(--bad-soft-fg); }
    .pa-tel { font-family: var(--font-mono); }
    .pa-mal-num { color: var(--bad-soft-fg); }
    .pa-ec-liga { display: inline-flex; gap: var(--sp-1); align-items: center; font-size: var(--fs-sm); color: var(--action); text-decoration: none; }
    .pa-ec-liga:hover, .pa-ec-liga:focus-visible { text-decoration: underline; }
    .pa-facturas .comm-num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    /* Vencida: palabra y número lo dicen (la columna «Días»); el color no es el único portador. */
    .pa-f-vencida td { color: var(--text-main); }
    .pa-f-vencida .comm-num:last-child { color: var(--bad-soft-fg); font-weight: 600; }
    .pa-resultado:empty { display: none; }
    .pa-resultado { margin: 0; font-size: var(--fs-sm); color: var(--text-main); background: var(--surface-2); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); }
    /* La negativa no lleva el color de acción (Von Restorff): se distingue, no compite. */
    .pa-rechazar { --p-button-outlined-primary-color: var(--bad-soft-fg); }
    .pa-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
    /* Con el dedo, la decisión y «Siguiente pedido» tienen que ser alcanzables: medido en un iPhone 13
       emulado el 2026-11-23, los botones daban 35 y 28 px de alto contra los 44 que pide el estándar. */
    @media (pointer: coarse) {
      .pa-acciones button, .pa-siguiente button { min-height: var(--tap-min, 44px); }
    }
    .pa-siguiente { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
  `],
})
export class FinanzasPorAutorizarComponent implements OnInit {
  private readonly api = inject(AutorizacionPedidosService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly permisos = inject(PermissionsService);
  private readonly cartera = inject(CarteraService);

  readonly data = signal<BandejaAutorizacion | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** Qué lista se está viendo. `decididos` sólo aparece cuando hay algo decidido hoy. */
  readonly vista = signal<'pendientes' | 'aparte' | 'decididos'>('pendientes');
  readonly sel = signal<PedidoPorAutorizar | null>(null);
  readonly peekOpen = signal(false);
  /** `[GP.A.5]` El motivo que se está escribiendo y la acción en vuelo (deshabilita los dos botones al primer clic). */
  readonly motivo = signal('');
  readonly enviando = signal<AccionDecisionPedido | null>(null);
  readonly motivoMax = MOTIVO_MAX;
  readonly puedeDecidir = this.permisos.has$(Permission.FINANCE_PEDIDOS_AUTORIZAR);
  /**
   * El campo se marca inválido **sólo después** de intentar decidir, nunca al abrir el panel: un `required` vacío
   * marcado desde el inicio hace que un lector de pantalla cante «no válido» antes de que la persona lo toque.
   */
  readonly intento = signal(false);
  readonly motivoInvalido = computed(() => this.intento() && !this.motivo().trim());
  /** Lo que contestó la última decisión, dentro del panel (el toast de afuera no llega a un lector dentro de un modal). */
  readonly resultado = signal('');
  /** `[GP.A.5c]` El auxiliar del cliente, pedido SÓLO al abrir el desglose. */
  readonly detalle = signal<CarteraDetalle | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  private pedidoDelDetalle = '';
  /** Las vencidas primero y las más viejas arriba: es el orden en que se cobran. */
  readonly facturas = computed(() => {
    const d = this.detalle();
    if (!d) return [];
    return [...d.partidas]
      .sort(masNuevaPrimero)
      .slice(0, FACTURAS_EN_EL_PANEL);
  });
  readonly facturasDeMas = computed(() => Math.max(0, (this.detalle()?.partidas.length ?? 0) - FACTURAS_EN_EL_PANEL));
  /** El siguiente vencimiento de lo que está al corriente, con la misma función que la ficha y el PDF. */
  readonly proximo = computed(() => { const d = this.detalle(); return d ? proximoVencimiento(d.partidas) : null; });
  /**
   * `[GP.A.5d]` Lo vencido repartido por antigüedad, de las mismas partidas que ya se leyeron. Sólo los
   * tramos que tienen algo: un tramo en cero no es información, es un renglón más que leer.
   */
  readonly aging = computed(() => {
    const d = this.detalle();
    if (!d) return null;
    const tramos = [
      { rotulo: '1 a 30 días', desde: 1, hasta: 30, alto: false },
      { rotulo: '31 a 60', desde: 31, hasta: 60, alto: false },
      { rotulo: '61 a 90', desde: 61, hasta: 90, alto: true },
      { rotulo: 'más de 90', desde: 91, hasta: Infinity, alto: true },
    ];
    const r = tramos.map((t) => ({
      rotulo: t.rotulo, alto: t.alto,
      monto: Math.round(d.partidas
        .filter((x) => x.vencida && x.dias_vencido != null && x.dias_vencido >= t.desde && x.dias_vencido <= t.hasta)
        .reduce((s, x) => s + x.saldo_documento, 0) * 100) / 100,
    })).filter((t) => t.monto > 0);
    return r.length ? r : null;
  });
  /** Sus últimos pagos, los más nuevos primero. */
  readonly abonos = computed(() => {
    const d = this.detalle();
    if (!d) return [];
    return [...d.abonos].sort((a, b) => String(b.fecha ?? '').localeCompare(String(a.fecha ?? ''))).slice(0, ABONOS_EN_EL_PANEL);
  });
  readonly abonosDeMas = computed(() => Math.max(0, (this.detalle()?.abonos.length ?? 0) - ABONOS_EN_EL_PANEL));
  /** La promesa de pago vigente, si la hay. ⚠️ Medido el 2026-11-23: la tabla está VACÍA en toda la base. */
  readonly compromiso = computed(() => this.detalle()?.compromisos?.[0] ?? null);
  /** El teléfono del cliente en esta sucursal, para llamarle antes de decidir (CXC.48). */
  readonly telefono = computed(() => this.detalle()?.cliente?.telefono ?? null);
  private readonly campoMotivo = viewChild<ElementRef<HTMLTextAreaElement>>('campoMotivo');
  private readonly tabla = viewChild<Table>('tabla');

  /** Se conserva para la plantilla y las pruebas que ya existían. */
  readonly verAparte = computed(() => this.vista() === 'aparte');

  readonly lista = computed(() => {
    const d = this.data();
    if (!d) return [];
    if (this.vista() === 'aparte') return d.aparte;
    if (this.vista() === 'decididos') return d.decididos;
    return d.pendientes;
  });

  readonly cifras = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const c: MetricStripItem[] = [
      { label: 'Esperan tu decisión', value: d.pendientes.length, format: 'number', drill: 'pendientes' },
      { label: 'Viejos, aparte', value: d.aparte.length, format: 'number', drill: 'aparte' },
    ];
    // «Ya decididos», no «Ya decidiste»: la lista también trae los que autorizó sola la regla.
    // Sólo cuando hay: una cifra en cero no es trabajo, es ruido.
    if (d.decididos.length) c.push({ label: 'Ya decididos', value: d.decididos.length, format: 'number', drill: 'decididos' });
    return c;
  });

  private readonly indice = computed(() => {
    const s = this.sel();
    return s ? this.lista().findIndex((p) => p.sucursal === s.sucursal && p.folio === s.folio) : -1;
  });
  readonly posicion = computed(() => (this.indice() >= 0 ? `${this.indice() + 1} de ${this.lista().length}` : ''));
  readonly haySiguiente = computed(() => this.indice() >= 0 && this.indice() < this.lista().length - 1);

  readonly etiqueta = etiquetaDe;
  readonly frase = fraseDe;
  readonly dato = datoDe;
  readonly hechos = hechosDe;
  readonly espera = esperaDe;
  readonly dinero = dinero;
  readonly diferencia = diferenciaKepler;

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.bandeja().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.error.set('No se pudieron leer los pedidos por autorizar.'); this.loading.set(false); },
    });
  }

  abrir(p: PedidoPorAutorizar): void {
    this.sel.set(p);
    this.limpiarCaptura();
    this.peekOpen.set(true);
  }

  siguiente(): void {
    const i = this.indice();
    const n = this.lista()[i + 1];
    if (n) this.pasarA(n);
  }

  escribirMotivo(v: string): void {
    this.motivo.set(v);
    // El error se quita en cuanto hay algo escrito; aparecer de nuevo exige otro intento.
    if (v.trim()) this.intento.set(false);
  }

  private limpiarCaptura(): void {
    this.motivo.set('');
    this.intento.set(false);
    this.resultado.set('');
  }

  /** Cambiar de pedido conserva el panel abierto y deja el foco en el campo, no en un botón de otro pedido. */
  private pasarA(p: PedidoPorAutorizar): void {
    this.sel.set(p);
    this.limpiarCaptura();
    queueMicrotask(() => this.campoMotivo()?.nativeElement.focus());
  }

  verLista(cual: string): void {
    this.vista.set(cual === 'aparte' || cual === 'decididos' ? cual : 'pendientes');
    // Cambiar de lista vuelve a la primera página Y recalcula el total: sin esto el paginador se queda
    // con el conteo de la lista anterior y publica «1–1 de 1» sobre 120 filas (medido en vivo, 2026-11-23).
    // En PrimeNG 22 son signals (`ModelSignal`), no números: asignarlos directo compila con `ngc` y
    // revienta en el bundle del dev server (TS2322), que fue quien lo cazó.
    const t = this.tabla();
    if (t) { t.first.set(0); t.totalRecords.set(this.lista().length); }
  }

  tituloVacio(): string {
    if (this.vista() === 'aparte') return 'No hay pedidos viejos';
    if (this.vista() === 'decididos') return 'Todavía no se ha decidido ninguno';
    return 'Ningún pedido espera tu decisión';
  }

  /**
   * `[GP.A.5c]` Trae el auxiliar del cliente **cuando se abre el desglose**, no antes, y una sola vez por
   * pedido. Reusa `CarteraService.detalle` —el mismo que ya usa la ficha de Cartera—: la cifra del panel y
   * la de la ficha salen de la misma lectura, no de dos.
   */
  abrirFacturas(p: PedidoPorAutorizar, abierto: boolean): void {
    const llave = `${p.sucursal}|${p.cliente}`;
    if (!abierto || (this.pedidoDelDetalle === llave && this.detalle())) return;
    this.pedidoDelDetalle = llave;
    this.detalle.set(null);
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    this.cartera.detalle(p.sucursal, p.cliente).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.detalle.set(d); this.cargandoDetalle.set(false); },
      error: () => { this.errorDetalle.set('No se pudieron leer sus facturas.'); this.cargandoDetalle.set(false); },
    });
  }

  /** `[GP.A.2]` La sucursal del pedido tiene encendida la escritura en Kepler (`kepler_push_switch`, tipo autorizacion). */
  escrituraEncendida(p: PedidoPorAutorizar): boolean {
    return this.data()?.sucursales_encendidas.includes(p.sucursal) ?? false;
  }

  /** Lo que ya se decidió de este pedido, en una frase. */
  loQueSeDecidio(d: DecisionVigente): string {
    const quien = d.automatica ? 'la regla, sola,' : (d.quien ?? 'alguien');
    const cuando = new Date(d.cuando).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const hecho = d.accion === 'autorizar' ? 'lo autorizó' : d.accion === 'rechazar' ? 'lo rechazó' : d.accion === 'escalar' ? 'lo pasó a Dirección General' : 'lo regresó a CREADO';
    const nota = d.accion === 'autorizar' && d.estado !== 'ya_estaba' ? ' Kepler ya lo tiene AUTORIZADO; el ERP tarda unos minutos en reflejarlo aquí.' : '';
    return `${quien} ${hecho} el ${cuando}.${d.motivo ? ` Motivo: «${d.motivo}».` : ''}${nota}`;
  }

  /**
   * `[GP.A.5]` Autorizar o rechazar, con el motivo. Un clic deshabilita los dos botones hasta que conteste el
   * servidor. Sin motivo no manda nada: marca el campo, lo enfoca y deja que el error se anuncie — en vez de
   * ofrecer un botón apagado que no explica por qué.
   */
  decidir(p: PedidoPorAutorizar, accion: AccionDecisionPedido): void {
    const motivo = this.motivo().trim();
    if (this.enviando()) return;
    if (!motivo) {
      this.intento.set(true);
      this.campoMotivo()?.nativeElement.focus();
      return;
    }
    this.enviando.set(accion);
    this.api.decidir(p, accion, motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.enviando.set(null);
        const llego = r.estado === 'escrito' || r.estado === 'ya_estaba' || r.estado === 'registrado';
        const siguiente = this.lista()[this.indice() + 1] ?? null;
        this.toast.add({ severity: llego ? 'success' : 'warn', summary: llego ? 'Listo' : 'No se pudo', detail: r.mensaje, life: 6000 });
        this.cargar();
        // Seguir con el próximo pedido sin cerrar el panel: la cola se trabaja de corrido. El resultado viaja
        // al panel nuevo (dentro del modal), porque el toast de afuera no llega a un lector de pantalla.
        if (siguiente) { this.pasarA(siguiente); this.resultado.set(r.mensaje); }
        else { this.limpiarCaptura(); this.peekOpen.set(false); }
      },
      error: (e: { error?: { message?: string } }) => {
        this.enviando.set(null);
        const msg = e?.error?.message ?? 'No se pudo registrar la decisión.';
        // El motivo NO se borra: lo tecleado se conserva para reintentar.
        this.resultado.set(msg);
        this.toast.add({ severity: 'error', summary: 'No se pudo', detail: msg, life: 8000 });
      },
    });
  }

  subtitulo(p: PedidoPorAutorizar): string {
    return `${p.sucursal_nombre} · pedido ${p.folio} · espera ${esperaDe(p) === 'hoy' ? 'desde hoy' : esperaDe(p).replace(' d', ' días')}`;
  }

  veredicto(p: PedidoPorAutorizar): string {
    const f = fraseDe(p);
    return f.charAt(0).toUpperCase() + f.slice(1);
  }

  condiciones(p: PedidoPorAutorizar): { texto: string; ok: boolean }[] {
    const fallan = new Set(p.resultado.motivos.map((m) => m.condicion));
    return CONDICIONES.map((texto, i) => ({ texto, ok: !fallan.has((i + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) }));
  }
}
