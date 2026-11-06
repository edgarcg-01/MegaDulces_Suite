import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { VisitMonitorResponse } from '@megadulces/contracts';
import { SupervisorEquipoService } from '../supervisor-equipo.service';
import {
  type FilaEquipo,
  type Ventas,
  armarEquipo,
  avanceVisitas,
  diaAnterior,
  fechaCorta,
  motivoDeError,
  resumenEquipo,
} from '../supervisor-equipo';
import { todayMx } from '../../../core/utils/mx-date';

/** Cada cuánto se vuelve a pedir mientras la pantalla se ve (el GPS del equipo llega cada pocos minutos). */
const REFRESCO_MS = 60_000;

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[SUP.2]` **Mi equipo** — el supervisor de ruta ve cómo va su gente sin llamar a nadie: quién no ha
 * empezado, quién tiene faltas, cuántos clientes lleva cada uno, lo levantado y lo cobrado en Kepler.
 * Primero lo que pide acción. Al tocar a un vendedor, sus clientes uno por uno.
 */
@Component({
  selector: 'app-vendor-supervisor-equipo',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="eq">
      <header class="eq-head">
        <div>
          <h1>Mi equipo</h1>
          <span class="eq-sub">
            {{ dia()?.alcance?.etiqueta || 'Tu equipo' }}@if (cargadoEn()) { · {{ horaDe(cargadoEn()!) }} }
          </span>
        </div>
        <button type="button" class="eq-ref" (click)="cargar()" [disabled]="cargando()" aria-label="Actualizar">
          <i class="pi pi-refresh" [class.pi-spin]="cargando()" aria-hidden="true"></i>
        </button>
      </header>

      <div class="eq-dias" role="group" aria-label="Día">
        <button type="button" [attr.aria-pressed]="fecha() === hoy" (click)="verDia(hoy)">Hoy · {{ corta(hoy) }}</button>
        <button type="button" [attr.aria-pressed]="fecha() === ayer" (click)="verDia(ayer)">Ayer · {{ corta(ayer) }}</button>
      </div>

      @if (error()) {
        <div class="eq-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button type="button" (click)="cargar()">Reintentar</button>
        </div>
      } @else if (cargando() && !dia()) {
        <p class="eq-vacio">Cargando a tu equipo…</p>
      } @else if (!filas().length) {
        <div class="eq-vacio">
          <i class="pi pi-users" aria-hidden="true"></i>
          <p>Nadie de tu equipo tiene ruta {{ fecha() === hoy ? 'hoy' : 'ese día' }}.</p>
          <p class="eq-nota">Tu equipo son los vendedores que tienen tu nombre como supervisor.</p>
        </div>
      } @else {
        <!-- El veredicto del día antes de la lista. -->
        <div class="eq-res" aria-label="Resumen del día">
          <div class="eq-k">
            <span class="eq-kl">Empezaron</span>
            <b>{{ resumen().en_ruta }} de {{ resumen().vendedores }}</b>
            @if (resumen().sin_iniciar) { <span class="eq-ks warn">{{ resumen().sin_iniciar }} sin iniciar</span> }
          </div>
          <div class="eq-k">
            <span class="eq-kl">Clientes visitados</span>
            <b>{{ resumen().visitados }} de {{ resumen().clientes }}</b>
            <span class="eq-ks">{{ resumen().con_pedido }} con pedido</span>
          </div>
          <div class="eq-k">
            <span class="eq-kl">Faltas</span>
            <b [class.bad]="resumen().faltas > 0">{{ resumen().faltas }}</b>
            <span class="eq-ks">medidas con GPS</span>
          </div>
          <div class="eq-k">
            <span class="eq-kl">Levantado</span>
            @if (resumen().levantado !== null) { <b>{{ dinero(resumen().levantado) }}</b> } @else { <b class="nm">sin dato</b> }
            <span class="eq-ks">pedidos en la app</span>
          </div>
          <div class="eq-k eq-k2">
            <span class="eq-kl">Cobrado en Kepler</span>
            @if (resumen().cobrado !== null) {
              <b>{{ dinero(resumen().cobrado) }}</b>
            } @else {
              <b class="nm">sin medir</b>
              <span class="eq-ks">{{ resumen().cobrado_motivo }}</span>
            }
          </div>
        </div>

        <ul class="eq-lista">
          @for (f of filas(); track f.vendor.user_id) {
            <li>
              <a class="eq-card" [class.eq-card-bad]="f.prioridad === 0" [class.eq-card-warn]="f.prioridad === 1 || f.prioridad === 2"
                 [routerLink]="[f.vendor.user_id]" [queryParams]="{ date: fecha() }">
                <span class="eq-r1">
                  <strong>{{ f.vendor.name }}</strong>
                  <span [class]="'chip ' + estadoRuta(f).tono">{{ estadoRuta(f).texto }}</span>
                </span>
                <span class="eq-rutas">{{ f.vendor.routes.join(' · ') || 'Sin ruta' }}{{ horario(f) }}</span>
                @if (f.aviso) { <span class="eq-aviso" [class.bad]="f.prioridad === 0">{{ f.aviso }}</span> }
                <span class="eq-av">
                  <span class="eq-bar" aria-hidden="true"><span [style.width.%]="avance(f) ?? 0"></span></span>
                  <span>{{ f.vendor.counts.visitados }} de {{ f.vendor.counts.clientes }} clientes · {{ f.vendor.counts.con_pedido }} con pedido</span>
                </span>
                <span class="eq-din">
                  @switch (f.dinero.estado) {
                    @case ('medido') {
                      <span>Levantado <b>{{ dinero(f.dinero.levantado) }}</b></span>
                      <span>Cobrado @if (f.dinero.cobrado !== null) { <b>{{ dinero(f.dinero.cobrado) }}</b> } @else { <b class="nm">sin medir</b> }</span>
                      @if (f.dinero.avance !== null) { <span>Meta <b>{{ f.dinero.avance }} %</b></span> }
                    }
                    @case ('no_vecinal') { <span class="nm">Ruta no vecinal: sin venta por ruta</span> }
                    @default { <span class="nm">Venta sin dato</span> }
                  }
                </span>
              </a>
            </li>
          }
        </ul>
        @if (ventas(); as v) { @if (!v.ok) { <p class="eq-nota">La venta no se pudo leer: {{ v.motivo }}</p> } }
      }

      <a class="eq-cubrir" routerLink="/vendor/route-pick"><i class="pi pi-directions" aria-hidden="true"></i> Cubrir una ruta</a>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .eq { padding: var(--sp-4) var(--sp-4) var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-3); }
    .eq-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
    .eq-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; }
    .eq-sub, .eq-nota { font-size: var(--fs-xs); color: var(--text-muted); }
    .eq-nota { margin: 0; }
    .eq-ref { width: var(--tap-min); height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); cursor: pointer; }
    .eq-dias { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-1); padding: var(--sp-1); border-radius: var(--r-md);
      background: var(--overlay-hover); }
    .eq-dias button { min-height: var(--tap-min); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-muted);
      font-size: var(--fs-sm); font-weight: 700; cursor: pointer; }
    .eq-dias button[aria-pressed='true'] { background: var(--card-bg); color: var(--text-main); box-shadow: 0 0 0 1px var(--border-color); }
    .eq-ref:focus-visible, .eq-dias button:focus-visible, .eq-card:focus-visible, .eq-cubrir:focus-visible, .eq-err button:focus-visible {
      outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .eq-err { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); color: var(--bad-fg); }
    .eq-err button { margin-left: auto; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); cursor: pointer; }
    .eq-vacio { text-align: center; color: var(--text-muted); padding: var(--sp-8) var(--sp-4); }
    .eq-vacio i { font-size: var(--fs-display); color: var(--text-faint); }
    .eq-res { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }
    .eq-k { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); min-width: 0; }
    .eq-k2 { grid-column: span 2; }
    .eq-kl { font-size: var(--fs-xs); color: var(--text-muted); }
    .eq-k b { font-size: var(--fs-h3); font-variant-numeric: tabular-nums; }
    .eq-ks { font-size: var(--fs-xs); color: var(--text-muted); }
    .eq-ks.warn { color: var(--warn-fg); font-weight: 700; }
    b.bad, .eq-aviso.bad { color: var(--bad-fg); }
    .nm { color: var(--text-muted); font-weight: 600; }
    .eq-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .eq-card { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-lg); color: var(--text-main); text-decoration: none; }
    .eq-card-bad { border-left: 4px solid var(--bad-fg); }
    .eq-card-warn { border-left: 4px solid var(--warn-fg); }
    .eq-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .eq-r1 strong { font-size: var(--fs-body); min-width: 0; overflow-wrap: anywhere; }
    .eq-rutas { font-size: var(--fs-xs); color: var(--text-muted); }
    .eq-aviso { font-size: var(--fs-sm); font-weight: 700; color: var(--warn-fg); }
    .eq-av { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .eq-bar { height: 6px; border-radius: var(--r-pill); background: var(--overlay-active); overflow: hidden; }
    .eq-bar span { display: block; height: 100%; background: var(--ok-fg); }
    .eq-din { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .eq-din b { color: var(--text-main); font-variant-numeric: tabular-nums; }
    .chip { font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); white-space: nowrap; }
    .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .chip.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .chip.bad { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .chip.muted { background: var(--overlay-hover); color: var(--text-muted); }
    .eq-cubrir { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: var(--tap-min);
      border: 1px solid var(--border-color); border-radius: var(--r-md); color: var(--text-main); text-decoration: none; font-weight: 700; }
  `],
})
export class VendorSupervisorEquipoComponent implements OnInit {
  private readonly api = inject(SupervisorEquipoService);
  private readonly destroyRef = inject(DestroyRef);

