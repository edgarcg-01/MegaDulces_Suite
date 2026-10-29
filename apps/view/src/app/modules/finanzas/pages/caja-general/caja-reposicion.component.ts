import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  ZONAS_HOJA_GASTOS, pagableConBilletesCaos, warehouseName,
  type HojaGastos, type HojasDeGastos, type ReposicionDoc, type ReposicionGrupo, type ReposicionRetiro,
  type ReposicionSucursales, type ReposicionVinculo, type AprobacionPago,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { AuthService } from '../../../../core/services/auth.service';
import { CashLedgerService } from '../../cash-ledger.service';
import { CaosService } from '../../caos.service';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';

interface OpcionOrigen { label: string; value: string }

/** Un renglón de la lista: lo que una sucursal pagó en un día, o una hoja de zona aprobada. */
type Fila =
  | { tipo: 'grupo'; clave: string; g: ReposicionGrupo }
  | { tipo: 'hoja'; clave: string; h: HojaGastos };

/**
 * ⭐ `[CGA-A.61]` **Reposición de sucursales**, en una ventana que abre la barra de Captura.
 *
 * Edgar, 2026-10-28: *«hagámoslo, pero desde una sola interfaz para tener más practicidad»*. Aquí está
 * todo junto: qué documentos de Kepler tiene cada sucursal por día de pago, de qué retiro salió cada
 * peso, y las acciones —reponer lo que sigue en la cola, confirmar la propuesta de vínculos, cambiar
 * un vínculo de retiro y, desde `[CGA-A.65]`, pagar la hoja de zona aprobada— en la misma fila.
 *
 * ⭐ `[CGA-A.65]` **La más sencilla, sin perder nada** (Edgar, 2026-10-29: *«hay que hacer la interfaz
 * más sencilla del mundo pero sin perder atención al detalle o ignorar información»*). La auditoría
 * encontró diez columnas, cinco cifras de tres universos distintos (la roja no estaba en la lista de
 * abajo), el naranja en seis papeles, encabezados más fuertes que las cifras y un renglón de Morelia
 * con dos instrucciones contrarias. Queda: cuatro columnas —quién, cuánto falta, qué sigue y el
 * desglose al abrir la fila—, tres cifras cada una con su lista, una sola acción por renglón y el
 * naranja sólo en ese botón. Nada se tiró: el total, lo de CAOS, lo del cajón y los documentos
 * están en la segunda línea o en el desglose.
 *
 * Jerarquía (Q.5): primario = cuánto falta y qué sigue; secundario = quién, el día y el total;
 * terciario = el desglose y los documentos, al abrir la fila.
 *
 * ⚠️ Quién hace qué lo vuelve a exigir el servidor: «Reponer» y «Pagar» son de quien gestiona la caja;
 * vincular y cambiar de retiro, de superadmin (`[CGA-A.58]`); y quien aprobó una hoja no la paga.
 */
