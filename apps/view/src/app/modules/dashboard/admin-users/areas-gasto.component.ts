import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';

/** Un área del catálogo, con la evidencia de cuánto movimiento tiene. */
interface AreaCandidata { id: string; name: string; solicitudes?: number }

type MotivoPropuesta = 'exacta' | 'contenida' | 'sin_propuesta' | 've_todo';

interface FilaAsignacion {
  user_id: string;
  username: string;
  nombre: string | null;
  role_name: string | null;
  areas_actuales: string[];
  ve_todo: boolean;
  motivo: MotivoPropuesta;
  propuestas: AreaCandidata[];
  explicacion: string;
}

interface EstadoAsignacion {
  ventana_dias: number;
  resumen: { usuarios: number; ya_asignados: number; ven_todo: number; con_propuesta: number; sin_propuesta: number };
  areas: AreaCandidata[];
  filas: FilaAsignacion[];
}

/**
 * `[GX.16]` — **Áreas de gasto: asignación asistida.**
 *
 * Qué resuelve, medido en prod el 2026-09-24: de **76 usuarios** que capturan o revisan
 * gastos, **0 tenían un área asignada**. El selector existe en el diálogo de cada usuario
 * desde GX.8; nadie lo usó, porque son 76 diálogos que hay que abrir uno por uno. El
 * efecto no se veía como error: la persona abría su bandeja y encontraba una lista vacía.
 *
 * Acá están los 76 juntos, con la propuesta y su evidencia al lado, y se confirman en lote.
 *
 * ## ⚠️ El motor propone, la persona confirma
 * Un área da visibilidad sobre el gasto de otro. Por eso **nada se asigna solo**: hay que
 * marcar y guardar. La regla de la propuesta es deliberadamente estricta (el nombre del
 * área tiene que estar contenido ENTERO en el de la persona) — aflojarla proponía el área
 * de un homónimo, y está medido en `area-match.spec.ts`.
 *
 * Con esa regla **47 de los 76 quedan sin propuesta**, y se listan igual con su buscador:
 * el problema era que estaban invisibles, no que faltara automatismo.
 */
