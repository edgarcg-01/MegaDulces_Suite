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
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';

import { AdminService, PermisosDePersona } from '../admin.service';
import { PerfilDelCatalogo } from '@megadulces/contracts';
import {
  PERMISSION_META,
  TOTAL_PERMISSIONS,
} from '../../../core/constants/permission-meta';
import {
  AUTHZ_TREE,
  CambioDePantalla,
  OverrideDePermiso,
  overridesContra,
  pantallasAfectadas,
  ubicacionDeClave,
  valoresDesdeBase,
} from '../../../core/constants/authz-tree';
import { PermissionsService } from '../../../core/services/permissions.service';
import { PermissionTreeComponent } from '../../../shared/components/permission-tree/permission-tree.component';
import {
  PermissionPreviewComponent,
  UsoDePermisos,
} from '../../../shared/components/permission-tree/permission-preview.component';

/**
 * `[AU.10]` / `[AU.14]` — Qué abre una persona: su perfil base, sus complementos y sus
 * diferencias contra el perfil.
 *
 * ⛔ Esto NO es un segundo editor de perfiles. El perfil concede; acá se declaran las
 * **diferencias** contra él, y el lote lleva motivo escrito.
 *
 * ── `[AU.14]` Por qué cambió la forma ───────────────────────────────────────
 * Antes se escribían las excepciones DE A UNA: elegir la clave en un desplegable de 223, elegir
 * el signo, y escribirle un motivo a cada una. Medido en prod el 2026-10-03: `ernesto_zarate`
 * tiene **28 excepciones, 27 de ellas «quita», y las 28 sin motivo** — y esas 27 son dos
 * proyectos enteros, o sea 27 renglones escritos a mano para expresar dos decisiones.
 *
 * Ahora se marca el estado FINAL sobre el árbol y la diferencia se deriva sola. El motivo pasa a
 * ser **uno por lote**: no es aflojar la auditoría, es hacerla cumplible. La regla vieja se
 * evadía en 2 de cada 3 casos (32 de 48 excepciones vivas sin nota) — cobraba fricción sin
 * comprar nada.
 *
 * ⚠️ Un montón de diferencias sobre una persona no es una excepción: es que el perfil no le
 * queda. La pantalla lo sigue diciendo y sigue mandando a arreglar el perfil.
 */

interface Excepcion {
  permission_key: string;
  allow: boolean;
  nota: string | null;
}

type Modo = 'editor' | 'revision';

/** El universo contra el que se compara. El catálogo cubre las 223 del enum (medido). */
const TODAS_LAS_CLAVES = Object.keys(PERMISSION_META);

