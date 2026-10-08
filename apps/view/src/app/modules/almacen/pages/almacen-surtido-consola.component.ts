import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { type Observable, timer } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import type {
  ConsolaSurtidoAlmacen,
  ConsolaSurtidoDestino,
  ConsolaSurtidoOla,
  ConsolaSurtidoResponse,
  KeplerWavesAutoResponse,
} from '@megadulces/contracts';
import { PickingService } from '../../reparto/picking.service';

type Accion = { ola: string; tipo: 'urgente' | 'cancelar' | 'liberar' };

const PREF_CONSOLA = 'gp.consola.almacen';
/** Cada cuánto se relee la fila sola: el coordinador la tiene abierta mientras surten. */
const REFRESCO_MS = 30_000;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const dmy = (v: string): string => {
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/**
 * `[GP.3c.2]` **Consola de surtido** — quién prioriza la fila (`FASE_GP` §8.3).
 *
 * El surtidor sólo toca "Tomar siguiente" (`/almacen/surtir`) y no elige. El orden lo decide
 * desde aquí el coordinador (coordinador de embarques, encargado de tienda, supervisor), con su
 * permiso propio `ALMACEN_SURTIDO_COORDINAR`:
 *
 *  · la fila se ve en el MISMO orden en que la va a dar "Tomar siguiente": urgente → salida más
 *    próxima de sus destinos → lo más viejo. No hay otra regla escondida;
 *  · captura la hora de salida de cada destino del día (decisión de Francisco: la captura él);
 *  · marca urgente con motivo, libera un surtido de quien se fue, o lo cancela con motivo;
 *  · ajusta el umbral de la tanda y arma ya lo que Kepler tiene autorizado.
 *
 * Acciones con motivo o que le quitan trabajo a alguien piden confirmar EN LA FILA, no en un
 * diálogo: el coordinador ve qué surtido está tocando mientras confirma.
 */
@Component({
  selector: 'app-almacen-surtido-consola',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head gp-head">
        <div class="gp-head-text">
          <h1>Consola de surtido</h1>
          @if (data(); as d) {
            <span class="gp-meta">{{ nombreAlmacen() }} · hoy {{ dmy(d.fecha) }} · actualizado {{ horaLeida() }}</span>
          }
        </div>
        <div class="gp-actions">
          @if (almacenes().length > 1) {
            <p-select [options]="almacenes()" optionLabel="etiqueta" optionValue="id" [ngModel]="almacen()" (onChange)="pickAlmacen($event.value)" ariaLabel="Almacén" appendTo="body" class="gp-sel" />
          }
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" [disabled]="!almacen()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <p class="gp-rule"><i class="pi pi-sort-amount-down" aria-hidden="true"></i><span>"Tomar siguiente" da los surtidos en este orden: <b>urgentes</b>, luego la <b>salida más próxima</b> de sus destinos, luego <b>lo más viejo</b>.</span></p>

      @if (err(); as e) { <div class="gp-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="gp-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }
      @if (aviso(); as a) { <div class="gp-note" role="status"><i class="pi pi-check-circle" aria-hidden="true"></i><span>{{ a }}</span></div> }

      @if (sinAlmacen()) {
        <div class="gp-note gp-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>No tienes un almacén a tu cargo, así que no hay fila que mostrarte. Pide que te asignen tu sucursal en <b>Administración › Personas</b>.</span></div>
      }

      @if (loading() && !data() && !sinAlmacen()) { <div class="gp-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="gp-skel-row"></div> }</div> }

      @if (data(); as d) {
        <section class="gp-kpis" aria-label="Resumen de hoy">
          <div class="gp-kpi"><span class="gp-kpi-v">{{ porTomar() }}</span><span class="gp-kpi-l">Por tomar</span></div>
          <div class="gp-kpi"><span class="gp-kpi-v">{{ enSurtido() }}</span><span class="gp-kpi-l">En surtido</span></div>
          <div class="gp-kpi" [class.gp-kpi-warn]="urgentes() > 0"><span class="gp-kpi-v">{{ urgentes() }}</span><span class="gp-kpi-l">Urgentes</span></div>
          <div class="gp-kpi"><span class="gp-kpi-v">{{ d.por_armar.pedidos }}</span><span class="gp-kpi-l">Pedidos por armar</span></div>
          <div class="gp-kpi"><span class="gp-kpi-v">{{ d.surtidas_hoy }}</span><span class="gp-kpi-l">Terminados hoy</span></div>
        </section>

        <section class="gp-block" aria-labelledby="gp-fila-h">
          <div class="gp-bh"><h2 id="gp-fila-h">Fila de surtido</h2><span class="gp-meta">{{ d.olas.length }} {{ d.olas.length === 1 ? 'surtido' : 'surtidos' }} sin terminar</span></div>
          @if (!d.olas.length) {
            <div class="gp-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>No hay surtidos en la fila. Si Kepler tiene pedidos autorizados, ármalos abajo.</span></div>
          } @else {
            <div class="gp-scroll">
              <table class="gp-table">
                <caption class="sr-only">Surtidos en el orden en que se van a tomar</caption>
                <thead>
                  <tr>
                    <th scope="col" class="ta-r">#</th>
                    <th scope="col">Surtido</th>
                    <th scope="col">Destinos</th>
                    <th scope="col">Salida</th>
                    <th scope="col">Quién</th>
                    <th scope="col" class="ta-r">Avance</th>
                    <th scope="col">Desde</th>
                    <th scope="col"><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (o of d.olas; track o.id; let i = $index) {
                    <tr [class.gp-urg]="o.prioridad === 1">
                      <td class="num muted ta-r">{{ i + 1 }}</td>
                      <td>
                        <span class="mono gp-code">{{ o.code }}</span>
                        @if (o.prioridad === 1) { <span class="gp-badge gp-badge-warn">Urgente</span> }
                        <span class="gp-sub muted">{{ pedidosTexto(o) }}</span>
                        @if (o.prioridad === 1 && o.prioridad_motivo) { <span class="gp-sub gp-motivo">Motivo: {{ o.prioridad_motivo }}</span> }
                      </td>
                      <td><span class="gp-trunc">{{ o.destinos.length ? o.destinos.join(', ') : '—' }}</span></td>
                      <td class="mono">{{ o.hora_salida ?? '—' }}</td>
                      <td>
                        @if (o.assigned_nombre) { <span>{{ o.assigned_nombre }}</span> }
                        @else { <span class="muted">Libre</span> }
                      </td>
                      <td class="num ta-r">{{ o.tocados }} / {{ o.renglones }}</td>
                      <td class="muted">{{ hace(o.created_at) }}</td>
                      <td class="gp-acts">
                        @if (o.prioridad === 1) {
                          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="guardando()" (click)="quitarUrgente(o)"><span class="p-button-label">Quitar urgente</span></button>
                        } @else {
                          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="guardando()" (click)="abrir(o, 'urgente')"><span class="p-button-label">Urgente</span></button>
                        }
                        @if (o.assigned_to) {
                          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="guardando()" (click)="abrir(o, 'liberar')"><span class="p-button-label">Liberar</span></button>
                        }
                        <button pButton type="button" class="p-button-sm p-button-text p-button-danger" [disabled]="guardando()" (click)="abrir(o, 'cancelar')"><span class="p-button-label">Cancelar</span></button>
                      </td>
                    </tr>
                    @if (accion()?.ola === o.id) {
                      <tr class="gp-confirm-row">
                        <td colspan="8">
                          <div class="gp-confirm" role="group" [attr.aria-label]="tituloAccion(o)">
                            <span class="gp-confirm-t">{{ tituloAccion(o) }}</span>
                            @if (accion()?.tipo !== 'liberar') {
                              <input pInputText id="gp-motivo" class="gp-motivo-in" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" (keydown.enter)="confirmar(o)" (keydown.escape)="cerrar()" placeholder="Motivo (obligatorio)" aria-label="Motivo" maxlength="200" />
                            }
                            <button pButton type="button" class="p-button-sm" [class.p-button-danger]="accion()?.tipo === 'cancelar'" [loading]="guardando()" [disabled]="!puedeConfirmar()" (click)="confirmar(o)"><span class="p-button-label">{{ etiquetaConfirmar() }}</span></button>
                            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="guardando()" (click)="cerrar()"><span class="p-button-label">No</span></button>
                          </div>
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <div class="gp-grid">
          <section class="gp-block" aria-labelledby="gp-sal-h">
            <div class="gp-bh"><h2 id="gp-sal-h">Salidas de hoy</h2><span class="gp-meta">La hora ordena la fila</span></div>
            @if (!d.destinos.length) {
              <div class="gp-empty"><i class="pi pi-truck" aria-hidden="true"></i><span>Hoy no hay destinos con pedidos.</span></div>
            } @else {
              <div class="gp-scroll">
                <table class="gp-table">
                  <caption class="sr-only">Hora de salida por destino</caption>
                  <thead>
                    <tr>
                      <th scope="col">Destino</th>
                      <th scope="col" class="ta-r">Por armar</th>
                      <th scope="col" class="ta-r">En surtido</th>
                      <th scope="col">Sale a las</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of d.destinos; track s.destino_code) {
                      <tr>
                        <td><span class="gp-trunc">{{ s.destino_nombre || s.destino_code }}</span><span class="gp-sub mono muted">{{ s.destino_code }}</span></td>
                        <td class="num ta-r">{{ s.por_armar }}</td>
                        <td class="num ta-r">{{ s.en_surtido }}</td>
                        <td>
                          <div class="gp-hora">
                            <input type="time" class="gp-time" [attr.aria-label]="'Hora de salida de ' + (s.destino_nombre || s.destino_code)" [ngModel]="borrador(s)" (ngModelChange)="setBorrador(s, $event)" (keydown.enter)="guardarSalida(s)" />
                            @if (cambio(s)) {
                              <button pButton type="button" class="p-button-sm" [disabled]="guardando() || !horaValida(s)" (click)="guardarSalida(s)"><span class="p-button-label">Guardar</span></button>
                            } @else if (s.hora_salida) {
                              <button pButton type="button" class="p-button-sm p-button-text" [disabled]="guardando()" (click)="borrarSalida(s)" [attr.aria-label]="'Borrar la hora de ' + (s.destino_nombre || s.destino_code)"><span class="p-button-label">Borrar</span></button>
                            }
                          </div>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>

          <section class="gp-block" aria-labelledby="gp-arm-h">
            <div class="gp-bh"><h2 id="gp-arm-h">Por armar</h2></div>
            <div class="gp-step">
              @if (d.por_armar.pedidos) {
                <p class="gp-p"><b>{{ d.por_armar.pedidos }}</b> {{ d.por_armar.pedidos === 1 ? 'pedido autorizado' : 'pedidos autorizados' }} en Kepler sin surtido: <b>{{ d.por_armar.tanda }}</b> van en tanda y <b>{{ d.por_armar.individual }}</b> solos.</p>
              } @else {
                <p class="gp-p muted">Kepler no tiene pedidos autorizados pendientes de armar.</p>
              }
              @if (d.por_armar.bloqueados) {
                <p class="gp-p gp-warn">{{ d.por_armar.bloqueados }} no pueden armarse: traen claves que no están en el catálogo.</p>
              }
              @if (d.por_armar.atorados.count) {
                <p class="gp-p gp-warn">{{ d.por_armar.atorados.count }} siguen autorizados en Kepler desde {{ d.por_armar.atorados.desde ? dmy(d.por_armar.atorados.desde) : 'antes' }} y quedan fuera de la fila: revísalos en Kepler.</p>
              }
              <div class="gp-inline">
                <p-select [options]="origenOpts" optionLabel="label" optionValue="value" [ngModel]="origenArmar()" (onChange)="origenArmar.set($event.value)" ariaLabel="Origen de los pedidos a armar" appendTo="body" class="gp-sel" />
                <button pButton type="button" class="p-button-sm" [loading]="armando()" [disabled]="guardando() || !d.por_armar.pedidos" (click)="armar()"><span class="p-button-label">Armar surtidos ahora</span></button>
              </div>
              <p class="gp-hint">"Tomar siguiente" también los arma solo cuando la fila se vacía.</p>
            </div>
            <div class="gp-step">
              <h3 id="gp-umb-h">Tanda</h3>
              <div class="gp-inline">
                <label for="gp-umbral" class="gp-lbl">Pedidos de hasta</label>
                <input pInputText id="gp-umbral" type="number" min="1" max="50" inputmode="numeric" class="gp-num-in" [ngModel]="umbral()" (ngModelChange)="umbral.set(+$event)" (keydown.enter)="guardarUmbral()" />
                <span class="gp-lbl">renglones van juntos en una tanda.</span>
                @if (umbral() !== d.umbral_tanda) {
                  <button pButton type="button" class="p-button-sm" [disabled]="guardando() || !umbralValido()" (click)="guardarUmbral()"><span class="p-button-label">Guardar</span></button>
                }
              </div>
              @if (!umbralValido()) { <p class="gp-hint gp-warn">Escribe un número del 1 al 50.</p> }
              <p class="gp-hint">Aplica a los surtidos que se armen desde ahora; los ya armados no cambian.</p>
            </div>
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .gp-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .gp-head { align-items:center; margin-bottom:.5rem; }
    .gp-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .gp-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .gp-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .gp-rule { display:flex; gap:.5rem; align-items:flex-start; margin:0 0 .6rem; font-size:var(--fs-sm); color:var(--text-muted); }
    .gp-rule b { color:var(--text-main); font-weight:600; }
    .gp-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .gp-note .pi { color:var(--ok-fg); margin-top:.15rem; }
    .gp-note-bad { border-left:3px solid var(--bad-fg); }
    .gp-note-bad .pi { color:var(--bad-fg); }
    .gp-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(8.5rem, 1fr)); gap:.5rem; margin:0 0 .75rem; }
    .gp-kpi { display:flex; flex-direction:column; gap:.15rem; padding:.6rem .8rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .gp-kpi-v { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-h2); font-weight:700; line-height:1.1; }
    .gp-kpi-l { font-size:var(--fs-xs); color:var(--text-muted); }
    .gp-kpi-warn { border-left:3px solid var(--warn-fg); }
    .gp-kpi-warn .gp-kpi-v { color:var(--warn-fg); }
    .gp-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; margin-bottom:.75rem; }
    .gp-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .gp-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .gp-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(22rem, 1fr)); gap:.75rem; align-items:start; }
    .gp-grid .gp-block { margin-bottom:0; }
    .gp-scroll { overflow-x:auto; }
    .gp-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .gp-table th { text-align:left; font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); padding:.45rem .6rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .gp-table td { padding:.45rem .6rem; border-bottom:1px solid var(--border-color); vertical-align:top; }
    .gp-table tbody tr:last-child td { border-bottom:0; }
    .gp-urg td:first-child { box-shadow:inset 3px 0 0 var(--warn-fg); }
    .gp-code { font-weight:600; }
    .gp-badge { display:inline-flex; align-items:center; margin-left:.4rem; padding:0 .45rem; height:1.25rem; border-radius:var(--r-pill); font-size:var(--fs-nano); font-weight:700; text-transform:uppercase; letter-spacing:.03em; vertical-align:middle; }
    .gp-badge-warn { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .gp-motivo { color:var(--warn-soft-fg); }
    .gp-acts { white-space:nowrap; text-align:right; }
    .gp-confirm-row td { background:var(--hover-bg); }
    .gp-confirm { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; }
    .gp-confirm-t { font-weight:600; font-size:var(--fs-sm); }
    .gp-motivo-in { flex:1; min-width:14rem; height:2.25rem; }
    .gp-hora { display:flex; align-items:center; gap:.4rem; }
    .gp-time { height:2.25rem; min-height:var(--tap-min); padding:0 .5rem; border:1px solid var(--border-color); border-radius:var(--r-sm); background:var(--card-bg); color:var(--text-main); font:inherit; font-family:var(--font-mono); }
    .gp-time:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .gp-step { padding:.7rem .85rem; border-top:1px solid var(--border-color); }
    .gp-bh + .gp-step { border-top:0; }
    .gp-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .gp-p { margin:0 0 .45rem; font-size:var(--fs-sm); }
    .gp-inline { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin-top:.35rem; }
    .gp-lbl { font-size:var(--fs-sm); }
    .gp-num-in { width:4.5rem; height:2.25rem; font-family:var(--font-mono); text-align:right; }
    :host ::ng-deep .gp-sel { min-width:11rem; }
    .gp-trunc { display:block; max-width:18rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gp-sub { display:block; font-size:var(--fs-xs); }
    .gp-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:.45rem 0 0; }
    .gp-warn { color:var(--warn-soft-fg); }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .gp-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .gp-errbox .pi { color:var(--bad-fg); } .gp-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .gp-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .gp-empty .pi { font-size:var(--fs-lg); }
    .gp-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .gp-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:gp-pulse 1.4s ease-in-out infinite; }
    @keyframes gp-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .gp-skel-row { animation:none; } }
  `],
})
export class AlmacenSurtidoConsolaComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly destroyRef = inject(DestroyRef);

  readonly skel = Array.from({ length: 6 });
  readonly dmy = dmy;
  readonly origenOpts = [
    { label: 'Todos los orígenes', value: null },
    { label: 'Telemarketing', value: 'TELEMARK' },
    { label: 'Sucursal', value: 'SUCURSAL' },
  ];

  readonly almacenes = signal<Array<ConsolaSurtidoAlmacen & { etiqueta: string }>>([]);
  readonly almacen = signal<string | null>(null);
  readonly sinAlmacen = signal(false);
  readonly data = signal<ConsolaSurtidoResponse | null>(null);
  readonly leidoEn = signal<Date | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly armando = signal(false);

  readonly accion = signal<Accion | null>(null);
  readonly motivo = signal('');
  /** Hora tecleada y aún sin guardar, por destino. */
  readonly borradores = signal<Record<string, string>>({});
  readonly umbral = signal<number>(5);
  readonly origenArmar = signal<string | null>(null);

  readonly porTomar = computed(() => (this.data()?.olas ?? []).filter((o) => !o.assigned_to).length);
  readonly enSurtido = computed(() => (this.data()?.olas ?? []).filter((o) => !!o.assigned_to).length);
  readonly urgentes = computed(() => (this.data()?.olas ?? []).filter((o) => o.prioridad === 1).length);
  readonly nombreAlmacen = computed(() => {
    const a = this.almacenes().find((x) => x.id === this.almacen());
    return a ? a.etiqueta : '';
  });
  readonly horaLeida = computed(() => {
    const d = this.leidoEn();
    return d ? d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
  });
  readonly umbralValido = computed(() => Number.isInteger(this.umbral()) && this.umbral() >= 1 && this.umbral() <= 50);
  readonly puedeConfirmar = computed(() => {
    const a = this.accion();
    if (!a || this.guardando()) return false;
    return a.tipo === 'liberar' || this.motivo().trim().length >= 3;
  });
  readonly etiquetaConfirmar = computed(() => {
    switch (this.accion()?.tipo) {
      case 'urgente': return 'Marcar urgente';
      case 'liberar': return 'Sí, liberar';
      default: return 'Cancelar surtido';
    }
  });

  ngOnInit(): void {
    this.api.consolaAlmacenes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (lista) => {
        this.almacenes.set(lista.map((a) => ({ ...a, etiqueta: `${a.code} · ${a.nombre}` })));
        if (!lista.length) {
          this.sinAlmacen.set(true);
          return;
        }
        const guardado = this.leer(PREF_CONSOLA);
        this.almacen.set(lista.some((a) => a.id === guardado) ? guardado : lista[0].id);
        this.reload();
        // La fila cambia sola mientras surten: se relee, salvo a media acción del coordinador.
        timer(REFRESCO_MS, REFRESCO_MS).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
          if (!this.accion() && !this.guardando() && !this.armando() && !this.loading() && !this.hayBorradores()) {
            this.reload(true);
          }
        });
      },
      error: () => this.err.set('No se pudo leer qué almacenes manejas.'),
    });
  }

  pickAlmacen(id: string): void {
    this.almacen.set(id);
    this.guardar(PREF_CONSOLA, id);
    this.data.set(null);
    this.cerrar();
    this.borradores.set({});
    this.aviso.set(null);
    this.reload();
  }

  reload(silencioso = false): void {
    const id = this.almacen();
    if (!id) return;
    this.loading.set(true);
    if (!silencioso) this.err.set(null);
    this.api.consola(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        this.leidoEn.set(new Date());
        this.umbral.set(d.umbral_tanda);
        this.loading.set(false);
        this.err.set(null);
      },
      error: (e: unknown) => {
        this.loading.set(false);
        this.err.set(this.mensaje(e, 'No se pudo cargar la consola.'));
      },
    });
  }

  // ── Acciones sobre un surtido ────────────────────────────────────────────────────────────

  abrir(o: ConsolaSurtidoOla, tipo: Accion['tipo']): void {
    this.accion.set({ ola: o.id, tipo });
    this.motivo.set('');
    this.aviso.set(null);
    if (tipo !== 'liberar') setTimeout(() => document.getElementById('gp-motivo')?.focus());
  }

  cerrar(): void {
    this.accion.set(null);
    this.motivo.set('');
  }

  tituloAccion(o: ConsolaSurtidoOla): string {
    switch (this.accion()?.tipo) {
      case 'urgente': return `¿Por qué ${o.code} es urgente?`;
      case 'liberar': return `¿Quitarle ${o.code} a ${o.assigned_nombre ?? 'quien lo trae'}? Vuelve a la fila con lo ya marcado.`;
      default: return `¿Por qué se cancela ${o.code}? Sus pedidos vuelven a quedar por armar.`;
    }
  }

  confirmar(o: ConsolaSurtidoOla): void {
    const a = this.accion();
    if (!a || !this.puedeConfirmar()) return;
    const motivo = this.motivo().trim();
    const req: Observable<unknown> =
      a.tipo === 'urgente' ? this.api.consolaPrioridad(o.id, true, motivo)
      : a.tipo === 'liberar' ? this.api.consolaLiberar(o.id)
      : this.api.consolaCancelar(o.id, motivo);
    const hecho =
      a.tipo === 'urgente' ? `${o.code} quedó urgente: es el siguiente que se va a tomar.`
      : a.tipo === 'liberar' ? `${o.code} volvió a la fila.`
      : `${o.code} se canceló.`;
    this.ejecutar(req, hecho, () => this.cerrar());
  }

  quitarUrgente(o: ConsolaSurtidoOla): void {
    this.ejecutar(this.api.consolaPrioridad(o.id, false), `${o.code} ya no es urgente.`);
  }

  // ── Salidas de hoy ───────────────────────────────────────────────────────────────────────

  borrador(s: ConsolaSurtidoDestino): string {
    return this.borradores()[s.destino_code] ?? s.hora_salida ?? '';
  }

  setBorrador(s: ConsolaSurtidoDestino, v: string): void {
    this.borradores.update((b) => ({ ...b, [s.destino_code]: v ?? '' }));
  }

  cambio(s: ConsolaSurtidoDestino): boolean {
    const b = this.borradores()[s.destino_code];
    return b !== undefined && b !== (s.hora_salida ?? '') && b !== '';
  }

  horaValida(s: ConsolaSurtidoDestino): boolean {
    return HORA_RE.test(this.borrador(s));
  }

  guardarSalida(s: ConsolaSurtidoDestino): void {
    const id = this.almacen();
    if (!id || !this.cambio(s) || !this.horaValida(s) || this.guardando()) return;
    const hora = this.borrador(s);
    this.ejecutar(
      this.api.consolaSalida({ warehouse_id: id, destino_code: s.destino_code, destino_nombre: s.destino_nombre, hora_salida: hora }),
      `${s.destino_nombre || s.destino_code} sale a las ${hora}.`,
      () => this.soltarBorrador(s),
    );
  }

  borrarSalida(s: ConsolaSurtidoDestino): void {
    const id = this.almacen();
    if (!id || this.guardando()) return;
    this.ejecutar(
      this.api.consolaSalida({ warehouse_id: id, destino_code: s.destino_code, destino_nombre: s.destino_nombre, hora_salida: null }),
      `Se borró la hora de ${s.destino_nombre || s.destino_code}.`,
      () => this.soltarBorrador(s),
    );
  }

  // ── Por armar y tanda ────────────────────────────────────────────────────────────────────

  guardarUmbral(): void {
    const id = this.almacen();
    const d = this.data();
    if (!id || !d || !this.umbralValido() || this.umbral() === d.umbral_tanda || this.guardando()) return;
    const n = this.umbral();
    this.ejecutar(this.api.consolaUmbral(id, n), `Desde ahora, los pedidos de hasta ${n} renglones van en tanda.`);
  }

  armar(): void {
    const id = this.almacen();
    if (!id || this.armando() || this.guardando()) return;
    this.armando.set(true);
    this.aviso.set(null);
    this.err.set(null);
    this.api.consolaArmar(id, this.origenArmar() ?? undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.armando.set(false);
        this.aviso.set(this.resumenArmado(r));
        this.reload(true);
      },
      error: (e: unknown) => {
        this.armando.set(false);
        this.err.set(this.mensaje(e, 'No se pudieron armar los surtidos.'));
      },
    });
  }

  resumenArmado(r: KeplerWavesAutoResponse): string {
    const partes = [
      r.creadas.length === 1 ? 'Se armó 1 surtido' : `Se armaron ${r.creadas.length} surtidos`,
    ];
    if (r.fallidas.length) partes.push(`${r.fallidas.length} no se pudieron armar (otro los tomó antes)`);
    if (r.bloqueados.length) partes.push(`${r.bloqueados.length} pedidos traen claves fuera del catálogo`);
    if (r.vacios.length) partes.push(`${r.vacios.length} pedidos sin renglones`);
    return partes.join(' · ') + '.';
  }

  // ── Presentación ─────────────────────────────────────────────────────────────────────────

  pedidosTexto(o: ConsolaSurtidoOla): string {
    const n = o.pedidos.length;
    if (!n) return 'Sin pedidos';
    const tipo = n === 1 ? 'pedido' : 'pedidos en tanda';
    const muestra = o.pedidos.slice(0, 2).join(', ');
    return `${n} ${tipo}: ${muestra}${n > 2 ? ` y ${n - 2} más` : ''}`;
  }

  /** "hace 12 min", "hace 3 h", "hace 2 días". */
  hace(v: string): string {
    const ms = Date.now() - new Date(v).getTime();
    if (!Number.isFinite(ms)) return '—';
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const dias = Math.floor(h / 24);
    return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────────

  private ejecutar<T>(req: Observable<T>, hecho: string, despues?: () => void): void {
    this.guardando.set(true);
    this.aviso.set(null);
    this.err.set(null);
    req.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardando.set(false);
        despues?.();
        this.aviso.set(hecho);
        this.reload(true);
      },
      error: (e: unknown) => {
        this.guardando.set(false);
        this.err.set(this.mensaje(e, 'No se guardó. Vuelve a intentar.'));
      },
    });
  }

  private soltarBorrador(s: ConsolaSurtidoDestino): void {
    this.borradores.update((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== s.destino_code)));
  }

  private hayBorradores(): boolean {
    return (this.data()?.destinos ?? []).some((s) => this.cambio(s));
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
