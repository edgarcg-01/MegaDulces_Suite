import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { LogisticaService, NuevoEmbarqueHoja, TomaKeplerBody } from '../logistica.service';
import { datosDeKepler } from '../components/kepler-hoja.component';
import { KeplerParadasComponent } from '../components/kepler-paradas.component';

/**
 * EMB.22 — Lo que no está en Kepler y es de la GUÍA (chofer si Kepler no lo trae, ayudantes,
 * horario, comisión y viáticos) se captura SÓLO en la pestaña Guías del embarque. Aquí se ve
 * bloqueado con esta leyenda, para que se sepa dónde se llena.
 */
export const SE_CAPTURA_EN_GUIAS = 'Se captura en Guías';
export const SE_CALCULA_EN_GUIAS = 'Se calculan en Guías';

export interface CapturaEmbarque {
  delivery_type: 'route' | 'long_trip' | null;
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
export function erroresDeCaptura(c: CapturaEmbarque, h: Pick<NuevoEmbarqueHoja, 'tomado'>): string[] {
  const e: string[] = [];
  if (h.tomado) e.push(`Este viaje ya se tomó en el embarque ${h.tomado.folio}.`);
  if (!c.delivery_type) e.push('Elige el tipo de entrega.');
  const montos: Array<[number | null, string]> = [
    [c.freight_revenue, 'El flete cobrado'],
    [c.total_weight_kg, 'El peso'],
  ];
  for (const [v, etiqueta] of montos) {
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) e.push(`${etiqueta} no puede ser negativo.`);
  }
  if (c.actual_km != null && (!Number.isInteger(Number(c.actual_km)) || Number(c.actual_km) < 0)) {
    e.push('Los kilómetros deben ser un número entero.');
  }
  return e;
}

/** El cuerpo que se manda: sólo lo del embarque; null en lo que no se tocó. La guía se completa en Guías. */
export function cuerpoDeToma(c: CapturaEmbarque): TomaKeplerBody {
  const num = (v: number | null) => (v == null || (v as unknown) === '' ? null : Number(v));
  return {
    delivery_type: c.delivery_type ?? 'route',
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
 * corrige en Kepler. Los campos en blanco son lo que el coordinador teclea del EMBARQUE.
 * EMB.22 — lo de la GUÍA que Kepler no tiene (ayudantes, horario, el chofer si falta) va bloqueado
 * con «Se captura en Guías»: se llena una sola vez, en la pestaña Guías del embarque ya creado.
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
              <dl class="hj-f"><dt>Chofer</dt><dd class="hj-lock" [class.hj-guias]="!d.chofer">{{ d.chofer ?? enGuias }}</dd></dl>
              <dl class="hj-f"><dt>Ayudantes</dt><dd class="hj-lock hj-guias">{{ enGuias }}</dd></dl>
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
                <input id="hj-flete" class="hj-txt" type="number" min="0" step="0.01" name="flete" [(ngModel)]="c.freight_revenue" (ngModelChange)="tocar()" />
              </label>
            </div>
          </section>

          <section class="hj-sec" aria-labelledby="hj-s-com">
            <h2 id="hj-s-com">Horario, comisión y viáticos</h2>
            <div class="hj-grid">
              <dl class="hj-f"><dt>Hora de salida</dt><dd class="hj-lock hj-guias">{{ enGuias }}</dd></dl>
              <dl class="hj-f"><dt>Hora de llegada</dt><dd class="hj-lock hj-guias">{{ enGuias }}</dd></dl>
              <dl class="hj-f"><dt>Comisión y viáticos</dt><dd class="hj-lock hj-guias">{{ calculaEnGuias }}</dd></dl>
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
    .hj-lock.hj-guias { color: var(--c-text-2); }
    .hj-txt, .hj-f select, .hj-f textarea { width: 100%; background: var(--c-surface-1); border: 1px solid var(--c-divider); }
    .hj-txt:disabled, .hj-f select:disabled { opacity: .55; }
    .hj-txt:focus-visible, .hj-f select:focus-visible, .hj-f textarea:focus-visible,
    .hj-radio input:focus-visible, .hj-check input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .hj-mono { font-family: var(--font-mono); }
    .hj-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .hj-radios { display: flex; flex-wrap: wrap; gap: .5rem; }
    .hj-radio { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: 0 .75rem; border: 1px solid var(--c-divider); border-radius: var(--r-sm); font-size: var(--fs-sm); cursor: pointer; }
    .hj-radio.act { border-color: var(--action); background: var(--ember-soft); }
    .hj-radio input, .hj-check input { accent-color: var(--action); }
    .hj-check { display: inline-flex; align-items: center; gap: .5rem; align-self: end; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }

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

  readonly cargando = signal(true);
  readonly guardando = signal(false);
  readonly errorCarga = signal<string | null>(null);
  readonly errorServidor = signal<string | null>(null);
  readonly hoja = signal<NuevoEmbarqueHoja | null>(null);
  readonly enGuias = SE_CAPTURA_EN_GUIAS;
  readonly calculaEnGuias = SE_CALCULA_EN_GUIAS;
  /** Señal de «algo cambió en la captura»: los computed de abajo dependen de ella. */
  private readonly version = signal(0);

  c: CapturaEmbarque = {
    delivery_type: null, freight_revenue: null, actual_km: null, total_weight_kg: null, notes: '',
  };

  readonly datos = computed(() => {
    const h = this.hoja();
    return h ? datosDeKepler(h) : null;
  });
  readonly errores = computed(() => {
    this.version();
    const h = this.hoja();
    return h ? erroresDeCaptura(this.c, h) : [];
  });
  readonly puedeCrear = computed(() => !!this.hoja() && !this.guardando() && this.errores().length === 0);
  ngOnInit() {
    const sucursal = this.route.snapshot.paramMap.get('sucursal') || '';
    const guia = this.route.snapshot.paramMap.get('guia') || '';
    this.api.getNuevoEmbarque(sucursal, guia).subscribe({
      next: (hoja) => {
        this.hoja.set(hoja);
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

  crear() {
    this.errorServidor.set(null);
    const h = this.hoja();
    if (!h || this.errores().length) return;
    this.guardando.set(true);
    const body = cuerpoDeToma(this.c);
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
