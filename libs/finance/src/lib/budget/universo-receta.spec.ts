import { ejesDesalineados, recetaLegible, UniversoReceta } from './universo-receta';

/**
 * `[TES.20]` **El candado de la receta — y el criterio de aceptación lo puso el auditor:**
 * *«si frena tres de cuatro, no sirve: la que falte es por donde va a volver a pasar».*
 *
 * Por eso los cuatro ejes se prueban **uno por uno**, cada uno con su **control positivo** al
 * lado. Sin el control, una función que devolviera «desalineado» SIEMPRE pasaría los cuatro
 * casos negativos y se vería perfecta — es el defecto de `test-authz-route-coverage` sobre
 * conjunto vacío que el proyecto ya tiene registrado.
 *
 * Los cuatro casos NO son inventados: son las cuatro derivaciones rotas del 2026-10-10.
 */

const MERC_00_05: UniversoReceta = {
  sucursales: ['00', '01', '02', '03', '04', '05'],
  ventana_dias: null, grupo: 'mercancia', dedup: 'sin_duplicados_conocidos',
  fuente: 'analytics.v_supplier_payables',
};
const COMPRAS_00_05: UniversoReceta = {
  sucursales: ['00', '01', '02', '03', '04', '05'],
  ventana_dias: 90, grupo: 'mercancia', dedup: 'deduplicado',
  fuente: 'analytics.erp_goods_receipts',
};

describe('[TES.20] la receta de un cociente', () => {
  it('⭐ CONTROL POSITIVO: universos alineados -> se puede emitir', () => {
    expect(ejesDesalineados(MERC_00_05, COMPRAS_00_05)).toEqual([]);
  });

  it('⭐ CONTROL POSITIVO: un STOCK contra un FLUJO no es desalineación — es la forma del DPO', () => {
    expect(MERC_00_05.ventana_dias).toBeNull();
    expect(COMPRAS_00_05.ventana_dias).toBe(90);
    expect(ejesDesalineados(MERC_00_05, COMPRAS_00_05).some((e) => e.eje === 'ventana')).toBe(false);
  });

  // ── Los cuatro casos reales, uno por eje ──────────────────────────────

  it('⛔ EJE 3 (grupo) — el defecto del 77.3: toda la deuda ÷ sólo recepciones de mercancía', () => {
    const todaLaDeuda = { ...MERC_00_05, grupo: 'todos' };
    const ejes = ejesDesalineados(todaLaDeuda, COMPRAS_00_05);
    expect(ejes.map((e) => e.eje)).toContain('grupo');
    expect(ejes[0].numerador).toBe('todos');
  });

  it('⛔ EJE 1 (sucursales) — numerador recortado a 00-05 y denominador con las nueve', () => {
    const compraTodas = { ...COMPRAS_00_05, sucursales: ['00', '01', '02', '03', '04', '05', '06', '07', '08'] };
    expect(ejesDesalineados(MERC_00_05, compraTodas).map((e) => e.eje)).toContain('sucursales');
  });

  it('⛔ EJE 2 (ventana) — dos FLUJOS con ventanas distintas no se dividen (el 54.6 contra el 48.8)', () => {
    const flujo90 = { ...COMPRAS_00_05, ventana_dias: 90 };
    const flujo365 = { ...COMPRAS_00_05, ventana_dias: 365 };
    expect(ejesDesalineados(flujo90, flujo365).map((e) => e.eje)).toContain('ventana');
  });

  it('⛔ EJE 4 (dedup) — dejar adentro duplicados que la fuente MARCA (el 45.9: $16,772,238.39)', () => {
    const conDup = { ...COMPRAS_00_05, dedup: 'con_duplicados' as const };
    const ejes = ejesDesalineados(MERC_00_05, conDup);
    expect(ejes.map((e) => e.eje)).toContain('dedup');
    expect(ejes.find((e) => e.eje === 'dedup')!.por_que).toContain('dos veces');
  });

  it('⛔ EJE 4 — y «no se midió» tampoco pasa: la ausencia se declara, no se asume', () => {
    const sinMedir = { ...MERC_00_05, dedup: 'sin_medir' as const };
    expect(ejesDesalineados(sinMedir, COMPRAS_00_05).map((e) => e.eje)).toContain('dedup');
  });

  it('⭐ EJE 4 — la ASIMETRÍA correcta SÍ pasa: deduplicado ÷ sin_duplicados_conocidos', () => {
    // Medido el 2026-10-10: el denominador trae duplicados marcados y el numerador no tiene.
    // Exigir «los dos deduplicados» habría frenado el único cociente bien construido.
    expect(ejesDesalineados(MERC_00_05, COMPRAS_00_05).some((e) => e.eje === 'dedup')).toBe(false);
  });

  it('el orden de las sucursales NO cambia el veredicto', () => {
    const desordenado = { ...MERC_00_05, sucursales: ['05', '00', '03', '01', '04', '02'] };
    expect(ejesDesalineados(desordenado, COMPRAS_00_05)).toEqual([]);
  });

  it('acumula TODOS los ejes rotos, no se detiene en el primero', () => {
    const roto = { ...MERC_00_05, grupo: 'todos', sucursales: ['00'], dedup: 'con_duplicados' as const };
    expect(ejesDesalineados(roto, COMPRAS_00_05).map((e) => e.eje).sort())
      .toEqual(['dedup', 'grupo', 'sucursales']);
  });

  it('la receta legible trae los cuatro ejes de los dos lados', () => {
    const r = recetaLegible(MERC_00_05, COMPRAS_00_05);
    expect(r).toContain('mercancia');
    expect(r).toContain('00,01,02,03,04,05');
    expect(r).toContain('90 d');
    expect(r).toContain('stock');
    expect(r).toContain('deduplicado');
  });
});
