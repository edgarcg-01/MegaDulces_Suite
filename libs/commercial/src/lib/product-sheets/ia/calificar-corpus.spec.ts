// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { LECTURA_FOTO_VERSION, NOMBRES_CAMPOS, type CampoPropuesto, type NivelFisico, type PropuestaAmpliada } from './lectura-foto.contract';
import {
  barajarRespuestas, calificarLectura, controlBarajado, generadorConSemilla, resumenCorpus, type CasoCorpus,
} from './calificar-corpus';

const cp = <T>(valor: T): CampoPropuesto<T> => ({ valor, confianza: 'alta', evidencia: String(valor), de_cara: 'frente', conflicto: null });

const propuesta = (campos: Partial<PropuestaAmpliada['campos']>, nivel: NivelFisico | null = null): PropuestaAmpliada => ({
  version: LECTURA_FOTO_VERSION, caras_leidas: ['frente'], nivel_fisico: nivel ? cp(nivel) : null, persona_visible: false, rostro_visible: false,
  campos: { ...(Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, null])) as PropuestaAmpliada['campos']), ...campos },
});

describe('calificarLectura · por campo', () => {
  const p = propuesta({
    marca: cp('BON O BON'), variante: cp('Fresa'), edicion: null,
    contenido_neto: cp({ cantidad: 0.12, unidad: 'kg' as const }),
    alergenos: cp(['trigo', 'leche'] as never), fabricante: cp('Arcor'),
    empaque: cp({ tipo: 'caja', material: null, colores: [] }),
  }, 'empaque_interior');

  const cal = calificarLectura(p, {
    marca: 'Bon o Bon',                                 // mismo texto sin mayúsculas → acierto
    variante: 'Chocolate',                              // otra cosa → fallo
    edicion: 'Edición Especial',                        // el empaque la trae y no se leyó → no_leido
    contenido_neto: { cantidad: 120, unidad: 'g' },     // 0.12 kg = 120 g → acierto
    alergenos: ['leche', 'trigo'],                      // conjunto, sin importar el orden → acierto
    fabricante: null,                                   // el empaque no lo trae y se inventó → fallo
    pais_origen: null,                                  // no lo trae y no se inventó → acierto
    empaque: { tipo: 'caja', material: 'PAP 21', colores: [] }, // estricto: material no leído → fallo
    nivel_fisico: 'empaque_interior',
    // ingredientes: sin etiquetar → sin_respuesta
  });

  it('acierto, fallo, no_leido y sin_respuesta', () => {
    expect(cal.campos.marca).toBe('acierto');
    expect(cal.campos.variante).toBe('fallo');
    expect(cal.campos.edicion).toBe('no_leido');
    expect(cal.campos.contenido_neto).toBe('acierto');
    expect(cal.campos.alergenos).toBe('acierto');
    expect(cal.campos.ingredientes).toBe('sin_respuesta');
    expect(cal.nivel_fisico).toBe('acierto');
  });

  it('⭐ inventar lo que el empaque no trae es fallo; no inventarlo es acierto', () => {
    expect(cal.campos.fabricante).toBe('fallo');
    expect(cal.campos.pais_origen).toBe('acierto');
  });

  it('la calificación es estricta: un material que no se leyó no pasa como «igual»', () => {
    expect(cal.campos.empaque).toBe('fallo');
  });

  it('sin propuesta (la lectura falló): todo lo etiquetado es no_leido', () => {
    const x = calificarLectura(null, { marca: 'Bon o Bon', nivel_fisico: 'pieza' });
    expect(x.campos.marca).toBe('no_leido');
    expect(x.nivel_fisico).toBe('no_leido');
    expect(x.campos.variante).toBe('sin_respuesta');
  });
});

