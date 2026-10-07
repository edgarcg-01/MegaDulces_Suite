/**
 * `[GX.27]` — **La rejilla del mes.** Función pura.
 *
 * Convierte «un mes + los días que tuvieron gasto» en las semanas que dibuja el calendario
 * del Historial. Vive aparte del componente para poder probarla sin montar Angular: un
 * calendario que corre un día, o que pierde el 31, es un error que se ve tarde y se cree
 * temprano.
 *
 * ## ⚠️ Nada de `new Date(iso)`
 * `new Date('2026-09-01')` es medianoche **UTC**: en México (−06:00) cae el 31 de agosto a
 * las 18:00, y la rejilla arrancaría el día equivocado. Acá se arma con `Date.UTC` y se lee
 * con los getters `UTC*`, así que el calendario es aritmética de casilleros — sin husos.
 */

/** Los días de la semana como los rotula el calendario, empezando en domingo. */
export const DIAS_SEMANA = ['D', 'L', 'M', 'M', 'J', 'V', 'S'] as const;

export interface CeldaCalendario {
  /** `YYYY-MM-DD`. */
  dia: string;
  /** El número que se pinta. */
  numero: number;
  /** `false` = relleno del mes vecino, para que la semana tenga siete casilleros. */
  delMes: boolean;
  esHoy: boolean;
  /** Cuántos levantamientos hubo. `0` = ninguno. */
  n: number;
  monto: number;
}

/** Lo que el servidor manda de cada día con movimiento. */
export interface DiaConGasto {
  dia: string;
  n: number;
  monto: number;
}

const dosDig = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${dosDig(d.getUTCMonth() + 1)}-${dosDig(d.getUTCDate())}`;

/**
 * Las semanas del mes, siempre de **siete** celdas.
 *
 * Los huecos de los extremos se rellenan con los días vecinos marcados `delMes: false`:
 * dejarlos vacíos haría que las columnas no correspondan al día de la semana que rotulan —
 * que es lo único que un calendario tiene que garantizar.
 *
 * ⚠️ Los días **sin gasto** llegan igual, con `n: 0`. El servidor sólo manda los que tuvieron
 * movimiento (mandar 30 ceros no agrega información); la rejilla es la que sabe que el mes
 * tiene todos sus días.
 */
export function semanasDelMes(
  mes: string,
  dias: readonly DiaConGasto[] = [],
  hoy = '',
): CeldaCalendario[][] {
  if (!/^\d{4}-\d{2}$/.test(String(mes ?? ''))) return [];
  const anio = Number(mes.slice(0, 4));
  const m = Number(mes.slice(5, 7));
  if (m < 1 || m > 12) return [];

  const porDia = new Map<string, DiaConGasto>();
  for (const d of dias ?? []) if (d?.dia) porDia.set(d.dia, d);

  const primero = new Date(Date.UTC(anio, m - 1, 1));
  // El domingo de la semana en la que cae el día 1. `getUTCDay()`: 0 = domingo.
  const arranque = new Date(primero);
  arranque.setUTCDate(arranque.getUTCDate() - primero.getUTCDay());

  // Cuántas celdas hacen falta: el relleno de adelante + los días del mes, redondeado a
  // semanas completas. `Date.UTC(anio, m, 0)` es el día 0 del mes SIGUIENTE, o sea el último
  // del actual — así febrero no necesita saber si es bisiesto.
  const diasEnMes = new Date(Date.UTC(anio, m, 0)).getUTCDate();
  const celdas = Math.ceil((primero.getUTCDay() + diasEnMes) / 7) * 7;

  const semanas: CeldaCalendario[][] = [];
  const cursor = new Date(arranque);
  for (let c = 0; c < celdas; c++) {
    if (c % 7 === 0) semanas.push([]);
    const key = iso(cursor);
    const info = porDia.get(key);
    semanas[semanas.length - 1].push({
      dia: key,
      numero: cursor.getUTCDate(),
      delMes: cursor.getUTCMonth() === m - 1 && cursor.getUTCFullYear() === anio,
      esHoy: key === hoy,
      n: Number(info?.n) || 0,
      monto: Math.round((Number(info?.monto) || 0) * 100) / 100,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return semanas;
}

/** Corre un mes `YYYY-MM` N meses, sin salirse del calendario. */
export function sumarMeses(mes: string, n: number): string {
  if (!/^\d{4}-\d{2}$/.test(String(mes ?? ''))) return mes;
  const anio = Number(mes.slice(0, 4));
  const m = Number(mes.slice(5, 7));
  const total = anio * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${dosDig((total % 12) + 1)}`;
}

/** El mes de un día `YYYY-MM-DD`. */
export function mesDe(dia: string): string {
  const t = String(dia ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t.slice(0, 7) : '';
}
