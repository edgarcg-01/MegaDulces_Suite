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

const DEPARTMENT_REQUIRED = 'Hay que asignar un departamento existente.';

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

  /**
   * OBLIGATORIO al crear: un usuario nuevo tiene que nacer en un departamento
   * que exista. Sin esto las cuentas caían en el cajón "Sin departamento" del
   * admin y el padrón volvía a desordenarse solo. La existencia del code la
   * valida `UsersService.assertOrgCodes` contra `identity.departments` del
   * tenant (400 si no existe, no 500 por la FK).
   */
  @ApiProperty({ description: 'Departamento del organigrama (identity.departments.code). Obligatorio.' })
  // Mismo mensaje en los 3 decoradores: `ValidationPipe` devuelve un ARRAY con
  // todos los que fallan, y si cada uno dice algo distinto el toast del admin
  // muestra el menos útil ("department_code must be a string").
  @IsString({ message: DEPARTMENT_REQUIRED })
  @IsNotEmpty({ message: DEPARTMENT_REQUIRED })
  @MaxLength(50, { message: DEPARTMENT_REQUIRED })
  department_code!: string;

  @ApiProperty({ description: 'Puesto del organigrama (identity.positions.code)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  position_code?: string | null;

  @ApiProperty({ description: "Sucursal Kepler ('00'..'05'). Vacío = ve todas (rol global).", required: false })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}$/, { message: "warehouse_code debe ser 2 dígitos ('00'..'05')" })
  warehouse_code?: string;
}
