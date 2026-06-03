import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @ApiProperty({ description: 'Nombre de usuario', required: false })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/i, {
    message: 'username solo admite letras, números, ".", "_" y "-"',
  })
  username?: string;

  @ApiProperty({ description: 'Nueva contraseña', required: false })
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password?: string;

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

  @ApiProperty({ description: 'Rol del sistema', required: false })
  @IsOptional()
  @IsString()
  role_name?: string;

  @ApiProperty({ description: 'Estado activo o inactivo', required: false })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiProperty({ description: 'ID del supervisor (UUID)', required: false })
  @IsOptional()
  @IsUUID()
  supervisor_id?: string;
}
