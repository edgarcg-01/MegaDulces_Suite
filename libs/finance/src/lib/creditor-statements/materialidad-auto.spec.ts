// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[MAT.5]` — El candado de la pasada masiva de casamiento CFDI ↔ operación.
 *
 * ⚠️ **Por qué vive en `libs/finance` y no junto al código que protege.** `libs/fiscal` **no
 * tiene runner de tests** (ni `vitest.config.ts` ni target `test`), y dárselo significa tocar la
 * configuración de Nx, que en este repo no se toca sin autorización. Se declara la deuda acá en
 * vez de dejar el código sin candado o de cambiar la config por mi cuenta.
 *
 * ⛔ **Lo que este archivo protege es UNA cosa, y es la que puede costar caro:** que lo que
 * propone la máquina **nunca** se escriba como lo que verificó una persona. `fiscal.cfdi_assignments`
 * es la evidencia de materialidad que consume `MAT.3`; un cruce por importe y fecha es una pista
 * fuerte, no la prueba de que la operación existió.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..', '..');
const SVC = readFileSync(join(RAIZ, 'libs', 'fiscal', 'src', 'lib', 'materialidad', 'materialidad-assignments.service.ts'), 'utf8');
const CTRL = readFileSync(join(RAIZ, 'libs', 'fiscal', 'src', 'lib', 'materialidad', 'materialidad.controller.ts'), 'utf8');
const MIG = readFileSync(join(RAIZ, 'database', 'migrations-newdb', '20261009153940_cfdi_assignments_auto.js'), 'utf8');

/** Mide código, no redacción: los comentarios nombran las mismas palabras que las aserciones. */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/^\s*--.*$/gm, ' ');
}
const CODIGO = sinComentarios(SVC);
const MIG_SQL = sinComentarios(MIG);

/** El cuerpo de un método, hasta el siguiente de su mismo nivel. */
function cuerpo(nombre: string): string {
  const i = CODIGO.indexOf(`async ${nombre}(`);
  if (i < 0) throw new Error(`No existe el método ${nombre}()`);
  const resto = CODIGO.slice(i + 6);
  const fin = resto.search(/\n {2}(?:async |private |\/\*\* )/);
  return fin < 0 ? CODIGO.slice(i) : CODIGO.slice(i, i + 6 + fin);
}

describe('[MAT.5] el arnés', () => {
  it('encuentra los tres métodos que importan', () => {
    expect(() => cuerpo('autoProponer')).not.toThrow();
    expect(() => cuerpo('confirmarPropuestas')).not.toThrow();
    expect(() => cuerpo('reconcile')).not.toThrow();
  });

  it('y falla fuerte si uno se renombra', () => {
    expect(() => cuerpo('noExiste')).toThrow(/No existe el método/);
  });
});

