/**
 * `[RH.3.3.3]` El HTML del CV: lo que escribió el candidato se ESCAPA (es texto libre de WhatsApp), sin experiencia se
 * escribe un «Objetivo», el estado civil no se imprime, y la foto sólo entra si es una imagen.
 */
// `cv-html` usa `esc` del barril de platform-core, que exige JWT_SECRET al cargarse (como en las demás pruebas del bot).
let htmlCv: typeof import('./cv-html').htmlCv;
beforeAll(async () => {
  process.env['JWT_SECRET'] ??= 'prueba-cv';
  ({ htmlCv } = await import('./cv-html'));
});

const base = {
  nombres: 'Ana', apellido_paterno: 'López', apellido_materno: 'Pérez', puesto_solicitado: 'Cajera', email: 'ana@gmail.com',
  fecha_nacimiento: '02/11/2000', estado_civil: 'Casado(a)', esc_prepa_hubo: 'Sí', esc_prepa_escuela: 'CETIS 120', esc_prepa_anios: '2015 - 2018',
};

describe('[RH.3.3.3] el CV en HTML', () => {
  it('⛔ lo que escribe el candidato se escapa: un <script> no entra como código', () => {
    const h = htmlCv({ ...base, emp1_hubo: 'Sí', emp1_compania: '<script>alert(1)</script>', emp1_puesto: 'Cajera "jefa"' });
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toContain('Cajera &quot;jefa&quot;');
  });
  it('sin experiencia: «Objetivo» honesto en vez del hueco; con experiencia: la empresa y las funciones en viñetas', () => {
    expect(htmlCv(base)).toContain('Sin experiencia laboral previa. Busco mi primera oportunidad como Cajera');
    const con = htmlCv({ ...base, emp1_hubo: 'Sí', emp1_compania: 'Oxxo', emp1_puesto: 'Cajera', emp1_funciones: 'Cobrar en caja. Acomodar mercancía' });
    expect(con).toContain('Experiencia laboral');
    expect(con).toContain('<li>Cobrar en caja</li><li>Acomodar mercancía</li>');
  });
  it('el estado civil NO se imprime (es sensible: queda en la solicitud)', () => {
    expect(htmlCv(base)).not.toContain('Casado');
    expect(htmlCv(base)).toContain('Ana López Pérez');
  });
  it('la foto sólo entra si es un data URI de imagen; si no, las iniciales', () => {
    expect(htmlCv(base, { fotoDataUri: 'data:image/jpeg;base64,AAAA' })).toContain('src="data:image/jpeg;base64,AAAA"');
    const mala = htmlCv(base, { fotoDataUri: 'javascript:alert(1)' });
    expect(mala).not.toContain('javascript:');
    expect(mala).toContain('>AL<');
  });
});
