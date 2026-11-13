// Stand-in for the VS Code webview API: forwards messages to the dev server and replays
// its answers as window "message" events, exactly as webview.postMessage would.
(function () {
  const file = new URLSearchParams(location.search).get('file');
  let state;
  let queue = Promise.resolve();

  function revive(_key, value) {
    if (value && typeof value === 'object' && typeof value.__u8 === 'string') {
      const bin = atob(value.__u8);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    }
    return value;
  }

  function send(message) {
    // Serialised so answers arrive in the order the messages were posted.
    queue = queue.then(async () => {
      const res = await fetch('/msg?file=' + encodeURIComponent(file), {
        method: 'POST',
        body: JSON.stringify(message),
      });
      const replies = JSON.parse(await res.text(), revive);
      for (const reply of replies) {
        window.__dev.received.push(reply.type);
        if (reply.type === '__reload') {
          // Drop an explicit ?lang= so the new language setting takes effect.
          const url = new URL(location.href);
          url.searchParams.delete('lang');
          location.replace(url.toString());
          return;
        }
        window.postMessage(reply, '*');
      }
    });
    return queue;
  }

  window.__dev = { send, sent: [], received: [] };
  window.acquireVsCodeApi = function () {
    return {
      postMessage(message) {
        window.__dev.sent.push(message);
        void send(message);
      },
      getState: () => state,
      setState(next) {
        state = next;
      },
    };
  };
})();
