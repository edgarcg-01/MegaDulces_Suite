/**
 * Andén · **el que decide qué sigue** (rediseño del flujo).
 *
 * Hoy el Andén tiene dos secciones —*Fechas* y *Ubicación*— y el operario las
 * recorre **enteras, una después de la otra**: fecha los 30 renglones, y recién
 * entonces va a acomodar los 30 lotes. Eso obliga a tocar la misma caja **dos
 * veces**: una para leerle la etiqueta y otra para llevarla al rack. La razón que
 * está escrita para ese orden es real pero es de DATOS, no de bodega — un lote no
 * se puede acomodar antes de existir, y existe en cuanto se fecha. O sea que la
 * segunda pasada es una consecuencia de cómo está partida la pantalla, no del
 * trabajo.
 *
 * Este módulo es el corazón del rediseño: **una función pura que, después de cada
 * guardado, dice cuál es el siguiente paso**. No pinta, no llama a la red y no
 * conoce Angular — por eso se puede probar entera, que es lo que no se podía
 * hacer con la decisión repartida entre `siguienteFechar()`, `siguienteUbicar()`
 * y dos `@switch` de plantilla.
 *
 * Las cuatro reglas, y por qué cada una:
 *
 * **R1 · El almacén congelado se sabe ANTES de capturar.** Hoy el bloqueo del
 * inventario físico aparece como un error al guardar: el operario fecha, aprieta,
 * y recién ahí se entera de que ese almacén tiene un conteo abierto. Con el vale
 * ya identificado el almacén se conoce, así que la pregunta se hace al abrir y el
 * paso es `bloqueado` con el folio que lo frena.
 *
 * **R2 · Al fechar se resuelve la ubicación, siempre.** Apenas un renglón queda
 * fechado, lo siguiente es acomodar ESE lote, con la caja todavía en la mano:
 *   - si el SKU **ya vive en un rack**, se ofrece ése y es un toque;
 *   - si **no tiene ubicación**, la pantalla ofrece **crearla ahí mismo** (con su
 *     cartel), en vez de mandar el lote a una cola.
 *
 * Es decisión del negocio (2026-09-23) y reemplaza una versión anterior de esta
 * regla que sólo ofrecía acomodar cuando el rack ya se conocía, para no hacer
 * caminar al operario con el camión descargando. Se descartó: un lote que cae a
 * la cola sin rack es mercancía que nadie encuentra, y `warehouse_bins` arrancó
 * en cero — crear la ubicación **es** el camino normal, no la excepción.
 *
 * **R3 · Nunca devolver al operario a una lista.** Después de guardar siempre hay
 * un siguiente paso calculado. Las listas quedan para las excepciones (buscar un
 * renglón puntual), no para el camino normal.
 *
 * **R4 · Cerrar sólo cuando de verdad no queda nada**, y cuando no se puede, que
 * el paso diga qué falta en vez de ofrecer un botón que va a fallar.
 */

/** Un renglón del vale, reducido a lo que la decisión necesita. */
export interface FlujoLinea {
  id: string;
  /** Piezas que todavía esperan lote y caducidad. 0 = renglón resuelto. */
  faltaFechar: number;
}

/** Un lote esperando rack, reducido a lo que la decisión necesita. */
export interface FlujoLote {
  /** Identidad del lote: producto + lote + caducidad (ver `claveLote`). */
  clave: string;
  /** De qué renglón salió, cuando se sabe. Es lo que permite la pasada única. */
  lineaId: string | null;
  /** Piezas de este lote sin acomodar. */
  porUbicar: number;
  /** Rack donde ya vive este SKU. `null` = hay que decidirlo caminando. */
  rackSugerido: string | null;
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
  lotes: FlujoLote[];
}

export type PasoAnden =
  /** No hay vale: pedir el folio. */
  | { tipo: 'folio' }
  /** El almacén está congelado por un conteo: no se puede capturar nada. */
  | { tipo: 'bloqueado'; folio: string }
  /** Capturar lote y caducidad de este renglón. */
  | { tipo: 'fechar'; lineaId: string }
  /** Llevar este lote a su rack. */
  | { tipo: 'ubicar'; clave: string; rackSugerido: string | null }
  /** No queda nada: se puede cerrar el vale. */
  | { tipo: 'cerrar' }
  /** El vale ya está cerrado. */
  | { tipo: 'terminado' };

