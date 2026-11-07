/**
 * jsbarcode 自带包没有类型声明（3.x 无 .d.ts），这里按用到的子集补一份。
 * 只声明标签打印真正会用到的选项——不做全量镜像，避免和上游漂移。
 */
declare module 'jsbarcode' {
  export interface JsBarcodeBaseOptions {
    /** 一维码制：标签用 CODE128（可编字母+数字，扫码枪通用） */
    format?: string;
    /** 窄条宽度（px） */
    width?: number;
    /** 条码高度（px） */
    height?: number;
    /** 是否绘制条码下方文字 */
    displayValue?: boolean;
    text?: string;
    fontSize?: number;
    font?: string;
    textAlign?: 'left' | 'center' | 'right';
    textPosition?: 'top' | 'bottom';
    textMargin?: number;
    /** 线条颜色（打印用纯黑） */
    lineColor?: string;
    background?: string;
    margin?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    /** 非法字符/空内容时抛异常（true）还是静默不画（false） */
    valid?: (valid: boolean) => void;
  }

  /**
   * 把条码画到目标上。element 传 SVG / canvas DOM 节点即可；
   * 内容非法（CODE128 编不了的字符）会抛 InvalidInputException。
   */
  export default function JsBarcode(
    element: unknown,
    text: string,
    options?: JsBarcodeBaseOptions,
  ): void;
}
