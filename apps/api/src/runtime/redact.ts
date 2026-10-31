export function makeRedactor(getSecrets: () => string[]) {
  const redact = (text: string, partial = true): string => {
    let result = partial ? text.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[redacted]") : text;
    for (const secret of getSecrets()
      .filter((value) => value.length >= 8)
      .sort((a, b) => b.length - a.length)) {
      result = result.replaceAll(secret, "[redacted]");
      for (
        let length = partial ? Math.min(secret.length - 1, result.length) : 0;
        length >= 8;
        length--
      ) {
        if (result.endsWith(secret.slice(0, length))) {
          result = result.slice(0, -length) + "[redacted]";
          break;
        }
      }
    }
    return result;
  };
  return Object.assign(redact, {
    holdback: () => Math.max(128, ...getSecrets().map((secret) => secret.length)),
  });
}
