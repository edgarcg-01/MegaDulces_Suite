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
  puedeAutorizarUI, puedeCerrarUI, textoSaldo, TEXTO_BLOQUEO, MOTIVO_SIN_DOC_MIN,
  conflictoDeEsperado, pasoDelCorte, textoPaso, PASOS_CORTE, textoDeError, separarPorFlujo,
  GRUPOS_COLA, GRUPO_SIN_CLASIFICAR, grupoDe,
  type FormularioCaja, type CorteVista, type EstadoParaPaso,
} from './caja-captura.util';
import { BILLETES_MXN } from '@megadulces/contracts';

// Con el desglose obligatorio (CG.23), un formulario "completo" incluye el conteo: el monto
// SALE de ahí. Antes esto tenía `monto: 100` y ningún desglose — que es justo el estado que
// ahora frena, y por eso el `formOk` viejo habría dejado la suite verde sobre la regla vieja.
const formOk = (o: Partial<FormularioCaja> = {}): FormularioCaja => ({
  tipo: 'gasto', fecha: '2026-09-18', sucursal: '00',
  kepler_cuenta: '601-001', kepler_concepto: '001',
  glosa: 'Compra de papeleria', monto: 100,
  denominaciones: [{ denominacion: 100, piezas: 1 }],
  // `[CG.160]` El camino feliz es un movimiento ENLAZADO: así lo arma la pantalla al elegir de la
  // bandeja, y así lo exige el servidor desde `[CG.124]`. Sin esto el `formOk` describiría un
  // formulario que el servidor rechaza con 400, que es justo lo que esta regla vino a adelantar.
  origen_ref: '00|X-D-26|0023047|0011',
  ...o,
});

