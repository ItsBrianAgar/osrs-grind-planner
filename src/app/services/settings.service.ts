import { Injectable, signal } from '@angular/core';

const PREREQS_ENABLED_KEY = 'osrs-prereqs-enabled';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  /** When disabled, connections stop gating: no lock badge, no dimming, no dashed-until-done
   *  edges, and "Mark Complete" is never blocked. The connections themselves aren't touched —
   *  turning this back on just resumes reading them as prereqs. */
  readonly prereqsEnabled = signal<boolean>(
    localStorage.getItem(PREREQS_ENABLED_KEY) !== 'false'
  );

  setPrereqsEnabled(enabled: boolean): void {
    this.prereqsEnabled.set(enabled);
    localStorage.setItem(PREREQS_ENABLED_KEY, String(enabled));
  }
}
