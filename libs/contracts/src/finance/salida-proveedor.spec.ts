/**
 * `[PGP.97]` La regla de la guía «pagado en el banco, falta en Kepler».
 *
 * Los vectores son SINTÉTICOS (el repo es público): reproducen la FORMA de los casos medidos en
 * prod —el envío devuelto y reenviado, el pago capturado con la cuenta equivocada, el importe
 * tecleado con $300 menos, la transferencia que Kepler partió en un documento por sucursal, la
 * partida cancelada DESPUÉS de pagar (la limpieza de lo saldado), el anticipo, la tarjeta que es
 * gasto, el día que el banco no tiene cargado— sin nombres ni montos reales.
 */
import {
  armarGuia, esSalidaAProveedor, estadoPrograma, facturasQueSuman, parear, programaPorImporte, salidasDevueltas,
  salidasSinPago, sugerirAcreedor, ESPERA_CAPTURA_DIAS,
  type AbonoBancario, type EntradaGuia, type FacturaViva, type FuentesDeAtribucion, type PagoKeplerBanco,
  type PartidaDelPrograma, type SalidaBancaria,
} from './salida-proveedor.contract';

const sal = (o: Partial<SalidaBancaria> & { id: string }): SalidaBancaria => ({
  cuenta_id: 'cta-a', cuenta: 'BANCO A', account_label: 'A1', fecha: '2030-03-10', importe: 1000,
  raw_type: 'C', raw_code: '510', categoria: 'compra_mercancia', concepto: 'Dulces Prueba', ...o,
});
const pago = (o: Partial<PagoKeplerBanco> & { id: string }): PagoKeplerBanco => ({
  sucursal: '00', doc_tipo: 'X-D-26', folio: o.id, account_label: 'A1', banco_nombre: 'BANCO A1', tipo_cuenta: 'banco', fecha: '2030-03-10',
  fecha_captura: '2030-03-11', importe: 1000, acreedor: 'CP001', acreedor_nombre: 'DULCES PRUEBA SA DE CV', facturas: ['f1'], ...o,
});
const partida = (o: Partial<PartidaDelPrograma> & { id: string }): PartidaDelPrograma => ({
  estado: 'pending', dia: '2030-03-10', alta: '2030-03-08', baja: null, monto: 1000, facturas: ['f1'], ...o,
});
const fac = (o: Partial<FacturaViva> & { id: string }): FacturaViva => ({
  acreedor: 'CP001', sucursal: '00', doc_tipo: 20, doc_sub: 1, folio: o.id, fecha: '2030-02-01', pendiente: 1000, ...o,
});
/** Días con movimientos: todo marzo en A1 y B2 (salvo que la prueba diga otra cosa). */
const diasMarzo = (): Set<string> => {
  const s = new Set<string>();
  for (let d = 1; d <= 31; d++) for (const l of ['A1', 'B2']) s.add(`${l}|2030-03-${String(d).padStart(2, '0')}`);
  return s;
};
const entrada = (o: Partial<EntradaGuia> = {}): EntradaGuia => ({
  hoy: '2030-03-25', desde: '2030-03-01', hasta: '2030-03-24', salidas: [], abonos: [], pagos: [], partidas: [],
  cubreHasta: new Map([['A1', '2030-03-24'], ['B2', '2030-03-24']]), diasConMovimientos: diasMarzo(), ...o,
});
const sinFuentes: FuentesDeAtribucion = { diccionario: new Map(), catalogo: [], facturasPorAcreedor: new Map() };

describe('[PGP.97] qué salida es pago a proveedor', () => {
  it('la columna M, el código 510/501 o la categoría', () => {
    expect(esSalidaAProveedor({ raw_type: 'C', raw_code: null, categoria: null })).toBe(true);
    expect(esSalidaAProveedor({ raw_type: 'G', raw_code: '510', categoria: null })).toBe(true);
    expect(esSalidaAProveedor({ raw_type: null, raw_code: null, categoria: 'compra_mercancia' })).toBe(true);
    expect(esSalidaAProveedor({ raw_type: 'N', raw_code: '102', categoria: 'nomina' })).toBe(false);
  });
});

