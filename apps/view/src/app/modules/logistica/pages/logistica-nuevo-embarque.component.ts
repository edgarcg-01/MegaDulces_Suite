import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { KeplerTripRow, LogisticaService } from '../logistica.service';

/** La fecha de HOY en la zona del navegador, como `YYYY-MM-DD` (no `toISOString`, que es UTC). */
export function hoyLocal(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Suma de dinero en centavos (los totales vienen como texto numérico desde la vista). */
export function sumarValor(rows: Array<Pick<KeplerTripRow, 'total'>>): number {
  return rows.reduce((a, r) => a + Math.round(Number(r.total || 0) * 100), 0) / 100;
}

/**
 * EMB.12 — «Nuevo embarque», paso 1: ELEGIR el viaje que almacén ya dio de salida en Kepler.
 *
 * El formulario anterior pedía a mano fecha, unidad, origen, destino, cajas, valor y chofer: todo
 * eso ya está en el documento de embarque de Kepler (U-D-41). Aquí no se captura nada: se elige
 * una guía y el paso 2 trae lo de Kepler en solo lectura y pide sólo lo que Kepler no tiene.
 *
 * Lo que Kepler no emite (una recolección, un viaje sin documento) sigue entrando por
 * «Embarque manual», que abre el formulario de siempre.
 */
@Component({
  selector: 'app-logistica-nuevo-embarque',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, SkeletonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page ne">
      <a routerLink="/logistica/shipments" class="ne-back"><i class="pi pi-arrow-left" aria-hidden="true"></i> Embarques</a>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Nuevo embarque</h1>
          <p class="surf-page-sub">Paso 1 de 2 · Elige el viaje que almacén ya dio de salida en Kepler. Lo que Kepler no trae lo capturas en el paso 2.</p>
        </div>
        <div class="ne-actions">
          <a pButton severity="secondary" [outlined]="true" size="small" routerLink="/logistica/shipments" [queryParams]="{ manual: 1 }">
            <span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span>
            <span class="p-button-label">Embarque manual</span>
          </a>
        </div>
      </header>

      <form class="ne-filters" (submit)="$event.preventDefault(); cargar()">
        <label class="ne-field">
          <span>Fecha</span>
          <input type="date" name="fecha" [ngModel]="fecha()" (ngModelChange)="fecha.set($event); cargar()" />
        </label>
        <label class="ne-field">
          <span>Sucursal</span>
          <select name="sucursal" [ngModel]="sucursal()" (ngModelChange)="sucursal.set($event || null); cargar()">
            @for (s of sucursales; track s.value) { <option [ngValue]="s.value">{{ s.label }}</option> }
          </select>
        </label>
        <label class="ne-check">
          <input type="checkbox" name="sinTomar" [ngModel]="soloSinTomar()" (ngModelChange)="soloSinTomar.set($event); cargar()" />
          Sólo viajes sin embarque en la Suite
        </label>
      </form>

      @if (!cargando() && rows().length) {
        <section class="sheet cols-12" aria-label="Resumen del día">
          <article class="cell cell-span-3">
            <span class="cell-label">Viajes (guías)</span>
            <span class="cell-value is-headline">{{ rows().length }}</span>
            <span class="cell-sub">{{ paradas() }} parada{{ paradas() === 1 ? '' : 's' }}</span>
          </article>
          <article class="cell cell-span-3">
            <span class="cell-label">Mercancía</span>
            <span class="cell-value">{{ valor() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
            <span class="cell-sub">mezcla venta (entregas) y costo (traspasos)</span>
          </article>
          <article class="cell cell-span-3">
            <span class="cell-label">Ya tomados</span>
            <span class="cell-value">{{ tomados() }}</span>
            <span class="cell-sub">con embarque en la Suite</span>
          </article>
          <article class="cell cell-span-3">
            <span class="cell-label">Sin chofer en Kepler</span>
            <span class="cell-value" [class.is-warn]="sinChofer() > 0">{{ sinChofer() }}</span>
            <span class="cell-sub">el chofer se elige en el paso 2</span>
          </article>
        </section>
      }

      <section class="ne-table-wrap dt-scope" aria-label="Viajes registrados en Kepler">
        @if (cargando()) {
          <p-skeleton height="16rem"></p-skeleton>
        } @else if (error()) {
          <div class="ne-empty">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <h3>No se pudo leer Kepler</h3>
            <p>{{ error() }}</p>
            <button pButton size="small" type="button" (click)="cargar()"><span class="p-button-label">Reintentar</span></button>
          </div>
        } @else if (!rows().length) {
          <div class="ne-empty">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <h3>Sin viajes para tomar</h3>
            <p>
              Kepler no tiene guías de embarque el {{ fecha() }}{{ sucursal() ? ' en la sucursal ' + sucursal() : '' }}{{ soloSinTomar() ? ' que falten de tomar' : '' }}.
            </p>
            <button pButton size="small" severity="secondary" [outlined]="true" type="button" (click)="diaAnterior()">
              <span class="p-button-label">Ver el día anterior</span>
            </button>
          </div>
        } @else {
          <table class="ne-table dt-stack">
            <thead>
              <tr>
                <th scope="col">Guía</th>
                <th scope="col">Tipo</th>
                <th scope="col" class="num">Paradas</th>
                <th scope="col">Destino</th>
                <th scope="col">Unidad</th>
                <th scope="col">Chofer</th>
                <th scope="col" class="num">Valor</th>
                <th scope="col">Estado</th>
                <th scope="col"><span class="sr-only">Acción</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.guia_digital) {
                <tr>
                  <td data-label="Guía" role="cell" class="dt-id">
                    <code class="ne-code">{{ r.guia_embarque }}</code>
                    <span class="ne-sub">{{ nombreSucursal(r.sucursal) }}</span>
                  </td>
                  <td data-label="Tipo" role="cell">{{ r.tipo_etiqueta || '—' }}</td>
                  <td data-label="Paradas" role="cell" class="num dt-num">{{ r.paradas }}</td>
                  <td data-label="Destino" role="cell" class="ne-dest">{{ r.destinos_texto || '—' }}</td>
                  <td data-label="Unidad" role="cell">
                    <span>{{ r.transporte_code || '—' }}{{ r.transporte_descripcion ? ' · ' + r.transporte_descripcion : '' }}</span>
                    <span class="ne-sub ne-mono">{{ r.vehicle_plate || r.transporte_placas || 'sin placa' }}</span>
                  </td>
                  <td data-label="Chofer" role="cell">
                    @if (r.chofer_falta) {
                      <span class="ne-pill is-warn">No viene en Kepler</span>
                    } @else {
                      <span>{{ r.chofer_nombre || r.chofer_code }}</span>
                    }
                  </td>
                  <td data-label="Valor" role="cell" class="num dt-num">{{ r.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td data-label="Estado" role="cell">
                    @if (r.tomado_folio) {
                      <span class="ne-pill is-ok">Tomado · {{ r.tomado_folio }}</span>
                    } @else if (r.chofer_falta) {
                      <span class="ne-pill is-warn">Falta chofer</span>
                    } @else {
                      <span class="ne-pill">Listo para tomar</span>
                    }
                  </td>
                  <td data-label="Acción" role="cell" class="dt-actions">
                    @if (r.tomado_shipment_id) {
                      <a pButton size="small" severity="secondary" [outlined]="true" [routerLink]="['/logistica/shipments', r.tomado_shipment_id]">
                        <span class="p-button-label">Ver embarque</span>
                      </a>
                    } @else {
                      <a pButton size="small" [routerLink]="['/logistica/shipments/nuevo', r.sucursal, r.guia_embarque]"
                         [attr.aria-label]="'Tomar el viaje ' + r.guia_digital">
                        <span class="p-button-label">Tomar viaje</span>
                      </a>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <p class="ne-foot">
            Un viaje es una guía de embarque de Kepler (kdm1.c86); cada documento U-D-41 dentro de ella es una parada.
            Kepler registra la salida, no la entrega: la entrega la confirma el chofer en la Suite.
          </p>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ne-back { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); color: var(--c-text-2); text-decoration: none; margin-bottom: .5rem; }
    .ne-back:hover { color: var(--c-text-1); }
    .ne-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .ne-filters { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; margin: .75rem 0; }
    .ne-field { display: flex; flex-direction: column; gap: .25rem; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .06em; color: var(--c-text-2); }
    .ne-field input, .ne-field select { height: 2.25rem; box-sizing: border-box; padding: 0 .6rem; border: 1px solid var(--c-divider); border-radius: var(--r-sm); background: var(--c-surface-1); color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); text-transform: none; letter-spacing: 0; min-width: 11rem; }
    .ne-field input:focus-visible, .ne-field select:focus-visible, .ne-check input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ne-check { display: inline-flex; align-items: center; gap: .5rem; height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .ne-check input { width: 1rem; height: 1rem; accent-color: var(--action); }
    .is-warn { color: var(--warn-soft-fg); }

    .ne-table-wrap { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md); padding: .5rem; overflow-x: auto; }
    .ne-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ne-table th { text-align: left; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); padding: .5rem; border-bottom: 1px solid var(--c-divider); white-space: nowrap; }
    .ne-table td { padding: .5rem; border-bottom: 1px solid var(--c-surface-2); vertical-align: top; }
    .ne-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ne-code, .ne-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ne-code { font-weight: var(--fw-bold); }
    .ne-sub { display: block; font-size: var(--fs-xs); color: var(--c-text-2); }
    .ne-dest { max-width: 18rem; }
    .ne-pill { display: inline-flex; align-items: center; padding: .1rem .5rem; border-radius: 999px; background: var(--c-surface-2); color: var(--c-text-1); font-size: var(--fs-xs); font-weight: var(--fw-medium); white-space: nowrap; }
    .ne-pill.is-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ne-pill.is-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .ne-foot { margin: .5rem .25rem 0; font-size: var(--fs-xs); color: var(--c-text-2); }
    .ne-empty { text-align: center; padding: 2.5rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .5rem; color: var(--c-text-2); }
    .ne-empty h3 { margin: 0; font-size: var(--fs-h3); color: var(--c-text-1); }
    .ne-empty p { margin: 0; font-size: var(--fs-sm); }
  `],
})
export class LogisticaNuevoEmbarqueComponent implements OnInit {
  private readonly api = inject(LogisticaService);

  readonly sucursales: Array<{ value: string | null; label: string }> = [
    { value: null, label: 'Todas' },
    { value: '00', label: '00 · CEDIS' },
    { value: '01', label: '01 · Padre Hidalgo' },
    { value: '02', label: '02 · La Piedad Abastos' },
    { value: '03', label: '03 · 8 Esquinas' },
    { value: '04', label: '04 · Yurécuaro' },
    { value: '05', label: '05 · Zamora Centro' },
    { value: '06', label: '06 · Canindo' },
    { value: '07', label: '07 · Morelia Madero' },
    { value: '08', label: '08 · Morelia Abastos' },
  ];

  readonly fecha = signal(hoyLocal());
  readonly sucursal = signal<string | null>(null);
  readonly soloSinTomar = signal(true);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly rows = signal<KeplerTripRow[]>([]);

  readonly paradas = computed(() => this.rows().reduce((a, r) => a + Number(r.paradas || 0), 0));
  readonly valor = computed(() => sumarValor(this.rows()));
  readonly tomados = computed(() => this.rows().filter((r) => !!r.tomado_folio).length);
  readonly sinChofer = computed(() => this.rows().filter((r) => r.chofer_falta && !r.tomado_folio).length);

  ngOnInit() { this.cargar(); }

  cargar() {
    this.cargando.set(true);
    this.error.set(null);
    this.api.listKeplerTrips({ fecha: this.fecha(), sucursal: this.sucursal(), solo_sin_tomar: this.soloSinTomar() })
      .subscribe({
        next: (r) => { this.rows.set(r.rows || []); this.cargando.set(false); },
        error: (e) => {
          this.rows.set([]);
          this.error.set(e?.error?.message || 'Intenta de nuevo en un momento.');
          this.cargando.set(false);
        },
      });
  }

  diaAnterior() {
    const [y, m, d] = this.fecha().split('-').map(Number);
    this.fecha.set(hoyLocal(new Date(y, m - 1, d - 1)));
    this.cargar();
  }

  nombreSucursal(code: string): string {
    return this.sucursales.find((s) => s.value === code)?.label ?? `Sucursal ${code}`;
  }
}
