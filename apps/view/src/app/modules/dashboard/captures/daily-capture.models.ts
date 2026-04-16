export interface ConceptoExhibicion {
  id: string;
  nombre: string;
  puntuacion: number;
  icono: string;
}

export interface UbicacionExhibicion {
  id: string;
  nombre: string;
  puntuacion: number;
}

export interface ProductoItem {
  pid: string;
  name: string;
  puntuacion: number;
}

export interface BrandGroup {
  marca: string;
  items: ProductoItem[];
}

export interface RegistroExhibicion {
  id: string; // ID local único
  conceptoId: string; // Mapeado a faktor_tipo
  ubicacionId: string; // Mapeado a peso_posicion
  nivelEjecucion: string; // Mapeado a niveles_ejecucion
  productosMarcados: string[]; // Lista de PIDs
  rangoCompra: string;
  ventaAdicional: number;
  fotoBase64?: string; // Dato de la foto en base64
  puntuacionCalculada: number;
  horaRegistro: string;
}

export interface VisitaSnapshot {
  folio: string;
  fechaCaptura: string; // Fecha del día (sin hora) para agrupar
  horaInicio: string;  // Hora a la que se pulsó Iniciar Visita
  horaFin: string;     // Hora a la que se pulsó Terminar Visita
  capturedBy: string;  // Username autocompletado
  userId?: string;     // ID del usuario (para filtrado)
  zona?: string;       // Zona autocompletada
  exhibiciones: RegistroExhibicion[];
  stats: {
    totalExhibiciones: number;
    totalProductosMarcados: number;
    puntuacionTotal: number;
    ventaTotal: number;
  };
  _offline?: boolean; // Flag para identificar visitas guardadas offline
}

// ─── Mocks con puntuaciones (Simulando DB) ───────────────────────────────────

export const CONCEPTOS_EXHIBICION: ConceptoExhibicion[] = [
  { id: 'exhibidor', nombre: 'Exhibidor', puntuacion: 10, icono: 'pi pi-box' },
  { id: 'vitrina', nombre: 'Vitrina', puntuacion: 15, icono: 'pi pi-desktop' },
  { id: 'vitrolero', nombre: 'Vitrolero', puntuacion: 5, icono: 'pi pi-database' },
  { id: 'paletero', nombre: 'Paletero', puntuacion: 20, icono: 'pi pi-sun' },
  { id: 'tiras', nombre: 'Tiras', puntuacion: 5, icono: 'pi pi-bars' },
];

export const UBICACIONES_EXHIBICION: UbicacionExhibicion[] = [
  { id: 'al_frente', nombre: 'Al frente', puntuacion: 20 },
  { id: 'lado_refri', nombre: 'Lado del refrigerador', puntuacion: 15 },
  { id: 'pasillo', nombre: 'Pasillo principal', puntuacion: 10 },
  { id: 'caja', nombre: 'Caja registradora', puntuacion: 25 },
  { id: 'fondo', nombre: 'Al fondo', puntuacion: 5 },
];

export const RANGOS_COMPRA = ['>500', '>1000', '>1500', '>2000', '>2500'];

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
