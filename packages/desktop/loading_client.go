package main

// 两种加载页在各自 IIFE 内拼接此客户端；状态字段之外的业务校验由调用者负责。
const loadingStreamClient = `
  function consumeLoadingStream(onState, onFailure) {
    const controller = new AbortController();
    let reader;
    let stopped = false;
    // 总期限不随状态帧续期，后端可用完整的 150 秒启动窗口。
    const deadline = setTimeout(fail, 155000);
    window.addEventListener('pagehide', cancel, { once: true });

    function cancellationFailed() {
      // 终态已交接或页面已退出，取消失败只留诊断，不再改变页面状态。
      console.warn('Loading stream cancellation failed');
    }
    function cancelReader(activeReader) {
      try {
        // 不等待 cancel：底层取消可能悬挂或拒绝，不能阻止 abort 与页面交接。
        Promise.resolve(activeReader.cancel()).catch(cancellationFailed);
      } catch {
        cancellationFailed();
      }
    }
    function cancel() {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      window.removeEventListener('pagehide', cancel);
      if (reader) cancelReader(reader);
      controller.abort();
    }
    function fail() {
      if (stopped) return;
      cancel();
      try {
        onFailure();
      } catch {
        console.error('Loading stream failure callback failed');
      }
    }
    async function receive() {
      const response = await fetch(location.pathname + '/events', {
        mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'no-referrer', headers: { Accept: 'application/x-ndjson' }, signal: controller.signal
      });
      if (response.body) reader = response.body.getReader();
      // 取消可发生在响应头到达之前；迟到的流也必须释放，不再派发状态。
      if (stopped) {
        if (reader) cancelReader(reader);
        return;
      }
      const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || contentType !== 'application/x-ndjson' || !reader) {
        throw new Error('Invalid loading stream response');
      }
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let frame = '';
      let frameBytes = 0;
      while (!stopped) {
        const chunk = await reader.read();
        if (stopped) return;
        if (chunk.done) {
          decoder.decode();
          throw new Error('Loading stream ended before terminal state');
        }
        if (!(chunk.value instanceof Uint8Array)) throw new Error('Invalid loading stream chunk');
        const bytes = chunk.value;
        let offset = 0;
        while (offset < bytes.length && !stopped) {
          const newline = bytes.indexOf(10, offset);
          const end = newline < 0 ? bytes.length : newline;
          // 按原始字节限长（含换行），不累计整个网络块；终态后的多余字节不处理。
          frameBytes += end - offset + (newline < 0 ? 0 : 1);
          if (frameBytes > 8192) throw new Error('Loading stream frame too large');
          frame += decoder.decode(bytes.subarray(offset, end), { stream: true });
          if (newline < 0) break;
          frame += decoder.decode();
          // 空行、坏 JSON、非状态对象均拒绝；EOF 前的半行不作为完整帧交付。
          if (!frame.trim()) throw new Error('Empty loading stream frame');
          const value = JSON.parse(frame);
          if (!value || typeof value !== 'object' || Array.isArray(value)
              || !['starting', 'ready', 'failed'].includes(value.state)) {
            throw new Error('Invalid loading stream state');
          }
          frame = '';
          frameBytes = 0;
          if (onState(value) === true) {
            cancel();
            return;
          }
          offset = end + 1;
        }
      }
    }
    // fetch/read/解码/业务回调的异常统一转为一次失败；主动取消不报失败。
    void receive().catch(fail);
    return cancel;
  }
`
