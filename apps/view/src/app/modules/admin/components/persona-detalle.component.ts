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
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import type {
  HistoriaDePuesto,
  PersonaFila,
  PropuestaDePuesto,
  ResponsabilidadesDePersona,
} from '@megadulces/contracts';

import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { AdminService, EventoDePersona, OpcionCatalogo, PermisosDePersona } from '../admin.service';

/**
 * `[AU.2]` — La ficha de una persona, organizada por las cinco preguntas que se
 * le hacen: **quién es · qué abre · qué datos ve · de qué responde · qué pasó**.
 *
 * ── Por qué en pestañas y no en un formulario largo ─────────────────────────
 * La ficha anterior era **un `<form>` de 700 líneas con scroll** y dos acordeones
 * al final. Los cinco bloques no se miran juntos casi nunca: quien da de alta
 * mira el puesto, quien audita mira la historia, y quien arregla un acceso mira
 * las excepciones.
 *
 * ── Tres defectos medidos de la pantalla vieja que esto corrige ─────────────
 *  1. **El endpoint de la propuesta no se llamaba.** La propuesta se recalculaba
 *     en el cliente desde el catálogo de puestos, que sólo trae `default_role`:
 *     el jefe, los complementos y las responsabilidades eran invisibles.
 *  2. **En el alta no se podían fijar permisos ni alcance** (estaban gateados a
 *     `isEditing()`), así que crear a alguien eran dos pasos.
 *  3. **`persistPermisos`/`persistAlcance` corrían con el drawer ya cerrado**: si
 *     el PUT fallaba, el toast salía sobre una pantalla sin editor y lo tecleado
 *     se perdía. Acá nada se cierra hasta que todo terminó bien.
 */

type Pestana = 'persona' | 'acceso' | 'datos' | 'responde' | 'historia';

