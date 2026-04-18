import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Subscription, take } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// PrimeNG
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { CheckboxModule } from 'primeng/checkbox';
import { RadioButtonModule } from 'primeng/radiobutton';
import { ChipModule } from 'primeng/chip';
import { CardModule } from 'primeng/card';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ThemeService } from '../../../core/services/theme.service';
import { AuthService } from '../../../core/services/auth.service';

// Spartan
import { HlmBadgeDirective } from '@spartan-ng/helm/badge';
import { HlmButtonDirective } from '@spartan-ng/helm/button';
import { HlmInputDirective } from '@spartan-ng/helm/input';
import { HlmLabelDirective } from '@spartan-ng/helm/label';

// Local
import { DailyCaptureService } from './daily-capture.service';
import {
  VisitaSnapshot,
  RANGOS_COMPRA,
  RegistroExhibicion,
} from './daily-capture.models';

@Component({
  selector: 'app-daily-capture',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    // PrimeNG
    ButtonModule,
    ConfirmDialogModule,
    DialogModule,
    InputNumberModule,
    SelectModule,
    TableModule,
    TagModule,
    ToastModule,
    CheckboxModule,
    RadioButtonModule,
    ChipModule,
    CardModule,
    // Spartan
    HlmBadgeDirective,
    HlmButtonDirective,
    HlmInputDirective,
    HlmLabelDirective,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './captures.component.html',
})
export class CapturesComponent implements OnInit, OnDestroy {
  readonly svc = inject(DailyCaptureService);
  readonly themeService = inject(ThemeService);
  readonly authService = inject(AuthService);
  readonly toast = inject(MessageService);
  readonly confirmSvc = inject(ConfirmationService);

  // ── Auth ──────────────────────────────────────────────────────────
  user = this.authService.user;

  // ── Initialization ───────────────────────────────────────────────────────
  ngOnInit() {
    this.svc.refreshAll();
  }

  // ── Constants & Catalogs ──────────────────────────────────────────────────
  readonly RANGOS_COMPRA = RANGOS_COMPRA;

  // ── UI State ──────────────────────────────────────────────────────────────
  showResultDialog = false;
  showImpactDialog = false;
  lastResult: VisitaSnapshot | null = null;
  expandedRows: { [key: string]: boolean } = {};
  isSaving = signal<boolean>(false);
  private saveSubscription: Subscription | null = null;

  // ── Wizard State ──────────────────────────────────────────────────────────
  showWizard = false;
  wizardStep = 1;
  searchQuery = signal<string>('');
  showSearchInput = false;

  currentExhibicion = signal<Partial<RegistroExhibicion>>({
    productosMarcados: [],
  });

  // ── Impacto Comercial State ───────────────────────────────────────────────
  impactoVentaAdicional: number = 0;
  impactoRangoCompra: string = '';

  // ── Computed ──────────────────────────────────────────────────────────────
  visitaNumero = computed(() => this.svc.visitasHoy().length + 1);

  filteredProducts = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const allProducts = this.svc.groupedProducts();
    
    if (!query) return [];
    
    const results: Array<{ pid: string; name: string; brand: string }> = [];
    
    for (const brand of allProducts) {
      for (const prod of brand.items) {
        if (prod.name.toLowerCase().includes(query) || brand.marca.toLowerCase().includes(query)) {
          results.push({
            pid: prod.pid,
            name: prod.name,
            brand: brand.marca
          });
        }
      }
    }
    
