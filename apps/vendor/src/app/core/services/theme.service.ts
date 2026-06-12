import { Injectable, signal } from '@angular/core';

const THEME_STORAGE_KEY = 'tradeMarketingThemeMode';
const THEME_USER_CHOICE_KEY = 'tradeMarketingThemeUserChoice';

/**
 * ThemeService — controla light vs dark (interno: `theme-monochrome`).
 *
 * Resolución de tema al boot:
 *   1. Si el usuario eligió manualmente alguna vez (`THEME_USER_CHOICE_KEY=true`),
 *      respetamos su última elección persistida (`THEME_STORAGE_KEY`).
 *   2. Sino, seguimos `prefers-color-scheme: dark` del sistema.
 *
 * Al cambiar el sistema (`matchMedia('change')`), el theme se actualiza solo
 * SI el usuario no ha tocado el toggle. Una vez que toggleó manual, ignoramos
 * el sistema — patrón estándar (Twitter, Google, Apple).
 */
@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private _isMonochrome = signal<boolean>(false);
  readonly isMonochrome = this._isMonochrome.asReadonly();

  private _followingSystem = signal<boolean>(true);
  readonly followingSystem = this._followingSystem.asReadonly();

  private userOverride = false;

  constructor() {
    this.userOverride = this.getUserChoice();
    this._followingSystem.set(!this.userOverride);
    const initial = this.userOverride
      ? this.getSavedTheme() ?? this.systemPrefersDark()
      : this.systemPrefersDark();
    this._isMonochrome.set(initial);
    this.updateBodyClass(initial);

    this.watchSystemPreference();
  }

  toggleMonochrome() {
    this._isMonochrome.update(v => {
      const next = !v;
      this.userOverride = true;
      this._followingSystem.set(false);
      this.saveUserChoice();
      this.saveTheme(next);
      this.updateBodyClass(next);
      return next;
    });
  }

  /** Forzar un modo específico (light/dark) — siempre marca override. */
  setMonochrome(value: boolean) {
    this.userOverride = true;
    this._followingSystem.set(false);
    this.saveUserChoice();
    this.saveTheme(value);
    this._isMonochrome.set(value);
    this.updateBodyClass(value);
  }

  /** Resetea la elección manual: vuelve a seguir el sistema. */
  resetToSystem() {
    this.userOverride = false;
    this._followingSystem.set(true);
    try { localStorage.removeItem(THEME_USER_CHOICE_KEY); } catch {}
    try { localStorage.removeItem(THEME_STORAGE_KEY); } catch {}
    const sys = this.systemPrefersDark();
    this._isMonochrome.set(sys);
    this.updateBodyClass(sys);
  }

  private systemPrefersDark(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  private watchSystemPreference() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      if (this.userOverride) return;
      this._isMonochrome.set(e.matches);
      this.updateBodyClass(e.matches);
    };
    if (mq.addEventListener) {
      mq.addEventListener('change', handler);
    } else if ((mq as any).addListener) {
      (mq as any).addListener(handler);
    }
  }

  private saveTheme(isMonochrome: boolean) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(isMonochrome));
    } catch {
      // Ignore storage errors for browsers with storage disabled
    }
  }

  private getSavedTheme(): boolean | null {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private saveUserChoice() {
    try { localStorage.setItem(THEME_USER_CHOICE_KEY, 'true'); } catch {}
  }

  private getUserChoice(): boolean {
    try { return localStorage.getItem(THEME_USER_CHOICE_KEY) === 'true'; } catch { return false; }
  }

  private updateBodyClass(isMonochrome: boolean) {
    // PrimeNG v18 Aura aplica dark mode buscando `darkModeSelector` en el
    // documentElement (html). El resto del CSS custom del proyecto usa
    // `body.theme-monochrome`. Para que ambos funcionen, ponemos la clase
    // en los DOS. Sin html, las p-card / p-dialog / p-table de PrimeNG
    // quedan blancas sobre fondo negro (vivido 2026-05-27).
    const root = document.documentElement;
    if (isMonochrome) {
      document.body.classList.add('theme-monochrome');
      root.classList.add('theme-monochrome');
    } else {
      document.body.classList.remove('theme-monochrome');
      root.classList.remove('theme-monochrome');
    }
    this.updateThemeColorMeta(isMonochrome);
  }

  /**
   * Sincroniza `<meta name="theme-color">` con el tema de la APP (no el del
   * sistema). Sin esto, iOS pinta el chrome del PWA (status bar + franja del
   * home indicator) según `prefers-color-scheme` del SO: si el iPhone está en
   * claro pero la app forzada a oscuro, salía una línea amarilla (#FDE707)
   * debajo del bottom nav. Eliminamos las variantes con `media=` del index.html
   * y dejamos un único meta dinámico que matchea el tema real de la app.
   */
  private updateThemeColorMeta(isMonochrome: boolean) {
    if (typeof document === 'undefined') return;
    // Fuente única: el chrome del SO (status bar + nav bar del PWA) matchea la
    // superficie real de la app leyendo `--card-bg` (= color del header/bottom-nav).
    // Derivarlo del token en vez de hardcodear evita que tema, meta y manifest se
    // desincronicen y reaparezca el "margen negro". Fallback a literales si falla.
    const color = this.readSurfaceColor() || (isMonochrome ? '#16130F' : '#FFFFFF');
    document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
      if (el.getAttribute('media')) el.remove();
    });
    let meta = document.querySelector(
      'meta[name="theme-color"]:not([media])',
    ) as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', color);
  }

  /** Color de la superficie de chrome (header/bottom-nav) para que las barras del
   *  SO matcheen la app. Lee `--card-bg` del body (ya tiene la clase de tema aplicada). */
  private readSurfaceColor(): string {
    try {
      return getComputedStyle(document.body).getPropertyValue('--card-bg').trim();
    } catch {
      return '';
    }
  }
}
