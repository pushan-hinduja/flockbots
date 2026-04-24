import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { Login } from './components/Login';
import { MissionConsole } from './components/MissionConsole';
import { AccessDenied } from './components/AccessDenied';

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [access, setAccess] = useState<'loading' | 'granted' | 'denied'>('loading');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (!session) setAccess('loading');
    });
    return () => subscription.unsubscribe();
  }, []);

  // Check allowlist after session is established
  useEffect(() => {
    if (!session) return;
    setAccess('loading');
    supabase
      .from('flockbots_console_access')
      .select('user_id')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          console.error('Access check failed:', error.message);
          setAccess('denied'); // Fail closed — deny on error
        } else {
          setAccess(data ? 'granted' : 'denied');
        }
      });
  }, [session]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!session) return <Login />;
  if (access === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }
  if (access === 'denied') return <AccessDenied email={session.user.email} />;
  return <MissionConsole />;
}
