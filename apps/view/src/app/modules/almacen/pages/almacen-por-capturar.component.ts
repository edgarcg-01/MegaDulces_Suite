import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import type { CapturaKeplerEstado, CapturaKeplerPedido, CapturaKeplerResponse } from '@megadulces/contracts';
import { PickingService } from '../../reparto/picking.service';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { branchName } from '../../../core/constants/store-branches';

type Filtro = 'pendientes' | CapturaKeplerEstado;

/** Se relee sola: Kepler llega con minutos de atraso y esto se usa con la pantalla abierta. */
const REFRESCO_MS = 60_000;

const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;

/** Orden de la lista: primero lo que alguien tiene que hacer, al final lo que ya quedó. */
const ORDEN: Record<CapturaKeplerEstado, number> = {
  por_capturar: 0,
  con_diferencias: 1,
  por_avanzar: 2,
  kepler_otro: 3,
  capturado: 4,
};

/**
 * `[GP.3d]` **Por capturar en Kepler**: la entrega del surtido a Facturación (`FASE_GP` §8.5).
 *
 * Lo que se surtió en la Suite se cierra en Kepler: Facturación corrige lo que no se encontró y pasa
 * el pedido a **SURTIDO**, que lo pone en la mesa de checado (decisión de Francisco, 2026-10-08).
 * Esta pantalla le dice qué tocar, renglón por renglón y en la unidad en que lo teclea en Kepler, y
 * **se da cuenta sola** cuando Kepler ya lo refleja. Sólo lectura: no hay botón "ya lo capturé".
 */
