/**
 * `[RH.1.3]` El lector de relojes ya no pregunta cada rato: la Suite le AVISA por una conexión abierta (SSE). Prueba
 * PURA del lado del lector (`database/importers/checadores/agente/avisos.js`), sin red ni relojes: corre en CI.
 * Lo que defiende: que lea bien el flujo aunque llegue partido, que ignore lo que no es un aviso, y que si la conexión
 * se cae vuelva a conectarse — y al volver, el primer aviso de la API es «ponte al día», así que nada se pierde.
 */
import fs from 'fs';
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const AGENTE = path.join(RAIZ, 'database/importers/checadores/agente');
const { partirSse, escucharAvisos } = require(path.join(AGENTE, 'avisos.js'));

/** Un cuerpo de respuesta que entrega los trozos dados y termina. */
function cuerpo(trozos: string[]) {
  const enc = new TextEncoder();
  return { async *[Symbol.asyncIterator]() { for (const t of trozos) yield enc.encode(t); } };
}

describe('[RH.1.3] avisos al lector — leer el flujo SSE', () => {
  it('saca los avisos completos y deja lo que no termina para el siguiente trozo', () => {
    const a = partirSse('event: padron\ndata: {"tipo":"padron"}\n\nevent: comando\ndata: {"tipo":"comando","se');
    expect(a.avisos).toEqual([{ tipo: 'padron' }]);
    const b = partirSse(a.resto + 'rie":"X1"}\n\n');
    expect(b.avisos).toEqual([{ tipo: 'comando', serie: 'X1' }]);
    expect(b.resto).toBe('');
  });

  it('ignora comentarios, bloques sin data y data que no es JSON; acepta \\r\\n', () => {
    expect(partirSse(': latido\n\nevent: x\n\ndata: no-json\n\ndata: {"tipo":"ponte_al_dia"}\r\n\r\n').avisos)
      .toEqual([{ tipo: 'ponte_al_dia' }]);
  });
});

describe('[RH.1.3] avisos al lector — la conexión', () => {
  it('⭐ se conecta con la llave del agente, atiende cada aviso en orden, y al caerse VUELVE a conectarse', async () => {
    const llamadas: Array<{ url: string; llave: string | null }> = [];
    const vistos: string[] = [];
    let parar: () => void = () => undefined;
    const termino = new Promise<void>((ok) => {
      const respuestas = [
        { ok: true, status: 200, body: cuerpo(['data: {"tipo":"ponte_al_dia"}\n\n', 'data: {"tipo":"comando","serie":"A1"}\n\n']) },
        { ok: false, status: 503, body: null },
        { ok: true, status: 200, body: cuerpo(['data: {"tipo":"ponte_al_dia"}\n\n']) },
      ];
      const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
        llamadas.push({ url, llave: init.headers['X-Agente-Token'] });
        const r = respuestas.shift();
        if (!r) { parar(); ok(); return { ok: false, status: 599, body: null }; }
        return r;
      };
      parar = escucharAvisos({
        apiUrl: 'http://api:10000/api/hr/attendance/ingest/mt', token: 'llave', log: () => undefined,
        alAviso: async (a: { tipo: string; serie?: string }) => { vistos.push(a.serie ? `${a.tipo}:${a.serie}` : a.tipo); },
        fetchImpl, esperar: async () => undefined,
      });
    });
    await termino;
    expect(llamadas[0]).toEqual({ url: 'http://api:10000/api/hr/attendance/ingest/mt/checador/ingesta/eventos', llave: 'llave' });
    expect(llamadas.length).toBeGreaterThanOrEqual(3);            // se cayó (fin del flujo, 503) y volvió
    expect(vistos).toEqual(['ponte_al_dia', 'comando:A1', 'ponte_al_dia']);
  });

  it('⛔ el lector ya no pregunta por reloj: sin setInterval de órdenes ni de padrón', () => {
    const reloj = fs.readFileSync(path.join(AGENTE, 'reloj.js'), 'utf8');
    const index = fs.readFileSync(path.join(AGENTE, 'index.js'), 'utf8');
    expect(reloj).not.toMatch(/setInterval\([\s\S]{0,80}atenderComandos/);
    expect(reloj).not.toContain('COMANDOS_MS');
    expect(index).not.toMatch(/setInterval\([\s\S]{0,400}relojesDeEsteAgente/);
    expect(index).toContain("require('./avisos')");
  });

  it('la ruta que abre el lector existe en la entrada compatible de la API, como SSE', () => {
    const avisos = fs.readFileSync(path.join(AGENTE, 'avisos.js'), 'utf8');
    const controlador = fs.readFileSync(path.join(RAIZ, 'libs/hr/src/lib/attendance/attendance-ingest.controller.ts'), 'utf8');
    expect(avisos).toContain('/checador/ingesta/eventos');
    expect(controlador).toContain("@Sse('eventos')");
  });
});