@Component({
  selector: 'app-areas-gasto',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, MultiSelectModule, InputTextModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ag">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Áreas de gasto</h1>
          <p class="surf-page-sub">
            Con cuál nombre de «solicitante» de Kepler se le reconocen sus gastos a cada persona.
            Sin área asignada, quien no coincida exacto por nombre <strong>no ve ninguna solicitud suya</strong>.
          </p>
        </div>
      </header>

      @if (cargando()) { <div class="ag-muted">Cargando…</div> }
      @else if (error()) { <div class="ag-err">{{ error() }}</div> }
      @else if (estado(); as e) {
        <div class="ag-kpis">
          <div class="ag-kpi"><span class="ag-k">Personas</span><b>{{ e.resumen.usuarios }}</b></div>
          <div class="ag-kpi"><span class="ag-k">Ya asignadas</span><b [class.ok]="e.resumen.ya_asignados > 0">{{ e.resumen.ya_asignados }}</b></div>
          <div class="ag-kpi"><span class="ag-k">Con propuesta</span><b class="prop">{{ e.resumen.con_propuesta }}</b></div>
          <div class="ag-kpi"><span class="ag-k">Sin propuesta</span><b class="warn">{{ e.resumen.sin_propuesta }}</b></div>
          <div class="ag-kpi"><span class="ag-k">Ven todo</span><b>{{ e.resumen.ven_todo }}</b></div>
        </div>

        <div class="ag-bar">
          <input pInputText type="search" [ngModel]="filtro()" (ngModelChange)="filtro.set($event)"
                 placeholder="Buscar persona…" class="ag-search" aria-label="Buscar persona" />
          <button type="button" class="ag-chip" [class.on]="soloPendientes()" (click)="soloPendientes.set(!soloPendientes())">
            Sólo las que no tienen área
          </button>
          <span class="ag-grow"></span>
          <button pButton type="button" class="p-button-text" [disabled]="!hayPropuestasSinTomar()"
                  (click)="tomarTodasLasPropuestas()">
            Poner todas las propuestas ({{ propuestasSinTomar() }})
          </button>
          <button pButton type="button" [loading]="guardando()" [disabled]="cambios().length === 0"
                  (click)="guardar()">
            Guardar {{ cambios().length ? '(' + cambios().length + ')' : '' }}
          </button>
        </div>

        <div class="ag-list">
          @for (f of visibles(); track f.user_id) {
            <div class="ag-row" [class.dirty]="esDistinto(f)">
              <div class="ag-who">
                <b>{{ f.nombre || f.username }}</b>
                <span class="ag-sub">{{ f.username }} · {{ f.role_name }}</span>
              </div>

              <div class="ag-mid">
                @if (f.ve_todo) {
                  <span class="ag-tag ok">Ve todos los gastos — no necesita área</span>
                } @else {
                  <p-multiselect [options]="opciones()" [ngModel]="seleccion(f)" (ngModelChange)="setSeleccion(f, $event)"
                                 optionLabel="etiqueta" optionValue="id" [filter]="true" filterBy="etiqueta"
                                 display="chip" appendTo="body" styleClass="ag-ms"
                                 placeholder="Sin área — no verá ninguna solicitud suya"
                                 selectedItemsLabel="{0} áreas"></p-multiselect>
                  <span class="ag-why">{{ f.explicacion }}</span>
                }
              </div>

              <div class="ag-act">
                @if (!f.ve_todo && f.propuestas.length && !propuestaTomada(f)) {
                  <button type="button" class="ag-take" (click)="tomarPropuesta(f)">
                    Usar: {{ nombresDe(f.propuestas) }}
                  </button>
                } @else if (!f.ve_todo && f.motivo === 'sin_propuesta') {
                  <span class="ag-tag warn">a mano</span>
                }
              </div>
            </div>
          }
          @if (!visibles().length) { <div class="ag-muted">Nadie coincide con el filtro.</div> }
        </div>
      }
    </div>
  `,
  styles: [`
    .ag { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ag-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-4); }
    .ag-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }

    .ag-kpis { display: flex; flex-wrap: wrap; gap: 0; background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3) 0; }
    .ag-kpi { flex: 1 1 120px; padding: 0 var(--sp-4); border-left: 1px solid var(--c-divider); }
    .ag-kpi:first-child { border-left: 0; }
    .ag-k { display: block; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .ag-kpi b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-h2); }
    .ag-kpi b.ok { color: var(--ok-fg); } .ag-kpi b.warn { color: var(--warn-fg); } .ag-kpi b.prop { color: var(--action); }

    .ag-bar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .ag-grow { flex-grow: 1; }
    .ag-search { min-width: 220px; }
    .ag-chip { height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--fg-2); border-radius: var(--r-sm);
      font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .ag-chip.on { background: var(--fg-1); color: var(--card-bg); border-color: var(--fg-1); }

    .ag-list { display: flex; flex-direction: column; background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .ag-row { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3);
      border-bottom: 1px solid var(--c-divider); }
    .ag-row:last-child { border-bottom: 0; }
    .ag-row.dirty { box-shadow: inset 3px 0 0 var(--action); }
    .ag-who { width: 230px; flex-shrink: 0; display: flex; flex-direction: column; }
    .ag-who b { font-size: var(--fs-sm); }
    .ag-sub { font-size: var(--fs-xs); color: var(--fg-3); }
    .ag-mid { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .ag-why { font-size: var(--fs-xs); color: var(--fg-3); }
    .ag-act { width: 250px; flex-shrink: 0; display: flex; justify-content: flex-end; }
    .ag-take { max-width: 100%; height: 28px; padding: 0 var(--sp-2); border: 1px solid var(--action);
      background: transparent; color: var(--action); border-radius: var(--r-sm); font: inherit;
      font-size: var(--fs-xs); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ag-tag { font-size: var(--fs-xs); border-radius: var(--r-sm); padding: 2px 8px; border: 1px solid var(--border-color); color: var(--fg-2); }
    .ag-tag.ok { color: var(--ok-fg); border-color: var(--ok-border); }
    .ag-tag.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    :host ::ng-deep .ag-ms { width: 100%; }
  `],
})
export class AreasGastoComponent {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/expenses/areas/asignacion`;

  readonly estado = signal<EstadoAsignacion | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');
  readonly guardando = signal(false);
  readonly filtro = signal('');
  readonly soloPendientes = signal(false);

  /** Lo que la persona eligió en pantalla, por usuario. Vacío = no lo tocó. */
  private readonly editado = signal<Record<string, string[]>>({});

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.http.get<EstadoAsignacion>(this.base, { params: new HttpParams().set('dias', '365') })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (e) => { this.estado.set(e); this.editado.set({}); this.cargando.set(false); },
        // Un error NO se pinta como «nadie necesita áreas»: eso es otra afirmación.
        error: () => { this.error.set('No se pudo cargar. ¿Tenés permiso de gestionar usuarios?'); this.cargando.set(false); },
      });
  }

  /** El catálogo con su evidencia en la etiqueta: sin eso no se distingue un área viva de un nombre suelto. */
  readonly opciones = computed(() => (this.estado()?.areas ?? []).map((a) => ({
    id: a.id,
    etiqueta: a.solicitudes ? `${a.name} · ${a.solicitudes}` : a.name,
  })));

  readonly visibles = computed(() => {
    const q = this.filtro().trim().toLowerCase();
    return (this.estado()?.filas ?? []).filter((f) => {
      if (this.soloPendientes() && (f.ve_todo || this.seleccion(f).length > 0)) return false;
      if (!q) return true;
      return `${f.nombre ?? ''} ${f.username} ${f.role_name ?? ''}`.toLowerCase().includes(q);
    });
  });

  seleccion(f: FilaAsignacion): string[] {
    return this.editado()[f.user_id] ?? f.areas_actuales;
  }

  setSeleccion(f: FilaAsignacion, ids: string[]): void {
    this.editado.update((m) => ({ ...m, [f.user_id]: ids ?? [] }));
  }

  esDistinto(f: FilaAsignacion): boolean {
    const a = [...this.seleccion(f)].sort().join(',');
    const b = [...f.areas_actuales].sort().join(',');
    return a !== b;
  }

  propuestaTomada(f: FilaAsignacion): boolean {
    const sel = new Set(this.seleccion(f));
    return f.propuestas.length > 0 && f.propuestas.every((p) => sel.has(p.id));
  }

  nombresDe(areas: AreaCandidata[]): string {
    return areas.map((a) => a.name).join(' + ');
  }

  tomarPropuesta(f: FilaAsignacion): void {
    // Suma, no reemplaza: si ya tenía un área puesta a mano, la propuesta no se la borra.
    const ids = [...new Set([...this.seleccion(f), ...f.propuestas.map((p) => p.id)])];
    this.setSeleccion(f, ids);
  }

  readonly propuestasSinTomar = computed(
    () => (this.estado()?.filas ?? []).filter((f) => !f.ve_todo && f.propuestas.length > 0 && !this.propuestaTomada(f)).length,
  );
  readonly hayPropuestasSinTomar = computed(() => this.propuestasSinTomar() > 0);

  /**
   * Pone TODAS las propuestas en pantalla — pero **no las guarda**: el botón de guardar
   * sigue siendo un acto aparte. Ver la lista completa antes de confirmar es el punto.
   */
  tomarTodasLasPropuestas(): void {
    for (const f of this.estado()?.filas ?? []) {
      if (!f.ve_todo && f.propuestas.length && !this.propuestaTomada(f)) this.tomarPropuesta(f);
    }
  }

  readonly cambios = computed(() => (this.estado()?.filas ?? [])
    .filter((f) => this.esDistinto(f))
    .map((f) => ({ user_id: f.user_id, area_ids: this.seleccion(f) })));

  guardar(): void {
    const asignaciones = this.cambios();
    if (!asignaciones.length) return;
    this.guardando.set(true);
    this.http.post<{ actualizados: number }>(this.base, { asignaciones })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.guardando.set(false);
          this.toast.add({ severity: 'success', summary: 'Áreas guardadas', detail: `${r.actualizados} persona(s)` });
          // Se recarga: lo que queda en pantalla tiene que ser lo que quedó guardado.
          this.cargar();
        },
        error: (e) => {
          this.guardando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'Reintentá' });
        },
      });
  }
}
