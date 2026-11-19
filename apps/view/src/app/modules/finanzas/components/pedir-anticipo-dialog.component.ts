import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, model, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { CheckboxModule } from 'primeng/checkbox';
import { RadioButtonModule } from 'primeng/radiobutton';
import { MessageService } from 'primeng/api';
import {
  cuentaCortaAnticipo, digitosClabe, faltaSolicitudAnticipo, importeSugeridoAnticipo, llaveOcKepler, numeroDeCuentaValido, textoUltimoMovimiento, topeDeOcs,
  type AnticipoOcKeplerRow, type AnticipoProveedorRow, type AnticipoSolicitudBody, type CuentaDelAnticipo, type ModoImporteAnticipo,
} from '@megadulces/contracts';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { leerPesos } from '../pages/calendario-pagos-descuento';
import { money } from '../../../shared/util/money.util';
import { environment } from '../../../../environments/environment';

/** Lo que devuelve el servidor al pedir, más lo que la pantalla que abrió el diálogo necesita para releer. */
export interface AnticipoPedido {
  obligation_id: string; monto: number; concepto: string;
  cuenta: 'aprobada' | 'pedida' | 'ya_pedida' | 'efectivo';
  proveedor: string;
  /** El día en que aparece en el Calendario (YYYY-MM-DD). */
  fecha: string;
}

/** Una cuenta aprobada del proveedor, del catálogo de Cuentas de pago (`GET …/by-supplier/:id`). */
interface CuentaCatalogo { id: string; bank_name: string; clabe: string | null; account_number: string | null; alias: string | null; es_favorita: boolean }

/** `pedir`: Compras o quien programa pagos elige el día. `programar`: Dirección, desde el Calendario, en el día que ve. */
export type ModoAnticipo = 'pedir' | 'programar';

/**
 * `[PGP.142]` El día con que abre el diálogo: el que se está viendo, si no pasó; si no, hoy. Un anticipo no
 * se pide para un día que ya pasó (el calendario del diálogo no lo deja elegir).
 */
export function diaInicialDelAnticipo(visto: string | null | undefined, hoy: string): string {
  return visto && /^\d{4}-\d{2}-\d{2}$/.test(visto) && visto >= hoy ? visto : hoy;
}

/**
 * `[PGP.119]` · `[PGP.127]` · `[PGP.138]` · `[PGP.142]` **Pedir o programar un anticipo a proveedor, con sus
 * papeles**: la OC de Kepler, la cotización y la cuenta. UN solo diálogo para todas las puertas (ADR-056: no se
 * copia): el Calendario de pagos, Compras › Anticipos, Compras › OC abiertas y «Anticipos solicitados».
 *
 * Dos modos (`[PGP.138]`, Edgar): `pedir` — se elige el día y entra al Calendario por programar; `programar` —
 * Dirección, desde el Calendario, en el día que está viendo (no se elige otro: el día ES el contexto) y la
 * pantalla, al recibir `pedido`, lo pone en ese día.
 *
 * El orden es el de los papeles (proveedor → OC → importe → cotización → cuenta → día). La MISMA regla que el
 * servidor (`faltaSolicitudAnticipo`) apaga el botón y dice por qué; se lee al enfocar el botón, no en cada
 * tecla. De la auditoría de `[PGP.138]`: una lectura que falla no se ve como «sin OC» ni «sin resultados» (dice
 * qué falló y deja reintentar), cerrar con algo capturado pregunta antes de tirarlo, la lista de proveedores no
 * se anuncia como un `listbox` que no se recorre con flechas, y el error del servidor se dice DENTRO del diálogo.
 *
 * Se abre de dos formas: `[(visible)]` (con `fechaInicial`), o `abrir(dia)` / `abrirParaOc(...)` desde una
 * referencia de plantilla (`[PGP.142]`/`[PGP.143]`). Al pedir avisa con el `MessageService` de la pantalla que
 * lo contiene (cada una pone su `<p-toast>`) y emite `pedido` para que esa pantalla relea.
 */
