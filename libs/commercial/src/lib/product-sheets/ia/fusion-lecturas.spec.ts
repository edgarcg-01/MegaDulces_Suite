// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import {
  LECTURA_FOTO_VERSION, NOMBRES_CAMPOS,
  type CampoLeido, type CamposLeidos, type Confianza, type LecturaFotoV1, type NivelFisico,
} from './lectura-foto.contract';
import { aUnidadBase, familiaCara, fusionarLecturas, mismoValor } from './fusion-lecturas';

/** Un campo leído. La evidencia es obligatoria en el contrato: aquí también. */
const c = <T>(valor: T, confianza: Confianza, evidencia: string): CampoLeido<T> => ({ valor, confianza, evidencia });

const SIN_CAMPOS = Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, null])) as unknown as CamposLeidos;

const lectura = (p: Partial<CamposLeidos>, nivel: NivelFisico = 'empaque_interior', confNivel: Confianza = 'alta', extra: Partial<LecturaFotoV1> = {}): LecturaFotoV1 => ({
  version: LECTURA_FOTO_VERSION,
  nivel_fisico: c(nivel, confNivel, 'caja de cartón tipo casita'),
  persona_visible: false, rostro_visible: false, legible: 'si', motivo_no_legible: null, texto_literal: [],
  campos: { ...SIN_CAMPOS, ...p }, ...extra,
});

/**
 * El 95805 del plan (§7.2): «BON O BON FRESA ED ESP 8/15G», caja de 8 (empaque interior), 5 caras.
 * Los textos de evidencia son de prueba, armados con los datos de §7.2.
 */
const BONOBON_95805 = (): Array<{ cara: string; lectura: LecturaFotoV1 }> => [
  { cara: 'frente', lectura: lectura({
    marca: c('bon o bon', 'alta', 'bon o bon'),
    variante: c('Fresa', 'alta', 'FRESA'),
    edicion: c('Edición Especial', 'media', 'EDICIÓN ESPECIAL'),
    contenido_neto: c({ cantidad: 120, unidad: 'g' }, 'alta', 'CONT. NET. 120 g'),
    piezas: c(8, 'alta', '8 piezas'),
    contenido_por_pieza: c({ cantidad: 15, unidad: 'g' }, 'media', '8 piezas de 15 g c/u'),
    sellos_nom051: c(['EXCESO CALORÍAS', 'EXCESO AZÚCARES', 'EXCESO GRASAS SATURADAS'], 'alta', 'EXCESO CALORÍAS · EXCESO AZÚCARES · EXCESO GRASAS SATURADAS'),
    empaque: c({ tipo: 'caja de cartón tipo casita', material: null, colores: ['rojo', 'rosa', 'blanco'] }, 'media', 'caja casita'),
  }) },
  { cara: 'posterior', lectura: lectura({
    marca: c('BON O BON', 'alta', 'BON O BON'),
    fabricante: c('Arcor / Mundo Dulce S.A. de C.V.', 'alta', 'Hecho por: Mundo Dulce S.A. de C.V. (Arcor)'),
    alergenos: c(['leche', 'trigo'], 'alta', 'CONTIENE: LECHE, TRIGO'),
    puede_contener: c(['cacahuate'], 'media', 'PUEDE CONTENER CACAHUATE'),
    contenido_neto: c({ cantidad: 0.12, unidad: 'kg' }, 'media', 'CONT. NET. 0,12 kg'),
  }, 'empaque_interior', 'media') },
  { cara: 'lateral_1', lectura: lectura({
    empaque: c({ tipo: 'caja de cartón tipo casita', material: 'PAP 21', colores: ['blanco'] }, 'alta', 'PAP 21'),
    alergenos: c(['soya', 'leche'], 'media', 'CONTIENE: SOYA, LECHE'),
  }) },
  { cara: 'lateral_2', lectura: lectura({
    nutricion: c({
      base: { cantidad: 100, unidad: 'g' }, kcal: 564, proteinas_g: null, grasas_totales_g: null, grasas_saturadas_g: null,
      grasas_trans_mg: null, carbohidratos_g: null, azucares_g: null, azucares_anadidos_g: null, fibra_g: null, sodio_mg: null,
    }, 'alta', '564 kcal / 100 g'),
  }) },
  { cara: 'codigo', lectura: lectura({ codigo_barras_visible: c('7500443006889', 'alta', '7 500443 006889') }) },
];

