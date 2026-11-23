/**
 * `[RH.15.3]` El lector de relojes NO da por enviadas checadas que la Suite no guardó.
 *
 * LFT 804-III/805: si la empresa no exhibe los controles de asistencia, se presume lo que dice el trabajador. Una
 * checada que se pierde entre el reloj y la Suite es un control que ya no se puede exhibir.
 *
 * Antes: con un 401/403 (llave rechazada) el lector marcaba el lote como enviado, pero la API rechaza la llave ANTES
 * de guardar nada: las checadas se perdían. Con un 409 (reloj sin dar de alta) sí es correcto confirmarlo, porque la
 * API archiva el lote crudo y se reprocesa al darlo de alta.
 *
 * Se prueba el código REAL del lector (`database/importers/checadores/agente/`), con la red y la cola simuladas.
 */
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const AGENTE = path.join(RAIZ, 'database/importers/checadores/agente');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Enviador, ErrorEnvio } = require(path.join(AGENTE, 'enviar.js'));
// `reloj.js` carga `node-zklib` (el protocolo de los relojes), que sólo está en la imagen del lector. El ciclo de
// envío que se prueba no habla con ningún reloj: se carga con una librería vacía en su lugar y se restaura enseguida.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Modulo = require('module') as { _load: (req: string, ...r: unknown[]) => unknown };
const cargaOriginal = Modulo._load;
Modulo._load = function (req: string, ...r: unknown[]) {
  return req === 'node-zklib' || req.startsWith('node-zklib/') ? function ZKVacio() { /* sin reloj */ } : cargaOriginal.call(this, req, ...r);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RelojJob } = require(path.join(AGENTE, 'reloj.js'));
Modulo._load = cargaOriginal;

type Fila = { id: number; codigo: string; fechaHora: string; tipo: number };

/** Una cola en memoria con lo que usa `vaciarColaInterno`. */
function colaFalsa(filas: Fila[]) {
  const confirmadas = new Set<number>();
  return {
    confirmadas,
    pendientes: (_serie: string, n: number) => filas.filter((f) => !confirmadas.has(f.id)).slice(0, n),
    confirmar: (ids: number[]) => ids.forEach((i) => confirmadas.add(i)),
    subirMarca: () => undefined,
  };
}

/** Un `fetch` que contesta siempre `status`. */
const fetchQueContesta = (status: number, cuerpo: unknown = {}) => async () =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(cuerpo) }) as unknown as Response;

const enviador = () => new Enviador({ apiUrl: 'http://api.prueba/x', token: 't' }, () => undefined);

describe('[RH.15.3] el lector no pierde checadas que la Suite no guardó', () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; vi.useRealTimers(); });

  it.each([401, 403])('un %i (llave rechazada) se REINTENTA: la API no guardó nada', async (status) => {
    globalThis.fetch = fetchQueContesta(status) as typeof fetch;
    const e = await enviador().enviarLote({ serie: 'S1', checadas: [] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorEnvio);
    expect([(e as { status: number }).status, (e as { reintentable: boolean }).reintentable]).toEqual([status, true]);
  });

  it('un 409 (reloj sin dar de alta) NO se reintenta: la API ya archivó el lote crudo', async () => {
    globalThis.fetch = fetchQueContesta(409, { mensaje: 'serie sin registrar' }) as typeof fetch;
    const e = await enviador().enviarLote({ serie: 'S1', checadas: [] }).catch((x: unknown) => x);
    expect((e as { reintentable: boolean }).reintentable).toBe(false);
  });

  /** El ciclo de envío del lector, con la red contestando `status`. */
  async function vaciarCon(status: number) {
    vi.useFakeTimers();
    globalThis.fetch = fetchQueContesta(status, { aceptadas: 2 }) as typeof fetch;
    const cola = colaFalsa([
      { id: 1, codigo: '15', fechaHora: '2026-11-17T08:00:00', tipo: 0 },
      { id: 2, codigo: '16', fechaHora: '2026-11-17T08:05:00', tipo: 0 },
    ]);
    const job = new RelojJob({ serie: 'S1', ip: '10.0.0.1', puerto: 4370, alias: 'Prueba' },
      { cola, enviador: enviador(), intervalos: {}, log: () => undefined });
    await job.vaciarColaInterno({});
    return cola.confirmadas.size;
  }

  it('con un 401, las dos checadas SIGUEN en la cola (antes se confirmaban y se perdían)', async () => {
    expect(await vaciarCon(401)).toBe(0);
  });
  it('con un 409, se confirman (quedaron archivadas en la API)', async () => {
    expect(await vaciarCon(409)).toBe(2);
  });
  it('con un 200, se confirman (control: el ciclo sí vacía la cola)', async () => {
    expect(await vaciarCon(200)).toBe(2);
  });
});
