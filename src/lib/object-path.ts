export function getByPath(value: unknown, path: string): unknown {
  if (!path) {
    return value;
  }

  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);
}
