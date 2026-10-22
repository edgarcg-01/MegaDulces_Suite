import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ Por SUBRUTA: el barrel `@megadulces/contracts` **no re-exporta `authz` a propósito**
// (`[ID.28]`). Importarlo de ahí compila y deja `AUTHZ_TREE` en `undefined`, con lo que la
// búsqueda devuelve `null` y el candado parece decir "el nodo no existe".
import { AUTHZ_TREE } from '@megadulces/contracts/authz/authz-tree';
import {
  aBase64,
  codigoDeIndicio,
  nombreDeRegla,
  contarDeNadie,
  esDeNadie,
  etiquetaFuente,
  ordenarCandidatas,
  cuadreDePago,
  etiquetaMotivo,
  participacion,
} from './contabilidad-contpaqi-puente.component';

/**
 * `[CP.8.33]` — Candado de **la bandeja del puente** del lado de la pantalla.
 *
 * Dos cosas distintas, porque fallan por motivos distintos:
 *
 *   1. **el cableado** ruta ↔ guard ↔ nodo del árbol ↔ sidebar. Este candado nace porque el
 *      defecto YA OCURRIÓ: el nodo `contpaqi-puente` se declaró apuntando a
 *      `/contabilidad/contpaqi`, que es OTRA página (los libros fiscales de CP.1–CP.4) con
 *      OTRO permiso. Nadie lo hubiera visto hasta que alguien con sólo el permiso del puente
 *      hiciera clic y lo rebotara el guard — el patrón de gates mal partidos de `[IC.13]`;
 *   2. **la clasificación**, que es lo único de esta pantalla que puede mentir con un número:
 *      si `no_aplica` se cuela entre los pendientes, la bandeja pide trabajo que no existe.
 *
 * El (1) se lee de los archivos como TEXTO en vez de importar `app.routes.ts` o el layout: esos
 * módulos arrastran guards, PrimeNG y media app, y un candado no debería depender de que 300
 * imports transitivos carguen en jsdom. Es configuración estructural, no lógica — lo que se
 * comprueba es que dos archivos digan lo mismo, no el comportamiento de una función.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
const leer = (p: string) => readFileSync(join(RAIZ, p), 'utf8');

const RUTA = '/contabilidad/contpaqi-puente';
const PERMISO = 'FISCAL_CONTPAQI_BRIDGE_VER';

describe('[CP.8.33] bandeja del puente — cableado', () => {
  const rutas = leer('apps/view/src/app/app.routes.ts');
  const layout = leer('apps/view/src/app/modules/dashboard/layout/layout.component.ts');

  it('la ruta existe y la gatea el permiso DEL PUENTE', () => {
    const bloque = bloqueDeRuta(rutas, 'contpaqi-puente');
    expect(bloque).toContain('ContabilidadContpaqiPuenteComponent');
    expect(bloque).toContain(`permissionGuard(Permission.${PERMISO})`);
  });

  it('⛔ NO la gatea el permiso de los libros fiscales', () => {
    // `FISCAL_CONTAB_VER` lo tienen 8 roles; el del puente, 5. Heredarlo abriría la pantalla
    // a tres roles que el reparto excluyó con motivo (marketing, cobranza, compras).
    expect(bloqueDeRuta(rutas, 'contpaqi-puente')).not.toContain('FISCAL_CONTAB_VER');
  });

  it('el nodo del árbol apunta a ESA ruta, no a la de los libros', () => {
    // ⚠️ Primero que el ÁRBOL llegó: un import vacío deja `undefined` y las dos aserciones de
    // abajo dirían "el nodo no existe" cuando lo que no existe es el import. Ya pasó.
    expect(Array.isArray(AUTHZ_TREE) && AUTHZ_TREE.length > 0).toBe(true);
    const nodo = buscarNodo(AUTHZ_TREE as unknown as Nodo[], 'contpaqi-puente');
    expect(nodo).toBeTruthy();
    expect(nodo?.route).toBe(RUTA);
    expect(nodo?.view).toContain(PERMISO);
  });

  it('⭐ el árbol y el guard piden EL MISMO permiso', () => {
    // La asimetría es el defecto real: un nodo visible que el guard rebota, o al revés una
    // pantalla alcanzable que la navegación no muestra.
    const nodo = buscarNodo(AUTHZ_TREE as unknown as Nodo[], 'contpaqi-puente');
    const bloque = bloqueDeRuta(rutas, 'contpaqi-puente');
    expect(nodo?.view?.length).toBeGreaterThan(0);
    for (const p of nodo?.view ?? []) expect(bloque).toContain(p);
  });

  it('el sidebar lleva a la misma ruta con el mismo permiso', () => {
    const i = layout.indexOf(RUTA);
    expect(i).toBeGreaterThan(-1);
    expect(layout.slice(i, i + 200)).toContain(`Permission.${PERMISO}`);
  });

  it('⛔ la página de los libros fiscales sigue existiendo y con SU permiso', () => {
    // Prueba negativa del arreglo: separar el puente no debía tocar a la página hermana.
    const bloque = bloqueDeRuta(rutas, 'contpaqi');
    expect(bloque).toContain('ContabilidadContpaqiComponent');
    expect(bloque).toContain('FISCAL_CONTAB_VER');
  });
});

/**
 * El bloque de UNA ruta: de su `path` a la siguiente. ⚠️ Una ventana de N caracteres se comía
 * la ruta de al lado (`polizas`, que sí usa `FISCAL_CONTAB_VER`) y la prueba negativa fallaba
 * por el vecino, no por lo que mide.
 */
