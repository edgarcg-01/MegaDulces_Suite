import {
  MENSAJE_EXPEDIENTE_AJENO, PERMISOS_VEN_CUALQUIER_EXPEDIENTE, puedeVerCualquierExpediente,
} from './ver-expediente.contract';
import { esDuenoDelVale } from './dueno-del-vale.contract';

/**
 * `[GX.68]` Candado del alcance con que se abre el expediente de un vale.
 *
 * Lo que vigila es un par que **no se puede separar**: el endpoint ahora deja entrar también a
 * quien sólo captura, y lo único que impide que eso le entregue los comprobantes de toda la
 * empresa a 76 personas es que, sin `VER` ni `COMPROBAR`, el vale **tiene que ser suyo**.
 *
 * Si alguna de las dos mitades se afloja, la otra deja de alcanzar — por eso las dos se
 * prueban acá juntas, y no cada una en su archivo.
 */

/** Un rol de plataforma, como lo resolvería `isPlatformAdminRole`. */
const esAdmin = (r?: string | null) => r === 'superadmin' || r === 'admin';

describe('[GX.68] puedeVerCualquierExpediente', () => {
  it('`FINANCE_EXPENSES_VER` abre cualquier expediente', () => {
    expect(puedeVerCualquierExpediente({ permissions: { FINANCE_EXPENSES_VER: true } })).toBe(true);
  });

  /** Quien firma gatea con `_COMPROBAR`: sin esto no podría abrir lo que tiene que autorizar. */
  it('`FINANCE_EXPENSES_COMPROBAR` también', () => {
    expect(puedeVerCualquierExpediente({ permissions: { FINANCE_EXPENSES_COMPROBAR: true } })).toBe(true);
  });

  /**
   * ⭐ EL CANDADO: capturar NO alcanza para ver lo ajeno. Si esto se pone en `true`, 76
   * personas pasan a ver los comprobantes de toda la empresa.
   */
  it('⛔ NEGATIVA: `FINANCE_EXPENSES_CAPTURAR` NO abre el expediente de cualquiera', () => {
    expect(puedeVerCualquierExpediente({ permissions: { FINANCE_EXPENSES_CAPTURAR: true } })).toBe(false);
  });

  /**
   * ⛔ `RolesGuard` deja pasar a admin/superadmin aunque no tengan la clave. Sin esta rama,
   * un superadmin entraría por el guard y quedaría acotado a «sus» vales — vería un
   * expediente vacío en vez de un error, que es la peor de las dos fallas.
   */
  it('el rol de plataforma abre, aunque el mapa de permisos venga vacío', () => {
    expect(puedeVerCualquierExpediente({ role_name: 'superadmin' }, esAdmin)).toBe(true);
    expect(puedeVerCualquierExpediente({ role_name: 'superadmin', permissions: {} }, esAdmin)).toBe(true);
  });

  /** Sin pasar el resolvedor, el rol no decide nada: el default es cerrado, no abierto. */
  it('sin resolvedor de admin, el rol no abre por sí solo', () => {
    expect(puedeVerCualquierExpediente({ role_name: 'superadmin' })).toBe(false);
  });

  /**
   * ⛔ Una clave en `false` es lo que queda al guardar el mapa completo desde `/admin/roles`.
   * Si se leyera como truthy, repartiría permiso justo donde alguien lo quitó.
   */
  it('⛔ NEGATIVA: una clave en `false` no abre', () => {
    expect(puedeVerCualquierExpediente({ permissions: { FINANCE_EXPENSES_VER: false } })).toBe(false);
  });

  it('sin usuario, sin permisos y con mapa nulo: cerrado', () => {
    expect(puedeVerCualquierExpediente(null)).toBe(false);
    expect(puedeVerCualquierExpediente(undefined)).toBe(false);
    expect(puedeVerCualquierExpediente({})).toBe(false);
    expect(puedeVerCualquierExpediente({ permissions: null })).toBe(false);
  });

  /** La lista es la del contrato: si alguien agrega una clave, que se vea acá. */
  it('las claves que abren son exactamente dos', () => {
    expect([...PERMISOS_VEN_CUALQUIER_EXPEDIENTE])
      .toEqual(['FINANCE_EXPENSES_VER', 'FINANCE_EXPENSES_COMPROBAR']);
  });
});

describe('[GX.68] el par alcance + propiedad', () => {
  const soloCaptura = { permissions: { FINANCE_EXPENSES_CAPTURAR: true }, username: 'cajero_ph', full_name: 'Ana Ruiz' };

  /** ⭐ El caso que esta fase existe para arreglar: su propio vale, y lo puede abrir. */
  it('⭐ quien sólo captura ABRE el vale que levantó', () => {
    const vale = { created_by: 'cajero_ph' };
    expect(puedeVerCualquierExpediente(soloCaptura)).toBe(false);
    expect(esDuenoDelVale(vale, soloCaptura)).toBe(true);
  });

  /** El vale guardado con el NOMBRE, no con el username: es el caso que ya había mordido. */
  it('también el que quedó guardado con su nombre completo', () => {
    expect(esDuenoDelVale({ created_by: 'Ana Ruiz' }, soloCaptura)).toBe(true);
  });

  /** `[GX.34]` Subir la evidencia también lo hace suyo: si no, no podría revisar lo que subió. */
  it('y aquel al que le subió la evidencia', () => {
    expect(esDuenoDelVale({ created_by: 'otra_persona', evidencia_por: 'Ana Ruiz' }, soloCaptura)).toBe(true);
  });

  /** ⛔ Lo ajeno sigue cerrado: es la mitad que impide que esto sea abrir la puerta. */
  it('⛔ NEGATIVA: NO abre el vale de otra persona', () => {
    const ajeno = { created_by: 'otro_cajero', evidencia_por: 'Luis Pérez' };
    expect(puedeVerCualquierExpediente(soloCaptura)).toBe(false);
    expect(esDuenoDelVale(ajeno, soloCaptura)).toBe(false);
  });
});

describe('[GX.68] el mensaje', () => {
  /**
   * ⛔ El visor mostraba *«Puede ser la conexión — reintentá»* ante un 403. Un permiso no se
   * arregla reintentando; mandar a reintentar algo que no se arregla así es peor que no decir
   * nada (la lección de `[GX.37]`).
   */
  it('⛔ NEGATIVA: no invita a reintentar ni habla de conexión', () => {
    expect(MENSAJE_EXPEDIENTE_AJENO).not.toMatch(/reintent/i);
    expect(MENSAJE_EXPEDIENTE_AJENO).not.toMatch(/conexi[oó]n/i);
  });

  it('dice qué se puede abrir y qué hace falta', () => {
    expect(MENSAJE_EXPEDIENTE_AJENO).toMatch(/levantaste/i);
    expect(MENSAJE_EXPEDIENTE_AJENO).toMatch(/permiso/i);
  });
});
