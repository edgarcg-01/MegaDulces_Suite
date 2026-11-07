/**
 * `[NP.7.L.11d]` La frontera IA → contrato. Caso real: la caja de 8 del 95805 (Bon o Bon fresa, ed. especial,
 * 8 piezas de 15 g; §7.2 del plan), con los tropiezos que un modelo comete de verdad (acentos que faltan,
 * números como texto, «n/a» en vez de vacío, un alérgeno fuera de la lista). Y los negativos: lo estructural
 * que falta invalida la lectura; el relleno de «ausente» nunca sobrevive como dato.
 */
import { NOMBRES_CAMPOS } from './lectura-foto.contract';
import { normalizarLectura, numeroDesde, SIN_EVIDENCIA } from './lector-foto.normalizar';

const AUSENTE_TEXTO = { evidencia: '', valor: '', confianza: 'baja' };

/** El cable de una cara con todo ausente, como lo pide el prompt; cada prueba pisa lo que necesita. */
function cableVacio(): Record<string, any> {
  return {
    version: 'lectura-foto-v1',
    persona_visible: false,
    rostro_visible: false,
    legible: 'si',
    motivo_no_legible: null,
    texto_literal: [],
    nivel_fisico: { evidencia: 'caja de cartón chica', valor: 'empaque_interior', confianza: 'media' },
    campos: {
      marca: AUSENTE_TEXTO, denominacion: AUSENTE_TEXTO, nombre_comercial: AUSENTE_TEXTO, variante: AUSENTE_TEXTO,
      edicion: AUSENTE_TEXTO, fabricante: AUSENTE_TEXTO,
      contenido_neto: { evidencia: '', valor: { cantidad: 0, unidad: 'g' }, confianza: 'baja' },
      piezas: { evidencia: '', valor: 0, confianza: 'baja' },
      contenido_por_pieza: { evidencia: '', valor: { cantidad: 0, unidad: 'g' }, confianza: 'baja' },
      sellos_nom051: { evidencia: '', valor: [], confianza: 'baja' },
      leyendas_nom051: { evidencia: '', valor: [], confianza: 'baja' },
      alergenos: { evidencia: '', valor: [], confianza: 'baja' },
      puede_contener: { evidencia: '', valor: [], confianza: 'baja' },
      alergenos_otros: { evidencia: '', valor: [], confianza: 'baja' },
      ingredientes: AUSENTE_TEXTO,
      nutricion: {
        evidencia: '', confianza: 'baja',
        valor: {
          base: { cantidad: 0, unidad: 'g' }, kcal: null, proteinas_g: null, grasas_totales_g: null, grasas_saturadas_g: null,
          grasas_trans_mg: null, carbohidratos_g: null, azucares_g: null, azucares_anadidos_g: null, fibra_g: null, sodio_mg: null,
        },
      },
      codigo_barras_visible: AUSENTE_TEXTO, pais_origen: AUSENTE_TEXTO, conservacion: AUSENTE_TEXTO,
      empaque: { evidencia: '', valor: { tipo: null, material: null, colores: [] }, confianza: 'baja' },
    },
  };
}

