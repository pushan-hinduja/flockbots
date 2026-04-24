import { supabase } from '../supabase';
import { Logo } from './Logo';
import './Login.css';

interface AccessDeniedProps {
  email: string;
}

export function AccessDenied({ email }: AccessDeniedProps) {
  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="lg-root">
      <div className="lg-bg-rings">
        <svg viewBox="0 0 900 900">
          <circle cx="450" cy="450" r="420" fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 6"/>
          <circle cx="450" cy="450" r="340" fill="none" stroke="rgba(255,255,255,0.06)"/>
          <circle cx="450" cy="450" r="260" fill="none" stroke="rgba(255,255,255,0.05)" strokeDasharray="1 6"/>
          <circle cx="450" cy="450" r="180" fill="none" stroke="rgba(255,255,255,0.08)"/>
          <circle cx="450" cy="450" r="120" fill="none" stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4"/>
          <line x1="450" y1="30" x2="450" y2="870" stroke="rgba(255,255,255,0.05)" strokeDasharray="2 6"/>
          <line x1="30" y1="450" x2="870" y2="450" stroke="rgba(255,255,255,0.05)" strokeDasharray="2 6"/>
        </svg>
        <div className="lg-sweep" />
      </div>

      <main className="lg-stage">
        <div className="lg-panel">
          <div className="lg-brand">
            <Logo size={30} />
            <div className="lg-brand-name">FLOCKBOTS</div>
          </div>

          <div className="lg-title">ACCESS DENIED</div>
          <div className="lg-subtitle">UNAUTHORIZED USER</div>

          <div className="lg-denied-body">
            <div className="lg-denied-email">{email}</div>
            <p className="lg-denied-msg">
              This account is not on the allowlist for the Agent Console.
            </p>
            <p className="lg-denied-msg">
              Ask an admin to add your user ID to the <code>flockbots_console_access</code> table.
            </p>
          </div>

          <button type="button" className="lg-submit" onClick={handleSignOut}>
            SIGN OUT →
          </button>
        </div>
      </main>
    </div>
  );
}
