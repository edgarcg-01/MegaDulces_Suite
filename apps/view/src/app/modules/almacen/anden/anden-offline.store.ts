import { InjectionToken, inject } from '@angular/core';
import type { AndenPaqueteOffline } from '@megadulces/contracts';
import { OfflineDatabaseService } from '../../../core/services/offline-database.service';
import type { OpAnden, ValeGuardado } from './anden-offline';

/**
 * `[WMS-REC.20]` Dónde guarda el Andén lo que necesita para seguir sin red.
 *
 * Detrás de una interfaz por una razón concreta: en las pruebas no hay IndexedDB, y una cola que
 * no se puede probar entera es justo la que pierde capturas en silencio. En el equipo es Dexie
 * (`OfflineDatabaseService` v7); en las pruebas, memoria.
 */
export interface AndenStore {
  paquete(sucursal: string): Promise<AndenPaqueteOffline | null>;
  paquetes(): Promise<AndenPaqueteOffline[]>;
  guardarPaquete(p: AndenPaqueteOffline): Promise<void>;
  vale(key: string): Promise<ValeGuardado | null>;
  /** El vale guardado que corresponde a un id del SERVIDOR (puede haberse abierto sin red). */
  valePorSesion(sessionId: string): Promise<ValeGuardado | null>;
  vales(): Promise<ValeGuardado[]>;
  guardarVale(v: ValeGuardado): Promise<void>;
  borrarVale(key: string): Promise<void>;
  ops(): Promise<OpAnden[]>;
  guardarOp(op: OpAnden): Promise<void>;
  borrarOp(id: string): Promise<void>;
}

export class DexieAndenStore implements AndenStore {
  constructor(private readonly db: OfflineDatabaseService) {}

  async paquete(sucursal: string) {
    return ((await this.db.andenPaquetes.get(sucursal)) as AndenPaqueteOffline | undefined) ?? null;
  }
  async paquetes() {
    return (await this.db.andenPaquetes.toArray()) as unknown as AndenPaqueteOffline[];
  }
  async guardarPaquete(p: AndenPaqueteOffline) {
    await this.db.andenPaquetes.put(p);
  }
  async vale(key: string) {
    return ((await this.db.andenVales.get(key)) as ValeGuardado | undefined) ?? null;
  }
  async valePorSesion(sessionId: string) {
    return ((await this.db.andenVales.where('sessionId').equals(sessionId).first()) as ValeGuardado | undefined) ?? null;
  }
  async vales() {
    return (await this.db.andenVales.toArray()) as unknown as ValeGuardado[];
  }
  async guardarVale(v: ValeGuardado) {
    await this.db.andenVales.put(v);
  }
  async borrarVale(key: string) {
    await this.db.andenVales.delete(key);
  }
  async ops() {
    return (await this.db.andenOps.toArray()) as unknown as OpAnden[];
  }
  async guardarOp(op: OpAnden) {
    await this.db.andenOps.put(op);
  }
  async borrarOp(id: string) {
    await this.db.andenOps.delete(id);
  }
}

/** En memoria: para las pruebas. Copia al guardar y al leer, como lo haría IndexedDB. */
export class MemoriaAndenStore implements AndenStore {
  readonly paqs = new Map<string, AndenPaqueteOffline>();
  readonly vs = new Map<string, ValeGuardado>();
  readonly os = new Map<string, OpAnden>();
  private copia<T>(x: T): T {
    return x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T);
  }

  async paquete(sucursal: string) {
    return this.copia(this.paqs.get(sucursal)) ?? null;
  }
  async paquetes() {
    return this.copia([...this.paqs.values()]);
  }
  async guardarPaquete(p: AndenPaqueteOffline) {
    this.paqs.set(p.sucursal, this.copia(p));
  }
  async vale(key: string) {
    return this.copia(this.vs.get(key)) ?? null;
  }
  async valePorSesion(sessionId: string) {
    return this.copia([...this.vs.values()].find((v) => v.sessionId === sessionId)) ?? null;
  }
  async vales() {
    return this.copia([...this.vs.values()]);
  }
  async guardarVale(v: ValeGuardado) {
    this.vs.set(v.key, this.copia(v));
  }
  async borrarVale(key: string) {
    this.vs.delete(key);
  }
  async ops() {
    return this.copia([...this.os.values()]);
  }
  async guardarOp(op: OpAnden) {
    this.os.set(op.id, this.copia(op));
  }
  async borrarOp(id: string) {
    this.os.delete(id);
  }
}

export const ANDEN_STORE = new InjectionToken<AndenStore>('ANDEN_STORE', {
  providedIn: 'root',
  factory: () => new DexieAndenStore(inject(OfflineDatabaseService)),
});