@Component({
  selector: 'app-persona-detalle',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, TagModule, SelectModule, InputTextModule,
    TextareaModule, SegmentedComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pd">
      <app-segmented [options]="pestanas()" [value]="pestana()" (valueChange)="irA($any($event))"
                     ariaLabel="Secciones de la ficha"></app-segmented>

      @if (errorGuardado()) {
        <div class="pd-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ errorGuardado() }}</span>
        </div>
      }

      <!-- ── 1. QUIÉN ES ────────────────────────────────────────────────── -->
      @if (pestana() === 'persona') {
        <section class="pd-blk">
          <label class="pd-lbl" for="pd-nombre">Nombre</label>
          <input pInputText id="pd-nombre" [(ngModel)]="f.nombre" [disabled]="!puedeEscribir"
                 placeholder="Nombre completo" />

          <label class="pd-lbl" for="pd-user">Usuario</label>
          <input pInputText id="pd-user" [(ngModel)]="f.username" [disabled]="!puedeEscribir || !!persona"
                 placeholder="nombre_apellido" class="mono" />
          @if (persona) {
            <p class="pd-hint">El usuario no se renombra: lo referencian la bitácora y las sesiones abiertas.</p>
          }

          <label class="pd-lbl" for="pd-puesto">Puesto</label>
          <p-select inputId="pd-puesto" [options]="puestoOpts()" [(ngModel)]="f.position_code"
                    (onChange)="cargarPropuesta()" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="¿Qué puesto ocupa?"></p-select>
        </section>

        <!-- Lo que el puesto PROPONE: las cuatro cosas, del servidor. -->
        @if (propuesta(); as p) {
          <section class="pd-blk pd-prop">
            <h3>Lo que propone el puesto</h3>

            <dl class="pd-dl">
              <dt>Perfil de acceso</dt>
              <dd>
                @if (p.sin_perfil) {
                  <span class="pd-falta">este puesto todavía no propone un perfil</span>
                } @else {
                  <span class="comm-code">{{ p.role_name }}</span>
                }
              </dd>

              @if (p.complementos.length) {
                <dt>Complementos</dt>
                <dd>
                  @for (c of p.complementos; track c) {
                    <span class="comm-code pd-chip">{{ c }}</span>
                  }
                </dd>
              }

              <dt>Jefe</dt>
              <dd>
                @if (!p.reports_to) {
                  <span class="pd-falta">el puesto no cuelga de ninguno — es raíz del organigrama</span>
                } @else {
                  <span>{{ p.reports_to.name }}</span>
                  @if (p.jefe_sin_ocupante) {
                    <span class="pd-aviso">· vacante: el escalamiento no llega a nadie</span>
                  } @else {
                    <span class="pd-sub">· {{ nombresDe(p.reports_to.ocupantes) }}</span>
                  }
                }
              </dd>

              <dt>Responde de</dt>
              <dd>
                @if (p.sin_responsabilidades) {
                  <span class="pd-falta">nada asignado a este puesto todavía</span>
                } @else {
                  @for (r of p.responsabilidades; track r.key) {
                    <span class="pd-chip" [class.pd-chip-ppal]="r.es_principal">{{ r.label }}</span>
                  }
                }
              </dd>

              <dt>Eje de alcance</dt>
              <dd>{{ p.scope_axis ?? '—' }} <span class="pd-sub">· {{ ejeExplica(p.scope_axis) }}</span></dd>
            </dl>

            <div class="pd-prop-acc">
              <button pButton type="button" class="p-button-sm" severity="contrast"
                      [disabled]="!puedeEscribir || p.sin_perfil" (click)="aceptarPropuesta()">
                <span class="p-button-label">Aceptar lo propuesto</span>
              </button>
              <button pButton type="button" class="p-button-sm p-button-text"
                      [disabled]="!puedeEscribir" (click)="ajustar.set(true)">
                <span class="p-button-label">Ajustar</span>
              </button>
            </div>
          </section>
        }

        @if (ajustar() || !propuesta()) {
          <section class="pd-blk">
            <label class="pd-lbl" for="pd-rol">Perfil de acceso</label>
            <p-select inputId="pd-rol" [options]="rolOpts()" [(ngModel)]="f.role_name" optionLabel="label"
                      optionValue="value" [filter]="true" filterBy="label" appendTo="body"
                      [disabled]="!puedeEscribir" placeholder="Elegí el perfil"></p-select>

            @if (hayDesvio()) {
              <label class="pd-lbl pd-lbl-req" for="pd-motivo">Motivo de apartarse del puesto</label>
              <textarea pTextarea id="pd-motivo" [(ngModel)]="f.motivo_desvio" rows="2" maxlength="300"
                        [disabled]="!puedeEscribir"
                        placeholder="Por qué este perfil y no el que propone el puesto"></textarea>
              <p class="pd-hint">
                El puesto propone <strong>{{ propuesta()?.role_name }}</strong> y elegiste
                <strong>{{ f.role_name }}</strong>. El motivo queda en la bitácora.
              </p>
            }
          </section>
        }
      }

      <!-- ── 2. QUÉ ABRE ────────────────────────────────────────────────── -->
      @if (pestana() === 'acceso') {
        @if (!persona) {
          <p class="pd-vacio">El acceso se configura una vez que la persona existe. Guardá primero.</p>
        } @else if (cargandoAcceso()) {
          <p class="pd-vacio">Leyendo el acceso…</p>
        } @else if (permisos(); as pm) {
          <section class="pd-blk">
            <dl class="pd-dl">
              <dt>Perfil base</dt>
              <dd><span class="comm-code">{{ persona.role_name }}</span></dd>
              <dt>Permisos que abre</dt>
              <dd class="comm-num">{{ pm.efectivos.length }}</dd>
            </dl>

            @if (pm.overrides.length) {
              <div class="pd-aviso-blk" role="status">
                <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                <div>
                  <strong>{{ pm.overrides.length }} clave(s) sueltas</strong> sobre su perfil:
                  {{ cuantosConceden(pm) }} conceden y {{ cuantosQuitan(pm) }} quitan.
                  <p class="pd-sub">
                    Un override de este tamaño no es una excepción: es que el rol no le queda.
                    Lo que corrige el problema de raíz es arreglar el rol, no acumular excepciones.
                  </p>
                  <a class="pd-link" routerLink="/admin/roles">Ir a Roles y permisos →</a>
                </div>
              </div>
              <ul class="pd-lista">
                @for (o of pm.overrides; track o.permission_key) {
                  <li>
                    <span class="comm-code">{{ o.permission_key }}</span>
                    <p-tag [value]="o.allow ? 'concede' : 'quita'"
                           [severity]="o.allow ? 'success' : 'danger'" styleClass="pd-tag"></p-tag>
                    @if (o.nota) { <span class="pd-sub">{{ o.nota }}</span> }
                  </li>
                }
              </ul>
            } @else {
              <p class="pd-vacio">Sin excepciones: su acceso sale entero de su perfil. Es lo deseable.</p>
            }
          </section>
        }
      }

      <!-- ── 3. QUÉ DATOS VE ───────────────────────────────────────────── -->
      @if (pestana() === 'datos') {
        @if (!persona) {
          <p class="pd-vacio">El alcance se configura una vez que la persona existe.</p>
        } @else if (alcance(); as al) {
          <section class="pd-blk">
            <p class="pd-hint">
              Qué filas ve en cada dimensión. <strong>Sin regla, no ve nada</strong> — el alcance
              es fail-closed a propósito.
            </p>
            <ul class="pd-lista">
              @for (d of dimensiones(); track d.code) {
                <li>
                  <span class="pd-dim">{{ d.code }}</span>
                  <p-tag [value]="d.mode" [severity]="d.mode === 'all' ? 'info' : 'secondary'"
                         styleClass="pd-tag"></p-tag>
                  <span class="pd-sub">{{ d.source }}</span>
                  @if (d.resolvable === false) {
                    <span class="pd-aviso">· no resoluble: su ficha no tiene el dato</span>
                  }
                </li>
              }
            </ul>
          </section>
        } @else {
          <p class="pd-vacio">Leyendo el alcance…</p>
        }
      }

      <!-- ── 4. DE QUÉ RESPONDE ────────────────────────────────────────── -->
      @if (pestana() === 'responde') {
        @if (!persona) {
          <p class="pd-vacio">Las responsabilidades se asignan una vez que la persona existe.</p>
        } @else if (responsabilidades(); as rs) {
          <section class="pd-blk">
            <h3>Heredadas del puesto</h3>
            @if (!rs.heredadas.length) {
              <p class="pd-vacio">Su puesto no responde de nada todavía.</p>
            } @else {
              <ul class="pd-lista">
                @for (h of rs.heredadas; track h.responsibility_key) {
                  <li>
                    <span>{{ h.label }}</span>
                    @if (h.es_principal) { <p-tag value="principal" severity="info" styleClass="pd-tag"></p-tag> }
                  </li>
                }
              </ul>
            }

            <h3>Propias de esta persona</h3>
            @if (!rs.propias.length) {
              <p class="pd-vacio">Sin excepciones.</p>
            } @else {
              <ul class="pd-lista">
                @for (p of rs.propias; track p.id) {
                  <li class="pd-propia">
                    <span>{{ p.label }}</span>
                    <p-tag [value]="p.accion" [severity]="p.accion === 'suma' ? 'success' : 'warn'"
                           styleClass="pd-tag"></p-tag>
                    @if (!p.vigente) { <p-tag value="vencida" severity="secondary" styleClass="pd-tag"></p-tag> }
                    <span class="pd-nota">{{ p.nota }}</span>
                    @if (puedeEscribir) {
                      <button pButton type="button" class="icon-btn-ghost-bad"
                              (click)="quitarResponsabilidad(p.id)" [attr.aria-label]="'Quitar ' + p.label">
                        <span class="pi pi-times" aria-hidden="true"></span>
                      </button>
                    }
                  </li>
                }
              </ul>
            }

            @if (puedeEscribir) {
              <div class="pd-asignar">
                <p-select [options]="respOpts()" [(ngModel)]="nuevaResp" optionLabel="label" optionValue="value"
                          appendTo="body" placeholder="Agregar una responsabilidad"></p-select>
                <textarea pTextarea [(ngModel)]="nuevaNota" rows="2" maxlength="500"
                          placeholder="Por qué se le asigna a ella y no a su puesto (obligatorio)"></textarea>
                <button pButton type="button" class="p-button-sm" severity="contrast"
                        [disabled]="!nuevaResp || !nuevaNota.trim()" (click)="agregarResponsabilidad()">
                  <span class="p-button-label">Asignar</span>
                </button>
                <p class="pd-hint">
                  Sin motivo no se guarda. Es lo que evita que esta tabla termine como
                  <code>user_roles</code>, donde 133 de 139 filas son un espejo que nadie sabe si es
                  una decisión o un descuido.
                </p>
              </div>
            }
          </section>
        } @else {
          <p class="pd-vacio">Leyendo responsabilidades…</p>
        }
      }

      <!-- ── 5. QUÉ PASÓ ───────────────────────────────────────────────── -->
      @if (pestana() === 'historia') {
        @if (!persona) {
          <p class="pd-vacio">Todavía no hay historia que contar.</p>
        } @else {
          <section class="pd-blk">
            <h3>Puestos que ocupó</h3>
            @if (!historia()?.tramos?.length) {
              <p class="pd-vacio">Sin tramos registrados.</p>
            } @else {
              <ul class="pd-lista">
                @for (t of historia()!.tramos; track t.desde) {
                  <li>
                    <span class="comm-code">{{ t.position_code ?? '—' }}</span>
                    <span class="pd-sub">
                      desde {{ t.desde | date: 'dd/MM/yy' }}
                      @if (t.hasta) { · hasta {{ t.hasta | date: 'dd/MM/yy' }} } @else { · vigente }
                    </span>
                    <p-tag [value]="origenLabel(t.desde_origen)"
                           [severity]="t.desde_origen === 'cambio' ? 'success' : 'secondary'"
                           styleClass="pd-tag"></p-tag>
                  </li>
                }
              </ul>
              <p class="pd-hint">
                <strong>Estimado</strong> y <strong>registro del sistema</strong> no son un cambio
                observado: son la fecha de alta de la cuenta. Se distinguen para no dar por medido
                lo que está estimado.
              </p>
            }

            <h3>Movimientos</h3>
            @if (!eventos().length) {
              <p class="pd-vacio">Sin eventos.</p>
            } @else {
              <ul class="pd-lista">
                @for (e of eventos(); track e.id) {
                  <li>
                    <span class="comm-code">{{ e.event }}</span>
                    <span class="pd-sub">{{ e.created_at | date: 'dd/MM/yy HH:mm' }}</span>
                    @if (e.actor_username) { <span class="pd-sub">· {{ e.actor_username }}</span> }
                  </li>
                }
              </ul>
            }
          </section>
        }
      }

      <footer class="pd-acc">
        <button pButton type="button" class="p-button-sm p-button-text" (click)="cancelado.emit()">
          <span class="p-button-label">Cerrar</span>
        </button>
        @if (puedeEscribir && pestana() === 'persona') {
          <button pButton type="button" class="p-button-sm" severity="contrast"
                  [disabled]="guardando() || !puedeGuardar()" (click)="guardar()">
            <span class="p-button-label">{{ persona ? 'Guardar cambios' : 'Dar de alta' }}</span>
          </button>
        }
      </footer>
    </div>
  `,
  styleUrls: ['./persona-detalle.component.css'],
})
export class PersonaDetalleComponent implements OnChanges {
  private api = inject(AdminService);
  private destroyRef = inject(DestroyRef);

  @Input() persona: PersonaFila | null = null;
  @Input() puedeEscribir = false;
  @Output() guardado = new EventEmitter<string>();
  @Output() cancelado = new EventEmitter<void>();

  readonly pestana = signal<Pestana>('persona');
  readonly propuesta = signal<PropuestaDePuesto | null>(null);
  readonly ajustar = signal(false);
  readonly guardando = signal(false);
  readonly errorGuardado = signal<string | null>(null);

  readonly permisos = signal<PermisosDePersona | null>(null);
  readonly alcance = signal<{ dimensions: Record<string, unknown> } | null>(null);
  readonly responsabilidades = signal<ResponsabilidadesDePersona | null>(null);
  readonly historia = signal<HistoriaDePuesto | null>(null);
  readonly eventos = signal<EventoDePersona[]>([]);
  readonly cargandoAcceso = signal(false);

  private readonly puestos = signal<OpcionCatalogo[]>([]);
  private readonly roles = signal<string[]>([]);
  private readonly catalogoResp = signal<Array<{ key: string; label: string }>>([]);

  nuevaResp: string | null = null;
  nuevaNota = '';

  f: {
    nombre: string;
    username: string;
    position_code: string | null;
    role_name: string | null;
    motivo_desvio: string;
  } = { nombre: '', username: '', position_code: null, role_name: null, motivo_desvio: '' };

  readonly pestanas = computed<SegOption[]>(() => [
    { label: 'Persona', value: 'persona' },
    { label: 'Acceso', value: 'acceso' },
    { label: 'Datos', value: 'datos' },
    { label: 'Responde de', value: 'responde' },
    { label: 'Historia', value: 'historia' },
  ]);

  readonly puestoOpts = computed(() =>
    this.puestos().map((p) => ({ label: p.name, value: p.code })),
  );

  readonly rolOpts = computed(() => this.roles().map((r) => ({ label: r, value: r })));

  readonly respOpts = computed(() =>
    this.catalogoResp().map((r) => ({ label: r.label, value: r.key })),
  );

  /**
   * Hay desvío cuando el perfil elegido no es el que el puesto propone. Se
   * evalúa sobre el CAMBIO: en una edición donde nadie tocó ni el rol ni el
   * puesto no se exige motivo por algo que ya estaba así.
   */
  readonly hayDesvio = computed(() => {
    const p = this.propuesta();
    if (!p || p.sin_perfil) return false;
    if (!this.f.role_name) return false;
    if (this.f.role_name === p.role_name) return false;
    if (!this.persona) return true;
    return this.f.role_name !== this.persona.role_name || this.f.position_code !== this.persona.position_code;
  });

  readonly puedeGuardar = computed(() => {
    if (!this.f.username.trim()) return false;
    if (!this.f.position_code) return false;
    if (!this.f.role_name) return false;
    if (this.hayDesvio() && !this.f.motivo_desvio.trim()) return false;
    return true;
  });

  readonly dimensiones = computed(() => {
    const d = this.alcance()?.dimensions ?? {};
    return Object.entries(d).map(([code, v]) => ({
      code,
      ...(v as { mode: string; source: string; resolvable?: boolean }),
    }));
  });

  ngOnChanges(): void {
    this.pestana.set('persona');
    this.errorGuardado.set(null);
    this.ajustar.set(false);
    this.propuesta.set(null);
    this.permisos.set(null);
    this.alcance.set(null);
    this.responsabilidades.set(null);
    this.historia.set(null);
    this.eventos.set([]);

    this.f = {
      nombre: this.persona?.nombre ?? '',
      username: this.persona?.username ?? '',
      position_code: this.persona?.position_code ?? null,
      role_name: this.persona?.role_name ?? null,
      motivo_desvio: '',
    };

    if (!this.puestos().length) {
      this.api.puestosSimples().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (p) => this.puestos.set(p),
        error: () => this.puestos.set([]),
      });
    }
    if (!this.catalogoResp().length) {
      this.api.responsabilidades().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => this.catalogoResp.set(r.map((x) => ({ key: x.key, label: x.label }))),
        error: () => this.catalogoResp.set([]),
      });
    }
    if (!this.roles().length) {
      this.api.roles().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => this.roles.set(r.map((x) => x.role_name)),
        error: () => this.roles.set([]),
      });
    }

    if (this.f.position_code) this.cargarPropuesta();
    if (this.persona) this.cargarLoDeLaPersona(this.persona.id);
  }

  private cargarLoDeLaPersona(id: string): void {
    this.cargandoAcceso.set(true);
    this.api.permisosDe(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.permisos.set(p);
        this.cargandoAcceso.set(false);
      },
      error: () => this.cargandoAcceso.set(false),
    });
    this.api.alcanceDe(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => this.alcance.set(a),
      error: () => this.alcance.set(null),
    });
    this.api.responsabilidadesDePersona(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.responsabilidades.set(r),
      error: () => this.responsabilidades.set(null),
    });
    this.api.historiaDePuesto(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => this.historia.set(h),
      error: () => this.historia.set(null),
    });
    this.api.eventosDe(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (e) => this.eventos.set(e),
      error: () => this.eventos.set([]),
    });
  }

  /** ⭐ El endpoint que la pantalla vieja nunca llamó. */
  cargarPropuesta(): void {
    const code = this.f.position_code;
    if (!code) {
      this.propuesta.set(null);
      return;
    }
    this.api.propuesta(code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.propuesta.set(p);
        // En el alta se precarga; en una edición no se pisa lo que ya tiene.
        if (!this.persona && !this.f.role_name && p.role_name) this.f.role_name = p.role_name;
      },
      error: () => this.propuesta.set(null),
    });
  }

  aceptarPropuesta(): void {
    const p = this.propuesta();
    if (!p?.role_name) return;
    this.f.role_name = p.role_name;
    this.f.motivo_desvio = '';
    this.ajustar.set(false);
  }

  irA(p: Pestana): void {
    this.pestana.set(p);
  }

  guardar(): void {
    if (!this.puedeGuardar() || this.guardando()) return;
    this.guardando.set(true);
    this.errorGuardado.set(null);

    const body: Record<string, unknown> = {
      nombre: this.f.nombre.trim() || null,
      position_code: this.f.position_code,
      role_name: this.f.role_name,
    };
    if (this.hayDesvio()) body['motivo_desvio'] = this.f.motivo_desvio.trim();

    const obs = this.persona
      ? this.api.editarPersona(this.persona.id, body)
      : this.api.crearPersona({ ...body, username: this.f.username.trim() });

    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardando.set(false);
        this.guardado.emit(this.persona ? 'Ficha actualizada.' : 'Persona dada de alta.');
      },
      // ⛔ El editor NO se cierra: lo tecleado sigue ahí y el error se lee al lado
      // del campo que lo causó.
      error: (e) => {
        this.guardando.set(false);
        this.errorGuardado.set(this.mensajeDe(e));
      },
    });
  }

  agregarResponsabilidad(): void {
    if (!this.persona || !this.nuevaResp || !this.nuevaNota.trim()) return;
    this.api
      .asignarAPersona(this.persona.id, {
        responsibility_key: this.nuevaResp,
        accion: 'suma',
        nota: this.nuevaNota.trim(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.responsabilidades.set(r);
          this.nuevaResp = null;
          this.nuevaNota = '';
        },
        error: (e) => this.errorGuardado.set(this.mensajeDe(e)),
      });
  }

  quitarResponsabilidad(rowId: string): void {
    if (!this.persona) return;
    this.api
      .quitarDePersona(this.persona.id, rowId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.responsabilidades.set(r),
        error: (e) => this.errorGuardado.set(this.mensajeDe(e)),
      });
  }

  private mensajeDe(e: unknown): string {
    const err = e as { error?: { message?: string | string[] } };
    const m = err?.error?.message;
    if (Array.isArray(m)) return m.join(' · ');
    return m ?? 'No se pudo guardar. Nada cambió.';
  }

  cuantosConceden(p: PermisosDePersona): number {
    return p.overrides.filter((o) => o.allow).length;
  }

  cuantosQuitan(p: PermisosDePersona): number {
    return p.overrides.filter((o) => !o.allow).length;
  }

  nombresDe(ocupantes: Array<{ nombre: string | null; username: string }>): string {
    return ocupantes.map((o) => o.nombre || o.username).join(', ');
  }

  origenLabel(o: string): string {
    if (o === 'cambio') return 'cambio observado';
    if (o === 'registro_sistema') return 'alta de la cuenta';
    return 'estimado';
  }

  ejeExplica(eje: string | null): string {
    switch (eje) {
      case 'ruta': return 'se le pregunta su ruta';
      case 'sucursal': return 'se le pregunta su tienda';
      case 'zona': return 'se le pregunta la plaza que cubre';
      case 'red': return 'no se le pregunta lugar: es de oficina';
      case 'cartera': return 'su cartera de clientes';
      case 'cliente': return 'es una cuenta externa';
      default: return 'sin eje declarado';
    }
  }
}
