import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, tap, forkJoin, catchError, of, throwError, from, map, firstValueFrom } from 'rxjs';
import {
  VisitaSnapshot,
  RegistroExhibicion,
  ConceptoExhibicion,
  UbicacionExhibicion,
  BrandGroup,
} from './daily-capture.models';
import { AuthService } from '../../../core/services/auth.service';
import { OfflineDailyCaptureService } from '../../../core/services/offline-daily-capture.service';
import { OfflineDatabaseService, TiendaOffline } from '../../../core/services/offline-database.service';
import { OfflineSyncService } from '../../../core/services/offline-sync.service';
import { buildVisitFormData } from '../../../core/http/visit-form-data';
import { todayMx } from '../../../core/utils/mx-date';
import { haversineMeters } from '../../../core/utils/geo';
import { environment } from '../../../../environments/environment';
import { calcularPuntosExhibicion } from '@megadulces/shared-scoring';

const SIMULATED_GPS_COORDS = { lat: 19.7033, lng: -101.1949 }; // Morelia, Michoacán
const ALLOW_SIMULATED_GPS_KEY = 'captures.allowSimulatedGps';
/**
 * Lee del localStorage si el usuario activó manualmente "permitir guardar sin
 * GPS". Por defecto NO se permite — guardar con coordenadas simuladas (Morelia)
 * contamina mapas/reports en silencio. Solo casos legítimos (campo sin señal
 * pero la tienda está validada) deben opt-in via Settings.
 */
function isSimulatedGpsAllowed(): boolean {
  try {
    return localStorage.getItem(ALLOW_SIMULATED_GPS_KEY) === 'true';
  } catch {
    return false;
  }
}

export type CaptureUserNotification =
  | { kind: 'simulated-coords'; source: string }
  | { kind: 'load-error'; summary: string; detail: string };

@Injectable({ providedIn: 'root' })
/**
 * Servicio principal para la gestión de capturas diarias de exhibidores.
 * Maneja el estado de visitas activas, catálogos de productos, y sincronización
 * con el backend y almacenamiento offline.
 */
export class DailyCaptureService {
  private auth = inject(AuthService);
  private http = inject(HttpClient);
  private offlineService = inject(OfflineDailyCaptureService);
  private offlineDb = inject(OfflineDatabaseService);
  private syncService = inject(OfflineSyncService);
  private apiUrl = environment.apiUrl;

  /**
   * Stream de notificaciones para que el componente las muestre como toast.
   * Se usa este patrón porque `MessageService` de PrimeNG vive a nivel de
   * componente (no root), por lo que inyectarlo aquí causa NG0200 cíclico.
   */
  private _notifications$ = new Subject<CaptureUserNotification>();
  readonly notifications$ = this._notifications$.asObservable();

  private notifySimulatedCoords(source: string) {
    this._notifications$.next({ kind: 'simulated-coords', source });
  }

  // --- Master Data (Fetched from API) ---
  /** Catálogo de conceptos de exhibición */
  private _conceptos = signal<ConceptoExhibicion[]>([]);
  readonly conceptos = this._conceptos.asReadonly();

  /** Catálogo de ubicaciones de exhibidores */
  private _ubicaciones = signal<UbicacionExhibicion[]>([]);
  readonly ubicaciones = this._ubicaciones.asReadonly();

  /** Productos agrupados por marca */
  private _groupedProducts = signal<BrandGroup[]>([]);
  readonly groupedProducts = this._groupedProducts.asReadonly();

  /** Configuración de scoring/evaluación */
  private _scoringConfig = signal<any>(null);
  readonly scoringConfig = this._scoringConfig.asReadonly();

  /** Niveles de ejecución disponibles */
  private _niveles = signal<any[]>([]);
  readonly niveles = this._niveles.asReadonly();

  // --- Active Visit State ---
  /** Hora de inicio de la visita activa */
  private _horaInicio = signal<string | null>(null);
  readonly horaInicio = this._horaInicio.asReadonly();
  /** Indica si hay una visita activa */
  readonly hasActiveVisit = computed(() => this._horaInicio() !== null);

  /** Latitud de la ubicación GPS */
  private _latitud = signal<number | null>(null);
  readonly latitud = this._latitud.asReadonly();

  /** Longitud de la ubicación GPS */
  private _longitud = signal<number | null>(null);
  readonly longitud = this._longitud.asReadonly();

  /** Tienda detectada por GPS */
  private _detectedStore = signal<{ id: string; nombre: string; distance: number } | null>(null);
  readonly detectedStore = this._detectedStore.asReadonly();

  /** Tiendas cercanas encontradas */
  private _nearbyStores = signal<{ id: string; nombre: string; distance: number }[]>([]);
  readonly nearbyStores = this._nearbyStores.asReadonly();

  /** Exhibidores registrados en la visita activa */
  private _activeExhibiciones = signal<RegistroExhibicion[]>([]);
  readonly activeExhibiciones = this._activeExhibiciones.asReadonly();

  // Fase V offline: foto del ticket que el vendedor tomó SIN red. Se difiere a
  // la cola offline; el OCR corre en el sync. Seteado desde captures.component.
  private _deferredTicket = signal<File | null>(null);
  setDeferredTicket(file: File | null): void {
    this._deferredTicket.set(file);
  }

  // --- Visit-Level Commercial Impact ---
  /** Venta adicional total de la visita */
  private _visitaVentaAdicional = signal<number>(0);
  readonly visitaVentaAdicional = this._visitaVentaAdicional.asReadonly();

  /** Rango de compra de la visita */
  private _visitaRangoCompra = signal<string>('');
  readonly visitaRangoCompra = this._visitaRangoCompra.asReadonly();

  // --- Captures History ---
  /** Historial de capturas realizadas */
  private _captures = signal<VisitaSnapshot[]>([]);
  readonly captures = this._captures.asReadonly();

  /** Asignación del usuario para HOY (route_name, etc.) — banner del header. */
  private _currentAssignment = signal<any | null>(null);
  readonly currentAssignment = this._currentAssignment.asReadonly();

  /**
   * Ruta activa de hoy (self-service). Fuente de verdad de con qué ruta se
   * etiquetan las capturas. Se resuelve: captura más reciente de hoy → asignación
   * recurrente (sugerida) → null (obliga a elegir antes de iniciar visita).
   */
  private _activeRoute = signal<{ id: string; name: string } | null>(null);
  readonly activeRoute = this._activeRoute.asReadonly();
  /** El usuario eligió ruta manualmente → no sobreescribir con la resolución. */
  private _routeChosen = false;

