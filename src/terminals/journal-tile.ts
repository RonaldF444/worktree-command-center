import { JournalStore } from './journal-store';
import { Autosave } from './autosave';
import { promptForConfirm } from '../ui/prompt-dialog';
import type { StageTile } from './stage-tile';
import { openExternalUrl } from './links';
import type { ProposedIssue, CreatedIssue } from './linear-convert-probe';

export interface JournalTileOpts {
  tileId: number;
  name: string;
  store: JournalStore;
  slug?: string;
  initialText?: string;
  onClosed: (tile: JournalTile) => void;
  onHide: (tile: JournalTile) => void;
  onLock: (tile: JournalTile) => void;
  onCenter: (tile: JournalTile) => void;
  onRequestRename: (tile: JournalTile, current: string) => void;
  onRename: () => void;
  toast: (msg: string) => void;
  onFormat: (text: string) => Promise<string>;
  onConvertPropose: (text: string) => Promise<ProposedIssue[]>;
  onConvertCreate: (issues: ProposedIssue[]) => Promise<CreatedIssue[]>;
}

/** A stage tile holding free-form notes (a textarea), not a Claude session. Saves to the
 *  JournalStore, browses saved notes via History, and carries terminal-like chrome so the grid
 *  treats it as any StageTile. */
export class JournalTile implements StageTile {
  readonly isJournal = true;
  readonly branch = '';
  readonly repoName = 'journal';
  readonly isSelected = false;
  private el: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private nameEl: HTMLElement | null = null;
  private lockBtnEl: HTMLElement | null = null;
  private displayName: string;
  private slug: string | undefined;
  private dirty = false;
  private showingHistory = false;
  private currentText = '';
  private autosave = new Autosave(() => this.persist(false));
  private fmtBtn: HTMLButtonElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private historyBtn: HTMLButtonElement | null = null;
  private convertBtn: HTMLButtonElement | null = null;

  constructor(private opts: JournalTileOpts) {
    this.displayName = opts.name;
    this.slug = opts.slug;
    this.currentText = opts.initialText ?? '';
  }

  get tileId(): number { return this.opts.tileId; }
  get name(): string { return this.displayName; }
  get journalSlug(): string | undefined { return this.slug; }

