import {
  ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { TextareaModule } from 'primeng/textarea';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import {
  validarRespuesta, type DefinicionVista, type PersonaAsignable,
} from '@megadulces/contracts';

import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { DefinicionesService } from '../definiciones.service';

/** A qué pantalla afecta cada consumidor. Un consumidor sin entrada se muestra por su código. */
const CONSUMIDORES: Record<string, { label: string; ruta: string }> = {
  'commercial.commissions': { label: 'Comisiones de Ruta Directa', ruta: '/comercial/comisiones' },
};
const AREAS: Record<string, string> = {
  comercial: 'Comercial', finanzas: 'Finanzas', logistica: 'Logística', rh: 'Recursos Humanos',
  plataforma: 'Plataforma', trade: 'Trade', direccion: 'Dirección',
};

/**
 * `[DP.3.1]` — **Definiciones de negocio: la regla que falta se pregunta en el sistema** (Fase DP).
 *
 * Contesta una sola pregunta desde dos sillas: *¿qué reglas faltan por definir y quién las define?*
 *  · el DUEÑO ve «A tu nombre» y contesta en el panel; el control lo decide el tipo;
 *  · Dirección (VER/GESTIONAR) ve «Todas», con las SIN DUEÑO arriba, y reparte.
 *
 * ⛔ Lo que esta pantalla nunca hace (observaciones del plan, `FASE_DP` §Observaciones):
 *  · DP.UI.1 — pintar la PROPUESTA como respuesta: la respuesta dice «sin definir» y la propuesta va
 *    aparte con su fuente;
 *  · DP.UI.3 — ofrecer «Guardar» a quien no es el dueño (el servidor lo rechazaría con 403).
 */
@Component({
  selector: 'app-admin-definiciones',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, TagModule, ToastModule,
    SelectModule, MultiSelectModule, InputNumberModule, DatePickerModule, TextareaModule, InputTextModule,
    MetricStripComponent, SidePeekComponent, LoadStateComponent, SegmentedComponent, FreshnessPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ad-page">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Definiciones de negocio</h1>
          <p class="surf-page-sub">
            <!-- Un solo span: .surf-page-sub es flex con gap, y un strong suelto se vuelve otro item. -->
            <span>Las reglas que el sistema necesita y sólo el negocio conoce. <strong>Contestar es configurar</strong>: la respuesta queda con quién, cuándo, desde cuándo rige y por qué.</span>
          </p>
        </div>
        <div class="ad-head-actions">
          <!-- Otra persona puede contestar o repartir mientras la lista está abierta: se dice cuándo se leyó. -->
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()"
                  (click)="cargar()" aria-label="Volver a leer las preguntas">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (puedeVer()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen de las definiciones"></app-metric-strip>
      }

      @if (opciones().length > 1) {
        <app-segmented [options]="opciones()" [value]="vista()" (valueChange)="cambiarVista($event)"
                       ariaLabel="Qué preguntas ver" />
      }

      <app-load-state class="dt-scope" [loading]="loading()" [error]="error()" [isEmpty]="!filas().length" [skeletonRows]="8"
                      emptyIcon="pi-check-circle"
                      [emptyTitle]="vista() === 'mias' ? 'No tienes preguntas por contestar' : 'No hay preguntas'"
                      emptyHint="Cuando alguien te asigne una regla por definir, aparece aquí y en «Mi trabajo»."
                      (retry)="cargar()">
        <p-table [value]="filas()" [scrollable]="true" scrollHeight="flex" dataKey="id"
                 class="ad-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                 [rowHover]="true" [tableStyle]="{ 'min-width': '56rem' }">
          <ng-template #header>
            <tr>
              <th>Pregunta</th>
              <th>Respuesta que rige hoy</th>
              <th>Quién la contesta</th>
              <th class="comm-num">Plazo</th>
            </tr>
          </ng-template>
          <ng-template #body let-d>
            <tr class="ad-row" [class.ad-row-sel]="sel()?.id === d.id" (click)="abrir(d)" tabindex="0"
                (keydown.enter)="abrir(d)" [attr.aria-label]="'Pregunta: ' + d.question">
              <td role="cell" data-label="Pregunta">
                <span class="ad-pregunta">{{ d.question }}</span>
                <span class="ad-sub">{{ consumidor(d.consumer).label }} · {{ area(d.area) }}</span>
              </td>
              <td role="cell" data-label="Respuesta que rige hoy">
                @if (d.status === 'descartada') {
                  <p-tag value="descartada" severity="secondary" />
                } @else if (d.vigente.estado === 'definida') {
                  <span class="ad-valor">{{ valorTexto(d, d.vigente.valor) }}</span>
                } @else {
                  <span class="ad-falta">sin definir</span>
                  @if (d.suggested_value !== null && d.suggested_value !== undefined) {
                    <span class="ad-sub">propuesta: {{ valorTexto(d, d.suggested_value) }}</span>
                  }
                }
              </td>
              <td role="cell" data-label="Quién la contesta">
                @if (d.asignado_nombre) {
                  {{ d.asignado_nombre }}
                } @else if (d.status === 'pendiente') {
                  <!-- Neutro a propósito: con 15 iguales el naranja no distinguía nada; el conteo va arriba. -->
                  <span class="ad-falta">sin dueño</span>
                } @else {
                  <span class="ad-sub">—</span>
                }
              </td>
              <td role="cell" data-label="Plazo" class="comm-num" [class.ad-vencida]="vencida(d)">
                {{ d.due_at ? (d.due_at | date: 'd MMM' : undefined : 'es-MX') : '—' }}
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <app-side-peek [(open)]="peek" [width]="560" [title]="sel()?.question || ''"
                     [subtitle]="sel() ? consumidor(sel()!.consumer).label : ''">
        @if (peek() && sel(); as d) {
          <div class="ad-peek">
            @if (msg()) {
              <div class="ad-error" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ msg() }}</span>
              </div>
            }

            <section>
              <h3>Qué decide</h3>
              <p>{{ d.decides || 'La pregunta no dice qué decide.' }}</p>
              @if (consumidor(d.consumer).ruta) {
                <a class="ad-link" [routerLink]="consumidor(d.consumer).ruta">Ver {{ consumidor(d.consumer).label }} →</a>
              }
            </section>

            <section>
              <h3>Respuesta que rige hoy</h3>
              @if (d.vigente.estado === 'definida') {
                <p class="ad-valor-grande">{{ valorTexto(d, d.vigente.valor) }}</p>
                <p class="ad-sub">
                  Rige desde {{ d.vigente.respuesta.valid_from }} · «{{ d.vigente.respuesta.note }}»
                  @if (d.respuestas > 1) { · {{ d.respuestas }} respuestas en su historia }
                </p>
              } @else {
                <p class="ad-falta">Sin definir · {{ motivoSinDefinir(d) }}</p>
              }
            </section>

            @if (d.suggested_value !== null && d.suggested_value !== undefined && d.vigente.estado !== 'definida') {
              <section class="ad-propuesta">
                <h3>Propuesta, todavía no es respuesta</h3>
                <p><strong>{{ valorTexto(d, d.suggested_value) }}</strong></p>
                <p class="ad-sub">{{ d.suggested_source }}</p>
                @if (esMia(d)) {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="usarPropuesta(d)">
                    <span class="p-button-label">Usar la propuesta</span>
                  </button>
                }
              </section>
            }

            @if (d.status !== 'descartada' && esMia(d)) {
              <section class="ad-form" aria-label="Contestar">
                <h3>{{ d.vigente.estado === 'definida' ? 'Cambiar la respuesta' : 'Tu respuesta' }}</h3>
                @switch (d.value_type) {
                  @case ('choice') {
                    <p-select [options]="opcionesDe(d)" optionLabel="label" optionValue="value" [(ngModel)]="valor"
                              placeholder="Elige una opción" appendTo="body" inputId="ad-valor" />
                  }
                  @case ('choices') {
                    <p-multiselect [options]="opcionesDe(d)" optionLabel="label" optionValue="value" [(ngModel)]="valor"
                                   placeholder="Elige una o varias" appendTo="body" inputId="ad-valor" />
                  }
                  @case ('boolean') {
                    <p-select [options]="siNo" optionLabel="label" optionValue="value" [(ngModel)]="valor"
                              placeholder="Sí o no" appendTo="body" inputId="ad-valor" />
                  }
                  @case ('money') {
                    <p-inputnumber [(ngModel)]="valor" mode="currency" currency="MXN" locale="es-MX" [min]="0" inputId="ad-valor" />
                  }
                  @case ('percent') {
                    <p-inputnumber [(ngModel)]="valor" suffix=" %" [min]="0" [max]="100" [maxFractionDigits]="3" inputId="ad-valor" />
                  }
                  @case ('number') {
                    <p-inputnumber [(ngModel)]="valor" [min]="0" [maxFractionDigits]="3" inputId="ad-valor" />
                    @if (d.unit) { <span class="ad-sub">{{ d.unit }}</span> }
                  }
                  @case ('date') {
                    <p-datepicker [(ngModel)]="valor" dateFormat="dd/mm/yy" appendTo="body" inputId="ad-valor" />
                  }
                  @case ('config_ref') {
                    <p class="ad-sub">
                      Se configura en su pantalla
                      @if (d.config_route) { (<a class="ad-link" [routerLink]="d.config_route">abrirla</a>) }
                      y aquí anotas cuál configuración la contesta.
                    </p>
                    <input pInputText type="text" [(ngModel)]="valor" placeholder="Qué configuración la contesta" id="ad-valor" />
                  }
                  @default {
                    <textarea pTextarea rows="3" [(ngModel)]="valor" id="ad-valor"></textarea>
                  }
                }

                <label class="ad-label" for="ad-vigencia">Rige desde</label>
                <p-datepicker [(ngModel)]="vigencia" dateFormat="dd/mm/yy" appendTo="body" inputId="ad-vigencia" />
                @if (vigenciaPasada()) {
                  <p class="ad-aviso" role="status">
                    Rige desde una fecha pasada: reescribe la regla también para lo que ya se calculó desde entonces.
                  </p>
                }

                <label class="ad-label" for="ad-motivo">Por qué (obligatorio)</label>
                <textarea pTextarea id="ad-motivo" rows="2" [(ngModel)]="motivo"
                          placeholder="Lo que explica esta regla dentro de seis meses"></textarea>

                <button pButton type="button" class="p-button-sm" [disabled]="!puedeGuardar() || guardando()" (click)="guardar(d)">
                  <span class="p-button-label">{{ guardando() ? 'Guardando…' : 'Guardar respuesta' }}</span>
                </button>
                @if (problemaRespuesta(); as p) { <p class="ad-sub">{{ p }}</p> }
              </section>
            } @else if (d.status !== 'descartada') {
              <p class="ad-sub">
                @if (d.asignado_nombre) { La contesta {{ d.asignado_nombre }}. } @else { Todavía no tiene dueño. }
              </p>
            }

            @if (puedeGestionar() && d.status !== 'descartada') {
              <section class="ad-reparto" aria-label="Repartir">
                <h3>Quién la contesta</h3>
                <p-select [options]="asignables()" optionLabel="nombre" optionValue="id" [(ngModel)]="duenoNuevo"
                          [filter]="true" filterBy="nombre" placeholder="Elige a una persona" appendTo="body"
                          inputId="ad-dueno" />
                <label class="ad-label" for="ad-plazo">Plazo</label>
                <p-datepicker [(ngModel)]="plazo" dateFormat="dd/mm/yy" appendTo="body" inputId="ad-plazo" [showClear]="true" />
                <div class="ad-acc">
                  <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="guardando()"
                          (click)="asignar(d, duenoNuevo)">
                    <span class="p-button-label">Asignar</span>
                  </button>
                  @if (!esMia(d)) {
                    <button pButton type="button" class="p-button-sm p-button-text" [disabled]="guardando()"
                            (click)="asignar(d, yo())">
                      <span class="p-button-label">Asignármela</span>
                    </button>
                  }
                </div>
              </section>

              @if (d.status === 'pendiente') {
                <section class="ad-descartar" aria-label="Descartar">
                  <label class="ad-label" for="ad-descarte">Descartar la pregunta (sólo si la regla ya no existe)</label>
                  <textarea pTextarea id="ad-descarte" rows="2" [(ngModel)]="motivoDescarte" placeholder="Por qué ya no aplica"></textarea>
                  <button pButton type="button" class="p-button-sm p-button-text ad-btn-bad"
                          [disabled]="!motivoDescarte.trim() || guardando()" (click)="descartar(d)">
                    <span class="p-button-label">Descartar</span>
                  </button>
                </section>
              }
            }

            <p class="ad-key mono">{{ d.key }}</p>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styleUrls: ['./admin-definiciones.component.css'],
})
export class AdminDefinicionesComponent implements OnInit {
  private api = inject(DefinicionesService);
  private perms = inject(PermissionsService);
  private auth = inject(AuthService);
  private toast = inject(MessageService);
  private destroyRef = inject(DestroyRef);

