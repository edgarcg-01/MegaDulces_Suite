import {
  MOTIVOS_CANCELAR,
  MOTIVOS_CORREGIR,
  MOTIVOS_SURTIDO,
  NOTA_MOTIVO_MAX,
  SIN_MOTIVO_REGISTRADO,
  motivoDeHistoria,
  textoDeJustificante,
  type PresalePickReport,
  type PresaleReviewResultLine,
} from '@megadulces/contracts';
import {
  MotivoInvalido,
  armarJustificantes,
  bloqueoParaCorregir,
  conMotivosEnReporte,
  conMotivosEnRevision,
  exigirMotivosDeRenglones,
  motivoDelCuerpo,
  motivosPorRenglon,
} from './justificantes.engine';

const surtido = (x: Partial<Parameters<typeof bloqueoParaCorregir>[0][number]> = {}) => ({
  started_at: null, started_by_name: null, finished_at: null, finished_by_name: null, reviewed_at: null, reviewed_by_name: null, ...x,
});

describe('[MCP.18] motivoDelCuerpo — lo que se guarda en la historia', () => {
  it('clave del catálogo → su etiqueta; con nota → «Etiqueta: nota»', () => {
    expect(motivoDelCuerpo({ reason_code: 'agregar' }, MOTIVOS_CORREGIR)).toBe('El cliente quiere agregar productos');
    expect(motivoDelCuerpo({ reason_code: 'agregar', note: '  2 cajas de chicle ' }, MOTIVOS_CORREGIR))
      .toBe('El cliente quiere agregar productos: 2 cajas de chicle');
  });
  it('negativa: una clave ajena al catálogo es un error, no se guarda tal cual', () => {
    expect(() => motivoDelCuerpo({ reason_code: 'ya_no_quiere' }, MOTIVOS_CORREGIR)).toThrow(MotivoInvalido);
    expect(() => motivoDelCuerpo({ reason_code: 'agregar' }, MOTIVOS_CANCELAR)).toThrow(/no está en la lista/);
  });
  it('negativa: «Otro motivo» sin nota, y una nota de más de 200, no pasan', () => {
    expect(() => motivoDelCuerpo({ reason_code: 'otro', note: '   ' }, MOTIVOS_CORREGIR)).toThrow(/escribe cuál/);
    expect(() => motivoDelCuerpo({ reason_code: 'quitar', note: 'x'.repeat(NOTA_MOTIVO_MAX + 1) }, MOTIVOS_CORREGIR)).toThrow(/200/);
    expect(motivoDelCuerpo({ reason_code: 'otro', note: 'el cliente cambió de sucursal' }, MOTIVOS_CORREGIR)).toBe('Otro motivo: el cliente cambió de sucursal');
  });
  it('el texto de las pantallas de antes se conserva (recortado); sin nada → null', () => {
    expect(motivoDelCuerpo({ reason: '  Cancelado por el vendedor ' }, MOTIVOS_CANCELAR)).toBe('Cancelado por el vendedor');
    expect(motivoDelCuerpo({}, MOTIVOS_CORREGIR)).toBeNull();
    expect(motivoDelCuerpo(undefined, MOTIVOS_CORREGIR)).toBeNull();
  });
  it('D4 obligatorio: sin motivo es error; con motivo, pasa', () => {
    expect(() => motivoDelCuerpo({}, MOTIVOS_CORREGIR, true)).toThrow(/Elige el motivo/);
    expect(motivoDelCuerpo({ reason_code: 'fecha' }, MOTIVOS_CORREGIR, true)).toBe('Cambiar la fecha de entrega');
  });
  it('D4 obligatorio: el texto fijo de antes no cuenta, un texto real sí, y el error dice cómo salir', () => {
    expect(() => motivoDelCuerpo({ reason: 'Cancelado por el vendedor' }, MOTIVOS_CANCELAR, true)).toThrow(/recárgala|vuelve a abrirla/);
    expect(() => motivoDelCuerpo({ reason: 'reabierto para corregir' }, MOTIVOS_CORREGIR, true)).toThrow(MotivoInvalido);
    expect(motivoDelCuerpo({ reason: 'el cliente cerró el local' }, MOTIVOS_CANCELAR, true)).toBe('el cliente cerró el local');
  });
  it('D2: los motivos nuevos están en su lista y no en otra', () => {
    expect(motivoDelCuerpo({ reason_code: 'cliente_equivocado' }, MOTIVOS_CANCELAR)).toBe('Me equivoqué de cliente');
    expect(() => motivoDelCuerpo({ reason_code: 'cliente_equivocado' }, MOTIVOS_CORREGIR)).toThrow(/no está en la lista/);
  });
});

