import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ description: 'Nombre de usuario único' })
  username!: string;

  @ApiProperty({ description: 'Contraseña en texto plano' })
  password!: string;

  @ApiProperty({ description: 'Nombre completo' })
  nombre?: string;

  @ApiProperty({ description: 'Zona asignada (ej. Norte)' })
  zona?: string;

  @ApiProperty({ description: 'Rol del sistema (superadmin, supervisor_v, colaborador)' })
  role_name!: string;

  @ApiProperty({ description: 'ID del supervisor (opcional)', required: false })
  supervisor_id?: string;
}
