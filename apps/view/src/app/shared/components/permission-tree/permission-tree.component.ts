import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';

import {
  AUTHZ_TREE,
  AuthzApp,
  AuthzModule,
  AuthzProject,
  alternarGrupo,
  clavesDeApp,
  clavesDeModulo,
  clavesDeProyecto,
  cuantasEncendidas,
  triEstado,
} from '../../../core/constants/authz-tree';
import { PERMISSION_META } from '../../../core/constants/permission-meta';

/**
 * `[AU.33]` — **El árbol de permisos, una sola vez.**
 *
 * App -> Proyecto -> Modulo -> Ver/Gestionar, con tri-estado y cascada. Lo usa el editor de
 * permisos de un PERFIL y el de una PERSONA; la logica pura (tri-estado, cascada, diferencia)
 * vive en el contrato compartido y NO se reimplementa aca (ADR-056).
 *
 * ── Lo que aporta sobre una lista plana ─────────────────────────────────────
 * Medido en prod el 2026-10-03: para decir "este senor no entra a Finanzas ni a Contabilidad"
 * habia que escribir 27 excepciones de a una, cada una con su motivo. Son dos clics.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────
 * No guarda. Emite el estado DESEADO; quien lo monta decide que hacer con la diferencia.
 * No decide seguridad: el backend recorta igual. El freno anti-escalada que aplica aca es el
 * espejo del de `setPermissions`, para no ofrecer lo que el servidor va a negar.
 */
