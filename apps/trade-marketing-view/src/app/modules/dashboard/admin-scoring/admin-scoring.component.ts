import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { AdminScoringService } from './admin-scoring.service';

@Component({
  selector: 'app-admin-scoring',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    ToastModule,
    DialogModule,
    ConfirmDialogModule
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-scoring.component.html',
  styleUrls: ['./admin-scoring.component.css']
})
export class AdminScoringComponent implements OnInit {
  private scoringService = inject(AdminScoringService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);

  config = signal<any>(null);
  loading = signal<boolean>(false);
  saving = signal<boolean>(false);

  // Modal para agregar nueva llave
  showAddKeyDialog = false;
  newKeyName = '';
  activeSection = '';

  ngOnInit() {
    this.loadConfig();
  }

  loadConfig() {
    this.loading.set(true);
    this.scoringService.getConfig().subscribe({
      next: (cfg) => {
        // Normalización: Asegurar que tipos_exhibicion exista (fallback para datos legacy)
        if (cfg && !cfg.tipos_exhibicion && cfg.factores_tipo) {
          cfg.tipos_exhibicion = { ...cfg.factores_tipo };
        }
        this.config.set(cfg || { pesos_posicion: {}, tipos_exhibicion: {}, niveles_ejecucion: {} });
        this.loading.set(false);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la configuración' });
        this.loading.set(false);
      }
    });
  }

  saveConfig() {
    this.saving.set(true);
    this.scoringService.updateConfig(this.config()).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Configuración guardada correctamente' });
        this.saving.set(false);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar la configuración' });
        this.saving.set(false);
      }
    });
  }

  // --- Dynamic Keys Management ---

  openAddKeyDialog(section: string) {
    this.activeSection = section;
    this.newKeyName = '';
    this.showAddKeyDialog = true;
  }

  addKey() {
    const key = this.newKeyName.trim().toLowerCase();
    if (!key) return;

    const current = this.config();
    if (current && current[this.activeSection]) {
      if (current[this.activeSection][key] !== undefined) {
        this.messageService.add({ severity: 'warn', summary: 'Atención', detail: 'Esta categoría ya existe' });
        return;
      }
      
      // Valor por defecto: 1.0 para factores, 10 para pesos
      current[this.activeSection][key] = this.activeSection === 'pesos_posicion' ? 10 : 1.0;
      this.config.set({ ...current });
      this.showAddKeyDialog = false;
    }
  }

  removeKey(section: string, key: string) {
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar la categoría "${key}"? Esta acción no se puede deshacer.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        const current = this.config();
        if (current && current[section]) {
          delete current[section][key];
          this.config.set({ ...current });
          this.messageService.add({
            severity: 'success',
            summary: 'Eliminado',
            detail: `Categoría "${key}" eliminada correctamente`,
          });
        }
      },
      reject: () => {
        this.messageService.add({
          severity: 'info',
          summary: 'Cancelado',
          detail: 'Eliminación cancelada.',
        });
      }
    });
  }

  // --- Helpers ---

  objectKeys(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  updateValue(section: string, key: string, value: number) {
    const current = this.config();
    if (current && current[section]) {
      current[section][key] = value;
      this.config.set({ ...current });
    }
  }
}
