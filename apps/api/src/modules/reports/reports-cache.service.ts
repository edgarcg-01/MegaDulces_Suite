import { Injectable } from '@nestjs/common';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  hits: number;
}

@Injectable()
export class ReportsCacheService {
  private cache = new Map<string, CacheEntry<any>>();
  private readonly DEFAULT_TTL_MS = 60_000;
  private readonly MAX_ENTRIES = 500;
  private readonly CLEANUP_INTERVAL_MS = 120_000;

  private hitCount = 0;
  private missCount = 0;
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictExpired(), this.CLEANUP_INTERVAL_MS);
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
      console.log(`[Cache] Invalidated ALL entries (${size} cleared)`);
      return;
    }

    let deleted = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        deleted++;
      }
    }
    console.log(`[Cache] Invalidated pattern "${pattern}": ${deleted} entries`);
  }

  invalidateAllReports(): void {
    this.invalidate('summary:');
    this.invalidate('daily_compliance:');
    this.invalidate('daily_scores:');
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
      console.log(`[Cache] Evicted ${deleted} expired entries`);
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
    clearInterval(this.cleanupTimer);
  }
}