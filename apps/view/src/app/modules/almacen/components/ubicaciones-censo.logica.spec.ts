import { describe, expect, it } from 'vitest';
import type { ProductPresentation, WarehouseLocationRow } from '@megadulces/contracts';
import { clasificarLectura, lugaresEnPalabras, papelParaUbicacion, presentacionDeLectura, presentacionParaLugar, tipoPorDefecto } from './ubicaciones-censo.logica';

/** `[UB.3b]` Lo que el censo deduce para que la persona sólo escanee. */

const U = (p: Partial<WarehouseLocationRow>): Pick<WarehouseLocationRow, 'code' | 'zona' | 'tipo' | 'estado'> => ({ code: 'BA053', zona: 'B', tipo: 'surtido', estado: 'activa', ...p });
const P = (peldano: 1 | 2 | 3, rotulo: string, codigos: string[]): ProductPresentation => ({ peldano, rotulo, factor: peldano === 1 ? 1 : 20, fuente: 'capturado', codigos, es_caja: peldano > 1 });
// Medido en prod (CEDIS, 2026-11-17): AVILA MAZAPAN 40 · PAQ 7502212930012 · CJA C07302.
const MAZAPAN = { presentaciones: [P(1, 'PAQ', ['7502212930012', 'CB1207302']), P(2, 'CJA', ['C07302', 'CB2207302'])] };

describe('[UB.3b] clasificarLectura', () => {
  it('un cartel de ubicación (aunque venga en minúsculas o con espacios) es ubicación', () => {
    expect(clasificarLectura(' ba053 ')).toMatchObject({ tipo: 'ubicacion', code: 'BA053' });
    expect(clasificarLectura('TA011')).toMatchObject({ tipo: 'ubicacion', code: 'TA011' });
  });
  it('un código de barras, una clave o un nombre se buscan como producto', () => {
    expect(clasificarLectura('7502212930012')).toEqual({ tipo: 'producto', texto: '7502212930012' });
    expect(clasificarLectura('C07302')).toEqual({ tipo: 'producto', texto: 'C07302' });
    expect(clasificarLectura('mazapan')).toEqual({ tipo: 'producto', texto: 'mazapan' });
  });
  // [UB.NV.1] El nivel llega al 9 desde el 2026-11-26, asi que BA057 YA ES una ubicacion valida.
  // El caso negativo pasa al 0, que sigue sin existir: el nivel empieza en 1.
  it('NEGATIVA: algo que parece ubicación pero no lo es (nivel 0) no cambia la ubicación: se busca como producto', () => {
    expect(clasificarLectura('BA050').tipo).toBe('producto');
  });

  // ⭐ Y el control del cambio de tope: el 7, el 8 y el 9 AHORA sí mandan a la ubicación.
  it('[UB.NV.1] los niveles 7, 8 y 9 ya son ubicaciones, no códigos de producto', () => {
    for (const code of ['BA057', 'BA058', 'BA059']) {
      expect(clasificarLectura(code).tipo).toBe('ubicacion');
    }
  });
  it('vacío no hace nada', () => {
    expect(clasificarLectura('   ').tipo).toBe('vacia');
  });
});

describe('[UB.3b] papelParaUbicacion: el papel sale de la ubicación', () => {
  it('bodega de surtido (o sin tipo) = lugar fijo de surtido', () => {
    expect(papelParaUbicacion(U({}))).toEqual({ papel: 'surtido_fijo' });
    expect(papelParaUbicacion(U({ tipo: null }))).toEqual({ papel: 'surtido_fijo' });
  });
  it('bodega de reserva = reserva preferida', () => {
    expect(papelParaUbicacion(U({ tipo: 'reserva' }))).toEqual({ papel: 'reserva_preferida' });
  });
  it('tienda = exhibición en tienda', () => {
    expect(papelParaUbicacion(U({ code: 'TA011', zona: 'T', tipo: 'tienda_piso' }))).toEqual({ papel: 'exhibicion_tienda' });
  });
  it.each([
    ['bloqueada', U({ estado: 'bloqueada' }), 'bloqueada'],
    ['dada de baja', U({ estado: 'baja' }), 'baja'],
    ['de recepción', U({ tipo: 'recepcion' }), 'recepción'],
    ['de merma', U({ tipo: 'merma' }), 'merma'],
    ['con código libre (sin zona)', U({ code: 'RACK-1', zona: null }), 'formato'],
  ])('NEGATIVA: una ubicación %s no recibe productos, y dice por qué', (_c, u, palabra) => {
    const r = papelParaUbicacion(u);
    expect('motivo' in r && r.motivo).toContain(palabra);
  });
});

