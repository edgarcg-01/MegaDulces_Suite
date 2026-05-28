import { Injectable, signal } from '@angular/core';

const THEME_STORAGE_KEY = 'tradeMarketingThemeMode';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private _isMonochrome = signal<boolean>(false);
  readonly isMonochrome = this._isMonochrome.asReadonly();

  constructor() {
    const savedTheme = this.getSavedTheme();
    if (savedTheme !== null) {
      this._isMonochrome.set(savedTheme);
      this.updateBodyClass(savedTheme);
    }
  }

  toggleMonochrome() {
    this._isMonochrome.update(v => {
      const next = !v;
      this.saveTheme(next);
      this.updateBodyClass(next);
      return next;
    });
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
  }
}
