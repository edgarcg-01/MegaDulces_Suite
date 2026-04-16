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
}

export interface CatalogoOffline {
  id: string;
  tipo: 'ubicaciones' | 'conceptos' | 'niveles' | 'planograma';
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

@Injectable({ providedIn: 'root' })
export class OfflineDatabaseService extends Dexie {
  tiendas!: Table<TiendaOffline, string>;
  visitas!: Table<VisitaPendiente, string>;
  catalogos!: Table<CatalogoOffline, string>;
  syncLogs!: Table<SyncLog, string>;

  constructor() {
    super('TradeMarketingOfflineDB');
    
    this.version(1).stores({
      tiendas: 'id, nombre, zona, ultima_sincronizacion',
      visitas: 'id, tiendaId, userId, sincronizado, fecha, intentos_fallidos',
      catalogos: 'id, tipo, version, ultima_sincronizacion',
      syncLogs: 'id, tipo, entidad_id, estado, fecha'
    });

    // Hooks para auditoría
    this.visitas.hook('creating', (primKey, obj, trans) => {
      console.log(`[OfflineDB] Creando visita: ${obj.id}`);
    });

    this.visitas.hook('updating', (modifications, primKey, obj, trans) => {
      console.log(`[OfflineDB] Actualizando visita: ${primKey}`, modifications);
    });
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

  async getTiendaById(id: string): Promise<TiendaOffline | undefined> {
    return await this.tiendas.get(id);
  }

  // --- Visitas Pendientes ---
  async guardarVisitaPendiente(visita: Omit<VisitaPendiente, 'id' | 'sincronizado' | 'intentos_fallidos' | 'ultimo_intento'>): Promise<string> {
    const id = crypto.randomUUID();
    const visitaCompleta: VisitaPendiente = {
      ...visita,
      id,
      sincronizado: false,
      intentos_fallidos: 0,
      ultimo_intento: new Date().toISOString()
    };

    await this.visitas.add(visitaCompleta);
    console.log(`[OfflineDB] Visita guardada localmente: ${id}`);
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
    const catalogo: CatalogoOffline = {
      id: crypto.randomUUID(),
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
  async getEstadisticasOffline(): Promise<{
    visitasPendientes: number;
    tiendasOffline: number;
    catalogosActualizados: number;
    ultimoSync: string | null;
  }> {
    const [visitasPendientes, tiendas, catalogos] = await Promise.all([
      this.getVisitasPendientes(),
      this.getTiendas(),
      this.getCatalogos()
    ]);

    const ultimoSync = await this.syncLogs
      .orderBy('fecha')
      .reverse()
      .first();

    return {
      visitasPendientes: visitasPendientes.length,
      tiendasOffline: tiendas.length,
      catalogosActualizados: catalogos.length,
      ultimoSync: ultimoSync?.fecha || null
    };
  }

  async limpiarDatosAntiguos(): Promise<void> {
    await Promise.all([
      this.limpiarVisitasSincronizadas(7),
      this.limpiarLogsAntiguos(30)
    ]);
    console.log('[OfflineDB] Limpieza de datos antiguos completada');
  }
}
