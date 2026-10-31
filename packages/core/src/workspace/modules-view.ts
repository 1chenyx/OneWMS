import type { ModuleRegistry, ModuleUninstallReport } from '../modules/module-registry.js';
import type { InstalledModule, ModuleManifest } from '../modules/manifest-types.js';

/**
 * 模块系统的工作区绑定视图（ModulesView，里程碑 6）。
 * 与其他 View 同纪律：构造期绑定 workspaceId，调用方不再传。
 * manifest 目录查询（listManifests/getManifest）是进程级面——透传不加 wsId。
 */
export class ModulesView {
  constructor(
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly service: ModuleRegistry,
  ) {}

  /**
   * 安装模块（幂等：同版本已装 → installed:false 零事件）。
   * actor 默认 `module:{id}@{nodeId}`（M5 通道节点唯一）。
   */
  install(manifest: ModuleManifest, opts?: { actor?: string }): { installed: boolean; version: number } {
    return this.service.install(this.workspaceId, manifest, opts);
  }

  /** 卸载模块（逆操作：字段处置 + workflows 摘除 + modules 段移除 + 审计事件） */
  uninstall(moduleId: string, opts?: { actor?: string }): ModuleUninstallReport {
    return this.service.uninstall(this.workspaceId, moduleId, opts);
  }

  /** 已安装模块清单（modules 段 + 目录 manifest 元数据聚合） */
  listInstalled(): InstalledModule[] {
    return this.service.listInstalled(this.workspaceId);
  }

  /** 进程 manifest 目录（代码装载方注册的声明面，「可安装模块目录」） */
  listManifests(): ModuleManifest[] {
    return this.service.listManifests();
  }

  getManifest(id: string): ModuleManifest | undefined {
    return this.service.getManifest(id);
  }
}
