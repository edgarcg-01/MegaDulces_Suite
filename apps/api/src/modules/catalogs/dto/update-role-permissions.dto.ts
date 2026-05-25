import { ApiProperty } from '@nestjs/swagger';

/**
 * Mapa de permisos `{ [PERMISSION_KEY]: boolean }`. La whitelist contra el
 * enum `Permission` se aplica en el service para evitar guardar claves
 * arbitrarias en el JSONB. El DTO documenta la forma esperada.
 */
export class UpdateRolePermissionsDto {
  @ApiProperty({
    description:
      'Mapa { CLAVE_PERMISO: boolean }. Las claves desconocidas se descartan.',
    type: 'object',
    additionalProperties: { type: 'boolean' },
  })
  [permission: string]: boolean | undefined;
}
