import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PwaInstallService } from './core/services/pwa-install.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'frontend';
  private pwaInstallService = inject(PwaInstallService);
  private swUpdateInterval: any;

  ngOnInit() {
    // Setup PWA installation prompt
    this.setupPwaInstall();
    
    // Start periodic service worker update check (every 14 minutes)
    this.startSwUpdateCheck();
  }

  ngOnDestroy() {
    // Clear interval when component is destroyed
    if (this.swUpdateInterval) {
      clearInterval(this.swUpdateInterval);
    }
  }

  private setupPwaInstall(): void {
    // Subscribe to install prompt events
    this.pwaInstallService.installPrompt$.subscribe(canShow => {
      if (canShow) {
        console.log('[AppComponent] PWA install prompt available');
        this.pwaInstallService.showInstallNotification();
      }
    });

    // Log PWA info for debugging
    const pwaInfo = this.pwaInstallService.getInstallInfo();
    console.log('[AppComponent] PWA Info:', pwaInfo);

    // Log device info
    const deviceInfo = this.pwaInstallService.getDeviceInfo();
    console.log('[AppComponent] Device Info:', deviceInfo);
  }

  private startSwUpdateCheck(): void {
    // Check for service worker updates every 14 minutes (840000 ms)
    this.swUpdateInterval = setInterval(() => {
      this.checkServiceWorkerUpdate();
    }, 14 * 60 * 1000);

    // Initial check
    this.checkServiceWorkerUpdate();
  }

  private async checkServiceWorkerUpdate(): Promise<void> {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          console.log('[AppComponent] Checking for service worker updates...');
          await registration.update();
          
          // Send message to service worker to skip waiting if new version found
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[AppComponent] New service worker available, prompting user');
                  if (confirm('Una nueva versión está disponible. ¿Recargar la aplicación?')) {
                    // Send message to skip waiting
                    newWorker.postMessage({ type: 'SKIP_WAITING' });
                    window.location.reload();
                  }
                }
              });
            }
          });
        }
      } catch (error) {
        console.error('[AppComponent] Error checking service worker update:', error);
      }
    }
  }
}
