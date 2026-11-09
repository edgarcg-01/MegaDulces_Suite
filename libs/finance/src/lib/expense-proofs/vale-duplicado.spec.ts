import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { valeDuplicadoMensaje } from './vale-duplicado';

/**
 * `[GX.91]` — **Una solicitud, un vale vivo.**
 *
 * Medido en prod el 2026-11-05: un doble clic en «Enviar a aprobación» creó DOS vales del mismo
 * folio en el mismo segundo, y otra persona capturó un tercero 12 s después. La pantalla ya lo
 * impedía (`modo()` → «esperando»), el servidor no.
 *
 * El comportamiento (dos transacciones a la vez) sólo se ve con una base real: queda declarado en
 * el tracker. Acá se vigila lo que una regresión rompería al reescribir `create()` a mano: que el
 * candado exista, que vaya ANTES de la revisión y que la revisión vaya ANTES del insert.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));
const BRK = String.fromCharCode(10);
const metodo = (src: string, decl: string): string => {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const fin = src.indexOf(BRK + '  }', i);
  return fin < 0 ? src.slice(i) : src.slice(i, fin);
};

/** Las tres piezas, en orden. `-1` = no está. */
const orden = (cuerpo: string) => ({
  candado: cuerpo.indexOf('pg_advisory_xact_lock'),
  revision: cuerpo.search(/whereNot\(\s*'status',\s*'rechazada'\s*\)/),
  conflicto: cuerpo.indexOf('throw new ConflictException'),
  insert: cuerpo.indexOf(".insert({"),
});
const enOrden = (o: ReturnType<typeof orden>) =>
  o.candado >= 0 && o.revision > o.candado && o.conflicto > o.revision && o.insert > o.conflicto;

describe('[GX.91] create() no deja dos vales vivos del mismo folio', () => {
  const CREATE = metodo(SERVICIO, 'async create(dto: CreateExpenseProofDto');

  it('el método existe (si se renombra, el candado debe saberlo)', () => {
    expect(CREATE.length).toBeGreaterThan(0);
  });

  it('candado → revisión → 409 → insert, en ese orden', () => {
    expect(enOrden(orden(CREATE))).toBe(true);
  });

  it('el candado es por tenant, sucursal y folio (no global: no frena a las demás capturas)', () => {
    expect(CREATE).toMatch(/expense-proof:\$\{this\.tenantCtx\.requireTenantId\(\)\}:\$\{sucursal\}:\$\{folioSolicitud\}/);
  });

  it('el 409 trae el vale que ya existe, para llevar a la persona a él', () => {
    expect(CREATE).toMatch(/vale_id:\s*vivo\.id/);
  });

  /** Prueba negativa: el detector sí ve las formas rotas. */
  it('el detector reconoce el defecto: sin candado, o revisando después del insert', () => {
    const sinCandado = "x.whereNot('status', 'rechazada'); throw new ConflictException(); y.insert({";
    expect(enOrden(orden(sinCandado))).toBe(false);
    const tarde = "pg_advisory_xact_lock; y.insert({ a }); x.whereNot('status', 'rechazada'); throw new ConflictException();";
    expect(enOrden(orden(tarde))).toBe(false);
  });
});

describe('[GX.91] el aviso dice qué pasó y qué hacer', () => {
  it('si el vale es tuyo, te manda a él', () => {
    const m = valeDuplicadoMensaje('0010748', 'recibida', true);
    expect(m).toContain('Ya mandaste un vale de la solicitud 0010748');
    expect(m).toContain('esperando «Revisado»');
    expect(m).toContain('Mis gastos');
  });

  it('si es de otra persona, no te manda a un vale que no puedes abrir', () => {
    const m = valeDuplicadoMensaje('0010748', 'validada', false);
    expect(m).toContain('capturó otra persona');
    expect(m).toContain('revisado');
    expect(m).not.toContain('Mis gastos');
  });

  it('un estado que no conoce se dice crudo, no se disfraza', () => {
    expect(valeDuplicadoMensaje('1', 'raro', true)).toContain('(raro)');
  });
});
