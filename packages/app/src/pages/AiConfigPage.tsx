import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  Popconfirm,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { ApiError } from '../api/client';
import type { AiProfilePublic, AiTestResult } from '../api/client';
import {
  useActivateAiProfile,
  useAddAiProfiles,
  useAiConfig,
  useClearAiConfig,
  useDeleteAiProfile,
  useTestAiConfig,
} from '../api/hooks';
import PageHeader from '../components/PageHeader';
import {
  AI_VENDOR_REGIONS,
  findVendor,
  vendorsIn,
  type AiVendor,
  type AiVendorRegion,
} from '../lib/ai-vendors';

/**
 * AI 模型配置页。
 *
 * 左边是厂商画廊：地址和常用模型已经写死，云厂商通常只填密钥。
 * 同厂商可以存多条。右边是已保存的清单，对话只用标成「当前使用」的那一条。
 * 环境变量带来的配置只读展示，不进可删除清单——关掉页面配置会回到它。
 *
 * 密钥不回显。同一厂商、同一地址上已经存过密钥时，留空表示沿用；
 * 换地址必须重填，避免旧密钥被发给新端点。
 */

const PAGE_STYLE = `
.ai-config-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.ai-config-split {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.8fr);
  gap: 16px;
  flex: 1;
  min-height: 0;
}
.ai-config-pane.ant-card {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-config-pane > .ant-card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}
.ai-config-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.ai-vendor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 8px;
  align-content: start;
}
.ai-vendor-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-height: 72px;
  margin: 0;
  padding: 10px 12px;
  text-align: left;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fafafa;
  cursor: pointer;
}
.ai-vendor-card:hover {
  border-color: #91caff;
  background: #fff;
}
.ai-vendor-card.is-selected {
  border-color: #1677ff;
  background: #e6f4ff;
  box-shadow: inset 0 0 0 1px #1677ff;
}
.ai-vendor-name {
  font-weight: 600;
  line-height: 1.3;
}
.ai-vendor-hint {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.4;
}
.ai-vendor-detail {
  flex: none;
  padding: 12px;
  border-radius: 8px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
}
.ai-model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ai-model-chips .ant-btn {
  height: auto;
  white-space: normal;
  text-align: left;
}
.ai-profile {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
}
.ai-profile.is-active {
  border-color: #1677ff;
  background: #f0f7ff;
}
.ai-profile + .ai-profile {
  margin-top: 8px;
}
@media (max-width: 1100px) {
  .ai-config-split {
    grid-template-columns: 1fr;
    overflow: auto;
  }
  .ai-config-pane.ant-card,
  .ai-config-pane > .ant-card-body,
  .ai-config-scroll {
    overflow: visible;
  }
}
`;

