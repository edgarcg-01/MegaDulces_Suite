import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OfflineBannerComponent } from './core/connectivity/offline-banner.component';
import { PwaUpdateBannerComponent } from './core/pwa/pwa-update-banner.component';
import { PwaInstallPromptComponent } from './core/pwa/pwa-install-prompt.component';
import { PushPromptComponent } from './core/pwa/push-prompt.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    OfflineBannerComponent,
    PwaUpdateBannerComponent,
    PwaInstallPromptComponent,
    PushPromptComponent,
  ],
  template: `
    <router-outlet></router-outlet>
    <app-offline-banner></app-offline-banner>
    <app-pwa-update-banner></app-pwa-update-banner>
    <app-pwa-install-prompt></app-pwa-install-prompt>
    <app-push-prompt></app-push-prompt>
  `,
})
export class AppComponent {}
