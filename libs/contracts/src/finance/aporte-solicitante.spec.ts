import { faltaParaMandar, puedeMandar, type EstadoAporte } from './aporte-solicitante.contract';
import { FORMAS_PAGO, codigoKepler, esFormaPagoValida, exigeDetalle, formaPago } from './forma-pago.contract';

/**
 * `[GX.14]` La compuerta es lo único que impide que una solicitud llegue a revisión sin
 * las dos cosas que Kepler no pide. Se prueba acá, y no en el servicio, porque es la
 * MISMA función que lee el botón del frontend: si se rompe, se rompen los dos lados a la
 * vez y una sola prueba lo ve.
 *
 * Cada caso arranca de un estado COMPLETO y le quita una cosa. Probar al revés (armar el
 * estado mínimo que falla) deja pasar el error de que la regla exija de más: con un
 * estado vacío, todo falla y la prueba se pone verde sin distinguir por qué.
 */

const completo = (): EstadoAporte => ({
  forma_pago: 'efectivo',
  forma_pago_detalle: 'Caja chica logística',
  archivos: [
    { role: 'solicitud_kepler', live: false },
    { role: 'comprobante_1', live: true },
  ],
  exige_evidencia: true,
});

describe('[GX.14] la compuerta de quien gasta', () => {
  it('deja mandar cuando están las dos cosas', () => {
    expect(faltaParaMandar(completo())).toEqual([]);
    expect(puedeMandar(completo())).toBe(true);
  });

  it('frena si no se declaró cómo se pagó', () => {
    const faltan = faltaParaMandar({ ...completo(), forma_pago: null });
    expect(faltan.map((f) => f.id)).toEqual(['forma_pago']);
  });

  it('frena si la forma de pago no es del catálogo (no se acepta un valor inventado)', () => {
    const faltan = faltaParaMandar({ ...completo(), forma_pago: 'bitcoin' });
    expect(faltan.map((f) => f.id)).toEqual(['forma_pago']);
  });

  it('frena si la forma elegida exige su dato y viene vacío', () => {
    const faltan = faltaParaMandar({ ...completo(), forma_pago: 'transferencia', forma_pago_detalle: '   ' });
    expect(faltan.map((f) => f.id)).toEqual(['forma_pago_detalle']);
  });

  it('NO pide dato a la forma que no lo tiene (vales)', () => {
    expect(faltaParaMandar({ ...completo(), forma_pago: 'vales', forma_pago_detalle: '' })).toEqual([]);
  });

  it('pide el dato de forma de pago ANTES que la foto: es el que se resuelve primero', () => {
    const faltan = faltaParaMandar({ forma_pago: null, archivos: [], exige_evidencia: true });
    expect(faltan[0].id).toBe('forma_pago');
    expect(faltan[1].id).toBe('evidencia');
  });

  it('frena si no hay comprobante', () => {
    const faltan = faltaParaMandar({ ...completo(), archivos: [{ role: 'solicitud_kepler', live: false }] });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia']);
  });

  /**
   * ⭐ El caso que da nombre a la fase: hay foto, pero entró como archivo. Es un faltante
   * DISTINTO de «no hay foto» — si el mensaje fuera el mismo, la persona vuelve a subir
   * exactamente el mismo archivo y no entiende por qué se lo rechazan otra vez.
   */
  it('frena si el comprobante existe pero NO se tomó en vivo, y lo dice distinto', () => {
    const faltan = faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'solicitud_kepler', live: false }, { role: 'comprobante_1', live: false }],
    });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia_en_vivo']);
    expect(faltan[0].motivo).toContain('cámara');
    expect(faltan[0].motivo).not.toBe(
      faltaParaMandar({ ...completo(), archivos: [] })[0].motivo,
    );
  });

  it('un comprobante sin el campo `live` cuenta como NO en vivo (el default no perdona)', () => {
    // Importa: si `undefined` pasara, bastaría con no mandar el campo para saltarse la regla.
    const faltan = faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'comprobante_1' }],
    });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia_en_vivo']);
  });

  it('con VARIOS comprobantes basta con que uno sea en vivo', () => {
    expect(faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'comprobante_1', live: false }, { role: 'comprobante_2', live: true }],
    })).toEqual([]);
  });

  it('la solicitud firmada NO cuenta como evidencia aunque sea en vivo', () => {
    // La firma respalda la autorización; el ticket respalda el gasto. Son dos cosas.
    const faltan = faltaParaMandar({ ...completo(), archivos: [{ role: 'solicitud_kepler', live: true }] });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia']);
  });

  it('un gasto no comprobable NO necesita foto, pero SÍ forma de pago', () => {
    // El dinero salió de algún lado aunque no haya papel: por eso la forma de pago no
    // cuelga de `exige_evidencia`.
    expect(faltaParaMandar({ forma_pago: 'efectivo', forma_pago_detalle: 'Caja chica', archivos: [], exige_evidencia: false })).toEqual([]);
    expect(faltaParaMandar({ forma_pago: null, archivos: [], exige_evidencia: false }).map((f) => f.id)).toEqual(['forma_pago']);
  });

  it('cada faltante trae texto corto para el botón y texto largo para el 400', () => {
    for (const f of faltaParaMandar({ forma_pago: null, archivos: [], exige_evidencia: true })) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.motivo.length).toBeGreaterThan(f.label.length);
    }
  });
});