function endpointOf(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function chosenModels(vendor: AiVendor, selected: string[], custom: string): string[] {
  const fromChips = vendor.models.map((item) => item.id).filter((id) => selected.includes(id));
  if (!vendor.modelFromUser) return fromChips;
  const extra = custom.trim();
  if (!extra || fromChips.includes(extra)) return fromChips;
  return [...fromChips, extra];
}

export default function AiConfigPage() {
  const { message } = AntApp.useApp();
  const { data: status, isLoading } = useAiConfig();
  const add = useAddAiProfiles();
  const activate = useActivateAiProfile();
  const remove = useDeleteAiProfile();
  const clear = useClearAiConfig();
  const test = useTestAiConfig();

  const [region, setRegion] = useState<AiVendorRegion>('cn');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [formError, setFormError] = useState('');
  const [testResult, setTestResult] = useState<AiTestResult>();

  const profiles = status?.profiles ?? [];
  const vendor = vendorId ? findVendor(vendorId) : undefined;
  const gallery = vendorsIn(region);
  const baseUrl = vendor ? (vendor.id === 'custom' ? customUrl.trim() : vendor.baseUrl) : '';
  const models = vendor ? chosenModels(vendor, selectedModels, customModel) : [];
  const reusableKey =
    vendor !== undefined &&
    profiles.some(
      (item) =>
        item.vendorId === vendor.id &&
        item.apiKeySet &&
        endpointOf(item.baseUrl) === endpointOf(baseUrl),
    );
  const showKey = vendor !== undefined && (vendor.needsKey || vendor.id === 'custom');

  const pick = (next: AiVendor) => {
    setVendorId(next.id);
    setSelectedModels(next.models[0] ? [next.models[0].id] : []);
    setCustomModel('');
    setCustomUrl('');
    setApiKey('');
    setFormError('');
    setTestResult(undefined);
  };

  const onRegion = (next: AiVendorRegion) => {
    setRegion(next);
    if (vendor && !vendorsIn(next).some((item) => item.id === vendor.id)) {
      setVendorId(null);
      setSelectedModels([]);
      setCustomModel('');
      setApiKey('');
      setFormError('');
      setTestResult(undefined);
    }
  };

  const toggleModel = (id: string) => {
    setSelectedModels((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
    setFormError('');
    setTestResult(undefined);
  };

  /** 组装前的页面校验。通过则返回要提交的模型名。 */
  const readyModels = (): string[] | undefined => {
    if (!vendor) {
      setFormError('请先选择一个厂商');
      return undefined;
    }
    if (vendor.id === 'custom' && !baseUrl) {
      setFormError('请填写接口地址');
      return undefined;
    }
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      setFormError('接口地址要以 http:// 或 https:// 开头');
      return undefined;
    }
    if (models.length === 0) {
      setFormError(vendor.modelFromUser ? '请填写模型 ID' : '请至少选择一个模型');
      return undefined;
    }
    if (vendor.needsKey && !apiKey.trim() && !reusableKey) {
      setFormError('请填写 API Key');
      return undefined;
    }
    setFormError('');
    return models;
  };

  const onAdd = async () => {
    const picked = readyModels();
    if (!picked || !vendor) return;
    try {
      const next = await add.mutateAsync({
        vendorId: vendor.id,
        label: vendor.name,
        kind: vendor.kind,
        baseUrl,
        models: picked,
        activate: true,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey('');
      setTestResult(undefined);
      message.success(next.config?.model ? `已保存，当前使用 ${next.config.model}` : '已保存');
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `保存失败：${String(e)}`);
    }
  };

  const onTestDraft = async () => {
    const picked = readyModels();
    if (!picked || !vendor) return;
    setTestResult(undefined);
    try {
      setTestResult(
        await test.mutateAsync({
          kind: vendor.kind,
          model: picked[0],
          baseUrl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      );
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `测试请求失败：${String(e)}`);
    }
  };

  const onTestSaved = async (profile: AiProfilePublic) => {
    setTestResult(undefined);
    try {
      setTestResult(await test.mutateAsync({ profileId: profile.id }));
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `测试请求失败：${String(e)}`);
    }
  };

  const onActivate = async (profile: AiProfilePublic) => {
    try {
      const next = await activate.mutateAsync(profile.id);
      message.success(`当前使用 ${next.config?.model ?? profile.model}`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `切换失败：${String(e)}`);
    }
  };

  const onRemove = async (profile: AiProfilePublic) => {
    try {
      await remove.mutateAsync(profile.id);
      message.success(`已移除 ${profile.model}`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `移除失败：${String(e)}`);
    }
  };

  const onClear = async () => {
    try {
      const next = await clear.mutateAsync();
      setTestResult(undefined);
      message.success(next.configured ? '已恢复环境变量配置' : 'AI 已关闭');
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `操作失败：${String(e)}`);
    }
  };

  const envOnly = status?.source === 'env' && profiles.length === 0 && status.config !== undefined;

  return (
    <div className="ai-config-page">
      <style>{PAGE_STYLE}</style>
      <PageHeader
        title="AI 模型"
        subtitle="选厂商、填密钥即可。地址已经配好，可以同时保存多条，对话用「当前使用」的那一条。"
        extra={[
          status?.configured ? (
            <Tag key="state" color="green">
              当前使用 {status.config?.model}
            </Tag>
          ) : (
            <Tag key="state">未配置</Tag>
          ),
          profiles.length > 0 ? (
            <Popconfirm
              key="clear"
              title="关闭 AI"
              description="删掉页面上保存的全部模型。若启动时配过环境变量，会回到那一份。"
              okText="关闭"
              cancelText="取消"
              onConfirm={onClear}
            >
              <Button danger loading={clear.isPending}>
                关闭 AI
              </Button>
            </Popconfirm>
          ) : null,
        ]}
      />

      {envOnly && (
        <Alert
          type="info"
          showIcon
          message={`当前生效的是环境变量里的 ${status.config?.model}。在这里添加模型后会改用页面配置；关掉页面上的模型会回到环境变量。`}
        />
      )}

      <div className="ai-config-split">
        <Card className="ai-config-pane" title="添加模型" loading={isLoading}>
          <Segmented
            block
            value={region}
            options={AI_VENDOR_REGIONS.map((item) => ({ label: item.label, value: item.id }))}
            onChange={(value) => onRegion(value as AiVendorRegion)}
          />
          <div className="ai-config-scroll">
            <div className="ai-vendor-grid" data-testid="ai-vendor-grid">
              {gallery.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === vendorId ? 'ai-vendor-card is-selected' : 'ai-vendor-card'}
                  aria-label={item.name}
                  aria-pressed={item.id === vendorId}
                  onClick={() => pick(item)}
                >
                  <span className="ai-vendor-name">{item.name}</span>
                  <span className="ai-vendor-hint">{item.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {vendor && (
            <div className="ai-vendor-detail">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <div>
                  <Typography.Text type="secondary">接口地址</Typography.Text>
                  {vendor.id === 'custom' ? (
                    <Input
                      style={{ marginTop: 4 }}
                      aria-label="接口地址"
                      placeholder="https://example.com/v1"
                      value={customUrl}
                      onChange={(event) => {
                        setCustomUrl(event.target.value);
                        setFormError('');
                      }}
                    />
                  ) : (
                    <div>
                      <Typography.Text code>{vendor.baseUrl}</Typography.Text>
                    </div>
                  )}
                </div>

                {vendor.models.length > 0 && (
                  <div>
                    <Typography.Text type="secondary">模型（可多选，第一条会设为当前使用）</Typography.Text>
                    <div className="ai-model-chips" style={{ marginTop: 8 }}>
                      {vendor.models.map((item) => {
                        const on = selectedModels.includes(item.id);
                        return (
                          <Button
                            key={item.id}
                            size="small"
                            type={on ? 'primary' : 'default'}
                            aria-pressed={on}
                            onClick={() => toggleModel(item.id)}
                          >
                            {item.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {vendor.modelFromUser && (
                  <div>
                    <Typography.Text type="secondary">模型 ID</Typography.Text>
                    <Input
                      style={{ marginTop: 4 }}
                      aria-label="模型 ID"
                      placeholder="填写接入点上的模型 ID"
                      value={customModel}
                      onChange={(event) => {
                        setCustomModel(event.target.value);
                        setFormError('');
                      }}
                    />
                  </div>
                )}

                {showKey && (
                  <div>
                    <Typography.Text type="secondary">API Key</Typography.Text>
                    <Input.Password
                      style={{ marginTop: 4 }}
                      aria-label="API Key"
                      placeholder="粘贴 API Key"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setFormError('');
                      }}
                    />
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4, fontSize: 12 }}>
                      {reusableKey
                        ? '这个地址已经存过密钥，留空会沿用，不会发到别的地址。'
                        : vendor.needsKey
                          ? '只填这一家的密钥。地址不用改。'
                          : '云接口再填密钥；本地兼容网关可以留空。'}
                    </Typography.Paragraph>
                  </div>
                )}

                {formError && <Typography.Text type="danger">{formError}</Typography.Text>}

                <Space wrap>
                  <Button loading={test.isPending} onClick={onTestDraft}>
                    测试连接
                  </Button>
                  <Button type="primary" loading={add.isPending} onClick={onAdd}>
                    添加并设为当前
                  </Button>
                </Space>

                {testResult &&
                  (testResult.ok ? (
                    <Alert
                      type="success"
                      showIcon
                      icon={<ApiOutlined />}
                      message={`连接成功（${testResult.latencyMs} ms）`}
                      description={
                        testResult.reply
                          ? `模型 ${testResult.model} 回复：${testResult.reply}`
                          : `模型 ${testResult.model} 可用`
                      }
                    />
                  ) : (
                    <Alert type="error" showIcon message="连接失败" description={testResult.message} />
                  ))}
              </Space>
            </div>
          )}
        </Card>

        <Card
          className="ai-config-pane"
          title={`已保存的模型${profiles.length > 0 ? `（${profiles.length}）` : ''}`}
          loading={isLoading}
        >
          <div className="ai-config-scroll">
            {profiles.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                还没有保存的模型。从左边选一个厂商，填上密钥就能添加。同一个厂商可以保存多条。
              </Typography.Paragraph>
            ) : (
              profiles.map((profile) => (
                <div key={profile.id} className={profile.active ? 'ai-profile is-active' : 'ai-profile'}>
                  <div style={{ minWidth: 0 }}>
                    <Space size={6} wrap>
                      <Typography.Text strong>{profile.label}</Typography.Text>
                      {profile.active && <Tag color="green">当前使用</Tag>}
                    </Space>
                    <div style={{ marginTop: 4 }}>
                      <Typography.Text code>{profile.model}</Typography.Text>
                    </div>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4, fontSize: 12 }}>
                      {profile.baseUrl}
                      {' · '}
                      {profile.apiKeySet ? '密钥已保存' : '未设置密钥'}
                    </Typography.Paragraph>
                  </div>
                  <Space direction="vertical" size={6}>
                    {!profile.active && (
                      <Button size="small" loading={activate.isPending} onClick={() => onActivate(profile)}>
                        设为当前
                      </Button>
                    )}
                    <Button size="small" loading={test.isPending} onClick={() => onTestSaved(profile)}>
                      测试这条
                    </Button>
                    <Popconfirm
                      title="移除这个模型"
                      description={profile.active ? '这是当前正在用的。移除后会改用剩下的第一条。' : '只移除这一条。'}
                      okText="确认移除"
                      cancelText="取消"
                      onConfirm={() => onRemove(profile)}
                    >
                      <Button size="small" danger loading={remove.isPending}>
                        移除这条
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
