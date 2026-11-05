const ADDRESS = /^session:([A-Za-z0-9][A-Za-z0-9-]*)$/;

export function sessionAddress(agentSessionId: string): string {
  return `session:${agentSessionId}`;
}

export function parseSessionAddress(address: string): string {
  const match = ADDRESS.exec(address);
  if (match === null)
    throw new Error("Linear addresses look like session:<agent session id>");
  return match[1];
}
