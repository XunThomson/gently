import type { ComponentDef } from '../types';

const COMPONENTS = new Map<string, ComponentDef>();

export function defineComponent(def: ComponentDef): ComponentDef {
    if (!def?.type) throw new Error('[registry] 组件定义必须包含 type');
    COMPONENTS.set(def.type, def);
    return def;
}

export const getComponent = (type: string): ComponentDef | undefined =>
    COMPONENTS.get(type);

export const hasComponent = (type: string): boolean => COMPONENTS.has(type);

export const getAllComponents = (): ComponentDef[] => [...COMPONENTS.values()];