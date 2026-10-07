import { faltaParaMandar, puedeMandar, quedaDebiendoComprobante, type EstadoAporte } from './aporte-solicitante.contract';
import { FORMAS_PAGO, codigoKepler, detalleInvalido, esFormaPagoValida, exigeDetalle, formaPago } from './forma-pago.contract';

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
  // `[GX.57]` El concepto es obligatorio desde 2026-10-01: un estado «completo» sin el
  // concepto ya no es completo. Agregarlo acá puso en rojo 26 pruebas de golpe, que es
  // justo la prueba de que la compuerta nueva muerde en todos los caminos.
  concepto: 'Garrafones de agua para la oficina',
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
    const faltan = faltaParaMandar({ forma_pago: null, archivos: [], exige_evidencia: true, concepto: 'x' });
    expect(faltan[0].id).toBe('forma_pago');
    expect(faltan[1].id).toBe('evidencia');
  });

  it('frena si no hay comprobante', () => {
    const faltan = faltaParaMandar({ ...completo(), archivos: [{ role: 'solicitud_kepler', live: false }] });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia']);
  });

  /**
   * ⭐⭐ `[GX.36]` **EL VALE ESCANEADO VALE LO MISMO QUE LA FOTO.**
   *
   * Acá vivían dos pruebas que exigían el sello de cámara: un comprobante subido como
   * archivo frenaba el envío con el faltante `evidencia_en_vivo`. Se retiraron por
   * decisión del usuario, con el defecto medido en pantalla: **en esta operación los
   * vales se ESCANEAN**, así que la persona adjuntaba el vale firmado escaneado y el
   * botón le seguía diciendo «Falta: La foto del comprobante». Por esa vía el gasto no
   * se podía enviar nunca.
   *
   * ⚠️ Lo que se perdió se DECLARA, no se esconde: `live` sigue viajando con cada
   * archivo y Aprobación lo muestra («foto en vivo» / «foto sin sello de cámara»). Dejó
   * de ser COMPUERTA y pasó a ser DATO — quien firma lo ve y decide con eso a la vista.
   */
  it('un comprobante subido como ARCHIVO alcanza: el vale escaneado cuenta', () => {
    expect(faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'comprobante_1', live: false }],
    })).toEqual([]);
  });

  /** Ni siquiera hace falta que el campo venga: un escaneo no lo trae. */
  it('sin el campo `live` también alcanza', () => {
    expect(faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'comprobante_1' }],
    })).toEqual([]);
  });

  /** ⛔ Pero SIGUE haciendo falta un comprobante: lo que se relajó es CÓMO entra, no si hay. */
  it('la solicitud firmada sola no alcanza: falta el comprobante', () => {
    const faltan = faltaParaMandar({ ...completo(), archivos: [{ role: 'solicitud_kepler', live: true }] });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia']);
    expect(faltan[0].motivo).toContain('escaneado');
  });

  it('con VARIOS comprobantes, cualquiera alcanza', () => {
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
    expect(faltaParaMandar({ forma_pago: 'efectivo', forma_pago_detalle: 'Caja chica', archivos: [], exige_evidencia: false, concepto: 'x' })).toEqual([]);
    expect(faltaParaMandar({ forma_pago: null, archivos: [], exige_evidencia: false, concepto: 'x' }).map((f) => f.id)).toEqual(['forma_pago']);
  });

  /**
   * ⭐ `[GX.44]` **UN archivo alcanza, sea lo que sea.**
   *
   * Pedido textual: *«solo debe de tener un archivo de evidencia ya sea foto o un doc, debe
   * dejarlo enviar, al igual una cotizacion»*. Lo que cambia NO es el rigor sino CUÁNDO se
   * exige el comprobante: antes, quien sólo tenía la cotización de lo que iba a comprar se
   * quedaba trabado y el gasto **no entraba al sistema**.
   */
  it('una COTIZACIÓN sola alcanza para mandar', () => {
    expect(faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'cotizacion', live: false }],
    })).toEqual([]);
  });

  it('cualquiera de las tres cotizaciones cuenta', () => {
    for (const role of ['cotizacion', 'cotizacion_2', 'cotizacion_3']) {
      expect(faltaParaMandar({ ...completo(), archivos: [{ role, live: false }] }), role).toEqual([]);
    }
  });

  /** ⛔ Pero SIGUE haciendo falta algo: cero archivos no se manda. */
  it('sin ningún archivo no se manda', () => {
    const faltan = faltaParaMandar({ ...completo(), archivos: [] });
    expect(faltan.map((f) => f.id)).toEqual(['evidencia']);
  });

  /** ⛔ Y la solicitud firmada NO es respaldo del gasto: es el permiso, no el papel. */
  it('la solicitud firmada sigue sin alcanzar', () => {
    expect(faltaParaMandar({
      ...completo(),
      archivos: [{ role: 'solicitud_kepler', live: true }],
    }).map((f) => f.id)).toEqual(['evidencia']);
  });

  describe('[GX.44] el vale que queda DEBIENDO su comprobante', () => {
    /**
     * *«cuando es cotización se queda abierto para que cuando compre lo que cotizó suba la
     * factura»*. Se manda, pero nace sabiendo que debe.
     */
    it('con sólo cotización, queda debiendo', () => {
      expect(quedaDebiendoComprobante({
        ...completo(), archivos: [{ role: 'cotizacion', live: false }],
      })).toBe(true);
    });

    it('con el comprobante, no debe nada', () => {
      expect(quedaDebiendoComprobante({
        ...completo(), archivos: [{ role: 'comprobante_1', live: true }],
      })).toBe(false);
    });

    /** Con los dos tampoco: el comprobante ya está, la cotización es contexto. */
    it('con cotización Y comprobante, no debe nada', () => {
      expect(quedaDebiendoComprobante({
        ...completo(),
        archivos: [{ role: 'cotizacion', live: false }, { role: 'comprobante_1', live: true }],
      })).toBe(false);
    });

    /**
     * ⛔ **Sin archivos NO queda debiendo: queda sin mandar.** Son cosas distintas, y
     * confundirlas dejaría entrar un vale vacío marcado como «pendiente de factura».
     */
    it('sin archivos no «debe»: directamente no se puede mandar', () => {
      expect(quedaDebiendoComprobante({ ...completo(), archivos: [] })).toBe(false);
      expect(faltaParaMandar({ ...completo(), archivos: [] }).length).toBe(1);
    });

    /** Un gasto que no exige evidencia no puede deber un comprobante que nadie le pidió. */
    it('un no comprobable nunca queda debiendo', () => {
      expect(quedaDebiendoComprobante({
        forma_pago: 'efectivo', archivos: [{ role: 'cotizacion' }], exige_evidencia: false,
      })).toBe(false);
    });

    /**
     * ⚠️ Lo decide el CONTENIDO, no quien captura. Si dependiera de una casilla, alguien
     * podría mandar una cotización sin marcarla y el vale cerraría sin deber nada.
     */
    it('no hay forma de mandar una cotización sin que quede debiendo', () => {
      const soloCotizacion = { ...completo(), archivos: [{ role: 'cotizacion' }] };
      expect(faltaParaMandar(soloCotizacion)).toEqual([]);
      expect(quedaDebiendoComprobante(soloCotizacion)).toBe(true);
    });
  });

  /**
   * ⭐ `[GX.53]` **El dato del pago tiene forma, no sólo presencia.**
   *
   * Reportado tecleando **19 dígitos** en «Últimos 4 dígitos». No es cosmético: ahí se estaría
   * guardando un **número de tarjeta completo**, un dato que no debería existir en esta tabla
   * ni un minuto.
   *
   * ⚠️ Se prueba en la COMPUERTA y no en el input: un `maxlength` se salta llamando a la API.
   */
  describe('[GX.53] la forma del dato del pago', () => {
    const conDetalle = (forma: string, detalle: string): EstadoAporte =>
      ({ ...completo(), forma_pago: forma, forma_pago_detalle: detalle });

    it('⛔ la tarjeta NO acepta más de 4 dígitos', () => {
      const faltan = faltaParaMandar(conDetalle('tarjeta', '5555555555555555555'));
      expect(faltan.map((f) => f.id)).toEqual(['forma_pago_detalle']);
      expect(faltan[0].motivo).toContain('máximo 4');
      // Y dice cuántos escribió, para que se entienda sin adivinar.
      expect(faltan[0].motivo).toContain('19');
    });

    it('4 dígitos exactos pasan', () => {
      expect(faltaParaMandar(conDetalle('tarjeta', '4821'))).toEqual([]);
    });

    it('⛔ y tienen que ser dígitos', () => {
      const faltan = faltaParaMandar(conDetalle('tarjeta', '48a1'));
      expect(faltan.map((f) => f.id)).toEqual(['forma_pago_detalle']);
      expect(faltan[0].motivo).toContain('sólo números');
    });

    /** El cheque también es numérico, con más lugar. */
    it('el cheque acepta su número y rechaza letras', () => {
      expect(faltaParaMandar(conDetalle('cheque', '120455'))).toEqual([]);
      expect(faltaParaMandar(conDetalle('cheque', 'AB-12')).map((f) => f.id)).toEqual(['forma_pago_detalle']);
    });

    /**
     * ⚠️ **La transferencia NO se exige numérica**: las referencias de banco traen letras
     * (`TRSP-8823`). Exigir dígitos ahí habría trabado el caso normal.
     */
    it('la referencia del banco admite letras', () => {
      expect(faltaParaMandar(conDetalle('transferencia', 'TRSP-8823'))).toEqual([]);
    });

    it('pero no un texto sin fin', () => {
      const faltan = faltaParaMandar(conDetalle('transferencia', 'X'.repeat(31)));
      expect(faltan.map((f) => f.id)).toEqual(['forma_pago_detalle']);
    });

    /**
     * ⛔ **El vacío es otro faltante, no éste.** Si se mezclaran, quien no escribió nada
     * leería «máximo 4 caracteres» y no entendería qué le piden.
     */
    it('el vacío sigue siendo «falta el dato», no «está mal escrito»', () => {
      const faltan = faltaParaMandar(conDetalle('tarjeta', ''));
      expect(faltan.map((f) => f.id)).toEqual(['forma_pago_detalle']);
      expect(faltan[0].motivo).toContain('exige su dato');
      expect(faltan[0].motivo).not.toContain('máximo');
    });

    /** Las formas que no piden dato no pueden invalidar nada. */
    it('efectivo y vales no juzgan lo que no piden', () => {
      expect(detalleInvalido('efectivo', 'lo que sea')).toBeNull();
      expect(detalleInvalido('vales', '9'.repeat(99))).toBeNull();
      expect(detalleInvalido('no-existe', 'x')).toBeNull();
    });

    /** Se compara sin espacios de borde: «4821 » es válido. */
    it('no castiga por un espacio de más', () => {
      expect(faltaParaMandar(conDetalle('tarjeta', '  4821  '))).toEqual([]);
    });
  });

  /**
   * `[GX.57]` **El concepto dejó de ser opcional.**
   *
   * Pedido textual del usuario (2026-10-01): *«aqui en donde dice concepto opcional, debe ser
   * obligatorio escribir concepto»*.
   *
   * ⛔ **Por qué se prueba acá y no en la pantalla.** Antes la regla estaba escrita DOS veces
   * —`puedeEnviar()` en el componente y un `if` suelto en `create()`— y además **decían cosas
   * distintas**: las dos la exigían sólo cuando el gasto no llevaba evidencia. O sea que para
   * todo lo que la captura genera hoy, el campo era de verdad opcional en los dos lados. Al
   * mudarla acá, el botón y el 400 leen la misma línea y una sola prueba cubre a los dos.
   */
  describe('[GX.57] el concepto es obligatorio', () => {
    it('sin concepto no se manda, y lo nombra', () => {
      const faltan = faltaParaMandar({ ...completo(), concepto: null });
      expect(faltan.map((f) => f.id)).toEqual(['concepto']);
      expect(faltan[0].label).toBe('El concepto');
      expect(puedeMandar({ ...completo(), concepto: null })).toBe(false);
    });

    it('un concepto de puros espacios es no haberlo escrito', () => {
      expect(faltaParaMandar({ ...completo(), concepto: '   ' }).map((f) => f.id)).toEqual(['concepto']);
    });

    /**
     * ⭐ **La prueba que cubre el cambio real.** Antes, un gasto CON evidencia pasaba sin
     * concepto — era el camino normal de la captura. Si alguien devuelve la regla a
     * `exige_evidencia`, esto se pone rojo.
     */
    it('lo exige TAMBIÉN cuando el gasto lleva evidencia', () => {
      expect(faltaParaMandar({ ...completo(), exige_evidencia: true, concepto: '' })
        .map((f) => f.id)).toEqual(['concepto']);
    });

    /** Y al gasto sin evidencia, que ya lo exigía: no se perdió nada al mudar la regla. */
    it('lo sigue exigiendo al gasto que no lleva evidencia', () => {
      expect(faltaParaMandar({
        forma_pago: 'efectivo', forma_pago_detalle: 'Caja chica', archivos: [],
        exige_evidencia: false, concepto: '',
      }).map((f) => f.id)).toEqual(['concepto']);
    });

    /**
     * ⚠️ Va ÚLTIMO a propósito: es el último campo de la pantalla, y el botón muestra el
     * primer faltante. Pedir el concepto antes que la forma de pago mandaría a la persona
     * al final del formulario para después hacerla volver.
     */
    it('se pide después de la forma de pago y del archivo', () => {
      const faltan = faltaParaMandar({ forma_pago: null, archivos: [], exige_evidencia: true, concepto: '' });
      expect(faltan.map((f) => f.id)).toEqual(['forma_pago', 'evidencia', 'concepto']);
    });

    /**
     * ⛔ **Lo que esta compuerta NO hace, dicho con una prueba en vez de con un comentario.**
     * Un punto la pasa. Está declarado en el contrato: el pedido fue «obligatorio escribir
     * concepto», no «escribir una frase». Si algún día se decide un largo mínimo, esta
     * prueba se da vuelta y marca exactamente dónde tocarlo.
     */
    it('NO exige que el concepto diga algo: un carácter alcanza', () => {
      expect(faltaParaMandar({ ...completo(), concepto: '.' })).toEqual([]);
    });

    /** El concepto no toca la deuda del comprobante: son dos preguntas distintas. */
    it('no cambia quién queda debiendo el comprobante', () => {
      expect(quedaDebiendoComprobante({
        ...completo(), concepto: '', archivos: [{ role: 'cotizacion', live: false }],
      })).toBe(true);
    });
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
    const faltan = faltaParaMandar({ forma_pago: 'efectivo', forma_pago_detalle: null, archivos: [], exige_evidencia: false, concepto: 'x' });
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
