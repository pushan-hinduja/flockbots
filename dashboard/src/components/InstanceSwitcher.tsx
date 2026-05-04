import { useState } from 'react';
import { useInstance, isInstanceOnline } from '../contexts/InstanceContext';

/**
 * Top-bar dropdown listing every non-archived instance. Selection drives
 * which instance the data hooks read (tasks, events, usage, sub-agents).
 * Cross-instance views (escalations, instance roster) are not affected.
 *
 * Custom menu (button + absolute-positioned <ul>) so the open list can
 * match the chrome's dark theme instead of the native <select>'s macOS
 * popover.
 */
export function InstanceSwitcher() {
  const { instances, selectedInstance, setSelectedInstance, loaded } = useInstance();
  const [open, setOpen] = useState(false);

  if (!loaded) {
    return <span className="mc-instance-loading">…</span>;
  }
  if (instances.length === 0) {
    return (
      <span className="mc-instance-empty" title="No coordinators have registered yet">
        NO INSTANCES
      </span>
    );
  }
  if (instances.length === 1) {
    // Single-instance install — show the slug, no dropdown affordance.
    const inst = instances[0];
    const online = isInstanceOnline(inst);
    return (
      <div className="mc-instance-wrap">
        <span
          className={`mc-instance-pill ${online ? 'online' : 'offline'}`}
          title={`${inst.target_repo} — ${online ? 'online' : 'offline'}`}
        >
          <span className="dot" />
          <span className="name">{inst.display_name || inst.id}</span>
        </span>
      </div>
    );
  }

  const current = instances.find((i) => i.id === selectedInstance);
  const online = current ? isInstanceOnline(current) : false;

  return (
    <div className="mc-instance-wrap">
      <button
        type="button"
        className={`mc-instance-pill ${online ? 'online' : 'offline'}`}
        title={current?.target_repo || ''}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dot" />
        <span className="name">{current?.display_name || current?.id || '—'}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="mc-instance-backdrop" onClick={() => setOpen(false)} />
          <ul className="mc-instance-menu" role="listbox">
            {instances.map((inst) => {
              const isOnline = isInstanceOnline(inst);
              const isSelected = inst.id === selectedInstance;
              return (
                <li
                  key={inst.id}
                  className={`${isOnline ? '' : 'offline'} ${isSelected ? 'selected' : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  title={inst.target_repo}
                  onClick={() => {
                    setSelectedInstance(inst.id);
                    setOpen(false);
                  }}
                >
                  <span className="dot" />
                  <span>{inst.display_name || inst.id}</span>
                  {isSelected && <span className="check">✓</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
