import { variacionPct, ventanaComparable } from './identity-me.contract';

/**
 * `[JZ.3]` — Los dos primitivos puros del bloque «Cómo va tu zona».
 *
 * ── Por qué están en `libs/contracts` y no junto a la medición ──────────────────────────────
 * Porque `libs/trade` **no tiene runner de pruebas** (sólo `lint`), y ADR-056 es explícito: un
 * primitivo no cierra su item hasta vivir donde se puede probar. Es la misma mudanza que hizo
 * `veredictoDe` en `[SN.29]`.
 *
 * ── Las dos cosas que vigilan, y lo que costaría equivocarse ────────────────────────────────
 *  1. **`variacionPct` no puede devolver un número cuando falta un lado.** Medido en prod: las 5
 *     rutas de ZAMORA no registran venta desde el 11-12 de agosto y vendieron $824k en julio.
 *     Con la resta ingenua eso publica **−100 %** y el jefe de zona sale a buscar al vendedor,
 *     cuando lo que se cortó fue la pierna Wincaja del sell-out.
 *  2. **`ventanaComparable` no puede invadir el mes que está midiendo.** El 31 de marzo,
 *     «los mismos 31 días de febrero» no existen: sumar 30 días al 1-feb da el **3 de marzo**, y
 *     el comparador se comería tres días del mes en curso — inflándolo y bajando la variación de
 *     todos los canales a la vez, en silencio.
 */
describe('JZ.3 · variacionPct', () => {
  it('calcula la variación cuando los dos lados existen', () => {
    expect(variacionPct(110, 100)).toBeCloseTo(0.1, 10);
    expect(variacionPct(90, 100)).toBeCloseTo(-0.1, 10);
    expect(variacionPct(100, 100)).toBe(0);
  });

  it('⛔ NEGATIVA — sin venta en el tramo NO es −100 %, es null', () => {
    // El caso ZAMORA/Wincaja exacto: $824k el mes pasado, nada este mes porque dejó de llegar.
    expect(variacionPct(null, 824_000)).toBeNull();
  });

  it('⛔ NEGATIVA — sin comparador no se inventa un crecimiento', () => {
    expect(variacionPct(500_000, null)).toBeNull();
  });

  it('⛔ NEGATIVA — comparador en 0 no publica un Infinity disfrazado', () => {
    /*
     * `JSON.stringify(Infinity)` es `null`, así que un `/0` no explota: llega al front como si
     * fuera «no se pudo medir» y nadie se entera de que hubo una división entre cero.
     */
    const r = variacionPct(500_000, 0);
    expect(r).toBeNull();
    expect(Number.isFinite(r as number)).toBe(false);
  });

  it('un cero MEDIDO sí se puede comparar: es un dato, no una ausencia', () => {
    // `monto: 0` significa «vendió cero», que es distinto de `null` («no hubo ninguna fila»).
    expect(variacionPct(0, 100)).toBe(-1);
  });
});

describe('JZ.3 · ventanaComparable', () => {
  it('compara tramo contra tramo, no contra el mes anterior completo', () => {
    expect(ventanaComparable('2026-09-15')).toEqual({
      desde: '2026-09-01',
      hasta: '2026-09-15',
      desde_comparado: '2026-08-01',
      hasta_comparado: '2026-08-15',
    });
  });

  it('cruza el año hacia atrás en enero', () => {
    expect(ventanaComparable('2026-01-07')).toEqual({
      desde: '2026-01-01',
      hasta: '2026-01-07',
      desde_comparado: '2025-12-01',
      hasta_comparado: '2025-12-07',
    });
  });

  it('⛔ NEGATIVA — el 31 de marzo NO se come tres días de marzo', () => {
    const v = ventanaComparable('2026-03-31');
    expect(v.hasta_comparado).toBe('2026-02-28');
    // La afirmación que importa: el comparador termina ANTES del mes que se está midiendo.
    expect(v.hasta_comparado < v.desde).toBe(true);
  });

  it('respeta el 29 de febrero de un año bisiesto', () => {
    // 2024 fue bisiesto: el 30 de marzo tiene comparador hasta el 29 de febrero, no el 28.
    expect(ventanaComparable('2024-03-30').hasta_comparado).toBe('2024-02-29');
  });

  it('el día 1 compara contra el día 1', () => {
    expect(ventanaComparable('2026-07-01')).toEqual({
      desde: '2026-07-01',
      hasta: '2026-07-01',
      desde_comparado: '2026-06-01',
      hasta_comparado: '2026-06-01',
    });
  });
});
