import { Injectable, signal } from '@angular/core';

const PREREQS_ENABLED_KEY = 'osrs-prereqs-enabled';
const SPLICE_ON_DROP_KEY = 'osrs-splice-on-drop';

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

  /** When enabled, holding a dragged node/group on a connection and then dropping inserts it
   *  between that connection's ends (A → B becomes A → dragged → B). */
  readonly spliceOnDropEnabled = signal<boolean>(
    localStorage.getItem(SPLICE_ON_DROP_KEY) !== 'false'
  );

  setSpliceOnDropEnabled(enabled: boolean): void {
    this.spliceOnDropEnabled.set(enabled);
    localStorage.setItem(SPLICE_ON_DROP_KEY, String(enabled));
  }
}
