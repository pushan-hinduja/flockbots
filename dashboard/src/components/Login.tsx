import { useState } from 'react';
import { supabase } from '../supabase';
import { Logo } from './Logo';
import './Login.css';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'err'; text: string }>({ kind: 'idle', text: '' });
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setStatus({ kind: 'err', text: 'MISSING CREDENTIALS' });
      return;
    }
    setLoading(true);
    setStatus({ kind: 'ok', text: 'VERIFYING…' });
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      setStatus({ kind: 'err', text: error.message.toUpperCase() });
      return;
    }
    setStatus({ kind: 'ok', text: 'ACCESS GRANTED · REDIRECTING' });
    // Auth state listener in App.tsx will swap views automatically.
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
        <form className="lg-panel" onSubmit={handleLogin} autoComplete="off">
          <div className="lg-brand">
            <Logo size={30} />
            <div className="lg-brand-name">FLOCKBOTS</div>
          </div>

          <div className="lg-title">SIGN IN</div>
          <div className="lg-subtitle">MULTI-AGENT ORCHESTRATION SYSTEM</div>

          <div className="lg-field">
            <label htmlFor="lg-email">EMAIL</label>
            <div className="lg-field-input">
              <input
                id="lg-email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
                required
              />
            </div>
          </div>

          <div className="lg-field">
            <label htmlFor="lg-pw">PASSWORD</label>
            <div className="lg-field-input">
              <input
                id="lg-pw"
                type={showPw ? 'text' : 'password'}
                placeholder="••••••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="lg-suffix"
                onClick={() => setShowPw(v => !v)}
              >{showPw ? 'HIDE' : 'SHOW'}</button>
            </div>
          </div>

          <button type="submit" className="lg-submit" disabled={loading}>
            {loading ? 'AUTHENTICATING…' : 'AUTHENTICATE →'}
          </button>

          <div className={`lg-status ${status.kind === 'err' ? 'err' : status.kind === 'ok' ? 'ok' : ''}`}>
            {status.text || '\u00a0'}
          </div>
        </form>
      </main>
    </div>
  );
}
