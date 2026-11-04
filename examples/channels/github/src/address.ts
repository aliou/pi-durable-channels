const ADDRESS = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

export type IssueRef = { owner: string; repo: string; number: number };

export function issueAddress(repository: string, number: number): string {
  return `${repository}#${number}`;
}

export function parseIssueAddress(address: string): IssueRef {
  const match = ADDRESS.exec(address);
  if (match === null)
    throw new Error("GitHub addresses look like <owner>/<repo>#<number>");
  const [, owner = "", repo = "", number = ""] = match;
  return { owner, repo, number: Number(number) };
}

export function issuePath({ owner, repo, number }: IssueRef): string {
  return `/repos/${owner}/${repo}/issues/${number}`;
}
