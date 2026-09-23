import { avance, motivoNoCerrable, siguientePaso, FlujoEstado, FlujoLinea, FlujoLote } from './anden-flujo';

/**
 * Candados del rediseño del Andén.
 *
 * Cada bloque prueba UNA de las cuatro reglas, y varios de estos casos son
 * exactamente lo que el flujo actual hace mal: el congelamiento que se descubre
 * al guardar, y la segunda pasada por la misma caja.
 */

const linea = (id: string, faltaFechar: number): FlujoLinea => ({ id, faltaFechar });
const lote = (
  clave: string,
  porUbicar: number,
  rackSugerido: string | null = null,
  lineaId: string | null = null,
): FlujoLote => ({ clave, porUbicar, rackSugerido, lineaId });

const estado = (p: Partial<FlujoEstado> = {}): FlujoEstado => ({
  valeAbierto: true,
  valeCerrado: false,
  congeladoPorFolio: null,
  lineas: [],
  lotes: [],
  ...p,
});

describe('R1 — el almacén congelado se sabe ANTES de capturar', () => {
  it('sin vale identificado, el paso es pedir el folio', () => {
    expect(siguientePaso(estado({ valeAbierto: false }))).toEqual({ tipo: 'folio' });
  });

  it('con un conteo abierto NO manda a fechar: manda a bloqueado, con el folio', () => {
    const e = estado({ congeladoPorFolio: 'INV-2026-00009', lineas: [linea('L1', 10)] });
    expect(siguientePaso(e)).toEqual({ tipo: 'bloqueado', folio: 'INV-2026-00009' });
  });

  it('el congelamiento gana incluso si no queda nada por hacer', () => {
    // Importa: si ganara "cerrar", el operario apretaría un botón que el backend
    // rechaza. El bloqueo tiene que verse antes que cualquier acción.
    const e = estado({ congeladoPorFolio: 'INV-2026-00009' });
    expect(siguientePaso(e).tipo).toBe('bloqueado');
  });

  it('sin conteo abierto el flujo sigue normal', () => {
    const e = estado({ congeladoPorFolio: null, lineas: [linea('L1', 10)] });
    expect(siguientePaso(e)).toEqual({ tipo: 'fechar', lineaId: 'L1' });
  });
});

describe('R2 — al fechar se resuelve la ubicación, siempre', () => {
  it('recién fechado y CON rack conocido: lo siguiente es acomodar ESE lote', () => {
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 5)],
      lotes: [lote('p1|A|2027-03-31', 12, 'R-04', 'L1')],
    });
    expect(siguientePaso(e, 'L1')).toEqual({
      tipo: 'ubicar', clave: 'p1|A|2027-03-31', rackSugerido: 'R-04',
    });
  });

  it('recién fechado y SIN rack conocido: igual manda a ubicar, para CREARLA', () => {
    // Decisión del negocio (2026-09-23): un lote que cae a la cola sin rack es
    // mercancía que nadie encuentra. `rackSugerido: null` es la señal de que la
    // pantalla tiene que ofrecer crear la ubicación, no un error.
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 5)],
      lotes: [lote('p1|A|2027-03-31', 12, null, 'L1')],
    });
    expect(siguientePaso(e, 'L1')).toEqual({
      tipo: 'ubicar', clave: 'p1|A|2027-03-31', rackSugerido: null,
    });
  });

  it('no arrastra al operario al lote de OTRO renglón', () => {
    // El lote con rack es de L9, que no tiene en la mano. Si el flujo lo mandara
    // ahí, lo pondría a buscar una caja que dejó hace media hora.
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 5)],
      lotes: [lote('p9|A|2027-01-31', 3, 'R-09', 'L9')],
    });
    expect(siguientePaso(e, 'L1')).toEqual({ tipo: 'fechar', lineaId: 'L2' });
  });

  it('un lote ya acomodado (porUbicar 0) no dispara la pasada única', () => {
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 5)],
      lotes: [lote('p1|A|2027-03-31', 0, 'R-04', 'L1')],
    });
    expect(siguientePaso(e, 'L1')).toEqual({ tipo: 'fechar', lineaId: 'L2' });
  });

  it('sin `recienFechada` nunca se activa la pasada única', () => {
    const e = estado({
      lineas: [linea('L2', 5)],
      lotes: [lote('p1|A|2027-03-31', 12, 'R-04', 'L1')],
    });
    expect(siguientePaso(e)).toEqual({ tipo: 'fechar', lineaId: 'L2' });
  });
});

