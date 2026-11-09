import { Alert, Card, Switch, Typography } from 'antd';
import PageHeader from '../components/PageHeader';
import { CAPABILITY_CARDS, capabilityCard, capabilityResult, isFlowModule } from '../lib/module-present';
import ChangeConfirm from './ChangeConfirm';
import { shownEnabled, useModuleReview, type InstalledModule } from './use-module-review';

/**
 * 模块。一张卡片一个开关。
 * 卡片写明打开以后出现在哪里。拨动后卡片立刻变成打开或关闭的样子。
 */

const PAGE_STYLE = `
.cap-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.cap-body {
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cap-group {
  margin: 8px 0 0;
  font-weight: 600;
}
.cap-card {
  padding: 14px 16px;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  background: #fff;
}
.cap-card.is-off {
  border-style: dashed;
  border-color: #d9d9d9;
  background: #fafafa;
}
.cap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.cap-name {
  font-weight: 600;
  font-size: 16px;
}
.cap-card.is-off .cap-name {
  color: rgba(0, 0, 0, 0.45);
}
.cap-place {
  margin: 8px 0 0;
}
.cap-detail {
  margin: 2px 0 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 13px;
}
`;

const GROUPS = [
  { key: 'page' as const, title: '作业里多一个页面' },
  { key: 'action' as const, title: '原来的页面上多一个动作' },
];

export default function ModulesPage() {
  const review = useModuleReview('模块');
  const { snapshotQuery, snapshot, installed } = review;
  const rows = installed
    .filter((card) => !card.system && !isFlowModule(card.id))
    .slice()
    .sort(byCard);

  return (
    <div className="cap-page">
      <style>{PAGE_STYLE}</style>
      <PageHeader title="模块" subtitle="打开以后，到对应的页面里就能用。确认后才生效。" />
      {snapshotQuery.isError ? (
        <Alert type="error" showIcon message="读不到模块配置" />
      ) : snapshotQuery.isLoading || !snapshot ? (
        <Card loading />
      ) : rows.length === 0 ? (
        <Alert type="info" showIcon message="还没有可开关的仓库能力" />
      ) : (
        <div className="cap-body">
          {GROUPS.map((group) => {
            const items = rows.filter((card) => (capabilityCard(card.id)?.group ?? 'action') === group.key);
            if (items.length === 0) return null;
            return (
              <section key={group.key} aria-label={group.title}>
                <div className="cap-group">{group.title}</div>
                {items.map((card) => (
                  <CapabilityCard key={card.id} card={card} review={review} />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CapabilityCard({
  card,
  review,
}: {
  card: InstalledModule;
  review: ReturnType<typeof useModuleReview>;
}) {
  const copy = capabilityCard(card.id);
  const on = shownEnabled(card, review.preview);
  const pendingHere = review.preview?.place === card.id;
  return (
    <article className={on ? 'cap-card' : 'cap-card is-off'} aria-label={card.name} data-on={on ? 'true' : 'false'}>
      <div className="cap-head">
        <div className="cap-name">{card.name}</div>
        <Switch
          aria-label={card.name}
          checked={on}
          disabled={review.busy}
          loading={review.proposingId === card.id}
          onChange={(enabled) => void review.start(card.id, enabled, `${enabled ? '打开' : '关掉'}${card.name}`, card.id)}
        />
      </div>
      <Typography.Paragraph className="cap-place">{copy?.place ?? card.line}</Typography.Paragraph>
      {copy?.detail ? <p className="cap-detail">{copy.detail}</p> : null}
      {pendingHere ? (
        <ChangeConfirm
          text={capabilityResult(card.id, review.preview?.enabled ?? false, card.name)}
          report={review.report}
          confirming={review.confirming}
          onDismiss={review.dismiss}
          onApply={() => void review.apply()}
          nameOf={review.nameOf}
        />
      ) : null}
    </article>
  );
}

function byCard(a: InstalledModule, b: InstalledModule): number {
  const rank = cardRank(a.id) - cardRank(b.id);
  return rank !== 0 ? rank : a.name.localeCompare(b.name, 'zh');
}

function cardRank(id: string): number {
  const index = CAPABILITY_CARDS.findIndex((item) => item.moduleId === id);
  return index === -1 ? CAPABILITY_CARDS.length : index;
}