  readonly puedeVer = this.perms.hasAny$(Permission.DEFINICIONES_VER, Permission.DEFINICIONES_GESTIONAR);
  readonly puedeGestionar = this.perms.has$(Permission.DEFINICIONES_GESTIONAR);
  readonly yo = computed(() => this.auth.user()?.sub ?? null);

  readonly mias = signal<DefinicionVista[]>([]);
  readonly todas = signal<DefinicionVista[]>([]);
  readonly asignables = signal<PersonaAsignable[]>([]);
  readonly vista = signal<'mias' | 'todas'>('mias');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly sel = signal<DefinicionVista | null>(null);
  readonly peek = signal(false);
  readonly msg = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly cargadoEn = signal<Date | null>(null);

  // El formulario: ngModel, así que son campos y no signals; los computed de abajo se recalculan por evento.
  valor: unknown = null;
  vigencia: Date = new Date();
  motivo = '';
  duenoNuevo: string | null = null;
  plazo: Date | null = null;
  motivoDescarte = '';

  readonly siNo = [{ label: 'Sí', value: true }, { label: 'No', value: false }];

  readonly opciones = computed<SegOption[]>(() => {
    const o: SegOption[] = [{ label: 'A tu nombre', value: 'mias', count: this.mias().filter((d) => d.status === 'pendiente').length }];
    if (this.puedeVer()) o.push({ label: 'Todas', value: 'todas', count: this.todas().length });
    return o;
  });

