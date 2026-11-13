import { armarPasos, cambiosContraCotizacion, claveCapturada, hallazgosAbiertos, horaMx, identidadDelPedido, llavesHallazgo, type PedidoCrudo, type EmbarqueCrudo, type FacturaCruda } from './quote-tracking.reglas';

/**
 * `[GP.9.1]` Anclado a la cadena real de Canindo (06, medida en prod 2026-11-12): pedido
 * `UD4001-0001608` → embarque `UD4101-0001823` (responsables c80/c81/c82 = 07/01/01) → factura
 * `UD0801-0001350` CANCELADA, sin refactura todavía.
 */
const pedido = (o: Partial<PedidoCrudo> = {}): PedidoCrudo => ({
  serie: 1, folio: '0001608', fecha: '2026-10-26', hora: '11:05', estatus: 'EMBARCADO',
  resp_surtido: null, resp_checado: null, resp_embarque: null, cliente: 'C3025', trae_cotizacion: false, ...o,
});
const emb1823: EmbarqueCrudo = { serie: 1, folio: '0001823', fecha: '2026-11-10', resp_surtido: '07', resp_checado: '01', resp_embarque: '01', importe: 37535.1 };
const fac1350: FacturaCruda = { serie: 1, folio: '0001350', fecha: '2026-11-10', hora: '', cancelada: true, importe: 0 };

const porClave = (ps: ReturnType<typeof armarPasos>) => Object.fromEntries(ps.map((p) => [p.clave, p]));

