import { useCallback, useMemo, useState } from 'react';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DynRow, UiPageDescriptor, UiPageField } from '../api/client';
import { useDynRecords, useToolConfirm, useToolInvoke } from '../api/hooks';
import { rowsOf, totalOf, useListPage } from '../api/page';
import { monoCell, numCell, serverPagination } from '../components/table-style';
import PageHeader from '../components/PageHeader';

/**
 * 通用实体列表页（B.6）：声明式模块的页面渲染器。
 *
 * 一切结构都来自服务端下发的页面描述（descriptor）——列、表单控件、可过滤列、
 * 读写工具 id 全是数据，不是代码。模块只提交 JSON 就能长出这一整页，
 * 这是「界面也是可声明能力」的落点（DESIGN §6.3 SDUI 主链路）。
 *
 * 与 SkusPage 的分工：SkusPage 是内置页面（有 SKU 专属的业务动作与跳转），
 * 这里只承载「一张声明式实体表」的通用读写，不夹带任何领域知识。
 */

/**
 * 写操作三步（B.5 确认闸口）：invoke 拿令牌 → 弹框摊开「服务端将要写什么」→ confirm 落地。
 *
 * 封成一个 hook 而不是每处各写一遍：漏掉第三步的后果是「界面提示成功、库里没数据」——
 * 服务端在 invoke 阶段只发令牌不执行，这种静默失败不该依赖每个调用点都记得。
 */
function useRecordWrite() {
  const { message, modal } = App.useApp();
  const invoke = useToolInvoke();
  const confirm = useToolConfirm();

  return useCallback(
    async (toolId: string, params: Record<string, unknown>) => {
      try {
        const first = await invoke.mutateAsync({ toolId, params });
        // read 工具直通（本页面用不到，但同一条链路要能走通）
        if (!first.pending) {
          message.success(`${first.label}完成`);
          return;
        }
        modal.confirm({
          title: `确认${first.label}`,
          content: <ParamPreview params={first.params} />,
          okText: '确认执行',
          cancelText: '取消',
          onOk: async () => {
            try {
              const done = await confirm.mutateAsync({ toolId: first.toolId, token: first.token });
              message.success(`${done.label}完成`);
            } catch (error) {
              // 令牌过期/已用过（409）时重试没有意义，关掉弹框让人重新发起
              message.error((error as Error).message);
            }
          },
        });
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [confirm, invoke, message, modal],
  );
}

/** 确认框里摊开的入参：让人看清「这一次到底要写什么」，而不是只看一个按钮 */
function ParamPreview({ params }: { params: Record<string, unknown> }) {
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        服务端将写入以下内容，点「确认执行」后才落地：
      </Typography.Paragraph>
      <pre style={{ margin: 0, maxHeight: 240, overflowY: 'auto', fontSize: 12 }}>
        {JSON.stringify(params, null, 2)}
      </pre>
    </div>
  );
}

/** 列值 → 单元格文本（与 SkusPage 的动态列同一套规则：类型只影响呈现，不影响存储） */
function renderValue(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return <span style={{ color: '#bfbfbf' }}>-</span>;
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 表单值 → 列值。按 manifest 声明的类型转，转不动就抛给调用处提示（宁可不写，不写脏） */
function toColumnValue(field: UiPageField, raw: unknown): unknown {
  switch (field.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`「${field.label}」不是合法数字`);
      return n;
    }
    case 'boolean':
      return Boolean(raw);
    case 'json': {
      if (typeof raw !== 'string') return raw;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`「${field.label}」不是合法 JSON`);
      }
    }
    default:
      return String(raw).trim();
  }
}

function fieldControl(field: UiPageField) {
  switch (field.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} />;
    case 'boolean':
      return <Switch />;
    case 'json':
      return <Input.TextArea rows={3} placeholder='JSON，如 {"a":1}' />;
    case 'date':
      // 纯文本而不是日期控件：不为一个声明式页面引入日期库（与 SkuFormModal 同一取舍）
      return <Input placeholder="YYYY-MM-DD" maxLength={32} />;
    default:
      return <Input maxLength={100} showCount />;
  }
}

