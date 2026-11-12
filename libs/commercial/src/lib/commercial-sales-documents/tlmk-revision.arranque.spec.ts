import 'reflect-metadata';
import { CANAL_FUENTE_KEPLER, PgListenService } from '@megadulces/platform-core';
import { AlertsService } from '../commercial-alerts/alerts.service';
import { CommercialSalesDocumentsModule } from './commercial-sales-documents.module';
import { TlmkRevisionService } from './tlmk-revision.service';
import { REGLA_FACTOR_EMBARQUE } from './tlmk-revision.reglas';

/**
 * `[AX.22]` — La revisión TM escucha `caja_fuente` y avisa por la campana. **Que compile no es que
 * arranque** (`[CB.53.1]`, `#414`): el grafo del módulo se lee de sus decoradores (vitest no emite
 * `design:paramtypes`). Y el aviso se prueba con dobles: sólo el hallazgo NUEVO avisa, lo viejo no, y
 * sin cotización de la Suite no hay a quién.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[AX.22] el grafo de CommercialSalesDocumentsModule cierra con la revisión TM', () => {
  it('el constructor toma 5 dependencias (si cambia, revisar el arranque)', () => {
    expect(TlmkRevisionService.length).toBe(5);
  });
  it('la revisión está entre los providers (si no, nadie escucha)', () => {
    expect(meta<unknown>('providers', CommercialSalesDocumentsModule)).toContain(TlmkRevisionService);
  });
  it('⛔ PgListenService y AlertsService están al alcance del módulo', () => {
    const a = alcanceDe(CommercialSalesDocumentsModule);
    expect(a.has(PgListenService)).toBe(true);
    expect(a.has(AlertsService)).toBe(true);
  });
  it('PRUEBA NEGATIVA: sin el import de alertas, AlertsService queda fuera', () => {
    class SinAlertas {}
    Reflect.defineMetadata('providers', [TlmkRevisionService, PgListenService], SinAlertas);
    Reflect.defineMetadata('imports', [], SinAlertas);
    expect(alcanceDe(SinAlertas).has(AlertsService)).toBe(false);
  });
  it('no hay reloj: ningún método lleva metadata de @nestjs/schedule', () => {
    const relojes = Object.getOwnPropertyNames(TlmkRevisionService.prototype).flatMap((k) => {
      const v = (TlmkRevisionService.prototype as unknown as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });
    expect(relojes).toEqual([]);
  });
});

const conEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
  const antes: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { antes[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const nuevoListen = () => ({ escuchar: vi.fn().mockReturnValue(() => undefined) });

describe('[AX.22] quién escucha', () => {
  it('en los pods de api escucha el canal de Kepler; en el worker no', async () => {
    await conEnv({ WORKER: 'false', DISABLE_TLMK_REVISION: undefined }, () => {
      const l = nuevoListen();
      const s = new TlmkRevisionService({} as never, {} as never, l as never, {} as never, { pushFindings: vi.fn() } as never);
      s.onModuleInit();
      expect(l.escuchar).toHaveBeenCalledTimes(1);
      expect(l.escuchar.mock.calls[0][0]).toBe(CANAL_FUENTE_KEPLER);
      s.onModuleDestroy();
    });
    await conEnv({ WORKER: 'true', DISABLE_TLMK_REVISION: undefined }, () => {
      const l = nuevoListen();
      new TlmkRevisionService({} as never, {} as never, l as never, {} as never, { pushFindings: vi.fn() } as never).onModuleInit();
      expect(l.escuchar).not.toHaveBeenCalled();
    });
  });
  it('sin bandeja ligada no escucha (y lo dice), en vez de revisar para nadie', async () => {
    await conEnv({ WORKER: 'false', DISABLE_TLMK_REVISION: undefined }, () => {
      const l = nuevoListen();
      new TlmkRevisionService({} as never, {} as never, l as never, {} as never, undefined).onModuleInit();
      expect(l.escuchar).not.toHaveBeenCalled();
    });
  });
});

describe('[AX.22] el aviso: sólo lo nuevo, sólo lo reciente, sólo a quien levantó la cotización', () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const CHILITO = {
    sucursal: '06', doc_type: 41, serie: 1, folio: '0001823',
    sku: '95644', captured_unit: 'CJA', captured_qty: 10, captured_factor: 40, base_qty: 400, base_unit: 'PAQ',
    base_unit_price: 35.97, current_factor: 25, status: 'factor_cambio', qty_in_current_unit: 16, base_qty_at_current_factor: 250,
  };
  const embarque = (fecha: string, comentario: string | null) => ({
    sucursal: '06', doc_type: 41, serie: 1, folio: '0001823', fecha, modificado: fecha,
    cliente: 'C3025', comentario, cancelado: false, o_tipo: 40, o_serie: 1, o_folio: '0001608',
  });

  function armar(opts: { fecha: string; comentario: string | null; insertado: boolean }) {
    const knex = Object.assign(() => ({ where: () => ({ select: async () => [{ id: 't1' }] }) }), { raw: vi.fn() });
    const alerts = { emitTo: vi.fn() };
    const sink = { pushFindings: vi.fn().mockResolvedValue({ inserted: opts.insertado ? 1 : 0, skipped: 0 }) };
    const s = new TlmkRevisionService(knex as never, {} as never, nuevoListen() as never, alerts as never, sink as never);
    const x = s as unknown as Record<string, unknown>;
    x['documentos'] = async () => [embarque(opts.fecha, opts.comentario)];
    x['cabecerasPorLlave'] = async () => [];
    x['pedidosEmbarcados'] = async () => new Set<string>();
    x['renglones'] = async () => new Map([['06|41|1|0001823', [CHILITO]]]);
    x['facturasDe'] = async () => new Map();
    x['autores'] = async (_t: string, cots: string[]) => new Map(cots.map((c) => [c, 'operadora.tm']));
    return { s, alerts, sink };
  }

  it('hallazgo NUEVO de hoy en un pedido de la Suite → a la bandeja y a la campana de quien cotizó', async () => {
    const { s, alerts, sink } = armar({ fecha: hoy, comentario: 'COT-2026-00412', insertado: true });
    const r = await s.revisar();
    expect(sink.pushFindings).toHaveBeenCalledTimes(1);
    expect(sink.pushFindings.mock.calls[0][1][0].rule_key).toBe(REGLA_FACTOR_EMBARQUE);
    expect(alerts.emitTo).toHaveBeenCalledTimes(1);
    expect(alerts.emitTo.mock.calls[0][1]).toBe('operadora.tm');
    expect(alerts.emitTo.mock.calls[0][2].type).toBe('tlmk_documento');
    expect(alerts.emitTo.mock.calls[0][2].message).toContain('la factura dirá 16 CJA');
    expect(r).toMatchObject({ hallazgos: 1, nuevos: 1, avisos: 1 });
  });

  it('NEGATIVA — ya estaba en la bandeja (la otra réplica lo insertó) → NO se repite el aviso', async () => {
    const { s, alerts } = armar({ fecha: hoy, comentario: 'COT-2026-00412', insertado: false });
    await s.revisar();
    expect(alerts.emitTo).not.toHaveBeenCalled();
  });

  it('NEGATIVA — documento viejo (recogido al arrancar) → entra callado a la bandeja', async () => {
    const { s, alerts, sink } = armar({ fecha: '2026-10-29', comentario: 'COT-2026-00412', insertado: true });
    await s.revisar();
    expect(sink.pushFindings).toHaveBeenCalledTimes(1);
    expect(alerts.emitTo).not.toHaveBeenCalled();
  });

  it('NEGATIVA — pedido capturado directo en Kepler (sin COT-) → bandeja sí, campana no', async () => {
    const { s, alerts, sink } = armar({ fecha: hoy, comentario: '40  CAJAS  A-4', insertado: true });
    await s.revisar();
    expect(sink.pushFindings).toHaveBeenCalledTimes(1);
    expect(alerts.emitTo).not.toHaveBeenCalled();
  });
});
