/**
 * `[RH.3.3.4b]` Pedir documentos desde la ficha: la lista siempre queda registrada; el mensaje sale SÓLO dentro de la
 * ventana de 24 h de Meta y por el teléfono como llegó de WhatsApp. Fuera de la ventana, sin salida o sin número, se
 * DECLARA el motivo (nunca se intenta un envío que Meta rechazaría en silencio).
 */
let HrDocumentRequestService: typeof import('./pedir-documentos.service').HrDocumentRequestService;
beforeAll(async () => {
  // El servicio importa el barril de platform-core, que exige JWT_SECRET al cargarse.
  process.env['JWT_SECRET'] ??= 'prueba-pedir-docs';
  ({ HrDocumentRequestService } = await import('./pedir-documentos.service'));
});

const AHORA = new Date('2026-10-14T18:00:00Z');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const tenantCtx = { requireTenantId: () => TENANT };
const peticion = (o: Record<string, unknown> = {}) => ({
  telefono: '3511234567', telefono_wa: '5213511234567', solicitados: ['ine', 'acta'], mensaje: '📄 Documentos…',
  ultimo_mensaje_en: '2026-10-14T10:00:00Z', ...o,
});
const montar = (p: ReturnType<typeof peticion>, salida?: { sendText: ReturnType<typeof vi.fn> }) => {
  const bot = { pedirDocumentos: vi.fn().mockResolvedValue(p) };
  return { svc: new HrDocumentRequestService(bot as never, tenantCtx as never, salida as never), bot };
};

describe('[RH.3.3.4b] HrDocumentRequestService', () => {
  it('⭐ dentro de la ventana: registra y manda al teléfono de WhatsApp', async () => {
    const salida = { sendText: vi.fn().mockResolvedValue({ encolado: true }) };
    const { svc, bot } = montar(peticion(), salida);
    const r = await svc.pedir('cand-1', ['ine'], AHORA);
    expect(r).toMatchObject({ enviado: true, motivo: 'enviado', solicitados: ['ine', 'acta'] });
    expect(bot.pedirDocumentos).toHaveBeenCalledWith(TENANT, 'cand-1', ['ine']);
    expect(salida.sendText).toHaveBeenCalledWith(TENANT, '5213511234567', '📄 Documentos…');
  });

  it('⛔ fuera de la ventana (o nunca escribió): NO intenta mandar, lo declara con el texto', async () => {
    const salida = { sendText: vi.fn() };
    for (const ultimo of ['2026-10-13T10:00:00Z', null]) {
      const r = await montar(peticion({ ultimo_mensaje_en: ultimo }), salida).svc.pedir('c', null, AHORA);
      expect(r).toMatchObject({ enviado: false, motivo: 'fuera_de_ventana', mensaje: '📄 Documentos…' });
    }
    expect(salida.sendText).not.toHaveBeenCalled();
  });

  it('nada que pedir: no manda', async () => {
    const salida = { sendText: vi.fn() };
    const r = await montar(peticion({ mensaje: null, solicitados: [] }), salida).svc.pedir('c', null, AHORA);
    expect(r).toMatchObject({ enviado: false, motivo: 'nada_que_pedir' });
    expect(salida.sendText).not.toHaveBeenCalled();
  });

  it('sin salida de WhatsApp o sin número de reclutamiento: se declara', async () => {
    expect(await montar(peticion()).svc.pedir('c', null, AHORA)).toMatchObject({ enviado: false, motivo: 'sin_whatsapp' });
    const sinNumero = { sendText: vi.fn().mockResolvedValue({ encolado: false, motivo: 'sin_numero' }) };
    expect(await montar(peticion(), sinNumero).svc.pedir('c', null, AHORA)).toMatchObject({ enviado: false, motivo: 'sin_whatsapp' });
  });
});
