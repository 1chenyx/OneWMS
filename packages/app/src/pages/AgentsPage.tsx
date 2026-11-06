import { useEffect, useState } from 'react';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  List,
  Space,
  Spin,
  Typography,
} from 'antd';
import { api, ApiError } from '../api/client';
import type { AgentCatalog, AgentDef } from '../api/client';
import { useAppNav } from '../app-nav';
import PageHeader from '../components/PageHeader';

/**
 * AI 助手管理页（M16：「配置 AI」的界面——与聊天里的「使用 AI」分离）。
 *
 *  - 清单 + 工具目录来自 GET /api/agents（server 现算：配置面或内置兜底）；
 *  - 编辑是本地草稿（增删改助手、勾选工具授权按 read/write 分组、
 *    systemPrompt 人设、model 覆盖；allowedRoles 灰显「预留」）；
 *  - 保存 = 以全量清单走慢通道（POST /api/agents/propose → 人工确认）——
 *    改配置是高权限动作，与 AI 对话里只有「切换权」形成对照。
 */

/** 编辑中的助手草稿（新建助手用空 id 占位，保存时校验补齐） */
function emptyDef(): AgentDef {
  return { id: '', name: '', description: '', systemPrompt: '', tools: [] };
}

export default function AgentsPage() {
  const { message } = AntApp.useApp();
  const { navigate } = useAppNav();
  const [agents, setAgents] = useState<AgentDef[] | null>(null);
  const [tools, setTools] = useState<AgentCatalog['tools']>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .agents()
      .then((catalog) => {
        if (!alive) return;
        setAgents(catalog.agents);
        setTools(catalog.tools);
      })
      .catch((e) => {
        if (!alive) return;
        message.error(`助手清单加载失败：${e instanceof Error ? e.message : String(e)}`);
        setAgents([]);
      });
    return () => {
      alive = false;
    };
  }, [message]);

  if (agents === null) return <Card loading />;

  const active = agents.find((a) => a.id === activeId) ?? null;
  /** 更新当前编辑的助手草稿（不可变替换，保持本地清单整表可提交） */
  const patchActive = (patch: Partial<AgentDef>) => {
    setAgents((prev) => prev!.map((a) => (a.id === activeId ? { ...a, ...patch } : a)));
  };

  const createAgent = () => {
    const draft = emptyDef();
    setAgents((prev) => [...prev!, draft]);
    setActiveId(''); // 草稿以空 id 标识（新建后立即编辑 id）
  };

  const removeAgent = () => {
    setAgents((prev) => prev!.filter((a) => a.id !== activeId));
    setActiveId(null);
  };

  /** 校验并提交全量清单（慢通道：提议 → 确认后生效） */
  const save = async () => {
    if (!agents) return;
    const ids = new Set<string>();
    for (const a of agents) {
      const bad =
        !a.id.trim() ||
        !a.name.trim() ||
        typeof a.systemPrompt !== 'string' ||
        !Array.isArray(a.tools);
      if (bad) {
        message.error(`助手「${a.name || a.id || '(新建)'}」缺少必填项（id / 名称 / 人设）`);
        return;
      }
      if (ids.has(a.id)) {
        message.error(`助手 id 重复：${a.id}`);
        return;
      }
      ids.add(a.id);
    }
    setSaving(true);
    try {
      await api.proposeAgents(agents, '更新 AI 助手定义');
      message.success('已生成助手定义提议——请到「AI 对话」页确认后生效');
      navigate('chat');
    } catch (e) {
      message.error(
        e instanceof ApiError ? e.message : `提交失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const readTools = tools.filter((t) => t.permission === 'read');
  const writeTools = tools.filter((t) => t.permission === 'write');

  /** 两组 Checkbox.Group 共享全量 value；本组 onChange 只含本组新勾选集——
   *  合并另一组的既有勾选，避免跨组覆盖丢选 */
  const toggleTools = (next: string[], groupIds: string[]) => {
    const other = active?.tools.filter((id) => !groupIds.includes(id)) ?? [];
    patchActive({ tools: [...other, ...next.filter((id) => groupIds.includes(id))] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, width: '100%' }}>
      <PageHeader
        title="助手管理"
        subtitle="人设 + 工具授权 + 模型覆盖；保存生成提议，确认后生效"
        extra={
          <>
            <Button icon={<PlusOutlined />} onClick={createAgent}>
              新建助手
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              保存（生成提议）
            </Button>
          </>
        }
      />
      <Card>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          每个助手 = 人设 + 工具授权 + 可选模型覆盖；保存走慢通道（提议 → 人工确认），
          确认后对话页的切换器即可使用新定义。清单保存为空 = 恢复内置三件套
          （通用 / 只读 / 配置）。
        </Typography.Paragraph>
        {agents.length === 0 ? (
          <Empty description="当前为内置三件套（未配置自定义助手）" />
        ) : (
          <List
            dataSource={agents}
            renderItem={(a) => (
              <List.Item
                actions={[
                  <a key="edit" onClick={() => setActiveId(a.id)}>
                    {a.id === activeId ? '收起' : '编辑'}
                  </a>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Typography.Text strong>{a.name}</Typography.Text>
                      <Typography.Text code>{a.id}</Typography.Text>
                    </Space>
                  }
                  description={`${a.description || '（无描述）'} · 授权工具 ${a.tools.length} 个${a.model ? ` · 模型 ${a.model}` : ''}`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {active ? (
        <Card
          title={
            <Space>
              <span>编辑助手</span>
              <Typography.Text code>{active.id || '(新助手)'}</Typography.Text>
            </Space>
          }
          extra={
            <Button danger icon={<DeleteOutlined />} onClick={removeAgent}>
              删除该助手
            </Button>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space size="middle" style={{ width: '100%' }} align="start">
              <div style={{ width: 200 }}>
                <Typography.Text type="secondary">助手 id（保存后不可改）</Typography.Text>
                <Input
                  value={active.id}
                  onChange={(e) => setActiveId(e.target.value.trim())}
                  placeholder="如 inspector"
                  disabled={active.id !== ''}
                />
              </div>
              <div style={{ width: 200 }}>
                <Typography.Text type="secondary">展示名</Typography.Text>
                <Input
                  value={active.name}
                  onChange={(e) => patchActive({ name: e.target.value })}
                  placeholder="如 质检助手"
                />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Typography.Text type="secondary">职责说明（切换器提示）</Typography.Text>
                <Input
                  value={active.description}
                  onChange={(e) => patchActive({ description: e.target.value })}
                  placeholder="一句话说明这个助手能做什么"
                />
              </div>
            </Space>
            <div>
              <Typography.Text type="secondary">
                人设（置于全局规则与数据快照之前的 System Prompt 前缀）
              </Typography.Text>
              <Input.TextArea
                value={active.systemPrompt}
                onChange={(e) => patchActive({ systemPrompt: e.target.value })}
                placeholder="如：你是质检助手，只负责核查临期批次并给出处置建议……"
                autoSize={{ minRows: 3, maxRows: 8 }}
              />
            </div>
            <div>
              <Typography.Text type="secondary">工具授权（按读 / 写分组）</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                只读工具用于查询；写工具会修改业务数据；profile.propose
                是配置提议权（慢通道，最终由人确认）。
              </Typography.Paragraph>
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <div>
                  <Typography.Text type="secondary">只读（查询）</Typography.Text>
                  <Checkbox.Group
                    value={active.tools}
                    onChange={(v) => toggleTools(v as string[], readTools.map((t) => t.id))}
                    options={readTools.map((t) => ({
                      label: `${t.label}（${t.id}）`,
                      value: t.id,
                    }))}
                  />
                </div>
                <div>
                  <Typography.Text type="secondary">写（修改业务数据 / 配置提议）</Typography.Text>
                  <Checkbox.Group
                    value={active.tools}
                    onChange={(v) => toggleTools(v as string[], writeTools.map((t) => t.id))}
                    options={writeTools.map((t) => ({
                      label: `${t.label}（${t.id}）`,
                      value: t.id,
                    }))}
                  />
                </div>
              </Space>
            </div>
            <Space size="middle" align="start" style={{ flexWrap: 'wrap' }}>
              <div style={{ width: 280 }}>
                <Typography.Text type="secondary">模型覆盖（留空 = 服务端配置）</Typography.Text>
                <Input
                  value={active.model ?? ''}
                  onChange={(e) => patchActive({ model: e.target.value.trim() || undefined })}
                  placeholder="如 qwen3:8b"
                />
              </div>
              <div style={{ width: 280 }}>
                <Typography.Text type="secondary">按角色分配（预留）</Typography.Text>
                <Input disabled placeholder="引入角色后开放" />
              </div>
            </Space>
          </Space>
        </Card>
      ) : saving ? (
        <Spin />
      ) : null}
    </div>
  );
}
