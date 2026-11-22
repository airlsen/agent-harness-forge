#!/usr/bin/env node
/** Store-level unit checks, using deterministic HTTP stubs (not API/model acceptance).
 * Loads the real TypeScript store through Vite; no extra testing dependency or dev server.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createPinia, setActivePinia } from 'pinia';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
const realFetch = globalThis.fetch;
const storage = new Map();
const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
// Node has no Web Storage by default: a Map-backed stub stands in for the "last used model" preference.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
});
const checks = [];
const calls = [];
const database = new Map();
let createGate = null;
let turnGate = null;
let detailGate = null;
let failTurn = false;
let failDetailId = null;
let nextSession = 100;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const response = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status === 200 ? 0 : status, data, message: 'Unit fixture request failed' }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
const modelOption = (id, isDefault = false) => ({
  id,
  name: `Model ${id}`,
  model: `model-${id}`,
  contextWindow: 64000,
  inputPrice: null,
  outputPrice: null,
  isDefault,
  status: 'untested',
});
const detail = (id, scenarioId = 1, modelId = 7) => ({
  id,
  scenarioId,
  modelId,
  model: `model-${modelId}`,
  modelName: `Model ${modelId}`,
  scenarioName: `Scenario ${scenarioId}`,
  scenarioVersion: 1,
  title: `Session ${id}`,
  status: 'idle',
  lastEventSeq: 0,
  messages: [],
  pendingApprovals: [],
  bundle: { meta: {} },
  tokensIn: 0,
  tokensOut: 0,
  cost: 0,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const scenario = (id, status = 'template') => ({
  id,
  status,
  space: 'official',
  current_version: 1,
  payload: {
    name: `Scenario ${id}`,
    icon: id === 1 ? 'sparkles' : 'file',
    capabilities: { builtin_tool_names: [] },
  },
});
async function until(test) {
  for (let i = 0; i < 100; ++i) {
    if (test()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Unit fixture did not reach its expected asynchronous boundary');
}
const count = (pattern, method = 'GET') =>
  calls.filter((call) => call.method === method && pattern.test(call.url)).length;
function passed(name) {
  checks.push(name);
  console.log('PASS draft store:', name);
}
let chat;
try {
  const { usePlatform } = await vite.ssrLoadModule('/src/stores/platform.ts');
  const { useConversation } = await vite.ssrLoadModule('/src/stores/conversation.ts');
  setActivePinia(createPinia());
  const app = usePlatform();
  chat = useConversation();
  app.authenticated = true;
  app.user = { username: 'unit-fixture-only' };
  app.connection = { configured: true };
  app.scenarios = [scenario(1), scenario(2, 'published'), scenario(3, 'draft')];
  const defaultModels = () => {
    app.modelOptions = [modelOption(7, true), modelOption(8)];
    app.defaultModelId = 7;
  };
  defaultModels();
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : undefined });
    if (url === '/api/agent/sessions' && method === 'GET') return response({ items: [...database.values()] });
    if (url === '/api/code/projects')
      return response({
        root: '/usr/data/git',
        available: true,
        projects: ['alpha', 'beta'].map((name) => ({ name, path: `/usr/data/git/${name}`, branch: 'main' })),
      });
    if (url === '/api/agent/sessions' && method === 'POST') {
      const body = JSON.parse(options.body);
      const row = detail(++nextSession, body.scenarioId, body.modelId);
      database.set(row.id, row);
      if (createGate) await createGate.promise;
      return response(row);
    }
    const match = url.match(/^\/api\/agent\/sessions\/(\d+)(.*)$/);
    assert.ok(match, `Unexpected unit fixture URL: ${url}`);
    const id = Number(match[1]);
    const suffix = match[2];
    const row = database.get(id);
    assert.ok(row, `Unit session ${id} is missing`);
    if (!suffix && method === 'GET') {
      if (failDetailId === id) {
        failDetailId = null;
        return response(null, 503);
      }
      const snapshot = clone(row);
      if (detailGate?.id === id) await detailGate.promise;
      return response(snapshot);
    }
    if (suffix.startsWith('/trajectory')) return response({ events: [], nextCursor: 0 });
    if (suffix === '/files') return response({ items: [] });
    if (suffix === '/turns' && method === 'POST') {
      if (turnGate) await turnGate.promise;
      if (failTurn) {
        failTurn = false;
        return response(null, 409);
      }
      const body = JSON.parse(options.body);
      const messageId = row.messages.length + 1;
      const from = { id: row.modelId, name: row.modelName, model: row.model };
      if (body.modelId !== undefined && body.modelId !== row.modelId) {
        row.modelId = body.modelId;
        row.modelName = `Model ${body.modelId}`;
        row.model = `model-${body.modelId}`;
      }
      const to = { id: row.modelId, name: row.modelName, model: row.model };
      if (body.codeProjects !== undefined) row.codeProjects = body.codeProjects;
      if (body.capabilities !== undefined) row.capabilities = body.capabilities;
      const code = row.codeProjects ?? [];
      const capabilities = row.capabilities ?? { skillIds: [], mcpServerIds: [], webSearch: false };
      const messageMeta = {
        modelId: to.id,
        modelName: to.name,
        model: to.model,
        ...(from.id !== to.id ? { modelSwitch: { messageId, from, to } } : {}),
        ...(code.length ? { codeProjects: code } : {}),
      };
      row.messages.push({ id: messageId, role: 'user', content: body.message, meta: messageMeta });
      row.status = 'running';
      return response({
        messageId,
        cursor: 0,
        messageMeta,
        model: { ...to, contextWindow: 64000 },
        codeProjects: code,
        capabilities,
      });
    }
    if (suffix.startsWith('/events?')) {
      // Pending SSE is aborted by the real store's disconnect(), without a timer or network.
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Unit stream disconnected', 'AbortError'));
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
    }
    assert.fail(`Unexpected unit fixture request: ${method} ${url}`);
  };
  function reset() {
    chat.clear();
    calls.length = 0;
    createGate = null;
    turnGate = null;
    detailGate = null;
    failTurn = false;
    failDetailId = null;
    storage.clear();
    defaultModels();
    database.clear();
    database.set(11, detail(11));
    database.set(12, detail(12, 2));
    chat.prepareStart();
  }

  reset();
  chat.input = 'Unsent home task';
  chat.draftAttachments.push({ name: 'notes.txt', content: 'Original material' });
  assert.equal(chat.selectScenario(2), true);
  const firstDraft = chat.draftId;
  chat.prepareStart();
  assert.equal(chat.input, 'Unsent home task');
  assert.equal(chat.selectedScenarioId, 2);
  assert.equal(chat.draftAttachments[0].content, 'Original material');
  assert.equal(chat.requestNewConversation(), false);
  assert.ok(chat.pendingNewConversation);
  assert.equal(chat.draftId, firstDraft);
  assert.equal(chat.input, 'Unsent home task');
  chat.pendingNewConversation = null;
  chat.newConversation(2); // Explicitly confirmed replacement.
  assert.equal(chat.input, '');
  assert.deepEqual(chat.draftAttachments, []);
  assert.notEqual(chat.draftId, firstDraft);
  assert.equal(chat.hasUnsentDrafts, false);
  assert.equal(calls.length, 0);
  passed(
    'home returns and scenario selection preserve text/files; replacing a start draft requires an explicit decision without any session API calls',
  );

  reset();
  chat.input = 'Will be manually cleared';
  chat.saveDraft();
  chat.input = '';
  assert.equal(chat.hasUnsentDrafts, false);
  chat.draftAttachments.push({ name: 'removed.txt', content: 'Will be removed' });
  chat.saveDraft();
  chat.draftAttachments = [];
  assert.equal(chat.hasUnsentDrafts, false);
  passed(
    'manually clearing active text/files does not leave a false browser-leave warning from an older cached snapshot',
  );

  reset();
  chat.input = 'Task draft';
  chat.draftAttachments.push({ name: 'start.txt', content: 'Start file' });
  chat.selectScenario(2);
  await chat.open(11);
  assert.equal(chat.input, '');
  assert.deepEqual(chat.draftAttachments, []);
  chat.input = 'Reply to session 11';
  chat.draftAttachments.push({ name: 'reply.txt', content: 'Only session 11' });
  await chat.open(12);
  assert.equal(chat.input, '');
  chat.input = 'Reply to session 12';
  chat.prepareStart();
  assert.equal(chat.input, 'Task draft');
  assert.equal(chat.selectedScenarioId, 2);
  assert.equal(chat.draftAttachments[0].content, 'Start file');
  await chat.open(11);
  assert.equal(chat.input, 'Reply to session 11');
  assert.equal(chat.draftAttachments[0].content, 'Only session 11');
  await chat.open(12);
  assert.equal(chat.input, 'Reply to session 12');
  assert.deepEqual(chat.draftAttachments, []);
  chat.prepareStart();
  assert.equal(chat.input, 'Task draft');
  passed('new-task drafts and each existing-session reply restore only within their own context');

  await chat.open(11);
  chat.input = 'Keep the reply across a canceled read';
  await chat.open(12);
  detailGate = { id: 11, ...deferred() };
  const priorReads = count(/^\/api\/agent\/sessions\/11$/);
  const opening = chat.open(11);
  await until(() => count(/^\/api\/agent\/sessions\/11$/) > priorReads);
  assert.equal(chat.loading, true);
  chat.prepareStart();
  assert.equal(chat.input, 'Task draft');
  detailGate.resolve();
  await opening;
  assert.equal(chat.current, null);
  detailGate = null;
  await chat.open(11);
  assert.equal(chat.input, 'Keep the reply across a canceled read');
  passed(
    'leaving a slow session load neither overwrites its parked reply nor attaches a stale response to home',
  );

  reset();
  await chat.open(11);
  chat.input = 'Reply survives a failed history read';
  await chat.open(12);
  failDetailId = 11;
  await assert.rejects(chat.open(11), /Unit fixture request failed/);
  assert.equal(chat.hasUnsentDrafts, true);
  chat.prepareStart();
  assert.equal(chat.input, '');
  await chat.open(11);
  assert.equal(chat.input, 'Reply survives a failed history read');
  passed(
    'failed history reads retain the parked reply through a home visit and later retry rather than saving an empty error placeholder over it',
  );

  reset();
  assert.equal(chat.selectScenario(3), false);
  chat.newConversation(3);
  chat.input = 'Explicit maintenance preview';
  chat.prepareStart();
  assert.equal(chat.selectedScenarioId, 3);
  assert.equal(chat.previewScenarioId, 3);
  await chat.open(11);
  chat.prepareStart();
  assert.equal(chat.input, 'Explicit maintenance preview');
  assert.equal(chat.selectedScenarioId, 3);
  assert.equal(chat.previewScenarioId, 3);
  passed(
    'unpublished scenarios cannot be public suggestions; explicitly requested maintenance previews remain usable and clearly scoped',
  );

  reset();
  chat.input = 'Old task, create response pending';
  createGate = deferred();
  const creating = chat.submit();
  await until(() => count(/^\/api\/agent\/sessions$/, 'POST') === 1);
  chat.newConversation();
  chat.input = 'A genuinely new task';
  chat.draftAttachments.push({ name: 'new.txt', content: 'Never clear this' });
  createGate.resolve();
  assert.equal(await creating, null);
  assert.equal(count(/\/turns$/, 'POST'), 0);
  assert.equal(chat.current, null);
  assert.equal(chat.input, 'A genuinely new task');
  assert.equal(chat.draftAttachments[0].content, 'Never clear this');
  passed(
    'a late create response cannot submit old text, clear the newer draft, or attach an obsolete session',
  );

  reset();
  await chat.open(11);
  chat.input = 'Accepted after navigating home';
  turnGate = deferred();
  const submitting = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  const pendingId = chat.current.id;
  chat.prepareStart();
  chat.input = 'Another independent home task';
  chat.draftAttachments.push({ name: 'later.txt', content: 'Keep the newer file' });
  turnGate.resolve();
  assert.equal(await submitting, null);
  assert.equal(chat.current, null);
  assert.equal(chat.messages.length, 0);
  assert.equal(chat.input, 'Another independent home task');
  assert.equal(chat.draftAttachments[0].content, 'Keep the newer file');
  assert.equal(chat.drafts[`session:${pendingId}`], undefined);
  assert.equal(database.get(pendingId).status, 'running');
  assert.equal(count(/interrupt/, 'POST'), 0);
  passed(
    'late accepted turns consume only their own snapshot; returning home cannot stop execution or populate the newer task',
  );

  reset();
  chat.input = 'First accepted task';
  chat.draftAttachments.push({ name: 'source.txt', content: 'Actual submitted material' });
  const acceptedId = await chat.submit();
  assert.equal(chat.current.id, acceptedId);
  assert.equal(chat.current.status, 'running');
  assert.equal(chat.messages.length, 1);
  assert.match(chat.messages[0].content, /Actual submitted material/);
  assert.equal(chat.input, '');
  assert.deepEqual(chat.draftAttachments, []);
  assert.equal(chat.draftKey, `session:${acceptedId}`);
  assert.equal(chat.hasUnsentDrafts, false);
  chat.prepareStart();
  assert.equal(chat.input, '');
  assert.equal(chat.hasUnsentDrafts, false);
  passed(
    'first acceptance locks the actual session, records the user message and consumes its start text/files exactly once',
  );

  reset();
  chat.input = 'Retry after a rejected turn';
  chat.draftAttachments.push({ name: 'retry.txt', content: 'Must survive' });
  failTurn = true;
  await assert.rejects(chat.submit(), /Unit fixture request failed/);
  assert.equal(chat.input, 'Retry after a rejected turn');
  assert.equal(chat.draftAttachments[0].content, 'Must survive');
  assert.equal(chat.sending, false);
  assert.equal(chat.current, null);
  assert.equal(chat.draftKey, 'new');
  chat.prepareStart();
  assert.equal(chat.input, 'Retry after a rejected turn');
  assert.equal(chat.draftAttachments[0].content, 'Must survive');
  const retryId = await chat.submit();
  assert.equal(count(/^\/api\/agent\/sessions$/, 'POST'), 1);
  assert.equal(chat.current.id, retryId);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.input, '');
  passed(
    'failed turn submission retains text/files and retries the same created session without duplicating it',
  );

  reset();
  chat.input = 'Show me right away';
  chat.draftAttachments.push({ name: 'notes.txt', content: 'Attached' });
  createGate = deferred();
  const optimistic = chat.submit();
  // 发送的同一刻：消息已在对话里显示，输入框已清空，但会话尚未出现
  assert.equal(chat.outgoing.failed, false);
  assert.match(chat.outgoing.content, /^Show me right away\n\n附件：notes.txt/);
  assert.equal(chat.input, '');
  assert.deepEqual(chat.draftAttachments, []);
  assert.equal(chat.current, null);
  assert.equal(chat.messages.length, 0);
  assert.equal(chat.hasUnsentDrafts, true);
  assert.equal(chat.requestNewConversation(), false); // the in-flight text still counts as the draft
  chat.pendingNewConversation = null;
  chat.prepareStart(); // entering the chat page without an id keeps the pending message
  assert.equal(chat.outgoing.content.startsWith('Show me right away'), true);
  createGate.resolve();
  const optimisticId = await optimistic;
  assert.equal(chat.outgoing, null);
  assert.equal(chat.current.id, optimisticId);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.input, '');
  passed('a sent message is shown immediately and replaced by the accepted message on receipt');

  reset();
  chat.input = 'Fails before acceptance';
  chat.draftAttachments.push({ name: 'keep.txt', content: 'Keep me' });
  turnGate = deferred();
  failTurn = true;
  const failing = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  assert.equal(chat.input, '');
  turnGate.resolve();
  await assert.rejects(failing, /Unit fixture request failed/);
  assert.equal(chat.outgoing.failed, true);
  assert.equal(chat.input, 'Fails before acceptance');
  assert.equal(chat.draftAttachments[0].content, 'Keep me');
  assert.equal(chat.hasUnsentDrafts, true);
  const resent = await chat.submit();
  assert.equal(chat.outgoing, null); // retrying replaces the failed message
  assert.equal(chat.current.id, resent);
  assert.equal(chat.messages.length, 1);
  passed('a failed send is marked as failed and puts the text and files back into the composer');

  reset();
  chat.input = 'Leave while sending';
  turnGate = deferred();
  failTurn = true;
  const leaving = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  chat.prepareStart();
  await chat.open(11);
  assert.equal(chat.outgoing, null);
  chat.prepareStart();
  assert.equal(chat.input, 'Leave while sending'); // the parked draft keeps the in-flight text
  turnGate.resolve();
  await assert.rejects(leaving, /Unit fixture request failed/);
  assert.equal(chat.outgoing, null); // a failure after leaving does not touch the new view
  assert.equal(chat.input, 'Leave while sending');
  passed('leaving during a send parks the text as the draft and a later failure does not touch the new view');

  reset();
  chat.input = 'First turn with a pending replacement dialog';
  turnGate = deferred();
  const firstTurn = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  assert.equal(chat.current, null);
  assert.equal(chat.draftKey, 'new');
  assert.equal(chat.requestNewConversation(), false);
  turnGate.resolve();
  assert.equal(typeof (await firstTurn), 'number');
  assert.equal(chat.pendingNewConversation, null);
  assert.equal(chat.hasUnsentDrafts, false);
  passed(
    'a first turn becomes visible only at acceptance and retires a now-obsolete replacement dialog for that exact submitted draft',
  );

  reset();
  chat.input = 'First turn accepted after explicit new-task discard';
  turnGate = deferred();
  const discardedSubmit = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  assert.equal(chat.requestNewConversation(), false);
  chat.newConversation();
  chat.input = 'Do not consume the replacement task';
  chat.draftAttachments.push({ name: 'replacement.txt', content: 'Replacement material' });
  turnGate.resolve();
  assert.equal(await discardedSubmit, null);
  assert.equal(chat.current, null);
  assert.equal(chat.input, 'Do not consume the replacement task');
  assert.equal(chat.draftAttachments[0].content, 'Replacement material');
  passed('a late first-turn acceptance cannot clear or redirect a separately confirmed new-task draft');

  reset();
  chat.input = 'In-flight start draft';
  turnGate = deferred();
  const originalSubmit = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  await chat.open(11);
  chat.prepareStart();
  chat.input = 'Edited while the older request is pending';
  chat.selectScenario(2);
  await assert.rejects(chat.submit(), /仍在提交/);
  assert.equal(count(/^\/api\/agent\/sessions$/, 'POST'), 1);
  assert.equal(count(/\/turns$/, 'POST'), 1);
  turnGate.resolve();
  assert.equal(await originalSubmit, null);
  assert.equal(chat.current, null);
  assert.equal(chat.input, 'Edited while the older request is pending');
  assert.equal(chat.selectedScenarioId, 2);
  passed(
    'revisiting and editing an in-flight draft cannot double-send it or allow the old acknowledgement to consume its changed content/scenario',
  );

  reset();
  await chat.open(11);
  chat.input = 'Turn accepted during same-session reopen';
  turnGate = deferred();
  const pendingSubmit = chat.submit();
  await until(() => count(/\/turns$/, 'POST') === 1);
  const readsBefore = count(/^\/api\/agent\/sessions\/11$/);
  const reopening = chat.open(11);
  assert.equal(chat.loading, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count(/^\/api\/agent\/sessions\/11$/), readsBefore);
  turnGate.resolve();
  assert.equal(await pendingSubmit, null);
  await reopening;
  assert.equal(chat.current.id, 11);
  assert.equal(chat.current.status, 'running');
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.input, '');
  assert.equal(chat.hasUnsentDrafts, false);
  passed('same-session reopen waits for its pending turn before restoring the database snapshot and SSE');

  reset();
  chat.input = 'Auth-bound draft';
  await chat.open(11);
  chat.input = 'Private parked reply';
  chat.prepareStart();
  assert.equal(chat.hasUnsentDrafts, true);
  chat.clear();
  assert.equal(chat.input, '');
  assert.deepEqual(chat.draftAttachments, []);
  assert.deepEqual(chat.drafts, {});
  assert.equal(chat.hasUnsentDrafts, false);
  await chat.open(11);
  assert.equal(chat.input, '');
  passed(
    'auth-boundary clear purges active and parked text/files, preview state and replacement dialogs from tab memory',
  );

  reset();
  assert.equal(chat.selectedModelId, 7);
  assert.equal(chat.selectModel(99), false);
  assert.equal(chat.selectModel(8), true);
  chat.input = 'Use the reasoning model';
  chat.prepareStart();
  assert.equal(chat.selectedModelId, 8);
  const chosenId = await chat.submit();
  const created = calls.find((call) => call.method === 'POST' && call.url === '/api/agent/sessions');
  assert.deepEqual(created.body, { scenarioId: 1, modelId: 8 });
  assert.equal(chat.current.modelId, 8);
  assert.equal(chat.selectModel(7), false);
  assert.equal(chat.selectedModelId, 8);
  assert.equal(database.get(chosenId).modelId, 8);
  chat.newConversation();
  assert.equal(chat.selectedModelId, 8);
  passed(
    'new-session model is chosen per draft, sent with the create request, frozen while its first turn runs and remembered for the next task',
  );

  reset();
  chat.selectModel(8);
  chat.input = 'Model removed before sending';
  app.modelOptions = [modelOption(7, true)];
  chat.syncModel();
  assert.equal(chat.selectedModelId, 7);
  app.modelOptions = [modelOption(8)];
  app.defaultModelId = 8;
  await chat.submit();
  assert.deepEqual(calls.find((call) => call.method === 'POST' && call.url === '/api/agent/sessions').body, {
    scenarioId: 1,
    modelId: 8,
  });
  reset();
  app.modelOptions = [];
  app.defaultModelId = null;
  chat.syncModel();
  chat.input = 'No model available';
  await assert.rejects(chat.submit(), /没有可用的模型/);
  assert.equal(count(/^\/api\/agent\/sessions$/, 'POST'), 0);
  assert.equal(chat.input, 'No model available');
  passed(
    'disabled or deleted models fall back to the platform default, and no model blocks creation without losing the draft',
  );

  reset();
  chat.input = 'Retry with another model';
  failTurn = true;
  await assert.rejects(chat.submit(), /Unit fixture request failed/);
  assert.equal(count(/^\/api\/agent\/sessions$/, 'POST'), 1);
  chat.selectModel(8);
  await chat.submit();
  const creates = calls.filter((call) => call.method === 'POST' && call.url === '/api/agent/sessions');
  assert.deepEqual(
    creates.map((call) => call.body.modelId),
    [7, 8],
  );
  passed(
    'a prepared session is reused only for the same scenario and model; changing the model creates a fresh session',
  );

  reset();
  await chat.open(11);
  assert.equal(chat.selectedModelId, 7);
  chat.input = 'Same model reply';
  await chat.submit();
  const sameTurn = calls.find((call) => call.method === 'POST' && call.url.endsWith('/turns'));
  assert.deepEqual(sameTurn.body, { message: 'Same model reply' });
  assert.equal(chat.selectModel(8), false); // running: the model only changes between turns
  database.get(11).status = 'idle';
  await chat.open(11);
  assert.equal(chat.selectModel(99), false);
  assert.equal(chat.selectModel(8), true);
  chat.input = 'Continue with the second model';
  await chat.submit();
  const switchTurn = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/turns')).at(-1);
  assert.deepEqual(switchTurn.body, { message: 'Continue with the second model', modelId: 8 });
  assert.equal(chat.current.modelId, 8);
  assert.equal(chat.current.modelName, 'Model 8');
  assert.equal(chat.selectedModelId, 8);
  assert.equal(chat.messages.at(-1).meta.modelSwitch.to.name, 'Model 8');
  assert.equal(count(/^\/api\/agent\/sessions$/, 'POST'), 0);
  passed(
    'an existing session switches model only between turns: same-model turns send no modelId, a switch rides on the next turn and updates the session',
  );

  reset();
  await chat.open(11);
  assert.equal(chat.selectModel(8), true);
  await chat.open(12);
  assert.equal(chat.selectedModelId, 7);
  await chat.open(11);
  assert.equal(chat.selectedModelId, 8);
  assert.equal(chat.hasUnsentDrafts, false);
  assert.equal(chat.selectModel(7), true); // choosing the current model cancels the pending switch
  await chat.open(12);
  await chat.open(11);
  assert.equal(chat.selectedModelId, 7);
  assert.equal(chat.drafts['session:11'], undefined);
  passed(
    'a pending switch is kept per session without text, never counts as unsent work, and can be cancelled',
  );

  reset();
  app.modelOptions = [modelOption(8, true)];
  app.defaultModelId = 8;
  await chat.open(11);
  assert.equal(chat.selectedModelId, 7); // disabled current model keeps working until the user switches
  chat.input = 'Keep the disabled current model';
  await chat.submit();
  assert.deepEqual(calls.filter((call) => call.url.endsWith('/turns')).at(-1).body, {
    message: 'Keep the disabled current model',
  });
  database.get(11).status = 'idle';
  await chat.open(11);
  assert.equal(chat.selectModel(8), true);
  assert.equal(chat.selectModel(7), true);
  app.modelOptions = [modelOption(7, true)];
  chat.selectModel(7);
  chat.selectedModelId = 8; // a pending target that was disabled meanwhile
  chat.syncModel();
  assert.equal(chat.selectedModelId, 7);
  passed(
    'a disabled current model can continue or be kept explicitly; a pending target that disappears falls back to no switch',
  );

  reset();
  const turnBody = () => calls.filter((call) => call.url.endsWith('/turns')).at(-1).body;
  assert.deepEqual(chat.codeProjects, []);
  assert.deepEqual(chat.setCodeProjects(['alpha', 'beta', 'alpha']), ['alpha', 'beta']);
  assert.deepEqual(chat.codeProjects, ['alpha', 'beta']);
  await chat.open(11);
  assert.deepEqual(chat.codeProjects, []); // an existing session starts from its own applied selection
  chat.prepareStart();
  assert.deepEqual(chat.codeProjects, ['alpha', 'beta']); // the start draft keeps its selection
  chat.input = 'Analyse both repositories';
  await chat.submit();
  assert.deepEqual(turnBody(), { message: 'Analyse both repositories', codeProjects: ['alpha', 'beta'] });
  assert.deepEqual(chat.current.codeProjects, ['alpha', 'beta']);
  assert.deepEqual(chat.codeProjects, ['alpha', 'beta']); // after sending, the selection is the applied one
  assert.equal(chat.codePending, false);
  assert.deepEqual(chat.messages.at(-1).meta.codeProjects, ['alpha', 'beta']);
  chat.prepareStart();
  assert.deepEqual(chat.codeProjects, []); // a consumed draft does not leak into the next new task
  passed('a new task carries its code selection in the first turn, survives navigation and is then consumed');

  reset();
  database.get(11).codeProjects = ['alpha'];
  database.get(11).status = 'running';
  await chat.open(11);
  assert.deepEqual(chat.codeProjects, ['alpha']);
  assert.equal(chat.codePending, false);
  // running: choosing still works; it only changes the composer and rides on the next message
  assert.deepEqual(chat.setCodeProjects(['beta']), ['beta']);
  assert.equal(chat.codePending, true);
  assert.deepEqual(chat.current.codeProjects, ['alpha']); // nothing is saved before sending
  assert.equal(chat.hasUnsentDrafts, false); // like a pending model switch, never counts as unsent work
  await chat.open(12);
  database.get(11).status = 'idle';
  await chat.open(11);
  assert.deepEqual(chat.codeProjects, ['beta']); // the pending change survives switching conversations
  chat.input = 'Next turn';
  await chat.submit();
  assert.deepEqual(turnBody(), { message: 'Next turn', codeProjects: ['beta'] });
  assert.equal(chat.codePending, false);
  assert.deepEqual(chat.messages.at(-1).meta.codeProjects, ['beta']);
  database.get(11).status = 'idle';
  await chat.open(11);
  chat.input = 'Unchanged';
  await chat.submit();
  assert.deepEqual(turnBody(), { message: 'Unchanged' }); // unchanged selections are not resent
  database.get(11).status = 'idle';
  await chat.open(11);
  chat.setCodeProjects([]);
  chat.input = 'No code';
  await chat.submit();
  assert.deepEqual(turnBody(), { message: 'No code', codeProjects: [] }); // clearing is explicit
  assert.equal(count(/./, 'PUT'), 0); // there is no separate save request
  passed('an existing session sends code changes with the next message only, even if chosen while running');

  reset();
  await chat.open(11);
  chat.setCodeProjects(['beta']);
  chat.input = 'Rejected turn';
  failTurn = true;
  await assert.rejects(chat.submit());
  assert.equal(chat.input, 'Rejected turn');
  assert.deepEqual(chat.codeProjects, ['beta']); // a rejected turn keeps the text and the selection
  assert.equal(chat.codePending, true);
  assert.deepEqual(chat.current.codeProjects ?? [], []);
  passed('a rejected turn keeps both the message and the pending selection for a retry');

  reset();
  const noCaps = { skillIds: [], mcpServerIds: [], webSearch: false };
  assert.deepEqual(chat.capabilityChoice, noCaps);
  chat.setCapabilities({ skillIds: [3, 4, 3], mcpServerIds: [9], webSearch: true });
  assert.deepEqual(chat.capabilityChoice, { skillIds: [3, 4], mcpServerIds: [9], webSearch: true });
  await chat.open(11);
  assert.deepEqual(chat.capabilityChoice, noCaps); // an existing session shows its own selection
  chat.prepareStart();
  assert.deepEqual(chat.capabilityChoice.skillIds, [3, 4]); // the start draft keeps its selection
  chat.input = 'Search the web with two skills';
  await chat.submit();
  assert.deepEqual(turnBody(), {
    message: 'Search the web with two skills',
    capabilities: { skillIds: [3, 4], mcpServerIds: [9], webSearch: true },
  });
  assert.deepEqual(chat.current.capabilities, { skillIds: [3, 4], mcpServerIds: [9], webSearch: true });
  assert.equal(chat.capabilitiesPending, false);
  chat.prepareStart();
  assert.deepEqual(chat.capabilityChoice, noCaps); // a consumed draft does not leak into the next task
  chat.input = 'Plain task';
  await chat.submit();
  assert.deepEqual(turnBody(), { message: 'Plain task' }); // an empty selection is not sent at all
  passed(
    'a new task carries its capability selection in the first turn only, and the draft is then consumed',
  );

  reset();
  database.get(11).capabilities = { skillIds: [5], mcpServerIds: [], webSearch: true };
  await chat.open(11);
  assert.deepEqual(chat.capabilityChoice, { skillIds: [5], mcpServerIds: [], webSearch: true });
  assert.equal(chat.capabilitiesPending, false);
  chat.setCapabilities({ skillIds: [5, 6], mcpServerIds: [], webSearch: false });
  assert.equal(chat.capabilitiesPending, true);
  chat.setCapabilities({ skillIds: [5], mcpServerIds: [], webSearch: true });
  assert.equal(chat.capabilitiesPending, false); // choosing back cancels the pending change
  database.get(11).codeProjects = ['alpha', 'beta'];
  await chat.open(12);
  await chat.open(11);
  chat.setCodeProjects(['beta', 'alpha']);
  assert.equal(chat.codePending, false); // order alone is not a change
  chat.setCapabilities({ skillIds: [], mcpServerIds: [], webSearch: true });
  chat.input = 'Drop the skill';
  await chat.submit();
  assert.deepEqual(turnBody(), {
    message: 'Drop the skill',
    capabilities: { skillIds: [], mcpServerIds: [], webSearch: true },
  });
  assert.deepEqual(chat.current.capabilities.skillIds, []);
  assert.equal(chat.capabilitiesPending, false);
  assert.equal(count(/./, 'PUT'), 0);
  passed('an existing session sends capability changes with the next message; choosing back cancels them');

  console.log(
    JSON.stringify({
      result: 'passed',
      checks: checks.length,
      scope: 'real store, stubbed HTTP; not auth/API/model or employee-isolation acceptance',
    }),
  );
} finally {
  chat?.clear();
  globalThis.fetch = realFetch;
  if (realLocalStorage) Object.defineProperty(globalThis, 'localStorage', realLocalStorage);
  else delete globalThis.localStorage;
  await vite.close();
}
