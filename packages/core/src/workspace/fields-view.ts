import type {
  FieldDefinition,
  FieldRegistry,
  RegisteredField,
} from '../registry/field-registry.js';

/**
 * 字段注册表的工作区绑定视图（FieldsView）。
 * 只做参数绑定与委托；冲突校验/投影/卸载语义全部在 FieldRegistry。
 */
export class FieldsView {
  constructor(
    private readonly workspaceId: string,
    private readonly registry: FieldRegistry,
  ) {}

  provide(providedBy: string, def: FieldDefinition, opts?: { actor?: string }): RegisteredField {
    return this.registry.provide(this.workspaceId, providedBy, def, opts);
  }

  require(
    requiredBy: string,
    spec: {
      entity: string;
      key: string;
      sharing?: 'shared' | 'private';
      expectType?: 'string' | 'number' | 'boolean' | 'date' | 'json';
    },
    opts?: { actor?: string },
  ): RegisteredField {
    return this.registry.require(this.workspaceId, requiredBy, spec, opts);
  }

  /** 软删除/恢复可见性 */
  setVisibility(by: string, entity: string, qualifiedKey: string, visible: boolean): void {
    this.registry.setVisibility(this.workspaceId, by, entity, qualifiedKey, visible);
  }

  /** 卸载模块（所有权移交 / 软删除语义见 §7.2） */
  unregisterModule(moduleId: string) {
    return this.registry.unregisterModule(this.workspaceId, moduleId);
  }

  list(entity?: string): RegisteredField[] {
    return this.registry.listFields(this.workspaceId, entity);
  }

  get(entity: string, qualifiedKey: string): RegisteredField | undefined {
    return this.registry.getField(this.workspaceId, entity, qualifiedKey);
  }
}