describe('[GX.14] el catálogo de formas de pago', () => {
  it('tiene las seis opciones y ningún id repetido', () => {
    expect(FORMAS_PAGO).toHaveLength(6);
    expect(new Set(FORMAS_PAGO.map((f) => f.id)).size).toBe(6);
  });

  /**
   * El código no es decorativo: es lo que hace conmensurable lo que declaramos con lo que
   * Kepler ya guarda en `kdm1.c90`. Si alguien lo cambia, el día que se concilie no cuadra
   * y nadie sabe por qué.
   */
  it('cada forma lleva el código con el que Kepler/SAT la guardan', () => {
    expect(codigoKepler('efectivo')).toBe('01');
    expect(codigoKepler('cheque')).toBe('02');
    expect(codigoKepler('transferencia')).toBe('03');
    expect(codigoKepler('tarjeta')).toBe('04');
    expect(codigoKepler('vales')).toBe('07');
    expect(codigoKepler('otro')).toBe('99');
  });

  it('los códigos no se repiten entre formas', () => {
    expect(new Set(FORMAS_PAGO.map((f) => f.codigo_kepler)).size).toBe(FORMAS_PAGO.length);
  });

  /**
   * [GX.19] `efectivo` se sumo a la lista de los que cierran sin pedir nada: la pregunta
   * «¿De que caja salio?» se retiro por pedido del usuario.
   *
   * ⚠️ Lo que se pierde esta medido en el comentario del catalogo: sin ese dato, un gasto
   * en efectivo no dice de que caja salio. La regla NO se toco -- `exigeDetalle` se deriva
   * del catalogo, asi que dejar de pedirlo fue poner `detalle_label` en null y nada mas.
   */
  it('efectivo y vales cierran sin pedir un dato más', () => {
    const sinDetalle = FORMAS_PAGO.filter((f) => f.detalle_label == null).map((f) => f.id);
    expect(sinDetalle).toEqual(['efectivo', 'vales']);
  });

  /** Y la compuerta lo respeta sin que nadie la edite: esa es la gracia de derivarla. */
  it('efectivo ya no genera el faltante del dato del pago', () => {
    const faltan = faltaParaMandar({ forma_pago: 'efectivo', forma_pago_detalle: null, archivos: [], exige_evidencia: false });
    expect(faltan.map((f) => f.id)).not.toContain('forma_pago_detalle');
  });

  it('una forma con etiqueta de detalle trae también su ejemplo (el placeholder)', () => {
    for (const f of FORMAS_PAGO) {
      if (f.detalle_label) expect(f.detalle_ejemplo, `${f.id} sin ejemplo`).toBeTruthy();
    }
  });

  it('rechaza lo que no está en el catálogo, y no se cae con null', () => {
    expect(esFormaPagoValida('efectivo')).toBe(true);
    expect(esFormaPagoValida('EFECTIVO')).toBe(false); // el id es exacto, no se normaliza
    expect(esFormaPagoValida(null)).toBe(false);
    expect(esFormaPagoValida(undefined)).toBe(false);
    expect(formaPago('no-existe')).toBeUndefined();
    expect(codigoKepler(null)).toBeNull();
  });

  it('una forma inválida NO reporta «falta el detalle» — reporta que la forma no vale', () => {
    // Si `exigeDetalle` devolviera true para lo desconocido, el mensaje al usuario sería el
    // equivocado y se pondría a escribir un dato de una forma que no existe.
    expect(exigeDetalle('no-existe')).toBe(false);
    expect(exigeDetalle(null)).toBe(false);
  });
});
