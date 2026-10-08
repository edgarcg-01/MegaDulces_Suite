/**
 * `[CG.67]` **El estado de la firma lo decide el SERVIDOR.** Puro, sin base de datos.
 *
 * ⚠️ Esto no es una comodidad de organización: es la regla de ADR-076. La pantalla manda la
 * imagen y el nombre; el estado se calcula acá. Si el cliente pudiera mandar `firma_estado`,
 * podría declarar `firmado` **sin imagen** — o sea firmar por otro, y que un reporte de
 * cumplimiento lo cuente como cumplido.
 *
 * ⛔ Y por eso tampoco alcanza con mirar si el campo viene lleno: se valida que sea **un PNG**.
 * `firma_png = 'ok'` pasaría cualquier chequeo de «no nulo» y el CHECK de la tabla también.
 * Una evidencia que no se puede abrir es peor que la ausencia declarada, porque la ausencia al
 * menos sale en la lista de lo que falta.
 */

/** Los cuatro estados. `previo` NO lo produce este motor: sólo lo escribe el relleno retroactivo. */
export type EstadoFirma = 'firmado' | 'sin_firma' | 'no_aplica' | 'previo';

/**
 * Techo del data URI, en bytes.
 *
 * ⚠️ Medido contra lo que produce el primitivo (`[CG.66]`): un PNG de firma de un canvas de
 * ~300×160 pesa **3-15 KB**. 512 KB son ~30× de holgura y siguen siendo un límite — sin techo,
 * un cliente roto (o malicioso) mete megabytes en una columna que vive en la fila del libro.
 */
export const FIRMA_MAX_BYTES = 512 * 1024;

/** Lo que se encontró al revisar la firma que llegó. Nunca se tira en silencio. */
export interface RevisionFirma {
  readonly estado: EstadoFirma;
  /** El PNG que se va a guardar, o `null` si no hay nada guardable. */
  readonly png: string | null;
  /**
   * Por qué una firma que LLEGÓ no se guardó. `null` cuando no llegó ninguna o cuando se guardó.
   * ⭐ Existe para que «no firmó» y «firmó y lo tiramos» no se vean iguales en el libro.
   */
  readonly descartada: 'no_es_png' | 'muy_grande' | null;
}

/** ¿Este tipo de movimiento PIDE firma? */
export function pideFirma(tipo: string | null | undefined): boolean {
  // Sólo el gasto. Decisión de Edgar: *"firma quien RECIBE el efectivo que sale"*.
  //
  // ⚠️ El depósito también es efectivo que sale y NO la pide, con motivo: quien lo recibe es el
  // banco, y su respaldo es la ficha de depósito — que Fase CC ya guarda en
  // `finance.collection_deposits` con su OCR y su cuadre. Pedir una firma ahí sería pedir que
  // el banco firme, y duplicaría una evidencia que ya existe mejor.
  return tipo === 'gasto';
}

/** El largo en bytes de un data URI, sin materializar el buffer. */
function bytesDeDataUri(uri: string): number {
  const coma = uri.indexOf(',');
  const b64 = coma >= 0 ? uri.slice(coma + 1) : uri;
  const relleno = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - relleno);
}

/**
 * Decide el estado a partir del tipo de movimiento y de lo que llegó.
 *
 * `previo` nunca sale de acá: es un hecho del pasado, no una decisión del presente.
 */
export function revisarFirma(
  tipo: string | null | undefined,
  pngCrudo: string | null | undefined,
): RevisionFirma {
  const png = typeof pngCrudo === 'string' ? pngCrudo.trim() : '';
  const base: EstadoFirma = pideFirma(tipo) ? 'sin_firma' : 'no_aplica';

  if (!png) return { estado: base, png: null, descartada: null };

  // ⚠️ Se exige el encabezado completo, no sólo "data:". `data:text/html,<script>` también
  // empieza con "data:" y terminaría guardado en una columna que después alguien renderiza.
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(png)) {
    return { estado: base, png: null, descartada: 'no_es_png' };
  }
  if (bytesDeDataUri(png) > FIRMA_MAX_BYTES) {
    return { estado: base, png: null, descartada: 'muy_grande' };
  }

  // ⭐ Se firma aunque el tipo no la pidiera. Nadie firma de más por accidente, y rechazar una
  // firma que alguien SÍ puso seria tirar evidencia por no haberla pedido.
  return { estado: 'firmado', png, descartada: null };
}
