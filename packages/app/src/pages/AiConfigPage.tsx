import { useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Radio,
  Space,
  Tag,
  Typography,
} from 'antd';
import { ApiOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { ApiError } from '../api/client';
import type { AiTestResult } from '../api/client';
import { useAiConfig, useClearAiConfig, useSaveAiConfig, useTestAiConfig } from '../api/hooks';
import PageHeader from '../components/PageHeader';

/**
 * AI 模型配置页（M17）——模型通道的接入面板。
 *
 * 定位：状态显示器 + 保存触发器。配置的持久位在服务端（配置文件，随数据走），
 * 页面只消费 GET/PUT/DELETE /api/ai-config；保存即热生效（服务端现场重建
 * provider，无需重启进程），下一轮 AI 对话就用新模型。
 *
 * 密钥约定：状态接口不回传明文（只报 apiKeySet）——编辑场景密钥输入框
 * 恒为空，留空提交且接入方式与 Base URL 都没改时，服务端沿用已保存密钥；
 * 换端点必须重填（旧密钥绝不静默发给新端点）。测试/保存共用这一约定。
 */

/** 表单值（apiKey 留空 = 沿用已保存密钥） */
interface AiConfigFormValues {
  kind: 'openai-compatible' | 'ollama';
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 常用预设（一键填充，纯前端便捷——最终还是走校验 + 保存） */
const PRESETS: AiConfigFormValues[] = [
  { kind: 'openai-compatible', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  { kind: 'openai-compatible', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
  { kind: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1' },
];
const PRESET_LABELS = ['OpenAI', 'DeepSeek', '本地 Ollama'];

const KIND_LABEL: Record<AiConfigFormValues['kind'], string> = {
  'openai-compatible': '云 API（OpenAI 兼容）',
  ollama: '本地 Ollama',
};
const SOURCE_LABEL: Record<'file' | 'env' | 'none', string> = {
  file: '页面配置',
  env: '环境变量',
  none: '—',
};

export default function AiConfigPage() {
  const { message } = AntApp.useApp();
  const { data: status, isLoading } = useAiConfig();
  const save = useSaveAiConfig();
  const clear = useClearAiConfig();
  const test = useTestAiConfig();

  const [form] = Form.useForm<AiConfigFormValues>();
  const kind = Form.useWatch('kind', form) ?? 'openai-compatible';
  const [testResult, setTestResult] = useState<AiTestResult>();

  const configured = status?.configured === true;
  const apiKeySet = status?.config?.apiKeySet === true;

  // 状态到达/变化 → 回填表单（密钥除外——不回传明文，输入框恒空）
  useEffect(() => {
    if (!status?.config) return;
    form.setFieldsValue({
      kind: status.config.kind,
      model: status.config.model,
      baseUrl: status.config.baseUrl,
    });
  }, [status, form]);

  /** 表单值 → 提交体（ollama 不带密钥字段——其本就忽略密钥，防止残留值混入） */
  const toBody = (values: AiConfigFormValues): AiConfigFormValues => ({
    kind: values.kind,
    model: values.model.trim(),
    baseUrl: values.baseUrl?.trim() || undefined,
    apiKey: values.kind === 'openai-compatible' ? values.apiKey?.trim() || undefined : undefined,
  });

  const onTest = async () => {
    let values: AiConfigFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败——错误提示已由表单字段渲染
    }
    setTestResult(undefined);
    try {
      setTestResult(await test.mutateAsync(toBody(values)));
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `测试请求失败：${String(e)}`);
    }
  };

  const onSave = async () => {
    let values: AiConfigFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败——错误提示已由表单字段渲染
    }
    try {
      const next = await save.mutateAsync(toBody(values));
      setTestResult(undefined);
      form.setFieldValue('apiKey', undefined);
      message.success(
        next.configured
          ? `已保存并生效（${next.config?.model}）——AI 对话即可使用`
          : '已保存',
      );
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `保存失败：${String(e)}`);
    }
  };

  const onClear = async () => {
    try {
      const next = await clear.mutateAsync();
      setTestResult(undefined);
      form.resetFields();
      message.success(next.configured ? '已恢复环境变量配置' : 'AI 已关闭');
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `操作失败：${String(e)}`);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        minHeight: 0,
        maxWidth: 720,
        width: '100%',
      }}
    >
      <PageHeader title="AI 模型" subtitle="模型通道接入；保存即热生效，无需重启" />
      {/* ① 当前状态：GET 的真相面（脱敏——密钥只显示是否已设置） */}
      <Card title="当前状态" loading={isLoading}>
        {status && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="AI 状态">
              {status.configured ? (
                <Tag color="green">已配置，可用</Tag>
              ) : (
                <Tag color="default">未配置（AI 入口将不可用，管理功能不受影响）</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="配置来源">
              {SOURCE_LABEL[status.source]}
            </Descriptions.Item>
            {status.config && (
              <>
                <Descriptions.Item label="接入方式">
                  {KIND_LABEL[status.config.kind]}
                </Descriptions.Item>
                <Descriptions.Item label="模型">{status.config.model}</Descriptions.Item>
                <Descriptions.Item label="Base URL">{status.config.baseUrl || '—'}</Descriptions.Item>
                <Descriptions.Item label="API Key">
                  {status.config.apiKeySet ? '已设置（不回显）' : '未设置'}
                </Descriptions.Item>
              </>
            )}
          </Descriptions>
        )}
      </Card>

      {/* ② 模型配置：预设速填 + 表单（测试连接 / 保存并生效 / 关闭 AI） */}
      <Card
        title="模型配置"
        extra={
          <Space size="small" wrap>
            <Typography.Text type="secondary">速填：</Typography.Text>
            {PRESETS.map((p, i) => (
              <Button
                key={i}
                size="small"
                onClick={() => {
                  form.setFieldsValue(p);
                  setTestResult(undefined);
                }}
              >
                {PRESET_LABELS[i]}
              </Button>
            ))}
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ kind: 'openai-compatible' } satisfies Partial<AiConfigFormValues>}
        >
          <Form.Item label="接入方式" name="kind">
            <Radio.Group
              options={[
                { value: 'openai-compatible', label: KIND_LABEL['openai-compatible'] },
                { value: 'ollama', label: KIND_LABEL['ollama'] },
              ]}
              onChange={() => setTestResult(undefined)}
            />
          </Form.Item>
          <Form.Item
            label="模型名"
            name="model"
            rules={[{ required: true, message: '请填写模型名' }]}
          >
            <Input placeholder={kind === 'ollama' ? '如 qwen3:8b（ollama list 查看）' : '如 deepseek-chat / gpt-4o-mini'} />
          </Form.Item>
          <Form.Item
            label="Base URL"
            name="baseUrl"
            dependencies={['kind']}
            rules={[
              {
                validator: (_, value: string | undefined) =>
                  kind === 'openai-compatible' && !value?.trim()
                    ? Promise.reject(new Error('云 API 必须填写 Base URL'))
                    : value && !/^https?:\/\//i.test(value)
                      ? Promise.reject(new Error('必须以 http:// 或 https:// 开头'))
                      : Promise.resolve(),
              },
            ]}
          >
            <Input
              placeholder={
                kind === 'ollama'
                  ? 'http://localhost:11434/v1（留空使用本机默认）'
                  : '如 https://api.deepseek.com/v1'
              }
            />
          </Form.Item>
          {kind === 'openai-compatible' && (
            <Form.Item
              label="API Key"
              name="apiKey"
              extra={
                apiKeySet
                  ? '已保存密钥不回显——接入方式与 Base URL 不变时留空沿用；更换密钥直接输入新值覆盖'
                  : '从服务商获取（sk- 开头等）；部分本地兼容网关可留空'
              }
            >
              <Input.Password placeholder={apiKeySet ? '留空保持已保存的密钥' : 'sk-...'} autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
        <Space wrap>
          <Button icon={<ThunderboltOutlined />} loading={test.isPending} onClick={onTest}>
            测试连接
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={save.isPending}
            onClick={onSave}
          >
            保存并生效
          </Button>
          {configured && (
            <Popconfirm
              title="关闭 AI"
              description="删除页面保存的配置；若启动环境变量也配置过，将回落到环境变量配置。"
              okText="关闭"
              cancelText="取消"
              onConfirm={onClear}
            >
              <Button danger loading={clear.isPending}>
                关闭 AI
              </Button>
            </Popconfirm>
          )}
        </Space>
        {testResult &&
          (testResult.ok ? (
            <Alert
              style={{ marginTop: 16 }}
              type="success"
              showIcon
              icon={<ApiOutlined />}
              message={`连接成功（${testResult.latencyMs} ms）`}
              description={
                testResult.reply ? `模型 ${testResult.model} 回复：${testResult.reply}` : `模型 ${testResult.model} 可用`
              }
            />
          ) : (
            <Alert
              style={{ marginTop: 16 }}
              type="error"
              showIcon
              message="连接失败"
              description={testResult.message}
            />
          ))}
        <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
          保存即热生效（无需重启服务端），下一轮 AI 对话即使用新模型；配置持久保存在服务端数据目录，
          重启后依然有效。本地 Ollama 需先拉取模型（ollama pull）并保持服务运行。
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
