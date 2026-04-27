import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    description: 'Nombre de usuario',
    example: 'superadmin',
  })
  username!: string;

  @ApiProperty({
    description: 'Contraseña del usuario',
    example: 'password123',
  })
  password!: string;
}