describe('[PGP.97] el par salida ↔ pago de Kepler', () => {
  it('misma cuenta, mismo día, centavos de diferencia: casa', () => {
    const p = parear([sal({ id: 's1', importe: 1000.21 })], [pago({ id: 'p1' })]);
    expect(p.get('s1')).toMatchObject({ pago_ids: ['p1'], modo: 'misma_cuenta', dif_importe: -0.21, dif_dias: 0 });
  });
  it('⛔ PLACEBO: con el banco corrido 35 días no casa nada (prueba negativa de la ventana)', () => {
    const salidas = [sal({ id: 's1', fecha: '2030-02-03' }), sal({ id: 's2', fecha: '2030-02-04', importe: 2000 })];
    const pagos = [pago({ id: 'p1' }), pago({ id: 'p2', fecha: '2030-03-11', importe: 2000 })];
    expect(parear(salidas, pagos).size).toBe(0);
  });
  it('⛔ más de $1 de diferencia no casa', () => {
    expect(parear([sal({ id: 's1', importe: 1001.5 })], [pago({ id: 'p1' })]).size).toBe(0);
  });
  it('uno a uno: dos salidas iguales no se llevan el mismo pago', () => {
    const p = parear([sal({ id: 's1' }), sal({ id: 's2', fecha: '2030-03-11' })], [pago({ id: 'p1' })]);
    expect(p.size).toBe(1);
    expect(p.get('s1')?.pago_ids).toEqual(['p1']);
  });
  it('la salida a proveedor elige antes que un gasto del mismo importe', () => {
    const gasto = sal({ id: 'g1', raw_type: 'G', raw_code: '102', categoria: 'servicios' });
    const prov = sal({ id: 's1', fecha: '2030-03-11' });
    expect(parear([gasto, prov], [pago({ id: 'p1' })]).get('s1')?.pago_ids).toEqual(['p1']);
  });
  it('capturado con OTRA cuenta de tesorería: casa como otra_cuenta', () => {
    const p = parear([sal({ id: 's1' })], [pago({ id: 'p1', account_label: 'B2' })]);
    expect(p.get('s1')).toMatchObject({ pago_ids: ['p1'], modo: 'otra_cuenta' });
  });
  it('UNA transferencia que Kepler capturó en un documento por sucursal: casa con todos', () => {
    const docs = ['01', '02', '03', '04'].map((suc, i) => pago({ id: `p${suc}`, sucursal: suc, importe: [400.01, 300, 200, 100][i], facturas: [`f${suc}`] }));
    const p = parear([sal({ id: 's1' })], docs);
    expect(p.get('s1')).toMatchObject({ modo: 'varios_documentos', dif_importe: 0.01 });
    expect([...p.get('s1')!.pago_ids].sort()).toEqual(['p01', 'p02', 'p03', 'p04']);
  });
  it('⛔ varios documentos de DISTINTOS acreedores no se juntan', () => {
    const p = parear([sal({ id: 's1' })], [pago({ id: 'pa', importe: 600, acreedor: 'CP001' }), pago({ id: 'pb', importe: 400, acreedor: 'CP002' })]);
    expect(p.size).toBe(0);
  });
  it('envío devuelto (abono DS al día siguiente): sale del universo y el pago casa con el reenvío', () => {
    const salidas = [sal({ id: 'envio', fecha: '2030-03-10' }), sal({ id: 'reenvio', fecha: '2030-03-12' })];
    const abonos: AbonoBancario[] = [{ id: 'ds', cuenta_id: 'cta-a', fecha: '2030-03-11', importe: 1000, raw_type: 'DS' }];
    const dev = salidasDevueltas(salidas, abonos);
    expect([...dev]).toEqual(['envio']);
    const pagos = [pago({ id: 'p1', fecha: '2030-03-12' })];
    expect(parear(salidas, pagos, dev).get('reenvio')?.pago_ids).toEqual(['p1']);
    // Control: sin neutralizar, el envío devuelto se lo quedaría (mismo importe, va primero).
    expect(parear(salidas, [pago({ id: 'p1', fecha: '2030-03-11' })]).get('envio')?.pago_ids).toEqual(['p1']);
  });
});

