import { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Input, InputNumber, Select, Switch, Tag, Typography } from 'antd';
import PageHeader from '../components/PageHeader';
import { ApiError } from '../api/client';
import type { IntegrationIssue } from '../api/integrations-api';
import type { ProposeResponse } from '../api/profile-api';
import {
  useCheckIntegrationSettings,
  useConfirmProposal,
  useDeleteIntegrationSecret,
  useIntegrationCodes,
  useIntegrationSecrets,
  useProfileSnapshot,
  useToolConfirm,
  useToolInvoke,
  useProposeProfile,
  usePutIntegrationSecret,
  useRejectProposal,
} from '../api/hooks';
import {
  ADAPTER_OPTIONS,
  DIRECTION_OPTIONS,
  INTEGRATION_MODULE_ID,
  blankConnector,
  buildSettings,
  draftFromModule,
  isConnectorId,
  modulePatch,
  nextConnectorId,
  routeLines,
  secretRefName,
  secretSlots,
  syncDraft,
  writerPreview,
  type ConnectorDraft,
  type DraftAdapter,
  type DraftDirection,
  type IntegrationDraft,
} from '../lib/integration-draft';
import ChangeConfirm from './ChangeConfirm';

/**
 * 对接。外部系统的收发配置走慢通道，确认后才写进 Profile。
 * 密钥只进本机库，页面不回显。
 */

const PAGE_STYLE = `
.int-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.int-body {
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}
.int-card {
  padding: 14px 16px;
  border: 1px solid rgba(23, 23, 23, 0.08);
  border-radius: 10px;
  background: #fff;
}
.int-card h3 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 500;
}
.int-rhythm {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
}
.int-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.int-field > span {
  font-size: 13px;
}
.int-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 16px;
}
.int-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.int-list button.int-item {
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(23, 23, 23, 0.08);
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.int-list button.int-item.is-on {
  border-color: #171717;
}
.int-item small {
  display: block;
  color: #737373;
  margin-top: 2px;
}
.int-routes {
  margin: 8px 0 0;
  padding-left: 18px;
  color: #525252;
}
.int-secret-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
}
.int-names {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.int-json {
  font-family: "IBM Plex Mono", ui-monospace, Consolas, monospace;
  font-size: 12px;
}
@media (max-width: 800px) {
  .int-layout { grid-template-columns: 1fr; }
}
`;

