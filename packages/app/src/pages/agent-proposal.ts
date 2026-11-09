/** 助手定义在配置里的位置。助手管理保存时整份替换这一处。 */
export const AGENT_DEFS_PATH = '/modules/core.ai/settings/agents';

/** 整份提议都是助手定义。这类改动只在助手管理页确认。 */
export function isAgentDefsProposal(proposal: { paths?: readonly string[] }): boolean {
  const paths = proposal.paths;
  return Array.isArray(paths) && paths.length > 0 && paths.every((path) => path === AGENT_DEFS_PATH);
}

export function proposalsForChat<T extends { paths?: readonly string[] }>(
  proposals: readonly T[] | undefined,
): T[] {
  return (proposals ?? []).filter((item) => !isAgentDefsProposal(item));
}