describe('fusionarLecturas · el 95805 del plan (§7.2)', () => {
  const p = fusionarLecturas(BONOBON_95805());

  it('identidad y contenido: lo de §7.2, sin conflictos', () => {
    expect(p.version).toBe(LECTURA_FOTO_VERSION);
    expect(p.caras_leidas).toEqual(['frente', 'posterior', 'lateral_1', 'lateral_2', 'codigo']);
    expect(p.campos.marca?.valor).toBe('bon o bon');
    expect(p.campos.marca?.de_cara).toBe('frente'); // empate alta/alta → el frente
    expect(p.campos.marca?.conflicto).toBeNull(); // «BON O BON» es lo mismo sin mayúsculas
    expect(p.campos.variante?.valor).toBe('Fresa');
    expect(p.campos.edicion?.valor).toBe('Edición Especial');
    expect(p.campos.piezas?.valor).toBe(8);
    expect(p.campos.contenido_por_pieza?.valor).toEqual({ cantidad: 15, unidad: 'g' });
    expect(p.campos.fabricante?.valor).toBe('Arcor / Mundo Dulce S.A. de C.V.');
    expect(p.campos.codigo_barras_visible?.valor).toBe('7500443006889');
    expect(p.campos.nutricion?.valor.kcal).toBe(564);
    expect(p.campos.nutricion?.de_cara).toBe('lateral_2');
  });

  it('⭐ contenido neto: 120 g (frente, alta) y 0.12 kg (reverso) son lo mismo → sin conflicto', () => {
    expect(p.campos.contenido_neto?.valor).toEqual({ cantidad: 120, unidad: 'g' });
    expect(p.campos.contenido_neto?.de_cara).toBe('frente');
    expect(p.campos.contenido_neto?.conflicto).toBeNull();
  });

  it('arreglos: unión sin repetidos, de_cara con las caras que aportaron, confianza la más baja, sin conflicto', () => {
    expect(p.campos.alergenos?.valor).toEqual(['leche', 'trigo', 'soya']);
    expect(p.campos.alergenos?.de_cara).toBe('posterior, lateral_1');
    expect(p.campos.alergenos?.confianza).toBe('media');
    expect(p.campos.alergenos?.evidencia).toBe('posterior: CONTIENE: LECHE, TRIGO | lateral_1: CONTIENE: SOYA, LECHE');
    expect(p.campos.alergenos?.conflicto).toBeNull();
    expect(p.campos.sellos_nom051?.valor).toEqual(['EXCESO CALORÍAS', 'EXCESO AZÚCARES', 'EXCESO GRASAS SATURADAS']);
    expect(p.campos.puede_contener?.valor).toEqual(['cacahuate']);
  });

  it('empaque: gana la confianza alta (lateral_1, PAP 21); colores distintos y material no visto no son conflicto', () => {
    expect(p.campos.empaque?.valor.material).toBe('PAP 21');
    expect(p.campos.empaque?.de_cara).toBe('lateral_1');
    // El frente leyó `material: null` («no se ve aquí») y otros colores: no contradice.
    expect(p.campos.empaque?.conflicto).toBeNull();
  });

  it('⭐ prueba negativa: un material DISTINTO (PAP 20) sí es conflicto', () => {
    const caras = BONOBON_95805();
    caras[0].lectura.campos.empaque = c({ tipo: 'caja de cartón tipo casita', material: 'PAP 20', colores: [] }, 'media', 'PAP 20');
    expect(fusionarLecturas(caras).campos.empaque?.conflicto?.map((x) => x.cara)).toEqual(['frente']);
  });

  it('nivel físico: las 5 caras ven el empaque interior; persona_visible y rostro_visible falsos', () => {
    expect(p.nivel_fisico?.valor).toBe('empaque_interior');
    expect(p.nivel_fisico?.conflicto).toBeNull();
    expect(p.nivel_fisico?.de_cara).toBe('frente, posterior, lateral_1, lateral_2, codigo');
    expect(p.persona_visible).toBe(false);
    expect(p.rostro_visible).toBe(false);
  });

  it('lo que ninguna cara leyó queda null (no cero, regla 11)', () => {
    expect(p.campos.ingredientes).toBeNull();
    expect(p.campos.leyendas_nom051).toBeNull();
    expect(p.campos.pais_origen).toBeNull();
  });
});