/** Lo que el encabezado necesita para que el avance esté SIEMPRE a la vista. */
export interface FlujoAvance {
  renglonesTotales: number;
  renglonesListos: number;
  lotesPorAcomodar: number;
  /** 0..1 sobre el trabajo total (fechar + acomodar). `0` si no hay nada que hacer. */
  fraccion: number;
  /** `true` sólo cuando no queda ni un renglón por fechar ni un lote por acomodar. */
  todoListo: boolean;
}

/**
 * Qué hacer **ahora**.
 *
 * `recienFechada` es el renglón que se acaba de guardar; es lo que habilita la
 * regla R2. Se pasa explícito en vez de adivinarlo del estado porque "el último
 * que se tocó" no es derivable de una lista de pendientes — y adivinarlo mal
 * mandaría al operario a acomodar una caja que no tiene en la mano.
 */
export function siguientePaso(estado: FlujoEstado, recienFechada?: string | null): PasoAnden {
  if (!estado.valeAbierto) return { tipo: 'folio' };

  // R1 — el congelamiento manda sobre todo lo demás: mientras el conteo esté
  // abierto no hay nada que capturar, y decirlo acá evita que el operario
  // escriba una captura entera para que el guardado la rechace.
  if (estado.congeladoPorFolio) return { tipo: 'bloqueado', folio: estado.congeladoPorFolio };

  if (estado.valeCerrado) return { tipo: 'terminado' };

  const porFechar = estado.lineas.filter((l) => l.faltaFechar > 0);
  const porUbicar = estado.lotes.filter((l) => l.porUbicar > 0);

  // R2 — el lote que se acaba de fechar se acomoda ANTES de seguir, tenga o no
  // rack conocido: cuando no lo tiene, la pantalla de ubicar ofrece crearlo.
  // `rackSugerido: null` es la señal de "hay que darle ubicación", no un error.
  if (recienFechada) {
    const suyo = porUbicar.find((l) => l.lineaId === recienFechada);
    if (suyo) return { tipo: 'ubicar', clave: suyo.clave, rackSugerido: suyo.rackSugerido };
  }

  // R3 — mientras haya etiquetas que leer, el camión es la prioridad.
  if (porFechar.length) return { tipo: 'fechar', lineaId: porFechar[0].id };

  // Ya no queda nada que fechar: ahora sí se acomoda lo que quedó en la cola,
  // empezando por lo que ya tiene rack (es el que se resuelve de un toque).
  if (porUbicar.length) {
    const conRack = porUbicar.find((l) => l.rackSugerido);
    const elegido = conRack ?? porUbicar[0];
    return { tipo: 'ubicar', clave: elegido.clave, rackSugerido: elegido.rackSugerido };
  }

  // R4 — cerrar es el único paso que queda, y sólo acá.
  return { tipo: 'cerrar' };
}

/**
 * El avance del vale, para que el encabezado lo muestre siempre.
 *
 * Cuenta las **dos** mitades del trabajo (fechar y acomodar) en un solo número:
 * un vale con todo fechado y nada acomodado no está "al 100%", y mostrarlo así
 * es lo que hace que la mercancía se quede sin rack.
 */
export function avance(estado: FlujoEstado): FlujoAvance {
  const renglonesTotales = estado.lineas.length;
  const renglonesListos = estado.lineas.filter((l) => l.faltaFechar <= 0).length;
  const lotesPorAcomodar = estado.lotes.filter((l) => l.porUbicar > 0).length;
  const lotesTotales = estado.lotes.length;

  const trabajoTotal = renglonesTotales + lotesTotales;
  const hecho = renglonesListos + (lotesTotales - lotesPorAcomodar);

  return {
    renglonesTotales,
    renglonesListos,
    lotesPorAcomodar,
    // Sin trabajo declarado la fracción es 0, no 1: un vale vacío no está
    // "completo", está sin cargar — y pintar 100% invita a cerrarlo.
    fraccion: trabajoTotal > 0 ? hecho / trabajoTotal : 0,
    todoListo: renglonesTotales > 0 && renglonesListos === renglonesTotales && lotesPorAcomodar === 0,
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
  const faltanUbicar = estado.lotes.filter((l) => l.porUbicar > 0).length;

  if (faltanFechar && faltanUbicar)
    return `Faltan ${faltanFechar} renglones por fechar y ${faltanUbicar} lotes por acomodar.`;
  if (faltanFechar)
    return `Faltan ${faltanFechar} ${faltanFechar === 1 ? 'renglón' : 'renglones'} por fechar.`;
  if (faltanUbicar)
    return `Faltan ${faltanUbicar} ${faltanUbicar === 1 ? 'lote' : 'lotes'} por acomodar.`;
  return null;
}
