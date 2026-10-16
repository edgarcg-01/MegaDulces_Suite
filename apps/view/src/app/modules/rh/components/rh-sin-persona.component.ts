import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import type { HrCandidatoPersonaDto, HrMotivoCandidato, HrPersonaBuscadaDto, HrSinPersonaDto, HrSinPersonaResponse } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhService, rhError } from '../rh.service';

/** Cómo se lee el motivo de un candidato. */
export const MOTIVO_CANDIDATO: Record<HrMotivoCandidato, { texto: string; severity: 'success' | 'info' | 'secondary' }> = {
  mismo_codigo: { texto: 'Mismo código en otro reloj', severity: 'success' },
  mismo_nombre: { texto: 'Mismo nombre', severity: 'info' },
  nombre_parecido: { texto: 'Nombre parecido', severity: 'secondary' },
};

/** El nombre del reloj sirve de punto de partida para el alta sólo si ya parece un nombre completo. */
export function nombreInicial(nombreReloj: string | null): string {
  const n = String(nombreReloj ?? '').replace(/\s+/g, ' ').trim();
  return n.split(' ').filter(Boolean).length >= 2 ? n : '';
}

/**
 * Fase RH · `[RH.1.12]` — CÓDIGOS SIN PERSONA, en `/rh/relojes`.
 *
 * Quien checa con un código que no está ligado a nadie no genera faltas, no tiene sección y no entra al reporte: para
 * la asistencia, no existe. Aquí RH lo resuelve. La Suite propone candidatos con el mismo motor de la carga de
 * personas; RH confirma con un clic. Nunca se liga solo: un enlace equivocado le pasa las faltas de una persona a otra.
 *
 * Tres salidas por código: ligarlo a un candidato, buscar a mano a la persona, o darla de alta (sin contraseña ni
 * acceso) con su sección. Si el código ya es de otra persona en otro reloj de la plaza, se pide confirmar el reemplazo.
 * Ligarlo días después recupera su historial: la asistencia se calcula al leer.
 */
