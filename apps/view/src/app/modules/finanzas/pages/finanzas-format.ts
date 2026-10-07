/**
 * Formato de dato compartido de Finanzas — importes y fechas.
 *
 * Vive fuera de `bancos-shared` desde 2026-08: `/finanzas/caja` tenía su propia copia de
 * `money()` que cortaba a **pesos enteros**, justo lo contrario de lo que necesita una
 * pantalla de conciliación — los centavos suelen SER la diferencia que se anda buscando.
 * Una sola definición evita que vuelva a divergir.
 */
// `money` vive en shared/util: la usan Finanzas y Compras. Acá sólo se reexporta para
// no tocar los archivos que ya la importaban de este módulo.
export { money } from '../../../shared/util';

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
