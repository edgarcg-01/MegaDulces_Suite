import { BadRequestException } from '@nestjs/common';
import {
  formatFolio,
  isIsoDate,
  kindFromMime,
  normalizeProjectInput,
  parseSource,
  sanitizeFileName,
  TITLE_MAX,
} from './dev-projects.rules';
import { mxYear } from './dev-projects.service';

describe('[DEV.1] formatFolio', () => {
  it('rellena a 4 dígitos', () => {
    expect(formatFolio(2026, 7)).toBe('DEV-2026-0007');
    expect(formatFolio(2026, 1234)).toBe('DEV-2026-1234');
  });
  it('no recorta si pasa de 9999 (el folio sigue siendo único)', () => {
    expect(formatFolio(2026, 12345)).toBe('DEV-2026-12345');
  });
  it('⛔ rechaza consecutivo 0, negativo o fraccionario', () => {
    expect(() => formatFolio(2026, 0)).toThrow();
    expect(() => formatFolio(2026, -1)).toThrow();
    expect(() => formatFolio(2026, 1.5)).toThrow();
    expect(() => formatFolio(26, 1)).toThrow();
  });
});

describe('[DEV.1] kindFromMime', () => {
  it.each([
    ['image/jpeg', 'imagen'],
    ['image/png', 'imagen'],
    ['video/webm', 'video'],
    ['video/mp4', 'video'],
    ['audio/ogg', 'audio'],
    ['application/pdf', 'documento'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'documento'],
    ['', 'documento'],
  ])('%s → %s', (mime, kind) => {
    expect(kindFromMime(mime)).toBe(kind);
  });
  it('no distingue mayúsculas', () => {
    expect(kindFromMime('IMAGE/JPEG')).toBe('imagen');
  });
});

describe('[DEV.1] parseSource', () => {
  it('default = archivo', () => {
    expect(parseSource(undefined)).toBe('archivo');
  });
  it('acepta camara y grabacion', () => {
    expect(parseSource('camara')).toBe('camara');
    expect(parseSource('grabacion')).toBe('grabacion');
  });
  it('⛔ rechaza un origen inventado', () => {
    expect(() => parseSource('drone')).toThrow(BadRequestException);
  });
});

describe('[DEV.1] sanitizeFileName', () => {
  it('quita la ruta (no se puede escribir fuera de la carpeta)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\plan.pdf')).toBe('plan.pdf');
  });
  it('un nombre vacío recibe el de respaldo', () => {
    expect(sanitizeFileName('', 'foto.jpg')).toBe('foto.jpg');
    expect(sanitizeFileName(undefined)).toBe('archivo');
  });
  it('recupera acentos que multer entrega en latin1', () => {
    const latin1 = Buffer.from('Fotografía de tienda.jpg', 'utf8').toString('latin1');
    expect(sanitizeFileName(latin1)).toBe('Fotografía de tienda.jpg');
  });
  it('no rompe un nombre que ya venía bien', () => {
    expect(sanitizeFileName('minuta.docx')).toBe('minuta.docx');
  });
  it('quita caracteres de control', () => {
    expect(sanitizeFileName('a\u0000b\u0007.txt')).toBe('ab.txt');
  });
  it('acota a 200 caracteres conservando la extensión', () => {
    const n = sanitizeFileName(`${'x'.repeat(300)}.pdf`);
    expect(n.length).toBe(200);
    expect(n.endsWith('.pdf')).toBe(true);
  });
});

describe('[DEV.1] isIsoDate', () => {
  it('acepta fechas reales', () => {
    expect(isIsoDate('2026-10-01')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });
  it('⛔ rechaza fechas que no existen o mal formadas', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('01/10/2026')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
  });
});

describe('[DEV.1] normalizeProjectInput', () => {
  it('alta mínima: sólo el nombre, normalizado', () => {
    expect(normalizeProjectInput({ title: '  Portal   de  proveedores ' }, true)).toEqual({ title: 'Portal de proveedores' });
  });

  it('⛔ alta sin nombre (o sólo espacios) se rechaza', () => {
    expect(() => normalizeProjectInput({}, true)).toThrow(BadRequestException);
    expect(() => normalizeProjectInput({ title: '   ' }, true)).toThrow(BadRequestException);
    expect(() => normalizeProjectInput(null, true)).toThrow(BadRequestException);
  });

  it('edición sin nombre NO exige nombre y no lo toca', () => {
    expect(normalizeProjectInput({ status: 'en_progreso' }, false)).toEqual({ status: 'en_progreso' });
  });

  it('⛔ nombre demasiado largo', () => {
    expect(() => normalizeProjectInput({ title: 'x'.repeat(TITLE_MAX + 1) }, true)).toThrow(/no puede pasar/);
  });

  it('objetivo vacío se guarda como NULL (no documentado ≠ texto vacío)', () => {
    expect(normalizeProjectInput({ objective: '   ' }, false)).toEqual({ objective: null });
    expect(normalizeProjectInput({ objective: null }, false)).toEqual({ objective: null });
  });

  it('conserva los saltos de línea del objetivo (instrucciones por renglón)', () => {
    const o = normalizeProjectInput({ objective: 'Paso 1\nPaso 2\n' }, false).objective;
    expect(o).toBe('Paso 1\nPaso 2');
  });

  it('⛔ objetivo que no es texto', () => {
    expect(() => normalizeProjectInput({ objective: 42 }, false)).toThrow(BadRequestException);
  });

  it('⛔ prioridad y estado fuera del catálogo', () => {
    expect(() => normalizeProjectInput({ priority: 'altísima' }, false)).toThrow(/Prioridad/);
    expect(() => normalizeProjectInput({ status: 'hecho' }, false)).toThrow(/Estado/);
  });

  it('responsable: uuid válido, vacío = sin asignar, basura = error', () => {
    const id = 'fbe43d20-1317-4fd9-b485-1779a6bd4355';
    expect(normalizeProjectInput({ assignee_user_id: id }, false)).toEqual({ assignee_user_id: id });
    expect(normalizeProjectInput({ assignee_user_id: '' }, false)).toEqual({ assignee_user_id: null });
    expect(normalizeProjectInput({ assignee_user_id: null }, false)).toEqual({ assignee_user_id: null });
    expect(() => normalizeProjectInput({ assignee_user_id: 'david' }, false)).toThrow(/Responsable/);
  });

  it('fecha compromiso: válida, vacía = sin fecha, inexistente = error', () => {
    expect(normalizeProjectInput({ due_date: '2026-10-15' }, false)).toEqual({ due_date: '2026-10-15' });
    expect(normalizeProjectInput({ due_date: '' }, false)).toEqual({ due_date: null });
    expect(() => normalizeProjectInput({ due_date: '2026-13-01' }, false)).toThrow(/Fecha/);
  });

  it('un campo ausente NO aparece en el parche (undefined no borra nada)', () => {
    const p = normalizeProjectInput({ title: 'X' }, false);
    expect(Object.keys(p)).toEqual(['title']);
  });
});

describe('[DEV.1] mxYear', () => {
  it('el 31-dic a las 19:00 MX (01-ene UTC) sigue siendo del año que termina', () => {
    expect(mxYear(new Date('2027-01-01T01:00:00Z'))).toBe(2026);
  });
  it('el 01-ene a las 07:00 MX ya es del año nuevo', () => {
    expect(mxYear(new Date('2027-01-01T13:00:00Z'))).toBe(2027);
  });
});
