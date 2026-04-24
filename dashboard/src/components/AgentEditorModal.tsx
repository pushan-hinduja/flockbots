import { useEffect, useRef, useState } from 'react';
import { AgentSpriteThumb } from './AgentSpriteThumb';
import { SPRITE_OPTION_COUNTS } from '../hooks/useAgentCustomizations';
import type { MergedAgent } from '../hooks/useAgentCustomizations';

interface AgentEditorModalProps {
  agent: MergedAgent;
  initialFocus?: 'name' | 'appearance';
  onClose: () => void;
  onSave: (patch: { name?: string; body_row?: number; hair_row?: number; suit_row?: number }) => Promise<void>;
}

/**
 * Agent customization modal. Styled to match the terminal/mission-console
 * aesthetic of the dashboard's overflow modal (mc-modal-* classes).
 */
export function AgentEditorModal({ agent, initialFocus = 'name', onClose, onSave }: AgentEditorModalProps) {
  const [name, setName] = useState(agent.name);
  const [bodyRow, setBodyRow] = useState(agent.bodyRow);
  const [hairRow, setHairRow] = useState(agent.hairRow);
  const [suitRow, setSuitRow] = useState(agent.suitRow);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appearanceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialFocus === 'appearance' && appearanceRef.current) {
      appearanceRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [initialFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty =
    name !== agent.name ||
    bodyRow !== agent.bodyRow ||
    hairRow !== agent.hairRow ||
    suitRow !== agent.suitRow;

  async function handleSave() {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const patch: any = {};
      if (name !== agent.name) patch.name = name.trim() || agent.name;
      if (bodyRow !== agent.bodyRow) patch.body_row = bodyRow;
      if (hairRow !== agent.hairRow) patch.hair_row = hairRow;
      if (suitRow !== agent.suitRow) patch.suit_row = suitRow;
      await onSave(patch);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mc-modal-backdrop" onClick={onClose}>
      <div className="mc-modal mc-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="mc-modal-head">
          <span className="title">EDIT AGENT · {agent.role.toUpperCase()}</span>
          <button className="mc-modal-close" onClick={onClose}>[ CLOSE ]</button>
        </div>

        <div className="mc-modal-body mc-editor-body">
          {/* Preview header */}
          <div className="mc-editor-preview">
            <AgentSpriteThumb bodyRow={bodyRow} hairRow={hairRow} suitRow={suitRow} size={56} />
            <div className="mc-editor-preview-info">
              <div className="mc-editor-preview-name">{(name || agent.name).toUpperCase()}</div>
              <div className="mc-editor-preview-role">{agent.role}</div>
            </div>
          </div>

          {/* NAME */}
          <section className="mc-editor-section">
            <div className="mc-editor-section-label">NAME</div>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={agent.name}
              className="mc-editor-input"
              autoFocus={initialFocus === 'name'}
              maxLength={40}
            />
            <div className="mc-editor-hint">Leave blank to revert to default ({agent.name}).</div>
          </section>

          {/* APPEARANCE */}
          <section ref={appearanceRef} className="mc-editor-section">
            <div className="mc-editor-section-label">APPEARANCE</div>

            <OptionGrid
              label="BODY"
              count={SPRITE_OPTION_COUNTS.body}
              selected={bodyRow}
              onSelect={setBodyRow}
              render={row => <AgentSpriteThumb bodyRow={row} hairRow={hairRow} suitRow={suitRow} size={40} />}
            />
            <OptionGrid
              label="HAIR"
              count={SPRITE_OPTION_COUNTS.hair}
              selected={hairRow}
              onSelect={setHairRow}
              render={row => <AgentSpriteThumb bodyRow={bodyRow} hairRow={row} suitRow={suitRow} size={40} />}
            />
            <OptionGrid
              label="OUTFIT"
              count={SPRITE_OPTION_COUNTS.suit}
              selected={suitRow}
              onSelect={setSuitRow}
              render={row => <AgentSpriteThumb bodyRow={bodyRow} hairRow={hairRow} suitRow={row} size={40} />}
            />
          </section>

          {error && <div className="mc-editor-error">{error}</div>}
        </div>

        <div className="mc-editor-actions">
          <button className="mc-editor-btn" onClick={onClose}>[ CANCEL ]</button>
          <button
            className="mc-editor-btn mc-editor-btn-primary"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? '[ SAVING... ]' : '[ SAVE ]'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface OptionGridProps {
  label: string;
  count: number;
  selected: number;
  onSelect: (row: number) => void;
  render: (row: number) => React.ReactNode;
}

function OptionGrid({ label, count, selected, onSelect, render }: OptionGridProps) {
  return (
    <div className="mc-editor-grid-wrap">
      <div className="mc-editor-grid-head">
        <span>{label}</span>
        <span className="mc-editor-grid-count">{selected + 1}/{count}</span>
      </div>
      <div className="mc-editor-grid">
        {Array.from({ length: count }, (_, row) => {
          const isSelected = row === selected;
          return (
            <button
              key={row}
              className={`mc-editor-option${isSelected ? ' on' : ''}`}
              onClick={() => onSelect(row)}
              aria-label={`${label} option ${row + 1}`}
              aria-pressed={isSelected}
            >
              {render(row)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
