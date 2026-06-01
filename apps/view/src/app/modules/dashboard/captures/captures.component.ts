import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit, OnDestroy, HostListener } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription, debounceTime, distinctUntilChanged, firstValueFrom, take } from 'rxjs';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../../environments/environment';

// PrimeNG
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { CheckboxModule } from 'primeng/checkbox';
import { RadioButtonModule } from 'primeng/radiobutton';
import { ChipModule } from 'primeng/chip';
import { CardModule } from 'primeng/card';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ThemeService } from '../../../core/services/theme.service';
import { AuthService } from '../../../core/services/auth.service';
import { HapticService } from '../../../core/services/haptic.service';
import { Permission } from '../../../core/constants/permissions';

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
// Fase K — AI product picker
import { AiProductPickerComponent } from './ai-product-picker.component';
// Offline status badge — comunica modo offline + visitas pendientes
import { OfflineStatusComponent } from '../../../shared/components/offline-status/offline-status.component';

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
    InputTextModule,
    SelectModule,
    TableModule,
    TagModule,
    ToastModule,
    CheckboxModule,
    RadioButtonModule,
    ChipModule,
    CardModule,
    TooltipModule,
    // Spartan
    HlmBadgeDirective,
    HlmButtonDirective,
    HlmInputDirective,
    HlmLabelDirective,
    // Fase K
    AiProductPickerComponent,
    // Offline status
    OfflineStatusComponent,
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
  private readonly haptic = inject(HapticService);
  readonly confirmSvc = inject(ConfirmationService);
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  /** Estado de detección de tienda */
  detectionStatus = signal<'idle' | 'detecting' | 'found' | 'not-found'>('idle');
  newStoreName = signal<string>('');
  creatingStore = signal(false);
  /** Guard contra double-click en "Iniciar Visita" (GPS puede tardar ~45s). */
  isStartingVisita = signal(false);

  /**
   * Toda visita activa DEBE estar vinculada a una tienda antes de capturar
   * exhibidores o terminar la visita. Si el GPS detectó una sola tienda
   * (`detectedStore`) o el usuario seleccionó/creó una manualmente, este
   * computed es false. Mientras sea true:
   *   - el FAB "Auditar Exhibidor" en mobile se deshabilita
   *   - `startWizard()` rechaza la apertura con un toast
   *   - `openImpactDialog()` (Terminar Visita) también rechaza
   * Esto evita visitas huérfanas sin store_id, que ensucian reportes.
   */
  needsStore = computed(
    () => this.svc.hasActiveVisit() && !this.svc.detectedStore(),
  );

  // Validación y compresión de archivos
  private readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB original
  private readonly ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  ];

  // ── Auth ──────────────────────────────────────────────────────────
  /** Usuario autenticado actual */
  user = this.authService.user;

  // ── Fase V — Vendedor con OCR de ticket ─────────────────────────────────
  /**
   * Modo recortado: SOLO el rol `vendedor` ve los 2 pasos (foto + ticket).
   *
   * IMPORTANTE: NO usar `CAPTURE_TICKET_USE` como gate del modo recortado.
   * Esa permission está en ALL_PERMS → admin/superadmin la heredan, y si
   * gateamos por la perm, superoot/admin entran al captures y solo ven los
   * 2 pasos del vendedor en vez del wizard completo de trade marketing
   * (bug observado 2026-05-29). La perm sigue gateando el ENDPOINT del
   * extractor, pero el MODO de la UI es role-based.
   */
  readonly isVendedor = computed(() => this.user()?.role_name === 'vendedor');

  /** Step 7 (solo vendedor): estado de la foto del ticket + extracción AI. */
  /**
   * Vendedor saltó intencionalmente el paso del ticket (red mala / OCR fallido).
   * Permite finalizar la visita con la foto del exhibidor + bandera explícita
   * en el JSONB para reporting (`ticket_skipped: true`). Sin esto, una visita
   * sin red en zona muerta se pierde al cerrar el wizard.
   */
  readonly ticketSkipped = signal(false);
  readonly ticketFile = signal<File | null>(null);
  readonly ticketPreview = signal<string | null>(null);
  readonly ticketExtracting = signal(false);
  readonly ticketResult = signal<any | null>(null);
  readonly ticketConfirmed = signal<Set<number>>(new Set());

  // ── Initialization ───────────────────────────────────────────────────────
  /**
   * Inicializa el componente, refresca los datos y bloquea el scroll del body
   */
  ngOnInit() {
    this.svc.refreshAll();
    // Fase K — escucha cambios de conectividad para mostrar/ocultar el botón AI.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }
    // Suscribirse al stream de notificaciones del servicio (MessageService vive a
    // nivel de componente, no se puede inyectar en el servicio root).
    this.notificationSub = this.svc.notifications$.subscribe((evt) => {
      if (evt.kind === 'simulated-coords') {
        this.toast.add({
          severity: 'warn',
          summary: 'Ubicación aproximada',
          detail: 'No fue posible obtener GPS. La visita se guardó con coordenadas aproximadas (Morelia). Verifica la ubicación de la tienda.',
          life: 8000,
        });
      } else if (evt.kind === 'load-error') {
        this.toast.add({
          severity: 'error',
          summary: evt.summary,
          detail: evt.detail,
          life: 6000,
        });
      }
    });
  }

  /**
   * Limpia las suscripciones cuando se destruye el componente
   */
  ngOnDestroy() {
    if (this.saveSubscription) {
      this.saveSubscription.unsubscribe();
    }
    if (this.notificationSub) {
      this.notificationSub.unsubscribe();
    }
    this.pendingTimeouts.forEach(clearTimeout);
    this.pendingTimeouts.clear();
    // Restaurar body scroll si el usuario navegó con el wizard abierto;
    // sin esto, body queda `position: fixed` y toda la app pierde scroll.
    if (this.showWizard) {
      this.unlockBodyScroll();
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      window.removeEventListener('offline', this.offlineHandler);
    }
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
  /** Suscripción al stream de notificaciones del servicio */
  private notificationSub: Subscription | null = null;
  /** Timeouts pendientes — cancelables en ngOnDestroy */
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  private scheduleTimeout(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.pendingTimeouts.delete(id);
      fn();
    }, ms);
    this.pendingTimeouts.add(id);
  }

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
  /** Marcas expandidas en el paso de productos */
  expandedBrands = signal<Set<string>>(new Set());

  /** Productos visibles por marca. Marcas con >PRODUCTS_PAGE_SIZE items
   * renderizan en páginas para no colapsar el DOM mobile con 200+ nodos.
   * Se incrementa con "Mostrar más"; se resetea con search/cierre wizard. */
  private readonly PRODUCTS_PAGE_SIZE = 50;
  productsShownByBrand = signal<Map<string, number>>(new Map());

  productsVisibleCount(marca: string, total: number): number {
    return Math.min(this.productsShownByBrand().get(marca) ?? this.PRODUCTS_PAGE_SIZE, total);
  }

  productsRemaining(marca: string, total: number): number {
    return Math.max(0, total - this.productsVisibleCount(marca, total));
  }

  showMoreInBrand(marca: string, total: number): void {
    this.productsShownByBrand.update((m) => {
      const next = new Map(m);
      const current = next.get(marca) ?? this.PRODUCTS_PAGE_SIZE;
      next.set(marca, Math.min(current + this.PRODUCTS_PAGE_SIZE, total));
      return next;
    });
  }

  nextPageSize(marca: string, total: number): number {
    return Math.min(this.PRODUCTS_PAGE_SIZE, this.productsRemaining(marca, total));
  }

  /** Exhibición actual siendo editada en el wizard */
  currentExhibicion = signal<Partial<RegistroExhibicion>>({
    productosMarcados: [],
  });

  // ── Fase K — AI product picker ────────────────────────────────────────
  /** Toggle del modal `<app-ai-product-picker>` en el paso 5. */
  showAiPicker = signal<boolean>(false);
  /**
   * Adaptador para `[(visible)]` de PrimeNG `<p-dialog>` que espera
   * property tradicional, no signal. Read del signal, write con `.set`.
   */
  get showAiPickerModel(): boolean {
    return this.showAiPicker();
  }
  set showAiPickerModel(v: boolean) {
    this.showAiPicker.set(v);
  }
  /** Online flag para esconder el botón AI cuando no hay red (captures es offline-first). */
  isOnline = signal<boolean>(typeof navigator === 'undefined' || navigator.onLine);

  private onlineHandler = () => this.isOnline.set(true);
  private offlineHandler = () => this.isOnline.set(false);

  /**
   * Search debounceado (200 ms). Recomputar `filteredProducts` y
   * `filteredBrands` en cada keystroke con catálogos grandes (1000+ SKUs)
   * lagueaba la búsqueda en móvil.
   */
  private debouncedSearch = toSignal(
    toObservable(this.searchQuery).pipe(
      debounceTime(200),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  /**
   * Map `pid → name` cached para `getProductName`. Antes recorría todas
   * las marcas linealmente cada vez (O(M×N) por llamada) — en el result
   * dialog con 50 productos × 100+ catálogo, era costosísimo.
   */
  private productNameMap = computed(() => {
    const map = new Map<string, string>();
    for (const brand of this.svc.groupedProducts()) {
      for (const prod of brand.items) map.set(prod.pid, prod.name);
    }
    return map;
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
    const query = this.debouncedSearch().toLowerCase();
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
    const query = this.debouncedSearch().toLowerCase();
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
        value: `${Math.round(s.puntuacionTotal)} pts`,
        description: `Puntos absolutos obtenidos`,
        icon: 'pi pi-star-fill',
        valueColor: s.puntuacionTotal > 0 ? 'var(--ok-fg)' : 'var(--text-main)',
      },
      {
        label: 'Venta Adicional Total',
        value: `$${s.ventaTotal.toLocaleString('es-MX')}`,
        description: 'Impacto comercial',
        icon: 'pi pi-dollar',
        valueColor: s.ventaTotal > 0 ? 'var(--ok-fg)' : 'var(--text-main)',
      },
    ];
  });

  // --- Dynamic Options (Map from Database Catalogs) ---
  /** Configuración de posiciones de exhibidores desde el catálogo */
  configPosiciones = computed(() => this.svc.ubicaciones());
  /** Configuración de tipos de exhibidores desde el catálogo */
  configTipos = computed(() => this.svc.conceptos());
  /**
   * Configuración de niveles de ejecución desde el catálogo real de la BD
   * Devuelve objetos con { id, value, puntuacion } para usar en el wizard
   */
  configNiveles = computed(() => {
    const niveles = this.svc.niveles();
    if (niveles.length === 0) {
      // NO usar fallback con IDs inventados (ej: 'legacy-0').
      // Esto causaba que el backend recibiera UUIDs falsos que no existen
      // en `catalogs`, rompiendo el scoring y dejando capturas sin nivelEjecucionId
      // válido. Mejor devolver vacío y mostrar mensaje al usuario.
      return [];
    }
    return niveles.map(n => ({
      id: n.id,
      value: n.value,
      puntuacion: Number(n.puntuacion) || 1,
    }));
  });

  // ── Main View Actions ─────────────────────────────────────────────────────

  /**
   * Inicia una nueva visita capturando la ubicación GPS
   * @throws Error si no se puede capturar la ubicación
   */
  async onIniciarVisita() {
    // Guard: GPS puede tardar hasta ~45s con reintentos. Sin esto, el usuario
    // tappea varias veces y dispara múltiples geolocation requests + toasts.
    if (this.isStartingVisita() || this.svc.hasActiveVisit()) return;

    this.isStartingVisita.set(true);
    try {
      const success = await this.svc.iniciarVisita();
      if (success) {
        this.toast.add({
          severity: 'success',
          summary: 'Visita Iniciada',
          detail: 'Ubicación capturada correctamente.',
        });
        if (this.svc.detectedStore()) {
          this.detectionStatus.set('found');
        } else if (this.svc.nearbyStores().length > 1) {
          this.detectionStatus.set('found');
        } else {
          this.detectionStatus.set('not-found');
        }
      }
    } catch (error: any) {
      this.toast.add({
        severity: 'error',
        summary: 'Error de GPS',
        detail:
          error?.message ||
          'No se pudo capturar la ubicación. Verifique que el GPS esté activado.',
        life: 5000,
      });
    } finally {
      this.isStartingVisita.set(false);
    }
  }

  async onReDetectarTienda() {
    this.detectionStatus.set('detecting');
    this.newStoreName.set('');
    await this.svc.detectarTiendaCercana();
    if (this.svc.detectedStore()) {
      this.detectionStatus.set('found');
    } else {
      this.detectionStatus.set('not-found');
    }
  }

  onSelectStore(store: any) {
    this.svc.selectStore(store);
    this.detectionStatus.set('found');
  }

  async onCreateStore() {
    const name = this.newStoreName().trim();
    if (!name) return;

    const lat = this.svc.latitud();
    const lng = this.svc.longitud();
    // Sin coordenadas válidas no creamos la tienda — `0, 0` es el Golfo de
    // Guinea y contamina los reports/mapas.
    if (!lat || !lng) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin GPS',
        detail:
          'Captura primero la ubicación de la visita antes de crear una tienda nueva.',
      });
      return;
    }

    this.creatingStore.set(true);
    try {
      // OFFLINE-FIRST: si no hay red, creamos local en Dexie con UUID temporal.
      // El sync background hace POST /stores cuando vuelva la conexión y
      // remappea visitas que apuntaban al ID local hacia el serverId real.
      // Antes esto bloqueaba al usuario en zonas sin señal cuando intentaba
      // dar de alta un PDV nuevo.
      if (!navigator.onLine) {
        const localId = await this.svc.crearTiendaOffline(name, lat, lng);
        this.svc.selectStore({ id: localId, nombre: name, distance: 0 });
        this.detectionStatus.set('found');
        this.toast.add({
          severity: 'info',
          summary: 'Tienda Pendiente',
          detail: `"${name}" guardada localmente. Se creará en el servidor cuando vuelva la conexión.`,
          life: 6000,
        });
        return;
      }

      const store = await firstValueFrom(
        this.http.post<any>(`${this.apiUrl}/stores`, {
          nombre: name,
          latitud: lat,
          longitud: lng,
        }),
      );
      this.svc.selectStore({ id: store.id, nombre: store.nombre, distance: 0 });
      this.detectionStatus.set('found');
      this.toast.add({
        severity: 'success',
        summary: 'Tienda Registrada',
        detail: `Nueva tienda "${name}" creada y vinculada a la visita.`,
      });
    } catch (err: any) {
      // Si el POST online falló por error de red, intentar fallback offline
      // (en lugar de bloquear al usuario).
      const TRANSIENT_STATUSES = new Set([0, 408, 502, 503, 504, 522, 524]);
      const status = err?.status;
      if (status === undefined || TRANSIENT_STATUSES.has(status)) {
        try {
          const localId = await this.svc.crearTiendaOffline(name, lat, lng);
          this.svc.selectStore({ id: localId, nombre: name, distance: 0 });
          this.detectionStatus.set('found');
          this.toast.add({
            severity: 'info',
            summary: 'Tienda Pendiente',
            detail: `"${name}" guardada localmente (sin red). Se sincronizará automáticamente.`,
            life: 6000,
          });
          return;
        } catch (offErr) {
          /* swallow — caemos al toast genérico abajo */
        }
      }
      this.toast.add({
        severity: 'error',
        summary: 'Error',
        detail:
          err?.error?.message || 'No se pudo crear la tienda. Intente nuevamente.',
      });
    } finally {
      this.creatingStore.set(false);
    }
  }

  openImpactDialog() {
    // Guard: no permitir terminar la visita sin tienda vinculada.
    if (this.needsStore()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Falta nombre de tienda',
        detail:
          'Selecciona o registra la tienda antes de terminar la visita.',
        life: 4500,
      });
      this.scrollToStoreBanner();
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

    // Inicializar valores desde el servicio
    this.impactoVentaAdicional = this.svc.visitaVentaAdicional();
    this.impactoRangoCompra = this.svc.visitaRangoCompra();

    this.showImpactDialog = true;
  }

  onSaveCapturaTotal() {
    // Guard: si ya se está guardando, ignorar el click silenciosamente
    // (el botón ya está disabled/loading; este check evita race en double-tap rápido).
    if (this.isSaving()) {
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
          this.haptic.notification('warning');
          this.toast.add({
            severity: 'warn',
            summary: 'Visita Guardada Offline',
            detail: `Folio ${result.folio}. Se sincronizará cuando haya conexión.`,
            life: 5000
          });
        } else {
          this.haptic.notification('success');
          this.toast.add({
            severity: 'success',
            summary: 'Visita Finalizada',
            detail: `Se ha registrado el folio ${result.folio}.`,
          });
        }

        // Backend devuelve `fotos: { requeridas, subidas, fallidas }`. Si
        // alguna foto no llegó a Cloudinary, avisamos al user — antes la
        // captura se guardaba con foto null y nadie se enteraba hasta abrir
        // reports y ver el ícono vacío.
        const fotos = result?.fotos;
        if (fotos?.fallidas > 0) {
          this.haptic.notification('warning');
          this.toast.add({
            severity: 'warn',
            summary: 'Fotos no subidas',
            detail:
              `${fotos.fallidas} de ${fotos.requeridas} fotos fallaron al subir. ` +
              `La visita quedó guardada sin esa evidencia. Revisá tu conexión.`,
            life: 8000,
          });
        }
      },
      error: (err) => {
        this.isSaving.set(false);
        this.haptic.notification('error');
        console.error('[saveCapturaTotal] error completo:', err);
        // El backend NestJS típicamente responde { statusCode, message, error }.
        // En multipart, err.error puede llegar como string (no JSON parsed)
        // o como Blob. Probamos todas las variantes antes del genérico.
        let detail = '';
        if (typeof err?.error === 'string') {
          detail = err.error;
        } else if (err?.error?.message) {
          detail = Array.isArray(err.error.message)
            ? err.error.message.join(', ')
            : err.error.message;
        } else if (err?.message) {
          detail = err.message;
        }
        const statusInfo = err?.status ? ` (HTTP ${err.status})` : '';
        this.toast.add({
          severity: 'error',
          summary: err?.status === 0 ? 'Error de Red' : 'Error del Servidor',
          detail:
            (detail ||
              'No pudimos registrar tu visita general en el servidor.') +
            statusInfo,
          life: 10000,
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
    // Guard: cada exhibidor pertenece a una tienda; no podemos auditar sin
    // haber resuelto el `store_id` (vía detección GPS o registro manual).
    if (this.needsStore()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Selecciona o registra una tienda',
        detail:
          'Antes de auditar exhibidores debes confirmar el nombre de la tienda donde estás.',
        life: 4500,
      });
      this.scrollToStoreBanner();
      return;
    }

    // Vendedor: pre-llenamos los campos del wizard que no se le muestran y
    // arrancamos directo en el paso de la foto del exhibidor.
    if (this.isVendedor()) {
      const ubi = this.configPosiciones()[0];
      const tip = this.configTipos()[0];
      const niv = this.configNiveles()[0];
      this.currentExhibicion.set({
        productosMarcados: [],
        rangoCompra: '',
        ventaAdicional: 0,
        ubicacionId: ubi?.id || '',
        conceptoId: tip?.id || '',
        perteneceMegaDulces: true,
        nivelEjecucion: niv?.value?.toLowerCase() || '',
        nivelEjecucionId: niv?.id || '',
      });
      // Reset estado del ticket en cada apertura del wizard.
      this.ticketFile.set(null);
      this.ticketPreview.set(null);
      this.ticketResult.set(null);
      this.ticketConfirmed.set(new Set());
      this.ticketSkipped.set(false);
      this.wizardStep = 6;
    } else {
      this.currentExhibicion.set({
        productosMarcados: [],
        rangoCompra: '',
        ventaAdicional: 0,
      });
      this.wizardStep = 1;
    }
    this.showWizard = true;
    this.expandedBrands.set(new Set());
    this.productsShownByBrand.set(new Map());
    this.lockBodyScroll();
    this.loadFrequentProducts();
  }

  /**
   * Top productos marcados por el usuario en los últimos 30 días. Atajo en
   * step 5 (chips arriba de la lista de marcas) — cuando el vendedor captura
   * tiendas similares, el 80% de los productos cae acá y evita expandir marcas.
   *
   * Best-effort: si falla la red el step 5 sigue funcionando con la lista
   * completa de marcas.
   */
  private loadFrequentProducts(): void {
    if (this.isVendedor()) return; // Vendedor no usa step 5
    const storeId = this.svc.detectedStore()?.id;
    this.svc.getFrequentProducts({ days: 30, limit: 20, storeId }).subscribe({
      next: (rows) => this.frequentProducts.set(rows),
      error: () => this.frequentProducts.set([]),
    });
  }

  /** Productos frecuentes con su nombre resuelto desde groupedProducts (para mostrar). */
  readonly frequentProducts = signal<{ product_id: string; marks: number }[]>([]);

  readonly frequentDisplay = computed(() => {
    const pids = this.frequentProducts();
    if (pids.length === 0) return [];
    const allBrands = this.svc.groupedProducts();
    const byPid = new Map<string, { name: string; brand: string }>();
    for (const b of allBrands) {
      for (const p of b.items || []) byPid.set(p.pid, { name: p.name, brand: b.marca });
    }
    return pids
      .map((r) => ({ ...r, ...(byPid.get(r.product_id) || { name: '', brand: '' }) }))
      .filter((r) => r.name); // descartar productos que ya no están en catálogo
  });

  /**
   * Hace scroll suave al primer banner de tienda visible. Útil cuando el
   * usuario está al fondo de la página (tras varios exhibidores) y el toast
   * apunta a algo que no ve.
   */
  private scrollToStoreBanner(): void {
    if (typeof document === 'undefined') return;
    const banner = document.querySelector(
      '[data-store-banner]',
    ) as HTMLElement | null;
    banner?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    if (this.wizardStep === 4) {
      // Defensa: si el catálogo de niveles no cargó, NO permitir avanzar.
      // Sin niveles válidos, el front guardaría con IDs inventados.
      if (this.configNiveles().length === 0) {
        this.toast.add({
          severity: 'error',
          summary: 'Catálogo no disponible',
          detail:
            'No se han cargado los niveles de ejecución. Verifica tu conexión y refresca la página.',
        });
        return;
      }
      if (!curr.nivelEjecucion || !curr.nivelEjecucionId) {
        this.toast.add({
          severity: 'warn',
          summary: 'Selecciona nivel',
          detail: 'Debe evaluar la calidad de la ejecución.',
        });
        return;
      }
    }
    // Vendedor: del paso 6 (foto exhibidor) avanza al paso 7 (foto ticket).
    if (this.isVendedor() && this.wizardStep === 6) {
      if (!curr.fotoBase64) {
        this.toast.add({
          severity: 'warn',
          summary: 'Foto requerida',
          detail: 'Tomá la foto del exhibidor antes de continuar.',
        });
        return;
      }
      this.wizardStep = 7;
      return;
    }
    if (this.wizardStep < 6) {
      this.wizardStep++;
      // Al entrar al paso 5, expandir marcas que tienen productos seleccionados
      if (this.wizardStep === 5) {
        this.scheduleTimeout(() => this.expandBrandsWithSelectedProducts(), 0);
      }
    }
  }

  prevStep() {
    // Vendedor: del paso 7 vuelve al paso 6. Del 6 cierra (no hay pasos previos visibles).
    if (this.isVendedor()) {
      if (this.wizardStep === 7) this.wizardStep = 6;
      return;
    }
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
   * @param level Objeto completo del nivel { id, value, puntuacion }
   */
   onNivelSelect(level: { id: string; value: string; puntuacion: number }) {
     this.currentExhibicion.update((curr) => ({
       ...curr,
       nivelEjecucion: level.value.toLowerCase(),
       nivelEjecucionId: level.id,
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

  /**
   * Verifica si una marca está expandida
   * @param marca Nombre de la marca
   * @returns true si la marca está expandida
   */
  isBrandExpanded(marca: string): boolean {
    return this.expandedBrands().has(marca);
  }

  /**
   * Expande o colapsa una marca
   * @param marca Nombre de la marca
   */
  toggleBrandExpansion(marca: string) {
    this.expandedBrands.update((set) => {
      const newSet = new Set(set);
      if (newSet.has(marca)) {
        newSet.delete(marca);
      } else {
        newSet.add(marca);
      }
      return newSet;
    });
  }

  /**
   * Expande todas las marcas que tienen productos seleccionados.
   * Usa `svc.groupedProducts()` y no `filteredBrands()` para que la
   * expansión sea independiente del query de búsqueda actual.
   */
  expandBrandsWithSelectedProducts() {
    const selectedProducts = this.currentExhibicion().productosMarcados || [];
    if (selectedProducts.length === 0) {
      this.expandedBrands.set(new Set());
      return;
    }
    const brands = this.svc.groupedProducts();
    const brandsToExpand = new Set<string>();

    for (const brand of brands) {
      if (brand.items.some((item) => selectedProducts.includes(item.pid))) {
        brandsToExpand.add(brand.marca);
      }
    }

    this.expandedBrands.set(brandsToExpand);
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

  // Estado del gesto: necesario porque `event.touches[0]/[1]` son dos dedos
  // distintos (multi-touch), no start/move del mismo dedo.
  private touchStartX: number | null = null;
  private touchStartY: number | null = null;

  @HostListener('touchstart', ['$event'])
  onTouchStart(event: TouchEvent) {
    if (!this.showWizard || !event.touches[0]) {
      this.touchStartX = null;
      this.touchStartY = null;
      return;
    }
    this.touchStartX = event.touches[0].clientX;
    this.touchStartY = event.touches[0].clientY;
  }

  /**
   * Previene navegación hacia atrás con gestos horizontales dentro del
   * wizard. Solo activo cuando el wizard está abierto.
   */
  @HostListener('touchmove', ['$event'])
  onTouchMove(event: TouchEvent) {
    if (
      !this.showWizard ||
      this.touchStartX === null ||
      this.touchStartY === null ||
      !event.touches[0]
    ) {
      return;
    }

    const deltaX = Math.abs(event.touches[0].clientX - this.touchStartX);
    const deltaY = Math.abs(event.touches[0].clientY - this.touchStartY);

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
    this.productsShownByBrand.set(new Map());
  }

  /**
   * Limpia el query de búsqueda
   */
  clearSearch() {
    this.searchQuery.set('');
    this.productsShownByBrand.set(new Map());
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
    if (!ex.nivelEjecucion || !ex.nivelEjecucionId) {
      this.toast.add({
        severity: 'error',
        summary: 'Evaluación requerida',
        detail: 'Debes evaluar la calidad de la ejecución (paso 4).',
      });
      this.wizardStep = 4;
      return;
    }
    try {
      this.svc.addExhibicion(ex);
    } catch (err: any) {
      this.toast.add({
        severity: 'error',
        summary: 'Error al guardar exhibidor',
        detail: err?.message || 'No se pudo guardar.',
      });
      return;
    }
    this.toast.add({
      severity: 'success',
      summary: 'Exhibidor registrado',
      detail: 'Guardado en la visita actual.',
    });
    this.showWizard = false;
    this.unlockBodyScroll();

    this.scheduleTimeout(() => {
      const container = document.getElementById('exhibiciones-list');
      if (container) {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 300);
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

  // ── Fase K — AI product picker handlers ─────────────────────────────────
  openAiPicker() {
    if (!this.isOnline()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin conexión',
        detail: 'La búsqueda con AI requiere internet. Usa el buscador clásico.',
        life: 3500,
      });
      return;
    }
    this.showAiPicker.set(true);
  }

  onAiPickerApplied(pids: string[]) {
    // Merge con dedupe automático contra los ya seleccionados.
    this.currentExhibicion.update((curr) => {
      const existing = curr.productosMarcados || [];
      const fresh = pids.filter((p) => !existing.includes(p));
      return { ...curr, productosMarcados: [...existing, ...fresh] };
    });
    this.showAiPicker.set(false);
    this.toast.add({
      severity: 'success',
      summary: 'Productos agregados',
      detail: `${pids.length} producto${pids.length === 1 ? '' : 's'} reconocidos por AI.`,
      life: 3000,
    });
  }

  onAiPickerCancelled() {
    this.showAiPicker.set(false);
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
   * Obtiene el nombre de un producto por su ID usando el map cached.
   * O(1) por lookup; antes era O(M×N) escaneando todas las marcas.
   */
  getProductName(pid: string): string {
    return this.productNameMap().get(pid) ?? pid;
  }

  /**
   * Fase V — Selecciona la foto del ticket y dispara el extractor AI.
   */
  async onTicketSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!this.ALLOWED_IMAGE_TYPES.includes(file.type)) {
      this.toast.add({ severity: 'warn', summary: 'Formato no soportado', detail: file.type });
      return;
    }
    this.ticketFile.set(file);
    const reader = new FileReader();
    reader.onload = () => this.ticketPreview.set(reader.result as string);
    reader.readAsDataURL(file);
    await this.extractTicket(file);
  }

  /** Sube el ticket al endpoint Fase V y marca productos auto-confirmados. */
  private async extractTicket(file: File): Promise<void> {
    this.ticketExtracting.set(true);
    this.ticketResult.set(null);
    this.ticketConfirmed.set(new Set());
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'ticket.jpg');
      const res = await firstValueFrom(
        this.http.post<any>(`${environment.apiUrl}/ai/ticket/extract`, fd),
      );
      this.ticketResult.set(res);
      // Pre-confirmar items con autoConfirm=true del backend.
      const auto = new Set<number>();
      const items = res?.match?.items || [];
      items.forEach((it: any, i: number) => {
        if (it.suggested?.autoConfirm) auto.add(i);
      });
      this.ticketConfirmed.set(auto);
      this.applyTicketProductsToExhibicion();
      this.toast.add({
        severity: items.length ? 'success' : 'warn',
        summary: items.length ? `${items.length} líneas detectadas` : 'Ticket ilegible',
        detail: items.length
          ? `${auto.size} listas para confirmar`
          : 'No se reconocieron productos. Tomá la foto con mejor luz.',
        life: 2500,
      });
    } catch (err: any) {
      const detail = err?.error?.message || 'No se pudo procesar el ticket';
      this.toast.add({ severity: 'error', summary: 'Error', detail });
    } finally {
      this.ticketExtracting.set(false);
    }
  }

  /** Toggle de un item del ticket — recalcula productosMarcados de la exhibición. */
  toggleTicketItem(idx: number, checked: boolean): void {
    const set = new Set(this.ticketConfirmed());
    if (checked) set.add(idx);
    else set.delete(idx);
    this.ticketConfirmed.set(set);
    this.applyTicketProductsToExhibicion();
  }

  isTicketConfirmed(idx: number): boolean {
    return this.ticketConfirmed().has(idx);
  }

  /** Aplica la selección actual del ticket al campo `productosMarcados` de la exhibición. */
  private applyTicketProductsToExhibicion(): void {
    const res = this.ticketResult();
    if (!res) return;
    const set = this.ticketConfirmed();
    const pids: string[] = (res.match?.items || [])
      .map((it: any, i: number) =>
        set.has(i) && it.suggested?.product_id ? (it.suggested.product_id as string) : null,
      )
      .filter((x: string | null): x is string => !!x);
    this.currentExhibicion.update((curr) => ({ ...curr, productosMarcados: pids }));
  }

  clearTicket(): void {
    this.ticketFile.set(null);
    this.ticketPreview.set(null);
    this.ticketResult.set(null);
    this.ticketConfirmed.set(new Set());
    this.ticketSkipped.set(false);
    this.currentExhibicion.update((curr) => ({ ...curr, productosMarcados: [] }));
  }

  /**
   * Saltar el paso del ticket explícitamente. Se usa cuando:
   *  - El vendedor no tiene red (Cloudinary/OCR fallan).
   *  - El ticket no es legible / no aplica.
   * Marca `ticketSkipped=true` para que finishWizard acepte la visita sin
   * ticketResult. El JSONB de la exhibición lleva `ticket_skipped:true`
   * para análisis posterior.
   */
  skipTicket(): void {
    if (!confirm('¿Saltar el paso del ticket? La visita se guardará solo con la foto del exhibidor. Asegurate de que la foto sea clara.')) {
      return;
    }
    this.ticketSkipped.set(true);
    this.ticketFile.set(null);
    this.ticketPreview.set(null);
    this.ticketResult.set(null);
    this.ticketConfirmed.set(new Set());
    this.toast.add({
      severity: 'info',
      summary: 'Ticket saltado',
      detail: 'Tocá Finalizar para guardar la visita con la foto del exhibidor.',
      life: 4000,
    });
  }

  ticketSev(c: string): 'success' | 'info' | 'warn' | 'danger' {
    if (c === 'high') return 'success';
    if (c === 'medium') return 'info';
    if (c === 'low') return 'warn';
    return 'danger';
  }

  ticketConfLabel(c: string): string {
    return c === 'high' ? 'Alta' : c === 'medium' ? 'Media' : c === 'low' ? 'Baja' : 'Sin match';
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
   * Maneja la selección de archivo: valida tipo (sólo imágenes), tamaño
   * máximo (10 MB) y **comprime** la imagen vía canvas antes de guardarla
   * como base64. Sin compresión, una foto de 5 MB se convierte en ~6.7 MB
   * en base64 → payloads que rompen body-parser y llenan IndexedDB offline.
   */
  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!this.ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
      this.toast.add({
        severity: 'error',
        summary: 'Tipo no soportado',
        detail: 'Solo imágenes JPG, PNG, WebP o HEIC.',
      });
      input.value = '';
      return;
    }

    if (file.size > this.MAX_FILE_SIZE_BYTES) {
      this.toast.add({
        severity: 'error',
        summary: 'Archivo demasiado grande',
        detail: `Máximo 10 MB. Tu archivo pesa ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
      });
      input.value = '';
      return;
    }

    try {
      const { blob, previewUrl } = await this.compressImage(file);
      // Revocar la previewUrl previa si existía (memory leak guard).
      this.revokeFotoPreview();
      this.currentExhibicion.update((curr) => ({
        ...curr,
        // `_photoBlob` se usa en buildVisitFormData (online) y en
        // OfflineSyncService.guardarVisitaOffline (offline). `fotoBase64`
        // queda solo como referencia para `<img [src]>` — para no romper
        // el template ni el resto de chequeos `*ngIf="ex.fotoBase64"`,
        // guardamos la objectURL ahí (también es válida para <img>).
        _photoBlob: blob,
        fotoBase64: previewUrl,
      }));
    } catch (err) {
      const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
      this.toast.add({
        severity: 'error',
        summary: isHeic ? 'Formato HEIC no soportado' : 'Error al procesar la imagen',
        detail: isHeic
          ? 'En este dispositivo tu foto no se puede decodificar. Cambiá el formato a "Más compatible" en Ajustes → Cámara → Formatos, o tomá la foto de nuevo.'
          : 'Intenta con otra foto.',
        life: 6000,
      });
    } finally {
      input.value = '';
    }
  }

  /**
   * Comprime una imagen a `maxDim` (lado mayor) y la devuelve como Blob JPEG
   * + una objectURL para preview. Antes devolvía data URL (`toDataURL`):
   * eso forzaba ~700KB de string en memoria y un atob() lineal al persistir
   * en Dexie (~30ms × N exhibidores de jank). Ahora el Blob viaja crudo a
   * upload y a IndexedDB; el preview usa `URL.createObjectURL`.
   */
  private compressImage(
    file: File,
    maxDim = 1920,
    quality = 0.8,
  ): Promise<{ blob: Blob; previewUrl: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () =>
        reject(reader.error || new Error('No se pudo leer el archivo'));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error('No se pudo decodificar la imagen'));
        img.onload = () => {
          try {
            const ratio = Math.min(
              1,
              maxDim / Math.max(img.width, img.height),
            );
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * ratio);
            canvas.height = Math.round(img.height * ratio);
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('Canvas sin contexto 2D'));
              return;
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              (blob) => {
                if (!blob) {
                  reject(new Error('canvas.toBlob devolvió null'));
                  return;
                }
                resolve({ blob, previewUrl: URL.createObjectURL(blob) });
              },
              'image/jpeg',
              quality,
            );
          } catch (err) {
            reject(err);
          }
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Revoca la objectURL de preview si la actual es `blob:`. Llamar antes de
   * sobrescribir / borrar la foto para evitar memory leak.
   */
  private revokeFotoPreview(): void {
    const curr = this.currentExhibicion();
    const url = (curr as any)?.fotoBase64;
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* no-op */
      }
    }
  }

  /**
   * Elimina la foto del exhibidor
   */
  removeFoto() {
    this.revokeFotoPreview();
    this.currentExhibicion.update((curr) => ({
      ...curr,
      fotoBase64: undefined,
      _photoBlob: undefined,
    } as any));
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

    // Validación de nivel — devuelve al paso 4 si falta.
    // Previene bug donde algunas capturas llegaban sin nivelEjecucionId.
    if (!ex.nivelEjecucion || !ex.nivelEjecucionId) {
      this.toast.add({
        severity: 'error',
        summary: 'Evaluación requerida',
        detail: 'Debes evaluar la calidad de la ejecución antes de guardar.',
      });
      this.wizardStep = 4;
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

    // Vendedor: exige también el ticket procesado (al menos 1 producto confirmado
    // o el ticket procesado con 0 matches válidos pero foto del ticket subida).
    if (this.isVendedor()) {
      // Aceptar la visita si: hay ticket procesado, O el vendedor lo saltó
      // explícitamente (con confirmación). Cualquier otro caso = falta foto.
      if (!this.ticketResult() && !this.ticketSkipped()) {
        this.toast.add({
          severity: 'warn',
          summary: 'Falta el ticket',
          detail: 'Tomá la foto del ticket o tocá "Saltar ticket" antes de finalizar.',
        });
        this.wizardStep = 7;
        return;
      }
      // Persistir URL del ticket dentro del JSONB de la exhibición.
      const tr = this.ticketResult();
      (ex as any).ticket_foto_url = tr?.ticket_url || null;
      (ex as any).ticket_foto_public_id = tr?.ticket_public_id || null;
      (ex as any).ticket_skipped = this.ticketSkipped();
    }

    try {
      this.svc.addExhibicion(ex);
    } catch (err: any) {
      this.toast.add({
        severity: 'error',
        summary: 'Error al guardar exhibidor',
        detail: err?.message || 'No se pudo guardar.',
      });
      return;
    }
    this.toast.add({
      severity: 'success',
      summary: 'Exhibidor registrado',
      detail: 'Guardado en la visita actual.',
    });

    if (addAnother) {
      this.startWizard();
    } else {
      this.showWizard = false;
      this.unlockBodyScroll();
    }
  }

  /**
   * Se llama cuando el wizard se cierra (por X, click fuera, o tecla Escape)
   */
  onWizardHide() {
    this.unlockBodyScroll();
  }

  /**
   * Elimina un exhibidor de la lista
   * @param id ID del exhibidor a eliminar
   */
  onRemoveExhibicion(id: string) {
    this.confirmSvc.confirm({
      message:
        '¿Eliminar este exhibidor de la visita? Se perderán los productos marcados, foto y datos capturados.',
      header: 'Eliminar Exhibidor',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.removeExhibicion(id);
        this.toast.add({
          severity: 'info',
          summary: 'Exhibidor eliminado',
          detail: 'El exhibidor fue removido de la visita.',
        });
      },
    });
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
  trackById(_: number, c: { id?: string; pid?: string }): string {
    return c.id || c.pid || '';
  }

  /**
   * Formatea una fecha ISO a hora local
   * @param isoString Fecha en formato ISO
   * @returns Hora formateada o guion si es nulo
   */
  fmtScore(v: any): string { return v != null ? Math.round(v) + ' pts' : ''; }
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
