/**
 * CG.14 — Pruebas unitarias de la lógica de la captura de Caja General (ADR-070).
 *
 * Lo que se prueba acá es lo que hace que la pantalla NO mienta:
 *   · que "no se contó" no se vea igual que "cuadra";
 *   · que no deje mandar algo que el servidor va a rechazar;
 *   · que un campo PROPUESTO nunca se pinte como un hecho.
 */
import {
  sumaDesglose, redondea, estadoArqueo, motivosDeBloqueo, puedeGuardar,
  etiquetaProcedencia, textoCobertura, DENOMINACIONES, GLOSA_MIN,
  type FormularioCaja,
} from './caja-captura.util';

const formOk = (o: Partial<FormularioCaja> = {}): FormularioCaja => ({
  tipo: 'gasto', fecha: '2026-09-18', sucursal: '00',
  kepler_cuenta: '601-001', kepler_concepto: '001',
  glosa: 'Compra de papeleria', monto: 100, ...o,
});

describe('DENOMINACIONES', () => {
  it('son las 14 de la operación, sin la morralla (que va en su campo)', () => {
    expect(DENOMINACIONES).toHaveLength(14);
    expect(DENOMINACIONES[0]).toBe(1000);
    expect(DENOMINACIONES[DENOMINACIONES.length - 1]).toBe(0.05);
  });
});

describe('sumaDesglose / redondea', () => {
  it('suma denominación × piezas más la morralla', () => {
    expect(sumaDesglose([{ denominacion: 1000, piezas: 1 }, { denominacion: 100, piezas: 2 }], 4.56)).toBe(1204.56);
  });
  it('ignora renglones en 0 piezas: teclear 0 es no haberlo capturado', () => {
    expect(sumaDesglose([{ denominacion: 500, piezas: 0 }, { denominacion: 100, piezas: 1 }])).toBe(100);
  });
  it('null/vacío dan 0 sin reventar', () => {
    expect(sumaDesglose(null)).toBe(0);
    expect(sumaDesglose([])).toBe(0);
  });
  it('el redondeo a centavos evita descuadres de punto flotante', () => {
    // sin redondeo esto da 0.30000000000000004 y se vería como diferencia
    expect(redondea(0.1 + 0.2)).toBe(0.3);
    expect(sumaDesglose([{ denominacion: 0.1, piezas: 1 }, { denominacion: 0.2, piezas: 1 }])).toBe(0.3);
  });
});

describe('estadoArqueo — "no se contó" NO es "cuadra"', () => {
  it('[negativa] sin desglose devuelve sin_desglose, no cuadra', () => {
    const r = estadoArqueo(1000, [], 0);
    expect(r.estado).toBe('sin_desglose');
    expect(r.estado).not.toBe('cuadra');
  });
  it('un desglose que suma el monto cuadra', () => {
    const r = estadoArqueo(1234.56, [
      { denominacion: 1000, piezas: 1 }, { denominacion: 100, piezas: 2 }, { denominacion: 10, piezas: 3 },
    ], 4.56);
    expect(r.estado).toBe('cuadra');
    expect(r.diferencia).toBe(0);
  });
  it('[negativa] un desglose que no llega al monto difiere, y dice por cuánto', () => {
    const r = estadoArqueo(1000, [{ denominacion: 500, piezas: 1 }]);
    expect(r.estado).toBe('difiere');
    expect(r.diferencia).toBe(-500);
  });
  it('el signo distingue sobrante de faltante', () => {
    expect(estadoArqueo(100, [{ denominacion: 200, piezas: 1 }]).diferencia).toBe(100);
    expect(estadoArqueo(200, [{ denominacion: 100, piezas: 1 }]).diferencia).toBe(-100);
  });
  it('sólo morralla ya es un desglose: se contó algo', () => {
    expect(estadoArqueo(5, [], 5).estado).toBe('cuadra');
  });
  it('un centavo de diferencia se tolera; dos no', () => {
    expect(estadoArqueo(100, [{ denominacion: 100, piezas: 1 }], 0.004).estado).toBe('cuadra');
    expect(estadoArqueo(100, [{ denominacion: 100, piezas: 1 }], 0.05).estado).toBe('difiere');
  });
});

