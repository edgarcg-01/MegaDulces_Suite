import { caducidadUnidadDef, unidadEnTexto, type FefoMotivo } from '@megadulces/contracts';
/**
 * El **plazo** de una caducidad: cuántos días le quedan y qué tan grave es.
 *
 * Función pura, fuera de todo componente, porque es la regla de negocio de la
 * pantalla — no una decoración. La pantalla no le pregunta a la persona "¿cómo
 * ves la fecha?": clasifica sola desde la fecha, y así la hoja de anaquel y las
 * alertas del sistema dicen lo mismo.
 *
 * `RIESGOSO_DIAS = 30` no es arbitrario: es el MISMO umbral con el que el back
 * ya alerta lotes por vencer (`ALERT_THRESHOLDS.EXPIRING_LOTS_DAYS`). Si el
 * negocio mueve la ventana, se mueve acá y se mueve en toda la pantalla.
 * 90 días (un trimestre) es el plazo cómodo para rotar en tienda; entre 31 y 90
 * hay que traerlo vigilado.
 */

export type PlazoLevel = 'bueno' | 'intermedio' | 'riesgoso' | 'vencido';

export const PLAZO_RIESGOSO_DIAS = 30;
export const PLAZO_INTERMEDIO_DIAS = 90;

export interface Plazo {
  level: PlazoLevel;
  /** Días entre hoy y la caducidad. Negativo = ya venció. */
  dias: number;
  /** Veredicto corto, el que se lee de un vistazo. */
  title: string;
  /** El "por qué" en palabras de tienda. */
  detail: string;
}

/** `severity` de `p-tag` que le corresponde a cada nivel. */
export function plazoSeverity(level: PlazoLevel): 'success' | 'info' | 'warn' | 'danger' {
  if (level === 'vencido' || level === 'riesgoso') return 'danger';
  if (level === 'intermedio') return 'warn';
  return 'success';
}

/** Ícono PrimeIcons por nivel — el color nunca va solo (a11y: no solo-color). */
export function plazoIcon(level: PlazoLevel): string {
  switch (level) {
    case 'vencido': return 'pi pi-times-circle';
    case 'riesgoso': return 'pi pi-exclamation-triangle';
    case 'intermedio': return 'pi pi-eye';
    default: return 'pi pi-check-circle';
  }
}

/**
 * Días entre hoy y una fecha `YYYY-MM-DD`, contados a medianoche local para que
 * "vence hoy" dé 0 y no ±1 según la hora en que se captura.
 */
export function diasHasta(ymd: string | null | undefined): number | null {
  const s = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const objetivo = new Date(y, m - 1, d).setHours(0, 0, 0, 0);
  const hoy = new Date().setHours(0, 0, 0, 0);
  return Math.round((objetivo - hoy) / 86_400_000);
}

/**
 * Cantidad legible. Postgres devuelve `numeric` como string con todos sus
 * decimales (`"4.000"`), y eso llegaba crudo a la pantalla y **a la hoja que se
 * imprime y se archiva**: "4.000 caja" se lee como cuatro mil. Se recortan los
 * ceros de relleno pero se conservan los decimales reales (granel: `2.5` kg).
 */
export function formatCantidad(v: number | string | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  // `toFixed(3)` antes de limpiar para no arrastrar basura de punto flotante;
  // después se van los ceros finales y el punto que quede huérfano.
  return n.toFixed(3).replace(/\.?0+$/, '') || '0';
}

/**
 * Unidad en plural cuando toca: "1 caja" · "4 paquetes" · "2.5 kg" · "3 bolsas de 250 g" · "10 pz".
 * [P2.9 paso 1] Sale del contrato `caducidad-unidad` (antes `${u}s`, que habría dado «g250s»).
 */
export function formatUnidad(v: number | string | null | undefined, unit: string | null | undefined): string {
  return unidadEnTexto(v, unit);
}

