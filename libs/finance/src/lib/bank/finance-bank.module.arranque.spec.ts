import 'reflect-metadata';
import { PgListenService } from '@megadulces/platform-core';
import { FinanceBankModule } from './finance-bank.module';
import { BankReconPorAvisoService } from './bank-recon-aviso.service';
import { CANAL_CAJA } from '../caja/caja-realtime.service';

/**
 * `[CB.53.1]` — **Que compile no es que arranque.**
 *
 * El 2026-10-21, `BankReconPorAvisoService` entró con el typecheck en VERDE (*«No typescript
 * errors found»*) y tiró el arranque de Nest:
 *
 *     UnknownDependenciesException: Nest can't resolve dependencies of the
 *     BankReconPorAvisoService (KNEX_NEW_DB, TenantContextService, ?, FinanceBankService).
 *     Please make sure that the argument PgListenService at index [2] is available.
 *
 * `PgListenService` **no es global**: lo exporta `CajaRealtimeModule` a propósito, para que todos
 * los oyentes compartan la misma conexión `LISTEN` (`[CG.197]`). Faltaba importarlo. El
 * compilador no puede verlo —la inyección se resuelve en runtime— y es la misma familia del
 * incidente de arranque de #414, que tiró la API en producción con el CI en verde.
 *
 * ── Por qué este candado lee METADATA y no levanta el contenedor ────────────────────────────
 * El primer intento fue `Test.createTestingModule({ imports: [FinanceBankModule] }).compile()`.
 * No sirve acá: `FinanceBankService` depende de la infraestructura **global** de la app
 * (`TenantKnexService`, el sink de hallazgos…), que en un test aislado no existe, así que
 * `compile()` falla por algo que en producción está resuelto — un rojo que no es el defecto.
 * Mockear esos globales obligaría a mockear también `PgListenService`, y entonces el candado
 * dejaría de ver justo lo que vino a ver.
 *
 * Lo que sí es comprobable sin app: **que el proveedor que el servicio pide esté realmente al
 * alcance del módulo** — provisto por él o exportado por alguno de sus imports. Eso es el grafo
 * de Nest leído de sus decoradores, no un regex sobre el texto.
 *
 * ⚠️ Lo que este candado NO prueba: que el oyente reciba avisos, que `runMatch` concilie bien, ni
 * que `WORKER=true` esté puesto en el pod correcto.
 */


const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

/** Lo que el módulo tiene al alcance: lo que provee + lo que exportan sus imports. */
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) {
    for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  }
  return out;
}

describe('[CB.53.1] el grafo de FinanceBankModule cierra', () => {
  /**
   * ⛔ Acá NO se lee `design:paramtypes`, aunque sería lo natural: **vitest transpila sin
   * `emitDecoratorMetadata`**, así que esa clave llega VACÍA y el test pasaría (o fallaría) por
   * la configuración del runner, no por el código. Medido al escribir este candado: el primer
   * intento falló con `expected [] to include [Function PgListenService]`.
   *
   * Lo que sí se puede afirmar sin esa metadata: que el constructor sigue tomando cuatro
   * dependencias, y que la tercera es la que escucha (lo ejerce el bloque de abajo, que
   * construye el servicio y comprueba quién recibe `escuchar`).
   */
  it('el constructor del oyente sigue tomando sus cuatro dependencias', () => {
    expect(BankReconPorAvisoService.length).toBe(4);
  });

  it('⛔ y el módulo tiene PgListenService al alcance: lo exporta uno de sus imports', () => {
    expect(alcanceDe(FinanceBankModule).has(PgListenService)).toBe(true);
  });

  it('NO lo provee por su cuenta: eso abriría una segunda conexión LISTEN contra prod', () => {
    expect(meta<unknown>('providers', FinanceBankModule)).not.toContain(PgListenService);
  });

  it('el oyente está entre los providers del módulo (si no, no se instancia y nadie escucha)', () => {
    expect(meta<unknown>('providers', FinanceBankModule)).toContain(BankReconPorAvisoService);
  });

  it('PRUEBA NEGATIVA: sin el import que lo exporta, la comprobación se pone roja', () => {
    @Reflect.metadata('providers', [BankReconPorAvisoService])
    @Reflect.metadata('imports', [])
    class ModuloSinElImport {}
    expect(alcanceDe(ModuloSinElImport).has(PgListenService)).toBe(false);
  });
});

describe('[CB.53.1] sólo el worker se suscribe', () => {
  const conWorker = async (valor: string, fn: (escuchar: ReturnType<typeof vi.fn>) => void) => {
    const anterior = process.env.WORKER;
    process.env.WORKER = valor;
    try {
      const escuchar = vi.fn().mockReturnValue(() => undefined);
      const svc = new BankReconPorAvisoService({} as never, {} as never, { escuchar } as never, {} as never);
      svc.onModuleInit();
      fn(escuchar);
      svc.onModuleDestroy();
    } finally {
      if (anterior === undefined) delete process.env.WORKER; else process.env.WORKER = anterior;
    }
  };

  it('fuera del worker no se suscribe, y no revienta por eso', async () => {
    await conWorker('false', (escuchar) => expect(escuchar).not.toHaveBeenCalled());
  });

  it('en el worker se suscribe UNA vez, al canal del carril de Kepler', async () => {
    await conWorker('true', (escuchar) => {
      expect(escuchar).toHaveBeenCalledTimes(1);
      expect(escuchar.mock.calls[0][0]).toBe(CANAL_CAJA);
    });
  });
});
