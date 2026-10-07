import { CLASIFICACION_LABEL, type ExpenseClasificacion } from './comprobaciones.service';

/**
 * `[GX.17]` **La clave con la que se guarda no es la palabra con la que se dice.**
 *
 * El tablero de aprobación imprimía el valor crudo de la columna —`no_fiscal_comprobable`—
 * como chip. Quien firma no lee claves de base de datos, y además «fiscal / no fiscal» es
 * vocabulario contable que acá no aporta: lo que la persona necesita saber es si el gasto
 * trae factura, sólo ticket, o nada.
 *
 * El valor guardado **no cambia** (lo fija un CHECK en `finance.expense_proofs` y lo leen
 * otros módulos). Lo que cambia es la etiqueta. Esta prueba es el candado de esa frontera:
 * si alguien vuelve a meter el término, o agrega una clasificación sin etiqueta, se pone
 * roja.
 */
describe('[GX.17] etiquetas de la clasificación del gasto', () => {
  const claves = Object.keys(CLASIFICACION_LABEL) as ExpenseClasificacion[];

  it('las tres clasificaciones que acepta el backend tienen etiqueta', () => {
    expect(claves.sort()).toEqual(['fiscal', 'no_comprobable', 'no_fiscal_comprobable']);
  });

  /** ⭐ La prueba negativa: el término que se pidió sacar no puede volver por la ventana. */
  it('ninguna etiqueta visible dice «fiscal»', () => {
    for (const c of claves) {
      expect(CLASIFICACION_LABEL[c].toLowerCase()).not.toContain('fiscal');
    }
  });

  it('ninguna etiqueta es la clave cruda —eso es lo que se veía en el chip', () => {
    for (const c of claves) {
      expect(CLASIFICACION_LABEL[c]).not.toBe(c);
      expect(CLASIFICACION_LABEL[c]).not.toContain('_');
    }
  });

  it('dice en palabras qué documento respalda el gasto', () => {
    expect(CLASIFICACION_LABEL.fiscal).toBe('Con factura');
    expect(CLASIFICACION_LABEL.no_fiscal_comprobable).toBe('Sólo ticket o recibo');
    // `[GX.31]` «Vale autorizado» desde GX.18: ese tipo SÍ lleva foto (la del vale que
    // se firma al gastar). Decirle «Sin comprobante» a quien firma era falso, y además
    // no coincidía con lo que había elegido quien capturó.
    expect(CLASIFICACION_LABEL.no_comprobable).toBe('Vale autorizado');
  });
});
