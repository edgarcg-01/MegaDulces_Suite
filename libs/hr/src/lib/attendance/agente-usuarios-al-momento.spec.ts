/**
 * `[RH.17.1]` Los nombres del checador llegan a la Suite en cuanto cambian, no hasta que el agente se reinicia.
 *
 * El aviso de cada checada trae el número, no el nombre; la lista de usuarios sólo viajaba con la lectura completa del
 * reloj, y desde `[RH.1.3]` los relojes que avisan ya no la hacen cada hora. Medido en prod el 19-nov-2026: 11 personas
 * dadas de alta después del último arranque salían en /rh/asistencia como «Empleado 109».
 *
 * Se prueba el código REAL del lector (`database/importers/checadores/agente/reloj.js`), con el reloj y la red simulados.
 */
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const AGENTE = path.join(RAIZ, 'database/importers/checadores/agente');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ErrorEnvio } = require(path.join(AGENTE, 'enviar.js'));
// `reloj.js` carga `node-zklib`, que sólo está en la imagen del lector: se carga con una librería vacía (igual que en
// `agente-envio-no-pierde.spec.ts`) y se restaura enseguida.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Modulo = require('module') as { _load: (req: string, ...r: unknown[]) => unknown };
const cargaOriginal = Modulo._load;
Modulo._load = function (req: string, ...r: unknown[]) {
  return req === 'node-zklib' || req.startsWith('node-zklib/') ? function ZKVacio() { /* sin reloj */ } : cargaOriginal.call(this, req, ...r);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RelojJob } = require(path.join(AGENTE, 'reloj.js'));
Modulo._load = cargaOriginal;

type Lote = { usuarios?: Array<{ codigo: string; nombre: string }>; checadas: unknown[]; completa: boolean };

/** Un reloj con `userCounts` usuarios y la lista dada, y una Suite que contesta con `falla` (o bien). */
function armar(opts: { userCounts: number; lista: Array<{ userId: string; name: string }>; vistos?: number | null }) {
  const lotes: Lote[] = [];
  let falla: unknown = null;
  const info = { logCounts: 500, userCounts: opts.userCounts };
  const enviador = {
    enviarLote: vi.fn(async (l: Lote) => { if (falla) throw falla; lotes.push(l); return { ok: true }; }),
    callado: () => 0,
    latido: vi.fn(async () => undefined),
  };
  const job = new RelojJob({ serie: 'S1', ip: '10.0.0.1', puerto: 4370, alias: 'Prueba' },
    { cola: { encolar: () => 0 }, enviador, intervalos: {}, log: () => undefined });
  job.corriendo = true;
  job.zk = { getInfo: async () => ({ ...info }) };
  job.usuariosVistos = opts.vistos === undefined ? opts.userCounts : opts.vistos;
  const lecturas = vi.fn(async () => opts.lista);
  job.leerListaUsuarios = lecturas;
  return {
    job, lotes, lecturas, info,
    fallarCon: (e: unknown) => { falla = e; },
    checar: (codigo: string) => job.alChecada({ deviceUserId: codigo, recordTime: new Date('2026-11-19T08:00:00') }),
  };
}

const LISTA = [{ userId: '108', name: 'PERSONA A' }, { userId: '109', name: 'PERSONA B' }];

