import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class PwaInstallService {
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private installPromptSource = new Subject<boolean>();
  public installPrompt$ = this.installPromptSource.asObservable();

  constructor() {
    this.setupInstallPrompt();
  }

  private setupInstallPrompt(): void {
    window.addEventListener('beforeinstallprompt', (e) => {
      // Prevenir el prompt automático
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      
      // Mostrar el prompt personalizado después de un pequeño retraso
      setTimeout(() => {
        this.installPromptSource.next(true);
      }, 3000);
    });

    window.addEventListener('appinstalled', () => {
      console.log('[PWA] App instalada exitosamente');
      this.deferredPrompt = null;
      this.installPromptSource.next(false);
    });
  }

  async installPWA(): Promise<{ success: boolean; message: string }> {
    if (!this.deferredPrompt) {
      return {
        success: false,
        message: 'No hay instalación pendiente o la app ya está instalada'
      };
    }

    try {
      // Mostrar el prompt de instalación
      await this.deferredPrompt.prompt();
      
      // Esperar la respuesta del usuario
      const { outcome } = await this.deferredPrompt.userChoice;
      
      if (outcome === 'accepted') {
        console.log('[PWA] Usuario aceptó la instalación');
        return {
          success: true,
          message: 'Instalación iniciada correctamente'
        };
      } else {
        console.log('[PWA] Usuario rechazó la instalación');
        return {
          success: false,
          message: 'Instalación cancelada por el usuario'
        };
      }
    } catch (error) {
      console.error('[PWA] Error durante la instalación:', error);
      return {
        success: false,
        message: 'Error durante la instalación'
      };
    } finally {
      this.deferredPrompt = null;
      this.installPromptSource.next(false);
    }
  }

  dismissInstallPrompt(): void {
    this.deferredPrompt = null;
    this.installPromptSource.next(false);
    
    // Ocultar/remover el prompt visualmente
    const prompt = document.querySelector('.pwa-install-prompt');
    if (prompt) {
      prompt.classList.add('hide');
      setTimeout(() => {
        if (prompt.parentElement) {
          prompt.remove();
        }
      }, 300);
    }
  }

  canInstall(): boolean {
    return this.deferredPrompt !== null;
  }

  isInstalled(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches ||
           (window.navigator as any).standalone === true ||
           document.referrer.includes('android-app://');
  }

  getInstallInfo(): {
    canInstall: boolean;
    isInstalled: boolean;
    isStandalone: boolean;
    platform: string;
  } {
    return {
      canInstall: this.canInstall(),
      isInstalled: this.isInstalled(),
      isStandalone: this.isStandalone(),
      platform: this.getPlatform()
    };
  }

  private isStandalone(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches ||
           (window.navigator as any).standalone === true;
  }

  private getPlatform(): string {
    const userAgent = navigator.userAgent.toLowerCase();
    
    if (userAgent.includes('android')) {
      return 'Android';
    } else if (userAgent.includes('iphone') || userAgent.includes('ipad')) {
      return 'iOS';
    } else if (userAgent.includes('win')) {
      return 'Windows';
    } else if (userAgent.includes('mac')) {
      return 'macOS';
    } else if (userAgent.includes('linux')) {
      return 'Linux';
    }
    
    return 'Unknown';
  }

  // Métodos para mostrar notificaciones de instalación
  showInstallNotification(): void {
    if (this.canInstall() && !this.isInstalled()) {
      // Crear notificación personalizada
      this.createInstallPrompt();
    }
  }

  private createInstallPrompt(): void {
    // Eliminar prompt existente si hay uno
    const existingPrompt = document.querySelector('.pwa-install-prompt');
    if (existingPrompt) {
      existingPrompt.remove();
    }

    // Crear nuevo prompt
    const prompt = document.createElement('div');
    prompt.className = 'pwa-install-prompt';

    // Crear contenido
    const content = document.createElement('div');
    content.className = 'pwa-install-prompt-content';

    const title = document.createElement('div');
    title.className = 'pwa-install-prompt-title';
    title.textContent = '📱 Instalar Trade Marketing';

    const text = document.createElement('div');
    text.className = 'pwa-install-prompt-text';
    text.textContent = 'Instala esta app para acceder más rápido.';

    content.appendChild(title);
    content.appendChild(text);

    // Crear botones
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'pwa-install-prompt-buttons';

    const installBtn = document.createElement('button');
    installBtn.className = 'install-btn';
    installBtn.textContent = 'Instalar';
    installBtn.addEventListener('click', () => this.installPWA());

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'dismiss-btn';
    dismissBtn.textContent = 'Ahora no';
    dismissBtn.addEventListener('click', () => this.dismissInstallPrompt());

    buttonsDiv.appendChild(installBtn);
    buttonsDiv.appendChild(dismissBtn);

    prompt.appendChild(content);
    prompt.appendChild(buttonsDiv);

    // Agregar al DOM
    document.body.appendChild(prompt);

    // Auto-ocultar después de 30 segundos
    setTimeout(() => {
      if (prompt.parentElement) {
        prompt.classList.add('hide');
        setTimeout(() => {
          if (prompt.parentElement) {
            prompt.remove();
          }
        }, 300);
      }
    }, 30000);
  }

  // Método para verificar si el navegador soporta PWA
  isPwaSupported(): boolean {
    return 'serviceWorker' in navigator && 
           'PushManager' in window && 
           'Notification' in window &&
           'beforeinstallprompt' in window;
  }

  // Obtener información del dispositivo para personalizar la experiencia
  getDeviceInfo(): {
    platform: string;
    isMobile: boolean;
    isTablet: boolean;
    isDesktop: boolean;
    supportsPWA: boolean;
    connectionType?: string;
    effectiveConnectionType?: string;
  } {
    const userAgent = navigator.userAgent.toLowerCase();
    const connection = (navigator as any).connection || 
                      (navigator as any).mozConnection || 
                      (navigator as any).webkitConnection;

    const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
    const isTablet = /ipad|android(?!.*mobile)/i.test(userAgent);
    const isDesktop = !isMobile && !isTablet;

    return {
      platform: this.getPlatform(),
      isMobile,
      isTablet,
      isDesktop,
      supportsPWA: this.isPwaSupported(),
      connectionType: connection?.type,
      effectiveConnectionType: connection?.effectiveType
    };
  }

  // Solicitar permisos para notificaciones push (futuro)
  async requestNotificationPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) {
      console.warn('[PWA] Este navegador no soporta notificaciones');
      return 'denied';
    }

    if (Notification.permission === 'granted') {
      return 'granted';
    }

    if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      return permission;
    }

    return Notification.permission;
  }

  // Suscribirse a notificaciones push (futuro)
  async subscribeToPushNotifications(): Promise<{
    success: boolean;
    subscription?: PushSubscription;
    message: string;
  }> {
    try {
      const registration = await navigator.serviceWorker.ready;
      
      if (!registration.pushManager) {
        return {
          success: false,
          message: 'Push notifications no soportadas'
        };
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array('TU_PUBLIC_VAPID_KEY')
      });

      return {
        success: true,
        subscription,
        message: 'Suscrito a notificaciones push exitosamente'
      };
    } catch (error) {
      console.error('[PWA] Error suscribiendo a push notifications:', error);
      return {
        success: false,
        message: 'Error al suscribirse a notificaciones push'
      };
    }
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }
}
