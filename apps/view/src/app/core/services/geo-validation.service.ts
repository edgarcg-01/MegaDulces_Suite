import { Injectable } from '@angular/core';

export interface Coordenada {
  lat: number;
  lng: number;
}

export interface GeoValidationResult {
  valido: boolean;
  distancia: number; // en metros
  precision: number; // en metros
  mensaje: string;
  nivelConfianza: 'alta' | 'media' | 'baja';
}

@Injectable({ providedIn: 'root' })
export class GeoValidationService {
  
  readonly RADIO_ACEPTABLE_METROS = 100; // 100 metros de radio aceptable
  readonly PRECISION_MINIMA_METROS = 50; // 50 metros de precisión mínima

  /**
   * Calcula la distancia entre dos coordenadas usando la fórmula de Haversine
   * Retorna distancia en metros
   */
  calcularDistanciaHaversine(punto1: Coordenada, punto2: Coordenada): number {
    const R = 6371e3; // Radio de la Tierra en metros
    const φ1 = this.toRadians(punto1.lat);
    const φ2 = this.toRadians(punto2.lat);
    const Δφ = this.toRadians(punto2.lat - punto1.lat);
    const Δλ = this.toRadians(punto2.lng - punto1.lng);

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c; // Distancia en metros
  }

  /**
   * Valida si el usuario está suficientemente cerca de la tienda
   */
  validarUbicacion(
    ubicacionUsuario: Coordenada & { precision: number },
    ubicacionTienda: Coordenada
  ): GeoValidationResult {
    
    const distancia = this.calcularDistanciaHaversine(ubicacionUsuario, ubicacionTienda);
    const precision = ubicacionUsuario.precision;
    
    // Calcular nivel de confianza basado en precisión GPS
    let nivelConfianza: 'alta' | 'media' | 'baja';
    if (precision <= 10) {
      nivelConfianza = 'alta';
    } else if (precision <= 30) {
      nivelConfianza = 'media';
    } else {
      nivelConfianza = 'baja';
    }

    // Validaciones
    if (precision > this.PRECISION_MINIMA_METROS) {
      return {
        valido: false,
        distancia,
        precision,
        mensaje: `Precisión GPS muy baja (${precision.toFixed(1)}m). Mueva el dispositivo o espere una mejor señal.`,
        nivelConfianza
      };
    }

    if (distancia > this.RADIO_ACEPTABLE_METROS) {
      return {
        valido: false,
        distancia,
        precision,
        mensaje: `Estás demasiado lejos de la tienda (${distancia.toFixed(1)}m). Debes estar a menos de ${this.RADIO_ACEPTABLE_METROS}m.`,
        nivelConfianza
      };
    }

    return {
      valido: true,
      distancia,
      precision,
      mensaje: `Ubicación válida. Distancia: ${distancia.toFixed(1)}m, Precisión: ${precision.toFixed(1)}m`,
      nivelConfianza
    };
  }

