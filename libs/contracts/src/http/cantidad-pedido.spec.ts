import { describe, expect, it } from 'vitest';
import { cabeBajoTope, diasDeCobertura, textoTopeBase, toparRedondeo, TOPE_COBERTURA_DIAS } from './cantidad-pedido.contract';
import { armarRenglon, redondearPedido, type EntradaRenglon, type EscaleraUnidades } from './autoabasto-pedido.contract';

/**
 * `[AB.40]` El motor único de cantidad: el tope de 45 días en unidad base. Los casos llevan su cuenta a
 * mano, para que la prueba no se valide contra sí misma.
 */

// Mr Beast Milk 60 g (97245): pieza, paquete de 10, caja de 180 (la escalera real de Kepler).
const MR_BEAST: EscaleraUnidades = { unit_base: 'PZA', u2_label: 'PAQ', u3_label: 'CJA', f2: 10, f3: 180, is_weight: false };

describe('[AB.40] el tope de 45 días', () => {
  it('cuánto cabe: venta 30 d × 45 ÷ 30.4 − existencia − lo que ya viene', () => {
    // 16,051 pz/30 d en Padre Hidalgo (medido 2026-10-26): 16,051 × 45 ÷ 30.4 = 23,759.70
    expect(cabeBajoTope({ venta30Base: 16051, existenciaBase: 1, vieneBase: 0 })).toBeCloseTo(23758.7, 1);
    expect(cabeBajoTope({ venta30Base: 16051, existenciaBase: 1, vieneBase: 1000 })).toBeCloseTo(22758.7, 1);
  });

  it('⭐ el caso de la captura: 144 cajas (25,920 pz) dejaban 49 días → se recorta a 131 cajas', () => {
    const r = redondearPedido(25848, MR_BEAST);          // 143.6 cajas → 144
    expect(r).toMatchObject({ regla: 'cajas', cantidad: 144, cantidad_base: 25920 });
    const t = toparRedondeo(r, MR_BEAST, { venta30Base: 16051, existenciaBase: 1, vieneBase: 0 });
    // caben 23,758.7 pz → 131 cajas enteras (23,580 pz); 132 serían 23,760 y ya pasan
    expect(t.motivo).toBe('recortado');
    expect(t.redondeo).toMatchObject({ regla: 'cajas', cantidad: 131, cantidad_base: 23580, factor: 180 });
    expect(t.dias).toBeLessThanOrEqual(TOPE_COBERTURA_DIAS);
    expect(t.antes_base).toBe(25920);
  });

  it('si no cabe ni una caja, baja a la unidad menor entera (no se rinde a 0)', () => {
    // venta 600 pz/30 d → caben 600 × 45 ÷ 30.4 − 800 = 88.2 pz → 8 paquetes de 10
    const r = redondearPedido(120, MR_BEAST);             // 120 pz = 0.67 cajas → 1 caja (180 pz)
    const t = toparRedondeo(r, MR_BEAST, { venta30Base: 600, existenciaBase: 800, vieneBase: 0 });
    expect(t.motivo).toBe('recortado');
    expect(t.redondeo).toMatchObject({ regla: 'menor', clase: 'menor', cantidad: 8, unidad: 'PAQ', cantidad_base: 80, factor: 10 });
  });

  it('lo que ya hay más lo que ya viene pasa el tope: no se pide, y se dice por qué', () => {
    const r = redondearPedido(500, MR_BEAST);
    const t = toparRedondeo(r, MR_BEAST, { venta30Base: 600, existenciaBase: 700, vieneBase: 300 });
    // (700 + 300) × 30.4 ÷ 600 = 50.7 días ≥ 45
    expect(t.motivo).toBe('ya_pasa_sin_pedir');
    expect(t.redondeo.cantidad).toBe(0);
    expect(t.dias_hoy).toBeCloseTo(50.67, 1);
    expect(textoTopeBase(t, 'PZA')).toContain('No se pide');
  });

  it('⛔ sin venta o con la unidad en duda NO se topa: se devuelve tal cual y se declara', () => {
    const r = redondearPedido(500, MR_BEAST);
    expect(toparRedondeo(r, MR_BEAST, { venta30Base: null, existenciaBase: 0, vieneBase: 0 })).toMatchObject({ motivo: 'sin_medir', redondeo: r, dias: null });
    expect(toparRedondeo(r, MR_BEAST, { venta30Base: 0, existenciaBase: 0, vieneBase: 0 }).motivo).toBe('sin_medir');
    expect(toparRedondeo(r, MR_BEAST, { venta30Base: 9000, existenciaBase: 0, vieneBase: 0, noConfiable: true }).motivo).toBe('sin_medir');
    expect(diasDeCobertura({ venta30Base: 0, existenciaBase: 5, vieneBase: 0 })).toBeNull();
  });

  it('lo que ya cabía no se toca, y el tope nunca sube una cantidad', () => {
    const r = redondearPedido(360, MR_BEAST);             // 2 cajas
    const t = toparRedondeo(r, MR_BEAST, { venta30Base: 16051, existenciaBase: 0, vieneBase: 0 });
    expect(t.motivo).toBeNull();
    expect(t.redondeo).toBe(r);
  });

  it('una sola unidad (granel sin caja): kilos enteros que caben', () => {
    const kg: EscaleraUnidades = { unit_base: 'KG', u2_label: null, u3_label: null, f2: null, f3: null, is_weight: true };
    const t = toparRedondeo(redondearPedido(50, kg), kg, { venta30Base: 30.4, existenciaBase: 10, vieneBase: 0 });
    // caben 30.4 × 45 ÷ 30.4 − 10 = 35 kg
    expect(t.redondeo).toMatchObject({ cantidad: 35, cantidad_base: 35 });
  });
});

