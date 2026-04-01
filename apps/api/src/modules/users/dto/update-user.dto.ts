import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({ description: 'Nueva contraseña', required: false })
  password?: string;

  @ApiProperty({ description: 'Nombre completo', required: false })
  nombre?: string;

  @ApiProperty({ description: 'Zona asignada (ej. Norte)', required: false })
  zona?: string;

  @ApiProperty({ description: 'Rol del sistema', required: false })
  role_name?: string;

  @ApiProperty({ description: 'Estado activo o inactivo', required: false })
  activo?: boolean;
}
