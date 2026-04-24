import { useMemo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAgentStream } from '../hooks/useAgentStream';
import { useAgentCustomizations, type MergedAgent } from '../hooks/useAgentCustomizations';
import { AgentSpriteThumb } from './AgentSpriteThumb';

const AGENT_COLORS: Record<string, string> = {
  pm: '#7848A8', ux: '#E068A0', dev: '#4878B8', test: '#48A868', reviewer: '#D08838',
};

// Fun rotating on-brand loader lines per dashboard agent id. Rotates every ~2s
// while waiting for the first stream chunk. Each line uses the agent's
// customized display name via token replacement.
const LOADER_MESSAGES: Record<string, string[]> = {
  pm: [
    "Accessing {NAME}'S BRAIN",
    "{NAME} is pulling the specs",
    "Consulting {NAME}",
    "{NAME} is reading the product context",
  ],
  ux: [
    "Channeling {NAME}'S aesthetic",
    "{NAME} is opening Figma",
    "{NAME} is debating pixel spacing",
    "Accessing {NAME}'S design system",
  ],
  dev: [
    "Booting {NAME}'S IDE",
    "{NAME} is reading the codebase",
    "{NAME} is thinking about edge cases",
    "Accessing {NAME}'S brain",
  ],
  reviewer: [
    "{NAME} is scrolling through the diff",
    "{NAME} is checking for bugs",
    "Reviewing with {NAME}",
    "Accessing {NAME}'S brain",
  ],
  test: [
    "{NAME} is spinning up the browser",
    "{NAME} is clicking around",
    "{NAME} is verifying the deploy",
    "Accessing {NAME}'S brain",
  ],
};
const DEFAULT_LOADER_MESSAGES = ["Connecting to {NAME}", "Accessing {NAME}"];

function StreamLoader({ agent }: { agent: { name: string; role: string } & Pick<MergedAgent, 'id' | 'bodyRow' | 'hairRow' | 'suitRow'> }) {
  const messages = LOADER_MESSAGES[agent.id] || DEFAULT_LOADER_MESSAGES;
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => (i + 1) % messages.length), 2200);
    return () => clearInterval(id);
  }, [messages.length]);
  const line = messages[msgIdx].replace('{NAME}', agent.name.toUpperCase());

  return (
    <div className="mc-stream-loader">
      <div className="mc-stream-loader-sprite">
        <AgentSpriteThumb bodyRow={agent.bodyRow} hairRow={agent.hairRow} suitRow={agent.suitRow} size={72} />
      </div>
      <div className="mc-stream-loader-msg" key={msgIdx}>
        {line.toUpperCase()}
        <span className="mc-stream-loader-dots"><span>.</span><span>.</span><span>.</span></span>
      </div>
      <div className="mc-stream-loader-bar"><span /></div>
    </div>
  );
}

interface AgentStreamModalProps {
  agentId: string;
  taskId: string;
  taskTitle?: string;
  onClose: () => void;
}

type BlockType = 'text' | 'tool' | 'thinking' | 'error';

interface StreamBlock {
  type: BlockType;
  content: string;
}

/**
 * Parse raw stream chunks into typed blocks based on [tool], [thinking], [error] tags.
 */
function parseBlocks(raw: string): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  const lines = raw.split('\n');
  let currentType: BlockType = 'text';
  let currentContent = '';

  const flush = () => {
    const trimmed = currentContent.trim();
    if (trimmed) {
      blocks.push({ type: currentType, content: trimmed });
    }
    currentContent = '';
  };

  for (const line of lines) {
    if (line.startsWith('[tool] ')) {
      flush();
      currentType = 'tool';
      currentContent = line.slice(7) + '\n';
    } else if (line.startsWith('[thinking] ')) {
      flush();
      currentType = 'thinking';
      currentContent = line.slice(11) + '\n';
    } else if (line.startsWith('[error] ')) {
      flush();
      currentType = 'error';
      currentContent = line.slice(8) + '\n';
    } else if (line === '' && currentType !== 'text') {
      // Empty line after a tagged block — switch back to text
      flush();
      currentType = 'text';
    } else {
      currentContent += line + '\n';
    }
  }
  flush();

  return blocks;
}