/** Un corpus de prueba: 4 SKUs, el lector acierta todo lo etiquetado. */
const CORPUS = (): CasoCorpus[] => [
  { id: '95805', propuesta: propuesta({ marca: cp('bon o bon'), variante: cp('Fresa'), piezas: cp(8) }, 'empaque_interior'),
    respuesta: { marca: 'Bon o Bon', variante: 'Fresa', piezas: 8, nivel_fisico: 'empaque_interior' } },
  { id: '02020', propuesta: propuesta({ marca: cp('Trident'), variante: cp('Menta'), piezas: cp(12) }, 'empaque_interior'),
    respuesta: { marca: 'TRIDENT', variante: 'menta', piezas: 12, nivel_fisico: 'empaque_interior' } },
  { id: '91059', propuesta: propuesta({ marca: cp('Turín'), variante: cp('Chocolate'), piezas: null }, 'caja_exterior'),
    respuesta: { marca: 'Turin', variante: 'Chocolate', piezas: null, nivel_fisico: 'caja_exterior' } },
  { id: '70344', propuesta: propuesta({ marca: cp('Pulparindo'), variante: cp('Tamarindo'), piezas: cp(1) }, 'pieza'),
    respuesta: { marca: 'Pulparindo', variante: 'Tamarindo', piezas: 1, nivel_fisico: 'pieza' } },
];

describe('resumenCorpus', () => {
  const r = resumenCorpus(CORPUS());

  it('por campo { n, aciertos, tasa } y el nivel físico', () => {
    expect(r.casos).toBe(4);
    expect(r.campos.marca).toEqual({ n: 4, aciertos: 4, fallos: 0, no_leidos: 0, tasa: 1 });
    expect(r.campos.piezas.tasa).toBe(1); // el null del 91059 cuadra con «no lo trae»
    expect(r.nivel_fisico).toMatchObject({ n: 4, aciertos: 4, tasa: 1 });
  });

  it('⭐ sin casos etiquetados la tasa es null, no 0 (regla 11)', () => {
    expect(r.campos.ingredientes).toEqual({ n: 0, aciertos: 0, fallos: 0, no_leidos: 0, tasa: null });
    expect(resumenCorpus([]).nivel_fisico.tasa).toBeNull();
  });

  it('línea base: la clase mayoritaria del nivel físico y su tasa', () => {
    expect(r.nivel_fisico.clase_mayoritaria).toBe('empaque_interior');
    expect(r.nivel_fisico.tasa_clase_mayoritaria).toBe(0.5);
  });
});

describe('controlBarajado', () => {
  it('⭐ con las respuestas barajadas el acierto CAE (si no cae, el comparador mide otra cosa)', () => {
    const real = resumenCorpus(CORPUS());
    const control = controlBarajado(CORPUS(), 20261104);
    const total = (r: typeof real) => NOMBRES_CAMPOS.reduce((s, k) => s + r.campos[k].aciertos, 0) + r.nivel_fisico.aciertos;
    expect(total(control)).toBeLessThan(total(real));
    expect(control.campos.marca.aciertos).toBe(0); // 4 marcas distintas: ninguna cae en su lugar
    expect(control.nivel_fisico.aciertos).toBeLessThan(real.nivel_fisico.aciertos);
    // La línea base no cambia al barajar: es la misma distribución de respuestas.
    expect(control.nivel_fisico.tasa_clase_mayoritaria).toBe(real.nivel_fisico.tasa_clase_mayoritaria);
  });

  it('determinista: misma semilla, mismo control; sin Math.random', () => {
    const azar = vi.spyOn(Math, 'random');
    expect(controlBarajado(CORPUS(), 7)).toEqual(controlBarajado(CORPUS(), 7));
    expect(azar).not.toHaveBeenCalled();
    azar.mockRestore();
    expect(generadorConSemilla(1)()).toBe(generadorConSemilla(1)());
  });

  it('ningún caso se queda con su propia respuesta (Sattolo), con varias semillas', () => {
    for (const semilla of [1, 2, 3, 42, 20261104]) {
      const casos = CORPUS();
      const barajados = barajarRespuestas(casos, semilla);
      barajados.forEach((b, i) => expect(b.respuesta).not.toBe(casos[i].respuesta));
      // Es una permutación: las mismas respuestas, cada una una vez.
      expect(new Set(barajados.map((b) => b.respuesta))).toEqual(new Set(casos.map((c) => c.respuesta)));
    }
  });

  it('con un solo caso no hay control (se devuelve igual)', () => {
    const [uno] = CORPUS();
    expect(barajarRespuestas([uno], 1)[0].respuesta).toBe(uno.respuesta);
  });
});