describe('[NP.7.L.11d] normalizarLectura — caso real (95805, caja de 8)', () => {
  const crudo = cableVacio();
  crudo['legible'] = 'Sí';
  crudo['motivo_no_legible'] = 'sobra: es legible';
  crudo['texto_literal'] = ['bon o bon', '  Edición Especial ', '', 'CONT. NET. 120 g', 'N/D'];
  Object.assign(crudo['campos'], {
    marca: { evidencia: 'bon o bon', valor: 'bon o bon', confianza: 'ALTA' },
    variante: { evidencia: '', valor: 'Fresa', confianza: 'alta' },
    edicion: { evidencia: 'Edición Especial', valor: 'Edición Especial', confianza: 'segura' },
    fabricante: { evidencia: 'Hecho por', valor: 'n/a', confianza: 'media' },
    contenido_neto: { evidencia: 'CONT. NET. 120 g', valor: { cantidad: '120', unidad: 'g' }, confianza: 'alta' },
    piezas: { evidencia: '8 piezas de 15 g', valor: '8', confianza: 'alta' },
    contenido_por_pieza: { evidencia: '8 piezas de 15 g', valor: { cantidad: 15, unidad: 'gr' }, confianza: 'alta' },
    sellos_nom051: {
      evidencia: 'EXCESO CALORÍAS · EXCESO AZÚCARES · EXCESO GRASAS SATURADAS', confianza: 'alta',
      valor: ['EXCESO CALORÍAS', 'EXCESO AZUCARES', 'EXCESO DE GRASAS SATURADAS', 'EXCESO VITAMINAS', 'EXCESO CALORIAS'],
    },
    leyendas_nom051: { evidencia: 'CONTIENE CAFEÍNA, EVITAR EN NIÑOS', valor: ['CONTIENE CAFEÍNA, EVITAR EN NIÑOS', 'HECHO EN MÉXICO'], confianza: 'media' },
    alergenos: { evidencia: 'Contiene: leche, trigo, soya, avellana', valor: ['leche', 'Trigo', 'soja', 'avellana'], confianza: 'alta' },
    puede_contener: { evidencia: 'Puede contener cacahuate y nuez de macadamia', valor: ['cacahuates', 'nuez de macadamia'], confianza: 'media' },
    nutricion: {
      evidencia: 'Contenido energético 564 kcal / 100 g', confianza: 'media',
      valor: { ...cableVacio()['campos'].nutricion.valor, base: { cantidad: 100, unidad: 'g' }, kcal: '564', grasas_trans_mg: 0, sodio_mg: '1,250' },
    },
    codigo_barras_visible: { evidencia: '7 500443 006889', valor: '7 500443 006889', confianza: 'alta' },
    empaque: { evidencia: 'caja de cartón tipo casita, PAP 21', valor: { tipo: 'caja de cartón', material: 'PAP 21', colores: ['rojo', 'Rojo', 'rosa', ' '] }, confianza: 'alta' },
  });
  const r = normalizarLectura(crudo);

  it('es válida y conserva lo estructural', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lectura.version).toBe('lectura-foto-v1');
    expect(r.lectura.legible).toBe('si');
    expect(r.lectura.motivo_no_legible).toBeNull(); // legible = si → sin motivo
    expect(r.lectura.persona_visible).toBe(false);
    expect(r.lectura.rostro_visible).toBe(false);
    expect(r.lectura.nivel_fisico).toEqual({ valor: 'empaque_interior', confianza: 'media', evidencia: 'caja de cartón chica' });
    // Tal cual: sólo se quitan renglones vacíos; «N/D» impreso es texto, no marcador.
    expect(r.lectura.texto_literal).toEqual(['bon o bon', 'Edición Especial', 'CONT. NET. 120 g', 'N/D']);
  });

  it('textos: evidencia vacía o marcador → null; confianza fuera de la lista → baja', () => {
    if (!r.ok) throw new Error(r.error);
    const c = r.lectura.campos;
    expect(c.marca).toEqual({ valor: 'bon o bon', confianza: 'alta', evidencia: 'bon o bon' });
    expect(c.variante).toBeNull(); // valor sin evidencia: no se acepta
    expect(c.fabricante).toBeNull(); // «n/a» no es un fabricante
    expect(c.edicion).toEqual({ valor: 'Edición Especial', confianza: 'baja', evidencia: 'Edición Especial' });
    expect(c.denominacion).toBeNull();
  });

  it('números y cantidades: texto → número, sinónimos de unidad', () => {
    if (!r.ok) throw new Error(r.error);
    const c = r.lectura.campos;
    expect(c.contenido_neto?.valor).toEqual({ cantidad: 120, unidad: 'g' });
    expect(c.piezas?.valor).toBe(8);
    expect(c.contenido_por_pieza?.valor).toEqual({ cantidad: 15, unidad: 'g' });
    expect(c.nutricion?.valor).toEqual({
      base: { cantidad: 100, unidad: 'g' }, kcal: 564, proteinas_g: null, grasas_totales_g: null, grasas_saturadas_g: null,
      grasas_trans_mg: 0, carbohidratos_g: null, azucares_g: null, azucares_anadidos_g: null, fibra_g: null, sodio_mg: 1250,
    });
  });

  it('listas cerradas: sellos y leyendas fuera de la lista se descartan; alérgeno fuera → alergenos_otros', () => {
    if (!r.ok) throw new Error(r.error);
    const c = r.lectura.campos;
    expect(c.sellos_nom051?.valor).toEqual(['EXCESO CALORÍAS', 'EXCESO AZÚCARES', 'EXCESO GRASAS SATURADAS']);
    expect(c.leyendas_nom051?.valor).toEqual(['CONTIENE CAFEÍNA - EVITAR EN NIÑOS']);
    expect(c.alergenos?.valor).toEqual(['leche', 'trigo', 'soya']);
    expect(c.alergenos_otros).toEqual({ valor: ['avellana'], confianza: 'alta', evidencia: 'Contiene: leche, trigo, soya, avellana' });
    expect(c.puede_contener?.valor).toEqual(['cacahuate']);
  });

  it('código: dígitos sin espacios en el valor, la evidencia tal cual; empaque sin colores repetidos', () => {
    if (!r.ok) throw new Error(r.error);
    const c = r.lectura.campos;
    expect(c.codigo_barras_visible).toEqual({ valor: '7500443006889', confianza: 'alta', evidencia: '7 500443 006889' });
    expect(c.empaque?.valor).toEqual({ tipo: 'caja de cartón', material: 'PAP 21', colores: ['rojo', 'rosa'] });
  });
});