describe('[RH.17.1] la lista de usuarios del reloj a la Suite, en cuanto cambia', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('control: si nada cambió, NO lee la lista ni manda nada (el disparador no queda siempre encendido)', async () => {
    const r = armar({ userCounts: 10, lista: LISTA });
    await r.job.vigilar();
    await r.job.vigilar();
    expect(r.lecturas).not.toHaveBeenCalled();
    expect(r.lotes).toHaveLength(0);
  });

  it('⭐ alguien se da de alta en el reloj (userCounts 10 → 11): manda la lista con su nombre, sin checadas', async () => {
    const r = armar({ userCounts: 11, lista: LISTA, vistos: 10 });
    await r.job.vigilar();
    expect(r.lotes).toHaveLength(1);
    expect(r.lotes[0].usuarios).toEqual([{ codigo: '108', nombre: 'PERSONA A' }, { codigo: '109', nombre: 'PERSONA B' }]);
    expect(r.lotes[0].checadas).toEqual([]);
    expect(r.lotes[0].completa).toBe(false);   // no es la lectura completa: no debe mover `last_backfill_at`
    await r.job.vigilar();                      // ya mandada: la siguiente vuelta no la repite
    expect(r.lecturas).toHaveBeenCalledTimes(1);
  });

  it('⭐ checa un número que no venía en la lista: la siguiente vuelta la manda; uno conocido no la vuelve a pedir', async () => {
    const r = armar({ userCounts: 10, lista: LISTA });
    r.checar('109');                            // aún no se manda ninguna lista: todo número es desconocido
    await r.job.vigilar();
    expect(r.lotes).toHaveLength(1);
    r.checar('109');                            // ya está en la lista mandada
    r.checar('108');
    await r.job.vigilar();
    expect(r.lecturas).toHaveBeenCalledTimes(1);
    r.checar('200');                            // alta que no movió el conteo (alta + baja a la vez)
    await r.job.vigilar();
    expect(r.lecturas).toHaveBeenCalledTimes(2);
    r.checar('200');                            // no venía en el reloj: no la pide en cada checada
    await r.job.vigilar();
    expect(r.lecturas).toHaveBeenCalledTimes(2);
  });

  it('si la Suite no la recibe, NO se da por mandada: reintenta pasados 5 min, no en cada vuelta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T08:00:00'));
    const r = armar({ userCounts: 11, lista: LISTA, vistos: 10 });
    r.fallarCon(new ErrorEnvio('la API contestó 503', { status: 503 }));
    await r.job.vigilar();
    expect(r.lotes).toHaveLength(0);
    expect(r.job.usuariosVistos).toBe(10);
    await r.job.vigilar();                      // 30 s después: todavía no
    expect(r.lecturas).toHaveBeenCalledTimes(1);
    r.fallarCon(null);
    vi.setSystemTime(new Date('2026-11-19T08:05:01'));
    await r.job.vigilar();
    expect(r.lotes).toHaveLength(1);
    expect(r.job.usuariosVistos).toBe(11);
  });

  it('un 409 (reloj sin dar de alta) no se repite cada 5 min: la API ya archivó el lote', async () => {
    const r = armar({ userCounts: 11, lista: LISTA, vistos: 10 });
    r.fallarCon(new ErrorEnvio('serie sin registrar', { status: 409, reintentable: false }));
    await r.job.vigilar();
    expect(r.job.usuariosVistos).toBe(11);
    expect(r.job.usuariosEnEspera).toBe(false);
  });

  it('si el reloj no contesta la lectura, suelta el candado y reconecta (como los comandos)', async () => {
    const r = armar({ userCounts: 11, lista: LISTA, vistos: 10 });
    r.lecturas.mockRejectedValueOnce(new Error('socket cerrado'));
    const reconectar = vi.fn(async () => undefined);
    r.job.reconectar = reconectar;
    await r.job.vigilar();
    expect(reconectar).toHaveBeenCalledTimes(1);
    expect(r.job.ocupado).toBe(false);
    expect(r.job.usuariosVistos).toBe(10);
  });

  it('con el candado tomado (backfill o comando en curso) no lee: queda pendiente para la siguiente vuelta', async () => {
    const r = armar({ userCounts: 10, lista: LISTA });
    r.checar('109');
    r.job.ocupado = true;
    await r.job.refrescarUsuarios('prueba', r.info);
    expect(r.lecturas).not.toHaveBeenCalled();
    expect(r.job.usuariosEnEspera).toBe(true);
  });
});
