/**
 * `[MS.7.4]` + `[MS.7.8]` — Campos propios de una cola y su validación. PURO: sin base, sin red.
 *
 * Cada cola declara qué MÁS pregunta al reportar (`servicedesk.queue_fields`): un sí/no, una opción de una lista, un texto o una
 * foto. Lo que la persona contesta viaja en `extra` (un objeto `{ codigo: valor }`) y se guarda en `requests.extra`.
 *
 * Reglas (todas con su prueba negativa en el spec):
 *  · ⛔ una clave que la cola NO declara se RECHAZA (no se ignora): un formulario desactualizado debe enterarse, y la base no se
 *    llena de datos sin dueño. (Contraste con la zona, que se ignora: ahí el formulario sí puede traerla de una categoría anterior.)
 *  · «Requerido» exige una respuesta de verdad: un sí/no `false` cuenta (es una respuesta); un texto vacío o en blanco no.
 *  · El tipo se respeta: un booleano debe ser verdadero/falso (no «no»), una opción debe ser una de la lista, un texto es texto.
 *  · Lo OPCIONAL sin contestar (ausente, `null` o texto en blanco) NO se guarda: «no se preguntó/contestó» ≠ un valor inventado.
 *  · La FOTO no viaja en `extra`: es un adjunto. Requerida ⇒ debe haber al menos un adjunto; opcional ⇒ no se exige nada.
 */
import { SD_FIELD_MAX_TEXT, type SdFieldType } from '@megadulces/contracts';

/** Lo mínimo que el validador necesita de la definición de un campo (la lee de `queue_fields`). */
export interface CampoDef {
  code: string;
  label: string;
  type: SdFieldType;
  required: boolean;
  options: string[];
}

export interface ResultadoCamposExtra {
  /** Lo que se guarda en `requests.extra` (sólo lo contestado, ya normalizado). */
  valores: Record<string, boolean | string>;
  /** Todos los problemas, en español, en el orden de los campos. Vacío ⇒ válido. */
  errores: string[];
}

const esObjetoPlano = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param campos     los campos ACTIVOS de la cola de la categoría elegida
 * @param extra      lo que mandó el formulario (cualquier cosa: no se confía)
 * @param adjuntos   cuántos archivos adjuntó la persona (para el campo de tipo foto)
 */
export function validarCamposExtra(campos: readonly CampoDef[], extra: unknown, adjuntos: number): ResultadoCamposExtra {
  const errores: string[] = [];
  const valores: Record<string, boolean | string> = {};

  if (extra !== undefined && extra !== null && !esObjetoPlano(extra)) {
    return { valores, errores: ['Los campos adicionales deben venir como un objeto'] };
  }
  const recibido: Record<string, unknown> = esObjetoPlano(extra) ? extra : {};
  const porCodigo = new Map(campos.map((c) => [c.code, c]));

  // ⛔ Lo que la cola no declara se rechaza (no se ignora).
  for (const clave of Object.keys(recibido)) {
    const def = porCodigo.get(clave);
    if (!def) errores.push(`El campo «${clave}» no existe en esta área`);
    else if (def.type === 'photo') errores.push(`«${def.label}» es una foto: se adjunta como archivo, no como texto`);
  }

  for (const c of campos) {
    if (c.type === 'photo') {
      if (c.required && adjuntos < 1) errores.push(`Adjunta una foto: «${c.label}» es obligatoria`);
      continue;
    }
    const v = recibido[c.code];
    const sinContestar = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (sinContestar) {
      if (c.required) errores.push(`Contesta «${c.label}»: es obligatorio`);
      continue;
    }
    if (c.type === 'boolean') {
      if (typeof v !== 'boolean') errores.push(`«${c.label}» debe ser sí o no`);
      else valores[c.code] = v;
    } else if (c.type === 'select') {
      if (typeof v !== 'string' || !c.options.includes(v)) errores.push(`«${c.label}»: elige una de las opciones de la lista`);
      else valores[c.code] = v;
    } else {
      // text
      if (typeof v !== 'string') errores.push(`«${c.label}» debe ser texto`);
      else if (v.trim().length > SD_FIELD_MAX_TEXT) errores.push(`«${c.label}» admite hasta ${SD_FIELD_MAX_TEXT} caracteres`);
      else valores[c.code] = v.trim();
    }
  }
  return { valores, errores };
}

/**
 * `[MS.7.4]` Valida la DEFINICIÓN de un campo antes de guardarla (la base es la última defensa; esto devuelve el motivo en español).
 * Devuelve los errores; vacío ⇒ válida.
 */
export function validarDefinicionCampo(d: { code?: unknown; label?: unknown; type?: unknown; options?: unknown }): string[] {
  const errores: string[] = [];
  if (typeof d.code !== 'string' || !/^[a-z][a-z0-9_]{0,29}$/.test(d.code)) errores.push('code debe ir en minúsculas, empezar con letra y usar sólo letras, números y guion bajo (máx. 30)');
  const label = typeof d.label === 'string' ? d.label.trim() : '';
  if (!label || label.length > 80) errores.push('Escribe la pregunta del campo (hasta 80 caracteres)');
  const tipos: readonly string[] = ['boolean', 'select', 'text', 'photo'];
  if (typeof d.type !== 'string' || !tipos.includes(d.type)) {
    errores.push(`type debe ser uno de: ${tipos.join(', ')}`);
    return errores;
  }
  const opciones = d.options;
  if (d.type === 'select') {
    if (!Array.isArray(opciones) || opciones.some((o) => typeof o !== 'string')) {
      errores.push('Las opciones deben ser una lista de textos');
    } else {
      const limpias = opciones.map((o: string) => o.trim());
      if (limpias.length < 2 || limpias.length > 20) errores.push('Un campo de opciones necesita entre 2 y 20 opciones');
      if (limpias.some((o) => !o || o.length > 60)) errores.push('Cada opción debe tener de 1 a 60 caracteres');
      if (new Set(limpias).size !== limpias.length) errores.push('Las opciones no pueden repetirse');
    }
  } else if (opciones !== undefined && !(Array.isArray(opciones) && opciones.length === 0)) {
    errores.push('Sólo un campo de tipo «opciones» lleva lista de opciones');
  }
  return errores;
}
