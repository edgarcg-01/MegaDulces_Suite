import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, effect, inject, signal } from '@angular/core';
import type { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';
import { TableModule } from 'primeng/table';
import { firstValueFrom } from 'rxjs';
import { warehouseName } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SucursalPickerComponent } from '../../../shared/components/sucursal-picker/sucursal-picker.component';
import { TiendaArqueoComponent } from './tienda-arqueo.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { HalladoCatalogo, ProductoPrecio, SucursalVerificador, VerificadorService } from '../verificador.service';
import {
  EscalonCaja, LineaCaja, MOTIVOS_QUITAR, errorEfectivo, esCorreccionInmediata, importeRenglon, leerComando,
  leerImporte, pesos, precioRenglon, r2, totalesCaja,
} from '../caja-motor';

/**
 * [PDV.31] Caja de mostrador — MODO PRÁCTICA.
 *
 * Una sola pantalla para vender, buscar, cobrar y pedir autorización, operada sólo con teclado
 * (FASE_PDV_ANEXO_CAJERO.md). Precio real de Kepler vía el verificador de la sucursal.
 * Las 5 preguntas (diseno §0b) están contestadas en ese anexo, §10.
 *
 * Lo que NO hace todavía, y lo dice en pantalla: no guarda el ticket, no imprime, no abre el cajón,
 * no lo manda a Kepler (eso espera D0 y D1 de la fase) y no aplica promociones por cantidad (el
 * precio es lista + escalera; el motor único es PDV.11). El PIN del supervisor no se valida contra el
 * servidor: la autorización real es PDV.23.
 *
 * Primario = el total (al cobrar: lo que falta; al terminar: el cambio) · secundario = el ticket ·
 * terciario = códigos, impuestos y teclas.
 */
type Estado = 'venta' | 'cobro' | 'cobrado';
interface Pago { forma: 'Efectivo' | 'Tarjeta' | 'Transferencia'; recibido: number; aplicado: number; cambio: number }
interface Aviso { tipo: 'error' | 'aviso' | 'ok'; texto: string }
interface Autorizacion { accion: 'quitar' | 'bajar' | 'cancelar'; indice: number; motivo: number }

const CANAL_CLIENTE = 'md-caja-cliente';

