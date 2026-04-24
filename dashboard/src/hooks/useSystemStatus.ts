import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export type SystemStatus = 'online' | 'warning' | 'offline';

interface SystemStatusResult {
  status: SystemStatus;
  errors: string[];
  lastHeartbeat: string | null;
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export function useSystemStatus(
  health: Record<string, any>,
): SystemStatusResult {
  const [result, setResult] = useState<SystemStatusResult>({
    status: 'offline',
    errors: [],
    lastHeartbeat: null,
  });

  useEffect(() => {
    const heartbeat = health.coordinator_heartbeat;
    const systemHealth = health.system_health;

    if (!heartbeat || !heartbeat.online) {
      setResult({ status: 'offline', errors: [], lastHeartbeat: null });
      return;
    }

    const lastBeat = new Date(heartbeat.timestamp).getTime();
    const age = Date.now() - lastBeat;

    if (age > STALE_THRESHOLD_MS) {
      setResult({
        status: 'offline',
        errors: ['No heartbeat in the last 15 minutes'],
        lastHeartbeat: heartbeat.timestamp,
      });
      return;
    }

    // Online — check for warnings
    const errors: string[] = [];

    if (systemHealth) {
      if (systemHealth.consecutiveFailures >= 3) {
        errors.push(`${systemHealth.consecutiveFailures} of last 5 tasks failed`);
      }
      if (systemHealth.recentTimeouts >= 3) {
        errors.push(`${systemHealth.recentTimeouts} agent sessions timed out recently`);
      }
      if (systemHealth.budgetPaused) {
        errors.push(`Rate limit paused at ${Math.round(systemHealth.budgetPct)}%`);
      }
      if (systemHealth.stuckEscalations > 0) {
        errors.push(`${systemHealth.stuckEscalations} escalation(s) awaiting input for 12+ hours`);
      }
      // Include any alerts from the health monitor
      if (Array.isArray(systemHealth.alerts)) {
        for (const alert of systemHealth.alerts) {
          if (!errors.includes(alert)) errors.push(alert);
        }
      }
    }

    setResult({
      status: errors.length > 0 ? 'warning' : 'online',
      errors,
      lastHeartbeat: heartbeat.timestamp,
    });
  }, [health]);

  return result;
}
