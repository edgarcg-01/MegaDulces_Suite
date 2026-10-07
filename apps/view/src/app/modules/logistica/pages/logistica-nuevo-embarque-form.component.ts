import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  ConfigItem, Driver, LogisticaService, NuevoEmbarqueHoja, TomaKeplerBody,
} from '../logistica.service';
import { comisionesDeLaGuia, erroresDeTarifa } from '@megadulces/contracts';
import { datosDeKepler } from '../components/kepler-hoja.component';
import { KeplerParadasComponent } from '../components/kepler-paradas.component';

type Persona = 'driver' | 'helper1' | 'helper2';
type Comida = 'cafe' | 'desayuno' | 'comida' | 'cena';
export const COMIDAS: Comida[] = ['cafe', 'desayuno', 'comida', 'cena'];

export interface CapturaEmbarque {
  delivery_type: 'route' | 'long_trip' | null;
  driver_id: string | null;
  helper1_id: string | null;
  helper2_id: string | null;
  per_diem_total: number | null;
  overnight: boolean;
  freight_revenue: number | null;
  actual_km: number | null;
  total_weight_kg: number | null;
  notes: string;
}

/**
 * Lo que falta para poder crear, en una línea cada cosa. Es el mismo criterio que valida el
 * servidor (`validarToma` en libs/logistics): se repite aquí para que el botón diga por qué no
 * avanza, no para reemplazar al servidor — él decide.
 */
export function erroresDeCaptura(
  c: CapturaEmbarque,
  h: Pick<NuevoEmbarqueHoja, 'chofer' | 'tomado' | 'comision' | 'resumen'>,
): string[] {
  const e: string[] = [];
  if (h.tomado) e.push(`Este viaje ya se tomó en el embarque ${h.tomado.folio}.`);
  if (!c.delivery_type) e.push('Elige el tipo de entrega.');
  const chofer = c.driver_id || h.chofer.driver_id;
  if (!chofer) e.push('Elige al chofer.');
  if (chofer && (c.helper1_id === chofer || c.helper2_id === chofer)) e.push('El chofer no puede ir también como ayudante.');
  if (c.helper1_id && c.helper1_id === c.helper2_id) e.push('Ayudante 1 y ayudante 2 son la misma persona.');
  if (c.helper2_id && !c.helper1_id) e.push('Captura primero al ayudante 1.');
  const montos: Array<[number | null, string]> = [
    [c.per_diem_total, 'Los viáticos'],
    [c.freight_revenue, 'El flete cobrado'],
    [c.total_weight_kg, 'El peso'],
  ];
  for (const [v, etiqueta] of montos) {
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) e.push(`${etiqueta} no puede ser negativo.`);
  }
  if (c.actual_km != null && (!Number.isInteger(Number(c.actual_km)) || Number(c.actual_km) < 0)) {
    e.push('Los kilómetros deben ser un número entero.');
  }
  // La comisión se calcula de la tarifa de las rutas: si falta una, no se crea (misma regla que la API).
  e.push(...erroresDeTarifa(h.comision, h.resumen.paradas_sin_ruta, { helper1: !!c.helper1_id, helper2: !!c.helper2_id }));
  return e;
}

/** Total de viáticos desde el checklist persona × comida y las tarifas de `config_finance`. */
export function totalViaticos(
  marcas: Record<Persona, Record<Comida, boolean>>,
  tarifas: Record<Comida, number>,
  personas: Persona[],
): number {
  let t = 0;
  for (const p of personas) for (const m of COMIDAS) if (marcas[p]?.[m]) t += Math.round((tarifas[m] || 0) * 100);
  return t / 100;
}

/** El cuerpo que se manda: sólo lo que se capturó; null en lo que no se tocó. */
export function cuerpoDeToma(
  c: CapturaEmbarque,
  extra: { per_diem_breakdown?: unknown } = {},
): TomaKeplerBody {
  const num = (v: number | null) => (v == null || (v as unknown) === '' ? null : Number(v));
  return {
    delivery_type: c.delivery_type ?? 'route',
    driver_id: c.driver_id || null,
    helper1_id: c.helper1_id || null,
    helper2_id: c.helper2_id || null,
    per_diem_total: num(c.per_diem_total),
    ...(extra.per_diem_breakdown ? { per_diem_breakdown: extra.per_diem_breakdown } : {}),
    overnight: !!c.overnight,
    freight_revenue: num(c.freight_revenue),
    actual_km: num(c.actual_km),
    total_weight_kg: num(c.total_weight_kg),
    notes: c.notes?.trim() || null,
  };
}

