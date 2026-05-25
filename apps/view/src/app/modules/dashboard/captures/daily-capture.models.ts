/**
 * Interfaz para conceptos de exhibición
 */
export interface ConceptoExhibicion {
  /** ID único del concepto */
  id: string;
  /** Nombre del concepto */
  nombre: string;
  /** Puntuación asignada al concepto */
  puntuacion: number;
  /** Icono de PrimeNG para representar el concepto */
  icono: string;
}

/**
 * Interfaz para ubicaciones de exhibidores
 */
export interface UbicacionExhibicion {
  /** ID único de la ubicación */
  id: string;
  /** Nombre de la ubicación */
  nombre: string;
  /** Puntuación asignada a la ubicación */
  puntuacion: number;
}

/**
 * Interfaz para un producto individual
 */
export interface ProductoItem {
  /** ID único del producto */
  pid: string;
  /** Nombre del producto */
  name: string;
  /** Puntuación del producto */
  puntuacion: number;
}

/**
 * Interfaz para agrupar productos por marca
 */
export interface BrandGroup {
  /** Nombre de la marca */
  marca: string;
  /** Lista de productos de la marca */
  items: ProductoItem[];
}

/**
 * Interfaz para el registro de una exhibición
 */
export interface RegistroExhibicion {
  /** ID local único */
  id: string;
  /** ID del concepto de exhibición (mapeado a faktor_tipo) */
  conceptoId: string;
  /** ID de la ubicación (mapeado a peso_posicion) */
  ubicacionId: string;
  /** Indica si pertenece a Mega Dulces */
  perteneceMegaDulces?: boolean;
  /** Nivel de ejecución (mapeado a niveles_ejecucion) */
  nivelEjecucion: string;
  /** ID del nivel de ejecución en el catálogo (UUID) */
  nivelEjecucionId?: string;
  /** Lista de PIDs de productos marcados */
  productosMarcados: string[];
  /** Rango de compra */
  rangoCompra: string;
  /** Venta adicional generada */
  ventaAdicional: number;
  /** Foto del exhibidor en base64 */
  fotoBase64?: string;
  /** Puntuación calculada del exhibidor */
  puntuacionCalculada: number;
  /** Hora de registro en formato ISO */
  horaRegistro: string;
}

/**
 * Interfaz para el snapshot de una visita
 */
export interface VisitaSnapshot {
  /** Folio único de la visita */
  folio: string;
  /** Fecha del día (sin hora) para agrupar */
  fechaCaptura: string;
  /** Hora a la que se inició la visita */
  horaInicio: string;
  /** Hora a la que terminó la visita */
  horaFin: string;
  /** Username del ejecutivo */
  capturedBy: string;
  /** ID del usuario (para filtrado) */
  userId?: string;
  /** Zona autocompletada */
  zona?: string;
  /** Lista de exhibidores registrados */
  exhibiciones: RegistroExhibicion[];
  /** Estadísticas de la visita */
  stats: {
    /** Total de exhibidores */
    totalExhibiciones: number;
    /** Total de productos marcados */
    totalProductosMarcados: number;
    /** Puntuación total */
    puntuacionTotal: number;
    /** Venta total */
    ventaTotal: number;
  };
  /** Flag para identificar visitas guardadas offline */
  _offline?: boolean;
}

/** Rangos de compra disponibles */
export const RANGOS_COMPRA = ['>500', '>1000', '>1500', '>2000', '>2500'];
