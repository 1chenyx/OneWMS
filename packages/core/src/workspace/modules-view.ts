import type { ModuleRegistry, ModuleUninstallReport } from '../modules/module-registry.js';
import type { ImpactReport } from '../profile/impact.js';
import type { InstalledModule, ModuleManifest } from '../modules/manifest-types.js';
import type { DynRecordSchema } from '../dyn/dyn-store.js';

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

  /**
   * 登记声明式模块注册提议（B.1）：manifest 静态校验 + 命名空间/撞名检查 →
   * 生成 `dyn.module.register` 提议进待确认队列。不落事件。
   * 确认入口在 ProfileView.confirm（按 kind 分派到 install），不在本视图——
   * 两种提议共用一个确认队列/一个 API。
   */
  proposeInstall(
    manifest: ModuleManifest,
    opts?: { proposedBy?: string; note?: string },
  ): { proposalId: string; report: ImpactReport } {
    return this.service.proposeInstall(this.workspaceId, manifest, opts);
  }

  /**
   * 生效 manifest 全集 = 进程目录 + 已落账的声明式模块 manifest（B.1）。
   * 工具目录装配/实体目录查询用这个，声明式模块才对 AI 可见。
   */
  effectiveManifests(): ModuleManifest[] {
    return this.service.effectiveManifests(this.workspaceId);
  }

  getManifest(id: string): ModuleManifest | undefined {
    return this.service.getManifest(id);
  }

  /**
   * 已安装模块声明的声明式实体清单（B.3 端点的白名单来源）。
   *
   * 与 DynStore 取 schema 走的是**同一个** ModuleRegistry 方法，所以端点判「未声明 → 404」
   * 与存储层判「无 schema → NotFound」永远同源，不会出现「路由放行、存储拒绝」的错位。
   * 端点需要它是因为 HTTP 层还要读列的 queryable/type（过滤排序白名单、查询串按类型转值）。
   */
  dynRecords(): DynRecordSchema[] {
    return this.service.installedDynRecords(this.workspaceId);
  }
}
