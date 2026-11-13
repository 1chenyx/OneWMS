import { useEffect, useMemo, useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError } from '../api/client';
import {
  useDeleteReport,
  useReportCatalog,
  useReports,
  useRunReport,
  useSaveReport,
} from '../api/hooks';
import type {
  ReportCatalog,
  ReportDraft,
  ReportFilter,
  ReportFilterOp,
  ReportGrainInfo,
  ReportParameter,
  ReportSection,
  StoredReport,
} from '../api/wms-api';
import PageHeader from '../components/PageHeader';
import { face } from '../theme';

const PAGE_SIZE = 50;

const OP_LABEL: Record<ReportFilterOp, string> = {
  eq: '等于',
  neq: '不等于',
  contains: '包含',
  in: '属于',
  gt: '大于',
  gte: '不早于',
  lt: '小于',
  lte: '不晚于',
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function newSectionId(): string {
  return `s${Math.random().toString(36).slice(2, 8)}`;
}

function sectionFromGrain(grain: ReportGrainInfo): ReportSection {
  const date = grain.fields.find((field) => field.selective && field.type === 'date');
  return {
    id: newSectionId(),
    title: grain.label,
    grain: grain.id,
    columns: grain.fields.slice(0, 8).map((field) => field.id),
    filters:
      grain.requireSelective && date
        ? [{ field: date.id, op: 'gte', value: daysAgo(30) }]
        : [],
  };
}

function blankDraft(catalog: ReportCatalog): ReportDraft {
  const grain = catalog.grains[0];
  return {
    title: '',
    note: '',
    parameters: [],
    sections: grain ? [sectionFromGrain(grain)] : [],
  };
}

function draftFrom(report: StoredReport): ReportDraft {
  return {
    reportId: report.reportId,
    title: report.title,
    note: report.note ?? '',
    parameters: report.parameters,
    sections: report.sections,
  };
}

function coerceNumbers(draft: ReportDraft, catalog: ReportCatalog | undefined): ReportDraft {
  return {
    ...draft,
    title: draft.title.trim(),
    note: draft.note?.trim() || undefined,
    sections: draft.sections.map((section) => {
      const grain = catalog?.grains.find((item) => item.id === section.grain);
      return {
        ...section,
        filters: section.filters.map((filter) => {
          const field = grain?.fields.find((item) => item.id === filter.field);
          if (
            field?.type !== 'number' ||
            (typeof filter.value === 'object' && filter.value !== null && !Array.isArray(filter.value))
          ) {
            return filter;
          }
          const asNumber = (item: string | number): string | number => {
            if (typeof item === 'number') return Number.isFinite(item) ? item : item;
            const trimmed = item.trim();
            if (!trimmed) return item;
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : item;
          };
          if (Array.isArray(filter.value)) {
            return { ...filter, value: filter.value.map(asNumber) };
          }
          return { ...filter, value: asNumber(filter.value) };
        }),
      };
    }),
  };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '没有完成';
}

function ReportSectionView({
  report,
  section,
  grainLabel,
  params,
  ready,
}: {
  report: StoredReport;
  section: ReportSection;
  grainLabel: string;
  params: Record<string, string>;
  ready: boolean;
}) {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [report.reportId, section.id, params]);
  const run = useRunReport(report.reportId, section.id, params, offset, ready);
  const columns: ColumnsType<Record<string, string | number | null>> = (run.data?.columns ?? []).map((column) => ({
    title: column.label,
    dataIndex: column.field,
    ellipsis: true,
    align: column.type === 'number' ? 'right' : 'left',
    render: (value: string | number | null) => (value === null || value === undefined || value === '' ? '—' : String(value)),
  }));
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <Typography.Text strong>{section.title}</Typography.Text>
        <Typography.Text style={{ marginLeft: 8, color: face.text3 }}>{grainLabel}</Typography.Text>
      </div>
      {!ready ? (
        <Typography.Text style={{ color: face.text2 }}>填完上面的条件后再看这张表。</Typography.Text>
      ) : run.isLoading ? (
        <Spin />
      ) : run.isError ? (
        <Typography.Text style={{ color: face.bad }}>{errorText(run.error)}</Typography.Text>
      ) : (
        <>
          <Table
            size="small"
            rowKey="key"
            columns={columns}
            dataSource={(run.data?.rows ?? []).map((row, index) => ({
              ...row,
              key: `${section.id}-${offset + index}`,
            }))}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: '没有符合条件的行' }}
          />
          <Space>
            <Button size="small" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>
              上一页
            </Button>
            <Typography.Text style={{ color: face.text3 }}>
              {offset + 1}–{offset + (run.data?.rows.length ?? 0)}
            </Typography.Text>
            <Button size="small" disabled={!run.data?.hasMore} onClick={() => setOffset((value) => value + PAGE_SIZE)}>
              下一页
            </Button>
          </Space>
        </>
      )}
    </section>
  );
}

