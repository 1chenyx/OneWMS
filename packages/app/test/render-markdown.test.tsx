import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMarkdown } from '../src/chat/render-markdown';

/**
 * 助手回复的 Markdown：排版可见，HTML 和危险链接不能变成真节点。
 */

function view(text: string) {
  return render(<ChatMarkdown text={text} />);
}

describe('ChatMarkdown', () => {
  it('标题、强调、列表、表格和换行会排版', () => {
    const { container } = view(
      [
        '## 结果',
        '',
        '已处理 **A-1**，备注 *易碎*，~~作废~~。',
        '下一行仍在这段里',
        '',
        '- 父项',
        '  - 子项',
        '- [x] 已上架',
        '',
        '2. 第二步',
        '',
        '| 编码 | 数量 |',
        '| --- | ---: |',
        '| A-1 | 10 |',
        '',
        '> 引用',
        '',
        '---',
        '',
        '字段 sku_code_a 保持原样，价格 &lt; 10。',
      ].join('\n'),
    );

    expect(container.querySelector('h2')).toHaveTextContent('结果');
    expect(container.querySelector('strong')).toHaveTextContent('A-1');
    expect(screen.getByText('易碎').tagName).toBe('EM');
    expect(screen.getByText('作废').tagName).toBe('DEL');
    expect(container.querySelectorAll('p')[0]?.querySelector('br')).not.toBeNull();
    expect(screen.getByText('子项').closest('ul')?.parentElement?.tagName).toBe('LI');
    expect(screen.getByRole('checkbox', { name: '已完成' })).toBeChecked();
    expect(container.querySelector('ol')).toHaveAttribute('start', '2');
    expect(screen.getByRole('columnheader', { name: '编码' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '10' })).toBeInTheDocument();
    expect(container.querySelector('blockquote')).toHaveTextContent('引用');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('em')).toHaveTextContent('易碎');
    expect(container).toHaveTextContent('sku_code_a');
    expect(container.textContent).toContain('价格 < 10');
    expect(container.textContent).not.toContain('&lt;');
  });

  it('反斜杠转义保持字面量，代码块里不再排版', () => {
    const { container } = view(['\\*不是斜体\\*', '', '```', '**不是粗体**', '```'].join('\n'));
    expect(container.querySelector('em, strong')).toBeNull();
    expect(container).toHaveTextContent('*不是斜体*');
    expect(container.querySelector('pre code')).toHaveTextContent('**不是粗体**');
  });

  it('没闭合的代码围栏把后面的文字都当代码', () => {
    const { container } = view(['```', '**还在代码里**'].join('\n'));
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('pre code')).toHaveTextContent('**还在代码里**');
  });

  it('HTML 只显示成文字，危险链接不会变成可点的地址', () => {
    const { container } = view(
      [
        '<b>粗</b> <script>alert(1)</script> <img src=x onerror=alert(1)>',
        '',
        '[点我](javascript:alert(1))',
        '',
        '[文档](https://example.com/doc)',
        '',
        '见 https://example.com/a。',
        '',
        '![箱](https://example.com/a.png)',
      ].join('\n'),
    );

    expect(container.querySelector('script, img, b')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('点我').closest('a')).toBeNull();
    const doc = screen.getByRole('link', { name: '文档' });
    expect(doc).toHaveAttribute('href', 'https://example.com/doc');
    expect(doc).toHaveAttribute('target', '_blank');
    expect(doc).toHaveAttribute('rel', 'noopener noreferrer');
    const bare = screen.getByRole('link', { name: 'https://example.com/a' });
    expect(bare).toHaveAttribute('href', 'https://example.com/a');
    expect(container.textContent).toContain('。');
    expect(screen.getByRole('link', { name: '箱' })).toHaveAttribute('href', 'https://example.com/a.png');
    expect(container.querySelector('img')).toBeNull();
  });

  it('行内代码不把星号当强调', () => {
    const { container } = view('请看 `**A-1**`');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')).toHaveTextContent('**A-1**');
  });
});
