import {
  alcanceDelRenglon, partirCaptura, escaleraDeCaptura, unidadesDeCaptura, propuestaDelRenglon, unidadDeCaptura, fallaDeOrigen,
  type RenglonCaptura,
} from './autoabasto-captura.contract';
import { DIAS_POR_MES } from './cantidad-pedido.contract';
import type { EscaleraUnidades } from './autoabasto-pedido.contract';

/**
 * `[AB.PM.2]` — **El alcance en días del pedido a mano, con la cuenta de Pedido de Compras.**
 *
 * Los controles son renglones REALES de Morelia Madero (07), leídos de `analytics.replenishment_plan`
 * en `pg-prod`, sólo lectura, el 2026-11-26: venta diaria en unidad base (× 30.4 = venta de 30 días),
 * existencia y lo que ya viene. La unidad se probó contra un hecho independiente: los 10 «en tránsito»
 * de 07212 son los 10 PAQ del pedido 0001700 de Morelia Abastos, que ese día iba en checado.
 */
const venta30 = (diaria: number) => diaria * DIAS_POR_MES;

describe('[AB.PM.2] alcanceDelRenglon: hoy → con lo que pides', () => {
  it('07212: lo que ya viene CUENTA — 8 + 10 que viene + 10 que pide → 31 días (hoy 20)', () => {
    const a = alcanceDelRenglon({ venta30Base: venta30(0.903), existenciaBase: 8, vieneBase: 10, pedidoBase: 10, almacenCode: '07' });
    expect(a.estado).toBe('medible');
    expect(Math.round(a.con_pedido as number)).toBe(31);
    expect(Math.round(a.hoy as number)).toBe(20);
    expect(a.pasa_tope).toBe(false);
  });

  it('07213: 5.5 + 10 → 19 días (hoy 7)', () => {
    const a = alcanceDelRenglon({ venta30Base: venta30(0.809), existenciaBase: 5.5, vieneBase: 0, pedidoBase: 10, almacenCode: '07' });
    expect(Math.round(a.con_pedido as number)).toBe(19);
    expect(Math.round(a.hoy as number)).toBe(7);
  });

  it('⭐ 28022: 77 + una caja de 30 → 47 días, PASA el tope de 45 (se dice, no se bloquea)', () => {
    const a = alcanceDelRenglon({ venta30Base: venta30(2.272), existenciaBase: 77, vieneBase: 0, pedidoBase: 30, almacenCode: '07' });
    expect(Math.round(a.con_pedido as number)).toBe(47);
    expect(Math.round(a.hoy as number)).toBe(34);
    expect(a.pasa_tope).toBe(true);
    expect(a.tope).toBe(45);
  });

  it('⛔ 28002 sin venta en 30 días: NO se mide — null, nunca 0, y no «pasa» ningún tope', () => {
    const a = alcanceDelRenglon({ venta30Base: 0, existenciaBase: 1, vieneBase: 0, pedidoBase: 18, almacenCode: '07' });
    expect(a.estado).toBe('sin_venta');
    expect(a.hoy).toBeNull();
    expect(a.con_pedido).toBeNull();
    expect(a.pasa_tope).toBe(false);
  });

  it('venta nula (no medida) es lo mismo que sin venta', () => {
    expect(alcanceDelRenglon({ venta30Base: null, existenciaBase: 3, vieneBase: 0, pedidoBase: 1 }).estado).toBe('sin_venta');
  });

  it('⛔ unidad contradicha: no_confiable, aunque haya venta', () => {
    const a = alcanceDelRenglon({ venta30Base: 30, existenciaBase: 10, vieneBase: 0, pedidoBase: 5, noConfiable: true });
    expect(a.estado).toBe('no_confiable');
    expect(a.con_pedido).toBeNull();
    expect(a.pasa_tope).toBe(false);
  });

  it('⛔ el tope es «más de 45»: quedar en 45 exactos NO lo pasa; un poco más, sí', () => {
    const base = { venta30Base: DIAS_POR_MES, existenciaBase: 45, vieneBase: 0, almacenCode: '07' }; // 1 al día
    expect(alcanceDelRenglon({ ...base, pedidoBase: 0 }).pasa_tope).toBe(false);
    expect(alcanceDelRenglon({ ...base, pedidoBase: 0.5 }).pasa_tope).toBe(true);
  });

  it('el objetivo es la cobertura de la mesa del almacén: 07 pide para 21 días, 08 para 30', () => {
    const e = { venta30Base: 30, existenciaBase: 0, vieneBase: 0, pedidoBase: 0 };
    expect(alcanceDelRenglon({ ...e, almacenCode: '07' }).objetivo).toBe(21);
    expect(alcanceDelRenglon({ ...e, almacenCode: '08' }).objetivo).toBe(30);
  });

  it('una cantidad negativa o basura se trata como cero (no resta días)', () => {
    const a = alcanceDelRenglon({ venta30Base: DIAS_POR_MES, existenciaBase: 10, vieneBase: 0, pedidoBase: -5 });
    expect(a.con_pedido).toBe(a.hoy);
  });
});

