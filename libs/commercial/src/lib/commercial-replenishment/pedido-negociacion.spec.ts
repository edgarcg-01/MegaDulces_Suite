import { type EntradaFila, type FichaCostoFila, factorBase, resumirCosto, resumirPagado } from './pedido-negociacion';
import 'reflect-metadata';
import { PedidoNegociacionService } from './pedido-negociacion.service';
import { PedidoNegociacionController } from './pedido-negociacion.controller';
import { CommercialReplenishmentModule } from './commercial-replenishment.module';

/**
 * `[RA-NEG.1]` La parte PURA del panel «Costo y negociación».
 *
 * ⚠️ **Qué NO afirma este archivo:** que el SQL traiga lo que debe. Un doble de Knex no ejecuta SQL;
 * eso lo prueba `database/tests/test-newdb-pedido-negociacion.js` contra una base real. Acá se prueba
 * la conversión a unidad base, el resumen y que Nest pueda construir el servicio.
 */
const ESC = { u1: 'PAQ', u2: 'PAQ', u3: 'CJA', f2: 1, f3: 16 };
const e = (fecha: string, plaza: string, costo: number, cantidad = 160, unidad: string | null = 'PAQ'): EntradaFila => ({ fecha, plaza, unidad, cantidad, costo });

describe('factorBase', () => {
  it('convierte con la escalera de la ficha', () => {
    expect(factorBase('PAQ', ESC)).toBe(1);
    expect(factorBase('cja', ESC)).toBe(16);
  });
  it('una unidad que la ficha no conoce NO se adivina', () => {
    expect(factorBase('PZA', ESC)).toBeNull();
    expect(factorBase(null, ESC)).toBeNull();
  });
});

describe('resumirPagado', () => {
  const filas = [
    e('2026-01-28', '08', 89.29, 320), e('2026-06-29', '06', 72.44, 1280), e('2026-10-15', '08', 82.68, 1600),
    e('2026-10-14', '06', 78.595625, 320), e('2026-10-21', '06', 78.595, 960), e('2026-10-19', '01', 82.68, 160),
    e('2026-10-10', '03', 1322.88, 10, 'CJA'),
  ];
  const r = resumirPagado(filas, ESC, 78.595625, '2025-10-22', '2026-10-22');

  it('promedia por mes en la unidad base, convirtiendo la caja', () => {
    const oct = r.meses.find((m) => m.mes === '2026-10')!;
    expect(oct.base).toBe(1600 + 320 + 960 + 160 + 160);   // las 10 cajas son 160 paquetes
    expect(oct.min).toBeCloseTo(78.595, 3);
    expect(oct.max).toBeCloseTo(82.68, 2);
  });

  it('último y mínimo, con su plaza', () => {
    expect(r.ultimo).toEqual({ fecha: '2026-10-21', sucursal: '06', costo_base: 78.595 });
    expect(r.minimo).toMatchObject({ fecha: '2026-06-29', sucursal: '06', costo_base: 72.44 });
  });

  it('marca la plaza que registró AL ESTÁNDAR mientras la mayoría pagó otra cosa', () => {
    expect(r.al_estandar_reciente).toEqual([{ sucursal: '06', entradas: 2, base: 1280, costo_base: 78.5956 }]);
  });

  it('CONTROL: si la mayoría reciente también paga el estándar, no hay nada que confirmar', () => {
    const todas = resumirPagado([e('2026-10-14', '06', 78.595625), e('2026-10-15', '08', 78.595625)], ESC, 78.595625, '2025-10-22', '2026-10-22');
    expect(todas.al_estandar_reciente).toEqual([]);
  });

  it('un renglón a centavo es atípico: fuera del mínimo y contado', () => {
    const x = resumirPagado([...filas, e('2026-02-18', '08', 0.0006, 192)], ESC, 78.595625, '2025-10-22', '2026-10-22');
    expect(x.renglones_atipicos).toBe(1);
    expect(x.minimo!.costo_base).toBe(72.44);
  });

  it('la unidad desconocida se cuenta y no se suma', () => {
    const x = resumirPagado([e('2026-10-01', '01', 5, 100, 'PZA')], ESC, 78.6, '2025-10-22', '2026-10-22');
    expect(x.renglones_sin_unidad).toBe(1);
    expect(x.total_base).toBe(0);
    expect(x.ultimo).toBeNull();
  });
});

describe('resumirCosto', () => {
  const f = (sucursal: string, over: Partial<FichaCostoFila> = {}): FichaCostoFila => ({
    sucursal, costo_estandar: 78.6, costo_estandar_u3: 1257.53, factor_tres: 16, costo_reposicion_base: 82.68, precio_ficha: 102.94,
    impuesto_pct: 8, margen_ficha_pct: 21.27, precio_si_conserva_margen: 108.29, impacto_cogs_30d: 0, venta_neta_30d: 1000,
    veredicto: 'al_dia', ...over,
  });

  it('el estándar sale de la CAJA, no del redondeo de la base', () => {
    expect(resumirCosto([f('01')]).estandar_base).toBeCloseTo(78.595625, 6);
  });

  it('referencia = la que más vende; impacto = suma de las afectadas', () => {
    const c = resumirCosto([
      f('08', { venta_neta_30d: 202207, veredicto: 'estandar_bajo', impacto_cogs_30d: 9477.84 }),
      f('06', { venta_neta_30d: 50763, costo_reposicion_base: 78.6, precio_si_conserva_margen: 102.94 }),
      f('01', { venta_neta_30d: 102033, veredicto: 'estandar_bajo', impacto_cogs_30d: 4528.8 }),
    ]);
    expect(c.reposicion_base).toBe(82.68);
    expect(c.impacto_30d).toBe(14006.64);
    expect(c.sucursales_afectadas).toEqual(['01', '08']);
    expect(c.precio_conserva_margen).toBe(108.29);
  });

  it('el precio que conserva el margen se lee donde el estándar quedó abajo, no en una al día', () => {
    const c = resumirCosto([
      f('06', { venta_neta_30d: 999999, precio_si_conserva_margen: 102.94 }),
      f('08', { venta_neta_30d: 1000, veredicto: 'estandar_bajo', impacto_cogs_30d: 50, precio_si_conserva_margen: 108.29 }),
    ]);
    expect(c.precio_conserva_margen).toBe(108.29);
  });

  it('dos precios distintos entre sucursales se declaran', () => {
    expect(resumirCosto([f('01'), f('02', { precio_ficha: 108.3 })]).precio_igual_en_todas).toBe(false);
  });
});

describe('PedidoNegociacionService — arranque', () => {
  // Lección de #414: un decorador mal puesto tira la API con el CI en verde.
  // ⛔ Acá NO se lee `design:paramtypes`: vitest transpila sin `emitDecoratorMetadata` y la clave
  // llega vacía (ver `finance-bank.module.arranque.spec.ts`). Se verificó aparte con ts-node y
  // metadata encendida: [TenantKnexService, TenantContextService, TenantCacheService].
  it('el constructor toma sus tres dependencias', () => {
    expect(PedidoNegociacionService.length).toBe(3);
  });
  it('el módulo provee el servicio y expone el controlador', () => {
    const meta = (k: string) => (Reflect as unknown as { getMetadata(k: string, o: object): unknown[] }).getMetadata(k, CommercialReplenishmentModule) ?? [];
    expect(meta('providers')).toContain(PedidoNegociacionService);
    expect(meta('controllers')).toContain(PedidoNegociacionController);
  });
});