  /** Rutas de la zona del usuario para el selector "¿En qué ruta estás hoy?". */
  private _zoneRoutes = signal<{ label: string; value: string }[]>([]);
  readonly zoneRoutes = this._zoneRoutes.asReadonly();

  /**
   * Lista de visitas de hoy.
   * El backend ya filtra por scope (admins ven todo, capturistas ven lo suyo)
   * vía `userIdFilter` en daily-captures.controller. El frontend NO debe
   * re-filtrar por user.sub porque deja a los admins viendo 0.
   * @returns Lista de visitas de hoy
   */
  readonly visitasHoy = computed(() => {
    // "Hoy" en TZ MX para que coincida con `fechaCaptura` que el backend
    // ya guarda como día calendario local del negocio.
    const today = todayMx();
    return this._captures().filter((c) => c.fechaCaptura === today);
  });

  // --- Computed Stats for Active Capture ---
  /**
   * Calcula estadísticas de la captura activa
   * @returns Estadísticas de exhibidores, productos, puntuación y ventas
   */
  readonly stats = computed(() => {
    const exhibiciones = this._activeExhibiciones();
    let puntuacionTotal = 0;
    let ventaTotal = 0;
    let totalProductosMarcados = 0;

    exhibiciones.forEach((ex) => {
      puntuacionTotal += ex.puntuacionCalculada;
      ventaTotal += ex.ventaAdicional || 0;
      totalProductosMarcados += ex.productosMarcados.length;
    });

    return {
      totalExhibiciones: exhibiciones.length,
      totalProductosMarcados,
      puntuacionTotal: Math.round(puntuacionTotal),
      ventaTotal,
    };
  });

  // El porcentaje de ejecución individual por visita ha sido removido
  // ya que la nueva arquitectura de Primeros Principios evalúa puntos absolutos
  // contra la meta global del colaborador, no contra la visita iterativa.

  constructor() {
    // Reactively load data when user state becomes available
    effect(() => {
      const u = this.auth.user();
      if (u) {
        this.loadTodayCaptures();
        this.loadMasterData();
      }
    });

    // Cuando el sync background actualiza catálogos en Dexie, re-hidratamos
    // los signals (sin esperar refresh de página). Antes el usuario podía
    // ver el catálogo viejo hasta que recargara la página captures.
    this.syncService.catalogsRefreshed$.subscribe(() => {
      this._masterDataLoaded = false;
      void this.applyMasterDataFromCache();
    });

    // Cuando una visita pendiente sincroniza exitoso, refrescar `_captures`
    // para que el badge `-PEND` desaparezca sin requerir refresh de página
    // (audit #7).
    this.syncService.visitasSincronizadas$.subscribe(() => {
      void this.loadTodayCaptures();
    });
  }

