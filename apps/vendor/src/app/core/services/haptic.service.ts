import { Injectable } from '@angular/core';

/**
 * Wrapper sobre `@capacitor/haptics`. En web puro no-op; en Capacitor native
 * (iOS / Android) ejecuta el feedback táctil correspondiente.
 *
 * Patrón de uso:
 *   - `selection()`: cambio de selección (toggle, picker scroll). Más suave.
 *   - `impact('light' | 'medium' | 'heavy')`: confirmación de tap / botón. Es el
 *     que más se usa: light para acciones triviales, medium para CTAs, heavy
 *     para destrucciones.
 *   - `notification('success' | 'warning' | 'error')`: triple-tap distintivo
 *     para feedback de resultado de acción (post submit).
 *
 * Convención del proyecto:
 *   - Submit OK → `notification('success')`
 *   - Submit FAIL → `notification('error')`
 *   - Botón CTA primario → `impact('medium')`
 *   - Botón secundario / icon button → `impact('light')`
 *   - Toggle / checkbox / segmented → `selection()`
 *
 * La importación de `@capacitor/haptics` es **lazy via dynamic import** para
 * no engordar el bundle web con código que ni se ejecuta fuera de native.
 */
@Injectable({ providedIn: 'root' })
export class HapticService {
  private hapticsModule: any = null;
  private readonly isNative: boolean;

  constructor() {
    this.isNative =
      typeof window !== 'undefined' &&
      (window.location.protocol === 'capacitor:' ||
        !!(window as any).Capacitor?.isNativePlatform?.());
    if (this.isNative) {
      // Lazy load; ignora errores si el plugin no está disponible.
      import('@capacitor/haptics')
        .then((m) => (this.hapticsModule = m))
        .catch(() => (this.hapticsModule = null));
    }
  }

  async impact(style: 'light' | 'medium' | 'heavy' = 'light'): Promise<void> {
    if (!this.isNative || !this.hapticsModule) return;
    try {
      const { Haptics, ImpactStyle } = this.hapticsModule;
      const map = {
        light: ImpactStyle.Light,
        medium: ImpactStyle.Medium,
        heavy: ImpactStyle.Heavy,
      };
      await Haptics.impact({ style: map[style] });
    } catch {
      // no-op
    }
  }

  async notification(
    type: 'success' | 'warning' | 'error',
  ): Promise<void> {
    if (!this.isNative || !this.hapticsModule) return;
    try {
      const { Haptics, NotificationType } = this.hapticsModule;
      const map = {
        success: NotificationType.Success,
        warning: NotificationType.Warning,
        error: NotificationType.Error,
      };
      await Haptics.notification({ type: map[type] });
    } catch {
      // no-op
    }
  }

  async selection(): Promise<void> {
    if (!this.isNative || !this.hapticsModule) return;
    try {
      await this.hapticsModule.Haptics.selectionStart();
      await this.hapticsModule.Haptics.selectionEnd();
    } catch {
      // no-op
    }
  }
}