/**
 * EMB.12 — «Nuevo embarque», paso 2: la HOJA DE EMBARQUE.
 *
 * Una sola hoja con las secciones del embarque manual. Lo que Kepler ya escribió (fecha, origen,
 * unidad, chofer, rutas, carga, almacén, paradas) viene lleno y bloqueado: no se edita aquí, se
 * corrige en Kepler. Los campos en blanco son lo que el coordinador teclea. El chofer sólo es
 * campo de captura cuando Kepler no lo trae; si lo trae, va bloqueado como lo demás.
 */
@Component({
  selector: 'app-logistica-nuevo-embarque-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, SkeletonModule, KeplerParadasComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page hj">
      <a routerLink="/logistica/shipments/nuevo" class="hj-back"><i class="pi pi-arrow-left" aria-hidden="true"></i> Viajes de Kepler</a>

      @if (cargando()) {
        <p-skeleton height="24rem"></p-skeleton>
      } @else if (errorCarga()) {
        <div class="hj-empty" role="alert">
          <h2>No se pudo abrir el viaje</h2>
          <p>{{ errorCarga() }}</p>
          <a pButton size="small" routerLink="/logistica/shipments/nuevo"><span class="p-button-label">Volver a la lista</span></a>
        </div>
      } @else if (hoja(); as h) {
        @let d = datos()!;
        <header class="surf-page-head">
          <div class="surf-page-head-text">
            <h1>Hoja de embarque · guía <code>{{ d.guia }}</code></h1>
            <p class="surf-page-sub">Paso 2 de 2 · {{ d.origen }}</p>
          </div>
          <div class="hj-actions">
            <a pButton severity="secondary" [outlined]="true" size="small" routerLink="/logistica/shipments/nuevo"><span class="p-button-label">Cancelar</span></a>
            <button pButton size="small" type="button" [disabled]="!puedeCrear()" [loading]="guardando()"
                    [attr.aria-describedby]="errores().length ? 'hj-faltan' : null" (click)="crear()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
              <span class="p-button-label">Crear embarque</span>
            </button>
          </div>
        </header>

        @if (h.tomado) {
          <div class="hj-banner" role="status">
            Este viaje ya se tomó en el embarque <b>{{ h.tomado.folio }}</b>.
            <a [routerLink]="['/logistica/shipments', h.tomado.id]">Ver embarque</a>
          </div>
        }

        <div class="hj-sheet">
          <section class="hj-sec" aria-labelledby="hj-s-gen">
            <h2 id="hj-s-gen">Datos generales</h2>
            <div class="hj-grid">
              <dl class="hj-f"><dt>Fecha</dt><dd class="hj-lock">{{ d.fecha ?? '—' }}</dd></dl>
              <dl class="hj-f"><dt>Guía</dt><dd class="hj-lock hj-mono">{{ d.guia }}</dd></dl>
              <dl class="hj-f"><dt>Origen</dt><dd class="hj-lock">{{ d.origen }}</dd></dl>
              <dl class="hj-f"><dt>Tipo</dt><dd class="hj-lock">{{ d.tipo }}</dd></dl>
              <fieldset class="hj-f hj-radios-f">
                <legend>Tipo de entrega</legend>
                <div class="hj-radios">
                  <label class="hj-radio" [class.act]="c.delivery_type === 'route'">
                    <input type="radio" name="tipo" value="route" [(ngModel)]="c.delivery_type" (ngModelChange)="tocar()" /> Por ruta
                  </label>
                  <label class="hj-radio" [class.act]="c.delivery_type === 'long_trip'">
                    <input type="radio" name="tipo" value="long_trip" [(ngModel)]="c.delivery_type" (ngModelChange)="tocar()" /> Viaje largo
                  </label>
                </div>
              </fieldset>
              <dl class="hj-f is-wide"><dt>Rutas</dt><dd class="hj-lock">{{ d.rutas ?? '—' }}</dd></dl>
            </div>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-uni">
            <h2 id="hj-s-uni">Unidad y tripulación</h2>
            <div class="hj-grid">
              <dl class="hj-f is-2"><dt>Unidad</dt><dd class="hj-lock">{{ d.unidad ?? '—' }}</dd></dl>
              <dl class="hj-f"><dt>Placas</dt><dd class="hj-lock hj-mono">{{ d.placas ?? '—' }}</dd></dl>
              @if (d.chofer) {
                <dl class="hj-f"><dt>Chofer</dt><dd class="hj-lock">{{ d.chofer }}</dd></dl>
              } @else {
                <label class="hj-f" for="hj-chofer">
                  <span>Chofer</span>
                  <select id="hj-chofer" name="chofer" [(ngModel)]="c.driver_id" (ngModelChange)="tocar()">
                    <option [ngValue]="null">Seleccionar</option>
                    @for (p of choferes(); track p.id) { <option [ngValue]="p.id">{{ p.full_name }}</option> }
                  </select>
                </label>
              }
              <label class="hj-f" for="hj-ay1">
                <span>Ayudante 1</span>
                <select id="hj-ay1" name="ay1" [(ngModel)]="c.helper1_id" (ngModelChange)="alElegirAyudante('helper1')">
                  <option [ngValue]="null">Sin ayudante</option>
                  @for (p of ayudantes(); track p.id) { <option [ngValue]="p.id">{{ p.full_name }}</option> }
                </select>
              </label>
              <label class="hj-f" for="hj-ay2">
                <span>Ayudante 2</span>
                <select id="hj-ay2" name="ay2" [(ngModel)]="c.helper2_id" (ngModelChange)="alElegirAyudante('helper2')" [disabled]="!c.helper1_id">
                  <option [ngValue]="null">Sin ayudante</option>
                  @for (p of ayudantes(); track p.id) { <option [ngValue]="p.id">{{ p.full_name }}</option> }
                </select>
              </label>
            </div>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-car">
            <h2 id="hj-s-car">Carga y flete</h2>
            <div class="hj-grid">
              <dl class="hj-f"><dt>Paradas</dt><dd class="hj-lock hj-num">{{ d.paradas }}</dd></dl>
              <dl class="hj-f"><dt>Cajas</dt><dd class="hj-lock hj-num">{{ d.cajas }}</dd></dl>
              <dl class="hj-f"><dt>Sueltos</dt><dd class="hj-lock hj-num">{{ d.sueltos }}</dd></dl>
              <dl class="hj-f"><dt>Valor de la mercancía</dt><dd class="hj-lock hj-num">{{ d.valor }}</dd></dl>
              @if (d.traspaso) {
                <dl class="hj-f"><dt>Traspaso a costo</dt><dd class="hj-lock hj-num">{{ d.traspaso }}</dd></dl>
              }
              <label class="hj-f" for="hj-peso">
                <span>Peso total (kg)</span>
                <input id="hj-peso" class="hj-txt" type="number" min="0" step="0.01" name="peso" [(ngModel)]="c.total_weight_kg" (ngModelChange)="tocar()" placeholder="kg" />
              </label>
              <label class="hj-f" for="hj-km">
                <span>Kilómetros</span>
                <input id="hj-km" class="hj-txt" type="number" min="0" step="1" name="km" [(ngModel)]="c.actual_km" (ngModelChange)="tocar()" placeholder="km" />
              </label>
              <label class="hj-f" for="hj-flete">
                <span>Flete cobrado</span>
                <input id="hj-flete" class="hj-txt" type="number" min="0" step="0.01" name="flete" [(ngModel)]="c.freight_revenue" (ngModelChange)="tocar()" placeholder="0.00" />
              </label>
            </div>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-com">
            <h2 id="hj-s-com">Comisiones y viáticos</h2>
            <div class="hj-grid">
              @let k = comisiones();
              <dl class="hj-f"><dt>Comisión chofer</dt><dd class="hj-lock hj-num">{{ k ? (k.driver_commission | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd></dl>
              <dl class="hj-f"><dt>Comisión ayudante 1</dt><dd class="hj-lock hj-num">{{ k && c.helper1_id ? (k.helper1_commission | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd></dl>
              <dl class="hj-f"><dt>Comisión ayudante 2</dt><dd class="hj-lock hj-num">{{ k && c.helper2_id ? (k.helper2_commission | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd></dl>
            </div>
            @if (hayTarifas()) {
              <div class="hj-table-wrap">
                <table class="hj-pd">
                  <caption class="sr-only">Viáticos por persona y comida</caption>
                  <thead>
                    <tr><th scope="col">Persona</th>
                      @for (m of comidas; track m) { <th scope="col">{{ etiquetaComida(m) }}<span class="hj-rate">{{ tarifas()[m] | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></th> }
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of personasViaje(); track p.key) {
                      <tr>
                        <th scope="row">{{ p.label }}</th>
                        @for (m of comidas; track m) {
                          <td><input type="checkbox" [attr.aria-label]="etiquetaComida(m) + ' ' + p.label" [ngModel]="marcas[p.key][m]" (ngModelChange)="marcar(p.key, m, $event)" /></td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            <div class="hj-grid">
              <label class="hj-f" for="hj-pd">
                <span>Viáticos</span>
                <input id="hj-pd" class="hj-txt" type="number" min="0" step="0.01" name="pd" [(ngModel)]="c.per_diem_total" (ngModelChange)="tocar()" [readonly]="hayTarifas()" placeholder="0.00" />
              </label>
              <label class="hj-check" for="hj-pern">
                <input id="hj-pern" type="checkbox" name="pern" [(ngModel)]="c.overnight" (ngModelChange)="tocar()" /> Pernocta
              </label>
            </div>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-alm">
            <h2 id="hj-s-alm">Almacén</h2>
            <div class="hj-grid">
              <dl class="hj-f"><dt>Surtió</dt><dd class="hj-lock">{{ d.surtio ?? '—' }}</dd></dl>
              <dl class="hj-f"><dt>Checó</dt><dd class="hj-lock">{{ d.checo ?? '—' }}</dd></dl>
              <dl class="hj-f"><dt>Embarcó</dt><dd class="hj-lock">{{ d.embarco ?? '—' }}</dd></dl>
            </div>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-par">
            <h2 id="hj-s-par">Paradas</h2>
            <app-kepler-paradas [hoja]="h"></app-kepler-paradas>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-not">
            <h2 id="hj-s-not">Notas</h2>
            <label class="hj-f" for="hj-notas">
              <span class="sr-only">Notas</span>
              <textarea id="hj-notas" name="notas" rows="2" [(ngModel)]="c.notes" (ngModelChange)="tocar()"></textarea>
            </label>
          </section>

          <footer class="hj-foot">
            @if (errores().length) {
              <div class="hj-faltan">
                <p class="hj-faltan-titulo">Para crear el embarque falta:</p>
                <ul id="hj-faltan" role="status">
                  @for (e of errores(); track e) { <li>{{ e }}</li> }
                </ul>
              </div>
            }
            @if (errorServidor()) { <p class="hj-error" role="alert">{{ errorServidor() }}</p> }
            <button pButton type="button" [disabled]="!puedeCrear()" [loading]="guardando()"
                    [attr.aria-describedby]="errores().length ? 'hj-faltan' : null" (click)="crear()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
              <span class="p-button-label">Crear embarque</span>
            </button>
          </footer>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .hj-back { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); color: var(--c-text-2); text-decoration: none; margin-bottom: .5rem; }
    .hj-back:hover { color: var(--c-text-1); }
    .surf-page-head h1 code { font-family: var(--font-mono); }
    .hj-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .hj-banner { padding: .6rem .8rem; border-radius: var(--r-sm); font-size: var(--fs-sm); margin: .5rem 0; background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .hj-banner a { margin-left: .5rem; }

    .hj-sheet { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md); }
    .hj-sec { padding: 1rem; border-bottom: 1px solid var(--c-divider); display: flex; flex-direction: column; gap: .75rem; }
    .hj-sec h2 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .hj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .75rem; }

    .hj-f { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-direction: column; gap: .3rem; }
    .hj-f.is-wide { grid-column: 1 / -1; }
    .hj-f.is-2 { grid-column: span 2; }
    .hj-f dt, .hj-f > span, .hj-f legend { padding: 0; font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--c-text-2); }
    .hj-f dd { margin: 0; }
    .hj-lock, .hj-txt, .hj-f select, .hj-f textarea { min-height: 2.25rem; box-sizing: border-box; padding: .4rem .6rem; border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); color: var(--c-text-1); }
    .hj-lock { background: var(--c-surface-2); border: 1px solid transparent; overflow-wrap: anywhere; }
    .hj-txt, .hj-f select, .hj-f textarea { width: 100%; background: var(--c-surface-1); border: 1px solid var(--c-divider); }
    .hj-txt:disabled, .hj-f select:disabled { opacity: .55; }
    .hj-txt:focus-visible, .hj-f select:focus-visible, .hj-f textarea:focus-visible,
    .hj-radio input:focus-visible, .hj-check input:focus-visible, .hj-pd input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .hj-mono { font-family: var(--font-mono); }
    .hj-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .hj-radios { display: flex; flex-wrap: wrap; gap: .5rem; }
    .hj-radio { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: 0 .75rem; border: 1px solid var(--c-divider); border-radius: var(--r-sm); font-size: var(--fs-sm); cursor: pointer; }
    .hj-radio.act { border-color: var(--action); background: var(--ember-soft); }
    .hj-radio input, .hj-check input, .hj-pd input { accent-color: var(--action); }
    .hj-check { display: inline-flex; align-items: center; gap: .5rem; align-self: end; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }

    .hj-table-wrap { overflow-x: auto; }
    .hj-pd { border-collapse: collapse; font-size: var(--fs-sm); }
    .hj-pd th, .hj-pd td { padding: .35rem .6rem; text-align: center; }
    .hj-pd th[scope="row"] { text-align: left; font-weight: var(--fw-medium); }
    .hj-pd thead th { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); font-weight: var(--fw-medium); }
    .hj-rate { display: block; font-family: var(--font-mono); text-transform: none; letter-spacing: 0; }

    .hj-foot { padding: 1rem; display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: center; justify-content: flex-end; }
    .hj-faltan { margin-right: auto; font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    .hj-faltan-titulo { margin: 0 0 .2rem; font-weight: var(--fw-bold); }
    .hj-faltan ul { margin: 0; padding-left: 1rem; }
    .hj-error { margin: 0 auto 0 0; font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    .hj-empty { text-align: center; padding: 3rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .5rem; }
    .hj-empty h2 { margin: 0; font-size: var(--fs-h3); }
    @media (max-width: 40rem) { .hj-f.is-2 { grid-column: 1 / -1; } }
  `],
})
export class LogisticaNuevoEmbarqueFormComponent implements OnInit {
  private readonly api = inject(LogisticaService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly comidas = COMIDAS;
  readonly cargando = signal(true);
  readonly guardando = signal(false);
  readonly errorCarga = signal<string | null>(null);
  readonly errorServidor = signal<string | null>(null);
  readonly hoja = signal<NuevoEmbarqueHoja | null>(null);
  readonly personas = signal<Driver[]>([]);
  readonly tarifas = signal<Record<Comida, number>>({ cafe: 0, desayuno: 0, comida: 0, cena: 0 });
  /** Señal de «algo cambió en la captura»: los computed de abajo dependen de ella. */
  private readonly version = signal(0);

  c: CapturaEmbarque = {
    delivery_type: null, driver_id: null, helper1_id: null, helper2_id: null,
    per_diem_total: null, overnight: false, freight_revenue: null, actual_km: null,
    total_weight_kg: null, notes: '',
  };
  marcas: Record<Persona, Record<Comida, boolean>> = {
    driver: { cafe: false, desayuno: false, comida: false, cena: false },
    helper1: { cafe: false, desayuno: false, comida: false, cena: false },
    helper2: { cafe: false, desayuno: false, comida: false, cena: false },
  };

  /** La comisión de la guía, CALCULADA de la tarifa del viaje. null = falta una tarifa (no se adivina). */
  readonly comisiones = computed(() => {
    this.version();
    const h = this.hoja();
    if (!h) return null;
    const ayudantes = { helper1: !!this.c.helper1_id, helper2: !!this.c.helper2_id };
    return erroresDeTarifa(h.comision, h.resumen.paradas_sin_ruta, ayudantes).length
      ? null
      : comisionesDeLaGuia(h.comision, ayudantes);
  });
  readonly datos = computed(() => {
    const h = this.hoja();
    return h ? datosDeKepler(h) : null;
  });
  readonly choferes = computed(() => this.personas().filter((d) => d.active && d.roles?.includes('chofer')));
  readonly ayudantes = computed(() => {
    this.version();
    const chofer = this.c.driver_id || this.hoja()?.chofer.driver_id;
    return this.personas().filter((d) => d.active && d.id !== chofer
      && (d.roles?.includes('ayudante') || d.roles?.includes('cargador')));
  });
  readonly hayTarifas = computed(() => COMIDAS.some((m) => (this.tarifas()[m] || 0) > 0));
  readonly errores = computed(() => {
    this.version();
    const h = this.hoja();
    return h ? erroresDeCaptura(this.c, h) : [];
  });
  readonly puedeCrear = computed(() => !!this.hoja() && !this.guardando() && this.errores().length === 0);
  readonly personasViaje = computed(() => {
    this.version();
    const xs: Array<{ key: Persona; label: string }> = [{ key: 'driver', label: 'Chofer' }];
    if (this.c.helper1_id) xs.push({ key: 'helper1', label: 'Ayudante 1' });
    if (this.c.helper2_id) xs.push({ key: 'helper2', label: 'Ayudante 2' });
    return xs;
  });

  ngOnInit() {
    const sucursal = this.route.snapshot.paramMap.get('sucursal') || '';
    const guia = this.route.snapshot.paramMap.get('guia') || '';
    forkJoin({
      hoja: this.api.getNuevoEmbarque(sucursal, guia),
      personas: this.api.listDrivers({ active: true }).pipe(catchError(() => of([] as Driver[]))),
      viatico: this.api.listConfig('viatico').pipe(catchError(() => of([] as ConfigItem[]))),
    }).subscribe({
      next: ({ hoja, personas, viatico }) => {
        this.hoja.set(hoja);
        this.personas.set(personas || []);
        const t: Record<Comida, number> = { cafe: 0, desayuno: 0, comida: 0, cena: 0 };
        for (const v of viatico || []) {
          const m = v.key.replace(/^viatico_/, '') as Comida;
          if (COMIDAS.includes(m)) t[m] = Number(v.value) || 0;
        }
        this.tarifas.set(t);
        this.cargando.set(false);
        this.tocar();
      },
      error: (e) => {
        this.errorCarga.set(e?.status === 404
          ? 'Kepler no tiene ese viaje. Puede que la guía se haya corregido o cancelado.'
          : (e?.error?.message || 'Intenta de nuevo en un momento.'));
        this.cargando.set(false);
      },
    });
  }

  tocar() { this.version.update((v) => v + 1); }

  alElegirAyudante(quien: 'helper1' | 'helper2') {
    // Sin ayudante 1 no hay ayudante 2. Las comisiones no se tocan aquí: se calculan (`comisiones`).
    if (quien === 'helper1' && !this.c.helper1_id) this.c.helper2_id = null;
    this.recalcularViaticos();
    this.tocar();
  }

  marcar(p: Persona, m: Comida, v: boolean) {
    this.marcas = { ...this.marcas, [p]: { ...this.marcas[p], [m]: v } };
    this.recalcularViaticos();
    this.tocar();
  }

  private recalcularViaticos() {
    if (!this.hayTarifas()) return;
    this.c.per_diem_total = totalViaticos(this.marcas, this.tarifas(), this.personasViaje().map((x) => x.key));
  }

  etiquetaComida(m: Comida): string {
    return { cafe: 'Café', desayuno: 'Desayuno', comida: 'Comida', cena: 'Cena' }[m];
  }

  crear() {
    this.errorServidor.set(null);
    const h = this.hoja();
    if (!h || this.errores().length) return;
    this.guardando.set(true);
    const body = cuerpoDeToma(this.c, this.hayTarifas() ? { per_diem_breakdown: this.marcas } : {});
    this.api.createShipmentFromKepler(h.viaje.sucursal, h.viaje.guia, body).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.router.navigate(['/logistica/shipments', r.shipment.id]);
      },
      error: (e) => {
        this.guardando.set(false);
        this.errorServidor.set(e?.error?.message || 'No se pudo crear el embarque. Intenta de nuevo.');
      },
    });
  }
}
