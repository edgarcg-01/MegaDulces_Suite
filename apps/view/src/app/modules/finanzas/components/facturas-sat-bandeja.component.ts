import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { MessageService } from 'primeng/api';
import {
  agruparPorEmisor, rfcLimpio, textoDeLaSenal, textoDeLaSucursal,
  type AlcanceDelDescarte, type BandejaDeFacturasSat, type DetalleDeFacturaSat, type FacturaPorRegistrar, type FacturaYaRegistrada,
  type ViaRfcDelAcreedor,
} from '@megadulces/contracts';

import { SolicitudGastoService } from '../solicitud-gasto.service';
import { branchLabel } from '../../../core/constants/store-branches';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

const VIA: Record<ViaRfcDelAcreedor, string> = {
  tal_cual: 'su RFC es el mismo que tiene Kepler',
  sin_formato: 'su RFC es el de Kepler sin guiones ni espacios',
  parecido: 'Kepler tiene su RFC con un error de captura (2 caracteres o menos)',
  por_nombre: 'por el nombre: el RFC de Kepler está vacío o no es de ningún emisor',
};
/** Formas de pago del SAT que se ven en las facturas de gasto. */
const FORMA_SAT: Record<string, string> = {
  '01': 'efectivo', '02': 'cheque', '03': 'transferencia', '04': 'tarjeta de crédito', '28': 'tarjeta de débito', '99': 'por definir',
};
/** «Para todas»: no es un gasto que se registre por aquí. «No es de esta sucursal» va aparte (sólo la quita de ésta). */
const MOTIVOS_RAPIDOS = ['No es un gasto de la empresa', 'Ya se registró de otra forma', 'Es una compra de mercancía'];
/** Cuántos proveedores se ven a la primera en la fila de «con facturas sin gasto»; el resto, a un clic. */
const PROVEEDORES_A_LA_VISTA = 6;

/** El proveedor elegido en «Registrar o pedir» (su clave de Kepler, su nombre y el RFC del catálogo). */
export interface ProveedorDeLaBandeja { clave: string; nombre: string; rfc: string | null }

/** Un emisor con facturas sin gasto, como se ofrece en la fila del paso «Proveedor». */
export interface EmisorConFacturas {
  rfc: string;
  nombre: string;
  n: number;
  total: number;
  mas_antigua: string;
  /** El acreedor de esta base al que se le pueden registrar; `null` si ninguno (no se ofrece, se dice por qué). */
  acreedor: ProveedorDeLaBandeja | null;
  por_que_no: string | null;
}

/**
 * `[PGP.122]` S.13 + S.17 — **Las facturas del SAT sin gasto, dentro del paso «Proveedor»** (anexo S §14 y §15).
 *
 * S.17 (Francisco, 2026-11-16): primero la base, luego el proveedor, y SUS facturas del SAT sin asociar a ningún gasto.
 * Por eso la bandeja deja de ir arriba del formulario y tiene dos modos:
 *  · **sin proveedor** — la pregunta es «¿a qué proveedores les llegó una factura que nadie ha registrado?»: una fila de
 *    proveedores (el más antiguo primero) que se eligen de un toque (DS28). Abajo, plegado, lo registrado, lo
 *    descartado y lo que la lista no ve.
 *  · **con proveedor** — «¿qué facturas de ESTE proveedor no tienen gasto?»: sus facturas, con «Usar esta factura»
 *    (llena el comprobante, no borra al proveedor: DS29) y «No es de aquí».
 * El acto de «No es de aquí» y el panel de cada factura siguen igual que en S.13 (DS23).
 */
