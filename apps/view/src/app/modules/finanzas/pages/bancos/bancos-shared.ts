/**
 * CB.14 — Base compartida del tablero de bancos (constantes + helpers puros + tipos).
 * Fuente única para el shell y los 6 componentes hijo (cierre/movimientos/concentrado/
 * conciliacion/cuentas/admin). Sin estado ni dependencias de Angular: solo datos y
 * funciones puras, así cada hijo importa lo que necesita sin acoplarse al shell.
 */

export type BankView = 'cierre' | 'movimientos' | 'concentrado' | 'conciliacion' | 'comparador' | 'cuentas' | 'admin';
export type BankAdminTab = 'catalogo' | 'cuentas';

export const MONTHS_ES: Record<string, string> = {
  ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06',
  JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12',
};

/** Vistas de trabajo del segmento (Cierre = home). Admin vive aparte en el engrane. */
export const WORK_VIEWS: { key: BankView; label: string; icon: string }[] = [
  { key: 'cierre', label: 'Cierre', icon: 'pi pi-flag' },
  { key: 'movimientos', label: 'Movimientos', icon: 'pi pi-list' },
  { key: 'concentrado', label: 'Concentrado', icon: 'pi pi-table' },
  { key: 'conciliacion', label: 'Conciliación', icon: 'pi pi-sync' },
  { key: 'comparador', label: 'Excel ↔ Kepler', icon: 'pi pi-arrows-h' },
  { key: 'cuentas', label: 'Cuentas', icon: 'pi pi-wallet' },
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

export function money0(v: number): string {
  return Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
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
