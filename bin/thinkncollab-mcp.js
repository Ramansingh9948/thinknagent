#!/usr/bin/env node
/**
 * ThinkNCollab Model Context Protocol (MCP) Server
 * Strict Spec Compliance: MCP Protocol Version 2024-11-05 / JSON-RPC 2.0
 */

const readline = require('readline');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const API_BASE_URL = process.env.THINKNCOLLAB_API_URL || 'http://localhost:3001';
const API_TOKEN = process.env.THINKNCOLLAB_TOKEN || '';
const BOARD_ID = process.env.THINKNCOLLAB_BOARD_ID || '';
const ROOM_ID = process.env.THINKNCOLLAB_ROOM_ID || '';

// ── HTTP API Request Helper ───────────────────────────────────────────────────
function apiRequest(method, endpoint, data = null) {
  return new Promise((resolve, reject) => {
    try {
      const baseObj = new URL(API_BASE_URL);
      
      // SECURITY FIX: Ensure endpoint is strictly relative to prevent URL override
      // and exfiltration of API_TOKEN to third-party endpoints.
      const safeEndpoint = endpoint.startsWith('http://') || endpoint.startsWith('https://')
        ? new URL(endpoint).pathname + new URL(endpoint).search
        : endpoint;

      const parsedUrl = new URL(safeEndpoint, baseObj.origin);

      if (parsedUrl.origin !== baseObj.origin) {
        return reject(new Error(`Security Error: Request origin mismatch (${parsedUrl.origin} vs ${baseObj.origin})`));
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const payload = data ? JSON.stringify(data) : null;
      const headers = {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ThinkNCollab-MCP/1.0.0'
      };
      if (payload) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method.toUpperCase(),
        headers
      };


      const req = client.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json);
          } catch (e) {
            resolve({ raw: body, statusCode: res.statusCode });
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Strict MCP Tool Definitions (JSON Schema draft-07 compatible) ─────────────
const TOOLS = [
  {
    name: 'thinkncollab_get_board_state',
    description: 'Get full project backlog, columns, and task list from ThinkNCollab board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID (optional if set in environment)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_plan_and_create_tasks',
    description: 'Decompose a project or feature into structured tasks and batch-create them on the board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID (optional if set in environment)'
        },
        tasks: {
          type: 'array',
          description: 'Array of task objects to generate on the board',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task title' },
              description: { type: 'string', description: 'Markdown technical spec & implementation steps' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              category: { type: 'string', description: 'Category e.g. Feature Requests, Security Issues, Bugs' },
              acceptanceCriteria: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of acceptance criteria checklist items'
              }
            },
            required: ['title']
          }
        }
      },
      required: ['tasks'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_create_task',
    description: 'Create a single new task with full technical documentation on the ThinkNCollab board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID (optional if set in environment)'
        },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Markdown technical specification' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        category: { type: 'string', description: 'Task category' },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of acceptance criteria checklist items'
        }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_get_task_spec',
    description: 'Read the full markdown specification, acceptance criteria, and comments of a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_update_task_spec',
    description: 'Update the technical documentation, description, or acceptance criteria of a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        description: { type: 'string', description: 'Updated markdown documentation' },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string' }
        },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_start_task',
    description: 'Mark a task as in-progress and notify the team that the AI agent is working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_add_comment',
    description: 'Add a progress note, architectural decision, or question to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        content: { type: 'string', description: 'Comment text / log' }
      },
      required: ['taskId', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_complete_task',
    description: 'Mark a task completed, post the completion verification comment, and trigger auto-tests.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        comment: { type: 'string', description: 'Detailed completion summary of what was implemented and tested' }
      },
      required: ['taskId', 'comment'],
      additionalProperties: false
    }
  },
  {
    name: 'thinkncollab_auto_assign_tasks',
    description: 'Automatically categorize, tag, and distribute board tasks to team members based on domain skills and workload balance.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID (optional if set in environment)'
        }
      },
      additionalProperties: false
    }
  }
];

// ── MCP Tool Execution Handler ────────────────────────────────────────────────
async function handleToolCall(name, args = {}) {
  const bId = args.boardId || BOARD_ID;

  switch (name) {
    case 'thinkncollab_get_board_state': {
      if (!bId) throw new Error('boardId is required (or set THINKNCOLLAB_BOARD_ID environment variable)');
      return await apiRequest('GET', `/boards/${bId}/api/state`);
    }

    case 'thinkncollab_plan_and_create_tasks': {
      if (!bId) throw new Error('boardId is required (or set THINKNCOLLAB_BOARD_ID environment variable)');
      return await apiRequest('POST', `/boards/${bId}/api/plan`, { tasks: args.tasks });
    }

    case 'thinkncollab_create_task': {
      if (!bId) throw new Error('boardId is required (or set THINKNCOLLAB_BOARD_ID environment variable)');
      return await apiRequest('POST', `/boards/${bId}/api/tasks/create`, args);
    }

    case 'thinkncollab_auto_assign_tasks': {
      if (!bId) throw new Error('boardId is required (or set THINKNCOLLAB_BOARD_ID environment variable)');
      return await apiRequest('POST', `/boards/${bId}/api/auto-assign-all`);
    }

    case 'thinkncollab_get_task_spec': {
      return await apiRequest('GET', `/tasks/${args.taskId}/api/spec`);
    }

    case 'thinkncollab_update_task_spec': {
      return await apiRequest('PUT', `/tasks/${args.taskId}/api/spec`, args);
    }

    case 'thinkncollab_start_task': {
      return await apiRequest('POST', `/tasks/${args.taskId}/api/start`);
    }

    case 'thinkncollab_add_comment': {
      return await apiRequest('POST', `/tasks/${args.taskId}/api/comment`, { content: args.content });
    }

    case 'thinkncollab_complete_task': {
      return await apiRequest('POST', `/tasks/${args.taskId}/api/complete`, { comment: args.comment });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC 2.0 Response Dispatcher ──────────────────────────────────────────
function sendResult(id, result) {
  if (id === null || id === undefined) return;
  const res = { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(res) + '\n');
}

function sendError(id, code, message) {
  if (id === null || id === undefined) return;
  const res = { jsonrpc: '2.0', id, error: { code, message } };
  process.stdout.write(JSON.stringify(res) + '\n');
}

// ── Stdio Stream Listener ─────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params } = msg;

  // Handle Notifications (No id -> Never respond in JSON-RPC 2.0)
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized' || method === 'initialized') {
      process.stderr.write('[MCP] Client initialized successfully.\n');
    }
    return;
  }

  // Handle Requests
  try {
    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'thinkncollab',
          version: '1.0.0'
        }
      });
    } else if (method === 'tools/list') {
      sendResult(id, {
        tools: TOOLS
      });
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const data = await handleToolCall(toolName, toolArgs);
        sendResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2)
            }
          ],
          isError: false
        });
      } catch (callErr) {
        sendResult(id, {
          content: [
            {
              type: 'text',
              text: `Tool error (${toolName}): ${callErr.message}`
            }
          ],
          isError: true
        });
      }
    } else if (method === 'ping') {
      sendResult(id, {});
    } else {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (handlerErr) {
    sendError(id, -32603, `Internal error: ${handlerErr.message}`);
  }
});
