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
import { ConfirmationService } from 'primeng/api';
import type {
  HistoriaDePuesto,
  PersonaFila,
  PropuestaDePuesto,
  ResponsabilidadesDePersona,
} from '@megadulces/contracts';

import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
// ⚠️ Vive todavía en el módulo viejo; se muda con él cuando `[AU.7]` lo retire.
import {
  SESSION_PRESETS,
  generateDevicePassword,
} from '../../dashboard/admin-users/device-session';
import { AdminService, EventoDePersona, OpcionCatalogo, PermisosDePersona } from '../admin.service';

/**
 * `[AU.2]` — La ficha de una persona, por las cinco preguntas que se le hacen:
 * **quién es · qué abre · qué datos ve · de qué responde · qué pasó**.
 *
 * Los cinco bloques casi nunca se miran juntos: quien da de alta mira el puesto,
 * quien audita mira la historia, quien arregla un acceso mira las excepciones.
 *
 * ⛔ Nada se persiste después de cerrar el drawer: si el guardado falla, el editor
 * sigue abierto con lo tecleado.
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
          <input pInputText id="pd-nombre" [ngModel]="fNombre()" (ngModelChange)="fNombre.set($event)"
                 [disabled]="!puedeEscribir" placeholder="Nombre completo" />

          <label class="pd-lbl" for="pd-user">Usuario</label>
          <input pInputText id="pd-user" [ngModel]="fUsername()" (ngModelChange)="fUsername.set($event)"
                 [disabled]="!puedeEscribir || !!persona"
                 placeholder="nombre_apellido" class="mono" />
          @if (persona) {
            <p class="pd-hint">El usuario no se renombra: lo referencian la bitácora y las sesiones abiertas.</p>
          }

          @if (!persona) {
            <label class="pd-lbl pd-lbl-req" for="pd-pass">Contraseña</label>
            <div class="pd-pass">
              <input pInputText id="pd-pass" [type]="verPass() ? 'text' : 'password'"
                     [ngModel]="fPassword()" (ngModelChange)="fPassword.set($event)"
                     [disabled]="!puedeEscribir" class="mono" autocomplete="new-password"
                     placeholder="Mínimo 6 caracteres" />
              <button pButton type="button" class="icon-btn-ghost" (click)="verPass.set(!verPass())"
                      [attr.aria-label]="verPass() ? 'Ocultar la contraseña' : 'Ver la contraseña'">
                <span class="pi" [class.pi-eye]="!verPass()" [class.pi-eye-slash]="verPass()"
                      aria-hidden="true"></span>
              </button>
              <button pButton type="button" class="p-button-sm p-button-text" (click)="generarPass()"
                      [disabled]="!puedeEscribir">
                <span class="p-button-label">Generar</span>
              </button>
            </div>
            <p class="pd-hint">
              Se genera en tu navegador y sólo viaja en el alta, ya hasheada del otro lado.
              Sin caracteres que se confundan: no hay <code>0/O</code> ni <code>1/l/I</code>.
            </p>
          }

          <label class="pd-lbl" for="pd-puesto">Puesto</label>
          <p-select inputId="pd-puesto" [options]="puestoOpts()" [ngModel]="fPuesto()"
                    (ngModelChange)="fPuesto.set($event)"
                    (onChange)="cargarPropuesta()" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="¿Qué puesto ocupa?"></p-select>

          <label class="pd-lbl pd-lbl-req" for="pd-depto">Departamento</label>
          <p-select inputId="pd-depto" [options]="deptoOpts()" [ngModel]="fDepto()"
                    (ngModelChange)="fDepto.set($event)" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="¿De qué área depende?"></p-select>

          <label class="pd-lbl" for="pd-jefe">Jefe directo</label>
          <p-select inputId="pd-jefe" [options]="jefeOpts()" [ngModel]="fJefe()"
                    (ngModelChange)="fJefe.set($event)" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="Sin jefe directo"></p-select>
          <p class="pd-hint">
            Si se deja vacío, el escalamiento usa el jefe que propone el puesto. Declararlo acá
            sirve cuando el organigrama por zona no alcanza para desempatar.
          </p>
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

        @if (ajustar() || !propuesta() || sinPropuesta()) {
          <section class="pd-blk">
            <label class="pd-lbl" for="pd-rol">Perfil de acceso</label>
            <p-select inputId="pd-rol" [options]="rolOpts()" [ngModel]="fRol()"
                      (ngModelChange)="fRol.set($event)" optionLabel="label"
                      optionValue="value" [filter]="true" filterBy="label" appendTo="body"
                      [disabled]="!puedeEscribir" placeholder="Elegí el perfil"></p-select>

            @if (hayDesvio()) {
              <label class="pd-lbl pd-lbl-req" for="pd-motivo">
                {{ sinPropuesta() ? 'Motivo de este perfil' : 'Motivo de apartarse del puesto' }}
              </label>
              <textarea pTextarea id="pd-motivo" [ngModel]="fMotivo()" (ngModelChange)="fMotivo.set($event)"
                        rows="2" maxlength="300" [disabled]="!puedeEscribir"
                        [placeholder]="sinPropuesta()
                          ? 'Por qué este perfil, si el puesto no propone ninguno'
                          : 'Por qué este perfil y no el que propone el puesto'"></textarea>
              @if (sinPropuesta()) {
                <p class="pd-hint">
                  Este puesto <strong>no propone ningún perfil</strong>, así que
                  <strong>{{ fRol() }}</strong> es una elección a dedo y no hay contra qué
                  contrastarla. El motivo queda en la bitácora. Lo que lo cierra de raíz es
                  <a class="pd-link" routerLink="/admin/puestos">darle un perfil al puesto</a>.
                </p>
              } @else {
                <p class="pd-hint">
                  El puesto propone <strong>{{ propuesta()?.role_name }}</strong> y elegiste
                  <strong>{{ fRol() }}</strong>. El motivo queda en la bitácora.
                </p>
              }
            }
          </section>
        }
      }

      <!-- ── 2. QUÉ ABRE ────────────────────────────────────────────────── -->
      @if (pestana() === 'acceso') {
        <section class="pd-blk">
          <label class="pd-lbl" for="pd-ttl">Duración de la sesión</label>
          <p-select inputId="pd-ttl" [options]="sesionOpts" [ngModel]="fTtl()"
                    (ngModelChange)="fTtl.set($event)" optionLabel="label" optionValue="value"
                    appendTo="body" [disabled]="!puedeEscribir"></p-select>
          <p class="pd-hint">
            Una sesión larga es para un <strong>kiosco o una tableta</strong> que nadie vuelve a
            desbloquear, no para una persona. Un permiso de un año que no se puede ver desde acá
            tampoco se puede revisar ni quitar.
          </p>
        </section>

        @if (!persona) {
          <p class="pd-vacio">Los permisos se revisan una vez que la persona existe. Guardá primero.</p>
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
        <section class="pd-blk">
          <h3>Dónde opera</h3>
          <p class="pd-hint">
            El eje del puesto dice cuál de estos tres se le pregunta. Si queda vacío el que le
            corresponde, <strong>no va a ver ninguna fila</strong>: el alcance es fail-closed.
            @if (propuesta()?.scope_axis; as eje) {
              Su puesto se resuelve por <strong>{{ eje }}</strong> — {{ ejeExplica(eje) }}.
            }
          </p>

          <label class="pd-lbl" for="pd-suc">Sucursal</label>
          <p-select inputId="pd-suc" [options]="sucursalOpts()" [ngModel]="fSucursal()"
                    (ngModelChange)="fSucursal.set($event)" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="Ninguna"></p-select>

          <label class="pd-lbl" for="pd-ruta">Ruta</label>
          <p-select inputId="pd-ruta" [options]="rutaOpts()" [ngModel]="fRuta()"
                    (ngModelChange)="fRuta.set($event)" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="Ninguna"></p-select>

          <label class="pd-lbl" for="pd-zona">Zona</label>
          <p-select inputId="pd-zona" [options]="zonaOpts()" [ngModel]="fZona()"
                    (ngModelChange)="fZona.set($event)" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" appendTo="body" [disabled]="!puedeEscribir"
                    placeholder="Ninguna"></p-select>
        </section>

        @if (!persona) {
          <p class="pd-vacio">
            Las reglas de alcance por dimensión se ven cuando la persona existe. Lo de arriba sí se
            guarda con el alta.
          </p>
        } @else if (alcance(); as al) {
          <section class="pd-blk">
            <h3>Qué filas ve</h3>
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
                              (click)="quitarResponsabilidad(p.id, p.label)"
                              [attr.aria-label]="'Quitar ' + p.label">
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
  /** Lo provee la página: el diálogo vive en su plantilla, no en el drawer. */
  private confirm = inject(ConfirmationService);
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
  private readonly departamentos = signal<OpcionCatalogo[]>([]);
  private readonly jefes = signal<Array<{ id: string; nombre: string | null; username: string }>>([]);
  private readonly branches = signal<Array<{ code: string; name: string }>>([]);
  private readonly routes = signal<Array<{ id: string; name: string }>>([]);
  private readonly zones = signal<Array<{ id: string; value: string }>>([]);

  nuevaResp: string | null = null;
  nuevaNota = '';

  /*
   * Signals y no un objeto plano: `hayDesvio()` y `puedeGuardar()` los leen
   * desde un `computed`, y un `computed` sólo recalcula cuando cambia un signal
   * que leyó. Con props planas dependían sólo de `propuesta`, así que
   * `hayDesvio()` quedaba congelado en `false` al cambiar el perfil: el textarea
   * del motivo NO aparecía nunca y el backend sí lo exige — 400 sin campo donde
   * escribirlo.
   */
  readonly fNombre = signal('');
  readonly fUsername = signal('');
  readonly fPassword = signal('');
  readonly fPuesto = signal<string | null>(null);
  readonly fDepto = signal<string | null>(null);
  readonly fJefe = signal<string | null>(null);
  readonly fRol = signal<string | null>(null);
  readonly fMotivo = signal('');
  readonly fSucursal = signal<string | null>(null);
  readonly fRuta = signal<string | null>(null);
  readonly fZona = signal<string | null>(null);
  readonly fTtl = signal<number | null>(null);
  readonly verPass = signal(false);

  /** Copia mutable: `p-select` no acepta un `ReadonlyArray` en `[options]`. */
  readonly sesionOpts = [...SESSION_PRESETS];

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

  readonly deptoOpts = computed(() =>
    this.departamentos().map((d) => ({ label: d.name, value: d.code })),
  );

  readonly jefeOpts = computed(() => [
    { label: 'Sin jefe directo', value: null as string | null },
    ...this.jefes()
      .filter((j) => j.id !== this.persona?.id)
      .map((j) => ({ label: j.nombre || j.username, value: j.id as string | null })),
  ]);

  readonly sucursalOpts = computed(() => [
    { label: 'Ninguna', value: null as string | null },
    ...this.branches().map((b) => ({ label: b.name, value: b.code as string | null })),
  ]);

  readonly rutaOpts = computed(() => [
    { label: 'Ninguna', value: null as string | null },
    ...this.routes().map((r) => ({ label: r.name, value: r.id as string | null })),
  ]);

  readonly zonaOpts = computed(() => [
    { label: 'Ninguna', value: null as string | null },
    ...this.zones().map((z) => ({ label: z.value, value: z.id as string | null })),
  ]);

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
    const rol = this.fRol();
    const puesto = this.fPuesto();
    if (!p || !rol) return false;
    const cambia = !this.persona
      ? true
      : rol !== this.persona.role_name || puesto !== this.persona.position_code;
    // `[AU.15]` Un puesto que no propone nada tampoco da contra qué contrastar:
    // el perfil se elige a dedo y el motivo es lo único que deja rastro. El
    // backend lo exige igual.
    if (p.sin_perfil) return cambia;
    if (rol === p.role_name) return false;
    return cambia;
  });

  /** El desvío existe porque el puesto no propone nada, no porque difiera. */
  readonly sinPropuesta = computed(() => !!this.propuesta()?.sin_perfil);

  readonly puedeGuardar = computed(() => {
    // Los signals se leen SIEMPRE primero e incondicionales: un `&&` que corta
    // antes de leer uno deja el computed sin esa dependencia.
    const usuario = this.fUsername().trim();
    const puesto = this.fPuesto();
    const depto = this.fDepto();
    const rol = this.fRol();
    const pass = this.fPassword();
    const motivo = this.fMotivo().trim();
    const desvio = this.hayDesvio();
    if (!usuario || !puesto || !rol) return false;
    // `department_code` y `password` los exige el DTO del alta: sin ellos el POST
    // vuelve 400 antes de tocar el servicio.
    if (!depto) return false;
    if (!this.persona && pass.trim().length < 6) return false;
    if (desvio && !motivo) return false;
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

    this.fNombre.set(this.persona?.nombre ?? '');
    this.fUsername.set(this.persona?.username ?? '');
    this.fPassword.set('');
    this.verPass.set(false);
    this.fPuesto.set(this.persona?.position_code ?? null);
    this.fDepto.set(this.persona?.department_code ?? null);
    this.fJefe.set(this.persona?.supervisor_id ?? null);
    this.fRol.set(this.persona?.role_name ?? null);
    this.fMotivo.set('');
    this.fSucursal.set(this.persona?.warehouse_code ?? null);
    this.fRuta.set(this.persona?.route_id ?? null);
    this.fZona.set(this.persona?.zona_id ?? null);
    this.fTtl.set(this.persona?.token_ttl_days ?? null);

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
    if (!this.departamentos().length) {
      this.api.departamentos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => this.departamentos.set(d),
        error: () => this.departamentos.set([]),
      });
    }
    if (!this.jefes().length) {
      this.api.supervisores().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (j) => this.jefes.set(j),
        error: () => this.jefes.set([]),
      });
    }
    if (!this.branches().length) {
      this.api.sucursales().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (b) => this.branches.set(b),
        error: () => this.branches.set([]),
      });
    }
    if (!this.routes().length) {
      this.api.rutas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => this.routes.set(r),
        error: () => this.routes.set([]),
      });
    }
    if (!this.zones().length) {
      this.api.zonas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (z) => this.zones.set(z),
        error: () => this.zones.set([]),
      });
    }

    if (this.fPuesto()) this.cargarPropuesta();
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

  /** Lo que el puesto propone: rol, complementos, jefe y responsabilidades. */
  cargarPropuesta(): void {
    const code = this.fPuesto();
    if (!code) {
      this.propuesta.set(null);
      return;
    }
    this.api.propuesta(code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.propuesta.set(p);
        // En el alta se precarga; en una edición no se pisa lo que ya tiene.
        if (!this.persona && !this.fRol() && p.role_name) this.fRol.set(p.role_name);
      },
      error: () => this.propuesta.set(null),
    });
  }

  aceptarPropuesta(): void {
    const p = this.propuesta();
    if (!p?.role_name) return;
    this.fRol.set(p.role_name);
    this.fMotivo.set('');
    this.ajustar.set(false);
  }

  irA(p: Pestana): void {
    this.pestana.set(p);
  }

  generarPass(): void {
    this.fPassword.set(generateDevicePassword());
    this.verPass.set(true);
  }

  guardar(): void {
    if (!this.puedeGuardar() || this.guardando()) return;
    this.guardando.set(true);
    this.errorGuardado.set(null);

    const ttl = this.fTtl();
    const body: Record<string, unknown> = {
      nombre: this.fNombre().trim() || null,
      position_code: this.fPuesto(),
      department_code: this.fDepto(),
      role_name: this.fRol(),
      supervisor_id: this.fJefe(),
      warehouse_code: this.fSucursal(),
      route_id: this.fRuta(),
      zone_id: this.fZona(),
      token_ttl_days: ttl,
    };
    if (this.hayDesvio()) body['motivo_desvio'] = this.fMotivo().trim();

    const obs = this.persona
      ? this.api.editarPersona(this.persona.id, body)
      : this.api.crearPersona({
          ...body,
          username: this.fUsername().trim(),
          password: this.fPassword(),
          // Una cuenta de kiosco es compartida y nadie la desbloquea: exigirle
          // cambio de contraseña al primer login la deja inservible.
          must_change_password: ttl == null,
        });

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

  quitarResponsabilidad(rowId: string, label: string): void {
    const persona = this.persona;
    if (!persona) return;
    this.confirm.confirm({
      header: 'Quitar la excepción',
      message: `«${label}» deja de ser responsabilidad propia de ${persona.nombre || persona.username}. Lo que herede de su puesto no cambia.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, quitar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger p-button-sm',
      rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => {
        this.api
          .quitarDePersona(persona.id, rowId)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (r) => this.responsabilidades.set(r),
            error: (e) => this.errorGuardado.set(this.mensajeDe(e)),
          });
      },
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