@Component({
  selector: 'app-rh-sin-persona',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, ButtonModule, InputTextModule, SelectModule, CheckboxModule, TagModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sp-card dt-scope" aria-label="Códigos sin persona">
      <header class="sp-head">
        <h2>Códigos sin persona
          @if (datos(); as d) { @if (d.total) { <p-tag [value]="d.total + ''" severity="warn" /> } }
        </h2>
        <p-button icon="pi pi-refresh" label="Actualizar" size="small" severity="secondary" [text]="true" [loading]="loading()" (onClick)="cargar()" />
      </header>
      <p class="sp-nota">Quien checa con un código sin persona no genera faltas ni entra al reporte. Elige a quién pertenece:
        la Suite sugiere, tú confirmas. Ligarlo después recupera todo lo que ya checó.</p>
      @if (aviso(); as a) { <p class="sp-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }

      <app-load-state [loading]="loading() && !datos()" [error]="error()" [isEmpty]="!loading() && !error() && !filas().length"
                      emptyIcon="pi-check-circle" emptyTitle="Todos los códigos que checan tienen persona" (retry)="cargar()">
        <p-table [value]="filas()" dataKey="enrollment_id" size="small" [rowHover]="true" selectionMode="single"
                 [selection]="seleccion()" (selectionChange)="elegir($event)"
                 class="dt-stack surf-table surf-table--plain surf-table--sticky surf-table--frozen-first" [tableStyle]="{ 'min-width': '52rem' }">
          <ng-template #header>
            <tr>
              <th scope="col">Plaza</th><th scope="col">Código</th><th scope="col">Nombre en el reloj</th>
              <th scope="col">Última checada</th><th scope="col" class="comm-num">Checadas 14 d</th><th scope="col">Sugerencia</th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr [pSelectableRow]="f">
              <td role="cell" data-label="Plaza">{{ f.site_name }}<small class="sp-sub">{{ f.device_label || f.serial_number }}</small></td>
              <td role="cell" data-label="Código" class="mono">{{ f.codigo }}</td>
              <td role="cell" data-label="Nombre en el reloj">{{ f.nombre_reloj || '—' }}</td>
              <td role="cell" data-label="Última checada">{{ f.ultima_checada ? (f.ultima_checada | date: 'd MMM HH:mm') : 'sin checadas' }}</td>
              <td role="cell" data-label="Checadas 14 d" class="comm-num">{{ f.checadas_14d }}</td>
              <td role="cell" data-label="Sugerencia">
                @if (sugerido(f); as s) { {{ s.nombre }} <p-tag [value]="motivo(s.motivo).texto" [severity]="motivo(s.motivo).severity" /> }
                @else if (f.candidatos.length) { {{ f.candidatos.length }} posible(s) }
                @else { <span class="sp-sub">sin candidatos</span> }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      @if (seleccion(); as f) {
        <div class="sp-panel" role="group" [attr.aria-label]="'Ligar el código ' + f.codigo + ' de ' + f.site_name">
          <h3>Código {{ f.codigo }} · {{ f.site_name }} @if (f.nombre_reloj) { <span class="sp-sub">«{{ f.nombre_reloj }}»</span> }</h3>
          @if (!gestiona()) {
            <p class="sp-nota">Sólo quien administra los relojes puede ligarlo.</p>
          } @else {
            @if (conflicto(); as c) {
              <div class="sp-banner bad" role="alert">
                <p>{{ c.mensaje }}</p>
                <div class="sp-fila">
                  <p-button label="Sí, reemplazar" size="small" severity="danger" [loading]="ocupado()" (onClick)="ligar(f, c.userId, true)" />
                  <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="conflicto.set(null)" />
                </div>
              </div>
            }
            @if (f.candidatos.length) {
              <ul class="sp-cands">
                @for (c of f.candidatos; track c.user_id) {
                  <li>
                    <span>{{ c.nombre }} <p-tag [value]="motivo(c.motivo).texto" [severity]="motivo(c.motivo).severity" />
                      @if (c.sugerido) { <p-tag value="Sugerido" severity="success" /> }</span>
                    <p-button [label]="'Ligar a ' + c.nombre" size="small" [outlined]="!c.sugerido" [loading]="ocupado()" (onClick)="ligar(f, c.user_id, false)" />
                  </li>
                }
              </ul>
            }
            <div class="sp-fila">
              <input pInputText [ngModel]="q()" (ngModelChange)="q.set($event)" (keydown.enter)="buscar()" placeholder="Buscar a la persona por nombre" aria-label="Buscar persona por nombre" />
              <p-button label="Buscar" icon="pi pi-search" size="small" severity="secondary" [outlined]="true" [disabled]="q().trim().length < 2" (onClick)="buscar()" />
            </div>
            @if (resultados(); as rs) {
              @if (rs.length) {
                <ul class="sp-cands">
                  @for (p of rs; track p.user_id) {
                    <li><span>{{ p.nombre }}@if (p.status === 'terminated') { <small class="sp-sub"> · de baja</small> }</span>
                      <p-button [label]="'Ligar a ' + p.nombre" size="small" [outlined]="true" [loading]="ocupado()" (onClick)="ligar(f, p.user_id, false)" /></li>
                  }
                </ul>
              } @else { <p class="sp-nota">Nadie con ese nombre en la Suite. Si es alguien nuevo, dalo de alta.</p> }
            }
            <details class="sp-alta" [open]="!f.candidatos.length">
              <summary>Es alguien nuevo: darlo de alta</summary>
              <div class="sp-form">
                <label>Nombre completo <input pInputText [ngModel]="nombre()" (ngModelChange)="nombre.set($event)" placeholder="Nombre y apellidos" /></label>
                <label>Sección del reporte de RH
                  <p-select [options]="secciones()" [ngModel]="seccion()" (ngModelChange)="seccion.set($event)" [editable]="true"
                            placeholder="Elige o escribe la sección" appendTo="body" ariaLabel="Sección del reporte de RH" />
                </label>
                <label class="sp-check"><p-checkbox [binary]="true" [ngModel]="promotora()" (ngModelChange)="promotora.set($event)" inputId="sp-promo" />
                  <span>Es promotora de marca</span></label>
                <small class="sp-sub">Se da de alta sin contraseña ni acceso a la Suite: sólo para su asistencia.</small>
                <p-button label="Dar de alta y ligar" icon="pi pi-user-plus" size="small" [disabled]="!puedeAlta()" [loading]="ocupado()" (onClick)="alta(f)" />
              </div>
            </details>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .sp-card { background: var(--card-bg); display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .sp-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .sp-head h2 { margin: 0; font-size: var(--fs-h3); color: var(--text-main); display: flex; align-items: center; gap: var(--sp-2); }
    .sp-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .sp-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .sp-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .sp-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sp-banner p { margin: 0 0 var(--sp-2); }
    .sp-panel { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-sm); }
    .sp-panel h3 { margin: 0; font-size: var(--fs-sm); }
    .sp-fila { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .sp-cands { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .sp-cands li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); }
    .sp-alta summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-main); }
    .sp-alta summary:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .sp-form { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); max-width: 28rem; }
    .sp-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .sp-form label.sp-check { flex-direction: row; align-items: center; color: var(--text-main); }
  `],
})
export class RhSinPersonaComponent implements OnInit {
  private readonly api = inject(RhService);

  readonly gestiona = input(false);

  readonly datos = signal<HrSinPersonaResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly ocupado = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly seleccion = signal<HrSinPersonaDto | null>(null);
  readonly conflicto = signal<{ mensaje: string; userId: string } | null>(null);
  readonly q = signal('');
  readonly resultados = signal<HrPersonaBuscadaDto[] | null>(null);
  readonly nombre = signal('');
  readonly seccion = signal<string | null>(null);
  readonly promotora = signal(false);

  readonly filas = computed(() => this.datos()?.filas ?? []);
  readonly secciones = computed(() => this.datos()?.secciones ?? []);
  readonly puedeAlta = computed(() => {
    const n = this.nombre().trim().split(/\s+/).filter(Boolean).length;
    const s = String(this.seccion() ?? '').trim();
    return n >= 2 && s.length > 0 && !this.ocupado();
  });

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.sinPersona().subscribe({
      next: (d) => {
        this.datos.set(d);
        this.loading.set(false);
        const sel = this.seleccion();
        if (sel && !d.filas.some((f) => f.enrollment_id === sel.enrollment_id)) this.seleccion.set(null);
      },
      error: (e) => { this.error.set(rhError(e, 'No se pudieron leer los códigos sin persona.')); this.loading.set(false); },
    });
  }

  motivo(m: HrMotivoCandidato) { return MOTIVO_CANDIDATO[m]; }
  sugerido(f: HrSinPersonaDto): HrCandidatoPersonaDto | null { return f.candidatos.find((c) => c.sugerido) ?? null; }

  elegir(f: HrSinPersonaDto | null): void {
    this.seleccion.set(f);
    this.conflicto.set(null);
    this.resultados.set(null);
    this.q.set('');
    this.nombre.set(nombreInicial(f?.nombre_reloj ?? null));
    this.seccion.set(f?.seccion ?? null);
    this.promotora.set(f?.promotora ?? false);
  }

  buscar(): void {
    const q = this.q().trim();
    if (q.length < 2) return;
    this.api.buscarPersonas(q).subscribe({
      next: (r) => this.resultados.set(r),
      error: (e) => this.aviso.set({ texto: rhError(e, 'No se pudo buscar.'), mal: true }),
    });
  }

  ligar(f: HrSinPersonaDto, userId: string, reemplazar: boolean): void {
    this.ocupado.set(true);
    this.api.ligarCodigo(f.enrollment_id, { user_id: userId, reemplazar }).subscribe({
      next: (r) => this.listo(`Código ${f.codigo} de ${f.site_name} ligado a ${r.nombre} (${r.enrolamientos} reloj(es)).`),
      error: (e) => {
        this.ocupado.set(false);
        // 409: el código ya es de otra persona en otro reloj de la plaza. Se pide confirmar, nunca se reemplaza solo.
        if (e instanceof HttpErrorResponse && e.status === 409 && !reemplazar) {
          this.conflicto.set({ mensaje: rhError(e, 'Ese código ya es de otra persona.'), userId });
          return;
        }
        this.aviso.set({ texto: rhError(e, 'No se pudo ligar.'), mal: true });
      },
    });
  }

  alta(f: HrSinPersonaDto): void {
    if (!this.puedeAlta()) return;
    this.ocupado.set(true);
    this.api.altaDesdeReloj(f.enrollment_id, { nombre: this.nombre().trim(), seccion: String(this.seccion() ?? '').trim(), promotora: this.promotora() }).subscribe({
      next: (r) => this.listo(`${r.nombre} quedó dado(a) de alta y ligado(a) al código ${f.codigo} de ${f.site_name}.`),
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo dar de alta.'), mal: true }); },
    });
  }

  private listo(texto: string): void {
    this.ocupado.set(false);
    this.conflicto.set(null);
    this.seleccion.set(null);
    this.aviso.set({ texto, mal: false });
    this.cargar();
  }
}
