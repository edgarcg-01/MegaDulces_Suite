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
import {
  PERMISSION_META,
  PERMISSION_CATEGORY_ORDER,
  TOTAL_PERMISSIONS,
} from '../../../core/constants/permission-meta';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[AU.10]` — Qué abre una persona: su perfil base, sus complementos y sus
 * excepciones.
 *
 * ⛔ Esto NO es un segundo `/admin/roles`. El perfil concede; acá sólo se
 * declaran las **diferencias** contra él, y cada una lleva motivo escrito.
 * Medido en prod: hay 32 excepciones vivas y **las 32 sin nota**, así que nadie
 * sabe por qué existe ninguna — que es exactamente el destino de `user_roles`
 * que la nota venía a evitar.
 *
 * ⚠️ Un montón de excepciones sobre una persona no es una excepción: es que el
 * rol no le queda. La pantalla lo dice y manda a arreglar el rol.
 */

interface Excepcion {
  permission_key: string;
  allow: boolean;
  nota: string | null;
}

@Component({
  selector: 'app-persona-acceso',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, TagModule, SelectModule,
    MultiSelectModule, InputTextModule,
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
        <p-multiselect [options]="rolOpts()" [ngModel]="complementos()"
                       (ngModelChange)="complementos.set($event)" optionLabel="label"
                       optionValue="value" appendTo="body" [filter]="true" display="chip"
                       [disabled]="!puedeEscribir || !!permisos()?.platform_admin"
                       placeholder="Ninguno" ariaLabel="Complementos de perfil"></p-multiselect>
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
        <h3>Excepciones</h3>

        @if (demasiadas()) {
          <div class="pd-aviso-blk" role="status">
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
            <div>
              <strong>{{ excepciones().length }} excepciones</strong> sobre un mismo perfil no son
              excepciones: son que el perfil no le queda. Lo que corrige el problema de raíz es
              arreglar el perfil, no acumular parches acá.
              <a class="pd-link" routerLink="/admin/roles">Ir a Roles y permisos →</a>
            </div>
          </div>
        }

        @if (!excepciones().length) {
          <p class="pd-vacio">Sin excepciones: su acceso sale entero de su perfil. Es lo deseable.</p>
        } @else {
          <ul class="pd-lista">
            @for (e of excepciones(); track e.permission_key) {
              <li class="pa-exc">
                <!-- [AU.6] La etiqueta primero y la clave debajo. Antes salía sólo
                     COMMERCIAL_QUOTES_VER: quien administra personas lee lo que el permiso
                     ABRE, no cómo se declara en el enum. La clave se conserva —es lo que se
                     guarda y lo que se menciona en un soporte— pero demotada. -->
                <span class="pa-perm">
                  <span class="pa-perm-label">{{ etiqueta(e.permission_key) }}</span>
                  <span class="pa-perm-key">{{ e.permission_key }}</span>
                </span>
                <p-tag [value]="e.allow ? 'concede' : 'quita'"
                       [severity]="e.allow ? 'success' : 'danger'" styleClass="pd-tag"></p-tag>
                <input pInputText [ngModel]="e.nota ?? ''" (ngModelChange)="setNota(e.permission_key, $event)"
                       [disabled]="!puedeEscribir" class="pa-nota"
                       placeholder="Por qué (obligatorio)"
                       [attr.aria-label]="'Motivo de ' + etiqueta(e.permission_key)" />
                @if (puedeEscribir) {
                  <button pButton type="button" class="icon-btn-ghost-bad"
                          (click)="quitar(e.permission_key)"
                          [attr.aria-label]="'Quitar la excepción ' + etiqueta(e.permission_key)">
                    <span class="pi pi-times" aria-hidden="true"></span>
                  </button>
                }
              </li>
            }
          </ul>
        }

        @if (puedeEscribir && !permisos()?.platform_admin) {
          <div class="pa-nueva">
            <!-- [AU.6] Agrupado por categoría y con la etiqueta legible. Eran 201 claves en
                 SCREAMING_SNAKE ordenadas alfabéticamente: para encontrar "ver cotizaciones"
                 había que saber de antemano que se llama COMMERCIAL_QUOTES_VER.
                 filterBy=label,key para que el que sí se sabe la clave la siga tecleando. -->
            <p-select [options]="claveOpts()" [ngModel]="nuevaClave()"
                      (ngModelChange)="elegirClave($event)" optionLabel="label" optionValue="value"
                      [group]="true" optionGroupLabel="label" optionGroupChildren="items"
                      [filter]="true" filterBy="label,key" appendTo="body"
                      placeholder="Agregar una excepción" ariaLabel="Permiso"></p-select>
            <p-select [options]="signoOpts" [ngModel]="nuevoAllow()"
                      (ngModelChange)="nuevoAllow.set($event)" optionLabel="label" optionValue="value"
                      appendTo="body" ariaLabel="Concede o quita"></p-select>
            <button pButton type="button" class="p-button-sm" [disabled]="!nuevaClave()"
                    (click)="agregar()">
              <span class="p-button-label">Agregar</span>
            </button>
          </div>
          <p class="pd-hint">
            Se puede elegir cualquiera de los {{ totalPermisos }} permisos del catálogo, tenga o no
            este perfil. Los que ya abre vienen marcados.
          </p>

          @if (avisoNoPuedeOtorgar(); as etq) {
            <p class="pd-hint">
              <strong>{{ etq }}</strong> no lo tenés vos, y sólo un superadmin puede otorgar un
              permiso que no tiene. Si lo agregás, el guardado se va a rechazar.
            </p>
          }

          @if (excepcionesCambiaron()) {
            <div class="pa-acc">
              <button pButton type="button" class="p-button-sm p-button-text" (click)="resetExcepciones()">
                <span class="p-button-label">Deshacer</span>
              </button>
              <button pButton type="button" class="p-button-sm" severity="contrast"
                      [disabled]="guardandoPerms() || !!faltaNota()" (click)="guardarExcepciones()">
                <span class="p-button-label">Guardar excepciones</span>
              </button>
            </div>
            @if (faltaNota(); as k) {
              <p class="pd-hint">
                Falta el motivo de <strong>{{ etiqueta(k) }}</strong>. Sin él, dentro de seis
                meses nadie va a saber si fue una decisión o un descuido.
              </p>
            }
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
  /** `[AU.12]` Los permisos de QUIEN administra, para avisar del freno del backend. */
  private perms = inject(PermissionsService);

  @Input() userId: string | null = null;
  @Input() puedeEscribir = false;
  @Output() guardado = new EventEmitter<string>();

  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardandoRoles = signal(false);
  readonly guardandoPerms = signal(false);

  readonly permisos = signal<PermisosDePersona | null>(null);
  readonly perfilBase = signal<string | null>(null);
  readonly complementos = signal<string[]>([]);
  readonly excepciones = signal<Excepcion[]>([]);
  readonly nuevaClave = signal<string | null>(null);
  readonly nuevoAllow = signal(true);

  private readonly complementosOriginal = signal<string[]>([]);
  private readonly excepcionesOriginal = signal<Excepcion[]>([]);
  private readonly roles = signal<string[]>([]);

  readonly signoOpts = [
    { label: 'Le concede', value: true },
    { label: 'Le quita', value: false },
  ];

  readonly rolOpts = computed(() =>
    this.roles()
      .filter((r) => r !== this.perfilBase())
      .map((r) => ({ label: r, value: r })),
  );

  /** Lo que esta persona YA abre. Decide el signo por default y marca la opción. */
  readonly yaTiene = computed(() => new Set(this.permisos()?.efectivos ?? []));

  /**
   * Las claves que todavía no son excepción. Un permiso no se declara dos veces.
   *
   * `[AU.6]` Agrupadas por la categoría de `PERMISSION_META` y ordenadas por etiqueta, no por
   * clave: el orden alfabético del enum mezcla dominios (`COMMERCIAL_*` de ventas, de almacén y
   * de logística quedan intercalados) y no es el orden en el que nadie busca.
   *
   * ⛔ `[AU.12]` **Acá salía sólo lo que la persona YA tenía** (`efectivos ∪ del_puesto`), y eso
   * volvía imposible la mitad de la función: el selector de signo ofrece «Le concede» y «Le
   * quita», pero para conceder hay que elegir una clave que NO tiene — y esa clave nunca estaba
   * en la lista. Medido: a una persona con 17 permisos se le ofrecían 17 de las
   * **204 del catálogo** (8%). El comentario de `[AU.6]` decía «eran 201 claves», o sea
   * que la intención siempre fue el catálogo entero; la lista se había recortado sola.
   *
   * El backend nunca fue el límite: `setPermissions` valida contra el enum completo y sólo pide
   * —para quien no es superadmin— que el permiso que se OTORGA lo tenga quien lo otorga.
   */
  readonly claveOpts = computed(() => {
    const ya = new Set(this.excepciones().map((e) => e.permission_key));
    const tiene = this.yaTiene();
    const claves = Object.keys(PERMISSION_META).filter((k) => !ya.has(k));

    const porCategoria = new Map<string, Array<{ label: string; key: string; value: string }>>();
    for (const k of claves) {
      const meta = PERMISSION_META[k];
      const cat = meta?.category || 'Otros';
      if (!porCategoria.has(cat)) porCategoria.set(cat, []);
      // Se marcan los que YA tiene, que son los pocos: sobre esos la excepción sólo puede
      // quitar. Sin la marca, «Le concede» sobre algo que ya tiene es una excepción que no
      // hace nada y que después nadie sabe por qué está.
      porCategoria.get(cat)!.push({
        label: (meta?.label || k) + (tiene.has(k) ? ' · ya lo tiene' : ''),
        key: k,
        value: k,
      });
    }

    // El orden declarado del catálogo manda; lo que no esté en él va al final, por nombre.
    const orden = (c: string) => {
      const i = PERMISSION_CATEGORY_ORDER.indexOf(c);
      return i === -1 ? PERMISSION_CATEGORY_ORDER.length : i;
    };
    return [...porCategoria.entries()]
      .sort((a, b) => orden(a[0]) - orden(b[0]) || a[0].localeCompare(b[0]))
      .map(([label, items]) => ({
        label,
        items: items.sort((a, b) => a.label.localeCompare(b.label)),
      }));
  });

  /**
   * `[AU.6]` La etiqueta legible de una clave. Fallback a la clave cruda —el catálogo cubre
   * hoy 201 de 201, pero un permiso nuevo sin entrada tiene que salir con algo, no vacío.
   * Mismo helper que ya usa el editor de roles (`admin-roles-permissions.metaLabel`).
   */
  etiqueta(key: string): string {
    return PERMISSION_META[key]?.label || key;
  }

  /** `[AU.12]` El tamaño del catálogo, en vivo: un número escrito a mano envejece sin avisar. */
  readonly totalPermisos = TOTAL_PERMISSIONS;

  readonly demasiadas = computed(() => this.excepciones().length >= 10);

  readonly complementosCambiaron = computed(
    () => this.firma(this.complementos()) !== this.firma(this.complementosOriginal()),
  );

  readonly excepcionesCambiaron = computed(
    () => this.firmaExc(this.excepciones()) !== this.firmaExc(this.excepcionesOriginal()),
  );

  /** La primera clave sin motivo, o `null`. La nota es lo único que distingue decisión de descuido. */
  readonly faltaNota = computed(
    () => this.excepciones().find((e) => !(e.nota ?? '').trim())?.permission_key ?? null,
  );

  ngOnChanges(): void {
    this.error.set(null);
    this.permisos.set(null);
    this.excepciones.set([]);
    this.complementos.set([]);
    this.nuevaClave.set(null);
    if (!this.userId) return;

    this.cargando.set(true);
    this.api.permisosDe(this.userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.permisos.set(p);
        const exc = (p.overrides ?? []).map((o) => ({ ...o }));
        this.excepciones.set(exc);
        this.excepcionesOriginal.set(exc.map((o) => ({ ...o })));
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
        next: (r) => this.roles.set(r.map((x) => x.role_name)),
        error: () => this.roles.set([]),
      });
    }
  }

  setNota(key: string, nota: string): void {
    this.excepciones.set(
      this.excepciones().map((e) => (e.permission_key === key ? { ...e, nota } : e)),
    );
  }

  /**
   * `[AU.12]` El signo lo propone la realidad: sobre un permiso que ya tiene, la única excepción
   * con sentido es quitárselo; sobre uno que no tiene, concedérselo. Se sigue pudiendo cambiar.
   */
  elegirClave(k: string | null): void {
    this.nuevaClave.set(k);
    if (k) this.nuevoAllow.set(!this.yaTiene().has(k));
  }

  /**
   * `[AU.12]` El freno del backend, dicho ANTES de guardar: quien no es superadmin no puede
   * otorgar un permiso que no tiene (`setPermissions` responde 403). Se AVISA, no se esconde la
   * opción: `PermissionsService` lee la foto del JWT, que puede estar vieja — ocultar por un
   * dato viejo sería negar algo que sí se puede hacer.
   */
  readonly avisoNoPuedeOtorgar = computed(() => {
    const k = this.nuevaClave();
    if (!k || !this.nuevoAllow() || this.perms.isAdmin()) return null;
    return this.perms.has(k) ? null : this.etiqueta(k);
  });

  agregar(): void {
    const k = this.nuevaClave();
    if (!k) return;
    this.excepciones.set([...this.excepciones(), { permission_key: k, allow: this.nuevoAllow(), nota: '' }]);
    this.nuevaClave.set(null);
  }

  quitar(key: string): void {
    this.excepciones.set(this.excepciones().filter((e) => e.permission_key !== key));
  }

  resetExcepciones(): void {
    this.excepciones.set(this.excepcionesOriginal().map((o) => ({ ...o })));
  }

  resetComplementos(): void {
    this.complementos.set([...this.complementosOriginal()]);
  }

  guardarExcepciones(): void {
    if (!this.userId || this.faltaNota()) return;
    this.guardandoPerms.set(true);
    this.error.set(null);
    this.api
      .setPermisos(
        this.userId,
        this.excepciones().map((e) => ({
          permission_key: e.permission_key,
          allow: e.allow,
          nota: (e.nota ?? '').trim(),
        })),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardandoPerms.set(false);
          this.guardado.emit('Excepciones de permiso actualizadas.');
          this.ngOnChanges();
        },
        error: (e) => {
          this.guardandoPerms.set(false);
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

  private firmaExc(xs: Excepcion[]): string {
    return [...xs]
      .map((e) => `${e.permission_key}:${e.allow}:${(e.nota ?? '').trim()}`)
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