@Component({
  selector: 'app-pedir-anticipo-dialog',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, DialogModule, SelectModule, DatePickerModule, CheckboxModule, RadioButtonModule, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" [modal]="true" [closable]="false" [closeOnEscape]="false" [header]="titulo()"
              [style]="{ width: '38rem' }" [breakpoints]="{ '640px': '96vw' }" (onShow)="alAbrir()">
      <form class="pa-form" (ngSubmit)="guardar()" (keydown.escape)="pedirCerrar()">
        <p class="pa-help">{{ ayuda() }}</p>
        @if (deOc(); as d) {
          <!-- [PGP.143] Abierto desde la orden de compra de Compras: se dice cuál. -->
          <p class="pa-deoc"><i class="pi pi-shopping-cart" aria-hidden="true"></i> Sobre la orden de compra <b>{{ d.folio }}</b> de {{ d.sucursal | sucursal }}</p>
        }
        <label class="pa-label" for="pa-prov">Proveedor (de mercancía)</label>
        @if (provAviso(); as a) { <p class="pa-muted pa-aviso" role="status">{{ a }}</p> }
        @if (prov(); as p) {
          <!-- &nbsp;: Angular quita el espacio entre etiquetas y el código salía pegado al nombre (visto en el recorrido). -->
          <div class="pa-elegido"><span><b>{{ p.name }}</b>&nbsp;<span class="pa-muted">{{ p.code }}</span></span>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="quitarProveedor()" [attr.aria-label]="'Cambiar el proveedor ' + p.name">Cambiar</button></div>
        } @else {
          <input id="pa-prov" name="pa-prov" pInputText type="search" autocomplete="off" enterkeyhint="search" class="pa-full" placeholder="Nombre o código del proveedor"
                 [ngModel]="busca()" (ngModelChange)="buscarProveedor($event)" aria-describedby="pa-prov-estado" />
          <p id="pa-prov-estado" class="pa-muted" aria-live="polite">
            @switch (estadoBusqueda()) {
              @case ('buscando') { Buscando… }
              @case ('vacio') { Ningún proveedor de mercancía activo coincide con «{{ busca().trim() }}». }
              @case ('hay') { {{ opciones().length === 1 ? '1 proveedor' : opciones().length + ' proveedores' }}: elige uno. }
            }
          </p>
          @if (estadoBusqueda() === 'error') {
            <p class="pa-error" role="alert">No se pudo buscar el proveedor.
              <button pButton type="button" class="p-button-sm p-button-text" (click)="buscarAhora()">Reintentar</button></p>
          }
          @if (opciones().length) {
            <ul class="pa-opciones" aria-label="Proveedores encontrados">
              @for (o of opciones(); track o.id) {
                <!-- [PGP.155.2] Con su último movimiento, como en «Cuentas de pago» [PGP.154]: VUMERSOFT salía dos
                     veces (CD004 y CV10) y nada decía cuál se usa. -->
                <li><button type="button" class="pa-opcion" (click)="elegirProveedor(o)">{{ o.name }}&nbsp;<span class="pa-muted">{{ o.code }}@if (movimiento(o); as m) { · {{ m }}}</span></button></li>
              }
            </ul>
          }
        }
        @if (prov(); as p) {
          <!-- [PGP.127] D11: la OC real es la de Kepler (la Suite dejó de hacer OC el 26-oct). Una o varias de UNA sucursal. -->
          <fieldset class="pa-fs">
            <legend class="pa-label">Orden de compra en Kepler</legend>
            @if (ocAviso(); as a) { <p class="pa-muted pa-aviso" role="status">{{ a }}</p> }
            @if (ocsCargando()) {
              <p class="pa-muted" aria-live="polite">Leyendo sus órdenes de compra…</p>
            } @else if (ocsError()) {
              <p class="pa-error" role="alert">No se pudieron leer las órdenes de compra de {{ p.name }}: sin ellas no se sabe el tope del anticipo.
                <button pButton type="button" class="p-button-sm p-button-text" (click)="cargarOcs(p)">Reintentar</button></p>
            } @else if (!ocs().length) {
              <p class="pa-muted">{{ p.name }} no tiene órdenes de compra pendientes en Kepler (últimos 180 días). El anticipo va atado a una: captúrala en Kepler y vuelve a elegir al proveedor.</p>
            } @else {
              <ul class="pa-ocs" aria-label="Órdenes de compra pendientes en Kepler">
                @for (o of ocs(); track llaveOc(o)) {
                  <li>
                    <label class="pa-oc" [class.pa-oc--off]="ocBloqueada(o)" [for]="'pa-oc-' + llaveOc(o)">
                      <p-checkbox [binary]="true" [inputId]="'pa-oc-' + llaveOc(o)" [name]="'pa-oc-' + llaveOc(o)" [ngModel]="ocMarcada(o)" (ngModelChange)="alternarOc(o, $event)" [disabled]="ocBloqueada(o)" />
                      <span class="pa-oc-txt"><b>OC {{ o.folio }}</b> · {{ o.sucursal | sucursal }} · {{ fecha(o.fecha) }}<span class="pa-muted"> · {{ o.estado === 'R' ? 'recibida en parte' : 'pendiente' }}</span></span>
                      <span class="comm-num pa-oc-num">{{ pesos(o.total) }}@if (pedidoSobre(o) > 0) {<span class="pa-muted"> · ya {{ pesos(pedidoSobre(o)) }} pedidos</span>}</span>
                    </label>
                  </li>
                }
              </ul>
              @if (ocsElegidas().length) {
                <p class="pa-muted">Se captura en <b>{{ sucursal() | sucursal }}</b> (la sucursal de su OC). Quedan <b>{{ pesos(tope().queda) }}</b> para anticipar.</p>
              } @else if (sucursales() > 1) {
                <p class="pa-muted">Son de varias sucursales: elige las de una sola (el anticipo sólo se aplica en su sucursal).</p>
              }
            }
          </fieldset>
        }
        <!-- [PGP.155] El importe se PROPONE desde la OC: todo lo que queda (100 %), un porcentaje o a mano. -->
        <fieldset class="pa-fs">
          <legend class="pa-label">Importe</legend>
          <div class="pa-radios">
            <label class="pa-radio"><p-radiobutton name="pa-modo" value="todo" inputId="pa-modo-t" [ngModel]="modoImporte()" (ngModelChange)="modoImporte.set($event)" /> Todo lo que queda de la OC</label>
            <label class="pa-radio"><p-radiobutton name="pa-modo" value="porcentaje" inputId="pa-modo-p" [ngModel]="modoImporte()" (ngModelChange)="modoImporte.set($event)" /> Un porcentaje</label>
            <label class="pa-radio"><p-radiobutton name="pa-modo" value="importe" inputId="pa-modo-i" [ngModel]="modoImporte()" (ngModelChange)="modoImporte.set($event)" /> Otro importe</label>
          </div>
          @switch (modoImporte()) {
            @case ('todo') {
              @if (importe(); as m) {
                <p class="pa-importe comm-num">{{ pesos(m) }}</p>
                <p class="pa-muted">{{ tope().anticipado > 0 ? 'Lo que queda de ' + pesos(tope().total) + ' (ya hay ' + pesos(tope().anticipado) + ' pedidos).' : 'El 100 % de ' + ocsTexto() + '.' }}</p>
              } @else {
                <p class="pa-muted">{{ ocsElegidas().length ? 'Esa orden ya no tiene saldo para anticipar.' : 'Elige la orden de compra y aquí sale su importe.' }}</p>
              }
            }
            @case ('porcentaje') {
              <div class="pa-pct">
                <input id="pa-pct" name="pa-pct" pInputText type="text" inputmode="decimal" autocomplete="off" class="comm-num pa-pct-in" aria-label="Porcentaje de la orden de compra"
                       [ngModel]="porcentaje()" (ngModelChange)="porcentaje.set($event)" />
                <span>% de {{ pesos(tope().total) }}</span>
                @if (importe(); as m) { <span>= <b class="comm-num">{{ pesos(m) }}</b></span> }
              </div>
            }
            @case ('importe') {
              <input id="pa-monto" name="pa-monto" pInputText type="text" inputmode="decimal" autocomplete="off" class="pa-full comm-num pa-monto" aria-label="Importe del anticipo"
                     [ngModel]="monto()" (ngModelChange)="monto.set($event)" />
            }
          }
        </fieldset>

        <!-- [PGP.127] D10: la cotización es obligatoria (PDF o foto); es el respaldo de qué se paga y de la CLABE. -->
        <label class="pa-label" for="pa-cot">Cotización del proveedor</label>
        @if (cot(); as c) {
          <div class="pa-elegido"><span><i class="pi pi-file" aria-hidden="true"></i> {{ c.nombre }}</span>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="quitarCotizacion()" aria-label="Cambiar la cotización">Cambiar</button></div>
        } @else {
          <input id="pa-cot" name="pa-cot" type="file" accept="application/pdf,image/*" class="pa-file" [disabled]="cotSubiendo()" (change)="elegirCotizacion($event)" />
          @if (cotSubiendo()) { <p class="pa-muted" aria-live="polite">Subiendo la cotización…</p> }
          @if (cotError(); as e) { <p class="pa-error" role="alert">{{ e }}</p> }
        }

        <!-- [PGP.127] D12: la CLABE nueva la aprueba Dirección antes de pagar (en Cuentas de pago, con la cotización a la vista).
             [PGP.155] La cuenta aprobada puede no tener CLABE (mismo banco), y la nueva puede ser un número de cuenta. -->
        <fieldset class="pa-fs">
          <legend class="pa-label">Se paga a</legend>
          <div class="pa-radios">
            @if (cuentas().length) {
              <label class="pa-radio"><p-radiobutton name="pa-cta" value="aprobada" inputId="pa-cta-a" [ngModel]="ctaTipo()" (ngModelChange)="ctaTipo.set($event)" /> Cuenta aprobada</label>
            }
            <label class="pa-radio"><p-radiobutton name="pa-cta" value="nueva" inputId="pa-cta-n" [ngModel]="ctaTipo()" (ngModelChange)="ctaTipo.set($event)" /> CLABE de la cotización</label>
            <label class="pa-radio"><p-radiobutton name="pa-cta" value="nueva_cuenta" inputId="pa-cta-c" [ngModel]="ctaTipo()" (ngModelChange)="ctaTipo.set($event)" /> Cuenta del mismo banco</label>
            <label class="pa-radio"><p-radiobutton name="pa-cta" value="efectivo" inputId="pa-cta-e" [ngModel]="ctaTipo()" (ngModelChange)="ctaTipo.set($event)" /> Efectivo</label>
          </div>
          @switch (ctaTipo()) {
            @case ('aprobada') {
              @if (cuentas().length === 1) {
                <!-- Con una sola cuenta aprobada no hay nada que elegir: se dice cuál. -->
                <p class="pa-fijo">{{ cuentaOpciones()[0].label }}</p>
              } @else {
                <p-select inputId="pa-cta-sel" name="pa-cta-sel" appendTo="body" [options]="cuentaOpciones()" optionLabel="label" optionValue="value" [ngModel]="cuentaId()" (ngModelChange)="cuentaId.set($event)"
                          placeholder="Elige la cuenta" [fluid]="true" ariaLabel="Cuenta aprobada del proveedor" />
              }
              @if (cuentaSinClabe(); as c) {
                <p class="pa-muted">Sin CLABE: es una transferencia entre cuentas de {{ c.bank_name }}; sale de una cuenta nuestra de {{ c.bank_name }}.</p>
              }
            }
            @case ('nueva') {
              <div class="pa-campos">
                <div>
                  <label class="pa-label pa-label--sub" for="pa-clabe">CLABE (18 dígitos)</label>
                  <input id="pa-clabe" name="pa-clabe" pInputText type="text" inputmode="numeric" autocomplete="off" class="pa-full comm-num" [ngModel]="clabe()" (ngModelChange)="clabe.set($event)" />
                </div>
                <div>
                  <label class="pa-label pa-label--sub" for="pa-banco">Banco</label>
                  <input id="pa-banco" name="pa-banco" pInputText type="text" autocomplete="off" class="pa-full" [ngModel]="banco()" (ngModelChange)="banco.set($event)" placeholder="Ej. BBVA" />
                </div>
              </div>
              <p class="pa-muted">Dirección aprueba esta CLABE antes del pago, con la cotización a la vista. Sin esa aprobación el anticipo no se puede transferir.</p>
            }
            @case ('nueva_cuenta') {
              <div class="pa-campos">
                <div>
                  <label class="pa-label pa-label--sub" for="pa-cuenta">Número de cuenta</label>
                  <input id="pa-cuenta" name="pa-cuenta" pInputText type="text" inputmode="numeric" autocomplete="off" class="pa-full comm-num" [ngModel]="cuentaNum()" (ngModelChange)="cuentaNum.set($event)" />
                </div>
                <div>
                  <label class="pa-label pa-label--sub" for="pa-banco-c">Banco</label>
                  <input id="pa-banco-c" name="pa-banco-c" pInputText type="text" autocomplete="off" class="pa-full" [ngModel]="banco()" (ngModelChange)="banco.set($event)" placeholder="Ej. BBVA" />
                </div>
              </div>
              <p class="pa-muted">Para transferir entre cuentas del mismo banco, sin CLABE. Dirección la aprueba antes del pago, con la cotización a la vista.</p>
            }
            @case ('efectivo') { <p class="pa-muted">Sale en efectivo de Caja General: no lleva cuenta.</p> }
          }
        </fieldset>
        <div class="pa-campos">
          <div>
            @if (modo() === 'programar') {
              <span class="pa-label">Se paga el</span>
              <p class="pa-fijo">{{ fechaLarga() }}</p>
            } @else {
              <label class="pa-label" for="pa-fecha">Pagar el</label>
              <p-datepicker inputId="pa-fecha" name="pa-fecha" [ngModel]="dia()" (ngModelChange)="dia.set($event)" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" [minDate]="hoy" [fluid]="true" />
            }
          </div>
          <div>
            <label class="pa-label" for="pa-motivo">Para qué es</label>
            <input id="pa-motivo" name="pa-motivo" pInputText type="text" autocomplete="off" class="pa-full" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Ej. apartar producto de temporada" />
          </div>
        </div>

        @if (falta(); as f) { <p id="pa-falta" class="pa-muted">{{ f }}</p> }
        @if (errorGuardar(); as e) { <p class="pa-error" role="alert">No se {{ modo() === 'programar' ? 'programó' : 'pidió' }} el anticipo: {{ e }}</p> }

        @if (confirmarDescarte()) {
          <div class="pa-descarte" role="alertdialog" aria-labelledby="pa-descarte-t">
            <p id="pa-descarte-t">¿Descartar lo capturado?</p>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="confirmarDescarte.set(false)">Seguir capturando</button>
            <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" (click)="cerrar()">Descartar</button>
          </div>
        } @else {
          <div class="pa-acciones">
            <button pButton type="button" class="p-button-text p-button-secondary" (click)="pedirCerrar()">Cancelar</button>
            <button pButton type="submit" [disabled]="!!falta() || guardando()" [loading]="guardando()" [attr.aria-describedby]="falta() ? 'pa-falta' : null">{{ accion() }}</button>
          </div>
        }
      </form>
    </p-dialog>
  `,
  styles: [`
    :host { display: contents; }
    .pa-form { display: block; }
    .pa-help { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-2); }
    .pa-deoc { font-size: var(--fs-sm); color: var(--text-main); margin: 0 0 var(--sp-2); display: flex; gap: var(--sp-2); align-items: center; }
    .pa-aviso { color: var(--warn-soft-fg); margin: 0 0 var(--sp-1); }
    .pa-error { font-size: var(--fs-sm); color: var(--bad-soft-fg); margin: var(--sp-2) 0 0; }
    .pa-label { display: block; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: var(--sp-3) 0 var(--sp-1); }
    .pa-label--sub { font-weight: 400; margin-top: var(--sp-2); }
    .pa-muted { font-size: var(--fs-xs); color: var(--text-muted); }
    .pa-muted:empty { display: none; }
    .pa-fijo { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .pa-full { width: 100%; }
    .pa-monto { max-width: 14rem; }
    /* [PGP.155] El importe sugerido es el dato que se firma: se lee primero. */
    .pa-importe { margin: 0; font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); }
    .pa-pct { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .pa-pct-in { width: 5rem; }
    .pa-campos { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    .pa-elegido { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .pa-opciones { list-style: none; margin: var(--sp-1) 0 0; padding: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); max-height: 14rem; overflow-y: auto; }
    .pa-opcion { display: block; width: 100%; text-align: left; padding: var(--sp-2) var(--sp-3); background: none; border: 0; color: var(--text-main); font: inherit; cursor: pointer; }
    .pa-opcion:hover { background: var(--overlay-hover); }
    .pa-opcion:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .pa-acciones, .pa-descarte { display: flex; justify-content: flex-end; align-items: center; gap: var(--sp-2); margin-top: var(--sp-4); }
    .pa-descarte p { margin: 0 auto 0 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .pa-fs { border: 0; padding: 0; margin: 0; min-width: 0; }
    .pa-ocs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); max-height: 13rem; overflow-y: auto; }
    .pa-oc { display: grid; grid-template-columns: auto 1fr auto; gap: var(--sp-2); align-items: center; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; }
    .pa-ocs li + li .pa-oc { border-top: 1px solid var(--border-color); }
    .pa-oc:hover { background: var(--overlay-hover); }
    .pa-oc--off { color: var(--text-muted); cursor: not-allowed; }
    .pa-oc-num { white-space: nowrap; text-align: right; }
    .pa-file { display: block; font-size: var(--fs-sm); color: var(--text-main); }
    .pa-file:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pa-radios { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); margin: 0 0 var(--sp-2); }
    .pa-radio { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; }
    @media (max-width: 40rem) {
      .pa-oc { grid-template-columns: auto 1fr; } .pa-oc-num { grid-column: 2; text-align: left; }
      .pa-campos { grid-template-columns: 1fr; }
    }
  `],
})
export class PedirAnticipoDialogComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  /** El de la pantalla que lo contiene: cada una pone su `<p-toast>`. */
  private readonly toast = inject(MessageService);
  private readonly obligaciones = `${environment.apiUrl}/commercial/supplier-obligations`;
  /** `[PGP.127]` El catálogo de cuentas del proveedor (las aprobadas). */
  private readonly urlCuentas = `${environment.apiUrl}/finance/supplier-payment-accounts`;
  private buscaTimer?: ReturnType<typeof setTimeout>;
  private buscaSeq = 0;
  /**
   * Cada apertura (y cada cierre) es una SESIÓN: lo que llega de una sesión vieja —una búsqueda, la OC desde la
   * que se abrió, la cuenta, la cotización que subía— se descarta. Revisión del PR: sin esto, una respuesta tardía
   * pintaba proveedores bajo una búsqueda vacía o metía la cotización de un pedido descartado en el siguiente.
   */
  private sesion = 0;
  /** Las OC y la cotización tienen además su propio turno: «Reintentar» o «Cambiar» dejan atrás la respuesta anterior. */
  private ocsSeq = 0;
  private cotSeq = 0;
  /** Lo abrió `abrir()`/`abrirParaOc()` con su contexto ya puesto: al mostrarse no se limpia otra vez. */
  private preparado = false;

  /** Abierto o cerrado: `[(visible)]` desde la pantalla, o `abrir()`. */
  readonly visible = model(false);
  readonly modo = input<ModoAnticipo>('pedir');
  /** El día con el que arranca al abrirse por `[(visible)]`: en `programar`, el día que se ve en el Calendario (fijo). */
  readonly fechaInicial = input<Date | null>(null);
  /** Al pedir: la pantalla que lo abrió relee lo suyo (y, en `programar`, lo pone en el día). */
  readonly pedido = output<AnticipoPedido>();

  readonly titulo = computed(() => (this.modo() === 'programar' ? 'Programar anticipo a proveedor' : 'Pedir anticipo a proveedor'));
  readonly accion = computed(() => (this.modo() === 'programar' ? 'Programar anticipo' : 'Pedir anticipo'));
  // `[PGP.155.2]` Ya no dice «a la cuenta de la cotización»: con una cuenta aprobada del catálogo, una del mismo
  // banco o efectivo, eso era falso (lo vio el recorrido visual). A dónde va el dinero lo dice «Se paga a».
  readonly ayuda = computed(() => (this.modo() === 'programar'
    ? 'Queda como un pago propio en el día que estás viendo: Tesorería lo prepara y se autoriza como cualquier pago.'
    : 'Aparece en el Calendario de pagos el día que elijas: ahí se agrega a ese día, Dirección lo autoriza y Tesorería lo paga.'));
  /** `[PGP.155.2]` El mismo texto que «Cuentas de pago» (`textoUltimoMovimiento`, una sola regla). */
  movimiento(o: AnticipoProveedorRow): string | null { return textoUltimoMovimiento(o.ultimo_movimiento); }

  readonly hoy = new Date();
  readonly busca = signal('');
  readonly opciones = signal<AnticipoProveedorRow[]>([]);
  /** Lo que dice la búsqueda: nada escrito, buscando, sin coincidencias, con resultados o falló (distintos). */
  readonly estadoBusqueda = signal<'nada' | 'buscando' | 'vacio' | 'hay' | 'error'>('nada');
  readonly prov = signal<AnticipoProveedorRow | null>(null);
  readonly monto = signal('');
  readonly dia = signal<Date | null>(null);
  readonly motivo = signal('');
  readonly guardando = signal(false);
  readonly errorGuardar = signal<string | null>(null);
  readonly confirmarDescarte = signal(false);
  readonly fechaLarga = computed(() => {
    const f = this.dia();
    return f ? f.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  });

  // ── `[PGP.127]` D11: las OC de Kepler del proveedor; se eligen una o varias de UNA sucursal ──
  readonly ocs = signal<AnticipoOcKeplerRow[]>([]);
  readonly ocsCargando = signal(false);
  readonly ocsError = signal(false);
  readonly ocsSel = signal<ReadonlySet<string>>(new Set());
  readonly llaveOc = llaveOcKepler;
  readonly ocsElegidas = computed(() => { const sel = this.ocsSel(); return this.ocs().filter((o) => sel.has(llaveOcKepler(o))); });
  /** La sucursal sale de la OC: ya no se elige aparte (el anticipo sólo se aplica en la sucursal de sus facturas). */
  readonly sucursal = computed<string | null>(() => this.ocsElegidas()[0]?.sucursal ?? null);
  readonly sucursales = computed(() => new Set(this.ocs().map((o) => o.sucursal)).size);
  readonly tope = computed(() => topeDeOcs(this.ocsElegidas()));
  /** «la OC 0007411» o «las 2 OC», para decir de dónde sale el importe. */
  readonly ocsTexto = computed(() => { const o = this.ocsElegidas(); return o.length === 1 ? `la OC ${o[0].folio}` : `las ${o.length} OC`; });

  // ── `[PGP.155]` El importe se PROPONE: todo lo que queda de la OC (100 %, lo normal en VUMERSOFT), un porcentaje
  // del total de las OC elegidas, o uno a mano. Con OC elegida no hay que teclear nada. ──
  readonly modoImporte = signal<ModoImporteAnticipo>('todo');
  readonly porcentaje = signal('');
  /** El importe que se manda: el sugerido, o el tecleado en «Otro importe». `null` = todavía no hay. */
  readonly importe = computed<number | null>(() => {
    const modo = this.modoImporte(), tope = this.tope(), porcentaje = this.porcentaje(), leido = leerPesos(this.monto());
    return importeSugeridoAnticipo({ modo, tope, porcentaje, importe: leido.pesos ?? null });
  });
  /** Por qué el modo elegido todavía no da importe (null = sí da, o lo dice la regla común). */
  private faltaImporte(): string | null {
    const modo = this.modoImporte();
    if (modo === 'importe') return leerPesos(this.monto()).error ?? null;
    if (this.importe() != null) return null;
    if (modo === 'todo') return 'Esa orden ya no tiene saldo para anticipar: elige otra.';
    return this.porcentaje().trim() ? 'El porcentaje va de 0 a 100.' : 'Escribe qué porcentaje de la OC se anticipa.';
  }
  ocMarcada(o: AnticipoOcKeplerRow): boolean { return this.ocsSel().has(llaveOcKepler(o)); }
  /** Elegida una, las de otra sucursal se apagan (poka-yoke: el error no se deja cometer). */
  ocBloqueada(o: AnticipoOcKeplerRow): boolean { const s = this.sucursal(); return !!s && s !== o.sucursal; }
  alternarOc(o: AnticipoOcKeplerRow, marcar: boolean): void {
    const sel = new Set(this.ocsSel());
    if (marcar) sel.add(llaveOcKepler(o)); else sel.delete(llaveOcKepler(o));
    this.ocsSel.set(sel);
  }
  /** Lo ya pedido sobre ESA OC (los pedidos que la incluyen). */
  pedidoSobre(o: AnticipoOcKeplerRow): number { return o.pedidos.reduce((s, p) => s + Number(p.monto), 0); }

  // ── `[PGP.127]` D10: la cotización se sube al elegirla; el pedido la cita por su llave ──
  readonly cot = signal<{ key: string; kind: 'pdf' | 'image'; nombre: string } | null>(null);
  readonly cotSubiendo = signal(false);
  readonly cotError = signal<string | null>(null);

  // ── `[PGP.127]` D12: a qué cuenta se paga ──
  readonly cuentas = signal<CuentaCatalogo[]>([]);
  readonly ctaTipo = signal<'aprobada' | 'nueva' | 'nueva_cuenta' | 'efectivo'>('nueva');
  readonly cuentaId = signal<string | null>(null);
  readonly clabe = signal('');
  /** `[PGP.155]` El número de cuenta nuevo (mismo banco, sin CLABE). */
  readonly cuentaNum = signal('');
  readonly banco = signal('');
  readonly cuentaOpciones = computed(() => this.cuentas().map((c) => ({
    label: `${cuentaCortaAnticipo({ clabe: c.clabe ? digitosClabe(c.clabe) : null, numero: digitosClabe(c.account_number) || null, banco: c.bank_name })}${c.alias ? ` (${c.alias})` : ''}`,
    value: c.id,
  })));
  /** `[PGP.155]` La cuenta aprobada elegida, si no tiene CLABE: se paga entre cuentas del mismo banco. */
  readonly cuentaSinClabe = computed<CuentaCatalogo | null>(() => {
    const id = this.cuentaId(), tipo = this.ctaTipo();
    const c = this.cuentas().find((x) => x.id === id);
    return tipo === 'aprobada' && c && digitosClabe(c.clabe).length !== 18 ? c : null;
  });
  readonly cuenta = computed<CuentaDelAnticipo | null>(() => {
    const t = this.ctaTipo(), id = this.cuentaId(), clabe = this.clabe(), num = this.cuentaNum(), banco = this.banco(), cs = this.cuentas();
    if (t === 'efectivo') return { tipo: 'efectivo' };
    // `[PGP.155.2]` Revisión independiente: con UNA cuenta aprobada la pantalla la muestra como texto (no hay
    // selector). Si la elección automática se saltó —la persona tocó «Efectivo» o escribió el banco antes de que
    // llegaran sus cuentas— `cuentaId` quedaba vacío y el botón no se encendía nunca. Con una sola, es ésa.
    const unica = cs.length === 1 ? cs[0].id : null;
    if (t === 'aprobada') return (id ?? unica) ? { tipo: 'aprobada', account_id: (id ?? unica)! } : null;
    if (t === 'nueva_cuenta') return { tipo: 'nueva_cuenta', cuenta: digitosClabe(num), banco: banco.trim() };
    return { tipo: 'nueva', clabe: digitosClabe(clabe), banco: banco.trim() };
  });

  /** `[PGP.138]` Hay algo capturado que se perdería al cerrar. */
  readonly sucio = computed(() => !!this.prov() || !!this.busca().trim() || !!this.monto().trim() || !!this.porcentaje().trim() || !!this.motivo().trim()
    || !!this.cot() || !!this.clabe().trim() || !!this.cuentaNum().trim());

  /** Por qué todavía no se puede pedir: la MISMA regla que el servidor (`faltaSolicitudAnticipo`). */
  readonly falta = computed<string | null>(() => {
    // Todas las señales se leen siempre (sin cortocircuito): el computed no se queda sin dependencias.
    const prov = this.prov(), suc = this.sucursal(), importe = this.importe(), motivo = this.motivo(), fecha = this.dia();
    const ocs = this.ocsElegidas(), cot = this.cot(), cuenta = this.cuenta(), subiendo = this.cotSubiendo();
    const sinOcs = this.ocsError(), leyendoOcs = this.ocsCargando(), faltaImporte = this.faltaImporte();
    // `[PGP.138]` Sin sus órdenes de compra no se sabe el tope: no se deja pedir (y no se lee como «sin OC»).
    if (prov && sinOcs) return 'Faltan sus órdenes de compra: reintenta leerlas antes de pedir (sin ellas no se sabe el tope).';
    if (prov && leyendoOcs) return 'Leyendo sus órdenes de compra…';
    // `[PGP.155]` El importe se dice en su turno (después de la OC): sin OC, la regla común pide la OC primero.
    if (prov && ocs.length && faltaImporte) return faltaImporte;
    if (subiendo) return 'Esperando a que suba la cotización…';
    return faltaSolicitudAnticipo({
      supplier_code: prov?.code ?? null, sucursal: suc, monto: importe ?? 0, motivo, fecha: this.ymd(fecha),
      ocs, cotizacion: !!cot, cuenta,
    });
  });

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.buscaTimer));
  }

  // ── `[PGP.143]` Abierto desde una OC de Compras (OC abiertas): proveedor y orden ya elegidos ──
  /** La OC desde la que se abrió; se queda mientras el diálogo esté abierto (lo dice arriba). */
  readonly deOc = signal<{ sucursal: string; folio: string } | null>(null);
  /** Se marca UNA vez, al leer las OC del proveedor; si la persona cambia de proveedor ya no aplica. */
  private ocPorMarcar: { sucursal: string; folio: string } | null = null;
  /** Por qué no quedó elegido el proveedor de esa OC (no es de mercancía activo, o no se pudo buscar). */
  readonly provAviso = signal<string | null>(null);
  /** Por qué esa OC no quedó marcada (no está entre las que aceptan anticipo). */
  readonly ocAviso = signal<string | null>(null);

  /** `[PGP.138]` Al mostrarse por `[(visible)]`, el formulario arranca limpio y con la fecha de la pantalla. */
  alAbrir(): void {
    if (this.preparado) { this.preparado = false; return; }
    this.limpiar();
  }
  /**
   * Todo en blanco. `dia` (YYYY-MM-DD), si viene, es el día que la persona está viendo; si no, `fechaInicial`.
   * Un día que ya pasó no: entonces, hoy.
   */
  limpiar(dia?: string | null): void {
    clearTimeout(this.buscaTimer);
    this.sesion++; this.buscaSeq++; this.cotSeq++;
    this.deOc.set(null); this.ocPorMarcar = null; this.provAviso.set(null); this.ocAviso.set(null);
    this.busca.set(''); this.opciones.set([]); this.estadoBusqueda.set('nada'); this.limpiarProveedor();
    this.monto.set(''); this.motivo.set(''); this.errorGuardar.set(null); this.confirmarDescarte.set(false);
    this.modoImporte.set('todo'); this.porcentaje.set('');
    this.cot.set(null); this.cotError.set(null); this.cotSubiendo.set(false);
    const hoy = this.ymd(new Date())!;
    const visto = dia !== undefined ? dia : this.ymd(this.fechaInicial());
    const [y, m, d] = diaInicialDelAnticipo(visto, hoy).split('-').map(Number);
    this.dia.set(new Date(y, m - 1, d));
  }
  /**
   * `[PGP.142]` Abre el diálogo en blanco. `dia` (YYYY-MM-DD) es el día que la persona está viendo: el anticipo
   * se pide para ése, salvo que ya haya pasado (entonces, hoy).
   */
  abrir(dia?: string | null): void {
    this.limpiar(dia ?? null);
    this.preparado = true;
    this.visible.set(true);
  }
  /** Cancelar, Esc: si hay algo capturado, pregunta antes de tirarlo (`[PGP.138]`). */
  pedirCerrar(): void {
    if (this.guardando()) return;
    if (this.sucio() && !this.confirmarDescarte()) { this.confirmarDescarte.set(true); return; }
    this.cerrar();
  }
  cerrar(): void {
    clearTimeout(this.buscaTimer);
    this.sesion++; this.buscaSeq++; this.ocsSeq++; this.cotSeq++;
    this.confirmarDescarte.set(false); this.preparado = false; this.visible.set(false);
  }

  /**
   * `[PGP.143]` Lo abre Compras desde una orden de compra de Kepler: el proveedor se busca por su CÓDIGO
   * exacto (no por nombre: dos razones sociales se parecen) y, al leer sus OC, queda marcada ésa. Si el
   * proveedor no recibe anticipo o la orden no se puede elegir, se DICE y la persona sigue a mano.
   */
  abrirParaOc(oc: { sucursal: string; folio: string; codigo: string | null; nombre: string | null }, dia?: string | null): void {
    this.abrir(dia);
    const ses = this.sesion;
    const sucursal = String(oc.sucursal ?? '').trim(), folio = String(oc.folio ?? '').trim();
    this.deOc.set({ sucursal, folio });
    this.ocPorMarcar = { sucursal, folio };
    const codigo = String(oc.codigo ?? '').trim().toUpperCase();
    if (!codigo) { this.provAviso.set(`La orden ${folio} no trae el código de su proveedor: búscalo por nombre.`); return; }
    this.http.get<AnticipoProveedorRow[]>(`${this.obligaciones}/anticipo/proveedores`, { params: { search: codigo } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (ses !== this.sesion || this.prov()) return;
        const p = (r ?? []).find((x) => String(x.code ?? '').trim().toUpperCase() === codigo);
        if (p) { this.elegirProveedor(p); return; }
        this.ocPorMarcar = null;
        this.provAviso.set(`${oc.nombre?.trim() || codigo} (${codigo}) no recibe anticipo en la Suite: no está en el catálogo como proveedor de mercancía activo.`);
      },
      error: () => { if (ses !== this.sesion) return; this.ocPorMarcar = null; this.provAviso.set('No se pudo buscar al proveedor de esta orden: búscalo por nombre.'); },
    });
  }

  /** `[PGP.127]` Lo que depende del proveedor se borra al cambiarlo: OC, cuentas y CLABE son suyos. */
  private limpiarProveedor(): void {
    this.ocsSeq++;
    this.prov.set(null); this.ocs.set([]); this.ocsSel.set(new Set()); this.ocsError.set(false); this.ocsCargando.set(false);
    this.cuentas.set([]); this.cuentaId.set(null); this.ctaTipo.set('nueva'); this.clabe.set(''); this.cuentaNum.set(''); this.banco.set('');
  }
  /** Cambiar de proveedor suelta la OC con que se abrió: ya no es de éste. */
  quitarProveedor(): void {
    this.ocPorMarcar = null; this.ocAviso.set(null); this.provAviso.set(null); this.limpiarProveedor();
    // Revisión del PR: el aviso «Sobre la orden de compra X» y la cotización eran del proveedor anterior. Con la
    // cotización de otro, la CLABE nueva iría a Dirección respaldada por el documento equivocado.
    this.deOc.set(null); this.cotSeq++; this.cot.set(null); this.cotError.set(null); this.cotSubiendo.set(false);
  }
  buscarProveedor(t: string): void {
    this.busca.set(t);
    clearTimeout(this.buscaTimer);
    if (!t.trim()) { this.buscaSeq++; this.opciones.set([]); this.estadoBusqueda.set('nada'); return; }
    this.estadoBusqueda.set('buscando');
    this.buscaTimer = setTimeout(() => this.buscarAhora(), 250);
  }
  /** `[PGP.138]` Busca ya (también «Reintentar»). Una respuesta vieja no pisa a la nueva. */
  buscarAhora(): void {
    const t = this.busca().trim();
    if (!t) return;
    const seq = ++this.buscaSeq;
    this.estadoBusqueda.set('buscando');
    this.http.get<AnticipoProveedorRow[]>(`${this.obligaciones}/anticipo/proveedores`, { params: { search: t } }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { if (seq !== this.buscaSeq) return; const xs = r ?? []; this.opciones.set(xs); this.estadoBusqueda.set(xs.length ? 'hay' : 'vacio'); },
        error: () => { if (seq !== this.buscaSeq) return; this.opciones.set([]); this.estadoBusqueda.set('error'); },
      });
  }
  elegirProveedor(p: AnticipoProveedorRow): void {
    this.limpiarProveedor();
    this.prov.set(p); this.opciones.set([]); this.estadoBusqueda.set('nada');
    this.cargarOcs(p);
    const ses = this.sesion;
    // `[PGP.127]` Sus cuentas APROBADAS: si tiene, se propone la favorita; si no, se captura la de la cotización.
    // `[PGP.155]` Con CLABE o, sin ella, con número de cuenta del mismo banco (VUMERSOFT: BBVA, 10 dígitos).
    this.http.get<CuentaCatalogo[]>(`${this.urlCuentas}/by-supplier/${p.id}`)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          if (ses !== this.sesion || this.prov()?.id !== p.id) return;
          const con = (r ?? []).filter((c) => digitosClabe(c.clabe).length === 18 || numeroDeCuentaValido(digitosClabe(c.account_number)));
          this.cuentas.set(con);
          // Revisión del PR: si ya eligió «Efectivo» o empezó a escribir la CLABE, la respuesta no se lo cambia.
          if (con.length && this.ctaTipo() === 'nueva' && !this.clabe().trim() && !this.cuentaNum().trim() && !this.banco().trim()) { this.ctaTipo.set('aprobada'); this.cuentaId.set((con.find((c) => c.es_favorita) ?? con[0]).id); }
        },
        // Sin poder leerlas, se captura la CLABE: si ya estaba aprobada, el servidor la reconoce y no la pide otra vez.
        error: () => this.cuentas.set([]),
      });
  }
  cargarOcs(p: AnticipoProveedorRow): void {
    const seq = ++this.ocsSeq;
    this.ocsSel.set(new Set()); this.ocs.set([]); this.ocsCargando.set(true); this.ocsError.set(false);
    this.http.get<AnticipoOcKeplerRow[]>(`${this.obligaciones}/anticipo/ocs`, { params: { supplier_id: p.id } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (seq !== this.ocsSeq || this.prov()?.id !== p.id) return;
        const ocs = (r ?? []).map((o) => ({ ...o, total: Number(o.total), pedidos: (o.pedidos ?? []).map((x) => ({ id: x.id, monto: Number(x.monto) })) }));
        this.ocs.set(ocs);
        const pedida = this.ocPorMarcar;
        this.ocPorMarcar = null;
        if (pedida) {
          // `[PGP.143]` Abierto desde una OC: se marca ésa (sucursal + folio). Si no está, se dice por qué.
          const o = ocs.find((x) => x.sucursal === pedida.sucursal && String(x.folio).trim() === pedida.folio);
          if (o) this.ocsSel.set(new Set([llaveOcKepler(o)]));
          else this.ocAviso.set(`La OC ${pedida.folio} no está entre las que aceptan anticipo: sólo las pendientes o recibidas en parte de los últimos 180 días. Elige otra o revísala en Kepler.`);
        } else if (ocs.length === 1) {
          // Con una sola OC no hay nada que decidir: se marca.
          this.ocsSel.set(new Set([llaveOcKepler(ocs[0])]));
        }
        this.ocsCargando.set(false);
      },
      error: () => { if (seq !== this.ocsSeq || this.prov()?.id !== p.id) return; this.ocs.set([]); this.ocsError.set(true); this.ocsCargando.set(false); },
    });
  }

  /** `[PGP.127]` Sube la cotización en cuanto se elige: al pedir sólo viaja su llave (el pedido no carga 10 MB). */
  elegirCotizacion(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    this.cotError.set(null);
    if (!/^(application\/pdf|image\/)/i.test(f.type)) { this.cotError.set('La cotización tiene que ser PDF o foto.'); return; }
    if (f.size > 10 * 1024 * 1024) { this.cotError.set('La cotización pesa más de 10 MB: escanéala más ligera o mándala en foto.'); return; }
    const seq = ++this.cotSeq;
    this.cotSubiendo.set(true);
    const lector = new FileReader();
    lector.onerror = () => { if (seq !== this.cotSeq) return; this.cotSubiendo.set(false); this.cotError.set('No se pudo leer el archivo.'); };
    lector.onload = () => {
      if (seq !== this.cotSeq) return;
      this.http.post<{ key: string; kind: 'pdf' | 'image' }>(`${this.obligaciones}/anticipo/cotizacion`, { file_base64: String(lector.result ?? '') })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (r) => { if (seq !== this.cotSeq) return; this.cotSubiendo.set(false); this.cot.set({ ...r, nombre: f.name }); },
          error: (e) => { if (seq !== this.cotSeq) return; this.cotSubiendo.set(false); this.cotError.set(e?.error?.message || 'No se pudo subir la cotización. Intenta de nuevo.'); },
        });
    };
    lector.readAsDataURL(f);
  }
  quitarCotizacion(): void { this.cotSeq++; this.cot.set(null); this.cotError.set(null); this.cotSubiendo.set(false); }

  /**
   * El botón se apaga en el primer clic; el servidor vuelve a leer las OC de Kepler, el tope y la cuenta. Si lo
   * rechaza, el diálogo sigue abierto y lo dice ahí (`[PGP.138]`): lo capturado no se pierde.
   */
  guardar(): void {
    if (this.falta() || this.guardando()) return;
    const prov = this.prov();
    const cot = this.cot();
    const suc = this.sucursal();
    // `[PGP.155]` El sugerido (100 % o porcentaje) o el tecleado: el mismo número que la pantalla enseña.
    const pesos = this.importe();
    if (!prov || !cot || !suc || pesos == null) return;
    const fecha = this.ymd(this.dia()) ?? this.ymd(new Date())!;
    const body: AnticipoSolicitudBody = {
      supplier_id: prov.id, sucursal: suc, monto: pesos, motivo: this.motivo().trim(), fecha,
      kepler_ocs: this.ocsElegidas().map((o) => ({ sucursal: o.sucursal, serie: o.serie, folio: o.folio })),
      cotizacion: { key: cot.key, kind: cot.kind }, cuenta: this.cuenta(),
    };
    this.guardando.set(true);
    this.errorGuardar.set(null);
    this.http.post<Omit<AnticipoPedido, 'proveedor' | 'fecha'>>(`${this.obligaciones}/anticipo`, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.cerrar();
        const monto = Number(r.monto);
        const cta = r.cuenta === 'pedida' ? ' La cuenta quedó pedida de alta: Dirección la aprueba en Cuentas de pago antes del pago.'
          : r.cuenta === 'ya_pedida' ? ' Esa cuenta ya esperaba la aprobación de Dirección: no se pidió otra vez.' : '';
        if (this.modo() === 'pedir') {
          this.toast.add({ severity: 'success', summary: 'Anticipo pedido', life: 9000,
            detail: `${prov.name}: ${this.pesos(monto)} (${r.concepto}). Aparece en el Calendario de pagos el ${this.fecha(fecha)}.${cta}` });
        } else if (cta) {
          // En `programar` la pantalla dice dónde quedó; aquí sólo lo que falta de la cuenta.
          this.toast.add({ severity: 'info', summary: 'Falta aprobar la cuenta', life: 12000, detail: `${prov.name}:${cta}` });
        }
        this.pedido.emit({ ...r, monto, proveedor: prov.name, fecha });
      },
      error: (e: { error?: { message?: string } }) => {
        this.guardando.set(false);
        this.errorGuardar.set(e?.error?.message || 'intenta de nuevo en un momento.');
      },
    });
  }

  private ymd(d: Date | null): string | null {
    if (!d || Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  fecha(ymd: string): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1];
    return `${d}-${mes}${y !== new Date().getFullYear() ? `-${y}` : ''}`;
  }
  pesos(v: number | string | null | undefined): string { return money(Number(v ?? 0)); }
}
