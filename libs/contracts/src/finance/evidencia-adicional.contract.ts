/**
 * `[GX.87]` **Evidencia adicional en un vale ya capturado: se agrega y ya.**
 *
 * Pedido del usuario (2026-10-29): *«un botón en cada vale en el cual se adjunte más evidencia y
 * que agregue el por qué»*. Decisiones tomadas con él:
 *  · **No cambia el estado del vale** ni borra nada: los archivos se SUMAN al expediente.
 *  · Cada archivo agregado lleva **su porqué, quién y cuándo** (va en el expediente y en su PDF).
 *  · Pueden agregar **el dueño del vale y quien aprueba** (`FINANCE_EXPENSES_COMPROBAR`).
 *
 * Es distinto de la reapertura (`[GX.29]`), que PIDE reabrir un vale para cambiarle el estado.
 * Esto no reabre nada: deja constancia de algo más, con su motivo.
 *
 * Sin dependencias: lo leen el servidor (que valida) y la pantalla (que ofrece el botón).
 */

/** El rol con que se guarda cada archivo agregado. Uno solo: pueden ser varios archivos. */
export const ROL_EVIDENCIA_ADICIONAL = 'adicional';

/** El porqué, en una frase: la misma vara que la reapertura. */
export const MOTIVO_EVIDENCIA_MINIMO = 10;

/** Archivos por envío. Para más, se agrega otra vez (cada envío con su porqué). */
export const MAX_ARCHIVOS_EVIDENCIA_ADICIONAL = 5;

/** Los estados que aceptan evidencia adicional. Un vale rechazado se vuelve a capturar. */
export const ESTADOS_CON_EVIDENCIA_ADICIONAL: readonly string[] = ['recibida', 'aprobada', 'revision', 'validada'];

/** ¿Este vale acepta evidencia adicional por su estado? */
export function aceptaEvidenciaAdicional(status: string | null | undefined): boolean {
  return ESTADOS_CON_EVIDENCIA_ADICIONAL.includes(String(status ?? ''));
}

/** Un archivo ya subido al almacenamiento, tal como lo manda la pantalla. */
export interface ArchivoAdicional {
  role?: string | null;
  url?: string | null;
}

/**
 * Lo que impide mandar la evidencia adicional, en palabras para la persona. `null` = se puede.
 * La pantalla lo usa para el botón y el servidor para rechazar con el mismo texto.
 */
export function faltaParaEvidenciaAdicional(d: { motivo?: string | null; archivos?: readonly ArchivoAdicional[] | null }): string | null {
  const archivos = (d.archivos ?? []).filter((a) => a && String(a.url ?? '').trim());
  if (!archivos.length) return 'Agrega al menos un archivo.';
  if (archivos.length > MAX_ARCHIVOS_EVIDENCIA_ADICIONAL) {
    return `Son ${MAX_ARCHIVOS_EVIDENCIA_ADICIONAL} archivos como máximo por envío.`;
  }
  if (archivos.some((a) => a.role !== ROL_EVIDENCIA_ADICIONAL)) return 'Hay un archivo que no es evidencia adicional.';
  if (String(d.motivo ?? '').trim().length < MOTIVO_EVIDENCIA_MINIMO) {
    return 'Escribe en una frase por qué agregas esta evidencia.';
  }
  return null;
}

/** ¿Este archivo del expediente es evidencia agregada después? */
export function esEvidenciaAdicional(f: { role?: string | null } | null | undefined): boolean {
  return String(f?.role ?? '') === ROL_EVIDENCIA_ADICIONAL;
}
