import { coberturaDeCategoria, leerFila, type FilaDeCobertura } from './cobertura-de-categoria';

const HOY = '2026-11-23'; // lunes
const f = (o: Partial<FilaDeCobertura>): FilaDeCobertura =>
  ({ con_categoria: false, motivo: null, responsable: null, fecha: '2026-11-20', n: 1, monto: 100, ...o });

describe('[BFU.7.6] coberturaDeCategoria — con categoría + por qué y de quién', () => {
  it('reparte por motivo y responsable, el de más dinero primero, y declara lo que no tiene motivo', () => {
    const c = coberturaDeCategoria([
      f({ con_categoria: true, n: 10, monto: 1000 }),
      f({ motivo: 'kepler_en_otra_cuenta', responsable: 'tesoreria', n: 2, monto: 300 }),
      f({ motivo: 'cuenta_sin_categoria', responsable: 'contabilidad', n: 3, monto: 900 }),
      f({ motivo: null, n: 1, monto: '50.5' }),
    ], HOY, 16);
    expect(c.evaluados).toBe(16);
    expect(c.con_categoria).toEqual({ n: 10, monto: 1000 });
    expect(c.por_resolver.map((g) => g.motivo)).toEqual(['cuenta_sin_categoria', 'kepler_en_otra_cuenta']);
    expect(c.sin_motivo).toEqual({ n: 1, monto: 50.5 });
    expect(c.suma_cuadra).toBe(true);
  });
  it('⛔ «todavía no» se recalcula al leer: pasado el plazo es «no lo tiene» y del área, aunque el motor no corra', () => {
    const c = coberturaDeCategoria([
      f({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia', fecha: '2026-11-13', n: 4 }), // 6 días hábiles
      f({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia', fecha: '2026-11-16', n: 2 }), // 5: dentro
      f({ motivo: 'kepler_no_lo_tiene', responsable: 'area', fecha: '2026-11-03', n: 1 }),
    ], HOY);
    const de = (m: string) => c.por_resolver.find((g) => g.motivo === m);
    expect(de('kepler_no_lo_tiene')).toMatchObject({ responsable: 'area', n: 5 });
    expect(de('kepler_aun_no_lo_tiene')).toMatchObject({ responsable: 'nadie_todavia', n: 2 });
    expect(c.vencidos_al_leer).toBe(4);
  });
  it('[negativa] el conteo independiente que no casa se pone en falso; sin conteo, no medido (null)', () => {
    const filas = [f({ con_categoria: true, n: 3 }), f({ motivo: 'pareo_debil', responsable: 'tesoreria', n: 1 })];
    expect(coberturaDeCategoria(filas, HOY, 5).suma_cuadra).toBe(false);
    expect(coberturaDeCategoria(filas, HOY).suma_cuadra).toBeNull();
  });
  it('un motivo guardado sin responsable toma el de la lista cerrada', () => {
    const c = coberturaDeCategoria([f({ motivo: 'cuenta_sin_categoria', responsable: null })], HOY);
    expect(c.por_resolver[0]).toMatchObject({ motivo: 'cuenta_sin_categoria', responsable: 'contabilidad' });
  });
  it('sin renglones: ceros, no inventa nada', () => {
    expect(coberturaDeCategoria([], HOY, 0)).toEqual({ evaluados: 0, con_categoria: { n: 0, monto: 0 }, por_resolver: [],
      sin_motivo: { n: 0, monto: 0 }, suma_cuadra: true, vencidos_al_leer: 0, por_area: [], explicado: null });
  });
});

describe('[BFU.4.5.2] coberturaDeCategoria — por área: cada renglón tiene a quién le toca, o el grupo declarado', () => {
  const filas: FilaDeCobertura[] = [
    f({ con_categoria: true, area: 'credito_cobranza', entra: true, n: 10, monto: 5000 }),
    f({ con_categoria: true, area: 'compras', entra: false, n: 3, monto: 900 }),
    f({ con_categoria: true, area: null, entra: false, n: 2, monto: 40 }), // categoría sin área → Otros
    f({ motivo: 'pareo_debil', responsable: 'tesoreria', entra: false, n: 1, monto: 700 }),
    f({ motivo: 'cuenta_sin_categoria', responsable: 'contabilidad', entra: false, n: 1, monto: 60 }),
    f({ motivo: 'kepler_no_lo_tiene', responsable: 'area', entra: false, fecha: '2026-11-03', n: 2, monto: 300 }),
    f({ motivo: 'kepler_no_lo_tiene', responsable: 'area', entra: true, fecha: '2026-11-03', n: 4, monto: 800 }),
    f({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia', entra: false, fecha: '2026-11-13', n: 1, monto: 50 }), // vencido
    f({ motivo: 'kepler_aun_no_lo_tiene', responsable: 'nadie_todavia', entra: true, fecha: '2026-11-20', n: 5, monto: 250 }), // en plazo
    f({ motivo: null, n: 1, monto: 5 }),
  ];
  const c = coberturaDeCategoria(filas, HOY, 30);
  const de = (a: string) => c.por_area.find((g) => g.area === a);

  it('⛔ la partición por área suma el total: ningún renglón se pierde ni se cuenta dos veces', () => {
    expect(c.evaluados).toBe(30);
    expect(c.por_area.reduce((s, g) => s + g.n, 0)).toBe(c.evaluados);
    expect(c.por_area.reduce((s, g) => s + g.monto, 0)).toBe(8105);
    expect(c.por_area.reduce((s, g) => s + g.sin_categoria.n, 0)).toBe(c.evaluados - c.con_categoria.n);
  });
  it('con categoría: el área de la categoría; sin área, «Otros», que atiende Tesorería (BFU.4.5.1)', () => {
    expect(de('credito_cobranza')).toMatchObject({ atiende: 'credito_cobranza', n: 10, sin_categoria: { n: 0, monto: 0 } });
    expect(de('otros')).toMatchObject({ atiende: 'tesoreria', n: 2, monto: 40 });
  });
  it('sin categoría: el responsable que dejó el motor, si es un departamento', () => {
    expect(de('tesoreria')).toMatchObject({ n: 1, monto: 700, sin_categoria: { n: 1, monto: 700 } });
    expect(de('contabilidad')).toMatchObject({ n: 1, monto: 60 });
  });
  it('⛔ «el área» sin nombre se decide por la dirección: el retiro, Tesorería lo asigna; el depósito, a quien lo captura', () => {
    // 2 retiros que Kepler no tiene + 1 que venció al leer = 3 por asignar.
    expect(de('por_asignar')).toMatchObject({ atiende: 'tesoreria', n: 3, monto: 350 });
    expect(de('quien_captura')).toMatchObject({ atiende: null, n: 4, monto: 800 });
  });
  it('en plazo es de nadie todavía, y lo que no tiene motivo se declara aparte', () => {
    expect(de('en_plazo')).toMatchObject({ atiende: null, n: 5 });
    expect(de('sin_motivo')).toMatchObject({ atiende: null, n: 1, monto: 5 });
  });
  it('[negativa] sin dirección conocida, «el área» NO se manda a quien captura: queda por asignar', () => {
    const d = coberturaDeCategoria([f({ motivo: 'kepler_no_lo_tiene', responsable: 'area', fecha: '2026-11-03' })], HOY);
    expect(d.por_area).toEqual([{ area: 'por_asignar', atiende: 'tesoreria', n: 1, monto: 100, sin_categoria: { n: 1, monto: 100 },
      explicado: null, por_ligar: null, atrasados: null, motivos: [] }]);
  });
  it('el de más dinero primero', () => {
    expect(c.por_area[0].area).toBe('credito_cobranza');
  });
});

describe('[BFU.4.5.6] coberturaDeCategoria — quién explica cada peso, por área (regla explicarRenglon, BFU.2.8)', () => {
  // Un renglón con todos sus hechos: por omisión, un retiro con categoría del banco y sin documento.
  const h = (o: Partial<FilaDeCobertura>): FilaDeCobertura => f({ con_categoria: true, area: 'tesoreria', entra: false, categoria: 'comision',
    classified_by: 'banco', fuente: 'banco', documento: false, pago: false, cliente: false, ...o });
  const filas: FilaDeCobertura[] = [
    h({ area: 'credito_cobranza', entra: true, categoria: 'cobranza', classified_by: 'documento', fuente: 'documento', documento: true, n: 6, monto: 600 }),
    h({ area: 'credito_cobranza', entra: true, categoria: 'cobranza', fuente: 'deposito', fecha: '2026-11-03', n: 3, monto: 300 }), // atrasado
    h({ area: 'credito_cobranza', entra: true, categoria: 'cobranza', fuente: 'deposito', fecha: '2026-11-20', n: 1, monto: 50 }), // en plazo
    h({ area: 'tesoreria', n: 4, monto: 40 }), // comisión por el texto del banco: explicada
    h({ con_categoria: false, area: null, categoria: null, fuente: null, motivo: 'pareo_debil', responsable: 'tesoreria', fecha: '2026-11-03', n: 2, monto: 500 }),
    h({ con_categoria: false, area: null, categoria: null, fuente: null, motivo: 'kepler_no_lo_tiene', responsable: 'area', pago: true, n: 1, monto: 90 }), // el pago la explica
  ];
  const c = coberturaDeCategoria(filas, HOY, 17);
  const de = (a: string) => c.por_area.find((g) => g.area === a)!;

  it('⛔ el depósito «cobranza» puesto sólo por ser depósito NO está explicado (D8); el casado con su documento sí', () => {
    expect(de('credito_cobranza')).toMatchObject({ n: 10, explicado: { n: 6, monto: 600 }, por_ligar: { n: 4, monto: 350 }, atrasados: 3 });
    expect(de('credito_cobranza').motivos).toEqual([{ motivo: 'deposito_sin_documento', n: 4, monto: 350 }]);
  });
  it('la categoría con evidencia y el pago del Calendario explican; lo sin categoría falta ligar con su motivo', () => {
    expect(de('tesoreria')).toMatchObject({ n: 6, explicado: { n: 4, monto: 40 }, por_ligar: { n: 2, monto: 500 }, atrasados: 2 });
    expect(de('tesoreria').motivos[0]).toEqual({ motivo: 'pareo_debil', n: 2, monto: 500 });
    expect(de('por_asignar')).toMatchObject({ explicado: { n: 1, monto: 90 }, por_ligar: { n: 0, monto: 0 }, atrasados: 0 });
  });
  it('⛔ en cada área explicado + por ligar = n, y el total del periodo cuadra con las áreas', () => {
    for (const a of c.por_area) expect(a.explicado!.n + a.por_ligar!.n).toBe(a.n);
    expect(c.explicado).toEqual({ n: 11, monto: 730, por_ligar: { n: 6, monto: 850 }, atrasados: 5 });
    expect(c.explicado!.n + c.explicado!.por_ligar.n).toBe(c.evaluados);
  });
  it('[negativa] el cobro a un cliente declarado sí se explica; sin cliente, la cobranza del banco no', () => {
    const d = coberturaDeCategoria([
      h({ area: 'credito_cobranza', entra: true, categoria: 'cobranza', cliente: true }),
      h({ area: 'credito_cobranza', entra: true, categoria: 'cobranza' }),
    ], HOY);
    expect(d.por_area[0]).toMatchObject({ explicado: { n: 1 }, por_ligar: { n: 1 } });
    expect(d.por_area[0].motivos).toEqual([{ motivo: 'cobranza_sin_cliente', n: 1, monto: 100 }]);
  });
  it('⛔ [negativa] un renglón sin los hechos NO se mide: su área y el total salen null, nunca cero', () => {
    const d = coberturaDeCategoria([h({}), f({ con_categoria: true, area: 'tesoreria' })], HOY);
    expect(d.por_area[0]).toMatchObject({ area: 'tesoreria', n: 2, explicado: null, por_ligar: null, atrasados: null, motivos: [] });
    expect(d.explicado).toBeNull();
  });
  it('leerFila decide área y explicado igual que la cifra (la misma función para el filtro de la lista)', () => {
    expect(leerFila(filas[1], HOY)).toMatchObject({ area: 'credito_cobranza', explicado: false, por_que_no: 'deposito_sin_documento', atrasado: true });
    expect(leerFila(filas[5], HOY)).toMatchObject({ area: 'por_asignar', explicado: true, por_que_no: null, atrasado: false });
    // [negativa] lo explicado nunca está «atrasado», por viejo que sea (el atraso es de lo que falta ligar).
    expect(leerFila(h({ documento: true, fecha: '2026-11-03' }), HOY)).toMatchObject({ explicado: true, atrasado: false });
  });
});
