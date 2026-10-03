/**
 * `[GX.65.5]` — **En qué columna va cada vale de «Mis gastos».**
 *
 * La regla, decidida por el usuario el 2026-10-03:
 *
 *  1 · **Solicitudes** — lo que todavía no pasa por «Revisado».
 *      Arriba (rojo, te toca): el vale que Kepler te asignó y falta tu evidencia · el devuelto.
 *      Abajo: enviado, espera «Revisado».
 *  2 · **Pendientes de comprobación** — el aprobado que todavía debe un papel: la factura de la
 *      prefactura/cotización (`provisional`, GX.54/55) o la evidencia del comprobable (GX.32).
 *      Arriba (rojo): te toca subirlo. Abajo: lo subiste y espera revisión.
 *  3 · **Expedientes** — validado: «Revisado» sin deber nada. Arriba: sin pago. Abajo: pagados.
 *
 * ⚠️ **Lo que NO decide la columna:** el gasto `XA1001` de Kepler (decidido: sólo se muestra) ni
 * la etapa de ejercicio. La columna sale del ESTADO del expediente, que es nuestro.
 *
 * ⛔ **«Pagados» hoy siempre está vacío, y se dice.** El pago `XD2601` no trae a qué gasto paga
 * (`c37 = '0'` y `c39` vacío en el 100%): hasta poder ligarlo, ningún expediente se puede afirmar
 * pagado. Dibujarlo sin esa liga sería inventar el dato.
 *
 * ⛔ Un estado que esta regla no conoce devuelve `null`: la pantalla lo cuenta y lo dice, en vez
 * de meterlo callado en una columna que no le corresponde.
 */

export type ColumnaId = 'solicitudes' | 'comprobacion' | 'expedientes';
export type ZonaId = 'pendiente' | 'espera';

export interface Ubicacion { columna: ColumnaId; zona: ZonaId }

/** Lo único que la regla necesita saber de una fila. */
export interface FilaUbicable {
  /** `'asignado'` = vale de Kepler sin expediente nuestro todavía. */
  etapa?: string | null;
  /** Estado de nuestro expediente; `null` en el asignado. */
  status?: string | null;
}

export function ubicacionDe(f: FilaUbicable): Ubicacion | null {
  if (f.etapa === 'asignado') return { columna: 'solicitudes', zona: 'pendiente' };
  switch (f.status) {
    case 'rechazada': return { columna: 'solicitudes', zona: 'pendiente' };
    case 'recibida': return { columna: 'solicitudes', zona: 'espera' };
    case 'aprobada': return { columna: 'comprobacion', zona: 'pendiente' };
    case 'revision': return { columna: 'comprobacion', zona: 'espera' };
    case 'validada': return { columna: 'expedientes', zona: 'pendiente' };
    default: return null;
  }
}

/** Días enteros desde una fecha `YYYY-MM-DD` (o ISO) hasta `hoy`. `null` si no se puede leer. */
export function diasDesde(fecha: string | null | undefined, hoy: Date = new Date()): number | null {
  if (!fecha) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const h = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const dias = Math.round((h.getTime() - d.getTime()) / 86_400_000);
  return dias < 0 ? 0 : dias;
}

/** Desde cuántos días un pendiente se marca como atorado. */
export const DIAS_ATORADO = 30;

export function textoAntiguedad(dias: number | null): string {
  if (dias === null) return '';
  if (dias === 0) return 'hoy';
  return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
}

/** Lo que hace falta para agrupar por proveedor. */
export interface FilaConProveedor {
  proveedor_clave?: string | null;
  proveedor_nombre?: string | null;
  /** Lo que tecleó quien capturó: sólo se usa si Kepler no dio clave, y se DICE. */
  titulo?: string | null;
  importe: number;
}

export interface GrupoProveedor<T> {
  clave: string | null;
  etiqueta: string;
  filas: T[];
  total: number;
}

/**
 * Agrupa por la CLAVE de proveedor de Kepler (decisión del usuario: «para hacer un gasto tienes
 * que, a fuerzas, partir de un proveedor»).
 *
 * ⚠️ Sin clave de Kepler, los vales NO se agrupan por el nombre tecleado — 367 variantes para 337
 * claves: juntaría y separaría al azar. Van a un solo grupo «Sin clave de Kepler», al final.
 */
export function agruparPorProveedor<T extends FilaConProveedor>(filas: readonly T[]): GrupoProveedor<T>[] {
  const grupos = new Map<string, GrupoProveedor<T>>();
  const SIN = '\u0000sin';
  for (const f of filas) {
    const clave = String(f.proveedor_clave ?? '').trim() || null;
    const k = clave ?? SIN;
    let g = grupos.get(k);
    if (!g) {
      const nombre = String(f.proveedor_nombre ?? '').trim();
      g = {
        clave,
        etiqueta: clave ? (nombre || 'nombre no disponible en Kepler') : 'Sin clave de proveedor en Kepler',
        filas: [], total: 0,
      };
      grupos.set(k, g);
    }
    g.filas.push(f);
    g.total += Number(f.importe) || 0;
  }
  const lista = [...grupos.values()];
  lista.sort((a, b) => {
    if (!a.clave) return 1;
    if (!b.clave) return -1;
    return a.etiqueta.localeCompare(b.etiqueta, 'es');
  });
  return lista;
}
