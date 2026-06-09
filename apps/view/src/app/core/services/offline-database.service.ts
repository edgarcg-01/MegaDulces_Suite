import Dexie, { Table } from 'dexie';
import { Injectable } from '@angular/core';

// Interfaces basadas en tu modelo existente
export interface TiendaOffline {
  id: string;
  nombre: string;
  lat: number;
  lng: number;
  direccion?: string;
  zona?: string;
  ultima_sincronizacion: string;
}

/**
 * Breadcrumb GPS (Fase 2 tiempos muertos). Ping periódico de posición que se
 * encola offline y se sincroniza en bulk a POST /reports/route-pings. `id` =
 * client_uuid (dedup idempotente server-side). `sincronizado=false` hasta que
 * el sync confirme.
 */
export interface RoutePing {
  id: string; // client_uuid (UUID v4 local)
  userId: string;
  routeId: string | null;
  capturedAt: string; // ISO del fix GPS
  lat: number;
  lng: number;
  accuracyM?: number;
  speedMps?: number;
  source: 'foreground' | 'background';
  sincronizado: boolean;
  intentos_fallidos: number;
}

export interface VisitaPendiente {
  id: string; // UUID v4 generado localmente
  tiendaId: string;
  userId: string;
  fecha: string;
  horaInicio: string;
  horaFin: string;
  latitud: number;
  longitud: number;
  precision: number;
  exhibiciones: any[]; // Tus exhibiciones existentes
  stats: any; // Stats del daily-capture
  sincronizado: boolean;
  intentos_fallidos: number;
  ultimo_intento: string;
  flag_fraude?: boolean; // Detectado en frontend
  // Fase V offline: foto del ticket guardada sin red. El OCR (`/ai/ticket/extract`)
  // se difiere al sync — ahí se llenan los productosMarcados de la exhibición.
  ticketPhotoBlobId?: string; // FK a photos.id (tabla de blobs Dexie v2)
  ticketPendingAnalysis?: boolean;
  // v4: venta del vendor-capture pendiente de POST a /commercial/vendor-sales.
  // El sync la postea DESPUÉS del POST exitoso a /daily-captures (necesita el
  // daily_capture_id devuelto por server para linkear). Si deferredFromTicket
  // y lines está vacío, el sync construye las líneas desde el OCR diferido.
  pendingSale?: PendingVendorSale;
}

export interface PendingVendorSale {
  store_id: string;
  sale_date: string;
  route_id: string | null;
  capture_ref: string;
  ticket_photo_url: string | null;
  ticket_cloudinary_public_id: string | null;
  lines: Array<{
    sku: string;
    product_name: string | null;
    quantity: number;
    confidence: string;
  }>;
  deferredFromTicket?: boolean;
  // Populado tras sync exitoso de la visita (response.id de /daily-captures).
  // Permite reintentar la venta sola si el POST de /commercial/vendor-sales
  // falla pero la visita ya quedó persistida en el server.
  daily_capture_id?: string;
}

export interface CatalogoOffline {
  id: string;
  tipo: 'ubicaciones' | 'conceptos' | 'niveles' | 'scoring' | 'planograma' | 'stores' | 'daily-captures-today' | 'daily-assignment-today';
  datos: any;
  version: string;
  ultima_sincronizacion: string;
}

export interface SyncLog {
  id: string;
  tipo: 'visita' | 'catalogo';
  entidad_id: string;
  estado: 'pendiente' | 'exitoso' | 'error';
  mensaje: string;
  fecha: string;
}

/**
 * v2: tabla `photos` separada. Las fotos se guardan como Blob (binario crudo)
 * en lugar de base64 dentro de `visitas.exhibiciones[].fotoBase64`. Beneficios:
 *
 * - **~25% menos storage** (base64 expande binario ~33%; Blob no).
 * - **Menos memory pressure**: no serializamos el blob al leer la visita.
 * - **Quota-safe**: Dexie maneja blobs grandes mejor que cadenas largas.
 *
 * Cada exhibición ahora referencia su foto con `_photoBlobId` (UUID).
 * Backward-compat: si una visita legacy todavía tiene `fotoBase64`, el sync
 * code la procesa igual (fallback path en `offline-sync.service.ts`).
 */
