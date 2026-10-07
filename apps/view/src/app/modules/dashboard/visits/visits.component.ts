import { Component, ChangeDetectionStrategy } from '@angular/core';

import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';

@Component({ selector: 'app-visits', standalone: true, imports: [TableModule, ButtonModule, TagModule], templateUrl: './visits.component.html', changeDetection: ChangeDetectionStrategy.Eager,
 styleUrls: ['./visits.component.css'] })
export class VisitsComponent { visits: any[] = []; }
