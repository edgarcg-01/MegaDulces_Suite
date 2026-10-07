import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { TelemetryService } from '../telemetry/telemetry.service';

/** Evento beforeinstallprompt (no está en los tipos estándar del DOM). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const UPDATE_CHECK_MS = 60 * 60 * 1000; // 1h

/**
 * Núcleo PWA del portal (Fase 1).
 *
 *  - Update flow: detecta nueva versión del service worker (SwUpdate) y expone
 *    `updateReady` para que un banner ofrezca recargar. Sin esto los usuarios
 *    quedan atorados en una versión vieja del SW indefinidamente.
 *  - Install UX: captura `beforeinstallprompt` (Chromium) y lo difiere para
 *    dispararlo en el momento de máximo engagement (ej. tras confirmar pedido)
 *    vía `promptInstall()`. En iOS no existe el evento → exponemos `isIos`/
 *    `isStandalone` para mostrar instrucciones de "Agregar a inicio".
 *
 * En dev el SW está deshabilitado → `swUpdate.isEnabled` es false y la parte de
 * updates es no-op (la captura de install sí corre).
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly telemetry = inject(TelemetryService);

  /** Hay una nueva versión lista para activar. */
  readonly updateReady = signal(false);
  /** El navegador ofrece instalar (Chromium, criterios PWA cumplidos). */
  readonly canInstall = signal(false);

  readonly isIos = this.detectIos();
  /** Ya corre como app instalada (standalone) → no ofrecer instalar. */
  readonly isStandalone = this.detectStandalone();

  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private started = false;

  init(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    // ── Updates ──
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => {
          this.updateReady.set(true);
          this.telemetry.track('pwa_update_ready');
        });
      // Chequeo periódico (además del de arranque) por si la pestaña queda abierta horas.
      setInterval(() => this.swUpdate.checkForUpdate().catch(() => void 0), UPDATE_CHECK_MS);
    }

    // ── Install ──
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault(); // diferimos: lo disparamos nosotros en buen momento
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      if (!this.isStandalone) this.canInstall.set(true);
      this.telemetry.track('pwa_installable');
    });
    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.canInstall.set(false);
      this.telemetry.track('pwa_installed');
    });
  }

  /** Activa la nueva versión y recarga. */
  async applyUpdate(): Promise<void> {
    try {
      await this.swUpdate.activateUpdate();
    } finally {
      document.location.reload();
    }
  }

  /**
   * Dispara el prompt nativo de instalación (Chromium). Devuelve el resultado.
   * Llamar en un gesto del usuario (click), idealmente tras un momento de valor
   * (ej. pedido confirmado). En iOS no aplica (usar las instrucciones).
   */
  async promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!this.deferredPrompt) return 'unavailable';
    const ev = this.deferredPrompt;
    ev.prompt();
    const { outcome } = await ev.userChoice;
    this.telemetry.track('pwa_install_choice', { outcome });
    this.deferredPrompt = null;
    this.canInstall.set(false);
    return outcome;
  }

  private detectIos(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ se reporta como Mac con touch.
    const iPadOs = /Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document;
    return iOS || iPadOs;
  }

  private detectStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  }
}