  /**
   * Obtiene la ubicación actual del usuario con opciones configurables
   */
  async obtenerUbicacionActual(
    opciones: {
      altaPrecision?: boolean;
      timeout?: number;
      maxAge?: number;
    } = {}
  ): Promise<Coordenada & { precision: number; timestamp: number }> {
    
    const opcionesPorDefecto = {
      enableHighAccuracy: opciones.altaPrecision ?? true,
      timeout: opciones.timeout ?? 20000,
      maximumAge: opciones.maxAge ?? 0
    };

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocalización no soportada en este navegador'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            precision: position.coords.accuracy,
            timestamp: position.timestamp
          });
        },
        (error) => {
          let mensaje = 'Error desconocido al obtener ubicación';
          
          switch (error.code) {
            case error.PERMISSION_DENIED:
              mensaje = 'Permiso de geolocalización denegado';
              break;
            case error.POSITION_UNAVAILABLE:
              mensaje = 'Información de ubicación no disponible';
              break;
            case error.TIMEOUT:
              mensaje = 'Tiempo de espera agotado al obtener ubicación';
              break;
          }
          
          reject(new Error(mensaje));
        },
        opcionesPorDefecto
      );
    });
  }

  /**
   * Intenta obtener ubicación con múltiples estrategias (fallback)
   */
  async obtenerUbicacionConFallback(): Promise<Coordenada & { precision: number; timestamp: number; estrategia: string }> {
    
    // Estrategia 1: Alta precisión
    try {
      const ubicacion = await this.obtenerUbicacionActual({
        altaPrecision: true,
        timeout: 15000,
        maxAge: 0
      });
      
      return {
        ...ubicacion,
        estrategia: 'alta_precision'
      };
    } catch (error) {
      console.warn('[GeoValidation] Falló ubicación de alta precisión:', error);
    }

    // Estrategia 2: Baja precisión con caché reciente
    try {
      const ubicacion = await this.obtenerUbicacionActual({
        altaPrecision: false,
        timeout: 10000,
        maxAge: 60000 // Aceptar caché de 1 minuto
      });
      
      return {
        ...ubicacion,
        estrategia: 'baja_precision_cache'
      };
    } catch (error) {
      console.warn('[GeoValidation] Falló ubicación de baja precisión:', error);
    }

    // Estrategia 3: Baja precisión sin caché
    try {
      const ubicacion = await this.obtenerUbicacionActual({
        altaPrecision: false,
        timeout: 20000,
        maxAge: 300000 // Aceptar caché de 5 minutos
      });
      
      return {
        ...ubicacion,
        estrategia: 'baja_precision'
      };
    } catch (error) {
      console.error('[GeoValidation] Todas las estrategias de ubicación fallaron:', error);
      throw new Error('No se pudo obtener la ubicación después de múltiples intentos');
    }
  }

  /**
   * Monitorea la ubicación continuamente (para visitas largas)
   */
  iniciarMonitoreoUbicacion(
    callback: (ubicacion: Coordenada & { precision: number }) => void,
    opciones: {
      intervaloMs?: number;
      altaPrecision?: boolean;
    } = {}
  ): () => void {
    
    const intervalo = opciones.intervaloMs ?? 30000; // 30 segundos por defecto
    let watchId: number | null = null;

    // Usar watchPosition para actualizaciones continuas
    if ('geolocation' in navigator) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          callback({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            precision: position.coords.accuracy
          });
        },
        (error) => {
          console.error('[GeoValidation] Error en monitoreo de ubicación:', error);
        },
        {
          enableHighAccuracy: opciones.altaPrecision ?? true,
          timeout: 15000,
          maximumAge: 5000
        }
      );
    }

    // También hacer verificaciones periódicas
    const intervalId = setInterval(async () => {
      try {
        const ubicacion = await this.obtenerUbicacionActual({
          altaPrecision: opciones.altaPrecision ?? false,
          timeout: 10000,
          maxAge: 10000
        });
        callback(ubicacion);
      } catch (error) {
        console.warn('[GeoValidation] Error en verificación periódica:', error);
      }
    }, intervalo);

    // Función de limpieza
    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
      clearInterval(intervalId);
    };
  }

  /**
   * Determina si la precisión GPS es suficiente para operaciones críticas
   */
  esPrecisionSuficiente(precision: number, operacion: 'registro_visita' | 'validacion_rapida' = 'registro_visita'): boolean {
    const umbrales = {
      registro_visita: 50, // 50m para registrar visita
      validacion_rapida: 100 // 100m para validaciones rápidas
    };
    
    return precision <= umbrales[operacion];
  }

  /**
   * Genera un resumen de la calidad de la señal GPS
   */
  generarResumenCalidadGPS(precision: number, satelites?: number): {
    calidad: 'excelente' | 'buena' | 'regular' | 'mala';
    recomendaciones: string[];
  } {
    let calidad: 'excelente' | 'buena' | 'regular' | 'mala';
    let recomendaciones: string[] = [];

    if (precision <= 5) {
      calidad = 'excelente';
      recomendaciones = ['Precisión óptima para todas las operaciones'];
    } else if (precision <= 15) {
      calidad = 'buena';
      recomendaciones = ['Precisión adecuada para registro de visitas'];
    } else if (precision <= 30) {
      calidad = 'regular';
      recomendaciones = ['Considere moverse a un área más despejada', 'Espere unos segundos para mejorar la señal'];
    } else {
      calidad = 'mala';
      recomendaciones = [
        'Mueva el dispositivo cerca de una ventana',
        'Evite estar entre edificios altos',
        'Espere a que la señal GPS mejore',
        'Considere reiniciar el GPS del dispositivo'
      ];
    }

    if (satelites !== undefined) {
      if (satelites < 4) {
        recomendaciones.push('Número bajo de satélites detectados');
      }
    }

    return { calidad, recomendaciones };
  }

  /**
   * Utilidad para convertir grados a radianes
   */
  private toRadians(grados: number): number {
    return grados * (Math.PI / 180);
  }
}
