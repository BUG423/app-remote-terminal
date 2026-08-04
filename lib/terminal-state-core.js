'use strict';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_SCROLLBACK_ROWS = 2000;
const DEFAULT_SNAPSHOT_BYTES = 256 * 1024;

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Build the state class with packages resolved from the caller's workspace. */
function createTerminalStateImplementation({ Terminal, SerializeAddon, Unicode11Addon }) {
  function writeTerminal(terminal, data) {
    return new Promise((resolve, reject) => {
      try {
        terminal.write(data, resolve);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Maintains a real terminal-emulator state for one PTY session.
   *
   * Every write, resize, restore and snapshot runs through the same operation
   * queue. A snapshot therefore represents an exact output sequence boundary.
   */
  class TerminalState {
    constructor(options = {}) {
      const cols = positiveInt(options.cols, DEFAULT_COLS, 2, 300);
      const rows = positiveInt(options.rows, DEFAULT_ROWS, 2, 100);
      this.maxSnapshotBytes = positiveInt(
        options.maxSnapshotBytes,
        DEFAULT_SNAPSHOT_BYTES,
        16 * 1024,
        4 * 1024 * 1024
      );

      this.terminal = new Terminal({
        cols,
        rows,
        scrollback: positiveInt(options.scrollbackRows, DEFAULT_SCROLLBACK_ROWS, 0, 10000),
        allowProposedApi: true,
        logLevel: 'off',
      });
      this.serializeAddon = new SerializeAddon();
      this.terminal.loadAddon(this.serializeAddon);
      this.terminal.loadAddon(new Unicode11Addon());
      this.terminal.unicode.activeVersion = '11';

      this.sequence = 0;
      this.disposed = false;
      this._tail = Promise.resolve();
    }

    _enqueue(task) {
      if (this.disposed) return Promise.reject(new Error('terminal state is disposed'));
      const operation = this._tail.then(task);
      this._tail = operation.catch(() => {});
      return operation;
    }

    append(data) {
      if (typeof data !== 'string') throw new TypeError('terminal data must be a string');
      const sequence = ++this.sequence;
      const completion = this._enqueue(() => writeTerminal(this.terminal, data));
      return { sequence, completion };
    }

    /** Replace the emulator with a complete serialized state from upstream. */
    restore(data, cols, rows) {
      if (typeof data !== 'string') throw new TypeError('terminal data must be a string');
      const safeCols = positiveInt(cols, this.terminal.cols, 2, 300);
      const safeRows = positiveInt(rows, this.terminal.rows, 2, 100);
      const sequence = ++this.sequence;
      const completion = this._enqueue(async () => {
        this.terminal.reset();
        this.terminal.resize(safeCols, safeRows);
        await writeTerminal(this.terminal, data);
      });
      return { sequence, completion };
    }

    resize(cols, rows) {
      const safeCols = positiveInt(cols, this.terminal.cols, 2, 300);
      const safeRows = positiveInt(rows, this.terminal.rows, 2, 100);
      return this._enqueue(() => {
        this.terminal.resize(safeCols, safeRows);
      });
    }

    _serializeWithinLimit() {
      const buffer = this.terminal.buffer.normal;
      const availableScrollback = Math.max(0, buffer.length - this.terminal.rows);
      let low = 0;
      let high = availableScrollback;
      let best = this.serializeAddon.serialize({ scrollback: 0 });
      let bestRows = 0;

      // Never byte-truncate the active viewport: that would recreate the
      // original mid-ANSI corruption. A very large viewport may exceed budget.
      if (Buffer.byteLength(best, 'utf8') > this.maxSnapshotBytes) {
        return { data: best, scrollbackRows: 0, historyTruncated: availableScrollback > 0 };
      }

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = this.serializeAddon.serialize({ scrollback: mid });
        if (Buffer.byteLength(candidate, 'utf8') <= this.maxSnapshotBytes) {
          best = candidate;
          bestRows = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return {
        data: best,
        scrollbackRows: bestRows,
        historyTruncated: bestRows < availableScrollback,
      };
    }

    snapshot() {
      const sequence = this.sequence;
      return this._enqueue(() => {
        const serialized = this._serializeWithinLimit();
        return {
          ...serialized,
          sequence,
          cols: this.terminal.cols,
          rows: this.terminal.rows,
          bytes: Buffer.byteLength(serialized.data, 'utf8'),
        };
      });
    }

    dispose() {
      if (this.disposed) return;
      const terminal = this.terminal;
      const serializeAddon = this.serializeAddon;
      const pending = this._tail;
      this.disposed = true;
      this._tail = pending.finally(() => {
        try { serializeAddon.dispose(); } catch { /* ignore */ }
        try { terminal.dispose(); } catch { /* ignore */ }
      });
    }
  }

  return { TerminalState, writeTerminal };
}

module.exports = { createTerminalStateImplementation };
