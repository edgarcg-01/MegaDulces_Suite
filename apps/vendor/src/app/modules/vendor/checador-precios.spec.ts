import type { VerificadorPrecioOk, VerificadorSnapshotItem } from '@megadulces/contracts';
import {
  copiaVencida,
  cuandoEs,
  estadoDeCopia,
  fichaDeCopia,
  fichaDeVivo,
  mayoreoDelRespaldo,
  motivoDeFallo,
  pareceCodigo,
  sucursalDelChecador,
} from './checador-precios';

/**
 * `[VTK.17]` Checador de precios — las reglas que no necesitan Angular.
 *
 * Una prueba negativa por regla: la copia de ayer NO dice «hoy»; sin sucursal asignada NO se usa
 * la de omisión; un código en dos productos NO se presenta como uno; «sin señal» NO se dice
 * «el servidor falló».
 */

// Forma real de prod (medida el 2026-11-09, sucursal 02), con un nombre de prueba.
const vivo = (o: Partial<VerificadorPrecioOk> = {}): VerificadorPrecioOk => ({
  ok: true, codigo: '00052', nombre: 'DULCE PRUEBA /12', unidad: 'PZA', precio_con_iva: 8.78, precio_sin_iva: 8.13,
  unidades: [
    { u: 'PZA', precio_con_iva: 8.78, precio_sin_iva: 8.13, factor: 1 },
    { u: 'PAQ', precio_con_iva: 93.48, precio_sin_iva: 86.56, factor: 12 },
    { u: 'CJA', precio_con_iva: 1057.11, precio_sin_iva: 978.81, factor: 144 },
  ],
  unidad_escaneada: 'PAQ', unidad_base: 'PZA', mayoreo: [], contenido: null, product_id: null,
  iva_pct: 0, ieps_pct: 8, sucursal_precio: '02', precio_ambiguo: false, plazas_con_precio_distinto: 1,
  codigo_ambiguo: false, productos_candidatos: [], plaza_pedida_sin_dato: false, origen_precio: 'kepler',
  ...o,
});

const renglon = (o: Partial<VerificadorSnapshotItem> = {}): VerificadorSnapshotItem => ({
  c: '00052', n: 'DULCE PRUEBA /12', b: ['7500000000052', '840004096513'], bu: ['PZA', 'PAQ'],
  u: [{ u: 'PZA', p: 8.78, s: 8.13, f: 1 }, { u: 'PAQ', p: 93.48, s: 86.56, f: 12 }, { u: 'CJA', p: 1057.11, s: 978.81, f: 144 }],
  ...o,
});

describe('motivoDeFallo — por qué se contestó con la copia', () => {
  it('⭐ sin señal (504 sin cuerpo del service worker, status 0, o el teléfono sin red) es «sin_senal»', () => {
    expect(motivoDeFallo({ status: 504, error: null }, true)).toBe('sin_senal');
    expect(motivoDeFallo({ status: 0 }, true)).toBe('sin_senal');
    expect(motivoDeFallo({ status: 500 }, false)).toBe('sin_senal');
  });

  it('tardó, falló o rechazó: cada uno lo suyo', () => {
    expect(motivoDeFallo({ name: 'TimeoutError' }, true)).toBe('lento');
    expect(motivoDeFallo({ status: 500, error: { message: 'x' } }, true)).toBe('servidor');
    expect(motivoDeFallo({ status: 400, error: { message: 'x' } }, true)).toBe('rechazo');
  });

  it('⛔ [negativa] un 504 CON mensaje del servidor no es «sin señal»: es el servidor', () => {
    expect(motivoDeFallo({ status: 504, error: { message: 'Gateway del ODS' } }, true)).toBe('servidor');
  });
});

