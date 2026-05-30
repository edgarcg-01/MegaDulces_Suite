import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { fromEvent, merge, of, BehaviorSubject, interval, Subject } from 'rxjs';
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

  /**
   * Emite cuando los catálogos en Dexie fueron actualizados por el sync.
   * Subscríbelo en DailyCaptureService (o cualquier consumer) para re-leer
   * desde Dexie cuando el server publicó cambios de admin sin tener que
   * recargar la página.
   */
  private _catalogsRefreshed$ = new Subject<void>();
  readonly catalogsRefreshed$ = this._catalogsRefreshed$.asObservable();

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

      // Catálogos son nice-to-have. Si fallan (504 del server, endpoint roto)
      // NO debe bloquear el sync de visitas — esas son lo crítico para no
      // perder data del usuario. Antes de este aislamiento, un 504 en
      // /catalogs/* dejaba las visitas atascadas indefinidamente en Dexie.
      try {
        await this.sincronizarCatalogos();
      } catch (catErr) {
        console.warn(
          '[OfflineSync] Catálogos fallaron, continuando con sync de visitas:',
          catErr,
        );
      }

      // CRÍTICO: sincronizar tiendas pendientes ANTES de visitas. Las visitas
      // que se crearon offline con tiendaId temporal local quedan ligadas a
      // la fila local de `tiendas`. Si la tienda aún no existe en backend, su
      // FK rechazaría la visita. Aquí POSTeamos las tiendas pendientes y
      // remappeamos los tiendaId locales en las visitas pendientes hacia el
      // serverId real.
      try {
        await this.sincronizarTiendasPendientes();
      } catch (storeErr) {
        console.warn(
          '[OfflineSync] Tiendas pendientes fallaron, continuando con visitas:',
          storeErr,
        );
      }

      // Sincronizar visitas — fuente real de verdad del trabajo del usuario.
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
      // Notificar a los consumers (DailyCaptureService recarga signals desde
      // Dexie) — antes los catálogos nuevos solo aparecían al recargar la
      // página, generando confusión con admins que editaban en runtime.
      this._catalogsRefreshed$.next();
    } catch (error) {
      console.error('[OfflineSync] Error sincronizando catálogos:', error);
      throw error;
    }
  }

  /**
   * Sincroniza tiendas creadas offline. POST /stores por cada una, captura
   * el serverId, marca como sincronizada y remappea visitas pendientes que
   * apuntaban al ID local hacia el serverId. Defense in depth: si el server
   * rechaza por validation (no transient), incrementamos intentos_fallidos
   * y eventualmente la descartamos (max 5 intentos como visitas).
   */
  private async sincronizarTiendasPendientes(): Promise<void> {
    const tiendasPendientes = await this.db.getTiendasPendientes();
    if (tiendasPendientes.length === 0) return;
    console.log(`[OfflineSync] Encontradas ${tiendasPendientes.length} tiendas pendientes`);

    for (const tienda of tiendasPendientes) {
      if (tienda.intentos_fallidos >= this.MAX_RETRY_ATTEMPTS) {
        console.warn(`[OfflineSync] Tienda ${tienda.id} alcanzó max intentos, skip.`);
        continue;
      }

      try {
        const response = await this.http
          .post<{ id: string; nombre: string }>(`${this.apiUrl}/stores`, {
            nombre: tienda.nombre,
            latitud: tienda.latitud,
            longitud: tienda.longitud,
          })
          .toPromise();

        if (!response?.id) throw new Error('Respuesta sin id de tienda');

        await this.db.marcarTiendaSincronizada(tienda.id, response.id);

        // Remappear visitas pendientes que apuntaban al tiendaId local.
        const visitasARemappear = (await this.db.getVisitasPendientes()).filter(
          (v) => v.tiendaId === tienda.id,
        );
        for (const v of visitasARemappear) {
          await this.db.actualizarTiendaIdVisita(v.id, response.id);
        }
        if (visitasARemappear.length > 0) {
          console.log(
            `[OfflineSync] Remappeadas ${visitasARemappear.length} visitas: tiendaId ${tienda.id} → ${response.id}`,
          );
        }
      } catch (error: any) {
        const TRANSIENT_STATUSES = new Set([0, 408, 502, 503, 504, 522, 524]);
        const status = error?.status;
        const isTransient = status === undefined || TRANSIENT_STATUSES.has(status);
        if (!isTransient) {
          await this.db.incrementarIntentoTiendaFallido(
            tienda.id,
            (error?.error?.message || error?.message || 'unknown') as string,
          );
        } else {
          console.warn(
            `[OfflineSync] Tienda ${tienda.id}: error transitorio (${status}), no cuenta como intento.`,
          );
        }
        // No throw — continuar con la siguiente tienda.
      }
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
      // SELF-HEALING: la visita guarda un UUID local de una tienda creada
      // offline; revisamos si esa tienda ya fue sincronizada con el server
      // y tiene serverId asignado. Si sí, lo usamos en lugar del local.
      // Esto cubre la race condition donde `marcarTiendaSincronizada` corrió
      // pero `actualizarTiendaIdVisita` no alcanzó a ejecutar (crash o cierre
      // de pestaña entre los dos pasos del sync).
      try {
        const pendingTienda = await this.db.tiendasPendientes.get(visita.tiendaId);
        if (pendingTienda?.sincronizado && pendingTienda.serverId) {
          console.log(
            `[OfflineSync] Self-heal: visita ${visita.id} tiendaId local ${visita.tiendaId} → server ${pendingTienda.serverId}`,
          );
          // Persistir el fix para no recalcular en cada intento.
          await this.db.actualizarTiendaIdVisita(visita.id, pendingTienda.serverId);
          return pendingTienda.serverId;
        }
        // Si la tienda local es pendiente pero aún no sincronizada, no podemos
        // postear la visita todavía — el FK del backend la rechazaría. Lanzar
        // error transitorio para que el siguiente ciclo de sync la procese
        // después de que sincronizarTiendasPendientes la haya creado.
        if (pendingTienda && !pendingTienda.sincronizado) {
          throw new Error(
            `Visita ${visita.id}: tienda local ${visita.tiendaId} aún no sincronizada al server. Reintentar en próximo ciclo.`,
          );
        }
      } catch (lookupErr) {
        // Si el lookup falla (ej. tabla no existe en Dexie v1), seguir con el
        // UUID tal cual — la mayoría de visitas usan tiendas reales del catálogo.
        if ((lookupErr as Error).message?.includes('aún no sincronizada')) throw lookupErr;
      }
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
      // Hidratar fotos: si la exhibición tiene `_photoBlobId` (Dexie v2),
      // levantamos el Blob de la tabla `photos` y lo pasamos a buildVisitFormData
      // vía `_photoBlob`. Si tiene fotoBase64 (Dexie v1 legacy), va por ese path.
      const exhibicionesHidratadas = await Promise.all(
        (visita.exhibiciones || []).map(async (ex: any) => {
          if (!ex?._photoBlobId) return ex;
          const photo = await this.db.getPhoto(ex._photoBlobId);
          if (!photo) {
            console.warn(`[OfflineSync] Photo blob ${ex._photoBlobId} no encontrada en Dexie; exhibición sin foto.`);
            return ex;
          }
          return { ...ex, _photoBlob: photo.blob };
        }),
      );

      // Preparar payload para el backend (mismo formato que daily-captures).
      //
      // IDEMPOTENCIA: enviamos visita.id (UUID v4 generado en el cliente al
      // crear la visita) como sync_uuid. Si el backend ya tiene una fila con
      // ese sync_uuid (porque un POST anterior contestó 504 pero sí escribió),
      // retorna la fila existente sin re-procesar — eliminando duplicados.
      const payload = {
        folio: visita.id.substring(0, 8), // Usar parte del UUID como folio
        sync_uuid: visita.id,
        fechaCaptura: visita.fecha,
        horaInicio: visita.horaInicio,
        horaFin: visita.horaFin,
        exhibiciones: exhibicionesHidratadas,
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

      // Marcar como sincronizada + limpiar fotos Blob asociadas (post-éxito).
      await this.db.marcarVisitaSincronizada(visita.id);
      try {
        const deleted = await this.db.deletePhotosByVisita(visita.id);
        if (deleted > 0) console.log(`[OfflineSync] ${deleted} fotos liberadas para visita ${visita.id}`);
      } catch (cleanErr) {
        console.warn('[OfflineSync] Error limpiando fotos de visita sincronizada:', cleanErr);
      }
      
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
      // Mensajes específicos que no son del backend sino del flujo offline
      // mismo (tienda pendiente esperando POST). También transient.
      const msg = (error?.message || '') as string;
      const isLocalTransient =
        msg.includes('aún no sincronizada') ||
        msg.includes('Reintentar en próximo ciclo');
      const isTransient = isLocalTransient || status === undefined || TRANSIENT_STATUSES.has(status);

      if (!isTransient) {
        await this.db.incrementarIntentoFallido(visita.id, error as string);
      } else {
        console.warn(
          `[OfflineSync] Visita ${visita.id}: error transitorio (status=${status ?? 'unknown'}, local=${isLocalTransient}), no se cuenta como intento fallido`,
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
      //
      // IDEMPOTENCIA: si `datosVisita.syncUuid` viene seteado (caso típico:
      // catchError de un POST online que falló con 504), lo usamos como
      // visita.id. Así el sync_uuid sigue siendo el MISMO valor que el server
      // pudo haber recibido en el POST fallido → backend dedup correcta vs
      // crear duplicado con UUID nuevo.
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
      }, datosVisita.syncUuid);

      // Migrar fotos base64 → Blob en tabla `photos` (Dexie v2).
      // Resulta en ~25% menos storage + evita serializar binarios al leer.
      // Después actualizamos la visita reemplazando fotoBase64 por _photoBlobId.
      try {
        const exhibicionesProcesadas = await Promise.all(
          (datosVisita.exhibiciones || []).map(async (ex: any) => {
            if (!ex?.fotoBase64) return ex;
            const photoId = await this.db.savePhoto(visitaId, ex.fotoBase64);
            const { fotoBase64, ...rest } = ex;
            return { ...rest, _photoBlobId: photoId };
          }),
        );
        await this.db.visitas.update(visitaId, { exhibiciones: exhibicionesProcesadas });
      } catch (photoErr) {
        // Si falla la migración, dejamos las fotos en base64 (fallback v1).
        // No bloqueamos el guardado offline porque la visita ya está persistida.
        console.warn('[OfflineSync] Fallback a fotoBase64 (no se pudo mover a Blob):', photoErr);
      }

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
