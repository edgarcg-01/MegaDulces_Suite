import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListFindingsDto {
  @IsOptional()
  @IsString()
  @IsIn(['open', 'reviewed', 'dismissed', 'confirmed', 'resolved'])
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['info', 'warn', 'critical'])
  severity?: string;

  @IsOptional()
  @IsString()
  @IsIn(['collaborator', 'route', 'store'])
  subject_type?: string;
}

export class ReviewFindingDto {
  @IsString()
  @IsIn(['dismissed', 'confirmed', 'reviewed'])
  status!: string;
}
