/**
 * 发版常量，不是 Profile。一个后续 PR 只把自己那一键改成 true。
 * 这一步开待收货、待上架、管理看板和单据下钻。
 */
export const FIELD_SCREENS = {
  receive: true,
  putaway: true,
  manageBoard: true,
  manageOrders: true,
  qc: false,
  pick: false,
  review: false,
  pack: false,
  load: false,
  wave: false,
  stocktake: false,
  transfer: false,
  scrap: false,
  serial: false,
  lpn: false,
  returnCreate: false,
} as const;

export type FieldScreen = keyof typeof FIELD_SCREENS;

export function screenOpen(id: FieldScreen): boolean {
  const open: boolean = FIELD_SCREENS[id];
  return open;
}