describe('[AB.PM.2] partirCaptura: un documento por sucursal origen, Compras aparte', () => {
  const r = (product_id: string, code: string | null, cantidad_base: number): RenglonCaptura => ({
    product_id, cantidad_base, destino: code ? { tipo: 'sucursal', code } : { tipo: 'compras' },
  });

  it('⭐ los renglones de la maqueta: 4 a Morelia Abastos, 1 a Padre Hidalgo, 1 a Compras', () => {
    const p = partirCaptura([
      r('07212', '08', 10), r('07213', '08', 10), r('28066', '01', 18), r('33241', '08', 5), r('28022', '08', 30), r('28002', null, 18),
    ], '07');
    expect(p.grupos.map((g) => (g.destino.tipo === 'sucursal' ? g.destino.code : 'compras'))).toEqual(['08', '01', 'compras']);
    expect(p.grupos[0].renglones).toHaveLength(4);
    expect(p.grupos[0].total_base).toBe(55);
    expect(p.grupos[1].total_base).toBe(18);
    expect(p.descartados).toEqual([]);
  });

  it('⛔ el grupo de Compras NO sale hasta que se confirme la ruta ([AB.NI.11]); los de sucursal sí', () => {
    const p = partirCaptura([r('a', '08', 1), r('b', null, 1)], '07');
    expect(p.grupos.find((g) => g.destino.tipo === 'sucursal')?.enviable).toBe(true);
    const compras = p.grupos.find((g) => g.destino.tipo === 'compras');
    expect(compras?.enviable).toBe(false);
    expect(compras?.motivo).toMatch(/Ruta por confirmar/);
  });

  it('⛔ Compras va siempre al final, aunque tenga más renglones', () => {
    const p = partirCaptura([r('a', null, 1), r('b', null, 1), r('c', null, 1), r('d', '08', 1)], '07');
    expect(p.grupos.map((g) => g.destino.tipo)).toEqual(['sucursal', 'compras']);
  });

  it('⛔ pedirle a la propia sucursal se descarta con su motivo; un renglón en cero no viaja', () => {
    const p = partirCaptura([r('a', '07', 5), r('b', '08', 0), r('c', '08', 2)], '07');
    expect(p.descartados).toEqual([{ product_id: 'a', motivo: 'No se le puede pedir a la propia sucursal.' }]);
    expect(p.grupos).toHaveLength(1);
    expect(p.grupos[0].renglones.map((x) => x.product_id)).toEqual(['c']);
  });

  it('el código con espacios se normaliza: «08 » y «08» son el mismo documento', () => {
    const p = partirCaptura([r('a', '08 ', 1), r('b', '08', 1)], '07');
    expect(p.grupos).toHaveLength(1);
  });
});