describe('fusionarLecturas · conflictos y desempates', () => {
  it('⭐ prueba negativa: otra cara leyó otra variante → conflicto con su cara y evidencia', () => {
    const caras = BONOBON_95805();
    caras[1].lectura.campos.variante = c('Chocolate', 'media', 'SABOR CHOCOLATE');
    const p = fusionarLecturas(caras);
    expect(p.campos.variante?.valor).toBe('Fresa'); // alta gana a media
    expect(p.campos.variante?.conflicto).toEqual([{ cara: 'posterior', valor: 'Chocolate', evidencia: 'SABOR CHOCOLATE' }]);
  });

  it('⭐ prueba negativa: 125 g contra 120 g SÍ es conflicto (la conversión no lo esconde)', () => {
    const caras = BONOBON_95805();
    caras[1].lectura.campos.contenido_neto = c({ cantidad: 125, unidad: 'g' }, 'media', 'CONT. NET. 125 g');
    expect(fusionarLecturas(caras).campos.contenido_neto?.conflicto).toEqual([
      { cara: 'posterior', valor: { cantidad: 125, unidad: 'g' }, evidencia: 'CONT. NET. 125 g' },
    ]);
  });

  it('la confianza manda sobre la cara preferida: un lateral «alta» gana al frente «baja»', () => {
    const p = fusionarLecturas([
      { cara: 'frente', lectura: lectura({ marca: c('Bon o Bon', 'baja', 'bon o bon') }) },
      { cara: 'lateral_2', lectura: lectura({ marca: c('Bonobon', 'alta', 'BONOBON') }) },
    ]);
    expect(p.campos.marca?.valor).toBe('Bonobon');
    expect(p.campos.marca?.de_cara).toBe('lateral_2');
    expect(p.campos.marca?.conflicto?.[0].cara).toBe('frente');
  });

  it('empate de confianza en nutrición → el reverso antes que el frente; en el código → la cara del código', () => {
    const tabla = (kcal: number) => ({
      base: { cantidad: 100, unidad: 'g' as const }, kcal, proteinas_g: null, grasas_totales_g: null, grasas_saturadas_g: null,
      grasas_trans_mg: null, carbohidratos_g: null, azucares_g: null, azucares_anadidos_g: null, fibra_g: null, sodio_mg: null,
    });
    const p = fusionarLecturas([
      { cara: 'frente', lectura: lectura({ nutricion: c(tabla(560), 'media', '560 kcal'), codigo_barras_visible: c('7500443006880', 'media', '...6880') }) },
      { cara: 'reverso', lectura: lectura({ nutricion: c(tabla(564), 'media', '564 kcal') }) },
      { cara: 'codigo', lectura: lectura({ codigo_barras_visible: c('7500443006889', 'media', '...6889') }) },
    ]);
    expect(p.campos.nutricion?.de_cara).toBe('reverso'); // `reverso` de la captura = `posterior` del contrato
    expect(p.campos.nutricion?.conflicto?.[0].cara).toBe('frente');
    expect(p.campos.codigo_barras_visible?.valor).toBe('7500443006889');
  });

  it('persona_visible (informativo): basta UNA cara, y no arrastra a rostro_visible', () => {
    const caras = BONOBON_95805();
    caras[3].lectura.persona_visible = true; // una mano sosteniendo la caja
    const p = fusionarLecturas(caras);
    expect(p.persona_visible).toBe(true);
    expect(p.rostro_visible).toBe(false);
  });

  it('⭐ rostro_visible es OR de las caras: basta UNA', () => {
    const caras = BONOBON_95805();
    caras[4].lectura.persona_visible = true;
    caras[4].lectura.rostro_visible = true;
    expect(fusionarLecturas(caras).rostro_visible).toBe(true);
    // Control: con las 5 limpias, false.
    expect(fusionarLecturas(BONOBON_95805()).rostro_visible).toBe(false);
  });

  it('⭐ una lectura sin el booleano rostro_visible (anterior al campo) NO se supone limpia', () => {
    const caras = BONOBON_95805();
    delete (caras[2].lectura as Partial<LecturaFotoV1>).rostro_visible;
    expect(fusionarLecturas(caras).rostro_visible).toBe(true);
  });

  it('nivel físico: mayoría PONDERADA (una alta pesa más que dos bajas), sin conflicto', () => {
    const p = fusionarLecturas([
      { cara: 'frente', lectura: lectura({}, 'empaque_interior', 'alta') },
      { cara: 'posterior', lectura: lectura({}, 'caja_exterior', 'baja') },
      { cara: 'lateral_1', lectura: lectura({}, 'caja_exterior', 'baja') },
    ]);
    expect(p.nivel_fisico?.valor).toBe('empaque_interior');
    expect(p.nivel_fisico?.conflicto).toBeNull();
  });

  it('⭐ nivel físico: empate de pesos → conflicto (la IA duda del nivel → revisión)', () => {
    const p = fusionarLecturas([
      { cara: 'frente', lectura: lectura({}, 'pieza', 'alta') },
      { cara: 'posterior', lectura: lectura({}, 'empaque_interior', 'alta') },
    ]);
    expect(p.nivel_fisico?.valor).toBe('pieza'); // a igual confianza, el frente
    expect(p.nivel_fisico?.conflicto).toEqual([{ cara: 'posterior', valor: 'empaque_interior', evidencia: 'caja de cartón tipo casita' }]);
  });

  it('sin lecturas: propuesta vacía, nada inventado', () => {
    const p = fusionarLecturas([]);
    expect(p.nivel_fisico).toBeNull();
    expect(p.persona_visible).toBe(false);
    expect(p.rostro_visible).toBe(false);
    expect(Object.values(p.campos).every((x) => x === null)).toBe(true);
  });
});

