import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Capacitor } from '@capacitor/core';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { RoutePingService } from '../../core/services/route-ping.service';
import { PushService } from '../../core/services/push.service';

interface DiagProbe {
  build: { commit: string; ts: string };
  displayMode: { standalone_mq: boolean; navigator_standalone: boolean | null };
  safeAreaInset: { top: string; right: string; bottom: string; left: string };
  viewport: { innerW: number; innerH: number; screenW: number; screenH: number; dpr: number };
  visualViewport: { w: number; h: number; offsetTop: number; offsetLeft: number } | null;
  bottomNav: { top: number; bottom: number; height: number; gapToScreenBottom: number } | null;
  bgColors: { html: string; body: string; shell: string; nav: string; main: string };
  navPaddingBottom: string;
  bottomViewportGap: number;
  elementAt: { navMid: string; navBottom: string; viewportBottom: string };
  ua: string;
}

/**
 * Shell del modo vendedor — mobile-first.
 * Header compacto + bottom nav (estilo nativo). Sin sidebar.
 */
@Component({
  selector: 'app-vendor-shell',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, ButtonModule, ToastModule],
  providers: [MessageService],
  template: `
    <div class="vendor-shell">
      <p-toast position="top-center"></p-toast>
      <header class="vendor-header">
        <div class="vendor-brand">
          <i class="pi pi-briefcase"></i>
          <span>Vendedor</span>
        </div>
        <div class="vendor-user">
          <a
            pButton
            icon="pi pi-search"
            severity="secondary"
            size="small"
            text
            routerLink="search"
            routerLinkActive="header-active"
            aria-label="Buscar cliente"
          ></a>
          <a
            pButton
            icon="pi pi-bell"
            severity="secondary"
            size="small"
            text
            routerLink="notifications"
            routerLinkActive="header-active"
            aria-label="Notificaciones"
          ></a>
          <a
            pButton
            icon="pi pi-chart-bar"
            severity="secondary"
            size="small"
            text
            routerLink="today"
            routerLinkActive="header-active"
            aria-label="Mi día"
          ></a>
          <button
            pButton
            icon="pi pi-cog"
            severity="secondary"
            size="small"
            text
            (click)="settingsOpen.set(!settingsOpen())"
            aria-label="Configuración"
          ></button>
        </div>
      </header>

      <!-- Aviso de salud del tracking: el GPS puede cortarse con la pantalla bloqueada -->
      <button
        class="bg-banner"
        *ngIf="routePing.trackingHealth() === 'permission' || routePing.trackingHealth() === 'inactive'"
        (click)="openBgHelp()"
      >
        <i class="pi pi-exclamation-triangle"></i>
        <span *ngIf="routePing.trackingHealth() === 'permission'">
          Tu ubicación deja de registrarse al bloquear. Falta permiso <b>"Permitir todo el tiempo"</b>. <u>Arreglar</u>
        </span>
        <span *ngIf="routePing.trackingHealth() === 'inactive'">
          El rastreo en segundo plano no está activo. <u>Arreglar</u>
        </span>
      </button>

      <!-- Panel de configuración (modo oscuro + cerrar sesión) -->
      <div class="settings-backdrop" *ngIf="settingsOpen()" (click)="settingsOpen.set(false)"></div>
      <div class="settings-panel" *ngIf="settingsOpen()">
        <button class="set-row" (click)="theme.toggleMonochrome()">
          <i class="pi" [ngClass]="theme.isMonochrome() ? 'pi-moon' : 'pi-sun'"></i>
          <span class="lbl">Modo oscuro</span>
          <span class="switch" [class.on]="theme.isMonochrome()"><span class="knob"></span></span>
        </button>
        <button class="set-row" (click)="openBgHelp()">
          <i class="pi pi-map-marker"></i>
          <span class="lbl">Ubicación y batería</span>
        </button>
        <button class="set-row" (click)="openDiag()">
          <i class="pi pi-info-circle"></i>
          <span class="lbl">Diagnóstico PWA</span>
        </button>
        <button class="set-row" *ngIf="push.supported" (click)="enablePush()" [disabled]="pushBusy()">
          <i class="pi pi-bell"></i>
          <span class="lbl">{{ push.permission() === 'granted' ? 'Avisos activados' : 'Activar avisos de cierre' }}</span>
          <i class="pi" [ngClass]="pushBusy() ? 'pi-spin pi-spinner' : (push.permission() === 'granted' ? 'pi-check' : 'pi-chevron-right')"></i>
        </button>
        <button class="set-row danger" (click)="logout()">
          <i class="pi pi-sign-out"></i>
          <span class="lbl">Cerrar sesión</span>
        </button>
      </div>

      <main class="vendor-main">
        <router-outlet></router-outlet>
      </main>

      <nav class="vendor-bottom-nav">
        <a routerLink="route-home" routerLinkActive="active">
          <i class="pi pi-map"></i>
          <span>Mi ruta</span>
        </a>
        <a routerLink="close-route" routerLinkActive="active">
          <i class="pi pi-receipt"></i>
          <span>Cierre</span>
        </a>
        <a routerLink="carga" routerLinkActive="active">
          <i class="pi pi-truck"></i>
          <span>Carga</span>
        </a>
      </nav>

      <!-- Overlay de diagnóstico PWA (Ajustes → Diagnóstico PWA): la verdad del device -->
      <div class="diag-overlay" *ngIf="diagOpen()" (click)="closeDiag()">
        <div class="diag-panel" (click)="$event.stopPropagation()">
          <div class="diag-head">
            <b>Diagnóstico PWA</b>
            <span class="diag-actions">
              <button type="button" (click)="copyDiag()">{{ copied() ? '✓ Copiado' : 'Copiar' }}</button>
              <button type="button" (click)="closeDiag()">Cerrar</button>
            </span>
          </div>
          <div class="diag-key" *ngIf="diag() as d">
            <div>build <b>{{ d.build.commit }}</b> · {{ d.build.ts }}</div>
            <div>standalone <b [class.bad]="!d.displayMode.standalone_mq">{{ d.displayMode.standalone_mq }}</b></div>
            <div>safe-area bottom <b>{{ d.safeAreaInset.bottom }}</b></div>
            <div>nav gap <b [class.bad]="d.bottomNav && d.bottomNav.gapToScreenBottom > 2">{{ d.bottomNav?.gapToScreenBottom }}px</b></div>
            <div>innerH {{ d.viewport.innerH }} · screenH {{ d.viewport.screenH }} · dpr {{ d.viewport.dpr }}</div>
            <div>nav bg <b>{{ d.bgColors.nav }}</b> · pad-b <b>{{ d.navPaddingBottom }}</b></div>
            <div>viewport gap <b [class.bad]="d.bottomViewportGap > 2">{{ d.bottomViewportGap }}px</b></div>
            <div>borde inf: {{ d.elementAt.viewportBottom }}</div>
          </div>
          <pre class="diag-json">{{ diag() | json }}</pre>
        </div>
      </div>

      <!-- Guía de ubicación en segundo plano (onboarding + banner + ajustes) -->
      <div class="diag-overlay" *ngIf="bgHelpOpen()" (click)="bgHelpOpen.set(false)">
        <div class="diag-panel bg-help" (click)="$event.stopPropagation()">
          <div class="diag-head">
            <b>Ubicación en segundo plano</b>
            <span class="diag-actions"><button type="button" (click)="bgHelpOpen.set(false)">Cerrar</button></span>
          </div>
          <p class="bg-intro">Para que tu recorrido se siga registrando con la pantalla bloqueada, revisá estos 3 puntos en tu teléfono:</p>
          <ol class="bg-steps">
            <li><b>Permiso de ubicación:</b> elegí <b>"Permitir todo el tiempo"</b> (no solo "mientras se usa la app").</li>
            <li><b>Batería:</b> poné la app en <b>"Sin restricciones"</b> / desactivá el ahorro de batería para Vendedor.</li>
            <li><b>Inicio automático</b> (Xiaomi, Huawei, Oppo, Vivo, Honor): activá <b>"Autostart"</b> para esta app.</li>
          </ol>
          <button class="bg-cta" (click)="openLocationSettings()">
            <i class="pi pi-cog"></i>&nbsp;Abrir ajustes de la app
          </button>
          <p class="bg-note">En la pantalla de ajustes: <b>Permisos → Ubicación</b> y <b>Batería</b>. Después volvé a la app.</p>
          <p class="bg-diag" *ngIf="routePing.bgError() as err">Diagnóstico: <code>{{ err }}</code></p>
          <p class="bg-diag" *ngIf="!routePing.bgError() && routePing.bgActive()">Estado: rastreo en segundo plano <b>activo</b>.</p>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .vendor-shell {
        /* MODELO DE SCROLL DE DOCUMENTO (igual que apps/view/Trade): el <html>
           scrollea (overflow-y:scroll en styles.css). El shell solo fija el alto
           MÍNIMO (para que páginas cortas llenen) y el fondo — SIN height fijo ni
           overflow:hidden. Así iOS maneja las safe-areas como página normal y no
           queda la franja vacía abajo del patrón 100dvh. */
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
        background: var(--layout-bg);
      }
      .vendor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: max(0.75rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.75rem max(1rem, env(safe-area-inset-left));
        background: var(--card-bg);
        border-bottom: 1px solid var(--border-color);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .vendor-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 700;
        color: var(--brand-700);
      }
      .vendor-brand i { font-size: 1.25rem; }
      .vendor-user { display: flex; align-items: center; gap: 0.25rem; }
      .vendor-user a.header-active { color: var(--brand-700); }
      .vendor-main {
        flex: 1;
        /* El scroll lo lleva el DOCUMENTO (no main) → sin overflow propio. main
           solo crece con su contenido; flex:1 hace que llene el viewport en
           páginas cortas. padding-bottom reserva el alto de la bottom-nav (fixed)
           + la safe-area para que el último contenido no quede tapado. */
        padding: 1rem;
        padding-bottom: calc(5rem + env(safe-area-inset-bottom));
        max-width: 800px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
      }
      .vendor-bottom-nav {
        /* Fixed al fondo del viewport (modelo scroll-de-documento, como las tabs
           nativas iOS). Con el <html> scrolleando normal + viewport-fit=cover,
           bottom:0 llega al borde físico y el padding-bottom rellena la safe-area
           del home indicator — sin la franja vacía del patrón 100dvh. */
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        /* Fondo = el de la PÁGINA (no --card-bg): así la nav + la franja del
           home indicator se funden con el contenido y no se ve un bloque de
           otro tono ("borde") abajo. La separación la da solo el border-top. */
        background: var(--layout-bg);
        border-top: 1px solid var(--border-color);
        display: flex;
        justify-content: space-around;
        /* La BARRA reserva la safe-area con su propio padding-bottom:
           env(safe-area-inset-bottom) → su background llena la zona del home
           indicator hasta el borde físico. Requiere viewport-fit=cover (index.html). */
        padding: 0 0 env(safe-area-inset-bottom);
        z-index: 10;
        box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.04);
      }
      .vendor-bottom-nav a {
        flex: 1;
        max-width: 110px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.125rem;
        justify-content: center;
        text-decoration: none;
        color: var(--text-muted);
        /* La safe-area la reserva la barra (padding-bottom: env) → acá padding
           normal. El ícono/label queda arriba de la zona del home indicator. */
        padding: 0.6rem 0.25rem;
        font-size: 0.72rem;
        white-space: nowrap;
      }
      .vendor-bottom-nav a i { font-size: 1.4rem; }
      .vendor-bottom-nav a.active {
        color: var(--brand-700);
        font-weight: 600;
      }

      /* Panel de configuración */
      .settings-backdrop { position: fixed; inset: 0; z-index: 40; }
      .settings-panel {
        position: fixed; top: calc(env(safe-area-inset-top) + 3.4rem); right: max(0.75rem, env(safe-area-inset-right));
        z-index: 41; min-width: 13.5rem; background: var(--card-bg); border: 1px solid var(--border-color);
        border-radius: var(--r-md, 12px); box-shadow: 0 14px 34px -10px rgba(0,0,0,0.4); padding: 0.35rem;
        display: flex; flex-direction: column; gap: 0.15rem; animation: setpop 0.14s var(--ease, ease);
      }
      .settings-panel .set-row {
        display: flex; align-items: center; gap: 0.65rem; width: 100%; border: none; background: none;
        color: var(--text-main); padding: 0.65rem 0.6rem; border-radius: var(--r-sm, 8px); text-align: left;
        font-family: var(--font-body); font-size: 0.9rem; font-weight: 600; cursor: pointer;
      }
      .settings-panel .set-row:active { background: var(--surface-ground); }
      .settings-panel .set-row > .pi { width: 1.25rem; text-align: center; color: var(--text-muted); font-size: 1rem; }
      .settings-panel .set-row .lbl { flex: 1; }
      .settings-panel .set-row.danger { color: var(--bad-fg); }
      .settings-panel .set-row.danger > .pi { color: var(--bad-fg); }
      .settings-panel .switch { width: 2.2rem; height: 1.3rem; border-radius: 999px; background: var(--border-color); position: relative; transition: background 0.15s var(--ease, ease); flex-shrink: 0; }
      .settings-panel .switch.on { background: var(--action); }
      .settings-panel .switch .knob { position: absolute; top: 0.15rem; left: 0.15rem; width: 1rem; height: 1rem; border-radius: 50%; background: #fff; transition: transform 0.15s var(--ease, ease); }
      .settings-panel .switch.on .knob { transform: translateX(0.9rem); }
      @keyframes setpop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

      /* Overlay de diagnóstico PWA */
      .diag-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.55); display: flex; align-items: flex-start; justify-content: center; padding: max(1rem, env(safe-area-inset-top)) 0.75rem max(1rem, env(safe-area-inset-bottom)); overflow-y: auto; }
      .diag-panel { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); max-width: 30rem; width: 100%; padding: 0.9rem; box-shadow: 0 18px 40px -12px rgba(0,0,0,0.5); }
      .diag-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; }
      .diag-head b { font-size: 0.95rem; color: var(--text-main); }
      .diag-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
      .diag-actions button { border: 1px solid var(--border-color); background: var(--surface-ground); color: var(--text-main); border-radius: var(--r-pill, 999px); padding: 0.35rem 0.7rem; font-size: 0.78rem; font-weight: 700; cursor: pointer; }
      .diag-key { display: flex; flex-direction: column; gap: 0.25rem; font-family: var(--font-mono, monospace); font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.6rem; }
      .diag-key b { color: var(--text-main); }
      .diag-key b.bad { color: var(--bad-fg, #dc2626); }
      .diag-json { font-family: var(--font-mono, monospace); font-size: 0.7rem; line-height: 1.35; color: var(--text-muted); background: var(--surface-ground); border-radius: var(--r-sm, 8px); padding: 0.6rem; white-space: pre-wrap; word-break: break-all; max-height: 50vh; overflow-y: auto; margin: 0; }
      @media (prefers-reduced-motion: reduce) { .settings-panel, .settings-panel .switch, .settings-panel .switch .knob { animation: none; transition: none; } }

      /* Banner de salud del tracking */
      .bg-banner {
        display: flex; align-items: center; gap: 0.55rem; width: 100%; border: 0; text-align: left; cursor: pointer;
        padding: 0.55rem max(0.9rem, env(safe-area-inset-left)) 0.55rem max(0.9rem, env(safe-area-inset-right));
        background: var(--warn-bg, #fffbeb); color: var(--warn-fg, #92400e);
        border-bottom: 1px solid var(--warn-border, #fde68a); font-family: var(--font-body); font-size: 0.78rem; line-height: 1.3;
      }
      .bg-banner > .pi { font-size: 1rem; flex-shrink: 0; }
      .bg-banner u { text-underline-offset: 2px; font-weight: 700; }

      /* Guía de ubicación en segundo plano */
      .bg-help .bg-intro { font-size: 0.85rem; color: var(--text-main); margin: 0 0 0.7rem; line-height: 1.4; }
      .bg-steps { margin: 0 0 0.9rem; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
      .bg-steps li { font-size: 0.82rem; color: var(--text-muted); line-height: 1.4; }
      .bg-steps li b { color: var(--text-main); }
      .bg-cta {
        display: inline-flex; align-items: center; justify-content: center; width: 100%; border: 0; cursor: pointer;
        background: var(--action); color: #fff; border-radius: var(--r-md, 10px); padding: 0.7rem 1rem;
        font-family: var(--font-body); font-size: 0.9rem; font-weight: 700;
      }
      .bg-note { font-size: 0.74rem; color: var(--text-muted); margin: 0.6rem 0 0; line-height: 1.4; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly theme = inject(ThemeService);
  protected readonly routePing = inject(RoutePingService);
  readonly push = inject(PushService);
  private readonly toast = inject(MessageService);

  private static readonly BG_ONBOARD_KEY = 'vendorBgGeoOnboarded';

  readonly settingsOpen = signal(false);
  readonly pushBusy = signal(false);
  readonly diagOpen = signal(false);
  readonly diag = signal<DiagProbe | null>(null);
  readonly copied = signal(false);
  readonly bgHelpOpen = signal(false);

  constructor() {
    // Tracking de jornada: arranca al entrar al modo vendedor.
    this.routePing.startShift();
    // Onboarding one-time de ubicación en segundo plano (solo nativo): explica
    // los 3 ajustes que hacen que el GPS siga con la pantalla bloqueada.
    if (Capacitor.isNativePlatform() && !this.bgOnboarded()) {
      setTimeout(() => { this.bgHelpOpen.set(true); this.markBgOnboarded(); }, 1200);
    }
  }

  /** Pide permiso + suscribe a push (recordatorio de cierre de ruta). */
  async enablePush(): Promise<void> {
    if (this.pushBusy()) return;
    if (this.push.permission() === 'granted') {
      this.toast.add({ severity: 'info', summary: 'Avisos ya activados' });
      return;
    }
    this.pushBusy.set(true);
    const ok = await this.push.enable();
    this.pushBusy.set(false);
    this.toast.add(
      ok
        ? { severity: 'success', summary: 'Avisos activados', detail: 'Te recordaremos subir tu cierre.' }
        : { severity: 'warn', summary: 'No se activaron', detail: 'Permití las notificaciones en tu navegador.' },
    );
  }

  /** Abre la guía de ubicación en segundo plano (desde el banner o ajustes). */
  openBgHelp(): void {
    this.settingsOpen.set(false);
    this.bgHelpOpen.set(true);
  }

  /** Manda a los ajustes de la app (permisos / batería). */
  openLocationSettings(): void {
    void this.routePing.openSettings();
  }

  private bgOnboarded(): boolean {
    try { return localStorage.getItem(VendorShellComponent.BG_ONBOARD_KEY) === '1'; } catch { return false; }
  }
  private markBgOnboarded(): void {
    try { localStorage.setItem(VendorShellComponent.BG_ONBOARD_KEY, '1'); } catch { /* noop */ }
  }

  logout(): void {
    this.settingsOpen.set(false);
    this.routePing.endShift();
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }

  // ─── Diagnóstico PWA (la verdad del device: deploy-vs-cache + safe-area) ───
  openDiag(): void {
    this.settingsOpen.set(false);
    this.copied.set(false);
    // Esperar a que el settings-backdrop (fixed, inset:0) se desmonte ANTES de
    // leer: si no, elementFromPoint() lo golpea a él en vez del nav/fondo real.
    setTimeout(() => {
      this.diag.set(this.readProbes());
      this.diagOpen.set(true);
    }, 80);
  }

  closeDiag(): void {
    this.diagOpen.set(false);
  }

  copyDiag(): void {
    const txt = JSON.stringify(this.diag(), null, 2);
    navigator.clipboard?.writeText(txt).then(
      () => this.copied.set(true),
      () => void 0,
    );
  }

  private readProbes(): DiagProbe {
    // safe-area insets COMPUTADOS (no el token CSS): elemento sonda + getComputedStyle
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const safeAreaInset = {
      top: cs.paddingTop,
      right: cs.paddingRight,
      bottom: cs.paddingBottom,
      left: cs.paddingLeft,
    };
    probe.remove();

    const navEl = document.querySelector('.vendor-bottom-nav') as HTMLElement | null;
    const r = navEl?.getBoundingClientRect();
    const vv = (window as Window & { visualViewport?: VisualViewport }).visualViewport;
    const w = window as unknown as { __BUILD_VERSION__?: string; __BUILD_TIMESTAMP__?: string };

    // Colores computados + qué elemento hay en cada punto del fondo (decisivo:
    // dice si la "banda" es el respiro del nav, un hueco de viewport, o qué bg).
    const shellEl = document.querySelector('.vendor-shell');
    const mainEl = document.querySelector('.vendor-main');
    const navAnchor = navEl?.querySelector('a') as HTMLElement | null;
    const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : 'n/a');
    const at = (x: number, y: number): string => {
      const el = document.elementFromPoint(x, y);
      if (!el) return 'null (fuera del viewport)';
      const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} bg=${getComputedStyle(el).backgroundColor}`;
    };
    const cx = Math.round(window.innerWidth / 2);

    return {
      build: { commit: w.__BUILD_VERSION__ || 'n/a', ts: w.__BUILD_TIMESTAMP__ || 'n/a' },
      displayMode: {
        standalone_mq: window.matchMedia('(display-mode: standalone)').matches,
        navigator_standalone: (navigator as Navigator & { standalone?: boolean }).standalone ?? null,
      },
      safeAreaInset,
      viewport: {
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        screenW: screen.width,
        screenH: screen.height,
        dpr: window.devicePixelRatio,
      },
      visualViewport: vv
        ? { w: Math.round(vv.width), h: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop), offsetLeft: Math.round(vv.offsetLeft) }
        : null,
      bottomNav: r
        ? {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            height: Math.round(r.height),
            gapToScreenBottom: Math.round(window.innerHeight - r.bottom),
          }
        : null,
      bgColors: {
        html: bg(document.documentElement),
        body: bg(document.body),
        shell: bg(shellEl),
        nav: bg(navEl),
        main: bg(mainEl),
      },
      navPaddingBottom: navAnchor ? getComputedStyle(navAnchor).paddingBottom : 'n/a',
      bottomViewportGap: window.screen.height - window.innerHeight,
      elementAt: {
        navMid: r ? at(cx, Math.round((r.top + r.bottom) / 2)) : 'n/a',
        navBottom: r ? at(cx, Math.round(r.bottom) - 2) : 'n/a',
        viewportBottom: at(cx, window.innerHeight - 2),
      },
      ua: navigator.userAgent,
    };
  }
}
