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
