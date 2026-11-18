import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { NgSwitch, NgSwitchCase } from '@angular/common';
import { SmartLayoutFeature } from '../../services/settings.service';

/** A small looping illustration of one smart-layout feature, for its switch in settings. */
@Component({
  selector: 'app-smart-layout-preview',
  standalone: true,
  imports: [NgSwitch, NgSwitchCase],
  templateUrl: './smart-layout-preview.component.html',
  // Split so each file stays within the per-stylesheet size budget.
  styleUrls: ['./smart-layout-preview.component.scss', './smart-layout-preview.resize.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SmartLayoutPreviewComponent {
  @Input({ required: true }) feature!: SmartLayoutFeature;
}