function bloqueDeRuta(texto: string, path: string): string {
  const i = texto.indexOf(`path: '${path}',`);
  expect(i).toBeGreaterThan(-1);
  const sig = texto.indexOf(`path: '`, i + 1);
  return texto.slice(i, sig === -1 ? undefined : sig);
}

describe('[CP.8.33] bandeja del puente — la clasificación', () => {
  /** Los cinco motivos reales de enero, medidos contra producción el 2026-10-09. */
  const MOTIVOS = [
    { motivo: 'sin_regla', movimientos: 954 },
    { motivo: 'proveedor_sin_cuenta', movimientos: 216 },
    { motivo: 'no_aplica', movimientos: 148 },
    { motivo: 'sin_centro_costo', movimientos: 135 },
    { motivo: 'sin_medir', movimientos: 21 },
  ];
  const TOTAL = 1474;

  it('⭐ `no_aplica` NO cuenta como pendiente', () => {
    expect(contarDeNadie(MOTIVOS)).toBe(148);
  });

  it('⛔ los pendientes restan TAMBIÉN lo que ya entra al asiento', () => {
    // Mientras el puente rechazaba todo, `total − no_aplica` daba lo mismo. Desde `[CP.8.35]`
    // entran 144 y esa cuenta sobredeclara el trabajo que falta — que es justo el número que
    // alguien mira para estimar cuánto queda.
    const incluidas = 144;
    expect(TOTAL - contarDeNadie(MOTIVOS) - incluidas).toBe(1182);
    // Y las tres cubetas tienen que sumar el universo del mes, sin huecos ni traslapes.
    expect(1182 + incluidas + contarDeNadie(MOTIVOS)).toBe(TOTAL);
  });

  it('los otros cuatro SÍ son trabajo de alguien', () => {
    for (const m of MOTIVOS.filter((x) => x.motivo !== 'no_aplica')) {
      expect(esDeNadie(m.motivo)).toBe(false);
    }
  });

  it('un motivo desconocido se cuenta como pendiente, no se descarta', () => {
    // ⚠️ El lado seguro: si mañana el backend agrega un motivo, que aparezca pidiendo dueño
    // en vez de desaparecer en silencio del total.
    expect(esDeNadie('motivo_que_no_existe_todavia')).toBe(false);
    expect(contarDeNadie([{ motivo: 'motivo_nuevo', movimientos: 99 }])).toBe(0);
  });

  it('la clave técnica se muestra traducida, y la que no conozco se muestra tal cual', () => {
    expect(etiquetaMotivo('no_aplica')).toBe('No genera póliza');
    expect(etiquetaMotivo('inventado')).toBe('inventado');
  });

  it('los motivos suman el total del mes: ninguno se pierde', () => {
    expect(MOTIVOS.reduce((a, m) => a + m.movimientos, 0)).toBe(TOTAL);
  });

  it('la participación cuadra a 100% y no revienta con denominador cero', () => {
    const suma = MOTIVOS.reduce((a, m) => a + participacion(m.movimientos, TOTAL), 0);
    expect(suma).toBeCloseTo(100, 6);
    // ⛔ Sin esta guarda la tabla imprime `NaN%`, que se lee como datos rotos.
    expect(participacion(0, 0)).toBe(0);
  });
});

describe('[CP.8.54] marcar entregado — los bytes viajan intactos', () => {
  it('⭐ base64 de un archivo de más de un tramo (0x8000) reproduce los bytes exactos', () => {
    // Bytes de 0 a 255, incluido lo que en latin1 es un acento: el archivo es de ancho fijo y
    // un solo byte cambiado corre todas las columnas del renglón.
    const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
    const vuelta = Uint8Array.from(atob(aBase64(bytes)), (c) => c.charCodeAt(0));
    expect(vuelta.length).toBe(bytes.length);
    expect(vuelta.every((b, i) => b === bytes[i])).toBe(true);
  });

  it('el archivo vacío no revienta', () => {
    expect(aBase64(new Uint8Array(0))).toBe('');
  });
});

