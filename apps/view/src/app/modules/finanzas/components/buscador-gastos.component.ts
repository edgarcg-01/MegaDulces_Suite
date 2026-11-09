import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InputTextModule } from 'primeng/inputtext';
import { branchLabel } from '../../../core/constants/store-branches';
import { parseLocalDate } from '../../../core/utils/mx-date';
import type { ExpedienteDelDia } from '../comprobaciones.service';
import { BuscadorGastosEstado, MINIMO_BUSQUEDA_GASTOS } from './buscador-gastos.estado';


/** Cómo se dice el estado de un vale. La clave cruda es cómo se guarda, no cómo se dice. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma', aprobada: 'Aprobado · falta ejercer', revision: 'Falta revisarla',
  validada: 'Comprobado', rechazada: 'Rechazado',
};

/** Cómo se dice el estado de Kepler de una solicitud sin vale. */
const ESTADO_KEPLER_LABEL: Record<string, string> = {
  N: 'sin aplicar en Kepler', A: 'autorizada en Kepler', F: 'aplicada en Kepler · el dinero salió',
};

/**
 * `[GX.88]` — **El buscador de gastos**, compartido por Aprobación, Historial y Expediente.
 *
 * Pedido del usuario (2026-10-30): *«un buscador universal para los gastos, con folios, nombre,
 * quién lo levantó, quién aprobó»*, y después *«quiero el mismo buscador en historial y
 * expediente»*. Es UNO solo a propósito: tres copias del mismo buscador se separan a la
 * primera corrección.
 *
 * ## Qué hace y qué NO
 * Busca (en el servidor: `GET /finance/expenses/proofs/buscar`) y muestra lo encontrado:
 * los **vales** de cualquier fecha y estado, y aparte las **solicitudes de Kepler sin vale**.
 * Al elegir un vale lo pasa al estado (`BuscadorGastosEstado.aperturas$`): qué se puede hacer
 * con él lo decide la PÁGINA (en
 * Aprobación se decide; en Historial y Expediente sólo se consulta). Mismo criterio que el
 * visor del vale: este componente no conoce las acciones.
 *
 * ## ⛔ Sólo para quien aprueba
 * Deja ver el gasto de toda la empresa. Sin `FINANCE_EXPENSES_COMPROBAR` no se pinta nada, y el
 * servidor además responde 403.
 *
 * ## Dónde vive
 * Va UNA vez, arriba de las pestañas, en `GastosAreaShellComponent`, que provee el estado
 * (`BuscadorGastosEstado`). Las pantallas esconden lo suyo mientras `buscando()` es verdad: los
 * resultados las reemplazan, no se mezclan con ellas.
 */
