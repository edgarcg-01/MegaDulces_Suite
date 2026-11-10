import {
  instruccionDeLaNota,
  paquetesDeLaNota,
  type GuiaRepartoDocumento,
  type GuiaRepartoFacturaEstado,
  type GuiaRepartoParada,
  type GuiaRepartoResumen,
} from '@megadulces/contracts';

/**
 * `[EMB.56]` La guía de reparto, en funciones puras: de los embarques de un viaje a las paradas de
 * la hoja del chofer. El servicio trae las filas; aquí se decide el orden, el agrupado y qué se dice.
 */

/** Un embarque `U-D-41` del viaje con lo que la hoja necesita (sin importes). */
export interface EmbarqueDeGuia {
  serie: number;
  folio: string;
  folio_digital: string;
  pedido_folio_digital: string | null;
  cliente_code: string | null;
  cliente_nombre: string | null;
  domicilio: string | null;
  domicilio_supuesto: boolean | null;
  domicilio_calle: string | null;
  domicilio_ciudad: string | null;
  domicilio_telefono: string | null;
  ruta_nombre: string | null;
  orden_visita: number | null;
  ruta_metodo: string | null;
  /** `kdm1.c43` del embarque: N = no se factura. */
  facturacion: string | null;
  nota_almacen: string | null;
  cajas: number | null;
  kg: number | null;
}

/** Facturas vigentes por embarque, con llave `serie|folio`. */
export type FacturasPorEmbarque = Map<string, Array<{ folio: string; folio_digital: string }>>;

export const llaveEmbarque = (serie: number, folio: string) => `${serie}|${folio}`;

/** El `doc_origen` con que la factura apunta a su embarque (`UD4101-0000670`), igual que `[AX.17]`. */
export const docOrigen = (serie: number, folio: string) => `UD41${String(serie).padStart(2, '0')}-${folio}`;

/**
 * `[EMB.56]` La carga de una camioneta de Ruta Directa NO es un viaje de reparto (PM, 2026-11-09).
 *
 * Kepler la registra como un embarque `U-D-41` serie 2 cuyo cliente es la ruta misma: código
 * `RUTA 21`, `RD021` o `RD 501`, destino `R.D. 21 …` o `RUTA DIRECTA 21`. La camioneta vende a bordo:
 * no hay paradas que repartir. Medido en prod (2026-11-09, un año): las dos marcas coinciden en
 * 1,064 de 1,064 embarques, todos serie 2, desde el 27-jun; son ~1 de cada 4 guías (Padre Hidalgo y
 * Canindo). Las dos expresiones se usan igual en SQL (`~*`) y aquí.
 */
export const RD_CLIENTE = '^(RUTA|RD)\\s*0*[0-9]+$';
export const RD_DESTINO = '^(R\\.\\s?D\\.|RUTA DIRECTA)';
export function esCargaDeRutaDirecta(e: { cliente_code: string | null; destino_nombre: string | null }): boolean {
  return new RegExp(RD_CLIENTE, 'i').test((e.cliente_code ?? '').trim())
    || new RegExp(RD_DESTINO, 'i').test((e.destino_nombre ?? '').trim());
}

/**
 * `[EMB.56]` ¿Es este viaje del chofer? Cada chofer ve SÓLO sus viajes (PM, 2026-11-09).
 *
 * Un embarque es suyo si Kepler trae su clave en el embarque (`c84`, ya resuelta contra el catálogo:
 * `chofer_clave_kepler`) o, si el embarque viene SIN chofer, si él es el chofer asignado a la unidad
 * en el catálogo de Kepler (`kdm_transporte.c4`), que es justo lo que Kepler precarga. El viaje es
 * suyo si alguno de sus embarques lo es (una guía lleva un solo chofer: 388 de 388, EMB.0).
 *
 * ⛔ Por RUTA no: la mitad de las guías cruza 2–4 rutas y una ruta la atienden varias unidades
 * (FASE_EMB §8). Comparación EXACTA de claves: normalizar a ciegas atribuía mal 582 embarques (EMB.0.1).
 */
export function esViajeDelChofer(
  embarques: Array<{ chofer_clave_kepler: string | null; transporte_clave_kepler: string | null }>,
  choferDeLaUnidad: Map<string, string>,
  claveChofer: string,
): boolean {
  return asignacionDelChofer(embarques, choferDeLaUnidad, claveChofer) !== null;
}

/**
 * Por qué el viaje es del chofer. ⭐ El EMBARQUE es la fuente buena; la UNIDAD sólo un respaldo que se
 * declara: contra el GPS, el día que Kepler le pone una guía a un camión, el camión no se movió en ~1 de
 * cada 3 (FASE_EMB §8), así que «el chofer de la unidad» puede recibir un viaje que no manejó.
 *  · `embarque` — almacén lo capturó como chofer en la salida por embarque (`c84`);
 *  · `unidad`   — el embarque viene sin chofer y él es el asignado a la unidad (`kdm_transporte.c4`);
 *  · null       — no es suyo.
 */
