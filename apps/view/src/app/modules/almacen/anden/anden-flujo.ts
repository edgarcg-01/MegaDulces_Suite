/**
 * Andén · **el que decide qué sigue**.
 *
 * **Una función pura que, después de cada guardado, dice cuál es el siguiente
 * paso.** No pinta, no llama a la red y no conoce Angular — por eso se puede
 * probar entera, que es lo que no se podía hacer con la decisión repartida en la
 * plantilla.
 *
 * Las reglas, y por qué cada una:
 *
 * **R1 · El almacén congelado se sabe ANTES de capturar.** Hoy el bloqueo del
 * inventario físico aparece como un error al guardar: el operario fecha, aprieta,
 * y recién ahí se entera de que ese almacén tiene un conteo abierto. Con el vale
 * ya identificado el almacén se conoce, así que la pregunta se hace al abrir y el
 * paso es `bloqueado` con el folio que lo frena.
 *
 * **R2 · (retirada el 2026-10-07, `[WMS-REC.21]`).** Decía "al fechar se resuelve
 * la ubicación, siempre": el lote recién fechado se acomodaba con la caja en la
 * mano (decisión de negocio del 2026-09-23). Quien recibe pidió separarlo: con el
 * camión enfrente se fecha, y acomodar es otro trabajo, en Ubicaciones
 * («Por acomodar»). El número queda sin usar a propósito, para que R3 y R4 sigan
 * diciendo lo mismo en los commits y los specs que ya las nombran.
 *
 * **R3 · Nunca devolver al operario a una lista.** Después de guardar siempre hay
 * un siguiente paso calculado. Las listas quedan para las excepciones (buscar un
 * renglón puntual), no para el camino normal.
 *
 * **R4 · Cerrar sólo cuando de verdad no queda nada por fechar**, y cuando no se
 * puede, que el paso diga qué falta en vez de ofrecer un botón que va a fallar.
 * Lo que falte acomodar NO frena el cierre: el vale cuenta lo que llegó, y el
 * lugar de cada lote se sigue en Ubicaciones, en «Por acomodar».
 */

/** Un renglón del vale, reducido a lo que la decisión necesita. */
export interface FlujoLinea {
  id: string;
  /** Piezas que todavía esperan lote y caducidad. 0 = renglón resuelto. */
  faltaFechar: number;
}

export interface FlujoEstado {
  /** `null` = todavía no se identificó el vale. */
  valeAbierto: boolean;
  valeCerrado: boolean;
  /**
   * Folio del inventario físico que congela este almacén, si lo hay.
   * `null` = el almacén acepta movimientos.
   */
  congeladoPorFolio: string | null;
  lineas: FlujoLinea[];
}

export type PasoAnden =
  /** No hay vale: pedir el folio. */
  | { tipo: 'folio' }
  /** El almacén está congelado por un conteo: no se puede capturar nada. */
  | { tipo: 'bloqueado'; folio: string }
  /** Capturar lote y caducidad de este renglón. */
  | { tipo: 'fechar'; lineaId: string }
  /** No queda nada: se puede cerrar el vale. */
  | { tipo: 'cerrar' }
  /** El vale ya está cerrado. */
  | { tipo: 'terminado' };

/** Lo que el encabezado necesita para que el avance esté SIEMPRE a la vista. */
export interface FlujoAvance {
  renglonesTotales: number;
  renglonesListos: number;
  /** 0..1 sobre los renglones del vale. `0` si no hay nada que hacer. */
  fraccion: number;
  /** `true` sólo cuando no queda ni un renglón por fechar. */
  todoListo: boolean;
}

/** Qué hacer **ahora**. */
export function siguientePaso(estado: FlujoEstado): PasoAnden {
  if (!estado.valeAbierto) return { tipo: 'folio' };

  // R1 — el congelamiento manda sobre todo lo demás: mientras el conteo esté
  // abierto no hay nada que capturar, y decirlo acá evita que el operario
  // escriba una captura entera para que el guardado la rechace.
  if (estado.congeladoPorFolio) return { tipo: 'bloqueado', folio: estado.congeladoPorFolio };

  if (estado.valeCerrado) return { tipo: 'terminado' };

  const porFechar = estado.lineas.filter((l) => l.faltaFechar > 0);

  // R3 — mientras haya etiquetas que leer, el camión es la prioridad.
  if (porFechar.length) return { tipo: 'fechar', lineaId: porFechar[0].id };

  // R4 — cerrar es el único paso que queda, y sólo acá.
  return { tipo: 'cerrar' };
}

/**
 * El avance del vale, para que el encabezado lo muestre siempre.
 *
 * `[WMS-REC.21]` Cuenta sólo lo fechado. Antes sumaba también los lotes por
 * acomodar; ahora eso se mide en Por acomodar, que es donde se hace.
 */
export function avance(estado: FlujoEstado): FlujoAvance {
  const renglonesTotales = estado.lineas.length;
  const renglonesListos = estado.lineas.filter((l) => l.faltaFechar <= 0).length;

  return {
    renglonesTotales,
    renglonesListos,
    // Sin trabajo declarado la fracción es 0, no 1: un vale vacío no está
    // "completo", está sin cargar — y pintar 100% invita a cerrarlo.
    fraccion: renglonesTotales > 0 ? renglonesListos / renglonesTotales : 0,
    todoListo: renglonesTotales > 0 && renglonesListos === renglonesTotales,
  };
}

/**
 * Por qué no se puede cerrar todavía, en palabras. `null` = se puede cerrar.
 *
 * Existe para que el botón de cerrar no sea un botón que falla: hoy el cierre se
 * ofrece y el backend contesta 409 si quedan renglones retenidos.
 */
export function motivoNoCerrable(estado: FlujoEstado): string | null {
  if (!estado.valeAbierto) return 'Todavía no identificaste el vale.';
  if (estado.congeladoPorFolio)
    return `El almacén está congelado por el inventario físico ${estado.congeladoPorFolio}.`;
  if (estado.valeCerrado) return 'El vale ya está cerrado.';

  const faltanFechar = estado.lineas.filter((l) => l.faltaFechar > 0).length;
  if (faltanFechar)
    return `Faltan ${faltanFechar} ${faltanFechar === 1 ? 'renglón' : 'renglones'} por fechar.`;
  return null;
}
