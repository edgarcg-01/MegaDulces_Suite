import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type {
  ChecadoCajaP,
  ChecadoEscaneoResultado,
  ChecadoEtiquetaP,
  ChecadoPedido,
  ChecadoRenglon,
  ChecadoTerminarResponse,
  ConsolaSurtidoAlmacen,
} from '@megadulces/contracts';
import { PickingService } from '../../reparto/picking.service';
import { AuthService } from '../../../core/services/auth.service';
import { type Etiqueta, etiquetaDeCaja, etiquetaDeCajaP, imprimirEtiquetas } from '../checado-etiquetas';

type Fase = 'cargando' | 'listo' | 'checando' | 'terminado';
type Origen = '' | 'TELEMARK' | 'SUCURSAL';
type Tono = 'ok' | 'warn' | 'bad';
/** Un escaneo esperando turno: el escáner no espera al servidor, la pantalla sí. */
interface EnCola {
  code: string;
  cantidad: number;
  comoCajas: boolean;
}

const PREF_ALMACEN = 'gp.checar.almacen';
const PREF_ORIGEN = 'gp.checar.origen';
/** El último pedido checado, para reimprimir sus etiquetas aunque se haya recargado la página. */
const PREF_ULTIMO = 'gp.checar.ultimo';
const TOL = 0.001;

const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;
const junto = (...partes: Array<string | number | null | undefined>): string =>
  partes.filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(' ');
const TONO: Record<ChecadoEscaneoResultado, Tono> = {
  ok: 'ok', sobra: 'warn', pide_peso: 'warn', no_es_caja: 'warn', ajeno: 'bad', desconocido: 'bad', ambiguo: 'bad',
};
const ORDEN_ESTADO: Record<ChecadoRenglon['estado'], number> = { sobra: 0, falta: 1, pendiente: 2, completo: 3 };

/**
 * `[GP.4]` **Checar** (`FASE_GP` §9): pantalla de foco del checador, para celular y handheld.
 *
 * "Tomar siguiente" da un pedido surtido que Facturación ya pasó a SURTIDO en Kepler y que quien
 * checa no surtió (P4, lo cuida el servidor). Luego se **rastrilla**: lo que viene en caja cerrada
 * (CJA/BTO/CUB) cuenta una caja; lo demás entra a la caja P abierta. Cerrar la caja P imprime su
 * etiqueta por triplicado; terminar imprime las de las cajas "1/7…". Lo que sobra no se cuenta.
 *
 * ⭐ El escáner no espera: cada lectura entra a una cola y se manda una tras otra. El campo nunca se
 * bloquea, así que dos cajas pasadas seguidas son dos escaneos, no uno.
 */
