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

interface Dimension {
  mode: Modo;
  source: string;
  nota: string | null;
  values: string[];
  supportsOwn: boolean;
  resolvable: boolean;
  options: Array<{ value: string; label: string }>;
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

          @if (modo(d.code) === 'listed') {
            <p-multiselect [options]="d.dim.options" [ngModel]="valores(d.code)"
                           (ngModelChange)="setValores(d.code, $event)" optionLabel="label"
                           optionValue="value" appendTo="body" [filter]="true" display="chip"
                           [disabled]="!puedeEscribir" placeholder="Elegí cuáles"
                           [attr.aria-label]="'Valores de ' + etiqueta(d.code)"></p-multiselect>
            @if (!d.dim.options.length) {
              <p class="ps-aviso">
                El catálogo de esta dimensión llegó vacío, así que «una lista» no se puede armar.
              </p>
            }
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
        this.original.set((a.dimensions ?? {}) as unknown as Record<string, Dimension>);
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

  modoOpts(d: Dimension): Array<{ label: string; value: Modo | null }> {
    const opts: Array<{ label: string; value: Modo | null }> = [
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