function StreamBlockView({ block }: { block: StreamBlock }) {
  switch (block.type) {
    case 'tool':
      return (
        <div className="mc-stream-block mc-stream-block-tool">
          <span className="label">TOOL</span>
          <pre className="content">{block.content}</pre>
        </div>
      );
    case 'thinking':
      return (
        <div className="mc-stream-block mc-stream-block-thinking">
          <span className="label">THINKING</span>
          <div className="content italic">{block.content}</div>
        </div>
      );
    case 'error':
      return (
        <div className="mc-stream-block mc-stream-block-error">
          <span className="label">ERROR</span>
          <pre className="content">{block.content}</pre>
        </div>
      );
    case 'text':
      return (
        <div className="mc-stream-block-text stream-markdown">
          <ReactMarkdown
            components={{
              p: ({ children }) => <p className="stream-p">{children}</p>,
              strong: ({ children }) => <strong className="stream-strong">{children}</strong>,
              em: ({ children }) => <em className="stream-em">{children}</em>,
              code: ({ children, className }) => {
                const isBlock = className?.includes('language-');
                if (isBlock) {
                  return (
                    <pre className="stream-code-block">
                      <code>{children}</code>
                    </pre>
                  );
                }
                return <code className="stream-code-inline">{children}</code>;
              },
              pre: ({ children }) => <>{children}</>,
              h1: ({ children }) => <h1 className="stream-h1">{children}</h1>,
              h2: ({ children }) => <h2 className="stream-h2">{children}</h2>,
              h3: ({ children }) => <h3 className="stream-h3">{children}</h3>,
              ul: ({ children }) => <ul className="stream-ul">{children}</ul>,
              ol: ({ children }) => <ol className="stream-ol">{children}</ol>,
              li: ({ children }) => <li className="stream-li">{children}</li>,
              table: ({ children }) => (
                <div className="stream-table-wrap">
                  <table className="stream-table">{children}</table>
                </div>
              ),
              th: ({ children }) => <th className="stream-th">{children}</th>,
              td: ({ children }) => <td className="stream-td">{children}</td>,
              a: ({ children, href }) => <a href={href} className="stream-a" target="_blank" rel="noreferrer">{children}</a>,
              blockquote: ({ children }) => <blockquote className="stream-bq">{children}</blockquote>,
              hr: () => <hr className="stream-hr" />,
            }}
          >
            {block.content}
          </ReactMarkdown>
        </div>
      );
  }
}

// Minimum time the splash loader stays visible on open, even if content is
// ready sooner. Gives the sprite bob + message rotation enough face-time to
// register without adding perceptible lag.
const SPLASH_MIN_MS = 600;

export function AgentStreamModal({ agentId, taskId, taskTitle, onClose }: AgentStreamModalProps) {
  const { chunks, connected, loaded, bottomRef } = useAgentStream(taskId, agentId);
  const { byId } = useAgentCustomizations();
  const [splashDone, setSplashDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSplashDone(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);
  // Coordinator role 'qa' maps to dashboard character 'test' (Zara). Look up
  // the merged agent via either key so names + sprites resolve correctly.
  const merged = byId[agentId] || byId[agentId === 'qa' ? 'test' : agentId];
  const agent = merged
    ? { name: merged.name, role: merged.role, color: AGENT_COLORS[agentId] || '#666', id: merged.id, bodyRow: merged.bodyRow, hairRow: merged.hairRow, suitRow: merged.suitRow }
    : { name: agentId, role: '?', color: '#666', id: agentId, bodyRow: 0, hairRow: 0, suitRow: 0 };

  // Combine all chunks into a single string and parse into blocks
  const blocks = useMemo(() => {
    const raw = chunks.map(c => c.chunk).join('');
    return parseBlocks(raw);
  }, [chunks]);

  // Escape to close — matches other MC modals
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mc-modal-backdrop" onClick={onClose}>
      <div className="mc-modal mc-stream-modal" onClick={e => e.stopPropagation()}>
        <div className="mc-modal-head">
          <div className="mc-stream-head-left">
            <span className="mc-stream-dot" style={{ backgroundColor: agent.color }} />
            <span className="title">{agent.name.toUpperCase()}</span>
            <span className="mc-stream-role">{agent.role.toUpperCase()}</span>
            {taskTitle && <span className="mc-stream-task" title={taskTitle}>{taskTitle}</span>}
          </div>
          <div className="mc-stream-head-right">
            <span className={`mc-stream-live${connected ? ' on' : ''}`}>
              <span className="pip" />
              {connected ? 'LIVE' : 'CONNECTING...'}
            </span>
            <button className="mc-modal-close" onClick={onClose}>[ CLOSE ]</button>
          </div>
        </div>

        <div className="mc-modal-body mc-stream-body">
          {(!splashDone || (chunks.length === 0 && (!loaded || connected))) && (
            <StreamLoader agent={agent} />
          )}
          {splashDone && blocks.map((block, i) => (
            <StreamBlockView key={i} block={block} />
          ))}
          <div ref={bottomRef} />
          {splashDone && chunks.length > 0 && <span className="mc-stream-cursor" />}
        </div>

        <div className="mc-stream-foot">
          <span>TASK · {taskId}</span>
          <span>ESC OR [ CLOSE ] TO EXIT</span>
        </div>
      </div>
    </div>
  );
}