interface Nodo { id: string; route?: string; view?: string[]; projects?: Nodo[]; modules?: Nodo[]; }

function buscarNodo(nodos: Nodo[], id: string): Nodo | null {
  for (const n of nodos ?? []) {
    if (n.id === id) return n;
    const hijo = buscarNodo((n.projects ?? n.modules ?? []) as Nodo[], id);
    if (hijo) return hijo;
  }
  return null;
}

describe('[CP.8.14] reglas de cuenta — lo que la pantalla deriva', () => {
  const catalogo = [{ codigo: '5200650000' }, { codigo: '5200600000' }];

  it('el indicio se ofrece sólo si su cuenta está en el catálogo firmable', () => {
    expect(codigoDeIndicio('5200650000 COMISIONES Y SITUACIONES (94.4%)', catalogo)).toBe('5200650000');
  });

  it('⛔ un indicio a una cuenta fuera del catálogo NO se ofrece (el backend la rechazaría)', () => {
    expect(codigoDeIndicio('2120000112 EFFEM (80%)', catalogo)).toBeNull();
  });

  it('sin indicio, o sin código al inicio, no se ofrece nada', () => {
    expect(codigoDeIndicio(null, catalogo)).toBeNull();
    expect(codigoDeIndicio('sin evidencia utilizable', catalogo)).toBeNull();
  });

  it('el nombre sale de la primera frase de la evidencia, y si no sirve, del código', () => {
    expect(nombreDeRegla({ evidencia: 'Comisión bancaria. 2,788 movs', categoria_code: 'comision_bancaria' }))
      .toBe('Comisión bancaria');
    expect(nombreDeRegla({ evidencia: null, categoria_code: 'renta' })).toBe('renta');
  });
});

describe('[CP.8.72] pago a proveedor armado completo — lo que la pantalla dice', () => {
  it('cada motivo nuevo de pago a proveedor tiene rótulo humano (no se ve la clave cruda)', () => {
    for (const m of ['pago_a_confirmar', 'pago_sin_resolver', 'pago_no_cuadra', 'pago_proveedor_sin_cuenta',
      'pago_sin_facturas', 'pago_importe_invalido', 'pago_error']) {
      expect(etiquetaMotivo(m)).not.toBe(m);
    }
  });
  it('los pagos que no se arman NO son «de nadie»: tienen dueño (confirmar)', () => {
    expect(esDeNadie('pago_a_confirmar')).toBe(false);
  });
  it('de dónde salen las facturas, en el idioma de quien mira', () => {
    expect(etiquetaFuente('cadena_kepler')).toBe('lo que aplicó Kepler');
    expect(etiquetaFuente('importe_una')).toBe('una factura por importe');
    expect(etiquetaFuente(null)).toBe('—');
  });
});

describe('[CP.8.73] confirmar un pago a proveedor — lo que decide el botón', () => {
  const f = (uuid: string, total: number, fecha: string) => ({ uuid, folio: uuid, fecha, total });
  const facturas = [f('A', 6960, '2026-09-01'), f('B', 4640, '2026-09-05'), f('C', 1000, '2026-09-20')];
  const notas = [f('N', 300, '2026-09-10')];

  it('lo sugerido va primero, después lo más reciente', () => {
    expect(ordenarCandidatas(facturas, ['A']).map((x) => x.uuid)).toEqual(['A', 'C', 'B']);
    expect(ordenarCandidatas(facturas, []).map((x) => x.uuid)).toEqual(['C', 'B', 'A']);
    expect(ordenarCandidatas(facturas, ['B']).find((x) => x.uuid === 'B')?.sugerida).toBe(true);
  });
  it('⛔ sin ninguna factura marcada NO cuadra, aunque la diferencia fuera cero', () => {
    expect(cuadreDePago(facturas, notas, new Set(), new Set(), 0).cuadra).toBe(false);
  });
  it('facturas − notas = pagado (±$1) cuadra; un peso o más, no', () => {
    expect(cuadreDePago(facturas, notas, new Set(['A', 'B']), new Set(), 11600).cuadra).toBe(true);
    expect(cuadreDePago(facturas, notas, new Set(['A', 'B']), new Set(), 11599.40).cuadra).toBe(true);
    expect(cuadreDePago(facturas, notas, new Set(['A', 'B']), new Set(), 11599).cuadra).toBe(false);
    const c = cuadreDePago(facturas, notas, new Set(['A', 'B', 'C']), new Set(['N']), 12300);
    expect(c).toEqual({ facturas: 12600, notas: 300, diferencia: 0, cuadra: true });
  });
  it('la fuente «confirmada» tiene rótulo', () => {
    expect(etiquetaFuente('confirmada')).toBe('lo que confirmó contabilidad');
  });
});