/** 新建/编辑弹框。row 有值 = 编辑（带 version 走乐观并发），无值 = 新建 */
function RecordFormModal({
  descriptor,
  row,
  open,
  onClose,
}: {
  descriptor: UiPageDescriptor;
  row?: DynRow;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const write = useRecordWrite();
  const { record } = descriptor;
  const editing = row !== undefined;

  const initialValues = useMemo(() => {
    const base: Record<string, unknown> = {};
    for (const field of record.fields) {
      // 布尔列必须有初值：不给的话「没碰过的开关」会是 undefined，整替时列就没了
      base[field.key] = field.type === 'boolean' ? false : undefined;
    }
    if (!row) return base;
    for (const field of record.fields) {
      const value = row.data[field.key];
      base[field.key] = field.type === 'json' && value !== undefined ? JSON.stringify(value) : value;
    }
    return base;
  }, [record.fields, row]);

  const submit = async (values: Record<string, unknown>) => {
    const data: Record<string, unknown> = {};
    try {
      for (const field of record.fields) {
        const raw = values[field.key];
        if (raw === undefined || raw === null || raw === '') continue;
        data[field.key] = toColumnValue(field, raw);
      }
    } catch (error) {
      message.error((error as Error).message);
      return;
    }
    const recordId = typeof values.recordId === 'string' ? values.recordId.trim() : '';
    const params = editing
      ? { recordId: row.recordId, expectedVersion: row.version, data }
      : { ...(recordId ? { recordId } : {}), data };
    // 先关表单再弹服务端确认框：两层弹框叠着，人就看不清「要确认的到底是哪一层」
    onClose();
    await write(editing ? record.tools.update : record.tools.create, params);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={editing ? '保存' : '新建'}
      title={`${editing ? '编辑' : '新建'}${record.label}`}
      width={680}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={submit} initialValues={initialValues}>
        {!editing && (
          <Form.Item
            name="recordId"
            label="记录 ID"
            tooltip="留空自动生成。填了就是这条记录的业务主键，之后不能改"
          >
            <Input placeholder="如 device-001（小写字母开头，可含数字与 _）" maxLength={128} />
          </Form.Item>
        )}
        {/* ⚠️ update 是整替：没带上的列会从记录里消失（服务端语义，见 dyn-tools.ts）。
            表单每次都用整行的当前值预填，所以正常使用不会掉列——但这句话得让人看见。 */}
        {editing && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            保存为整替：清空的列会从记录里移除。
          </Typography.Paragraph>
        )}
        {record.fields.map((field) => (
          <Form.Item
            key={field.key}
            name={field.key}
            label={field.label}
            tooltip={field.description}
            valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
          >
            {fieldControl(field)}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
}

export default function RecordListPage({ descriptor }: { descriptor: UiPageDescriptor }) {
  const { record } = descriptor;
  const write = useRecordWrite();
  const [modal, setModal] = useState<{ open: boolean; row?: DynRow }>({ open: false });

  const queryable = useMemo(() => record.fields.filter((f) => f.queryable), [record.fields]);
  const [filterField, setFilterField] = useState<string | undefined>(queryable[0]?.key);
  const [applied, setApplied] = useState<{ filter?: string; equals?: string }>({});
  // 过滤条件变了就回到第一页（key 变化触发 useListPage 内部重置）
  const list = useListPage(`${record.id}|${applied.filter ?? ''}|${applied.equals ?? ''}`);
  const { data, isLoading } = useDynRecords(record, {
    limit: list.limit,
    offset: list.offset,
    ...applied,
  });

  const columns = useMemo<ColumnsType<DynRow>>(() => {
    const cols: ColumnsType<DynRow> = [
      { title: '记录 ID', dataIndex: 'recordId', key: 'recordId', width: 180, onCell: monoCell },
    ];
    for (const field of record.fields) {
      cols.push({
        title: field.label,
        key: field.key,
        dataIndex: ['data', field.key] as const,
        align: field.type === 'number' ? 'right' : undefined,
        onCell: field.type === 'number' ? numCell : undefined,
        render: renderValue,
      });
    }
    cols.push({
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_, row) => (
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setModal({ open: true, row })}
          >
            编辑
          </Button>
          {/* 不用 Popconfirm：删除同样走 invoke→确认弹框→confirm，再套一层本地确认就是三次点击 */}
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() =>
              void write(record.tools.delete, { recordId: row.recordId, expectedVersion: row.version })
            }
          >
            删除
          </Button>
        </Space>
      ),
    });
    return cols;
  }, [record.fields, record.tools.delete, write]);

  return (
    <div>
      <PageHeader
        title={descriptor.label}
        subtitle={`${descriptor.moduleName} · ${record.note ?? '列结构由模块 manifest 定义'}`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true })}>
            新建
          </Button>
        }
      />
      <Card styles={{ body: { paddingTop: 12 } }}>
        <Space wrap style={{ marginBottom: 12 }}>
          {queryable.length > 0 && (
            <Space.Compact>
              <Select
                style={{ width: 132 }}
                value={filterField}
                onChange={(value) => {
                  setFilterField(value);
                  setApplied({});
                }}
                options={queryable.map((f) => ({ value: f.key, label: f.label }))}
              />
              <Input.Search
                allowClear
                style={{ width: 200 }}
                placeholder="精确匹配…"
                onSearch={(value) => {
                  const equals = value.trim();
                  setApplied(equals && filterField ? { filter: filterField, equals } : {});
                }}
              />
            </Space.Compact>
          )}
        </Space>
        <Table<DynRow>
          rowKey="recordId"
          size="middle"
          tableLayout="auto"
          loading={isLoading}
          dataSource={rowsOf(data)}
          columns={columns}
          scroll={{ x: 'max-content' }}
          pagination={serverPagination({
            current: list.page,
            total: totalOf(data),
            onChange: list.setPage,
          })}
        />
      </Card>
      {modal.open && (
        <RecordFormModal
          descriptor={descriptor}
          row={modal.row}
          open
          onClose={() => setModal({ open: false })}
        />
      )}
    </div>
  );
}
