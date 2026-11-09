import { instruccionDeLaNota, normalizarNumeroDeGuia, paquetesDeLaNota } from '@megadulces/contracts';
import { armarParadas, asignacionDelChofer, docOrigen, esViajeDelChofer, estadoFactura, llaveEmbarque, type EmbarqueDeGuia, type FacturasPorEmbarque } from './guia-reparto.logic';

/**
 * `[EMB.56]` La guía de reparto. El caso es la guía Kepler `0000969` (Padre Hidalgo, 23-jul-2026),
 * medida contra prod el 2026-11-09: el orden impreso (3, 4, 5, 6, 7, 9, 11, 12, 13) es
 * `kdm_rutas2.c4` y cruza tres rutas; un cliente con tres domicilios son tres paradas; un domicilio
 * con tres embarques es UNA parada; y el embarque 0000694 tiene dos facturas canceladas y una vigente.
 */

const emb = (p: Partial<EmbarqueDeGuia> & Pick<EmbarqueDeGuia, 'folio'>): EmbarqueDeGuia => ({
  serie: 1,
  folio_digital: `01UD4101-${p.folio}`,
  pedido_folio_digital: null,
  cliente_code: 'C0000',
  cliente_nombre: null,
  domicilio: '1',
  domicilio_supuesto: false,
  domicilio_calle: null,
  domicilio_ciudad: null,
  domicilio_telefono: null,
  ruta_nombre: 'R0005',
  orden_visita: null,
  ruta_metodo: 'domicilio',
  facturacion: 'F',
  nota_almacen: null,
  cajas: 0,
  kg: null,
  ...p,
});

const guia969: EmbarqueDeGuia[] = [
  emb({ folio: '0000670', cliente_code: 'C1025', orden_visita: 6, nota_almacen: 'CJ 7 PQ 1 UB 4', cajas: 7 }),
  emb({ folio: '0000684', cliente_code: '10002', orden_visita: 3, nota_almacen: 'CJ 4 PQ 1 UB 3', cajas: 4 }),
  emb({ folio: '0000685', cliente_code: 'C1012', orden_visita: 4, nota_almacen: 'CJ 28 UB 5', cajas: 28 }),
  emb({ folio: '0000686', cliente_code: '10003', orden_visita: 9, nota_almacen: 'PQ 1 UB 6' }),
  emb({ folio: '0000687', cliente_code: 'C1087', domicilio: '2', ruta_nombre: 'R0006', orden_visita: 11, nota_almacen: 'ZINAPARO PQ 1 UB 6' }),
  emb({ folio: '0000688', cliente_code: 'C1087', domicilio: '3', ruta_nombre: 'R0036', orden_visita: 13, nota_almacen: 'CHURINTZIO PQ 1 UB 6' }),
  emb({ folio: '0000690', cliente_code: 'C1087', domicilio: '2', ruta_nombre: 'R0006', orden_visita: 11, nota_almacen: 'ZINAPARO PQ 1 UB 6' }),
  emb({ folio: '0000691', cliente_code: 'C1087', domicilio: '2', ruta_nombre: 'R0006', orden_visita: 11, nota_almacen: 'ZINAPARO | PQ 1 UB 6' }),
  emb({ folio: '0000692', cliente_code: 'C1087', domicilio: '1', orden_visita: 7, nota_almacen: 'PENJAMILLO PQ 1 UB 6' }),
  emb({ folio: '0000693', cliente_code: 'C1013', orden_visita: 5, nota_almacen: 'TIENDA DE LA ESQUINA | CJ 8 PQ 2 UB 6', cajas: 8 }),
  emb({ folio: '0000694', cliente_code: 'C1012', orden_visita: 4, facturacion: 'R', nota_almacen: 'PQ 9 UB 5' }),
  emb({ folio: '0000695', cliente_code: 'C1014', ruta_nombre: 'R0006', orden_visita: 12, nota_almacen: 'LAS VELAS SOLIDOS SON AZUL', cajas: 10 }),
];

/** Las vigentes, como las devuelve el servicio: las dos canceladas del 0000694 ya no vienen. */
const facturas969: FacturasPorEmbarque = new Map([
  ['0000670', '0000373'], ['0000684', '0000374'], ['0000685', '0000396'], ['0000686', '0000382'],
  ['0000687', '0000375'], ['0000688', '0000376'], ['0000690', '0000377'], ['0000691', '0000378'],
  ['0000692', '0000379'], ['0000693', '0000383'], ['0000694', '0000400'], ['0000695', '0000399'],
].map(([e, f]) => [llaveEmbarque(1, e), [{ folio: f, folio_digital: `01UD0801-${f}` }]]));