@Component({
  selector: 'app-almacen-checar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule],
  template: `
    <div class="ck">
      <header class="ck-top">
        <a routerLink="/almacen" class="ck-salir"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Salir</span></a>
        <h1>Checar</h1>
        @if (almacenNombre()) { <span class="ck-alm">{{ almacenNombre() }}</span> }
      </header>

      @if (!enLinea()) {
        <div class="ck-off" role="alert"><i class="pi pi-wifi" aria-hidden="true"></i><span>Sin conexión. Lo que escanees no se va a guardar hasta que vuelva la señal.</span></div>
      }

      @if (error(); as e) {
        <div class="ck-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ e }}</span>
          @if (fase() === 'listo') { <button type="button" class="ck-sec" (click)="iniciar()">Reintentar</button> }
        </div>
      }

      @switch (fase()) {
        @case ('cargando') { <p class="ck-muted" aria-busy="true">Cargando…</p> }

        @case ('listo') {
          <section class="ck-card">
            @if (almacenes().length > 1) {
              <label class="ck-l" for="ck-alm">Almacén donde checas</label>
              <select id="ck-alm" class="ck-select" [ngModel]="almacenId()" (ngModelChange)="elegirAlmacen($event)">
                <option value="">— Elige —</option>
                @for (a of almacenes(); track a.id) { <option [value]="a.id">{{ a.code }} · {{ a.nombre }}</option> }
              </select>
            } @else if (almacenes().length === 1) {
              <p class="ck-l">Almacén: <b>{{ almacenes()[0].code }} · {{ almacenes()[0].nombre }}</b></p>
            } @else if (!error()) {
              <p class="ck-warn">No tienes una sucursal asignada. Pídele a Sistemas que te asigne tu sucursal.</p>
            }
            <p class="ck-l" id="ck-orig-l">Pedidos de</p>
            <div class="ck-seg" role="radiogroup" aria-labelledby="ck-orig-l">
              @for (o of origenes; track o.v) {
                <button type="button" role="radio" class="ck-seg-b" [class.on]="origen() === o.v" [attr.aria-checked]="origen() === o.v" (click)="elegirOrigen(o.v)">{{ o.l }}</button>
              }
            </div>
            <button type="button" class="ck-go" [disabled]="!almacenId() || ocupado()" (click)="tomar()">
              <i class="pi pi-play" aria-hidden="true"></i><span>{{ ocupado() ? 'Buscando…' : 'Tomar siguiente' }}</span>
            </button>
            @if (!almacenId() && almacenes().length > 1) { <p class="ck-muted">Elige primero tu almacén.</p> }
            @if (ultimo(); as u) {
              <button type="button" class="ck-sec ck-soltar" [disabled]="ocupado()" (click)="reimprimirUltimo()">Reimprimir etiquetas de {{ u.code }}</button>
            }
          </section>
          @if (sinTrabajo(); as s) {
            <section class="ck-card ck-vacio" role="status">
              <h2>No hay pedidos por checar</h2>
              <p>{{ s }}</p>
            </section>
          }
        }

        @case ('checando') {
          @if (pedido(); as p) {
            <section class="ck-head">
              <div><span class="ck-code">{{ p.order_code }}</span><span class="ck-dest">{{ p.destino || '—' }}</span></div>
              <span class="ck-prog">{{ completos() }} de {{ plural(p.renglones.length, 'producto', 'productos') }} listos</span>
            </section>

            <form class="ck-scan" (ngSubmit)="enviar()" autocomplete="off">
              @if (pidePeso(); as pp) {
                <label class="ck-l" for="ck-peso">Peso de {{ pp.producto }} en la báscula (kg)</label>
                <div class="ck-row">
                  <input #pesoInput id="ck-peso" name="peso" type="number" step="0.001" min="0" inputmode="decimal" class="ck-input" [ngModel]="peso()" (ngModelChange)="peso.set($event)" />
                  <button type="submit" class="ck-btn" [disabled]="!(peso() > 0)">Agregar</button>
                  <button type="button" class="ck-sec" (click)="cancelarPeso()">Cancelar</button>
                </div>
              } @else {
                <label class="ck-l" for="ck-code">Escanea o escribe el código</label>
                <div class="ck-row">
                  <input #codigoInput id="ck-code" name="code" class="ck-input" [ngModel]="codigo()" (ngModelChange)="codigo.set($event)" [attr.inputmode]="teclado() ? 'text' : 'none'" enterkeyhint="send" autocapitalize="characters" />
                  <button type="submit" class="ck-btn" [disabled]="!codigo().trim()">Agregar</button>
                  <button type="button" class="ck-sec" [attr.aria-pressed]="teclado()" (click)="alternarTeclado()">{{ teclado() ? 'Ocultar teclado' : 'Teclado' }}</button>
                </div>
                <div class="ck-row ck-cant">
                  <span class="ck-l">Cantidad</span>
                  <button type="button" class="ck-step" (click)="paso(-1)" [disabled]="cantidad() <= 1" aria-label="Una menos">−</button>
                  <span class="ck-n" aria-live="polite">{{ cantidad() }}</span>
                  <button type="button" class="ck-step" (click)="paso(1)" [disabled]="cantidad() >= 999" aria-label="Una más">+</button>
                  <label class="ck-check"><input type="checkbox" [ngModel]="comoCajas()" (ngModelChange)="comoCajas.set($event)" name="cajas" /> Son cajas cerradas</label>
                </div>
                <p class="ck-hint">¿Varias iguales sin etiqueta? Pon cuántas (y marca "Son cajas cerradas" si lo son) ANTES de escanear la pieza.</p>
              }
            </form>

            <div class="ck-aviso" [ngClass]="'ck-' + (aviso()?.tono ?? 'ok')" role="status" aria-live="polite">
              @if (aviso(); as a) { <span>{{ a.texto }}</span> }
              @if (pendientesEnCola() > 0) { <span class="ck-cola"> · guardando {{ pendientesEnCola() }}…</span> }
            </div>

            @if (p.ultimo_escaneo; as u) {
              <div class="ck-ult">
                <span>Último: {{ ultimoTexto(u) }}</span>
                <button type="button" class="ck-sec" [disabled]="ocupado()" (click)="deshacer(u.id)">Deshacer</button>
              </div>
            }

            @if (cajaAbierta(); as c) {
              <section class="ck-caja">
                <div><b>Caja P{{ c.numero }} abierta</b> · {{ plural(articulos(c), 'artículo', 'artículos') }}</div>
                <button type="button" class="ck-btn" [disabled]="ocupado() || !c.contenido.length" (click)="cerrarCaja()">Cerrar caja P{{ c.numero }} e imprimir sus 3 etiquetas</button>
              </section>
            } @else {
              <p class="ck-hint">La paquetería que escanees abre la caja P{{ siguienteP() }}.</p>
            }

            <ul class="ck-lista" aria-label="Productos del pedido">
              @for (r of renglonesOrdenados(); track r.id) {
                <li class="ck-item" [ngClass]="'ck-e-' + r.estado">
                  <div class="ck-item-t"><span class="ck-prod">{{ r.producto ?? r.sku }}</span><span class="ck-sku">{{ r.sku }}</span></div>
                  <div class="ck-item-n">
                    <span>Pedido: <b>{{ pedidoTexto(r) }}</b></span>
                    <span>Llevas: <b class="ck-chk">{{ llevasTexto(r) }}</b></span>
                    <span class="ck-badge">{{ estadoTexto(r) }}</span>
                  </div>
                </li>
              }
            </ul>

            @if (cajasCerradas().length) {
              <details class="ck-cerradas">
                <summary>{{ plural(cajasCerradas().length, 'caja P cerrada', 'cajas P cerradas') }}</summary>
                @for (c of cajasCerradas(); track c.id) {
                  <div class="ck-cerrada">
                    <p><b>P{{ c.numero }}</b>: {{ contenidoTexto(c) }}</p>
                    <button type="button" class="ck-sec" (click)="reimprimirCaja(c)">Reimprimir P{{ c.numero }}</button>
                  </div>
                }
              </details>
            }

            @if (!confirmando()) {
              <button type="button" class="ck-go ck-fin" [disabled]="ocupado() || pendientesEnCola() > 0" (click)="abrirTerminar()"><span>Terminar checado</span></button>
              <button type="button" class="ck-sec ck-soltar" [disabled]="ocupado()" (click)="soltando.set(true)">Soltar este pedido</button>
              @if (soltando()) {
                <section class="ck-confirm" role="group" aria-label="Soltar el pedido">
                  <p>¿Soltar {{ p.order_code }}? Vuelve a la fila y otro lo checa desde cero.</p>
                  <div class="ck-row">
                    <button type="button" class="ck-btn" [disabled]="ocupado()" (click)="soltar()">Sí, soltarlo</button>
                    <button type="button" class="ck-sec" (click)="soltando.set(false); enfocar()">Volver</button>
                  </div>
                </section>
              }
            } @else {
              <section class="ck-confirm" role="group" aria-label="Terminar checado">
                @if (noCuadran().length) {
                  <p class="ck-warn">Si terminas así, lo que falta sale incompleto:</p>
                  <ul class="ck-dif">
                    @for (r of noCuadran(); track r.id) { <li>{{ r.producto ?? r.sku }}: {{ estadoTexto(r) }}</li> }
                  </ul>
                } @else {
                  <p class="ck-ok">Todo cuadra.</p>
                }
                <label class="ck-l" for="ck-espera">Dónde queda esperando la unidad (opcional)</label>
                <input id="ck-espera" class="ck-input" [ngModel]="espera()" (ngModelChange)="espera.set($event)" maxlength="40" placeholder="Ej. A2" />
                <div class="ck-row">
                  <button type="button" class="ck-btn" [disabled]="ocupado()" (click)="terminar()">Sí, terminar</button>
                  <button type="button" class="ck-sec" [disabled]="ocupado()" (click)="confirmando.set(false); enfocar()">Volver</button>
                </div>
              </section>
            }
          }
        }

        @case ('terminado') {
          @if (fin(); as f) {
            <section class="ck-card">
              <h2>{{ f.order_code }} checado</h2>
              <p class="ck-muted">{{ f.destino || '—' }} · {{ plural(f.cajas_p, 'caja P', 'cajas P') }} · {{ plural(f.etiquetas_cj.length, 'caja completa', 'cajas completas') }}</p>
              @if (f.etiqueta_p; as ep) { <p class="ck-muted">La caja P{{ ep.numero }} se cerró al terminar: se mandaron a imprimir sus 3 etiquetas.</p> }
              @if (f.diferencias.length) {
                <p class="ck-warn">Sale con {{ plural(f.diferencias.length, 'diferencia', 'diferencias') }}:</p>
                <ul class="ck-dif">
                  @for (d of f.diferencias; track $index) { <li>{{ d.producto ?? d.sku }}: pedido {{ junto(d.esperado, d.unidad) }}, checado {{ junto(d.checado, d.unidad) }}</li> }
                </ul>
              } @else {
                <p class="ck-ok">Todo cuadró.</p>
              }
              @if (f.etiquetas_cj.length) {
                <p class="ck-muted">Se mandaron a imprimir las {{ f.etiquetas_cj.length }} etiquetas de cajas (1/{{ f.etiquetas_cj.length }}…).</p>
              }
              <div class="ck-row">
                @if (f.etiquetas_cj.length) { <button type="button" class="ck-sec" (click)="imprimirCajas()">Reimprimir etiquetas de cajas</button> }
                @if (f.etiqueta_p; as ep) { <button type="button" class="ck-sec" (click)="imprimirP(ep)">Reimprimir P{{ ep.numero }}</button> }
              </div>
              <button type="button" class="ck-go" [disabled]="ocupado()" (click)="tomar()"><i class="pi pi-play" aria-hidden="true"></i><span>Tomar siguiente</span></button>
            </section>
          }
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .ck { max-width:40rem; margin:0 auto; padding:var(--sp-3) var(--sp-3) var(--sp-6); }
    .ck-top { display:flex; align-items:center; gap:var(--sp-3); margin-bottom:var(--sp-3); flex-wrap:wrap; }
    .ck-top h1 { margin:0; font-size:var(--fs-h2); font-weight:700; }
    .ck-alm { margin-left:auto; font-size:var(--fs-sm); color:var(--text-muted); }
    .ck-salir { display:inline-flex; align-items:center; gap:.4rem; min-height:var(--tap-min); color:var(--text-muted); text-decoration:none; font-size:var(--fs-body); }
    .ck-card, .ck-head, .ck-caja, .ck-confirm { border:1px solid var(--border-color); border-radius:var(--r-lg); background:var(--card-bg); padding:var(--sp-3); margin-bottom:var(--sp-3); }
    .ck-card h2 { margin:0 0 .3rem; font-size:var(--fs-h3); }
    .ck-vacio p { margin:0; font-size:var(--fs-body); }
    .ck-head { display:flex; justify-content:space-between; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .ck-code { display:block; font-family:var(--font-mono); font-weight:700; font-size:var(--fs-lg); }
    .ck-dest { display:block; color:var(--text-muted); font-size:var(--fs-sm); }
    .ck-prog { font-size:var(--fs-body); font-weight:700; }
    .ck-l { display:block; font-size:var(--fs-sm); color:var(--text-muted); margin:.4rem 0 .25rem; }
    .ck-l b { color:var(--text-main); }
    .ck-hint { margin:.35rem 0 0; font-size:var(--fs-sm); color:var(--text-muted); }
    .ck-select, .ck-input { width:100%; min-height:var(--tap-min); padding:0 .7rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font:inherit; font-size:var(--fs-lg); box-sizing:border-box; }
    .ck-select:focus-visible, .ck-input:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .ck-row { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
    .ck-row .ck-input { flex:1; min-width:10rem; }
    .ck-cant { margin-top:.4rem; }
    .ck-cant .ck-l { margin:0; }
    .ck-step { width:var(--tap-min); height:var(--tap-min); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:var(--fs-lg); cursor:pointer; }
    .ck-n { min-width:2.5rem; text-align:center; font-family:var(--font-mono); font-size:var(--fs-lg); font-weight:800; }
    .ck-check { display:inline-flex; align-items:center; gap:.4rem; min-height:var(--tap-min); font-size:var(--fs-sm); cursor:pointer; }
    .ck-check input { width:1.25rem; height:1.25rem; }
    .ck-seg { display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:var(--sp-3); }
    .ck-seg-b { min-height:var(--tap-min); padding:0 1rem; border:1px solid var(--border-color); border-radius:var(--r-pill); background:var(--card-bg); color:var(--text-main); font:inherit; cursor:pointer; }
    .ck-seg-b.on { border-color:var(--action); box-shadow:inset 0 0 0 1px var(--action); font-weight:600; }
    .ck-go { display:flex; align-items:center; justify-content:center; gap:.6rem; width:100%; min-height:4rem; border:0; border-radius:var(--r-lg); background:var(--action); color:var(--action-ink); font:inherit; font-size:var(--fs-h2); font-weight:700; cursor:pointer; margin-top:var(--sp-2); }
    .ck-go:disabled { background:var(--surface-border); color:var(--text-muted); cursor:not-allowed; }
    .ck-fin { background:var(--text-main); color:var(--card-bg); font-size:var(--fs-h3); }
    .ck-btn { min-height:var(--tap-min); padding:0 1rem; border:0; border-radius:var(--r-md); background:var(--action); color:var(--action-ink); font:inherit; font-weight:600; cursor:pointer; }
    .ck-btn:disabled { background:var(--surface-border); color:var(--text-muted); cursor:not-allowed; }
    .ck-sec { min-height:var(--tap-min); padding:0 .9rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font:inherit; font-size:var(--fs-sm); font-weight:600; cursor:pointer; }
    .ck-sec:disabled { color:var(--text-muted); cursor:not-allowed; }
    .ck-soltar { display:block; margin:var(--sp-2) auto 0; }
    .ck-go:focus-visible, .ck-btn:focus-visible, .ck-sec:focus-visible, .ck-step:focus-visible, .ck-seg-b:focus-visible, .ck-salir:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .ck-aviso { min-height:2.6rem; margin:var(--sp-2) 0; padding:.55rem .8rem; border-radius:var(--r-md); font-size:var(--fs-lg); font-weight:700; }
    .ck-aviso:empty { padding:0; min-height:0; }
    .ck-cola { font-size:var(--fs-sm); font-weight:600; }
    .ck-ok { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .ck-warn { background:var(--warn-soft-bg); color:var(--warn-soft-fg); padding:.4rem .6rem; border-radius:var(--r-md); }
    .ck-bad { background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .ck-ult { display:flex; justify-content:space-between; align-items:center; gap:.5rem; font-size:var(--fs-body); margin-bottom:var(--sp-2); }
    .ck-caja { display:flex; flex-direction:column; gap:.5rem; border-left:3px solid var(--action); }
    .ck-lista { list-style:none; margin:var(--sp-3) 0; padding:0; display:flex; flex-direction:column; gap:.4rem; }
    .ck-item { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.6rem .75rem; }
    .ck-item-t { display:flex; justify-content:space-between; gap:.5rem; }
    .ck-prod { font-weight:600; font-size:var(--fs-body); }
    .ck-sku { font-family:var(--font-mono); color:var(--text-muted); font-size:var(--fs-sm); }
    .ck-item-n { display:flex; gap:.4rem 1rem; align-items:center; flex-wrap:wrap; font-size:var(--fs-body); margin-top:.3rem; }
    .ck-chk { font-family:var(--font-mono); font-size:var(--fs-lg); font-weight:800; }
    .ck-badge { margin-left:auto; padding:.15rem .6rem; border-radius:var(--r-pill); font-size:var(--fs-sm); font-weight:700; background:var(--hover-bg); }
    .ck-e-completo .ck-badge { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .ck-e-falta .ck-badge { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .ck-e-sobra { border-left:3px solid var(--bad-fg); }
    .ck-e-sobra .ck-badge { background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .ck-cerradas { margin-bottom:var(--sp-3); font-size:var(--fs-sm); }
    .ck-cerradas summary { min-height:var(--tap-min); display:flex; align-items:center; cursor:pointer; font-weight:600; }
    .ck-cerrada { display:flex; justify-content:space-between; align-items:center; gap:.5rem; }
    .ck-muted { color:var(--text-muted); }
    .ck-err, .ck-off { display:flex; align-items:center; gap:.5rem; padding:.6rem .8rem; margin-bottom:var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .ck-err { border-left:3px solid var(--bad-fg); }
    .ck-err .pi { color:var(--bad-fg); }
    .ck-off { border-left:3px solid var(--warn-fg); }
    .ck-off .pi { color:var(--warn-fg); }
    .ck-dif { margin:0 0 var(--sp-3); padding-left:1.2rem; font-size:var(--fs-body); }
  `],
})
export class AlmacenChecarComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly codigoInput = viewChild<ElementRef<HTMLInputElement>>('codigoInput');
  private readonly pesoInput = viewChild<ElementRef<HTMLInputElement>>('pesoInput');

  readonly plural = plural;
  readonly junto = junto;
  readonly origenes: Array<{ v: Origen; l: string }> = [
    { v: '', l: 'Todos' },
    { v: 'TELEMARK', l: 'Telemarketing' },
    { v: 'SUCURSAL', l: 'Sucursal' },
  ];

  readonly fase = signal<Fase>('cargando');
  readonly almacenes = signal<ConsolaSurtidoAlmacen[]>([]);
  readonly almacenId = signal('');
  readonly origen = signal<Origen>('');
  readonly pedido = signal<ChecadoPedido | null>(null);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<{ tono: Tono; texto: string } | null>(null);
  readonly sinTrabajo = signal<string | null>(null);
  readonly ocupado = signal(false);
  readonly enLinea = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  readonly codigo = signal('');
  readonly cantidad = signal(1);
  readonly comoCajas = signal(false);
  readonly teclado = signal(false);
  readonly pidePeso = signal<{ code: string; producto: string } | null>(null);
  readonly peso = signal<number>(0);
  readonly confirmando = signal(false);
  readonly soltando = signal(false);
  readonly espera = signal('');
  readonly fin = signal<ChecadoTerminarResponse | null>(null);
  readonly ultimo = signal<{ id: string; code: string } | null>(null);
  private readonly cola = signal<EnCola[]>([]);
  private enviando = false;

  readonly pendientesEnCola = computed(() => this.cola().length);
  readonly almacenNombre = computed(() => {
    const a = this.almacenes().find((x) => x.id === this.almacenId());
    return a ? `${a.code} · ${a.nombre}` : '';
  });
  readonly completos = computed(() => (this.pedido()?.renglones ?? []).filter((r) => r.estado === 'completo').length);
  readonly noCuadran = computed(() => (this.pedido()?.renglones ?? []).filter((r) => r.estado !== 'completo'));
  readonly renglonesOrdenados = computed(() =>
    [...(this.pedido()?.renglones ?? [])].sort((a, b) => ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado]),
  );
  readonly cajaAbierta = computed(() => (this.pedido()?.cajas_p ?? []).find((c) => c.status === 'abierta') ?? null);
  readonly cajasCerradas = computed(() => (this.pedido()?.cajas_p ?? []).filter((c) => c.status === 'cerrada'));
  readonly siguienteP = computed(() => (this.pedido()?.cajas_p ?? []).reduce((m, c) => Math.max(m, c.numero), 0) + 1);

  ngOnInit(): void {
    this.origen.set(this.leer(PREF_ORIGEN) as Origen);
    try {
      const u = JSON.parse(this.leer(PREF_ULTIMO) || 'null') as { id?: string; code?: string } | null;
      if (u?.id && u.code) this.ultimo.set({ id: u.id, code: u.code });
    } catch {
      /* preferencia dañada: se ignora */
    }
    if (typeof window !== 'undefined') {
      const on = () => this.enLinea.set(true);
      const off = () => this.enLinea.set(false);
      window.addEventListener('online', on);
      window.addEventListener('offline', off);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('online', on);
        window.removeEventListener('offline', off);
      });
    }
    this.iniciar();
  }

  /** Almacenes (con la clave del checado) + el pedido que ya traía, si cerró la app a medias. */
  iniciar(): void {
    this.error.set(null);
    this.fase.set('cargando');
    this.api.checadoAlmacenes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws) => {
        this.almacenes.set(ws || []);
        const guardado = this.leer(PREF_ALMACEN);
        const delUsuario = this.auth.user()?.warehouse_code;
        const def = ws.find((w) => w.id === guardado) ?? ws.find((w) => w.code === delUsuario) ?? (ws.length === 1 ? ws[0] : undefined);
        this.almacenId.set(def?.id ?? '');
        this.api.checadoMio().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (p) => {
            if (p) this.entrar(p, 'Retomaste el pedido que traías.');
            else this.fase.set('listo');
          },
          error: () => {
            this.error.set('No se pudo revisar si ya traías un pedido.');
            this.fase.set('listo');
          },
        });
      },
      error: () => {
        this.error.set('No se pudo leer la lista de almacenes.');
        this.fase.set('listo');
      },
    });
  }

  elegirAlmacen(id: string): void {
    this.almacenId.set(id);
    this.guardar(PREF_ALMACEN, id);
    this.sinTrabajo.set(null);
  }

  elegirOrigen(o: Origen): void {
    this.origen.set(o);
    this.guardar(PREF_ORIGEN, o);
    this.sinTrabajo.set(null);
  }

  tomar(): void {
    const alm = this.almacenId();
    if (!alm || this.ocupado()) return;
    this.ocupado.set(true);
    this.error.set(null);
    this.sinTrabajo.set(null);
    this.api.checadoSiguiente(alm, this.origen() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        if (r.estado === 'asignado') {
          this.entrar(r.pedido, r.ya_era_tuyo ? 'Retomaste el pedido que traías.' : 'Empieza a escanear.');
        } else {
          this.fase.set('listo');
          this.sinTrabajo.set(r.motivo);
        }
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.fase.set('listo');
        this.error.set(this.mensaje(e, 'No se pudo tomar un pedido.'));
      },
    });
  }

  paso(d: number): void {
    this.cantidad.set(Math.min(999, Math.max(1, this.cantidad() + d)));
  }

  alternarTeclado(): void {
    this.teclado.set(!this.teclado());
    this.enfocar();
  }

  /** El escáner manda el código y Enter: entra a la cola al instante y el campo queda libre. */
  enviar(): void {
    const pp = this.pidePeso();
    if (pp) {
      if (!(this.peso() > 0)) return;
      this.mandar({ code: pp.code, cantidad: 1, comoCajas: false }, Number(this.peso()));
      return;
    }
    const code = this.codigo().trim();
    if (!code || !this.pedido()) return;
    this.cola.update((c) => [...c, { code, cantidad: this.cantidad(), comoCajas: this.comoCajas() }]);
    this.codigo.set('');
    this.cantidad.set(1);
    this.comoCajas.set(false);
    this.siguienteDeLaCola();
    this.enfocar();
  }

  cancelarPeso(): void {
    this.pidePeso.set(null);
    this.aviso.set({ tono: 'warn', texto: 'No se agregó: falta el peso.' });
    this.siguienteDeLaCola();
    this.enfocar();
  }

  deshacer(scanId: string): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoDeshacer(p.id, scanId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (np) => {
        this.ocupado.set(false);
        this.pedido.set(np);
        this.aviso.set({ tono: 'warn', texto: 'Se deshizo el último escaneo.' });
        this.enfocar();
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo deshacer.') });
        this.enfocar();
      },
    });
  }

  cerrarCaja(): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoCerrarCaja(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.pedido.set(r.pedido);
        this.aviso.set({ tono: 'ok', texto: `Caja P${r.etiqueta.numero} cerrada. Pega dos etiquetas en lados distintos de la caja y la tercera en la hoja del pedido.` });
        this.imprimirP(r.etiqueta);
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo cerrar la caja.') });
        this.enfocar();
      },
    });
  }

  reimprimirCaja(c: ChecadoCajaP): void {
    const p = this.pedido();
    if (!p) return;
    this.imprimirP({
      id: c.id, numero: c.numero, order_code: p.order_code, destino: p.destino,
      articulos: this.articulos(c), productos: new Set(c.contenido.map((x) => x.sku)).size,
    });
  }

  abrirTerminar(): void {
    this.confirmando.set(true);
    this.soltando.set(false);
    this.enfocar();
  }

  terminar(): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoTerminar(p.id, this.espera().trim() || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.fin.set(r);
        this.ultimo.set({ id: p.id, code: r.order_code });
        this.guardar(PREF_ULTIMO, JSON.stringify({ id: p.id, code: r.order_code }));
        this.pedido.set(null);
        this.confirmando.set(false);
        this.espera.set('');
        this.fase.set('terminado');
        // La caja P que seguía abierta primero; luego las de cajas 1/N. Encadenadas: una sola
        // impresión a la vez, y no se pierden con un toque a "Tomar siguiente".
        const cajas = r.etiquetas_cj.map((e) => etiquetaDeCaja(e, r.order_code, r.destino));
        const imprimirCajas = () => imprimirEtiquetas(cajas);
        if (r.etiqueta_p) this.imprimirP(r.etiqueta_p, imprimirCajas);
        else imprimirCajas();
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo terminar el checado.') });
        this.enfocar();
      },
    });
  }

  soltar(): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoSoltar(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ocupado.set(false);
        this.soltando.set(false);
        this.pedido.set(null);
        this.cola.set([]);
        this.fase.set('listo');
        this.sinTrabajo.set(`Soltaste ${p.order_code}: volvió a la fila.`);
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo soltar el pedido.') });
      },
    });
  }

  /** Reimprime todo el último pedido (cada caja P por triplicado y las cajas 1/N), desde el servidor. */
  reimprimirUltimo(): void {
    const u = this.ultimo();
    if (!u || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoEtiquetas(u.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        const lista: Etiqueta[] = [];
        for (const p of r.cajas_p) {
          const et = etiquetaDeCajaP(p);
          lista.push(et, et, et);
        }
        lista.push(...r.etiquetas_cj.map((e) => etiquetaDeCaja(e, r.order_code, r.destino)));
        if (!lista.length) {
          this.sinTrabajo.set(`${r.order_code} no tiene etiquetas que imprimir.`);
          return;
        }
        imprimirEtiquetas(lista);
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.error.set(this.mensaje(e, 'No se pudieron leer las etiquetas.'));
      },
    });
  }

  imprimirCajas(): void {
    const f = this.fin();
    if (f) imprimirEtiquetas(f.etiquetas_cj.map((e) => etiquetaDeCaja(e, f.order_code, f.destino)));
  }

  /** La etiqueta de la caja P por triplicado: llena la fila de 3 del rollo. */
  imprimirP(e: ChecadoEtiquetaP, despues?: () => void): void {
    const et: Etiqueta = etiquetaDeCajaP(e);
    imprimirEtiquetas([et, et, et], () => {
      this.enfocar();
      despues?.();
    });
  }

  // ── Textos ───────────────────────────────────────────────────────────────────────────────

  /** En cajas sólo si el pedido da cajas enteras y no se ha contado nada suelto. */
  private enCajas(r: ChecadoRenglon): boolean {
    return r.esperado_mayor !== null && !!r.unidad_mayor && r.checado_sueltas <= TOL;
  }

  pedidoTexto(r: ChecadoRenglon): string {
    return this.enCajas(r) ? junto(r.esperado_mayor, r.unidad_mayor) : junto(this.num(r.esperado), r.unidad);
  }

  llevasTexto(r: ChecadoRenglon): string {
    if (this.enCajas(r)) return junto(r.checado_mayor, r.unidad_mayor);
    if (r.checado_mayor > 0 && r.unidad_mayor) return `${junto(r.checado_mayor, r.unidad_mayor)} + ${junto(this.num(r.checado_sueltas), r.unidad)}`;
    return junto(this.num(r.checado), r.unidad);
  }

  estadoTexto(r: ChecadoRenglon): string {
    const cajas = this.enCajas(r);
    switch (r.estado) {
      case 'completo': return 'Listo';
      case 'falta': return cajas ? `Faltan ${junto((r.esperado_mayor ?? 0) - r.checado_mayor, r.unidad_mayor)}` : `Faltan ${junto(this.num(r.esperado - r.checado), r.unidad)}`;
      case 'sobra': return `Sobran ${junto(this.num(r.checado - r.esperado), r.unidad)}`;
      default: return 'Pendiente';
    }
  }

  ultimoTexto(u: NonNullable<ChecadoPedido['ultimo_escaneo']>): string {
    return junto(u.cantidad, u.unidad, '·', u.producto, u.kind === 'ajeno' ? '(no va en el pedido)' : null);
  }

  contenidoTexto(c: ChecadoCajaP): string {
    return c.contenido.map((x) => junto(x.cantidad, x.unidad, x.producto ?? x.sku)).join(', ');
  }

  articulos(c: ChecadoCajaP): number {
    return c.contenido.reduce((s, x) => s + x.cantidad, 0);
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────────

  private entrar(p: ChecadoPedido, texto: string): void {
    this.pedido.set(p);
    this.fin.set(null);
    this.cola.set([]);
    this.pidePeso.set(null);
    this.confirmando.set(false);
    this.soltando.set(false);
    this.aviso.set({ tono: 'ok', texto });
    this.fase.set('checando');
    this.enfocar();
  }

  /** Manda el siguiente escaneo de la cola si no hay uno en camino ni se está pidiendo un peso. */
  private siguienteDeLaCola(): void {
    if (this.enviando || this.pidePeso()) return;
    const [primero] = this.cola();
    if (!primero) return;
    this.mandar(primero);
  }

  private mandar(item: EnCola, pesoKg?: number): void {
    const p = this.pedido();
    if (!p) return;
    this.enviando = true;
    this.api
      .checadoEscanear(p.id, { code: item.code, cantidad: item.cantidad, como_cajas: item.comoCajas || undefined, peso_kg: pesoKg })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.enviando = false;
          this.pedido.set(r.pedido);
          this.aviso.set({ tono: TONO[r.resultado], texto: r.mensaje });
          if (pesoKg === undefined) this.cola.update((c) => c.slice(1));
          if (r.resultado === 'pide_peso') {
            this.pidePeso.set({ code: item.code, producto: r.producto ?? item.code });
            this.peso.set(0);
            setTimeout(() => this.pesoInput()?.nativeElement.focus());
            return;
          }
          this.pidePeso.set(null);
          this.siguienteDeLaCola();
          this.enfocar();
        },
        error: (e: unknown) => {
          this.enviando = false;
          if (pesoKg === undefined) this.cola.update((c) => c.slice(1));
          this.aviso.set({ tono: 'bad', texto: `${item.code}: ${this.mensaje(e, 'no se registró. Vuelve a escanearlo.')}` });
          this.siguienteDeLaCola();
          this.enfocar();
        },
      });
  }

  enfocar(): void {
    setTimeout(() => (this.pidePeso() ? this.pesoInput() : this.codigoInput())?.nativeElement.focus());
  }

  private num(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  private mensaje(e: unknown, def: string): string {
    const m = (e as { error?: { message?: unknown } })?.error?.message;
    return typeof m === 'string' && m ? m : def;
  }

  private leer(k: string): string {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  }

  private guardar(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* sin almacenamiento: se elige de nuevo la próxima vez */
    }
  }
}
