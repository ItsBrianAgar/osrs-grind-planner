import { ChangeDetectorRef, Component, Input, Output, EventEmitter, OnInit, ViewChild, ElementRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIf } from '@angular/common';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { AvatarModule } from 'primeng/avatar';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TooltipModule } from 'primeng/tooltip';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { CanvasService } from '../../services/canvas.service';
import { ItemSearchService, ItemMappingEntry } from '../../services/item-search.service';
import { GrindNode } from '../../models/grind-node.model';

/** Uploaded avatars are stored inline in localStorage (as data URLs), so a full-size photo could eat
 *  most of the ~5MB quota on its own. Avatars only ever render at ≤64px, so 128px (2× for
 *  high-DPI screens) loses nothing visible and keeps each one to a few tens of KB. */
const AVATAR_MAX_PX = 128;

/** Decodes an image file and re-encodes it as a PNG data URL no larger than `maxPx` on its longest side. */
async function downscaleImage(file: File, maxPx: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

@Component({
  selector: 'app-node-editor',
  standalone: true,
  imports: [
    FormsModule, NgIf,
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
  // The app is zoneless: fields written after an await / in a FileReader callback don't re-render
  // on their own, so those paths mark the view dirty explicitly.
  private readonly cdr = inject(ChangeDetectorRef);

  visible = true;
  draft: Partial<GrindNode> = {};
  itemSuggestions: ItemMappingEntry[] = [];
  searchingItems = false;

  ngOnInit(): void {
    const node = this.canvas.getNode(this.nodeId);
    if (node) this.draft = { ...node };
  }

  async searchItemSuggestions(event: AutoCompleteCompleteEvent): Promise<void> {
    this.searchingItems = true;
    try {
      this.itemSuggestions = await this.itemSearch.search(event.query);
    } catch {
      this.itemSuggestions = [];
    } finally {
      this.searchingItems = false;
      this.cdr.markForCheck();
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

  pickAvatar(): void {
    this.fileInput.nativeElement.click();
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.draft = { ...this.draft, avatarUrl: await downscaleImage(file, AVATAR_MAX_PX) };
    } catch {
      // Not a decodable image — leave the avatar as it was.
    }
    this.cdr.markForCheck();
  }

  clearAvatar(): void {
    this.draft = { ...this.draft, avatarUrl: undefined };
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
