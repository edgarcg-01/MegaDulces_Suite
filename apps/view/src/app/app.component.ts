import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PwaInstallService } from './core/services/pwa-install.service';
import { ConfirmDialogModule } from 'primeng/confirmdialog';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ConfirmDialogModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'frontend';
  private pwaInstallService = inject(PwaInstallService);

  ngOnInit() {
    this.setupPwaInstall();
  }

  ngOnDestroy() {
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


}
