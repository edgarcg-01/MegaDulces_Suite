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

/** Unidad en plural cuando toca: "1 caja" · "4 cajas" · "2.5 kg" · "10 pz". */
export function formatUnidad(v: number | string | null | undefined, unit: string | null | undefined): string {
  const u = String(unit || 'pz');
  if (u === 'kg' || u === 'pz') return u; // no se pluralizan
  return Number(v) === 1 ? u : `${u}s`;
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
 *  - El motivo sólo nombra lo que se sabe: producto sin catálogo (no hay `product_id`) o falta de
 *    existencia SIN FECHA registrada. No adivina por qué falta (conteo físico mayor, lote ya
 *    fechado…): eso lo decide quien revise el inventario.
 *
 * ⚠️ NO resuelve —y no lo oculta— que `quantity` está en la unidad que se eligió (caja/pieza/…) y
 * `feedLine` la mueve tal cual contra existencia que puede estar en otra: ver `docs/UNIDADES_DE_MEDIDA.md`.
 */
export function estadoFefo(l: {
  fed_to_fefo?: boolean | null;
  fefo_qty?: number | string | null;
  quantity?: number | string | null;
  product_id?: string | null;
}): EstadoFefo {
  const cap = Number(l.quantity);
  const capturado = Number.isFinite(cap) && cap > 0 ? cap : 0;
  const fq = Number(l.fefo_qty);
  const fechado = l.fed_to_fefo && Number.isFinite(fq) && fq > 0 ? fq : 0;

  if (fechado <= 0) {
    return {
      nivel: 'ninguno', reflejado: 0, capturado, faltante: capturado,
      motivo: l.product_id
        ? 'el sistema no tiene existencia sin fecha de este producto en esta sucursal'
        : 'el producto no está en el catálogo',
    };
  }
  if (fechado >= capturado - TOLERANCIA_FEFO) {
    return { nivel: 'total', reflejado: Math.min(fechado, capturado) || fechado, capturado, faltante: 0, motivo: null };
  }
  return {
    nivel: 'parcial', reflejado: fechado, capturado, faltante: capturado - fechado,
    motivo: 'el sistema no tenía más existencia sin fecha de este producto en esta sucursal',
  };
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
