/**
 * `[RH.3.3.3]` El documento en Meta: primero se SUBE el archivo (`/media`), luego se manda el mensaje con ese id —
 * no una liga nuestra, que Meta tendría que poder descargar—. Si la subida falla, se lanza (la cola reintenta).
 */
import axios from 'axios';
import { MetaCloudWhatsAppAdapter } from './meta-cloud.adapter';

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
