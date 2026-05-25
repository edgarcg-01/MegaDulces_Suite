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
import { OfflineDatabaseService } from '../../../core/services/offline-database.service';
import { buildVisitFormData } from '../../../core/http/visit-form-data';
import { todayMx } from '../../../core/utils/mx-date';
import { environment } from '../../../../environments/environment';
import { calcularPuntosExhibicion } from '@megadulces/shared-scoring';

const SIMULATED_GPS_COORDS = { lat: 19.7033, lng: -101.1949 }; // Morelia, Michoacán

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

    const MAX_RETRIES = 3;
    let gpsCapturado = false;

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
      } catch {
        // continúa reintentando
      }
    }

    if (!gpsCapturado) {
      const ultimaPosicion = this.obtenerUltimaPosicionConocida();
      if (ultimaPosicion) {
        this._latitud.set(ultimaPosicion.lat);
        this._longitud.set(ultimaPosicion.lng);
        return true;
      }

      if (!navigator.onLine) {
        this.notifySimulatedCoords('iniciarVisita-offline');
        this._latitud.set(SIMULATED_GPS_COORDS.lat);
        this._longitud.set(SIMULATED_GPS_COORDS.lng);
        return true;
      }

      this._horaInicio.set(null);
      this._activeExhibiciones.set([]);
      throw new Error(
        'No se pudo capturar la ubicación GPS. Por favor verifique que el GPS esté activado y tenga señal.',
      );
    }

    await this.detectarTiendaCercana();
    return true;
  }

  async detectarTiendaCercana(radius = 50) {
    const lat = this._latitud();
    const lng = this._longitud();
    if (!lat || !lng) return;

    try {
      const stores = await firstValueFrom(
        this.http.get<any[]>(
          `${this.apiUrl}/stores/nearby?lat=${lat}&lng=${lng}&radius=${radius}`,
        ),
      );
      this._nearbyStores.set(stores || []);
      this._detectedStore.set(stores && stores.length > 0 ? stores[0] : null);
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
    const customFolio = `${user.username.charAt(0).toUpperCase()}-${hh}${mm}${ss}`;
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

    const isOffline = !navigator.onLine;
    const puntuacionTotal = isOffline
      ? this.calculateVisitScoreOffline()
      : s.puntuacionTotal;

    const statsForPayload = {
      ...s,
      puntuacionTotal,
      ventaAdicional: this._visitaVentaAdicional(),
      rangoCompra: rangoCompraVisita,
    };

    const payload: any = {
      folio: customFolio,
      fechaCaptura: localDateStr,
      horaInicio: this._horaInicio()!,
      horaFin: d.toISOString(),
      exhibiciones: exhibicionesConRango,
      stats: statsForPayload,
      latitud,
      longitud,
      store_id: store?.id || null,
      // Nota: NO enviamos `_offline` al backend — lo añadimos solo al
      // response del offline-catch para que el componente lo identifique.
    };

    // Multipart en lugar de JSON+base64: ahorra ~25% de wire al evitar la
    // codificación base64 de las fotos (cada byte binario pasa de 1 byte
    // a ~1.33 bytes como string). El backend acepta ambos formatos, pero
    // multipart es el preferido para el flujo online.
    const formData = buildVisitFormData(payload);

    return this.http.post<any>(`${this.apiUrl}/daily-captures`, formData).pipe(
      tap((res: any) => {
        const parsedRes: VisitaSnapshot = {
          folio: res.folio,
          userId: res.user_id,
          fechaCaptura: this.formatDate(res.fecha || res.fechaCaptura),
          horaInicio: res.hora_inicio || res.horaInicio,
          horaFin: res.hora_fin || res.horaFin,
          capturedBy: res.captured_by_username || user?.username || 'Sistema',
          zona: res.zona_captura,
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
        // Detectar error de red: status 0 (cors/network) o offline conocido.
        const isNetworkError = !error.status || error.status === 0;

        if (isNetworkError) {
          // Recuperar coordenadas de localStorage si payload llegó sin ellas
          // (no debería pasar tras la validación arriba, pero defensa extra).
          let lat = payload.latitud || this._latitud();
          let lng = payload.longitud || this._longitud();
          if (!lat || !lng) {
            const ultimaPosicion = this.obtenerUltimaPosicionConocida();
            if (ultimaPosicion) {
              lat = ultimaPosicion.lat;
              lng = ultimaPosicion.lng;
            } else {
              this.notifySimulatedCoords('saveCapturaTotal');
              lat = SIMULATED_GPS_COORDS.lat;
              lng = SIMULATED_GPS_COORDS.lng;
            }
          }

          return from(
            this.offlineService.guardarCapturaOffline(
              store?.id ?? 'default',
              user.sub,
              {
                horaInicio: payload.horaInicio,
                horaFin: payload.horaFin,
                exhibiciones: payload.exhibiciones,
                stats: payload.stats,
                latitud: lat,
                longitud: lng,
                precision: 20,
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
    this.http.get<any[]>(`${this.apiUrl}/daily-captures?fecha=${today}`).subscribe({
      next: (data: any[]) => {
        try {
          const parsedData = data.map((item) => ({
            folio: item.folio,
            userId: item.user_id,
            fechaCaptura: this.formatDate(item.fecha || item.fechaCaptura),
            horaInicio: item.hora_inicio || item.horaInicio,
            horaFin: item.hora_fin || item.horaFin,
            capturedBy: item.captured_by_username || 'Sistema',
            zona: item.zona_captura,
            exhibiciones:
              typeof item.exhibiciones === 'string'
                ? JSON.parse(item.exhibiciones)
                : item.exhibiciones || [],
            stats:
              typeof item.stats === 'string'
                ? JSON.parse(item.stats)
                : item.stats || {},
          }));
          this._captures.set(parsedData);
        } catch {
          /* corrupt JSON en JSONB — ignorar para no romper la vista */
        } finally {
          this._todayCapturesInFlight = false;
        }
      },
      error: () => {
        this._todayCapturesInFlight = false;
        this._notifications$.next({
          kind: 'load-error',
          summary: 'No se pudieron cargar las visitas de hoy',
          detail: 'Verifica tu conexión e intenta refrescar la página.',
        });
      },
    });
  }

  loadTodayAssignment() {
    const user = this.auth.user();
    if (!user) return;
    const day = new Date().getDay();
    const dayOfWeek = day === 0 ? 7 : day; // 1=Lun, 7=Dom
    this.http
      .get<any[]>(
        `${this.apiUrl}/daily-assignments?user_id=${user.sub}&day_of_week=${dayOfWeek}`,
      )
      .subscribe({
        next: (data) => {
          this._currentAssignment.set(data && data.length > 0 ? data[0] : null);
        },
        error: () => {
          /* sin asignación visible si falla — no es crítico */
        },
      });
  }

  private _masterDataInFlight = false;
  loadMasterData() {
    // Dedup: el `effect()` del constructor y `refreshAll()` pueden disparar
    // esto en paralelo al cargar el componente.
    if (this._masterDataInFlight) return;
    this._masterDataInFlight = true;

    forkJoin({
      conceptos: this.http.get<any[]>(`${this.apiUrl}/catalogs/conceptos`),
      ubicaciones: this.http.get<any[]>(`${this.apiUrl}/catalogs/ubicaciones`),
      niveles: this.http.get<any[]>(`${this.apiUrl}/catalogs/niveles`),
      scoring: this.http.get<any>(`${this.apiUrl}/scoring/config`),
    }).subscribe({
      next: (res) => {
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
      },
      error: () => {
        this._masterDataInFlight = false;
      },
    });

    this.loadPlanogramData();
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
