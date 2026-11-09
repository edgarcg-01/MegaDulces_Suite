/**
 * CB.14 — Base compartida del tablero de bancos (constantes + helpers puros + tipos).
 * Fuente única para el shell y los 6 componentes hijo (cierre/movimientos/concentrado/
 * conciliacion/cuentas/admin). Sin estado ni dependencias de Angular: solo datos y
 * funciones puras, así cada hijo importa lo que necesita sin acoplarse al shell.
 */

export type BankView = 'cierre' | 'estados' | 'movimientos' | 'concentrado' | 'conciliacion' | 'contpaqi' | 'cuadre' | 'cuentas' | 'capturas' | 'admin';
export type BankAdminTab = 'catalogo' | 'cuentas';

export const MONTHS_ES: Record<string, string> = {
  ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06',
  JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12',
};

/**
 * `[PGP.97.1]` **El periodo de un workbook, por el nombre de su archivo.**
 *
 * ⛔ El caso que lo trajo (medido en prod el 2026-11-07): el 5-nov se subió «11 NOVIEMBRE.xlsx»
 * —896 movimientos del 1 al 5-nov—. La regla vieja exigía mes **y** año («NOVIEMBRE 2026»); sin
 * año caía al periodo SELECCIONADO en pantalla, que era octubre, y la siguiente subida de octubre
 * barrió esos movimientos por «ya no venir en el archivo». Noviembre quedó en cero y la guía de
 * Salidas del banco, ciega.
 *
 * Ahora: con mes y año, ese periodo. Con mes sin año, el año es el de HOY, salvo que ese mes
 * todavía no llegue (un «DICIEMBRE» subido en enero es del año pasado). Sin mes en el nombre, el
 * periodo seleccionado, como antes. `null` = no se pudo decidir.
 */
export function periodoDelArchivo(nombre: string, seleccionado: string | null | undefined, hoy: Date = new Date()): string | null {
  const t = nombre.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const meses = Object.keys(MONTHS_ES).join('|');
  // El año es 20xx: un «OCTUBRE_1463.xlsx» trae la CUENTA, no el año (lo encontró la revisión).
  const conAnio = t.match(new RegExp(`(${meses})[\\s_.-]*(20\\d{2})(?!\\d)`));
  if (conAnio) return `${conAnio[2]}-${MONTHS_ES[conAnio[1]]}`;
  const soloMes = t.match(new RegExp(`(?:^|[^A-Z])(${meses})(?![A-Z])`));
  if (soloMes) {
    const mes = Number(MONTHS_ES[soloMes[1]]);
    const anio = mes > hoy.getMonth() + 1 ? hoy.getFullYear() - 1 : hoy.getFullYear();
    return `${anio}-${MONTHS_ES[soloMes[1]]}`;
  }
  return seleccionado || null;
}

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
/**
 * [CB.59] Las vistas, agrupadas por el paso del proceso (Edgar, 2026-11-09: «una barra por proceso»).
 * El orden es el del trabajo: lo que falta → lo que entra → lo que se revisa → contra Kepler. Lo de
 * consulta ocasional va en «Más» (medido 30 días: Factoraje 2 consultas, Capturas WhatsApp 3).
 */
export type BankViewGrupo = 'cierre' | 'entra' | 'revisa' | 'kepler' | 'mas';
export const VIEW_GRUPOS: { key: BankViewGrupo; label: string }[] = [
  { key: 'cierre', label: '' },
  { key: 'entra', label: 'Entra' },
  { key: 'revisa', label: 'Revisa' },
  { key: 'kepler', label: 'Contra Kepler' },
  { key: 'mas', label: '' },
];
export const WORK_VIEWS: { key: BankView; label: string; icon: string; grupo: BankViewGrupo }[] = [
  { key: 'cierre', label: 'Cierre', icon: 'pi pi-flag', grupo: 'cierre' },
  { key: 'estados', label: 'Estados de cuenta', icon: 'pi pi-file-import', grupo: 'entra' },
  { key: 'movimientos', label: 'Movimientos', icon: 'pi pi-list', grupo: 'revisa' },
  { key: 'cuentas', label: 'Cuentas', icon: 'pi pi-wallet', grupo: 'revisa' },
  { key: 'conciliacion', label: 'Conciliación', icon: 'pi pi-sync', grupo: 'kepler' },
  { key: 'cuadre', label: 'Cuadre 3 vías', icon: 'pi pi-check-square', grupo: 'kepler' },
  { key: 'concentrado', label: 'Concentrado', icon: 'pi pi-table', grupo: 'mas' },
  { key: 'contpaqi', label: 'Factoraje', icon: 'pi pi-credit-card', grupo: 'mas' },
  { key: 'capturas', label: 'Capturas WhatsApp', icon: 'pi pi-whatsapp', grupo: 'mas' },
];

/** El número que lleva cada pestaña: lo que pide trabajo en esa vista (sustituye a la franja de indicadores). */
export interface NumeroDePestana { texto: string; aria: string; aviso: boolean }
export interface DatosDePestanas {
  descargas: readonly { hasta: string | null; con_lector: boolean }[] | null;
  sinClasificar?: number | null;
  descuadradas?: number | null;
  conciliadoPct: number | null;
  conciliacionVieja: boolean;
}
export function numeroDePestana(v: BankView, d: DatosDePestanas): NumeroDePestana | null {
  switch (v) {
    case 'estados': {
      const c = (d.descargas ?? []).filter((x) => x.con_lector);
      if (!c.length) return null;
      const con = c.filter((x) => x.hasta).length;
      return { texto: `${con}/${c.length}`, aria: `${con} de ${c.length} cuentas con su descarga`, aviso: con < c.length };
    }
    case 'movimientos':
      return d.sinClasificar ? { texto: d.sinClasificar.toLocaleString('es-MX'), aria: `${d.sinClasificar} sin clasificar`, aviso: true } : null;
    case 'cuentas':
      return d.descuadradas ? { texto: String(d.descuadradas), aria: `${d.descuadradas} sin cuadrar`, aviso: true } : null;
    case 'conciliacion': {
      const p = d.conciliadoPct;
      if (d.conciliacionVieja) return { texto: `${p ?? '—'}% · desactualizado`, aria: 'se volvió a importar el libro después de la última conciliación: córrela de nuevo', aviso: true };
      return p == null ? { texto: 'sin correr', aria: 'la conciliación no se ha corrido en este periodo', aviso: true }
        : { texto: `${p}%`, aria: `${p}% conciliado por monto`, aviso: p < 80 };
    }
    default: return null;
  }
}

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

// Formato de dato: vive en finanzas-format (lo comparten Bancos y Caja). Se reexporta
// para no tocar los 11 componentes del tablero de bancos que ya lo importan de acá.
export { money, dmShort, dmy } from '../finanzas-format';
