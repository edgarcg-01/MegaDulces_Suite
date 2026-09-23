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
  etiquetaProcedencia, textoCobertura, BILLETES_CAJA, seleccionarBilletes, GLOSA_MIN,
  puedeAutorizarUI, puedeCerrarUI, textoSaldo,
  type FormularioCaja, type CorteVista,
} from './caja-captura.util';
import { BILLETES_MXN } from '@megadulces/contracts';

// Con el desglose obligatorio (CG.23), un formulario "completo" incluye el conteo: el monto
// SALE de ahí. Antes esto tenía `monto: 100` y ningún desglose — que es justo el estado que
// ahora frena, y por eso el `formOk` viejo habría dejado la suite verde sobre la regla vieja.
const formOk = (o: Partial<FormularioCaja> = {}): FormularioCaja => ({
  tipo: 'gasto', fecha: '2026-09-18', sucursal: '00',
  kepler_cuenta: '601-001', kepler_concepto: '001',
  glosa: 'Compra de papeleria', monto: 100,
  denominaciones: [{ denominacion: 100, piezas: 1 }], ...o,
});

describe('BILLETES_CAJA — los cinco que la caja cuenta, salidos del catálogo compartido', () => {
  it('son 500, 200, 100, 50 y 20, del mayor al menor', () => {
    expect(BILLETES_CAJA.map((b) => b.valor)).toEqual([500, 200, 100, 50, 20]);
  });

  it('no son una lista propia: cada uno es el objeto del catálogo de @megadulces/contracts', () => {
    // Identidad, no igualdad: si alguien reconstruyera la lista a mano acá, esto se pondría rojo.
    for (const b of BILLETES_CAJA) {
      expect(BILLETES_MXN).toContain(b);
    }
  });

  it('la caja NO desglosa monedas: todas son billetes (el metal va en Morralla)', () => {
    expect(BILLETES_CAJA.every((b) => b.familia === 'billete')).toBe(true);
  });

  it('[negativa] una llave que el catálogo compartido no tiene revienta al construirse', () => {
    // El valor de esta compuerta: si mañana alguien renombra una llave en `contracts`, la caja
    // deja de OFRECER ese billete. Un billete que desaparece de la reja es dinero que no se
    // puede contar, y eso no puede pasar en silencio.
    expect(() => seleccionarBilletes(['500', '999'])).toThrow(/999/);
  });

  it('[negativa] una MONEDA no se puede colar como billete', () => {
    expect(() => seleccionarBilletes(['20m'])).toThrow(/moneda/);
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

  it('[negativa] CG.23 — sin desglose ahora SÍ frena: el arqueo dejó de ser opcional', () => {
    // Esta prueba decía lo contrario ("sin desglose NO frena: el arqueo es opcional") y era
    // cierta: el desglose vivía plegado en un <details> rotulado "(opcional)", así que el
    // camino fácil era registrar efectivo sin contarlo. Decisión de Edgar: no es opcional.
    const f = formOk({ denominaciones: [], morralla: 0 });
    expect(motivosDeBloqueo(f)).toContain('falta_desglose');
    expect(puedeGuardar(f)).toBe(false);
  });

  it('sólo morralla ya cuenta como desglose: no todo movimiento trae billetes', () => {
    const f = formOk({ monto: 7.5, denominaciones: [], morralla: 7.5 });
    expect(motivosDeBloqueo(f)).not.toContain('falta_desglose');
    expect(puedeGuardar(f)).toBe(true);
  });

  it('"no contó" y "monto en cero" se dicen UNA vez, con el texto que sirve', () => {
    // Sin desglose el monto es 0 por construcción, así que publicar los dos motivos sería
    // decir dos veces lo mismo y ninguno de los dos diría qué hacer.
    const m = motivosDeBloqueo(formOk({ monto: 0, denominaciones: [], morralla: 0 }));
    expect(m).toContain('falta_desglose');
    expect(m).not.toContain('monto_invalido');
  });

  it('devuelve TODOS los motivos, no el primero', () => {
    const m = motivosDeBloqueo({ glosa: 'x', monto: 0 });
    expect(m).toEqual(expect.arrayContaining([
      'falta_tipo', 'falta_fecha', 'falta_sucursal', 'falta_concepto', 'glosa_corta', 'falta_desglose',
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

// ── CG.15 · el corte ───────────────────────────────────────────────────────────────────

const corteCerrado: CorteVista = {
  id: 'c1', folio: 'CC-2026-00001', estado: 'cerrado',
  closed_by: 'u-capturista', closed_by_username: 'karmen',
};

describe('puedeAutorizarUI — la doble llave en el botón', () => {
  it('otra persona puede, y el texto dice quién cerró', () => {
    const r = puedeAutorizarUI(corteCerrado, 'u-gerente');
    expect(r.ok).toBe(true);
    expect(r.texto).toContain('karmen');
  });
  it('[negativa] quien cerró NO puede, y el texto se lo explica', () => {
    const r = puedeAutorizarUI(corteCerrado, 'u-capturista');
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('otra persona');
  });
  it('[negativa] un borrador no se autoriza', () => {
    expect(puedeAutorizarUI({ ...corteCerrado, estado: 'borrador' }, 'u-gerente').ok).toBe(false);
  });
  it('[negativa] uno ya autorizado dice quién lo hizo', () => {
    const r = puedeAutorizarUI({ ...corteCerrado, estado: 'autorizado', authorized_by_username: 'gerente' }, 'u-x');
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('gerente');
  });
  it('[negativa] sin corte o sin usuario, no', () => {
    expect(puedeAutorizarUI(null, 'u1').ok).toBe(false);
    expect(puedeAutorizarUI(corteCerrado, null).ok).toBe(false);
  });
});

describe('puedeCerrarUI', () => {
  const borrador: CorteVista = { id: 'c', folio: 'CC-2026-00002', estado: 'borrador' };
  it('[negativa] sin contar no se cierra', () => {
    expect(puedeCerrarUI(borrador, 'sin_contar').ok).toBe(false);
  });
  it('se cierra aunque NO cuadre — el faltante se registra, no se esconde', () => {
    const r = puedeCerrarUI(borrador, 'falta');
    expect(r.ok).toBe(true);
    expect(r.texto).toContain('queda registrada');
  });
  it('[negativa] uno ya cerrado no se re-cierra', () => {
    expect(puedeCerrarUI(corteCerrado, 'cuadra').ok).toBe(false);
  });
});

describe('textoSaldo — null NO es cero', () => {
  it('[negativa] sin corte abierto lo DECLARA, no dibuja $0.00', () => {
    const t = textoSaldo({ saldo: null, sin_corte_abierto: true });
    expect(t).toContain('sin corte abierto');
    expect(t).not.toContain('0.00');
  });
  it('con corte abierto muestra el monto y el folio', () => {
    const t = textoSaldo({ saldo: 1300, sin_corte_abierto: false, corte_abierto: { folio: 'CC-2026-00001' } });
    expect(t).toContain('1,300');
    expect(t).toContain('CC-2026-00001');
  });
  it('[negativa] sin respuesta dice "sin medir", que no es lo mismo que cero', () => {
    expect(textoSaldo(null)).toContain('sin medir');
  });
});