describe('[MCP.18] bloqueoParaCorregir — D1', () => {
  const hora = '2026-11-10T16:42:00Z'; // 10:42 en México
  it('[MCP.21] cancelar sigue la misma regla y dice qué hacer en lugar de cancelar', () => {
    expect(bloqueoParaCorregir([surtido()], 'hasta_que_empiece_el_surtido', 'cancelar')).toBeNull();
    const m = bloqueoParaCorregir([surtido({ started_at: hora, started_by_name: 'Surtidor Prueba' })], 'hasta_que_empiece_el_surtido', 'cancelar');
    expect(m).toMatch(/Ya lo está surtiendo Surtidor Prueba desde las 10:42: ya no se cancela desde la app\. Avísale al surtidor/);
    const r = bloqueoParaCorregir([surtido({ started_at: hora, finished_at: hora, reviewed_at: hora, reviewed_by_name: 'Caja Prueba' })], 'hasta_que_empiece_el_surtido', 'cancelar');
    expect(r).toMatch(/Ya lo revisó la caja \(Caja Prueba, 10:42\): ya no se cancela desde la app\. Avísale a la caja/);
    expect(bloqueoParaCorregir([surtido({ started_at: hora })], 'permitir', 'cancelar')).toBeNull();
  });
  it('sin surtido (o sin empezar) se puede corregir', () => {
    expect(bloqueoParaCorregir([], 'hasta_que_empiece_el_surtido')).toBeNull();
    expect(bloqueoParaCorregir([surtido()], 'hasta_que_empiece_el_surtido')).toBeNull();
  });
  it('con el surtido empezado NO, y dice quién, desde qué hora y qué hacer', () => {
    const m = bloqueoParaCorregir([surtido({ started_at: hora, started_by_name: 'Surtidor Prueba' })], 'hasta_que_empiece_el_surtido');
    expect(m).toMatch(/Ya lo está surtiendo Surtidor Prueba desde las 10:42/);
    expect(m).toMatch(/toma un pedido nuevo/);
    expect(m).toMatch(/pídele al surtidor/);
  });
  it('ya surtido → apunta a la caja; ya revisado → lo dice', () => {
    expect(bloqueoParaCorregir([surtido({ started_at: hora, finished_at: hora, finished_by_name: 'Surtidor Prueba' })], 'hasta_que_empiece_el_surtido'))
      .toMatch(/Ya lo surtió Surtidor Prueba a las 10:42.*pídele a la caja/);
    expect(bloqueoParaCorregir([surtido({ started_at: hora, finished_at: hora, reviewed_at: hora, reviewed_by_name: 'Cajera Prueba' })], 'hasta_que_empiece_el_surtido'))
      .toMatch(/Ya lo revisó la caja \(Cajera Prueba, 10:42\)/);
  });
  it('basta con que UNA parte del grupo haya empezado', () => {
    expect(bloqueoParaCorregir([surtido(), surtido({ started_at: hora, started_by_name: 'Otro' })], 'hasta_que_empiece_el_surtido')).toMatch(/Otro/);
  });
  it('la política se revierte en un solo lugar: «permitir» y «hasta que termine»', () => {
    const empezado = [surtido({ started_at: hora, started_by_name: 'S' })];
    expect(bloqueoParaCorregir(empezado, 'permitir')).toBeNull();
    expect(bloqueoParaCorregir(empezado, 'hasta_que_termine_el_surtido')).toBeNull();
    expect(bloqueoParaCorregir([surtido({ started_at: hora, finished_at: hora })], 'hasta_que_termine_el_surtido')).not.toBeNull();
  });
});

