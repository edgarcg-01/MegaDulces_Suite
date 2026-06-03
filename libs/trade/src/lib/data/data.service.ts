import { Injectable } from '@nestjs/common';

@Injectable()
export class DataService {
  /**
   * Obtiene la versión actual y la fecha de última modificación del sistema.
   * Por ahora retorna el timestamp actual simplificado.
   */
  async getVersion() {
    return {
      version: '1.0.0',
      lastModified: new Date().toISOString(),
    };
  }
}
