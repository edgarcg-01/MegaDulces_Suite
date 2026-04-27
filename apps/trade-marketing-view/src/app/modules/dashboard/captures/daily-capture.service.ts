import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, forkJoin, catchError, of, throwError, from, map } from 'rxjs';
import {
  VisitaSnapshot,
  RegistroExhibicion,
  ConceptoExhibicion,
  UbicacionExhibicion,
  BrandGroup,
} from './daily-capture.models';
import { AuthService } from '../../../core/services/auth.service';
import { OfflineDailyCaptureService } from '../../../core/services/offline-daily-capture.service';
import { environment } from '../../../../environments/environment';

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
  private apiUrl = environment.apiUrl;

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

  /** Asignación actual del usuario */
  private _currentAssignment = signal<any | null>(null);
  readonly currentAssignment = this._currentAssignment.asReadonly();

  /**
   * Filtra las visitas realizadas hoy por el usuario actual
   * @returns Lista de visitas de hoy
   */
  readonly visitasHoy = computed(() => {
    const today = new Date().toISOString().split('T')[0];
    const user = this.auth.user();
    if (!user) return [];
    return this._captures().filter((c) => c.fechaCaptura === today && c.userId === user.sub);
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
      puntuacionTotal,
      ventaTotal,
    };
  });

  // --- Computed Max Score from Catalogs ---
  /**
   * Calcula el puntaje máximo posible según los catálogos
   * @returns Puntaje máximo calculado
   */
  readonly maxScore = computed(() => {
    const ubicaciones = this._ubicaciones();
    const conceptos = this._conceptos();
    const niveles = this._niveles();

    const maxUbicacion = Math.max(...ubicaciones.map(u => Number(u.puntuacion) || 0));
    const maxConcepto = Math.max(...conceptos.map(c => Number(c.puntuacion) || 0));
    const maxNivel = Math.max(...niveles.map(n => Number(n.puntuacion) || 0));

    return maxUbicacion * maxConcepto * maxNivel;
  });

  /**
   * Calcula el porcentaje de ejecución actual
   * @returns Porcentaje de ejecución (0-100)
   */
  readonly scorePercentage = computed(() => {
    const s = this.stats();
    const maxPerExhibicion = this.maxScore();
    const numExhibiciones = s.totalExhibiciones;
    
    // El máximo de la visita es el máximo por exhibición × número de exhibiciones
    const maxVisita = maxPerExhibicion * numExhibiciones;
    
    if (maxVisita === 0) return 0;
    return Math.round((s.puntuacionTotal / maxVisita) * 100);
  });

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
    console.log('[iniciarVisita] 🚀 Iniciando visita...');
    console.log('[iniciarVisita] Estado inicial de GPS:', { latitud: this._latitud(), longitud: this._longitud() });
    console.log('[iniciarVisita] Estado de conexión:', navigator.onLine ? 'online' : 'offline');

    this._horaInicio.set(new Date().toISOString());
    this._activeExhibiciones.set([]);
    this._latitud.set(null);
    this._longitud.set(null);

    // Intentar capturar ubicación al iniciar la visita (con reintentos)
    const MAX_RETRIES = 3;
    let gpsCapturado = false;

    for (let i = 0; i < MAX_RETRIES; i++) {
      console.log(`[iniciarVisita] 📡 Intento ${i + 1}/${MAX_RETRIES} de capturar GPS...`);
      try {
        await this.capturarUbicacion();
        
        // Verificar que se capturaron coordenadas válidas
        const lat = this._latitud();
        const lng = this._longitud();
        
        console.log(`[iniciarVisita] 📍 Coordenadas después de intento ${i + 1}:`, { latitud: lat, longitud: lng });
        
        if (lat && lng && lat !== 0 && lng !== 0) {
          console.log('[iniciarVisita] ✅ GPS capturado exitosamente (intento', i + 1, '):', lat, lng);
          gpsCapturado = true;
          // Guardar última posición conocida en localStorage
          this.guardarUltimaPosicionConocida(lat, lng);
          break;
        } else {
          console.warn('[iniciarVisita] ⚠️ GPS capturado pero coordenadas inválidas (intento', i + 1, '):', lat, lng);
        }
      } catch (error) {
        console.warn('[iniciarVisita] ❌ Error capturando GPS (intento', i + 1, '):', error);
      }
    }

    console.log('[iniciarVisita] Estado final de GPS después de reintentos:', { latitud: this._latitud(), longitud: this._longitud() });

    if (!gpsCapturado) {
      console.error('[iniciarVisita] ❌ No se pudo capturar GPS después de', MAX_RETRIES, 'intentos');
      
      // Intentar usar última posición conocida del localStorage
      const ultimaPosicion = this.obtenerUltimaPosicionConocida();
      if (ultimaPosicion) {
        console.warn('[iniciarVisita] 🔧 Usando ÚLTIMA POSICIÓN CONOCIDA:', ultimaPosicion);
        this._latitud.set(ultimaPosicion.lat);
        this._longitud.set(ultimaPosicion.lng);
        return true;
      }
      
      // Como último recurso, usar coordenadas simuladas cuando está offline
      const isOffline = !navigator.onLine;
      if (isOffline) {
        const SIMULATED_COORDS = { lat: 19.7033, lng: -101.1949 };
        console.warn('[iniciarVisita] 🔧 MODO OFFLINE: Usando coordenadas SIMULADAS (último recurso):', SIMULATED_COORDS);
        this._latitud.set(SIMULATED_COORDS.lat);
        this._longitud.set(SIMULATED_COORDS.lng);
        return true;
      }
      
      // No permitir iniciar visita sin GPS cuando está online
      this._horaInicio.set(null);
      this._activeExhibiciones.set([]);
      throw new Error('No se pudo capturar la ubicación GPS. Por favor verifique que el GPS esté activado y tenga señal.');
    }

    console.log('[iniciarVisita] ✅ Visita iniciada con GPS:', { latitud: this._latitud(), longitud: this._longitud() });
    return true;
  }

  // --- Helpers para última posición conocida ---
  /**
   * Guarda la última posición GPS conocida en localStorage
   * @param lat Latitud
   * @param lng Longitud
   */
  private guardarUltimaPosicionConocida(lat: number, lng: number): void {
    try {
      const posicion = {
        lat,
        lng,
        timestamp: new Date().toISOString()
      };
      localStorage.setItem('ultimaPosicionGPS', JSON.stringify(posicion));
      console.log('[GPS] 💾 Última posición guardada en localStorage:', posicion);
    } catch (error) {
      console.error('[GPS] Error al guardar última posición:', error);
    }
  }

  /**
   * Obtiene la última posición GPS conocida del localStorage
   * @returns Última posición conocida o null si no existe o es muy antigua
   */
  private obtenerUltimaPosicionConocida(): { lat: number; lng: number } | null {
    try {
      const data = localStorage.getItem('ultimaPosicionGPS');
      if (data) {
        const posicion = JSON.parse(data);
        const edad = Date.now() - new Date(posicion.timestamp).getTime();
        const MAX_AGE = 24 * 60 * 60 * 1000; // 24 horas
        
        if (edad < MAX_AGE) {
          console.log('[GPS] 📦 Última posición recuperada (edad:', Math.round(edad / 1000 / 60), 'minutos):', posicion);
          return { lat: posicion.lat, lng: posicion.lng };
        } else {
          console.warn('[GPS] ⚠️ Última posición muy antigua (>24 horas), ignorando');
          localStorage.removeItem('ultimaPosicionGPS');
          return null;
        }
      }
      return null;
    } catch (error) {
      console.error('[GPS] Error al recuperar última posición:', error);
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
        console.error('[GPS] Geolocalización no soportada en este navegador');
        reject('Geolocation not supported');
        return;
      }

      console.log('[GPS] Iniciando captura de ubicación...');

      // Coordenadas simuladas para desarrollo (Morelia, Michoacán)
      const SIMULATED_GPS = false; // Cambiar a true para usar coordenadas simuladas
      const SIMULATED_COORDS = {
        lat: 19.7033,
        lng: -101.1949,
        precision: 15
      };

      if (SIMULATED_GPS) {
        console.warn('[GPS] 🔧 Usando coordenadas SIMULADAS (modo desarrollo)');
        this._latitud.set(SIMULATED_COORDS.lat);
        this._longitud.set(SIMULATED_COORDS.lng);
        resolve(SIMULATED_COORDS);
        return;
      }

      // Intentar con alta precisión primero (timeout aumentado a 30s)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const precision = pos.coords.accuracy;

          this._latitud.set(lat);
          this._longitud.set(lng);

          console.log('[GPS] ✅ Señal GPS recuperada exitosamente:', {
            latitud: lat,
            longitud: lng,
            precision: precision + ' metros',
            timestamp: new Date(pos.timestamp).toISOString()
          });

          resolve({ lat, lng, precision });
        },
        (err) => {
          console.warn('[GPS] ⚠️ Error con GPS de alta precisión:', err.message, '- Código:', err.code);
          console.log('[GPS] Intentando con baja precisión...');

          // Intentar con baja precisión como fallback (timeout aumentado a 20s)
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const lat = pos.coords.latitude;
              const lng = pos.coords.longitude;
              const precision = pos.coords.accuracy;

              this._latitud.set(lat);
              this._longitud.set(lng);

              console.log('[GPS] ✅ Señal GPS recuperada (baja precisión):', {
                latitud: lat,
                longitud: lng,
                precision: precision + ' metros',
                modo: 'baja precisión'
              });

              resolve({ lat, lng, precision });
            },
            (err2) => {
              console.error('[GPS] ❌ Fallo absoluto de GPS:', err2.message, '- Código:', err2.code);
              console.warn('[GPS] 💡 Tip: Activa el GPS del navegador o usa coordenadas simuladas cambiando SIMULATED_GPS=true en el código');
              reject(err2);
            },
            {
              enableHighAccuracy: false,
              timeout: 20000, // Aumentado de 10s a 20s
              maximumAge: 60000
            }
          );
        },
        {
          enableHighAccuracy: true,
          timeout: 30000, // Aumentado de 20s a 30s
          maximumAge: 0
        }
      );
    });
  }

  // --- Exhibition Actions ---
  /**
   * Agrega una exhibición a la visita activa calculando su puntuación
   * @param registro Datos de la exhibición sin ID, puntuación ni hora
   */
  addExhibicion(registro: Omit<RegistroExhibicion, 'id' | 'puntuacionCalculada' | 'horaRegistro'>) {
    console.log('[addExhibicion] Called with:', registro);

    // 1. Resolve objects from Catalogs (Source of Truth)
    const ubi = this._ubicaciones().find((u) => u.id === registro.ubicacionId);
    const con = this._conceptos().find((c) => c.id === registro.conceptoId);
    const niv = this._niveles().find(n => n.value.toLowerCase() === registro.nivelEjecucion?.toLowerCase());

    console.log('[addExhibicion] Catalog lookup:');
    console.log('  - ubicaciones available:', this._ubicaciones());
    console.log('  - conceptos available:', this._conceptos());
    console.log('  - niveles available:', this._niveles());
    console.log('  - niveles structure:', this._niveles().map(n => ({ value: n.value, puntuacion: n.puntuacion })));
    console.log('  - registro.nivelEjecucion:', registro.nivelEjecucion);
    console.log('  - ubi found:', ubi);
    console.log('  - con found:', con);
    console.log('  - niv found:', niv);

    // 2. Base points from Catalog Items
    const puntosPosicion = Number(ubi?.puntuacion) || 0;
    const puntosConcepto = Number(con?.puntuacion) || 0;
    const multiplicador = Number(niv?.puntuacion) || 1; // Niveles ahora usan valores decimales: 1.0, 0.7, 0.4, 0.2

    console.log('[addExhibicion] Base points:');
    console.log('  - puntosPosicion:', puntosPosicion);
    console.log('  - puntosConcepto:', puntosConcepto);
    console.log('  - multiplicador:', multiplicador);

    // 3. Sumar puntos de productos marcados
    let puntosProductos = 0;
    if (registro.productosMarcados && registro.productosMarcados.length > 0) {
      this._groupedProducts().forEach((brand) => {
        brand.items.forEach((prod) => {
          if (registro.productosMarcados.includes(prod.pid)) {
            puntosProductos += Number(prod.puntuacion) || 0;
          }
        });
      });
    }

    // 4. Calcular puntuación total
    const puntuacionCalculada = (puntosPosicion + puntosConcepto + puntosProductos) * multiplicador;

    console.log('[addExhibicion] Final calculation:');
    console.log('  - puntosProductos:', puntosProductos);
    console.log('  - puntuacionCalculada:', puntuacionCalculada);

    const exhibicion: RegistroExhibicion = {
      ...registro,
      id: crypto.randomUUID(),
      puntuacionCalculada,
      horaRegistro: new Date().toISOString(),
    };

    this._activeExhibiciones.update((current) => [...current, exhibicion]);
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
   * Verifica si es después del horario de corte (6 PM)
   * @returns true si es después de las 6 PM
   */
  isPastCutoff(): boolean {
    const now = new Date();
    const hour = now.getHours();
    return hour >= 18; // 6 PM
  }

  /**
   * Guarda la captura total de la visita en el backend o offline
   * @returns Observable con el resultado de la operación
   */
  saveCapturaTotal(): Observable<any> {
    console.log('[saveCapturaTotal] Estado de conexión:', navigator.onLine ? 'online' : 'offline');

    const s = this.stats();
    const user = this.auth.user();
    if (!user) return of(null);

    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const customFolio = `${user.username.charAt(0).toUpperCase()}-${hh}${mm}${ss}`;
    // Usar la fecha de inicio de la visita para fechaCaptura (extraer del timestamp ISO)
    const fechaInicio = this._horaInicio()!;
    const localDateStr = fechaInicio.split('T')[0];

    const latitud = this._latitud();
    const longitud = this._longitud();

    console.log('[saveCapturaTotal] 📤 Enviando datos al backend:', {
      folio: customFolio,
      latitud: latitud,
      longitud: longitud,
      totalExhibiciones: s.totalExhibiciones,
      puntuacionTotal: s.puntuacionTotal,
      horaInicio: this._horaInicio(),
      horaFin: d.toISOString()
    });

    // Validar que tenemos coordenadas válidas
    if (!latitud || !longitud || latitud === 0 || longitud === 0) {
      console.warn('[saveCapturaTotal] ⚠️ GPS no disponible o inválido:', { latitud, longitud });
      console.warn('[saveCapturaTotal] 💡 El GPS debería haberse capturado al iniciar la visita');
    } else {
      console.log('[saveCapturaTotal] ✅ GPS disponible y válido:', { latitud, longitud });
    }

    const payload = {
      folio: customFolio,
      fechaCaptura: localDateStr,
      horaInicio: this._horaInicio()!,
      horaFin: d.toISOString(),
      exhibiciones: this._activeExhibiciones(),
      stats: {
        ...s,
        ventaAdicional: this._visitaVentaAdicional(),
        rangoCompra: this._visitaRangoCompra()
      },
      latitud: latitud || 0,
      longitud: longitud || 0,
    };

    console.log('[saveCapturaTotal] 📡 POST a /daily-captures con payload:', JSON.stringify(payload, null, 2));

    return this.http.post<any>(`${this.apiUrl}/daily-captures`, payload).pipe(
      tap((res: any) => {
        console.log('[saveCapturaTotal] ✅ Respuesta del backend:', res);
        console.log('[saveCapturaTotal] 💾 Datos guardados en BD:', {
          id: res.id,
          folio: res.folio,
          latitud: res.latitud,
          longitud: res.longitud,
          fecha: res.fecha,
          hora_inicio: res.hora_inicio
        });
        console.log('[saveCapturaTotal] Stats in response:', res.stats);

        const parsedRes: VisitaSnapshot = {
          folio: res.folio,
          userId: res.user_id,
          fechaCaptura: this.formatDate(res.fecha || res.fechaCaptura),
          horaInicio: res.hora_inicio || res.horaInicio,
          horaFin: res.hora_fin || res.horaFin,
          capturedBy: res.captured_by_username || user?.username || 'Sistema',
          zona: res.zona_captura,
          exhibiciones: typeof res.exhibiciones === 'string' ? JSON.parse(res.exhibiciones) : (res.exhibiciones || []),
          stats: typeof res.stats === 'string' ? JSON.parse(res.stats) : (res.stats || {})
        };

        console.log('[saveCapturaTotal] Parsed stats:', parsedRes.stats);

        this._captures.update((curr) => [parsedRes, ...curr]);
        this.clearActiveState();
      }),
      catchError((error) => {
        console.error('[saveCapturaTotal] ❌ Error al enviar al backend:', error);
        console.error('[saveCapturaTotal] Error details:', {
          status: error.status,
          statusText: error.statusText,
          message: error.message,
          errorType: error.error?.type || 'unknown'
        });

        // Detectar si es error de red (offline)
        const isNetworkError = !error.status || error.status === 0 || error.message?.includes('NetworkError') || error.message?.includes('ERR_INTERNET_DISCONNECTED');

        if (isNetworkError) {
          console.warn('[saveCapturaTotal] 📶 Detectado error de red, intentando guardar offline...');
          console.log('[saveCapturaTotal] Coordenadas actuales:', { latitud: this._latitud(), longitud: this._longitud() });
          console.log('[saveCapturaTotal] Coordenadas en payload:', { latitud: payload.latitud, longitud: payload.longitud });

          // Recuperar coordenadas de localStorage si están null
          let latitud = payload.latitud || this._latitud() || null;
          let longitud = payload.longitud || this._longitud() || null;
          
          if (!latitud || !longitud || latitud === 0 || longitud === 0) {
            const ultimaPosicion = this.obtenerUltimaPosicionConocida();
            if (ultimaPosicion) {
              console.warn('[saveCapturaTotal] 🔧 Recuperando coordenadas de localStorage:', ultimaPosicion);
              latitud = ultimaPosicion.lat;
              longitud = ultimaPosicion.lng;
            } else {
              // Coordenadas simuladas como último recurso
              const SIMULATED_COORDS = { lat: 19.7033, lng: -101.1949 };
              console.warn('[saveCapturaTotal] 🔧 Usando coordenadas SIMULADAS:', SIMULATED_COORDS);
              latitud = SIMULATED_COORDS.lat;
              longitud = SIMULATED_COORDS.lng;
            }
          }

          // Guardar offline con coordenadas recuperadas
          return from(this.offlineService.guardarCapturaOffline(
            'default', // tiendaId - ajustar según tu lógica
            user.sub,
            {
              horaInicio: payload.horaInicio,
              horaFin: payload.horaFin,
              exhibiciones: payload.exhibiciones,
              stats: payload.stats,
              latitud: latitud,
              longitud: longitud,
              precision: 20
            }
          )).pipe(
            tap((result) => {
              console.log('[saveCapturaTotal] ✅ Visita guardada offline:', result);
              
              // Crear una respuesta simulada para mantener consistencia
              const offlineRes: VisitaSnapshot = {
                folio: `${customFolio}-OFFLINE`,
                userId: user.sub,
                fechaCaptura: localDateStr,
                horaInicio: payload.horaInicio,
                horaFin: payload.horaFin,
                capturedBy: user.username,
                zona: 'Offline',
                exhibiciones: payload.exhibiciones,
                stats: payload.stats
              };

              this._captures.update((curr) => [offlineRes, ...curr]);
              this.clearActiveState();
            }),
            map(() => {
              // Retornar un objeto simulado para que el componente funcione
              return {
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
                _offline: true // Flag para identificar visitas offline
              } as any;
            }),
            catchError((offlineError) => {
              console.error('[saveCapturaTotal] ❌ Error también al guardar offline:', offlineError);
              return throwError(() => new Error(`Error de red y fallo al guardar offline: ${offlineError.message}`));
            })
          );
        }

        // Si no es error de red, propagar el error
        return throwError(() => error);
      })
    );
  }

  loadTodayCaptures() {
    const today = new Date().toISOString().split('T')[0];
    this.http.get<any[]>(`${this.apiUrl}/daily-captures?fecha=${today}`).subscribe({
        next: (data: any[]) => {
        const parsedData = data.map(item => ({
            folio: item.folio,
            userId: item.user_id,
            fechaCaptura: this.formatDate(item.fecha || item.fechaCaptura),
            horaInicio: item.hora_inicio || item.horaInicio,
            horaFin: item.hora_fin || item.horaFin,
            capturedBy: item.captured_by_username || 'Sistema',
            zona: item.zona_captura,
            exhibiciones: typeof item.exhibiciones === 'string' ? JSON.parse(item.exhibiciones) : (item.exhibiciones || []),
            stats: typeof item.stats === 'string' ? JSON.parse(item.stats) : (item.stats || {})          }));
          this._captures.set(parsedData);
        },
      error: (err) => console.error('Error fetching visits from server', err)
      });
  }

  loadTodayAssignment() {
    const user = this.auth.user();
    if (!user) return;

    const day = new Date().getDay(); 
    const dayOfWeek = day === 0 ? 7 : day; // 1=Mon, 7=Sun

    this.http.get<any[]>(`${this.apiUrl}/daily-assignments?user_id=${user.sub}&day_of_week=${dayOfWeek}`)
      .subscribe({
        next: (data) => {
          if (data && data.length > 0) {
            this._currentAssignment.set(data[0]);
          } else {
            this._currentAssignment.set(null);
          }
        },
        error: (err) => console.error('Error loading today assignment', err)
      });
  }

  loadMasterData() {
    forkJoin({
      conceptos: this.http.get<any[]>(`${this.apiUrl}/catalogs/conceptos`),
      ubicaciones: this.http.get<any[]>(`${this.apiUrl}/catalogs/ubicaciones`),
      niveles: this.http.get<any[]>(`${this.apiUrl}/catalogs/niveles`),
      planograma: this.http.get<any[]>(`${this.apiUrl}/planograms/brands`),
      scoring: this.http.get<any>(`${this.apiUrl}/scoring/config`),
    }).subscribe({
      next: (res) => {
        this._scoringConfig.set(res.scoring);
        this._niveles.set(res.niveles);
        // Mapear el catálogo de la BD (catalog_id, value) a la interfaz del UI (id, nombre)
        this._conceptos.set(
          res.conceptos.map((c) => ({
            id: c.id,
            nombre: c.value,
            puntuacion: c.puntuacion,
            icono: c.icono
          })),
        );

        this._ubicaciones.set(
          res.ubicaciones.map((u) => ({
            id: u.id,
            nombre: u.value,
            puntuacion: u.puntuacion,
          })),
        );

        // Mapear planograma: Marcas -> Productos
        this._groupedProducts.set(
          res.planograma.map((b) => ({
            marca: b.nombre,
            items: (b.productos || []).map((p: any) => ({
              pid: p.id,
              name: p.nombre,
              puntuacion: p.puntuacion,
            })),
          })),
        );
      },
      error: (err) =>
        console.error('Error loading master data from backend', err),
    });
  }

  // Manual trigger if needed by components
  /**
   * Refresca todos los datos del servicio
   */
  refreshAll() {
    if (this.auth.isAuthenticated) {
      this.loadTodayCaptures();
      this.loadMasterData();
      this.loadTodayAssignment();
    }
  }

  /**
   * Formatea una fecha a formato YYYY-MM-DD
   * @param dateStr Fecha a formatear
   * @returns Fecha formateada o string vacío
   */
  private formatDate(dateStr: string | Date | undefined): string {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toISOString().split('T')[0];
    } catch {
      return '';
    }
  }
}