describe('[MCP.18] motivos por renglón (surtido y caja)', () => {
  it('valida contra el catálogo y se queda sólo con lo que trae motivo', () => {
    const m = motivosPorRenglon([
      { line_id: 'a', picked: 0, reason: 'danado' },
      { line_id: 'b', picked: 1 },
      { line_id: 'c', picked: 0, reason: 'otro', reason_note: ' se rompió la caja ' },
    ], MOTIVOS_SURTIDO, 'line_id');
    expect([...m.keys()]).toEqual(['a', 'c']);
    expect(m.get('c')).toEqual({ reason: 'otro', reason_note: 'se rompió la caja' });
  });
  it('negativa: motivo de otro catálogo u «Otro» sin nota → error', () => {
    expect(() => motivosPorRenglon([{ line_id: 'a', reason: 'no_venia' }], MOTIVOS_SURTIDO, 'line_id')).toThrow(MotivoInvalido);
    expect(() => motivosPorRenglon([{ key: 'a', reason: 'otro' }], MOTIVOS_SURTIDO, 'key')).toThrow(/escribe cuál/);
  });
  it('D4: todo renglón que faltó trae su motivo, o error con los productos en palabras', () => {
    const m = motivosPorRenglon([{ line_id: 'a', reason: 'no_localizado' }], MOTIVOS_SURTIDO, 'line_id');
    expect(() => exigirMotivosDeRenglones([{ id: 'a', product_name: 'SALSA' }], m)).not.toThrow();
    expect(() => exigirMotivosDeRenglones([], new Map())).not.toThrow();
    expect(() => exigirMotivosDeRenglones([{ id: 'a', product_name: 'SALSA' }, { id: 'b', product_name: 'CHICLE' }], m)).toThrow(/CHICLE/);
    const muchos = ['b', 'c', 'd', 'e', 'f'].map((id) => ({ id, product_name: 'P-' + id }));
    expect(() => exigirMotivosDeRenglones(muchos, m)).toThrow('P-b, P-c, P-d y 2 más');
  });

  const reporte: PresalePickReport = {
    removed: [{ product_name: 'SALSA', unit: 'CJA', ordered: 2, picked: 0, line_id: 'a' }],
    adjusted: [{ product_name: 'CHICLE', unit: 'PAQ', ordered: 3, picked: 1, line_id: 'b' }],
    total_before: 100, total_after: 40,
  };
  it('el motivo queda en el renglón del reporte; lo que no faltó no lleva', () => {
    const r = conMotivosEnReporte(reporte, new Map([['a', { reason: 'danado' }], ['zz', { reason: 'danado' }]]));
    expect(r?.removed[0].reason).toBe('danado');
    expect(r?.adjusted[0].reason).toBeUndefined();
    expect(conMotivosEnReporte(null, new Map([['a', { reason: 'danado' }]]))).toBeNull();
  });

  const linea = (x: Partial<PresaleReviewResultLine>): PresaleReviewResultLine => ({
    key: 'k', product_name: 'P', unit: 'PZA', ordered: 2, picked: 2, final: 2, returned: 0, resolution: 'bien', ...x,
  });
  it('caja: el motivo sólo donde la caja dejó MENOS de lo surtido', () => {
    const out = conMotivosEnRevision([
      linea({ key: 'menos', final: 1, resolution: 'no_hubo' }),
      linea({ key: 'ya_faltaba', picked: 0, final: 0, resolution: 'no_hubo' }),
      linea({ key: 'bien' }),
    ], new Map([['menos', { reason: 'danado' }], ['ya_faltaba', { reason: 'danado' }], ['bien', { reason: 'danado' }]]));
    expect(out.map((l) => l.reason ?? null)).toEqual(['danado', null, null]);
  });
});

