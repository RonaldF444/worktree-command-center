/** The structural contract the terminal grid relies on for any tile it places in the stage —
 *  satisfied by both TerminalTile (a Claude session) and JournalTile (a notes editor). */
export interface StageTile {
  readonly tileId: number;
  readonly name: string;
  readonly branch: string;
  readonly repoName: string;
  readonly isJournal: boolean;
  readonly isSelected: boolean;
  render(parent: HTMLElement): void;
  setRect(r: { x: number; y: number; w: number; h: number }): void;
  setCentered(on: boolean): void;
  setHidden(on: boolean): void;
  setLocked(on: boolean): void;
  setDimmed(on: boolean): void;
  setSelected(on: boolean): void;
  setBadge(text: string | null): void;
  focus(): void;
  blur(): void;
  kill(): void;
  recentOutput(): string;
}
