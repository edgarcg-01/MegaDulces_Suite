import { Injectable, effect, inject } from '@angular/core';
import { ThemeService } from './theme.service';

/**
 * Sincroniza la status bar del device (iOS / Android) con el theme actual.
 *
 *   - Theme light → status bar con texto oscuro sobre brand yellow.
 *   - Theme dark → status bar con texto claro sobre neutral-950.
 *
 * Solo activa en Capacitor native. En PWA web la barra del sistema no se
 * controla desde JS (el meta `theme-color` ya hace ese trabajo en el browser).
 *
 * Importación lazy del plugin para no afectar el bundle web.
 */
@Injectable({ providedIn: 'root' })
export class StatusBarService {
  private theme = inject(ThemeService);
  private plugin: any = null;
  private readonly isNative: boolean;

  constructor() {
    this.isNative =
      typeof window !== 'undefined' &&
      (window.location.protocol === 'capacitor:' ||
        !!(window as any).Capacitor?.isNativePlatform?.());
    if (this.isNative) {
      import('@capacitor/status-bar').then((m) => {
        this.plugin = m;
        this.applyTheme(this.theme.isMonochrome());
      }).catch(() => {});
    }

    effect(() => {
      const dark = this.theme.isMonochrome();
      if (this.isNative && this.plugin) this.applyTheme(dark);
    });
  }

  private async applyTheme(isDark: boolean) {
    if (!this.plugin) return;
    try {
      const { StatusBar, Style } = this.plugin;
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      // Android only: setBackgroundColor. iOS lo ignora silenciosamente.
      await StatusBar.setBackgroundColor({
        color: isDark ? '#09090B' : '#FDE707',
      });
    } catch {
      // no-op
    }
  }
}
