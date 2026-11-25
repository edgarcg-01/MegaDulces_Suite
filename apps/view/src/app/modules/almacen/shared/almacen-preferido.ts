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

/**
 * `[UB.RF.20]` El rollo amarillo que tiene cargado la impresora de ESTE equipo. Hay dos y conviven
 * (Edgar, 2026-11-25): 55 × 25 y 60 × 29, los dos medidos con regla.
 *
 * Se recuerda por máquina y no por persona ni por sucursal **porque el rollo está en la impresora que
 * tiene al lado quien imprime**: dos personas en la misma sucursal pueden imprimir en equipos con
 * rollos distintos, y la misma persona en otro equipo necesita el otro. Si no hay almacenamiento, se
 * usa el de siempre (55 × 25) y no se recuerda: nadie queda sin poder imprimir.
 */
const LLAVE_ROLLO = 'ub.rollo.v1';
const ROLLOS_VALIDOS = ['55x25', '60x29'] as const;

export function rolloRecordado(): '55x25' | '60x29' | null {
  try {
    const v = localStorage.getItem(LLAVE_ROLLO);
    // Se valida contra la lista: un valor viejo o manipulado no puede mandar una medida inventada a la TSC.
    return (ROLLOS_VALIDOS as readonly string[]).includes(v ?? '') ? (v as '55x25' | '60x29') : null;
  } catch {
    return null;
  }
}

export function recordarRollo(rollo: '55x25' | '60x29'): void {
  try {
    localStorage.setItem(LLAVE_ROLLO, rollo);
  } catch {
    /* sin almacenamiento: sólo no se recuerda */
  }
}
