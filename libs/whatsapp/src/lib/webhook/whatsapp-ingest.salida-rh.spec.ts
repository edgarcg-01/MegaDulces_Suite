/**
 * `[RH.3.3.4b]` La SALIDA de reclutamiento por iniciativa de RH: el texto sale desde el número de reclutamiento DEL TENANT
 * (no del de ventas), por la misma cola y al mismo libro; sin número de reclutamiento no se manda nada. Sin base: la
 * ingesta real con dobles (simulador como proveedor).
 */
import type { Knex } from 'knex';

const NUM_RH = '9990001112223';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';

describe('[RH.3.3.4b] salida de reclutamiento', () => {
  let IngestService: typeof import('./whatsapp-ingest.service').WhatsAppIngestService;
  let Simulator: typeof import('../adapters/simulator.adapter').SimulatorWhatsAppAdapter;

  beforeAll(async () => {
    // El barril de platform-core exige JWT_SECRET al cargarse.
    process.env['JWT_SECRET'] ??= 'prueba-salida-rh';
    ({ WhatsAppIngestService: IngestService } = await import('./whatsapp-ingest.service'));
    ({ SimulatorWhatsAppAdapter: Simulator } = await import('../adapters/simulator.adapter'));
  });

  function montar() {
    const port = new Simulator();
    // El mapa: un número de ventas y uno de reclutamiento para TENANT; el otro tenant sólo tiene ventas.
    const filas = [
      { phone_number_id: '1256572530868591', tenant_id: TENANT, flow: 'commerce' },
      { phone_number_id: NUM_RH, tenant_id: TENANT, flow: 'recruitment' },
      { phone_number_id: '7770001112223', tenant_id: OTRO, flow: 'commerce' },
    ];
    const knex = ((tabla: string) => ({
      where: (w: { tenant_id: string; flow: string }) => ({
        orderBy: () => ({
          first: async () => {
            expect(tabla).toBe('whatsapp.phone_number_tenant_map');
            return filas.find((f) => f.tenant_id === w.tenant_id && f.flow === w.flow);
          },
        }),
      }),
    })) as unknown as Knex;
    const handlers: Record<string, (j: unknown) => Promise<void>> = {};
    const encolados: unknown[] = [];
    const queue = {
      mode: 'in-process',
      process: async (dir: string, h: (j: unknown) => Promise<void>) => { handlers[dir] = h; },
      enqueue: async (job: { dir: string }) => { encolados.push(job); await handlers[job.dir](job); },
    };
    const libro: Array<{ flow: string; direction: string; phone: string; phone_number_id: string | null }> = [];
    const threads = {
      logFlowMessage: async (flow: string, direction: string, m: { phone: string; phone_number_id?: string | null }) => {
        libro.push({ flow, direction, phone: m.phone, phone_number_id: m.phone_number_id ?? null }); return true;
      },
    };
    const tenantCtx = { run: async (_c: unknown, fn: () => Promise<unknown>) => fn() };
    const svc = new IngestService(port as never, knex, queue as never, threads as never, {} as never, {} as never, tenantCtx as never);
    return { svc, port, libro, encolados };
  }

  it('⭐ sale desde el número de reclutamiento del tenant y queda en el libro de reclutamiento', async () => {
    const { svc, port, libro } = montar();
    await svc.onModuleInit();
    expect(await svc.sendRecruitmentText(TENANT, '5213511234567', 'Tus documentos, por favor')).toEqual({ encolado: true });
    expect(port.outbox.map((o) => [o.to, o.body, o.from])).toEqual([['5213511234567', 'Tus documentos, por favor', NUM_RH]]); // el adaptador de Meta quita el 1 de la lada (su prueba)
    expect(libro).toEqual([{ flow: 'recruitment', direction: 'out', phone: '5213511234567', phone_number_id: NUM_RH }]);
  });

  it('⛔ sin número de reclutamiento no se encola nada (no sale por el de ventas)', async () => {
    const { svc, port, encolados } = montar();
    await svc.onModuleInit();
    expect(await svc.sendRecruitmentText(OTRO, '5213511234567', 'x')).toEqual({ encolado: false, motivo: 'sin_numero' });
    expect(encolados).toHaveLength(0);
    expect(port.outbox).toHaveLength(0);
  });
});