  /** DP.UI.2: en «Todas», lo SIN dueño arriba (lo que falta repartir); después por plazo; al final lo cerrado. */
  readonly filas = computed(() => {
    if (this.vista() === 'mias') return this.mias();
    const rango = (d: DefinicionVista) =>
      d.status === 'pendiente' ? (d.assigned_to ? 1 : 0) : d.status === 'respondida' ? 2 : 3;
    return [...this.todas()].sort((a, b) => rango(a) - rango(b)
      || (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') || a.key.localeCompare(b.key));
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const t = this.todas();
    const pend = t.filter((d) => d.status === 'pendiente');
    const sinDueno = pend.filter((d) => !d.assigned_to).length;
    return [
      { label: 'Por definir', value: pend.length, format: 'number' },
      { label: 'Sin dueño', value: sinDueno, format: 'number', tone: sinDueno ? 'warn' : undefined, sub: 'nadie las va a contestar' },
      { label: 'Definidas', value: t.filter((d) => d.status === 'respondida').length, format: 'number' },
      { label: 'Vencidas', value: pend.filter((d) => this.vencida(d)).length, format: 'number' },
    ];
  });

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    let pendientes = this.puedeVer() ? 2 : 1;
    const listo = () => { if (--pendientes === 0) { this.loading.set(false); this.cargadoEn.set(new Date()); } };
    const falla = (e: unknown) => { this.error.set(this.mensajeDe(e, 'No se pudieron leer las preguntas.')); listo(); };
    this.api.mias().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.mias.set(r);
        // Sin nada a su nombre, quien puede ver todo aterriza en «Todas».
        if (!r.some((d) => d.status === 'pendiente') && this.puedeVer()) this.vista.set('todas');
        listo();
      },
      error: falla,
    });
    if (this.puedeVer()) {
      this.api.todas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.todas.set(r); listo(); },
        error: falla,
      });
    }
    if (this.puedeGestionar()) {
      this.api.asignables().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => this.asignables.set(r),
        error: () => this.asignables.set([]),
      });
    }
  }

  cambiarVista(v: string): void {
    this.vista.set(v === 'todas' ? 'todas' : 'mias');
  }

  abrir(d: DefinicionVista): void {
    this.sel.set(d);
    this.msg.set(null);
    this.valor = d.value_type === 'choices' ? [] : null;
    this.vigencia = new Date();
    this.motivo = '';
    this.duenoNuevo = d.assigned_to;
    this.plazo = d.due_at ? new Date(d.due_at) : null;
    this.motivoDescarte = '';
    this.peek.set(true);
  }

  esMia(d: DefinicionVista): boolean {
    return !!d.assigned_to && d.assigned_to === this.yo();
  }

  vencida(d: DefinicionVista): boolean {
    return d.status === 'pendiente' && !!d.due_at && Date.parse(d.due_at) < Date.now();
  }

  usarPropuesta(d: DefinicionVista): void {
    const p = d.suggested_value;
    this.valor = d.value_type === 'date' && typeof p === 'string' ? new Date(`${p}T12:00:00`)
      : d.value_type === 'config_ref' && p && typeof p === 'object' ? (p as { ref?: string }).ref ?? '' : p;
  }

  /** El valor tal como viaja: fecha a AAAA-MM-DD, `config_ref` envuelto en `{ ref }`. */
  private valorParaEnviar(d: DefinicionVista): unknown {
    if (d.value_type === 'date') return this.valor instanceof Date ? this.dia(this.valor) : this.valor;
    if (d.value_type === 'config_ref') return { ref: typeof this.valor === 'string' ? this.valor.trim() : '' };
    if (d.value_type === 'text') return typeof this.valor === 'string' ? this.valor.trim() : this.valor;
    return this.valor;
  }

  /** DP.UI.4: la MISMA validación del servidor (`validarRespuesta` del contrato), antes de mandar. */
  problemaRespuesta(): string | null {
    const d = this.sel();
    if (!d) return null;
    const v = this.valorParaEnviar(d);
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return null;
    const p = validarRespuesta({ value_type: d.value_type, choices: d.choices }, v);
    return p ? `La respuesta ${p}.` : null;
  }

  puedeGuardar(): boolean {
    const d = this.sel();
    if (!d || !this.vigencia || !this.motivo.trim()) return false;
    return validarRespuesta({ value_type: d.value_type, choices: d.choices }, this.valorParaEnviar(d)) === null;
  }

  vigenciaPasada(): boolean {
    return !!this.vigencia && this.dia(this.vigencia) < this.dia(new Date());
  }

  guardar(d: DefinicionVista): void {
    if (!this.puedeGuardar() || this.guardando()) return;
    this.guardando.set(true); // DP.UI.6: síncrono, antes de esperar la respuesta.
    this.msg.set(null);
    this.api.contestar(d.id, { value: this.valorParaEnviar(d), valid_from: this.dia(this.vigencia), note: this.motivo.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.guardando.set(false);
          this.reemplazar(r);
          this.toast.add({ severity: 'success', summary: 'Respuesta guardada', detail: `Rige desde ${this.dia(this.vigencia)}`, life: 3500 });
          this.peek.set(false);
        },
        error: (e) => { this.guardando.set(false); this.msg.set(this.mensajeDe(e, 'No se guardó. Nada cambió.')); },
      });
  }

  asignar(d: DefinicionVista, persona: string | null): void {
    if (!persona || this.guardando()) return;
    this.guardando.set(true);
    this.msg.set(null);
    this.api.actualizar(d.id, { assigned_to: persona, due_at: this.plazo ? this.plazo.toISOString() : null })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.guardando.set(false);
          this.reemplazar(r);
          this.sel.set(r);
          this.toast.add({ severity: 'success', summary: 'Asignada', detail: r.asignado_nombre ?? '', life: 3000 });
        },
        error: (e) => { this.guardando.set(false); this.msg.set(this.mensajeDe(e, 'No se asignó. Nada cambió.')); },
      });
  }

  descartar(d: DefinicionVista): void {
    const motivo = this.motivoDescarte.trim();
    if (!motivo || this.guardando()) return;
    this.guardando.set(true);
    this.api.actualizar(d.id, { discard_reason: motivo }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.guardando.set(false); this.reemplazar(r); this.peek.set(false); },
      error: (e) => { this.guardando.set(false); this.msg.set(this.mensajeDe(e, 'No se descartó. Nada cambió.')); },
    });
  }

  /** Copia mutable: el contrato declara las opciones `readonly` y el `[options]` de PrimeNG no las acepta así. */
  opcionesDe(d: DefinicionVista): { value: string; label: string }[] {
    return [...(d.choices ?? [])];
  }

  consumidor(c: string): { label: string; ruta: string | null } {
    return CONSUMIDORES[c] ?? { label: c, ruta: null };
  }

  area(a: string): string {
    return AREAS[a] ?? a;
  }

  motivoSinDefinir(d: DefinicionVista): string {
    if (d.vigente.estado !== 'sin_definir') return '';
    if (d.vigente.motivo === 'no_rige_aun') return 'la respuesta todavía no rige';
    if (d.vigente.motivo === 'descartada') return 'la pregunta se descartó';
    return 'nadie la ha contestado';
  }

  /** El valor en llano: la etiqueta de la opción, no su código; dinero con signo. */
  valorTexto(d: DefinicionVista, v: unknown): string {
    if (v === null || v === undefined) return '—';
    const etiqueta = (x: unknown) => d.choices?.find((c) => c.value === x)?.label ?? String(x);
    switch (d.value_type) {
      case 'choice': return etiqueta(v);
      case 'choices': return Array.isArray(v) ? v.map(etiqueta).join(', ') : String(v);
      case 'boolean': return v === true ? 'Sí' : v === false ? 'No' : String(v);
      case 'money': return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(v));
      case 'percent': return `${Number(v)} %`;
      case 'number': return `${Number(v)}${d.unit ? ` ${d.unit}` : ''}`;
      case 'config_ref': return typeof v === 'object' ? String((v as { ref?: string }).ref ?? '—') : String(v);
      default: return String(v);
    }
  }

  private reemplazar(r: DefinicionVista): void {
    const cambia = (lista: DefinicionVista[]) => lista.map((x) => (x.id === r.id ? r : x));
    this.todas.set(cambia(this.todas()));
    const ya = this.mias().some((x) => x.id === r.id);
    const mia = r.assigned_to === this.yo();
    this.mias.set(mia ? (ya ? cambia(this.mias()) : [...this.mias(), r]) : this.mias().filter((x) => x.id !== r.id));
  }

  /** `YYYY-MM-DD` en hora LOCAL: `toISOString()` es UTC y de noche adelanta el día. */
  private dia(f: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }

  private mensajeDe(e: unknown, defecto: string): string {
    const m = (e as { error?: { message?: string | string[] } })?.error?.message;
    if (Array.isArray(m)) return m.join(' · ');
    return m ?? defecto;
  }
}
