import { coincidenciaDeCodigo, type PresaleReviewCode } from './presale-review.contract';

/**
 * `[MCP.10.3]` Qué cuenta como «el mismo producto» al buscar en la revisión en caja. La usan la pantalla y
 * el servidor: si aquí cambia, cambia en los dos lados.
 */
const CODES: PresaleReviewCode[] = [
  { code: '006001', factor: 1 },   // pieza
  { code: '06001', factor: 20 },   // paquete
  { code: 'C06001', factor: 400 }, // caja
];

describe('coincidenciaDeCodigo', () => {
  it('el código exacto gana y trae su unidad', () => {
    expect(coincidenciaDeCodigo(' 06001 ', CODES, '06001')).toEqual({ match: 'codigo', factor: 20 });
    expect(coincidenciaDeCodigo('c06001', CODES, null)).toEqual({ match: 'codigo', factor: 400 });
  });

  it('el SKU exacto señala el producto sin decir unidad', () => {
    expect(coincidenciaDeCodigo('44340', [], '44340')).toEqual({ match: 'sku', factor: null });
  });

  it('con ceros de más o de menos lo encuentra, pero NUNCA dice qué unidad es', () => {
    expect(coincidenciaDeCodigo('6001', CODES, null)).toEqual({ match: 'codigo_sin_ceros', factor: null });
    expect(coincidenciaDeCodigo('0044340', [], '44340')).toEqual({ match: 'sku', factor: null });
  });

  it('NEGATIVO: lo que no es código ni SKU no coincide (el nombre se busca aparte)', () => {
    expect(coincidenciaDeCodigo('mazapan', CODES, '06001')).toBeNull();
    expect(coincidenciaDeCodigo('   ', CODES, '06001')).toBeNull();
    expect(coincidenciaDeCodigo('60011', CODES, '06001')).toBeNull();
  });
});
