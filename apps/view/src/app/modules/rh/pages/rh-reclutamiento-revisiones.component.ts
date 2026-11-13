import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type { HrDuplicadoGrupoDto, HrReingresoAlertaDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';
import { etapaLabel, fechaMx, telefono } from '../reclutamiento-formato';

/**
 * Fase RH · `[RH.2.3]` — Revisiones (`/rh/reclutamiento/revisiones`): lo que hay que mirar aunque nadie lo pida.
 *
 *   · Quién se volvió a postular estando marcado como no recontratable. Una lista negra que hay que ir a consultar no
 *     evita nada: en Mega Talento el caso de Yurécuaro se detectó porque alguien reconoció a la persona.
 *   · Registros duplicados por teléfono: el bot y el portal abren a la misma persona por separado.
 *
 * `[RH.13.6]` Contesta UNA pregunta: «¿qué registros hay que corregir?». El tiempo por etapa (un diagnóstico del proceso,
 * no un registro por corregir) se mudó al Resumen. Cada lista se lee por su cuenta: si una falla, la otra sigue.
 */
@Component({
  selector: 'app-rh-reclutamiento-revisiones',
  standalone: true,
  imports: [RouterLink, ButtonModule, LoadStateComponent, RhReclutamientoMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rr2-page">
      <app-rh-reclutamiento-marco subtitulo="Registros que hay que corregir: quien regresó estando marcado y quien quedó registrado dos veces.">
        <div acciones><p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" /></div>
      </app-rh-reclutamiento-marco>

      <app-load-state [loading]="loading() && !cargado()" [error]="null" (retry)="cargar()">
        <p class="rr2-veredicto" role="status">
          @if (pendientes() === null) {
            No se pudo revisar todo: abajo se dice qué faltó.
          } @else if (pendientes() === 0) {
            <i class="pi pi-check-circle" aria-hidden="true"></i> Nada por revisar.
          } @else {
            <span><b>{{ pendientes() }}</b> por revisar:
              @if (reingresos().length) { {{ reingresos().length }} {{ reingresos().length === 1 ? 'persona marcada que regresó' : 'personas marcadas que regresaron' }} }
              @if (reingresos().length && duplicados().length) { · }
              @if (duplicados().length) { {{ duplicados().length }} {{ duplicados().length === 1 ? 'teléfono con más de un registro' : 'teléfonos con más de un registro' }} }
            </span>
          }
        </p>

        <section class="rr2-card" aria-labelledby="rr2-t-re">
          <header class="rr2-h">
            <h2 id="rr2-t-re">Se volvieron a postular estando marcados</h2>
            <span class="rr2-cuenta" [attr.data-t]="reingresos().length ? 'mal' : null">{{ reingresos().length }}</span>
          </header>
          <p class="rr2-ayuda">Alguien en proceso tiene el mismo teléfono que una persona marcada como no recontratable.</p>
          @if (errorReingresos(); as e) {
            <p class="rr2-err" role="alert">{{ e }}</p>
          } @else if (!reingresos().length) {
            <p class="rr2-vacio">Nadie en proceso comparte teléfono con alguien marcado.</p>
          } @else {
            <ul class="rr2-alertas">
              @for (a of reingresos(); track a.id) {
                <li>
                  <div class="rr2-quien">
                    <a class="rr2-nom" [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', id: a.id }">{{ a.full_name || 'Sin nombre' }}</a>
                    <span class="rr2-meta"><span class="mono">{{ telefono(a.phone) }}</span> · {{ etapaLabel(a.stage) }} · se postuló {{ fechaMx(a.created_at) }}</span>
                  </div>
                  <div class="rr2-porque">
                    <span class="pill" data-t="mal">No recontratable</span>
                    <span>Marcado como «{{ a.marcado_nombre || 'sin nombre' }}»: <b>{{ a.motivo || 'sin motivo escrito' }}</b>
                      <small> — {{ a.marcado_por || 'RH' }}, {{ fechaMx(a.marcado_en) }}</small></span>
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        <section class="rr2-card" aria-labelledby="rr2-t-dup">
          <header class="rr2-h">
            <h2 id="rr2-t-dup">Mismo teléfono, más de un registro</h2>
            <span class="rr2-cuenta" [attr.data-t]="duplicados().length ? 'aviso' : null">{{ duplicados().length }}</span>
          </header>
          <p class="rr2-ayuda">El bot y el portal abren a la misma persona por separado. Abre la ficha del que se queda y usa «Fusionar aquí»:
            sólo se rellenan los datos que le faltan.</p>
          @if (errorDuplicados(); as e) {
            <p class="rr2-err" role="alert">{{ e }}</p>
          } @else if (!duplicados().length) {
            <p class="rr2-vacio">Ningún teléfono está registrado dos veces.</p>
          } @else {
            <div class="rr2-scroll dt-scope">
              <table class="rr2-tabla dt-stack">
                <thead><tr>
                  <th scope="col" class="rr2-c-nom">Registro</th><th scope="col">Etapa</th><th scope="col">Origen</th>
                  <th scope="col">Se registró</th><th scope="col">CV</th>
                </tr></thead>
                @for (g of duplicados(); track g.phone_key) {
                  <tbody>
                    <tr class="rr2-grupo">
                      <th scope="rowgroup" colspan="5"><span class="mono">{{ telefono(g.phone_key) }}</span><small>{{ g.candidatos.length }} registros</small></th>
                    </tr>
                    @for (c of g.candidatos; track c.id) {
                      <tr>
                        <td class="dt-id rr2-c-nom" role="cell">
                          <a class="rr2-nom" [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', id: c.id }">{{ c.full_name || 'Sin nombre' }}</a>
                        </td>
                        <td role="cell" data-label="Etapa">{{ etapaLabel(c.stage) }}</td>
                        <td role="cell" data-label="Origen">{{ c.source || 'Sin origen' }}</td>
                        <td role="cell" data-label="Se registró">{{ fechaMx(c.created_at) }}</td>
                        <td role="cell" data-label="CV">@if (c.has_cv) { Con CV } @else { <span class="pill" data-t="aviso">Sin CV</span> }</td>
                      </tr>
                    }
                  </tbody>
                }
              </table>
            </div>
          }
        </section>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rr2-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    /* El veredicto: cuánto hay por corregir, antes de cualquier lista. */
    .rr2-veredicto { margin: 0 0 var(--sp-3); font: 500 var(--fs-h3)/1.4 var(--font-body); color: var(--text-main); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .rr2-veredicto b { font-weight: 700; }
    .rr2-veredicto .pi-check-circle { color: var(--ok-soft-fg); }
    .rr2-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; margin-bottom: var(--sp-3);
      display: flex; flex-direction: column; overflow: hidden; }
    .rr2-h { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-3) 0; }
    .rr2-h h2 { margin: 0; font: 700 var(--fs-h3)/1.3 var(--font-body); color: var(--text-main); }
    /* La cuenta va en su propia ficha, no pegada al título (antes se leía «marcados 1»). */
    .rr2-cuenta { min-width: 1.75rem; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-align: center; font-size: var(--fs-xs); font-weight: 700;
      font-variant-numeric: tabular-nums; background: var(--surface-2); color: var(--text-muted); }
    .rr2-cuenta[data-t='mal'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .rr2-cuenta[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rr2-ayuda { margin: var(--sp-1) 0 var(--sp-2); padding: 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .rr2-vacio { margin: 0; padding: var(--sp-2) var(--sp-3) var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .rr2-err { margin: 0 var(--sp-3) var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rr2-nom { font-weight: 700; color: var(--text-main); text-decoration: underline; text-decoration-color: var(--border-color); text-underline-offset: 3px; }
    .rr2-nom:hover { text-decoration-color: currentColor; }
    .rr2-nom:focus-visible { outline: 2px solid var(--focus-ring); border-radius: var(--r-sm); }

    /* Quien regresó estando marcado: una tarjeta con filo rojo (el texto va en tinta normal, que sí se lee). */
    .rr2-alertas { list-style: none; margin: 0; padding: 0 var(--sp-3) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
    .rr2-alertas li { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color);
      border-left: 4px solid var(--bad-fg); border-radius: var(--r-sm); font-size: var(--fs-sm); color: var(--text-main); }
    .rr2-quien { display: flex; align-items: baseline; gap: var(--sp-1) var(--sp-3); flex-wrap: wrap; }
    .rr2-meta { font-size: var(--fs-xs); color: var(--text-muted); }
    .rr2-porque { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
    .rr2-porque small { color: var(--text-muted); font-size: var(--fs-xs); }

    /* Los duplicados: una tabla, un grupo por teléfono (como las zonas de Candidatos). */
    .rr2-scroll { overflow-x: auto; }
    .rr2-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rr2-tabla thead th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rr2-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rr2-c-nom { width: 32%; }
    .rr2-tabla tr.rr2-grupo th { text-align: left; padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); background: var(--surface-2);
      font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .rr2-tabla tr.rr2-grupo small { margin-left: var(--sp-2); font-size: var(--fs-xs); font-weight: 500; color: var(--text-muted); }
    @container densetable (max-width: 34rem) { .rr2-tabla td.rr2-c-nom { width: auto; } }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='mal'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    :host ::ng-deep .p-button { min-height: var(--tap-min); }
    .rr2-nom { display: inline-flex; align-items: center; min-height: var(--tap-min); }
    @media (max-width: 40rem) { .rr2-page { padding: var(--sp-3); } }
  `],
})
export class RhReclutamientoRevisionesComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);

  readonly etapaLabel = etapaLabel;
  readonly fechaMx = fechaMx;
  readonly telefono = telefono;

  readonly reingresos = signal<HrReingresoAlertaDto[]>([]);
  readonly duplicados = signal<HrDuplicadoGrupoDto[]>([]);
  readonly errorReingresos = signal<string | null>(null);
  readonly errorDuplicados = signal<string | null>(null);
  readonly loading = signal(false);
  readonly cargado = signal(false);

  /** Cuántas cosas hay por corregir. `null` = una de las dos listas no se pudo leer: no se dice «nada por revisar». */
  readonly pendientes = computed<number | null>(() =>
    this.errorReingresos() || this.errorDuplicados() ? null : this.reingresos().length + this.duplicados().length);

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.errorReingresos.set(null);
    this.errorDuplicados.set(null);
    let pendientes = 2;
    const fin = () => { if (--pendientes === 0) { this.loading.set(false); this.cargado.set(true); } };
    this.api.reingresos().subscribe({
      next: (r) => { this.reingresos.set(r); fin(); },
      error: (e) => { this.errorReingresos.set(rhError(e, 'No se pudo revisar quién regresó estando marcado.')); fin(); },
    });
    this.api.duplicados().subscribe({
      next: (d) => { this.duplicados.set(d); fin(); },
      error: (e) => { this.errorDuplicados.set(rhError(e, 'No se pudieron leer los registros duplicados.')); fin(); },
    });
  }
}
