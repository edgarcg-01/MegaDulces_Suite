import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ description: 'Nombre de usuario único (3-64 caracteres)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/i, {
    message: 'username solo admite letras, números, ".", "_" y "-"',
  })
  username!: string;

  @ApiProperty({ description: 'Contraseña en texto plano (mínimo 6 caracteres)' })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ description: 'Nombre completo', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nombre?: string;

  @ApiProperty({ description: 'Nombre de zona — se resuelve a zona_id', required: false })
  @IsOptional()
  @IsString()
  zona?: string;

  @ApiProperty({ description: 'ID de zona (UUID)', required: false })
  @IsOptional()
  @IsUUID()
  zona_id?: string;

  @ApiProperty({ description: 'Rol del sistema (superadmin, supervisor_v, colaborador, ...)' })
  @IsString()
  @IsNotEmpty()
  role_name!: string;

  @ApiProperty({ description: 'ID del supervisor (UUID)', required: false })
  @IsOptional()
  @IsUUID()
  supervisor_id?: string;
}
