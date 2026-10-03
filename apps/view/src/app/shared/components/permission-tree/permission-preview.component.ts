import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

import { AUTHZ_TREE, AuthzModule, AuthzProject, clavesDeModulo } from '../../../core/constants/authz-tree';
import { resolveSpaceForUrl } from '../../../core/constants/suite-map';
import { PERMISSION_META } from '../../../core/constants/permission-meta';

/** Cuántas personas y perfiles abren hoy cada permiso. `null` = no se pudo medir. */
export type UsoDePermisos = Record<string, { roles: number; personas: number }> | null;

type EstadoMarco = 'cargando' | 'ok' | 'no-embebible';

/**
 * `[AU.33]` — **Ver la pantalla que se está concediendo.**
 *
 * ── Por qué se puede mostrar en vivo sin abrir una puerta trasera ────────────
 * No es una suposición, sale de una regla que ya existe: `setPermissions` frena a todo el que no
 * es superadmin con "no puedes otorgar permisos que no tenés", y el superadmin los tiene todos.
 * Entonces **toda pantalla que le podés conceder a otro, vos ya la abrís**: mostrártela no te
 * enseña nada que no puedas ver entrando por el menú.
 *
 * ⛔ El hueco donde SÍ sería una puerta trasera: el freno sólo mira los `allow`, o sea que podés
 * QUITAR un permiso que vos no tenés. En ese caso el marco no se dibuja y se dice por qué.
 *
 * ── Lo que esto NO es ───────────────────────────────────────────────────────
 * ⚠️ **No es "como lo vería esa persona".** Se dibuja con la sesión y los datos de quien
 * administra. Dice QUÉ ES la pantalla, no qué vería el otro adentro. Mostrar el punto de vista
 * ajeno exige impersonación, que no existe en el repo (medido: cero `login-as`, `impersonate` o
 * `switch-user`) y es una decisión de seguridad aparte.
 *
 * ── Por qué el marco puede salir apagado ────────────────────────────────────
 * La app se sirve con `X-Frame-Options` y `frame-ancestors`. Si la política no permite que la app
 * se embeba a sí misma, el marco queda en blanco **sin error**, y un hueco mudo se lee como
 * "esta pantalla está vacía". Por eso se MIDE: al cargar se intenta leer la ubicación del iframe
 * —mismo origen, así que se puede— y si no llegó a nuestra URL se declara. No se asume ninguna
 * de las dos cosas.
 */
