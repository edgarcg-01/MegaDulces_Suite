/**
 * Benchmark del mercado de dulces mexicano (curado, refrescable).
 *
 * NO hay un API en vivo de "tendencias de dulces MX", así que esto es una
 * referencia curada a partir de investigación de mercado 2025-2026 (sabores
 * picante/ácido/tamarindo dominantes, virales de TikTok, clásicos nostálgicos,
 * picos estacionales). El portal CRUZA estos términos contra NUESTRO catálogo
 * (ILIKE sobre el nombre del producto) y muestra las coincidencias en
 * "Productos top". Actualizar esta lista = actualizar el benchmark.
 *
 * Fuentes: confitexpoinforma 2025, thefoodtech (liofilizados), k-botanas,
 * posta (más vendidos MX), periodistasunidos (Día de Muertos).
 */
export interface MxTrend {
  id: string;
  /** Etiqueta corta para el badge "por qué" del card. */
  label: string;
  /** Razón de la tendencia (contexto, para tooltip/futuro). */
  reason: string;
  /** Término único para la búsqueda ILIKE contra el nombre del producto. */
  query: string;
  /** Meses (1-12) en que aplica. Ausente = evergreen (todo el año). */
  season?: number[];
}

/** Ordenadas por prioridad: evergreen/virales primero, estacionales al final. */
export const MX_TRENDS: MxTrend[] = [
  { id: 'chamoy',     label: 'Chamoy y Tajín',      reason: 'Viral en TikTok: picante-ácido sobre todo', query: 'chamoy' },
  { id: 'tamarindo',  label: 'Tamarindo',           reason: 'Base #1 del dulce mexicano',                query: 'tamarindo' },
  { id: 'enchilado',  label: 'Enchilado y picante', reason: 'Gomitas y paletas cubiertas de chile',      query: 'enchilado' },
  { id: 'mango',      label: 'Mango con chile',      reason: 'Sabor de fruta dominante en MX',            query: 'mango' },
  { id: 'paletas',    label: 'Paletas enchiladas',  reason: 'Formato icónico viral (polvo de chile)',    query: 'lucas' },
  { id: 'skwinkles',  label: 'Tiras de tamarindo',  reason: 'Salsaghetti / Skwinkles muy virales',       query: 'skwinkles' },
  { id: 'sandia',     label: 'Frutas ácidas',        reason: 'Perfil ácido-afrutado en gomitas',          query: 'sandia' },
  { id: 'mazapan',    label: 'Mazapán y cacahuate', reason: 'Clásico nostálgico, top of mind',           query: 'mazapan' },
  { id: 'cajeta',     label: 'Cajeta y leche',       reason: 'Dulce de leche tradicional',                query: 'cajeta' },
  { id: 'duvalin',    label: 'Duvalín',             reason: 'Clásico cremoso de catálogo',               query: 'duvalin' },
  { id: 'bubulubu',   label: 'Chocolate clásico',   reason: 'Bubulubu / Carlos V, anclas del catálogo',  query: 'bubulubu' },
  { id: 'liofilizado',label: 'Liofilizados',        reason: 'Freeze-dried, tendencia TikTok',            query: 'liofilizado' },
  // Estacionales:
  { id: 'calaveritas',label: 'Día de Muertos',      reason: 'Pico oct-nov: azúcar y amaranto',           query: 'calaverita', season: [10, 11] },
  { id: 'colacion',   label: 'Colación navideña',   reason: 'Posadas y piñatas de diciembre',            query: 'colacion',   season: [12] },
];
