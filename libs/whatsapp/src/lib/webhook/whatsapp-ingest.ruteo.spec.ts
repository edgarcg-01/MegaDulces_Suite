/**
 * `[RH.3.1]` El ruteo por NÚMERO: el número de reclutamiento va al bot de RH (no al de comercio), la respuesta sale desde
 * el mismo número y queda en el libro con su flujo. Sin base: la ingesta real con dobles (simulador como proveedor).
 */
import type { Knex } from 'knex';
import type { RecruitmentBotPort, RecruitmentInbound } from '@megadulces/contracts';

const NUM_RH = '9990001112223';
const NUM_VENTAS = '1256572530868591';
const TENANT = '00000000-0000-0000-0000-00000000d01c';

describe('[RH.3.1] ruteo de la ingesta por número', () => {
  let IngestService: typeof import('./whatsapp-ingest.service').WhatsAppIngestService;
  let Simulator: typeof import('../adapters/simulator.adapter').SimulatorWhatsAppAdapter;

  beforeAll(async () => {
    // El barril de platform-core exige JWT_SECRET al cargarse (como en las pruebas de libs/hr).
    process.env['JWT_SECRET'] ??= 'prueba-ruteo';
    ({ WhatsAppIngestService: IngestService } = await import('./whatsapp-ingest.service'));
    ({ SimulatorWhatsAppAdapter: Simulator } = await import('../adapters/simulator.adapter'));
  });

  function montar(o: { mapa?: Record<string, string>; mapaFalla?: boolean; bot?: RecruitmentBotPort | null } = {}) {
    const port = new Simulator();
    const mapa = o.mapa ?? { [NUM_RH]: 'recruitment', [NUM_VENTAS]: 'commerce' };
    const knex = ((tabla: string) => ({
      where: (w: { phone_number_id: string }) => ({
        first: async () => {
          if (o.mapaFalla) throw new Error('sin base');
          expect(tabla).toBe('whatsapp.phone_number_tenant_map');
          const flow = mapa[w.phone_number_id];
          return flow ? { tenant_id: TENANT, flow } : undefined;
        },
      }),
    })) as unknown as Knex;
    const handlers: Record<string, (j: unknown) => Promise<void>> = {};
    const queue = {
      mode: 'in-process',
      process: async (dir: string, h: (j: unknown) => Promise<void>) => { handlers[dir] = h; },
      enqueue: async (job: { dir: string }) => { await handlers[job.dir](job); },
    };
    const libro: Array<{ flow: string; direction: string; phone: string; phone_number_id: string | null; body: unknown }> = [];
    const threads = {
      isDuplicateInbound: async () => false,
      logFlowMessage: async (flow: string, direction: string, m: { phone: string; phone_number_id?: string | null; body?: unknown }) => {
        libro.push({ flow, direction, phone: m.phone, phone_number_id: m.phone_number_id ?? null, body: m.body }); return true;
      },
      getOrCreate: async () => ({ id: 'hilo-1' }),
      logMessage: async (_t: string, direction: string, m: { body?: unknown }) => { libro.push({ flow: 'commerce', direction, phone: '', phone_number_id: null, body: m.body }); return true; },
      countRecentTurns: async () => 0,
      update: async () => undefined,
    };
    const orchestrator = { handleTurn: vi.fn(async () => ({ reply: 'respuesta de comercio' })) };
    const optin = { isOptOutMessage: () => false, optOut: async () => undefined };
    const tenantCtx = { run: async (_c: unknown, fn: () => Promise<unknown>) => fn() };
    const svc = new IngestService(port as never, knex, queue as never, threads as never, orchestrator as never, optin as never,
      tenantCtx as never, undefined, o.bot === null ? undefined : (o.bot ?? undefined));
    return { svc, port, libro, orchestrator };
  }

  it('⭐ el número de RH va al bot de reclutamiento; la respuesta sale DESDE ESE número y queda en el libro', async () => {
    const recibidos: RecruitmentInbound[] = [];
    const bot: RecruitmentBotPort = { handleMessage: async (m) => { recibidos.push(m); return [{ kind: 'text', body: 'hola desde RH' }]; } };
    const { svc, port, libro, orchestrator } = montar({ bot });
    await svc.onModuleInit();
    const n = await svc.ingestSimulator({ from: '5213511234567', text: 'quiero trabajar', phone_number_id: NUM_RH, profile_name: 'Ana Prueba' });
    expect(n).toBe(1);
    expect(orchestrator.handleTurn).not.toHaveBeenCalled();
    expect(recibidos.map((m) => [m.phone, m.phoneNumberId, m.text, m.profileName])).toEqual([['523511234567', NUM_RH, 'quiero trabajar', 'Ana Prueba']]);
    expect(port.outbox.map((o) => [o.to, o.body, o.from])).toEqual([['523511234567', 'hola desde RH', NUM_RH]]);
    expect(libro.map((l) => [l.flow, l.direction, l.phone_number_id])).toEqual([['recruitment', 'in', NUM_RH], ['recruitment', 'out', NUM_RH]]);
  });

  it('el número de ventas (o uno sin mapear) sigue yendo al bot de comercio, y sin «from»', async () => {
    const bot: RecruitmentBotPort = { handleMessage: vi.fn(async () => []) };
    const { svc, port, orchestrator } = montar({ bot });
    await svc.onModuleInit();
    await svc.ingestSimulator({ from: '5213511234567', text: 'hola', phone_number_id: NUM_VENTAS });
    await svc.ingestSimulator({ from: '5213519999999', text: 'hola', phone_number_id: 'otro-numero' });
    await svc.ingestSimulator({ from: '5213518888888', text: 'hola' }); // sin número
    expect(orchestrator.handleTurn).toHaveBeenCalledTimes(3);
    expect(bot.handleMessage).not.toHaveBeenCalled();
    expect(port.outbox.every((o) => o.from === null)).toBe(true);
  });

  it('⛔ NEGATIVA — si la consulta del mapa falla, va a comercio: nunca a reclutamiento sin saber de dónde vino', async () => {
    const bot: RecruitmentBotPort = { handleMessage: vi.fn(async () => []) };
    const { svc, orchestrator } = montar({ bot, mapaFalla: true });
    await svc.onModuleInit();
    await svc.ingestSimulator({ from: '5213511234567', text: 'hola', phone_number_id: NUM_RH });
    expect(bot.handleMessage).not.toHaveBeenCalled();
    expect(orchestrator.handleTurn).toHaveBeenCalledTimes(1);
  });

  it('el adjunto se le pasa al bot con su descarga (sin que conozca al proveedor)', async () => {
    let bytes: string | null = null;
    const bot: RecruitmentBotPort = {
      handleMessage: async (m) => { const d = await m.descargar?.(); bytes = d ? Buffer.from(d.buffer).toString() : null; return []; },
    };
    const { svc } = montar({ bot });
    await svc.onModuleInit();
    await svc.ingestSimulator({ from: '5213511234567', phone_number_id: NUM_RH, type: 'document',
      media_data_uri: `data:application/pdf;base64,${Buffer.from('%PDF-cv').toString('base64')}` });
    expect(bytes).toBe('%PDF-cv');
  });

  it('sin bot de reclutamiento (sin binding): se registra y NO se contesta con el bot de comercio', async () => {
    const { svc, port, libro, orchestrator } = montar({ bot: null });
    await svc.onModuleInit();
    await svc.ingestSimulator({ from: '5213511234567', text: 'hola', phone_number_id: NUM_RH });
    expect(orchestrator.handleTurn).not.toHaveBeenCalled();
    expect(port.outbox.length).toBe(0);
    expect(libro.map((l) => [l.flow, l.direction])).toEqual([['recruitment', 'in']]);
  });
});
