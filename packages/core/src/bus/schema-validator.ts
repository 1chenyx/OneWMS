import { ToolValidationError } from '../errors.js';

/**
 * 轻量 JSON Schema 子集校验器（无状态纯函数，manifest 工具参数声明用，§6）。
 * 支持：type / required / enum / minimum / maximum / items / properties。
 * 刻意不引入 ajv——内核依赖最小化，取值域校验足够。
 */
export interface ParameterSchema {
  type: 'object';
  properties?: Record<string, ParameterProperty>;
  required?: string[];
}

export interface ParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  items?: ParameterProperty;
  default?: unknown;
}

export function validateParameters(schema: ParameterSchema, params: unknown): void {
  if (params === undefined || params === null) {
    if (schema.required?.length) {
      throw new ToolValidationError(`缺少必填参数: ${schema.required.join(', ')}`);
    }
    return;
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ToolValidationError(`参数必须是对象，实际为 ${typeof params}`);
  }

  const obj = params as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined) {
      throw new ToolValidationError(`缺少必填参数: ${key}`);
    }
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (obj[key] !== undefined) {
      validateProperty(key, prop, obj[key]);
    }
  }
}

function validateProperty(path: string, prop: ParameterProperty, value: unknown): void {
  const fail = (reason: string) => new ToolValidationError(`参数 ${path} ${reason}`) as never;

  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') throw fail(`必须是 string，实际为 ${typeof value}`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw fail(`必须是 number，实际为 ${typeof value}`);
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw fail(`必须是 integer，实际为 ${JSON.stringify(value)}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw fail(`必须是 boolean，实际为 ${typeof value}`);
      break;
    case 'array':
      if (!Array.isArray(value)) throw fail(`必须是 array，实际为 ${typeof value}`);
      if (prop.items) {
        value.forEach((item, i) => validateProperty(`${path}[${i}]`, prop.items!, item));
      }
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw fail(`必须是 object`);
      }
      break;
  }

  if (prop.enum && !prop.enum.includes(value as string | number)) {
    throw fail(`取值必须是 [${prop.enum.join(', ')}] 之一，实际为 ${JSON.stringify(value)}`);
  }
  if (typeof value === 'number') {
    if (prop.minimum !== undefined && value < prop.minimum) {
      throw fail(`不能小于 ${prop.minimum}，实际为 ${value}`);
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      throw fail(`不能大于 ${prop.maximum}，实际为 ${value}`);
    }
  }
}