  render(parent: HTMLElement): void {
    this.el = parent.createDiv({ cls: 'cos-term-tile cos-journal-tile' });
    this.el.addEventListener('click', () => this.opts.onCenter(this));
    const head = this.el.createDiv({ cls: 'cos-term-head' });
    this.nameEl = head.createSpan({ cls: 'cos-term-name', text: this.displayName, attr: { title: 'Double-click to rename' } });
    this.nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.opts.onRequestRename(this, this.displayName); });
    const btns = head.createDiv({ cls: 'cos-term-head-btns' });
    this.lockBtnEl = btns.createEl('button', { text: '🔒', cls: 'cos-term-lock', attr: { title: 'Lock to center (Alt+L)' } });
    this.lockBtnEl.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onLock(this); });
    const hide = btns.createEl('button', { text: '–', cls: 'cos-term-hide', attr: { title: 'Hide — resurface from Coordination' } });
    hide.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onHide(this); });
    const close = btns.createEl('button', { text: '×', attr: { title: 'Close this journal' } });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.requestClose(); });

    this.bodyEl = this.el.createDiv({ cls: 'cos-journal-body' });
    this.renderEditor();

    const actions = this.el.createDiv({ cls: 'cos-journal-actions' });
    this.saveBtn = actions.createEl('button', { text: 'Save', cls: 'cos-journal-save' }) as HTMLButtonElement;
    this.saveBtn.addEventListener('click', (e) => { e.stopPropagation(); this.save(); });
    this.historyBtn = actions.createEl('button', { text: 'See History', cls: 'cos-journal-history' }) as HTMLButtonElement;
    this.historyBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleHistory(); });
    this.fmtBtn = actions.createEl('button', { text: 'Format', cls: 'cos-journal-fmt', attr: { title: 'Reformat with Claude — fixes indentation, keeps your words' } }) as HTMLButtonElement;
    this.fmtBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.format(); });
    this.convertBtn = actions.createEl('button', { text: 'Convert to Linear', cls: 'cos-journal-convert-btn', attr: { title: 'Propose Linear issues from this note' } }) as HTMLButtonElement;
    this.convertBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.convertToLinear(); });
  }

  private renderEditor(): void {
    if (!this.bodyEl) return;
    this.showingHistory = false;
    this.bodyEl.empty();
    const ta = this.bodyEl.createEl('textarea', { cls: 'cos-journal-text' }) as HTMLTextAreaElement;
    ta.value = this.currentText;
    ta.spellcheck = false;
    ta.addEventListener('input', () => { this.currentText = ta.value; this.dirty = true; this.autosave.schedule(); });
    ta.addEventListener('click', (e) => e.stopPropagation());
    this.textarea = ta;
  }

  private renderHistory(): void {
    if (!this.bodyEl) return;
    this.showingHistory = true;
    if (this.textarea) this.currentText = this.textarea.value; // preserve the open edit
    this.bodyEl.empty();
    const list = this.bodyEl.createDiv({ cls: 'cos-journal-hist' });
    const items = this.opts.store.list();
    if (!items.length) list.createDiv({ cls: 'cos-journal-hist-empty', text: 'No saved notes yet' });
    for (const m of items) {
      const row = list.createDiv({ cls: 'cos-journal-hist-row' });
      row.createSpan({ cls: 'cos-journal-hist-name', text: m.name });
      row.createSpan({ cls: 'cos-journal-hist-time', text: new Date(m.created ?? m.updated).toLocaleString() });
      row.createEl('button', { text: 'open', cls: 'cos-reopen-btn' })
        .addEventListener('click', (e) => { e.stopPropagation(); this.openFromHistory(m.slug); });
      row.createEl('button', { text: '✕', cls: 'cos-close-btn', attr: { title: 'Delete this saved note' } })
        .addEventListener('click', async (e) => {
          e.stopPropagation();
          if (await promptForConfirm(`Delete "${m.name}"?`, 'This permanently deletes the saved note.', 'Delete')) {
            this.opts.store.remove(m.slug);
            this.renderHistory();
          }
        });
    }
    list.createEl('button', { text: '← Back', cls: 'cos-journal-back' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.renderEditor(); });
  }

  private toggleHistory(): void { this.showingHistory ? this.renderEditor() : this.renderHistory(); }

  private openFromHistory(slug: string): void {
    const doc = this.opts.store.load(slug);
    if (!doc) return;
    this.autosave.cancel(); // a save pending for the OLD document must not fire under the new slug
    this.slug = slug;
    this.displayName = doc.name;
    this.nameEl?.setText(doc.name);
    this.currentText = doc.text;
    this.dirty = false;
    this.opts.onRename();
    this.renderEditor();
  }

  save(): void { this.persist(true); }

  /** Write the current text to the store. Manual saves toast; autosaves are silent. The first
   *  write assigns the slug and onRename() re-persists the session list with it, so a crash
   *  after this point restores the tile WITH its text. */
  private persist(toast: boolean): void {
    this.autosave.cancel();
    if (this.textarea && !this.showingHistory) this.currentText = this.textarea.value;
    if (!toast && this.slug === undefined && this.currentText.trim() === '') return; // don't mint files for untouched tiles
    const slug = this.opts.store.uniqueSlug(this.displayName, this.slug);
    this.slug = slug;
    this.opts.store.save(slug, this.displayName, this.currentText, Date.now());
    this.dirty = false;
    this.opts.onRename();
    if (toast) this.opts.toast(`Saved "${this.displayName}"`);
  }

  private setFooterDisabled(on: boolean): void {
    for (const b of [this.saveBtn, this.historyBtn, this.fmtBtn, this.convertBtn]) if (b) b.disabled = on;
  }

  private async format(): Promise<void> {
    const before = this.textarea?.value ?? this.currentText;
    if (before.trim() === '') { this.opts.toast('Nothing to format'); return; }
    this.currentText = before;
    this.setFooterDisabled(true);
    if (this.bodyEl) { this.bodyEl.empty(); this.bodyEl.createDiv({ cls: 'cos-journal-formatting', text: 'Formatting…' }); }
    let after: string;
    try { after = await this.opts.onFormat(before); }
    catch { this.opts.toast('Format failed'); this.renderEditor(); this.setFooterDisabled(false); return; }
    this.renderFormatPreview(before, after);
  }

  private renderFormatPreview(before: string, after: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const wrap = this.bodyEl.createDiv({ cls: 'cos-journal-preview' });
    const pane = (title: string, text: string): void => {
      const col = wrap.createDiv({ cls: 'cos-journal-pane' });
      col.createDiv({ cls: 'cos-journal-pane-h', text: title });
      const ta = col.createEl('textarea', { cls: 'cos-journal-text' }) as HTMLTextAreaElement;
      ta.value = text; ta.readOnly = true;
    };
    pane('BEFORE', before);
    pane('AFTER', after);
    const bar = this.bodyEl.createDiv({ cls: 'cos-journal-preview-actions' });
    bar.createEl('button', { text: 'Apply', cls: 'cos-journal-save' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.currentText = after; this.dirty = true; this.autosave.schedule(); this.setFooterDisabled(false); this.renderEditor(); });
    bar.createEl('button', { text: 'Discard' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.setFooterDisabled(false); this.renderEditor(); });
  }

  private async convertToLinear(): Promise<void> {
    const text = this.textarea?.value ?? this.currentText;
    if (text.trim() === '') { this.opts.toast('Nothing to convert'); return; }
    this.currentText = text;
    this.setFooterDisabled(true);
    if (this.bodyEl) { this.bodyEl.empty(); this.bodyEl.createDiv({ cls: 'cos-journal-formatting', text: 'Analyzing note…' }); }
    let proposed: ProposedIssue[];
    try { proposed = await this.opts.onConvertPropose(text); }
    catch { this.opts.toast('Convert failed'); this.renderEditor(); this.setFooterDisabled(false); return; }
    if (!proposed.length) { this.opts.toast("Couldn't read a proposed split"); this.renderEditor(); this.setFooterDisabled(false); return; }
    this.renderConvertPreview(proposed);
  }

  private renderConvertPreview(proposed: ProposedIssue[]): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const checked = proposed.map(() => true);
    const list = this.bodyEl.createDiv({ cls: 'cos-journal-convert' });
    proposed.forEach((iss, i) => {
      const row = list.createDiv({ cls: 'cos-journal-convert-row' });
      const cb = row.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = true;
      const txt = row.createDiv({ cls: 'cos-journal-convert-txt' });
      txt.createDiv({ cls: 'cos-journal-convert-title', text: iss.title });
      txt.createDiv({ cls: 'cos-journal-convert-desc', text: iss.description });
      cb.addEventListener('change', () => { checked[i] = cb.checked; updateBtn(); });
    });
    const bar = this.bodyEl.createDiv({ cls: 'cos-journal-preview-actions' });
    const createBtn = bar.createEl('button', { cls: 'cos-journal-save' }) as HTMLButtonElement;
    const updateBtn = (): void => {
      const n = checked.filter(Boolean).length;
      createBtn.setText(`Create ${n} issue${n === 1 ? '' : 's'}`);
      createBtn.disabled = n === 0;
    };
    updateBtn();
    createBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.doCreate(proposed.filter((_, i) => checked[i])); });
    bar.createEl('button', { text: 'Discard' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.setFooterDisabled(false); this.renderEditor(); });
  }

  private async doCreate(issues: ProposedIssue[]): Promise<void> {
    if (this.bodyEl) { this.bodyEl.empty(); this.bodyEl.createDiv({ cls: 'cos-journal-formatting', text: 'Creating in Linear…' }); }
    let results: CreatedIssue[];
    try { results = await this.opts.onConvertCreate(issues); }
    catch { this.opts.toast('Create timed out — check Linear'); this.renderEditor(); this.setFooterDisabled(false); return; }
    this.renderConvertResult(results);
  }

  private renderConvertResult(results: CreatedIssue[]): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const list = this.bodyEl.createDiv({ cls: 'cos-journal-convert' });
    if (!results.length) list.createDiv({ cls: 'cos-journal-hist-empty', text: 'No issues created' });
    for (const r of results) {
      const row = list.createDiv({ cls: 'cos-journal-convert-row' });
      row.createSpan({ cls: 'cos-journal-convert-mark', text: r.ok ? '✓' : '✗' });
      if (r.ok && r.url) {
        const a = row.createEl('a', { cls: 'cos-journal-convert-link', text: r.title, attr: { href: r.url } });
        a.addEventListener('click', (e) => { e.preventDefault(); openExternalUrl(r.url!); });
      } else {
        row.createSpan({ cls: 'cos-journal-convert-title', text: r.title });
        if (r.error) row.createSpan({ cls: 'cos-journal-convert-desc', text: r.error });
      }
    }
    const bar = this.bodyEl.createDiv({ cls: 'cos-journal-preview-actions' });
    bar.createEl('button', { text: 'Done', cls: 'cos-journal-save' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.setFooterDisabled(false); this.renderEditor(); });
  }

  setName(name: string): void { this.displayName = name; this.nameEl?.setText(name); this.opts.onRename(); }

  /** Closing never discards anymore: autosave means the text is already (or now) on disk. */
  private requestClose(): void {
    if (this.dirty) this.persist(false);
    this.opts.onClosed(this);
  }

  // --- StageTile ---
  setRect(r: { x: number; y: number; w: number; h: number }): void {
    if (!this.el) return;
    this.el.style.left = `${r.x}px`; this.el.style.top = `${r.y}px`;
    this.el.style.width = `${r.w}px`; this.el.style.height = `${r.h}px`;
  }
  setCentered(on: boolean): void { this.el?.toggleClass('centered', on); }
  setHidden(on: boolean): void { if (this.el) this.el.style.display = on ? 'none' : ''; }
  setLocked(on: boolean): void { this.lockBtnEl?.toggleClass('on', on); }
  setDimmed(on: boolean): void { this.el?.toggleClass('cos-term-dim', on); }
  setSelected(_on: boolean): void { /* journals are never chat members */ }
  setBadge(_text: string | null): void { /* no keyboard-shortcut badge for journals */ }
  focus(): void { this.textarea?.focus(); }
  blur(): void { this.textarea?.blur(); }
  recentOutput(): string { return this.textarea?.value ?? this.currentText; }
  kill(): void {
    if (this.dirty) this.persist(false); // app teardown mid-debounce: last keystrokes still reach disk
    else this.autosave.cancel();
    this.el?.remove(); this.el = null;
  }
}