    return results.slice(0, 20); // Limit to 20 results
  });

  statCards = computed(() => {
    const s = this.svc.stats();
    const maxScore = this.svc.maxScore();
    const scorePct = this.svc.scorePercentage();
    const isDark = this.themeService.isMonochrome();

    return [
      {
        label: 'Exhibidores Registrados',
        value: s.totalExhibiciones.toString(),
        description: 'En esta visita',
        icon: 'pi pi-box',
        valueColor: 'var(--text-main)',
      },
      {
        label: 'Ejecución Auditada',
        value: `${scorePct}%`,
        description: `Score de calidad`,
        icon: 'pi pi-star-fill',
        valueColor: scorePct >= 50 ? '#10b981' : 'var(--text-main)',
        progress: scorePct,
      },
      {
        label: 'Venta Adicional Total',
        value: `$${s.ventaTotal.toLocaleString('es-MX')}`,
        description: 'Impacto comercial',
        icon: 'pi pi-dollar',
        valueColor: s.ventaTotal > 0 ? '#10b981' : 'var(--text-main)',
      },
    ];
  });

  // --- Dynamic Options (Map from Database Catalogs) ---
  configPosiciones = computed(() => this.svc.ubicaciones());
  configTipos = computed(() => this.svc.conceptos());
  configNiveles = computed(() => {
    const cfg = this.svc.scoringConfig();
    return Object.keys(
      cfg?.niveles_ejecucion || { excelente: 1.2, estandar: 1.0, basico: 0.8 },
    );
  });

  // ── Main View Actions ─────────────────────────────────────────────────────

  async onIniciarVisita() {
    if (this.svc.isPastCutoff()) {
      this.toast.add({
        severity: 'error',
        summary: 'Jornada Cerrada',
        detail:
          'Ya son las 6:00 PM. No se permiten más visitas por el día de hoy.',
      });
      return;
    }

    this.toast.add({
      severity: 'info',
      summary: 'GPS',
      detail: 'Localizando tienda...',
    });

    try {
      const success = await this.svc.iniciarVisita();
      if (success) {
        this.toast.add({
          severity: 'success',
          summary: 'Visita Iniciada',
          detail: 'Ubicación capturada correctamente.',
        });
      }
    } catch (error: any) {
      console.error('[captures.component] Error al iniciar visita:', error);
      this.toast.add({
        severity: 'error',
        summary: 'Error de GPS',
        detail: error.message || 'No se pudo capturar la ubicación. Verifique que el GPS esté activado.',
        life: 5000
      });
    }
  }

  openImpactDialog() {
    const ex = this.svc.activeExhibiciones();

    if (ex.length === 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Visita vacía',
        detail:
          'Debe agregar al menos un exhibidor antes de guardar la visita total.',
      });
      return;
    }

    // Inicializar valores desde el servicio
    this.impactoVentaAdicional = this.svc.visitaVentaAdicional();
    this.impactoRangoCompra = this.svc.visitaRangoCompra();

    this.showImpactDialog = true;
  }

  onSaveCapturaTotal() {
    // Prevent if already saving
    if (this.isSaving()) {
      this.toast.add({
        severity: 'info',
        summary: 'Enviando...',
        detail: 'La visita ya se está guardando, por favor espera.',
      });
      return;
    }

    const ex = this.svc.activeExhibiciones();

    if (ex.length === 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Visita vacía',
        detail:
          'Debe agregar al menos un exhibidor antes de guardar la visita total.',
      });
      return;
    }

    const obs = this.svc.saveCapturaTotal();
    if (!obs) return;

    // Cancel any previous subscription
    if (this.saveSubscription) {
      this.saveSubscription.unsubscribe();
    }

    this.isSaving.set(true);

    this.saveSubscription = obs.pipe(take(1)).subscribe({
      next: (result) => {
        this.isSaving.set(false);
        this.lastResult = result;
        
        // Detectar si es visita offline
        const isOffline = result._offline === true;
        
        this.showResultDialog = true;
        this.showImpactDialog = false;
        
        if (isOffline) {
          this.toast.add({
            severity: 'warn',
            summary: 'Visita Guardada Offline',
            detail: `Folio ${result.folio}. Se sincronizará cuando haya conexión.`,
            life: 5000
          });
        } else {
          this.toast.add({
            severity: 'success',
            summary: 'Visita Finalizada',
            detail: `Se ha registrado el folio ${result.folio}.`,
          });
        }
      },
      error: (err) => {
        this.isSaving.set(false);
        console.error('[captures.component] Error al guardar visita:', err);
        this.toast.add({
          severity: 'error',
          summary: 'Error de Red',
          detail: 'No pudimos registrar tu visita general en el servidor.',
        });
      },
    });
  }

  ngOnDestroy() {
    // Cleanup subscription when component is destroyed
    if (this.saveSubscription) {
      this.saveSubscription.unsubscribe();
    }
  }

  onCancelarVisita() {
    this.confirmSvc.confirm({
      message:
        '¿Estás seguro de cancelar la visita activa? Se perderán los exhibidores registrados que no hayas enviado.',
      header: 'Cancelar Visita',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, cancelar',
      rejectLabel: 'Reanudar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.clearActiveState();
        this.toast.add({
          severity: 'info',
          summary: 'Visita Cancelada',
          detail: 'No se guardaron los cambios.',
        });
      },
    });
  }

  toggleRowExpansion(visita: any) {
    this.expandedRows = {
      ...this.expandedRows,
      [visita.folio]: !this.expandedRows[visita.folio]
    };
  }

  // ── Wizard Actions ────────────────────────────────────────────────────────

  startWizard() {
    this.currentExhibicion.set({
      productosMarcados: [],
      rangoCompra: '',
      ventaAdicional: 0,
    });
    this.wizardStep = 1;
    this.showWizard = true;
  }

  nextStep() {
    const curr = this.currentExhibicion();
    if (this.wizardStep === 1 && !curr.ubicacionId) {
      this.toast.add({
        severity: 'warn',
        summary: 'Selecciona una posición',
        detail: 'Debe elegir dónde se realiza la auditoría.',
      });
      return;
    }
    if (this.wizardStep === 2 && !curr.conceptoId) {
      this.toast.add({
        severity: 'warn',
        summary: 'Selecciona tipo',
        detail: 'Debe indicar el tipo de exhibición.',
      });
      return;
    }
    if (this.wizardStep === 3 && curr.perteneceMegaDulces === undefined) {
      this.toast.add({
        severity: 'warn',
        summary: 'Selecciona si pertenece a Mega Dulces',
        detail: 'Debe indicar si el exhibidor pertenece a Mega Dulces.',
      });
      return;
    }
    if (this.wizardStep === 4 && !curr.nivelEjecucion) {
      this.toast.add({
        severity: 'warn',
        summary: 'Selecciona nivel',
        detail: 'Debe evaluar la calidad de la ejecución.',
      });
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
    this.currentExhibicion.update((curr) => ({ ...curr, conceptoId: id }));
  }

  onUbicacionSelect(id: string) {
    this.currentExhibicion.update((curr) => ({ ...curr, ubicacionId: id }));
  }

  onNivelSelect(nivel: string) {
    this.currentExhibicion.update((curr) => ({
      ...curr,
      nivelEjecucion: nivel,
    }));
  }

  onPerteneceMegaDulcesSelect(value: boolean) {
    this.currentExhibicion.update((curr) => ({
      ...curr,
      perteneceMegaDulces: value,
    }));
  }

  toggleProducto(pid: string, checked: boolean) {
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      const updated = checked ? [...pm, pid] : pm.filter((id) => id !== pid);
      return { ...curr, productosMarcados: updated };
    });
  }

  isBrandFullySelected(brand: any): boolean {
    const pm = this.currentExhibicion().productosMarcados || [];
    const brandPids = brand.items.map((p: any) => p.pid);
    return brandPids.length > 0 && brandPids.every((pid: string) => pm.includes(pid));
  }

  isBrandPartiallySelected(brand: any): boolean {
    const pm = this.currentExhibicion().productosMarcados || [];
    const brandPids = brand.items.map((p: any) => p.pid);
    const selectedCount = brandPids.filter((pid: string) => pm.includes(pid)).length;
    return selectedCount > 0 && selectedCount < brandPids.length;
  }

  getSelectedCountInBrand(brand: any): number {
    const pm = this.currentExhibicion().productosMarcados || [];
    const brandPids = brand.items.map((p: any) => p.pid);
    return brandPids.filter((pid: string) => pm.includes(pid)).length;
  }

  toggleBrandSelection(brand: any, checked: boolean) {
    const brandPids = brand.items.map((p: any) => p.pid);
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      let updated: string[];
      
      if (checked) {
        // Add all products from this brand
        updated = [...pm, ...brandPids.filter((pid: string) => !pm.includes(pid))];
      } else {
        // Remove all products from this brand
        updated = pm.filter((id: string) => !brandPids.includes(id));
      }
      
      return { ...curr, productosMarcados: updated };
    });
  }

  onSearchChange(query: string) {
    this.searchQuery.set(query);
  }

  clearSearch() {
    this.searchQuery.set('');
  }

  onSearchFocus() {
    // En móvil, cuando el input obtiene foco, scroll para que sea visible
    if (window.innerWidth < 768) {
      setTimeout(() => {
        const container = document.getElementById('step-4-container');
        const searchResults = document.getElementById('search-results');
        if (container) {
          container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 300);
    }
  }

  onSearchBlur() {
    // Manejar blur si es necesario
  }

  addProducto(pid: string) {
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      if (!pm.includes(pid)) {
        return { ...curr, productosMarcados: [...pm, pid] };
      }
      return curr;
    });
  }

  removeProducto(pid: string) {
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      return { ...curr, productosMarcados: pm.filter((id) => id !== pid) };
    });
  }

  getProductName(pid: string): string {
    const allProducts = this.svc.groupedProducts();
    for (const brand of allProducts) {
      const prod = brand.items.find(p => p.pid === pid);
      if (prod) return prod.name;
    }
    return pid;
  }

  onRangoCompraChange(val: string) {
    this.currentExhibicion.update((curr) => ({ ...curr, rangoCompra: val }));
  }

  onVentaAdicionalChange(val: number) {
    this.currentExhibicion.update((curr) => ({ ...curr, ventaAdicional: val }));
  }

  onImpactoVentaChange(val: number) {
    this.impactoVentaAdicional = val;
    this.svc.updateVisitaVentaAdicional(val);
  }

  onImpactoRangoChange(val: string) {
    this.impactoRangoCompra = val;
    this.svc.updateVisitaRangoCompra(val);
  }

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentExhibicion.update((curr) => ({
          ...curr,
          fotoBase64: e.target?.result as string,
        }));
      };
      reader.readAsDataURL(file);
    }
  }

  removeFoto() {
    this.currentExhibicion.update((curr) => ({
      ...curr,
      fotoBase64: undefined,
    }));
  }

  finishWizard(addAnother: boolean) {
    const ex = this.currentExhibicion() as Omit<
      RegistroExhibicion,
      'id' | 'puntuacionCalculada' | 'horaRegistro'
    >;
    if (!ex.conceptoId || !ex.ubicacionId) {
      this.toast.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Faltan datos requeridos (concepto/ubicación).',
      });
      return;
    }

    if (!ex.fotoBase64) {
      this.toast.add({
        severity: 'error',
        summary: 'Evidencia Obligatoria',
        detail:
          'Debe adjuntar una fotografía del exhibidor antes de guardarlo.',
      });
      return;
    }

    this.svc.addExhibicion(ex);
    this.toast.add({
      severity: 'success',
      summary: 'Exhibidor registrado',
      detail: 'Guardado en la visita actual.',
    });

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
    const c = this.svc.conceptos().find((x) => x.id === id);
    return c ? c.nombre : id;
  }

  getConceptIcon(id: string): string {
    const c = this.svc.conceptos().find((x) => x.id === id);
    return c?.icono || '📦';
  }

  getUbicacionNombre(id: string): string {
    const u = this.svc.ubicaciones().find((x) => x.id === id);
    return u ? u.nombre : id;
  }

  trackByFolio(_: number, c: VisitaSnapshot): string {
    return c.folio;
  }
  trackById(_: number, c: any): string {
    return c.id || c.pid;
  }

  formatDate(isoString: string): string {
    if (!isoString) return '—';
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  }
}
