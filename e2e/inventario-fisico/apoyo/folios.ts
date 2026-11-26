/**
 * Folios de mentira con la MISMA forma que devuelve `listCounts`.
 *
 * Los campos salen del `SELECT` real del servicio, no de lo que la pantalla usa: si mañana el
 * componente lee uno que acá falta, la prueba lo destapa en vez de pintarlo vacio.
 */
export interface FolioFalso {
  id: string;
  folio: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  type: 'full' | 'cycle';
  status: 'open' | 'counting' | 'review' | 'ready_to_reconcile' | 'reconciled' | 'cancelled';
  freeze_movements: boolean;
  started_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  items_total: number;
  items_counted: number;
  last_count_at: string | null;
}

const haceDias = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const base = (over: Partial<FolioFalso>): FolioFalso => ({
  id: '11111111-1111-1111-1111-111111111111',
  folio: 'INV-2026-00100',
  warehouse_id: '22222222-2222-2222-2222-222222222222',
  warehouse_code: '01',
  warehouse_name: 'Padre Hidalgo',
  type: 'full',
  status: 'counting',
  freeze_movements: true,
  started_at: haceDias(1),
  closed_at: null,
  created_at: haceDias(1),
  updated_at: haceDias(1),
  items_total: 4819,
  items_counted: 1200,
  last_count_at: haceDias(0),
  ...over,
});

/** Un folio vivo, avanzando con normalidad. */
export const VIVO = base({});

/**
 * ⚠️ El caso de `INV-2026-00009`, que congelo Padre Hidalgo **101 dias**: abierto, congelando,
 * y con 8 escaneos sobre 2,094 articulos.
 */
export const ABANDONADO = base({
  id: '33333333-3333-3333-3333-333333333333',
  folio: 'INV-2026-00009',
  items_total: 2094,
  items_counted: 8,
  started_at: haceDias(101),
  created_at: haceDias(101),
  last_count_at: haceDias(100),
});

/** Nadie escaneo nunca: la otra ausencia, la que arregla quien asigna. */
export const SIN_CONTEOS = base({
  id: '44444444-4444-4444-4444-444444444444',
  folio: 'INV-2026-00008',
  warehouse_code: '02',
  warehouse_name: 'La Piedad Abastos',
  items_total: 3664,
  items_counted: 0,
  started_at: haceDias(6),
  created_at: haceDias(6),
  last_count_at: null,
});

/** Muerto. En prod hoy los seis folios estan asi. */
export const CANCELADO = base({
  id: '55555555-5555-5555-5555-555555555555',
  folio: 'INV-2026-00004',
  warehouse_code: '02',
  warehouse_name: 'La Piedad Abastos',
  status: 'cancelled',
  started_at: haceDias(160),
  closed_at: haceDias(157),
  created_at: haceDias(160),
  items_total: 2500,
  items_counted: 0,
  last_count_at: null,
});

/** Sin instantanea de apertura: `items_total = 0`. */
export const SIN_SNAPSHOT = base({
  id: '66666666-6666-6666-6666-666666666666',
  folio: 'INV-2026-00101',
  items_total: 0,
  items_counted: 0,
  last_count_at: null,
});

/**
 * ⛔ El folio que destapa el defecto del avance: **doble conteo ciego**, primer pase completo
 * y segundo sin empezar. `items_counted` cuenta solo `count_1`, asi que la barra dice 100 %.
 */
export const PRIMER_PASE_COMPLETO = base({
  id: '77777777-7777-7777-7777-777777777777',
  folio: 'INV-2026-00102',
  items_total: 500,
  items_counted: 500,
  status: 'review',
});

export const LISTA_COMPLETA = [VIVO, ABANDONADO, SIN_CONTEOS, CANCELADO, SIN_SNAPSHOT];

/** Almacenes como los devuelve `GET /commercial/warehouses`. */
export const ALMACENES = [
  { id: '22222222-2222-2222-2222-222222222222', code: '01', name: 'Padre Hidalgo', active: true },
  { id: '88888888-8888-8888-8888-888888888888', code: '02', name: 'La Piedad Abastos', active: true },
  { id: '99999999-9999-9999-9999-999999999999', code: '01-002', name: 'Ruta 22 (PH)', active: true },
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', code: 'RUTA-22', name: 'Ruta 22', active: true },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', code: 'MD-32', name: 'Almacen Morelia Madero (32)', active: true },
];
