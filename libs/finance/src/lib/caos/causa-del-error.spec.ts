import { causaDelError } from './causa-del-error';

/**
 * `[CGA-A.37]` El latido del carril de atribución guardaba los primeros 300 caracteres del
 * mensaje de knex, que son SQL: la causa no llegó nunca. El error de abajo tiene la forma real
 * (sentencia completa, ` - `, mensaje de Postgres, y los campos `code`/`constraint`/`detail`).
 */
function errorDeKnex(): Error {
  const params = Array.from({ length: 1667 * 10 }, (_, i) => `$${i + 1}`).join(', ');
  const e = new Error(
    `insert into "finance"."caos_ingreso_atribucion" ("calculado_por", "caos_device") values (${params})`
    + ' - duplicate key value violates unique constraint "ux_caos_atrib_cobro_vivo"',
  ) as Error & { code: string; constraint: string; detail: string };
  e.code = '23505';
  e.constraint = 'ux_caos_atrib_cobro_vivo';
  e.detail = 'Key (tenant_id, cobro_origen_ref)=(…, 00|U-A-5|0014589|0011) already exists.';
  return e;
}

describe('causaDelError — la causa primero, el SQL después', () => {
  it('nombra el código, la restricción y el mensaje de Postgres', () => {
    const c = causaDelError(errorDeKnex());
    expect(c.startsWith('23505 · ux_caos_atrib_cobro_vivo · duplicate key value')).toBe(true);
    expect(c).toContain('00|U-A-5|0014589|0011');
    expect(c).not.toContain('insert into');
  });

  it('⛔ el recorte viejo (los primeros 300 caracteres) NO contenía la causa', () => {
    expect(errorDeKnex().message.slice(0, 300)).not.toContain('ux_caos_atrib_cobro_vivo');
  });

  it('respeta el tope y no inventa nada si el error no es de Postgres', () => {
    expect(causaDelError(new Error('se cayó la red')).length).toBeLessThanOrEqual(300);
    expect(causaDelError(new Error('se cayó la red'))).toBe('se cayó la red');
    expect(causaDelError('texto suelto')).toBe('fallo sin mensaje');
  });
});
