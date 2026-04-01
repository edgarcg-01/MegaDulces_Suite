import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule }    from '@angular/common';
import { FormsModule }     from '@angular/forms';

// PrimeNG
import { ButtonModule }        from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule }        from 'primeng/dialog';
import { InputNumberModule }   from 'primeng/inputnumber';
import { SelectModule }        from 'primeng/select';
import { TableModule }         from 'primeng/table';
import { TagModule }           from 'primeng/tag';
import { ToastModule }         from 'primeng/toast';
import { CheckboxModule }      from 'primeng/checkbox';
import { RadioButtonModule }   from 'primeng/radiobutton';
import { ConfirmationService, MessageService } from 'primeng/api';

// Spartan
import { HlmBadgeDirective }  from '@spartan-ng/helm/badge';
import { HlmButtonDirective } from '@spartan-ng/helm/button';
import { HlmInputDirective }  from '@spartan-ng/helm/input';
import { HlmLabelDirective }  from '@spartan-ng/helm/label';

// Local
import { DailyCaptureService } from './daily-capture.service';
import { VisitaSnapshot, RANGOS_COMPRA, RegistroExhibicion } from './daily-capture.models';

@Component({
  selector: 'app-daily-capture',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule,
    // PrimeNG
    ButtonModule, ConfirmDialogModule, DialogModule, InputNumberModule,
    SelectModule, TableModule, TagModule, ToastModule, CheckboxModule, RadioButtonModule,
    // Spartan
    HlmBadgeDirective, HlmButtonDirective, HlmInputDirective, HlmLabelDirective,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './captures.component.html',
})
export class CapturesComponent implements OnInit {

  readonly svc         = inject(DailyCaptureService);
  readonly toast       = inject(MessageService);
  readonly confirmSvc  = inject(ConfirmationService);

  // ── Initialization ───────────────────────────────────────────────────────
  ngOnInit() {
    this.svc.refreshAll();
  }

  // ── Constants & Catalogs ──────────────────────────────────────────────────
  readonly RANGOS_COMPRA = RANGOS_COMPRA;

  // ── UI State ──────────────────────────────────────────────────────────────
  showResultDialog = false;
  lastResult: VisitaSnapshot | null = null;
  expandedRows: { [key: string]: boolean } = {};

  // ── Wizard State ──────────────────────────────────────────────────────────
  showWizard = false;
  wizardStep = 1;

  currentExhibicion = signal<Partial<RegistroExhibicion>>({
    productosMarcados: []
  });

  // ── Computed ──────────────────────────────────────────────────────────────
  visitaNumero = computed(() => this.svc.visitasHoy().length + 1);

  statCards = computed(() => {
    const s = this.svc.stats();
    return [
      {
        label:       'Exhibidores Registrados',
        value:       s.totalExhibiciones.toString(),
        description: 'En esta visita',
        icon:        'pi pi-box',
        valueColor:  '#09090b',
      },
      {
        label:       'Ejecución Auditada',
        value:       `${s.puntuacionTotal} pts`,
        description: 'Basado en configuración dinámica',
        icon:        'pi pi-star-fill',
        valueColor:  s.puntuacionTotal >= 50 ? '#059669' : '#09090b',
      },
      {
        label:       'Venta Adicional Total',
        value:       `$${s.ventaTotal.toLocaleString('es-MX')}`,
        description: 'Impacto comercial',
        icon:        'pi pi-dollar',
        valueColor:  s.ventaTotal > 0 ? '#059669' : '#09090b',
      },
    ];
  });

  // --- Dynamic Options (Map from Database Catalogs) ---
  configPosiciones = computed(() => this.svc.ubicaciones());
  configTipos      = computed(() => this.svc.conceptos());
  configNiveles    = computed(() => {
    const cfg = this.svc.scoringConfig();
    return Object.keys(cfg?.niveles_ejecucion || { excelente: 1.2, estandar: 1.0, basico: 0.8 });
  });

  // ── Main View Actions ─────────────────────────────────────────────────────

  onIniciarVisita() {
    if (this.svc.isPastCutoff()) {
      this.toast.add({ 
        severity: 'error', 
        summary: 'Jornada Cerrada', 
        detail: 'Ya son las 6:00 PM. No se permiten más visitas por el día de hoy.' 
      });
      return;
    }
    
    this.svc.iniciarVisita();
    this.toast.add({ severity: 'info', summary: 'GPS', detail: 'Localizando tienda...' });
    
    this.svc.capturarUbicacion().then(() => {
       this.toast.add({ severity: 'success', summary: 'Ubicación Confirmada', detail: 'GPS capturado exitosamente.' });
    }).catch(() => {
       this.toast.add({ 
         severity: 'warn', 
         summary: 'GPS No Disponible', 
         detail: 'Se analizará si esta visita será válida para tu ruta',
         sticky: true
       });
    });
  }

