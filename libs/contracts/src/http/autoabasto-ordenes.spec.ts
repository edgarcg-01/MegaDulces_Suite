import {
  armarOrdenes,
  MINIMO_RENGLONES_UNIDAD,
  SIN_LINEA,
  TOPE_RENGLONES_ORDEN,
  UNIDAD_MIXTA,
  type RenglonArmable,
} from './autoabasto-ordenes';

/**
 * `[AB.NI.2]` Cómo se parte el pedido en órdenes.
 *
 * ⭐ **CONTROL contra un hecho independiente:** la forma del pedido NO se inventa aquí. Sale de
 * `RQ-2026-03239` (Morelia Madero → Morelia Abastos), medida en prod en sólo lectura el
 * 2026-11-23: 294 renglones, 102 líneas, la más grande de 12 renglones, y por unidad de envío
 * PAQ 166 · CJA 51 · PZA 45 · KG 8 · BTO 2 · CUB 1 · sin unidad 21.
 *
 * ⛔ **PRUEBAS NEGATIVAS ejercidas al escribir esto** (cada mutación se corrió y se vio el rojo):
 *   · M1 — agrupar sólo por línea (quitar la unidad de la llave): cae «ninguna orden mezcla unidades».
 *   · M2 — cortar a mitad de línea (`cuenta + 1 > tope` renglón a renglón): cae «una línea no se parte».
 *   · M3 — no separar los renglones sin unidad: caen «21 quedan fuera» y «el botón cuenta 273».
 *   · M4 — quitar el `.sort()` de bandas y renglones: cae «líneas y renglones alfabéticos».
 *   · M5 — sumar `valor` tratando `null` como 0: cae «no valuable no se suma como cero».
 */

let n = 0;
const r = (p: Partial<RenglonArmable>): RenglonArmable => ({
  product_id: `p${++n}`,
  nombre: `PRODUCTO ${n}`,
  linea: 'LINEA A',
  unidad: 'CJA',
  valor: 10,
  ...p,
});

/** Genera `cuantos` renglones repartidos en líneas de a lo más `maxLinea`, todos en `unidad`. */
function bloque(unidad: string | null, cuantos: number, maxLinea = 12): RenglonArmable[] {
  const out: RenglonArmable[] = [];
  let i = 0;
  let linea = 0;
  while (i < cuantos) {
    const tam = Math.min(maxLinea, cuantos - i);
    // El nombre de línea lleva el índice con padding para que el alfabético sea estable.
    const nom = `${unidad ?? 'NULA'} LINEA ${String(linea).padStart(3, '0')}`;
    for (let k = 0; k < tam; k++) out.push(r({ unidad, linea: nom }));
    i += tam;
    linea++;
  }
  return out;
}

/** La forma MEDIDA de RQ-2026-03239. */
const pedidoReal: RenglonArmable[] = [
  ...bloque('PAQ', 166),
  ...bloque('CJA', 51),
  ...bloque('PZA', 45),
  ...bloque('KG', 8),
  ...bloque('BTO', 2),
  ...bloque('CUB', 1),
  ...bloque(null, 21),
];