  // --- Visit Lifecycle Actions ---
  /**
   * Inicia una nueva visita capturando la ubicación GPS
   * @returns true si se inició exitosamente
   * @throws Error si no se puede capturar la ubicación GPS
   */
  async iniciarVisita(): Promise<boolean> {
    this._horaInicio.set(new Date().toISOString());
    this._activeExhibiciones.set([]);
    this._latitud.set(null);
    this._longitud.set(null);
    // Limpiar deteccion previa: sin esto, la UI podia mostrar la tienda de
    // una visita anterior si por alguna razon clearActiveState no se ejecuto.
    this._detectedStore.set(null);
    this._nearbyStores.set([]);

    const MAX_RETRIES = 3;
    let gpsCapturado = false;
    let permissionDenied = false;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        await this.capturarUbicacion();
        const lat = this._latitud();
        const lng = this._longitud();
        if (lat && lng && lat !== 0 && lng !== 0) {
          gpsCapturado = true;
          this.guardarUltimaPosicionConocida(lat, lng);
          break;
        }
      } catch (err: any) {
        // GeolocationPositionError.code: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE,
        // 3=TIMEOUT. Reintentar con permiso denegado es UX rota — el usuario
        // tiene que ir a ajustes del navegador, no esperar 30s más.
        if (err?.code === 1) {
          permissionDenied = true;
          break;
        }
      }
    }

    if (permissionDenied) {
      this._horaInicio.set(null);
      this._activeExhibiciones.set([]);
      throw new Error(
        'Permiso de ubicación bloqueado. Activá el GPS para esta app en los ajustes del navegador (candado de la URL → Permisos → Ubicación) y volvé a intentar.',
      );
    }

    if (!gpsCapturado) {
      const ultimaPosicion = this.obtenerUltimaPosicionConocida();
      if (ultimaPosicion) {
        this._latitud.set(ultimaPosicion.lat);
        this._longitud.set(ultimaPosicion.lng);
      } else if (!navigator.onLine && isSimulatedGpsAllowed()) {
        // Solo si el usuario opt-in explícito (Settings → "Permitir guardar
        // sin GPS"). Default: rechazar para evitar contaminar mapas con
        // coords de Morelia silenciosamente.
        this.notifySimulatedCoords('iniciarVisita-offline');
        this._latitud.set(SIMULATED_GPS_COORDS.lat);
        this._longitud.set(SIMULATED_GPS_COORDS.lng);
      } else {
        this._horaInicio.set(null);
        this._activeExhibiciones.set([]);
        const offlineHint = !navigator.onLine
          ? ' Si estás sin señal y no podés esperar, activá "Permitir guardar sin GPS" en ajustes (la captura quedará marcada para revisión).'
          : '';
        throw new Error(
          'No se pudo capturar la ubicación GPS. Por favor verifique que el GPS esté activado y tenga señal.' + offlineHint,
        );
      }
    }

    // Critico: detectar la tienda SIEMPRE que tengamos coords (GPS real,
    // ultima conocida o simuladas). Antes solo se llamaba en el happy path,
    // por eso la 2da visita y los flujos offline quedaban sin tienda.
    await this.detectarTiendaCercana();
    return true;
  }

  async detectarTiendaCercana(radius = 30) {
    const lat = this._latitud();
    const lng = this._longitud();
    if (!lat || !lng) return;

    // 1. Intento online primero: el backend ya filtra por scope/zona y
    //    aplica reglas de negocio que el cliente no conoce.
    if (navigator.onLine) {
      try {
        const stores = await firstValueFrom(
          this.http.get<{ id: string; nombre: string; distance: number }[]>(
            `${this.apiUrl}/stores/nearby?lat=${lat}&lng=${lng}&radius=${radius}`,
          ),
        );
        this._nearbyStores.set(stores || []);
        this._detectedStore.set(stores && stores.length > 0 ? stores[0] : null);
        return;
      } catch {
        // Cae al fallback offline en lugar de dejar al usuario sin tienda.
      }
    }

    // 2. Fallback offline: Haversine sobre tiendas cacheadas en IndexedDB.
    //    `loadStoresData()` corre al login y mantiene el cache fresco; si
    //    el dispositivo nunca estuvo online, la lista estara vacia y el
    //    componente cae al banner de "registra la tienda" como hoy.
    try {
      const cached = await this.offlineDb.getTiendas();
      const nearby = cached
        .filter((s) => s.lat && s.lng)
        .map((s) => ({
          id: s.id,
          nombre: s.nombre,
          distance: Math.round(haversineMeters(lat, lng, s.lat, s.lng)),
        }))
        .filter((s) => s.distance <= radius)
        .sort((a, b) => a.distance - b.distance);

      this._nearbyStores.set(nearby);
      this._detectedStore.set(nearby[0] ?? null);
    } catch {
      this._nearbyStores.set([]);
      this._detectedStore.set(null);
    }
  }

  selectStore(store: { id: string; nombre: string; distance: number } | null) {
    this._detectedStore.set(store);
  }

  clearStoreDetection() {
    this._detectedStore.set(null);
    this._nearbyStores.set([]);
  }

  // --- Helpers para última posición conocida ---
  /**
   * Guarda la última posición GPS conocida en localStorage
   * @param lat Latitud
   * @param lng Longitud
   */
  private guardarUltimaPosicionConocida(lat: number, lng: number): void {
    try {
      localStorage.setItem(
        'ultimaPosicionGPS',
        JSON.stringify({ lat, lng, timestamp: new Date().toISOString() }),
      );
    } catch {
      /* localStorage lleno o bloqueado — ignorar */
    }
  }

  /**
   * Obtiene la última posición GPS conocida del localStorage
   * @returns Última posición conocida o null si no existe o es muy antigua
   */
  private obtenerUltimaPosicionConocida(): { lat: number; lng: number } | null {
    try {
      const data = localStorage.getItem('ultimaPosicionGPS');
      if (!data) return null;
      const posicion = JSON.parse(data);
      const edad = Date.now() - new Date(posicion.timestamp).getTime();
      const MAX_AGE = 24 * 60 * 60 * 1000; // 24 horas
      if (edad < MAX_AGE) {
        return { lat: posicion.lat, lng: posicion.lng };
      }
      localStorage.removeItem('ultimaPosicionGPS');
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Captura la ubicación GPS actual del dispositivo
   * @returns Objeto con latitud, longitud y precisión en metros
   * @throws Error si la geolocalización no está soportada o falla
   */
  capturarUbicacion(): Promise<{ lat: number; lng: number; precision: number }> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }

      const applyAndResolve = (
        pos: GeolocationPosition,
        resolveFn: typeof resolve,
      ) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const precision = pos.coords.accuracy;
        this._latitud.set(lat);
        this._longitud.set(lng);
        resolveFn({ lat, lng, precision });
      };

      // Intento 1: alta precisión (móvil con GPS activo).
      navigator.geolocation.getCurrentPosition(
        (pos) => applyAndResolve(pos, resolve),
        () => {
          // Fallback baja precisión (caché reciente si existe).
          navigator.geolocation.getCurrentPosition(
            (pos) => applyAndResolve(pos, resolve),
            (err2) => reject(err2),
            { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 },
          );
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }

  // --- Exhibition Actions ---
  /**
   * Agrega una exhibición a la visita activa calculando su puntuación
   * @param registro Datos de la exhibición sin ID, puntuación ni hora
   */
  addExhibicion(registro: Omit<RegistroExhibicion, 'id' | 'puntuacionCalculada' | 'horaRegistro'>) {
    // Defensa: nivel es obligatorio. Sin él, score = ubicacion × concepto × 1
    // (falsamente Alto).
    if (!registro.nivelEjecucion || !registro.nivelEjecucionId) {
      throw new Error(
        'Exhibición sin nivel de ejecución. Debe completar paso 4 del wizard.',
      );
    }

    const ubi = this._ubicaciones().find((u) => u.id === registro.ubicacionId);
    const con = this._conceptos().find((c) => c.id === registro.conceptoId);
    const niv = this._niveles().find(
      (n) => n.value.toLowerCase() === registro.nivelEjecucion?.toLowerCase(),
    );

    const puntuacionCalculada = Math.round(
      calcularPuntosExhibicion({
        posicionPuntuacion: Number(ubi?.puntuacion) || 0,
        conceptoPuntuacion: Number(con?.puntuacion) || 0,
        nivelPuntuacion: Number(niv?.puntuacion) || 1,
      }),
    );

    const exhibicion: RegistroExhibicion = {
      ...registro,
      id: crypto.randomUUID(),
      puntuacionCalculada,
      horaRegistro: new Date().toISOString(),
      nivelEjecucionId: registro.nivelEjecucionId || niv?.id,
    };

    this._activeExhibiciones.update((current) => [...current, exhibicion]);
  }

  /**
   * Calcula el score de una exhibición usando la fórmula canónica compartida.
   * Se usa en modo offline cuando el backend no está disponible.
   */
  calculateExhibicionScoreOffline(
    conceptoId: string,
    ubicacionId: string,
    nivelEjecucionId: string | undefined
  ): number {
    const concepto = this._conceptos().find(c => c.id === conceptoId);
    const ubicacion = this._ubicaciones().find(u => u.id === ubicacionId);
    const nivel = this._niveles().find(n => n.id === nivelEjecucionId);

    return Math.round(
      calcularPuntosExhibicion({
        posicionPuntuacion: Number(ubicacion?.puntuacion) || 0,
        conceptoPuntuacion: Number(concepto?.puntuacion) || 0,
        nivelPuntuacion: Number(nivel?.puntuacion) || 1,
      }),
    );
  }

  /**
   * Recalcula el puntuacionTotal de toda la visita usando la fórmula offline.
   * Útil para modo offline o para re-validar antes de enviar al backend.
   */
  calculateVisitScoreOffline(): number {
    const exhibiciones = this._activeExhibiciones();
    let total = 0;
    for (const ex of exhibiciones) {
      total += this.calculateExhibicionScoreOffline(
        ex.conceptoId,
        ex.ubicacionId,
        ex.nivelEjecucionId
      );
    }
    return total;
  }

  /**
   * Elimina una exhibición de la visita activa por su ID
   * @param id ID de la exhibición a eliminar
   */
  removeExhibicion(id: string) {
    this._activeExhibiciones.update((current) => current.filter((e) => e.id !== id));
  }

  /**
   * Limpia el estado de la visita activa
   */
  clearActiveState() {
    this._horaInicio.set(null);
    this._latitud.set(null);
    this._longitud.set(null);
    this._activeExhibiciones.set([]);
    this._detectedStore.set(null);
    this._nearbyStores.set([]);
    this._deferredTicket.set(null);
  }

  /**
   * Actualiza la venta adicional de la visita
   * @param valor Monto de venta adicional
   */
  updateVisitaVentaAdicional(valor: number) {
    this._visitaVentaAdicional.set(valor);
  }

  /**
   * Actualiza el rango de compra de la visita
   * @param rango Rango de compra
   */
  updateVisitaRangoCompra(rango: string) {
    this._visitaRangoCompra.set(rango);
  }

  /**
   * Productos más marcados por este usuario en los últimos `days` días.
   * Para la sección "Frecuentes" en step 5 — atajo cuando captura la misma
   * tienda repetidamente. Si `storeId` se pasa, scope a esa tienda.
   */
  getFrequentProducts(opts: { days?: number; limit?: number; storeId?: string } = {}): Observable<{ product_id: string; marks: number }[]> {
    const params: string[] = [];
    if (opts.days)    params.push(`days=${opts.days}`);
    if (opts.limit)   params.push(`limit=${opts.limit}`);
    if (opts.storeId) params.push(`storeId=${encodeURIComponent(opts.storeId)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.http.get<{ product_id: string; marks: number }[]>(
      `${this.apiUrl}/daily-captures/frequent-products${qs}`,
    );
  }

  /**
   * Guarda la captura total de la visita en el backend o offline
   * @returns Observable con el resultado de la operación
   */
  saveCapturaTotal(): Observable<any> {
    const s = this.stats();
    const user = this.auth.user();
    if (!user) return of(null);

    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    // Sufijo de 4 chars hex random para evitar colisión cuando dos vendedores
    // con la misma inicial guardan en el MISMO segundo. Resolución por seg
    // sola → 2/N usuarios con misma letra terminaba devolviendo la fila ajena
    // en el catch del UNIQUE (visita perdida silenciosa, ver audit #2).
    const rand = (typeof crypto !== 'undefined' && (crypto as any).getRandomValues
      ? (() => {
          const buf = new Uint16Array(1);
          (crypto as any).getRandomValues(buf);
          return buf[0].toString(16).padStart(4, '0');
        })()
      : Math.random().toString(16).slice(2, 6).padStart(4, '0'));
    const customFolio = `${user.username.charAt(0).toUpperCase()}-${hh}${mm}${ss}-${rand}`;
    const fechaInicio = this._horaInicio()!;
    const localDateStr = fechaInicio.split('T')[0];

    const latitud = this._latitud();
    const longitud = this._longitud();

    // Sin coordenadas válidas no enviamos: `0, 0` es el Golfo de Guinea y
    // contamina reports/mapas. La defensa en `iniciarVisita` ya debería
    // garantizarlas, este es el último cinturón.
    if (!latitud || !longitud) {
      return throwError(
        () =>
          new Error(
            'No hay ubicación GPS válida para esta visita. Re-inicia la visita capturando GPS antes de guardar.',
          ),
      );
    }

    const store = this._detectedStore();
    const rangoCompraVisita = this._visitaRangoCompra();
    const exhibicionesConRango = this._activeExhibiciones().map((ex) => ({
      ...ex,
      rangoCompra: rangoCompraVisita,
    }));

    // SIEMPRE recalculamos local con la fórmula offline para construir el
    // payload — el server hará su propio recálculo autoritativo en `daily-
    // captures.service.ts` con la versión activa de scoring_config. Antes
    // dependíamos de `navigator.onLine`, lo cual fallaba con captive portals
    // (onLine=true sin conexión real) → bug edge resuelto.
    const puntuacionTotal = this.calculateVisitScoreOffline();

    const statsForPayload = {
      ...s,
      puntuacionTotal,
      ventaAdicional: this._visitaVentaAdicional(),
      rangoCompra: rangoCompraVisita,
    };

    // sync_uuid generado per intento de guardado — si el POST falla y el
    // usuario reintenta sin querer (o un retry HTTP transparente lo duplica),
    // el backend hace deduplicación silenciosa via UNIQUE INDEX en sync_uuid.
    const syncUuid =
      typeof crypto !== 'undefined' && (crypto as any).randomUUID
        ? (crypto as any).randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const payload: any = {
      folio: customFolio,
      sync_uuid: syncUuid,
      fechaCaptura: localDateStr,
      horaInicio: this._horaInicio()!,
      horaFin: d.toISOString(),
      exhibiciones: exhibicionesConRango,
      stats: statsForPayload,
      latitud,
      longitud,
      store_id: store?.id || null,
      route_id: this._activeRoute()?.id || this._currentAssignment()?.route_id || null,
      // Nota: NO enviamos `_offline` al backend — lo añadimos solo al
      // response del offline-catch para que el componente lo identifique.
    };

    // Multipart en lugar de JSON+base64: ahorra ~25% de wire al evitar la
    // codificación base64 de las fotos (cada byte binario pasa de 1 byte
    // a ~1.33 bytes como string). El backend acepta ambos formatos, pero
    // multipart es el preferido para el flujo online.
    const formData = buildVisitFormData(payload);
    const deferredTicket = this._deferredTicket();

    // Fase V offline: si hay un ticket diferido (tomado sin red), forzamos el
    // path offline. La cola guarda la foto del ticket y corre el OCR en el sync
    // (inmediato si hay red). Así el ticket no se pierde aunque la conexión
    // haya vuelto justo al guardar, y el OCR siempre corre en el sync.
    const source$ = deferredTicket
      ? throwError(() => ({ status: 0, _deferredTicketOffline: true }))
      : this.http.post<any>(`${this.apiUrl}/daily-captures`, formData);

    return source$.pipe(
      tap((res: any) => {
        const parsedRes: VisitaSnapshot = {
          folio: res.folio,
          userId: res.user_id,
          fechaCaptura: this.formatDate(res.fecha || res.fechaCaptura),
          horaInicio: res.hora_inicio || res.horaInicio,
          horaFin: res.hora_fin || res.horaFin,
          capturedBy: res.captured_by_username || user?.username || 'Sistema',
          zona: res.zona_captura,
          routeId: res.route_id || this._activeRoute()?.id,
          exhibiciones:
            typeof res.exhibiciones === 'string'
              ? JSON.parse(res.exhibiciones)
              : res.exhibiciones || [],
          stats:
            typeof res.stats === 'string'
              ? JSON.parse(res.stats)
              : res.stats || {},
        };

        this._captures.update((curr) => [parsedRes, ...curr]);
        this.clearActiveState();
      }),
      catchError((error) => {
        // Considerar "no llegó al backend" tanto network errors puros
        // (status 0) como timeouts del proxy/edge (504/503/502/408/522/524).
        // En todos esos casos la visita NO se persistió en server y el UX
        // correcto es caer al path offline para no perder la captura.
        const TIMEOUT_STATUSES = new Set([408, 502, 503, 504, 522, 524]);
        const isNetworkError =
          !error.status ||
          error.status === 0 ||
          TIMEOUT_STATUSES.has(error.status);

        if (isNetworkError) {
          // Sin tienda no guardamos offline: el placeholder 'default' de
          // antes generaba registros que nunca podian sincronizar (FK a
          // stores.id rechaza valores no-UUID). La UI bloquea via
          // `needsStore`, pero esta es la red de seguridad final.
          if (!store?.id) {
            return throwError(
              () =>
                new Error(
                  'No hay tienda seleccionada. Selecciona una tienda antes de guardar la visita.',
                ),
            );
          }

          // Recuperar coordenadas de localStorage si payload llegó sin ellas
          // (no debería pasar tras la validación arriba, pero defensa extra).
          let lat = payload.latitud || this._latitud();
          let lng = payload.longitud || this._longitud();
          if (!lat || !lng) {
            const ultimaPosicion = this.obtenerUltimaPosicionConocida();
            if (ultimaPosicion) {
              lat = ultimaPosicion.lat;
              lng = ultimaPosicion.lng;
            } else if (isSimulatedGpsAllowed()) {
              // Opt-in explícito requerido — sin esto, rechazamos para no
              // contaminar reportes con coords de Morelia hardcoded.
              this.notifySimulatedCoords('saveCapturaTotal');
              lat = SIMULATED_GPS_COORDS.lat;
              lng = SIMULATED_GPS_COORDS.lng;
            } else {
              return throwError(
                () =>
                  new Error(
                    'Sin GPS válido y sin posición conocida. Activá "Permitir guardar sin GPS" en ajustes si necesitás guardar igual.',
                  ),
              );
            }
          }

          return from(
            this.offlineService.guardarCapturaOffline(
              store.id,
              user.sub,
              {
                horaInicio: payload.horaInicio,
                horaFin: payload.horaFin,
                exhibiciones: payload.exhibiciones,
                stats: payload.stats,
                latitud: lat,
                longitud: lng,
                precision: 20,
                // CRÍTICO: propagar el sync_uuid del intento online que falló.
                // Si el server escribió la visita pero no respondió (504),
                // el siguiente POST con el mismo sync_uuid hace dedup en lugar
                // de crear duplicado.
                syncUuid,
                // Fase V offline: foto del ticket a diferir (OCR en el sync).
                ticketBlob: deferredTicket || undefined,
              },
            ),
          ).pipe(
            tap(() => {
              const offlineRes: VisitaSnapshot = {
                folio: `${customFolio}-OFFLINE`,
                userId: user.sub,
                fechaCaptura: localDateStr,
                horaInicio: payload.horaInicio,
                horaFin: payload.horaFin,
                capturedBy: user.username,
                zona: 'Offline',
                exhibiciones: payload.exhibiciones,
                stats: payload.stats,
                _offline: true,
              };
              this._captures.update((curr) => [offlineRes, ...curr]);
              this.clearActiveState();
            }),
            map(
              () =>
                ({
                  folio: `${customFolio}-OFFLINE`,
                  user_id: user.sub,
                  fecha: localDateStr,
                  hora_inicio: payload.horaInicio,
                  hora_fin: payload.horaFin,
                  captured_by_username: user.username,
                  zona_captura: 'Offline',
                  exhibiciones: payload.exhibiciones,
                  stats: payload.stats,
                  latitud: payload.latitud,
                  longitud: payload.longitud,
                  _offline: true,
                }) as any,
            ),
            catchError((offlineError) =>
              throwError(
                () =>
                  new Error(
                    `Error de red y fallo al guardar offline: ${offlineError.message}`,
                  ),
              ),
            ),
          );
        }

        return throwError(() => error);
      }),
    );
  }

  private _todayCapturesInFlight = false;
  loadTodayCaptures() {
    if (this._todayCapturesInFlight) return;
    this._todayCapturesInFlight = true;
    // "Hoy" en TZ MX — coincide con la query del backend que ahora también
    // evalúa DATE() en MX. Antes (UTC) el filtro se "movía" al día siguiente
    // a partir de las 18:00 MX y la lista quedaba vacía.
    const today = todayMx();

    // NETWORK-FIRST: si offline detectado, usar cache + pendientes locales.
    // Si online, pedir directo al server (datos frescos) — el cache es respaldo.
    if (!navigator.onLine) {
      void this.applyTodayCapturesFromCacheAndPending(today);
      this._todayCapturesInFlight = false;
      return;
    }

    this.http.get<any[]>(`${this.apiUrl}/daily-captures?fecha=${today}`).subscribe({
      next: async (data: any[]) => {
        try {
          const parsedData = data.map((item) => ({
            folio: item.folio,
            userId: item.user_id,
            fechaCaptura: this.formatDate(item.fecha || item.fechaCaptura),
            horaInicio: item.hora_inicio || item.horaInicio,
            horaFin: item.hora_fin || item.horaFin,
            capturedBy: item.captured_by_username || 'Sistema',
            zona: item.zona_captura,
            routeId: item.route_id || undefined,
            exhibiciones:
              typeof item.exhibiciones === 'string'
                ? JSON.parse(item.exhibiciones)
                : item.exhibiciones || [],
            stats:
              typeof item.stats === 'string'
                ? JSON.parse(item.stats)
                : item.stats || {},
          }));
          // Persistir snapshot del server para fallback offline.
          try {
            await this.offlineDb.guardarCatalogo(
              'daily-captures-today' as any,
              parsedData,
              today,
            );
          } catch { /* cache best-effort */ }
          // Merge con visitas pendientes en Dexie (offline saves de hoy).
          await this.mergeTodayCapturesWithPending(parsedData);
          this.resolveActiveRoute();
        } catch {
          /* corrupt JSON en JSONB — ignorar para no romper la vista */
        } finally {
          this._todayCapturesInFlight = false;
        }
      },
      error: async () => {
        // Network falló online: fallback a cache + pendientes para no
        // dejar la lista vacía. Silencioso porque el badge offline-status
        // ya comunica el problema.
        await this.applyTodayCapturesFromCacheAndPending(today);
        this._todayCapturesInFlight = false;
      },
    });
  }

  /**
   * Hidrata la lista de visitas de hoy desde Dexie (cache del server) y
   * fusiona las visitas pendientes locales (offline-saves todavía no
   * sincronizadas). Garantiza que el usuario NUNCA ve la lista vacía
   * cuando ya capturó visitas en esta sesión, aunque estemos offline.
   */
  private async applyTodayCapturesFromCacheAndPending(today: string): Promise<void> {
    try {
      const [cached, pendientes] = await Promise.all([
        this.offlineDb.getCatalogo('daily-captures-today' as any),
        this.offlineDb.getVisitasPendientes(),
      ]);

      const userId = this.auth.user()?.sub;
      const fromCache: VisitaSnapshot[] =
        cached?.version === today && Array.isArray(cached.datos) ? cached.datos : [];
      const fromPending: VisitaSnapshot[] = (pendientes || [])
        .filter((v) => v.fecha === today && (!userId || v.userId === userId))
        .map((v) => this.pendingToSnapshot(v));

      // Dedup por folio o sync_uuid prefix.
      const merged = this.mergeCapturesUnique(fromCache, fromPending);
      if (merged.length > 0) this._captures.set(merged);
    } catch (err) {
      console.warn('[DailyCapture] Error aplicando cache/pendientes de hoy:', err);
    }
  }

  private async mergeTodayCapturesWithPending(serverList: VisitaSnapshot[]): Promise<void> {
    try {
      const pendientes = await this.offlineDb.getVisitasPendientes();
      const today = todayMx();
      const userId = this.auth.user()?.sub;
      const fromPending: VisitaSnapshot[] = (pendientes || [])
        .filter((v) => v.fecha === today && (!userId || v.userId === userId))
        .map((v) => this.pendingToSnapshot(v));
      this._captures.set(this.mergeCapturesUnique(serverList, fromPending));
    } catch {
      this._captures.set(serverList);
    }
  }

  /** Convierte una VisitaPendiente (Dexie) en VisitaSnapshot para la UI. */
  private pendingToSnapshot(v: any): VisitaSnapshot {
    return {
      folio: `${(v.id || '').substring(0, 8)}-PEND`,
      userId: v.userId,
      fechaCaptura: this.formatDate(v.fecha),
      horaInicio: v.horaInicio,
      horaFin: v.horaFin,
      capturedBy: this.auth.user()?.username || 'Sistema',
      zona: '',
      exhibiciones: v.exhibiciones || [],
      stats: v.stats || {},
      _offline: true,
    } as any;
  }

  /** Dedup por folio (server y pending no se solapan porque pending no tiene
   *  folio real hasta sincronizar — el `-PEND` es siempre único). */
  private mergeCapturesUnique(a: VisitaSnapshot[], b: VisitaSnapshot[]): VisitaSnapshot[] {
    const seen = new Set<string>();
    const out: VisitaSnapshot[] = [];
    for (const v of [...b, ...a]) {
      const key = v.folio || `${v.userId}-${v.horaInicio}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  /**
   * Crea una tienda offline. Devuelve el ID local temporal — la tienda
   * queda en Dexie `tiendas` (para Haversine inmediato) + `tiendasPendientes`
   * (queue de sync). El OfflineSyncService POSTea cuando hay red y remappea
   * el `tiendaId` en visitas pendientes hacia el serverId real.
   */
  async crearTiendaOffline(nombre: string, lat: number, lng: number): Promise<string> {
    const localId = await this.offlineDb.guardarTiendaPendiente(nombre, lat, lng);
    // Trigger sync inmediato si está online (no debería estarlo aquí, pero
    // defensa por si volvió la red entre el check y este punto).
    if (navigator.onLine) {
      setTimeout(() => {
        void this.offlineService.forzarSincronizacionManual().catch(() => {});
      }, 500);
    }
    return localId;
  }

  loadTodayAssignment() {
    const user = this.auth.user();
    if (!user) return;
    const day = new Date().getDay();
    const dayOfWeek = day === 0 ? 7 : day; // 1=Lun, 7=Dom

    // NETWORK-FIRST: si offline, usar cache directo. Si online, pedir server.
    if (!navigator.onLine) {
      void this.applyAssignmentFromCache(user.sub, dayOfWeek);
      return;
    }

    // Endpoint self-service `/me`: gateado por VISITAS_REGISTRAR, así funciona
    // para colaboradores/vendedores sin permiso de supervisor. El server fuerza
    // user_id = sub del JWT.
    this.http
      .get<any[]>(`${this.apiUrl}/daily-assignments/me?day_of_week=${dayOfWeek}`)
      .subscribe({
        next: async (data) => {
          const assignment = data && data.length > 0 ? data[0] : null;
          this._currentAssignment.set(assignment);
          this.resolveActiveRoute();
          // Persistir para el próximo fallback offline.
          try {
            await this.offlineDb.guardarCatalogo(
              'daily-assignment-today' as any,
              { assignment, userId: user.sub, dayOfWeek },
              new Date().toISOString().slice(0, 10),
            );
          } catch { /* cache best-effort */ }
        },
        error: async () => {
          // Fallback a cache si el server no respondió.
          await this.applyAssignmentFromCache(user.sub, dayOfWeek);
        },
      });
  }

  private async applyAssignmentFromCache(userId: string, dayOfWeek: number): Promise<void> {
    try {
      const cached = await this.offlineDb.getCatalogo('daily-assignment-today' as any);
      if (!cached?.datos) return;
      const { assignment, userId: cachedUser, dayOfWeek: cachedDay } = cached.datos as any;
      if (cachedUser === userId && cachedDay === dayOfWeek) {
        this._currentAssignment.set(assignment);
        this.resolveActiveRoute();
      }
    } catch { /* silent — no crítico */ }
  }

  /**
   * Resuelve la "ruta activa de hoy" sin pisar una elección manual del usuario:
   *   1. captura más reciente de hoy con route_id (sticky una vez que empezó)
   *   2. asignación recurrente del día (sugerencia del supervisor / propia)
   *   3. null → el selector "¿En qué ruta estás hoy?" obliga a elegir.
   * El nombre se resuelve contra `zoneRoutes`; si aún no cargó, cae al
   * route_name de la asignación o al id como placeholder (se refina al recargar
   * zoneRoutes, que vuelve a llamar este método).
   */
  private resolveActiveRoute(): void {
    if (this._routeChosen) return;

    const today = todayMx();
    const nameOf = (id: string): string => {
      const hit = this._zoneRoutes().find((r) => r.value === id);
      if (hit) return hit.label;
      const a = this._currentAssignment();
      if (a?.route_id === id && a?.route_name) return a.route_name;
      return id;
    };

    const recent = this._captures().find(
      (c) => c.fechaCaptura === today && c.routeId,
    );
    if (recent?.routeId) {
      this._activeRoute.set({ id: recent.routeId, name: nameOf(recent.routeId) });
      return;
    }

    const assignment = this._currentAssignment();
    if (assignment?.route_id) {
      this._activeRoute.set({
        id: assignment.route_id,
        name: assignment.route_name || nameOf(assignment.route_id),
      });
      return;
    }

    this._activeRoute.set(null);
  }

  /** Elección manual del colaborador en el selector de /captures. */
  setActiveRoute(route: { id: string; name: string } | null): void {
    this._routeChosen = !!route;
    this._activeRoute.set(route);
    const user = this.auth.user();
    if (route && user) {
      // Persistir hoy en self-service (recurrente por día de semana, pero el
      // colaborador puede cambiarla). No bloquea el flujo si falla.
      const day = new Date().getDay();
      const dayOfWeek = day === 0 ? 7 : day;
      this.http
        .post(`${this.apiUrl}/daily-assignments/me`, {
          route_id: route.id,
          day_of_week: dayOfWeek,
        })
        .subscribe({ next: () => {}, error: () => {} });
    }
  }

  /**
   * Roles globales que ven TODAS las rutas (supervisión/testing cross-zona).
   * El resto se scopea estrictamente a su zona — un colaborador/vendedor nunca
   * ve rutas de otra zona.
   */
  private static readonly GLOBAL_ROUTE_ROLES = new Set([
    'superadmin',
    'jefe_marketing',
  ]);

  /**
   * Carga las rutas para el selector. Colaboradores/vendedores: solo las rutas
   * de su zona + las rutas sin zona (parent_id NULL, legacy). Nunca rutas de
   * OTRAS zonas. Roles globales (superadmin/jefe_marketing): todas las rutas.
   */
  loadZoneRoutes(): void {
    const user = this.auth.user();
    if (!user) return;
    const zonaName = (user as any).zona as string | undefined;
    const roleName = ((user as any).role_name as string | undefined)?.toLowerCase();
    const seesAllRoutes = roleName
      ? DailyCaptureService.GLOBAL_ROUTE_ROLES.has(roleName)
      : false;

    const setFrom = (rutas: any[]) => {
      this._zoneRoutes.set(
        (rutas || []).map((r) => ({ label: r.value, value: r.id })),
      );
      this.resolveActiveRoute();
      void this.offlineDb
        .guardarCatalogo('zone-routes' as any, this._zoneRoutes(), todayMx())
        .catch(() => {});
    };

    if (!navigator.onLine) {
      void this.offlineDb
        .getCatalogo('zone-routes' as any)
        .then((c) => {
          if (c?.datos) this._zoneRoutes.set(c.datos as any);
          this.resolveActiveRoute();
        })
        .catch(() => {});
      return;
    }

    // Traemos zonas (para mapear nombre→id) y TODAS las rutas en paralelo, y
    // decidimos el scope en cliente.
    forkJoin({
      zonas: this.http
        .get<any[]>(`${this.apiUrl}/catalogs/zonas`)
        .pipe(catchError(() => of([] as any[]))),
      rutas: this.http
        .get<any[]>(`${this.apiUrl}/catalogs/rutas`)
        .pipe(catchError(() => of([] as any[]))),
    }).subscribe(({ zonas, rutas }) => {
      if (seesAllRoutes) {
        setFrom(rutas || []);
        return;
      }
      const zoneId = (zonas || []).find(
        (z) => (z.value || z.name) === zonaName,
      )?.id;
      const scoped = (rutas || []).filter(
        (r) => r.parent_id === zoneId || !r.parent_id,
      );
      setFrom(scoped);
    });
  }

  private _masterDataInFlight = false;
  private _masterDataLoaded = false;
  /**
   * Carga catalogos maestros (conceptos, ubicaciones, niveles, scoring).
   * Una vez cargados con exito, sucesivas llamadas son no-op para no
   * re-pegarle al backend en cada navegacion. Para forzar refresh ante
   * cambios de admin, llamar `reloadMasterData()`.
   */
  loadMasterData() {
    if (this._masterDataLoaded || this._masterDataInFlight) return;
    this._masterDataInFlight = true;

    // NETWORK-FIRST: si estamos online, vamos directo al server (datos
    // frescos). El cache Dexie es respaldo SOLO si:
    //   a) `navigator.onLine === false` (offline detectado)
    //   b) la request falla (network error / timeout)
    // Persistimos cada respuesta exitosa en Dexie para tener fallback fresco
    // la próxima vez que falle la red.
    if (!navigator.onLine) {
      void this.applyMasterDataFromCache().then((hit) => {
        this._masterDataInFlight = false;
        if (!hit) {
          console.warn('[DailyCapture] Offline + sin cache de catálogos: wizard limitado');
        }
      });
      this.loadPlanogramData();
      this.loadStoresData();
      return;
    }

    forkJoin({
      conceptos: this.http.get<any[]>(`${this.apiUrl}/catalogs/conceptos`),
      ubicaciones: this.http.get<any[]>(`${this.apiUrl}/catalogs/ubicaciones`),
      niveles: this.http.get<any[]>(`${this.apiUrl}/catalogs/niveles`),
      scoring: this.http.get<any>(`${this.apiUrl}/scoring/config`),
    }).subscribe({
      next: async (res) => {
        this._scoringConfig.set(res.scoring);
        this._niveles.set(res.niveles);
        this._conceptos.set(
          res.conceptos.map((c) => ({
            id: c.id,
            nombre: c.value,
            puntuacion: c.puntuacion,
            icono: c.icono,
          })),
        );
        this._ubicaciones.set(
          res.ubicaciones.map((u) => ({
            id: u.id,
            nombre: u.value,
            puntuacion: u.puntuacion,
          })),
        );
        this._masterDataInFlight = false;
        this._masterDataLoaded = true;
        // Persistir cache para el próximo fallback offline.
        try {
          const version = new Date().toISOString();
          await Promise.all([
            this.offlineDb.guardarCatalogo('conceptos', res.conceptos, version),
            this.offlineDb.guardarCatalogo('ubicaciones', res.ubicaciones, version),
            this.offlineDb.guardarCatalogo('niveles', res.niveles, version),
            this.offlineDb.guardarCatalogo('scoring', res.scoring, version),
          ]);
        } catch (cacheErr) {
          console.warn('[DailyCapture] Error cacheando catálogos en Dexie:', cacheErr);
        }
      },
      error: async () => {
        // Network falló (online según navigator pero el server no respondió):
        // fallback a cache Dexie si existe.
        console.warn('[DailyCapture] loadMasterData falló online, cayendo a cache');
        await this.applyMasterDataFromCache();
        this._masterDataInFlight = false;
      },
    });

    this.loadPlanogramData();
    this.loadStoresData();
  }

  /**
   * Hidrata signals de master data desde Dexie. Devuelve true si los 4
   * catálogos fundamentales estaban en cache. Usado como fallback cuando
   * la red está caída o aún no respondió en el cold-start.
   */
  private async applyMasterDataFromCache(): Promise<boolean> {
    try {
      const [conceptos, ubicaciones, niveles, scoring] = await Promise.all([
        this.offlineDb.getCatalogo('conceptos' as any),
        this.offlineDb.getCatalogo('ubicaciones' as any),
        this.offlineDb.getCatalogo('niveles' as any),
        this.offlineDb.getCatalogo('scoring' as any),
      ]);

      const hasAll = !!(conceptos?.datos && ubicaciones?.datos && niveles?.datos && scoring?.datos);
      if (!hasAll) return false;

      this._scoringConfig.set(scoring!.datos);
      this._niveles.set(niveles!.datos);
      this._conceptos.set(
        (conceptos!.datos as any[]).map((c) => ({
          id: c.id,
          nombre: c.value,
          puntuacion: c.puntuacion,
          icono: c.icono,
        })),
      );
      this._ubicaciones.set(
        (ubicaciones!.datos as any[]).map((u) => ({
          id: u.id,
          nombre: u.value,
          puntuacion: u.puntuacion,
        })),
      );
      // Marcamos loaded para que la UI pueda arrancar el wizard sin esperar red.
      // El network response llegando después puede REEMPLAZAR estos signals si
      // hay versión más nueva, sin bloquear la experiencia.
      this._masterDataLoaded = true;
      return true;
    } catch (err) {
      console.warn('[DailyCapture] Error leyendo cache de catálogos:', err);
      return false;
    }
  }

  /**
   * Fuerza recarga de master data (catalogos). Util cuando admin edita
   * conceptos/ubicaciones/niveles y los demas usuarios necesitan ver el cambio
   * sin recargar pestana.
   */
  reloadMasterData() {
    this._masterDataLoaded = false;
    this.loadMasterData();
  }

  /**
   * Descarga el catalogo completo de tiendas y lo guarda en IndexedDB para
   * que la deteccion offline (Haversine en cliente) tenga datos con que
   * trabajar. Versionado por timestamp del catalogo: si cache local esta
   * al dia, no redescarga.
   *
   * Mismo patron que `loadPlanogramData()`: silencioso ante errores de
   * red — confiamos en que el cache previo siga viable.
   */
  private async loadStoresData() {
    try {
      const cached = await this.offlineDb.getCatalogo('stores');
      const serverVersion = await firstValueFrom(
        this.http.get<{ version: string | null }>(
          `${this.apiUrl}/stores/version`,
        ),
      );

      const serverTime = serverVersion?.version
        ? new Date(serverVersion.version).getTime()
        : -1;
      const cachedTime = cached?.version
        ? new Date(cached.version).getTime()
        : 0;

      // Cache vigente — no hay que volver a bajar el bulk.
      if (cached && cachedTime >= serverTime && serverTime !== -1) {
        return;
      }

      const stores = await firstValueFrom(
        this.http.get<
          {
            id: string;
            nombre: string;
            direccion?: string;
            latitud: number | string;
            longitud: number | string;
            zona_id?: string;
          }[]
        >(`${this.apiUrl}/stores/all-for-sync`),
      );

      // Mapeo (backend usa latitud/longitud, IndexedDB usa lat/lng).
      const tiendasOffline: TiendaOffline[] = stores.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        lat: Number(s.latitud),
        lng: Number(s.longitud),
        direccion: s.direccion,
        zona: s.zona_id,
        ultima_sincronizacion: new Date().toISOString(),
      }));

      await this.offlineDb.guardarTiendas(tiendasOffline);
      await this.offlineDb.guardarCatalogo(
        'stores',
        stores,
        serverVersion?.version || new Date().toISOString(),
      );
    } catch {
      // Sin red o backend caido: confiamos en lo que ya este en Dexie.
    }
  }

  private _mapPlanogramData(data: any[]): BrandGroup[] {
    const sorted = [...data].sort((a: any, b: any) => a.nombre.localeCompare(b.nombre));
    return sorted.map((b: any) => ({
      marca: b.nombre,
      items: (b.productos || [])
        .sort((a: any, b: any) => a.nombre.localeCompare(b.nombre))
        .map((p: any) => ({
          pid: p.id,
          name: p.nombre,
          puntuacion: p.puntuacion,
        })),
    }));
  }

  private async loadPlanogramData() {
    try {
      const cached = await this.offlineDb.getCatalogo('planograma');
      const serverVersion = await firstValueFrom(
        this.http.get<{ version: string }>(
          `${this.apiUrl}/planograms/brands/version`,
        ),
      );

      const serverTime = serverVersion?.version
        ? new Date(serverVersion.version).getTime()
        : -1; // -1 = forzar descarga si version es null
      const cachedTime = cached?.version
        ? new Date(cached.version).getTime()
        : 0;

      if (cached && cachedTime >= serverTime && serverTime !== -1) {
        this._groupedProducts.set(this._mapPlanogramData(cached.datos));
        return;
      }

      const data = await firstValueFrom(
        this.http.get<any[]>(`${this.apiUrl}/planograms/brands`),
      );
      this._groupedProducts.set(this._mapPlanogramData(data));
      await this.offlineDb.guardarCatalogo(
        'planograma',
        data,
        serverVersion?.version || new Date().toISOString(),
      );
    } catch {
      // Fallback a cache si la descarga falla
      const cached = await this.offlineDb.getCatalogo('planograma');
      if (cached) {
        this._groupedProducts.set(this._mapPlanogramData(cached.datos));
      }
    }
  }

  refreshAll() {
    if (this.auth.isAuthenticated) {
      this.loadTodayCaptures();
      this.loadMasterData();
      this.loadTodayAssignment();
      this.loadZoneRoutes();
    }
  }

  /**
   * Formatea una fecha a formato YYYY-MM-DD. Si la entrada es inválida,
   * devuelve la entrada original como string (no pierde info).
   */
  private formatDate(dateStr: string | Date | undefined): string {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const iso = d.toISOString();
      return iso.split('T')[0];
    } catch {
      return typeof dateStr === 'string' ? dateStr : '';
    }
  }
}
