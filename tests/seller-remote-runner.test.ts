import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ExternalAwareRunner } from '../src/seller/remote-runner';
import { buildContainerMetaMap, validateContainerEntries } from '../src/seller';
import type { ContainerMeta, ContainerRunner } from '../src/seller/deps';

vi.mock('axios');
const mockedPost = vi.mocked(axios.post);

const localMeta: ContainerMeta = { id: 'hf-a', name: 'hf-a', image: 'img', tag: 'latest', port: '8091' };
const externalMeta: ContainerMeta = { id: 'hf-stt', name: 'hf-stt', externalUrl: 'http://100.104.167.100:8095' };

const makeLocal = () => {
  const runContainer = vi.fn().mockResolvedValue({ output: 'local-out' });
  return { runner: { runContainer } as ContainerRunner, runContainer };
};

beforeEach(() => {
  mockedPost.mockReset();
});

describe('ExternalAwareRunner — delegation', () => {
  it('delegates containers without externalUrl to the local runner untouched', async () => {
    const { runner: local, runContainer } = makeLocal();
    const runner = new ExternalAwareRunner(local);
    const res = await runner.runContainer(localMeta, '{"text":"hi"}', 12345);
    expect(res.output).toBe('local-out');
    expect(runContainer).toHaveBeenCalledWith(localMeta, '{"text":"hi"}', 12345);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

describe('ExternalAwareRunner — external HTTP call', () => {
  it('POSTs to <externalUrl>/computation with the agent-core body shape', async () => {
    mockedPost.mockResolvedValue({ data: { output: { text: 'hello' } } });
    const { runner: local, runContainer } = makeLocal();
    const runner = new ExternalAwareRunner(local);
    const res = await runner.runContainer(externalMeta, '{"audio_b64":"QUJD"}', 60000);
    expect(runContainer).not.toHaveBeenCalled();
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe('http://100.104.167.100:8095/computation');
    expect(body).toEqual({ input: '{"audio_b64":"QUJD"}', audio_b64: 'QUJD' });
    expect(opts).toMatchObject({ timeout: 60000 });
    expect(res.output).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('strips trailing slashes from externalUrl', async () => {
    mockedPost.mockResolvedValue({ data: 'plain' });
    const runner = new ExternalAwareRunner(makeLocal().runner);
    const res = await runner.runContainer({ ...externalMeta, externalUrl: 'http://host:8095///' }, 'x');
    expect(mockedPost.mock.calls[0][0]).toBe('http://host:8095/computation');
    expect(res.output).toBe('plain');
  });

  it('wraps non-JSON input as { input } only', async () => {
    mockedPost.mockResolvedValue({ data: { ok: true } });
    const runner = new ExternalAwareRunner(makeLocal().runner);
    const res = await runner.runContainer(externalMeta, 'not-json');
    expect(mockedPost.mock.calls[0][1]).toEqual({ input: 'not-json' });
    expect(res.output).toBe(JSON.stringify({ ok: true })); // no output field → whole body
  });

  it('passes string output through unchanged', async () => {
    mockedPost.mockResolvedValue({ data: { output: 'already-a-string' } });
    const runner = new ExternalAwareRunner(makeLocal().runner);
    const res = await runner.runContainer(externalMeta, '{}');
    expect(res.output).toBe('already-a-string');
  });
});

describe('ExternalAwareRunner — retries & errors', () => {
  it('retries ECONNREFUSED then succeeds', async () => {
    mockedPost
      .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
      .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
      .mockResolvedValue({ data: { output: 'up' } });
    const runner = new ExternalAwareRunner(makeLocal().runner, { connectionRetryDelayMs: 1 });
    const res = await runner.runContainer(externalMeta, '{}');
    expect(res.output).toBe('up');
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it('gives up after exhausting ECONNREFUSED retries with a clear error', async () => {
    mockedPost.mockRejectedValue({ code: 'ECONNREFUSED' });
    const runner = new ExternalAwareRunner(makeLocal().runner, { connectionRetries: 2, connectionRetryDelayMs: 1 });
    await expect(runner.runContainer(externalMeta, '{}')).rejects.toThrow(
      /Cannot connect to external container at http:\/\/100\.104\.167\.100:8095\/computation after 2 attempts/,
    );
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it('does not retry HTTP errors and surfaces status + body', async () => {
    mockedPost.mockRejectedValue({ response: { status: 500, data: { error: 'boom' } } });
    const runner = new ExternalAwareRunner(makeLocal().runner, { connectionRetryDelayMs: 1 });
    await expect(runner.runContainer(externalMeta, '{}')).rejects.toThrow('Container HTTP error 500: {"error":"boom"}');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('maps timeout codes to a timeout error', async () => {
    mockedPost.mockRejectedValue({ code: 'ECONNABORTED' });
    const runner = new ExternalAwareRunner(makeLocal().runner);
    await expect(runner.runContainer(externalMeta, '{}', 5000)).rejects.toThrow('Container execution timeout after 5000ms');
  });

  it('rethrows unknown errors without retrying', async () => {
    const weird = Object.assign(new Error('dns down'), { code: 'ENOTFOUND' });
    mockedPost.mockRejectedValue(weird);
    const runner = new ExternalAwareRunner(makeLocal().runner);
    await expect(runner.runContainer(externalMeta, '{}')).rejects.toThrow('dns down');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });
});

describe('buildContainerMetaMap — external entries', () => {
  it('maps externalUrl entries without image/port', () => {
    const map = buildContainerMetaMap([
      { id: 'hf-stt', name: 'hf-stt-remote', externalUrl: 'http://100.1.2.3:8095' },
      { id: 'hf-a', image: 'img:v1', port: '8091' },
    ]);
    expect(map.get('hf-stt')).toEqual({ id: 'hf-stt', name: 'hf-stt-remote', externalUrl: 'http://100.1.2.3:8095' });
    expect(map.get('hf-a')).toMatchObject({ image: 'img', tag: 'v1', port: '8091' });
  });

  it('skips invalid entries (both or neither of image/externalUrl)', () => {
    const map = buildContainerMetaMap([
      { id: 'both', image: 'img', externalUrl: 'http://h:1' },
      { id: 'neither' },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('validateContainerEntries', () => {
  it('accepts valid local and external entries', () => {
    expect(validateContainerEntries([
      { id: 'a', image: 'img:v1', port: '8091' },
      { id: 'b', externalUrl: 'http://100.1.2.3:8095' },
      { id: 'c', externalUrl: 'https://compute.example.com' },
    ])).toEqual([]);
  });

  it('rejects image+externalUrl together', () => {
    const errs = validateContainerEntries([{ id: 'x', image: 'img', externalUrl: 'http://h:1' }]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('mutually exclusive');
  });

  it('rejects non-http(s) externalUrl', () => {
    const errs = validateContainerEntries([{ id: 'x', externalUrl: 'tcp://h:1' }]);
    expect(errs[0]).toContain('must be an http(s) URL');
  });

  it('rejects entries with neither image nor externalUrl', () => {
    const errs = validateContainerEntries([{ id: 'x' }]);
    expect(errs[0]).toContain('either "image" or "externalUrl" is required');
  });
});