export default function ReportsPage() {
  const { message } = AntApp.useApp();
  const catalog = useReportCatalog();
  const reports = useReports();
  const save = useSaveReport();
  const remove = useDeleteReport();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});

  const selected = reports.data?.find((report) => report.reportId === selectedId) ?? null;
  useEffect(() => {
    if (reports.isLoading || reports.isFetching) return;
    if (!reports.data) return;
    if (selectedId && reports.data.some((report) => report.reportId === selectedId)) return;
    const next = reports.data[0]?.reportId ?? null;
    if (next !== selectedId) setSelectedId(next);
  }, [reports.data, reports.isFetching, reports.isLoading, selectedId]);
  useEffect(() => {
    setParams({});
  }, [selected?.reportId]);

  const ready = useMemo(() => {
    if (!selected) return false;
    return selected.parameters.every((param) => (params[param.key] ?? '').trim() !== '');
  }, [selected, params]);

  const openNew = () => {
    if (!catalog.data) return;
    setDraft(blankDraft(catalog.data));
  };
  const openEdit = () => {
    if (selected) setDraft(draftFrom(selected));
  };

  const onSave = async () => {
    if (!draft) return;
    try {
      const saved = await save.mutateAsync(coerceNumbers(draft, catalog.data));
      setSelectedId(saved.reportId);
      setDraft(null);
      message.success('报表已保存');
    } catch (error) {
      message.error(errorText(error));
    }
  };

  const onDelete = async (reportId: string) => {
    try {
      await remove.mutateAsync(reportId);
      setSelectedId(null);
      message.success('报表已删除');
    } catch (error) {
      message.error(errorText(error));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="报表"
        subtitle="每张报表是几张明细表。一行是什么、连哪些列、按什么条件收窄，都可以自己定。也可以在对话里让助手保存。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew} disabled={!catalog.data}>
            新建
          </Button>
        }
      />
      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        <div style={{ width: 220, flex: 'none', overflow: 'auto' }}>
          {reports.isLoading ? <Spin /> : null}
          {(reports.data ?? []).map((report) => {
            const active = report.reportId === selected?.reportId;
            return (
              <button
                key={report.reportId}
                type="button"
                onClick={() => setSelectedId(report.reportId)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: active ? face.raised : 'transparent',
                  borderRadius: 8,
                  padding: '8px 10px',
                  cursor: 'pointer',
                  color: face.ink,
                }}
              >
                <div>{report.title}</div>
                <Typography.Text style={{ fontSize: 12, color: face.text3 }}>
                  {report.sections.length} 张表
                </Typography.Text>
              </button>
            );
          })}
          {reports.data && reports.data.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有报表" />
          ) : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {selected ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <Typography.Title level={5} style={{ margin: 0 }}>
                    {selected.title}
                  </Typography.Title>
                  {selected.note ? (
                    <Typography.Text style={{ color: face.text2 }}>{selected.note}</Typography.Text>
                  ) : null}
                </div>
                <Space>
                  <Button onClick={openEdit}>编辑</Button>
                  <Popconfirm title="删除这张报表？" onConfirm={() => void onDelete(selected.reportId)}>
                    <Button danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              </div>
              {selected.parameters.length > 0 ? (
                <Space wrap>
                  {selected.parameters.map((param) => (
                    <label key={param.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <Typography.Text style={{ fontSize: 12, color: face.text3 }}>{param.label}</Typography.Text>
                      <Input
                        type={param.type === 'date' ? 'date' : param.type === 'number' ? 'number' : 'text'}
                        value={params[param.key] ?? ''}
                        onChange={(event) =>
                          setParams((current) => ({ ...current, [param.key]: event.target.value }))
                        }
                        style={{ width: 180 }}
                      />
                    </label>
                  ))}
                </Space>
              ) : null}
              {selected.sections.map((section) => (
                <ReportSectionView
                  key={`${selected.reportId}:${section.id}`}
                  report={selected}
                  section={section}
                  grainLabel={catalog.data?.grains.find((item) => item.id === section.grain)?.label ?? section.grain}
                  params={params}
                  ready={ready}
                />
              ))}
            </>
          ) : reports.isLoading || reports.isFetching ? (
            <Spin />
          ) : (
            <Empty description="选一张报表，或新建一张" />
          )}
        </div>
      </div>
      <ReportEditor
        catalog={catalog.data}
        draft={draft}
        saving={save.isPending}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={() => void onSave()}
      />
    </div>
  );
}