describe('[EMB.56] armarParadas — la guía 0000969', () => {
  const { paradas, resumen } = armarParadas(guia969, facturas969);

  it('ordena por el número de Kepler aunque el viaje cruce tres rutas', () => {
    expect(paradas.map((p) => p.orden_visita)).toEqual([3, 4, 5, 6, 7, 9, 11, 12, 13]);
    expect(paradas.map((p) => p.numero)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('un cliente con tres domicilios son tres paradas; un domicilio con tres embarques, una', () => {
    const c1087 = paradas.filter((p) => p.cliente_code === 'C1087');
    expect(c1087.map((p) => p.orden_visita)).toEqual([7, 11, 13]);
    expect(c1087[1].documentos.map((d) => d.embarque_folio)).toEqual(['0000687', '0000690', '0000691']);
    expect(resumen).toMatchObject({ paradas: 9, documentos: 12 });
  });

  it('cada embarque lleva su factura; el 0000694 sólo la vigente', () => {
    const c1012 = paradas.find((p) => p.cliente_code === 'C1012')!;
    expect(c1012.documentos.map((d) => d.facturas.map((f) => f.folio))).toEqual([['0000396'], ['0000400']]);
    expect(paradas.flatMap((p) => p.documentos).every((d) => d.factura_estado === 'facturado')).toBe(true);
    expect(resumen.sin_factura).toBe(0);
  });

  it('las cajas salen de los renglones; los paquetes, de la nota (los arma el checador)', () => {
    const c1012 = paradas.find((p) => p.cliente_code === 'C1012')!;
    expect([c1012.cajas, c1012.paquetes]).toEqual([28, 9]);
    expect(c1012.documentos.map((d) => d.paquetes_nota)).toEqual([null, 9]);
    expect(resumen.cajas).toBe(57);
    expect(resumen.paquetes).toBe(19);
    // Sin «PQ» en ninguna nota de la parada: null, no cero.
    expect(paradas.find((p) => p.cliente_code === 'C1014')!.paquetes).toBeNull();
  });

  it('la instrucción es la nota sin el conteo de bultos', () => {
    expect(paradas.find((p) => p.cliente_code === 'C1013')!.instruccion).toBe('TIENDA DE LA ESQUINA');
    expect(paradas.find((p) => p.cliente_code === 'C1014')!.instruccion).toBe('LAS VELAS SOLIDOS SON AZUL');
    expect(paradas.find((p) => p.cliente_code === '10002')!.instruccion).toBeNull();
  });

  it('⛔ ningún campo de la hoja trae un importe', () => {
    const texto = JSON.stringify({ paradas, resumen });
    expect(texto).not.toMatch(/total|importe|monto|valor/i);
  });
});

describe('[EMB.56] lo que falta se dice', () => {
  it('sin orden en Kepler va al final, no intercalado', () => {
    const { paradas, resumen } = armarParadas([
      emb({ folio: '1', cliente_code: 'A', orden_visita: null }),
      emb({ folio: '2', cliente_code: 'B', orden_visita: 9 }),
      emb({ folio: '3', cliente_code: 'C', orden_visita: 2 }),
    ], new Map());
    expect(paradas.map((p) => p.cliente_code)).toEqual(['C', 'B', 'A']);
    expect(paradas[2].orden_visita).toBeNull();
    expect(resumen.sin_orden).toBe(1);
  });

  it('el estado de la factura distingue «sin factura», «no se factura» y el traspaso', () => {
    expect(estadoFactura(1, 'F', 0)).toBe('sin_factura');
    expect(estadoFactura(1, 'N', 0)).toBe('no_se_factura');
    expect(estadoFactura(1, 'F', 2)).toBe('facturado');
    expect(estadoFactura(2, null, 0)).toBe('no_aplica');
  });

  it('kg es null si ninguna parada lleva renglones por kilo (no es «cero kilos»)', () => {
    expect(armarParadas([emb({ folio: '1' })], new Map()).resumen.kg).toBeNull();
    expect(armarParadas([emb({ folio: '1', kg: 2.5 }), emb({ folio: '2', cliente_code: 'X' })], new Map()).resumen.kg).toBe(2.5);
  });

  it('el domicilio supuesto (c85 vacío) se declara en la parada', () => {
    expect(armarParadas([emb({ folio: '1', domicilio_supuesto: true })], new Map()).paradas[0].domicilio_supuesto).toBe(true);
  });
});

describe('[EMB.56] esViajeDelChofer · cada chofer, sólo sus viajes', () => {
  const doc = (chofer: string | null, unidad: string | null) => ({ chofer_clave_kepler: chofer, transporte_clave_kepler: unidad });
  // Canindo: la 00017 tiene chofer asignado en Kepler. Padre Hidalgo: la 00008, no.
  const asignados = new Map([['00017', '00017']]);

  it('es suyo si Kepler trae su clave en el embarque', () => {
    expect(esViajeDelChofer([doc('00017', '00017')], asignados, '00017')).toBe(true);
  });

  it('embarque SIN chofer: es suyo si él es el asignado a la unidad (lo que Kepler precarga)', () => {
    expect(esViajeDelChofer([doc(null, '00017')], asignados, '00017')).toBe(true);
  });

  it('⛔ el chofer del embarque manda sobre el de la unidad: si cubrió otro, no es suyo', () => {
    expect(esViajeDelChofer([doc('00009', '00017')], asignados, '00017')).toBe(false);
    expect(esViajeDelChofer([doc('00009', '00017')], asignados, '00009')).toBe(true);
  });

  it('⛔ unidad sin chofer asignado y embarque sin chofer: no es de nadie (la 00008 hoy)', () => {
    expect(esViajeDelChofer([doc(null, '00008')], asignados, '00008')).toBe(false);
    expect(esViajeDelChofer([doc(null, null)], asignados, '00017')).toBe(false);
  });

  it('dice POR QUÉ es suyo: el embarque es la fuente buena; la unidad, un respaldo que se declara', () => {
    expect(asignacionDelChofer([doc('00017', '00017')], asignados, '00017')).toBe('embarque');
    expect(asignacionDelChofer([doc(null, '00017')], asignados, '00017')).toBe('unidad');
    // Una guía donde un embarque lo trae a él y otro viene vacío: manda el embarque.
    expect(asignacionDelChofer([doc(null, '00017'), doc('00017', '00017')], asignados, '00017')).toBe('embarque');
    expect(asignacionDelChofer([doc('00009', '00017')], asignados, '00017')).toBeNull();
  });

  it('⛔ comparación EXACTA: «17» no es «00017» (normalizar atribuía mal 582 embarques)', () => {
    expect(esViajeDelChofer([doc('00017', '00017')], asignados, '17')).toBe(false);
    expect(esViajeDelChofer([doc('00017', '00017')], asignados, '')).toBe(false);
  });
});

describe('[EMB.56] llaves', () => {
  it('doc_origen calca la vista de facturas (UD + grupo + serie a dos dígitos)', () => {
    expect(docOrigen(1, '0000670')).toBe('UD4101-0000670');
    expect(docOrigen(2, '0000748')).toBe('UD4102-0000748');
  });

  it('normalizarNumeroDeGuia: liberal en la forma, estricto en el significado', () => {
    expect(normalizarNumeroDeGuia('969')).toBe('0000969');
    expect(normalizarNumeroDeGuia(' 0000969 ')).toBe('0000969');
    expect(normalizarNumeroDeGuia('G-969')).toBe('0000969');
    expect(normalizarNumeroDeGuia('')).toBeNull();
    expect(normalizarNumeroDeGuia('abc')).toBeNull();
    expect(normalizarNumeroDeGuia('0')).toBeNull();
    expect(normalizarNumeroDeGuia('12345678')).toBeNull(); // Kepler usa 7 dígitos: no se recorta a ciegas
  });

  it('paquetesDeLaNota suma PQ y P, y no confunde una palabra con P', () => {
    expect(paquetesDeLaNota('CJ 16 P 10 UB 6')).toBe(10);
    expect(paquetesDeLaNota('CJ 8 PQ 2 UB 6')).toBe(2);
    expect(paquetesDeLaNota('CJ 28 UB 5')).toBeNull();
    expect(paquetesDeLaNota('PAW PATROL Y 6 MINIE')).toBeNull();
    expect(paquetesDeLaNota(null)).toBeNull();
  });

  it('instruccionDeLaNota deja intacto lo que no es conteo', () => {
    expect(instruccionDeLaNota('CJ 16 P 10 UB 6')).toBeNull();
    expect(instruccionDeLaNota(null)).toBeNull();
    expect(instruccionDeLaNota('ZINAPARO | PQ 1 UB 6')).toBe('ZINAPARO');
    expect(instruccionDeLaNota('LAS BLS DE AGUINALDO SON 6 | CJ 10 PQ 8 UB 2')).toBe('LAS BLS DE AGUINALDO SON 6');
  });
});
