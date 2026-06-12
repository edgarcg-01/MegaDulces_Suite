import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { finalize, shareReplay, tap } from 'rxjs/operators';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Cache de lecturas GET con TTL + dedup de requests en vuelo (E6).
 *
 * Dos ganancias frente a refetchear en cada navegación:
 *   1. TTL hit → respuesta instantánea sin red (navegar home↔catálogo↔promos
 *      no vuelve a bajar el catálogo cada vez).
 *   2. Dedup → si 3 pantallas piden `customers/me` en el mismo tick, sale 1
 *      sola request y todas comparten el resultado (shareReplay).
 *
 * Solo para datos de lectura que cambian lento (catálogo, precios, reference
 * data). NUNCA cachear carrito/órdenes — cambian a cada tap.
 *
 * Nota de inmutabilidad: en cache hit de arrays devolvemos una copia superficial
 * (`slice()`) para que un caller que ordene/filtre el array no corrompa el
 * cache. Los objetos fila se comparten → tratarlos como read-only.
 */
@Injectable({ providedIn: 'root' })
export class HttpCacheService {
  private readonly store = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Observable<unknown>>();

  wrap<T>(key: string, ttlMs: number, source: () => Observable<T>): Observable<T> {
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      const v = cached.value;
      return of(Array.isArray(v) ? (v.slice() as unknown as T) : (v as T));
    }

    const existing = this.inflight.get(key);
    if (existing) return existing as Observable<T>;

    const req = source().pipe(
      tap((value) => this.store.set(key, { value, expiresAt: Date.now() + ttlMs })),
      finalize(() => this.inflight.delete(key)),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.inflight.set(key, req);
    return req as Observable<T>;
  }

  /** Invalida una clave exacta, todas las que empiecen con `prefix`, o todo. */
  invalidate(prefix?: string): void {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const k of Array.from(this.store.keys())) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }
}
