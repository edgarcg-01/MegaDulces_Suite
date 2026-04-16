import { Injectable } from '@angular/core';
import { Observable, throwError, timer, of } from 'rxjs';
import { mergeMap, retryWhen, delay, take, concatMap } from 'rxjs/operators';

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (attempt: number, error: any) => void;
}

export interface NetworkStatus {
  online: boolean;
  connectionType?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

@Injectable({ providedIn: 'root' })
export class RetryStrategyService {
  
  readonly DEFAULT_CONFIG: Partial<RetryConfig> = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffFactor: 2,
    shouldRetry: this.defaultShouldRetry.bind(this)
  };

  /**
   * Estrategia de reintento con exponencial backoff
   */
  createRetryStrategy(config: Partial<RetryConfig> = {}) {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config } as RetryConfig;
    
    return retryWhen(errors => 
      errors.pipe(
        mergeMap((error, attempt) => {
          // Verificar si debemos reintentar
          if (attempt >= finalConfig.maxRetries) {
            console.error(`[RetryStrategy] Máximo de reintentos alcanzado (${finalConfig.maxRetries})`);
            return throwError(() => error);
          }

          if (finalConfig.shouldRetry && !finalConfig.shouldRetry(error)) {
            console.log('[RetryStrategy] Error no reintentable:', error);
            return throwError(() => error);
          }

          // Calcular delay con exponencial backoff
          const delay = this.calculateDelay(attempt, finalConfig);
          
          console.log(`[RetryStrategy] Reintentando intento ${attempt + 1}/${finalConfig.maxRetries} en ${delay}ms`);
          
          // Notificar reintento
          if (finalConfig.onRetry) {
            finalConfig.onRetry(attempt + 1, error);
          }

          return timer(delay);
        })
      )
    );
  }

  /**
   * Estrategia de reintento para sincronización (más agresiva)
   */
  createSyncRetryStrategy(): RetryConfig {
    return {
      maxRetries: 5,
      initialDelayMs: 2000,
      maxDelayMs: 60000,
      backoffFactor: 1.5,
      shouldRetry: (error) => {
        // Reintentar errores de red y timeouts
        return this.isNetworkError(error) || this.isTimeoutError(error);
      },
      onRetry: (attempt, error) => {
        console.warn(`[SyncRetry] Intento ${attempt} para sincronización:`, error.message);
      }
    };
  }

  /**
   * Estrategia de reintento para geolocalización (rápida)
   */
  createGeoRetryStrategy(): RetryConfig {
    return {
      maxRetries: 3,
      initialDelayMs: 500,
      maxDelayMs: 5000,
      backoffFactor: 1.5,
      shouldRetry: (error) => {
        // Reintentar errores de GPS y timeouts
        return this.isGeoError(error) || this.isTimeoutError(error);
      },
      onRetry: (attempt, error) => {
        console.warn(`[GeoRetry] Intento ${attempt} para GPS:`, error.message);
      }
    };
  }

  /**
   * Estrategia de reintento para catálogos (persistente)
   */
  createCatalogRetryStrategy(): RetryConfig {
    return {
      maxRetries: 10,
      initialDelayMs: 1000,
      maxDelayMs: 120000, // 2 minutos máximo
      backoffFactor: 2,
      shouldRetry: (error) => {
        // Reintentar casi todos los errores excepto autenticación
        return !this.isAuthError(error);
      },
      onRetry: (attempt, error) => {
        console.warn(`[CatalogRetry] Intento ${attempt} para catálogos:`, error.message);
      }
    };
  }

  /**
   * Reintento con jitter para evitar thundering herd
   */
  createJitterRetryStrategy(config: Partial<RetryConfig> = {}) {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config } as RetryConfig;
    
    return retryWhen(errors =>
      errors.pipe(
        mergeMap((error, attempt) => {
          if (attempt >= finalConfig.maxRetries) {
            return throwError(() => error);
          }

          if (finalConfig.shouldRetry && !finalConfig.shouldRetry(error)) {
            return throwError(() => error);
          }

          // Calcular delay base
          const baseDelay = this.calculateDelay(attempt, finalConfig);
          
          // Agregar jitter aleatorio (±25%)
          const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
          const finalDelay = Math.max(0, baseDelay + jitter);
          
          console.log(`[JitterRetry] Intento ${attempt + 1} en ${Math.round(finalDelay)}ms (jitter: ${Math.round(jitter)}ms)`);
          
          if (finalConfig.onRetry) {
            finalConfig.onRetry(attempt + 1, error);
          }

          return timer(finalDelay);
        })
      )
    );
  }

  /**
   * Reintento condicional basado en estado de red
   */
  createNetworkAwareRetryStrategy(config: Partial<RetryConfig> = {}) {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config } as RetryConfig;
    
    return retryWhen(errors =>
      errors.pipe(
        mergeMap(async (error, attempt) => {
          if (attempt >= finalConfig.maxRetries) {
            throw error;
          }

          if (finalConfig.shouldRetry && !finalConfig.shouldRetry(error)) {
            throw error;
          }

          // Verificar estado de red
          const networkStatus = await this.getNetworkStatus();
          
          if (!networkStatus.online) {
            // Si no hay red, esperar más tiempo
            const offlineDelay = Math.min(finalConfig.maxDelayMs, 30000);
            console.log(`[NetworkRetry] Sin conexión, esperando ${offlineDelay}ms`);
            return timer(offlineDelay);
          }

          // Ajustar delay según calidad de conexión
          let delayMultiplier = 1;
          if (networkStatus.effectiveType === 'slow-2g' || networkStatus.effectiveType === '2g') {
            delayMultiplier = 3;
          } else if (networkStatus.effectiveType === '3g') {
            delayMultiplier = 1.5;
          }

          const baseDelay = this.calculateDelay(attempt, finalConfig);
          const adjustedDelay = Math.min(baseDelay * delayMultiplier, finalConfig.maxDelayMs);
          
          console.log(`[NetworkRetry] Intento ${attempt + 1} en ${Math.round(adjustedDelay)}ms (conexión: ${networkStatus.effectiveType})`);
          
          if (finalConfig.onRetry) {
            finalConfig.onRetry(attempt + 1, error);
          }

          return timer(adjustedDelay);
        }),
        concatMap(timerObs => timerObs)
      )
    );
  }

  /**
   * Calcula delay con exponencial backoff
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    const delay = config.initialDelayMs * Math.pow(config.backoffFactor, attempt);
    return Math.min(delay, config.maxDelayMs);
  }

  /**
   * Determina si un error es reintentable por defecto
   */
  private defaultShouldRetry(error: any): boolean {
    return this.isNetworkError(error) || 
           this.isTimeoutError(error) || 
           this.isServerError(error) ||
           this.isRateLimitError(error);
  }

  /**
   * Verifica si es un error de red
   */
  private isNetworkError(error: any): boolean {
    return error?.status === 0 || 
           error?.message?.includes('NetworkError') ||
           error?.message?.includes('Failed to fetch') ||
           error?.message?.includes('ERR_NETWORK');
  }

  /**
   * Verifica si es un error de timeout
   */
  private isTimeoutError(error: any): boolean {
    return error?.status === 408 || 
           error?.message?.includes('timeout') ||
           error?.message?.includes('TimeoutError');
  }

  /**
   * Verifica si es un error del servidor (5xx)
   */
  private isServerError(error: any): boolean {
    return error?.status >= 500 && error?.status < 600;
  }

  /**
   * Verifica si es un error de rate limiting
   */
  private isRateLimitError(error: any): boolean {
    return error?.status === 429 || 
           error?.message?.includes('rate limit') ||
           error?.message?.includes('too many requests');
  }

  /**
   * Verifica si es un error de autenticación
   */
  private isAuthError(error: any): boolean {
    return error?.status === 401 || error?.status === 403;
  }

  /**
   * Verifica si es un error de geolocalización
   */
  private isGeoError(error: any): boolean {
    return error?.message?.includes('Geolocation') ||
           error?.message?.includes('GPS') ||
           error?.message?.includes('location');
  }

  /**
   * Obtiene información del estado de red
   */
  async getNetworkStatus(): Promise<NetworkStatus> {
    const connection = (navigator as any).connection || 
                      (navigator as any).mozConnection || 
                      (navigator as any).webkitConnection;

    return {
      online: navigator.onLine,
      connectionType: connection?.type,
      effectiveType: connection?.effectiveType,
      downlink: connection?.downlink,
      rtt: connection?.rtt
    };
  }

  /**
   * Espera a que la conexión esté disponible
   */
  async waitForConnection(timeoutMs: number = 30000): Promise<boolean> {
    return new Promise((resolve) => {
      if (navigator.onLine) {
        resolve(true);
        return;
      }

      let timeoutId: any;
      
      const onlineHandler = () => {
        clearTimeout(timeoutId);
        window.removeEventListener('online', onlineHandler);
        resolve(true);
      };

      const offlineHandler = () => {
        console.log('[RetryStrategy] Conexión perdida, esperando...');
      };

      timeoutId = setTimeout(() => {
        window.removeEventListener('online', onlineHandler);
        window.removeEventListener('offline', offlineHandler);
        resolve(false);
      }, timeoutMs);

      window.addEventListener('online', onlineHandler);
      window.addEventListener('offline', offlineHandler);
    });
  }

  /**
   * Ejecuta una función con reintentos automáticos
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    config: Partial<RetryConfig> = {}
  ): Promise<T> {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config } as RetryConfig;
    let lastError: any;

    for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
      try {
        const result = await fn();
        
        if (attempt > 0) {
          console.log(`[RetryStrategy] Éxito en intento ${attempt + 1}`);
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        if (attempt === finalConfig.maxRetries) {
          console.error(`[RetryStrategy] Todos los intentos fallaron (${finalConfig.maxRetries + 1})`);
          throw lastError;
        }

        if (finalConfig.shouldRetry && !finalConfig.shouldRetry(error)) {
          throw error;
        }

        const delay = this.calculateDelay(attempt, finalConfig);
        
        console.log(`[RetryStrategy] Intento ${attempt + 1} falló, reintentando en ${delay}ms:`, (error as Error).message);
        
        if (finalConfig.onRetry) {
          finalConfig.onRetry(attempt + 1, error);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Crea un Observable que se reintentará automáticamente
   */
  createRetryableObservable<T>(
    observableFactory: () => Observable<T>,
    config: Partial<RetryConfig> = {}
  ): Observable<T> {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config } as RetryConfig;
    
    return new Observable<T>(subscriber => {
      let attempt = 0;
      
      const subscribe = () => {
        attempt++;
        
        observableFactory().subscribe({
          next: (value) => {
            if (attempt > 1) {
              console.log(`[RetryStrategy] Observable éxito en intento ${attempt}`);
            }
            subscriber.next(value);
            subscriber.complete();
          },
          error: (error) => {
            if (attempt > finalConfig.maxRetries) {
              console.error(`[RetryStrategy] Observable todos los intentos fallidos (${attempt})`);
              subscriber.error(error);
              return;
            }

            if (finalConfig.shouldRetry && !finalConfig.shouldRetry(error)) {
              subscriber.error(error);
              return;
            }

            const delay = this.calculateDelay(attempt - 1, finalConfig);
            
            console.log(`[RetryStrategy] Observable intento ${attempt} falló, reintentando en ${delay}ms:`, (error as Error).message);
            
            if (finalConfig.onRetry) {
              finalConfig.onRetry(attempt, error);
            }

            setTimeout(subscribe, delay);
          }
        });
      };

      subscribe();
    });
  }
}
