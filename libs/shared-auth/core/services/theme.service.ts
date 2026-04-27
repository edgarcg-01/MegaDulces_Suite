import { Injectable, signal } from '@angular/core';

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
      localStorage.setItem('sharedAuthThemeMode', JSON.stringify(isMonochrome));
    } catch {
      // Ignore storage errors for browsers with storage disabled
    }
  }

  private getSavedTheme(): boolean | null {
    try {
      const raw = localStorage.getItem('sharedAuthThemeMode');
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private updateBodyClass(isMonochrome: boolean) {
    if (isMonochrome) {
      document.body.classList.add('theme-monochrome');
    } else {
      document.body.classList.remove('theme-monochrome');
    }
  }
}
