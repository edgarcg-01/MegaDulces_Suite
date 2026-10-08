import { readFileSync } from 'fs';
import { join } from 'path';
import { avance, motivoNoCerrable, siguientePaso, FlujoEstado, FlujoLinea } from './anden-flujo';

/**
 * Candados del flujo del Andén.
 *
 * Cada bloque prueba UNA regla. `[WMS-REC.21]` La R2 (acomodar el lote recién fechado)
 * se retiró el 2026-10-07: acomodar pasó a Ubicaciones («Por acomodar»). El último
 * bloque cuida que no vuelva a entrar por la puerta de atrás.
 */

const linea = (id: string, faltaFechar: number): FlujoLinea => ({ id, faltaFechar });

const estado = (p: Partial<FlujoEstado> = {}): FlujoEstado => ({
  valeAbierto: true,
  valeCerrado: false,
  congeladoPorFolio: null,
  lineas: [],
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

describe('R3 — nunca devolver a una lista: siempre hay siguiente paso', () => {
  it('mientras haya etiquetas que leer, fechar es la prioridad', () => {
    const e = estado({ lineas: [linea('L1', 0), linea('L2', 4), linea('L3', 7)] });
    expect(siguientePaso(e)).toEqual({ tipo: 'fechar', lineaId: 'L2' });
  });

  it('después de fechar un renglón sigue el SIGUIENTE renglón, no un lote', () => {
    // Antes de WMS-REC.21 el paso podía ser "ubicar" el lote recién fechado.
    const e = estado({ lineas: [linea('L1', 0), linea('L2', 5)] });
    expect(siguientePaso(e)).toEqual({ tipo: 'fechar', lineaId: 'L2' });
  });
});

describe('R4 — cerrar sólo cuando de verdad no queda nada por fechar', () => {
  it('sin pendientes, el paso es cerrar', () => {
    expect(siguientePaso(estado({ lineas: [linea('L1', 0)] }))).toEqual({ tipo: 'cerrar' });
  });

  it('un vale ya cerrado no vuelve a ofrecer cerrar', () => {
    const e = estado({ valeCerrado: true, lineas: [linea('L1', 0)] });
    expect(siguientePaso(e)).toEqual({ tipo: 'terminado' });
  });

  it('singular y plural, porque el mensaje se lee en voz alta', () => {
    expect(motivoNoCerrable(estado({ lineas: [linea('L1', 3)] }))).toBe('Faltan 1 renglón por fechar.');
    expect(motivoNoCerrable(estado({ lineas: [linea('L1', 3), linea('L2', 1)] }))).toBe('Faltan 2 renglones por fechar.');
  });

  it('el congelamiento también explica por qué no se puede cerrar', () => {
    const e = estado({ congeladoPorFolio: 'INV-2026-00009' });
    expect(motivoNoCerrable(e)).toContain('INV-2026-00009');
  });

  it('sin pendientes, no hay motivo', () => {
    expect(motivoNoCerrable(estado({ lineas: [linea('L1', 0)] }))).toBeNull();
  });
});

describe('avance — el encabezado muestra lo fechado', () => {
  it('con todo fechado, 100% y todoListo', () => {
    const a = avance(estado({ lineas: [linea('L1', 0), linea('L2', 0)] }));
    expect(a.fraccion).toBe(1);
    expect(a.todoListo).toBe(true);
  });

  it('a mitad de camino, la fracción son los renglones listos', () => {
    const a = avance(estado({ lineas: [linea('L1', 0), linea('L2', 4)] }));
    expect(a.renglonesListos).toBe(1);
    expect(a.fraccion).toBe(0.5);
    expect(a.todoListo).toBe(false);
  });

  it('un vale sin renglones es 0%, no 100%: está sin cargar, no completo', () => {
    const a = avance(estado());
    expect(a.fraccion).toBe(0);
    expect(a.todoListo).toBe(false);
  });
});

describe('[WMS-REC.21] el Andén ya no acomoda', () => {
  const FLUJO = readFileSync(join(__dirname, 'anden-flujo.ts'), 'utf8');
  const PANTALLA = readFileSync(join(__dirname, 'anden.component.ts'), 'utf8');

  it('el flujo no tiene paso de ubicar ni lotes', () => {
    expect(FLUJO).not.toMatch(/tipo: 'ubicar'/);
    expect(FLUJO).not.toMatch(/lotes:/);
  });

  it('la pantalla no pide la cola de acomodo, no acomoda y no crea ubicaciones', () => {
    expect(PANTALLA).not.toMatch(/\.unlocated\(/);
    expect(PANTALLA).not.toMatch(/\.putAway\(/);
    expect(PANTALLA).not.toMatch(/\.createBin\(/);
    expect(PANTALLA).not.toContain('app-anden-ubicacion');
  });

  it('la portada manda a acomodar a Ubicaciones, que tiene su sección «Por acomodar»', () => {
    expect(PANTALLA).toContain('routerLink="/almacen/inventory/ubicaciones"');
  });
});