/** Clasifica una caducidad. `null` si la fecha no es interpretable todavía. */
export function clasificarPlazo(ymd: string | null | undefined): Plazo | null {
  const dias = diasHasta(ymd);
  if (dias == null) return null;

  if (dias < 0) {
    const n = Math.abs(dias);
    return {
      level: 'vencido',
      dias,
      title: 'Vencido',
      detail: n === 1 ? 'venció ayer' : `venció hace ${n} días`,
    };
  }
  if (dias <= PLAZO_RIESGOSO_DIAS) {
    return {
      level: 'riesgoso',
      dias,
      title: 'Riesgoso',
      detail: dias === 0 ? 'vence hoy' : dias === 1 ? 'vence mañana' : `quedan ${dias} días`,
    };
  }
  if (dias <= PLAZO_INTERMEDIO_DIAS) {
    return { level: 'intermedio', dias, title: 'Intermedio', detail: `quedan ${dias} días — vigilarlo` };
  }
  return { level: 'bueno', dias, title: 'Buen plazo', detail: `quedan ${dias} días` };
}

// ── Cuánto de lo capturado llegó realmente al inventario (FEFO) ─────────────────────────────

/** `total` = todo lo capturado se fechó · `parcial` = sólo una parte · `ninguno` = nada se movió. */
export type FefoNivel = 'total' | 'parcial' | 'ninguno';

export interface EstadoFefo {
  nivel: FefoNivel;
  /** Lo que SÍ se fechó en el inventario (0 si nada). */
  reflejado: number;
  /** Lo que la persona capturó en el anaquel. */
  capturado: number;
  /** Lo que quedó sin fechar (0 si `total`). */
  faltante: number;
  /** Por qué no llegó todo; `null` cuando sí llegó todo. */
  motivo: string | null;
}

/** Las cantidades traen hasta 3 decimales (`numeric(14,3)`): por debajo de eso es ruido de coma flotante. */
const TOLERANCIA_FEFO = 0.0005;

/**
 * **¿Qué parte de lo capturado se reflejó en el inventario?**
 *
 * Existe porque la pantalla decía «Ya se reflejó en el control de inventario» con sólo mirar
 * `fed_to_fefo`, y esa bandera es verdadera aunque se haya movido UNA PARTE. `feedLine` mueve
 * `min(capturado, existencia sin fecha del producto en esa sucursal)`: capturar 10 cajas con 4
 * sin fecha en el sistema deja `fed_to_fefo = true` y `fefo_qty = 4`. La persona leía «listo»
 * y el inventario tenía 4.
 *
 * Reglas, y qué NO se afirma:
 *  - `fed_to_fefo` falso, o `fefo_qty` en 0/ausente → `ninguno`. No se confía en una cifra suelta
 *    si la bandera no la respalda (ni en la bandera sin cifra).
 *  - `fefo_qty` ≥ `quantity` (con tolerancia) → `total`. Si por algún motivo se fechó MÁS de lo
 *    capturado, se cuenta como `total` y `reflejado` se recorta a lo capturado: no se dice «12 de 10».
 *  - El motivo sólo nombra lo que se sabe. `[P2.9 paso 4]` Desde que FEFO convierte a la unidad
 *    base, **el motivo lo dice el servidor** (`fefo_motivo`) y aquí sólo se pone en palabras: con la
 *    conversión hay razones nuevas (la unidad no tiene factor en Kepler, el producto no se maneja en
 *    esa unidad) que la pantalla no podía inferir — y la inferencia de antes («no hay existencia sin
 *    fecha») habría sido falsa. Sin `fefo_motivo` (renglón anterior al paso 4) se infiere como antes:
 *    producto sin catálogo o falta de existencia SIN FECHA. No adivina por qué falta (conteo físico
 *    mayor, lote ya fechado…): eso lo decide quien revise el inventario.
 *
 * `fefo_qty` y `quantity` están los dos en la unidad CAPTURADA (caja/pieza/…): el servidor mueve
 * `quantity × factor` en la base y devuelve lo movido en la unidad capturada. Ver `feedLine`.
 */
