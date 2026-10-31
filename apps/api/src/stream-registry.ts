export interface StreamRegistry {
  register(close: () => void): () => void;
  closeAll(): void;
}

/**
 * Tracks open SSE responses so shutdown can end them instead of waiting for
 * clients to disconnect.
 */
export function createStreamRegistry(): StreamRegistry {
  const closers = new Set<() => void>();

  return {
    register(close) {
      closers.add(close);
      return () => {
        closers.delete(close);
      };
    },
    closeAll() {
      for (const close of [...closers]) {
        close();
      }
      closers.clear();
    },
  };
}
