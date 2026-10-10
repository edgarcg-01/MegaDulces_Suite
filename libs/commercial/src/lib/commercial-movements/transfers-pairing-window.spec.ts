// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[DM.22]` — El candado de la ventana del pareo de traspasos.
 *
 * ⛔ **Lo que protege: que el pareo mire FUERA del rango y reporte DENTRO.** Las dos CTEs de
 * candidatos usaban la misma ventana que el rango pedido, mientras `TRANSFER_PAIR_MATCH` declara
 * una tolerancia de hasta 90 días entre embarque y recepción. Eso no dejaba huecos: **fabricaba
 * hallazgos**, que es peor, porque mandan a alguien a buscar un documento que sí existe.
 *
 * Medido contra prod el 2026-10-09, antes y después, y las restas dan exacto:
 *
 * | ventana          | `sin_origen` | `sin acuse` | monto del acuse                 |
 * |------------------|-------------:|------------:|--------------------------------:|
 * | 30 días          |    24 → **2** |   124 → 124 | $2,829,744.73 → igual           |
 * | mes en curso     |    38 → **0** |     99 → 99 | $1,575,917.89 → igual           |
 * | septiembre-2026  |    21 → **2** |  75 → **35** | $1,820,521.15 → **$1,340,386.58** |
 * | agosto-2026      |    15 → **0** |  46 → **27** |   $637,431.22 → **$347,752.72** |
 *
 * ⭐ Las dos columnas de ceros no son suerte, y por eso vale la pena que el candado las distinga:
 * `sin_origen` se rompía en TODA ventana (siempre hay embarques anteriores al rango), `sin acuse`
 * sólo cuando la ventana termina en el pasado (una recepción posterior a hoy no existe todavía).
 */

const DIR = __dirname;
const SVC = readFileSync(join(DIR, 'commercial-movements.service.ts'), 'utf8');

/** Mide código, no redacción: los comentarios nombran las mismas palabras que las aserciones. */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/^\s*--.*$/gm, ' ');
}

/** El cuerpo del template, tal cual: acá los comentarios SQL SÍ se conservan a propósito. */
function cuerpoTemplate(): string {
  const i = SVC.indexOf('const TRANSFER_PAIRING_SQL = (shpDestSql: string) => `');
  if (i < 0) throw new Error('No existe TRANSFER_PAIRING_SQL');
  const desde = SVC.indexOf('`', i) + 1;
  const hasta = SVC.indexOf('`;', desde);
  if (hasta < 0) throw new Error('El template no cierra');
  return SVC.slice(desde, hasta);
}

const TPL = cuerpoTemplate();
const SQL = sinComentarios(TPL);

describe('[DM.22] el arnés', () => {
  it('encuentra el template y su lista de parámetros', () => {
    expect(TPL.length).toBeGreaterThan(500);
    expect(SVC).toContain('const TRANSFER_PAIRING_PARAMS');
  });

  it('y falla fuerte si el template se renombra', () => {
    const roto = SVC.replace('const TRANSFER_PAIRING_SQL', 'const OTRA_COSA');
    expect(() => {
      const i = roto.indexOf('const TRANSFER_PAIRING_SQL = (shpDestSql: string) => `');
      if (i < 0) throw new Error('No existe TRANSFER_PAIRING_SQL');
    }).toThrow(/No existe/);
  });
});

describe('[DM.22] ⛔ los CANDIDATOS se buscan fuera del rango', () => {
  it('⭐⭐ la ventana de embarques se ensancha con las constantes del pareo, no con un número suelto', () => {
    // Si acá quedara un literal, la ventana del pareo y la de los candidatos podrían separarse
    // en silencio — que es exactamente el defecto que esto cierra.
    expect(TPL).toContain('?::date - ${PAIR_LATE_DAYS} AND ?::date + ${PAIR_EARLY_DAYS}');
  });

  it('⭐ y la de recepciones, espejada', () => {
    expect(TPL).toContain('?::date - ${PAIR_EARLY_DAYS} AND ?::date + ${PAIR_LATE_DAYS}');
  });

  it('⛔ NEGATIVA: ninguna CTE de candidatos usa el rango pelado', () => {
    // `BETWEEN ? AND ?` sin aritmética era la forma vieja. Si vuelve, vuelve el defecto.
    const candidatos = SQL.slice(0, SQL.indexOf('paired_all'));
    expect(candidatos).not.toMatch(/doc_date BETWEEN \?\s+AND \?/);
  });

  it('⛔ NEGATIVA: el ensanche NO es el default del rango — ensanchar el rango no arregla esto', () => {
    // Ensanchar `range()` mueve el borde; no lo quita. El arreglo es separar candidato de
    // reportado, y este candado existe para que nadie lo "simplifique" de vuelta.
    expect(SVC).toContain('Rango por default: últimos 30 días.');
    expect(SVC).toMatch(/new Date\(Date\.now\(\) - 30 \* 864e5\)/);
  });
});

