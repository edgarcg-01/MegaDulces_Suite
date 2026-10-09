import { cambioDeMeta, huellaVentas, type ResultadoPropuesta } from './budget-run-output.engine';

/**
 * `[PVI.14]` — **Qué cifra produjo cada pasada.**
 *
 * El caso que define el éxito es el primero: dos pasadas del MISMO día que escribieron **429
 * renglones cada una** y publicaron metas distintas. Por el conteo son idénticas; es exactamente
 * el par que hay en prod (`GEN-20261009-001` y `-003`, con el proxy pasando de $197 M a cero) y
 * por el que «¿por qué cambió la meta?» no tiene respuesta.
 *
 * ⛔ Y la regla que lo sostiene: **el dinero ausente se declara, el conteo ausente es cero.** No
 * son el mismo caso. Un presupuesto de $0 y un presupuesto no medido son hechos distintos, y en un
 * registro HISTÓRICO la diferencia no se recupera: nadie va a recomputar una pasada de hace tres
 * meses para desmentir un cero.
 */

const propuesta = (over: Partial<ResultadoPropuesta> = {}): ResultadoPropuesta => ({
  coverage: { historico_ajustado: 300, estacional: 25, proxy_canal: 104, sin_base_declarado: 0, no_signal: 0, manual_kept: 0 },
  coverage_monto: { proxy_canal: 197_160_564.29 },
  proxy_canal_pct: 0.2446,
  meta_total: 604_775_116,
  ...over,
});

describe('[PVI.14] dos pasadas con el mismo conteo y distinta cifra', () => {
  it('⭐ el conteo NO las distingue; la meta SÍ', () => {
    const a = huellaVentas(propuesta());
    const b = huellaVentas(propuesta({ meta_total: 806_217_119, coverage_monto: { proxy_canal: 0 }, proxy_canal_pct: 0 }));

    expect(a.escritas).toBe(b.escritas);          // 429 las dos — indistinguibles por conteo
    expect(a.escritas).toBe(429);
    expect(a.meta_total).not.toBe(b.meta_total);  // …y publicaron cifras distintas
    expect(cambioDeMeta(a, b)).toBe(806_217_119 - 604_775_116);
  });

  it('el conteo suma los cuatro métodos y deja `manual_kept` aparte', () => {
    const h = huellaVentas(propuesta({
      coverage: { historico_ajustado: 10, estacional: 2, proxy_canal: 1, sin_base_declarado: 3, manual_kept: 7 },
    }));
    expect(h.escritas).toBe(16);     // lo que escribió el motor
    expect(h.manual_kept).toBe(7);   // lo que respetó
  });
});

describe('[PVI.14] el dinero ausente se declara; el conteo ausente es cero', () => {
  it('⛔ sin `meta_total` queda NULL, nunca 0', () => {
    expect(huellaVentas(propuesta({ meta_total: undefined })).meta_total).toBeNull();
    expect(huellaVentas(propuesta({ meta_total: null })).meta_total).toBeNull();
  });

  it('⛔ sin `coverage_monto` el proxy queda NULL — era un `?? 0` pegado a un `?? null` correcto', () => {
    expect(huellaVentas(propuesta({ coverage_monto: undefined })).proxy_canal_monto).toBeNull();
    expect(huellaVentas(propuesta({ coverage_monto: { proxy_canal: null } })).proxy_canal_monto).toBeNull();
  });

  it('un CERO de verdad se conserva como cero: declarar no es borrar', () => {
    const h = huellaVentas(propuesta({ meta_total: 0, coverage_monto: { proxy_canal: 0 }, proxy_canal_pct: 0 }));
    expect(h.meta_total).toBe(0);
    expect(h.proxy_canal_monto).toBe(0);
    expect(h.proxy_canal_pct).toBe(0);
  });

  it('sin `coverage` el conteo es 0 — ahí la ausencia SÍ significa ninguna celda', () => {
    const h = huellaVentas(propuesta({ coverage: null }));
    expect(h.escritas).toBe(0);
    expect(h.manual_kept).toBe(0);
    expect(h.meta_total).toBe(604_775_116);   // …y el dinero sigue declarado
  });

  it('un valor no numérico no se cuela como número', () => {
    const h = huellaVentas({ meta_total: Number.NaN, proxy_canal_pct: Number.POSITIVE_INFINITY } as ResultadoPropuesta);
    expect(h.meta_total).toBeNull();
    expect(h.proxy_canal_pct).toBeNull();
  });

  it('sin propuesta no inventa una huella', () => {
    const h = huellaVentas(null);
    expect(h).toEqual({ escritas: 0, manual_kept: 0, meta_total: null, proxy_canal_monto: null, proxy_canal_pct: null });
  });
});

describe('[PVI.14] comparar dos pasadas', () => {
  it('⛔ si alguna no registró la cifra, el cambio es DESCONOCIDO — no cero', () => {
    const conCifra = huellaVentas(propuesta());
    const sinCifra = huellaVentas(propuesta({ meta_total: null }));
    expect(cambioDeMeta(sinCifra, conCifra)).toBeNull();
    expect(cambioDeMeta(conCifra, sinCifra)).toBeNull();
    expect(cambioDeMeta(null, conCifra)).toBeNull();
  });

  it('dos pasadas con la misma cifra dan 0, que es distinto de NULL', () => {
    const a = huellaVentas(propuesta());
    expect(cambioDeMeta(a, huellaVentas(propuesta()))).toBe(0);
  });
});
