import { Component, ChangeDetectionStrategy } from '@angular/core';

import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';

@Component({ selector: 'app-exhibitions', standalone: true, imports: [TableModule, ButtonModule, TagModule, TooltipModule], templateUrl: './exhibitions.component.html', changeDetection: ChangeDetectionStrategy.Eager,
 styleUrls: ['./exhibitions.component.css'] })
export class ExhibitionsComponent { exhibitions: any[] = []; }