  onSaveCapturaTotal() {
    const ex = this.svc.activeExhibiciones();

    if (ex.length === 0) {
      this.toast.add({ severity: 'warn', summary: 'Visita vacía', detail: 'Debe agregar al menos un exhibidor antes de guardar la visita total.' });
      return;
    }

    const obs = this.svc.saveCapturaTotal();
    if (!obs) return;

    obs.subscribe({
      next: (result) => {
        this.lastResult = result;
        this.showResultDialog = true;
        this.toast.add({ severity: 'success', summary: 'Visita Finalizada', detail: `Se ha registrado el folio ${result.folio}.` });
      },
      error: (err) => {
        this.toast.add({ severity: 'error', summary: 'Error de Red', detail: 'No pudimos registrar tu visita general en el servidor.' });
      }
    });
  }

  onCancelarVisita() {
    this.confirmSvc.confirm({
      message:  '¿Estás seguro de cancelar la visita activa? Se perderán los exhibidores registrados que no hayas enviado.',
      header:   'Cancelar Visita',
      icon:     'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, cancelar',
      rejectLabel: 'Reanudar',
      acceptButtonStyleClass: 'p-button-danger',
      accept:   () => {
        this.svc.clearActiveState();
        this.toast.add({ severity: 'info', summary: 'Visita Cancelada', detail: 'No se guardaron los cambios.' });
      },
    });
  }

  // ── Wizard Actions ────────────────────────────────────────────────────────
  
  startWizard() {
    this.currentExhibicion.set({
      productosMarcados: [],
      rangoCompra: '',
      ventaAdicional: 0
    });
    this.wizardStep = 1;
    this.showWizard = true;
  }

  nextStep() {
    const curr = this.currentExhibicion();
    if (this.wizardStep === 1 && !curr.ubicacionId) {
      this.toast.add({ severity: 'warn', summary: 'Selecciona una posición', detail: 'Debe elegir dónde se realiza la auditoría.' });
      return;
    }
    if (this.wizardStep === 2 && !curr.conceptoId) {
      this.toast.add({ severity: 'warn', summary: 'Selecciona tipo', detail: 'Debe indicar el tipo de exhibición.' });
      return;
    }
    if (this.wizardStep === 3 && !curr.nivelEjecucion) {
      this.toast.add({ severity: 'warn', summary: 'Selecciona nivel', detail: 'Debe evaluar la calidad de la ejecución.' });
      return;
    }
    if (this.wizardStep < 6) {
      this.wizardStep++;
    }
  }

  prevStep() {
    if (this.wizardStep > 1) {
      this.wizardStep--;
    }
  }

  onConceptoSelect(id: string) {
    this.currentExhibicion.update(curr => ({ ...curr, conceptoId: id }));
  }

  onUbicacionSelect(id: string) {
    this.currentExhibicion.update(curr => ({ ...curr, ubicacionId: id }));
  }

  onNivelSelect(nivel: string) {
    this.currentExhibicion.update(curr => ({ ...curr, nivelEjecucion: nivel }));
  }

  toggleProducto(pid: string, checked: boolean) {
    this.currentExhibicion.update(curr => {
      const pm = curr.productosMarcados || [];
      const updated = checked 
        ? [...pm, pid] 
        : pm.filter(id => id !== pid);
      return { ...curr, productosMarcados: updated };
    });
  }

  onRangoCompraChange(val: string) {
    this.currentExhibicion.update(curr => ({ ...curr, rangoCompra: val }));
  }

  onVentaAdicionalChange(val: number) {
    this.currentExhibicion.update(curr => ({ ...curr, ventaAdicional: val }));
  }

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentExhibicion.update(curr => ({ ...curr, fotoBase64: e.target?.result as string }));
      };
      reader.readAsDataURL(file);
    }
  }

  removeFoto() {
    this.currentExhibicion.update(curr => ({ ...curr, fotoBase64: undefined }));
  }

  finishWizard(addAnother: boolean) {
    const ex = this.currentExhibicion() as Omit<RegistroExhibicion, 'id' | 'puntuacionCalculada' | 'horaRegistro'>;
    if (!ex.conceptoId || !ex.ubicacionId) {
      this.toast.add({ severity: 'error', summary: 'Error', detail: 'Faltan datos requeridos (concepto/ubicación).' });
      return;
    }

    if (!ex.fotoBase64) {
      this.toast.add({ severity: 'error', summary: 'Evidencia Obligatoria', detail: 'Debe adjuntar una fotografía del exhibidor antes de guardarlo.' });
      return;
    }

    this.svc.addExhibicion(ex);
    this.toast.add({ severity: 'success', summary: 'Exhibidor registrado', detail: 'Guardado en la visita actual.' });

    if (addAnother) {
      this.startWizard();
    } else {
      this.showWizard = false;
    }
  }

  onRemoveExhibicion(id: string) {
    this.svc.removeExhibicion(id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  getConceptNombre(id: string): string {
    const c = this.svc.conceptos().find(x => x.id === id);
    return c ? c.nombre : id;
  }

  getConceptIcon(id: string): string {
    const c = this.svc.conceptos().find(x => x.id === id);
    return c?.icono || '📦';
  }

  getUbicacionNombre(id: string): string {
    const u = this.svc.ubicaciones().find(x => x.id === id);
    return u ? u.nombre : id;
  }

  trackByFolio(_: number, c: VisitaSnapshot): string { return c.folio; }
  trackById(_: number, c: any): string { return c.id || c.pid; }

  formatDate(isoString: string): string {
    if (!isoString) return '—';
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  }
}