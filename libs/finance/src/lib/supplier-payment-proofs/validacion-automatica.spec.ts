import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[PC.6]` — **El comprobante se valida solo SÓLO con las cinco condiciones.** La regla de las
 * cuatro coincidencias se prueba en `libs/contracts` (`coincidencia-pago.spec.ts`); aquí se prueba
 * que el servicio la cablea con TODAS sus guardas. Cada guarda que falte es un comprobante validado
 * sin que nadie lo vea.
 */
const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.service.ts'), 'utf8'));
const decide = SERVICIO.slice(SERVICIO.indexOf('private async decidirAutomatico('), SERVICIO.indexOf('private async pagoParaCoincidir('));
const attach = SERVICIO.slice(SERVICIO.indexOf('async attach('), SERVICIO.indexOf('private async decidirAutomatico('));
// ⚠️ `[AT.1]` El corte termina en `relectura(`, no en `detail(`. Al insertar `relectura()` entre
// medio, este recorte pasó a abarcarla — y como la asercion de abajo es un `toContain`, el bloque
// seguia VERDE mientras el metodo nuevo pone `verificada: true` sin mirar la columna. Es la
// debilidad de un candado por texto: crece con el archivo y deja de decir lo que su nombre dice.
const recheck = SERVICIO.slice(SERVICIO.indexOf('async recheck('), SERVICIO.indexOf('async relectura('));
const relectura = SERVICIO.slice(SERVICIO.indexOf('async relectura('), SERVICIO.indexOf('async detail('));

describe('[PC.6] decidirAutomatico tiene las cinco guardas', () => {
  it('1 · las cuatro coincidencias, con la regla de libs/contracts', () => {
    expect(decide).toContain('coincidenciasPago(a.lectura, pagoK');
    expect(decide).toContain('if (faltan.length) return { coincidencias: k, validar: false');
    expect(decide).toContain('validar: coincidenTodas(k)');
  });
  it('⛔ sin el pago en Kepler, no', () => {
    expect(decide).toContain("if (!pagoK) return { coincidencias: k, validar: false");
  });
  it('2 · ⛔ lectura no verificada (vino del request), no', () => {
    expect(decide).toContain("if (!a.verificada) return { coincidencias: k, validar: false");
  });
  it('3 · ⛔ OCR que no terminó ok, no', () => {
    expect(decide).toContain("if (a.ocrStatus !== 'ok') return { coincidencias: k, validar: false");
  });
  it('4 · ⛔ clave de rastreo en otro pago, no', () => {
    expect(decide).toContain("if (a.refDuplicada) return { coincidencias: k, validar: false");
  });
  it('5 · ⛔ el pago ya tiene otro comprobante validado, no', () => {
    expect(decide).toContain("status: 'validado' })");
    expect(decide).toContain("if (yaValidado) return { coincidencias: k, validar: false");
  });
});

describe('[PC.6] attach y recheck sólo validan con la decisión', () => {
  it('attach: la lectura verificada es la que recuperó el servidor, no la del request', () => {
    expect(attach).toContain('verificada: !!verificada');
    expect(attach).toContain('lectura_verificada: !!verificada');
  });
  it("attach: status 'validado' únicamente si auto.validar, firmado por el sistema", () => {
    expect(attach).toContain("...(auto.validar ? { status: 'validado', validated_by: VALIDADOR_AUTOMATICO");
  });
  it('recheck: sólo toca comprobantes recibidos y exige lectura_verificada === true', () => {
    expect(recheck).toContain(".where('status', 'recibido')");
    expect(recheck).toContain('verificada: p.lectura_verificada === true');
    expect(recheck).toContain(".where({ id: p.id, status: 'recibido' })");
    // ⛔ El recorte NO debe arrastrar el metodo siguiente: si lo hiciera, la linea de arriba
    // se satisface con el `verificada: true` de `relectura` y este bloque deja de probar nada.
    expect(recheck).not.toContain('verificada: true');
  });
});

/**
 * `[AT.1]` **La relectura es la única que puede poner `verificada: true`, y sólo porque la lectura
 * la produjo el servidor bajando el archivo del bucket.** Si alguien la cablea a partir de algo
 * que vino en el request, la guarda 2 de `[PC.6]` queda anulada para toda la cola.
 */
describe('[AT.1] relectura: la lectura la produce el servidor, no el request', () => {
  it('⛔ el contenido sale del bucket, por la llave guardada', () => {
    expect(relectura).toContain('hojaRelegible(p.files)');
    expect(relectura).toContain('this.storage.getDataUri(String(hoja.public_id))');
    expect(relectura).toContain('this.ocr.extractSupplierPayment(base64De(dataUri), tipo)');
  });

  it('⛔⛔ una lectura vacía no se persiste (si no, una caída del lector borra evidencia)', () => {
    expect(relectura).toContain('if (!lecturaSirve(fresca))');
  });

  it('⛔ sin lector, la pasada NO arranca: no cuenta 25 ilegibles', () => {
    expect(relectura).toContain('if (!process.env.ANTHROPIC_API_KEY)');
  });

  it('la decisión la sigue tomando decidirAutomatico, con el id excluido', () => {
    expect(relectura).toContain('this.decidirAutomatico(trx');
    expect(relectura).toContain('excluirProofId: p.id');
    expect(relectura).toContain('auto.validar ?');
  });

  it('⛔ no pisa a una persona que decidió mientras tanto', () => {
    expect(relectura).toContain(".where({ id: p.id, status: 'recibido' })");
    expect(relectura).toContain('if (!escrito.filas) continue;');
  });

  it('la lectura anterior se conserva en la fila', () => {
    expect(relectura).toContain('anterior:');
    expect(relectura).toContain('relectura:');
  });

  /**
   * ⛔⛔ `ref_norm` es `GENERATED ALWAYS AS` sobre `ocr_referencia` (verificado en prod).
   * Escribirla hace que Postgres rechace **el UPDATE entero**: «column "ref_norm" can only be
   * updated to DEFAULT». Costó una pasada completa de 90,910 ms —los 25 comprobantes bajados y
   * leídos con el modelo, pagados— con cada fila fallando al guardar.
   *
   * ⚠️ Es una prueba por TEXTO y sé lo que vale: no ejecuta SQL, así que no descubriría una
   * columna generada NUEVA. Lo que hace es impedir que ésta vuelva — un doble de Knex tampoco la
   * habría atrapado, porque un doble no ejecuta SQL. Lo que la atrapó de verdad fue que el latido
   * mida ENTREGA: con un `ok` por «la pasada terminó», esto se repetía cada 20 min en silencio.
   */
  it('⛔⛔ no escribe columnas GENERATED (ref_norm se deriva de ocr_referencia)', () => {
    expect(relectura).not.toMatch(/ref_norm:\s/);
    // …y sí escribe la columna de la que ref_norm se deriva, o no se actualizaría nunca.
    expect(relectura).toContain('ocr_referencia:');
  });
});