export default function IntegrationsPage() {
  const { message } = AntApp.useApp();
  const snapshotQuery = useProfileSnapshot();
  const check = useCheckIntegrationSettings();
  const propose = useProposeProfile();
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const putSecret = usePutIntegrationSecret();
  const deleteSecret = useDeleteIntegrationSecret();
  const [seenVersion, setSeenVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState<IntegrationDraft | null>(null);
  const [pending, setPending] = useState<{ id: string; report: ProposeResponse['report'] } | null>(null);
  const [issues, setIssues] = useState<IntegrationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const rejectRef = useRef(reject.mutate);
  rejectRef.current = reject.mutate;

  useEffect(() => {
    return () => {
      const id = pendingRef.current?.id;
      if (id) rejectRef.current(id);
    };
  }, []);

  const snapshot = snapshotQuery.data;
  if (snapshot && !pending && seenVersion !== snapshot.version) {
    setSeenVersion(snapshot.version);
    setDraft(draftFromModule(snapshot.modules[INTEGRATION_MODULE_ID]));
    setIssues([]);
  }

  const selected = draft?.connectors.find((item) => item.localId === draft.selected) ?? null;
  const names = useIntegrationSecrets(selected && isConnectorId(selected.id) ? selected.id : null);

  const update = (localId: string, patch: Partial<ConnectorDraft>) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        connectors: current.connectors.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
      };
    });
  };

  const save = async () => {
    if (!draft || !snapshot || pending || saving) return;
    const built = buildSettings(draft);
    if (!built.ok) {
      setIssues([{ path: '', code: 'CONFIG', message: built.message }]);
      return;
    }
    setSaving(true);
    try {
      const checked = await check.mutateAsync(built.settings);
      if (!checked.ok) {
        setIssues(checked.issues);
        return;
      }
      setIssues([]);
      const synced = syncDraft(draft, built.settings.connectors);
      setDraft(synced);
      const installed = snapshot.modules[INTEGRATION_MODULE_ID];
      const result = await propose.mutateAsync({
        patch: modulePatch({
          installed: installed !== undefined,
          wasEnabled: installed?.enabled ?? false,
          hadSettings: installed?.settings !== undefined,
          enabled: draft.enabled,
          settings: built.settings,
        }),
        note: '对接：保存配置',
      });
      setPending({ id: result.proposalId, report: result.report });
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '提议没有发出');
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (confirm.isPending) return;
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (!current) return;
    reject.mutate(current.id, {
      onError: () => message.warning('这次没有生效，但提议还留在待确认里'),
    });
  };

  const apply = async () => {
    if (!pending || !draft) return;
    try {
      const result = await confirm.mutateAsync({ id: pending.id });
      const failed = await writeTypedSecrets(draft, putSecret.mutateAsync);
      pendingRef.current = null;
      setPending(null);
      setDraft(clearTypedSecrets(draft));
      if (failed) message.warning('配置已生效，有的密钥没有写上');
      else message.success(`已生效（v${result.newVersion}）`);
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '确认失败');
    }
  };

  const writeSecrets = async () => {
    if (!selected || saving) return;
    if (!isConnectorId(selected.id)) {
      message.error('连接器 id 不合法，密钥先不写');
      return;
    }
    const entries = typedSecrets(selected);
    if (entries.length === 0) return;
    setSaving(true);
    try {
      for (const entry of entries) {
        await putSecret.mutateAsync({ connectorId: selected.id, name: entry.name, value: entry.value });
      }
      update(selected.localId, { secrets: {} });
      message.success('密钥已写入这台电脑');
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '密钥没有写上');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="int-page">
      <style>{PAGE_STYLE}</style>
      <PageHeader
        title="对接"
        subtitle="外部系统怎么收、怎么拉、怎么推。配置确认后才生效。密钥只留在这台电脑上。"
        extra={
          <Button type="primary" onClick={() => void save()} loading={saving} disabled={!draft || pending !== null}>
            保存配置
          </Button>
        }
      />
      {snapshotQuery.isError ? (
        <Alert type="error" showIcon message="读不到对接配置" />
      ) : !snapshot || !draft ? (
        <div className="int-card">正在读取配置</div>
      ) : (
        <div className="int-body">
          {issues.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message="这份配置还不能保存"
              description={
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`}>{issue.path ? `${issue.path} ${issue.message}` : issue.message}</li>
                  ))}
                </ul>
              }
            />
          ) : null}
          <section className="int-card" aria-label="拉取节奏">
            <h3>节奏</h3>
            <div className="int-rhythm">
              <label className="int-field">
                <span>拉取间隔（秒）</span>
                <InputNumber
                  aria-label="拉取间隔（秒）"
                  min={15}
                  max={86400}
                  precision={0}
                  value={draft.pollIntervalSec}
                  disabled={pending !== null}
                  onChange={(value) => setDraft({ ...draft, pollIntervalSec: typeof value === 'number' ? value : draft.pollIntervalSec })}
                />
              </label>
              <label className="int-field">
                <span>超时（毫秒）</span>
                <InputNumber
                  aria-label="超时（毫秒）"
                  min={1000}
                  max={60000}
                  precision={0}
                  value={draft.timeoutMs}
                  disabled={pending !== null}
                  onChange={(value) => setDraft({ ...draft, timeoutMs: typeof value === 'number' ? value : draft.timeoutMs })}
                />
              </label>
              <label className="int-field">
                <span>最多尝试</span>
                <InputNumber
                  aria-label="最多尝试"
                  min={1}
                  max={50}
                  precision={0}
                  value={draft.maxAttempts}
                  disabled={pending !== null}
                  onChange={(value) => setDraft({ ...draft, maxAttempts: typeof value === 'number' ? value : draft.maxAttempts })}
                />
              </label>
              <label className="int-field">
                <span>启用对接</span>
                <Switch
                  aria-label="启用对接"
                  checked={draft.enabled}
                  disabled={pending !== null}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                />
              </label>
            </div>
            <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0' }}>
              {writerPreview(draft)}
            </Typography.Paragraph>
          </section>

          <div className="int-layout">
            <div className="int-list">
              {draft.connectors.map((item) => (
                <button
                  key={item.localId}
                  type="button"
                  className={item.localId === draft.selected ? 'int-item is-on' : 'int-item'}
                  aria-pressed={item.localId === draft.selected}
                  onClick={() => setDraft({ ...draft, selected: item.localId })}
                >
                  {item.name.trim() || item.id || '未命名'}
                  <small>{item.enabled ? '启用' : '停用'}</small>
                </button>
              ))}
              <Button
                onClick={() => {
                  const id = nextConnectorId(draft.connectors.map((item) => item.id));
                  const created = blankConnector(id);
                  setDraft({ ...draft, connectors: [...draft.connectors, created], selected: created.localId });
                }}
                disabled={pending !== null}
              >
                添加连接器
              </Button>
            </div>
            {selected ? (
              <ConnectorEditor
                item={selected}
                locked={pending !== null}
                storedNames={names.data?.names ?? []}
                onChange={(patch) => update(selected.localId, patch)}
                onWriteSecrets={() => void writeSecrets()}
                onDeleteSecret={(name) => {
                  if (!isConnectorId(selected.id)) return;
                  void deleteSecret.mutateAsync({ connectorId: selected.id, name }).catch((error: unknown) => {
                    message.error(error instanceof ApiError ? error.message : '密钥没有删掉');
                  });
                }}
                onRemove={() => {
                  const connectors = draft.connectors.filter((item) => item.localId !== selected.localId);
                  setDraft({ ...draft, connectors, selected: connectors[0]?.localId ?? null });
                }}
              />
            ) : (
              <div className="int-card">还没有连接器。添加一家，写上对方的地址和路由。</div>
            )}
          </div>

          {pending ? (
            <ChangeConfirm
              text="保存后，对接就按这份配置收发。已经接住的单据不会因此改掉。"
              report={pending.report}
              confirming={confirm.isPending}
              onDismiss={dismiss}
              onApply={() => void apply()}
              nameOf={(id) => (id === INTEGRATION_MODULE_ID ? '对接' : id)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ConnectorEditor({
  item,
  locked,
  storedNames,
  onChange,
  onWriteSecrets,
  onDeleteSecret,
  onRemove,
}: {
  item: ConnectorDraft;
  locked: boolean;
  storedNames: string[];
  onChange: (patch: Partial<ConnectorDraft>) => void;
  onWriteSecrets: () => void;
  onDeleteSecret: (name: string) => void;
  onRemove: () => void;
}) {
  const slots = secretSlots(item.adapter);
  const hasTyped = slots.some((slot) => (item.secrets[slot.slot] ?? '').trim() !== '');
  return (
    <section className="int-card" aria-label={item.name.trim() || item.id || '连接器'}>
      <h3>连接器</h3>
      <div className="int-rhythm">
        <label className="int-field">
          <span>连接器 id</span>
          <Input aria-label="连接器 id" value={item.id} disabled={locked} onChange={(event) => onChange({ id: event.target.value })} />
        </label>
        <label className="int-field">
          <span>名称</span>
          <Input aria-label="名称" value={item.name} disabled={locked} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="int-field">
          <span>启用这家</span>
          <Switch aria-label="启用这家" checked={item.enabled} disabled={locked} onChange={(enabled) => onChange({ enabled })} />
        </label>
      </div>
      <div className="int-rhythm" style={{ marginTop: 12 }}>
        <label className="int-field">
          <span>方向</span>
          <Select
            aria-label="方向"
            value={item.direction}
            disabled={locked}
            style={{ minWidth: 120 }}
            options={DIRECTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(direction: DraftDirection) => onChange({ direction })}
          />
        </label>
        <label className="int-field" style={{ flex: 1 }}>
          <span>地址</span>
          <Input aria-label="地址" value={item.baseUrl} disabled={locked} onChange={(event) => onChange({ baseUrl: event.target.value })} />
        </label>
        <label className="int-field">
          <span>鉴权</span>
          <Select
            aria-label="鉴权"
            value={item.adapter}
            disabled={locked}
            style={{ minWidth: 180 }}
            options={ADAPTER_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(adapter: DraftAdapter) => onChange({ adapter })}
          />
        </label>
      </div>
      {item.adapter === 'apiKey' ? (
        <div className="int-rhythm" style={{ marginTop: 12 }}>
          <label className="int-field">
            <span>放在哪个头</span>
            <Input aria-label="放在哪个头" value={item.header} disabled={locked} onChange={(event) => onChange({ header: event.target.value })} />
          </label>
          <label className="int-field">
            <span>前缀</span>
            <Input aria-label="前缀" value={item.prefix} disabled={locked} onChange={(event) => onChange({ prefix: event.target.value })} />
          </label>
        </div>
      ) : null}
      {item.adapter === 'hmac-sha256' || item.adapter === 'oauth2-client' ? (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message="这一档鉴权还没接通，保存后也不会发出请求。" />
      ) : null}
      {slots.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="int-secret-row">
            {slots.map((slot) => (
              <label key={slot.slot} className="int-field">
                <span>{slot.label}</span>
                <Input.Password
                  aria-label={slot.label}
                  autoComplete="new-password"
                  value={item.secrets[slot.slot] ?? ''}
                  disabled={locked}
                  onChange={(event) => onChange({ secrets: { ...item.secrets, [slot.slot]: event.target.value } })}
                />
              </label>
            ))}
            <Button onClick={onWriteSecrets} disabled={locked || !hasTyped}>
              写入密钥
            </Button>
          </div>
          <div className="int-names">
            {storedNames.map((name) => (
              <Tag key={name} bordered={false}>
                <span>本机已有 {name}</span>
                <Button type="link" size="small" aria-label={`删除本机密钥 ${name}`} onClick={() => onDeleteSecret(name)}>
                  删除
                </Button>
              </Tag>
            ))}
          </div>
        </div>
      ) : null}
      <Typography.Paragraph type="secondary" style={{ margin: '12px 0 8px' }}>
        连接器 id、名称、方向、地址、鉴权和启用以上面的栏为准。路由和映射写在 JSON 里。
      </Typography.Paragraph>
      <ul className="int-routes">
        {routeLines(item.json).map((line, index) => (
          <li key={`${line}-${index}`}>{line}</li>
        ))}
      </ul>
      <Input.TextArea
        aria-label="连接器配置"
        className="int-json"
        rows={14}
        value={item.json}
        disabled={locked}
        onChange={(event) => onChange({ json: event.target.value })}
      />
      <CodeBindings connectorId={item.id} locked={locked} />
      <div style={{ marginTop: 12 }}>
        <Button danger disabled={locked} onClick={onRemove}>
          移出这个连接器
        </Button>
      </div>
    </section>
  );
}

const CODE_ENTITIES = [
  { value: 'sku', label: '货品' },
  { value: 'partner', label: '往来' },
  { value: 'warehouse', label: '仓库' },
] as const;

type CodeEntityValue = (typeof CODE_ENTITIES)[number]['value'];

function entityLabel(entity: string): string {
  return CODE_ENTITIES.find((item) => item.value === entity)?.label ?? entity;
}

function CodeBindings({ connectorId, locked }: { connectorId: string; locked: boolean }) {
  const { message, modal } = AntApp.useApp();
  const codes = useIntegrationCodes(isConnectorId(connectorId) ? connectorId : null);
  const invoke = useToolInvoke();
  const confirm = useToolConfirm();
  const [entity, setEntity] = useState<CodeEntityValue>('sku');
  const [externalCode, setExternalCode] = useState('');
  const [internalCode, setInternalCode] = useState('');
  const busy = invoke.isPending || confirm.isPending;

  if (!isConnectorId(connectorId)) {
    return (
      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        连接器 id 写好之后才能记对照。
      </Typography.Paragraph>
    );
  }

  const rows = codes.data?.rows ?? [];
  const bind = async () => {
    const params = {
      connectorId,
      entity,
      externalCode: externalCode.trim(),
      internalCode: internalCode.trim(),
    };
    try {
      const first = await invoke.mutateAsync({ toolId: 'integration.code.bind', params });
      if (!first.pending) {
        setExternalCode('');
        setInternalCode('');
        message.success('对照已记下');
        return;
      }
      modal.confirm({
        title: '确认绑定编码',
        content: `把${entityLabel(entity)}的对方编码 ${params.externalCode} 对上内部编码 ${params.internalCode}。确认后其他节点也会用这对照。`,
        okText: '确认执行',
        cancelText: '取消',
        onOk: async () => {
          try {
            await confirm.mutateAsync({ toolId: first.toolId, token: first.token });
            setExternalCode('');
            setInternalCode('');
            message.success('对照已记下');
          } catch (error) {
            message.error(error instanceof Error ? error.message : '对照没有记下');
          }
        },
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '对照没有记下');
    }
  };

  const release = (row: { entity: string; externalCode: string }) => {
    void invoke
      .mutateAsync({
        toolId: 'integration.code.unbind',
        params: { connectorId, entity: row.entity, externalCode: row.externalCode },
      })
      .then((first) => {
        if (!first.pending) return;
        modal.confirm({
          title: '确认解除对照',
          content: `解除${entityLabel(row.entity)}对方编码 ${row.externalCode}。之后报文里的这个编码会被拒绝。`,
          okText: '确认执行',
          cancelText: '取消',
          onOk: async () => {
            try {
              await confirm.mutateAsync({ toolId: first.toolId, token: first.token });
              message.success('对照已解除');
            } catch (error) {
              message.error(error instanceof Error ? error.message : '对照没有解除');
            }
          },
        });
      })
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '对照没有解除');
      });
  };

  return (
    <div style={{ marginTop: 16 }}>
      <h3>编码对照</h3>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        对照按连接器 id 记，会同步到其他节点，不写进上面的 JSON。缺一条时整笔报文会被拒绝，不会自动建档。
      </Typography.Paragraph>
      <div className="int-rhythm">
        <label className="int-field">
          <span>实体</span>
          <Select
            aria-label="实体"
            value={entity}
            disabled={locked || busy}
            style={{ minWidth: 120 }}
            options={CODE_ENTITIES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value: CodeEntityValue) => setEntity(value)}
          />
        </label>
        <label className="int-field">
          <span>对方编码</span>
          <Input
            aria-label="对方编码"
            value={externalCode}
            disabled={locked || busy}
            onChange={(event) => setExternalCode(event.target.value)}
          />
        </label>
        <label className="int-field">
          <span>内部编码</span>
          <Input
            aria-label="内部编码"
            value={internalCode}
            disabled={locked || busy}
            onChange={(event) => setInternalCode(event.target.value)}
          />
        </label>
        <Button onClick={() => void bind()} disabled={locked || busy || externalCode.trim() === '' || internalCode.trim() === ''}>
          绑定
        </Button>
      </div>
      {codes.isLoading ? null : rows.length === 0 ? (
        <Typography.Paragraph type="secondary">还没有对照。</Typography.Paragraph>
      ) : (
        <ul className="int-routes">
          {rows.map((row) => (
            <li key={`${row.entity}:${row.externalCode}`}>
              {entityLabel(row.entity)} · {row.externalCode} → {row.internalCode}
              <Button
                type="link"
                size="small"
                aria-label={`解除 ${entityLabel(row.entity)} ${row.externalCode}`}
                disabled={locked || busy}
                onClick={() => release(row)}
              >
                解除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function typedSecrets(item: ConnectorDraft): { name: string; value: string }[] {
  const entries: { name: string; value: string }[] = [];
  for (const slot of secretSlots(item.adapter)) {
    const value = (item.secrets[slot.slot] ?? '').trim();
    if (!value) continue;
    entries.push({ name: secretRefName(item, slot.slot), value });
  }
  return entries;
}

async function writeTypedSecrets(
  draft: IntegrationDraft,
  put: (input: { connectorId: string; name: string; value: string }) => Promise<unknown>,
): Promise<boolean> {
  let failed = false;
  for (const item of draft.connectors) {
    if (!isConnectorId(item.id)) continue;
    for (const entry of typedSecrets(item)) {
      try {
        await put({ connectorId: item.id, name: entry.name, value: entry.value });
      } catch {
        failed = true;
      }
    }
  }
  return failed;
}

function clearTypedSecrets(draft: IntegrationDraft): IntegrationDraft {
  return { ...draft, connectors: draft.connectors.map((item) => ({ ...item, secrets: {} })) };
}
