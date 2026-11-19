/**
 * `[UB.RF.7]` El almacén que la persona eligió en Ubicaciones, compartido por sus tres pantallas
 * (Mapa, Asignación y Contenido). Antes cada una lo pedía otra vez y Contenido abría vacío.
 *
 * Es una comodidad de ESTE navegador (localStorage): si no hay almacenamiento, cada pantalla vuelve
 * a su comportamiento de antes. La elección sólo se usa si el almacén está en el alcance que la
 * pantalla recibió del servidor: una preferencia vieja nunca abre un almacén ajeno.
 */
const LLAVE = 'ub.almacen.v1';

export function almacenPreferido(): string | null {
  try {
    return localStorage.getItem(LLAVE) || null;
  } catch {
    return null;
  }
}

export function guardarAlmacenPreferido(id: string | null | undefined): void {
  if (!id) return;
  try {
    localStorage.setItem(LLAVE, id);
  } catch {
    /* sin almacenamiento: sólo no se recuerda */
  }
}

/**
 * De una lista de almacenes del alcance, cuál abrir: el preferido si está en la lista; si no, el que
 * propone el servidor o la pantalla (`porDefecto`); si no hay ninguno, `null`.
 */
export function elegirAlmacen<T extends { id: string }>(lista: readonly T[], porDefecto: string | null | undefined): string | null {
  const pref = almacenPreferido();
  if (pref && lista.some((w) => w.id === pref)) return pref;
  if (porDefecto && lista.some((w) => w.id === porDefecto)) return porDefecto;
  return null;
}
