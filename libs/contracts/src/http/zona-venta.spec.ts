import { recortarAlDato, variacionPct, ventanaComparable } from './identity-me.contract';

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

describe('JZ.4 · ventanaComparable · mes', () => {
  const mes = (hoy: string) => ventanaComparable(hoy, 'mes');

  it('compara tramo contra tramo, no contra el mes anterior completo', () => {
    expect(mes('2026-09-15')).toEqual({
      periodo: 'mes',
      desde: '2026-09-01',
      hasta: '2026-09-15',
      desde_comparado: '2026-08-01',
      hasta_comparado: '2026-08-15',
      incluye_dia_en_curso: true,
    });
  });

  it("'mes' es el default: quien no elige nada recibe el grano de siempre", () => {
    expect(ventanaComparable('2026-09-15')).toEqual(mes('2026-09-15'));
  });

  it('cruza el año hacia atrás en enero', () => {
    const v = mes('2026-01-07');
    expect(v.desde_comparado).toBe('2025-12-01');
    expect(v.hasta_comparado).toBe('2025-12-07');
  });

  it('⛔ NEGATIVA — el 31 de marzo NO se come tres días de marzo', () => {
    const v = mes('2026-03-31');
    expect(v.hasta_comparado).toBe('2026-02-28');
    // La afirmación que importa: el comparador termina ANTES del mes que se está midiendo.
    expect(v.hasta_comparado < v.desde).toBe(true);
  });

  it('respeta el 29 de febrero de un año bisiesto', () => {
    expect(mes('2024-03-30').hasta_comparado).toBe('2024-02-29');
  });

  it('el día en curso va DECLARADO, porque el tramo llega a hoy', () => {
    // No se excluye —«mes corrido» es la convención y el día parcial pesa 1/N— pero la pantalla
    // tiene que poder decirlo. Callarlo sería la misma omisión que `no_comparado` vino a cerrar.
    expect(mes('2026-09-15').incluye_dia_en_curso).toBe(true);
  });
});

describe('JZ.4 · ventanaComparable · dia', () => {
  const dia = (hoy: string) => ventanaComparable(hoy, 'dia');

  it('⛔ es el último día CERRADO, no hoy', () => {
    // `sales_daily` tiene grano de día: un «hoy» a medias contra un día completo es una caída
    // falsa que se achica sola con las horas. El pulso de hoy vive en /tienda/live.
    const v = dia('2026-09-15');
    expect(v.desde).toBe('2026-09-14');
    expect(v.hasta).toBe('2026-09-14');
    expect(v.incluye_dia_en_curso).toBe(false);
  });

  it('⛔ NO compara contra ayer: compara contra el MISMO día de la semana', () => {
    /*
     * Medido en prod sobre 60 días: en rutas, lunes 162,470 contra sábado 115,765 (40 %); en
     * tiendas, martes 756,969 contra domingo 345,281 (2.2×). Comparar contra el día anterior
     * publicaría un salto que es puro calendario.
     */
    const v = dia('2026-09-15'); // el tramo es lunes 14
    expect(v.desde_comparado).toBe('2026-09-07'); // el lunes anterior
    const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
    expect(dow(v.desde_comparado)).toBe(dow(v.desde));
  });

  it('cruza el mes hacia atrás sin inventar fechas', () => {
    const v = dia('2026-03-01'); // el último cerrado es el 28-feb
    expect(v.hasta).toBe('2026-02-28');
    expect(v.hasta_comparado).toBe('2026-02-21');
  });
});

describe('JZ.4 · ventanaComparable · semana', () => {
  const semana = (hoy: string) => ventanaComparable(hoy, 'semana');

  it('⛔ son 7 días CERRADOS, no la semana del calendario', () => {
    /*
     * La semana natural (lunes-a-hoy) tiene dos defectos que se suman y ya se midieron: el día en
     * curso puede ser la MITAD del tramo —LA PIEDAD salía −31.9 % un martes por la tarde— y el
     * lunes el tramo se queda sin un solo día cerrado.
     */
    const v = semana('2026-09-15'); // martes
    expect(v).toEqual({
      periodo: 'semana',
      desde: '2026-09-08',
      hasta: '2026-09-14',
      desde_comparado: '2026-09-01',
      hasta_comparado: '2026-09-07',
      incluye_dia_en_curso: false,
    });
  });

  it('los dos lados traen los MISMOS 7 días de la semana, uno de cada uno', () => {
    // Es lo que hace conmensurable el par: ni un sábado de más ni un domingo de menos.
    const v = semana('2026-09-15');
    const dows = (a: string) =>
      [...Array(7)].map((_, i) =>
        new Date(Date.parse(`${a}T00:00:00Z`) + i * 86_400_000).getUTCDay(),
      ).sort();
    expect(dows(v.desde)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(dows(v.desde_comparado)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('⛔ NEGATIVA — un lunes NO deja el tramo vacío', () => {
    // El defecto exacto de la semana de calendario: el lunes, «lunes-a-ayer» no existe.
    const v = semana('2026-09-14'); // lunes
    expect(v.desde <= v.hasta).toBe(true);
    expect(v.desde).toBe('2026-09-07');
    expect(v.hasta).toBe('2026-09-13');
  });
});

describe('JZ.4 · recortarAlDato', () => {
  const base = ventanaComparable('2026-09-15', 'mes'); // 09-01…09-15 vs 08-01…08-15

  it('⛔ recorta los DOS lados al mismo número de días', () => {
    /*
     * El caso real: MORELIA ABASTOS publicaba −26.1 % comparando 10 días de septiembre contra 15
     * de agosto, porque su fuente (`wincaja_*`) no entregaba desde el 10. Con el tramo parejo la
     * zona sube 17.1 %. Recortar sólo arriba cambiaría una mentira por la opuesta.
     */
    const v = recortarAlDato(base, '2026-09-10');
    expect(v.hasta).toBe('2026-09-10');
    expect(v.hasta_comparado).toBe('2026-08-10');
    expect(v.incluye_dia_en_curso).toBe(false);
  });

  it('no hace nada cuando la fuente llegó al día', () => {
    expect(recortarAlDato(base, '2026-09-15')).toEqual(base);
    expect(recortarAlDato(base, null)).toEqual(base);
  });

  it('⛔ NEGATIVA — una fuente adelantada NO estira el tramo', () => {
    // `sales_daily` tiene 4 filas fechadas el 6-dic-2026, en el futuro. Un `hastaDato` mayor no
    // puede mover `hasta`: sólo se puede acortar.
    expect(recortarAlDato(base, '2026-12-06')).toEqual(base);
  });

  it('⛔ NEGATIVA — una fuente que no entregó NADA del tramo no lo recorta a cero', () => {
    // Las rutas de ZAMORA no entregan desde el 11-ago. Eso no es un rezago del tramo: es una
    // ausencia, y se declara fila por fila (`sin_medir`) y en `no_comparado`.
    expect(recortarAlDato(base, '2026-08-11')).toEqual(base);
  });
});