describe('[AB.NI.2] armarOrdenes — cómo se parte el pedido', () => {
  it('⭐ CONTROL · la forma real de RQ-2026-03239 da 6 órdenes y 21 renglones fuera', () => {
    const a = armarOrdenes(pedidoReal);

    expect(pedidoReal).toHaveLength(294);
    expect(a.fuera).toHaveLength(21);
    expect(a.fuera.every((f) => f.motivo === 'sin_unidad')).toBe(true);
    expect(a.renglones_que_salen).toBe(273);

    // PAQ 166 en líneas de ≤12 no cabe en 2 órdenes de 70: son 3. CJA 51 y PZA 45, una cada una.
    // KG 8, BTO 2 y CUB 1 no llegan al mínimo de 12 → una sola orden mixta (D1, Edgar 2026-11-24).
    expect(a.ordenes).toHaveLength(6);
    const porUnidad = Object.fromEntries(a.por_unidad.map((u) => [u.unidad, u.ordenes]));
    expect(porUnidad).toEqual({ PAQ: 3, CJA: 1, PZA: 1, KG: 0, BTO: 0, CUB: 0 });
    expect(a.por_unidad.filter((u) => u.mixta).map((u) => u.unidad).sort()).toEqual(['BTO', 'CUB', 'KG']);
  });

  it('⭐ D1 · las unidades chicas se juntan en UNA orden, al final, y dice cuáles', () => {
    const a = armarOrdenes(pedidoReal);
    const mixtas = a.ordenes.filter((o) => o.mixta);

    expect(mixtas).toHaveLength(1);
    const m = mixtas[0];
    // Al FINAL: es lo último que se arma.
    expect(m.numero).toBe(a.ordenes.length);
    expect(m.unidad).toBe(UNIDAD_MIXTA);
    expect(m.renglones).toBe(11);
    expect([...m.unidades].sort()).toEqual(['BTO', 'CUB', 'KG']);
    // Dentro de la mixta la mercancía de cada unidad sigue junta: unidad → línea → alfabético.
    const us = m.bandas.map((b) => b.unidad);
    expect(us).toEqual([...us].sort());
  });

  it('⛔ con UNA sola unidad chica NO se junta nada: conserva su unidad real', () => {
    // CJA grande + un solo KG de 3 renglones. Juntar uno solo sería renombrarlo sin ahorrar nada.
    const a = armarOrdenes([...bloque('CJA', 30), ...bloque('KG', 3)]);
    expect(a.ordenes.some((o) => o.mixta)).toBe(false);
    expect(a.ordenes.map((o) => o.unidad).sort()).toEqual(['CJA', 'KG']);
    expect(a.por_unidad.every((u) => !u.mixta)).toBe(true);
  });

  it('⛔ una unidad que alcanza el mínimo NO entra a la cola, aunque sea la más chica', () => {
    const justo = MINIMO_RENGLONES_UNIDAD;
    const a = armarOrdenes([...bloque('CJA', 40), ...bloque('KG', justo), ...bloque('BTO', justo - 1), ...bloque('CUB', 1)]);
    const porUnidad = Object.fromEntries(a.por_unidad.map((u) => [u.unidad, u.mixta]));
    expect(porUnidad['KG']).toBe(false);   // 12 → documento propio
    expect(porUnidad['BTO']).toBe(true);   // 11 → cola
    expect(porUnidad['CUB']).toBe(true);   // 1  → cola
    expect(a.ordenes.filter((o) => o.mixta)).toHaveLength(1);
  });

  it('el junte se puede apagar: con minimoPorUnidad 1 cada unidad va por su lado', () => {
    const a = armarOrdenes(pedidoReal, { minimoPorUnidad: 1 });
    expect(a.ordenes).toHaveLength(8);
    expect(a.ordenes.some((o) => o.mixta)).toBe(false);
    expect(a.renglones_que_salen).toBe(273);
  });

  it('la orden mixta también respeta el tope: si no cabe, se parte', () => {
    // Cuatro unidades chicas de 11 (44 en total) con tope 20 → la cola sale en 3 órdenes mixtas.
    const chicas = [...bloque('KG', 11, 4), ...bloque('BTO', 11, 4), ...bloque('CUB', 11, 4), ...bloque('LTS', 11, 4)];
    const a = armarOrdenes(chicas, { tope: 20, minimoPorUnidad: 12 });
    const mixtas = a.ordenes.filter((o) => o.mixta);
    expect(mixtas.length).toBeGreaterThan(1);
    for (const o of mixtas) expect(o.renglones).toBeLessThanOrEqual(20);
    expect(mixtas.reduce((n, o) => n + o.renglones, 0)).toBe(44);
  });

  it('el botón primario cuenta lo que SALE, no el total', () => {
    const a = armarOrdenes(pedidoReal);
    expect(a.renglones_que_salen).toBe(pedidoReal.length - a.fuera.length);
    expect(a.renglones_que_salen).not.toBe(pedidoReal.length);
  });

  it('⛔ ninguna orden mezcla unidades — salvo la mixta, que lo DICE', () => {
    for (const o of armarOrdenes(pedidoReal).ordenes) {
      const unidades = [...new Set(o.bandas.flatMap((b) => b.renglones.map((x) => x.unidad)))].sort();
      // `unidades` de la orden siempre refleja lo que de verdad lleva.
      expect([...o.unidades].sort()).toEqual(unidades);
      if (o.mixta) {
        // La única que mezcla es la cola, y su rótulo no finge ser una unidad de Kepler.
        expect(o.unidad).toBe(UNIDAD_MIXTA);
        expect(unidades.length).toBeGreaterThan(1);
      } else {
        expect(unidades).toEqual([o.unidad]);
      }
    }
  });

  it('⛔ ninguna orden pasa del tope', () => {
    for (const o of armarOrdenes(pedidoReal).ordenes) {
      expect(o.renglones).toBeLessThanOrEqual(TOPE_RENGLONES_ORDEN);
    }
  });

  it('⛔ una línea más grande que el tope NO se parte: se va sola en su orden', () => {
    // ⚠️ Nombres de línea DISTINTOS a propósito: con el mismo nombre serían una sola línea de 76
    // y la prueba mediría otra cosa (ya pasó al escribirla).
    const grande = Array.from({ length: 71 }, (_, i) =>
      r({ unidad: 'CJA', linea: 'ZZZ UNA LINEA ENORME', nombre: `P${String(i).padStart(3, '0')}` }));
    const chica = Array.from({ length: 5 }, (_, i) =>
      r({ unidad: 'CJA', linea: 'AAA LINEA CHICA', nombre: `Q${String(i).padStart(3, '0')}` }));
    const a = armarOrdenes([...chica, ...grande], { tope: 70 });

    expect(a.ordenes).toHaveLength(2);
    const sola = a.ordenes.find((o) => o.renglones === 71);
    expect(sola).toBeDefined();
    expect(sola?.bandas).toHaveLength(1);
    // La chica queda en su propia orden: no se mete con la grande para "rellenar".
    expect(a.ordenes.find((o) => o.renglones === 5)).toBeDefined();
  });

  it('el corte ocurre al TERMINAR una línea, no a mitad', () => {
    // 7 líneas de 10 = 70 justo; la octava abre orden nueva.
    const a = armarOrdenes(bloque('CJA', 80, 10), { tope: 70 });
    expect(a.ordenes.map((o) => o.renglones)).toEqual([70, 10]);
    for (const o of a.ordenes) {
      for (const b of o.bandas) expect(b.renglones).toHaveLength(10);
    }
  });

  it('líneas y renglones van alfabéticos, y el acento no cambia el lugar', () => {
    const a = armarOrdenes([
      r({ linea: 'ZAPIEN', nombre: 'ZETA', unidad: 'CJA' }),
      r({ linea: 'ÁLVAREZ', nombre: 'BETA', unidad: 'CJA' }),
      r({ linea: 'ALVAREZZ', nombre: 'ALFA', unidad: 'CJA' }),
      r({ linea: 'ÁLVAREZ', nombre: 'ALFA', unidad: 'CJA' }),
    ]);
    expect(a.ordenes[0].bandas.map((b) => b.linea)).toEqual(['ÁLVAREZ', 'ALVAREZZ', 'ZAPIEN']);
    expect(a.ordenes[0].bandas[0].renglones.map((x) => x.nombre)).toEqual(['ALFA', 'BETA']);
  });

  it('un producto sin línea se agrupa bajo «(sin línea)», no se rellena con un default', () => {
    const a = armarOrdenes([r({ linea: null }), r({ linea: '   ' }), r({ linea: 'ACME' })]);
    const nombres = a.ordenes[0].bandas.map((b) => b.linea);
    expect(nombres).toContain(SIN_LINEA);
    expect(a.ordenes[0].bandas.find((b) => b.linea === SIN_LINEA)?.renglones).toHaveLength(2);
  });

  it('⛔ lo no valuable NO se suma como cero: se cuenta aparte', () => {
    const a = armarOrdenes([
      r({ valor: 100, unidad: 'CJA' }),
      r({ valor: null, unidad: 'CJA' }),
      r({ valor: undefined, unidad: 'CJA' }),
    ]);
    expect(a.ordenes[0].valor).toBe(100);
    expect(a.ordenes[0].sin_valuar).toBe(2);
  });

  it('una orden donde NADA se puede valuar declara valor null, no 0', () => {
    const a = armarOrdenes([r({ valor: null }), r({ valor: null })]);
    expect(a.ordenes[0].valor).toBeNull();
    expect(a.ordenes[0].sin_valuar).toBe(2);
    expect(a.por_unidad[0].valor).toBeNull();
  });

  it('un pedido entero sin unidad no produce órdenes y lo dice', () => {
    const a = armarOrdenes(bloque(null, 5));
    expect(a.ordenes).toHaveLength(0);
    expect(a.fuera).toHaveLength(5);
    expect(a.renglones_que_salen).toBe(0);
    expect(a.por_unidad).toHaveLength(0);
  });

  it('sin renglones devuelve vacío sin reventar', () => {
    const a = armarOrdenes([]);
    expect(a.ordenes).toEqual([]);
    expect(a.fuera).toEqual([]);
    expect(a.renglones_que_salen).toBe(0);
  });

  it('las órdenes se numeran 1..n en el orden en que se presentan', () => {
    const a = armarOrdenes(pedidoReal);
    expect(a.ordenes.map((o) => o.numero)).toEqual([1, 2, 3, 4, 5, 6]);
    // La unidad con más renglones se arma primero: PAQ (166). La cola, al final.
    expect(a.ordenes[0].unidad).toBe('PAQ');
    expect(a.ordenes[a.ordenes.length - 1].unidad).toBe(UNIDAD_MIXTA);
  });

  it('un tope de 0 o negativo se trata como «sin tope», no como «ninguna orden»', () => {
    const a = armarOrdenes(bloque('CJA', 200, 10), { tope: 0 });
    expect(a.ordenes).toHaveLength(1);
    expect(a.ordenes[0].renglones).toBe(200);
  });
});
