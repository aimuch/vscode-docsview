// Explicit finite state machine for the Image Inspector workspace (`ISM-2` / `UI-2`).
// Guarantees at most one secondary action bar ('crop' | 'markup' | 'resize' | 'diff') is open at a time.
import { StateMachine } from '../../common/stateMachine';

export type ImageToolSegment = 'inspect' | 'bbox' | 'markup' | 'crop';
export type ImageWorkspaceMode = ImageToolSegment | 'resize' | 'diff';

export class ImageWorkspaceMachine {
  private readonly machine: StateMachine<ImageWorkspaceMode>;

  constructor(initial: ImageToolSegment = 'inspect') {
    this.machine = new StateMachine<ImageWorkspaceMode>(initial);
  }

  get mode(): ImageWorkspaceMode {
    return this.machine.state;
  }

  /** Value shown on the 4-way toolbar segmented switch ('inspect' | 'bbox' | 'markup' | 'crop'). */
  get toolSegment(): ImageToolSegment {
    const m = this.machine.state;
    return m === 'resize' || m === 'diff' ? 'inspect' : m;
  }

  setMode(next: ImageWorkspaceMode): ImageWorkspaceMode {
    this.machine.transition(next);
    return this.machine.state;
  }

  toggleResize(): ImageWorkspaceMode {
    return this.setMode(this.machine.state === 'resize' ? 'inspect' : 'resize');
  }

  exitSubMode(): ImageWorkspaceMode {
    if (this.machine.state === 'inspect' || this.machine.state === 'bbox') {
      return this.machine.state;
    }
    return this.setMode('inspect');
  }

  onChange(listener: (next: ImageWorkspaceMode, prev: ImageWorkspaceMode) => void): () => void {
    return this.machine.subscribe(listener);
  }
}