@Component({
  selector: 'app-tienda-caja',
  standalone: true,
  imports: [TableModule, FreshnessPillComponent, LoadStateComponent, SucursalPickerComponent, TiendaArqueoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="cj">
    <header class="cj-head">
      <h1 class="cj-titulo">Caja</h1>
      <app-sucursal-picker [(valor)]="sucursal" placeholder="Elige la sucursal" etiqueta="Sucursal de la caja" />
      @if (datosAl(); as d) { <app-freshness-pill measures="data" [since]="d" label="Precios de Kepler" [staleAfterSec]="900" /> }
      <span class="cj-practica" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i>
        Modo práctica: no guarda, no imprime, no cobra ni manda a Kepler. Sin promociones por cantidad.</span>
      <span class="cj-acciones">
        <button type="button" class="cj-hb" tabindex="-1" (click)="abrirVerificador()">Verificar precio <kbd>F6</kbd></button>
        @if (puedeArqueo) { <button type="button" class="cj-hb" tabindex="-1" [class.cj-hb-on]="arqueo()" (click)="irArqueo()">Mi arqueo <kbd>F7</kbd></button> }
        <button type="button" class="cj-hb" tabindex="-1" (click)="abrirCliente()">Pantalla del cliente</button>
      </span>
    </header>

    <app-load-state [loading]="cargando()" [error]="errorCarga()" [isEmpty]="!sucursal()" emptyIcon="pi-building"
                    emptyTitle="Elige la sucursal de esta caja" emptyHint="Los precios y la búsqueda salen del catálogo de esa sucursal."
                    (retry)="prepararSucursal()">
    @if (arqueo()) {
    <section class="cj-arq" aria-label="Mi arqueo">
      <div class="cj-arq-barra">
        <span class="cj-sub">Arqueo ciego de tu caja, el mismo de Arqueo de Tienda: lo que entregues aquí queda guardado.</span>
        <button type="button" class="cj-hb" (click)="cerrarArqueo()">{{ confirmarSalida() ? 'Salir sin entregar el conteo' : 'Volver a la caja' }}</button>
      </div>
      @if (confirmarSalida()) { <div class="cj-aviso cj-warn" role="status">Tu conteo no está entregado. Entrégalo, o presiona otra vez para salir y perderlo.</div> }
      @defer (on immediate) { <app-tienda-arqueo #arq /> } @loading (minimum 200ms) { <div class="cj-sub">Cargando el arqueo…</div> }
    </section>
    } @else {
    <main class="cj-main">
      <section class="cj-trabajo" aria-label="Ticket en curso">
        <div class="cj-cmd">
          <label class="cj-cmd-caja" for="cj-cmd">
            <span class="cj-modo">{{ modo() }}</span>
            <input #cmd id="cj-cmd" class="cj-cmd-input" autocomplete="off" spellcheck="false"
                   [type]="auth()?.motivo ? 'password' : 'text'" [placeholder]="placeholder()"
                   [value]="texto()" (input)="alTeclear($any($event.target).value)" (blur)="reenfocar()" />
          </label>
          @if (resultados().length || buscandoTexto()) {
            <ul class="cj-res" role="listbox" aria-label="Resultados de la búsqueda">
              @for (h of resultados(); track h.codigo; let i = $index) {
                <li role="option" [attr.aria-selected]="i === hit()" class="cj-res-i" [class.cj-on]="i === hit()" (mousedown)="elegir(i, $event)">
                  <span><b>{{ h.nombre }}</b> <span class="cj-sub mono">{{ h.codigo }}</span></span>
                  <span class="cj-sub num">{{ unidadesTexto(h) }}</span>
                </li>
              } @empty { <li class="cj-res-i cj-sub">Buscando en el catálogo de la sucursal…</li> }
            </ul>
          }
        </div>
        @if (aviso(); as a) { <div [class]="'cj-aviso ' + claseAviso(a.tipo)" role="status">{{ a.texto }}</div> }

        <div class="cj-ticket">
          <div class="cj-cap"><b>Ticket {{ folio() }}</b><span>Público en general</span><span class="cj-der">{{ tot().renglones }} renglones</span></div>
          <p-table [value]="lineas()" styleClass="surf-table surf-table--plain surf-table--sticky" [scrollable]="true" scrollHeight="flex">
            <ng-template #header>
              <tr><th>Producto</th><th>Present.</th><th class="comm-num">Cantidad</th><th class="comm-num">Precio</th><th class="comm-num">Importe</th></tr>
            </ng-template>
            <ng-template #body let-l let-i="rowIndex">
              <tr [class.cj-sel]="i === sel()" [class.cj-quitado]="!!l.quitado" [class.cj-flash]="i === destello()" (mousedown)="seleccionar(i, $event)">
                <td>
                  <div class="cj-desc">{{ l.nombre }}</div>
                  <div class="cj-sub"><span class="mono">{{ l.codigo }}</span> · {{ tasaTexto(l) }}</div>
                  @if (empujon(l); as e) { <div class="cj-empujon">{{ e }}</div> }
                  @if (l.quitado) { <div class="cj-sub">Quitado · {{ l.quitado.motivo }} · {{ l.quitado.quien }}</div> }
                </td>
                <td><span class="cj-u">{{ l.unidad }}</span>
                  @if (i === sel() && l.presentaciones.length > 1 && !l.quitado) { <div class="cj-sub mono">F4 cambia</div> }</td>
                <td class="comm-num cj-cant">{{ l.granel ? l.cantidad.toFixed(3) + ' kg' : l.cantidad }}</td>
                <td class="comm-num">{{ dinero(precio(l)) }}
                  @if (!l.quitado && precio(l) < l.lista) { <div class="cj-mayoreo">mayoreo · antes {{ dinero(l.lista) }}</div> }</td>
                <td class="comm-num cj-imp">{{ dinero(importe(l)) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="cj-vacio">Caja lista. Escanea el primer producto.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </section>

      <aside class="cj-panel" aria-live="polite">
        @if (auth(); as a) {
          <div class="cj-box cj-box-act">
            <span class="cj-lbl">Pide supervisor</span>
            <div class="cj-h2">{{ authTitulo() }}</div>
            <div class="cj-sub">El total pasa de {{ dinero(tot().total) }} a {{ dinero(authTotalDespues()) }}. Nada se borra: queda tachado.</div>
            @for (m of motivos; track m; let i = $index) {
              <div class="cj-opt" [class.cj-opt-on]="a.motivo === i + 1"><kbd>{{ i + 1 }}</kbd>{{ m }}</div>
            }
            <div class="cj-sub">{{ a.motivo ? 'El supervisor teclea su PIN arriba y Enter. En práctica el PIN no se valida todavía.' : 'Elige el motivo con su número.' }}</div>
          </div>
        } @else if (verificando()) {
          <div class="cj-box cj-box-act">
            <span class="cj-lbl">Verificador de precios · no se agrega al ticket</span>
            @if (verificado(); as p) {
              <div class="cj-h2">{{ p.nombre }}</div>
              <div class="cj-sub"><span class="mono">{{ p.codigo }}</span> · {{ tasaProducto(p) }}</div>
              @for (u of p.unidades; track u.u) {
                <div class="cj-fila"><b>{{ u.u }}</b><span class="cj-grande">{{ dinero(u.precio_con_iva) }}</span></div>
              }
              @for (t of p.mayoreo; track $index) { <div class="cj-mayoreo">Desde {{ t.desde }} {{ t.palabra }}: {{ dinero(t.precio_con_iva) }} c/u</div> }
            } @else { <div class="cj-h2">Escanea o escribe el producto que pregunta el cliente.</div> }
          </div>
        } @else if (estado() === 'venta') {
          <div class="cj-box">
            <span class="cj-lbl">Total</span>
            <div class="cj-total">{{ dinero(tot().total) }}</div>
            <div class="cj-sub">{{ tot().articulos }} artículos · IVA {{ dinero(tot().iva) }} e IEPS {{ dinero(tot().ieps) }} incluidos</div>
            @if (tot().ahorro > 0) { <div class="cj-ahorro">Ahorro por mayoreo {{ dinero(tot().ahorro) }}</div> }
          </div>
          <button type="button" class="cj-cta" tabindex="-1" [disabled]="!tot().renglones" (click)="cobrar('')">Cobrar <kbd>F12</kbd></button>
          @if (lineaSel(); as l) {
            <div class="cj-box">
              <span class="cj-lbl">{{ esUltimo() ? 'Último escaneo' : 'Renglón seleccionado' }}</span>
              <div class="cj-h3">{{ l.quitado ? 'Quitado: ' : '' }}{{ l.nombre }} · {{ l.granel ? l.cantidad.toFixed(3) + ' kg' : l.cantidad + ' ' + l.unidad }} · {{ dinero(importe(l)) }}</div>
              @if (!l.quitado) {
                <div class="cj-teclas">
                  @if (!l.granel) { <span><kbd>+</kbd> <kbd>-</kbd> cantidad</span> } @else { <span>Peso de báscula</span> }
                  @if (l.presentaciones.length > 1) { <span><kbd>F4</kbd> presentación</span> }
                  <span><kbd>F10</kbd> quitar</span><span><kbd>↑</kbd><kbd>↓</kbd> otro renglón</span>
                </div>
              }
            </div>
          }
        } @else if (estado() === 'cobro') {
          <div class="cj-box">
            <span class="cj-lbl">Por cobrar</span>
            <div class="cj-total">{{ dinero(saldo()) }}</div>
            <div class="cj-fila"><span>Recibido</span><span class="cj-grande">{{ recibidoVivo() === null ? '—' : dinero(recibidoVivo()!) }}</span></div>
            <div class="cj-fila"><span>Cambio</span><span class="cj-grande">{{ cambioVivo() }}</span></div>
          </div>
          @if (pagos().length) {
            <div class="cj-box"><span class="cj-lbl">Pagos aplicados</span>
              @for (p of pagos(); track $index) { <div class="cj-fila"><span>{{ p.forma }}{{ p.cambio ? ' · cambio ' + dinero(p.cambio) : '' }}</span><span class="num">{{ dinero(p.aplicado) }}</span></div> }
            </div>
          }
        } @else {
          <div class="cj-box cj-box-ok">
            <span class="cj-lbl">{{ hayEfectivo() ? 'Cambio' : 'Cobrado' }}</span>
            <div class="cj-total cj-cambio">{{ dinero(cambioTotal()) }}</div>
            <div class="cj-sub">Recibido {{ dinero(recibidoTotal()) }} · total {{ dinero(tot().total) }} · {{ formasTexto() }}</div>
          </div>
          <div class="cj-aviso cj-ok">Ticket {{ folio() }} cobrado en práctica: no se imprimió ni se mandó a Kepler. Escanea el siguiente producto para empezar otro ticket.</div>
        }
      </aside>
    </main>
    }
    </app-load-state>

    <footer class="cj-pie" aria-label="Teclas de este momento">
      @if (arqueo()) { <span>Captura tu conteo con el teclado y el ratón; la caja no toma teclas mientras tanto</span> }
      @else if (auth()) { <span><kbd>1</kbd>–<kbd>4</kbd> motivo</span><span>PIN y <kbd>Enter</kbd></span><span><kbd>Esc</kbd> no hacerlo</span> }
      @else if (verificando()) { <span>Escanea o escribe y <kbd>Enter</kbd></span><span><kbd>Esc</kbd> volver a vender</span> }
      @else if (estado() === 'venta') { <span><kbd>Enter</kbd> agregar</span><span><kbd>5*</kbd>código cantidad</span><span>letras o <kbd>F9</kbd> buscar</span><span><kbd>Ctrl</kbd>+<kbd>Supr</kbd> cancelar ticket</span><span><b>250 <kbd>F12</kbd></b> cobra $250 en efectivo</span> }
      @else if (estado() === 'cobro') { <span>Teclea lo que te dieron</span><span><b><kbd>Enter</kbd> efectivo</b> (vacío = exacto)</span><span><kbd>F2</kbd> tarjeta</span><span><kbd>F3</kbd> transferencia</span><span><kbd>Esc</kbd> volver</span> }
      @else { <span>Escanea o teclea para el siguiente cliente</span> }
    </footer>
  </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .cj { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--surface-ground); color: var(--text-main); font-size: var(--fs-lg); }
    .cj-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); padding: var(--sp-2) var(--sp-4); background: var(--card-bg); border-bottom: 1px solid var(--border-color); }
    .cj-titulo { margin: 0; font-size: var(--fs-h3); font-weight: 700; }
    .cj-practica { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-radius: var(--r-pill); padding: var(--sp-1) var(--sp-3); }
    .cj-acciones { margin-left: auto; display: inline-flex; gap: var(--sp-2); }
    .cj-hb { display: inline-flex; align-items: center; gap: var(--sp-2); height: 2.25rem; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
    .cj-hb:hover { background: var(--surface-hover-bg); }
    .cj-hb-on { border-color: var(--action); color: var(--action); }
    .cj-arq { flex: 1; min-height: 0; overflow: auto; padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .cj-arq-barra { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .cj-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(20rem, 27rem); gap: var(--sp-4); padding: var(--sp-4); }
    @media (max-width: 60rem) { .cj-main { grid-template-columns: 1fr; } }
    .cj-trabajo { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .cj-cmd { position: relative; }
    .cj-cmd-caja { display: flex; align-items: center; gap: var(--sp-3); height: 4.25rem; padding: 0 var(--sp-4); background: var(--card-bg); border: 2px solid var(--action); border-radius: var(--r-lg); }
    .cj-modo { min-width: 5.5rem; font-size: var(--fs-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--action); }
    .cj-cmd-input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-main); font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-h2); }
    .cj-cmd-input:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .cj-cmd-input::placeholder { font-family: inherit; font-size: var(--fs-lg); color: var(--text-faint); }
    .cj-res { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + var(--sp-1)); margin: 0; padding: 0; list-style: none; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); box-shadow: var(--shadow-float); overflow: hidden; }
    .cj-res-i { display: flex; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border-color); cursor: pointer; }
    .cj-on { background: var(--surface-selected-bg); box-shadow: inset 3px 0 0 var(--action); }
    .cj-aviso { border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); font-weight: 600; }
    .cj-error { background: var(--bad-soft-bg); color: var(--bad-fg); border: 2px solid var(--bad-border); }
    .cj-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .cj-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .cj-ticket { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); overflow: hidden; }
    .cj-cap { display: flex; gap: var(--sp-3); align-items: baseline; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); font-size: var(--fs-sm); color: var(--text-muted); }
    .cj-cap b { color: var(--text-main); font-size: var(--fs-body); }
    .cj-der { margin-left: auto; }
    .cj-sel td { background: var(--surface-selected-bg); }
    .cj-sel td:first-child { box-shadow: inset 4px 0 0 var(--action); }
    .cj-flash td { animation: cj-fl .3s ease-out; }
    @keyframes cj-fl { from { opacity: .45; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .cj-flash td { animation: none; } }
    .cj-quitado td { color: var(--text-faint); }
    .cj-quitado .cj-desc { text-decoration: line-through; }
    .cj-desc { font-weight: 600; font-size: var(--fs-lg); }
    .cj-sub { font-size: var(--fs-sm); color: var(--text-faint); }
    .cj-empujon { font-size: var(--fs-sm); font-weight: 700; color: var(--action); }
    .cj-mayoreo, .cj-ahorro { font-size: var(--fs-sm); font-weight: 600; color: var(--ok-fg); }
    .cj-ahorro { font-size: var(--fs-body); }
    .cj-u { display: inline-block; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-xs); font-weight: 600; padding: 0 var(--sp-2); border-radius: var(--r-sm); background: var(--text-main); color: var(--card-bg); }
    .cj-cant { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; font-size: var(--fs-lg); white-space: nowrap; }
    .cj-imp { font-weight: 700; font-size: var(--fs-lg); }
    .cj-vacio { padding: var(--sp-6) var(--sp-3); color: var(--text-faint); }
    .cj-panel { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .cj-box { display: flex; flex-direction: column; gap: var(--sp-1); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-4); }
    .cj-box-act { border: 2px solid var(--action); }
    .cj-box-ok { border: 2px solid var(--ok-border); }
    .cj-lbl { font-size: var(--fs-xs); letter-spacing: .06em; text-transform: uppercase; font-weight: 600; color: var(--text-faint); }
    .cj-total { font-size: var(--text-display-xl); font-weight: 700; line-height: 1.05; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .cj-grande { font-size: var(--fs-h2); font-weight: 700; font-variant-numeric: tabular-nums; }
    .cj-h2 { font-size: var(--fs-h3); font-weight: 700; }
    .cj-h3 { font-size: var(--fs-lg); font-weight: 600; }
    .cj-fila { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); }
    .cj-teclas, .cj-pie { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); }
    .cj-opt { display: flex; gap: var(--sp-2); align-items: center; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .cj-opt-on { border: 2px solid var(--text-main); font-weight: 700; }
    .cj-cta { height: 4rem; width: 100%; border: 0; border-radius: var(--r-lg); background: var(--action); color: var(--action-ink); font: inherit; font-size: var(--fs-h3); font-weight: 700; display: flex; align-items: center; justify-content: center; gap: var(--sp-3); cursor: pointer; }
    .cj-cta:disabled { opacity: .4; cursor: not-allowed; }
    .cj-cta:focus-visible, .cj-hb:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .cj-pie { padding: var(--sp-2) var(--sp-4); background: var(--card-bg); border-top: 1px solid var(--border-color); }
    kbd { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-xs); font-weight: 600; border: 1px solid var(--border-color); border-bottom-width: 2px; border-radius: var(--r-sm); padding: 0 var(--sp-1); background: var(--card-bg); color: var(--text-main); }
    .cj-cta kbd { background: transparent; color: var(--action-ink); border-color: var(--action-ink); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .num { font-variant-numeric: tabular-nums; }
  `],
})
export class TiendaCajaComponent implements OnDestroy {
  private readonly svc = inject(VerificadorService);
  @ViewChild('cmd') private cmd?: ElementRef<HTMLInputElement>;

  readonly motivos = MOTIVOS_QUITAR;
  /** El arqueo vive DENTRO de la caja (una sola interfaz): el mismo componente real de /tienda/arqueo. */
  readonly puedeArqueo = [Permission.STORE_ARQUEO_VER, Permission.STORE_ARQUEO_CAPTURAR, Permission.STORE_ARQUEO_SIN_CAJA_CAPTURAR].some((p) => inject(PermissionsService).has(p));
  readonly arqueo = signal(false);
  readonly confirmarSalida = signal(false);
  @ViewChild('arq') private arqueoCmp?: HasUnsavedChanges;
  readonly dinero = pesos;

  // ── Sucursal y catálogo ──
  readonly sucursal = signal<string | string[] | null>(null);
  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly cargando = signal(false);
  readonly errorCarga = signal<string | null>(null);
  private readonly suc = computed(() => { const s = this.sucursal(); return typeof s === 'string' ? s : null; });
  readonly datosAl = computed(() => this.sucursales().find((s) => s.codigo === this.suc())?.datos_al ?? null);

  // ── Ticket ──
  readonly lineas = signal<LineaCaja[]>([]);
  readonly sel = signal(-1);
  readonly destello = signal(-1);
  private readonly ultimo = signal<{ indice: number; en: number } | null>(null);
  readonly estado = signal<Estado>('venta');
  readonly pagos = signal<Pago[]>([]);
  private numero = 1;
  readonly folio = signal(this.folioDe(1));

  // ── Línea de comandos y paneles ──
  readonly texto = signal('');
  readonly aviso = signal<Aviso | null>(null);
  readonly resultados = signal<HalladoCatalogo[]>([]);
  readonly buscandoTexto = signal(false);
  readonly hit = signal(0);
  readonly auth = signal<Autorizacion | null>(null);
  readonly verificando = signal(false);
  readonly verificado = signal<ProductoPrecio | null>(null);
  private teclas: number[] = [];
  private busquedaId = 0;
  private readonly canal = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CANAL_CLIENTE) : null;

  readonly tot = computed(() => totalesCaja(this.lineas()));
  readonly lineaSel = computed(() => this.lineas()[this.sel()] ?? null);
  readonly esUltimo = computed(() => this.ultimo()?.indice === this.sel());
  readonly saldo = computed(() => r2(Math.max(this.tot().total - this.pagos().reduce((a, p) => a + p.aplicado, 0), 0)));
  readonly recibidoVivo = computed(() => (this.estado() === 'cobro' && this.texto() ? leerImporte(this.texto()) : null));
  readonly cambioVivo = computed(() => {
    const r = this.recibidoVivo();
    if (r === null) return '—';
    return r >= this.saldo() ? pesos(r - this.saldo()) : 'falta ' + pesos(this.saldo() - r);
  });
  readonly cambioTotal = computed(() => r2(this.pagos().reduce((a, p) => a + p.cambio, 0)));
  readonly recibidoTotal = computed(() => r2(this.pagos().reduce((a, p) => a + p.recibido, 0)));
  readonly hayEfectivo = computed(() => this.pagos().some((p) => p.forma === 'Efectivo'));
  readonly formasTexto = computed(() => [...new Set(this.pagos().map((p) => p.forma.toLowerCase()))].join(' + '));

  readonly modo = computed(() => {
    const a = this.auth();
    if (a) return a.motivo ? 'PIN' : 'Motivo';
    if (this.verificando()) return 'Verificar';
    if (this.estado() === 'cobro') return 'Recibido $';
    if (this.estado() === 'cobrado') return 'Siguiente';
    return /[a-zñ]/i.test(this.texto()) ? 'Buscar' : 'Escanear';
  });
  readonly placeholder = computed(() => {
    const a = this.auth();
    if (a) return a.motivo ? 'PIN del supervisor' : 'Elige 1, 2, 3 o 4';
    if (this.verificando()) return 'Código o nombre del producto';
    if (this.estado() === 'cobro') return 'Importe recibido y Enter · vacío = exacto';
    if (this.estado() === 'cobrado') return 'Escanea el siguiente producto';
    return 'Escanea, teclea el código o escribe el nombre';
  });
  readonly authTitulo = computed(() => {
    const a = this.auth();
    if (!a) return '';
    if (a.accion === 'cancelar') return 'Cancelar el ticket completo · ' + pesos(this.tot().total);
    const l = this.lineas()[a.indice];
    return (a.accion === 'bajar' ? 'Bajar a ' + (l.cantidad - 1) + ': ' : 'Quitar renglón: ') + l.nombre + ' · ' + pesos(importeRenglon(l));
  });
  readonly authTotalDespues = computed(() => {
    const a = this.auth();
    if (!a || a.accion === 'cancelar') return 0;
    return totalesCaja(this.lineas().map((l, i) => (i !== a.indice ? l : a.accion === 'bajar' ? { ...l, cantidad: l.cantidad - 1 } : { ...l, quitado: { motivo: '', quien: '' } }))).total;
  });

  constructor() {
    // La sucursal del usuario, si la tiene: la caja es de UNA sucursal.
    const propia = inject(AuthService).user()?.warehouse_code;
    if (propia) this.sucursal.set(propia);
    this.svc.sucursales().subscribe({ next: (s) => this.sucursales.set(s), error: () => this.sucursales.set([]) });
    effect(() => { if (this.suc()) this.prepararSucursal(); });
    // La pantalla del cliente escucha este canal (misma app, otra ventana).
    effect(() => this.canal?.postMessage(this.paraCliente()));
    // La pantalla del cliente recién abierta pide el estado actual.
    if (this.canal) this.canal.onmessage = (m: MessageEvent<{ pide?: boolean }>) => { if (m.data?.pide) this.canal?.postMessage(this.paraCliente()); };
  }

  ngOnDestroy(): void { this.canal?.close(); }

  /** Descarga el respaldo de precios de la sucursal: la búsqueda por nombre lee de ahí. */
  prepararSucursal(): void {
    const s = this.suc();
    if (!s) return;
    this.cargando.set(true);
    this.errorCarga.set(null);
    this.svc.asegurarSnapshot(s).subscribe({
      next: () => { this.cargando.set(false); this.enfocar(); },
      error: () => { this.cargando.set(false); this.errorCarga.set('No se pudo descargar el catálogo de precios de ' + warehouseName(s) + '. La búsqueda por código sigue funcionando.'); },
    });
  }

  // ── Teclado: todo pasa por aquí; el foco nunca sale de la línea de comandos ──
  @HostListener('document:keydown', ['$event'])
  alPresionar(e: KeyboardEvent): void {
    const k = e.key;
    if (/^F\d+$/.test(k)) e.preventDefault();
    if (k.length === 1 && !e.ctrlKey && !e.altKey) this.teclas.push(performance.now());
    const a = this.aviso();
    if (a && a.tipo !== 'error' && k !== 'Shift') this.aviso.set(null);
    const v = this.texto().trim();

    if (this.arqueo()) return; // el arqueo captura con su propio teclado
    if (!this.auth() && (k === 'F6' || k === 'F7')) { k === 'F6' ? this.abrirVerificador() : this.irArqueo(); return; }
    if (this.auth()) return this.teclaAutorizacion(e, k);
    if (this.verificando()) {
      if (k === 'Escape') { e.preventDefault(); this.verificando.set(false); this.verificado.set(null); this.limpiar(); }
      else if (k === 'Enter') { e.preventDefault(); void this.verificar(v); }
      return;
    }
    if (this.estado() === 'cobro') return this.teclaCobro(e, k, v);
    if (this.estado() === 'cobrado') { if (k === 'Enter' || /^F\d+$/.test(k)) e.preventDefault(); return; }

    switch (k) {
      case 'Enter': e.preventDefault(); void this.entrar(v); this.teclas = []; return;
      case 'Escape': e.preventDefault();
        if (this.resultados().length) this.cerrarResultados();
        else if (this.aviso()) this.aviso.set(null);
        else this.limpiar();
        return;
      case 'ArrowDown': case 'ArrowUp': {
        e.preventDefault();
        const d = k === 'ArrowDown' ? 1 : -1;
        const n = this.resultados().length;
        if (n) this.hit.set((this.hit() + d + n) % n);
        else if (this.lineas().length) this.sel.set(Math.min(Math.max(this.sel() + d, 0), this.lineas().length - 1));
        return;
      }
      case '+': if (v) return; e.preventDefault(); this.sumar(); return;
      case '-': if (v) return; e.preventDefault(); this.restar(); return;
      case 'F4': this.cambiarPresentacion(); return;
      case 'F9': void this.buscarTexto(v || ' ', true); return;
      case 'F10': this.pedir('quitar', this.sel()); return;
      case 'Delete':
        if (e.ctrlKey) { e.preventDefault(); this.pedir('cancelar', -1); }
        else if (!v) { e.preventDefault(); this.pedir('quitar', this.sel()); }
        return;
      case 'F12': this.cerrarResultados(); this.cobrar(v); return;
    }
  }

  alTeclear(valor: string): void {
    if (this.estado() === 'cobrado' && valor && !this.auth() && !this.verificando()) this.siguienteCliente();
    this.texto.set(valor);
    if (this.estado() === 'venta' && !this.auth() && !this.verificando()) {
      const c = leerComando(valor);
      if (c.tipo === 'texto') void this.buscarTexto(c.texto, false);
      else this.cerrarResultados();
    }
  }

  // ── Venta ──
  private async entrar(v: string): Promise<void> {
    const res = this.resultados();
    if (res.length) { const h = res[this.hit()]; this.cerrarResultados(); this.limpiar(); await this.agregarPorCodigo(h.codigo, 1, false); return; }
    const c = leerComando(v);
    if (c.tipo === 'vacio') return this.avisar('aviso', 'Escanea un producto. Para cobrar: F12.');
    if (c.tipo === 'invalido') return this.avisar('error', c.razon);
    if (c.tipo === 'texto') return this.avisar('error', 'Sin resultados para «' + c.texto + '». Prueba con otra palabra o con el código.');
    this.limpiar();
    await this.agregarPorCodigo(c.codigo, c.cantidad, c.conCantidad);
  }

  private async agregarPorCodigo(codigo: string, cantidad: number, conCantidad: boolean): Promise<void> {
    const s = this.suc();
    if (!s) return this.avisar('error', 'Elige la sucursal de la caja.');
    const r = await firstValueFrom(this.svc.buscar(codigo, s));
    if (r.estado === 'no_encontrado') return this.avisar('error', 'No encontrado: ' + codigo + '. El producto NO entró al ticket.');
    if (r.estado === 'sin_datos') return this.avisar('error', 'Sin datos de precios para ' + codigo + ' (sin red y sin respaldo). El producto NO entró al ticket.');
    if (r.esPromocion) return this.avisar('error', 'El código ' + codigo + ' es una promoción de Kepler, no un producto. No entró al ticket.');
    if (r.codigoAmbiguo) return this.avisar('error', 'El código apunta a más de un producto (' + (r.candidatos ?? []).map((c) => c.nombre).join(' / ') + '). Búscalo por nombre.');
    const linea = this.lineaDe(r.producto, r.unidadEscaneada ?? null);
    if (linea.granel && !conCantidad) return this.avisar('error', 'A granel: teclea el peso, *, y el código. Ejemplo: 1.884*' + codigo);
    if (!linea.granel && cantidad % 1) return this.avisar('error', 'Este producto se vende por ' + linea.unidad + ': la cantidad va sin decimales.');
    const ls = [...this.lineas()];
    const i = linea.granel ? -1 : ls.findIndex((l) => !l.quitado && l.codigo === linea.codigo && l.unidad === linea.unidad);
    if (i >= 0) ls[i] = { ...ls[i], cantidad: ls[i].cantidad + cantidad };
    else ls.push({ ...linea, cantidad });
    this.lineas.set(ls);
    this.tocar(i >= 0 ? i : ls.length - 1);
    this.tono(1320, 60);
  }

  private lineaDe(p: ProductoPrecio, unidadEscaneada: string | null): LineaCaja {
    const base = p.unidades.find((u) => u.factor === 1) ?? p.unidades[0];
    const escaleraDe = (u: string): EscalonCaja[] =>
      p.mayoreo.filter((t) => (t.etiqueta === 'paquete' ? u === 'PAQ' : u === base?.u)).map((t) => ({ desde: t.desde, precio: t.precio_con_iva }));
    const presentaciones = p.unidades.map((u) => ({ unidad: u.u, lista: u.precio_con_iva, escalera: escaleraDe(u.u) }));
    const elegida = presentaciones.find((x) => x.unidad === unidadEscaneada) ?? presentaciones.find((x) => x.unidad === base?.u) ?? presentaciones[0];
    return {
      codigo: p.codigo, nombre: p.nombre, unidad: elegida.unidad, lista: elegida.lista, escalera: elegida.escalera,
      ivaPct: p.iva_pct ?? 0, iepsPct: p.ieps_pct ?? 0, granel: /^KG/i.test(elegida.unidad), cantidad: 1, quitado: null, presentaciones,
    };
  }

  private sumar(): void {
    const i = this.sel(), l = this.lineas()[i];
    if (!l || l.quitado) return;
    if (l.granel) return this.avisar('aviso', 'El peso viene de la báscula: no se suma con +.');
    this.cambiarLinea(i, { cantidad: l.cantidad + 1 });
    this.tono(1320, 60);
  }

  private restar(): void {
    const i = this.sel(), l = this.lineas()[i];
    if (!l || l.quitado) return;
    if (l.granel) return this.avisar('aviso', 'El peso viene de la báscula. Para quitarlo: F10.');
    if (esCorreccionInmediata(this.ultimo(), i, Date.now())) {
      if (l.cantidad > 1) this.cambiarLinea(i, { cantidad: l.cantidad - 1 });
      else this.cambiarLinea(i, { quitado: { motivo: 'Corrección inmediata', quien: 'sin supervisor, menos de 15 s' } });
      return this.avisar('aviso', 'Corrección inmediata (menos de 15 s del escaneo). Quedaría en la bitácora.');
    }
    this.pedir('bajar', i);
  }

  private cambiarPresentacion(): void {
    const i = this.sel(), l = this.lineas()[i];
    if (!l || l.quitado) return;
    if (l.presentaciones.length < 2) return this.avisar('aviso', 'Este producto tiene una sola presentación.');
    const k = l.presentaciones.findIndex((p) => p.unidad === l.unidad);
    const n = l.presentaciones[(k + 1) % l.presentaciones.length];
    this.cambiarLinea(i, { unidad: n.unidad, lista: n.lista, escalera: n.escalera, cantidad: 1, granel: /^KG/i.test(n.unidad) });
    this.avisar('aviso', 'Presentación cambiada a ' + n.unidad + '. La cantidad volvió a 1: ajústala con + si hace falta.');
  }

  private cambiarLinea(i: number, cambio: Partial<LineaCaja>): void {
    this.lineas.update((ls) => ls.map((l, j) => (j === i ? { ...l, ...cambio } : l)));
    this.tocar(i);
  }

  private tocar(i: number): void {
    this.sel.set(i);
    this.ultimo.set({ indice: i, en: Date.now() });
    this.destello.set(i);
    setTimeout(() => { if (this.destello() === i) this.destello.set(-1); }, 400);
  }

  seleccionar(i: number, e: MouseEvent): void { e.preventDefault(); if (this.estado() === 'venta' && !this.auth()) this.sel.set(i); this.enfocar(); }

  // ── Búsqueda por nombre (sobre el respaldo de la sucursal) ──
  private async buscarTexto(texto: string, todo: boolean): Promise<void> {
    const s = this.suc();
    if (!s) return;
    const id = ++this.busquedaId;
    this.buscandoTexto.set(true);
    const r = await this.svc.buscarEnCatalogo(s, todo ? texto.trim() || 'a' : texto, 8);
    if (id !== this.busquedaId) return;
    this.buscandoTexto.set(false);
    this.hit.set(0);
    this.resultados.set(r ?? []);
    if (r === null) this.avisar('aviso', 'Aún no está el catálogo de la sucursal para buscar por nombre. Usa el código.');
  }

  elegir(i: number, e: MouseEvent): void { e.preventDefault(); this.hit.set(i); void this.entrar(''); }
  private cerrarResultados(): void { this.busquedaId++; this.resultados.set([]); this.buscandoTexto.set(false); }
  unidadesTexto(h: HalladoCatalogo): string { return h.unidades.map((u) => u.u + ' ' + pesos(u.precio_con_iva)).join(' · '); }

  // ── Autorización (PDV.23 la valida en el servidor; aquí se practica el flujo) ──
  private pedir(accion: Autorizacion['accion'], indice: number): void {
    if (accion === 'cancelar' ? !this.tot().renglones : !this.lineas()[indice] || this.lineas()[indice].quitado) return;
    this.cerrarResultados();
    this.limpiar();
    this.auth.set({ accion, indice, motivo: 0 });
  }

  private teclaAutorizacion(e: KeyboardEvent, k: string): void {
    const a = this.auth()!;
    if (k === 'Escape') { e.preventDefault(); this.auth.set(null); this.limpiar(); return; }
    if (!a.motivo) { if (k.length === 1) e.preventDefault(); if (/^[1-4]$/.test(k)) this.auth.set({ ...a, motivo: Number(k) }); return; }
    if (k === 'Enter') {
      e.preventDefault();
      if (this.texto().trim().length < 4) return this.avisar('error', 'El PIN del supervisor lleva al menos 4 dígitos.');
      this.aplicarAutorizacion(a);
      return;
    }
    if (k.length === 1 && !/\d/.test(k)) e.preventDefault();
  }

  private aplicarAutorizacion(a: Autorizacion): void {
    const motivo = MOTIVOS_QUITAR[a.motivo - 1], quien = 'autorizó supervisor (práctica)';
    this.auth.set(null);
    this.limpiar();
    if (a.accion === 'cancelar') { this.siguienteCliente(); return this.avisar('ok', 'Ticket cancelado con autorización. En producción queda en la bitácora.'); }
    const l = this.lineas()[a.indice];
    if (a.accion === 'bajar' && l.cantidad > 1) this.cambiarLinea(a.indice, { cantidad: l.cantidad - 1 });
    else this.cambiarLinea(a.indice, { quitado: { motivo, quien } });
    this.avisar('ok', 'Autorizado: ' + motivo.toLowerCase() + '.');
  }

  // ── Cobro ──
  cobrar(v: string): void {
    if (!this.tot().renglones) return this.avisar('aviso', 'El ticket está vacío.');
    if (!v) { this.estado.set('cobro'); this.limpiar(); return; }
    const imp = leerImporte(v);
    if (imp === null) return this.avisar('error', 'Para cobrar con importe teclea sólo el número, por ejemplo 250, y F12.');
    const err = errorEfectivo(imp, this.saldo());
    if (err) return this.avisar('error', err);
    this.estado.set('cobro');
    this.pagar('Efectivo', imp);
  }

  private teclaCobro(e: KeyboardEvent, k: string, v: string): void {
    if (k === 'Enter' || k === 'F2' || k === 'F3') {
      e.preventDefault();
      const rapido = this.teclas.length >= 4 && (this.teclas[this.teclas.length - 1] - this.teclas[0]) / (this.teclas.length - 1) < 35;
      this.teclas = [];
      if (k === 'Enter' && rapido && /^\d{4,}$/.test(v)) {
        if (this.pagos().length) return this.avisar('error', 'Hay un pago aplicado: termina el cobro antes de agregar productos.');
        this.estado.set('venta'); this.limpiar(); void this.agregarPorCodigo(v, 1, false); return;
      }
      const imp = v ? leerImporte(v) : this.saldo();
      if (imp === null) return this.avisar('error', 'En el cobro sólo va el importe recibido.');
      this.pagar(k === 'Enter' ? 'Efectivo' : k === 'F2' ? 'Tarjeta' : 'Transferencia', imp);
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      if (this.aviso()) this.aviso.set(null);
      else if (v) this.limpiar();
      else if (!this.pagos().length) this.estado.set('venta');
      else this.avisar('aviso', 'Ya hay un pago aplicado: completa el saldo.');
      return;
    }
    if (k.length === 1 && !/[\d.,$]/.test(k) && !e.ctrlKey) { e.preventDefault(); this.avisar('aviso', 'En el cobro sólo va el importe recibido.'); }
  }

  private pagar(forma: Pago['forma'], recibido: number): void {
    const saldo = this.saldo();
    if (forma === 'Efectivo') { const err = errorEfectivo(recibido, saldo); if (err) return this.avisar('error', err); }
    else if (recibido > saldo) return this.avisar('error', forma + ' no puede ser mayor que lo que falta (' + pesos(saldo) + ').');
    const aplicado = Math.min(recibido, saldo);
    this.pagos.update((p) => [...p, { forma, recibido, aplicado, cambio: forma === 'Efectivo' ? r2(recibido - aplicado) : 0 }]);
    this.limpiar();
    this.aviso.set(null);
    if (this.saldo() <= 0.004) { this.estado.set('cobrado'); this.tono(1320, 60); }
  }

  private siguienteCliente(): void {
    this.numero++;
    this.folio.set(this.folioDe(this.numero));
    this.lineas.set([]);
    this.pagos.set([]);
    this.sel.set(-1);
    this.ultimo.set(null);
    this.estado.set('venta');
    this.aviso.set(null);
  }

  // ── Verificador (F6) y arqueo (F7) ──
  abrirVerificador(): void { this.cerrarResultados(); this.limpiar(); this.verificado.set(null); this.verificando.set(true); this.enfocar(); }
  irArqueo(): void {
    if (this.tot().renglones && this.estado() !== 'cobrado') return this.avisar('aviso', 'Para hacer tu arqueo, termina o cancela el ticket en curso.');
    if (!this.puedeArqueo) return this.avisar('aviso', 'Tu puesto no tiene el arqueo de caja.');
    this.cerrarResultados();
    this.verificando.set(false);
    this.confirmarSalida.set(false);
    this.arqueo.set(true);
  }

  cerrarArqueo(): void {
    if (this.arqueoCmp?.hasUnsavedChanges() && !this.confirmarSalida()) { this.confirmarSalida.set(true); return; }
    this.confirmarSalida.set(false);
    this.arqueo.set(false);
    this.enfocar();
  }

  private async verificar(v: string): Promise<void> {
    const s = this.suc();
    if (!v || !s) return;
    this.limpiar();
    let codigo = v;
    const c = leerComando(v);
    if (c.tipo === 'texto') {
      const r = await this.svc.buscarEnCatalogo(s, c.texto, 1);
      if (!r?.length) return this.avisar('error', 'No encontrado: ' + v + '.');
      codigo = r[0].codigo;
    } else if (c.tipo === 'codigo') codigo = c.codigo;
    const r = await firstValueFrom(this.svc.buscar(codigo, s));
    if (r.estado !== 'encontrado') return this.avisar('error', 'No encontrado: ' + v + '.');
    this.verificado.set(r.producto);
  }

  // ── Pantalla del cliente ──
  abrirCliente(): void { window.open('/tienda/caja/cliente', 'md-caja-cliente', 'popup'); this.enfocar(); }
  private paraCliente() {
    const l = this.lineaSel();
    const p = l && !l.quitado && !l.granel ? precioRenglon(l) : null;
    return {
      estado: this.estado(), total: this.tot().total, ahorro: this.tot().ahorro, saldo: this.saldo(), recibido: this.recibidoTotal(), cambio: this.cambioTotal(),
      sucursal: this.suc() ? warehouseName(this.suc()) : '',
      empujon: p?.siguiente ? 'Llevando ' + (p.siguiente.desde - l!.cantidad) + ' más de ' + l!.nombre + ', te quedan en ' + pesos(p.siguiente.precio) + ' cada uno.' : '',
      lineas: this.lineas().map((x, i) => ({ nombre: x.nombre, cantidad: x.granel ? x.cantidad.toFixed(3) + ' kg' : x.cantidad + ' ' + x.unidad.toLowerCase(), importe: importeRenglon(x), quitado: !!x.quitado, sel: i === this.sel() })),
    };
  }

  // ── Ayudas ──
  precio(l: LineaCaja): number { return precioRenglon(l).precio; }
  importe(l: LineaCaja): number { return importeRenglon(l); }
  tasaTexto(l: LineaCaja): string { return l.ivaPct ? 'IVA ' + l.ivaPct + ' %' : l.iepsPct ? 'IEPS ' + l.iepsPct + ' %' : 'Tasa 0 %'; }
  tasaProducto(p: ProductoPrecio): string { return p.iva_pct ? 'IVA ' + p.iva_pct + ' % incluido' : p.ieps_pct ? 'IEPS ' + p.ieps_pct + ' % incluido' : 'Tasa 0 %'; }
  empujon(l: LineaCaja): string {
    if (l.quitado || l.granel) return '';
    const s = precioRenglon(l).siguiente;
    return s ? 'Lleva ' + (s.desde - l.cantidad) + ' más y queda en ' + pesos(s.precio) + ' c/u' : '';
  }
  claseAviso(t: Aviso['tipo']): string { return t === 'error' ? 'cj-error' : t === 'aviso' ? 'cj-warn' : 'cj-ok'; }
  private folioDe(n: number): string { return 'P-' + String(n).padStart(6, '0'); }
  private avisar(tipo: Aviso['tipo'], texto: string): void { this.aviso.set({ tipo, texto }); if (tipo === 'error') this.tono(180, 260, 'square'); }
  private limpiar(): void { this.texto.set(''); this.teclas = []; if (this.cmd) this.cmd.nativeElement.value = ''; }
  private enfocar(): void { if (!this.arqueo()) setTimeout(() => this.cmd?.nativeElement.focus(), 0); }
  reenfocar(): void { this.enfocar(); }

  private audio?: AudioContext;
  private tono(f: number, ms: number, forma: OscillatorType = 'sine'): void {
    try {
      this.audio ??= new AudioContext();
      const o = this.audio.createOscillator(), g = this.audio.createGain();
      o.type = forma; o.frequency.value = f; g.gain.value = 0.07;
      o.connect(g); g.connect(this.audio.destination);
      o.start(); o.stop(this.audio.currentTime + ms / 1000);
    } catch { /* sin audio: la confirmación visual basta */ }
  }
}