export interface PhotoBlob {
  id: string;       // UUID v4
  visitaId: string; // FK lógica a visitas.id (para limpieza en cascada)
  blob: Blob;
  mime: string;
  createdAt: string;
}

/**
 * v3: tiendas creadas offline pendientes de sincronización.
 * Al volver online, el sync POST /stores las crea en backend, recibe el ID
 * real, lo guarda en `serverId`, y vuelve a procesar visitas pendientes
 * que apuntaban al `id` local para remappearlas al serverId.
 */
export interface TiendaPendiente {
  id: string;           // UUID v4 generado localmente
  nombre: string;
  latitud: number;
  longitud: number;
  serverId?: string;    // Asignado tras POST exitoso
  sincronizado: boolean;
  intentos_fallidos: number;
  ultimo_intento: string;
}

@Injectable({ providedIn: 'root' })
export class OfflineDatabaseService extends Dexie {
  tiendas!: Table<TiendaOffline, string>;
  visitas!: Table<VisitaPendiente, string>;
  catalogos!: Table<CatalogoOffline, string>;
  syncLogs!: Table<SyncLog, string>;
  photos!: Table<PhotoBlob, string>;
  tiendasPendientes!: Table<TiendaPendiente, string>;
  routePings!: Table<RoutePing, string>;

  constructor() {
    super('TradeMarketingOfflineDB');

    this.version(1).stores({
      tiendas: 'id, nombre, zona, ultima_sincronizacion',
      visitas: 'id, tiendaId, userId, sincronizado, fecha, intentos_fallidos',
      catalogos: 'id, tipo, version, ultima_sincronizacion',
      syncLogs: 'id, tipo, entidad_id, estado, fecha'
    });

    // v2: tabla photos separada para Blobs. Migración no-destructiva: las
    // visitas v1 con fotoBase64 siguen funcionando vía fallback en el sync.
    this.version(2).stores({
      tiendas: 'id, nombre, zona, ultima_sincronizacion',
      visitas: 'id, tiendaId, userId, sincronizado, fecha, intentos_fallidos',
      catalogos: 'id, tipo, version, ultima_sincronizacion',
      syncLogs: 'id, tipo, entidad_id, estado, fecha',
      photos: 'id, visitaId, createdAt',
    });

    // v3: tabla tiendasPendientes para crear tiendas offline.
    // El sync las POSTea primero y luego remappea visitas pendientes que
    // apuntaban al ID local hacia el serverId recibido.
    this.version(3).stores({
      tiendas: 'id, nombre, zona, ultima_sincronizacion',
      visitas: 'id, tiendaId, userId, sincronizado, fecha, intentos_fallidos',
      catalogos: 'id, tipo, version, ultima_sincronizacion',
      syncLogs: 'id, tipo, entidad_id, estado, fecha',
      photos: 'id, visitaId, createdAt',
      tiendasPendientes: 'id, nombre, sincronizado, intentos_fallidos',
    });

    // v4: campo pendingSale en visitas (sin index — propiedad libre).
    // Misma definición de stores que v3; Dexie sube versión sin re-indexar.
    this.version(4).stores({
      tiendas: 'id, nombre, zona, ultima_sincronizacion',
      visitas: 'id, tiendaId, userId, sincronizado, fecha, intentos_fallidos',
      catalogos: 'id, tipo, version, ultima_sincronizacion',
      syncLogs: 'id, tipo, entidad_id, estado, fecha',
      photos: 'id, visitaId, createdAt',
      tiendasPendientes: 'id, nombre, sincronizado, intentos_fallidos',
    });

    // v5: tabla routePings (breadcrumbs GPS, Fase 2 tiempos muertos). `id` =
    // client_uuid. Index sincronizado para drenar la cola; capturedAt para orden.
    this.version(5).stores({
      tiendas: 'id, nombre, zona, ultima_sincronizacion',
      visitas: 'id, tiendaId, userId, sincronizado, fecha, intentos_fallidos',
      catalogos: 'id, tipo, version, ultima_sincronizacion',
      syncLogs: 'id, tipo, entidad_id, estado, fecha',
      photos: 'id, visitaId, createdAt',
      tiendasPendientes: 'id, nombre, sincronizado, intentos_fallidos',
      routePings: 'id, userId, sincronizado, capturedAt, intentos_fallidos',
    });

    // Hooks para auditoría
    this.visitas.hook('creating', (primKey, obj, trans) => {
      console.log(`[OfflineDB] Creando visita: ${obj.id}`);
    });

    this.visitas.hook('updating', (modifications, primKey, obj, trans) => {
      console.log(`[OfflineDB] Actualizando visita: ${primKey}`, modifications);
    });

    this.requestPersistentStorage();
  }

