import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ScanOutlined } from '@ant-design/icons';
import { Input } from 'antd';
import type { InputRef } from 'antd';

/**
 * 扫码输入（M18）：USB 扫码枪 = 键盘设备——聚焦的输入框收到一串字符 + 回车。
 * 挂载即聚焦；回车触发 onScan（trim 后非空才触发）并清空续扫——扫码是无鼠标
 * 动作，提交后焦点保持在本框。手工键入同样有效（扫码枪与键盘无区别）。
 */
export default function ScanInput({
  onScan,
  placeholder = '扫码枪输入（或手工键入后回车）',
  style,
  size = 'small',
}: {
  onScan: (code: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  size?: 'small' | 'middle' | 'large';
}) {
  const ref = useRef<InputRef>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const fire = () => {
    const v = value.trim();
    if (!v) return;
    onScan(v);
    setValue('');
  };

  return (
    <Input
      ref={ref}
      size={size}
      prefix={<ScanOutlined />}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPressEnter={fire}
      style={{ width: 240, ...style }}
    />
  );
}