describe('[AB.PM.4] fallaDeOrigen: a quién se le puede pedir (R6)', () => {
  const W = { id: 'w-08', active: true, kind: 'central', kepler_code: '08' };
  it('una sucursal activa, con Kepler y que no es la propia, sirve', () => {
    expect(fallaDeOrigen(W, 'w-07')).toBeNull();
  });
  it.each([
    ['no existe', null, 'no_existe'],
    ['inactiva', { ...W, active: false }, 'inactivo'],
    ['camión de ruta', { ...W, kind: 'truck' }, 'es_camion'],
    ['sin Kepler', { ...W, kepler_code: '  ' }, 'sin_kepler'],
    ['la propia', { ...W, id: 'w-07' }, 'es_el_mismo'],
  ] as const)('⛔ %s → %s', (_q, w, esperado) => {
    expect(fallaDeOrigen(w, 'w-07')).toBe(esperado);
  });
  it('el orden es el de lectura: un camión inactivo dice «inactivo» primero', () => {
    expect(fallaDeOrigen({ ...W, active: false, kind: 'truck' }, 'w-07')).toBe('inactivo');
  });
});

/**
 * `[AB.PM.3]` R8 (a) y (b) — **en qué unidades se captura y qué se propone**, con las reglas de Pedido.
 *
 * Escaleras REALES de `analytics.mv_product_unit_ladder` (`pg-prod`, sólo lectura, 2026-11-26): esa
 * vista guarda el factor EXACTO de Kepler (`kdii.c81`/`c84`), y 8 de sus 9,641 escaleras lo traen con
 * decimales — el bulto 95579 de 19.75 KG y la caja 97235 de 10.80 KG, los mismos de `[COT.45]`.
 */
const esc = (e: Partial<EscaleraUnidades>): EscaleraUnidades =>
  ({ unit_base: null, u2_label: null, u3_label: null, f2: null, f3: null, is_weight: false, ...e });
const E28022 = esc({ unit_base: 'PAQ', u2_label: 'PAQ', u3_label: 'CJA', f3: 30 });
const E07212 = esc({ unit_base: 'PAQ', u2_label: 'PAQ', u3_label: 'PAQ' });
const E95579 = esc({ unit_base: 'KG', u2_label: 'KG', u3_label: 'BTO', f3: 19.75, is_weight: true });
const E97235 = esc({ unit_base: 'KG', u2_label: 'CJA', f2: 10.8, is_weight: true });
const TRES = esc({ unit_base: 'PZA', u2_label: 'PAQ', f2: 10, u3_label: 'CJA', f3: 120 });

describe('[AB.PM.3] R8 (a): sólo se captura en presentaciones de unidades base ENTERAS', () => {
  it('28022: caja de 30 y el paquete suelto', () => {
    expect(unidadesDeCaptura(E28022)).toEqual([{ unidad: 'CJA', factor: 30 }, { unidad: 'PAQ', factor: 1 }]);
  });

  it('07212: sólo tiene su unidad base (los peldaños repiten PAQ sin factor)', () => {
    expect(unidadesDeCaptura(E07212)).toEqual([{ unidad: 'PAQ', factor: 1 }]);
  });

  it('⛔ 95579: el bulto de 19.75 KG NO se ofrece — sólo kilos enteros', () => {
    expect(unidadesDeCaptura(E95579)).toEqual([{ unidad: 'KG', factor: 1 }]);
  });

  it('⛔ 97235: la caja de 10.80 KG NO se ofrece', () => {
    expect(unidadesDeCaptura(E97235)).toEqual([{ unidad: 'KG', factor: 1 }]);
  });

  it('tres peldaños, de la mayor a la base', () => {
    expect(unidadesDeCaptura(TRES).map((u) => u.unidad)).toEqual(['CJA', 'PAQ', 'PZA']);
  });

  it('⛔ sin escalera de Kepler no hay en qué capturar: lista vacía, no una unidad inventada', () => {
    expect(unidadesDeCaptura(null)).toEqual([]);
    expect(unidadesDeCaptura(esc({}))).toEqual([]);
  });

  it('escaleraDeCaptura quita SÓLO el peldaño decimal y deja los demás', () => {
    expect(escaleraDeCaptura(E97235)).toMatchObject({ f2: null, f3: null, unit_base: 'KG' });
    expect(escaleraDeCaptura(TRES)).toMatchObject({ f2: 10, f3: 120 });
    expect(escaleraDeCaptura(null)).toBeNull();
  });

  it('unidadDeCaptura: el factor lo pone la escalera, no quien manda la unidad', () => {
    expect(unidadDeCaptura(E28022, 'cja')).toEqual({ unidad: 'CJA', factor: 30 });
    expect(unidadDeCaptura(E95579, 'BTO')).toBeNull();
    expect(unidadDeCaptura(E28022, 'PZA')).toBeNull();
  });
});

