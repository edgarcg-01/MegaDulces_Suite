import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TextareaModule } from 'primeng/textarea';

import { AdminService } from '../admin.service';
// `[ZN.8]` Las áreas se DERIVAN de AUTHZ_TREE; el front no tiene su propia lista (ADR-056).
import { AREAS_DE_ALCANCE } from '@megadulces/contracts/authz/scope-areas';
import type { ExcepcionDeAlcance } from '@megadulces/contracts';

/**
 * `[AU.10]` — Qué filas ve una persona, en las seis dimensiones.
 *
 * ⛔ El alcance es **fail-closed**: sin regla no ve nada. Por eso la pantalla
 * distingue tres cosas que se parecen — heredar del rol, no ver nada a
 * propósito, y *no se pudo resolver* (`resolvable: false`, que es «no sé», no
 * «cero»).
 *
 * Las opciones de cada dimensión salen del servidor (`describe()` las resuelve
 * desde `scope_dimensions.ref_table`), igual que `supportsOwn`, que es la misma
 * fuente contra la que `setScope` valida: ofrecer «su ficha» donde el endpoint
 * lo rechaza sería un formulario que se rebota a sí mismo.
 */

type Modo = 'none' | 'own' | 'listed' | 'all';

/** `[ZN.8]` La excepción que se está escribiendo. `area`/`mode` en `null` = todavía sin elegir. */
interface NuevaExcepcion {
  area: string | null;
  mode: Modo | null;
  values: string[];
  nota: string;
}

interface Dimension {
  mode: Modo;
  source: string;
  nota: string | null;
  values: string[];
  supportsOwn: boolean;
  resolvable: boolean;
  /** Lo que la persona ALCANZA hoy — un read-model. No sirve para editar: ver `universe`. */
  options: Array<{ value: string; label: string }>;
  /** `[ZN.6]` Todo lo que se le puede otorgar. Es lo que este editor tiene que ofrecer. */
  universe: Array<{ value: string; label: string }>;
  /** `[ZN.6]` Lo que tiene guardado y ya no existe en el universo. Se muestra marcado. */
  valuesFueraDelUniverso: string[];
}