export function asignacionDelChofer(
  embarques: Array<{ chofer_clave_kepler: string | null; transporte_clave_kepler: string | null }>,
  choferDeLaUnidad: Map<string, string>,
  claveChofer: string,
): 'embarque' | 'unidad' | null {
  const clave = claveChofer.trim();
  if (!clave) return null;
  if (embarques.some((e) => e.chofer_clave_kepler?.trim() === clave)) return 'embarque';
  const porUnidad = embarques.some((e) => {
    if (e.chofer_clave_kepler?.trim()) return false; // el chofer del embarque manda sobre el de la unidad
    const unidad = e.transporte_clave_kepler?.trim();
    return !!unidad && choferDeLaUnidad.get(unidad) === clave;
  });
  return porUnidad ? 'unidad' : null;
}

export function estadoFactura(
  serie: number,
  facturacion: string | null,
  facturas: number,
): GuiaRepartoFacturaEstado {
  if (serie !== 1) return 'no_aplica'; // traspaso o carga a ruta: no lleva factura
  if (facturas > 0) return 'facturado';
  if (facturacion === 'N') return 'no_se_factura';
  return 'sin_factura';
}

const sumaONull = (xs: Array<number | null>): number | null =>
  xs.some((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null;

/**
 * Agrupa por cliente + domicilio de entrega (así lo imprime Kepler: un cliente con tres
 * domicilios son tres paradas) y ordena por el orden de visita de Kepler, que es UNA secuencia
 * aunque el viaje cruce rutas. Sin orden → al final, por ruta y cliente: nunca intercaladas.
 */
export function armarParadas(
  embarques: EmbarqueDeGuia[],
  facturas: FacturasPorEmbarque,
): { paradas: GuiaRepartoParada[]; resumen: GuiaRepartoResumen } {
  const grupos = new Map<string, EmbarqueDeGuia[]>();
  for (const e of embarques) {
    const k = `${e.cliente_code ?? ''}|${e.domicilio ?? '1'}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(e);
  }

  const sinNumero = Number.POSITIVE_INFINITY;
  const ordenDe = (g: EmbarqueDeGuia[]) => {
    const os = g.map((e) => e.orden_visita).filter((o): o is number => o != null && Number.isFinite(o));
    return os.length ? Math.min(...os) : sinNumero;
  };

  const ordenados = [...grupos.values()].sort((a, b) => {
    const oa = ordenDe(a);
    const ob = ordenDe(b);
    if (oa !== ob) return oa - ob;
    const ra = a[0].ruta_nombre ?? '￿';
    const rb = b[0].ruta_nombre ?? '￿';
    if (ra !== rb) return ra.localeCompare(rb, 'es');
    return (a[0].cliente_code ?? '').localeCompare(b[0].cliente_code ?? '');
  });

  let sinFactura = 0;
  const paradas = ordenados.map((g, i): GuiaRepartoParada => {
    const docs = [...g].sort((a, b) => a.folio.localeCompare(b.folio));
    const documentos = docs.map((e): GuiaRepartoDocumento => {
      const fs = facturas.get(llaveEmbarque(e.serie, e.folio)) ?? [];
      const estado = estadoFactura(e.serie, e.facturacion, fs.length);
      if (estado === 'sin_factura') sinFactura++;
      return {
        serie: e.serie,
        embarque_folio: e.folio,
        embarque_folio_digital: e.folio_digital,
        pedido_folio_digital: e.pedido_folio_digital,
        facturas: fs,
        factura_estado: estado,
        cajas: e.cajas,
        paquetes_nota: paquetesDeLaNota(e.nota_almacen),
        kg: e.kg,
      };
    });
    const instrucciones = [...new Set(docs.map((e) => instruccionDeLaNota(e.nota_almacen)).filter((x): x is string => !!x))];
    const p = docs[0];
    const orden = ordenDe(g);
    return {
      numero: i + 1,
      orden_visita: orden === sinNumero ? null : orden,
      cliente_code: p.cliente_code,
      cliente_nombre: p.cliente_nombre,
      domicilio_calle: p.domicilio_calle,
      domicilio_ciudad: p.domicilio_ciudad,
      domicilio_telefono: p.domicilio_telefono,
      domicilio_supuesto: docs.some((e) => !!e.domicilio_supuesto),
      ruta_nombre: p.ruta_nombre,
      instruccion: instrucciones.length ? instrucciones.join(' · ') : null,
      cajas: docs.reduce((a, e) => a + (e.cajas ?? 0), 0),
      paquetes: sumaONull(documentos.map((d) => d.paquetes_nota)),
      kg: sumaONull(docs.map((e) => e.kg)),
      documentos,
    };
  });

  const resumen: GuiaRepartoResumen = {
    paradas: paradas.length,
    documentos: embarques.length,
    cajas: paradas.reduce((a, p) => a + p.cajas, 0),
    paquetes: sumaONull(paradas.map((p) => p.paquetes)),
    kg: sumaONull(paradas.map((p) => p.kg)),
    sin_orden: paradas.filter((p) => p.orden_visita == null).length,
    sin_domicilio: ordenados.filter((g) => g.some((e) => e.ruta_metodo === 'sin_domicilio')).length,
    sin_factura: sinFactura,
  };
  return { paradas, resumen };
}