describe('[MCP.18] armarJustificantes — lo que ven los otros roles', () => {
  it('historia: «Corregir» con motivo, el texto por omisión = sin motivo, y la cancelación', () => {
    const js = armarJustificantes({
      historia: [
        { from_status: 'confirmed', to_status: 'draft', reason: 'reabierto para corregir', changed_at: '2026-11-10T15:00:00Z', by_name: 'Vendedor Prueba', by_seller: true },
        { from_status: 'confirmed', to_status: 'draft', reason: 'El cliente quiere agregar productos', changed_at: '2026-11-10T15:10:00Z', by_name: 'Vendedor Prueba', by_seller: true },
        { from_status: 'draft', to_status: 'confirmed', reason: null, changed_at: '2026-11-10T15:11:00Z', by_name: 'Vendedor Prueba', by_seller: true },
        { from_status: 'confirmed', to_status: 'cancelled', reason: 'Pedido duplicado', changed_at: '2026-11-10T15:20:00Z', by_name: 'Comercial', by_seller: false },
      ],
    });
    expect(js.map((j) => [j.action, j.actor, j.reason])).toEqual([
      ['reopened', 'seller', null],
      ['reopened', 'seller', 'El cliente quiere agregar productos'],
      ['cancelled', 'other', 'Pedido duplicado'],
    ]);
    expect(textoDeJustificante(js[0]).motivo).toBe(SIN_MOTIVO_REGISTRADO);
  });
  it('surtido y caja, con su motivo; un reporte viejo sin motivo dice «sin motivo registrado»', () => {
    const js = armarJustificantes({
      reporte: {
        removed: [{ product_name: 'SALSA', unit: 'CJA', ordered: 2, picked: 0, line_id: 'a', reason: 'danado', reason_note: 'mojada' }],
        adjusted: [{ product_name: 'CHICLE', unit: 'PAQ', ordered: 3, picked: 1, line_id: 'b' }],
        total_before: 100, total_after: 40,
      },
      surtio: { name: 'Surtidor Prueba', at: '2026-11-10T16:00:00Z' },
      revision: {
        lines: [
          { key: 'c', product_name: 'MAZAPÁN', unit: 'PZA', ordered: 5, picked: 5, final: 3, returned: 0, resolution: 'no_hubo', reason: 'no_venia' },
          { key: 'b', product_name: 'CHICLE', unit: 'PAQ', ordered: 3, picked: 1, final: 1, returned: 0, resolution: 'no_hubo' },
        ],
        total_before: 40, total_after: 30,
      },
      reviso: { name: 'Cajera Prueba', at: '2026-11-10T17:00:00Z' },
    });
    expect(js.map((j) => [j.actor, j.action, j.product_name, j.detail, j.reason])).toEqual([
      ['picker', 'removed', 'SALSA', '2 CJA', 'Dañado o caducado: mojada'],
      ['picker', 'trimmed', 'CHICLE', '1 de 3 PAQ', null],
      // El faltante del CHICLE ya venía del surtido: la caja no lo repite.
      ['cashier', 'not_in_cart', 'MAZAPÁN', '3 de 5 PZA', 'No venía en el carrito'],
    ]);
    expect(textoDeJustificante(js[1])).toEqual({ quien: 'Surtidor · Surtidor Prueba', que: 'Surtió menos de CHICLE (1 de 3 PAQ)', motivo: SIN_MOTIVO_REGISTRADO });
  });
  it('en orden de tiempo, y nada inventado cuando no hay datos', () => {
    expect(armarJustificantes({})).toEqual([]);
    const js = armarJustificantes({
      historia: [{ from_status: 'confirmed', to_status: 'draft', reason: 'x', changed_at: '2026-11-10T18:00:00Z', by_name: null, by_seller: true }],
      reporte: { removed: [{ product_name: 'A', unit: 'PZA', ordered: 1, picked: 0 }], adjusted: [], total_before: 1, total_after: 0 },
      surtio: { name: 'S', at: '2026-11-10T17:00:00Z' },
    });
    expect(js.map((j) => j.action)).toEqual(['removed', 'reopened']);
    expect(js[1].by_name).toBeNull();
  });
  it('motivoDeHistoria: los textos que el sistema escribía solo no son motivo', () => {
    expect(motivoDeHistoria('reabierto para corregir')).toBeNull();
    expect(motivoDeHistoria('Cancelado por el vendedor')).toBeNull();
    expect(motivoDeHistoria('  ')).toBeNull();
    expect(motivoDeHistoria('Pedido duplicado')).toBe('Pedido duplicado');
  });
});
