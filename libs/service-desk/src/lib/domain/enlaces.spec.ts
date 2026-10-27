import { MAX_ENLACES_POR_ENVIO, normalizarEnlaceGoogle } from './enlaces';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const ok = (s: string) => normalizarEnlaceGoogle(s);

describe('[MS.ADJ.1.6] enlaces de Google: lo que SÍ pasa', () => {
  it('Documentos, Hojas, Presentaciones y Formularios, con la cola de siempre y los parámetros de «compartir» descartados', () => {
    expect(ok(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toMatchObject({ ok: true, tipo: 'documento', id: ID, url: `https://docs.google.com/document/d/${ID}/edit` });
    expect(ok(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toMatchObject({ ok: true, tipo: 'hoja', url: `https://docs.google.com/spreadsheets/d/${ID}/edit` });
    expect(ok(`https://docs.google.com/presentation/d/${ID}/view`)).toMatchObject({ ok: true, tipo: 'presentacion' });
    expect(ok(`https://docs.google.com/forms/d/e/${ID}/viewform?usp=pp_url`)).toMatchObject({ ok: true, tipo: 'formulario', url: `https://docs.google.com/forms/d/e/${ID}/viewform` });
  });

  it('Drive: archivo, carpeta y `open?id=`; con varias cuentas (`/u/1/`) y con `resourcekey`', () => {
    expect(ok(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`)).toMatchObject({ ok: true, tipo: 'archivo', url: `https://drive.google.com/file/d/${ID}/view` });
    expect(ok(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toMatchObject({ ok: true, tipo: 'carpeta', url: `https://drive.google.com/drive/folders/${ID}` });
    expect(ok(`https://drive.google.com/drive/u/1/folders/${ID}`)).toMatchObject({ ok: true, tipo: 'carpeta' });
    expect(ok(`https://drive.google.com/open?id=${ID}&authuser=0`)).toMatchObject({ ok: true, tipo: 'archivo', url: `https://drive.google.com/open?id=${ID}` });
    expect(ok(`https://drive.google.com/file/d/${ID}/view?resourcekey=0-AbCd_123`)).toMatchObject({ ok: true, url: `https://drive.google.com/file/d/${ID}/view?resourcekey=0-AbCd_123` });
    expect(ok(`  https://docs.google.com/document/d/${ID}  `)).toMatchObject({ ok: true }); // espacios alrededor: se recortan
  });

  it('una cola de ruta desconocida se DESCARTA; no se arrastra al enlace guardado', () => {
    expect(ok(`https://docs.google.com/document/d/${ID}/algo-raro/otro`)).toMatchObject({ ok: true, url: `https://docs.google.com/document/d/${ID}` });
  });
});

describe('[MS.ADJ.1.6] ⛔ NEGATIVAS — lo que se disfraza o no corresponde', () => {
  const malos: [string, string][] = [
    ['javascript:alert(1)', 'esquema peligroso'],
    [`http://docs.google.com/document/d/${ID}/edit`, 'sin https'],
    [`https://docs.google.com.evil.com/document/d/${ID}/edit`, 'host que EMPIEZA con el de Google'],
    [`https://evil.com/docs.google.com/document/d/${ID}`, 'el host de Google sólo en la ruta'],
    [`https://docs.google.com@evil.com/document/d/${ID}`, 'usuario falso antes del @ (el host real es evil.com)'],
    [`https://user:pass@docs.google.com/document/d/${ID}`, 'con usuario y contraseña'],
    [`https://docs.google.com:8443/document/d/${ID}`, 'con puerto'],
    [`https://sub.docs.google.com/document/d/${ID}`, 'subdominio'],
    [`https://www.google.com/document/d/${ID}`, 'otro host de Google'],
    [`https://docs.google.com/document/d/corto`, 'identificador demasiado corto'],
    [`https://drive.google.com/uc?export=download&id=${ID}`, 'descarga directa (no es un documento)'],
    [`https://drive.google.com/open?id=corto`, 'open con id inválido'],
    [`https://drive.google.com/open`, 'open sin id'],
    [`https://docs.google.com/`, 'la portada de Docs'],
    [`https://docs.google.com/document/create`, 'una ruta de Docs que no es un documento'],
    [`https://docs.google.com/document/d/${ID}/edit\n`.replace('\n', ' x'), 'con un espacio dentro'],
    [`https://docs.google.com/document/d/${ID}/edit‮`, 'con un carácter de dirección Unicode'],
    ['', 'vacío'],
    ['no es un enlace', 'texto suelto'],
    [`https://docs.google.com/document/d/${ID}/${'a'.repeat(600)}`, 'demasiado largo'],
  ];
  it.each(malos)('%s → rechazado (%s)', (entrada) => {
    expect(ok(entrada)).toMatchObject({ ok: false });
  });

  it('el motivo se dice en palabras (no un código)', () => {
    const r = ok('https://evil.com/x');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toMatch(/Google/);
  });

  it('el tope de enlaces por envío es 3 (el servidor lo vuelve a exigir)', () => {
    expect(MAX_ENLACES_POR_ENVIO).toBe(3);
  });
});
