import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { fromEvent, merge, of, BehaviorSubject, interval } from 'rxjs';
import { map, distinctUntilChanged, tap, filter } from 'rxjs/operators';
import { OfflineDatabaseService, VisitaPendiente, TiendaOffline } from './offline-database.service';
import { GeoValidationService, Coordenada } from './geo-validation.service';
import { buildVisitFormData } from '../http/visit-form-data';
import { todayMx } from '../utils/mx-date';
import { haversineMeters } from '../utils/geo';
import { environment } from '../../../environments/environment';

// UUID v4 lax (acepta cualquier hex; el FK del backend valida estructura real).
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Radio para reparacion retroactiva de tiendaId legacy ('default' o vacio).
// Coincide con el radio normal de deteccion online — solo aceptamos auto-fix
// si hay EXACTAMENTE una tienda dentro del radio, para no asignar a la
// equivocada cuando hay varias cercanas.
const RETROFIT_RADIUS_M = 50;

export interface SyncStatus {
  online: boolean;
  sincronizando: boolean;
  visitasPendientes: number;
  ultimoSync: string | null;
  errores: string[];
}

export interface SyncResult {
  exitosas: number;
  fallidas: number;
  errores: string[];
}

@Injectable({ providedIn: 'root' })
export class OfflineSyncService {
  private http = inject(HttpClient);
  private db = inject(OfflineDatabaseService);
  private geoValidation = inject(GeoValidationService);
  private apiUrl = environment.apiUrl;

  // Estado de sincronización
  private _syncStatus = new BehaviorSubject<SyncStatus>({
    online: navigator.onLine,
    sincronizando: false,
    visitasPendientes: 0,
    ultimoSync: null,
    errores: []
  });

  readonly syncStatus$ = this._syncStatus.asObservable();

  // Configuración
  private readonly SYNC_INTERVAL_MS = 60000; // 1 minuto
  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly RETRY_DELAY_MS = 5000; // 5 segundos
  private readonly BATCH_SIZE = 10; // Procesar en lotes

  constructor() {
    this.iniciarListenersConexion();
    this.iniciarSincronizacionPeriodica();
    this.actualizarEstadoInicial();
  }

  /**
   * Inicia los listeners de eventos de conexión
   */
  private iniciarListenersConexion(): void {
    merge(
      of(navigator.onLine),
      fromEvent(window, 'online').pipe(map(() => true)),
      fromEvent(window, 'offline').pipe(map(() => false))
    ).pipe(
      distinctUntilChanged(),
      tap(isOnline => {
        console.log(`[OfflineSync] Estado de conexión: ${isOnline ? 'online' : 'offline'}`);
        this._syncStatus.next({
          ...this._syncStatus.value,
          online: isOnline
        });

        if (isOnline) {
          // Pequeña espera para asegurar que la red esté estable
          setTimeout(() => this.sincronizarTodo(), 2000);
        }
      })
    ).subscribe();
  }

  /**
   * Inicia sincronización periódica cuando está online
   */
  private iniciarSincronizacionPeriodica(): void {
    interval(this.SYNC_INTERVAL_MS).pipe(
      filter(() => this._syncStatus.value.online && !this._syncStatus.value.sincronizando),
      tap(() => {
        const pendientes = this._syncStatus.value.visitasPendientes;
        if (pendientes > 0) {
          console.log(`[OfflineSync] Iniciando sincronización periódica (${pendientes} pendientes)`);
          this.sincronizarTodo();
        }
      })
    ).subscribe();
  }

  /**
   * Actualiza el estado inicial al iniciar el servicio
   */
  private async actualizarEstadoInicial(): Promise<void> {
    try {
      const estadisticas = await this.db.getEstadisticasOffline();
      this._syncStatus.next({
        ...this._syncStatus.value,
        visitasPendientes: estadisticas.visitasPendientes,
        ultimoSync: estadisticas.ultimoSync
      });
    } catch (error) {
      console.error('[OfflineSync] Error al obtener estado inicial:', error);
    }
  }

