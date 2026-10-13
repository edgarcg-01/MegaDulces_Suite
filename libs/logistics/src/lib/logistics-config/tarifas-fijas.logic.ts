/**
 * `[EMB.28.1]` Tarifas fijas — la regla del candado, pura para poder probarla sin base.
 *
 * Una tarifa con la que se le PAGA a alguien (comisión por ruta, viático, maniobra de carga) se
 * captura una vez y queda fija: cambiarla, borrarla o desactivarla exige
 * `LOGISTICS_TARIFAS_AUTORIZAR`. Una tarifa en cero todavía no está fijada: capturarla es de
 * quien configura (`LOGISTICS_CONFIG_GESTIONAR`).
 *
 * El NOMBRE de la ruta también cuenta: la tarifa de un viaje de Kepler se empareja por nombre
 * normalizado (`comisionSugerida`), así que renombrar una ruta tarifada mueve su comisión a otro
 * viaje igual que cambiar el monto.
 */

/** Las categorías de `config_finance` con las que se paga a una persona. */
export const CATEGORIAS_QUE_PAGAN = ['viatico', 'tarifa_maniobra'] as const;

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const igualNum = (a: unknown, b: unknown) => Math.abs(n(a) - n(b)) < 0.005;

export interface RutaTarifa {
  name?: string | null;
  driver_commission?: unknown;
  helper_commission?: unknown;
  active?: boolean | null;
  /** `[EMB.33]` «No paga comisión» también es una tarifa: quitarla haría cobrar una ruta local. */
  sin_comision?: boolean | null;
}

export interface ConfigTarifa {
  key?: string | null;
  category?: string | null;
  value?: unknown;
  active?: boolean | null;
}

/** ¿La ruta ya tiene una tarifa fijada? (cero en las dos = todavía no). */
export function rutaFijada(r: RutaTarifa): boolean {
  return !!r.sin_comision || n(r.driver_commission) > 0 || n(r.helper_commission) > 0;
}

/** ¿El renglón de configuración ya es una tarifa fijada con la que se paga? */
export function configFijada(c: ConfigTarifa): boolean {
  return (CATEGORIAS_QUE_PAGAN as readonly string[]).includes(String(c.category ?? '')) && n(c.value) > 0;
}

export interface CambioDeTarifa {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Los cambios que toca una edición de ruta y que importan para el pago. */
export function cambiosDeRuta(antes: RutaTarifa, dto: Partial<RutaTarifa>): CambioDeTarifa[] {
  const c: CambioDeTarifa[] = [];
  for (const k of ['driver_commission', 'helper_commission'] as const) {
    if (dto[k] !== undefined && !igualNum(dto[k], antes[k])) {
      c.push({ field: k, old_value: txt(n(antes[k]).toFixed(2)), new_value: txt(n(dto[k]).toFixed(2)) });
    }
  }
  if (dto.name !== undefined && String(dto.name ?? '').trim() !== String(antes.name ?? '').trim()) {
    c.push({ field: 'name', old_value: txt(antes.name), new_value: txt(dto.name) });
  }
  if (dto.active === false && antes.active !== false) {
    c.push({ field: 'active', old_value: 'true', new_value: 'false' });
  }
  if (dto.sin_comision !== undefined && dto.sin_comision !== null && !!dto.sin_comision !== !!antes.sin_comision) {
    c.push({ field: 'sin_comision', old_value: String(!!antes.sin_comision), new_value: String(!!dto.sin_comision) });
  }
  return c;
}

/** Los cambios que toca una edición de un renglón de configuración y que importan para el pago. */
export function cambiosDeConfig(antes: ConfigTarifa, dto: Partial<ConfigTarifa>): CambioDeTarifa[] {
  const c: CambioDeTarifa[] = [];
  if (dto.value !== undefined && !igualNum(dto.value, antes.value)) {
    c.push({ field: 'value', old_value: txt(n(antes.value)), new_value: txt(n(dto.value)) });
  }
  for (const k of ['key', 'category'] as const) {
    if (dto[k] !== undefined && dto[k] !== antes[k]) c.push({ field: k, old_value: txt(antes[k]), new_value: txt(dto[k]) });
  }
  if (dto.active === false && antes.active !== false) {
    c.push({ field: 'active', old_value: 'true', new_value: 'false' });
  }
  return c;
}

/** El mensaje cuando alguien sin el permiso intenta tocar una tarifa fijada. */
export function mensajeTarifaFijada(que: string): string {
  return `La tarifa de ${que} ya está fijada: sólo un autorizador (LOGISTICS_TARIFAS_AUTORIZAR) puede cambiarla, borrarla o desactivarla.`;
}