describe('[PGP.97] ¿pasó por el programa?', () => {
  const p = pago({ id: 'p1', fecha: '2030-03-10', facturas: ['f1'] });
  it('factura en una partida vigente del día ±3, dada de alta antes: en_programa', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', dia: '2030-03-12' })]).estado).toBe('en_programa');
  });
  it('⭐ cancelada DESPUÉS de pagar (la limpieza de lo saldado) sigue contando: en_programa', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', estado: 'cancelled', baja: '2030-03-11' })]).estado).toBe('en_programa');
  });
  it('⭐ reprogramada después de pagar (la original cancelada al día siguiente): en_programa', () => {
    const original = partida({ id: 'a1', estado: 'cancelled', baja: '2030-03-11' });
    const nueva = partida({ id: 'a2', estado: 'cancelled', dia: '2030-03-14', alta: '2030-03-11', baja: '2030-03-11' });
    expect(estadoPrograma(p, [original, nueva])).toMatchObject({ estado: 'en_programa', partida_id: 'a1' });
  });
  it('cancelada ANTES (o el mismo día) de pagar, y dada de alta antes: quitada_del_programa', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', estado: 'cancelled', baja: '2030-03-09' })]).estado).toBe('quitada_del_programa');
    expect(estadoPrograma(p, [partida({ id: 'a1', estado: 'cancelled', baja: '2030-03-10' })]).estado).toBe('quitada_del_programa');
  });
  it('⛔ dada de alta y cancelada DESPUÉS de pagar: no es «se quitó del programa»', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', estado: 'cancelled', alta: '2030-03-12', baja: '2030-03-09' })]).estado).toBe('no_programada');
  });
  it('dada de alta DESPUÉS de pagar, del día: regularizada (no cuenta)', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', alta: '2030-03-11' })]).estado).toBe('regularizada');
  });
  it('vigente y dada de alta antes, pero a más de 3 días: programada_otro_dia; dada de alta después: no_programada', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', dia: '2030-03-20' })]).estado).toBe('programada_otro_dia');
    expect(estadoPrograma(p, [partida({ id: 'a1', dia: '2030-03-20', alta: '2030-03-15' })]).estado).toBe('no_programada');
  });
  it('anticipo sin facturas: sin_factura; factura nunca programada: no_programada', () => {
    expect(estadoPrograma({ fecha: '2030-03-10', facturas: [] }, []).estado).toBe('sin_factura');
    expect(estadoPrograma(p, [partida({ id: 'a1', facturas: ['otra'] })]).estado).toBe('no_programada');
  });
  it('⛔ placebo: el Calendario corrido 7 días ya no cuenta como en_programa', () => {
    expect(estadoPrograma(p, [partida({ id: 'a1', dia: '2030-03-17', alta: '2030-03-01' })]).estado).not.toBe('en_programa');
  });
  it('sin pago en Kepler: una partida del MISMO acreedor por el mismo importe ±7 días es indicio', () => {
    const delAcreedor = new Set(['f1']);
    expect(programaPorImporte({ fecha: '2030-03-10', importe: 1000.4 }, [partida({ id: 'a1', dia: '2030-03-15' })], delAcreedor).estado).toBe('probable_en_programa');
    expect(programaPorImporte({ fecha: '2030-03-10', importe: 1000 }, [partida({ id: 'a1', dia: '2030-03-25' })], delAcreedor).estado).toBe('sin_partida_por_importe');
  });
  it('⛔ sin pago en Kepler nunca se afirma «no estaba en el programa»', () => {
    const r = programaPorImporte({ fecha: '2030-03-10', importe: 1000 }, [], new Set(['f1']));
    expect(r.estado).toBe('sin_partida_por_importe');
    expect(r.estado).not.toBe('no_programada');
  });
  it('⛔ una partida de OTRO acreedor, sin acreedor, o ya usada por otro pago no cuenta', () => {
    const a = partida({ id: 'a1', facturas: ['de-otro'] });
    expect(programaPorImporte({ fecha: '2030-03-10', importe: 1000 }, [a], new Set(['f1'])).estado).toBe('sin_partida_por_importe');
    expect(programaPorImporte({ fecha: '2030-03-10', importe: 1000 }, [partida({ id: 'a2' })], null).estado).toBe('sin_partida_por_importe');
    expect(programaPorImporte({ fecha: '2030-03-10', importe: 1000 }, [partida({ id: 'a2' })], new Set(['f1']), new Set(['a2'])).estado).toBe('sin_partida_por_importe');
  });
  it('sin pago en Kepler, partida del acreedor cancelada antes de la salida: quitada_del_programa', () => {
    const a = partida({ id: 'a1', estado: 'cancelled', baja: '2030-03-09' });
    expect(programaPorImporte({ fecha: '2030-03-10', importe: 1000 }, [a], new Set(['f1'])).estado).toBe('quitada_del_programa');
  });
});