describe('R3 — nunca devolver a una lista: siempre hay siguiente paso', () => {
  it('mientras haya etiquetas que leer, fechar es la prioridad', () => {
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 4), linea('L3', 7)],
      lotes: [lote('p1|A|2027-03-31', 12, 'R-04', 'L1')],
    });
    // Sin `recienFechada`, aunque haya un lote con rack listo, primero el camión.
    expect(siguientePaso(e)).toEqual({ tipo: 'fechar', lineaId: 'L2' });
  });

  it('terminado el fechado, acomoda primero lo que YA tiene rack', () => {
    const e = estado({
      lineas: [linea('L1', 0)],
      lotes: [lote('sin|rack', 5, null, 'L1'), lote('con|rack', 2, 'R-07', 'L1')],
    });
    expect(siguientePaso(e)).toEqual({ tipo: 'ubicar', clave: 'con|rack', rackSugerido: 'R-07' });
  });

  it('si ninguno tiene rack, toma el primero de la cola igual', () => {
    const e = estado({
      lineas: [linea('L1', 0)],
      lotes: [lote('a|1', 5, null, 'L1'), lote('b|2', 2, null, 'L1')],
    });
    expect(siguientePaso(e)).toEqual({ tipo: 'ubicar', clave: 'a|1', rackSugerido: null });
  });
});

describe('R4 — cerrar sólo cuando de verdad no queda nada', () => {
  it('sin pendientes, el paso es cerrar', () => {
    const e = estado({ lineas: [linea('L1', 0)], lotes: [lote('a|1', 0, 'R-01', 'L1')] });
    expect(siguientePaso(e)).toEqual({ tipo: 'cerrar' });
  });

  it('un vale ya cerrado no vuelve a ofrecer cerrar', () => {
    const e = estado({ valeCerrado: true, lineas: [linea('L1', 0)] });
    expect(siguientePaso(e)).toEqual({ tipo: 'terminado' });
  });

  it('el motivo de no poder cerrar nombra las DOS mitades', () => {
    const e = estado({ lineas: [linea('L1', 3)], lotes: [lote('a|1', 2, null, 'L1')] });
    expect(motivoNoCerrable(e)).toBe('Faltan 1 renglones por fechar y 1 lotes por acomodar.');
  });

  it('singular y plural, porque el mensaje se lee en voz alta', () => {
    expect(motivoNoCerrable(estado({ lineas: [linea('L1', 3)] }))).toBe('Faltan 1 renglón por fechar.');
    expect(motivoNoCerrable(estado({ lineas: [linea('L1', 3), linea('L2', 1)] }))).toBe('Faltan 2 renglones por fechar.');
    expect(motivoNoCerrable(estado({ lotes: [lote('a|1', 2)] }))).toBe('Faltan 1 lote por acomodar.');
    expect(motivoNoCerrable(estado({ lotes: [lote('a|1', 2), lote('b|2', 1)] }))).toBe('Faltan 2 lotes por acomodar.');
  });

  it('el congelamiento también explica por qué no se puede cerrar', () => {
    const e = estado({ congeladoPorFolio: 'INV-2026-00009' });
    expect(motivoNoCerrable(e)).toContain('INV-2026-00009');
  });

  it('sin pendientes, no hay motivo', () => {
    const e = estado({ lineas: [linea('L1', 0)], lotes: [] });
    expect(motivoNoCerrable(e)).toBeNull();
  });
});

describe('avance — el encabezado muestra las dos mitades del trabajo', () => {
  it('todo fechado pero nada acomodado NO es 100%', () => {
    // Es el error que hace que la mercancía se quede sin rack: un vale que se
    // ve completo cuando todavía hay cajas en el piso.
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 0)],
      lotes: [lote('a|1', 5, null, 'L1'), lote('b|2', 3, null, 'L2')],
    });
    const a = avance(e);
    expect(a.renglonesListos).toBe(2);
    expect(a.lotesPorAcomodar).toBe(2);
    expect(a.fraccion).toBe(0.5);
    expect(a.todoListo).toBe(false);
  });

  it('con todo hecho, 100% y todoListo', () => {
    const e = estado({ lineas: [linea('L1', 0)], lotes: [lote('a|1', 0, 'R-01', 'L1')] });
    const a = avance(e);
    expect(a.fraccion).toBe(1);
    expect(a.todoListo).toBe(true);
  });

  it('un vale sin renglones es 0%, no 100%: está sin cargar, no completo', () => {
    const a = avance(estado());
    expect(a.fraccion).toBe(0);
    expect(a.todoListo).toBe(false);
  });

  it('a mitad de camino la fracción cuenta fechado + acomodado', () => {
    const e = estado({
      lineas: [linea('L1', 0), linea('L2', 4)],
      lotes: [lote('a|1', 0, 'R-01', 'L1'), lote('b|2', 7, null, 'L1')],
    });
    expect(avance(e).fraccion).toBe(0.5);
  });
});