@Component({
  selector: 'app-permission-preview',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!modulo()) {
      <p class="pv-vacio">Elegí un módulo del árbol para ver qué pantalla abre.</p>
    } @else {
      <article class="pv">
        <header class="pv-head">
          @if (espacio(); as e) { <p class="pv-espacio">{{ e }}</p> }
          <div class="pv-titulo">
            <h3>{{ modulo()!.label }}</h3>
            @if (modulo()!.route) {
              <code class="pv-ruta">{{ modulo()!.route }}</code>
              <a class="pv-abrir" [href]="modulo()!.route" target="_blank" rel="noopener">
                Abrir en una pestaña <i class="pi pi-external-link" aria-hidden="true"></i>
              </a>
            } @else {
              <span class="pv-chip pv-chip-neutro">No es una pantalla de la app</span>
            }
          </div>
        </header>

        <ul class="pv-claves">
          @for (k of claves(); track k.key) {
            <li class="pv-chip" [class.pv-chip-on]="k.on" [class.pv-chip-off]="!k.on">
              @if (k.gestiona) { <i class="pi pi-pencil pv-ic" aria-hidden="true"></i> }
              <strong>{{ k.accion }}</strong>
              <span class="pv-key">{{ k.key }}</span>
            </li>
          }
          @if (!claves().length) {
            <li class="pv-chip pv-chip-neutro">Este módulo no declara permisos</li>
          }
        </ul>

        @for (d of descripciones(); track d) { <p class="pv-desc">{{ d }}</p> }

        <dl class="pv-datos">
          <div>
            <dt>La abren hoy</dt>
            <dd>
              @if (uso() === null) {
                <span class="pv-nomedido">no medido</span>
              } @else {
                <strong>{{ personas() }}</strong> personas en <strong>{{ roles() }}</strong> perfiles
                @if (admins() > 0) { <span class="pv-mas">+{{ admins() }} con acceso total</span> }
              }
            </dd>
          </div>
          <div>
            <dt>Esta pantalla</dt>
            <dd>{{ escribe() ? 'escribe: incluye acciones de gestión' : 'sólo lee' }}</dd>
          </div>
        </dl>

        @if (!puedeVerla()) {
          <div class="pv-bloq" role="status">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <div>
              <strong>No se puede previsualizar</strong>
              <p>
                Vos no abrís esta pantalla, así que mostrártela acá sería darte por la ventana lo
                que la puerta te niega. Podés <strong>quitársela</strong> sin verla; para
                concedérsela a alguien, primero tiene que tenerla tu propio perfil.
              </p>
            </div>
          </div>
        } @else if (!modulo()!.route) {
          <div class="pv-bloq" role="status">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <div>
              <strong>No hay pantalla que mostrar</strong>
              <p>
                Este permiso no abre una ruta de la app: gobierna un kiosco, un bot o una acción de
                otro sistema. Se declara así en vez de dibujar un marco vacío.
              </p>
            </div>
          </div>
        } @else {
          <div class="pv-marco">
            <div class="pv-barra">
              <span class="pv-puntos" aria-hidden="true"><i></i><i></i><i></i></span>
              <code>{{ modulo()!.route }}</code>
              @if (estadoMarco() === 'ok') { <span class="pv-vivo">en vivo</span> }
            </div>
            <div class="pv-lienzo">
              @if (src(); as url) {
                <iframe [src]="url" [title]="'Vista previa de ' + modulo()!.label"
                        tabindex="-1" loading="lazy" (load)="medirMarco($event)"></iframe>
              }
            </div>
            @if (estadoMarco() === 'no-embebible') {
              <div class="pv-nota pv-nota-warn" role="status">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>
                  La app no se deja embeber a sí misma (política de framing del servidor), así que
                  el marco queda vacío. Se declara en vez de dejarlo mudo:
                  <strong>usá «Abrir en una pestaña»</strong>.
                </span>
              </div>
            }
          </div>
          <p class="pv-pie">
            Se dibuja con <strong>tu</strong> sesión y tus datos, no con los de la persona que estás
            editando: dice qué es la pantalla, no qué vería ella adentro.
          </p>
        }
      </article>
    }
  `,
  styles: [`
    :host { display: block; }
    .pv-vacio { margin: 0; padding: var(--sp-6) var(--sp-4); font-size: var(--fs-sm);
                color: var(--text-muted); text-align: center; }
    .pv { display: flex; flex-direction: column; gap: var(--sp-3); }

    .pv-espacio { margin: 0 0 2px; font-size: var(--fs-xs); color: var(--text-muted); }
    .pv-titulo { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); }
    .pv-titulo h3 { margin: 0; font-size: var(--fs-lg); font-weight: 700; letter-spacing: -0.01em; }
    .pv-ruta { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .pv-abrir { margin-left: auto; font-size: var(--fs-xs); display: inline-flex;
                align-items: center; gap: 5px; min-height: 32px; }

    .pv-claves { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap;
                 gap: var(--sp-2); }
    .pv-chip { display: inline-flex; align-items: center; gap: var(--sp-2);
               border: 1px solid var(--border-color); border-radius: 999px;
               padding: 4px 10px; font-size: var(--fs-xs); }
    .pv-chip strong { font-weight: 600; }
    .pv-chip-on { background: var(--ok-soft-bg); border-color: var(--ok-border);
                  color: var(--ok-soft-fg); }
    .pv-chip-off { background: var(--surface-ground); color: var(--text-muted); }
    .pv-chip-neutro { color: var(--text-muted); }
    .pv-key { font-family: var(--font-mono); font-size: var(--fs-nano, 0.6875rem); opacity: 0.85; }
    .pv-ic { font-size: 10px; }

    .pv-desc { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }

    .pv-datos { display: flex; flex-wrap: wrap; gap: var(--sp-5); margin: 0;
                border-top: 1px solid var(--border-color);
                border-bottom: 1px solid var(--border-color); padding: var(--sp-2) 0; }
    .pv-datos dt { font-size: var(--fs-nano, 0.6875rem); text-transform: uppercase;
                   letter-spacing: 0.05em; color: var(--text-muted); }
    .pv-datos dd { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-main); }
    .pv-nomedido { color: var(--text-muted); font-style: italic; }
    .pv-mas { color: var(--text-muted); }

    .pv-bloq { display: flex; gap: var(--sp-3); border: 1px dashed var(--border-color);
               border-radius: var(--radius-md); background: var(--surface-ground);
               padding: var(--sp-5) var(--sp-4); align-items: flex-start; }
    .pv-bloq i { color: var(--text-muted); margin-top: 2px; }
    .pv-bloq strong { display: block; font-size: var(--fs-sm); }
    .pv-bloq p { margin: 4px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }

    .pv-marco { border: 1px solid var(--border-color); border-radius: var(--radius-md);
                overflow: hidden; background: var(--surface-card); }
    .pv-barra { display: flex; align-items: center; gap: var(--sp-2);
                padding: 6px var(--sp-3); background: var(--surface-ground);
                border-bottom: 1px solid var(--border-color); }
    .pv-barra code { flex: 1 1 auto; min-width: 0; font-family: var(--font-mono);
                     font-size: var(--fs-nano, 0.6875rem); color: var(--text-muted);
                     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pv-puntos { display: inline-flex; gap: 4px; }
    .pv-puntos i { width: 8px; height: 8px; border-radius: 50%; background: var(--border-color); }
    .pv-vivo { font-size: var(--fs-nano, 0.6875rem); font-weight: 600;
               color: var(--ok-soft-fg); background: var(--ok-soft-bg);
               border-radius: var(--radius-sm); padding: 1px 7px; }

    /* El marco es una VISTA, no una segunda app: sin puntero y sin foco. */
    .pv-lienzo { position: relative; width: 100%; height: 360px; overflow: hidden; }
    .pv-lienzo iframe { position: absolute; top: 0; left: 0; width: 1440px; height: 900px;
                        border: none; transform: scale(0.42); transform-origin: top left;
                        pointer-events: none; }

    .pv-nota { display: flex; gap: var(--sp-2); align-items: flex-start;
               padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs);
               border-top: 1px solid var(--border-color); }
    .pv-nota-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }

    .pv-pie { margin: 0; font-size: var(--fs-nano, 0.6875rem); color: var(--text-muted); }
  `],
})
export class PermissionPreviewComponent {
  private readonly sanitizer = inject(DomSanitizer);

  /** `projectId/moduleId`, como lo emite el árbol. */
  readonly seleccion = input<string | null>(null);
  readonly valores = input<Record<string, boolean>>({});
  readonly uso = input<UsoDePermisos>(null);
  /** Cuántas personas tienen acceso total por rol. Se declara aparte: no sale del mapa de permisos. */
  readonly admins = input(0);
  /** Lo que tiene quien ESTÁ ADMINISTRANDO. Decide si el marco en vivo se puede dibujar. */
  readonly misPermisos = input<(clave: string) => boolean>(() => false);

  readonly estadoMarco = signal<EstadoMarco>('cargando');

  constructor() {
    // Cada cambio de módulo vuelve a poner el marco en "cargando": si no, el veredicto del
    // módulo anterior se quedaría pegado y diría algo sobre una pantalla que ya no es ésta.
    effect(() => {
      this.seleccion();
      this.estadoMarco.set('cargando');
    });
  }

  private readonly ubicacion = computed<{ project: AuthzProject; module: AuthzModule } | null>(() => {
    const sel = this.seleccion();
    if (!sel) return null;
    const [projectId, moduleId] = sel.split('/');
    for (const app of AUTHZ_TREE) {
      for (const project of app.projects) {
        if (project.id !== projectId) continue;
        const module = project.modules.find((m) => m.id === moduleId);
        if (module) return { project, module };
      }
    }
    return null;
  });

  readonly modulo = computed(() => this.ubicacion()?.module ?? null);

  readonly espacio = computed(() => {
    const u = this.ubicacion();
    if (!u) return null;
    const r = resolveSpaceForUrl(u.module.route ?? u.project.route);
    return r ? `${r.space.label} › ${u.project.label}` : u.project.label;
  });

  readonly claves = computed(() => {
    const u = this.ubicacion();
    if (!u) return [];
    const v = this.valores();
    const manage = u.module.manage as readonly string[];
    return clavesDeModulo(u.module).map((k) => ({
      key: k,
      // La etiqueta del catálogo ya dice la acción ("Ver Bancos", "Gestionar Bancos"): no se le
      // antepone nada. `gestiona` queda aparte porque lo que escribe merece verse distinto.
      accion: PERMISSION_META[k]?.label || k,
      gestiona: manage.includes(k),
      on: v[k] === true,
    }));
  });

  readonly descripciones = computed(() => {
    const u = this.ubicacion();
    if (!u) return [];
    const vistas = new Set<string>();
    for (const k of clavesDeModulo(u.module)) {
      const d = PERMISSION_META[k]?.description;
      if (d) vistas.add(d);
    }
    return [...vistas];
  });

  readonly escribe = computed(() => (this.ubicacion()?.module.manage.length ?? 0) > 0);

  readonly personas = computed(() => {
    const u = this.uso();
    const mod = this.ubicacion()?.module;
    if (!u || !mod) return 0;
    // El máximo entre sus claves, no la suma: una persona con Ver y Gestionar es UNA persona.
    return Math.max(0, ...clavesDeModulo(mod).map((k) => u[k]?.personas ?? 0));
  });

  readonly roles = computed(() => {
    const u = this.uso();
    const mod = this.ubicacion()?.module;
    if (!u || !mod) return 0;
    return Math.max(0, ...clavesDeModulo(mod).map((k) => u[k]?.roles ?? 0));
  });

  /**
   * ⚠️ Alcanza con que quien administra tenga **alguna** de las claves del módulo: con eso ya
   * entra a la pantalla. Exigir todas la escondería a quien tiene sólo lectura, que la ve igual.
   */
  readonly puedeVerla = computed(() => {
    const mod = this.ubicacion()?.module;
    if (!mod) return false;
    const tengo = this.misPermisos();
    return clavesDeModulo(mod).some((k) => tengo(k));
  });

  readonly src = computed<SafeResourceUrl | null>(() => {
    const r = this.modulo()?.route;
    if (!r || !this.puedeVerla()) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(r);
  });

  /**
   * Mide si el marco de verdad cargó. Mismo origen, así que leer su ubicación es legítimo; si la
   * política de framing lo bloqueó, el documento se queda en `about:blank` o el acceso tira.
   */
  medirMarco(ev: Event): void {
    const el = ev.target as HTMLIFrameElement;
    const esperado = this.modulo()?.route ?? '';
    try {
      const href = el.contentWindow?.location?.href ?? '';
      this.estadoMarco.set(href && href.includes(esperado) ? 'ok' : 'no-embebible');
    } catch {
      this.estadoMarco.set('no-embebible');
    }
  }
}
