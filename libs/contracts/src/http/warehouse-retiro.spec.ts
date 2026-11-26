import {
  describeAlcance,
  planDeRetiro,
  veredictoDeBorrado,
  type UsoUbicacion,
} from './warehouse-retiro.contract';

/**
 * `[UB.PL.9]` Quitar ubicaciones. **Retirar** y **borrar** son dos actos distintos: el mueble que
 * existió queda en baja con su motivo y no se borra nunca (fase UB §7); la captura equivocada sí se
 * borra, pero **sólo si nunca se usó**.
 *
 * Medido en prod el 2026-11-26: tres tablas apuntan a `warehouse_bins` —`stock_lot_locations` y
 * `bin_assignments` con RESTRICT, y `cart_occupations`—, así que borrar algo usado revienta en la
 * base de todas formas. Esto lo convierte en una frase antes de intentarlo. En Padre Hidalgo, 310
 * de 315 ubicaciones no las usó nadie y 5 tienen producto asignado.
 */

const uso = (p: Partial<UsoUbicacion>): UsoUbicacion => ({
  id: 'x', code: 'TA011', estado: 'activa', productos: 0, renglones: 0, ocupaciones: 0, ...p,
});

describe('[UB.PL.9] qué se puede borrar', () => {
  it('⭐ una ubicación que no usó nadie se puede borrar', () => {
    expect(veredictoDeBorrado(uso({}))).toEqual({ code: 'TA011', borrable: true, motivo: null });
  });

  it('⛔ NEGATIVA: con un producto asignado NO se borra, y el motivo lo dice en palabras', () => {
    const v = veredictoDeBorrado(uso({ productos: 3 }));
    expect(v.borrable).toBe(false);
    expect(v.motivo).toBe('TA011 tiene 3 productos con lugar aquí: se retira, no se borra.');
  });

  it('⛔ NEGATIVA: un renglón de mercancía EN CERO tampoco deja borrar — el acomodo pasó por ahí', () => {
    expect(veredictoDeBorrado(uso({ renglones: 1 })).borrable).toBe(false);
  });

  it('⛔ NEGATIVA: una carreta que la nombra tampoco', () => {
    expect(veredictoDeBorrado(uso({ ocupaciones: 2 })).borrable).toBe(false);
  });

  it('con varias razones, el motivo las une como una frase y no como una lista de campos', () => {
    expect(veredictoDeBorrado(uso({ productos: 1, renglones: 2, ocupaciones: 1 })).motivo)
      .toBe('TA011 tiene 1 producto con lugar aquí, 2 renglones de mercancía y 1 carreta: se retira, no se borra.');
  });

  it('el singular y el plural están cuidados: nadie lee «1 productos»', () => {
    expect(veredictoDeBorrado(uso({ productos: 1 })).motivo).toContain('1 producto con lugar');
    expect(veredictoDeBorrado(uso({ renglones: 1 })).motivo).toContain('1 renglón de mercancía');
  });
});

describe('[UB.PL.9] el plan, antes de tocar nada', () => {
  const lote = [uso({ code: 'TA011' }), uso({ code: 'TA012', productos: 2 }), uso({ code: 'TA013' })];

  it('⭐ borrar: se borra lo que se puede y se DICE lo que no, con su motivo', () => {
    const p = planDeRetiro(lote, 'borrar');
    expect(p.total).toBe(3);
    expect(p.se_borran).toBe(2);
    expect(p.bloqueadas.map((b) => b.code)).toEqual(['TA012']);
    expect(p.bloqueadas[0].motivo).toContain('se retira, no se borra');
  });

  it('⭐ NEGATIVA: una ubicación con uso NO cancela el lote entero (parcial se reporta parcial)', () => {
    expect(planDeRetiro(lote, 'borrar').se_borran).toBeGreaterThan(0);
  });

  it('⭐ retirar vale para TODAS: tener uso impide borrar, no dar de baja', () => {
    const p = planDeRetiro(lote, 'retirar');
    expect(p.se_retiran).toBe(3);
    expect(p.se_borran).toBe(0);
    expect(p.bloqueadas).toEqual([]);
  });

  it('retirar no cuenta dos veces lo que ya estaba de baja', () => {
    expect(planDeRetiro([uso({ estado: 'baja' }), uso({ code: 'TA012' })], 'retirar').se_retiran).toBe(1);
  });

  it('un lote vacío es un plan vacío, no un error', () => {
    expect(planDeRetiro([], 'borrar')).toMatchObject({ total: 0, se_borran: 0, bloqueadas: [] });
  });

  it('⭐ el caso real de Padre Hidalgo: 310 sin uso y 5 con producto', () => {
    const ph = [
      ...Array.from({ length: 310 }, (_, i) => uso({ code: `TA${i}` })),
      ...Array.from({ length: 5 }, (_, i) => uso({ code: `TB${i}`, productos: 1 })),
    ];
    const p = planDeRetiro(ph, 'borrar');
    expect(p.se_borran).toBe(310);
    expect(p.bloqueadas).toHaveLength(5);
  });
});

describe('[UB.PL.9] la pregunta de confirmación se lee en palabras de la tienda', () => {
  it('cada alcance se dice como lo diría una persona', () => {
    expect(describeAlcance({ que: 'nivel', code: 'TA011' })).toBe('la ubicación TA011');
    expect(describeAlcance({ que: 'rack', zona: 'T', pasillo: 'A', rack: 5 })).toBe('el rack A05 completo');
    expect(describeAlcance({ que: 'pasillo', zona: 'T', pasillo: 'A' })).toBe('el pasillo A completo');
    expect(describeAlcance({ que: 'pieza', fixture_id: 'x' })).toBe('esta pieza completa');
  });
});
