/**
 * 现场设备判定：手机 / 扫码枪 / 触屏 PDA 的浏览器算「移动端」。
 * 场景作业（module.scenario）的入口只给移动端显示，桌面管理界面不出现
 * （ROADMAP §3.1：现场扫码是移动形态；管理在电脑上做）。
 *
 * 判据取宽松并集——现场设备形态太多（Android PDA、iOS、触屏平板），
 * 宁可多显示也不能漏：漏了等于把现场的作业入口收走。
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  // 手机/平板 UA；iPad 新版 UA 伪装成 Mac，靠下面的触屏判据兜住
  if (/Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent)) return true;
  // 触屏为主 + 屏幕不宽：覆盖触屏平板、PDA 和伪装成桌面 UA 的移动浏览器
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return coarse && window.innerWidth <= 900;
}
