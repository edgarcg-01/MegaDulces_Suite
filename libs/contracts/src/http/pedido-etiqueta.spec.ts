import { codigoDeBarrasDePedido, folioDeLectura, ligaDePedido, pasoDelPedido } from './pedido-etiqueta';

describe('[MCP.32] codigoDeBarrasDePedido', () => {
  it('12 dígitos: 99 + año + número a 6', () => {
    expect(codigoDeBarrasDePedido('PD-2026-00012')).toBe('992026000012');
    expect(codigoDeBarrasDePedido('pd-2026-123456')).toBe('992026123456');
  });
  it('lo que no es un folio de la Suite: null (la etiqueta sale sólo con QR)', () => {
    expect(codigoDeBarrasDePedido('03UD1001-0018665')).toBeNull();
    expect(codigoDeBarrasDePedido('PD-2026-1234567')).toBeNull();
    expect(codigoDeBarrasDePedido(null)).toBeNull();
  });
});

describe('[MCP.33] folioDeLectura', () => {
  it('lee el QR, el código de barras y el folio tecleado', () => {
    expect(folioDeLectura('PD-2026-00012')).toBe('PD-2026-00012');
    expect(folioDeLectura('992026000012')).toBe('PD-2026-00012');
    expect(folioDeLectura(' pd 2026 12 ')).toBe('PD-2026-00012');
  });
  it("un lector con teclado en español manda ' en lugar de -", () => {
    expect(folioDeLectura("PD'2026'00012")).toBe('PD-2026-00012');
  });
  it('ida y vuelta: lo que se imprime se lee igual', () => {
    for (const f of ['PD-2026-00001', 'PD-2026-99999', 'PD-2027-123456']) {
      expect(folioDeLectura(codigoDeBarrasDePedido(f))).toBe(f);
    }
  });
  it('negativa: un código de producto, una etiqueta del checado o basura no son pedido', () => {
    expect(folioDeLectura('7501000111206')).toBeNull(); // EAN-13
    expect(folioDeLectura('000278110003')).toBeNull(); // etiqueta del checado
    expect(folioDeLectura('992026000000')).toBeNull(); // número 0
    expect(folioDeLectura('gomitas')).toBeNull();
    expect(folioDeLectura('')).toBeNull();
  });
});

describe('[MCP.36] ligaDePedido y la lectura de la liga', () => {
  const o = 'https://megadulcessuite.com';
  it('la liga lleva el folio a la vista y la firma en k', () => {
    expect(ligaDePedido(o, 'PD-2026-00039', 'a.b-c_d')).toBe('https://megadulcessuite.com/pedido/PD-2026-00039?k=a.b-c_d');
    expect(ligaDePedido(o + '/', 'pd-2026-00039', 'x')).toBe('https://megadulcessuite.com/pedido/PD-2026-00039?k=x');
  });
  it('negativa: sin firma, sin origen o con un folio que no es de la Suite no hay liga', () => {
    expect(ligaDePedido(o, 'PD-2026-00039', '')).toBeNull();
    expect(ligaDePedido('', 'PD-2026-00039', 'x')).toBeNull();
    expect(ligaDePedido('megadulcessuite.com', 'PD-2026-00039', 'x')).toBeNull();
    expect(ligaDePedido(o, '03UD1001-0018665', 'x')).toBeNull();
  });
  it('los lectores de la Suite sacan el folio de la liga (ida y vuelta)', () => {
    const k = 'eyJhbGciOiJIUzI1NiJ9.eyJ0IjoicGQifQ.PD2026999999abc';
    expect(folioDeLectura(ligaDePedido(o, 'PD-2026-00039', k))).toBe('PD-2026-00039');
    expect(folioDeLectura('http://localhost:4200/pedido/PD-2026-00039?k=zz')).toBe('PD-2026-00039');
  });
  it("la pistola con teclado en español: '/' y '-' llegan cambiados y aún se lee", () => {
    expect(folioDeLectura("httpsÑ--megadulcessuite.com-pedido-PD'2026'00039_k=abc")).toBe('PD-2026-00039');
  });
  it('negativa: un folio que sólo aparece dentro de la firma no se lee', () => {
    expect(folioDeLectura('https://megadulcessuite.com/otra/cosa?k=PD-2026-00039')).toBeNull();
  });
  it('las etiquetas impresas antes (sólo el folio) se siguen leyendo', () => {
    expect(folioDeLectura('PD-2026-00039')).toBe('PD-2026-00039');
    expect(folioDeLectura('992026000039')).toBe('PD-2026-00039');
  });
});

describe('[MCP.36] pasoDelPedido', () => {
  const t = '2026-11-25T10:00:00Z';
  it('cada paso, en palabras de la gente', () => {
    expect(pasoDelPedido({ status: 'cancelled' }).clave).toBe('cancelado');
    expect(pasoDelPedido({ status: 'fulfilled' }).clave).toBe('entregado');
    expect(pasoDelPedido({ status: 'pending_approval' }).clave).toBe('por_confirmar');
    expect(pasoDelPedido({ status: 'confirmed' }).clave).toBe('por_surtir');
    expect(pasoDelPedido({ status: 'confirmed', pick_started_at: t }).clave).toBe('surtiendo');
    expect(pasoDelPedido({ status: 'confirmed', pick_started_at: t, pick_finished_at: t, pick_outcome: 'completo' })).toEqual({ clave: 'surtido', texto: 'Surtido' });
    expect(pasoDelPedido({ status: 'confirmed', pick_started_at: t, pick_finished_at: t, pick_outcome: 'con_faltantes', reviewed_at: t }))
      .toEqual({ clave: 'revisado', texto: 'Revisado, listo para entregar, con faltantes' });
    expect(pasoDelPedido({ status: 'confirmed', pick_started_at: t, pick_finished_at: t, pick_outcome: 'sin_mercancia' }).clave).toBe('sin_mercancia');
  });
  it('negativa: un estado que la regla no conoce se DICE, no se pinta como otro', () => {
    expect(pasoDelPedido({ status: 'en_ruta_marte' })).toEqual({ clave: 'desconocido', texto: 'Estado «en_ruta_marte»' });
    expect(pasoDelPedido({ status: null }).clave).toBe('desconocido');
  });
});
