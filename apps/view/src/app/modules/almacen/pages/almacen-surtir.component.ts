import {
  ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { KeplerWavesAutoResponse, PickerWave, PickerWaveLine } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { PickingService } from '../../reparto/picking.service';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { AuthService } from '../../../core/services/auth.service';

/**
 * Preferencias guardadas en el dispositivo (almacén y origen elegidos): el surtidor no tiene por
 * qué elegirlos cada vez. ⚠️ El nombre no termina en "key": gitleaks tomaba la constante por una
 * clave de API y bloqueaba el PR (falso positivo en #316).
 */
const PREF_ALMACEN = 'gp.surtir.almacen.v1';
const PREF_ORIGEN = 'gp.surtir.origen.v1';

type Origen = '' | 'TELEMARK' | 'SUCURSAL';

/** "1 pedido" / "3 pedidos": nada de "pedido(s)" en una pantalla que se lee de reojo. */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * `[GP.3b]` **Surtir desde el celular: "Tomar siguiente", marcar renglón por renglón y cerrar.**
 *
 * Reemplaza el ticket impreso `Referencia SURTIDO` y el círculo de pluma sobre la hoja. Modelo
 * decidido por Francisco (2026-10-07, `FASE_GP` §8): el surtidor **jala** su trabajo —el sistema le
 * da la ola libre más vieja de su almacén, no elige cuál— y la consola queda para excepciones.
 *
 * ── Decisiones de uso (revisión de usabilidad, 2026-10-08) ─────────────────────────────────
 *  · **La lista no se mueve bajo el dedo.** Los renglones quedan en su orden; uno marcado se
 *    ENCOGE a una línea con "Corregir" (que sirve de deshacer). Si se fuera a otra sección, el
 *    siguiente subiría justo debajo del pulgar y un segundo toque —o uno con guante— marcaría el
 *    renglón equivocado. Encogidos, 85 renglones caben en una lista que se puede recorrer.
 *  · **La cantidad es lo que se lee de lejos**: va en `--fs-display`, el nombre más chico.
 *  · **Escáner**: busca por código de barras, código y nombre; Enter con un solo resultado manda
 *    el foco a su "Completo" (no lo marca solo: escanear no es haber contado).
 *  · **"No había nada" está separado** del Guardar y a lo ancho: es el toque que más cuesta.
 *  · Cada toque se guarda en el servidor al momento y la pantalla lo dice; sin señal, lo avisa.
 *  · Un faltante NO detiene el surtido (P7: el pedido sale incompleto). Se marca y se sigue.
 *  · No se puede cerrar con renglones sin tocar: "nadie pasó" no es lo mismo que "no había".
 *
 * ⚠️ El orden es el del servidor (pendientes primero, después por ubicación y nombre). La ubicación
 * de cada producto todavía no está dada de alta (`FASE_WMS` §12.5): hoy, en la práctica, por nombre.
 */
@Component({
  selector: 'app-almacen-surtir',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in sr-page">
      <p-toast position="top-center"></p-toast>
      <!-- Lo que acaba de pasar, para lectores de pantalla (el renglón no se mueve, pero cambia). -->
      <p class="sr-oculto" role="status" aria-live="polite">{{ anuncio() }}</p>

      <header class="sr-top">
        <button pButton type="button" [text]="true" severity="secondary" class="sr-tap" (click)="salir()">
          <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Salir
        </button>
        <div class="sr-top-mid">
          <strong>Surtir</strong>
          @if (almacenNombre()) { <span class="sr-top-sub">{{ almacenNombre() }}</span> }
        </div>
        @if (ola(); as o) {
          <div class="sr-top-prog" aria-hidden="true">{{ hechos() }} / {{ o.lines.length }}</div>
        }
      </header>

      @if (!enLinea()) {
        <div class="sr-banda sr-banda-bad" role="alert">
          <i class="pi pi-wifi" aria-hidden="true"></i>
          <span>Sin conexión. Lo que marques no se va a guardar hasta que vuelva la señal.</span>
        </div>
      }

      @if (atoradas().length) {
        <div class="sr-banda sr-banda-warn" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>Avísale a tu supervisor: {{ plural(atoradas().length, 'surtido armado a mano no se pudo abrir', 'surtidos armados a mano no se pudieron abrir') }}
            ({{ atoradasTexto() }}).</span>
        </div>
      }

      @if (fase() === 'cargando') {
        <div class="sr-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando…</div>
      }

      @if (error()) {
        <div class="sr-banda sr-banda-bad" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="sr-banda-txt">{{ error() }}</span>
          <button pButton type="button" severity="secondary" class="sr-tap" (click)="reintentar()">Reintentar</button>
        </div>
      }

      <!-- ─────────── ELEGIR ALMACÉN / LISTO PARA TOMAR ─────────── -->
      @if (fase() === 'listo') {
        <section class="sr-card">
          <label class="sr-l" for="sr-alm">Almacén donde surtes</label>
          <select id="sr-alm" class="sr-select" [ngModel]="almacenId()" (ngModelChange)="elegirAlmacen($event)">
            <option value="">— Elige —</option>
            @for (a of almacenes(); track a.id) {
              <option [value]="a.id">{{ a.code }} · {{ a.name }}</option>
            }
          </select>

          <span class="sr-l" id="sr-origen-l">Pedidos de</span>
          <div class="sr-chips" role="radiogroup" aria-labelledby="sr-origen-l">
            @for (op of origenes; track op.v) {
              <button type="button" class="sr-chip" role="radio" [attr.aria-checked]="origen() === op.v"
                      [class.sr-chip-on]="origen() === op.v" (click)="elegirOrigen(op.v)">{{ op.l }}</button>
            }
          </div>

          <button type="button" class="sr-btn sr-btn-go" [disabled]="!almacenId() || tomando()" (click)="tomar()">
            @if (tomando()) {
              <i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Buscando trabajo…</span>
            } @else {
              <i class="pi pi-play" aria-hidden="true"></i><span>Tomar siguiente</span>
            }
          </button>
          <p class="sr-tip">
            @if (!almacenId()) { Elige primero tu almacén. } @else { Te toca el pedido que más urge. No se elige cuál. }
          </p>
        </section>

        @if (sinTrabajo(); as s) {
          <section class="sr-card sr-vacio">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <h2>No hay pedidos por surtir</h2>
            <p>{{ s.motivo }}</p>
            @if (s.armado; as a) {
              @if (a.bloqueados.length) {
                <p class="sr-aviso">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  {{ plural(a.bloqueados.length, 'pedido no se puede surtir', 'pedidos no se pueden surtir') }}. Avísale a tu supervisor:
                </p>
                <ul class="sr-lista-min">
                  @for (b of a.bloqueados; track b.code) { <li><strong>{{ b.code }}</strong> — {{ b.motivo }}</li> }
                </ul>
              }
              @if (a.atorados.count) {
                <p class="sr-tip">
                  {{ plural(a.atorados.count, 'pedido sigue autorizado', 'pedidos siguen autorizados') }} en Kepler desde el
                  {{ a.atorados.desde }} y no entran a la fila. Hay que cerrarlos en Kepler.
                </p>
              }
            }
          </section>
        }
      }

      <!-- ─────────── SURTIENDO ─────────── -->
      @if (fase() === 'surtiendo' && ola(); as o) {
        <div class="sr-barra" role="progressbar" aria-label="Avance del surtido" [attr.aria-valuenow]="hechos()"
             [attr.aria-valuemin]="0" [attr.aria-valuemax]="o.lines.length"
             [attr.aria-valuetext]="hechos() + ' de ' + o.lines.length + ' renglones'">
          <span [style.--fill]="o.lines.length ? hechos() / o.lines.length : 0"></span>
        </div>

        <section class="sr-ola">
          <span class="sr-ola-code">{{ o.code }}</span>
          <span class="sr-ola-ped">{{ plural(o.pedidos.length, 'pedido', 'pedidos') }}: {{ o.pedidos.join(', ') }}</span>
          <span class="sr-ola-ped"><i class="pi pi-cloud" aria-hidden="true"></i> Cada toque se guarda al momento.</span>
        </section>

        <section class="sr-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input id="sr-buscar" class="sr-buscar-input" type="text" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                 (keydown.enter)="enterBuscar()" autocomplete="off" aria-label="Buscar producto"
                 placeholder="Escanea la etiqueta o escribe el nombre" />
          @if (busqueda()) {
            <button pButton type="button" [text]="true" severity="secondary" class="sr-tap" (click)="limpiarBusqueda()">Limpiar</button>
          }
        </section>

        <div class="sr-filtro">
          <h3 class="sr-h3">
            @if (busqueda()) { {{ plural(visibles().length, 'coincidencia', 'coincidencias') }} }
            @else { Por surtir <span class="sr-n">{{ pendientesTotal() }} de {{ o.lines.length }}</span> }
          </h3>
          @if (hechos() && !busqueda()) {
            <button type="button" class="sr-chip" [attr.aria-pressed]="ocultarHechos()" [class.sr-chip-on]="ocultarHechos()"
                    (click)="ocultarHechos.set(!ocultarHechos())">Ocultar los ya surtidos</button>
          }
        </div>

        @if (busqueda() && !visibles().length) {
          <p class="sr-sinhit">Ningún renglón de este surtido coincide con «{{ busqueda() }}». Revisa que el producto sea de este pedido.</p>
        } @else if (!pendientesTotal()) {
          <p class="sr-tip sr-tip-ok"><i class="pi pi-check" aria-hidden="true"></i> Ya pasaste por todos los renglones. Revisa y termina.</p>
        }

        @for (l of visibles(); track l.id) {
          @if (l.status === 'pendiente' || editando() === l.id) {
            <!-- Renglón por surtir (o abierto para corregir): grande, con los botones del pulgar. -->
            <article class="sr-ren">
              <div class="sr-ren-prod">
                <strong>{{ l.product_name || l.sku }}</strong>
                <span class="sr-sku">{{ l.sku }}</span>
              </div>
              <div class="sr-cant" [attr.aria-label]="'Surtir ' + cantidadPrincipal(l)">
                <span class="sr-cant-n">{{ cantidadNumero(l) }}</span>
                <span class="sr-cant-u">{{ unidadConteo(l) }}</span>
                @if (cantidadBase(l); as b) { <span class="sr-cant-b">{{ b }}</span> }
              </div>
              @if (l.unidad_mixta) {
                <p class="sr-tip"><i class="pi pi-info-circle" aria-hidden="true"></i> Los pedidos lo piden en unidades distintas: cuenta en {{ unidadConteo(l) }}.</p>
              }

              @if (editando() === l.id) {
                <div class="sr-falta">
                  <label class="sr-l" [for]="'sr-q-' + l.id">¿Cuánto levantaste? ({{ unidadConteo(l) }})</label>
                  <input [id]="'sr-q-' + l.id" class="sr-falta-input" type="number" [attr.inputmode]="modoTeclado(l)"
                         step="any" min="0" [attr.aria-describedby]="'sr-qh-' + l.id"
                         [ngModel]="borrador()" (ngModelChange)="borrador.set($event)"
                         (keydown.enter)="!guardando().has(l.id) && guardarFaltante(l)" (keydown.escape)="cerrarEditor()"
                         (wheel)="$any($event.target).blur()" autocomplete="off" />
                  <p class="sr-tip" [id]="'sr-qh-' + l.id" [class.sr-tip-bad]="borradorFueraDeRango(l)">
                    @if (borradorFueraDeRango(l)) { No puede ser más de {{ cantidadPrincipal(l) }}. }
                    @else { Entre 0 y {{ cantidadPrincipal(l) }}. }
                  </p>
                  <div class="sr-falta-acc">
                    <button pButton type="button" severity="secondary" [outlined]="true" class="sr-tap" (click)="cerrarEditor()">Cancelar</button>
                    <button pButton type="button" class="sr-tap" [disabled]="!borradorValido(l) || guardando().has(l.id)"
                            [loading]="guardando().has(l.id)" (click)="guardarFaltante(l)">Guardar</button>
                  </div>
                  <!-- Separado y a lo ancho: es la afirmación más fuerte ("no había NADA") y no se
                       debe tocar por error al buscar Guardar. -->
                  <button type="button" class="sr-nada" [disabled]="guardando().has(l.id)" (click)="noHabia(l)">
                    <i class="pi pi-times-circle" aria-hidden="true"></i> No había nada
                  </button>
                </div>
              } @else {
                <div class="sr-acc">
                  <button type="button" class="sr-btn sr-btn-ok" [id]="'sr-ok-' + l.id"
                          [disabled]="guardando().has(l.id)" (click)="completo(l)">
                    <i class="pi" [class.pi-check]="!guardando().has(l.id)" [class.pi-spin]="guardando().has(l.id)"
                       [class.pi-spinner]="guardando().has(l.id)" aria-hidden="true"></i>
                    <span>Completo</span>
                  </button>
                  <button type="button" class="sr-btn sr-btn-falta" [disabled]="guardando().has(l.id)" (click)="abrirFaltante(l)">
                    <i class="pi pi-minus-circle" aria-hidden="true"></i><span>Faltante</span>
                  </button>
                </div>
              }
            </article>
          } @else {
            <!-- Ya surtido: una línea. Queda EN SU LUGAR para que la lista no se mueva bajo el dedo. -->
            <article class="sr-hecho" [class.sr-hecho-falta]="l.status !== 'surtido'">
              <span class="sr-hecho-n">{{ l.product_name || l.sku }}</span>
              @switch (l.status) {
                @case ('surtido') { <p-tag severity="success" value="Completo"></p-tag> }
                @case ('agotado') { <p-tag severity="danger" value="No había"></p-tag> }
                @default { <p-tag severity="warn" [value]="faltaronTexto(l)"></p-tag> }
              }
              <button pButton type="button" [text]="true" class="sr-tap" (click)="abrirFaltante(l)"
                      [attr.aria-label]="'Corregir ' + (l.product_name || l.sku)">Corregir</button>
            </article>
          }
        }

        <footer class="sr-pie">
          <div class="sr-pie-n">
            @if (pendientesTotal()) {
              <span class="sr-pend">{{ plural(pendientesTotal(), 'renglón sin tocar', 'renglones sin tocar') }}</span>
            } @else {
              <span class="sr-pend sr-pend-cero">Todos tocados</span>
            }
            @if (conFaltante()) { · <span class="sr-falt">{{ plural(conFaltante(), 'con faltante', 'con faltante') }}</span> }
          </div>
          <button type="button" class="sr-btn sr-btn-go sr-btn-fin" [disabled]="pendientesTotal() > 0 || cerrando()" (click)="cerrar()">
            <i class="pi" [class.pi-check]="!cerrando()" [class.pi-spin]="cerrando()" [class.pi-spinner]="cerrando()" aria-hidden="true"></i>
            <span>Terminé de surtir</span>
          </button>
        </footer>
      }

      <!-- ─────────── CERRADA ─────────── -->
      @if (fase() === 'cerrada') {
        <section class="sr-card sr-listo">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <h2>Surtido terminado</h2>
          <p>
            {{ plural(resumen().completos, 'renglón completo', 'renglones completos') }}
            · {{ plural(resumen().faltantes, 'con faltante', 'con faltante') }}
          </p>
          @if (resumen().cambios.length) {
            <p class="sr-aviso">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              El pedido cambió en Kepler mientras surtías. Se repartió contra lo que surtiste; avísale a quien cheque:
            </p>
            <ul class="sr-lista-min">
              @for (c of resumen().cambios; track c) { <li>{{ c }}</li> }
            </ul>
          }
          <button type="button" class="sr-btn sr-btn-go" [disabled]="tomando()" (click)="tomar()">
            <i class="pi pi-play" aria-hidden="true"></i><span>Tomar siguiente</span>
          </button>
        </section>
      }
    </div>
  `,
  styles: [`
    .sr-page { max-width: 46rem; }
    .sr-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .sr-msg { display: flex; align-items: center; gap: .6rem; padding: 1.25rem; color: var(--text-muted); }
    /* Botones de texto de la pantalla: también del pulgar (pre-vuelo 11). */
    .sr-tap { min-height: var(--tap-min); }

    .sr-top { display: flex; align-items: center; gap: .75rem; margin-bottom: .5rem; }
    .sr-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .sr-top-mid strong { font-size: var(--fs-h3); }
    .sr-top-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .sr-top-prog { font-variant-numeric: tabular-nums; font-weight: 800; font-size: var(--fs-lg); }

    .sr-banda { display: flex; align-items: center; gap: .6rem; padding: .6rem .8rem; margin-bottom: .75rem;
      border-radius: var(--r-md); border: 1px solid currentColor; font-size: var(--fs-body); }
    .sr-banda-txt { flex: 1; }
    .sr-banda-bad { color: var(--bad-fg); }
    .sr-banda-warn { color: var(--warn-fg); }

    .sr-barra { height: 6px; border-radius: var(--r-pill); background: var(--surface-border); overflow: hidden; margin-bottom: .75rem; }
    /* transform y no width: no dispara layout (check-motion). */
    .sr-barra > span { display: block; width: 100%; height: 100%; background: var(--action);
      transform: scaleX(var(--fill, 0)); transform-origin: left center; transition: transform var(--dur-short) ease; }

    .sr-card { background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: var(--radius-lg); padding: 1.25rem; display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1rem; }
    .sr-l { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .sr-select { min-height: var(--tap-min); padding: .4rem .6rem; border: 1px solid var(--surface-border);
      border-radius: var(--r-sm); background: var(--surface-card); color: var(--text-main); font-size: var(--fs-body); }
    .sr-select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    .sr-chips { display: flex; flex-wrap: wrap; gap: .4rem; }
    .sr-chip { min-height: var(--tap-min); padding: .35rem .9rem; border-radius: var(--r-pill); cursor: pointer;
      border: 1px solid var(--surface-border); background: var(--surface-card); color: var(--text-main); font-size: var(--fs-body); }
    .sr-chip-on { border-color: var(--action); background: var(--surface-hover); font-weight: 700; }
    .sr-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    /* Botones del pulgar: igual que la pantalla hermana (contar camión) — ícono arriba, texto abajo. */
    .sr-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .3rem;
      min-height: 5.5rem; border-radius: var(--r-lg); border: 2px solid transparent;
      font-size: var(--fs-lg); font-weight: 800; cursor: pointer; transition: transform var(--dur-micro) ease; }
    .sr-btn i { font-size: var(--fs-h2); }
    .sr-btn:disabled { opacity: .55; cursor: not-allowed; }
    .sr-btn:not(:disabled):active { transform: scale(.98); }
    .sr-btn:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    /* --fs-h2 (20px, negrita) cuenta como texto grande: el blanco sobre --action pasa 3:1. */
    .sr-btn-go { background: var(--action); color: var(--action-ink); margin-top: .4rem; font-size: var(--fs-h2); }
    .sr-btn-go:not(:disabled):hover { background: var(--action-hover); }
    .sr-btn-go:not(:disabled):active { background: var(--action-press); }
    .sr-btn-ok { background: var(--ok-soft-bg); color: var(--ok-fg); border-color: var(--ok-fg); }
    .sr-btn-falta { background: var(--surface-card); color: var(--text-main); border-color: var(--surface-border); }
    .sr-btn-ok:not(:disabled):hover, .sr-btn-falta:not(:disabled):hover { filter: brightness(.97); }
    .sr-tip { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .sr-tip-ok { color: var(--ok-fg); font-size: var(--fs-body); font-weight: 600; margin: .25rem 0 .6rem; }
    .sr-tip-bad { color: var(--bad-fg); font-weight: 600; }
    .sr-sinhit { margin: .25rem 0 .6rem; font-size: var(--fs-body); color: var(--warn-fg); }

    .sr-vacio, .sr-listo { text-align: center; align-items: center; }
    .sr-vacio i, .sr-listo i { font-size: var(--fs-display); color: var(--text-muted); }
    .sr-listo i { color: var(--ok-fg); }
    .sr-listo .sr-btn i, .sr-vacio .sr-btn i { font-size: var(--fs-h2); color: inherit; }
    .sr-listo .sr-btn { align-self: stretch; }
    .sr-vacio h2, .sr-listo h2 { margin: .25rem 0; font-size: var(--fs-h2); }
    .sr-aviso { display: flex; gap: .4rem; align-items: flex-start; margin: .25rem 0 0; color: var(--warn-fg);
      font-size: var(--fs-body); text-align: left; }
    .sr-lista-min { margin: 0; padding-left: 1.2rem; text-align: left; font-size: var(--fs-body); }

    .sr-ola { display: flex; flex-direction: column; gap: .15rem; margin-bottom: .6rem; }
    .sr-ola-code { font-family: var(--font-mono); font-weight: 700; }
    .sr-ola-ped { font-size: var(--fs-xs); color: var(--text-muted); }

    .sr-buscar { display: flex; align-items: center; gap: .5rem; padding: .25rem .75rem; margin-bottom: .5rem;
      border: 1px solid var(--surface-border); border-radius: var(--r-md); background: var(--surface-card); }
    .sr-buscar i { color: var(--text-muted); }
    .sr-buscar-input { flex: 1; min-width: 0; min-height: var(--tap-min); border: 0; background: transparent;
      color: var(--text-main); font-size: var(--fs-body); }
    /* El campo vive dentro de una caja con borde; el anillo vuelve en :focus-visible. */
    .sr-buscar-input:focus { outline: none; }
    .sr-buscar-input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }

    .sr-filtro { display: flex; align-items: center; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
    .sr-h3 { margin: .75rem 0 .5rem; font-size: var(--fs-h3); display: flex; align-items: center; gap: .5rem; }
    .sr-n { font-size: var(--fs-body); color: var(--text-muted); font-variant-numeric: tabular-nums; }

    .sr-ren { background: var(--surface-card); border: 1px solid var(--surface-border); border-radius: var(--r-lg);
      padding: .9rem 1rem; margin-bottom: .6rem; display: flex; flex-direction: column; gap: .6rem; }
    .sr-ren-prod { display: flex; flex-direction: column; gap: .15rem; }
    .sr-ren-prod strong { font-size: var(--fs-lg); line-height: 1.25; }
    .sr-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    /* La cantidad es lo que se lee a un brazo de distancia: número grande, unidad un escalón abajo. */
    .sr-cant { display: flex; align-items: baseline; flex-wrap: wrap; gap: .4rem; }
    .sr-cant-n { font-size: var(--fs-display); font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
    .sr-cant-u { font-size: var(--fs-h2); font-weight: 800; }
    .sr-cant-b { flex-basis: 100%; font-size: var(--fs-body); color: var(--text-muted); }

    .sr-acc { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
    .sr-falta { display: flex; flex-direction: column; align-items: stretch; gap: .5rem; }
    .sr-falta-input { align-self: center; width: 100%; max-width: 16rem; text-align: center; font-size: var(--fs-display);
      font-weight: 900; font-variant-numeric: tabular-nums; padding: .3rem .6rem; border: 2px solid var(--action);
      border-radius: var(--r-md); background: var(--surface-card); color: var(--text-main); }
    .sr-falta-input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sr-falta .sr-tip { text-align: center; }
    .sr-falta-acc { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
    .sr-nada { margin-top: .75rem; padding-top: .75rem; min-height: var(--tap-min); width: 100%; display: flex;
      align-items: center; justify-content: center; gap: .5rem; border-radius: var(--r-md); cursor: pointer;
      border: 2px solid var(--bad-fg); background: var(--surface-card); color: var(--bad-fg);
      font-size: var(--fs-body); font-weight: 700; }
    .sr-nada:disabled { opacity: .55; cursor: not-allowed; }
    .sr-nada:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }

    /* Ya surtido: una línea, en su lugar. */
    .sr-hecho { display: flex; align-items: center; gap: .6rem; padding: .25rem .25rem .25rem .75rem; margin-bottom: .4rem;
      border-left: 4px solid var(--ok-fg); border-radius: var(--r-sm); background: var(--surface-card); }
    .sr-hecho-falta { border-left-color: var(--warn-fg); }
    .sr-hecho-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: var(--fs-body); color: var(--text-muted); }

    .sr-pie { position: sticky; bottom: 0; z-index: 5; display: flex; flex-direction: column; gap: .5rem; margin-top: 1rem;
      padding: .75rem 0 calc(.75rem + env(safe-area-inset-bottom));
      background: var(--surface-ground, var(--surface-card)); border-top: 1px solid var(--surface-border); }
    .sr-pie-n { font-size: var(--fs-body); color: var(--text-muted); text-align: center; }
    .sr-pend { font-weight: 800; color: var(--warn-fg); font-variant-numeric: tabular-nums; }
    .sr-pend-cero { color: var(--ok-fg); }
    .sr-falt { font-weight: 800; color: var(--warn-fg); }
    .sr-btn-fin { min-height: 4rem; margin-top: 0; }

    @media (prefers-reduced-motion: reduce) {
      .sr-barra > span, .sr-btn { transition: none; }
      .sr-btn:not(:disabled):active { transform: none; }
    }
  `],
})
export class AlmacenSurtirComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly comercial = inject(ComercialService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly plural = plural;
  readonly origenes: ReadonlyArray<{ v: Origen; l: string }> = [
    { v: '', l: 'Todos' },
    { v: 'TELEMARK', l: 'Telemarketing' },
    { v: 'SUCURSAL', l: 'Sucursal' },
  ];

  readonly fase = signal<'cargando' | 'listo' | 'surtiendo' | 'cerrada'>('cargando');
  readonly error = signal<string | null>(null);
  readonly enLinea = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  readonly almacenes = signal<Warehouse[]>([]);
  readonly almacenId = signal<string>('');
  readonly origen = signal<Origen>('');
  readonly ola = signal<PickerWave | null>(null);
  readonly sinTrabajo = signal<{ motivo: string; armado: KeplerWavesAutoResponse | null } | null>(null);
  /** Surtidos armados a mano que no se pudieron abrir (se liberaron): hay que avisar al supervisor. */
  readonly atoradas = signal<ReadonlyArray<{ code: string; motivo: string }>>([]);
  readonly tomando = signal(false);
  readonly cerrando = signal(false);
  readonly busqueda = signal('');
  readonly ocultarHechos = signal(false);
  /** Renglón con el teclado de faltante abierto. */
  readonly editando = signal<string | null>(null);
  readonly borrador = signal<number | null>(null);
  /** Renglones con un guardado en vuelo: sus botones se apagan para no mandar dos veces. */
  readonly guardando = signal<ReadonlySet<string>>(new Set());
  /** Lo último que pasó, para lectores de pantalla. */
  readonly anuncio = signal('');
  readonly resumen = signal<{ completos: number; faltantes: number; cambios: string[] }>({
    completos: 0, faltantes: 0, cambios: [],
  });

  readonly atoradasTexto = computed(() => this.atoradas().map((a) => `${a.code}: ${a.motivo}`).join(' · '));
  readonly almacenNombre = computed(() => this.almacenes().find((a) => a.id === this.almacenId())?.name ?? '');
  private readonly filtradas = computed(() => {
    const o = this.ola();
    if (!o) return [];
    const q = this.busqueda().trim();
    // ⚠️ `coincideBusqueda(consulta, ...campos)`: la consulta va PRIMERO. Al revés el buscador no
    // encontraba nada al escanear (lo atrapó la prueba de la pantalla).
    return q ? o.lines.filter((l) => coincideBusqueda(q, l.barcode, l.sku, l.product_name)) : o.lines;
  });
  /** Lo que se pinta, en el orden del servidor (estable: no se reacomoda al marcar). */
  readonly visibles = computed(() =>
    this.ocultarHechos() && !this.busqueda()
      ? this.filtradas().filter((l) => l.status === 'pendiente' || this.editando() === l.id)
      : this.filtradas(),
  );
  readonly pendientes = computed(() => this.filtradas().filter((l) => l.status === 'pendiente'));
  readonly hechas = computed(() => this.filtradas().filter((l) => l.status !== 'pendiente'));
  readonly hechos = computed(() => (this.ola()?.lines ?? []).filter((l) => l.status !== 'pendiente').length);
  readonly pendientesTotal = computed(() => (this.ola()?.lines ?? []).filter((l) => l.status === 'pendiente').length);
  readonly conFaltante = computed(
    () => (this.ola()?.lines ?? []).filter((l) => ['faltante', 'agotado', 'danado'].includes(l.status)).length,
  );

  ngOnInit(): void {
    if (typeof window !== 'undefined') {
      const on = (): void => this.enLinea.set(true);
      const off = (): void => this.enLinea.set(false);
      window.addEventListener('online', on);
      window.addEventListener('offline', off);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('online', on);
        window.removeEventListener('offline', off);
      });
    }
    this.iniciar();
  }

  /** Almacenes + la ola que la persona ya traía (si cerró la app a medias, la retoma). */
  iniciar(): void {
    this.error.set(null);
    this.fase.set('cargando');
    this.origen.set(this.leer(PREF_ORIGEN) as Origen);
    this.comercial.listWarehouses().subscribe({
      next: (ws) => {
        // Sólo sucursales Kepler (código de 2 dígitos): los pedidos U-D-40 salen de ahí.
        const suc = (ws || []).filter((w) => w.kind !== 'truck' && /^\d{2}$/.test(String(w.code ?? '')));
        this.almacenes.set(suc);
        const guardado = this.leer(PREF_ALMACEN);
        const delUsuario = this.auth.user()?.warehouse_code;
        const def =
          suc.find((w) => w.id === guardado) ?? (delUsuario ? suc.find((w) => w.code === delUsuario) : undefined);
        this.almacenId.set(def?.id ?? '');
        this.api.misOlas().subscribe({
          next: (olas) => {
            if (olas.length) {
              // Se retoma con "tomar siguiente" y NO pintando la ola tal cual: una ola asignada por
              // la consola puede venir sin arrancar (sin renglones) y "0 pendientes" habilitaba
              // cerrarla sin surtir nada. tomarSiguiente la arranca y devuelve sus renglones.
              this.almacenId.set(olas[0].warehouse_id);
              this.tomar();
            } else {
              this.fase.set('listo');
            }
          },
          error: () => {
            this.error.set('No se pudo revisar si ya traías un surtido.');
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

  /** Reintentar: si falta la lista de almacenes, se recarga todo; si no, se vuelve a pedir trabajo. */
  reintentar(): void {
    if (!this.almacenes().length) {
      this.iniciar();
      return;
    }
    this.error.set(null);
    this.tomar();
  }

  elegirAlmacen(id: string): void {
    this.almacenId.set(id);
    this.guardar(PREF_ALMACEN, id);
    this.sinTrabajo.set(null);
  }

  elegirOrigen(v: Origen): void {
    this.origen.set(v);
    this.guardar(PREF_ORIGEN, v);
    this.sinTrabajo.set(null);
  }

  tomar(): void {
    const almacen = this.almacenId();
    if (!almacen) {
      this.fase.set('listo');
      return;
    }
    this.tomando.set(true);
    this.sinTrabajo.set(null);
    this.api.tomarSiguiente({ warehouse_id: almacen, origen: this.origen() || undefined }).subscribe({
      next: (r) => {
        this.tomando.set(false);
        this.error.set(null);
        this.atoradas.set(r.atoradas ?? []);
        if (r.estado === 'asignada') {
          this.ola.set(r.ola);
          this.busqueda.set('');
          this.editando.set(null);
          this.ocultarHechos.set(false);
          this.fase.set('surtiendo');
          this.anuncio.set(`Surtido ${r.ola.code}: ${plural(r.ola.lines.length, 'renglón', 'renglones')}.`);
          if (r.ya_era_tuya) this.avisar('info', 'Sigues con el surtido que ya traías.');
        } else {
          this.sinTrabajo.set({ motivo: r.motivo, armado: r.armado });
          this.fase.set('listo');
        }
      },
      error: (e) => {
        this.tomando.set(false);
        // En la pantalla y no sólo en un aviso de 4 segundos: con guantes, el aviso se pierde.
        this.error.set(this.mensaje(e, 'No se pudo tomar trabajo.'));
        // Al RETOMAR (desde iniciar) la fase todavía es 'cargando': sin esto el spinner quedaba
        // para siempre.
        if (this.fase() === 'cargando') this.fase.set('listo');
      },
    });
  }

  completo(l: PickerWaveLine): void {
    this.marcar(l, l.qty_requested);
  }

  noHabia(l: PickerWaveLine): void {
    this.marcar(l, 0, 'agotado');
  }

  abrirFaltante(l: PickerWaveLine): void {
    this.borrador.set(null);
    this.editando.set(l.id);
    // El cursor ya en el número: se teclea mirando el producto, no la pantalla.
    setTimeout(() => (document.getElementById('sr-q-' + l.id) as HTMLInputElement | null)?.focus());
  }

  cerrarEditor(): void {
    this.editando.set(null);
  }

  /** Lo capturado viene en la unidad que ve el surtidor; se convierte a la base para guardar. */
  guardarFaltante(l: PickerWaveLine): void {
    if (!this.borradorValido(l)) return;
    const base = this.aBase(l, Number(this.borrador()));
    this.marcar(l, base, base === 0 ? 'agotado' : undefined);
  }

  borradorValido(l: PickerWaveLine): boolean {
    const v = this.borrador();
    if (v == null || (v as unknown) === '' || !Number.isFinite(Number(v)) || Number(v) < 0) return false;
    return this.aBase(l, Number(v)) <= l.qty_requested;
  }

  /** Para decir POR QUÉ "Guardar" está apagado, no sólo apagarlo. */
  borradorFueraDeRango(l: PickerWaveLine): boolean {
    const v = this.borrador();
    if (v == null || (v as unknown) === '' || !Number.isFinite(Number(v))) return false;
    return Number(v) < 0 || this.aBase(l, Number(v)) > l.qty_requested;
  }

  /**
   * Enter en el buscador (el escáner manda el código y un Enter): con UNA coincidencia pendiente,
   * el foco va a su "Completo". No lo marca solo: escanear la etiqueta no es haber contado.
   */
  enterBuscar(): void {
    const p = this.pendientes();
    if (p.length === 1) {
      (document.getElementById('sr-ok-' + p[0].id) as HTMLButtonElement | null)?.focus();
    }
  }

  limpiarBusqueda(): void {
    this.busqueda.set('');
    setTimeout(() => (document.getElementById('sr-buscar') as HTMLInputElement | null)?.focus());
  }

  cerrar(): void {
    const o = this.ola();
    if (!o || this.pendientesTotal() > 0) return;
    this.cerrando.set(true);
    this.api.finish(o.id).subscribe({
      next: (r) => {
        this.cerrando.set(false);
        this.resumen.set({
          completos: o.lines.filter((l) => l.status === 'surtido').length,
          faltantes: this.conFaltante(),
          cambios: r.cambios_en_kepler ?? [],
        });
        this.ola.set(null);
        this.fase.set('cerrada');
        this.anuncio.set('Surtido terminado.');
      },
      error: (e) => {
        this.cerrando.set(false);
        this.avisar('error', this.mensaje(e, 'No se pudo terminar el surtido.'));
      },
    });
  }

  /**
   * A `/almacen` y no al tablero de pedidos: el almacenista NO tiene `ALMACEN_PEDIDOS_VER` y el
   * guard lo rebotaría. `/almacen` lo manda a la primera pantalla que sí puede abrir.
   */
  salir(): void {
    this.router.navigateByUrl('/almacen');
  }

  // ── Cantidades ──────────────────────────────────────────────────────────────────────────

  /** La cantidad completa en texto: en la presentación de la hoja si existe; si no, en la base. */
  cantidadPrincipal(l: PickerWaveLine): string {
    return `${this.cantidadNumero(l)} ${this.unidadConteo(l)}`.trim();
  }

  cantidadNumero(l: PickerWaveLine): string {
    return this.tienePresentacion(l) ? this.fmt(Number(l.qty_presentacion)) : this.fmt(l.qty_requested);
  }

  /** La unidad base, debajo, sólo cuando la principal es la presentación y difieren. */
  cantidadBase(l: PickerWaveLine): string | null {
    if (!this.tienePresentacion(l)) return null;
    if (l.unidad_presentacion === l.qty_unit) return null;
    return `= ${this.fmt(l.qty_requested)} ${l.qty_unit ?? ''}`.trim();
  }

  unidadConteo(l: PickerWaveLine): string {
    return this.tienePresentacion(l) ? (l.unidad_presentacion ?? '') : (l.qty_unit ?? 'la unidad del pedido');
  }

  /** Teclado entero para cajas y bultos; con punto decimal sólo cuando se cuenta por peso. */
  modoTeclado(l: PickerWaveLine): 'numeric' | 'decimal' {
    return ['KG', 'GR', 'LT', 'L', 'G'].includes(this.unidadConteo(l).toUpperCase()) ? 'decimal' : 'numeric';
  }

  /** "Faltaron 1 de 3 BTO": dice cuánto FALTÓ, que es lo que importa al checar. */
  faltaronTexto(l: PickerWaveLine): string {
    if (l.qty_picked == null) return 'Faltante';
    const f = this.factor(l);
    const pedido = f ? Number(l.qty_presentacion) : l.qty_requested;
    const levantado = f ? l.qty_picked / f : l.qty_picked;
    const falta = Math.round((pedido - levantado) * 1000) / 1000;
    return `Faltaron ${this.fmt(falta)} de ${this.fmt(pedido)} ${this.unidadConteo(l)}`;
  }

  /** Hay presentación usable: con unidad y cantidad > 0 (una presentación en 0 se ignora). */
  private tienePresentacion(l: PickerWaveLine): boolean {
    return l.qty_presentacion != null && l.qty_presentacion > 0 && !!l.unidad_presentacion;
  }

  /**
   * Base por unidad de presentación (75 KG / 3 BTO = 25), o null si se cuenta en la base.
   * ⚠️ Es un PROMEDIO del renglón: con bultos de peso variable entre pedidos, un faltante
   * capturado en bultos se convierte con el peso medio, no con el de cada bulto.
   */
  private factor(l: PickerWaveLine): number | null {
    if (!this.tienePresentacion(l)) return null;
    return l.qty_requested / Number(l.qty_presentacion);
  }

  private aBase(l: PickerWaveLine, capturado: number): number {
    const f = this.factor(l);
    const base = f ? capturado * f : capturado;
    // Milésimas: la precisión de la base. Si capturó la presentación completa, es lo pedido exacto.
    if (f && Math.round(capturado * 1000) === Math.round(Number(l.qty_presentacion) * 1000)) return l.qty_requested;
    return Math.round(base * 1000) / 1000;
  }

  private fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toLocaleString('es-MX', { maximumFractionDigits: 3 });
  }

  // ── Guardado ────────────────────────────────────────────────────────────────────────────

  private marcar(l: PickerWaveLine, qty: number, status?: string): void {
    const o = this.ola();
    if (!o) return;
    this.guardando.update((s) => new Set([...s, l.id]));
    this.api.pick(o.id, l.id, { qty_picked: qty, status }).subscribe({
      next: (upd) => {
        this.quitarGuardando(l.id);
        this.editando.set(null);
        const venia = this.busqueda();
        this.ola.update((w) =>
          w
            ? {
                ...w,
                lines: w.lines.map((x) =>
                  x.id === l.id
                    ? { ...x, qty_picked: Number(upd.qty_picked), status: upd.status as PickerWaveLine['status'] }
                    : x,
                ),
              }
            : w,
        );
        const nombre = l.product_name || l.sku || 'Renglón';
        this.anuncio.set(
          upd.status === 'surtido' ? `${nombre}: completo.` : upd.status === 'agotado' ? `${nombre}: no había.` : `${nombre}: con faltante.`,
        );
        // Si llegó por el buscador (escaneó la etiqueta), se limpia y el foco vuelve ahí para
        // escanear el siguiente. Si no, el foco va al "Completo" del siguiente pendiente: el botón
        // que se tocó desaparece y, sin esto, el foco quedaría perdido en la página.
        if (venia) {
          this.limpiarBusqueda();
        } else {
          const siguiente = this.pendientes()[0];
          if (siguiente) {
            setTimeout(() => (document.getElementById('sr-ok-' + siguiente.id) as HTMLButtonElement | null)?.focus());
          }
        }
      },
      error: (e) => {
        this.quitarGuardando(l.id);
        this.avisar('error', this.mensaje(e, 'No se guardó. Vuelve a intentar.'));
        // 409 = el surtido ya no está abierto (lo cancelaron o ya se cerró): seguir en él dejaría
        // la pantalla sin salida. Se vuelve a "Tomar siguiente".
        if ((e as { status?: number })?.status === 409) {
          this.ola.set(null);
          this.fase.set('listo');
          this.error.set('Este surtido ya no está abierto. Toma el siguiente.');
        }
      },
    });
  }

  private quitarGuardando(id: string): void {
    this.guardando.update((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }

  private avisar(severity: 'info' | 'error', detail: string): void {
    this.toast.add({ severity, summary: severity === 'error' ? 'Error' : 'Aviso', detail, life: 5000 });
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
      /* sin almacenamiento local: sólo se pierde la preferencia, no el trabajo */
    }
  }
}
