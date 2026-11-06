import { useCallback, useEffect, useState } from 'react';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { api, ApiError } from '../api/client';
import type { MemoryItem, MemorySettings } from '../api/client';
import { useAppNav } from '../app-nav';
import PageHeader from '../components/PageHeader';

/**
 * AI 记忆管理页：查看 / 维护 AI 聊天积累的长期记忆（personal=用户偏好，
 * project=业务约定），并控制自动记忆设置。
 *
 *  - 读：GET /api/memory 直查投影（清单 + 生效设置一次拿全）；
 *  - 写：新增 / 遗忘走工具总线端点（护栏 + 审计，source=manual）；
 *  - 设置：autoMemory / maxMemoryItems 改动走慢通道（提议 → 人工确认），
 *    与助手定义同一条通道——配置变更铁律；
 *  - 来源标签：auto=对话后自动提取、ai=对话中 AI 记录、manual=本页手动维护。
 */

type ScopeFilter = 'all' | 'personal' | 'project';

const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  auto: '自动提取',
  ai: '对话记录',
  manual: '手动',
};

const SCOPE_LABEL: Record<MemoryItem['scope'], string> = {
  personal: '个人偏好',
  project: '业务约定',
};

export default function MemoryPage() {
  const { message } = AntApp.useApp();
  const { navigate } = useAppNav();
  const [loading, setLoading] = useState(true);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MemorySettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addScope, setAddScope] = useState<MemoryItem['scope']>('project');
  const [addContent, setAddContent] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await api.memories();
      setMemories(data.memories);
      setSettings(data.settings);
      setSettingsDraft(data.settings);
    } catch (e) {
      message.error(`记忆加载失败：${e instanceof Error ? e.message : String(e)}`);
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = scopeFilter === 'all' ? memories : memories.filter((m) => m.scope === scopeFilter);

  const addMemory = async () => {
    const content = addContent.trim();
    if (!content) {
      message.error('内容不能为空');
      return;
    }
    setAdding(true);
    try {
      await api.createMemory({ scope: addScope, content });
      message.success('已保存');
      setAddOpen(false);
      setAddContent('');
      await reload();
    } catch (e) {
      message.error(
        e instanceof ApiError ? e.message : `保存失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setAdding(false);
    }
  };

  const forget = async (item: MemoryItem) => {
    try {
      await api.forgetMemory(item.id);
      message.success('已遗忘');
      await reload();
    } catch (e) {
      message.error(
        e instanceof ApiError ? e.message : `删除失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  /** 设置走慢通道：提交提议 → 引导到配置确认页 */
  const saveSettings = async () => {
    if (!settings || !settingsDraft) return;
    const changed: { autoMemory?: boolean; maxMemoryItems?: number } = {};
    if (settingsDraft.autoMemory !== settings.autoMemory) changed.autoMemory = settingsDraft.autoMemory;
    if (settingsDraft.maxMemoryItems !== settings.maxMemoryItems) {
      changed.maxMemoryItems = settingsDraft.maxMemoryItems;
    }
    if (Object.keys(changed).length === 0) {
      message.info('设置未变化');
      return;
    }
    setSavingSettings(true);
    try {
      await api.proposeMemorySettings(changed, '更新 AI 记忆设置');
      message.success('已生成设置提议——请到「配置确认」页确认后生效');
      navigate('proposals');
    } catch (e) {
      message.error(
        e instanceof ApiError ? e.message : `提交失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, width: '100%' }}>
      <PageHeader
        title="AI 记忆"
        subtitle="AI 从对话中积累的长期上下文：个人偏好与业务约定，越用越懂你"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            新增记忆
          </Button>
        }
      />

      {loading ? (
        <Card loading />
      ) : (
        <>
          <Card size="small">
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Space size="large" wrap>
                <Space size="small">
                  <Typography.Text>对话后自动提取记忆</Typography.Text>
                  <Switch
                    checked={settingsDraft?.autoMemory ?? false}
                    onChange={(v) => setSettingsDraft((s) => (s ? { ...s, autoMemory: v } : s))}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    关闭后 AI 不再自动记录（对话中说「记住…」仍可显式记录）
                  </Typography.Text>
                </Space>
                <Space size="small">
                  <Typography.Text>记忆总量上限</Typography.Text>
                  <InputNumber
                    min={1}
                    value={settingsDraft?.maxMemoryItems ?? 200}
                    onChange={(v) =>
                      setSettingsDraft((s) => (s ? { ...s, maxMemoryItems: v ?? 200 } : s))
                    }
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    条（达到后拒绝新增，需先遗忘）
                  </Typography.Text>
                </Space>
                <Button icon={<SaveOutlined />} loading={savingSettings} onClick={saveSettings}>
                  保存设置（生成提议）
                </Button>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                设置修改走慢通道：提交后到「配置确认」页确认才生效。记忆随事件账本多节点同步，
                来源标签区分：{SOURCE_LABEL.auto} / {SOURCE_LABEL.ai} / {SOURCE_LABEL.manual}。
              </Typography.Text>
            </Space>
          </Card>

          <Card
            title={
              <Space>
                <Segmented
                  value={scopeFilter}
                  onChange={(v) => setScopeFilter(v as ScopeFilter)}
                  options={[
                    { label: `全部（${memories.length}）`, value: 'all' },
                    {
                      label: `个人偏好（${memories.filter((m) => m.scope === 'personal').length}）`,
                      value: 'personal',
                    },
                    {
                      label: `业务约定（${memories.filter((m) => m.scope === 'project').length}）`,
                      value: 'project',
                    },
                  ]}
                />
              </Space>
            }
          >
            {shown.length === 0 ? (
              <Empty description="暂无记忆——与 AI 对话后会自动积累，也可手动新增" />
            ) : (
              <List
                dataSource={shown}
                pagination={{ pageSize: 10, showSizeChanger: false }}
                renderItem={(m) => (
                  <List.Item
                    actions={[
                      <Popconfirm
                        key="forget"
                        title="遗忘这条记忆？"
                        description="AI 之后将不再利用该信息"
                        okText="遗忘"
                        cancelText="取消"
                        onConfirm={() => void forget(m)}
                      >
                        <Button type="text" danger icon={<DeleteOutlined />} size="small">
                          遗忘
                        </Button>
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small" wrap>
                          <Tag color={m.scope === 'personal' ? 'geekblue' : 'green'}>
                            {SCOPE_LABEL[m.scope]}
                          </Tag>
                          <Tag>{SOURCE_LABEL[m.source]}</Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            更新于 {new Date(m.updatedAt).toLocaleString()}
                          </Typography.Text>
                        </Space>
                      }
                      description={m.content}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </>
      )}

      <Modal
        title="新增记忆"
        open={addOpen}
        onOk={() => void addMemory()}
        onCancel={() => setAddOpen(false)}
        confirmLoading={adding}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 8 }}>
          <div>
            <Typography.Text type="secondary">分层</Typography.Text>
            <Segmented
              block
              value={addScope}
              onChange={(v) => setAddScope(v as MemoryItem['scope'])}
              options={[
                { label: '个人偏好（我的习惯/称呼/风格）', value: 'personal' },
                { label: '业务约定（商品/供应商/流程）', value: 'project' },
              ]}
            />
          </div>
          <div>
            <Typography.Text type="secondary">内容（一句完整的话，单条事实）</Typography.Text>
            <Input.TextArea
              value={addContent}
              onChange={(e) => setAddContent(e.target.value)}
              placeholder="如：A001 是易碎品，搬运需轻拿轻放"
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={500}
              showCount
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
}