@Component({
  selector: 'app-buscador-gastos',
  standalone: true,
  imports: [CommonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.es-caja]': "parte() === 'caja'" },
  template: `
    @if (puedeBuscar()) {
      @if (parte() !== 'resultados') {
      <div class="bg-caja" role="search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input pInputText type="search" class="bg-in" [value]="busqueda()"
               (input)="escribir($any($event.target).value)" (keydown.enter)="buscarYa()"
               (keydown.escape)="limpiar()"
               [placeholder]="parte() === 'caja' ? 'Buscar gastos: folio, proveedor, persona…' : 'Buscar en todos los gastos: folio, proveedor, quién lo levantó, quién lo aprobó, quién lo pidió…'"
               aria-label="Buscar en todos los gastos" />
        @if (busqueda()) {
          <button type="button" class="bg-x" (click)="limpiar()" aria-label="Limpiar la búsqueda">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        }
      </div>
      }

      @if (parte() !== 'caja' && buscando()) {
        @if (corta()) {
          <div class="bg-muted">Escribe al menos {{ minimo }} letras, o el folio.</div>
        } @else if (cargando() && !resultado()) {
          <div class="bg-muted">Buscando…</div>
        } @else if (error()) {
          <!-- Un error NO se pinta como «no hay resultados»: son dos afirmaciones distintas. -->
          <div class="bg-err">{{ error() }}</div>
        } @else if (resultado(); as r) {
          <section class="bg-res">
            <h2 class="bg-t">Vales <span class="bg-n">{{ r.vales.length }}{{ r.vales_truncado ? '+' : '' }}</span></h2>
            @if (r.vales_truncado) {
              <div class="bg-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>Hay más vales que coinciden. Escribe algo más preciso para verlos.</span></div>
            }
            @for (v of r.vales; track v.id) {
              <article class="bg-item" role="button" tabindex="0" [attr.aria-label]="'Ver el vale ' + v.folio_solicitud"
                       (click)="abrir(v)" (keydown.enter)="abrir(v)" (keydown.space)="abrir(v); $event.preventDefault()">
                <div class="bg-head">
                  <span class="bg-folio">{{ v.folio_solicitud || 'sin folio' }}</span>
                  @if (v.sucursal) { <span class="bg-faint">{{ branchLabel(v.sucursal) }}</span> }
                  @if (v.created_at) { <span class="bg-dia">{{ diaLocal(v.created_at) | date: 'dd/MM/yy' }}</span> }
                  <span class="bg-grow"></span>
                  <span class="bg-imp">{{ money(v.importe) }}</span>
                </div>
                <div class="bg-con">{{ v.concepto || v.proveedor || '—' }}</div>
                <div class="bg-meta">
                  <span class="bg-chip" [class.ok]="v.status === 'validada'" [class.warn]="v.status === 'revision'"
                        [class.bad]="v.status === 'rechazada'">{{ estado(v.status) }}</span>
                  @if (v.solicitante) { <span>la pidió {{ v.solicitante }}</span> }
                  <span>levantado por {{ v.created_by || '—' }}</span>
                  @if (v.validated_by) { <span>cerrado por {{ v.validated_by }}</span> }
                </div>
              </article>
            }
            @if (!r.vales.length) { <div class="bg-muted">Ningún vale coincide con «{{ r.q }}».</div> }
          </section>

          <section class="bg-res">
            <h2 class="bg-t">Solicitudes de Kepler sin vale <span class="bg-n">{{ r.sin_vale.length }}{{ r.sin_vale_truncado ? '+' : '' }}</span></h2>
            <!-- Se dice desde cuándo: antes de la Suite, una solicitud «sin vale» no es pendiente. -->
            @if (r.solicitudes_desde) {
              <p class="bg-faint">Nadie las subió a la Suite. Se buscan desde el {{ diaLocal(r.solicitudes_desde) | date: 'dd/MM/yy' }}, cuando empezó a usarse.</p>
            }
            @if (r.sin_vale_truncado) {
              <div class="bg-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>Puede haber más solicitudes que coinciden. Escribe algo más preciso.</span></div>
            }
            @for (s of r.sin_vale; track s.sucursal + '|' + s.folio) {
              <!-- La solicitud sin vale no se abre: no hay expediente que mirar. Se ve, no se clica. -->
              <article class="bg-item bg-sinvale">
                <div class="bg-head">
                  <span class="bg-folio">{{ s.folio }}</span>
                  <span class="bg-faint">{{ branchLabel(s.sucursal) }}</span>
                  @if (s.fecha) { <span class="bg-dia">{{ diaLocal(s.fecha) | date: 'dd/MM/yy' }}</span> }
                  <span class="bg-grow"></span>
                  <span class="bg-imp">{{ money(s.importe) }}</span>
                </div>
                <div class="bg-con">{{ s.concepto || s.beneficiario || '—' }}</div>
                <div class="bg-meta">
                  <span class="bg-chip bad">sin vale en la Suite</span>
                  <span class="bg-chip" [class.ok]="s.estado === 'F'">{{ estadoKepler(s.estado) }}</span>
                  <span>la pidió {{ s.solicitante || 'nadie (sin solicitante en Kepler)' }}</span>
                  @if (s.beneficiario) { <span>para {{ s.beneficiario }}</span> }
                </div>
              </article>
            }
            @if (!r.sin_vale.length) { <div class="bg-muted">Ninguna solicitud sin vale coincide.</div> }
          </section>
        }
      }
    }
  `,
  styles: [`
    :host { display: block; }
    /* [GX.101] En el encabezado de la pantalla, junto al título: crece hasta un ancho cómodo. */
    :host(.es-caja) { flex: 1 1 18rem; max-width: 30rem; margin-left: auto; }
    .bg-caja { position: relative; display: flex; align-items: center; }
    .bg-caja > .pi-search { position: absolute; left: var(--sp-3); color: var(--fg-3); pointer-events: none; }
    .bg-in { width: 100%; padding-left: calc(var(--sp-3) * 2 + 1rem); padding-right: 2.5rem; font-size: var(--fs-sm); }
    .bg-x { position: absolute; right: var(--sp-2); display: inline-flex; align-items: center; justify-content: center;
      min-width: var(--tap-min, 2rem); min-height: var(--tap-min, 2rem); border: 0; background: none;
      color: var(--fg-3); cursor: pointer; border-radius: var(--r-sm); }
    .bg-x:hover { color: var(--fg-1); }
    /* [GX.101] La tachita propia ya borra; la del navegador (type=search) era una segunda igual al lado. */
    .bg-in::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; display: none; }
    .bg-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .bg-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-3); }
    .bg-faint { font-size: var(--fs-xs); color: var(--fg-3); margin: 0; }
    .bg-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); margin-top: var(--sp-2); }
    .bg-aviso { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--warn-fg);
      background: var(--card-bg); border: 1px solid var(--warn-border); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .bg-res { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); }
    .bg-t { margin: 0; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em;
      color: var(--fg-3); font-weight: var(--fw-medium); }
    .bg-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg-2); }
    .bg-item { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: 3px; }
    .bg-item[role='button'] { cursor: pointer; transition: border-color .12s ease, background .12s ease; }
    .bg-item[role='button']:hover { border-color: var(--action); background: var(--hover-bg); }
    .bg-item[role='button']:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .bg-sinvale { border-style: dashed; }
    .bg-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .bg-grow { flex-grow: 1; }
    .bg-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .bg-dia { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-2);
      background: var(--layout-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 0 .3rem; }
    .bg-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .bg-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .bg-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .bg-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .bg-chip.ok { color: var(--ok-fg); border-color: var(--ok-border); }
    .bg-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .bg-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
  `],
})
export class BuscadorGastosComponent {
  /** El estado vive en el shell de Gastos: por eso lo escrito sobrevive al cambiar de pestaña. */
  private readonly e = inject(BuscadorGastosEstado);
  /**
   * `[GX.101]` Qué pieza pinta: la caja (va junto al título de cada pantalla), los resultados (van
   * debajo del encabezado y reemplazan a la pantalla) o las dos juntas. Las dos piezas leen el MISMO
   * estado: lo escrito en la caja es lo que buscan los resultados.
   */
  readonly parte = input<'todo' | 'caja' | 'resultados'>('todo');

  readonly branchLabel = branchLabel;
  readonly minimo = MINIMO_BUSQUEDA_GASTOS;
  readonly puedeBuscar = this.e.puedeBuscar;
  readonly busqueda = this.e.busqueda;
  readonly resultado = this.e.resultado;
  readonly cargando = this.e.cargando;
  readonly error = this.e.error;
  readonly buscando = this.e.buscando;
  readonly corta = this.e.corta;

  escribir(v: string): void { this.e.escribir(v); }
  buscarYa(): void { this.e.buscarYa(); }
  limpiar(): void { this.e.limpiar(); }
  /** El vale elegido. Qué se hace con él lo decide la pantalla de la pestaña activa. */
  abrir(v: ExpedienteDelDia): void { this.e.abrir(v); }

  /** La fecha ISO como `Date` local, para que el pipe no corra el día. */
  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }
  estado(s: string): string { return ESTADO_LABEL[s] ?? s; }
  estadoKepler(e: string | null | undefined): string {
    const k = String(e ?? '').trim().toUpperCase();
    return ESTADO_KEPLER_LABEL[k] ?? (k ? `estado ${k} en Kepler` : 'sin estado en Kepler');
  }
  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }
}