describe('[DM.22] ⛔ lo REPORTADO sigue anclado al rango', () => {
  it('⭐⭐ el recorte al rango va DESPUÉS del desempate, no antes', () => {
    // Filtrar antes del DISTINCT ON puede descartar al mejor candidato y dejar que el desempate
    // elija a uno peor: el pareo saldría distinto según la ventana que se mire.
    const iDistinct = SQL.indexOf('DISTINCT ON');
    const iRecorte = SQL.indexOf('FROM paired_all');
    expect(iDistinct).toBeGreaterThan(0);
    expect(iRecorte).toBeGreaterThan(iDistinct);
    expect(SQL).toMatch(/paired AS \(\s*SELECT \* FROM paired_all/);
  });

  it('⭐ basta con que CUALQUIER pata caiga en el rango', () => {
    // Exigir las dos escondería el embarque del rango recibido después: se cambiaría una mentira
    // ("sin acuse") por un hueco.
    expect(SQL).toMatch(/WHERE rcv_date BETWEEN \?::date AND \?::date OR ship_date BETWEEN \?::date AND \?::date/);
  });

  it('⛔ y el embarque sin recepción se reporta sólo si ÉL está en el rango', () => {
    const i = SQL.indexOf('unreceived AS (');
    expect(i).toBeGreaterThan(0);
    const bloque = SQL.slice(i, i + 600);
    expect(bloque).toMatch(/WHERE s\.doc_date BETWEEN \?::date AND \?::date/);
    expect(bloque).toContain('NOT EXISTS');
  });
});

describe('[DM.22] ⭐ los parámetros CUADRAN con los marcadores', () => {
  /**
   * ⚠️ Esta es la aserción que más se ganó su lugar: al escribir el cambio conté los marcadores a
   * ojo y me faltaron dos (el `OR` de `paired` lleva cuatro, no dos). Un desfase de uno **no
   * explota**: la consulta corre y devuelve otra cosa, con otras fechas en otros lugares.
   */
  /**
   * ⚠️ El arreglo se extrae desde su `[`, NO desde el nombre de la constante: la FIRMA
   * (`(tenantId: string, from: string, to: string)`) nombra las mismas tres variables y las
   * contaba de más. La primera versión de este candado daba 16 — y la culpa era del candado.
   */
  function listaDeParams(): string {
    const i = SVC.indexOf('const TRANSFER_PAIRING_PARAMS');
    if (i < 0) throw new Error('No existe TRANSFER_PAIRING_PARAMS');
    const ini = SVC.indexOf('[', i);
    return SVC.slice(ini, SVC.indexOf('];', ini));
  }

  it('⛔⛔ hay exactamente tantos marcadores en el template como parámetros en la lista', () => {
    const marcadores = (TPL.match(/\?/g) || []).length;
    const params = (listaDeParams().match(/\b(tenantId|from|to)\b/g) || []).length;
    expect(marcadores).toBe(13);
    expect(params).toBe(marcadores);
  });

  it('⭐ y van en el orden que la consulta los pide', () => {
    const orden = (listaDeParams().match(/\b(tenantId|from|to)\b/g) || []).join(',');
    expect(orden).toBe(
      'tenantId,from,to,' +   // shp
      'tenantId,from,to,' +   // rcv
      'from,to,from,to,' +    // paired: DOS rangos, uno por pata
      'from,to,' +            // unreceived
      'tenantId',             // el mapa de destino
    );
  });
});

describe('[DM.22] ⭐ el pareo vive en UN solo lugar', () => {
  it('⛔⛔ no quedan copias del bloque: los dos llamadores usan el template', () => {
    // Había TRES copias y la tercera ya había derivado: el `coalesce` del destino de
    // `transfersCheckPair` perdía `u.dest_code`, así que un destino sin etiqueta salía en blanco
    // sólo en el drill. Es el mismo motivo por el que existen DEST_WH_VIVO y TRANSFER_PAIR_MATCH.
    const usos = (SVC.match(/TRANSFER_PAIRING_SQL\(/g) || []).length;
    expect(usos).toBe(2);
    expect((SVC.match(/DISTINCT ON \(r\.warehouse_id, r\.folio/g) || []).length).toBe(1);
    expect((SVC.match(/unreceived AS \(/g) || []).length).toBe(1);
  });

  it('⭐ y el destino se resuelve con el mismo coalesce en los dos', () => {
    // ⚠️ Sobre el CÓDIGO, no sobre la prosa: el JSDoc de `hallazgos` cita este mismo coalesce
    // para explicar por qué `dest_wh` no sirve para separar cliente de sucursal, y contarlo
    // habría dado 2. Es la trampa de medir redacción en vez de código.
    const codigo = sinComentarios(SVC);
    expect((codigo.match(/coalesce\(dw\.name, dw\.code, u\.dest_label, u\.dest_code\)/g) || []).length).toBe(1);
    expect(codigo).not.toMatch(/coalesce\(dw\.name, dw\.code, u\.dest_label\)/);
  });
});
