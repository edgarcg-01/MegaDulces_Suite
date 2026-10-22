import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import {
  ContpaqiPuenteService, LoteRow, LotesResp, CuadreResp,
  PendienteProveedor, PendientesResp, ReglaVista, PagoPorConfirmar, CfdiPropuesto, MovimientosResp,
  FiltroMovimientos, MovimientoBanco, CategoriaEgreso, VistaPreviaBeneficiario,
} from '../contpaqi-puente.service';

/**
 * Fase CP `[CP.8.33]` — **Las pólizas de egresos de banco para ContPAQi, mes por mes.**
 *
 * ── `[CP.8.76]` Un asistente de cuatro pasos, no una bandeja ───────────────────────────────
 * La versión anterior contestaba siete preguntas en un solo scroll (cuánto sale, de quién es
 * cada rechazo, qué lotes hay, firmar reglas, confirmar proveedores, confirmar pagos, entregar):
 * diez bloques, seis tablas y prosa escrita para quien la programó. El PM la reportó «muy
 * complicada de entender» y eligió partirla en pasos (2026-10-21). Ahora:
 *
 *   arriba   → la respuesta: cuántas pólizas están listas y qué falta, en una frase;
 *   pasos    → 1 reglas · 2 proveedores · 3 pagos · 4 revisar y entregar, cada uno con lo que
 *              le queda; abre en el primero que tiene trabajo;
 *   cuerpo   → sólo el paso elegido, con su instrucción en una línea.
 *
 * El rechazo con dueño (`[CP.8.33]`) y los lotes viven en el paso 4: son la revisión antes de
 * entregar, no lo primero que se lee.
 *
 * ── Entregar ────────────────────────────────────────────────────────────────────────────────
 * **No manda nada a ContPAQi.** `[CP.8.54]` «Marcar como cargado» registra que contabilidad ya
 * CARGÓ el archivo, y sólo acepta ese mismo archivo (el backend lo compara byte a byte con el que
 * genera hoy). Va separado de «Generar» porque descargar no es entregar. Exige `_GESTIONAR`.
 *
 * ── ⚠️ Ruta propia, no un tab de `/contabilidad/contpaqi` ───────────────────────────────────
 * Esa página ya existe desde CP.1–CP.4 y es el **otro sentido** (lee los libros que ContPAQi ya
 * tiene), gateada por `FISCAL_CONTAB_VER`. Colgar el puente ahí lo habría escondido detrás del
 * permiso equivocado: quien revisa los libros fiscales no es quien arma la póliza de egresos.
 */
