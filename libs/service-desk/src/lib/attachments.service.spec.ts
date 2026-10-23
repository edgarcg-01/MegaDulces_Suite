import { BadRequestException } from '@nestjs/common';
import type { ObjectStorageService } from '@megadulces/platform-core';
import { MAX_TOTAL_ADJUNTOS_BYTES, ServiceDeskAttachmentsService } from './attachments.service';

// El índice de `@megadulces/platform-core` levanta `TenantModule`, que exige `JWT_SECRET` AL IMPORTARSE y el CI no lo define: sin este mock el
// archivo no carga («[AUTHZ-HARD] JWT_SECRET no está definido»). Se usan las funciones REALES de firma y nombre (no dobles): lo que se
// prueba es `preparar`, que es justo quien las llama.
vi.mock('@megadulces/platform-core', async () => {
  const firma = await import('../../../platform-core/src/lib/storage/attachment-signature');
  return { sanitizarNombre: firma.sanitizarNombre, validarAdjunto: firma.validarAdjunto, ObjectStorageService: class {} };
});

const MB = 1048576;
const PDF = (bytes: number): string => `data:application/pdf;base64,${Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes - 9, 7)]).toString('base64')}`;
const PNG = (): string => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64')}`;
const servicio = (): ServiceDeskAttachmentsService => new ServiceDeskAttachmentsService({} as ObjectStorageService);

describe('[MS.ADJ.1.1/1.2/1.3] ServiceDeskAttachmentsService.preparar', () => {
  it('el nombre sale coherente con el tipo DETECTADO: `foto.exe` con bytes de PNG se guarda `.png`', () => {
    const [a] = servicio().preparar([{ file_name: 'foto.exe', file_base64: PNG() }], 8 * MB);
    expect(a.file_name).toBe('foto.png');
    expect(a.adjunto.contentType).toBe('image/png');
  });

  it('un nombre normal no cambia', () => {
    const [a] = servicio().preparar([{ file_name: 'Oficio 2026.pdf', file_base64: PDF(1024) }], 8 * MB);
    expect(a.file_name).toBe('Oficio 2026.pdf');
  });

  it('⛔ NEGATIVA — 3 archivos de 8 MB (24 MB) rebasan el tope de 22 MB y el mensaje lo dice', () => {
    const tres = [1, 2, 3].map((n) => ({ file_name: `a${n}.pdf`, file_base64: PDF(8 * MB) }));
    expect(() => servicio().preparar(tres, 8 * MB)).toThrow(BadRequestException);
    expect(() => servicio().preparar(tres, 8 * MB)).toThrow(/22 MB por envío/);
  });

  it('dos archivos de 8 MB (16 MB) pasan; el tope es del envío, no por archivo', () => {
    const dos = [1, 2].map((n) => ({ file_name: `a${n}.pdf`, file_base64: PDF(8 * MB) }));
    expect(servicio().preparar(dos, 8 * MB)).toHaveLength(2);
    expect(MAX_TOTAL_ADJUNTOS_BYTES).toBe(22 * MB);
  });

  it('[MS.ADJ.2.2] los enlaces de Google se normalizan, sin repetidos', () => {
    const r = servicio().prepararEnlaces([
      { url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing#gid=0' },
      { url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit' },
    ]);
    expect(r).toEqual([{ url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit', kind: 'hoja' }]);
    expect(servicio().prepararEnlaces(undefined)).toEqual([]);
  });

  it.each([
    ['otro dominio', 'https://evil.com/document/d/1AbCdEfGhIjKlMnOp/edit'],
    ['host por sufijo', 'https://docs.google.com.evil.com/document/d/1AbCdEfGhIjKlMnOp/edit'],
    ['http', 'http://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit'],
    ['javascript:', 'javascript:alert(1)'],
  ])('⛔ NEGATIVA — enlace inválido (%s) → 400 con «Enlace 1:»', (_n, url) => {
    expect(() => servicio().prepararEnlaces([{ url }])).toThrow(/Enlace 1:/);
  });

  it('⛔ NEGATIVA — más de 3 enlaces por envío → 400', () => {
    const cuatro = [1, 2, 3, 4].map((n) => ({ url: `https://docs.google.com/document/d/1AbCdEfGhIjKlMnO${n}/edit` }));
    expect(() => servicio().prepararEnlaces(cuatro)).toThrow(/Máximo 3 enlaces/);
  });

  it('el límite POR ARCHIVO sigue mandando (9 MB con tope de 8 MB)', () => {
    expect(() => servicio().preparar([{ file_name: 'g.pdf', file_base64: PDF(9 * MB) }], 8 * MB)).toThrow(/Archivo 1/);
  });
});
