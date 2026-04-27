import { randomUUID } from 'crypto';
import { extractInstanceFlag, loadEnvFile } from './env';

/**
 * `flockbots task add [-i <slug>] "<description>"` — queues a task into the
 * SQLite pipeline via the CLI, useful when you don't have a chat provider
 * configured or you want to script task creation.
 *
 * Queue loads the DB lazily at require time, so we ensure the env is
 * loaded first before touching ./queue.
 */
export async function runTaskAdd(args: string[]): Promise<void> {
  const { instanceId, rest } = extractInstanceFlag(args);
  const description = rest.join(' ').trim();
  if (!description) {
    console.error('Usage: flockbots task add [-i <slug>] "<description>"');
    process.exit(1);
  }

  loadEnvFile(instanceId);

  // Defer require so paths.ts sees the loaded FLOCKBOTS_HOME
  const { createTask } = await import('../queue');

  const id = randomUUID().slice(0, 8);
  const firstLine = description.split('\n')[0];
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;

  createTask(id, title, description, 'cli');
  console.log(`Queued task ${id}: ${title}`);
}
