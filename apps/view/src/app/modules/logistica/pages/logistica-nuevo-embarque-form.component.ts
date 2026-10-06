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
import { KeplerHojaComponent } from '../components/kepler-hoja.component';

type Persona = 'driver' | 'helper1' | 'helper2';
type Comida = 'cafe' | 'desayuno' | 'comida' | 'cena';
export const COMIDAS: Comida[] = ['cafe', 'desayuno', 'comida', 'cena'];

export interface CapturaEmbarque {
  delivery_type: 'route' | 'long_trip' | null;
  driver_id: string | null;
  helper1_id: string | null;
  helper2_id: string | null;
  driver_commission: number | null;
  helper1_commission: number | null;
  helper2_commission: number | null;
  per_diem_total: number | null;
  overnight: boolean;
  freight_revenue: number | null;
  actual_km: number | null;
  total_weight_kg: number | null;
  notes: string;
}

/**
 * Los errores que se ven ANTES de mandar. Es el mismo criterio que valida el servidor
 * (`validarToma` en libs/logistics): se repite aquí para que el botón diga por qué no avanza,
 * no para reemplazar al servidor — él decide.
 */
export function erroresDeCaptura(c: CapturaEmbarque, h: Pick<NuevoEmbarqueHoja, 'chofer' | 'tomado'>): string[] {
  const e: string[] = [];
  if (h.tomado) e.push(`Este viaje ya se tomó en el embarque ${h.tomado.folio}.`);
  if (!c.delivery_type) e.push('Indica si la entrega es por ruta o viaje largo.');
  const chofer = c.driver_id || h.chofer.driver_id;
  if (!chofer) e.push('Elige al chofer: Kepler no lo trae para esta unidad.');
  if (chofer && (c.helper1_id === chofer || c.helper2_id === chofer)) e.push('El chofer no puede ir también como ayudante.');
  if (c.helper1_id && c.helper1_id === c.helper2_id) e.push('Ayudante 1 y ayudante 2 son la misma persona.');
  if (c.helper2_id && !c.helper1_id) e.push('Captura primero al ayudante 1.');
  const montos: Array<[number | null, string]> = [
    [c.driver_commission, 'La comisión del chofer'],
    [c.helper1_commission, 'La comisión del ayudante 1'],
    [c.helper2_commission, 'La comisión del ayudante 2'],
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
    driver_commission: num(c.driver_commission),
    helper1_commission: c.helper1_id ? num(c.helper1_commission) : null,
    helper2_commission: c.helper2_id ? num(c.helper2_commission) : null,
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
 * EMB.12 — «Nuevo embarque», paso 2: lo que Kepler ya capturó (solo lectura) + lo que no tiene.
 *
 * Arriba va la hoja de Kepler tal cual (`<app-kepler-hoja>`): unidad, chofer, paradas con su
 * ruta y orden, cajas de los renglones, valor. Abajo, sólo lo que Kepler no registra: tipo de
 * entrega, ayudantes, comisiones (sugeridas por el catálogo de rutas), viáticos, flete, km y peso.
 * El chofer se pide SÓLO cuando Kepler no lo trae.
 */
@Component({
  selector: 'app-logistica-nuevo-embarque-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, SkeletonModule, KeplerHojaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page nf">
      <a routerLink="/logistica/shipments/nuevo" class="nf-back"><i class="pi pi-arrow-left" aria-hidden="true"></i> Viajes de Kepler</a>

      @if (cargando()) {
        <p-skeleton height="24rem"></p-skeleton>
      } @else if (errorCarga()) {
        <div class="nf-empty" role="alert">
          <h2>No se pudo abrir el viaje</h2>
          <p>{{ errorCarga() }}</p>
          <a pButton size="small" routerLink="/logistica/shipments/nuevo"><span class="p-button-label">Volver a la lista</span></a>
        </div>
      } @else if (hoja(); as h) {
        <header class="surf-page-head">
          <div class="surf-page-head-text">
            <h1>Nuevo embarque · guía <code>{{ h.viaje.guia }}</code></h1>
            <p class="surf-page-sub">Paso 2 de 2 · {{ h.viaje.tipo.etiqueta }} · {{ h.viaje.fecha }} · {{ h.resumen.paradas }} parada{{ h.resumen.paradas === 1 ? '' : 's' }} en Kepler</p>
          </div>
          <div class="nf-actions">
            <a pButton severity="secondary" [outlined]="true" size="small" routerLink="/logistica/shipments/nuevo"><span class="p-button-label">Cancelar</span></a>
            <button pButton size="small" type="button" [disabled]="!puedeCrear()" [loading]="guardando()"
                    [attr.aria-describedby]="errores().length ? 'nf-faltan' : null" (click)="crear()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
              <span class="p-button-label">Crear embarque</span>
            </button>
          </div>
        </header>

        @if (h.tomado) {
          <div class="nf-banner is-ok" role="status">
            Este viaje ya se tomó en el embarque <b>{{ h.tomado.folio }}</b>.
            <a [routerLink]="['/logistica/shipments', h.tomado.id]">Ver embarque</a>
          </div>
        }

        <div class="nf-legend" aria-label="Leyenda">
          <span><span class="nf-k" aria-hidden="true">K</span> Viene de Kepler · solo lectura</span>
          <span><span class="nf-chip is-cap">Captura</span> Lo escribes tú</span>
          <span><span class="nf-chip is-calc">Sugerido</span> Lo propone la Suite</span>
          <span><span class="nf-chip is-no">No existe en Kepler</span> Se declara, no se pone en cero</span>
        </div>

        <div class="nf-layout">
          <div class="nf-main">
            <app-kepler-hoja [hoja]="h" modo="previa"></app-kepler-hoja>

            <section class="nf-card" aria-labelledby="nf-captura">
              <div class="nf-card-head">
                <h2 id="nf-captura">Lo capturas tú</h2>
                <span>Kepler no tiene estos datos. Es lo único que se guarda en la Suite, junto con la llave de la guía.</span>
              </div>

              <fieldset class="nf-fieldset">
                <legend>Tipo de entrega <span class="nf-chip is-cap">Captura</span></legend>
                <div class="nf-radios">
                  <label class="nf-radio" [class.act]="c.delivery_type === 'route'">
                    <input type="radio" name="tipo" value="route" [(ngModel)]="c.delivery_type" (ngModelChange)="tocar()" /> Por ruta
                  </label>
                  <label class="nf-radio" [class.act]="c.delivery_type === 'long_trip'">
                    <input type="radio" name="tipo" value="long_trip" [(ngModel)]="c.delivery_type" (ngModelChange)="tocar()" /> Viaje largo
                  </label>
                </div>
              </fieldset>

              <div class="nf-grid">
                <label class="nf-field" for="nf-chofer">
                  <span>Chofer
                    @if (choferDeKepler()) { <span class="nf-k" aria-hidden="true">K</span> }
                    @else { <span class="nf-chip is-cap">Captura</span> }
                  </span>
                  @if (choferDeKepler() && !cambiarChofer()) {
                    <span class="nf-readonly">{{ h.chofer.nombre }} · <code>{{ h.chofer.kepler_code }}</code>
                      <button type="button" class="nf-link" (click)="cambiarChofer.set(true)">Cambiar</button>
                    </span>
                  } @else {
                    <select id="nf-chofer" name="chofer" [(ngModel)]="c.driver_id" (ngModelChange)="tocar()">
                      <option [ngValue]="null">Seleccionar chofer</option>
                      @for (d of choferes(); track d.id) { <option [ngValue]="d.id">{{ d.full_name }}</option> }
                    </select>
                    @if (h.chofer.motivo) { <span class="nf-hint is-no">{{ h.chofer.motivo }}</span> }
                  }
                </label>
                <label class="nf-field" for="nf-ay1">
                  <span>Ayudante 1 <span class="nf-chip is-cap">Captura</span></span>
                  <select id="nf-ay1" name="ay1" [(ngModel)]="c.helper1_id" (ngModelChange)="alElegirAyudante('helper1')">
                    <option [ngValue]="null">Sin ayudante</option>
                    @for (d of ayudantes(); track d.id) { <option [ngValue]="d.id">{{ d.full_name }}</option> }
                  </select>
                  <span class="nf-hint">Kepler sólo registra al chofer</span>
                </label>
                <label class="nf-field" for="nf-ay2">
                  <span>Ayudante 2</span>
                  <select id="nf-ay2" name="ay2" [(ngModel)]="c.helper2_id" (ngModelChange)="alElegirAyudante('helper2')" [disabled]="!c.helper1_id">
                    <option [ngValue]="null">Sin ayudante</option>
                    @for (d of ayudantes(); track d.id) { <option [ngValue]="d.id">{{ d.full_name }}</option> }
                  </select>
                </label>
              </div>

              <div class="nf-grid">
                <label class="nf-field" for="nf-com1">
                  <span>Comisión chofer <span class="nf-chip is-calc">Sugerido</span></span>
                  <input id="nf-com1" type="number" min="0" step="0.01" name="com1" [(ngModel)]="c.driver_commission" (ngModelChange)="tocar()" placeholder="0.00" />
                  <span class="nf-hint">{{ textoComision() }}</span>
                </label>
                <label class="nf-field" for="nf-com2">
                  <span>Comisión ayudante 1</span>
                  <input id="nf-com2" type="number" min="0" step="0.01" name="com2" [(ngModel)]="c.helper1_commission" (ngModelChange)="tocar()" [disabled]="!c.helper1_id" placeholder="0.00" />
                </label>
                <label class="nf-field" for="nf-com3">
                  <span>Comisión ayudante 2</span>
                  <input id="nf-com3" type="number" min="0" step="0.01" name="com3" [(ngModel)]="c.helper2_commission" (ngModelChange)="tocar()" [disabled]="!c.helper2_id" placeholder="0.00" />
                </label>
              </div>
              @if (h.comision.sin_tarifa.length) {
                <p class="nf-hint is-no">
                  Sin tarifa en el catálogo de rutas de la Suite:
                  {{ nombresSinTarifa() }}. No se adivina; si es la ruta más lejana, captura la comisión a mano.
                </p>
              }

              <div class="nf-viaticos">
                <div class="nf-row-head">
                  <span class="nf-label">Viáticos <span class="nf-chip is-cap">Captura</span></span>
                  @if (!hayTarifas()) { <span class="nf-hint is-no">Sin tarifas de viáticos configuradas: captura el total.</span> }
                </div>
                @if (hayTarifas()) {
                  <div class="nf-table-wrap">
                    <table class="nf-pd">
                      <thead>
                        <tr><th scope="col">Persona</th>
                          @for (m of comidas; track m) { <th scope="col">{{ etiquetaComida(m) }}<span class="nf-rate">{{ tarifas()[m] | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></th> }
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
                <div class="nf-grid">
                  <label class="nf-field" for="nf-pd">
                    <span>Total de viáticos</span>
                    <input id="nf-pd" type="number" min="0" step="0.01" name="pd" [(ngModel)]="c.per_diem_total" (ngModelChange)="tocar()" [readonly]="hayTarifas()" placeholder="0.00" />
                  </label>
                  <label class="nf-check" for="nf-pern">
                    <input id="nf-pern" type="checkbox" name="pern" [(ngModel)]="c.overnight" (ngModelChange)="tocar()" /> Pernocta (duermen fuera)
                  </label>
                </div>
              </div>

              <div class="nf-grid">
                <label class="nf-field" for="nf-flete">
                  <span>Flete cobrado <span class="nf-chip is-no">No existe en Kepler</span></span>
                  <input id="nf-flete" type="number" min="0" step="0.01" name="flete" [(ngModel)]="c.freight_revenue" (ngModelChange)="tocar()" placeholder="0.00" />
                </label>
                <label class="nf-field" for="nf-km">
                  <span>Kilómetros <span class="nf-chip is-no">No existe en Kepler</span></span>
                  <input id="nf-km" type="number" min="0" step="1" name="km" [(ngModel)]="c.actual_km" (ngModelChange)="tocar()" placeholder="km" />
                  <span class="nf-hint">{{ h.unidad.gps ? 'La unidad tiene rastreo: se puede contrastar con el GPS.' : 'La unidad no tiene rastreo: captura los km del odómetro.' }}</span>
                </label>
                <label class="nf-field" for="nf-peso">
                  <span>Peso total (kg) <span class="nf-chip is-no">Sin medir</span></span>
                  <input id="nf-peso" type="number" min="0" step="0.01" name="peso" [(ngModel)]="c.total_weight_kg" (ngModelChange)="tocar()" placeholder="Opcional · báscula" />
                  <span class="nf-hint">Kepler no tiene peso por producto. Déjalo vacío si nadie lo pesó.</span>
                </label>
              </div>

              <label class="nf-field" for="nf-notas">
                <span>Notas</span>
                <textarea id="nf-notas" name="notas" rows="2" [(ngModel)]="c.notes" (ngModelChange)="tocar()"></textarea>
              </label>
            </section>
          </div>

          <aside class="nf-aside" aria-label="Resumen">
            <section class="nf-card">
              <h2>Resumen</h2>
              <dl class="nf-dl">
                <dt>Paradas · clientes</dt><dd>{{ h.resumen.paradas }} · {{ h.resumen.clientes }}</dd>
                <dt>Rutas</dt><dd>{{ h.resumen.rutas.length }}</dd>
                <dt>Cajas</dt><dd>{{ h.resumen.cajas | number:'1.0-0' }}</dd>
                <dt>Sueltos</dt><dd>{{ h.resumen.sueltos | number:'1.0-0' }}</dd>
                <dt>Valor de la mercancía</dt><dd class="is-strong">{{ h.resumen.valor_venta | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
                <dt>Comisiones</dt><dd>{{ totalComisiones() | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
                <dt>Viáticos</dt><dd>{{ (c.per_diem_total || 0) | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
              </dl>
            </section>
            <section class="nf-card">
              <h2>¿Qué tan completo está?</h2>
              <ul class="nf-check-list">
                @for (x of completitud(); track x.label) {
                  <li><span>{{ x.label }}</span><span class="nf-chip" [ngClass]="x.clase">{{ x.estado }}</span></li>
                }
              </ul>
            </section>
            <section class="nf-card">
              @if (errores().length) {
                <p class="nf-faltan-titulo">Para crear el embarque falta:</p>
                <ul id="nf-faltan" class="nf-errores" role="status">
                  @for (e of errores(); track e) { <li>{{ e }}</li> }
                </ul>
              }
              @if (errorServidor()) { <p class="nf-errores" role="alert">{{ errorServidor() }}</p> }
              <button pButton type="button" class="nf-cta" [disabled]="!puedeCrear()" [loading]="guardando()"
                      [attr.aria-describedby]="errores().length ? 'nf-faltan' : null" (click)="crear()">
                <span class="p-button-label">Crear embarque</span>
              </button>
              <p class="nf-hint">
                Se guarda la llave (sucursal {{ h.viaje.sucursal }} + guía {{ h.viaje.guia }}) y lo que capturaste, la guía
                de entrega y una parada por documento para que el chofer confirme cada entrega.
              </p>
            </section>
          </aside>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .nf-back { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); color: var(--c-text-2); text-decoration: none; margin-bottom: .5rem; }
    .nf-back:hover { color: var(--c-text-1); }
    .surf-page-head h1 code { font-family: var(--font-mono); }
    .nf-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .nf-banner { padding: .6rem .8rem; border-radius: var(--r-sm); font-size: var(--fs-sm); margin: .5rem 0; }
    .nf-banner.is-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .nf-banner a { margin-left: .5rem; }
    .nf-legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; font-size: var(--fs-xs); color: var(--c-text-2); margin: .5rem 0 1rem; }
    .nf-legend > span { display: inline-flex; align-items: center; gap: .35rem; }
    .nf-k { display: inline-flex; align-items: center; justify-content: center; width: 1rem; height: 1rem; border-radius: .25rem; background: var(--c-divider); color: var(--c-text-1); font-family: var(--font-mono); font-size: var(--fs-nano); }
    .nf-chip { display: inline-flex; align-items: center; padding: .05rem .5rem; border-radius: 999px; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: none; letter-spacing: 0; background: var(--c-surface-2); color: var(--c-text-1); }
    .nf-chip.is-cap { background: var(--ember-soft); color: var(--brand-800); }
    .nf-chip.is-calc { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .nf-chip.is-no { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .nf-chip.is-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }

    .nf-layout { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; }
    .nf-main { flex: 999 1 40rem; min-width: 0; display: flex; flex-direction: column; gap: 1rem; }
    .nf-aside { flex: 1 1 18rem; min-width: 16rem; display: flex; flex-direction: column; gap: 1rem; }
    .nf-card { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md); padding: 1rem; display: flex; flex-direction: column; gap: .9rem; }
    .nf-card h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .nf-card-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; justify-content: space-between; }
    .nf-card-head > span { font-size: var(--fs-xs); color: var(--c-text-2); }

    .nf-fieldset { border: 0; padding: 0; margin: 0; }
    .nf-fieldset legend { padding: 0; margin-bottom: .5rem; font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .nf-radios { display: inline-flex; flex-wrap: wrap; gap: .5rem; }
    .nf-radio { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: 0 .75rem; border: 1px solid var(--c-divider); border-radius: var(--r-sm); font-size: var(--fs-sm); cursor: pointer; }
    .nf-radio.act { border-color: var(--action); background: var(--ember-soft); }
    .nf-radio input { accent-color: var(--action); }

    .nf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .75rem; }
    .nf-field { display: flex; flex-direction: column; gap: .3rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .nf-field > span:first-child { display: inline-flex; align-items: center; gap: .35rem; font-weight: var(--fw-medium); color: var(--c-text-1); font-size: var(--fs-sm); }
    .nf-field input, .nf-field select, .nf-field textarea { min-height: 2.25rem; box-sizing: border-box; padding: .35rem .6rem; border: 1px solid var(--c-divider); border-radius: var(--r-sm); background: var(--c-surface-1); color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); }
    .nf-field input:focus-visible, .nf-field select:focus-visible, .nf-field textarea:focus-visible,
    .nf-radio input:focus-visible, .nf-check input:focus-visible, .nf-pd input:focus-visible, .nf-link:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .nf-field input[readonly] { background: var(--c-surface-2); }
    .nf-readonly { display: flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .nf-readonly code { font-family: var(--font-mono); }
    .nf-link { border: 0; background: none; padding: 0; color: var(--brand-800); font: inherit; font-size: var(--fs-xs); text-decoration: underline; cursor: pointer; }
    .nf-hint { font-size: var(--fs-xs); color: var(--c-text-2); margin: 0; }
    .nf-hint.is-no { color: var(--warn-soft-fg); }
    .nf-check { display: inline-flex; align-items: center; gap: .5rem; font-size: var(--fs-sm); color: var(--c-text-1); align-self: end; min-height: 2.25rem; }
    .nf-check input { accent-color: var(--action); }

    .nf-viaticos { display: flex; flex-direction: column; gap: .5rem; }
    .nf-row-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; justify-content: space-between; }
    .nf-label { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); font-weight: var(--fw-medium); }
    .nf-table-wrap { overflow-x: auto; }
    .nf-pd { border-collapse: collapse; font-size: var(--fs-sm); }
    .nf-pd th, .nf-pd td { padding: .35rem .6rem; text-align: center; }
    .nf-pd th[scope="row"] { text-align: left; font-weight: var(--fw-medium); }
    .nf-pd thead th { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); font-weight: var(--fw-medium); }
    .nf-rate { display: block; font-family: var(--font-mono); text-transform: none; letter-spacing: 0; }
    .nf-pd input { accent-color: var(--action); }

    .nf-dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: .45rem .75rem; font-size: var(--fs-sm); }
    .nf-dl dt { color: var(--c-text-2); }
    .nf-dl dd { margin: 0; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .nf-dl dd.is-strong { font-weight: var(--fw-bold); }
    .nf-check-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: .45rem; font-size: var(--fs-sm); }
    .nf-check-list li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .nf-faltan-titulo { margin: 0 0 .25rem; font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--bad-soft-fg); }
    .nf-errores { margin: 0; padding-left: 1rem; font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    .nf-cta { width: 100%; justify-content: center; }
    .nf-empty { text-align: center; padding: 3rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .5rem; }
    .nf-empty h2 { margin: 0; font-size: var(--fs-h3); }
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
  readonly cambiarChofer = signal(false);
  /** Señal de «algo cambió en la captura»: los computed de abajo dependen de ella. */
  private readonly version = signal(0);

  c: CapturaEmbarque = {
    delivery_type: 'route', driver_id: null, helper1_id: null, helper2_id: null,
    driver_commission: null, helper1_commission: null, helper2_commission: null,
    per_diem_total: null, overnight: false, freight_revenue: null, actual_km: null,
    total_weight_kg: null, notes: '',
  };
  marcas: Record<Persona, Record<Comida, boolean>> = {
    driver: { cafe: false, desayuno: false, comida: false, cena: false },
    helper1: { cafe: false, desayuno: false, comida: false, cena: false },
    helper2: { cafe: false, desayuno: false, comida: false, cena: false },
  };

  readonly choferes = computed(() => this.personas().filter((d) => d.active && d.roles?.includes('chofer')));
  readonly ayudantes = computed(() => {
    this.version();
    const chofer = this.c.driver_id || this.hoja()?.chofer.driver_id;
    return this.personas().filter((d) => d.active && d.id !== chofer
      && (d.roles?.includes('ayudante') || d.roles?.includes('cargador')));
  });
  readonly choferDeKepler = computed(() => {
    const h = this.hoja();
    return !!h && !h.chofer.falta && !!h.chofer.driver_id;
  });
  readonly hayTarifas = computed(() => COMIDAS.some((m) => (this.tarifas()[m] || 0) > 0));
  readonly errores = computed(() => {
    this.version();
    const h = this.hoja();
    return h ? erroresDeCaptura(this.c, h) : [];
  });
  readonly puedeCrear = computed(() => !!this.hoja() && !this.guardando() && this.errores().length === 0);
  readonly totalComisiones = computed(() => {
    this.version();
    return [this.c.driver_commission, this.c.helper1_id ? this.c.helper1_commission : 0, this.c.helper2_id ? this.c.helper2_commission : 0]
      .reduce<number>((a, v) => a + Math.round(Number(v || 0) * 100), 0) / 100;
  });
  readonly personasViaje = computed(() => {
    this.version();
    const xs: Array<{ key: Persona; label: string }> = [{ key: 'driver', label: 'Chofer' }];
    if (this.c.helper1_id) xs.push({ key: 'helper1', label: 'Ayudante 1' });
    if (this.c.helper2_id) xs.push({ key: 'helper2', label: 'Ayudante 2' });
    return xs;
  });
  readonly completitud = computed(() => {
    this.version();
    const h = this.hoja();
    if (!h) return [];
    const k = 'is-k', cap = 'is-cap', no = 'is-no', ok = 'is-ok';
    return [
      { label: 'Unidad', estado: h.unidad.kepler_code ? 'Kepler' : 'Falta', clase: h.unidad.kepler_code ? k : no },
      { label: 'Chofer', estado: this.choferDeKepler() ? 'Kepler' : (this.c.driver_id ? 'Capturado' : 'Falta'), clase: this.choferDeKepler() ? k : (this.c.driver_id ? ok : no) },
      { label: 'Ruta de cada parada', estado: `Kepler · ${h.resumen.paradas - h.resumen.paradas_sin_ruta}/${h.resumen.paradas}`, clase: h.resumen.paradas_sin_ruta ? no : k },
      { label: 'Cajas y sueltos', estado: 'Kepler · renglones', clase: k },
      { label: 'Ayudantes', estado: this.c.helper1_id ? 'Capturado' : 'Sin ayudante', clase: this.c.helper1_id ? ok : cap },
      { label: 'Comisiones', estado: this.c.driver_commission != null ? 'Capturado' : 'Pendiente', clase: this.c.driver_commission != null ? ok : cap },
      { label: 'Kilómetros', estado: this.c.actual_km != null ? 'Capturado' : 'Pendiente', clase: this.c.actual_km != null ? ok : cap },
      { label: 'Peso', estado: this.c.total_weight_kg != null ? 'Capturado' : 'Sin medir', clase: this.c.total_weight_kg != null ? ok : no },
    ];
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
        // La comisión del chofer arranca con la SUGERIDA (si el catálogo la tiene). Es editable.
        if (hoja.comision.driver != null) this.c.driver_commission = hoja.comision.driver;
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
    const h = this.hoja();
    if (quien === 'helper1') {
      if (!this.c.helper1_id) { this.c.helper2_id = null; this.c.helper1_commission = null; this.c.helper2_commission = null; }
      else if (this.c.helper1_commission == null && h?.comision.helper != null) this.c.helper1_commission = h.comision.helper;
    } else if (!this.c.helper2_id) this.c.helper2_commission = null;
    else if (this.c.helper2_commission == null && h?.comision.helper != null) this.c.helper2_commission = h.comision.helper;
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

  textoComision(): string {
    const h = this.hoja();
    if (!h) return '';
    if (!h.comision.ruta_usada) return 'Ninguna ruta del viaje tiene tarifa en el catálogo de la Suite.';
    return `Del catálogo de rutas: ${h.comision.ruta_usada.nombre || h.comision.ruta_usada.clave} (la de mayor comisión del viaje).`;
  }

  nombresSinTarifa(): string {
    return (this.hoja()?.comision.sin_tarifa ?? []).map((r) => r.nombre || r.clave).join(', ');
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
