import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  hits: number;
}

@Injectable()
export class ReportsCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(ReportsCacheService.name);
  private cache = new Map<string, CacheEntry<any>>();
  private readonly DEFAULT_TTL_MS = 60_000;
  private readonly MAX_ENTRIES = 500;
  private readonly CLEANUP_INTERVAL_MS = 120_000;

  private hitCount = 0;
  private missCount = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictExpired(), this.CLEANUP_INTERVAL_MS);
    // .unref() permite que Node termine sin esperar a este timer en shutdown
    this.cleanupTimer.unref?.();
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.missCount++;
      return null;
    }

    if (Date.now() - entry.timestamp > this.DEFAULT_TTL_MS) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    entry.hits++;
    this.hitCount++;
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs?: number): void {
    if (this.cache.size >= this.MAX_ENTRIES) {
      this.evictLru();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      const size = this.cache.size;
      this.cache.clear();
      this.logger.log(`Invalidated ALL entries (${size} cleared)`);
      return;
    }

    let deleted = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        deleted++;
      }
    }
    this.logger.log(`Invalidated pattern "${pattern}": ${deleted} entries`);
  }

  invalidateAllReports(): void {
    this.invalidate('summary:');
    this.invalidate('daily_compliance:');
    this.invalidate('daily_scores:');
  }

  /**
   * Invalida solo las entradas de caché que afectan a un usuario concreto:
   * - Sus reportes propios (scopeUserId=<userId>)
   * - Reportes globales (scope 'all' — siempre dependen de toda la data)
   * - Reportes de equipo donde el userId aparece en supervisor o userIds
   *
   * Útil cuando llega un nuevo capture: no hace falta tirar la caché entera.
   */
  invalidateForUser(userId: string): void {
    if (!userId) {
      this.invalidateAllReports();
      return;
    }
    let deleted = 0;
    for (const key of this.cache.keys()) {
      // Las keys tienen el formato `summary:scopeType=own&scopeUserId=<uuid>&...`
      // Invalidar:
      //   - las del propio user (scopeUserId=<userId> o supervisorId=<userId> o userIds que contengan <userId>)
      //   - las globales (scopeType=all)
      const isOwnUser = key.includes(`scopeUserId=${userId}`)
        || key.includes(`supervisorId=${userId}`)
        || key.includes(`userIds=${userId}`)
        || key.includes(`,${userId},`)
        || key.includes(`,${userId}&`);
      const isGlobal = key.includes('scopeType=all');
      if (isOwnUser || isGlobal) {
        this.cache.delete(key);
        deleted++;
      }
    }
    if (deleted > 0) {
      this.logger.debug(`Invalidated ${deleted} entries for user ${userId}`);
    }
  }

  buildKey(method: string, params: Record<string, any>): string {
    const sortedParams = Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== null && v !== 'null' && v !== 'undefined')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => {
        const val = Array.isArray(v) ? v.sort().join(',') : String(v);
        return `${k}=${val}`;
      })
      .join('&');

    return `${method}:${sortedParams}`;
  }

  getHitRate(): { hits: number; misses: number; rate: string } {
    const total = this.hitCount + this.missCount;
    const rate = total > 0 ? ((this.hitCount / total) * 100).toFixed(1) + '%' : '0%';
    return { hits: this.hitCount, misses: this.missCount, rate };
  }

  getSize(): number {
    return this.cache.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    let deleted = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.DEFAULT_TTL_MS) {
        this.cache.delete(key);
        deleted++;
      }
    }
    if (deleted > 0) {
      this.logger.debug(`Evicted ${deleted} expired entries`);
    }
  }

  private evictLru(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
    this.logger.log('ReportsCacheService destroyed; timer cleared and cache wiped.');
  }
}