  /**
   * Sincroniza todos los datos pendientes
   */
  async sincronizarTodo(): Promise<SyncResult> {
    if (!this._syncStatus.value.online) {
      throw new Error('No hay conexión a internet');
    }

    if (this._syncStatus.value.sincronizando) {
      throw new Error('Sincronización ya en progreso');
    }

    this._syncStatus.next({
      ...this._syncStatus.value,
      sincronizando: true,
      errores: []
    });

    try {
      console.log('[OfflineSync] Iniciando sincronización completa');
      
      // Sincronizar catálogos primero
      await this.sincronizarCatalogos();
      
      // Sincronizar visitas
      const resultadoVisitas = await this.sincronizarVisitas();
      
      // Actualizar estado
      const estadisticas = await this.db.getEstadisticasOffline();
      this._syncStatus.next({
        ...this._syncStatus.value,
        sincronizando: false,
        visitasPendientes: estadisticas.visitasPendientes,
        ultimoSync: new Date().toISOString(),
        errores: resultadoVisitas.errores
      });

      console.log('[OfflineSync] Sincronización completada:', resultadoVisitas);
      return resultadoVisitas;

    } catch (error) {
      console.error('[OfflineSync] Error en sincronización:', error);
      
      this._syncStatus.next({
        ...this._syncStatus.value,
        sincronizando: false,
        errores: [error as string]
      });

      throw error;
    }
  }

  /**
   * Sincroniza los catálogos desde el servidor
   */
  private async sincronizarCatalogos(): Promise<void> {
    try {
      console.log('[OfflineSync] Sincronizando catálogos...');
      
      const [conceptos, ubicaciones, niveles, planograma, scoring] = await Promise.all([
        this.http.get<any[]>(`${this.apiUrl}/catalogs/conceptos`).toPromise(),
        this.http.get<any[]>(`${this.apiUrl}/catalogs/ubicaciones`).toPromise(),
        this.http.get<any[]>(`${this.apiUrl}/catalogs/niveles`).toPromise(),
        this.http.get<any[]>(`${this.apiUrl}/planograms/brands`).toPromise(),
        this.http.get<any>(`${this.apiUrl}/scoring/config`).toPromise()
      ]);

      const version = new Date().toISOString();

      // Preserve the existing planograma version if set by the caching layer
      const existingPlanograma = await this.db.getCatalogo('planograma');
      const planogramaVersion = existingPlanograma?.version || version;
      
      await Promise.all([
        this.db.guardarCatalogo('conceptos', conceptos, version),
        this.db.guardarCatalogo('ubicaciones', ubicaciones, version),
        this.db.guardarCatalogo('niveles', niveles, version),
        this.db.guardarCatalogo('planograma', planograma, planogramaVersion),
        this.db.guardarCatalogo('scoring', scoring, version)
      ]);

      console.log('[OfflineSync] Catálogos sincronizados correctamente');
    } catch (error) {
      console.error('[OfflineSync] Error sincronizando catálogos:', error);
      throw error;
    }
  }