describe('fichaDeVivo / fichaDeCopia — lo que se pinta de UN producto', () => {
  it('en vivo: presentaciones con lo que traen, y la unidad del código leído', () => {
    const f = fichaDeVivo(vivo());
    expect(f.presentaciones.map((p) => [p.nombre, p.precio, p.trae?.n, p.trae?.u])).toEqual([
      ['Pieza', 8.78, undefined, undefined], ['Paquete', 93.48, 12, 'PZA'], ['Caja', 1057.11, 12, 'PAQ'],
    ]);
    expect(f.unidadLeida).toBe('PAQ');
    expect(f.otrosConElCodigo).toEqual([]);
  });

  it('⭐ [TDA.9] código en dos productos: se nombra al otro, no se elige en silencio', () => {
    const f = fichaDeVivo(vivo({
      codigo_ambiguo: true,
      productos_candidatos: [{ codigo: '00052', nombre: 'DULCE PRUEBA /12', precio_con_iva: 8.78 }, { codigo: '33259', nombre: 'OTRO PRUEBA', precio_con_iva: 20 }],
    }));
    expect(f.otrosConElCodigo).toEqual(['OTRO PRUEBA']);
  });

  it('promoción, precio ambiguo, de otra plaza y corregido a mano llegan como banderas', () => {
    const f = fichaDeVivo(vivo({ es_promocion: true, precio_ambiguo: true, plaza_pedida_sin_dato: true, origen_precio: 'override_manual' }));
    expect([f.esPromocion, f.precioAmbiguo, f.deOtraPlaza, f.corregidoAMano]).toEqual([true, true, true, true]);
  });

  it('⛔ [negativa] una unidad leída SIN precio no se afirma', () => {
    expect(fichaDeVivo(vivo({ unidad_escaneada: 'BTO' })).unidadLeida).toBeNull();
  });

  it('desde la copia: misma cuenta, la unidad sale de `bu`, y un gemelo de código se nombra', () => {
    const otro = renglon({ c: '33259', n: 'OTRO PRUEBA' });
    const f = fichaDeCopia(renglon(), '840004096513', [renglon(), otro]);
    expect(f.presentaciones[2].trae).toEqual({ n: 12, u: 'PAQ', palabra: 'paquetes' });
    expect(f.unidadLeida).toBe('PAQ');
    expect(f.otrosConElCodigo).toEqual(['OTRO PRUEBA']);
    expect(fichaDeCopia(renglon({ pm: 1 }), '00052').esPromocion).toBe(true);
  });
});

describe('[VTK.17] los dos mayoreos (pieza y paquete) — David: «agrega ambos precios de mayoreo»', () => {
  const tierPieza = { etiqueta: 'pieza', desde: 12, palabra: 'piezas', precio_con_iva: 8.2, ahorro_por_unidad: 0.58, ahorro_en_el_minimo: 6.96,
    descuento_pct: 6.6, realza: true, aplica_a: 'base' as const, unidad_monto: 'c/u', equivale_a: null };
  const tierPaquete = { etiqueta: 'paquete', desde: 3, palabra: 'paquetes', precio_con_iva: 88, ahorro_por_unidad: 5.48, ahorro_en_el_minimo: 16.44,
    descuento_pct: 5.9, realza: true, aplica_a: 'paquete' as const, unidad_monto: 'por paquete', equivale_a: '36 piezas' };
  const esperado = [['PZA', 12, 8.2, 'c/pieza'], ['PAQ', 3, 88, 'c/paquete']];
  const forma = (m: Array<{ u: string; desde: number; precio: number; etiqueta: string }>) => m.map((e) => [e.u, e.desde, e.precio, e.etiqueta]);

  it('en línea: cada escalón en su presentación, desde cuántos y a cuánto', () => {
    const f = fichaDeVivo(vivo({ mayoreo: [tierPieza, tierPaquete] }));
    expect(forma(f.mayoreo)).toEqual(esperado);
    expect(f.mayoreoSabido).toBe(true);
  });

  it('desde la copia: el mayoreo compacto se lee igual que el de en línea', () => {
    const m = [
      { e: 'pieza', d: 12, w: 'piezas', p: 8.2, au: 0.58, am: 6.96, pc: 6.6, r: 1 as const, a: 0 as const, um: 'c/u' },
      { e: 'paquete', d: 3, w: 'paquetes', p: 88, au: 5.48, am: 16.44, pc: 5.9, r: 1 as const, a: 1 as const, um: 'por paquete', eq: '36 piezas' },
    ];
    const f = fichaDeCopia(renglon({ m }), '00052');
    expect(forma(f.mayoreo)).toEqual(esperado);
    expect(f.mayoreoSabido).toBe(true);
  });

  it('⛔ [negativa] una copia SIN `m` (formato viejo) no dice «sin mayoreo»: dice que no lo sabe', () => {
    const f = fichaDeCopia(renglon(), '00052');
    expect(f.mayoreo).toEqual([]);
    expect(f.mayoreoSabido).toBe(false);
    expect(mayoreoDelRespaldo(renglon({ m: [] }))).toEqual({ mayoreo: [], mayoreoSabido: true });
  });
});