describe('motivosDeBloqueo — la pantalla frena lo mismo que el servidor', () => {
  it('un formulario completo no tiene motivos', () => {
    expect(motivosDeBloqueo(formOk())).toEqual([]);
    expect(puedeGuardar(formOk())).toBe(true);
  });

  it('[negativa] sin cuenta Y concepto no se puede guardar — media cuenta no contabiliza', () => {
    expect(motivosDeBloqueo(formOk({ kepler_concepto: null }))).toContain('falta_concepto');
    expect(motivosDeBloqueo(formOk({ kepler_cuenta: null }))).toContain('falta_concepto');
  });

  it('[negativa] la glosa corta frena — es el defecto de los 2,387 movimientos sin concepto', () => {
    expect(motivosDeBloqueo(formOk({ glosa: 'x' }))).toContain('glosa_corta');
    expect(motivosDeBloqueo(formOk({ glosa: '     ' }))).toContain('glosa_corta');
    expect(motivosDeBloqueo(formOk({ glosa: 'a'.repeat(GLOSA_MIN) }))).not.toContain('glosa_corta');
  });

  it('[negativa] monto cero o negativo frena', () => {
    expect(motivosDeBloqueo(formOk({ monto: 0 }))).toContain('monto_invalido');
    expect(motivosDeBloqueo(formOk({ monto: -5 }))).toContain('monto_invalido');
  });

  it('[negativa] un arqueo que no cuadra frena ANTES de mandar', () => {
    const f = formOk({ monto: 1000, denominaciones: [{ denominacion: 500, piezas: 1 }] });
    expect(motivosDeBloqueo(f)).toContain('arqueo_no_cuadra');
    expect(puedeGuardar(f)).toBe(false);
  });

  it('sin desglose NO frena: el arqueo es opcional, lo que no puede es estar mal', () => {
    expect(motivosDeBloqueo(formOk({ denominaciones: [] }))).not.toContain('arqueo_no_cuadra');
  });

  it('devuelve TODOS los motivos, no el primero', () => {
    const m = motivosDeBloqueo({ glosa: 'x', monto: 0 });
    expect(m).toEqual(expect.arrayContaining([
      'falta_tipo', 'falta_fecha', 'falta_sucursal', 'falta_concepto', 'glosa_corta', 'monto_invalido',
    ]));
    expect(m.length).toBeGreaterThanOrEqual(6);
  });
});

describe('etiquetaProcedencia — un campo propuesto NUNCA se pinta como un hecho', () => {
  it('con soporte, muestra cuántos antecedentes lo respaldan', () => {
    const e = etiquetaProcedencia({ value: { a: 1 }, source: 'aprendido', confidence: 0.94, support: 47, supportRatio: 0.94 });
    expect(e.tono).toBe('propuesto');
    expect(e.texto).toContain('47 antecedentes');
    expect(e.texto).toContain('94%');
  });

  it('sin soporte, igual declara la fuente', () => {
    const e = etiquetaProcedencia({ value: 'x', source: 'documento', confidence: 1 });
    expect(e.tono).toBe('propuesto');
    expect(e.texto).toContain('del documento');
  });

  it('[negativa] un valor sin fuente declarada NO se presenta como confiable', () => {
    const e = etiquetaProcedencia({ value: 'x', source: null, confidence: null });
    expect(e.texto).toContain('no declarado');
  });

  it('[negativa] sin propuesta muestra el MOTIVO, que es lo que el humano necesita', () => {
    expect(etiquetaProcedencia({ value: null, source: null, confidence: null, reason: 'empate' }).texto)
      .toContain('repartidos');
    expect(etiquetaProcedencia({ value: null, source: null, confidence: null, reason: 'soporte_insuficiente' }).texto)
      .toContain('pocos antecedentes');
    expect(etiquetaProcedencia({ value: null, source: null, confidence: null, reason: 'empate' }).tono).toBe('vacio');
  });

  it('[negativa] un motivo desconocido se declara, no se inventa una explicación', () => {
    const e = etiquetaProcedencia({ value: null, source: null, confidence: null, reason: 'motivo_que_no_existe' });
    expect(e.tono).toBe('vacio');
    expect(e.texto).toBe('Sin propuesta: capturalo a mano.');
  });

  it('null/undefined no revientan la pantalla', () => {
    expect(etiquetaProcedencia(null).tono).toBe('vacio');
    expect(etiquetaProcedencia(undefined).tono).toBe('vacio');
  });
});

describe('textoCobertura — "0 conceptos" no puede leerse igual que "sin medir"', () => {
  it('con datos, dice cuántos conceptos hay y cuántos quedaron fuera', () => {
    const t = textoCobertura([{ usables: 2227, filas_origen: 2320, sin_subcuenta: 61 }]);
    expect(t).toContain('2,227');
    expect(t).toContain('61 sin subcuenta');
  });

  it('[negativa] catálogo VACÍO avisa que revisen el carril, no dice "no hay conceptos"', () => {
    const t = textoCobertura([{ usables: 0, filas_origen: 0, sin_subcuenta: 0 }]);
    expect(t).toContain('VACÍO');
    expect(t).toContain('carril del ODS');
  });

  it('[negativa] sin filas dice "sin medir", que no es lo mismo que cero', () => {
    expect(textoCobertura([])).toContain('sin medir');
    expect(textoCobertura(null)).toContain('sin medir');
  });

  it('suma varias sucursales', () => {
    const t = textoCobertura([
      { usables: 100, filas_origen: 110, sin_subcuenta: 10 },
      { usables: 200, filas_origen: 210, sin_subcuenta: 10 },
    ]);
    expect(t).toContain('300');
    expect(t).toContain('20 sin subcuenta');
  });
});
