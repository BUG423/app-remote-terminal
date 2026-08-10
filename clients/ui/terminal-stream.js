(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.TerminalStream = api;
})(function buildTerminalStream() {
  'use strict';

  const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function utf8Bytes(value) {
    if (utf8Encoder) return utf8Encoder.encode(value).byteLength;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(value, 'utf8');
    return unescape(encodeURIComponent(value)).length;
  }

  /**
   * Serializes all xterm writes and validates relay sequence numbers. This
   * keeps xterm's internal parser queue bounded and requests a full snapshot
   * whenever a gap or local overload makes incremental rendering unsafe.
   */
  class TerminalStreamController {
    constructor(terminal, options = {}) {
      this.terminal = terminal;
      this.maxPendingBytes = options.maxPendingBytes || 512 * 1024;
      this.onResync = options.onResync || (() => {});
      this.onSnapshotApplied = options.onSnapshotApplied || (() => {});
      this.queue = [];
      this.pendingBytes = 0;
      this.writing = false;
      this.accepting = false;
      this.lastSequence = null;
      this.resyncRequested = false;
      this.revision = 0;
      this.disposed = false;
    }

    beginSync() {
      if (this.disposed) return;
      this.revision++;
      this.accepting = false;
      this.lastSequence = null;
      this.resyncRequested = false;
      this.queue = [];
      this.pendingBytes = 0;
    }

    pause() {
      this.beginSync();
    }

    applySnapshot(snapshot) {
      if (this.disposed || !snapshot || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 ||
          typeof snapshot.data !== 'string') {
        this._requestResync();
        return false;
      }

      const revision = ++this.revision;
      this.queue = [];
      this.pendingBytes = 0;
      this.accepting = true;
      this.lastSequence = snapshot.seq;
      this.resyncRequested = false;
      this.queue.push({
        kind: 'snapshot',
        data: snapshot.data,
        cols: snapshot.cols,
        rows: snapshot.rows,
        revision,
      });
      this.pendingBytes = utf8Bytes(snapshot.data);
      this._drain();
      return true;
    }

    acceptOutput(data, sequence) {
      if (this.disposed || !this.accepting) return false;
      if (typeof data !== 'string' || !Number.isSafeInteger(sequence) || sequence < 1) {
        this._requestResync();
        return false;
      }
      if (sequence <= this.lastSequence) return true; // duplicate after reconnect
      if (sequence !== this.lastSequence + 1) {
        this._requestResync();
        return false;
      }

      const bytes = utf8Bytes(data);
      if (this.pendingBytes + bytes > this.maxPendingBytes) {
        this._requestResync();
        return false;
      }
      this.lastSequence = sequence;
      const tail = this.queue[this.queue.length - 1];
      if (tail && tail.kind === 'output' && tail.revision === this.revision) tail.data += data;
      else this.queue.push({ kind: 'output', data, revision: this.revision });
      this.pendingBytes += bytes;
      this._drain();
      return true;
    }

    writeLocal(data) {
      if (this.disposed || typeof data !== 'string') return;
      const bytes = utf8Bytes(data);
      if (this.pendingBytes + bytes > this.maxPendingBytes) return;
      const tail = this.queue[this.queue.length - 1];
      if (tail && tail.kind === 'local' && tail.revision === this.revision) tail.data += data;
      else this.queue.push({ kind: 'local', data, revision: this.revision });
      this.pendingBytes += bytes;
      this._drain();
    }

    _requestResync() {
      if (this.disposed) return;
      this.revision++;
      this.accepting = false;
      this.lastSequence = null;
      this.queue = [];
      this.pendingBytes = 0;
      if (this.resyncRequested) return;
      this.resyncRequested = true;
      this.onResync();
    }

    _drain() {
      if (this.writing || this.disposed) return;
      const item = this.queue.shift();
      if (!item) return;
      this.pendingBytes = Math.max(0, this.pendingBytes - utf8Bytes(item.data));
      this.writing = true;

      if (item.kind === 'snapshot') {
        try {
          const cols = Number.isInteger(item.cols) ? Math.max(2, Math.min(300, item.cols)) : null;
          const rows = Number.isInteger(item.rows) ? Math.max(2, Math.min(100, item.rows)) : null;
          if (cols && rows) this.terminal.resize(cols, rows);
          this.terminal.reset();
        } catch { /* a later resync can recover rendering */ }
      }

      let completed = false;
      const done = () => {
        if (completed) return;
        completed = true;
        this.writing = false;
        if (item.kind === 'snapshot' && item.revision === this.revision && !this.disposed) {
          this.onSnapshotApplied();
        }
        this._drain();
      };
      try {
        this.terminal.write(item.data, done);
        // xterm may skip the callback for an empty write. Snapshots can be
        // legitimately empty, so complete them on the next microtask as a
        // fallback; `done` is idempotent if xterm did invoke it.
        if (item.data.length === 0) queueMicrotask(done);
      } catch {
        this.writing = false;
        this._requestResync();
      }
    }

    dispose() {
      this.disposed = true;
      this.queue = [];
      this.pendingBytes = 0;
      this.accepting = false;
    }
  }

  return { TerminalStreamController, utf8Bytes };
});