describe('cuandoEs / copiaVencida — de cuándo es la copia (nunca «hoy» si no es de hoy)', () => {
  // 2026-11-09 16:30 en México (22:30 UTC).
  const ahora = new Date('2026-11-09T22:30:00Z');

  it('de hoy dice «hoy» con la hora de México', () => {
    expect(cuandoEs('2026-11-09T14:12:00Z', ahora)).toEqual({ texto: 'hoy 08:12', esDeHoy: true });
  });

  it('⭐⛔ [negativa] la copia de AYER no dice «hoy», aunque en UTC ya sea el mismo día', () => {
    // 2026-11-09 03:00 UTC = 2026-11-08 21:00 en México: es de AYER para el vendedor.
    const c = cuandoEs('2026-11-09T03:00:00Z', ahora);
    expect(c.esDeHoy).toBe(false);
    expect(c.texto).toBe('ayer 21:00');
    expect(c.texto).not.toContain('hoy');
  });

  it('más vieja: día y mes; ilegible: lo dice', () => {
    expect(cuandoEs('2026-11-07T00:03:00Z', ahora).texto).toBe('6 nov, 18:03');
    expect(cuandoEs('no-es-fecha', ahora)).toEqual({ texto: 'fecha desconocida', esDeHoy: false });
    expect(cuandoEs(null, ahora).esDeHoy).toBe(false);
  });

  it('se vuelve a bajar: si no es de hoy, si pasó el plazo, si es de formato anterior o si no tiene fecha', () => {
    expect(copiaVencida({ generado: '2026-11-09T14:12:00Z', formatoAnterior: false }, ahora)).toBe(false);
    expect(copiaVencida({ generado: '2026-11-09T03:00:00Z', formatoAnterior: false }, ahora)).toBe(true);
    expect(copiaVencida({ generado: '2026-11-09T14:12:00Z', formatoAnterior: true }, ahora)).toBe(true);
    expect(copiaVencida({ generado: '', formatoAnterior: false }, ahora)).toBe(true);
  });

  it('estadoDeCopia nombra la sucursal (no la numera) y declara el formato', () => {
    const e = estadoDeCopia('02', { v: 4, total: 9537, generado: 'g', productos: [] }, 'x');
    expect(e.nombreSucursal).toBe('La Piedad Abastos');
    expect(e.formatoAnterior).toBe(false);
    expect(estadoDeCopia('02', { v: 2, generado: 'g', productos: [] }, 'x').formatoAnterior).toBe(true);
  });
});

describe('sucursalDelChecador — la de Tomar pedido, o se dice por qué no', () => {
  it('con sucursal asignada y clave de Kepler: ésa', () => {
    expect(sucursalDelChecador({ code: '02', name: 'La Piedad Abastos', assigned: true }))
      .toEqual({ ok: true, codigo: '02', nombre: 'La Piedad Abastos', deLaCopia: false });
  });

  it('⛔ [negativa] sin sucursal, o con la de omisión del tenant (assigned:false), NO se adivina', () => {
    const sin = sucursalDelChecador(null);
    const omision = sucursalDelChecador({ code: '02', name: 'La Piedad Abastos', assigned: false });
    expect(sin.ok).toBe(false);
    expect(omision.ok).toBe(false);
    if (!omision.ok) expect(omision.motivo).toContain('No tienes sucursal de surtido asignada');
  });

  it('⛔ [negativa] una sucursal sin clave de Kepler de 2 dígitos no se consulta', () => {
    const r = sucursalDelChecador({ code: 'MD-30', name: 'Almacén Prueba', assigned: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('Almacén Prueba');
  });
});

describe('pareceCodigo — Enter pregunta a Kepler sólo si es un código', () => {
  it('EAN, clave y clave interna sí; un nombre no', () => {
    expect(pareceCodigo('7501234567890')).toBe(true);
    expect(pareceCodigo('52')).toBe(true);
    expect(pareceCodigo('CB1100052')).toBe(true);
    expect(pareceCodigo('pulparindo')).toBe(false);
    expect(pareceCodigo('coca 600')).toBe(false);
    expect(pareceCodigo('  ')).toBe(false);
  });
});
