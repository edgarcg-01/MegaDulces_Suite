/**
 * CB.14 — Base compartida del tablero de bancos (constantes + helpers puros + tipos).
 * Fuente única para el shell y los 6 componentes hijo (cierre/movimientos/concentrado/
 * conciliacion/cuentas/admin). Sin estado ni dependencias de Angular: solo datos y
 * funciones puras, así cada hijo importa lo que necesita sin acoplarse al shell.
 */

export type BankView = 'cierre' | 'estados' | 'movimientos' | 'concentrado' | 'conciliacion' | 'contpaqi' | 'cuadre' | 'comisiones' | 'ingresos' | 'cuentas' | 'admin';
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
  // [CB.64] «Movimientos» ya no es pestaña: es una ventana que abre Cuentas (y el Cierre, y un archivo subido).
  // [BFU.4.5.13] Ingresos y egresos (de dónde viene y a dónde va cada peso) y Cuentas (los saldos) son dos preguntas:
  // juntas en una vista obligaban a desplazarse (Edgar, 2026-11-25: «para no hacer tanto scroll»).
  { key: 'ingresos', label: 'Ingresos y egresos', icon: 'pi pi-arrow-right-arrow-left', grupo: 'revisa' },
  { key: 'cuentas', label: 'Cuentas', icon: 'pi pi-wallet', grupo: 'revisa' },
  { key: 'conciliacion', label: 'Conciliación', icon: 'pi pi-sync', grupo: 'kepler' },
  { key: 'cuadre', label: 'Cuadre 3 vías', icon: 'pi pi-check-square', grupo: 'kepler' },
  // [CB.62] Las comisiones de la terminal que faltan en Kepler (la descarga del banco → solicitud, gasto y pagos).
  { key: 'comisiones', label: 'Comisiones', icon: 'pi pi-percentage', grupo: 'kepler' },
  { key: 'concentrado', label: 'Concentrado', icon: 'pi pi-table', grupo: 'mas' },
  { key: 'contpaqi', label: 'Factoraje', icon: 'pi pi-credit-card', grupo: 'mas' },
  // [CB.78] «Capturas WhatsApp» (CBW) salió de la barra el 2026-11-17: 0 capturas en toda su vida y 1 consulta en 30
  // días. El backend (ingesta de WhatsApp) sigue montado; si llega a tener remitentes reales, vuelve aquí.
];

/** El número que lleva cada pestaña: lo que pide trabajo en esa vista (sustituye a la franja de indicadores). */
export interface NumeroDePestana { texto: string; aria: string; aviso: boolean }
export interface DatosDePestanas {
  descargas: readonly { hasta: string | null; con_lector: boolean }[] | null;
  sinClasificar?: number | null;
  descuadradas?: number | null;
  conciliadoPct: number | null;
  conciliacionVieja: boolean;
  /**
   * [CB.77] `false` = el estado de la conciliación todavía no llega o no se pudo leer: la pestaña no lleva número.
   * Antes decía «sin correr» mientras el diagnóstico cargaba o si fallaba: no medido no es lo mismo que no corrido.
   * Sin el campo vale como medido (lo que había antes).
   */
  conciliacionMedida?: boolean;
  /** [CB.62] Cargos de comisión listos para Kepler; `null` = la propuesta no se cargó o no se pudo medir. */
  comisionesListas?: number | null;
  /** [BFU.4.5.13] Lo que falta explicar del periodo; `null` = el diagnóstico no lo midió. */
  porLigar?: { n: number; atrasados: number } | null;
}
export function numeroDePestana(v: BankView, d: DatosDePestanas): NumeroDePestana | null {
  switch (v) {
    case 'estados': {
      const c = (d.descargas ?? []).filter((x) => x.con_lector);
      if (!c.length) return null;
      const con = c.filter((x) => x.hasta).length;
      return { texto: `${con}/${c.length}`, aria: `${con} de ${c.length} cuentas con su descarga`, aviso: con < c.length };
    }
    case 'ingresos': {
      // Lo que falta explicar; es aviso sólo si algo lleva más de 5 días hábiles sin ligar.
      const p = d.porLigar;
      return p && p.n ? { texto: String(p.n), aria: `${p.n} movimientos por explicar${p.atrasados ? `, ${p.atrasados} con más de 5 días hábiles` : ''}`, aviso: p.atrasados > 0 } : null;
    }
    case 'cuentas':
      return d.descuadradas ? { texto: String(d.descuadradas), aria: `${d.descuadradas} sin cuadrar`, aviso: true } : null;
    case 'conciliacion': {
      if (d.conciliacionMedida === false) return null;
      const p = d.conciliadoPct;
      if (d.conciliacionVieja) return { texto: `${p ?? '—'}% · desactualizado`, aria: 'hay movimientos que el motor todavía no revisa; los concilia solo', aviso: true };
      return p == null ? { texto: 'sin correr', aria: 'la conciliación no se ha corrido en este periodo', aviso: true }
        : { texto: `${p}%`, aria: `${p}% conciliado por monto`, aviso: p < 80 };
    }
    case 'comisiones': {
      // Informativo, no aviso: mientras la escritura en Kepler no exista, la pestaña no pide una acción imposible.
      const n = d.comisionesListas;
      return n ? { texto: String(n), aria: `${n} cargos de comisión listos para Kepler`, aviso: false } : null;
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

/**
 * `[BFU.4.5.6]` Por qué falta ligar un movimiento del banco, en palabras (la clave la pone `leerFila` en la API:
 * el motivo del motor de categoría o, si tiene categoría sin evidencia, de dónde salió). Una clave que no esté
 * aquí se muestra tal cual: no se inventa un nombre.
 */
export const MOTIVO_POR_LIGAR: Readonly<Record<string, string>> = {
  deposito_sin_documento: 'Depósitos sin documento de Kepler',
  cobranza_sin_cliente: 'Cobranza sin cliente',
  categoria_sin_evidencia: 'Categoría sin evidencia',
  kepler_aun_no_lo_tiene: 'Kepler todavía no lo tiene',
  kepler_no_lo_tiene: 'Kepler no lo tiene',
  kepler_en_otra_cuenta: 'Kepler lo tiene en otra cuenta',
  pareo_debil: 'Casó con un documento dudoso',
  pareo_pendiente: 'Falta correr la conciliación',
  cuenta_sin_categoria: 'Su cuenta contable no tiene categoría',
  documento_sin_cuenta: 'El documento no dice su cuenta contable',
  documento_sin_aplicacion: 'El documento no dice qué paga',
  deposito_que_no_es_venta: 'Préstamo o devolución que entró como depósito',
  categoria_contra_direccion: 'La categoría va contra la dirección del dinero',
  sin_ods: 'Sin datos de Kepler en este entorno',
  sin_motivo: 'Sin motivo del motor',
};
export const motivoPorLigar = (k: string): string => MOTIVO_POR_LIGAR[k] ?? k;