@Component({
  selector: 'app-persona-datos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TagModule, SelectModule, MultiSelectModule,
    TextareaModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cargando()) {
      <p class="pd-vacio">Leyendo el alcance…</p>
    } @else if (error()) {
      <div class="pd-error" role="alert">
        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ error() }}</span>
      </div>
    } @else {
      <p class="pd-hint">
        Qué filas ve en cada dimensión. <strong>Sin regla no ve nada</strong> — es fail-closed a
        propósito. Dejar «lo que diga su perfil» es lo normal; poner una regla propia es la
        excepción, y por eso pide motivo.
      </p>

      @if (servidorSinUniverso()) {
        <div class="pd-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>
            El servidor todavía no manda el catálogo de cada dimensión, así que
            <strong>«una lista» no se puede armar</strong> y lo que veas acá está incompleto.
            Falta redesplegar el API. No es que no haya opciones.
          </span>
        </div>
      }

      @for (d of lista(); track d.code) {
        <section class="ps-dim" [class.ps-dim-tocada]="tocada(d.code)">
          <header class="ps-dim-head">
            <span class="ps-dim-nom">{{ etiqueta(d.code) }}</span>
            <p-tag [value]="fuenteLabel(d.dim.source)" severity="secondary" styleClass="pd-tag"></p-tag>
            @if (!d.dim.resolvable) {
              <p-tag value="no resoluble" severity="warn" styleClass="pd-tag"></p-tag>
            }
          </header>

          @if (!d.dim.resolvable) {
            <p class="ps-aviso">
              Su regla dice «su ficha» y la ficha no trae el dato, así que <strong>no se puede
              resolver</strong>. No es que vea cero: es que no se sabe. Se arregla llenando el campo
              en la pestaña Persona, o poniéndole acá una regla explícita.
            </p>
          }

          <p-select [options]="modoOpts(d.dim)" [ngModel]="modo(d.code)"
                    (ngModelChange)="setModo(d.code, $event)" optionLabel="label" optionValue="value"
                    appendTo="body" [disabled]="!puedeEscribir"
                    [attr.aria-label]="'Modo de ' + etiqueta(d.code)"></p-select>

          <!-- [ZN.6] Las opciones salen de "universe" (todo lo que se le puede OTORGAR), no de
               "options" (lo que la persona alcanza hoy). Con "options" este editor solo podia
               QUITAR: en modo "una lista" ofrecia exactamente lo que ya tenia, y en "no ve nada"
               ofrecia una lista vacia. Reportado como "por que en zonas solo aparece eso".
               SIN ACENTOS GRAVES: adentro de un template literal rompen el build del repo. -->
          @if (modo(d.code) === 'listed') {
            <p-multiselect [options]="d.dim.universe" [ngModel]="valores(d.code)"
                           (ngModelChange)="setValores(d.code, $event)" optionLabel="label"
                           optionValue="value" appendTo="body" [filter]="true" display="chip"
                           [disabled]="!puedeEscribir" placeholder="Elegí cuáles"
                           [attr.aria-label]="'Valores de ' + etiqueta(d.code)"></p-multiselect>
            @if (!d.dim.universe.length) {
              <p class="ps-aviso">
                El catálogo de esta dimensión llegó vacío, así que «una lista» no se puede armar.
              </p>
            }
          }

          @if (d.dim.valuesFueraDelUniverso.length) {
            <p class="ps-aviso">
              Tiene guardado <strong>{{ d.dim.valuesFueraDelUniverso.length }}</strong> valor(es)
              que ya <strong>no existen</strong> en {{ etiqueta(d.code) | lowercase }}: se borraron,
              o nunca debieron poder elegirse. Mientras sigan ahí <strong>filtra por algo que no
              está</strong>, o sea que no ve nada por ese lado. Elegí de nuevo y guardá.
            </p>
          }

          @if (tocada(d.code)) {
            @if (modo(d.code) !== null) {
              <textarea pTextarea [ngModel]="nota(d.code)" (ngModelChange)="setNota(d.code, $event)"
                        rows="2" maxlength="300"
                        placeholder="Por qué esta persona ve esto y no lo que dice su perfil (obligatorio)"></textarea>
            }
            <div class="ps-dim-acc">
              <button pButton type="button" class="p-button-sm p-button-text"
                      (click)="deshacer(d.code)">
                <span class="p-button-label">Deshacer</span>
              </button>
              <button pButton type="button" class="p-button-sm" severity="contrast"
                      [disabled]="guardando() === d.code || !puedeGuardar(d.code)"
                      (click)="guardar(d.code)">
                <span class="p-button-label">Guardar</span>
              </button>
            </div>
          }

          <!-- [ZN.8] Donde ve DISTINTO. Lo de arriba es la regla general; esto son las
               excepciones por area, que es lo que antes no se podia escribir y obligaba a
               mover la unica palanca una y otra vez. -->
          <div class="ps-exc">
            @for (e of excepcionesDe(d.code); track e.area) {
              <div class="ps-exc-fila">
                <span class="ps-exc-area">{{ e.area_label }}</span>
                <span class="ps-exc-regla">{{ comoSeLee(e.mode, e.values) }}</span>
                @if (e.nota) { <span class="ps-exc-nota" [title]="e.nota">{{ e.nota }}</span> }
                @if (puedeEscribir) {
                  <button pButton type="button" class="p-button-sm p-button-text"
                          [disabled]="guardando() === d.code"
                          (click)="quitarExcepcion(d.code, e.area)"
                          [attr.aria-label]="'Quitar la excepcion de ' + e.area_label">
                    <span class="p-button-label">Quitar</span>
                  </button>
                }
              </div>
            } @empty {
              <p class="ps-exc-vacio">Ve lo mismo en toda la app.</p>
            }

            @if (puedeEscribir) {
              @if (nueva(d.code); as n) {
                <div class="ps-exc-nueva">
                  <p-select [options]="areasLibres(d.code)" [ngModel]="n.area"
                            (ngModelChange)="setExc(d.code, { area: $event })"
                            optionLabel="label" optionValue="value" appendTo="body"
                            placeholder="¿En qué área?" ariaLabel="Area de la excepcion" />
                  <p-select [options]="modoOpts(d.dim, true)" [ngModel]="n.mode"
                            (ngModelChange)="setExc(d.code, { mode: $event })"
                            optionLabel="label" optionValue="value" appendTo="body"
                            placeholder="¿Qué ve ahí?" ariaLabel="Modo de la excepcion" />
                  @if (n.mode === 'listed') {
                    <p-multiselect [options]="d.dim.universe" [ngModel]="n.values"
                                   (ngModelChange)="setExc(d.code, { values: $event })"
                                   optionLabel="label" optionValue="value" appendTo="body"
                                   [filter]="true" display="chip" placeholder="Elegí cuáles"
                                   ariaLabel="Valores de la excepcion" />
                  }
                  <textarea pTextarea [ngModel]="n.nota" (ngModelChange)="setExc(d.code, { nota: $event })"
                            rows="2" maxlength="300"
                            placeholder="Por qué acá ve distinto que en el resto (obligatorio)"></textarea>
                  <div class="ps-dim-acc">
                    <button pButton type="button" class="p-button-sm p-button-text"
                            (click)="cancelarExc(d.code)">
                      <span class="p-button-label">Cancelar</span>
                    </button>
                    <button pButton type="button" class="p-button-sm" severity="contrast"
                            [disabled]="guardando() === d.code || !puedeGuardarExc(d.code)"
                            (click)="guardarExc(d.code)">
                      <span class="p-button-label">Guardar excepción</span>
                    </button>
                  </div>
                </div>
              } @else if (areasLibres(d.code).length) {
                <button pButton type="button" class="p-button-sm p-button-text"
                        (click)="nuevaExcepcion(d.code)">
                  <span class="p-button-label">+ Ve distinto en un área</span>
                </button>
              }
            }
          </div>
        </section>
      }
    }
  `,
  styleUrls: ['./persona-datos.component.css'],
})
export class PersonaDatosComponent implements OnChanges {
  private api = inject(AdminService);
  private destroyRef = inject(DestroyRef);

  @Input() userId: string | null = null;
  @Input() puedeEscribir = false;
  @Output() guardado = new EventEmitter<string>();

  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardando = signal<string | null>(null);
  /** `[ZN.6]` El servidor no mandó `universe` → está corriendo código previo a esta entrega. */
  readonly servidorSinUniverso = signal(false);
  /** `[ZN.8]` Las reglas por área que la persona ya tiene, agrupadas por dimensión. */
  private readonly excepciones = signal<Record<string, ExcepcionDeAlcance[]>>({});
  /** `[ZN.8]` La excepción que se está escribiendo, por dimensión. `null` = ninguna abierta. */
  private readonly nuevas = signal<Record<string, NuevaExcepcion>>({});

  private readonly original = signal<Record<string, Dimension>>({});
  private readonly edicion = signal<Record<string, { mode: Modo | null; values: string[]; nota: string }>>({});

  readonly lista = computed(() =>
    Object.entries(this.original()).map(([code, dim]) => ({ code, dim })),
  );

  private readonly ETIQUETAS: Record<string, string> = {
    warehouse: 'Sucursal / almacén',
    zone: 'Zona',
    route: 'Ruta',
    brand: 'Marca',
    expense_area: 'Área de gasto',
    customer: 'Cliente',
  };

  ngOnChanges(): void {
    this.original.set({});
    this.edicion.set({});
    this.error.set(null);
    if (!this.userId) return;
    this.cargando.set(true);
    this.api.alcanceDe(this.userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => {
        // `[ZN.6]` `universe` nació con esta entrega. Si el `api` todavía no se redesplegó,
        // llega `undefined` y el `.length` del template reventaría la pestaña entera. Se
        // normaliza acá — y se DECLARA: caer a `options` restauraría en silencio el defecto que
        // esta entrega cierra (el editor que sólo puede quitar), y un selector vacío sin
        // explicación se lee como «no hay nada que elegir», que es otra cosa.
        const dims = (a.dimensions ?? {}) as unknown as Record<string, Partial<Dimension>>;
        let faltaUniverso = false;
        const normalizadas: Record<string, Dimension> = {};
        for (const [code, d] of Object.entries(dims)) {
          if (d.universe === undefined) faltaUniverso = true;
          normalizadas[code] = {
            ...(d as Dimension),
            options: d.options ?? [],
            universe: d.universe ?? [],
            valuesFueraDelUniverso: d.valuesFueraDelUniverso ?? [],
          };
        }
        this.servidorSinUniverso.set(faltaUniverso);
        this.original.set(normalizadas);
        // `[ZN.8]` Ausente = el API todavía no las manda. Se trata como «no hay», que es lo
        // honesto: no inventamos excepciones, y el bloque dirá «ve lo mismo en toda la app».
        const porDim: Record<string, ExcepcionDeAlcance[]> = {};
        for (const e of a.excepciones ?? []) (porDim[e.dimension] ??= []).push(e);
        this.excepciones.set(porDim);
        this.nuevas.set({});
        this.cargando.set(false);
      },
      error: (e) => {
        this.error.set(this.mensajeDe(e));
        this.cargando.set(false);
      },
    });
  }

  etiqueta(code: string): string {
    return this.ETIQUETAS[code] ?? code;
  }

  /** De dónde sale hoy la regla. `usuario` = alguien la puso a mano. */
  fuenteLabel(source: string): string {
    if (source === 'user') return 'regla propia';
    if (source === 'role') return 'de su perfil';
    return source || 'default';
  }

  /**
   * `[ZN.8]` `paraExcepcion` saca «Lo que diga su perfil»: en una excepción ese modo no existe
   * — una excepción que dice «lo mismo que en el resto» no es una excepción, es ruido. Para
   * volver atrás está el botón Quitar.
   */
  modoOpts(d: Dimension, paraExcepcion = false): Array<{ label: string; value: Modo | null }> {
    const opts: Array<{ label: string; value: Modo | null }> = paraExcepcion
      ? [{ label: 'No ve nada', value: 'none' }]
      : [
          { label: 'Lo que diga su perfil', value: null },
          { label: 'No ve nada', value: 'none' },
        ];
    // `supportsOwn` viene del servidor: ofrecerlo donde el endpoint lo rechaza
    // sería un formulario que se rebota a sí mismo.
    if (d.supportsOwn) opts.push({ label: 'Sólo lo suyo (su ficha)', value: 'own' });
    opts.push({ label: 'Una lista', value: 'listed' }, { label: 'Todo', value: 'all' });
    return opts;
  }

  tocada(code: string): boolean {
    return code in this.edicion();
  }

  modo(code: string): Modo | null {
    const e = this.edicion()[code];
    if (e) return e.mode;
    const d = this.original()[code];
    return d?.source === 'user' ? d.mode : null;
  }

  valores(code: string): string[] {
    return this.edicion()[code]?.values ?? this.original()[code]?.values ?? [];
  }

  nota(code: string): string {
    return this.edicion()[code]?.nota ?? this.original()[code]?.nota ?? '';
  }

  private tocar(code: string, parche: Partial<{ mode: Modo | null; values: string[]; nota: string }>): void {
    const actual = this.edicion()[code] ?? {
      mode: this.modo(code),
      values: this.valores(code),
      nota: this.nota(code),
    };
    this.edicion.set({ ...this.edicion(), [code]: { ...actual, ...parche } });
  }

  setModo(code: string, mode: Modo | null): void {
    this.tocar(code, { mode });
  }

  setValores(code: string, values: string[]): void {
    this.tocar(code, { values });
  }

  setNota(code: string, nota: string): void {
    this.tocar(code, { nota });
  }

  // ───────────────────────── `[ZN.8]` excepciones por área ─────────────────────────

  excepcionesDe(code: string): ExcepcionDeAlcance[] {
    return this.excepciones()[code] ?? [];
  }

  nueva(code: string): NuevaExcepcion | null {
    return this.nuevas()[code] ?? null;
  }

  /**
   * Las áreas donde esta persona **todavía no** tiene una regla propia en esta dimensión.
   * Ofrecer una que ya tiene invitaría a pisarla sin decirlo — y el `onConflict` del backend la
   * pisaría de verdad.
   */
  areasLibres(code: string): Array<{ label: string; value: string }> {
    const usadas = new Set(this.excepcionesDe(code).map((e) => e.area));
    return AREAS_DE_ALCANCE
      .filter((a) => !usadas.has(a.id))
      .map((a) => ({ label: a.label, value: a.id }));
  }

  /** Cómo se lee una regla guardada, en una línea. */
  comoSeLee(mode: string, values: string[] | null): string {
    if (mode === 'all') return 've todo';
    if (mode === 'none') return 'no ve nada';
    if (mode === 'own') return 'sólo lo suyo';
    return `una lista de ${values?.length ?? 0}`;
  }

  nuevaExcepcion(code: string): void {
    this.nuevas.set({ ...this.nuevas(), [code]: { area: null, mode: null, values: [], nota: '' } });
  }

  setExc(code: string, parche: Partial<NuevaExcepcion>): void {
    const actual = this.nueva(code);
    if (!actual) return;
    this.nuevas.set({ ...this.nuevas(), [code]: { ...actual, ...parche } });
  }

  cancelarExc(code: string): void {
    const { [code]: _fuera, ...resto } = this.nuevas();
    this.nuevas.set(resto);
  }

  /**
   * Una excepción pide **más** que la regla general: además del modo y el motivo, el área.
   * ⚠️ El motivo no es burocracia — es lo único que explica, seis meses después, por qué esta
   * persona ve distinto acá que en el resto de la app.
   */
  puedeGuardarExc(code: string): boolean {
    const n = this.nueva(code);
    if (!n || !n.area || !n.mode) return false;
    if (!n.nota.trim()) return false;
    if (n.mode === 'listed' && !n.values.length) return false;
    return true;
  }

  guardarExc(code: string): void {
    const n = this.nueva(code);
    if (!this.userId || !n || !this.puedeGuardarExc(code)) return;
    this.guardando.set(code);
    this.error.set(null);
    this.api
      .setAlcance(this.userId, code, {
        mode: n.mode,
        values: n.mode === 'listed' ? n.values : undefined,
        nota: n.nota.trim(),
        area: n.area!,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.guardando.set(null); this.cancelarExc(code); this.recargar(code); },
        error: (e) => { this.guardando.set(null); this.error.set(this.mensajeDe(e)); },
      });
  }

  /**
   * ⚠️ Quitar una excepción NO la deja sin alcance: la devuelve a su **regla general**. Es
   * distinto de borrar la general, que la devuelve al rol. Por eso el botón dice «Quitar» y no
   * «Borrar»: lo que se retira es la diferencia, no el acceso.
   */
  quitarExcepcion(code: string, area: string): void {
    if (!this.userId) return;
    this.guardando.set(code);
    this.error.set(null);
    this.api
      .setAlcance(this.userId, code, { mode: null, area })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.guardando.set(null); this.recargar(code); },
        error: (e) => { this.guardando.set(null); this.error.set(this.mensajeDe(e)); },
      });
  }

  /** Releer del servidor: la lista de excepciones es suya, no se arma optimista acá. */
  private recargar(code: string): void {
    this.guardado.emit(`Alcance de ${this.etiqueta(code)} actualizado.`);
    this.ngOnChanges();
  }

  deshacer(code: string): void {
    const { [code]: _fuera, ...resto } = this.edicion();
    this.edicion.set(resto);
  }

  /**
   * Volver a «lo que diga su perfil» es de-escalada y no pide motivo. Poner una
   * regla propia sí: es lo único que explica, seis meses después, por qué esta
   * persona ve algo distinto de su perfil.
   */
  puedeGuardar(code: string): boolean {
    const e = this.edicion()[code];
    if (!e) return false;
    if (e.mode === null) return true;
    if (!e.nota.trim()) return false;
    if (e.mode === 'listed' && !e.values.length) return false;
    return true;
  }

  guardar(code: string): void {
    const e = this.edicion()[code];
    if (!this.userId || !e || !this.puedeGuardar(code)) return;
    this.guardando.set(code);
    this.error.set(null);
    this.api
      .setAlcance(this.userId, code, {
        mode: e.mode,
        values: e.mode === 'listed' ? e.values : undefined,
        nota: e.nota.trim() || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardando.set(null);
          this.deshacer(code);
          this.guardado.emit(`Alcance de ${this.etiqueta(code)} actualizado.`);
          this.ngOnChanges();
        },
        // ⛔ Lo editado NO se pierde: el error se lee y la fila sigue tocada.
        error: (err) => {
          this.guardando.set(null);
          this.error.set(this.mensajeDe(err));
        },
      });
  }

  private mensajeDe(e: unknown): string {
    const err = e as { error?: { message?: string | string[] } };
    const m = err?.error?.message;
    if (Array.isArray(m)) return m.join(' · ');
    return m ?? 'No se pudo leer ni guardar el alcance.';
  }
}