@Component({
  selector: 'app-persona-acceso',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, TagModule, SelectModule,
    MultiSelectModule, InputTextModule, PermissionTreeComponent, PermissionPreviewComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cargando()) {
      <p class="pd-vacio">Leyendo el acceso…</p>
    } @else {
      @if (error()) {
        <div class="pd-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ error() }}</span>
        </div>
      }

      <section class="pd-blk">
        <dl class="pd-dl">
          <dt>Perfil base</dt>
          <dd><span class="comm-code">{{ perfilBase() || '—' }}</span></dd>
          <dt>Permisos que abre</dt>
          <dd class="comm-num">{{ permisos()?.efectivos?.length ?? 0 }}</dd>
        </dl>
        @if (permisos()?.platform_admin) {
          <p class="pd-hint">
            Este perfil tiene acceso total por rol, así que las excepciones por persona
            <strong>no le aplican</strong>. Para limitarla hay que cambiarle el perfil base.
          </p>
        }
      </section>

      <section class="pd-blk">
        <h3>Complementos</h3>
        <p class="pd-hint">
          Perfiles que se SUMAN al base. El acceso es la unión de los dos, así que quitar el
          complemento es lo único que quita lo que el complemento daba.
        </p>
        <!-- [AU.13] Agrupado y con lo que hace falta para ELEGIR. Antes era una lista plana de
             codigos (finanzas_operativo, almacenista...): sin saber que abre cada uno, quien lo
             usa, ni de que parte de la organizacion es. El grupo sale de los PUESTOS que lo
             declaran (identity.positions), no de un mapa escrito a mano.
             PrimeNG 22: la plantilla del item se declara con #item, NO con pTemplate -- con el
             nombre viejo no se proyecta nada y la lista se ve igual que antes (GOTCHAS 59).
             SIN acentos graves aca adentro: esto vive en un template literal. -->
        <p-multiselect [options]="rolOpts()" [ngModel]="complementos()"
                       (ngModelChange)="complementos.set($event)" optionLabel="label"
                       optionValue="value" [group]="true" optionGroupLabel="label"
                       optionGroupChildren="items"
                       appendTo="body" [filter]="true" filterBy="label,code" display="chip"
                       filterPlaceholder="Buscar perfil o codigo..."
                       [disabled]="!puedeEscribir || !!permisos()?.platform_admin"
                       placeholder="Ninguno" ariaLabel="Complementos de perfil">
          <ng-template #item let-opt>
            <span class="pa-rol">
              <span class="pa-rol-nom">
                {{ opt.label }}
                @if (opt.propuesto) {
                  <em class="pa-rol-tag"><i class="pi pi-check" aria-hidden="true"></i> lo propone su puesto</em>
                }
              </span>
              <span class="pa-rol-meta">
                <code class="comm-code">{{ opt.code }}</code>
                <span class="pa-rol-n">{{ opt.permisos }}</span> permisos@if (opt.personas !== null) {
                  · <span class="pa-rol-n">{{ opt.personas }}</span> {{ opt.personas === 1 ? 'persona' : 'personas' }}
                }
              </span>
            </span>
          </ng-template>
        </p-multiselect>
        @if (!agrupacionMedida()) {
          <p class="pd-hint">
            No se pudo leer de que departamento es cada perfil, asi que van todos juntos. Es una
            falla de lectura, no que los perfiles no tengan departamento.
          </p>
        }
        @if (complementosCambiaron()) {
          <div class="pa-acc">
            <button pButton type="button" class="p-button-sm p-button-text" (click)="resetComplementos()">
              <span class="p-button-label">Deshacer</span>
            </button>
            <button pButton type="button" class="p-button-sm" severity="contrast"
                    [disabled]="guardandoRoles()" (click)="guardarComplementos()">
              <span class="p-button-label">Guardar complementos</span>
            </button>
          </div>
        }
      </section>

      <section class="pd-blk">
        <h3>Qué abre esta persona</h3>

        @if (demasiadas()) {
          <div class="pd-aviso-blk" role="status">
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
            <div>
              <strong>{{ excepcionesOriginal().length }} diferencias</strong> contra un mismo perfil
              no son excepciones: son que el perfil no le queda.
              Lo que corrige el problema de raíz es arreglar el perfil, no acumular parches acá.
              <a class="pd-link" routerLink="/admin/roles">Ir a Roles y permisos →</a>
            </div>
          </div>
        }

        @if (permisos()?.platform_admin) {
          <p class="pd-vacio">
            Su perfil abre todo por rol: marcar o desmarcar acá no cambiaría nada.
          </p>
        } @else if (modo() === 'revision') {
          <!-- Paso de revision: la diferencia dicha en PANTALLAS, que es lo que se puede leer.
               27 claves no se revisan; 18 pantallas con nombre y ruta si. -->
          <div class="pa-rev">
            <div class="pa-rev-kpis">
              <div>
                <span class="pa-rev-lab">Pantallas que se cierran</span>
                <strong class="pa-rev-num pa-rev-bad">{{ pantallasQueCierran().length }}</strong>
              </div>
              <div>
                <span class="pa-rev-lab">Pantallas que se abren</span>
                <strong class="pa-rev-num pa-rev-ok">{{ pantallasQueAbren().length }}</strong>
              </div>
              <div>
                <span class="pa-rev-lab">Permisos afectados</span>
                <strong class="pa-rev-num">{{ pendientes().length }}</strong>
                <span class="pa-rev-sub">{{ cuantosDeLectura() }} de lectura · {{ cuantosDeGestion() }} de gestión</span>
              </div>
              <div>
                <span class="pa-rev-lab">Queda con</span>
                <strong class="pa-rev-num">{{ efectivosTrasGuardar() }}</strong>
                <span class="pa-rev-sub">de los {{ permisos()?.del_puesto?.length ?? 0 }} de su perfil</span>
              </div>
            </div>

            @if (sinModulo().length) {
              <div class="pd-aviso-blk" role="status">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <div>
                  <strong>{{ sinModulo().length }} permisos no viven en ninguna pantalla del árbol</strong>
                  y por eso no aparecen abajo: {{ sinModulo().join(', ') }}. Se guardan igual; se
                  declara para que nadie lea la lista como completa.
                </div>
              </div>
            }

            <ul class="pa-rev-lista">
              @for (g of pantallasPorProyecto(); track g.projectId) {
                <li>
                  <div class="pa-rev-proy">
                    <span>{{ g.projectLabel }}</span>
                    <span class="pa-rev-n">{{ g.items.length }} pantallas</span>
                  </div>
                  <ul>
                    @for (p of g.items; track p.moduleId) {
                      <li class="pa-rev-fila">
                        <i class="pi" [class.pi-minus]="p.quita.length && !p.concede.length"
                           [class.pi-plus]="p.concede.length && !p.quita.length"
                           [class.pi-sort-alt]="p.quita.length && p.concede.length"
                           [class.pa-rev-bad]="p.quita.length && !p.concede.length"
                           [class.pa-rev-ok]="p.concede.length && !p.quita.length"
                           aria-hidden="true"></i>
                        <span class="pa-rev-nom">
                          <span>{{ p.label }}</span>
                          @if (p.route) {
                            <code class="comm-code">{{ p.route }}</code>
                          } @else {
                            <em class="pd-hint">no es una pantalla</em>
                          }
                        </span>
                        @if (p.tocaGestion) {
                          <p-tag value="incluye gestión" severity="warn" styleClass="pd-tag"></p-tag>
                        }
                      </li>
                    }
                  </ul>
                </li>
              }
            </ul>

            @if (noPodesOtorgar().length) {
              <div class="pd-aviso-blk" role="alert">
                <i class="pi pi-ban" aria-hidden="true"></i>
                <div>
                  No podés otorgar {{ noPodesOtorgar().length }} de estos permisos porque vos no los
                  tenés: <strong>{{ etiquetasDe(noPodesOtorgar()) }}</strong>. El guardado se va a
                  rechazar hasta que los quites del lote o te los den a vos.
                </div>
              </div>
            }

            <label class="pa-motivo-lab" for="motivo-lote">Motivo del cambio</label>
            <input pInputText id="motivo-lote" [ngModel]="motivo()"
                   (ngModelChange)="motivo.set($event)" class="pa-motivo"
                   placeholder="Por ejemplo: sale del área de Finanzas y Contabilidad." />
            <p class="pd-hint">
              Uno para todo el lote. Queda asentado junto con las {{ pendientes().length }} claves.
            </p>

            <div class="pa-acc">
              <button pButton type="button" class="p-button-sm p-button-text" (click)="modo.set('editor')">
                <span class="p-button-label">Volver al árbol</span>
              </button>
              <button pButton type="button" class="p-button-sm" severity="contrast"
                      [disabled]="guardandoPerms() || !motivo().trim()" (click)="guardar()">
                <span class="p-button-label">Guardar los {{ pendientes().length }} cambios</span>
              </button>
            </div>
            @if (!motivo().trim()) {
              <p class="pd-hint">
                Falta el motivo. Sin él, dentro de seis meses nadie va a saber si fue una decisión
                o un descuido.
              </p>
            }
          </div>
        } @else {
          <div class="pa-barra">
            <input pInputText [ngModel]="filtro()" (ngModelChange)="filtro.set($event)"
                   class="pa-buscar" placeholder="Buscar por pantalla, módulo o ruta…"
                   aria-label="Buscar módulo" />
            <button type="button" class="pa-chip" [class.pa-chip-on]="soloBase()"
                    [attr.aria-pressed]="soloBase()" (click)="soloBase.set(true)">
              Sólo lo que abre su perfil
            </button>
            <button type="button" class="pa-chip" [class.pa-chip-on]="!soloBase()"
                    [attr.aria-pressed]="!soloBase()" (click)="soloBase.set(false)">
              Todo el catálogo ({{ totalPermisos }})
            </button>
          </div>

          <div class="pa-split">
            <div class="pa-split-arbol">
              <app-permission-tree
                [valores]="valores()" (valoresChange)="valores.set($event)"
                [base]="baseSet()" [puedeOtorgar]="puedeOtorgarFn"
                [soloBase]="soloBase()" [filtro]="filtro()"
                [seleccion]="seleccion()" (seleccionChange)="seleccion.set($event)" />
            </div>
            <aside class="pa-split-previa">
              <app-permission-preview
                [seleccion]="seleccion()" [valores]="valores()"
                [uso]="uso()" [admins]="admins()" [misPermisos]="puedeOtorgarFn" />
            </aside>
          </div>

          @if (excepcionesOriginal().length) {
            <details class="pa-viejas">
              <summary>
                Diferencias ya guardadas ({{ excepcionesOriginal().length }}) y su motivo
              </summary>
              <ul class="pd-lista">
                @for (e of excepcionesOriginal(); track e.permission_key) {
                  <li class="pa-exc">
                    <span class="pa-perm">
                      <span class="pa-perm-label">{{ etiqueta(e.permission_key) }}</span>
                      <span class="pa-perm-key">{{ e.permission_key }}</span>
                    </span>
                    <p-tag [value]="e.allow ? 'concede' : 'quita'"
                           [severity]="e.allow ? 'success' : 'danger'" styleClass="pd-tag"></p-tag>
                    <span class="pa-nota-vieja">
                      @if (e.nota && e.nota.trim()) { {{ e.nota }} }
                      @else { <em>sin motivo escrito</em> }
                    </span>
                  </li>
                }
              </ul>
            </details>
          }

          @if (puedeEscribir) {
            <div class="pa-pie">
              <span class="pa-pie-dif">
                @if (pendientes().length) {
                  <span class="pa-dif-ok">+{{ cuantasConcede() }}</span>
                  <span class="pa-dif-bad">−{{ cuantasQuita() }}</span>
                  sobre <strong>{{ pantallas().length }}</strong> pantallas
                } @else {
                  Sin diferencias contra su perfil. Es lo deseable.
                }
              </span>
              <button pButton type="button" class="p-button-sm p-button-text"
                      [disabled]="!cambiado()" (click)="resetArbol()">
                <span class="p-button-label">Deshacer</span>
              </button>
              <button pButton type="button" class="p-button-sm" severity="contrast"
                      [disabled]="!cambiado()" (click)="modo.set('revision')">
                <span class="p-button-label">Revisar y guardar</span>
              </button>
            </div>
          }
        }
      </section>
    }
  `,
  styleUrls: ['./persona-acceso.component.css'],
})
export class PersonaAccesoComponent implements OnChanges {
  private api = inject(AdminService);
  private destroyRef = inject(DestroyRef);
  /** `[AU.12]` Los permisos de QUIEN administra, para el espejo del freno del backend. */
  private perms = inject(PermissionsService);

  @Input() userId: string | null = null;
  /**
   * `[AU.13]` El puesto que ocupa, para poder marcar **cuales complementos PROPONE**. El dato ya
   * existia (`GET /users/positions/:code/propuesta`) y esta pantalla no lo llamaba: se elegia el
   * complemento a ciegas teniendo la respuesta a un endpoint de distancia.
   */
  @Input() positionCode: string | null = null;
  @Input() puedeEscribir = false;
  @Output() guardado = new EventEmitter<string>();

  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardandoRoles = signal(false);
  readonly guardandoPerms = signal(false);

  readonly permisos = signal<PermisosDePersona | null>(null);
  readonly perfilBase = signal<string | null>(null);
  readonly complementos = signal<string[]>([]);

  // ── `[AU.14]` El estado del árbol ─────────────────────────────────────────
  readonly valores = signal<Record<string, boolean>>({});
  readonly modo = signal<Modo>('editor');
  readonly motivo = signal('');
  readonly filtro = signal('');
  readonly soloBase = signal(true);
  readonly seleccion = signal<string | null>(null);
  readonly uso = signal<UsoDePermisos>(null);
  readonly admins = signal(0);

  readonly excepcionesOriginal = signal<Excepcion[]>([]);
  private readonly valoresOriginal = signal<Record<string, boolean>>({});
  private readonly roles = signal<PerfilDelCatalogo[]>([]);
  private readonly complementosOriginal = signal<string[]>([]);
  /** `[AU.13]` Los complementos que declara su puesto. Vacio = no propone ninguno. */
  private readonly propuestos = signal<string[]>([]);

  readonly totalPermisos = TOTAL_PERMISSIONS;

  /**
   * `[AU.14]` Espejo del freno de `setPermissions`. Se pasa como función al árbol y al panel.
   * ⚠️ Es una propiedad, no un método: si fuera `(k) => ...` inline en el template, Angular
   * crearía una función nueva en cada ciclo y el `input` se vería siempre como cambiado.
   */
  readonly puedeOtorgarFn = (clave: string): boolean =>
    this.perms.isAdmin() || this.perms.has(clave);

  /**
   * `[AU.13]` ¿Se pudo medir de que departamento es cada perfil? `null` en el backend significa
   * que la fuente no estaba, y eso NO es lo mismo que "no tiene departamento": lo primero lo
   * arregla Sistemas, lo segundo lo arregla quien administra los puestos (ADR-056).
   */
  readonly agrupacionMedida = computed(
    () => !this.roles().some((r) => r.departamentos === null),
  );

  /**
   * `[AU.13]` Los complementos, agrupados por la parte de la organizacion que los declara.
   *
   * El orden contesta la pregunta de quien elige, no el alfabeto:
   *   1. lo que PROPONE su puesto (si algo hay) -- la respuesta antes de la lista;
   *   2. los departamentos cuyos puestos lo declaran, alfabeticos;
   *   3. los que ningun puesto declara, al final y dichos asi.
   *
   * Un perfil aparece en UN solo grupo: repetir el mismo `value` en dos grupos rompe la
   * seleccion del multiselect (marca uno y el otro queda suelto).
   */
  readonly rolOpts = computed(() => {
    const base = this.perfilBase();
    const propone = new Set(this.propuestos().filter((r) => r !== base));
    const filas = this.roles().filter((r) => r.role_name !== base);

    const item = (r: PerfilDelCatalogo) => ({
      label: this.nombreDePerfil(r.role_name),
      code: r.role_name,
      value: r.role_name,
      permisos: r.permisos,
      personas: r.personas,
      propuesto: propone.has(r.role_name),
    });

    const delPuesto = filas.filter((r) => propone.has(r.role_name)).map(item);
    const resto = filas.filter((r) => !propone.has(r.role_name));

    const porDepto = new Map<string, ReturnType<typeof item>[]>();
    const SIN = 'Ningun puesto lo declara';
    for (const r of resto) {
      // El backend los devuelve del mas declarado al menos: el primero es el departamento
      // donde ese perfil de verdad vive. `null` (no medido) cae en el mismo cajon que el
      // vacio, pero la pantalla lo declara arriba con otra frase.
      const dep = (r.departamentos && r.departamentos[0]) || SIN;
      porDepto.set(dep, [...(porDepto.get(dep) ?? []), item(r)]);
    }

    const grupos = [...porDepto.entries()]
      .sort((a, b) => (a[0] === SIN ? 1 : b[0] === SIN ? -1 : a[0].localeCompare(b[0])))
      .map(([label, items]) => ({
        label,
        items: items.sort((a, b) => a.label.localeCompare(b.label)),
      }));

    return delPuesto.length
      ? [{ label: 'Lo propone su puesto', items: delPuesto }, ...grupos]
      : grupos;
  });

  /**
   * `[AU.13]` El codigo, legible. NO inventa un nombre: cambia `_` por espacio y pone mayuscula
   * inicial, y el codigo sigue a la vista debajo.
   */
  nombreDePerfil(code: string): string {
    const txt = code.replace(/_/g, ' ').trim();
    return txt ? txt.charAt(0).toUpperCase() + txt.slice(1) : code;
  }

  etiqueta(key: string): string {
    return PERMISSION_META[key]?.label || key;
  }

  etiquetasDe(claves: string[]): string {
    return claves.map((k) => this.etiqueta(k)).join(', ');
  }

  // ── `[AU.14]` La diferencia, derivada ─────────────────────────────────────

  readonly baseSet = computed(() => new Set(this.permisos()?.del_puesto ?? []));

  /** Las excepciones a guardar. NO se escriben a mano: salen de comparar con el perfil. */
  readonly pendientes = computed<OverrideDePermiso[]>(() =>
    overridesContra(this.baseSet(), this.valores(), TODAS_LAS_CLAVES),
  );

  private readonly afectadas = computed(() => pantallasAfectadas(this.pendientes(), AUTHZ_TREE));
  readonly pantallas = computed(() => this.afectadas().pantallas);
  readonly sinModulo = computed(() => this.afectadas().sinModulo);

  readonly pantallasQueCierran = computed(() => this.pantallas().filter((p) => p.quita.length));
  readonly pantallasQueAbren = computed(() => this.pantallas().filter((p) => p.concede.length));

  readonly pantallasPorProyecto = computed(() => {
    const por = new Map<string, { projectId: string; projectLabel: string; items: CambioDePantalla[] }>();
    for (const p of this.pantallas()) {
      const g =
        por.get(p.projectId) ??
        { projectId: p.projectId, projectLabel: p.projectLabel, items: [] as CambioDePantalla[] };
      g.items.push(p);
      por.set(p.projectId, g);
    }
    return [...por.values()]
      .sort((a, b) => a.projectLabel.localeCompare(b.projectLabel))
      .map((g) => ({ ...g, items: [...g.items].sort((a, b) => a.label.localeCompare(b.label)) }));
  });

  readonly cuantasQuita = computed(() => this.pendientes().filter((o) => !o.allow).length);
  readonly cuantasConcede = computed(() => this.pendientes().filter((o) => o.allow).length);

  /**
   * ⚠️ Las claves sin módulo en el árbol NO se cuentan como lectura por descarte: se quedan fuera
   * de los dos números y se declaran aparte en `sinModulo`. Meterlas en «lectura» sería afirmar
   * algo que no se midió.
   */
  readonly cuantosDeGestion = computed(
    () =>
      this.pendientes().filter((o) => {
        const u = ubicacionDeClave(o.permission_key, AUTHZ_TREE);
        return !!u && (u.module.manage as readonly string[]).includes(o.permission_key);
      }).length,
  );
  readonly cuantosDeLectura = computed(
    () => this.pendientes().length - this.cuantosDeGestion() - this.sinModulo().length,
  );

  readonly efectivosTrasGuardar = computed(
    () => Object.values(this.valores()).filter(Boolean).length,
  );

  /** Lo que el backend va a rechazar: otorgar lo que quien edita no tiene. Se dice ANTES. */
  readonly noPodesOtorgar = computed(() =>
    this.pendientes()
      .filter((o) => o.allow && !this.puedeOtorgarFn(o.permission_key))
      .map((o) => o.permission_key),
  );

  readonly cambiado = computed(
    () => this.firmaValores(this.valores()) !== this.firmaValores(this.valoresOriginal()),
  );

  readonly demasiadas = computed(() => this.excepcionesOriginal().length >= 10);

  readonly complementosCambiaron = computed(
    () => this.firma(this.complementos()) !== this.firma(this.complementosOriginal()),
  );

  // ── Carga ─────────────────────────────────────────────────────────────────

  ngOnChanges(): void {
    this.error.set(null);
    this.permisos.set(null);
    this.complementos.set([]);
    this.valores.set({});
    this.modo.set('editor');
    this.motivo.set('');
    this.seleccion.set(null);
    if (!this.userId) return;

    this.cargando.set(true);
    this.api.permisosDe(this.userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.permisos.set(p);
        const exc = (p.overrides ?? []).map((o) => ({ ...o }));
        this.excepcionesOriginal.set(exc);
        // El árbol arranca marcando lo EFECTIVO: lo que la persona abre hoy, perfil más
        // excepciones. La diferencia contra `del_puesto` se deriva de ahí.
        const v = valoresDesdeBase(p.efectivos ?? []);
        this.valores.set(v);
        this.valoresOriginal.set({ ...v });
        this.cargando.set(false);
      },
      error: (e) => {
        this.error.set(this.mensajeDe(e));
        this.cargando.set(false);
      },
    });

    this.api.rolesDe(this.userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.perfilBase.set(r.perfil_base);
        const comp = (r.roles ?? []).filter((x) => !x.is_primary).map((x) => x.role_name);
        this.complementos.set(comp);
        this.complementosOriginal.set([...comp]);
      },
      error: () => this.perfilBase.set(null),
    });

    if (!this.roles().length) {
      this.api.roles().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => this.roles.set(r),
        error: () => this.roles.set([]),
      });
    }

    // `[AU.14]` Cuánta gente abre cada pantalla. Si falla, queda `null` y el panel DECLARA
    // «no medido» — nunca pinta 0, que se leería como «no la usa nadie».
    if (this.uso() === null) {
      this.api.usoDePermisos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.uso.set(r.uso ?? {});
          this.admins.set(r.platform_admins ?? 0);
        },
        error: () => this.uso.set(null),
      });
    }

    // `[AU.13]` Lo que el PUESTO propone. Sin puesto no hay propuesta, y eso no es un error:
    // las cuentas de dispositivo y de sistema no ocupan un puesto del organigrama.
    this.propuestos.set([]);
    if (this.positionCode) {
      this.api.propuesta(this.positionCode).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (pr) => this.propuestos.set(pr.complementos ?? []),
        error: () => this.propuestos.set([]),
      });
    }
  }

  // ── Mutaciones ────────────────────────────────────────────────────────────

  resetArbol(): void {
    this.valores.set({ ...this.valoresOriginal() });
    this.motivo.set('');
  }

  resetComplementos(): void {
    this.complementos.set([...this.complementosOriginal()]);
  }

  /**
   * `[AU.14]` Guarda el lote. `PUT` reemplaza el conjunto entero, así que se manda TODO lo
   * pendiente — incluido lo que no cambió.
   *
   * ⚠️ **El motivo viejo no se pisa.** Una diferencia que ya existía y sigue igual conserva su
   * nota original; el motivo del lote va sólo a las que nacen o cambian de signo. Sin esto,
   * guardar un cambio chico borraría el porqué de todas las demás.
   */
  guardar(): void {
    if (!this.userId || !this.motivo().trim()) return;
    const previo = new Map(
      this.excepcionesOriginal().map((e) => [e.permission_key, e]),
    );
    const lote = this.pendientes().map((o) => {
      const antes = previo.get(o.permission_key);
      const nota =
        antes && antes.allow === o.allow && (antes.nota ?? '').trim()
          ? (antes.nota as string).trim()
          : this.motivo().trim();
      return { permission_key: o.permission_key, allow: o.allow, nota };
    });

    this.guardandoPerms.set(true);
    this.error.set(null);
    this.api
      .setPermisos(this.userId, lote)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardandoPerms.set(false);
          this.guardado.emit(
            lote.length
              ? `Acceso actualizado: ${lote.length} diferencias contra su perfil.`
              : 'Acceso igualado a su perfil: ya no tiene diferencias.',
          );
          this.ngOnChanges();
        },
        error: (e) => {
          this.guardandoPerms.set(false);
          this.modo.set('revision');
          this.error.set(this.mensajeDe(e));
        },
      });
  }

  guardarComplementos(): void {
    if (!this.userId) return;
    this.guardandoRoles.set(true);
    this.error.set(null);
    this.api
      .setRoles(this.userId, this.complementos())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardandoRoles.set(false);
          this.guardado.emit('Complementos actualizados.');
          this.ngOnChanges();
        },
        error: (e) => {
          this.guardandoRoles.set(false);
          this.error.set(this.mensajeDe(e));
        },
      });
  }

  private firma(xs: string[]): string {
    return [...xs].sort().join('|');
  }

  private firmaValores(v: Record<string, boolean>): string {
    return Object.keys(v)
      .filter((k) => v[k] === true)
      .sort()
      .join('|');
  }

  private mensajeDe(e: unknown): string {
    const err = e as { error?: { message?: string | string[] } };
    const m = err?.error?.message;
    if (Array.isArray(m)) return m.join(' · ');
    return m ?? 'No se pudo leer ni guardar el acceso.';
  }
}