describe('[AB.PM.3] R8 (b): la propuesta es la regla de media caja sobre lo que falta para la cobertura', () => {
  it('28022 (07, 21 días): con 77 PAQ ya cubre 34 días — no se propone nada', () => {
    expect(propuestaDelRenglon({ venta30Base: venta30(2.272), existenciaBase: 77, vieneBase: 0, almacenCode: '07', escalera: E28022 })).toBeNull();
  });

  it('28022 sin existencia: faltan 47.7 PAQ para 21 días (1.6 cajas) → 2 cajas cerradas', () => {
    const p = propuestaDelRenglon({ venta30Base: venta30(2.272), existenciaBase: 0, vieneBase: 0, almacenCode: '07', escalera: E28022 });
    expect(p).toMatchObject({ regla: 'cajas', cantidad: 2, unidad: 'CJA', cantidad_base: 60 });
  });

  it('menos de media caja → la unidad menor, entera (la misma regla que Pedido)', () => {
    // faltan 10 PAQ de una caja de 30 (1/3 de caja) → 10 PAQ
    const p = propuestaDelRenglon({ venta30Base: 40 * DIAS_POR_MES / 21, existenciaBase: 30, vieneBase: 0, almacenCode: '07', escalera: E28022 });
    expect(p).toMatchObject({ regla: 'menor', unidad: 'PAQ', cantidad: 10, cantidad_base: 10 });
  });

  it('⭐ lo que ya viene se resta: 07212 con 8 + 10 que viene apenas le falta 1 PAQ', () => {
    const p = propuestaDelRenglon({ venta30Base: venta30(0.903), existenciaBase: 8, vieneBase: 10, almacenCode: '07', escalera: E07212 });
    expect(p).toMatchObject({ unidad: 'PAQ', cantidad: 1, cantidad_base: 1 });
  });

  it('⛔ 95579: la propuesta nunca sale en el bulto de 19.75 — en kilos enteros', () => {
    const p = propuestaDelRenglon({ venta30Base: 60 * DIAS_POR_MES / 21, existenciaBase: 0, vieneBase: 0, almacenCode: '07', escalera: E95579 });
    expect(p?.unidad).toBe('KG');
    expect(Number.isInteger(p?.cantidad_base)).toBe(true);
  });

  it('⛔ sin venta no se propone (no hay ritmo con qué medir lo que falta)', () => {
    expect(propuestaDelRenglon({ venta30Base: 0, existenciaBase: 0, vieneBase: 0, almacenCode: '07', escalera: E28022 })).toBeNull();
    expect(propuestaDelRenglon({ venta30Base: 30, existenciaBase: 0, vieneBase: 0, noConfiable: true, escalera: E28022 })).toBeNull();
  });

  it('⛔ sin escalera no se propone: no hay unidad en qué decirlo', () => {
    expect(propuestaDelRenglon({ venta30Base: 300, existenciaBase: 0, vieneBase: 0, almacenCode: '07', escalera: null })).toBeNull();
  });
});
