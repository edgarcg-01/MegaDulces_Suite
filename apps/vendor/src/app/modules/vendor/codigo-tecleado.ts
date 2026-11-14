/**
 * `[BU.4.1]` Un código de barras TECLEADO, pegado o mandado por una pistola lectora (que «teclea» el
 * código y da Enter) busca el producto igual que la cámara (`[VTK.18]`).
 *
 * El catálogo del teléfono se filtra por nombre y SKU (la clave de Kepler), no por código de barras:
 * hasta hoy, escribir `7501079221165` en «Buscar producto o código» daba «sin resultados» aunque la
 * cámara sí lo encontraba. El rótulo prometía algo que sólo cumplía una de las dos entradas.
 *
 * Qué cuenta como código lo dice UNA regla, la misma que usa el buscador del servidor:
 * `pareceCodigoDeBarras` de `@megadulces/contracts/http/codigo-de-barras` (medida en prod).
 */
import { pareceCodigoDeBarras } from '@megadulces/contracts/http/codigo-de-barras';

export { pareceCodigoDeBarras };

/** Lo que se espera a que la persona deje de teclear antes de resolver (una pistola manda Enter antes). */
export const ESPERA_CODIGO_TECLEADO_MS = 450;

/**
 * Decide CUÁNDO un texto del buscador se resuelve como código: al confirmar (Enter) de inmediato, o
 * al dejar de teclear. Mientras se escribe un EAN dígito a dígito no se consulta en cada tecla.
 */
export class CodigoTecleado {
  private pendiente: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly resolver: (codigo: string) => void,
    private readonly esperaMs = ESPERA_CODIGO_TECLEADO_MS,
  ) {}

  /** Cada cambio del buscador. Lo que no parece código cancela lo pendiente. */
  alTeclear(texto: string): void {
    this.cancelar();
    const codigo = String(texto ?? '').trim();
    if (!pareceCodigoDeBarras(codigo)) return;
    this.pendiente = setTimeout(() => {
      this.pendiente = null;
      this.resolver(codigo);
    }, this.esperaMs);
  }

  /** Enter: si parece código se resuelve ya. `true` = lo tomó. */
  alConfirmar(texto: string): boolean {
    const codigo = String(texto ?? '').trim();
    if (!pareceCodigoDeBarras(codigo)) return false;
    this.cancelar();
    this.resolver(codigo);
    return true;
  }

  cancelar(): void {
    if (this.pendiente) {
      clearTimeout(this.pendiente);
      this.pendiente = null;
    }
  }
}
