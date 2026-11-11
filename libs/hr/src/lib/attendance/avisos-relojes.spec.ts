import { firstValueFrom, take, toArray } from 'rxjs';
import type { PgListenService } from '@megadulces/platform-core';
import { CANAL_RELOJES, HrRelojesAvisosService, avisarRelojes, leerAviso } from './avisos-relojes';

/**
 * `[RH.1.3]` Los avisos al lector de relojes reemplazan sus preguntas periódicas (padrón cada 30 min, órdenes cada
 * minuto por reloj). Lo que se defiende: el aviso sale por el canal correcto y DENTRO de la transacción; el lector
 * recibe primero «ponte al día» (lo que pasó mientras no estaba), y cuando el LISTEN se recupera de una caída también
 * — porque un NOTIFY perdido no se recupera de otra forma sin un reloj.
 */
class ListenFalso {
  oyentes = new Map<string, (p: string) => void>();
  alVolver: Array<() => void> = [];
  escuchar(canal: string, o: (p: string) => void) { this.oyentes.set(canal, o); return () => this.oyentes.delete(canal); }
  alConectar(o: () => void) { this.alVolver.push(o); return () => { this.alVolver = this.alVolver.filter((x) => x !== o); }; }
  emitir(canal: string, p: string) { this.oyentes.get(canal)?.(p); }
}

function servicio() {
  const listen = new ListenFalso();
  const s = new HrRelojesAvisosService(listen as unknown as PgListenService);
  s.onModuleInit();
  return { s, listen };
}

describe('[RH.1.3] avisos al lector de relojes', () => {
  it('el aviso va por pg_notify en el canal hr_relojes, con la transacción que se le da', async () => {
    const llamadas: unknown[][] = [];
    const trx = { raw: (...a: unknown[]) => { llamadas.push(a); return Promise.resolve(); } };
    await avisarRelojes(trx as never, { tipo: 'comando', serie: 'CEZU201060011' });
    expect(llamadas).toEqual([['select pg_notify(?, ?)', [CANAL_RELOJES, '{"tipo":"comando","serie":"CEZU201060011"}']]]);
  });

  it('del canal sólo pasa lo que se entiende (un comando sin serie, o basura, se descarta)', () => {
    expect(leerAviso('{"tipo":"padron"}')).toEqual({ tipo: 'padron' });
    expect(leerAviso('{"tipo":"comando","serie":" X1 "}')).toEqual({ tipo: 'comando', serie: 'X1' });
    expect(leerAviso('{"tipo":"comando"}')).toBeNull();
    expect(leerAviso('{"tipo":"borrar_todo"}')).toBeNull();
    expect(leerAviso('no es json')).toBeNull();
  });

  it('⭐ el lector que se conecta recibe PRIMERO «ponte al día», y después los avisos en vivo', async () => {
    const { s, listen } = servicio();
    const llega = firstValueFrom(s.flujo().pipe(take(3), toArray()));
    listen.emitir(CANAL_RELOJES, '{"tipo":"padron"}');
    listen.emitir(CANAL_RELOJES, '{"tipo":"comando","serie":"UEED255000166"}');
    expect((await llega).map((e) => e.type)).toEqual(['ponte_al_dia', 'padron', 'comando']);
  });

  it('⛔ cuando el LISTEN vuelve de una caída, a los lectores conectados les llega «ponte al día» (el NOTIFY perdido)', async () => {
    const { s, listen } = servicio();
    const llega = firstValueFrom(s.flujo().pipe(take(2), toArray()));
    for (const o of listen.alVolver) o();
    expect((await llega).map((e) => e.type)).toEqual(['ponte_al_dia', 'ponte_al_dia']);
  });
});
