package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestLoadingStreamClient(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("loading stream client tests require Node:", err)
	}
	for _, name := range []string{
		"single_request_utf8_splits", "progressive_partial_frames", "terminal_without_eof",
		"callback_controls_completion", "invalid_frames", "frame_size_bounds", "response_validation",
		"early_eof", "transport_rejections", "pagehide", "explicit_cancel", "late_headers",
		"fixed_deadline", "cancellation_errors", "callback_errors", "real_readable_stream",
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, node, "--unhandled-rejections=strict", "-e", loadingClientNodeTests, name)
			command.Stdin = strings.NewReader(loadingStreamClient)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("Node client test failed: %v\n%s", err, output)
			}
		})
	}
}

// 在独立 VM 内执行真实常量，控制网络分块与时钟；严格拒绝未处理的 Promise rejection。
const loadingClientNodeTests = `
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(0, 'utf8');
const encoder = new TextEncoder();
const encode = text => encoder.encode(text);
const line = value => JSON.stringify(value) + '\n';
const ready = line({ state: 'ready' });
const starting = line({ state: 'starting' });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  const h = {
    requests: [], states: [], failures: 0, reads: 0, readers: 0, cancels: 0,
    warnings: [], errors: [], timers: new Map(), listeners: new Map(), timerDelays: [],
    now: 0, cleared: 0, headers: deferred()
  };
  const queued = [];
  let pending;
  function deliver(item) {
    if (pending) {
      const active = pending;
      pending = undefined;
      item.error ? active.reject(item.error) : active.resolve(item.result);
    } else queued.push(item);
  }
  const controlledReader = {
    read() {
      const item = queued.shift();
      if (item) return item.error ? Promise.reject(item.error) : Promise.resolve(item.result);
      assert.equal(pending, undefined, 'only one outstanding read');
      pending = deferred();
      return pending.promise;
    },
    cancel() {
      if (options.cancelMode === 'throw') throw new Error('cancel threw');
      if (options.cancelMode === 'reject') return Promise.reject(new Error('cancel rejected'));
      if (options.cancelMode === 'hang') return new Promise(() => {});
      return Promise.resolve();
    }
  };
  h.push = value => deliver({ result: { done: false, value } });
  h.eof = () => deliver({ result: { done: true } });
  h.rejectRead = () => deliver({ error: new Error('read failed') });
  let stream;
  if (options.realStream) {
    stream = new ReadableStream({ start(controller) {
      h.push = value => controller.enqueue(value);
      h.eof = () => controller.close();
    } });
  }
  h.response = {
    status: options.status ?? 200,
    headers: { get(name) {
      assert.equal(name.toLowerCase(), 'content-type');
      return options.contentType === undefined ? 'application/x-ndjson; charset=utf-8' : options.contentType;
    } },
    body: options.noBody ? null : { getReader() {
      h.readers++;
      if (options.readerError) throw new Error('reader unavailable');
      const active = stream ? stream.getReader() : controlledReader;
      return {
        read() { h.reads++; return active.read(); },
        cancel() { h.cancels++; return active.cancel(); }
      };
    } }
  };
  const window = {
    addEventListener(name, callback, config) {
      assert.equal(name, 'pagehide');
      assert.equal(config.once, true);
      h.listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      assert.equal(h.listeners.get(name), callback);
      h.listeners.delete(name);
    }
  };
  h.hide = () => h.listeners.get('pagehide')?.();
  h.advance = elapsed => {
    const target = h.now + elapsed;
    for (;;) {
      const next = [...h.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      h.now = next[1].at;
      h.timers.delete(next[0]);
      next[1].callback();
    }
    h.now = target;
  };
  let timerID = 0;
  const context = vm.createContext({
    AbortController, TextDecoder, Uint8Array, window,
    location: { pathname: '/random-capability' },
    console: {
      warn: (...args) => h.warnings.push(args),
      error: (...args) => h.errors.push(args)
    },
    setTimeout(callback, delay) {
      h.timerDelays.push(delay);
      const id = ++timerID;
      h.timers.set(id, { callback, at: h.now + delay });
      return id;
    },
    clearTimeout(id) { h.cleared++; h.timers.delete(id); },
    fetch(url, config) {
      h.requests.push({ url, config });
      if (options.fetchMode === 'throw') throw new Error('fetch threw');
      if (options.fetchMode === 'reject') return Promise.reject(new Error('fetch rejected'));
      return options.fetchMode === 'pending' ? h.headers.promise : Promise.resolve(h.response);
    },
    onState(value) {
      h.states.push(JSON.parse(JSON.stringify(value)));
      return options.onState ? options.onState(value) : value.state !== 'starting';
    },
    onFailure() { h.failures++; options.onFailure?.(); }
  });
  h.cancel = vm.runInContext('(() => {' + source + '\nreturn consumeLoadingStream(onState, onFailure); })()', context);
  assert.equal(typeof h.cancel, 'function');
  assert.equal(h.requests.length, 1, 'fetch must start synchronously and only once');
  return h;
}
function stopped(h, failures = 0) {
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].config.signal.aborted, true);
  assert.equal(h.failures, failures);
  assert.equal(h.timers.size, 0, 'deadline must be cleared');
  assert.equal(h.listeners.size, 0, 'pagehide listener must be removed');
  assert.equal(h.cleared, 1, 'cleanup must be idempotent');
  assert.deepEqual(h.timerDelays, [155000], 'one total deadline, no polling or header-wide 3s abort');
}
async function failsAfter(parts, eof = false, options = {}) {
  const h = harness(options);
  for (const part of parts) h.push(typeof part === 'string' ? encode(part) : part);
  if (eof) h.eof();
  await settle();
  stopped(h, 1);
  h.advance(200000);
  h.hide();
  h.cancel();
  stopped(h, 1);
  return h;
}
const tests = {
  async single_request_utf8_splits() {
    const h = harness();
    const first = { state: 'starting', phase: '正在启动 dsh 中文😀' };
    const data = encode(line(first) + starting + ready);
    for (const byte of data) h.push(Uint8Array.of(byte));
    await settle();
    assert.deepEqual(h.states, [first, { state: 'starting' }, { state: 'ready' }]);
    const { url, config } = h.requests[0];
    assert.equal(url, '/random-capability/events');
    assert.deepEqual(JSON.parse(JSON.stringify(config)), {
      mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/x-ndjson' }, signal: {}
    });
    assert.equal(h.readers, 1);
    assert.equal(h.reads, data.length);
    assert.equal(h.cancels, 1);
    stopped(h);
  },
  async progressive_partial_frames() {
    const h = harness();
    const second = encode(line({ state: 'starting', phase: '准备😀' }).replace('\n', '\r\n'));
    const cut = second.indexOf(0xf0) + 2;
    h.push(encode(starting));
    h.push(second.subarray(0, cut));
    await settle();
    assert.equal(h.states.length, 1);
    h.push(second.subarray(cut, second.length - 1));
    await settle();
    assert.equal(h.states.length, 1, 'partial line must not be delivered');
    h.push(second.subarray(second.length - 1));
    await settle();
    assert.deepEqual(h.states[1], { state: 'starting', phase: '准备😀' });
    h.push(encode(ready));
    await settle();
    stopped(h);
  },
  async terminal_without_eof() {
    for (const state of ['ready', 'failed']) {
      const h = harness({ cancelMode: 'hang' });
      const terminal = encode(line({ state }));
      const bytes = new Uint8Array(terminal.length + 20000);
      bytes.set(terminal);
      bytes.fill(0xff, terminal.length);
      h.push(bytes);
      await settle();
      assert.deepEqual(h.states, [{ state }]);
      assert.equal(h.reads, 1, 'must not await another read or parse terminal suffix');
      assert.equal(h.cancels, 1);
      stopped(h);
      h.advance(200000);
      h.cancel();
      stopped(h);
    }
  },
  async callback_controls_completion() {
    const h = harness({ onState: () => true });
    h.push(encode(starting + ready));
    await settle();
    assert.deepEqual(h.states, [{ state: 'starting' }]);
    stopped(h);
    const continuing = harness({ onState: value => value.state === 'failed' });
    continuing.push(encode(ready));
    await settle();
    assert.equal(continuing.requests[0].config.signal.aborted, false);
    continuing.push(encode(line({ state: 'failed' })));
    await settle();
    assert.equal(continuing.states.length, 2);
    stopped(continuing);
  },
  async invalid_frames() {
    for (const frame of [
      '{\n', '\n', ' \r\n', 'null\n', '[]\n', 'true\n', '42\n', '"ready"\n',
      '{}\n', '{"state":null}\n', '{"state":"unknown"}\n', '\ufeff' + ready,
      Uint8Array.of(0xff, 10), Uint8Array.of(0xc3, 10), Uint8Array.of(0xc0, 0xaf, 10),
      { invalid: 'not bytes' }
    ]) {
      const h = await failsAfter([frame]);
      assert.equal(h.states.length, 0);
    }
    const h = await failsAfter([starting + '{broken}\n' + ready]);
    assert.deepEqual(h.states, [{ state: 'starting' }]);
  },
  async frame_size_bounds() {
    const padding = 8192 - encode(line({ state: 'starting', detail: '' })).length;
    const exact = line({ state: 'starting', detail: 'x'.repeat(padding) });
    assert.equal(encode(exact).length, 8192);
    const accepted = harness();
    accepted.push(encode(exact + ready));
    await settle();
    assert.equal(accepted.states.length, 2);
    stopped(accepted);
    await failsAfter([exact.replace('xxx', 'xxxx')]);
    await failsAfter([line({ state: 'starting', detail: '界'.repeat(2800) })]);
    const partial = harness();
    partial.push(encode('x'.repeat(4096)));
    partial.push(encode('x'.repeat(4096)));
    await settle();
    assert.equal(partial.failures, 0);
    partial.push(encode('x'));
    await settle();
    stopped(partial, 1);
    const combined = harness();
    combined.push(encode(starting.repeat(1000) + ready));
    await settle();
    assert.equal(combined.states.length, 1001, 'network chunk is not the frame limit');
    assert.equal(combined.reads, 1);
    stopped(combined);
  },
  async response_validation() {
    const invalid = [
      ...[201, 204, 301, 302, 401, 500].map(status => ({ status })),
      ...[null, '', 'application/json', 'text/html', 'application/x-ndjson-extra',
        'application/x-ndjson, application/json'].map(contentType => ({ contentType })),
      { noBody: true }, { readerError: true }
    ];
    for (const options of invalid) {
      const h = await failsAfter([], false, options);
      assert.equal(h.reads, 0, 'invalid response must never be consumed');
    }
    const h = harness({ contentType: ' Application/X-NDJSON ; charset=UTF-8' });
    h.push(encode(ready));
    await settle();
    stopped(h);
  },
  async early_eof() {
    for (const chunks of [[], [starting], [ready.trimEnd()], [starting, '{"state":'],
      [Uint8Array.of(0xe4, 0xb8)]]) {
      const h = await failsAfter(chunks, true);
      assert.equal(h.states.some(value => value.state === 'ready'), false);
    }
  },
  async transport_rejections() {
    for (const fetchMode of ['reject', 'throw']) await failsAfter([], false, { fetchMode });
    for (const initial of ['', starting]) {
      const h = harness();
      if (initial) h.push(encode(initial));
      h.rejectRead();
      await settle();
      stopped(h, 1);
    }
  },
  async pagehide() {
    for (const late of ['data', 'rejection']) {
      const h = harness();
      h.push(encode(starting));
      await settle();
      h.hide();
      if (late === 'data') h.push(encode(ready));
      else h.rejectRead();
      await settle();
      assert.deepEqual(h.states, [{ state: 'starting' }]);
      assert.equal(h.cancels, 1);
      stopped(h);
    }
  },
  async explicit_cancel() {
    const h = harness();
    await settle();
    h.cancel();
    h.cancel();
    h.hide();
    h.advance(200000);
    h.push(encode(ready));
    await settle();
    assert.equal(h.states.length, 0);
    assert.equal(h.cancels, 1);
    stopped(h);
  },
  async late_headers() {
    for (const action of ['cancel', 'pagehide', 'timeout']) {
      const h = harness({ fetchMode: 'pending' });
      if (action === 'cancel') h.cancel();
      else if (action === 'pagehide') h.hide();
      else h.advance(155000);
      const failures = action === 'timeout' ? 1 : 0;
      stopped(h, failures);
      h.headers.resolve(h.response);
      h.push(encode(ready));
      await settle();
      assert.equal(h.states.length, 0);
      assert.equal(h.reads, 0);
      assert.equal(h.cancels, 1, 'late response must release its reader');
      stopped(h, failures);
    }
    const h = harness({ fetchMode: 'pending' });
    h.cancel();
    h.headers.reject(new Error('late network rejection'));
    await settle();
    stopped(h);
  },
  async fixed_deadline() {
    const headers = harness({ fetchMode: 'pending' });
    headers.advance(3000);
    assert.equal(headers.requests[0].config.signal.aborted, false, 'no initial 3s fetch abort');
    headers.advance(151999);
    assert.equal(headers.failures, 0);
    headers.advance(1);
    stopped(headers, 1);
    headers.headers.reject(new Error('aborted headers'));
    await settle();
    stopped(headers, 1);
    const h = harness();
    await settle();
    h.advance(100000);
    h.push(encode(starting));
    await settle();
    h.advance(54999);
    h.push(encode(starting));
    await settle();
    assert.equal(h.failures, 0);
    h.advance(1);
    h.rejectRead();
    await settle();
    assert.equal(h.states.length, 2);
    assert.equal(h.cancels, 1);
    stopped(h, 1);
  },
  async cancellation_errors() {
    for (const cancelMode of ['throw', 'reject', 'hang']) {
      const h = harness({ cancelMode });
      h.push(encode(ready));
      await settle();
      assert.deepEqual(h.states, [{ state: 'ready' }]);
      assert.equal(h.cancels, 1);
      assert.equal(h.warnings.length, cancelMode === 'hang' ? 0 : 1);
      stopped(h);
    }
  },
  async callback_errors() {
    const h = await failsAfter([starting + ready], false, {
      onState() { throw new Error('state callback failed'); },
      onFailure() { throw new Error('failure callback failed'); }
    });
    assert.equal(h.states.length, 1);
    assert.equal(h.errors.length, 1, 'callback error must remain observable');
  },
  async real_readable_stream() {
    const h = harness({ realStream: true });
    const data = encode(line({ state: 'starting', phase: '中文😀' }) + ready);
    for (const byte of data) h.push(Uint8Array.of(byte));
    await settle();
    assert.deepEqual(h.states, [{ state: 'starting', phase: '中文😀' }, { state: 'ready' }]);
    assert.equal(h.reads, data.length);
    assert.equal(h.readers, 1);
    assert.equal(h.cancels, 1);
    stopped(h);
  }
};
Promise.resolve().then(() => tests[process.argv[1]]()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`