describe('[NP.7.L.11d] normalizarLectura — lo que invalida y lo que nunca sobrevive', () => {
  it('lo que no es una lectura: no-objeto, arreglo, texto, null', () => {
    for (const x of [null, undefined, 'hola', 42, [], [cableVacio()]]) expect(normalizarLectura(x).ok).toBe(false);
  });

  it('persona_visible desconocido invalida (no se supone false); "true" en texto sí se acepta', () => {
    const sin = cableVacio();
    delete sin['persona_visible'];
    expect(normalizarLectura(sin)).toEqual({ ok: false, error: expect.stringContaining('persona_visible') });
    const quiza = cableVacio();
    quiza['persona_visible'] = 'quizá';
    expect(normalizarLectura(quiza).ok).toBe(false);
    const texto = cableVacio();
    texto['persona_visible'] = 'true';
    const r = normalizarLectura(texto);
    expect(r.ok && r.lectura.persona_visible).toBe(true);
  });

  it('⭐ rostro_visible ausente, null o de texto dudoso invalida la lectura (nunca se supone false)', () => {
    const sin = cableVacio();
    delete sin['rostro_visible'];
    expect(normalizarLectura(sin)).toEqual({ ok: false, error: 'rostro_visible no es booleano (no se supone false)' });
    for (const dudoso of [null, 'quizá', 'no sé', 0, 1, 'sí']) {
      const c = cableVacio();
      c['rostro_visible'] = dudoso;
      expect(normalizarLectura(c), String(dudoso)).toEqual({ ok: false, error: expect.stringContaining('rostro_visible') });
    }
    // Control: con el booleano (o su texto exacto) la lectura pasa y conserva el valor.
    const conRostro = cableVacio();
    conRostro['rostro_visible'] = 'true';
    conRostro['persona_visible'] = true;
    const r = normalizarLectura(conRostro);
    expect(r.ok && r.lectura.rostro_visible).toBe(true);
    const mano = cableVacio();
    mano['persona_visible'] = true; // una mano: persona sí, rostro no
    const m = normalizarLectura(mano);
    expect(m.ok && [m.lectura.persona_visible, m.lectura.rostro_visible]).toEqual([true, false]);
  });

  it('legible, nivel físico, versión, campos y texto_literal: fuera del contrato → inválida', () => {
    const casos: Array<[string, (c: Record<string, any>) => void]> = [
      ['legible', (c) => (c['legible'] = 'tal vez')],
      ['nivel_fisico', (c) => (c['nivel_fisico'].valor = 'tarima')],
      ['nivel_fisico', (c) => (c['nivel_fisico'] = null)],
      ['versión', (c) => (c['version'] = 'lectura-foto-v2')],
      ['campos', (c) => delete c['campos']],
      ['texto_literal', (c) => (c['texto_literal'] = 'bon o bon')],
    ];
    for (const [que, romper] of casos) {
      const c = cableVacio();
      romper(c);
      const r = normalizarLectura(c);
      expect(r.ok, que).toBe(false);
    }
  });

  it('el cable con todo ausente da los 20 campos en null (y sin `version` también vale)', () => {
    const c = cableVacio();
    delete c['version'];
    const r = normalizarLectura(c);
    if (!r.ok) throw new Error(r.error);
    expect(Object.keys(r.lectura.campos).sort()).toEqual([...NOMBRES_CAMPOS].sort());
    for (const k of NOMBRES_CAMPOS) expect(r.lectura.campos[k], k).toBeNull();
  });

  it('campos que ni siquiera vienen → null, no error', () => {
    const c = cableVacio();
    c['campos'] = {};
    const r = normalizarLectura(c);
    expect(r.ok).toBe(true);
    if (r.ok) for (const k of NOMBRES_CAMPOS) expect(r.lectura.campos[k]).toBeNull();
  });

  it('el relleno no sobrevive aunque traiga evidencia: cantidad 0, piezas 0 o fraccionarias, unidad desconocida', () => {
    const c = cableVacio();
    Object.assign(c['campos'], {
      contenido_neto: { evidencia: 'CONT. NET.', valor: { cantidad: 0, unidad: 'g' }, confianza: 'alta' },
      piezas: { evidencia: 'piezas', valor: 0, confianza: 'alta' },
      contenido_por_pieza: { evidencia: '2 oz', valor: { cantidad: 2, unidad: 'onzas' }, confianza: 'alta' },
    });
    const r = normalizarLectura(c);
    if (!r.ok) throw new Error(r.error);
    expect(r.lectura.campos.contenido_neto).toBeNull();
    expect(r.lectura.campos.piezas).toBeNull();
    expect(r.lectura.campos.contenido_por_pieza).toBeNull();

    c['campos'].piezas = { evidencia: '2.5 piezas', valor: 2.5, confianza: 'alta' };
    const r2 = normalizarLectura(c);
    expect(r2.ok && r2.lectura.campos.piezas).toBeNull();
  });

  it('nutrición sin base válida, o sin ningún renglón, es null (los números sueltos no se refieren a nada)', () => {
    const sinBase = cableVacio();
    sinBase['campos'].nutricion = { evidencia: '564 kcal', confianza: 'alta', valor: { ...sinBase['campos'].nutricion.valor, kcal: 564 } };
    const r1 = normalizarLectura(sinBase);
    expect(r1.ok && r1.lectura.campos.nutricion).toBeNull();

    const sinRenglones = cableVacio();
    sinRenglones['campos'].nutricion = { evidencia: 'Por 100 g', confianza: 'alta', valor: { ...sinRenglones['campos'].nutricion.valor, base: { cantidad: 100, unidad: 'g' } } };
    const r2 = normalizarLectura(sinRenglones);
    expect(r2.ok && r2.lectura.campos.nutricion).toBeNull();
  });

  it('nivel físico sin evidencia: se conserva, con confianza baja y la falta declarada', () => {
    const c = cableVacio();
    c['nivel_fisico'] = { evidencia: '  ', valor: 'Caja_Exterior', confianza: 'alta' };
    const r = normalizarLectura(c);
    if (!r.ok) throw new Error(r.error);
    expect(r.lectura.nivel_fisico).toEqual({ valor: 'caja_exterior', confianza: 'baja', evidencia: SIN_EVIDENCIA });
  });

  it('empacado en tienda: no se le leen sellos, leyendas ni código (§10b.7 punto 6)', () => {
    const c = cableVacio();
    c['nivel_fisico'] = { evidencia: 'bolsa transparente con etiqueta de báscula', valor: 'empacado_en_tienda', confianza: 'alta' };
    Object.assign(c['campos'], {
      sellos_nom051: { evidencia: 'EXCESO AZÚCARES', valor: ['EXCESO AZÚCARES'], confianza: 'alta' },
      codigo_barras_visible: { evidencia: '2 01234 005004', valor: '2 01234 005004', confianza: 'alta' },
      marca: { evidencia: 'MEGA DULCES', valor: 'MEGA DULCES', confianza: 'alta' },
    });
    const r = normalizarLectura(c);
    if (!r.ok) throw new Error(r.error);
    expect(r.lectura.campos.sellos_nom051).toBeNull();
    expect(r.lectura.campos.codigo_barras_visible).toBeNull();
    expect(r.lectura.campos.marca?.valor).toBe('MEGA DULCES');
  });

  it('un alérgeno de la lista que el modelo puso en «otros» regresa a alergenos, con la evidencia de otros', () => {
    const c = cableVacio();
    c['campos'].alergenos_otros = { evidencia: 'Contiene: Leche y avellana', valor: ['Leche', 'avellana', 'n/a'], confianza: 'media' };
    const r = normalizarLectura(c);
    if (!r.ok) throw new Error(r.error);
    expect(r.lectura.campos.alergenos).toEqual({ valor: ['leche'], confianza: 'media', evidencia: 'Contiene: Leche y avellana' });
    expect(r.lectura.campos.alergenos_otros?.valor).toEqual(['avellana']);
  });

  it('sellos sólo fuera de la lista → null (no se afirma «sin sellos»)', () => {
    const c = cableVacio();
    c['campos'].sellos_nom051 = { evidencia: 'EXCESO VITAMINAS', valor: ['EXCESO VITAMINAS'], confianza: 'alta' };
    const r = normalizarLectura(c);
    expect(r.ok && r.lectura.campos.sellos_nom051).toBeNull();
  });
});

describe('[NP.7.L.11d] numeroDesde', () => {
  it.each([
    [120, 120], ['120', 120], ['1,250', 1250], ['1 250', 1250], ['1,250.5', 1250.5], ['0.5', 0.5], ['0,5', 0.5],
    ['12,5', 12.5], ['0,500', 0.5], ['.5', 0.5], [0, 0], ['0', 0],
  ])('%j → %j', (entrada, esperado) => expect(numeroDesde(entrada)).toBe(esperado));

  it.each([['<1'], ['120 g'], ['-3'], [-3], [Number.NaN], [Number.POSITIVE_INFINITY], ['1,25,0'], [''], [null], [true], ['n/a']])(
    '%j → null',
    (entrada) => expect(numeroDesde(entrada)).toBeNull(),
  );
});