  /**
   * Pide al browser que marque este origen como "persistente" — sin esto
   * Chrome/Safari pueden evictar IndexedDB bajo presión de almacenamiento
   * (visitas pendientes desaparecen silenciosamente). Idempotente:
   * llamarlo varias veces es seguro. Best-effort: si el browser no lo
   * soporta o el usuario lo rechaza, seguimos funcionando igual.
   */
  private async requestPersistentStorage(): Promise<void> {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
      const already = await navigator.storage.persisted?.().catch(() => false);
      if (already) return;
      const granted = await navigator.storage.persist();
      console.log(`[OfflineDB] storage.persist() → ${granted ? 'concedido' : 'denegado'}`);
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate().catch(() => null);
        if (est?.quota && est?.usage) {
          const pct = Math.round((est.usage / est.quota) * 100);
          console.log(`[OfflineDB] Storage: ${(est.usage / 1024 / 1024).toFixed(1)}MB / ${(est.quota / 1024 / 1024).toFixed(0)}MB (${pct}%)`);
        }
      }
    } catch (err) {
      console.warn('[OfflineDB] requestPersistentStorage falló (no crítico):', err);
    }
  }

  // --- Tiendas ---
  async guardarTiendas(tiendas: TiendaOffline[]) {
    await this.transaction('rw', this.tiendas, async () => {
      await this.tiendas.clear();
      await this.tiendas.bulkPut(tiendas.map(tienda => ({
        ...tienda,
        ultima_sincronizacion: new Date().toISOString()
      })));
    });
    console.log(`[OfflineDB] Guardadas ${tiendas.length} tiendas`);
  }

  async getTiendas(): Promise<TiendaOffline[]> {
    return await this.tiendas.toArray();
  }

  async getTiendaById(id: string | null): Promise<TiendaOffline | undefined> {
    if (!id) return undefined;
    return await this.tiendas.get(id);
  }

  // --- Visitas Pendientes ---
  /**
   * @param idOverride si se pasa, se usa como `visita.id` en lugar de generar
   *   un UUID v4 nuevo. CRÍTICO para idempotencia: cuando el online falla
   *   tras commit en server, el catchError debe pasar el mismo syncUuid que
   *   se envió en el POST para que el sync background dedup contra ese mismo
   *   valor en lugar de crear duplicado con UUID nuevo.
   */
  async guardarVisitaPendiente(
    visita: Omit<VisitaPendiente, 'id' | 'sincronizado' | 'intentos_fallidos' | 'ultimo_intento'>,
    idOverride?: string,
  ): Promise<string> {
    const id = idOverride || crypto.randomUUID();
    const visitaCompleta: VisitaPendiente = {
      ...visita,
      id,
      sincronizado: false,
      intentos_fallidos: 0,
      ultimo_intento: new Date().toISOString()
    };

    // ON CONFLICT defensa: si por alguna razón llega 2 veces el mismo
    // idOverride (ej. user hace doble click + 2 catchErrors), no creamos
    // duplicado en Dexie. Usar `put` en vez de `add` cuando hay override.
    if (idOverride) {
      await this.visitas.put(visitaCompleta);
    } else {
      await this.visitas.add(visitaCompleta);
    }
    console.log(`[OfflineDB] Visita guardada localmente: ${id} (override=${!!idOverride})`);
    return id;
  }

  async getVisitasPendientes(): Promise<VisitaPendiente[]> {
    // Dexie con boolean usa 0/1 internamente, usamos filtro manual
    const todas = await this.visitas.toArray();
    return todas.filter(v => v.sincronizado === false);
  }

  async getVisitasPendientesPorUsuario(userId: string): Promise<VisitaPendiente[]> {
    const todas = await this.visitas.toArray();
    return todas.filter(visita => visita.sincronizado === false && visita.userId === userId);
  }

  async marcarVisitaSincronizada(visitaId: string): Promise<void> {
    const visita = await this.visitas.get(visitaId);
    if (!visita) {
      console.warn(`[OfflineDB] Visita no encontrada: ${visitaId}`);
      return;
    }

    await this.visitas.update(visitaId, { 
      sincronizado: true,
      ultimo_intento: new Date().toISOString()
    });
    console.log(`[OfflineDB] Visita marcada como sincronizada: ${visitaId}`);
  }

  /**
   * Actualiza el `tiendaId` de una visita pendiente. Se usa en el flujo de
   * sync para reparar retroactivamente visitas guardadas con el placeholder
   * legacy 'default' (antes del fix de offline stores).
   */
  async actualizarTiendaIdVisita(visitaId: string, tiendaId: string): Promise<void> {
    await this.visitas.update(visitaId, { tiendaId });
    console.log(`[OfflineDB] tiendaId reparado en visita ${visitaId} -> ${tiendaId}`);
  }

  async incrementarIntentoFallido(visitaId: string, error: string): Promise<void> {
    const visita = await this.visitas.get(visitaId);
    if (visita) {
      await this.visitas.update(visitaId, {
        intentos_fallidos: visita.intentos_fallidos + 1,
        ultimo_intento: new Date().toISOString()
      });
      
      // Log del error
      await this.addSyncLog({
        tipo: 'visita',
        entidad_id: visitaId,
        estado: 'error',
        mensaje: error,
        fecha: new Date().toISOString()
      });
    }
  }

  async limpiarVisitasSincronizadas(diasAntiguedad: number = 7): Promise<number> {
    const fechaLimite = new Date();
    fechaLimite.setDate(fechaLimite.getDate() - diasAntiguedad);
    
    // Obtener IDs de visitas sincronizadas antiguas
    const todas = await this.visitas.toArray();
    const aEliminar = todas
      .filter(visita => visita.sincronizado === true && new Date(visita.ultimo_intento) < fechaLimite)
      .map(v => v.id);
    
    // Eliminar en lotes
    await this.visitas.bulkDelete(aEliminar);
    
    console.log(`[OfflineDB] Eliminadas ${aEliminar.length} visitas sincronizadas antiguas`);
    return aEliminar.length;
  }

  // --- Catálogos ---
  async guardarCatalogo(tipo: string, datos: any, version: string): Promise<void> {
    // Use tipo as the document ID so put() always replaces the same entry
    const catalogo: CatalogoOffline = {
      id: tipo,
      tipo: tipo as any,
      datos,
      version,
      ultima_sincronizacion: new Date().toISOString()
    };

    await this.catalogos.put(catalogo);
    console.log(`[OfflineDB] Catálogo guardado: ${tipo} v${version}`);
  }

  async getCatalogo(tipo: string): Promise<CatalogoOffline | undefined> {
    return await this.catalogos.where('tipo').equals(tipo as any).first();
  }

  async getCatalogos(): Promise<CatalogoOffline[]> {
    return await this.catalogos.toArray();
  }

  // --- Sync Logs ---
  async addSyncLog(log: Omit<SyncLog, 'id'>): Promise<void> {
    await this.syncLogs.add({
      ...log,
      id: crypto.randomUUID()
    });
  }

  async getSyncLogs(limit: number = 50): Promise<SyncLog[]> {
    return await this.syncLogs
      .orderBy('fecha')
      .reverse()
      .limit(limit)
      .toArray();
  }

  async limpiarLogsAntiguos(diasAntiguedad: number = 30): Promise<number> {
    const fechaLimite = new Date();
    fechaLimite.setDate(fechaLimite.getDate() - diasAntiguedad);
    
    return await this.syncLogs
      .where('fecha').below(fechaLimite.toISOString())
      .delete();
  }

  // --- Utilidades ---
  /**
   * Estadísticas para la UI:
   *   - `visitasPendientes` = ACTIVAS (intentos < MAX_RETRY_ATTEMPTS=5). Estas
   *     sí se reintentan en cada ciclo de sync.
   *   - `visitasMuertas` = visitas que llegaron al cap de reintentos y NO se
   *     sincronizan más. Antes se mezclaban en `pendientes` → la UI decía
   *     "5 visitas pendientes" eternamente sin que el usuario supiera que
   *     ninguna era recuperable. Ahora separadas para acción manual.
   */
  async getEstadisticasOffline(): Promise<{
    visitasPendientes: number;
    visitasMuertas: number;
    tiendasOffline: number;
    catalogosActualizados: number;
    ultimoSync: string | null;
  }> {
    const MAX_RETRIES = 5;
    const [todas, tiendas, catalogos] = await Promise.all([
      this.getVisitasPendientes(),
      this.getTiendas(),
      this.getCatalogos(),
    ]);

    const activas = todas.filter((v) => (v.intentos_fallidos || 0) < MAX_RETRIES).length;
    const muertas = todas.length - activas;

    const ultimoSync = await this.syncLogs
      .orderBy('fecha')
      .reverse()
      .first();

    return {
      visitasPendientes: activas,
      visitasMuertas: muertas,
      tiendasOffline: tiendas.length,
      catalogosActualizados: catalogos.length,
      ultimoSync: ultimoSync?.fecha || null,
    };
  }

  /** Visitas pendientes que llegaron al cap de reintentos (necesitan acción manual). */
  async getVisitasMuertas(maxRetries = 5): Promise<VisitaPendiente[]> {
    const todas = await this.visitas.toArray();
    return todas.filter(
      (v) => v.sincronizado === false && (v.intentos_fallidos || 0) >= maxRetries,
    );
  }

  /** Resetea el contador de intentos de una visita muerta → vuelve a la cola activa. */
  async reintentarVisitaMuerta(visitaId: string): Promise<void> {
    await this.visitas.update(visitaId, {
      intentos_fallidos: 0,
    });
    console.log(`[OfflineDB] Visita ${visitaId} reseteada para nuevo intento`);
  }

  async limpiarDatosAntiguos(): Promise<void> {
    await Promise.all([
      this.limpiarVisitasSincronizadas(7),
      this.limpiarLogsAntiguos(30),
      this.limpiarPhotosHuerfanas(),
    ]);
    console.log('[OfflineDB] Limpieza de datos antiguos completada');
  }

  // --- Photos (Blob storage) ---

  /**
   * Guarda una foto como Blob asociada a una visita. Devuelve el photoId
   * que la exhibición debe almacenar como `_photoBlobId` para luego
   * recuperar el Blob al sincronizar.
   *
   * @param visitaId ID de la visita dueña (para limpieza en cascada).
   * @param input Puede ser un Blob directo o un data URL base64.
   */
  async savePhoto(visitaId: string, input: Blob | string, mime = 'image/jpeg'): Promise<string> {
    const id = crypto.randomUUID();
    let blob: Blob;
    if (input instanceof Blob) {
      blob = input;
    } else {
      // base64 / data URL — decodificar a binario para evitar overhead.
      const cleaned = (input as string).replace(/^data:image\/\w+;base64,/, '');
      const byteString = atob(cleaned);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
      blob = new Blob([bytes], { type: mime });
    }
    await this.photos.add({
      id,
      visitaId,
      blob,
      mime: blob.type || mime,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async getPhoto(photoId: string): Promise<PhotoBlob | undefined> {
    return this.photos.get(photoId);
  }

  async getPhotosByVisita(visitaId: string): Promise<PhotoBlob[]> {
    return this.photos.where('visitaId').equals(visitaId).toArray();
  }

  /** Borra todas las fotos asociadas a una visita (post-sync exitoso). */
  async deletePhotosByVisita(visitaId: string): Promise<number> {
    return this.photos.where('visitaId').equals(visitaId).delete();
  }

  // --- Tiendas Pendientes (offline create queue) ---

  /**
   * Crea una tienda local con ID temporal y la encola para sync.
   * También la agrega a la tabla `tiendas` para que detectarTiendaCercana
   * (Haversine) la encuentre inmediatamente, sin esperar al POST.
   */
  async guardarTiendaPendiente(nombre: string, latitud: number, longitud: number): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.transaction('rw', this.tiendasPendientes, this.tiendas, async () => {
      await this.tiendasPendientes.add({
        id,
        nombre,
        latitud,
        longitud,
        sincronizado: false,
        intentos_fallidos: 0,
        ultimo_intento: now,
      });
      // También insertar en tabla `tiendas` para que detectarTiendaCercana
      // la encuentre durante la captura actual y futuras antes del sync.
      await this.tiendas.put({
        id,
        nombre,
        lat: latitud,
        lng: longitud,
        ultima_sincronizacion: now,
      });
    });

    console.log(`[OfflineDB] Tienda pendiente creada localmente: ${id} - "${nombre}"`);
    return id;
  }

  async getTiendasPendientes(): Promise<TiendaPendiente[]> {
    const todas = await this.tiendasPendientes.toArray();
    return todas.filter((t) => !t.sincronizado);
  }

  /**
   * Marca tienda pendiente como sincronizada y guarda el `serverId`
   * recibido. Atómica con el remap de la fila en `tiendas` (cambia su id
   * local por el del server) — pero como Dexie no permite cambiar PK,
   * insertamos la fila con server id y eliminamos la antigua.
   */
  async marcarTiendaSincronizada(localId: string, serverId: string): Promise<void> {
    await this.transaction('rw', this.tiendasPendientes, this.tiendas, async () => {
      const pending = await this.tiendasPendientes.get(localId);
      if (!pending) return;
      await this.tiendasPendientes.update(localId, {
        sincronizado: true,
        serverId,
        ultimo_intento: new Date().toISOString(),
      });

      // Reemplazar en la tabla `tiendas`: insertar fila con serverId, borrar antigua.
      const localRow = await this.tiendas.get(localId);
      if (localRow) {
        await this.tiendas.put({
          ...localRow,
          id: serverId,
          ultima_sincronizacion: new Date().toISOString(),
        });
        await this.tiendas.delete(localId);
      }
    });
    console.log(`[OfflineDB] Tienda pendiente ${localId} sincronizada → server ${serverId}`);
  }

  async incrementarIntentoTiendaFallido(localId: string, error: string): Promise<void> {
    const tienda = await this.tiendasPendientes.get(localId);
    if (!tienda) return;
    await this.tiendasPendientes.update(localId, {
      intentos_fallidos: tienda.intentos_fallidos + 1,
      ultimo_intento: new Date().toISOString(),
    });
    await this.addSyncLog({
      tipo: 'visita',
      entidad_id: localId,
      estado: 'error',
      mensaje: `tienda pending: ${error}`,
      fecha: new Date().toISOString(),
    });
  }

  /**
   * Limpieza de fotos cuyas visitas ya no existen (defensa contra leaks
   * por crashes mid-flow). Se corre como parte de limpiarDatosAntiguos.
   */
  async limpiarPhotosHuerfanas(): Promise<number> {
    const todasFotos = await this.photos.toArray();
    const visitaIdsPresentes = new Set((await this.visitas.toArray()).map(v => v.id));
    const huerfanas = todasFotos.filter(p => !visitaIdsPresentes.has(p.visitaId));
    if (huerfanas.length === 0) return 0;
    await this.photos.bulkDelete(huerfanas.map(p => p.id));
    console.log(`[OfflineDB] Eliminadas ${huerfanas.length} fotos huérfanas`);
    return huerfanas.length;
  }
}