@Component({
  selector: 'app-facturas-sat-bandeja',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, TagModule, TextareaModule, LoadStateComponent, FreshnessPillComponent, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!sinAcceso()) {
    <section class="fs" [class.fs-prov]="!!acreedor()" aria-labelledby="fs-t">
      <app-load-state [loading]="cargando()" [error]="error()" (retry)="cargar()" [skeletonRows]="1" errorTitle="No se pudieron leer las facturas del SAT">
        @if (bandeja(); as b) {
          @if (acreedor(); as p) {
            <!-- Con proveedor: SUS facturas sin gasto. -->
            <header class="fs-head">
              <h3 id="fs-t" class="fs-t" tabindex="-1">Facturas de {{ p.nombre }} en el SAT sin gasto</h3>
              <span class="fs-sat">SAT <app-freshness-pill measures="data" [since]="b.ultima_llegada" label="la última" [staleAfterSec]="172800" /></span>
            </header>
            @if (delProveedor().length) {
              <ul class="fs-facturas">
                @for (f of delProveedor(); track f.uuid) {
                  <li class="fs-f">
                    <button type="button" class="fs-f-ver" (click)="ver(f.uuid)">
                      <span class="fs-f-fecha">{{ fecha(f.fecha) }}</span>
                      <span class="fs-f-folio">{{ f.serie_folio || 'sin folio' }}</span>
                      <span class="fs-f-total comm-num">{{ dinero(f.total) }}</span>
                      @if (f.dias > 30) { <span class="fs-f-dias">hace {{ f.dias }} días: pedirá motivo</span> }
                    </button>
                    <span class="fs-f-marcas">
                      @if (f.contabilizada) { <p-tag severity="secondary" value="ya en ContPAQi" /> }
                      @if (!f.sucursal.propuesta) { <p-tag severity="secondary" value="sucursal sin confirmar" /> }
                      @if (f.avisos.length) { <p-tag severity="warn" value="revisa antes" /> }
                    </span>
                    <!-- comm-actions: la regla global de toque (pointer: coarse) les da 44 px; con mouse quedan compactos. -->
                    <span class="fs-f-acc comm-actions">
                      @if (enUso() === f.uuid) {
                        <span class="fs-f-uso"><i class="pi pi-check" aria-hidden="true"></i> En esta solicitud</span>
                      } @else if (registrableAqui(f)) {
                        <!-- Contorno NEUTRO (plain de Aura, texto 9.50:1): el botón de acción de la pantalla es «Mandar a firma». -->
                        <p-button size="small" label="Usar esta factura" [outlined]="true" [plain]="true" [disabled]="bloqueado()"
                          [ariaLabel]="'Usar la factura ' + (f.serie_folio || 'sin folio') + ' del ' + fecha(f.fecha) + ' por ' + dinero(f.total)" (onClick)="registrarFactura(f)" />
                      } @else {
                        <small class="fs-f-sin">{{ porQueNo(f) }}</small>
                      }
                      <p-button size="small" [text]="true" severity="contrast" label="No es de aquí"
                        [ariaLabel]="'La factura ' + (f.serie_folio || 'sin folio') + ' no es de aquí'" (onClick)="abrirDescarte(f)" />
                    </span>
                    @if (f.avisos.length) {
                      <ul class="fs-avisos">@for (a of f.avisos; track a) { <li><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a }}</li> }</ul>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="fs-vacia" role="status">Sin facturas de {{ p.nombre }} en el SAT por registrar en esta base: usa su ticket, su nota o su cotización.</p>
            }
          } @else {
            <!-- Sin proveedor: a qué proveedores les llegó una factura que nadie ha registrado (DS28). -->
            <div class="fs-head">
              <p id="fs-t" class="fs-t-fila" tabindex="-1">
                @if (b.por_registrar.length) {
                  Con facturas del SAT sin gasto <span class="fs-cuenta comm-num">{{ b.por_registrar.length }} · {{ dinero(totalPorRegistrar()) }}</span>
                } @else {
                  Sin facturas del SAT por registrar en esta base
                }
              </p>
              <span class="fs-sat">SAT <app-freshness-pill measures="data" [since]="b.ultima_llegada" label="la última" [staleAfterSec]="172800" /></span>
            </div>
            @if (emisores().length) {
              <div class="fs-chips comm-actions" role="group" aria-labelledby="fs-t">
                @for (e of emisoresVisibles(); track e.rfc) {
                  @if (e.acreedor) {
                    <button pButton type="button" size="small" [outlined]="true" [plain]="true" class="fs-chip" [disabled]="bloqueado()"
                      [attr.aria-label]="'Elegir a ' + e.nombre + ': ' + e.n + (e.n === 1 ? ' factura' : ' facturas') + ' sin gasto por ' + dinero(e.total)"
                      (click)="elegirEmisor(e)">{{ e.nombre }} <span class="fs-chip-n comm-num">{{ e.n }}</span></button>
                  }
                }
                @if (emisores().length > visibles) {
                  <p-button size="small" [text]="true" severity="contrast" [icon]="verTodos() ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                    [label]="verTodos() ? 'Ver menos' : 'Ver los ' + emisores().length" (onClick)="verTodos.set(!verTodos())" />
                }
              </div>
              @if (sinAcreedor().length) {
                <p class="fs-nota"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ sinAcreedor().length }} {{ sinAcreedor().length === 1 ? 'proveedor no está' : 'proveedores no están' }} en el catálogo de Kepler de esta base: {{ nombresSinAcreedor() }}. Pídele a Finanzas que los dé de alta.</p>
              }
            }
            @if (b.registradas.length || b.descartadas.length || b.declarado.length) {
              <details class="fs-mas">
                <summary><i class="pi pi-chevron-right fs-mas-i" aria-hidden="true"></i> Ya registradas: {{ b.registradas.length }} · descartadas: {{ b.descartadas.length }} · lo que esta lista no ve</summary>
                @if (b.registradas.length) {
                  <p class="fs-sub">Ya registradas: {{ conteo().kepler }} en Kepler · {{ conteo().suite }} en la Suite · {{ conteo().pagada }} pagadas con un gasto agrupado</p>
                  <ul class="fs-lista">
                    @for (r of b.registradas; track r.uuid) {
                      <li><span class="fs-l-p">{{ fecha(r.fecha) }} · {{ r.emisor_nombre }} · {{ r.serie_folio || 'sin folio' }} · <span class="comm-num">{{ dinero(r.total) }}</span></span>
                        <span class="fs-l-s">{{ registro(r) }}</span></li>
                    }
                  </ul>
                }
                @if (b.descartadas.length) {
                  <p class="fs-sub">Descartadas</p>
                  <ul class="fs-lista">
                    @for (d of b.descartadas; track d.uuid) {
                      <li><span class="fs-l-p">{{ fecha(d.fecha) }} · {{ d.emisor_nombre }} · {{ d.serie_folio || 'sin folio' }} · <span class="comm-num">{{ dinero(d.total) }}</span></span>
                        <span class="fs-l-s">{{ d.alcance === 'sucursal' ? 'No es de esta sucursal' : 'Sacada para todas desde ' + nombreSucursal(d.sucursal) + ': «' + d.motivo + '»' }} — {{ d.por }}, {{ fechaHora(d.cuando) }}</span>
                        <p-button size="small" [text]="true" label="Regresar a la bandeja" [loading]="restaurando() === d.uuid" (onClick)="restaurar(d.uuid)" /></li>
                    }
                  </ul>
                }
                @if (b.declarado.length) {
                  <p class="fs-sub">Lo que esta lista todavía no ve</p>
                  <ul class="fs-lista">@for (d of b.declarado; track d) { <li>{{ d }}</li> }</ul>
                }
              </details>
            }
          }
        }
      </app-load-state>

      <app-side-peek [open]="peek()" (openChange)="cambioPeek($event)" [title]="tituloPeek()" [subtitle]="subtituloPeek()" [width]="480">
        @if (cargandoDetalle()) {
          <p class="fs-p-t">Leyendo la factura…</p>
        } @else if (errorDetalle(); as e) {
          <p class="fs-p-t" role="alert">{{ e }}</p>
        } @else if (detalle(); as d) {
          @if (d.por_registrar; as f) {
            <section class="fs-p">
              <h4>Por qué está aquí</h4>
              <p>{{ f.motivo }}</p>
              @if (f.avisos.length) {
                <ul class="fs-avisos">@for (a of f.avisos; track a) { <li><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a }}</li> }</ul>
              }
            </section>
            <section class="fs-p">
              <h4>Acreedor en Kepler</h4>
              <ul class="fs-lista">
                @for (a of f.acreedores; track a.clave) {
                  <li>{{ a.clave }} · {{ a.nombre }} — {{ via(a.via) }}@if (!a.en_la_sucursal) { <strong> (no está en el catálogo de esta sucursal)</strong> }
                    @if (a.por_que_no) { <br /><strong>{{ a.por_que_no }}</strong> }</li>
                }
              </ul>
            </section>
            <section class="fs-p">
              <h4>Sucursal</h4>
              <p>{{ sucursalTexto(f) }}</p>
            </section>
            <section class="fs-p">
              <h4>Importe</h4>
              <dl class="fs-dl">
                <div><dt>Subtotal</dt><dd class="comm-num">{{ dinero(f.subtotal) }}</dd></div>
                @if (f.descuento) { <div><dt>Descuento</dt><dd class="comm-num">{{ dinero(f.descuento) }}</dd></div> }
                <div><dt>IVA</dt><dd class="comm-num">{{ f.iva === null ? 'sin dato del SAT: captúralo al registrar' : dinero(f.iva) }}</dd></div>
                <div><dt>Total</dt><dd class="comm-num"><strong>{{ dinero(f.total) }}</strong></dd></div>
                <div><dt>Forma de pago</dt><dd>{{ forma(f.forma_pago) }}{{ f.metodo_pago ? ' · ' + f.metodo_pago : '' }}</dd></div>
              </dl>
            </section>
          } @else if (d.registrada; as r) {
            <section class="fs-p">
              <h4>Ya está registrada</h4>
              <p>{{ registro(r) }}.</p>
            </section>
          } @else if (d.descartada; as x) {
            <section class="fs-p">
              <h4>Descartada</h4>
              <p>{{ x.alcance === 'sucursal' ? 'No es de esta sucursal' : '«' + x.motivo + '»' }} — {{ x.por }}, {{ fechaHora(x.cuando) }}</p>
            </section>
          }
          <section class="fs-p">
            <h4>Conceptos de la factura</h4>
            @if (d.conceptos.length) {
              <ul class="fs-lista">
                @for (c of d.conceptos; track $index) {
                  <li>{{ c.descripcion }}@if (c.cantidad !== null) { · {{ c.cantidad }} {{ c.unidad || '' }} } · <span class="comm-num">{{ dinero(c.importe) }}</span></li>
                }
              </ul>
            } @else {
              <p>{{ d.tiene_xml ? 'El XML no trae conceptos legibles.' : 'La factura no tiene su XML guardado.' }}</p>
            }
            <p class="fs-uuid">UUID <span class="fs-mono">{{ d.uuid }}</span></p>
          </section>
          <div class="fs-p-acc">
            @if (d.por_registrar; as f) {
              @if (enUso() !== f.uuid && registrableAqui(f)) { <p-button label="Usar esta factura" icon="pi pi-check" [disabled]="bloqueado()" (onClick)="registrarFactura(f)" /> }
              <p-button label="No es de aquí" [text]="true" severity="contrast" (onClick)="abrirDescarte(f)" />
            }
            @if (d.tiene_xml) { <p-button label="Descargar XML" icon="pi pi-download" [outlined]="true" severity="secondary" [loading]="bajando()" (onClick)="descargarXml(d)" /> }
          </div>
        }
      </app-side-peek>

      <p-dialog [visible]="dialogo()" (visibleChange)="$event || cerrarDescarte()" (onHide)="devolverFoco()" [modal]="true" header="No es de aquí"
        [closable]="!descartandoEnvio()" [closeOnEscape]="!descartandoEnvio()" [dismissableMask]="!descartandoEnvio()"
        [style]="{ width: '30rem' }" [breakpoints]="{ '640px': '95vw' }">
        @if (descartando(); as f) {
          <p class="fs-d-t">{{ f.emisor_nombre }} · {{ f.serie_folio || 'sin folio' }} · {{ dinero(f.total) }}</p>
          @if (sucursal() !== '00') {
            <div class="fs-d-op">
              <p class="fs-d-n"><strong>No es de esta sucursal:</strong> sólo sale de {{ nombreSucursal(sucursal()) }}. La siguen viendo {{ otrasQueLaVen(f) }}.</p>
              <p-button label="No es de esta sucursal" [outlined]="true" severity="secondary" [loading]="descartandoEnvio() && alcanceEnvio() === 'sucursal'"
                [disabled]="descartandoEnvio()" (onClick)="descartar('sucursal')" />
            </div>
          }
          <div class="fs-d-op">
            <p class="fs-d-n"><strong>Sacar para todas:</strong> no es un gasto que se registre por aquí. Sale de todas las bandejas y se ve en «Descartadas» de cada sucursal que la veía, desde donde se puede regresar.</p>
            <div class="fs-d-chips" role="group" aria-label="Motivos frecuentes">
              @for (m of motivosRapidos; track m) { <p-button size="small" [outlined]="true" severity="secondary" [label]="m" [disabled]="descartandoEnvio()" (onClick)="motivo.set(m)" /> }
            </div>
            <label for="fs-motivo" class="fs-d-l">Motivo</label>
            <textarea pTextarea id="fs-motivo" rows="3" maxlength="300" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" [autoResize]="true" class="fs-d-a"
              [disabled]="descartandoEnvio()"></textarea>
            <div class="fs-d-acc">
              <p-button label="Cancelar" [text]="true" severity="secondary" [disabled]="descartandoEnvio()" (onClick)="cerrarDescarte()" />
              <p-button label="Sacar para todas" severity="secondary" [disabled]="largoMotivo() < 3 || descartandoEnvio()"
                [loading]="descartandoEnvio() && alcanceEnvio() === 'todas'" (onClick)="descartar('todas')" />
            </div>
          </div>
        }
      </p-dialog>
    </section>
    }
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    /*
     * Dentro del paso «Proveedor»: sin marco propio (el marco es el del paso). Primario: el título del bloque (--fs-body,
     * 600) y su conteo; secundario: los proveedores y las facturas (--fs-body); terciario: fecha, días y marcas (--fs-sm).
     */
    .fs { display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-body); }
    .fs-prov { padding-top: var(--sp-2); border-top: 1px solid var(--border-color); }
    .fs-head { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4); align-items: baseline; justify-content: space-between; }
    .fs-t { margin: 0; font-size: var(--fs-body); font-weight: 700; color: var(--text-main); overflow-wrap: anywhere; }
    .fs-t-fila { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .fs-cuenta { font-weight: 400; color: var(--text-muted); margin-left: var(--sp-1); }
    .fs-sat { display: inline-flex; gap: var(--sp-2); align-items: center; color: var(--text-faint); font-size: var(--fs-xs); }
    .fs-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: flex-start; }
    .fs-chip { max-width: 100%; white-space: normal; text-align: left; }
    .fs-chip-n { margin-left: var(--sp-1); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .fs-vacia, .fs-nota { margin: 0; display: flex; gap: var(--sp-2); align-items: flex-start; color: var(--text-muted); font-size: var(--fs-sm); }
    .fs-facturas, .fs-lista, .fs-avisos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .fs-facturas { gap: var(--sp-1); }
    .fs-f { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--sp-1) var(--sp-3); align-items: center; padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); }
    .fs-f:first-child { border-top: 0; }
    .fs-f-ver:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* align-content: el renglón de texto va al centro de sus 44 px, a la altura de los botones. */
    .fs-f-ver { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); align-items: baseline; align-content: center; min-height: 2.75rem; background: none; border: 0; padding: 0; color: var(--text-main); text-align: left; cursor: pointer; font: inherit; }
    .fs-f-fecha, .fs-f-dias { color: var(--text-muted); font-size: var(--fs-sm); }
    .fs-f-folio { font-weight: 600; }
    .fs-f-total { font-variant-numeric: tabular-nums; }
    .fs-f-marcas, .fs-f-acc { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; justify-content: flex-end; }
    .fs-f-sin { color: var(--text-muted); font-size: var(--fs-xs); max-width: 16rem; }
    .fs-f-uso { display: inline-flex; gap: var(--sp-1); align-items: center; color: var(--text-main); font-size: var(--fs-sm); font-weight: 600; }
    .fs-avisos { grid-column: 1 / -1; gap: var(--sp-1); color: var(--text-main); font-size: var(--fs-xs); }
    .fs-avisos li { display: flex; gap: var(--sp-2); align-items: flex-start; }
    /* Con display:flex el navegador borra el triángulo del <summary>: se pone uno explícito que gira al abrir. */
    .fs-mas summary { cursor: pointer; color: var(--text-muted); font-size: var(--fs-sm); min-height: 2.75rem; display: flex; align-items: center; gap: var(--sp-2); list-style: none; }
    .fs-mas summary::-webkit-details-marker { display: none; }
    .fs-mas-i { font-size: var(--fs-xs); }
    .fs-mas[open] > summary .fs-mas-i { transform: rotate(90deg); }
    .fs-sub { margin: var(--sp-2) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .fs-mas .fs-lista { gap: var(--sp-2); padding: 0 0 var(--sp-2) var(--sp-4); font-size: var(--fs-sm); }
    .fs-mas .fs-lista li { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); align-items: baseline; }
    .fs-l-p { color: var(--text-main); }
    .fs-l-s { color: var(--text-muted); }
    .fs-p { display: flex; flex-direction: column; gap: var(--sp-1); padding-bottom: var(--sp-3); }
    .fs-p h4 { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .fs-p p, .fs-p-t { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .fs-p .fs-lista { gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .fs-dl { margin: 0; display: grid; gap: var(--sp-1); font-size: var(--fs-sm); }
    .fs-dl div { display: flex; justify-content: space-between; gap: var(--sp-3); }
    .fs-dl dt { color: var(--text-muted); }
    .fs-dl dd { margin: 0; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .fs-uuid { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-faint); }
    .fs-mono { font-family: var(--font-mono, monospace); user-select: all; overflow-wrap: anywhere; }
    .fs-p-acc, .fs-d-acc, .fs-d-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .fs-d-acc { justify-content: flex-end; margin-top: var(--sp-3); }
    .fs-d-t { margin: 0 0 var(--sp-3); font-weight: 600; color: var(--text-main); }
    .fs-d-op { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) 0; border-top: 1px solid var(--border-color); }
    .fs-d-n { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .fs-d-l { display: block; font-size: var(--fs-sm); color: var(--text-muted); }
    .fs-d-a { width: 100%; }
    @container (max-width: 40rem) {
      .fs-f { grid-template-columns: minmax(0, 1fr); }
      .fs-f-marcas, .fs-f-acc { justify-content: flex-start; }
    }
  `],
})
export class FacturasSatBandejaComponent {
  private readonly api = inject(SolicitudGastoService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** La base de «Registrar o pedir». */
  readonly sucursal = input.required<string>();
  /** S.17: el proveedor elegido. Con él, la bandeja muestra SUS facturas; sin él, los proveedores con facturas. */
  readonly acreedor = input<ProveedorDeLaBandeja | null>(null);
  /** El UUID de la factura que ya usa la solicitud en captura: su fila lo dice en vez de ofrecerla otra vez. */
  readonly enUso = input<string | null>(null);
  /** Sube cuando se mandó una solicitud: la factura que se registró sale sola (la cubre su vale). */
  readonly refrescar = input(0);
  /** Mientras el formulario manda una solicitud, «Usar esta factura» espera (no se pisa lo que va en camino). */
  readonly bloqueado = input(false);
  /** «Usar esta factura»: el comprobante de la solicitud se llena con ella. */
  readonly registrar = output<FacturaPorRegistrar>();
  /** S.17 (DS28): un proveedor elegido desde sus facturas sin gasto. */
  readonly elegirProveedor = output<ProveedorDeLaBandeja>();

  readonly motivosRapidos = MOTIVOS_RAPIDOS;
  readonly visibles = PROVEEDORES_A_LA_VISTA;
  readonly bandeja = signal<BandejaDeFacturasSat | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /**
   * El servidor dice que esta persona no ve facturas de esta base (403: su alcance no la incluye). No es un error: el
   * bloque no se muestra y el formulario sigue. Con S.17 no debería pasar (la base ya es suya), pero si pasa, no se finge.
   */
  readonly sinAcceso = signal(false);
  readonly verTodos = signal(false);
  readonly totalPorRegistrar = computed(() => Math.round((this.bandeja()?.por_registrar ?? []).reduce((s, f) => s + f.total, 0) * 100) / 100);

  /** Los emisores con facturas sin gasto, el de la factura más antigua primero (lo que más urge, como en S.13 H5). */
  readonly emisores = computed((): EmisorConFacturas[] => agruparPorEmisor(this.bandeja()?.por_registrar ?? []).map((g) => {
    const f = g.facturas.find((x) => this.registrableAqui(x));
    const a = f?.acreedores.find((x) => x.en_la_sucursal && x.registrable);
    const nombre = a?.nombre || g.emisor_nombre || g.emisor_rfc;
    return {
      rfc: g.emisor_rfc, nombre, n: g.facturas.length, total: g.total, mas_antigua: g.mas_antigua,
      acreedor: a ? { clave: a.clave, nombre, rfc: g.emisor_rfc } : null,
      por_que_no: a ? null : this.porQueNo(g.facturas[0]),
    };
  }));
  readonly emisoresVisibles = computed(() => {
    const todos = this.emisores().filter((e) => !!e.acreedor);
    return this.verTodos() ? todos : todos.slice(0, PROVEEDORES_A_LA_VISTA);
  });
  readonly sinAcreedor = computed(() => this.emisores().filter((e) => !e.acreedor));
  readonly nombresSinAcreedor = computed(() => this.sinAcreedor().map((e) => e.nombre).join(', '));

  /** Las facturas sin gasto del proveedor elegido (por su clave de Kepler, o por su RFC), la más antigua primero. */
  readonly delProveedor = computed(() => {
    const p = this.acreedor();
    if (!p) return [];
    return [...(this.bandeja()?.por_registrar ?? [])].filter((f) => esDelProveedor(f, p))
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.uuid.localeCompare(b.uuid));
  });

  /** Quién abrió el panel o el diálogo: al cerrar, el foco vuelve ahí (S.13 H6). */
  private disparador: HTMLElement | null = null;
  readonly conteo = computed(() => {
    const r = this.bandeja()?.registradas ?? [];
    const de = (...ss: string[]) => r.filter((x) => ss.includes(x.registro.senal)).length;
    return { kepler: de('referencia', 'referencia_otro', 'difusa'), suite: de('suite', 'suite_ticket'), pagada: de('pagada') };
  });

  // El panel lateral
  readonly peek = signal(false);
  readonly detalle = signal<DetalleDeFacturaSat | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly bajando = signal(false);
  /** El último detalle pedido: una respuesta de otro (que llegó tarde) no se pinta en este panel. */
  private pedido = '';
  readonly tituloPeek = computed(() => {
    const f = this.detalle()?.por_registrar;
    return f ? `${f.emisor_nombre || f.emisor_rfc} · ${f.serie_folio || 'sin folio'}` : 'Factura del SAT';
  });
  readonly subtituloPeek = computed(() => {
    const f = this.detalle()?.por_registrar;
    return f ? `${this.fecha(f.fecha)} · ${this.dinero(f.total)} · ${f.emisor_rfc}` : null;
  });

  // «No es de aquí»
  readonly dialogo = signal(false);
  readonly descartando = signal<FacturaPorRegistrar | null>(null);
  readonly motivo = signal('');
  /** Caracteres reales (como los cuenta la base): un emoji es uno. */
  readonly largoMotivo = computed(() => [...this.motivo().trim()].length);
  readonly descartandoEnvio = signal(false);
  readonly alcanceEnvio = signal<AlcanceDelDescarte | null>(null);
  readonly restaurando = signal<string | null>(null);

  constructor() {
    effect(() => {
      const s = this.sucursal();
      this.refrescar();
      untracked(() => { if (s) this.cargar(); });
    });
  }

  cargar(): void {
    const s = this.sucursal();
    if (!s) return;
    this.cargando.set(true);
    this.error.set(null);
    this.sinAcceso.set(false);
    this.api.facturasSat(s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => { if (this.sucursal() !== s) return; this.bandeja.set(b); this.cargando.set(false); },
      error: (e) => {
        if (this.sucursal() !== s) return;
        this.cargando.set(false);
        if (Number(e?.status) === 403) { this.sinAcceso.set(true); return; }
        this.error.set(e?.error?.message || 'Revisa tu conexión e intenta otra vez');
      },
    });
  }

  /** Se ofrece «Usar esta factura» sólo si «Mandar a firma» lo aceptaría: el acreedor en esta base y con un RFC compatible. */
  registrableAqui(f: FacturaPorRegistrar): boolean {
    return f.acreedores.some((a) => a.en_la_sucursal && a.registrable);
  }

  porQueNo(f: FacturaPorRegistrar): string {
    const aqui = f.acreedores.find((a) => a.en_la_sucursal && !a.registrable);
    return aqui?.por_que_no ?? 'El acreedor no está en el catálogo de Kepler de esta sucursal';
  }

  otrasQueLaVen(f: FacturaPorRegistrar): string {
    const otras = f.sucursal.propuesta ? [] : f.sucursal.opciones.filter((s) => s !== this.sucursal());
    return [...otras, '00'].map((s) => this.nombreSucursal(s)).join(', ');
  }

  /** La sucursal por su nombre («05 Zamora Centro»), nunca la clave sola (S.13 H8). */
  nombreSucursal(s: string | null | undefined): string {
    return branchLabel(s) || String(s ?? '');
  }

  /** DS28: elegir al proveedor desde sus facturas; el formulario lo pone en «Proveedor» y aquí aparecen sus facturas. */
  elegirEmisor(e: EmisorConFacturas): void {
    if (this.bloqueado() || !e.acreedor) return;
    this.verTodos.set(false);
    this.elegirProveedor.emit(e.acreedor);
  }

  registrarFactura(f: FacturaPorRegistrar): void {
    if (this.bloqueado()) return;
    // El foco va al formulario (lo pone «Registrar o pedir»): no se regresa a la fila.
    this.disparador = null;
    this.peek.set(false);
    this.registrar.emit(f);
  }

  private recordarDisparador(): void {
    const a = typeof document === 'undefined' ? null : document.activeElement;
    this.disparador = a instanceof HTMLElement && a !== document.body ? a : null;
  }

  /** Al cerrar el panel o el diálogo, el foco vuelve a la fila que lo abrió; si la fila ya no está, al título. */
  devolverFoco(): void {
    const el = this.disparador;
    this.disparador = null;
    setTimeout(() => {
      if (el?.isConnected) el.focus();
      else (document.getElementById('fs-t') as HTMLElement | null)?.focus();
    }, 0);
  }

  cambioPeek(abierto: boolean): void {
    this.peek.set(abierto);
    if (!abierto) this.devolverFoco();
  }

  ver(uuid: string): void {
    this.recordarDisparador();
    const s = this.sucursal();
    this.pedido = uuid;
    this.detalle.set(null);
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    this.peek.set(true);
    this.api.facturaSat(uuid, s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { if (this.pedido !== uuid) return; this.detalle.set(d); this.cargandoDetalle.set(false); },
      error: (e) => { if (this.pedido !== uuid) return; this.errorDetalle.set(e?.error?.message || 'No se pudo leer la factura'); this.cargandoDetalle.set(false); },
    });
  }

  descargarXml(d: DetalleDeFacturaSat): void {
    const f = d.por_registrar;
    const nombre = f ? `${f.emisor_rfc}_${f.serie_folio || d.uuid}.xml`.replace(/[^\w.-]+/g, '_') : `${d.uuid}.xml`;
    this.bajando.set(true);
    this.api.xmlDeFacturaSat(d.uuid, this.sucursal()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.bajando.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: () => { this.bajando.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo descargar el XML', detail: 'Intenta de nuevo' }); },
    });
  }

  /** Abre el diálogo y cierra el panel: el mismo Esc ya no cierra los dos, y el diálogo dice qué factura es. */
  abrirDescarte(f: FacturaPorRegistrar): void {
    // Desde el panel, el que vuelve a recibir el foco es la fila que abrió el panel, no el botón del panel.
    if (!this.peek()) this.recordarDisparador();
    this.peek.set(false);
    this.motivo.set('');
    this.descartando.set(f);
    this.dialogo.set(true);
  }

  cerrarDescarte(): void {
    if (this.descartandoEnvio()) return;
    this.dialogo.set(false);
    this.descartando.set(null);
  }

  descartar(alcance: AlcanceDelDescarte): void {
    const f = this.descartando();
    if (!f || this.descartandoEnvio()) return;
    const motivo = alcance === 'sucursal' ? '' : this.motivo().trim();
    if (alcance === 'todas' && [...motivo].length < 3) return;
    this.descartandoEnvio.set(true);
    this.alcanceEnvio.set(alcance);
    this.api.descartarFacturaSat(f.uuid, { sucursal: this.sucursal(), alcance, motivo }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.descartandoEnvio.set(false);
        this.alcanceEnvio.set(null);
        // La fila se va de la lista al recargar: el foco no puede volver a ella, va al título del bloque.
        this.disparador = null;
        this.cerrarDescarte();
        this.toast.add({ severity: 'success', summary: alcance === 'sucursal' ? 'Ya no se ve en esta sucursal' : 'Se sacó de la bandeja',
          detail: `${f.serie_folio || ''} · ${this.dinero(f.total)}: se puede regresar desde «Descartadas».` });
        this.cargar();
      },
      error: (e) => {
        this.descartandoEnvio.set(false);
        this.alcanceEnvio.set(null);
        this.toast.add({ severity: 'error', summary: 'No se sacó', detail: e?.error?.message || 'Intenta de nuevo', life: 8000 });
        if (Number(e?.status) === 409 || Number(e?.status) === 404) { this.cerrarDescarte(); this.cargar(); }
      },
    });
  }

  restaurar(uuid: string): void {
    if (this.restaurando()) return;
    this.restaurando.set(uuid);
    this.api.restaurarFacturaSat(uuid, this.sucursal()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.restaurando.set(null); this.toast.add({ severity: 'success', summary: 'Regresó a la bandeja' }); this.cargar(); },
      error: (e) => { this.restaurando.set(null); this.toast.add({ severity: 'error', summary: 'No se regresó', detail: e?.error?.message || 'Intenta de nuevo' }); this.cargar(); },
    });
  }

  registro(r: FacturaYaRegistrada): string {
    const x = r.registro;
    const doc = x.documento ? `: ${x.documento.tipo} ${x.documento.folio} de ${x.documento.sucursal}, ${this.fecha(x.documento.fecha)}` : '';
    const quien = x.acreedor ? ` (a nombre de ${x.acreedor})` : '';
    const vale = x.vale?.folio_solicitud ? ` (solicitud ${x.vale.folio_solicitud})` : '';
    return `${textoDeLaSenal(x.senal)}${doc}${quien}${vale}`;
  }
  via(v: ViaRfcDelAcreedor): string { return VIA[v]; }
  forma(c: string | null): string { return c ? `${FORMA_SAT[c] ?? 'otra'} (SAT ${c})` : 'sin forma de pago en el CFDI'; }
  sucursalTexto(f: FacturaPorRegistrar): string {
    const t = textoDeLaSucursal(f.sucursal, (s) => this.nombreSucursal(s));
    return f.sucursal.opciones.length && !f.sucursal.propuesta
      ? `${t}. En su historia: ${f.sucursal.opciones.map((s) => this.nombreSucursal(s)).join(' y ')}.` : t;
  }
  dinero(n: number | null | undefined): string {
    return Number(n ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  fecha(iso: string | null | undefined): string {
    if (!iso) return '—';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }
  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}

/** ¿La factura es de este proveedor? Por su clave de Kepler (la escalera del RFC ya la resolvió) o por su RFC. */
export function esDelProveedor(f: FacturaPorRegistrar, p: ProveedorDeLaBandeja): boolean {
  if (f.acreedores.some((a) => a.clave === p.clave)) return true;
  const rfc = rfcLimpio(p.rfc);
  return !!rfc && rfcLimpio(f.emisor_rfc) === rfc;
}
