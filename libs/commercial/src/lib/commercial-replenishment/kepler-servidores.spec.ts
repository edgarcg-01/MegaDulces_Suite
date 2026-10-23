import { normalizarSucursal, plantillaDe, servidoresEncendidos, urlDeServidor } from './kepler-servidores';

/**
 * `[KR.11]` Un documento se escribe en el servidor Kepler de SU sucursal. El caso que importa es
 * el negativo: una sucursal sin su variable queda APAGADA, nunca redirigida a oficinas (`00`),
 * porque ahí el documento existiría en un ERP que esa sucursal no mira.
 */
const U00 = 'conexion-md_00';
const U02 = 'conexion-md_02';

describe('urlDeServidor', () => {
  it('cada sucursal usa SU variable', () => {
    expect(urlDeServidor('02', { KEPLER_PUSH_URL_02: U02, KEPLER_PUSH_URL_00: U00 })).toEqual({ ok: true, valor: U02 });
  });

  it('KEPLER_PUSH_URL sin sufijo sigue valiendo para 00 (runbook original)', () => {
    expect(urlDeServidor('00', { KEPLER_PUSH_URL: U00 })).toEqual({ ok: true, valor: U00 });
  });

  it('⛔ CONTROL: KEPLER_PUSH_URL NO es comodín — 02 sin su variable queda apagada, no va a md_00', () => {
    const r = urlDeServidor('02', { KEPLER_PUSH_URL: U00 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('KEPLER_PUSH_URL_02');
  });

  it('la variable propia de 00 gana sobre la legada', () => {
    expect(urlDeServidor('00', { KEPLER_PUSH_URL: 'vieja', KEPLER_PUSH_URL_00: U00 })).toEqual({ ok: true, valor: U00 });
  });

  it('un valor en blanco cuenta como apagado', () => {
    expect(urlDeServidor('02', { KEPLER_PUSH_URL_02: '   ' }).ok).toBe(false);
  });

  it('rechaza sucursales que no son de dos dígitos (camioneta, vacío)', () => {
    expect(normalizarSucursal('01-005').ok).toBe(false);
    expect(normalizarSucursal('').ok).toBe(false);
    expect(normalizarSucursal(null).ok).toBe(false);
    expect(normalizarSucursal(' 03 ')).toEqual({ ok: true, valor: '03' });
  });
});

describe('servidoresEncendidos', () => {
  it('lista sólo los configurados, en orden', () => {
    expect(servidoresEncendidos({ KEPLER_PUSH_URL_02: U02, KEPLER_PUSH_URL: U00 }).map((s) => s.sucursal)).toEqual(['00', '02']);
  });
  it('sin variables, ninguno', () => {
    expect(servidoresEncendidos({})).toEqual([]);
  });
});

describe('plantillaDe', () => {
  it('00 conserva el default de compra 0000424 y la serie 1', () => {
    expect(plantillaDe('compra', '00', {})).toEqual({ ok: true, valor: { serie: '1', folio: '0000424' } });
  });

  it('00 hereda las variables sin sufijo', () => {
    expect(plantillaDe('traspaso', '00', { KEPLER_PED_TEMPLATE_FOLIO: '0000450' }))
      .toEqual({ ok: true, valor: { serie: '1', folio: '0000450' } });
  });

  it('⛔ CONTROL: el folio de 00 no viaja a 02 — sin su plantilla, 02 rechaza', () => {
    const r = plantillaDe('compra', '02', { KEPLER_REQ_TEMPLATE_FOLIO: '0000424' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('KEPLER_REQ_TEMPLATE_FOLIO_02');
  });

  it('cada servidor usa su plantilla y su serie', () => {
    expect(plantillaDe('compra', '02', { KEPLER_REQ_TEMPLATE_FOLIO_02: '0000101', KEPLER_REQ_TEMPLATE_SERIE_02: '2' }))
      .toEqual({ ok: true, valor: { serie: '2', folio: '0000101' } });
  });

  it('el traspaso de 00 sigue sin default', () => {
    expect(plantillaDe('traspaso', '00', {}).ok).toBe(false);
  });
});
