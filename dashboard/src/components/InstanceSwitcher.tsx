import { useInstance, isInstanceOnline } from '../contexts/InstanceContext';

/**
 * Top-bar dropdown listing every non-archived instance. Selection drives
 * which instance the data hooks read (tasks, events, usage, sub-agents).
 * Cross-instance views (escalations, instance roster) are not affected.
 */
export function InstanceSwitcher() {
  const { instances, selectedInstance, setSelectedInstance, loaded } = useInstance();

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
      <span
        className={`mc-instance-pill ${online ? 'online' : 'offline'}`}
        title={`${inst.target_repo} — ${online ? 'online' : 'offline'}`}
      >
        <span className="dot" />
        {inst.display_name || inst.id}
      </span>
    );
  }

  const current = instances.find((i) => i.id === selectedInstance);
  const online = current ? isInstanceOnline(current) : false;

  return (
    <label className={`mc-instance-pill ${online ? 'online' : 'offline'}`} title={current?.target_repo || ''}>
      <span className="dot" />
      <select
        className="mc-instance-select"
        value={selectedInstance || ''}
        onChange={(e) => setSelectedInstance(e.target.value)}
      >
        {instances.map((inst) => {
          const isOnline = isInstanceOnline(inst);
          return (
            <option key={inst.id} value={inst.id}>
              {(inst.display_name || inst.id) + (isOnline ? '' : ' · offline')}
            </option>
          );
        })}
      </select>
    </label>
  );
}
