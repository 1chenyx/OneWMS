import { request } from './request';

export interface IntegrationIssue {
  path: string;
  code: string;
  message: string;
}

export type IntegrationCheck = { ok: true } | { ok: false; issues: IntegrationIssue[] };

/** 对接配置的校验和本机密钥。校验只看 JSON。密钥接口不回传值。 */
export const integrationApi = {
  checkIntegrationSettings: (settings: unknown) =>
    request<IntegrationCheck>('/api/integrations/check', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  integrationSecretNames: (connectorId: string) =>
    request<{ names: string[] }>(`/api/integrations/secrets?connectorId=${encodeURIComponent(connectorId)}`),
  putIntegrationSecret: (input: { connectorId: string; name: string; value: string }) =>
    request<{ ok: true }>('/api/integrations/secrets', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteIntegrationSecret: (input: { connectorId: string; name: string }) =>
    request<{ ok: true }>('/api/integrations/secrets', {
      method: 'DELETE',
      body: JSON.stringify(input),
    }),
};
