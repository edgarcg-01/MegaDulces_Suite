import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * `[AU.0]` — Los DTO de la organización.
 *
 * Se escriben como CLASES desde el día uno, y no como el tipo inline que usan
 * hoy los cuatro endpoints de escritura más sensibles del padrón
 * (`PUT :id/scope/:dimension`, `PATCH bulk`, `PUT :id/roles`,
 * `PUT :id/permissions`). Ahí el `ValidationPipe({ whitelist: true })` del
 * controller **no valida ni recorta nada**: con un tipo inline el metatype
 * resuelve a `Object` y el pipe se saltea, así que toda la defensa cae en el
 * service. Funciona, pero es una garantía que depende de que nadie se olvide.
 */

/** Los ejes que admite el CHECK `positions_scope_axis_check`. */
export const EJES_DE_ALCANCE = ['ruta', 'zona', 'sucursal', 'red', 'cartera', 'cliente'] as const;

/** Lo que admite el CHECK `user_responsibilities_accion_valida`. */
export const ACCIONES_RESPONSABILIDAD = ['suma', 'resta'] as const;

export class PositionWriteDto {
  /**
   * El código es la identidad del puesto y **no se renombra**: lo referencian
   * `users.position_code`, `positions.reports_to_position_code` y
   * `position_responsibilities.position_code`. Para cambiarlo se crea otro y se
   * mueve la gente, que es una decisión visible.
   */
  @ValidateIf((o) => o.code !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'Falta el código del puesto.' })
  @MaxLength(50)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'El código va en minúsculas, sin espacios ni acentos (letras, números y guion bajo).',
  })
  code?: string;

  @ValidateIf((o) => o.name !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'Falta el nombre del puesto.' })
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  department_code?: string | null;

  /**
   * El rol que el puesto PROPONE. ⛔ No otorga: `identity.role_permissions` +
   * `user_roles` son los que conceden. El puesto sólo dice qué debería llevar.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  default_role?: string | null;

  /**
   * `[OR.7.0b]` Complementos del perfil. Un puesto cuyo perfil real es
   * «administrativo + analisis_ventas» no se podía expresar con `default_role`
   * solo, que es singular.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  default_complements?: string[];

  @IsOptional()
  @IsIn(EJES_DE_ALCANCE as unknown as string[])
  scope_axis?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  orden?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  org_labels?: string[];
}

export class ReportsToDto {
  /**
   * `null` desprende el puesto de la cadena (queda raíz). No es lo mismo que no
   * mandar el campo, así que va explícito.
   */
  @ValidateIf((o) => o.reports_to_position_code !== null)
  @IsString()
  @MaxLength(50)
  reports_to_position_code!: string | null;
}

export class PositionResponsibilityDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta la responsabilidad.' })
  @MaxLength(64)
  responsibility_key!: string;

  /**
   * Un solo PRINCIPAL por responsabilidad: con dos, «¿quién responde?» tiene dos
   * respuestas y el reparto no sabe a cuál apuntar.
   */
  @IsOptional()
  @IsBoolean()
  es_principal?: boolean;
}

export class UserResponsibilityDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta la responsabilidad.' })
  @MaxLength(64)
  responsibility_key!: string;

  @IsOptional()
  @IsIn(ACCIONES_RESPONSABILIDAD as unknown as string[])
  accion?: string;

  /**
   * **Obligatoria, y el CHECK de la base la exige no-vacía.**
   *
   * `identity.user_roles` ya mostró en qué termina un override sin regla: 133 de
   * 139 filas son un espejo del rol que ya está en `users.role_name`, y nadie
   * sabe cuáles de las 6 restantes son intencionales. La nota es lo único que
   * distingue una decisión de un descuido seis meses después.
   */
  @IsString()
  @IsNotEmpty({
    message:
      'Falta el motivo. Asignarle algo a una persona y no a su puesto necesita decir por qué.',
  })
  @MaxLength(500)
  nota!: string;

  @IsOptional()
  @IsDateString({}, { message: 'La vigencia desde tiene que ser una fecha (YYYY-MM-DD).' })
  valid_from?: string;

  @IsOptional()
  @ValidateIf((o) => o.valid_to !== null)
  @IsDateString({}, { message: 'La vigencia hasta tiene que ser una fecha (YYYY-MM-DD).' })
  valid_to?: string | null;
}
