import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RQ.12]` — **Autorizar una requisición es una facultad APARTE de operarla.**
 *
 * Nace de una decisión de negocio (2026-10-08): *toda requisición la autoriza `arizbeth_gonzalez`,
 * y el proceso sigue*. Las dos mitades de esa frase viven en este archivo, y la segunda es la que
 * de verdad protege:
 *
 * ⛔ **El camino obvio era recortar `COMPRAS_REQUISICIONES_GESTIONAR`, y habría roto la operación.**
 * Esa llave gatea OCHO endpoints y la tienen **29 personas en 9 roles** (medido en prod el
 * 2026-10-08). Recortarla deja a 28 de ellas sin poder armar un pedido. Por eso sólo los tres
 * endpoints que DECIDEN cambian de llave, y los cinco que OPERAN se quedan — y este candado se
 * pone rojo si alguien, «por simetría», mueve `order` o `receive` a la llave de autorizar.
 *
 * ⚠️ **Qué NO afirma este archivo.** Lee el FUENTE del controlador: comprueba qué decorador tiene
 * cada ruta, no que el guard lo honre en runtime (eso es `RolesGuard`, probado aparte), ni que la
 * persona correcta tenga la llave (eso es la migración `20261008115334`, que lo mide al aplicarse).
 * Mismo alcance que `inventory-count.asignar.spec.ts`, de donde sale este molde.
 */

const CTRL = readFileSync(join(__dirname, 'commercial-replenishment.controller.ts'), 'utf8');

/**
 * El bloque de UNA ruta: desde su decorador de método hasta el de la siguiente.
 *
 * Se corta en el próximo decorador y NO por longitud fija: un corte por caracteres se come el
 * decorador del vecino y pone el candado en rojo con el código intacto.
 */
function bloqueDe(fuente: string, metodo: string, ruta: string): string {
  const i = fuente.indexOf(`@${metodo}('${ruta}')`);
  if (i < 0) throw new Error(`No existe la ruta @${metodo}('${ruta}')`);
  const resto = fuente.slice(i + 1);
  const siguiente = resto.search(/@(Get|Post|Delete|Put|Patch)\(/);
  return siguiente < 0 ? fuente.slice(i) : fuente.slice(i, i + 1 + siguiente);
}

/**
 * La llave que EXIGE una ruta — no su bloque entero.
 *
 * ⛔ **La primera versión de este archivo comparaba contra el bloque crudo y salió roja con el
 * código correcto.** El bloque de una ruta llega hasta el decorador de la siguiente, así que se
 * traga el comentario que explica a la que viene — y ese comentario nombra las dos llaves. O sea:
 * *escribir un comentario entre dos rutas rompía el candado.* Un candado que se cae con prosa no
 * mide permisos, mide redacción. Acá se extrae el `@RequirePermissions(...)` de ESA ruta y se
 * compara contra eso.
 *
 * Si la ruta no declara permiso, se lanza: una ruta sin gate no puede pasar en silencio.
 */
function permisoDe(fuente: string, metodo: string, ruta: string): string {
  const b = bloqueDe(fuente, metodo, ruta);
  const m = /@RequirePermissions\(([^)]*)\)/.exec(b);
  if (!m) throw new Error(`La ruta @${metodo}('${ruta}') no declara @RequirePermissions`);
  return m[1];
}

const AUTORIZAR = 'COMPRAS_REQUISICIONES_AUTORIZAR';
const GESTIONAR = 'COMPRAS_REQUISICIONES_GESTIONAR';

/** Los tres que DECIDEN: comprometen el dinero. */
const DECIDEN: ReadonlyArray<[string, string]> = [
  ['Post', 'requisitions/:id/approve'],
  ['Post', 'requisitions/:id/reject'],
  ['Post', 'requisitions/bulk'],
];

/** Los cinco que OPERAN: arman, corrigen y mueven la mercancía. */
const OPERAN: ReadonlyArray<[string, string]> = [
  ['Post', 'requisitions'],
  ['Post', 'requisitions/batch'],
  ['Post', 'requisitions/:id/recalculate'],
  ['Post', 'requisitions/:id/order'],
  ['Post', 'requisitions/:id/receive'],
];

describe('[RQ.12] el arnés del candado', () => {
  /**
   * Sin esto, un extractor que devolviera cadena vacía pondría en verde TODOS los `not.toContain`
   * de abajo — que son justamente las aserciones que separan decidir de operar.
   */
  it('el extractor devuelve UNA llave, no una cadena vacía', () => {
    const p = permisoDe(CTRL, 'Post', 'requisitions/:id/approve');
    expect(p).toContain('COMPRAS_REQUISICIONES');
    expect(p.length).toBeGreaterThan(20);
  });

  it('y falla fuerte si la ruta no existe (una ruta renombrada no pasa en silencio)', () => {
    expect(() => permisoDe(CTRL, 'Post', 'requisitions/:id/no-existe')).toThrow(/No existe la ruta/);
  });

  it('⚠️ el extractor NO se come el decorador del vecino', () => {
    // `requisitions/:id/order` está pegado a `receive`. Si el corte se pasara, este bloque traería
    // las dos rutas y las aserciones de abajo medirían la equivocada.
    expect(bloqueDe(CTRL, 'Post', 'requisitions/:id/order')).not.toContain('receive');
  });

  it('⭐ y NO se cae por un COMENTARIO entre dos rutas — ése fue el bug de este archivo', () => {
    // El bloque crudo de `batch` llega hasta `approve` y se traga el comentario que nombra las dos
    // llaves; la llave extraída, no. Si alguien vuelve a comparar contra el bloque, esto se rompe.
    expect(bloqueDe(CTRL, 'Post', 'requisitions/batch')).toContain(AUTORIZAR);
    expect(permisoDe(CTRL, 'Post', 'requisitions/batch')).not.toContain(AUTORIZAR);
  });
});

describe('[RQ.12] decidir es de AUTORIZAR', () => {
  for (const [metodo, ruta] of DECIDEN) {
    it(`${metodo} ${ruta} exige ${AUTORIZAR}`, () => {
      expect(permisoDe(CTRL, metodo, ruta)).toContain(AUTORIZAR);
    });

    it(`⛔ ${metodo} ${ruta} ya NO se abre con sólo ${GESTIONAR}`, () => {
      // Ésta es la aserción del pedido: con las 29 personas que tienen GESTIONAR pudiendo aprobar,
      // «la única que autoriza» no existe. `AUTORIZAR` contiene a `GESTIONAR` como substring NO,
      // son cadenas distintas — pero `COMPRAS_REQUISICIONES_` sí es prefijo común, así que se
      // compara la llave COMPLETA con su paréntesis de cierre para no casar por prefijo.
      expect(permisoDe(CTRL, metodo, ruta)).not.toContain(GESTIONAR);
    });
  }
});

describe('[RQ.12] operar se queda donde estaba — «que el proceso siga»', () => {
  for (const [metodo, ruta] of OPERAN) {
    it(`${metodo} ${ruta} sigue con ${GESTIONAR}`, () => {
      expect(permisoDe(CTRL, metodo, ruta)).toContain(GESTIONAR);
    });

    it(`⛔ ${metodo} ${ruta} NO exige autorizar (frenaría a 28 personas)`, () => {
      // Si alguien mueve `receive` acá, la mercancía que llega al almacén no se puede registrar
      // hasta que ella lo haga — y nadie lo notaría hasta el primer camión.
      expect(permisoDe(CTRL, metodo, ruta)).not.toContain(AUTORIZAR);
    });
  }
});

describe('[RQ.12] la llave no se reparte de paquete', () => {
  const PERMISOS = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'contracts', 'src', 'authz', 'permissions.ts'), 'utf8');

  it('la llave existe en el enum', () => {
    expect(PERMISOS).toContain(`${AUTORIZAR} = '${AUTORIZAR}'`);
  });

  it('⭐ NEGATIVA: no vive en ningún MODULE_GROUP — se reparte por PERSONA, no por rol', () => {
    // Hay DOS `gerente_compras` en prod; entrar a un grupo le daría la llave a quien nadie nombró.
    // Los grupos se declaran como `MODULE_GROUP*` / `GRUPO*` con listas de permisos; si la llave
    // aparece dentro de uno, este candado se pone rojo.
    const grupos = PERMISOS.split(/export const (?=[A-Z_]*GROUP)/).slice(1).join('\n');
    expect(grupos).not.toContain(AUTORIZAR);
  });
});
