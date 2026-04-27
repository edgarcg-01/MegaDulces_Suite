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

// ─── Mocks con puntuaciones (Simulando DB) ───────────────────────────────────

/** Catálogo de conceptos de exhibición con puntuaciones */
export const CONCEPTOS_EXHIBICION: ConceptoExhibicion[] = [
  { id: 'exhibidor', nombre: 'Exhibidor', puntuacion: 10, icono: 'pi pi-box' },
  { id: 'vitrina', nombre: 'Vitrina', puntuacion: 15, icono: 'pi pi-desktop' },
  { id: 'vitrolero', nombre: 'Vitrolero', puntuacion: 5, icono: 'pi pi-database' },
  { id: 'paletero', nombre: 'Paletero', puntuacion: 20, icono: 'pi pi-sun' },
  { id: 'tiras', nombre: 'Tiras', puntuacion: 5, icono: 'pi pi-bars' },
];

/** Catálogo de ubicaciones de exhibidores con puntuaciones */
export const UBICACIONES_EXHIBICION: UbicacionExhibicion[] = [
  { id: 'al_frente', nombre: 'Al frente', puntuacion: 20 },
  { id: 'lado_refri', nombre: 'Lado del refrigerador', puntuacion: 15 },
  { id: 'pasillo', nombre: 'Pasillo principal', puntuacion: 10 },
  { id: 'caja', nombre: 'Caja registradora', puntuacion: 25 },
  { id: 'fondo', nombre: 'Al fondo', puntuacion: 5 },
];

/** Rangos de compra disponibles */
export const RANGOS_COMPRA = ['>500', '>1000', '>1500', '>2000', '>2500'];

/** Catálogo de productos del planograma agrupados por marca */
export const PRODUCTOS_PLANOGRAMA: BrandGroup[] = [
  {
    marca: 'Bimbo',
    items: [
      { pid: 'pan-blanco', name: 'Pan Blanco Large', puntuacion: 5 },
      { pid: 'pan-integral', name: 'Pan Integral', puntuacion: 5 },
      { pid: 'medias-noches', name: 'Medias Noches 8p', puntuacion: 3 },
    ]
  },
  {
    marca: 'Marinela',
    items: [
      { pid: 'gansito', name: 'Gansito 50g', puntuacion: 8 },
      { pid: 'pinguinos', name: 'Pinguinos 80g', puntuacion: 6 },
      { pid: 'chocoroles', name: 'Chocoroles', puntuacion: 6 },
    ]
  },
  {
    marca: 'Barcel',
    items: [
      { pid: 'takis-fuego', name: 'Takis Fuego', puntuacion: 10 },
      { pid: 'chips-sal', name: 'Chips Sal', puntuacion: 7 },
    ]
  },
  {
    marca: 'Tía Rosa',
    items: [
      { pid: 'tortillinas', name: 'Tortillinas 12p', puntuacion: 5 },
      { pid: 'doraditas', name: 'Doraditas', puntuacion: 4 },
    ]
  }
];