describe('[MAT.5] ⛔ la máquina PROPONE, nunca confirma', () => {
  const c = cuerpo('autoProponer');

  it('⭐⭐ el lote escribe `auto`, NO `confirmed`', () => {
    // Si escribiera 'confirmed', MAT.3 consumiría como evidencia de materialidad un cruce por
    // importe y fecha que nadie miró. Es la única aserción de este archivo que, al caerse,
    // tiene consecuencia fiscal.
    expect(c).toMatch(/'auto', 'auto_rfc_importe_fecha'/);
    expect(c).not.toMatch(/'confirmed'\s*,\s*'auto_rfc/);
  });

  it('⛔ NEGATIVA: la lista de valores que se INSERTA no lleva confirmed', () => {
    // ⚠️ La primera versión barría todo el INSERT y salía roja con el código correcto: los
    // `NOT EXISTS` de idempotencia nombran 'confirmed' legítimamente — están COMPROBANDO filas
    // existentes, no insertando una. Se acota a la lista de valores, que es lo que se escribe.
    const sel = c.slice(c.indexOf('SELECT :tid,'), c.indexOf('FROM par p'));
    expect(sel.length).toBeGreaterThan(40);
    expect(sel).toContain(`'auto'`);
    expect(sel).not.toContain(`'confirmed'`);
  });

  it('⭐ y la base lo distingue: el CHECK admite el estado nuevo', () => {
    expect(MIG_SQL).toMatch(/status IN \('confirmed', 'rejected', 'auto'\)/);
  });

  it('⭐ confirmar es un acto aparte, y sólo mueve lo que estaba en `auto`', () => {
    const cf = cuerpo('confirmarPropuestas');
    expect(cf).toMatch(/status:\s*'auto'/);
    expect(cf).toMatch(/status:\s*'confirmed'/);
  });

  it('⛔ y al confirmar queda el nombre de QUIEN la miró', () => {
    const cf = cuerpo('confirmarPropuestas');
    expect(cf).toContain('created_by_username');
  });
});

describe('[MAT.5] una sola heurística, no dos', () => {
  const c = cuerpo('autoProponer');

  it('⭐ reusa las constantes de `reconcile`, no números propios', () => {
    // Si el lote tuviera su propia tolerancia, lo que propone y lo que sugiere la pantalla
    // dejarían de coincidir y nadie sabría cuál creer.
    expect(c).toContain('tol: TOL_IMPORTE');
    expect(c).toContain('tolDias: VENTANA_DIAS');
    expect(c).not.toMatch(/<=\s*1\.0\b/);
  });

  it('⛔ NEGATIVA: NO usa el casamiento DÉBIL (sin RFC, por nombre)', () => {
    // Proponer en masa un cruce que se apoya en que dos nombres compartan una palabra siembra
    // trabajo de revisión en vez de ahorrarlo. El débil queda para la pantalla, caso por caso.
    expect(c).not.toContain('VENTANA_DIAS_WEAK');
    expect(c).not.toContain('beneficiario');
  });

  it('⭐ compara contra importe Y contra importe+IVA, como Kepler guarda las dos formas', () => {
    expect(c).toMatch(/LEAST\(abs\([\s\S]{0,200}COALESCE\(e\.iva,0\)/);
  });
});

describe('[MAT.5] sólo el 1:1 estricto, en las DOS direcciones', () => {
  const c = cuerpo('autoProponer');

  it('el CFDI tiene que tener un solo candidato', () => {
    expect(c).toMatch(/unico_cfdi AS \(SELECT cfdi_id FROM par GROUP BY cfdi_id HAVING count\(\*\) = 1\)/);
  });

  it('⭐⭐ y la operación no puede estar reclamada por otro CFDI', () => {
    // Sin esta mitad, dos facturas del mismo importe y fecha se asignarían a la misma entrada.
    expect(c).toMatch(/unica_op[\s\S]{0,160}HAVING count\(\*\) = 1/);
    expect(c).toContain('JOIN unica_op');
  });

  it('⛔ y la base lo vuelve estructural: dos índices únicos parciales', () => {
    expect(MIG_SQL).toMatch(/UNIQUE INDEX[\s\S]{0,140}\(tenant_id, cfdi_id\)[\s\S]{0,80}WHERE status IN \('confirmed', 'auto'\)/);
    expect(MIG_SQL).toMatch(/UNIQUE INDEX[\s\S]{0,160}sucursal, doc_tipo, doc_folio\)[\s\S]{0,80}WHERE status IN \('confirmed', 'auto'\)/);
  });

  it('⭐ `rejected` queda FUERA del índice: descartar el mismo par N veces no es asignar', () => {
    expect(MIG_SQL).not.toMatch(/WHERE status IN \('confirmed', 'auto', 'rejected'\)/);
  });
});

describe('[MAT.5] idempotente: correrlo dos veces no duplica ni pisa', () => {
  const c = cuerpo('autoProponer');

  it('no toca un CFDI que ya tiene asignación viva', () => {
    expect(c).toMatch(/NOT EXISTS[\s\S]{0,200}a\.cfdi_id = p\.cfdi_id[\s\S]{0,120}status IN \('confirmed','auto'\)/);
  });

  it('no reclama una operación ya tomada', () => {
    expect(c).toMatch(/NOT EXISTS[\s\S]{0,260}a2\.doc_folio = p\.doc_folio[\s\S]{0,120}status IN \('confirmed','auto'\)/);
  });

  it('⛔ y NO vuelve a proponer un par que alguien ya descartó', () => {
    // Si lo repropusiera, el lote le devolvería a la persona el mismo trabajo que ya hizo.
    expect(c).toMatch(/a3\.status = 'rejected'/);
  });
});

describe('[MAT.5] lo que NO casó se declara', () => {
  const c = cuerpo('autoProponer');

  it('⭐⭐ la respuesta trae el UNIVERSO, no sólo las propuestas', () => {
    // «1,900 propuestas» sin denominador se lee como «ya está casado todo lo que se podía», y es
    // falso: quedan ~12,900 CFDIs que no tienen ni un candidato. Eso no es ambigüedad, es ausencia.
    expect(c).toContain('cfdis_en_ventana');
    expect(c).toContain('cfdis_sin_candidato');
    expect(c).toContain('pares_ambiguos');
  });

  it('y distingue ausencia de ambigüedad: son dos campos, no uno', () => {
    expect(c).toMatch(/cfdis_sin_candidato:[^,]*\n?[^,]*,/);
    expect(c).not.toMatch(/sin_candidato.*=.*pares_ambiguos/);
  });
});

describe('[MAT.5] la pantalla ve lo que el lote escribió', () => {
  it('⛔ `reconcile` mira TAMBIÉN las propuestas, no sólo lo confirmado', () => {
    // Si siguiera mirando sólo `confirmed`, la pantalla volvería a sugerir lo que ya está
    // propuesto y el trabajo del lote sería invisible.
    expect(cuerpo('reconcile')).toMatch(/a\.status IN \('confirmed', 'auto'\)/);
  });

  it('⭐ y el estado VIAJA al front, para que no los pinte igual', () => {
    expect(CODIGO).toMatch(/status: row\.a_status === 'auto' \? 'auto' : 'confirmed'/);
  });
});

describe('[MAT.5] las rutas', () => {
  it('existen y exigen GESTIONAR: las dos ESCRIBEN', () => {
    for (const r of ['assignments/auto', 'assignments/confirm-batch']) {
      const i = CTRL.indexOf(`@Post('${r}')`);
      expect(i).toBeGreaterThan(0);
      expect(CTRL.slice(i, i + 220)).toContain('FISCAL_MATERIALIDAD_GESTIONAR');
    }
  });
});