@Component({
  selector: 'app-caja-reposicion',
  standalone: true,
  imports: [
    FormsModule, RouterLink, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- [CGA-A.63] Ventana y no cajón: mientras se repone, la cola pasa a segundo plano.
         Sin aboveModals: adentro hay p-select y se abre el p-dialog de cambiar de retiro. -->
    <app-side-peek mode="window" [width]="1100" [open]="abierta()" (openChange)="$event ? null : cerrarVentana()"
                   title="Reposición" [subtitle]="subtitulo()">
    <div class="rp">
      <header class="rp-head">
        @if (datos(); as d) {
          <span class="rp-lead" aria-live="polite" aria-atomic="true">
            @if (nPorResolver()) {
              {{ nPorResolver() }} <span class="rp-lead-sub">por resolver</span>
            } @else {
              <span class="rp-lead-sub">Nada por resolver</span>
            }
          </span>
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
        @if (datos()) {
          <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="vista.set($any($event))"
                         ariaLabel="Qué ver" />
        }
        <p-button icon="pi pi-refresh" size="small" severity="secondary" [text]="true" [loading]="cargando()"
                  ariaLabel="Volver a leer la reposición" (onClick)="cargar()"></p-button>
      </header>

      @if (datos()) {
        <app-metric-strip class="rp-kpis" [items]="kpis()"></app-metric-strip>
      }

      <!-- Las hojas que esperan a OTRA persona (la zona o finanzas): se dicen aquí, no son trabajo de esta lista. -->
      @if (enEspera().length || hojasNoLeidas()) {
        <p class="rp-hojas" role="status">
          <i class="pi pi-file-check" aria-hidden="true"></i>
          <span>
            @if (hojasNoLeidas()) { Las hojas de zona no se pudieron leer. }
            @for (x of enEspera(); track x.clave) { {{ x.texto }}@if (!$last) { · } }
          </span>
          <a routerLink="/finanzas/hoja-gastos">Ver las hojas</a>
        </p>
      }

      <app-load-state class="dt-scope" [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!filas().length" [skeletonRows]="3"
                      errorTitle="No se pudo leer la reposición" emptyIcon="pi-check-circle"
                      [emptyTitle]="textoVacio()"
                      [emptyHint]="pistaVacio()"
                      (retry)="cargar()">
        <p-table [value]="filas()" size="small" dataKey="clave" [expandedRowKeys]="abiertas()" class="rp-tbl dt-stack"
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
                <p-button type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" [text]="true" size="small"
                          severity="secondary" [ariaLabel]="(expanded ? 'Ocultar' : 'Ver') + ' el desglose de ' + quien(f)"
                          (onClick)="alternar(f.clave)"></p-button>
              </td>
              @if (f.tipo === 'hoja') {
                <td class="rp-quien dt-id" data-label="Sucursal" role="cell">
                  <strong>{{ f.h.nombre_zona }} · {{ f.h.folio }}</strong>
                  <small>{{ textoHoja(f.h) }}</small>
                </td>
                <td class="rp-cifra dt-num" data-label="Por resolver" role="cell">
                  <strong>{{ money(f.h.total) }}</strong>
                  <small>{{ f.h.estado === 'pagada' ? 'pagada' : 'aprobó ' + (f.h.aprobada_por_nombre ?? 'finanzas') }}</small>
                </td>
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
                    @if (puedeGestionar()) {
                      <p-button [label]="'Capturar lo que falta (' + (f.h.pago?.sin_capturar ?? 0) + ')'" icon="pi pi-refresh" size="small"
                                [disabled]="!!ocupado()" [loading]="ocupado() === f.clave" (onClick)="capturarHoja(f.h)"></p-button>
                    }
                    <small class="fin-dim">Pagada, pero {{ f.h.pago?.sin_capturar }} {{ f.h.pago?.sin_capturar === 1 ? 'pago no ha entrado' : 'pagos no han entrado' }} al libro (casi siempre, la cuenta del beneficiario).</small>
                  }
                </td>
              } @else {
                <td class="rp-quien dt-id" data-label="Sucursal" role="cell">
                  <strong>{{ nombre(f.g.sucursal) }}</strong>
                  <small>{{ dmy(f.g.fecha) }} · {{ textoDocs(f.g) }}</small>
                </td>
                <td class="rp-cifra dt-num" data-label="Por resolver" role="cell">
                  <strong>{{ porResolverDe(f.g) > 0 ? money(porResolverDe(f.g)) : '—' }}</strong>
                  <small>de {{ money(f.g.total) }}</small>
                </td>
                <td class="rp-que dt-actions" data-label="Qué sigue" role="cell">
                  <span class="rp-tags">
                    <p-tag severity="secondary" [value]="textoEstado(f.g)"></p-tag>
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
                      <small class="fin-dim">Nada pendiente.</small>
                    }
                  }
                  @if (f.g.n_sin_aprobar) {
                    <!-- [CGA-A.62] Sin aprobación no se repone: se firma en su pantalla y vuelve solo. -->
                    <a class="rp-link" routerLink="/finanzas/aprobacion-gastos">
                      <i class="pi pi-arrow-right" aria-hidden="true"></i>
                      {{ f.g.n_sin_aprobar === 1 ? '1 gasto espera' : f.g.n_sin_aprobar + ' gastos esperan' }} firma o se rechazó: no se repone. Ir a Aprobación de gastos
                    </a>
                  }
                </td>
              }
            </tr>
          </ng-template>
          <ng-template #expandedrow let-f>
            <tr>
              <td colspan="4" class="rp-det" role="cell">
                @if (f.tipo === 'hoja') {
                  <p class="rp-desglose">
                    Cerró {{ f.h.cerrada_por_nombre ?? 'sin nombre' }} · aprobó {{ f.h.aprobada_por_nombre ?? 'sin nombre' }} ·
                    al pagarla, sus {{ f.h.renglones.length }} pagos quedan ligados a un solo retiro y se deposita el total en la cuenta de la zona.
                  </p>
                  <p-table [value]="f.h.renglones" size="small" class="rp-mini">
                    <ng-template #header>
                      <tr><th>Sucursal</th><th>Día de pago</th><th>Documento de Kepler</th><th>Beneficiario</th><th class="rp-num-h">Importe</th></tr>
                    </ng-template>
                    <ng-template #body let-r>
                      <tr>
                        <td data-label="Sucursal" role="cell">{{ nombre(r.sucursal) }}</td>
                        <td class="rp-mono" data-label="Día de pago" role="cell">{{ dmy(r.fecha_pago) }}</td>
                        <td class="rp-mono dt-id" data-label="Documento de Kepler" role="cell">{{ r.doc_tipo }} {{ r.folio }}</td>
                        <td data-label="Beneficiario" role="cell">{{ r.beneficiario ?? '—' }}</td>
                        <td class="rp-num dt-num" data-label="Importe" role="cell">{{ money(r.importe) }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                } @else {
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
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      @if (datos(); as d) {
        <p class="rp-universo fin-dim">
          @for (z of d.universo.en_hoja ?? []; track z.zona) {
            {{ nombreZona(z.zona) }}: {{ z.n }} {{ z.n === 1 ? 'pago' : 'pagos' }} de estos días ({{ money(z.total) }}) van en su hoja, no en esta lista.
          }
          @if (d.universo.sin_documentos.length) {
            Sin documentos de caja en estos días: {{ nombres(d.universo.sin_documentos) }}.
          }
          {{ textoAprobacion() }}
          Oficinas no se repone: Caja General paga directo lo suyo.
        </p>
      }
    </div>
    </app-side-peek>

    <!-- appendTo body: se abre DESDE la ventana y tiene que quedar encima de ella, no adentro. -->
    <p-dialog [visible]="mover() !== null" (visibleChange)="$event ? null : cerrarMover()" [modal]="true" appendTo="body"
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
        <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="cerrarMover()"></p-button>
        <p-button label="Cambiar de retiro" icon="pi pi-check" [disabled]="!destinoMover || motivoMover.trim().length < 10 || !!ocupado()"
                  [loading]="ocupado() === 'mover'" (onClick)="confirmarMover()"></p-button>
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
    :host ::ng-deep .rp-mini .p-datatable-thead > tr > th {
      font-family:var(--font-body); font-size:var(--fs-micro); font-weight:700; text-transform:uppercase;
      letter-spacing:.06em; color:var(--text-muted);
    }
    .rp-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin-bottom:var(--sp-2); }
    .rp-sp { flex:1 1 auto; }
    .rp-lead { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); font-weight:700; color:var(--fg-1); }
    .rp-lead-sub { font-family:var(--font-body); font-weight:400; color:var(--text-muted); }
    .rp-warn { color:var(--warn-soft-fg); font-size:var(--fs-xs); }
    .rp-kpis { display:block; margin-bottom:var(--sp-2); }
    .rp-hojas { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin:0 0 var(--sp-2);
                font-size:var(--fs-sm); color:var(--fg-2); }
    .rp-num-h { text-align:right; }
    .rp-num { text-align:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .rp-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    /* Dos líneas por celda: lo que importa arriba, su contexto abajo (Q.5 por tamaño y contraste, sin color). */
    .rp-quien, .rp-cifra { vertical-align:top; }
    .rp-quien strong { display:block; font-weight:600; color:var(--fg-1); }
    .rp-quien small, .rp-cifra small { display:block; font-size:var(--fs-xs); color:var(--text-muted); }
    .rp-cifra { text-align:right; white-space:nowrap; }
    .rp-cifra strong { display:block; font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-md); font-weight:700; color:var(--fg-1); }
    .rp-dim { color:var(--text-muted); }
    .rp-falta { font-weight:600; color:var(--fg-1); }
    .rp-col-tog { width:2.5rem; }
    .rp-que { min-width:18rem; }
    .rp-que small { display:block; margin-top:var(--sp-1); max-width:30rem; }
    .rp-accion { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin-top:var(--sp-1); }
    .rp-sel { min-width:14rem; }
    .rp-det { background:var(--surface-2); padding:var(--sp-3); }
    .rp-desglose { margin:0 0 var(--sp-2); color:var(--fg-2); }
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
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /** `[CGA-A.65]` Las hojas de zona. `null` + `hojasNoLeidas` = no se pudo leer: se dice, no se pinta vacío. */
  readonly hojas = signal<HojasDeGastos | null>(null);
  readonly hojasNoLeidas = signal(false);
  /** `[CGA-A.63]` La ventana de la reposición; la abre el botón de la barra de Captura. */
  readonly abierta = signal(false);
  /** El botón que la abrió: al cerrar, el foco vuelve ahí y no al `<body>`. */
  private origen: HTMLElement | null = null;
  /**
   * Qué grupos se ven. ⭐ Medido en prod el 2026-10-28 (ventana 22–28/10): de 28 sucursal-día, 20
   * tenían egresos sin vincular y NINGÚN retiro de su sucursal — son de antes del proceso nuevo, o
   * se pagaron por otro lado. Mezclados con los de un clic, la lista de «pendientes» era casi toda
   * filas sin acción posible. Van aparte: son la señal de descuadre, no trabajo de un clic.
   */
  readonly vista = signal<'resolver' | 'sin_retiro' | 'explicadas'>('resolver');
  readonly abiertas = signal<Record<string, boolean>>({});
  /** D.7: la fila con el foco de teclado (flechas por `pSelectableRow`; Enter abre su desglose). */
  readonly filaActiva = signal<Fila | null>(null);
  /** Lo que está escribiendo (idempotencia visual): la clave de la fila, o `'mover'`. */
  readonly ocupado = signal<string | null>(null);
  private readonly elegidos = signal<Record<string, string>>({});
  private readonly elegidosHoja = signal<Record<string, string>>({});
  readonly mover = signal<{ vinculo: ReposicionVinculo; folio: string } | null>(null);
  destinoMover: string | null = null;
  motivoMover = '';

  readonly esSuperadmin = computed(() => this.perms.isSuperadmin());
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
  readonly nPorResolver = computed(() => this.accionables().length + this.hojasPorPagar().length);

  readonly filas = computed<Fila[]>(() => {
    const v = this.vista();
    const deGrupo = (gs: ReposicionGrupo[]): Fila[] => gs.map((g) => ({ tipo: 'grupo' as const, clave: g.clave, g }));
    if (v === 'sin_retiro') return deGrupo(this.sinRetiro());
    if (v === 'explicadas') return deGrupo(this.explicadas());
    return [...this.hojasPorPagar().map((h) => ({ tipo: 'hoja' as const, clave: `hoja|${h.id}`, h })), ...deGrupo(this.accionables())];
  });
  readonly opcionesVista = computed<SegOption[]>(() => [
    { label: 'Por resolver', value: 'resolver', count: this.nPorResolver() },
    { label: 'Sin retiro', value: 'sin_retiro', count: this.sinRetiro().length },
    { label: 'Explicadas', value: 'explicadas', count: this.explicadas().length },
  ]);

  /** `[CGA-A.65]` Las hojas que esperan a otra persona —la zona o finanzas—, en una línea cada una. */
  readonly enEspera = computed<Array<{ clave: string; texto: string }>>(() => {
    const h = this.hojas();
    if (!h) return [];
    const abiertas = h.abiertas.filter((a) => a.renglones.length).map((a) => ({
      clave: `a|${a.zona}`,
      texto: `${a.nombre}: hoja abierta con ${a.renglones.length} ${a.renglones.length === 1 ? 'pago' : 'pagos'} (${money(a.total)}), la cierra la zona`,
    }));
    const cerradas = h.cerradas.filter((c) => c.estado === 'cerrada').map((c) => ({
      clave: `c|${c.id}`, texto: `${c.folio} (${c.nombre_zona}, ${money(c.total)}) espera la aprobación de finanzas`,
    }));
    return [...abiertas, ...cerradas];
  });

  /**
   * `[CGA-A.63]` Lo que dice el botón de la barra sin abrir nada: las mismas cuentas que los
   * filtros de la ventana, para que lo de afuera y lo de adentro digan lo mismo. Sin importes: el
   * botón es la puerta, la cifra está adentro con su desglose. Lo que no se midió se dice; un
   * Kepler sin medir no es «nada pendiente».
   */
  readonly resumen = computed(() => {
    const d = this.datos();
    if (!d) return this.error() ? 'no se pudo leer' : 'leyendo…';
    if (!d.datos_al) return 'Kepler sin medir';
    const partes: string[] = [];
    if (this.nPorResolver()) partes.push(`${this.nPorResolver()} por resolver`);
    if (this.sinRetiro().length) partes.push(`${this.sinRetiro().length} sin retiro`);
    if (!d.caos_al) partes.push('CAOS sin medir');
    return partes.length ? partes.join(' · ') : 'nada pendiente';
  });
  /** El título repite el rótulo del botón —como «Tu jornada»—; el resto va aquí. */
  readonly subtitulo = computed(() => {
    const d = this.datos();
    return d ? `de sucursales · pago del ${dmy(d.desde)} al ${dmy(d.hasta)}` : 'de sucursales';
  });

  /**
   * Tres cifras, y cada una dice de qué lista es: la auditoría encontró cinco de tres universos, y la
   * roja ($121,992.87 el 29/10) no estaba en la lista de abajo. La aprobación y lo que espera su hoja
   * no se perdieron: van en el renglón y en el pie.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const porResolver = Math.round((this.accionables().reduce((a, g) => a + this.porResolverDe(g), 0)
      + this.hojasPorPagar().filter((h) => h.estado === 'aprobada').reduce((a, h) => a + h.total, 0)) * 100) / 100;
    const sinRetiro = this.sinRetiro().reduce((a, g) => a + g.sin_vincular, 0);
    const cajon = this.grupos().reduce((a, g) => a + g.cajon, 0);
    const n = this.nPorResolver();
    const m = this.sinRetiro().length;
    return [
      { label: 'Por resolver', value: porResolver, format: 'currency2', tone: 'default',
        sub: `${n} ${n === 1 ? 'renglón' : 'renglones'} en «Por resolver», cada uno con su acción` },
      { label: 'Sin retiro que lo explique', value: sinRetiro, format: 'currency2', tone: sinRetiro > 0 ? 'bad' : 'ok',
        sub: `${m} ${m === 1 ? 'sucursal-día' : 'sucursales-día'} en «Sin retiro»: CAOS no dice de dónde salió` },
      { label: 'Del cajón', value: cajon, format: 'currency2', tone: 'muted', sub: 'lo que CAOS no dio, en estos días' },
    ];
  });

  /** `[CGA-A.62]` La aprobación de los días de la ventana, en una frase: antes era una cifra en cero. */
  readonly textoAprobacion = computed(() => {
    const sinAprobar = this.grupos().reduce((a, g) => a + g.n_sin_aprobar, 0);
    const antes = this.grupos().reduce((a, g) => a + g.n_pagado_antes_de_aprobar, 0);
    if (!sinAprobar && !antes) return 'Nada espera firma ni se pagó antes de aprobarse.';
    return `${sinAprobar} ${sinAprobar === 1 ? 'gasto espera' : 'gastos esperan'} firma o se rechazó; ${antes} ${antes === 1 ? 'se pagó' : 'se pagaron'} antes de aprobarse.`;
  });

  readonly textoVacio = computed(() => {
    const v = this.vista();
    if (v === 'sin_retiro') return 'Todos los egresos de sucursal tienen su retiro';
    if (v === 'explicadas') return 'Ninguna sucursal está explicada todavía en estos días';
    return 'Nada por resolver';
  });
  readonly pistaVacio = computed(() => {
    if (this.vista() !== 'resolver') return 'Cambia de filtro arriba para ver las demás.';
    const n = this.sinRetiro().length;
    return n ? `Hay ${n} ${n === 1 ? 'sucursal-día' : 'sucursales-día'} con egresos que ningún retiro explica: filtro «Sin retiro».`
      : 'Sin documentos de caja de sucursal pendientes en estos días.';
  });

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
    this.api.hojasDeGastos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => { this.hojas.set(h); this.hojasNoLeidas.set(false); },
      error: () => { this.hojas.set(null); this.hojasNoLeidas.set(true); },
    });
  }

  /** Abre la ventana y RELEE: lo que la cola confirmó desde que se cargó ya no está por capturar. */
  abrirVentana(origen?: HTMLElement): void {
    this.origen = origen ?? null;
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
  quien(f: Fila): string { return f.tipo === 'hoja' ? f.h.folio : `${this.nombre(f.g.sucursal)} del ${dmy(f.g.fecha)}`; }

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
    const clave = `hoja|${h.id}`;
    if (!e || this.ocupado()) return;
    const r = h.retiros_que_cuadran.find((x) => this.llave(x) === e);
    if (e !== 'cajon' && !r) return;
    this.ocupado.set(clave);
    const body = r ? { medio: 'caos' as const, device: r.device, external_id: r.external_id } : { medio: 'cajon' as const };
    this.api.pagarHojaDeGastos(h.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(null);
        const faltan = x.sin_capturar.length;
        this.toast.add({
          severity: faltan ? 'warn' : 'success', summary: `${x.hoja.folio} pagada`,
          detail: `${x.capturados + x.ligados} ${x.capturados + x.ligados === 1 ? 'pago quedó explicado' : 'pagos quedaron explicados'} por ${r ? 'el retiro' : 'el cajón'}.`
            + (faltan ? ` ${faltan} sin capturar: ${x.sin_capturar[0].motivo ?? 'reintenta con «Capturar lo que falta»'}.` : ''),
          life: 8000,
        });
        this.cargar();
        this.cambio.emit();
      },
      error: (err) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'error', summary: `No se pagó ${h.folio}`, detail: this.textoError(err), life: 10000 });
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
        const faltan = x.sin_capturar.length;
        this.toast.add({ severity: faltan ? 'warn' : 'success', summary: `${x.hoja.folio}: ${x.capturados} ${x.capturados === 1 ? 'capturado' : 'capturados'}`,
          detail: faltan ? `${faltan} todavía sin capturar: ${x.sin_capturar[0].motivo ?? 'revisa su cuenta contable'}.` : 'Todos sus pagos ya están en el libro.', life: 8000 });
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
          const fallaron = r.rechazados + r.no_confirmables;
          const sobre = r.retiro ? ` · CAOS ${money(r.retiro.tomado)}, cajón ${money(r.retiro.del_cajon)}` : '';
          this.toast.add({
            severity: fallaron ? 'warn' : 'success',
            summary: `${this.nombre(g.sucursal)} ${dmy(g.fecha)}`,
            detail: `${r.guardados} de ${items.length} egresos guardados por ${money(r.monto_guardado)}${sobre}`
              + (fallaron ? ` · ${fallaron} no se pudieron: siguen en la cola` : '') + '.',
            life: 8000,
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
