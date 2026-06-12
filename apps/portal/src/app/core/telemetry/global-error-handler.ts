import { ErrorHandler, Injectable, inject } from '@angular/core';
import { TelemetryService } from './telemetry.service';

/**
 * ErrorHandler global: captura toda excepción no manejada de Angular y la manda
 * a telemetría antes de re-loguearla. Sin esto los errores morían en consola y
 * nadie se enteraba (gap del review CEO).
 *
 * También engancha `unhandledrejection` (promesas rechazadas sin catch), que el
 * ErrorHandler de Angular NO captura por sí solo.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly telemetry = inject(TelemetryService);
  private rejectionHooked = false;

  constructor() {
    if (typeof window !== 'undefined' && !this.rejectionHooked) {
      this.rejectionHooked = true;
      window.addEventListener('unhandledrejection', (e) => {
        this.telemetry.trackError('unhandledrejection', {
          message: this.describe(e.reason),
        });
      });
    }
  }

  handleError(error: unknown): void {
    this.telemetry.trackError('uncaught', {
      message: this.describe(error),
      stack: this.stackOf(error),
    });
    // Mantener el comportamiento default: que el dev lo vea en consola.
    console.error(error);
  }

  private describe(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err)?.slice(0, 500) ?? String(err);
    } catch {
      return String(err);
    }
  }

  private stackOf(err: unknown): string | undefined {
    return err instanceof Error ? err.stack?.slice(0, 2000) : undefined;
  }
}