  readonly hoy = todayMx();
  readonly ayer = diaAnterior(this.hoy);

  readonly fecha = signal(this.hoy);
  readonly dia = signal<VisitMonitorResponse | null>(null);
  readonly ventas = signal<Ventas | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<string | null>(null);

  readonly filas = computed<FilaEquipo[]>(() => armarEquipo(this.dia()?.vendors ?? [], this.ventas(), this.fecha() === this.hoy));
  readonly resumen = computed(() => resumenEquipo(this.filas()));

  ngOnInit(): void {
    this.cargar();
    const t = setInterval(() => { if (document.visibilityState === 'visible' && this.fecha() === this.hoy) this.cargar(true); }, REFRESCO_MS);
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  verDia(f: string): void {
    if (f === this.fecha()) return;
    this.fecha.set(f);
    this.dia.set(null);
    this.ventas.set(null);
    this.cargar();
  }

  cargar(silencioso = false): void {
    const f = this.fecha();
    if (!silencioso) this.cargando.set(true);
    this.api.dia(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        if (f !== this.fecha()) return;
        this.dia.set(d);
        this.cargando.set(false);
        this.error.set(null);
        this.cargadoEn.set(new Date().toISOString());
      },
      error: (e) => {
        if (f !== this.fecha()) return;
        this.cargando.set(false);
        this.error.set(motivoDeError(e, 'No se pudo cargar a tu equipo.'));
      },
    });
    // La venta es aparte: si falla, el equipo se ve igual y el dinero se declara sin dato.
    this.api.ventas(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => { if (f === this.fecha()) this.ventas.set({ ok: true, data }); },
      error: (e) => { if (f === this.fecha()) this.ventas.set({ ok: false, motivo: motivoDeError(e, 'No se pudo leer la venta.') }); },
    });
  }

  estadoRuta(f: FilaEquipo): { texto: string; tono: string } {
    switch (f.vendor.day_state) {
      case 'finalizada': return { texto: 'Terminó', tono: 'ok' };
      case 'en_ruta': return { texto: 'En ruta', tono: 'info' };
      default: return { texto: 'Sin iniciar', tono: this.fecha() === this.hoy ? 'warn' : 'muted' };
    }
  }

  horario(f: FilaEquipo): string {
    const a = f.vendor.started_at ? this.horaDe(f.vendor.started_at) : null;
    const b = f.vendor.finished_at ? this.horaDe(f.vendor.finished_at) : null;
    if (a && b) return ` · ${a}–${b}`;
    if (a) return ` · desde ${a}`;
    return '';
  }

  avance(f: FilaEquipo): number | null { return avanceVisitas(f.vendor); }
  corta(f: string): string { return fechaCorta(f); }
  dinero(n: number | null | undefined): string { return pesos.format(Number(n) || 0); }
  horaDe(iso: string): string { return hora.format(new Date(iso)); }
}
