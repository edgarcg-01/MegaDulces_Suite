import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { fromEvent, merge, of, BehaviorSubject, interval, Subject, firstValueFrom, throwError, TimeoutError } from 'rxjs';
import { map, distinctUntilChanged, tap, filter, timeout, catchError } from 'rxjs/operators';
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
  /** Visitas que SÍ se reintentan (intentos < MAX). */
  visitasPendientes: number;
  /** Visitas en cap de reintentos: requieren acción manual del usuario. */
  visitasMuertas: number;
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
    visitasMuertas: 0,
    ultimoSync: null,
    errores: [],
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

  /**
   * Emite cuando al menos UNA visita pendiente acaba de sincronizar exitoso.
   * `DailyCaptureService` subscribe → recarga `loadTodayCaptures()` para que
   * el signal `_captures` deje de mostrar el badge `-PEND` (audit #7).
   */
  private _visitasSincronizadas$ = new Subject<void>();
  readonly visitasSincronizadas$ = this._visitasSincronizadas$.asObservable();

  // Configuración
  private readonly SYNC_INTERVAL_MS = 60000; // 1 minuto
  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly RETRY_DELAY_MS = 5000; // 5 segundos
  private readonly BATCH_SIZE = 10; // Procesar en lotes
  /** Timeout por visita en el POST a /daily-captures (fotos + cloudinary). */
  private readonly VISIT_POST_TIMEOUT_MS = 60_000;
  /** Watchdog: máximo tiempo razonable para una sincronización completa. */
  private readonly SYNC_WATCHDOG_MS = 120_000; // 2 minutos
  /** Cap a reintentos transient (500/timeout) por visita en un mismo proceso. */
  private readonly MAX_TRANSIENT_RETRIES = 20;
  /** Contador in-memory por visita: cuenta cuántos transient consecutivos. */
  private readonly _transientCount = new Map<string, number>();
  /**
   * Subject que la UI puede subscribir para reaccionar a sesión expirada
   * (audit #21). Cuando un sync devuelve 401, emite. El AppShell debería
   * forzar re-login o refresh del token.
   */
  private _sessionExpired$ = new Subject<void>();
  readonly sessionExpired$ = this._sessionExpired$.asObservable();

  /** Inicio del último ciclo de sync (epoch ms). 0 si no hay activo. */
  private _syncStartedAt = 0;
  private _watchdogTimer: any = null;

  constructor() {
    this.iniciarListenersConexion();
    this.iniciarSincronizacionPeriodica();
    this.actualizarEstadoInicial();
    this.iniciarListenersCapacitor();
  }

  /**
   * En builds nativos (Capacitor), el evento `online` rara vez se dispara
   * al reanudar la app — la conexión a menudo estuvo siempre presente
   * mientras la app estaba en background. Sin este listener, una visita
   * pendiente queda esperando hasta el próximo poll (60s) tras resume.
   * En web, `@capacitor/app` resuelve a un shim no-op y no pasa nada.
   */
  private async iniciarListenersCapacitor(): Promise<void> {
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return;
      const { App } = await import('@capacitor/app');
      App.addListener('appStateChange', (state) => {
        if (!state.isActive) return;
        if (!this._syncStatus.value.online || this._syncStatus.value.sincronizando) return;
        console.log('[OfflineSync] App.resume → sync inmediato');
        void this.sincronizarTodo().catch(() => {
          /* errores ya quedan en _syncStatus.errores */
        });
      });
    } catch (err) {
      // En entornos donde @capacitor/* no está disponible (SSR/test), no
      // bloqueamos el boot del servicio.
      console.warn('[OfflineSync] @capacitor/app no disponible (web build OK):', err);
    }
  }

  /**
   * Libera el flag `sincronizando` de forma atómica + cancela watchdog.
   * Helper único que TODO path de salida de `sincronizarTodo` debe usar.
   */
  private liberarSincronizando(opts: {
    errores?: string[];
    ultimoSync?: string | null;
    visitasPendientes?: number;
    visitasMuertas?: number;
  } = {}): void {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this._syncStartedAt = 0;
    const curr = this._syncStatus.value;
    this._syncStatus.next({
      ...curr,
      sincronizando: false,
      errores: opts.errores ?? curr.errores,
      ultimoSync: opts.ultimoSync !== undefined ? opts.ultimoSync : curr.ultimoSync,
      visitasPendientes:
        opts.visitasPendientes !== undefined ? opts.visitasPendientes : curr.visitasPendientes,
      visitasMuertas:
        opts.visitasMuertas !== undefined ? opts.visitasMuertas : curr.visitasMuertas,
    });
  }

  /**
   * Reset manual: para cuando la UI detecta que `sincronizando` quedó stuck
   * (>30s, ver `offline-status.component`). El usuario lo dispara con el
   * botón "Reiniciar sincronización".
   */
  resetEstadoSincronizacion(): void {
    if (!this._syncStatus.value.sincronizando) return;
    console.warn('[OfflineSync] reset manual del estado de sincronización (flag stuck)');
    this.liberarSincronizando({
      errores: ['Sincronización reiniciada manualmente (estaba colgada)'],
    });
  }

  /** Tiempo transcurrido desde que arrancó el ciclo de sync actual (ms). 0 si no hay activo. */
  getSyncElapsedMs(): number {
    return this._syncStartedAt ? Date.now() - this._syncStartedAt : 0;
  }

  /** Timer de debounce para el sync post-online (audit #26). */
  private _onlineDebounceTimer: any = null;

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
          // Debounce (audit #26): flapping de red dispara online/offline
          // varias veces seguidas → cancelamos el timer anterior antes de
          // programar uno nuevo. Sin esto, se acumulan setTimeouts y N syncs
          // intentan arrancar a la vez (el segundo+ tira "ya en progreso").
          if (this._onlineDebounceTimer) {
            clearTimeout(this._onlineDebounceTimer);
          }
          this._onlineDebounceTimer = setTimeout(() => {
            this._onlineDebounceTimer = null;
            void this.sincronizarTodo().catch(() => {
              /* errores ya quedan en _syncStatus.errores */
            });
          }, 2000);
        }
      })
    ).subscribe();
  }

  /** Audit #25: chequear que haya sesión antes de tirar requests a la API. */
  private hasAuthToken(): boolean {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('auth_token')) return true;
    } catch { /* no-op */ }
    if (typeof document === 'undefined') return false;
    return /(^|;)\s*auth_token\s*=/.test(document.cookie);
  }

  /**
   * Inicia sincronización periódica cuando está online
   */
  private iniciarSincronizacionPeriodica(): void {
    interval(this.SYNC_INTERVAL_MS).pipe(
      filter(
        () =>
          this._syncStatus.value.online &&
          !this._syncStatus.value.sincronizando &&
          this.hasAuthToken(), // audit #25
      ),
      tap(() => {
        const pendientes = this._syncStatus.value.visitasPendientes;
        if (pendientes > 0) {
          console.log(`[OfflineSync] Iniciando sincronización periódica (${pendientes} pendientes)`);
          void this.sincronizarTodo().catch(() => {
            /* errores ya quedan en _syncStatus.errores */
          });
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
        visitasMuertas: estadisticas.visitasMuertas,
        ultimoSync: estadisticas.ultimoSync,
      });
    } catch (error) {
      console.error('[OfflineSync] Error al obtener estado inicial:', error);
    }
  }

  /**
   * Lock cross-tab: si el browser soporta Web Locks (Chrome/Edge/Safari 16+),
   * envolvemos `sincronizarTodo` en un lock exclusivo. Sin esto, dos pestañas
   * abiertas (común en tablet de oficina + móvil) ejecutan el sync en
   * paralelo y compiten por las visitas pendientes en Dexie.
   *
   * `ifAvailable: true` → si otra tab ya lo tiene, no espera; retorna null.
   * El periodic interval lo recoge en el próximo ciclo desde la tab que sí
   * tiene el lock.
   */
  private readonly SYNC_LOCK_KEY = 'trademkt-offline-sync';

  async sincronizarTodo(): Promise<SyncResult> {
    if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks?.request) {
      const result = await navigator.locks.request(
        this.SYNC_LOCK_KEY,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            console.log('[OfflineSync] Otra pestaña ya está sincronizando — skip');
            return null;
          }
          return await this.sincronizarTodoInner();
        },
      );
      if (result === null) {
        return { exitosas: 0, fallidas: 0, errores: ['Lock no disponible (otra pestaña sincronizando)'] };
      }
      return result;
    }
    // Fallback: browsers viejos sin Web Locks (FF < 96 sin flag) caen al
    // path original — el guard in-memory `sincronizando` sigue siendo la
    // única defensa contra reentrancia dentro de la misma tab.
    return await this.sincronizarTodoInner();
  }

  private async sincronizarTodoInner(): Promise<SyncResult> {
    if (!this._syncStatus.value.online) {
      throw new Error('No hay conexión a internet');
    }

    if (this._syncStatus.value.sincronizando) {
      throw new Error('Sincronización ya en progreso');
    }

    // Marcar inicio + arrancar watchdog. Si el flow no termina en
    // SYNC_WATCHDOG_MS, forzamos reset para que el usuario no quede stuck.
    this._syncStartedAt = Date.now();
    this._syncStatus.next({
      ...this._syncStatus.value,
      sincronizando: true,
      errores: [],
    });
    this._watchdogTimer = setTimeout(() => {
      if (this._syncStatus.value.sincronizando) {
        console.error(
          `[OfflineSync] WATCHDOG: sync excedió ${this.SYNC_WATCHDOG_MS}ms — forzando reset`,
        );
        this.liberarSincronizando({
          errores: [
            `Sincronización abortada por watchdog (${this.SYNC_WATCHDOG_MS / 1000}s). Reintentando en próximo ciclo.`,
          ],
        });
      }
    }, this.SYNC_WATCHDOG_MS);

    let resultadoVisitas: SyncResult = { exitosas: 0, fallidas: 0, errores: [] };
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
      resultadoVisitas = await this.sincronizarVisitas();

      console.log('[OfflineSync] Sincronización completada:', resultadoVisitas);
      return resultadoVisitas;
    } catch (error) {
      console.error('[OfflineSync] Error en sincronización:', error);
      resultadoVisitas.errores.push(
        (error as Error)?.message || String(error),
      );
      throw error;
    } finally {
      // Garantizado: cualquier path de salida (happy, error, return, throw)
      // libera el flag + cancela watchdog. Antes esto vivía en happy+catch
      // por separado y podía quedar stuck si algo lanzaba entre medio.
      let pendientes = this._syncStatus.value.visitasPendientes;
      let muertas = this._syncStatus.value.visitasMuertas;
      try {
        const estadisticas = await this.db.getEstadisticasOffline();
        pendientes = estadisticas.visitasPendientes;
        muertas = estadisticas.visitasMuertas;
      } catch {
        /* si el estado falla, mantenemos los contadores anteriores */
      }
      this.liberarSincronizando({
        errores: resultadoVisitas.errores,
        ultimoSync: new Date().toISOString(),
        visitasPendientes: pendientes,
        visitasMuertas: muertas,
      });
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

      // Fase V offline: análisis diferido del ticket. Si la visita guardó una
      // foto de ticket sin red, corremos el OCR ahora (con conexión) y aplicamos
      // los productos detectados a la exhibición. Best-effort: si falla, la
      // captura igual se postea (no se pierde la visita).
      const exhibicionesFinal = await this.analizarTicketDiferidoSiAplica(
        visita,
        exhibicionesHidratadas,
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
        exhibiciones: exhibicionesFinal,
        stats: visita.stats,
        latitud: visita.latitud,
        longitud: visita.longitud,
        precision: visita.precision,
        store_id: storeId,
      };

      // Multipart en lugar de JSON+base64: el endpoint acepta ambos pero
      // multipart ahorra ~25% de wire (relevante en sync con muchas visitas
      // pendientes tras varias horas sin conexión).
      //
      // Timeout duro de VISIT_POST_TIMEOUT_MS para no quedar colgado por
      // cloudinary lento o network suspendido (browser mobile en background).
      // Si timeoutea, se lanza TimeoutError que el catch de abajo trata como
      // transient → reintenta en próximo ciclo.
      const formData = buildVisitFormData(payload);
      const response = await firstValueFrom(
        this.http
          .post<any>(`${this.apiUrl}/daily-captures`, formData)
          .pipe(
            timeout(this.VISIT_POST_TIMEOUT_MS),
            catchError((err) => {
              if (err instanceof TimeoutError) {
                return throwError(() =>
                  Object.assign(new Error('Timeout esperando respuesta del backend'), {
                    status: 0,
                    isTimeout: true,
                  }),
                );
              }
              return throwError(() => err);
            }),
          ),
      );
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

      // Reset contador de retries transient: la visita se sincronizó OK.
      this._transientCount.delete(visita.id);

      // Notificar a UI (DailyCaptureService recarga `_captures` → desaparece
      // el badge -PEND que antes se quedaba forever hasta refresh manual).
      this._visitasSincronizadas$.next();

    } catch (error: any) {
      // Timeouts del proxy/edge (502/503/504/408/522/524), network errors (0)
      // y 500 (server bug transitorio: migration faltante, deploy en curso,
      // DB lock) NO consumen el contador de retries — son transitorios.
      // Reintentamos en el próximo ciclo (60s).
      const TRANSIENT_STATUSES = new Set([0, 408, 500, 502, 503, 504, 522, 524]);
      const status = error?.status;
      // Mensajes específicos que no son del backend sino del flujo offline
      // mismo (tienda pendiente esperando POST). También transient.
      const msg = (error?.message || '') as string;
      const isLocalTransient =
        msg.includes('aún no sincronizada') ||
        msg.includes('Reintentar en próximo ciclo');

      // ── Audit #21: 401 → session expirada. NO incrementar nada, emitir
      // evento para que la UI fuerce re-login. La visita queda pendiente
      // intacta para el siguiente ciclo.
      if (status === 401) {
        console.warn(`[OfflineSync] Visita ${visita.id} sync FAIL · 401 → sesión expirada. Esperando re-login.`);
        this._sessionExpired$.next();
        throw error;
      }

      let isTransient = isLocalTransient || status === undefined || TRANSIENT_STATUSES.has(status);

      // ── Audit #22: cap a transient retries. Si una visita lleva 20 transient
      // consecutivos (eg. backend con bug determinístico que devuelve 500),
      // dejamos de tratarlo como transient → cuenta como intento fallido y
      // eventualmente va al pile de "muertas" para revisión manual.
      if (isTransient) {
        const count = (this._transientCount.get(visita.id) || 0) + 1;
        this._transientCount.set(visita.id, count);
        if (count >= this.MAX_TRANSIENT_RETRIES) {
          isTransient = false;
          console.error(
            `[OfflineSync] Visita ${visita.id} excedió ${this.MAX_TRANSIENT_RETRIES} retries transient consecutivos — degradando a non-transient para evitar loop infinito.`,
          );
        }
      } else {
        // Reset del contador cuando es un fallo no-transient (otro tipo de error).
        this._transientCount.delete(visita.id);
      }

      // Surface DETALLE del error para debugging — antes solo se logueaba
      // [OfflineSync] error transitorio (status=500) sin más info, lo que
      // hacía imposible diagnosticar por qué una visita no sincronizaba.
      const detail = error?.error?.message || error?.message || JSON.stringify(error);
      const fullLog = `[OfflineSync] Visita ${visita.id} sync FAIL · status=${status ?? '?'} · transient=${isTransient} · localTransient=${isLocalTransient} · detalle="${detail}"`;

      if (!isTransient) {
        console.error(fullLog + ` · ⚠️ intentos_fallidos++`);
        await this.db.incrementarIntentoFallido(visita.id, detail);
      } else {
        console.warn(fullLog + ` · reintentando en próximo ciclo`);
      }
      throw error;
    }
  }

  /**
   * Fase V offline: si la visita tiene un ticket pendiente de análisis, corre
   * el OCR (`/ai/ticket/extract`) con el blob guardado y aplica los productos
   * auto-confirmados a la PRIMERA exhibición (`productosMarcados`). Auto-aplica
   * sin revisión (decisión del flujo offline) + marca `ticket_analyzed_offline`.
   * Best-effort: si el OCR falla, deja las exhibiciones intactas y marca
   * `ticket_ocr_failed` — la captura se postea igual (no se pierde la visita).
   */
  private async analizarTicketDiferidoSiAplica(
    visita: VisitaPendiente,
    exhibiciones: any[],
  ): Promise<any[]> {
    if (!visita.ticketPendingAnalysis || !visita.ticketPhotoBlobId) {
      return exhibiciones;
    }
    try {
      const photo = await this.db.getPhoto(visita.ticketPhotoBlobId);
      if (!photo) return exhibiciones;
      const fd = new FormData();
      fd.append('file', photo.blob, 'ticket.jpg');
      const res: any = await firstValueFrom(
        this.http
          .post<any>(`${this.apiUrl}/ai/ticket/extract`, fd)
          .pipe(timeout(this.VISIT_POST_TIMEOUT_MS)),
      );
      const items: any[] = res?.match?.items || [];
      const productIds = items
        .filter((it) => it?.suggested?.autoConfirm && it?.suggested?.product_id)
        .map((it) => it.suggested.product_id as string);
      if (visita.stats && typeof visita.stats === 'object') {
        visita.stats.ticket_analyzed_offline = true;
      }
      // Aplica a la primera exhibición (modo vendedor = 1 exhibición + ticket).
      return exhibiciones.map((ex, i) =>
        i === 0 ? { ...ex, productosMarcados: productIds } : ex,
      );
    } catch (err) {
      console.warn(
        '[OfflineSync] OCR diferido del ticket falló; la captura se postea sin productos del ticket:',
        err,
      );
      if (visita.stats && typeof visita.stats === 'object') {
        visita.stats.ticket_ocr_failed = true;
      }
      return exhibiciones;
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

      // Persistir fotos como Blob en la tabla `photos` (Dexie v2).
      // Fuentes (en orden de preferencia):
      //   1. `_photoBlob: Blob` — flujo nuevo (compressImage usa canvas.toBlob).
      //   2. `fotoBase64: string` — solo si es data URL legacy (no objectURL).
      //      Una objectURL `blob:http://...` NO sobrevive el reload, así que
      //      si llega acá no tiene sentido persistirla.
      try {
        const exhibicionesProcesadas = await Promise.all(
          (datosVisita.exhibiciones || []).map(async (ex: any) => {
            const directBlob = ex?._photoBlob as Blob | undefined;
            const b64 = ex?.fotoBase64 as string | undefined;
            const isDataUrl = typeof b64 === 'string' && b64.startsWith('data:');

            if (!directBlob && !isDataUrl) {
              // Si fotoBase64 es objectURL (blob:...) la dropeamos en el rest
              // — no es persistible, y la imagen real ya debería estar en
              // _photoBlob. Si tampoco hay _photoBlob, la exhibición se
              // guarda sin foto (caso degradado, ya estaba antes).
              const { _photoBlob, fotoBase64, ...rest } = ex;
              return rest;
            }
            const input: Blob | string = directBlob ?? (b64 as string);
            const photoId = await this.db.savePhoto(visitaId, input);
            const { _photoBlob, fotoBase64, ...rest } = ex;
            return { ...rest, _photoBlobId: photoId };
          }),
        );
        await this.db.visitas.update(visitaId, { exhibiciones: exhibicionesProcesadas });
      } catch (photoErr) {
        console.warn('[OfflineSync] Error persistiendo fotos a Blob (la visita queda sin fotos):', photoErr);
      }

      // Fase V offline: persistir la foto del ticket como Blob + marcar pendiente
      // de análisis. El OCR (`/ai/ticket/extract`) corre en el sync (online).
      if (datosVisita.ticketBlob instanceof Blob) {
        try {
          const ticketPhotoId = await this.db.savePhoto(visitaId, datosVisita.ticketBlob);
          await this.db.visitas.update(visitaId, {
            ticketPhotoBlobId: ticketPhotoId,
            ticketPendingAnalysis: true,
          });
        } catch (tErr) {
          console.warn('[OfflineSync] Error persistiendo ticket Blob (visita sin ticket diferido):', tErr);
        }
      }

      // Actualizar contador de pendientes
      const estadoActual = this._syncStatus.value;
      this._syncStatus.next({
        ...estadoActual,
        visitasPendientes: estadoActual.visitasPendientes + 1
      });

      // Intentar sincronizar inmediatamente si está online.
      // Audit #27: si ya hay sync activo, NO lanzamos otro — el periodic
      // lo recoge en el próximo ciclo. Si no hay activo, dispara con catch
      // explícito para no producir unhandled rejection.
      if (estadoActual.online && !estadoActual.sincronizando) {
        setTimeout(() => {
          void this.sincronizarTodo().catch(() => {
            /* errores ya quedan en _syncStatus.errores */
          });
        }, 1000);
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

  /** Lista visitas atascadas (cap de reintentos) para la UI de revisión manual. */
  async getVisitasMuertas() {
    return this.db.getVisitasMuertas(this.MAX_RETRY_ATTEMPTS);
  }

  /** Resetea el contador de intentos de una visita y dispara sync inmediato. */
  async reintentarVisitaMuerta(visitaId: string): Promise<void> {
    await this.db.reintentarVisitaMuerta(visitaId);
    // Refrescar contadores y forzar sync si online.
    const estadisticas = await this.db.getEstadisticasOffline();
    const curr = this._syncStatus.value;
    this._syncStatus.next({
      ...curr,
      visitasPendientes: estadisticas.visitasPendientes,
      visitasMuertas: estadisticas.visitasMuertas,
    });
    if (curr.online && !curr.sincronizando) {
      this.sincronizarTodo().catch(() => {
        /* el error ya queda en _syncStatus.errores */
      });
    }
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