describe('armarPasos', () => {
  it('Canindo: embarcado y con la única factura cancelada → «Facturado» NO está hecho, y la cancelada se ve', () => {
    const p = porClave(armarPasos(pedido(), [emb1823], [fac1350], null));
    expect(p['embarcado'].hecho).toBe(true);
    expect(p['embarcado'].documentos.map((d) => d.documento)).toEqual(['UD4101-0001823']);
    expect(p['facturado'].hecho).toBe(false);
    expect(p['facturado'].documentos).toEqual([{ documento: 'UD0801-0001350', fecha: '2026-11-10', cancelado: true, importe: 0 }]);
  });

  it('el pedido sin clave de surtidor toma la del embarque, dicha como clave de Kepler', () => {
    const p = porClave(armarPasos(pedido(), [emb1823], [fac1350], null));
    expect(p['surtido'].quien).toBe('clave 07 en Kepler');
    expect(p['checado'].quien).toBe('clave 01 en Kepler');
    expect(p['embarcado'].quien).toBe('clave 01 en Kepler');
  });

  it('Kepler no guarda la hora de surtido ni de checado: sin el piso en la Suite, cuándo = null (no se inventa)', () => {
    const p = porClave(armarPasos(pedido(), [emb1823], [], null));
    expect(p['surtido'].cuando).toBeNull();
    expect(p['checado'].cuando).toBeNull();
    expect(p['pedido'].cuando).toBe('2026-10-26 11:05');
    expect(p['embarcado'].cuando).toBe('2026-11-10');
  });

  it('paso hecho sin nadie registrado → sin_responsable (la pantalla dice «Kepler no registró quién»)', () => {
    const sinNadie = { ...emb1823, resp_surtido: '00', resp_checado: '', resp_embarque: '00000' };
    const p = porClave(armarPasos(pedido(), [sinNadie], [], null));
    expect(p['surtido'].hecho).toBe(true);
    expect(p['surtido'].quien).toBeNull();
    expect(p['surtido'].sin_responsable).toBe(true);
    expect(p['embarcado'].sin_responsable).toBe(true);
  });

  it('pedido recién creado: sólo el primer paso hecho, y los pendientes no cargan quién ni cuándo', () => {
    const ps = armarPasos(pedido({ estatus: 'CREADO', resp_surtido: '30002' }), [], [], null);
    expect(ps.filter((x) => x.hecho).map((x) => x.clave)).toEqual(['pedido']);
    const s = porClave(ps)['surtido'];
    expect(s.quien).toBeNull();
    expect(s.cuando).toBeNull();
    expect(s.sin_responsable).toBe(false);
  });

  it('el estatus avanza en orden: SURTIDO deja autorizado y surtido hechos, checado no', () => {
    const p = porClave(armarPasos(pedido({ estatus: 'SURTIDO' }), [], [], null));
    expect([p['autorizado'].hecho, p['surtido'].hecho, p['checado'].hecho, p['embarcado'].hecho]).toEqual([true, true, false, false]);
  });

  it('un embarque prueba surtido y checado aunque el estatus del pedido se haya quedado atrás', () => {
    const p = porClave(armarPasos(pedido({ estatus: 'AUTORIZADO' }), [emb1823], [], null));
    expect([p['surtido'].hecho, p['checado'].hecho, p['embarcado'].hecho]).toEqual([true, true, true]);
  });

  it('lo marcado en la Suite gana: nombre y hora del piso, aunque Kepler siga en AUTORIZADO', () => {
    const p = porClave(armarPasos(pedido({ estatus: 'AUTORIZADO', resp_surtido: '30002' }), [], [],
      { surtio: 'Juan Surtidor', surtido_at: '2026-11-12T16:30:00.000Z', checo: null, checado_at: null }));
    expect(p['surtido'].hecho).toBe(true);
    expect(p['surtido'].quien).toBe('Juan Surtidor');
    expect(p['surtido'].cuando).toBe('2026-11-12 10:30');
    expect(p['checado'].hecho).toBe(false);
  });

  it('refactura: con una viva, «Facturado» está hecho con la fecha de la viva', () => {
    const viva: FacturaCruda = { serie: 1, folio: '0001400', fecha: '2026-11-13', hora: '09:12', cancelada: false, importe: 30000 };
    const p = porClave(armarPasos(pedido(), [emb1823], [viva, fac1350], null));
    expect(p['facturado'].hecho).toBe(true);
    expect(p['facturado'].cuando).toBe('2026-11-13 09:12');
    expect(p['facturado'].documentos).toHaveLength(2);
  });

  it('ESTATUS desconocido no adelanta pasos', () => {
    const p = porClave(armarPasos(pedido({ estatus: 'RARO' }), [], [], null));
    expect(p['autorizado'].hecho).toBe(false);
  });
});

describe('cambiosContraCotizacion (GP.9.3) — COT-2026-00173: 14 renglones cotizados, el pedido 08UD4001-0001187 quedó con 9', () => {
  const cot = (sku: string, cantidad: number, o: Partial<{ presentacion: string | null; factor: number | null; importe: number | null; nombre: string | null }> = {}) =>
    ({ sku, nombre: `P${sku}`, cantidad, presentacion: 'CJA', factor: 24, importe: 100, ...o });
  const ped = (sku: string, base: number) => ({ sku, nombre: `K${sku}`, base, unidad_base: 'PAQ' });

  it('renglón cotizado que ya no está en el pedido → quitado, en la presentación cotizada y con su importe', () => {
    const r = cambiosContraCotizacion([cot('47005', 2, { importe: 812.5 }), cot('20092', 1)], [ped('20092', 24)]);
    expect(r).toEqual([{ sku: '47005', nombre: 'P47005', tipo: 'quitado', cotizado: 2, pedido: 0, unidad: 'CJA', importe_cotizado: 812.5 }]);
  });

  it('cantidad bajada se dice en la presentación cotizada (2 CJA → 1 CJA), no en piezas', () => {
    expect(cambiosContraCotizacion([cot('83306', 2)], [ped('83306', 24)])).toEqual([
      { sku: '83306', nombre: 'P83306', tipo: 'menos', cotizado: 2, pedido: 1, unidad: 'CJA', importe_cotizado: 100 },
    ]);
  });

  it('igual en base aunque el pedido lo parta en dos renglones → sin cambio (prueba negativa)', () => {
    expect(cambiosContraCotizacion([cot('99624', 2)], [ped('99624', 30), ped('99624', 18)])).toEqual([]);
  });

  it('el pedido trae un producto que no se cotizó → agregado, en su unidad base', () => {
    expect(cambiosContraCotizacion([], [ped('11111', 6)])).toEqual([
      { sku: '11111', nombre: 'K11111', tipo: 'agregado', cotizado: null, pedido: 6, unidad: 'PAQ', importe_cotizado: null },
    ]);
  });

  it('orden: quitados primero, luego bajados, subidos y agregados', () => {
    const r = cambiosContraCotizacion([cot('3', 1), cot('2', 2), cot('1', 1)], [ped('2', 24), ped('3', 48), ped('9', 1)]);
    expect(r.map((x) => `${x.tipo}:${x.sku}`)).toEqual(['quitado:1', 'menos:2', 'mas:3', 'agregado:9']);
  });

  it('sin factor (se cotizó en la base) compara uno a uno', () => {
    expect(cambiosContraCotizacion([cot('5', 10, { presentacion: null, factor: null })], [ped('5', 7)])[0])
      .toMatchObject({ tipo: 'menos', cotizado: 10, pedido: 7, unidad: null });
  });
});

