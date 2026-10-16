// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { antiguedadUltimo, clasificarContraUltimo } from './contra-ultimo';

describe('[CAT-COSTO.7] clasificarContraUltimo', () => {
  it('el caso de control 70001 en la 01: estándar 66.52, última compra 69.98 → estándar abajo, +5.2 %', () => {
    const r = clasificarContraUltimo({ costo_estandar: 66.52, costo_ultimo: 69.98, ultimo_motivo: null });
    expect(r.veredicto).toBe('estandar_abajo');
    expect(r.diferencia_pct).toBe(5.2);
  });

  it('la compra más barata que el estándar → estándar arriba, con diferencia negativa', () => {
    const r = clasificarContraUltimo({ costo_estandar: 100, costo_ultimo: 90, ultimo_motivo: null });
    expect(r.veredicto).toBe('estandar_arriba');
    expect(r.diferencia_pct).toBe(-10);
  });

  it('el borde de la tolerancia de 1 %: 0.9 % es igual, 1.1 % no', () => {
    expect(clasificarContraUltimo({ costo_estandar: 100, costo_ultimo: 100.9, ultimo_motivo: null }).veredicto).toBe('igual');
    expect(clasificarContraUltimo({ costo_estandar: 100, costo_ultimo: 101.1, ultimo_motivo: null }).veredicto).toBe('estandar_abajo');
    expect(clasificarContraUltimo({ costo_estandar: 100, costo_ultimo: 98.9, ultimo_motivo: null }).veredicto).toBe('estandar_arriba');
  });

  it('NEGATIVA: sin compra NO se dibuja como igual', () => {
    const r = clasificarContraUltimo({ costo_estandar: 50, costo_ultimo: null, ultimo_motivo: 'sin_compra' });
    expect(r.veredicto).toBe('sin_compra');
    expect(r.diferencia_pct).toBeNull();
  });

  it('NEGATIVA: una compra en unidad que la ficha no declara NO se compara: va a la lista del analista', () => {
    for (const motivo of ['unidad_no_resuelta', 'inverosimil'] as const) {
      const r = clasificarContraUltimo({ costo_estandar: 50, costo_ultimo: null, ultimo_motivo: motivo });
      expect(r.veredicto).toBe('unidad_no_clara');
      expect(r.diferencia_pct).toBeNull();
    }
  });

  it('sin estándar (o en cero) gana sobre cualquier otra cosa: no hay contra qué comparar', () => {
    expect(clasificarContraUltimo({ costo_estandar: null, costo_ultimo: 10, ultimo_motivo: null }).veredicto).toBe('sin_estandar');
    expect(clasificarContraUltimo({ costo_estandar: 0, costo_ultimo: 10, ultimo_motivo: null }).veredicto).toBe('sin_estandar');
  });

  it('un último costo en cero se trata como ausente, nunca como «100 % abajo»', () => {
    const r = clasificarContraUltimo({ costo_estandar: 50, costo_ultimo: 0, ultimo_motivo: null });
    expect(r.veredicto).toBe('sin_compra');
  });
});

describe('[CAT-COSTO.7] antiguedadUltimo', () => {
  it('reparte en 90 / 180 días, con los bordes del lado reciente', () => {
    expect(antiguedadUltimo('2026-10-15', '2026-10-15')).toBe('hasta_90');
    expect(antiguedadUltimo('2026-07-17', '2026-10-15')).toBe('hasta_90'); // 90 días
    expect(antiguedadUltimo('2026-07-16', '2026-10-15')).toBe('de_90_a_180'); // 91
    expect(antiguedadUltimo('2026-04-18', '2026-10-15')).toBe('de_90_a_180'); // 180
    expect(antiguedadUltimo('2026-04-17', '2026-10-15')).toBe('mas_de_180'); // 181
  });

  it('sin fecha → null (no se inventa una antigüedad)', () => {
    expect(antiguedadUltimo(null, '2026-10-15')).toBeNull();
  });
});
