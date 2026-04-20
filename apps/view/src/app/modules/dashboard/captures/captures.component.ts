import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit, OnDestroy, HostListener } from '@angular/core';
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
/**
 * Componente principal para la captura diaria de exhibidores.
 * Permite a los usuarios registrar visitas, capturar ubicación GPS, y documentar
 * exhibidores con productos, fotos y evaluaciones de calidad.
 */
export class CapturesComponent implements OnInit, OnDestroy {
  readonly svc = inject(DailyCaptureService);
  readonly themeService = inject(ThemeService);
  readonly authService = inject(AuthService);
  readonly toast = inject(MessageService);
  readonly confirmSvc = inject(ConfirmationService);

  // ── Auth ──────────────────────────────────────────────────────────
  /** Usuario autenticado actual */
  user = this.authService.user;

  // ── Initialization ───────────────────────────────────────────────────────
  /**
   * Inicializa el componente, refresca los datos y bloquea el scroll del body
   */
  ngOnInit() {
    this.svc.refreshAll();
    // Bloquear scroll del body cuando el componente se inicializa
    this.lockBodyScroll();
  }

  /**
   * Limpia las suscripciones y restaura el scroll del body al destruir el componente
   */
  ngOnDestroy() {
    // Cleanup subscription when component is destroyed
    if (this.saveSubscription) {
      this.saveSubscription.unsubscribe();
    }
    // Restaurar scroll del body cuando el componente se destruye
    this.unlockBodyScroll();
  }

  // ── Constants & Catalogs ──────────────────────────────────────────────────
  /** Catálogo de rangos de compra disponibles */
  readonly RANGOS_COMPRA = RANGOS_COMPRA;

  // ── UI State ──────────────────────────────────────────────────────────────
  /** Indica si se muestra el diálogo de resultados */
  showResultDialog = false;
  /** Indica si se muestra el diálogo de impacto comercial */
  showImpactDialog = false;
  /** Último resultado de visita capturado */
  lastResult: VisitaSnapshot | null = null;
  /** Filas expandidas en la tabla de exhibidores */
  expandedRows: { [key: string]: boolean } = {};
  /** Indica si se está guardando datos */
  isSaving = signal<boolean>(false);
  /** Suscripción para guardar datos */
  private saveSubscription: Subscription | null = null;

  // ── Wizard State ──────────────────────────────────────────────────────────
  /** Indica si el wizard está visible */
  showWizard = false;
  /** Paso actual del wizard (1-6) */
  wizardStep = 1;
  /** Query de búsqueda de productos */
  searchQuery = signal<string>('');
  /** Indica si el input de búsqueda está visible */
  showSearchInput = false;
  /** Indica si se muestran más productos en el chip */
  showMoreProducts = false;

  /** Exhibición actual siendo editada en el wizard */
  currentExhibicion = signal<Partial<RegistroExhibicion>>({
    productosMarcados: [],
  });

  // ── Impacto Comercial State ───────────────────────────────────────────────
  /** Valor del impacto de venta adicional */
  impactoVentaAdicional: number = 0;
  /** Rango de compra seleccionado */
  impactoRangoCompra: string = '';

  // ── Computed ──────────────────────────────────────────────────────────────
  /** Número de visita actual (visitas hoy + 1) */
  visitaNumero = computed(() => this.svc.visitasHoy().length + 1);

  /**
   * Filtra productos según el query de búsqueda, ignorando acentos
   * @returns Lista de productos filtrados (máximo 20)
   */
  filteredProducts = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const allProducts = this.svc.groupedProducts();

    if (!query) return [];

    // Normalizar query para ignorar acentos
    const normalizedQuery = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const results: Array<{ pid: string; name: string; brand: string }> = [];

