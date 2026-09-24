import { normalizarNombre, proponerAreas, tokensDeNombre, type AreaCandidata } from './area-match';

/**
 * `[GX.16]` Esta regla decide **a quién se le da visibilidad sobre el gasto de otro**. Una
 * propuesta mal hecha que alguien confirma en lote no es un error cosmético: es una fuga.
 *
 * Los casos negativos NO son inventados: son los que el primer matcher (tokens en común)
 * produjo contra los datos reales de prod el 2026-09-24. Si alguien afloja la regla «para
 * que no quede nadie sin propuesta», estos tres se ponen rojos.
 */

const A = (name: string, id = name): AreaCandidata => ({ id, name });

// El catálogo real tiene 656 áreas; acá van las que participan de los casos medidos.
const CATALOGO: AreaCandidata[] = [
  A('JUAN JESUS CARRILLO CONTRERAS'),
  A('MARIA DEL CARMEN RODRIGUEZ VERA'),
  A('LUIS F'),
  A('GLORIA'),
  A('VICTORINO URBANO'),
  A('PERLA GARCÍA'),
  A('CLAUDIA PIMENTEL'),
  A('PILAR GARCIA'),
  A('LEONARDO CAZARES'),
  A('RRHH'),
];

describe('[GX.16] a quién se le propone qué área', () => {
  describe('los tres falsos positivos que mataron al primer matcher', () => {
    it('NO propone el área de otra persona con los mismos apellidos', () => {
      // `JUAN JESUS CARRILLO CONTRERAS` comparte CARRILLO y CONTRERAS con ella.
      const r = proponerAreas('Miriam Jazmin Carrillo Contreras', CATALOGO);
      expect(r.motivo).toBe('sin_propuesta');
      expect(r.areas).toEqual([]);
    });

    it('NO propone por un nombre de pila en común', () => {
      const r = proponerAreas('Maria del Pilar Nava Tafoya', CATALOGO);
      expect(r.areas.map((a) => a.name)).not.toContain('MARIA DEL CARMEN RODRIGUEZ VERA');
    });

    it('NO propone un área de una sola palabra, por más que coincida', () => {
      // `GLORIA` casaría con cualquier Gloria de la empresa; `LUIS F` con cualquier Luis.
      expect(proponerAreas('GLORIA ESTER NUÑEZ ALCALA', CATALOGO).motivo).toBe('sin_propuesta');
      expect(proponerAreas('JOSE LUIS MUÑOZ MOTA', CATALOGO).motivo).toBe('sin_propuesta');
    });
  });

  describe('lo que sí propone', () => {
    it('la coincidencia exacta', () => {
      const r = proponerAreas('Leonardo Cazares', CATALOGO);
      expect(r.motivo).toBe('exacta');
      expect(r.areas.map((a) => a.name)).toEqual(['LEONARDO CAZARES']);
    });

    it('el área contenida entera en el nombre de la persona', () => {
      const r = proponerAreas('VICTORINO URBANO OLIVARES', CATALOGO);
      expect(r.motivo).toBe('contenida');
      expect(r.areas.map((a) => a.name)).toEqual(['VICTORINO URBANO']);
    });

    /**
     * ⭐ Acentos. El catálogo trae `PERLA GARCÍA` y `PILAR GARCIA` — la misma familia de
     * nombres escrita de las dos formas. Sin normalizarlos se pierden 3 de las 17
     * coincidencias exactas medidas.
     */
    it('ignora los acentos en los dos lados', () => {
      const r = proponerAreas('Perla del Rosario García Pérez', CATALOGO);
      expect(r.areas.map((a) => a.name)).toContain('PERLA GARCÍA');
    });

    it('ignora «de», «del» y «la», que no distinguen a nadie', () => {
      expect(tokensDeNombre('CECILIA DEL PILAR GARCÍA MEJÍA')).not.toContain('DEL');
      const r = proponerAreas('CECILIA DEL PILAR GARCÍA MEJÍA', CATALOGO);
      expect(r.areas.map((a) => a.name)).toContain('PILAR GARCIA');
    });

    /**
     * ⭐ Varias propuestas NO es ambigüedad. Medido: `ANGEL ALBERTO VAZQUEZ MEJIA` tiene
     * en el catálogo `ANGEL MEJÍA`, `ANGEL MEJIA` y `ANGEL VAZQUEZ MEJIA` — el mismo
     * nombre escrito de tres formas. Las tres le corresponden, y el campo es una lista.
     */
    it('propone TODAS las variantes del mismo nombre', () => {
      const variantes = [A('ANGEL MEJÍA'), A('ANGEL MEJIA'), A('ANGEL VAZQUEZ MEJIA'), A('ANGEL RIVERA')];
      const r = proponerAreas('ANGEL ALBERTO VAZQUEZ MEJIA', variantes);
      expect(r.motivo).toBe('contenida');
      expect(r.areas.map((a) => a.name).sort()).toEqual(['ANGEL MEJIA', 'ANGEL MEJÍA', 'ANGEL VAZQUEZ MEJIA'].sort());
      // `ANGEL RIVERA` NO: RIVERA no está en su nombre.
      expect(r.areas.map((a) => a.name)).not.toContain('ANGEL RIVERA');
    });
  });

  describe('cuando no hay nada que proponer, lo dice', () => {
    it('devuelve el motivo, no una lista vacía a secas', () => {
      const r = proponerAreas('Rosaura Casias Garcia', CATALOGO);
      expect(r.motivo).toBe('sin_propuesta');
      expect(r.explicacion).toContain('a mano');
    });

    it('un usuario sin nombre no revienta', () => {
      for (const v of [null, undefined, '', '   ']) {
        const r = proponerAreas(v, CATALOGO);
        expect(r.motivo).toBe('sin_propuesta');
        expect(r.areas).toEqual([]);
      }
    });

    it('un catálogo vacío no revienta', () => {
      expect(proponerAreas('Leonardo Cazares', []).motivo).toBe('sin_propuesta');
    });

    it('un área sin nombre no se cuela como propuesta', () => {
      // Con `''` los tokens son 0, y 0 >= 2 es falso: no pasa la regla. Importa porque
      // `every()` sobre un arreglo vacío devuelve `true` y sin el mínimo entraría SIEMPRE.
      expect(proponerAreas('Leonardo Cazares', [A('', 'x')]).motivo).toBe('sin_propuesta');
    });
  });

  describe('la normalización', () => {
    it('colapsa espacios, acentos y mayúsculas', () => {
      expect(normalizarNombre('  José   Ramón  ÑAÑEZ ')).toBe('JOSE RAMON NANEZ');
    });
    it('deja pasar palabras cortas fuera de los tokens (RRHH sí, y sólo exacto)', () => {
      expect(tokensDeNombre('RRHH')).toEqual(['RRHH']);
      // Una sola palabra: no se propone por contención, sólo si casa exacto.
      expect(proponerAreas('RRHH', CATALOGO).motivo).toBe('exacta');
      expect(proponerAreas('Ana de RRHH y compras', CATALOGO).motivo).toBe('sin_propuesta');
    });
  });
});
