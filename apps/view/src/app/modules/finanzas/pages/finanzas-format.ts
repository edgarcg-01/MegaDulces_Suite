/**
 * Formato de dato compartido de Finanzas — importes y fechas.
 *
 * Vive fuera de `bancos-shared` desde 2026-08: `/finanzas/caja` tenía su propia copia de
 * `money()` que cortaba a **pesos enteros**, justo lo contrario de lo que necesita una
 * pantalla de conciliación — los centavos suelen SER la diferencia que se anda buscando.
 * Una sola definición evita que vuelva a divergir.
 */
/**
 * Importe en pesos SIN redondear — se muestra tal como viene del origen.
 * (Antes `money0` cortaba a pesos enteros: en una pantalla de conciliación eso
 * escondía los centavos que son justo la diferencia que se anda buscando.)
 */
// Acepta null: varias columnas del detalle son "el importe de la otra fuente, si lo tiene".
// El cuerpo ya trataba el nulo (`v || 0`); el tipo era el que no lo decía.
export function money(v: number | null | undefined): string {
  return Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