function ReportEditor({
  catalog,
  draft,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  catalog: ReportCatalog | undefined;
  draft: ReportDraft | null;
  saving: boolean;
  onChange: (draft: ReportDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Drawer
      title={draft?.reportId ? '编辑报表' : '新建报表'}
      open={draft !== null}
      width={720}
      onClose={onClose}
      extra={
        <Button type="primary" loading={saving} onClick={onSave} disabled={!draft}>
          保存
        </Button>
      }
    >
      {draft && catalog ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            placeholder="标题，例如 华东客户未完成出库"
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
          <Input
            placeholder="说明，给谁看（可选）"
            value={draft.note ?? ''}
            onChange={(event) => onChange({ ...draft, note: event.target.value })}
          />
          <ParameterEditor
            parameters={draft.parameters}
            onChange={(parameters) => onChange({ ...draft, parameters })}
          />
          {draft.sections.map((section, index) => (
            <SectionEditor
              key={section.id}
              catalog={catalog}
              section={section}
              parameters={draft.parameters}
              onChange={(next) =>
                onChange({
                  ...draft,
                  sections: draft.sections.map((item, itemIndex) => (itemIndex === index ? next : item)),
                })
              }
              onRemove={
                draft.sections.length > 1
                  ? () => onChange({ ...draft, sections: draft.sections.filter((_, itemIndex) => itemIndex !== index) })
                  : undefined
              }
            />
          ))}
          {draft.sections.length < 8 ? (
            <Button
              icon={<PlusOutlined />}
              onClick={() => {
                const grain = catalog.grains.find((item) => item.id === 'inventory') ?? catalog.grains[0];
                if (!grain) return;
                onChange({ ...draft, sections: [...draft.sections, sectionFromGrain(grain)] });
              }}
            >
              再加一张表
            </Button>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function ParameterEditor({
  parameters,
  onChange,
}: {
  parameters: ReportParameter[];
  onChange: (parameters: ReportParameter[]) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Typography.Text style={{ color: face.text2 }}>共用条件。几张表可以引用同一个参数。</Typography.Text>
      {parameters.map((param, index) => (
        <Space key={index} wrap>
          <Input
            placeholder="key"
            value={param.key}
            style={{ width: 120 }}
            onChange={(event) =>
              onChange(parameters.map((item, itemIndex) => (itemIndex === index ? { ...item, key: event.target.value } : item)))
            }
          />
          <Input
            placeholder="名称"
            value={param.label}
            style={{ width: 140 }}
            onChange={(event) =>
              onChange(parameters.map((item, itemIndex) => (itemIndex === index ? { ...item, label: event.target.value } : item)))
            }
          />
          <Select
            value={param.type}
            style={{ width: 100 }}
            options={[
              { value: 'text', label: '文字' },
              { value: 'number', label: '数字' },
              { value: 'date', label: '日期' },
            ]}
            onChange={(type: ReportParameter['type']) =>
              onChange(parameters.map((item, itemIndex) => (itemIndex === index ? { ...item, type } : item)))
            }
          />
          <Button type="text" danger onClick={() => onChange(parameters.filter((_, itemIndex) => itemIndex !== index))}>
            去掉
          </Button>
        </Space>
      ))}
      {parameters.length < 12 ? (
        <Button
          size="small"
          onClick={() => onChange([...parameters, { key: `p${parameters.length + 1}`, label: '条件', type: 'text' }])}
        >
          加参数
        </Button>
      ) : null}
    </div>
  );
}

function SectionEditor({
  catalog,
  section,
  parameters,
  onChange,
  onRemove,
}: {
  catalog: ReportCatalog;
  section: ReportSection;
  parameters: ReportParameter[];
  onChange: (section: ReportSection) => void;
  onRemove?: () => void;
}) {
  const grain = catalog.grains.find((item) => item.id === section.grain) ?? catalog.grains[0];
  if (!grain) return null;
  const ops = (fieldId: string): ReportFilterOp[] => {
    const field = grain.fields.find((item) => item.id === fieldId);
    return field ? catalog.filterOps[field.type] : [];
  };
  return (
    <div style={{ border: `1px solid ${face.line}`, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Space wrap>
        <Input
          value={section.title}
          style={{ width: 200 }}
          onChange={(event) => onChange({ ...section, title: event.target.value })}
        />
        <Select
          value={section.grain}
          style={{ width: 160 }}
          options={catalog.grains.map((item) => ({ value: item.id, label: item.label }))}
          onChange={(grainId: string) => {
            const next = catalog.grains.find((item) => item.id === grainId);
            if (!next) return;
            const fresh = sectionFromGrain(next);
            onChange({ ...fresh, id: section.id, title: section.title || fresh.title });
          }}
        />
        {onRemove ? (
          <Button type="text" danger onClick={onRemove}>
            去掉这张表
          </Button>
        ) : null}
      </Space>
      <Typography.Text style={{ color: face.text3 }}>{grain.row}</Typography.Text>
      {grain.requireSelective ? (
        <Typography.Text style={{ color: face.text2 }}>这张表要先收窄。标了收窄的字段至少用一个。</Typography.Text>
      ) : null}
      <Checkbox.Group
        value={section.columns}
        options={grain.fields.map((field) => ({
          value: field.id,
          label: field.selective ? `${field.label}（收窄）` : field.label,
        }))}
        onChange={(columns) => onChange({ ...section, columns: columns.map(String) })}
      />
      {section.filters.map((filter, index) => (
        <FilterRow
          key={index}
          grain={grain}
          filter={filter}
          ops={ops(filter.field)}
          parameters={parameters}
          onChange={(next) =>
            onChange({
              ...section,
              filters: section.filters.map((item, itemIndex) => (itemIndex === index ? next : item)),
            })
          }
          onRemove={() => onChange({ ...section, filters: section.filters.filter((_, itemIndex) => itemIndex !== index) })}
        />
      ))}
      {section.filters.length < 20 ? (
        <Button
          size="small"
          onClick={() => {
            const field = grain.fields.find((item) => item.selective) ?? grain.fields[0];
            if (!field) return;
            const op = catalog.filterOps[field.type][0] ?? 'eq';
            onChange({
              ...section,
              filters: [...section.filters, { field: field.id, op, value: '' }],
            });
          }}
        >
          加条件
        </Button>
      ) : null}
    </div>
  );
}

function FilterRow({
  grain,
  filter,
  ops,
  parameters,
  onChange,
  onRemove,
}: {
  grain: ReportGrainInfo;
  filter: ReportFilter;
  ops: ReportFilterOp[];
  parameters: ReportParameter[];
  onChange: (filter: ReportFilter) => void;
  onRemove: () => void;
}) {
  const paramKey =
    typeof filter.value === 'object' && filter.value !== null && !Array.isArray(filter.value)
      ? filter.value.param
      : undefined;
  const field = grain.fields.find((item) => item.id === filter.field);
  const shown = Array.isArray(filter.value) ? filter.value.join(',') : paramKey ?? String(filter.value ?? '');
  return (
    <Space wrap>
      <Select
        value={filter.field}
        style={{ width: 150 }}
        options={grain.fields.map((item) => ({ value: item.id, label: item.label }))}
        onChange={(fieldId: string) => {
          const next = grain.fields.find((item) => item.id === fieldId);
          const op = next && opsFor(next.type).includes(filter.op) ? filter.op : 'eq';
          onChange({ field: fieldId, op, value: '' });
        }}
      />
      <Select
        value={filter.op}
        style={{ width: 110 }}
        options={ops.map((op) => ({ value: op, label: op === 'gte' || op === 'lte' ? (field?.type === 'date' ? OP_LABEL[op] : op === 'gte' ? '大于等于' : '小于等于') : OP_LABEL[op] }))}
        onChange={(op: ReportFilterOp) => onChange({ ...filter, op, value: op === 'in' ? [] : '' })}
      />
      {paramKey !== undefined ? (
        <Select
          value={paramKey}
          placeholder="参数"
          style={{ width: 140 }}
          options={parameters.map((param) => ({ value: param.key, label: param.label }))}
          onChange={(key: string) => onChange({ ...filter, value: { param: key } })}
        />
      ) : (
        <Input
          value={shown}
          placeholder={filter.op === 'in' ? '多个值用逗号分开' : field?.type === 'date' ? 'YYYY-MM-DD' : '值'}
          style={{ width: 180 }}
          onChange={(event) => {
            const text = event.target.value;
            onChange({
              ...filter,
              value: filter.op === 'in' ? text.split(',').map((item) => item.trim()).filter(Boolean) : text,
            });
          }}
        />
      )}
      {parameters.length > 0 ? (
        <Button
          size="small"
          onClick={() =>
            onChange({
              ...filter,
              value: paramKey !== undefined ? '' : { param: parameters[0]?.key ?? '' },
            })
          }
        >
          {paramKey !== undefined ? '改成固定值' : '改用参数'}
        </Button>
      ) : null}
      <Button type="text" danger onClick={onRemove}>
        去掉
      </Button>
    </Space>
  );
}

function opsFor(type: ReportGrainInfo['fields'][number]['type']): ReportFilterOp[] {
  if (type === 'number') return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
  if (type === 'date') return ['eq', 'gt', 'gte', 'lt', 'lte'];
  return ['eq', 'neq', 'contains', 'in'];
}
