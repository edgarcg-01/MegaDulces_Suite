/**
 * `[RH.3.3.4]` El clasificador con visión: sin IA o con error NO adivina (entra como «otro»), una respuesta fuera del
 * catálogo se descarta, y el PDF viaja como documento (no como imagen).
 */
// El servicio importa el barril de platform-core, que exige JWT_SECRET al cargarse.
let HrDocumentClassifierService: typeof import('./clasificar-documento.service').HrDocumentClassifierService;
beforeAll(async () => {
  process.env['JWT_SECRET'] ??= 'prueba-clasificador';
  ({ HrDocumentClassifierService } = await import('./clasificar-documento.service'));
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const respuesta = (input: unknown) => ({ content: [{ type: 'tool_use', name: 'clasificar_documento', input }] });

describe('[RH.3.3.4] HrDocumentClassifierService', () => {
  it('sin IA no pregunta ni adivina', async () => {
    const messages = vi.fn();
    const c = await new HrDocumentClassifierService({ hasApiKey: false, messages } as never).clasificar(PNG, 'image/png');
    expect(c).toMatchObject({ slot: null, clasificado: false });
    expect(messages).not.toHaveBeenCalled();
  });

  it('reconoce el casillero; el PDF va como documento', async () => {
    const messages = vi.fn().mockResolvedValue(respuesta({ slot: 'comprobante', motivo: 'recibo de CFE' }));
    const c = await new HrDocumentClassifierService({ hasApiKey: true, messages } as never).clasificar(Buffer.from('%PDF'), 'application/pdf');
    expect(c).toEqual({ slot: 'comprobante', motivo: 'recibo de CFE', clasificado: true });
    expect(messages.mock.calls[0][0].messages[0].content[0].type).toBe('document');
  });

  it('⛔ una llave fuera del catálogo o un error: «otro», sin inventar', async () => {
    const malo = vi.fn().mockResolvedValue(respuesta({ slot: 'pasaporte', motivo: 'x' }));
    expect(await new HrDocumentClassifierService({ hasApiKey: true, messages: malo } as never).clasificar(PNG, 'image/png'))
      .toMatchObject({ slot: null, clasificado: false });
    const roto = vi.fn().mockRejectedValue(new Error('timeout'));
    expect(await new HrDocumentClassifierService({ hasApiKey: true, messages: roto } as never).clasificar(PNG, 'image/png'))
      .toMatchObject({ slot: null, clasificado: false });
  });

  it('un formato que la visión no lee no se manda', async () => {
    const messages = vi.fn();
    expect(await new HrDocumentClassifierService({ hasApiKey: true, messages } as never).clasificar(PNG, 'image/heic'))
      .toMatchObject({ slot: null, clasificado: false });
    expect(messages).not.toHaveBeenCalled();
  });
});