@Component({
  selector: 'app-almacen-por-capturar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head gp-head">
        <div class="gp-head-text">
          <h1>Por capturar en Kepler</h1>
          @if (data(); as d) {
            <span class="gp-meta">{{ keplerTexto(d) }} · se actualiza sola</span>
          }
        </div>
        <div class="gp-actions">
          @if (sucursalOpts().length > 2) {
            <p-select [options]="sucursalOpts()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (onChange)="sucursal.set($event.value)" ariaLabel="Sucursal" appendTo="body" class="gp-sel" />
          }
          <button pButton type="button" class="p-button-sm p-button-outlined gp-tap" [loading]="loading()" [disabled]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <p class="gp-rule"><i class="pi pi-info-circle" aria-hidden="true"></i><span>Lo que se surtió en la Suite se cierra en Kepler: <b>corrige lo que faltó</b> y pasa el pedido a <b>SURTIDO</b>. Cuando Kepler lo refleja, el pedido sale solo de esta lista y queda listo para checar.</span></p>

      @if (err(); as e) {
        <div class="gp-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="gp-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div>
      }

      @if (refrescoFallido(); as desde) {
        <div class="gp-note gp-note-warn" role="status"><i class="pi pi-wifi" aria-hidden="true"></i><span>No se pudo actualizar desde las {{ desde }}. Lo que ves puede estar atrasado; se vuelve a intentar solo.</span></div>
      }

      @if (loading() && !data()) { <div class="gp-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="gp-skel-row"></div> }</div> }

      @if (data(); as d) {
        @if (d.sin_alcance) {
          <div class="gp-note gp-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay pedidos que mostrarte. Pídele a Sistemas que te asigne tu sucursal.</span></div>
        } @else {
          <section class="gp-kpis" aria-label="Resumen">
            <button type="button" class="gp-kpi" [class.on]="filtro() === 'por_capturar'" [class.gp-kpi-warn]="cuenta('por_capturar') > 0" (click)="pick('por_capturar')" [attr.aria-pressed]="filtro() === 'por_capturar'"><span class="gp-kpi-v">{{ cuenta('por_capturar') }}</span><span class="gp-kpi-l">Corregir y pasar a SURTIDO</span></button>
            <button type="button" class="gp-kpi" [class.on]="filtro() === 'por_avanzar'" (click)="pick('por_avanzar')" [attr.aria-pressed]="filtro() === 'por_avanzar'"><span class="gp-kpi-v">{{ cuenta('por_avanzar') }}</span><span class="gp-kpi-l">Sólo pasar a SURTIDO</span></button>
            <button type="button" class="gp-kpi" [class.on]="filtro() === 'con_diferencias'" [class.gp-kpi-bad]="cuenta('con_diferencias') > 0" (click)="pick('con_diferencias')" [attr.aria-pressed]="filtro() === 'con_diferencias'"><span class="gp-kpi-v">{{ cuenta('con_diferencias') }}</span><span class="gp-kpi-l">En SURTIDO pero no cuadran</span></button>
            <button type="button" class="gp-kpi" [class.on]="filtro() === 'capturado'" (click)="pick('capturado')" [attr.aria-pressed]="filtro() === 'capturado'"><span class="gp-kpi-v">{{ cuenta('capturado') }}</span><span class="gp-kpi-l">Surtidos hoy, ya en Kepler</span></button>
            @if (cuenta('kepler_otro') > 0) {
              <button type="button" class="gp-kpi" [class.on]="filtro() === 'kepler_otro'" (click)="pick('kepler_otro')" [attr.aria-pressed]="filtro() === 'kepler_otro'"><span class="gp-kpi-v">{{ cuenta('kepler_otro') }}</span><span class="gp-kpi-l">En otro estatus en Kepler</span></button>
            }
          </section>

          <section class="gp-block dt-scope" aria-labelledby="gp-pc-h">
            <div class="gp-bh">
              <h2 id="gp-pc-h" tabindex="-1">{{ tituloLista() }}</h2>
              @if (filtro() !== 'pendientes') { <button type="button" class="gp-link" (click)="pick('pendientes')">Ver todo lo pendiente</button> }
            </div>
            @if (!visibles().length) {
              <div class="gp-empty"><i class="pi pi-check-circle" aria-hidden="true"></i><span>{{ vacioTexto() }}</span></div>
            } @else {
              <div class="gp-scroll">
                <table class="gp-table dt-stack">
                  <caption class="sr-only">Pedidos surtidos en la Suite y lo que falta hacer en Kepler</caption>
                  <thead>
                    <tr>
                      <th scope="col">Pedido</th>
                      <th scope="col">Destino</th>
                      <th scope="col">Surtido</th>
                      <th scope="col">Kepler</th>
                      <th scope="col">Qué hacer</th>
                      <th scope="col"><span class="sr-only">Detalle</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of visibles(); track p.order_id) {
                      <tr [class.gp-row-open]="abierto() === p.order_id">
                        <td class="dt-id" role="cell" data-label="Pedido">
                          <span class="mono gp-code">{{ p.code }}</span>
                          <span class="gp-sub muted">{{ origenTexto(p.origen) }}@if (multiSucursal()) { · {{ branchName(p.sucursal) }} }</span>
                        </td>
                        <td role="cell" data-label="Destino"><span class="gp-trunc">{{ p.destino || '—' }}</span></td>
                        <td role="cell" data-label="Surtido">
                          <span>{{ hace(p.surtido_at) }}</span>
                          @if (p.surtidores.length) { <span class="gp-sub muted">por {{ p.surtidores.join(', ') }}</span> }
                        </td>
                        <td class="mono" role="cell" data-label="Kepler">{{ p.estatus_kepler ?? 'no encontrado' }}</td>
                        <td role="cell" data-label="Qué hacer"><span class="gp-badge" [ngClass]="'gp-b-' + p.estado">{{ queHacer(p) }}</span></td>
                        <td class="dt-actions gp-acts" role="cell" data-label="Detalle">
                          <button pButton type="button" class="p-button-sm p-button-text" (click)="toggle(p)" [attr.aria-expanded]="abierto() === p.order_id" [attr.aria-controls]="abierto() === p.order_id ? 'gp-det-' + p.order_id : null"><span class="p-button-label">{{ abierto() === p.order_id ? 'Ocultar' : (p.estado === 'capturado' ? 'Ver detalle' : 'Ver qué tocar') }}</span></button>
                        </td>
                      </tr>
                      @if (abierto() === p.order_id) {
                        <tr class="gp-det-row">
                          <td colspan="6" role="cell" data-label="Detalle" [id]="'gp-det-' + p.order_id">
                            <p class="gp-det-t">{{ instruccion(p) }}</p>
                            @if (p.pendientes.length) {
                              <table class="gp-table gp-sub-table">
                                <caption class="sr-only">Renglones de {{ p.code }}</caption>
                                <thead>
                                  <tr>
                                    <th scope="col">Clave</th>
                                    <th scope="col">Producto</th>
                                    <th scope="col" class="ta-r">Pedido</th>
                                    <th scope="col" class="ta-r">Surtido</th>
                                    <th scope="col" class="ta-r">Kepler trae</th>
                                    <th scope="col" class="ta-r">Dejar en Kepler</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  @for (r of p.pendientes; track $index) {
                                    <tr>
                                      <td class="mono">{{ r.sku ?? '—' }}</td>
                                      <td>
                                        <span class="gp-trunc">{{ r.producto ?? '—' }}</span>
                                        @if (r.extra) { <span class="gp-sub gp-bad">La Suite no lo surtió</span> }
                                      </td>
                                      <td class="num ta-r">{{ r.extra ? '—' : cant(r.pedido) + ' ' + (r.unidad ?? '') }}</td>
                                      <td class="num ta-r">{{ r.extra ? '—' : cant(r.surtido) + ' ' + (r.unidad ?? '') }}</td>
                                      <td class="num ta-r" [class.gp-bad]="r.cuadra === false">{{ r.kepler === null ? 'sin dato' : cant(r.kepler) + ' ' + (r.unidad ?? '') }}</td>
                                      <td class="num ta-r">
                                        @if (r.extra || r.surtido === 0) { <b>Quitar el renglón</b> }
                                        @else { <b>{{ cant(r.surtido) }} {{ r.unidad ?? '' }}</b> }
                                        @if (r.renglones_kepler > 1) { <span class="gp-sub muted">Viene en {{ r.renglones_kepler }} renglones: el total debe quedar así</span> }
                                      </td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            }
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
              </div>
            }
            <p class="gp-foot">
              <span>Se revisan los surtidos de los últimos {{ d.dias }} días.</span>
              @if (d.capturados_antes) { <span>{{ plural(d.capturados_antes, 'pedido surtido en días anteriores ya está', 'pedidos surtidos en días anteriores ya están') }} en Kepler (no se listan).</span> }
              @if (d.sin_congelado) { <span>{{ plural(d.sin_congelado, 'surtido anterior', 'surtidos anteriores') }} a esta pantalla no se pueden comparar con Kepler.</span> }
            </p>
          </section>
        }
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
    .gp-note-bad { border-left:3px solid var(--bad-fg); }
    .gp-note-warn { border-left:3px solid var(--warn-fg); }
    .gp-note-warn .pi { color:var(--warn-fg); margin-top:.15rem; }
    .gp-tap { min-height:var(--tap-min); min-width:var(--tap-min); }
    #gp-pc-h:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .gp-note-bad .pi { color:var(--bad-fg); margin-top:.15rem; }
    .gp-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(10rem, 1fr)); gap:.5rem; margin:0 0 .75rem; }
    .gp-kpi { display:flex; flex-direction:column; align-items:flex-start; gap:.15rem; padding:.6rem .8rem; min-height:var(--tap-min); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font:inherit; text-align:left; cursor:pointer; }
    .gp-kpi.on { border-color:var(--text-main); box-shadow:inset 0 0 0 1px var(--text-main); }
    .gp-kpi:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .gp-kpi-v { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-h2); font-weight:700; line-height:1.1; }
    .gp-kpi-l { font-size:var(--fs-xs); color:var(--text-muted); }
    .gp-kpi-warn .gp-kpi-v { color:var(--warn-fg); }
    .gp-kpi-bad .gp-kpi-v { color:var(--bad-fg); }
    .gp-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .gp-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .gp-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .gp-scroll { overflow-x:auto; }
    .gp-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .gp-table th { text-align:left; font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); padding:.45rem .6rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .gp-table td { padding:.45rem .6rem; border-bottom:1px solid var(--border-color); vertical-align:top; }
    .gp-row-open td { border-bottom:0; }
    .gp-det-row > td { background:var(--hover-bg); }
    .gp-det-t { margin:0 0 .45rem; font-size:var(--fs-sm); font-weight:600; }
    .gp-sub-table { background:var(--card-bg); border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .gp-code { font-weight:600; }
    .gp-badge { display:inline-flex; align-items:center; padding:.1rem .5rem; border-radius:var(--r-pill); font-size:var(--fs-xs); font-weight:600; }
    .gp-b-por_capturar { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .gp-b-con_diferencias { background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .gp-b-por_avanzar, .gp-b-kepler_otro { background:var(--hover-bg); color:var(--text-main); }
    .gp-b-capturado { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .gp-acts { white-space:nowrap; text-align:right; }
    .gp-acts button { min-height:var(--tap-min); }
    .gp-trunc { display:block; max-width:18rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gp-sub { display:block; font-size:var(--fs-xs); }
    .gp-bad { color:var(--bad-fg); font-weight:600; }
    .gp-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; font-size:var(--fs-sm); text-decoration:underline; min-height:var(--tap-min); }
    .gp-link:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .gp-foot { display:flex; flex-wrap:wrap; gap:.25rem 1.1rem; margin:0; padding:.45rem .85rem; border-top:1px solid var(--border-color); font-size:var(--fs-xs); color:var(--text-muted); }
    :host ::ng-deep .gp-sel { min-width:11rem; }
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
export class AlmacenPorCapturarComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly skel = Array.from({ length: 6 });
  readonly plural = plural;
  readonly branchName = branchName;

  readonly data = signal<CapturaKeplerResponse | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly filtro = signal<Filtro>('pendientes');
  readonly sucursal = signal<string | null>(null);
  readonly abierto = signal<string | null>(null);
  private refrescando = false;
  /** Hora de la última lectura buena; se muestra si un refresco de fondo falla. */
  private leidoEn: Date | null = null;
  readonly refrescoFallido = signal<string | null>(null);

  readonly sucursalOpts = computed(() => {
    const suc = this.data()?.sucursales ?? [];
    return [{ label: 'Todas las sucursales', value: null as string | null }, ...suc.map((s) => ({ label: branchName(s), value: s as string | null }))];
  });
  readonly multiSucursal = computed(() => (this.data()?.sucursales.length ?? 0) > 1 && !this.sucursal());

  private readonly enSucursal = computed(() => {
    const s = this.sucursal();
    return (this.data()?.pedidos ?? []).filter((p) => !s || p.sucursal === s);
  });

  readonly visibles = computed(() => {
    const f = this.filtro();
    return this.enSucursal()
      .filter((p) => (f === 'pendientes' ? p.estado !== 'capturado' : p.estado === f))
      .sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || a.surtido_at.localeCompare(b.surtido_at));
  });

  readonly tituloLista = computed(() => {
    switch (this.filtro()) {
      case 'por_capturar': return 'Corregir y pasar a SURTIDO';
      case 'por_avanzar': return 'Sólo pasar a SURTIDO';
      case 'con_diferencias': return 'En SURTIDO pero no cuadran';
      case 'capturado': return 'Surtidos hoy, ya en Kepler';
      case 'kepler_otro': return 'En otro estatus en Kepler';
      default: return 'Pendientes en Kepler';
    }
  });

  ngOnInit(): void {
    this.reload();
    encuestarVisible(REFRESCO_MS, () => {
      // Con un detalle abierto no se relee: la lista se reordenaría bajo el dedo de quien la lee.
      if (!this.loading() && !this.refrescando && !this.abierto()) this.reload(true);
    }, { destroyRef: this.destroyRef, zone: this.zone });
  }

  reload(silencioso = false): void {
    if (silencioso) this.refrescando = true;
    else {
      this.loading.set(true);
      this.err.set(null);
    }
    this.api.porCapturar().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
        this.refrescando = false;
        this.err.set(null);
        this.leidoEn = new Date();
        this.refrescoFallido.set(null);
        // El detalle abierto de un pedido que ya salió de la lista se cierra y el foco va al título.
        const a = this.abierto();
        if (a && !d.pedidos.some((p) => p.order_id === a)) {
          this.abierto.set(null);
          setTimeout(() => document.getElementById('gp-pc-h')?.focus());
        }
      },
      error: (e: unknown) => {
        this.loading.set(false);
        this.refrescando = false;
        if (silencioso && this.data()) {
          // No tapa lo que ya se ve, pero tampoco se calla: dice desde cuándo no se actualiza.
          const t = this.leidoEn ?? new Date();
          this.refrescoFallido.set(t.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
          return;
        }
        this.err.set(this.mensaje(e, 'No se pudo leer la lista. Revisa tu conexión.'));
      },
    });
  }

  pick(f: Filtro): void {
    this.filtro.set(this.filtro() === f ? 'pendientes' : f);
    this.abierto.set(null);
  }

  toggle(p: CapturaKeplerPedido): void {
    this.abierto.set(this.abierto() === p.order_id ? null : p.order_id);
  }

  cuenta(e: CapturaKeplerEstado): number {
    return this.enSucursal().filter((p) => p.estado === e).length;
  }

  queHacer(p: CapturaKeplerPedido): string {
    const n = p.pendientes.length;
    switch (p.estado) {
      case 'por_capturar': return `Corregir ${plural(n, 'renglón', 'renglones')} y pasar a SURTIDO`;
      case 'por_avanzar': return 'Pasar a SURTIDO';
      case 'con_diferencias': return `Revisar: ${plural(n, 'renglón no cuadra', 'renglones no cuadran')}`;
      case 'capturado': return 'Listo';
      default: return p.estatus_kepler ? `Kepler lo trae en ${p.estatus_kepler}` : 'No se encontró en Kepler';
    }
  }

  instruccion(p: CapturaKeplerPedido): string {
    switch (p.estado) {
      case 'por_capturar': return `En Kepler, deja estos renglones de ${p.code} como se surtieron y pasa el pedido a SURTIDO:`;
      case 'por_avanzar': return `${p.code} salió completo: sólo pásalo a SURTIDO en Kepler.`;
      case 'con_diferencias': return `Kepler ya tiene ${p.code} en ${p.estatus_kepler}, pero estos renglones no traen lo que se surtió:`;
      case 'capturado': return `${p.code} ya está en Kepler como se surtió.`;
      default: return p.estatus_kepler
        ? `Kepler trae ${p.code} en ${p.estatus_kepler}: revisa si se canceló o se regresó.`
        : `No se encontró ${p.code} en Kepler.`;
    }
  }

  vacioTexto(): string {
    switch (this.filtro()) {
      case 'capturado': return 'Ningún surtido de hoy está ya en Kepler.';
      case 'por_capturar': return 'No hay pedidos con renglones por corregir.';
      case 'por_avanzar': return 'No hay pedidos completos esperando pasar a SURTIDO.';
      case 'con_diferencias': return 'Ningún pedido en SURTIDO tiene diferencias.';
      case 'kepler_otro': return 'Ningún pedido en otro estatus.';
      default: return 'No hay surtidos pendientes de capturar en Kepler.';
    }
  }

  origenTexto(o: string | null): string {
    if (o === 'TELEMARK') return 'Telemarketing';
    if (o === 'SUCURSAL') return 'Sucursal';
    return o ?? '—';
  }

  keplerTexto(d: CapturaKeplerResponse): string {
    // La frescura es de Kepler en general, no de cada sucursal: se dice así para no prometer más.
    if (!d.kepler_al) return 'Kepler: no se sabe de qué hora es';
    const min = Math.max(0, Math.round((Date.now() - new Date(d.kepler_al).getTime()) / 60000));
    return min < 1 ? 'Kepler (todas las sucursales) leído al momento' : `Kepler (todas las sucursales) leído hace ${min} min`;
  }

  cant(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  /** "hace 12 min", "hace 3 h", "hace 2 días". */
  hace(v: string): string {
    const ms = Date.now() - new Date(v).getTime();
    if (!Number.isFinite(ms)) return '—';
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const dias = Math.floor(h / 24);
    return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
  }

  private mensaje(e: unknown, def: string): string {
    const m = (e as { error?: { message?: unknown } })?.error?.message;
    return typeof m === 'string' && m ? m : def;
  }
}
