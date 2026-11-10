import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import knexFactory from 'knex';
import { nombreLigable, solicitaDe, sqlNombreNormalizado, SQL_MI_NOMBRE_LIGABLE, SQL_SOLICITA_COMO_NOMBRE } from './solicita-por-nombre';

/**
 * `[GX.108]` — Candado de **la solicitud de Kepler le llega a quien la pidió también por su nombre.**
 *
 * Medido en prod el 2026-11-10 (sólo lectura): 1,600 solicitudes sin vale no le llegaban a nadie porque
 * la caja «Solicita» trae nombres y no usuarios; por nombre se ligan 474 a 7 personas, ninguna a dos.
 * Lo que cuida, sobre todo, es la PRIVACIDAD: nadie ve el gasto de otro. La prueba con homónimos de
 * verdad (dos usuarios y una solicitud) pide base; aquí se compila el SQL y se cuida su forma.
 */
const db = knexFactory({ client: 'pg' });

describe('[GX.108] nombreLigable — qué nombre sirve para ligar', () => {
  it('⭐ un nombre de persona (dos palabras o más) sí', () => {
    expect(nombreLigable('DEMO PEREZ NUNEZ')).toBe(true);
    expect(nombreLigable('DEMO CAPTURISTA')).toBe(true);
  });

  it('⛔ una sola palabra es un área o un alias: no se liga', () => {
    for (const n of ['RRHH', 'FINANZAS', 'CONTABILIDAD', 'ADMIN', '']) expect(nombreLigable(n)).toBe(false);
    expect(nombreLigable(null)).toBe(false);
  });
});

describe('[GX.108] la llave de nombre (SQL)', () => {
  it('sólo letras: mayúsculas, sin acentos, y lo demás (punto, coma, espacio duro) como espacio', () => {
    const s = sqlNombreNormalizado('u.nombre');
    expect(s).toBe("btrim(regexp_replace(translate(upper(coalesce(u.nombre, '')), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'), '[^A-Z]+', ' ', 'g'))");
    // El rol de lectura de prod no alcanza `unaccent`: no se usa.
    expect(s).not.toContain('unaccent');
    expect(SQL_SOLICITA_COMO_NOMBRE).toBe(sqlNombreNormalizado('r.solicitante'));
  });

  it('⛔ el candado de privacidad: si OTRO usuario tiene todas mis palabras, mi nombre no se usa', () => {
    // «JUAN PEREZ» frente a «JUAN PEREZ LOPEZ» (que en Kepler escribe «JUAN PEREZ»): contenido = ambiguo.
    expect(SQL_MI_NOMBRE_LIGABLE).toContain('u2.username <> ?');
    expect(SQL_MI_NOMBRE_LIGABLE).toMatch(/string_to_array\(btrim\(regexp_replace\(.*u2\.nombre.*\), ' '\) @> string_to_array\(n\.nom, ' '\)/s);
    expect(SQL_MI_NOMBRE_LIGABLE).toContain("WHERE n.nom <> ''");
    // Cuatro parámetros: tenant, username, tenant, username.
    expect(SQL_MI_NOMBRE_LIGABLE.split('?').length - 1).toBe(4);
  });
});

describe('[GX.108] solicitaDe, compilado', () => {
  const r = () => db('analytics.expense_requests as r').where('r.tenant_id', 't').select('r.folio');

  it('⭐ usuario O nombre, y el O queda DENTRO de su paréntesis (no se come el tenant)', () => {
    const s = r().modify(solicitaDe, 'DEMO.CAPTURISTA', 'DEMO PEREZ NUNEZ').toSQL().toNative();
    expect(s.sql).toBe('select "r"."folio" from "analytics"."expense_requests" as "r" where "r"."tenant_id" = $1'
      + " and (upper(regexp_replace(btrim(r.solicitante),'\\s+',' ','g')) = $2 or " + SQL_SOLICITA_COMO_NOMBRE + ' = $3)');
    expect(s.bindings).toEqual(['t', 'DEMO.CAPTURISTA', 'DEMO PEREZ NUNEZ']);
  });

  it('⛔ sin nombre ligable, sólo el usuario (como antes de GX.108)', () => {
    const s = r().modify(solicitaDe, 'DEMO.CAPTURISTA', null).toSQL().toNative();
    expect(s.sql).not.toContain(' or ');
    expect(s.bindings).toEqual(['t', 'DEMO.CAPTURISTA']);
  });
});

describe('[GX.108] el servicio liga por nombre sólo cuando es seguro', () => {
  const SERVICIO = readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8');
  const i = SERVICIO.indexOf('async valesAsignados(');
  const cuerpo = SERVICIO.slice(i, SERVICIO.indexOf('\n  async ', i + 10));

  it('lo asignado se busca con solicitaDe, y el nombre sólo pasa si es ligable', () => {
    expect(cuerpo).toContain('.modify(solicitaDe, u, miNombre)');
    expect(cuerpo).toContain('trx.raw(SQL_MI_NOMBRE_LIGABLE, [tenantId, yoUsuario, tenantId, yoUsuario])');
    expect(cuerpo).toContain('nombreLigable(yo.nom)');
  });

  it('devuelve el día de captura (para «Se mandó» y los días)', () => {
    expect(cuerpo).toContain("to_char(r.capturado_at,'YYYY-MM-DD') AS capturado");
    expect(cuerpo).toContain("capturado: (r['capturado'] as string) ?? null,");
  });
});