@Component({
  selector: 'app-contabilidad-contpaqi-puente',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, TagModule, MetricStripComponent,
    LoadStateComponent, FreshnessPillComponent, SidePeekComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cpp-page">

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>P&oacute;lizas de egresos para ContPAQi <app-context-help topic="contpaqi-puente" /></h1>
        </div>
        <div class="surf-page-head-actions">
          <span class="cpp-buscar">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input type="search" class="cpp-buscar-in" placeholder="Buscar proveedor, RFC o concepto"
                   aria-label="Buscar movimientos del mes por proveedor, razón social, RFC o concepto"
                   [ngModel]="busqueda()" (ngModelChange)="escribirBusqueda($event)" (keydown.enter)="buscarYa()" />
          </span>
          @if (cargadoEn(); as t) { <app-freshness-pill measures="fetch" [since]="t" [staleAfterSec]="600" /> }
          <p-select [options]="mesOpts" [ngModel]="mes()" (ngModelChange)="setMes($event)"
                    appendTo="body" class="cpp-sel" [style]="{ minWidth: '10rem' }"
                    ariaLabel="Mes"></p-select>
        </div>
      </header>

      <app-load-state [loading]="loading()" [error]="error()" errorTitle="No se pudo leer el mes"
                      [skeletonRows]="8" (retry)="cargar()">
        @if (data(); as d) {

          <!-- Q.1 · la respuesta, antes que cualquier tabla -->
          <section class="cpp-verdict">
            <h2>
              <span class="mono">{{ d.resumen.con_asiento | number }}</span>
              {{ d.resumen.con_asiento === 1 ? 'póliza lista' : 'pólizas listas' }}
              <span class="cpp-v-imp mono">{{ importeListo() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
            </h2>
          </section>

          <!-- Los pasos: cada uno dice lo que le queda. El estado no depende sólo del color. -->
          <nav class="cpp-pasos" [attr.aria-label]="'Pasos del mes. ' + queFalta()">
            <ol>
              @for (p of pasos(); track p.id; let i = $index) {
                <li>
                  <button type="button" class="cpp-paso" [class.on]="paso() === p.id" [class.hecho]="p.pendientes === 0"
                          [class.mal]="p.error" [attr.aria-current]="paso() === p.id ? 'step' : null" (click)="irA(p.id)">
                    <span class="cpp-paso-n" aria-hidden="true">
                      @if (p.pendientes === 0) { <i class="pi pi-check"></i> } @else { {{ i + 1 }} }
                    </span>
                    <span class="cpp-paso-txt">
                      <span class="cpp-paso-t">{{ p.titulo }}</span>
                      <span class="cpp-paso-s">{{ p.estado }}</span>
                    </span>
                  </button>
                </li>
              }
            </ol>
          </nav>

          <section class="cpp-cuerpo" aria-live="polite">
            @switch (paso()) {

              <!-- ── 1 · REGLAS DE CUENTA ── -->
              @case ('reglas') {
                <h3>Firma la cuenta de cada tipo de gasto</h3>
                @if (reglasError(); as e) {
                  <div class="cpp-aviso mal" role="alert">No se pudieron leer las reglas: {{ e }}</div>
                } @else if (reglas() === null) {
                  <app-load-state [loading]="true" [skeletonRows]="5" />
                } @else {
                  @if (soloCategoria(); as sc) {
                    <div class="cpp-solo"><span>Mostrando sólo: <strong>{{ nombreDeCategoria(sc) }}</strong></span>
                      <button type="button" class="cpp-link" (click)="soloCategoria.set(null)">Ver todos</button></div>
                  }
                  <div class="card-premium card-flat cpp-tablewrap">
                    <p-table [value]="reglasVisibles()" size="small" class="surf-table" [rowHover]="true" dataKey="categoria_code">
                      <ng-template #header>
                        <tr><th>Tipo de gasto</th><th class="ta-r">Movs</th><th class="ta-r">Importe</th>
                          <th>Cuenta de gasto</th></tr>
                      </ng-template>
                      <ng-template #body let-r>
                        <tr>
                          <td><span class="cpp-bank">{{ nombreRegla(r) }}</span></td>
                          <td class="ta-r">
                            @if (r.movimientos_mes > 0) {
                              <button type="button" class="cpp-cifra mono" (click)="verMovimientos({ categoria: r.categoria_code }, nombreRegla(r))"
                                      [attr.aria-label]="'Ver los ' + r.movimientos_mes + ' movimientos de ' + nombreRegla(r)">{{ r.movimientos_mes | number }}</button>
                            } @else { <span class="mono muted">0</span> }
                          </td>
                          <td class="ta-r mono" [class.muted]="r.movimientos_mes === 0">{{ r.importe_mes | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                          <td class="cpp-cta">
                            @if (r.estado === 'aprobada') {
                              <div class="cpp-firma">
                                <span><span class="mono">{{ r.cuenta_gasto }}</span> {{ r.cuenta_nombre }}
                                  <span class="cpp-sub">firmada por {{ r.aprobada_por }} &middot; {{ r.aprobada_en }}</span></span>
                                @if (puedeGestionar()) {
                                  <button type="button" class="cpp-btn-bad cpp-lejos" [disabled]="firmando() === r.categoria_code"
                                          (click)="revocar(r)">{{ firmando() === r.categoria_code ? 'Quitando…' : 'Quitar firma' }}</button>
                                }
                              </div>
                            } @else if (puedeGestionar()) {
                              <div class="cpp-firma">
                                <p-select [options]="cuentas()" [ngModel]="cuentaElegida()[r.categoria_code] ?? null"
                                          (ngModelChange)="elegirCuenta(r.categoria_code, $event)"
                                          optionLabel="etiqueta" optionValue="codigo" [filter]="true" filterBy="etiqueta"
                                          placeholder="Elige la cuenta" appendTo="body" [showClear]="true"
                                          class="cpp-sel-cta" [ariaLabel]="'Cuenta de gasto para ' + nombreRegla(r)"></p-select>
                                <button type="button" class="cpp-btn-ok"
                                        [disabled]="!cuentaElegida()[r.categoria_code] || firmando() === r.categoria_code"
                                        (click)="firmar(r)">{{ firmando() === r.categoria_code ? 'Firmando…' : 'Firmar' }}</button>
                              </div>
                              @if (pistaDe(r); as p) {
                                <button type="button" class="cpp-pista" (click)="elegirCuenta(r.categoria_code, p.codigo)">
                                  <i class="pi pi-lightbulb" aria-hidden="true"></i> Pista: {{ p.etiqueta }}
                                </button>
                              }
                            } @else {
                              <span class="muted">sin firmar</span>
                            }
                          </td>
                        </tr>
                      </ng-template>
                      <ng-template #emptymessage>
                        <tr><td colspan="4" class="cpp-empty">Ning&uacute;n tipo de gasto de este mes espera firma.</td></tr>
                      </ng-template>
                    </p-table>
                  </div>
                  @if (reglasOcultas() > 0) {
                    <button type="button" class="cpp-link mt" (click)="todasLasReglas.set(!todasLasReglas())">
                      {{ todasLasReglas() ? 'Ver sólo las de este mes' : 'Ver también ' + reglasOcultas() + ' sin movimientos este mes' }}
                    </button>
                  }
                  @if (avisoRegla(); as a) {
                    <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
                  }
                  @if (noFirmables().length) {
                    <details class="cpp-mas">
                      <summary>{{ noFirmables().length }} tipos de gasto no se firman aqu&iacute;</summary>
                      <ul class="cpp-lista-simple">
                        @for (r of noFirmables(); track r.categoria_code) {
                          <li><span>{{ nombreRegla(r) }}</span> <span class="muted">&middot; {{ porQueNoSeFirma(r) }}</span>
                            @if (r.movimientos_mes > 0) { &middot; <button type="button" class="cpp-cifra mono" (click)="verMovimientos({ categoria: r.categoria_code }, nombreRegla(r))">{{ r.movimientos_mes | number }}</button> movs }</li>
                        }
                      </ul>
                    </details>
                  }
                }
              }
              <!-- ── 2 · PROVEEDORES ── -->
              @case ('proveedores') {
                <h3>Confirma la cuenta de cada nombre del banco</h3>
                @if (proveedoresError(); as e) {
                  <div class="cpp-aviso mal" role="alert">No se pudieron leer los proveedores: {{ e }}</div>
                } @else if (porConfirmar(); as p) {
                  <app-load-state [isEmpty]="!p.filas.length" emptyIcon="pi-check-circle"
                                  emptyTitle="Todos los nombres de este mes ya tienen cuenta">
                    @if (soloNombre(); as sn) {
                      <div class="cpp-solo"><span>Mostrando sólo un nombre del banco</span>
                        <button type="button" class="cpp-link" (click)="soloNombre.set(null)">Ver todos</button></div>
                    }
                    <div class="card-premium card-flat cpp-tablewrap">
                      <p-table [value]="provVisibles()" size="small" class="surf-table" [rowHover]="true"
                               [scrollable]="true" scrollHeight="480px">
                        <ng-template #header>
                          <tr><th>Nombre en el banco</th><th class="ta-r">Movs</th><th class="ta-r">Importe</th>
                            <th>Cuenta en ContPAQi</th><th></th></tr>
                        </ng-template>
                        <ng-template #body let-f>
                          <tr>
                            <td><span class="cpp-bank">{{ f.concepto_banco }}</span></td>
                            <td class="ta-r">
                              <button type="button" class="cpp-cifra mono" (click)="verMovimientos({ nombre: f.alias_normalizado }, f.concepto_banco)"
                                      [attr.aria-label]="'Ver los ' + f.movimientos + ' movimientos de ' + f.concepto_banco">{{ f.movimientos | number }}</button>
                            </td>
                            <td class="ta-r mono">{{ f.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                            <td>
                              @if (!f.sugerencias.length) {
                                <span class="muted">sin candidato parecido: b&uacute;scalo en ContPAQi</span>
                              }
                              @for (s of f.sugerencias; track s.cuenta) {
                                <label class="cpp-sug">
                                  <input type="radio" [name]="'sug-' + f.alias_normalizado" [value]="s.cuenta"
                                         [checked]="elegido()[f.alias_normalizado] === s.cuenta" [disabled]="!puedeGestionar()"
                                         (change)="elegir(f.alias_normalizado, s.cuenta)">
                                  <span class="mono">{{ s.cuenta }}</span>
                                  <span>{{ s.nombre }}</span>
                                </label>
                              }
                            </td>
                            <td class="ta-r">
                              @if (puedeGestionar()) {
                                <button type="button" class="cpp-btn-ok"
                                        [disabled]="!elegido()[f.alias_normalizado] || guardando() === f.alias_normalizado"
                                        (click)="confirmar(f)">
                                  {{ guardando() === f.alias_normalizado ? 'Guardando…' : 'Confirmar' }}
                                </button>
                              }
                            </td>
                          </tr>
                        </ng-template>
                      </p-table>
                    </div>
                  </app-load-state>
                  @if (avisoAlias(); as a) {
                    <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
                  }
                } @else {
                  <app-load-state [loading]="true" [skeletonRows]="5" />
                }
              }

              <!-- ── 3 · PAGOS A PROVEEDOR ── -->
              @case ('pagos') {
                <h3>Elige las facturas que paga cada pago</h3>
                @if (pagosError(); as pe) {
                  <div class="cpp-aviso mal" role="alert">No se pudieron leer los pagos: {{ pe }}</div>
                } @else if (pagos(); as pc) {
                  <app-load-state [isEmpty]="!pc.length" emptyIcon="pi-check-circle"
                                  emptyTitle="Todos los pagos a proveedor de este mes se arman solos">
                    <div class="cpp-md">
                      <div class="card-premium card-flat cpp-tablewrap">
                        <p-table [value]="pc" size="small" class="surf-table" [rowHover]="true"
                                 [scrollable]="true" scrollHeight="480px"
                                 selectionMode="single" [selection]="pagoSel()" (selectionChange)="elegirPago($event)"
                                 dataKey="movimiento_id">
                          <ng-template #header>
                            <tr><th>Fecha</th><th>Banco</th><th class="ta-r">Importe</th><th>Estado</th></tr>
                          </ng-template>
                          <ng-template #body let-p>
                            <tr [pSelectableRow]="p">
                              <td class="muted mono">{{ p.fecha }}</td>
                              <td><span class="cpp-bank">{{ p.banco_label || p.cuenta_banco }}</span>
                                <span class="cpp-sub">{{ p.concepto }}</span></td>
                              <td class="ta-r mono">{{ p.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                              <td>
                                @if (p.confirmacion?.vigente) { <p-tag severity="success" value="Confirmado" /> }
                                @else if (!p.propuesta) { <p-tag severity="warn" value="Proveedor sin identificar" /> }
                                @else { <p-tag severity="secondary" value="Por confirmar" /> }
                              </td>
                            </tr>
                          </ng-template>
                        </p-table>
                      </div>

                      <aside class="card-premium card-flat cpp-peek">
                        @if (pagoSel(); as s) {
                          <h4 class="mono">{{ s.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</h4>
                          <div class="cpp-sub">{{ s.banco_label || s.cuenta_banco }} &middot; {{ s.fecha }} &middot; {{ s.concepto }}</div>
                          @if (!s.propuesta) {
                            <p class="cpp-note">No se sabe de qu&eacute; proveedor es: Kepler no tiene el pago y el concepto no lleva a nadie.
                              Compras tiene que corregir el RFC del proveedor; despu&eacute;s aparece aqu&iacute; con sus facturas.</p>
                          } @else {
                            <div class="cpp-kvs">
                              <div class="cpp-kv"><span>Proveedor (RFC)</span><span class="mono">{{ s.propuesta.rfc }}</span></div>
                              @if (!s.confirmacion?.vigente) {
                                <div class="cpp-kv"><span>Por qu&eacute; no sali&oacute; solo</span><span>{{ s.motivo }}</span></div>
                              } @else {
                                <div class="cpp-kv"><span>Confirm&oacute;</span><span>{{ s.confirmacion?.confirmado_por }}</span></div>
                              }
                            </div>
                            @if (s.propuesta.sugerencia.length && puedeGestionar()) {
                              <button type="button" class="cpp-btn-ok mt" (click)="usarSugerencia()">
                                <i class="pi pi-bolt" aria-hidden="true"></i>
                                Marcar la sugerencia ({{ s.propuesta.origen === 'kepler' ? 'lo que aplicó Kepler' : 'la única que da el importe' }})
                              </button>
                            }
                            <div class="cpp-eyebrow mt">Facturas ({{ s.propuesta.facturas.length | number }})</div>
                            <div class="cpp-lista">
                              @for (f of candidatas(); track f.uuid) {
                                <label class="cpp-sug">
                                  <input type="checkbox" [checked]="marcadasF().has(f.uuid)" [disabled]="!puedeGestionar()"
                                         (change)="alternar('f', f.uuid)">
                                  <span class="mono">{{ f.folio || 'sin folio' }}</span>
                                  <span class="muted mono">{{ f.fecha }}</span>
                                  <span class="mono">{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                                  @if (f.sugerida) { <p-tag severity="info" value="sugerida" /> }
                                  @if (f.pagada_antes) { <p-tag severity="warn" [value]="'ya en un pago del ' + f.pagada_antes" /> }
                                </label>
                              }
                            </div>
                            @if (s.propuesta.notas.length) {
                              <div class="cpp-eyebrow mt">Notas de cr&eacute;dito ({{ s.propuesta.notas.length | number }})</div>
                              <div class="cpp-lista">
                                @for (n of s.propuesta.notas; track n.uuid) {
                                  <label class="cpp-sug">
                                    <input type="checkbox" [checked]="marcadasN().has(n.uuid)" [disabled]="!puedeGestionar()"
                                           (change)="alternar('n', n.uuid)">
                                    <span class="mono">{{ n.folio || 'sin folio' }}</span>
                                    <span class="muted mono">{{ n.fecha }}</span>
                                    <span class="mono">{{ n.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                                  </label>
                                }
                              </div>
                            }
                            @if (cuadrePago(); as c) {
                              <div class="cpp-kvs mt">
                                <div class="cpp-kv"><span>Facturas marcadas</span><span class="mono">{{ c.facturas | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                                <div class="cpp-kv"><span>&minus; Notas marcadas</span><span class="mono">{{ c.notas | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                                <div class="cpp-kv"><span>Pagado</span><span class="mono">{{ s.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                                <div class="cpp-kv cpp-kv-total"><span>{{ c.cuadra ? 'Cuadra' : 'Falta cuadrar' }}</span>
                                  <span class="mono" [class.cpp-mal]="!c.cuadra">{{ c.diferencia | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                              </div>
                              @if (puedeGestionar()) {
                                <div class="cpp-acciones">
                                  <button type="button" class="cpp-btn-ok" [disabled]="!c.cuadra || confirmandoPago()" (click)="confirmarPago()">
                                    {{ confirmandoPago() ? 'Guardando…' : 'Confirmar' }}
                                  </button>
                                  @if (s.confirmacion?.vigente) {
                                    <button type="button" class="cpp-btn-bad cpp-lejos" [disabled]="confirmandoPago()" (click)="desconfirmarPago()">Quitar la confirmaci&oacute;n</button>
                                  }
                                </div>
                              }
                            }
                          }
                          @if (avisoPago(); as a) {
                            <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div>
                          }
                        } @else {
                          <p class="cpp-note">Elige un pago de la lista.</p>
                        }
                      </aside>
                    </div>
                  </app-load-state>
                } @else {
                  <app-load-state [loading]="true" [skeletonRows]="5" />
                }
              }

              <!-- ── 4 · REVISAR Y ENTREGAR ── -->
              @case ('archivo') {
                <h3>Descarga el archivo y m&aacute;rcalo como cargado</h3>

                <app-metric-strip [items]="kpis()" ariaLabel="Resumen del mes" (drill)="abrirKpi($event)" />

                @if (puedeGestionar()) {
                  <div class="cpp-entrega">
                    <button type="button" class="cpp-btn-ok" [disabled]="bajando() || d.resumen.con_asiento === 0" (click)="descargar()">
                      <i class="pi pi-download" aria-hidden="true"></i>
                      {{ bajando() ? 'Generando…' : 'Descargar el archivo' }}
                    </button>
                    <input #archivoCargado type="file" accept=".txt,text/plain" class="cpp-file"
                           (change)="marcarEntregado(archivoCargado)" aria-label="Archivo que se cargó en ContPAQi" />
                    <button type="button" class="cpp-btn-ok" [disabled]="entregando() || d.resumen.con_asiento === 0" (click)="archivoCargado.click()">
                      <i class="pi pi-check" aria-hidden="true"></i>
                      {{ entregando() ? 'Comparando…' : 'Ya lo cargué: elegir el archivo' }}
                    </button>
                  </div>
                  @if (avisoArchivo(); as a) { <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div> }
                  @if (avisoEntrega(); as a) { <div class="cpp-aviso" [class.mal]="a.mal" role="status">{{ a.texto }}</div> }
                }
                @if (cuadre(); as c) {
                  <p class="cpp-ojo">
                    <i class="pi pi-sync" aria-hidden="true"></i>
                    @if (!c.hay_entregas) {
                      Todav&iacute;a no se ha marcado ning&uacute;n archivo como cargado.
                    } @else {
                      En ContPAQi: <strong class="mono">{{ c.verificadas | number }}</strong> encontradas,
                      <strong class="mono">{{ c.esperando | number }}</strong> por revisar,
                      <strong class="mono" [class.cpp-mal]="c.divergentes > 0">{{ c.divergentes | number }}</strong>
                      que no aparecieron en {{ c.plazo_dias }} d&iacute;as.
                    }
                  </p>
                }

                <h4 class="cpp-h4">Lo que no entra, y a qui&eacute;n le toca</h4>
                @if (d.fuera_de_lote.movimientos > 0) {
                  <p class="cpp-sub-p">Aparte: <button type="button" class="cpp-cifra mono" (click)="verMovimientos({ motivo: 'fuera_de_banco' }, 'Fuera de banco')">{{ d.fuera_de_lote.movimientos | number }}</button> de {{ cuentasFuera() }} (no son banco).</p>
                }
                <div class="card-premium card-flat cpp-tablewrap">
                  <p-table [value]="motivosConTrabajo()" size="small" class="surf-table">
                    <ng-template #header>
                      <tr><th>Por qu&eacute; no entra</th><th class="ta-r">Movs</th><th>Le toca a</th></tr>
                    </ng-template>
                    <ng-template #body let-m>
                      <tr>
                        <td>{{ etiqueta(m.motivo) }}</td>
                        <td class="ta-r"><button type="button" class="cpp-cifra mono" [class.muted]="esDeNadie(m.motivo)"
                              (click)="verMovimientos({ motivo: m.motivo }, etiqueta(m.motivo))">{{ m.movimientos | number }}</button></td>
                        <td [class.muted]="esDeNadie(m.motivo)">{{ duenoCorto(m.dueno) }}</td>
                      </tr>
                    </ng-template>
                    <ng-template #emptymessage>
                      <tr><td colspan="3" class="cpp-empty">Todo el mes entra al archivo.</td></tr>
                    </ng-template>
                  </p-table>
                </div>

                <h4 class="cpp-h4">Las p&oacute;lizas del mes</h4>
                <div class="cpp-chips">
                  <button type="button" class="cpp-chip" [class.on]="filtro() === null"
                          [attr.aria-pressed]="filtro() === null" (click)="toggleMotivo(null)">
                    Todas <span class="mono">{{ d.lotes.length | number }}</span>
                  </button>
                  @for (m of d.motivos; track m.motivo) {
                    <button type="button" class="cpp-chip" [class.on]="filtro() === m.motivo"
                            [attr.aria-pressed]="filtro() === m.motivo" (click)="toggleMotivo(m.motivo)">
                      {{ etiqueta(m.motivo) }} <span class="mono">{{ lotesCon(m.motivo) | number }}</span>
                    </button>
                  }
                </div>
                <div class="cpp-md">
                  <div class="card-premium card-flat cpp-tablewrap">
                    <p-table [value]="visibles()" size="small" class="surf-table" [rowHover]="true"
                             [scrollable]="true" scrollHeight="440px"
                             [paginator]="visibles().length > 120" [rows]="120"
                             selectionMode="single" [selection]="sel()" (selectionChange)="sel.set($event)"
                             dataKey="k">
                      <ng-template #header>
                        <tr><th>Banco</th><th>Fecha</th><th class="ta-r">Movs</th><th class="ta-r">Entran</th></tr>
                      </ng-template>
                      <ng-template #body let-l>
                        <tr [pSelectableRow]="l" class="cpp-lote">
                          <td>
                            <span class="cpp-bank">{{ banco(l) }}</span>
                            @if (l.tipo === 'pago_proveedor') { <span class="cpp-sub">pago a proveedor &middot; {{ l.cfdis | number }} facturas y notas</span> }
                          </td>
                          <td class="muted mono">{{ l.fecha }}</td>
                          <td class="ta-r"><button type="button" class="cpp-cifra mono" (click)="verMovimientos({ poliza: l.k }, banco(l) + ' · ' + l.fecha)">{{ l.movimientos | number }}</button></td>
                          <td class="ta-r">
                            @if (l.incluidas > 0) {
                              <button type="button" class="cpp-cifra mono" (click)="verMovimientos({ poliza: l.k, entra: true }, banco(l) + ' · ' + l.fecha + ' · entran')">{{ l.incluidas | number }}</button>
                            } @else { <span class="mono muted">0</span> }
                          </td>
                        </tr>
                      </ng-template>
                      <ng-template #emptymessage>
                        <tr><td colspan="4" class="cpp-empty">Ninguna p&oacute;liza con ese motivo.</td></tr>
                      </ng-template>
                    </p-table>
                  </div>

                  <aside class="card-premium card-flat cpp-peek">
                    @if (sel(); as l) {
                      <h4>{{ banco(l) }}</h4>
                      <div class="cpp-sub">{{ l.fecha }}{{ l.tipo === 'pago_proveedor' ? ' · pago a proveedor' : '' }}</div>
                      <div class="cpp-kvs">
                        @if (l.tipo === 'pago_proveedor') {
                          <div class="cpp-kv"><span>Total</span><span class="mono">{{ l.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                          <div class="cpp-kv"><span>Renglones</span><span class="mono">{{ l.renglones | number }}</span></div>
                          <div class="cpp-kv"><span>Facturas y notas</span><span class="mono">{{ l.cfdis | number }}</span></div>
                          <div class="cpp-kv"><span>Qu&eacute; facturas paga lo dice</span><span>{{ fuente(l) }}</span></div>
                        } @else {
                          <div class="cpp-kv"><span>Movimientos</span><button type="button" class="cpp-cifra mono" (click)="verMovimientos({ poliza: l.k }, banco(l) + ' · ' + l.fecha)">{{ l.movimientos | number }}</button></div>
                          <div class="cpp-kv"><span>Entran a la p&oacute;liza</span>
                            @if (l.incluidas > 0) {
                              <button type="button" class="cpp-cifra mono" (click)="verMovimientos({ poliza: l.k, entra: true }, banco(l) + ' · ' + l.fecha + ' · entran')">{{ l.incluidas | number }}</button>
                            } @else { <span class="mono muted">0</span> }</div>
                          @if (l.incluidas > 0) {
                            <div class="cpp-kv"><span>Renglones</span><span class="mono">{{ l.renglones | number }}</span></div>
                            <div class="cpp-kv"><span>Total</span><span class="mono">{{ l.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                          }
                        }
                      </div>
                      @if (motivosDe(l).length) {
                        <div class="cpp-eyebrow mt">No entran</div>
                        <div class="cpp-kvs">
                          @for (m of motivosDe(l); track m.k) {
                            <div class="cpp-kv"><span [class.muted]="esDeNadie(m.k)">{{ etiqueta(m.k) }}</span><button type="button" class="cpp-cifra mono" (click)="verMovimientos({ poliza: l.k, motivo: m.k }, banco(l) + ' · ' + etiqueta(m.k))">{{ m.n | number }}</button></div>
                          }
                        </div>
                      }
                      @if (l.iva_traspaso === 'no_emitido') {
                        <p class="cpp-note">Esta p&oacute;liza cuadra pero no lleva el traspaso de IVA.</p>
                      }
                    } @else {
                      <p class="cpp-note">Elige una p&oacute;liza de la lista.</p>
                    }
                  </aside>
                </div>
              }

              @default {
                <app-load-state [loading]="true" [skeletonRows]="6" />
              }
            }

            @if (paso(); as actual) {
              <div class="cpp-nav">
                @if (anterior(); as a) {
                  <button type="button" class="cpp-btn-sec" (click)="irA(a.id)"><i class="pi pi-arrow-left" aria-hidden="true"></i> {{ a.titulo }}</button>
                }
                @if (siguiente(); as s) {
                  <button type="button" class="cpp-btn-ok cpp-nav-sig" (click)="irA(s.id)">{{ s.titulo }} <i class="pi pi-arrow-right" aria-hidden="true"></i></button>
                }
              </div>
            }
          </section>
        }
      </app-load-state>

      <!-- [CP.8.77] La cifra se recorre: «437 movs» abre los 437. -->
      <app-side-peek [open]="movsAbierto()" (openChange)="movsAbierto.set($event)" [width]="640"
                     [title]="movsTitulo()" [subtitle]="movsSubtitulo()">
        @if (catAviso(); as a) { <div class="cpp-aviso cpp-aviso-top" [class.mal]="a.mal" role="status">{{ a.texto }}</div> }
        <app-load-state [loading]="movs() === null && !movsError()" [error]="movsError()" [skeletonRows]="8"
                        errorTitle="No se pudieron leer los movimientos" (retry)="recargarMovimientos()"
                        [isEmpty]="(movs()?.filas?.length ?? 0) === 0" emptyTitle="Sin movimientos">
          @if (movs(); as m) {
            @if (m.otros_meses.length) {
              <div class="cpp-otros">También en
                @for (o of m.otros_meses; track o.mes) {
                  <button type="button" class="cpp-chip" (click)="irAMes(o.mes)">{{ o.mes }} <span class="mono">{{ o.movimientos | number }}</span></button>
                }
              </div>
            }
            <p-table [value]="m.filas" size="small" class="surf-table" dataKey="id">
              <ng-template #header>
                <tr><th>Fecha</th><th>Movimiento</th><th class="ta-r">Importe</th><th>D&oacute;nde est&aacute;</th></tr>
              </ng-template>
              <ng-template #body let-x>
                <tr>
                  <td class="mono muted">{{ x.fecha }}</td>
                  <td>
                    <span class="cpp-bank">{{ x.razon_social || x.concepto }}</span>
                    @if (x.razon_social && x.razon_social !== x.concepto) { <span class="cpp-sub">banco: {{ x.concepto }}</span> }
                    <span class="cpp-sub">{{ x.banco }}@if (x.rfc) { &middot; <span class="mono">{{ x.rfc }}</span> }</span>
                  </td>
                  <td class="ta-r mono">{{ x.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}
                    @if (x.iva !== null) { <span class="cpp-sub">+ IVA {{ x.iva | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> }</td>
                  <td>
                    @if (x.motivo === null) { <p-tag severity="success" value="Entra al archivo" /> }
                    @else { <p-tag [severity]="esDeNadie(x.motivo) || x.motivo === 'fuera_de_banco' ? 'secondary' : 'warn'" [value]="etiqueta(x.motivo)" /> }
                    @if (x.motivo === 'sin_categoria') {
                      @if (puedeCategorizar()) {
                        <button type="button" class="cpp-ir" (click)="abrirCategorizar(x)" [attr.aria-expanded]="catAbierto() === x.id">Categorizar <i class="pi pi-tag" aria-hidden="true"></i></button>
                      } @else { <span class="cpp-sub">Sin permiso para categorizar</span> }
                    } @else if (pasoDe(x.motivo); as ps) {
                      <button type="button" class="cpp-ir" (click)="irAMovimiento(x)">Ir <i class="pi pi-arrow-right" aria-hidden="true"></i></button>
                    }
                  </td>
                </tr>
                <!-- [CP.8.80] Categorizar aquí mismo; con la casilla, también los que vengan de ese beneficiario. -->
                @if (catAbierto() === x.id) {
                  <tr class="cpp-cat-fila"><td colspan="4">
                    <div class="cpp-cat" role="group" [attr.aria-label]="'Categorizar ' + (x.razon_social || x.concepto)">
                      <div class="cpp-cat-campos">
                        <p-select [options]="categorias() ?? []" optionLabel="nombre" optionValue="code" [filter]="true" filterBy="nombre"
                                  appendTo="body" placeholder="Categoría" ariaLabel="Categoría" styleClass="cpp-cat-sel"
                                  [loading]="categorias() === null" [ngModel]="catElegida()" (ngModelChange)="catElegida.set($event)" />
                        <label class="cpp-sug"><input type="checkbox" [ngModel]="catRecordar()" (ngModelChange)="cambiarRecordar($event)" /> y todos los que empiecen con</label>
                        <input type="text" class="cpp-buscar-in cpp-cat-texto" [disabled]="!catRecordar()" aria-label="Nombre del beneficiario"
                               [ngModel]="catTexto()" (ngModelChange)="escribirTexto($event)" />
                      </div>
                      @if (catRecordar()) {
                        @if (catPreviaError(); as pe) { <p class="cpp-mal cpp-cat-nota" role="alert">{{ pe }}</p> }
                        @else if (catPrevia(); as v) {
                          <p class="cpp-cat-nota">Toma <strong class="mono">{{ v.movimientos | number }}</strong> egresos sin categoría
                            (<span class="mono">{{ v.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>) de todos los meses, y los que traigan los próximos estados de cuenta.
                            @if (v.regla_existente; as re) { Ya hay una regla con ese texto: {{ re.categoria }}. }</p>
                          <ul class="cpp-lista-simple cpp-lista">
                            @for (f of v.filas.slice(0, 8); track f.id) {
                              <li><span class="mono muted">{{ f.fecha }}</span> {{ f.concepto }} <span class="mono">{{ f.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></li>
                            }
                          </ul>
                          @if (v.movimientos > 8) { <p class="cpp-sub">Se muestran 8 de {{ v.movimientos | number }}.</p> }
                        } @else { <p class="cpp-sub">Calculando qué toma…</p> }
                      }
                      <div class="cpp-acciones">
                        <button type="button" class="cpp-btn-ok" [disabled]="!puedeGuardarCategoria()" (click)="guardarCategoria(x)">
                          <i class="pi" [class.pi-check]="!catGuardando()" [class.pi-spin]="catGuardando()" [class.pi-spinner]="catGuardando()" aria-hidden="true"></i> Guardar</button>
                        <button type="button" class="cpp-btn-sec" (click)="cerrarCategorizar()">Cancelar</button>
                      </div>
                    </div>
                  </td></tr>
                }
              </ng-template>
              <ng-template #footer>
                <tr><td colspan="2">Total</td><td class="ta-r mono">{{ m.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td></td></tr>
              </ng-template>
            </p-table>
          }
        </app-load-state>
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cpp-page { --cpp-gap: 1.25rem; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .muted { color: var(--c-text-3); }
    .ta-r { text-align: right; }

    /* Q.5 · primario = la frase de arriba; secundario = el paso; terciario = las tablas del paso. */
    .cpp-verdict { padding: 1.25rem 0 1rem; }
    .cpp-verdict h2 { font-size: clamp(1.5rem, 3.6vw, 2rem); font-weight: 600; margin: 0;
      letter-spacing: -.02em; line-height: 1.15; text-wrap: balance; }
    .cpp-v-imp { color: var(--c-text-2); font-weight: 500; margin-left: .35rem; font-size: .7em; }

    .cpp-pasos ol { list-style: none; margin: 0; padding: 0; display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); }
    .cpp-paso { width: 100%; display: flex; align-items: center; gap: var(--sp-3); text-align: left;
      padding: var(--sp-3); border: 1px solid var(--c-divider); border-radius: var(--r-lg);
      background: var(--c-surface-1); color: var(--c-text-2); font: inherit; cursor: pointer;
      transition: border-color .12s var(--ease-standard, ease), background .12s var(--ease-standard, ease); }
    .cpp-paso:hover { background: var(--surface-hover); }
    .cpp-paso:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .cpp-paso.on { border-color: var(--action); background: var(--surface-selected-bg); color: var(--c-text-1, var(--text-main)); }
    .cpp-paso-n { flex: 0 0 auto; width: 1.75rem; height: 1.75rem; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--c-divider); font-weight: 600; font-size: var(--fs-sm); }
    .cpp-paso.on .cpp-paso-n { border-color: var(--action); color: var(--action); }
    .cpp-paso.hecho .cpp-paso-n { border-color: var(--ok-border); color: var(--ok-fg); }
    .cpp-paso-txt { display: flex; flex-direction: column; min-width: 0; }
    .cpp-paso-t { font-weight: 600; font-size: var(--fs-sm); }
    .cpp-paso-s { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cpp-paso.mal .cpp-paso-s { color: var(--bad-fg); }

    .cpp-cuerpo { padding-top: 1.25rem; }
    .cpp-cuerpo h3 { font-size: var(--fs-h3); font-weight: 600; margin: 0; letter-spacing: -.01em; }
    .cpp-ojo { display: flex; gap: .5rem; align-items: baseline; margin: 0 0 .8rem;
      color: var(--c-text-3); font-size: var(--fs-xs); max-width: 78ch; }
    .cpp-h4 { font-size: var(--fs-body); font-weight: 600; margin: 1.5rem 0 .25rem; }
    .cpp-sub-p { color: var(--c-text-3); font-size: var(--fs-xs); margin: 0 0 .6rem; }
    .cpp-eyebrow { font-size: var(--fs-micro); letter-spacing: .09em; text-transform: uppercase; color: var(--c-text-3); }
    .cpp-eyebrow.mt { margin-top: 1.1rem; }
    .cpp-tablewrap { overflow: hidden; }
    .cpp-bank { font-weight: 500; display: block; }
    .cpp-sub { display: block; font-size: var(--fs-xs); color: var(--c-text-3); }

    .cpp-chips { display: flex; gap: .4rem; flex-wrap: wrap; margin-bottom: .75rem; }
    .cpp-chip { border: 1px solid var(--c-divider); background: var(--c-surface-1); color: var(--c-text-2);
      border-radius: 999px; padding: 4px 11px; font: inherit; font-size: var(--fs-xs); cursor: pointer;
      transition: background .12s var(--ease-standard, ease), border-color .12s var(--ease-standard, ease); }
    .cpp-chip:hover { background: var(--surface-hover); }
    .cpp-chip.on { border-color: var(--action); color: var(--action); background: var(--surface-selected-bg); }
    .cpp-chip .mono { margin-left: .4rem; color: var(--c-text-3); }
    .cpp-chip.on .mono { color: var(--action); }

    .cpp-md { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--cpp-gap);
      align-items: start; }
    .cpp-lote { cursor: pointer; }
    .cpp-peek { padding: 1.1rem; }
    .cpp-peek h4 { margin: 0 0 .1rem; font-size: var(--fs-h3); font-weight: 600; }
    .cpp-kvs { margin-top: .6rem; }
    .cpp-kv { display: flex; justify-content: space-between; gap: .75rem; padding: .5rem 0;
      border-bottom: 1px solid var(--c-divider); font-size: var(--fs-sm); }
    .cpp-kv:last-child { border-bottom: 0; }
    .cpp-kv > span:first-child { color: var(--c-text-2); min-width: 0; }
    .cpp-kv > span:last-child { text-align: right; }
    .cpp-kv-total { font-weight: 600; }
    .cpp-note { margin: .85rem 0 0; font-size: var(--fs-xs); color: var(--c-text-3); }
    .cpp-empty { padding: 1.5rem; text-align: center; color: var(--c-text-3); font-size: var(--fs-sm); }

    .cpp-entrega { display: flex; gap: .6rem; flex-wrap: wrap; margin: 1rem 0 .75rem; }
    .cpp-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

    /* [CP.8.77] La cuenta y su botón van juntos (Fitts: Firmar ya no queda al otro lado de la fila). */
    .cpp-cta { min-width: 24rem; }
    .cpp-firma { display: flex; align-items: center; gap: .5rem; }
    .cpp-sel-cta { width: 20rem; max-width: 100%; }
    /* La pista es una sugerencia, no una alerta: tono apagado, con el nombre de la cuenta. */
    .cpp-pista { display: inline-flex; align-items: center; gap: .35rem; margin-top: .3rem; padding: 0; border: 0;
      background: transparent; color: var(--c-text-3); font: inherit; font-size: var(--fs-xs); cursor: pointer; }
    .cpp-pista:hover { color: var(--c-text-2); text-decoration: underline; }
    .cpp-pista:focus-visible, .cpp-cifra:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    /* La cifra se recorre: se lee como número y se comporta como enlace. */
    .cpp-cifra { border: 0; background: transparent; padding: 0; font: inherit; color: var(--c-text-1, var(--text-main));
      cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
    .cpp-cifra:hover { color: var(--action); text-decoration-style: solid; }
    .cpp-cifra.muted { color: var(--c-text-3); }
    /* [CP.8.78] El buscador y lo que lo rodea. */
    .cpp-buscar { position: relative; display: inline-flex; align-items: center; }
    .cpp-buscar .pi { position: absolute; left: .6rem; color: var(--c-text-3); font-size: var(--fs-xs); pointer-events: none; }
    .cpp-buscar-in { width: 18rem; max-width: 60vw; padding: 6px 10px 6px 1.9rem; border: 1px solid var(--c-divider);
      border-radius: var(--radius-sm); background: var(--c-surface-1); color: var(--c-text-1, var(--text-main));
      font: inherit; font-size: var(--fs-sm); }
    .cpp-buscar-in:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .cpp-solo { display: flex; align-items: center; gap: .75rem; margin-bottom: .6rem; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cpp-otros { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-bottom: .75rem; font-size: var(--fs-xs); color: var(--c-text-3); }
    .cpp-ir { display: inline-flex; align-items: center; gap: .3rem; margin-left: .5rem; border: 0; background: transparent;
      padding: 0; color: var(--action); font: inherit; font-size: var(--fs-xs); cursor: pointer; text-decoration: none; }
    .cpp-ir:hover { text-decoration: underline; }
    .cpp-ir:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .cpp-link { border: 0; background: transparent; color: var(--action); padding: 2px 0; font: inherit;
      font-size: var(--fs-xs); cursor: pointer; text-decoration: underline; }
    .cpp-link.mt { margin-top: .5rem; }
    .cpp-mas { margin-top: 1rem; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cpp-mas summary { cursor: pointer; color: var(--c-text-2); }
    .cpp-lista-simple { margin: .5rem 0 0; padding-left: 1.1rem; font-size: var(--fs-xs); }
    .cpp-lista-simple li { padding: 2px 0; }

    .cpp-sug { display: flex; align-items: center; gap: .5rem; padding: 3px 0; cursor: pointer;
      font-size: var(--fs-sm); flex-wrap: wrap; }
    .cpp-sug input { accent-color: var(--action); flex: 0 0 auto; }
    .cpp-lista { max-height: 16rem; overflow: auto; padding-right: .25rem; }
    .cpp-mal { color: var(--bad-fg); font-weight: 600; }
    .cpp-acciones { display: flex; align-items: center; gap: .6rem; margin-top: .75rem; }
    /* Von Restorff: la destructiva lejos de la diaria. */
    .cpp-lejos { margin-left: auto; }
    .cpp-btn-ok.mt { margin-top: .75rem; }

    .cpp-btn-ok { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--action);
      background: transparent; color: var(--action); border-radius: var(--radius-sm); padding: 5px 12px;
      font: inherit; font-size: var(--fs-sm); cursor: pointer; white-space: nowrap; }
    .cpp-btn-ok:hover:not(:disabled) { background: var(--surface-selected-bg); }
    .cpp-btn-ok:disabled { border-color: var(--c-divider); color: var(--c-text-3); cursor: default; }
    .cpp-btn-sec { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--c-divider);
      background: transparent; color: var(--c-text-2); border-radius: var(--radius-sm); padding: 5px 12px;
      font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cpp-btn-sec:hover { background: var(--surface-hover); }
    .cpp-btn-bad { border: 1px solid var(--bad-border); background: transparent; color: var(--bad-fg);
      border-radius: var(--radius-sm); padding: 4px 12px; font: inherit; font-size: var(--fs-xs);
      cursor: pointer; white-space: nowrap; }
    .cpp-btn-bad:disabled { color: var(--c-text-3); border-color: var(--c-divider); cursor: default; }
    .cpp-nav { display: flex; gap: .6rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--c-divider); }
    .cpp-nav-sig { margin-left: auto; }

    .cpp-aviso { margin-top: .75rem; padding: .6rem .8rem; border-radius: var(--radius-md);
      font-size: var(--fs-sm); border: 1px solid var(--ok-border); background: var(--ok-soft-bg);
      color: var(--ok-soft-fg); }
    .cpp-aviso.mal { border-color: var(--bad-border); background: var(--bad-soft-bg);
      color: var(--bad-soft-fg); }
    .cpp-aviso-top { margin: 0 0 .75rem; }

    /* [CP.8.80] El formulario en línea bajo el movimiento. */
    .cpp-cat-fila > td { background: var(--surface-hover); }
    .cpp-cat { padding: .5rem 0; }
    .cpp-cat-campos { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .cpp-cat-campos .cpp-sug { padding: 0; }
    .cpp-cat-texto { padding-left: 10px; width: 16rem; }
    .cpp-cat-texto:disabled { color: var(--c-text-3); }
    .cpp-cat-nota { margin: .6rem 0 .25rem; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cpp-cat .cpp-lista { max-height: 10rem; }

    @media (max-width: 56.25rem) {
      .cpp-md { grid-template-columns: 1fr; }
      .cpp-pasos ol { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (prefers-reduced-motion: reduce) { .cpp-chip, .cpp-paso { transition: none; } }
  `],
})
export class ContabilidadContpaqiPuenteComponent implements OnInit {
  private readonly api = inject(ContpaqiPuenteService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly data = signal<LotesResp | null>(null);
  readonly cuadre = signal<CuadreResp | null>(null);
  readonly filtro = signal<string | null>(null);
  readonly sel = signal<LoteVista | null>(null);
  readonly mes = signal<string>(mesCerrado());
  // ⛔ Se llamaba `pendientes` y COLISIONABA con el `computed` del mismo nombre que ya vivía
  // más abajo (el de `[CP.8.33]`, que cuenta movimientos). Dos miembros con el mismo nombre en
  // una clase: `TS2300` + `TS2717`, y el `| number` del template recibiendo un objeto (`TS2769`).
  // Ninguna de las dos ramas podía verlo sola — se tocaron al integrarlas. El nombre sale de
  // su propio título en pantalla: «Proveedores por confirmar».
  readonly porConfirmar = signal<PendientesResp | null>(null);
  /** alias → cuenta elegida en la pantalla. ⛔ Nada se preselecciona: elegir es del humano. */
  readonly elegido = signal<Record<string, string>>({});
  readonly guardando = signal<string | null>(null);
  readonly bajando = signal(false);
  readonly avisoArchivo = signal<{ texto: string; mal: boolean } | null>(null);
  readonly entregando = signal(false);
  readonly avisoEntrega = signal<{ texto: string; mal: boolean } | null>(null);
  /** El plazo del motor, del backend: repetir la constante acá la dejaría divergir. */
  readonly plazoDias = computed(() => this.cuadre()?.plazo_dias ?? 5);

  // ── [CP.8.14] reglas de cuenta ──
  readonly reglas = signal<ReglaVista[] | null>(null);
  readonly reglasError = signal<string | null>(null);
  readonly cuentas = signal<{ codigo: string; etiqueta: string }[]>([]);
  /** categoría → cuenta elegida. ⛔ Nada se preselecciona: el indicio sólo llena si se pide. */
  readonly cuentaElegida = signal<Record<string, string>>({});
  readonly firmando = signal<string | null>(null);
  readonly avisoRegla = signal<{ texto: string; mal: boolean } | null>(null);
  readonly firmables = computed(() => (this.reglas() ?? []).filter((r) => r.firmable));
  readonly noFirmables = computed(() => (this.reglas() ?? []).filter((r) => !r.firmable));
  /** Lo que destrabaría firmar lo pendiente de la lista. Techo: otro motivo puede dejarlos fuera. */
  readonly porFirmar = computed(() => {
    const p = this.firmables().filter((r) => r.estado !== 'aprobada' && r.movimientos_mes > 0);
    return {
      reglas: p.length,
      n: p.reduce((a, r) => a + r.movimientos_mes, 0),
      imp: p.reduce((a, r) => a + Number(r.importe_mes), 0),
    };
  });
  readonly avisoAlias = signal<{ texto: string; mal: boolean } | null>(null);
  /**
   * Confirmar exige `_GESTIONAR`; mirar el pendiente sólo `_VER`.
   *
   * ⚠️ Esto esconde el botón, **no** protege nada: quien manda es el guard del endpoint. Un
   * permiso del lado del navegador es una cortesía, no una puerta.
   */
  readonly puedeGestionar = signal<boolean>(
    this.auth.user()?.permissions?.[Permission.FISCAL_CONTPAQI_BRIDGE_GESTIONAR] === true,
  );

  /** Los 12 meses cerrados hacia atrás. El mes en curso NO entra: siempre se ve incompleto. */
  readonly mesOpts = mesesAtras(12);

  /** El resumen del paso 4: qué trae el archivo y qué se queda afuera. */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Pólizas listas', value: d.resumen.con_asiento, format: 'number', state: 'medido',
        tone: d.resumen.con_asiento === 0 ? 'muted' : 'ok', sub: 'van en el archivo' },
      { label: 'Importe', value: this.importeListo(), format: 'currency', state: 'medido', sub: 'de esas pólizas' },
      // `[CP.8.78]` Todo conteo de movimientos se abre (`drill` de MetricStrip, `[LC.21]`).
      { label: 'Movimientos que entran', value: d.resumen.incluidas, format: 'number', state: 'medido',
        sub: 'van en esas pólizas', drill: 'entran', drillLabel: 'Ver los movimientos que entran al archivo' },
      { label: 'Esperan un paso', value: this.pendientes(), format: 'number', state: 'medido',
        tone: this.pendientes() > 0 ? 'warn' : 'muted', sub: 'de alguien', drill: 'espera', drillLabel: 'Ver los movimientos que esperan un paso' },
      { label: 'No generan póliza', value: this.deNadie(), format: 'number', state: 'medido', tone: 'muted',
        sub: 'ya decidido', drill: 'no_aplica', drillLabel: 'Ver los movimientos que no generan póliza' },
    ];
  });

  // ── `[CP.8.76]` Los cuatro pasos ──────────────────────────────────────────────────────────
  /** Cuándo cargó la pantalla. ⚠️ Es la hora del navegador (`measures="fetch"`), no la edad del dato. */
  readonly cargadoEn = signal<Date | null>(null);
  readonly proveedoresError = signal<string | null>(null);
  /** El paso que eligió la persona. `null` = el primero que tiene trabajo. */
  readonly pasoElegido = signal<Paso | null>(null);
  readonly todasLasReglas = signal(false);

  readonly importeListo = computed(() =>
    (this.data()?.lotes ?? []).filter((l) => l.incluidas > 0).reduce((a, l) => a + Number(l.total), 0));

  readonly pagosPendientes = computed(() => {
    const p = this.pagos();
    return p ? p.filter((x) => !x.confirmacion?.vigente).length : null;
  });

  readonly pasos = computed<PasoVista[]>(() => armarPasos({
    reglas: this.reglas() ? this.porFirmar().reglas : null, reglasError: !!this.reglasError(),
    proveedores: this.porConfirmar()?.filas.length ?? null, proveedoresError: !!this.proveedoresError(),
    pagos: this.pagosPendientes(), pagosError: !!this.pagosError(),
    polizas: this.data()?.resumen.con_asiento ?? 0,
  }));

  readonly paso = computed<Paso | null>(() => this.pasoElegido() ?? primerPasoConTrabajo(this.pasos()));
  readonly anterior = computed(() => vecino(this.pasos(), this.paso(), -1));
  readonly siguiente = computed(() => vecino(this.pasos(), this.paso(), +1));
  readonly queFalta = computed(() => fraseQueFalta(this.pasos()));

  /** Las reglas de este mes (con movimientos o ya firmadas); las demás, a un clic y contadas. */
  readonly reglasVisibles = computed(() => {
    const sc = this.soloCategoria();
    if (sc) return this.firmables().filter((r) => r.categoria_code === sc);
    return this.todasLasReglas()
      ? this.firmables() : this.firmables().filter((r) => r.movimientos_mes > 0 || r.estado === 'aprobada');
  });

  // ── `[CP.8.78]` El buscador y «Ir»: llegar a la fila donde se resuelve ────────────────────
  /** Al llegar desde el buscador: el paso muestra sólo esa fila, con «Ver todos» al lado. */
  readonly soloCategoria = signal<string | null>(null);
  readonly soloNombre = signal<string | null>(null);
  readonly provVisibles = computed(() => {
    const filas = this.porConfirmar()?.filas ?? [];
    const sn = this.soloNombre();
    return sn ? filas.filter((f) => f.alias_normalizado === sn) : filas;
  });
  readonly busqueda = signal('');
  private esperaBusqueda: ReturnType<typeof setTimeout> | null = null;

  /** Busca al dejar de escribir (450 ms) o con Enter. Menos de 2 letras no busca: traería todo. */
  escribirBusqueda(v: string): void {
    this.busqueda.set(v ?? '');
    if (this.esperaBusqueda) clearTimeout(this.esperaBusqueda);
    this.esperaBusqueda = setTimeout(() => this.buscarYa(), 450);
  }

  buscarYa(): void {
    if (this.esperaBusqueda) { clearTimeout(this.esperaBusqueda); this.esperaBusqueda = null; }
    const q = this.busqueda().trim();
    if (q.replace(/\s/g, '').length < 2) return;
    this.verMovimientos({ q }, `«${q}»`);
  }

  /** Otro mes desde «También en»: cambia el mes de la pantalla y repite la misma búsqueda. */
  irAMes(mes: string): void {
    const filtro = this.movsFiltro;
    const titulo = this.movsTitulo();
    this.setMes(mes);
    this.verMovimientos(filtro, titulo);
  }

  pasoDe(motivo: string | null): Paso | null { return pasoDeMotivo(motivo); }

  /** Las tarjetas de la tira del paso 4 abren sus movimientos. */
  abrirKpi(llave: string): void {
    if (llave === 'entran') this.verMovimientos({ entra: true }, 'Entran al archivo');
    else if (llave === 'espera') this.verMovimientos({ espera: true }, 'Esperan un paso');
    else if (llave === 'no_aplica') this.verMovimientos({ motivo: 'no_aplica' }, 'No generan póliza');
  }

  nombreDeCategoria(code: string): string {
    const r = (this.reglas() ?? []).find((x) => x.categoria_code === code);
    return r ? this.nombreRegla(r) : code;
  }

  /** Lleva al paso donde se resuelve ese movimiento, con su fila a la vista. */
  irAMovimiento(m: MovimientoBanco): void {
    const p = pasoDeMotivo(m.motivo);
    if (!p) return;
    this.movsAbierto.set(false);
    this.soloCategoria.set(p === 'reglas' ? m.categoria : null);
    this.soloNombre.set(p === 'proveedores' ? m.nombre : null);
    if (p === 'pagos') this.elegirPago((this.pagos() ?? []).find((x) => x.movimiento_id === m.id) ?? null);
    if (p === 'archivo') {
      this.filtro.set(null);
      this.sel.set(this.visibles().find((l) => l.k === m.poliza) ?? this.sel());
    }
    this.irA(p);
  }
  readonly reglasOcultas = computed(() =>
    this.firmables().filter((r) => !(r.movimientos_mes > 0 || r.estado === 'aprobada')).length);

  readonly motivosConTrabajo = computed(() => this.data()?.motivos ?? []);
  readonly cuentasFuera = computed(() => (this.data()?.fuera_de_lote.cuentas ?? []).map((c) => c.cuenta).join(' y '));

  irA(p: Paso): void { this.pasoElegido.set(p); }

  porQueNoSeFirma(r: ReglaVista): string { return motivoNoFirmable(r.tipo_regla); }

  /** El dueño viene como «quién — qué hace»; en la tabla basta el quién. */
  duenoCorto(d: string): string { return d.split(' — ')[0]; }

  readonly visibles = computed<LoteVista[]>(() => {
    const d = this.data();
    if (!d) return [];
    const f = this.filtro();
    const rows = f ? d.lotes.filter((l) => (l.motivos?.[f] ?? 0) > 0) : d.lotes;
    return [...rows]
      .sort((a, b) => b.movimientos - a.movimientos || a.fecha.localeCompare(b.fecha))
      // `dataKey` de PrimeNG necesita UN campo, y la llave del lote son dos (banco y día).
      // `[CP.8.72]` La clave viene del servidor: un pago a proveedor y el lote de su día comparten banco y fecha.
      .map((l) => ({ ...l, k: l.clave ?? `${l.cuenta_banco}|${l.fecha}` }));
  });

  readonly deNadie = computed(() => contarDeNadie(this.data()?.motivos ?? []));

  /**
   * ⛔ Resta TAMBIÉN las incluidas. Mientras el puente rechazaba todo, `movimientos − no_aplica`
   * daba lo mismo; desde `[CP.8.35]` entran 144 al asiento y esa cuenta **sobredeclara el trabajo
   * pendiente**, que es justo el número que alguien mira para estimar cuánto falta.
   */
  readonly pendientes = computed(() => {
    const r = this.data()?.resumen;
    if (!r) return 0;
    return Math.max(0, r.movimientos - this.deNadie() - r.incluidas);
  });

  // ── `[CP.8.73]` Pagos a proveedor por confirmar ────────────────────────────────────────────
  readonly pagos = signal<PagoPorConfirmar[] | null>(null);
  readonly pagosError = signal<string | null>(null);
  readonly pagoSel = signal<PagoPorConfirmar | null>(null);
  readonly marcadasF = signal<ReadonlySet<string>>(new Set());
  readonly marcadasN = signal<ReadonlySet<string>>(new Set());
  readonly confirmandoPago = signal(false);
  readonly avisoPago = signal<{ texto: string; mal: boolean } | null>(null);
  /** Las facturas del pago elegido: lo sugerido primero, después las más recientes. */
  readonly candidatas = computed(() => {
    const p = this.pagoSel()?.propuesta;
    return p ? ordenarCandidatas(p.facturas, p.sugerencia) : [];
  });
  readonly cuadrePago = computed(() => {
    const p = this.pagoSel()?.propuesta;
    return p ? cuadreDePago(p.facturas, p.notas, this.marcadasF(), this.marcadasN(), p.pagado) : null;
  });

  cargarPagos(): void {
    this.pagosError.set(null);
    this.api.pagosPorConfirmar(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.pagos.set(r.pagos);
        const id = this.pagoSel()?.movimiento_id;
        this.elegirPago(r.pagos.find((x) => x.movimiento_id === id) ?? r.pagos[0] ?? null);
      },
      error: (e) => { this.pagos.set(null); this.pagosError.set(e?.error?.message ?? 'no se pudo leer los pagos por confirmar'); },
    });
  }

  /** ⛔ Al elegir un pago NO se marca la sugerencia: sólo lo ya confirmado vuelve marcado. */
  elegirPago(p: PagoPorConfirmar | null): void {
    this.pagoSel.set(p);
    this.avisoPago.set(null);
    const c = p?.confirmacion;
    this.marcadasF.set(new Set(c?.facturas ?? []));
    this.marcadasN.set(new Set(c?.notas ?? []));
  }

  usarSugerencia(): void {
    const s = this.pagoSel()?.propuesta?.sugerencia ?? [];
    this.marcadasF.set(new Set(s));
  }

  alternar(tipo: 'f' | 'n', uuid: string): void {
    const sig = tipo === 'f' ? this.marcadasF : this.marcadasN;
    const s = new Set(sig()); if (s.has(uuid)) s.delete(uuid); else s.add(uuid);
    sig.set(s);
  }

  confirmarPago(): void {
    const p = this.pagoSel(); const c = this.cuadrePago();
    if (!p || !c?.cuadra || this.confirmandoPago()) return;
    this.confirmandoPago.set(true);
    this.api.confirmarPago(p.movimiento_id, [...this.marcadasF()], [...this.marcadasN()])
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.confirmandoPago.set(false);
          this.avisoPago.set({ texto: `Confirmado: la póliza sale con ${r.renglones} renglones por ${r.total.toFixed(2)}.`, mal: false });
          this.cargar(true);
        },
        error: (e) => {
          this.confirmandoPago.set(false);
          this.avisoPago.set({ texto: e?.error?.message ?? 'no se pudo confirmar', mal: true });
        },
      });
  }

  desconfirmarPago(): void {
    const p = this.pagoSel();
    if (!p?.confirmacion || this.confirmandoPago()) return;
    this.confirmandoPago.set(true);
    this.api.desconfirmarPago(p.movimiento_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.confirmandoPago.set(false); this.avisoPago.set({ texto: 'Confirmación quitada.', mal: false }); this.cargar(true); },
      error: (e) => { this.confirmandoPago.set(false); this.avisoPago.set({ texto: e?.error?.message ?? 'no se pudo quitar', mal: true }); },
    });
  }

  ngOnInit(): void { this.cargar(); }

  /**
   * `silencioso` = recargar después de firmar o confirmar SIN volver al esqueleto: la persona se
   * queda en su paso y en su fila, y los números se actualizan debajo.
   */
  cargar(silencioso = false): void {
    if (!silencioso) {
      this.loading.set(true);
      this.reglas.set(null);
      this.porConfirmar.set(null);
      this.pagos.set(null);
    }
    this.error.set(null);
    this.cargarPagos();   // [CP.8.73] mismo mes, mismo momento
    this.api.lotes(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        this.cargadoEn.set(new Date());
        // Completa al llegar: el primer lote ya seleccionado, no un panel en blanco.
        const k = this.sel()?.k ?? null;
        this.sel.set(this.visibles().find((l) => l.k === k) ?? this.visibles()[0] ?? null);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? e?.message ?? 'Error de red');
        this.loading.set(false);
      },
    });
    // ⚠️ El cuadre va aparte a propósito: si falla, la bandeja igual sirve. Lo que no puede
    // pasar es que se pinte un 0 % inventado, así que ante error queda en `null` y no se dibuja.
    this.api.cuadre().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.cuadre.set(c), error: () => this.cuadre.set(null) });

    // `[CP.8.76]` ⛔ Antes el error se tragaba (`null` y la sección desaparecía): se leía como «no hay
    // proveedores por confirmar», que es justo lo contrario. Ahora el paso dice «no se pudo leer».
    this.proveedoresError.set(null);
    this.api.pendientes(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => this.porConfirmar.set(p),
      error: (e) => { this.porConfirmar.set(null); this.proveedoresError.set(e?.error?.message ?? 'error de red'); },
    });

    // [CP.8.14] ⚠️ Aquí el error SÍ se dibuja: una sección de firmas que desaparece se lee como
    // «no hay nada que firmar», y es justo lo contrario.
    this.reglasError.set(null);
    this.api.reglas(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.reglas.set(r.reglas),
      error: (e) => { this.reglas.set(null); this.reglasError.set(e?.error?.message ?? 'error de red'); },
    });
    if (!this.cuentas().length && this.puedeGestionar()) {
      this.api.cuentasGasto().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (c) => this.cuentas.set(c.cuentas.map((x) => ({ codigo: x.codigo, etiqueta: `${x.codigo} ${x.nombre}` }))),
        error: () => this.cuentas.set([]),
      });
    }
  }

  /** El nombre legible es la primera frase de la evidencia medida («Comisión bancaria.»). */
  nombreRegla(r: ReglaVista): string {
    return nombreDeRegla(r);
  }

  /**
   * `[CP.8.77]` La pista con el NOMBRE de la cuenta, no sólo su código: «5200600000» no le dice nada a quien firma.
   * Sólo si la cuenta está en el catálogo firmable (si no, el backend la rechazaría).
   */
  pistaDe(r: ReglaVista): { codigo: string; etiqueta: string } | null {
    const c = codigoDeIndicio(r.indicio, this.cuentas());
    return c ? this.cuentas().find((x) => x.codigo === c) ?? null : null;
  }

  // ── `[CP.8.77]` Los movimientos detrás de una cifra ──────────────────────────────────────
  readonly movsAbierto = signal(false);
  readonly movs = signal<MovimientosResp | null>(null);
  readonly movsError = signal<string | null>(null);
  readonly movsTitulo = signal('');
  private movsFiltro: FiltroMovimientos = {};
  readonly movsSubtitulo = computed(() => {
    const m = this.movs();
    if (!m) return this.mes();
    const n = m.filas.length;
    return `${n.toLocaleString('es-MX')} ${n === 1 ? 'movimiento' : 'movimientos'} · ${this.mes()}`;
  });

  verMovimientos(filtro: FiltroMovimientos, titulo: string): void {
    this.cerrarCategorizar();
    this.catAviso.set(null);
    this.movsFiltro = filtro;
    this.movsTitulo.set(titulo);
    this.movsAbierto.set(true);
    this.recargarMovimientos();
  }

  recargarMovimientos(): void {
    this.movs.set(null);
    this.movsError.set(null);
    this.api.movimientos(this.mes(), this.movsFiltro).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.movs.set(r),
      error: (e) => this.movsError.set(e?.error?.message ?? 'error de red'),
    });
  }

  // ── `[CP.8.80]` Categorizar aquí mismo, y recordarlo por beneficiario ──────────────────────────
  // Antes: «Categorizar en Bancos» abría Bancos sin filtro, y Bancos es de sólo lectura (`[CB.14]`).
  private readonly perms = inject(PermissionsService);
  /** ⚠️ Cortesía, no puerta: manda el guard del endpoint (`_CATEGORIZAR`). Los roles de plataforma pasan. */
  readonly puedeCategorizar = this.perms.has$(Permission.FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR);
  readonly categorias = signal<CategoriaEgreso[] | null>(null);
  readonly catAbierto = signal<string | null>(null);
  readonly catElegida = signal('');
  readonly catRecordar = signal(true);
  readonly catTexto = signal('');
  readonly catPrevia = signal<VistaPreviaBeneficiario | null>(null);
  readonly catPreviaError = signal<string | null>(null);
  readonly catGuardando = signal(false);
  readonly catAviso = signal<{ texto: string; mal: boolean } | null>(null);
  private esperaPrevia: ReturnType<typeof setTimeout> | null = null;
  /** Sólo cuenta la última vista previa pedida: una lenta que llega tarde no pisa a la nueva. */
  private previaPedida = 0;

  /** ⛔ Con la casilla, no se guarda sin haber visto qué toma la regla. */
  readonly puedeGuardarCategoria = computed(() => {
    const elegida = this.catElegida(), guardando = this.catGuardando(), recordar = this.catRecordar();
    const previa = this.catPrevia(), error = this.catPreviaError();
    return !!elegida && !guardando && (!recordar || (!!previa && !error));
  });

  abrirCategorizar(m: MovimientoBanco): void {
    if (this.catAbierto() === m.id) { this.cerrarCategorizar(); return; }
    this.cerrarCategorizar();
    this.catAbierto.set(m.id);
    this.catElegida.set('');
    this.catRecordar.set(true);
    this.catAviso.set(null);
    this.catTexto.set(sugerenciaBeneficiario(m.concepto));
    if (this.categorias() === null) {
      this.api.categoriasEgreso().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (c) => this.categorias.set(c),
        error: (e) => {
          this.categorias.set([]);
          this.catAviso.set({ mal: true, texto: `No se pudieron leer las categorías: ${e?.error?.message ?? 'error de red'}` });
        },
      });
    }
    this.pedirPrevia();
  }

  cerrarCategorizar(): void {
    if (this.esperaPrevia) { clearTimeout(this.esperaPrevia); this.esperaPrevia = null; }
    this.previaPedida += 1;
    this.catAbierto.set(null);
    this.catPrevia.set(null);
    this.catPreviaError.set(null);
  }

  cambiarRecordar(v: boolean): void {
    this.catRecordar.set(!!v);
    if (v) this.pedirPrevia();
  }

  escribirTexto(v: string): void {
    this.catTexto.set(v ?? '');
    this.catPrevia.set(null);
    this.catPreviaError.set(null);
    if (this.esperaPrevia) clearTimeout(this.esperaPrevia);
    this.esperaPrevia = setTimeout(() => this.pedirPrevia(), 400);
  }

  private pedirPrevia(): void {
    const id = this.catAbierto();
    if (!id || !this.catRecordar()) return;
    const n = ++this.previaPedida;
    this.catPrevia.set(null);
    this.catPreviaError.set(null);
    this.api.vistaPreviaBeneficiario(id, this.catTexto()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => { if (n === this.previaPedida) this.catPrevia.set(v); },
      error: (e) => { if (n === this.previaPedida) this.catPreviaError.set(e?.error?.message ?? 'No se pudo calcular qué toma la regla.'); },
    });
  }

  /** ⭐ Al guardar se recarga la lista y la bandeja: la categoría cambia qué entra al archivo. */
  guardarCategoria(m: MovimientoBanco): void {
    if (!this.puedeGuardarCategoria()) return;
    this.catGuardando.set(true);   // idempotencia visual: el segundo clic ya no pasa
    const categoria = this.catElegida();
    const body = this.catRecordar() ? { categoria, beneficiario: this.catTexto() } : { categoria };
    this.api.categorizar(m.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.catGuardando.set(false);
        const nombre = this.categorias()?.find((c) => c.code === r.categoria)?.nombre ?? r.categoria;
        const imp = r.importe_aplicado.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
        this.cerrarCategorizar();
        this.catAviso.set({ mal: false, texto: r.regla
          ? `Categorizado como ${nombre}. Con «${r.regla.texto}» se categorizaron ${r.aplicados} más (${imp}), y se aplicará a los próximos estados de cuenta.`
          : `Categorizado como ${nombre}.` });
        this.recargarMovimientos();
        this.cargar(true);
      },
      error: (e) => {
        this.catGuardando.set(false);
        this.catAviso.set({ mal: true, texto: e?.error?.message ?? 'No se pudo categorizar.' });
      },
    });
  }

  elegirCuenta(categoria: string, cuenta: string | null): void {
    this.cuentaElegida.update((m) => {
      const n = { ...m };
      if (cuenta) n[categoria] = cuenta; else delete n[categoria];
      return n;
    });
  }

  /** ⭐ Al firmar se recarga la bandeja entera: la firma cambia qué movimientos entran al asiento. */
  firmar(r: ReglaVista): void {
    const cuenta = this.cuentaElegida()[r.categoria_code];
    if (!cuenta || this.firmando()) return;
    this.firmando.set(r.categoria_code);
    this.avisoRegla.set(null);
    this.api.firmarRegla(r.categoria_code, cuenta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => {
        this.firmando.set(null);
        this.elegirCuenta(r.categoria_code, null);
        this.avisoRegla.set({
          texto: `${this.nombreRegla(r)} quedó firmada a ${v.cuenta_gasto} ${v.cuenta_nombre ?? ''}. `
            + 'Sus movimientos ya entran al armado; lo ya entregado no se vuelve a mandar.',
          mal: false,
        });
        this.cargar(true);
      },
      error: (e) => {
        this.firmando.set(null);
        this.avisoRegla.set({ texto: e?.error?.message ?? 'No se pudo firmar', mal: true });
      },
    });
  }

  revocar(r: ReglaVista): void {
    if (this.firmando()) return;
    this.firmando.set(r.categoria_code);
    this.avisoRegla.set(null);
    this.api.revocarRegla(r.categoria_code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.firmando.set(null);
        this.avisoRegla.set({
          texto: `${this.nombreRegla(r)} quedó sin firmar: sus movimientos dejan de armarse. `
            + 'Lo que ya se entregó a ContPAQi no se toca.',
          mal: false,
        });
        this.cargar(true);
      },
      error: (e) => {
        this.firmando.set(null);
        this.avisoRegla.set({ texto: e?.error?.message ?? 'No se pudo revocar', mal: true });
      },
    });
  }

  /**
   * `[CP.8.38]` Baja el TXT del mes.
   *
   * ⚠️ El navegador no puede leer el archivo y decidir: si el backend rechaza, llega un JSON de
   * error con `Content-Type` distinto. Por eso se pide como `blob` y se mira el tipo antes de
   * ofrecerlo — guardar un JSON de error con nombre `.txt` y que alguien lo importe a ContPAQi
   * es un modo de falla real.
   */
  descargar(): void {
    this.bajando.set(true);
    this.avisoArchivo.set(null);
    this.api.archivo(this.mes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.bajando.set(false);
        if (!blob || blob.type.includes('json')) {
          this.avisoArchivo.set({ texto: 'El servidor no devolvió un archivo de póliza.', mal: true });
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `egresos-banco-${this.mes()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        this.avisoArchivo.set({
          texto: `Archivo de ${this.mes()} generado. NO quedó marcado como entregado.`, mal: false,
        });
      },
      error: (e) => {
        this.bajando.set(false);
        this.avisoArchivo.set({ texto: e?.error?.message ?? 'No se pudo generar', mal: true });
      },
    });
  }

  /**
   * `[CP.8.54]` Marca entregado el archivo que se cargó en ContPAQi.
   *
   * ⭐ Se deshabilita en el primer clic, antes de leer el archivo: el doble clic no manda dos
   * veces (y aunque mandara, el backend no duplica). Los bytes viajan tal cual en base64 — el
   * archivo es latin1 de ancho fijo y cualquier decodificación a texto podría cambiarlo.
   */
  async marcarEntregado(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.entregando()) return;
    this.entregando.set(true);
    this.avisoEntrega.set(null);
    let b64: string;
    try {
      b64 = aBase64(new Uint8Array(await file.arrayBuffer()));
    } catch {
      this.entregando.set(false);
      this.avisoEntrega.set({ texto: 'No se pudo leer el archivo elegido.', mal: true });
      return;
    }
    const mes = this.mes();
    this.api.entregar(mes, b64).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.entregando.set(false);
        const ya = r.ya_registradas ? ` (${r.ya_registradas} ya estaban registradas)` : '';
        this.avisoEntrega.set({
          texto: `${r.nuevas} pólizas de ${r.mes} quedaron como entregadas${ya}. `
            + `La Suite las buscará en ContPAQi; las que no aparezcan en ${this.plazoDias()} días se avisan aquí.`,
          mal: false,
        });
        this.api.cuadre().pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({ next: (c) => this.cuadre.set(c), error: () => this.cuadre.set(null) });
      },
      error: (e) => {
        this.entregando.set(false);
        this.avisoEntrega.set({ texto: e?.error?.message ?? 'No se pudo marcar como entregado', mal: true });
      },
    });
  }

  elegir(alias: string, cuenta: string): void {
    this.elegido.update((m) => ({ ...m, [alias]: cuenta }));
  }

  /**
   * ⭐ Al confirmar se recarga la bandeja entera, no sólo la lista: el alias cambia **cuántos
   * movimientos entran al asiento**, y dejar los lotes con el número viejo sería mostrar un
   * resultado que ya no es cierto.
   */
  confirmar(f: PendienteProveedor): void {
    const cuenta = this.elegido()[f.alias_normalizado];
    if (!cuenta) return;
    this.guardando.set(f.alias_normalizado);
    this.avisoAlias.set(null);
    this.api.confirmarAlias({ concepto_banco: f.concepto_banco, cuenta, rubro: f.rubro })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardando.set(null);
          this.avisoAlias.set({ texto: `"${f.concepto_banco}" queda en ${cuenta}.`, mal: false });
          this.cargar(true);
        },
        error: (e) => {
          this.guardando.set(null);
          // El backend manda el motivo exacto (cuenta inexistente, rubro equivocado): se muestra
          // tal cual, porque es lo que hace falta leer para corregir.
          this.avisoAlias.set({ texto: e?.error?.message ?? 'No se pudo guardar', mal: true });
        },
      });
  }

  setMes(m: string): void {
    this.mes.set(m); this.filtro.set(null); this.sel.set(null); this.pasoElegido.set(null);
    this.soloCategoria.set(null); this.soloNombre.set(null); this.cargar();
  }

  toggleMotivo(motivo: string | null): void {
    this.filtro.set(motivo !== null && this.filtro() === motivo ? null : motivo);
    this.sel.set(this.visibles()[0] ?? null);
  }

  lotesCon(motivo: string): number {
    return (this.data()?.lotes ?? []).filter((l) => (l.motivos?.[motivo] ?? 0) > 0).length;
  }

  motivosDe(l: LoteRow): { k: string; n: number }[] {
    return Object.entries(l.motivos ?? {})
      .map(([k, n]) => ({ k, n: Number(n) }))
      .sort((a, b) => b.n - a.n);
  }

  etiqueta(motivo: string): string { return etiquetaMotivo(motivo); }
  esDeNadie(motivo: string): boolean { return esDeNadie(motivo); }

  /**
   * El rótulo sale del propio lote; si el backend no lo manda, se muestra la cuenta contable
   * tal cual. ⛔ No se inventa un alias: una cuenta mal rotulada en una pantalla de
   * contabilidad es peor que una cuenta sin rótulo.
   */
  banco(l: LoteRow): string { return l.banco_label || l.cuenta_banco; }
  fuente(l: LoteRow): string { return etiquetaFuente(l.fuente); }
}

/** Una fila de la tabla: el lote más la llave que `dataKey` necesita. */
type LoteVista = LoteRow & { k: string };

/** `[CP.8.76]` Los pasos del mes, en el orden en que se hacen. */
export type Paso = 'reglas' | 'proveedores' | 'pagos' | 'archivo';

export interface PasoVista {
  id: Paso;
  titulo: string;
  /** Lo que le queda. `null` = todavía cargando (o no se pudo leer: ver `error`). El paso 4 no tiene pendiente. */
  pendientes: number | null;
  error: boolean;
  /** La línea chica bajo el título: «4 por firmar», «listo», «cargando…», «no se pudo leer». */
  estado: string;
  /** Cómo se nombra lo que falta en la frase de arriba («firmar 4 reglas»). */
  frase: (n: number) => string;
}

const plural = (n: number, uno: string, varios: string): string => `${n.toLocaleString('es-MX')} ${n === 1 ? uno : varios}`;

/**
 * `[CP.8.76]` Los cuatro pasos con su estado. ⛔ Cargando ≠ listo ≠ no se pudo leer: un paso cuya lista
 * falló NO se pinta «listo» — se leería como «no hay nada que hacer», que es justo lo contrario.
 */
export function armarPasos(e: {
  reglas: number | null; reglasError: boolean;
  proveedores: number | null; proveedoresError: boolean;
  pagos: number | null; pagosError: boolean;
  polizas: number;
}): PasoVista[] {
  const estado = (n: number | null, error: boolean, falta: (n: number) => string): string =>
    error ? 'no se pudo leer' : n === null ? 'cargando…' : n === 0 ? 'listo' : falta(n);
  return [
    { id: 'reglas', titulo: 'Reglas de cuenta', pendientes: e.reglasError ? null : e.reglas, error: e.reglasError,
      estado: estado(e.reglas, e.reglasError, (n) => plural(n, 'por firmar', 'por firmar')),
      frase: (n) => `firmar ${plural(n, 'regla', 'reglas')}` },
    { id: 'proveedores', titulo: 'Proveedores', pendientes: e.proveedoresError ? null : e.proveedores, error: e.proveedoresError,
      estado: estado(e.proveedores, e.proveedoresError, (n) => plural(n, 'nombre por confirmar', 'nombres por confirmar')),
      frase: (n) => `confirmar ${plural(n, 'nombre del banco', 'nombres del banco')}` },
    { id: 'pagos', titulo: 'Pagos a proveedor', pendientes: e.pagosError ? null : e.pagos, error: e.pagosError,
      estado: estado(e.pagos, e.pagosError, (n) => plural(n, 'pago por confirmar', 'pagos por confirmar')),
      frase: (n) => `elegir las facturas de ${plural(n, 'pago', 'pagos')}` },
    { id: 'archivo', titulo: 'Revisar y entregar', pendientes: null, error: false,
      estado: plural(e.polizas, 'póliza en el archivo', 'pólizas en el archivo'), frase: () => '' },
  ];
}

/**
 * El paso con el que abre: el primero con trabajo. Mientras alguno de los tres no termina de cargar
 * devuelve `null` (la pantalla espera en vez de abrir en uno y saltar a otro). Uno que falló cuenta
 * como «con trabajo»: abre ahí, donde está el error.
 */
export function primerPasoConTrabajo(pasos: PasoVista[]): Paso | null {
  const tres = pasos.filter((p) => p.id !== 'archivo');
  if (tres.some((p) => p.pendientes === null && !p.error)) return null;
  return tres.find((p) => p.error || (p.pendientes ?? 0) > 0)?.id ?? 'archivo';
}

export function vecino(pasos: PasoVista[], actual: Paso | null, d: -1 | 1): PasoVista | null {
  const i = pasos.findIndex((p) => p.id === actual);
  return i < 0 ? null : pasos[i + d] ?? null;
}

/** La frase de arriba: qué falta para cerrar el mes, en el orden de los pasos. */
export function fraseQueFalta(pasos: PasoVista[]): string {
  const tres = pasos.filter((p) => p.id !== 'archivo');
  if (tres.some((p) => p.error)) return 'Alguna lista no se pudo leer: el paso marcado lo dice.';
  if (tres.some((p) => p.pendientes === null)) return 'Revisando qué falta…';
  const faltan = tres.filter((p) => (p.pendientes ?? 0) > 0).map((p) => p.frase(p.pendientes as number));
  if (!faltan.length) return 'No falta nada de tu lado: descarga el archivo en el paso 4.';
  const lista = faltan.length === 1 ? faltan[0] : `${faltan.slice(0, -1).join(', ')} y ${faltan[faltan.length - 1]}`;
  return `Para que salga el resto falta ${lista}.`;
}

/** Por qué un tipo de gasto no se firma aquí, en palabras de contabilidad (no el código de la regla). */
/**
 * `[CP.8.78]` A qué paso lleva «Ir» desde un movimiento, según por qué no entra. `null` = no se resuelve en esta
 * pantalla: sin categoría se categoriza en Bancos, y fuera de banco no es de este puente.
 */
/**
 * `[CP.8.80]` El nombre con que se propone la regla: el concepto sin las iniciales sueltas del final. Medido: el
 * mismo beneficiario llega como «Oscar Hernandez R» y «Oscar Hernandez Rodriguez»; proponer «OSCAR HERNANDEZ R»
 * tomaría uno solo. Nunca deja menos de dos palabras.
 */
export function sugerenciaBeneficiario(concepto: string | null | undefined): string {
  const p = String(concepto ?? '').replace(/\s+/g, ' ').trim().toUpperCase().split(' ').filter(Boolean);
  while (p.length > 2 && p[p.length - 1].replace(/[^A-Z0-9ÁÉÍÓÚÜÑ]/g, '').length <= 1) p.pop();
  return p.join(' ');
}

export function pasoDeMotivo(motivo: string | null): Paso | null {
  if (motivo === null) return 'archivo';
  if (motivo === 'sin_categoria' || motivo === 'fuera_de_banco') return null;
  if (motivo === 'sin_regla' || motivo === 'regla_sin_cuenta' || motivo === 'sin_medir') return 'reglas';
  if (motivo === 'proveedor_sin_cuenta') return 'proveedores';
  if (motivo.startsWith('pago_')) return 'pagos';
  return 'archivo';
}

export function motivoNoFirmable(tipoRegla: string): string {
  return tipoRegla === 'por_proveedor' ? 'va a la cuenta del proveedor (pasos 2 y 3)'
    : tipoRegla === 'no_aplica' ? 'no genera póliza'
    : tipoRegla === 'sin_medir' ? 'falta medirlo: le toca a Sistemas'
    : tipoRegla === 'por_sucursal' ? 'depende de la plaza y el banco no la trae'
    : 'no lleva una cuenta fija';
}

/**
 * ⭐ Etiquetas en el idioma de quien mira. La clave técnica sigue visible abajo del rótulo,
 * porque es lo que se cita al pedir el arreglo — pero no es lo primero que se lee.
 */
const ETIQUETA_MOTIVO: Record<string, string> = {
  sin_regla: 'Sin regla firmada',
  proveedor_sin_cuenta: 'Proveedor sin cuenta',
  no_aplica: 'No genera póliza',
  sin_centro_costo: 'Sin centro de costo',
  sin_medir: 'Categoría sin medir',
  contpaqi_cuenta: 'Cuenta fuera del crosswalk',
  importe_invalido: 'Importe no positivo',
  descuadre: 'Subtotal + IVA ≠ total',
  regla_sin_cuenta: 'Regla firmada sin cuenta',
  // `[CP.8.72]` Pagos a proveedor que no se arman solos: se cuentan en su lote, nunca entran incompletos.
  pago_a_confirmar: 'Pago a proveedor: confirmar qué facturas paga',
  pago_sin_resolver: 'Pago a proveedor sin identificar',
  pago_no_cuadra: 'Pago a proveedor: facturas − notas ≠ pagado',
  pago_proveedor_sin_cuenta: 'Pago a proveedor sin cuenta',
  pago_sin_facturas: 'Pago a proveedor sin facturas',
  pago_importe_invalido: 'Pago a proveedor con un CFDI en cero',
  pago_error: 'Pago a proveedor: error al armar',
  // `[CP.8.79]` Antes estos dos desaparecían o no tenían rótulo.
  sin_categoria: 'Sin categoría',
  fuera_de_banco: 'Fuera de banco',
};

/** `[CP.8.72]` De dónde salieron las facturas de un pago armado. */
export function etiquetaFuente(f: string | null | undefined): string {
  return f === 'cadena_kepler' ? 'lo que aplicó Kepler' : f === 'importe_una' ? 'una factura por importe'
    : f === 'confirmada' ? 'lo que confirmó contabilidad' : '—';
}

/**
 * `[CP.8.73]` Las candidatas en el orden en que se revisan: lo sugerido primero, después las más recientes.
 * (Medido: mediana 19 candidatas por pago, p90 98 — sin orden no se encuentran.)
 */
export function ordenarCandidatas(facturas: CfdiPropuesto[], sugerencia: string[]): (CfdiPropuesto & { sugerida: boolean })[] {
  const s = new Set(sugerencia);
  return facturas.map((f) => ({ ...f, sugerida: s.has(f.uuid) }))
    .sort((a, b) => (a.sugerida === b.sugerida ? (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0) : a.sugerida ? -1 : 1));
}

/**
 * `[CP.8.73]` La cuenta que decide si se puede confirmar: facturas − notas contra lo pagado. ⛔ Cuadra sólo con
 * al menos una factura y una diferencia menor a $1 (lo que el armador manda a redondeo); es la misma compuerta
 * del servidor, para que el botón no prometa lo que el servidor va a rechazar.
 */
export function cuadreDePago(
  facturas: CfdiPropuesto[], notas: CfdiPropuesto[], marcadasF: ReadonlySet<string>, marcadasN: ReadonlySet<string>, pagado: number,
): { facturas: number; notas: number; diferencia: number; cuadra: boolean } {
  const cent = (n: number): number => Math.round(Number(n) * 100);
  const f = facturas.filter((x) => marcadasF.has(x.uuid)).reduce((a, x) => a + cent(x.total), 0);
  const n = notas.filter((x) => marcadasN.has(x.uuid)).reduce((a, x) => a + cent(x.total), 0);
  const d = f - n - cent(pagado);
  return { facturas: f / 100, notas: n / 100, diferencia: d / 100, cuadra: marcadasF.size > 0 && Math.abs(d) < 100 };
}

/**
 * ⛔ **El único motivo que NO es trabajo de nadie**, y la razón de que esta pantalla exista.
 *
 * `no_aplica` significa que ya se midió que ese movimiento **no genera póliza** — no que falte
 * decidirlo. Son 148 de los 1,474 de enero (10.0 %). Sumarlos a los pendientes haría que la
 * bandeja pida trabajo que no existe, y el total es justo lo que alguien mira para estimar
 * cuánto falta.
 *
 * ⚠️ Es un conjunto, no un `if`, porque la lista va a crecer: cualquier motivo nuevo que
 * signifique «ya decidido» entra acá y en ningún otro lado.
 */
const MOTIVOS_DE_NADIE = new Set(['no_aplica']);

export function etiquetaMotivo(motivo: string): string {
  return ETIQUETA_MOTIVO[motivo] ?? motivo;
}

export function esDeNadie(motivo: string): boolean {
  return MOTIVOS_DE_NADIE.has(motivo);
}

/** ⚠️ Total cero devuelve 0, no `NaN`: una tabla con `NaN%` se lee como un defecto de datos. */
export function participacion(n: number, total: number): number {
  return total > 0 ? (n / total) * 100 : 0;
}

/** Cuántos movimientos ya están decididos y por lo tanto NO esperan a nadie. */
export function contarDeNadie(motivos: { motivo: string; movimientos: number }[]): number {
  return motivos.filter((m) => esDeNadie(m.motivo)).reduce((a, m) => a + m.movimientos, 0);
}

/** `[CP.8.14]` El nombre legible de una regla: la primera frase de su evidencia («Comisión bancaria.»). */
export function nombreDeRegla(r: { evidencia: string | null; categoria_code: string }): string {
  const f = (r.evidencia ?? '').split('.')[0].trim();
  return f && f.length <= 48 ? f : r.categoria_code;
}

/**
 * `[CP.8.14]` El código del indicio, SÓLO si está en el catálogo que se puede firmar: ofrecer
 * «usar el indicio» con una cuenta que el backend va a rechazar es invitar al error.
 */
export function codigoDeIndicio(indicio: string | null, cuentas: { codigo: string }[]): string | null {
  const m = /^(\d{10})/.exec(indicio ?? '');
  return m && cuentas.some((c) => c.codigo === m[1]) ? m[1] : null;
}

/**
 * `[CP.8.54]` Bytes → base64, por tramos: `String.fromCharCode(...bytes)` de un golpe revienta
 * la pila con un archivo de unos cientos de KB.
 */
export function aBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** El mes cerrado más reciente. ⚠️ No el actual: el mes en curso siempre se ve incompleto. */
function mesCerrado(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function mesesAtras(n: number): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  for (let i = 0; i < n; i++) {
    const v = d.toISOString().slice(0, 7);
    out.push({ value: v, label: v });
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}