describe('[PGP.97] a quién se le pagó', () => {
  const fuentes = (o: Partial<FuentesDeAtribucion> = {}): FuentesDeAtribucion => ({
    diccionario: new Map([['DULCES PRUEBA', new Map([['CP001', 4]])]]),
    catalogo: [{ acreedor: 'CP001', nombre: 'DULCES PRUEBA SA DE CV' }, { acreedor: 'CP002', nombre: 'GALLETAS OTRAS SA' }],
    facturasPorAcreedor: new Map([['CP001', [fac({ id: 'x1', pendiente: 600 }), fac({ id: 'x2', pendiente: 400 })]], ['CP002', [fac({ id: 'y1', acreedor: 'CP002', pendiente: 77 })]]]),
    ...o,
  });
  it('nombre + importe (dos facturas que suman): fuerte, con las facturas', () => {
    const s = sugerirAcreedor({ concepto: 'Dulces Prueba', importe: 1000 }, fuentes());
    expect(s).toMatchObject({ acreedor: 'CP001', nivel: 'fuerte' });
    expect(s.facturas.map((f) => f.id).sort()).toEqual(['x1', 'x2']);
  });
  it('sólo el nombre: débil', () => {
    expect(sugerirAcreedor({ concepto: 'Dulces Prueba', importe: 5 }, fuentes())).toMatchObject({ acreedor: 'CP001', nivel: 'debil', porque: 'sólo el nombre' });
  });
  it('sólo el importe de UNA factura: débil', () => {
    expect(sugerirAcreedor({ concepto: 'zzz', importe: 77 }, fuentes())).toMatchObject({ acreedor: 'CP002', nivel: 'debil' });
  });
  it('los candidatos llevan su nombre, no sólo el código', () => {
    const f = fuentes({ diccionario: new Map(), catalogo: [{ acreedor: 'CP001', nombre: 'DULCES PRUEBA UNO' }, { acreedor: 'CP003', nombre: 'DULCES PRUEBA TRES' }] });
    const s = sugerirAcreedor({ concepto: 'Dulces Prueba', importe: 5 }, f);
    expect(s.candidatos).toEqual([{ acreedor: 'CP001', nombre: 'DULCES PRUEBA UNO' }, { acreedor: 'CP003', nombre: 'DULCES PRUEBA TRES' }]);
  });
  it('⛔ PLACEBO: concepto de otro y importe +$0.37 no da fuerte', () => {
    const s = sugerirAcreedor({ concepto: 'Galletas Otras', importe: 1000.37 }, fuentes());
    expect(s.nivel).not.toBe('fuerte');
  });
  it('sin señal: ninguno', () => {
    expect(sugerirAcreedor({ concepto: 'Retiro', importe: 3 }, fuentes()).nivel).toBe('ninguno');
  });
  it('la suma de 3 y 4 facturas se encuentra; si no suman, null', () => {
    const fs = [fac({ id: 'a', pendiente: 100 }), fac({ id: 'b', pendiente: 200 }), fac({ id: 'c', pendiente: 300 }), fac({ id: 'd', pendiente: 450 })];
    expect(facturasQueSuman(fs, 600)?.map((f) => f.id).sort()).toEqual(['a', 'b', 'c']);
    expect(facturasQueSuman(fs, 1050)?.length).toBe(4);
    expect(facturasQueSuman(fs, 999)).toBeNull();
  });
  it('⛔ la factura más nueva de una lista larga también se encuentra (el tope no recorta la búsqueda de una)', () => {
    const muchas = Array.from({ length: 450 }, (_, i) => fac({ id: `v${i}`, pendiente: 10 + i }));
    expect(facturasQueSuman(muchas, 10 + 449)?.map((f) => f.id)).toEqual(['v449']);
  });
});