describe('[UB.3b] presentacionDeLectura: la presentación sale del código de barras', () => {
  it('⭐ el código del paquete da el paquete y el de la caja da la caja', () => {
    expect(presentacionDeLectura(MAZAPAN, '7502212930012')).toEqual({ peldano: 1 });
    expect(presentacionDeLectura(MAZAPAN, 'c07302')).toEqual({ peldano: 2 });
  });
  it('con una sola presentación, la clave o el nombre bastan', () => {
    expect(presentacionDeLectura({ presentaciones: [P(1, 'PZA', [])] }, '95694')).toEqual({ peldano: 1 });
  });
  it('NEGATIVA: con varias presentaciones y una lectura que no es código de ninguna, pregunta (no adivina)', () => {
    const r = presentacionDeLectura(MAZAPAN, '07302');
    expect('opciones' in r && r.opciones.map((p) => p.rotulo)).toEqual(['PAQ', 'CJA']);
  });
  it('NEGATIVA: un código repetido en dos presentaciones pregunta entre esas dos', () => {
    const r = presentacionDeLectura({ presentaciones: [P(1, 'PZA', ['111']), P(2, 'PAQ', ['111']), P(3, 'CJA', ['333'])] }, '111');
    expect('opciones' in r && r.opciones.map((p) => p.rotulo)).toEqual(['PZA', 'PAQ']);
  });
});

describe('[UB.3b] tipoPorDefecto al dar de alta desde el escaneo', () => {
  it('bodega = surtido, tienda = piso', () => {
    expect(tipoPorDefecto('B')).toBe('surtido');
    expect(tipoPorDefecto('T')).toBe('tienda_piso');
  });
});

// [UB.RF.11] Lo que la pantalla rehecha dice y decide sin pantalla de por medio.
const A = (presentacion: 1 | 2 | 3, papel: 'surtido_fijo' | 'exhibicion_tienda' | 'reserva_preferida', code: string, estado: 'activa' | 'baja' = 'activa') =>
  ({ id: 'a' + code, bin_id: 'b' + code, code, zona: code[0] as 'B' | 'T', estado, presentacion, presentacion_rotulo: presentacion === 1 ? 'PAQ' : 'CJA', papel, min_qty: null, max_qty: null });

describe('[UB.RF.11] lugaresEnPalabras', () => {
  it('tienda y bodega SIEMPRE: lo que falta se dice «falta» (valor null), no se esconde', () => {
    expect(lugaresEnPalabras([{ papel: 'exhibicion_tienda', code: 'TA011', presentacion: 1, rotulo: 'PAQ' }]))
      .toEqual([{ etiqueta: 'Tienda', valor: 'TA011' }, { etiqueta: 'Bodega', valor: null }]);
  });
  it('con varias presentaciones cada código lleva su rótulo; la reserva sale sólo si hay', () => {
    expect(lugaresEnPalabras([
      { papel: 'surtido_fijo', code: 'BA053', presentacion: 2, rotulo: 'CJA' },
      { papel: 'surtido_fijo', code: 'BA052', presentacion: 1, rotulo: 'PAQ' },
      { papel: 'reserva_preferida', code: 'BC022', presentacion: 2, rotulo: 'CJA' },
    ])).toEqual([
      { etiqueta: 'Tienda', valor: null },
      { etiqueta: 'Bodega', valor: 'BA053 (CJA), BA052 (PAQ)' },
      { etiqueta: 'Reserva', valor: 'BC022 (CJA)' },
    ]);
  });
});

describe('[UB.RF.13] presentacionParaLugar — paquete O caja', () => {
  it('la presentación leída por su código de barras gana', () => {
    expect(presentacionParaLugar(MAZAPAN, 2)).toEqual({ peldano: 2 });
  });
  it('con una sola presentación no hay nada que preguntar', () => {
    expect(presentacionParaLugar({ presentaciones: [MAZAPAN.presentaciones[0]] }, null)).toEqual({ peldano: 1 });
  });
  it('⭐ NEGATIVA: con PAQ y CJA y sin código, se PREGUNTA — aunque el PAQ ya tenga lugar, no se deduce la CJA', () => {
    expect(presentacionParaLugar(MAZAPAN, null)).toMatchObject({ opciones: [{ peldano: 1 }, { peldano: 2 }] });
    expect(presentacionParaLugar({ ...MAZAPAN, asignaciones: [A(1, 'surtido_fijo', 'BA052')] }, null)).toMatchObject({ opciones: [{ peldano: 1 }, { peldano: 2 }] });
  });
});