describe('[AB.40] armarRenglon aplica el motor único', () => {
  const entrada = (p: Partial<EntradaRenglon> = {}): EntradaRenglon => ({
    product_id: 'p', sku: '97245', nombre: 'MR BEAST', venta_30d: 89.2, existencia: 0, objetivo: 143.6, falta: 143.6,
    falta_base: 25848, caja_factor: 180, costo_base: 11.57, rung_veredicto: null, posicion: 'bajo_minimo', viene: null,
    planeado_compras: 0, pedido_sucursal: 0, escalera: MR_BEAST, ajuste: null,
    surte: { tipo: 'matriz', clave: '00', nombre: '00' }, venta_30d_base: 16051, existencia_base: 1, ...p,
  });

  it('el renglón de la captura sale topado a 131 cajas, con su porqué', () => {
    const { linea } = armarRenglon(entrada());
    expect(linea.a_pedir).toMatchObject({ cantidad: 131, regla: 'cajas' });
    expect(linea.tope).toMatchObject({ motivo: 'recortado', antes_base: 25920 });
    expect(linea.valor).toBeCloseTo(23580 * 11.57, 2);
  });

  it('sin venta en base (un servidor anterior) no se topa: sale lo de antes', () => {
    const { linea } = armarRenglon(entrada({ venta_30d_base: undefined }));
    expect(linea.a_pedir.cantidad).toBe(144);
    expect(linea.tope?.motivo).toBe('sin_medir');
  });

  it('⛔ con la unidad en duda no se pide (como /compras/pedido), y lo dice', () => {
    const { linea } = armarRenglon(entrada({ rung_veredicto: 'contradice' }));
    expect(linea.a_pedir.cantidad).toBe(0);
    expect(linea.tope?.motivo).toBe('unidad_dudosa');
    expect(linea.valor).toBeNull();
  });

  it('lo que ya viene cuenta para el tope', () => {
    // Ya vienen 5,000 pz: neta 20,848 → 116 cajas (20,880); cabe 23,758.7 − 5,000 = 18,758.7 → 104 cajas
    const { linea } = armarRenglon(entrada({ viene: { ya: 5000, atorado: 0, negado: 0, camino: 0 } }));
    expect(linea.a_pedir).toMatchObject({ cantidad: 104, cantidad_base: 18720 });
    expect(linea.tope?.motivo).toBe('recortado');
  });
});