describe('[PGP.97] la guía completa', () => {
  it('cuadrantes: en programa en Kepler, fuera en Kepler, fuera y falta', () => {
    const g = armarGuia(entrada({
      salidas: [sal({ id: 's1' }), sal({ id: 's2', importe: 2000 }), sal({ id: 's3', importe: 3000, fecha: '2030-03-05' })],
      pagos: [pago({ id: 'p1' }), pago({ id: 'p2', importe: 2000, facturas: ['f2'] })],
      partidas: [partida({ id: 'a1' })],
    }), sinFuentes);
    const por = Object.fromEntries(g.filas.map((f) => [f.salida.id, f]));
    expect(por.s1).toMatchObject({ estado_kepler: 'registrado', cuadrante: 'en_programa_en_kepler' });
    expect(por.s2).toMatchObject({ estado_kepler: 'registrado', cuadrante: 'fuera_en_kepler' });
    expect(por.s2.programa.estado).toBe('no_programada');
    expect(por.s3).toMatchObject({ estado_kepler: 'falta', cuadrante: 'fuera_falta', documentos: [] });
  });
  it(`dentro de la espera de captura (${ESPERA_CAPTURA_DIAS} días) dice en_espera, no falta`, () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1', fecha: '2030-03-20' })] }), sinFuentes);
    expect(g.filas[0].estado_kepler).toBe('en_espera');
  });
  it('varios documentos: la fila los lista todos y ninguno queda como «sin salida»', () => {
    const docs = [pago({ id: 'pa', sucursal: '01', importe: 600, facturas: ['f1'] }), pago({ id: 'pb', sucursal: '02', importe: 400, facturas: ['f9'] })];
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1' })], pagos: docs, partidas: [partida({ id: 'a1' })] }), sinFuentes);
    expect(g.filas[0]).toMatchObject({ estado_kepler: 'registrado', cuadrante: 'en_programa_en_kepler', dif_importe: 0 });
    expect(g.filas[0].documentos.map((d) => d.id).sort()).toEqual(['pa', 'pb']);
    expect(g.kepler_sin_salida).toEqual([]);
  });
  it('quitada del programa antes de pagar y pagada igual: fuera, con su motivo', () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1' })], pagos: [pago({ id: 'p1' })], partidas: [partida({ id: 'a1', estado: 'cancelled', baja: '2030-03-09' })] }), sinFuentes);
    expect(g.filas[0]).toMatchObject({ cuadrante: 'fuera_en_kepler', programa: { estado: 'quitada_del_programa' } });
  });
  it('capturado con otra cuenta: en Kepler, pero «corregir la cuenta»', () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1' })], pagos: [pago({ id: 'p1', account_label: 'B2' })] }), sinFuentes);
    expect(g.filas[0]).toMatchObject({ estado_kepler: 'otra_cuenta', corregir: 'cuenta' });
    expect(g.kepler_sin_salida).toEqual([]);
  });
  const fuDulces: FuentesDeAtribucion = { ...sinFuentes, diccionario: new Map([['DULCES PRUEBA', new Map([['CP001', 3]])]]), catalogo: [{ acreedor: 'CP001', nombre: 'DULCES PRUEBA' }] };
  it('importe tecleado POCO distinto: el pago del acreedor sugerido ese día se señala para corregir', () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1', importe: 1015 })], pagos: [pago({ id: 'p1', importe: 1000 })] }), fuDulces);
    expect(g.filas[0]).toMatchObject({ estado_kepler: 'importe_distinto', corregir: 'importe', dif_importe: -15 });
    expect(g.kepler_sin_salida).toEqual([]);
  });
  it('⛔ importe MUY distinto: no se propone corregir; sigue faltando, con el aviso de que no cuadra', () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1', importe: 1300, fecha: '2030-03-10' })], pagos: [pago({ id: 'p1', importe: 1000 })] }), fuDulces);
    expect(g.filas[0]).toMatchObject({ estado_kepler: 'falta', corregir: null, no_cuadra: { id: 'p1' } });
  });
  it('el pago en Kepler es de un acreedor de gasto: sale de la guía y se cuenta aparte', () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1' })], pagos: [pago({ id: 'p1', acreedor: 'GA999' })] }), sinFuentes);
    expect(g.filas).toEqual([]);
    expect(g.fuera_del_universo.gasto).toEqual({ pagos: 1, monto: 1000 });
  });
  it('sin pago, pero el concepto ya le pagaba a un acreedor de gasto: tampoco es de esta guía', () => {
    const fu: FuentesDeAtribucion = { ...sinFuentes, diccionario: new Map([['TARJETA PRUEBA', new Map([['GA099', 5]])]]) };
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1', concepto: 'Tarjeta Prueba', fecha: '2030-03-05' })] }), fu);
    expect(g.filas).toEqual([]);
    expect(g.fuera_del_universo.gasto.pagos).toBe(1);
  });
  it('mal clasificada (sin la marca de proveedor) pero su pago es de compra: entra y se marca', () => {
    const g = armarGuia(entrada({ salidas: [sal({ id: 's1', raw_type: 'G', raw_code: '102', categoria: 'cobranza' })], pagos: [pago({ id: 'p1' })] }), sinFuentes);
    expect(g.filas[0]).toMatchObject({ mal_clasificada: true, estado_kepler: 'registrado' });
  });
  it('el envío devuelto no es pago y no aparece en la guía', () => {
    const g = armarGuia(entrada({
      salidas: [sal({ id: 'envio', fecha: '2030-03-10' }), sal({ id: 'reenvio', fecha: '2030-03-12' })],
      abonos: [{ id: 'ds', cuenta_id: 'cta-a', fecha: '2030-03-11', importe: 1000, raw_type: 'DS' }],
      pagos: [pago({ id: 'p1', fecha: '2030-03-12' })],
    }), sinFuentes);
    expect(g.filas.map((f) => f.salida.id)).toEqual(['reenvio']);
    expect(g.fuera_del_universo.devueltas).toEqual({ pagos: 1, monto: 1000 });
  });
  it('pago de compra sin salida: se lista si el workbook cubre su día +3; si no, se declara sin cobertura', () => {
    const g = armarGuia(entrada({
      cubreHasta: new Map([['A1', '2030-03-15']]),
      pagos: [pago({ id: 'p1', fecha: '2030-03-12' }), pago({ id: 'p2', fecha: '2030-03-13', importe: 50 }), pago({ id: 'p3', fecha: '2030-03-20', importe: 70 })],
    }), sinFuentes);
    expect(g.kepler_sin_salida.map((p) => p.id)).toEqual(['p1']);
    expect(g.kepler_sin_cobertura).toEqual({ pagos: 2, monto: 120 });
  });
  it('⛔ un pago en un día SIN movimientos de su cuenta no se declara «sin salida»', () => {
    const dias = diasMarzo(); dias.delete('A1|2030-03-12');
    const g = armarGuia(entrada({ diasConMovimientos: dias, pagos: [pago({ id: 'p1', fecha: '2030-03-12' })] }), sinFuentes);
    expect(g.kepler_sin_salida).toEqual([]);
    expect(g.sin_cobertura_por_dia).toEqual([{ account_label: 'A1', fecha: '2030-03-12', pagos: 1, monto: 1000 }]);
  });
  it('la cuenta puente sin contraste se dice con el NOMBRE de la cuenta, y lo que sí casó no entra', () => {
    const g = armarGuia(entrada({
      salidas: [sal({ id: 's1', importe: 461 })],
      pagos: [pago({ id: 'dev', tipo_cuenta: 'puente', account_label: null, banco_nombre: 'DEVOLUCIONES', importe: 461 }),
        pago({ id: 'fac', tipo_cuenta: 'puente', account_label: null, banco_nombre: 'FACTORAJE', importe: 37 })],
    }), sinFuentes);
    expect(g.filas[0]).toMatchObject({ estado_kepler: 'otra_cuenta', documentos: [{ banco_nombre: 'DEVOLUCIONES' }] });
    expect(g.otra_sin_contraste).toEqual({ pagos: 1, monto: 37, por_cuenta: [{ cuenta: 'FACTORAJE', pagos: 1, monto: 37 }] });
  });
  it('la métrica de la meta se mide por universo y por dinero, sólo acreedores de compra y hasta hoy', () => {
    const g = armarGuia(entrada({
      pagos: [
        pago({ id: 'p1' }), pago({ id: 'p2', importe: 3000, facturas: ['f9'] }),
        pago({ id: 'p3', tipo_cuenta: 'caja', importe: 500, facturas: [] }),
        pago({ id: 'p4', acreedor: 'GA001', importe: 9999 }),
        pago({ id: 'p5', fecha: '2030-03-30', importe: 7777 }),
      ],
      partidas: [partida({ id: 'a1' })],
    }), sinFuentes);
    expect(g.metrica.banco).toMatchObject({ pagos: 2, monto: 4000, pagos_en_programa: 1, monto_en_programa: 1000 });
    expect(g.metrica.caja).toMatchObject({ pagos: 1, monto: 500, pagos_sin_factura: 1, monto_sin_factura: 500 });
    // p2 (fuera del programa, sin salida) es la diferencia entre la lista y la meta.
    expect(g.kepler_fuera_sin_fila.sin_salida).toEqual({ pagos: 1, monto: 3000 });
  });
  it('sólo pide atribución para las salidas a proveedor sin pago, dentro de la ventana', () => {
    const e = entrada({
      salidas: [sal({ id: 's1' }), sal({ id: 's2', importe: 2000 }), sal({ id: 's3', fecha: '2030-02-20', importe: 5 })],
      pagos: [pago({ id: 'p1' })],
    });
    expect(salidasSinPago(e).map((s) => s.id)).toEqual(['s2']);
  });
});
