import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * `[AU.34]` `POST /users/:id/rename`. El formato del username es el mismo del alta
 * (`UserWriteDto`): si una regla cambia allá y no acá, se podría renombrar a un nombre
 * con el que no se puede dar de alta a nadie. `test-newdb-users-rename.js` compara las dos.
 */
export class RenameUserDto {
  @ApiProperty({ description: 'Nuevo nombre de usuario (3-64 caracteres; letras, números, ".", "_" y "-")' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/i, {
    message: 'username solo admite letras, números, ".", "_" y "-"',
  })
  username!: string;

  @ApiProperty({ description: 'Por qué se cambia. Queda en la bitácora de la cuenta.' })
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  motivo!: string;
}
