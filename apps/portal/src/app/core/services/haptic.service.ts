import { Injectable } from '@angular/core';

/**
 * Versión WEB del haptic service. El portal standalone NO usa Capacitor, así que
 * acá usamos la Vibration API del browser donde exista (Android/Chrome); en el
 * resto es no-op. Misma API pública que la versión nativa del monorepo, para que
 * los componentes del portal no cambien.
 */
@Injectable({ providedIn: 'root' })
export class HapticService {
  private vibrate(pattern: number | number[]): void {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        (navigator as Navigator & { vibrate(p: number | number[]): boolean }).vibrate(pattern);
      }
    } catch {
      // no-op
    }
  }

  async impact(style: 'light' | 'medium' | 'heavy' = 'light'): Promise<void> {
    this.vibrate(style === 'heavy' ? 20 : style === 'medium' ? 12 : 6);
  }

  async notification(type: 'success' | 'warning' | 'error'): Promise<void> {
    this.vibrate(type === 'error' ? [8, 40, 8] : type === 'warning' ? [8, 30] : 10);
  }

  async selection(): Promise<void> {
    this.vibrate(4);
  }
}