    for (const brand of allProducts) {
      for (const prod of brand.items) {
        const normalizedName = prod.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const normalizedBrand = brand.marca.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        if (normalizedName.includes(normalizedQuery) || normalizedBrand.includes(normalizedQuery)) {
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

  /**
   * Filtra marcas y sus productos según el query de búsqueda, ignorando acentos
   * @returns Lista de marcas con productos filtrados
   */
  filteredBrands = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const allBrands = this.svc.groupedProducts();

    if (!query) return allBrands;

    // Normalizar query para ignorar acentos
    const normalizedQuery = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    return allBrands.map(brand => {
      // Filtrar productos dentro de cada marca según la búsqueda (ignorando acentos)
      const filteredItems = brand.items.filter(prod => {
        const normalizedName = prod.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const normalizedBrand = brand.marca.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return normalizedName.includes(normalizedQuery) ||
               normalizedBrand.includes(normalizedQuery);
      });

      return {
        marca: brand.marca,
        items: filteredItems
      };
    }).filter(brand => brand.items.length > 0); // Solo mostrar marcas que tienen productos después del filtro
  });

  /**
   * Genera las tarjetas de estadísticas para el dashboard
   * @returns Lista de tarjetas con información de exhibidores, ejecución y ventas
   */
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
  /** Configuración de posiciones de exhibidores desde el catálogo */
  configPosiciones = computed(() => this.svc.ubicaciones());
  /** Configuración de tipos de exhibidores desde el catálogo */
  configTipos = computed(() => this.svc.conceptos());
  /**
   * Configuración de niveles de ejecución desde el catálogo de scoring
   * @returns Lista de niveles de ejecución disponibles
   */
  configNiveles = computed(() => {
    const cfg = this.svc.scoringConfig();
    return Object.keys(
      cfg?.niveles_ejecucion || { excelente: 1.2, estandar: 1.0, basico: 0.8 },
    );
  });

  // ── Main View Actions ─────────────────────────────────────────────────────

  /**
   * Inicia una nueva visita capturando la ubicación GPS
   * @throws Error si no se puede capturar la ubicación o si es después de las 6 PM
   */
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

  /**
   * Muestra el diálogo de confirmación para cancelar la visita activa
   */
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

  /**
   * Inicia el wizard para agregar un nuevo exhibidor
   */
  startWizard() {
    this.currentExhibicion.set({
      productosMarcados: [],
      rangoCompra: '',
      ventaAdicional: 0,
    });
    this.wizardStep = 1;
    this.showWizard = true;
  }

  /**
   * Avanza al siguiente paso del wizard con validaciones
   */
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

  /**
   * Selecciona el tipo de exhibición en el wizard
   * @param id ID del concepto de exhibición seleccionado
   */
  onConceptoSelect(id: string) {
    this.currentExhibicion.update((curr) => ({ ...curr, conceptoId: id }));
  }

  /**
   * Selecciona la ubicación del exhibidor en el wizard
   * @param id ID de la ubicación seleccionada
   */
  onUbicacionSelect(id: string) {
    this.currentExhibicion.update((curr) => ({ ...curr, ubicacionId: id }));
  }

  /**
   * Selecciona el nivel de ejecución en el wizard
   * @param nivel Nivel de ejecución seleccionado
   */
  onNivelSelect(nivel: string) {
    this.currentExhibicion.update((curr) => ({
      ...curr,
      nivelEjecucion: nivel,
    }));
  }

  /**
   * Selecciona si el exhibidor pertenece a Mega Dulces
   * @param value true si pertenece a Mega Dulces, false si es de la competencia
   */
  onPerteneceMegaDulcesSelect(value: boolean) {
    this.currentExhibicion.update((curr) => ({
      ...curr,
      perteneceMegaDulces: value,
    }));
  }

  /**
   * Alterna la selección de un producto en la lista
   * @param pid ID del producto
   * @param checked Estado opcional del checkbox
   */
  toggleProducto(pid: string, checked?: boolean) {
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      // Si no se proporciona checked, calcular el nuevo estado
      const newChecked = checked !== undefined ? checked : !pm.includes(pid);
      const updated = newChecked ? [...pm, pid] : pm.filter((id) => id !== pid);
      return { ...curr, productosMarcados: updated };
    });
  }

  trackByMarca(index: number, brand: any): string {
    return brand.marca;
  }

  trackByPid(index: number, prod: any): string {
    return prod.pid;
  }

  /**
   * Verifica si un producto está seleccionado
   * @param pid ID del producto a verificar
   * @returns true si el producto está seleccionado
   */
  isProductSelected(pid: string): boolean {
    const pm = this.currentExhibicion().productosMarcados || [];
    return pm.includes(pid);
  }

  // ── Body Scroll Control ──────────────────────────────────────────────────────
  private bodyScrollPosition = 0;

  /**
   * Bloquea el scroll del body para evitar scroll en iOS Safari
   */
  lockBodyScroll() {
    this.bodyScrollPosition = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${this.bodyScrollPosition}px`;
    document.body.style.width = '100%';
  }

  /**
   * Restaura el scroll del body a su posición original
   */
  unlockBodyScroll() {
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('position');
    document.body.style.removeProperty('top');
    document.body.style.removeProperty('width');
    window.scrollTo(0, this.bodyScrollPosition);
  }

  @HostListener('touchmove', ['$event'])
  /**
   * Previene navegación hacia atrás con gestos horizontales
   * @param event Evento de touch
   */
  onTouchMove(event: TouchEvent) {
    // Detectar si el gesto es más horizontal que vertical
    const touchStartX = event.touches[0].clientX;
    const touchStartY = event.touches[0].clientY;
    const touchMoveX = event.touches[1]?.clientX || touchStartX;
    const touchMoveY = event.touches[1]?.clientY || touchStartY;

    const deltaX = Math.abs(touchMoveX - touchStartX);
    const deltaY = Math.abs(touchMoveY - touchStartY);

    // Si el movimiento es más horizontal que vertical, prevenir el comportamiento por defecto
    if (deltaX > deltaY && deltaX > 30) {
      event.preventDefault();
    }
  }

  /**
   * Verifica si todos los productos de una marca están seleccionados
   * @param brand Objeto de marca con productos
   * @returns true si todos los productos están seleccionados
   */
  isBrandFullySelected(brand: any): boolean {
    const pm = this.currentExhibicion().productosMarcados || [];
    const brandPids = brand.items.map((p: any) => p.pid);
    return brandPids.length > 0 && brandPids.every((pid: string) => pm.includes(pid));
  }

  /**
   * Verifica si algunos productos de una marca están seleccionados
   * @param brand Objeto de marca con productos
   * @returns true si algunos pero no todos los productos están seleccionados
   */
  isBrandPartiallySelected(brand: any): boolean {
    const pm = this.currentExhibicion().productosMarcados || [];
    const brandPids = brand.items.map((p: any) => p.pid);
    const selectedCount = brandPids.filter((pid: string) => pm.includes(pid)).length;
    return selectedCount > 0 && selectedCount < brandPids.length;
  }

  /**
   * Obtiene el número de productos seleccionados en una marca
   * @param brand Objeto de marca con productos
   * @returns Número de productos seleccionados
   */
  getSelectedCountInBrand(brand: any): number {
    const pm = this.currentExhibicion().productosMarcados || [];
    const brandPids = brand.items.map((p: any) => p.pid);
    return brandPids.filter((pid: string) => pm.includes(pid)).length;
  }

  /**
   * Alterna la selección de todos los productos de una marca
   * @param brand Objeto de marca con productos
   * @param checked Estado al que se debe cambiar la selección
   */
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

  /**
   * Actualiza el query de búsqueda de productos
   * @param query Texto de búsqueda
   */
  onSearchChange(query: string) {
    this.searchQuery.set(query);
  }

  /**
   * Limpia el query de búsqueda
   */
  clearSearch() {
    this.searchQuery.set('');
  }

  /**
   * Agrega la exhibición actual a la lista de exhibidores
   */
  addExhibicion() {
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
    this.svc.addExhibicion(ex);
    this.toast.add({
      severity: 'success',
      summary: 'Exhibidor registrado',
      detail: 'Guardado en la visita actual.',
    });
    this.showWizard = false;

    // Scroll to the bottom of the list
    setTimeout(() => {
      const container = document.getElementById('exhibiciones-list');
      if (container) {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 300);
  }

  /**
   * Maneja el evento blur del input de búsqueda
   */
  onSearchBlur() {
    // Manejar blur si es necesario
  }

  /**
   * Agrega un producto a la lista de productos seleccionados
   * @param pid ID del producto a agregar
   */
  addProducto(pid: string) {
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      if (!pm.includes(pid)) {
        return { ...curr, productosMarcados: [...pm, pid] };
      }
      return curr;
    });
  }

  /**
   * Elimina un producto de la lista de productos seleccionados
   * @param pid ID del producto a eliminar
   */
  removeProducto(pid: string) {
    this.currentExhibicion.update((curr) => {
      const pm = curr.productosMarcados || [];
      return { ...curr, productosMarcados: pm.filter((id) => id !== pid) };
    });
  }

  /**
   * Obtiene el nombre de un producto por su ID
   * @param pid ID del producto
   * @returns Nombre del producto o el ID si no se encuentra
   */
  getProductName(pid: string): string {
    const allProducts = this.svc.groupedProducts();
    for (const brand of allProducts) {
      const prod = brand.items.find(p => p.pid === pid);
      if (prod) return prod.name;
    }
    return pid;
  }

  /**
   * Actualiza el rango de compra de la exhibición actual
   * @param val Rango de compra seleccionado
   */
  onRangoCompraChange(val: string) {
    this.currentExhibicion.update((curr) => ({ ...curr, rangoCompra: val }));
  }

  /**
   * Actualiza la venta adicional de la exhibición actual
   * @param val Monto de venta adicional
   */
  onVentaAdicionalChange(val: number) {
    this.currentExhibicion.update((curr) => ({ ...curr, ventaAdicional: val }));
  }

  /**
   * Actualiza el impacto de venta adicional de la visita
   * @param val Monto de impacto de venta
   */
  onImpactoVentaChange(val: number) {
    this.impactoVentaAdicional = val;
    this.svc.updateVisitaVentaAdicional(val);
  }

  /**
   * Actualiza el rango de compra de la visita
   * @param val Rango de compra
   */
  onImpactoRangoChange(val: string) {
    this.impactoRangoCompra = val;
    this.svc.updateVisitaRangoCompra(val);
  }

  /**
   * Maneja la selección de archivo para la foto del exhibidor
   * @param event Evento de selección de archivo
   */
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

  /**
   * Elimina la foto del exhibidor
   */
  removeFoto() {
    this.currentExhibicion.update((curr) => ({
      ...curr,
      fotoBase64: undefined,
    }));
  }

  /**
   * Finaliza el wizard y guarda la exhibición
   * @param addAnother true para agregar otro exhibidor, false para cerrar el wizard
   */
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

  /**
   * Elimina un exhibidor de la lista
   * @param id ID del exhibidor a eliminar
   */
  onRemoveExhibicion(id: string) {
    this.svc.removeExhibicion(id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Obtiene el nombre del concepto por su ID
   * @param id ID del concepto
   * @returns Nombre del concepto o el ID si no se encuentra
   */
  getConceptNombre(id: string): string {
    const c = this.svc.conceptos().find((x) => x.id === id);
    return c ? c.nombre : id;
  }

  /**
   * Obtiene el icono del concepto por su ID
   * @param id ID del concepto
   * @returns Icono del concepto o emoji por defecto
   */
  getConceptIcon(id: string): string {
    const c = this.svc.conceptos().find((x) => x.id === id);
    return c?.icono || '📦';
  }

  /**
   * Obtiene el nombre de la ubicación por su ID
   * @param id ID de la ubicación
   * @returns Nombre de la ubicación o el ID si no se encuentra
   */
  getUbicacionNombre(id: string): string {
    const u = this.svc.ubicaciones().find((x) => x.id === id);
    return u ? u.nombre : id;
  }

  /**
   * Función de trackBy para el folio de visita
   * @param _ Índice (no usado)
   * @param c Objeto de visita
   * @returns Folio de la visita
   */
  trackByFolio(_: number, c: VisitaSnapshot): string {
    return c.folio;
  }
  /**
   * Función de trackBy para ID
   * @param _ Índice (no usado)
   * @param c Objeto con ID o PID
   * @returns ID o PID del objeto
   */
  trackById(_: number, c: any): string {
    return c.id || c.pid;
  }

  /**
   * Formatea una fecha ISO a hora local
   * @param isoString Fecha en formato ISO
   * @returns Hora formateada o guion si es nulo
   */
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