@Component({
  selector: 'app-permission-tree',
  standalone: true,
  imports: [CommonModule, FormsModule, CheckboxModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!proyectosVisibles().length) {
      <p class="pt-vacio">
        @if (filtro().trim() || soloBase()) {
          Ningún módulo coincide con el filtro.
        } @else {
          El árbol llegó vacío. Es una falla de carga, no un perfil sin permisos.
        }
      </p>
    }

    @for (app of appsVisibles(); track app.id) {
      <section class="pt-app">
        <header class="pt-app-head">
          <button type="button" class="pt-tri" (click)="alternar(clavesApp(app))"
                  [attr.aria-pressed]="estadoApp(app) === 'all'"
                  [attr.aria-label]="'Alternar ' + app.label">
            <i class="pi" [class.pi-check-square]="estadoApp(app) === 'all'"
               [class.pi-minus]="estadoApp(app) === 'some'"
               [class.pi-stop]="estadoApp(app) === 'none'" aria-hidden="true"></i>
          </button>
          <i [class]="app.icon" aria-hidden="true"></i>
          <span class="pt-app-nom">{{ app.label }}</span>
          <span class="pt-n">{{ encendidas(clavesApp(app)) }}/{{ clavesApp(app).length }}</span>
        </header>

        <!-- Apps de acceso general (Vendedor, Portal): un solo interruptor, sin proyectos. -->
        @if (accesoDe(app); as clave) {
          <div class="pt-hoja pt-hoja-sola">
            <p-checkbox [ngModel]="valores()[clave] === true" [binary]="true"
                        (ngModelChange)="fijarHoja(clave, $event)"
                        [disabled]="frenada(clave)"
                        [ariaLabel]="etiqueta(clave)"></p-checkbox>
            <span class="pt-hoja-nom">{{ etiqueta(clave) }}</span>
            <code class="pt-key">{{ clave }}</code>
            @if (cambia(clave)) { <span class="pt-dif" [class.pt-dif-quita]="!valores()[clave]">{{ signo(clave) }}</span> }
          </div>
        }

        @for (p of proyectosDe(app); track p.id) {
          <!-- Dos botones HERMANOS, no uno adentro del otro: un button dentro de un button es
               HTML invalido, y la salida barata (un span con click) deja el control fuera del
               Tab. Marcar el proyecto entero es la accion que esta fase vino a dar: no puede
               quedar solo para el mouse. -->
          <div class="pt-proy">
            <div class="pt-proy-head">
              <button type="button" class="pt-tri" (click)="alternar(clavesProy(p))"
                      [attr.aria-pressed]="estadoProy(p) === 'all'"
                      [attr.aria-label]="'Alternar todo el proyecto ' + p.label">
                <i class="pi" [class.pi-check-square]="estadoProy(p) === 'all'"
                   [class.pi-minus]="estadoProy(p) === 'some'"
                   [class.pi-stop]="estadoProy(p) === 'none'" aria-hidden="true"></i>
              </button>
              <button type="button" class="pt-proy-abrir" (click)="plegar(p.id)"
                      [attr.aria-expanded]="!plegado(p.id)">
                <i class="pi pt-chev" [class.pi-chevron-right]="plegado(p.id)"
                   [class.pi-chevron-down]="!plegado(p.id)" aria-hidden="true"></i>
                <span class="pt-proy-nom">{{ p.label }}</span>
                <code class="pt-ruta">{{ p.route }}</code>
              </button>
              <span class="pt-n">{{ encendidas(clavesProy(p)) }}/{{ clavesProy(p).length }}</span>
            </div>

            @if (!plegado(p.id)) {
              @for (m of modulosDe(p); track m.id) {
                <div class="pt-mod" [class.pt-mod-sel]="seleccion() === p.id + '/' + m.id">
                  <div class="pt-mod-head">
                    <button type="button" class="pt-tri pt-tri-sm" (click)="alternar(clavesMod(m))"
                            [attr.aria-pressed]="estadoMod(m) === 'all'"
                            [attr.aria-label]="'Alternar el módulo ' + m.label">
                      <i class="pi" [class.pi-check-square]="estadoMod(m) === 'all'"
                         [class.pi-minus]="estadoMod(m) === 'some'"
                         [class.pi-stop]="estadoMod(m) === 'none'" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="pt-mod-nom" (click)="elegir(p.id, m.id)"
                            [attr.aria-pressed]="seleccion() === p.id + '/' + m.id">
                      <span>{{ m.label }}</span>
                      @if (m.route) {
                        <code class="pt-ruta">{{ m.route }}</code>
                      } @else {
                        <span class="pt-sin-ruta">no es una pantalla</span>
                      }
                    </button>
                    <span class="pt-n">{{ encendidas(clavesMod(m)) }}/{{ clavesMod(m).length }}</span>
                  </div>

                  <div class="pt-hojas">
                    @for (k of clavesMod(m); track k) {
                      <label class="pt-hoja" [class.pt-hoja-cambia]="cambia(k)">
                        <p-checkbox [ngModel]="valores()[k] === true" [binary]="true"
                                    (ngModelChange)="fijarHoja(k, $event)"
                                    [disabled]="frenada(k)"
                                    [ariaLabel]="etiqueta(k)"></p-checkbox>
                        <span class="pt-hoja-nom" [title]="descripcion(k)">
                          @if (esGestion(m, k)) { <span class="pt-tag-g">gestiona</span> }
                          {{ etiqueta(k) }}
                        </span>
                        @if (cambia(k)) {
                          <span class="pt-dif" [class.pt-dif-quita]="!valores()[k]">{{ signo(k) }}</span>
                        }
                        @if (frenada(k)) { <span class="pt-bloq">no podés otorgarlo</span> }
                      </label>
                    }
                    @if (!clavesMod(m).length) {
                      <span class="pt-sin-claves">Sin permisos declarados</span>
                    }
                  </div>
                </div>
              }
            }
          </div>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .pt-vacio { margin: 0; padding: var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); }

    .pt-app { border: 1px solid var(--border-color); border-radius: var(--radius-md);
              background: var(--surface-card); overflow: hidden; margin-bottom: var(--sp-3); }
    .pt-app-head { display: flex; align-items: center; gap: var(--sp-3);
                   padding: var(--sp-3) var(--sp-4); background: var(--surface-ground);
                   border-bottom: 1px solid var(--border-color); }
    .pt-app-nom { font-weight: 600; font-size: var(--fs-body); }

    .pt-n { margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-xs);
            color: var(--text-muted); }

    .pt-tri { appearance: none; border: none; background: none; padding: 0; cursor: pointer;
              width: 24px; height: 24px; display: inline-flex; align-items: center;
              justify-content: center; color: var(--action); }
    .pt-tri .pi-stop { color: var(--text-faint); }
    .pt-tri-sm { width: 20px; height: 20px; font-size: var(--fs-xs); }

    .pt-proy { border-bottom: 1px solid var(--border-color); }
    .pt-proy:last-child { border-bottom: none; }
    .pt-proy-head { display: flex; align-items: center; gap: var(--sp-2);
                    padding: var(--sp-2) var(--sp-4); min-height: 40px; }
    .pt-proy-head:hover { background: var(--surface-hover); }
    .pt-proy-abrir { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap;
                     align-items: baseline; gap: var(--sp-2); background: none; border: none;
                     font: inherit; text-align: left; cursor: pointer; min-height: 36px;
                     color: var(--text-main); padding: 0; }
    .pt-proy-nom { font-weight: 600; font-size: var(--fs-sm); }
    .pt-chev { font-size: 10px; color: var(--text-muted); }

    .pt-ruta { font-family: var(--font-mono); font-size: var(--fs-nano, 0.6875rem);
               color: var(--text-muted); }
    .pt-sin-ruta { font-size: var(--fs-nano, 0.6875rem); color: var(--text-muted);
                   font-style: italic; }

    .pt-mod { padding: var(--sp-1) var(--sp-4) var(--sp-2) var(--sp-6);
              border-left: 2px solid transparent; }
    .pt-mod-sel { background: var(--surface-hover); border-left-color: var(--action); }
    .pt-mod-head { display: flex; align-items: center; gap: var(--sp-2); }
    .pt-mod-nom { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap;
                  align-items: baseline; gap: var(--sp-2); background: none; border: none;
                  font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer;
                  padding: var(--sp-2) 0; min-height: 36px; color: var(--text-main); }
    .pt-mod-nom:hover span:first-child { text-decoration: underline; }

    .pt-hojas { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-5);
                padding-left: var(--sp-6); }
    .pt-hoja { display: inline-flex; align-items: center; gap: var(--sp-2); cursor: pointer;
               font-size: var(--fs-xs); min-height: 28px; }
    .pt-hoja-sola { padding: var(--sp-3) var(--sp-4); }
    .pt-hoja-nom { color: var(--text-muted); }
    .pt-hoja-cambia .pt-hoja-nom { color: var(--text-main); font-weight: 500; }
    .pt-key { font-family: var(--font-mono); font-size: var(--fs-nano, 0.6875rem);
              color: var(--text-muted); }

    .pt-tag-g { display: inline-block; font-size: 9px; text-transform: uppercase;
                letter-spacing: 0.05em; color: var(--action); margin-right: var(--sp-1); }

    .pt-dif { font-family: var(--font-mono); font-size: var(--fs-nano, 0.6875rem);
              font-weight: 700; background: var(--ok-soft-bg); color: var(--ok-soft-fg);
              border-radius: var(--radius-sm); padding: 0 5px; }
    .pt-dif-quita { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }

    .pt-bloq { font-size: var(--fs-nano, 0.6875rem); color: var(--warn-soft-fg);
               background: var(--warn-soft-bg); border-radius: var(--radius-sm); padding: 0 5px; }
    .pt-sin-claves { font-size: var(--fs-nano, 0.6875rem); color: var(--text-muted);
                     font-style: italic; }
  `],
})
export class PermissionTreeComponent {
  /** El estado DESEADO, clave por clave. Es el modelo: quien lo monta lo lee y escribe. */
  readonly valores = model<Record<string, boolean>>({});

  /** Lo que la persona ya tiene por su perfil. Sirve para marcar la diferencia, no para gatear. */
  readonly base = input<ReadonlySet<string>>(new Set<string>());

  /**
   * Espejo del freno del backend. Por default no frena nada: el editor de un PERFIL y el de una
   * PERSONA le pasan el suyo. ⚠️ Sólo aplica al ENCENDER — quitar lo que no tenés es legítimo y
   * `setPermissions` lo permite (sólo valida los `allow`).
   */
  readonly puedeOtorgar = input<(clave: string) => boolean>(() => true);

  /** Recorta el árbol a lo que el perfil base abre. Para la ficha de una persona es el default útil. */
  readonly soloBase = input(false);

  /** Texto libre: busca por etiqueta de módulo, de proyecto, por ruta y por clave. */
  readonly filtro = input('');

  /** Módulo elegido, como `projectId/moduleId`. Lo consume el panel de vista previa. */
  readonly seleccion = model<string | null>(null);

  /** Estado interno, no una entrada: con `model()` esto sería un input público que nadie usa. */
  private readonly plegados = signal<Set<string>>(new Set<string>());

  readonly arbol = AUTHZ_TREE;

  // ── Filtrado ──────────────────────────────────────────────────────────────

  private coincide(m: AuthzModule, p: AuthzProject): boolean {
    const q = this.filtro().trim().toLowerCase();
    const base = this.base();
    if (this.soloBase() && !clavesDeModulo(m).some((k) => base.has(k))) return false;
    if (!q) return true;
    const heno = [
      m.label,
      m.route ?? '',
      p.label,
      ...clavesDeModulo(m).map((k) => `${k} ${PERMISSION_META[k]?.label ?? ''}`),
    ]
      .join(' ')
      .toLowerCase();
    return heno.includes(q);
  }

  modulosDe(p: AuthzProject): AuthzModule[] {
    return p.modules.filter((m) => this.coincide(m, p));
  }

  proyectosDe(app: AuthzApp): AuthzProject[] {
    return app.projects.filter((p) => this.modulosDe(p).length > 0);
  }

  readonly proyectosVisibles = computed(() => {
    // Se lee `filtro`/`soloBase`/`base` para que el computed se recalcule con ellos.
    this.filtro();
    this.soloBase();
    this.base();
    return this.arbol.flatMap((a) => (a.kind === 'workspace' ? this.proyectosDe(a) : []));
  });

  readonly appsVisibles = computed(() => {
    this.filtro();
    this.soloBase();
    this.base();
    return this.arbol.filter((a) =>
      a.kind === 'access' ? this.accesoVisible(a) : this.proyectosDe(a).length > 0,
    );
  });

  private accesoVisible(app: AuthzApp): boolean {
    const k = app.accessPermission;
    if (!k) return false;
    if (this.soloBase() && !this.base().has(k)) return false;
    const q = this.filtro().trim().toLowerCase();
    if (!q) return true;
    return `${app.label} ${k} ${PERMISSION_META[k]?.label ?? ''}`.toLowerCase().includes(q);
  }

  // ── Claves y estados (la lógica vive en el contrato) ──────────────────────

  clavesApp(a: AuthzApp): string[] { return clavesDeApp(a); }
  clavesProy(p: AuthzProject): string[] { return clavesDeProyecto(p); }
  clavesMod(m: AuthzModule): string[] { return clavesDeModulo(m); }
  accesoDe(a: AuthzApp): string | null { return a.kind === 'access' ? a.accessPermission ?? null : null; }

  encendidas(claves: string[]): number { return cuantasEncendidas(this.valores(), claves); }
  estadoApp(a: AuthzApp) { return triEstado(this.valores(), clavesDeApp(a)); }
  estadoProy(p: AuthzProject) { return triEstado(this.valores(), clavesDeProyecto(p)); }
  estadoMod(m: AuthzModule) { return triEstado(this.valores(), clavesDeModulo(m)); }

  esGestion(m: AuthzModule, k: string): boolean {
    return (m.manage as readonly string[]).includes(k);
  }

  etiqueta(k: string): string { return PERMISSION_META[k]?.label || k; }
  descripcion(k: string): string { return PERMISSION_META[k]?.description || ''; }

  /** Difiere de lo que da el perfil. Es lo que se va a guardar como excepción. */
  cambia(k: string): boolean {
    return (this.valores()[k] === true) !== this.base().has(k);
  }

  signo(k: string): string {
    return this.valores()[k] === true ? '+' : '−';
  }

  /** Frenada = todavía no la tiene Y quien edita no puede otorgarla. Quitar nunca se frena. */
  frenada(k: string): boolean {
    return this.valores()[k] !== true && !this.puedeOtorgar()(k);
  }

  // ── Mutaciones ────────────────────────────────────────────────────────────

  fijarHoja(k: string, v: boolean): void {
    if (v && this.frenada(k)) return;
    this.valores.update((actual) => ({ ...actual, [k]: v }));
  }

  alternar(claves: string[]): void {
    this.valores.update((actual) => alternarGrupo(actual, claves, this.puedeOtorgar()));
  }

  elegir(projectId: string, moduleId: string): void {
    const id = `${projectId}/${moduleId}`;
    this.seleccion.set(this.seleccion() === id ? null : id);
  }

  plegado(id: string): boolean { return this.plegados().has(id); }

  plegar(id: string): void {
    this.plegados.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
}
