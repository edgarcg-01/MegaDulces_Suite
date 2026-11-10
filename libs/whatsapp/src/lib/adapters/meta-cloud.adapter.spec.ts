/**
 * `[RH.3.3.3]` El documento en Meta: primero se SUBE el archivo (`/media`), luego se manda el mensaje con ese id —
 * no una liga nuestra, que Meta tendría que poder descargar—. Si la subida falla, se lanza (la cola reintenta).
 */
import axios from 'axios';
import { createHmac } from 'crypto';
// El adaptador importa el barril de platform-core, que exige JWT_SECRET al cargarse.
let MetaCloudWhatsAppAdapter: typeof import('./meta-cloud.adapter').MetaCloudWhatsAppAdapter;
beforeAll(async () => {
  process.env['JWT_SECRET'] ??= 'prueba-meta';
  ({ MetaCloudWhatsAppAdapter } = await import('./meta-cloud.adapter'));
});

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
const post = axios.post as unknown as ReturnType<typeof vi.fn>;

describe('[RH.3.3.3] MetaCloudWhatsAppAdapter.sendDocument', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env['WHATSAPP_PHONE_NUMBER_ID'] = 'num-ventas';
    process.env['WHATSAPP_ACCESS_TOKEN'] = 'token';
    post.mockReset();
  });
  afterEach(() => { process.env = { ...env }; });

  it('⭐ sube a /media DESDE el número que recibió y manda `type: document` con el id', async () => {
    post.mockResolvedValueOnce({ data: { id: 'media-123' } }).mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });
    const r = await new MetaCloudWhatsAppAdapter().sendDocument('5213511234567',
      { base64: Buffer.from('%PDF').toString('base64'), mime: 'application/pdf', filename: 'CV.pdf', caption: 'Tu CV' }, { from: 'num-rh' });
    expect(r).toEqual({ message_id: 'wamid.1' });
    expect(post.mock.calls[0][0]).toMatch(/\/num-rh\/media$/);
    expect(post.mock.calls[0][1]).toBeInstanceOf(FormData);
    expect(post.mock.calls[1][0]).toMatch(/\/num-rh\/messages$/);
    expect(post.mock.calls[1][1]).toMatchObject({ type: 'document', to: '523511234567', document: { id: 'media-123', filename: 'CV.pdf', caption: 'Tu CV' } });
  });

  it('⛔ si la subida falla, lanza y NO manda un mensaje sin documento', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('400'), { response: { status: 400, data: { error: 'bad' } } }));
    await expect(new MetaCloudWhatsAppAdapter().sendDocument('5213511234567', { base64: 'eA==', mime: 'application/pdf', filename: 'x.pdf' })).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sin credenciales no llama a Meta', async () => {
    delete process.env['WHATSAPP_ACCESS_TOKEN'];
    expect(await new MetaCloudWhatsAppAdapter().sendDocument('5213511234567', { base64: 'eA==', mime: 'application/pdf', filename: 'x.pdf' })).toEqual({ message_id: null });
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * `[RH.3.5]` El número de RH vive en otra app de Meta (`mega-dulces-rh`): firma con SU clave y habla con SU token.
 * Sin estas pruebas, mover el webhook del bot a la Suite rechazaba todo mensaje de reclutamiento por «firma inválida».
 */
describe('[RH.3.5] MetaCloudWhatsAppAdapter con la app de RH', () => {
  const env = { ...process.env };
  const get = axios.get as unknown as ReturnType<typeof vi.fn>;
  const firma = (secreto: string, body: string) => 'sha256=' + createHmac('sha256', secreto).update(body).digest('hex');
  const body = JSON.stringify({ entry: [] });
  beforeEach(() => {
    process.env['WHATSAPP_PHONE_NUMBER_ID'] = 'num-ventas';
    process.env['WHATSAPP_ACCESS_TOKEN'] = 'token-ventas';
    process.env['WHATSAPP_APP_SECRET'] = 'clave-ventas';
    process.env['WHATSAPP_RECRUITMENT_APP_SECRET'] = 'clave-rh';
    process.env['WHATSAPP_RECRUITMENT_PHONE_NUMBER_ID'] = 'num-rh';
    process.env['WHATSAPP_RECRUITMENT_ACCESS_TOKEN'] = 'token-rh';
    post.mockReset();
    get.mockReset();
  });
  afterEach(() => { process.env = { ...env }; });

  it('⭐ acepta la firma de CUALQUIERA de las dos apps', () => {
    const a = new MetaCloudWhatsAppAdapter();
    expect(() => a.parseInbound(JSON.parse(body), firma('clave-ventas', body), body)).not.toThrow();
    expect(() => a.parseInbound(JSON.parse(body), firma('clave-rh', body), body)).not.toThrow();
  });

  it('⛔ rechaza una firma de una clave que no es de ninguna', () => {
    expect(() => new MetaCloudWhatsAppAdapter().parseInbound(JSON.parse(body), firma('clave-ajena', body), body))
      .toThrow('Firma de webhook inválida');
  });

  it('⛔ sin la clave de RH configurada, el mensaje de RH se rechaza (el estado de antes)', () => {
    delete process.env['WHATSAPP_RECRUITMENT_APP_SECRET'];
    expect(() => new MetaCloudWhatsAppAdapter().parseInbound(JSON.parse(body), firma('clave-rh', body), body))
      .toThrow('Firma de webhook inválida');
  });

  it('⛔ en producción, sin ninguna clave, falla cerrado', () => {
    delete process.env['WHATSAPP_APP_SECRET'];
    delete process.env['WHATSAPP_RECRUITMENT_APP_SECRET'];
    process.env['NODE_ENV'] = 'production';
    expect(() => new MetaCloudWhatsAppAdapter().parseInbound(JSON.parse(body), undefined, body)).toThrow('falta WHATSAPP_APP_SECRET');
  });

  it('⭐ lo que sale DESDE el número de RH lleva el token de RH; lo demás, el general', async () => {
    post.mockResolvedValue({ data: { messages: [{ id: 'wamid.x' }] } });
    const a = new MetaCloudWhatsAppAdapter();
    await a.sendText('5213511234567', 'hola', { from: 'num-rh' });
    await a.sendText('5213511234567', 'hola');
    await a.sendText('5213511234567', 'hola', { from: 'num-otro' });
    expect(post.mock.calls.map((c) => c[2].headers.Authorization)).toEqual(['Bearer token-rh', 'Bearer token-ventas', 'Bearer token-ventas']);
  });

  it('⭐ la media que llegó al número de RH se baja con el token de RH (los dos pasos)', async () => {
    get.mockResolvedValueOnce({ data: { url: 'https://lookaside/x', mime_type: 'image/jpeg' } }).mockResolvedValueOnce({ data: Buffer.from('jpg') });
    const r = await new MetaCloudWhatsAppAdapter().downloadMedia('media-1', { from: 'num-rh' });
    expect(r?.mime).toBe('image/jpeg');
    expect(get.mock.calls.map((c) => c[1].headers.Authorization)).toEqual(['Bearer token-rh', 'Bearer token-rh']);
  });

  it('sin token propio de RH, el número de RH usa el general (misma cuenta de negocio)', async () => {
    delete process.env['WHATSAPP_RECRUITMENT_ACCESS_TOKEN'];
    post.mockResolvedValue({ data: { messages: [{ id: 'wamid.x' }] } });
    await new MetaCloudWhatsAppAdapter().sendText('5213511234567', 'hola', { from: 'num-rh' });
    expect(post.mock.calls[0][2].headers.Authorization).toBe('Bearer token-ventas');
  });
});