  /**
   * Sincroniza las visitas pendientes
   */
  private async sincronizarVisitas(): Promise<SyncResult> {
    const resultado: SyncResult = {
      exitosas: 0,
      fallidas: 0,
      errores: []
    };

    try {
      const visitasPendientes = await this.db.getVisitasPendientes();
      console.log(`[OfflineSync] Encontradas ${visitasPendientes.length} visitas pendientes`);

      // Procesar en lotes para no sobrecargar el servidor
      for (let i = 0; i < visitasPendientes.length; i += this.BATCH_SIZE) {
        const lote = visitasPendientes.slice(i, i + this.BATCH_SIZE);
        
        for (const visita of lote) {
          try {
            await this.sincronizarVisitaIndividual(visita);
            resultado.exitosas++;
          } catch (error) {
            resultado.fallidas++;
            const errorMsg = `Visita ${visita.id}: ${error}`;
            resultado.errores.push(errorMsg);
            console.error(`[OfflineSync] Error sincronizando visita ${visita.id}:`, error);
          }
        }

        // Pequeña pausa entre lotes
        if (i + this.BATCH_SIZE < visitasPendientes.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      return resultado;
    } catch (error) {
      console.error('[OfflineSync] Error general sincronizando visitas:', error);
      throw error;
    }
  }

  /**
   * Resuelve el store_id que se mandara al backend al sincronizar una visita.
   *
   * - Si `visita.tiendaId` es un UUID valido → se respeta tal cual.
   * - Si es 'default' o vacio (legacy) → se intenta mapear via Haversine
   *   contra el catalogo de tiendas cacheado. Solo aceptamos auto-fix si
   *   hay UNA sola tienda dentro de `RETROFIT_RADIUS_M`; si hay multiples
   *   se marca como error de sync y queda pendiente para revision manual.
   * - Si no hay match alguno → error explicito y no se intenta sincronizar.
   *
   * El tiendaId reparado se persiste en IndexedDB para que el flujo no
   * vuelva a recalcular en cada intento de sync.
   */
  private async resolveStoreIdForSync(visita: VisitaPendiente): Promise<string> {
    if (UUID_REGEX.test(visita.tiendaId)) {
      return visita.tiendaId;
    }

    // Sin coords no se puede recalcular — fallaria igual el FK del backend.
    if (!visita.latitud || !visita.longitud) {
      throw new Error(
        `Visita ${visita.id} sin coordenadas y tiendaId invalido. Requiere asignacion manual.`,
      );
    }

    const cached = await this.db.getTiendas();
    const matches = cached
      .filter((s) => s.lat && s.lng)
      .map((s) => ({
        id: s.id,
        distance: haversineMeters(
          visita.latitud,
          visita.longitud,
          s.lat,
          s.lng,
        ),
      }))
      .filter((s) => s.distance <= RETROFIT_RADIUS_M)
      .sort((a, b) => a.distance - b.distance);

    if (matches.length === 0) {
      throw new Error(
        `Visita ${visita.id}: ninguna tienda dentro de ${RETROFIT_RADIUS_M}m de las coords. Requiere asignacion manual.`,
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Visita ${visita.id}: ${matches.length} tiendas posibles dentro de ${RETROFIT_RADIUS_M}m. Requiere asignacion manual para evitar ambiguedad.`,
      );
    }

    const resolved = matches[0].id;
    // Persistir el fix para no re-calcular en cada intento futuro.
    await this.db.actualizarTiendaIdVisita(visita.id, resolved);
    return resolved;
  }

  /**
   * Sincroniza una visita individual
   */
  private async sincronizarVisitaIndividual(visita: VisitaPendiente): Promise<void> {
    // Validar que no exceda los intentos máximos
    if (visita.intentos_fallidos >= this.MAX_RETRY_ATTEMPTS) {
      throw new Error(`Máximo de intentos de sincronización alcanzado (${this.MAX_RETRY_ATTEMPTS})`);
    }

    // Reparar tiendaId si vino con el placeholder legacy 'default' o vacio.
    // Pre-fix del 26-may-2026: las visitas offline se guardaban con
    // tiendaId='default' que rechaza el FK del backend. Aqui intentamos
    // identificar la tienda real via Haversine antes de mandar al servidor.
    const storeId = await this.resolveStoreIdForSync(visita);

    try {
      // Preparar payload para el backend (mismo formato que daily-captures)
      const payload = {
        folio: visita.id.substring(0, 8), // Usar parte del UUID como folio
        fechaCaptura: visita.fecha,
        horaInicio: visita.horaInicio,
        horaFin: visita.horaFin,
        exhibiciones: visita.exhibiciones,
        stats: visita.stats,
        latitud: visita.latitud,
        longitud: visita.longitud,
        precision: visita.precision,
        store_id: storeId,
      };

      // Multipart en lugar de JSON+base64: el endpoint acepta ambos pero
      // multipart ahorra ~25% de wire (relevante en sync con muchas visitas
      // pendientes tras varias horas sin conexión).
      const formData = buildVisitFormData(payload);
      const response = await this.http.post<any>(`${this.apiUrl}/daily-captures`, formData).toPromise();
      console.log('[OfflineSync] Respuesta del backend:', response);
      
      // Marcar como sincronizada
      await this.db.marcarVisitaSincronizada(visita.id);
      
      // Log exitoso
      await this.db.addSyncLog({
        tipo: 'visita',
        entidad_id: visita.id,
        estado: 'exitoso',
        mensaje: 'Sincronización exitosa',
        fecha: new Date().toISOString()
      });

      console.log(`[OfflineSync] Visita ${visita.id} sincronizada exitosamente`);

    } catch (error: any) {
      // Timeouts del proxy/edge (502/503/504/408/522/524) y network errors (0)
      // NO consumen el contador de retries — el problema es transitorio del
      // servidor, no de la visita. Reintentamos en el próximo ciclo (60s).
      const TRANSIENT_STATUSES = new Set([0, 408, 502, 503, 504, 522, 524]);
      const status = error?.status;
      const isTransient = status === undefined || TRANSIENT_STATUSES.has(status);

      if (!isTransient) {
        await this.db.incrementarIntentoFallido(visita.id, error as string);
      } else {
        console.warn(
          `[OfflineSync] Visita ${visita.id}: error transitorio (status=${status ?? 'unknown'}), no se cuenta como intento fallido`,
        );
      }
      throw error;
    }
  }

  /**
   * Guarda una visita offline (la usa el servicio de captura)
   */
  async guardarVisitaOffline(
    tiendaId: string | null,
    userId: string,
    datosVisita: any,
    ubicacion: Coordenada & { precision: number }
  ): Promise<string> {
    try {
      console.log('[OfflineSync] Guardando visita offline:', { tiendaId, userId, ubicacion });

      // Validar geolocalización (opcional - solo si hay tienda en catálogo)
      let flag_fraude = false;
      try {
        const tienda = await this.db.getTiendaById(tiendaId);
        if (tienda) {
          const validacion = this.geoValidation.validarUbicacion(
            ubicacion,
            { lat: tienda.lat, lng: tienda.lng }
          );
          flag_fraude = !validacion.valido || validacion.nivelConfianza === 'baja';
          console.log('[OfflineSync] Validación de ubicación:', validacion);
        } else {
          console.warn('[OfflineSync] Tienda no encontrada en catálogo, guardando sin validación');
        }
      } catch (geoError) {
        console.warn('[OfflineSync] Error en validación geográfica, continuando:', geoError);
      }

      // Guardar visita pendiente.
      // `fecha` debe ser el día calendario MX, no UTC — antes una visita
      // capturada offline a las 19:00 MX se persistía con la fecha del día
      // siguiente y al sincronizar terminaba mal agrupada en los reportes.
      const visitaId = await this.db.guardarVisitaPendiente({
        tiendaId: tiendaId ?? '',
        userId,
        fecha: todayMx(),
        horaInicio: datosVisita.horaInicio,
        horaFin: datosVisita.horaFin,
        latitud: ubicacion.lat,
        longitud: ubicacion.lng,
        precision: ubicacion.precision,
        exhibiciones: datosVisita.exhibiciones,
        stats: datosVisita.stats,
        flag_fraude
      });

      // Actualizar contador de pendientes
      const estadoActual = this._syncStatus.value;
      this._syncStatus.next({
        ...estadoActual,
        visitasPendientes: estadoActual.visitasPendientes + 1
      });

      // Intentar sincronizar inmediatamente si está online
      if (estadoActual.online) {
        setTimeout(() => this.sincronizarTodo(), 1000);
      }

      console.log(`[OfflineSync] Visita guardada offline: ${visitaId}`);
      return visitaId;

    } catch (error) {
      console.error('[OfflineSync] Error guardando visita offline:', error);
      throw error;
    }
  }

  /**
   * Fuerza la sincronización manual
   */
  async forzarSincronizacion(): Promise<SyncResult> {
    console.log('[OfflineSync] Forzando sincronización manual');
    return await this.sincronizarTodo();
  }

  /**
   * Limpia datos antiguos
   */
  async limpiarDatosAntiguos(): Promise<void> {
    console.log('[OfflineSync] Iniciando limpieza de datos antiguos');
    await this.db.limpiarDatosAntiguos();
  }

  /**
   * Obtiene estadísticas detalladas
   */
  async getEstadisticasDetalladas(): Promise<any> {
    const [estadisticas, logs] = await Promise.all([
      this.db.getEstadisticasOffline(),
      this.db.getSyncLogs(20)
    ]);

    return {
      ...estadisticas,
      logsRecientes: logs,
      estadoActual: this._syncStatus.value
    };
  }

  /**
   * Verifica el estado de conexión
   */
  verificarConexion(): boolean {
    return this._syncStatus.value.online;
  }

  /**
   * Obtiene el estado actual
   */
  getEstadoActual(): SyncStatus {
    return this._syncStatus.value;
  }
}
