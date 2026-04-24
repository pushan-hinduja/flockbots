import { randomUUID } from 'crypto';
import { createTask, initDatabase } from '../coordinator/src/queue';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const title = getArg('title');
const description = getArg('description') || title;
const priorityStr = getArg('priority') || 'medium';

if (!title) {
  console.error('Usage: npx ts-node scripts/add-task.ts --title "..." [--description "..."] [--priority high|medium|low]');
  process.exit(1);
}

const priorityMap: Record<string, number> = { high: 1, medium: 2, low: 3 };
const priority = priorityMap[priorityStr] || 2;

initDatabase();

const taskId = randomUUID().slice(0, 8);
createTask(taskId, title, description!, 'manual', undefined, priority);
console.log(`Task created: ${taskId} — ${title} (priority: ${priorityStr})`);