describe('comparación y unidades', () => {
  it('aUnidadBase: kg→g, l→ml, mg→g; una unidad fuera del contrato no se convierte', () => {
    expect(aUnidadBase({ cantidad: 1, unidad: 'kg' })).toEqual({ cantidad: 1000, unidad: 'g' });
    expect(aUnidadBase({ cantidad: 0.5, unidad: 'l' })).toEqual({ cantidad: 500, unidad: 'ml' });
    expect(aUnidadBase({ cantidad: 500, unidad: 'mg' })).toEqual({ cantidad: 0.5, unidad: 'g' });
    expect(aUnidadBase({ cantidad: 3, unidad: 'oz' as never })).toEqual({ cantidad: 3, unidad: 'oz' });
  });

  it('mismoValor: texto sin acentos/mayúsculas/espacios; g ≠ ml; arreglos como conjuntos', () => {
    expect(mismoValor('Edición  Especial ', 'EDICION ESPECIAL')).toBe(true);
    expect(mismoValor('Bon o Bon', 'Bonobon')).toBe(false); // la fusión no quita espacios; el diccionario sí
    expect(mismoValor({ cantidad: 500, unidad: 'g' }, { cantidad: 500, unidad: 'ml' })).toBe(false);
    expect(mismoValor(['leche', 'Trigo'], ['trigo', 'LECHE'])).toBe(true);
    expect(mismoValor(['leche'], ['leche', 'soya'])).toBe(false);
    expect(mismoValor(null, null)).toBe(true);
    expect(mismoValor(null, 'x')).toBe(false);
  });

  it('estricto (calificación) vs no estricto (fusión): un null dentro del empaque', () => {
    const conPap = { tipo: 'caja', material: 'PAP 21', colores: [] };
    const sinPap = { tipo: 'caja', material: null, colores: [] };
    expect(mismoValor(conPap, sinPap)).toBe(false);
    expect(mismoValor(conPap, sinPap, { estricto: false })).toBe(true);
  });

  it('familiaCara: los nombres de la captura y los del contrato caen en la misma familia', () => {
    expect(familiaCara('reverso')).toBe('posterior');
    expect(familiaCara('lateral_izq')).toBe('lateral');
    expect(familiaCara('lateral_2')).toBe('lateral');
    expect(familiaCara('base')).toBe('base'); // no se asume que la base trae el código
  });
});
