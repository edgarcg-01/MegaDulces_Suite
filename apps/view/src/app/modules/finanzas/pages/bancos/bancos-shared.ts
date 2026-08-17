/**
 * CB.14 — Base compartida del tablero de bancos (constantes + helpers puros + tipos).
 * Fuente única para el shell y los 6 componentes hijo (cierre/movimientos/concentrado/
 * conciliacion/cuentas/admin). Sin estado ni dependencias de Angular: solo datos y
 * funciones puras, así cada hijo importa lo que necesita sin acoplarse al shell.
 */

export type BankView = 'cierre' | 'movimientos' | 'concentrado' | 'conciliacion' | 'contpaqi' | 'cuadre' | 'cuentas' | 'capturas' | 'admin';
export type BankAdminTab = 'catalogo' | 'cuentas';

export const MONTHS_ES: Record<string, string> = {
  ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06',
  JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12',
};

/**
 * Vistas de trabajo del segmento (Cierre = home). Admin vive aparte en el engrane.
 * Consolidación 2026-08-13: la comparación de fuentes vive SOLO en `cuadre` (3-4 vías +
 * drill a movimiento). `comparador` (Excel↔Kepler) fue ELIMINADO (cubierto por el drill
 * del Cuadre). `contpaqi` se reencauza a **Factoraje** — su único valor propio (compras
 * factoradas por proveedor vs ContPAQi); su comparación banco↔ContPAQi ya está en Cuadre.
 */
// Orden izquierda→derecha por IMPORTANCIA (de la respuesta al detalle):
// Cierre (¿cuadra?) → Cuadre (¿coinciden las fuentes?) → Conciliación (¿casó cada
// movimiento?) → Movimientos (detalle) → Concentrado (composición) → Cuentas (catálogo)
// → Factoraje (nicho) → Capturas (entrada). Cierre = home (default del shell).
export const WORK_VIEWS: { key: BankView; label: string; icon: string }[] = [
  { key: 'cierre', label: 'Cierre', icon: 'pi pi-flag' },
  { key: 'cuadre', label: 'Cuadre', icon: 'pi pi-check-square' },
  { key: 'conciliacion', label: 'Conciliación', icon: 'pi pi-sync' },
  { key: 'movimientos', label: 'Movimientos', icon: 'pi pi-list' },
  { key: 'concentrado', label: 'Concentrado', icon: 'pi pi-table' },
  { key: 'cuentas', label: 'Cuentas', icon: 'pi pi-wallet' },
  { key: 'contpaqi', label: 'Factoraje', icon: 'pi pi-credit-card' },
  { key: 'capturas', label: 'Capturas WhatsApp', icon: 'pi pi-whatsapp' },
];

/** Etiquetas + orden de los grupos del tablero CONCENTRADO. */
export const GROUP_LABELS: Record<string, string> = {
  ingreso: 'Ingresos', compra: 'Compras', gasto: 'Gastos', factoraje: 'Factoraje',
  financiero: 'Financiero', traspaso: 'Traspasos', devolucion: 'Devoluciones', sin_clasificar: 'Sin clasificar',
};
export const GROUP_ORDER = ['ingreso', 'compra', 'gasto', 'factoraje', 'financiero', 'traspaso', 'devolucion', 'sin_clasificar'];

/**
 * Color por grupo (CC.1) — el color = la clasificación, determinista + dark-safe.
 * Paleta categórica sancionada por DESIGN (--chart-*, sin morado, flipa en dark).
 */
export const GROUP_COLOR: Record<string, string> = {
  ingreso: 'var(--chart-3)', compra: 'var(--chart-5)', gasto: 'var(--chart-1)',
  factoraje: 'var(--chart-4)', financiero: 'var(--chart-2)', traspaso: 'var(--chart-8)',
  devolucion: 'var(--chart-6)', sin_clasificar: 'var(--warn-fg)',
};

export function groupLabel(group: string): string { return GROUP_LABELS[group] || group; }
export function groupColorVar(group?: string | null): string { return GROUP_COLOR[group || 'sin_clasificar'] || 'transparent'; }
export function kindLabel(kind: string): string { return kind === 'bank' ? 'Banco' : kind === 'cash' ? 'Caja' : 'Factoraje'; }

/** Tolerancia de cuadre: ±$1,000 se considera cuadrado. */
export function cuadra(delta: number): boolean { return Math.abs(delta) < 1000; }

/** % por MONTO del matching (matched/bank). */
export function amtPct(mr: { matched_amount: number; bank_amount: number }): number {
  return mr?.bank_amount ? Math.round((mr.matched_amount / mr.bank_amount) * 100) : 0;
}

/**
 * Importe en pesos SIN redondear — se muestra tal como viene del origen.
 * (Antes `money0` cortaba a pesos enteros: en una pantalla de conciliación eso
 * escondía los centavos que son justo la diferencia que se anda buscando.)
 */
export function money(v: number): string {
  return Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fecha (Date o 'YYYY-MM-DD') → 'DD/MM' con componentes locales (sin voltear a UTC). */
export function dmShort(v: any): string {
  if (v instanceof Date && !isNaN(v.getTime())) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}`;
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}` : String(v ?? '');
}

/** Fecha (Date o 'YYYY-MM-DD') → 'DD/MM/YY' sin conversión de TZ. */
export function dmy(v: any): string {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${String(v.getFullYear()).slice(2)}`;
  }
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(v ?? '');
}

/**
 * Ordenamiento por columna para las tablas CRUDAS del tablero (las que no son
 * `p-table`, porque llevan encabezados agrupados con colspan/rowspan que PrimeNG
 * no arma). `p-table` trae lo suyo con `pSortableColumn`; esto es el equivalente
 * mínimo para el resto: un campo, una dirección, y un comparador que entiende
 * número, fecha ISO y texto.
 */
export type SortDir = 'asc' | 'desc';
export interface SortState { field: string; dir: SortDir }

/** Alterna: mismo campo → invierte; campo nuevo → arranca descendente (lo más grande primero). */
export function toggleSort(cur: SortState | null, field: string): SortState {
  if (cur?.field === field) return { field, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { field, dir: 'desc' };
}

/** Ícono del encabezado: neutro si la columna no es la activa. */
export function sortIcon(cur: SortState | null, field: string): string {
  if (cur?.field !== field) return 'pi pi-sort-alt';
  return cur.dir === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
}

/** `aria-sort` del `<th>` — sin esto la tabla ordenable no se anuncia a un lector de pantalla. */
export function ariaSort(cur: SortState | null, field: string): 'ascending' | 'descending' | 'none' {
  if (cur?.field !== field) return 'none';
  return cur.dir === 'asc' ? 'ascending' : 'descending';
}

/**
 * Copia ordenada. Nulos siempre al final (en ambas direcciones): un dato ausente
 * no compite con uno presente por el primer lugar.
 */
export function sortRows<T>(rows: T[], sort: SortState | null, pick: (r: T, field: string) => unknown): T[] {
  if (!sort) return rows;
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = pick(a, sort.field), vb = pick(b, sort.field);
    const na = va == null || va === '', nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb), 'es-MX', { numeric: true }) * mul;
  });
}
