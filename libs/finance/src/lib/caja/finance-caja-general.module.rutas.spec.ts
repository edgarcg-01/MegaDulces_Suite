import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { FinanceCajaGeneralModule } from './finance-caja-general.module';

/**
 * `[LE.6.22]` — **Un controlador cuyo prefijo cuelga de otro va ANTES que él.**
 *
 * Nest registra las rutas en el orden de `controllers: [...]`. `CashLedgerController`
 * (`finance/cash-ledger`) termina en `@Get(':id')`, así que si se registra antes que
 * `CajaArqueoController` (`finance/cash-ledger/arqueos-caja`), `GET /cash-ledger/arqueos-caja`
 * lo atiende `detail('arqueos-caja')` y responde 500. Medido en prod (`analytics.ui_usage`,
 * 2026-10-23 → 11-06): la ruta de arqueos **nunca** registró una llamada y `:id` sumó 2,079
 * errores 5xx — la lista de arqueos de `/finanzas/caja-general` no cargaba.
 *
 * Se lee el orden de los decoradores, no se levanta el contenedor (ver
 * `finance-bank.module.arranque.spec.ts`: sin la infraestructura global `compile()` falla por otra cosa).
 */
describe('[LE.6.22] FinanceCajaGeneralModule · orden de controladores', () => {
  const controladores: Array<new (...a: never[]) => unknown> = Reflect.getMetadata('controllers', FinanceCajaGeneralModule) ?? [];
  const prefijo = (c: object) => String(Reflect.getMetadata(PATH_METADATA, c) ?? '').replace(/^\/+|\/+$/g, '');

  it('ningún controlador queda detrás de otro cuyo prefijo es el inicio del suyo', () => {
    expect(controladores.length).toBeGreaterThan(1);
    const tapados: string[] = [];
    controladores.forEach((tarde, j) => {
      for (const temprano of controladores.slice(0, j)) {
        const a = prefijo(temprano);
        if (a && prefijo(tarde).startsWith(`${a}/`)) tapados.push(`${tarde.name} (${prefijo(tarde)}) queda detrás de ${temprano.name} (${a})`);
      }
    });
    expect(tapados).toEqual([]);
  });

  it('los arqueos de caja se registran antes que el libro', () => {
    const nombres = controladores.map((c) => c.name);
    expect(nombres.indexOf('CajaArqueoController')).toBeGreaterThanOrEqual(0);
    expect(nombres.indexOf('CajaArqueoController')).toBeLessThan(nombres.indexOf('CashLedgerController'));
  });
});
