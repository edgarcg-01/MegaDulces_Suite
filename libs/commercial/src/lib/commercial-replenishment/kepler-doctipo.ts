/**
 * `[KR.10]` — **Las dos formas de documento que la Suite le escribe a Kepler.**
 *
 * Plan: [`FASE_KR_REQUISICION_A_KEPLER.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_KR_REQUISICION_A_KEPLER.md).
 *
 * La compra y el traspaso **no son el mismo documento con otro código**: cambian la coordenada,
 * el prefijo del folio, qué va en `c10`, y —la que muerde— **qué significa `c11`**. Juntarlos en
 * un `if` dentro del adapter esconde justo eso. Acá queda una tabla, legible de un vistazo, con
 * el porqué de cada campo medido contra el ERP el 2026-10-13.
 *
 * ⛔⛔ **`c11` NO significa lo mismo en los dos**, y es la trampa que haría escribir basura:
 *   - En `X-A-30` es la **referencia** libre → ahí va el folio de la Suite.
 *   - En `U-D-40` es el **ESTADO del flujo** (`AUTORIZADO` → `SURTIDO` → `CHECADO` →
 *     `EMBARCADO`). Escribir `RQ-2026-00807` ahí dejaría un pedido en un estado inexistente.
 *     Su marca va en `c24`, que es texto libre de verdad: la gente escribe ahí cosas como
 *     *"TRASPASO CANINDO A ZAMORA CENTRO"* y hasta *"LO QUE DIJO LUPITA"*.
 *
 * ⭐ **Por qué la marca importa y no es decorativa:** el 2026-10-13 hubo que limpiar cuatro
 * documentos de prueba del ERP, y lo único que permitió distinguirlos de los que captura
 * compras —sin adivinar— fue el folio de la Suite escrito en `c11`. Un documento nuestro sin
 * marca sólo se puede reconocer por su folio de Kepler, que vive de nuestro lado: si se pierde
 * esa liga, el documento queda huérfano adentro del ERP.
 */

export type KeplerDoctipo = 'compra' | 'traspaso';

export interface DoctipoSpec {
  /** `(c2, c3, c4)` — género · naturaleza · grupo. */
  genero: string;
  naturaleza: string;
  grupo: string;
  /** `c63`, el prefijo del folio. Informativo: lo trae la plantilla. */
  prefijo: string;
  /** `c31`, la etiqueta corta del documento. */
  etiqueta: string;
  /** `c27`. `null` = la compra no lo usa. */
  c27: string | null;
  /**
   * `c11`: qué se escribe. `'referencia'` = el folio de la Suite; o un literal = el estado
   * inicial del flujo, y entonces la marca va a `c24`.
   */
  c11: 'referencia' | string;
  /** Dónde va el folio de la Suite. */
  marca: 'c11' | 'c24';
  /**
   * ⛔ Columnas que un documento NUEVO debe dejar VACÍAS porque las llena el proceso después.
   * Medido comparando recién creados contra procesados: en `U-D-40` son los responsables de
   * surtir, checar y embarcar (90-91 % de los procesados, **0 %** de los nuevos). Clonar un
   * documento procesado sin limpiarlas pare un pedido que nace diciendo que ya lo surtió
   * alguien. En `X-A-30` **no existe ninguna**: se midió y no hay una sola columna que aparezca
   * sólo en las requisiciones ya convertidas a orden de compra.
   */
  limpiar: string[];
  /** Variables de entorno con la coordenada del documento plantilla. */
  envSerie: string;
  envFolio: string;
  /** Doctypes (`c4`) de los que se lee el precedente de unidad para este tipo. */
  gruposPrecedente: string[];
}

export const DOCTIPOS: Readonly<Record<KeplerDoctipo, DoctipoSpec>> = Object.freeze({
  /** Requisición de compra. Verificada contra el ERP: 3,110 documentos en `md_00`. */
  compra: {
    genero: 'X', naturaleza: 'A', grupo: '30',
    prefijo: 'XA3001-', etiqueta: 'Req', c27: null,
    c11: 'referencia', marca: 'c11',
    limpiar: [],
    envSerie: 'KEPLER_REQ_TEMPLATE_SERIE', envFolio: 'KEPLER_REQ_TEMPLATE_FOLIO',
    // La OC (`35`) sirve de precedente igual que la requisición: es la misma línea, un paso después.
    gruposPrecedente: ['30', '35'],
  },
  /**
   * Pedido de traspaso. 955 documentos en 120 días, **951 con `c27='SUCURSAL'`**, y 886 (92.8 %)
   * derivaron en su embarque `U-D-41`. ⚠️ El "cliente" de `c10` es un pseudo-cliente `TI###`
   * que **no se puede inferir del número de sucursal** (`02`→`TI008`, `03`→`TI002`): lo resuelve
   * el adapter leyendo `md.pv_suc_ip`.
   */
  traspaso: {
    genero: 'U', naturaleza: 'D', grupo: '40',
    prefijo: 'PD-', etiqueta: 'Ped', c27: 'SUCURSAL',
    c11: 'AUTORIZADO', marca: 'c24',
    limpiar: ['c100', 'c102', 'c103'],
    envSerie: 'KEPLER_PED_TEMPLATE_SERIE', envFolio: 'KEPLER_PED_TEMPLATE_FOLIO',
    gruposPrecedente: ['40', '41'],
  },
});

/** La coordenada del documento, para mensajes y para el `WHERE`. */
export const coordenada = (t: KeplerDoctipo): string => {
  const d = DOCTIPOS[t];
  return `${d.genero}-${d.naturaleza}-${d.grupo}`;
};
