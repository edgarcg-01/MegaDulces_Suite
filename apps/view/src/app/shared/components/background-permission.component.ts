import { Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { TrackingService } from '../../core/services/tracking.service';

@Component({
  selector: 'app-background-permission',
  standalone: true,
  imports: [CommonModule, DialogModule, ButtonModule],
  template: `
    <p-dialog
      [(visible)]="visible"
      [modal]="true"
      [closable]="false"
      [style]="{width: '90vw', maxWidth: '450px'}"
      header="Permisos de Ubicación"
    >
      <div class="permission-content">
        <div class="icon-header">
          <i class="pi pi-map-marker" style="font-size: 3rem; color: var(--action)"></i>
        </div>

        <h3>Rastreo en segundo plano</h3>
        <p>
          Para que el seguimiento de tu ruta funcione correctamente mientras la pantalla está apagada o usas otras apps,
          necesitamos que concedas el permiso de ubicación <strong>"Permitir todo el tiempo"</strong>.
        </p>

        <div class="steps">
          <div class="step">
            <span class="step-num">1</span>
            <span>Toca "Continuar" y selecciona <strong>"Mientras la app está en uso"</strong>.</span>
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <span>Luego, selecciona <strong>"Permitir todo el tiempo"</strong> en la configuración del sistema.</span>
          </div>
        </div>

        <div class="footer-actions">
          <button pButton label="Más tarde" class="p-button-text" (click)="onCancel()" [disabled]="requesting()"></button>
          <button pButton [label]="buttonLabel()" (click)="onRequest()" [loading]="requesting()"></button>
        </div>
      </div>

      <style>
        .permission-content { text-align: center; padding: 1rem; }
        .icon-header { margin-bottom: 1.5rem; }
        h3 { margin-bottom: 1rem; font-weight: 700; }
        p { color: var(--c-text-2); line-height: 1.5; margin-bottom: 1.5rem; }
        .steps { text-align: left; background: var(--c-surface-2); padding: 1rem; border-radius: 12px; margin-bottom: 2rem; }
        .step { display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
        .step:last-child { margin-bottom: 0; }
        .step-num {
          background: var(--action);
          color: white;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.75rem;
          flex-shrink: 0;
          margin-top: 2px;
        }
        .footer-actions { display: flex; justify-content: flex-end; gap: 1rem; }
      </style>
    </p-dialog>
  `
})
export class BackgroundPermissionComponent {
  private tracking = inject(TrackingService);

  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() granted = new EventEmitter<void>();

  requesting = signal(false);
  step = signal(1); // 1: Foreground, 2: Background

  buttonLabel = computed(() => this.step() === 1 ? 'Continuar' : 'Abrir Configuración');

  onCancel() {
    this.visible = false;
    this.visibleChange.emit(false);
  }

  async onRequest() {
    this.requesting.set(true);
    try {
      if (this.step() === 1) {
        const ok = await this.tracking.requestPermissions();
        if (ok) {
          this.step.set(2);
        }
      } else {
        await this.tracking.openSettings();
        // Al volver de settings, el usuario debería haberlo activado
        this.onCancel();
      }
    } finally {
      this.requesting.set(false);
    }
  }
}
