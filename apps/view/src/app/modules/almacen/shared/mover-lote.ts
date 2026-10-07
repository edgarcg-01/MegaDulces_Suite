/**
 * Almacén · **mover un lote de un rack a otro**: qué se puede y qué no, dicho antes.
 *
 * La regla vive acá y no dentro del diálogo porque la pantalla tiene que poder
 * decir el problema **mientras se teclea**, no al apretar Mover. El backend la
 * vuelve a aplicar —es el que manda— pero enterarse de que el destino no existe
 * después de escribir el movimiento entero es exactamente el patrón que esta
 * fase viene corrigiendo.
 *
 * Es una función pura: no conoce Angular ni la red, y por eso se puede probar
 * entera.
 */

/** Una ubicación conocida del almacén, reducida a lo que la validación mira. */
export interface UbicacionConocida {
  code: string;
  label?: string | null;
  tipoLabel?: string;
  unidades?: number;
}

export interface MovimientoPropuesto {
  /** Código del rack de origen, como lo tiene la fila que se está mirando. */
  desdeCodigo: string;
  /** Lo que el operario tecleó o escaneó. Puede venir sucio. */
  hastaCodigo: string;
  /** Lo que hay del lote en el origen. */
  disponible: number;
  cantidad: number;
  /** Las ubicaciones que existen en este almacén. */
  conocidas: UbicacionConocida[];
}

export interface Veredicto {
  /** `true` sólo si el movimiento se puede intentar. */
  puede: boolean;
  /**
   * Qué decir del destino, mientras se teclea. `null` = todavía no escribió
   * nada, que no es lo mismo que "está mal".
   */
  aviso: string | null;
  /** `true` cuando el aviso señala un problema y no una confirmación. */
  esProblema: boolean;
}

/**
 * Normaliza como el servidor: mayúsculas, sin espacios al borde y los espacios
 * internos a guion. Tiene que coincidir con `normalizeBinCode` del backend, o la
 * pantalla diría "no existe" sobre un código que el servidor sí encuentra.
 */
export function normalizarCodigo(v: string | null | undefined): string {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '-');
}

export function validarMovimiento(m: MovimientoPropuesto): Veredicto {
  const hasta = normalizarCodigo(m.hastaCodigo);
  const desde = normalizarCodigo(m.desdeCodigo);
  const cantidad = Number(m.cantidad);
  const disponible = Number(m.disponible);

  if (!hasta) return { puede: false, aviso: null, esProblema: false };

  if (hasta === desde)
    return { puede: false, aviso: 'Es el mismo rack de origen.', esProblema: true };

  const destino = m.conocidas.find((b) => normalizarCodigo(b.code) === hasta);
  if (!destino)
    return {
      puede: false,
      aviso: `No existe ${hasta} en este almacén. Creala desde Administrar.`,
      esProblema: true,
    };

  // El destino existe: a partir de acá el aviso confirma, no corrige.
  const nombre = destino.label || destino.tipoLabel || 'Ubicación';
  const aviso = `${nombre} · tiene ${Number(destino.unidades ?? 0)} unidades`;

  if (!Number.isFinite(cantidad) || cantidad <= 0)
    return { puede: false, aviso: 'Escribí cuánto vas a mover.', esProblema: true };

  if (cantidad > disponible)
    return {
      puede: false,
      aviso: `En ${desde} hay ${disponible}: no podés mover ${cantidad}.`,
      esProblema: true,
    };

  return { puede: true, aviso, esProblema: false };
}
