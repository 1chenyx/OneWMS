import { useState, type CSSProperties, type ReactNode } from 'react';
import { PrinterOutlined } from '@ant-design/icons';
import { Button, Modal, Space, Typography } from 'antd';

/**
 * 单据预览和打印。
 * 屏幕上只在弹窗里看；真正交给浏览器打印的节点固定在视口里并隐藏，
 * 不插进列表文档流。@media print 再把它摆回纸面，其余界面藏掉。
 * 多张单据叠在同一个打印根里，每张单独换页，一次系统打印对话框打完。
 */

/** 屏幕上不占位、不挡点击。打印样式用 !important 把它拉回纸面。 */
export const PRINT_ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  left: 0,
  top: 0,
  width: 720,
  visibility: 'hidden',
  pointerEvents: 'none',
};

export function printCss(rootId: string): string {
  return `
    @media print {
      @page { margin: 12mm; }
      body * { visibility: hidden !important; }
      #${rootId}, #${rootId} * { visibility: visible !important; }
      #${rootId} { position: absolute !important; left: 0; top: 0; width: 100%; visibility: visible !important; }
      #${rootId} .print-sheet { break-after: page; page-break-after: always; }
      #${rootId} .print-sheet:last-child { break-after: auto; page-break-after: auto; }
      #${rootId} tr { page-break-inside: avoid; break-inside: avoid; }
    }
  `;
}

/** 挂上打印根之后再拉起系统对话框，避免打出空白页。打完卸掉打印根。 */
export function armWindowPrint(onDone: () => void): void {
  const cleanup = () => {
    onDone();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.setTimeout(() => window.print(), 60);
}

export function usePrintSession<T extends { id: string }>() {
  const [previewDocs, setPreviewDocs] = useState<T[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [printDocs, setPrintDocs] = useState<T[]>([]);

  const openPreview = (docs: T[]) => {
    if (docs.length === 0) return;
    setPreviewDocs(docs);
    setPreviewIndex(0);
  };

  const closePreview = () => {
    setPreviewDocs([]);
    setPreviewIndex(0);
  };

  const printNow = (docs: T[]) => {
    if (docs.length === 0) return;
    setPrintDocs(docs);
    armWindowPrint(() => setPrintDocs([]));
  };

  return { previewDocs, previewIndex, setPreviewIndex, printDocs, openPreview, closePreview, printNow };
}

export function PrintStyle({ rootId }: { rootId: string }) {
  return <style>{printCss(rootId)}</style>;
}

export function PrintRoot<T extends { id: string }>({
  id,
  docs,
  renderDoc,
}: {
  id: string;
  docs: T[];
  renderDoc: (doc: T) => ReactNode;
}) {
  if (docs.length === 0) return null;
  return (
    <div id={id} aria-hidden="true" style={PRINT_ROOT_STYLE}>
      {docs.map((doc) => (
        <div key={doc.id} className="print-sheet">
          {renderDoc(doc)}
        </div>
      ))}
    </div>
  );
}

/** 勾选后出现。打印不经过弹窗，直接打这一叠。onPreview 留给还没有详情页的清单。 */
export function PrintSelectionBar({
  count,
  onPreview,
  onPrint,
}: {
  count: number;
  onPreview?: () => void;
  onPrint: () => void;
}) {
  if (count === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <Typography.Text>已选 {count} 张</Typography.Text>
      {onPreview ? (
        <Button size="small" onClick={onPreview}>
          预览所选
        </Button>
      ) : null}
      <Button size="small" type="primary" icon={<PrinterOutlined aria-hidden />} onClick={onPrint}>
        打印所选（{count}）
      </Button>
    </div>
  );
}

/**
 * 预览弹窗。单张时底部是「打印」；多张时翻页看，主按钮打整叠。
 * 弹窗里的版式和纸张是同一份组件，点打印才挂打印根。
 */
export function PrintPreviewModal({
  open,
  title,
  index,
  total,
  onIndexChange,
  onClose,
  onPrint,
  children,
}: {
  open: boolean;
  title: string;
  index: number;
  total: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onPrint: () => void;
  children: ReactNode;
}) {
  const shown = total > 1 ? `${title}（${index + 1}/${total}）` : title;
  return (
    <Modal
      title={open ? `预览 ${shown}` : '预览'}
      open={open}
      width={800}
      centered
      destroyOnHidden
      onCancel={onClose}
      styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          {total > 1 ? (
            <>
              <Button disabled={index <= 0} onClick={() => onIndexChange(index - 1)}>
                上一张
              </Button>
              <Button disabled={index >= total - 1} onClick={() => onIndexChange(index + 1)}>
                下一张
              </Button>
              <Button type="primary" icon={<PrinterOutlined aria-hidden />} onClick={onPrint}>
                打印全部 {total} 张
              </Button>
            </>
          ) : (
            <Button type="primary" icon={<PrinterOutlined aria-hidden />} onClick={onPrint}>
              打印
            </Button>
          )}
        </Space>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 720 }}>{children}</div>
      </div>
    </Modal>
  );
}
