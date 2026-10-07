import { ForbiddenException } from '@nestjs/common';
import { ExpenseProofsController } from './expense-proofs.controller';
import type { ExpenseProofsService } from './expense-proofs.service';

/**
 * `[GX.26]` **El candado del historial de toda la empresa.**
 *
 * `GET /finance/expenses/proofs` devuelve los expedientes de **todas las personas**. Pasó de
 * `FINANCE_EXPENSES_VER` (25 personas, 9 de ellas cuentas de administración) a **god-mode**,
 * por pedido del usuario.
 *
 * ⛔ Esta prueba existe porque el recorte **no puede vivir sólo en la UI**. Esconder la
 * pestaña es la cortesía; si la ruta no comprueba el rol, cualquiera con `_VER` la sigue
 * pudiendo pedir a mano y el «recorte» es una decoración.
 *
 * ⚠️ Y no se puede expresar con el decorador de permisos: `RolesGuard` deja pasar a
 * admin/superadmin **y** a quien tenga la clave, así que `@RequirePermissions(_VER)` por sí
 * solo abre la puerta a los 25. Por eso el rol se comprueba explícito, y por eso se prueba.
 */

/** Un doble del servicio: lo que se comprueba es la PUERTA, no la consulta. */
const servicioFalso = () => {
  const llamadas: unknown[] = [];
  const svc = {
    list: (q: unknown) => { llamadas.push(q); return Promise.resolve({ kpis: {}, rows: [] }); },
  } as unknown as ExpenseProofsService;
  return { svc, llamadas };
};

const pedirHistorial = (role_name?: string | null) => {
  const { svc, llamadas } = servicioFalso();
  const ctrl = new ExpenseProofsController(svc);
  const req = role_name === undefined ? undefined : { user: { role_name } };
  // (status, folio, search, from, to, limit, dia, req) -- `req` es el ULTIMO. Si la firma
  // gana otro @Query, esta llamada se corre: por eso las 3 pruebas de god-mode se pusieron
  // en rojo cuando `[GX.27]` agrego `dia`, y por eso el conteo va explicito aca.
  const correr = () => ctrl.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, req);
  return { correr, llamadas };
};

describe('[GX.26] el historial de toda la empresa es sólo god-mode', () => {
  it('superadmin pasa y la consulta se ejecuta', async () => {
    const { correr, llamadas } = pedirHistorial('superadmin');
    await correr();
    expect(llamadas).toHaveLength(1);
  });

  it('admin también: son los dos roles de plataforma', async () => {
    const { correr, llamadas } = pedirHistorial('admin');
    await correr();
    expect(llamadas).toHaveLength(1);
  });

  /** El rol viaja en el token y puede llegar con otra caja. */
  it('no distingue mayúsculas', async () => {
    const { correr, llamadas } = pedirHistorial('SuperAdmin');
    await correr();
    expect(llamadas).toHaveLength(1);
  });

  /**
   * ⭐ La prueba que sostiene el cambio: quien revisa gastos **ya no** ve los de los demás.
   * Son las 16 personas de finanzas, contabilidad, crédito, compras y tesorería.
   */
  it('⛔ tesorería —que tiene _VER y aprueba gastos— NO pasa', () => {
    const { correr, llamadas } = pedirHistorial('tesoreria');
    expect(correr).toThrow(ForbiddenException);
    expect(llamadas).toHaveLength(0);
  });

  it('⛔ ningún otro rol del área pasa', () => {
    for (const rol of ['finanzas', 'finanzas_operativo', 'contabilidad', 'credito_cobranza',
      'gerente_compras', 'marketing', 'direccion', 'auditor_externo']) {
      const { correr, llamadas } = pedirHistorial(rol);
      expect(() => correr()).toThrow(ForbiddenException);
      expect(llamadas).toHaveLength(0);
    }
  });

  /**
   * ⛔ Sin rol NO se cae del lado permisivo. Un token viejo o una petición armada a mano
   * llegan así, y «no sé quién sos» nunca puede significar «pasá».
   */
  it('sin rol, o sin usuario, se rechaza', () => {
    for (const r of [null, undefined, '']) {
      const { correr, llamadas } = pedirHistorial(r);
      expect(() => correr()).toThrow(ForbiddenException);
      expect(llamadas).toHaveLength(0);
    }
  });

  /** El «no» dice a dónde ir: quien pregunta por lo suyo tiene su propia ruta. */
  it('el rechazo explica que lo propio está en /mine', () => {
    const { correr } = pedirHistorial('tesoreria');
    expect(correr).toThrow(/mine/);
  });
});