describe('BILLETES_CAJA — los seis que la caja cuenta, salidos del catálogo compartido', () => {
  it('son 1000, 500, 200, 100, 50 y 20, del mayor al menor', () => {
    expect(BILLETES_CAJA.map((b) => b.valor)).toEqual([1000, 500, 200, 100, 50, 20]);
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
    expect(motivosDeBloqueo(formOk({ kepler_concepto: null }))).toContain('falta_concepto_de_cuenta');
    expect(motivosDeBloqueo(formOk({ kepler_cuenta: null }))).toContain('falta_concepto');
  });

  it('[negativa] la glosa corta frena — es el defecto de los 2,387 movimientos sin concepto', () => {
    expect(motivosDeBloqueo(formOk({ glosa: 'x' }))).toContain('glosa_corta');
    expect(motivosDeBloqueo(formOk({ glosa: '     ' }))).toContain('glosa_corta');
    expect(motivosDeBloqueo(formOk({ glosa: 'a'.repeat(GLOSA_MIN) }))).not.toContain('glosa_corta');
  });

  /**
   * CG — El freno que faltaba, y que ya costó un movimiento real.
   *
   * El 2026-09-28 entró al libro `CG-2026-00002` con `fecha = 2026-12-10`: era el `X-D-26 0001298`
   * de Kepler, un gasto de ENERO ("GASTOS NF MORELIA 28-01-2026") mal fechado en el ERP. La bandeja
   * lo rotulaba desde el 22-sep con "fecha posterior a hoy", pero el rótulo no frenaba nada.
   * Consecuencia medida en prod: el filtro por default del libro mostraba **1 de los 2**
   * movimientos que había.
   *
   * El día se pasa SIEMPRE explícito: una prueba de fechas que lea el reloj se pone verde o roja
   * según cuándo se corra, y eso no es una prueba.
   */
  const HOY = '2026-09-29';

  it('[negativa] una fecha POSTERIOR a hoy frena — es el caso de CG-2026-00002', () => {
    const f = formOk({ fecha: '2026-12-10' });
    expect(motivosDeBloqueo(f, HOY)).toContain('fecha_futura');
    expect(puedeGuardar(f, HOY)).toBe(false);
  });

  it('hoy y el pasado NO frenan: corregir hacia atrás es legítimo, hacia adelante no', () => {
    expect(motivosDeBloqueo(formOk({ fecha: HOY }), HOY)).not.toContain('fecha_futura');
    expect(motivosDeBloqueo(formOk({ fecha: '2026-01-28' }), HOY)).not.toContain('fecha_futura');
    expect(puedeGuardar(formOk({ fecha: HOY }), HOY)).toBe(true);
  });

  it('sin fecha el motivo es "falta_fecha", no "fecha_futura" — son dos problemas distintos', () => {
    const m = motivosDeBloqueo(formOk({ fecha: null }), HOY);
    expect(m).toContain('falta_fecha');
    expect(m).not.toContain('fecha_futura');
  });

  it('sin `hoy` el motivo NO se evalúa — por eso el candado que manda vive en el servidor', () => {
    // Documenta el límite a propósito: si un llamador olvida el día, la pantalla no frena y el
    // 400 de `create()` es el que atrapa. Que esto quede escrito evita creer que alcanza con la UI.
    expect(motivosDeBloqueo(formOk({ fecha: '2026-12-10' }))).not.toContain('fecha_futura');
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
    expect(e.texto).toBe('Sin propuesta: captúralo a mano.');
  });

  it('null/undefined no revientan la pantalla', () => {
    expect(etiquetaProcedencia(null).tono).toBe('vacio');
    expect(etiquetaProcedencia(undefined).tono).toBe('vacio');
  });

  // ⭐⭐ `[CG.180]` «No hay historia de este proveedor» es una afirmación sobre EL PROVEEDOR.
  // Con la copia del historial vacía, el hecho verdadero es sobre NOSOTROS: no hay con qué
  // proponer. Medido por la sesión de backend: la copia llegó a prod con cero filas, así que el
  // motor contestaba `sin_historia` para TODA entidad y la frase era falsa en el 100 % de los
  // casos — 25 reclasificaciones sobre 70 movimientos.
  describe('[CG.180] con la fuente vacía, `sin_historia` deja de culpar al proveedor', () => {
    const sinHistoria = { value: null, source: null, confidence: null, reason: 'sin_historia' };

    it('con la copia vacía, nombra a la copia y no al beneficiario', () => {
      const e = etiquetaProcedencia(sinHistoria, true);
      expect(e.tono).toBe('vacio');
      expect(e.texto).toContain('copia del historial está vacía');
      expect(e.texto).not.toContain('no hay historia de este proveedor');
    });

    it('[control] sin la bandera, el texto de siempre no cambia', () => {
      expect(etiquetaProcedencia(sinHistoria).texto).toContain('no hay historia de este proveedor');
      expect(etiquetaProcedencia(sinHistoria, false).texto).toContain('no hay historia de este proveedor');
    });

    it('[negativa] la bandera NO pisa los otros motivos: ésos sí hablan del proveedor', () => {
      const empate = { value: null, source: null, confidence: null, reason: 'empate' };
      expect(etiquetaProcedencia(empate, true).texto).toContain('repartidos');
      expect(etiquetaProcedencia(empate, true).texto).not.toContain('copia del historial');
    });

    it('[negativa] con una propuesta REAL la bandera no cambia nada: hay con qué proponer', () => {
      const prop = { value: { a: 1 }, source: 'aprendido', confidence: 0.9, support: 12, supportRatio: 0.9 };
      expect(etiquetaProcedencia(prop, true).tono).toBe('propuesto');
      expect(etiquetaProcedencia(prop, true).texto).toContain('12 antecedentes');
    });
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

  it('⛔⛔ [CG.112] se llama ESPERADO, no saldo — y con un negativo es la diferencia', () => {
    // Edgar, con la pantalla delante: "mi saldo en caja no se entiende". El defecto era el
    // rótulo: esta cifra es `t.esperado` con otro nombre (lo dice `cash-cut.service`), y el panel
    // de la jornada publica el MISMO número como "Esperado en caja general". Un saldo es lo que
    // HAY —y "saldo −$125,868.34" no tiene sentido físico—; un esperado es lo que el libro dice
    // que debería haber, y puede salir negativo cuando arrastra movimientos viejos sin cerrar.
    const t = textoSaldo({ saldo: -125868.34, sin_corte_abierto: false, corte_abierto: { folio: 'CC-2026-00001' } });
    expect(t).toContain('Esperado en caja');
    expect(t, 'volvió a decir que un negativo es un saldo').not.toContain('Saldo en caja');
    expect(t).toContain('125,868.34');
  });
  it('[negativa] sin respuesta dice "sin medir", que no es lo mismo que cero', () => {
    expect(textoSaldo(null)).toContain('sin medir');
  });

  /**
   * ⛔ `[CG.71]` La respuesta distingue CUATRO estados y esta función barría dos en uno.
   * El backend ya los separaba (`saldo_oculto` vs `sin_corte_abierto`); se perdían en la
   * última traducción, que es donde el usuario los lee.
   */
  it('⛔ [CG.71] [negativa] OCULTO no es "sin corte abierto": hay corte y el número se retiene', () => {
    // `[CG.19]`: quien captura cuenta a ciegas. Decirle "no hay corte abierto" es un hecho FALSO,
    // y la acción que sugiere —abrir uno— es la peor posible sobre un corte vivo.
    const t = textoSaldo({
      saldo: null, saldo_oculto: true, sin_corte_abierto: false,
      corte_abierto: { folio: 'CC-2026-00007' },
    });
    expect(t).toContain('oculto');
    expect(t).toContain('CC-2026-00007');     // se dice CUÁL corte: hay uno, y se nombra
    expect(t).not.toContain('sin corte abierto');
    expect(t).not.toContain('0.00');          // ocultar nunca se dibuja como cero
  });

  it('[CG.71] sin corte abierto MANDA, aunque además venga oculto', () => {
    // Un cajero sin corte: las dos banderas vienen juntas. La accionable es la primera —abrir la
    // caja—, no "esperá a que alguien selle" sobre algo que no existe.
    const t = textoSaldo({ saldo: null, saldo_oculto: true, sin_corte_abierto: true });
    expect(t).toContain('sin corte abierto');
    expect(t).not.toContain('oculto');
  });
});

/**
 * ⛔⛔ `[CG.160]` **El servidor exigía un campo que la pantalla no tenía.**
 *
 * `[CG.124]` puso la regla en el servidor: un movimiento sin `origen_ref` tiene que decir por qué,
 * en al menos 12 caracteres. El campo nunca llegó a la pantalla — `grep` de `sin_documento_motivo`
 * en todo `apps/view` daba **cero**. Quien capturaba cobranza de ruta recibía un 400 que le
 * explicaba perfectamente qué hacer **y no tenía dónde hacerlo**.
 *
 * Medido en prod: 71 movimientos vivos, 6 sin origen, **CERO con motivo**. Los únicos dos que
 * alguna vez lo trajeron los mandó una auditoría por POST a mano.
 */
describe('[CG.160] sin documento, hay que decir por qué', () => {
  const sinOrigen = (o: Partial<FormularioCaja> = {}) => formOk({ origen_ref: null, ...o });

  it('⛔ sin origen y sin motivo: la pantalla frena, no el 400 del servidor', () => {
    expect(motivosDeBloqueo(sinOrigen())).toContain('falta_motivo_sin_documento');
  });

  it('un motivo corto no alcanza — 12 caracteres es el mismo mínimo que el servidor', () => {
    expect(motivosDeBloqueo(sinOrigen({ sin_documento_motivo: 'ruta 501' })))
      .toContain('falta_motivo_sin_documento');
    expect(motivosDeBloqueo(sinOrigen({ sin_documento_motivo: 'a'.repeat(MOTIVO_SIN_DOC_MIN - 1) })))
      .toContain('falta_motivo_sin_documento');
    expect(motivosDeBloqueo(sinOrigen({ sin_documento_motivo: 'a'.repeat(MOTIVO_SIN_DOC_MIN) })))
      .not.toContain('falta_motivo_sin_documento');
  });

  it('los espacios no cuentan como razón', () => {
    expect(motivosDeBloqueo(sinOrigen({ sin_documento_motivo: '            ' })))
      .toContain('falta_motivo_sin_documento');
  });

  it('⛔ PRUEBA NEGATIVA: con origen NO estorba — es el caso normal', () => {
    // Si esta regla se disparara con el movimiento enlazado, bloquearía TODA la captura desde la
    // bandeja, que es el camino por el que entran 65 de los 71 movimientos vivos de prod.
    expect(motivosDeBloqueo(formOk())).toEqual([]);
    expect(motivosDeBloqueo(formOk({ origen_ref: '07|U-A-5|0000038|0011' })))
      .not.toContain('falta_motivo_sin_documento');
  });

  it('el texto dice QUÉ hacer, y nombra el mínimo que el servidor va a exigir', () => {
    expect(TEXTO_BLOQUEO.falta_motivo_sin_documento).toContain(String(MOTIVO_SIN_DOC_MIN));
    expect(TEXTO_BLOQUEO.falta_motivo_sin_documento.toLowerCase()).toContain('kepler');
  });
});

describe('[CGP-V.12] conflictoDeEsperado — el 409 del cierre se lee para poder confirmarlo', () => {
  const conflicto = {
    status: 409,
    error: {
      motivo: 'esperado_cambio', esperado_mostrado: 1500, esperado_actual: 1800,
      message: 'El esperado cambió desde que se contó: se mostró $1,500.00 y ahora da $1,800.00.',
    },
  };

  it('lee las dos cifras y la frase del servidor', () => {
    expect(conflictoDeEsperado(conflicto)).toEqual({
      mostrado: 1500, actual: 1800, mensaje: conflicto.error.message,
    });
  });

  it('las cifras que llegan como texto (numeric de Postgres) se convierten a número', () => {
    const r = conflictoDeEsperado({ ...conflicto, error: { ...conflicto.error, esperado_actual: '1800.00' } });
    expect(r?.actual).toBe(1800);
  });

  it('⛔ otro 409 no es este conflicto: no se ofrece confirmar nada', () => {
    expect(conflictoDeEsperado({ status: 409, error: { motivo: 'otra_cosa' } })).toBeNull();
  });

  it('⛔ un 400 (la reja tecleada, L.1) no es este conflicto', () => {
    expect(conflictoDeEsperado({ ...conflicto, status: 400 })).toBeNull();
  });

  it('⛔ sin las dos cifras no se ofrece confirmar un número que no llegó', () => {
    expect(conflictoDeEsperado({ status: 409, error: { motivo: 'esperado_cambio', esperado_mostrado: 1500 } })).toBeNull();
    expect(conflictoDeEsperado(null)).toBeNull();
    expect(conflictoDeEsperado(new Error('red caída'))).toBeNull();
  });
});

// ── `[CGP-V.1]` En qué paso va el corte ──────────────────────────────────────────────────────────
//
// La pantalla tiene que decir siempre en qué paso está el corte y qué sigue. El paso se DERIVA de lo
// que dice el servidor (corte abierto, conteo sellado, corte por autorizar), nunca de lo que la
// persona hizo en esta pestaña.
describe('[CGP-V.1] pasoDelCorte', () => {
  const base: EstadoParaPaso = { corteAbierto: true, sellado: null, conflicto: false, porAutorizar: false, recontando: false };

  it('los cinco pasos, en el orden de la jornada', () => {
    expect(PASOS_CORTE.map((p) => p.paso)).toEqual(['abrir', 'contar', 'revisar', 'cerrar', 'autorizar']);
  });

  it('⛔ [negativa] sin saber si hay corte (el saldo no se midió) no se afirma ningún paso', () => {
    expect(pasoDelCorte({ ...base, corteAbierto: null })).toBeNull();
  });

  it('sin corte abierto y nada por autorizar: sigue abrir', () => {
    expect(pasoDelCorte({ ...base, corteAbierto: false })).toBe('abrir');
  });

  it('sin corte abierto y uno cerrado sin autorizar: sigue autorizar', () => {
    expect(pasoDelCorte({ ...base, corteAbierto: false, porAutorizar: true })).toBe('autorizar');
  });

  it('corte abierto sin conteo sellado: sigue contar a ciegas', () => {
    expect(pasoDelCorte(base)).toBe('contar');
  });

  it('conteo sellado sin nada que decidir: sigue cerrar', () => {
    expect(pasoDelCorte({ ...base, sellado: { ofreceRecontar: false } })).toBe('cerrar');
  });

  it('conteo sellado con diferencia y el reconteo sin usar: sigue revisar la diferencia', () => {
    expect(pasoDelCorte({ ...base, sellado: { ofreceRecontar: true } })).toBe('revisar');
  });

  it('⛔ el esperado cambió desde el conteo: se vuelve a revisar aunque cuadrara', () => {
    expect(pasoDelCorte({ ...base, sellado: { ofreceRecontar: false }, conflicto: true })).toBe('revisar');
  });

  it('recontando: se vuelve a contar', () => {
    expect(pasoDelCorte({ ...base, sellado: { ofreceRecontar: true }, recontando: true })).toBe('contar');
  });

  it('el texto de autorizar nombra el folio y dice que es otra persona', () => {
    const t = textoPaso('autorizar', 'CC-2026-00009');
    expect(t).toContain('CC-2026-00009');
    expect(t).toContain('otra persona');
  });

  it('cada paso tiene un texto de qué sigue', () => {
    for (const p of PASOS_CORTE) expect(textoPaso(p.paso).length).toBeGreaterThan(10);
  });
});

// ── `[CGP-V.5]` El error dice lo que dijo el servidor ─────────────────────────────────────────────
//
// Un 403 se pintaba siempre «No tenés permiso»: la frase de la doble llave («Quien cerró el corte no
// puede autorizarlo») se perdía, y la persona creía que le faltaba un permiso.
describe('[CGP-V.5] textoDeError', () => {
  it('⛔ un 403 con frase del servidor dice ESA frase (la doble llave)', () => {
    const e = { status: 403, error: { message: 'Quien cerró el corte no puede autorizarlo: tiene que hacerlo otra persona.' } };
    expect(textoDeError(e)).toBe('Quien cerró el corte no puede autorizarlo: tiene que hacerlo otra persona.');
  });

  it('un 403 genérico del guardia de permisos se traduce', () => {
    expect(textoDeError({ status: 403, error: { message: 'Forbidden resource' } })).toBe('No tienes permiso para esta acción.');
    expect(textoDeError({ status: 403 })).toBe('No tienes permiso para esta acción.');
  });

  it('varias frases de validación se juntan, no se pierden', () => {
    expect(textoDeError({ status: 400, error: { message: ['La fecha no es válida', 'Falta la sucursal'] } }))
      .toBe('La fecha no es válida. Falta la sucursal.');
  });

  it('sin conexión y 429 se dicen en palabras', () => {
    expect(textoDeError({ status: 0 })).toBe('No hay conexión con el servidor.');
    expect(textoDeError({ status: 429 })).toContain('esperar');
  });

  it('⛔ sin frase no se inventa una: se dice que el servidor respondió con error', () => {
    expect(textoDeError({ status: 500 })).toBe('El servidor respondió con un error.');
    expect(textoDeError(null)).toBe('El servidor respondió con un error.');
  });
});

// ── `[CGP-L.8]` Las dos pilas del detalle ──────────────────────────────────────────────────────────
describe('[CGP-L.8] separarPorFlujo', () => {
  it('separa lo recibido del cambio; sin flujo, es lo recibido', () => {
    const r = separarPorFlujo([
      { denominacion: 500, piezas: 1, flujo: 'recibido' },
      { denominacion: 100, piezas: 1, flujo: 'devuelto' },
      { denominacion: 50, piezas: 2 },
    ]);
    expect(r.recibido).toEqual([{ denominacion: 500, piezas: 1 }, { denominacion: 50, piezas: 2 }]);
    expect(r.devuelto).toEqual([{ denominacion: 100, piezas: 1 }]);
  });

  it('el numeric de Postgres llega como texto: se convierte', () => {
    const r = separarPorFlujo([{ denominacion: '500.00' as unknown as number, piezas: '2' as unknown as number }]);
    expect(r.recibido).toEqual([{ denominacion: 500, piezas: 2 }]);
  });
});

/**
 * `[CGA11Y-O3b]` LA TAXONOMÍA DE LA TIRA DE ACCESOS.
 *
 * El grupo de un movimiento NO existe como dato: en la vista de pendientes `origen_tipo` sale
 * del signo, así que es un sinónimo de `tipo`. El eje real es `doc_tipo`, y el mapa que lo
 * traduce a grupos de negocio es una DECLARACIÓN — por eso se prueba como tal.
 */
describe('[CGA11Y-O3b] grupos de la cola', () => {
  it('los seis doc_tipo medidos en prod caen en un grupo', () => {
    // El universo completo de 365 días (ver la tabla en caja-captura.util.ts).
    expect(grupoDe('U-A-5')).toBe('deposito');
    expect(grupoDe('X-D-26')).toBe('egreso');
    expect(grupoDe('X-A-45')).toBe('otros_in');
    expect(grupoDe('U-A-25')).toBe('otros_in');
    expect(grupoDe('X-D-60')).toBe('otros_eg');
    expect(grupoDe('X-D-25')).toBe('otros_eg');
  });

  it('⛔ [negativa] un doc_tipo DESCONOCIDO se declara, no se reparte a ojo', () => {
    // Es la regla de ADR-056 puesta acá: un grupo inventado es peor que un grupo que falta.
    // Si mañana Kepler publica un doctype nuevo, tiene que aparecer como «sin clasificar» en
    // pantalla — no sumarse en silencio a «Egresos» porque empieza con X.
    expect(grupoDe('X-D-99')).toBe(GRUPO_SIN_CLASIFICAR);
    expect(grupoDe('U-A-9')).toBe(GRUPO_SIN_CLASIFICAR);
    expect(grupoDe('')).toBe(GRUPO_SIN_CLASIFICAR);
    expect(grupoDe(null)).toBe(GRUPO_SIN_CLASIFICAR);
    expect(grupoDe(undefined)).toBe(GRUPO_SIN_CLASIFICAR);
  });

  it('⛔ ningún doc_tipo pertenece a DOS grupos: el mapa es una función', () => {
    // Un doctype en dos grupos haría que la suma de los accesos no dé el universo, y la tira
    // publicaría más trabajo del que hay.
    const vistos = new Map<string, string>();
    for (const g of GRUPOS_COLA) {
      for (const d of g.docTipos) {
        expect(vistos.has(d), `${d} está en ${vistos.get(d)} y en ${g.clave}`).toBe(false);
        vistos.set(d, g.clave);
      }
    }
  });

  it('⛔ «Vecinal» NO es un grupo de esta cola', () => {
    /**
     * Medido el 2026-10-16: el cierre de ruta vecinal se timbra en la caja de su sucursal y
     * llega a Caja General como un `U-A-5` YA AGREGADO por día y plaza (`VEC.10`). Un acceso
     * propio pondría 572 cierres encima de 3,648 depósitos: ~$9 M contados dos veces.
     * Esta prueba existe para que no vuelva a entrar por parecer que falta.
     */
    const claves = GRUPOS_COLA.map((g) => g.clave);
    expect(claves).not.toContain('vecinal');
    expect(GRUPOS_COLA.some((g) => /vecinal/i.test(g.label))).toBe(false);
  });

  it('cada grupo declara al menos un doc_tipo y una etiqueta legible', () => {
    for (const g of GRUPOS_COLA) {
      expect(g.docTipos.length, `${g.clave} sin doc_tipo: sería un acceso que nunca tiene filas`)
        .toBeGreaterThan(0);
      expect(g.label.trim().length).toBeGreaterThan(2);
    }
  });
});