export function estadoFefo(l: {
  fed_to_fefo?: boolean | null;
  fefo_qty?: number | string | null;
  quantity?: number | string | null;
  product_id?: string | null;
  fefo_motivo?: FefoMotivo | string | null;
  unit?: string | null;
}): EstadoFefo {
  const cap = Number(l.quantity);
  const capturado = Number.isFinite(cap) && cap > 0 ? cap : 0;
  const fq = Number(l.fefo_qty);
  const fechado = l.fed_to_fefo && Number.isFinite(fq) && fq > 0 ? fq : 0;
  const delServidor = l.fefo_motivo ? motivoFefoEnTexto(l.fefo_motivo, l.unit) : null;

  if (fechado <= 0) {
    return {
      nivel: 'ninguno', reflejado: 0, capturado, faltante: capturado,
      motivo: delServidor ?? (l.product_id
        ? 'el sistema no tiene existencia sin fecha de este producto en esta sucursal'
        : 'el producto no está en el catálogo'),
    };
  }
  if (fechado >= capturado - TOLERANCIA_FEFO) {
    return { nivel: 'total', reflejado: Math.min(fechado, capturado) || fechado, capturado, faltante: 0, motivo: null };
  }
  return {
    nivel: 'parcial', reflejado: fechado, capturado, faltante: capturado - fechado,
    motivo: delServidor ?? 'el sistema no tenía más existencia sin fecha de este producto en esta sucursal',
  };
}

/**
 * `[P2.9 paso 4]` El `fefo_motivo` del servidor en palabras de quien captura. Va detrás de «no movió
 * inventario: …» o «quedaron N sin fechar porque …». Un código que esta versión no conoce se muestra
 * crudo (no se traduce a otra cosa).
 */
export function motivoFefoEnTexto(motivo: FefoMotivo | string, unidad?: string | null): string {
  const d = caducidadUnidadDef(unidad);
  switch (motivo) {
    case 'sin_producto': return 'el producto no está en el catálogo';
    case 'sin_caducidad': return 'no tiene fecha de caducidad';
    case 'sin_cantidad': return 'la cantidad es cero';
    case 'sin_unidad': return 'no se dijo en qué unidad se contó';
    case 'sin_presentaciones':
      return 'Kepler no publica las presentaciones de este producto en esta sucursal, y sin ellas no se sabe a cuánto inventario equivale lo contado';
    case 'sin_lectura':
      return 'no se pudieron leer las presentaciones del producto en Kepler; corregir la captura lo vuelve a intentar';
    case 'unidad_fuera_del_producto':
      return `en Kepler este producto no se maneja en ${d?.plural ?? unidad ?? 'esa unidad'}`;
    case 'unidad_sin_factor':
      return `Kepler no dice a cuánto del inventario equivale «${d?.singular ?? unidad ?? 'esa unidad'}» en este producto`;
    case 'sin_existencia_sin_fecha': return 'el sistema no tiene existencia sin fecha de este producto en esta sucursal';
    case 'existencia_sin_fecha_insuficiente': return 'el sistema no tenía más existencia sin fecha de este producto en esta sucursal';
    default: return String(motivo);
  }
}

/**
 * Lo que se le dice a la persona al guardar. Un mensaje, tres tonos: `success` sólo si TODO llegó.
 * `unidad` es la de la captura (`caja`, `pieza`…); la plural la resuelve `formatUnidad`.
 */
export function mensajeFefo(
  e: EstadoFefo,
  unidad?: string | null,
): { severity: 'success' | 'warn' | 'info'; detail: string } {
  const u = (n: number): string => `${formatCantidad(n)} ${formatUnidad(n, unidad)}`;
  if (e.nivel === 'total') return { severity: 'success', detail: 'Ya se reflejó todo en el control de inventario.' };
  if (e.nivel === 'parcial') {
    return {
      severity: 'warn',
      detail: `Se reflejaron ${u(e.reflejado)} de ${u(e.capturado)} en el control de inventario: ${e.motivo}. Quedan ${u(e.faltante)} sin fechar.`,
    };
  }
  return { severity: 'info', detail: `Guardado, pero no movió inventario: ${e.motivo}.` };
}
