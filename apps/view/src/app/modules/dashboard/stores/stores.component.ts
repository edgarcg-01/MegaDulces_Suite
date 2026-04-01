import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';

@Component({ selector: 'app-stores', standalone: true, imports: [CommonModule, TableModule, ButtonModule, TagModule], templateUrl: './stores.component.html', styleUrls: ['./stores.component.css'] })
export class StoresComponent { stores: any[] = []; }