describe('identidadDelPedido (medido: 2 de 109 sin el código y de otro cliente)', () => {
  it('con el código de la cotización en comentarios → confirmada, aunque el cliente haya cambiado', () => {
    expect(identidadDelPedido({ cliente: 'C1123', trae_cotizacion: true }, '10001')).toBe('confirmada');
  });
  it('sin el código pero del mismo cliente → por_folio', () => {
    expect(identidadDelPedido({ cliente: 'C2094', trae_cotizacion: false }, ' C2094 ')).toBe('por_folio');
  });
  it('sin el código y de otro cliente → dudosa (COT-2026-00174: cotizó C2094, el pedido es de C2032)', () => {
    expect(identidadDelPedido({ cliente: 'C2032', trae_cotizacion: false }, 'C2094')).toBe('dudosa');
  });
  it('sin cliente en la cotización y sin código → dudosa, no por_folio', () => {
    expect(identidadDelPedido({ cliente: 'C2032', trae_cotizacion: false }, null)).toBe('dudosa');
  });
});

describe('auxiliares', () => {
  it('claveCapturada: ceros y vacío son «sin capturar»', () => {
    expect([claveCapturada('0'), claveCapturada('00000'), claveCapturada(' '), claveCapturada(null), claveCapturada('30002')])
      .toEqual([null, null, null, null, '30002']);
  });

  it('horaMx convierte a la hora de la Ciudad de México', () => {
    expect(horaMx('2026-11-12T20:15:00.000Z')).toBe('2026-11-12 14:15');
    expect(horaMx(null)).toBeNull();
    expect(horaMx('basura')).toBeNull();
  });

  it('las llaves son las mismas que escribe TlmkRevisionService (AX.22.2)', () => {
    expect(llavesHallazgo('06', pedido(), [emb1823])).toEqual([
      'tlmk_caja|06|40|1|0001608', 'tlmk_caja|06|41|1|0001823', 'tlmk_fac_emb|06|1|0001823',
    ]);
  });

  it('hallazgosAbiertos esconde los resueltos y descartados, no los abiertos', () => {
    const r = hallazgosAbiertos([
      { titulo: 'a', resumen: 'x', importe: 1, severity: 'high', status: 'open' },
      { titulo: 'b', resumen: 'x', importe: 1, severity: 'high', status: 'resuelto' },
      { titulo: 'c', resumen: 'x', importe: null, severity: null, status: null },
    ]);
    expect(r.map((h) => h.titulo)).toEqual(['a', 'c']);
  });
});
