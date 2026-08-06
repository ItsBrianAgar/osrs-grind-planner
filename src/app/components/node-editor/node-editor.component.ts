import { Component, Input, Output, EventEmitter, OnInit, ViewChild, ElementRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgFor, NgIf } from '@angular/common';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { AvatarModule } from 'primeng/avatar';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TooltipModule } from 'primeng/tooltip';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { CanvasService } from '../../services/canvas.service';
import { SettingsService } from '../../services/settings.service';
import { ItemSearchService, ItemMappingEntry } from '../../services/item-search.service';
import { GrindNode, NodeCategory, CATEGORY_COLORS, CATEGORY_LABELS } from '../../models/grind-node.model';

@Component({
  selector: 'app-node-editor',
  standalone: true,
  imports: [
    FormsModule, NgFor, NgIf,
    DialogModule, ButtonModule, InputTextModule, TextareaModule,
    AvatarModule, SelectButtonModule, TooltipModule, AutoCompleteModule,
  ],
  templateUrl: './node-editor.component.html',
  styleUrl: './node-editor.component.scss',
})
export class NodeEditorComponent implements OnInit {
  @Input({ required: true }) nodeId!: string;
  @Output() close = new EventEmitter<void>();

  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  private readonly canvas = inject(CanvasService);
  private readonly itemSearch = inject(ItemSearchService);
  readonly settings = inject(SettingsService);

  visible = true;
  draft: Partial<GrindNode> = {};
  itemSuggestions: ItemMappingEntry[] = [];
  searchingItems = false;

  readonly categories: { label: string; value: NodeCategory; color: string }[] = (
    Object.keys(CATEGORY_LABELS) as NodeCategory[]
  ).map(k => ({ label: CATEGORY_LABELS[k], value: k, color: CATEGORY_COLORS[k] }));

  ngOnInit(): void {
    const node = this.canvas.getNode(this.nodeId);
    if (node) this.draft = { ...node };
  }

  get isItemCategory(): boolean {
    return !this.settings.categoriesEnabled() || this.draft.category === 'item';
  }

  async searchItemSuggestions(event: AutoCompleteCompleteEvent): Promise<void> {
    this.searchingItems = true;
    try {
      this.itemSuggestions = await this.itemSearch.search(event.query);
    } catch {
      this.itemSuggestions = [];
    } finally {
      this.searchingItems = false;
    }
  }

  onItemTitleChange(value: string | ItemMappingEntry): void {
    if (typeof value === 'string') {
      this.draft = { ...this.draft, title: value };
      return;
    }
    if (value) this.selectItem(value);
  }

  onItemSelect(event: AutoCompleteSelectEvent): void {
    this.selectItem(event.value as ItemMappingEntry);
  }

  itemSpriteUrl(itemId: number): string {
    return this.itemSearch.spriteUrl(itemId);
  }

  private selectItem(item: ItemMappingEntry): void {
    this.draft = { ...this.draft, title: item.name, avatarUrl: this.itemSearch.spriteUrl(item.id) };
  }

  get avatarLabel(): string {
    return (this.draft.title?.charAt(0) ?? '?').toUpperCase();
  }

  get categoryColor(): string {
    if (!this.settings.categoriesEnabled()) return CATEGORY_COLORS['item'];
    return CATEGORY_COLORS[this.draft.category ?? 'general'];
  }

  pickAvatar(): void {
    this.fileInput.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => { this.draft = { ...this.draft, avatarUrl: e.target?.result as string }; };
    reader.readAsDataURL(file);
  }

  clearAvatar(): void {
    this.draft = { ...this.draft, avatarUrl: undefined };
  }

  setCategory(cat: NodeCategory): void {
    this.draft = { ...this.draft, category: cat };
  }

  save(): void {
    this.canvas.snapshot();
    this.canvas.updateNode(this.nodeId, this.draft);
    this.close.emit();
  }

  cancel(): void {
    this.close.emit();
  }

  onHide(): void {
    this.close.emit();
  }
}
