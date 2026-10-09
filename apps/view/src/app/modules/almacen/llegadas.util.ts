import type { AndenLlegada, AndenLlegadaEstado } from '@megadulces/contracts';

/**
 * `[WMS-REC.22]` Llegadas al andén — lo que la pantalla decide sin tocar la red: qué entra en cada
 * periodo, en qué orden y cuánto suma. Separado del componente para probarlo aislado.
 */

export type PeriodoLlegadas = 'hoy' | 'ayer' | '7d';

const RANGO: Record<AndenLlegadaEstado, number> = { sin_abrir: 0, a_medias: 1, completa: 2, en_camino: 3 };

/** El día anterior (`YYYY-MM-DD`), contado en el calendario y no en la zona del navegador. */
export function diaAnterior(dia: string): string {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * **Hoy** muestra lo de hoy, lo que va en camino y lo de días anteriores que sigue sin terminar
 * (sin abrir o a medias). Es la misma regla del menú del Andén: lo de ayer no se cae por cambiar
 * de día. **Ayer** es sólo el día anterior, y **7 días** es la ventana completa.
 */
export function enPeriodo(l: Pick<AndenLlegada, 'dia' | 'estado'>, periodo: PeriodoLlegadas, hoy: string): boolean {
  if (periodo === '7d') return true;
  if (periodo === 'ayer') return l.dia === diaAnterior(hoy);
  return l.dia === hoy || l.estado === 'sin_abrir' || l.estado === 'a_medias' || l.estado === 'en_camino';
}

/** Primero lo que pide atención (sin abrir, a medias, completas, en camino); dentro, lo más reciente. */
export function ordenarLlegadas<T extends Pick<AndenLlegada, 'estado' | 'dia' | 'vale'>>(lista: readonly T[]): T[] {
  const llave = (l: T): string => `${l.dia}|${l.vale?.abierto_en ?? ''}`;
  return [...lista].sort((a, b) => RANGO[a.estado] - RANGO[b.estado] || llave(b).localeCompare(llave(a)));
}

export interface ResumenLlegadas {
  /** Camiones que llegaron: todo menos lo que va en camino. */
  llegaron: number;
  proveedor: number;
  traspaso: number;
  manual: number;
  /** De los que llegaron, los de días anteriores a hoy. */
  anteriores: number;
  sin_abrir: number;
  /** Importe de Kepler de lo que entró sin que nadie abriera el vale. */
  importe_sin_abrir: number;
  a_medias: number;
  /** Renglones que les faltan a los camiones a medias. */
  renglones_sin_fecha: number;
  completas: number;
  /** Renglones que se declararon sin caducidad, en todos los camiones. */
  sin_caducidad: number;
  por_autorizar: number;
  en_camino: number;
}

export function resumirLlegadas(lista: readonly AndenLlegada[], hoy: string): ResumenLlegadas {
  const r: ResumenLlegadas = {
    llegaron: 0, proveedor: 0, traspaso: 0, manual: 0, anteriores: 0,
    sin_abrir: 0, importe_sin_abrir: 0, a_medias: 0, renglones_sin_fecha: 0,
    completas: 0, sin_caducidad: 0, por_autorizar: 0, en_camino: 0,
  };
  for (const l of lista) {
    r.sin_caducidad += l.resumen.sin_caducidad;
    r.por_autorizar += l.resumen.por_autorizar;
    if (l.estado === 'en_camino') { r.en_camino++; continue; }
    r.llegaron++;
    if (l.tipo === 'compra') r.proveedor++;
    else if (l.tipo === 'traspaso') r.traspaso++;
    else r.manual++;
    if (l.dia < hoy) r.anteriores++;
    if (l.estado === 'sin_abrir') { r.sin_abrir++; r.importe_sin_abrir += l.importe ?? 0; }
    else if (l.estado === 'a_medias') { r.a_medias++; r.renglones_sin_fecha += l.resumen.faltan; }
    else r.completas++;
  }
  return r;
}
