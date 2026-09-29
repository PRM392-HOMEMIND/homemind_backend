import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiPlanner } from '../src/assistant/planner';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('AI provider lifecycle: mocked transport only', () => {
  function transport() {
    vi.stubEnv('GEMINI_API_KEY', 'mock-provider-never-sent-to-network');
    vi.stubEnv('DATABASE_URL', 'postgresql://homemind_app:fixture@127.0.0.1:5432/homemind');
    vi.stubEnv('AUTH_ACCESS_SECRET', 'test_access_secret_longer_than_32_characters_123456');
    vi.stubEnv('AUTH_REFRESH_SECRET', 'test_refresh_secret_longer_than_32_characters_123456');
    vi.stubEnv('AUTH_RESET_SECRET', 'test_reset_secret_longer_than_32_characters_123456');
    let entered!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const signal = options!.signal!;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    });
    return { planner: new AiPlanner(), ready, fetch };
  }
  it('requests the bounded18s deadline and reports504 on its expiration', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const { planner, ready, fetch } = transport();
    const pending = planner.plan('Trong nhà còn gì?', [], '2026-10-13');
    const result = expect(pending).rejects.toMatchObject({ status: 504 });
    await ready;
    deadline.abort(new DOMException('Controlled deadline', 'TimeoutError'));
    await result;
    expect(timeout).toHaveBeenCalledWith(18000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('propagates caller cancellation independently of the provider deadline', async () => {
    const deadline = new AbortController(), caller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const { planner, ready } = transport();
    const pending = planner.plan('Trong nhà còn gì?', [], '2026-10-13', caller.signal);
    const result = expect(pending).rejects.toMatchObject({ status: 408, response: { code: 'REQUEST_CANCELLED' } });
    await ready;
    caller.abort();
    await result;
    expect(deadline.signal.aborted).toBe(false);
  });
  it('supports openai_compatible provider with custom base url and returns parsed plan', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai_compatible');
    vi.stubEnv('AI_BASE_URL', 'http://127.0.0.1:11434/v1');
    vi.stubEnv('AI_MODEL', 'qwen2.5:7b');
    vi.stubEnv('DATABASE_URL', 'postgresql://homemind_app:fixture@127.0.0.1:5432/homemind');
    vi.stubEnv('AUTH_ACCESS_SECRET', 'test_access_secret_longer_than_32_characters_123456');
    vi.stubEnv('AUTH_REFRESH_SECRET', 'test_refresh_secret_longer_than_32_characters_123456');
    vi.stubEnv('AUTH_RESET_SECRET', 'test_reset_secret_longer_than_32_characters_123456');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _options) => {
      expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"toolId": "inventory.list", "arguments": {}}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const planner = new AiPlanner();
    const plan = await planner.plan('Trong nhà còn gì?', [], '2026-11-04');
    expect(plan.toolId).toBe('inventory.list');
    expect(plan.arguments).toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
